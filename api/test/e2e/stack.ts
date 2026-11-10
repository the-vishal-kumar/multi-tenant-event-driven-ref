// Helpers for driving the running compose stack from the `tools` container.
// Shared by the end-to-end test and the demo script.
import { randomUUID } from 'node:crypto';
import {
  GetQueueAttributesCommand,
  ChangeMessageVisibilityBatchCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Client } from 'pg';
import { signToken } from '../../src/auth';
import { createTenant } from '../../src/cli';

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name}: run via 'docker compose --profile tools run --rm tools ...'`);
  return v;
}

export const sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });

export interface Tenant {
  name: string;
  id: string;
  token: string;
}

export async function tenant(name: string): Promise<Tenant> {
  const id = await createTenant(env('DATABASE_URL_OWNER'), name);
  return { name, id, token: await signToken(env('JWT_SECRET'), id, `${name}-user`) };
}

export interface HttpResult {
  status: number;
  headers: Headers;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function api(
  t: Tenant,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; key?: string } = {},
): Promise<HttpResult> {
  const res = await fetch(`${env('API_URL')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${t.token}`,
      ...(opts.body !== undefined && { 'content-type': 'application/json' }),
      ...(opts.key && { 'idempotency-key': opts.key }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Runs one query as a given role, optionally with a tenant set. */
export async function sql<R extends object>(urlVar: string, tenantId: string | null, text: string, params: unknown[] = []): Promise<R[]> {
  const c = new Client({ connectionString: env(urlVar) });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (tenantId) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query<R>(text, params);
    await c.query('COMMIT');
    return r.rows;
  } finally {
    await c.end();
  }
}

/** The published event for an order, as the relay role sees it. */
export async function eventFor(orderId: string) {
  const rows = await sql<{ event_id: string; tenant_id: string; payload: unknown; created_at: Date }>(
    'DATABASE_URL_RELAY', null,
    `SELECT event_id::text, tenant_id::text, payload, created_at FROM outbox WHERE payload->>'order_id' = $1`,
    [orderId]);
  if (!rows[0]) throw new Error(`no outbox row for ${orderId}`);
  return rows[0];
}

export function envelope(eventId: string, tenantId: string, orderId: string): string {
  return JSON.stringify({
    event_id: eventId, event_type: 'order.created', tenant_id: tenantId,
    occurred_at: new Date().toISOString(), data: { order_id: orderId },
  });
}

/** Puts a message straight on the main queue, bypassing the API and outbox. */
export async function inject(body: string, attrs: Record<string, string>): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: env('QUEUE_URL'),
    MessageBody: body,
    MessageAttributes: Object.fromEntries(
      Object.entries(attrs).map(([k, v]) => [k, { DataType: 'String', StringValue: v }])),
  }));
}

export async function depth(urlVar: 'QUEUE_URL' | 'DLQ_URL'): Promise<number> {
  const out = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: env(urlVar),
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  }));
  const a = out.Attributes ?? {};
  return Number(a.ApproximateNumberOfMessages ?? 0) + Number(a.ApproximateNumberOfMessagesNotVisible ?? 0);
}

export interface DeadLetter {
  body: string;
  attrs: Record<string, string>;
}

/**
 * Looks through the DLQ for a message with the given event_id without
 * consuming anything: messages are hidden while scanning (so a DLQ with more
 * than 10 messages can be walked) and made visible again afterwards.
 */
export async function findInDLQ(eventId: string): Promise<DeadLetter | undefined> {
  const seen: string[] = [];
  try {
    for (let i = 0; i < 20; i++) {
      const out = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: env('DLQ_URL'), MaxNumberOfMessages: 10, VisibilityTimeout: 30,
        WaitTimeSeconds: 0, MessageAttributeNames: ['All'],
      }));
      if (!out.Messages?.length) return undefined;
      for (const m of out.Messages) {
        if (m.ReceiptHandle) seen.push(m.ReceiptHandle);
        const attrs = Object.fromEntries(
          Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? '']));
        if (attrs.event_id === eventId) return { body: m.Body ?? '', attrs };
      }
    }
    return undefined;
  } finally {
    for (let i = 0; i < seen.length; i += 10) {
      await sqs.send(new ChangeMessageVisibilityBatchCommand({
        QueueUrl: env('DLQ_URL'),
        Entries: seen.slice(i, i + 10).map((h, j) => ({ Id: String(j), ReceiptHandle: h, VisibilityTimeout: 0 })),
      }));
    }
  }
}

export const runId = () => randomUUID().slice(0, 8);
