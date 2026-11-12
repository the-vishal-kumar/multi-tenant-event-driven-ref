# Security

This is a reference implementation, not a hosted service. It has no
production deployment and holds no real data.

## Reporting a vulnerability

If you find a way to read or change another tenant's data, bypass the
row-level security policies, or get a service role more privileges than its
grants allow, please report it privately through
[GitHub's private vulnerability reporting](https://github.com/the-vishal-kumar/multi-tenant-event-driven-ref/security/advisories/new)
rather than a public issue. Include the steps to reproduce against the
docker compose stack.

## What is in scope

- Tenant isolation: RLS policies, role grants, the tenant setting
  (`db/migrations`, `api/src/db.ts`, `worker/internal/store`).
- Token verification and how the tenant is derived (`api/src/auth.ts`).
- Message handling that could apply one tenant's event to another
  (`worker/internal/consumer`).

## Known, deliberate weaknesses

- Tokens are HS256 with a shared secret, and every secret in
  `docker-compose.yml` is a throwaway dev value. Production would verify an
  identity provider's asymmetric tokens and load secrets from a manager.
- `app.tenant_id` is an ordinary setting. A service role that could run
  arbitrary SQL (for example through SQL injection) could set any tenant.
  All queries are parameterised; see ADR 0001 for the trade-off.
