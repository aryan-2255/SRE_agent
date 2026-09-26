"""Smaller adapters: feature flags (flagd), read-only SQL, synthetic user, Slack."""
import json
import re
import secrets
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx


class FlagdFlags:
    """flagd watches its JSON file, so editing defaultVariant takes effect in seconds."""

    def __init__(self, file: Path, backup_dir: Path):
        self.file = file
        self.backup_dir = backup_dir

    def all(self) -> dict:
        flags = json.loads(self.file.read_text())["flags"]
        return {name: {"value": f["defaultVariant"], "options": list(f["variants"]), "description": f.get("description", "")}
                for name, f in flags.items()}

    def set(self, flag: str, variant: str) -> dict:
        data = json.loads(self.file.read_text())
        if flag not in data["flags"]:
            raise ValueError(f"Unknown flag {flag}. Known: {sorted(data['flags'])}")
        f = data["flags"][flag]
        if variant not in f["variants"]:
            raise ValueError(f"Unknown variant {variant} for {flag}. Options: {list(f['variants'])}")
        old = f["defaultVariant"]
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        backup = self.backup_dir / f"flagd-{datetime.now(timezone.utc):%Y%m%dT%H%M%S}.json"
        shutil.copy(self.file, backup)
        f["defaultVariant"] = variant
        self.file.write_text(json.dumps(data, indent=2) + "\n")
        return {"flag": flag, "old": old, "new": variant, "undo": f"set_flag('{flag}', '{old}')"}


class ReadOnlySQL:
    """SELECT-only access to the shop database through a read-only role."""

    _WRITE = re.compile(r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do)\b", re.I)

    def __init__(self, host: str, port: int, db: str, admin_user: str, admin_password: str, ro_password: str = ""):
        self.host, self.port, self.db = host, port, db
        self.admin = (admin_user, admin_password)
        # no fixed password in code: from .env, or a fresh random one each start (ensure_role sets it)
        self.role, self.password = "nightshift_ro", ro_password or secrets.token_hex(16)

    def ensure_role(self) -> None:
        import psycopg
        from psycopg import sql

        with psycopg.connect(host=self.host, port=self.port, dbname=self.db, user=self.admin[0],
                             password=self.admin[1], autocommit=True, connect_timeout=5) as c:
            if not c.execute("select 1 from pg_roles where rolname=%s", (self.role,)).fetchone():
                c.execute(f"create role {self.role} login")
            c.execute(sql.SQL("alter role {} password {}").format(sql.Identifier(self.role), sql.Literal(self.password)))
            c.execute(f"alter role {self.role} set default_transaction_read_only = on")
            c.execute(f"grant pg_read_all_data to {self.role}")

    def query(self, sql: str, limit: int = 100) -> dict:
        import psycopg

        if self._WRITE.search(sql) or ";" in sql.strip().rstrip(";"):
            raise ValueError("Only a single SELECT statement is allowed.")
        with psycopg.connect(host=self.host, port=self.port, dbname=self.db, user=self.role,
                             password=self.password, connect_timeout=5) as c:
            c.execute("set statement_timeout = '5s'")
            cur = c.execute(sql.strip().rstrip(";"))
            cols = [d.name for d in cur.description or []]
            rows = cur.fetchmany(limit)
            return {"columns": cols, "rows": [list(map(str, r)) for r in rows], "truncated_at": limit}


