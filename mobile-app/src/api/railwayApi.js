import { makeClient } from "./client";

/**
 * One function per backend route. Every function takes `baseUrl` first so
 * callers (screens) just pass the value from useSettings() — no hidden
 * global state, no stale client after a Settings change.
 *
 * Endpoints mirror backend/app.py exactly:
 *   GET  /api/health
 *   POST /api/chat
 *   POST /api/stations/search
 *   POST /api/delay/predict
 *   POST /api/crowd/predict
 *   GET  /api/analytics/summary
 *   GET  /api/analytics/train/{train_number}
 *   POST /api/feedback              <-- RLHF thumbs up/down + correction
 *   GET  /api/feedback/stats
 *   POST /api/intents/teach         <-- teach a new example to the router
 *   GET  /api/intents/list
 *   POST /api/sentiment/analyze
 *   GET  /api/train/{train_number}/route-stats  <-- RailRadar distance/time fallback
 */

export async function checkHealth(baseUrl) {
  const client = makeClient(baseUrl, { timeoutMs: 8000 });
  const { data } = await client.get("/api/health");
  return data;
}

export async function sendChatMessage(baseUrl, { message, imageBase64, imageMediaType, language, trainNumber, webSearch, deepThink }) {
  const client = makeClient(baseUrl, { timeoutMs: 45000 }); // LLM synthesis can be slow
  const { data } = await client.post("/api/chat", {
    message,
    image_base64: imageBase64 || null,
    image_media_type: imageMediaType || null,
    language: language || null,
    train_number: trainNumber || null,
    web_search: webSearch === undefined ? null : webSearch, // null = today's automatic behavior
    deep_think: !!deepThink,
  });
  return data;
}

export async function searchStations(baseUrl, { query, topK = 5 }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/stations/search", { query, top_k: topK });
  return data;
}

/**
 * POST /api/trains/search — real-time train search by source/dest (and
 * optional date/time), paginated with a user-chosen page size (1-50).
 * Mirrors the same railway_api.search_trains_between_stations +
 * trains_between.py path the chat TRAINS_BETWEEN intent uses, just as a
 * structured form endpoint instead of free-text chat.
 */
export async function searchTrains(baseUrl, { source, dest, date, time, travelClass, quota, limit = 10, page = 1 }) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const { data } = await client.post("/api/trains/search", {
    source,
    dest,
    date: date || null,
    time: time || null,
    travel_class: travelClass || null,
    quota: quota || "GN",
    limit: Math.max(1, Math.min(50, limit)),
    page,
  });
  return data;
}

export async function predictDelay(baseUrl, params) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/delay/predict", params);
  return data;
}

/**
 * POST /api/delay/explain — Train Delay Prediction with Explainable AI.
 * Same inputs as predictDelay, same headline figure, PLUS a real SHAP
 * (KernelExplainer) per-factor breakdown (`attributions`, ranked, each
 * with a signed `minutes` and `pct_of_total`), a ready-to-render
 * `narrative` array ("40% due to X"), and — when a train number is given —
 * a real historical weekday comparison (`historical_headline`). See
 * backend/delay_explainability.py. Slower than predictDelay (SHAP + up to
 * `historicalLookbackDays` real provider history calls), so it's its own
 * endpoint rather than folded into the plain prediction one.
 */
export async function explainDelay(baseUrl, params) {
  const client = makeClient(baseUrl, { timeoutMs: 30000 });
  const { data } = await client.post("/api/delay/explain", {
    ...params,
    include_historical: params.includeHistorical !== false,
    historical_lookback_days: params.historicalLookbackDays || 10,
  });
  return data;
}

export async function predictCrowd(baseUrl, params) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/crowd/predict", params);
  return data;
}

export async function getAnalyticsSummary(baseUrl) {
  const client = makeClient(baseUrl);
  const { data } = await client.get("/api/analytics/summary");
  return data;
}

export async function getTrainAnalytics(baseUrl, trainNumber, limit = 100) {
  const client = makeClient(baseUrl);
  const { data } = await client.get(`/api/analytics/train/${encodeURIComponent(trainNumber)}`, {
    params: { limit },
  });
  return data;
}

