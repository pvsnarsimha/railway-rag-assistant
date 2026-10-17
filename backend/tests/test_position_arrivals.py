from datetime import datetime, timezone, timedelta

import position_arrivals as pa


def _tl():
    return [
        {"code": "BZA", "kind": "stoppage", "status": "upcoming", "distance_km": "349.6",
         "arrival": {"scheduled": "10:00", "actual": "10:00", "actual_is_predicted": True},
         "departure": {"scheduled": "10:05", "actual": "10:05", "actual_is_predicted": True}},
        {"code": "KMT", "kind": "stoppage", "status": "upcoming", "distance_km": "451.4",
         "arrival": {"scheduled": "11:09"}, "departure": {"scheduled": "11:10"}},
    ]


def _t(h, m):  # IST clock as the naive datetime the helper expects
    return datetime(2026, 10, 17, h, m)


def test_arrival_stamped_immediately_and_departure_after_leaving():
    tl, seen = _tl(), {}
    pa.infer_position_arrivals(tl, 349.5, seen, _t(10, 12))
    a = tl[0]["arrival"]
    assert (a["actual"], a["actual_is_predicted"], a["actual_source"], a["delay_minutes"]) == ("10:12", False, "position", 12)
    assert tl[0]["status"] == "current" and tl[1]["status"] == "upcoming"
    pa.infer_position_arrivals(tl, 349.9, seen, _t(10, 15))
    assert tl[0]["arrival"]["actual"] == "10:12"  # fixed once observed
    pa.infer_position_arrivals(tl, 351.0, seen, _t(10, 18))
    assert tl[0]["status"] == "passed"
    assert tl[0]["departure"]["actual"] == "10:18" and tl[0]["departure"]["actual_is_predicted"] is False


def test_provider_actual_wins():
    tl, seen = _tl(), {"BZA": {"arr": "10:12", "dep": None}}
    tl[0]["arrival"].update(actual="10:03", actual_is_predicted=False)
    pa.infer_position_arrivals(tl, 360.0, seen, _t(10, 20))
    assert tl[0]["arrival"]["actual"] == "10:03" and "actual_source" not in tl[0]["arrival"]
    assert "BZA" not in seen


def test_no_position_no_change():
    tl = _tl()
    pa.infer_position_arrivals(tl, None, {}, _t(10, 12))
    assert tl[0]["status"] == "upcoming"
