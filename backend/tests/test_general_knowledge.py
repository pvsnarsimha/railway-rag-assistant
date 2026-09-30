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


@pytest.mark.parametrize("question, expected_id", [
    ("how many days in advance can I book a train ticket", "rule-arp-60-days"),
    ("cancellation charges for sleeper class", "rule-cancel-flat-charges"),
    ("train is 4 hours late can I get refund", "rule-train-late-3-hours"),
    ("where can I find official railway rules", "rule-official-sources"),
    ("when is the reservation chart prepared", "rule-chart-timing-2025"),
])
def test_official_rules_are_retrievable(question, expected_id):
    ids = [c.id for c in get_engine().retrieve(question, top_k=4).chunks]
    assert expected_id in ids


def test_new_rule_entries_carry_a_source():
    import json
    import rag_engine
    kb = json.load(open(rag_engine.KB_PATH, encoding="utf-8"))
    rules = [x for x in kb if x["id"].startswith("rule-")]
    assert len(rules) >= 15 and all(r.get("source") and r.get("verified") for r in rules)


def test_current_rule_values():
    import json
    import rag_engine
    kb = {x["id"]: x for x in json.load(open(rag_engine.KB_PATH, encoding="utf-8"))}
    assert "Rs 500" in kb["rule-no-ticket-penalty"]["text"] and "1 July 2026" in kb["rule-no-ticket-penalty"]["text"]
    assert "20:00" in kb["rule-chart-timing-2025"]["text"] and "10 hours" in kb["rule-chart-timing-2025"]["text"]
    assert "100 cm x 60 cm x 25 cm" in kb["rule-luggage-excess"]["text"]
    assert "Nationalised Bank passbook" in kb["rule-id-proof"]["text"]
    assert "48 hours" in kb["rule-ticket-transfer"]["text"]
