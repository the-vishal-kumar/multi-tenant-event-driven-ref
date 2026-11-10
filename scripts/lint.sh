#!/usr/bin/env bash
# Static checks, all in containers: terraform fmt/validate, tflint (AWS
# ruleset), checkov, and actionlint for the CI workflow. Nothing here talks
# to an AWS account: `init -backend=false` only downloads the provider.
set -euo pipefail
cd "$(dirname "$0")/.."
TF=infra/terraform
U="$(id -u):$(id -g)"

tf() { docker run --rm -u "$U" -e HOME=/tmp -v "$PWD/$TF":/tf -w /tf hashicorp/terraform:1.10.5 "$@"; }

echo "--- terraform fmt"
tf fmt -check -recursive
echo "--- terraform validate"
tf init -backend=false -input=false >/dev/null
tf validate
echo "--- tflint"
docker run --rm -u "$U" -e HOME=/tmp -v "$PWD/$TF":/data -w /data --entrypoint sh \
  ghcr.io/terraform-linters/tflint:v0.55.1 -c 'tflint --init >/dev/null && tflint --format compact'
echo "--- checkov"
docker run --rm -u "$U" -e HOME=/tmp -v "$PWD/$TF":/tf -w /tf \
  bridgecrew/checkov:3.2.400 -d /tf --config-file /tf/.checkov.yaml
echo "--- actionlint"
docker run --rm -u "$U" -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.7 -color
echo "all static checks passed"
