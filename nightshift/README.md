# nightshift/

The NightShift project. **The full overview (architecture, diagrams, how to run it, results) is in the [main README](../README.md).**

| Where | What |
|---|---|
| [SETUP.md](SETUP.md) | Detailed setup on a new machine, TrueForge settings, troubleshooting |
| [agents/README.md](agents/README.md) | Every agent: job, model, tools, what it asks you before (generated from `agents/*.json`) |
| [docs/MANUAL-TEST.md](docs/MANUAL-TEST.md) | Plant a bug yourself and watch the agents fix it |
| [control/ui/README.md](control/ui/README.md) | The dashboard: code layout, colour meanings, demo helpers |
| [systems/astronomy-shop.yaml](systems/astronomy-shop.yaml) | The onboarding file: everything NightShift knows about the watched system |

```bash
./scripts/bootstrap.sh            # once
./scripts/nightshift.sh start     # TrueForge + NightShift
./.venv/bin/python -m pytest -q tests && ./.venv/bin/python evals/run.py
```
