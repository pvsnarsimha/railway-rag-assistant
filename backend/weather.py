"""
weather.py
----------
Live weather at the train's current/upcoming position, from WeatherAPI.com
(https://www.weatherapi.com/docs/), keyed by WEATHER_API_KEY in backend/.env.

Two real uses, both requested directly:
  1. Display: current conditions (condition text, temp, visibility, rain)
     shown alongside the Live Tracking card, at the train's current station
     and its next reporting station.
  2. Delay prediction: visibility_km and precip_mm feed a `weather_component`
     into the SAME blended heuristic that already produces
     `predicted_delay_minutes` (see app.py's _predict_delay_per_reporting_station
     and the single-figure delay_prediction.predict_delay call) — fog is the
     single largest real-world driver of Indian Railways delays, followed by
     heavy rain/waterlogging, and neither was visible to the model before
     this. Nothing here is estimated without a real reading: if the API
     call fails or the key is missing, every function returns None and the
     weather_component simply drops to 0 rather than guessing.

Get a free key at https://www.weatherapi.com/signup.aspx (free tier is
generous — 1M calls/month at time of writing), then in backend/.env set:
    WEATHER_API_KEY=<your key>
"""

import os
from typing import Optional

import requests

from api_cache import cached

API_BASE = "https://api.weatherapi.com/v1/current.json"
TIMEOUT_SECONDS = 6

# Real reason the LAST call failed (missing/invalid key, network error,
# etc.) - same pattern as railradar_fallback._last_error, so callers that
# must swallow the exception can still surface the actual reason.
_last_error: Optional[str] = None


class WeatherError(Exception):
    pass


def _api_key() -> Optional[str]:
    return os.environ.get("WEATHER_API_KEY") or None


def get_last_error() -> Optional[str]:
    return _last_error


@cached(ttl_seconds=900, prefix="weather_current")
def _fetch_raw(lat_rounded: float, lng_rounded: float) -> dict:
    """GET WeatherAPI.com's current-conditions endpoint for a lat/lng.
    Rounded to 2 decimal places (~1.1 km) before caching/calling — weather
    doesn't meaningfully change station-to-station over a few hundred
    metres, and this keeps a train's position jitter from busting the
    15-minute cache on every single poll. Raises WeatherError with a real
    reason on any failure; never returns a guessed reading."""
    global _last_error

    def _fail(msg: str):
        global _last_error
        _last_error = msg
        raise WeatherError(msg)

    key = _api_key()
    if not key:
        _fail("WEATHER_API_KEY is not set in backend/.env.")

    try:
        resp = requests.get(
            API_BASE,
            params={"key": key, "q": f"{lat_rounded},{lng_rounded}", "aqi": "no"},
            timeout=TIMEOUT_SECONDS,
        )
    except requests.exceptions.RequestException as exc:
        _fail(f"Could not reach api.weatherapi.com ({exc}).")

    if resp.status_code == 401 or resp.status_code == 403:
        _fail("WeatherAPI.com rejected the API key — check WEATHER_API_KEY in backend/.env is correct and active.")
    if resp.status_code == 429:
        _fail("WeatherAPI.com rate limit exceeded (429) — try again later or check your plan's quota.")

    try:
        body = resp.json()
    except ValueError:
        _fail(f"WeatherAPI.com returned a response that wasn't valid JSON (HTTP {resp.status_code}).")

    if resp.status_code != 200 or "current" not in body:
        err = (body.get("error") or {}).get("message") if isinstance(body, dict) else None
        _fail(err or f"WeatherAPI.com returned HTTP {resp.status_code} with no usable data.")

    _last_error = None
    return body


def get_current_weather(lat: Optional[float], lng: Optional[float]) -> Optional[dict]:
    """Real current conditions at a lat/lng: condition text, temp_c,
    precip_mm, humidity, visibility_km, wind_kph, gust_kph — every field
    copied straight from WeatherAPI.com's own response, nothing derived.
    Returns None (never a guess) if lat/lng are missing, the key isn't
    configured, or the call fails for any reason."""
    if lat is None or lng is None:
        return None
    try:
        body = _fetch_raw(round(float(lat), 2), round(float(lng), 2))
    except WeatherError:
        return None
    except (TypeError, ValueError):
        return None

    current = body.get("current") or {}
    condition = (current.get("condition") or {}).get("text")
    location = body.get("location") or {}
    return {
        "condition": condition,
        "temp_c": current.get("temp_c"),
        "feelslike_c": current.get("feelslike_c"),
        "precip_mm": current.get("precip_mm"),
        "humidity": current.get("humidity"),
        "visibility_km": current.get("vis_km"),
        "wind_kph": current.get("wind_kph"),
        "gust_kph": current.get("gust_kph"),
        "is_day": bool(current.get("is_day")),
        "observed_near": location.get("name"),
        "source": "WeatherAPI.com (live current conditions)",
    }


def weather_delay_component_minutes(weather: Optional[dict]) -> "tuple[float, Optional[str]]":
    """Real, bounded extra-delay-minutes estimate purely from the weather
    reading itself — the same kind of transparent, capped heuristic as
    app.py's speed_component / trend_component, not an ML black box.
    Grounded in the two documented biggest weather-driven delay causes on
    Indian Railways:
      - Fog / low visibility: below 1 km visibility, Railways itself
        applies speed restrictions (well below the 25 km/h "dense fog"
        threshold commonly enforced); below 200 m, restrictions are severe.
        Scaled smoothly between 5 km (no restriction) and 0 km (severe).
      - Heavy rain: >7.6 mm/hr is IMD's "heavy rain" threshold; scaled
        smoothly up to a cap at very heavy/extreme rain.
    Returns (extra_minutes, basis_text) — (0.0, None) if weather is None or
    neither signal is present, never inventing a number from nothing.
    """
    if not weather:
        return 0.0, None

    minutes = 0.0
    reasons = []

    vis_km = weather.get("visibility_km")
    if vis_km is not None:
        try:
            vis_km = float(vis_km)
            if vis_km < 5.0:
                # Linear ramp: 5km -> 0 extra min, 0km -> 45 extra min (severe fog).
                fog_minutes = max(0.0, min(45.0, (5.0 - vis_km) / 5.0 * 45.0))
                if fog_minutes >= 1.0:
                    minutes += fog_minutes
                    reasons.append(f"visibility {vis_km:.1f} km reported near current position (+{fog_minutes:.0f} min)")
        except (TypeError, ValueError):
            pass

    precip_mm = weather.get("precip_mm")
    if precip_mm is not None:
        try:
            precip_mm = float(precip_mm)
            if precip_mm > 2.5:
                # Linear ramp: 2.5mm/hr -> 0 extra min, 35mm/hr (extremely
                # heavy) -> 30 extra min, capped there.
                rain_minutes = max(0.0, min(30.0, (precip_mm - 2.5) / 32.5 * 30.0))
                if rain_minutes >= 1.0:
                    minutes += rain_minutes
                    reasons.append(f"{precip_mm:.1f} mm/hr rain reported near current position (+{rain_minutes:.0f} min)")
        except (TypeError, ValueError):
            pass

    if not reasons:
        return 0.0, None
    return round(minutes, 1), "; ".join(reasons)
