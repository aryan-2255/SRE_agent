# NightShift — shared contracts

Every workstream (A, B, C, D) reads this file first. It fixes the names, ports, schemas and interfaces so four people can build in parallel without talking. If you need to change a contract, change it here first and tell the others.

Architecture page (the picture of all of this): https://claude.ai/artifact/DZTegNgebksC8Lov1zRkZU

## 1. What we are building

An on-call team of AI agents that runs on **TrueForge**. It watches a live system, detects a real incident without AI, then runs a pipeline of TrueForge agents that diagnose, prove the bug in a sandbox, ask a human on Jira, mitigate, fix, test, open a PR, canary-deploy and write a postmortem.

Hackathon hard requirements, shown live in every run:
1. **Reaches a real system**: the Astronomy Shop (31 Docker containers), GitHub, Jira.
2. **Runs generated code in a sandbox**: TrueForge's Daytona sandbox clones the fork and runs a test the agent wrote.
3. **Pauses before irreversible actions**: TrueForge tool approval, answered from Jira (`/approve`) or the dashboard.

Rules that bind us: the agent must run on TrueForge (unmodified, `npx`), public GitHub repo with a working README, AI tools disclosed in the README, only our own accounts, **no secrets in the repo or video**.

## 2. Two repos, one parent folder

```
truforge_hackthon/
├── astronomy-shop/     the target system. Fork: github.com/aryan-2255/opentelemetry-demo
│                       Already running. ./shop.sh start|stop|status|logs X|rebuild X|public
└── nightshift/         OUR PROJECT. New public repo: github.com/aryan-2255/nightshift
```

## 3. Where each piece runs (local laptop, Docker Desktop, 8 GB)

| Piece | Runs as | Address | Owner |
|---|---|---|---|
| Astronomy Shop (31 containers) | Docker, project `astronomy-shop`, network `opentelemetry-demo` | shop `localhost:8080`, Prometheus `localhost:9090` | exists |
| TrueForge 0.2.1 | host process (`npx`) | `http://localhost:8790` | C |
| `control` = watcher + orchestrator + dashboard API/UI | host process (Python, FastAPI) | `http://localhost:8090` | B (backend), D (UI) |
| `ops-mcp` | container on `opentelemetry-demo` | `http://localhost:8000/mcp` | A |
| `knowledge-mcp` | container | `http://localhost:8001/mcp` | C |
| `codegraph-mcp` | container | `http://localhost:8002/mcp` | C |
| `payment-lb` (nginx gRPC 90/10 split for canary) | container | internal `payment-lb:50051` | A |
| redis (queue + cache) | container | `localhost:6380` | B |
| postgres (incident state) | container | `localhost:5433` | B |
| qdrant | container | `localhost:6333` | C |
| neo4j (cap 512M heap) | container | `localhost:7474`, `7687` | C |
| airflow standalone (last, optional if RAM is short) | container | `localhost:8081` | C |
| public-gate + Cloudflare tunnel | exists in astronomy-shop | `./shop.sh public` | exists |

Why `control` runs on the host: TrueForge local mode listens on localhost only, and host processes reach both TrueForge and the published container ports without extra networking.

All NightShift containers live in `nightshift/compose.yaml`, join the external network `opentelemetry-demo`, and publish ports on `127.0.0.1` only.

**TrueForge must be started with** (it blocks localhost MCP URLs otherwise):
```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' SQLITE_PATH=$PWD/.data/trueforge.sqlite npx @truefoundry/trueforge@0.2.1 --port 8790
```

## 4. Repo layout (`nightshift/`)

