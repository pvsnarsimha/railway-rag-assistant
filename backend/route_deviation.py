"""
route_deviation.py
-------------------
FEATURE: Route-Deviation / Diversion Detection.

Distinct from reroute_suggestions.py (which reacts to the PASSENGER'S plan
when the train is severely delayed — "should I get off and switch trains
here" — a planning suggestion). This instead watches whether the train
ITSELF is running on a genuinely different physical path than its own
scheduled route right now — a real diversion, which floods, protests, and
maintenance blocks cause often on Indian Railways.

METHOD (honestly a straight-line approximation, stated plainly, never
oversold): the "expected route" here is the polyline formed by connecting
this train's own scheduled stations, in order, with straight lines — built
from the SAME per-station lat/lng already resolved onto the live timeline
(gps_tracking.parse_full_timeline -> timeline_to_json), not a second/
separate route-geometry source this project doesn't have. Real Indian
Railways track curves between two stations that are, say, 40km apart by
rail — a straight chord between their coordinates can already sit several
km off the real curved track under completely NORMAL running, before any
diversion at all. So:
  - the deviation threshold is deliberately generous (DEFAULT_THRESHOLD_KM)
    to avoid flagging ordinary track curvature as a "diversion", and
  - a single over-threshold GPS ping is never enough on its own — only a
    SUSTAINED deviation (continuously over DEFAULT_SUSTAIN_SECONDS of polls)
    is reported as "likely genuine", filtering one-off GPS/interpolation
    noise the same way the rest of this app's live-tracking smoothers do.
This can occasionally miss a real short diversion loop that reconnects to
the route quickly, and can occasionally misfire on a legitimately curvy
stretch between two widely-spaced stations — `disclaimer` below says this
plainly rather than presenting the flag as certain.
"""

from dataclasses import dataclass
from datetime import datetime
from math import radians, sin, cos, atan2, sqrt
from typing import List, Optional, Tuple

EARTH_RADIUS_KM = 6371.0088
DEFAULT_THRESHOLD_KM = 8.0
DEFAULT_SUSTAIN_SECONDS = 90.0

DISCLAIMER = (
    "Deviation is measured against straight lines between this train's own scheduled stations, not the "
    "real curved track — normal running can already sit a few km off that line on widely-spaced stretches, "
    "so only a SUSTAINED gap this large counts as a likely diversion, not a certain one. Always confirm "
    "with an official announcement or the on-board crew before assuming a genuine reroute."
)


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    lat1, lng1, lat2, lng2 = map(radians, [lat1, lng1, lat2, lng2])
    dlat, dlng = lat2 - lat1, lng2 - lng1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_KM * atan2(sqrt(a), sqrt(1 - a))


