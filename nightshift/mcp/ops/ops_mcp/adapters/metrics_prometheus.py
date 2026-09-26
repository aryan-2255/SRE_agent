"""Metrics adapter for Prometheus with OpenTelemetry span metrics."""
import httpx


class PrometheusMetrics:
    def __init__(self, url: str, error_metric: str, duration_metric: str):
        self.url = url.rstrip("/")
        self.calls = error_metric
        self.duration = duration_metric

    def query(self, promql: str) -> list[dict]:
        r = httpx.get(f"{self.url}/api/v1/query", params={"query": promql}, timeout=15)
        r.raise_for_status()
        return r.json()["data"]["result"]

    def query_range(self, promql: str, minutes: int, step: str = "30s") -> list[dict]:
        import time

        end = time.time()
        r = httpx.get(
            f"{self.url}/api/v1/query_range",
            params={"query": promql, "start": end - minutes * 60, "end": end, "step": step},
            timeout=20,
        )
        r.raise_for_status()
        return r.json()["data"]["result"]

    def error_rates(self, window: str = "2m") -> dict[str, dict]:
        """Per service: requests/s, error % and p95 latency over the window (server-side spans)."""
        kind = 'span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER"'
        totals = self.query(f"sum by (service_name) (rate({self.calls}{{{kind}}}[{window}]))")
        errors = self.query(
            f'sum by (service_name) (rate({self.calls}{{{kind},status_code="STATUS_CODE_ERROR"}}[{window}]))'
        )
        p95 = self.query(
            f"histogram_quantile(0.95, sum by (service_name, le) (rate({self.duration}{{{kind}}}[{window}])))"
        )
        out: dict[str, dict] = {}
        for row in totals:
            svc = row["metric"].get("service_name", "?")
            out[svc] = {"rps": float(row["value"][1]), "error_pct": 0.0, "p95_ms": None}
        for row in errors:
            svc = row["metric"].get("service_name", "?")
            rps = out.get(svc, {}).get("rps") or 0.0
            if svc in out and rps > 0:
                out[svc]["error_pct"] = 100.0 * float(row["value"][1]) / rps
        for row in p95:
            svc = row["metric"].get("service_name", "?")
            v = row["value"][1]
            if svc in out and v not in ("NaN", "+Inf"):
                out[svc]["p95_ms"] = float(v)
        for v in out.values():
            v["rps"] = round(v["rps"], 3)
            v["error_pct"] = round(v["error_pct"], 2)
            v["p95_ms"] = round(v["p95_ms"], 1) if v["p95_ms"] is not None else None
        return dict(sorted(out.items()))
