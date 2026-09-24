"""
running_status.py
-----------------
FEATURE: RailYatri-style "running status" snapshot for push notifications.

RailYatri's live-status notification doesn't just say "15 min late" — it
tells you WHERE the train is: "Crossed Aluva at 17:54 · 26 km to Thrissur ·
Exp. 17:28". This module turns the already-built live timeline (the same
`gps_tracking.timeline_to_json()` list Live Tracking and the delay-alert
pipeline use) into that compact snapshot, so the background push jobs
(delay alerts + the new background tracking watch) can describe the
train's real position without re-running the whole /ws/track pipeline.

Everything here is derived from real provider fields (status, actual
times, distance_km, expected times). Where a figure can't be derived it's
left as None and simply omitted from the text — never invented.
"""

import re
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

_HHMM_RE = re.compile(r"(\d{1,2}):(\d{2})")


def ist_now() -> datetime:
    """Train times are IST; Render runs in UTC — always compute in IST."""
    return (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).replace(tzinfo=None)


def _hhmm(value) -> Optional[str]:
    m = _HHMM_RE.search(str(value or ""))
    if not m:
        return None
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def _minutes_since(hhmm: Optional[str], now: datetime) -> Optional[float]:
    """Minutes elapsed since a same-day-ish HH:MM clock time (handles the
    midnight wrap). None if unparseable or apparently in the future."""
    if not hhmm:
        return None
    h, m = (int(x) for x in hhmm.split(":"))
    diff = (now.hour * 60 + now.minute) - (h * 60 + m)
    diff = diff % 1440
    if diff > 720:  # more than 12h "ago" → really a future time
        return None
    return float(diff)


