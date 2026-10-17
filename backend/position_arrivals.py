"""
position_arrivals.py

The data providers (RailKit / RailRadar) often record a station's real
arrival/departure only 20-30 minutes AFTER the train was there; until then
the stop keeps showing its timetable times. The train's own live position
(RailRadar GPS, same distance-from-origin the rest of Live Tracking uses) is
fresher, so when it reaches a halt we stamp the observed clock time as that
stop's arrival, and again as its departure once the train is clearly past.

Provider-recorded actuals always win: a stop that already has a real
(actual_is_predicted=False, not from us) time is left untouched and any
inferred value for it is dropped.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

# Train counts as AT a halt from this far before it to ...
ARRIVE_WITHIN_KM = 0.3
# ... until it is this far beyond it (platform + yard length).
DEPART_BEYOND_KM = 1.0

SOURCE = "position"


def _ist_hhmm(now: Optional[datetime] = None) -> str:
    now = now or (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30))
    return now.strftime("%H:%M")


def _hhmm_minutes(v) -> Optional[int]:
    try:
        h, m = str(v).strip()[:5].split(":")
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


def _delay(actual: str, event: dict) -> Optional[int]:
    anchor = _hhmm_minutes(event.get("expected") or event.get("scheduled"))
    act = _hhmm_minutes(actual)
    if anchor is None or act is None:
        return None
    diff = act - anchor
    if diff < -720:
        diff += 1440
    elif diff > 720:
        diff -= 1440
    return max(0, min(400, diff))


def _provider_has_real(event) -> bool:
    return (isinstance(event, dict) and bool(event.get("actual"))
            and event.get("actual_is_predicted") is False
            and event.get("actual_source") != SOURCE)


def _stamp(event: dict, actual: str) -> None:
    event["actual"] = actual
    delay = _delay(actual, event)
    if delay is not None:
        event["delay_minutes"] = delay
    event["actual_is_predicted"] = False
    event["actual_source"] = SOURCE


def infer_position_arrivals(timeline_json: list, current_km: Optional[float],
                            observed: dict, now: Optional[datetime] = None) -> None:
    """Mutates timeline_json in place. `observed` is a connection-scoped dict
    (code -> {"arr": "HH:MM", "dep": "HH:MM"|None}) so the times observed
    first stay fixed on later polls. Only stops seen AHEAD of the train on an
    earlier poll are stamped; anything already behind it when tracking began
    keeps the provider's own times."""
    if current_km is None or not timeline_json:
        return
    from gps_tracking import _distance_km_value  # local: avoid import cycle

    clock = _ist_hhmm(now)
    for stop in timeline_json:
        if stop.get("kind") == "intermediate":
            continue
        code = (stop.get("code") or "").strip().upper()
        stop_km = _distance_km_value(stop.get("distance_km"))
        arrival, departure = stop.get("arrival"), stop.get("departure")
        if not code or stop_km is None or not isinstance(arrival, dict):
            continue
        if _provider_has_real(arrival):
            observed.pop(code, None)
            continue
        if current_km < stop_km - ARRIVE_WITHIN_KM:
            # Still ahead: remember we saw it that way, so a later arrival is
            # one we actually watched happen.
            observed.setdefault(code, {"before": True})
            continue
        rec = observed.get(code)
        if rec is None:
            # First seen with the train already at/past it (page opened
            # mid-journey, or the origin): the real moment is unknown, so
            # leave the provider's times alone rather than stamp "now".
            observed[code] = {"skip": True}
            continue
        if rec.get("skip"):
            continue
        if rec.get("before"):
            rec.pop("before")
            rec.update(arr=clock, dep=None)
        _stamp(arrival, rec["arr"])
        beyond = current_km >= stop_km + DEPART_BEYOND_KM
        if beyond and rec["dep"] is None:
            rec["dep"] = clock
        stop["status"] = "passed" if beyond else "current"
        if beyond and isinstance(departure, dict) and not _provider_has_real(departure):
            _stamp(departure, rec["dep"])
