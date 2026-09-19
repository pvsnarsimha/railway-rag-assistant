"""
gps_tracking.py
------------------
FEATURE: Real-Time GPS Train Tracking + Interactive Route Map with Stations.

Now backed by RailKit (see railway_api.py for why this goes through a local
Node microservice). RailKit is a genuine improvement here over the previous
RapidAPI listing for two of this app's four latest features:

  - `getTrainInfo()` returns real {latitude, longitude} coordinates for
    (most) stations on a train's route - not just the ~50 major stations in
    our own station_coordinates.json fallback table.
  - `trackTrain()` reports the current station code + a timeline of
    stoppages/intermediate points, but NOT a raw GPS lat/lng itself - so for
    a plottable live position, this module looks up the current station's
    REAL coordinate from getTrainInfo's route (when available) rather than
    our static table, falling back to the static table only if that
    specific station's coordinate is missing.

Same honesty rule as always: if neither the provider nor our fallback table
has a coordinate, the position is reported as `"unavailable"`, never
invented. `position_source` on every result tells you exactly which of the
three tiers produced the marker: "provider" (RailKit's real per-station
coordinate), "estimated_from_last_station" (our static fallback table), or
"unavailable".
"""

import json
import math
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

import railway_api

STATION_COORDS_PATH = os.path.join(os.path.dirname(__file__), "data", "station_coordinates.json")

with open(STATION_COORDS_PATH, "r", encoding="utf-8") as f:
    _STATION_COORDS = json.load(f)


def _first_present(d: dict, keys, default=None):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] not in (None, ""):
            return d[k]
    return default


def _lookup_station(code: Optional[str]) -> Optional[dict]:
    if not code:
        return None
    return _STATION_COORDS.get(code.strip().upper())


def _parse_delay_minutes(delay_text) -> Optional[int]:
    """RailKit's delay fields are human text ('On Time', '5m late', or a
    bare number) rather than a guaranteed integer - pull a number out if
    there is one, otherwise leave it as None (0 delay is NOT assumed)."""
    if delay_text is None:
        return None
    if isinstance(delay_text, (int, float)):
        return int(delay_text)
    match = re.search(r"-?\d+", str(delay_text))
    return int(match.group(0)) if match else None


@dataclass
class RouteStation:
    code: str
    name: str
    lat: Optional[float]
    lng: Optional[float]
    scheduled_arrival: Optional[str] = None
    scheduled_departure: Optional[str] = None
    distance_km: Optional[str] = None
    has_coordinates: bool = False
    coordinates_from: str = "none"  # "provider" | "fallback_table" | "none"


def get_route_with_coordinates(train_number: str):
    """Convenience wrapper: fetches AND parses. Prefer parse_route()
    directly if you already have the getTrainInfo response from elsewhere
    in the same request."""
    data = railway_api.get_train_info(train_number)
    return parse_route(data)


def parse_route(data: dict):
    """
    Returns a list of RouteStation from an already-fetched
    railway_api.get_train_info() (RailKit getTrainInfo) response:
    { success, data: { trainInfo: {...}, route: [ { stnCode, stnName,
    arrival, departure, halt, distance, day,
    coordinates: { latitude, longitude } }, ... ] } }
    """
    payload = data.get("data", data) if isinstance(data, dict) else {}

    stops = None
    if isinstance(payload, dict) and isinstance(payload.get("route"), list):
        stops = payload["route"]
    elif isinstance(payload, list):
        stops = payload
    if stops is None:
        stops = []

    route = []
    for stop in stops:
        code = _first_present(stop, ["stnCode", "station_code", "stationCode", "code"])
        name = _first_present(stop, ["stnName", "station_name", "stationName", "name"], default=code)
        arrival = _first_present(stop, ["arrival", "arrival_time", "arrivalTime"])
        departure = _first_present(stop, ["departure", "departure_time", "departureTime"])
        distance = _first_present(stop, ["distance", "distanceFromSource"])

        lat = lng = None
        coordinates_from = "none"
        provider_coords = stop.get("coordinates") if isinstance(stop, dict) else None
        if isinstance(provider_coords, dict) and provider_coords.get("latitude") is not None:
            try:
                lat = float(provider_coords["latitude"])
                lng = float(provider_coords["longitude"])
                coordinates_from = "provider"
            except (TypeError, ValueError):
                lat = lng = None

        if lat is None:
            fallback = _lookup_station(code)
            if fallback:
                lat, lng = fallback["lat"], fallback["lng"]
                coordinates_from = "fallback_table"

        route.append(RouteStation(
            code=code or "?", name=name or (code or "Unknown"),
            lat=lat, lng=lng,
            scheduled_arrival=arrival, scheduled_departure=departure,
            distance_km=distance, has_coordinates=lat is not None,
            coordinates_from=coordinates_from,
        ))
    return route


@dataclass
class LivePosition:
    train_number: str
    train_name: Optional[str] = None
    status_note: Optional[str] = None
    current_station_code: Optional[str] = None
    current_station_name: Optional[str] = None
    next_station_code: Optional[str] = None
    next_station_name: Optional[str] = None
    delay_minutes: Optional[int] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    position_source: str = "unavailable"
    raw: dict = field(default_factory=dict)


def get_live_position(train_number: str, date_ddmmyyyy: str = None) -> LivePosition:
    """Convenience wrapper: fetches trackTrain AND getTrainInfo (for real
    per-station coordinates), then parses both together. Prefer
    parse_live_position() directly if you already have one or both
    responses from elsewhere in the same request."""
    track_data = railway_api.get_live_train_status(train_number, date_ddmmyyyy)
    try:
        train_info_data = railway_api.get_train_info(train_number)
    except railway_api.RailwayAPIError:
        train_info_data = None  # still return a position from station-code + fallback table
    return parse_live_position(train_number, track_data, train_info_data)


