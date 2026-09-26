"""The watcher: plain rules, no AI, runs all the time. It opens an incident only when a problem is large, real and lasting."""
import asyncio
import logging
import time

import httpx

from . import bus, db, ops_client, orchestrator, settings

log = logging.getLogger("watcher")
COOLDOWN_S = 600

latest: dict = {"services": {}, "synthetic": None, "ts": None}


def _seconds(window: str) -> int:
    return int(window[:-1]) * (60 if window.endswith("m") else 1)


async def _error_rates(client: httpx.AsyncClient, metric: str, window: str) -> dict[str, dict]:
    kind = 'span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER"'

    async def q(expr):
        r = await client.get(f"{settings.PROMETHEUS_URL}/api/v1/query", params={"query": expr})
        return r.json()["data"]["result"]

    total = await q(f"sum by (service_name) (rate({metric}{{{kind}}}[{window}]))")
    errs = await q(f'sum by (service_name) (rate({metric}{{{kind},status_code="STATUS_CODE_ERROR"}}[{window}]))')
    out = {r["metric"]["service_name"]: {"rps": float(r["value"][1]), "error_pct": 0.0} for r in total}
    for r in errs:
        s = r["metric"]["service_name"]
        if s in out and out[s]["rps"] > 0:
            out[s]["error_pct"] = round(100 * float(r["value"][1]) / out[s]["rps"], 2)
    for v in out.values():
        v["rps"] = round(v["rps"], 3)
    return out


def _deps(system: dict, service: str) -> set[str]:
    """Every service this one calls, directly or indirectly."""
    seen, todo = set(), list(system["services"].get(service, {}).get("depends_on", []))
    while todo:
        s = todo.pop()
        if s not in seen:
            seen.add(s)
            todo += system["services"].get(s, {}).get("depends_on", [])
    return seen


def _root_incident(system: dict, service: str) -> dict | None:
    """An active incident on a service this one depends on: this service is probably just a symptom."""
    deps = _deps(system, service)
    if not deps:
        return None
    return db.one("select id, service from incidents where system=%s and service = any(%s) and status in ('open','mitigated') "
                  "and opened_at > now() - interval '30 minutes' order by opened_at desc limit 1", system["name"], list(deps))


def open_incident(system: dict, service: str, reason: str, trigger: dict) -> str | None:
    root = _root_incident(system, service)
    if root:
        db.q("update incidents set trigger = coalesce(trigger,'{}'::jsonb) || jsonb_build_object('symptoms', "
             "coalesce(trigger->'symptoms','[]'::jsonb) || to_jsonb(%s::text)) where id=%s", service, root["id"])
        bus.publish("incident.symptom", f"{service} is failing too, most likely because it depends on {root['service']}",
                    root["id"], None, {"service": service, "reason": reason})
        return None
    fp = f"{system['name']}:{service}"
    recent = db.one("select id from incidents where fingerprint=%s and (status in ('open','mitigated') "
                    "or opened_at > now() - make_interval(secs => %s)) order by opened_at desc limit 1", fp, COOLDOWN_S)
    if recent:
        return None
    inc_id = db.new_incident_id()
    db.q("insert into incidents(id, system, service, status, fingerprint, summary, trigger) values (%s,%s,%s,'open',%s,%s,%s)",
         inc_id, system["name"], service, fp, reason, trigger)
    bus.publish("incident.opened", f"{inc_id}: {reason}", inc_id, None, {"service": service, "trigger": trigger})
    orchestrator.enqueue(inc_id)
    return inc_id


async def run(system_name: str = "astronomy-shop") -> None:
    system = settings.system(system_name)
    watch = system["watch"]
    need_s = _seconds(watch["demo_for"] if settings.DEMO_MODE else watch["for"])
    metric = system["telemetry"]["metrics"]["error_metric"]
    breach_since: dict[str, float] = {}
    synth_fails, last_synth = 0, 0.0
    async with httpx.AsyncClient(timeout=10) as client:
        while True:
            try:
                rates = await _error_rates(client, metric, "1m" if settings.DEMO_MODE else watch["window"])
                now = time.time()
                tiles = {}
                # services with fewer dependencies first, so the root cause opens the incident, not its symptoms
                order = sorted(system["services"].items(), key=lambda kv: len(_deps(system, kv[0])))
                for name, svc in order:
                    r = rates.get(name, {"rps": 0.0, "error_pct": 0.0})
                    limit = svc.get("slo", {}).get("max_error_pct", 5)
                    over = r["error_pct"] > limit and r["rps"] >= watch["min_rps"]
                    if over:
                        breach_since.setdefault(name, now)
                    else:
                        breach_since.pop(name, None)
                    held = round(now - breach_since[name]) if name in breach_since else 0
                    tiles[name] = {**r, "limit_pct": limit, "over": over, "over_for_s": held, "fires_after_s": need_s}
                    if over and held >= need_s:
                        # a dependency failing at the same time is the likelier root cause: open it there
                        failing_dep = next((d for d in sorted(_deps(system, name)) if d in breach_since), None)
                        if failing_dep:
                            dep_r = rates.get(failing_dep, {"error_pct": 0.0})
                            inc = open_incident(system, failing_dep,
                                                f"{failing_dep} errors at {dep_r['error_pct']}% (also breaking {name})",
                                                {"type": "error_rate", "service": failing_dep, "symptom_of": name, **dep_r})
                            if inc:
                                breach_since.pop(name, None)
                            continue
                        inc = open_incident(system, name, f"{name} errors at {r['error_pct']}% for {held}s (limit {limit}%)",
                                            {"type": "error_rate", **tiles[name]})
                        if inc:
                            breach_since.pop(name, None)

                # Synthetic customer every 30 s: catches bugs that return "success" with the wrong result.
                if now - last_synth > 30:
                    last_synth = now
                    try:
                        res = await ops_client.call("synthetic_check", {"flow": "add_to_cart"})
                        latest["synthetic"] = res
                        synth_fails = 0 if res.get("passed") else synth_fails + 1
                        if synth_fails >= 2:
                            step = res.get("failed_step") or {}
                            open_incident(system, "frontend", f"Synthetic customer failed twice: {step.get('step')} {step.get('detail', '')}",
                                          {"type": "synthetic", **res})
                            synth_fails = 0
                    except Exception as e:  # noqa: BLE001
                        log.warning("synthetic check failed to run: %s", e)

                latest.update({"services": tiles, "ts": now})
                bus.publish("watcher.tick", "", None, None, {"services": tiles, "synthetic": latest["synthetic"]}, store=False)
            except Exception as e:  # noqa: BLE001
                log.warning("watcher: %s", e)
            await asyncio.sleep(watch["poll_seconds"])
