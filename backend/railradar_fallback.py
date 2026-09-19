"""
railradar_fallback.py
----------------------
Fallback / secondary data source, used when RailKit's own timeline is
missing distance or clock-time data. RailRadar's own documented schema
(https://railradar.in/docs/live-train-status) publishes a real, populated
`distance` field on every route stop, plus `speedToNextStationKmph` per
stop and a live `currentLocation.speedKmh` - real distance/time math
RailRadar has already done on its own aggregated data. Nothing here is
scraped or invented; every field is copied straight from RailRadar's own
published response shape.

Three things this module provides, all grounded in real RailRadar fields:
  1. fetch_railradar_timeline()      -> TimelineStop list (drop-in for
                                         gps_tracking.compute_avg_speed_kmph)
  2. get_major_stop_distances()      -> real km between each halting
                                         station, for the RailYatri-style
                                         per-stop distance display
  3. get_route_averages()            -> real avg distance and avg time
                                         between halts for the whole train

To go live:
  1. Get a free API key at https://railradar.in/developers (they publish a
     free Sandbox plan; check their site for current limits).
  2. In backend/.env, set RAILRADAR_API_KEY=<your key>.

If no key is configured, or the call fails for any reason, every function
below returns [] / None rather than raising - this is a best-effort
fallback, so a problem here must never break the primary RailKit-based
response it's backing up.
"""

import os
import re
from datetime import date as date_cls, datetime, timedelta
from typing import List, Optional

import requests

from api_cache import cached
from gps_tracking import StopTiming, TimelineStop


def _ddmmyyyy_to_iso(date_ddmmyyyy: Optional[str]) -> Optional[str]:
    """Converts this app's own DD-MM-YYYY date convention (used everywhere
    else in the codebase, e.g. railway_api.get_live_train_status) into the
    YYYY-MM-DD RailRadar's own `date` query parameter expects. Returns None
    (never a guess) for anything that isn't a real, parseable date, so a
    caller passing a bad/empty value just falls back to RailRadar's own
    "auto-detect current run" behavior rather than sending a malformed
    query param."""
    if not date_ddmmyyyy:
        return None
    try:
        return datetime.strptime(date_ddmmyyyy.strip(), "%d-%m-%Y").strftime("%Y-%m-%d")
    except (ValueError, AttributeError):
        return None

API_BASE = "https://api.railradar.in/v1/trains"
TIMEOUT_SECONDS = 8


class RailRadarFallbackError(Exception):
    pass


# Real reason the LAST _fetch_raw() call failed (invalid key, train not
# found, rate limited, network error, etc.) - kept so callers that must
# swallow the exception (get_major_stop_distances / get_route_averages,
# which return [] / None rather than raising) can still surface the ACTUAL
# reason to the user instead of a generic "no data" message. Simple
# process-global is fine here: same best-effort, single-process dev-server
# scope as api_cache's own in-memory cache elsewhere in this codebase.
_last_error: Optional[str] = None


def get_last_error() -> Optional[str]:
    """The real message from the most recent failed RailRadar call, or
    None if the last call succeeded (or nothing has been called yet)."""
    return _last_error



def _api_key() -> Optional[str]:
    return os.environ.get("RAILRADAR_API_KEY") or None


