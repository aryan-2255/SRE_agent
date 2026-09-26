"""The watcher: plain rules, no AI, runs all the time. It opens an incident only when a problem is large, real and lasting.

Three kinds of problem:
- error rate: a service fails more than its limit, with enough failed requests to be sure (not one unlucky call);
- signals: numbers error rates miss, e.g. a Kafka consumer falling behind (systems/<name>.yaml → signals);
- blind monitoring: Prometheus stops answering or no service reports anything. Silence is not health.
"""
import asyncio
import logging
import time
from collections import Counter

import httpx

from . import bus, db, ops_client, orchestrator, settings

log = logging.getLogger("watcher")
COOLDOWN_S = int(settings.env("WATCH_COOLDOWN_S", "600"))  # evals shorten this to run scenarios back to back

latest: dict = {"services": {}, "signals": {}, "synthetic": None, "blind": None, "ts": None}


def _seconds(window: str) -> int:
    return int(window[:-1]) * (60 if window.endswith("m") else 1)


def classify(r: dict, limit: float, window_s: int, min_failures: int) -> str:
    """'over' = clearly failing; 'ok' = traffic flows and errors are under the limit;
    'quiet' = too little traffic to tell (the breach timer pauses instead of resetting)."""
    rps, pct = r.get("rps", 0.0), r.get("error_pct", 0.0)
    failures = rps * pct / 100 * window_s
    if pct > limit and failures >= min_failures:
        return "over"
    if pct > limit or rps == 0:
        return "quiet"
    return "ok"


def tick_timer(since: dict, key: str, state: str, now: float, dt: float) -> int:
    """Advance one breach timer; returns for how many seconds the problem has lasted."""
    if state == "over":
        since.setdefault(key, now)
    elif state == "ok":
        since.pop(key, None)
    elif key in since:  # quiet: pause, so a lull in traffic neither fires nor forgets the problem
        since[key] += dt
    return round(now - since[key]) if key in since else 0


async def _query(client: httpx.AsyncClient, expr: str) -> list:
    r = await client.get(f"{settings.PROMETHEUS_URL}/api/v1/query", params={"query": expr})
    r.raise_for_status()
    return r.json()["data"]["result"]


async def _error_rates(client: httpx.AsyncClient, metric: str, window: str) -> dict[str, dict]:
    kind = 'span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER"'
    total = await _query(client, f"sum by (service_name) (rate({metric}{{{kind}}}[{window}]))")
    errs = await _query(client, f'sum by (service_name) (rate({metric}{{{kind},status_code="STATUS_CODE_ERROR"}}[{window}]))')
    out = {r["metric"].get("service_name", "?"): {"rps": float(r["value"][1]), "error_pct": 0.0} for r in total}
    for r in errs:
        s = r["metric"].get("service_name", "?")
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


async def origin_service(system: dict, service: str) -> str | None:
    """Where do the failures seen at `service` start? The most common deepest failing step in recent error traces."""
    try:
        traces = await ops_client.call("get_traces", {"service": service, "minutes": 5, "errors_only": True, "limit": 8},
                                       timeout=20)
    except Exception as e:  # noqa: BLE001
        log.info("origin lookup for %s failed: %s", service, e)
        return None
    if not isinstance(traces, list):
        return None
    votes = Counter((t.get("origin_step") or {}).get("service") for t in traces if t.get("origin_step"))
    for svc, _ in votes.most_common():
        if svc in system["services"]:
            return svc
    return None