def _km(v) -> Optional[float]:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def _title(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    # "KURUKSHETRA JN" -> "Kurukshetra Jn" (RailYatri shows mixed case in the body)
    return " ".join(w.capitalize() if len(w) > 2 else w.title() for w in str(name).split())


def build(timeline_json: list, *, delay_minutes: Optional[int] = None, train_name: Optional[str] = None,
          speed_kmph: Optional[float] = None,
          is_really_reached: Optional[Callable[[dict], bool]] = None,
          now: Optional[datetime] = None) -> Optional[dict]:
    """
    Returns a dict (all fields optional/None-able):
      crossed_station, crossed_code, crossed_time, crossed_verb ("Crossed"|"Arrived at"|"Departed"),
      next_station, next_code, km_to_next,
      next_halt, next_halt_code, next_halt_eta, next_halt_delay,
      destination, destination_eta, completed (bool), delay_minutes, train_name,
      headline (str), detail (str)
    or None if the timeline is empty.
    """
    if not timeline_json:
        return None
    now = now or ist_now()
    reached = is_really_reached or (lambda s: s.get("status") in ("current", "passed"))

    # Last point the train has REALLY reached — any kind (intermediate
    # points count: RailYatri's "Crossed X" is very often a no-halt station).
    last_idx = -1
    for i, s in enumerate(timeline_json):
        if s.get("status") in ("current", "passed") or (s.get("kind") != "intermediate" and reached(s)):
            last_idx = i

    dest = timeline_json[-1]
    dest_arr = dest.get("arrival") or {}
    completed = last_idx == len(timeline_json) - 1 and last_idx >= 0

    crossed = timeline_json[last_idx] if last_idx >= 0 else None
    crossed_time = None
    crossed_verb = None
    if crossed is not None:
        arr = crossed.get("arrival") or {}
        dep = crossed.get("departure") or {}
        dep_actual = _hhmm(dep.get("actual")) if dep.get("actual_is_predicted") is not True else None
        arr_actual = _hhmm(arr.get("actual")) if arr.get("actual_is_predicted") is not True else None
        if crossed.get("kind") == "intermediate":
            crossed_verb, crossed_time = "Crossed", dep_actual or arr_actual
        elif crossed.get("status") == "current" and arr_actual and not dep_actual and not completed:
            crossed_verb, crossed_time = "Arrived at", arr_actual
        elif completed:
            crossed_verb, crossed_time = "Reached", arr_actual or dep_actual
        else:
            crossed_verb, crossed_time = ("Departed" if dep_actual else "Crossed"), dep_actual or arr_actual

    nxt = timeline_json[last_idx + 1] if 0 <= last_idx + 1 < len(timeline_json) else None
    if last_idx < 0:
        nxt = timeline_json[0]
    next_halt = None
    for s in timeline_json[last_idx + 1:]:
        if s.get("kind") != "intermediate":
            next_halt = s
            break

    # Remaining km to the very next point: static route gap, reduced by how
    # far the train has plausibly run since it crossed the last point (real
    # crossed time x real speed), and never below 0.
    km_to_next = None
    if crossed is not None and nxt is not None:
        a, b = _km(crossed.get("distance_km")), _km(nxt.get("distance_km"))
        if a is not None and b is not None and b >= a:
            gap = b - a
            since = _minutes_since(crossed_time, now)
            if since is not None and speed_kmph and speed_kmph > 0 and crossed_verb != "Arrived at":
                gap = max(0.0, gap - speed_kmph * since / 60.0)
            km_to_next = round(gap, 1)

    def _eta(stop):
        if not stop:
            return None
        arr = stop.get("arrival") or {}
        return _hhmm(stop.get("predicted_eta")) or _hhmm(arr.get("expected")) or _hhmm(arr.get("scheduled"))

    def _delay(stop):
        if not stop:
            return None
        if stop.get("predicted_delay_minutes") is not None:
            return stop.get("predicted_delay_minutes")
        return (stop.get("arrival") or {}).get("delay_minutes")

    if delay_minutes is None and crossed is not None:
        delay_minutes = ((crossed.get("departure") or {}).get("delay_minutes")
                         if (crossed.get("departure") or {}).get("delay_minutes") is not None
                         else (crossed.get("arrival") or {}).get("delay_minutes"))

    rs = {
        "train_name": train_name,
        "delay_minutes": delay_minutes,
        "crossed_station": _title(crossed.get("name")) if crossed else None,
        "crossed_code": crossed.get("code") if crossed else None,
        "crossed_time": crossed_time,
        "crossed_verb": crossed_verb,
        "next_station": _title(nxt.get("name")) if nxt else None,
        "next_code": nxt.get("code") if nxt else None,
        "km_to_next": km_to_next,
        "next_halt": _title(next_halt.get("name")) if next_halt else None,
        "next_halt_code": next_halt.get("code") if next_halt else None,
        "next_halt_eta": _eta(next_halt),
        "next_halt_delay": _delay(next_halt),
        "destination": _title(dest.get("name")),
        "destination_eta": _hhmm(dest_arr.get("actual")) if completed else _eta(dest),
        "completed": completed,
    }
    rs["headline"] = headline(rs)
    rs["detail"] = detail(rs)
    return rs


def delay_phrase(minutes: Optional[int]) -> Optional[str]:
    if minutes is None:
        return None
    if minutes <= 0:
        return "On time"
    h, m = divmod(int(minutes), 60)
    return (f"{h}h {m}m late" if h else f"{m} min late")


def headline(rs: dict) -> str:
    """'Crossed Aluva at 17:54 · 26 km to Thrissur'"""
    if not rs:
        return ""
    if rs.get("completed"):
        s = f"Reached {rs.get('destination')}"
        if rs.get("destination_eta"):
            s += f" at {rs['destination_eta']}"
        return s
    parts = []
    if rs.get("crossed_station"):
        p = f"{rs.get('crossed_verb') or 'Crossed'} {rs['crossed_station']}"
        if rs.get("crossed_time"):
            p += f" at {rs['crossed_time']}"
        parts.append(p)
    else:
        parts.append("Yet to start")
    if rs.get("next_station"):
        if rs.get("km_to_next") is not None:
            parts.append(f"{rs['km_to_next']:g} km to {rs['next_station']}")
        else:
            parts.append(f"Next: {rs['next_station']}")
    return " · ".join(parts)


def detail(rs: dict) -> str:
    """'Next halt Thrissur exp. 17:43 (15 min late)'"""
    if not rs or rs.get("completed"):
        return ""
    if not rs.get("next_halt"):
        return ""
    s = f"Next halt {rs['next_halt']}"
    if rs.get("next_halt_eta"):
        s += f" exp. {rs['next_halt_eta']}"
    dp = delay_phrase(rs.get("next_halt_delay"))
    if dp:
        s += f" ({dp})"
    return s


def signature(rs: Optional[dict]) -> str:
    """What counts as a 'new' running status worth a fresh push: a new
    crossed point, a new next halt, or the delay moving by 5+ min."""
    if not rs:
        return ""
    d = rs.get("delay_minutes")
    bucket = "" if d is None else str(int(d) // 5)
    return "|".join(str(x or "") for x in (rs.get("crossed_code"), rs.get("next_halt_code"), bucket, rs.get("completed")))
