"""General railway knowledge (history, zones, categories...) must be answerable from the KB."""
import os
import sys

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))

import pytest  # noqa: E402
from rag_engine import get_engine  # noqa: E402


@pytest.mark.parametrize("question, expected_id", [
    ("when was the first train in india", "gk-history-first-trains"),
    ("list all indian railway zones", "gk-zones"),
    ("what is kavach", "gk-safety-kavach"),
    ("what does the first digit of train number mean", "gk-train-numbering-digits"),
    ("which is the longest train route", "gk-records"),
])
def test_general_knowledge_is_retrievable(question, expected_id):
    ids = [c.id for c in get_engine().retrieve(question, top_k=4).chunks]
    assert expected_id in ids


def test_agent_prompt_allows_general_knowledge():
    import railway_agent
    assert "GENERAL RAILWAY KNOWLEDGE" in railway_agent.build_system_prompt()
