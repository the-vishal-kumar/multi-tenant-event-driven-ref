import { Pool, type PoolClient } from 'pg';

export function createPool(connectionString: string, max: number): Pool {
  const pool = new Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  // An idle client erroring (e.g. the DB restarted) must not crash the process.
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Runs fn in a transaction whose tenant setting is transaction-local
 * (set_config(..., true)). It disappears at COMMIT or ROLLBACK, so it cannot
 * leak to the next request that reuses the pooled connection. Every query on
 * tenant data goes through here; the RLS policies read app.tenant_id.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}

/** Postgres SQLSTATE of an error from node-postgres, if any. */
export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}
