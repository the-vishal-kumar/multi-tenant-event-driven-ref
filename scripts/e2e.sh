#!/usr/bin/env bash
# End-to-end test through docker compose. Starts the stack if needed.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up -d --build --wait
docker compose --profile tools run --build --rm --no-deps tools npm run test:e2e
