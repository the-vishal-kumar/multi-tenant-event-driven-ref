#!/usr/bin/env bash
# Every check, in containers: API typecheck + unit + integration, Go vet +
# tests (unit and against Postgres/LocalStack), and the end-to-end test.
# Leaves the stack running; `docker compose down -v` to stop it.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --build --wait
docker compose --profile tools build tools

echo "--- api: typecheck, unit, integration"
docker compose --profile tools run --rm --no-deps tools \
  sh -c 'npx tsc --noEmit && npm test && npm run test:integration'

echo "--- worker: gofmt, vet, tests (with Postgres and LocalStack)"
docker run --rm --network mtedr_default \
  -v "$PWD/worker":/src -w /src \
  -e DATABASE_URL_OWNER=postgres://orders_owner:owner-dev-only@db:5432/orders \
  -e DATABASE_URL_API=postgres://app_api:api-dev-only@db:5432/orders \
  -e DATABASE_URL_WORKER=postgres://app_worker:worker-dev-only@db:5432/orders \
  -e SQS_ENDPOINT=http://localstack:4566 -e AWS_REGION=us-east-1 \
  -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test \
  golang:1.27.3-bookworm \
  sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go test -race -count=1 ./...'

echo "--- end-to-end"
docker compose --profile tools run --rm --no-deps tools npm run test:e2e
