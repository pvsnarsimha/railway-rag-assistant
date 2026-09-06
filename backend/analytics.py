"""
analytics.py
--------------
FEATURE: Advanced Charting & Analytics Dashboard.

Records a small, structured event every time `/api/chat` handles a
request (see app.py) — the resolved intent, and (when the intent actually
produced them) a real delay figure, a real crowd-prediction score, or a
live-tracking update. This is a log of things that genuinely happened in
this server process, not synthetic/demo chart data — if nobody has asked a
crowd-prediction question yet this session, the crowd chart is honestly
empty rather than pre-populated.

STORAGE NOTE: an in-memory, capped ring buffer
(deque maxlen), process-local, resets on restart. No database in this
project — this is real-events analytics for the current server process's
lifetime, not a durable historical warehouse.
"""

from collections import Counter, deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Optional

from api_cache import cache_stats

_MAX_EVENTS = 3000
_EVENTS = deque(maxlen=_MAX_EVENTS)

# FEATURE: Automatic keyword/intent discovery (see auto_keyword_discovery.py)
# Raw text of questions that fell all the way through to GENERAL_FAQ with no
# few-shot match either - i.e. genuinely unrecognized phrasing. This is the
# feedstock auto_keyword_discovery.run_auto_discovery() clusters and
# auto-teaches from, so growing the router's coverage never requires someone
# to notice a miss and hand-type a keyword. Capped and process-local, same
# as _EVENTS above - not a durable log, just enough recent history for the
# next discovery run to work with.
_MAX_MISSES = 500
_MISS_QUESTIONS = deque(maxlen=_MAX_MISSES)


@dataclass
class AnalyticsEvent:
    timestamp: str
    intent: Optional[str] = None
    train_number: Optional[str] = None
    delay_minutes: Optional[int] = None
    predicted_delay_minutes: Optional[int] = None
    crowd_score: Optional[int] = None
    live_error: bool = False


def record_event(intent: Optional[str] = None, train_number: Optional[str] = None,
                  delay_minutes: Optional[int] = None, predicted_delay_minutes: Optional[int] = None,
                  crowd_score: Optional[int] = None, live_error: bool = False):
    """Best-effort logging — callers should wrap this in try/except so a
    logging hiccup never breaks the actual user-facing feature it's
    observing."""
    _EVENTS.append(AnalyticsEvent(
        timestamp=datetime.now(timezone.utc).isoformat(),
        intent=intent, train_number=train_number, delay_minutes=delay_minutes,
        predicted_delay_minutes=predicted_delay_minutes, crowd_score=crowd_score,
        live_error=live_error,
    ))


def record_miss(question: str):
    """Best-effort logging of a genuinely-unrecognized question (rule-based
    router said GENERAL_FAQ and the few-shot matcher had nothing either).
    Called from app.py right before it falls back to plain RAG."""
    question = (question or "").strip()
    if question:
        _MISS_QUESTIONS.append(question)


def get_recent_misses(limit: int = 200) -> list:
    return list(_MISS_QUESTIONS)[-limit:]


def train_delay_history(train_number: str, limit: int = 100) -> dict:
    """Delay history (actual vs ML-predicted) logged so far this session for
    ONE specific train, oldest first — powers the per-train chart in the
    Live Tracking panel. Same real-events-only rule as summary()."""
    train_number = (train_number or "").strip()
    matches = [
        e for e in _EVENTS
        if e.train_number == train_number and (e.delay_minutes is not None or e.predicted_delay_minutes is not None)
    ]
    series = [
        {"t": e.timestamp, "actual": e.delay_minutes, "predicted": e.predicted_delay_minutes}
        for e in matches
    ][-limit:]
    return {
        "train_number": train_number,
        "points": len(series),
        "series": series,
        "note": (
            f"Real events logged for train {train_number} during this server session only "
            "— empty until you track or predict for this train at least once."
        ),
    }


def train_crowd_history(train_number: str, limit: int = 50) -> list:
    """Real crowd-prediction scores logged so far this server session for
    ONE specific train, oldest first — used by the "Optimal Booking
    Window" tool's session_crowd_trend (see advanced_features.
    booking_window_advice). Same real-events-only rule as summary(): empty
    until this train's crowd prediction has actually been checked at
    least once this session, never backfilled/synthetic."""
    train_number = (train_number or "").strip()
    matches = [
        {"t": e.timestamp, "score": e.crowd_score}
        for e in _EVENTS
        if e.train_number == train_number and e.crowd_score is not None
    ]
    return matches[-limit:]


def summary(recent_limit: int = 200) -> dict:
    events = list(_EVENTS)
    intent_counts = Counter(e.intent for e in events if e.intent)

    delay_series = [
        {"t": e.timestamp, "train": e.train_number, "actual": e.delay_minutes, "predicted": e.predicted_delay_minutes}
        for e in events if e.delay_minutes is not None or e.predicted_delay_minutes is not None
    ][-recent_limit:]

    crowd_series = [
        {"t": e.timestamp, "train": e.train_number, "score": e.crowd_score}
        for e in events if e.crowd_score is not None
    ][-recent_limit:]

    total = len(events)
    error_count = sum(1 for e in events if e.live_error)
    live_error_rate_pct = round(100 * error_count / total, 1) if total else 0.0

    return {
        "total_events": total,
        "intent_distribution": dict(intent_counts),
        "delay_series": delay_series,
        "crowd_series": crowd_series,
        "live_error_rate_pct": live_error_rate_pct,
        "cache_stats": cache_stats(),
        "note": (
            "In-memory analytics of this server process's own real events since its last "
            "restart - no database, no synthetic/demo data mixed in."
        ),
    }
