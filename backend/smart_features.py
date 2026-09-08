"""
smart_features.py
--------------------
Business logic for four of the newer "dynamic, input-driven" tools:

  1. "When Should I Leave?" Smart Departure Reminder
  3. "Smart Alarm" based on real-time train position
  5. "Transit Time Optimizer" — best train for a rider's own schedule
  6. "Route Visualization" data feed for the frontend's time-lapse player

(Feature 2 — seat/berth recommendation by trip profile — lives in
advanced_features.py next to the seat-picker it extends. Feature 9's
indoor-navigation guidance lives there too, next to the platform
predictor it extends. Both are one function each; splitting them into
this file would just mean importing advanced_features from here anyway.)

"Live Crowd Map for Train Coaches" and "Water/Restroom Availability Live
Check" were dropped entirely — neither RailKit (RapidAPI) nor RailRadar,
the two live-data providers this app has access to, publish any real
per-coach occupancy or water/restroom sensor feed, and this project's
rule is to never ship a "live" feature with no real (or honestly-labelled
crowdsourced) data behind it.

Same honesty rule as the rest of this project everywhere it applies:
every number that CAN be computed from real data (RailKit's live
timeline, real station coordinates, real distances) is computed for
real; anything this app has no real source for (walking speed, indoor
station layout) is a clearly-labelled, parameterized estimate — never a
fabricated "live" figure.
"""

import json
import math
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import List, Optional

import gps_tracking
import railway_api
from nearby_stations import haversine_km

# Every arrival/departure time this module compares against ("now") comes
# from RailKit as a real Indian Railways wall-clock time — always IST,
# regardless of where this backend process happens to be hosted. Using a
# naive datetime.now() here silently takes the SERVER's local clock instead
# (e.g. UTC on most cloud hosts), which throws every "minutes remaining" /
# "lead time" calculation off by however many hours the host's clock is
# offset from IST — the Smart Alarm and Departure Reminder would fire at
# the wrong moment even though the underlying train data is correct. India
# has a single fixed UTC+5:30 offset with no DST, so a plain fixed-offset
# timezone (no tzdata/pytz dependency needed) is exact and always correct.
IST = timezone(timedelta(hours=5, minutes=30))


def _now_ist() -> datetime:
    """The real current time in IST — what every 'now' in this module
    should mean, independent of the host server's own system timezone."""
    return datetime.now(IST)

_STATION_COORDS_PATH = os.path.join(os.path.dirname(__file__), "data", "station_coordinates.json")
with open(_STATION_COORDS_PATH, "r", encoding="utf-8") as _f:
    _STATION_COORDS = json.load(_f)


def _station_coords(code: Optional[str]) -> Optional[dict]:
    if not code:
        return None
    return _STATION_COORDS.get(code.strip().upper())


def _hhmm_to_minutes(t: Optional[str]) -> Optional[int]:
    """Parses a leading 'HH:MM' into minutes-since-midnight, tolerating any
    trailing text after it (seconds, ' AM'/' PM', a '(Day 2)' annotation,
    etc.) — matches gps_tracking._time_str_to_minutes's proven regex
    approach instead of a strict split, so a real RailKit time string with
    extra trailing content doesn't get rejected as unparseable. Never
    guesses a value it genuinely can't find a leading HH:MM in."""
    if not t:
        return None
    match = re.match(r"^\s*(\d{1,2}):(\d{2})", str(t))
    if not match:
        return None
    h, m = int(match.group(1)), int(match.group(2))
    if h > 27 or m > 59:  # RailKit sometimes uses >23 for next-day times
        return None
    return h * 60 + m


# RailKit uses these literal words instead of a clock time for the one
# event a station genuinely doesn't have: "SRC" (source station — no
# arrival, the train starts there) and "DSTN" (destination station — no
# departure, the train ends there). Recognising them by name gives a real,
# specific explanation instead of a generic "couldn't parse" — same
# "surface the real reason" convention gps_tracking.py's own comments
# about "SRC" already follow.
_NON_TIME_SENTINELS = {"SRC", "SOURCE", "DSTN", "DESTINATION", "--", "-", "N/A", "NA"}


