// End-to-end through the running compose stack: HTTP -> Postgres -> outbox
// relay -> SQS (LocalStack) -> Go worker -> Postgres, plus the trace in Jaeger.
//   scripts/e2e.sh
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, depth, envelope, env, eventFor, inject, findInDLQ, runId, sql, tenant, waitFor, type Tenant } from './stack';

const order = { currency: 'EUR', items: [{ sku: 'E2E-1', quantity: 2, unit_price_cents: 1250 }] };
let acme: Tenant;
let globex: Tenant;
const run = runId();

beforeAll(async () => {
  acme = await tenant('e2e-acme');
  globex = await tenant('e2e-globex');
});

const confirmed = (t: Tenant, id: string) =>
  waitFor(`order ${id} confirmed`, async () => {
    const r = await api(t, 'GET', `/v1/orders/${id}`);
    return r.body.status === 'confirmed' ? r.body : undefined;
  });

describe('order flow', () => {
  it('creates an order that the worker confirms asynchronously', async () => {
    const created = await api(acme, 'POST', '/v1/orders', { body: order, key: `e2e-${run}-1` });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');
    const done = await confirmed(acme, created.body.id);
    expect(done.processed_at).not.toBeNull();
  });

  it('replays a retried request instead of creating a second order', async () => {
    const key = `e2e-${run}-2`;
    const a = await api(acme, 'POST', '/v1/orders', { body: order, key });
    const b = await api(acme, 'POST', '/v1/orders', { body: order, key });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    const c = await api(acme, 'POST', '/v1/orders', { body: { ...order, currency: 'USD' }, key });
    expect(c.status).toBe(422);
  });

  it('never shows one tenant another tenant\'s order', async () => {
    const created = await api(acme, 'POST', '/v1/orders', { body: order, key: `e2e-${run}-3` });
    expect((await api(globex, 'GET', `/v1/orders/${created.body.id}`)).status).toBe(404);
    const list = await api(globex, 'GET', '/v1/orders?limit=100');
    expect(list.body.orders.map((o: { id: string }) => o.id)).not.toContain(created.body.id);
  });

  it('absorbs a duplicate delivery of the same event', async () => {
    const created = await api(acme, 'POST', '/v1/orders', { body: order, key: `e2e-${run}-4` });
    await confirmed(acme, created.body.id);
    const ev = await eventFor(created.body.id);
    await inject(envelope(ev.event_id, acme.id, created.body.id), { tenant_id: acme.id, event_id: ev.event_id });
    const dups = await waitFor('duplicate counted', async () => {
      const [r] = await sql<{ duplicate_deliveries: number }>('DATABASE_URL_WORKER', acme.id,
        'SELECT duplicate_deliveries FROM processed_messages WHERE event_id = $1', [ev.event_id]);
      return r && r.duplicate_deliveries > 0 ? r.duplicate_deliveries : undefined;
    });
    expect(dups).toBe(1);
  });

  it('dead-letters a poison message after the configured attempts, without touching the other tenant', async () => {
    const victim = await api(acme, 'POST', '/v1/orders', { body: order, key: `e2e-${run}-5` });
    const victimDone = await confirmed(acme, victim.body.id);
    const before = await depth('DLQ_URL');
    // Routed as globex, naming acme's order: RLS hides it, so it can never succeed.
    const forgedId = randomUUID();
    await inject(envelope(forgedId, globex.id, victim.body.id), { tenant_id: globex.id, event_id: forgedId });

    const dead = await waitFor('poison message in DLQ', () => findInDLQ(forgedId), 45_000);
    expect(dead.attrs.failure_reason).toBe('order not found in tenant');
    expect(dead.attrs.failed_attempts).toBe('4');
    expect(await depth('DLQ_URL')).toBeGreaterThan(before);
    // Acme's order is unchanged.
    expect((await api(acme, 'GET', `/v1/orders/${victim.body.id}`)).body).toEqual(victimDone);
  }, 60_000);

  it('dead-letters a malformed message on the first attempt', async () => {
    const marker = randomUUID();
    await inject('{"this is": not json', { tenant_id: acme.id, event_id: marker });
    const dead = await waitFor('malformed message in DLQ', () => findInDLQ(marker), 20_000);
    expect(dead.attrs.failed_attempts).toBe('1');
    expect(dead.attrs.failure_reason).toMatch(/^permanent: malformed body/);
  }, 30_000);

  it('records one trace across the API, the relay and the worker', async () => {
    const created = await api(acme, 'POST', '/v1/orders', { body: order, key: `e2e-${run}-6` });
    await confirmed(acme, created.body.id);
    const ev = await eventFor(created.body.id);
    const trace = await waitFor('trace in Jaeger', async () => {
      const res = await fetch(`${env('JAEGER_URL')}/api/traces?service=orders-api&operation=${encodeURIComponent('order.created publish')}&tags=${encodeURIComponent(JSON.stringify({ 'messaging.message.id': ev.event_id }))}&limit=1`);
      const json = (await res.json()) as { data: { spans: { operationName: string; processID: string }[]; processes: Record<string, { serviceName: string }> }[] };
      const t = json.data[0];
      if (!t) return undefined;
      const services = new Set(t.spans.map((s) => t.processes[s.processID]!.serviceName));
      return services.has('orders-worker') ? { t, services } : undefined;
    }, 30_000);
    const ops = trace.t.spans.map((s) => s.operationName);
    expect([...trace.services].sort()).toEqual(['orders-api', 'orders-worker']);
    expect(ops).toContain('POST');
    expect(ops).toContain('order.created publish');
    expect(ops).toContain('order.created process');
  }, 45_000);
});
