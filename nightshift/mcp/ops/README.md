# nightshift-ops MCP server

The only door NightShift's agents use to read and change the running system. It runs as a container on the target system's Docker network and speaks MCP (streamable HTTP) at `http://localhost:8000/mcp`. Every request needs `Authorization: Bearer $OPS_MCP_TOKEN`, and every output is redacted (emails, card numbers, CVVs, tokens and the values of secret environment variables) before a model sees it.

## Tools

| Tool | What it does | Safety |
|---|---|---|
| `list_services` | Every container with state, health and running commit | read |
| `get_error_rates` | Requests/s, error % and p95 per service, with each service's threshold | read |
| `get_metrics` | Any PromQL range query, summarised | read |
| `query_logs` | Recent log lines of one service, filterable by text or level | read |
| `get_traces` | Recent requests through a service, failing step first; `real_users_only` skips bots | read |
| `get_trace` | Every step of one request | read |
| `get_recent_deploys` | Deploy/rollback history and recent commits touching the service | read |
| `get_flags` | Every feature flag and its options | read |
| `run_sql_readonly` | One SELECT with a read-only database role, 100 rows, 5 s | read |
| `synthetic_check` | Uses the live shop like a customer and checks the result is right | read |
| `rollback` | Runs the previous good image (no rebuild, ~10 s) | destructive |
| `deploy` | Pulls merged code, builds, tags the image with the commit, swaps it in | destructive |
| `deploy_canary` | Runs a new version next to the old one with N% of traffic | destructive |
| `promote_canary` | Makes the canary the main version | destructive |
| `abort_canary` | Sends all traffic back to the main version | write |
| `restart_service` / `scale_service` | Restart or run 1–5 copies | destructive |
| `set_flag` | Changes a feature flag, returns how to undo it | destructive |
| `notify` | Posts to Slack | write |

Destructive tools carry `destructiveHint=true`, and every NightShift agent also lists them by name in `require_approval_for_tools`, so TrueForge always pauses for a human first.

## How it works on Docker Compose

- **Images are tagged by commit** (`nightshift/<service>:<sha>`). Rollback is a retag plus a container swap, so it takes seconds. The image the system started with is saved as `nightshift/<service>:baseline`.
- **Canary**: `payment-lb` (nginx) sits between checkout and payment and splits gRPC requests by weight. `deploy_canary` starts `payment-canary` and rewrites the weights; measured on the demo shop, a 70/30 setting sent 14 of 20 checkouts to the main version and 6 to the canary.
- The shop folder is mounted at the **same absolute path** as on the host, because Docker Compose resolves bind mounts on the host.
- Deploy history lives in `<shop>/.nightshift/deploys.json`.

## Adapters (how it stays universal)

The tools call adapters chosen by the onboarding file (`systems/*.yaml`):

| Capability | This system | Module |
|---|---|---|
| Metrics | Prometheus (OpenTelemetry span metrics) | `adapters/metrics_prometheus.py` |
| Logs | OpenSearch | `adapters/logs_opensearch.py` |
| Traces | Jaeger v3 API | `adapters/traces_jaeger.py` |
| Runtime | Docker Compose | `adapters/runtime_compose.py` |
| Flags, SQL, synthetic user, Slack | flagd, Postgres, HTTP, webhook | `adapters/extras.py` |

To support another platform (CloudWatch logs, Vercel deploys, Datadog metrics), add an adapter with the same methods and point the onboarding file at it. The tools and the agents stay the same.

## Run and test

```bash
docker compose up -d --build ops-mcp payment-lb      # from the nightshift folder
python scripts/mcp_call.py                           # list tools
python scripts/mcp_call.py get_error_rates
python scripts/mcp_call.py synthetic_check '{"flow":"checkout"}'
```
