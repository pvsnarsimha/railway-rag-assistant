"""
reroute_suggestions.py
-------------------------
FEATURE: Dynamic Re-route Suggestions During Live Tracking.

Current State (before this module): the Live Tracking panel/screen streams
a train's real-time position, delay, and ML-predicted delay (see app.py's
`/ws/track` handler + gps_tracking.py) — but a passenger watching their
train run an hour late had nothing more actionable to do with that number
than keep watching it grow.

What this module adds: when a tracked train's delay (predicted, or real
reported delay as a fallback — see `delay_source`) crosses a severity
threshold, it proactively looks up REAL alternative trains from the next
scheduled halt ("the next junction" — a genuine upcoming reporting station
on the train's own live timeline, never a small non-halting intermediate
point) onward to the train's own final destination (also read straight off
its live timeline, never guessed). The idea: "you're 90 minutes late — if
you get off at the next station, here's what else actually runs from there
to where you're going."

Same honesty rules as the rest of this project:
  - The threshold, the delay figure it was measured against, and which
    figure was used (predicted vs. reported) are always stated plainly —
    never a silent "trust me" trigger.
  - Alternatives are only ever REAL trains from a real, live
    railway_api.search_trains_between_stations() lookup — parsed the exact
    same way journey_planner.py and the Search Trains tool already do,
    never invented. If none are found, this says so and — same as
    journey_planner — falls back to route_planner's real k-shortest-paths
    junction-hopping graph rather than a dead end, clearly labelled as
    "a corridor exists" rather than "a specific train runs there".
  - This is explicitly NOT a booking/refund/ticket-change action of any
    kind (this project has no ticketing integration at all) — the
    disclaimer says so on every triggered response, so it's never mistaken
    for "the app rebooked you."
  - No live-status call is made by this module itself — it works off the
    same live timeline app.py's `/ws/track` loop already fetched this poll
    (current delay + next reporting halt + final destination), so
    triggering this doesn't cost an extra RailKit call. The one live call
    it DOES make (search_trains_between_stations) is already cached for
    6 hours by railway_api.py, so repeated polls while a delay stays severe
    don't hammer the provider either.
"""

from dataclasses import dataclass, field
from typing import List, Optional

import railway_api
import route_planner
import trains_between

# "Severely delayed" — same spirit as the worked example in the feature
# request ("if a train is 3 hours late..."), but set low enough (1 hour) to
# actually be useful before a passenger's alternatives at the next junction
# have ALSO mostly departed. Callers (the /ws/track query param
# `reroute_threshold_minutes`) can override this per connection.
SEVERE_DELAY_THRESHOLD_MINUTES_DEFAULT = 60

# How many real alternative trains / junction-hopping routes to surface —
# enough to be a genuine choice, not an overwhelming list.
_MAX_DIRECT_ALTERNATIVES = 4
_MAX_ALTERNATIVE_ROUTES = 2


@dataclass
class AlternativeTrain:
    train_number: str
    train_name: str
    departure_time: Optional[str]
    arrival_time: Optional[str]
    classes: List[str] = field(default_factory=list)


@dataclass
class RerouteSuggestion:
    triggered: bool = False
    threshold_minutes: int = SEVERE_DELAY_THRESHOLD_MINUTES_DEFAULT
    delay_minutes_used: Optional[int] = None
    delay_source: Optional[str] = None       # "predicted" | "reported"
    junction_code: Optional[str] = None
    junction_name: Optional[str] = None
    destination_code: Optional[str] = None
    destination_name: Optional[str] = None
    direct_alternatives: List[AlternativeTrain] = field(default_factory=list)
    # Junction-hopping fallback (route_planner's real graph) — only ever
    # populated when NO direct alternative train was found, same "only
    # reach for the graph fallback when the simple real lookup comes up
    # empty" order journey_planner.py already uses.
    alternative_routes: list = field(default_factory=list)
    note: Optional[str] = None
    disclaimer: Optional[str] = None


_DISCLAIMER = (
    "These are real trains found for the route from your next scheduled stop to your "
    "destination — not a guarantee of an available seat, and this app has no ticketing "
    "integration, so it can't change or refund your current ticket for you. Compare the "
    "departure time shown against this train's own current ETA to that stop (above) before "
    "deciding whether you can actually make the connection."
)