def _non_time_sentinel_note(raw_value: Optional[str], station: str, train_number: str, event: str) -> Optional[str]:
    """Returns a specific, human note when `raw_value` is one of RailKit's
    known non-time sentinel words for this event (arrival/departure) at
    this station, or None if it isn't one (i.e. parsing should proceed
    normally, or genuinely failed for some other reason)."""
    if not raw_value:
        return None
    token = str(raw_value).strip().upper()
    if token not in _NON_TIME_SENTINELS:
        return None
    if event == "departure" and token in ("DSTN", "DESTINATION"):
        return (f"{station} is train {train_number}'s final destination — it doesn't depart from there, so "
                "there's no departure time to plan against. Use the station you're actually boarding at instead.")
    if event == "arrival" and token in ("SRC", "SOURCE"):
        return (f"{station} is train {train_number}'s starting station — it doesn't arrive there, so there's no "
                "arrival time to alarm against. Use the station you're actually getting off at instead.")
    return f"{station} has no real {event} time for this train (provider returned {raw_value!r})."


def _find_stop(timeline_json: list, station_code: str) -> Optional[dict]:
    code = (station_code or "").strip().upper()
    for stop in timeline_json:
        if (stop.get("code") or "").strip().upper() == code:
            return stop
    return None


# =============================================================================
# FEATURE 1: "When Should I Leave?" Smart Departure Reminder
# =============================================================================
DEPARTURE_REMINDER_DISCLAIMER = (
    "Travel time here is a straight-line (haversine) distance divided by a "
    "typical speed for your chosen mode — it does not account for real "
    "traffic, road routing, or queues at the station. Treat the 'leave by' "
    "time as a helpful estimate, and add extra buffer in heavy traffic or "
    "at unfamiliar stations."
)

# Typical average door-to-door speeds (km/h) — deliberately conservative,
# since this is a straight-line distance being divided by a speed, not a
# real routed ETA.
_MODE_SPEEDS_KMPH = {
    "walk": 4.5,
    "cycle": 12.0,
    "auto": 18.0,
    "bike": 25.0,      # two-wheeler
    "car": 28.0,
    "bus": 16.0,
    "metro": 30.0,
    "taxi": 26.0,
}

# How long before departure a passenger should already be AT the station —
# security/luggage check, finding the platform, boarding — on top of the
# travel time itself. Indian Railways' own general advice is "arrive at
# least 30-45 min before departure for a reserved train"; kept configurable
# per-call so a user can override it.
DEFAULT_BOARDING_BUFFER_MINUTES = 25


def _parse_scheduled_dt(date_ddmmyyyy: Optional[str], hhmm: Optional[str], day_offset: int = 0) -> Optional[datetime]:
    minutes = _hhmm_to_minutes(hhmm)
    if minutes is None:
        return None
    h, m = divmod(minutes, 60)
    extra_days, h = divmod(h, 24)
    try:
        if date_ddmmyyyy:
            # A user/caller-supplied date has no timezone of its own — it's
            # always "that calendar date in India", so it's anchored to IST
            # the same as the "no date given" branch below.
            base = datetime.strptime(date_ddmmyyyy.strip(), "%d-%m-%Y").replace(tzinfo=IST)
        else:
            base = _now_ist()
    except ValueError:
        base = _now_ist()
    return base.replace(hour=h, minute=m, second=0, microsecond=0) + timedelta(days=day_offset + extra_days)


