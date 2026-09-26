"""NightShift ops MCP server: the only door the agents use to read and change the running system."""
import json
import logging
import os
from functools import wraps

import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.responses import JSONResponse

from . import config
from .adapters.extras import FlagdFlags, IncidentHistory, ReadOnlySQL, SyntheticUser, notify_slack
from .adapters.logs_opensearch import OpenSearchLogs
from .adapters.metrics_prometheus import PrometheusMetrics
from .adapters.runtime_compose import DockerComposeRuntime
from .adapters.traces_jaeger import JaegerTraces
from .redact import redact

log = logging.getLogger("ops-mcp")
SYSTEM = config.system()
TEL = SYSTEM["telemetry"]

metrics = PrometheusMetrics(TEL["metrics"]["url"], TEL["metrics"]["error_metric"], TEL["metrics"]["duration_metric"])
logs = OpenSearchLogs(TEL["logs"]["url"], TEL["logs"]["index"], TEL["logs"]["service_field"])
traces = JaegerTraces(TEL["traces"]["url"], TEL["traces"]["ui"])
runtime = DockerComposeRuntime(config.shop_path(), SYSTEM["runtime"])
flags = FlagdFlags(config.shop_path() / SYSTEM["flags"]["file"], config.shop_path() / ".nightshift" / "flag-backups")
synthetic = SyntheticUser(SYSTEM["shop_url"])
sql = ReadOnlySQL(config.env("DB_HOST", "astronomy-db"), int(config.env("DB_PORT", "5432")), config.env("DB_NAME", "astronomy_db"),
                  config.env("DB_ADMIN_USER", "postgres"), config.env("DB_ADMIN_PASSWORD", ""), config.env("SHOP_DB_RO_PASSWORD", ""))
history = IncidentHistory(config.env("NIGHTSHIFT_DB_URL", ""))

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False)
DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True)

