"""
few_shot_intents.py
----------------------
FEATURE: Few-Shot Learning for New Intents.

query_router.py is a rule-based classifier — adding a genuinely new intent
today means writing new regex/keyword rules and shipping a code change.
That's fine for the handful of structurally distinctive intents this app
started with, but it doesn't let a non-engineer (e.g. a support lead who
notices "people keep asking about X and we have no bucket for it") teach
the assistant a new question category on the fly.

This module adds an in-context, embedding-based few-shot classifier that
sits ALONGSIDE the rule-based router rather than replacing it:

  - `teach_intent(name, examples, response_hint)` — register a new intent
    with a handful (as few as 1, ideally 3-10) of example user utterances.
    No training/fine-tuning happens; "learning" here means embedding the
    examples and remembering them, in the spirit of few-shot / in-context
    classification rather than gradient-based training.
  - `match(question, semantic_engine)` — embeds the incoming question with
    the SAME semantic engine the RAG pipeline already builds (so this adds
    zero extra model loads), compares it against every stored example via
    cosine similarity, and returns the best-matching taught intent if it
    clears a confidence floor.

Persisted to data/custom_intents.json (unlike analytics/feedback, which are
deliberately session-only logs, taught intents are configuration a person
deliberately added and expects to survive a restart).

query_router.classify() stays the fast first pass for the built-in intents.
app.py calls few_shot_intents.match() only when the rule-based router falls
through to GENERAL_FAQ, so a confident custom-intent match can override the
generic "policy question -> RAG" bucket with something more specific.
"""

import json
import os
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

_STORE_PATH = os.path.join(os.path.dirname(__file__), "data", "custom_intents.json")

# Cosine similarity floor for accepting a few-shot match. Embeddings here
# reuse whatever engine the RAG pipeline is already running (real sentence-
# transformers or the TF-IDF/SVD fallback — see semantic_engine.py), so the
# floor is intentionally conservative to avoid the fallback engine's
# noisier similarity scores producing false-positive intent matches.
DEFAULT_CONFIDENCE_FLOOR = 0.55


@dataclass
class TaughtIntent:
    name: str
    examples: List[str]
    response_hint: Optional[str] = None


@dataclass
class FewShotMatch:
    intent_name: str
    confidence: float
    matched_example: str
    response_hint: Optional[str] = None


def _load() -> List[TaughtIntent]:
    if not os.path.isfile(_STORE_PATH):
        return []
    with open(_STORE_PATH, "r", encoding="utf-8") as f:
        raw = json.load(f)
    return [TaughtIntent(**item) for item in raw.get("intents", [])]


def _save(intents: List[TaughtIntent]):
    payload = {"intents": [
        {"name": i.name, "examples": i.examples, "response_hint": i.response_hint}
        for i in intents
    ]}
    with open(_STORE_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)


# In-process cache so we don't re-read the file on every single chat
# message; invalidated (re-read) whenever teach_intent() writes.
_CACHE: Optional[List[TaughtIntent]] = None


def _get_cached() -> List[TaughtIntent]:
    global _CACHE
    if _CACHE is None:
        _CACHE = _load()
    return _CACHE


def teach_intent(name: str, examples: List[str], response_hint: Optional[str] = None) -> TaughtIntent:
    """
    Adds a new taught intent, or — if `name` already exists — extends its
    example set (this is how the loop is meant to be used over time: start
    with 2-3 examples, add more as real misclassified questions surface).
    """
    name = name.strip()
    examples = [e.strip() for e in examples if e.strip()]
    if not name:
        raise ValueError("intent name cannot be empty")
    if not examples:
        raise ValueError("at least one example utterance is required")

    intents = _get_cached()
    existing = next((i for i in intents if i.name == name), None)
    if existing:
        merged = existing.examples + [e for e in examples if e not in existing.examples]
        existing.examples = merged
        if response_hint:
            existing.response_hint = response_hint
        result = existing
    else:
        result = TaughtIntent(name=name, examples=examples, response_hint=response_hint)
        intents.append(result)

    _save(intents)
    return result


def list_intents() -> List[TaughtIntent]:
    return list(_get_cached())


def delete_intent(name: str) -> bool:
    intents = _get_cached()
    remaining = [i for i in intents if i.name != name]
    changed = len(remaining) != len(intents)
    if changed:
        global _CACHE
        _CACHE = remaining
        _save(remaining)
    return changed


def match(question: str, semantic_engine, confidence_floor: float = DEFAULT_CONFIDENCE_FLOOR) -> Optional[FewShotMatch]:
    """
    `semantic_engine` must expose the same contract as
    semantic_engine.BaseSemanticEngine: .encode(list[str]) -> np.ndarray and
    .similarity(query_vec, matrix) -> np.ndarray. Passing in the engine the
    RAG pipeline already built (see rag_engine.py) means this costs one more
    small `.encode()` call, not a second model load.
    """
    intents = _get_cached()
    if not intents or not question.strip():
        return None

    all_examples: List[str] = []
    owner: List[TaughtIntent] = []
    for intent in intents:
        for ex in intent.examples:
            all_examples.append(ex)
            owner.append(intent)

    if not all_examples:
        return None

    try:
        example_matrix = semantic_engine.encode(all_examples)
        query_vec = semantic_engine.encode([question])[0]
        sims = semantic_engine.similarity(query_vec, example_matrix)
    except Exception:
        # Never let an embedding hiccup break the main chat flow — the
        # rule-based router's GENERAL_FAQ fallback still handles the message.
        return None

    best_idx = int(np.argmax(sims))
    best_score = float(sims[best_idx])
    if best_score < confidence_floor:
        return None

    best_intent = owner[best_idx]
    return FewShotMatch(
        intent_name=best_intent.name,
        confidence=round(best_score, 3),
        matched_example=all_examples[best_idx],
        response_hint=best_intent.response_hint,
    )
