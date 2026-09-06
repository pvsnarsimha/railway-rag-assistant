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
