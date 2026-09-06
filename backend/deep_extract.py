"""
deep_extract.py
------------------
Shared resilient field extraction for provider responses whose exact
nested shape isn't guaranteed. trains_between.py, gps_tracking.py, and
the original pnr_tracking.py each had their own flat "try a few plausible
top-level key spellings" helper — fine when the field genuinely sits at
the top level, but RailKit's PNR/history responses turned out to nest
fields under a wrapper object our flat guesses never looked inside (real
PNR/delay-history lookups came back with every field unmatched even
though the provider clearly returned real data — see the two rounds of
screenshots that prompted this file).

This generalizes the same idea: walk the FULL nested dict/list structure,
not just top level, so a field under an unexpected wrapper is still
found. Still never invents a value — deep_find only ever returns
something that was genuinely present somewhere in the real response, and
`default`/`[]` otherwise, same honesty rule as every other extractor in
this project.
"""

import re
from typing import Any, Iterable


def normalize_key(k: str) -> str:
    """Lowercases and strips non-alphanumerics so 'trainNumber',
    'train_number', 'TrainNo', and 'train-no' can all match the same
    candidate name without listing every casing variant by hand."""
    return re.sub(r"[^a-z0-9]", "", str(k).lower())


def _walk(obj: Any, depth: int = 0):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield normalize_key(k), v, depth
            yield from _walk(v, depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk(item, depth)


def deep_find(obj: Any, candidate_names: Iterable[str], default=None):
    """Shallowest real (non-None/empty, non-container) value found under
    any key whose normalized name matches one of candidate_names,
    searched anywhere in the nested structure. Prefers the shallowest
    match so a field near the top wins over a coincidentally-matching
    name buried deep inside an unrelated sub-object."""
    normalized = {normalize_key(c) for c in candidate_names}
    best, best_depth = None, None
    for nk, v, depth in _walk(obj):
        if nk in normalized and v not in (None, "") and not isinstance(v, (dict, list)):
            if best_depth is None or depth < best_depth:
                best, best_depth = v, depth
    return best if best is not None else default


def deep_find_list_of_dicts(obj: Any, candidate_names: Iterable[str]):
    """First non-empty list-of-dicts value found under any key whose
    normalized name matches one of candidate_names — for passenger
    lists, stop/station lists, etc. whose wrapper key name or nesting
    depth isn't fixed. Returns [] (never a guess) if nothing matches."""
    normalized = {normalize_key(c) for c in candidate_names}
    for nk, v, depth in _walk(obj):
        if nk in normalized and isinstance(v, list) and v and isinstance(v[0], dict):
            return v
    return []


def _collect_key_paths(obj: Any, max_depth: int = 3, prefix: str = "", out=None, cap: int = 40):
    if out is None:
        out = []
    if len(out) >= cap:
        return out
    if isinstance(obj, dict):
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else str(k)
            out.append(path)
            if max_depth > 0:
                _collect_key_paths(v, max_depth - 1, path, out, cap)
    elif isinstance(obj, list) and obj:
        _collect_key_paths(obj[0], max_depth, f"{prefix}[0]", out, cap)
    return out


def top_level_keys(obj: Any, max_depth: int = 3) -> list:
    """Real key PATHS actually present in the response (after unwrapping
    a {success, data} envelope), a few levels deep — e.g.
    'pnrData.trainDetails.number' — surfaced in API responses purely as a
    debugging aid. Deep responses often nest the useful fields a couple
    of levels below a wrapper object, so a flat top-level key list alone
    isn't enough to fix an unmatched field from; this gives enough of the
    real shape to pinpoint exactly which candidate name to add, capped at
    40 paths so the response stays small."""
    payload = obj.get("data", obj) if isinstance(obj, dict) else obj
    return _collect_key_paths(payload, max_depth=max_depth)
