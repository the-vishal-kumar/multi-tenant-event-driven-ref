// Admin commands. These run with the owner role (migrate, create-tenant) or
// the signing secret (token), so they are operator tools, not API endpoints.
//
//   node dist/cli.js migrate
//   node dist/cli.js create-tenant <name>     prints the tenant id
//   node dist/cli.js token <tenant-id> [sub]  prints a 1-hour JWT
import path from 'node:path';
import { Client } from 'pg';
import { signToken } from './auth';
import { migrate } from './migrate';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

export async function createTenant(ownerUrl: string, name: string): Promise<string> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    // Idempotent by name so the demo can run repeatedly.
    const r = await client.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id::text`,
      [name],
    );
    return r.rows[0]!.id;
  } finally {
    await client.end();
  }
}

const USAGE = `Usage: node dist/cli.js <command>

  migrate                    apply db/migrations (needs DATABASE_URL_OWNER)
  create-tenant <name>       create a tenant, print its id (needs DATABASE_URL_OWNER)
  token <tenant-id> [sub]    print a 1-hour JWT for the tenant (needs JWT_SECRET)
  help                       show this help`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'migrate': {
      const dir = process.env.MIGRATIONS_DIR ?? path.resolve(__dirname, '../../db/migrations');
      const applied = await migrate(env('DATABASE_URL_OWNER'), dir);
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
      return;
    }
    case 'create-tenant': {
      if (!args[0]) throw new Error('usage: create-tenant <name>');
      console.log(await createTenant(env('DATABASE_URL_OWNER'), args[0]));
      return;
    }
    case 'token': {
      if (!args[0]) throw new Error('usage: token <tenant-id> [subject]');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args[0])) {
        throw new Error(`tenant id must be a UUID (the output of create-tenant), got "${args[0]}"`);
      }
      console.log(await signToken(env('JWT_SECRET'), args[0], args[1] ?? 'cli-user'));
      return;
    }
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE);
      return;
    default:
      throw new Error(cmd ? `unknown command "${cmd}"\n\n${USAGE}` : USAGE);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
