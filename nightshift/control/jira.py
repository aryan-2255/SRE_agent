"""Jira Cloud bridge: one ticket per incident; approvals are answered with /approve or /deny comments."""
import logging
import threading
import time
from datetime import datetime

import httpx

from . import approvals, db, settings

log = logging.getLogger("jira")


def enabled() -> bool:
    return all(settings.env(k) for k in ("JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"))


def _client() -> httpx.Client:
    return httpx.Client(base_url=settings.env("JIRA_BASE_URL").rstrip("/") + "/rest/api/3",
                        auth=(settings.env("JIRA_EMAIL"), settings.env("JIRA_API_TOKEN")), timeout=20)


def _adf(text: str) -> dict:
    """Plain text to Atlassian Document Format, one paragraph per line."""
    content = [{"type": "paragraph", "content": [{"type": "text", "text": line}]} if line else {"type": "paragraph"}
               for line in text.splitlines()]
    return {"type": "doc", "version": 1, "content": content or [{"type": "paragraph"}]}


def browse_url(key: str) -> str:
    return f"{settings.env('JIRA_BASE_URL').rstrip('/')}/browse/{key}"


def create_ticket(incident_id: str, title: str, body: str) -> str | None:
    if not enabled():
        return None
    with _client() as c:
        r = c.post("/issue", json={"fields": {"project": {"key": settings.env("JIRA_PROJECT", "SRE")},
                                              "issuetype": {"name": "Task"}, "summary": title,
                                              "description": _adf(body), "labels": ["nightshift", incident_id]}})
        if r.status_code >= 300:
            log.warning("jira create failed: %s %s", r.status_code, r.text[:300])
            return None
        key = r.json()["key"]
    db.q("update incidents set jira_key=%s where id=%s", key, incident_id)
    return key


def comment(key: str | None, text: str) -> None:
    if not (enabled() and key):
        return
    with _client() as c:
        r = c.post(f"/issue/{key}/comment", json={"body": _adf(text)})
        if r.status_code >= 300:
            log.warning("jira comment failed: %s %s", r.status_code, r.text[:200])


def close(key: str | None) -> None:
    if not (enabled() and key):
        return
    with _client() as c:
        for t in c.get(f"/issue/{key}/transitions").json().get("transitions", []):
            if t.get("to", {}).get("statusCategory", {}).get("key") == "done":
                c.post(f"/issue/{key}/transitions", json={"transition": {"id": t["id"]}})
                return


def _text(adf: dict) -> str:
    out = []

    def walk(n):
        if isinstance(n, dict):
            if n.get("type") == "text":
                out.append(n.get("text", ""))
            for ch in n.get("content", []) or []:
                walk(ch)

    walk(adf)
    return " ".join(out).strip()


def _poll_once(seen: set[str]) -> None:
    rows = db.q("select distinct a.incident_id, i.jira_key from approvals a join incidents i on i.id=a.incident_id "
                "where a.status='pending' and i.jira_key is not null")
    if not rows:
        return
    with _client() as c:
        for row in rows:
            r = c.get(f"/issue/{row['jira_key']}/comment", params={"orderBy": "created", "maxResults": 50})
            for cm in r.json().get("comments", []):
                if cm["id"] in seen:
                    continue
                seen.add(cm["id"])
                text = _text(cm.get("body", {}))
                cmd = text.split()[0].lower() if text else ""
                if cmd not in ("/approve", "/deny"):
                    continue
                pend = approvals.pending(row["incident_id"])
                created = datetime.fromisoformat(cm["created"].replace("Z", "+00:00").replace("+0000", "+00:00"))
                # only a comment written after the request can answer it
                pend = [p for p in pend if created >= p["created_at"]]
                if not pend:
                    continue
                who = cm.get("author", {}).get("displayName", "jira user")
                reason = text[len(cmd):].strip()
                a = approvals.decide(pend[0]["id"], "approve" if cmd == "/approve" else "deny", "jira", who, reason)
                if a:
                    comment(row["jira_key"], f"NightShift: {a['tool']} {a['status']} by {who}. Continuing.")


def start_poller() -> None:
    if not enabled():
        log.info("Jira not configured; approvals come from the dashboard only.")
        return

    def loop():
        seen: set[str] = set()
        while True:
            try:
                _poll_once(seen)
            except Exception as e:  # noqa: BLE001
                log.warning("jira poll: %s", e)
            time.sleep(5)

    threading.Thread(target=loop, daemon=True, name="jira-poller").start()
