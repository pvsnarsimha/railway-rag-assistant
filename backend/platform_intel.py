"""
platform_intel.py
-----------------
Platform pipeline: licensed/live source -> adaptive poller -> cache + history
of changes -> comparison with history, the ML/pattern prediction and
passenger reports -> confidence label -> WebSocket + push.

  * locate_platform() (station_tools) is the live source (station board,
    RailRadar). process() is called on every result, however it was fetched.
  * poll_due() is the poller, run every minute by alert_scheduler: each
    watched / recently-viewed (train, station) is re-checked on its OWN
    cadence — every 15 min far out, every minute in the last 20 min.
  * Every observation is stored (platform_obs); a change is a new row, so the
    table is also the history of changes and the "usual platform" source.
  * The cache is Redis when REDIS_URL is set (and `redis` is installed),
    otherwise a process-local dict. Both hold the latest compact snapshot.
  * assess() compares live vs history vs the pattern model vs user reports
    and attaches a confidence label (see LEVELS).
"""

import json
import logging
import os
import threading
import time
from collections import Counter
from typing import Callable, Dict, List, Optional, Tuple

import push_store

logger = logging.getLogger("platform_intel")

CACHE_TTL_SECONDS = 180
TOUCH_TTL_SECONDS = 10 * 60          # a viewer (screen/WebSocket) keeps a pair polled this long
REPORT_WINDOW_SECONDS = 3 * 3600
MIN_HISTORY_DAYS = 3
MIN_REPORTERS = 2
STOP_POLLING_AFTER_MIN = -15         # train is >15 min past its arrival

# label shown in the app, per level (most to least trustworthy)
LEVELS = {
    "confirmed": "Confirmed by station",
    "high": "High confidence",
    "likely": "Likely",
    "reported": "Reported by passengers",
    "history": "Usual platform",
    "estimate": "Estimate only",
}


# --------------------------------------------------------------------- cache
class _Cache:
    def __init__(self):
        self._mem: Dict[str, Tuple[float, str]] = {}
        self._lock = threading.Lock()
        self._redis = None
        url = (os.environ.get("REDIS_URL") or "").strip()
        if url:
            try:
                import redis  # type: ignore
                self._redis = redis.Redis.from_url(url, socket_timeout=2)
                self._redis.ping()
            except Exception as e:  # noqa: BLE001
                logger.warning("Redis unavailable (%s) — using the in-process cache.", e)
                self._redis = None

    def set(self, key: str, value: dict, ttl: int = CACHE_TTL_SECONDS) -> None:
        raw = json.dumps(value)
        if self._redis is not None:
            try:
                self._redis.setex(f"platform:{key}", ttl, raw)
                return
            except Exception:  # noqa: BLE001
                pass
        with self._lock:
            self._mem[key] = (time.time() + ttl, raw)

    def get(self, key: str) -> Optional[dict]:
        if self._redis is not None:
            try:
                raw = self._redis.get(f"platform:{key}")
                return json.loads(raw) if raw else None
            except Exception:  # noqa: BLE001
                pass
        with self._lock:
            hit = self._mem.get(key)
            if not hit or hit[0] < time.time():
                self._mem.pop(key, None)
                return None
            return json.loads(hit[1])


cache = _Cache()
_touched: Dict[Tuple[str, str], float] = {}
_next_due: Dict[Tuple[str, str], float] = {}
_state_lock = threading.Lock()


def _key(train: str, station: str) -> str:
    return f"{str(train).strip()}:{str(station).strip().upper()}"


def _today() -> str:
    import station_tools
    return station_tools.ist_now().strftime("%Y-%m-%d")


def touch(train: str, station: str) -> None:
    """Someone is looking at this pair — keep it in the poll set."""
    with _state_lock:
        _touched[(str(train).strip(), str(station).strip().upper())] = time.time()


def cached(train: str, station: str) -> Optional[dict]:
    return cache.get(_key(train, station))


# ------------------------------------------------------------------- storage
def init_db() -> None:
    with push_store._connect() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS platform_obs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, train_number TEXT NOT NULL, station TEXT NOT NULL,
                day TEXT NOT NULL, platform TEXT NOT NULL, source TEXT, observed_at REAL NOT NULL)"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_platform_obs ON platform_obs(train_number, station, day)")
        conn.execute(
            """CREATE TABLE IF NOT EXISTS platform_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT, train_number TEXT NOT NULL, station TEXT NOT NULL,
                day TEXT NOT NULL, platform TEXT NOT NULL, reporter TEXT NOT NULL, reported_at REAL NOT NULL,
                UNIQUE(train_number, station, day, reporter))"""
        )


