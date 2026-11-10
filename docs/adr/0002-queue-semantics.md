# ADR 0002: At-least-once delivery with a transactional outbox and consumer dedupe

- Status: accepted
- Date: 2026-11-10

## Context

Creating an order must eventually trigger processing, exactly once in
effect. Two failure windows make the naive version wrong:

1. **Dual write.** `INSERT order; send message` loses the event if the
   process dies between the two, and sends an event for an order that was
   rolled back if the order is sent first.
2. **Redelivery.** SQS standard queues deliver at least once. A message can
   arrive twice (visibility timeout expired mid-processing, delete failed,
   consumer crashed after committing). FIFO queues dedupe only within a
   5-minute window and only on the send side; they don't make the consumer's
   side effect atomic.

Retries happen at the HTTP edge too: a client that times out will resend
`POST /orders`.

## Decision

Exactly-once *effect* from three pieces, each covering one window:

- **Idempotency-Key at the API.** `UNIQUE (tenant_id, idempotency_key)` and
  `INSERT ... ON CONFLICT DO NOTHING`. A retry with the same key and body
  returns the original order with `200` and `Idempotent-Replayed: true`; the
  same key with a different body is `422`. Concurrent retries serialise on
  the unique index, so exactly one creates. The key is required.
- **Transactional outbox.** The order and its `order.created` outbox row
  are inserted in one transaction. A relay (in the API process, safe to run
  in every replica thanks to `FOR UPDATE SKIP LOCKED`) publishes committed
  rows and marks them `published_at`. If it dies after sending and before
  marking, the rows are sent again: at-least-once, by design.
- **Consumer dedupe.** The worker inserts `event_id` into
  `processed_messages` and applies the side effect **in the same
  transaction**. A second delivery hits the primary key, bumps
  `duplicate_deliveries` and is acknowledged without re-applying. If the
  transaction fails, neither the dedupe row nor the effect is committed.

The W3C `traceparent` of the originating request is stored on the outbox
row and carried as an SQS message attribute, so one trace covers HTTP
request → publish → processing.

**Standard queue, not FIFO.** Order processing here has no cross-message
ordering requirement, and FIFO's throughput limits and message-group
head-of-line blocking would buy nothing the dedupe table doesn't already
give. If per-order ordering matters later (e.g. `created` before
`cancelled`), use FIFO with `MessageGroupId = order_id`, keep the dedupe.

## Alternatives considered

- **CDC (Debezium / logical replication) instead of a polling relay.** Lower
  latency and no polling load, but another stateful system to run. The
  polling relay is ~100 lines and adequate below thousands of events per
  second.
- **EventBridge Pipes from DynamoDB Streams.** Requires DynamoDB as the
  system of record; Postgres was chosen for relational order data and RLS.
- **Two-phase commit / XA.** Not available across Postgres and SQS.

## Consequences

- Every consumer must be idempotent; the dedupe table is the contract.
- Two extra writes per order (outbox row, dedupe row). Both tables grow
  without bound and need pruning: delete published outbox rows and dedupe
  rows older than the queue's retention (4 days) plus a margin. Not
  implemented here; listed in the README.
- Publish latency is bounded by the relay poll interval (200 ms default)
  when idle; under load it drains in batches without sleeping.
- The relay holds a transaction open while it calls SQS. Fine for batches
  of tens; at higher volume, claim rows with a lease column instead.
