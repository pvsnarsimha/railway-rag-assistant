"""
station_search.py
--------------------
FEATURE: Semantic Station Search with Geo-Coding.

Wraps the curated `data/station_coordinates.json` table with:

  1. NAME-TOKEN MATCH: an IDF-weighted word-overlap score straight against
     station names (see the big comment above _TOKEN_RE below) — the
     workhorse tier now that the table covers all ~8,700 Indian Railways
     stations, since a query like "howrah junction" needs to not get lost
     among the thousands of OTHER "... Junction" stations.

  2. SEMANTIC SEARCH: reuses the exact same dense-embedding (or TF-IDF/SVD
     fallback) machinery from semantic_engine.py that already powers the
     knowledge-base search - here built over a corpus of
     "<station name> <code> <known city aliases>" strings instead of KB
     articles. Runs as the final fallback tier, for a loosely worded or
     misspelled query that shares no exact words with the station name
     ("vizag station" via the city_aliases exact-match tier above it, or a
     typo'd name) — the same way a paraphrased policy question matches the
     right KB entry.

  3. GEO-CODING: every match returned carries its real lat/lng straight
     from station_coordinates.json - "geocoding" here means resolving a
     free-text place description down to those coordinates using data
     already in this project, not a call to an external geocoding
     service (this app doesn't have one / doesn't need one).

station_coordinates.json now covers all ~8,700 Indian Railways stations
(merged from the DataMeet community's public Indian Railways station
dataset, https://github.com/datameet/railways, on top of the original
~50 hand-curated majors, whose hand-checked names/coords were kept as
the source of truth wherever a code appears in both). nearby_stations.py
shares this same file and note.
"""

import json
import math
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

import entity_gazetteer
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

# ============================================================
# FEATURE: IDF-weighted station-name token match — added when this table
# grew from ~50 hand-curated majors to all ~8,700 real Indian Railways
# stations. The shared semantic_engine's TF-IDF+SVD fallback (LSA), tuned
# for the small KB-search corpus it also serves, starts giving genuinely
# wrong top results at this scale: a query like "howrah junction" or
# "bangalore city" gets swamped by the thousands of OTHER stations whose
# names also contain "Junction"/"City", because SVD's top components chase
# whatever term explains the most variance across the WHOLE corpus, not
# what's actually discriminating for this one query. A direct,
# uncompressed IDF-weighted word-overlap score has no such blind spot —
# "Junction" is near-worthless (it's in a sizeable slice of all station
# names) while "Howrah" or "Bangalore" (in a handful of stations each)
# carry nearly all the weight, so the intended station wins even amid
# thousands of same-suffix namesakes. This tier runs BEFORE the semantic
# fallback and only ever compares against the plain station name, so it's
# cheap (a few milliseconds over ~8,700 short token lists) and touches
# nothing in the shared semantic_engine.py (KB search is unaffected).
# ============================================================
_TOKEN_RE = re.compile(r"[a-z0-9]+")

# BUGFIX: found while expanding this table from ~50 majors to all ~8,700
# real stations — real-world lineside/cabin halts often have names like
# "A-Cabin Bondamunda" or "Daund A Mmr" that tokenize down to a standalone
# single-letter token ("a"). At ~8,700 docs that token's document frequency
# is tiny (only those few "A ..." names contain it), so its IDF score is
# huge — big enough, on its own, to clear _MIN_TOKEN_SCORE below. The
# result: a totally unrelated query that merely CONTAINS a standalone "a"
# as one of its words (e.g. "not a place", "a" being an article, not a
# place name) was matching those cabin halts as if it were a real,
# confident name match — exactly the kind of silent-wrong-guess this
# codebase's honesty rule exists to prevent. Real distinguishing station-
# name words are essentially never 1-2 characters, so tokens that short are
# dropped from the matching vocabulary entirely (station CODE matching
# above this tier is unaffected — that still matches short codes exactly).
_MIN_TOKEN_LEN = 3

# BUGFIX #2 (same discovery, a deeper layer of it): _MIN_TOKEN_SCORE below
# was tuned back when this table had ~50 stations, where a generic word
# like "junction" showed up in a large enough SHARE of the tiny corpus to
# get a low, safely-below-threshold IDF. At ~8,700 stations the whole IDF
# scale shifts up — 91% of all distinct tokens in this corpus now appear in
# exactly ONE station name, so almost every real word (generic or not) gets
# a high IDF, and _MIN_TOKEN_LEN's fix above doesn't help here since these
# are ordinary 5-8 letter words, not throwaway 1-2 letter ones. Concretely:
# "station" has IDF 7.7 here (only 3 curated names literally contain the
# word "station"), so ANY query containing the word "station" — including
# an honest "is there a station near X" or a typo'd non-place phrase —
# could single-handedly clear the threshold via that one word alone,
# matching an unrelated station by coincidence rather than by the query
# actually naming a place. Reusing entity_gazetteer's own curated English
# stopword list (built for the analogous code-collision problem) plus a
# few generic railway-infra words this corpus happens to under-use is the
# same fix pattern already established there — never statistically
# reliable to separate from a genuinely rare place name by IDF alone.
_GENERIC_NAME_STOPWORDS = {w.lower() for w in entity_gazetteer._AMBIGUOUS_CODE_STOPWORDS} | {
    "station", "stn", "flag", "colony", "block", "halt", "cabin", "railway", "railways",
}


