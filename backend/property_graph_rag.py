"""
property_graph_rag.py
------------------------
FEATURE: Advanced Graph RAG with Property Graphs.

graph_rag.py (the original Graph RAG feature) builds a plain, untyped,
undirected co-occurrence graph: two entities get an edge just because they
show up in the same KB entry, and "expansion" means "walk 1 hop, pull in
whatever's there". That's good enough for "these two topics are related",
but it can't answer "related HOW" - it can't tell a user that a Tatkal
ticket's waitlist *resolves at* chart preparation, which then *triggers*
automatic cancellation, which *leads to* a refund. Those are different,
directional, meaningfully-typed relationships, and the chain itself (not
just the bag of related entities) is the useful answer to a multi-hop
question.

This module layers a genuine property graph on top of the same KB entity
tags graph_rag.py already uses:
  - NODES carry a `type` property (quota_type, status, process,
    train_category, service, info) instead of being untyped strings.
  - EDGES carry a `relation` property from a small hand-curated domain
    ontology (e.g. "upgrades_to", "resolved_at", "triggers", "leads_to")
    rather than a generic, symmetric "co-occurs" weight. Entity pairs with
    no curated relation still connect via a `co_occurs_with` fallback edge
    (built from graph_rag's EntityGraph) so nothing present before is lost
    - the upgrade is additive, not a replacement.

`PropertyGraph.reason(text)` returns typed, directional REASONING PATHS
(e.g. `tatkal --restricts--> refund`) instead of a flat expanded-entity
list, giving the synthesis step (and the user, via rag_trace) an
explainable multi-hop chain rather than just "these docs are also
related".
"""

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import networkx as nx

from graph_rag import EntityGraph

# Node type ontology - what KIND of thing each entity id represents.
NODE_TYPES = {
    "premium_tatkal": "quota_type", "tatkal": "quota_type", "quota": "quota_type",
    "senior_citizen": "quota_type", "child_ticket": "quota_type",
    "wl": "status", "gnwl": "status", "pqwl": "status", "rlwl": "status",
    "rac": "status", "cnf": "status",
    "chart_preparation": "process", "cancellation": "process", "refund": "process",
    "rajdhani": "train_category", "shatabdi": "train_category", "duronto": "train_category",
    "vande_bharat": "train_category", "garib_rath": "train_category", "jan_shatabdi": "train_category",
    "irctc": "service", "e_ticket": "service", "i_ticket": "service",
    "platform_ticket": "service", "luggage": "service", "catering": "service", "helpline": "service",
    "station_code": "info", "live_status": "info", "seat_availability": "info", "classes": "info",
}
DEFAULT_NODE_TYPE = "concept"

# (source, relation, target) — hand-curated, directional. This is the
# "property"/typed layer that plain co-occurrence graphs don't have.
TYPED_RELATIONS: List[Tuple[str, str, str]] = [
    ("premium_tatkal", "is_variant_of", "tatkal"),
    ("tatkal", "can_have_status", "wl"),
    ("gnwl", "is_type_of", "wl"),
    ("pqwl", "is_type_of", "wl"),
    ("rlwl", "is_type_of", "wl"),
    ("wl", "upgrades_to", "rac"),
    ("rac", "upgrades_to", "cnf"),
    ("wl", "resolved_at", "chart_preparation"),
    ("chart_preparation", "triggers", "cancellation"),
    ("cancellation", "leads_to", "refund"),
    ("tatkal", "restricts", "refund"),
    ("quota", "includes", "tatkal"),
    ("quota", "includes", "senior_citizen"),
    ("quota", "includes", "child_ticket"),
    ("irctc", "issues", "e_ticket"),
    ("e_ticket", "alternative_to", "i_ticket"),
    ("live_status", "depends_on", "station_code"),
    ("seat_availability", "depends_on", "classes"),
    ("helpline", "assists_with", "refund"),
    ("helpline", "assists_with", "cancellation"),
    ("platform_ticket", "required_at", "station_code"),
]