mcp = FastMCP(
    "nightshift-ops",
    instructions=(
        f"Operate the '{SYSTEM['name']}' system ({SYSTEM['domain']}). Read tools are safe. "
        "Tools that change the system pause for human approval. Every output is redacted."
    ),
    stateless_http=True,
    # Clients are TrueForge on the host and containers on the Docker network; a bearer token protects it instead.
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


def _service(name: str) -> dict:
    svc = SYSTEM["services"].get(name)
    if not svc:
        raise ValueError(f"Unknown service '{name}'. Known: {sorted(SYSTEM['services'])}")
    return svc


def safe(fn):
    """Return redacted JSON text; turn exceptions into a clear error message instead of a crash."""

    @wraps(fn)
    def inner(*args, **kwargs):
        try:
            result = fn(*args, **kwargs)
            text = result if isinstance(result, str) else json.dumps(result, indent=1, default=str)
        except Exception as e:  # noqa: BLE001
            log.exception("tool %s failed", fn.__name__)
            text = json.dumps({"error": f"{type(e).__name__}: {e}"})
        return redact(text)

    return inner


# ---------------- read ----------------
@mcp.tool(annotations=READ)
@safe
def list_services() -> str:
    """Every container of the system with state, health and the commit it is running."""
    return runtime.services()


@mcp.tool(annotations=READ)
@safe
def get_error_rates(window: str = "2m", services: str = "") -> str:
    """Requests per second, error percentage, failed requests and p95 latency over a window like '1m' or '2m'.
    services: comma-separated names (e.g. 'payment,checkout') to keep the answer small. Default: the watched
    services, plus any other service with errors. Each watched service also shows its error threshold."""
    rates = metrics.error_rates(window)
    wanted = {x.strip() for x in services.split(",") if x.strip()}
    seconds = int(window[:-1]) * (60 if window.endswith("m") else 1) if window[:-1].isdigit() else 120
    out = {}
    for name, r in rates.items():
        svc = SYSTEM["services"].get(name)
        if wanted and name not in wanted:
            continue
        if not wanted and not svc and not r.get("error_pct"):
            continue
        r["failed_requests"] = round(r["rps"] * r["error_pct"] / 100 * seconds, 1)
        if not r["rps"]:
            r["note"] = f"no requests in the last {window}: 0% here means no data, not healthy. Use a longer window."
        if svc:
            r["threshold_error_pct"] = svc.get("slo", {}).get("max_error_pct")
            r["over_threshold"] = r["error_pct"] > (r["threshold_error_pct"] or 100)
        out[name] = r
    return out or {"note": f"no traffic in the last {window} for {sorted(wanted) or 'any service'}"}


@mcp.tool(annotations=READ)
@safe
def get_metrics(promql: str, minutes: int = 15) -> str:
    """Run a PromQL range query over the last N minutes. Returns min / max / last per series."""
    out = []
    for s in metrics.query_range(promql, minutes)[:20]:
        vals = [float(v[1]) for v in s["values"] if v[1] not in ("NaN", "+Inf", "-Inf")]
        r4 = lambda v: None if v is None else round(v, 4)
        out.append({"labels": s["metric"], "min": r4(min(vals, default=None)), "max": r4(max(vals, default=None)),
                    "last": r4(vals[-1] if vals else None), "points": len(vals)})
    return out


@mcp.tool(annotations=READ)
@safe
def query_logs(service: str, minutes: int = 15, contains: str = "", level: str = "", limit: int = 50) -> str:
    """Recent log lines of one service, newest first. Filter by text (contains) or level (error, warn, info)."""
    rows = logs.query(service, minutes, contains, level, limit)
    return {"service": service, "count": len(rows), "by_level": logs.count_by_level(service, minutes), "lines": rows}


@mcp.tool(annotations=READ)
@safe
def get_traces(service: str, minutes: int = 15, errors_only: bool = True, limit: int = 5,
               real_users_only: bool = False) -> str:
    """Recent request traces through a service: root call, duration, the first failing step, and origin_step:
    the deepest failing step, where the error started (its caller failed only because of it).
    real_users_only skips load-generator traffic."""
    return traces.search(service, minutes, errors_only, limit, real_users_only)


@mcp.tool(annotations=READ)
@safe
def get_trace(trace_id: str) -> str:
    """Every step of one request in order: service, operation, time, errors and key attributes."""
    return traces.get(trace_id)


@mcp.tool(annotations=READ)
@safe
def get_recent_deploys(service: str = "") -> str:
    """Deploy and rollback history (newest last) plus the latest commits touching the service's code."""
    out = {"deploys": runtime.recent_deploys(service)}
    if service:
        out["recent_commits"] = runtime.recent_commits(_service(service)["path"])
    return out


@mcp.tool(annotations=READ)
@safe
def get_flags() -> str:
    """Current value and options of every feature flag (failure switches included)."""
    return flags.all()


@mcp.tool(annotations=READ)
@safe
def run_sql_readonly(sql_query: str) -> str:
    """Run one SELECT against the shop database with a read-only user (max 100 rows, 5 s timeout)."""
    return sql.query(sql_query)


@mcp.tool(annotations=READ)
@safe
def synthetic_check(flow: str = "add_to_cart") -> str:
    """Use the live shop like a real customer. flow='add_to_cart' adds 5 items and checks the cart really holds 5;
    flow='checkout' also places an order. Returns pass/fail and the failing step."""
    return synthetic.run(flow)


@mcp.tool(annotations=READ)
@safe
def search_incidents(text: str, limit: int = 5) -> str:
    """Past incidents of this system that match the words in `text` (service, error message, cause):
    what the root cause was, what fixed it, and the postmortem summary. Use it early in a diagnosis."""
    return history.search(text, limit)


@mcp.tool(annotations=READ)
@safe
def get_incident_evidence(incident_id: str, stage: str = "", tool: str = "", limit: int = 8) -> str:
    """The raw tool outputs earlier agents saw in this incident (newest first), for when a summary is not enough.
    Filter by stage (e.g. 'diagnosis') or tool (e.g. 'query_logs')."""
    return history.evidence(incident_id, stage, tool, limit)


# ---------------- change (paused for human approval) ----------------
@mcp.tool(annotations=DESTRUCTIVE)
@safe
def rollback(service: str, to_commit: str = "") -> str:
    """Run the previous known-good image of a service (no rebuild, a few seconds). Default: the version before the current one."""
    _service(service)
    return runtime.rollback(service, to_commit)


@mcp.tool(annotations=DESTRUCTIVE)
@safe
def deploy(service: str, commit: str = "origin/main") -> str:
    """Pull the merged code, build the service image, tag it with the commit and swap it in."""
    return runtime.deploy(service, _service(service)["path"], commit)


@mcp.tool(annotations=DESTRUCTIVE)
@safe
def deploy_canary(service: str, commit: str, percent: int = 10) -> str:
    """Start the given commit's image next to the current one and send it `percent`% of traffic."""
    return runtime.deploy_canary(service, commit, percent)


@mcp.tool(annotations=DESTRUCTIVE)
@safe
def promote_canary(service: str) -> str:
    """Make the canary the main version and remove the canary."""
    return runtime.promote_canary(service)


@mcp.tool(annotations=WRITE)
@safe
def abort_canary(service: str) -> str:
    """Send all traffic back to the main version and remove the canary."""
    return runtime.abort_canary(service)


@mcp.tool(annotations=DESTRUCTIVE)
@safe
def restart_service(service: str) -> str:
    """Restart one service's container."""
    _service(service)
    return runtime.restart(service)


@mcp.tool(annotations=DESTRUCTIVE)
@safe
def scale_service(service: str, replicas: int) -> str:
    """Run 1-5 copies of a service."""
    _service(service)
    return runtime.scale(service, replicas)


@mcp.tool(annotations=DESTRUCTIVE)
@safe
def set_flag(flag: str, variant: str) -> str:
    """Change a feature flag's value. Returns old and new value and how to undo it."""
    return flags.set(flag, variant)


@mcp.tool(annotations=WRITE)
@safe
def notify(text: str, channel: str = "slack") -> str:
    """Post a status message for the on-call team."""
    return notify_slack(config.env("SLACK_WEBHOOK_URL"), text)


# ---------------- HTTP app with bearer auth ----------------
class BearerAuth:
    def __init__(self, app, token: str):
        self.app, self.token = app, token

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] != "/healthz":
            headers = dict(scope.get("headers") or [])
            if headers.get(b"authorization", b"").decode() != f"Bearer {self.token}":
                await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def app():
    starlette = mcp.streamable_http_app()
    starlette.add_route("/healthz", lambda request: JSONResponse({"ok": True, "system": SYSTEM["name"]}))
    token = os.environ.get("OPS_MCP_TOKEN", "")
    if not token:
        raise SystemExit("OPS_MCP_TOKEN is required")
    return BearerAuth(starlette, token)


def main():
    logging.basicConfig(level=logging.INFO)
    try:
        sql.ensure_role()
    except Exception as e:  # noqa: BLE001
        log.warning("read-only SQL role not ready: %s", e)
    uvicorn.run(app(), host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), log_level="info")


if __name__ == "__main__":
    main()
