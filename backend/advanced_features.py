"""
advanced_features.py
----------------------
Backend logic for the "More Tools" panel: Platform Predictor, Pantry Car
Menu, Station Amenities, Coach Layout Visualization, Seat Recommendation
Engine, and Cancellation Refund Estimator. (Cross-Train Route Compare and
Fare & Availability Heatmap live directly in app.py since they're thin
wrappers around railway_api's real RailKit calls; "My Train" Dashboard is
likewise a thin batch wrapper over railway_api.get_live_train_status.)

HONEST NOTE (same rule as everywhere else in this project): RailKit/NTES
does not publish platform history, pantry menus, or a station amenities
directory. Those three features here are clearly-labelled ESTIMATES or
general reference information, never presented as live data. Coach layout
and the refund calculator are deterministic, documented public rules
(standard ICF coach geometry; IRCTC's published cancellation-charge slabs)
- not guesses - but exact figures/rakes can vary by train/zone, so both
still carry a "confirm on IRCTC / your ticket" disclaimer.
"""

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import List, Optional

from deep_extract import deep_find, deep_find_list_of_dicts


# =============================================================================
# FEATURE: Platform Number Predictor (heuristic — no real history source)
# =============================================================================
PLATFORM_DISCLAIMER = (
    "Indian Railways does not publish historical platform-allocation data "
    "through any API this app can reach, and the actual platform is only "
    "confirmed by NTES/station announcements shortly before arrival — this "
    "is a deterministic pattern-based estimate, not a live or booked platform."
)

# A handful of major stations have a genuinely-known real platform count
# (these numbers are public/documented, not estimated).
_STATION_PLATFORM_COUNTS = {
    "NDLS": 16, "HWH": 23, "BCT": 18, "MAS": 12, "SBC": 10, "SC": 10,
    "BZA": 10, "PUNE": 6, "ADI": 12, "LKO": 9, "PNBE": 10, "NGP": 8,
    "BPL": 6, "CNB": 10, "ASR": 6, "JP": 6, "GZB": 8, "VSKP": 8,
    "BBS": 7, "JHS": 8,
}

# CROWD-POSITION FOLLOW-UP: the flat 5-platform default used to apply to
# every unlisted station alike, whether it was a big junction or a small
# halt — which is exactly the "why should a small station get less
# attention" complaint turned inside out (it was actually giving small
# halts an inflated, made-up platform count). This can't become real data
# — Indian Railways doesn't publish a platform-count directory for its
# 7,000+ stations through any API this app can reach — but it can become
# a *better-informed* heuristic for the ~51 stations this app already has
# real topology data for: a station's junction degree in
# data/rail_network_edges.json (how many distinct rail lines meet there)
# is real, publicly-derivable structure, and genuinely correlates with
# station size — a 4-line junction reliably has more platforms than a
# branch-line halt. Stations outside that graph (the vast majority of the
# 7,000+) still fall back to a small-station-shaped default rather than a
# junction-shaped one, which is the honest prior for "some station this
# app has no data on at all."
_EDGES_PATH = os.path.join(os.path.dirname(__file__), "data", "rail_network_edges.json")
_DEFAULT_PLATFORM_COUNT = 3  # honest prior for an unknown/unlisted station: most of India's stations are small halts


def _station_degrees() -> dict:
    """station_code -> number of distinct rail lines meeting there, from the
    real (if small, ~51-station) topology graph this app ships with."""
    try:
        with open(_EDGES_PATH, encoding="utf-8") as f:
            edges = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    degrees: dict = {}
    for e in edges:
        for code in (e.get("from"), e.get("to")):
            if code:
                degrees[code] = degrees.get(code, 0) + 1
    return degrees


_STATION_DEGREES = _station_degrees()


def _estimated_platform_count(station_code: str) -> tuple:
    """Returns (n_platforms, basis) — basis is surfaced to the caller so the
    UI/response can be honest about whether a count is a documented real
    figure, a topology-informed estimate, or a plain unlisted default."""
    if station_code in _STATION_PLATFORM_COUNTS:
        return _STATION_PLATFORM_COUNTS[station_code], "known"

    degree = _STATION_DEGREES.get(station_code)
    if degree is not None:
        # Junction-degree tiers: a real, if coarse, structural signal —
        # not a guess about the station in isolation.
        if degree >= 4:
            return 10, "topology_estimate"
        if degree >= 2:
            return 6, "topology_estimate"
        return 4, "topology_estimate"

    return _DEFAULT_PLATFORM_COUNT, "unlisted_default"


def predict_platform(train_number: str, station_code: str) -> dict:
    station_code = (station_code or "").strip().upper()
    train_number = (train_number or "").strip()
    n_platforms, basis = _estimated_platform_count(station_code)

    # Deterministic (same train+station always gives the same answer, so
    # it doesn't flicker between checks) but not tied to anything real —
    # a stable hash standing in for "typical" allocation patterns.
    digest = hashlib.sha256(f"{train_number}:{station_code}".encode()).hexdigest()
    primary = 1 + (int(digest[:8], 16) % n_platforms)
    alt = 1 + (int(digest[8:16], 16) % n_platforms)
    if alt == primary:
        alt = 1 + (alt % n_platforms)

    basis_label = {
        "known": "Documented real platform count for this station.",
        "topology_estimate": "No documented platform count for this station — estimated from how many rail lines actually meet here in this app's route graph (a real structural signal, still not a confirmed count).",
        "unlisted_default": "No data of any kind for this station — using the typical small-station default, not a junction-sized guess.",
    }[basis]

    return {
        "station": station_code,
        "predicted_platform": primary,
        "alternate_platform": alt,
        "station_platform_count": n_platforms,
        "platform_count_basis": basis,
        "platform_count_note": basis_label,
        "confidence": "Low — pattern estimate only",
        "disclaimer": PLATFORM_DISCLAIMER,
    }


# =============================================================================
# FEATURE: Platform Finder — Indoor Navigation Guidance
# -----------------------------------------------------------------------
# HONEST NOTE (same rule as the platform predictor above): no Indian
# Railways station publishes an indoor map / entrance-to-platform routing
# graph through any API this app can reach, so there is no real "turn left
# at the escalator" data source to draw from. What IS real: the predicted
# (or user-given) platform number, this station's estimated platform count
# (predict_platform's own real/topology/default tiers, reused as-is), and
# generic, well-known Indian station conventions (platform 1 sits by the
# main entrance/circulating area; higher-numbered platforms are reached via
# a foot overbridge/subway and are a longer walk). This composes those
# real+documented-convention pieces into step-by-step generic guidance,
# clearly labelled as such — never presented as a live indoor map.
# =============================================================================
PLATFORM_NAV_DISCLAIMER = (
    "No Indian Railways station publishes real indoor-navigation/wayfinding "
    "data through any API this app can reach. These are generic steps based "
    "on typical Indian station layout conventions (platform 1 near the main "
    "entrance, higher platforms via a foot overbridge/subway) and this "
    "station's estimated platform count — not a live indoor map, and not "
    "specific to this station's actual concourse layout."
)


def platform_navigation_guide(station_code: str, platform_number: int, entry_point: Optional[str] = None) -> dict:
    station_code = (station_code or "").strip().upper()
    entry_point = (entry_point or "the main entrance").strip()
    n_platforms, basis = _estimated_platform_count(station_code)
    try:
        platform_number = int(platform_number)
    except (TypeError, ValueError):
        platform_number = 1
    platform_number = max(1, min(platform_number, max(n_platforms, platform_number)))

    steps = [f"From {entry_point}, follow signage towards the main concourse / circulating area."]

    if platform_number == 1:
        steps.append("Platform 1 is almost always the one directly alongside the main entrance/concourse at Indian "
                     "stations — no foot overbridge or subway crossing should be needed.")
        walk_minutes = 2
    else:
        steps.append("Look for the nearest foot overbridge (FOB) or subway — signposted 'Platform 2 onwards' or by "
                      "platform-number ranges — and use the stairs/escalator/lift up (FOB) or down (subway).")
        position_fraction = (platform_number - 1) / max(1, n_platforms - 1)
        if position_fraction <= 0.34:
            steps.append(f"Platform {platform_number} is one of the nearer ones — take the first set of stairs down "
                         "from the bridge (or up from the subway) after crossing.")
            walk_minutes = 4
        elif position_fraction <= 0.67:
            steps.append(f"Platform {platform_number} is roughly in the middle of the station — keep walking along "
                         "the bridge/subway past the first couple of platforms before descending.")
            walk_minutes = 6
        else:
            steps.append(f"Platform {platform_number} is towards the far end of the station — it's a longer walk "
                         "along the bridge/subway; allow extra time, especially with heavy luggage.")
            walk_minutes = 9

    steps.append("Watch the platform's own display boards/announcements to reconfirm — platform allocation can "
                 "change right up until the train arrives.")

    amenities_info = _STATION_AMENITIES.get(station_code)
    nearby_note = None
    if amenities_info:
        available = [k.replace("_", " ") for k, v in amenities_info.items() if k != "name" and v]
        if available:
            nearby_note = f"{amenities_info.get('name', station_code)} generally has: {', '.join(available)}."

    return {
        "station": station_code,
        "platform_number": platform_number,
        "entry_point": entry_point,
        "station_platform_count": n_platforms,
        "platform_count_basis": basis,
        "steps": steps,
        "estimated_walk_minutes": walk_minutes,
        "nearby_amenities_note": nearby_note,
        "disclaimer": PLATFORM_NAV_DISCLAIMER,
    }


