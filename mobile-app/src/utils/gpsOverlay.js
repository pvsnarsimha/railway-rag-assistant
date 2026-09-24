// gpsOverlay.js
// -------------
// FEATURE (per request: "when the user uses GPS, the live tracker screen
// should display the prediction BY GPS"): takes the last live payload the
// screen has (from the server, or its on-device copy when offline) and the
// phone's own GPS position on this train's route (utils/offlineTracker.js
// locateOnRoute), and returns a payload of the SAME shape with:
//   - every stop behind the phone marked passed, the last one "current"
//     (so the train marker + callout sit where the phone really is),
//   - every stop ahead given a GPS ETA = now + remaining km / speed, and a
//     predicted delay re-derived from that ETA vs. the timetable,
//   - next station / km to next / live ETA / map lat-lng from the GPS fix.
// Pure JS, no network — works with no internet at all.

import { gpsEtaFor } from "./offlineTracker";

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clockMinutes(str) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(str || ""));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

// eta - scheduled, circular, in (-720, 720]
function diffMinutes(etaDate, scheduledStr) {
  const s = clockMinutes(scheduledStr);
  if (s == null || !etaDate) return null;
  const e = etaDate.getHours() * 60 + etaDate.getMinutes();
  let d = ((e - s) % 1440 + 1440) % 1440;
  if (d > 720) d -= 1440;
  return d;
}

const DROP_LOCK_FIELDS = [
  "predicted_delay_locked", "predicted_delay_locked_via", "predicted_delay_grounded_via",
  "predicted_delay_low_minutes", "predicted_delay_high_minutes", "prediction_methods_compared",
];

// ---------------------------------------------------------------------------
// BUGFIX ("for GPS it is getting wrong data"): a phone that is ON this
// train's route but NOT on the train (at home near the line, on a platform
// waiting for it, on a different train) passed the old "within 5 km of the
// route" check, so the whole screen jumped to the phone's position — e.g.
// 20834 shown "just past Vijayawada" at 16:19 while the real train was still
// ~250 km back, with made-up "2 hr 4 min late" pills. Now the phone's
// position along the route must also agree with where the LIVE feed says
// the train is (dead-reckoned forward when that reading is old / offline).
// ---------------------------------------------------------------------------

/** Train's distance-from-origin per the live feed, projected forward by
 *  elapsed time when the reading is old. { km, ageMin, tolKm } or null. */
export function liveTrainPosition(raw, now = new Date()) {
  const tl = raw && Array.isArray(raw.timeline) ? raw.timeline : [];
  if (!tl.length) return null;
  let anchor = null;
  tl.forEach((s) => { if ((s.status === "passed" || s.status === "current") && num(s.distance_km) != null) anchor = s; });
  const firstKm = num(tl[0].distance_km);
  let km = anchor ? num(anchor.distance_km) : (firstKm != null ? firstKm : null);
  if (km == null) return null;
  if (anchor && raw.distance_covered_since_last_stop_km != null) km += Math.max(0, Number(raw.distance_covered_since_last_stop_km) || 0);
  const updated = raw.status_updated_at ? new Date(raw.status_updated_at).getTime() : NaN;
  const ageMin = Number.isFinite(updated) ? Math.max(0, (now.getTime() - updated) / 60000) : 0;
  const notStarted = !anchor;
  const v = Number(raw.display_speed_kmph || raw.avg_speed_kmph) || 50;
  // Dead-reckon forward only for a running train, and only up to 3 hours.
  const moved = notStarted ? 0 : Math.min(ageMin, 180) / 60 * Math.min(Math.max(v, 20), 110);
  const lastKm = num(tl[tl.length - 1].distance_km);
  const est = lastKm != null ? Math.min(km + moved, lastKm) : km + moved;
  // Allowed disagreement: 20 km baseline, widening with how stale the
  // reading is (the train may have sped up or been held).
  const tolKm = 20 + (notStarted ? 0 : Math.min(ageMin, 180) / 60 * 40);
  return { km: est, ageMin, tolKm, notStarted };
}

/** Is the phone plausibly ON this train? { ok, gapKm, trainKm, ahead } */
export function checkGpsOnTrain(raw, gps, now = new Date()) {
  if (!gps || gps.error || gps.currentKm == null) return { ok: false, unknown: true };
  const live = liveTrainPosition(raw, now);
  if (!live) return { ok: true, unknown: true }; // nothing to compare against
  const gap = gps.currentKm - live.km;
  const acc = gps.accuracyM ? gps.accuracyM / 1000 : 0;
  return { ok: Math.abs(gap) <= live.tolKm + acc, gapKm: Math.abs(gap), ahead: gap > 0, trainKm: live.km, notStarted: live.notStarted };
}

