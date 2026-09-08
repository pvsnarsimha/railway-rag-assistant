"""
alt_transport.py
-------------------
FEATURE: Trip Planning with Alternative Transport (Bus/Flight).

Current State (before this module): journey_planner.py plans a journey from
REAL direct trains plus route_planner.py's real junction-hopping trunk-
corridor graph — but if genuinely nothing comes back (no direct trains, no
graph-connected alternative), the app had nothing left to offer beyond "no
trains found."

What this module adds: when a train journey plan comes up empty (or a
caller otherwise wants a mode comparison), it suggests bus and/or flight as
the next-best real-world options — grounded in the same kind of REAL,
curated geo-data the rest of this project uses (not a live bus/flight
booking API this project has no access to):

  - A genuine haversine great-circle distance between the two stations
    (same `nearby_stations.haversine_km` calculation route_planner and
    nearby_stations already use), which is what actually decides whether
    bus or flight is the sensible suggestion — a real number, not a guess.
  - `data/major_airports.json`: a small, hand-curated table (same "~50
    honestly-labelled major stations" pattern as station_coordinates.json)
    mapping a station to its REAL nearest major commercial airport (IATA
    code, name, real lat/lng) — when both ends resolve, the real distance
    from each station to its own airport is also computed the same honest
    way, so "how far is the airport" is never invented either.

HONEST LIMIT (stated plainly, same rule as everywhere else in this
project): this app has no bus operator or flight-booking integration of
any kind. There is no live schedule, seat, or fare data for either mode —
this module only ever tells you WHICH mode is realistic for the distance
involved and WHERE to look (a state road transport corporation / bus
aggregator, or any flight-search site/app), never a specific bus number,
flight number, time, or price. If a station/city isn't in the curated
airport table, that's said plainly (`dest_airport: null` etc.) rather than
guessing the nearest airport.
"""

import json
import os
from dataclasses import dataclass, field
from typing import Optional

from nearby_stations import haversine_km

_COORDS_PATH = os.path.join(os.path.dirname(__file__), "data", "station_coordinates.json")
_AIRPORTS_PATH = os.path.join(os.path.dirname(__file__), "data", "major_airports.json")

with open(_COORDS_PATH, "r", encoding="utf-8") as f:
    _STATION_COORDS = json.load(f)

with open(_AIRPORTS_PATH, "r", encoding="utf-8") as f:
    _MAJOR_AIRPORTS = json.load(f)

# Below this real distance, a bus is a genuinely practical alternative
# (a few hours on the road) — above it, flying is the practical one. The
# two bands OVERLAP (300-450 km) because both are realistic in that range
# and the honest answer is "depends how much time you have," not a single
# hard cutoff.
_BUS_MAX_KM = 450.0
_FLIGHT_MIN_KM = 300.0


@dataclass
class AirportInfo:
    code: str
    iata: str
    name: str
    city: str
    lat: float
    lng: float
    distance_from_station_km: Optional[float] = None


@dataclass
class AltTransportSuggestion:
    source_code: str
    dest_code: str
    rail_distance_km: Optional[float] = None
    distance_known: bool = False
    bus_recommended: bool = False
    flight_recommended: bool = False
    source_airport: Optional[AirportInfo] = None
    dest_airport: Optional[AirportInfo] = None
    guidance: list = field(default_factory=list)   # list of {"mode": "bus"|"flight", "text": str}
    note: Optional[str] = None
    disclaimer: str = (
        "This app has no bus or flight booking integration — no live schedule, seat, or "
        "fare data for either mode. This is only a distance-based pointer to which mode is "
        "realistic and where to look, never a specific bus/flight number, time, or price."
    )


def _station_point(code: Optional[str]):
    if not code:
        return None
    return _STATION_COORDS.get(code.strip().upper())


def _airport_for(code: Optional[str]) -> Optional[AirportInfo]:
    if not code:
        return None
    code = code.strip().upper()
    entry = _MAJOR_AIRPORTS.get(code)
    if not entry:
        return None
    station = _STATION_COORDS.get(code)
    dist = None
    if station and station.get("lat") is not None:
        dist = round(haversine_km(station["lat"], station["lng"], entry["lat"], entry["lng"]), 1)
    return AirportInfo(
        code=code, iata=entry["iata"], name=entry["name"], city=entry["city"],
        lat=entry["lat"], lng=entry["lng"], distance_from_station_km=dist,
    )