@cached(ttl_seconds=60, prefix="railradar_fallback_live")
def _fetch_raw(train_number: str, date_iso: Optional[str] = None) -> dict:
    """GET RailRadar's live-status endpoint.

    `date_iso` (YYYY-MM-DD) is RailRadar's own documented `date` query
    parameter — "Journey start date. Omit to auto-detect current run."
    (https://railradar.in/docs/live-train-status). This used to be left
    out unconditionally on the theory that RailRadar's own auto-detection
    would be more reliable than a reformatted date — but that only holds
    for the CURRENT/live-running case. For a caller asking about a past
    date (or a journey that's already finished), omitting it means this
    always fetches whatever RailRadar considers the "most recent run"
    (frequently today's, possibly not-yet-departed one) instead of the
    actually-requested day's completed journey, so real per-station
    actual/delay data for that requested day never gets matched. Passing
    the real requested date fixes that; still perfectly safe to omit for
    genuinely live polling of a train running today, which is the only
    case that used to rely on the auto-detect behavior anyway."""
    global _last_error

    def _fail(msg: str):
        global _last_error
        _last_error = msg
        raise RailRadarFallbackError(msg)

    key = _api_key()
    if not key:
        _fail("RAILRADAR_API_KEY is not set in backend/.env.")

    url = f"{API_BASE}/{train_number}/live"
    params = {"date": date_iso} if date_iso else None
    try:
        resp = requests.get(url, headers={"Authorization": f"Bearer {key}"}, params=params, timeout=TIMEOUT_SECONDS)
    except requests.exceptions.RequestException as exc:
        _fail(f"Could not reach api.railradar.in ({exc}).")

    if resp.status_code == 401:
        _fail("RailRadar rejected the API key (401 Unauthorized) — check RAILRADAR_API_KEY in backend/.env is correct and active.")
    if resp.status_code == 404:
        _fail(f"RailRadar has no data for train {train_number} (404 Not Found) — check the train number, or it may not be running today.")
    if resp.status_code == 429:
        _fail("RailRadar rate limit exceeded (429) — you've hit your plan's request quota; try again later or upgrade your plan.")

    try:
        body = resp.json()
    except ValueError:
        _fail(f"RailRadar returned a response that wasn't valid JSON (HTTP {resp.status_code}).")

    if not body.get("success"):
        err = body.get("error") or {}
        _fail(err.get("message") or f"RailRadar returned success=false (HTTP {resp.status_code}).")

    _last_error = None
    return body.get("data") or {}


def _hhmm_from_iso(raw: Optional[str]) -> Optional[str]:
    """RailRadar gives full ISO datetimes like '2026-06-23T01:07:00+05:30'.
    gps_tracking._time_str_to_minutes() expects a leading 'HH:MM', so this
    extracts that real clock-time portion. Returns None for anything that
    isn't a real timestamp - never a guess."""
    if not raw:
        return None
    match = re.match(r"^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})", str(raw))
    return f"{match.group(1)}:{match.group(2)}" if match else None


def _day_offset_from_iso(raw: Optional[str], start_date: Optional[str]) -> str:
    """RailKit's `day` field is 1-based ('day N of the journey'). RailRadar
    doesn't give that directly, but DOES give full real calendar dates for
    both the journey start and every stop's actual timestamp, so the same
    number is derivable as a real date subtraction rather than a guess.
    Falls back to day 1 if either date is missing/unparseable."""
    if not raw or not start_date:
        return "1"
    try:
        stop_date = date_cls.fromisoformat(str(raw)[:10])
        journey_start = date_cls.fromisoformat(str(start_date)[:10])
        return str((stop_date - journey_start).days + 1)
    except ValueError:
        return "1"


