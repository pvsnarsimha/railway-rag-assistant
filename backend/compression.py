"""
compression.py
-----------------
FEATURE 3: Contextual Compression (RAG Refinement).

A retrieved knowledge-base entry is often a whole paragraph, but only one or
two sentences in it are actually relevant to the specific question asked.
Passing the full paragraph to Claude wastes context and dilutes relevance
(and, for the templated fallback path with no API key, makes raw dumps to
the user noisier than necessary). This module compresses each retrieved
chunk down to just the sentences that matter for the current query, before
it's handed to the synthesis step.

Approach: split each chunk into sentences, embed sentence + query with the
same semantic engine already loaded for retrieval (no extra model), keep the
top-scoring sentences (by count or score threshold), and reassemble them in
their original order (so the compressed text still reads naturally rather
than as a shuffled bag of sentences).
"""

import re
from dataclasses import dataclass
from typing import List

import numpy as np


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "do", "does", "did", "i", "my", "me", "can", "get",
    "to", "of", "in", "on", "for", "and", "or", "if", "it", "this", "that", "what", "which", "when", "how",
    "at", "by", "with", "from", "as", "will", "would", "should", "there", "any", "please", "tell", "about",
}
# A question asking for a quantity ("how much", "what time", "minimum penalty") is answered by the
# sentence that contains the number, which a semantic score alone often ranks below generic context.
_QUANTITY_CUE_RE = re.compile(
    r"\b(how (?:much|many|long|far|early|late|old)|what time|at what|when|number|fee|fees|charge|charges|"
    r"penalty|fine|limit|minimum|maximum|free|age|hours?|days?|kg|fare|cost|price)\b", re.IGNORECASE)
_DIGIT_RE = re.compile(r"\d")
_LEXICAL_WEIGHT = 0.5
_QUANTITY_BONUS = 0.3


def _content_tokens(text: str) -> set:
    return {t.rstrip("s") for t in _TOKEN_RE.findall(text.lower()) if t not in _STOPWORDS and len(t) > 1}


def _lexical_scores(query: str, sentences: List[str]) -> np.ndarray:
    q = _content_tokens(query)
    if not q:
        return np.zeros(len(sentences))
    return np.array([len(q & _content_tokens(s)) / len(q) for s in sentences])


def _split_sentences(text: str) -> List[str]:
    parts = [s.strip() for s in _SENTENCE_SPLIT_RE.split(text) if s.strip()]
    return parts if parts else [text]


@dataclass
class CompressedChunk:
    id: str
    category: str
    original_text: str
    compressed_text: str
    kept_ratio: float


def compress_chunk(query: str, doc_id: str, category: str, text: str,
                    semantic_engine, min_sentences: int = 1,
                    keep_fraction: float = 0.6) -> CompressedChunk:
    """
    Compresses one retrieved chunk relative to `query`. Always keeps at
    least `min_sentences` sentence(s) even if the whole chunk scores low -
    we're refining, not discarding, a chunk retrieval already judged relevant.
    """
    sentences = _split_sentences(text)
    if len(sentences) <= min_sentences:
        return CompressedChunk(doc_id, category, text, text, 1.0)

    try:
        vecs = semantic_engine.encode(sentences)
        query_vec = semantic_engine.encode([query])[0]
        scores = np.array([semantic_engine.similarity(query_vec, vecs[i:i + 1])[0] for i in range(len(sentences))])
    except Exception:
        # If encoding fails for any reason, fail safe -> keep the whole chunk.
        return CompressedChunk(doc_id, category, text, text, 1.0)

    # Hybrid score: the semantic similarity (min-max scaled so it is comparable) plus exact word
    # overlap with the question, plus a bonus for number-bearing sentences on quantity questions.
    spread = scores.max() - scores.min()
    sem = (scores - scores.min()) / spread if spread > 1e-9 else np.zeros(len(scores))
    scores = (1 - _LEXICAL_WEIGHT) * sem + _LEXICAL_WEIGHT * _lexical_scores(query, sentences)
    if _QUANTITY_CUE_RE.search(query):
        scores = scores + _QUANTITY_BONUS * np.array([1.0 if _DIGIT_RE.search(x) else 0.0 for x in sentences])

    keep_n = max(min_sentences, int(round(len(sentences) * keep_fraction)))
    keep_n = min(keep_n, len(sentences))

    top_indices = sorted(np.argsort(scores)[::-1][:keep_n].tolist())
    compressed = " ".join(sentences[i] for i in top_indices)

    return CompressedChunk(
        id=doc_id,
        category=category,
        original_text=text,
        compressed_text=compressed,
        kept_ratio=round(keep_n / len(sentences), 2),
    )


def compress_chunks(query: str, chunks, semantic_engine) -> List[CompressedChunk]:
    """chunks: iterable of objects with .id, .category, .text attributes."""
    return [compress_chunk(query, c.id, c.category, c.text, semantic_engine) for c in chunks]
