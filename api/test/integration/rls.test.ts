// Tenant isolation enforced by Postgres itself, not by the API's WHERE
// clauses. Each test talks to the database as a service role, the way the
// services do, and checks that the policies hold even for queries that
// "forget" to filter by tenant.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { withTenant } from '../../src/db';
import { pgOrdersRepo } from '../../src/orders';
import { client, newTenant, pool, pools } from './helpers';

const input = { currency: 'EUR', items: [{ sku: 'RLS-1', quantity: 1, unit_price_cents: 100 }] };
let tenantA: string;
let tenantB: string;
let orderA: string;
const api = () => pool('DATABASE_URL_API');

beforeAll(async () => {
  tenantA = await newTenant('rls-a');
  tenantB = await newTenant('rls-b');
  const r = await pgOrdersRepo(api()).create(tenantA, 'rls-key', input);
  if (r.kind !== 'created') throw new Error('setup failed');
  orderA = r.order.id;
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

describe('row-level security (app_api role)', () => {
  it('shows a tenant only its own orders, even without a WHERE clause', async () => {
    const seenByA = await withTenant(api(), tenantA, (c) => c.query('SELECT id::text FROM orders'));
    const seenByB = await withTenant(api(), tenantB, (c) => c.query('SELECT id::text FROM orders'));
    expect(seenByA.rows.map((r) => r.id)).toContain(orderA);
    expect(seenByB.rows.map((r) => r.id)).not.toContain(orderA);
  });

  it('fails closed with no tenant set', async () => {
    const c = await api().connect();
    try {
      const orders = await c.query('SELECT count(*)::int AS n FROM orders');
      const tenants = await c.query('SELECT count(*)::int AS n FROM tenants');
      expect(orders.rows[0].n).toBe(0);
      expect(tenants.rows[0].n).toBe(0);
      await expect(
        c.query(`INSERT INTO orders (tenant_id, idempotency_key, request_hash, currency, total_cents, items)
                 VALUES ($1, 'x', 'h', 'EUR', 1, '[]')`, [tenantA]),
      ).rejects.toThrow(/row-level security/);
    } finally {
      c.release();
    }
  });

  it('rejects writing a row for another tenant', async () => {
    await expect(
      withTenant(api(), tenantB, (c) =>
        c.query(`INSERT INTO orders (tenant_id, idempotency_key, request_hash, currency, total_cents, items)
                 VALUES ($1, 'forged', 'h', 'EUR', 1, '[]')`, [tenantA])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(api(), tenantB, (c) =>
        c.query(`INSERT INTO outbox (tenant_id, event_type, payload) VALUES ($1, 'order.created', '{}')`, [tenantA])),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete orders at all', async () => {
    await expect(withTenant(api(), tenantA, (c) => c.query(`UPDATE orders SET status = 'confirmed'`)))
      .rejects.toThrow(/permission denied/);
    await expect(withTenant(api(), tenantA, (c) => c.query('DELETE FROM orders')))
      .rejects.toThrow(/permission denied/);
  });

  it('rejects a malformed tenant setting instead of matching anything', async () => {
    await expect(withTenant(api(), 'not-a-uuid', (c) => c.query('SELECT * FROM orders')))
      .rejects.toThrow(/invalid input syntax for type uuid/);
  });

  describe('on a single reused connection', () => {
    let c: Client;
    beforeAll(async () => {
      c = await client('DATABASE_URL_API');
    });
    afterAll(async () => {
      await c.end();
    });

    it('drops the tenant setting at the end of the transaction', async () => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      expect((await c.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBeGreaterThan(0);
      await c.query('COMMIT');
      // Next "request" on the same pooled connection sees nothing.
      expect((await c.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(0);
    });

    it('also drops it on rollback', async () => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      await c.query('ROLLBACK');
      expect((await c.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(0);
    });
  });
});

describe('role separation', () => {
  it('relay role sees every tenant\'s outbox but no orders', async () => {
    const relay = pool('DATABASE_URL_RELAY');
    const ob = await relay.query('SELECT DISTINCT tenant_id::text FROM outbox');
    expect(ob.rows.map((r) => r.tenant_id)).toContain(tenantA);
    await expect(relay.query('SELECT 1 FROM orders LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(relay.query(`UPDATE outbox SET payload = '{}'`)).rejects.toThrow(/permission denied/);
  });

  it('worker role sees one tenant at a time and cannot create orders', async () => {
    const worker = pool('DATABASE_URL_WORKER');
    const asB = await withTenant(worker, tenantB, (c) => c.query('SELECT id FROM orders WHERE id = $1', [orderA]));
    expect(asB.rowCount).toBe(0);
    const upd = await withTenant(worker, tenantB, (c) =>
      c.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [orderA]));
    expect(upd.rowCount).toBe(0);
    await expect(withTenant(worker, tenantA, (c) =>
      c.query(`INSERT INTO orders (tenant_id, idempotency_key, request_hash, currency, total_cents, items)
               VALUES (app_tenant_id(), 'w', 'h', 'EUR', 1, '[]')`))).rejects.toThrow(/permission denied/);
  });

  it('owner role is also bound by FORCE row-level security on tenant data', async () => {
    const owner = pool('DATABASE_URL_OWNER');
    expect((await owner.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(0);
  });
});
