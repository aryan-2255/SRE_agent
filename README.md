# SRE_agent · NightShift

An on-call team of AI agents on [TrueForge](https://github.com/truefoundry/trueforge) that watches a live system, finds the cause of an incident, proves it in a sandbox, asks a human before any risky change, and fixes it. Built for **Agents That Act** (TrueFoundry × Polaris, 26 September 2026).

**What it does, end to end:** a watcher with no AI checks the live shop every 5 seconds. When a service keeps failing, 14 TrueForge agents take over. A supervisor picks each next step within code guardrails. The agents work through triage, diagnosis (logs, traces, commits), reproducing the bug with a failing test in a Daytona sandbox, a plan with risk and evidence, and a rollback or flag change. They then verify recovery, write the code fix, run the tests, open a pull request, review it, merge it, ship a 10% canary, promote it, and write a postmortem. **Every change waits for a person**, approved on the dashboard or with `/approve` on the Jira ticket.

| Hackathon requirement | How NightShift meets it |
|---|---|
| Runs on TrueForge | All 14 agents are TrueForge agents (TrueForge 0.2.1, unmodified), driven through the TrueForge SDK |
| Reaches a real system | The live OpenTelemetry Astronomy Shop (31 containers): Prometheus, OpenSearch, Jaeger, Docker, feature flags, GitHub, Jira |
| Runs generated code in a sandbox | Validator, coder and tester clone the repo into Daytona and run tests they wrote |
| Pauses before irreversible actions | Rollback, flag changes, restarts, branch/push/PR, merge, deploy, canary, even notifications: each is gated by name and waits for a human |

**Tested:** 8 break scenarios (`nightshift/evals/`), all handled correctly, including a real bad commit fixed through a merged PR and a promoted canary. 21 guardrail tests (`nightshift/tests/`). Try it yourself: [nightshift/docs/MANUAL-TEST.md](nightshift/docs/MANUAL-TEST.md).

| Folder | What it is |
|---|---|
| [`nightshift/`](nightshift/) | The project: agents, ops MCP server, supervisor/orchestrator, dashboard, scripts. Start with [nightshift/README.md](nightshift/README.md). |
| `astronomy-shop/` | The system NightShift watches and repairs: the OpenTelemetry Astronomy Shop. It is **its own repo**, [aryan-2255/opentelemetry-demo](https://github.com/aryan-2255/opentelemetry-demo), linked here as a submodule. The agents read its commits and open their fix PRs there. |
| [`plan/`](plan/) | The build plan and interface contracts. |

## Run it

```bash
git clone --recursive https://github.com/aryan-2255/SRE_agent.git truforge_hackthon
cd truforge_hackthon/nightshift
./scripts/bootstrap.sh          # once: paths, Python packages, shop + NightShift containers, dashboard build
./scripts/nightshift.sh start   # TrueForge (http://localhost:8790) + NightShift (dashboard http://localhost:8090)
./chaos/break.sh payment-bug    # ship a real bad commit and watch the agents fix it
```

Secrets (`nightshift/.env`, the TrueForge setup in `nightshift/.data/`) are not in git. Full guide: [nightshift/SETUP.md](nightshift/SETUP.md).

## AI tools used to build this

Claude Code (Anthropic, Claude Opus 5.5) helped design and write the code, scripts and documentation. The team reviewed, ran and tested everything and can explain every part. At runtime the agents use MiniMax M2.5 and Kimi K3 through Amazon Bedrock.

## Credits

Architecture inspired by Bhavishya Pandit's SRE-agent talk at a Google event. Target system: [OpenTelemetry Astronomy Shop](https://github.com/open-telemetry/opentelemetry-demo) (Apache-2.0). Agent harness: [TrueForge](https://github.com/truefoundry/trueforge) by TrueFoundry (MIT). Dashboard design: Aarnav Mathakiya.

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
