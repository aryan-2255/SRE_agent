"""The incident pipeline. Each stage is one TrueForge agent; this file decides the order, the loops and when to stop."""
import json
import logging
import re
import threading
import time
import traceback

import httpx
import redis

from . import approvals, bus, db, jira, settings
from .stages import StageError, runner

log = logging.getLogger("orchestrator")
STREAM = "ns:incidents"

# stage name -> TrueForge agent
AGENTS = {
    "triage": "ns-triage", "diagnosis": "ns-diagnosis", "validation": "ns-validator", "plan": "ns-planner",
    "mitigation": "ns-mitigator", "verify": "ns-verifier", "fix": "ns-coder", "test": "ns-tester",
    "pr": "ns-pr", "review": "ns-reviewer", "cicd": "ns-cicd", "postmortem": "ns-postmortem", "docs": "ns-docs",
}


# Agents that reason about code get the system map (scripts/map_system.py) in their input.
MAP_STAGES = {"diagnosis", "validation", "plan", "fix", "test", "review"}

# Claims a model may not invent: each must match the result of a real tool call in the same stage.
BACKED_CLAIMS = {"pr": ("pr_url", "create_pull_request"), "cicd": ("promoted", "promote_canary")}


def unbacked_claim(stage: str, output: dict, tool_calls: list[dict]) -> str | None:
    if stage not in BACKED_CLAIMS or not output.get(BACKED_CLAIMS[stage][0]):
        return None
    field, tool = BACKED_CLAIMS[stage]
    value = output[field]
    # the tool may be called directly or through TrueForge's call_tool wrapper
    results = [c.get("result", "") for c in tool_calls if c["tool"] == tool or tool in c.get("args", "")]
    if not results:
        return f"you reported {field}={value!r} but never called {tool}. Call {tool} and report what it returns"
    if isinstance(value, str) and not any(value in r for r in results):
        return f"{field} {value!r} does not appear in the result of {tool}. Report the value it returned"
    return None


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9.%:/_-]+", " ", str(text).lower()).strip()


