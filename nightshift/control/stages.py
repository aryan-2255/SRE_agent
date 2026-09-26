"""Runs one pipeline stage as one TrueForge session, and turns what the agent does into dashboard events."""
import json
import logging
import re
import time
from dataclasses import dataclass, field

from . import approvals, bus, db, jira, settings

log = logging.getLogger("stages")

# Tool outputs worth showing verbatim to people: this is how judges see what the agent actually read.
EVIDENCE_SOURCES = {
    "query_logs": "opensearch", "get_traces": "jaeger", "get_trace": "jaeger", "get_error_rates": "prometheus",
    "get_metrics": "prometheus", "get_recent_deploys": "git", "synthetic_check": "shop",
    "list_commits": "github", "get_commit": "github", "search_incidents": "knowledge", "blast_radius": "codegraph",
}


@dataclass
class StageResult:
    output: dict
    cost_usd: float = 0.0
    session_id: str | None = None
    tool_calls: list[dict] = field(default_factory=list)


class StageError(RuntimeError):
    def __init__(self, message: str, tool_calls: list[dict] | None = None):
        super().__init__(message)
        self.tool_calls = tool_calls or []  # what the failed attempt already did, so a retry can continue from there


def _dump(obj) -> dict:
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json", exclude_none=True)
    if hasattr(obj, "dict"):
        return obj.dict()
    return dict(obj)


def _tool_text(content) -> str:
    """Tool responses arrive as a string or a list of parts; our MCP servers wrap JSON in {"result": "..."}."""
    if isinstance(content, list):
        content = "\n".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    text = str(content or "")
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and set(parsed) == {"result"} and isinstance(parsed["result"], str):
            return parsed["result"]
    except (json.JSONDecodeError, TypeError):
        pass
    return text


_REASONING = re.compile(r"<(reasoning|think|thinking)>.*?(</\1>|$)", re.S)


