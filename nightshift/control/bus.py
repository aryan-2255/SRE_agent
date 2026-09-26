"""Event bus: every event is stored (so a page refresh can replay it) and pushed to live SSE listeners.

Publishing is thread-safe because stages run in worker threads.
"""
import asyncio
import json
import threading
from datetime import datetime, timezone

from . import db

_listeners: set[asyncio.Queue] = set()
_loop: asyncio.AbstractEventLoop | None = None
_lock = threading.Lock()


def attach_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=1000)
    _listeners.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _listeners.discard(q)


def _fanout(msg: dict) -> None:
    for q in list(_listeners):
        if q.full():
            continue
        q.put_nowait(msg)


def publish(kind: str, text: str = "", incident_id: str | None = None, stage: str | None = None,
            data: dict | None = None, store: bool = True) -> dict:
    msg = {"incident_id": incident_id, "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
           "stage": stage, "kind": kind, "text": text, "data": data or {}}
    if store:
        with _lock:
            row = db.one("insert into events(incident_id, stage, kind, text, data) values (%s,%s,%s,%s,%s) returning id",
                         incident_id, stage, kind, text, json.loads(json.dumps(data or {}, default=str)))
        msg["id"] = row["id"]
    if _loop:
        _loop.call_soon_threadsafe(_fanout, msg)
    return msg