```
nightshift/
├── README.md                     D  setup, architecture link, AI tools used, credits
├── .env.example                  B  every variable, no values. .env is gitignored
├── compose.yaml                  A  (ops-mcp, payment-lb) + B (redis, postgres) + C (qdrant, neo4j, knowledge, codegraph, airflow)
├── Makefile                      D  up / down / trueforge / setup / demo / evals
├── scripts/
│   ├── start-trueforge.sh        C
│   └── setup_trueforge.py        C  registers MCP servers, skills and all agents via the SDK (idempotent)
├── systems/astronomy-shop.yaml   B  onboarding file (section 7)
├── mcp/ops/                      A  ops MCP server (section 5)
├── mcp/knowledge/                C
├── mcp/codegraph/                C
├── agents/*.json                 C  one TrueForge agent spec per file (section 6)
├── skills/                       C  SKILL.md packs (runbooks, sandbox toolchains, postmortems)
├── knowledge/docs/               C  postmortems/runbooks that get indexed
├── pipelines/airflow/dags/       C
├── control/                      B  watcher, orchestrator, jira bridge, state, API + SSE
│   └── web/                      D  dashboard UI (static, served by control)
├── chaos/                        D  break.sh / fix.sh / prebuild.sh
├── evals/                        D
└── docs/                         D  screenshots for README
```

## 5. ops-mcp tools (contract between A and C)

FastMCP, streamable HTTP at `/mcp`, every request needs `Authorization: Bearer $OPS_MCP_TOKEN`. All outputs are plain text or JSON strings, **always redacted** (emails, card numbers, CVV, tokens, secrets from env).

| Tool | Args | Returns | Annotation |
|---|---|---|---|
| `list_services` | – | services, image tag, running commit, health | read-only |
| `get_error_rates` | `window="2m"` | per service: rps, error %, p95 ms | read-only |
| `get_metrics` | `promql`, `minutes=15` | series summary | read-only |
| `query_logs` | `service`, `minutes=15`, `contains=""`, `level=""`, `limit=50` | log lines (time, level, message, trace_id) | read-only |
| `get_traces` | `service`, `minutes=15`, `errors_only=true`, `limit=5` | trace summaries: id, root op, failing step, duration | read-only |
| `get_trace` | `trace_id` | ordered steps (service, operation, ms, error, key attributes) | read-only |
| `get_recent_deploys` | `service=""` | deploy history: time, service, commit, who | read-only |
| `get_flags` | – | current flagd flag values | read-only |
| `run_sql_readonly` | `sql` | rows (astronomy-db, read-only user, 100-row cap) | read-only |
| `rollback` | `service`, `to_commit=""` (default: previous good) | new state | **destructive** |
| `deploy` | `service`, `commit="origin/main"` | builds `nightshift/<svc>:<sha>`, swaps it in | **destructive** |
| `deploy_canary` | `service`, `commit`, `percent=10` | starts `<svc>-canary`, sets payment-lb weights | **destructive** |
| `promote_canary` | `service` | canary becomes main, canary removed | **destructive** |
| `abort_canary` | `service` | canary removed, weights 100/0 | read-only=false, not destructive |
| `restart_service` | `service` | | **destructive** |
| `scale_service` | `service`, `replicas` | | **destructive** |
| `set_flag` | `flag`, `variant` | old → new | **destructive** |
| `notify` | `channel="slack"`, `text` | ok | write (gated by name) |
| `synthetic_check` | `flow="add_to_cart"|"checkout"` | pass/fail with detail (drives the real shop like a user) | read-only |

Destructive tools set `destructiveHint=True`. **Agents still list them by name** in `require_approval_for_tools` (never rely on annotations alone).

Image tagging (makes rollback instant): every deploy builds/tags `nightshift/<service>:<shortsha>`, retags it as the compose image (`ghcr.io/open-telemetry/demo:latest-<service>`) and runs `docker compose ... up -d --no-deps <service>`. History in `astronomy-shop/.nightshift/deploys.json`.

## 6. TrueForge agents (contract between C and B)

Saved agents in TrueForge. B calls them by name. Every agent returns **JSON matching its schema** (`response_format: json_schema`), always including `summary` (one sentence for the dashboard) and `confidence` (0–1).

