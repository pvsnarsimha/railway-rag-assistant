"""
push_store.py
-------------
FEATURE: Push Notifications for Proactive Alerts — persistence layer.

Every other "watchlist" feature in this app (Delay Alerts, PNR tracking)
deliberately keeps state client-side (localStorage/AsyncStorage) because
checking only happens while the app is open. Push notifications break
that pattern on purpose: a background job has to be able to see watches
and device tokens even when nobody has the app open, so this is the
first piece of server-side persistence in the project.

Kept intentionally simple — a single SQLite file, stdlib `sqlite3`, no
new service or ORM dependency. This is meant to comfortably hold
thousands of watches; if this app ever needs real multi-instance/
horizontally-scaled deployment, swap this file for a real DB, but
nothing else in the app needs to change since everything goes through
the functions below.

HONESTY NOTE: a "device token" here is whatever the frontend's Firebase
Cloud Messaging (FCM) SDK hands back after the user grants notification
permission in their browser/app. There's no login system in this project
(no user accounts anywhere else either), so a token IS the identity —
anyone holding a given browser/device's token can list/edit only the
watches tied to that token via the API below, but there is no password
or auth scheme beyond "you hold the token your own browser generated".
Fine for a personal/small-scale tool; call this out if this ever goes
to a wider audience with sensitive alerts.
"""

import os
import sqlite3
import time
from contextlib import contextmanager
from typing import List, Optional

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "push_data.db")


