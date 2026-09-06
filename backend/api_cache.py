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
                _cache[key] = {"value": value, "expires_at": now + ttl_seconds}
            return value
        return wrapper
    return decorator


def cache_stats() -> dict:
    """For a diagnostic endpoint - how many entries are cached right now."""
    with _lock:
        now = time.time()
        live = sum(1 for e in _cache.values() if e["expires_at"] > now)
        return {"total_entries": len(_cache), "live_entries": live}


def clear_cache():
    with _lock:
        _cache.clear()
