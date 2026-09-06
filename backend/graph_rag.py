"""
graph_rag.py
--------------
FEATURE 6: Graph RAG.

Vector/BM25 retrieval only finds documents that individually match the
query. It doesn't reason across documents. But a lot of real railway
questions are inherently multi-hop: "if my Tatkal ticket stays waitlisted,
what happens at chart preparation and do I get a refund?" touches three
separate KB entries (tatkal-rules, chart-preparation, cancellation-refund-
waitlist) that don't necessarily all score highly against the raw query
text.

This module builds a small knowledge graph over the KB: nodes are domain
entities (e.g. "tatkal", "waitlist", "chart_preparation", "refund"), and
edges connect entities that co-occur inside the same KB entry (each entry
is tagged with an `entities` list in knowledge_base.json). Given a query,
we detect which entities it mentions, then walk 1 hop out in the graph to
pull in KB entries about *related* entities that the query didn't literally
mention - the same multi-hop expansion idea behind GraphRAG, scoped down to
something that runs instantly with no external graph DB.
"""

import re
from dataclasses import dataclass, field
from typing import Dict, List, Set

import networkx as nx

# Human phrasing -> canonical entity id. Longest phrases first so "premium
# tatkal" matches before the generic "tatkal" substring inside it.
ENTITY_ALIASES: Dict[str, str] = {
    "premium tatkal": "premium_tatkal",
    "tatkal": "tatkal",
    "waitlist": "wl",
    "wait list": "wl",
    "gnwl": "gnwl",
    "pqwl": "pqwl",
    "rlwl": "rlwl",
    "rac": "rac",
    "confirmed": "cnf",
    "cnf": "cnf",
    "chart preparation": "chart_preparation",
    "chart": "chart_preparation",
    "cancellation": "cancellation",
    "cancel": "cancellation",
    "refund": "refund",
    "clerkage": "refund",
    "quota": "quota",
    "senior citizen": "senior_citizen",
    "child ticket": "child_ticket",
    "children": "child_ticket",
    "rajdhani": "rajdhani",
    "shatabdi": "shatabdi",
    "duronto": "duronto",
    "vande bharat": "vande_bharat",
    "garib rath": "garib_rath",
    "jan shatabdi": "jan_shatabdi",
    "irctc": "irctc",
    "e-ticket": "e_ticket",
    "i-ticket": "i_ticket",
    "platform ticket": "platform_ticket",
    "luggage": "luggage",
    "catering": "catering",
    "food": "catering",
    "helpline": "helpline",
    "rail madad": "helpline",
    "station code": "station_code",
    "running status": "live_status",
    "live status": "live_status",
    "seat availability": "seat_availability",
    "berth": "classes",
    "berths": "classes",
    "classes": "classes",
    "class": "classes",
    "coach": "classes",
    "coaches": "classes",
    "quotas": "quota",
}


@dataclass
class GraphExpansionResult:
    matched_entities: List[str] = field(default_factory=list)
    expanded_entities: List[str] = field(default_factory=list)
    direct_doc_ids: List[str] = field(default_factory=list)
    expanded_doc_ids: List[str] = field(default_factory=list)


class EntityGraph:
    def __init__(self, docs: List[dict]):
        self._docs = docs
        self._doc_by_id = {d["id"]: d for d in docs}
        self.graph = nx.Graph()
        self._entity_to_doc_ids: Dict[str, Set[str]] = {}

        for doc in docs:
            entities = doc.get("entities", [])
            for e in entities:
                self.graph.add_node(e)
                self._entity_to_doc_ids.setdefault(e, set()).add(doc["id"])
            # Co-occurrence edges: any two entities appearing in the same
            # doc are considered related.
            for i in range(len(entities)):
                for j in range(i + 1, len(entities)):
                    if self.graph.has_edge(entities[i], entities[j]):
                        self.graph[entities[i]][entities[j]]["weight"] += 1
                    else:
                        self.graph.add_edge(entities[i], entities[j], weight=1)

    def detect_entities(self, text: str) -> List[str]:
        lower = f" {text.lower()} "
        found = []
        for phrase, entity_id in ENTITY_ALIASES.items():
            if re.search(r"(?<![a-z0-9])" + re.escape(phrase) + r"(?![a-z0-9])", lower):
                found.append(entity_id)
        return sorted(set(found))

    def expand(self, text: str, already_retrieved_doc_ids=None, hops: int = 1,
               max_new_docs: int = 3) -> GraphExpansionResult:
        """
        already_retrieved_doc_ids: doc ids the ranked (hybrid) search already
        surfaced - used only to avoid listing duplicates in expanded_doc_ids,
        NOT to decide what counts as "direct". A KB entry that is literally
        about a matched entity is always a direct hit, whether or not the
        ranked search happened to find it too.
        """
        already_retrieved = set(already_retrieved_doc_ids or [])
        matched = self.detect_entities(text)
        if not matched:
            return GraphExpansionResult()

        direct_doc_ids: List[str] = []
        for e in matched:
            for doc_id in self._entity_to_doc_ids.get(e, set()):
                if doc_id not in direct_doc_ids:
                    direct_doc_ids.append(doc_id)

        frontier = set(matched)
        visited = set(matched)
        for _ in range(hops):
            next_frontier = set()
            for node in frontier:
                if node in self.graph:
                    next_frontier |= set(self.graph.neighbors(node))
            next_frontier -= visited
            visited |= next_frontier
            frontier = next_frontier

        expanded_entities = sorted(visited - set(matched))

        covered = already_retrieved | set(direct_doc_ids)
        new_doc_ids: List[str] = []
        for e in expanded_entities:
            for doc_id in self._entity_to_doc_ids.get(e, set()):
                if doc_id not in covered and doc_id not in new_doc_ids:
                    new_doc_ids.append(doc_id)
            if len(new_doc_ids) >= max_new_docs:
                break

        return GraphExpansionResult(
            matched_entities=matched,
            expanded_entities=expanded_entities,
            direct_doc_ids=direct_doc_ids,
            expanded_doc_ids=new_doc_ids[:max_new_docs],
        )

    def get_doc(self, doc_id: str) -> dict:
        return self._doc_by_id.get(doc_id)