def parse_live_position(train_number: str, track_data: dict, train_info_data: dict = None) -> LivePosition:
    """
    Parses an already-fetched railway_api.get_live_train_status()
    (RailKit trackTrain) response, shape:
    { success, data: { trainNo, trainName, statusNote, currentStationCode,
    timeline: [ { type: "stoppage"|"intermediate", status: "passed"|
    "current"|"upcoming", stationCode, stationName, arrival: {...},
    departure: {...} }, ... ] } }

    train_info_data, if provided (an already-fetched get_train_info()
    response), supplies REAL per-station coordinates for the current
    station - the single biggest accuracy improvement RailKit brings over
    the previous provider. Falls back to the static station_coordinates.json
    table if that station's coordinate isn't available from either source.
    """
    payload = track_data.get("data", track_data) if isinstance(track_data, dict) else {}

    train_name = payload.get("trainName")
    status_note = payload.get("statusNote")
    current_code = payload.get("currentStationCode")
    timeline = payload.get("timeline") or []

    # BUGFIX ("Position source showing unavailable" even when the SAME
    # response's own per-stop timeline clearly marks one stop "current"):
    # every lookup below used to match purely on RailKit's TOP-LEVEL
    # currentStationCode field against each stop's own stationCode - if
    # that top-level field is missing, blank, or (rarely) formatted
    # differently than the matching per-stop code in this exact same
    # response, NOTHING ever matched, so current_name/delay/coordinates all
    # fell straight through to "unavailable" even though the per-stop
    # status array - the SAME source of truth this app already trusts
    # everywhere else (current_position_distance_km, position_from_stops,
    # the impossible-downstream-status repair pass) - had a real,
    # unambiguous "current" entry the whole time. Falls back to that
    # per-stop signal ONLY when the top-level field didn't resolve to
    # anything real in this response; a genuine match is never overridden,
    # this only fills the gap when there wasn't one. Compared
    # case/whitespace-insensitively, same normalization _lookup_station
    # already applies, so a harmless formatting difference alone can't
    # trigger this either.
    def _norm_code(c):
        return (c or "").strip().upper()

    current_code_matches = any(
        _norm_code(point.get("stationCode")) == _norm_code(current_code) for point in timeline
    ) if current_code else False
    if not current_code_matches:
        current_status_stop = next((point for point in timeline if point.get("status") == "current"), None)
        if current_status_stop is not None:
            current_code = current_status_stop.get("stationCode")

    current_name = None
    next_code = next_name = None
    delay_minutes = None

    for i, point in enumerate(timeline):
        if _norm_code(point.get("stationCode")) == _norm_code(current_code):
            current_name = point.get("stationName")
            if point.get("type") == "stoppage":
                # BUGFIX: this used to trust RailKit's raw departure/arrival
                # `delay` field directly (_parse_delay_minutes(dep_delay)) -
                # the SAME unreliable field that was already proven wrong
                # twice on the per-station timeline (Warangal showing "+1m"
                # against a real 86-minute Exp/Act gap). This is the
                # headline "Reported delay" AND the current_delay_minutes
                # input the WHOLE top-level ML prediction is anchored to -
                # so when this raw field jitters poll to poll, that jitter
                # propagates straight into predicted_delay_minutes (the
                # visible 7/10/12/14/15/16/5/6 min swings). Routed through
                # the SAME _parse_timing() fix already applied on the
                # per-station timeline instead of re-deriving delay
                # separately here: real actual-vs-expected arithmetic when
                # both are real clock times, RailKit's raw field only as a
                # fallback when there's no actual time yet to check it
                # against. One source of truth for delay, not two.
                dep_timing = _parse_timing(point.get("departure"))
                arr_timing = _parse_timing(point.get("arrival"))
                delay_minutes = dep_timing.delay_minutes if dep_timing.delay_minutes is not None else arr_timing.delay_minutes
            for later in timeline[i + 1:]:
                if later.get("status") == "upcoming":
                    next_code = later.get("stationCode")
                    next_name = later.get("stationName")
                    break
            break

    if next_code is None:
        for point in timeline:
            if point.get("status") == "upcoming":
                next_code, next_name = point.get("stationCode"), point.get("stationName")
                break

    # Coordinate for the current station: sourced from the full timeline
    # below, which itself resolves each stop through three tiers - a real
    # per-station coordinate from RailKit's route (best), our static
    # fallback table, or a geometric interpolation along the route between
    # the nearest two stations that DO have a real coordinate (see
    # parse_full_timeline's interpolation pass) - so small stations with no
    # direct coordinate of their own still get a real, honestly-labelled
    # position instead of the map going blank. Only truly falls through to
    # "unavailable" if none of the three tiers can place this station at
    # all (e.g. it's before the first or after the last station RailKit
    # gave any coordinate for).
    lat = lng = None
    position_source = "unavailable"
    for stn in parse_full_timeline(track_data, train_info_data):
        if _norm_code(stn.code) == _norm_code(current_code):
            lat, lng = stn.lat, stn.lng
            current_name = current_name or stn.name
            position_source = {
                "provider": "provider",
                "fallback_table": "estimated_from_last_station",
                "interpolated": "interpolated_on_route",
                "nearest_known_station": "estimated_from_nearest_station",
            }.get(stn.coordinates_from, "unavailable")
            break

    return LivePosition(
        train_number=train_number, train_name=train_name, status_note=status_note,
        current_station_code=current_code, current_station_name=current_name,
        next_station_code=next_code, next_station_name=next_name,
        delay_minutes=delay_minutes, lat=lat, lng=lng,
        position_source=position_source, raw=payload,
    )


def position_from_stops(train_number: str, stops, train_name: Optional[str] = None,
                         status_note: Optional[str] = None) -> LivePosition:
    """Builds a LivePosition directly from an already-resolved list of
    TimelineStop objects, instead of parse_live_position's raw-RailKit-JSON
    parse. Both parse_full_timeline (RailKit) AND railradar_fallback.
    fetch_railradar_timeline (RailRadar) already produce the SAME
    TimelineStop shape (see that function's own docstring), so this works
    on a corrected stop list from either provider without caring which one
    it came from.

    NEEDED FOR: app.py's ws_track_train explicit-date correction path. When
    RailKit is confirmed to have ignored an explicit date (see the
    self-correcting anchor pass and date_reliability_warning logic there)
    and a RailRadar date-scoped re-fetch has been independently VERIFIED to
    have actually honored it (RailRadar's own resolved startDate for that
    exact request matches what was asked — see railradar_fallback.
    get_real_journey_start_date's date_ddmmyyyy param), the corrected stop
    list becomes the new source of truth for the running-status display —
    but without this, the headline "current station"/delay/ETA (driven by
    LivePosition, not the stop list) would stay anchored to RailKit's wrong
    run while only the list underneath got corrected, showing two
    disagreeing positions on the same screen.

    Mirrors parse_live_position's own real logic — current station, then
    its real delay from its own arrival/departure timing, then the first
    upcoming stop after it — just reading it off parsed TimelineStop
    objects instead of raw provider JSON, since a corrected stop list is
    the same shape whichever provider it came from.
    """
    current = next((s for s in stops if s.status == "current"), None)
    if current is None:
        # No live "current" pointer in the corrected data (the requested
        # day's run hasn't started yet, or has already finished) - fall
        # back to the last "passed" stop, same "last real entry is ground
        # truth" convention used elsewhere in this app (e.g. the frontend's
        # scrollToLivePositionOnce fallback).
        passed = [s for s in stops if s.status == "passed"]
        current = passed[-1] if passed else None

    if current is None:
        return LivePosition(train_number=train_number, train_name=train_name, status_note=status_note)

    delay_minutes = current.departure.delay_minutes
    if delay_minutes is None:
        delay_minutes = current.arrival.delay_minutes

    current_idx = stops.index(current)
    next_stop = next((s for s in stops[current_idx + 1:] if s.status == "upcoming"), None)

    position_source = {
        "provider": "provider",
        "fallback_table": "estimated_from_last_station",
        "interpolated": "interpolated_on_route",
        "nearest_known_station": "estimated_from_nearest_station",
    }.get(current.coordinates_from, "unavailable")

    return LivePosition(
        train_number=train_number, train_name=train_name, status_note=status_note,
        current_station_code=current.code, current_station_name=current.name,
        next_station_code=next_stop.code if next_stop else None,
        next_station_name=next_stop.name if next_stop else None,
        delay_minutes=delay_minutes, lat=current.lat, lng=current.lng,
        position_source=position_source, raw={},
    )


def _first_present_nested(d: dict, keys, default=None):
    """Same idea as _first_present but tolerant of the value being 0/False
    (only None/"" are treated as absent) - times like "00:00" are valid."""
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None and d[k] != "":
            return d[k]
    return default


@dataclass
class StopTiming:
    """Expected (scheduled/predicted) vs actual, for one event (arrival OR
    departure) at one station. Any field RailKit doesn't provide for this
    stop is left as None and rendered as "unavailable" downstream - never
    guessed. `delay_minutes` is RailKit's own reported delay for this
    specific event when given; otherwise derived from expected vs actual
    if both are real clock times."""
    scheduled: Optional[str] = None
    expected: Optional[str] = None
    actual: Optional[str] = None
    delay_minutes: Optional[int] = None


@dataclass
class TimelineStop:
    code: str
    name: str
    kind: str  # "stoppage" | "intermediate" - intermediate = small/passing station, not a scheduled halt
    status: str  # "passed" | "current" | "upcoming"
    lat: Optional[float]
    lng: Optional[float]
    coordinates_from: str  # "provider" | "fallback_table" | "interpolated" | "nearest_known_station" | "none"
    distance_km: Optional[str]
    halt_minutes: Optional[str]
    day: Optional[str]
    arrival: StopTiming
    departure: StopTiming
    # RailYatri-style "X km from <last reporting station>" for small
    # intermediate/passing points that don't report their own live status -
    # real arithmetic on RailKit's own distance_km figures (see
    # _annotate_distance_since_last_stoppage), never invented. None for the
    # reporting (stoppage) stations themselves and for any stop before the
    # first reporting station.
    distance_since_last_stoppage_km: Optional[float] = None
    last_reporting_station: Optional[str] = None


