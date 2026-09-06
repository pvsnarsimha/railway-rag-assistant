/**
 * server.js
 * -----------
 * A thin Node.js microservice that wraps the OFFICIAL `railkit` npm SDK as
 * local REST endpoints, so the Python/FastAPI backend can call it over
 * plain HTTP.
 *
 * WHY THIS EXISTS: RailKit is published only as a Node.js SDK (requires
 * Node 18+ for native fetch; its internal implementation is an obfuscated
 * bundle with no publicly documented raw REST endpoint). Guessing at an
 * undocumented HTTP URL and headers would be exactly the kind of
 * unverified integration this project avoids - so instead, this service
 * uses the real SDK exactly as documented, and simply re-exposes each of
 * its 8 methods as a JSON endpoint. It does not transform, filter, or
 * invent any field - every response is the SDK's own {success, data} or
 * {success:false, error} shape, passed straight through.
 *
 * Run:
 *   cd railkit-service
 *   npm install
 *   cp .env.example .env   # set RAILKIT_API_KEY
 *   npm start
 *
 * The FastAPI backend talks to this on RAILKIT_SERVICE_URL
 * (default http://127.0.0.1:4001) - see backend/railway_api.py.
 *
 * ALSO EXPOSES a combined RailKit+RailRadar endpoint, GET
 * /track-combined/:trainNumber - fetches both providers CONCURRENTLY
 * (Promise.allSettled, not sequential awaits) and returns both real
 * responses together, each labelled with its own success/error state.
 * Requires RAILRADAR_API_KEY in this service's own .env (separate from
 * backend/.env's copy, since this is a different process). This is
 * additive - the plain RailKit-only /track/:trainNumber endpoint above
 * is unchanged and still what the Python backend's existing pipeline
 * calls; /track-combined is available for anything that wants both
 * sources in one fast round trip instead of two.
 */

import express from "express";
import dotenv from "dotenv";
import {
  configure,
  checkPNRStatus,
  getTrainInfo,
  trackTrain,
  getTrainHistory,
  liveAtStation,
  searchTrainBetweenStations,
  getAvailability,
  fareLookup,
} from "railkit";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;
const API_KEY = (process.env.RAILKIT_API_KEY || "").trim();

if (API_KEY) {
  configure(API_KEY);
}

// Every route follows the same shape: call the SDK, forward its JSON
// response verbatim. A thrown exception (network/timeout/etc, not a
// {success:false} business error - the SDK returns those as normal
// resolved values) becomes a 500 with the same {success:false, error}
// shape so the Python side has one error contract to handle.
function wrap(handler) {
  return async (req, res) => {
    if (!API_KEY) {
      return res.status(503).json({
        success: false,
        error: "RAILKIT_API_KEY is not configured on the railkit-service. " +
               "Get a free key at https://railkit.rajivdubey.dev and set it in railkit-service/.env",
      });
    }
    try {
      const result = await handler(req);
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
    }
  };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    railkit_api_key_configured: Boolean(API_KEY),
    railradar_api_key_configured: Boolean(RAILRADAR_API_KEY),
  });
});

// 1. PNR Status
app.get("/pnr/:pnr", wrap((req) => checkPNRStatus(req.params.pnr)));

// 2. Train Information (route + per-station coordinates)
app.get("/train-info/:trainNumber", wrap((req) => getTrainInfo(req.params.trainNumber)));

// 3. Live Tracking
app.get("/track/:trainNumber", wrap((req) => {
  const date = req.query.date; // optional, "DD-MM-YYYY"; SDK defaults to today if omitted
  return date ? trackTrain(req.params.trainNumber, date) : trackTrain(req.params.trainNumber);
}));

// 3b. Live Tracking - RailKit AND RailRadar, run CONCURRENTLY, not one
// after another. RailKit is the primary schedule/route source (this
// service's whole reason to exist); RailRadar adds real crowdsourced
// live GPS speed + segment progress between stations that RailKit alone
// doesn't have. The Python backend already combines these too, but does
// so with its own separate sequential calls; this endpoint additionally
// exposes the SAME parallel-fetch capability directly here in
// railkit-service, for any caller that wants both sources in one round
// trip instead of two.
//
// Uses Promise.allSettled (not Promise.all) deliberately: RailRadar not
// having data for a given train (crowdsourced - depends on whether any
// passenger currently has GPS-sharing on) is a routine, expected outcome,
// not a failure that should take down the RailKit half of the response.
// Every field's real source is labelled - nothing here is invented or
// silently merged into a single ambiguous number.
const RAILRADAR_API_KEY = (process.env.RAILRADAR_API_KEY || "").trim();
const RAILRADAR_BASE = "https://api.railradar.in/v1/trains";
const RAILRADAR_TIMEOUT_MS = 6000;

