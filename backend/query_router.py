"""
query_router.py
-----------------
Classifies a free-typed user message into an intent and pulls out any
entities needed (PNR number, train number, station codes, date, class).

This is intentionally rule-based (regex + keywords) rather than an ML
classifier: intents here are structurally distinctive (a 10-digit number is
almost certainly a PNR; a 4-5 digit number near "status"/"running" is a
train number), so a lightweight router is faster, cheaper, and more
debuggable than a model call for every single message. The user still asks
anything in free text - there is no fixed menu of buttons anywhere in this
flow.
"""

import json
import os
import re
from datetime import datetime, timedelta
from enum import Enum

_CITY_ALIASES_PATH = os.path.join(os.path.dirname(__file__), "data", "city_aliases.json")
with open(_CITY_ALIASES_PATH, "r", encoding="utf-8") as f:
    # Sort longest-alias-first so "new delhi" matches before the bare "delhi"
    # substring inside it would otherwise win.
    _CITY_ALIASES = dict(sorted(json.load(f).items(), key=lambda kv: -len(kv[0])))


class Intent(str, Enum):
    PNR_STATUS = "pnr_status"
    LIVE_STATUS = "live_status"
    SEAT_AVAILABILITY = "seat_availability"
    TRAIN_SCHEDULE = "train_schedule"
    TRAINS_BETWEEN = "trains_between"
    NEARBY_STATIONS = "nearby_stations"
    ALTERNATIVE_ROUTE = "alternative_route"
    CROWD_PREDICTION = "crowd_prediction"
    GENERAL_FAQ = "general_faq"
    HELP = "help"

