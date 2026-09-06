"""
station_search.py
--------------------
FEATURE: Semantic Station Search with Geo-Coding.

Wraps the curated `data/station_coordinates.json` table with:

  1. SEMANTIC SEARCH: reuses the exact same dense-embedding (or TF-IDF/SVD
     fallback) machinery from semantic_engine.py that already powers the
     knowledge-base search - here built over a small corpus of
     "<station name> <code> <known city aliases>" strings instead of KB
     articles. That means a loosely worded or paraphrased query ("the big
     junction near bangalore", "vizag station", "howrah") still matches
     the right station even without an exact substring hit, the same way
     a paraphrased policy question matches the right KB entry.

  2. GEO-CODING: every match returned carries its real lat/lng straight
     from station_coordinates.json - "geocoding" here means resolving a
     free-text place description down to those coordinates using data
     already in this project, not a call to an external geocoding
     service (this app doesn't have one / doesn't need one for its
     curated station set).

Same honesty rule as nearby_stations.py: the curated table only covers
~50 major stations, not all ~7,000+ Indian Railways stations. If nothing
matches reasonably well, that's said plainly (`note`) rather than
returning a low-confidence guess dressed up as a solid match.
"""

import json
import os
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

import semantic_engine

_COORDS_PATH = os.path.join(os.path.dirname(__file__), "data", "station_coordinates.json")
_ALIASES_PATH = os.path.join(os.path.dirname(__file__), "data", "city_aliases.json")

with open(_COORDS_PATH, "r", encoding="utf-8") as f:
    _STATION_COORDS = json.load(f)

with open(_ALIASES_PATH, "r", encoding="utf-8") as f:
    _CITY_ALIASES = json.load(f)  # alias (lowercase) -> station code

_ALIASES_BY_CODE = {}
for _alias, _code in _CITY_ALIASES.items():
    _ALIASES_BY_CODE.setdefault(_code, []).append(_alias)

_CODES = list(_STATION_COORDS.keys())
_CORPUS = [
    f"{_STATION_COORDS[code]['name']} {code} " + " ".join(_ALIASES_BY_CODE.get(code, []))
    for code in _CODES
]

_MIN_SEMANTIC_SCORE = 0.12  # below this, a "match" is noise, not a real hit

_engine = None
_matrix = None


def _ensure_index():
    global _engine, _matrix
    if _engine is None:
        _engine, _matrix = semantic_engine.build_semantic_index(_CORPUS)


@dataclass
class StationMatch:
    code: str
    name: str
    lat: Optional[float]
    lng: Optional[float]
    score: float
    matched_on: str  # "exact_code" | "exact_alias" | "semantic"


@dataclass
class StationSearchResult:
    query: str
    matches: List[StationMatch] = field(default_factory=list)
    engine_name: str = "unknown"
    note: Optional[str] = None


def search_stations(query: str, top_k: int = 5) -> StationSearchResult:
    q = (query or "").strip()
    if not q:
        return StationSearchResult(query=q, note="Please type a station name, code, or city to search for.")

    _ensure_index()
    upper = q.upper()
    lower = q.lower().strip()

    matches: List[StationMatch] = []
    seen = set()

    # Fast, exact paths first — an exact code or a known city alias should
    # always outrank a fuzzy semantic guess, not just happen to.
    if upper in _STATION_COORDS:
        info = _STATION_COORDS[upper]
        matches.append(StationMatch(code=upper, name=info["name"], lat=info["lat"], lng=info["lng"],
                                     score=1.0, matched_on="exact_code"))
        seen.add(upper)

    if lower in _CITY_ALIASES:
        code = _CITY_ALIASES[lower]
        if code not in seen and code in _STATION_COORDS:
            info = _STATION_COORDS[code]
            matches.append(StationMatch(code=code, name=info["name"], lat=info["lat"], lng=info["lng"],
                                         score=0.99, matched_on="exact_alias"))
            seen.add(code)

    query_vec = _engine.encode([q])[0]
    sims = _engine.similarity(query_vec, _matrix)
    order = np.argsort(-sims)

    for idx in order:
        if len(matches) >= top_k:
            break
        code = _CODES[idx]
        if code in seen:
            continue
        score = float(sims[idx])
        if score < _MIN_SEMANTIC_SCORE:
            continue
        info = _STATION_COORDS[code]
        matches.append(StationMatch(code=code, name=info["name"], lat=info["lat"], lng=info["lng"],
                                     score=round(score, 3), matched_on="semantic"))
        seen.add(code)

    note = None
    if not matches:
        note = (
            f"No close match found for '{q}' among the ~{len(_STATION_COORDS)} major stations in my "
            "curated table. Try a major junction name or its station code (e.g. NDLS, BZA, SBC)."
        )

    return StationSearchResult(query=q, matches=matches, engine_name=_engine.name, note=note)


def format_station_search(result: StationSearchResult) -> str:
    if result.note and not result.matches:
        return result.note
    lines = [f"Stations matching \"{result.query}\":"]
    for m in result.matches:
        tag = {"exact_code": "exact code", "exact_alias": "known city name", "semantic": "closest match"}[m.matched_on]
        lines.append(f"- {m.name} ({m.code}) — {tag}, lat {m.lat}, lng {m.lng}")
    if result.note:
        lines.append(result.note)
    return "\n".join(lines)
