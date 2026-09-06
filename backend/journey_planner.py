"""
journey_planner.py
--------------------
FEATURE: Personalized Journey Planner.

Combines pieces that already exist elsewhere in this project into one
"plan my journey" answer, instead of inventing a new data source:

  1. DIRECT TRAINS - railway_api.search_trains_between_stations() +
     trains_between.py, exactly like the Search Trains tool.
  2. JUNCTION-HOPPING ALTERNATIVES - route_planner.py's real k-shortest-
     paths graph over the curated trunk-corridor network, then a REAL
     per-leg train lookup (same search_trains_between_stations call) for
     each hop - never a guessed train number for a leg.
  3. RANKING - "fastest" (real duration = arrival-time minus departure-
     time, computed from the provider's own times, not a parsed guess),
     "cheapest" (real live fare via railway_api.get_fare - only ever
     shown when a travel_class was given, since fare is class-specific
     and there is no honest way to rank "cheapest" without one), and
     "fewest_changes" (direct trains first, then by hop count).

Same honesty rules as the rest of the project:
  - A multi-leg alternative whose leg has no real train found says so
    plainly (`train_found: false`) rather than inventing one.
  - Fare is only ever populated from a real get_fare() call; if no class
    was given, every fare field stays null with a note explaining why,
    never a fabricated number.
  - Live fare/availability lookups are capped (see _FARE_LOOKUP_CAP)
    so one planning request can't fan out into an unbounded number of
    provider calls.
"""

from dataclasses import dataclass, field
from typing import List, Optional

import railway_api
import trains_between
import route_planner
import advanced_features

_FARE_LOOKUP_CAP = 6           # max real get_fare() calls per plan request
_ALT_ROUTE_CAP = 2             # how many junction-hopping alternatives to try to flesh out with real legs


def _duration_minutes(departure_hhmm: Optional[str], arrival_hhmm: Optional[str]) -> Optional[int]:
    """Real elapsed time computed from the provider's own departure/arrival
    clock times (HH:MM, 24h) - not a parsed guess at some other duration
    string whose format/units aren't guaranteed. Assumes a same-day-or-
    next-day journey (wraps once past midnight); genuinely multi-day
    trains will read as their same-clock-time-tomorrow duration, which is
    the honest limit of clock-only data with no explicit day-offset from
    this provider field - callers should treat single-leg direct-train
    durations under ~36h as reliable and treat anything else cautiously."""
    if not departure_hhmm or not arrival_hhmm:
        return None
    try:
        dh, dm = str(departure_hhmm).split(":")[:2]
        ah, am = str(arrival_hhmm).split(":")[:2]
        dep = int(dh) * 60 + int(dm)
        arr = int(ah) * 60 + int(am)
    except (ValueError, TypeError):
        return None
    diff = arr - dep
    if diff < 0:
        diff += 1440
    return diff


def _format_duration(minutes: Optional[int]) -> Optional[str]:
    if minutes is None:
        return None
    h, m = divmod(minutes, 60)
    return f"{h}h {m}m"


@dataclass
class DirectOption:
    train_number: str
    train_name: str
    departure_time: Optional[str]
    arrival_time: Optional[str]
    duration_minutes: Optional[int]
    duration_display: Optional[str]
    classes: List[str] = field(default_factory=list)
    fare: Optional[float] = None
    fare_note: Optional[str] = None


@dataclass
class Leg:
    from_code: str
    from_name: str
    to_code: str
    to_name: str
    train_number: Optional[str] = None
    train_name: Optional[str] = None
    departure_time: Optional[str] = None
    arrival_time: Optional[str] = None
    train_found: bool = False


@dataclass
class AlternativeRoute:
    via_names: List[str]
    hops: int
    total_distance_km: float
    legs: List[Leg] = field(default_factory=list)
    all_legs_confirmed: bool = False


@dataclass
class JourneyPlan:
    source: str
    dest: str
    date: Optional[str]
    preference: str
    travel_class: Optional[str]
    direct_options: List[DirectOption] = field(default_factory=list)
    alternative_routes: List[AlternativeRoute] = field(default_factory=list)
    note: Optional[str] = None
    fare_note: Optional[str] = None


def _fetch_direct_options(source: str, dest: str, date: Optional[str]) -> List[DirectOption]:
    try:
        live_data = railway_api.search_trains_between_stations(source, dest, date)
    except railway_api.RailwayAPIError:
        return []
    trains = trains_between.parse_trains_list(live_data)
    options = []
    for t in trains:
        mins = _duration_minutes(t.source_departure, t.dest_arrival)
        options.append(DirectOption(
            train_number=t.train_number, train_name=t.train_name,
            departure_time=t.source_departure, arrival_time=t.dest_arrival,
            duration_minutes=mins, duration_display=_format_duration(mins),
            classes=t.classes,
        ))
    return options


def _find_leg_train(from_code: str, to_code: str) -> Optional[trains_between.TrainSummary]:
    try:
        live_data = railway_api.search_trains_between_stations(from_code, to_code, None)
    except railway_api.RailwayAPIError:
        return None
    trains = trains_between.parse_trains_list(live_data)
    return trains[0] if trains else None