/**
 * RLHF feedback loop: every /api/chat reply carries a `response_id`.
 * Sending it back here with a rating (+ optional correction on a
 * thumbs-down) is exactly what backend/feedback_rlhf.py logs and later
 * shapes into (prompt, chosen, rejected) preference pairs via
 * /api/feedback/export — this is the human-feedback signal the backend
 * is built to collect, so the mobile app must call it on every rating tap.
 */
export async function sendFeedback(baseUrl, { responseId, rating, correction, reason }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/feedback", {
    response_id: responseId,
    rating, // "up" | "down"
    correction: correction || null,
    reason: reason || null,
  });
  return data;
}

export async function getFeedbackStats(baseUrl) {
  const client = makeClient(baseUrl);
  const { data } = await client.get("/api/feedback/stats");
  return data;
}

export async function teachIntent(baseUrl, { name, examples, responseHint }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/intents/teach", {
    name,
    examples,
    response_hint: responseHint || null,
  });
  return data;
}

export async function listIntents(baseUrl) {
  const client = makeClient(baseUrl);
  const { data } = await client.get("/api/intents/list");
  return data;
}

export async function analyzeSentiment(baseUrl, text) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/sentiment/analyze", { text });
  return data;
}

/**
 * GET /api/train/{train_number}/route-stats — real per-halt distance from
 * origin (RailRadar), avg distance/time between halts. Used as a fallback
 * for the distance shown next to each station whenever RailKit's own
 * `distance_km` is missing for this train, and for the "Distance
 * travelled so far" line in the tap-the-train-icon status popup.
 */
export async function getTrainRouteStats(baseUrl, trainNumber) {
  const client = makeClient(baseUrl, { timeoutMs: 10000 });
  const { data } = await client.get(`/api/train/${encodeURIComponent(trainNumber)}/route-stats`);
  return data;
}

/**
 * Builds the ws://.../ws/track/{trainNumber} URL with the same optional
 * query params the backend's websocket handler reads (date, source, dest,
 * travel_class, quota). wsBaseUrl should already be ws:// or wss://.
 */
export function buildTrackingWsUrl(wsBaseUrl, trainNumber, { date, source, dest, travelClass, quota } = {}) {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if (source) params.set("source", source);
  if (dest) params.set("dest", dest);
  if (travelClass) params.set("travel_class", travelClass);
  if (quota) params.set("quota", quota);
  const qs = params.toString();
  return `${wsBaseUrl}/ws/track/${encodeURIComponent(trainNumber)}${qs ? `?${qs}` : ""}`;
}

/* ---------------------------------------------------------------------
 * "More Tools" advanced-features endpoints — mirror backend/app.py's
 * /api/advanced/* routes (see backend/advanced_features.py for the
 * honesty notes on which of these are real-data vs heuristic/estimate).
 * ------------------------------------------------------------------- */

export async function predictPlatform(baseUrl, { trainNumber, station }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/platform-predict", { train_number: trainNumber, station });
  return data;
}

export async function getPantryMenu(baseUrl, { trainNumber }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/pantry-menu", { train_number: trainNumber });
  return data;
}

export async function getStationAmenities(baseUrl, stationCode) {
  const client = makeClient(baseUrl);
  const { data } = await client.get(`/api/advanced/station-amenities/${encodeURIComponent(stationCode)}`);
  return data;
}

export async function getMyTrainsDashboard(baseUrl, trains) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/dashboard", { trains });
  return data;
}

/**
 * source/dest/date/quota are optional — when a train number AND all four
 * of these are given, the backend also attaches a real-aggregate-based
 * occupancy ESTIMATE (see advanced_features.estimate_seat_occupancy's
 * honesty notes: this shades the coach's real berth numbers using the
 * real live AVAILABLE/RAC/WL count, not a live per-berth sensor).
 */
export async function getCoachLayout(baseUrl, travelClass, trainNumber, { source, dest, date, quota } = {}) {
  const client = makeClient(baseUrl);
  const params = new URLSearchParams();
  if (trainNumber) params.set("train_number", trainNumber);
  if (source) params.set("source", source);
  if (dest) params.set("dest", dest);
  if (date) params.set("date", date);
  if (quota) params.set("quota", quota);
  const qs = params.toString();
  const { data } = await client.get(`/api/advanced/coach-layout/${encodeURIComponent(travelClass)}${qs ? `?${qs}` : ""}`);
  return data;
}