def _parse_timing(event: dict) -> StopTiming:
    if not isinstance(event, dict):
        return StopTiming()
    scheduled = _first_present_nested(event, ["scheduled", "scheduledTime", "schTime", "sch", "std", "sta"])
    expected = _first_present_nested(event, ["expected", "expectedTime", "eta", "etd", "predicted"])
    actual = _first_present_nested(event, ["actual", "actualTime", "ata", "atd", "actualArrival", "actualDeparture"])
    delay = _parse_delay_minutes(event.get("delay"))

    # BUGFIX: RailKit's own `delay` field can disagree with its OWN
    # actual/expected clock times on the SAME event — seen live: Warangal's
    # real recorded arrival was Exp 16:35 / Act 18:01 (an 86-minute real
    # gap, once the train had actually arrived - not a future prediction),
    # yet RailKit's `delay` field still read "+1m". Whenever we have both a
    # real `actual` time and something to compare it against (expected,
    # falling back to scheduled), that's real arithmetic on two real
    # timestamps - a ground truth RailKit's own field shouldn't be allowed
    # to override with a stale/wrong number. This replaces `delay`
    # whenever that comparison is possible, for EVERY station regardless
    # of status (passed/current/upcoming) - not just the upcoming-station
    # predicted case app.py's _predict_delay_per_reporting_station already
    # handles separately. RailKit's own `delay` is now only used as a
    # fallback when actual isn't parseable as a clock time (e.g. still
    # literally "SRC" or missing for a station not yet reached).
    anchor = expected or scheduled
    actual_min = _time_str_to_minutes(actual)
    anchor_min = _time_str_to_minutes(anchor)
    if actual_min is not None and anchor_min is not None:
        diff = actual_min - anchor_min
        # BUGFIX: a blanket "diff < -60 => midnight rollover" rule wrongly
        # reinterprets a station that's simply running well ahead of
        # schedule (a genuine, same-day negative diff of more than an hour
        # - not unusual at padded-schedule junction stations) as having
        # wrapped past midnight, turning e.g. a real "-110 min early" into
        # a nonsensical "+1330 min late". A true midnight rollover only
        # happens when the two clock times are on opposite sides of
        # midnight, which shows up as a gap of more than 12h - the standard
        # circular-time-diff test - not merely "more than an hour".
        if diff < -720:
            diff += 1440
        elif diff > 720:
            diff -= 1440
        delay = round(diff)

    return StopTiming(scheduled=scheduled, expected=expected, actual=actual, delay_minutes=delay)


def get_full_timeline(train_number: str, date_ddmmyyyy: str = None):
    """Convenience wrapper: fetches trackTrain AND getTrainInfo, then parses
    both into the full IRCTC-style stop-by-stop timeline (every station
    RailKit reports - scheduled halts AND the small intermediate/passing
    stations - not just the ~50 major stations in the static fallback
    table). Prefer parse_full_timeline() directly if you already have both
    responses fetched elsewhere in the same request (as the /ws/track
    handler does)."""
    track_data = railway_api.get_live_train_status(train_number, date_ddmmyyyy)
    try:
        train_info_data = railway_api.get_train_info(train_number)
    except railway_api.RailwayAPIError:
        train_info_data = None
    return parse_full_timeline(track_data, train_info_data)


def parse_full_timeline(track_data: dict, train_info_data: dict = None):
    """
    Builds the full stop-by-stop list (every entry in trackTrain's
    `timeline`, both `type: "stoppage"` scheduled halts AND
    `type: "intermediate"` small/passing stations RailKit reports GPS
    progress through) with expected-vs-actual arrival AND departure for
    each, plus a real coordinate when one is available - exactly the
    ingredients an IRCTC-style running-status list needs.

    Coordinate resolution follows the same honesty rule as
    parse_live_position(): a real per-station coordinate from
    getTrainInfo's route (when train_info_data is given) is preferred,
    then the static station_coordinates.json fallback table, and if
    neither has it the stop's lat/lng stay None - the frontend shows that
    as "no map fix for this station" rather than a guessed position.
    """
    payload = track_data.get("data", track_data) if isinstance(track_data, dict) else {}
    timeline = payload.get("timeline") or []

    route_coords_by_code = {}
    route_distance_by_code = {}
    if train_info_data:
        for stn in parse_route(train_info_data):
            if stn.lat is not None:
                route_coords_by_code[stn.code] = (stn.lat, stn.lng)
            d = _distance_km_value(stn.distance_km)
            if d is not None:
                route_distance_by_code[stn.code] = d

    stops = []
    for point in timeline:
        code = point.get("stationCode") or "?"
        name = point.get("stationName") or code
        kind = point.get("type") or "intermediate"
        status = point.get("status") or "upcoming"

        lat = lng = None
        coordinates_from = "none"
        if code in route_coords_by_code:
            lat, lng = route_coords_by_code[code]
            coordinates_from = "provider"
        else:
            fallback = _lookup_station(code)
            if fallback:
                lat, lng = fallback["lat"], fallback["lng"]
                coordinates_from = "fallback_table"

        # ROOT-CAUSE FIX (this is the earlier "blank Next station ETA" bug's
        # real source): the live tracking timeline sometimes doesn't carry a
        # `distance`/`distanceFromSource` for small non-reporting points at
        # all — every downstream consumer (current-position distance,
        # per-station ETA, distance-since-last-stoppage) was individually
        # working around that with its own fallback, which still missed
        # cases where the station isn't on the STATIC commercial route
        # either. Filled centrally here instead, once, from the same real
        # getTrainInfo() route data already used for coordinates just
        # above — so every consumer downstream just sees a real distance_km
        # and never has to know a fallback happened.
        distance_km = _first_present(point, ["distance", "distanceFromSource"])
        if distance_km is None and code in route_distance_by_code:
            distance_km = route_distance_by_code[code]

        stops.append(TimelineStop(
            code=code, name=name, kind=kind, status=status,
            lat=lat, lng=lng, coordinates_from=coordinates_from,
            distance_km=distance_km,
            halt_minutes=_first_present(point, ["halt", "haltMinutes"]),
            day=point.get("day"),
            arrival=_parse_timing(point.get("arrival")),
            departure=_parse_timing(point.get("departure")),
        ))

    finalize_timeline_stops(stops)
    return stops


def _repair_impossible_downstream_statuses(stops) -> None:
    """
    BUGFIX ("Vande Bharat 20833 shows Secunderabad Jn — the actual FINAL
    destination — already reached, with a real-looking '+24m late' pill
    and 720.9 km covered, while Khammam and Warangal, both EARLIER on the
    exact same route, still show 'upcoming' with only predicted ETAs" —
    and the direct cause of the PREVIOUS round's "720.9 km covered so far"
    while the train was genuinely still sitting at Eluru, ~600km short of
    that: same 720.9 figure, same root cause, just seen from two different
    screens): RailKit's own per-stop `status` field can go wrong
    specifically at a route's terminal station — the exact same failure
    already documented and worked around once before, in the OTHER
    direction, for train 20707 ("kept SECUNDERABAD JN 'current' for 9+
    hours after actually finishing at VISAKHAPATNAM" — see
    computeJourneyLikelyComplete in LiveTrackingScreen.web.js). This is
    that same provider inconsistency again: a downstream station marked
    "passed" (or "current") while a station genuinely earlier on the same
    route is still "upcoming" — not just unlikely, but physically
    impossible on a route the train traverses in one direction, since it
    cannot have reached a later station without first reaching every
    earlier one.

    Every consumer of `status` trusted RailKit's per-stop field completely
    instead of checking it against that basic constraint —
    current_position_distance_km()'s "last reporting passed station"
    fallback, the frontend's own identical backward scan for "km covered
    so far", and the timeline row rendering itself all independently
    picked up the same bad "passed" flag on the real destination and
    turned it into "the train has already finished the whole ~720km
    route", each in its own display.

    Real fix, no new guessing: walk `stops` in their real route order (this
    list already IS that order) and find the first one that ISN'T
    "passed" — that is the genuine leading edge of the journey, whatever
    it honestly says ("current" if RailKit has a live pointer there,
    "upcoming" if it doesn't). Nothing AFTER that point can honestly be
    "passed" or "current" either, so any stop RailKit marked that way
    anyway is downgraded to "upcoming" — the honest default absent real
    evidence, never a guessed timestamp or invented status. Stops at or
    before the leading edge are never touched: this only ever removes an
    impossible downstream claim, never invents or removes a real one
    closer to the front. A fully "passed" list (journey genuinely
    complete) and a fully "upcoming" one (not yet started) both leave this
    as a no-op, same as the ordinary case where nothing downstream was
    ever marked done.
    """
    frontier = next((i for i, s in enumerate(stops) if s.status != "passed"), None)
    if frontier is None:
        return
    for s in stops[frontier + 1:]:
        if s.status in ("passed", "current"):
            s.status = "upcoming"


