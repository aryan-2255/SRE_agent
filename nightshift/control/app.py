"""NightShift control: watcher + orchestrator + approvals + the dashboard API, in one process on :8090."""
import asyncio
import json
import logging
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from . import approvals, bus, db, jira, ops_client, orchestrator, settings, watcher

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
# The React dashboard (control/ui, built with `npm run build`) when present; the original static page otherwise.
_UI_DIST = Path(__file__).parent / "ui" / "dist"
WEB = _UI_DIST if (_UI_DIST / "index.html").exists() else Path(__file__).parent / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    bus.attach_loop(asyncio.get_running_loop())
    orchestrator.resume_unfinished()
    orchestrator.start_worker()
    jira.start_poller()
    task = asyncio.create_task(watcher.run())
    yield
    task.cancel()


app = FastAPI(title="NightShift control", lifespan=lifespan)


def _json(rows):
    return json.loads(json.dumps(rows, default=str))


@app.get("/api/incidents")
def incidents(limit: int = 50):
    return _json(db.q("select * from incidents order by opened_at desc limit %s", limit))


@app.get("/api/incidents/{incident_id}")
def incident(incident_id: str):
    inc = db.incident(incident_id)
    if not inc:
        raise HTTPException(404)
    inc["events"] = db.q("select * from events where incident_id=%s order by id", incident_id)
    if inc.get("jira_key"):
        inc["jira_url"] = jira.browse_url(inc["jira_key"])
    return _json(inc)


@app.get("/api/stream")
async def stream(request: Request):
    q = bus.subscribe()

    async def gen():
        try:
            yield {"event": "hello", "data": json.dumps({"watch": watcher.latest}, default=str)}
            while not await request.is_disconnected():
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield {"event": "message", "data": json.dumps(msg, default=str)}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": "{}"}
        finally:
            bus.unsubscribe(q)

    return EventSourceResponse(gen())


class Decision(BaseModel):
    decision: str
    reason: str = ""


LOCAL = {"127.0.0.1", "::1", "localhost"}


def who(request: Request) -> str:
    """Who is deciding. The server decides this, never the request body: a token from DASHBOARD_USERS,
    or, when no users are configured, anyone on this machine only."""
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip() or request.cookies.get("ns_token", "")
    if settings.DASHBOARD_USERS:
        name = settings.DASHBOARD_USERS.get(token)
        if not name:
            raise HTTPException(401, "Sign in with your NightShift token")
        return name
    if request.client and request.client.host in LOCAL:
        return "local operator"
    raise HTTPException(401, "Approvals from other machines need DASHBOARD_USERS in .env")


@app.get("/api/me")
def me(request: Request):
    try:
        return {"name": who(request), "mode": "users" if settings.DASHBOARD_USERS else "local"}
    except HTTPException as e:
        return {"name": None, "mode": "users" if settings.DASHBOARD_USERS else "local", "error": e.detail}


@app.post("/api/approvals/{approval_id}")
def decide(approval_id: int, body: Decision, request: Request):
    by = who(request)
    row = approvals.decide(approval_id, body.decision, "dashboard", by, body.reason)
    if not row:
        raise HTTPException(409, "Already decided or not found")
    inc = db.one("select jira_key from incidents where id=%s", row["incident_id"])
    jira.comment(inc and inc["jira_key"], f"NightShift: {row['tool']} {row['status']} by {by} from the dashboard."
                 + (f" Reason: {body.reason}" if body.reason else ""))
    return _json(row)


