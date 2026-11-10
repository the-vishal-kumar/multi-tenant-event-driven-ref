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
    const failing: Queue = { sendBatch: async (msgs) => ({ failed: msgs.map((m) => m.id) }) };
    const relayPool = pool('DATABASE_URL_RELAY');
    expect(await new Relay(relayPool, failing, 50, [type]).runOnce()).toBe(0);
    const rows = await relayPool.query(
      `SELECT published_at, publish_attempts FROM outbox WHERE event_type = $1`, [type]);
    expect(rows.rows).toEqual([
      { published_at: null, publish_attempts: 1 },
      { published_at: null, publish_attempts: 1 },
    ]);
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