def finalize_timeline_stops(stops) -> None:
    """The shared enrichment pass every raw stop list needs before it's fit
    to display or feed the rest of the pipeline — factored out of
    parse_full_timeline so railradar_fallback.fetch_railradar_timeline's
    own stop list (used as-is by app.py's explicit-date correction path
    when RailKit is confirmed to have ignored an explicit date — see
    date_corrected_via_railradar there) gets the SAME real-data enrichment
    RailKit's own timeline always got, not a degraded version of it just
    because it came from a different provider. Mutates `stops` in place;
    returns nothing, same convention as the three helpers it calls.

    Small stations without a direct coordinate/distance still get a real
    position/figure interpolated along the route between the nearest two
    stops that DO have one (never a flat guess, never extrapolated past a
    known anchor), every small passing/intermediate stop gets a RailYatri-
    style "N km from <last reporting station>" caption, and the origin's
    non-existent "arrival" / destination's non-existent "departure" (RailKit
    sends literal "SRC"/"DSTN" sentinels for these; RailRadar just leaves
    them empty — _timing_has_no_real_event treats both the same way) get
    mirrored from that same halt's one real recorded event, so every
    downstream consumer just sees a normal real timing either way.

    Also repairs an impossible downstream "passed"/"current" status (see
    _repair_impossible_downstream_statuses) BEFORE any of the above runs,
    so every later step — including this same function's own distance/
    caption logic — works from an already-consistent status sequence.
    """
    _repair_impossible_downstream_statuses(stops)
    _interpolate_missing_coordinates(stops)
    _interpolate_missing_distance_km(stops)
    _annotate_distance_since_last_stoppage(stops)
    if stops:
        # ROBUSTNESS: use the first/last REPORTING (kind != "intermediate")
        # stop rather than stops[0]/stops[-1] - the raw timeline can carry a
        # small passing/signalling point before the real origin or after the
        # real destination's own entry, which would otherwise make this
        # mirror check (and set) the wrong stop entirely, leaving the actual
        # origin/destination halt's sentinel untouched.
        reporting_stops = [s for s in stops if s.kind != "intermediate"]
        origin = reporting_stops[0] if reporting_stops else stops[0]
        if _timing_has_no_real_event(origin.arrival) and not _timing_has_no_real_event(origin.departure):
            origin.arrival = StopTiming(
                scheduled=origin.departure.scheduled, expected=origin.departure.expected,
                actual=origin.departure.actual, delay_minutes=origin.departure.delay_minutes,
            )
        destination = reporting_stops[-1] if reporting_stops else stops[-1]
        if _timing_has_no_real_event(destination.departure) and not _timing_has_no_real_event(destination.arrival):
            destination.departure = StopTiming(
                scheduled=destination.arrival.scheduled, expected=destination.arrival.expected,
                actual=destination.arrival.actual, delay_minutes=destination.arrival.delay_minutes,
            )


def _timing_has_no_real_event(timing: StopTiming) -> bool:
    """True if none of this StopTiming's scheduled/expected/actual fields
    parse as a real clock time - i.e. this event genuinely doesn't exist
    for this station (RailKit's "SRC"/"DSTN" sentinels, missing data, etc.)
    rather than just being momentarily unconfirmed. Reuses
    _time_str_to_minutes so "is this a real time" is judged the exact same
    way everywhere else in this file."""
    return (
        _time_str_to_minutes(timing.scheduled) is None
        and _time_str_to_minutes(timing.expected) is None
        and _time_str_to_minutes(timing.actual) is None
    )


def _interpolate_missing_distance_km(stops) -> None:
    """Fills in (in place) `distance_km` for any stop that still doesn't
    have one after the live-timeline + static-route lookups in
    parse_full_timeline, by linear interpolation (weighted by position in
    the stop list) between the nearest earlier and later stop that DO have
    a real distance_km — the same anchoring approach as
    _interpolate_missing_coordinates, just for distance instead of lat/lng.
    Stops before the first, or after the last, known distance are left
    alone rather than extrapolated (no real anchor to extrapolate from)."""
    known_idx = [i for i, s in enumerate(stops) if _distance_km_value(s.distance_km) is not None]
    if len(known_idx) < 2:
        return
    known_set = set(known_idx)
    for i, s in enumerate(stops):
        if i in known_set:
            continue
        earlier = [j for j in known_idx if j < i]
        later = [j for j in known_idx if j > i]
        if not earlier or not later:
            continue
        prev_i, next_i = earlier[-1], later[0]
        d_prev = _distance_km_value(stops[prev_i].distance_km)
        d_next = _distance_km_value(stops[next_i].distance_km)
        if d_prev is None or d_next is None or next_i == prev_i:
            continue
        ratio = (i - prev_i) / (next_i - prev_i)
        s.distance_km = round(d_prev + ratio * (d_next - d_prev), 1)


def _annotate_distance_since_last_stoppage(stops) -> None:
    """Fills in (in place) `distance_since_last_stoppage_km` and
    `last_reporting_station` for every intermediate (non-reporting) stop,
    the way RailYatri/NTES show "X km from <station>" for small stations
    that don't themselves report live status. Computed as a plain
    subtraction of RailKit's own real `distance_km` figures between this
    stop and the nearest earlier scheduled-halt ("stoppage") stop - genuine
    arithmetic on real provider data, never invented. Left None when either
    distance figure is missing, or when there's no earlier reporting
    station yet (e.g. stops before the train's first scheduled halt)."""
    last_stoppage = None
    for s in stops:
        if s.kind != "intermediate":
            last_stoppage = s
            continue
        if last_stoppage is None:
            continue
        d_cur = _distance_km_value(s.distance_km)
        d_prev = _distance_km_value(last_stoppage.distance_km)
        if d_cur is not None and d_prev is not None:
            s.distance_since_last_stoppage_km = round(d_cur - d_prev, 1)
        s.last_reporting_station = last_stoppage.name


def timeline_to_json(stops) -> list:
    """Plain-dict form of parse_full_timeline()'s output, ready to drop
    straight into a WebSocket JSON payload / JSON response."""
    out = []
    for s in stops:
        out.append({
            "code": s.code, "name": s.name, "kind": s.kind, "status": s.status,
            "lat": s.lat, "lng": s.lng, "coordinates_from": s.coordinates_from,
            "distance_km": s.distance_km, "halt_minutes": s.halt_minutes, "day": s.day,
            "distance_since_last_stoppage_km": s.distance_since_last_stoppage_km,
            "last_reporting_station": s.last_reporting_station,
            "arrival": {
                "scheduled": s.arrival.scheduled, "expected": s.arrival.expected,
                "actual": s.arrival.actual, "delay_minutes": s.arrival.delay_minutes,
            },
            "departure": {
                "scheduled": s.departure.scheduled, "expected": s.departure.expected,
                "actual": s.departure.actual, "delay_minutes": s.departure.delay_minutes,
            },
        })
    return out


def _time_str_to_minutes(t: Optional[str]) -> Optional[int]:
    """Parses a leading 'HH:MM' out of a RailKit time string into minutes-
    since-midnight. Returns None (never a guess) if it doesn't look like a
    clock time."""
    if not t:
        return None
    match = re.match(r"^\s*(\d{1,2}):(\d{2})", str(t))
    if not match:
        return None
    h, m = int(match.group(1)), int(match.group(2))
    if h > 23 or m > 59:
        return None
    return h * 60 + m