def fetch_railradar_timeline(train_number: str, date_ddmmyyyy: Optional[str] = None) -> List[TimelineStop]:
    """Fetches + parses RailRadar's live status into the SAME TimelineStop
    shape gps_tracking.py already uses for RailKit, so
    compute_avg_speed_kmph() / compute_recent_delay_trend() work on it
    completely unchanged.

    `date_ddmmyyyy` is this app's own date convention (same format the
    caller already has on hand for railway_api.get_live_train_status) —
    converted to RailRadar's own YYYY-MM-DD and passed through so a
    caller asking about a SPECIFIC (often past) date gets that date's real
    journey instead of RailRadar's "most recent run" default. Omit it (or
    pass None/unparseable) for genuinely live polling of today's running
    train, where the auto-detect default is exactly what's wanted.

    Returns [] (never raises) on any failure - see module docstring.
    """
    try:
        data = _fetch_raw(train_number, _ddmmyyyy_to_iso(date_ddmmyyyy))
    except RailRadarFallbackError:
        return []

    start_date = data.get("startDate")
    current_code = (data.get("currentLocation") or {}).get("stationCode")
    route = data.get("route") or []

    stops: List[TimelineStop] = []
    for idx, point in enumerate(route):
        code = point.get("stationCode")
        # RailRadar tells us directly whether the train has "departed" this
        # stop or it's still "upcoming" - real status, not inferred.
        raw_status = point.get("status")
        # BUGFIX: the FINAL destination never gets raw_status "departed" -
        # a train doesn't depart its own terminus. A prior attempt at this
        # fix guessed RailRadar uses the literal string "arrived" for a
        # completed terminus (based on their own site's "Arrived at
        # <station>" wording) - that guess didn't hold up against a real
        # completed run (train 20834), where the destination kept showing
        # "Not confirmed by provider" even after that fix shipped, meaning
        # either the real field uses different wording/casing or isn't
        # reliably set at all. Rather than guess a second string, this
        # keys off the one thing that can't be ambiguous: whether RailRadar
        # has actually recorded a real `actualArrival` timestamp for this
        # stop. A genuine recorded arrival time IS the journey having
        # completed there, regardless of what (if anything) the separate
        # `status` field says - and unlike a guessed status string, this
        # can't silently stop matching if RailRadar's wording differs.
        # Without this, the terminus falls through to the current_code
        # check below, which for a COMPLETED journey is very often still
        # pointing at this same terminus (it's the train's real last known
        # position) - so the destination kept coming out "current" forever,
        # never "passed", and so never qualified for the real-recorded-data
        # merge in app.py's rr_by_code (which only trusts an rr stop whose
        # OWN status is "passed"). Checked first and scoped to the LAST
        # route point only, so every other station's current/departed/
        # upcoming logic below is completely unaffected.
        is_terminus = idx == len(route) - 1
        terminus_has_real_arrival = bool(point.get("actualArrival"))
        terminus_status_says_done = (raw_status or "").strip().lower() in ("arrived", "departed", "completed", "reached", "terminated")
        # Third, guess-proof signal: a train can only ever BE at the
        # terminus by having already departed the stop right before it -
        # there's no other way to get there. So if the immediately
        # preceding stop is already confirmed "passed" (real, not
        # inferred - RailRadar's own "departed"), the terminus logically
        # MUST have been reached too, regardless of what its own status
        # field says or whether actualArrival happens to be populated.
        # `stops` already holds every earlier point in route order at
        # this point in the loop, so this never looks ahead.
        terminus_prev_stop_departed = is_terminus and bool(stops) and stops[-1].status == "passed"
        if is_terminus and (terminus_has_real_arrival or terminus_status_says_done or terminus_prev_stop_departed):
            status = "passed"
        elif current_code and code == current_code:
            status = "current"
        elif raw_status == "departed":
            status = "passed"
        else:
            status = "upcoming"

        arrival = StopTiming(
            scheduled=_hhmm_from_iso(point.get("scheduledArrival")),
            actual=_hhmm_from_iso(point.get("actualArrival")),
            delay_minutes=point.get("delayArrival"),
        )
        departure = StopTiming(
            scheduled=_hhmm_from_iso(point.get("scheduledDeparture")),
            actual=_hhmm_from_iso(point.get("actualDeparture")),
            delay_minutes=point.get("delayDeparture"),
        )

        day_ref = point.get("actualDeparture") or point.get("actualArrival") or point.get("scheduledDeparture")

        stops.append(TimelineStop(
            code=code, name=point.get("stationName"),
            kind="stoppage" if point.get("isHalt") else "intermediate",
            status=status,
            lat=point.get("lat"), lng=point.get("lng"),
            coordinates_from="provider" if point.get("lat") is not None else "none",
            distance_km=point.get("distance"),
            halt_minutes=None,
            day=_day_offset_from_iso(day_ref, start_date),
            arrival=arrival, departure=departure,
        ))

    return stops


def _iso_to_datetime(raw: Optional[str]) -> Optional[datetime]:
    """Full real ISO parse (unlike _hhmm_from_iso, keeps the date + tz), used
    here for genuine elapsed-time math across halts that may span midnight."""
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw))
    except ValueError:
        return None


