"""Regression tests for fixes that previously shipped and later went missing.

Rule (see docs/RELEASING.md): every bug fix adds a test here or beside the
code it fixes. A fix without a test can silently disappear in the next
merge; one with a test fails CI the moment that happens."""
import os
import sys

_BACKEND = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, _BACKEND)
os.chdir(_BACKEND)

from fastapi.testclient import TestClient  # noqa: E402
import app as app_module  # noqa: E402
import query_router  # noqa: E402

client = TestClient(app_module.app)


def test_mobile_web_pages_are_never_cached_stale():
    """Patch 0031: phones kept loading the old index.html after a deploy, so
    new screens never appeared. Entry pages must always revalidate."""
    r = client.get("/mobile-app/", follow_redirects=True)
    if r.status_code == 200:
        assert r.headers.get("cache-control") == "no-cache"


def test_root_revalidates():
    r = client.get("/", follow_redirects=False)
    assert r.headers.get("cache-control") == "no-cache"


def test_health_reports_agent_flag_so_old_code_is_detectable():
    """/api/health comment: `agent_enabled` absent means old code is deployed."""
    body = client.get("/api/health").json()
    assert "agent_enabled" in body and "commit" in body


def test_bare_ten_digit_number_is_a_pnr():
    assert query_router.classify("2345678901")["intent"] == query_router.Intent.PNR_STATUS


def test_reach_with_train_number_is_live_status():
    r = query_router.classify("when will 12951 reach BCT")
    assert r["intent"] == query_router.Intent.LIVE_STATUS and r["entities"]["train_number"] == "12951"


def test_no_stray_patch_files_in_repo_root():
    """Fixes ship as reviewed commits on main, never as loose .patch files."""
    root = os.path.dirname(_BACKEND)
    assert [f for f in os.listdir(root) if f.endswith((".patch", ".diff", ".orig", ".rej"))] == []
