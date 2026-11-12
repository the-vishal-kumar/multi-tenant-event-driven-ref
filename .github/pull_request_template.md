## Why

<!-- The problem or risk this change addresses. -->

## What changed

## How verified

<!-- Commands you ran and their results, e.g. scripts/test.sh, scripts/lint.sh, scripts/audit.sh. -->

## Checklist

- [ ] A new table with a `tenant_id` column has RLS enabled and forced, with policies, in the same migration (the catalog test in `rls.test.ts` enforces this)
- [ ] Service roles still get only the grants their queries need
- [ ] New consumers or event types are idempotent on `event_id`
- [ ] README and ADRs describe the behaviour as it is now
