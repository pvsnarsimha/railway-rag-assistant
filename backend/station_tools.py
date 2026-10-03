"""
station_tools.py
----------------
Data layer behind the redesigned "At the station" tools in the mobile app's
More Tools tab: Live Departures, Platform Locator, Coach Position and
Station Navigator.

Sources, in the order they are trusted (same honesty rule as the rest of
this project — every value says where it came from, nothing is invented):

  1. RailKit "live at station" board (railkit-service /live-station) —
     the station's own running board: platform, expected time, delay.
  2. RapidAPI IRCTC "getLiveStation" — the same kind of board, used only
     when RailKit has nothing for the station.
  3. RailRadar live-status route (api.railradar.in /live) — per-station
     scheduled/actual times, delay and platform for ONE train.
  4. RailRadar coach composition (/coaches/{station}) — the real rake,
     aligned for this station.
  5. advanced_features.predict_platform — a clearly-labelled estimate,
     only when none of the above has a platform.

The provider row shapes differ (camelCase / snake_case / nested
arrival{} objects), so every field is looked up through a list of known
aliases. A field no provider sent stays None.
"""

import re
from datetime import datetime, timedelta, timezone
from typing import Optional

import advanced_features
from api_cache import cached
import gps_tracking
import railradar_fallback
import railway_api
import rapidapi_provider

_HHMM = re.compile(r"(\d{1,2}):(\d{2})")

# Rough physical constants for the walking estimate (Indian station norms):
# platforms are ~12 m apart centre-to-centre, a walking pace of ~1.2 m/s,
# and a lift adds about 90 s of waiting/ride time.
_PLATFORM_SPACING_M = 12
_WALK_M_PER_MIN = 72
_LIFT_EXTRA_MIN = 1.5


