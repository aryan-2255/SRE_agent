"""Register NightShift's MCP servers, skills and agents in TrueForge. Safe to run again: it creates or updates.

Model keys, GitHub, Jira OAuth and the sandbox provider are set once in TrueForge's Settings UI, never here.
Usage: python scripts/setup_trueforge.py [--dry-run]
"""
import json
import os
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
for line in (ROOT / ".env").read_text().splitlines() if (ROOT / ".env").exists() else []:
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.split(" #")[0].strip())

TF = os.environ.get("TRUEFORGE_BASE_URL", "http://localhost:8790").rstrip("/") + "/api/v1"
DRY = "--dry-run" in sys.argv
c = httpx.Client(timeout=60)

OUR_SERVERS = {
    "nightshift-ops": ("http://localhost:8000/mcp", "OPS_MCP_TOKEN",
                       "Read and operate the Astronomy Shop: metrics, logs, traces, deploys, rollback, canary, feature flags, synthetic customer checks."),
    "nightshift-knowledge": ("http://localhost:8001/mcp", "KNOWLEDGE_MCP_TOKEN",
                             "Search past incidents, runbooks and saved provider documentation; save postmortems and docs."),
    "nightshift-codegraph": ("http://localhost:8002/mcp", "CODEGRAPH_MCP_TOKEN",
                             "Code graph of the system: callers, service dependencies, commits touching a file, blast radius."),
}


def get(path):
    r = c.get(TF + path)
    r.raise_for_status()
    return r.json()["data"]


def say(msg):
    print(("[dry-run] " if DRY else "") + msg)


def register_servers():
    existing = {s["manifest"]["name"] for s in get("/settings/mcp-servers")}
    for name, (url, token_env, desc) in OUR_SERVERS.items():
        token = os.environ.get(token_env)
        if not token:
            say(f"skip {name}: {token_env} not set")
            continue
        try:
            c.get(url.replace("/mcp", "/healthz"), timeout=3).raise_for_status()
        except Exception:  # noqa: BLE001
            say(f"skip {name}: not running at {url}")
            continue
        body = {"manifest": {"type": "remote", "name": name, "description": desc, "url": url,
                             "auth": {"type": "header", "headers": {"Authorization": f"Bearer {token}"}}}}
        if DRY:
            say(f"would register {name}")
            continue
        r = c.put(f"{TF}/settings/mcp-servers", json=body) if name in existing else c.post(f"{TF}/settings/mcp-servers", json=body)
        say(f"{'updated' if name in existing else 'registered'} {name}: {r.status_code}")
        if r.status_code >= 300:
            print("   ", r.text[:300])


REASONING: dict[str, bool] = {}


def pick_models():
    rows = get("/models")
    for m in rows:
        REASONING[m["name"]] = bool((m.get("properties") or {}).get("reasoning_efforts"))
    models = [m["name"] for m in rows]

    def choose(env, prefs):
        if os.environ.get(env):
            return os.environ[env]
        for p in prefs:
            for m in models:
                if m.endswith("/" + p) or m == p:
                    return m
        return None

    small = choose("NS_MODEL_SMALL", ["minimax-m2-5", "gpt-5-4-mini", "claude-haiku-4-5", "gemini-3-6-flash"])
    strong = choose("NS_MODEL_STRONG", ["kimi-k3", "gpt-5-5", "claude-opus-5", "claude-sonnet-5", "gemini-3-1-pro-preview"]) or small
    return small or strong, strong, models


def server_tools(name):
    try:
        return {t["name"] for t in get(f"/mcp-servers/{name}/tools")}
    except Exception:  # noqa: BLE001
        return None


def build_manifest(spec, small, strong, servers, skills):
    m = json.loads(json.dumps(spec["manifest"]).replace('"$SMALL"', json.dumps(small)).replace('"$STRONG"', json.dumps(strong)))
    if not REASONING.get(m["model"]["name"], False):
        m["model"].get("params", {}).pop("reasoning_effort", None)  # this model has no reasoning-effort setting
    kept, notes = [], []
    for srv in m.get("mcp_servers", []):
        if srv["name"] not in servers:
            notes.append(f"{srv['name']} not configured")
            continue
        tools = servers[srv["name"]]
        if tools is not None and srv.get("enable_tools") != ["@all"]:
            wanted = srv["enable_tools"]
            srv["enable_tools"] = [t for t in wanted if t in tools]
            missing = [t for t in wanted if t not in tools]
            if missing:
                notes.append(f"{srv['name']} has no {missing}")
            if not srv["enable_tools"]:
                notes.append(f"{srv['name']}: none of its tools matched, detached")
                continue
        # approvals: always by name, and only for tools that exist
        srv["require_approval_for_tools"] = [t for t in srv.get("require_approval_for_tools", []) if tools is None or t in tools]
        kept.append(srv)
    for srv in kept:
        srv["preload"] = True  # small tool sets: load schemas up front so every model sees them without searching
    m["mcp_servers"] = kept
    # Some providers stop calling tools when the output format is forced, so the schema goes into the
    # instructions instead; the orchestrator validates the JSON and retries once if it is invalid.
    rf = m.pop("response_format", None)
    if rf and os.environ.get("NS_FORCE_RESPONSE_FORMAT") != "1":
        schema = rf["json_schema"]["schema"]
        m["instructions"] += ("\n\nWhen you are done, reply with ONLY this JSON object (no other text). "
                              f"Required fields: {schema['required']}. Schema: {json.dumps(schema['properties'])}")
    elif rf:
        m["response_format"] = rf
    m["skills"] = [s for s in m.get("skills", []) if s["name"] in skills]
    if not m["config"]["sandbox"]["enabled"]:
        m["skills"] = []
    return m, notes


def main():
    if not DRY:
        register_servers()
    small, strong, available = pick_models()
    if not small:
        sys.exit("No models available. Add a model provider in TrueForge (Settings → Models), then run this again.\n"
                 f"Models seen: {available}")
    print(f"models: small={small} strong={strong}")
    servers = {s["manifest"]["name"]: server_tools(s["manifest"]["name"]) for s in get("/settings/mcp-servers")
               if (s.get("auth_status") or {}).get("status") in ("authenticated", "not_required", None)}
    skills = {s.get("manifest", s).get("name") for s in get("/settings/skills")}
    existing = {a["name"]: a["id"] for a in get("/agents")}
    for f in sorted((ROOT / "agents").glob("ns-*.json")):
        spec = json.loads(f.read_text())
        manifest, notes = build_manifest(spec, small, strong, servers, skills)
        note = f"  ({'; '.join(notes)})" if notes else ""
        if DRY:
            say(f"{spec['name']}: {len(manifest['mcp_servers'])} servers{note}")
            continue
        if spec["name"] in existing:
            r = c.put(f"{TF}/agents/{existing[spec['name']]}", json={"description": spec["description"], "manifest": manifest})
        else:
            r = c.post(f"{TF}/agents", json={"name": spec["name"], "description": spec["description"], "manifest": manifest})
        ok = "ok" if r.status_code < 300 else f"FAILED {r.status_code} {r.text[:300]}"
        print(f"{spec['name']}: {ok}{note}")


if __name__ == "__main__":
    main()