def _init_db():
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS device_tokens (
                token TEXT PRIMARY KEY,
                platform TEXT,
                created_at REAL NOT NULL,
                last_seen_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS watches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL,
                train_number TEXT NOT NULL,
                date TEXT,
                threshold_minutes INTEGER NOT NULL DEFAULT 15,
                repeat_minutes INTEGER NOT NULL DEFAULT 15,
                label TEXT,
                last_notified_delay INTEGER,
                last_notified_at REAL,
                created_at REAL NOT NULL,
                FOREIGN KEY(token) REFERENCES device_tokens(token)
            )
            """
        )
        # MIGRATION: a `watches` table created before the "repeat every N
        # min" feature existed won't have these two columns yet — SQLite's
        # CREATE TABLE IF NOT EXISTS above is a no-op against an existing
        # table, it doesn't add new columns to it. ALTER TABLE ADD COLUMN
        # is the idempotent way to backfill them; it fails with "duplicate
        # column name" on a table that already has them (a fresh table
        # created just above, or a second app instance racing this same
        # startup), which is exactly the case to swallow and move on from.
        for stmt in (
            "ALTER TABLE watches ADD COLUMN repeat_minutes INTEGER NOT NULL DEFAULT 15",
            "ALTER TABLE watches ADD COLUMN last_notified_at REAL",
            # FEATURE: one-shot "arriving in ~10 min, be alert" push per bell.
            "ALTER TABLE watches ADD COLUMN approach_notified_at REAL",
        ):
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError as e:
                if "duplicate column" not in str(e).lower():
                    raise
        conn.execute("CREATE INDEX IF NOT EXISTS idx_watches_token ON watches(token)")
        # FEATURE: bell auto-off. Once the train has really reached a bell's
        # station, that watch is RETIRED: deleted, and remembered here so a
        # later full re-sync from the device (the web page re-sends its whole
        # local list on every load) can't quietly bring it back and restart
        # the "already reached" notifications.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS retired_watches (
                token TEXT NOT NULL,
                train_number TEXT NOT NULL,
                date TEXT NOT NULL DEFAULT '',
                label TEXT NOT NULL DEFAULT '',
                retired_at REAL NOT NULL,
                PRIMARY KEY (token, train_number, date, label)
            )
            """
        )
        # FEATURE: Fare & Availability "Alert Zone" — same pattern as
        # `watches` above (delay alerts), a separate table since a fare
        # watch tracks a route/class/quota rather than just a train, and
        # dedupes on a real baseline fare + status rank rather than a
        # delay-minutes threshold. See alert_scheduler.py's fare-check
        # pass for how baseline_fare/last_notified_fare/last_notified_status
        # are used together.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fare_watches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL,
                train_number TEXT NOT NULL,
                source TEXT NOT NULL,
                dest TEXT NOT NULL,
                date TEXT,
                travel_class TEXT NOT NULL DEFAULT 'SL',
                quota TEXT NOT NULL DEFAULT 'GN',
                threshold_pct INTEGER NOT NULL DEFAULT 10,
                label TEXT,
                baseline_fare REAL,
                last_notified_fare REAL,
                last_notified_status TEXT,
                created_at REAL NOT NULL,
                FOREIGN KEY(token) REFERENCES device_tokens(token)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_fare_watches_token ON fare_watches(token)")
        # FEATURE: Background-surviving Smart Alarm — same "server-side
        # mirror of a client watch" pattern as `watches`/`fare_watches`
        # above. The in-tab Smart Alarm (see smart_features.py /
        # ltAlarmForm in app.js) only works while the tab stays open/
        # backgrounded; this table lets alert_scheduler.py's background
        # job (and the live-tracking websocket trigger) fire the SAME
        # real /api/advanced/smart-alarm check even after the tab/app is
        # fully closed, via a push notification instead of a browser
        # Notification. `fired` is a one-shot flag (0/1), not a repeating
        # dedupe like delay watches — an arrival alarm should only ever
        # notify once per (train, date, station) arm, not on every tick
        # it stays "due".
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS alarm_watches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL,
                train_number TEXT NOT NULL,
                date TEXT,
                station TEXT NOT NULL,
                lead_minutes REAL NOT NULL DEFAULT 10,
                label TEXT,
                fired INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                FOREIGN KEY(token) REFERENCES device_tokens(token)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_alarm_watches_token ON alarm_watches(token)")
        # FEATURE: background Live Tracking (RailYatri-style). One row per
        # (device, train, date) the user was tracking when they closed the
        # app — alert_scheduler.run_tracking_check_once keeps pushing a
        # silent, in-place running-status update for it ("Crossed X at
        # HH:MM · N km to Y") until the journey completes, the user taps
        # Stop, or the row expires. last_signature dedupes: a push only
        # goes out when the train has really moved on (new crossed point /
        # next halt / delay moved 5+ min) or on a slow refresh cadence.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tracking_watches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL,
                train_number TEXT NOT NULL,
                date TEXT,
                source TEXT,
                dest TEXT,
                last_signature TEXT,
                last_pushed_at REAL,
                created_at REAL NOT NULL,
                UNIQUE(token, train_number, date)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tracking_watches_token ON tracking_watches(token)")