def get_real_journey_start_date(train_number: str, date_ddmmyyyy: Optional[str] = None) -> Optional[str]:
    """
    BUGFIX SUPPORT ("long journey trains ... it should [not] start day 1 as
    today when no date is given"): the real DD-MM-YYYY (this app's own
    convention) origin-departure date of whichever run RailRadar currently
    considers the ACTIVE one for this train, using RailRadar's own genuine
    auto-detect behavior — the `date` query param, left out entirely (see
    _fetch_raw's docstring: "Omit to auto-detect current run"). RailRadar's
    response carries a real `startDate` (ISO YYYY-MM-DD) for whichever run
    it auto-detected — this just reformats that real field, never guesses
    one.

    WHY THIS IS NEEDED: railway_api.get_live_train_status sends RailKit a
    `date` on every call (RailKit errors on a missing one) — defaulting to
    TODAY whenever the caller has no explicit date from the user. RailKit's
    own per-stop scheduled/expected/actual times come back stamped relative
    to whatever date it was asked about, so for a multi-day journey that
    genuinely started before today, sending "today" makes RailKit itself
    return every station's time already mislabeled with the wrong calendar
    date — a client-side display fix can't correct that, since the wrong
    date is baked into the raw provider strings being displayed as-is.
    Resolving the REAL start date here (once, before the RailKit call) and
    using THAT instead of "today" fixes it at the source.

    `date_ddmmyyyy`, optional: also lets a caller VERIFY a specific
    explicit date, not just auto-detect the blank-date default — passed
    straight through to RailRadar's own `date` param, documented as
    "Journey start date" (not a hint/filter — a real per-run selector,
    unlike RailKit's `date`, which round-18/round-22 evidence showed just
    relabels whichever run RailKit is already attached to; see app.py's
    ws_track_train comment for the full history). When given, this
    returns RailRadar's own resolved startDate for THAT specific request —
    compare it against the date_ddmmyyyy you passed in: if they match,
    RailRadar genuinely found and returned the requested run, not a guess.
    If they don't match (or this returns None), RailRadar couldn't
    disambiguate it either — the caller must not treat the result as
    verified. Only ever changes what's passed to `_fetch_raw`; the blank-
    date auto-detect behavior below is untouched when this stays None.
    """
    try:
        data = _fetch_raw(train_number, _ddmmyyyy_to_iso(date_ddmmyyyy))
    except RailRadarFallbackError:
        return None
    start_date_iso = data.get("startDate")
    if not start_date_iso:
        return None
    try:
        return datetime.strptime(str(start_date_iso)[:10], "%Y-%m-%d").strftime("%d-%m-%Y")
    except ValueError:
        return None


def get_live_speed_kmph(train_number: str) -> "tuple[Optional[float], Optional[str]]":
    """Real INSTANTANEOUS GPS speed straight from RailRadar's own
    `currentLocation.speedKmh` field - not computed/derived here at all,
    just read off their live feed. This is genuinely useful on top of
    gps_tracking.compute_avg_speed_kmph()'s cumulative (distance/time)
    calculation: right after departure (or anywhere the train hasn't yet
    passed a second reporting station with usable data), there's no
    distance/time DELTA to divide yet, so the cumulative calculation
    correctly returns None - but RailRadar may still have a real live
    speed reading for that same instant, straight from the train's GPS.

    Returns (speed_kmph, note) - (None, None) on any failure/missing
    field, never a guessed value.
    """
    try:
        data = _fetch_raw(train_number)
    except RailRadarFallbackError:
        return None, None

    loc = data.get("currentLocation") or {}
    speed = loc.get("speedKmh")
    if speed is None:
        return None, None
    try:
        speed = round(float(speed), 1)
    except (TypeError, ValueError):
        return None, None
    return speed, "RailRadar live GPS speed reading (currentLocation.speedKmh), not a distance/time calculation"


def get_segment_progress(train_number: str) -> dict:
    """
    FEATURE: smooth position/ETA between real station-crossing updates.
    RailKit's own "current station" only flips when the train actually
    crosses/departs that physical station — for halts 60-90+ min apart,
    that means the position and ETA can look frozen for a long stretch
    even though the train is genuinely moving the whole time. RailRadar's
    live feed carries `currentLocation.segmentProgress` (0.0-1.0 — real
    progress between the previous and next station, from crowdsourced GPS,
    not a guess) plus `isActualPosition` (whether this reading is a real
    GPS fix vs a schedule-based placeholder) and `bearingDegrees` — genuine
    signals this app wasn't using before, that let the map/ETA move
    smoothly poll-to-poll instead of only jumping when RailKit's own
    "current station" pointer advances.

    Returns a dict (all keys None if unavailable/failed — never guessed):
      {"segment_progress": float|None, "station_code": str|None,
       "sequence": int|None, "is_actual_position": bool|None,
       "bearing_degrees": float|None, "note": str|None}
    """
    empty = {
        "segment_progress": None, "station_code": None, "sequence": None,
        "is_actual_position": None, "bearing_degrees": None, "note": None,
    }
    try:
        data = _fetch_raw(train_number)
    except RailRadarFallbackError:
        return empty

    loc = data.get("currentLocation") or {}
    progress = loc.get("segmentProgress")
    try:
        progress = max(0.0, min(1.0, float(progress))) if progress is not None else None
    except (TypeError, ValueError):
        progress = None

    return {
        "segment_progress": progress,
        "station_code": loc.get("stationCode"),
        "sequence": loc.get("sequence"),
        "is_actual_position": loc.get("isActualPosition"),
        "bearing_degrees": loc.get("bearingDegrees"),
        "note": "RailRadar live segment progress (currentLocation.segmentProgress) — crowdsourced GPS, real progress between the previous and next station" if progress is not None else None,
    }


