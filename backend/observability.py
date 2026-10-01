"""
observability.py
----------------
Request metrics + structured access logs, dependency-free.

* Pure-ASGI middleware (no BaseHTTPMiddleware overhead, safe with
  WebSockets: non-HTTP scopes pass straight through).
* Per-route request count, error count and latency percentiles over a
  rolling window, keyed by the route *template* (/api/delay-history/{train}/{date}),
  never the raw path, so cardinality stays bounded.
* Stamps every response with X-Request-ID, X-App-Version, X-App-Commit.
* Emits one JSON log line per request (method, route, status, ms, request id).
* /api/metrics (JSON) and /metrics (Prometheus text) are rendered from the
  same registry. State is in-process: it resets on restart/redeploy, and
  with several workers each reports its own slice. Scrape or poll it; do
  not treat it as durable history.
"""
import json
import logging
import threading
import time
import uuid
from collections import defaultdict, deque

import version

_log = logging.getLogger("access")
_WINDOW = 1000          # latency samples kept per route
_SLOW_MS = 2000         # requests slower than this are flagged in the log
_MAX_ROUTES = 300       # hard cap on distinct label values

_lock = threading.Lock()
_routes = defaultdict(lambda: {"count": 0, "errors_5xx": 0, "errors_4xx": 0,
                               "sum_ms": 0.0, "lat": deque(maxlen=_WINDOW)})
_counters = defaultdict(int)


def percentile(sorted_vals, p):
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * p / 100.0
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def incr(name: str, n: int = 1) -> None:
    """Free-form business counter, e.g. incr('chat_intent.live_status')."""
    with _lock:
        _counters[name] += n


def record(method: str, route: str, status: int, ms: float) -> None:
    key = f"{method} {route}"
    with _lock:
        if key not in _routes and len(_routes) >= _MAX_ROUTES:
            key = f"{method} other"
        r = _routes[key]
        r["count"] += 1
        r["sum_ms"] += ms
        r["lat"].append(ms)
        if status >= 500:
            r["errors_5xx"] += 1
        elif status >= 400:
            r["errors_4xx"] += 1


def snapshot() -> dict:
    with _lock:
        routes = {}
        total = errs = 0
        for key, r in _routes.items():
            lat = sorted(r["lat"])
            routes[key] = {
                "count": r["count"], "errors_5xx": r["errors_5xx"], "errors_4xx": r["errors_4xx"],
                "mean_ms": round(r["sum_ms"] / r["count"], 2) if r["count"] else 0.0,
                "p50_ms": round(percentile(lat, 50), 2),
                "p95_ms": round(percentile(lat, 95), 2),
                "p99_ms": round(percentile(lat, 99), 2),
            }
            total += r["count"]
            errs += r["errors_5xx"]
        counters = dict(_counters)
    return {
        **version.info(),
        "requests_total": total,
        "errors_5xx_total": errs,
        "error_rate_5xx": round(errs / total, 4) if total else 0.0,
        "window_samples_per_route": _WINDOW,
        "routes": routes,
        "counters": counters,
    }


def prometheus() -> str:
    snap = snapshot()
    out = ["# TYPE app_info gauge",
           f'app_info{{version="{snap["version"]}",commit="{snap["commit_short"]}"}} 1',
           "# TYPE app_uptime_seconds gauge", f"app_uptime_seconds {snap['uptime_seconds']}",
           "# TYPE http_requests_total counter", "# TYPE http_errors_total counter",
           "# TYPE http_request_duration_ms summary"]
    for key, r in snap["routes"].items():
        method, route = key.split(" ", 1)
        lbl = f'method="{method}",route="{route}"'
        out.append(f"http_requests_total{{{lbl}}} {r['count']}")
        out.append(f'http_errors_total{{{lbl},class="5xx"}} {r["errors_5xx"]}')
        out.append(f'http_errors_total{{{lbl},class="4xx"}} {r["errors_4xx"]}')
        for q, f in (("0.5", "p50_ms"), ("0.95", "p95_ms"), ("0.99", "p99_ms")):
            out.append(f'http_request_duration_ms{{{lbl},quantile="{q}"}} {r[f]}')
    for name, val in snap["counters"].items():
        out.append(f'app_counter{{name="{name}"}} {val}')
    return "\n".join(out) + "\n"


def reset() -> None:
    with _lock:
        _routes.clear()
        _counters.clear()


class MetricsMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        rid = next((v.decode() for k, v in scope["headers"] if k == b"x-request-id"), "") or uuid.uuid4().hex[:12]
        t0 = time.perf_counter()
        state = {"status": 500}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                state["status"] = message["status"]
                headers = message.setdefault("headers", [])
                headers.append((b"x-request-id", rid.encode()))
                headers.append((b"x-app-version", version.VERSION.encode()))
                headers.append((b"x-app-commit", version.COMMIT[:12].encode()))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            ms = (time.perf_counter() - t0) * 1000
            route_obj = scope.get("route")
            route = getattr(route_obj, "path", None) or ("static" if state["status"] < 400 else "unmatched")
            record(scope["method"], route, state["status"], ms)
            try:
                _log.log(logging.WARNING if (state["status"] >= 500 or ms > _SLOW_MS) else logging.INFO,
                         json.dumps({"rid": rid, "method": scope["method"], "route": route,
                                     "status": state["status"], "ms": round(ms, 1),
                                     "slow": ms > _SLOW_MS}))
            except Exception:
                pass
