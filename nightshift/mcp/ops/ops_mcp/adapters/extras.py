"""Smaller adapters: feature flags (flagd), read-only SQL, synthetic user, Slack."""
import json
import re
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

    def __init__(self, host: str, port: int, db: str, admin_user: str, admin_password: str):
        self.host, self.port, self.db = host, port, db
        self.admin = (admin_user, admin_password)
        self.role, self.password = "nightshift_ro", "nightshift_ro"

    def ensure_role(self) -> None:
        import psycopg

        with psycopg.connect(host=self.host, port=self.port, dbname=self.db, user=self.admin[0],
                             password=self.admin[1], autocommit=True, connect_timeout=5) as c:
            if not c.execute("select 1 from pg_roles where rolname=%s", (self.role,)).fetchone():
                c.execute(f"create role {self.role} login password '{self.password}'")
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

            try:
                products = step("list products", lambda: c.get("/api/products", params={"currencyCode": "USD"})).json()
                pid = products[0]["id"]
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
                                                              json={**self.TEST_BUYER, "userId": user}))
                    steps[-1]["detail"] = f"order {order.json().get('orderId', '?')}"
            except StopIteration:
                pass
        passed = all(s["ok"] for s in steps)
        failed = next((s for s in steps if not s["ok"]), None)
        return {"flow": flow, "passed": passed, "failed_step": failed, "steps": steps}


def notify_slack(webhook: str, text: str) -> str:
    if not webhook:
        return "Recorded. (No Slack webhook is configured, so the message was logged instead of posted. Do not retry.)"
    r = httpx.post(webhook, json={"text": text}, timeout=10)
    return "sent" if r.status_code < 300 else f"Slack returned {r.status_code}: {r.text[:200]}"