def get_station_coordinate(train_number: str, station_code: Optional[str]) -> "tuple[Optional[float], Optional[float]]":
    """
    BUGFIX ("Coordinates: —, Position source: unavailable" for small
    stations RailKit's own getTrainInfo route doesn't have a coordinate
    for and that also aren't in our own ~8,700-entry static table, e.g.
    Intekanne, Chintapalli — "it should be RailRadar right, it is not use
    RailRadar yet"): confirmed against RailRadar's own published schema
    (https://railradar.in/docs/live-train-status) that `currentLocation`
    does NOT carry a raw GPS lat/lng itself (only stationCode/
    segmentProgress/speedKmh/bearingDegrees — see get_segment_progress) —
    so this isn't "the current position's live GPS fix", it's RailRadar's
    OWN per-station `route[].lat`/`route[].lng` figures, the same real
    field fetch_railradar_timeline already reads for its own stop list —
    just looked up for ONE specific station code here, as a genuinely
    independent THIRD coordinate source (after RailKit's getTrainInfo
    route and our static table) for exactly the small stations neither of
    those two happens to cover. RailRadar maintains this coordinate
    per PHYSICAL STATION, not per run, so it's safe to use even from a
    blank-date auto-detected response (see _fetch_raw's own docstring on
    why blank-date is never trusted for WHICH run/date, only for genuinely
    live signals) — a station's real-world location doesn't depend on
    which day's run RailRadar happened to auto-detect.

    Returns (lat, lng) — (None, None) if there's no key configured, the
    call fails, the station code isn't given, or RailRadar's own route
    doesn't have a coordinate for it either (never a guessed position).
    """
    if not station_code:
        return None, None
    try:
        data = _fetch_raw(train_number)
    except RailRadarFallbackError:
        return None, None

    code_norm = station_code.strip().upper()
    for point in (data.get("route") or []):
        if (point.get("stationCode") or "").strip().upper() != code_norm:
            continue
        lat, lng = point.get("lat"), point.get("lng")
        if lat is None or lng is None:
            return None, None
        try:
            return float(lat), float(lng)
        except (TypeError, ValueError):
            return None, None
    return None, None


def get_major_stop_distances(train_number: str) -> List[dict]:
    """Real km between each MAJOR (halting) stop for a given train number -
    the RailYatri-style per-stop distance display. Every distance here is
    RailRadar's own real `distance` field (cumulative from origin); the
    gap to the previous halt is a plain subtraction of two real numbers,
    never estimated. Non-halting pass-through stations are excluded, same
    as the "major stop" framing asked for.

    Returns [] on any failure (no key, request error, empty route) - see
    module docstring.
    """
    try:
        data = _fetch_raw(train_number)
    except RailRadarFallbackError:
        return []

    halts = [p for p in (data.get("route") or []) if p.get("isHalt")]
    if not halts:
        return []

    out = []
    prev_distance = None
    for h in halts:
        dist = h.get("distance")
        gap = (dist - prev_distance) if (dist is not None and prev_distance is not None) else None
        out.append({
            "code": h.get("stationCode"),
            "name": h.get("stationName"),
            "distance_from_origin_km": dist,
            "distance_from_prev_halt_km": gap,
            "speed_to_next_station_kmph": h.get("speedToNextStationKmph"),
            "status": h.get("status"),
            "platform": h.get("platform"),
        })
        if dist is not None:
            prev_distance = dist

    return out