# =============================================================================
# FEATURE: Pantry Car Menu
# =============================================================================
_PANTRY_KEYWORDS = [
    "rajdhani", "duronto", "shatabdi", "vande bharat", "tejas", "humsafar",
    "gatimaan", "double decker", "garib rath", "jan shatabdi", "sampark kranti",
    "superfast", "sf exp", "mail", "express",
]
_ALWAYS_PANTRY_KEYWORDS = [
    "rajdhani", "duronto", "shatabdi", "vande bharat", "tejas", "humsafar", "gatimaan",
]

MENU_DISCLAIMER = (
    "Menu items, prices, and whether a pantry is actually attached vary by "
    "zone, caterer, and specific rake — this is general IRCTC on-board "
    "catering reference, not this train's live/confirmed menu. Trains "
    "without an attached pantry usually still support IRCTC e-catering "
    "(pre-order food to your seat at select stations) via the IRCTC app/site."
)

_STANDARD_MENU = {
    "Breakfast": ["Tea/Coffee", "Bread butter/jam", "Vegetable cutlet", "Idli/Poha (regional)", "Boiled eggs (non-veg option)"],
    "Lunch/Dinner (Veg thali)": ["Rice", "Dal", "2 Roti", "Mixed vegetable curry", "Curd", "Pickle"],
    "Lunch/Dinner (Non-veg thali)": ["Rice", "Chicken/Egg curry", "2 Roti", "Dal", "Curd", "Pickle"],
    "Evening snacks": ["Tea/Coffee", "Samosa/Pakora", "Biscuits", "Namkeen"],
    "À la carte": ["Veg/Chicken biryani", "Sandwich", "Soup", "Cold drinks", "Bottled water (Rail Neer)"],
}


def pantry_menu(train_number: str, train_name: Optional[str] = None) -> dict:
    name_lower = (train_name or "").lower()
    has_pantry = any(k in name_lower for k in _ALWAYS_PANTRY_KEYWORDS)
    likely_pantry = has_pantry or any(k in name_lower for k in _PANTRY_KEYWORDS)

    if not train_name:
        # No name available (e.g. RailKit lookup failed) — can't rule
        # in/out confidently, so say so rather than guessing either way.
        status = "unknown"
    elif has_pantry:
        status = "yes"
    elif likely_pantry:
        status = "likely"
    else:
        status = "unlikely"

    return {
        "train_number": train_number,
        "train_name": train_name,
        "pantry_status": status,  # yes | likely | unlikely | unknown
        "menu": _STANDARD_MENU,
        "e_catering_note": "IRCTC e-catering lets you pre-order food from local restaurants for delivery at select stations, regardless of pantry car status.",
        "disclaimer": MENU_DISCLAIMER,
    }


# =============================================================================
# FEATURE: Station Amenities
# =============================================================================
STATION_AMENITIES_DISCLAIMER = (
    "General facility reference for major stations, compiled from publicly "
    "known station facilities — not a live feed. Availability/hours can "
    "change; confirm at the station or via IRCTC's station facility pages."
)