def departure_reminder(
    train_number: str, boarding_station: str, date: Optional[str] = None,
    mode: str = "walk", distance_km: Optional[float] = None,
    user_lat: Optional[float] = None, user_lng: Optional[float] = None,
    boarding_buffer_minutes: int = DEFAULT_BOARDING_BUFFER_MINUTES,
) -> dict:
    boarding_station = (boarding_station or "").strip().upper()
    mode = (mode or "walk").strip().lower()
    speed_kmph = _MODE_SPEEDS_KMPH.get(mode, _MODE_SPEEDS_KMPH["walk"])

    try:
        stops = gps_tracking.get_full_timeline(train_number, date)
    except railway_api.RailwayAPIError as e:
        return {"found": False, "note": f"Couldn't fetch this train's live timeline: {e}"}
    timeline_json = gps_tracking.timeline_to_json(stops)
    stop = _find_stop(timeline_json, boarding_station)
    if stop is None:
        return {
            "found": False,
            "note": f"{boarding_station} doesn't appear on train {train_number}'s route for this date — "
                    "check the station code and that this train actually starts/passes through there.",
        }

    departure = stop["departure"]
    scheduled, expected, delay_minutes = departure.get("scheduled"), departure.get("expected"), departure.get("delay_minutes")
    effective_hhmm = expected or scheduled
    sentinel_note = _non_time_sentinel_note(effective_hhmm, boarding_station, train_number, "departure")
    if sentinel_note:
        return {"found": True, "note": sentinel_note}
    if not effective_hhmm:
        return {"found": True, "note": f"No departure time is available yet for {boarding_station} on this train."}

    day_offset = 0
    try:
        day_offset = max(0, int(str(stop.get("day") or "1").strip()) - 1)
    except (TypeError, ValueError):
        pass
    effective_dt = _parse_scheduled_dt(date, effective_hhmm, day_offset)
    if effective_dt is None:
        return {"found": True, "note": f"Couldn't parse this station's departure time (raw value: {effective_hhmm!r})."}

    # Distance to the station: an explicit distance_km wins; otherwise
    # derive it from the user's real GPS fix + the station's real curated
    # coordinate, when both are available.
    distance_note = None
    if distance_km is None and user_lat is not None and user_lng is not None:
        coords = _station_coords(boarding_station)
        if coords:
            distance_km = round(haversine_km(user_lat, user_lng, coords["lat"], coords["lng"]), 2)
        else:
            distance_note = (
                f"{boarding_station} isn't in this app's curated {len(_STATION_COORDS)}-station coordinate table, so your live "
                "location can't be converted into a distance automatically — enter the distance manually."
            )

    if distance_km is None:
        return {
            "found": True,
            "station": boarding_station,
            "train_number": train_number,
            "scheduled_departure": scheduled,
            "expected_departure": expected,
            "delay_minutes": delay_minutes,
            "status": stop.get("status"),
            "note": distance_note or "Share your current location or enter a distance (km) to the station to get a 'leave by' time.",
            "disclaimer": DEPARTURE_REMINDER_DISCLAIMER,
        }

    travel_minutes = (distance_km / speed_kmph) * 60.0
    total_lead_minutes = travel_minutes + max(0, boarding_buffer_minutes)
    leave_by_dt = effective_dt - timedelta(minutes=total_lead_minutes)
    now = _now_ist()
    minutes_until_leave = round((leave_by_dt - now).total_seconds() / 60.0, 1)

    if stop.get("status") == "passed":
        urgency = "departed"
    elif minutes_until_leave <= 0:
        urgency = "leave_now"
    elif minutes_until_leave <= 15:
        urgency = "leave_soon"
    else:
        urgency = "plenty_of_time"

    return {
        "found": True,
        "train_number": str(train_number).strip(),
        "station": boarding_station,
        "mode": mode,
        "distance_km": round(distance_km, 2),
        "assumed_speed_kmph": speed_kmph,
        "travel_minutes": round(travel_minutes, 1),
        "boarding_buffer_minutes": max(0, boarding_buffer_minutes),
        "scheduled_departure": scheduled,
        "expected_departure": expected,
        "delay_minutes": delay_minutes,
        "status": stop.get("status"),
        "leave_by": leave_by_dt.strftime("%H:%M"),
        "leave_by_date": leave_by_dt.strftime("%d-%m-%Y"),
        "minutes_until_leave": minutes_until_leave,
        "urgency": urgency,
        "disclaimer": DEPARTURE_REMINDER_DISCLAIMER
                      + (f" {delay_minutes} min of real reported delay was already folded into this using the train's "
                         "live expected departure time." if delay_minutes else ""),
    }