async function fetchRailRadarLive(trainNumber) {
  if (!RAILRADAR_API_KEY) {
    return { ok: false, error: "RAILRADAR_API_KEY is not configured on the railkit-service (set it in railkit-service/.env)." };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RAILRADAR_TIMEOUT_MS);
  try {
    const resp = await fetch(`${RAILRADAR_BASE}/${trainNumber}/live`, {
      headers: { Authorization: `Bearer ${RAILRADAR_API_KEY}` },
      signal: controller.signal,
    });
    if (resp.status === 401) return { ok: false, error: "RailRadar rejected the API key (401)." };
    if (resp.status === 404) return { ok: false, error: `RailRadar has no data for train ${trainNumber} (404) - may not be running today, or no live GPS coverage.` };
    if (resp.status === 429) return { ok: false, error: "RailRadar rate limit exceeded (429)." };
    const body = await resp.json();
    if (!body || body.success !== true) {
      return { ok: false, error: (body && body.error && body.error.message) || `RailRadar returned HTTP ${resp.status} with no usable data.` };
    }
    return { ok: true, data: body.data || {} };
  } catch (err) {
    return { ok: false, error: `Could not reach api.railradar.in (${err && err.message ? err.message : err}).` };
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/track-combined/:trainNumber", async (req, res) => {
  const trainNumber = req.params.trainNumber;
  const date = req.query.date;

  // Kick off BOTH real network calls at the same time - this is the
  // actual "parallel" part, not sequential awaits.
  const [railkitResult, railradarResult] = await Promise.allSettled([
    API_KEY
      ? (date ? trackTrain(trainNumber, date) : trackTrain(trainNumber))
      : Promise.resolve({ success: false, error: "RAILKIT_API_KEY is not configured on the railkit-service." }),
    fetchRailRadarLive(trainNumber),
  ]);

  const railkit = railkitResult.status === "fulfilled"
    ? railkitResult.value
    : { success: false, error: String(railkitResult.reason && railkitResult.reason.message ? railkitResult.reason.message : railkitResult.reason) };

  const railradar = railradarResult.status === "fulfilled"
    ? railradarResult.value
    : { ok: false, error: String(railradarResult.reason && railradarResult.reason.message ? railradarResult.reason.message : railradarResult.reason) };

  // A handful of convenience fields pulled straight from RailRadar's raw
  // response where present - copied verbatim, nothing derived or
  // computed here. The full reconciliation/prediction logic (delay
  // arithmetic, ETA, smoothing) stays in the Python backend, which is
  // already built and tested for that - this endpoint's job is just
  // getting both real sources back in one fast, concurrent round trip.
  const loc = railradar.ok ? (railradar.data.currentLocation || {}) : {};
  res.json({
    success: true,
    sources: {
      railkit: { ok: railkit.success === true, error: railkit.success === true ? null : (railkit.error || "unknown error") },
      railradar: { ok: railradar.ok === true, error: railradar.ok === true ? null : railradar.error },
    },
    railkit: railkit.success === true ? railkit.data : null,
    railradar: railradar.ok === true ? railradar.data : null,
    railradar_live_gps: railradar.ok === true ? {
      speed_kmph: loc.speedKmh != null ? loc.speedKmh : null,
      segment_progress: loc.segmentProgress != null ? loc.segmentProgress : null,
      is_actual_position: loc.isActualPosition != null ? loc.isActualPosition : null,
      bearing_degrees: loc.bearingDegrees != null ? loc.bearingDegrees : null,
      station_code: loc.stationCode || null,
    } : null,
  });
});

// 4. Train History (completed journeys only)
app.get("/history/:trainNumber", wrap((req) => {
  const date = req.query.date;
  if (!date) throw new Error("date query param (DD-MM-YYYY) is required for train history");
  return getTrainHistory(req.params.trainNumber, date);
}));

// 5. Live at Station
app.get("/live-station/:stnCode", wrap((req) => {
  const hours = req.query.hours ? Number(req.query.hours) : undefined;
  return hours ? liveAtStation(req.params.stnCode, hours) : liveAtStation(req.params.stnCode);
}));

// 6. Train Search (trains between two stations)
app.get("/search", wrap((req) => {
  const { from, to } = req.query;
  if (!from || !to) throw new Error("'from' and 'to' query params are required");
  return searchTrainBetweenStations(from, to);
}));

// 7. Seat Availability
app.get("/availability", wrap((req) => {
  const { trainNo, from, to, date, coach, quota } = req.query;
  if (!trainNo || !from || !to || !date || !coach || !quota) {
    throw new Error("trainNo, from, to, date, coach, and quota query params are all required");
  }
  return getAvailability(trainNo, from, to, date, coach, quota);
}));

// 8. Fare Lookup
app.get("/fare", wrap((req) => {
  const { trainNo, from, to, date, travelClass, quota } = req.query;
  if (!trainNo || !from || !to || !date || !travelClass || !quota) {
    throw new Error("trainNo, from, to, date, travelClass, and quota query params are all required");
  }
  return fareLookup(trainNo, from, to, date, travelClass, quota);
}));

app.listen(PORT, () => {
  console.log(`[railkit-service] listening on http://127.0.0.1:${PORT}`);
  console.log(`[railkit-service] RAILKIT_API_KEY configured: ${Boolean(API_KEY)}`);
});