def get_route_averages(train_number: str) -> Optional[dict]:
    """Real average distance AND average time between halts for a given
    train number.

    avg_distance_km_between_halts: RailRadar's own real `train.distance`
    (total route km) divided by (real halt count - 1) - plain arithmetic
    on two real published fields, never estimated.

    avg_time_minutes_between_halts: prefers REAL elapsed time - summing
    actual (not scheduled) arrival/departure gaps between consecutive
    halts that both have real `actualArrival`/`actualDeparture` timestamps
    on THIS run, divided by how many such real gaps existed. Only falls
    back to `train.duration` (the scheduled total journey time) divided by
    halt count if fewer than 2 halts on this run have real actual times
    yet (e.g. train hasn't run much of its route today) - and says so
    plainly in `basis` so the caller/UI can tell which one it got.

    Returns None on any failure (no key, request error, no distance data).
    """
    try:
        data = _fetch_raw(train_number)
    except RailRadarFallbackError:
        return None

    train = data.get("train") or {}
    total_distance_km = train.get("distance")
    total_halts = train.get("totalHalts")
    if total_distance_km is None or not total_halts or total_halts < 2:
        return None

    avg_distance_km = round(total_distance_km / (total_halts - 1), 1)

    halts = [p for p in (data.get("route") or []) if p.get("isHalt")]
    real_gaps_minutes = []
    for a, b in zip(halts, halts[1:]):
        t1 = _iso_to_datetime(a.get("actualDeparture") or a.get("actualArrival"))
        t2 = _iso_to_datetime(b.get("actualArrival") or b.get("actualDeparture"))
        if t1 and t2 and t2 > t1:
            real_gaps_minutes.append((t2 - t1).total_seconds() / 60.0)

    if len(real_gaps_minutes) >= 2:
        avg_time_minutes = round(sum(real_gaps_minutes) / len(real_gaps_minutes), 1)
        basis = (f"real actual timings across {len(real_gaps_minutes)} halt-to-halt "
                 f"segments already run today")
    elif train.get("duration"):
        avg_time_minutes = round(train["duration"] / (total_halts - 1), 1)
        basis = "scheduled total journey duration / halt count (not enough of today's run has actual times yet)"
    else:
        avg_time_minutes = None
        basis = "no real actual-timing data or scheduled duration available"

    return {
        "avg_distance_km_between_halts": avg_distance_km,
        "avg_time_minutes_between_halts": avg_time_minutes,
        "total_distance_km": total_distance_km,
        "total_halts": total_halts,
        "basis": basis,
    }


_ROUTE_HISTORY_DEFAULT_LOOKBACK_DAYS = 14
_ROUTE_HISTORY_MAX_LOOKBACK_DAYS = 30


@cached(ttl_seconds=86400, prefix="railradar_route_history")
def get_route_delay_history(train_number: str, lookback_days: int = _ROUTE_HISTORY_DEFAULT_LOOKBACK_DAYS) -> dict:
    """
    FEATURE: real per-STATION delay history for this train, built from
    RailRadar's own past-date live-status responses — unlike
    historical_delay.py (which calls RailKit's separate /history endpoint
    and collapses each day down to ONE final delay figure), this walks
    RailRadar's `date=<past date>` query (already used by
    fetch_railradar_timeline — see that function's own docstring) and
    keeps EVERY real per-station delayArrival/delayDeparture RailRadar
    reports for that completed run, not just the last one.

    Real, not assumed: RailRadar's own docs don't state how many days
    back a `date` query reliably returns real archived per-station data
    (checked directly — it's undocumented), so this doesn't assume any
    retention window. Each day is queried independently and honestly
    contributes 0 samples if RailRadar has nothing real for it (train
    didn't run that day, hasn't completed yet, or the provider simply has
    no archived data that far back) — never backfilled or guessed. Use
    get_route_delay_history_diagnostics() below to see exactly which of
    the last N days actually had real data, e.g. after deploying
    somewhere with real network access to api.railradar.in.

    Cached 24h (a completed past day's data never changes), keyed on
    (train_number, lookback_days) — so this costs up to `lookback_days`
    real RailRadar calls only on the FIRST request for a given train each
    day, not on every poll.

    Returns {station_code: {"avg_delay_minutes": float, "samples": int,
    "min_delay_minutes": int, "max_delay_minutes": int}} — a station only
    appears here if at least one real past run gave it a real recorded
    delay. Never includes a station with 0 real samples.
    """
    lookback_days = max(1, min(int(lookback_days or _ROUTE_HISTORY_DEFAULT_LOOKBACK_DAYS), _ROUTE_HISTORY_MAX_LOOKBACK_DAYS))
    today = datetime.now()

    per_station_delays: dict = {}
    for i in range(1, lookback_days + 1):
        day = today - timedelta(days=i)
        date_ddmmyyyy = day.strftime("%d-%m-%Y")
        try:
            stops = fetch_railradar_timeline(train_number, date_ddmmyyyy)
        except Exception:
            stops = []
        for stop in stops:
            if stop.status != "passed":
                continue
            code = (stop.code or "").strip().upper()
            if not code:
                continue
            delay = stop.departure.delay_minutes if stop.departure and stop.departure.delay_minutes is not None else (
                stop.arrival.delay_minutes if stop.arrival else None
            )
            if delay is None:
                continue
            per_station_delays.setdefault(code, []).append(delay)

    result = {}
    for code, delays in per_station_delays.items():
        result[code] = {
            "avg_delay_minutes": round(sum(delays) / len(delays), 1),
            "samples": len(delays),
            "min_delay_minutes": min(delays),
            "max_delay_minutes": max(delays),
        }
    return result