def _parse_json(text: str) -> dict:
    # some models (MiniMax) put their reasoning in the answer text before the JSON
    text = _REASONING.sub("", text or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise ValueError("no JSON object in the agent's answer")
    return json.loads(text[start:end + 1])


def _short(v, n=600):
    s = v if isinstance(v, str) else json.dumps(v, default=str)
    return s if len(s) <= n else s[:n] + "…"


class TrueForgeRunner:
    def __init__(self):
        from trueforge_sdk import TrueForge

        self.client = TrueForge(base_url=settings.TRUEFORGE_BASE_URL, timeout=900)

    _models: dict[str, str] = {}

    def _model(self, agent: str) -> str:
        if agent not in self._models:
            for a in self.client.agents.list():
                d = _dump(a)
                self._models[d["name"]] = (d.get("manifest") or {}).get("model", {}).get("name", "")
        return self._models.get(agent, "")

    def run(self, incident_id: str, stage: str, agent: str, payload: dict, autonomy_auto: list[str]) -> StageResult:
        from trueforge_sdk.events import is_event_delta, merge_event_delta

        session = self.client.sessions.create(agent={"name": agent}, metadata={"incident": incident_id, "stage": stage})
        sid = session.data.id
        db.q("update stages set trueforge_session_id=%s where incident_id=%s and name=%s and status='running'",
             sid, incident_id, stage)
        bus.publish("stage.session", f"{agent} session started", incident_id, stage,
                    {"session_id": sid, "agent": agent, "url": f"{settings.TRUEFORGE_BASE_URL}/sessions/{sid}"})

        turn_input: list[dict] = [{"type": "user.message", "content": json.dumps(payload, default=str)}]
        total_cost, calls = 0.0, []
        tool_names: dict[str, str] = {}
        reported: set[str] = set()
        tool_calls_by_id: dict[str, object] = {}
        for _ in range(12):  # each loop is one turn; approvals resume with a new turn
            index: dict[str, object] = {}
            done = None
            stream = self.client.sessions.create_turn_stream(session_id=sid, input=turn_input)
            for ev in stream:
                if is_event_delta(ev):
                    base = index.get(ev.id)
                    if base is not None:
                        merge_event_delta(base, ev)
                    continue
                index[ev.id] = ev
                kind = getattr(ev, "type", "")
                # Learn tool names first: they arrive through deltas, before their tool.response.
                for msg in list(index.values()):
                    if getattr(msg, "type", "") != "model.message" or not getattr(msg, "tool_calls", None):
                        continue
                    for tc in msg.tool_calls:
                        d = _dump(tc)
                        name = (d.get("tool_info") or {}).get("name") or d.get("function", {}).get("name")
                        if d.get("id") and name:
                            tool_names[d["id"]] = name
                            tool_calls_by_id[d["id"]] = tc
                if kind == "thread.created":
                    d = _dump(ev)
                    bus.publish("subagent", f"Sub-agent started: {d.get('title', '')}", incident_id, stage,
                                {"thread_id": d.get("thread_id"), "title": d.get("title")})
                elif kind == "tool.response":
                    d = _dump(ev)
                    call_id = d.get("tool_call_id", "")
                    name = tool_names.get(call_id, "tool")
                    if call_id not in reported:
                        reported.add(call_id)
                        args = _dump(tool_calls_by_id[call_id]).get("function", {}).get("arguments", "") if call_id in tool_calls_by_id else ""
                        bus.publish("tool.call", f"Called {name}", incident_id, stage, {"tool": name, "args": _short(args, 800)})
                    text = _tool_text(d.get("content"))
                    full_args = _dump(tool_calls_by_id[call_id]).get("function", {}).get("arguments", "") if call_id in tool_calls_by_id else ""
                    calls.append({"tool": name, "args": _short(full_args, 500), "result": _short(text, 2000)})
                    bus.publish("tool.result", f"{name} returned", incident_id, stage,
                                {"tool": name, "result": _short(text, 1500)})
                    if name in EVIDENCE_SOURCES:
                        try:
                            items = json.loads(text)
                        except json.JSONDecodeError:
                            items = text
                        bus.publish("evidence", f"Read {EVIDENCE_SOURCES[name]} via {name}", incident_id, stage,
                                    {"source": EVIDENCE_SOURCES[name], "tool": name, "items": items})
                elif kind == "sandbox.created":
                    bus.publish("sandbox", "Sandbox started for this agent", incident_id, stage, _dump(ev))
                elif kind == "turn.done":
                    done = ev

            if done is None:
                raise StageError("TrueForge stream ended without turn.done", calls)
            state = _dump(done).get("state", {})
            m = state.get("metrics") or {}
            reported_cost = float(m.get("total_cost_in_usd") or 0)
            total_cost += reported_cost or settings.estimate_cost(
                self._model(agent), int(m.get("total_input_tokens") or 0), int(m.get("total_output_tokens") or 0))
            if state.get("status") != "done":
                raise StageError(f"turn {state.get('status')}: {state.get('message') or state.get('reason')}", calls)

            required = state.get("required_actions") or []
            if not required:
                output = state.get("output") or {}
                return StageResult(_parse_json(output.get("content", "")), total_cost, sid, calls)

            # The agent paused. Ask a human (or policy) for each pending call, then resume.
            turn_input = []
            for action in required:
                if action.get("type") == "mcp.auth_required":
                    raise StageError(f"MCP server needs login: {[s.get('name') for s in action.get('mcp_servers', [])]}")
                for ref in action.get("tool_calls", []):
                    src = index.get(ref.get("source_event_id"))
                    tc = next((t for t in (getattr(src, "tool_calls", None) or []) if t.id == ref["id"]), None)
                    d = _dump(tc) if tc else {}
                    tool = (d.get("tool_info") or {}).get("name") or d.get("function", {}).get("name", "?")
                    try:
                        args = json.loads(d.get("function", {}).get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {"raw": d.get("function", {}).get("arguments")}
                    thread_id = action.get("thread_id", "main")
                    if action.get("type") == "tool.response_required":
                        # ask_user_question: route it as an approval with the question in args
                        a = approvals.request(incident_id, stage, tool, args, thread_id, ref["id"], sid)
                        decided = approvals.wait(a["id"])
                        turn_input.append({"type": "user.tool_response", "thread_id": thread_id, "tool_call_id": ref["id"],
                                           "content": decided.get("reason") or decided["status"]})
                        continue
                    a = approvals.request(incident_id, stage, tool, args, thread_id, ref["id"], sid)
                    inc = db.one("select jira_key from incidents where id=%s", incident_id)
                    jira.comment(inc and inc["jira_key"],
                                 f"Approval needed: {tool}\nArguments: {json.dumps(args)}\n"
                                 f"Undo: {approvals.UNDO_HINTS.get(tool, 'see NightShift dashboard')}\n"
                                 "Reply /approve or /deny <reason>.")
                    if tool in autonomy_auto:
                        approvals.decide(a["id"], "approve", "policy", "autonomy policy")
                    db.q("update stages set status='waiting_approval' where incident_id=%s and name=%s and status='running'",
                         incident_id, stage)
                    decided = approvals.wait(a["id"])
                    db.q("update stages set status='running' where incident_id=%s and name=%s and status='waiting_approval'",
                         incident_id, stage)
                    approval = {"status": "allow"} if decided["status"] == "approved" else \
                        {"status": "deny", "reason": decided.get("reason") or "denied by the on-call engineer"}
                    turn_input.append({"type": "user.tool_approval", "thread_id": thread_id,
                                       "tool_call_id": ref["id"], "approval": approval})
        raise StageError("too many approval rounds")


class FakeRunner:
    """Canned outputs, so the pipeline and dashboard can be built without models."""

    CANNED = {
        "triage": {"summary": "Payment errors at 62%, a code regression is likely.", "confidence": 0.8,
                   "real_incident": True, "severity": "P1", "service": "payment", "category": "code", "route": "full"},
        "diagnosis": {"summary": "Commit a1b2c3 made amount validation reject fractional amounts.", "confidence": 0.82,
                      "root_cause": "validateAmount throws on non-integer amounts",
                      "evidence": [{"source": "opensearch", "text": "Error: Invalid amount"}],
                      "suspect_commit": "a1b2c3", "suspect_files": ["src/payment/charge.js"]},
        "validation": {"summary": "Reproduced with a failing test.", "confidence": 0.9, "reproduced": True,
                       "test_file": "src/payment/charge.test.js", "run_output": "1 failing"},
        "plan": {"summary": "Roll back payment now, then fix the validation.", "confidence": 0.85,
                 "options": [{"action": "rollback payment", "risk": "low", "reversible": True}],
                 "chosen": "rollback payment", "mitigation": {"tool": "rollback", "args": {"service": "payment"}},
                 "fix_needed": True},
        "mitigation": {"summary": "Rolled back payment.", "confidence": 0.9, "action_taken": "rollback", "result": "ok"},
        "verify": {"summary": "Error rate back to 0%.", "confidence": 0.9, "recovered": True},
        "fix": {"summary": "Allow fractional amounts again.", "confidence": 0.8, "patch": "--- a\n+++ b\n"},
        "test": {"summary": "All tests pass.", "confidence": 0.9, "passed": True},
        "pr": {"summary": "Opened PR #1.", "confidence": 0.9, "pr_url": "https://github.com/example/pr/1"},
        "review": {"summary": "Looks correct.", "confidence": 0.8, "verdict": "approve"},
        "cicd": {"summary": "Merged and promoted.", "confidence": 0.8, "ci_passed": True, "canary_ok": True, "promoted": True},
        "postmortem": {"summary": "Postmortem written.", "confidence": 0.9, "postmortem_md": "# Postmortem"},
    }

    def run(self, incident_id, stage, agent, payload, autonomy_auto) -> StageResult:
        bus.publish("tool.call", f"(fake) {agent} thinking", incident_id, stage, {"tool": "fake"})
        time.sleep(1.5)
        out = dict(self.CANNED.get(stage, {"summary": "ok", "confidence": 1.0}))
        if stage == "mitigation":  # exercise the real approval path
            a = approvals.request(incident_id, stage, "rollback", {"service": "payment"}, "main", "fake-call", "fake")
            db.q("update stages set status='waiting_approval' where incident_id=%s and name=%s and status='running'", incident_id, stage)
            decided = approvals.wait(a["id"])
            db.q("update stages set status='running' where incident_id=%s and name=%s", incident_id, stage)
            if decided["status"] != "approved":
                out.update(summary="Rollback denied; no change made.", denied=True, action_taken="none")
        return StageResult(out, 0.001, None, [])


def runner():
    return FakeRunner() if settings.STAGE_RUNNER == "fake" else TrueForgeRunner()
