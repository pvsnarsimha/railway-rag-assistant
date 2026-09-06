"""
trains_between.py
--------------------
Turns the raw "trains between two stations" provider response into a clean,
groundable list of trains - and, when the user gave a time ("at 3pm which
trains..."), filters/sorts that list by closeness to the requested time.

Same honesty rule as the rest of this project: this module only ever
reshapes data that actually came back from railway_api.py. If the provider
call failed (bad key, quota exhausted, etc.) there is no list to build -
callers see an empty list and the caller (app.py) is responsible for saying
so plainly, never inventing train names/times to fill the gap.
"""

import re

from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional

from deep_extract import deep_find_list_of_dicts, top_level_keys


def _first_present(d: dict, keys, default=None):
    """Field names on RapidAPI listings vary/change over time - try several
    plausible spellings instead of hardcoding one (see the same pattern in
    gps_tracking.py and the note in railway_api.py about this)."""
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d[k]
    return default


def _normalize_hhmm(raw) -> Optional[str]:
    """Normalizes a provider's raw departure/arrival time value into a
    consistent 24h "HH:MM" string, for both display and for _to_minutes()
    below to filter on. This is the actual root cause of departure/arrival
    time filtering silently failing: RapidAPI's IRCTC1 listing's real
    from_time/to_time fields commonly come back as bare digit strings with
    NO colon at all - e.g. "0555" or "1310" for 05:55/13:10 - which the
    old colon-only check in _to_minutes() couldn't parse at all, so every
    train silently got treated as having an unknown time and got dropped
    from every departure/arrival band match (falling back to showing the
    whole unfiltered list, which is what looked like "wrong data").
    Handles, in order:
      - "HH:MM" / "HH:MM:SS" (already correct, passed through)
      - "H:MM AM/PM" / "HH:MM AM/PM" (12-hour, seen on some IRCTC-family listings)
      - bare 3-4 digit "HMM"/"HHMM" with no separator (RapidAPI's real shape)
    Returns None (never a guess) if the value doesn't match any of these.
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    m = re.match(r"^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$", text)
    if m:
        h, mi, ap = int(m.group(1)), int(m.group(2)), m.group(3)
        if ap:
            ap = ap.upper()
            if ap == "PM" and h != 12:
                h += 12
            elif ap == "AM" and h == 12:
                h = 0
        return f"{h:02d}:{mi:02d}" if 0 <= h <= 23 and 0 <= mi <= 59 else None
    if re.fullmatch(r"\d{3,4}", text):
        text4 = text.zfill(4)
        h, mi = int(text4[:2]), int(text4[2:])
        return f"{h:02d}:{mi:02d}" if 0 <= h <= 23 and 0 <= mi <= 59 else None
    return None


@dataclass
class TrainSummary:
    train_number: str
    train_name: str
    source_departure: Optional[str]  # "HH:MM", 24-hour, if the provider gave one
    dest_arrival: Optional[str]
    duration: Optional[str]
    classes: List[str]
    running_days_raw: Optional[object] = None  # whatever shape the provider gave, if any - kept raw so filter_by_running_date can interpret it
    minutes_from_requested_time: Optional[int] = None  # filled in only if a time was requested


def _to_minutes(hhmm: Optional[str]) -> Optional[int]:
    if not hhmm or ":" not in str(hhmm):
        return None
    try:
        h, m = str(hhmm).split(":")[:2]
        return int(h) * 60 + int(m)
    except (ValueError, TypeError):
        return None


def _extract_normalized_rows(data: dict) -> List[dict]:
    """Shared row-extraction step used by both parse_trains_list() and the
    raw_row_sample() diagnostic below - single source of truth so the two
    never drift out of sync with each other."""
    payload = data.get("data", data) if isinstance(data, dict) else {}

    rows = payload if isinstance(payload, list) else None
    if rows is None:
        for key in ("trains", "train_list", "results"):
            if isinstance(payload, dict) and isinstance(payload.get(key), list):
                rows = payload[key]
                break
    if rows is None:
        rows = []

    deep_rows = deep_find_list_of_dicts(
        data, ["trains", "trainList", "train_list", "results", "trainDetails",
               "trainDetailsList", "data", "list", "records", "trainsBetweenStations"],
    )
    if len(deep_rows) > len(rows):
        rows = deep_rows

    normalized_rows = []
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get("train_base"), dict):
            merged = dict(row["train_base"])
            if row.get("avl_classes") is not None:
                merged["classes"] = row["avl_classes"]
            normalized_rows.append(merged)
        else:
            normalized_rows.append(row)
    return normalized_rows


def raw_row_sample(data: dict, train_number: Optional[str] = None) -> Optional[dict]:
    """DIAGNOSTIC ONLY - never used for actual parsing/filtering. Returns
    the real, un-normalized train row (after the same train_base/
    avl_classes unwrap parse_trains_list does) so a "departure/arrival
    didn't parse" report can be answered from REAL evidence - the exact
    key names and values RapidAPI actually sent back - instead of another
    blind guess at field names.

    If train_number is given, returns THAT specific train's raw row
    (falling back to the first row if no match) - important because when
    only SOME trains on a page are missing times, row[0] might happen to
    be one that parsed fine, which would hide the real broken shape.
    Always pass the train_number of a train that's actually missing times
    when you have one. Returns None if there's no row to sample at all.
    """
    rows = _extract_normalized_rows(data)
    if not rows or not isinstance(rows[0], dict):
        return None
    row = rows[0]
    if train_number:
        for candidate in rows:
            if not isinstance(candidate, dict):
                continue
            num = _first_present(candidate, ["train_no", "train_number", "trainNumber", "number"])
            if num is not None and str(num) == str(train_number):
                row = candidate
                break
    time_like = {
        k: row[k] for k in row
        if "time" in k.lower() or k.lower() in ("std", "sta", "dep", "arr", "departure", "arrival", "from", "to")
    }
    day_like = {
        k: row[k] for k in row
        if "day" in k.lower() or "run" in k.lower()
    }
    return {"all_keys": list(row.keys()), "time_like_fields": time_like, "day_like_fields": day_like}


def parse_trains_list(data: dict) -> List[TrainSummary]:
    """Parses an already-fetched railway_api.search_trains_between_stations()
    (RailKit searchTrainBetweenStations) response, shape:
    { success, data: [ { train_no, train_name, from_stn_code, from_stn_name,
    to_stn_code, to_stn_name, from_time, to_time, travel_time, running_days,
    distance, halts }, ... ] }
    Returns [] (not an error) if the shape is unrecognised or the list is
    genuinely empty - app.py decides how to phrase that to the user."""
    rows = _extract_normalized_rows(data)

    trains = []
    for row in rows:
        number = _first_present(row, ["train_no", "train_number", "trainNumber", "number"])
        name = _first_present(row, ["train_name", "trainName", "name"], default=number)
        # from_std/to_sta are RapidAPI IRCTC1's REAL field names, confirmed via
        # raw_row_sample() diagnostic evidence (Round 31) - "from"/"to" on this
        # same row are station CODES (e.g. "SC"), not times, and must never be
        # matched here. from_std = scheduled departure at the origin station;
        # to_sta = scheduled arrival at the destination station. Older guesses
        # kept after them as fallback for other provider shapes only.
        departure = _normalize_hhmm(_first_present(row, ["from_std", "from_time", "departure_time", "departureTime", "source_departure", "std", "dep_time", "departure"]))
        arrival = _normalize_hhmm(_first_present(row, ["to_sta", "to_time", "arrival_time", "arrivalTime", "dest_arrival", "sta", "arr_time", "arrival"]))
        duration = _first_present(row, ["travel_time", "duration", "travelTime"])
        classes = _first_present(row, ["classes", "class_type", "classType"], default=[])
        if isinstance(classes, str):
            classes = [c.strip() for c in classes.split(",") if c.strip()]
        running_days_raw = _first_present(row, ["run_days", "running_days", "runningDays", "running_day", "days"])

        if not number:
            continue  # can't ground a train with no number - skip rather than guess one

        trains.append(TrainSummary(
            train_number=str(number), train_name=name or str(number),
            source_departure=departure, dest_arrival=arrival,
            duration=duration, classes=classes or [], running_days_raw=running_days_raw,
        ))
    return trains


def filter_and_sort_by_time(trains: List[TrainSummary], target_hhmm: str,
                             window_minutes: int = 180) -> List[TrainSummary]:
    """
    Sorts trains by closeness of departure time to target_hhmm ("HH:MM", 24h).
    Trains with no known departure time are kept at the end (never dropped -
    we don't know they DON'T match, we just can't rank them).
    `window_minutes` only affects labelling (minutes_from_requested_time),
    not filtering - we never hide a real train just because it's outside the
    window, since "at 3pm" usually means "closest to 3pm", not "exactly 3pm".
    """
    target = _to_minutes(target_hhmm)
    if target is None:
        return trains

    with_time, without_time = [], []
    for t in trains:
        mins = _to_minutes(t.source_departure)
        if mins is None:
            without_time.append(t)
            continue
        diff = min(abs(mins - target), 1440 - abs(mins - target))  # wrap midnight
        t.minutes_from_requested_time = diff
        with_time.append(t)

    with_time.sort(key=lambda t: t.minutes_from_requested_time)
    return with_time + without_time


def filter_by_time_range(trains: List[TrainSummary], start_hhmm: str, end_hhmm: str) -> List[TrainSummary]:
    """
    Keeps only trains whose departure falls inside [start_hhmm, end_hhmm]
    (both "HH:MM", 24h) - for phrasing like "5:30 p.m to 8:20 p.m", where
    the user wants an actual window, not just "closest to one time" like
    filter_and_sort_by_time above. Handles a window that crosses midnight
    (e.g. 23:00-01:00). Trains with no known departure time are dropped
    here (unlike the closest-match filter) since "in this window" is a
    real inclusion test, not a ranking - we can't say a train IS in an
    unknown-time window.
    """
    start = _to_minutes(start_hhmm)
    end = _to_minutes(end_hhmm)
    if start is None or end is None:
        return trains

    def in_window(mins: int) -> bool:
        if start <= end:
            return start <= mins <= end
        return mins >= start or mins <= end  # wraps past midnight

    matched = []
    for t in trains:
        mins = _to_minutes(t.source_departure)
        if mins is None:
            continue
        if in_window(mins):
            t.minutes_from_requested_time = min(abs(mins - start), abs(mins - end))
            matched.append(t)

    matched.sort(key=lambda t: _to_minutes(t.source_departure) or 0)
    return matched


def filter_by_class(trains: List[TrainSummary], travel_class: str):
    """Keeps only trains confirmed (by the provider's own class list) to
    run the requested class - like IRCTC's class filter. Same never-drop-
    to-a-dead-end philosophy as filter_by_departure_and_arrival: if that
    strict match comes back empty (e.g. the provider's class data is
    incomplete for this route, not necessarily that the class doesn't
    run), this falls back to returning every train on the route rather
    than "no trains" - the caller gets told via is_exact_match so it can
    show an honest note instead of silently pretending the filter worked.

    Returns (trains, is_exact_match).
    """
    travel_class = (travel_class or "").strip().upper()
    if not travel_class:
        return trains, True
    matched = [t for t in trains if any(c.strip().upper() == travel_class for c in (t.classes or []))]
    if matched:
        return matched, True
    return trains, False


def _parse_running_days(raw) -> Optional[set]:
    """Interprets whatever shape the provider gave for a train's weekly
    running schedule into a set of weekday indices (0=Mon..6=Sun) it
    genuinely runs on. Handles the common shapes this kind of provider
    field comes in without guessing a single fixed format:
      - a 7-char string of 0/1 or Y/N, Mon-first (e.g. "1111100")
      - a list of day abbreviations/names (e.g. ["Mon","Wed","Fri"])
      - a dict keyed by day name/abbreviation with truthy values
    Returns None (unknown/unparseable) rather than guessing - callers
    must never drop a train just because its running-day shape wasn't
    recognised, only because it was recognised AND says "no" for that day.
    """
    if raw is None:
        return None
    day_names = {
        "mon": 0, "monday": 0, "tue": 1, "tues": 1, "tuesday": 1,
        "wed": 2, "wednesday": 2, "thu": 3, "thur": 3, "thurs": 3, "thursday": 3,
        "fri": 4, "friday": 4, "sat": 5, "saturday": 5, "sun": 6, "sunday": 6,
    }
    if isinstance(raw, str) and len(raw) == 7 and all(c in "01YyNn" for c in raw):
        return {i for i, c in enumerate(raw) if c in "1Yy"}
    if isinstance(raw, (list, tuple)):
        days = set()
        for item in raw:
            key = str(item).strip().lower()
            if key in day_names:
                days.add(day_names[key])
        return days if days else None
    if isinstance(raw, dict):
        days = set()
        for key, val in raw.items():
            k = str(key).strip().lower()
            if k in day_names and val:
                days.add(day_names[k])
        return days if days else None
    return None


def filter_by_running_date(trains: List[TrainSummary], date_ddmmyyyy: Optional[str]):
    """When a specific date is given, RailKit's searchTrainBetweenStations
    is date-independent (the whole week's timetable, not just what runs
    on that day - see the module docstring), so it can include trains
    that genuinely don't run on the requested date's weekday even though
    IRCTC's own date-specific search excludes them. This narrows to
    trains whose parsed running_days confirms they run on that weekday.

    Same never-drop-to-a-dead-end / never-guess philosophy as the rest of
    this module: a train is only excluded when its running-days field was
    actually parsed AND explicitly says it doesn't run that weekday: a
    train with a missing or unrecognised running-days shape is always
    kept, since we can't confirm it's excluded. If literally every train
    ends up excluded (unlikely, but possible with unusual data), falls
    back to the unfiltered list rather than returning nothing.

    IMPORTANT: "is_exact_match == True" here does NOT by itself mean the
    filter did anything - if the provider's running-days field was never
    found/parsed for ANY train, every train falls into the "keep, can't
    confirm" branch and matched == trains regardless of whether the date
    genuinely excludes anyone. `parsed_count` (out of `total`) tells the
    caller how many trains actually had a recognised running-days value
    to filter on, so a real no-op can be told apart from "everything
    genuinely runs this weekday".

    Returns (trains, is_exact_match, parsed_count, total).
    """
    if not date_ddmmyyyy:
        return trains, True, 0, len(trains)
    try:
        weekday = datetime.strptime(date_ddmmyyyy, "%d-%m-%Y").weekday()  # 0=Mon..6=Sun
    except (ValueError, TypeError):
        return trains, True, 0, len(trains)  # unparseable date - can't filter, don't guess

    matched = []
    parsed_count = 0
    for t in trains:
        days = _parse_running_days(t.running_days_raw)
        if days is not None:
            parsed_count += 1
        if days is None or weekday in days:
            matched.append(t)

    if matched:
        return matched, len(matched) == len(trains), parsed_count, len(trains)
    return trains, False, parsed_count, len(trains)


def filter_by_time_bands(trains: List[TrainSummary], departure_start: Optional[str] = None, departure_end: Optional[str] = None,
                          arrival_start: Optional[str] = None, arrival_end: Optional[str] = None, point_tolerance_minutes: int = 60):
    """IRCTC-style departure/arrival time-band filter. Each of departure/
    arrival can be given as:
      - a real band (start != end, e.g. "00:00".."06:00" for the quick
        00-06/06-12/12-18/18-00 buttons, or any custom "from".."to" range)
      - a single point in time (start == end, e.g. a custom "8:45 PM" or
        "20:45" entry with no range) - treated as +/- point_tolerance_minutes
        around that time, same as the old point-filter behaviour
    Both start and end are "HH:MM" 24h. A band that wraps past midnight
    (e.g. 18:00..00:00, or a custom 23:00..02:00) is handled correctly.

    Tries a REAL filter first: keep only trains whose real departure/
    arrival falls in every given band. If that comes back empty (the
    user's departure and arrival bands don't correspond to any single
    train's real journey length - a real possibility when the two are
    picked independently), falls back to the same never-drop philosophy
    used elsewhere in this module: return every train instead of a dead
    end, sorted by departure time.

    Returns (trains, is_exact_match, sample_diagnostics). sample_diagnostics
    is a small list of {train_number, source_departure, dest_arrival} for
    the first few trains, ALWAYS included regardless of match/no-match -
    this is what actually lets a "no trains matched" report get diagnosed
    from real evidence instead of another blind guess at RapidAPI's field
    shape: if these come back None/None for real trains, the bug is in
    parsing (wrong field name/format upstream); if they show correct real
    times but still don't match a band that should clearly include them,
    the bug is in this function's band math instead.
    """
    sample_diagnostics = [
        {"train_number": t.train_number, "source_departure": t.source_departure, "dest_arrival": t.dest_arrival}
        for t in trains[:5]
    ]
    if not any([departure_start, departure_end, arrival_start, arrival_end]):
        return trains, True, sample_diagnostics

    def in_band(mins: Optional[int], start_hhmm: Optional[str], end_hhmm: Optional[str]) -> Optional[bool]:
        if not start_hhmm and not end_hhmm:
            return None  # this leg wasn't filtered on
        if mins is None:
            return False  # unknown value - can't confirm a match
        start = _to_minutes(start_hhmm) if start_hhmm else None
        end = _to_minutes(end_hhmm) if end_hhmm else None
        if start is None:
            start = end
        if end is None:
            end = start
        if start == end:
            diff = min(abs(mins - start), 1440 - abs(mins - start))
            return diff <= point_tolerance_minutes
        if start <= end:
            return start <= mins <= end
        return mins >= start or mins <= end  # wraps past midnight

    matched = []
    for t in trains:
        dep_ok = in_band(_to_minutes(t.source_departure), departure_start, departure_end)
        if dep_ok is False:
            continue
        arr_ok = in_band(_to_minutes(t.dest_arrival), arrival_start, arrival_end)
        if arr_ok is False:
            continue
        matched.append(t)

    if matched:
        matched.sort(key=lambda t: _to_minutes(t.source_departure) if _to_minutes(t.source_departure) is not None else 1440)
        return matched, True, sample_diagnostics

    # Fallback: nothing matched both bands - show every train instead of a
    # dead end, sorted by departure time so it's still a sensible list.
    fallback = sorted(trains, key=lambda t: _to_minutes(t.source_departure) if _to_minutes(t.source_departure) is not None else 1440)
    return fallback, False, sample_diagnostics


def train_to_dict(t: TrainSummary) -> dict:
    """Plain-dict shape for JSON API responses (frontend/mobile train-search
    endpoint) - only ever built from an already-parsed TrainSummary, so
    still nothing invented here. Departure time (from source) and arrival
    time (at destination) are both included, under two names each -
    source_departure/dest_arrival (original field names, kept for anything
    already reading them) and departure_time/arrival_time (clearer names
    for new callers) - same values, not two separate lookups."""
    return {
        "train_number": t.train_number,
        "train_name": t.train_name,
        "source_departure": t.source_departure,
        "dest_arrival": t.dest_arrival,
        "departure_time": t.source_departure,
        "arrival_time": t.dest_arrival,
        "duration": t.duration,
        "classes": t.classes,
        "minutes_from_requested_time": t.minutes_from_requested_time,
    }


def paginate_trains(trains: List[TrainSummary], page: int, limit: int):
    """Slices an already filtered/sorted train list into one page.
    `limit` is the page size (1-50, enforced by the caller) - the user
    picks how many trains they want per page, this never drops trains
    from the underlying result, just returns the requested slice plus
    enough metadata (total, total_pages) for the caller to render
    pagination controls in the UI.
    Returns (page_trains, page, total, total_pages).
    """
    total = len(trains)
    total_pages = max(1, -(-total // limit)) if limit > 0 else 1  # ceil div
    page = max(1, min(page, total_pages))
    start = (page - 1) * limit
    page_trains = trains[start:start + limit]
    return page_trains, page, total, total_pages


def format_trains_summary(trains: List[TrainSummary], limit: int = 8) -> str:
    """Plain-text bullet list for grounding the LLM prompt / the no-key
    fallback view - never invented, only what parse_trains_list actually
    extracted from the provider response."""
    if not trains:
        return "No trains were returned for this route."
    lines = []
    for t in trains[:limit]:
        bits = [f"Train {t.train_number} ({t.train_name})"]
        if t.source_departure:
            bits.append(f"dep {t.source_departure}")
        if t.dest_arrival:
            bits.append(f"arr {t.dest_arrival}")
        if t.duration:
            bits.append(f"duration {t.duration}")
        if t.classes:
            bits.append(f"classes: {', '.join(t.classes)}")
        lines.append("- " + " · ".join(bits))
    if len(trains) > limit:
        lines.append(f"...and {len(trains) - limit} more.")
    return "\n".join(lines)