def _day_offset(day_val) -> int:
    """RailKit's per-stop `day` field ('day N of the journey', 1-based)
    lets clock times be ordered correctly across a multi-day train run.
    Defaults to day 1 (offset 0) when missing/unparseable."""
    try:
        return max(0, int(str(day_val).strip()) - 1)
    except (TypeError, ValueError):
        return 0


def current_position_distance_km(timeline_json: list) -> Optional[float]:
    """
    Real distance-from-origin (RailKit's own distance_km) of the train's
    current position, from an already-built timeline_to_json() list: the
    stop marked status == "current" if there is one, else the last
    reporting (kind != "intermediate") stop marked "passed" (train is
    running between two halts). Shared by the per-station predictor and
    the instant-speed-per-ping calculation in app.py's /ws/track loop, so
    both anchor to exactly the same real position. Returns None if neither
    is found or that stop has no real distance figure.
    """
    current_entry = next((s for s in timeline_json if s.get("status") == "current"), None)
    if current_entry is None:
        passed = [s for s in timeline_json if s.get("kind") != "intermediate" and s.get("status") == "passed"]
        current_entry = passed[-1] if passed else None
    if current_entry is None:
        return None
    return _distance_km_value(current_entry.get("distance_km"))


def interpolate_live_position(timeline_json: list, segment_progress: Optional[float]):
    """
    FEATURE: smooth position between real station-crossing updates, using
    RailRadar's real `segmentProgress` (see railradar_fallback.get_segment_progress)
    rather than RailKit's own "current station" pointer, which only
    advances when the train actually crosses/departs a physical halt — for
    halts far apart in time, that leaves distance/lat/lng frozen for long
    stretches even though the train is genuinely moving throughout.

    Anchors to the SAME current/last-passed reporting stop as
    current_position_distance_km() (real distance_km) and the next
    upcoming stop after it, then linearly interpolates distance_km and
    lat/lng between those two real, known points by `segment_progress`
    (0.0 = at the anchor stop, 1.0 = at the next stop) — genuine
    arithmetic on two real anchors, same style as
    _interpolate_missing_coordinates / _interpolate_missing_distance_km,
    never extrapolated past either end.

    Returns (distance_km, lat, lng) — any of which may be None if
    segment_progress or either anchor stop's real figures aren't
    available. Never returns a value when segment_progress itself is
    None (nothing to interpolate against).
    """
    if segment_progress is None:
        return None, None, None

    current_entry = next((s for s in timeline_json if s.get("status") == "current"), None)
    if current_entry is None:
        passed = [s for s in timeline_json if s.get("kind") != "intermediate" and s.get("status") == "passed"]
        current_entry = passed[-1] if passed else None
    if current_entry is None:
        return None, None, None

    next_entry = next((s for s in timeline_json if s.get("status") == "upcoming"), None)
    if next_entry is None:
        return None, None, None

    d_cur = _distance_km_value(current_entry.get("distance_km"))
    d_next = _distance_km_value(next_entry.get("distance_km"))
    lat_cur, lng_cur = current_entry.get("lat"), current_entry.get("lng")
    lat_next, lng_next = next_entry.get("lat"), next_entry.get("lng")

    distance_km = None
    if d_cur is not None and d_next is not None:
        distance_km = round(d_cur + segment_progress * (d_next - d_cur), 1)

    lat = lng = None
    if lat_cur is not None and lng_cur is not None and lat_next is not None and lng_next is not None:
        lat = round(lat_cur + segment_progress * (lat_next - lat_cur), 6)
        lng = round(lng_cur + segment_progress * (lng_next - lng_cur), 6)

    return distance_km, lat, lng


def compute_recent_delay_trend(stops, max_points: int = 5, recency_decay: float = 0.6, decay_per_km: float = 0.015):
    """
    FEATURE: real inter-station delay trend, e.g. "20833 crossed VSKP with
    5 min delay, SLO 10 min, RJY 10 min, BZA 15 min -> predict expected
    delay at the next station (KMT)".

    Looks at the last `max_points` REPORTING stations (kind != "intermediate")
    the train has actually passed, in order, and returns:
      - recent_delays: [(station_name, delay_minutes), ...], most-recent last
      - trend_per_stop: the RECENCY-WEIGHTED minute-over-minute change in
        delay between consecutive reporting stations (how fast delay is
        currently growing/shrinking) - None if fewer than 2 real delay
        points are available.
      - basis: a human-readable string of the actual stations/delays used,
        so the prediction can show its work instead of just a number
    Every input here is RailKit's own reported delay at a station the train
    has genuinely already passed - nothing is estimated in this function.

    SECTION-AWARE WEIGHTING (real distance, not just station count): each
    transition's weight used to be pure ordinal decay (`recency_decay^N`
    stations back), which treats two transitions as equally "recent" even
    when one covers 3 real km and the other covers 40 - the 40km one is a
    much older piece of the journey in genuine travel-time terms, so it
    should count for less. When every involved stop carries a real
    distance_km (RailKit's own figure, never estimated), this instead
    decays each transition by the REAL km already covered since it
    happened: weight = recency_decay^(stations_back) * exp(-decay_per_km *
    km_since_that_transition) - a transition that's both several stops AND
    many real km behind now contributes very little, while a transition
    that's a few stops back but geographically close (a cluster of closely
    spaced halts) still counts meaningfully. Falls back to the original
    pure ordinal decay when any involved stop is missing a real distance_km
    (never fabricates a distance), so this is strictly an enhancement, not
    a new failure mode.
    """
    passed_stoppages = [s for s in stops if s.kind != "intermediate" and s.status == "passed"]
    recent = passed_stoppages[-max_points:]

    recent_delays = []
    recent_distances = []  # parallel to recent_delays; None where distance_km isn't real for that stop
    for s in recent:
        d = s.departure.delay_minutes if s.departure.delay_minutes is not None else s.arrival.delay_minutes
        if d is not None:
            recent_delays.append((s.name, d))
            recent_distances.append(_distance_km_value(s.distance_km))

    trend_per_stop = None
    section_aware = False
    if len(recent_delays) >= 2:
        diffs = [recent_delays[i][1] - recent_delays[i - 1][1] for i in range(1, len(recent_delays))]
        n = len(diffs)
        last_km = recent_distances[-1]
        all_real_distances = last_km is not None and all(d is not None for d in recent_distances)
        if all_real_distances:
            # km already covered SINCE each transition (i.e. since the
            # LATER of the two stops in that transition), using the real
            # distance_km already on each stop - no estimation.
            km_since = [max(0.0, last_km - recent_distances[i]) for i in range(1, len(recent_distances))]
            weights = [
                (recency_decay ** (n - 1 - i)) * math.exp(-decay_per_km * km_since[i])
                for i in range(n)
            ]
            section_aware = True
        else:
            weights = [recency_decay ** (n - 1 - i) for i in range(n)]  # most-recent diff -> weight 1.0
        total_w = sum(weights)
        if total_w > 0:
            trend_per_stop = sum(w * d for w, d in zip(weights, diffs)) / total_w

    basis = None
    if recent_delays:
        basis = "crossed " + ", ".join(f"{name} ({d:+d} min)" for name, d in recent_delays)
        if trend_per_stop is not None:
            weighting_note = "distance+recency-weighted" if section_aware else "recency-weighted"
            basis += f" — {weighting_note} trend {trend_per_stop:+.1f} min/stop"

    return {
        "recent_delays": recent_delays, "trend_per_stop": trend_per_stop, "basis": basis,
        "section_aware": section_aware,
    }


