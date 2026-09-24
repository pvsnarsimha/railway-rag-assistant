"""
quick_live.py
-------------
FEATURE ("on internet it takes a lot of time to show live tracking the first
time — use RailRadar / RapidAPI"): a FAST first frame for /ws/track.

Why the first frame was slow: the full live-tracking poll goes backend ->
railkit-service (a SEPARATE Render free-tier service that falls asleep and
needs ~30-60s to wake) -> RailKit, and only then runs the whole prediction
pipeline (weather, speed, RailRadar cross-checks, ML delay, ...) before the
first message is sent. So the screen sat on "loading" for a long time.

This module builds a complete, lighter payload (same shape the screen
already renders: timeline, timeline_grouped, current/next station, lat/lng,
km to next, ETA) straight from providers the backend calls DIRECTLY, with
no railkit-service hop:
  RailRadar live (api.railradar.in — real crowdsourced GPS position,
  segment progress between stations, live speed). RapidAPI is NOT used for
  live tracking; if RailRadar has nothing, the full poll uses RailKit.
It is sent the moment the socket opens; the full RailKit-based poll then
replaces it seamlessly. The same builder is the fallback whenever RailKit /
railkit-service fails mid-session, so the screen keeps moving on RailRadar
instead of going blank (RailRadar -> RailKit only).

Nothing here is invented: every station, time and position comes from the
provider response; anything missing stays None.
"""

import re
from datetime import datetime, timezone
from typing import Optional

import gps_tracking
import railradar_fallback
import running_status

_HHMM = re.compile(r"(\d{1,2}):(\d{2})")


def _hhmm(v) -> Optional[str]:
    m = _HHMM.search(str(v or ""))
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else None


def _int(v) -> Optional[int]:
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def _first(d: dict, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d.get(k)
    return None


def build_quick_payload(train_number: str, date_ddmmyyyy: Optional[str] = None) -> Optional[dict]:
    """Fast live payload from RailRadar ONLY (no RapidAPI — "99% RailRadar,
    1% RailKit"). None if RailRadar has no data; the full poll then falls
    back to RailKit."""
    source = "railradar"
    rr = railradar_primary(train_number, date_ddmmyyyy, force_ignore_flag=True)
    if rr is None:
        return None
    stops, _pos, _start, _fetched = rr
    train_name = _pos.train_name if _pos else None

    try:
        gps_tracking.finalize_timeline_stops(stops)
    except Exception:  # noqa: BLE001
        pass
    timeline = gps_tracking.timeline_to_json(stops)

    seg = {}
    speed = None
    if source == "railradar":
        try:
            seg = railradar_fallback.get_segment_progress(train_number) or {}
        except Exception:  # noqa: BLE001
            seg = {}
        try:
            speed, _note = railradar_fallback.get_live_speed_kmph(train_number)
        except Exception:  # noqa: BLE001
            speed = None
    try:
        interp_km, lat, lng = gps_tracking.interpolate_live_position(timeline, seg.get("segment_progress"))
    except Exception:  # noqa: BLE001
        interp_km, lat, lng = None, None, None
    cur_km = interp_km if interp_km is not None else gps_tracking.current_position_distance_km(timeline)

    cur_idx = -1
    for i, s in enumerate(timeline):
        if s.get("status") in ("current", "passed"):
            cur_idx = i
    cur = timeline[cur_idx] if cur_idx >= 0 else None
    nxt = timeline[cur_idx + 1] if cur_idx + 1 < len(timeline) else None
    if lat is None and cur is not None:
        lat, lng = cur.get("lat"), cur.get("lng")

    eta_speed = speed if speed and speed > 10 else None
    try:
        # Physics-checked ETAs for every upcoming stop (see app.py's
        # _sanitize_upcoming_etas — same rule, inlined to avoid importing app).
        now = running_status.ist_now()
        for s in timeline:
            if s.get("status") != "upcoming" or cur_km is None:
                continue
            d = gps_tracking._distance_km_value(s.get("distance_km"))
            if d is None or d < cur_km - 0.5:
                continue
            km = max(0.0, d - cur_km)
            arr = s.get("arrival") or {}
            info = running_status.sane_eta(arr.get("expected") or arr.get("scheduled"), km, eta_speed, now)
            s["distance_ahead_km"] = round(km, 1)
            s["minutes_away"] = round(info["minutes"]) if info["minutes"] is not None else None
            if info["eta"]:
                s["predicted_eta"] = info["eta"]
                if info["source"] == "distance":
                    s["predicted_eta_source"] = "distance"
    except Exception:  # noqa: BLE001
        pass

    km_to_next = None
    if nxt is not None and cur_km is not None:
        d = gps_tracking._distance_km_value(nxt.get("distance_km"))
        if d is not None:
            km_to_next = round(max(0.0, d - cur_km), 1)
    delay = None
    if cur is not None:
        delay = ((cur.get("departure") or {}).get("delay_minutes")
                 if (cur.get("departure") or {}).get("delay_minutes") is not None
                 else (cur.get("arrival") or {}).get("delay_minutes"))

    return {
        "type": "position_update",
        "train_number": train_number,
        "train_name": train_name,
        "date": date_ddmmyyyy,
        "quick_frame": True,
        "quick_source": source,
        "timeline": timeline,
        "timeline_grouped": gps_tracking.group_timeline_for_display(timeline),
        "current_station": cur.get("name") if cur else None,
        "current_station_code": cur.get("code") if cur else None,
        "next_station": nxt.get("name") if nxt else None,
        "next_station_code": nxt.get("code") if nxt else None,
        "lat": lat, "lng": lng,
        "position_source": "railradar_segment_progress" if interp_km is not None else f"{source}_station",
        "delay_minutes": delay,
        "display_speed_kmph": speed,
        "display_speed_source": "railradar_live_gps" if speed else None,
        "distance_remaining_to_next_km": km_to_next,
        "next_station_live_eta": (nxt or {}).get("predicted_eta"),
        "status_updated_at": datetime.now(timezone.utc).isoformat(),
        "error": None,
    }


# ===========================================================================
# RailRadar as the PRIMARY live source ("99% RailRadar, 1% RailKit").
# RailKit is only reached through railkit-service — a separate Render
# free-tier service that sleeps and then takes 30-60s to answer — so every
# live read now comes from RailRadar (called directly), and RailKit is used
# only when RailRadar has no data for the train (or no key is configured).
# Set LIVE_PRIMARY_PROVIDER=railkit in the environment to go back.
# ===========================================================================
import os  # noqa: E402
import threading  # noqa: E402

import api_cache  # noqa: E402
import railway_api  # noqa: E402

RAILRADAR_PRIMARY = (os.environ.get("LIVE_PRIMARY_PROVIDER", "railradar").strip().lower() != "railkit")


def _iso_to_ddmmyyyy(iso: Optional[str]) -> Optional[str]:
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(iso or ""))
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


