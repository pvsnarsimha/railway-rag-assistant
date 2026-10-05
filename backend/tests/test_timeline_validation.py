"""Pipeline step 4 (timeline_validation): impossible provider readings are
rejected, correctly dated ones are kept — including on multi-day trains where
the same HH:MM occurs on day 1, 2 and 3 (e.g. 12295)."""
import os
import sys
from datetime import datetime
from types import SimpleNamespace as NS

_BACKEND = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, _BACKEND)

import timeline_validation as tv  # noqa: E402


def _ev(sched, actual=None):
    return {"scheduled": sched, "expected": sched, "actual": actual, "delay_minutes": 0}


def _stop(code, status, arr, dep, arr_actual=None, dep_actual=None):
    return {"code": code, "name": code, "kind": "station", "status": status,
            "arrival": _ev(arr, arr_actual), "departure": _ev(dep, dep_actual)}


def _long_train(**actuals):
    """Bengaluru -> Danapur style: ~2 nights, three calendar days."""
    return [
        _stop("SBC", "passed", None, "09:00"),
        _stop("ARK", "current", "13:20", "13:22"),     # day 1
        _stop("KPD", "upcoming", "14:00", "14:02", actuals.get("KPD")),    # next halt
        _stop("VSKP", "upcoming", "23:10", "23:20", actuals.get("VSKP")),  # day 1 late
        _stop("KGP", "upcoming", "08:00", "08:05", actuals.get("KGP")),    # day 2
        _stop("DNR", "upcoming", "08:00", None, actuals.get("DNR")),       # day 3, same clock time
    ]


NOW_DAY1 = datetime(2026, 10, 5, 13, 31)


def test_day_numbers_follow_midnight_wraps():
    days = tv.day_numbers(_long_train())
    assert days == {"SBC": 1, "ARK": 1, "KPD": 1, "VSKP": 1, "KGP": 2, "DNR": 3}


def test_far_downstream_actual_with_past_looking_clock_time_is_rejected():
    """"Reached Danapur at 08:00" while still near Arakkonam on day 1:
    08:00 < 13:31 looks like the past, but it belongs to day 3."""
    tl = _long_train(DNR="08:00")
    report = tv.validate_actuals(tl, NOW_DAY1)
    assert report["anchor"] != "none"
    assert tl[5]["arrival"]["actual"] is None
    assert tl[5]["arrival"]["actual_rejected"]
    assert [r["code"] for r in report["rejected"]] == ["DNR"]


def test_day2_actual_is_rejected_on_day1():
    tl = _long_train(KGP="08:10")
    tv.validate_actuals(tl, NOW_DAY1)
    assert tl[4]["arrival"]["actual"] is None


def test_real_past_actual_is_kept():
    tl = _long_train(KPD="13:25")   # provider status stale, but 13:25 on day 1 is past
    tv.validate_actuals(tl, NOW_DAY1)
    assert tl[2]["arrival"]["actual"] == "13:25"


def test_day2_actual_is_accepted_once_day2_arrives():
    now = datetime(2026, 10, 6, 8, 30)
    tl = _long_train(KGP="08:10")
    # train is further along on day 2: provider still lags on status
    for i in (1, 2, 3):
        tl[i]["status"] = "passed"
    tv.validate_actuals(tl, now)
    assert tl[4]["arrival"]["actual"] == "08:10"


def test_provider_current_and_passed_stops_are_never_touched():
    tl = _long_train()
    tl[1]["arrival"]["actual"] = "13:25"
    tv.validate_actuals(tl, NOW_DAY1)
    assert tl[1]["arrival"]["actual"] == "13:25"


def test_no_anchor_means_no_changes():
    tl = [_stop("A", "upcoming", "10:00", "10:02", "23:59")]
    report = tv.validate_actuals(tl, NOW_DAY1)
    assert report["anchor"] == "none" and tl[0]["arrival"]["actual"] == "23:59"


def test_railradar_entries_for_other_days_are_dropped():
    tl = _long_train()
    good = NS(arrival=NS(actual="13:25"), departure=NS(actual=None))
    bad = NS(arrival=NS(actual="08:00"), departure=NS(actual="08:00"))
    kept = tv.filter_railradar({"KPD": good, "DNR": bad}, tl, NOW_DAY1)
    assert "KPD" in kept and "DNR" not in kept
