# Workstream A — ops MCP server, deploys, canary

Paste everything below the line into Claude account **A**, started in `truforge_hackthon/nightshift/`.

---

You are building **workstream A of NightShift**, an on-call AI agent team for the TrueFoundry × Polaris "Agents That Act" hackathon. First read `../plan/00-CONTRACTS.md` completely. It is the source of truth for names, ports and interfaces. Do not change a contract without updating that file.

## Your job

Build the **ops MCP server**: the only door through which the AI agents read and change the running system. Also build the deploy, rollback and canary machinery for Docker Compose.

The target system is `../astronomy-shop` (OpenTelemetry Astronomy Shop, 31 containers, Docker Compose project `astronomy-shop`, network `opentelemetry-demo`). It is already running. Read `../astronomy-shop/shop.sh` and `../astronomy-shop/SHOP-MAP.html` to understand it. Do not modify shop source code under `src/`.

## Deliverables

1. `mcp/ops/` — Python 3.12, `mcp` package (FastMCP), streamable HTTP on port 8000 at `/mcp`, Dockerfile.
   - Bearer-token middleware: reject any request without `Authorization: Bearer $OPS_MCP_TOKEN`.
   - Every tool in section 5 of the contracts, with exactly those names and args.
   - Adapters behind the tools, chosen by `systems/astronomy-shop.yaml`: `PrometheusMetrics`, `OpenSearchLogs`, `JaegerTraces`, `DockerComposeRuntime`, `FlagdFlags`. Put each in its own module behind a small interface (`MetricsAdapter.error_rates(window)`, `LogsAdapter.query(service, minutes, contains, level, limit)`, `RuntimeAdapter.deploy/rollback/restart/scale`, etc.) so a Vercel/Render/CloudWatch adapter could be added later without touching tools.
   - **Redaction** on every output: emails, 12–19 digit card numbers, CVV-like fields, bearer tokens, and the literal values of any env var whose name contains KEY/TOKEN/SECRET/PASSWORD.
   - Annotations: read tools `readOnlyHint=True`; `rollback, deploy, deploy_canary, promote_canary, restart_service, scale_service, set_flag` get `destructiveHint=True`.

2. Facts already verified (use them, don't rediscover):
   - Error rate: `sum by (service_name, status_code) (rate(traces_span_metrics_calls_total[2m]))`; status codes `STATUS_CODE_ERROR | STATUS_CODE_UNSET | STATUS_CODE_OK`. p95 from `traces_span_metrics_duration_milliseconds_bucket`. Prometheus inside the network: `http://prometheus:9090`.
   - Logs: OpenSearch `http://opensearch:9200`, index `otel-logs-*`, service field `resource.service.name.keyword` (the text field can't be aggregated). Inspect one document first to find the timestamp, severity, body and trace id field names.
   - Traces: Jaeger v3 API through the proxy: `http://frontend-proxy:8080/jaeger/ui/api/v3/traces?query.service_name=X&query.start_time_min=<RFC3339>&query.start_time_max=<RFC3339>&query.search_depth=N`, and `/traces/{trace_id}`. Response is OTLP JSON (`result.resourceSpans[].scopeSpans[].spans[]`, service name in resource attribute `service.name`, error = `status.code == STATUS_CODE_ERROR`).
   - Load-generator traffic carries baggage `synthetic_request=true`; real users' payment spans have `demo.payment.charged=true`. Expose a `real_users_only` option on `get_traces`.
   - Flags: `../astronomy-shop/src/flagd/demo.flagd.json`; flagd reloads the file on change. `set_flag` edits `defaultVariant` of one flag, keeps a backup, and returns old → new.
   - Rebuild works: `./shop.sh rebuild payment` took 40 s.

3. Deploy / rollback (Docker Compose runtime):
   - The container needs the docker CLI + compose plugin, `/var/run/docker.sock`, and the shop folder **mounted at the identical absolute path** (`$SHOP_PATH:$SHOP_PATH`). Compose resolves relative bind mounts on the host, so a different path silently breaks them.
   - Use the same compose invocation as `shop.sh` (5 files, `--env-file .env --env-file .env.override`, project `astronomy-shop`).
   - `deploy(service, commit)`: keep the shop repo on `main`: `git pull --ff-only`, build, tag `nightshift/<svc>:<sha>`, retag as the compose image, `up -d --no-deps <svc>`, append to `.nightshift/deploys.json`, then wait for health.
   - `rollback(service, to_commit)`: retag the previous good `nightshift/<svc>:<sha>` (or the original upstream image, saved as `nightshift/<svc>:baseline` on first run) and `up -d --no-deps`. Must take under 10 s. No rebuild.
   - Refuse to deploy if the shop repo has uncommitted changes; return a clear error.

4. Canary (real 10% traffic split in Docker):
   - Add `payment-lb`: nginx with `grpc_pass` to an upstream `{ server payment:50051 weight=100; server payment-canary:50051 weight=0; }` (nginx balances per gRPC request). Point checkout at it by adding `PAYMENT_ADDR=payment-lb:50051` to `../astronomy-shop/.env.override` and recreating `checkout`. Verify orders still succeed.
   - `deploy_canary`: run `payment-canary` from the new image on the same network with the same env, set weights 90/10, `nginx -s reload`.
   - `promote_canary`: deploy that image as `payment`, weights 100/0, remove canary. `abort_canary`: weights 100/0, remove canary.
   - Implement for `payment` only; make the service name a parameter so others can follow.

5. `synthetic_check(flow)`: drive the real shop over HTTP like a user (`http://frontend-proxy:8080`): add a product to the cart with quantity 5, read the cart back, assert it holds 5; for `checkout` also place an order with a test card. Return pass/fail with the failing step and HTTP status. Do not send the synthetic baggage (it must look like a real user).

6. `notify(channel, text)`: Slack incoming webhook (`SLACK_WEBHOOK_URL`). If unset, log and return "slack not configured" without failing.

7. `run_sql_readonly`: create a read-only Postgres role on `astronomy-db` at startup if missing (connection details are in the shop's `.env`), enforce `SELECT`-only and a 100-row limit.

8. Add `ops-mcp` and `payment-lb` to `nightshift/compose.yaml` (external network `opentelemetry-demo`, ports on `127.0.0.1` only).

## Done when

- `curl` with the token lists all tools; without it gets 401.
- `get_error_rates` returns every shop service; `query_logs(service="payment")` and `get_traces(service="checkout")` return real, redacted data.
- `rollback` and `deploy` round-trip `payment` and orders keep succeeding (check with `synthetic_check`).
- Canary: with 90/10 weights, about 10% of payment spans come from `payment-canary` (check Jaeger or container logs).
- A README section in `mcp/ops/README.md`: tools table, how to run, how to add an adapter.

Commit small and often. Never commit `.env` or tokens.
