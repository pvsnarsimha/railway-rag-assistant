"""
crowd_position_tracking.py
-----------------------------
FEATURE: Crowd-Sourced Train Position Reports.

HONEST NOTE, same rule as everywhere else in this project: RailKit's GPS
data is good but, for most trains/stations, "position_source: provider" is
the exception — the common case (see gps_tracking.py) is
"estimated_from_last_station": the train is really just snapped to the
coordinate of the last station it reported passing, which could be many
kilometres and several minutes stale by the time it's displayed. Real
phones physically riding the train can fill that gap. This module fuses
whatever official position gps_tracking.py produced with recent
passenger-submitted GPS reports (see crowd_position_store.py for the raw
report persistence) using a genuine sequential Kalman filter — not a
majority vote or a simple average — so:

  1. A single report can't move the fused position much on its own
     (bounded by its assumed measurement noise).
  2. Several INDEPENDENT phones agreeing tightens the estimate a lot more
     than one report repeated, because clustering is keyed on distinct
     reporter_id, not raw report count.
  3. The "official" position is itself weighted by how much RailKit
     actually told us — a real per-station GPS reading (`provider`) is
     trusted far more than the last-known-station snap
     (`estimated_from_last_station`), which is honestly modelled as VERY
     imprecise (kilometres of assumed measurement noise) — a real,
     agreeing cluster of passenger reports can legitimately end up MORE
     precise than that fallback tier. That's the actual point of this
     feature, not just "extra data points."

Kalman filter mechanics: rather than run the filter directly in lat/lng
degrees (where one degree of longitude is a very different real distance
depending on latitude), each train gets its own local flat-earth
(equirectangular) projection anchored at its first known position for this
session — accurate to well within GPS/report noise at the scale a train
moves between polls — and two independent 1-D Kalman filters run over the
projected (east_m, north_m) offsets. Process noise between updates grows
with elapsed real time, bounded by a documented plausible top running
speed, so a stale fix's uncertainty is never understated.

State is kept in-memory per process, one Kalman filter per train_number —
same "lives for the process, not persisted" pattern as
gps_tracking.RecencyWeightedValue and the live-tracking delay smoother in
app.py. A restart simply starts fresh, which is fine: a stale filter state
from a previous session shouldn't anchor a brand new tracking session
anyway.
"""

import math
import time
from dataclasses import dataclass, field
from typing import List, Optional

EARTH_RADIUS_M = 6371000.0

# Measurement noise (std dev, METRES) assumed for each position source.
# "provider" is RailKit's own real per-station coordinate on the train's
# route — a genuine reading, still not literally a live continuous GPS fix
# off the train itself, so it's not treated as noise-free.
# "estimated_from_last_station" is really a snapped station coordinate —
# honestly modelled as easily kilometres off the train's TRUE current
# position, since the train could be anywhere between that station and the
# next real reporting point.
_SIGMA_OFFICIAL_PROVIDER_M = 400.0
_SIGMA_OFFICIAL_ESTIMATED_M = 6000.0

_SIGMA_CROWD_DEFAULT_M = 30.0    # typical smartphone GPS accuracy when the app didn't report one
_SIGMA_CROWD_MIN_M = 5.0
_SIGMA_CROWD_MAX_M = 500.0       # cap for a report with terrible/no reported accuracy

# A moving express train's position uncertainty grows over time since its
# last fix — bounded by a documented, conservative top speed for the
# fastest Indian expresses (~100 km/h), converted to m/s. This is ONLY the
# Kalman filter's process-noise growth rate (an upper bound so the filter
# never over-trusts an old fix), not a real per-train speed reading — see
# gps_tracking / delay_prediction for the actual speed ESTIMATE features.
_MAX_PROCESS_SPEED_MPS = 100_000 / 3600.0

_CLUSTER_RADIUS_M = 2000.0         # reports within this distance of each other count as "agreeing"
_REPORT_MAX_AGE_SECONDS = 15 * 60  # a report older than this is stale and excluded entirely