init_db()


def record_observation(train: str, station: str, platform: str, source: str) -> bool:
    """Stores a REAL observation (never a pattern estimate). A row is added
    only when the platform differs from the last one seen today, so the table
    is the history of changes. Returns True when this was a change."""
    if not platform or source == "estimate":
        return False
    day = _today()
    with push_store._connect() as conn:
        last = conn.execute(
            "SELECT platform FROM platform_obs WHERE train_number=? AND station=? AND day=? ORDER BY id DESC LIMIT 1",
            (train, station, day)).fetchone()
        if last and last["platform"] == platform:
            return False
        conn.execute(
            "INSERT INTO platform_obs (train_number, station, day, platform, source, observed_at) VALUES (?,?,?,?,?,?)",
            (train, station, day, platform, source, time.time()))
        return last is not None


def history_usual(train: str, station: str) -> Optional[dict]:
    """The platform this train usually gets here: the last real platform of
    each PREVIOUS day, most common one. None until MIN_HISTORY_DAYS days."""
    with push_store._connect() as conn:
        rows = conn.execute(
            """SELECT day, platform FROM platform_obs WHERE train_number=? AND station=? AND day<>?
               AND id IN (SELECT MAX(id) FROM platform_obs WHERE train_number=? AND station=? GROUP BY day)""",
            (train, station, _today(), train, station)).fetchall()
    if len(rows) < MIN_HISTORY_DAYS:
        return None
    plat, n = Counter(r["platform"] for r in rows).most_common(1)[0]
    return {"platform": plat, "days": len(rows), "agree": n}


def change_log(train: str, station: str, limit: int = 10) -> List[dict]:
    with push_store._connect() as conn:
        rows = conn.execute(
            "SELECT day, platform, source, observed_at FROM platform_obs WHERE train_number=? AND station=? "
            "ORDER BY id DESC LIMIT ?", (train, station, limit)).fetchall()
    return [dict(r) for r in rows]


def add_report(train: str, station: str, platform: str, reporter: str) -> None:
    with push_store._connect() as conn:
        conn.execute(
            """INSERT INTO platform_reports (train_number, station, day, platform, reporter, reported_at)
               VALUES (?,?,?,?,?,?) ON CONFLICT(train_number, station, day, reporter)
               DO UPDATE SET platform=excluded.platform, reported_at=excluded.reported_at""",
            (train, station, _today(), platform, reporter, time.time()))


def recent_reports(train: str, station: str) -> dict:
    with push_store._connect() as conn:
        rows = conn.execute(
            "SELECT platform FROM platform_reports WHERE train_number=? AND station=? AND day=? AND reported_at>?",
            (train, station, _today(), time.time() - REPORT_WINDOW_SECONDS)).fetchall()
    if not rows:
        return {"count": 0, "platform": None, "agree": 0}
    plat, n = Counter(r["platform"] for r in rows).most_common(1)[0]
    return {"count": len(rows), "platform": plat, "agree": n}


