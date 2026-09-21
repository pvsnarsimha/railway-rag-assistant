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
# Two independent layers, both opt-in via env var, both print()-simple:
#   1. A human-readable one-line summary per call (WRITE/READ/DELETE, the
#      train+date+station it was for, and the outcome) - this is what you
#      actually want to eyeball in the log stream to confirm "yes, a real
#      write just happened for train 20833".
#   2. The literal SQL text SQLite actually ran, via sqlite3's own
#      set_trace_callback - the raw ground truth, one level more detailed
#      than (1), useful if something looks wrong and you need to see the
#      exact statement rather than trust this file's own summary of it.
#
# BUGFIX (noticed while reading a user-supplied Render log for an unrelated
# report): this used to default ON - a single poll of a long-journey train
# (parse_full_timeline walking every one of its ~80+ real stops) logs one
# READ and usually one WRITE line PER STATION, so a single live-tracking
# session was producing hundreds of these lines a minute, permanently,
# burying whatever anyone was actually trying to find in the log stream
# right when they needed it most (exactly what happened here). The toggle
# itself was always correct - only the default was backwards for a feature
# meant to be turned on when actively debugging this one store, not left
# on by default forever. Same env var, same opt-out mechanic, just OFF
# unless explicitly requested with LOG_SQL_QUERIES=1.
_logger = logging.getLogger("delay_accuracy_store")
if not _logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s [delay_accuracy_store] %(message)s"))
    _logger.addHandler(_handler)
    _logger.setLevel(logging.INFO)
    _logger.propagate = False

_LOG_QUERIES = (os.environ.get("LOG_SQL_QUERIES", "0").strip() != "0")


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


# FEATURE: real ML feature vector alongside each prediction (see
# delay_prediction.py's FEATURE_NAMES / ResolvedFeatures.values - same
# names, "feature_" prefixed so they're unambiguous as SQL columns).
# Without this, a logged (predicted, actual) row is just a before/after
# number - useful for the accuracy chart, but NOT usable as a supervised
# training example, since there'd be no record of what real inputs the
# prediction was actually made from. Rows written before this column set
# existed simply have NULLs here (an honest gap, not backfilled with a
# guess) and are excluded from training - see delay_prediction.py's
# train_on_real_history_if_available().
_FEATURE_COLUMNS = [
    "feature_distance_km", "feature_hour_of_day", "feature_is_weekend",
    "feature_is_high_demand_season", "feature_route_progress_ratio",
    "feature_current_delay_minutes", "feature_is_unreserved_class",
    "feature_recent_delay_trend_per_stop", "feature_speed_deficit_kmph",
]


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
        # MIGRATION: add the feature-vector columns to a table created by an
        # earlier version of this file. ALTER TABLE ADD COLUMN has no
        # IF NOT EXISTS in SQLite, so each add is tried and a "duplicate
        # column" failure (already migrated, e.g. on every restart after
        # the first) is the expected, harmless outcome - anything else
        # re-raises, since that would be a real problem worth seeing.
        existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(station_delay_records)").fetchall()}
        for col in _FEATURE_COLUMNS:
            if col in existing_cols:
                continue
            try:
                conn.execute(f"ALTER TABLE station_delay_records ADD COLUMN {col} REAL")
            except sqlite3.OperationalError as e:
                if "duplicate column" not in str(e).lower():
                    raise


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


def _feature_columns_and_values(feature_values: Optional[dict]) -> "tuple[str, list]":
    """Shared helper: turns a delay_prediction.FEATURE_NAMES-keyed dict
    (delay_prediction.DelayPrediction.feature_values) into the
    ", feature_x = ?" SQL fragment and matching bind values for an UPDATE
    SET clause, or ("", []) when no feature vector was supplied (e.g. the
    ML ensemble call failed that poll, or an older caller not yet passing
    this through) - never fabricates a placeholder feature row."""
    if not feature_values:
        return "", []
    # feature_values keys are delay_prediction.FEATURE_NAMES entries
    # (e.g. "distance_km") - column names here are the same names
    # "feature_"-prefixed (see _FEATURE_COLUMNS above).
    name_map = {col[len("feature_"):]: col for col in _FEATURE_COLUMNS}
    frag_parts, vals = [], []
    for key, col in name_map.items():
        if key in feature_values and feature_values[key] is not None:
            frag_parts.append(col)
            vals.append(float(feature_values[key]))
    if not frag_parts:
        return "", []
    return frag_parts, vals


