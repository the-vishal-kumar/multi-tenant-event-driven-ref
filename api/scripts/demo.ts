// Walks the running stack through the interesting cases and prints what
// happened. Run it with scripts/demo.sh, which also starts the stack and runs
// the worker's redrive command at the end.
//
//   demo.ts            the main walkthrough
//   demo.ts dlq        print the DLQ depth and contents
import { randomUUID } from 'node:crypto';
import {
  api, depth, envelope, eventFor, findInDLQ, inject, runId, sql, tenant, waitFor, type Tenant,
} from '../test/e2e/stack';

const log = (s = '') => console.log(s);
const step = (s: string) => log(`\n== ${s}`);
const show = (label: string, v: unknown) => log(`   ${label.padEnd(22)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);

const order = (sku: string, qty: number, cents: number) => ({ currency: 'EUR', items: [{ sku, quantity: qty, unit_price_cents: cents }] });

async function confirmed(t: Tenant, id: string) {
  return waitFor(`order ${id}`, async () => {
    const r = await api(t, 'GET', `/v1/orders/${id}`);
    return r.body.status === 'confirmed' ? r.body : undefined;
  });
}

async function main(): Promise<void> {
  const run = runId();

  step('Two tenants, each with its own signed token (tenant id is a claim in the JWT)');
  const acme = await tenant('demo-acme');
  const globex = await tenant('demo-globex');
  show('acme', acme.id);
  show('globex', globex.id);

  step('acme creates an order with an Idempotency-Key');
  const key = `checkout-${run}`;
  const first = await api(acme, 'POST', '/v1/orders', { body: order('BOOK-42', 2, 1599), key });
  show('POST /v1/orders', `${first.status} ${first.body.status} total=${first.body.total_cents}`);
  show('order id', first.body.id);

  step('The client retries the same request (same key, same body)');
  const retry = await api(acme, 'POST', '/v1/orders', { body: order('BOOK-42', 2, 1599), key });
  show('POST /v1/orders', `${retry.status} Idempotent-Replayed=${retry.headers.get('idempotent-replayed')}`);
  show('same order?', retry.body.id === first.body.id);

  step('The same key with a different body is refused');
  const reused = await api(acme, 'POST', '/v1/orders', { body: order('BOOK-42', 3, 1599), key });
  show('POST /v1/orders', `${reused.status} ${JSON.stringify(reused.body)}`);

  step('globex creates its own order; it cannot see acme\'s');
  const g = await api(globex, 'POST', '/v1/orders', { body: order('LAMP-7', 1, 4500), key: `checkout-${run}` });
  show('globex POST', `${g.status} (same key string, different tenant: no clash)`);
  const peek = await api(globex, 'GET', `/v1/orders/${first.body.id}`);
  show('globex GET acme order', `${peek.status} ${JSON.stringify(peek.body)}`);

  step('Outbox -> SQS -> Go worker confirms both orders');
  const a = await confirmed(acme, first.body.id);
  const b = await confirmed(globex, g.body.id);
  const ev = await eventFor(first.body.id);
  show('acme order', `${a.status} after ${Date.parse(a.processed_at) - Date.parse(a.created_at)} ms`);
  show('globex order', `${b.status} after ${Date.parse(b.processed_at) - Date.parse(b.created_at)} ms`);

  step('SQS is at-least-once: deliver acme\'s event a second time');
  await inject(envelope(ev.event_id, acme.id, first.body.id), { tenant_id: acme.id, event_id: ev.event_id });
  const dups = await waitFor('dedupe', async () => {
    const [r] = await sql<{ duplicate_deliveries: number }>('DATABASE_URL_WORKER', acme.id,
      'SELECT duplicate_deliveries FROM processed_messages WHERE event_id = $1', [ev.event_id]);
    return r && r.duplicate_deliveries > 0 ? r.duplicate_deliveries : undefined;
  });
  show('duplicate deliveries', `${dups} (recorded and skipped; the order was applied once)`);

  step('Poison message: routed as globex but naming acme\'s order');
  const forged = randomUUID();
  await inject(envelope(forged, globex.id, first.body.id), { tenant_id: globex.id, event_id: forged });
  log('   RLS hides acme\'s order from a globex transaction, so this can never succeed.');
  log('   The worker retries with exponential backoff (1s, 2s, 4s + jitter), then dead-letters it.');
  const t0 = Date.now();
  const dead = await waitFor('DLQ', () => findInDLQ(forged), 60_000);
  show('dead-lettered after', `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  show('failure_reason', dead.attrs.failure_reason);
  show('failed_attempts', dead.attrs.failed_attempts);
  const still = await api(acme, 'GET', `/v1/orders/${first.body.id}`);
  show('acme order untouched', `${still.body.status}, processed_at unchanged: ${still.body.processed_at === a.processed_at}`);

  step('Malformed message: dead-lettered on the first attempt (retrying cannot help)');
  const junk = randomUUID();
  await inject('{"not": json', { tenant_id: acme.id, event_id: junk });
  const junkDead = await waitFor('DLQ', () => findInDLQ(junk), 20_000);
  show('failure_reason', junkDead.attrs.failure_reason.slice(0, 60));
  show('failed_attempts', junkDead.attrs.failed_attempts);

  step('Queue depths (the DLQ also holds anything from earlier runs)');
  show('orders-events', await depth('QUEUE_URL'));
  show('orders-events-dlq', await depth('DLQ_URL'));
}

async function dlq(): Promise<void> {
  show('orders-events-dlq depth', await depth('DLQ_URL'));
}

(process.argv[2] === 'dlq' ? dlq() : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
