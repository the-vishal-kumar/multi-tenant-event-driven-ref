import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { AuthError, type Verifier } from '../../src/auth';
import { requestHash, totalCents, type Order, type OrderInput, type OrdersRepo } from '../../src/orders';

// In-memory repo with the same idempotency contract as the Postgres one.
function memoryRepo(): OrdersRepo {
  const byKey = new Map<string, { hash: string; order: Order }>();
  return {
    async create(tenantId, key, input) {
      const k = `${tenantId}/${key}`;
      const prior = byKey.get(k);
      if (prior) return prior.hash === requestHash(input) ? { kind: 'replayed', order: prior.order } : { kind: 'key_reused' };
      const order: Order = {
        id: crypto.randomUUID(), status: 'pending', currency: input.currency,
        total_cents: totalCents(input.items), items: input.items,
        created_at: new Date().toISOString(), processed_at: null,
      };
      byKey.set(k, { hash: requestHash(input), order });
      return { kind: 'created', order };
    },
    async get(tenantId, id) {
      for (const [k, v] of byKey) if (k.startsWith(`${tenantId}/`) && v.order.id === id) return v.order;
      return undefined;
    },
    async list(tenantId) {
      return [...byKey].filter(([k]) => k.startsWith(`${tenantId}/`)).map(([, v]) => v.order);
    },
  };
}

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const verify: Verifier = async (h) => {
  if (h === 'Bearer a') return { subject: 'a', tenantId: TENANT_A };
  if (h === 'Bearer b') return { subject: 'b', tenantId: TENANT_B };
  throw new AuthError('bad');
};
const body: OrderInput = { currency: 'EUR', items: [{ sku: 'SKU-1', quantity: 2, unit_price_cents: 500 }] };

describe('orders API', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    app = buildApp({ orders: memoryRepo(), verify });
  });

  const post = (auth: string | undefined, key: string | undefined, payload: unknown) =>
    app.inject({
      method: 'POST', url: '/v1/orders', payload: payload as object,
      headers: { ...(auth && { authorization: auth }), ...(key && { 'idempotency-key': key }) },
    });

  it('requires a token', async () => {
    const r = await post(undefined, 'k1', body);
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Bearer');
  });

  it('requires an Idempotency-Key', async () => {
    expect((await post('Bearer a', undefined, body)).statusCode).toBe(400);
    expect((await post('Bearer a', 'has space', body)).statusCode).toBe(400);
  });

  it('rejects bodies that do not match the schema instead of fixing them up', async () => {
    for (const bad of [
      { currency: 'eur', items: body.items },
      { currency: 'EUR', items: [] },
      { currency: 'EUR', items: [{ sku: 'X', quantity: '2', unit_price_cents: 1 }] },
      { ...body, tenant_id: TENANT_B },
    ]) {
      const r = await post('Bearer a', 'k-bad', bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('creates once and replays the same response for the same key and body', async () => {
    const first = await post('Bearer a', 'k1', body);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ status: 'pending', total_cents: 1000 });
    const again = await post('Bearer a', 'k1', body);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().id).toBe(first.json().id);
  });

  it('rejects a reused key with a different body', async () => {
    await post('Bearer a', 'k1', body);
    const r = await post('Bearer a', 'k1', { ...body, currency: 'USD' });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: 'idempotency_key_reused' });
  });

  it('scopes idempotency keys and reads to the token tenant', async () => {
    const a = await post('Bearer a', 'shared-key', body);
    const b = await post('Bearer b', 'shared-key', body);
    expect(b.statusCode).toBe(201);
    expect(b.json().id).not.toBe(a.json().id);
    const cross = await app.inject({ method: 'GET', url: `/v1/orders/${a.json().id}`, headers: { authorization: 'Bearer b' } });
    expect(cross.statusCode).toBe(404);
  });

  it('returns 404 for a malformed id', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/orders/not-a-uuid', headers: { authorization: 'Bearer a' } });
    expect(r.statusCode).toBe(404);
  });
});
