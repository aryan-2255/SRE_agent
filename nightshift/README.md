# NightShift

An on-call team of AI agents, built on [TrueForge](https://github.com/truefoundry/trueforge), that watches a live system, finds the cause of an incident, proves it in a sandbox, asks a human before any risky change, and fixes it.

Built for **Agents That Act** (TrueFoundry × Polaris, Bengaluru, 26 September 2026).

**Architecture page:** https://claude.ai/artifact/DZTegNgebksC8Lov1zRkZU · **Setup:** [SETUP.md](SETUP.md) · **Agents:** [agents/README.md](agents/README.md)

```bash
git clone --recursive https://github.com/aryan-2255/SRE_agent.git truforge_hackthon
cd truforge_hackthon/nightshift && ./scripts/bootstrap.sh
```

## How it works

1. **Watch (no AI, ₹0 while quiet).** The watcher reads the system's metrics every 5 seconds and opens an incident only when a service stays over its error threshold (for example 5% for 2 minutes, 30 seconds in demo mode). A synthetic customer shops every 30 seconds to catch bugs that return "success" with the wrong result.
2. **Agents (TrueForge), coordinated by a supervisor.** After triage, a supervisor agent reads every agent's latest answer and picks the next move: run an agent, ask an agent a question, send work back with feedback (for example the reviewer rejecting a fix), escalate to a human, or finish. Code enforces the guardrails: which moves are allowed at each point (for example CI/CD only after tests pass and the reviewer approves), attempt limits, the cost budget, and human approval for every change. If the supervisor's choice breaks a rule, the rule-based choice is used instead.
3. **Human approval.** Every change to production (rollback, flag change, restart, deploy, merge) pauses inside TrueForge. The on-call engineer answers on the dashboard or by commenting `/approve` or `/deny` on the incident's Jira ticket.
4. **Any system.** Agents only use generic tools (`query_logs`, `get_error_rates`, `rollback`, …) from the `nightshift-ops` MCP server. Adapters translate them for the system described in its onboarding file (`systems/astronomy-shop.yaml`).

## The three hackathon requirements

| Requirement | Where it happens |
|---|---|
| Reaches a real system | `nightshift-ops` reads and operates the live OpenTelemetry Astronomy Shop (31 containers); agents also use GitHub and Jira |
| Runs generated code in a sandbox | Validation, coder and tester agents clone the repo into a Daytona sandbox and run tests they wrote |
| Stops before irreversible actions | Tools that change the system are listed by name in each agent's `require_approval_for_tools`; TrueForge pauses and NightShift asks on Jira or the dashboard |

## Repository

| Path | What it is |
|---|---|
| `mcp/ops/` | MCP server with 19 tools: metrics, logs, traces, deploy history, flags, read-only SQL, synthetic customer, rollback, deploy, canary, restart, scale, notify |
| `control/` | Watcher, orchestrator, Jira approval bridge, incident state (Postgres), API and live stream |
| `control/web/` | Dashboard |
| `agents/` | 13 TrueForge agent specs |
| `skills/` | Skills the agents load (sandbox toolchains, runbooks, postmortem template) |
| `systems/` | Onboarding file per watched system |
| `chaos/` | Scripts that break and restore the shop for demos |
| `scripts/` | Bootstrap, TrueForge setup, MCP command-line client |
| `docs/plan/` | The build plan and interface contracts |
| `../astronomy-shop/` | The system being watched: OpenTelemetry Astronomy Shop, its own repo (aryan-2255/opentelemetry-demo) where the agents open PRs |

## Status

Working and tested against the live shop: watcher, ops server (all tools), rollback (~11 s), 90/10-style canary through `payment-lb`, dashboard, Jira approval bridge, and the full flag-incident path with real models (detect → triage → diagnosis → plan → approved mitigation → verify → postmortem, about 4 minutes).

Supervisor agent working live: on a flag incident it chose each step with a reason, skipped the sandbox and code path because the cause was a flag, and resolved it for about $0.23.

Code-fix path run end to end on 26 Sep (INC-004): a bad commit pushed to the fork was detected, reproduced in a Daytona sandbox, rolled back, fixed by the coder, tested, opened as a PR, reviewed, merged and shipped through a 10% canary. When the PR agent reported a PR it had not created, the reviewer caught it and the supervisor sent the work back. Try it yourself: [docs/MANUAL-TEST.md](docs/MANUAL-TEST.md).

Planned: a toolsmith agent that writes missing read-only tools.

## AI tools used to build this

Claude Code (Anthropic, Claude Opus 5.5) helped design and write the code, scripts and documentation. The team reviewed, ran and tested everything and can explain every part.

Runtime models used by the agents: MiniMax M2.5 and Kimi K3 through Amazon Bedrock.

## Credits

- Architecture inspired by Bhavishya Pandit's SRE-agent talk at a Google event.
- Target system: [OpenTelemetry Astronomy Shop](https://github.com/open-telemetry/opentelemetry-demo) (Apache-2.0).
- Agent harness: [TrueForge](https://github.com/truefoundry/trueforge) by TrueFoundry (MIT), used unmodified.