def record_station_prediction_vs_actual(
    train_number: str, date: str, station_code: str, station_name: Optional[str],
    predicted_delay_minutes: Optional[int], predicted_delay_confidence: Optional[str],
    predicted_delay_locked: bool, predicted_delay_grounded_via: Optional[str],
    actual_delay_minutes: Optional[int], scheduled_time: Optional[str], actual_time: Optional[str],
    sequence_index: Optional[int] = None, feature_values: Optional[dict] = None,
) -> None:
    """Upserts one station's predicted-vs-actual pair for one real-world
    run (train_number + date). Safe to call every poll once both figures
    are known — re-writing the SAME values is a harmless no-op, and a
    later call for the same station simply updates the row rather than
    duplicating it (UNIQUE(train_number, date, station_code)).

    `feature_values` (optional): the real ML feature vector this
    prediction was made from (delay_prediction.DelayPrediction.
    feature_values) — see the _FEATURE_COLUMNS comment above _init_db for
    why this is what makes a row usable for real retraining, not just for
    the accuracy chart. Only columns actually present and non-None in the
    dict are written — a partial/missing vector never overwrites a
    previously-recorded fuller one with NULLs."""
    train_number = str(train_number).strip()
    date = str(date).strip()
    station_code = str(station_code).strip().upper()
    if not train_number or not date or not station_code:
        return
    now = time.time()
    feat_cols, feat_vals = _feature_columns_and_values(feature_values)
    extra_insert_cols = ", " + ", ".join(feat_cols) if feat_cols else ""
    extra_insert_qs = ", " + ", ".join("?" for _ in feat_cols) if feat_cols else ""
    extra_update_set = ", " + ", ".join(f"{c} = excluded.{c}" for c in feat_cols) if feat_cols else ""
    with _connect() as conn:
        conn.execute(
            f"""
            INSERT INTO station_delay_records (
                train_number, date, station_code, station_name, sequence_index,
                predicted_delay_minutes, predicted_delay_confidence, predicted_delay_locked,
                predicted_delay_grounded_via, actual_delay_minutes, scheduled_time, actual_time,
                recorded_at{extra_insert_cols}
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?{extra_insert_qs})
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
                recorded_at = excluded.recorded_at{extra_update_set}
            """,
            (
                train_number, date, station_code, station_name, sequence_index,
                predicted_delay_minutes, predicted_delay_confidence, 1 if predicted_delay_locked else 0,
                predicted_delay_grounded_via, actual_delay_minutes, scheduled_time, actual_time,
                now, *feat_vals,
            ),
        )
    if _LOG_QUERIES:
        _logger.info(
            "WRITE upsert train=%s date=%s station=%s(%s) predicted=%s%s actual=%s scheduled=%s actual_time=%s features=%d",
            train_number, date, station_code, station_name or "?", predicted_delay_minutes,
            " [locked]" if predicted_delay_locked else "", actual_delay_minutes, scheduled_time, actual_time,
            len(feat_vals),
        )


