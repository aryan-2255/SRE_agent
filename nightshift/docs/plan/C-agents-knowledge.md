# Workstream C — TrueForge, agents, skills, knowledge, code graph

Paste everything below the line into Claude account **C**, started in `truforge_hackthon/nightshift/`.

---

You are building **workstream C of NightShift**, an on-call AI agent team for the TrueFoundry × Polaris "Agents That Act" hackathon. First read `../plan/00-CONTRACTS.md` completely. It is the source of truth for names, ports, schemas and interfaces.

## Your job

Everything that lives inside or feeds **TrueForge**: running it, registering connectors, the 13 agent specs, skills, the knowledge base (Qdrant + reranker + Airflow) and the code graph (Neo4j). The hackathon requires the agents to run on TrueForge, so this workstream is the core of the judging.

## Verified TrueForge facts (0.2.1, don't rediscover)

- Run: `scripts/start-trueforge.sh` = `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' SQLITE_PATH=$PWD/.data/trueforge.sqlite npx @truefoundry/trueforge@0.2.1 --port 8790`. Without the env var, `localhost` MCP URLs are rejected with "Outbound URL blocked".
- API docs at `http://localhost:8790/api/v1/docs`. Python SDK: `pip install trueforge-sdk`.
- Register an MCP server: `POST /api/v1/settings/mcp-servers` with `{"manifest":{"type":"remote","name":"nightshift-ops","description":"...","url":"http://localhost:8000/mcp","auth":{"type":"header","headers":{"Authorization":"Bearer ..."}}}}`. `PUT` updates.
- Agent spec fields: `model{name,params}`, `instructions`, `mcp_servers[{name, enable_tools, disable_tools, require_approval_for_tools, preload}]`, `skills[{name}]`, `config{sandbox{enabled}, generative_ui, ask_user_questions, dynamic_sub_agents, context_management, iteration_limit}`, `response_format{type:"json_schema", json_schema:{...}}`. Save with `client.agents.create(name=..., description=..., manifest=...)`, update with `agents.update(id, ...)` (name is immutable).
- **Approval gotcha**: only tools annotated destructive pause by default. Unannotated tools (most GitHub tools) run without asking. Always list gated tools **by name** in `require_approval_for_tools`.
- Skills need `config.sandbox.enabled: true`. Skills are git-backed: register with repo URL + path + ref (so push `skills/` to GitHub first).
- Sandbox: Daytona is the official provider (API key needs Sandboxes + Snapshots write). Local fallback exists but only reaches PyPI + GitHub (no npm). Daytona's lower tiers allow npm, PyPI, GitHub, Debian repos. **TrueForge's Daytona image is `python:3.13-slim` with no Node**: install Node with `pip install nodejs-wheel` (gives `node`/`npm`).
- Catalog connectors to use: **GitHub** (header token, fine-grained PAT scoped to `aryan-2255/opentelemetry-demo` only), **Exa** (web search, no auth) for the Docs Researcher. Jira is handled by the orchestrator (B), not by agents.
- Turn metrics give `total_cost_in_usd`; the orchestrator reads it.

## Deliverables

1. `scripts/start-trueforge.sh` and `scripts/setup_trueforge.py` (idempotent: create or update): registers `nightshift-ops`, `nightshift-knowledge`, `nightshift-codegraph` MCP servers with header tokens from `.env`, registers skills, and creates/updates all agents from `agents/*.json`. Model provider keys and the GitHub/Daytona connections are done **once in the UI** by the human (never in files).

