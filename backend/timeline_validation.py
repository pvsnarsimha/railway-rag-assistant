"""Step 4 of the live-tracking pipeline: sanity-check provider readings.

Providers (RailKit, RailRadar, RapidAPI) sometimes return an "actual" arrival
for a stop the train cannot have reached yet — a projection, or the PREVIOUS
run's record (daily trains have overlapping runs). Bare "HH:MM" actuals are
ambiguous on long, multi-day trains (e.g. 12295: the same clock time occurs
on day 1, 2 and 3), so a plain "is it ahead of the clock" test is not enough.

This module resolves each reading to an ABSOLUTE date-time by anchoring the
route's scheduled times to a real calendar date (day number worked out from
the scheduled times wrapping past midnight), then rejects a reading only when
that is provable:

  * its absolute time is ahead of now,
  * its stop's scheduled time is still well in the future (the train would
    have to be hours early),
  * it runs backwards relative to an earlier stop's reading.

Only stops the provider still marks "upcoming" are checked: a stop the
provider says is current/passed is never touched. When no reliable calendar
anchor can be found the validator does nothing (it never guesses).
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Dict, Optional, Tuple

_CLOCK_RE = re.compile(r"(\d{1,2}):(\d{2})")
_DATED_RE = re.compile(r"(\d{1,2}):(\d{2})\s+(\d{1,2})-([A-Za-z]{3})")
_MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}

# A reading this far ahead of "now" is impossible (clock skew allowance).
FUTURE_SLACK = timedelta(minutes=10)
# A stop scheduled more than this far ahead cannot already have a real
# arrival (that would mean the train is running hours early).
NOT_YET_SLACK = timedelta(minutes=90)
# Consecutive readings may disagree by a few minutes; more is "backwards".
BACKWARDS_SLACK = timedelta(minutes=10)


def _minutes(raw) -> Optional[int]:
    m = _CLOCK_RE.search(str(raw or ""))
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 23 or mi > 59:
        return None
    return h * 60 + mi


def _dated(raw, now: datetime) -> Optional[datetime]:
    """RailKit's dated "HH:MM DD-Mon" string -> naive datetime (year chosen
    nearest to `now`), or None when the string carries no date."""
    m = _DATED_RE.search(str(raw or ""))
    if not m:
        return None
    month = _MONTHS.get(m.group(4).capitalize())
    if not month:
        return None
    try:
        dt = datetime(now.year, month, int(m.group(3)), int(m.group(1)), int(m.group(2)))
    except ValueError:
        return None
    if (dt - now).days > 200:
        dt = dt.replace(year=dt.year - 1)
    elif (now - dt).days > 200:
        dt = dt.replace(year=dt.year + 1)
    return dt


def day_numbers(timeline_json: list) -> Dict[str, int]:
    """Day number (1-based) of every stop, from its scheduled times: scheduled
    times only increase along a route until they cross midnight, so a stop
    whose arrival is EARLIER than the previous stop's departure is on the
    next day. (Same rule the app's day pills use.)"""
    out: Dict[str, int] = {}
    day, prev = 1, None
    for s in timeline_json or []:
        code = s.get("code")
        if not code:
            continue
        arr = _minutes((s.get("arrival") or {}).get("scheduled"))
        dep = _minutes((s.get("departure") or {}).get("scheduled"))
        if arr is not None and prev is not None and arr < prev:
            day += 1
        out[code] = day
        if arr is not None and dep is not None and dep < arr:
            day += 1  # the halt itself crosses midnight
        leave = dep if dep is not None else arr
        if leave is not None:
            prev = leave
    return out


def _anchor_start_date(timeline_json: list, days: Dict[str, int], now: datetime,
                       start_date_hint: Optional[date]) -> Tuple[Optional[date], str]:
    """Calendar date of day 1, and how it was found."""
    # 1) any stop carrying a real dated scheduled/expected timestamp
    for s in timeline_json:
        n = days.get(s.get("code"))
        if not n:
            continue
        for key in ("arrival", "departure"):
            for field in ("scheduled", "expected"):
                dt = _dated((s.get(key) or {}).get(field), now)
                if dt:
                    return dt.date() - timedelta(days=n - 1), "dated"
    # 2) the stop the train is at / last passed: pick the start date that puts
    #    that stop's scheduled time closest to now (a train is never days off
    #    its own schedule).
    ref = None
    for s in timeline_json:
        if s.get("status") in ("current", "passed") and s.get("code") in days:
            ref = s
    if ref is not None:
        mins = _minutes((ref.get("departure") or {}).get("scheduled")) or _minutes((ref.get("arrival") or {}).get("scheduled"))
        if mins is not None:
            n = days[ref["code"]]
            best = None
            for back in range(0, 7):
                start = now.date() - timedelta(days=back)
                cand = datetime.combine(start + timedelta(days=n - 1), datetime.min.time()) + timedelta(minutes=mins)
                gap = abs(cand - now)
                if best is None or gap < best[0]:
                    best = (gap, start)
            if best and best[0] <= timedelta(hours=18):
                return best[1], "nearest-to-now"
    return None, "none"


def scheduled_datetimes(timeline_json: list, now: datetime,
                        start_date_hint: Optional[date] = None):
    """{code: {"arr": datetime|None, "dep": datetime|None}} absolute scheduled
    times, plus the anchor method ("dated" / "nearest-to-now" / "none")."""
    days = day_numbers(timeline_json)
    start, how = _anchor_start_date(timeline_json, days, now, start_date_hint)
    if start is None:
        return {}, how
    out = {}
    for s in timeline_json:
        code = s.get("code")
        n = days.get(code)
        if not code or not n:
            continue
        base = datetime.combine(start + timedelta(days=n - 1), datetime.min.time())
        arr_m = _minutes((s.get("arrival") or {}).get("scheduled"))
        dep_m = _minutes((s.get("departure") or {}).get("scheduled"))
        arr = base + timedelta(minutes=arr_m) if arr_m is not None else None
        dep = base + timedelta(minutes=dep_m) if dep_m is not None else None
        if arr is not None and dep is not None and dep < arr:
            dep += timedelta(days=1)
        out[code] = {"arr": arr, "dep": dep}
    return out, how


def absolute_time(raw, sched: Optional[datetime], now: datetime) -> Optional[datetime]:
    """Resolve a reading to an absolute date-time. A dated string is taken as
    is; a bare "HH:MM" is placed on whichever calendar day puts it closest to
    the stop's own scheduled time (so day 1/2/3 of a long train never mix up)."""
    dt = _dated(raw, now)
    if dt:
        return dt
    mins = _minutes(raw)
    if mins is None or sched is None:
        return None
    best = None
    for off in (-1, 0, 1):
        day = sched.date() + timedelta(days=off)
        cand = datetime.combine(day, datetime.min.time()) + timedelta(minutes=mins)
        gap = abs(cand - sched)
        if best is None or gap < best[0]:
            best = (gap, cand)
    return best[1]


def validate_actuals(timeline_json: list, now: datetime,
                     start_date_hint: Optional[date] = None) -> dict:
    """Clear provably-impossible provider "actual" times on stops still marked
    "upcoming". Mutates `timeline_json` in place; returns a report:
    {"anchor": ..., "rejected": [{"code","event","reason"}]}."""
    sched, how = scheduled_datetimes(timeline_json, now, start_date_hint)
    report = {"anchor": how, "rejected": []}
    if not sched:
        return report
    prev_actual: Optional[datetime] = None
    for s in timeline_json:
        code = s.get("code")
        times = sched.get(code)
        if not times or s.get("status") != "upcoming":
            # provider says current/passed: trust it and use it as the baseline
            if times:
                for key, sk in (("arrival", "arr"), ("departure", "dep")):
                    ev = s.get(key) or {}
                    if ev.get("actual"):
                        t = absolute_time(ev["actual"], times.get(sk), now)
                        if t:
                            prev_actual = t
            continue
        for key, sk in (("arrival", "arr"), ("departure", "dep")):
            ev = s.get(key)
            if not isinstance(ev, dict) or not ev.get("actual") or ev.get("actual_is_predicted"):
                continue
            t = absolute_time(ev["actual"], times.get(sk), now)
            reason = None
            if t is None:
                continue
            if t > now + FUTURE_SLACK:
                reason = "ahead of the clock"
            elif times.get(sk) is not None and times[sk] - now > NOT_YET_SLACK:
                reason = "scheduled hours from now (previous run's record)"
            elif prev_actual is not None and t < prev_actual - BACKWARDS_SLACK:
                reason = "earlier than the previous stop's reading"
            if reason:
                report["rejected"].append({"code": code, "event": key, "actual": ev["actual"], "reason": reason})
                ev["actual_rejected"] = reason
                ev["actual"] = None
                ev["delay_minutes"] = None  # it was derived from the rejected time
            else:
                prev_actual = t
    return report


def filter_railradar(rr_by_code: dict, timeline_json: list, now: datetime,
                     start_date_hint: Optional[date] = None) -> dict:
    """Drop RailRadar "passed" entries whose recorded times are impossible for
    THIS run (same tests as validate_actuals). `rr_by_code` maps station code
    -> RailRadar stop object (with .arrival/.departure .actual)."""
    sched, _how = scheduled_datetimes(timeline_json, now, start_date_hint)
    if not sched:
        return rr_by_code
    kept = {}
    for code, rr in rr_by_code.items():
        times = sched.get(code)
        ok = True
        if times:
            for attr, sk in (("arrival", "arr"), ("departure", "dep")):
                actual = getattr(getattr(rr, attr, None), "actual", None)
                if not actual:
                    continue
                t = absolute_time(actual, times.get(sk), now)
                if t is None:
                    continue
                if t > now + FUTURE_SLACK or (times.get(sk) is not None and times[sk] - now > NOT_YET_SLACK):
                    ok = False
        if ok:
            kept[code] = rr
    return kept
