"""
crowd_position_store.py
-------------------------
FEATURE: Crowd-Sourced Train Position Reports — persistence layer.

Same pattern as push_store.py (single SQLite file, stdlib sqlite3, no ORM):
this is the first piece of server-side state a passenger's own phone
writes to, so it needs to survive across requests/devices, unlike every
other "form" feature in this app that's stateless per call.

Two tables:
  - position_reports  — one row per submitted "I'm on this train, here's
    my phone's GPS fix" report. Reports are the raw, ungrouped input;
    crowd_position_tracking.py does the actual clustering/fusion on top of
    whatever's recent for a given train.
  - reporters          — lifetime report counts per anonymous reporter id,
    purely for the gamification badges (see badge_for_count below) — never
    used to weight or trust a report differently, so a "frequent reporter"
    badge is a thank-you, not a way to game the fused position.

HONESTY / PRIVACY NOTE, same rule as push_store.py's device tokens: a
"reporter_id" is a random id the MOBILE APP generates and persists locally
(see mobile-app/src/utils/reporterId.js) — there's no login system
anywhere in this project. It identifies a DEVICE for badge-counting and
basic abuse throttling, not a real person. Raw lat/lng for an individual
report is never exposed by the read APIs below beyond what's needed to
compute a fused position — see crowd_position_tracking.fuse_position,
which returns a confirming-report COUNT, not the individual reporters.
"""

import os
import sqlite3
import time
from contextlib import contextmanager
from typing import List, Optional

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crowd_position_data.db")

# Lifetime report-count thresholds for the gamification badges (see
# badge_for_count). Deliberately generous at the low end — the point is to
# make submitting a FEW reports feel rewarded quickly, not to gate
# recognition behind a huge count.
_BADGE_THRESHOLDS = [
    (300, "🏆 Platinum Tracker"),
    (100, "🥇 Gold Tracker"),
    (25, "🥈 Silver Tracker"),
    (5, "🥉 Bronze Tracker"),
]


def _init_db():
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS position_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                train_number TEXT NOT NULL,
                date TEXT,
                reporter_id TEXT NOT NULL,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                accuracy_meters REAL,
                station_hint TEXT,
                reported_at REAL NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reports_train ON position_reports(train_number, reported_at)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reporters (
                reporter_id TEXT PRIMARY KEY,
                total_reports INTEGER NOT NULL DEFAULT 0,
                first_report_at REAL,
                last_report_at REAL,
                display_name TEXT
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


def badge_for_count(total_reports: int) -> Optional[str]:
    for threshold, label in _BADGE_THRESHOLDS:
        if total_reports >= threshold:
            return label
    return None


def next_badge_progress(total_reports: int) -> Optional[dict]:
    """How many more reports until the NEXT badge tier — the little
    '3 more reports to Silver Tracker' nudge, computed honestly from the
    same thresholds badge_for_count uses, never a fabricated number."""
    for threshold, label in reversed(_BADGE_THRESHOLDS):
        if total_reports < threshold:
            return {"next_badge": label, "reports_needed": threshold - total_reports, "threshold": threshold}
    return None  # already at the top tier


def submit_report(
    train_number: str, reporter_id: str, lat: float, lng: float,
    date: Optional[str] = None, accuracy_meters: Optional[float] = None,
    station_hint: Optional[str] = None,
) -> dict:
    """Inserts one position report and upserts the reporter's lifetime
    count. Returns the reporter's updated stats + badge so the mobile app
    can show an immediate "thanks, you're now a Bronze Tracker" moment
    without a second round-trip."""
    now = time.time()
    train_number = str(train_number).strip()
    reporter_id = str(reporter_id).strip()

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO position_reports (train_number, date, reporter_id, lat, lng, accuracy_meters, station_hint, reported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (train_number, date, reporter_id, float(lat), float(lng), accuracy_meters, station_hint, now),
        )
        conn.execute(
            """
            INSERT INTO reporters (reporter_id, total_reports, first_report_at, last_report_at)
            VALUES (?, 1, ?, ?)
            ON CONFLICT(reporter_id) DO UPDATE SET
                total_reports = total_reports + 1,
                last_report_at = excluded.last_report_at
            """,
            (reporter_id, now, now),
        )
        row = conn.execute(
            "SELECT total_reports, first_report_at FROM reporters WHERE reporter_id = ?", (reporter_id,)
        ).fetchone()

    total = row["total_reports"] if row else 1
    return {
        "reporter_id": reporter_id,
        "total_reports": total,
        "badge": badge_for_count(total),
        "next_badge": next_badge_progress(total),
        "reported_at": now,
    }


def recent_reports_for_train(train_number: str, max_age_seconds: int = 900) -> List[dict]:
    """Every position report for this train newer than max_age_seconds —
    a position report goes stale fast (the train keeps moving), so callers
    should NEVER treat an old report as still valid. Not filtered by
    `date` — a report submitted a few minutes ago is relevant to whichever
    real-world run of this train is currently in progress regardless of
    what date string was attached, same reasoning push_store.py's
    list_watches_for_train uses."""
    cutoff = time.time() - max(60, max_age_seconds)
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM position_reports WHERE train_number = ? AND reported_at >= ? ORDER BY reported_at DESC",
            (str(train_number).strip(), cutoff),
        ).fetchall()
        return [dict(r) for r in rows]


