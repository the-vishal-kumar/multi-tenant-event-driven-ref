#!/usr/bin/env bash
# Dependency and image vulnerability checks, all in containers:
#   npm audit     API dependencies (fails on high or critical)
#   govulncheck   worker module and the Go standard library it is built with
#                 (fails only on vulnerabilities the code can reach)
#   trivy         the built API and worker images (fails on fixable high or
#                 critical findings in OS packages and libraries)
# Builds the images first if they are missing.
set -euo pipefail
cd "$(dirname "$0")/.."
U="$(id -u):$(id -g)"
GO_IMAGE=golang:1.27.4-bookworm # keep in step with worker/Dockerfile

echo "--- npm audit (api)"
docker run --rm -u "$U" -e HOME=/tmp -v "$PWD/api":/src:ro -w /src node:22-alpine \
  npm audit --audit-level=high

echo "--- govulncheck (worker)"
docker run --rm -u "$U" -e HOME=/tmp -e GOCACHE=/tmp/gocache -e GOPATH=/tmp/gopath \
  -v "$PWD/worker":/src:ro -w /src "$GO_IMAGE" \
  go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...

echo "--- trivy (images)"
docker compose build migrate worker
# One container for both images, so the vulnerability DB downloads once.
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro --entrypoint sh \
  aquasec/trivy:0.76.1 -c '
    set -e
    for image in mtedr-api:local mtedr-worker:local; do
      echo "$image"
      trivy image --quiet --scanners vuln --ignore-unfixed \
        --severity HIGH,CRITICAL --exit-code 1 "$image"
    done'
echo "all audits passed"