class SyntheticUser:
    """Drives the real shop like a customer (no synthetic baggage, so it counts as real traffic)."""

    TEST_BUYER = {
        "email": "nightshift-probe@example.com",
        "address": {"streetAddress": "1 Probe Street", "zipCode": "560066", "city": "Bengaluru",
                    "state": "KA", "country": "India"},
        "userCurrency": "USD",
        "creditCard": {"creditCardNumber": "4432-8015-6152-0454", "creditCardExpirationMonth": 1,
                       "creditCardExpirationYear": 2039, "creditCardCvv": 672},
    }

    def __init__(self, shop_url: str):
        self.url = shop_url.rstrip("/")

    def run(self, flow: str = "add_to_cart", quantity: int = 5) -> dict:
        steps = []
        user = str(uuid.uuid4())
        with httpx.Client(base_url=self.url, timeout=20, headers={"User-Agent": "NightShift-Probe/1.0"}) as c:
            def step(name, fn):
                t = time.time()
                try:
                    r = fn()
                    ok = r.status_code < 400
                    detail = r.text[:300] if not ok else ""
                except Exception as e:  # noqa: BLE001
                    r, ok, detail = None, False, str(e)[:300]
                steps.append({"step": name, "ok": ok, "status": getattr(r, "status_code", None),
                              "ms": round((time.time() - t) * 1000), "detail": detail})
                if not ok:
                    raise StopIteration
                return r

            def money(m):
                return round((m or {}).get("units", 0) + (m or {}).get("nanos", 0) / 1e9, 2)

            def check(name, ok, detail):
                steps.append({"step": name, "ok": bool(ok), "status": None, "ms": 0, "detail": "" if ok else detail})
                if not ok:
                    raise StopIteration

            try:
                products = step("list products", lambda: c.get("/api/products", params={"currencyCode": "USD"})).json()
                # a price with cents exercises the money code paths that whole-dollar prices skip
                product = next((p for p in products if (p.get("priceUsd") or {}).get("nanos")), products[0])
                pid, price = product["id"], money(product.get("priceUsd"))
                step(f"add {quantity} × {pid} to cart", lambda: c.post(
                    "/api/cart", params={"currencyCode": "USD"},
                    json={"item": {"productId": pid, "quantity": quantity}, "userId": user}))
                cart = step("read cart", lambda: c.get("/api/cart", params={"sessionId": user, "currencyCode": "USD"})).json()
                got = sum(i.get("quantity", 0) for i in cart.get("items", []) if i.get("productId") == pid)
                steps.append({"step": f"cart holds {quantity}", "ok": got == quantity, "status": None, "ms": 0,
                              "detail": "" if got == quantity else f"expected {quantity}, cart has {got}"})
                if got != quantity:
                    raise StopIteration
                if flow == "checkout":
                    order = step("place order", lambda: c.post("/api/checkout", params={"currencyCode": "USD"},
                                                              json={**self.TEST_BUYER, "userId": user})).json()
                    steps[-1]["detail"] = f"order {order.get('orderId', '?')}"
                    # a 200 is not enough: the order must say what we bought, at the catalog price
                    lines = [i for i in order.get("items", []) if (i.get("item") or {}).get("productId") == pid]
                    qty = sum((i.get("item") or {}).get("quantity", 0) for i in lines)
                    check(f"order holds {quantity} × {pid}", qty == quantity, f"order has {qty}")
                    cost = money(lines[0].get("cost")) if lines else None
                    check(f"charged the catalog price {price}", cost == price, f"order line costs {cost}")
                    ship = money(order.get("shippingCost"))
                    check("shipping cost is sane", 0 < ship < 1000, f"shipping cost {ship}")
                    check("order has a tracking id", bool(order.get("shippingTrackingId")), "no shipping tracking id")
            except StopIteration:
                pass
        passed = all(s["ok"] for s in steps)
        failed = next((s for s in steps if not s["ok"]), None)
        return {"flow": flow, "passed": passed, "failed_step": failed, "steps": steps}


class IncidentHistory:
    """Read-only view of NightShift's own incident store: past incidents and the raw evidence of the current one."""

    def __init__(self, dsn: str):
        self.dsn = dsn

    def _q(self, query: str, *params) -> list[dict]:
        import psycopg
        from psycopg.rows import dict_row

        if not self.dsn:
            raise RuntimeError("Incident history is not configured (NIGHTSHIFT_DB_URL).")
        with psycopg.connect(self.dsn, row_factory=dict_row, connect_timeout=5) as c:
            c.execute("set statement_timeout = '5s'")
            return c.execute(query, params).fetchall()

    def search(self, text: str, limit: int = 5) -> list[dict]:
        rows = self._q(
            "select i.id, i.service, i.status, i.category, i.severity, i.summary, i.opened_at, i.pr_url, "
            "(select output->>'root_cause' from stages where incident_id=i.id and name='diagnosis' and status='done' order by id desc limit 1) root_cause, "
            "(select output->>'suspect_commit' from stages where incident_id=i.id and name='diagnosis' and status='done' order by id desc limit 1) suspect_commit, "
            "(select output->>'summary' from stages where incident_id=i.id and name='mitigation' and status='done' order by id desc limit 1) mitigation, "
            "(select output->>'summary' from stages where incident_id=i.id and name='postmortem' and status='done' order by id desc limit 1) postmortem "
            "from incidents i order by opened_at desc limit 300")
        words = [w for w in re.findall(r"[a-z0-9_.-]{3,}", text.lower())]
        scored = []
        for r in rows:
            hay = " ".join(str(v) for v in r.values() if v).lower()
            score = sum(hay.count(w) for w in words)
            if score:
                scored.append((score, r))
        scored.sort(key=lambda x: -x[0])
        return [{k: (str(v) if v is not None else None) for k, v in r.items()} for _, r in scored[: max(1, min(int(limit), 10))]] \
            or [{"note": "no similar past incidents"}]

    def evidence(self, incident_id: str, stage: str = "", tool: str = "", limit: int = 8) -> list[dict]:
        rows = self._q(
            "select id, ts, stage, data->>'tool' tool, data->>'result' result from events "
            "where incident_id=%s and kind='tool.result' and (%s='' or stage=%s) and (%s='' or data->>'tool'=%s) "
            "order by id desc limit %s", incident_id, stage, stage, tool, tool, max(1, min(int(limit), 20)))
        return [{**r, "ts": str(r["ts"])} for r in rows] or [{"note": "no matching tool outputs"}]


def notify_slack(webhook: str, text: str) -> str:
    if not webhook:
        return "Recorded. (No Slack webhook is configured, so the message was logged instead of posted. Do not retry.)"
    r = httpx.post(webhook, json={"text": text}, timeout=10)
    return "sent" if r.status_code < 300 else f"Slack returned {r.status_code}: {r.text[:200]}"
