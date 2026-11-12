# ADR 0003: Retry with backoff in the worker, dead-letter with a reason, SQS redrive as backstop

- Status: accepted
- Date: 2026-11-10

## Context

Some messages fail. Transient failures (database failover, throttling)
should be retried without hammering the dependency. Permanent ones
(malformed body, unknown event type, an order that the message's tenant
can't see) should not block the queue or burn retries, and whoever triages
them needs to know why they failed. SQS on its own offers a redrive policy
(`maxReceiveCount`) that moves a message to a DLQ after N receives, but it
retries at a fixed interval (the visibility timeout) and records no reason.

## Decision

- **Classify.** Envelope validation errors are `PermanentError`s and go to
  the DLQ on the first attempt. Everything else is treated as retryable.
- **Back off with the visibility timeout.** On a retryable failure the
  worker calls `ChangeMessageVisibility` with
  `base × 2^(attempt-1)`, capped, with equal jitter (half fixed, half
  random) so a burst of failures doesn't retry in lockstep. Production
  defaults: base 2 s, cap 5 min, 5 attempts (≈ 2+4+8+16 s before the last
  try). The local stack uses base 1 s, 4 attempts so the demo is quick.
- **Dead-letter in the worker.** When `ApproximateReceiveCount` reaches
  `MAX_ATTEMPTS`, the worker sends the message to the DLQ with its original
  attributes plus `failure_reason`, `failed_attempts` and
  `source_message_id`, then deletes it from the main queue.
- **SQS redrive policy as the backstop**, with `maxReceiveCount` (8) above
  `MAX_ATTEMPTS` (5). It only fires if the worker can't dead-letter itself
  (crash loop, OOM on a specific message). Terraform enforces
  `max_receive_count > worker_max_attempts`.
- **Redrive is an explicit operator command** (`worker redrive -max N`), run
  after the cause is fixed. It moves only messages that were already in the
  DLQ when it started; a message that is still poison is dead-lettered again
  while the redrive runs and must not be picked up twice (the first version
  of this command did exactly that and looped until its limit; the test
  `TestRedriveSkipsMessagesDeadLetteredAfterItStarted` pins the fix).
- **Alarms.** DLQ depth > 0 (page: something needs a human), DLQ oldest
  message older than a day (untriaged; the DLQ keeps messages 14 days), and
  main-queue oldest message older than 5 minutes (workers down or behind).

## Alternatives considered

- **SQS redrive policy only.** Simpler, but no reason on the message and no
  backoff: every retry waits the same visibility timeout.
- **In-process retry loop (sleep and retry before acking).** Holds a worker
  slot and the message's visibility while sleeping, and loses the attempt
  count if the process dies.
- **Native DLQ redrive (`StartMessageMoveTask`).** Equivalent for AWS and
  fine to use there; the explicit command works against any SQS-compatible
  endpoint (LocalStack in tests) and lets us strip the failure attributes.

## Consequences

- A poison message costs `MAX_ATTEMPTS` deliveries and about 30 seconds of
  delay with production settings before it is out of the way. Other messages
  keep flowing meanwhile (standard queue, no head-of-line blocking).
- The failure classification is a judgment call. "Order not found in
  tenant" is treated as retryable because in other topologies (a read
  replica, a separately committed order) it can be transient; here it never
  is, so it costs a few wasted retries.
- If the DLQ send succeeds but the delete fails, the message exists in both
  queues. The next delivery is deduped if it would have succeeded, or
  dead-lettered again; the DLQ can then hold a duplicate, which a redrive
  also dedupes.