# =============================================================================
# FEATURE 3: "Smart Alarm" Based on Real-Time Train Position
# =============================================================================
SMART_ALARM_DISCLAIMER = (
    "Based on this train's real live position/timeline from RailKit — the "
    "same feed the live tracking map uses — not a GPS geofence on your own "
    "phone. Keep this tab/app open (or re-check periodically) since there's "
    "no background push tied to this specific alarm."
)


def smart_alarm_check(
    train_number: str, destination_station: str, date: Optional[str] = None,
    lead_minutes: float = 10.0, lead_km: Optional[float] = None,
    predicted_delay_minutes: Optional[int] = None,
    predicted_delay_confidence: Optional[str] = None,
) -> dict:
    """
    predicted_delay_minutes / predicted_delay_confidence: this app's OWN
    live-data-grounded delay prediction for `destination_station` on this
    run — the exact same per-station figure the Live Tracking tab and the
    delay-alert feature show (see app.py's `_predict_for_watch_station`,
    which wraps `_predict_delay_per_reporting_station`). Passed in by the
    caller (api_smart_alarm) rather than recomputed here, so this module
    doesn't duplicate that pipeline's live-position/trend/speed plumbing.

    BUGFIX: previously this function only ever alarmed off RailKit's raw
    `expected` (falling back to `scheduled` whenever RailKit hadn't yet
    published a live delay for THIS specific station — routinely the case
    well before a train reaches it). That silently dropped any delay this
    app's own prediction already knew about, so e.g. a real case reported
    against train 20833 at RJY: scheduled arrival 20:43, this app's own
    predicted delay +30 min (predicted arrival 21:13), a 10-min-lead alarm
    fired at 20:33 — 10 min before the UN-delayed scheduled time — instead
    of 21:03 (10 min before the actually-expected 21:13). Now: RailKit's
    own `expected` is still used whenever RailKit itself has reported a
    real delay for this station (`delay_minutes is not None` — that's real
    live data and takes priority over a model estimate); only when RailKit
    has NOT reported one yet does the caller-supplied predicted delay get
    added to the scheduled time to form the effective arrival the alarm is
    computed against.
    """
    destination_station = (destination_station or "").strip().upper()
    try:
        stops = gps_tracking.get_full_timeline(train_number, date)
    except railway_api.RailwayAPIError as e:
        return {"found": False, "note": f"Couldn't fetch this train's live position: {e}"}
    timeline_json = gps_tracking.timeline_to_json(stops)
    stop = _find_stop(timeline_json, destination_station)
    if stop is None:
        return {
            "found": False,
            "note": f"{destination_station} doesn't appear on train {train_number}'s route for this date.",
        }

    if stop.get("status") == "passed":
        return {
            "found": True, "already_passed": True, "alarm_now": False,
            "station": destination_station,
            "note": f"Train {train_number} has already passed {destination_station}.",
            "disclaimer": SMART_ALARM_DISCLAIMER,
        }

    arrival = stop["arrival"]
    scheduled, expected, delay_minutes = arrival.get("scheduled"), arrival.get("expected"), arrival.get("delay_minutes")
    effective_hhmm = expected or scheduled
    sentinel_note = _non_time_sentinel_note(effective_hhmm, destination_station, train_number, "arrival")
    if sentinel_note:
        return {"found": True, "already_passed": False, "alarm_now": False, "station": destination_station, "note": sentinel_note, "disclaimer": SMART_ALARM_DISCLAIMER}
    minutes_remaining = None
    eta_iso = None
    alarm_at_iso = None
    server_now_iso = _now_ist().isoformat()
    # See the BUGFIX note on this function: RailKit's `delay_minutes` being
    # None means RailKit itself has no real live delay figure for this
    # station yet (not that the train is on time — that case reports 0) —
    # only then is a caller-supplied predicted delay folded into the
    # effective arrival used for the alarm.
    used_predicted_delay = bool(delay_minutes is None and predicted_delay_minutes is not None and scheduled)
    if effective_hhmm:
        day_offset = 0
        try:
            day_offset = max(0, int(str(stop.get("day") or "1").strip()) - 1)
        except (TypeError, ValueError):
            pass
        if used_predicted_delay:
            # Base strictly off `scheduled`, never `expected` — RailKit can
            # set `expected` to a copy of `scheduled` with no real delay
            # figure attached (delay_minutes still None in that case), and
            # stacking the predicted delay on top of THAT would double-count
            # it. Scheduled + this app's own predicted delay is the whole
            # "effective arrival" on this path, computed fresh.
            eta_dt = _parse_scheduled_dt(date, scheduled, day_offset)
            if eta_dt:
                eta_dt = eta_dt + timedelta(minutes=predicted_delay_minutes)
        else:
            eta_dt = _parse_scheduled_dt(date, effective_hhmm, day_offset)
        if eta_dt:
            minutes_remaining = round((eta_dt - _now_ist()).total_seconds() / 60.0, 1)
            # Real IST wall-clock timestamps a client can schedule against
            # directly (Date.parse() on the frontend), instead of only
            # inferring "how many minutes are left" from whenever its next
            # poll happens to land. eta_iso is when the train is really due;
            # alarm_at_iso is eta_iso minus the requested lead time — the
            # exact real-time moment the notification should fire, computed
            # once here from RailKit's live ETA and this server's IST clock
            # (never the client device's own clock, which the client should
            # only use to know "has that real moment arrived yet").
            eta_iso = eta_dt.isoformat()
            alarm_at_iso = (eta_dt - timedelta(minutes=lead_minutes)).isoformat()

    current_km = gps_tracking.current_position_distance_km(timeline_json)
    dest_km = None
    try:
        dest_km = float(str(stop.get("distance_km")).replace(",", "")) if stop.get("distance_km") not in (None, "") else None
    except (TypeError, ValueError):
        dest_km = None
    distance_remaining_km = None
    if current_km is not None and dest_km is not None:
        distance_remaining_km = round(dest_km - current_km, 1)

    alarm_now = False
    if minutes_remaining is not None and minutes_remaining <= lead_minutes:
        alarm_now = True
    if lead_km is not None and distance_remaining_km is not None and distance_remaining_km <= lead_km:
        alarm_now = True

    alarm_basis = "predicted_delay" if used_predicted_delay else ("railkit_live" if delay_minutes is not None else "scheduled")
    disclaimer = SMART_ALARM_DISCLAIMER
    # Plain IST "HH:MM" (sliced straight out of eta_iso, which is this same
    # eta_dt.isoformat() built from _now_ist()/IST arithmetic throughout
    # this module) rather than re-deriving it in the browser with
    # `new Date(eta_iso)`, which would render in the VIEWER's local
    # timezone instead of IST whenever those differ.
    predicted_arrival_hhmm = eta_iso[11:16] if (used_predicted_delay and eta_iso) else None
    if predicted_arrival_hhmm:
        disclaimer += (
            f" RailKit hasn't published a live delay for {destination_station} on this run yet, so the "
            f"alarm time below is the scheduled arrival ({scheduled}) plus this app's own predicted delay of "
            f"~{predicted_delay_minutes} min"
            + (f" ({predicted_delay_confidence} confidence)" if predicted_delay_confidence else "")
            + f" — giving a predicted arrival of {predicted_arrival_hhmm}. This will be replaced by RailKit's "
              "own real live figure the moment it publishes one for this station."
        )

    return {
        "found": True,
        "already_passed": False,
        "train_number": str(train_number).strip(),
        "station": destination_station,
        "status": stop.get("status"),
        "scheduled_arrival": scheduled,
        "expected_arrival": expected,
        "delay_minutes": delay_minutes,
        "predicted_delay_minutes": predicted_delay_minutes if used_predicted_delay else None,
        "predicted_delay_confidence": predicted_delay_confidence if used_predicted_delay else None,
        "predicted_arrival": predicted_arrival_hhmm,
        "alarm_basis": alarm_basis,
        "minutes_remaining": minutes_remaining,
        "distance_remaining_km": distance_remaining_km,
        "lead_minutes": lead_minutes,
        "lead_km": lead_km,
        "alarm_now": alarm_now,
        "eta_iso": eta_iso,
        "alarm_at_iso": alarm_at_iso,
        "server_now_iso": server_now_iso,
        "disclaimer": disclaimer,
    }


