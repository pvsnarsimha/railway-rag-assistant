"""
self_rag.py
--------------
FEATURE 4: Adaptive Retrieval (Self-RAG).

Not every message needs the full retrieval pipeline, and not every first
retrieval attempt succeeds. This module implements a lightweight version of
the Self-RAG idea (Asai et al.) - the system reflects on its own retrieval
before answering, instead of always doing one fixed retrieve-then-generate
pass:

  1. RETRIEVE?  - does this message even need knowledge-base grounding, or
     is it a greeting / thanks / already-answered-by-live-data message?
  2. ISREL (is relevant?) - for each retrieved chunk, is it actually
     relevant enough to use, or is it noise that happened to rank in the
     top-k?
  3. Reflect & retry - if nothing retrieved clears the relevance bar, try
     ONE broadened re-retrieval (lower the score floor, pull more
     candidates) before giving up, rather than silently answering ungrounded
     or silently returning nothing.

This keeps the control flow cheap (no extra LLM call is required for the
core loop - relevance is graded from the fused retrieval score, which is
already computed), while giving the "adaptive" behavior Self-RAG is named
for: retrieval effort scales with how well the first attempt worked.
"""

from dataclasses import dataclass
from typing import List


NO_RETRIEVAL_PATTERNS = (
    "hi", "hii", "hello", "hey", "thanks", "thank you", "thx", "ok", "okay",
    "bye", "goodbye", "good morning", "good evening",
)


@dataclass
class AdaptiveRetrievalPlan:
    should_retrieve: bool
    reason: str


def decide_retrieval(question: str, has_live_data: bool, has_live_error: bool) -> AdaptiveRetrievalPlan:
    """
    Step 1 of Self-RAG: decide whether retrieval is even worth running.
    Live-data intents still retrieve (a PNR/status answer usually benefits
    from a one-line policy grounding, e.g. explaining what "RAC" means), so
    this mainly filters out pure social/no-content messages.
    """
    stripped = question.strip().lower().rstrip("!.?")
    if stripped in NO_RETRIEVAL_PATTERNS:
        return AdaptiveRetrievalPlan(should_retrieve=False, reason="social/no-content message")
    if len(stripped) < 2:
        return AdaptiveRetrievalPlan(should_retrieve=False, reason="empty/too short")
    return AdaptiveRetrievalPlan(should_retrieve=True, reason="question requires grounding")


def grade_relevance(scored_docs: List, relevance_floor: float) -> List:
    """Step 2 (ISREL): keep only chunks whose fused retrieval score clears the floor."""
    return [d for d in scored_docs if d.fused_score >= relevance_floor]


def adaptive_retrieve(retriever, query: str, top_k: int = 3,
                       initial_floor: float = 0.01, broadened_floor: float = 0.0,
                       broadened_top_k: int = 6):
    """
    Runs the retrieve -> grade -> (maybe) retry-broader loop.
    Returns (accepted_docs, attempts, used_broadened: bool).
    """
    attempts = []

    first_pass = retriever.search(query, top_k=top_k)
    attempts.append(("initial", first_pass))
    accepted = grade_relevance(first_pass, initial_floor)
    if accepted:
        return accepted, attempts, False

    # Reflect: nothing cleared the bar. Retry once with a wider net instead
    # of either hallucinating an answer or returning nothing.
    second_pass = retriever.search(query, top_k=broadened_top_k)
    attempts.append(("broadened", second_pass))
    accepted = grade_relevance(second_pass, broadened_floor)
    return accepted, attempts, True