async def run(system_name: str = "astronomy-shop") -> None:
    system = settings.system(system_name)
    watch = system["watch"]
    need_s = _seconds(watch["demo_for"] if settings.DEMO_MODE else watch["for"])
    window = watch["window"]
    window_s = _seconds(window)
    min_failures = watch.get("min_failures", 3)
    blind_after = watch.get("blind_after_s", 60)
    metric = system["telemetry"]["metrics"]["error_metric"]
    watched = {n: s for n, s in system["services"].items() if s.get("slo")}
    order = sorted(watched.items(), key=lambda kv: len(_deps(system, kv[0])))  # dependencies first
    since: dict[str, float] = {}
    prom_down_since = no_data_since = None
    synth_flows = ("add_to_cart", "checkout")
    synth_fails, synth_runs, last_synth = {f: 0 for f in synth_flows}, 0, 0.0
    last = time.time()
    async with httpx.AsyncClient(timeout=10) as client:
        while True:
            now = time.time()
            dt, last = now - last, now
            try:
                blind = None
                try:
                    rates = await _error_rates(client, metric, window)
                    prom_down_since = None
                except Exception as e:  # noqa: BLE001
                    rates = None
                    prom_down_since = prom_down_since or now
                    log.warning("prometheus query failed: %s", e)
                    if now - prom_down_since >= blind_after:
                        blind = ("prometheus", f"Monitoring is blind: Prometheus has not answered for {round(now - prom_down_since)}s ({e})")
                if rates is not None:
                    # how old is the newest data point? It is normally under 15 s; old data means the pipeline stopped,
                    # even while rates over the window still look busy
                    try:
                        res = await _query(client, f"time() - max(timestamp({metric}))")
                        age = float(res[0]["value"][1]) if res else float("inf")
                    except Exception:  # noqa: BLE001
                        age = 0.0
                    no_data_since = now - age if age >= 30 else None
                    if no_data_since and age >= blind_after:
                        blind = ("otel-collector", f"Monitoring is blind: the newest metric is {round(age)}s old; no service "
                                                   "is reporting. The telemetry pipeline (otel-collector) is likely down.")

                if blind:
                    if not latest.get("blind"):
                        bus.publish("watcher.blind", blind[1], None, None, {"service": blind[0]})
                    latest["blind"] = {"service": blind[0], "reason": blind[1], "since": prom_down_since or no_data_since}
                    open_incident(system, blind[0], blind[1], {"type": "monitoring_blind", "reason": blind[1]})
                    for k in since:  # nothing is known about the services now: pause their timers
                        since[k] += dt
                elif rates is not None:
                    if latest.get("blind"):
                        bus.publish("watcher.sighted", "Monitoring is back.", None, None, {})
                    latest["blind"] = None
                    tiles = {}
                    for name, svc in order:
                        r = rates.get(name, {"rps": 0.0, "error_pct": 0.0})
                        limit = svc["slo"].get("max_error_pct", 5)
                        state = classify(r, limit, window_s, min_failures)
                        held = tick_timer(since, name, state, now, dt)
                        failures = round(r["rps"] * r["error_pct"] / 100 * window_s, 1)
                        tiles[name] = {**r, "failed_requests": failures, "limit_pct": limit, "state": state,
                                       "over": state == "over", "over_for_s": held, "fires_after_s": need_s}
                    for name, t in tiles.items():
                        if not (t["over"] and t["over_for_s"] >= need_s):
                            continue
                        # a dependency failing at the same time is the likelier root cause: open it there
                        where = next((d for d in sorted(_deps(system, name)) if tiles.get(d, {}).get("over")), None)
                        if not where:
                            # otherwise ask the traces where the failing requests break
                            origin = await origin_service(system, name)
                            where = origin if origin and origin != name else None
                        target = where or name
                        tr = tiles.get(target, t)
                        reason = (f"{target} errors at {tr['error_pct']}% ({tr['failed_requests']} failed requests in {window})"
                                  + (f", also breaking {name}" if target != name else ""))
                        inc = open_incident(system, target, reason,
                                            {"type": "error_rate", "service": target, "symptom_of": name if target != name else None, **tr})
                        if inc:
                            since.pop(name, None)
                            since.pop(target, None)
                    latest["services"] = tiles

                    # signals that error rates miss (queue lag, stalled consumers)
                    sigs = {}
                    for sig in system.get("signals", []):
                        try:
                            res = await _query(client, sig["promql"])
                            value = round(float(res[0]["value"][1]), 3) if res else 0.0
                        except Exception as e:  # noqa: BLE001
                            log.warning("signal %s failed: %s", sig["name"], e)
                            continue
                        state = "over" if value > sig["above"] else "ok"
                        held = tick_timer(since, "signal:" + sig["name"], state, now, dt)
                        sigs[sig["name"]] = {"service": sig["service"], "value": value, "above": sig["above"],
                                             "over": state == "over", "over_for_s": held, "explain": sig.get("explain", "")}
                        if state == "over" and held >= need_s:
                            inc = open_incident(system, sig["service"], f"{sig['name']}: {value} (limit {sig['above']}). {sig.get('explain', '')}",
                                                {"type": "signal", "signal": sig["name"], "value": value, "promql": sig["promql"]})
                            if inc:
                                since.pop("signal:" + sig["name"], None)
                    latest["signals"] = sigs

                # Synthetic customer every 30 s, alternating browsing with a real checkout: it catches bugs that return
                # "200 OK" with the wrong result, and keeps a little traffic on the payment path at night.
                if now - last_synth > 30:
                    last_synth = now
                    flow = synth_flows[synth_runs % 2]
                    synth_runs += 1
                    try:
                        res = await ops_client.call("synthetic_check", {"flow": flow})
                        latest["synthetic"] = res
                        synth_fails[flow] = 0 if res.get("passed") else synth_fails[flow] + 1
                        if synth_fails[flow] >= 2:
                            step = res.get("failed_step") or {}
                            entry = "checkout" if flow == "checkout" else "frontend"
                            where = await origin_service(system, entry) or entry
                            open_incident(system, where, f"Synthetic customer failed twice: {step.get('step')} {step.get('detail', '')}",
                                          {"type": "synthetic", **res})
                            synth_fails[flow] = 0
                    except Exception as e:  # noqa: BLE001
                        log.warning("synthetic check failed to run: %s", e)

                latest["ts"] = now
                bus.publish("watcher.tick", "", None, None,
                            {"services": latest["services"], "signals": latest["signals"], "synthetic": latest["synthetic"],
                             "blind": latest["blind"]}, store=False)
            except Exception as e:  # noqa: BLE001
                log.warning("watcher: %s", e)
            await asyncio.sleep(watch["poll_seconds"])