# =============================================================================
# FEATURE 5: "Transit Time Optimizer" — Best Train for Your Schedule
# =============================================================================
TRANSIT_OPTIMIZER_DISCLAIMER = (
    "Ranked from the same real live train list your Train Search uses — "
    "nothing invented — scored purely against the schedule window you gave."
)


def _minutes_diff_abs(a: Optional[int], b: Optional[int]) -> Optional[int]:
    if a is None or b is None:
        return None
    # circular distance on a 24h clock, so 23:50 vs 00:10 reads as 20 min apart, not 1420
    d = abs(a - b)
    return min(d, 1440 - d)


def rank_trains_for_schedule(
    trains: List[dict],
    depart_after: Optional[str] = None, depart_before: Optional[str] = None,
    arrive_after: Optional[str] = None, arrive_before: Optional[str] = None,
    preferred_arrival: Optional[str] = None,
    max_duration_hours: Optional[float] = None,
) -> dict:
    da_min, db_min = _hhmm_to_minutes(depart_after), _hhmm_to_minutes(depart_before)
    aa_min, ab_min = _hhmm_to_minutes(arrive_after), _hhmm_to_minutes(arrive_before)
    pref_min = _hhmm_to_minutes(preferred_arrival)

    scored = []
    for t in trains:
        dep_min = _hhmm_to_minutes(t.get("source_departure") or t.get("departure_time"))
        arr_min = _hhmm_to_minutes(t.get("dest_arrival") or t.get("arrival_time"))
        duration_h = _duration_to_hours(t.get("duration"))

        reasons, fits = [], True
        if da_min is not None and dep_min is not None and dep_min < da_min:
            fits = False
        if db_min is not None and dep_min is not None and dep_min > db_min:
            fits = False
        if aa_min is not None and arr_min is not None and arr_min < aa_min:
            fits = False
        if ab_min is not None and arr_min is not None and arr_min > ab_min:
            fits = False
        if max_duration_hours is not None and duration_h is not None and duration_h > max_duration_hours:
            fits = False

        if fits:
            if da_min is not None or db_min is not None:
                reasons.append(f"Departs {t.get('source_departure') or '?'} — within your departure window.")
            if aa_min is not None or ab_min is not None:
                reasons.append(f"Arrives {t.get('dest_arrival') or '?'} — within your arrival window.")
            if max_duration_hours is not None and duration_h is not None:
                reasons.append(f"Journey is {t.get('duration') or '?'} — under your {max_duration_hours}h limit.")

        # Score: lower is better. Primary: distance from preferred arrival
        # time (if given); else raw duration; both scaled to comparable
        # ranges. A train outside the hard windows is pushed to the bottom
        # rather than dropped, so the tool still shows the closest misses.
        score = 0.0
        if pref_min is not None and arr_min is not None:
            score += _minutes_diff_abs(arr_min, pref_min) or 0
        elif duration_h is not None:
            score += duration_h * 60
        if not fits:
            score += 100000  # sink to the bottom, still visible

        scored.append({**t, "fits_schedule": fits, "why": reasons, "duration_hours": duration_h, "_score": score})

    scored.sort(key=lambda t: t["_score"])
    for t in scored:
        t.pop("_score", None)
    return {
        "trains": scored,
        "criteria": {
            "depart_after": depart_after, "depart_before": depart_before,
            "arrive_after": arrive_after, "arrive_before": arrive_before,
            "preferred_arrival": preferred_arrival, "max_duration_hours": max_duration_hours,
        },
        "disclaimer": TRANSIT_OPTIMIZER_DISCLAIMER,
    }


