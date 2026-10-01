"""Routing regression sets, compression behaviour, and the answer-eval scoring logic."""
import json
import os
import sys

_BACKEND = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, _BACKEND)
sys.path.insert(0, os.path.join(_BACKEND, "evaluation"))
os.chdir(_BACKEND)

import numpy as np  # noqa: E402
import pytest  # noqa: E402
import query_router  # noqa: E402
import compression  # noqa: E402
import answer_eval as ae  # noqa: E402

EVAL = os.path.join(_BACKEND, "evaluation")


@pytest.mark.parametrize("fname", ["intent_cases.json", "intent_cases_heldout.json",
                                   "intent_cases_validation.json", "intent_cases_regression.json"])
def test_tuned_routing_sets_do_not_regress(fname):
    cases = json.load(open(os.path.join(EVAL, fname), encoding="utf-8"))
    wrong = [(t, query_router.classify(t)["intent"].value, want) for t, want, _ in cases
             if query_router.classify(t)["intent"].value != want]
    assert wrong == []


def test_blind_set_stays_above_floor():
    cases = json.load(open(os.path.join(EVAL, "intent_cases_blind.json"), encoding="utf-8"))
    ok = sum(query_router.classify(t)["intent"].value == want for t, want, _ in cases)
    assert ok / len(cases) >= 0.74


def test_helpline_is_not_the_app_help_intent():
    """'help' inside 'helpline' used to return the app tutorial instead of the number 139."""
    assert query_router.classify("what is the railway helpline number")["intent"] == query_router.Intent.GENERAL_FAQ
    assert query_router.classify("help")["intent"] == query_router.Intent.HELP


def test_policy_questions_with_route_words_go_to_faq():
    for q in ["how do I cancel my ticket", "what is the refund if my train is delayed by 4 hours",
              "can I change my route after booking"]:
        assert query_router.classify(q)["intent"] == query_router.Intent.GENERAL_FAQ, q


def test_ordinary_words_are_not_stations():
    assert query_router.classify("can I carry a pet in train")["intent"] == query_router.Intent.GENERAL_FAQ


def test_new_city_aliases_resolve():
    assert query_router._extract_stations("trains from Varanasi to Lucknow") == ["BSB", "LKO"]


class _FakeEngine:
    """Semantic scores that rank the WRONG sentence first, so only the lexical/number boost can save the fact."""
    def encode(self, texts):
        return np.array([[1.0 if "generic" in t.lower() else 0.1] for t in texts])

    def similarity(self, q, v):
        return np.array([float(v[0][0])])


def test_compression_keeps_the_sentence_with_the_number():
    text = ("Generic introduction about penalties on trains. Generic background about the Railways Act. "
            "The minimum penalty is Rs 500 for travelling without a ticket. Generic closing remark.")
    out = compression.compress_chunk("what is the minimum penalty for travelling without a ticket",
                                     "x", "c", text, _FakeEngine(), keep_fraction=0.4)
    assert "Rs 500" in out.compressed_text


# --- answer-eval scoring ---------------------------------------------------
CASE = {"q": "How many days in advance can I book?", "gold": ["rule-arp-60-days"], "required": [["60 days", "60-day"]]}


def test_score_factual_paraphrase_and_missing():
    ok = ae.score_factual(CASE, "You can book up to 60 days ahead.", ["rule-arp-60-days"], {"rule-arp-60-days": "up to 60 days"})
    assert ok["full_facts"] and ok["source_hit"] and ok["unsupported_numbers"] == []
    bad = ae.score_factual(CASE, "Booking opens early.", [], {})
    assert not bad["full_facts"] and bad["missing"] == ["60 days"] and not bad["source_hit"]


def test_unsupported_number_is_flagged_as_hallucination():
    r = ae.score_factual(CASE, "You can book 60 days ahead, with a fee of Rs 750.", ["rule-arp-60-days"],
                         {"rule-arp-60-days": "up to 60 days"})
    assert r["unsupported_numbers"] == ["750"]


def test_numbers_from_question_are_allowed():
    r = ae.score_factual({"q": "Is 12951 delayed?", "gold": [], "required": [["delayed"]]},
                         "Train 12951 is delayed.", [], {})
    assert r["unsupported_numbers"] == []


def test_score_abstain_and_no_live():
    assert ae.score_abstain("Sorry, I can only help with Indian Railways questions.", ["can only help"])["declined"]
    assert not ae.score_abstain("Here's what I found: chart is prepared", ["can only help"])["declined"]
    assert ae.score_no_live("Could not reach the live data service.", ["could not"], ["minutes late"])["honest"]
    r = ae.score_no_live("Could not reach it, but it is 20 minutes late.", ["could not"], ["minutes late"])
    assert not r["honest"] and r["invented"] == ["minutes late"]


def test_judge_with_fake_llm():
    fake = lambda prompt: 'Sure: {"faithfulness": 4, "reason": "ok"}'
    j = ae.judge(CASE, "60 days", ["rule-arp-60-days"], {"rule-arp-60-days": "60 days"}, call=fake)
    assert j["faithfulness"] == 4
    assert ae.parse_judge("not json") is None
    assert ae.parse_judge('{"faithfulness": 99}')["faithfulness"] == 5   # clamped


def test_answer_cases_expected_facts_exist_in_gold_kb():
    """The expectations themselves must be true: every required fact appears in its gold KB text."""
    cases = json.load(open(os.path.join(EVAL, "answer_cases.json"), encoding="utf-8"))
    kb = {d["id"]: d["text"].lower() for d in json.load(open(os.path.join(_BACKEND, "data", "knowledge_base.json"), encoding="utf-8"))}
    for c in cases["factual"]:
        text = " ".join(kb[g] for g in c["gold"])
        for grp in c["required"]:
            assert any(a.lower() in text for a in grp), (c["id"], grp)
