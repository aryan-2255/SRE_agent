# NightShift build plan — how to run it

Four Claude Code accounts build in parallel, one workstream each. Each gets one file to paste. All of them share `00-CONTRACTS.md`, so they don't need to talk to each other.

| Account | Paste this file | Builds | Folders it owns |
|---|---|---|---|
| A | `A-ops-mcp.md` | ops MCP server, deploy/rollback, 10% canary | `mcp/ops/`, payment-lb |
| B | `B-control.md` | watcher, orchestrator, Jira approvals, state, API | `control/` (not `web/`), `systems/` |
| C | `C-agents-knowledge.md` | TrueForge setup, 13 agents, skills, knowledge, code graph, Airflow | `agents/`, `skills/`, `scripts/`, `mcp/knowledge/`, `mcp/codegraph/`, `pipelines/`, `knowledge/` |
| D | `D-dashboard-demo.md` | dashboard, chaos scripts, evals, README, demo script | `control/web/`, `chaos/`, `evals/`, `docs/`, `README.md` |

`compose.yaml` is shared: each account adds only its own services.

## Step 0 — you (the human), before the accounts start

1. `mkdir nightshift && cd nightshift && git init`, then create the public repo `aryan-2255/nightshift` on GitHub and `git remote add origin ...`.
2. Copy `plan/` next to it (it already is: `../plan`).
3. Start TrueForge: `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@0.2.1 --port 8790`, open `http://localhost:8790`, then in **Settings**:
   - Models: add OpenAI (use the hackathon credits).
   - Sandbox providers: Daytona API key (Sandboxes + Snapshots write).
   - Connectors: GitHub with a fine-grained token that can only access `aryan-2255/opentelemetry-demo` (contents, pull requests, actions read), and Exa.
4. Create: a free Jira Cloud site with project key `SRE` and an API token; a Slack incoming webhook.
5. Put the non-TrueForge secrets in `nightshift/.env` (see contracts section 10). Never paste keys into the Claude chats.
6. Make sure the shop is running: `../astronomy-shop/shop.sh status`.
7. Docker Desktop → Settings → Resources: raise memory to 10–11 GB if you can (the shop uses ~4 GB; Neo4j, Qdrant and Airflow add ~3 GB).

## Step 1 — start all four accounts at the same time

Each works against fakes until the real parts exist:
- B uses a `FakeStageRunner` until C's agents are saved.
- D uses a recorded mock stream until B's API is up.
- C can test agents in the TrueForge chat as soon as A's ops-mcp answers.

## Integration checkpoints (in this order)

1. **ops-mcp live** (A) → C registers it in TrueForge → `ns-diagnosis` reads real logs in chat.
2. **Watcher fires** (B) on `paymentFailure` → incident row + SSE events.
3. **First real pipeline** (B + C): triage → diagnosis → validator (sandbox) → planner → Jira ticket → mitigator approval from Jira → verify. This alone satisfies all three hackathon requirements. **Protect this path; demo it even if nothing else lands.**
4. **Dashboard live** (D) on B's stream.
5. **Fix path** (C + A + B): coder → tester → PR → reviewer → cicd → canary → promote.
6. `break.sh payment-bug` end to end, then evals, then README polish.
7. Knowledge (Qdrant, docs researcher), code graph, Airflow: add as they are ready; the pipeline must work without them.

## Rules for every account

- Build only after the organizers allow it (or after 9:00 AM on 26 Sep). Commit small and often.
- Never commit `.env`, tokens, `*.sqlite`, or screenshots showing keys.
- Record the AI tools used for the README (Claude Code, 4 accounts).
- Every person on the team must be able to explain the architecture (the rules require it). Read the architecture page once.

## Demo reminders

- Start `./shop.sh public` and make the QR code from the new link.
- Run `chaos/break.sh payment-bug` 2–3 minutes before the judges reach you.
- Open windows: dashboard (`:8090`), shop on phone, Jira ticket, Grafana APM dashboard, TrueForge Sessions.
- Have the screen recording ready as a fallback.