| name | model | sandbox | MCP tools | require approval | output (main fields) |
|---|---|---|---|---|---|
| `ns-triage` | `openai/gpt-5.4-mini` | no | ops: get_error_rates, get_metrics, list_services, get_flags | – | `real_incident, severity(P1-P4), service, category(code|config|flag|capacity|external|unknown), route` |
| `ns-diagnosis` | `openai/gpt-5.5`, subagents on | no | ops read tools, github (read), knowledge.search_incidents, knowledge.search_docs, codegraph.* | – | `root_cause, evidence[] (each with source + link), suspect_commit, suspect_files[], confidence` |
| `ns-validator` | different model from diagnosis if a 2nd provider key exists | **yes** | github (read) | – | `reproduced(bool), test_file, test_code, run_output, disproved_reason` |
| `ns-planner` | `openai/gpt-5.5` | no | codegraph.blast_radius, knowledge.search_incidents | – | `options[] (action, risk, blast_radius, reversible)`, `chosen`, `mitigation{tool,args}`, `fix_needed(bool)` |
| `ns-mitigator` | `openai/gpt-5.4-mini` | no | ops: rollback, restart_service, scale_service, set_flag, get_error_rates, synthetic_check | rollback, restart_service, scale_service, set_flag | `action_taken, args, result` |
| `ns-verifier` | `openai/gpt-5.4-mini` | no | ops: get_error_rates, synthetic_check, get_traces | – | `recovered(bool), before, after` |
| `ns-coder` (Toolsmith) | `openai/gpt-5.5` | **yes** | github (read) | – | `branch_plan, patch(unified diff), files[], new_tool(optional)` |
| `ns-tester` | `openai/gpt-5.4-mini` | **yes** | github (read) | – | `passed(bool), output, failing_tests[]` |
| `ns-pr` | `openai/gpt-5.4-mini` | no | github: create_branch, push_files, create_pull_request | create_pull_request, push_files, create_or_update_file | `pr_url, pr_number` |
| `ns-reviewer` | `openai/gpt-5.5` | no | github: get PR, create review | – | `verdict(approve|changes), comments[]` |
| `ns-cicd` | `openai/gpt-5.4-mini` | no | github: get CI status, merge_pull_request; ops: deploy_canary, promote_canary, abort_canary, get_error_rates | merge_pull_request, deploy_canary, promote_canary | `ci_passed, canary_ok, promoted` |
| `ns-postmortem` | `openai/gpt-5.4-mini` | no | ops.notify, knowledge.save_postmortem (Jira is written by the orchestrator) | notify | `postmortem_md, timeline[]` |
| `ns-docs` (Docs Researcher) | `openai/gpt-5.4-mini` | no | exa (web search), knowledge.save_docs | – | `provider, version, sources[], saved(bool)` |

Model names must exist in TrueForge's catalog under the configured provider; C confirms the exact ids after connecting OpenAI and updates this table.

## 7. Onboarding file (`systems/astronomy-shop.yaml`) — the "universal" part

```yaml
name: astronomy-shop
domain: e-commerce
repo: { url: https://github.com/aryan-2255/opentelemetry-demo, branch: main, local_path: ../astronomy-shop }
runtime: { type: docker-compose, project: astronomy-shop, command: ./shop.sh }
telemetry:   # URLs as seen from inside the opentelemetry-demo network (ops-mcp). control uses localhost:9090 for Prometheus.
  metrics: { type: prometheus, url: http://prometheus:9090, error_metric: traces_span_metrics_calls_total }
  logs:    { type: opensearch, url: http://opensearch:9200, index: "otel-logs-*", service_field: resource.service.name.keyword }
  traces:  { type: jaeger, url: http://frontend-proxy:8080/jaeger/ui/api/v3 }
flags: { type: flagd, file: ../astronomy-shop/src/flagd/demo.flagd.json }
services:
  payment:        { language: javascript, path: src/payment,        test_cmd: "npm ci && node --test", slo: { max_error_pct: 5,  p95_ms: 800 } }
  frontend:       { language: typescript, path: src/frontend,       test_cmd: "npm ci && npm test",   slo: { max_error_pct: 5,  p95_ms: 1500 } }
  recommendation: { language: python,     path: src/recommendation, test_cmd: "pip install -r requirements.txt && pytest", slo: { max_error_pct: 5 } }
  agent:          { language: python,     path: src/agent,          slo: { max_error_pct: 35 } }   # baseline ~17% errors
  checkout:       { language: go,         path: src/checkout,       slo: { max_error_pct: 5 } }   # config/flag fixes only
  cart:           { language: csharp,     path: src/cart,           slo: { max_error_pct: 5 } }
watch: { window: 2m, for: 2m, demo_for: 30s, min_rps: 0.2, poll_seconds: 5 }
autonomy:
  auto:  []                                   # demo: everything asks. Night mode: [rollback, restart_service]
  ask:   [rollback, restart_service, scale_service, set_flag, merge_pull_request, deploy_canary, promote_canary, create_pull_request]
  never: [drop_table, delete_data, read_secret]
  quiet_hours: "22:00-09:00"
tickets: { type: jira, project: SRE }
notify:  { type: slack }
```

