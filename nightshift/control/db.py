"""Incident state in Postgres. Small helpers, plain SQL."""
import json
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from . import settings

pool = ConnectionPool(settings.DATABASE_URL, min_size=1, max_size=10, kwargs={"row_factory": dict_row, "autocommit": True},
                      open=False)


def init() -> None:
    pool.open()
    for f in sorted((Path(__file__).parent / "migrations").glob("*.sql")):
        with pool.connection() as c:
            c.execute(f.read_text())
    _reader_role()


def _reader_role() -> None:
    """A read-only login for the ops server's search_incidents / get_incident_evidence tools."""
    pw = settings.env("NIGHTSHIFT_DB_RO_PASSWORD")
    if not pw:
        return
    with pool.connection() as c:
        if not c.execute("select 1 from pg_roles where rolname='nightshift_reader'").fetchone():
            c.execute("create role nightshift_reader login")
        c.execute(sql.SQL("alter role nightshift_reader password {}").format(sql.Literal(pw)))
        c.execute("grant select on incidents, stages, events to nightshift_reader")


def _param(p):
    # dicts and lists of dicts are JSON columns; plain lists stay Postgres arrays (for any(...))
    if isinstance(p, dict) or (isinstance(p, list) and any(isinstance(x, (dict, list)) for x in p)):
        return json.dumps(p, default=str)
    return p


def q(sql: str, *params) -> list[dict]:
    with pool.connection() as c:
        cur = c.execute(sql, [_param(p) for p in params])
        return cur.fetchall() if cur.description else []


def one(sql: str, *params) -> dict | None:
    rows = q(sql, *params)
    return rows[0] if rows else None


def new_incident_id() -> str:
    n = one("select nextval('incident_seq') as n")["n"]
    return f"INC-{n:03d}"


def incident(incident_id: str) -> dict | None:
    inc = one("select * from incidents where id=%s", incident_id)
    if not inc:
        return None
    inc["stages"] = q("select * from stages where incident_id=%s order by id", incident_id)
    inc["approvals"] = q("select * from approvals where incident_id=%s order by id", incident_id)
    return inc