/**
 * FEATURE 2: `tripProfile` is optional — { departureTime, arrivalTime,
 * travelers } — when given, the backend adds an automatic Lower/Upper (or
 * window/aisle for seat-only classes) recommendation from the trip's real
 * timing + who you're travelling with (see advanced_features.py).
 */
export async function getSeatRecommendation(baseUrl, { travelClass, preferences, tripProfile }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/seat-recommend", {
    travel_class: travelClass, preferences,
    trip_profile: tripProfile ? {
      departure_time: tripProfile.departureTime || null,
      arrival_time: tripProfile.arrivalTime || null,
      travelers: tripProfile.travelers || null,
    } : null,
  });
  return data;
}

export async function compareRoutes(baseUrl, { trainNumbers, source, dest, date, travelClass, quota }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/route-compare", {
    train_numbers: trainNumbers, source, dest, date, travel_class: travelClass, quota,
  });
  return data;
}

export async function estimateRefund(baseUrl, { fareAmount, travelClass, ticketStatus, hoursBeforeDeparture }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/refund-estimate", {
    fare_amount: fareAmount, travel_class: travelClass, ticket_status: ticketStatus, hours_before_departure: hoursBeforeDeparture,
  });
  return data;
}

export async function buildFareHeatmap(baseUrl, { trainNumber, source, dest, startDate, days, travelClass, quota }) {
  const client = makeClient(baseUrl, { timeoutMs: 30000 });
  const { data } = await client.post("/api/advanced/fare-heatmap", {
    train_number: trainNumber, source, dest, start_date: startDate, days, travel_class: travelClass, quota,
  });
  return data;
}

/** NEW: Proactive Delay Alerts — batch-checks a client-held watchlist. */
export async function checkDelayAlerts(baseUrl, watches) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/alerts/check", { watches });
  return data;
}

/* ---------------------------------------------------------------------
 * Background Push Notifications for Delay Alerts — mirror the web app's
 * enablePushNotifications() flow (frontend/app.js) so a watch set here
 * actually reaches alert_scheduler.py's server-side background job, not
 * just the in-app check above. See src/services/pushNotifications.js for
 * how the token itself is obtained (Expo push service, not raw FCM).
 * ------------------------------------------------------------------- */

/** Registers this device's push token with the backend (push_store.py). */
export async function registerPushToken(baseUrl, token, platform) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/push/register-token", { token, platform: platform || null });
  return data;
}

export async function unregisterPushToken(baseUrl, token) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/push/unregister", { token });
  return data;
}

/**
 * Replaces this device's server-side watch list wholesale (same
 * "replace everything, don't diff" contract as push_store.replace_watches
 * on the backend, and the web app's syncWatchesToServer). Call this
 * every time the local Delay Alerts list changes AND a push token is
 * already registered.
 */
export async function syncPushWatches(baseUrl, token, watches) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/push/watches", {
    token,
    watches: watches.map((w) => ({
      train_number: w.trainNumber, date: w.date || null,
      threshold_minutes: w.threshold, label: w.label,
    })),
  });
  return data;
}

/** Diagnostics: whether the backend's FCM path is configured + how many devices/watches are registered server-side. */
export async function getPushStatus(baseUrl) {
  const client = makeClient(baseUrl);
  const { data } = await client.get("/api/push/status");
  return data;
}

/** NEW: Live Station Crowd Estimation (heuristic — see backend note). */
export async function getStationCrowd(baseUrl, stationCode, hours = 2) {
  const client = makeClient(baseUrl);
  const { data } = await client.get(`/api/advanced/station-crowd/${encodeURIComponent(stationCode)}?hours=${hours}`);
  return data;
}

/** NEW: Smart Luggage/Parcel Tracking — informational (official portal link), not real tracking data. */
export async function getParcelInfo(baseUrl) {
  const client = makeClient(baseUrl);
  const { data } = await client.get("/api/advanced/parcel-info");
  return data;
}

/** NEW: Offline Route Maps & Station Information — bulk station bundle to cache locally. */
export async function getOfflineStationBundle(baseUrl) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const { data } = await client.get("/api/advanced/offline-stations");
  return data;
}

/** NEW: Interactive Journey Timeline (Gantt view) — full stop-by-stop timeline. */
export async function getJourneyTimeline(baseUrl, trainNumber, date) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const qs = date ? `?date=${encodeURIComponent(date)}` : "";
  const { data } = await client.get(`/api/advanced/journey-timeline/${encodeURIComponent(trainNumber)}${qs}`);
  return data;
}