@contextmanager
def _connect():
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def register_token(token: str, platform: Optional[str] = None) -> None:
    """Insert or refresh a device token's last_seen_at (upsert)."""
    now = time.time()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO device_tokens (token, platform, created_at, last_seen_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(token) DO UPDATE SET last_seen_at = excluded.last_seen_at,
                                              platform = COALESCE(excluded.platform, device_tokens.platform)
            """,
            (token, platform, now, now),
        )


def unregister_token(token: str) -> None:
    """Drop a token and every watch (delay, fare AND alarm) tied to it (e.g.
    user disabled notifications, or a dead token was cleaned up after a
    failed push — see alert_scheduler.py's dead-token cleanup on the delay,
    fare AND alarm check passes)."""
    with _connect() as conn:
        conn.execute("DELETE FROM watches WHERE token = ?", (token,))
        conn.execute("DELETE FROM fare_watches WHERE token = ?", (token,))
        conn.execute("DELETE FROM alarm_watches WHERE token = ?", (token,))
        conn.execute("DELETE FROM tracking_watches WHERE token = ?", (token,))
        conn.execute("DELETE FROM retired_watches WHERE token = ?", (token,))
        conn.execute("DELETE FROM device_tokens WHERE token = ?", (token,))


# Per-device cap on delay watches — generous enough for many trains and
# many stations per train; only exists to bound a runaway client.
MAX_WATCHES_PER_DEVICE = 100


def replace_watches(token: str, watches: List[dict]) -> None:
    """
    Replace the FULL watch set for one token in a single transaction — the
    frontend always sends its complete current local watchlist (same
    pattern as the client-side localStorage list), so mirroring that
    wholesale is simpler and less error-prone than diffing add/remove
    calls, and it's small data (a handful of watches per person, capped
    at 8 to match the existing /api/advanced/alerts/check cap).
    """
    with _connect() as conn:
        # Keyed by (train_number, date, label), not train_number alone —
        # two watches can share a train number (different date and/or
        # label), and keying by train_number alone let one watch's
        # notification-dedup state leak onto an unrelated watch for the
        # same number (fixed after a real report of predictions/dedup
        # state bleeding across watches sharing a train number).
        existing = {
            (row["train_number"], row["date"], (row["label"] or "").strip().upper() or None):
                (row["last_notified_delay"], row["last_notified_at"], row["approach_notified_at"])
            for row in conn.execute(
                "SELECT train_number, date, label, last_notified_delay, last_notified_at, approach_notified_at "
                "FROM watches WHERE token = ?",
                (token,),
            )
        }
        # Bells already auto-switched-off (station reached) stay off even if
        # the device re-sends them. Old entries (runs long over) are purged.
        conn.execute("DELETE FROM retired_watches WHERE retired_at < ?", (time.time() - 4 * 86400,))
        retired = {
            (row["train_number"], row["date"], row["label"])
            for row in conn.execute(
                "SELECT train_number, date, label FROM retired_watches WHERE token = ?", (token,),
            )
        }
        conn.execute("DELETE FROM watches WHERE token = ?", (token,))
        now = time.time()
        # BUGFIX ("notifications only for a single train"): this used to
        # keep only the FIRST 8 watches in the list — the oldest ones — so
        # once a device had armed 8 station bells in total, every bell
        # armed after that (usually on a different train) was silently
        # dropped and never notified. Now: one row per (train, date,
        # station) — the latest settings win — and up to MAX_WATCHES_PER_
        # DEVICE of the NEWEST are kept, so any number of trains/stations
        # (same or different) work side by side.
        deduped = {}
        for w in watches:
            train_number = str(w.get("train_number", "")).strip()
            if not train_number:
                continue
            key = (train_number, w.get("date"), (w.get("label") or "").strip().upper() or None)
            if (key[0], key[1] or "", key[2] or "") in retired:
                continue  # station already reached — this bell was auto-switched off
            deduped.pop(key, None)
            deduped[key] = w
        for w in list(deduped.values())[-MAX_WATCHES_PER_DEVICE:]:
            train_number = str(w.get("train_number", "")).strip()
            # Preserve last_notified_delay/last_notified_at across a
            # "replace" for a train that was already being watched, so
            # re-saving the same watchlist (e.g. after editing an
            # unrelated watch, or updating this one's threshold/repeat
            # cadence from DelayAlertModal) doesn't re-fire a notification
            # early — see alert_scheduler.py's repeat-interval gate, which
            # depends on last_notified_at surviving a replace.
            carried_delay, carried_at, carried_approach = existing.get(
                (train_number, w.get("date"), (w.get("label") or "").strip().upper() or None), (None, None, None))
            conn.execute(
                """
                INSERT INTO watches (
                    token, train_number, date, threshold_minutes, repeat_minutes,
                    label, last_notified_delay, last_notified_at, created_at, approach_notified_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    token,
                    train_number,
                    w.get("date"),
                    int(w.get("threshold_minutes") or 15),
                    int(w.get("repeat_minutes") or w.get("threshold_minutes") or 15),
                    w.get("label"),
                    carried_delay,
                    carried_at,
                    now,
                    carried_approach,
                ),
            )


