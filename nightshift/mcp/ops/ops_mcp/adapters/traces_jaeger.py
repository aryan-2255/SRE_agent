"""Traces adapter for Jaeger's v3 API (OTLP JSON)."""
from datetime import datetime, timedelta, timezone

import httpx

_KEEP_ATTR_PREFIXES = ("demo.", "http.", "rpc.", "error", "exception", "db.", "server.address", "user_agent")


def _val(v: dict):
    return next(iter(v.values())) if v else None


def _iso(ns: int) -> str:
    return datetime.fromtimestamp(ns / 1e9, timezone.utc).isoformat(timespec="milliseconds")


class JaegerTraces:
    def __init__(self, url: str, ui: str):
        self.url = url.rstrip("/")
        self.ui = ui.rstrip("/")

    def link(self, trace_id: str) -> str:
        return f"{self.ui}/trace/{trace_id}"

    def _spans(self, resource_spans: list[dict]) -> list[dict]:
        spans = []
        for rs in resource_spans:
            attrs = {a["key"]: _val(a["value"]) for a in rs.get("resource", {}).get("attributes", [])}
            svc = attrs.get("service.name", "?")
            for ss in rs.get("scopeSpans", []):
                for s in ss.get("spans", []):
                    sattrs = {a["key"]: _val(a["value"]) for a in s.get("attributes", [])}
                    status = s.get("status", {}) or {}
                    events = [
                        {e["name"]: {a["key"]: _val(a["value"]) for a in e.get("attributes", [])}}
                        for e in s.get("events", [])
                        if e.get("name") == "exception"
                    ]
                    spans.append(
                        {
                            "trace_id": s["traceId"],
                            "service": svc,
                            "operation": s["name"],
                            "start_ns": int(s["startTimeUnixNano"]),
                            "ms": round((int(s["endTimeUnixNano"]) - int(s["startTimeUnixNano"])) / 1e6, 1),
                            "error": status.get("code") == "STATUS_CODE_ERROR",
                            "status_message": status.get("message"),
                            "attributes": {k: v for k, v in sattrs.items() if k.startswith(_KEEP_ATTR_PREFIXES)},
                            "exceptions": events,
                            "synthetic": sattrs.get("user_agent.synthetic.type") == "test",
                        }
                    )
        return spans

    def _search(self, service: str, minutes: int, depth: int, operation: str = "") -> list[dict]:
        now = datetime.now(timezone.utc)
        params = {
            "query.service_name": service,
            "query.start_time_min": (now - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "query.start_time_max": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "query.search_depth": depth,
        }
        if operation:
            params["query.operation_name"] = operation
        r = httpx.get(f"{self.url}/traces", params=params, timeout=30)
        if r.status_code == 404:
            return []
        r.raise_for_status()
        return self._spans(r.json().get("result", {}).get("resourceSpans", []))

    def search(self, service: str, minutes: int = 15, errors_only: bool = True, limit: int = 5,
               real_users_only: bool = False) -> list[dict]:
        """Summaries of recent traces through `service`, failing ones first."""
        by_trace: dict[str, list[dict]] = {}
        for s in self._search(service, minutes, depth=max(limit * 8, 40)):
            by_trace.setdefault(s["trace_id"], []).append(s)
        out = []
        for tid, spans in by_trace.items():
            spans.sort(key=lambda s: s["start_ns"])
            services = {s["service"] for s in spans}
            real_user = "load-generator" not in services and not any(s["synthetic"] for s in spans)
            if real_users_only and not real_user:
                continue
            failing = [s for s in spans if s["error"]]
            if errors_only and not failing:
                continue
            root = spans[0]
            first_fail = failing[0] if failing else None
            out.append(
                {
                    "trace_id": tid,
                    "link": self.link(tid),
                    "start": _iso(root["start_ns"]),
                    "root": f'{root["service"]} {root["operation"]}',
                    "duration_ms": round((max(s["start_ns"] + s["ms"] * 1e6 for s in spans) - root["start_ns"]) / 1e6, 1),
                    "steps": len(spans),
                    "real_user": real_user,
                    "failing_step": (
                        {
                            "service": first_fail["service"],
                            "operation": first_fail["operation"],
                            "message": first_fail["status_message"],
                            "exceptions": first_fail["exceptions"],
                        }
                        if first_fail
                        else None
                    ),
                }
            )
        out.sort(key=lambda t: t["start"], reverse=True)
        out.sort(key=lambda t: t["failing_step"] is None)  # failing first, newest first within each group
        return out[: max(1, int(limit))]

    def get(self, trace_id: str) -> dict:
        r = httpx.get(f"{self.url}/traces/{trace_id}", timeout=30)
        r.raise_for_status()
        spans = sorted(self._spans(r.json().get("result", {}).get("resourceSpans", [])), key=lambda s: s["start_ns"])
        if not spans:
            return {"trace_id": trace_id, "steps": []}
        t0 = spans[0]["start_ns"]
        steps = [
            {
                "at_ms": round((s["start_ns"] - t0) / 1e6, 1),
                "ms": s["ms"],
                "service": s["service"],
                "operation": s["operation"],
                "error": s["error"],
                "message": s["status_message"],
                "attributes": s["attributes"],
                "exceptions": s["exceptions"],
            }
            for s in spans
        ]
        return {"trace_id": trace_id, "link": self.link(trace_id), "start": _iso(t0), "steps": steps}
