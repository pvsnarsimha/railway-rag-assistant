import os
import sys

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))

from api_cache import cached  # noqa: E402


def test_empty_results_are_not_cached_when_skip_empty():
    calls = {"n": 0}

    @cached(ttl_seconds=60, prefix="t_skip_empty", skip_empty=True)
    def search(q):
        calls["n"] += 1
        return [] if calls["n"] == 1 else ["hit"]   # first call "fails soft" with []

    assert search("x") == []
    assert search("x") == ["hit"]      # retried, not stuck on the failed []
    assert search("x") == ["hit"]      # good result IS cached
    assert calls["n"] == 2


def test_default_still_caches_everything():
    calls = {"n": 0}

    @cached(ttl_seconds=60, prefix="t_default")
    def f(q):
        calls["n"] += 1
        return []

    f("x"); f("x")
    assert calls["n"] == 1