# code -> {name, food_court, executive_lounge, retiring_room, wifi, cloak_room, waiting_room}
_STATION_AMENITIES = {
    "NDLS": dict(name="New Delhi", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "HWH": dict(name="Howrah Jn", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "BCT": dict(name="Mumbai Central", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "CSMT": dict(name="Chhatrapati Shivaji Maharaj T.", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "MAS": dict(name="Chennai Central", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "SBC": dict(name="KSR Bengaluru", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "SC": dict(name="Secunderabad Jn", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "BZA": dict(name="Vijayawada Jn", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "PUNE": dict(name="Pune Jn", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "ADI": dict(name="Ahmedabad Jn", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "LKO": dict(name="Lucknow NR", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "PNBE": dict(name="Patna Jn", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "NGP": dict(name="Nagpur Jn", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "BPL": dict(name="Bhopal Jn (Habibganj/Rani Kamlapati)", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "CNB": dict(name="Kanpur Central", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "ASR": dict(name="Amritsar Jn", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "JP": dict(name="Jaipur Jn", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "GZB": dict(name="Ghaziabad Jn", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "VSKP": dict(name="Visakhapatnam Jn", food_court=True, executive_lounge=True, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "BBS": dict(name="Bhubaneswar", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "AGC": dict(name="Agra Cantt", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "JHS": dict(name="Jhansi Jn", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "GAYA": dict(name="Gaya Jn", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "DHN": dict(name="Dhanbad Jn", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
    "LDH": dict(name="Ludhiana Jn", food_court=True, executive_lounge=False, retiring_room=True, wifi=True, cloak_room=True, waiting_room=True),
}


def station_amenities(station_code: str) -> dict:
    station_code = (station_code or "").strip().upper()
    info = _STATION_AMENITIES.get(station_code)
    return {
        "station": station_code,
        "found": info is not None,
        "amenities": info,
        "disclaimer": STATION_AMENITIES_DISCLAIMER,
    }


# =============================================================================
# FEATURE: Coach Layout Visualization
# =============================================================================
COACH_LAYOUT_DISCLAIMER = (
    "Standard ICF coach geometry for this class — the exact rake composition "
    "(how many of each coach, their order) varies by train; check your "
    "ticket's coach/berth number for the actual assignment."
)

# Each bay describes one physical bay's berth codes in order (L=Lower,
# M=Middle, U=Upper, SL=Side Lower, SU=Side Upper); "windows" marks which
# positions in the bay sit right against a window.
_COACH_LAYOUTS = {
    "SL": {"label": "Sleeper (SL)", "total_berths": 72, "bays": 9, "berths_per_bay": ["L", "M", "U", "L", "M", "U", "SL", "SU"], "window_positions": ["L", "U", "SL", "SU"]},
    "3A": {"label": "AC 3-Tier (3A)", "total_berths": 64, "bays": 8, "berths_per_bay": ["L", "M", "U", "L", "M", "U", "SL", "SU"], "window_positions": ["L", "U", "SL", "SU"]},
    "3E": {"label": "AC 3-Tier Economy (3E)", "total_berths": 83, "bays": 10, "berths_per_bay": ["L", "M", "U", "L", "M", "U", "SL", "SM"], "window_positions": ["L", "U", "SL"]},
    "2A": {"label": "AC 2-Tier (2A)", "total_berths": 46, "bays": 6, "berths_per_bay": ["L", "U", "L", "U", "SL", "SU"], "window_positions": ["L", "U", "SL", "SU"]},
    "1A": {"label": "AC First Class (1A)", "total_berths": 22, "bays": 7, "berths_per_bay": ["L", "U"], "window_positions": ["L", "U"]},
    "CC": {"label": "AC Chair Car (CC)", "total_berths": 73, "bays": 15, "berths_per_bay": ["window", "aisle", "aisle", "middle", "window"], "window_positions": ["window"]},
    "EC": {"label": "Executive Chair Car (EC)", "total_berths": 56, "bays": 14, "berths_per_bay": ["window", "aisle", "aisle", "window"], "window_positions": ["window"]},
    "2S": {"label": "Second Sitting (2S)", "total_berths": 108, "bays": 18, "berths_per_bay": ["window", "middle", "aisle", "aisle", "middle", "window"], "window_positions": ["window"]},
}


_CAPACITY_RANGE_NOTES = {
    "1A": "Real 1A coaches carry 18-24 passengers depending on the cabin/coupe mix; this shows a common 22-berth arrangement (4 four-berth cabins + 3 two-berth coupes: A,B,F,G cabins, C,D,E coupes).",
    "3E": "Real 3E coaches carry 72-80 berths depending on the rake; this shows the 80-berth end of that range.",
    "CC": "Real CC coaches vary by rake (commonly 73-78 seats); this shows a verified 73-seat layout with a door-cutout row at each end.",
}


def coach_layout(travel_class: str) -> dict:
    travel_class = (travel_class or "").strip().upper()
    layout = _COACH_LAYOUTS.get(travel_class)
    return {
        "travel_class": travel_class,
        "found": layout is not None,
        "layout": layout,
        "seat_map": generate_seat_map(travel_class) if layout else None,
        "capacity_note": _CAPACITY_RANGE_NOTES.get(travel_class),
        "disclaimer": COACH_LAYOUT_DISCLAIMER,
    }


# -----------------------------------------------------------------------
# Real, sequentially-numbered seat map, generated from the standard, well
# documented ICF berth-numbering convention (the same one printed on the
# berth chart inside every SL/3A coach and shown on IRCTC/NTES-style seat
# charts): each bay of 8 in SL/3A runs Lower/Middle/Upper/Lower/Middle/
# Upper/Side-Lower/Side-Upper, numbered straight through (bay 1 = 1-8, bay
# 2 = 9-16, ...). 2A/1A/3E/CC/EC/2S use the same "generate real sequential
# numbers over a documented bay/row pattern" approach; where the exact
# rake varies train-to-train (2A coupe placement, CC door cut-outs, etc.)
# the total is rounded to the nearest clean bay/row count and flagged as
# approximate rather than presented as this specific train's live rake.
# -----------------------------------------------------------------------
def generate_seat_map(travel_class: str) -> Optional[dict]:
    travel_class = (travel_class or "").strip().upper()

    if travel_class in ("SL", "3A"):
        bay_count = 9 if travel_class == "SL" else 8
        bays = []
        n = 1
        for b in range(bay_count):
            left = [{"number": n, "type": "L"}, {"number": n + 1, "type": "M"}, {"number": n + 2, "type": "U"}]
            right = [{"number": n + 3, "type": "L"}, {"number": n + 4, "type": "M"}, {"number": n + 5, "type": "U"}]
            side = [{"number": n + 6, "type": "SL"}, {"number": n + 7, "type": "SU"}]
            bays.append({"bay": b + 1, "left": left, "right": right, "side": side})
            n += 8
        return {"kind": "bay", "bays": bays, "total": n - 1, "approximate": False}

    if travel_class == "3E":
        bay_count = 10
        bays = []
        n = 1
        for b in range(bay_count):
            left = [{"number": n, "type": "L"}, {"number": n + 1, "type": "M"}, {"number": n + 2, "type": "U"}]
            right = [{"number": n + 3, "type": "L"}, {"number": n + 4, "type": "M"}, {"number": n + 5, "type": "U"}]
            side = [{"number": n + 6, "type": "SL"}, {"number": n + 7, "type": "SM"}]
            bays.append({"bay": b + 1, "left": left, "right": right, "side": side})
            n += 8
        return {"kind": "bay", "bays": bays, "total": n - 1, "approximate": True}

    if travel_class == "2A":
        bays = []
        n = 1
        for b in range(7):  # 7 open bays of 6 (LB/UB facing pair + side lower/upper)
            left = [{"number": n, "type": "L"}, {"number": n + 1, "type": "U"}]
            right = [{"number": n + 2, "type": "L"}, {"number": n + 3, "type": "U"}]
            side = [{"number": n + 4, "type": "SL"}, {"number": n + 5, "type": "SU"}]
            bays.append({"bay": b + 1, "left": left, "right": right, "side": side})
            n += 6
        # + 1 closed coupe of 4 (no side berths) at the end, common on real 2A coaches
        left = [{"number": n, "type": "L"}, {"number": n + 1, "type": "U"}]
        right = [{"number": n + 2, "type": "L"}, {"number": n + 3, "type": "U"}]
        bays.append({"bay": 8, "left": left, "right": right, "side": [], "is_coupe": True})
        n += 4
        return {"kind": "bay", "bays": bays, "total": n - 1, "approximate": True}

    if travel_class == "1A":
        # Real cabin/coupe layout confirmed from an etrain.info-style 1A
        # diagram: 7 units in order Cabin-A(4), Cabin-B(4), Coupe-C(2),
        # Coupe-D(2), Coupe-E(2), Cabin-F(4), Cabin-G(4) = 22 berths,
        # plus a non-passenger attendant's chamber (not numbered).
        unit_sizes = [4, 4, 2, 2, 2, 4, 4]
        unit_letters = ["A", "B", "C", "D", "E", "F", "G"]
        bays = []
        n = 1
        for letter, size in zip(unit_letters, unit_sizes):
            left = [{"number": n, "type": "L"}, {"number": n + 1, "type": "U"}]
            right = [{"number": n + 2, "type": "L"}, {"number": n + 3, "type": "U"}] if size == 4 else []
            bays.append({"bay": letter, "left": left, "right": right, "side": [], "is_cabin": size == 4, "is_coupe": size == 2})
            n += size
        return {"kind": "bay", "bays": bays, "total": n - 1, "approximate": False}

    if travel_class in ("CC", "EC", "2S"):
        # Real row-by-row layouts confirmed from etrain.info seat charts
        # (plain sequential numbering, NOT airline-style row+letter):
        #   EC (LHB, 56 seats): uniform 2+2 across 14 rows.
        #   CC (Type 2, 73 seats): mostly 2+3 across the middle, but the
        #     row nearest each end door loses its window seat (2+2) - a
        #     real, verified door-cutout effect.
        #   2S (Non-AC, 108 seats): uniform 3+3 across 18 rows.
        if travel_class == "EC":
            row_specs = [(2, 2)] * 14
        elif travel_class == "CC":
            row_specs = [(2, 2)] + [(2, 3)] * 13 + [(2, 2)]
        else:  # 2S
            row_specs = [(3, 3)] * 18

        def seat_types(count, is_left):
            if count == 2:
                return ["window", "aisle"] if is_left else ["aisle", "window"]
            if count == 3:
                return ["window", "middle", "aisle"] if is_left else ["aisle", "middle", "window"]
            return ["window"] + ["middle"] * (count - 2) + ["aisle"] if count > 3 else ["window"] * count

        rows = []
        n = 1
        for r, (lcount, rcount) in enumerate(row_specs, start=1):
            seats = []
            for i, t in enumerate(seat_types(lcount, True)):
                seats.append({"number": n, "type": t, "aisle_after": i == lcount - 1})
                n += 1
            for t in seat_types(rcount, False):
                seats.append({"number": n, "type": t, "aisle_after": False})
                n += 1
            rows.append({"row": r, "seats": seats})
        return {"kind": "row", "rows": rows, "total": n - 1, "approximate": travel_class == "CC"}

    return None


# =============================================================================
# FEATURE: Seat/Berth Occupancy Estimate (probabilistic — not a live sensor)
# -----------------------------------------------------------------------
# CROWD-POSITION FOLLOW-UP: "which specific berths in a specific coach are
# occupied right now" is real per-passenger booking data Indian Railways
# does not expose through any API this app can reach (see
# crowd_prediction.py's identical disclaimer for the parallel
# coach-crowding estimate). What real data DOES exist, already fetched by
# this app's own live availability check (railway_api.get_seat_availability
# via extract_status_text), is the class's aggregate booking count — "42
# AVAILABLE" / "87 WL" / "12 RAC" — for the exact train/date/class/quota
# being viewed. That real aggregate count is used here to shade a
# plausible fraction of the coach's real, sequentially-numbered berths
# (from generate_seat_map) as "likely occupied" vs "likely open" — a
# genuine improvement over a bare geometry diagram, but still explicitly
# labelled an estimate distribution, never presented as which exact berth
# a specific passenger holds.
# =============================================================================
SEAT_OCCUPANCY_DISCLAIMER = (
    "Indian Railways doesn't publish live per-berth booking data through any "
    "API this app can reach, so no source exists to show which exact berth is "
    "occupied. This shading distributes the real aggregate booking count "
    "(the same AVAILABLE/RAC/WL figure shown in Search) across the coach's "
    "real berth numbers as a plausible estimate — it is not a live sensor "
    "reading, and the actual free berth may not be the one shown here."
)


def parse_availability_count(status_text: Optional[str]) -> Optional[dict]:
    """Pulls a status keyword (AVAILABLE/RAC/WL/CNF) and a numeric count out
    of RailKit's real free-text status string (e.g. "AVAILABLE-42",
    "WL87", "RAC 12", "REGRET/WL"). Returns None if no number is present
    at all (e.g. a bare "REGRET") rather than fabricating one."""
    if not status_text:
        return None
    text = status_text.upper()
    m = re.search(r"\b(AVAILABLE|AVL|RAC|WL|CNF)\D{0,3}(\d+)", text)
    if not m:
        return None
    kind_raw, count = m.group(1), int(m.group(2))
    kind = "AVAILABLE" if kind_raw in ("AVAILABLE", "AVL") else kind_raw
    return {"kind": kind, "count": count}


def estimate_seat_occupancy(travel_class: str, status_text: Optional[str], seed: str = "") -> Optional[dict]:
    """Shades the real berth-numbering seat map (generate_seat_map) with a
    plausible occupied/open estimate derived from the real aggregate
    availability count for this train/date/class/quota. Returns None if
    there's no known layout for this class or no parseable count to work
    from — never invents a fill level out of nothing."""
    travel_class = (travel_class or "").strip().upper()
    seat_map = generate_seat_map(travel_class)
    if not seat_map:
        return None
    total = seat_map["total"]
    parsed = parse_availability_count(status_text)

    if parsed is None:
        return {
            "total": total, "estimated_occupied": None, "occupied_berths": [],
            "basis": "no_count", "disclaimer": SEAT_OCCUPANCY_DISCLAIMER,
        }

    kind, count = parsed["kind"], parsed["count"]
    if kind == "AVAILABLE":
        occupied_fraction = max(0.0, min(1.0, (total - count) / total)) if total else 0.0
    elif kind == "RAC":
        # RAC means the confirmed quota is already exhausted (RAC berths
        # are shared, 2 passengers per side-berth) — a real signal that
        # the coach is at/near full, not a count of open berths itself.
        occupied_fraction = 0.95
    else:  # WL / CNF-only-implies-full - waitlist means zero confirmed berths left
        occupied_fraction = 1.0

    occupied_n = round(occupied_fraction * total)
    # Deterministic (stable across refreshes for the same train/date/class)
    # pseudo-distribution across the REAL berth numbers this coach has —
    # not a live read, just a repeatable way to pick which numbers to shade.
    digest = hashlib.sha256(f"{seed}:{travel_class}:{status_text}".encode()).hexdigest()
    order = sorted(range(1, total + 1), key=lambda n: hashlib.sha256(f"{digest}:{n}".encode()).hexdigest())
    occupied_berths = sorted(order[:occupied_n])

    return {
        "total": total,
        "estimated_occupied": occupied_n,
        "estimated_available": total - occupied_n,
        "occupied_berths": occupied_berths,
        "basis": kind,
        "source_status_text": status_text,
        "disclaimer": SEAT_OCCUPANCY_DISCLAIMER,
    }


# =============================================================================
# FEATURE: Seat Recommendation Engine
# =============================================================================
_PREFERENCE_ADVICE = {
    "window": "Ask for a Lower or Upper berth (SL/3A) or an A/E seat (CC/2S) / A/D seat (EC) — those sit against the window.",
    "lower_berth": "Lower berths are easiest for boarding/alighting and usable anytime (Middle/Upper berths fold down only at night). Senior citizens (60+) and women travelling alone/with children get automatic lower-berth preference at booking if available.",
    "avoid_middle": "Avoid Middle berths in SL/3A — they fold down only during designated sleeping hours and block the Lower berth's seating space in between.",
    "family_together": "Book a full Side bay (Side Lower + Side Upper) or an adjacent Lower+Middle+Upper bay together so the group isn't split across the coach.",
    "quiet_corner": "Side Lower/Side Upper berths (SL/3A/2A) or end-of-coach bays tend to be quieter, away from the main aisle bay's foot traffic.",
    "easy_toilet_access": "Bays closest to either end of the coach (bay 1 or the last bay) are nearest the toilets/doorway.",
}


def seat_recommend(travel_class: str, preferences: List[str], trip_profile: Optional[dict] = None) -> dict:
    travel_class = (travel_class or "").strip().upper()
    layout_info = _COACH_LAYOUTS.get(travel_class)
    preferences = preferences or []
    advice = [_PREFERENCE_ADVICE[p] for p in preferences if p in _PREFERENCE_ADVICE]
    result = {
        "travel_class": travel_class,
        "layout_found": layout_info is not None,
        "layout_label": layout_info["label"] if layout_info else None,
        "advice": advice,
        "note": "Exact berth/seat is allotted by the reservation system at booking/chart preparation — this only tells you what to look for or request, not a guaranteed seat number.",
    }
    profile_result = _berth_recommendation_from_trip_profile(travel_class, trip_profile)
    if profile_result:
        result.update(profile_result)
    return result


_HAS_BERTHS = {"SL", "3A", "3E", "2A", "1A"}  # sleeper classes with real berth tiers; CC/EC/2S are seat-only


def _berth_recommendation_from_trip_profile(travel_class: str, trip_profile: Optional[dict]) -> Optional[dict]:
    """FEATURE: Best Seat/Berth Automatic Recommendation Based on Trip
    Profile. Takes real inputs the passenger actually knows about their
    OWN trip (departure/arrival clock time or a duration, who they're
    travelling with, age) and applies documented, real rules (IRCTC's
    actual automatic lower-berth preference for seniors/women-with-
    children; the plain fact that Middle/Upper berths only fold down
    during night hours) plus one genuine, explainable heuristic (a short
    daytime trip doesn't need a Lower berth's daytime bench-seating value
    the way a long/overnight one does) — never a fabricated booking
    probability."""
    if not trip_profile:
        return None

    dep_min = _hhmm_to_minutes_local(trip_profile.get("departure_time"))
    arr_min = _hhmm_to_minutes_local(trip_profile.get("arrival_time"))
    duration_hours = trip_profile.get("duration_hours")
    if duration_hours is None and dep_min is not None and arr_min is not None:
        diff = arr_min - dep_min
        if diff < 0:
            diff += 24 * 60
        duration_hours = round(diff / 60.0, 1)

    # "Overnight" = the journey spans the typical 22:00-06:00 sleeping
    # window, OR it's simply long enough (>=6h) that passengers will want
    # to lie down regardless of the exact clock times.
    night_window = lambda m: m is not None and (m >= 22 * 60 or m <= 6 * 60)
    overnight = bool(trip_profile.get("overnight")) or night_window(dep_min) or night_window(arr_min) or (
        duration_hours is not None and duration_hours >= 6
    )

    travelers = (trip_profile.get("travelers") or "solo").strip().lower()
    age = trip_profile.get("age")
    is_senior = travelers == "senior" or (isinstance(age, (int, float)) and age >= 60)
    is_with_children = travelers in ("family", "with_children", "with_kids")

    reasoning = []
    if travel_class not in _HAS_BERTHS:
        # Seat-only classes (CC/EC/2S): the real, useful axis is window vs
        # aisle, not lower/middle/upper.
        recommended = "window" if (duration_hours or 0) >= 3 else "aisle"
        reasoning.append(
            f"{travel_class} has seats, not berths — for a "
            f"{'longer' if recommended == 'window' else 'shorter'} trip like this, {'a' if recommended == 'window' else 'an'} {recommended} seat "
            f"{'gives you a headrest wall and a view for the ride' if recommended == 'window' else 'gets you out to stretch/detrain faster'}."
        )
        return {
            "trip_profile_used": True,
            "duration_hours": duration_hours,
            "overnight": overnight,
            "recommended_seat_type": recommended,
            "recommendation_reasoning": reasoning,
        }

    if is_senior:
        recommended = "Lower"
        reasoning.append("Senior citizens (60+) get automatic Lower-berth preference at booking when available — "
                          "always request Lower for this reason alone, regardless of trip length.")
    elif is_with_children:
        recommended = "Lower"
        reasoning.append("Travelling with young children: Lower berth avoids climbing with a child and doubles as "
                          "seating for the group during the day. Women travelling with children also get automatic "
                          "Lower-berth preference at booking.")
    elif overnight:
        recommended = "Lower"
        reasoning.append(f"{'This spans typical sleeping hours' if (night_window(dep_min) or night_window(arr_min)) else f'At {duration_hours}h, this is a long enough trip'} "
                          "that you'll want to lie down for real — Lower berth is usable to sleep on anytime, while "
                          "Middle/Upper only fold down during designated night hours.")
        if travelers == "solo":
            reasoning.append("Travelling solo overnight: a Side Lower/Side Upper berth is a quieter option, away "
                              "from the busier main-bay aisle traffic, if you'd rather trade a little space for quiet.")
    else:
        recommended = "Upper"
        reasoning.append(f"A {'short' if duration_hours and duration_hours < 6 else 'daytime'} trip like this doesn't "
                          "need Lower berth's main advantage (usable as a bench to sit on all day) since you'll "
                          "mostly be sitting anyway — Upper (or Side Upper) berths are usually easier to get "
                          "confirmed and give you your own space to stack luggage without disturbing anyone below.")

    return {
        "trip_profile_used": True,
        "duration_hours": duration_hours,
        "overnight": overnight,
        "recommended_berth_type": recommended,
        "recommendation_reasoning": reasoning,
    }


def _hhmm_to_minutes_local(t) -> Optional[int]:
    """Same tolerant leading-'HH:MM' regex parse as
    smart_features._hhmm_to_minutes — handles trailing seconds/annotations
    a strict split would reject."""
    if not t:
        return None
    match = re.match(r"^\s*(\d{1,2}):(\d{2})", str(t))
    if not match:
        return None
    h, m = int(match.group(1)), int(match.group(2))
    return h * 60 + m if 0 <= h <= 27 and 0 <= m <= 59 else None


# =============================================================================
# FEATURE: Cancellation Refund Estimator (IRCTC published slabs, simplified)
# =============================================================================
REFUND_DISCLAIMER = (
    "Based on IRCTC's published general cancellation-charge slabs — exact "
    "amounts can differ for Tatkal/Premium Tatkal (no refund on confirmed "
    "Tatkal tickets except a few exceptions), circular journey, or special "
    "trains. Always verify the final figure on IRCTC before cancelling."
)

# Flat minimum cancellation charge per class when cancelled >48h before
# departure (confirmed ticket), per IRCTC's published slabs.
_FLAT_CHARGE_BY_CLASS = {
    "1A": 240, "EC": 240, "2A": 200, "CC": 200, "3A": 180, "3E": 180,
    "SL": 120, "2S": 60,
}
# RAC/WL clerkage-only charge when cancelled before chart preparation.
_CLERKAGE_BY_CLASS = {
    "1A": 60, "EC": 60, "2A": 60, "CC": 60, "3A": 60, "3E": 60,
    "SL": 60, "2S": 30,
}


def estimate_refund(fare_amount: float, travel_class: str, ticket_status: str, hours_before_departure: float) -> dict:
    travel_class = (travel_class or "SL").strip().upper()
    ticket_status = (ticket_status or "confirmed").strip().lower()  # confirmed | rac | waitlist
    flat_charge = _FLAT_CHARGE_BY_CLASS.get(travel_class, 120)
    clerkage = _CLERKAGE_BY_CLASS.get(travel_class, 60)

    breakdown = []
    if ticket_status in ("rac", "waitlist"):
        if hours_before_departure is not None and hours_before_departure < 0:
            deduction = fare_amount  # already departed / auto-cancelled after chart prep without TDR
            breakdown.append("Cancelled after chart preparation without a TDR filed — refund typically requires a TDR claim; shown here as no automatic refund.")
        else:
            deduction = min(clerkage, fare_amount)
            breakdown.append(f"RAC/Waitlisted ticket cancelled before chart preparation — only the clerkage charge (₹{clerkage}) applies.")
    else:  # confirmed
        if hours_before_departure is None:
            deduction = flat_charge
            breakdown.append(f"No departure time given — showing the >48h flat minimum charge (₹{flat_charge}) for {travel_class}.")
        elif hours_before_departure >= 48:
            deduction = flat_charge
            breakdown.append(f"Cancelled ≥48h before departure — flat minimum charge (₹{flat_charge}) for {travel_class}.")
        elif hours_before_departure >= 12:
            deduction = max(fare_amount * 0.25, flat_charge)
            breakdown.append("Cancelled between 12h and 48h before departure — 25% of fare deducted (subject to the class minimum).")
        elif hours_before_departure >= 4:
            deduction = max(fare_amount * 0.50, flat_charge)
            breakdown.append("Cancelled between 4h and 12h before departure — 50% of fare deducted (subject to the class minimum).")
        else:
            deduction = fare_amount
            breakdown.append("Cancelled within 4h of departure / after chart preparation — no refund on a confirmed ticket via normal cancellation (a TDR may apply only for specific documented reasons).")

    deduction = round(min(deduction, fare_amount), 2)
    refund = round(fare_amount - deduction, 2)
    return {
        "fare_amount": fare_amount,
        "travel_class": travel_class,
        "ticket_status": ticket_status,
        "hours_before_departure": hours_before_departure,
        "deduction": deduction,
        "estimated_refund": refund,
        "breakdown": breakdown,
        "disclaimer": REFUND_DISCLAIMER,
    }


# =============================================================================
# FEATURE: Live Station Crowd Estimation
# =============================================================================
# HONEST NOTE: no provider gives a real sensor-based "how crowded is this
# platform right now" figure. This is a heuristic built from something
# real, though: the actual count of trains RailKit reports due at/through
# the station in the next `hours`, combined with a documented time-of-day
# multiplier (rush hours are busier). It is always labeled an ESTIMATE.
STATION_CROWD_DISCLAIMER = (
    "Estimated from the real number of trains RailKit reports due at this "
    "station in the window, combined with typical time-of-day travel "
    "patterns - not a live sensor/camera crowd count, which no provider "
    "here offers. Treat as a rough guide, not a precise figure."
)

_RUSH_HOUR_MULTIPLIER = {  # hour (0-23) -> multiplier on the base train-frequency score
    **{h: 1.6 for h in (7, 8, 9, 17, 18, 19, 20)},   # morning + evening rush
    **{h: 1.2 for h in (6, 10, 16, 21)},
    **{h: 0.5 for h in (0, 1, 2, 3, 4)},              # late night
}


def estimate_station_crowd(station_code: str, train_count: int, hours_window: int, current_hour: int) -> dict:
    multiplier = _RUSH_HOUR_MULTIPLIER.get(current_hour, 1.0)
    # trains/hour as the base signal, scaled by rush-hour multiplier
    trains_per_hour = train_count / max(hours_window, 1)
    score = trains_per_hour * multiplier
    if score >= 2.5:
        level, label = 4, "Very Busy"
    elif score >= 1.5:
        level, label = 3, "Busy"
    elif score >= 0.7:
        level, label = 2, "Moderate"
    elif score > 0:
        level, label = 1, "Light"
    else:
        level, label = 0, "Very Quiet"
    return {
        "station": station_code,
        "trains_in_window": train_count,
        "hours_window": hours_window,
        "is_rush_hour": multiplier > 1.3,
        "level": level,
        "label": label,
        "disclaimer": STATION_CROWD_DISCLAIMER,
    }


def extract_station_train_count(data: dict) -> int:
    """Defensive count of trains in a get_live_at_station() response -
    field names for the list aren't documented, so try the common shapes
    rather than assuming one and silently returning 0 for the rest."""
    if not isinstance(data, dict):
        return 0
    payload = data.get("data", data)
    if isinstance(payload, list):
        return len(payload)
    if isinstance(payload, dict):
        for key in ("trains", "trainList", "liveTrains", "results", "list"):
            val = payload.get(key)
            if isinstance(val, list):
                return len(val)
    return 0


# =============================================================================
# FEATURE: Smart Luggage/Parcel Tracking
# =============================================================================
# HONEST NOTE: Indian Railways' parcel/luggage tracking runs through a
# separate system (Parcel Management System) that RailKit does not expose
# an API for. Rather than fabricate tracking data, this points to the
# real official portal and explains that clearly - no invented statuses.
PARCEL_INFO = {
    "available": False,
    "reason": "No connected data provider exposes Indian Railways' parcel/luggage tracking (a separate system from passenger PNR/train data) - so this can't show real tracking status without inventing it.",
    "official_portal_url": "https://www.parcel.indianrail.gov.in",
    "official_portal_label": "Indian Railways Parcel Management System",
    "what_you_can_track_there": "Parcel booking status, RR (Railway Receipt) number tracking, and freight/parcel charges.",
}


def parcel_info() -> dict:
    return dict(PARCEL_INFO)


# =============================================================================
# FEATURE: Offline Station Info export (bulk, for client-side caching)
# =============================================================================
def offline_station_bundle(station_coords: dict) -> dict:
    """Merges the curated coordinates table with whatever curated amenities
    exist, into one compact bundle the frontend fetches once and caches
    locally (localStorage/AsyncStorage) for offline lookup. Only ever
    includes stations actually present in station_coords - never invents
    an entry."""
    bundle = {}
    for code, info in station_coords.items():
        entry = {"name": info.get("name"), "lat": info.get("lat"), "lng": info.get("lng")}
        amen = _STATION_AMENITIES.get(code)
        if amen:
            entry["amenities"] = amen
        bundle[code] = entry
    return bundle



def extract_status_text(data: dict, date_ddmmyyyy: Optional[str] = None) -> Optional[str]:
    """Pulls the real availability status text out of a RailKit response.

    GN quota (and similar) return a flat top-level status field, which the
    original flat-only check below still handles. But quotas with their own
    booking-window/ARP restriction (e.g. Tatkal) - and low-inventory classes
    like 1A - come back as a real, successful response with a NESTED
    per-date `availability[]` array (availability[0].status /
    .availabilityText / .rawStatus) instead. The flat check alone silently
    returns None for those even though real data came back, so we fall back
    to a deep search for that array (picking the entry matching the
    requested date when we can tell dates apart) before giving up."""
    if not isinstance(data, dict):
        return None
    payload = data.get("data", data)
    if not isinstance(payload, dict):
        return None

    # 1) Flat top-level shape (GN quota etc.) - unchanged, backward compatible.
    for key in ("availabilityStatus", "status", "availability_status", "currentStatus"):
        if payload.get(key):
            return str(payload[key])

    # 2) Nested per-date availability[] array (Tatkal-type quotas, 1A/other
    #    low-inventory classes) - deep-search the whole response for it.
    rows = deep_find_list_of_dicts(payload, ["availability", "availabilityList", "availability_list"])
    if rows:
        entry = None
        if date_ddmmyyyy:
            candidates = {date_ddmmyyyy}
            try:
                d, m, y = date_ddmmyyyy.split("-")
                candidates.add(f"{y}-{m}-{d}")
                candidates.add(f"{d}/{m}/{y}")
            except ValueError:
                pass
            for row in rows:
                row_date = str(row.get("date") or row.get("journeyDate") or row.get("doj") or "")
                if row_date in candidates:
                    entry = row
                    break
        if entry is None:
            entry = rows[0]
        for key in ("status", "availabilityText", "rawStatus", "availability_status", "availabilityStatus"):
            if entry.get(key):
                return str(entry[key])

    # 3) Last resort: a full deep scan for any status-shaped field anywhere
    #    in the response, so a real answer isn't lost to an unmatched shape.
    return deep_find(payload, ["status", "availabilityStatus", "availabilityText", "rawStatus", "currentStatus"])


def extract_prediction_info(data: dict) -> Optional[dict]:
    """When there's no direct status (e.g. an ARP-restricted quota that
    only offers a prediction), surface RailKit's real prediction fields
    instead of leaving the caller with nothing. Never fabricated - returns
    None if none of these fields are actually present."""
    if not isinstance(data, dict):
        return None
    payload = data.get("data", data)
    if not isinstance(payload, dict):
        return None
    rows = deep_find_list_of_dicts(payload, ["availability", "availabilityList", "availability_list"])
    source = rows[0] if rows else payload
    prediction = deep_find(source, ["prediction", "predictionText"])
    percentage = deep_find(source, ["predictionPercentage", "prediction_percentage"])
    can_book = deep_find(source, ["canBook", "can_book"])
    if prediction is None and percentage is None and can_book is None:
        return None
    return {"prediction": prediction, "prediction_percentage": percentage, "can_book": can_book}


def extract_fare_amount(data: dict) -> Optional[float]:
    if not isinstance(data, dict):
        return None
    payload = data.get("data", data)
    if not isinstance(payload, dict):
        return None
    for key in ("totalFare", "total_fare", "fare", "baseFare", "amount", "totalAmount"):
        val = payload.get(key)
        if isinstance(val, (int, float)):
            return float(val)
        if isinstance(val, str):
            m = re.search(r"[\d,]+(\.\d+)?", val)
            if m:
                try:
                    return float(m.group(0).replace(",", ""))
                except ValueError:
                    pass
    return None


# =============================================================================
# FEATURE: Personalized Travel Assistant (Profile & History)
# =============================================================================
# HONEST NOTE: everything here is computed from trip history the person
# themselves entered (kept client-side, same pattern as "My Trains"/
# "Delay Alerts" elsewhere in this file) - real arithmetic over real
# entries, not a trained model and not data about them from anywhere
# else. "Preferred class" is just the most common value they logged;
# "next occurrence" is plain date math, not a prediction.
_WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def summarize_travel_history(history: list) -> dict:
    """history: list of {source, dest, travel_class, date (dd-mm-yyyy)}.
    Returns the frequent route, preferred class, home station (most common
    source), and - if a weekday recurs at least twice - a booking reminder
    with the real next calendar date that weekday falls on."""
    if not history:
        return {"has_data": False}

    route_counts, class_counts, source_counts, weekday_counts = {}, {}, {}, {}
    for trip in history:
        src = (trip.get("source") or "").strip().upper()
        dst = (trip.get("dest") or "").strip().upper()
        cls = (trip.get("travel_class") or "").strip().upper()
        if src and dst:
            route_counts[(src, dst)] = route_counts.get((src, dst), 0) + 1
            source_counts[src] = source_counts.get(src, 0) + 1
        if cls:
            class_counts[cls] = class_counts.get(cls, 0) + 1
        date_str = trip.get("date")
        if date_str:
            try:
                d = datetime.strptime(date_str, "%d-%m-%Y")
                weekday_counts[d.weekday()] = weekday_counts.get(d.weekday(), 0) + 1
            except ValueError:
                pass

    frequent_route = max(route_counts.items(), key=lambda kv: kv[1]) if route_counts else None
    preferred_class = max(class_counts.items(), key=lambda kv: kv[1])[0] if class_counts else None
    home_station = max(source_counts.items(), key=lambda kv: kv[1])[0] if source_counts else None

    reminder = None
    if weekday_counts:
        top_weekday, top_count = max(weekday_counts.items(), key=lambda kv: kv[1])
        if top_count >= 2:
            today = datetime.now()
            days_ahead = (top_weekday - today.weekday()) % 7
            days_ahead = days_ahead or 7  # if today IS that weekday, point to next week's, not today
            next_date = today + timedelta(days=days_ahead)
            reminder = {
                "weekday": _WEEKDAY_NAMES[top_weekday],
                "occurrences_logged": top_count,
                "next_date": next_date.strftime("%d-%m-%Y"),
                "days_away": days_ahead,
                "route": f"{frequent_route[0][0]} → {frequent_route[0][1]}" if frequent_route else None,
                "preferred_class": preferred_class,
            }

    return {
        "has_data": True,
        "trip_count": len(history),
        "frequent_route": {"source": frequent_route[0][0], "dest": frequent_route[0][1], "count": frequent_route[1]} if frequent_route else None,
        "preferred_class": preferred_class,
        "home_station": home_station,
        "booking_reminder": reminder,
    }


# =============================================================================
# FEATURE: "Near Me" Real-Time Platform Information
# =============================================================================
# HONEST NOTE: RailKit's live-at-station response format for per-train
# platform numbers isn't documented, and many providers simply don't
# report platform for still-inbound trains at all. This only ever shows
# a platform for a train when the provider's own response actually
# includes one - stations/trains with no reported platform show as
# "not reported" rather than a guess (that's what the separate Platform
# Predictor tool further up is for, and it's clearly labeled a pattern
# estimate, never mixed in here).
def _first_present(d: dict, keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d.get(k)
    return default


def parse_station_live_trains(data: dict) -> list:
    if not isinstance(data, dict):
        return []
    payload = data.get("data", data)
    rows = None
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        for key in ("trains", "trainList", "liveTrains", "results", "list"):
            if isinstance(payload.get(key), list):
                rows = payload[key]
                break
    if rows is None:
        return []

    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        out.append({
            "train_number": _first_present(row, ("trainNumber", "train_number", "number")),
            "train_name": _first_present(row, ("trainName", "train_name", "name")),
            "scheduled_time": _first_present(row, ("scheduledTime", "scheduled_time", "arrivalTime", "arrival_time", "std", "sta")),
            "platform": _first_present(row, ("platform", "platformNumber", "platform_number", "pf")),
            "status": _first_present(row, ("status", "currentStatus")),
        })
    return out


def build_platform_heatmap(trains: list) -> dict:
    occupied = {}
    unreported = 0
    for t in trains:
        pf = t.get("platform")
        if pf not in (None, ""):
            occupied.setdefault(str(pf), []).append(t)
        else:
            unreported += 1
    return {
        "platforms": [{"platform": pf, "trains": ts} for pf, ts in sorted(occupied.items(), key=lambda kv: kv[0])],
        "occupied_count": len(occupied),
        "trains_without_reported_platform": unreported,
        "platform_data_available": len(occupied) > 0,
    }


def next_arrival(trains: list) -> Optional[dict]:
    now_min = datetime.now().hour * 60 + datetime.now().minute
    best, best_diff = None, None
    for t in trains:
        m = _to_minutes_safe(t.get("scheduled_time"))
        if m is None:
            continue
        diff = (m - now_min) % 1440  # minutes until this time, wrapping past midnight
        if best_diff is None or diff < best_diff:
            best, best_diff = t, diff
    return best


def _to_minutes_safe(t: Optional[str]) -> Optional[int]:
    if not t:
        return None
    m = re.match(r"^(\d{1,2}):(\d{2})", t.strip())
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if 0 <= h <= 23 and 0 <= mi <= 59:
        return h * 60 + mi
    return None


# =============================================================================
# FEATURE: "Station Navigator" — Point of Interest Finder
# -----------------------------------------------------------------------
# HONEST NOTE (same rule as everywhere else in this file — see the module
# docstring): no Indian Railways station publishes a real indoor facility
# map through any API this app can reach. What IS real here: the curated
# entrance-side names for a handful of very well-documented major termini
# (data/station_poi.json — sourced from genuinely public, widely-known
# facts, e.g. New Delhi's Ajmeri Gate/Paharganj sides, Howrah's Old/New
# complex split), and this station's real amenity flags (reused as-is from
# _STATION_AMENITIES) and real/topology-estimated platform count (reused
# from _estimated_platform_count). WHICH platform a specific facility sits
# on is deliberately never invented — instead this composes those real
# pieces with the same generic, clearly-labelled Indian-station-layout
# convention platform_navigation_guide already uses (platform 1 near the
# main concourse/entrance; higher platforms via FOB/subway; food courts
# and waiting rooms typically clustered near the main concourse) so the
# guidance is honest about what's confirmed vs. typical.
# =============================================================================
_STATION_POI_PATH = os.path.join(os.path.dirname(__file__), "data", "station_poi.json")


def _load_station_poi() -> dict:
    try:
        with open(_STATION_POI_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


_STATION_POI = _load_station_poi()

STATION_NAVIGATOR_DISCLAIMER = (
    "No Indian Railways station publishes a real indoor facility map through any API this "
    "app can reach. Entrance-side names (where shown) are genuinely public, well-documented "
    "facts about this station; which platform holds which facility is generic Indian-station "
    "convention (main concourse near platform 1, escalators/lifts at the foot overbridge/"
    "subway) combined with this station's real listed amenities — not a live or confirmed "
    "indoor map. Confirm exact locations with station signage or staff."
)

_GENERIC_FACILITY_NOTES = {
    "food_court": "Food courts/stalls are typically clustered near the main concourse (platform 1 side) and sometimes duplicated on the foot overbridge.",
    "cloak_room": "The cloak room (luggage deposit) is almost always near the main entrance/platform 1 concourse, not on an intermediate platform.",
    "waiting_room": "Waiting rooms (general + retiring rooms, where available) are usually near the main concourse on platform 1, with smaller ones sometimes on the far platforms too.",
    "retiring_room": "Retiring rooms (if the station has them) are typically booked/accessed near the station manager's office on the main concourse.",
    "executive_lounge": "Executive lounges (where present) are usually near the main entrance/concourse, sometimes requiring a short walk from the platform.",
    "wifi": "Railtel's free station WiFi typically covers the main concourse and platforms alike where available.",
}


def station_navigator(station_code: str) -> dict:
    station_code = (station_code or "").strip().upper()
    poi = _STATION_POI.get(station_code)
    amenities_info = _STATION_AMENITIES.get(station_code)
    n_platforms, platform_basis = _estimated_platform_count(station_code)

    facilities = []
    if amenities_info:
        for key, present in amenities_info.items():
            if key == "name" or not present:
                continue
            facilities.append({
                "facility": key,
                "label": key.replace("_", " ").title(),
                "confirmed_present": True,
                "typical_location_note": _GENERIC_FACILITY_NOTES.get(key, "Typically near the main concourse."),
            })

    return {
        "station": station_code,
        "name": (poi or {}).get("name") or (amenities_info or {}).get("name") or station_code,
        "found": bool(poi or amenities_info),
        "entrance_sides": (poi or {}).get("entrance_sides") or [],
        "notable_note": (poi or {}).get("notable_note"),
        "station_platform_count": n_platforms,
        "platform_count_basis": platform_basis,
        "layout_guidance": [
            "Platform 1 is almost always the one directly alongside the main entrance/concourse — no foot overbridge needed to reach it.",
            "Higher-numbered platforms are reached via a foot overbridge (FOB) or subway, signposted by platform-number range, with escalators/lifts usually located at the FOB/subway access points.",
            "The main concourse (near platform 1) is where cloak rooms, waiting rooms, and most food counters cluster — plan to use these before crossing over to a far platform.",
        ],
        "facilities": facilities,
        "disclaimer": STATION_NAVIGATOR_DISCLAIMER,
    }


# =============================================================================
# FEATURE: "Optimal Booking Window" Predictor
# -----------------------------------------------------------------------
# HONEST NOTE: no provider this app has access to exposes historical
# booking-demand data (how full a train/class typically gets N days before
# departure, by day-of-week). What IS real and used here: (1) IRCTC's own
# PUBLISHED, DOCUMENTED booking rules — the 120-day Advance Reservation
# Period (ARP), and Tatkal quota opening at 10:00 AM (AC classes) / 11:00
# AM (non-AC classes) exactly one day before the journey date (excluding
# the journey date itself) — these are real rules, not estimates; (2) the
# REAL current aggregate availability status for this exact train/route/
# date/class/quota, pulled live the same way Search/Fare Heatmap do; (3)
# this server process's own REAL logged crowd-prediction scores for this
# train so far this session (analytics.py) — never synthetic demand data
# presented as a trend.
# =============================================================================
BOOKING_WINDOW_DISCLAIMER = (
    "Combines IRCTC's real published booking rules (120-day Advance Reservation Period; "
    "Tatkal opens 10:00 AM for AC classes / 11:00 AM for non-AC classes, exactly one day "
    "before the journey date) with this train's real current availability status. No "
    "provider this app can reach publishes historical booking-demand data, so this does not "
    "claim to know how full this specific train/date typically gets — it tells you the real "
    "rules and the real current status, not a demand forecast."
)

_AC_TATKAL_CLASSES = {"1A", "2A", "3A", "3E", "CC", "EC"}


def booking_window_advice(
    travel_class: str, date_ddmmyyyy: Optional[str], status_kind: Optional[str],
    status_count: Optional[int], crowd_score_history: Optional[list] = None,
) -> dict:
    travel_class = (travel_class or "SL").strip().upper()
    advice = []
    urgency = "unknown"
    days_until = None

    if date_ddmmyyyy:
        try:
            journey_date = datetime.strptime(date_ddmmyyyy.strip(), "%d-%m-%Y")
            days_until = (journey_date.date() - datetime.now().date()).days
        except ValueError:
            journey_date = None
    else:
        journey_date = None

    if days_until is not None:
        if days_until < 0:
            advice.append("This date has already passed.")
        elif days_until > 120:
            advice.append(
                f"General quota booking for this date hasn't opened yet — IRCTC's Advance Reservation "
                f"Period (ARP) is 120 days, so booking opens on "
                f"{(journey_date - timedelta(days=120)).strftime('%d-%m-%Y')}."
            )
        elif days_until == 0:
            advice.append("This is today's journey — general quota booking closed at chart preparation; Tatkal (if not already exhausted) is your only remaining new-booking option.")
        elif days_until == 1:
            tatkal_time = "10:00 AM" if travel_class in _AC_TATKAL_CLASSES else "11:00 AM"
            advice.append(f"Tatkal quota for tomorrow's journey opens today at {tatkal_time} ({'AC' if travel_class in _AC_TATKAL_CLASSES else 'non-AC'} class rule) — be logged in and ready a few minutes early if general quota is already full.")
        else:
            advice.append(f"{days_until} day(s) until departure — general quota is open (booked within the 120-day ARP window). Tatkal for this date opens the day before, at {'10:00 AM' if travel_class in _AC_TATKAL_CLASSES else '11:00 AM'}.")

        weekday = journey_date.weekday() if journey_date else None
        if weekday is not None and weekday in (4, 5, 6):  # Fri/Sat/Sun
            advice.append("This date falls on a weekend (Fri/Sat/Sun) — these dates typically see higher demand than midweek travel; booking earlier in the ARP window is generally safer.")

    # Real current status -> urgency signal (not a forecast, a live snapshot).
    if status_kind == "AVAILABLE":
        urgency = "open"
        advice.append(f"Current status: AVAILABLE ({status_count if status_count is not None else 'some'} seats) — booking now is a safe window; no sign of a rush on this specific date/class yet.")
    elif status_kind == "RAC":
        urgency = "tightening"
        advice.append("Current status: RAC — confirmed berths are exhausted; book now if RAC is acceptable, or watch for cancellations (availability can open up closer to the date/chart preparation).")
    elif status_kind == "WL":
        urgency = "tight"
        advice.append(f"Current status: WL{status_count if status_count is not None else ''} — this train/date/class is in high demand right now; an earlier booking window (or an alternate train/class/quota) would have had (and may still have) better odds.")
    else:
        advice.append("No current live availability status could be fetched to gauge real-time demand — the timing guidance above (ARP/Tatkal) still applies regardless.")

    crowd_trend = None
    if crowd_score_history:
        crowd_trend = {
            "points_this_session": len(crowd_score_history),
            "series": crowd_score_history,
            "note": "Real crowd-prediction scores logged for this train during this server session only — not historical demand data, and empty until someone checks this train's crowd prediction.",
        }

    return {
        "travel_class": travel_class,
        "date": date_ddmmyyyy,
        "days_until_departure": days_until,
        "urgency": urgency,
        "current_status_kind": status_kind,
        "current_status_count": status_count,
        "advice": advice,
        "session_crowd_trend": crowd_trend,
        "disclaimer": BOOKING_WINDOW_DISCLAIMER,
    }


# =============================================================================
# FEATURE: Coach & Seat "Find My Coach" Guide
# -----------------------------------------------------------------------
# HONEST NOTE: Indian Railways does not publish per-train rake composition
# (the exact order coaches are marshalled in, or which end the engine sits
# at) through any API this app can reach — that data (LARSGEN rake
# diagrams) isn't exposed to any provider this project has access to. What
# IS real and documented: reserved coaches of a given class are marshalled
# together in ascending numeric order on virtually every LHB/ICF rake
# (you won't find S4 randomly placed between S1 and S9) — this composes
# that real convention with a typical-coach-count table (approximate,
# labelled as such) to say roughly where in that class's block a coach
# sits. WHICH physical end of the platform that block will stop at depends
# on rake orientation this app has no source for, so both possibilities
# are shown side by side rather than picking one and presenting it as fact.
# =============================================================================
FIND_MY_COACH_DISCLAIMER = (
    "Indian Railways doesn't publish real per-train rake composition (coach order, or which "
    "end the engine is at) through any API this app can reach. The 'coaches of one class are "
    "marshalled in ascending order' part is a real, essentially universal convention; which "
    "physical end of the platform that block stops at is NOT knowable from here, so both "
    "possibilities are shown — confirm with the coach position display board or platform "
    "announcement at the station, or the coach guide chart near the platform entrance."
)

# Typical (approximate, not this train's actual) coach counts per class on a
# common long-distance ICF/LHB rake — used only to place a coach roughly
# within its own class's block, never presented as this train's real count.
_TYPICAL_COACH_COUNTS = {
    "SL": 10, "3A": 5, "2A": 3, "1A": 1, "3E": 2, "CC": 6, "EC": 2, "2S": 8,
}
# Rough, documented-typical marshalling ORDER of coach blocks from one end
# of a common long-distance rake to the other (General/unreserved at both
# ends, AC coaches usually together, SL usually the largest single block).
# This is a common pattern, not a rule — see disclaimer.
_TYPICAL_BLOCK_ORDER = ["General (unreserved)", "SL", "3A", "2A", "1A", "Pantry", "SL", "General (unreserved)"]


def find_my_coach(coach_number: str, total_coaches_hint: Optional[int] = None, train_number: Optional[str] = None) -> dict:
    coach_number = (coach_number or "").strip().upper()
    m = re.match(r"^([A-Z]+)-?(\d+)$", coach_number)
    if not m:
        return {
            "found": False,
            "note": f"Couldn't parse a class + number out of \"{coach_number}\" — enter it like S4, B2, A1, or HA1.",
            "disclaimer": FIND_MY_COACH_DISCLAIMER,
        }
    class_prefix, coach_idx = m.group(1), int(m.group(2))
    # Map common real coach-code prefixes to the travel classes this app
    # already models (SL uses "S", 3A uses "B", 2A uses "A", 1A uses "H").
    prefix_to_class = {"S": "SL", "B": "3A", "A": "2A", "H": "1A", "HA": "1A", "D": "2S", "C": "CC", "E": "EC"}
    travel_class = prefix_to_class.get(class_prefix, class_prefix if class_prefix in _COACH_LAYOUTS else None)

    total = total_coaches_hint or (_TYPICAL_COACH_COUNTS.get(travel_class) if travel_class else None) or 10
    position_fraction = max(0.0, min(1.0, (coach_idx - 0.5) / total))
    if position_fraction <= 0.34:
        block_position = "towards the FRONT of this class's block"
    elif position_fraction <= 0.67:
        block_position = "roughly in the MIDDLE of this class's block"
    else:
        block_position = "towards the REAR of this class's block"

    # Deterministic (stable per train, doesn't flicker between checks) but
    # explicitly NOT a real rake-orientation reading — see disclaimer.
    digest = hashlib.sha256(f"{train_number or ''}:{coach_number}".encode()).hexdigest()
    guess_engine_at_front = int(digest[:4], 16) % 2 == 0

    scenario_a = f"If the engine end is at the platform's ENTRY end: this class's block (and coach {coach_number}, {block_position}) would be towards the {'FRONT' if guess_engine_at_front else 'REAR'} of the platform."
    scenario_b = f"If the engine end is at the platform's FAR end instead: it would be towards the {'REAR' if guess_engine_at_front else 'FRONT'} of the platform."

    return {
        "found": True,
        "coach_number": coach_number,
        "travel_class": travel_class,
        "coach_index_in_class": coach_idx,
        "typical_class_coach_count": total,
        "class_block_position": block_position,
        "typical_marshalling_order": _TYPICAL_BLOCK_ORDER,
        "platform_end_scenarios": [scenario_a, scenario_b],
        "recommendation": "Check the coach position indicator board (common at major stations) or the announcement just before arrival to know which end is which today — then use the scenario above that matches.",
        "disclaimer": FIND_MY_COACH_DISCLAIMER,
    }