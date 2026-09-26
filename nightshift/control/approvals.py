"""Human approvals: one row per paused tool call, decided from Jira, the dashboard, or policy.

Each request carries context for the person deciding: the live error rate right now, what the planner said about
this option (risk, blast radius, evidence or a guess), and the diagnosis in one line. Nobody answering is also an
answer: after a reminder, an approval expires as denied, and the supervisor escalates.
"""
import json
import logging
import threading

from . import bus, db, settings

log = logging.getLogger("approvals")
_waiters: dict[int, threading.Event] = {}

UNDO_HINTS = {
    "rollback": "Roll forward again with deploy, or roll back to another commit.",
    "deploy": "rollback returns to the previous image in seconds.",
    "deploy_canary": "abort_canary sends all traffic back to the current version.",
    "promote_canary": "rollback returns to the previous image.",
    "restart_service": "A restart is not reversible, but it changes no code or data.",
    "scale_service": "scale_service back to 1.",
    "set_flag": "set_flag back to the old value (shown in the result).",
    "create_branch": "Delete the branch.",
    "create_pull_request": "Close the pull request.",
    "merge_pull_request": "Revert the merge commit, then rollback.",
    "push_files": "Delete the branch.",
    "notify": "Messages cannot be unsent.",
}


def _live(service: str) -> dict | None:
    from . import watcher  # lazy: watcher imports the orchestrator, which imports this module

    t = (watcher.latest.get("services") or {}).get(service)
    return {k: t.get(k) for k in ("error_pct", "rps", "failed_requests", "limit_pct", "state")} if t else None


def context_for(incident_id: str, stage: str, tool: str, args: dict, payload: dict | None) -> dict:
    """What a person needs to see next to 'Approve rollback?'."""
    inc = db.one("select service, severity from incidents where id=%s", incident_id) or {}
    prev = (payload or {}).get("previous") or {}
    service = args.get("service") or inc.get("service")
    ctx = {"service": service, "severity": inc.get("severity"), "live": _live(service) if service else None,
           "diagnosis": ((prev.get("diagnosis") or {}).get("summary") or "")[:300], "undo": UNDO_HINTS.get(tool, "")}
    # the planner's words about this exact change, if it planned one
    for opt in (prev.get("plan") or {}).get("options") or []:
        if not isinstance(opt, dict):
            continue
        blob = json.dumps(opt).lower()
        if tool.lower() in blob and (not service or service.lower() in blob):
            ctx["plan_option"] = {k: opt.get(k) for k in ("action", "risk", "reversible", "blast_radius", "evidence", "speculative")}
            break
    return ctx


def describe(tool: str, args: dict, ctx: dict | None) -> str:
    ctx = ctx or {}
    lines = [f"Approval needed: {tool}", f"Arguments: {json.dumps(args)[:600]}"]
    live = ctx.get("live")
    if live:
        lines.append(f"Right now: {ctx.get('service')} errors at {live.get('error_pct')}% "
                     f"({live.get('failed_requests')} failed requests, limit {live.get('limit_pct')}%)")
    opt = ctx.get("plan_option")
    if opt:
        lines.append(f"Plan: risk {opt.get('risk')}, reversible {opt.get('reversible')}, blast radius {opt.get('blast_radius')}"
                     + (" — SPECULATIVE (no direct evidence)" if opt.get("speculative") else ""))
        if opt.get("evidence"):
            lines.append(f"Evidence: {str(opt['evidence'])[:300]}")
    if ctx.get("diagnosis"):
        lines.append(f"Diagnosis: {ctx['diagnosis']}")
    if ctx.get("undo"):
        lines.append(f"Undo: {ctx['undo']}")
    return "\n".join(lines)


def request(incident_id: str, stage: str, tool: str, args: dict, thread_id: str, tool_call_id: str,
            session_id: str, context: dict | None = None) -> dict:
    row = db.one(
        "insert into approvals(incident_id, stage, tool, args, thread_id, tool_call_id, session_id, context) "
        "values (%s,%s,%s,%s,%s,%s,%s,%s) returning *",
        incident_id, stage, tool, args, thread_id, tool_call_id, session_id, context or {},
    )
    _waiters[row["id"]] = threading.Event()
    bus.publish("approval.requested", f"Waiting for approval: {tool}", incident_id, stage,
                {"approval_id": row["id"], "tool": tool, "args": args, "undo": UNDO_HINTS.get(tool, ""), "context": context or {}})
    return row


def decide(approval_id: int, decision: str, via: str, by: str = "", reason: str = "") -> dict | None:
    status = "approved" if decision in ("approve", "approved", "allow") else "denied"
    row = db.one(
        "update approvals set status=%s, decided_via=%s, decided_by=%s, reason=%s, decided_at=now() "
        "where id=%s and status='pending' returning *",
        status, via, by, reason, approval_id,
    )
    if not row:
        return None
    text = (f"{row['tool']} {status} automatically ({reason or by or 'policy'})" if via == "policy"
            else f"{by or 'Someone'} {status} {row['tool']} on {via}" + (f": {reason}" if reason else ""))
    bus.publish("approval.decided", text,
                row["incident_id"], row["stage"], {"approval_id": approval_id, "status": status, "via": via, "by": by})
    ev = _waiters.get(approval_id)
    if ev:
        ev.set()
    return row


def wait(approval_id: int, timeout: float | None = None) -> dict:
    ev = _waiters.setdefault(approval_id, threading.Event())
    ev.wait(timeout)
    return db.one("select * from approvals where id=%s", approval_id)


def wait_or_expire(approval_id: int, jira_key: str | None) -> dict:
    """Wait for a person; remind once, then expire as denied so the incident never hangs on a sleeping on-call."""
    from . import jira

    remind_s, expire_s = settings.APPROVAL_REMIND_MIN * 60, settings.APPROVAL_TIMEOUT_MIN * 60
    row = wait(approval_id, remind_s)
    if row["status"] == "pending":
        msg = f"Reminder: still waiting for approval of {row['tool']} ({row['incident_id']}). It expires in {int((expire_s - remind_s) / 60)} min."
        bus.publish("approval.reminder", msg, row["incident_id"], row["stage"], {"approval_id": approval_id})
        jira.comment(jira_key, msg)
        row = wait(approval_id, max(expire_s - remind_s, 1))
    if row["status"] == "pending":
        decide(approval_id, "deny", "policy", "timeout", f"No answer within {settings.APPROVAL_TIMEOUT_MIN} minutes")
        row = db.one("select * from approvals where id=%s", approval_id)
    return row


def pending(incident_id: str) -> list[dict]:
    return db.q("select * from approvals where incident_id=%s and status='pending' order by id", incident_id)
