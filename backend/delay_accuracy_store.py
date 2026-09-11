"""
delay_accuracy_store.py
------------------------
FEATURE: Predicted-vs-Actual Delay History — persistence layer.

Same pattern as crowd_position_store.py / push_store.py (single SQLite
file, stdlib sqlite3, no ORM). This is the durable record behind the Live
Tracking delay chart's "predicted vs actual" comparison (see app.py's
_snapshot_prediction_before_arrival / _sync_station_delay_history):
without this, that comparison only ever lived in one WebSocket
connection's memory and vanished the moment that tab closed — so
re-opening Live Tracking for a train that had ALREADY finished its
journey (or that a DIFFERENT user tracked earlier) showed nothing to
compare against, even though a real prediction genuinely was made (and
genuinely was close, or wasn't) while someone was watching.

HONESTY NOTE, same rule as everywhere else in this app: a row only ever
gets written the moment a station's REAL recorded actual delay becomes
known (RailKit's own arrival, or RailRadar's independently-confirmed one
— never this app's own predicted stand-in), paired with whatever this
app had already predicted for that station BEFORE it was reached. There
is no way to retroactively invent what would have been predicted for a
station nobody was live-tracking at the time it was reached — if this
table has no row for a (train, date, station), it genuinely means no one
had Live Tracking open when that train passed through, not a bug. Reads
never fabricate a placeholder to fill that gap; they simply have nothing
to show, and callers should treat an empty result that way.

One row per (train_number, date, station_code) — re-tracking the same
real-world run just upserts the same row (harmless), it never creates
duplicates and a later write only ever replaces an earlier one with a
more final real actual for that exact run, never a worse guess.
"""

import logging
import os
import sqlite3
import time
from contextlib import contextmanager
from typing import List, Optional

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "delay_accuracy_data.db")

# FEATURE: query-execution visibility in Render's console. Render's free
# plan has no Shell/file-browser access (see the db_diagnostics() docstring
# below and app.py's /api/health wiring - both exist for the exact same
# "I can't see what's happening on the server" reason), but it DOES stream
# stdout/stderr live to its Logs tab, same as any `print()`/logging call
# anywhere else in this app already shows up there. Using Python's stdlib
# `logging` (not bare print) so these lines get the same timestamp/level
# formatting as uvicorn's own request logs, and so they can be silenced
# later (LOG_SQL_QUERIES=0) without touching this file again.
#
# Two independent layers, both opt-out via env var, both print()-simple:
#   1. A human-readable one-line summary per call (WRITE/READ/DELETE, the
#      train+date+station it was for, and the outcome) - this is what you
#      actually want to eyeball in the log stream to confirm "yes, a real
#      write just happened for train 20833".
#   2. The literal SQL text SQLite actually ran, via sqlite3's own
#      set_trace_callback - the raw ground truth, one level more detailed
#      than (1), useful if something looks wrong and you need to see the
#      exact statement rather than trust this file's own summary of it.
_logger = logging.getLogger("delay_accuracy_store")
if not _logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s [delay_accuracy_store] %(message)s"))
    _logger.addHandler(_handler)
    _logger.setLevel(logging.INFO)
    _logger.propagate = False

_LOG_QUERIES = (os.environ.get("LOG_SQL_QUERIES", "1").strip() != "0")


def _sql_trace(statement: str) -> None:
    """Registered per-connection via set_trace_callback - called by SQLite
    itself for every statement it actually executes (CREATE TABLE, INSERT,
    SELECT, everything), not just the ones this file's own functions log a
    summary for. Kept as its own tiny function (rather than a bare lambda)
    so a bug in logging itself can never break a real query - printing is
    wrapped defensively since this runs inside SQLite's own C callback."""
    if not _LOG_QUERIES:
        return
    try:
        _logger.info("[SQL] %s", " ".join(statement.split()))
    except Exception:
        pass


def _init_db():
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS station_delay_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                train_number TEXT NOT NULL,
                date TEXT NOT NULL,
                station_code TEXT NOT NULL,
                station_name TEXT,
                sequence_index INTEGER,
                predicted_delay_minutes INTEGER,
                predicted_delay_confidence TEXT,
                predicted_delay_locked INTEGER NOT NULL DEFAULT 0,
                predicted_delay_grounded_via TEXT,
                actual_delay_minutes INTEGER,
                scheduled_time TEXT,
                actual_time TEXT,
                recorded_at REAL NOT NULL,
                UNIQUE(train_number, date, station_code)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_delay_records_run ON station_delay_records(train_number, date)"
        )