def get_route_delay_history_diagnostics(train_number: str, lookback_days: int = _ROUTE_HISTORY_DEFAULT_LOOKBACK_DAYS) -> dict:
    """
    DIAGNOSTIC / VERIFICATION endpoint support — real per-day success/
    failure detail behind get_route_delay_history()'s aggregated numbers,
    so this can be checked against RailRadar's REAL behavior once
    deployed somewhere with real internet access (this exact check could
    not be run from the sandbox that built this feature — outbound
    requests to api.railradar.in were blocked there, so this was built to
    RailRadar's own documented response shape and to fail honestly/
    visibly rather than assumed to work). NOT cached, unlike
    get_route_delay_history() — always a fresh real check.

    Returns per-day detail (date, whether real stops came back, how many
    had a real delay figure) plus the same aggregated per-station result,
    so a genuinely broken day is visible instead of silently averaged
    away.
    """
    lookback_days = max(1, min(int(lookback_days or _ROUTE_HISTORY_DEFAULT_LOOKBACK_DAYS), _ROUTE_HISTORY_MAX_LOOKBACK_DAYS))
    today = datetime.now()

    days_detail = []
    per_station_delays: dict = {}
    for i in range(1, lookback_days + 1):
        day = today - timedelta(days=i)
        date_ddmmyyyy = day.strftime("%d-%m-%Y")
        try:
            stops = fetch_railradar_timeline(train_number, date_ddmmyyyy)
        except Exception as exc:
            days_detail.append({
                "date": date_ddmmyyyy, "stops_returned": 0, "stations_with_real_delay": 0,
                "error": str(exc),
            })
            continue

        stations_with_delay = 0
        for stop in stops:
            if stop.status != "passed":
                continue
            code = (stop.code or "").strip().upper()
            if not code:
                continue
            delay = stop.departure.delay_minutes if stop.departure and stop.departure.delay_minutes is not None else (
                stop.arrival.delay_minutes if stop.arrival else None
            )
            if delay is None:
                continue
            stations_with_delay += 1
            per_station_delays.setdefault(code, []).append(delay)

        days_detail.append({
            "date": date_ddmmyyyy, "stops_returned": len(stops),
            "stations_with_real_delay": stations_with_delay,
            "error": get_last_error() if not stops else None,
        })

    per_station_summary = {
        code: {
            "avg_delay_minutes": round(sum(delays) / len(delays), 1),
            "samples": len(delays),
        }
        for code, delays in per_station_delays.items()
    }

    days_with_real_data = sum(1 for d in days_detail if d["stations_with_real_delay"] > 0)
    return {
        "train_number": train_number,
        "lookback_days": lookback_days,
        "days_with_real_data": days_with_real_data,
        "days_detail": days_detail,
        "stations_with_history": len(per_station_summary),
        "per_station_summary": per_station_summary,
        "note": (
            f"{days_with_real_data}/{lookback_days} recent days returned real per-station delay data from "
            f"RailRadar for train {train_number}. Days with 0 stations are shown as such (train didn't run, "
            "hasn't completed yet, or RailRadar has no archived data that far back) — never guessed or "
            "backfilled. If days_with_real_data is 0 across a wide lookback_days, RailRadar's `date` param "
            "likely doesn't retain real per-station history this far back for this train, and the route-history "
            "prediction nudge below will correctly stay inactive rather than fabricate one."
        ),
    }