# ----------------------------------------------------------------- assessing
def assess(res: dict) -> dict:
    """Compares the live platform with history, the pattern/ML estimate and
    passenger reports, and returns {level, label, platform, reasons, ...}."""
    train, station = res["train_number"], res["station"]
    live = str(res.get("platform") or "").strip() or None
    source = res.get("platform_source") or "estimate"
    is_live = source != "estimate"
    usual = history_usual(train, station)
    reports = recent_reports(train, station)
    rep_plat = reports["platform"] if reports["agree"] >= MIN_REPORTERS else None
    reasons: List[str] = []
    platform, level = live, "estimate"

    if source.startswith("station_board"):
        level = "confirmed"
        reasons.append("The station's own board shows this platform.")
    elif is_live:
        level = "likely"
        reasons.append("Live allocation from RailRadar.")
        agree_hist = usual and usual["platform"] == live
        agree_rep = rep_plat == live
        if agree_hist or agree_rep:
            level = "high"
            if agree_hist:
                reasons.append(f"Matches its usual platform ({usual['agree']} of {usual['days']} recent days).")
            if agree_rep:
                reasons.append(f"{reports['agree']} passengers report the same platform.")
    elif rep_plat:
        platform, level = rep_plat, "reported"
        reasons.append(f"{reports['agree']} passengers report PF {rep_plat}; no live source yet.")
    elif usual and usual["agree"] >= 2:
        platform, level = usual["platform"], "history"
        reasons.append(f"Usually PF {usual['platform']} ({usual['agree']} of {usual['days']} recent days); no live source yet.")
    else:
        reasons.append("No live source yet — pattern estimate only.")

    notes = []
    if is_live and usual and usual["platform"] != live:
        notes.append(f"Differs from its usual PF {usual['platform']}.")
    if is_live and rep_plat and rep_plat != live:
        notes.append(f"{reports['agree']} passengers report PF {rep_plat} instead.")
    return {
        "level": level, "label": LEVELS[level], "platform": platform,
        "reasons": reasons, "warnings": notes,
        "candidates": {
            "live": live if is_live else None,
            "history": usual,
            "model": live if not is_live else None,
            "reports": reports if reports["count"] else None,
        },
    }


def process(res: dict) -> dict:
    """Run on every locate_platform() result: record it, assess it, attach
    `confidence`, use the better platform when the live one is only an
    estimate, and cache a compact snapshot for the WebSocket / poller."""
    try:
        train, station = res["train_number"], res["station"]
        changed = record_observation(train, station, str(res.get("platform") or ""), res.get("platform_source") or "estimate")
        conf = assess(res)
        res["model_platform"] = res.get("platform") if res.get("platform_source") == "estimate" else None
        if conf["platform"] and conf["platform"] != res.get("platform"):
            res["platform"] = conf["platform"]
            res["platform_source"] = "history" if conf["level"] == "history" else "passenger_reports"
        res["confidence"] = conf
        res["platform_changed_today"] = changed
        res["platform_changes"] = change_log(train, station, 5)
        snap = {k: res.get(k) for k in (
            "train_number", "train_name", "station", "station_name", "platform", "platform_source",
            "scheduled_arrival", "expected_arrival", "delay_minutes", "arrives_in_minutes", "cancelled", "checked_at")}
        snap["confidence"] = conf
        snap["updated_at"] = time.time()
        cache.set(_key(train, station), snap)
    except Exception as e:  # noqa: BLE001 - never break the lookup itself
        logger.warning("platform_intel.process failed: %s", e)
    return res


# -------------------------------------------------------------------- poller
def _interval_seconds(minutes_to_arrival: Optional[float]) -> int:
    """Checks more often as the train gets close: platforms are most likely
    to be (re)allocated in the last half hour."""
    if minutes_to_arrival is None:
        return 10 * 60
    if minutes_to_arrival > 180:
        return 15 * 60
    if minutes_to_arrival > 60:
        return 10 * 60
    if minutes_to_arrival > 20:
        return 5 * 60
    return 60


def poll_due(locate_fn: Callable[[str, str, Optional[str]], dict]) -> Dict[Tuple[str, str], dict]:
    """One poller tick. Refreshes every watched / recently-viewed pair that is
    due, and returns {(train, station): result} for the ones refreshed."""
    now = time.time()
    pairs: Dict[Tuple[str, str], Optional[str]] = {}
    for w in push_store.list_all_platform_watches():
        pairs[(w["train_number"], w["station"])] = w.get("date")
    with _state_lock:
        for k, t in list(_touched.items()):
            if now - t > TOUCH_TTL_SECONDS:
                del _touched[k]
            else:
                pairs.setdefault(k, None)
        for k in [k for k in _next_due if k not in pairs]:
            del _next_due[k]
    out: Dict[Tuple[str, str], dict] = {}
    for pair, date in pairs.items():
        if _next_due.get(pair, 0) > now:
            continue
        try:
            res = process(locate_fn(pair[0], pair[1], date))
        except Exception as e:  # noqa: BLE001
            logger.warning("poll %s failed: %s", pair, e)
            _next_due[pair] = now + 120
            continue
        mins = res.get("arrives_in_minutes")
        if mins is not None and mins < STOP_POLLING_AFTER_MIN:
            _next_due[pair] = now + 3600       # long gone — barely check
        else:
            _next_due[pair] = now + _interval_seconds(mins)
        out[pair] = res
    return out
