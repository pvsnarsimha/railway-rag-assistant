"""
semantic_engine.py
--------------------
FEATURE 1: Semantic Search Upgrade.

Replaces pure keyword/TF-IDF matching with dense vector (embedding) search,
so paraphrased or loosely-worded questions ("what if my ticket never gets a
seat?") still match the right knowledge-base entry even when they share
almost no exact words with it ("waitlist", "RAC", "confirmed").

Primary path: sentence-transformers (all-MiniLM-L6-v2) — a small, fast,
CPU-friendly embedding model, encoded once at startup and cached on disk.

Fallback path: if sentence-transformers / torch isn't installed (e.g. a
constrained deployment box), we degrade to a TF-IDF + Truncated SVD
"pseudo-embedding" (latent semantic analysis). It's weaker than a real
embedding model but still captures co-occurring-word semantics rather than
exact tokens, and needs no extra heavy dependency, so the app never crashes
for lack of torch.

Either way, callers get the same contract: `encode(texts) -> np.ndarray`,
`similarity(query_vec, matrix) -> np.ndarray of cosine scores`.
"""

import hashlib
import json
import os
from typing import List

import numpy as np

_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")


class BaseSemanticEngine:
    name = "base"

    def encode(self, texts: List[str]) -> np.ndarray:
        raise NotImplementedError

    def similarity(self, query_vec: np.ndarray, matrix: np.ndarray) -> np.ndarray:
        # Cosine similarity, query_vec: (d,), matrix: (n, d)
        q = query_vec / (np.linalg.norm(query_vec) + 1e-10)
        m_norms = np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-10
        m = matrix / m_norms
        return m @ q


class TransformerSemanticEngine(BaseSemanticEngine):
    """Real dense embeddings via sentence-transformers (preferred path)."""

    name = "sentence-transformers/all-MiniLM-L6-v2"

    def __init__(self, model_name: str = "all-MiniLM-L6-v2"):
        from sentence_transformers import SentenceTransformer  # noqa: import kept local
        self._model = SentenceTransformer(model_name)

    def encode(self, texts: List[str]) -> np.ndarray:
        return np.asarray(self._model.encode(list(texts), normalize_embeddings=False, show_progress_bar=False))


class LSASemanticEngine(BaseSemanticEngine):
    """
    Fallback pseudo-embedding: TF-IDF followed by Truncated SVD (i.e. classic
    Latent Semantic Analysis). Cheap, dependency-light (scikit-learn only,
    already required elsewhere in this project), and captures term
    co-occurrence patterns rather than exact keyword overlap - a reasonable
    stand-in for a neural embedding model when one isn't available.
    """

    name = "tfidf-svd-lsa (fallback)"

    def __init__(self, n_components: int = 100):
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.decomposition import TruncatedSVD

        self._vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), max_df=0.95)
        self._n_components = n_components
        self._svd = None

    def fit(self, corpus: List[str]):
        tfidf = self._vectorizer.fit_transform(corpus)
        from sklearn.decomposition import TruncatedSVD
        k = min(self._n_components, max(2, tfidf.shape[1] - 1), max(2, tfidf.shape[0] - 1))
        self._svd = TruncatedSVD(n_components=k, random_state=42)
        return self._svd.fit_transform(tfidf)

    def encode(self, texts: List[str]) -> np.ndarray:
        if self._svd is None:
            raise RuntimeError("LSASemanticEngine.fit(corpus) must be called before encode().")
        tfidf = self._vectorizer.transform(texts)
        return self._svd.transform(tfidf)


def _hash_corpus(corpus: List[str]) -> str:
    h = hashlib.sha256()
    for t in corpus:
        h.update(t.encode("utf-8"))
    return h.hexdigest()[:16]


def build_semantic_index(corpus: List[str]):
    """
    Returns (engine, matrix). Tries the real transformer model first; falls
    back to LSA transparently. Embeddings are cached on disk per corpus hash
    so repeated startups don't re-encode the whole KB every time.
    """
    os.makedirs(_CACHE_DIR, exist_ok=True)
    digest = _hash_corpus(corpus)

    try:
        engine = TransformerSemanticEngine()
        cache_path = os.path.join(_CACHE_DIR, f"st_{digest}.npy")
        if os.path.isfile(cache_path):
            matrix = np.load(cache_path)
        else:
            matrix = engine.encode(corpus)
            np.save(cache_path, matrix)
        return engine, matrix
    except Exception:
        # sentence-transformers/torch unavailable or failed to load -> fall back.
        engine = LSASemanticEngine()
        matrix = engine.fit(corpus)
        return engine, matrix
