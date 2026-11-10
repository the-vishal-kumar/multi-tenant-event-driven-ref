#!/bin/sh
# Local development only: creates the owner and service roles with
# throwaway passwords. Runs once, as the postgres superuser, when the
# container's data volume is first created. In AWS these roles are created by
# a one-off migration task with passwords from Secrets Manager.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE orders_owner LOGIN PASSWORD 'owner-dev-only';
CREATE ROLE app_api      LOGIN PASSWORD 'api-dev-only'    NOBYPASSRLS;
CREATE ROLE app_relay    LOGIN PASSWORD 'relay-dev-only'  NOBYPASSRLS;
CREATE ROLE app_worker   LOGIN PASSWORD 'worker-dev-only' NOBYPASSRLS;
CREATE DATABASE orders OWNER orders_owner;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname orders \
  -c 'ALTER SCHEMA public OWNER TO orders_owner'
