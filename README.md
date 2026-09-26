# SRE_agent · NightShift

An on-call team of AI agents on [TrueForge](https://github.com/truefoundry/trueforge) that watches a live system, finds the cause of an incident, proves it in a sandbox, asks a human before any risky change, and fixes it. Built for **Agents That Act** (TrueFoundry × Polaris, 26 September 2026).

| Folder | What it is |
|---|---|
| [`nightshift/`](nightshift/) | The project: agents, ops MCP server, supervisor/orchestrator, dashboard, scripts. Start with [nightshift/README.md](nightshift/README.md). |
| [`astronomy-shop/`](astronomy-shop/) | The system NightShift watches and repairs: the OpenTelemetry Astronomy Shop (31 Docker containers), with `shop.sh` and a visual map in `SHOP-MAP.html`. |
| [`plan/`](plan/) | The build plan and interface contracts. |

## Run it

```bash
git clone https://github.com/aryan-2255/SRE_agent.git truforge_hackthon
cd truforge_hackthon/nightshift
./scripts/bootstrap.sh                               # once: paths, Python packages, shop + NightShift containers
./scripts/start-trueforge.sh                         # keep open → http://localhost:8790
./.venv/bin/uvicorn control.app:app --port 8090      # keep open → dashboard http://localhost:8090
```

Secrets (`nightshift/.env`, the TrueForge setup in `nightshift/.data/`) are not in git. Get them from a teammate privately. Full guide: [nightshift/SETUP.md](nightshift/SETUP.md).

## Working together

```bash
git pull                                   # teammate's changes first
git add -A && git commit -m "what changed" && git push
git log --stat                             # who changed what
```