def reporter_stats(reporter_id: str) -> dict:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM reporters WHERE reporter_id = ?", (str(reporter_id).strip(),)).fetchone()
    if not row:
        return {"reporter_id": reporter_id, "total_reports": 0, "badge": None, "next_badge": next_badge_progress(0)}
    total = row["total_reports"]
    return {
        "reporter_id": row["reporter_id"], "total_reports": total,
        "badge": badge_for_count(total), "next_badge": next_badge_progress(total),
        "first_report_at": row["first_report_at"], "last_report_at": row["last_report_at"],
    }


def leaderboard(limit: int = 10) -> List[dict]:
    """Top reporters by lifetime report count — gamification only, no
    identity beyond the anonymous reporter_id (see module docstring)."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT reporter_id, total_reports, display_name FROM reporters ORDER BY total_reports DESC LIMIT ?",
            (max(1, min(limit, 50)),),
        ).fetchall()
    return [
        {
            "reporter_id": r["reporter_id"], "total_reports": r["total_reports"],
            "display_name": r["display_name"], "badge": badge_for_count(r["total_reports"]),
        }
        for r in rows
    ]


def set_display_name(reporter_id: str, display_name: Optional[str]) -> None:
    """Optional cosmetic nickname for the leaderboard — purely client-set,
    never required, never used for anything but display."""
    name = (display_name or "").strip()[:40] or None
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO reporters (reporter_id, total_reports, display_name)
            VALUES (?, 0, ?)
            ON CONFLICT(reporter_id) DO UPDATE SET display_name = excluded.display_name
            """,
            (str(reporter_id).strip(), name),
        )


def stats() -> dict:
    with _connect() as conn:
        reporter_count = conn.execute("SELECT COUNT(*) FROM reporters").fetchone()[0]
        report_count = conn.execute("SELECT COUNT(*) FROM position_reports").fetchone()[0]
    return {"registered_reporters": reporter_count, "total_reports": report_count}


def purge_old_reports(max_age_seconds: int = 6 * 3600) -> int:
    """Housekeeping: delete reports old enough that no live fusion window
    would ever use them again (see crowd_position_tracking's
    _REPORT_MAX_AGE_SECONDS, always far shorter than this). Safe to call
    on a schedule or ad hoc; returns the number of rows removed."""
    cutoff = time.time() - max_age_seconds
    with _connect() as conn:
        cur = conn.execute("DELETE FROM position_reports WHERE reported_at < ?", (cutoff,))
        return cur.rowcount


_init_db()
