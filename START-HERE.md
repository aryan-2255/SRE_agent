# truforge_hackthon: start here

This is Aryan's complete project folder, as-is:

- `nightshift/`: NightShift (agents, ops MCP server, control, dashboard, scripts, `.env`)
- `astronomy-shop/`: the shop NightShift watches and repairs (31 Docker containers)
- `plan/`: the build plan
- `nightshift/.data/trueforge.sqlite`: Aryan's TrueForge setup (Bedrock models, Daytona sandbox, GitHub, Jira, nightshift-ops, all 14 agents). `start-trueforge.sh` uses it automatically.

**Contains private keys. Don't upload or share further.**

Needs: Docker Desktop with 10 GB+ memory, ~20 GB free disk, Node.js 22.14+, Python 3.12+.

```bash
cd truforge_hackthon/nightshift
./scripts/bootstrap.sh                               # once; fixes paths for this laptop, starts everything
./scripts/start-trueforge.sh                         # keep open → http://localhost:8790
./.venv/bin/uvicorn control.app:app --port 8090      # keep open → dashboard http://localhost:8090
./.venv/bin/python scripts/mcp_call.py set_flag '{"flag":"paymentFailure","variant":"50%"}'   # try an incident
```

Details: `nightshift/SETUP.md`.
