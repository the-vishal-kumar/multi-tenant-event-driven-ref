# ADR 0001: Shared schema with Postgres row-level security

- Status: accepted
- Date: 2026-11-10

## Context

Every order belongs to exactly one tenant. A leak between tenants is the
worst failure this system can have: worse than downtime, because it can't be
rolled back. Tenants are many and small, and the same code serves all of
them. The options:

| | Shared tables + RLS | Schema per tenant | Database per tenant |
|---|---|---|---|
| Isolation enforced by | Postgres policies on every query | `search_path` per connection | Network and credentials |
| Cost per extra tenant | ~0 | Small (catalog bloat) | An instance or cluster |
| Migrations | Once | N times; drift risk | N times; fleet tooling |
| Connection pooling | One pool | Pool per schema, or reset `search_path` | Pool per database |
| Noisy neighbour | Shared; needs app-level limits | Shared | Isolated |
| Per-tenant restore / residency | Hard (row-level export) | Moderate | Easy |
| Bug that forgets the tenant filter | Fails closed (policy) | Wrong schema if `search_path` leaks | Wrong DSN if config leaks |

## Decision

Shared tables with a `tenant_id` column and row-level security:

- Policies compare `tenant_id` with `app_tenant_id()`, which reads
  `current_setting('app.tenant_id', true)`. Unset or empty is `NULL`, and
  `NULL` matches nothing: **no tenant, no rows**. A malformed value fails
  the `uuid` cast and errors.
- The setting is applied with `set_config(..., true)`, which is
  **transaction-local**: it disappears at `COMMIT` or `ROLLBACK`, so a
  pooled connection can't carry one request's tenant into the next. All
  tenant queries go through one helper (`withTenant` in the API,
  `inTenant` in the worker).
- Tenant tables are `FORCE ROW LEVEL SECURITY` and services connect as
  **non-owner roles without `BYPASSRLS`**, so even a superficially correct
  query that forgets `WHERE tenant_id = ...` is filtered by the database.
- Each service has its own role with column-level grants: the API cannot
  update or delete orders; the worker cannot insert them; the outbox relay,
  which is cross-tenant by design, can read the outbox and nothing else.
- The tenant comes from a verified JWT claim, never from a path, header or
  body.
- **Only the migrate job holds the owner's credentials.** The owner owns the
  tables, so it can `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` and read
  everything. The API and worker containers get only their own role's
  connection string, locally and in the ECS task definitions.

The integration tests (`api/test/integration/rls.test.ts`,
`worker/internal/store/store_test.go`) check these properties against a real
Postgres: unfiltered queries, no tenant set, forged `tenant_id` on insert,
setting cleared after commit and rollback on the same connection and on a
one-connection pool, and each role's missing privileges. Catalog tests fail
the build if any application role is a superuser or has `BYPASSRLS`, if a
service role owns an object, is a member of the owner or can create objects,
or if any table with a `tenant_id` column lacks forced RLS.

## Consequences

- Cheap tenants and one migration path. Fits a long tail of small tenants.
- Isolation depends on Postgres policies being right. They are short and
  tested; adding a tenant table means adding its policy in the same
  migration, and the catalog test fails if the table lacks forced RLS.
- `app.tenant_id` is an ordinary setting, not a credential: any session of a
  service role can set it to any tenant. The boundary is "the service only
  runs its own parameterised queries". SQL injection in a service would
  cross it. Stronger options, at more cost: a role per tenant (`SET ROLE`,
  thousands of roles), or a signed tenant token checked by a
  `SECURITY DEFINER` function in every policy.
- Noisy neighbours share capacity. Mitigate with per-tenant rate limits at
  the API and, if one tenant dominates, by moving it out.
- Per-tenant restore, deletion and data residency need row-level tooling.
- RLS predicates need `tenant_id` leading in indexes
  (`orders (tenant_id, created_at)`, `UNIQUE (tenant_id, idempotency_key)`).

## When to revisit

A tenant that needs its own region, encryption key, maintenance window or
guaranteed capacity gets its own database (a "silo" tier) behind the same
code: the tenant → DSN lookup becomes a routing step and RLS stays as
defence in depth. Schema-per-tenant is the option I would not pick: it
multiplies migrations without giving the operational isolation of a
separate database.
