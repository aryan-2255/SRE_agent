"""Break the shop in known ways and score what NightShift does.

    .venv/bin/python evals/run.py                      # every scenario in evals/scenarios.yaml
    .venv/bin/python evals/run.py payment-failure ad-failure

Needs NightShift running (control on :8090 with STAGE_RUNNER=trueforge) and, to run scenarios back to back,
WATCH_COOLDOWN_S=60 and JIRA_DRY_RUN=true in .env (so evals do not fill the real Jira project).

For each scenario it records: was an incident opened (and how fast), on the right service, did the diagnosis name the
cause, was the first change it asked for the right one, did the service recover, what it cost. Approvals are answered
automatically: the expected change is approved, anything else is denied (a wrong change never reaches the shop).
Results go to evals/results/<time>.json and a table is printed.
"""
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx
import yaml

ROOT = Path(__file__).resolve().parent.parent
API = "http://localhost:8090"
c = httpx.Client(base_url=API, timeout=30)


def get(path: str):
    """GET that rides out a NightShift restart (it continues unfinished incidents on start)."""
    for _ in range(20):
        try:
            return c.get(path).json()
        except httpx.HTTPError:
            time.sleep(3)
    raise RuntimeError(f"NightShift did not answer {path}")


def incidents() -> list[dict]:
    return get("/api/incidents")


def flag(name: str, variant: str) -> None:
    subprocess.run([str(ROOT / ".venv/bin/python"), str(ROOT / "scripts/mcp_call.py"), "set_flag",
                    json.dumps({"flag": name, "variant": variant})], check=True, capture_output=True)


def chaos(kind: str, name: str) -> None:
    subprocess.run([str(ROOT / "chaos" / f"{kind}.sh"), *([name] if name else [])], check=True, capture_output=True, cwd=ROOT)


def matches(expected: dict, tool: str, args: dict) -> bool:
    return tool == expected.get("tool") and all(str(args.get(k)) == str(v) for k, v in (expected.get("args") or {}).items())


def run(sc: dict) -> dict:
    exp, brk = sc["expect"], sc["break"]
    timeout = sc.get("timeout_s", 480)
    before = {i["id"] for i in incidents()}
    r = {"id": sc["id"], "detected": False}
    t0 = time.time()
    if "flag" in brk:
        flag(brk["flag"], brk["variant"])
    else:
        chaos("break", brk["chaos"])
    inc, seen_approvals = None, set()
    try:
        while time.time() - t0 < timeout:
            new = [i for i in incidents() if i["id"] not in before]
            if new and not inc:
                inc = new[-1]
                r.update(detected=True, incident=inc["id"], detect_s=round(time.time() - t0), service=inc["service"])
                if exp.get("incident") is False:
                    break
            if inc:
                d = get(f"/api/incidents/{inc['id']}")
                for a in d["approvals"]:
                    if a["status"] != "pending" or a["id"] in seen_approvals:
                        continue
                    seen_approvals.add(a["id"])
                    ok = matches(exp.get("fix") or {}, a["tool"], a["args"] or {})
                    if "first_change" not in r:
                        r["first_change"] = {"tool": a["tool"], "args": a["args"]}
                        r["fix_ok"] = ok
                    # the expected change and the steps after it go ahead; a wrong first change is refused
                    allow = ok or a["stage"] not in ("mitigation",) or r.get("fix_ok")
                    c.post(f"/api/approvals/{a['id']}", json={"decision": "approve" if allow else "deny",
                                                              "reason": "" if allow else "eval: not the expected change"})
                if d["status"] == "mitigated" and "mitigate_s" not in r:
                    r["mitigate_s"] = round(time.time() - t0)
                if d["status"] in ("resolved", "escalated", "false_alarm"):
                    break
            time.sleep(3)
    finally:
        # always put the shop back
        if "flag" in brk:
            flag(brk["flag"], "off")
        elif brk["chaos"] == "payment-bug":
            chaos("fix", "")
    if inc:
        d = get(f"/api/incidents/{inc['id']}")
        diag = next((s["output"] for s in reversed(d["stages"]) if s["name"] == "diagnosis" and s["output"]), {}) or {}
        tri = next((s["output"] for s in d["stages"] if s["name"] == "triage" and s["output"]), {}) or {}
        text = json.dumps([diag.get("root_cause"), diag.get("summary"), tri.get("summary")]).lower()
        r.update(status=d["status"], cost_usd=round(float(d["total_cost_usd"]), 3), total_s=round(time.time() - t0),
                 service=d["service"], cause_ok=any(w.lower() in text for w in exp.get("cause", [])),
                 service_ok=d["service"] in exp.get("service", [d["service"]]),
                 unverified_evidence=diag.get("unverified_evidence"))
    if exp.get("incident") is False:
        r["ok"] = not r["detected"]
    else:
        r["ok"] = bool(r.get("detected") and r.get("service_ok") and r.get("cause_ok") and r.get("fix_ok")
                       and r.get("status") in ("resolved", "mitigated"))
    return r


def main() -> None:
    scenarios = yaml.safe_load((ROOT / "evals/scenarios.yaml").read_text())
    pick = sys.argv[1:]
    if pick:
        scenarios = [s for s in scenarios if s["id"] in pick]
    results = []
    for sc in scenarios:
        print(f"== {sc['id']}", flush=True)
        res = run(sc)
        print("   ", json.dumps(res), flush=True)
        results.append(res)
        time.sleep(int(sc.get("settle_s", 90)))  # let the metrics window clear before the next scenario
    out = ROOT / "evals/results" / f"{datetime.now():%Y%m%d-%H%M}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(results, indent=1))
    ok = sum(r["ok"] for r in results)
    print(f"\n{ok}/{len(results)} scenarios fully right   (results: {out.relative_to(ROOT)})\n")
    print(f"{'scenario':24} {'ok':3} {'found':6} {'secs':5} {'service':16} {'cause':6} {'1st change':34} {'status':10} {'$':6}")
    for r in results:
        ch = r.get("first_change") or {}
        print(f"{r['id']:24} {'✓' if r['ok'] else '✗':3} {str(r['detected']):6} {str(r.get('detect_s', '-')):5} "
              f"{str(r.get('service', '-')):16} {str(r.get('cause_ok', '-')):6} "
              f"{(ch.get('tool', '-') + ' ' + json.dumps(ch.get('args', ''))[:24]):34} {str(r.get('status', '-')):10} {r.get('cost_usd', '-')}")


if __name__ == "__main__":
    main()
