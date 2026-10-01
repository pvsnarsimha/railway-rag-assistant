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
