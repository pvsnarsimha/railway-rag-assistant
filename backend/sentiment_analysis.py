"""
sentiment_analysis.py
------------------------
FEATURE: Real-Time Sentiment and Emotion Analysis.

Runs on every incoming message, inline, before synthesis - "real-time" in
the sense that matters here: it's cheap enough (a lexicon scan, no network
call, no model load) to run on the critical path of every single chat
turn without adding latency, so the assistant's *tone* can react to a
frustrated or urgent message in the SAME reply, not after the fact.

Deliberately lexicon + heuristic based rather than a trained classifier,
matching this project's existing pattern (self_rag's retrieval gate,
query_router's intent rules) of lightweight, dependency-free, fully
debuggable heuristics over black-box models where the domain is narrow
enough for that to work well - a railway-assistant chat message's emotional
signal is dominated by a fairly small, predictable vocabulary (delay/
complaint words, urgency words, gratitude words, profanity-adjacent
frustration), plus surface cues (ALL CAPS, "!!!", "?!").

`analyze(text) -> SentimentResult` is the single entry point. app.py calls
it once per /api/chat request and:
  1. folds a short tone instruction into the synthesis system prompt when
     frustration/urgency is detected (empathetic, no fluff, no upsell)
  2. surfaces the result in the response's `rag_trace` for the frontend to
     show (e.g. a small mood indicator) and for analytics.
"""

import re
from dataclasses import dataclass
from typing import List

NEGATIVE_WORDS = {
    "worst", "terrible", "horrible", "awful", "useless", "pathetic", "disgusting",
    "scam", "fraud", "cheated", "ridiculous", "unacceptable", "disappointed",
    "disappointing", "hate", "angry", "annoyed", "annoying", "frustrated",
    "frustrating", "waste", "wasted", "broken", "fail", "failed", "failure",
    "never", "worse", "sick", "tired", "fed up", "nonsense", "rubbish",
    "delayed", "delay", "late", "stuck", "cancelled", "cancel", "lost",
    "missing", "wrong", "error", "problem", "issue", "complaint", "refund",
    "not working", "doesn't work", "no response", "still waiting",
}

POSITIVE_WORDS = {
    "thanks", "thank you", "great", "awesome", "excellent", "perfect", "good",
    "helpful", "appreciate", "appreciated", "nice", "love", "amazing",
    "wonderful", "fantastic", "super", "cool", "brilliant", "smooth", "easy",
}

URGENCY_WORDS = {
    "urgent", "urgently", "asap", "immediately", "right now", "emergency",
    "hurry", "quickly", "in a few minutes", "about to", "boarding now",
    "train is leaving", "please help", "help me", "help asap",
}

FRUSTRATION_PHRASES = {
    "why is this so hard", "this is ridiculous", "nobody is helping",
    "i keep asking", "i already told you", "for the third time",
    "still no answer", "why won't", "this makes no sense", "not helpful at all",
}

_WORD_RE = re.compile(r"[a-z']+")


@dataclass
class SentimentResult:
    sentiment: str          # "positive" | "neutral" | "negative"
    sentiment_score: float  # -1.0 (very negative) .. +1.0 (very positive)
    emotion: str            # "frustrated" | "urgent" | "satisfied" | "neutral" | "anxious"
    is_urgent: bool
    is_frustrated: bool
    matched_signals: List[str]


def _count_phrase_hits(lower_text: str, phrases) -> List[str]:
    return [p for p in phrases if p in lower_text]


def analyze(text: str) -> SentimentResult:
    if not text or not text.strip():
        return SentimentResult("neutral", 0.0, "neutral", False, False, [])

    lower = text.lower()
    words = set(_WORD_RE.findall(lower))
    signals: List[str] = []

    neg_hits = _count_phrase_hits(lower, NEGATIVE_WORDS) + list(words & NEGATIVE_WORDS)
    pos_hits = _count_phrase_hits(lower, POSITIVE_WORDS) + list(words & POSITIVE_WORDS)
    urgency_hits = _count_phrase_hits(lower, URGENCY_WORDS)
    frustration_hits = _count_phrase_hits(lower, FRUSTRATION_PHRASES)

    neg_hits = list(dict.fromkeys(neg_hits))
    pos_hits = list(dict.fromkeys(pos_hits))
    signals.extend(neg_hits + pos_hits + urgency_hits + frustration_hits)

    # Surface cues: shouting and stacked punctuation both push toward a
    # stronger (usually negative/urgent) reading, but are mild signals on
    # their own - each only nudges the score, never dominates it.
    letters = [c for c in text if c.isalpha()]
    caps_ratio = (sum(1 for c in letters if c.isupper()) / len(letters)) if letters else 0.0
    is_shouting = len(letters) >= 6 and caps_ratio > 0.7
    stacked_punct = bool(re.search(r"[!?]{2,}", text))
    if is_shouting:
        signals.append("ALL_CAPS")
    if stacked_punct:
        signals.append("stacked_punctuation")

    raw_score = len(pos_hits) - len(neg_hits) - len(frustration_hits)
    if is_shouting:
        raw_score -= 1
    if stacked_punct:
        raw_score -= 0.5

    # Squash to [-1, 1] without needing a real magnitude scale.
    if raw_score > 0:
        sentiment_score = min(1.0, raw_score / 3.0)
    elif raw_score < 0:
        sentiment_score = max(-1.0, raw_score / 3.0)
    else:
        sentiment_score = 0.0

    if sentiment_score >= 0.2:
        sentiment = "positive"
    elif sentiment_score <= -0.2:
        sentiment = "negative"
    else:
        sentiment = "neutral"

    is_urgent = bool(urgency_hits) or (stacked_punct and bool(neg_hits))
    is_frustrated = bool(frustration_hits) or len(neg_hits) >= 2 or (is_shouting and bool(neg_hits))

    if is_frustrated:
        emotion = "frustrated"
    elif is_urgent:
        emotion = "urgent"
    elif sentiment == "positive":
        emotion = "satisfied"
    elif neg_hits:
        emotion = "anxious"
    else:
        emotion = "neutral"

    return SentimentResult(
        sentiment=sentiment,
        sentiment_score=round(sentiment_score, 2),
        emotion=emotion,
        is_urgent=is_urgent,
        is_frustrated=is_frustrated,
        matched_signals=signals[:8],
    )


def synthesis_tone_instruction(result: SentimentResult) -> str:
    """A short addendum for the synthesis system prompt - only added when
    it would actually change how the answer should be delivered, so a
    routine neutral question isn't prefixed with unnecessary tone-coaching."""
    if result.emotion == "frustrated":
        return (
            "\n\nTONE NOTE: the user's message reads as frustrated or upset. Open with one brief, "
            "genuine acknowledgment (e.g. \"Sorry about the trouble\") - no more than that - then "
            "answer plainly and directly. Do not over-apologize, do not add filler reassurance."
        )
    if result.emotion == "urgent":
        return (
            "\n\nTONE NOTE: the user's message reads as time-urgent. Lead with the single most "
            "actionable piece of information first, skip preamble entirely."
        )
    if result.emotion == "anxious":
        return (
            "\n\nTONE NOTE: the user's message suggests some worry (e.g. about a delay or refund). "
            "Be clear and reassuring where the facts genuinely support it, without minimizing the "
            "concern or promising anything not in the context."
        )
    return ""
