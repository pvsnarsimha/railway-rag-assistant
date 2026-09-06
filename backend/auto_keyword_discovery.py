"""
auto_keyword_discovery.py
----------------------------
FEATURE: Automatic keyword/intent discovery (no manual keyword dumping).

query_router.py's keyword lists (LIVE_STATUS_KEYWORDS, SEAT_AVAIL_KEYWORDS,
...) and few_shot_intents.teach_intent() both still need a human to notice a
gap and type strings into either Python or an API call. This module removes
that human step for the *recurring* gap: questions that fall all the way
through to GENERAL_FAQ.

Two jobs, matching the two "solutions" this replaces:

  1. Automatic keyphrase extraction (replaces hand-typed keyword lists)
     -> extract_keyphrases(texts): YAKE first (pure Python, no torch/GPU,
        ranks phrases by statistical distinctiveness within the text - the
        same job KeyBERT/RAKE do, YAKE was picked because it has the
        lightest footprint and needs no embedding model download). Falls
        back to a bare CountVectorizer n-gram frequency count (scikit-learn
        is already a hard dependency of this project) if yake isn't
        installed, so this module never hard-fails the way
        semantic_engine.py never hard-fails on a missing torch install.

  2. Automatic intent discovery (replaces a human deciding "this is a new
     category, let me teach it")
     -> discover_clusters(questions, semantic_engine): reuses the SAME
        embedding engine the RAG pipeline already built (zero extra model
        load, exactly like few_shot_intents.match() already does), then
        clusters. Tries BERTopic if it's installed (better topic labels,
        handles noise/outliers natively); falls back to scikit-learn
        KMeans over those same embeddings (BERTopic itself is UMAP+HDBSCAN
        over embeddings under the hood - the KMeans fallback is the same
        idea with dependencies this project already has).

  3. run_auto_discovery(): the orchestrator that closes the loop end to
     end - pulls logged GENERAL_FAQ misses from analytics.py, clusters
     them, extracts a keyphrase-based name per cluster, and calls
     few_shot_intents.teach_intent() automatically for every cluster that
     clears a minimum size. No one ever opens query_router.py or calls
     /api/intents/teach by hand; app.py just needs to invoke this
     periodically (see /api/intents/auto-discover in app.py) - a cron job
     or an ops person clicking one button is the entire "manual" step left.

Entity extraction (stations, train numbers) is NOT handled here - see
entity_gazetteer.py, which auto-builds a station/city matcher straight from
data/city_aliases.json + data/station_coordinates.json instead of a
hand-maintained stopword list.
"""

import re
from collections import Counter
from typing import Dict, List, Optional

import numpy as np

import analytics
import few_shot_intents


# ---------------------------------------------------------------------------
# 1. Automatic keyphrase extraction
# ---------------------------------------------------------------------------

def extract_keyphrases(texts: List[str], top_n: int = 6) -> List[str]:
    """
    Returns up to `top_n` railway-relevant keyphrases mined from `texts`,
    ranked by relevance - no human types these.
    """
    corpus = " . ".join(t.strip() for t in texts if t and t.strip())
    if not corpus:
        return []

    try:
        import yake
        extractor = yake.KeywordExtractor(
            lan="en", n=3, top=top_n, dedupLim=0.85,
        )
        # YAKE scores are "lower is better" (distance-like), so ascending sort.
        pairs = extractor.extract_keywords(corpus)
        pairs.sort(key=lambda p: p[1])
        return [phrase.lower() for phrase, _score in pairs[:top_n]]
    except Exception:
        return _fallback_ngram_keyphrases(texts, top_n)


def _fallback_ngram_keyphrases(texts: List[str], top_n: int) -> List[str]:
    """No-embedding, no-extra-dependency fallback: frequency-ranked n-grams
    via scikit-learn's CountVectorizer (already a hard dependency here)."""
    try:
        from sklearn.feature_extraction.text import CountVectorizer
        vectorizer = CountVectorizer(ngram_range=(1, 3), stop_words="english", max_features=200)
        matrix = vectorizer.fit_transform(texts)
        counts = np.asarray(matrix.sum(axis=0)).ravel()
        vocab = vectorizer.get_feature_names_out()
        ranked = sorted(zip(vocab, counts), key=lambda p: -p[1])
        return [phrase for phrase, count in ranked[:top_n] if count > 0]
    except Exception:
        # Last-resort: raw word frequency, no third-party imports at all.
        words = re.findall(r"[a-zA-Z]{3,}", " ".join(texts).lower())
        common = Counter(w for w in words if w not in _BASIC_STOPWORDS)
        return [w for w, _ in common.most_common(top_n)]


