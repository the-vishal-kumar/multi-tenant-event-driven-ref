import { createHash } from 'node:crypto';
import { context, propagation } from '@opentelemetry/api';
import type { Pool, PoolClient } from 'pg';
import { pgCode, withTenant } from './db';

export interface OrderItem {
  sku: string;
  quantity: number;
  unit_price_cents: number;
}

export interface OrderInput {
  currency: string;
  items: OrderItem[];
}

export interface Order {
  id: string;
  status: 'pending' | 'confirmed';
  currency: string;
  total_cents: number;
  items: OrderItem[];
  created_at: string;
  processed_at: string | null;
}

export type CreateResult =
  | { kind: 'created'; order: Order }
  | { kind: 'replayed'; order: Order }
  | { kind: 'key_reused' }; // same key, different request body

export class UnknownTenantError extends Error {}

export interface OrdersRepo {
  create(tenantId: string, idempotencyKey: string, input: OrderInput): Promise<CreateResult>;
  get(tenantId: string, id: string): Promise<Order | undefined>;
  list(tenantId: string, limit: number): Promise<Order[]>;
}

export const ORDER_CREATED = 'order.created';

/**
 * Hash of the request in a fixed field order, so a retry with the same body
 * matches regardless of JSON key order or whitespace. Item order is part of
 * the request and is kept.
 */
export function requestHash(input: OrderInput): string {
  const canonical = JSON.stringify({
    currency: input.currency,
    items: input.items.map((i) => [i.sku, i.quantity, i.unit_price_cents]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function totalCents(items: OrderItem[]): number {
  return items.reduce((sum, i) => sum + i.quantity * i.unit_price_cents, 0);
}

const COLS = `id::text, status, currency, total_cents::float8 AS total_cents, items,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(processed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS processed_at`;

/** W3C trace context of the current span, stored with the outbox row. */
function currentTraceContext(): { traceparent: string | null; tracestate: string | null } {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return { traceparent: carrier.traceparent ?? null, tracestate: carrier.tracestate ?? null };
}

export function pgOrdersRepo(pool: Pool): OrdersRepo {
  return {
    async create(tenantId, idempotencyKey, input) {
      const hash = requestHash(input);
      try {
        return await withTenant(pool, tenantId, async (c) => {
          // ON CONFLICT DO NOTHING waits for a concurrent insert of the same
          // key to commit, then returns no row, so racing retries are safe.
          const inserted = await c.query<Order>(
            `INSERT INTO orders (tenant_id, idempotency_key, request_hash, currency, total_cents, items)
             VALUES (app_tenant_id(), $1, $2, $3, $4, $5)
             ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
             RETURNING ${COLS}`,
            [idempotencyKey, hash, input.currency, totalCents(input.items), JSON.stringify(input.items)],
          );
          const order = inserted.rows[0];
          if (order) {
            await writeOutbox(c, order);
            return { kind: 'created', order };
          }
          const existing = await c.query<Order & { request_hash: string }>(
            `SELECT ${COLS}, request_hash FROM orders WHERE idempotency_key = $1`,
            [idempotencyKey],
          );
          const row = existing.rows[0];
          if (!row) throw new Error('idempotency conflict without a visible row');
          if (row.request_hash !== hash) return { kind: 'key_reused' };
          const { request_hash: _, ...prior } = row;
          return { kind: 'replayed', order: prior };
        });
      } catch (err) {
        // FK violation: the token names a tenant that does not exist.
        if (pgCode(err) === '23503') throw new UnknownTenantError();
        throw err;
      }
    },

    async get(tenantId, id) {
      return withTenant(pool, tenantId, async (c) => {
        const r = await c.query<Order>(`SELECT ${COLS} FROM orders WHERE id = $1`, [id]);
        return r.rows[0];
      });
    },

    async list(tenantId, limit) {
      return withTenant(pool, tenantId, async (c) => {
        const r = await c.query<Order>(
          `SELECT ${COLS} FROM orders ORDER BY created_at DESC LIMIT $1`,
          [limit],
        );
        return r.rows;
      });
    },
  };
}

async function writeOutbox(c: PoolClient, order: Order): Promise<void> {
  const { traceparent, tracestate } = currentTraceContext();
  await c.query(
    `INSERT INTO outbox (tenant_id, event_type, payload, traceparent, tracestate)
     VALUES (app_tenant_id(), $1, $2, $3, $4)`,
    [
      ORDER_CREATED,
      JSON.stringify({ order_id: order.id, total_cents: order.total_cents, currency: order.currency }),
      traceparent,
      tracestate,
    ],
  );
}
