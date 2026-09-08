"""
nearby_stations.py
--------------------
FEATURE: Nearby Station Recommendations (Geo-Spatial).

A genuine geo-spatial computation over real data, not a guess: every
station in `data/station_coordinates.json` has a real lat/lng, so "which
stations are near X" is answered with an actual haversine great-circle
distance calculation from X to every other station in the table, sorted
and radius-filtered - not a hardcoded "nearby list" per station.

station_coordinates.json now covers all ~8,700 Indian Railways stations
(see station_search.py's module docstring for where that data came from).
If the anchor station still isn't in the table for some reason, this says
so plainly rather than inventing a location for it or silently returning
an empty list.
"""

import json
import math
import os
from dataclasses import dataclass, field
from typing import List, Optional

_COORDS_PATH = os.path.join(os.path.dirname(__file__), "data", "station_coordinates.json")

with open(_COORDS_PATH, "r", encoding="utf-8") as f:
    _STATION_COORDS = json.load(f)

EARTH_RADIUS_KM = 6371.0


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two lat/lng points, in kilometres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return EARTH_RADIUS_KM * 2 * math.asin(math.sqrt(a))


@dataclass
class NearbyStation:
    code: str
    name: str
    lat: float
    lng: float
    distance_km: float


@dataclass
class NearbyStationsResult:
    anchor_code: Optional[str]
    anchor_name: Optional[str]
    anchor_lat: Optional[float]
    anchor_lng: Optional[float]
    anchor_known: bool
    radius_km: float
    stations: List[NearbyStation] = field(default_factory=list)
    note: Optional[str] = None


def find_nearby_stations(anchor_code: Optional[str], radius_km: float = 150.0, limit: int = 5) -> NearbyStationsResult:
    """
    Finds stations from our curated table within `radius_km` of `anchor_code`,
    sorted nearest-first. If nothing is within the radius, widens the answer
    to "closest N regardless of radius" rather than returning nothing, but
    labels that clearly via `note`.
    """
    code = (anchor_code or "").strip().upper()
    anchor = _STATION_COORDS.get(code)

    if not anchor:
        return NearbyStationsResult(
            anchor_code=code or None, anchor_name=None, anchor_lat=None, anchor_lng=None,
            anchor_known=False, radius_km=radius_km,
            note=(
                f"'{code}' isn't in my curated table of ~{len(_STATION_COORDS)} major stations, "
                "so I can't compute nearby stations for it. Try a major junction code (e.g. NDLS, BZA, SC)."
            ),
        )

    all_distances = []
    for other_code, info in _STATION_COORDS.items():
        if other_code == code:
            continue
        d = haversine_km(anchor["lat"], anchor["lng"], info["lat"], info["lng"])
        all_distances.append(NearbyStation(code=other_code, name=info["name"], lat=info["lat"], lng=info["lng"], distance_km=round(d, 1)))

    all_distances.sort(key=lambda s: s.distance_km)

    within_radius = [s for s in all_distances if s.distance_km <= radius_km]

    result = NearbyStationsResult(
        anchor_code=code, anchor_name=anchor["name"], anchor_lat=anchor["lat"], anchor_lng=anchor["lng"],
        anchor_known=True, radius_km=radius_km,
    )

    if within_radius:
        result.stations = within_radius[:limit]
    else:
        result.stations = all_distances[:limit]
        if all_distances:
            result.note = (
                f"No major stations in my table are within {int(radius_km)} km of {anchor['name']} - "
                f"showing the {min(limit, len(all_distances))} closest ones instead, "
                f"the nearest being {all_distances[0].distance_km} km away."
            )
    return result


def format_nearby_stations(result: NearbyStationsResult) -> str:
    """Plain-text summary for grounding the LLM prompt / no-key fallback view."""
    if not result.anchor_known:
        return result.note or "Could not resolve the anchor station."
    lines = [f"Stations near {result.anchor_name} ({result.anchor_code}):"]
    if result.note:
        lines.append(result.note)
    for s in result.stations:
        lines.append(f"- {s.name} ({s.code}) — {s.distance_km} km away")
    if not result.stations:
        lines.append("No other stations found in the curated table.")
    return "\n".join(lines)
