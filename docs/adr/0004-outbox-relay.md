# ADR 0004: A polling outbox relay inside the API process

- Status: accepted
- Date: 2026-11-11

## Context

ADR 0002 puts every `order.created` event in an outbox row committed with the
order. Something has to move those rows to SQS: reliably, without sending a
row twice in the normal case, in every API replica, and without one bad row
holding up the rest. It also has to be visible when it stops working: the
SQS alarms only see events that reached SQS.

## Decision

- **Poll from the API process.** Each API task runs one relay loop on its own
  small pool (2 connections) as `app_relay`, a role that can read and mark
  outbox rows and cannot see orders. It sleeps 200 ms when idle and loops
  without sleeping while full batches keep coming.
- **Claim with `FOR UPDATE SKIP LOCKED`.** One transaction per batch:
  select up to 50 unpublished rows, send them in `SendMessageBatch` calls of
  10, set `published_at` on the ones SQS accepted, increment
  `publish_attempts` on the rest, commit. Concurrent relays skip each
  other's locked rows, so every replica can run one (tested with four relays
  draining the same backlog: each row sent once).
- **Order by `publish_attempts, id`.** Rows that keep failing sink below new
  ones instead of blocking them. The partial index
  `(publish_attempts, id) WHERE published_at IS NULL` serves that order
  directly; without it each claim sorted the whole backlog (measured: 125 ms
  per claim at 100,000 waiting rows, 0.2 ms with the index).
- **Report the backlog.** Every 15 s each relay logs
  `outbox_unpublished` and `outbox_oldest_age_seconds`. In AWS a CloudWatch
  log metric filter turns the age into a metric with an alarm; no report for
  three minutes also alarms, because that means no relay is running.

## What this does not guarantee

- **Ordering.** Rows leave in `id` order within one relay, but `id` is
  assigned at insert, not commit, and several relays interleave. SQS
  standard queues reorder anyway. Consumers must not depend on order; if a
  future event type needs per-order ordering, use a FIFO queue with
  `MessageGroupId = order_id` (ADR 0002).
- **At-most-once sending.** A crash after `SendMessageBatch` and before
  `COMMIT` sends the batch again. The worker's dedupe table absorbs it.
- **A cap on retries.** A row that SQS always rejects is retried forever,
  counted in `publish_attempts` and kept out of the way by the ordering. The
  backlog alarm fires on it. There is no outbox dead-letter state.

## Alternatives considered

- **CDC (Debezium, logical replication).** No polling, lower latency, but
  another stateful system to run and monitor. Worth it past a few thousand
  events per second or when several services need the same change stream.
- **A separate relay service.** Independent scaling and deploys, one more
  deployable. With `SKIP LOCKED` the in-process relay scales with API
  replicas, which is enough here.
- **`LISTEN/NOTIFY` to wake the relay.** Cuts idle latency below the 200 ms
  poll, but notifications are lost while a listener is disconnected, so the
  poll stays as the fallback. Not worth the extra moving part at this scale.
- **Lease column instead of a held transaction.** The relay keeps its
  transaction open across the SQS call. That is fine for batches of tens;
  a lease (`claimed_until`) frees the row locks and the connection, at the
  cost of a second write per row.

## Consequences

- One fewer service to deploy and monitor.
- Relay load scales with API replicas: each idle relay runs one cheap
  indexed query every 200 ms.
- Published rows are never deleted. Pruning (delete rows published more
  than a few days ago) is not implemented and is listed in the README.
