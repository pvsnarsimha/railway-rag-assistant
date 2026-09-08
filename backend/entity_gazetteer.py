"""
entity_gazetteer.py
----------------------
FEATURE: Automatic entity detection (no manual station/stopword lists).

query_router.py's station-code extraction relies on a generic regex
(`\\b[A-Z]{2,5}\\b`) plus a hand-maintained `_STOPWORDS` set that has to grow
every time an everyday word ("MANY", "VACANT", "BERTH"...) collides with the
station-code shape once uppercased. That list only grows by someone hitting
a false positive in production and patching it.

This module replaces that approach with a closed-vocabulary gazetteer
matcher built AUTOMATICALLY from data already in this project:
  - data/city_aliases.json   (city/colloquial name -> station code)
  - data/station_coordinates.json (station code -> official station name)

Because it only ever matches strings that are actually known station
names/codes/aliases, it structurally cannot produce the "MANY"/"BERTH"-style
false positives the old regex+stopword approach did - there's no stopword
list to maintain because there's no generic pattern to filter in the first
place. Adding a new station is a data-file edit (or a script that pulls the
official IR station list), never a code change.

This is the lightweight, dependency-free alternative to a full NER model
(GLiNER, spaCy EntityRuler). If station-name recall ever needs to go beyond
"things already in our two data files" - e.g. recognizing a station this
gazetteer has never seen, written in free text - GLiNER (zero-shot NER) or a
spaCy PhraseMatcher/EntityRuler seeded from the same two files are the
documented upgrade path; see the note at the bottom of this file.

Public contract mirrors query_router._extract_stations() so it's a drop-in:
    extract_stations_auto(text) -> List[str]   # station codes, in the order mentioned
"""

import json
import os
import re
from typing import Dict, List, Tuple

_DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