def _duration_to_hours(duration_str: Optional[str]) -> Optional[float]:
    """Parses RailKit-style durations ('12h 30m', '5:45', '340' minutes) —
    returns None rather than guessing on an unrecognised shape."""
    if not duration_str:
        return None
    s = str(duration_str).strip().lower()
    h = m = None
    import re
    hm = re.search(r"(\d+)\s*h", s)
    mm = re.search(r"(\d+)\s*m", s)
    if hm or mm:
        h = int(hm.group(1)) if hm else 0
        m = int(mm.group(1)) if mm else 0
        return round(h + m / 60.0, 2)
    if ":" in s:
        parts = s.split(":")
        try:
            h, m = int(parts[0]), int(parts[1])
            return round(h + m / 60.0, 2)
        except (ValueError, IndexError):
            return None
    if s.isdigit():  # bare minutes
        return round(int(s) / 60.0, 2)
    return None


# =============================================================================
# FEATURE 6: "Route Visualization" with Time-Lapse — data feed
# =============================================================================
ROUTE_TIMELAPSE_DISCLAIMER = (
    "Stop order and coordinates are real (RailKit's route data, with this "
    "app's curated fallback table for any station RailKit doesn't give a "
    "coordinate for). Playback is paced by real cumulative distance "
    "between stops, not a live per-second speed profile, so it's a "
    "schematic preview of the route rather than a live replay."
)


