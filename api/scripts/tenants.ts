// Creates (or reuses) tenants and prints "<tenant-id> <token>" per line.
//   tsx scripts/tenants.ts <name>...
import { tenant } from '../test/e2e/stack';

(async () => {
  for (const name of process.argv.slice(2)) {
    const t = await tenant(name);
    console.log(`${t.id} ${t.token}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
