"""
pnr_tracking.py
------------------
FEATURE: PNR Auto-Tracking & Status Change Alerts.

Turns a raw railway_api.get_pnr_status() response into a clean structured
summary (extract_pnr_summary) using deep_extract.py's recursive field
search — a real PNR lookup came back with every top-level field unmatched
even though the provider clearly returned real data, meaning RailKit
nests these fields under a wrapper object rather than at the top level;
deep_find/deep_find_list_of_dicts walk the FULL nested structure instead
of guessing a fixed depth. Still never invents a value - a field that
genuinely isn't anywhere in the response stays None. `raw_keys` on the
response carries the response's own real top-level key names purely as a
debugging aid, in case a field is still unmatched after this.


The "auto-tracking" itself is a client-held watchlist (same pattern as
the existing Delay Alerts tool): check_pnr_watchlist() batch-refreshes a
list of PNRs the client already holds and, for each, compares the CURRENT
real status text against a `last_known_status` the client passed back in,
so the frontend/mobile can flag "status changed since you last checked".
Same honesty note as Delay Alerts: this is real, on-demand in-app
checking triggered when the user opens the tool or pulls to refresh -
there is no background push infrastructure in this project (that would
need EAS Build + the user's own FCM/APNs credentials).
"""

from dataclasses import dataclass, field
from typing import Callable, List, Optional

from deep_extract import deep_find, deep_find_list_of_dicts, top_level_keys


@dataclass
class PassengerStatus:
    number: Optional[int] = None
    current_status: Optional[str] = None
    coach: Optional[str] = None
    berth: Optional[str] = None
    booking_status: Optional[str] = None


@dataclass
class PNRSummary:
    pnr: str
    train_number: Optional[str] = None
    train_name: Optional[str] = None
    date_of_journey: Optional[str] = None
    from_station: Optional[str] = None
    to_station: Optional[str] = None
    chart_prepared: Optional[bool] = None
    travel_class: Optional[str] = None
    passengers: List[PassengerStatus] = field(default_factory=list)
    overall_status_text: Optional[str] = None
    raw_available: bool = True
    raw_keys: List[str] = field(default_factory=list)  # debugging aid, see deep_extract.py


def extract_pnr_summary(pnr: str, data: dict) -> PNRSummary:
    if not isinstance(data, dict):
        return PNRSummary(pnr=pnr, raw_available=False)
    payload = data.get("data", data)
    if not isinstance(payload, dict):
        return PNRSummary(pnr=pnr, raw_available=False)

    summary = PNRSummary(
        pnr=pnr,
        train_number=deep_find(payload, ["trainNumber", "train_no", "trainNo", "trainnumber", "number"]),
        train_name=deep_find(payload, ["trainName", "train_name", "name"]),
        date_of_journey=deep_find(payload, ["dateOfJourney", "doj", "date_of_journey", "journeyDate"]),
        from_station=deep_find(payload, ["fromStation", "from_stn_name", "boardingPoint", "boardingStation", "from", "sourceStation", "fromStationName", "origin"]),
        to_station=deep_find(payload, ["toStation", "to_stn_name", "reservationUpto", "destinationStation", "to", "destinationStationName", "destination"]),
        travel_class=deep_find(payload, ["class", "journeyClass", "travelClass", "classOfTravel"]),
        raw_keys=top_level_keys(data),
    )

    chart = deep_find(payload, ["chartPrepared", "chart_prepared", "chartStatus", "isChartPrepared"])
    if isinstance(chart, str):
        summary.chart_prepared = chart.strip().lower() in ("yes", "true", "1", "prepared")
    elif isinstance(chart, bool):
        summary.chart_prepared = chart

    raw_passengers = deep_find_list_of_dicts(payload, [
        "passengerList", "passengers", "passenger_status", "passengerDetails", "paxList", "passengerInfo",
    ])
    for i, p in enumerate(raw_passengers, start=1):
        if not isinstance(p, dict):
            continue
        summary.passengers.append(PassengerStatus(
            number=deep_find(p, ["number", "passengerSerialNumber", "serialNo", "passengerNo"], default=i),
            current_status=deep_find(p, ["currentStatus", "current_status", "status", "predictionCurrentStatus"]),
            coach=deep_find(p, ["coach", "coachId", "coachPosition"]),
            berth=deep_find(p, ["berth", "berthNo", "berthNumber"]),
            booking_status=deep_find(p, ["bookingStatus", "booking_status", "currentBookingStatus"]),
        ))

    if summary.passengers:
        p1 = summary.passengers[0]
        bits = [str(b) for b in (p1.current_status, p1.coach, p1.berth) if b]
        summary.overall_status_text = "/".join(bits) if bits else p1.current_status
    else:
        summary.overall_status_text = deep_find(payload, ["currentStatus", "status", "chartStatus", "pnrStatus"])

    return summary


def pnr_summary_to_dict(s: PNRSummary) -> dict:
    return {
        "pnr": s.pnr, "train_number": s.train_number, "train_name": s.train_name,
        "date_of_journey": s.date_of_journey, "from_station": s.from_station, "to_station": s.to_station,
        "chart_prepared": s.chart_prepared, "class": s.travel_class,
        "passengers": [
            {"number": p.number, "current_status": p.current_status, "coach": p.coach,
             "berth": p.berth, "booking_status": p.booking_status}
            for p in s.passengers
        ],
        "overall_status_text": s.overall_status_text,
        "raw_available": s.raw_available,
        "raw_keys": s.raw_keys,
    }


def check_pnr_watchlist(entries: List[dict], fetcher: Callable[[str], dict]) -> List[dict]:
    """entries: [{pnr, last_known_status, label}, ...] held client-side.
    fetcher: callable(pnr) -> raw get_pnr_status() response, so the
    caller (app.py) controls the real railway_api call and its own
    try/except per PNR. Capped at 10 PNRs per request, same cap pattern
    as the existing Delay Alerts checker. Returns one row per entry with
    the current real summary plus `status_changed` - a plain string
    comparison against what the client says it last saw, never inferred."""
    out = []
    for entry in entries[:10]:
        pnr = (entry.get("pnr") or "").strip()
        label = entry.get("label")
        last_known = entry.get("last_known_status")
        row = {"pnr": pnr, "label": label, "last_known_status": last_known}
        try:
            data = fetcher(pnr)
            summary = extract_pnr_summary(pnr, data)
            row.update(pnr_summary_to_dict(summary))
            row["status_changed"] = bool(last_known) and bool(summary.overall_status_text) and (last_known != summary.overall_status_text)
        except Exception as e:
            row["error"] = str(e)
        out.append(row)
    return out
