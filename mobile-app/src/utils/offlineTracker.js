// offlineTracker.js
// -----------------
// FEATURE: Offline Live Tracking (no internet / no mobile data).
//
// RailYatri's "offline running status" locates the phone without internet
// and then places it on the train's route using data already stored on the
// phone. This file is the "place it on the route" half, shared by the web
// and native Live Tracking screens:
//
//   1. While ONLINE, every live payload's timeline (stations + lat/lng +
//      distance_km + schedule + last known delay) is saved on the device
//      (saveRouteCache).
//   2. OFFLINE, a location fix from ANY source — the phone's GPS (works
//      with no internet at all), or a cell-tower lookup on a native build
//      (see utils/cellTower.js) — is snapped onto that cached route
//      (locateOnRoute) to give "Crossed X · N km to Y · next halt ETA".
//   3. With no location fix at all, estimateFromTimetable falls back to the
//      cached timetable + last known delay (clearly labelled as an estimate).
//
// Pure JS, no network calls, no React — safe on web and native.

import AsyncStorage from "@react-native-async-storage/async-storage";

const CACHE_PREFIX = "liveTracking.routeCache.";
const RAIL_TS_RE = /(\d{1,2}):(\d{2})(?:\s+(\d{1,2})-([A-Za-z]{3}))?/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

