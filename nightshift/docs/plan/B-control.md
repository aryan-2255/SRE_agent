# Workstream B — control: watcher, orchestrator, Jira approval bridge, state, API

Paste everything below the line into Claude account **B**, started in `truforge_hackthon/nightshift/`.

---

You are building **workstream B of NightShift**, an on-call AI agent team for the TrueFoundry × Polaris "Agents That Act" hackathon. First read `../plan/00-CONTRACTS.md` completely. It is the source of truth for names, ports, schemas and interfaces.

## Your job

Build `control/`: one Python 3.12 FastAPI process on the host at `:8090`. It contains four parts:

1. **Watcher**: no AI, runs all the time, decides when there is a real incident.
2. **Orchestrator**: runs the agent pipeline by calling TrueForge agents one stage at a time.
3. **Approval bridge**: turns TrueForge approval pauses into Jira comments and dashboard buttons, and sends the human's decision back.
4. **State + API + SSE** that the dashboard (workstream D) reads.

Also add `redis` and `postgres` to `nightshift/compose.yaml`, write `systems/astronomy-shop.yaml` (copy from contracts section 7) and `.env.example`.

## 1. Watcher

- Every `poll_seconds` (5), query Prometheus at `http://localhost:9090` for each service's error % and p95 over `window` (2m):
  `sum by (service_name, status_code) (rate(traces_span_metrics_calls_total[2m]))`.
- An incident opens when a service is above its `slo.max_error_pct` (or `p95_ms`) **and** above `min_rps`, continuously for `for` (2m, or `demo_for` 30s when `DEMO_MODE=true`).
- Baselines differ: the shop's AI `agent` service normally errors ~17%. Only watch services listed in the onboarding file and use their thresholds.
- Dedupe with a fingerprint `system:service:category-guess`. The same fingerprint cannot open a new incident for 10 minutes. Push incidents to a Redis Stream `ns:incidents`; the orchestrator consumes one incident per service at a time.
- Also run the synthetic user every 30 s by calling ops-mcp `synthetic_check` over MCP (use the `mcp` Python client with the bearer token). Two consecutive failures open an incident even if error rates look fine (catches "success with the wrong result" bugs).
- Emit `watcher.tick` SSE events with the numbers so the dashboard tiles are live.

## 2. Orchestrator

Use the TrueForge Python SDK (`pip install trueforge-sdk`, `from trueforge_sdk import TrueForge`, base URL `http://localhost:8790`, `timeout=600`).

Pipeline, one TrueForge **session per stage**, each stage calling a saved agent by name (contracts section 6):

```
triage → (not real? close as false alarm)
       → diagnosis → validator ─(disproved, attempt<2)→ diagnosis
                              ─(can't reproduce, attempt=2)→ escalate
       → planner (opens Jira ticket via orchestrator, see §3)
       → mitigator → verifier ─(not recovered, option<3)→ mitigator (next option)
       → if planner.fix_needed: coder → tester ─(fail, attempt<3)→ coder
                                 → pr → reviewer → cicd (merge, canary, promote)
       → postmortem → resolved
```
- Route by triage `category`: `code` runs the full path; `config|flag|capacity` skip coder..cicd; `external|unknown` escalate after diagnosis with no changes.
- Each stage's input is a JSON message: `{incident, system (onboarding file), previous_outputs, attempt, question}`. Pass only what the stage needs.
- Stream events with `client.sessions.create_turn_stream(...)`. Keep the id-keyed event index and merge deltas (`from trueforge_sdk.events import is_event_delta, merge_event_delta`). Forward to SSE: `tool.call` (tool name + args), `tool.response` (shortened), `thread.created` (subagents), and the final output.
- **Evidence**: when a `tool.response` comes from `query_logs`, `get_traces`, `get_trace`, `get_metrics` or GitHub commit reads, emit an `evidence` event with the real lines and a link (`http://localhost:8080/jaeger/ui/trace/<id>`, GitHub commit URL). Judges will read these.
- **Approvals**: when the stream contains `tool.approval_required`, look up each pending call's tool name and arguments via `source_event_id` in the event index, write an `approvals` row, emit `approval.requested`, post a Jira comment (§3), and wait. On decision, resume with `create_turn_stream(session_id, input=[{"type":"user.tool_approval","thread_id":..., "tool_call_id":..., "approval":{"status":"allow"} or {"status":"deny","reason":...}}])`. A turn's input cannot mix a user message with approvals.
- Read cost from `turn.done.state.metrics.total_cost_in_usd`; sum per stage and per incident; emit `cost`.
- Budget cap per incident (env `INCIDENT_BUDGET_USD`, default 2.0) and `iteration_limit` per agent: exceeding either escalates.
- Structured output: each agent's final `model.message` content is JSON. Validate it; if invalid, retry the stage once with the parse error appended.
- Retries: tool/network errors up to 3 with backoff; TrueForge 5xx up to 2. Everything counted and shown.
- Resume after restart: stage status lives in Postgres; on startup continue unfinished incidents from their last finished stage.
- Autonomy: tools in `autonomy.auto` are approved automatically by the orchestrator (still logged as `approval.decided` with `decided_via: policy`). In demo mode `auto` is empty so everything asks.

## 3. Jira approval bridge

- Jira Cloud REST v3 with basic auth (`JIRA_EMAIL` + `JIRA_API_TOKEN`). Create the incident ticket after planner: title `INC-00X · <service> · <summary>`, description with root cause, evidence (links), plan options with blast radius, and "Reply `/approve` or `/deny <reason>`".
- For each pending approval, add a comment: tool, arguments, what it changes, how to undo it.
- Poll the ticket's comments every 5 s. A comment starting with `/approve` or `/deny` from anyone resolves the oldest pending approval of that incident. Reply with a comment confirming the action.
- The dashboard's `POST /api/approvals/{id}` does the same, so the demo works even if Jira is slow.
- On resolve, transition the ticket to Done (look up the transition id) and add the postmortem.

## 4. State, API, SSE

- Postgres schema exactly as contracts section 8 (use `psycopg` + plain SQL migrations in `control/migrations/`).
- FastAPI routes exactly as contracts section 9. SSE via `sse-starlette`. Serve `control/web/` (built by D) at `/`.
- `GET /api/connections` checks: TrueForge `/healthz`, each MCP server (`initialize`), Prometheus `/-/ready`, Jira `/myself`, Slack configured, GitHub (via TrueForge connector status).
- `POST /api/demo/{scenario}` shells out to `chaos/break.sh <scenario>` (D writes it); only when `DEMO_MODE=true`.

## Done when

- Flip `paymentFailure` to 50% on `http://localhost:8080/feature/`: within ~40 s (demo mode) an incident opens, the pipeline starts, every stage shows up in `GET /api/stream`, approvals appear in Jira and resolve from a `/approve` comment, and after recovery the incident closes with a total cost.
- Stopping `control` mid-incident and starting it again continues from the last finished stage.
- `control/README.md` explains the state machine with the diagram above.

Until C's agents exist, build the loop against a `FakeStageRunner` that returns canned JSON per stage (same interface as the real TrueForge runner), then switch with `STAGE_RUNNER=trueforge`.

Commit small and often. Never commit `.env` or tokens.