@app.get("/api/agents")
def agents():
    """Who is on the team: each agent's job, model tier, tools, which tools wait for a person, and its runtime."""
    stage_of = {v: k for k, v in orchestrator.AGENTS.items()}
    stage_of["ns-supervisor"] = "supervisor"
    out = []
    for f in sorted((settings.ROOT / "agents").glob("ns-*.json")):
        spec = json.loads(f.read_text())
        m = spec["manifest"]
        cfg = m.get("config", {})
        out.append({
            "name": spec["name"], "stage": stage_of.get(spec["name"]), "job": spec["description"],
            "model": {"$SMALL": "small", "$STRONG": "strong"}.get(m["model"]["name"], m["model"]["name"]),
            "tools": {s["name"]: s.get("enable_tools", []) for s in m.get("mcp_servers", [])},
            "asks_before": [t for s in m.get("mcp_servers", []) for t in s.get("require_approval_for_tools", [])],
            "sandbox": cfg.get("sandbox", {}).get("enabled", False),
            "sub_agents": cfg.get("dynamic_sub_agents", {}).get("enabled", False),
        })
    return out


@app.get("/api/watch")
def watch():
    return _json(watcher.latest)


@app.get("/api/system")
def system():
    return settings.system()


@app.get("/api/connections")
async def connections():
    out = {}
    async with httpx.AsyncClient(timeout=5) as c:
        async def check(name, fn):
            try:
                out[name] = await fn()
            except Exception as e:  # noqa: BLE001
                out[name] = {"ok": False, "detail": str(e)[:200]}

        async def tf():
            r = await c.get(f"{settings.TRUEFORGE_BASE_URL}/healthz")
            servers = (await c.get(f"{settings.TRUEFORGE_BASE_URL}/api/v1/settings/mcp-servers")).json()["data"]
            agents = (await c.get(f"{settings.TRUEFORGE_BASE_URL}/api/v1/agents")).json()["data"]
            models = (await c.get(f"{settings.TRUEFORGE_BASE_URL}/api/v1/settings/model-providers")).json()["data"]
            return {"ok": r.status_code == 200, "detail": r.json().get("version"),
                    "mcp_servers": {s["manifest"]["name"]: (s.get("auth_status") or {}).get("status") for s in servers},
                    "agents": sorted(a["name"] for a in agents), "model_providers": len(models)}

        async def prom():
            r = await c.get(f"{settings.PROMETHEUS_URL}/-/ready")
            return {"ok": r.status_code == 200}

        async def ops():
            svcs = await ops_client.call("list_services", timeout=20)
            return {"ok": isinstance(svcs, list), "detail": f"{len(svcs)} containers" if isinstance(svcs, list) else str(svcs)[:200]}

        async def jr():
            if not jira.enabled():
                return {"ok": False, "detail": "not configured (dashboard approvals still work)"}
            r = await c.get(settings.env("JIRA_BASE_URL").rstrip("/") + "/rest/api/3/myself",
                            auth=(settings.env("JIRA_EMAIL"), settings.env("JIRA_API_TOKEN")))
            return {"ok": r.status_code == 200, "detail": r.json().get("displayName") if r.status_code == 200 else r.status_code}

        await asyncio.gather(check("trueforge", tf), check("prometheus", prom), check("ops_mcp", ops), check("jira", jr))
    out["slack"] = {"ok": bool(settings.env("SLACK_WEBHOOK_URL")), "detail": "webhook set" if settings.env("SLACK_WEBHOOK_URL") else "not configured"}
    return out


@app.post("/api/demo/{scenario}")
def demo(scenario: str, request: Request):
    who(request)
    if not settings.DEMO_MODE:
        raise HTTPException(403, "Demo endpoints are off")
    script = settings.ROOT / "chaos" / "break.sh"
    if not script.exists():
        raise HTTPException(404, "chaos/break.sh not found")
    p = subprocess.run([str(script), scenario], capture_output=True, text=True, timeout=300)
    return {"ok": p.returncode == 0, "output": (p.stdout + p.stderr)[-2000:]}


@app.post("/api/test-incident")
def test_incident(request: Request, service: str = "payment"):
    """Open an incident by hand (for testing the pipeline without breaking anything)."""
    who(request)
    inc = watcher.open_incident(settings.system(), service, f"Manual test incident on {service}", {"type": "manual"})
    return {"incident": inc}


if WEB.exists():
    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
