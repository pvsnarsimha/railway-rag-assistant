"""/api/chat hands failures/unknown questions to the agent instead of an error."""
import os
import sys

_BACKEND = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, _BACKEND)
os.chdir(_BACKEND)  # app.py mounts ../frontend relative to the working dir

from fastapi.testclient import TestClient  # noqa: E402
import app as app_module  # noqa: E402
import railway_agent  # noqa: E402


def _agent(answer="Here is what I found."):
    return railway_agent.AgentResult(
        answer=answer, provider="claude",
        steps=[railway_agent.AgentStep("web_search", {"query": "q"}, True, "ok")])


def test_provider_error_is_answered_by_agent(monkeypatch):
    def boom(*a, **k): raise app_module.railway_api.RailwayAPIError("quota exceeded")
    monkeypatch.setattr(app_module.railway_api, "get_live_train_status", boom)
    monkeypatch.setattr(railway_agent, "is_available", lambda: True)
    monkeypatch.setattr(railway_agent, "run_agent", lambda q, extra="": _agent("Train 12951 is on time."))
    r = TestClient(app_module.app).post("/api/chat", json={"message": "running status of train 12951"}).json()
    assert r["answer"] == "Train 12951 is on time."
    assert r["agent"]["used"] and r["agent"]["steps"][0]["tool"] == "web_search"


def test_agent_can_be_disabled(monkeypatch):
    def boom(*a, **k): raise app_module.railway_api.RailwayAPIError("quota exceeded")
    monkeypatch.setattr(app_module.railway_api, "get_live_train_status", boom)
    monkeypatch.setattr(railway_agent, "is_available", lambda: True)
    monkeypatch.setattr(railway_agent, "run_agent", lambda q, extra="": _agent())
    r = TestClient(app_module.app).post("/api/chat", json={"message": "running status of train 12951", "agent": False}).json()
    assert not r["agent"]["used"]


def test_agent_failure_falls_back_to_rules(monkeypatch):
    def boom(*a, **k): raise app_module.railway_api.RailwayAPIError("quota exceeded")
    monkeypatch.setattr(app_module.railway_api, "get_live_train_status", boom)
    monkeypatch.setattr(railway_agent, "is_available", lambda: True)
    monkeypatch.setattr(railway_agent, "run_agent", lambda q, extra="": railway_agent.AgentResult(error="down"))
    monkeypatch.setattr(app_module.web_search, "search_web", lambda *a, **k: [])
    r = TestClient(app_module.app).post("/api/chat", json={"message": "running status of train 12951"}).json()
    assert r["answer"] and not r["agent"]["used"]


def test_unexpected_exception_is_rescued(monkeypatch):
    monkeypatch.setattr(app_module.query_router, "classify", lambda q: (_ for _ in ()).throw(RuntimeError("bug")))
    monkeypatch.setattr(railway_agent, "is_available", lambda: True)
    monkeypatch.setattr(railway_agent, "run_agent", lambda q, extra="": _agent("rescued"))
    r = TestClient(app_module.app).post("/api/chat", json={"message": "anything"}).json()
    assert r["answer"] == "rescued"
    monkeypatch.setattr(railway_agent, "is_available", lambda: False)
    r = TestClient(app_module.app).post("/api/chat", json={"message": "anything"}).json()
    assert "RuntimeError" not in r["answer"] and "bug" not in r["answer"]
