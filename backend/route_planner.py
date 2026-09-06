"""
route_planner.py
------------------
FEATURE: Alternative Route Planner (Graph Algorithms).

Same honesty rule as the rest of this project: `railway_api.py` only tells
you about trains that run DIRECTLY between two stations. It has no notion
of "go via a junction and change trains" - if there's no direct service (or
it's fully booked), the app previously had nothing else to offer.

This module closes that gap with an actual graph algorithm, not a live
network feed (Indian Railways doesn't publish one): `data/rail_network_edges.json`
is a small, hand-curated graph of ~50 major stations connected along their
REAL, well-known trunk corridors (e.g. the Delhi-Chennai Grand Trunk route
via Jhansi-Bhopal-Nagpur-Vijayawada, the Howrah-Mumbai line via Bilaspur-
Nagpur, the Grand Chord via Gaya-Dhanbad, etc.) with edge weights that are
real haversine distances between the two stations, not invented numbers.

Given a source and destination, `find_alternative_routes()` runs networkx's
Yen's-algorithm shortest-simple-paths to return the K lowest-distance
junction-hopping routes - a real weighted-shortest-path computation, not a
lookup table of pre-written routes.

IMPORTANT LIMIT (stated honestly, not hidden): this graph models *that a
corridor exists*, not *that a specific train runs on it today*. It answers
"which junctions would a multi-leg journey plausibly go via" - it does NOT
claim any specific train number covers any specific leg. app.py additionally
calls `railway_api.search_trains_between_stations()` for each suggested leg
where possible, so any train numbers shown alongside a route are always
real, live-looked-up trains for that leg, never guessed.
"""

import json
import os
from dataclasses import dataclass, field
from typing import List, Optional

import networkx as nx

_EDGES_PATH = os.path.join(os.path.dirname(__file__), "data", "rail_network_edges.json")
_COORDS_PATH = os.path.join(os.path.dirname(__file__), "data", "station_coordinates.json")

with open(_EDGES_PATH, "r", encoding="utf-8") as f:
    _EDGES = json.load(f)

with open(_COORDS_PATH, "r", encoding="utf-8") as f:
    _STATION_COORDS = json.load(f)

_GRAPH = nx.Graph()
for edge in _EDGES:
    _GRAPH.add_edge(edge["from"], edge["to"], weight=edge["distance_km"])


def _station_name(code: str) -> str:
    info = _STATION_COORDS.get(code)
    return info["name"] if info else code


@dataclass
class RouteOption:
    stations: List[str] = field(default_factory=list)   # ordered station codes, source -> dest
    station_names: List[str] = field(default_factory=list)
    total_distance_km: float = 0.0
    hops: int = 0                                        # number of junction changes (legs - 1)
    is_direct_corridor: bool = False                      # True if the two stations are directly linked


@dataclass
class RoutePlanResult:
    source: str
    dest: str
    source_known: bool
    dest_known: bool
    options: List[RouteOption] = field(default_factory=list)
    note: Optional[str] = None


def find_alternative_routes(source_code: Optional[str], dest_code: Optional[str], k: int = 3) -> RoutePlanResult:
    """
    Returns up to `k` distinct lowest-total-distance paths through the
    curated trunk-corridor graph, ranked shortest first (networkx's
    `shortest_simple_paths`, a generator implementation of Yen's algorithm -
    a genuine k-shortest-paths graph algorithm, not a shuffled single route).

    If source/dest aren't in our ~50-station graph, or there's genuinely no
    path between them in it, this says so plainly via `note` rather than
    fabricating a route.
    """
    source = (source_code or "").strip().upper()
    dest = (dest_code or "").strip().upper()

    source_known = source in _GRAPH
    dest_known = dest in _GRAPH

    result = RoutePlanResult(source=source, dest=dest, source_known=source_known, dest_known=dest_known)

    if not source or not dest:
        result.note = "I need both a source and a destination station to plan alternative routes."
        return result

    if not source_known or not dest_known:
        missing = []
        if not source_known:
            missing.append(source)
        if not dest_known:
            missing.append(dest)
        result.note = (
            f"{' and '.join(missing)} isn't in my curated trunk-route network "
            f"({len(_GRAPH.nodes)} major junctions), so I can't graph-plan an alternative route for it - "
            "but I can still look up direct trains between the two stations if you ask that separately."
        )
        return result

    if source == dest:
        result.note = "Source and destination are the same station."
        return result

    if not nx.has_path(_GRAPH, source, dest):
        result.note = f"No path exists between {source} and {dest} in the curated trunk network."
        return result

    is_direct = _GRAPH.has_edge(source, dest)

    try:
        paths_gen = nx.shortest_simple_paths(_GRAPH, source, dest, weight="weight")
        seen = 0
        for path in paths_gen:
            seen += 1
            distance = sum(
                _GRAPH[path[i]][path[i + 1]]["weight"] for i in range(len(path) - 1)
            )
            result.options.append(RouteOption(
                stations=path,
                station_names=[_station_name(c) for c in path],
                total_distance_km=round(distance, 1),
                hops=max(len(path) - 2, 0),
                is_direct_corridor=(len(path) == 2),
            ))
            if seen >= k:
                break
    except nx.NetworkXNoPath:
        result.note = f"No path exists between {source} and {dest} in the curated trunk network."
        return result

    if is_direct and len(result.options) > 1:
        result.note = (
            f"{source} and {dest} sit on the same direct corridor - the first option below is that "
            "direct line; the rest are junction-hopping alternatives, useful if the direct train is full "
            "or not running."
        )
    return result


def format_route_options(result: RoutePlanResult) -> str:
    """Plain-text summary for grounding the LLM prompt / no-key fallback view."""
    if result.note and not result.options:
        return result.note
    lines = []
    if result.note:
        lines.append(result.note)
    for i, opt in enumerate(result.options, start=1):
        via = " → ".join(f"{name} ({code})" for code, name in zip(opt.stations, opt.station_names))
        tag = "direct corridor" if opt.is_direct_corridor else f"{opt.hops} junction change(s)"
        lines.append(f"{i}. {via} — approx {opt.total_distance_km} km ({tag})")
    if not lines:
        lines.append(f"No alternative routes found between {result.source} and {result.dest}.")
    return "\n".join(lines)