def _build_alternative_routes(source: str, dest: str) -> List[AlternativeRoute]:
    plan = route_planner.find_alternative_routes(source, dest, k=_ALT_ROUTE_CAP + 1)
    routes = []
    for opt in plan.options:
        if opt.is_direct_corridor:
            continue  # the direct-corridor option is already covered by direct_options
        if len(routes) >= _ALT_ROUTE_CAP:
            break
        legs = []
        all_confirmed = True
        for i in range(len(opt.stations) - 1):
            from_code, to_code = opt.stations[i], opt.stations[i + 1]
            leg_train = _find_leg_train(from_code, to_code)
            if leg_train:
                legs.append(Leg(
                    from_code=from_code, from_name=opt.station_names[i],
                    to_code=to_code, to_name=opt.station_names[i + 1],
                    train_number=leg_train.train_number, train_name=leg_train.train_name,
                    departure_time=leg_train.source_departure, arrival_time=leg_train.dest_arrival,
                    train_found=True,
                ))
            else:
                all_confirmed = False
                legs.append(Leg(
                    from_code=from_code, from_name=opt.station_names[i],
                    to_code=to_code, to_name=opt.station_names[i + 1],
                    train_found=False,
                ))
        routes.append(AlternativeRoute(
            via_names=opt.station_names, hops=opt.hops,
            total_distance_km=opt.total_distance_km, legs=legs,
            all_legs_confirmed=all_confirmed,
        ))
    return routes


def plan_journey(source: str, dest: str, date: Optional[str], preference: str = "fastest",
                  travel_class: Optional[str] = None, quota: str = "GN") -> JourneyPlan:
    preference = (preference or "fastest").strip().lower()
    if preference not in ("fastest", "cheapest", "fewest_changes"):
        preference = "fastest"

    plan = JourneyPlan(source=source, dest=dest, date=date, preference=preference, travel_class=travel_class)

    plan.direct_options = _fetch_direct_options(source, dest, date)
    plan.alternative_routes = _build_alternative_routes(source, dest)

    # --- Live fare (only ever real, only ever when a class was given) ---
    if travel_class and date:
        # Rank candidates by duration first (a reasonable pre-fare order)
        # so the capped fare-lookup budget goes to the trains most likely
        # to matter, regardless of which preference the user picked.
        candidates = sorted(
            plan.direct_options,
            key=lambda o: o.duration_minutes if o.duration_minutes is not None else 10**9,
        )[:_FARE_LOOKUP_CAP]
        for opt in candidates:
            try:
                fare_data = railway_api.get_fare(opt.train_number, source, dest, date, travel_class, quota)
                opt.fare = advanced_features.extract_fare_amount(fare_data)
                if opt.fare is None:
                    opt.fare_note = "Fare not returned for this class/quota."
            except railway_api.RailwayAPIError as e:
                opt.fare_note = str(e)
        if len(plan.direct_options) > _FARE_LOOKUP_CAP:
            plan.fare_note = f"Live fare checked for the {_FARE_LOOKUP_CAP} closest-in-duration trains only; the rest show duration/timing only."
    elif preference == "cheapest":
        plan.fare_note = "Pick a class (and date) to rank by real live fare — without one there's no honest \"cheapest\" to show, so results are sorted by duration instead."

    # --- Ranking ---
    if preference == "fastest":
        plan.direct_options.sort(key=lambda o: o.duration_minutes if o.duration_minutes is not None else 10**9)
    elif preference == "cheapest":
        if travel_class and date:
            with_fare = [o for o in plan.direct_options if o.fare is not None]
            without_fare = [o for o in plan.direct_options if o.fare is None]
            with_fare.sort(key=lambda o: o.fare)
            without_fare.sort(key=lambda o: o.duration_minutes if o.duration_minutes is not None else 10**9)
            plan.direct_options = with_fare + without_fare
        else:
            plan.direct_options.sort(key=lambda o: o.duration_minutes if o.duration_minutes is not None else 10**9)
    elif preference == "fewest_changes":
        # Direct trains are already 0 changes; just order them by duration
        # among themselves, and alternatives already come after (they all
        # have >=1 hop by construction, sorted shortest-distance first by
        # route_planner already).
        plan.direct_options.sort(key=lambda o: o.duration_minutes if o.duration_minutes is not None else 10**9)

    if not plan.direct_options and not plan.alternative_routes:
        plan.note = f"No direct trains found between {source} and {dest}, and no junction-hopping alternative exists in the curated trunk network either."
    elif not plan.direct_options:
        plan.note = f"No direct trains found between {source} and {dest} — showing junction-hopping alternatives instead."

    return plan


def journey_plan_to_dict(plan: JourneyPlan) -> dict:
    return {
        "source": plan.source, "dest": plan.dest, "date": plan.date,
        "preference": plan.preference, "travel_class": plan.travel_class,
        "direct_options": [
            {
                "train_number": o.train_number, "train_name": o.train_name,
                "departure_time": o.departure_time, "arrival_time": o.arrival_time,
                "duration_minutes": o.duration_minutes, "duration_display": o.duration_display,
                "classes": o.classes, "fare": o.fare, "fare_note": o.fare_note,
            }
            for o in plan.direct_options
        ],
        "alternative_routes": [
            {
                "via_names": r.via_names, "hops": r.hops, "total_distance_km": r.total_distance_km,
                "all_legs_confirmed": r.all_legs_confirmed,
                "legs": [
                    {
                        "from_code": l.from_code, "from_name": l.from_name,
                        "to_code": l.to_code, "to_name": l.to_name,
                        "train_number": l.train_number, "train_name": l.train_name,
                        "departure_time": l.departure_time, "arrival_time": l.arrival_time,
                        "train_found": l.train_found,
                    }
                    for l in r.legs
                ],
            }
            for r in plan.alternative_routes
        ],
        "note": plan.note,
        "fare_note": plan.fare_note,
    }