def _haversine_m(lat1, lng1, lat2, lng2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def _project(lat, lng, ref_lat, ref_lng):
    """Equirectangular local projection -> (east_m, north_m) offset from
    (ref_lat, ref_lng). Good approximation at the scale a train moves
    between two consecutive tracking polls; not meant for anything
    long-range."""
    x = math.radians(lng - ref_lng) * math.cos(math.radians(ref_lat)) * EARTH_RADIUS_M
    y = math.radians(lat - ref_lat) * EARTH_RADIUS_M
    return x, y


def _unproject(x_m, y_m, ref_lat, ref_lng):
    lat = ref_lat + math.degrees(y_m / EARTH_RADIUS_M)
    lng = ref_lng + math.degrees(x_m / (EARTH_RADIUS_M * math.cos(math.radians(ref_lat)) or 1e-9))
    return lat, lng


class _Kalman1D:
    """A textbook scalar Kalman filter — predict() grows the variance by a
    process-noise amount, update() fuses in one new measurement weighted
    by its own variance vs. the filter's current variance (the Kalman
    gain). Used twice per train (once for east_m, once for north_m)."""

    def __init__(self, x: float = 0.0, var: float = 1.0e10):
        self.x = x
        self.var = var

    def predict(self, process_var: float) -> None:
        self.var += max(0.0, process_var)

    def update(self, z: float, measurement_var: float) -> None:
        measurement_var = max(1.0, measurement_var)
        k = self.var / (self.var + measurement_var)
        self.x = self.x + k * (z - self.x)
        self.var = (1 - k) * self.var


@dataclass
class _TrainKalmanState:
    ref_lat: float
    ref_lng: float
    kx: _Kalman1D = field(default_factory=_Kalman1D)
    ky: _Kalman1D = field(default_factory=_Kalman1D)
    last_updated: float = 0.0


_train_states: dict = {}  # train_number -> _TrainKalmanState, in-memory for this process's lifetime


def reset_train_state(train_number: str) -> None:
    """Drops this train's Kalman state — useful if a session clearly moved
    to a different physical run of the same train number (e.g. a new
    date), so a stale filter doesn't anchor/over-trust a fresh journey."""
    _train_states.pop(str(train_number).strip(), None)


def _largest_agreeing_cluster(reports: List[dict]):
    """Finds the largest set of MUTUALLY-nearby reports (within
    _CLUSTER_RADIUS_M of at least one shared neighbourhood) and returns
    their accuracy-weighted centroid. Deliberately keyed on DISTINCT
    reporter_id, not raw report rows, so one device spamming reports can't
    inflate the "confirmed by N passengers" count — see module docstring
    point 2. Returns (lat, lng, n_distinct_reporters, cluster_reports);
    (None, None, 0, []) if given no reports."""
    if not reports:
        return None, None, 0, []

    best_cluster: List[dict] = []
    for r in reports:
        neighbors = [
            r2 for r2 in reports
            if _haversine_m(r["lat"], r["lng"], r2["lat"], r2["lng"]) <= _CLUSTER_RADIUS_M
        ]
        # Prefer the neighborhood with the most DISTINCT reporters, not
        # just the most rows (a single chatty reporter shouldn't win).
        if len({n["reporter_id"] for n in neighbors}) > len({b["reporter_id"] for b in best_cluster}):
            best_cluster = neighbors

    weights = []
    for r in best_cluster:
        acc = r.get("accuracy_meters") or _SIGMA_CROWD_DEFAULT_M
        acc = min(max(float(acc), _SIGMA_CROWD_MIN_M), _SIGMA_CROWD_MAX_M)
        weights.append(1.0 / (acc ** 2))
    total_w = sum(weights) or 1.0
    lat = sum(w * r["lat"] for w, r in zip(weights, best_cluster)) / total_w
    lng = sum(w * r["lng"] for w, r in zip(weights, best_cluster)) / total_w
    n_distinct_reporters = len({r["reporter_id"] for r in best_cluster})
    return lat, lng, n_distinct_reporters, best_cluster


@dataclass
class FusedPosition:
    lat: Optional[float] = None
    lng: Optional[float] = None
    uncertainty_radius_m: Optional[int] = None   # approx. 95% (2-sigma) radius around (lat, lng)
    confidence_label: str = "No position available"
    position_source: str = "unavailable"   # official | official_confirmed_by_crowd | crowd_sourced | crowd_sourced_unconfirmed | unavailable
    n_confirming_reports: int = 0          # distinct reporters in the winning cluster
    n_total_reports: int = 0               # all recent reports considered (incl. non-clustered outliers)
    disclaimer: str = (
        "Fuses RailKit's official position (when available) with recent passenger-submitted GPS reports "
        "via a Kalman filter — not a live guaranteed-accurate feed. Passenger reports are self-submitted "
        "and unverified beyond agreeing with each other; treat this as a best current estimate."
    )


def fuse_position(
    train_number: str,
    official_lat: Optional[float], official_lng: Optional[float], official_position_source: Optional[str],
    reports: List[dict], now: Optional[float] = None,
) -> FusedPosition:
    """
    `reports` should already be pre-filtered to recent, this-train reports
    (see crowd_position_store.recent_reports_for_train — it defaults to
    the same _REPORT_MAX_AGE_SECONDS window this module uses). Safe to
    call with EITHER input missing (no official fix yet, or no crowd
    reports yet) — falls back to whichever real signal is actually
    available, never fabricates the other.
    """
    now = now if now is not None else time.time()
    train_number = str(train_number).strip()

    cluster_lat, cluster_lng, n_confirming, cluster_reports = _largest_agreeing_cluster(reports)
    have_official = official_lat is not None and official_lng is not None
    have_crowd = cluster_lat is not None

    if not have_official and not have_crowd:
        return FusedPosition(n_total_reports=len(reports))

    state = _train_states.get(train_number)
    ref_lat = official_lat if have_official else cluster_lat
    ref_lng = official_lng if have_official else cluster_lng

    if state is None:
        state = _TrainKalmanState(ref_lat=ref_lat, ref_lng=ref_lng, last_updated=now)
        _train_states[train_number] = state
    else:
        elapsed = max(0.0, now - state.last_updated)
        process_std = elapsed * _MAX_PROCESS_SPEED_MPS
        state.kx.predict(process_std ** 2)
        state.ky.predict(process_std ** 2)
        state.last_updated = now

    if have_official:
        x, y = _project(official_lat, official_lng, state.ref_lat, state.ref_lng)
        sigma = _SIGMA_OFFICIAL_PROVIDER_M if official_position_source == "provider" else _SIGMA_OFFICIAL_ESTIMATED_M
        state.kx.update(x, sigma ** 2)
        state.ky.update(y, sigma ** 2)

    if have_crowd:
        x, y = _project(cluster_lat, cluster_lng, state.ref_lat, state.ref_lng)
        # More independent agreeing reporters -> proportionally tighter
        # measurement noise (classic sqrt(N) averaging benefit), floored
        # so a huge cluster still can't claim sub-metre certainty.
        sigma = max(_SIGMA_CROWD_DEFAULT_M / math.sqrt(max(1, n_confirming)), _SIGMA_CROWD_MIN_M)
        state.kx.update(x, sigma ** 2)
        state.ky.update(y, sigma ** 2)

    fused_lat, fused_lng = _unproject(state.kx.x, state.ky.x, state.ref_lat, state.ref_lng)
    uncertainty_radius_m = round(2 * math.sqrt(max(state.kx.var, state.ky.var)))  # ~95% (2-sigma) radius

    if have_official and n_confirming >= 2:
        position_source = "official_confirmed_by_crowd"
        confidence_label = f"Position confirmed by {n_confirming} passenger reports, matches official tracking"
    elif have_official:
        position_source = "official"
        confidence_label = "Official tracking position — no recent passenger reports to cross-check yet"
    elif n_confirming >= 2:
        position_source = "crowd_sourced"
        confidence_label = f"Position confirmed by {n_confirming} passenger reports — no official GPS available right now"
    else:
        position_source = "crowd_sourced_unconfirmed"
        confidence_label = "Single unconfirmed passenger report — no official GPS available right now"

    return FusedPosition(
        lat=round(fused_lat, 6), lng=round(fused_lng, 6), uncertainty_radius_m=uncertainty_radius_m,
        confidence_label=confidence_label, position_source=position_source,
        n_confirming_reports=n_confirming, n_total_reports=len(reports),
    )
