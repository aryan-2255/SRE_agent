"""Logs adapter for OpenSearch (OpenTelemetry log documents)."""
import httpx


class OpenSearchLogs:
    def __init__(self, url: str, index: str, service_field: str):
        self.url = url.rstrip("/")
        self.index = index
        self.service_field = service_field

    def query(self, service: str, minutes: int = 15, contains: str = "", level: str = "", limit: int = 50) -> list[dict]:
        must: list[dict] = [{"range": {"@timestamp": {"gte": f"now-{int(minutes)}m"}}}]
        if service:
            must.append({"term": {self.service_field: service}})
        if contains:
            must.append({"match_phrase": {"body": contains}})
        if level:
            must.append({"match": {"severity.text": level}})
        body = {
            "size": max(1, min(int(limit), 200)),
            "sort": [{"@timestamp": "desc"}],
            "query": {"bool": {"must": must}},
            "_source": ["@timestamp", "body", "severity.text", "traceId", "resource.service.name", "attributes"],
        }
        r = httpx.post(f"{self.url}/{self.index}/_search", json=body, timeout=20)
        r.raise_for_status()
        rows = []
        for hit in r.json()["hits"]["hits"]:
            s = hit["_source"]
            rows.append(
                {
                    "time": s.get("@timestamp"),
                    "service": (s.get("resource") or {}).get("service", {}).get("name") or service,
                    "level": (s.get("severity") or {}).get("text"),
                    "message": s.get("body"),
                    "trace_id": s.get("traceId"),
                    "attributes": {k: v for k, v in (s.get("attributes") or {}).items() if k != "data_stream"},
                }
            )
        return rows

    def count_by_level(self, service: str, minutes: int = 15) -> dict[str, int]:
        body = {
            "size": 0,
            "query": {"bool": {"must": [
                {"range": {"@timestamp": {"gte": f"now-{int(minutes)}m"}}},
                {"term": {self.service_field: service}},
            ]}},
            "aggs": {"lvl": {"terms": {"field": "severity.text.keyword", "size": 10}}},
        }
        r = httpx.post(f"{self.url}/{self.index}/_search", json=body, timeout=20)
        r.raise_for_status()
        return {b["key"]: b["doc_count"] for b in r.json().get("aggregations", {}).get("lvl", {}).get("buckets", [])}
