"""
version.py
----------
Single source of truth for "which code is actually running?".

Deploys have shipped stale code before, and the only way to tell was to
poke at behaviour. Now every deploy can be asked directly: /api/version
returns the semantic version (from the repo-root VERSION file) and the git
commit the process was built from, and every HTTP response carries them in
X-App-Version / X-App-Commit headers. tools/verify_deploy.py compares the
live commit against the one that was meant to ship.

Commit resolution order: explicit GIT_SHA/COMMIT_SHA env (CI), Render's
RENDER_GIT_COMMIT, Railway's RAILWAY_GIT_COMMIT_SHA, then `git rev-parse`
when running from a checkout, else "unknown".
"""
import os
import subprocess
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STARTED_AT = time.time()


def _read_version() -> str:
    try:
        with open(os.path.join(_ROOT, "VERSION"), encoding="utf-8") as f:
            return f.read().strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def _read_commit() -> str:
    for var in ("GIT_SHA", "COMMIT_SHA", "RENDER_GIT_COMMIT", "RAILWAY_GIT_COMMIT_SHA"):
        val = os.environ.get(var, "").strip()
        if val:
            return val
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=_ROOT, capture_output=True,
                             text=True, timeout=3)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return "unknown"


VERSION = _read_version()
COMMIT = _read_commit()


def info() -> dict:
    return {
        "version": VERSION,
        "commit": COMMIT,
        "commit_short": COMMIT[:7],
        "uptime_seconds": round(time.time() - STARTED_AT, 1),
    }
