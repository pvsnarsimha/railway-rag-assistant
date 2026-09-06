"""
feedback_rlhf.py
-------------------
FEATURE: User Feedback Loop with Reinforcement Learning (RLHF) Data Collection.

Every /api/chat response is stamped with a `response_id`. The frontend can
then post a 👍/👎 (optionally with a free-text correction) against that id
via POST /api/feedback. This module is the storage + shaping layer for that
loop:

  1. `record_response(...)` — called once per /api/chat reply, before the
     user has had a chance to react to it. Stores the (question, answer,
     intent, sources) tuple so a later feedback event can be joined back to
     what was actually said, without asking the frontend to resend the full
     answer text.
  2. `record_feedback(...)` — called from POST /api/feedback. Joins the
     rating against the stored response and appends a normalized event.
  3. `export_preference_pairs(...)` — turns the raw event log into
     RLHF-style (prompt, chosen, rejected) preference pairs, the standard
     training signal shape for reward-model / DPO-style fine-tuning:
       - a 👎 WITH a correction attached produces a real pair: the
         correction is `chosen`, the original (bad) answer is `rejected`.
       - a bare 👎 (no correction) has no "chosen" text to offer, so it's
         surfaced separately as a `flagged_negative` rather than forced
         into a low-quality synthetic pair.
       - a 👍 records the served answer as `chosen` with `rejected: null` —
         useful as a positive-only example for reward modeling, but never
         invented as a pair against a made-up rejection.

STORAGE NOTE: same convention as analytics.py — in-memory, capped, process-
local. This is a working data-collection buffer, not a durable data
warehouse; a real deployment would flush `export_preference_pairs()` to a
file/DB on a schedule.
"""

import uuid
from collections import OrderedDict, deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import List, Optional

_MAX_RESPONSES = 5000   # bound the response-context cache
_MAX_FEEDBACK = 5000    # bound the feedback event log


@dataclass
class StoredResponse:
    response_id: str
    question: str
    answer: str
    intent: Optional[str]
    sources: List[str] = field(default_factory=list)
    timestamp: str = ""


@dataclass
class FeedbackEvent:
    response_id: str
    rating: str                      # "up" | "down"
    question: str
    answer: str
    intent: Optional[str]
    correction: Optional[str] = None
    reason: Optional[str] = None
    timestamp: str = ""


# response_id -> StoredResponse, insertion-ordered so we can evict the
# oldest once the cap is hit (a plain dict + manual eviction, since
# OrderedDict.popitem(last=False) gives O(1) FIFO eviction).
_RESPONSES: "OrderedDict[str, StoredResponse]" = OrderedDict()
_FEEDBACK: deque = deque(maxlen=_MAX_FEEDBACK)


def new_response_id() -> str:
    return uuid.uuid4().hex[:12]


def record_response(response_id: str, question: str, answer: str,
                     intent: Optional[str], sources: Optional[List[str]] = None):
    """Best-effort — callers should not let a logging hiccup break the
    actual chat reply it's observing."""
    _RESPONSES[response_id] = StoredResponse(
        response_id=response_id, question=question, answer=answer,
        intent=intent, sources=sources or [],
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    while len(_RESPONSES) > _MAX_RESPONSES:
        _RESPONSES.popitem(last=False)


class UnknownResponseError(Exception):
    pass


def record_feedback(response_id: str, rating: str, correction: Optional[str] = None,
                     reason: Optional[str] = None) -> FeedbackEvent:
    rating = (rating or "").strip().lower()
    if rating not in ("up", "down"):
        raise ValueError("rating must be 'up' or 'down'")

    stored = _RESPONSES.get(response_id)
    if stored is None:
        # The response aged out of the cache, or the id is bogus. Still
        # record the rating itself (the id is kept for traceability) rather
        # than silently dropping user feedback, but we can't reconstruct
        # the prompt/answer for a preference pair from this event.
        event = FeedbackEvent(
            response_id=response_id, rating=rating, question="", answer="",
            intent=None, correction=correction, reason=reason,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        _FEEDBACK.append(event)
        raise UnknownResponseError(
            "response_id not found (may have expired) — rating logged without linked context"
        )

    event = FeedbackEvent(
        response_id=response_id, rating=rating,
        question=stored.question, answer=stored.answer, intent=stored.intent,
        correction=(correction or "").strip() or None,
        reason=(reason or "").strip() or None,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    _FEEDBACK.append(event)
    return event


def stats() -> dict:
    events = list(_FEEDBACK)
    up = sum(1 for e in events if e.rating == "up")
    down = sum(1 for e in events if e.rating == "down")
    with_correction = sum(1 for e in events if e.rating == "down" and e.correction)
    total = len(events)
    return {
        "total_feedback": total,
        "thumbs_up": up,
        "thumbs_down": down,
        "approval_rate_pct": round(100 * up / total, 1) if total else None,
        "corrections_collected": with_correction,
        "responses_awaiting_feedback": len(_RESPONSES),
        "note": (
            "In-memory feedback log for this server process's own real events since its "
            "last restart — no database, resets on restart."
        ),
    }


def export_preference_pairs(limit: int = 500) -> dict:
    """
    Shapes the raw feedback log into RLHF-ready training signal:
      - preference_pairs: [{prompt, chosen, rejected}] — usable directly as
        DPO/reward-model pairwise training data.
      - flagged_negatives: [{prompt, rejected, reason}] — 👎 with no
        correction text, so there's no `chosen` to pair it with; still
        useful as "avoid this" signal / for a human to write a correction
        against later.
    """
    events = [e for e in _FEEDBACK if e.question]  # drop unlinked/expired events
    events = events[-limit:]

    pairs = []
    flagged = []
    for e in events:
        if e.rating == "down" and e.correction:
            pairs.append({
                "prompt": e.question,
                "chosen": e.correction,
                "rejected": e.answer,
                "source_response_id": e.response_id,
                "timestamp": e.timestamp,
            })
        elif e.rating == "down":
            flagged.append({
                "prompt": e.question,
                "rejected": e.answer,
                "reason": e.reason,
                "source_response_id": e.response_id,
                "timestamp": e.timestamp,
            })
        elif e.rating == "up":
            pairs.append({
                "prompt": e.question,
                "chosen": e.answer,
                "rejected": None,
                "source_response_id": e.response_id,
                "timestamp": e.timestamp,
            })

    return {
        "preference_pairs": pairs,
        "flagged_negatives": flagged,
        "pair_count": len(pairs),
        "flagged_count": len(flagged),
    }
