-- Order-processing schema with shared tables and row-level security.
--
-- This file runs as the schema owner `orders_owner`, an ordinary role (not a
-- superuser). Services connect as separate NON-owner roles without
-- BYPASSRLS, so every query they make goes through the policies below:
--
--   app_api     the HTTP API: reads and creates its tenant's orders, writes outbox rows
--   app_relay   the outbox relay: reads and marks outbox rows for all tenants, nothing else
--   app_worker  the queue consumer: confirms its message's tenant's orders, records dedupe rows
--
-- The roles must exist before this runs (db/init creates them locally).

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_api, app_relay, app_worker;
DO $$ BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;

-- Tenant context. Services set it per transaction with
-- set_config('app.tenant_id', $1, true), so it is gone at COMMIT/ROLLBACK and
-- cannot leak to the next request on a pooled connection. Unset or empty
-- means NULL, and NULL never equals anything: no tenant, no rows.
CREATE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

REVOKE ALL ON FUNCTION app_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_tenant_id() TO app_api, app_worker;

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_hash    text NOT NULL,   -- sha256 of the canonical request body
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_cents     bigint NOT NULL CHECK (total_cents >= 0),
  items           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX orders_tenant_created_idx ON orders (tenant_id, created_at DESC);

-- Transactional outbox: written in the same transaction as the order, so an
-- order exists if and only if its event will eventually be published.
CREATE TABLE outbox (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id         uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  traceparent      text,           -- W3C trace context of the request that wrote the row
  tracestate       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  publish_attempts int NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

-- Consumer dedupe: one row per event the worker has applied. Inserted in the
-- same transaction as the side effect, so "applied" and "recorded" commit
-- together.
CREATE TABLE processed_messages (
  event_id             uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  order_id             uuid NOT NULL,
  processed_at         timestamptz NOT NULL DEFAULT now(),
  duplicate_deliveries int NOT NULL DEFAULT 0
);

-- ---- row-level security ----
-- Tenant data tables are FORCEd, so even the owner is subject to policies;
-- there is no owner policy, so an owner session sees no orders at all.
-- `tenants` itself is not FORCEd: the owner provisions tenants (the
-- `create-tenant` admin command). Service roles are not the owner, so the
-- policy below still applies to them.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_self ON tenants FOR SELECT TO app_api, app_worker
  USING (id = app_tenant_id());

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_api_select ON orders FOR SELECT TO app_api
  USING (tenant_id = app_tenant_id());
CREATE POLICY orders_api_insert ON orders FOR INSERT TO app_api
  WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY orders_worker_select ON orders FOR SELECT TO app_worker
  USING (tenant_id = app_tenant_id());
CREATE POLICY orders_worker_update ON orders FOR UPDATE TO app_worker
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_api_insert ON outbox FOR INSERT TO app_api
  WITH CHECK (tenant_id = app_tenant_id());
-- The relay is a transport: it moves every tenant's events and has no access
-- to orders at all. Cross-tenant by design, so it is a separate role.
CREATE POLICY outbox_relay_select ON outbox FOR SELECT TO app_relay USING (true);
CREATE POLICY outbox_relay_update ON outbox FOR UPDATE TO app_relay USING (true) WITH CHECK (true);

ALTER TABLE processed_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY processed_worker_all ON processed_messages FOR ALL TO app_worker
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- ---- grants: only what each service's queries need ----

GRANT SELECT ON tenants TO app_api, app_worker;

GRANT SELECT ON orders TO app_api;
GRANT INSERT (tenant_id, idempotency_key, request_hash, currency, total_cents, items)
  ON orders TO app_api;
GRANT INSERT (tenant_id, event_type, payload, traceparent, tracestate) ON outbox TO app_api;

GRANT SELECT ON outbox TO app_relay;
GRANT UPDATE (published_at, publish_attempts) ON outbox TO app_relay;

GRANT SELECT (id, tenant_id, status, processed_at) ON orders TO app_worker;
GRANT UPDATE (status, processed_at) ON orders TO app_worker;
GRANT SELECT, INSERT ON processed_messages TO app_worker;
GRANT UPDATE (duplicate_deliveries) ON processed_messages TO app_worker;