def record_station_prediction(
    train_number: str, date: str, station_code: str, station_name: Optional[str],
    predicted_delay_minutes: Optional[int], predicted_delay_confidence: Optional[str],
    predicted_delay_locked: bool, predicted_delay_grounded_via: Optional[str],
    sequence_index: Optional[int] = None, feature_values: Optional[dict] = None,
) -> None:
    """
    FEATURE: durably record a station's PREDICTION the moment it's known —
    before the station has been reached, before there's any actual to pair
    it with yet.

    HONEST NOTE on why this exists: record_station_prediction_vs_actual()
    above only ever gets called once a station is BOTH predicted AND
    reached with a real actual, which — before this function existed —
    meant the prediction only ever survived in the caller's own in-memory
    `final_predictions` dict (see app.py's _snapshot_prediction_before_arrival/
    _sync_station_delay_history) for the lifetime of ONE WebSocket
    connection. In practice, real connections drop and reconnect
    constantly — a closed tab, a flaky network, Render's own free-tier
    idle behavior — so a station's prediction was routinely computed
    correctly while it was "upcoming", then lost the moment THAT specific
    connection dropped, before the station was actually reached. The next
    connection (even seconds later) would see the station already
    "reached" with no in-memory snapshot of its own, check history via
    get_station_record(), and find nothing — because nothing had ever been
    WRITTEN yet, only held in a now-gone connection's memory. Real symptom
    this caused: on a multi-hour journey with many reconnects, only the
    rare station whose full "upcoming -> reached" transition happened to
    fall entirely inside one unbroken connection ever got durably
    recorded — every other station, despite genuinely having a real
    predicted-vs-actual comparison computed for it at some point, stayed
    permanently unrecorded.

    This function closes that gap: call it every poll for every
    currently-"upcoming" reporting station with a known prediction (cheap,
    idempotent upsert — see record_station_prediction_vs_actual's own same
    reasoning). Once persisted, ANY future connection — even a brand new
    one — can pick up this prediction via get_station_record() once the
    station is finally reached, and pair it with the real actual.

    SAFETY: deliberately does NOT touch actual_delay_minutes/scheduled_time/
    actual_time on conflict (unlike record_station_prediction_vs_actual,
    which always overwrites them). This is what makes it safe to call
    on every single poll while a station is upcoming: even in an
    unexpected ordering (e.g. this fires again after a real actual was
    already recorded for this exact station), it can never clobber a real
    recorded actual with NULLs — it only ever refines the predicted half
    of the row, leaving whatever actual data already exists untouched.
    """
    train_number = str(train_number).strip()
    date = str(date).strip()
    station_code = str(station_code).strip().upper()
    if not train_number or not date or not station_code:
        return
    now = time.time()
    feat_cols, feat_vals = _feature_columns_and_values(feature_values)
    extra_insert_cols = ", " + ", ".join(feat_cols) if feat_cols else ""
    extra_insert_qs = ", " + ", ".join("?" for _ in feat_cols) if feat_cols else ""
    extra_update_set = ", " + ", ".join(f"{c} = excluded.{c}" for c in feat_cols) if feat_cols else ""
    with _connect() as conn:
        conn.execute(
            f"""
            INSERT INTO station_delay_records (
                train_number, date, station_code, station_name, sequence_index,
                predicted_delay_minutes, predicted_delay_confidence, predicted_delay_locked,
                predicted_delay_grounded_via, actual_delay_minutes, scheduled_time, actual_time,
                recorded_at{extra_insert_cols}
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?{extra_insert_qs})
            ON CONFLICT(train_number, date, station_code) DO UPDATE SET
                station_name = excluded.station_name,
                sequence_index = excluded.sequence_index,
                predicted_delay_minutes = excluded.predicted_delay_minutes,
                predicted_delay_confidence = excluded.predicted_delay_confidence,
                predicted_delay_locked = excluded.predicted_delay_locked,
                predicted_delay_grounded_via = excluded.predicted_delay_grounded_via,
                recorded_at = excluded.recorded_at{extra_update_set}
            """,
            (
                train_number, date, station_code, station_name, sequence_index,
                predicted_delay_minutes, predicted_delay_confidence, 1 if predicted_delay_locked else 0,
                predicted_delay_grounded_via, now, *feat_vals,
            ),
        )
    if _LOG_QUERIES:
        _logger.info(
            "WRITE pending-prediction upsert train=%s date=%s station=%s(%s) predicted=%s%s features=%d",
            train_number, date, station_code, station_name or "?", predicted_delay_minutes,
            " [locked]" if predicted_delay_locked else "", len(feat_vals),
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


def get_station_history_for_train(
    train_number: str, station_code: str, exclude_date: Optional[str] = None, limit: int = 12,
) -> List[dict]:
    """
    FEATURE: this exact train's own real recorded delay at this exact
    station, across OTHER real-world runs (other dates) that have already
    been recorded here. This is the real "does THIS station on THIS
    train's route tend to run later/earlier than the general trend would
    suggest" signal (e.g. a station right after a long single-line/ghat
    section, where trains often lose a few extra minutes regardless of
    how they were running before it) - see _predict_delay_per_reporting_
    station's historical_component in app.py for how this is blended in.

    Only rows with a REAL recorded actual_delay_minutes count (a row that's
    only ever seen a prediction, never an actual, tells us nothing about
    how this station really runs). `exclude_date` leaves out the run
    currently being predicted for, so a train's OWN in-progress run is
    never used to "predict" itself.

    Returns [] (never a guess) when this train+station combination has no
    real recorded history yet - which, for any train/station this store
    hasn't accumulated multiple real runs for yet, is the honest, expected
    answer, not a bug.
    """
    train_number = str(train_number).strip()
    station_code = str(station_code).strip().upper()
    if not train_number or not station_code:
        return []
    with _connect() as conn:
        if exclude_date:
            rows = conn.execute(
                """
                SELECT date, actual_delay_minutes, predicted_delay_minutes, recorded_at, feature_current_delay_minutes
                FROM station_delay_records
                WHERE train_number = ? AND station_code = ? AND date != ?
                  AND actual_delay_minutes IS NOT NULL
                ORDER BY recorded_at DESC
                LIMIT ?
                """,
                (train_number, station_code, str(exclude_date).strip(), limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT date, actual_delay_minutes, predicted_delay_minutes, recorded_at, feature_current_delay_minutes
                FROM station_delay_records
                WHERE train_number = ? AND station_code = ?
                  AND actual_delay_minutes IS NOT NULL
                ORDER BY recorded_at DESC
                LIMIT ?
                """,
                (train_number, station_code, limit),
            ).fetchall()
    result = [dict(r) for r in rows]
    if _LOG_QUERIES:
        _logger.info(
            "READ get_station_history_for_train train=%s station=%s exclude_date=%s -> %d row(s)",
            train_number, station_code, exclude_date, len(result),
        )
    return result


def get_all_records_for_training(min_actual_rows: int = 1) -> List[dict]:
    """
    FEATURE: every real (predicted, actual) pair this store has ever
    recorded, across every train/date/station - the raw material for
    retraining delay_prediction.py's ML ensemble on this app's OWN real
    logged outcomes instead of the synthetic dataset it ships with (see
    delay_prediction.py's train_on_real_history_if_available()). Only rows
    with a real actual_delay_minutes are returned - a row that's only ever
    seen a prediction is not a real training example (there is no known
    "correct answer" to learn from yet).

    `min_actual_rows` is a cheap short-circuit: pass the caller's own
    minimum-row threshold so this can return [] fast without building the
    full row list when there obviously isn't enough real data yet (the
    caller still re-checks len() itself - this is just an optimization for
    the "clearly not enough yet" case, not the source of truth for that
    decision).
    """
    with _connect() as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM station_delay_records WHERE actual_delay_minutes IS NOT NULL"
        ).fetchone()[0]
        if count < min_actual_rows:
            if _LOG_QUERIES:
                _logger.info("READ get_all_records_for_training -> %d row(s) (below min_actual_rows=%d, skipped fetch)", count, min_actual_rows)
            return []
        rows = conn.execute(
            f"""
            SELECT train_number, date, station_code, station_name, sequence_index,
                   predicted_delay_minutes, predicted_delay_confidence, predicted_delay_locked,
                   actual_delay_minutes, recorded_at, {", ".join(_FEATURE_COLUMNS)}
            FROM station_delay_records
            WHERE actual_delay_minutes IS NOT NULL
            ORDER BY recorded_at ASC
            """
        ).fetchall()
    result = [dict(r) for r in rows]
    if _LOG_QUERIES:
        _logger.info("READ get_all_records_for_training -> %d real row(s)", len(result))
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
