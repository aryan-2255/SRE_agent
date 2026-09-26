"""The safety rules, tested without models, TrueForge or a database.  Run: .venv/bin/python -m pytest -q tests"""
import pytest

from control import orchestrator, watcher
from control.orchestrator import Pipeline, check_evidence, unbacked_claim
from control.stages import unwrap_tool

SYSTEM = {"services": {"payment": {"slo": {"max_error_pct": 5}}, "checkout": {"slo": {"max_error_pct": 5}, "depends_on": ["payment"]}},
          "telemetry": {"metrics": {"error_metric": "m"}}}


def pipeline(out=None, history=(), category="code", live=None, monkeypatch=None):
    p = object.__new__(Pipeline)
    p.id, p.system, p.auto = "INC-T", SYSTEM, []
    p.inc = {"service": "payment", "category": category, "status": "open"}
    p.out = dict(out or {})
    p.history = [{"step": i, "stage": s, "done": True} for i, s in enumerate(history)]
    p.attempts = {}
    for s in history:
        p.attempts[s] = p.attempts.get(s, 0) + 1
    p.stage_ended = {}
    if monkeypatch:
        monkeypatch.setattr(orchestrator, "live_error", lambda svc, window="30s": live)
    return p


CODE_OK = {"triage": {"confidence": 0.9}, "diagnosis": {"confidence": 0.9}, "validation": {"reproduced": True, "confidence": 0.9},
           "plan": {"confidence": 0.9, "fix_needed": True, "options": [{"action": "rollback"}, {"action": "restart", "speculative": True}]},
           "mitigation": {"confidence": 0.9}}


# ---------- watcher ----------
def test_one_bad_request_does_not_count():
    assert watcher.classify({"rps": 0.02, "error_pct": 50}, 5, 120, 3) == "quiet"


def test_sustained_failures_count_even_with_little_traffic():
    assert watcher.classify({"rps": 0.03, "error_pct": 100}, 5, 120, 3) == "over"


def test_healthy_and_silent():
    assert watcher.classify({"rps": 2, "error_pct": 1}, 5, 120, 3) == "ok"
    assert watcher.classify({"rps": 0, "error_pct": 0}, 5, 120, 3) == "quiet"


def test_quiet_pauses_the_timer_instead_of_resetting():
    since = {}
    assert watcher.tick_timer(since, "payment", "over", 100, 5) == 0
    assert watcher.tick_timer(since, "payment", "over", 120, 20) == 20
    assert watcher.tick_timer(since, "payment", "quiet", 140, 20) == 20   # paused, not reset
    assert watcher.tick_timer(since, "payment", "over", 150, 10) == 30
    assert watcher.tick_timer(since, "payment", "ok", 160, 10) == 0      # healthy resets


# ---------- orchestrator ----------
def test_cannot_finish_before_recovery(monkeypatch):
    p = pipeline(CODE_OK, ["triage", "diagnosis", "validation", "plan", "mitigation"], monkeypatch=monkeypatch)
    assert "recovered" in p._valid({"action": "finish"}, p.allowed_moves())


def test_cannot_finish_with_an_unshipped_fix(monkeypatch):
    out = {**CODE_OK, "verify": {"recovered": True}, "fix": {"confidence": 0.9}}
    p = pipeline(out, ["triage", "diagnosis", "validation", "plan", "mitigation", "verify", "fix"], monkeypatch=monkeypatch)
    assert "not shipped" in p._valid({"action": "finish"}, p.allowed_moves())


def test_cicd_needs_passing_tests_and_approving_review(monkeypatch):
    out = {**CODE_OK, "verify": {"recovered": True}, "fix": {}, "test": {"passed": True}, "pr": {"pr_url": "u"},
           "review": {"verdict": "changes"}}
    p = pipeline(out, ["triage", "diagnosis", "validation", "plan", "mitigation", "verify", "fix", "test", "pr", "review"],
                 monkeypatch=monkeypatch)
    assert "cicd" not in p.allowed_moves()
    nxt = p.default_next(p.allowed_moves())
    assert nxt["action"] == "send_back" and nxt["stage"] == "fix"


