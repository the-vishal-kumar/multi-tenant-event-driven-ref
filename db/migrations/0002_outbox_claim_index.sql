-- The relay claims rows with
--   WHERE published_at IS NULL ... ORDER BY publish_attempts, id LIMIT n
-- The partial index on (id) from 0001 can't produce that order, so Postgres
-- sorted the whole unpublished backlog on every pass: with 100,000 rows
-- waiting, one claim took ~125 ms (a sequential scan and an on-disk sort).
-- With the sort key in the index it reads only the first n entries: ~0.2 ms.
--
-- Plain CREATE INDEX (not CONCURRENTLY) because migrations run inside a
-- transaction. It briefly blocks writes to outbox; on a large production
-- table, build it CONCURRENTLY by hand first and this becomes a no-op.
CREATE INDEX IF NOT EXISTS outbox_relay_claim_idx
  ON outbox (publish_attempts, id) WHERE published_at IS NULL;
DROP INDEX IF EXISTS outbox_unpublished_idx;