def compute_avg_speed_kmph(stops, max_points: Optional[int] = None):
    """
    FEATURE: real average running speed (km/h), computed the way RailYatri
    / NTES actually do it - total real distance covered from the train's
    ORIGIN station to its last reported location (RailKit's own distance_km
    figures), divided by the total real elapsed time since it actually left
    origin (RailKit's own clock-time fields) - a plain cumulative
    (distance delta) / (time delta) calculation on real data, never a
    lookup table or a guess. This intentionally INCLUDES time spent halted
    at intermediate stops, matching the "overall average speed" RailYatri
    displays (as opposed to a halts-excluded "running/schedule speed").

    Uses every REPORTING station the train has actually passed (or is
    currently at) so far, not just a short recent window - a short window
    is what made this silently return None whenever one of the last couple
    of stations happened to be missing a real timestamp, even though
    earlier stations in the same run had everything needed. Pass
    `max_points` to instead average over only the most recent N reporting
    stations (a "current pace" reading rather than the whole-trip average).

    Prefers `actual` times; falls back to `expected` then `scheduled` if a
    station is missing an actual time, and says which tier it used via the
    returned note.

    Returns (speed_kmph: float | None, note: str).
    """
    happened = [s for s in stops if s.kind != "intermediate" and s.status in ("passed", "current")]
    if len(happened) < 2:
        return None, "not enough passed reporting stations with distance/time data yet"

    def _ref(s):
        # The origin only ever has a real DEPARTURE time; the current/last
        # station may only have an ARRIVAL time (train hasn't left yet) -
        # so check both events and use whichever is actually populated.
        for ev in (s.departure, s.arrival):
            for tier, val in (("actual", ev.actual), ("expected", ev.expected), ("scheduled", ev.scheduled)):
                if val:
                    return val, tier
        return None, None

    # Resolve every station that's actually happened so far to
    # (station, distance, minutes, tier), keeping only the ones that have
    # BOTH a real distance_km and a parseable clock time. Skipping ones
    # missing either (rather than requiring the literal first/last entry to
    # have everything) means one incomplete station doesn't blank the whole
    # calculation when earlier/later stations in the same run have what's
    # needed.
    resolved = []
    for s in happened:
        d = _distance_km_value(s.distance_km)
        t_raw, tier = _ref(s)
        t = _time_str_to_minutes(t_raw)
        if d is not None and t is not None:
            resolved.append((s, d, _day_offset(s.day) * 1440 + t, tier))

    if len(resolved) < 2:
        return None, "distance or clock-time data missing for the reporting stations passed so far"

    # Cumulative from origin by default (the RailYatri-style "overall
    # average speed since departure"); max_points restricts to a recent
    # window instead, for callers that want current pace rather than the
    # whole-trip figure.
    window = resolved[-max_points:] if max_points else resolved
    if len(window) < 2:
        window = resolved

    first, d1, t1, tier1 = window[0]
    last, d2, t2, tier2 = window[-1]

    minutes_elapsed = t2 - t1
    dist_covered = d2 - d1
    if minutes_elapsed <= 0 or dist_covered <= 0:
        return None, "elapsed time/distance since departure was non-positive"

    speed = round(dist_covered / (minutes_elapsed / 60.0), 1)
    tier_note = "real recorded (actual) timings" if tier1 == "actual" and tier2 == "actual" else "scheduled/expected timings (not live-actual)"
    span = "since departure" if not max_points else "recent"
    return speed, f"{first.name} \u2192 {last.name} ({span}): {dist_covered:.0f} km in {minutes_elapsed} min, using {tier_note}"


def compute_instant_speed_kmph(
    prev_distance_km: Optional[float], prev_timestamp: Optional[datetime],
    curr_distance_km: Optional[float], curr_timestamp: Optional[datetime],
    max_plausible_kmph: float = 200.0,
):
    """
    FEATURE: instant speed per GPS ping - the single biggest accuracy fix
    over the old halt-to-halt average. compute_avg_speed_kmph only moves
    when the train crosses a scheduled halt (it only looks at
    kind != "intermediate" stops), so between two halts it stays frozen
    even while the train genuinely speeds up or slows down section to
    section. This instead reacts on EVERY poll (~5s, see
    _TRACK_POLL_INTERVAL_SECONDS in app.py): real km covered between the
    immediately preceding poll and this one, divided by the real
    wall-clock seconds between those two polls - both real provider
    figures (RailKit reports a distance_km / distance_since_last_stoppage_km
    for intermediate GPS points too, not just halts), never a guess.

    Returns None (never inventing a reading) when:
      - there's no previous sample yet (first ping of this session, or the
        connection just reconnected)
      - the distance figure didn't actually change (train genuinely halted,
        or the provider hasn't refreshed its GPS fix since the last poll)
      - the implied speed exceeds max_plausible_kmph - a provider/GPS
        glitch (e.g. a station-code jump) would otherwise show as a
        nonsense instant reading; discarded rather than displayed.
    """
    if prev_distance_km is None or prev_timestamp is None or curr_distance_km is None or curr_timestamp is None:
        return None
    dt_seconds = (curr_timestamp - prev_timestamp).total_seconds()
    if dt_seconds <= 0:
        return None
    dist_delta = curr_distance_km - prev_distance_km
    if dist_delta <= 0:
        return None
    speed = dist_delta / (dt_seconds / 3600.0)
    if speed > max_plausible_kmph:
        return None
    return round(speed, 1)


class RecencyWeightedValue:
    """
    FEATURE: smooths any per-poll numeric reading that can jitter between
    polls (GPS/provider noise, a slightly stale distance figure, etc.) into
    a stable trend, WITHOUT lagging behind a real, sustained change the way
    a long cumulative average would. Each sample is weighted by exponential
    decay on its real wall-clock age (`halflife_seconds`), so a genuine
    change shows up within a couple of polls while a single noisy outlier
    gets diluted rather than taken at face value.

    Originally built for smoothing live speed readings (see current-speed
    usage in app.py) - generalized to also smooth the headline predicted-
    delay figure, after a report that it swung 7/10/12/14/15/16/5/6 minutes
    poll to poll (an out-of-sequence, jumpy read) even though the
    underlying confidence interval kept correctly bracketing the real
    delay the whole time. Same fix, same reason: display the trend, not
    every noisy individual reading.

    Deliberately lives for the lifetime of one /ws/track connection only
    (kept as a local in app.py's polling loop) - not persisted across
    reconnects, since a fresh connection has no real prior samples to
    weight against.
    """

    def __init__(self, halflife_seconds: float = 45.0, max_samples: int = 12):
        self.halflife_seconds = halflife_seconds
        self.max_samples = max_samples
        self._samples: list = []  # [(value, timestamp), ...]

    def add(self, value: Optional[float], timestamp: datetime) -> None:
        if value is None:
            return
        self._samples.append((value, timestamp))
        if len(self._samples) > self.max_samples:
            self._samples.pop(0)

    def value(self) -> Optional[float]:
        if not self._samples:
            return None
        latest_t = self._samples[-1][1]
        total_w = 0.0
        total_wv = 0.0
        for val, t in self._samples:
            age = (latest_t - t).total_seconds()
            w = 0.5 ** (age / self.halflife_seconds) if self.halflife_seconds > 0 else 1.0
            total_w += w
            total_wv += w * val
        return round(total_wv / total_w, 1) if total_w > 0 else None

    def sample_count(self) -> int:
        return len(self._samples)

    def coefficient_of_variation(self, min_samples: int = 4) -> Optional[float]:
        """
        FEATURE: this train's OWN real measured speed variability this run,
        as a fraction of its mean (stddev / mean) - e.g. 0.08 means this
        train's actual recent speed readings have varied about +/-8% around
        their average. Used by app.py's lock-confidence formula in place of
        the fixed assumed 12% (_LOCK_SPEED_VARIABILITY_CV) whenever there
        are enough real samples to trust: a train that's been running very
        steadily should get a MORE confident (tighter) lock than one whose
        speed has been jumping around, and the fixed 12% treated every
        train identically regardless of how it's actually been running.

        Returns None (never fabricating a number) when fewer than
        `min_samples` real readings have been collected yet this
        connection, or when the mean is non-positive - callers must fall
        back to the documented fixed assumption in that case, same as
        every other "not enough real data yet" case in this app.
        """
        if len(self._samples) < min_samples:
            return None
        values = [v for v, _t in self._samples]
        mean = sum(values) / len(values)
        if mean <= 0:
            return None
        variance = sum((v - mean) ** 2 for v in values) / len(values)
        stddev = variance ** 0.5
        return round(stddev / mean, 4)


