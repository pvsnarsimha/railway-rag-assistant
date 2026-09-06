"""
coach_crowd_store.py
---------------------
FEATURE: Real-Time Per-Coach Crowding (passenger-reported).

Distinct from crowd_prediction.py (a booking-data + date/time heuristic
estimate for the WHOLE train, computed before anyone boards) and from the
Coach Layout tool's static/aggregate seat-occupancy estimate (derived from
booked/RAC/WL counts, not a live reading). This is a genuinely live signal:
a 1-tap "how crowded is MY coach right now" report from someone actually
riding this run, aggregated per coach across everyone who's reported
recently. Also distinct from crowd_position_tracking.py/crowd_position_store.py
(that feature fuses rider GPS pings to answer "where is this train", not
"how crowded is it").

Same infra pattern as crowd_position_store.py (and push_store.py before
it): a single SQLite file, stdlib sqlite3, no new dependency — this is a
small-scale, personal-tool-sized feature, not something needing a real
time-series database. `reporter_id` is a client-generated anonymous id
(same honesty note as push_store.py's device tokens: there's no login
system anywhere in this app, so nothing here is tied to a real identity).
"""

import os
import sqlite3
import time
from contextlib import contextmanager
from typing import List, Optional

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coach_crowd_data.db")

# Canonical crowd levels, ordered least -> most crowded. Kept as a short
# fixed vocabulary (not a free-text field) so aggregation/mode-finding is
# well-defined and the frontend/mobile can render a consistent color scale.
CROWD_LEVELS = ["empty", "comfortable", "crowded", "packed"]
_LEVEL_RANK = {lvl: i for i, lvl in enumerate(CROWD_LEVELS)}

# A report older than this is dropped from "current" aggregation — coach
# crowding on a moving train changes fast (people board/alight every halt),
# so a 20-minute-old report is closer to stale than informative.
DEFAULT_MAX_AGE_SECONDS = 20 * 60


def _init_db():
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS coach_crowd_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                train_number TEXT NOT NULL,
                date TEXT,
                coach TEXT NOT NULL,
                crowd_level TEXT NOT NULL,
                reporter_id TEXT,
                reported_at REAL NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_coach_crowd_train ON coach_crowd_reports(train_number, reported_at)")


@contextmanager
def _connect():
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def submit_report(train_number: str, coach: str, crowd_level: str, date: Optional[str] = None,
                   reporter_id: Optional[str] = None) -> dict:
    crowd_level = (crowd_level or "").strip().lower()
    if crowd_level not in _LEVEL_RANK:
        return {"ok": False, "error": f"crowd_level must be one of {CROWD_LEVELS}"}
    coach = (coach or "").strip().upper()
    if not coach:
        return {"ok": False, "error": "coach is required (e.g. 'S4', 'B2', or a class code like 'SL' if the coach number isn't known)."}
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO coach_crowd_reports (train_number, date, coach, crowd_level, reporter_id, reported_at) VALUES (?, ?, ?, ?, ?, ?)",
            (str(train_number).strip(), date, coach, crowd_level, reporter_id, now),
        )
    return {"ok": True, "train_number": str(train_number).strip(), "coach": coach, "crowd_level": crowd_level, "reported_at": now}


def recent_reports_for_train(train_number: str, max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS) -> List[dict]:
    cutoff = time.time() - max_age_seconds
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM coach_crowd_reports WHERE train_number = ? AND reported_at >= ? ORDER BY reported_at DESC",
            (str(train_number).strip(), cutoff),
        ).fetchall()
        return [dict(r) for r in rows]


def aggregate_for_train(train_number: str, max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS) -> dict:
    """
    Per-coach aggregation over recent reports: the MODE (most-reported)
    crowd level per coach, a full breakdown, how many distinct reports fed
    it, and how fresh the newest one is. Never invents a coach with zero
    real reports — a coach with no recent reports is simply absent from
    `coaches`, and the caller/UI should say "no reports yet" for it rather
    than this module guessing.
    """
    reports = recent_reports_for_train(train_number, max_age_seconds)
    by_coach: dict = {}
    for r in reports:
        coach = r["coach"]
        entry = by_coach.setdefault(coach, {"breakdown": {}, "count": 0, "most_recent_at": 0.0})
        entry["breakdown"][r["crowd_level"]] = entry["breakdown"].get(r["crowd_level"], 0) + 1
        entry["count"] += 1
        entry["most_recent_at"] = max(entry["most_recent_at"], r["reported_at"])

    coaches = []
    for coach, entry in by_coach.items():
        # Mode by count, ties broken toward the MORE crowded reading — a
        # passenger deciding whether to board a coach is better served by
        # an honest worst-case tiebreak than an arbitrary one.
        mode_level = max(
            entry["breakdown"].items(),
            key=lambda kv: (kv[1], _LEVEL_RANK[kv[0]]),
        )[0]
        coaches.append({
            "coach": coach,
            "crowd_level": mode_level,
            "report_count": entry["count"],
            "breakdown": entry["breakdown"],
            "most_recent_seconds_ago": round(time.time() - entry["most_recent_at"]) if entry["most_recent_at"] else None,
        })
    coaches.sort(key=lambda c: c["coach"])
    return {
        "train_number": str(train_number).strip(),
        "coaches": coaches,
        "max_age_seconds": max_age_seconds,
        "disclaimer": (
            "Reported live by riders on this run in the last "
            f"{max_age_seconds // 60} minutes — anonymous, self-reported, and not verified. "
            "A coach with no recent reports simply isn't listed here yet."
        ),
    }


def purge_old_reports(max_age_seconds: int = 24 * 60 * 60) -> int:
    """Housekeeping — drop reports older than a day by default so the DB
    doesn't grow unbounded. Not called automatically anywhere yet; wire
    into a periodic job if this ever needs it."""
    cutoff = time.time() - max_age_seconds
    with _connect() as conn:
        cur = conn.execute("DELETE FROM coach_crowd_reports WHERE reported_at < ?", (cutoff,))
        return cur.rowcount


def stats() -> dict:
    with _connect() as conn:
        total = conn.execute("SELECT COUNT(*) FROM coach_crowd_reports").fetchone()[0]
        trains = conn.execute("SELECT COUNT(DISTINCT train_number) FROM coach_crowd_reports").fetchone()[0]
    return {"total_reports": total, "trains_with_reports": trains}


_init_db()