@dataclass
class ReasoningPath:
    nodes: List[str] = field(default_factory=list)
    relations: List[str] = field(default_factory=list)
    doc_ids: List[str] = field(default_factory=list)
    typed_hop_count: int = 0  # how many hops used a curated (non-fallback) relation

    def as_str(self) -> str:
        parts = [self.nodes[0]] if self.nodes else []
        for rel, node in zip(self.relations, self.nodes[1:]):
            parts.append(f"--{rel}-->")
            parts.append(node)
        return " ".join(parts)


class PropertyGraph:
    def __init__(self, docs: List[dict], entity_graph: Optional[EntityGraph] = None):
        self._entity_graph = entity_graph or EntityGraph(docs)
        self.graph = nx.MultiDiGraph()

        for doc in docs:
            for e in doc.get("entities", []):
                self.graph.add_node(e, type=NODE_TYPES.get(e, DEFAULT_NODE_TYPE))

        for src, relation, dst in TYPED_RELATIONS:
            if src in self.graph.nodes and dst in self.graph.nodes:
                self.graph.add_edge(src, dst, relation=relation)

        # Fallback: any co-occurrence edge from the plain entity graph that
        # isn't already covered by a curated typed relation (in either
        # direction) still connects the two nodes, just generically typed.
        for u, v in self._entity_graph.graph.edges():
            if self.graph.has_edge(u, v) or self.graph.has_edge(v, u):
                continue
            self.graph.add_edge(u, v, relation="co_occurs_with")
            self.graph.add_edge(v, u, relation="co_occurs_with")

    def node_type(self, entity: str) -> str:
        return self.graph.nodes[entity]["type"] if entity in self.graph.nodes else DEFAULT_NODE_TYPE

    def reason(self, text: str, hops: int = 2, max_paths: int = 3) -> List[ReasoningPath]:
        """
        Detects entities mentioned in `text` (reusing graph_rag's alias
        matcher) and walks up to `hops` directed edges out from each,
        collecting typed reasoning paths. Paths that use more curated
        (non-fallback) relations are preferred over ones that lean on the
        generic co_occurs_with edge, since those are the ones that actually
        explain *why* two things are connected.
        """
        matched = self._entity_graph.detect_entities(text)
        if not matched:
            return []

        candidate_paths: List[ReasoningPath] = []
        seen_endpoints = set()

        for start in matched:
            if start not in self.graph.nodes:
                continue
            for path in self._walk(start, hops):
                if len(path.nodes) < 2:
                    continue
                endpoint = path.nodes[-1]
                key = (start, endpoint)
                if endpoint in matched or key in seen_endpoints:
                    continue
                seen_endpoints.add(key)
                path.doc_ids = sorted(self._entity_graph._entity_to_doc_ids.get(endpoint, set()))
                candidate_paths.append(path)

        # Prefer paths that lean on curated typed relations over generic
        # co-occurrence, then shorter (more direct) explanations.
        candidate_paths.sort(key=lambda p: (-p.typed_hop_count, len(p.nodes)))
        return candidate_paths[:max_paths]

    def _walk(self, start: str, hops: int) -> List[ReasoningPath]:
        results: List[ReasoningPath] = []

        def dfs(node: str, nodes: List[str], relations: List[str], typed_count: int, depth: int):
            if depth >= hops:
                return
            for _, nxt, data in self.graph.out_edges(node, data=True):
                if nxt in nodes:  # no revisits within one path
                    continue
                relation = data.get("relation", "co_occurs_with")
                is_typed = relation != "co_occurs_with"
                new_nodes = nodes + [nxt]
                new_relations = relations + [relation]
                new_typed_count = typed_count + (1 if is_typed else 0)
                results.append(ReasoningPath(nodes=new_nodes, relations=new_relations,
                                              typed_hop_count=new_typed_count))
                dfs(nxt, new_nodes, new_relations, new_typed_count, depth + 1)

        dfs(start, [start], [], 0, 0)
        return results

    def get_doc(self, doc_id: str) -> Optional[dict]:
        return self._entity_graph.get_doc(doc_id)
