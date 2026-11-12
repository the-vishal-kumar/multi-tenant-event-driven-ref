import { context, propagation, SpanKind, trace, type Context } from '@opentelemetry/api';
import type { Pool } from 'pg';
import { ORDER_CREATED } from './orders';
import type { OutboundMessage, Queue } from './queue';

const tracer = trace.getTracer('orders-api/relay');

interface OutboxRow {
  id: string;
  event_id: string;
  tenant_id: string;
  event_type: string;
  payload: unknown;
  traceparent: string | null;
  tracestate: string | null;
  created_at: Date;
}

/**
 * Moves committed outbox rows to the queue. Delivery is at-least-once: if the
 * process dies after the send but before the commit, the rows are sent again
 * and the worker's dedupe table absorbs the copy. FOR UPDATE SKIP LOCKED lets
 * several API replicas run the relay without sending the same row twice in
 * the normal case.
 *
 * Connects as app_relay, which can read and mark outbox rows for every tenant
 * and cannot see orders.
 */
export class Relay {
  constructor(
    private readonly pool: Pool,
    private readonly queue: Queue,
    private readonly batchSize = 50,
    // One relay per queue: it only moves the event types routed to its queue.
    private readonly eventTypes: readonly string[] = [ORDER_CREATED],
  ) {}

  /** Publishes one batch. Returns how many rows were published. */
  async runOnce(): Promise<number> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<OutboxRow>(
        `SELECT id::text, event_id::text, tenant_id::text, event_type, payload,
                traceparent, tracestate, created_at
           FROM outbox
          WHERE published_at IS NULL AND event_type = ANY($2::text[])
          ORDER BY publish_attempts, id  -- rows that keep failing don't block newer ones
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize, this.eventTypes],
      );
      if (rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      const spans = rows.map((r) =>
        tracer.startSpan(
          `${r.event_type} publish`,
          {
            kind: SpanKind.PRODUCER,
            attributes: {
              'messaging.system': 'aws_sqs',
              'messaging.operation.type': 'publish',
              'messaging.message.id': r.event_id,
              'app.tenant_id': r.tenant_id,
            },
          },
          parentContext(r),
        ),
      );
      const messages: OutboundMessage[] = rows.map((r, i) => toMessage(r, trace.setSpan(context.active(), spans[i]!)));
      const { failed, error } = await this.queue.sendBatch(messages);
      const failedSet = new Set(failed);

      const ok = rows.filter((r) => !failedSet.has(r.id)).map((r) => r.id);
      const bad = rows.filter((r) => failedSet.has(r.id)).map((r) => r.id);
      if (ok.length) {
        await client.query(`UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])`, [ok]);
      }
      if (bad.length) {
        await client.query(
          `UPDATE outbox SET publish_attempts = publish_attempts + 1 WHERE id = ANY($1::bigint[])`,
          [bad],
        );
      }
      await client.query('COMMIT');
      spans.forEach((s, i) => {
        if (failedSet.has(rows[i]!.id)) s.setStatus({ code: 2, message: 'send failed' });
        s.end();
      });
      if (bad.length) {
        // The attempts are committed; now make the failure visible (run()
        // passes it to onError, which logs it).
        throw new PublishError(bad.length, rows.length, error ?? 'rejected by the queue');
      }
      return ok.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      throw err;
    } finally {
      client.release(broken);
    }
  }

  /**
   * Unpublished rows of this relay's event types and the age of the oldest.
   * The SQS alarms can't see events that never left the outbox; this can.
   */
  async backlog(): Promise<Backlog> {
    const { rows } = await this.pool.query<{ rows: number; age: number }>(
      `SELECT count(*)::int AS rows,
              coalesce(extract(epoch FROM now() - min(created_at)), 0)::float8 AS age
         FROM outbox
        WHERE published_at IS NULL AND event_type = ANY($1::text[])`,
      [this.eventTypes],
    );
    return { rows: rows[0]!.rows, oldestAgeSeconds: Math.round(rows[0]!.age) };
  }

  /**
   * Polls until the signal aborts. Drains quickly when there is a backlog.
   * With `report`, also measures the backlog every `everyMs` and hands it to
   * `onBacklog` (server.ts logs it; CloudWatch turns the log line into the
   * outbox-age metric and alarm).
   */
  async run(
    signal: AbortSignal,
    intervalMs: number,
    onError: (err: unknown) => void,
    report?: { everyMs: number; onBacklog: (b: Backlog) => void },
  ): Promise<void> {
    let nextReport = 0;
    while (!signal.aborted) {
      let published = 0;
      try {
        published = await this.runOnce();
      } catch (err) {
        onError(err);
      }
      if (report && Date.now() >= nextReport) {
        nextReport = Date.now() + report.everyMs;
        try {
          report.onBacklog(await this.backlog());
        } catch (err) {
          onError(err);
        }
      }
      if (published < this.batchSize) await sleep(intervalMs, signal);
    }
  }
}

export interface Backlog {
  rows: number;
  oldestAgeSeconds: number;
}

/** Some outbox rows couldn't be sent; they stay unpublished and are retried. */
export class PublishError extends Error {
  constructor(readonly failed: number, readonly total: number, reason: string) {
    super(`${failed} of ${total} outbox rows not published: ${reason}`);
    this.name = 'PublishError';
  }
}

function parentContext(r: OutboxRow): Context {
  const carrier: Record<string, string> = {};
  if (r.traceparent) carrier.traceparent = r.traceparent;
  if (r.tracestate) carrier.tracestate = r.tracestate;
  return propagation.extract(context.active(), carrier);
}

function toMessage(r: OutboxRow, ctx: Context): OutboundMessage {
  const attributes: Record<string, string> = {
    event_id: r.event_id,
    event_type: r.event_type,
    tenant_id: r.tenant_id,
  };
  // The producer span's context travels in message attributes, so the worker
  // continues the same trace.
  propagation.inject(ctx, attributes);
  return {
    id: r.id,
    body: JSON.stringify({
      event_id: r.event_id,
      event_type: r.event_type,
      tenant_id: r.tenant_id,
      occurred_at: r.created_at.toISOString(),
      data: r.payload,
    }),
    attributes,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