def test_no_second_change_while_live_numbers_are_healthy(monkeypatch):
    out = {**CODE_OK, "verify": {"recovered": False}}
    p = pipeline(out, ["triage", "diagnosis", "validation", "plan", "mitigation", "verify"],
                 live={"rps": 0.5, "error_pct": 0.0, "window": "30s"}, monkeypatch=monkeypatch)
    nxt = p.default_next(p.allowed_moves())
    assert nxt == {**nxt, "action": "run", "stage": "verify"}


def test_speculative_next_option_goes_to_a_person(monkeypatch):
    out = {**CODE_OK, "verify": {"recovered": False}}
    p = pipeline(out, ["triage", "diagnosis", "validation", "plan", "mitigation", "verify"],
                 live={"rps": 0.5, "error_pct": 60.0, "window": "30s"}, monkeypatch=monkeypatch)
    assert p.default_next(p.allowed_moves())["action"] == "escalate"


def test_supervisor_only_asked_when_there_is_a_choice(monkeypatch):
    p = pipeline(CODE_OK, ["triage", "diagnosis"], monkeypatch=monkeypatch)
    assert p.needs_judgement({"validation": ""}, {"action": "run", "stage": "validation"}) is None
    p.out["diagnosis"] = {"confidence": 0.4}
    assert "unsure" in p.needs_judgement({"validation": "", "docs": ""}, {"action": "run", "stage": "validation"})


# ---------- claims, evidence, approvals ----------
def test_pr_url_must_come_from_create_pull_request():
    assert "never called" in unbacked_claim("pr", {"pr_url": "https://x/pull/1"}, [{"tool": "push_files", "result": "ok"}])
    assert unbacked_claim("pr", {"pr_url": "https://x/pull/1"},
                          [{"tool": "create_pull_request", "result": '{"html_url":"https://x/pull/1"}'}]) is None


def test_invented_evidence_is_flagged():
    corpus = orchestrator._norm('{"msg": "Error: Invalid amount: fractional value 520000000 nanos"}')
    ev = check_evidence([{"text": "Error: Invalid amount: fractional value 520000000 nanos"},
                         {"text": "payment ran out of memory while starting up"}], corpus)
    assert [e["verified"] for e in ev] == [True, False]


@pytest.mark.parametrize("name,args,expected", [
    ("call_tool", {"tool_name": "rollback", "input": {"service": "payment"}, "mcp_server": "nightshift-ops"},
     ("rollback", {"service": "payment"})),
    ("call_tool", '{"tool_name": "set_flag", "input": {"flag": "paymentFailure", "variant": "off"}}',
     ("set_flag", {"flag": "paymentFailure", "variant": "off"})),
    ("rollback", '{"service": "payment"}', ("rollback", {"service": "payment"})),
])
def test_approvals_show_the_real_tool(name, args, expected):
    assert unwrap_tool(name, args) == expected


def test_evidence_describing_real_output_counts():
    corpus = orchestrator._norm('{"kafkaQueueProblems": {"value": "off", "options": ["off","on"]}, "paymentFailure": {"value": "off"}}')
    ev = check_evidence([{"text": 'get_flags shows every switch off, e.g. "kafkaQueueProblems": {"value": "off"}'}], corpus)
    assert ev[0]["verified"]


def test_supervisor_asks_about_unverified_evidence_only_once(monkeypatch):
    p = pipeline({**CODE_OK, "diagnosis": {"confidence": 0.9, "unverified_evidence": 2}}, ["triage", "diagnosis"], monkeypatch=monkeypatch)
    assert p.needs_judgement({"validation": "", "docs": ""}, {"action": "run", "stage": "validation"})
    p.history.append({"step": 2, "action": "ask", "stage": "diagnosis", "done": True})
    assert p.needs_judgement({"validation": "", "docs": ""}, {"action": "run", "stage": "validation"}) is None


