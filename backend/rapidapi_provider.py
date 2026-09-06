"""
rapidapi_provider.py
---------------------
Live data provider for the Search Trains tab: the "IRCTC1" API listed on
RapidAPI (host: irctc1.p.rapidapi.com). Search Trains uses this
unconditionally now, not RailKit (see railway_api.py's
search_trains_between_stations/get_seat_availability).

HONESTY NOTE (same rule as the rest of this project):
The exact field names below (fromStationCode/toStationCode/dateOfJourney,
classType/quota/trainNo, the "train_base"/"avl_classes" response wrapper,
etc.) are RapidAPI's commonly-documented shape for this listing, not
something verified against a live call in this sandbox - this environment
has no network access to rapidapi.com. This has NOT been tested against
the real live service.

Two things make this safe to ship without that live test:
  1. trains_between.parse_trains_list() and advanced_features.extract_status_text()
     already do field-name-tolerant + full nested-response deep search
     (see deep_extract.py) - built over many earlier rounds fixing exactly
     this class of "provider field name doesn't match my guess" bug for
     RailKit. The same deep search will catch a RapidAPI shape that's
     close-but-not-exact to what's assumed here.
  2. If something still doesn't parse, api_trains_search's existing
     `availability_raw_keys_sample` / `raw_candidate_debug` debug fields
     will show the REAL key shape RapidAPI actually returned - the fix
     from there is a one-file edit driven by that real evidence, not
     another guess (same pattern used for every RailKit shape bug so far).

To go live:
  1. Subscribe to the "IRCTC1" API on RapidAPI (or an equivalent IRCTC
     listing) and copy your RapidAPI key.
  2. In backend/.env set:
       RAPIDAPI_KEY=your_key_here
       RAPIDAPI_HOST=irctc1.p.rapidapi.com   (only change if your
                                               subscribed listing uses a
                                               different host)
  3. Restart the backend. Until RAPIDAPI_KEY is set, Search Trains will
     raise a clear RailwayAPIError explaining that - it will NEVER fall
     back to RailKit silently or fabricate results.

Everything else (PNR status, live GPS tracking, train info/schedule,
history, fare) is UNCHANGED and still goes through RailKit - this
provider only covers the two calls Search Trains needs. Extend this file
with the same pattern (get_pnr_status, get_live_train_status, ...) if you
want to move those off RailKit too.
"""

import os
import requests

RAPIDAPI_KEY = os.environ.get("RAPIDAPI_KEY", "")
RAPIDAPI_HOST = os.environ.get("RAPIDAPI_HOST", "irctc1.p.rapidapi.com")
BASE_URL = f"https://{RAPIDAPI_HOST}"
TIMEOUT_SECONDS = 10


class RapidAPIProviderError(Exception):
    pass


def _headers():
    if not RAPIDAPI_KEY:
        raise RapidAPIProviderError(
            "RAPIDAPI_KEY is not set. Set RAILWAY_PROVIDER=rapidapi and RAPIDAPI_KEY "
            "in backend/.env to use the RapidAPI IRCTC provider."
        )
    return {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
    }


def _get(path: str, params: dict) -> dict:
    url = f"{BASE_URL}{path}"
    try:
        resp = requests.get(url, headers=_headers(), params=params, timeout=TIMEOUT_SECONDS)
    except requests.exceptions.RequestException as exc:
        raise RapidAPIProviderError(f"Could not reach RapidAPI ({exc}).")

    if resp.status_code == 429:
        raise RapidAPIProviderError("Too many requests (RapidAPI rate limit / quota exceeded).")
    if resp.status_code == 403:
        raise RapidAPIProviderError(
            "RapidAPI request forbidden (HTTP 403) - check that RAPIDAPI_KEY is valid and "
            "you're subscribed to this API listing."
        )

    try:
        data = resp.json()
    except ValueError:
        raise RapidAPIProviderError("RapidAPI returned a response that wasn't valid JSON.")

    if resp.status_code >= 400:
        msg = data.get("message") if isinstance(data, dict) else None
        raise RapidAPIProviderError(msg or f"RapidAPI request failed (HTTP {resp.status_code}).")

    # This listing's convention: {"status": true/false, "data": ..., "message": "..."}.
    if isinstance(data, dict) and data.get("status") is False:
        raise RapidAPIProviderError(data.get("message") or "RapidAPI reported failure for this request.")

    return data


def _ddmmyyyy_to_iso(date_ddmmyyyy: str) -> str:
    """RapidAPI's documented examples use YYYY-MM-DD; this app's date fields
    are DD-MM-YYYY throughout, so convert here rather than push the
    RapidAPI-specific format up into app.py/trains_between.py."""
    try:
        d, m, y = date_ddmmyyyy.split("-")
        return f"{y}-{m}-{d}"
    except (ValueError, AttributeError):
        return date_ddmmyyyy


def search_trains_between_stations(source_code: str, dest_code: str, date_ddmmyyyy: str = None) -> dict:
    """Trains running between two stations, via RapidAPI's
    /api/v3/trainBetweenStations. Returns the raw response as-is (same
    pass-through rule as railway_api.py) - trains_between.py normalizes
    RapidAPI's real per-row wrapper shape (each row typically nests fields
    under a "train_base" object plus a top-level "avl_classes" list) before
    the usual field-tolerant/deep-search parsing runs."""
    params = {
        "fromStationCode": source_code.upper(),
        "toStationCode": dest_code.upper(),
    }
    if date_ddmmyyyy:
        params["dateOfJourney"] = _ddmmyyyy_to_iso(date_ddmmyyyy)
    return _get("/api/v3/trainBetweenStations", params)


def get_seat_availability(train_number: str, source_code: str, dest_code: str,
                           date_ddmmyyyy: str, travel_class: str, quota: str = "GN") -> dict:
    """Real-time seat/berth availability for a specific train/route/date/class,
    via RapidAPI's /api/v1/checkSeatAvailability."""
    params = {
        "classType": travel_class.upper(),
        "quota": (quota or "GN").upper(),
        "trainNo": train_number,
        "fromStationCode": source_code.upper(),
        "toStationCode": dest_code.upper(),
        "date": _ddmmyyyy_to_iso(date_ddmmyyyy) if date_ddmmyyyy else None,
    }
    params = {k: v for k, v in params.items() if v is not None}
    return _get("/api/v1/checkSeatAvailability", params)
