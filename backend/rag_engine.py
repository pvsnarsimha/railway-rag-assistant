"""
rag_engine.py
--------------
Orchestrates all six RAG upgrades into one retrieval call:

  1. Semantic Search Upgrade   -> semantic_engine.py
  2. Hybrid Retrieval          -> hybrid_retriever.py   (BM25 + semantic, RRF fusion)
  3. Contextual Compression    -> compression.py        (trim chunks to relevant sentences)
  4. Adaptive Retrieval        -> self_rag.py            (retrieve? / relevance grading / retry)
  5. Multi-Modal RAG           -> multimodal.py          (diagram lookup on the answer side)
  6. Graph RAG                 -> graph_rag.py           (entity-graph 1-hop expansion)

`AdvancedRAGEngine.retrieve(query)` is the single entry point app.py calls.
It returns a RetrievalResult bundling everything the synthesis step and the
frontend need: the final compressed chunks, which retrieval path found each
one (hybrid vs. graph-expanded), any diagrams to show, and a short trace of
what the adaptive controller decided - useful for debugging why an answer
was or wasn't grounded.
"""

import json
import os
from dataclasses import dataclass, field
from typing import List, Optional

from hybrid_retriever import HybridRetriever
from compression import compress_chunks, CompressedChunk
from graph_rag import EntityGraph
from property_graph_rag import PropertyGraph
from self_rag import decide_retrieval, adaptive_retrieve
from multimodal import get_diagrams_for_docs

KB_PATH = os.path.join(os.path.dirname(__file__), "data", "knowledge_base.json")


@dataclass
class RetrievedChunk:
    """Kept for backward compatibility with any code expecting the old,
    simpler rag_engine.py contract (id/category/text/score)."""
    id: str
    category: str
    text: str
    score: float


@dataclass
class RetrievalResult:
    chunks: List[CompressedChunk] = field(default_factory=list)
    diagrams: List[dict] = field(default_factory=list)
    retrieval_performed: bool = True
    used_broadened_search: bool = False
    used_graph_expansion: bool = False
    graph_matched_entities: List[str] = field(default_factory=list)
    reasoning_paths: List[str] = field(default_factory=list)
    engine_name: str = ""
    skip_reason: Optional[str] = None


class AdvancedRAGEngine:
    def __init__(self, kb_path: str = KB_PATH):
        with open(kb_path, "r", encoding="utf-8") as f:
            self.docs = json.load(f)
        self.corpus = [d["text"] for d in self.docs]

        self.hybrid = HybridRetriever(self.corpus)
        self.graph = EntityGraph(self.docs)
        self.property_graph = PropertyGraph(self.docs, entity_graph=self.graph)

    def retrieve(self, query: str, top_k: int = 3, has_live_data: bool = False,
                 has_live_error: bool = False, use_graph_expansion: bool = True) -> RetrievalResult:
        # --- Step 4a: Self-RAG "should we even retrieve?" gate ---
        plan = decide_retrieval(query, has_live_data, has_live_error)
        if not plan.should_retrieve:
            return RetrievalResult(retrieval_performed=False, skip_reason=plan.reason,
                                    engine_name=self.hybrid.semantic_engine_name)

        # --- Step 2 + 4b: hybrid retrieval, graded, with one broadened retry if needed ---
        accepted, attempts, used_broadened = adaptive_retrieve(self.hybrid, query, top_k=top_k)

        selected_docs = [self.docs[d.idx] for d in accepted]

        # --- Step 6: Graph RAG - pull in entries the ranked retrieval missed:
        # both entries directly about an entity the query mentions, and
        # entries about entities 1 hop away in the co-occurrence graph ---
        used_graph_expansion = False
        matched_entities: List[str] = []
        if use_graph_expansion:
            already_ids = {d["id"] for d in selected_docs}
            expansion = self.graph.expand(query, already_retrieved_doc_ids=already_ids)
            matched_entities = expansion.matched_entities
            for doc_id in expansion.direct_doc_ids + expansion.expanded_doc_ids:
                if doc_id in already_ids:
                    continue
                doc = self.graph.get_doc(doc_id)
                if doc:
                    selected_docs.append(doc)
                    already_ids.add(doc_id)
                    used_graph_expansion = True

        as_retrieved_chunks = [
            RetrievedChunk(id=d["id"], category=d["category"], text=d["text"], score=1.0)
            for d in selected_docs
        ]

        # --- Step 3: Contextual compression - trim each chunk to its most
        # query-relevant sentences before it goes to synthesis ---
        compressed = compress_chunks(query, as_retrieved_chunks, self.hybrid._semantic_engine)

        # --- Step 5: Multi-modal - attach any diagrams tied to selected docs ---
        diagrams = get_diagrams_for_docs(selected_docs)

        # --- Advanced Graph RAG (property graph) - typed, directional
        # multi-hop reasoning chains explaining WHY entities are related,
        # on top of the plain co-occurrence expansion above ---
        reasoning_paths: List[str] = []
        if use_graph_expansion:
            for path in self.property_graph.reason(query, hops=2, max_paths=3):
                reasoning_paths.append(path.as_str())

        return RetrievalResult(
            chunks=compressed,
            diagrams=diagrams,
            retrieval_performed=True,
            used_broadened_search=used_broadened,
            used_graph_expansion=used_graph_expansion,
            graph_matched_entities=matched_entities,
            reasoning_paths=reasoning_paths,
            engine_name=self.hybrid.semantic_engine_name,
        )


# Module-level singleton so the indexes (BM25, semantic embeddings, graph)
# are only built once per process.
_engine_instance = None


def get_engine() -> AdvancedRAGEngine:
    global _engine_instance
    if _engine_instance is None:
        _engine_instance = AdvancedRAGEngine()
    return _engine_instance


# --- Legacy shim -------------------------------------------------------
# Older code (or the pyc-only deployment) may still import get_retriever()
# and call .retrieve(query, top_k) expecting a plain list of chunks back.
# Keep that working by wrapping the new engine.
class _LegacyRetrieverShim:
    def retrieve(self, query: str, top_k: int = 3):
        result = get_engine().retrieve(query, top_k=top_k)
        return [
            RetrievedChunk(id=c.id, category=c.category, text=c.compressed_text, score=1.0)
            for c in result.chunks
        ]


def get_retriever() -> _LegacyRetrieverShim:
    return _LegacyRetrieverShim()
