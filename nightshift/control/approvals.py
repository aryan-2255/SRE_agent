"""Human approvals: one row per paused tool call, decided from Jira, the dashboard, or policy."""
import threading

from . import bus, db

_waiters: dict[int, threading.Event] = {}

UNDO_HINTS = {
    "rollback": "Roll forward again with deploy, or roll back to another commit.",
    "deploy": "rollback returns to the previous image in seconds.",
    "deploy_canary": "abort_canary sends all traffic back to the current version.",
    "promote_canary": "rollback returns to the previous image.",
    "restart_service": "A restart is not reversible, but it changes no code or data.",
    "scale_service": "scale_service back to 1.",
    "set_flag": "set_flag back to the old value (shown in the result).",
    "create_pull_request": "Close the pull request.",
    "merge_pull_request": "Revert the merge commit, then rollback.",
    "push_files": "Delete the branch.",
    "notify": "Messages cannot be unsent.",
}


def request(incident_id: str, stage: str, tool: str, args: dict, thread_id: str, tool_call_id: str,
            session_id: str) -> dict:
    row = db.one(
        "insert into approvals(incident_id, stage, tool, args, thread_id, tool_call_id, session_id) "
        "values (%s,%s,%s,%s,%s,%s,%s) returning *",
        incident_id, stage, tool, args, thread_id, tool_call_id, session_id,
    )
    _waiters[row["id"]] = threading.Event()
    bus.publish("approval.requested", f"Waiting for approval: {tool}", incident_id, stage,
                {"approval_id": row["id"], "tool": tool, "args": args, "undo": UNDO_HINTS.get(tool, "")})
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
    bus.publish("approval.decided", f"{row['tool']} {status} via {via}" + (f": {reason}" if reason else ""),
                row["incident_id"], row["stage"], {"approval_id": approval_id, "status": status, "via": via, "by": by})
    ev = _waiters.get(approval_id)
    if ev:
        ev.set()
    return row


def wait(approval_id: int, timeout: float | None = None) -> dict:
    ev = _waiters.setdefault(approval_id, threading.Event())
    ev.wait(timeout)
    return db.one("select * from approvals where id=%s", approval_id)


def pending(incident_id: str) -> list[dict]:
    return db.q("select * from approvals where incident_id=%s and status='pending' order by id", incident_id)
