"""Monitoring + release-identity contract. These guard the things the
deploy checks and uptime monitor depend on."""
import os
import sys

_BACKEND = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, _BACKEND)
os.chdir(_BACKEND)

from fastapi.testclient import TestClient  # noqa: E402
import app as app_module  # noqa: E402
import observability  # noqa: E402
import version  # noqa: E402

client = TestClient(app_module.app)


def test_healthz_is_cheap_and_identifies_build():
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["version"] == version.VERSION and body["commit"]


def test_every_response_carries_version_and_request_id():
    r = client.get("/api/version")
    assert r.headers["x-app-version"] == version.VERSION
    assert r.headers["x-app-commit"]
    assert r.headers["x-request-id"]
    assert client.get("/healthz", headers={"x-request-id": "abc123"}).headers["x-request-id"] == "abc123"


def test_version_file_matches_runtime_version():
    root = os.path.dirname(_BACKEND)
    assert open(os.path.join(root, "VERSION")).read().strip() == version.VERSION


def test_commit_can_be_injected_for_deploys(monkeypatch):
    monkeypatch.setenv("GIT_SHA", "deadbeefcafe")
    assert version._read_commit() == "deadbeefcafe"


def test_metrics_record_route_template_not_raw_path():
    observability.reset()
    client.get("/api/delay-history/12951/01-01-2026")
    client.get("/api/delay-history/12301/02-01-2026")
    snap = client.get("/api/metrics").json()
    key = "GET /api/delay-history/{train_number}/{date}"
    assert snap["routes"][key]["count"] == 2           # bounded label cardinality
    assert not any("12951" in k for k in snap["routes"])


def test_unknown_paths_do_not_explode_label_cardinality():
    observability.reset()
    for i in range(20):
        client.get(f"/no-such-page-{i}")
    snap = client.get("/api/metrics").json()
    assert snap["routes"]["GET unmatched"]["count"] == 20


def test_5xx_counted_as_errors():
    observability.record("GET", "/x", 500, 10.0)
    observability.record("GET", "/x", 404, 1.0)
    r = observability.snapshot()["routes"]["GET /x"]
    assert r["errors_5xx"] == 1 and r["errors_4xx"] == 1


def test_percentiles():
    vals = sorted(range(1, 101))
    assert observability.percentile(vals, 50) == 50.5
    assert observability.percentile(vals, 99) > 99
    assert observability.percentile([], 95) == 0.0


def test_prometheus_output_shape():
    observability.reset()
    client.get("/healthz")
    text = client.get("/metrics").text
    assert 'app_info{version="' in text
    assert 'http_requests_total{method="GET",route="/healthz"}' in text


def test_chat_intents_are_counted(monkeypatch):
    observability.reset()
    client.post("/api/chat", json={"message": "help", "agent": False})
    assert observability.snapshot()["counters"].get("chat_intent.help") == 1


def test_slow_step_breakdown_in_log_and_metrics(monkeypatch, caplog):
    """A slow request's log line must say which outside call ate the time."""
    import logging
    import time
    observability.reset()
    monkeypatch.setattr(app_module.railway_agent, "is_available", lambda: False)

    def slow_search(*a, **k):
        time.sleep(0.05)
        return []
    monkeypatch.setattr(app_module.web_search, "search_web", observability.timed("web_search")(slow_search))

    with caplog.at_level(logging.INFO, logger="access"):
        client.post("/api/chat", json={"message": "who was the first railway minister of India", "agent": False})
    lines = [r.getMessage() for r in caplog.records if r.name == "access" and "/api/chat" in r.getMessage()]
    import json as _json
    entry = _json.loads(lines[-1])
    assert entry["intent"] == "general_faq"
    assert "steps" in entry and entry["steps"]["rag_retrieve"]["calls"] >= 1
    snap = observability.snapshot()
    assert snap["steps"]["rag_retrieve"]["count"] >= 1


def test_timed_records_errors():
    observability.reset()

    @observability.timed("boom")
    def f():
        raise ValueError("x")
    try:
        f()
    except ValueError:
        pass
    assert observability.snapshot()["steps"]["boom"]["errors"] == 1