_BASIC_STOPWORDS = {
    "the", "and", "for", "are", "you", "your", "with", "from", "that", "this",
    "what", "when", "how", "will", "can", "any", "does", "did", "was", "were",
}


# ---------------------------------------------------------------------------
# 2. Automatic intent (cluster) discovery
# ---------------------------------------------------------------------------

def discover_clusters(
    questions: List[str],
    semantic_engine,
    min_cluster_size: int = 3,
    max_clusters: int = 8,
) -> List[Dict]:
    """
    Groups `questions` into topic clusters automatically. Returns a list of
    dicts: {"questions": [...], "keyphrases": [...]}. Reuses whichever
    engine rag_engine.py already built (real sentence-transformers or the
    TF-IDF/SVD fallback - see semantic_engine.py), so this costs one more
    `.encode()` call, not a new model.
    """
    if len(questions) < min_cluster_size:
        return []

    try:
        return _discover_with_bertopic(questions, min_cluster_size)
    except Exception:
        return _discover_with_kmeans(questions, semantic_engine, min_cluster_size, max_clusters)


def _discover_with_bertopic(questions: List[str], min_cluster_size: int) -> List[Dict]:
    from bertopic import BERTopic  # optional heavy dependency; see requirements.txt

    topic_model = BERTopic(min_topic_size=min_cluster_size, verbose=False)
    topics, _probs = topic_model.fit_transform(questions)

    clusters: Dict[int, List[str]] = {}
    for question, topic_id in zip(questions, topics):
        if topic_id == -1:  # BERTopic's built-in "noise / no clear topic" bucket
            continue
        clusters.setdefault(topic_id, []).append(question)

    results = []
    for topic_id, qs in clusters.items():
        if len(qs) < min_cluster_size:
            continue
        keyphrases = [word for word, _score in topic_model.get_topic(topic_id)[:6]]
        results.append({"questions": qs, "keyphrases": keyphrases})
    return results


def _discover_with_kmeans(
    questions: List[str], semantic_engine, min_cluster_size: int, max_clusters: int,
) -> List[Dict]:
    from sklearn.cluster import KMeans

    embeddings = semantic_engine.encode(questions)
    n_clusters = max(1, min(max_clusters, len(questions) // min_cluster_size))
    if n_clusters < 2:
        # Not enough volume to split meaningfully - treat everything as one
        # candidate cluster and let the size check below decide.
        labels = np.zeros(len(questions), dtype=int)
    else:
        km = KMeans(n_clusters=n_clusters, n_init=10, random_state=42)
        labels = km.fit_predict(embeddings)

    results = []
    for label in sorted(set(labels)):
        qs = [q for q, l in zip(questions, labels) if l == label]
        if len(qs) < min_cluster_size:
            continue
        keyphrases = extract_keyphrases(qs, top_n=6)
        results.append({"questions": qs, "keyphrases": keyphrases})
    return results


# ---------------------------------------------------------------------------
# 3. Orchestrator: close the loop, no human typing required
# ---------------------------------------------------------------------------

def run_auto_discovery(
    semantic_engine,
    min_cluster_size: int = 3,
    max_new_intents: int = 5,
) -> Dict:
    """
    Pulls recent GENERAL_FAQ misses -> clusters them -> auto-teaches each
    cluster as a new few-shot intent via few_shot_intents.teach_intent().
    Meant to be called periodically (cron / an ops "run discovery" button),
    not per-request - clustering a batch is cheap, doing it per message
    would not be.
    """
    misses = analytics.get_recent_misses(limit=500)
    if len(misses) < min_cluster_size:
        return {"ran": True, "misses_seen": len(misses), "new_intents": []}

    clusters = discover_clusters(misses, semantic_engine, min_cluster_size=min_cluster_size)
    clusters.sort(key=lambda c: -len(c["questions"]))

    taught = []
    for cluster in clusters[:max_new_intents]:
        name = _name_from_keyphrases(cluster["keyphrases"]) or "auto_topic"
        result = few_shot_intents.teach_intent(
            name=name,
            examples=cluster["questions"][:10],
            response_hint=f"Auto-discovered from {len(cluster['questions'])} similar unmatched questions; "
                           f"keyphrases: {', '.join(cluster['keyphrases'][:4])}",
        )
        taught.append({
            "name": result.name,
            "example_count": len(result.examples),
            "source_question_count": len(cluster["questions"]),
            "keyphrases": cluster["keyphrases"],
        })

    return {"ran": True, "misses_seen": len(misses), "new_intents": taught}


def _name_from_keyphrases(keyphrases: List[str]) -> Optional[str]:
    if not keyphrases:
        return None
    slug = re.sub(r"[^a-z0-9]+", "_", keyphrases[0].lower()).strip("_")
    return slug or None