export function applyGpsOverlay(raw, gps, speedKmph, now = new Date()) {
  if (!raw || !gps || gps.error || gps.currentKm == null) return raw;
  if (gps.source !== "gps" && gps.source !== "cell") return raw;
  const tl = Array.isArray(raw.timeline) ? raw.timeline : [];
  if (!tl.length) return raw;
  const cur = gps.currentKm;

  let lastIdx = -1;
  tl.forEach((s, i) => {
    const d = num(s.distance_km);
    if (d != null && d <= cur + 0.3) lastIdx = i;
  });

  // A stop the live feed had NOT reached yet but the phone's GPS has just
  // passed: its provider "actual" times are only predictions — never show
  // them as real recorded times or as a delay pill.
  const gpsOnlyPassed = (s) => {
    if (s.status === "passed" || s.status === "current") return s;
    const clean = (t) => (t ? { ...t, actual: null, delay_minutes: null, actual_is_predicted: true } : t);
    return { ...s, arrival: clean(s.arrival), departure: clean(s.departure), gps_passed: true,
      predicted_delay_minutes: null, predicted_eta: null };
  };
  const mapped = tl.map((s, i) => {
    if (i < lastIdx) return { ...gpsOnlyPassed(s), status: "passed" };
    if (i === lastIdx) return { ...gpsOnlyPassed(s), status: "current" };
    const out = { ...s, status: "upcoming" };
    const d = num(s.distance_km);
    if (d == null) return out;
    const km = Math.max(0, d - cur);
    const eta = gpsEtaFor(km, speedKmph, now);
    out.distance_ahead_km = Math.round(km * 10) / 10;
    if (!eta) return out;
    out.predicted_eta = eta.hhmm;
    out.predicted_eta_source = "gps";
    out.minutes_away = Math.round(eta.minutes);
    if (s.kind !== "intermediate") {
      const arr = s.arrival || {};
      const diff = diffMinutes(eta.eta, arr.scheduled || arr.expected);
      if (diff != null && diff > -120) {
        out.predicted_delay_minutes = Math.max(0, Math.round(diff));
        out.predicted_delay_confidence = "GPS";
        DROP_LOCK_FIELDS.forEach((k) => { delete out[k]; });
      }
    }
    return out;
  });

  const byCode = {};
  mapped.forEach((s) => { if (s.code) byCode[String(s.code).toUpperCase()] = s; });
  const pick = (s) => (s && s.code ? byCode[String(s.code).toUpperCase()] : null);

  const grouped = (Array.isArray(raw.timeline_grouped) && raw.timeline_grouped.length ? raw.timeline_grouped : null);
  const groupedOut = grouped
    ? grouped.map((e) => {
      if (e.display_type === "no_halt_group") {
        return {
          ...e,
          stations: (e.stations || []).map((st) => {
            const m = pick(st);
            return m ? {
              ...st, status: m.status, predicted_eta: m.predicted_eta ?? st.predicted_eta,
              distance_ahead_km: m.distance_ahead_km ?? st.distance_ahead_km, minutes_away: m.minutes_away,
              predicted_eta_source: m.predicted_eta_source,
            } : st;
          }),
        };
      }
      const m = pick(e);
      return m ? { ...e, ...m, display_type: e.display_type } : e;
    })
    : null;

  const current = lastIdx >= 0 ? mapped[lastIdx] : null;
  const next = mapped[lastIdx + 1] || null;
  const nextReporting = mapped.slice(lastIdx + 1).find((s) => s.kind !== "intermediate" && s.predicted_delay_minutes != null);
  const curD = current ? num(current.distance_km) : null;

  return {
    ...raw,
    gps_overlay: true,
    gps_headline: gps.headline || null,
    timeline: mapped,
    timeline_grouped: groupedOut || raw.timeline_grouped,
    current_station: current ? current.name : raw.current_station,
    current_station_code: current ? current.code : raw.current_station_code,
    next_station: next ? next.name : null,
    next_station_code: next ? next.code : null,
    next_station_live_eta: next ? next.predicted_eta || null : null,
    distance_remaining_to_next_km: gps.kmToNext != null ? gps.kmToNext : (next ? next.distance_ahead_km : null),
    distance_covered_since_last_stop_km: curD != null ? Math.max(0, Math.round((cur - curD) * 10) / 10) : null,
    lat: gps.lat != null ? gps.lat : raw.lat,
    lng: gps.lng != null ? gps.lng : raw.lng,
    position_source: gps.source === "gps" ? "phone_gps" : "cell_tower",
    status_updated_at: new Date(gps.fixAt || Date.now()).toISOString(),
    display_speed_kmph: speedKmph != null ? Math.round(speedKmph) : raw.display_speed_kmph,
    delay_minutes: nextReporting ? nextReporting.predicted_delay_minutes : raw.delay_minutes,
    // The server's own "wrong run" / diversion notes are about ITS feed.
    date_reliability_warning: null,
  };
}