class DirectionAwareSmoother:
    """
    FEATURE: same goal as RecencyWeightedValue (a stable trend, not a jumpy
    per-poll reading) but with a deliberate asymmetry, for values where
    "going down" and "going up" mean genuinely different things - the
    headline predicted-delay figure being the motivating case. A train
    genuinely RECOVERING time (delay shrinking) should show up fast, so
    the passenger isn't stuck looking at a stale, too-high number for
    minutes after the train has actually sped up. A single noisy poll
    reading HIGHER, or a real but gradual worsening trend, shouldn't yank
    the displayed number around - that's exactly the random-looking
    7/10/12/14/15/16/5/6 jumpiness RecencyWeightedValue was already built
    to fix. So: fast reaction (short halflife) when the new raw reading is
    BELOW the current smoothed value (recovering); slow, damped reaction
    (long halflife) otherwise (rising or flat/noisy).

    This is a running exponential smoother (recomputed incrementally on
    each `add()`, not a batch recompute over stored samples like
    RecencyWeightedValue) since the asymmetric choice has to be made fresh
    for every single new reading based on which direction THIS reading
    moved relative to the current trend, not a fixed weighting scheme.

    Deliberately lives for the lifetime of one /ws/track connection only,
    same as RecencyWeightedValue - a fresh connection has no real prior
    trend to compare a new reading against.
    """

    def __init__(self, halflife_down_seconds: float = 30.0, halflife_up_seconds: float = 90.0):
        self.halflife_down_seconds = halflife_down_seconds
        self.halflife_up_seconds = halflife_up_seconds
        self._smoothed: Optional[float] = None
        self._last_timestamp: Optional[datetime] = None

    def add(self, value: Optional[float], timestamp: datetime) -> None:
        if value is None:
            return
        if self._smoothed is None or self._last_timestamp is None:
            self._smoothed = float(value)
            self._last_timestamp = timestamp
            return
        dt = (timestamp - self._last_timestamp).total_seconds()
        if dt <= 0:
            return  # out-of-order or duplicate poll - ignore rather than corrupt the trend
        # The direction call: is THIS reading pulling the trend down
        # (recovering) or not (rising/flat/noisy)?
        halflife = self.halflife_down_seconds if value < self._smoothed else self.halflife_up_seconds
        alpha = (1.0 - 0.5 ** (dt / halflife)) if halflife > 0 else 1.0
        self._smoothed = self._smoothed + alpha * (value - self._smoothed)
        self._last_timestamp = timestamp

    def value(self) -> Optional[float]:
        return round(self._smoothed, 1) if self._smoothed is not None else None


# Backward-compat alias - existing code (e.g. app.py's live-speed tracker)
# still refers to this by its original, speed-specific name.
RecencyWeightedSpeed = RecencyWeightedValue


def compute_live_eta(distance_ahead_km: Optional[float], effective_speed_kmph: Optional[float],
                      now: Optional[datetime] = None):
    """
    FEATURE: ETA recalculated every GPS ping, not just every halt. RailKit's
    own `expected` timing field for a station is only refreshed by the
    provider when the train actually crosses a reporting halt, so between
    two halts it can sit stale for minutes even as the train's real pace
    changes. This instead recomputes locally on every poll: real remaining
    distance to that station (RailKit's own distance_km figures) divided by
    the freshest real speed reading available (recency-weighted instant
    speed preferred, average speed as fallback - see app.py's
    `_effective_speed_for_eta`), added to the current wall-clock time.

    Returns an "HH:MM" string, or None if either input is missing/invalid -
    never a guessed time.
    """
    if distance_ahead_km is None or not effective_speed_kmph or effective_speed_kmph <= 0:
        return None
    now = now or datetime.now()
    minutes = distance_ahead_km / effective_speed_kmph * 60.0
    eta = now + timedelta(minutes=minutes)
    return eta.strftime("%H:%M")


def compute_avg_speed_multi_source(railkit_stops, railradar_stops=None, live_speed_kmph=None,
                                    live_speed_note=None, max_points: Optional[int] = None):
    """
    FEATURE: combines BOTH real providers (RailKit AND RailRadar) for the
    average-speed figure, instead of only reaching for RailRadar when
    RailKit returns nothing (the old fallback-only behaviour). For any
    given train:

      1. Computes the real cumulative distance/time speed from RailKit's
         own timeline (compute_avg_speed_kmph).
      2. Computes the SAME real calculation independently from RailRadar's
         own timeline, when RailRadar data was supplied.
      3. If both providers produced a real number, averages them (each is
         genuine provider data, computed the identical honest way - this
         is not inventing a number, it's using two independent real
         measurements of the same thing).
      4. If only one provider had enough data, uses that one.
      5. If NEITHER provider has enough distance/time data yet (e.g. the
         train only just left origin and hasn't passed a second reporting
         station), falls back to RailRadar's own live instantaneous GPS
         speed reading (`live_speed_kmph`, from get_live_speed_kmph) if
         supplied - a genuine real-time measurement, not a calculation.
      6. Only if nothing real is available at all does this return None -
         callers should treat that as the trigger for an ML instant
         estimate (see delay_prediction / app.py), not display a dash.

    Returns (speed_kmph: float | None, note: str, source: str) where
    `source` is one of "railkit+railradar_avg", "railkit", "railradar",
    "railradar_live_gps", or "none".
    """
    rk_speed, rk_note = compute_avg_speed_kmph(railkit_stops, max_points=max_points) if railkit_stops else (None, None)
    rr_speed, rr_note = compute_avg_speed_kmph(railradar_stops, max_points=max_points) if railradar_stops else (None, None)

    if rk_speed is not None and rr_speed is not None:
        merged = round((rk_speed + rr_speed) / 2.0, 1)
        note = f"RailKit: {rk_note}  |  RailRadar: {rr_note}  |  averaged: {merged} km/h"
        return merged, note, "railkit+railradar_avg"
    if rk_speed is not None:
        return rk_speed, f"[RailKit] {rk_note}", "railkit"
    if rr_speed is not None:
        return rr_speed, f"[RailRadar] {rr_note}", "railradar"
    if live_speed_kmph is not None:
        return live_speed_kmph, f"[RailRadar] {live_speed_note or 'live GPS speed reading'}", "railradar_live_gps"
    return None, "no real distance/time data or live GPS speed available from either provider yet", "none"


