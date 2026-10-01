#!/usr/bin/env python3
"""
Post-deploy / uptime verification. Exit code 0 = healthy, 1 = something is wrong.

    python tools/verify_deploy.py --url https://my-app.onrender.com --expect-commit <sha>
    python tools/verify_deploy.py --url ... --expect-version 1.0.0 --latency-budget-ms 3000

Checks, in order:
  1. /healthz answers 200 within the latency budget
  2. /api/version reports the commit/version you meant to ship  (catches stale deploys)
  3. a real chat round-trip returns a non-empty answer
  4. /api/metrics reports a 5xx error rate under --max-error-rate
Retries the first call for --wait seconds so it can sit right after a deploy
trigger while the new instance boots (free-tier cold starts take ~30-60 s).
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def get(url, data=None, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data else None,
                                 headers={"Content-Type": "application/json"} if data else {})
    t = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode()
        return r.status, json.loads(body) if body.startswith(("{", "[")) else body, (time.perf_counter() - t) * 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--expect-commit", default="")
    ap.add_argument("--expect-version", default="")
    ap.add_argument("--latency-budget-ms", type=float, default=5000)
    ap.add_argument("--max-error-rate", type=float, default=0.05)
    ap.add_argument("--wait", type=int, default=180, help="seconds to keep retrying until the service is up")
    a = ap.parse_args()
    base = a.url.rstrip("/")
    problems = []

    deadline = time.time() + a.wait
    while True:
        try:
            status, body, ms = get(f"{base}/healthz")
            break
        except (urllib.error.URLError, OSError) as e:
            if time.time() > deadline:
                print(f"FAIL  /healthz unreachable after {a.wait}s: {e}")
                return 1
            time.sleep(5)
    print(f"ok    /healthz {status} in {ms:.0f} ms")
    if ms > a.latency_budget_ms:
        problems.append(f"/healthz took {ms:.0f} ms > budget {a.latency_budget_ms:.0f} ms")

    # The commit may lag while the old instance drains; poll until it matches.
    while True:
        _, ver, _ = get(f"{base}/api/version")
        ok = (not a.expect_commit or ver["commit"].startswith(a.expect_commit[:7])) and \
             (not a.expect_version or ver["version"] == a.expect_version)
        if ok or time.time() > deadline:
            break
        time.sleep(5)
    print(f"{'ok  ' if ok else 'FAIL'}  live build: version {ver['version']} commit {ver['commit_short']}")
    if not ok:
        problems.append(f"STALE DEPLOY: live is {ver['version']}@{ver['commit_short']}, "
                        f"expected {a.expect_version or '*'}@{a.expect_commit[:7] or '*'}")

    try:
        _, chat, ms = get(f"{base}/api/chat", {"message": "what is RAC", "agent": False})
        answered = bool(isinstance(chat, dict) and str(chat.get("answer", "")).strip())
        print(f"{'ok  ' if answered else 'FAIL'}  chat round-trip {ms:.0f} ms")
        if not answered:
            problems.append("chat returned an empty answer")
        if ms > a.latency_budget_ms:
            problems.append(f"chat took {ms:.0f} ms > budget {a.latency_budget_ms:.0f} ms")
    except Exception as e:
        problems.append(f"chat request failed: {e}")

    try:
        _, m, _ = get(f"{base}/api/metrics")
        print(f"{'ok  ' if m['error_rate_5xx'] <= a.max_error_rate else 'FAIL'}  5xx rate {m['error_rate_5xx']:.2%} over {m['requests_total']} requests")
        if m["error_rate_5xx"] > a.max_error_rate:
            problems.append(f"5xx rate {m['error_rate_5xx']:.2%} > {a.max_error_rate:.2%}")
    except Exception as e:
        problems.append(f"/api/metrics unavailable: {e}")

    for p in problems:
        print("PROBLEM:", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
