"""
railway_api.py
---------------
Connector to a REAL, live Indian Railways data provider — RailKit
(https://railkit.rajivdubey.dev).

IMPORTANT / HONEST NOTE (same rule as always in this project):
Indian Railways / IRCTC does not publish a free official public API for PNR
status, live train running status, or seat availability. NTES (the enquiry
portal) has no public API, and scraping it violates its terms of use.
RailKit is a registered third-party provider with a real signup and a real
API key requirement - nothing here is a scrape or a demo dataset.

WHY A LOCAL MICROSERVICE INSTEAD OF A DIRECT HTTP CALL:
RailKit is published ONLY as a Node.js SDK (`npm install railkit`) - there
is no publicly documented raw REST endpoint to call directly from Python
(the SDK's internal implementation is an obfuscated bundle). Rather than
guess at an undocumented URL/auth scheme, this project runs the tiny,
official-SDK-using Node service in `railkit-service/` and talks to it over
local HTTP. That service is a pass-through: it does not transform, filter,
or invent any field - every response here is exactly what the real RailKit
SDK returned.

To go live:
  1. Get a free API key at https://railkit.rajivdubey.dev (Dashboard -> API Keys).
  2. cd railkit-service && npm install && cp .env.example .env
     (set RAILKIT_API_KEY in railkit-service/.env)
  3. npm start   (runs the microservice on http://127.0.0.1:4001 by default)
  4. In backend/.env, set RAILKIT_SERVICE_URL if you changed the port
     (defaults to http://127.0.0.1:4001, no key needed on the Python side -
     the Node service holds the actual RailKit key).

If the microservice isn't running, or it isn't configured with a key,
every method below raises a clear RailwayAPIError — the app will NEVER
fabricate train data or silently fall back to a hardcoded demo response.

Swapping providers again later: only this file (and railkit-service/) needs
to change — keep the same method signatures (get_pnr_status,
get_live_train_status, etc.) so app.py, gps_tracking.py, and
trains_between.py don't need to change.
"""

import os
import requests
from datetime import datetime

from api_cache import cached
import rapidapi_provider

SERVICE_URL = os.environ.get("RAILKIT_SERVICE_URL", "http://127.0.0.1:4001").rstrip("/")
TIMEOUT_SECONDS = 10

# Search Trains (trains-between-stations + seat availability) always uses
# RapidAPI now - see rapidapi_provider.py and the two functions below.
# Everything else in this file (PNR, live GPS tracking, train info/schedule,
# history, fare) is unaffected and still goes through RailKit.


class RailwayAPIError(Exception):
    pass


def _call(path: str, params: dict = None) -> dict:
    """GET the local railkit-service, unwrap {success, data}/{success, error}."""
    url = f"{SERVICE_URL}{path}"
    try:
        resp = requests.get(url, params=params or {}, timeout=TIMEOUT_SECONDS)
    except requests.exceptions.RequestException as exc:
        raise RailwayAPIError(
            f"Could not reach the railkit-service at {SERVICE_URL} ({exc}). "
            "Is it running? See railkit-service/README or run "
            "`cd railkit-service && npm start`."
        )

    if resp.status_code == 503:
        # The service is up but has no RAILKIT_API_KEY configured.
        try:
            body = resp.json()
        except ValueError:
            body = {}
        raise RailwayAPIError(body.get("error", "railkit-service has no RAILKIT_API_KEY configured."))

    try:
        data = resp.json()
    except ValueError:
        raise RailwayAPIError("The railkit-service returned a response that wasn't valid JSON.")

    if isinstance(data, dict) and data.get("success") is False:
        raise RailwayAPIError(data.get("error") or data.get("message") or "Unknown error from RailKit.")

    # Everything else (including non-2xx we haven't special-cased) still
    # gets surfaced honestly rather than silently swallowed.
    if resp.status_code >= 400 and not (isinstance(data, dict) and "success" in data):
        raise RailwayAPIError(f"RailKit request failed (HTTP {resp.status_code}).")

    return data


def _validate_train_number(train_number: str) -> str:
    train_number = train_number.strip()
    if not (train_number.isdigit() and len(train_number) == 5):
        raise RailwayAPIError("A valid train number is 5 digits. Please double-check and re-enter it.")
    return train_number


@cached(ttl_seconds=120, prefix="pnr_status")
def get_pnr_status(pnr: str) -> dict:
    """Real-time PNR status lookup. `pnr` must be a 10-digit PNR number."""
    pnr = pnr.strip()
    if not (pnr.isdigit() and len(pnr) == 10):
        raise RailwayAPIError("A valid PNR number is 10 digits. Please double-check and re-enter it.")
    return _call(f"/pnr/{pnr}")


