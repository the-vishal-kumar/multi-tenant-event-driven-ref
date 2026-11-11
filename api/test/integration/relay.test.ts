// Outbox relay against Postgres and a real SQS API (LocalStack). Uses its own
// temporary queue and a test-only event type, so neither the running API's
// relay nor the compose worker touches these rows or messages.
import { propagation } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant } from '../../src/db';
import { sqsQueue, type Queue } from '../../src/queue';
import { Relay } from '../../src/relay';
import { env, newTenant, pool, pools } from './helpers';

const sqs = new SQSClient({ endpoint: env('SQS_ENDPOINT') });
let queueUrl: string;

beforeAll(async () => {
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const out = await sqs.send(new CreateQueueCommand({ QueueName: `relay-test-${Date.now()}` }));
  queueUrl = out.QueueUrl!;
});
afterAll(async () => {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  await Promise.all(pools.map((p) => p.end()));
});

/** Writes outbox rows the way the API does (app_api role, tenant set). */
async function writeEvents(tenant: string, eventType: string, n: number): Promise<string[]> {
  return withTenant(pool('DATABASE_URL_API'), tenant, async (c) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const orderId = randomUUID();
      await c.query(
        `INSERT INTO outbox (tenant_id, event_type, payload, traceparent)
         VALUES (app_tenant_id(), $1, $2, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')`,
        [eventType, JSON.stringify({ order_id: orderId })]);
      ids.push(orderId);
    }
    return ids;
  });
}

describe('outbox relay', () => {
  it('publishes committed events in batches with tenant and trace attributes, then marks them', async () => {
    const tenant = await newTenant('relay');
    const type = `test.relay.${randomUUID().slice(0, 8)}`;
    const orderIds = await writeEvents(tenant, type, 12); // more than one SendMessageBatch

    const relayPool = pool('DATABASE_URL_RELAY');
    const relay = new Relay(relayPool, sqsQueue(queueUrl, env('SQS_ENDPOINT')), 50, [type]);
    expect(await relay.runOnce()).toBe(12);
    expect(await relay.runOnce()).toBe(0);

    const rows = await relayPool.query(
      `SELECT event_id::text, published_at FROM outbox WHERE event_type = $1`, [type]);
    expect(rows.rows.every((r) => r.published_at !== null)).toBe(true);

    const first = rows.rows[0];
    const found = await receiveUntil((attrs) => attrs.event_id === first.event_id);
    expect(found.attrs.tenant_id).toBe(tenant);
    expect(found.attrs.event_type).toBe(type);
    // The message continues the trace of the request that wrote the row.
    expect(found.attrs.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-/);
    const body = JSON.parse(found.body);
    expect(body).toMatchObject({ event_id: first.event_id, tenant_id: tenant });
    expect(orderIds).toContain(body.data.order_id);
  });

  it('keeps rows unpublished and counts the attempt when the send fails', async () => {
    const tenant = await newTenant('relay-fail');
    const type = `test.relay-fail.${randomUUID().slice(0, 8)}`;
    await writeEvents(tenant, type, 2);
    const failing: Queue = { sendBatch: async (msgs) => ({ failed: msgs.map((m) => m.id), error: 'AccessDenied: not allowed' }) };
    const relayPool = pool('DATABASE_URL_RELAY');
    // The failure is reported (run() logs it), not swallowed.
    await expect(new Relay(relayPool, failing, 50, [type]).runOnce()).rejects.toThrow(
      '2 of 2 outbox rows not published: AccessDenied: not allowed');
    const rows = await relayPool.query(
      `SELECT published_at, publish_attempts FROM outbox WHERE event_type = $1`, [type]);
    expect(rows.rows).toEqual([
      { published_at: null, publish_attempts: 1 },
      { published_at: null, publish_attempts: 1 },
    ]);
  });

  it('lets new rows past rows that keep failing', async () => {
    const tenant = await newTenant('relay-hol');
    const type = `test.relay-hol.${randomUUID().slice(0, 8)}`;
    await writeEvents(tenant, type, 2);
    const relayPool = pool('DATABASE_URL_RELAY');
    // The older row has failed many times already.
    await relayPool.query(
      `UPDATE outbox SET publish_attempts = 7 WHERE id = (SELECT min(id) FROM outbox WHERE event_type = $1)`, [type]);
    const sent: string[] = [];
    const recording: Queue = { sendBatch: async (msgs) => { sent.push(...msgs.map((m) => m.id)); return { failed: [] }; } };
    expect(await new Relay(relayPool, recording, 1, [type]).runOnce()).toBe(1);
    const fresh = await relayPool.query(
      `SELECT id::text FROM outbox WHERE event_type = $1 AND publish_attempts = 0`, [type]);
    expect(sent).toEqual([fresh.rows[0].id]);
  });
});

describe('outbox relay under concurrency', () => {
  it('publishes each row exactly once when several relays drain the same backlog', async () => {
    const tenant = await newTenant('relay-race');
    const type = `test.relay-race.${randomUUID().slice(0, 8)}`;
    await writeEvents(tenant, type, 40);
    const sent: string[] = [];
    // A slow queue keeps each batch's rows locked long enough for the others to collide.
    const slow: Queue = {
      sendBatch: async (msgs) => {
        await new Promise((r) => setTimeout(r, 30));
        sent.push(...msgs.map((m) => m.id));
        return { failed: [] };
      },
    };
    const relays = Array.from({ length: 4 }, () => new Relay(pool('DATABASE_URL_RELAY'), slow, 5, [type]));
    await Promise.all(relays.map(async (r) => {
      while ((await r.runOnce()) > 0);
    }));
    expect(sent).toHaveLength(40);
    expect(new Set(sent).size).toBe(40);
    const left = await pool('DATABASE_URL_RELAY').query(
      `SELECT count(*)::int AS n FROM outbox WHERE event_type = $1 AND published_at IS NULL`, [type]);
    expect(left.rows[0].n).toBe(0);
  });

  it('sends rows in outbox id order within one relay', async () => {
    const tenant = await newTenant('relay-order');
    const type = `test.relay-order.${randomUUID().slice(0, 8)}`;
    await writeEvents(tenant, type, 12);
    const sent: string[] = [];
    const recording: Queue = { sendBatch: async (msgs) => { sent.push(...msgs.map((m) => m.id)); return { failed: [] }; } };
    const relay = new Relay(pool('DATABASE_URL_RELAY'), recording, 5, [type]);
    while ((await relay.runOnce()) > 0);
    expect(sent).toHaveLength(12);
    expect(sent.map(Number)).toEqual([...sent.map(Number)].sort((a, b) => a - b));
  });
});

async function receiveUntil(match: (attrs: Record<string, string>) => boolean) {
  for (let i = 0; i < 20; i++) {
    const out = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'],
    }));
    for (const m of out.Messages ?? []) {
      const attrs = Object.fromEntries(
        Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? '']));
      if (match(attrs)) return { attrs, body: m.Body ?? '' };
    }
  }
  throw new Error('message not received');
}