def _point_to_segment_km(p_lat: float, p_lng: float, a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    """
    Approximate perpendicular distance from point P to segment A-B, in km.
    Projects onto an equirectangular plane local to this one segment (fine
    at the scale of the few-hundred-km gap between two adjacent stations —
    not meant as survey-grade global geometry) rather than exact
    great-circle segment math, since this only needs "accurate to a few
    km", not precise track distance.
    """
    lat0 = radians((a_lat + b_lat) / 2.0)
    kx = EARTH_RADIUS_KM * cos(lat0)  # km per radian of longitude at this latitude
    ky = EARTH_RADIUS_KM             # km per radian of latitude

    ax, ay = radians(a_lng) * kx, radians(a_lat) * ky
    bx, by = radians(b_lng) * kx, radians(b_lat) * ky
    px, py = radians(p_lng) * kx, radians(p_lat) * ky

    dx, dy = bx - ax, by - ay
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq < 1e-9:
        return _haversine_km(p_lat, p_lng, a_lat, a_lng)
    t = ((px - ax) * dx + (py - ay) * dy) / seg_len_sq
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return sqrt((px - cx) ** 2 + (py - cy) ** 2)


@dataclass
class RouteDeviationReading:
    off_route: bool                             # this SINGLE poll's raw reading, unfiltered
    distance_from_route_km: Optional[float]
    nearest_segment: Optional[Tuple[Optional[str], Optional[str]]]  # (station_code_a, station_code_b)


def evaluate_point(lat: Optional[float], lng: Optional[float], route_points: List[dict],
                    threshold_km: float = DEFAULT_THRESHOLD_KM) -> RouteDeviationReading:
    """
    route_points: ordered list of {"code", "name", "lat", "lng"} for every
    station on this train's own live timeline (see gps_tracking.timeline_to_json)
    — points missing real lat/lng are skipped, never guessed. Returns the
    single closest distance from (lat, lng) to any segment of that polyline.
    """
    if lat is None or lng is None:
        return RouteDeviationReading(False, None, None)
    pts = [p for p in (route_points or []) if p.get("lat") is not None and p.get("lng") is not None]
    if len(pts) < 2:
        return RouteDeviationReading(False, None, None)

    best_dist = None
    best_pair = None
    for a, b in zip(pts, pts[1:]):
        try:
            d = _point_to_segment_km(lat, lng, a["lat"], a["lng"], b["lat"], b["lng"])
        except (TypeError, ValueError):
            continue
        if best_dist is None or d < best_dist:
            best_dist = d
            best_pair = (a.get("code"), b.get("code"))
    if best_dist is None:
        return RouteDeviationReading(False, None, None)
    return RouteDeviationReading(best_dist > threshold_km, best_dist, best_pair)


class DeviationSustainTracker:
    """
    Tracks how long the train has been reading CONTINUOUSLY off-route, so a
    single noisy GPS/interpolation ping doesn't flip the flag. Lives for the
    lifetime of one websocket connection (same "plain locals for this
    session only" pattern as gps_tracking.RecencyWeightedSpeed in
    app.py's ws_track_train) — a fresh connection has no prior reading to
    carry over, so it starts clean.
    """

    def __init__(self, sustain_seconds: float = DEFAULT_SUSTAIN_SECONDS):
        self.sustain_seconds = sustain_seconds
        self._since: Optional[datetime] = None

    def update(self, off_route_now: bool, now: datetime) -> Tuple[bool, float]:
        if not off_route_now:
            self._since = None
            return False, 0.0
        if self._since is None:
            self._since = now
        elapsed = (now - self._since).total_seconds()
        return elapsed >= self.sustain_seconds, elapsed


@dataclass
class RouteDeviationStatus:
    likely_diversion: bool                      # the SUSTAINED flag — the one worth alerting on
    off_route_now: bool                          # this poll's raw reading (can flicker on noise)
    distance_from_route_km: Optional[float]
    nearest_segment: Optional[Tuple[Optional[str], Optional[str]]]
    sustained_seconds: float
    threshold_km: float
    note: str
    disclaimer: str = DISCLAIMER


def build_status(reading: RouteDeviationReading, likely_diversion: bool, sustained_seconds: float,
                  threshold_km: float = DEFAULT_THRESHOLD_KM) -> RouteDeviationStatus:
    if likely_diversion:
        note = (
            f"This train has been running ~{round(reading.distance_from_route_km, 1)} km off its usual route "
            f"for over {int(sustained_seconds // 60)} min {int(sustained_seconds % 60)}s — likely a genuine "
            "diversion (floods, protests, or a maintenance block), not just GPS noise."
        )
    elif reading.off_route:
        note = (
            f"Reading ~{round(reading.distance_from_route_km, 1)} km off the usual route just now — "
            "watching to see if this sticks before calling it a diversion."
        )
    else:
        note = "Running on its usual route."
    return RouteDeviationStatus(
        likely_diversion=likely_diversion, off_route_now=reading.off_route,
        distance_from_route_km=reading.distance_from_route_km, nearest_segment=reading.nearest_segment,
        sustained_seconds=sustained_seconds, threshold_km=threshold_km, note=note,
    )


def to_dict(status: Optional[RouteDeviationStatus]) -> Optional[dict]:
    if status is None:
        return None
    return {
        "likely_diversion": status.likely_diversion,
        "off_route_now": status.off_route_now,
        "distance_from_route_km": round(status.distance_from_route_km, 1) if status.distance_from_route_km is not None else None,
        "nearest_segment": list(status.nearest_segment) if status.nearest_segment else None,
        "sustained_seconds": round(status.sustained_seconds, 0),
        "threshold_km": status.threshold_km,
        "note": status.note,
        "disclaimer": status.disclaimer,
    }