/* ---------------------------------------------------------------------
 * Crowd-Sourced Train Position Reports — mirror backend/app.py's
 * /api/crowd-position/* routes. See backend/crowd_position_tracking.py for
 * the Kalman-filter fusion of RailKit's official position with recent
 * passenger-submitted GPS reports, and crowd_position_store.py for the
 * gamification badge tiers.
 * ------------------------------------------------------------------- */

/** Submit "I'm on this train, here's my phone's current GPS fix." */
export async function reportPosition(baseUrl, { trainNumber, reporterId, lat, lng, date, accuracyMeters, stationHint }) {
  const client = makeClient(baseUrl, { timeoutMs: 10000 });
  const { data } = await client.post("/api/crowd-position/report", {
    train_number: trainNumber,
    reporter_id: reporterId,
    lat, lng,
    date: date || null,
    accuracy_meters: accuracyMeters ?? null,
    station_hint: stationHint || null,
  });
  return data;
}

/** Fused (official + crowd-sourced) position for one train, right now. */
export async function getFusedPosition(baseUrl, trainNumber, date) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const qs = date ? `?date=${encodeURIComponent(date)}` : "";
  const { data } = await client.get(`/api/crowd-position/${encodeURIComponent(trainNumber)}${qs}`);
  return data;
}

export async function getReporterStats(baseUrl, reporterId) {
  const client = makeClient(baseUrl);
  const { data } = await client.get(`/api/crowd-position/reporter/${encodeURIComponent(reporterId)}`);
  return data;
}

export async function setReporterDisplayName(baseUrl, reporterId, displayName) {
  const client = makeClient(baseUrl);
  const { data } = await client.post(`/api/crowd-position/reporter/${encodeURIComponent(reporterId)}/name`, {
    display_name: displayName || null,
  });
  return data;
}

export async function getPositionLeaderboard(baseUrl, limit = 10) {
  const client = makeClient(baseUrl);
  const { data } = await client.get(`/api/crowd-position/leaderboard/top?limit=${limit}`);
  return data;
}

/* ---------------------------------------------------------------------
 * Personalized Travel Assistant (Profile & History) + "Near Me" Platform
 * Info — mirror backend/app.py's newest /api/advanced/* routes.
 * ------------------------------------------------------------------- */

export async function getProfileSummary(baseUrl, history) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/profile/summary", { history });
  return data;
}

export async function checkPacked(baseUrl, { trainNumber, source, dest, date, travelClass, quota }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/profile/packed-check", {
    train_number: trainNumber, source, dest, date, travel_class: travelClass, quota,
  });
  return data;
}

export async function getAlternativePlan(baseUrl, { trainNumber, source, dest, date, travelClass, quota, delayThresholdMinutes }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/profile/alternative-plan", {
    train_number: trainNumber, source, dest, date, travel_class: travelClass, quota,
    delay_threshold_minutes: delayThresholdMinutes,
  });
  return data;
}

export async function getStationNow(baseUrl, stationCode, hours = 2) {
  const client = makeClient(baseUrl);
  const { data } = await client.get(`/api/advanced/station-now/${encodeURIComponent(stationCode)}?hours=${hours}`);
  return data;
}

/**
 * POST /api/journey/plan — Personalized Journey Planner. Real direct
 * trains + real junction-hopping alternatives (route_planner.py's
 * curated graph, never an invented train), ranked by a real preference.
 * Fare is only ever populated when travelClass+date are given and a
 * live get_fare() call actually returned one — never fabricated.
 */
export async function planJourney(baseUrl, { source, dest, date, preference = "fastest", travelClass, quota = "GN" }) {
  const client = makeClient(baseUrl, { timeoutMs: 20000 });
  const { data } = await client.post("/api/journey/plan", {
    source, dest, date: date || null, preference,
    travel_class: travelClass || null, quota,
  });
  return data;
}

/**
 * GET /api/advanced/delay-history/{train_number}?days=N — real per-day
 * completed-journey history for a train, grouped by weekday. See
 * historical_delay.py — a day with no real data stays marked
 * unavailable, never averaged in as zero.
 */
