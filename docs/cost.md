# Rough monthly cost (not a bill)

**Nothing in this repository has been deployed.** These numbers are an
estimate built from AWS public on-demand list prices for us-east-1 as I know
them at the time of writing (2026). Prices change; check them in the
[AWS Pricing Calculator](https://calculator.aws/) before relying on them.
Excludes tax, support plans, data transfer out, and free-tier credits.

## Assumptions

- Low, steady traffic: well under 1M orders a month, so SQS, ALB LCUs and
  log volume stay small. 730 hours per month.
- Infrastructure as in `infra/terraform` defaults: 2 API tasks and 1 worker
  task, each 0.25 vCPU / 0.5 GB; API on Graviton (ARM64); worker on Fargate
  Spot (x86_64, because Spot does not run ARM64 tasks).
- Default VPC, public subnets, no NAT gateway (tasks get public IPv4
  addresses).
- 4 CloudWatch alarms, ~2 GB of logs, Container Insights on.

## Baseline: Aurora Serverless v2, min 0.5 ACU

| Item | Basis | $/month |
|---|---|---:|
| API tasks, Fargate ARM64 | 2 × (0.25 vCPU × $0.03238 + 0.5 GB × $0.00356) × 730 h | 14.42 |
| Worker task, Fargate Spot x86 | 1 × $9.01 on-demand, assuming ~70% Spot discount | ~2.70 |
| Application Load Balancer | $0.0225/h + ~1 LCU × $0.008/h | 22.27 |
| Public IPv4 addresses | 5 (3 tasks + 2 ALB nodes) × $0.005/h | 18.25 |
| Aurora Serverless v2 | 0.5 ACU × $0.12/ACU-h × 730 h | 43.80 |
| Aurora storage and I/O | ~1 GB × $0.10, light I/O | ~0.50 |
| SQS | Long polling (20 s) keeps empty receives ~0.5M/worker task; inside the 1M free requests | 0.00 |
| Secrets Manager | 5 app secrets + 1 RDS-managed master secret × $0.40 | 2.40 |
| CloudWatch logs + alarms | ~2 GB × $0.50 + 4 alarms × $0.10 | 1.40 |
| Container Insights | Rough; depends on task and metric count | ~3.00 |
| **Total** | | **~109** |

## Levers, largest first

| Lever | Effect | Trade-off |
|---|---|---|
| `database_mode = "rds-instance"` (db.t4g.micro, 20 GB gp3) | 43.80 → ~14.00 | Fixed capacity; no scale-to-zero; a burstable instance can run out of CPU credits under sustained load |
| `aurora_min_acu = 0` (auto-pause) | 43.80 → pay only for active hours (e.g. 8 h × 22 days ≈ $10.60) | First request after a pause waits for resume (seconds); unsuitable for a latency SLO |
| `api_desired_count = 1` | −7.21 compute, −3.65 IPv4 | One AZ for the API; a task replacement is an outage |
| `worker_on_spot = true` (default) | 9.01 → ~2.70 | Interruptions: in-flight messages reappear after the visibility timeout and are deduped, so this is safe by design |
| ARM64 for on-demand tasks (default) | ~20% off x86 Fargate | Multi-arch image builds |
| Turn off Container Insights | −~3 | Lose per-task CPU/memory metrics |
| Private subnets + VPC endpoints instead of public IPs | Usually **more** at this size: 5 interface endpoints × 2 AZ × ~$7.30 ≈ $73 vs ~$18 of IPv4 | Endpoints win once there are many tasks or NAT would otherwise be needed |
| NAT gateway instead of public IPs | **Adds** ~$33/AZ + $0.045/GB | Standard private-subnet pattern; worth it for compliance, not for cost |

**Cheapest sensible configuration** (RDS t4g.micro, 1 API task, Spot
worker, Container Insights off): roughly **$65/month**, dominated by the ALB
and IPv4 addresses. Below that, the next step is replacing the ALB with API
Gateway HTTP API + VPC Link, or moving the API to Lambda, which changes the
architecture rather than its settings.

## What drives cost as traffic grows

- **SQS** is $0.40 per million requests after the free tier; each order is
  about 3 requests (send, receive, delete). 10M orders ≈ $12.
- **Aurora ACUs** track write load. The outbox and dedupe rows double the
  writes per order compared with a bare insert; partition or prune them
  (see README).
- **Fargate** scales with worker count; scale workers on queue age, not CPU.