def _tokenize(text: str) -> List[str]:
    return [
        t for t in _TOKEN_RE.findall((text or "").lower())
        if len(t) >= _MIN_TOKEN_LEN and t not in _GENERIC_NAME_STOPWORDS
    ]


# Token set per station = the official name's words PLUS any known
# colloquial city aliases for that code (e.g. SBC's curated name is
# "Bengaluru City" but city_aliases.json also has "bangalore" -> SBC, and
# VSKP's curated name "Visakhapatnam" has "vizag" as an alias) — so a query
# like "bangalore city" or "vizag junction" overlaps on the alias word even
# though it's absent from the official name text itself.
_NAME_TOKENS = {}
for _code in _CODES:
    _toks = set(_tokenize(_STATION_COORDS[_code].get("name", "")))
    for _alias in _ALIASES_BY_CODE.get(_code, []):
        _toks.update(_tokenize(_alias))
    _NAME_TOKENS[_code] = _toks

_DOC_FREQ: Counter = Counter()
for _toks in _NAME_TOKENS.values():
    for _t in _toks:
        _DOC_FREQ[_t] += 1
_N_DOCS = max(1, len(_CODES))
_MIN_TOKEN_SCORE = 0.55  # tuned so one solid rare-word hit clears it; "junction"/"road"/"city" alone never do


def _idf(token: str) -> float:
    df = _DOC_FREQ.get(token, 0)
    return math.log(_N_DOCS / (1 + df))


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
    matched_on: str  # "exact_code" | "exact_alias" | "name_match" | "semantic"


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

    # Name-token tier — see the big comment above _TOKEN_RE. Runs before the
    # semantic fallback so an exact-ish name/word match (however common the
    # station) always outranks a merely-plausible fuzzy guess.
    query_tokens = _tokenize(q)
    if query_tokens and len(matches) < top_k:
        query_token_set = set(query_tokens)
        token_scores = []
        for code in _CODES:
            if code in seen:
                continue
            name_tokens = _NAME_TOKENS.get(code)
            if not name_tokens:
                continue
            overlap = query_token_set & set(name_tokens)
            if not overlap:
                continue
            token_scores.append((sum(_idf(t) for t in overlap), code))
        token_scores.sort(key=lambda pair: -pair[0])
        for score, code in token_scores:
            if len(matches) >= top_k:
                break
            if score < _MIN_TOKEN_SCORE:
                continue
            info = _STATION_COORDS[code]
            matches.append(StationMatch(code=code, name=info["name"], lat=info["lat"], lng=info["lng"],
                                         score=round(min(score / 10.0, 0.98), 3), matched_on="name_match"))
            seen.add(code)

    # BUGFIX (same root cause as the name-token stopword fix above, a
    # different tier it hits): feeding the RAW query straight to the
    # embedding engine let generic filler/infra words ("a", "station", ...)
    # that are rare in THIS corpus (see the big comment above
    # _GENERIC_NAME_STOPWORDS) dominate the query's embedding, not just the
    # name-token tier's score — e.g. "is there a station near me" embedded
    # close enough to "Hanuman Station" to score 0.97, an unrelated
    # coincidence, not a real fuzzy match. Encoding the SAME cleaned token
    # set the name-token tier already computed (instead of raw `q`) removes
    # that noise before it ever reaches the embedding; if nothing
    # meaningful survives the cleanup, there's honestly nothing to
    # fuzzy-search for, so the semantic tier is skipped entirely rather
    # than embedding an all-stopword string and risking another
    # coincidental high score.
    if query_tokens:
        cleaned_query = " ".join(query_tokens)
        query_vec = _engine.encode([cleaned_query])[0]
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
            f"No close match found for '{q}' among the ~{len(_STATION_COORDS)} Indian Railways stations "
            "in my table. Try a major junction name or its station code (e.g. NDLS, BZA, SBC)."
        )

    return StationSearchResult(query=q, matches=matches, engine_name=_engine.name, note=note)


def format_station_search(result: StationSearchResult) -> str:
    if result.note and not result.matches:
        return result.note
    lines = [f"Stations matching \"{result.query}\":"]
    for m in result.matches:
        tag = {"exact_code": "exact code", "exact_alias": "known city name", "name_match": "name match", "semantic": "closest match"}[m.matched_on]
        lines.append(f"- {m.name} ({m.code}) — {tag}, lat {m.lat}, lng {m.lng}")
    if result.note:
        lines.append(result.note)
    return "\n".join(lines)
