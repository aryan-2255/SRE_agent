"""The incident pipeline. Each stage is one TrueForge agent; this file decides the order, the loops and when to stop."""
import json
import logging
import threading
import traceback

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
            "system": {k: self.system[k] for k in ("name", "domain", "repo", "runtime", "services", "telemetry") if k in self.system},
            "previous": self.out,
            "attempt": attempt,
            **(extra or {}),
        }
        last_err = None
        for tries in range(2):  # one retry if the answer is not valid JSON or the call failed
            try:
                res = self.run_stage_impl.run(self.id, name, AGENTS[name], payload, self.auto)
                break
            except (StageError, ValueError, json.JSONDecodeError) as e:
                last_err = e
                payload["retry_reason"] = f"Previous attempt failed: {e}. Answer with only the JSON object."
                bus.publish("stage.retry", f"{name} retrying: {e}", self.id, name)
        else:
            db.q("update stages set status='failed', ended_at=now(), output=%s where incident_id=%s and name=%s and status in ('running','waiting_approval')",
                 {"error": str(last_err)}, self.id, name)
            bus.publish("stage.failed", f"{name} failed: {last_err}", self.id, name)
            raise Escalate(f"{name} failed twice: {last_err}")
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
    def run(self) -> None:
        try:
            self._run()
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
        code_path = cat in ("code", "unknown")
        reproduced = bool(self._ok("validation", "reproduced"))
        recovered = bool(self._ok("verify", "recovered")) and self._last("verify") > self._last("mitigation")
        tests_ok = bool(self._ok("test", "passed")) and self._last("test") > self._last("fix")
        review_ok = self._ok("review", "verdict") == "approve" and self._last("review") > self._last("fix")
        rules = {
            "diagnosis": True,
            "validation": "diagnosis" in self.out and code_path,
            "docs": "diagnosis" in self.out,
            "plan": "diagnosis" in self.out and (reproduced or not code_path),
            "mitigation": "plan" in self.out,
            "verify": self._last("mitigation") > self._last("verify"),
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

    def default_next(self, moves: dict) -> dict:
        """The plain rule-based choice. Used as the supervisor's hint and as the fallback."""
        cat = self.inc.get("category") or "unknown"
        if "diagnosis" not in self.out:
            return {"action": "run", "stage": "diagnosis"}
        if cat == "external" or self._ok("diagnosis", "external"):
            return {"action": "escalate", "reason": "Cause is outside our system. No changes made."}
        if cat in ("code", "unknown") and "validation" not in self.out and "validation" in moves:
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
        for stage in ("fix", "test", "pr", "review", "cicd"):
            if stage in moves:
                if stage == "fix" and "fix" in self.out and "test" in self.out and self._ok("test", "passed"):
                    continue
                return {"action": "run", "stage": stage}
        if "postmortem" in moves:
            return {"action": "run", "stage": "postmortem"}
        return {"action": "finish"}

    def _brief(self) -> dict:
        """What the supervisor sees: each agent's latest answer, trimmed."""
        keep = ("summary", "confidence", "real_incident", "category", "root_cause", "reproduced", "disproved_reason",
                "chosen", "fix_needed", "action_taken", "denied", "recovered", "passed", "failing_tests", "pr_url",
                "verdict", "comments", "promoted", "external", "suspect_commit")
        return {st: {k: v for k, v in (o or {}).items() if k in keep} for st, o in self.out.items()}

    def supervise(self, moves: dict, hint: dict) -> dict:
        if settings.STAGE_RUNNER == "fake" or not settings.SUPERVISOR:
            return {**hint, "reason": "rule-based order"}
        payload = {
            "incident": {k: self.inc.get(k) for k in ("id", "service", "severity", "category", "summary")},
            "latest_answers": self._brief(),
            "history": [{k: h[k] for k in ("step", "action", "stage", "reason") if k in h} for h in self.history[-12:]],
            "allowed_stages": moves,
            "rule_based_suggestion": hint,
            "steps_left": self.MAX_STEPS - len(self.history),
            "budget_left_usd": round(settings.INCIDENT_BUDGET_USD - self._cost(), 3),
        }
        try:
            res = self.run_stage_impl.run(self.id, "supervisor", "ns-supervisor", payload, self.auto)
            db.q("update incidents set total_cost_usd = total_cost_usd + %s where id=%s", res.cost_usd, self.id)
            return res.output
        except Exception as e:  # noqa: BLE001
            log.warning("supervisor failed, using rules: %s", e)
            return {**hint, "reason": f"supervisor unavailable ({e}); rule-based order"}

    def _valid(self, d: dict, moves: dict) -> str | None:
        """Return why a decision breaks the rules, or None if it is allowed."""
        act = d.get("action")
        if act in ("escalate", "finish"):
            if act == "finish" and not (self._ok("verify", "recovered") or self.inc.get("status") == "false_alarm"):
                return "cannot finish before the service is verified as recovered"
            return None
        if act not in ("run", "ask", "send_back"):
            return f"unknown action {act!r}"
        if d.get("stage") not in moves:
            return f"{d.get('stage')!r} is not allowed now"
        if act in ("ask", "send_back") and not d.get("message"):
            return "ask/send_back needs a message"
        return None

    def _run(self) -> None:
        self.history: list[dict] = []
        self.attempts: dict[str, int] = {}
        tri = self.stage("triage")
        self.attempts["triage"] = 1
        self.history.append({"step": 0, "action": "run", "stage": "triage", "done": True, "reason": "every incident starts with triage"})
        if not tri.get("real_incident", True):
            self.set(status="false_alarm", summary=tri.get("summary"))
            bus.publish("incident.closed", "False alarm: numbers are within normal variation. No action taken.", self.id)
            return
        self.set(severity=tri.get("severity"), category=tri.get("category"), service=tri.get("service") or self.inc["service"])

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
                        {"decision": d, "allowed": list(moves), "suggested": hint})

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
            lines.append(f"- [{e.get('source', '?')}] {e.get('text') or e.get('detail') or json.dumps(e)[:200]}"
                         + (f" {e['link']}" if e.get("link") else ""))
        lines += ["", "Options:"]
        for o in plan.get("options", []):
            lines.append(f"- {o.get('action')} (risk {o.get('risk')}, reversible: {o.get('reversible')}, blast radius: {o.get('blast_radius', 'n/a')})")
        lines += ["", f"Chosen: {plan.get('chosen')}", "",
                  "NightShift will ask here before each change. Reply /approve or /deny <reason>."]
        return "\n".join(lines)

    def escalate(self, reason: str) -> None:
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


def resume_unfinished() -> None:
    """After a restart, incidents that were mid-pipeline are escalated with a clear note (their sessions are gone)."""
    for row in db.q("select id from incidents where status='open'"):
        for a in approvals.pending(row["id"]):
            approvals.decide(a["id"], "deny", "policy", "restart", "NightShift restarted while waiting")
        Pipeline(row["id"]).escalate("NightShift restarted mid-incident; please review.")