def test_no_sandbox_validation_without_a_suspect_change(monkeypatch):
    p = pipeline({"triage": {}, "diagnosis": {"confidence": 0.9}}, ["triage", "diagnosis"], category="unknown", monkeypatch=monkeypatch)
    assert "validation" not in p.allowed_moves() and "plan" in p.allowed_moves()
    p.out["diagnosis"]["suspect_commit"] = "2bf06ff0"
    assert "validation" in p.allowed_moves() and "plan" not in p.allowed_moves()


def test_unrunnable_language_can_still_be_planned(monkeypatch):
    out = {"triage": {}, "diagnosis": {"suspect_files": ["src/ad/AdService.java"]}, "validation": {"reproduced": False, "runnable": False}}
    p = pipeline(out, ["triage", "diagnosis", "validation"], category="code", monkeypatch=monkeypatch)
    assert "plan" in p.allowed_moves() and "fix" not in p.allowed_moves()


def test_code_path_runs_in_order_without_the_supervisor(monkeypatch):
    base = {**CODE_OK, "verify": {"recovered": True}}
    steps = ["triage", "diagnosis", "validation", "plan", "mitigation", "verify"]
    p = pipeline(base, steps, monkeypatch=monkeypatch)
    assert p.default_next(p.allowed_moves())["stage"] == "fix"
    p = pipeline({**base, "fix": {}}, steps + ["fix"], monkeypatch=monkeypatch)
    assert p.default_next(p.allowed_moves())["stage"] == "test"
    p = pipeline({**base, "fix": {}, "test": {"passed": False}}, steps + ["fix", "test"], monkeypatch=monkeypatch)
    assert p.default_next(p.allowed_moves())["stage"] == "fix"
    p = pipeline({**base, "fix": {}, "test": {"passed": True}}, steps + ["fix", "test"], monkeypatch=monkeypatch)
    assert p.default_next(p.allowed_moves())["stage"] == "pr"
    p = pipeline({**base, "fix": {}, "test": {"passed": True}, "pr": {"pr_url": "u"}}, steps + ["fix", "test", "pr"], monkeypatch=monkeypatch)
    assert p.default_next(p.allowed_moves())["stage"] == "review"
    p = pipeline({**base, "fix": {}, "test": {"passed": True}, "pr": {"pr_url": "u"}, "review": {"verdict": "approve"}},
                 steps + ["fix", "test", "pr", "review"], monkeypatch=monkeypatch)
    assert p.default_next(p.allowed_moves())["stage"] == "cicd"


def test_the_server_decides_who_approves(monkeypatch):
    from starlette.requests import Request
    from fastapi import HTTPException
    from control import app, settings

    def req(host, token=""):
        headers = [(b"authorization", f"Bearer {token}".encode())] if token else []
        return Request({"type": "http", "client": (host, 1), "headers": headers})

    monkeypatch.setattr(settings, "DASHBOARD_USERS", {})
    assert app.who(req("127.0.0.1")) == "local operator"
    with pytest.raises(HTTPException):
        app.who(req("192.168.1.20"))
    monkeypatch.setattr(settings, "DASHBOARD_USERS", {"s3cret": "aryan"})
    assert app.who(req("192.168.1.20", "s3cret")) == "aryan"
    with pytest.raises(HTTPException):
        app.who(req("127.0.0.1"))            # with users configured, even this machine must sign in
    with pytest.raises(HTTPException):
        app.who(req("127.0.0.1", "guess"))


def test_false_alarm_needs_live_confirmation(monkeypatch):
    p = pipeline({}, [], monkeypatch=monkeypatch, live={"rps": 0.03, "error_pct": 73.8, "window": "2m"})
    p.system = {**SYSTEM, "watch": {"window": "2m"}}
    assert "73.8%" in p._still_failing("payment")
    monkeypatch.setattr(orchestrator, "live_error", lambda svc, window="30s": {"rps": 0.5, "error_pct": 0.0, "window": window})
    assert p._still_failing("payment") is None
    monkeypatch.setattr(orchestrator, "live_error", lambda svc, window="30s": {"rps": 0.0, "error_pct": 0.0, "window": window})
    assert p._still_failing("payment") is None   # no data is not "still failing" either; triage decides then
