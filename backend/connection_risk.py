"""
connection_risk.py
-------------------
FEATURE: Connection-Risk Alert.

PNR Tracking and Live Tracking don't otherwise talk to each other in this
app — each is its own tool with its own client-held watchlist. This module
is the one place that cross-references them: given (a) a currently-tracked
train's real predicted/actual arrival at an interchange station, and (b) a
connecting train's real scheduled/predicted departure from that SAME
station, it computes the real buffer between them and classifies the risk
of missing the connection.

Both timing inputs are expected to already be resolved from this app's
existing REAL live-data pipeline (gps_tracking.timeline_to_json entries —
the same per-station arrival/departure dicts the stop-by-stop list and
delay chart already render) — this module does no fetching of its own, it
only compares two already-fetched timings. That keeps it a pure, easily
tested function; the caller in app.py (see /api/advanced/connection-risk)
does the two real live-status fetches (one per train) the same way
_predict_for_watch_station already does for a single train.
"""

from dataclasses import dataclass
from typing import Optional, Tuple

# Below this many minutes of buffer, a connection is "at risk" even if not
# technically already missed — platform-to-platform walking time, ticket
# checks, etc. eat into a nominal buffer fast at a busy Indian junction.
AT_RISK_BUFFER_MINUTES = 15
COMFORTABLE_BUFFER_MINUTES = 30

DISCLAIMER = (
    "Buffer is the gap between this train's own live-predicted/actual arrival and the connecting train's own "
    "live-predicted/actual departure at the same station — it does not account for platform-to-platform walking "
    "distance, which can itself be several minutes at a large junction."
)


def _minutes_from_midnight(hhmm: Optional[str]) -> Optional[int]:
    """'HH:MM' (or the last 5 chars of a longer timestamp) -> minutes since midnight."""
    if not hhmm:
        return None
    s = str(hhmm).strip()[-5:]
    if ":" not in s:
        return None
    try:
        h, m = s.split(":")[:2]
        return int(h) * 60 + int(m)
    except (TypeError, ValueError):
        return None


def _station_arrival_time(entry: Optional[dict]) -> Tuple[Optional[str], Optional[str]]:
    """Best real arrival clock time for a timeline entry + which kind it is
    ('actual' > this app's own live 'predicted' ETA > RailKit's 'expected' >
    bare 'scheduled')."""
    if not entry:
        return None, None
    arrival = entry.get("arrival") or {}
    if arrival.get("actual"):
        return arrival["actual"], "actual"
    if entry.get("predicted_eta"):
        return entry["predicted_eta"], "predicted"
    if arrival.get("expected"):
        return arrival["expected"], "expected"
    if arrival.get("scheduled"):
        return arrival["scheduled"], "scheduled"
    return None, None


def _station_departure_time(entry: Optional[dict]) -> Tuple[Optional[str], Optional[str]]:
    """Best real departure clock time for a timeline entry + which kind it
    is. Falls back to the arrival dict when departure is empty (RailKit
    quirk on some origin-station entries) rather than reporting nothing —
    the same "arrival/departure figures are interchangeable per station
    when only one side is known" convention this app's own per-station
    delay chart already relies on."""
    if not entry:
        return None, None
    departure = entry.get("departure") or {}
    if departure.get("actual"):
        return departure["actual"], "actual"
    if departure.get("expected"):
        return departure["expected"], "expected"
    if departure.get("scheduled"):
        return departure["scheduled"], "scheduled"
    return _station_arrival_time(entry)


@dataclass
class ConnectionRisk:
    found: bool
    risk_level: Optional[str]                    # "missed" | "at_risk" | "tight" | "comfortable"
    buffer_minutes: Optional[int]
    primary_arrival_hhmm: Optional[str]
    primary_arrival_basis: Optional[str]          # "actual" | "predicted" | "expected" | "scheduled"
    connecting_departure_hhmm: Optional[str]
    connecting_departure_basis: Optional[str]
    note: str
    disclaimer: str = DISCLAIMER


def evaluate(primary_entry: Optional[dict], connecting_entry: Optional[dict],
             primary_train_number: str, connecting_train_number: str,
             station_name: Optional[str] = None) -> ConnectionRisk:
    """
    primary_entry / connecting_entry: the matched timeline_json entry (see
    gps_tracking.timeline_to_json + app._match_station_in_timeline) for the
    interchange station, taken from the PRIMARY (currently-tracked) train's
    route and the CONNECTING train's route respectively.
    """
    if primary_entry is None or connecting_entry is None:
        return ConnectionRisk(
            False, None, None, None, None, None, None,
            note="Couldn't find this station on one of the two trains' routes.",
        )

    arrival_hhmm, arrival_basis = _station_arrival_time(primary_entry)
    departure_hhmm, departure_basis = _station_departure_time(connecting_entry)
    arrival_min = _minutes_from_midnight(arrival_hhmm)
    departure_min = _minutes_from_midnight(departure_hhmm)

    if arrival_min is None or departure_min is None:
        return ConnectionRisk(
            True, None, None, arrival_hhmm, arrival_basis, departure_hhmm, departure_basis,
            note="Missing a real timing on one side (arrival or departure) — can't compute a buffer yet.",
        )

    buffer_minutes = departure_min - arrival_min
    if buffer_minutes < -720 or buffer_minutes > 720:
        # Rolled past midnight in one direction (e.g. arrival 23:50,
        # departure 00:10 the same running day) — fold onto a signed
        # +/-12h window instead of a wild ~1430-minute figure.
        buffer_minutes = ((buffer_minutes + 720) % 1440) - 720

    station_phrase = station_name or "this station"
    if buffer_minutes < 0:
        risk_level = "missed"
        note = (
            f"{connecting_train_number} would already have left {station_phrase} before {primary_train_number} "
            f"arrives, by about {abs(buffer_minutes)} min."
        )
    elif buffer_minutes < AT_RISK_BUFFER_MINUTES:
        risk_level = "at_risk"
        note = f"Only ~{buffer_minutes} min between arrival and {connecting_train_number}'s departure — cutting it close."
    elif buffer_minutes < COMFORTABLE_BUFFER_MINUTES:
        risk_level = "tight"
        note = f"~{buffer_minutes} min buffer before {connecting_train_number} departs — workable if you move quickly."
    else:
        risk_level = "comfortable"
        note = f"~{buffer_minutes} min buffer before {connecting_train_number} departs — comfortable."

    return ConnectionRisk(True, risk_level, buffer_minutes, arrival_hhmm, arrival_basis, departure_hhmm, departure_basis, note)


def to_dict(risk: Optional[ConnectionRisk]) -> Optional[dict]:
    if risk is None:
        return None
    return {
        "found": risk.found,
        "risk_level": risk.risk_level,
        "buffer_minutes": risk.buffer_minutes,
        "primary_arrival": risk.primary_arrival_hhmm,
        "primary_arrival_basis": risk.primary_arrival_basis,
        "connecting_departure": risk.connecting_departure_hhmm,
        "connecting_departure_basis": risk.connecting_departure_basis,
        "note": risk.note,
        "disclaimer": risk.disclaimer,
    }
