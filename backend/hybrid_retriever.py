"""
hybrid_retriever.py
----------------------
FEATURE 2: Hybrid Retrieval (BM25 + Semantic).

Pure semantic search can miss exact-token hits that matter a lot in this
domain (a station code like "NDLS", a quota code like "RLWL", an exact
policy term like "clerkage"). Pure lexical (BM25) search misses paraphrases.
This module runs both and fuses their rankings with Reciprocal Rank Fusion
(RRF) - a simple, weight-free way to combine ranked lists that doesn't
require the two scores to be on the same scale (BM25 scores and cosine
similarities aren't comparable, so averaging raw scores would be wrong).

RRF formula per candidate doc d:  score(d) = sum_over_rankers( 1 / (k + rank_d) )
k=60 is the standard constant from the original RRF paper; it just dampens
the influence of any single very-high rank so the fusion isn't dominated by
one retriever's top pick.
"""

from dataclasses import dataclass
from typing import List

import numpy as np
from rank_bm25 import BM25Okapi

from semantic_engine import build_semantic_index


@dataclass
class ScoredDoc:
    idx: int
    bm25_score: float
    semantic_score: float
    fused_score: float


def _tokenize(text: str) -> List[str]:
    return text.lower().split()


class HybridRetriever:
    def __init__(self, corpus: List[str], rrf_k: int = 60):
        self._corpus = corpus
        self._rrf_k = rrf_k

        tokenized = [_tokenize(t) for t in corpus]
        self._bm25 = BM25Okapi(tokenized)

        self._semantic_engine, self._semantic_matrix = build_semantic_index(corpus)

    @property
    def semantic_engine_name(self) -> str:
        return self._semantic_engine.name

    def search(self, query: str, top_k: int = 5) -> List[ScoredDoc]:
        n = len(self._corpus)

        bm25_scores = self._bm25.get_scores(_tokenize(query))
        bm25_ranked = np.argsort(bm25_scores)[::-1]

        query_vec = self._semantic_engine.encode([query])[0]
        semantic_scores = self._semantic_engine.similarity(query_vec, self._semantic_matrix)
        semantic_ranked = np.argsort(semantic_scores)[::-1]

        # Reciprocal Rank Fusion across the two ranked lists.
        rrf_scores = np.zeros(n)
        for rank, doc_idx in enumerate(bm25_ranked):
            rrf_scores[doc_idx] += 1.0 / (self._rrf_k + rank + 1)
        for rank, doc_idx in enumerate(semantic_ranked):
            rrf_scores[doc_idx] += 1.0 / (self._rrf_k + rank + 1)

        fused_order = np.argsort(rrf_scores)[::-1][:top_k]

        results = []
        for idx in fused_order:
            results.append(
                ScoredDoc(
                    idx=int(idx),
                    bm25_score=float(bm25_scores[idx]),
                    semantic_score=float(semantic_scores[idx]),
                    fused_score=float(rrf_scores[idx]),
                )
            )
        return results
