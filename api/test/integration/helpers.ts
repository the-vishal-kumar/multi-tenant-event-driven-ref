import { randomUUID } from 'node:crypto';
import { Client, type Pool } from 'pg';
import { createTenant } from '../../src/cli';
import { createPool } from '../../src/db';

// Integration tests run against the compose Postgres (already migrated):
//   docker compose --profile tools run --rm tools npm run test:integration
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`integration tests need ${name}; run them via the compose tools service`);
  return v;
}

export const pools: Pool[] = [];
export function pool(urlVar: string): Pool {
  const p = createPool(env(urlVar), 10);
  pools.push(p);
  return p;
}

export async function newTenant(prefix = 't'): Promise<string> {
  return createTenant(env('DATABASE_URL_OWNER'), `${prefix}-${randomUUID().slice(0, 8)}`);
}

/** A single connection, for tests that need to see session state across transactions. */
export async function client(urlVar: string): Promise<Client> {
  const c = new Client({ connectionString: env(urlVar) });
  await c.connect();
  return c;
}
