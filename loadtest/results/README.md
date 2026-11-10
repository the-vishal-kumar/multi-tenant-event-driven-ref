# Load test results (local, measured)

Measured on 2026-11-10 with [`loadtest/run.sh`](../run.sh) and
[`loadtest/orders.js`](../orders.js) (k6 0.57.0). Each rate ran for 60 s
against a freshly created stack (`docker compose down -v` before each run).
Raw k6 output (`*.txt`), the k6 summary export (`*.json`), the
create-to-confirmed lag (`*.lag.json`) and one `docker stats` sample taken
mid-run (`*.docker-stats.txt`) are in this directory.

## Machine and caveats

- One laptop: Intel Core i7-8550U (4 cores / 8 threads, 1.8 GHz base),
  ~11 GB RAM, Ubuntu 26.04, Docker 29.9.3. k6, Postgres, LocalStack, Jaeger,
  the API and the worker all share those cores, so the load generator
  competes with the system under test.
- **LocalStack is not SQS.** It is a single Python process emulating the
  API; at the higher rates it was the busiest container. Real SQS latency and
  throughput are different (network round trips are slower, capacity is far
  higher).
- One API container (one Node.js process, which also runs the outbox relay),
  one worker container with 4 consumer loops, untuned Postgres 17 defaults,
  tracing on with every span exported to Jaeger, request logging on.
- Request mix: 70% new orders, 10% retries of the VU's previous request
  (idempotent replay), 20% reads. Open model (constant arrival rate).
- These numbers describe this setup on this laptop. They are not a capacity
  claim for AWS and not numbers from any production system.

## Results

"Lag" is create → confirmed, measured in Postgres as
`processed_at - created_at` for every order the run created: outbox relay
poll (200 ms when idle) + SQS + worker. It was read 10 s after k6 finished.

| Target req/s | Achieved req/s | Dropped iterations | HTTP errors | Create p50 | Create p95 | Create p99 | Orders confirmed / pending at read | Lag p50 | Lag p95 | Lag p99 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 100 | 0 | 0% | 3.4 ms | 4.7 ms | 7.7 ms | 4,260 / 0 | 148 ms | 219 ms | 237 ms |
| 300 | 300 | 0 | 0% | 4.3 ms | 14.5 ms | 88.2 ms | 12,710 / 0 | 233 ms | 338 ms | 475 ms |
| 450 | 450 | 6 | 0% | 9.0 ms | 151 ms | 454 ms | 18,944 / 0 | 10.3 s | 14.9 s | 15.3 s |
| 600 | 543 | 2,589 | 0% | 2,107 ms | 2,207 ms | 2,499 ms | 18,586 / 5,195 | 7.1 s* | 15.4 s* | 16.3 s* |

\* Of the orders confirmed by the time of reading; 5,195 were still queued.

## Reading it

- Up to **300 req/s** (~210 new orders/s) the whole pipeline keeps up: HTTP
  p95 under 15 ms and every order confirmed within half a second, most of
  it the relay's 200 ms idle poll.
- At **450 req/s** the HTTP side still answers (p95 151 ms) but the
  asynchronous side falls behind: orders queue up and lag grows to ~15 s,
  then drains after the burst. The API stays fast because the outbox
  decouples it from the queue, which is the point of the design, and a
  queue-age alarm is what would catch this in production.
- At **600 req/s** the API saturates at ~540 req/s and k6 drops iterations.
- In the `docker stats` samples at 450 and 600 req/s, the API (one Node.js
  process), Postgres and LocalStack were each at roughly one full core, and
  the Go worker at ~30%. My reading, not separately profiled: the event path
  is limited by the single relay loop and LocalStack, not by the worker.
  Next steps would be several API replicas (the relay is safe to run in each)
  and a profile before tuning anything.