def group_timeline_for_display(timeline_json: list) -> list:
    """
    RailYatri-style display grouping for the Live Tracking timeline.

    Consecutive non-reporting (`kind == "intermediate"`) small stations
    between two reporting halts are collapsed into a single
    "+N No-Halt stations" summary entry instead of one row each, carrying
    the real distance span across that run (plain arithmetic on RailKit's
    own `distance_since_last_stoppage_km` figures — see
    `_annotate_distance_since_last_stoppage`, never invented). Reporting
    (`kind != "intermediate"`) stations pass through unchanged, one entry
    each, in original order — this is where per-station
    `predicted_delay_minutes` (see app.py's `_predict_delay_per_reporting_station`)
    and RailKit's own real `arrival.delay_minutes` for already-passed halts
    live.

    Returns a list of dict entries of two shapes:
      {"display_type": "station", ...all fields from the station dict...}
      {"display_type": "no_halt_group", "count": N, "distance_km": <float|None>,
       "from_station": <name|None>, "to_station": <name|None>,
       "stations": [{"code","name","status","distance_since_last_stoppage_km",
       "distance_km","predicted_delay_minutes","predicted_delay_confidence",
       "predicted_eta","distance_ahead_km"}, ...]}

    BUGFIX ("707.2 km covered so far ... not a real cumulative distance
    from origin" — reported on train 20833's Eluru row, inside an expanded
    "+N No-Halt stations" group): each sub-station here only ever carried
    `distance_since_last_stoppage_km` — a genuine, real figure, but
    deliberately scoped to "since the last HALTING station", not "since
    origin" (see `_annotate_distance_since_last_stoppage`'s own docstring).
    The mobile app's expanded-group row rendered that number under a bare
    "km" label with nothing distinguishing it from every OTHER "km" figure
    on the same screen (the reporting-station rows above/below it, and the
    live-position callout's own "X km covered so far", which both use the
    real cumulative `distance_km` instead) — so a small, correct, locally-
    scoped number (e.g. 90 km since the last halt) sat right next to a
    much larger, ALSO correct, cumulative one (e.g. 720.9 km since origin)
    with no way to tell they answer different questions. Each sub-station's
    own real cumulative `distance_km` (already computed for every stop by
    parse_full_timeline/_interpolate_missing_distance_km — just never
    carried through this grouping step before) is now included too, so the
    frontend can label both real numbers plainly instead of only ever
    showing the smaller, easily-misread one.
    """
    out = []
    pending = []

    def _flush():
        if not pending:
            return
        first_d = pending[0].get("distance_since_last_stoppage_km")
        last_d = pending[-1].get("distance_since_last_stoppage_km")
        span_km = round(abs(last_d - first_d), 1) if (first_d is not None and last_d is not None) else None
        out.append({
            "display_type": "no_halt_group",
            "count": len(pending),
            "distance_km": span_km,
            "from_station": pending[0].get("last_reporting_station"),
            "to_station": None,  # filled in below, once the next stoppage is known
            "stations": [
                {"code": p["code"], "name": p["name"],
                 # BUGFIX: this station's own real passed/current/upcoming
                 # status (already computed above in timeline_to_json — was
                 # being silently dropped here, which left the mobile app's
                 # expanded "+N No-Halt stations" rail with no way to color
                 # an already-passed non-reporting station green like every
                 # other passed stop, since it never got told which ones
                 # were passed.
                 "status": p.get("status"),
                 "distance_since_last_stoppage_km": p.get("distance_since_last_stoppage_km"),
                 # BUGFIX (see this function's own docstring): the real
                 # cumulative-from-origin figure, same field/meaning as
                 # every reporting station's own "distance_km" elsewhere on
                 # this same screen — was missing here before, leaving the
                 # frontend with only the smaller "since last halt" number
                 # to show for every non-reporting station.
                 "distance_km": p.get("distance_km"),
                 # FEATURE: per-station predicted delay/ETA/distance now
                 # computed for non-reporting points too (see app.py's
                 # _predict_delay_per_reporting_station) — carried through
                 # here so the collapsed "+N No-Halt stations" popup can
                 # show each one's own figures instead of only the span.
                 "predicted_delay_minutes": p.get("predicted_delay_minutes"),
                 "predicted_delay_confidence": p.get("predicted_delay_confidence"),
                 "predicted_delay_low_minutes": p.get("predicted_delay_low_minutes"),
                 "predicted_delay_high_minutes": p.get("predicted_delay_high_minutes"),
                 "predicted_eta": p.get("predicted_eta"),
                 "distance_ahead_km": p.get("distance_ahead_km")}
                for p in pending
            ],
        })
        pending.clear()

    for s in timeline_json:
        if s.get("kind") == "intermediate":
            pending.append(s)
        else:
            _flush()
            out.append({"display_type": "station", **s})
    _flush()

    for i, entry in enumerate(out):
        if entry.get("display_type") == "no_halt_group":
            nxt = next((e for e in out[i + 1:] if e.get("display_type") == "station"), None)
            entry["to_station"] = nxt.get("name") if nxt else None
    return out


def determine_train_direction(train_number: str) -> dict:
    """
    FEATURE: auto-detect UP/DOWN running direction from the train number,
    e.g. 20833 -> UP, 20834 -> DOWN, for rotating the map marker to face
    the direction of travel.

    Uses the widely-followed Indian Railways numbering convention where,
    for a given UP/DOWN pair on the same route, the odd-numbered train runs
    UP and the even-numbered train runs DOWN (e.g. 20833 UP / 20834 DOWN).
    HONEST NOTE (same rule as the rest of this project): this is a common
    *convention*, not a rule guaranteed by any public API - a handful of
    trains/zones deviate from it. Treated as a labelled best-effort
    classification, never presented as verified fact.
    """
    digits = re.sub(r"\D", "", str(train_number or ""))
    if not digits:
        return {"direction": "UNKNOWN", "basis": "train number not numeric — direction undetermined"}
    is_up = int(digits[-1]) % 2 == 1
    direction = "UP" if is_up else "DOWN"
    basis = (
        f"train number {digits} ends in an {'odd' if is_up else 'even'} digit — by the common "
        f"Indian Railways UP(odd)/DOWN(even) numbering convention, classified as {direction}"
    )
    return {"direction": direction, "basis": basis}


def _distance_km_value(v) -> Optional[float]:
    if v is None:
        return None
    match = re.search(r"[\d.]+", str(v))
    return float(match.group(0)) if match else None


def _interpolate_missing_coordinates(stops) -> None:
    """Fills in lat/lng (in place) for any stop RailKit gave neither a real
    coordinate nor a static-table match for, by interpolating along the
    ACTUAL route line between the nearest earlier and later stop that DO
    have a real coordinate - weighted by distance-from-source when RailKit
    reports it for all three points, otherwise by position in the stop
    list. This is a genuine geometric estimate anchored to two real
    coordinates on the train's real route, not a guess - and it's labelled
    "interpolated" (never "provider") so callers can always tell the
    difference.

    BUGFIX ("Coordinates: —, Position source: unavailable" reported for
    train 20833 while genuinely at a small station, "Intekanne", not in
    our ~8,700-entry static table): a stop with NO known-coordinate
    anchor on one side - before the first, or after the last, station in
    THIS SPECIFIC response that resolved a coordinate - used to be left
    entirely unavailable rather than extrapolated, since there's no real
    route line to interpolate along without both ends. That's the right
    call when it's a genuine geometric extrapolation (no anchor at all on
    one side), but it meant the small handful of intermediate stations
    RailKit's timeline sometimes returns right at the very edge of what
    it also gives coordinates for - most often the CURRENT station, the
    one that matters most - went completely blank instead of getting the
    single closest real station's own real coordinate, which is still a
    far better position than nothing for a small station that's at most
    a few km from it. Labelled "nearest_known_station" (mapped to
    position_source "estimated_from_nearest_station" below) so it's never
    confused with the more precise two-sided interpolation above.
    """
    known_idx = [i for i, s in enumerate(stops) if s.lat is not None]
    if not known_idx:
        return
    known_set = set(known_idx)
    for i, s in enumerate(stops):
        if s.lat is not None:
            continue
        earlier = [j for j in known_idx if j < i]
        later = [j for j in known_idx if j > i]
        if earlier and later:
            prev_i, next_i = earlier[-1], later[0]
            prev_s, next_s = stops[prev_i], stops[next_i]

            d_prev = _distance_km_value(prev_s.distance_km)
            d_cur = _distance_km_value(s.distance_km)
            d_next = _distance_km_value(next_s.distance_km)
            if d_prev is not None and d_cur is not None and d_next is not None and d_next != d_prev:
                frac = (d_cur - d_prev) / (d_next - d_prev)
            else:
                span = next_i - prev_i
                frac = (i - prev_i) / span if span else 0.5
            frac = max(0.0, min(1.0, frac))

            s.lat = prev_s.lat + (next_s.lat - prev_s.lat) * frac
            s.lng = prev_s.lng + (next_s.lng - prev_s.lng) * frac
            s.coordinates_from = "interpolated"
        elif earlier or later:
            nearest_s = stops[earlier[-1] if earlier else later[0]]
            s.lat, s.lng = nearest_s.lat, nearest_s.lng
            s.coordinates_from = "nearest_known_station"


def offline_station_pair_map(source_code: Optional[str], dest_code: Optional[str]) -> Optional[dict]:
    """
    For trains-between / seat-availability questions, a source/destination
    preview map doesn't need a live API call - the two station locations
    come from our own static station_coordinates.json, so a map still
    renders even during a provider outage. Clearly a straight-line preview,
    never confused with a real route or live position.
    """
    source = _lookup_station(source_code)
    dest = _lookup_station(dest_code)
    if not source and not dest:
        return None
    return {
        "type": "station_pair",
        "source": {"code": source_code, "name": source["name"] if source else None,
                    "lat": source["lat"] if source else None, "lng": source["lng"] if source else None},
        "dest": {"code": dest_code, "name": dest["name"] if dest else None,
                  "lat": dest["lat"] if dest else None, "lng": dest["lng"] if dest else None},
    }