## 8. Incident state (Postgres, owned by B)

```
incidents(id text pk 'INC-001', system, service, severity, category, status, stage,
          opened_at, resolved_at, jira_key, pr_url, total_cost_usd, fingerprint, summary)
stages(id, incident_id, name, status(pending|running|waiting_approval|done|failed|skipped),
       trueforge_session_id, started_at, ended_at, cost_usd, attempt, output jsonb)
approvals(id, incident_id, stage, tool, args jsonb, thread_id, tool_call_id,
          session_id, status(pending|approved|denied), decided_by, decided_via(jira|dashboard), reason)
events(id, incident_id, ts, stage, kind, text, data jsonb)   -- everything the dashboard shows
```

## 9. Dashboard API (contract between B and D)

Served by `control` on `:8090`.

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/incidents` | list, newest first |
| GET | `/api/incidents/{id}` | incident + stages + approvals |
| GET | `/api/stream` | **SSE**. Each message: `{incident_id, ts, stage, kind, text, data}`. kinds: `incident.opened, stage.started, stage.done, stage.failed, tool.call, tool.result, evidence, approval.requested, approval.decided, cost, incident.resolved, watcher.tick` |
| POST | `/api/approvals/{id}` | `{decision: "approve"|"deny", reason?}` |
| GET | `/api/watch` | current error rate / p95 / rps per service (for the live tiles) |
| GET | `/api/connections` | status of TrueForge, each MCP, GitHub, Jira, Slack, Prometheus |
| POST | `/api/demo/{scenario}` | runs `chaos/break.sh <scenario>` (demo only) |

`evidence` events must carry the **real** lines: `{source: "opensearch"|"jaeger"|"github"|"prometheus", items: [...], link: "http://localhost:8080/jaeger/ui/trace/<id>"}`. The dashboard shows them verbatim. This is how judges see that the agent read the logs.

## 10. Environment variables (`nightshift/.env`, gitignored)

```
TRUEFORGE_BASE_URL=http://localhost:8790
OPS_MCP_TOKEN=          KNOWLEDGE_MCP_TOKEN=     CODEGRAPH_MCP_TOKEN=
OPENAI_API_KEY=         # embeddings for knowledge (TrueForge holds its own copy for agents)
JIRA_BASE_URL=          JIRA_EMAIL=              JIRA_API_TOKEN=     JIRA_PROJECT=SRE
SLACK_WEBHOOK_URL=
GITHUB_REPO=aryan-2255/opentelemetry-demo
DATABASE_URL=postgresql://nightshift:nightshift@localhost:5433/nightshift
REDIS_URL=redis://localhost:6380/0
SHOP_PATH=/Users/aryanchoudhary/Documents/truforge_hackthon/astronomy-shop
DEMO_MODE=true
```
Model keys, GitHub token and Jira OAuth live **only inside TrueForge** (Settings), never in this file.

## 11. Git rules for everyone

- Commit small and often, message says what changed. Push to `main` of `aryan-2255/nightshift` only after the plan owner (you) says the repo is public-ready.
- Never commit `.env`, tokens, `*.sqlite`, `MY-ORDERS.html`, screenshots with keys.
- Each workstream owns its folders (table in section 4). Touching another folder: tell its owner.
- README must list AI tools used: Claude Code (4 accounts), plus anything else.