def suggest_alternative_transport(source_code: Optional[str], dest_code: Optional[str]) -> AltTransportSuggestion:
    source_code = (source_code or "").strip().upper()
    dest_code = (dest_code or "").strip().upper()
    result = AltTransportSuggestion(source_code=source_code, dest_code=dest_code)

    src_pt = _station_point(source_code)
    dst_pt = _station_point(dest_code)

    if src_pt and dst_pt:
        result.rail_distance_km = round(haversine_km(src_pt["lat"], src_pt["lng"], dst_pt["lat"], dst_pt["lng"]), 1)
        result.distance_known = True
    else:
        missing = []
        if not src_pt:
            missing.append(source_code or "source")
        if not dst_pt:
            missing.append(dest_code or "destination")
        result.note = (
            f"{' and '.join(missing)} isn't in the curated {len(_STATION_COORDS)}-station coordinate table, so a real "
            "distance couldn't be computed — bus/flight suitability can't be judged without it."
        )
        return result

    result.bus_recommended = result.rail_distance_km <= _BUS_MAX_KM
    result.flight_recommended = result.rail_distance_km >= _FLIGHT_MIN_KM

    src_name = src_pt.get("name", source_code)
    dst_name = dst_pt.get("name", dest_code)

    if result.bus_recommended:
        result.guidance.append({
            "mode": "bus",
            "text": (
                f"~{result.rail_distance_km} km by road is a realistic intercity bus trip "
                f"({src_name} → {dst_name}) — check your state road transport corporation "
                "(e.g. an RTC/SRTC Volvo/AC service) or a bus aggregator for real timings, "
                "seats, and fare; none of that is available inside this app."
            ),
        })

    if result.flight_recommended:
        result.source_airport = _airport_for(source_code)
        result.dest_airport = _airport_for(dest_code)
        if result.source_airport and result.dest_airport:
            result.guidance.append({
                "mode": "flight",
                "text": (
                    f"~{result.rail_distance_km} km is realistic to fly — nearest major airports: "
                    f"{result.source_airport.name} ({result.source_airport.iata}, "
                    f"~{result.source_airport.distance_from_station_km} km from {src_name}) and "
                    f"{result.dest_airport.name} ({result.dest_airport.iata}, "
                    f"~{result.dest_airport.distance_from_station_km} km from {dst_name}). "
                    "Check a flight-search site/app for real schedules and fares — not available in this app."
                ),
            })
        else:
            missing_airport = []
            if not result.source_airport:
                missing_airport.append(src_name)
            if not result.dest_airport:
                missing_airport.append(dst_name)
            result.guidance.append({
                "mode": "flight",
                "text": (
                    f"~{result.rail_distance_km} km is realistic to fly, but this app doesn't have a curated "
                    f"nearby-airport entry for {' and '.join(missing_airport)} — search a flight-search "
                    "site/app for the nearest airport(s) instead."
                ),
            })

    if not result.guidance:
        # Shouldn't normally happen given the two thresholds overlap and
        # cover [0, inf), but never leave a silent empty result.
        result.note = f"~{result.rail_distance_km} km — no bus/flight guidance could be determined for this distance."

    return result


def to_dict(s: AltTransportSuggestion) -> dict:
    def _airport_dict(a: Optional[AirportInfo]):
        if a is None:
            return None
        return {
            "code": a.code, "iata": a.iata, "name": a.name, "city": a.city,
            "lat": a.lat, "lng": a.lng, "distance_from_station_km": a.distance_from_station_km,
        }
    return {
        "source_code": s.source_code, "dest_code": s.dest_code,
        "rail_distance_km": s.rail_distance_km, "distance_known": s.distance_known,
        "bus_recommended": s.bus_recommended, "flight_recommended": s.flight_recommended,
        "source_airport": _airport_dict(s.source_airport), "dest_airport": _airport_dict(s.dest_airport),
        "guidance": s.guidance, "note": s.note, "disclaimer": s.disclaimer,
    }
