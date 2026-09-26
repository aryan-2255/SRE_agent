# SRE_agent · NightShift

An on-call team of AI agents on [TrueForge](https://github.com/truefoundry/trueforge) that watches a live system, finds the cause of an incident, proves it in a sandbox, asks a human before any risky change, and fixes it. Built for **Agents That Act** (TrueFoundry × Polaris, 26 September 2026).

| Folder | What it is |
|---|---|
| [`nightshift/`](nightshift/) | The project: agents, ops MCP server, supervisor/orchestrator, dashboard, scripts. Start with [nightshift/README.md](nightshift/README.md). |
| `astronomy-shop/` | The system NightShift watches and repairs: the OpenTelemetry Astronomy Shop (31 Docker containers). It is **its own repo**, [aryan-2255/opentelemetry-demo](https://github.com/aryan-2255/opentelemetry-demo), linked here as a submodule. The agents read its commits and open their fix PRs there. |
| [`plan/`](plan/) | The build plan and interface contracts. |

## Run it

```bash
git clone --recursive https://github.com/aryan-2255/SRE_agent.git truforge_hackthon
cd truforge_hackthon/nightshift
./scripts/bootstrap.sh                               # once: paths, Python packages, shop + NightShift containers
./scripts/start-trueforge.sh                         # keep open → http://localhost:8790
./.venv/bin/uvicorn control.app:app --port 8090      # keep open → dashboard http://localhost:8090
```

Secrets (`nightshift/.env`, the TrueForge setup in `nightshift/.data/`) are not in git. Get them from a teammate privately. Full guide: [nightshift/SETUP.md](nightshift/SETUP.md).

## Two repos, two jobs

| Repo | Job | Who uses it |
|---|---|---|
| **aryan-2255/SRE_agent** (this one) | Share NightShift, the plan and docs between teammates | us |
| **aryan-2255/opentelemetry-demo** (`astronomy-shop/`) | The use case: the shop's code. NightShift's agents read its commits, test it in the sandbox and open PRs there | the agents (and us, when we change the shop) |

```bash
git pull && git submodule update          # teammate's changes, plus the shop version they use
git add -A && git commit -m "what changed" && git push
git log --stat                            # who changed what
```

Changing the shop itself: commit and push inside `astronomy-shop/` (that goes to the fork), then `git add astronomy-shop && git commit && git push` here to share which shop version to use.