def list_watches_for_token(token: str) -> List[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM watches WHERE token = ?", (token,)).fetchall()
        return [dict(r) for r in rows]


def list_all_watches_with_tokens() -> List[dict]:
    """Used by the background scheduler — every watch across every registered device."""
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM watches").fetchall()
        return [dict(r) for r in rows]


def list_watches_for_train(train_number: str, date: Optional[str] = None) -> List[dict]:
    """
    Used by the LIVE-TRACKING trigger (see alert_scheduler.check_and_push_for_train):
    every stored watch for this exact train, across every registered device,
    regardless of that watch's own saved date filter — a live tracking session
    is always for one real, currently-running instance of the train, so any
    watch on that train number is relevant to it. The watch's own `date` is
    still carried through in the returned rows for display/labeling, it's
    just not used to exclude matches here (unlike the interval scheduler,
    which is checking many trains it has no live session open for).
    """
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM watches WHERE train_number = ?", (str(train_number).strip(),)
        ).fetchall()
        return [dict(r) for r in rows]


def mark_notified(watch_id: int, delay_minutes: int) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE watches SET last_notified_delay = ?, last_notified_at = ? WHERE id = ?",
            (delay_minutes, time.time(), watch_id),
        )


def mark_approach_notified(watch_id: int) -> None:
    """The one-shot "arriving in ~10 min" push went out for this bell."""
    with _connect() as conn:
        conn.execute("UPDATE watches SET approach_notified_at = ? WHERE id = ?", (time.time(), watch_id))


def retire_watch(watch: dict) -> None:
    """FEATURE: bell auto-off — the train has really reached this watch's
    station. Deletes the watch and remembers it as retired so a later
    re-sync of the device's local list can't resurrect it."""
    label = (watch.get("label") or "").strip().upper()
    with _connect() as conn:
        conn.execute("DELETE FROM watches WHERE id = ?", (watch["id"],))
        conn.execute(
            "INSERT OR REPLACE INTO retired_watches (token, train_number, date, label, retired_at) VALUES (?, ?, ?, ?, ?)",
            (watch["token"], str(watch["train_number"]).strip(), watch.get("date") or "", label, time.time()),
        )


def list_retired_for_token(token: str) -> List[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT train_number, date, label, retired_at FROM retired_watches WHERE token = ?", (token,),
        ).fetchall()
        return [dict(r) for r in rows]


def stats() -> dict:
    with _connect() as conn:
        token_count = conn.execute("SELECT COUNT(*) FROM device_tokens").fetchone()[0]
        watch_count = conn.execute("SELECT COUNT(*) FROM watches").fetchone()[0]
        fare_watch_count = conn.execute("SELECT COUNT(*) FROM fare_watches").fetchone()[0]
        alarm_watch_count = conn.execute("SELECT COUNT(*) FROM alarm_watches").fetchone()[0]
    return {
        "registered_devices": token_count, "active_watches": watch_count,
        "active_fare_watches": fare_watch_count, "active_alarm_watches": alarm_watch_count,
    }


