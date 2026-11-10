#!/usr/bin/env bash
# One-command demo: builds and starts the stack, walks through the main
# cases, then redrives the DLQ. Needs only Docker.
#   scripts/demo.sh            (leave the stack running afterwards)
#   docker compose down -v     (tear it down)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Starting the stack (Postgres, LocalStack SQS, Jaeger, API, worker)..."
docker compose --progress quiet up -d --build --wait
docker compose --progress quiet --profile tools build tools

docker compose --progress quiet --profile tools run --rm --no-deps tools npx tsx scripts/demo.ts

echo
echo "== Redrive: move everything in the DLQ back to the main queue"
docker compose --progress quiet run --rm --no-deps worker redrive
docker compose --progress quiet --profile tools run --rm --no-deps tools npx tsx scripts/demo.ts dlq
echo "   The poison message is still poison: the worker will dead-letter it again"
echo "   after its retries. Redrive is for after the cause is fixed."

echo
echo "Traces: http://localhost:16686 (service orders-api, operation POST)"
echo "Worker log: docker compose logs worker"
