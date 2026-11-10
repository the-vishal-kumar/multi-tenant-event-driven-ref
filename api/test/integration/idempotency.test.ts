import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { hmacVerifier, signToken } from '../../src/auth';
import { withTenant } from '../../src/db';
import { pgOrdersRepo } from '../../src/orders';
import { env, newTenant, pool, pools } from './helpers';

const body = { currency: 'USD', items: [{ sku: 'IDEM-1', quantity: 3, unit_price_cents: 250 }] };
let tenant: string;
let token: string;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  tenant = await newTenant('idem');
  token = await signToken(env('JWT_SECRET'), tenant, 'test');
  app = buildApp({ orders: pgOrdersRepo(pool('DATABASE_URL_API')), verify: hmacVerifier(env('JWT_SECRET')) });
});
afterAll(async () => {
  await app.close();
  await Promise.all(pools.map((p) => p.end()));
});

const post = (key: string, payload: object = body) =>
  app.inject({ method: 'POST', url: '/v1/orders', payload, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key } });

describe('idempotency against Postgres', () => {
  it('creates exactly one order and one outbox event for 20 concurrent retries', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => post('concurrent-key')));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 200)).toHaveLength(19);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);

    const id = results[0]!.json().id;
    const outbox = await pool('DATABASE_URL_RELAY').query(
      `SELECT count(*)::int AS n FROM outbox WHERE payload->>'order_id' = $1`, [id]);
    expect(outbox.rows[0].n).toBe(1);
  });

  it('rejects the same key with a different body and writes nothing', async () => {
    expect((await post('k-mismatch')).statusCode).toBe(201);
    const r = await post('k-mismatch', { ...body, currency: 'EUR' });
    expect(r.statusCode).toBe(422);
    const n = await withTenant(pool('DATABASE_URL_API'), tenant, (c) =>
      c.query(`SELECT count(*)::int AS n FROM orders WHERE idempotency_key = 'k-mismatch'`));
    expect(n.rows[0].n).toBe(1);
  });

  it('returns 403 for a validly signed token naming a tenant that does not exist', async () => {
    const ghost = await signToken(env('JWT_SECRET'), '00000000-0000-4000-8000-000000000000', 'ghost');
    const r = await app.inject({
      method: 'POST', url: '/v1/orders', payload: body,
      headers: { authorization: `Bearer ${ghost}`, 'idempotency-key': 'ghost' },
    });
    expect(r.statusCode).toBe(403);
  });
});