# =============================================================================
# FEATURE: Fare & Availability "Alert Zone" — same "replace the full set"
# pattern as replace_watches above, and the same reasoning: the frontend
# always sends its complete current local fare-watchlist, so mirroring
# that wholesale is simpler than diffing add/remove calls, and it's small
# data (capped at 8 per token, same cap as delay watches).
# =============================================================================
def replace_fare_watches(token: str, watches: List[dict]) -> None:
    with _connect() as conn:
        # Keyed by (train_number, source, dest, date, travel_class, quota,
        # label) so two watches on the same train but a different class/
        # route/label don't bleed their notified-state into each other —
        # same reasoning as replace_watches' key above.
        existing = {
            (row["train_number"], row["source"], row["dest"], row["date"], row["travel_class"], row["quota"], row["label"]):
                (row["baseline_fare"], row["last_notified_fare"], row["last_notified_status"])
            for row in conn.execute(
                "SELECT train_number, source, dest, date, travel_class, quota, label, baseline_fare, last_notified_fare, last_notified_status "
                "FROM fare_watches WHERE token = ?", (token,)
            )
        }
        conn.execute("DELETE FROM fare_watches WHERE token = ?", (token,))
        now = time.time()
        for w in watches[:8]:
            train_number = str(w.get("train_number", "")).strip()
            source = str(w.get("source", "")).strip().upper()
            dest = str(w.get("dest", "")).strip().upper()
            if not train_number or not source or not dest:
                continue
            travel_class = str(w.get("travel_class") or "SL").strip().upper()
            quota = str(w.get("quota") or "GN").strip().upper()
            key = (train_number, source, dest, w.get("date"), travel_class, quota, w.get("label"))
            carried = existing.get(key)
            baseline_fare = w.get("baseline_fare")
            last_notified_fare, last_notified_status = (carried[1], carried[2]) if carried else (None, None)
            if carried and baseline_fare is None:
                baseline_fare = carried[0]  # preserve the original baseline across a re-save
            conn.execute(
                """
                INSERT INTO fare_watches (token, train_number, source, dest, date, travel_class, quota,
                                           threshold_pct, label, baseline_fare, last_notified_fare,
                                           last_notified_status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    token, train_number, source, dest, w.get("date"), travel_class, quota,
                    int(w.get("threshold_pct") or 10), w.get("label"), baseline_fare,
                    last_notified_fare, last_notified_status, now,
                ),
            )


def list_fare_watches_for_token(token: str) -> List[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM fare_watches WHERE token = ?", (token,)).fetchall()
        return [dict(r) for r in rows]


def list_all_fare_watches_with_tokens() -> List[dict]:
    """Used by alert_scheduler.py's background fare-check pass."""
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM fare_watches").fetchall()
        return [dict(r) for r in rows]


def mark_fare_notified(watch_id: int, fare: Optional[float], status_kind: Optional[str]) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE fare_watches SET last_notified_fare = ?, last_notified_status = ? WHERE id = ?",
            (fare, status_kind, watch_id),
        )


# =============================================================================
# FEATURE: Background-surviving Smart Alarm — same "replace the full set"
# pattern as replace_watches/replace_fare_watches above. One arm = one row;
# `fired` resets to 0 whenever the SAME (train_number, date, station, label)
# arm is re-saved fresh (e.g. user re-armed it after it already fired, or
# the frontend re-syncs an unrelated change) is intentionally NOT carried
# over — an explicit re-save of the watchlist is treated as "arm again",
# unlike the "preserve state across a passive re-save" reasoning the other
# two watch types use, since an alarm firing is a one-shot event the user
# is very likely re-arming on purpose (e.g. a new day's run of the same
# train number).
# =============================================================================
def replace_alarm_watches(token: str, watches: List[dict]) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM alarm_watches WHERE token = ?", (token,))
        now = time.time()
        for w in watches[:8]:
            train_number = str(w.get("train_number", "")).strip()
            station = str(w.get("station", "")).strip().upper()
            if not train_number or not station:
                continue
            conn.execute(
                """
                INSERT INTO alarm_watches (token, train_number, date, station, lead_minutes, label, fired, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, ?)
                """,
                (
                    token, train_number, w.get("date"), station,
                    float(w.get("lead_minutes") or 10), w.get("label"), now,
                ),
            )