export function routeCacheKey(trainNumber, date) {
  return `${CACHE_PREFIX}${String(trainNumber || "").trim()}|${date || "today"}`;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function compactTiming(t) {
  if (!t) return null;
  return { scheduled: t.scheduled || null, expected: t.expected || null, actual: t.actual || null, delay_minutes: t.delay_minutes ?? null };
}

/** Builds the compact on-device copy of a live payload. */
export function buildRouteCache(payload, { trainNumber, date } = {}) {
  const tl = (payload && payload.timeline) || [];
  if (!tl.length) return null;
  return {
    v: 1,
    trainNumber: String(trainNumber || payload.train_number || ""),
    trainName: payload.train_name || null,
    date: date || payload.date || null,
    savedAt: Date.now(),
    delayMinutes: payload.delay_minutes ?? null,
    lastLive: {
      current: payload.current_station || null,
      next: payload.next_station || null,
      at: payload.status_updated_at || null,
    },
    stops: tl.map((s) => ({
      code: s.code || null,
      name: s.name || s.code || "",
      kind: s.kind || "stoppage",
      status: s.status || null,
      lat: num(s.lat),
      lng: num(s.lng),
      km: num(s.distance_km),
      day: num(s.day),
      arrival: compactTiming(s.arrival),
      departure: compactTiming(s.departure),
    })),
  };
}

export async function saveRouteCache(payload, meta) {
  const cache = buildRouteCache(payload, meta);
  if (!cache) return null;
  try { await AsyncStorage.setItem(routeCacheKey(cache.trainNumber, meta && meta.date), JSON.stringify(cache)); } catch (e) { /* storage full / private mode */ }
  return cache;
}

export async function loadRouteCache(trainNumber, date) {
  try {
    const raw = await AsyncStorage.getItem(routeCacheKey(trainNumber, date));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- geometry
const R_KM = 6371;
function toRad(d) { return (d * Math.PI) / 180; }
export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Project p onto segment a-b in a local flat (equirectangular) frame.
function projectOnSegment(p, a, b) {
  const kx = Math.cos(toRad((a.lat + b.lat) / 2)) * 111.32;
  const ky = 110.57;
  const ax = a.lng * kx, ay = a.lat * ky;
  const bx = b.lng * kx, by = b.lat * ky;
  const px = p.lng * kx, py = p.lat * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { t, offKm: Math.hypot(px - cx, py - cy) };
}

/** Stops that have coordinates, each with a route-km (provider distance_km
 *  where known, cumulative straight-line distance otherwise). */
function geoStops(stops) {
  const out = [];
  let cum = 0;
  let prev = null;
  stops.forEach((s, idx) => {
    if (s.lat == null || s.lng == null) return;
    if (prev) cum += haversineKm(prev, s);
    out.push({ ...s, idx, routeKm: s.km != null ? s.km : cum });
    prev = s;
  });
  return out;
}

// -------------------------------------------------------------- timetable
function parseStopTime(timing, journeyStart, day) {
  const raw = timing && (timing.actual || timing.expected || timing.scheduled);
  const m = RAIL_TS_RE.exec(String(raw || ""));
  if (!m) return null;
  const now = new Date();
  if (m[3] && m[4] && MONTHS[m[4]] != null) {
    return new Date(now.getFullYear(), MONTHS[m[4]], +m[3], +m[1], +m[2]);
  }
  if (!journeyStart) return null;
  const d = new Date(journeyStart);
  d.setHours(+m[1], +m[2], 0, 0);
  d.setDate(d.getDate() + Math.max(0, (day || 1) - 1));
  return d;
}

function journeyStartFromDate(date) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(date || ""));
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtHHMM(d) {
  if (!d) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function titleCase(name) {
  return String(name || "").split(/\s+/).map((w) => (w.length > 2 ? w[0] + w.slice(1).toLowerCase() : w)).join(" ");
}

/** Estimated arrival at a stop = its timetable time + the last known live delay
 *  (only when the provider hadn't already given an expected time). */
function estimatedArrival(stop, cache) {
  const start = journeyStartFromDate(cache.date);
  const hasExpected = stop.arrival && stop.arrival.expected;
  const t = parseStopTime(stop.arrival || stop.departure, start, stop.day);
  if (!t) return null;
  if (!hasExpected && cache.delayMinutes > 0) return new Date(t.getTime() + cache.delayMinutes * 60000);
  return t;
}

function nextHaltAfter(stops, idx) {
  for (let i = idx + 1; i < stops.length; i++) if (stops[i].kind !== "intermediate") return stops[i];
  return null;
}

function describe(cache, { crossedIdx, nextIdx, kmToNext, source, accuracyM, offRouteKm, speedKmph, verb }) {
  const stops = cache.stops;
  const crossed = crossedIdx >= 0 ? stops[crossedIdx] : null;
  const next = nextIdx != null && nextIdx < stops.length ? stops[nextIdx] : null;
  const halt = nextHaltAfter(stops, crossedIdx);
  let haltEta = halt ? estimatedArrival(halt, cache) : null;
  // With a real GPS speed, re-derive the next halt ETA from real remaining km.
  if (halt && speedKmph && speedKmph > 5 && crossed) {
    const haltKm = halt.km, crossedKm = crossed.km;
    if (haltKm != null && crossedKm != null && kmToNext != null && next && next.km != null) {
      const remaining = kmToNext + Math.max(0, haltKm - next.km);
      haltEta = new Date(Date.now() + (remaining / speedKmph) * 3600000);
    }
  }
  const completed = crossedIdx === stops.length - 1;
  const parts = [];
  if (completed) parts.push(`Reached ${titleCase(crossed.name)}`);
  else if (crossed) {
    // Real recorded time from the last live data, when this point had one.
    const t = crossed.departure && crossed.departure.actual ? crossed.departure.actual
      : crossed.arrival && crossed.arrival.actual ? crossed.arrival.actual : null;
    const m = t ? RAIL_TS_RE.exec(String(t)) : null;
    const clock = m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
    parts.push(`${verb || "Crossed"} ${titleCase(crossed.name)}${clock && verb !== "At" ? ` at ${clock}` : ""}`);
  }
  else parts.push("Yet to start");
  if (!completed && next) {
    parts.push(kmToNext != null ? `${Math.round(kmToNext * 10) / 10} km to ${titleCase(next.name)}` : `Next: ${titleCase(next.name)}`);
  }
  return {
    source, // "gps" | "cell" | "timetable"
    accuracyM: accuracyM ?? null,
    offRouteKm: offRouteKm ?? null,
    speedKmph: speedKmph ?? null,
    completed,
    crossedStation: crossed ? titleCase(crossed.name) : null,
    nextStation: next ? titleCase(next.name) : null,
    kmToNext: kmToNext != null ? Math.round(kmToNext * 10) / 10 : null,
    nextHalt: halt ? titleCase(halt.name) : null,
    nextHaltEta: fmtHHMM(haltEta),
    delayMinutes: cache.delayMinutes,
    headline: parts.join(" · "),
    cacheAgeMinutes: Math.round((Date.now() - (cache.savedAt || Date.now())) / 60000),
  };
}

/**
 * Snaps a location fix onto the cached route.
 * fix: { lat, lng, accuracy (m)?, speed (m/s)?, source: "gps"|"cell" }
 * Returns a description, or { error } when the fix is too far from this
 * train's route (e.g. the user isn't actually on this train).
 */
export function locateOnRoute(cache, fix) {
  if (!cache || !cache.stops || !fix || fix.lat == null || fix.lng == null) return { error: "No location or route data." };
  const geo = geoStops(cache.stops);
  if (geo.length < 2) return { error: "This train's cached route has no station coordinates yet — open it once online." };
  let best = null;
  for (let i = 0; i < geo.length - 1; i++) {
    const pr = projectOnSegment(fix, geo[i], geo[i + 1]);
    if (!best || pr.offKm < best.offKm) best = { i, ...pr };
  }
  const maxOff = fix.source === "cell" ? 8 : 5; // cell fixes are coarser
  if (best.offKm > maxOff + (fix.accuracy ? fix.accuracy / 1000 : 0)) {
    return { error: `You're about ${Math.round(best.offKm)} km away from this train's route — are you on this train?`, offRouteKm: best.offKm };
  }
  const a = geo[best.i], b = geo[best.i + 1];
  const segKm = Math.max(0, b.routeKm - a.routeKm);
  const kmToNext = segKm * (1 - best.t);
  const atStation = best.t < 0.03 && a.kind !== "intermediate";
  // FEATURE (GPS predictions on the live timeline): the phone's own
  // position as a distance-from-origin on this train's route, so the
  // Live Tracking screen can mark every stop behind it as passed and
  // compute a real GPS-based ETA to every stop ahead.
  const currentKm = a.routeKm + segKm * best.t;
  const base = describe(cache, {
    crossedIdx: a.idx,
    nextIdx: b.idx,
    kmToNext,
    source: fix.source || "gps",
    accuracyM: fix.accuracy,
    offRouteKm: best.offKm,
    speedKmph: fix.speed != null && fix.speed >= 0 ? fix.speed * 3.6 : null,
    verb: atStation ? "At" : "Crossed",
  });
  return {
    ...base,
    currentKm: Math.round(currentKm * 100) / 100,
    crossedCode: a.code || null,
    nextCode: b.code || null,
    atStation,
    fixAt: fix.at || Date.now(),
    lat: fix.lat,
    lng: fix.lng,
  };
}

/** Minutes-ahead arithmetic for GPS ETAs: remaining km / speed. */
export function gpsEtaFor(kmAway, speedKmph, now = new Date()) {
  if (kmAway == null || !speedKmph || speedKmph <= 0) return null;
  const minutes = (Math.max(0, kmAway) / speedKmph) * 60;
  const eta = new Date(now.getTime() + minutes * 60000);
  return { minutes, eta, hhmm: fmtHHMM(eta) };
}

/** No location at all: timetable + last known delay. Always labelled "estimate". */
export function estimateFromTimetable(cache, now = new Date()) {
  if (!cache || !cache.stops || !cache.stops.length) return { error: "No cached timetable for this train." };
  const times = cache.stops.map((s) => estimatedArrival(s, cache));
  let crossedIdx = -1;
  times.forEach((t, i) => { if (t && t.getTime() <= now.getTime()) crossedIdx = i; });
  // Never go backwards from where live data last put the train.
  const lastPassed = cache.stops.reduce((acc, s, i) => (s.status === "passed" || s.status === "current" ? i : acc), -1);
  crossedIdx = Math.max(crossedIdx, lastPassed);
  let kmToNext = null;
  const a = cache.stops[crossedIdx], b = cache.stops[crossedIdx + 1];
  if (a && b && a.km != null && b.km != null && times[crossedIdx] && times[crossedIdx + 1]) {
    const span = times[crossedIdx + 1] - times[crossedIdx];
    const frac = span > 0 ? Math.min(1, Math.max(0, (now - times[crossedIdx]) / span)) : 0;
    kmToNext = (b.km - a.km) * (1 - frac);
  }
  return describe(cache, { crossedIdx, nextIdx: crossedIdx + 1, kmToNext, source: "timetable" });
}
