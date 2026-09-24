"""
api_cache.py
--------------
A tiny in-memory, time-to-live cache for the paid railway data provider
calls. This exists purely to stretch a limited RapidAPI quota further -
it does NOT change what data is returned, and it does NOT invent data: a
cache hit returns the exact same response a fresh call would have, just
without spending another call on it.

Different data types get different TTLs because they change at different
rates:
  - PNR status / live running status: changes minute-to-minute -> short TTL.
  - Seat availability: changes as people book -> short-medium TTL.
  - Train schedule / trains-between-stations: essentially static day-to-day
    -> long TTL, since a train's stop sequence doesn't change hour to hour.

This is process-local (a dict in memory) - fine for a single-instance
deployment like `uvicorn app:app`. If you scale to multiple worker
processes, swap this for a shared cache (e.g. Redis) so workers don't each
maintain their own quota-wasting copy.
"""

import time
import functools
import threading

_cache = {}
_lock = threading.Lock()


def _make_key(prefix: str, args, kwargs) -> str:
    return f"{prefix}:{args}:{sorted(kwargs.items())}"


def cached(ttl_seconds: int, prefix: str):
    """Decorator: cache a function's return value for ttl_seconds, keyed on
    its arguments. Exceptions are never cached - a failed call (including a
    quota error) is retried fresh next time, not "remembered" as a failure.

    FEATURE: pass `_force_refresh=True` as a keyword argument on any call to
    bypass the cache lookup for just that one call and fetch a real fresh
    value (still repopulating the cache normally afterward) - added so a
    caller with a strong real-time signal that something just changed (see
    app.py's /ws/track loop: RailRadar's segmentProgress showing the train
    is essentially AT the next station) can get an instant real read instead
    of waiting out the rest of the TTL. `_force_refresh` itself is popped
    off before the wrapped function ever sees it, so it never becomes part
    of the cache key or gets passed through to a function that doesn't
    expect it."""
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            force_refresh = kwargs.pop("_force_refresh", False)
            key = _make_key(prefix, args, kwargs)
            now = time.time()
            if not force_refresh:
                with _lock:
                    entry = _cache.get(key)
                    if entry and entry["expires_at"] > now:
                        return entry["value"]
            value = fn(*args, **kwargs)  # let exceptions propagate uncached
            with _lock:
                # `fetched_at` is the real wall-clock moment this value was
                # actually pulled from the provider - set ONLY here, in the
                # branch that just made a genuine call, never touched on a
                # cache-hit read. This is what entry_fetched_at() below
                # reports, so a caller can tell a live-tracking client the
                # TRUE age of what it's showing instead of always claiming
                # "just now" merely because a poll happened to run.
                _cache[key] = {"value": value, "expires_at": now + ttl_seconds, "fetched_at": now}
            return value
        return wrapper
    return decorator


def entry_fetched_at(prefix: str, args=(), kwargs=None) -> float | None:
    """Introspects the cache for the given (prefix, args, kwargs) key and
    returns the real epoch-seconds timestamp of the last genuine fetch that
    populated it (never invented, never bumped by a cache-hit read) - or
    None if nothing is cached for that key yet. Does NOT trigger a fetch
    itself and never raises.

    Added for the live-tracking WebSocket loop (backend/app.py's
    ws_track_train): before this, it stamped every single 5s poll's
    "status_updated_at" with datetime.now(), so the UI's "As of X ago"
    label reset every poll even on a cache HIT where the underlying
    provider data hadn't actually changed in up to ttl_seconds - looking
    live while quietly showing stale data. This lets the caller report the
    real fetch time instead.
    """
    kwargs = {k: v for k, v in (kwargs or {}).items() if k != "_force_refresh"}
    key = _make_key(prefix, args, kwargs)
    with _lock:
        entry = _cache.get(key)
        return entry.get("fetched_at") if entry else None


def peek(prefix: str, args=(), kwargs=None):
    """The cached value for this key if present and not expired, else None.
    Never fetches, never raises."""
    kwargs = {k: v for k, v in (kwargs or {}).items() if k != "_force_refresh"}
    key = _make_key(prefix, args, kwargs)
    with _lock:
        entry = _cache.get(key)
        if entry and entry["expires_at"] > time.time():
            return entry["value"]
    return None


def cache_stats() -> dict:
    """For a diagnostic endpoint - how many entries are cached right now."""
    with _lock:
        now = time.time()
        live = sum(1 for e in _cache.values() if e["expires_at"] > now)
        return {"total_entries": len(_cache), "live_entries": live}


def clear_cache():
    with _lock:
        _cache.clear()