def list_alarm_watches_for_token(token: str) -> List[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM alarm_watches WHERE token = ?", (token,)).fetchall()
        return [dict(r) for r in rows]


def list_all_alarm_watches_with_tokens() -> List[dict]:
    """Used by alert_scheduler.py's background alarm-check pass."""
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM alarm_watches WHERE fired = 0").fetchall()
        return [dict(r) for r in rows]


def list_alarm_watches_for_train(train_number: str) -> List[dict]:
    """Used by the LIVE-TRACKING trigger (mirrors list_watches_for_train) —
    every not-yet-fired alarm for this exact train, across every registered
    device, so a session someone has open right now can fire the push the
    instant the live ETA says it's due instead of waiting for the interval
    scheduler's next tick."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM alarm_watches WHERE train_number = ? AND fired = 0", (str(train_number).strip(),)
        ).fetchall()
        return [dict(r) for r in rows]


def mark_alarm_fired(watch_id: int) -> None:
    with _connect() as conn:
        conn.execute("UPDATE alarm_watches SET fired = 1 WHERE id = ?", (watch_id,))


_init_db()


# =============================================================================
# FEATURE: background Live Tracking watches (see tracking_watches above).
# A device tracks at most a few trains at once; starting to track a train
# upserts its row (keeping dedupe state if it already existed), Stop deletes it.
# =============================================================================
MAX_TRACKING_PER_DEVICE = 3
TRACKING_WATCH_MAX_AGE_SECONDS = 3 * 24 * 3600  # a multi-day run still fits


def upsert_tracking_watch(token: str, train_number: str, date: Optional[str],
                          source: Optional[str] = None, dest: Optional[str] = None) -> None:
    train_number = str(train_number or "").strip()
    if not token or not train_number:
        return
    now = time.time()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO tracking_watches (token, train_number, date, source, dest, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(token, train_number, date) DO UPDATE SET
                source = excluded.source, dest = excluded.dest
            """,
            (token, train_number, date or None, source or None, dest or None, now),
        )
        # Keep only the most recent few per device.
        rows = conn.execute(
            "SELECT id FROM tracking_watches WHERE token = ? ORDER BY created_at DESC", (token,)
        ).fetchall()
        for r in rows[MAX_TRACKING_PER_DEVICE:]:
            conn.execute("DELETE FROM tracking_watches WHERE id = ?", (r["id"],))


def delete_tracking_watch(token: str, train_number: Optional[str] = None, date: Optional[str] = None) -> int:
    with _connect() as conn:
        if train_number is None:
            cur = conn.execute("DELETE FROM tracking_watches WHERE token = ?", (token,))
        elif date is None:
            cur = conn.execute("DELETE FROM tracking_watches WHERE token = ? AND train_number = ?",
                               (token, str(train_number).strip()))
        else:
            cur = conn.execute(
                "DELETE FROM tracking_watches WHERE token = ? AND train_number = ? AND (date = ? OR date IS NULL)",
                (token, str(train_number).strip(), date),
            )
        return cur.rowcount


def delete_tracking_watch_by_id(watch_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM tracking_watches WHERE id = ?", (watch_id,))


def list_tracking_watches_for_token(token: str) -> List[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM tracking_watches WHERE token = ?", (token,)).fetchall()
        return [dict(r) for r in rows]


def list_all_tracking_watches() -> List[dict]:
    """Used by alert_scheduler.run_tracking_check_once. Expired rows are
    pruned here so a forgotten watch can't push forever."""
    cutoff = time.time() - TRACKING_WATCH_MAX_AGE_SECONDS
    with _connect() as conn:
        conn.execute("DELETE FROM tracking_watches WHERE created_at < ?", (cutoff,))
        rows = conn.execute("SELECT * FROM tracking_watches").fetchall()
        return [dict(r) for r in rows]


def count_tracking_watches() -> int:
    with _connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM tracking_watches").fetchone()[0]


def mark_tracking_pushed(watch_id: int, signature: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE tracking_watches SET last_signature = ?, last_pushed_at = ? WHERE id = ?",
            (signature, time.time(), watch_id),
        )
