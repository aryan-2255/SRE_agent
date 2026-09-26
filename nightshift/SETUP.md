# Setting up NightShift on a new machine

About 20 minutes, most of it Docker downloading images. Written for a teammate joining the project.

## What you need

- macOS or Linux, **Docker Desktop with at least 10 GB of memory** (Settings → Resources) and about 20 GB of free disk
- Node.js 22.14+ (for TrueForge) and Python 3.12+
- Write access to two repos (ask Aryan to add you as a collaborator on both):
  - `aryan-2255/SRE_agent`: NightShift, the plan and docs, shared between teammates
  - `aryan-2255/opentelemetry-demo`: the shop (the use case). The agents read its commits and open PRs there.
- The secret values for `.env` and TrueForge. Get them from Aryan **privately** (a one-time secret link, never a group chat or git).

## 1. Get the code

The team repo brings the shop with it (as a submodule):

```bash
git clone --recursive https://github.com/aryan-2255/SRE_agent.git truforge_hackthon
cd truforge_hackthon/nightshift
```

Forgot `--recursive`? The bootstrap below fetches the shop for you.

## 2. Run the bootstrap

```bash
./scripts/bootstrap.sh
```

It creates `.env` (with a fresh ops-server token and the right shop path), installs the Python packages into `.venv`, starts the shop's 31 containers and NightShift's own containers. Run it again any time; it only fills in what is missing.

Check the shop: http://localhost:8080 (store), http://localhost:8080/grafana/, http://localhost:8080/feature/ (failure switches).

## 3. Add the secrets to `.env`

Open `nightshift/.env` and fill in the values Aryan sends you:

```
JIRA_BASE_URL=https://aryanmatrixx.atlassian.net
JIRA_EMAIL=<your Atlassian email>
JIRA_API_TOKEN=<your own token from id.atlassian.com/manage-profile/security/api-tokens>
SLACK_WEBHOOK_URL=        # optional
```

Leave everything else as the bootstrap set it. `.env` is ignored by git; never commit it.

## 4. Start TrueForge and connect it

```bash
./scripts/nightshift.sh start      # TrueForge + NightShift control, restarted automatically if they crash
./scripts/nightshift.sh status     # or: stop | restart | logs control | logs trueforge
```

Open http://localhost:8790 → **Settings**:

| Setting | What to add |
|---|---|
| **Models** | *Add custom provider*: name `bedrock`, base URL `https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1`, the Bedrock API key, and two models: `minimax-m2-5` → `minimax.minimax-m2.5`, `kimi-k3` → `global.moonshotai.kimi-k3` |
| **Sandbox providers** | Daytona API key (Sandboxes + Snapshots write) |
| **Connectors → GitHub** | Your own fine-grained token, repository `aryan-2255/opentelemetry-demo` only, permissions Contents RW, Pull requests RW, Actions R, Commit statuses R |
| **Connectors → Jira** | Connect and log in with Atlassian |

TrueForge is started through `scripts/start-trueforge.sh`, which sets `OUTBOUND_URL_ALLOWED_HOSTS` so TrueForge can reach NightShift's servers on localhost.

## 5. Load the agents

```bash
./.venv/bin/python scripts/setup_trueforge.py
```

It registers the `nightshift-ops` server and creates or updates all 14 agents (see `agents/README.md`). Run it again after changing anything in `agents/`.

## 6. Open NightShift

`scripts/nightshift.sh start` already runs it. Dashboard: http://localhost:8090. The watcher starts immediately; if
NightShift restarts mid-incident, it continues from the last finished step.

Who may approve: with nothing set, only this machine. To give each person their own sign-in, add to `.env`:
`DASHBOARD_USERS=aryan:<long random token>,friend:<another token>` and restart. The dashboard asks for the token once,
and every approval is recorded under that name (Jira approvals use the Jira user).

## 7. Try an incident

```bash
./.venv/bin/python scripts/mcp_call.py set_flag '{"flag":"paymentFailure","variant":"50%"}'
```

Within about a minute the dashboard shows an incident; the agents diagnose it and ask for approval to turn the flag off (Approve on the dashboard, or comment `/approve` on the Jira ticket). Undo by hand at any time:

```bash
./.venv/bin/python scripts/mcp_call.py set_flag '{"flag":"paymentFailure","variant":"off"}'
```

## Handy commands

| Command | What it does |
|---|---|
| `astronomy-shop/shop.sh status` | Shop containers and memory |
| `astronomy-shop/shop.sh logs payment` | One container's logs |
| `python scripts/mcp_call.py` | List the ops tools; add a tool name and JSON args to call one |
| `docker compose logs -f ops-mcp` | Ops server logs |
| `chaos/break.sh <scenario>` / `chaos/fix.sh` | Break the shop on purpose / restore it |
| `.venv/bin/python -m pytest -q tests` | Guardrail tests (no models needed, under a second) |
| `.venv/bin/python evals/run.py [scenario…]` | Break the shop in 8 known ways and score detection, cause, fix, cost (set `WATCH_COOLDOWN_S=60`, `JIRA_DRY_RUN=true` first) |
| `docs/MANUAL-TEST.md` | Step-by-step: plant a bug and watch the agents fix it |
| `.venv/bin/python scripts/map_system.py` | Rebuild `systems/<name>.map.md`, the architecture the agents get up front (run after big code changes) |
| `cd control/ui && npm run build` | Rebuild the dashboard after changing `control/ui` (the control service serves `control/ui/dist`) |

## Working together

NightShift, the plan and docs live in `SRE_agent`. The shop is its own repo in `astronomy-shop/`.

```bash
git pull && git submodule update   # teammate's changes, plus the shop version they use
# ...edit NightShift...
git add -A && git commit -m "what you changed" && git push
git log --stat                     # who changed what
```

Changing the shop's code: commit and push inside `astronomy-shop/` (that goes to aryan-2255/opentelemetry-demo), then in the team repo `git add astronomy-shop && git commit -m "Use new shop version" && git push`.

## Troubleshooting

- **"Outbound URL blocked for host localhost"** in TrueForge: it was started without `scripts/start-trueforge.sh`.
- **Port 6379/5432 already in use**: NightShift uses 6380 (Redis) and 5433 (Postgres) to avoid clashes; stop whatever else is using them if these clash too.
- **Grafana keeps restarting**: Docker has too little memory; raise it to 10 GB+.
- **Agents missing tools**: run `setup_trueforge.py` again after connecting GitHub or other connectors.