PNR_RE = re.compile(r"\b(\d{10})\b")
TRAIN_NO_RE = re.compile(r"\b(\d{5})\b")
STATION_CODE_RE = re.compile(r"\b([A-Z]{2,5})\b")
DATE_RE = re.compile(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b")
RADIUS_RE = re.compile(r"\b(\d{1,4})\s*km\b", re.IGNORECASE)
TIME_RE = re.compile(
    r"\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b"   # "3pm", "3:00 p.m."
    r"|\b([01]?\d|2[0-3]):([0-5]\d)\b",                    # "15:00", "3:00" (24h or ambiguous 24h-style)
    re.IGNORECASE,
)
# "5:30 p.m to 8:20 p.m", "5pm-8pm", "5 to 8:20 pm" (meridiem borrowed from
# the second time if the first one didn't state one, since "5 to 8pm"
# almost always means "5pm to 8pm", not 5am).
TIME_RANGE_RE = re.compile(
    r"\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:to|-|\u2013|until|till)\s*"
    r"(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b",
    re.IGNORECASE,
)
_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
# Longest-alias-first so "thursday" matches before a bare "thu" abbreviation
# pattern would, and each weekday also matches its common short forms.
_WEEKDAY_ALIASES = {
    "monday": "monday", "mon": "monday",
    "tuesday": "tuesday", "tue": "tuesday", "tues": "tuesday",
    "wednesday": "wednesday", "wed": "wednesday",
    "thursday": "thursday", "thu": "thursday", "thurs": "thursday",
    "friday": "friday", "fri": "friday",
    "saturday": "saturday", "sat": "saturday",
    "sunday": "sunday", "sun": "sunday",
}
DAY_OF_WEEK_RE = re.compile(
    r"\b(" + "|".join(sorted(_WEEKDAY_ALIASES, key=len, reverse=True)) + r")s?\b",
    re.IGNORECASE,
)

# Common English words that happen to be all-caps once we uppercase the
# text for station-code matching. These must never be mistaken for a
# station code (real station codes are things like NDLS, CSMT, BCT, SBC).
_STOPWORDS = {
    "AND", "FROM", "TO", "ON", "THE", "IS", "IN", "AT", "OF", "TRAIN",
    "TRAINS", "SEAT", "SEATS", "STATUS", "SCHEDULE", "BETWEEN", "RUNNING",
    "TODAY", "TOMORROW", "WHAT", "WHICH", "RUN", "LATE", "ANY", "MY",
    "FOR", "ARE", "CAN", "PNR", "CLASS", "AVAILABILITY", "STOPS", "ROUTE",
    "TIMING", "TIMETABLE", "ARRIVAL", "DEPARTURE", "TIME", "DELAY",
    "DELAYED", "WHERE", "CURRENT", "LOCATION", "IT", "ME", "DOES",
    "TRACK", "GPS", "MAP", "HELP", "GUIDE", "TUTORIAL", "SHOW",
    "AM", "PM", "GO", "LIST", "AVAILABLE", "NEW",
    "NEARBY", "NEAR", "STATIONS", "CLOSEST", "NEAREST", "CLOSE", "KM",
    "ALTERNATIVE", "ALTERNATE", "VIA", "REACH", "WAY", "CONNECTING",
    "CROWD", "CROWDED", "CAPACITY", "OCCUPANCY", "FULL", "PREDICT",
    "HOW", "WILL", "BE", "WOULD", "EXPECTED",
    # Added: everyday words that surface in paraphrased questions and were
    # previously slipping through as false "station codes" once uppercased
    # (e.g. "how many seats are vacant" -> MANY matched \b[A-Z]{2,5}\b).
    "THERE", "MANY", "PACKED", "VACANT", "BERTH", "BERTHS", "LEFT",
    "DIRECT", "LOST", "WORK", "WORKS", "BOT", "THIS", "THAT", "WHO",
    "YOU", "DOING", "OPEN", "STILL", "JUST", "ABOUT", "NEXT", "LAST",
    "FIRST", "SECOND", "OK", "OKAY", "PLEASE", "TELL", "NEED", "WANT",
    "GET", "GIVE", "PLS", "SOON", "NOW", "BUSY", "CHART", "AFTER",
    "BEFORE", "WAITLIST", "WL", "RAC", "CONFIRM", "CONFIRMED",
    "CHECK", "FIND", "OUT", "ETA", "ARRIVE", "ARRIVES", "DEPART",
    "DEPARTS", "COMING", "TRIP", "JOURNEY", "TICKET", "TICKETS",
}


def _extract_station_codes(text: str) -> list:
    candidates = STATION_CODE_RE.findall(text.upper())
    return [c for c in candidates if c not in _STOPWORDS]


def _extract_stations(text: str) -> list:
    """
    Combines explicit station codes ("NDLS") with everyday city names
    ("Hyderabad", "New Delhi") via city_aliases.json, so a question phrased
    the way most people actually type it - full city names, not codes -
    still resolves to real stations. Matches are kept in the order they
    appear in the text (first mention = source, second = destination),
    since that's how "from X to Y" phrasing naturally reads.
    """
    lower = text.lower()
    upper = text.upper()
    found = []  # list of (position, code)

    for match in STATION_CODE_RE.finditer(upper):
        word = match.group(1)
        if word in _STOPWORDS:
            continue
        if word.lower() in _CITY_ALIASES:
            continue  # e.g. "DELHI" uppercased from the city name "delhi" -
                      # let the city-alias match below resolve it to NDLS
                      # instead of treating the city name itself as a code.
        found.append((match.start(), word))

    for alias, code in _CITY_ALIASES.items():
        idx = lower.find(alias)
        if idx != -1:
            found.append((idx, code))

    found.sort(key=lambda pair: pair[0])

    ordered = []
    for _, code in found:
        if not ordered or ordered[-1] != code:
            ordered.append(code)

    if not ordered:
        # Nothing matched this file's own city_aliases.json dict or the
        # STATION_CODE_RE+_STOPWORDS heuristic - before giving up, try the
        # auto-built gazetteer (entity_gazetteer.py), which also covers
        # official full station names ("Mumbai Central") straight from
        # data/station_coordinates.json without anyone hand-adding them
        # here. Only used as a fallback so existing behavior above is
        # unchanged when it already found something.
        try:
            import entity_gazetteer
            ordered = entity_gazetteer.extract_stations_auto(text)
        except Exception:
            pass

    return ordered

LIVE_STATUS_KEYWORDS = [
    "running status", "live status", "running late", "delay", "delayed", "delaying",
    "where is my train", "where's my train", "current location", "track my train",
    "gps", "running on time", "on time", "is running", "is late", "is my train late",
    "how late", "delayed by", "delayed today", "real-time location", "real time location",
    "live location", "where is train", "train position", "position of train",
    "current status of train", "behind schedule", "running behind", "eta of", "eta for",
    "when will it reach", "when will the train reach", "has it left", "has it departed",
]
SEAT_AVAIL_KEYWORDS = [
    "seat availability", "available seats", "berth available", "any seats", "seat status",
    "seats left", "seats vacant", "vacant seats", "berths left", "any berths", "berth left",
    "seats free", "free seats", "is full", "fully booked", "is 3ac full", "is sl full",
    "vacancy in", "check availability", "availability in", "seat confirm chances",
    "confirmation chances", "how many seats are", "how many berths are",
    "seats available", "tickets available", "ticket availability", "available in which coach",
    "available in which class", "which coaches have", "which coach has", "berths available",
]
SCHEDULE_KEYWORDS = [
    "schedule", "route", "stops at", "timing", "timetable", "arrival time", "departure time",
    "route map", "show route", "what time does", "departs from", "arrives at",
    "list of stops", "stop list", "which stations does it stop", "stoppages", "halts at",
    "departure of", "arrival of", "time table",
]
BETWEEN_KEYWORDS = ["trains between", "trains from", "which trains run", "which trains are available",
                     "trains available", "list of trains", "trains to go from", "any trains from",
                     "direct train", "any direct train", "how can i go from", "how do i travel from",
                     "how do i go from", "options to travel from", "connecting trains from",
                     "way to travel from", "train from", "trains running from", "any train",
                     "train departing", "departing to", "train availability from", "train availability between",
                     "availability of trains", "availability from", "trains available from",
                     "availability between", "trains availability", "train list", "trains list",
                     "list available", "train list available"]
HELP_KEYWORDS = ["help", "how do i", "how to use", "how does this work", "tutorial", "guide me",
                  "what can you do", "what can i ask", "getting started", "instructions",
                  "what is this", "what can this bot do", "what can this assistant do",
                  "who are you", "i'm lost", "im lost", "confused how"]
NEARBY_KEYWORDS = ["nearby station", "stations near", "station near", "closest station", "nearest station",
                    "stations close to", "station close to", "stations around", "close to",
                    "within km of", "stations within"]
# Word-order-flexible fallback: "nearest/closest railway station to X" doesn't
# contain "nearest station" as one contiguous phrase, so a plain substring
# check misses it — this regex allows words (like "railway") in between.
NEARBY_RE = re.compile(r"\b(nearest|closest)\b.{0,15}\bstations?\b", re.IGNORECASE)
ALT_ROUTE_KEYWORDS = ["alternative route", "alternate route", "another way to reach", "connecting route",
                       "via which station", "different route", "route via", "other route",
                       "other way to reach", "another way to go"]
CROWD_KEYWORDS = ["how crowded", "crowd prediction", "will it be crowded", "train capacity",
                   "how full is", "occupancy", "predict crowd", "crowded train", "expected crowd",
                   "how full will", "will it be packed", "how packed", "will be packed",
                   "how busy is", "will be crowded", "be packed", "be crowded"]


def _extract_date(text: str) -> str:
    """Return a DD-MM-YYYY string; defaults to today if none found."""
    match = DATE_RE.search(text)
    if match:
        d, m, y = match.groups()
        if len(y) == 2:
            y = "20" + y
        return f"{int(d):02d}-{int(m):02d}-{y}"
    return datetime.now().strftime("%d-%m-%Y")


def _extract_time(text: str):
    """Returns 'HH:MM' (24-hour) if the message mentions a time, else None.
    Handles both '3pm'/'3:00 p.m.' style and bare '15:00' style."""
    match = TIME_RE.search(text)
    if not match:
        return None
    hour_ampm, minute_ampm, meridiem, hour_24, minute_24 = match.groups()
    if hour_24 is not None:
        return f"{int(hour_24):02d}:{minute_24}"
    hour = int(hour_ampm)
    minute = minute_ampm or "00"
    meridiem = meridiem.replace(".", "").lower()
    if meridiem == "pm" and hour != 12:
        hour += 12
    if meridiem == "am" and hour == 12:
        hour = 0
    return f"{hour:02d}:{minute}"


def _to_24h(hour: int, minute: str, meridiem: str) -> str:
    minute = minute or "00"
    meridiem = (meridiem or "").replace(".", "").lower()
    if meridiem == "pm" and hour != 12:
        hour += 12
    if meridiem == "am" and hour == 12:
        hour = 0
    return f"{hour:02d}:{minute}"


def _extract_time_range(text: str):
    """
    Returns (start_hhmm, end_hhmm) for phrasing like "5:30 p.m to 8:20 p.m"
    or "5pm-8pm", else None. If only the SECOND time states am/pm (e.g.
    "5 to 8pm"), the first one borrows it - "5 to 8pm" reads as 5pm-8pm to
    almost everyone, not 5am-8pm.
    """
    match = TIME_RANGE_RE.search(text)
    if not match:
        return None
    h1, m1, mer1, h2, m2, mer2 = match.groups()
    mer1 = mer1 or mer2
    start = _to_24h(int(h1), m1, mer1)
    end = _to_24h(int(h2), m2, mer2)
    return (start, end)


def _extract_day_of_week(text: str):
    """Returns a canonical lowercase weekday name ('monday'..'sunday') if
    the message names one (including short forms and the plural
    "Sundays" style), else None."""
    match = DAY_OF_WEEK_RE.search(text.lower())
    if not match:
        return None
    return _WEEKDAY_ALIASES.get(match.group(1).lower())


def _next_date_for_weekday(day_name: str, from_date=None) -> str:
    """DD-MM-YYYY for the next occurrence of `day_name` on/after `from_date`
    (defaults to today) - "today" counts if today already IS that weekday,
    matching how someone asking "trains on Mondays" would expect a hit on
    a Monday rather than always skipping a week ahead."""
    from_date = from_date or datetime.now()
    target = _WEEKDAYS.index(day_name)
    delta = (target - from_date.weekday()) % 7
    result = from_date + timedelta(days=delta)
    return result.strftime("%d-%m-%Y")


def classify(message: str) -> dict:
    """
    Returns a dict: {"intent": Intent, "entities": {...}}
    """
    text = message.strip()
    lower = text.lower()

    # 0. Help / tutorial - checked first since these are meta-questions
    # about the assistant itself, not railway data, and should never be
    # mistaken for a PNR/train lookup.
    if any(kw in lower for kw in HELP_KEYWORDS):
        return {"intent": Intent.HELP, "entities": {}}

    # 1. PNR status — a bare 10-digit number is an unambiguous PNR signal.
    pnr_match = PNR_RE.search(text)
    if pnr_match and ("pnr" in lower or True):  # 10-digit number alone is distinctive enough
        return {"intent": Intent.PNR_STATUS, "entities": {"pnr": pnr_match.group(1)}}

    # 2. Nearby station recommendations (geo-spatial) — checked before the
    # schedule/between keyword checks below since it's structurally
    # distinctive ("nearby"/"closest") and would otherwise never be reached.
    if any(kw in lower for kw in NEARBY_KEYWORDS) or NEARBY_RE.search(lower):
        stations = _extract_stations(text)
        radius_match = RADIUS_RE.search(text)
        return {
            "intent": Intent.NEARBY_STATIONS,
            "entities": {
                "station": stations[0] if stations else None,
                "radius_km": float(radius_match.group(1)) if radius_match else None,
            },
        }

    # 3. Alternative route planner (graph algorithms) — must be checked
    # before SCHEDULE_KEYWORDS below, since "route" alone would otherwise
    # match the schedule intent first.
    if any(kw in lower for kw in ALT_ROUTE_KEYWORDS):
        stations = _extract_stations(text)
        return {
            "intent": Intent.ALTERNATIVE_ROUTE,
            "entities": {
                "source": stations[0] if len(stations) > 0 else None,
                "dest": stations[1] if len(stations) > 1 else None,
            },
        }

    # 4. Train capacity & crowd prediction
    if any(kw in lower for kw in CROWD_KEYWORDS):
        train_match = TRAIN_NO_RE.search(text)
        stations = _extract_stations(text)
        return {
            "intent": Intent.CROWD_PREDICTION,
            "entities": {
                "train_number": train_match.group(1) if train_match else None,
                "source": stations[0] if len(stations) > 0 else None,
                "dest": stations[1] if len(stations) > 1 else None,
                "date": _extract_date(text),
            },
        }

    # 5. Live running status — also triggers on "reach/arrive" phrased with
    # a train number (e.g. "when will 12951 reach BCT"), since that's a
    # real-time ETA question, not a station-code lookup. Gated on a train
    # number being present so a plain "how to reach Chennai" (no train
    # number) still falls through to trains_between/FAQ as expected.
    train_match_early = TRAIN_NO_RE.search(text)
    if train_match_early and re.search(r"\b(reach|arrive|arriving)\b", lower):
        return {
            "intent": Intent.LIVE_STATUS,
            "entities": {"train_number": train_match_early.group(1), "date": _extract_date(text)},
        }

    if any(kw in lower for kw in LIVE_STATUS_KEYWORDS):
        train_match = TRAIN_NO_RE.search(text)
        return {
            "intent": Intent.LIVE_STATUS,
            "entities": {
                "train_number": train_match.group(1) if train_match else None,
                "date": _extract_date(text),
            },
        }

    # 6. Seat availability
    if any(kw in lower for kw in SEAT_AVAIL_KEYWORDS):
        train_match = TRAIN_NO_RE.search(text)
        stations = _extract_stations(text)
        return {
            "intent": Intent.SEAT_AVAILABILITY,
            "entities": {
                "train_number": train_match.group(1) if train_match else None,
                "source": stations[0] if len(stations) > 0 else None,
                "dest": stations[1] if len(stations) > 1 else None,
                "date": _extract_date(text),
            },
        }

    # 7. Train schedule
    if any(kw in lower for kw in SCHEDULE_KEYWORDS):
        train_match = TRAIN_NO_RE.search(text)
        stations = _extract_stations(text)
        day_of_week = _extract_day_of_week(text)
        has_explicit_date = bool(DATE_RE.search(text))
        date = (
            _extract_date(text) if has_explicit_date
            else _next_date_for_weekday(day_of_week) if day_of_week
            else None  # no date/day mentioned at all -> plain schedule, not date-scoped
        )
        return {
            "intent": Intent.TRAIN_SCHEDULE,
            "entities": {
                "train_number": train_match.group(1) if train_match else None,
                "source": stations[0] if len(stations) > 0 else None,
                "dest": stations[1] if len(stations) > 1 else None,
                "date": date,
                "day_of_week": day_of_week,
                "time": _extract_time(text),
                "time_range": _extract_time_range(text),
            },
        }

    # 8. Trains between two stations
    if any(kw in lower for kw in BETWEEN_KEYWORDS):
        stations = _extract_stations(text)
        day_of_week = _extract_day_of_week(text)
        has_explicit_date = bool(DATE_RE.search(text))
        date = (
            _extract_date(text) if has_explicit_date
            else _next_date_for_weekday(day_of_week) if day_of_week
            else _extract_date(text)
        )
        return {
            "intent": Intent.TRAINS_BETWEEN,
            "entities": {
                "source": stations[0] if len(stations) > 0 else None,
                "dest": stations[1] if len(stations) > 1 else None,
                "date": date,
                "day_of_week": day_of_week,
                "time": _extract_time(text),
                "time_range": _extract_time_range(text),
            },
        }

    # 9. Everything else: policy/FAQ style question -> RAG
    return {"intent": Intent.GENERAL_FAQ, "entities": {}}
