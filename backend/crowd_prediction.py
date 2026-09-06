"""
crowd_prediction.py
----------------------
FEATURE: Train Capacity & Crowd Prediction.

HONEST NOTE (same rule as everywhere else in this project): Indian Railways
does not publish live per-coach headcounts or occupancy sensors anywhere
Claude or this app can reach. So this is NOT a live crowd feed - it is a
transparent, rule-based ESTIMATE that combines:

  1. REAL data, when available: the actual booking numbers from
     `railway_api.get_seat_availability()` (current status like "AVAILABLE
     42" / "RAC 12" / "WL 87" is real, provider-returned data) - a train
     showing a long waitlist for the requested class/date is real evidence
     of high demand, not a guess.
  2. Documented, general heuristics about Indian rail travel patterns: peak
     festival/holiday season, weekday vs weekend, time-of-day (early
     morning/late night trains tend to be quieter), and unreserved/general
     coaches historically running fuller than reserved ones.

Every result carries `basis` (exactly which of the above fed the score) and
a `disclaimer` string that the caller MUST surface - so nobody mistakes this
for a real occupancy sensor reading.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional

DISCLAIMER = (
    "This is a rule-based estimate from booking demand and general travel patterns, "
    "not a live headcount sensor - Indian Railways doesn't publish real-time coach occupancy."
)

# Indian festival/holiday travel-rush windows are well-known to run very
# high demand (Diwali, Chhath, Holi, summer/Durga Puja school-holiday
# season, major long weekends). Kept as month/day ranges, not exact dates
# tied to one year, since these shift on the lunar/festival calendar - this
# is a coarse seasonal signal, not a precise festival calendar.
_HIGH_DEMAND_MONTH_DAYS = [
    (10, 1, 11, 15),   # Durga Puja / Dussehra / Diwali / Chhath season
    (3, 1, 3, 25),      # Holi season
    (5, 15, 6, 30),     # Summer school-holiday travel
    (12, 15, 1, 5),     # Christmas / New Year
]


def _in_high_demand_window(month: int, day: int) -> bool:
    for m1, d1, m2, d2 in _HIGH_DEMAND_MONTH_DAYS:
        start = (m1, d1)
        end = (m2, d2)
        cur = (month, day)
        if start <= end:
            if start <= cur <= end:
                return True
        else:  # wraps year-end (Dec -> Jan)
            if cur >= start or cur <= end:
                return True
    return False


def _parse_ddmmyyyy(date_str: Optional[str]):
    if not date_str:
        return None
    try:
        return datetime.strptime(date_str, "%d-%m-%Y")
    except ValueError:
        return None


def _extract_seat_counts(seat_availability_data: dict) -> dict:
    """Pulls whatever numbers RailKit's availability response actually
    contains - field names vary across providers, same defensive pattern
    used in trains_between.py / gps_tracking.py. Returns {} if nothing
    recognisable is present (never invents a number)."""
    if not isinstance(seat_availability_data, dict):
        return {}
    payload = seat_availability_data.get("data", seat_availability_data)
    if not isinstance(payload, dict):
        return {}

    status_text = None
    for key in ("availabilityStatus", "status", "availability_status", "currentStatus"):
        if payload.get(key):
            status_text = str(payload[key])
            break

    out = {"status_text": status_text}
    if status_text:
        wl_match = re.search(r"\bWL[\s-]?(\d+)", status_text, re.IGNORECASE)
        rac_match = re.search(r"\bRAC[\s-]?(\d+)", status_text, re.IGNORECASE)
        avl_match = re.search(r"\bAVAILABLE[\s-]?(\d+)", status_text, re.IGNORECASE)
        if wl_match:
            out["waitlist"] = int(wl_match.group(1))
        if rac_match:
            out["rac"] = int(rac_match.group(1))
        if avl_match:
            out["available"] = int(avl_match.group(1))
    return out


@dataclass
class CrowdPrediction:
    level: str                       # "Low" | "Moderate" | "High" | "Very High"
    score: int                       # 0-100, internal, for ordering/debugging
    basis: List[str] = field(default_factory=list)
    disclaimer: str = DISCLAIMER


def predict_crowd(seat_availability_data: Optional[dict] = None, travel_class: Optional[str] = None,
                   date_ddmmyyyy: Optional[str] = None, time_hhmm: Optional[str] = None) -> CrowdPrediction:
    score = 30  # baseline "moderate-low" before any signal is applied
    basis = []

    counts = _extract_seat_counts(seat_availability_data or {})
    if counts.get("waitlist") is not None:
        wl = counts["waitlist"]
        if wl > 100:
            score += 45
        elif wl > 30:
            score += 30
        elif wl > 0:
            score += 15
        basis.append(f"waitlist of {wl} in booking data")
    elif counts.get("rac") is not None:
        score += 10
        basis.append(f"RAC status ({counts['rac']}) in booking data")
    elif counts.get("available") is not None:
        avail = counts["available"]
        if avail > 50:
            score -= 15
            basis.append(f"{avail} seats freely available in booking data")
        elif avail > 10:
            basis.append(f"{avail} seats available in booking data")
        else:
            score += 10
            basis.append(f"only {avail} seats left in booking data")

    date_obj = _parse_ddmmyyyy(date_ddmmyyyy)
    if date_obj:
        if _in_high_demand_window(date_obj.month, date_obj.day):
            score += 20
            basis.append("travel date falls in a known festival/holiday rush window")
        if date_obj.weekday() >= 4:  # Fri/Sat/Sun
            score += 8
            basis.append("weekend/long-weekend travel date")

    if time_hhmm:
        try:
            hour = int(time_hhmm.split(":")[0])
            if 0 <= hour < 5:
                score -= 15
                basis.append("late-night departure (typically quieter)")
            elif 7 <= hour <= 10 or 17 <= hour <= 21:
                score += 8
                basis.append("peak commute/evening departure window")
        except (ValueError, IndexError):
            pass

    cls = (travel_class or "").upper()
    if cls in ("SL", "2S", "GEN", "GENERAL"):
        score += 10
        basis.append(f"{cls} class historically runs fuller than AC classes")
    elif cls in ("1A", "2A", "EC"):
        score -= 10
        basis.append(f"{cls} class historically has more predictable, lower occupancy")
    elif cls in ("3A", "3E", "CC", "FC"):
        score += 3
        basis.append(f"{cls} class sits in the middle of the demand curve - popular AC tier, but rarely overbooked like SL")
    elif cls:
        basis.append(f"{cls} class noted - no strong historical skew on record for it, so it wasn't weighted either way")

    score = max(0, min(100, score))
    if score >= 70:
        level = "Very High"
    elif score >= 50:
        level = "High"
    elif score >= 30:
        level = "Moderate"
    else:
        level = "Low"

    if not basis:
        basis.append("no booking data or date/time/class details were available - this is a generic baseline")

    return CrowdPrediction(level=level, score=score, basis=basis)


def format_crowd_prediction(pred: CrowdPrediction) -> str:
    lines = [f"Predicted crowd level: {pred.level}", f"Based on: {'; '.join(pred.basis)}", pred.disclaimer]
    return "\n".join(lines)