export async function getDelayHistory(baseUrl, trainNumber, days = 14) {
  const client = makeClient(baseUrl, { timeoutMs: 30000 }); // up to `days` real provider calls
  const { data } = await client.get(`/api/advanced/delay-history/${encodeURIComponent(trainNumber)}?days=${days}`);
  return data;
}

/**
 * GET /api/pnr/status/{pnr} — structured real PNR status.
 * POST /api/pnr/watchlist/check — batch-refresh a client-held PNR
 * watchlist, flags status_changed vs each entry's last_known_status.
 * See pnr_tracking.py — in-app checking only, no background push.
 */
export async function getPnrStatus(baseUrl, pnr) {
  const client = makeClient(baseUrl);
  const { data } = await client.get(`/api/pnr/status/${encodeURIComponent(pnr)}`);
  return data;
}

/**
 * GET /api/train/live-status/{train_number} — RailYatri-style plain
 * running-status enquiry (mobile Home tab's "Live Train Status" tile).
 * Same real timeline the Track tab's WebSocket is built from, just
 * without the map/ML prediction layered on top.
 */
export async function getTrainLiveStatus(baseUrl, trainNumber, date) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const { data } = await client.get(`/api/train/live-status/${encodeURIComponent(trainNumber)}`, {
    params: date ? { date } : undefined,
  });
  return data;
}

/**
 * GET /api/train/schedule/{train_number} — RailYatri-style static Time
 * Table: day/distance/scheduled arrival & departure per station.
 */
export async function getTrainSchedule(baseUrl, trainNumber) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const { data } = await client.get(`/api/train/schedule/${encodeURIComponent(trainNumber)}`);
  return data;
}

/**
 * POST /api/train/seat-availability — RailYatri-style single Seat
 * Availability check for one train/route/date/class/quota.
 */
export async function checkSeatAvailability(baseUrl, { trainNumber, source, dest, date, travelClass, quota }) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const { data } = await client.post("/api/train/seat-availability", {
    train_number: trainNumber, source, dest, date,
    travel_class: travelClass, quota: quota || "GN",
  });
  return data;
}

/**
 * POST /api/train/fare — RailYatri-style Fare Calculator for one
 * train/route/date/class/quota.
 */
export async function getTrainFare(baseUrl, { trainNumber, source, dest, date, travelClass, quota }) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const { data } = await client.post("/api/train/fare", {
    train_number: trainNumber, source, dest, date,
    travel_class: travelClass, quota: quota || "GN",
  });
  return data;
}

export async function checkPnrWatchlist(baseUrl, entries) {
  const client = makeClient(baseUrl, { timeoutMs: 20000 });
  const { data } = await client.post("/api/pnr/watchlist/check", { entries });
  return data;
}

/**
 * GET /api/advanced/offline-knowledge-base — bulk bundle of the real KB
 * articles (same ones the online RAG searches) for client-side caching
 * and plain-keyword offline search. Not full offline RAG — see the
 * `note` field in the response for the honest limit (no embeddings/LLM
 * synthesis without a live connection).
 */
export async function getOfflineKnowledgeBase(baseUrl) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const { data } = await client.get("/api/advanced/offline-knowledge-base");
  return data;
}

/* ---------------------------------------------------------------------
 * Newer dynamic, input-driven tools — mirror backend/app.py's
 * departure-reminder / smart-alarm / transit-optimizer / route-timelapse /
 * coach-conditions routes. See backend/smart_features.py for the honesty
 * notes (straight-line distance estimate, crowdsourced-only coach data,
 * generic indoor-navigation guidance — never a fabricated live feed).
 * ------------------------------------------------------------------- */

/** FEATURE 9: Platform Finder with Indoor Navigation. */
export async function getPlatformNavigation(baseUrl, { station, platformNumber, trainNumber, entryPoint }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/platform-navigate", {
    station, platform_number: platformNumber || null, train_number: trainNumber || null, entry_point: entryPoint || null,
  });
  return data;
}

/** FEATURE 1: "When Should I Leave?" Smart Departure Reminder. */
export async function getDepartureReminder(baseUrl, {
  trainNumber, boardingStation, date, mode, distanceKm, userLat, userLng, boardingBufferMinutes,
}) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const { data } = await client.post("/api/advanced/departure-reminder", {
    train_number: trainNumber, boarding_station: boardingStation, date: date || null,
    mode: mode || "walk", distance_km: distanceKm ?? null,
    user_lat: userLat ?? null, user_lng: userLng ?? null,
    boarding_buffer_minutes: boardingBufferMinutes ?? 25,
  });
  return data;
}

