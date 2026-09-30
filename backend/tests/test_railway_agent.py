"""Tests for the tool-using agent layer. No network / API keys needed: the LLM
client and railway providers are faked."""
import os
import sys
import types
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))

import railway_agent  # noqa: E402


class FakeAnthropic:
    """Scripted Claude: turn 1 calls a failing tool, turn 2 falls back to the
    knowledge base, turn 3 answers."""
    def __init__(self, api_key=None):
        self.calls = 0
        self.messages = self

    def create(self, **kw):
        self.calls += 1
        if self.calls == 1:
            return NS(stop_reason="tool_use", content=[NS(type="tool_use", id="t1", name="train_schedule", input={"train_number": "99999"})])
        if self.calls == 2:
            assert kw["messages"][-1]["content"][0]["is_error"] is True   # error was fed back, not raised
            return NS(stop_reason="tool_use", content=[NS(type="tool_use", id="t2", name="search_knowledge_base", input={"query": "tatkal"})])
        return NS(stop_reason="end_turn", content=[NS(type="text", text="Tatkal opens 1 day before.")])


def test_agent_recovers_from_tool_error(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=FakeAnthropic))
    def boom(_): raise railway_agent.railway_api.RailwayAPIError("provider down")
    monkeypatch.setattr(railway_agent.railway_api, "get_train_schedule", boom)
    monkeypatch.setattr(railway_agent, "tool_search_knowledge_base", lambda query: {"excerpts": [{"text": "x"}]})
    monkeypatch.setitem(railway_agent._TOOL_FNS, "search_knowledge_base", railway_agent.tool_search_knowledge_base)

    res = railway_agent.run_agent("when does tatkal open")
    assert res.answer == "Tatkal opens 1 day before."
    assert res.provider == "claude"
    assert [(s.tool, s.ok) for s in res.steps] == [("train_schedule", False), ("search_knowledge_base", True)]


def test_no_provider_returns_no_answer(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    res = railway_agent.run_agent("hi")
    assert res.answer is None and res.error
    assert not railway_agent.is_available()


def test_execute_tool_never_raises():
    assert "error" in railway_agent.execute_tool("nope", {})
    assert "error" in railway_agent.execute_tool("pnr_status", {"wrong": 1})
    assert "error" in railway_agent.execute_tool("pnr_status", {"pnr": "123"})  # invalid PNR -> error dict


def test_step_budget_forces_final_answer(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    monkeypatch.setattr(railway_agent, "MAX_STEPS", 2)

    class Looper:
        def __init__(self, api_key=None): self.messages = self; self.n = 0
        def create(self, **kw):
            self.n += 1
            if "used all tool calls" in kw["system"]:
                return NS(stop_reason="tool_use", content=[NS(type="text", text="Best effort answer.")])
            return NS(stop_reason="tool_use", content=[NS(type="tool_use", id=f"t{self.n}", name="find_station", input={"query": "Vijayawada"})])
    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=Looper))
    res = railway_agent.run_agent("q")
    assert res.answer == "Best effort answer."
    assert len(res.steps) == 2


def test_gemini_schema_uppercases_types():
    out = railway_agent._gemini_schema(railway_agent.TOOLS[2]["schema"])
    assert out["type"] == "OBJECT" and out["properties"]["train_number"]["type"] == "STRING"