@contextmanager
def _connect():
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    if _LOG_QUERIES:
        conn.set_trace_callback(_sql_trace)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def record_station_prediction_vs_actual(
    train_number: str, date: str, station_code: str, station_name: Optional[str],
    predicted_delay_minutes: Optional[int], predicted_delay_confidence: Optional[str],
    predicted_delay_locked: bool, predicted_delay_grounded_via: Optional[str],
    actual_delay_minutes: Optional[int], scheduled_time: Optional[str], actual_time: Optional[str],
    sequence_index: Optional[int] = None,
) -> None:
    """Upserts one station's predicted-vs-actual pair for one real-world
    run (train_number + date). Safe to call every poll once both figures
    are known — re-writing the SAME values is a harmless no-op, and a
    later call for the same station simply updates the row rather than
    duplicating it (UNIQUE(train_number, date, station_code))."""
    train_number = str(train_number).strip()
    date = str(date).strip()
    station_code = str(station_code).strip().upper()
    if not train_number or not date or not station_code:
        return
    now = time.time()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO station_delay_records (
                train_number, date, station_code, station_name, sequence_index,
                predicted_delay_minutes, predicted_delay_confidence, predicted_delay_locked,
                predicted_delay_grounded_via, actual_delay_minutes, scheduled_time, actual_time,
                recorded_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(train_number, date, station_code) DO UPDATE SET
                station_name = excluded.station_name,
                sequence_index = excluded.sequence_index,
                predicted_delay_minutes = excluded.predicted_delay_minutes,
                predicted_delay_confidence = excluded.predicted_delay_confidence,
                predicted_delay_locked = excluded.predicted_delay_locked,
                predicted_delay_grounded_via = excluded.predicted_delay_grounded_via,
                actual_delay_minutes = excluded.actual_delay_minutes,
                scheduled_time = excluded.scheduled_time,
                actual_time = excluded.actual_time,
                recorded_at = excluded.recorded_at
            """,
            (
                train_number, date, station_code, station_name, sequence_index,
                predicted_delay_minutes, predicted_delay_confidence, 1 if predicted_delay_locked else 0,
                predicted_delay_grounded_via, actual_delay_minutes, scheduled_time, actual_time,
                now,
            ),
        )
    if _LOG_QUERIES:
        _logger.info(
            "WRITE upsert train=%s date=%s station=%s(%s) predicted=%s%s actual=%s scheduled=%s actual_time=%s",
            train_number, date, station_code, station_name or "?", predicted_delay_minutes,
            " [locked]" if predicted_delay_locked else "", actual_delay_minutes, scheduled_time, actual_time,
        )


def get_run_records(train_number: str, date: str) -> List[dict]:
    """All recorded station comparisons for one specific real-world run,
    in route order (sequence_index) where known. An empty list is a
    normal, honest answer — it means no one was live-tracking this
    train/date combination for any station yet, not an error."""
    train_number = str(train_number).strip()
    date = str(date).strip()
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM station_delay_records
            WHERE train_number = ? AND date = ?
            ORDER BY (sequence_index IS NULL), sequence_index, id
            """,
            (train_number, date),
        ).fetchall()
    result = [dict(r) for r in rows]
    if _LOG_QUERIES:
        _logger.info("READ get_run_records train=%s date=%s -> %d row(s)", train_number, date, len(result))
    return result


def get_station_record(train_number: str, date: str, station_code: str) -> Optional[dict]:
    """One station's recorded comparison for one real-world run, or None
    if nobody was live-tracking this train when it passed that station."""
    train_number_n, date_n, station_code_n = str(train_number).strip(), str(date).strip(), str(station_code).strip().upper()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM station_delay_records WHERE train_number = ? AND date = ? AND station_code = ?",
            (train_number_n, date_n, station_code_n),
        ).fetchone()
    result = dict(row) if row else None
    if _LOG_QUERIES:
        _logger.info(
            "READ get_station_record train=%s date=%s station=%s -> %s",
            train_number_n, date_n, station_code_n,
            f"predicted={result['predicted_delay_minutes']} actual={result['actual_delay_minutes']}" if result else "not found",
        )
    return result


def purge_old_records(max_age_days: int = 90) -> int:
    """Housekeeping: this table is meant to be a real historical record
    (unlike the in-memory analytics ring buffer elsewhere in this app),
    so the default retention here is deliberately long — pass a shorter
    max_age_days if disk space becomes a concern. Returns the number of
    rows removed."""
    cutoff = time.time() - max_age_days * 86400
    with _connect() as conn:
        cur = conn.execute("DELETE FROM station_delay_records WHERE recorded_at < ?", (cutoff,))
        removed = cur.rowcount
    if _LOG_QUERIES:
        _logger.info("DELETE purge_old_records max_age_days=%s -> %d row(s) removed", max_age_days, removed)
    return removed


def db_diagnostics() -> dict:
    """FEATURE: lets you confirm this store is actually alive on a deployed
    server you have no shell/file-browser access to (e.g. Render's free
    plan) - wired into /api/health in app.py. `file_exists`/`file_size_bytes`
    prove the sqlite file itself got created (it's created lazily by
    sqlite3.connect() the moment _init_db() runs at import time - see the
    bottom of this file), and `row_count`/`distinct_runs` prove real writes
    have actually happened, not just that the empty file/table exist.
    Never raises - a broken db is exactly the kind of thing this exists to
    surface, so a failure here is reported IN the result, not thrown."""
    try:
        exists = os.path.isfile(_DB_PATH)
        size = os.path.getsize(_DB_PATH) if exists else 0
        row_count = 0
        distinct_runs = 0
        if exists:
            with _connect() as conn:
                row_count = conn.execute("SELECT COUNT(*) FROM station_delay_records").fetchone()[0]
                distinct_runs = conn.execute(
                    "SELECT COUNT(DISTINCT train_number || '|' || date) FROM station_delay_records"
                ).fetchone()[0]
        return {
            "db_path": _DB_PATH, "file_exists": exists, "file_size_bytes": size,
            "row_count": row_count, "distinct_runs_recorded": distinct_runs, "error": None,
        }
    except Exception as e:
        return {
            "db_path": _DB_PATH, "file_exists": None, "file_size_bytes": None,
            "row_count": None, "distinct_runs_recorded": None, "error": str(e),
        }


_init_db()