@cached(ttl_seconds=45, prefix="live_status")
def get_live_train_status(train_number: str, date_ddmmyyyy: str = None) -> dict:
    """Live running status of a train (RailKit's trackTrain).

    TTL shortened from an original 120s to 45s so a genuine station arrival
    doesn't sit stale for up to two minutes even in the ordinary case; see
    also app.py's /ws/track loop, which calls this with `_force_refresh=True`
    (bypassing this cache entirely for one call) the moment RailRadar's real
    segment progress shows the train is essentially AT the next station -
    that's the actual "instant" update path for an arrival, this TTL is
    just the fallback for when RailRadar has no live GPS for the train at
    all.

    date_ddmmyyyy is optional on this function's own signature, but we
    ALWAYS send a real, correctly-formatted date to the provider rather
    than omitting the query param — in practice the provider has returned
    an "Invalid date format" error when `date` was left out entirely
    (its documented "defaults to today if omitted" behavior doesn't hold
    reliably), so a missing date is filled in with today's actual date
    (DD-MM-YYYY) here instead of being passed through as absent."""
    train_number = _validate_train_number(train_number)
    date_ddmmyyyy = date_ddmmyyyy or datetime.now().strftime("%d-%m-%Y")
    return _call(f"/track/{train_number}", {"date": date_ddmmyyyy})


@cached(ttl_seconds=86400, prefix="train_info")
def get_train_info(train_number: str) -> dict:
    """Route + per-station coordinates for a train (RailKit's getTrainInfo).
    This is the source of truth for both the route map AND for looking up
    a station's real lat/lng when building the live GPS position - see
    gps_tracking.py."""
    train_number = _validate_train_number(train_number)
    return _call(f"/train-info/{train_number}")


@cached(ttl_seconds=86400, prefix="train_schedule")
def get_train_schedule(train_number: str) -> dict:
    """Alias kept for backward compatibility with existing call sites -
    schedule and "train info" are the same RailKit endpoint."""
    return get_train_info(train_number)


@cached(ttl_seconds=180, prefix="seat_availability")
def get_seat_availability(train_number: str, source_code: str, dest_code: str,
                           date_ddmmyyyy: str, travel_class: str, quota: str = "GN") -> dict:
    """Real-time seat/berth availability for a specific train, route, date and class -
    used only by the Search Trains tab. Goes through RapidAPI unconditionally now (not
    RailKit) per explicit request - see rapidapi_provider.py. Errors surface as
    RailwayAPIError so app.py doesn't need to know which provider is behind this call."""
    train_number = _validate_train_number(train_number)
    try:
        return rapidapi_provider.get_seat_availability(
            train_number, source_code, dest_code, date_ddmmyyyy, travel_class, quota,
        )
    except rapidapi_provider.RapidAPIProviderError as exc:
        raise RailwayAPIError(str(exc))


@cached(ttl_seconds=21600, prefix="trains_between")
def search_trains_between_stations(source_code: str, dest_code: str, date_ddmmyyyy: str = None) -> dict:
    """Trains running between two stations - used only by the Search Trains tab. Goes
    through RapidAPI unconditionally now (not RailKit) per explicit request - see
    rapidapi_provider.py. Unlike RailKit's date-independent timetable call, RapidAPI's
    trainBetweenStations DOES take a date, so date_ddmmyyyy is forwarded to it."""
    try:
        return rapidapi_provider.search_trains_between_stations(source_code, dest_code, date_ddmmyyyy)
    except rapidapi_provider.RapidAPIProviderError as exc:
        raise RailwayAPIError(str(exc))


@cached(ttl_seconds=300, prefix="live_at_station")
def get_live_at_station(station_code: str, hours: int = 2) -> dict:
    """Upcoming/passing trains at a station in the next `hours` (2, 4, or 8)."""
    return _call(f"/live-station/{station_code.upper()}", {"hours": hours})


@cached(ttl_seconds=86400, prefix="train_history")
def get_train_history(train_number: str, date_ddmmyyyy: str) -> dict:
    """Completed-journey history for a train on a specific date (only
    populated once that train has finished the run)."""
    train_number = _validate_train_number(train_number)
    return _call(f"/history/{train_number}", {"date": date_ddmmyyyy})


@cached(ttl_seconds=86400, prefix="fare_lookup")
def get_fare(train_number: str, source_code: str, dest_code: str,
             date_ddmmyyyy: str, travel_class: str, quota: str = "GN") -> dict:
    """Full fare breakdown for a journey."""
    train_number = _validate_train_number(train_number)
    return _call("/fare", {
        "trainNo": train_number,
        "from": source_code.upper(),
        "to": dest_code.upper(),
        "date": date_ddmmyyyy,
        "travelClass": travel_class.upper(),
        "quota": quota.upper(),
    })