/** FEATURE 3: "Smart Alarm" Based on Real-Time Train Position. */
export async function checkSmartAlarm(baseUrl, { trainNumber, destinationStation, date, leadMinutes, leadKm }) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const { data } = await client.post("/api/advanced/smart-alarm", {
    train_number: trainNumber, destination_station: destinationStation, date: date || null,
    lead_minutes: leadMinutes ?? 10, lead_km: leadKm ?? null,
  });
  return data;
}

/** FEATURE 5: "Transit Time Optimizer" — best train for a rider's own schedule. */
export async function getTransitOptimizer(baseUrl, {
  source, dest, date, departAfter, departBefore, arriveAfter, arriveBefore, preferredArrival, maxDurationHours,
}) {
  const client = makeClient(baseUrl, { timeoutMs: 20000 });
  const { data } = await client.post("/api/advanced/transit-optimizer", {
    source, dest, date: date || null,
    depart_after: departAfter || null, depart_before: departBefore || null,
    arrive_after: arriveAfter || null, arrive_before: arriveBefore || null,
    preferred_arrival: preferredArrival || null, max_duration_hours: maxDurationHours ?? null,
  });
  return data;
}

/** FEATURE 6: "Route Visualization" with Time-Lapse — data feed for an animated map. */
export async function getRouteTimelapse(baseUrl, trainNumber) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const { data } = await client.get(`/api/advanced/route-timelapse/${encodeURIComponent(trainNumber)}`);
  return data;
}

// NOTE: "Live Crowd Map for Train Coaches" and "Water/Restroom Availability
// Live Check" were removed — neither RailKit (RapidAPI) nor RailRadar, the
// two live-data providers this app has access to, expose any real
// per-coach occupancy or water/restroom sensor feed.

/* ---------------------------------------------------------------------
 * Newer feature-request tools: "Optimal Booking Window" predictor, Fare &
 * Availability "Alert Zone", "Find My Coach", "Station Navigator" — mirror
 * backend/app.py's newest /api/advanced/* + /api/push/fare-watches routes.
 * ------------------------------------------------------------------- */

/** "Optimal Booking Window" Predictor — real ARP/Tatkal rules + this
 * train's real current availability + this session's real logged crowd
 * scores, never a fabricated demand forecast (see advanced_features.py). */
export async function getBookingWindow(baseUrl, { trainNumber, source, dest, date, travelClass, quota }) {
  const client = makeClient(baseUrl, { timeoutMs: 15000 });
  const { data } = await client.post("/api/advanced/booking-window", {
    train_number: trainNumber, source, dest, date: date || null,
    travel_class: travelClass || "SL", quota: quota || "GN",
  });
  return data;
}

/** Coach & Seat "Find My Coach" Guide. */
export async function findMyCoach(baseUrl, { coachNumber, trainNumber, totalCoachesHint }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/advanced/find-my-coach", {
    coach_number: coachNumber, train_number: trainNumber || null, total_coaches_hint: totalCoachesHint || null,
  });
  return data;
}

/** "Station Navigator" — Point of Interest Finder. */
export async function getStationNavigator(baseUrl, stationCode) {
  const client = makeClient(baseUrl);
  const { data } = await client.get(`/api/advanced/station-navigator/${encodeURIComponent(stationCode)}`);
  return data;
}

/** Fare & Availability "Alert Zone" — on-demand check of a client-held
 * fare watchlist (same pairing as checkDelayAlerts + syncPushWatches). */
export async function checkFareWatches(baseUrl, watches) {
  const client = makeClient(baseUrl, { timeoutMs: 20000 });
  const { data } = await client.post("/api/advanced/fare-watch/check", {
    watches: watches.map((w) => ({
      train_number: w.trainNumber, source: w.source, dest: w.dest, date: w.date || null,
      travel_class: w.travelClass || "SL", quota: w.quota || "GN",
      threshold_pct: w.thresholdPct || 10, label: w.label || null, baseline_fare: w.baselineFare ?? null,
    })),
  });
  return data;
}

/** Mirrors the server-side fare-watch list (push_store.py) for background
 * push, same "replace everything" contract as syncPushWatches. */