def compute_reroute_suggestions(
    next_junction_code: Optional[str], next_junction_name: Optional[str],
    destination_code: Optional[str], destination_name: Optional[str],
    delay_minutes_used: Optional[int], delay_source: Optional[str],
    date_ddmmyyyy: Optional[str] = None,
    threshold_minutes: int = SEVERE_DELAY_THRESHOLD_MINUTES_DEFAULT,
) -> RerouteSuggestion:
    """
    Pure-ish (one possible real network call) computation — no caching of
    its own beyond what railway_api.search_trains_between_stations already
    provides (6h TTL), so callers (app.py's /ws/track loop) can call this
    every poll once a train is running severely late without it turning
    into a fresh provider hit each time.
    """
    threshold_minutes = max(1, int(threshold_minutes or SEVERE_DELAY_THRESHOLD_MINUTES_DEFAULT))
    result = RerouteSuggestion(
        threshold_minutes=threshold_minutes,
        delay_minutes_used=delay_minutes_used, delay_source=delay_source,
        junction_code=next_junction_code, junction_name=next_junction_name,
        destination_code=destination_code, destination_name=destination_name,
    )

    if delay_minutes_used is None:
        result.note = "No real delay figure available yet — can't judge whether a re-route is worth suggesting."
        return result

    if delay_minutes_used < threshold_minutes:
        result.note = (
            f"Running {delay_minutes_used} min late ({delay_source}) — under the "
            f"{threshold_minutes}-min threshold, so no re-route suggested yet."
        )
        return result

    result.triggered = True
    result.disclaimer = _DISCLAIMER

    if not next_junction_code or not destination_code:
        result.note = (
            f"Running {delay_minutes_used} min late ({delay_source}) — but the next scheduled stop or "
            "the final destination isn't known yet from the live timeline, so no re-route can be looked up."
        )
        return result

    if next_junction_code == destination_code:
        result.note = (
            f"Running {delay_minutes_used} min late ({delay_source}) — but the next stop IS the final "
            "destination, so there's no onward leg left to re-route."
        )
        return result

    try:
        live_data = railway_api.search_trains_between_stations(next_junction_code, destination_code, date_ddmmyyyy)
    except railway_api.RailwayAPIError as e:
        result.note = (
            f"Running {delay_minutes_used} min late ({delay_source}) — couldn't look up alternatives from "
            f"{next_junction_name or next_junction_code} to {destination_name or destination_code} right now: {e}"
        )
        return result

    trains = trains_between.parse_trains_list(live_data)
    for t in trains[:_MAX_DIRECT_ALTERNATIVES]:
        result.direct_alternatives.append(AlternativeTrain(
            train_number=t.train_number, train_name=t.train_name,
            departure_time=t.source_departure, arrival_time=t.dest_arrival,
            classes=t.classes or [],
        ))

    if result.direct_alternatives:
        result.note = (
            f"Running {delay_minutes_used} min late ({delay_source}). If you get off at "
            f"{next_junction_name or next_junction_code}, here's what else runs from there to "
            f"{destination_name or destination_code}."
        )
        return result

    # No direct train found for that leg — fall back to route_planner's
    # real junction-hopping graph, same order journey_planner.py uses,
    # clearly labelled as "a corridor exists", never a guessed train.
    plan = route_planner.find_alternative_routes(next_junction_code, destination_code, k=_MAX_ALTERNATIVE_ROUTES)
    for opt in plan.options:
        if opt.is_direct_corridor:
            continue
        result.alternative_routes.append({
            "via_names": opt.station_names, "hops": opt.hops,
            "total_distance_km": opt.total_distance_km,
        })

    if result.alternative_routes:
        result.note = (
            f"Running {delay_minutes_used} min late ({delay_source}). No single direct train found from "
            f"{next_junction_name or next_junction_code} to {destination_name or destination_code} right now — "
            "these junction-hopping corridors exist, but no specific onward train is confirmed for every leg."
        )
    else:
        extra = f" {plan.note}" if plan.note else ""
        result.note = (
            f"Running {delay_minutes_used} min late ({delay_source}) — no confirmed alternative trains found "
            f"from {next_junction_name or next_junction_code} to {destination_name or destination_code} "
            f"right now.{extra}"
        )
    return result


def to_dict(r: RerouteSuggestion) -> dict:
    return {
        "triggered": r.triggered,
        "threshold_minutes": r.threshold_minutes,
        "delay_minutes_used": r.delay_minutes_used,
        "delay_source": r.delay_source,
        "junction_code": r.junction_code,
        "junction_name": r.junction_name,
        "destination_code": r.destination_code,
        "destination_name": r.destination_name,
        "direct_alternatives": [
            {
                "train_number": a.train_number, "train_name": a.train_name,
                "departure_time": a.departure_time, "arrival_time": a.arrival_time,
                "classes": a.classes,
            }
            for a in r.direct_alternatives
        ],
        "alternative_routes": r.alternative_routes,
        "note": r.note,
        "disclaimer": r.disclaimer,
    }