def _load_json(name: str) -> dict:
    path = os.path.join(_DATA_DIR, name)
    if not os.path.isfile(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_gazetteer() -> Dict[str, str]:
    """
    Auto-builds {alias_text_lowercase_or_CODE: station_code} from the two
    data files. Runs once at import time (cheap - a few hundred entries at
    most) and is rebuilt automatically the next process restart if either
    data file changes, so growing station coverage is a data edit, not a
    code edit.
    """
    aliases = _load_json("city_aliases.json")          # "new delhi" -> "NDLS"
    stations = _load_json("station_coordinates.json")  # "NDLS" -> {"name": "New Delhi", ...}

    gazetteer: Dict[str, str] = {}
    for alias, code in aliases.items():
        gazetteer[alias.lower().strip()] = code

    for code, info in stations.items():
        gazetteer[code.upper().strip()] = code  # the code itself, e.g. "NDLS"
        official_name = (info or {}).get("name")
        if official_name:
            gazetteer[official_name.lower().strip()] = code

    return gazetteer


# FEATURE: collision guards — added when station_coordinates.json grew from
# ~50 hand-picked majors (all deliberately distinctive: NDLS, BZA, SBC...)
# to all ~8,700 real Indian Railways stations, where short/plain codes and
# names are common and DO collide with ordinary English words and
# substrings. Two guards, matching where each tier's false positives
# actually come from:
#
#   1. _MIN_ALIAS_LEN — the name/alias tier below does a plain, UNBOUNDED
#      substring search (`lower.find(alias)`, no \b word boundaries), so a
#      2-letter station name/alias can match INSIDE an unrelated word (a
#      real station literally named "Od" would match the "od" hiding in
#      "tODay"). Real place names worth recognizing are essentially never
#      this short, so aliases/names under this length are dropped from the
#      substring tier entirely - they're still reachable via their station
#      CODE, which the tier below matches on whole-word boundaries.
#
#   2. _AMBIGUOUS_CODE_STOPWORDS — the code tier matches on whole-word
#      boundaries already, but it uppercases the ENTIRE input first, so an
#      ordinary short English word ("at", "is", "on", "to"...) that happens
#      to equal some obscure rural station's real code still fires. This is
#      the same problem this module's docstring says the gazetteer approach
#      structurally avoids - true when the vocabulary was ~50 distinctive
#      majors, no longer true at ~8,700 stations where 2-3 letter codes are
#      common. A small, explicit stopword list for exactly this collision
#      class is a much narrower reintroduction of that old pattern than the
#      original open-ended "grows every time someone hits a false positive"
#      one - it only ever excludes a station CODE match for words that are
#      near-universally NOT what a passenger means, never touches the name/
#      alias tier, and someone can still search that code directly via
#      Station Search (station_search.py has no such filter).
_MIN_ALIAS_LEN = 4
_AMBIGUOUS_CODE_STOPWORDS = {
    "A", "I", "AM", "AN", "AS", "AT", "BE", "BY", "DO", "GO", "HE", "IF", "IN",
    "IS", "IT", "ME", "MY", "NO", "OF", "OK", "ON", "OR", "SO", "TO", "UP",
    "US", "WE", "ALL", "AND", "ANY", "ARE", "BUT", "CAN", "DID", "FOR", "GET",
    "GOT", "HAD", "HAS", "HER", "HIM", "HIS", "HOW", "ITS", "LET", "MAY",
    "NOT", "NOW", "OFF", "OLD", "ONE", "OUR", "OUT", "OWN", "PUT", "SAY",
    "SEE", "SHE", "THE", "TOO", "TWO", "USE", "WAS", "WAY", "WHO", "WHY",
    "NEW", "YOU", "YES", "YET", "TRY", "RUN", "SET", "END", "ADD", "BAD",
    "BIG", "BOX", "BUY", "CAR", "CUT", "EAT", "FAR", "FEW", "FIT", "FUN",
    "HOT", "JOB", "KEY", "LOT", "LOW", "MAP", "MAX", "MIN", "MOM", "TOP",
    "WILL", "WITH", "FROM", "THAT", "THIS", "THAN", "THEN", "WHEN", "WHAT",
    "WERE", "BEEN", "HAVE", "JUST", "LIKE", "MUCH", "SOME", "SAME", "STILL",
    "TODAY", "PLEASE", "THANKS",
}
def _build_alias_patterns(gazetteer: Dict[str, str]) -> List[Tuple["re.Pattern", str]]:
    """Longest alias first (so "new delhi" matches before a bare "delhi"
    inside a longer phrase would otherwise win — same ordering trick
    query_router.py already uses for city_aliases.json alone), each
    precompiled with \\b word-boundary anchors on both ends.

    Word boundaries matter more now than they used to: with ~50 curated
    majors, a plain unbounded substring search (the original approach here)
    never misfired because every name/alias was long and distinctive. At
    ~8,700 real stations, short-but-legitimate names are common enough to
    turn up INSIDE unrelated words — a real Punjab station literally named
    "Banga" (code BXB) would otherwise match every mention of "Bangalore".
    \\b-anchoring on the whole alias (not each internal word) still matches
    multi-word phrases like "new delhi" fine, since a space satisfies \\b
    just as well as a true word boundary.
    """
    aliases = sorted(
        (a for a in gazetteer if not a.isupper() and len(a) >= _MIN_ALIAS_LEN), key=len, reverse=True,
    )
    return [(re.compile(r"\b" + re.escape(a) + r"\b"), a) for a in aliases]


_GAZETTEER: Dict[str, str] = build_gazetteer()
_ALIAS_PATTERNS = _build_alias_patterns(_GAZETTEER)
_CODE_RE = re.compile(r"\b([A-Z]{2,5})\b")


def reload_gazetteer() -> int:
    """Call after editing city_aliases.json / station_coordinates.json
    without restarting the process. Returns the new entry count."""
    global _GAZETTEER, _ALIAS_PATTERNS
    _GAZETTEER = build_gazetteer()
    _ALIAS_PATTERNS = _build_alias_patterns(_GAZETTEER)
    return len(_GAZETTEER)


def extract_stations_auto(text: str) -> List[str]:
    """
    Returns station codes mentioned in `text`, in first-mention order,
    matching only against known station codes/names/aliases - never a
    generic uppercase-word guess, so nothing gets misfired as a station
    just because it happens to be short and capitalized.
    """
    lower = text.lower()
    upper = text.upper()
    found: List[Tuple[int, str]] = []

    # Official station codes (e.g. "NDLS"), matched as whole words only.
    for match in _CODE_RE.finditer(upper):
        word = match.group(1)
        if word in _AMBIGUOUS_CODE_STOPWORDS:
            continue
        if word in _GAZETTEER:
            found.append((match.start(), _GAZETTEER[word]))

    # City names / colloquial aliases / official station names — \b-anchored
    # (see _build_alias_patterns) so a short real name never matches inside
    # an unrelated longer word.
    for pattern, alias in _ALIAS_PATTERNS:
        match = pattern.search(lower)
        if match:
            found.append((match.start(), _GAZETTEER[alias]))

    found.sort(key=lambda pair: pair[0])
    ordered: List[str] = []
    for _, code in found:
        if not ordered or ordered[-1] != code:
            ordered.append(code)
    return ordered


# ---------------------------------------------------------------------------
# Upgrade path notes (not implemented here - see module docstring):
#
# GLiNER (zero-shot NER): would let the bot recognize a station it has
# NEVER seen in the two data files, typed in free text, without adding a
# row anywhere - at the cost of a real model load (a few hundred MB) and
# per-request inference time, which is the tradeoff called out in the
# routing-cascade discussion (this gazetteer belongs in Tier 1/2, a GLiNER
# call would belong in Tier 3-territory cost-wise).
#
# spaCy EntityRuler / PhraseMatcher: a pure-rules alternative that would
# give you the same closed-vocabulary matching this module already does,
# plus spaCy's tokenizer (handles punctuation/contractions a bit more
# robustly than the regex above) - worth adopting only if spaCy is already
# a dependency for another reason, since it's a heavier install for the
# same coverage this module gets for free.
# ---------------------------------------------------------------------------