export async function syncFareWatches(baseUrl, token, watches) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/push/fare-watches", {
    token,
    watches: watches.map((w) => ({
      train_number: w.trainNumber, source: w.source, dest: w.dest, date: w.date || null,
      travel_class: w.travelClass || "SL", quota: w.quota || "GN",
      threshold_pct: w.thresholdPct || 10, label: w.label || null, baseline_fare: w.baselineFare ?? null,
    })),
  });
  return data;
}

/* ---------------------------------------------------------------------
 * NEW: 9 Live Tracking features added this round — mirror backend/app.py's
 * /api/push/alarms, /api/advanced/connection-risk, /api/coach-crowd/*,
 * /api/trip-summary* routes, plus URL builders for the two public share
 * pages (/track/{trainNumber}, /trip/{shareId}) served directly by the
 * backend (frontend/track.html, frontend/trip.html) — those are opened
 * with Linking.openURL rather than fetched as JSON.
 * ------------------------------------------------------------------- */

/**
 * FEATURE: Background-surviving Smart Alarm. Same "replace the full set"
 * contract as syncPushWatches/syncFareWatches — this UI only ever arms ONE
 * alarm at a time, so pass a single-item array to arm, or [] to cancel the
 * background registration.
 */
export async function syncAlarmWatches(baseUrl, token, watches) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/push/alarms", {
    token,
    watches: watches.map((w) => ({
      train_number: w.trainNumber, station: w.station, date: w.date || null, lead_minutes: w.leadMinutes,
    })),
  });
  return data;
}

export async function getAlarmWatches(baseUrl, token) {
  const client = makeClient(baseUrl);
  const { data } = await client.get(`/api/push/alarms?token=${encodeURIComponent(token)}`);
  return data;
}

/** FEATURE: Connection-Risk Alert. */
export async function getConnectionRisk(baseUrl, {
  primaryTrainNumber, primaryDate, interchangeStation, connectingTrainNumber, connectingDate, connectingBoardingStation,
}) {
  const client = makeClient(baseUrl, { timeoutMs: 20000 }); // two real live-status fetches under the hood
  const { data } = await client.post("/api/advanced/connection-risk", {
    primary_train_number: primaryTrainNumber, primary_date: primaryDate || null,
    interchange_station: interchangeStation,
    connecting_train_number: connectingTrainNumber, connecting_date: connectingDate || null,
    connecting_boarding_station: connectingBoardingStation || null,
  });
  return data;
}

/** FEATURE: Real-Time Per-Coach Crowding (passenger-reported). */
export async function reportCoachCrowd(baseUrl, { trainNumber, coach, crowdLevel, date, reporterId }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/coach-crowd/report", {
    train_number: trainNumber, coach, crowd_level: crowdLevel, date: date || null, reporter_id: reporterId || null,
  });
  return data;
}

export async function getCoachCrowd(baseUrl, trainNumber, maxAgeMinutes = 20) {
  const client = makeClient(baseUrl);
  const { data } = await client.get(`/api/coach-crowd/${encodeURIComponent(trainNumber)}?max_age_minutes=${maxAgeMinutes}`);
  return data;
}

/** FEATURE: End-of-Trip Summary Card (shareable). */
export async function saveTripSummary(baseUrl, { trainNumber, date, summary }) {
  const client = makeClient(baseUrl);
  const { data } = await client.post("/api/trip-summary", { train_number: trainNumber, date: date || null, summary });
  return data;
}

export async function getTripSummary(baseUrl, shareId) {
  const client = makeClient(baseUrl);
  const { data } = await client.get(`/api/trip-summary/${encodeURIComponent(shareId)}`);
  return data;
}

/** FEATURE: Shareable Read-Only Tracking Link — builds the public
 * /track/{trainNumber} page URL (backend/frontend/track.html), derived
 * from apiBaseUrl (http(s)://host), not wsBaseUrl. */
export function buildTrackShareUrl(apiBaseUrl, trainNumber, date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : "";
  return `${apiBaseUrl.replace(/\/+$/, "")}/track/${encodeURIComponent(trainNumber)}${qs}`;
}

/** Builds the public /trip/{shareId} recap page URL (frontend/trip.html). */
export function buildTripShareUrl(apiBaseUrl, shareId) {
  return `${apiBaseUrl.replace(/\/+$/, "")}/trip/${encodeURIComponent(shareId)}`;
}