def check_evidence(items: list, corpus: str) -> list:
    """Mark each evidence item verified=True only if what it quotes appears in a real tool output of this incident.
    Models sometimes paraphrase or invent 'log lines'; the supervisor and the dashboard see which ones are backed."""
    out = []
    for e in items or []:
        if not isinstance(e, dict):
            e = {"text": str(e)}
        text = str(e.get("text") or e.get("detail") or e.get("quote") or "")
        # trace ids and commit shas (hex with at least one letter, so plain numbers do not count)
        ids = [i for i in re.findall(r"\b[0-9a-f]{7,40}\b", text + " " + str(e.get("link", ""))) if re.search("[a-f]", i)]
        # the text itself (pieces between "..."), or the literals it quotes: "value": "off", "Up 2 hours"
        fragments = [f for f in (_norm(x) for x in re.split(r"\.\.\.|…|\n", text)) if len(f) >= 16]
        quoted = [q for q in (_norm(x) for x in re.findall(r'"([^"]{6,})"', text)) if len(q) >= 6]
        whole = bool(fragments) and all(any(f[i:i + 24] in corpus for i in range(0, max(1, len(f) - 23), 4)) for f in fragments)
        literal = bool(quoted) and sum(q in corpus for q in quoted) >= max(1, len(quoted) // 2)
        ok = whole or literal or (bool(ids) and all(i in corpus for i in ids))
        out.append({**e, "verified": ok})
    return out


def live_error(service: str, window: str = "30s") -> dict | None:
    """The service's error rate over the last few seconds, straight from Prometheus (the watcher's window is longer)."""
    metric = settings.system()["telemetry"]["metrics"]["error_metric"]
    sel = f'service_name="{service}",span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER"'
    try:
        def q(expr):
            r = httpx.get(f"{settings.PROMETHEUS_URL}/api/v1/query", params={"query": expr}, timeout=5).json()["data"]["result"]
            return float(r[0]["value"][1]) if r else 0.0
        total = q(f"sum(rate({metric}{{{sel}}}[{window}]))")
        errs = q(f'sum(rate({metric}{{{sel},status_code="STATUS_CODE_ERROR"}}[{window}]))')
    except Exception as e:  # noqa: BLE001
        log.info("live error rate for %s failed: %s", service, e)
        return None
    return {"rps": round(total, 3), "error_pct": round(100 * errs / total, 2) if total else 0.0, "window": window}


class Escalate(Exception):
    pass


class Pipeline:
    def __init__(self, incident_id: str):
        self.id = incident_id
        self.inc = db.one("select * from incidents where id=%s", incident_id)
        self.system = settings.system(self.inc["system"])
        self.auto = self.system.get("autonomy", {}).get("auto", [])
        self.run_stage_impl = runner()
        self.out: dict[str, dict] = {}
        self.corpus = ""          # every tool output of this incident, normalized: evidence is checked against it
        map_file = settings.ROOT / "systems" / f"{self.inc['system']}.map.md"
        self.system_map = map_file.read_text() if map_file.exists() else ""
        self.stage_ended: dict[str, float] = {}

    # ---------- helpers ----------
    def _cost(self) -> float:
        return float(db.one("select total_cost_usd from incidents where id=%s", self.id)["total_cost_usd"])

    def stage(self, name: str, extra: dict | None = None, attempt: int = 1) -> dict:
        if self._cost() > settings.INCIDENT_BUDGET_USD:
            raise Escalate(f"budget of ${settings.INCIDENT_BUDGET_USD} used up")
        db.q("insert into stages(incident_id, name, status, attempt) values (%s,%s,'running',%s)", self.id, name, attempt)
        db.q("update incidents set stage=%s where id=%s", name, self.id)
        bus.publish("stage.started", f"{name} started" + (f" (attempt {attempt})" if attempt > 1 else ""),
                    self.id, name, {"agent": AGENTS[name], "attempt": attempt})
        payload = {
            "incident": {k: self.inc[k] for k in ("id", "service", "severity", "category", "summary") if self.inc.get(k)},
            "trigger": self.inc.get("trigger"),
            "system": {k: self.system[k] for k in ("name", "domain", "repo", "runtime", "services", "shared_paths", "telemetry") if k in self.system},
            "previous": self.out,
            "attempt": attempt,
            **(extra or {}),
        }
        if name in MAP_STAGES and self.system_map:
            payload["system_map"] = self.system_map  # the architecture up front: fewer calls rediscovering it
        last_err = None
        for tries in range(2):  # one retry if the answer is not valid JSON or the call failed
            try:
                res = self.run_stage_impl.run(self.id, name, AGENTS[name], payload, self.auto)
                problem = unbacked_claim(name, res.output, res.tool_calls)
                if problem:
                    raise StageError(problem, res.tool_calls)
                break
            except (StageError, ValueError, json.JSONDecodeError) as e:
                last_err = e
                payload["retry_reason"] = f"Previous attempt failed: {e}. Answer with only the JSON object."
                done = [c for c in getattr(e, "tool_calls", []) if '"error"' not in c.get("result", "")[:40]]
                if done:
                    payload["already_done"] = {
                        "note": "The previous attempt was cut off after these tool calls succeeded. They took effect: "
                                "do not repeat or undo them, continue from where they left off.",
                        "tool_calls": [{"tool": c["tool"], "args": c.get("args", "")[:300], "result": c["result"][:400]} for c in done]}
                bus.publish("stage.retry", f"{name} retrying: {e}", self.id, name)
        else:
            db.q("update stages set status='failed', ended_at=now(), output=%s where incident_id=%s and name=%s and status in ('running','waiting_approval')",
                 {"error": str(last_err)}, self.id, name)
            bus.publish("stage.failed", f"{name} failed: {last_err}", self.id, name)
            raise Escalate(f"{name} failed twice: {last_err}")
        self.corpus += " " + " ".join(_norm(c.get("result", "")) for c in res.tool_calls)
        if isinstance(res.output.get("evidence"), list):
            res.output["evidence"] = check_evidence(res.output["evidence"], self.corpus)
            bad = [e for e in res.output["evidence"] if not e["verified"]]
            res.output["unverified_evidence"] = len(bad)
            if bad:
                bus.publish("evidence.unverified", f"{len(bad)} of {len(res.output['evidence'])} evidence items are not in any tool output",
                            self.id, name, {"items": bad[:5]})
        self.stage_ended[name] = time.time()
        db.q("update stages set status='done', ended_at=now(), cost_usd=%s, output=%s "
             "where incident_id=%s and name=%s and status in ('running','waiting_approval')",
             res.cost_usd, res.output, self.id, name)
        db.q("update incidents set total_cost_usd = total_cost_usd + %s where id=%s", res.cost_usd, self.id)
        self.out[name] = res.output
        bus.publish("stage.done", res.output.get("summary", f"{name} done"), self.id, name,
                    {"output": res.output, "cost_usd": res.cost_usd, "session_id": res.session_id})
        bus.publish("cost", "", self.id, name, {"total_usd": self._cost(), "total_inr": round(self._cost() * settings.USD_TO_INR, 2)})
        return res.output

    def skip(self, *names: str) -> None:
        for n in names:
            db.q("insert into stages(incident_id, name, status) values (%s,%s,'skipped')", self.id, n)
            bus.publish("stage.skipped", f"{n} not needed", self.id, n)

    def set(self, **fields) -> None:
        for k, v in fields.items():
            db.q(f"update incidents set {k}=%s where id=%s", v, self.id)
        self.inc = db.one("select * from incidents where id=%s", self.id)

    # ---------- the pipeline ----------
    def run(self, resume: bool = False) -> None:
        try:
            self._run(resume)
        except Escalate as e:
            self.escalate(str(e))
        except Exception as e:  # noqa: BLE001
            log.error("pipeline crashed: %s", traceback.format_exc())
            self.escalate(f"internal error: {e}")

    # ---------- the supervised loop ----------
    # How many times each agent may run in one incident, and how many steps in total.
    LIMITS = {"triage": 1, "diagnosis": 3, "validation": 2, "plan": 2, "mitigation": 3, "verify": 4,
              "fix": 3, "test": 3, "pr": 2, "review": 2, "cicd": 1, "postmortem": 1, "docs": 2}
    MAX_STEPS = 24

    def _ok(self, stage: str, key: str, default=None):
        return (self.out.get(stage) or {}).get(key, default)

    def _last(self, stage: str) -> int:
        """Step number at which a stage last finished (-1 if never)."""
        return max((i for i, h in enumerate(self.history) if h.get("stage") == stage and h.get("done")), default=-1)

    def allowed_moves(self) -> dict[str, str]:
        """Guardrails: which agents may run now, and why the others may not. The supervisor chooses only from these."""
        cat = self.inc.get("category") or "unknown"
        # a sandbox can only test code: "unknown" counts as a code problem only if diagnosis points at a change
        suspect = self._ok("diagnosis", "suspect_commit") or self._ok("diagnosis", "suspect_files")
        code_path = cat == "code" or (cat == "unknown" and bool(suspect))
        reproduced = bool(self._ok("validation", "reproduced"))
        cannot_run = self._ok("validation", "runnable") is False  # e.g. a Java service: read, not run
        recovered = bool(self._ok("verify", "recovered")) and self._last("verify") > self._last("mitigation")
        tests_ok = bool(self._ok("test", "passed")) and self._last("test") > self._last("fix")
        review_ok = self._ok("review", "verdict") == "approve" and self._last("review") > self._last("fix")
        rules = {
            "diagnosis": True,
            "validation": "diagnosis" in self.out and code_path,
            "docs": "diagnosis" in self.out,
            "plan": "diagnosis" in self.out and (reproduced or cannot_run or not code_path),
            "mitigation": "plan" in self.out,
            # verify after every change; or once more when it said "not recovered" but live numbers look healthy
            "verify": self._last("mitigation") > self._last("verify") or self._recheck_verify(),
            "fix": code_path and reproduced and bool(self._ok("plan", "fix_needed", True)),
            "test": self._last("fix") > self._last("test"),
            "pr": tests_ok,
            "review": "pr" in self.out and self._last("pr") > self._last("review"),
            "cicd": tests_ok and review_ok and "pr" in self.out,
            "postmortem": recovered,
        }
        moves = {}
        for stage, ok in rules.items():
            used = self.attempts.get(stage, 0)
            if ok and used < self.LIMITS[stage]:
                moves[stage] = f"allowed ({used}/{self.LIMITS[stage]} runs used)"
        return moves

    def _still_failing(self, service: str) -> str | None:
        """Why the service is still failing (live numbers over the watcher's window), or None."""
        limit = self.system["services"].get(service, {}).get("slo", {}).get("max_error_pct", 5)
        live = live_error(service, self.system["watch"].get("window", "2m"))
        if live and live["rps"] > 0 and live["error_pct"] > limit:
            return f"{service} is still at {live['error_pct']}% errors over the last {live['window']}"
        return None

    def _recheck_verify(self) -> bool:
        if "verify" not in self.out or self._ok("verify", "recovered") or self._last("verify") < self._last("mitigation"):
            return False
        live = live_error(self.inc["service"])
        limit = self.system["services"].get(self.inc["service"], {}).get("slo", {}).get("max_error_pct", 5)
        self._live_note = live
        return bool(live) and live["rps"] > 0 and live["error_pct"] <= limit

    def _next_option(self) -> dict | None:
        opts = self._ok("plan", "options", []) or []
        i = self.attempts.get("mitigation", 0)
        return opts[i] if i < len(opts) and isinstance(opts[i], dict) else None

    def default_next(self, moves: dict) -> dict:
        """The plain rule-based choice. Used as the supervisor's hint and as the fallback."""
        cat = self.inc.get("category") or "unknown"
        if "diagnosis" not in self.out:
            return {"action": "run", "stage": "diagnosis"}
        if cat == "external" or self._ok("diagnosis", "external"):
            return {"action": "escalate", "reason": "Cause is outside our system. No changes made."}
        if "validation" not in self.out and "validation" in moves:
            return {"action": "run", "stage": "validation"}
        if "validation" in self.out and not self._ok("validation", "reproduced") and "plan" not in moves:
            if "diagnosis" in moves:
                return {"action": "send_back", "stage": "diagnosis", "from": "validation",
                        "message": self._ok("validation", "disproved_reason") or "The sandbox could not reproduce this cause."}
            return {"action": "escalate", "reason": "Could not reproduce the root cause in the sandbox."}
        for stage in ("plan", "mitigation", "verify"):
            if stage in moves and (stage not in self.out or stage == "verify"):
                return {"action": "run", "stage": stage}
        if self._last("verify") > self._last("mitigation") and not self._ok("verify", "recovered"):
            # every change is a new risk: prove it is needed before making another one
            if "verify" in moves:
                live = getattr(self, "_live_note", None) or {}
                return {"action": "run", "stage": "verify",
                        "message": f"Live error rate over the last {live.get('window', '30s')} is {live.get('error_pct')}% "
                                   f"({live.get('rps')} req/s). Check again before anything else is changed."}
            nxt = self._next_option()
            if nxt and nxt.get("speculative"):
                return {"action": "escalate", "reason": f"The last change did not recover the service and the next option "
                                                        f"({nxt.get('action')}) is a guess without evidence. A person should decide."}
            if "mitigation" in moves:
                return {"action": "run", "stage": "mitigation", "message": "The last action did not recover the service. Use the next option."}
            return {"action": "escalate", "reason": "Mitigation did not recover the service."}
        if "cicd" in self.out and not self._ok("cicd", "promoted"):
            return {"action": "escalate", "reason": "The canary was not promoted; the fix is not live."}
        if "test" in self.out and not self._ok("test", "passed") and self._last("test") > self._last("fix") and "fix" not in moves:
            return {"action": "escalate", "reason": "The fix still fails its tests after every allowed attempt."}
        if self._ok("review", "verdict") == "changes" and self._last("review") > self._last("fix") and "fix" not in moves:
            return {"action": "escalate", "reason": "The reviewer still asks for changes after every allowed attempt."}
        if self._ok("review", "verdict") == "changes" and "fix" in moves and self._last("review") > self._last("fix"):
            return {"action": "send_back", "stage": "fix", "from": "review",
                    "message": "; ".join(self._ok("review", "comments", []) or ["Reviewer asked for changes."])}
        tested = self._last("test") > self._last("fix") and bool(self._ok("test", "passed"))
        for stage in ("fix", "test", "pr", "review", "cicd"):
            if stage not in moves:
                continue
            # a fix is written once, then tested; it is only rewritten after a failed test or a review asking for changes
            if stage == "fix" and "fix" in self.out and (self._last("fix") > self._last("test") or tested):
                continue
            if stage == "pr" and "pr" in self.out and self._last("pr") > self._last("fix"):
                continue  # the PR for this fix exists: review it
            return {"action": "run", "stage": stage}
        if "postmortem" in moves:
            return {"action": "run", "stage": "postmortem"}
        return {"action": "finish"}

    def _brief(self) -> dict:
        """What the supervisor sees: each agent's latest answer, trimmed."""
        keep = ("summary", "confidence", "real_incident", "category", "root_cause", "reproduced", "disproved_reason",
                "chosen", "fix_needed", "action_taken", "denied", "recovered", "passed", "failing_tests", "pr_url",
                "verdict", "comments", "promoted", "external", "suspect_commit", "unverified_evidence")
        return {st: {k: v for k, v in (o or {}).items() if k in keep} for st, o in self.out.items()}

    def needs_judgement(self, moves: dict, hint: dict) -> str | None:
        """Call the supervisor only where it can change the outcome. Returns why, or None for a clear next step."""
        if hint.get("action") == "escalate":
            return None  # a guardrail forces this: nothing to decide
        if len(moves) <= 1:
            return None
        last = self.history[-1]["stage"] if self.history else None
        o = self.out.get(last) or {}
        if o.get("confidence", 1) < 0.75:
            return f"{last} is unsure (confidence {o.get('confidence')})"
        for key, bad in (("reproduced", False), ("recovered", False), ("passed", False), ("verdict", "changes"), ("denied", True)):
            if key in o and o[key] == bad:
                return f"{last} answered {key}={bad}"
        asked_before = any(h.get("action") == "ask" and h.get("stage") == last for h in self.history)
        if o.get("unverified_evidence") and not asked_before:  # ask once; then the dashboard shows them as unverified
            return f"{last} cites {o['unverified_evidence']} evidence item(s) no tool returned"
        if last in ("pr", "review") and o.get("summary") and "not" in o.get("summary", "").lower():
            return f"{last} reports a problem"
        return None

    def supervise(self, moves: dict, hint: dict) -> dict:
        if settings.STAGE_RUNNER == "fake" or not settings.SUPERVISOR:
            return {**hint, "reason": "rule-based order", "by": "rules"}
        why = self.needs_judgement(moves, hint)
        if not why:
            return {**hint, "reason": hint.get("reason") or "the next step is clear, so the rules decided", "by": "rules"}
        payload = {
            "incident": {k: self.inc.get(k) for k in ("id", "service", "severity", "category", "summary")},
            "latest_answers": self._brief(),
            "history": [{k: h[k] for k in ("step", "action", "stage", "reason") if k in h} for h in self.history[-12:]],
            "allowed_stages": moves,
            "rule_based_suggestion": hint,
            "steps_left": self.MAX_STEPS - len(self.history),
            "budget_left_usd": round(settings.INCIDENT_BUDGET_USD - self._cost(), 3),
            "why_you_are_asked": why,
        }
        try:
            res = self.run_stage_impl.run(self.id, "supervisor", "ns-supervisor", payload, self.auto)
            db.q("update incidents set total_cost_usd = total_cost_usd + %s where id=%s", res.cost_usd, self.id)
            return {**res.output, "by": "supervisor", "asked_because": why, "session_id": res.session_id,
                    "cost_usd": round(res.cost_usd, 4)}
        except Exception as e:  # noqa: BLE001
            log.warning("supervisor failed, using rules: %s", e)
            return {**hint, "reason": f"supervisor unavailable ({str(e)[:120]}); rule-based order", "by": "rules"}

    def _valid(self, d: dict, moves: dict) -> str | None:
        """Return why a decision breaks the rules, or None if it is allowed."""
        act = d.get("action")
        if act in ("escalate", "finish"):
            if act == "finish" and not (self._ok("verify", "recovered") or self.inc.get("status") == "false_alarm"):
                return "cannot finish before the service is verified as recovered"
            if act == "finish" and "fix" in self.out and not self._ok("cicd", "promoted"):
                left = [s for s in ("test", "pr", "review", "cicd") if s in moves]
                if left:
                    return f"the code fix is written but not shipped yet (next: {left[0]})"
            return None
        if act not in ("run", "ask", "send_back"):
            return f"unknown action {act!r}"
        if d.get("stage") not in moves:
            return f"{d.get('stage')!r} is not allowed now"
        if act in ("ask", "send_back") and not d.get("message"):
            return "ask/send_back needs a message"
        return None

    def save_state(self) -> None:
        db.q("update incidents set state=%s where id=%s",
             {"out": self.out, "attempts": self.attempts, "history": self.history, "stage_ended": self.stage_ended}, self.id)

    def _restore(self) -> bool:
        st = self.inc.get("state") or {}
        if not st.get("history"):
            return False
        self.out, self.attempts, self.history = st["out"], st["attempts"], st["history"]
        self.stage_ended = st.get("stage_ended", {})
        for r in db.q("select data->>'result' r from events where incident_id=%s and kind='tool.result'", self.id):
            self.corpus += " " + _norm(r["r"] or "")
        bus.publish("incident.resumed", f"NightShift restarted; continuing {self.id} after step {len(self.history)}.", self.id)
        return True

    def _run(self, resume: bool = False) -> None:
        self.history: list[dict] = []
        self.attempts: dict[str, int] = {}
        if not (resume and self._restore()):
            tri = self.stage("triage")
            self.attempts["triage"] = 1
            self.history.append({"step": 0, "action": "run", "stage": "triage", "done": True, "reason": "every incident starts with triage"})
            if not tri.get("real_incident", True):
                # a false alarm must be confirmed by live numbers: little traffic can make a short window read "0%"
                still = self._still_failing(tri.get("service") or self.inc["service"])
                if still:
                    bus.publish("supervisor.overruled", f"Guardrail: triage called it a false alarm, but {still}. Treating it as real.",
                                self.id, "triage", {"triage": tri})
                    tri = {**tri, "real_incident": True}
            if not tri.get("real_incident", True):
                self.set(status="false_alarm", summary=tri.get("summary"))
                bus.publish("incident.closed", "False alarm: numbers are within normal variation. No action taken.", self.id)
                return
            self.set(severity=tri.get("severity"), category=tri.get("category"), service=tri.get("service") or self.inc["service"])
            self.save_state()

        while len(self.history) < self.MAX_STEPS:
            moves = self.allowed_moves()
            hint = self.default_next(moves)
            d = self.supervise(moves, hint)
            problem = self._valid(d, moves)
            if problem:
                bus.publish("supervisor.overruled", f"Guardrail: {problem}. Using the rule-based choice instead.", self.id,
                            None, {"rejected": d, "used": hint})
                d = {**hint, "reason": f"guardrail override: {problem}"}
            act, stage = d.get("action"), d.get("stage")
            step = len(self.history)
            label = {"run": f"run {stage}", "ask": f"ask {stage}", "send_back": f"send back to {stage}",
                     "escalate": "escalate to a human", "finish": "finish"}.get(act, act)
            bus.publish("supervisor.decision", f"{label}: {d.get('reason', '')}", self.id, stage,
                        {"decision": {k: v for k, v in d.items() if k not in ("session_id", "cost_usd", "by", "asked_because")},
                         "allowed": list(moves), "suggested": hint, "by": d.get("by", "supervisor"),
                         "asked_because": d.get("asked_because"), "session_id": d.get("session_id"), "cost_usd": d.get("cost_usd"),
                         "url": f"{settings.TRUEFORGE_BASE_URL}/sessions/{d['session_id']}" if d.get("session_id") else None})

            if act == "escalate":
                raise Escalate(d.get("reason") or "Supervisor escalated.")
            if act == "finish":
                break

            extra = {}
            if act in ("ask", "send_back"):
                who = d.get("from") or "supervisor"
                kind = "agent.question" if act == "ask" else "agent.sendback"
                bus.publish(kind, f"{who} → {stage}: {d['message']}", self.id, stage, {"from": who, "to": stage, "message": d["message"]})
                extra = {"question": d["message"], "asked_by": who, "mode": "answer this and update your result" if act == "ask" else "rework"}
            elif d.get("message"):
                extra = {"note": d["message"]}
            if stage == "mitigation":
                extra.update({"plan": self.out.get("plan"), "option_index": self.attempts.get("mitigation", 0),
                              "options": self._ok("plan", "options", [])})
            if stage in ("fix",) and "test" in self.out:
                extra["previous_test_output"] = self._ok("test", "output")
            if stage == "fix" and "review" in self.out:
                extra["review_comments"] = self._ok("review", "comments")
            if stage == "verify":
                # metrics need time to show a change: wait, then tell the verifier exactly how long ago it happened
                changed = self.stage_ended.get("mitigation", 0)
                wait_s = settings.VERIFY_SETTLE_S - (time.time() - changed)
                if changed and wait_s > 0:
                    bus.publish("stage.waiting", f"Waiting {int(wait_s)}s for fresh metrics before verifying", self.id, "verify")
                    time.sleep(wait_s)
                extra.update({"seconds_since_change": int(time.time() - changed) if changed else None,
                              "live_now": live_error(self.inc["service"]),
                              "change": self._ok("mitigation", "action_taken"), "change_summary": self._ok("mitigation", "summary")})

            self.attempts[stage] = self.attempts.get(stage, 0) + 1
            out = self.stage(stage, extra, self.attempts[stage])
            self.history.append({"step": step, "action": act, "stage": stage, "done": True, "reason": d.get("reason", "")})
            if act == "ask":
                bus.publish("agent.answer", f"{stage} answered: {out.get('summary', '')}", self.id, stage, {"answer": out})

            if stage == "plan" and not self.inc.get("jira_key"):
                key = jira.create_ticket(self.id, f"{self.id} · {self.inc['service']} · {self._ok('diagnosis', 'summary', '')[:120]}",
                                         self._ticket_body(self.out.get("diagnosis", {}), out))
                if key:
                    self.inc["jira_key"] = key
                    bus.publish("jira", f"Jira ticket {key} opened", self.id, "plan", {"key": key, "url": jira.browse_url(key)})
            if stage == "verify" and out.get("recovered") and self.inc.get("status") != "mitigated":
                self.set(status="mitigated")
                bus.publish("incident.mitigated", "Service recovered. Users are no longer affected.", self.id)
            if stage == "pr" and out.get("pr_url"):
                self.set(pr_url=out["pr_url"])
                jira.comment(self.inc.get("jira_key"), f"Fix ready for review: {out['pr_url']}")
            self.save_state()
        else:
            raise Escalate(f"Stopped after {self.MAX_STEPS} steps without resolving.")

        if "postmortem" not in self.out and self._ok("verify", "recovered"):
            self.attempts["postmortem"] = 1
            self.stage("postmortem")
        for name in AGENTS:
            if name not in self.out and name != "docs":
                self.skip(name)
        pm = self.out.get("postmortem", {})
        jira.comment(self.inc.get("jira_key"), pm.get("postmortem_md", pm.get("summary", "")))
        jira.close(self.inc.get("jira_key"))
        self.set(status="resolved", stage="done")
        db.q("update incidents set resolved_at=now() where id=%s", self.id)
        bus.publish("incident.resolved", f"{self.id} resolved. Total cost ${self._cost():.3f}", self.id, None,
                    {"total_usd": self._cost()})

    def _ticket_body(self, diag: dict, plan: dict) -> str:
        lines = [f"Incident {self.id} on {self.inc['system']} / {self.inc['service']} ({self.inc.get('severity')})", "",
                 "Root cause:", diag.get("root_cause", diag.get("summary", "")), "", "Evidence:"]
        for e in diag.get("evidence", [])[:8]:
            if not isinstance(e, dict):
                continue
            lines.append(f"- [{e.get('source', '?')}]{'' if e.get('verified', True) else ' [unverified]'} "
                         f"{e.get('text') or e.get('detail') or json.dumps(e)[:200]}" + (f" {e['link']}" if e.get("link") else ""))
        lines += ["", "Options:"]
        for o in plan.get("options", []):
            if not isinstance(o, dict):
                continue
            lines.append(f"- {o.get('action')} (risk {o.get('risk')}, reversible: {o.get('reversible')}, blast radius: {o.get('blast_radius', 'n/a')})"
                         + (" [SPECULATIVE: no direct evidence]" if o.get("speculative") else f" evidence: {str(o.get('evidence', ''))[:160]}"))
        lines += ["", f"Chosen: {plan.get('chosen')}", "",
                  "NightShift will ask here before each change. Reply /approve or /deny <reason>."]
        return "\n".join(lines)

    def escalate(self, reason: str) -> None:
        cancel_sessions(self.id)
        self.set(status="escalated", summary=reason)
        jira.comment(self.inc.get("jira_key"), f"Escalated to on-call: {reason}")
        bus.publish("incident.escalated", f"Escalated to a human: {reason}", self.id)


# ---------- queue ----------
def enqueue(incident_id: str) -> None:
    redis.from_url(settings.REDIS_URL).xadd(STREAM, {"id": incident_id})


def start_worker() -> None:
    def loop():
        r = redis.from_url(settings.REDIS_URL, socket_timeout=30)
        last = "$"
        while True:
            try:
                batches = r.xread({STREAM: last}, block=5000, count=10) or []
            except redis.exceptions.RedisError as e:
                log.warning("queue read failed, retrying: %s", e)
                continue
            for _, entries in batches:
                for entry_id, fields in entries:
                    last = entry_id
                    inc_id = fields[b"id"].decode()
                    threading.Thread(target=Pipeline(inc_id).run, daemon=True, name=f"pipeline-{inc_id}").start()

    threading.Thread(target=loop, daemon=True, name="incident-worker").start()


def cancel_sessions(incident_id: str) -> None:
    """Stop TrueForge sessions that no process is listening to any more; otherwise they keep running and billing."""
    if settings.STAGE_RUNNER == "fake":
        return
    rows = db.q("select trueforge_session_id s from stages where incident_id=%s and status in ('running','waiting_approval') "
                "and trueforge_session_id is not null", incident_id)
    for r in rows:
        try:
            runner().client.sessions.cancel(session_id=r["s"])
        except Exception as e:  # noqa: BLE001
            log.info("could not cancel session %s: %s", r["s"], e)


def resume_unfinished() -> None:
    """After a restart, unfinished incidents continue from their last completed step. The step that was running is
    decided again (its TrueForge turn died with the old process); approvals it was waiting for expire."""
    for row in db.q("select id from incidents where status in ('open','mitigated') and stage is distinct from 'done'"):
        for a in approvals.pending(row["id"]):
            approvals.decide(a["id"], "deny", "policy", "restart", "NightShift restarted while waiting; the step will be retried")
        cancel_sessions(row["id"])
        db.q("update stages set status='interrupted', ended_at=now() where incident_id=%s and status in ('running','waiting_approval')", row["id"])
        threading.Thread(target=Pipeline(row["id"]).run, kwargs={"resume": True}, daemon=True, name=f"pipeline-{row['id']}").start()
