// Create-to-confirmed latency for the orders of the given tenants, measured
// in Postgres (created_at -> processed_at), i.e. through the outbox relay,
// SQS and the worker. Reads as app_api with each tenant set, like the API.
//   tsx scripts/lag.ts <tenant-id>...
import { sql } from '../test/e2e/stack';

async function main(tenants: string[]): Promise<void> {
  const lags: number[] = [];
  let pending = 0;
  for (const t of tenants) {
    const rows = await sql<{ ms: number | null }>('DATABASE_URL_API', t,
      `SELECT (extract(epoch FROM processed_at - created_at) * 1000)::float8 AS ms FROM orders`);
    for (const r of rows) {
      if (r.ms === null) pending++;
      else lags.push(r.ms);
    }
  }
  lags.sort((a, b) => a - b);
  const pct = (p: number) => lags[Math.min(lags.length - 1, Math.ceil((p / 100) * lags.length) - 1)] ?? NaN;
  const out = {
    orders: lags.length + pending,
    confirmed: lags.length,
    pending,
    p50_ms: Math.round(pct(50)),
    p95_ms: Math.round(pct(95)),
    p99_ms: Math.round(pct(99)),
    max_ms: Math.round(lags[lags.length - 1] ?? NaN),
  };
  console.log(JSON.stringify(out));
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
