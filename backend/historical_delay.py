"""
historical_delay.py
--------------------
FEATURE: Real-Time Delay Dashboard with Historical Patterns.

Adds real historical context next to the existing single-shot ML delay
prediction (delay_prediction.py) by pulling this train's own REAL
completed-journey history (railway_api.get_train_history — one real call
per past date, already cached 24h) for a small window of recent calendar
dates, and reporting the real delay actually recorded for each one -
grouped by day of week, so "this train usually runs on time on
Tuesdays" is grounded in its own real run history, not a generalized or
synthetic pattern.

Honesty rules, same as the rest of this project:
  - A date this train hasn't completed yet, or that the provider has no
    history for, is reported as `data_available: false` for that date -
    never silently dropped nor backfilled with a guess.
  - Weekday averages are only ever computed from dates that actually
    returned a real delay figure; a weekday with zero real data points
    stays `null` (not zero, not omitted).
  - Tries gps_tracking.parse_full_timeline's existing "timeline" parser
    first (same provider, plausible shape for a stop-by-stop delay
    figure on a completed run); falls back to a couple of plausible flat
    delay field names before honestly giving up on that date.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import List, Optional
import re

import railway_api
import gps_tracking
from deep_extract import deep_find, deep_find_list_of_dicts, top_level_keys

_DEFAULT_LOOKBACK_DAYS = 14
_MAX_LOOKBACK_DAYS = 30
_WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _extract_history_delay(data: dict) -> Optional[int]:
    if not isinstance(data, dict):
        return None
    payload = data.get("data", data)

    # 1. A delay-shaped field anywhere in the response, whatever it's
    # nested under (see deep_extract.py — a real /history lookup came
    # back with real content but 0 top-level field-name matches, meaning
    # RailKit nests the history payload under a wrapper key).
    val = deep_find(payload, [
        "delay", "totalDelay", "delayMinutes", "lateBy", "arrivalDelay",
        "finalDelay", "delayInMinutes", "netDelay", "overallDelay",
    ])
    if isinstance(val, (int, float)):
        return int(val)
    if isinstance(val, str):
        m = re.search(r"-?\d+", val)
        if m:
            return int(m.group(0))

    # 2. gps_tracking's own "timeline" parser, in case a history response
    # happens to share live-tracking's exact shape.
    try:
        stops = gps_tracking.parse_full_timeline(data)
    except Exception:
        stops = []
    confirmed = [
        s for s in stops
        if (s.departure and s.departure.delay_minutes is not None) or (s.arrival and s.arrival.delay_minutes is not None)
    ]
    if confirmed:
        last = confirmed[-1]
        if last.departure and last.departure.delay_minutes is not None:
            return last.departure.delay_minutes
        return last.arrival.delay_minutes

    # 3. A stop/station list under ANY wrapper key name — real
    # actual-minus-scheduled arithmetic on whatever per-stop timing
    # fields are actually there, without assuming "timeline" is the key.
    stop_list = deep_find_list_of_dicts(payload, [
        "timeline", "stations", "stops", "route", "stationList", "history", "haltDetails", "journeyHistory",
    ])
    best_delay = None
    for stop in stop_list:
        if not isinstance(stop, dict):
            continue
        for actual_names, sched_names in (
            (["actualArrival", "actual", "ata"], ["scheduledArrival", "scheduled", "sta"]),
            (["actualDeparture", "actual", "atd"], ["scheduledDeparture", "scheduled", "std"]),
        ):
            actual = deep_find(stop, actual_names)
            sched = deep_find(stop, sched_names)
            a_min = gps_tracking._time_str_to_minutes(actual)
            s_min = gps_tracking._time_str_to_minutes(sched)
            if a_min is not None and s_min is not None:
                diff = a_min - s_min
                # BUGFIX: same fix as gps_tracking._parse_timing - only treat
                # this as a real midnight rollover when the two clock times
                # are more than 12h apart (the standard circular-time-diff
                # test), not merely "more than an hour early", which used to
                # misread a genuinely-early same-day arrival as having
                # wrapped past midnight.
                if diff < -720:
                    diff += 1440
                elif diff > 720:
                    diff -= 1440
                best_delay = diff  # last real pair wins - closer to the run's final/most representative delay
    return best_delay


@dataclass
class DayRecord:
    date: str
    weekday: str
    data_available: bool
    delay_minutes: Optional[int] = None
    error: Optional[str] = None
    raw_keys: Optional[List[str]] = None  # debugging aid when the call succeeded but nothing matched, see deep_extract.py


def get_historical_pattern(train_number: str, lookback_days: int = _DEFAULT_LOOKBACK_DAYS) -> dict:
    """Real per-day history for the last `lookback_days` calendar days
    (capped 30), plus a real weekday-averaged summary computed only from
    dates that actually returned a delay figure."""
    lookback_days = max(1, min(lookback_days, _MAX_LOOKBACK_DAYS))
    today = datetime.now()
    days: List[DayRecord] = []

    for i in range(1, lookback_days + 1):
        day = today - timedelta(days=i)
        date_str = day.strftime("%d-%m-%Y")
        weekday = _WEEKDAY_NAMES[day.weekday()]
        try:
            data = railway_api.get_train_history(train_number, date_str)
            delay = _extract_history_delay(data)
            if delay is None:
                keys = top_level_keys(data)
                days.append(DayRecord(
                    date=date_str, weekday=weekday, data_available=False,
                    error=(
                        f"Provider returned no recognizable delay/timing fields for this date "
                        f"(top-level keys seen: {', '.join(keys)})." if keys else
                        "No history data returned for this date (train may not have run, or hasn't completed its run yet)."
                    ),
                    raw_keys=keys or None,
                ))
            else:
                days.append(DayRecord(date=date_str, weekday=weekday, data_available=True, delay_minutes=delay))
        except railway_api.RailwayAPIError as e:
            days.append(DayRecord(date=date_str, weekday=weekday, data_available=False, error=str(e)))

    by_weekday = {name: [] for name in _WEEKDAY_NAMES}
    for d in days:
        if d.data_available and d.delay_minutes is not None:
            by_weekday[d.weekday].append(d.delay_minutes)

    weekday_summary = []
    for name in _WEEKDAY_NAMES:
        vals = by_weekday[name]
        weekday_summary.append({
            "weekday": name,
            "samples": len(vals),
            "avg_delay_minutes": round(sum(vals) / len(vals), 1) if vals else None,
            "min_delay_minutes": min(vals) if vals else None,
            "max_delay_minutes": max(vals) if vals else None,
        })

    available_count = sum(1 for d in days if d.data_available)
    unmatched_but_present = [d for d in days if not d.data_available and d.raw_keys]
    note = (
        f"Real completed-journey history for train {train_number}, {available_count}/{lookback_days} recent days had data — "
        "days without data (train didn't run, or hasn't completed yet) are shown as such, not averaged in as zero delay."
        if available_count else
        (
            f"The provider returned real data for train {train_number} but not in a shape this could match to a delay figure "
            f"(see each day's raw field names below) — this needs a fix on the extraction side, not a data problem."
            if unmatched_but_present else
            f"No completed-journey history was available for train {train_number} in the last {lookback_days} days — "
            "the provider only has data once a run is fully complete."
        )
    )

    return {
        "train_number": train_number,
        "lookback_days": lookback_days,
        "days_with_data": available_count,
        "days": [
            {"date": d.date, "weekday": d.weekday, "data_available": d.data_available,
             "delay_minutes": d.delay_minutes, "error": d.error, "raw_keys": d.raw_keys}
            for d in days
        ],
        "weekday_summary": weekday_summary,
        "note": note,
    }


def headline(weekday_summary: List[dict]) -> Optional[str]:
    """
    FEATURE: plain-English historical-comparison line for the Explainable
    AI delay-prediction breakdown (see delay_explainability.py) — e.g.
    "This train has averaged the least delay on Tuesdays (+4 min avg over
    3 recent runs) and the most on Fridays (+22 min avg over 2 recent
    runs)." Built ONLY from get_historical_pattern()'s weekday_summary
    entries that actually had >=1 real completed-journey sample — a
    weekday with zero real data points is already `avg_delay_minutes:
    null` there and is excluded here too, never treated as "0 delay".
    Returns None (not a guess) if fewer than two weekdays have any real
    data to compare, or if the best/worst weekday tie.
    """
    have_data = [d for d in weekday_summary if d.get("samples") and d.get("avg_delay_minutes") is not None]
    if len(have_data) < 2:
        return None
    best = min(have_data, key=lambda d: d["avg_delay_minutes"])
    worst = max(have_data, key=lambda d: d["avg_delay_minutes"])
    if best["weekday"] == worst["weekday"]:
        return None
    return (
        f"This train has averaged the least delay on {best['weekday']}s "
        f"(+{best['avg_delay_minutes']:.0f} min avg over {best['samples']} recent run(s)) "
        f"and the most on {worst['weekday']}s "
        f"(+{worst['avg_delay_minutes']:.0f} min avg over {worst['samples']} recent run(s))."
    )