def route_timelapse(train_number: str) -> dict:
    try:
        route = gps_tracking.get_route_with_coordinates(train_number)
    except railway_api.RailwayAPIError as e:
        return {"found": False, "note": f"Couldn't fetch this train's route: {e}"}
    if not route:
        return {"found": False, "note": f"No route data found for train {train_number}."}

    def _dist_val(d):
        try:
            return float(str(d).replace(",", "")) if d not in (None, "") else None
        except (TypeError, ValueError):
            return None

    stops = []
    for s in route:
        stops.append({
            "code": s.code, "name": s.name, "lat": s.lat, "lng": s.lng,
            "has_coordinates": s.has_coordinates, "coordinates_from": s.coordinates_from,
            "scheduled_arrival": s.scheduled_arrival, "scheduled_departure": s.scheduled_departure,
            "distance_km": _dist_val(s.distance_km),
        })

    known_distances = [s["distance_km"] for s in stops if s["distance_km"] is not None]
    total_distance = max(known_distances) if known_distances else None

    # Fill a monotonic `progress` (0..1 along the route) for every stop
    # that has SOME real distance figure; stops with neither a real nor
    # interpolatable distance fall back to even index-spacing so the
    # frontend still has something to animate against, flagged via
    # `progress_basis`.
    if total_distance and total_distance > 0:
        for s in stops:
            s["progress"] = round(s["distance_km"] / total_distance, 4) if s["distance_km"] is not None else None
        # linearly fill any gaps between two known progress values
        known_idx = [i for i, s in enumerate(stops) if s["progress"] is not None]
        for i, s in enumerate(stops):
            if s["progress"] is not None:
                continue
            earlier = [j for j in known_idx if j < i]
            later = [j for j in known_idx if j > i]
            if earlier and later:
                p, n = earlier[-1], later[0]
                ratio = (i - p) / (n - p)
                s["progress"] = round(stops[p]["progress"] + ratio * (stops[n]["progress"] - stops[p]["progress"]), 4)
        progress_basis = "distance"
    else:
        n = max(1, len(stops) - 1)
        for i, s in enumerate(stops):
            s["progress"] = round(i / n, 4)
        progress_basis = "even_spacing"

    plottable = sum(1 for s in stops if s["has_coordinates"])
    return {
        "found": True,
        "train_number": str(train_number).strip(),
        "stops": stops,
        "total_distance_km": total_distance,
        "progress_basis": progress_basis,
        "plottable_stops": plottable,
        "total_stops": len(stops),
        "disclaimer": ROUTE_TIMELAPSE_DISCLAIMER,
    }


# NOTE: "Live Crowd Map for Train Coaches" and "Water/Restroom Availability
# Live Check" (coach_conditions_overview and friends) were removed —
# neither RailKit (RapidAPI) nor RailRadar exposes any real per-coach
# occupancy or water/restroom sensor feed, and a crowdsourced-only version
# was intentionally dropped rather than shipped with no real data behind
# it. See coach_conditions_store.py in git history if reviving this later.
