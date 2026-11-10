#!/usr/bin/env bash
# Runs the k6 test against the local compose stack at one arrival rate and
# writes the results to loadtest/results/<rate>rps-<date>.*
#   loadtest/run.sh [rate] [duration]      e.g. loadtest/run.sh 200 60s
set -euo pipefail
cd "$(dirname "$0")/.."
RATE=${1:-100}
DURATION=${2:-60s}
RUN_ID="load-$(date +%s)"
OUT="loadtest/results/${RATE}rps-$(date +%Y%m%d-%H%M%S)"
mkdir -p loadtest/results

docker compose --progress quiet up -d --build --wait
docker compose --progress quiet --profile tools build tools

# Four tenants, so requests spread across tenants like real traffic.
mapfile -t LINES < <(docker compose --progress quiet --profile tools run --rm --no-deps -T tools \
  npx tsx scripts/tenants.ts "$RUN_ID-a" "$RUN_ID-b" "$RUN_ID-c" "$RUN_ID-d")
TENANTS=$(printf '%s\n' "${LINES[@]}" | cut -d' ' -f1 | tr '\n' ' ')
TOKENS=$(printf '%s\n' "${LINES[@]}" | cut -d' ' -f2 | paste -sd, -)

docker run --rm --network mtedr_default -u "$(id -u):$(id -g)" \
  -v "$PWD/loadtest":/loadtest -w /loadtest \
  -e API_URL=http://api:3000 -e TOKENS="$TOKENS" -e RATE="$RATE" -e DURATION="$DURATION" -e RUN_ID="$RUN_ID" \
  grafana/k6:0.57.0 run --quiet --no-color --summary-export "/$OUT.json" orders.js \
  2>&1 | tee "$OUT.txt" || true   # threshold failures are recorded, not hidden

echo "Waiting for the worker to drain, then measuring create -> confirmed lag..."
sleep 10
docker compose --progress quiet --profile tools run --rm --no-deps tools \
  npx tsx scripts/lag.ts $TENANTS | tee "$OUT.lag.json"  # word-split on purpose