LAST_RAILRADAR_ERROR: dict = {}


def _today_ddmmyyyy_ist() -> str:
    return running_status.ist_now().strftime("%d-%m-%Y")


def railradar_primary(train_number: str, date_ddmmyyyy: Optional[str] = None, force_refresh: bool = False,
                      force_ignore_flag: bool = False):
    """Live stops + position from RailRadar, in the SAME TimelineStop /
    LivePosition shapes the RailKit path produces, so everything downstream
    (predictions, ETAs, alerts, grouping) runs unchanged.
    Returns (stops, position, run_start_ddmmyyyy, fetched_epoch) or None."""
    if not RAILRADAR_PRIMARY and not force_ignore_flag:
        return None
    # Try the requested run first; when that's today (or blank), also try
    # RailRadar's own "current run" auto-detect before giving up — an
    # explicit today's date for a train that hasn't started yet can come
    # back empty while the running train is right there.
    attempts = [date_ddmmyyyy]
    if date_ddmmyyyy and date_ddmmyyyy == _today_ddmmyyyy_ist():
        attempts.append(None)
    data = stops = None
    used_date = None
    last_err = None
    for d in attempts:
        iso = railradar_fallback._ddmmyyyy_to_iso(d)
        try:
            data = railradar_fallback._fetch_raw(train_number, iso, _force_refresh=force_refresh)
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
            data = None
            continue
        stops = railradar_fallback.fetch_railradar_timeline(train_number, d)  # same cache entry
        if stops:
            used_date = d
            break
        last_err = "RailRadar returned no route/stations for this train and date."
    if not stops:
        LAST_RAILRADAR_ERROR[str(train_number)] = last_err or railradar_fallback.get_last_error() or "RailRadar has no data."
        return None
    LAST_RAILRADAR_ERROR.pop(str(train_number), None)
    iso = railradar_fallback._ddmmyyyy_to_iso(used_date)
    gps_tracking.finalize_timeline_stops(stops)
    name = _first(data, "trainName", "train_name", "name") or _first(data.get("train") or {}, "name", "trainName")
    position = gps_tracking.position_from_stops(train_number, stops, train_name=name)
    fetched = api_cache.entry_fetched_at("railradar_fallback_live", (train_number, iso), {})
    return stops, position, _iso_to_ddmmyyyy(data.get("startDate")), fetched


_train_info_inflight: dict = {}


def train_info_nonblocking(train_number: str):
    """RailKit route info (station coordinates) only if already cached;
    otherwise starts ONE background fetch and returns None right away, so a
    sleeping railkit-service never delays live tracking."""
    val = api_cache.peek("train_info", (train_number,), {})
    if val is not None:
        return val
    t = _train_info_inflight.get(train_number)
    if t is None or not t.is_alive():
        def _bg():
            try:
                railway_api.get_train_info(train_number)
            except Exception:  # noqa: BLE001
                pass
        t = threading.Thread(target=_bg, daemon=True)
        _train_info_inflight[train_number] = t
        t.start()
    return None


def railradar_status(train_number: str, date_ddmmyyyy: Optional[str] = None) -> dict:
    """Diagnostics for /api/live/provider-check: is RailRadar configured and
    answering for this train right now, and if not, exactly why."""
    key_set = bool(railradar_fallback._api_key())
    rr = railradar_primary(train_number, date_ddmmyyyy, force_refresh=True, force_ignore_flag=True) if key_set else None
    out = {
        "train_number": train_number,
        "railradar_primary_enabled": RAILRADAR_PRIMARY,
        "railradar_key_set": key_set,
        "railradar_ok": rr is not None,
        "railradar_error": None if rr is not None else (
            LAST_RAILRADAR_ERROR.get(str(train_number)) if key_set else "RAILRADAR_API_KEY is not set on this backend service."),
    }
    if rr is not None:
        stops, pos, start, _f = rr
        out.update({"stations": len(stops), "run_start": start,
                    "current_station": pos.current_station_name if pos else None,
                    "train_name": pos.train_name if pos else None})
    return out