def ist_now() -> datetime:
    return (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# Generic field helpers
# ---------------------------------------------------------------------------
def _pick(row: dict, keys) -> Optional[object]:
    for k in keys:
        v = row.get(k) if isinstance(row, dict) else None
        if v not in (None, "", "-", "--"):
            return v
    return None


def to_hhmm(value) -> Optional[str]:
    """'10:22', '10:22:00', '2026-09-28T10:22:00+05:30', '10:22, 28 Sep' -> '10:22'."""
    if value in (None, ""):
        return None
    if isinstance(value, dict):
        value = _pick(value, ("scheduled", "expected", "actual", "time"))
        if value is None:
            return None
    m = _HHMM.search(str(value))
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if 0 <= h <= 23 and 0 <= mi <= 59:
        return f"{h:02d}:{mi:02d}"
    return None


def _minutes(hhmm: Optional[str]) -> Optional[int]:
    if not hhmm:
        return None
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _add_minutes(hhmm: Optional[str], delta: Optional[int]) -> Optional[str]:
    base = _minutes(hhmm)
    if base is None or delta is None:
        return None
    t = (base + int(delta)) % 1440
    return f"{t // 60:02d}:{t % 60:02d}"


def parse_delay_minutes(value) -> Optional[int]:
    """12 / '12' / '+12 min' / '12 Min Late' / '01:05 hrs late' / 'Right Time' -> minutes."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(round(value))
    text = str(value).strip().lower()
    if any(w in text for w in ("right time", "on time", "ontime", "no delay")):
        return 0
    hm = re.search(r"(\d{1,2}):(\d{2})\s*(hrs?|hours?)?", text)
    if hm and ("hr" in text or "hour" in text or ":" in text):
        mins = int(hm.group(1)) * 60 + int(hm.group(2))
    else:
        num = re.search(r"-?\d+", text)
        if not num:
            return None
        mins = int(num.group(0))
        if "hr" in text or "hour" in text:
            mins *= 60
    if "early" in text or text.startswith("-"):
        mins = -abs(mins)
    return mins


def _minutes_until(hhmm: Optional[str], now: Optional[datetime] = None) -> Optional[int]:
    """Minutes from now (IST) to a clock time, treating anything more than
    3 h in the past as tomorrow (a board lists the next few hours)."""
    t = _minutes(hhmm)
    if t is None:
        return None
    now = now or ist_now()
    diff = t - (now.hour * 60 + now.minute)
    if diff < -180:
        diff += 1440
    elif diff > 1260:
        diff -= 1440
    return diff


# ---------------------------------------------------------------------------
# Live station board
# ---------------------------------------------------------------------------
_ROW_LIST_KEYS = ("trains", "trainList", "liveTrains", "results", "list", "data")


def _board_rows(payload) -> list:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in _ROW_LIST_KEYS:
            inner = payload.get(key)
            if isinstance(inner, list):
                return inner
            if isinstance(inner, dict):
                rows = _board_rows(inner)
                if rows:
                    return rows
    return []


def _timing(row: dict, kind: str):
    """(scheduled, expected, delay) for kind 'arr' or 'dep' out of a board row."""
    nested = row.get("arrival" if kind == "arr" else "departure")
    sched = exp = delay = None
    if isinstance(nested, dict):
        sched = to_hhmm(_pick(nested, ("scheduled", "sch", "time", "std", "sta")))
        exp = to_hhmm(_pick(nested, ("expected", "actual", "eta", "etd")))
        delay = parse_delay_minutes(_pick(nested, ("delay", "delay_minutes", "delayMinutes", "late")))
    elif nested not in (None, ""):
        sched = to_hhmm(nested)

    if kind == "arr":
        sched = sched or to_hhmm(_pick(row, (
            "scheduledArrival", "schArrival", "sch_arr", "sta", "arrivalTime", "arrival_time",
            "scheduled_arrival", "arr", "arrTime", "schArrTime")))
        exp = exp or to_hhmm(_pick(row, (
            "expectedArrival", "expected_arrival", "eta", "actualArrival", "actual_arrival",
            "expArrival", "expected_arrival_time", "expArrTime", "actArrTime")))
        if delay is None:
            delay = parse_delay_minutes(_pick(row, ("delayArrival", "delay_arrival", "arrDelay", "delayArr")))
    else:
        sched = sched or to_hhmm(_pick(row, (
            "scheduledDeparture", "schDeparture", "sch_dep", "std", "departureTime", "departure_time",
            "scheduled_departure", "dep", "depTime", "schDepTime")))
        exp = exp or to_hhmm(_pick(row, (
            "expectedDeparture", "expected_departure", "etd", "actualDeparture", "actual_departure",
            "expDeparture", "expected_departure_time", "expDepTime", "actDepTime")))
        if delay is None:
            delay = parse_delay_minutes(_pick(row, ("delayDeparture", "delay_departure", "depDelay", "delayDep")))
    return sched, exp, delay


def normalize_board_row(row: dict) -> Optional[dict]:
    if not isinstance(row, dict):
        return None
    number = _pick(row, ("trainNumber", "train_number", "trainNo", "train_no", "number", "train_num"))
    if number is None:
        return None
    number = str(number).strip()

    sch_arr, exp_arr, delay_arr = _timing(row, "arr")
    sch_dep, exp_dep, delay_dep = _timing(row, "dep")
    generic_delay = parse_delay_minutes(_pick(row, ("delay", "delayInMinutes", "delay_in_min", "late_by", "lateBy", "delayMinutes")))
    delay_arr = delay_arr if delay_arr is not None else generic_delay
    delay_dep = delay_dep if delay_dep is not None else generic_delay
    # A train running late into a station leaves it late too (and a late
    # departure implies the arrival was late) — share the one known value.
    if delay_dep is None and delay_arr is not None and sch_dep and not exp_dep:
        delay_dep = delay_arr
    if delay_arr is None and delay_dep is not None and sch_arr and not exp_arr:
        delay_arr = delay_dep

    # Fill whichever of expected/delay is missing from the other.
    if exp_arr is None and sch_arr and delay_arr is not None:
        exp_arr = _add_minutes(sch_arr, delay_arr)
    if exp_dep is None and sch_dep and delay_dep is not None:
        exp_dep = _add_minutes(sch_dep, delay_dep)
    if delay_arr is None and sch_arr and exp_arr:
        delay_arr = ((_minutes(exp_arr) - _minutes(sch_arr) + 720) % 1440) - 720
    if delay_dep is None and sch_dep and exp_dep:
        delay_dep = ((_minutes(exp_dep) - _minutes(sch_dep) + 720) % 1440) - 720

    status_text = _pick(row, ("status", "currentStatus", "trainStatus", "remark", "remarks"))
    status_text = str(status_text) if status_text is not None else None
    cancelled = bool(row.get("isCancelled") or row.get("cancelled")) or (
        status_text is not None and "cancel" in status_text.lower())

    platform = _pick(row, ("platform", "platformNumber", "platform_number", "pf", "platformNo", "expectedPlatform"))
    if isinstance(platform, dict):
        platform = _pick(platform, ("number", "actual", "expected"))
    platform = str(platform).strip() if platform is not None else None
    if platform in ("0", "-", "--", "?"):
        platform = None

    return {
        "train_number": number,
        "train_name": _pick(row, ("trainName", "train_name", "name")),
        "source": _pick(row, ("sourceStationName", "source_stn_name", "sourceName", "source", "from", "fromStationName", "source_name")),
        "destination": _pick(row, ("destinationStationName", "dstn_stn_name", "destinationName", "destination", "to", "toStationName", "destination_name", "dest")),
        "scheduled_arrival": sch_arr,
        "expected_arrival": exp_arr,
        "arrival_delay_minutes": delay_arr,
        "scheduled_departure": sch_dep,
        "expected_departure": exp_dep,
        "departure_delay_minutes": delay_dep,
        "platform": platform,
        "cancelled": cancelled,
        "status_text": status_text,
    }


def _status_for(delay: Optional[int], cancelled: bool) -> str:
    if cancelled:
        return "cancelled"
    if delay is None:
        return "unknown"
    if delay >= 5:
        return "delayed"
    return "on_time"


def build_board(rows: list, mode: str = "departures", now: Optional[datetime] = None) -> list:
    """Normalized rows -> sorted Departures or Arrivals list."""
    mode = "arrivals" if mode == "arrivals" else "departures"
    out = []
    for r in rows:
        if mode == "departures":
            sched, exp, delay = r["scheduled_departure"], r["expected_departure"], r["departure_delay_minutes"]
            # A train that ends here never departs; a row with only an
            # arrival time is a terminating train.
            if sched is None and exp is None:
                continue
        else:
            sched, exp, delay = r["scheduled_arrival"], r["expected_arrival"], r["arrival_delay_minutes"]
            if sched is None and exp is None:
                continue
        shown = exp or sched
        out.append({
            **r,
            "time": sched or exp,
            "expected_time": exp,
            "delay_minutes": delay,
            "status": _status_for(delay, r["cancelled"]),
            "minutes_until": _minutes_until(shown, now),
        })
    out.sort(key=lambda x: (x["minutes_until"] if x["minutes_until"] is not None else 10_000))
    return out


@cached(ttl_seconds=60, prefix="rapidapi_live_station")
def _rapidapi_live_station(station_code: str, hours: int) -> dict:
    return rapidapi_provider.get_live_station(station_code, hours)


def fetch_station_board(station_code: str, hours: int = 2) -> dict:
    """Raw rows for a station from RailKit, falling back to RapidAPI."""
    station_code = (station_code or "").strip().upper()
    errors = []
    try:
        data = railway_api.get_live_at_station(station_code, hours)
        rows = [r for r in (normalize_board_row(x) for x in _board_rows(data)) if r]
        if rows:
            return {"rows": rows, "source": "railkit", "errors": errors}
        errors.append("RailKit returned no trains for this station/window.")
    except railway_api.RailwayAPIError as e:
        errors.append(f"RailKit: {e}")
    try:
        data = _rapidapi_live_station(station_code, hours)
        rows = [r for r in (normalize_board_row(x) for x in _board_rows(data)) if r]
        if rows:
            return {"rows": rows, "source": "rapidapi", "errors": errors}
        errors.append("RapidAPI returned no trains for this station/window.")
    except rapidapi_provider.RapidAPIProviderError as e:
        errors.append(f"RapidAPI: {e}")
    return {"rows": [], "source": None, "errors": errors}


def station_name(station_code: str) -> Optional[str]:
    info = gps_tracking._lookup_station(station_code)
    return (info or {}).get("name")


def live_board(station_code: str, mode: str = "departures", hours: int = 2) -> dict:
    station_code = (station_code or "").strip().upper()
    hours = hours if hours in (2, 4, 8) else 2
    fetched = fetch_station_board(station_code, hours)
    trains = build_board(fetched["rows"], mode)
    amen = advanced_features.station_amenities(station_code)
    return {
        "station": station_code,
        "station_name": station_name(station_code) or (amen.get("amenities") or {}).get("name"),
        "mode": "arrivals" if mode == "arrivals" else "departures",
        "hours_window": hours,
        "source": fetched["source"],
        "trains": trains,
        "amenities": amen.get("amenities"),
        "updated_at": ist_now().strftime("%H:%M:%S"),
        "error": None if trains else ("; ".join(fetched["errors"]) or "No trains reported for this station/window right now."),
    }


# ---------------------------------------------------------------------------
# Coach / berth helpers
# ---------------------------------------------------------------------------
_BAY8 = {1: "Lower", 2: "Middle", 3: "Upper", 4: "Lower", 5: "Middle", 6: "Upper", 7: "Side Lower", 8: "Side Upper"}
_BAY6 = {1: "Lower", 2: "Upper", 3: "Lower", 4: "Upper", 5: "Side Lower", 6: "Side Upper"}
_BERTHS_PER_COACH = {"SL": 72, "3A": 72, "3E": 80, "2A": 48, "1A": 22, "CC": 78, "EC": 56, "2S": 108}
_CLASS_BY_PREFIX = [("HA", "1A"), ("M", "3E"), ("S", "SL"), ("B", "3A"), ("A", "2A"), ("H", "1A"),
                    ("C", "CC"), ("E", "EC"), ("D", "2S"), ("G", "GEN")]


def coach_class(coach_code: Optional[str]) -> Optional[str]:
    code = (coach_code or "").strip().upper()
    for prefix, cls in _CLASS_BY_PREFIX:
        if code.startswith(prefix) and code[len(prefix):].isdigit():
            return cls
    return None


def berth_info(coach_code: Optional[str], berth: Optional[int], travel_class: Optional[str] = None) -> Optional[dict]:
    """Standard Indian Railways berth type + nearest door for a berth number."""
    if not berth:
        return None
    cls = (travel_class or coach_class(coach_code) or "").upper()
    total = _BERTHS_PER_COACH.get(cls)
    btype = None
    if cls in ("SL", "3A", "3E"):
        btype = _BAY8[(berth - 1) % 8 + 1]
    elif cls == "2A":
        btype = _BAY6[(berth - 1) % 6 + 1]
    elif cls in ("CC", "EC", "2S"):
        btype = "Seat"
    door = None
    if total:
        # Berth 1 sits at one end of the coach and the last berth at the
        # other; each end has a door.
        door = "front" if berth <= total / 2 else "rear"
    return {"berth": berth, "type": btype, "coach_class": cls or None, "total_berths": total, "nearest_door": door}


def rake_from_composition(comp: dict) -> list:
    """RailRadar coach-composition `data` -> ordered list of {code, category}.
    Order is engine -> rear as the train pulls into the station (mirrored
    when RailRadar flags a reversal for this station)."""
    if not isinstance(comp, dict):
        return []
    rake = comp.get("rake") or comp.get("coaches") or []
    if not isinstance(rake, list):
        return []
    rake = sorted([c for c in rake if isinstance(c, dict)], key=lambda c: c.get("position") or 0)
    if comp.get("reversal") is True:
        rake = list(reversed(rake))
    return [{
        "code": str(c.get("code") or c.get("coachCode") or c.get("coach") or "?"),
        "category": c.get("category") or c.get("classType") or c.get("type"),
    } for c in rake]


def locate_coach(rake: list, coach_code: Optional[str]) -> Optional[dict]:
    code = (coach_code or "").strip().upper()
    if not code or not rake:
        return None
    for i, c in enumerate(rake):
        if c["code"].upper() == code:
            frac = (i + 0.5) / len(rake)
            zone = "engine end" if frac < 0.34 else ("middle" if frac < 0.67 else "rear end")
            return {"index": i, "total": len(rake), "fraction": round(frac, 3), "zone": zone}
    return None


# ---------------------------------------------------------------------------
# Platform Locator
# ---------------------------------------------------------------------------
def _railradar_stop(train_number: str, station_code: str, date_ddmmyyyy: Optional[str]) -> Optional[dict]:
    try:
        data = railradar_fallback._fetch_raw(train_number, railradar_fallback._ddmmyyyy_to_iso(date_ddmmyyyy))
    except Exception:  # noqa: BLE001 — no key / no network / no run: just not available
        return None
    for p in data.get("route") or []:
        if str(p.get("stationCode") or "").upper() == station_code:
            return {
                "train_name": data.get("trainName") or (data.get("train") or {}).get("name"),
                "station_name": p.get("stationName"),
                "platform": str(p["platform"]) if p.get("platform") not in (None, "", 0, "0") else None,
                "scheduled_arrival": to_hhmm(p.get("scheduledArrival")),
                "scheduled_departure": to_hhmm(p.get("scheduledDeparture")),
                "actual_arrival": to_hhmm(p.get("actualArrival")),
                "arrival_delay_minutes": p.get("delayArrival"),
                "departure_delay_minutes": p.get("delayDeparture"),
                "status": p.get("status"),
            }
    return None


def _composition(train_number: str, station_code: str) -> Optional[dict]:
    try:
        comp = railway_api.get_coach_composition(train_number, station_code)
    except railway_api.RailwayAPIError:
        return None
    if isinstance(comp, dict) and isinstance(comp.get("data"), dict) and "rake" not in comp:
        comp = comp["data"]
    return comp if isinstance(comp, dict) else None


def locate_platform(train_number: str, station_code: str, date_ddmmyyyy: Optional[str] = None,
                    coach: Optional[str] = None, berth: Optional[int] = None) -> dict:
    station_code = (station_code or "").strip().upper()
    train_number = (train_number or "").strip()
    coach = (coach or "").strip().upper() or None

    board_row = None
    board_source = None
    fetched = fetch_station_board(station_code, 4)
    for r in fetched["rows"]:
        if r["train_number"] == train_number:
            board_row, board_source = r, fetched["source"]
            break

    rr = _railradar_stop(train_number, station_code, date_ddmmyyyy)
    comp = _composition(train_number, station_code)
    comp_platform = None
    if comp and isinstance(comp.get("station"), dict) and comp["station"].get("platform") not in (None, "", 0, "0"):
        comp_platform = str(comp["station"]["platform"])

    predicted = None
    platform_candidates, platform_busy = [], {}
    if board_row and board_row.get("platform"):
        platform, source = board_row["platform"], f"station_board_{board_source}"
    elif rr and rr.get("platform"):
        platform, source = rr["platform"], "railradar_live"
    elif comp_platform:
        platform, source = comp_platform, "railradar_coach_alignment"
    else:
        predicted = advanced_features.predict_platform(train_number, station_code)
        platform, source = str(predicted["predicted_platform"]), "estimate"
        # The hash above is only a last resort. Prefer a ranked guess from real
        # history + what the live board says is already occupied.
        try:
            import platform_intel
            cands, busy = platform_intel.rank_candidates(
                train_number, station_code, fetched["rows"],
                ((board_row or {}).get("expected_arrival") or (board_row or {}).get("scheduled_arrival") or (rr or {}).get("scheduled_arrival")),
                ((board_row or {}).get("expected_departure") or (board_row or {}).get("scheduled_departure") or (rr or {}).get("scheduled_departure")),
                predicted.get("station_platform_count"))
        except Exception:  # noqa: BLE001
            cands, busy = [], {}
        if cands:
            platform = cands[0]["platform"]
            predicted["alternate_platform"] = cands[1]["platform"] if len(cands) > 1 else None
        platform_candidates, platform_busy = cands, busy

    # Timings: the board first (station-reported), RailRadar next.
    sched_arr = (board_row or {}).get("scheduled_arrival") or (rr or {}).get("scheduled_arrival")
    sched_dep = (board_row or {}).get("scheduled_departure") or (rr or {}).get("scheduled_departure")
    delay = (board_row or {}).get("arrival_delay_minutes")
    if delay is None:
        delay = (board_row or {}).get("departure_delay_minutes")
    if delay is None and rr:
        delay = rr.get("arrival_delay_minutes") if rr.get("arrival_delay_minutes") is not None else rr.get("departure_delay_minutes")
    expected_arr = (board_row or {}).get("expected_arrival") or (rr or {}).get("actual_arrival") or _add_minutes(sched_arr, delay)
    expected_dep = (board_row or {}).get("expected_departure") or _add_minutes(sched_dep, delay)
    arrives_in = _minutes_until(expected_arr or sched_arr or expected_dep or sched_dep)

    rake = rake_from_composition(comp) if comp else []
    coach_pos = locate_coach(rake, coach)

    train_name = (board_row or {}).get("train_name") or (rr or {}).get("train_name") or (comp or {}).get("trainName")
    return {
        "train_number": train_number,
        "train_name": train_name,
        "station": station_code,
        "station_name": (rr or {}).get("station_name") or station_name(station_code) or station_code,
        "platform": platform,
        "platform_source": source,
        "platform_confirmed": source.startswith("station_board"),
        "alternate_platform": (predicted or {}).get("alternate_platform"),
        "platform_candidates": platform_candidates,
        "platform_busy": platform_busy,
        "scheduled_arrival": sched_arr,
        "expected_arrival": expected_arr,
        "scheduled_departure": sched_dep,
        "expected_departure": expected_dep,
        "delay_minutes": delay,
        "arrives_in_minutes": arrives_in,
        "cancelled": bool((board_row or {}).get("cancelled")),
        "rake": rake,
        "rake_source": "railradar" if rake else None,
        "coach": coach,
        "coach_position": coach_pos,
        "coach_found_in_rake": bool(coach_pos) if (coach and rake) else None,
        "berth": berth_info(coach, berth),
        "checked_at": ist_now().strftime("%H:%M"),
        "sources_note": {
            "station_board": board_source,
            "railradar_live": bool(rr),
            "railradar_coaches": bool(rake),
        },
        "disclaimer": (
            "Platform from the station's live board is what the station has announced; RailRadar's "
            "platform is its expected allocation; an 'estimate' is a pattern guess only. Platforms can "
            "change until the train arrives — watch the station display boards."
        ),
    }


# ---------------------------------------------------------------------------
# Station Navigator (schematic map + walking route)
# ---------------------------------------------------------------------------
_TYPICAL_CONCOURSE = ["booking", "toilets", "canteen", "water", "lift", "atm"]
_FACILITY_MAP = {
    "food_court": "canteen", "cloak_room": "cloak_room", "waiting_room": "waiting_room",
    "retiring_room": "retiring_room", "executive_lounge": "lounge", "wifi": "wifi",
}


def station_map(station_code: str, platform: Optional[int] = None, train_number: Optional[str] = None,
                coach: Optional[str] = None, date_ddmmyyyy: Optional[str] = None,
                step_free: bool = False) -> dict:
    station_code = (station_code or "").strip().upper()
    nav = advanced_features.station_navigator(station_code)
    n_platforms = int(nav.get("station_platform_count") or 4)

    located = None
    platform_source = "user_given" if platform else None
    if platform is None and train_number:
        located = locate_platform(train_number, station_code, date_ddmmyyyy, coach)
        try:
            platform = int(re.match(r"\d+", located["platform"]).group(0))
        except (TypeError, AttributeError, ValueError):
            platform = None
        platform_source = located["platform_source"]
    if platform is None:
        platform, platform_source = 1, "default"
    platform = max(1, int(platform))
    n_platforms = max(n_platforms, platform)

    # Walking model: concourse -> (FOB/lift) -> platform -> along the
    # platform to the coach (if its position in the rake is known).
    concourse_m = 45
    along_m = 60
    coach_pos = (located or {}).get("coach_position")
    if coach_pos:
        # A 24-coach rake is ~560 m; assume the concourse/FOB is mid-platform.
        along_m = int(abs(coach_pos["fraction"] - 0.5) * 560) + 10
    steps = [{"icon": "walk", "text": "Walk straight through the concourse past the booking office and canteen",
              "meters": concourse_m}]
    if platform == 1:
        steps.append({"icon": "enter", "text": "Platform 1 is beside the main entrance — no bridge needed", "meters": 15})
        bridge_m = 15
    else:
        bridge_m = (platform - 1) * _PLATFORM_SPACING_M + 20
        if step_free:
            steps.append({"icon": "lift", "text": f"Take the lift up to the foot over bridge, cross to PF {platform} and take the lift down",
                          "meters": bridge_m})
        else:
            steps.append({"icon": "stairs", "text": f"Take the foot over bridge (or lift) and cross to PF {platform}",
                          "meters": bridge_m})
    target = f"coach {coach}" if coach else "your coach"
    if coach_pos:
        direction = "towards the engine end" if coach_pos["fraction"] < 0.5 else "towards the rear end"
        steps.append({"icon": "flag", "text": f"On PF {platform}, walk {direction} to {target}", "meters": along_m})
    else:
        steps.append({"icon": "flag", "text": f"On PF {platform}, check the coach display board for {target}", "meters": along_m})

    total_m = sum(s["meters"] for s in steps)
    minutes = total_m / _WALK_M_PER_MIN + (_LIFT_EXTRA_MIN if step_free and platform > 1 else 0)

    amen = (advanced_features.station_amenities(station_code).get("amenities") or {})
    known = [_FACILITY_MAP[k] for k, v in amen.items() if k in _FACILITY_MAP and v]
    concourse = list(dict.fromkeys(_TYPICAL_CONCOURSE + known))

    return {
        "station": station_code,
        "station_name": nav.get("name") if nav.get("name") != station_code else (station_name(station_code) or station_code),
        "platform_count": n_platforms,
        "platform_count_basis": nav.get("platform_count_basis"),
        "target_platform": platform,
        "platform_source": platform_source,
        "coach": coach,
        "coach_position": coach_pos,
        "step_free": step_free,
        "steps": steps,
        "walk_meters": int(round(total_m / 5.0) * 5),
        "walk_minutes": max(1, int(round(minutes))),
        "train": ({
            "train_number": located["train_number"],
            "train_name": located["train_name"],
            "arrives_in_minutes": located["arrives_in_minutes"],
            "expected_arrival": located["expected_arrival"],
            "platform_confirmed": located["platform_confirmed"],
            "rake": located.get("rake") or [],
        } if located else None),
        "concourse_facilities": concourse,
        "facilities_confirmed": known,
        "entrance_sides": nav.get("entrance_sides") or [],
        "notable_note": nav.get("notable_note"),
        "disclaimer": (
            "Schematic, not the station's real floor plan: no Indian station publishes an indoor map "
            "through any API. It follows the usual layout (PF 1 by the main entrance, higher platforms "
            "via the foot over bridge). Distances and walking time are estimates."
        ),
    }