2. `agents/*.json` — the 13 agents in contracts section 6, each with:
   - focused instructions (role, inputs it receives, exactly what to output, what never to do),
   - only the tools it needs (`enable_tools` lists, never `@all` on GitHub),
   - `require_approval_for_tools` exactly as the table,
   - `response_format` JSON schema with `summary` and `confidence` always present,
   - `iteration_limit` (triage 10, diagnosis 40, validator/coder/tester 40, others 15),
   - `dynamic_sub_agents` on only for `ns-diagnosis` (instruct it to fan out 4 subagents: logs, traces, recent commits, past incidents; then merge),
   - `generative_ui` off (the orchestrator consumes JSON).
   Key behaviours to write into the instructions:
   - `ns-validator`: try to **disprove** the root cause. Clone the fork in the sandbox, install the service's deps (Node via `pip install nodejs-wheel`), write a minimal failing test with the service's external calls mocked (no secrets, no network to the shop), run it, return the real output. If it can't reproduce, say so honestly.
   - `ns-coder`: produce the smallest patch that makes the validator's test pass without breaking the service; run the test in the sandbox before answering. If the fix needs a capability no tool offers, write the new tool function + tests (Toolsmith mode) and return it as `new_tool` for human approval.
   - `ns-mitigator`: prefer the most reversible action (rollback to last good commit > flag off > restart > scale). Never act without a verified reason.
   - `ns-triage`: say `real_incident=false` when numbers are within normal variance; list the numbers used.
   - `ns-docs`: when an error involves an external provider (e.g. Razorpay, Stripe), find the **official** docs for the SDK version in the repo's lockfile, save them with provider + version + date via `knowledge.save_docs`, and return sources. Check the provider's status page.
   - Everyone: cite evidence (log line, trace id, commit sha). Never print secrets. Never invent tool output.

3. `skills/` (push to GitHub, register by repo URL):
   - `sandbox-toolchains/SKILL.md`: how to set up Node (`nodejs-wheel`), Python, run tests for each language in `systems/*.yaml`, how to mock gRPC/HTTP calls, time limits.
   - `astronomy-shop-runbooks/SKILL.md` + `references/*.md`: architecture summary (from `../astronomy-shop/SHOP-MAP.html`), each service's role, the flagd switches and what each breaks, safe mitigations per service.
   - `incident-postmortem/SKILL.md`: postmortem template (timeline, impact, root cause, fix, prevention).

4. `mcp/knowledge/` (FastMCP, port 8001, bearer token) + Qdrant:
   - Tools: `search_incidents(query, k=5)`, `search_docs(query, provider="", k=5)`, `save_docs(provider, version, url, text)`, `save_postmortem(incident_id, markdown)`.
   - Embeddings: OpenAI `text-embedding-3-small` (key from `.env`). Rerank top 20 → 5 with `fastembed` cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`, CPU).
   - Redact before storing (same rules as ops-mcp). Chunk ~800 tokens with overlap. Collections: `incidents`, `docs`.
   - `knowledge/docs/`: write 6–8 realistic past postmortems and runbooks for this shop (e.g. "payment rejected valid cards after validation refactor", "Kafka consumer lag during sale", "cart Redis evictions", "product-catalog DB lock contention"). Mark them clearly as fictional examples in their front matter.

5. `pipelines/airflow/` — Airflow `standalone` container (last; skip if Docker RAM is short and run the same ingest as a cron script). DAG `ingest_docs`: every 5 min, new files in `knowledge/docs/` → redact → chunk → embed → upsert via the knowledge service's `/ingest` HTTP endpoint.

6. `mcp/codegraph/` (FastMCP, port 8002, bearer token) + Neo4j (cap heap 512M):
   - Indexer: parse `../astronomy-shop/src/{payment,frontend,recommendation,agent,checkout}` into `(:Service)-[:HAS_FILE]->(:File)-[:DEFINES]->(:Function)`, `(:Function)-[:CALLS]->(:Function)`, `(:Service)-[:CALLS_SERVICE]->(:Service)` (from gRPC client usage / env `*_ADDR`), `(:Commit)-[:CHANGED]->(:File)` from `git log --name-only -50`. Use Python `ast` for Python and `tree-sitter-language-pack` for JS/TS; Go/C# get file + service level only.
   - Tools: `blast_radius(file_or_function)` (callers, services affected, recent commits touching it), `service_dependencies(service)`, `commits_touching(path, since)`.

7. Add qdrant, neo4j, knowledge-mcp, codegraph-mcp, airflow to `nightshift/compose.yaml`.

## Done when

- `python scripts/setup_trueforge.py` on a fresh TrueForge shows all MCP servers connected and 13 agents in the Agents page.
- In the TrueForge chat, `ns-diagnosis` on "payment errors in the last 10 minutes" reads real logs and traces and returns valid JSON with evidence.
- `ns-validator` produces a failing test for a known payment bug inside the Daytona sandbox and returns the real test output.
- Asking `ns-mitigator` to roll back pauses with an Allow/Deny card.
- Knowledge search returns the right postmortem for "payment validation errors after deploy".
- `agents/README.md` lists every agent, its model, tools and approvals (judges will read this).

Commit small and often. Never commit `.env`, tokens or `.data/`.
