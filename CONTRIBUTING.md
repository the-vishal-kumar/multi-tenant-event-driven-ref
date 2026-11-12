# Contributing

Everything runs in containers; the host needs only Docker with Compose v2.

```sh
scripts/test.sh    # API typecheck, unit + integration; Go vet + race tests; end-to-end
scripts/lint.sh    # terraform fmt/validate, tflint, checkov, actionlint
scripts/audit.sh   # npm audit, govulncheck, trivy on the built images
docker compose down -v
```

CI runs the same three scripts on every pull request.

## Test strategy

Each layer is tested where its guarantee lives:

| Layer | Where | What it pins |
|---|---|---|
| API unit | `api/test/unit` | Validation, status codes, idempotency contract, token checks. No database. |
| API integration | `api/test/integration` | RLS policies and grants against the real Postgres, as each service role; catalog guards (no superuser/`BYPASSRLS`, every `tenant_id` table forced); idempotent create under 20 concurrent retries; outbox relay against LocalStack SQS, including concurrent relays and failure handling. |
| Worker | `worker/internal/...` | Backoff, dead-lettering, redrive, dedupe under 16 concurrent deliveries, cross-tenant messages, against Postgres and LocalStack. Run with `-race`. |
| End-to-end | `api/test/e2e` | HTTP → Postgres → relay → SQS → worker → Postgres through the compose stack, plus the trace in Jaeger. |
| Load | `loadtest/` | k6 at fixed rates; results are committed with their method. |

Rules of thumb:

- A tenant-isolation property is tested against Postgres, never a mock.
- A new table with a `tenant_id` column needs RLS enabled and forced in the
  same migration; the catalog test fails otherwise.
- Migrations are append-only: add `db/migrations/NNNN_*.sql`, don't edit an
  applied one.
- A decision that changes a trade-off gets an ADR in `docs/adr`.

## Commits and pull requests

Small commits with conventional prefixes (`fix:`, `feat:`, `test:`, `docs:`,
`ci:`, `chore:`), each saying why. The pull request template asks for the
commands you ran.
