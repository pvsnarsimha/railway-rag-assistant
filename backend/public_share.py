"""
public_share.py
-----------------
FEATURE: End-of-Trip Summary Card (shareable).

Once a tracked journey completes, nothing about it persists anywhere in
this app today — Live Tracking's whole state lives only in the open
websocket session's local variables and the browser tab/app's in-memory
per-station data, both of which vanish the moment the tab/connection
closes. This module is the one small piece of REAL persistence needed to
make "a recap of the trip you just took" something you can still open (and
share) minutes, hours, or days later — a tiny SQLite table storing exactly
the summary object the frontend/mobile computed from its own accumulated
per-station data, keyed by a short random share id.

Same "single SQLite file, no login system" pattern as push_store.py /
crowd_position_store.py / coach_crowd_store.py elsewhere in this project —
anyone holding a share id can view that one trip's summary (there's
nothing sensitive in it: a train number, a date, and per-station delay
figures), matching this project's existing "possession of the id/token IS
the access control" honesty note.
"""

import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from typing import Optional

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trip_summary_data.db")


def _init_db():
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS trip_summaries (
                share_id TEXT PRIMARY KEY,
                train_number TEXT NOT NULL,
                date TEXT,
                summary_json TEXT NOT NULL,
                created_at REAL NOT NULL
            )
            """
        )


@contextmanager
def _connect():
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def save_summary(train_number: str, date: Optional[str], summary: dict) -> str:
    """Stores whatever summary dict the caller built (see app.py's
    /api/trip-summary, which trusts the frontend's own accumulated
    per-station figures — the same numbers already shown live during
    tracking, just snapshotted) and returns a short URL-safe share id."""
    share_id = secrets.token_urlsafe(6)  # ~48 bits — plenty for a low-stakes shareable id, not a security boundary
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO trip_summaries (share_id, train_number, date, summary_json, created_at) VALUES (?, ?, ?, ?, ?)",
            (share_id, str(train_number).strip(), date, json.dumps(summary), now),
        )
    return share_id


def get_summary(share_id: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM trip_summaries WHERE share_id = ?", (share_id.strip(),)).fetchone()
    if not row:
        return None
    out = dict(row)
    try:
        out["summary"] = json.loads(out.pop("summary_json"))
    except (TypeError, ValueError):
        out["summary"] = {}
    return out


def stats() -> dict:
    with _connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM trip_summaries").fetchone()[0]
    return {"saved_trip_summaries": count}


_init_db()
