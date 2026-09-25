import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Share, Linking, Modal } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import DayPickerModal from "../components/DayPickerModal";
import DelayAlertModal from "../components/DelayAlertModal";
import { useSettings } from "../context/SettingsContext";
import {
  buildTrackingWsUrl, saveTripSummary, buildTrackShareUrl, buildTripShareUrl, sendFeedback,
  checkDelayAlerts, checkSmartAlarm, registerPushToken, syncPushWatches, syncAlarmWatches, getAlarmWatches,
  warmupLive,
} from "../api/railwayApi";
import { describeApiError } from "../api/client";
import { registerForPushNotifications, refreshWebPushToken, scheduleLocalAlarm, cancelLocalAlarm } from "../services/pushNotifications";
import { formatDelayDuration } from "../utils/formatDelay";
import { fromDdMmYyyy, formatLongLabel } from "../utils/dateFormat";
import OfflineTrackingCard from "../components/OfflineTrackingCard";
import { applyGpsOverlay, checkGpsOnTrain } from "../utils/gpsOverlay";
import { isSpeechSupported, loadReadAloud, saveReadAloud, speak, onTrainPush, shouldSpeakPush } from "../utils/speakNotifications";
import {
  saveActiveTrack, loadActiveTrack, clearActiveTrack, enableBackgroundTracking, disableBackgroundTracking,
  loadStatusEvery, saveStatusEvery,
} from "../services/backgroundTracking";

// FEATURE: Delay Alert / Smart Alarm, moved onto Live Tracking itself
// instead of living only inside the separate "More Tools" menu (per
// explicit user request — these are the two alerts someone actively
// tracking a train actually wants in the moment, and burying them behind
// an 18-tab "More Tools" scroll meant most people never found them).
// Both reuse the SAME AsyncStorage keys MoreToolsScreen.js's AlertsTool /
// SmartAlarmTool already use for the local watchlist + push token, so a
// watch set from either screen shows up on both, and a token registered
// from either screen works for both — nothing here is a second, separate
// watchlist or a second push registration.
const PUSH_TOKEN_KEY = "moreTools.pushToken";
const ALERTS_KEY = "moreTools.delayAlerts";

// FEATURE ("Start tracking should show the live tracking INSTANTLY, and
// coming back to the app it should be back on the live position within a
// second"): the last live payload per train is kept on the device and
// painted immediately on Start / app resume, while the live connection
// catches up in the background (the server also pushes its own latest
// snapshot the moment the socket opens — see ws_track_train).
const LAST_PAYLOAD_PREFIX = "liveTracking.lastPayload.";
const LAST_PAYLOAD_MAX_AGE_MS = 6 * 3600 * 1000;
const LAST_PAYLOAD_SAVE_EVERY_MS = 15000;
function lastPayloadKey(trainNumber, date) {
  return `${LAST_PAYLOAD_PREFIX}${String(trainNumber || "").trim()}|${effectiveTrackDate(date)}`;
}
async function loadLastPayload(trainNumber, date) {
  try {
    const raw = await AsyncStorage.getItem(lastPayloadKey(trainNumber, date));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || !v.payload || Date.now() - (v.savedAt || 0) > LAST_PAYLOAD_MAX_AGE_MS) return null;
    return v.payload;
  } catch (e) {
    return null;
  }
}
async function saveLastPayload(trainNumber, date, payload) {
  try {
    await AsyncStorage.setItem(lastPayloadKey(trainNumber, date), JSON.stringify({ savedAt: Date.now(), payload }));
  } catch (e) { /* storage full / private mode — the live feed still works */ }
}

// FEATURE: "train about to arrive in the next 5–10 min, be alert" — for
// an armed bell. The server pushes this too; the in-app banner (and, on
// GPS with no internet, a local notification) covers the cases a server
// push can't reach.
const APPROACH_ALERT_MINUTES = 10;
function showLocalNotice(title, body, tag) {
  try { if (loadReadAloud()) speak(`${title}. ${body}`); } catch (e) { /* ignore */ }
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      // eslint-disable-next-line no-new
      new Notification(title, { body, tag, renotify: true, vibrate: [200, 100, 200, 100, 200] });
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

// Custom Smart Alarm lead time, per the exact UX requested: a quick-pick
// row of common values, or "Custom" for a free-typed value — plain
// minutes under an hour, "H:MM" (e.g. "1:30" = 1hr 30min) at or past an
// hour. Returns null on anything unparseable so the caller can show a
// clear error instead of silently arming a bogus lead time.
function parseLeadMinutesInput(text) {
  const t = (text || "").trim();
  if (!t) return null;
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (hhmm) {
    const h = parseInt(hhmm[1], 10);
    const m = parseInt(hhmm[2], 10);
    if (m >= 60) return null;
    return h * 60 + m;
  }
  const n = parseInt(t, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// FEATURE: Live delay-trend sparkline — same rolling-buffer size as the
// native screen's DelaySparkline and the web app's ltDelaySparkline.
const SPARKLINE_MAX_POINTS = 20;

// A share link built from a private/local host (localhost, a bare LAN IP)
// only ever resolves on this device/WiFi — see the matching comment in
// TrackedTrainCard.js for the full explanation. Same check, duplicated
// here rather than shared, since this file is a separate Metro entry
// point (the web-only fallback) from the native component.
function extractHostname(url) {
  return (url || "").replace(/^[a-zA-Z][\w+.-]*:\/\//, "").split(/[/:?#]/)[0];
}
function isPrivateOrLocalHost(url) {
  const h = extractHostname(url).toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "10.0.2.2" || h.endsWith(".local")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}
const LOCAL_SHARE_WARNING =
  "⚠️ Local address — won't open for anyone outside this device/WiFi. See the README's \"Sharing links publicly\" section.";

// BUGFIX: "no station anywhere is current" alone missed a second failure
// shape — the provider getting stuck showing the ORIGIN station as
// "current" forever instead of clearing the current marker altogether once
// it stops updating. Seen live on train 20707: SECUNDERABAD JN (the very
// first stop) stayed flagged "current" for 9+ hours after the train should
// have reached VISAKHAPATNAM. parseRailTimestamp/scheduleWellInPast add a
// second, independent signal: the destination's own scheduled arrival
// ("Exp HH:MM DD-Mon", RailKit's own format) is well behind the real
// current time. Requiring BOTH that AND "current is missing or stuck
// at/before the first stop" (see computeJourneyLikelyComplete) keeps a
// train that's simply running very late but still genuinely, actively
// tracked from being wrongly flagged — a real live position necessarily
// moves past the origin as a very late train's journey continues. Mirrors
// the web frontend's identical helpers in app.js.
const RAIL_TIMESTAMP_RE = /(\d{1,2}):(\d{2})\s+(\d{1,2})-([A-Za-z]{3})/;
const RAIL_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseRailTimestamp(str) {
  const m = RAIL_TIMESTAMP_RE.exec(String(str || ""));
  if (!m) return null;
  const monthIdx = RAIL_MONTHS[m[4]];
  if (monthIdx == null) return null;
  const now = new Date();
  let d = new Date(now.getFullYear(), monthIdx, parseInt(m[3], 10), parseInt(m[1], 10), parseInt(m[2], 10));
  if (d.getTime() - now.getTime() > 200 * 24 * 60 * 60 * 1000) {
    d = new Date(now.getFullYear() - 1, monthIdx, parseInt(m[3], 10), parseInt(m[1], 10), parseInt(m[2], 10));
  }
  return d;
}
function scheduleWellInPast(timing, thresholdMinutes) {
  if (!timing) return false;
  const d = parseRailTimestamp(timing.expected || timing.scheduled);
  if (!d) return false;
  return Date.now() - d.getTime() > thresholdMinutes * 60000;
}
// BUGFIX: querying an OLDER date (e.g. "yesterday") for a train whose
// journey is obviously long over by now was still reading as "genuinely,
// actively tracked" whenever the provider's stuck "current" pointer
// happened to land mid-route rather than exactly at the origin, because
// currentIdx > 0 unconditionally short-circuited the schedule check
// below. (An earlier version of this fix compared calendar DATES instead
// of elapsed time, but that misfires right at midnight — a destination
// scheduled 23:xx "yesterday" checked at 00:3x "today" is barely over an
// hour old, not a day-old completed run, yet a bare date comparison
// called it a past day regardless.) Elapsed real time avoids that edge
// case outright: a stuck-at-origin (or fully silent) provider only needs
// 3h past the destination's own schedule to call it stale, but a pointer
// stuck FURTHER ALONG the route could still be a genuinely very late,
// actively-tracked train, so it needs a much bigger overrun — 12h past
// its own scheduled arrival, comfortably longer than a real same-run
// delay — before being treated the same way. Mirrors the web frontend's
// identical helper in app.js.
function computeJourneyLikelyComplete(timelineArr, lastStop) {
  if (!Array.isArray(timelineArr) || !timelineArr.length || !lastStop) return false;
  if (lastStop.status === "passed" || lastStop.status === "current") return false;
  const currentIdx = timelineArr.findIndex((s) => s.status === "current");
  if (currentIdx === -1) return true;
  const thresholdMinutes = currentIdx === 0 ? 180 : 720;
  return scheduleWellInPast(lastStop.arrival, thresholdMinutes) || scheduleWellInPast(lastStop.departure, thresholdMinutes);
}

// REDESIGN (RailYatri-style running status): RailKit's own per-stop "day"
// field (1-based day-of-run — see gps_tracking.py's `day`/`_day_offset`,
// already flowing through both `timeline` and `timeline_grouped`) lets the
// station list be split into "Day N: <date>" bands, same as RailYatri's own
// page. The calendar date shown for each day is derived — never invented —
// from day 1's real calendar date (see resolveJourneyStartDate below) plus
// (day - 1).
// Blank "Date" field means today: pin it to today's real dd-mm-yyyy (the
// same format DayPickerModal emits) so a saved alert keeps pointing at
// the run the user meant even after midnight.
// Drops delay watches whose run date is more than 2 days in the past —
// those journeys are over and their alerts can never fire, so they only
// used to crowd out newly armed bells.
function pruneExpiredWatches(list) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 2);
  return (list || []).filter((w) => {
    const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(w.date || ""));
    if (!m) return true;
    return new Date(+m[3], +m[2] - 1, +m[1]) >= cutoff;
  });
}

// FEATURE: bell auto-off — drops local delay watches the server has
// already switched off (station reached). `retired` rows come back from
// POST /api/push/watches as { train_number, date, label }.
function dropRetiredWatches(list, retired) {
  if (!Array.isArray(retired) || !retired.length) return list;
  const gone = new Set(retired.map((r) => `${String(r.train_number).trim()}|${r.date || ""}|${String(r.label || "").toUpperCase()}`));
  return (list || []).filter((w) => !gone.has(`${String(w.trainNumber).trim()}|${w.date || ""}|${String(w.label || "").toUpperCase()}`));
}

// "Today" / "Yesterday" / "Tomorrow" / "24 Sep" for the header date switch.
function trackDateLabel(ddmmyyyy) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(ddmmyyyy || ""));
  if (!m) return "Today";
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function effectiveTrackDate(trackDateInput) {
  const v = (trackDateInput || "").trim();
  if (v) return v;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

function parseTrackDateInput(str) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec((str || "").trim());
  if (!m) return new Date();
  const d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
function journeyDayNumber(entry) {
  const n = parseInt(entry?.day, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
// BUGFIX ("for long journey trains ... even if I don't give any date it
// should [not] default day 1 as today"): when the user leaves the "Date"
// field blank, this used to just call parseTrackDateInput("") -> today and
// treat THAT as day 1 of the journey unconditionally. For a multi-day train
// that's already partway through its run (e.g. it genuinely departed 2 days
// ago), that's wrong.
//
// FIRST FIX ATTEMPT (kept here as a record, since it was real but
// insufficient on its own): anchor on "today minus (the current/last-passed
// stop's real day number - 1)". That was WRONG in practice as soon as the
// backend was separately fixed to send RailKit the train's real start date
// (see backend/app.py's ws_track_train) - RailKit's own per-stop
// scheduled/expected/actual strings already carry a real date suffix in
// RailKit's own "HH:MM DD-Mon" format (see parseRailTimestamp above,
// "RailKit's own format"), and those came back correct (e.g. the origin
// showing the real "16-Sep") - but this function was STILL computing the
// "DayN:" pill from "today minus day-number", which used the DEVICE'S
// clock as ground truth for "day N is happening right now". The two can
// disagree (the device's "today" is not necessarily the same real day as
// whichever station the provider currently marks "current"/"passed"),
// which is exactly what was reported: the pill read "Day1: 17 Sept" while
// the very first station's own row, right below it, already correctly
// showed "16-Sep" - two different numbers for what should be the same
// real fact, because they were computed two different ways.
//
// REAL FIX: stop deriving Day 1 from "today" at all. RailKit already GIVES
// us a real calendar date on every dated stop (its own "HH:MM DD-Mon"
// timestamps) - so Day 1's date is just that stop's own real date minus
// (that SAME stop's own real day number - 1), entirely self-consistent
// with what the row underneath the pill already displays, no separate
// "what is today" assumption involved anywhere. Walks the timeline for the
// first stop that has ANY real dated timestamp (arrival or departure,
// actual/expected/scheduled, whichever is present) - normally the origin,
// since an already-passed/current stop is what reliably carries a real
// date-stamped time in RailKit's response.
//
// Only applies when the user left the date field blank - an explicit date
// the user typed IS day 1 by definition and is trusted as before.
function realDateOfEntry(entry) {
  if (!entry) return null;
  for (const timing of [entry.arrival, entry.departure]) {
    if (!timing) continue;
    for (const raw of [timing.actual, timing.expected, timing.scheduled]) {
      const d = parseRailTimestamp(raw);
      if (d) return d;
    }
  }
  return null;
}
function firstRealDatedStop(timelineArr) {
  for (const s of timelineArr) {
    const d = realDateOfEntry(s);
    if (d) return { stop: s, date: d };
  }
  return null;
}
// BUGFIX ("if I choose 17th sept then day 1 17th sept day 2 18th sept day 3
// 19th sept but in my app it is completely reverse"): this used to trust an
// EXPLICIT trackDateInput verbatim as Day 1's calendar anchor, only falling
// back to the self-consistent real-timestamp derivation below when the date
// field was left blank. That was built on the same assumption rounds 24-26
// (see backend/app.py's ws_track_train) already disproved for the blank-date
// case and had to fix there instead: RailKit cannot actually select a
// DIFFERENT run by date - whatever date is requested, it returns whichever
// run it's currently live-attached to. So typing "17-09-2026" for a train
// whose real live-attached run genuinely departed "18-09-2026" doesn't make
// RailKit switch runs; it just means every REAL dated timestamp RailKit
// sends back (the same ones dayNumberForEntry below reads for each row) is
// stamped with the true 18-Sep/19-Sep run, while this function alone kept
// insisting Day 1 was 17-Sep - two different sources of truth for what
// should be the same fact, exactly the bug the "Day1: 17 Sept" vs. "16-Sep"
// mismatch further up this file was already fixed for once before.
//
// REAL FIX: always derive Day 1 the same self-consistent way regardless of
// whether the user typed a date - from the FIRST real dated timestamp
// RailKit itself sent, minus that same stop's own real day number. This can
// never disagree with dayNumberForEntry's per-row math below, because both
// read the identical real field. Only when there's no real dated stop at
// all yet (nothing to derive from) does this fall back to trusting what the
// user typed, and only then to today - same honest-fallback order as
// before, just no longer skipped whenever real data IS available.
function resolveJourneyStartDate(trackDateInput, timelineArr) {
  const arr = Array.isArray(timelineArr) ? timelineArr : [];
  const found = firstRealDatedStop(arr);
  if (!found) {
    // no real dated timestamp anywhere yet - trust what the user typed if
    // they typed something, otherwise today is the best honest fallback
    return (trackDateInput || "").trim() ? parseTrackDateInput(trackDateInput) : new Date();
  }
  const realDayNumber = journeyDayNumber(found.stop);
  const anchor = new Date(found.date);
  anchor.setDate(anchor.getDate() - (realDayNumber - 1));
  return anchor;
}
// BUGFIX ("after 11:59:59 PM ... onwards it should display Day 2 ... but in
// my app is not behaving like that"): the day-pill boundary itself (WHEN a
// new "DayN:" band starts) was still keyed off RailKit's own per-stop `day`
// field (journeyDayNumber) - a SEPARATE field from the real date already
// stamped on that same stop's own arrival/departure time (the thing the row
// itself displays, e.g. Warangal's own real "00:48 17-Sep"). Those two
// fields don't reliably move together - a stop can carry a correct real
// dated timestamp while RailKit's own `day` counter hasn't incremented for
// it, so the pill kept showing "Day1" past a real midnight crossing even
// though the row directly under it had already rolled over to the next
// calendar date. Fixed the same way as resolveJourneyStartDate above: work
// out this stop's real day number FROM ITS OWN real dated timestamp
// (whole-calendar-days since journeyStartDate) whenever it has one, so the
// pill boundary can never disagree with what's printed on the row beneath
// it. Only falls back to RailKit's raw `day` field for a stop that has no
// real dated timestamp of its own yet (a genuinely bare "HH:MM" far-future
// scheduled stop) - same as before for that case, nothing lost.
function dayNumberForEntry(entry, journeyStartDate) {
  const realDate = realDateOfEntry(entry);
  if (realDate && journeyStartDate) {
    const msPerDay = 24 * 60 * 60 * 1000;
    const a = new Date(journeyStartDate.getFullYear(), journeyStartDate.getMonth(), journeyStartDate.getDate());
    const b = new Date(realDate.getFullYear(), realDate.getMonth(), realDate.getDate());
    const diffDays = Math.round((b.getTime() - a.getTime()) / msPerDay);
    return diffDays + 1;
  }
  return journeyDayNumber(entry);
}
function formatJourneyDayLabel(startDate, dayNumber) {
  const d = new Date(startDate);
  d.setDate(d.getDate() + (dayNumber - 1));
  return d.toLocaleDateString("en-IN", { month: "short", day: "numeric" });
}

// REDESIGN (RailYatri-style): RailKit reports intermediate ("passing")
// station names in ALL CAPS while its major-halt names already come
// through nicely cased — purely a display normalization of the SAME real
// name, not a data change, so the collapsed "No-Halt stations" list reads
// like the rest of the screen instead of shouting.
function toDisplayCase(name) {
  if (!name) return name;
  // Leave a name that's already mixed-case alone (don't mangle real
  // camel/PascalCase station names some sources already provide nicely).
  if (/[a-z]/.test(name)) return name;
  return name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// REDESIGN (RailYatri-style bottom bar): "Next: X in N mins" needs
// minutes-from-now, not just the clock-time string the payload already
// carries (next_station_live_eta, e.g. "13:10") — this is arithmetic on
// that same real value, never an invented ETA. Returns null (never a
// guess) if the string isn't a parseable HH:MM, or if it's already passed
// by more than a few minutes (stale/yesterday's reading).
function minutesFromNowClockTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(m[1], 10), parseInt(m[2], 10));
  let diffMin = Math.round((target.getTime() - now.getTime()) / 60000);
  if (diffMin < -5) diffMin += 24 * 60; // clock time was for "tomorrow" relative to a late-night now
  return diffMin;
}

// REDESIGN (RailYatri-style live position marker): "As of N secs/mins ago"
// — backed by the REAL last-genuine-fetch field (backend app.py's
// status_updated_at). BUGFIX: that field used to be re-stamped "now" on
// EVERY ~5s poll regardless of whether the position data had actually
// changed, so this always read "less than a min ago" even when the
// underlying live status was up to 45s stale — looking live while quietly
// not being live. The backend now reports the true last real-fetch time,
// and separately guarantees that real fetch happens at least every 60s
// (see REAL_DATA_MAX_STALENESS_SECONDS in ws_track_train). Shown down to
// the second here (not just whole minutes) so that real <=60s cadence is
// actually visible ticking up between genuine refreshes, instead of
// always reading the same vague "less than a min ago" either way. Kept as
// a duplicate copy rather than shared, matching this file's existing
// separate-Metro-entry-point pattern (see extractHostname's comment above).
function formatAsOfAgo(iso) {
  if (!iso) return "just now";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "just now";
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec} secs ago`;
  const diffMin = Math.round(diffSec / 60);
  return `${diffMin} min${diffMin === 1 ? "" : "s"} ago`;
}

// FEATURE: "Train on map" — a real Leaflet map on demand, shown/hidden by a
// toggle button rather than always rendered (matches the web frontend's own
// "Train on map" / "Delay chart" collapsible sections). `react-native-maps`
// has no web target (see the module docstring below for why this file
// exists at all), but plain Leaflet has no such restriction — it's just DOM
// + JS, so it runs fine inside a react-native-web <View> (which is a <div>
// under the hood; a ref to it is a real DOM node Leaflet can mount into).
// Reuses the SAME vendored Leaflet build + train icon the web frontend
// already ships (frontend/assets/vendor/leaflet, frontend/assets/icons) —
// served from this same backend at these absolute paths regardless of
// whether this page itself is loaded from "/" or "/mobile-app/" — instead
// of adding a new CDN dependency.
const LEAFLET_CSS_URL = "/assets/vendor/leaflet/leaflet.css";
const LEAFLET_JS_URL = "/assets/vendor/leaflet/leaflet.js";
const TRAIN_ICON_URL = "/assets/icons/train-marker.png";

// FEATURE: 2D-animated train movement — same idea as the web frontend's
// animateMarkerTo() in app.js (kept as a separate copy rather than shared,
// same "this file is a separate Metro entry point" pattern the rest of
// this module already follows). Tweens the marker smoothly between two
// REAL reported positions instead of Leaflet's normal instant setLatLng()
// jump, so the train reads as continuously moving rather than a pin that
// teleports every ~5s poll.
let liveMarkerAnimFrame = null;
function animateMarkerTo(marker, fromLatLng, toLatLng, durationMs) {
  if (liveMarkerAnimFrame) {
    cancelAnimationFrame(liveMarkerAnimFrame);
    liveMarkerAnimFrame = null;
  }
  if (!marker) return;
  const noMove = fromLatLng && fromLatLng[0] === toLatLng[0] && fromLatLng[1] === toLatLng[1];
  if (!fromLatLng || noMove) {
    marker.setLatLng(toLatLng);
    return;
  }
  const [fromLat, fromLng] = fromLatLng;
  const [toLat, toLng] = toLatLng;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    marker.setLatLng([fromLat + (toLat - fromLat) * eased, fromLng + (toLng - fromLng) * eased]);
    if (t < 1) {
      liveMarkerAnimFrame = requestAnimationFrame(step);
    } else {
      liveMarkerAnimFrame = null;
    }
  }
  liveMarkerAnimFrame = requestAnimationFrame(step);
}

let leafletLoadPromise = null;
function loadLeaflet() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.L) return Promise.resolve(window.L);
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS_URL}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS_URL;
      document.head.appendChild(link);
    }
    // FEATURE: 2D-animated "live" pulse on the train icon — same keyframes
    // as the web frontend's .train-marker-icon (frontend/style.css), just
    // inlined here since this Metro/web bundle has no shared CSS file with
    // the frontend. Purely visual (the marker's actual movement between
    // real positions is animated in JS via animateMarkerTo() above).
    if (!document.getElementById("rn-train-marker-pulse-style")) {
      const style = document.createElement("style");
      style.id = "rn-train-marker-pulse-style";
      style.textContent = `
        .train-marker-icon {
          border-radius: 5px; background: #fff; padding: 1px;
          animation: rnTrainMarkerPulse 1.6s ease-in-out infinite;
        }
        @keyframes rnTrainMarkerPulse {
          0%, 100% { box-shadow: 0 1px 3px rgba(11,37,69,0.45), 0 0 0 0 rgba(193,39,45,0.55); }
          50% { box-shadow: 0 1px 3px rgba(11,37,69,0.45), 0 0 0 7px rgba(193,39,45,0); }
        }
        @media (prefers-reduced-motion: reduce) { .train-marker-icon { animation: none; } }
      `;
      document.head.appendChild(style);
    }
    const script = document.createElement("script");
    script.src = LEAFLET_JS_URL;
    script.async = true;
    script.onload = () => (window.L ? resolve(window.L) : reject(new Error("Leaflet loaded but window.L is missing")));
    script.onerror = () => reject(new Error("Failed to load the map library"));
    document.head.appendChild(script);
  });
  return leafletLoadPromise;
}

/**
 * Web build of Live Tracking. `react-native-maps` has no web target — even
 * importing it breaks Metro's web bundle (see MapMarkerNativeComponent's
 * native-only import) — so this file exists purely so Metro's platform
 * resolution (`LiveTrackingScreen.web.js` beats `LiveTrackingScreen.js` on
 * web) picks a screen that never imports react-native-maps. It still gets a
 * real map though, via the "Train on map" toggle: plain Leaflet (see
 * loadLeaflet() above) has no such native-only restriction, so it's loaded
 * and mounted directly into a react-native-web <View>'s underlying DOM node
 * on demand, matching the web frontend's own collapsible map section.
 * Everything else — the live WebSocket feed, delay/crowd prediction, and
 * stop timeline — works identically to the native screen. The native/Expo
 * Go build still gets its own map in LiveTrackingScreen.js.
 */

// green = already arrived, yellow = the very next station the train is
// heading to, red = stations further out that haven't been reached yet.
const STATUS_COLOR = {
  passed: colors.success,
  current: colors.warning,
  upcoming: colors.danger,
};

export default function LiveTrackingScreen({ navigation }) {
  const { wsBaseUrl, apiBaseUrl } = useSettings();
  const [trainNumber, setTrainNumber] = useState("");
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [trackDate, setTrackDate] = useState("");
  const [dayPickerVisible, setDayPickerVisible] = useState(false);
  const [connection, setConnection] = useState("idle");
  // The last payload from the live server feed (or its on-device copy).
  const [rawPayload, setPayload] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const lastPayloadSavedAtRef = useRef(0);

  // FEATURE: GPS mode (RailYatri-style "Are you inside the train?").
  // GPS is used only when the user confirms they're ON this train (or
  // there's no internet) — then the whole screen (timeline, train marker,
  // ETAs, next station, map) is driven by the phone's own GPS position via
  // applyGpsOverlay. If the GPS fix is far from this train's route the user
  // isn't on it: an error is shown and tracking switches back to internet.
  const [gpsOn, setGpsOn] = useState(false);
  const [gpsAsk, setGpsAsk] = useState(null); // null | { reason }
  const [gpsResult, setGpsResult] = useState(null);
  const [modeNotice, setModeNotice] = useState(null); // red RailYatri-style banner text
  const gpsHistoryRef = useRef([]); // [{ km, t }] recent GPS route positions, for a real speed
  const onGpsResult = useCallback((r) => {
    setGpsResult(r);
    if (r && !r.error && r.currentKm != null && (r.source === "gps" || r.source === "cell")) {
      const t = r.fixAt || Date.now();
      const hist = gpsHistoryRef.current.filter((h) => t - h.t < 5 * 60000 && t >= h.t);
      hist.push({ km: r.currentKm, t });
      gpsHistoryRef.current = hist.slice(-30);
    }
  }, []);
  const gpsSpeedKmph = useMemo(() => {
    if (!gpsResult || gpsResult.error) return null;
    if (gpsResult.speedKmph != null && gpsResult.speedKmph >= 10) return Math.min(gpsResult.speedKmph, 130);
    const hist = gpsHistoryRef.current;
    if (hist.length >= 2) {
      const a = hist[0], b = hist[hist.length - 1];
      const dtH = (b.t - a.t) / 3600000;
      if (dtH > 45 / 3600) {
        const v = (b.km - a.km) / dtH;
        if (v >= 10) return Math.min(v, 130);
      }
    }
    // Stopped at a signal/station: ETAs assume it resumes at its usual pace.
    const avg = rawPayload && (rawPayload.avg_speed_kmph || rawPayload.display_speed_kmph);
    return avg && avg > 10 ? avg : 50;
  }, [gpsResult, rawPayload]);
  // BUGFIX ("for GPS it is getting wrong data"): being NEAR the route isn't
  // being ON the train. The phone's position along the route must also
  // match where the live feed says the train is; until it does, the screen
  // keeps showing the live (internet) data, never the phone's position.
  const gpsVerdict = useMemo(
    () => (gpsOn && gpsResult && !gpsResult.error ? checkGpsOnTrain(rawPayload, gpsResult) : null),
    [gpsOn, gpsResult, rawPayload],
  );
  const payload = useMemo(
    () => (gpsVerdict && gpsVerdict.ok ? applyGpsOverlay(rawPayload, gpsResult, gpsSpeedKmph) : rawPayload),
    [gpsVerdict, gpsResult, gpsSpeedKmph, rawPayload],
  );
  const gpsNotOnTrainCountRef = useRef(0);

  // REDESIGN (RailYatri-style live position marker): a real countdown to
  // the next WebSocket message — the backend sends a message every 5s
  // once connected (see backend/app.py's _TRACK_POLL_INTERVAL_SECONDS),
  // so this displays that real send cadence rather than an invented
  // number, resetting to 5 every time a payload actually arrives
  // (lastUpdated changes) and ticking down once a second in between.
  //
  // CLARIFICATION (see the BUGFIX in formatAsOfAgo above and in backend
  // app.py's ws_track_train): a message arriving every 5s is the
  // connection's heartbeat, NOT proof the underlying live position data
  // itself changed — most of those messages re-serve the same
  // still-cached data. This countdown is genuinely accurate as "next
  // check-in", but the "As of X ago" label next to it (statusUpdatedAt,
  // not this) is the one that reports real DATA freshness, guaranteed
  // <=60s by the backend. Don't read this 5s number as the data's actual
  // refresh rate.
  const [refreshCountdown, setRefreshCountdown] = useState(5);
  useEffect(() => {
    if (!lastUpdated) return undefined;
    setRefreshCountdown(5);
    const id = setInterval(() => setRefreshCountdown((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  // REDESIGN (RailYatri-style "Report Inaccuracy") — reuses the SAME real
  // /api/feedback endpoint (and status_response_id the backend already
  // attaches to every /ws/track payload) the native app's status popup
  // already calls, so this is real feedback wired to a real endpoint, not
  // a decorative button.
  const [reportState, setReportState] = useState("idle"); // idle | sending | sent
  const reportInaccuracy = useCallback(async (responseId) => {
    if (!responseId) return;
    setReportState("sending");
    try {
      await sendFeedback(apiBaseUrl, {
        responseId, rating: "down",
        reason: "Reported inaccurate from web Live Tracking position marker",
      });
      setReportState("sent");
    } catch (e) {
      setReportState("idle");
    }
  }, [apiBaseUrl]);
  // A "Reported — thanks" state should only last until the train actually
  // moves on to a new current station — otherwise it wrongly looks like
  // the NEXT station's position was also reported, once the train reaches
  // it minutes/hours later.
  useEffect(() => {
    setReportState("idle");
  }, [payload?.current_station]);
  const [refreshing, setRefreshing] = useState(false);
  const wsRef = useRef(null);
  // Background-tracking status line under the Start/Stop buttons.
  const [bgTracking, setBgTracking] = useState(null); // null | {state:"pending"|"on"|"off", reason?}

  // BUGFIX: auto-reconnect so the timeline/marker keep updating on their
  // own once tracking has started, instead of going stale the moment the
  // socket drops (network blip, phone screen lock, tab backgrounded, the
  // free-tier host recycling the connection) and requiring the user to tap
  // "Reconnect" again by hand. manualStopRef distinguishes a real user
  // action (the "Stop" button, or navigating away) from an unexpected
  // close — only an unexpected close schedules a retry. activeParamsRef
  // freezes the train/date/source/dest actually being tracked at the
  // moment "Start tracking" was pressed, so a retry always reconnects to
  // THAT train even if the input fields above have since been edited
  // (they aren't re-submitted until the user presses Start again).
  const manualStopRef = useRef(true);
  const activeParamsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  // BUGFIX ("Coordinates / Position source frozen on a station the train
  // already left, 9 km to next station never ticking down to 7.5 km etc,
  // even though the backend genuinely pushes a fresh position every 5s and
  // the plain web frontend for the SAME train updates fine) — see the
  // watchdog effect below for the real mechanism. Tracks when the last
  // real WS message actually arrived, independent of React state, so the
  // watchdog can check it on its own timer without re-subscribing.
  const lastMessageAtRef = useRef(0);
  const reconnectDelayRef = useRef(1000);
  // RailYatri-style collapsed "+N No-Halt stations" groups — which ones the
  // user has tapped open, keyed by index within timelineGrouped below.
  const [expandedGroups, setExpandedGroups] = useState({});

  // FEATURE: "Train on map" toggle — see the module-level comment above
  // loadLeaflet() for why a real Leaflet map is possible here despite
  // react-native-maps having no web target.
  const [showMap, setShowMap] = useState(false);
  // Live-status bubble on the train icon: hidden until the icon is tapped.
  const [calloutOpen, setCalloutOpen] = useState(false);
  const toggleCallout = useCallback(() => setCalloutOpen((v) => !v), []);
  const [mapError, setMapError] = useState(null);
  const mapContainerRef = useRef(null);
  const leafletMapRef = useRef(null);
  const routeLayerRef = useRef(null);
  const trainMarkerRef = useRef(null);
  const trainMarkerLatLngRef = useRef(null);
  const routeBoundsFitRef = useRef(false);
  // Which train "Reconnect"/"Start tracking" last connected to — lets
  // connect() tell a same-train reconnect (socket dropped, user tapped
  // Reconnect for the SAME train) apart from actually switching to a
  // different train. See the same-train guard in connect() below.
  const lastConnectedTrainRef = useRef(null);
  // FEATURE: auto-scroll straight down to where the train currently is the
  // first time real tracking data arrives for a train, instead of leaving
  // the connect form at the top and making the user scroll down manually.
  // Prefers the current-station row inside "Running status" (most
  // specific — e.g. train 20708 lands right on its actual current
  // station), falling back to the quick bar only if that row genuinely
  // isn't in the DOM yet. See scrollToLivePositionOnce() below — a SINGLE
  // scrollIntoView call, not two competing ones (an earlier version fired
  // both back to back, which didn't reliably land on the current row).
  const quickBarRef = useRef(null);
  const currentStationRowRef = useRef(null);
  // Fallback scroll target for a train with no is-current row at all (see
  // ltJourneyLikelyComplete below) — the timeline's own last row.
  const lastStationRowRef = useRef(null);
  const autoScrolledRef = useRef(false);

  // FEATURE: Live delay-trend sparkline — shown as compact text on this
  // already text-only fallback screen, rather than a canvas/SVG chart.
  const [delaySparkline, setDelaySparkline] = useState([]);

  // REDESIGN (RailYatri-style): the raw coordinate/speed/weather stat rows
  // are now tucked behind a "More details" toggle so the headline quick bar
  // + stop timeline are what's visible by default, matching the web
  // frontend's own declutter (see frontend/index.html's lt-section).
  const [showMoreStats, setShowMoreStats] = useState(false);

  // FEATURE: End-of-Trip Summary Card (shareable).
  const tripSummaryShownKeyRef = useRef(null);
  const [tripSummary, setTripSummary] = useState(null);
  const [tripSummaryShareBusy, setTripSummaryShareBusy] = useState(false);
  const [tripSummaryShareStatus, setTripSummaryShareStatus] = useState(null);

  const [shareLinkNote, setShareLinkNote] = useState(null);

  // FEATURE: per-station Delay Alerts — a bell on every upcoming reporting
  // station in "Running status". Tapping it opens DelayAlertModal for THAT
  // station; the watch is saved as (train, date, label=station code), which
  // the backend's _predict_for_watch_station resolves to that exact stop.
  // Train number + date come from the "Track a train" form above; a blank
  // date is pinned to today's real date at arming time (see
  // effectiveTrackDate) so an overnight run never silently switches to the
  // next day's run after midnight.
  //
  // BUGFIX ("arming a bell on train A hid/disabled the bells on train B"):
  // bell state used to be read off the "Track a train" INPUT FIELDS and a
  // single screen-wide busy/status flag, and armed watches were keyed by
  // station code alone. So once a bell was tapped on one train, switching
  // to another train could show that train's bells as armed/blocked or its
  // alert sheet stuck on "Saving…" (the first train's save — push-token +
  // backend sync, often slow on a cold start — was still in flight). Now:
  //   - activeTrack pins the train + date actually being TRACKED (set on
  //     "Start tracking"), independent of whatever is typed in the form;
  //   - every armed-watch map, busy flag and status message is keyed by
  //     "train|date" (and station), so one train can never affect another.
  const [activeTrack, setActiveTrack] = useState(null); // { trainNumber, date } | null
  const activeTrackKey = activeTrack ? `${activeTrack.trainNumber}|${activeTrack.date}` : null;
  const [delayModalStation, setDelayModalStation] = useState(null); // { code, name, trainNumber, date } | null
  const [stationWatchesState, setStationWatchesState] = useState({ key: null, map: {} }); // map: CODE -> { threshold, repeatMinutes }
  // Only ever expose the armed-watch map for the train currently tracked.
  const stationWatches = stationWatchesState.key && stationWatchesState.key === activeTrackKey ? stationWatchesState.map : {};
  const [delayWatchBusyKey, setDelayWatchBusyKey] = useState(null); // "train|date|CODE" of the save in flight
  const [delayWatchStatusState, setDelayWatchStatusState] = useState(null); // { key, ok, message } | null
  const delayModalKey = delayModalStation ? `${delayModalStation.trainNumber}|${delayModalStation.date}|${delayModalStation.code}` : null;
  const delayWatchBusy = !!delayModalKey && delayWatchBusyKey === delayModalKey;
  const delayWatchStatus = delayWatchStatusState && delayWatchStatusState.key === delayModalKey ? delayWatchStatusState : null;
  const reloadWatchesSeqRef = useRef(0);
  // FEATURE: bell auto-off + "arriving in ~10 min" notices shown in-app.
  const [bellNotice, setBellNotice] = useState(null);
  const [approachNotice, setApproachNotice] = useState(null); // { code, name, minutes, eta }
  const approachFiredRef = useRef({});
  // Collapses the "Track a train" form into a compact RailYatri-style
  // header once a train is being tracked (tap "Change" to edit).
  const [formOpen, setFormOpen] = useState(true);
  // FEATURE: "notify me every 10 / 20 / 30 / custom min" for the tracked
  // train — the live position + prediction as a notification at the
  // user's own interval, app open or closed (0 = off).
  // FEATURE: "Read notifications aloud" checkbox (off by default).
  const [readAloud, setReadAloud] = useState(() => loadReadAloud());
  const readAloudRef = useRef(readAloud);
  useEffect(() => { readAloudRef.current = readAloud; }, [readAloud]);
  useEffect(() => onTrainPush((m) => {
    if (!readAloudRef.current || !shouldSpeakPush(m)) return;
    speak([m.title, m.body].filter(Boolean).join(". "));
  }), []);
  const toggleReadAloud = useCallback(() => {
    setReadAloud((on) => {
      const next = !on;
      saveReadAloud(next);
      // Speaking once from the tap itself also unlocks speech on mobile.
      if (next) speak("Read aloud is on. Train notifications and delay alerts will be read out.");
      else if (isSpeechSupported()) window.speechSynthesis.cancel();
      return next;
    });
  }, []);
  const [statusEvery, setStatusEvery] = useState(10);
  const statusEveryRef = useRef(10);
  const [statusEveryCustomOpen, setStatusEveryCustomOpen] = useState(false);
  const [statusEveryCustomText, setStatusEveryCustomText] = useState("");
  useEffect(() => {
    loadStatusEvery().then((n) => { statusEveryRef.current = n; setStatusEvery(n); });
  }, []);
  const datePickForHeaderRef = useRef(false);

  // FEATURE: Smart Alarm — same station-arrival wake-up as
  // MoreToolsScreen.js's SmartAlarmTool / the native TrackedTrainCard.js,
  // now right on this screen, with the quick-pick + Custom (H:MM for 1hr+)
  // lead-time UX.
  const [alarmStation, setAlarmStation] = useState("");
  const [alarmLeadMinutes, setAlarmLeadMinutes] = useState("20");
  const [alarmCustomOpen, setAlarmCustomOpen] = useState(false);
  const [alarmCustomText, setAlarmCustomText] = useState("");
  const [alarmBusy, setAlarmBusy] = useState(false);
  const [alarmStatus, setAlarmStatus] = useState(null);
  const [alarmArmed, setAlarmArmed] = useState(false);
  const alarmNotificationIdRef = useRef(null);

  // Reflects already-armed station alerts for the TRACKED train+date back
  // onto the bells (filled icon) instead of always starting fresh. A
  // sequence number drops a slow, stale read for a previous train so it
  // can't overwrite the map for the train now on screen.
  const reloadStationWatches = useCallback(async () => {
    const seq = ++reloadWatchesSeqRef.current;
    if (!activeTrack) { setStationWatchesState({ key: null, map: {} }); return; }
    const key = `${activeTrack.trainNumber}|${activeTrack.date}`;
    const map = {};
    try {
      const raw = await AsyncStorage.getItem(ALERTS_KEY);
      const existing = raw ? JSON.parse(raw) : [];
      existing.forEach((w) => {
        if (String(w.trainNumber) === activeTrack.trainNumber && (w.date || null) === activeTrack.date && w.label) {
          map[String(w.label).toUpperCase()] = { threshold: w.threshold, repeatMinutes: w.repeatMinutes };
        }
      });
    } catch (e) { /* fall through with an empty map */ }
    if (seq !== reloadWatchesSeqRef.current) return;
    setStationWatchesState({ key, map });
  }, [activeTrack]);
  useEffect(() => { reloadStationWatches(); }, [reloadStationWatches]);
  const reloadStationWatchesRef = useRef(null);
  useEffect(() => { reloadStationWatchesRef.current = reloadStationWatches; }, [reloadStationWatches]);

  // Switching to a different tracked train closes any alert sheet still
  // open for the previous one.
  useEffect(() => { setDelayModalStation(null); }, [activeTrackKey]);

  // Gets a usable push token — reuses whatever's already cached from
  // either this screen or MoreToolsScreen's own "Enable Background Push"
  // flow, or registers a fresh one on demand. Never throws; returns
  // { token: null, reason } on any failure so callers can show why.
  const getOrCreatePushToken = useCallback(async () => {
    const cached = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    if (cached) return { token: cached };
    const { token, platform, reason } = await registerForPushNotifications();
    if (!token) return { token: null, reason };
    try { await registerPushToken(apiBaseUrl, token, platform); } catch (e) { /* best-effort; caller's own sync call still tries */ }
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
    return { token, platform };
  }, [apiBaseUrl]);

  // BUGFIX (alerts for other trains stopped arriving): once push was on,
  // the cached token was reused forever — but browsers rotate push tokens,
  // and the server deletes every watch tied to a token that stops working.
  // On each page load (only if notifications are already allowed — no
  // prompt), fetch the CURRENT token, re-register it and re-sync the whole
  // local watch list, so every armed bell on every train keeps reaching
  // the server. This also re-attaches the in-page handler that shows a
  // push arriving while the app is open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { token, platform } = await refreshWebPushToken();
        if (cancelled || !token) return;
        const cached = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
        try { await registerPushToken(apiBaseUrl, token, platform || "web"); } catch (e) { /* best-effort */ }
        await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
        const raw = await AsyncStorage.getItem(ALERTS_KEY);
        const list = pruneExpiredWatches(raw ? JSON.parse(raw) : []);
        await AsyncStorage.setItem(ALERTS_KEY, JSON.stringify(list));
        if (list.length || (cached && cached !== token)) {
          const res = await syncPushWatches(apiBaseUrl, token, list);
          const kept = dropRetiredWatches(list, res && res.retired);
          if (kept.length !== list.length) {
            await AsyncStorage.setItem(ALERTS_KEY, JSON.stringify(kept));
            if (!cancelled) reloadStationWatchesRef.current && reloadStationWatchesRef.current();
          }
        }
      } catch (e) { /* best-effort — arming a bell still syncs on its own */ }
    })();
    return () => { cancelled = true; };
  }, [apiBaseUrl]);

  // Push-token acquisition on web waits on the service worker becoming
  // active, which can hang indefinitely (blocked/failed SW install). Cap
  // it so a stuck save can never leave the alert sheet on "Saving…".
  const getPushTokenWithTimeout = useCallback(() => Promise.race([
    getOrCreatePushToken(),
    new Promise((resolve) => setTimeout(() => resolve({ token: null, reason: "Timed out enabling push on this device — the alert is saved on this device only." }), 20000)),
  ]), [getOrCreatePushToken]);

  // Reads the FULL local delay-watch list, replaces just this
  // (train, date, station) entry, writes it back and syncs the WHOLE set
  // (syncPushWatches replaces the server's full list for this token, so a
  // single-item sync would wipe every other alert on this device). Also
  // drops any older train-wide (label-less) watch for the same train+date,
  // which no longer has a UI to stop it from. The train + date come from
  // the station object itself (captured when its bell was tapped), never
  // from the form fields, so it always targets the train that bell was on.
  const saveStationWatch = useCallback(async (station, settings) => {
    const num = String(station.trainNumber || "").trim();
    const dateVal = station.date || null;
    const code = String(station.code || station.name || "").toUpperCase();
    const key = `${num}|${dateVal}|${code}`;
    const setStatus = (ok, message) => setDelayWatchStatusState({ key, ok, message });
    if (!num) { setStatus(false, "Start tracking a train first."); return { ok: false }; }
    setDelayWatchBusyKey(key);
    setDelayWatchStatusState((prev) => (prev && prev.key === key ? null : prev));
    try {
      const raw = await AsyncStorage.getItem(ALERTS_KEY);
      const existing = pruneExpiredWatches(raw ? JSON.parse(raw) : []);
      const merged = existing.filter((w) => !(
        String(w.trainNumber) === num
        && (w.date || null) === dateVal
        && (!w.label || String(w.label).toUpperCase() === code)
      ));
      if (settings) {
        merged.push({ trainNumber: num, date: dateVal, label: code, threshold: settings.threshold, repeatMinutes: settings.repeatMinutes });
      }
      await AsyncStorage.setItem(ALERTS_KEY, JSON.stringify(merged));
      await reloadStationWatches();

      const { token, reason } = settings ? await getPushTokenWithTimeout() : { token: await AsyncStorage.getItem(PUSH_TOKEN_KEY) };
      if (!token) {
        if (settings) setStatus(false, reason || "Saved, but background push isn't available on this device/browser.");
        return { ok: true };
      }
      const syncRes = await syncPushWatches(apiBaseUrl, token, merged);
      const kept = dropRetiredWatches(merged, syncRes && syncRes.retired);
      if (kept.length !== merged.length) {
        await AsyncStorage.setItem(ALERTS_KEY, JSON.stringify(kept));
        await reloadStationWatches();
      }
      if (settings) {
        setStatus(true, settings.threshold === 0
          ? `Alert set for ${station.name}: live ETA + delay every ${settings.repeatMinutes} min, and ~10 min before arrival.`
          : `Alert set for ${station.name}: a push every ${settings.repeatMinutes} min while it's predicted ≥ ${settings.threshold} min late.`);
      }
      return { ok: true };
    } catch (e) {
      setStatus(false, describeApiError(e));
      return { ok: false };
    } finally {
      setDelayWatchBusyKey((prev) => (prev === key ? null : prev));
    }
  }, [apiBaseUrl, getPushTokenWithTimeout, reloadStationWatches]);

  const openStationAlert = useCallback((stop) => {
    if (!activeTrack) return;
    setDelayModalStation({
      code: (stop.code || "").toUpperCase(),
      name: toDisplayCase(stop.name || stop.code || ""),
      trainNumber: activeTrack.trainNumber,
      date: activeTrack.date,
    });
  }, [activeTrack]);

  const confirmDelayAlert = useCallback((thresholdVal, repeatVal) => {
    if (!delayModalStation) return;
    const target = delayModalStation;
    saveStationWatch(target, { threshold: thresholdVal, repeatMinutes: repeatVal }).then((result) => {
      // Only close the sheet if it's still showing the station just saved
      // (the user may have moved on to another station/train meanwhile).
      // On failure the sheet stays open showing the error.
      if (result && result.ok) {
        setDelayModalStation((cur) => (cur && cur.code === target.code && cur.trainNumber === target.trainNumber && cur.date === target.date ? null : cur));
      }
    });
  }, [delayModalStation, saveStationWatch]);

  const setSmartAlarm = useCallback(async () => {
    const num = trainNumber.trim();
    const station = alarmStation.trim().toUpperCase();
    if (!num || !station) { setAlarmStatus("Enter a destination station code."); return; }
    const leadMinutes = alarmCustomOpen ? parseLeadMinutesInput(alarmCustomText) : parseInt(alarmLeadMinutes, 10);
    if (!leadMinutes) { setAlarmStatus("Enter a valid time — minutes, or H:MM for 1hr+ (e.g. 1:30 = 1hr 30min)."); return; }
    setAlarmBusy(true);
    setAlarmStatus("Checking live prediction…");
    try {
      const data = await checkSmartAlarm(apiBaseUrl, { trainNumber: num, destinationStation: station, date: trackDate.trim() || null, leadMinutes });
      if (!data.found) { setAlarmStatus(data.note || "Couldn't check this station."); return; }
      if (data.already_passed) { setAlarmStatus(`Train has already reached ${station}.`); return; }
      if (data.minutes_remaining == null) { setAlarmStatus("No live ETA available yet — try again shortly."); return; }
      const fireInSeconds = (data.minutes_remaining - leadMinutes) * 60;
      const body = `Train ${num} is due at ${station} soon${data.delay_minutes ? ` (running ${formatDelayDuration(data.delay_minutes)} late)` : ""}. Time to head out!`;
      if (fireInSeconds <= 0) {
        await scheduleLocalAlarm(`⏰ Smart Alarm — ${station}`, body, 1);
        setAlarmStatus(`Already within your window — notified now. Train due in ~${data.minutes_remaining} min.`);
        return;
      }
      const id = await scheduleLocalAlarm(`⏰ Smart Alarm — ${station}`, body, fireInSeconds);
      alarmNotificationIdRef.current = id;
      setAlarmArmed(true);

      // Background-surviving registration, on by default — same
      // "read existing, merge, write back the full set" pattern
      // TrackedTrainCard.js (native) already uses for this exact endpoint,
      // so arming an alarm here never clobbers a sibling alarm armed
      // elsewhere on the same device.
      const { token, reason } = await getOrCreatePushToken();
      if (token) {
        try {
          const existing = (await getAlarmWatches(apiBaseUrl, token)).watches || [];
          const merged = existing.filter((w) => !(String(w.train_number) === num && w.station === station));
          merged.push({ train_number: num, station, date: trackDate.trim() || null, lead_minutes: leadMinutes });
          await syncAlarmWatches(apiBaseUrl, token, merged.map((w) => ({
            trainNumber: w.trainNumber ?? w.train_number, station: w.station, date: w.date, leadMinutes: w.leadMinutes ?? w.lead_minutes,
          })));
          setAlarmStatus(`Armed for ${station}, ~${leadMinutes} min lead — rings even if you close the app, and registered server-side too.`);
        } catch (e) {
          setAlarmStatus(`Armed for ${station} on this device — couldn't also register server-side (${describeApiError(e)}).`);
        }
      } else {
        setAlarmStatus(`Armed for ${station}, ~${leadMinutes} min lead — rings even if you close the app.${reason ? ` (Server-side backup unavailable: ${reason})` : ""}`);
      }
    } catch (e) {
      setAlarmStatus(describeApiError(e));
    } finally {
      setAlarmBusy(false);
    }
  }, [apiBaseUrl, trainNumber, trackDate, alarmStation, alarmLeadMinutes, alarmCustomOpen, alarmCustomText, getOrCreatePushToken]);

  const cancelSmartAlarm = useCallback(async () => {
    await cancelLocalAlarm(alarmNotificationIdRef.current);
    alarmNotificationIdRef.current = null;
    setAlarmArmed(false);
    setAlarmStatus("Alarm cancelled.");
    try {
      const num = trainNumber.trim();
      const station = alarmStation.trim().toUpperCase();
      const token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
      if (token && station) {
        const existing = (await getAlarmWatches(apiBaseUrl, token)).watches || [];
        const merged = existing.filter((w) => !(String(w.train_number) === num && w.station === station));
        await syncAlarmWatches(apiBaseUrl, token, merged.map((w) => ({
          trainNumber: w.trainNumber ?? w.train_number, station: w.station, date: w.date, leadMinutes: w.leadMinutes ?? w.lead_minutes,
        })));
      }
    } catch (e) { /* best-effort — the local alarm is already cancelled either way */ }
  }, [apiBaseUrl, trainNumber, alarmStation]);

  const shareTrackingLink = useCallback(() => {
    if (!trainNumber.trim()) return;
    const url = buildTrackShareUrl(apiBaseUrl, trainNumber.trim(), trackDate.trim() || null);
    setShareLinkNote(isPrivateOrLocalHost(apiBaseUrl) ? LOCAL_SHARE_WARNING : null);
    Share.share({ message: `Track train ${trainNumber.trim()} live: ${url}`, url }).catch(() => {
      Linking.openURL(url).catch(() => {});
    });
  }, [apiBaseUrl, trainNumber, trackDate]);

  const shareTripSummary = useCallback(async () => {
    if (!tripSummary) return;
    setTripSummaryShareBusy(true);
    setTripSummaryShareStatus(null);
    try {
      const res = await saveTripSummary(apiBaseUrl, { trainNumber: tripSummary.train_number, date: tripSummary.date, summary: tripSummary });
      const url = buildTripShareUrl(apiBaseUrl, res.share_id);
      await Share.share({ message: `My trip on train ${tripSummary.train_number}: ${url}`, url });
      setTripSummaryShareStatus(isPrivateOrLocalHost(apiBaseUrl) ? `Link ready: ${url}\n${LOCAL_SHARE_WARNING}` : `Link ready: ${url}`);
    } catch (e) {
      setTripSummaryShareStatus("Couldn't create a shareable link right now.");
    } finally {
      setTripSummaryShareBusy(false);
    }
  }, [apiBaseUrl, tripSummary]);

  const disconnect = useCallback(() => {
    manualStopRef.current = true;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    setConnection("idle");
  }, []);

  const toggleMap = useCallback(() => setShowMap((prev) => !prev), []);

  function initMapIfNeeded() {
    if (leafletMapRef.current || !mapContainerRef.current || typeof window === "undefined" || !window.L) return;
    const L = window.L;
    // dragging: false — same reasoning as the web frontend's live-tracking
    // map: this map should stay static, and Leaflet only shows its
    // grab/grabbing "move" cursor while dragging is enabled, so turning it
    // off removes that cursor everywhere on the map (including over the
    // train icon) without touching zoom (buttons/pinch/double-tap).
    leafletMapRef.current = L.map(mapContainerRef.current, { scrollWheelZoom: false, dragging: false }).setView([22.5, 79], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 18,
    }).addTo(leafletMapRef.current);
  }

  // Load Leaflet (once) the first time the map is revealed, then init the
  // map instance and nudge it to size correctly (it was created — or is
  // being re-shown — against a container that may have been zero-height a
  // moment ago, same invalidateSize()-on-reveal pattern the web frontend
  // uses for its own toggle).
  useEffect(() => {
    if (!showMap) return;
    let cancelled = false;
    loadLeaflet()
      .then(() => {
        if (cancelled) return;
        setMapError(null);
        requestAnimationFrame(() => {
          initMapIfNeeded();
          leafletMapRef.current?.invalidateSize();
        });
      })
      .catch((e) => {
        if (!cancelled) setMapError(e.message || "Couldn't load the map library.");
      });
    return () => {
      cancelled = true;
    };
  }, [showMap]);

  // Redraw the route (polyline + per-station dots) whenever the timeline
  // changes, same shape/coloring as the web frontend's drawLiveTrackRoute.
  useEffect(() => {
    if (!showMap || !leafletMapRef.current || typeof window === "undefined" || !window.L) return;
    const L = window.L;
    const points = (payload?.timeline || []).filter((s) => s.lat != null && s.lng != null);
    if (routeLayerRef.current) {
      leafletMapRef.current.removeLayer(routeLayerRef.current);
      routeLayerRef.current = null;
    }
    if (points.length < 2) return;
    const layer = L.layerGroup();
    L.polyline(points.map((s) => [s.lat, s.lng]), { color: "#16324F", weight: 3 }).addTo(layer);
    points.forEach((s) => {
      const color = s.status === "passed" ? "#2E8B57" : s.status === "current" ? "#C1272D" : "#8a93a1";
      L.circleMarker([s.lat, s.lng], {
        radius: s.kind === "intermediate" ? 3 : 5,
        color, fillColor: color, fillOpacity: 1, weight: 1,
      }).bindTooltip(`${s.name} (${s.code})`).addTo(layer);
    });
    layer.addTo(leafletMapRef.current);
    routeLayerRef.current = layer;
    if (!routeBoundsFitRef.current) {
      leafletMapRef.current.fitBounds(points.map((s) => [s.lat, s.lng]), { padding: [30, 30] });
      routeBoundsFitRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMap, JSON.stringify(payload?.timeline || [])]);

  // Move (or create) the live train-position marker — falls back to the
  // last passed/current station's own coordinate when the live fix is
  // momentarily unavailable, same honesty rule the web frontend uses.
  useEffect(() => {
    if (!showMap || !leafletMapRef.current || typeof window === "undefined" || !window.L) return;
    const L = window.L;
    let lat = payload?.lat, lng = payload?.lng;
    if ((lat == null || lng == null) && Array.isArray(payload?.timeline)) {
      const passedWithFix = payload.timeline.filter((s) => s.lat != null && (s.status === "passed" || s.status === "current"));
      const last = passedWithFix[passedWithFix.length - 1];
      if (last) { lat = last.lat; lng = last.lng; }
    }
    // BUGFIX: once the journey looks likely complete (see
    // computeJourneyLikelyComplete near the top of this file), the live
    // fix above still reflects wherever the provider's position got stuck
    // — for train 20707 that stayed SECUNDERABAD JN, the origin, for 9+
    // hours after the train had actually finished at VISAKHAPATNAM. Snap
    // the marker to the real last-known (destination) station instead, so
    // it isn't left sitting somewhere the train demonstrably isn't
    // anymore — same reasoning as the quick bar's "Last known" fallback.
    const timelineForMarker = Array.isArray(payload?.timeline) ? payload.timeline : [];
    const lastStopForMarker = timelineForMarker.length ? timelineForMarker[timelineForMarker.length - 1] : null;
    if (computeJourneyLikelyComplete(timelineForMarker, lastStopForMarker) && lastStopForMarker?.lat != null && lastStopForMarker?.lng != null) {
      lat = lastStopForMarker.lat;
      lng = lastStopForMarker.lng;
    }
    if (lat == null || lng == null) return;
    if (!trainMarkerRef.current) {
      const icon = L.icon({
        iconUrl: TRAIN_ICON_URL, iconSize: [26, 19], iconAnchor: [13, 9.5], popupAnchor: [0, -9],
        className: "train-marker-icon",
      });
      trainMarkerRef.current = L.marker([lat, lng], { icon }).addTo(leafletMapRef.current);
      trainMarkerLatLngRef.current = [lat, lng];
    } else {
      // 2D-animated glide from the last real fix to this one — see
      // animateMarkerTo() near the top of this file.
      animateMarkerTo(trainMarkerRef.current, trainMarkerLatLngRef.current, [lat, lng], 4000);
      trainMarkerLatLngRef.current = [lat, lng];
    }
    // autoPan: false — Leaflet's default popup behaviour pans the whole
    // map to fit the popup on open, which made tapping the train icon
    // itself look like the map "moved" even though the train's actual
    // position hadn't changed. Tapping the icon should only show its
    // popup, never move the view.
    trainMarkerRef.current.bindPopup(
      `Train ${payload?.train_number || trainNumber}${payload?.current_station ? `<br>${payload.current_station}` : ""}`,
      { autoPan: false }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMap, payload?.lat, payload?.lng, payload?.current_station, payload?.train_number, JSON.stringify(payload?.timeline || [])]);

  // Fires once per train (see the autoScrolledRef reset in connect()).
  // Exactly ONE scrollIntoView call, preferring the current-station row
  // inside "Running status" (currentStationRowRef, wired up via
  // TimelineStopRow's rowRef prop below) — no quick-bar fallback (an
  // earlier version raced a quick-bar scroll against this one, which per
  // user report didn't reliably land on the current row). Falls back to
  // the timeline's own LAST row (lastStationRowRef) for a train the
  // provider never flips a "current" pointer to at all — most often its
  // own destination, once genuinely reached (see ltJourneyLikelyComplete
  // above) — so the view still lands on where the train actually ended
  // up. If NEITHER ref exists yet on a given payload, the flag stays
  // false and this retries on the next one. Both refs are <View ref>s
  // which, on this web build, forward straight to the underlying DOM
  // node — same ref-is-a-div pattern this file already relies on for the
  // Leaflet map container.
  useEffect(() => {
    if (!payload || autoScrolledRef.current) return;
    const target = currentStationRowRef.current || lastStationRowRef.current;
    if (!target) return;
    autoScrolledRef.current = true;
    requestAnimationFrame(() => {
      target.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
  }, [payload]);

  const refreshNow = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setRefreshing(true);
      wsRef.current.send(JSON.stringify({ type: "refresh" }));
    } else if (activeParamsRef.current && !manualStopRef.current) {
      openSocket(activeParamsRef.current, true); // eslint-disable-line no-use-before-define
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      disconnect();
    };
  }, [disconnect]);

  // BUGFIX ("Coordinates: —, Position source: unavailable" frozen on a
  // station the train already left, "9 km to next station" never ticking
  // down — reported live against train 20833, confirmed via the backend's
  // own /api/train/live-status and /api/advanced/live-position-debug that
  // the SAME train's data was genuinely fresh and resolving fine the whole
  // time, and that the plain web frontend for the SAME train was updating
  // normally): the existing auto-reconnect above (openSocket's onclose
  // handler) only ever fires when the browser/OS actually tells this page
  // the socket closed. On a phone, locking the screen or backgrounding the
  // browser tab very commonly suspends the network stack WITHOUT ever
  // firing that close event — the WebSocket object just sits there
  // "open" (readyState-wise) forever, silently not receiving the fresh
  // position the backend is genuinely still pushing every ~5s. No close
  // event ever arrives, so the existing reconnect logic never even
  // triggers, and the UI freezes on whatever the last real message was
  // — permanently, since nothing here was watching for THAT failure mode.
  //
  // Two independent, real signals — neither a guess about why the
  // connection died, just "is it actually still delivering":
  //   1. A watchdog timer: if nominally open but no message has arrived
  //      in several multiples of the backend's real ~5s push cadence, the
  //      connection is dead in practice. Force-closing it hands off to the
  //      existing onclose auto-reconnect already above, so there's still
  //      only one reconnect code path.
  //   2. The page becoming visible again (phone unlocked, tab
  //      foregrounded) — the single most common real moment a mobile
  //      browser's suspended socket needs replacing — checked immediately
  //      instead of waiting out the watchdog's own poll interval.
  // FEATURE ("if I exit the app or jump into another app and come back, it
  // should NOT lag to reconnect — within 1 sec it should be back on the
  // live position"): the moment the page is visible / focused / back from
  // the bfcache / back online, a socket that isn't OPEN, or is nominally
  // open but silent for more than ~2 server pushes, is replaced
  // IMMEDIATELY (no backoff); a healthy one is just asked for a fresh push
  // right now. The screen keeps showing the last live position meanwhile
  // (never a "Connecting…" blank), and the server replies to a new socket
  // with its latest snapshot instantly.
  useEffect(() => {
    const STALE_MS = 12000; // > 2x the backend's real 5s push cadence
    const watchdog = setInterval(() => {
      if (manualStopRef.current || !wsRef.current) return;
      if (wsRef.current.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMessageAtRef.current > STALE_MS) {
        openSocket(activeParamsRef.current, true);
      }
    }, 4000);

    function resumeNow() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (manualStopRef.current || !activeParamsRef.current) return;
      const ws = wsRef.current;
      const quietFor = Date.now() - lastMessageAtRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING || quietFor > 7000) {
        if (reconnectTimeoutRef.current) { clearTimeout(reconnectTimeoutRef.current); reconnectTimeoutRef.current = null; }
        reconnectDelayRef.current = 1000;
        openSocket(activeParamsRef.current, true);
      } else if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "refresh" })); } catch (e) { /* ignore */ }
      }
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", resumeNow);
    if (typeof window !== "undefined") {
      window.addEventListener("focus", resumeNow);
      window.addEventListener("pageshow", resumeNow);
      window.addEventListener("online", resumeNow);
    }

    return () => {
      clearInterval(watchdog);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", resumeNow);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", resumeNow);
        window.removeEventListener("pageshow", resumeNow);
        window.removeEventListener("online", resumeNow);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Does the actual work of opening the WebSocket for a fixed set of
  // params (captured once in activeParamsRef when the user presses "Start
  // tracking" / "Reconnect"). Called directly by the button, and again by
  // itself — via a timer — on an unexpected disconnect, so the train icon
  // and timeline keep updating on their own without the user having to
  // tap anything. `isRetry` skips the parts of setup that should only
  // happen on a genuine user-initiated (re)start (clearing old payload/
  // stats so the screen doesn't flash empty on a brief, automatic blip).
  function openSocket(params, isRetry) {
    if (!params || !params.trainNumber) return;
    // Reconnecting to the SAME train (socket dropped, auto-retry, or the
    // user tapped "Reconnect") must not be treated as switching trains —
    // wiping the marker/route/fitBounds state here made the map visibly
    // jump/re-fit to a new pan+zoom on every reconnect instead of just
    // letting the marker glide onto its next real position on a static map.
    const connectKey = `${params.trainNumber}|${effectiveTrackDate(params.date)}`;
    const isSameTrainReconnect = connectKey === lastConnectedTrainRef.current;
    const old = wsRef.current;
    wsRef.current = null;
    if (old) {
      // Detach first so the old socket's late onclose can't schedule a
      // second, competing reconnect.
      old.onclose = null; old.onmessage = null; old.onerror = null;
      try { old.close(); } catch (e) { /* ignore */ }
    }
    setConnection("connecting");
    if (!isRetry && !isSameTrainReconnect) {
      // Switching trains: drop the old train's screen, then paint this
      // train's last known live status from the device INSTANTLY (no blank
      // "connecting" screen) while the live feed catches up.
      setPayload(null);
      setDelaySparkline([]);
      tripSummaryShownKeyRef.current = null;
      setTripSummary(null);
      setTripSummaryShareStatus(null);
      const wantTrain = params.trainNumber;
      loadLastPayload(wantTrain, params.date).then((cached) => {
        if (!cached || String(cached.train_number || wantTrain) !== String(wantTrain)) return;
        if (!activeParamsRef.current || activeParamsRef.current.trainNumber !== wantTrain) return;
        setPayload((prev) => prev || { ...cached, from_device_cache: true });
      });
    }

    if (!isSameTrainReconnect) {
      // A stale route/marker from a PREVIOUSLY tracked train would be
      // actively misleading pinned to the new train's map.
      if (leafletMapRef.current) {
        if (routeLayerRef.current) { leafletMapRef.current.removeLayer(routeLayerRef.current); routeLayerRef.current = null; }
        if (trainMarkerRef.current) { leafletMapRef.current.removeLayer(trainMarkerRef.current); trainMarkerRef.current = null; }
      }
      if (liveMarkerAnimFrame) {
        cancelAnimationFrame(liveMarkerAnimFrame);
        liveMarkerAnimFrame = null;
      }
      trainMarkerLatLngRef.current = null;
      routeBoundsFitRef.current = false;
      autoScrolledRef.current = false;
    }
    lastConnectedTrainRef.current = connectKey;

    const url = buildTrackingWsUrl(wsBaseUrl, params.trainNumber, {
      date: params.date || undefined,
      source: params.source || undefined,
      dest: params.dest || undefined,
    });

    // Stamped now, not just on the first real message — otherwise the
    // watchdog below could see a "last message" from a previous connection
    // that's several STALE_MS old and immediately kill this brand-new
    // socket before it even gets a chance to open.
    lastMessageAtRef.current = Date.now();

    const socket = new WebSocket(url);
    wsRef.current = socket;
    socket.onopen = () => {
      setConnection("open");
      // A successful connection means whatever went wrong last time is
      // over — back off from scratch next time, instead of the delay
      // staying stretched out from an earlier stretch of bad connectivity.
      reconnectDelayRef.current = 1000;
      lastMessageAtRef.current = Date.now();
    };
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        lastMessageAtRef.current = Date.now();
        if (data.snapshot) {
          // Server's own last-known payload, sent the instant the socket
          // opens — shown only if nothing fresher is already on screen.
          setPayload((prev) => (!prev || prev.from_device_cache || prev.snapshot ? data : prev));
          return;
        }
        if (!data.timeline || !data.timeline.length) {
          // A frame without a timeline (provider hiccup) must never blank a
          // screen that's already showing this train's live position.
          setPayload((prev) => (prev && prev.timeline && prev.timeline.length
            && String(prev.train_number) === String(data.train_number) ? { ...prev, error: data.error } : data));
          setRefreshing(false);
          return;
        }
        if (data.quick_frame && !data.provider_note) {
          // Fast RailRadar/RapidAPI first frame: fills an empty/cached screen
          // at once, but never replaces a fuller live frame that's recent.
          setPayload((prev) => {
            if (!prev || prev.from_device_cache || prev.snapshot || prev.quick_frame) return data;
            const age = prev.status_updated_at ? Date.now() - new Date(prev.status_updated_at).getTime() : Infinity;
            return age > 90000 ? data : prev;
          });
          setLastUpdated(new Date());
          return;
        }
        setPayload(data);
        if (data.timeline && data.timeline.length && !data.error
            && Date.now() - lastPayloadSavedAtRef.current > LAST_PAYLOAD_SAVE_EVERY_MS) {
          lastPayloadSavedAtRef.current = Date.now();
          saveLastPayload(params.trainNumber, params.date, data);
        }

        // FEATURE: Live delay-trend sparkline.
        const sparkValue = data.predicted_delay_minutes != null ? data.predicted_delay_minutes : data.delay_minutes;
        if (sparkValue != null) {
          setDelaySparkline((prev) => {
            const next = [...prev, sparkValue];
            return next.length > SPARKLINE_MAX_POINTS ? next.slice(next.length - SPARKLINE_MAX_POINTS) : next;
          });
        }

        // FEATURE: End-of-Trip Summary Card — only once a real actual
        // arrival is recorded at the destination.
        if (data.destination_actual_arrival) {
          const key = `${data.train_number}|${data.date || ""}`;
          if (tripSummaryShownKeyRef.current !== key) {
            const stoppages = (data.timeline || []).filter((s) => s.kind !== "intermediate");
            if (stoppages.length >= 2) {
              tripSummaryShownKeyRef.current = key;
              const origin = stoppages[0];
              const destination = stoppages[stoppages.length - 1];
              const delayOf = (s) => {
                if (s.arrival && s.arrival.delay_minutes != null) return s.arrival.delay_minutes;
                if (s.departure && s.departure.delay_minutes != null) return s.departure.delay_minutes;
                return null;
              };
              let worst = null;
              stoppages.forEach((s) => {
                const d = delayOf(s);
                if (d != null && (!worst || d > worst.delay_minutes)) worst = { name: s.name || s.code, delay_minutes: d };
              });
              setTripSummary({
                train_number: data.train_number,
                date: data.date,
                source_station: origin.name || origin.code,
                destination_station: destination.name || destination.code,
                departure: { scheduled: origin.departure && origin.departure.scheduled, delay_minutes: delayOf(origin) },
                arrival: { scheduled: destination.arrival && destination.arrival.scheduled, delay_minutes: delayOf(destination) },
                worst_station: worst,
                total_distance_km: destination.distance_km || null,
                per_station: stoppages.map((s) => ({ name: s.name || s.code, delay_minutes: delayOf(s) || 0 })),
                generated_at: new Date().toISOString(),
              });
            }
          }
        }
        setLastUpdated(new Date());
        setRefreshing(false);
      } catch (e) {
        // ignore malformed frame
      }
    };
    socket.onerror = () => setConnection("error");
    // BUGFIX: auto-reconnect. Any close that wasn't the user pressing
    // "Stop" (manualStopRef) schedules another attempt on the SAME train
    // after a short, backed-off delay — this is what makes the train icon
    // and timeline keep moving on their own as stations are crossed,
    // instead of freezing the moment a connection drops until the user
    // manually taps "Reconnect" again.
    socket.onclose = () => {
      setConnection((c) => (c === "error" ? c : "closed"));
      if (manualStopRef.current) return;
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 1.6, 15000);
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        openSocket(activeParamsRef.current, true);
      }, delay);
    };
  }

  // Button handler — reads whatever's currently in the input fields,
  // freezes it into activeParamsRef for any future auto-reconnect, and
  // (re-)opens the socket for it. A fresh manual start always re-arms
  // auto-reconnect (manualStopRef = false), even after a prior "Stop".
  function connect() {
    if (!trainNumber.trim()) return;
    startTracking({
      trainNumber: trainNumber.trim(),
      date: trackDate.trim(),
      source: source.trim(),
      dest: dest.trim(),
    }, false);
  }

  // FEATURE (RailYatri-style "keeps tracking after you close the app"):
  // shared by the Start button AND the automatic resume on app open.
  //   - remembers the train on the device (auto-resume next launch),
  //   - registers it with the server so a silent running-status push keeps
  //     updating after the app is closed (see services/backgroundTracking.js).
  // fromResume = true never pops a notification-permission prompt.
  function startTracking(params, fromResume) {
    if (!params || !params.trainNumber) return;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectDelayRef.current = 1000;
    manualStopRef.current = false;
    if (activeParamsRef.current && activeParamsRef.current.trainNumber !== params.trainNumber) {
      // GPS mode belongs to the train the user said they're on — a
      // different train starts back on internet.
      setGpsOn(false);
      setModeNotice(null);
      gpsHistoryRef.current = [];
    }
    activeParamsRef.current = params;
    // Pin the bells / delay alerts to THIS train + run date (blank = today,
    // pinned now so it can't drift past midnight) — see activeTrack above.
    const trackedDate = effectiveTrackDate(params.date);
    setFormOpen(false);
    setActiveTrack((prev) => (prev && prev.trainNumber === params.trainNumber && prev.date === trackedDate
      ? prev
      : { trainNumber: params.trainNumber, date: trackedDate }));
    openSocket(params, false);

    // Pin the run date (a blank "today" must not drift to tomorrow's run
    // when the app is reopened after midnight on an overnight journey).
    saveActiveTrack({ ...params, date: params.date || trackedDate });
    setBgTracking({ state: "pending" });
    enableBackgroundTracking(
      apiBaseUrl,
      { trainNumber: params.trainNumber, date: trackedDate, source: params.source, dest: params.dest, intervalMinutes: statusEveryRef.current },
      { prompt: !fromResume },
    ).then((r) => setBgTracking(r.ok ? { state: "on" } : { state: "off", reason: r.reason }));
  }

  // Change "notify me every N min" for the tracked train: saved on this
  // device and sent to the server's tracking watch right away.
  function applyStatusEvery(minutes) {
    const n = Math.max(0, Math.min(720, Math.round(minutes)));
    statusEveryRef.current = n;
    setStatusEvery(n);
    saveStatusEvery(n);
    const params = activeParamsRef.current;
    if (params && params.trainNumber && !manualStopRef.current) {
      setBgTracking({ state: "pending" });
      enableBackgroundTracking(
        apiBaseUrl,
        { trainNumber: params.trainNumber, date: effectiveTrackDate(params.date), source: params.source, dest: params.dest, intervalMinutes: n },
        { prompt: true },
      ).then((r) => setBgTracking(r.ok ? { state: "on" } : { state: "off", reason: r.reason }));
    }
  }

  // "Stop" is the ONLY thing that ends tracking for good — leaving the
  // screen or closing the app keeps it going in the background.
  function stopTracking() {
    const params = activeParamsRef.current;
    setGpsOn(false);
    setModeNotice(null);
    setFormOpen(true);
    disconnect();
    clearActiveTrack();
    setBgTracking(null);
    if (params && params.trainNumber) {
      disableBackgroundTracking(apiBaseUrl, { trainNumber: params.trainNumber, date: effectiveTrackDate(params.date) });
    }
  }

  // FEATURE (fast first display on internet): wake the live data sources
  // as soon as the screen opens, and again for the exact train as soon as
  // a full 5-digit number is typed — by the time "Start tracking" is
  // tapped, RailRadar/RailKit are already answering.
  useEffect(() => { warmupLive(apiBaseUrl); }, [apiBaseUrl]);
  useEffect(() => {
    const t = trainNumber.trim();
    if (/^\d{5}$/.test(t)) warmupLive(apiBaseUrl, t);
  }, [trainNumber, apiBaseUrl]);

  // Auto-resume on app open: reconnect to whatever was being tracked
  // before the app was closed — no re-typing, no pressing Start again.
  useEffect(() => {
    let cancelled = false;
    loadActiveTrack().then((saved) => {
      if (cancelled || !saved || activeParamsRef.current) return;
      const params = {
        trainNumber: saved.trainNumber, date: saved.date || "", source: saved.source || "", dest: saved.dest || "",
      };
      setTrainNumber(params.trainNumber);
      setTrackDate(params.date);
      setSource(params.source);
      setDest(params.dest);
      startTracking(params, true);
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const timeline = payload?.timeline || [];
  // FEATURE: "no current station" fallback — same reasoning as the web
  // frontend's own copy of this logic (see the matching comment in
  // app.js): the provider sometimes never flips a train's FINAL/
  // destination station's status away from "upcoming" even once the
  // train has genuinely reached it, which left payload.next_station
  // pointing at a stale earlier station once tracking had otherwise
  // ended. Falls back to the timeline's own last entry — whatever it
  // truthfully says — labeled honestly as "Last known" instead of a
  // "Next" stop that isn't real.
  const ltLastStop = timeline.length ? timeline[timeline.length - 1] : null;
  const ltJourneyLikelyComplete = computeJourneyLikelyComplete(timeline, ltLastStop);
  const ltEffectiveDelay = ltJourneyLikelyComplete
    ? (ltLastStop.arrival && ltLastStop.arrival.delay_minutes != null
        ? ltLastStop.arrival.delay_minutes
        : (ltLastStop.departure ? ltLastStop.departure.delay_minutes : null))
    : payload?.delay_minutes;

  // REDESIGN (RailYatri-style running status): prefer the backend's own
  // pre-grouped timeline (consecutive non-reporting stations collapsed
  // into a single "+N No-Halt stations" entry — see gps_tracking.py's
  // group_timeline_for_display) — falling back to one "station" entry per
  // flat timeline row (no grouping) if an older/cached payload doesn't
  // have the grouped field yet.
  const timelineGrouped = payload?.timeline_grouped && payload.timeline_grouped.length
    ? payload.timeline_grouped
    : timeline.map((s) => ({ display_type: "station", ...s }));
  let ltLastStationIndex = -1;
  for (let i = timelineGrouped.length - 1; i >= 0; i--) {
    if (timelineGrouped[i].display_type !== "no_halt_group") { ltLastStationIndex = i; break; }
  }
  const journeyStartDate = resolveJourneyStartDate(trackDate, timeline);

  // BUGFIX (train 20833, bell armed on WARANGAL after the trip had ended):
  // RailKit can keep a stop's `status` at "upcoming" long after the train
  // has really been there — RailRadar confirms the arrival first
  // (actual_is_predicted === false) and RailKit never flips it. A bell on
  // such a stop can never fire, so a stop counts as reached (no bell) if
  // it — or ANY later stop — has a real recorded arrival/departure, the
  // same rule the backend's _stop_really_reached applies to alerts.
  // Bells only on a timeline that really belongs to the tracked train —
  // never on a leftover payload from a different train.
  const bellsEnabledForPayload = !!activeTrack
    && (!payload?.train_number || String(payload.train_number).trim() === activeTrack.trainNumber);
  const reallyReachedCodes = (() => {
    // A genuinely recorded arrival can never be in the future: a provider
    // "actual" that is really an ETA (20834: VISAKHAPATNAM "14:03" at 12:08,
    // train still before Annavaram) must not mark every station reached —
    // that hid the bell on all stations. Times are IST; compare against the
    // IST clock regardless of the phone's own timezone.
    const istNowMin = (() => {
      const d = new Date(Date.now() + 330 * 60000);
      return d.getUTCHours() * 60 + d.getUTCMinutes();
    })();
    const inFuture = (hhmm) => {
      const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
      if (!m) return false;
      const ahead = (((+m[1]) * 60 + (+m[2]) - istNowMin) % 1440 + 1440) % 1440;
      return ahead > 5 && ahead < 720;
    };
    // BUGFIX (12797 running normally, yet NO bell on any upcoming station):
    // a daily train has overlapping runs, and the providers can hand back
    // the PREVIOUS run's recorded arrivals for stations today's run hasn't
    // reached yet. One such row far down the route marked every earlier
    // station reached and hid all the bells. A train can't arrive 90+ min
    // before its own schedule, so an "actual" on a stop whose schedule for
    // THIS run is still that far ahead belongs to another run — ignored.
    const notYetPossible = (st) => {
      const nowMs = Date.now();
      const times = [];
      ["arrival", "departure"].forEach((k) => {
        const t = st[k];
        if (!t) return;
        [t.scheduled, t.expected].forEach((raw) => { const d = parseRailTimestamp(raw); if (d) times.push(d.getTime()); });
      });
      if (!times.length) {
        // Undated provider strings: place the scheduled clock time on this
        // run's own day (journey start + the stop's day number).
        const raw = (st.arrival && st.arrival.scheduled) || (st.departure && st.departure.scheduled) || "";
        const m = /^(\d{1,2}):(\d{2})/.exec(String(raw));
        if (!m || !journeyStartDate) return false;
        const d = new Date(journeyStartDate);
        d.setHours(+m[1], +m[2], 0, 0);
        d.setDate(d.getDate() + journeyDayNumber(st) - 1);
        times.push(d.getTime());
      }
      return Math.min(...times) - nowMs > 90 * 60000;
    };
    const isReal = (st) => st.status === "current" || st.status === "passed"
      || (!notYetPossible(st)
        && ["arrival", "departure"].some((k) => st[k] && st[k].actual && st[k].actual_is_predicted === false && !inFuture(st[k].actual)));
    let lastIdx = -1;
    timeline.forEach((st, i) => { if (st.kind !== "intermediate" && isReal(st)) lastIdx = i; });
    const set = new Set();
    timeline.forEach((st, i) => { if (i <= lastIdx && st.code) set.add(String(st.code).toUpperCase()); });
    return set;
  })();

  // BUGFIX: the real current position is very often INSIDE a collapsed
  // "+N No-Halt stations" group (most of a route's stations are
  // non-reporting) — auto-expand whichever group actually contains it so
  // the live marker is visible without the user having to guess which
  // collapsed group to tap open. Keyed on the real current_station value
  // so this only re-fires when the train genuinely moves on, and only
  // ever adds an expansion (never collapses a group the user opened by
  // hand, or one they've since closed again).
  useEffect(() => {
    const idx = timelineGrouped.findIndex(
      (e) => e.display_type === "no_halt_group" && (e.stations || []).some((s) => s.status === "current")
    );
    if (idx !== -1) {
      setExpandedGroups((prev) => (prev[idx] ? prev : { ...prev, [idx]: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.current_station]);

  // FEATURE: bell auto-off. Once the train (live feed OR the phone's own
  // GPS) has really reached a station whose bell is armed, that bell turns
  // itself off: removed from this device's list, re-synced so the server
  // stops too (the server independently retires it as well), and a short
  // "reached — alert switched off" note is shown. No further notifications
  // are sent for that station.
  const armedCodesKey = Object.keys(stationWatches).sort().join(",");
  const reachedCodesKey = [...reallyReachedCodes].sort().join(",");
  useEffect(() => {
    if (!activeTrack || !bellsEnabledForPayload || !armedCodesKey) return;
    const hit = armedCodesKey.split(",").filter((c) => c && (ltJourneyLikelyComplete || reallyReachedCodes.has(c)));
    if (!hit.length) return;
    const track = activeTrack;
    const names = hit.map((c) => {
      const st = timeline.find((x) => String(x.code || "").toUpperCase() === c);
      return st ? toDisplayCase(st.name) : c;
    });
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(ALERTS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        const kept = list.filter((w) => !(String(w.trainNumber) === track.trainNumber
          && (w.date || null) === track.date && hit.includes(String(w.label || "").toUpperCase())));
        if (kept.length === list.length) return;
        await AsyncStorage.setItem(ALERTS_KEY, JSON.stringify(kept));
        await reloadStationWatches();
        const msg = `${names.join(", ")} reached — ${hit.length > 1 ? "those alerts are" : "its alert is"} switched off now.`;
        setBellNotice(msg);
        if (gpsOn) showLocalNotice(`🔕 Train ${track.trainNumber}`, msg, `bell-off-${track.trainNumber}`);
        const token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
        if (token) { try { await syncPushWatches(apiBaseUrl, token, kept); } catch (e) { /* server retires it on its own too */ } }
      } catch (e) { /* best-effort */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armedCodesKey, reachedCodesKey, activeTrackKey, ltJourneyLikelyComplete]);

  // FEATURE: "before 10 min, tell me the train is about to arrive — be
  // alert". For every armed bell, the live (or GPS) ETA to that station is
  // watched; once it's within APPROACH_ALERT_MINUTES a banner is shown
  // once. On GPS (often no internet on the train, so no server push can
  // arrive) a local system notification is raised too.
  useEffect(() => {
    if (!activeTrack || !payload || !armedCodesKey) return;
    armedCodesKey.split(",").forEach((code) => {
      if (!code) return;
      const st = timeline.find((x) => String(x.code || "").toUpperCase() === code && x.status === "upcoming");
      if (!st) return;
      const minutes = st.minutes_away != null ? st.minutes_away : minutesFromNowClockTime(st.predicted_eta);
      if (minutes == null || minutes < 0 || minutes > APPROACH_ALERT_MINUTES) return;
      const key = `${activeTrackKey}|${code}`;
      if (approachFiredRef.current[key]) return;
      approachFiredRef.current[key] = true;
      const name = toDisplayCase(st.name);
      setApproachNotice({ code, name, minutes, eta: st.predicted_eta || null });
      if (readAloudRef.current && !(gpsOn || (typeof navigator !== "undefined" && navigator.onLine === false))) speak(`Train ${activeTrack.trainNumber} arriving at ${name} in about ${Math.max(1, minutes)} minutes. Please be alert.`);
      if (gpsOn || (typeof navigator !== "undefined" && navigator.onLine === false)) {
        showLocalNotice(
          `🚆 ${activeTrack.trainNumber} arriving at ${name} ${minutes < 1 ? "now" : `in ~${minutes} min`}`,
          `Please be alert — the train reaches ${name} in the next 5–10 minutes${st.predicted_eta ? ` (ETA ${st.predicted_eta})` : ""}.`,
          `approach-${activeTrack.trainNumber}-${code}`,
        );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, armedCodesKey]);

  // GPS mode switching (RailYatri's "Are you inside the train?").
  const askGps = useCallback((reason) => { setGpsAsk({ reason: reason || "manual" }); }, []);
  const answerInTrain = useCallback((yes) => {
    const reason = gpsAsk ? gpsAsk.reason : "manual";
    setGpsAsk(null);
    if (yes) {
      gpsHistoryRef.current = [];
      setModeNotice(null);
      setGpsOn(true);
    } else {
      setGpsOn(false);
      setModeNotice(reason === "offline"
        ? "No internet — live status needs internet when you're not on the train."
        : null);
    }
  }, [gpsAsk]);
  const onGpsOffRoute = useCallback((r) => {
    const km = r && r.offRouteKm != null ? Math.round(r.offRouteKm) : null;
    setGpsOn(false);
    setApproachNotice(null);
    setModeNotice(`You don't seem to be on train ${activeTrack ? activeTrack.trainNumber : ""}${km != null ? ` (${km} km away from its route)` : ""}. Use internet when you are not on the train — switching back to internet.`);
    if (activeParamsRef.current && !manualStopRef.current) refreshNow();
  }, [activeTrack, refreshNow]);
  const stopGps = useCallback(() => { setGpsOn(false); setApproachNotice(null); refreshNow(); }, [refreshNow]);

  // Two GPS readings in a row that disagree with the live train position
  // → the user is not on this train: say so and switch back to internet.
  useEffect(() => {
    if (!gpsOn || !gpsVerdict || gpsVerdict.unknown) return;
    if (gpsVerdict.ok) { gpsNotOnTrainCountRef.current = 0; return; }
    gpsNotOnTrainCountRef.current += 1;
    if (gpsNotOnTrainCountRef.current < 2) return;
    gpsNotOnTrainCountRef.current = 0;
    const num = activeTrack ? activeTrack.trainNumber : "";
    const km = Math.round(gpsVerdict.gapKm);
    setGpsOn(false);
    setApproachNotice(null);
    setModeNotice(gpsVerdict.notStarted
      ? `Train ${num} hasn't started yet, so you can't be on it. Use internet when you are not on the train — switching back to internet.`
      : `You're about ${km} km ${gpsVerdict.ahead ? "ahead of" : "behind"} train ${num}, so you don't seem to be on it. Use internet when you are not on the train — switching back to internet.`);
    if (activeParamsRef.current && !manualStopRef.current) refreshNow();
  }, [gpsVerdict]); // eslint-disable-line react-hooks/exhaustive-deps

  // REDESIGN (RailYatri-style live position marker): "X km covered so
  // far" — honestly derived, never invented, from two real payload
  // values: the last reporting station's own real distance-from-origin
  // (already on that station's timeline entry) plus how far the train has
  // moved past it (payload.distance_covered_since_last_stop_km, computed
  // fresh every poll server-side — see backend/app.py).
  let ltLastReportingDistanceKm = null;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if ((timeline[i].status === "passed" || timeline[i].status === "current") && timeline[i].distance_km != null) {
      ltLastReportingDistanceKm = timeline[i].distance_km;
      break;
    }
  }
  const ltTotalCoveredKm = (ltLastReportingDistanceKm != null && payload?.distance_covered_since_last_stop_km != null)
    ? Math.round((ltLastReportingDistanceKm + payload.distance_covered_since_last_stop_km) * 10) / 10
    : null;
  const ltNextEtaMinutes = !ltJourneyLikelyComplete
    ? minutesFromNowClockTime(payload?.next_station_live_eta || payload?.next_station_expected_arrival)
    : null;

  // REDESIGN (RailYatri-style bottom sticky bar): "Next: X in N mins
  // (delay)" plus two quick-action buttons that jump to the real Time
  // Table / "More tools" (Coach layout lives there) screens — see
  // App.js's actual navigator structure. Both now hand along the real
  // train number already being tracked (see TrainScheduleScreen.js's
  // route.params.trainNumber auto-fetch, and MoreToolsScreen.js's
  // initialTab/trainNumber pre-fill for its Coach Layout tab) instead of
  // making the user re-type it.
  const showBottomBar = !!payload && !ltJourneyLikelyComplete && !!payload.next_station;

  // RailYatri-style status sentence for the status card.
  const ltStatus = (() => {
    if (!payload || !timeline.length) return { headline: "", sub: null };
    const last = timeline[timeline.length - 1];
    if (ltJourneyLikelyComplete || last.status === "passed" || (last.status === "current" && !ltNextEtaMinutes)) {
      const t = (last.arrival && (last.arrival.actual || last.arrival.expected)) || null;
      return { headline: "Train has reached destination.", sub: t ? `Arrived ${toDisplayCase(last.name)} at ${String(t).slice(0, 5)}` : null };
    }
    const curIdx = timeline.findIndex((x) => x.status === "current");
    let lastReached = -1;
    timeline.forEach((x, i) => { if (x.status === "passed" || x.status === "current") lastReached = i; });
    const first = timeline[0];
    const nextHalt = timeline.slice(Math.max(0, lastReached + 1)).find((x) => x.kind !== "intermediate");
    let sub = null;
    if (nextHalt) {
      let eta = nextHalt.predicted_eta || (nextHalt.arrival && (nextHalt.arrival.expected || nextHalt.arrival.scheduled));
      let mins = nextHalt.minutes_away != null ? nextHalt.minutes_away : minutesFromNowClockTime(nextHalt.predicted_eta);
      // Never show a physically impossible ETA (e.g. "in 35 min" while
      // 2 km away): beyond ~20 km/h + a halt, fall back to km / speed.
      const kmAway = nextHalt.distance_ahead_km;
      if (kmAway != null && mins != null && mins > (kmAway / 20) * 60 + 10) {
        const v = payload.display_speed_kmph || payload.avg_speed_kmph || 50;
        mins = Math.round((kmAway / Math.max(10, Math.min(v, 130))) * 60);
        const d = new Date(Date.now() + mins * 60000);
        eta = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      }
      sub = `Next halt ${toDisplayCase(nextHalt.name)}${eta ? ` · ETA ${String(eta).slice(0, 5)}` : ""}${mins != null && mins >= 0 && mins <= 180 ? ` (in ${mins} min)` : ""}${nextHalt.predicted_eta_source === "gps" ? " · by GPS" : ""}`;
    }
    const departed = first.departure && first.departure.actual && first.departure.actual_is_predicted !== true;
    if (lastReached === -1 || (curIdx === 0 && !departed)) {
      const dep = first.departure && (first.departure.expected || first.departure.scheduled);
      return {
        headline: "Train hasn't started yet.",
        sub: dep ? `Departs ${toDisplayCase(first.name)} at ${String(dep).slice(0, 5)}` : sub,
      };
    }
    if (gpsOn && payload.gps_headline) return { headline: payload.gps_headline, sub };
    const at = timeline[lastReached];
    const timing = (at.departure && at.departure.actual) || (at.arrival && at.arrival.actual);
    const verb = at.status === "current" && at.kind !== "intermediate" && !(at.departure && at.departure.actual) ? "At" : "Crossed";
    const km = payload.distance_remaining_to_next_km;
    const nxt = timeline[lastReached + 1];
    const headline = `${verb} ${toDisplayCase(at.name)}${timing && verb === "Crossed" ? ` at ${String(timing).slice(0, 5)}` : ""}`
      + (nxt ? (km != null ? ` · ${km} km to ${toDisplayCase(nxt.name)}` : ` · next ${toDisplayCase(nxt.name)}`) : "");
    return { headline, sub };
  })();

  return (
    <View style={styles.flex}>
    <ScrollView style={styles.flex} contentContainerStyle={[styles.content, showBottomBar && styles.contentWithBar]}>
      {(!activeTrack || formOpen) ? (
        <SectionCard title="Track a train" subtitle="Shows the live position instantly and keeps it updating every few seconds.">
          <LabeledInput label="Train number" placeholder="e.g. 12709" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" />
          <Text style={styles.fieldLabel}>{"Date (optional \u2014 defaults to today)"}</Text>
          <TouchableOpacity style={styles.dateField} onPress={() => { datePickForHeaderRef.current = false; setDayPickerVisible(true); }} activeOpacity={0.7}>
            <Ionicons name="calendar-outline" size={16} color={colors.primary} />
            <Text style={styles.dateFieldText}>
              {trackDate.trim() ? (formatLongLabel(fromDdMmYyyy(trackDate)) || trackDate) : "Today"}
            </Text>
            <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
          </TouchableOpacity>
          <View style={styles.row}>
            <LabeledInput label="Source (optional)" placeholder="e.g. SC" value={source} onChangeText={setSource} style={styles.half} />
            <LabeledInput label="Dest (optional)" placeholder="e.g. BZA" value={dest} onChangeText={setDest} style={styles.half} />
          </View>
          <View style={styles.row}>
            {/* No spinner / "Connecting…" state: tracking starts at once —
                the last known position is shown instantly and the live
                feed takes over the moment it answers. */}
            <PrimaryButton title="Start tracking" onPress={connect} style={styles.half} />
            {activeTrack ? (
              <PrimaryButton title="Cancel" variant="secondary" onPress={() => setFormOpen(false)} style={styles.half} />
            ) : null}
          </View>
        </SectionCard>
      ) : (
        <View style={styles.ryHeader}>
          {/* REDESIGN (RailYatri-style header): "12728 - Godavari Sf Express",
              route, and a Today/Yesterday date switch — the form itself is
              tucked away behind "Change" once a train is being tracked. */}
          <View style={styles.ryHeaderTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.ryTrainTitle} numberOfLines={1}>
                {activeTrack.trainNumber}{payload?.train_name ? ` - ${toDisplayCase(payload.train_name)}` : ""}
              </Text>
              {timeline.length >= 2 ? (
                <Text style={styles.ryTrainSub} numberOfLines={1}>
                  {(timeline[0].code || timeline[0].name)}-{(timeline[timeline.length - 1].code || timeline[timeline.length - 1].name)}
                  {payload?.train_name ? "" : ` · ${toDisplayCase(timeline[0].name)} → ${toDisplayCase(timeline[timeline.length - 1].name)}`}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity style={styles.ryDateBtn} onPress={() => { datePickForHeaderRef.current = true; setDayPickerVisible(true); }}>
              <Text style={styles.ryDateBtnText}>{trackDateLabel(activeTrack.date)}</Text>
              <Ionicons name="caret-down" size={12} color="#fff" />
            </TouchableOpacity>
          </View>
          <View style={styles.ryHeaderRow}>
            <LiveBadge connection={connection} hasPayload={!!payload} gpsOn={gpsOn} />
            {payload?.status_updated_at ? (
              <TouchableOpacity onPress={refreshNow} style={styles.refreshRow}>
                <Ionicons name="refresh" size={13} color={colors.primary} />
                <Text style={styles.refreshText}>{gpsOn ? "GPS fix" : "Position"} {formatAsOfAgo(payload.status_updated_at)}</Text>
              </TouchableOpacity>
            ) : null}
            <View style={{ flex: 1 }} />
            <TouchableOpacity onPress={shareTrackingLink} style={styles.ryIconBtn} accessibilityLabel="Share link">
              <Ionicons name="share-social-outline" size={16} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFormOpen(true)} style={styles.ryIconBtn} accessibilityLabel="Change train">
              <Ionicons name="create-outline" size={16} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={stopTracking} style={styles.ryStopBtn}>
              <Text style={styles.ryStopBtnText}>Stop</Text>
            </TouchableOpacity>
          </View>

          {/* Internet | GPS switch — GPS only after "Are you inside the train?" */}
          <View style={styles.modeSwitch}>
            <TouchableOpacity
              style={[styles.modeBtn, !gpsOn && styles.modeBtnActive]}
              onPress={() => { if (gpsOn) stopGps(); }}
            >
              <Ionicons name="globe-outline" size={14} color={!gpsOn ? "#fff" : colors.primary} />
              <Text style={[styles.modeBtnText, !gpsOn && styles.modeBtnTextActive]}>Internet</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeBtn, gpsOn && styles.modeBtnActive]}
              onPress={() => { if (!gpsOn) askGps("manual"); }}
            >
              <Ionicons name="navigate-outline" size={14} color={gpsOn ? "#fff" : colors.primary} />
              <Text style={[styles.modeBtnText, gpsOn && styles.modeBtnTextActive]}>GPS · I'm on this train</Text>
            </TouchableOpacity>
          </View>

          {/* "Notify me every" — live position + prediction as a notification
              at the user's own interval, app open or closed. */}
          <View style={styles.everyRow}>
            <Ionicons name="notifications-outline" size={14} color={colors.primary} />
            <Text style={styles.everyLabel}>Notify me every</Text>
            {[10, 20, 30].map((m) => (
              <TouchableOpacity
                key={m}
                onPress={() => { setStatusEveryCustomOpen(false); applyStatusEvery(m); }}
                style={[styles.everyChip, !statusEveryCustomOpen && statusEvery === m && styles.everyChipActive]}
              >
                <Text style={[styles.everyChipText, !statusEveryCustomOpen && statusEvery === m && styles.everyChipTextActive]}>{m}m</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              onPress={() => setStatusEveryCustomOpen(true)}
              style={[styles.everyChip, (statusEveryCustomOpen || ![0, 10, 20, 30].includes(statusEvery)) && styles.everyChipActive]}
            >
              <Text style={[styles.everyChipText, (statusEveryCustomOpen || ![0, 10, 20, 30].includes(statusEvery)) && styles.everyChipTextActive]}>
                {![0, 10, 20, 30].includes(statusEvery) && !statusEveryCustomOpen ? `${statusEvery}m` : "Custom"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { setStatusEveryCustomOpen(false); applyStatusEvery(0); }}
              style={[styles.everyChip, !statusEveryCustomOpen && statusEvery === 0 && styles.everyChipActive]}
            >
              <Text style={[styles.everyChipText, !statusEveryCustomOpen && statusEvery === 0 && styles.everyChipTextActive]}>Off</Text>
            </TouchableOpacity>
          </View>
          {/* Read notifications aloud (opt-in). */}
          <TouchableOpacity
            onPress={toggleReadAloud}
            style={styles.everyRow}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: readAloud }}
            disabled={!isSpeechSupported()}
          >
            <Ionicons name={readAloud ? "checkbox" : "square-outline"} size={18} color={isSpeechSupported() ? colors.primary : colors.textMuted} />
            <Text style={styles.everyLabel}>
              {isSpeechSupported() ? "🔊 Read notifications aloud" : "Read aloud isn't supported in this browser"}
            </Text>
          </TouchableOpacity>
          {readAloud ? (
            <Text style={styles.bgTrackText}>
              Reads the status updates and bell/delay alerts while this app is open (also in a background tab). With the app fully closed, you'll still get the notification and sound.
            </Text>
          ) : null}
          {statusEveryCustomOpen ? (
            <View style={styles.everyRow}>
              <LabeledInput
                label="Minutes (e.g. 15, or 1:30 for 1 hr 30 min)"
                value={statusEveryCustomText}
                onChangeText={setStatusEveryCustomText}
                keyboardType="numbers-and-punctuation"
                style={{ flex: 1 }}
              />
              <TouchableOpacity
                style={styles.everySetBtn}
                onPress={() => {
                  const n = parseLeadMinutesInput(statusEveryCustomText);
                  if (n) { setStatusEveryCustomOpen(false); applyStatusEvery(n); }
                }}
              >
                <Text style={styles.everySetBtnText}>Set</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {bgTracking && bgTracking.state !== "on" ? (
            <Text style={styles.bgTrackText}>
              {bgTracking.state === "pending" ? "Turning on background notifications…" : bgTracking.reason || "Background notifications are off."}
            </Text>
          ) : null}
          {shareLinkNote && <Text style={styles.errorText}>{shareLinkNote}</Text>}
          {!gpsOn && payload ? (
            // Which provider this frame came from — RailRadar is primary;
            // RailKit only when RailRadar has nothing, with the reason shown.
            <Text style={[styles.bgTrackText, payload.live_source === "railkit" && { color: colors.danger }]}>
              {payload.live_source === "railkit"
                ? `Live data: RailKit (backup) — RailRadar unavailable${payload.railradar_error ? `: ${payload.railradar_error}` : ""}`
                : payload.provider_note
                  ? payload.provider_note
                  : payload.quick_frame
                    ? "Live data: RailRadar — loading full details…"
                    : payload.live_source === "railradar"
                      ? `Live data: RailRadar${payload.position_estimated && payload.position_age_seconds
                        ? ` · position moved on by speed since the last report ${Math.max(1, Math.round(payload.position_age_seconds / 60))} min ago`
                        : ""}`
                      : null}
            </Text>
          ) : null}
        </View>
      )}

      {modeNotice ? (
        <View style={styles.ryRedBanner}>
          <Ionicons name="alert-circle-outline" size={18} color="#fff" />
          <Text style={styles.ryRedBannerText}>{modeNotice}</Text>
          <TouchableOpacity onPress={() => setModeNotice(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={16} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : null}
      {approachNotice ? (
        <View style={styles.ryAlertBanner}>
          <Ionicons name="notifications" size={18} color="#fff" />
          <Text style={styles.ryRedBannerText}>
            Train arriving at {approachNotice.name} {approachNotice.minutes < 1 ? "now" : `in ~${approachNotice.minutes} min`}
            {approachNotice.eta ? ` (ETA ${approachNotice.eta})` : ""} — please be alert.
          </Text>
          <TouchableOpacity onPress={() => setApproachNotice(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={16} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : null}
      {bellNotice ? (
        <View style={styles.ryInfoBanner}>
          <Ionicons name="notifications-off-outline" size={16} color={colors.primary} />
          <Text style={styles.ryInfoBannerText}>{bellNotice}</Text>
          <TouchableOpacity onPress={() => setBellNotice(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={14} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      ) : null}

      {activeTrack && (
        <OfflineTrackingCard
          trainNumber={activeTrack.trainNumber}
          date={activeTrack.date}
          payload={rawPayload}
          connection={connection}
          apiBaseUrl={apiBaseUrl}
          gpsOn={gpsOn}
          onNeedGps={askGps}
          onResult={onGpsResult}
          onOffRoute={onGpsOffRoute}
          onStopGps={stopGps}
          verifying={gpsOn && !!gpsResult && !gpsResult.error && !(gpsVerdict && gpsVerdict.ok)}
        />
      )}

      {activeTrack && payload && !(payload.timeline && payload.timeline.length) && payload.error ? (
        <View style={[styles.ryInfoBanner, { backgroundColor: "#fdecec", borderColor: "#f3b4b4" }]}>
          <Ionicons name="cloud-offline-outline" size={16} color={colors.danger} />
          <Text style={styles.ryInfoBannerText}>
            {`Couldn't get live data yet. RailRadar: ${payload.railradar_error || "no data"}. RailKit: ${payload.error}. Retrying…`}
          </Text>
        </View>
      ) : null}
      {activeTrack && !payload ? (
        <View style={styles.ryLoadingCard}>
          <Ionicons name="train-outline" size={18} color={colors.primary} />
          <Text style={styles.ryLoadingText}>Getting train {activeTrack.trainNumber}'s live position…</Text>
        </View>
      ) : null}

      {activeTrack ? (
        <>
          <TouchableOpacity onPress={toggleMap} style={styles.mapToggleBtn}>
            <Ionicons name="map-outline" size={14} color={colors.primary} />
            <Text style={styles.mapToggleBtnText}>{showMap ? "Hide train on map" : "🗺️ Train on map"}</Text>
          </TouchableOpacity>
          {mapError && <Text style={styles.errorText}>{mapError}</Text>}
        </>
      ) : null}
      <View style={[styles.mapBox, !(showMap && activeTrack) && styles.mapBoxHidden]}>
        <View ref={mapContainerRef} style={styles.mapInner} />
      </View>

      {/* FEATURE: Delay Alert — moved off this inline card onto the bell
          icon + DelayAlertModal sheet (see near the end of this component's
          JSX, and confirmDelayAlert above). Each bell arms an alert for
          the train + date actually being TRACKED (activeTrack), not
          whatever is typed in the form. delayWatchStatus is surfaced
          inside the sheet (statusMessage) — it no longer renders as its
          own standalone card. */}

      {/* FEATURE: End-of-Trip Summary Card (shareable) */}
      {tripSummary && (
        <SectionCard title="🏁 Trip complete">
          <Text style={styles.tripSummaryLine}>
            {tripSummary.source_station} → {tripSummary.destination_station} · arrived{" "}
            {tripSummary.arrival.delay_minutes ? `+${formatDelayDuration(tripSummary.arrival.delay_minutes)} late` : "on time"}
            {tripSummary.worst_station ? ` · worst delay at ${tripSummary.worst_station.name} (+${formatDelayDuration(tripSummary.worst_station.delay_minutes)})` : ""}.
          </Text>
          <PrimaryButton title={tripSummaryShareBusy ? "Creating link…" : "🔗 Share this trip recap"} onPress={shareTripSummary} loading={tripSummaryShareBusy} style={{ marginTop: spacing.sm }} />
          {tripSummaryShareStatus && <Text style={styles.webNoticeText}>{tripSummaryShareStatus}</Text>}
        </SectionCard>
      )}

      {/* FEATURE: Route-Deviation / Diversion Detection — see
          backend/route_deviation.py + payload.route_deviation. */}
      {payload?.route_deviation?.likely_diversion && (
        <SectionCard title="🚧 Possible route diversion">
          <Text style={styles.rerouteNote}>{payload.route_deviation.note}</Text>
          <Text style={styles.rerouteDisclaimer}>{payload.route_deviation.disclaimer}</Text>
        </SectionCard>
      )}

      {/* FEATURE: Dynamic Re-route Suggestions During Live Tracking — see
          backend/reroute_suggestions.py + payload.reroute_suggestion. GPS
          position-sharing isn't offered on this map-free web fallback
          screen — see the module docstring above for why this file stays
          deliberately reduced; the native screen (LiveTrackingScreen.js /
          TrackedTrainCard.js) is the "mobile-first GPS" target for that. */}
      {payload?.reroute_suggestion?.triggered && (
        <SectionCard title="⚠️ Re-route suggestion">
          <Text style={styles.rerouteTitle}>
            Running {formatDelayDuration(payload.reroute_suggestion.delay_minutes_used)} late ({payload.reroute_suggestion.delay_source})
          </Text>
          <Text style={styles.rerouteNote}>{payload.reroute_suggestion.note}</Text>
          {payload.reroute_suggestion.direct_alternatives?.length > 0 && (
            <>
              <Text style={styles.rerouteSubhead}>
                Alternative trains from {payload.reroute_suggestion.junction_name || payload.reroute_suggestion.junction_code}
                {" "}to {payload.reroute_suggestion.destination_name || payload.reroute_suggestion.destination_code}:
              </Text>
              {payload.reroute_suggestion.direct_alternatives.map((t, i) => (
                <Text key={i} style={styles.rerouteAltLine}>
                  {t.train_number}{t.train_name ? ` — ${t.train_name}` : ""} · dep {t.departure_time || "?"} → arr {t.arrival_time || "?"}
                </Text>
              ))}
            </>
          )}
          {payload.reroute_suggestion.alternative_routes?.length > 0 && (
            <>
              <Text style={styles.rerouteSubhead}>Junction-hopping corridors (no single confirmed train):</Text>
              {payload.reroute_suggestion.alternative_routes.map((r, i) => (
                <Text key={i} style={styles.rerouteAltLine}>
                  Via {r.via_names.join(" → ")} — {r.hops} change(s), ~{r.total_distance_km} km
                </Text>
              ))}
            </>
          )}
          {payload.reroute_suggestion.disclaimer && (
            <Text style={styles.rerouteDisclaimer}>{payload.reroute_suggestion.disclaimer}</Text>
          )}
        </SectionCard>
      )}

      {payload && (
        <>
          {/* FEATURE: explicit-past-date reliability warning — see
              backend/app.py's ws_track_train (`date_reliability_warning`).
              RailKit's `date` query param doesn't reliably select a
              SPECIFIC historical run; when a date was explicitly typed and
              RailKit's response has no live "current" station, what came
              back may actually be a different run (earlier, later, or
              already-finished) than the one asked for, just relabeled with
              the requested date — including when RailKit is simply attached
              to a run dated later than an explicit past date that was typed
              in. Also fires for a blank/today request stuck on an older,
              unfinished run. Shown first, above everything else, since it
              changes how every row below should be read — same "surface the
              uncertainty rather than present a guess as fact" rule this
              project applies everywhere else. */}
          {payload.date_reliability_warning && (
            <SectionCard title="⚠️ This may be the wrong run">
              <Text style={styles.rerouteNote}>{payload.date_reliability_warning}</Text>
            </SectionCard>
          )}

          {/* REDESIGN (RailYatri-style header): train number + real route
              (first/last reported stops — never invented), then a plain-
              English running-status line. When the journey is genuinely
              done, this reads "Train has reached destination." exactly
              like RailYatri's own completed-run page; otherwise it's the
              same "Next station · ETA" summary as before. */}
          {/* REDESIGN (RailYatri-style status card): one plain sentence for
              where the train is — "Train hasn't started yet", "Crossed X at
              HH:MM · 2 km to Y", "Train has reached destination." — and the
              next halt's live ETA underneath. On GPS it's the phone's own
              position on the route. */}
          <View ref={quickBarRef} style={styles.ryStatusCard}>
            <View style={[styles.ryStatusIcon, gpsOn && { backgroundColor: colors.accent }]}>
              <Ionicons name={gpsOn ? "navigate" : "train"} size={20} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.ryStatusText}>{ltStatus.headline}</Text>
              {ltStatus.sub ? <Text style={styles.ryStatusSub}>{ltStatus.sub}</Text> : null}
            </View>
            <DelayPill minutes={ltEffectiveDelay} />
          </View>

          <TouchableOpacity onPress={() => setShowMoreStats((v) => !v)} style={styles.moreStatsToggle}>
            <Text style={styles.moreStatsToggleText}>{showMoreStats ? "▾ Hide more details" : "▸ More details"}</Text>
          </TouchableOpacity>

          {showMoreStats && (
            <SectionCard title="Live position — full details">
              <InfoRow label="Coordinates" value={payload.lat && payload.lng ? `${payload.lat}, ${payload.lng}` : "—"} />
              <InfoRow label="Current station" value={payload.current_station || "—"} />
              <InfoRow
                label="ML predicted delay"
                value={
                  payload.predicted_delay_minutes != null
                    ? `${formatDelayDuration(payload.predicted_delay_minutes)} (${payload.predicted_delay_confidence || "n/a"} confidence)`
                    : "—"
                }
              />
              <InfoRow label="Position source" value={payload.position_source || "—"} />
              <InfoRow label="Direction" value={payload.direction && payload.direction !== "UNKNOWN" ? payload.direction : "—"} />
              <InfoRow
                label="Current speed"
                value={
                  payload.recency_weighted_speed_kmph != null || payload.instant_speed_kmph != null
                    ? `${payload.recency_weighted_speed_kmph ?? payload.instant_speed_kmph} km/h`
                    : payload.display_speed_kmph != null ? `${payload.display_speed_kmph} km/h (est.)` : "—"
                }
              />
              <InfoRow label="Avg. running speed" value={payload.avg_speed_kmph != null ? `${payload.avg_speed_kmph} km/h` : "—"} />
              <InfoRow
                label="Distance to next station"
                value={payload.distance_remaining_to_next_km != null ? `${payload.distance_remaining_to_next_km} km` : "—"}
              />
              {/* FEATURE: Live delay-trend sparkline — text form (getting
                  better/worse right now), fitting this already text-only
                  screen rather than adding a chart library here. */}
              {delaySparkline.length >= 2 && (
                <InfoRow
                  label={`Delay trend (last ${delaySparkline.length})`}
                  value={`${delaySparkline.map((v) => (v > 0 ? `+${v}` : String(v))).join(", ")} ${
                    delaySparkline[delaySparkline.length - 1] < delaySparkline[0] ? "(improving)"
                    : delaySparkline[delaySparkline.length - 1] > delaySparkline[0] ? "(worsening)" : "(steady)"
                  }`}
                />
              )}
              {payload.error ? <Text style={styles.errorText}>{payload.error}</Text> : null}
            </SectionCard>
          )}


          {/* REDESIGN (RailYatri-style running status): Arrival | Station |
              Departure columns, a "DayN: <date>" pill at each real day
              boundary (RailKit's own per-stop day field), and consecutive
              non-halting stations collapsed into a tappable
              "+N No-Halt stations" row — same layout as the reference. */}
          <SectionCard title="Running status — every station" subtitle={`${timeline.length} stops reported`}>
            <View style={styles.tlColHeaderRow}>
              <Text style={styles.tlColHeaderSide}>Arrival</Text>
              <Text style={styles.tlColHeaderMid}>Station</Text>
              <Text style={[styles.tlColHeaderSide, styles.tlColHeaderRight]}>Departure</Text>
            </View>
            {(() => {
              let lastDay = null;
              return timelineGrouped.map((entry, idx) => {
                if (entry.display_type === "no_halt_group") {
                  return (
                    <NoHaltGroupRow
                      key={`group_${idx}`}
                      group={entry}
                      expanded={!!expandedGroups[idx]}
                      onToggle={() => setExpandedGroups((prev) => ({ ...prev, [idx]: !prev[idx] }))}
                      statusUpdatedAt={payload?.status_updated_at}
                      refreshCountdown={refreshCountdown}
                      distanceRemainingToNextKm={payload?.distance_remaining_to_next_km}
                      totalCoveredKm={ltTotalCoveredKm}
                      statusResponseId={payload?.status_response_id}
                      reportState={reportState}
                      onReportInaccuracy={reportInaccuracy}
                      nextStationName={payload?.next_station}
                      segmentSpeedSignal={payload?.segment_speed_signal}
                      gpsMode={gpsOn}
                      calloutOpen={calloutOpen}
                      onTrainIconPress={toggleCallout}
                    />
                  );
                }
                const dayNum = dayNumberForEntry(entry, journeyStartDate);
                const showDayPill = lastDay !== dayNum;
                lastDay = dayNum;
                return (
                  <React.Fragment key={`${entry.code}_${idx}`}>
                    {showDayPill && (
                      <DayPill label={`Day${dayNum}: ${formatJourneyDayLabel(journeyStartDate, dayNum)}`} />
                    )}
                    <TimelineStopRow
                      stop={entry}
                      isFirst={idx === 0}
                      isLast={idx === ltLastStationIndex}
                      rowRef={
                        // BUGFIX: once the journey looks likely complete, a
                        // raw stop.status === "current" can be a stuck
                        // pointer (see computeJourneyLikelyComplete's
                        // reasoning) rather than the train's real position
                        // — scroll to the actual last row instead of that
                        // stale "current" one.
                        ltJourneyLikelyComplete
                          ? (idx === ltLastStationIndex ? lastStationRowRef : undefined)
                          : entry.status === "current"
                            ? currentStationRowRef
                            : idx === ltLastStationIndex
                              ? lastStationRowRef
                              : undefined
                      }
                      journeyLikelyComplete={ltJourneyLikelyComplete}
                      statusUpdatedAt={payload?.status_updated_at}
                      refreshCountdown={refreshCountdown}
                      distanceRemainingToNextKm={payload?.distance_remaining_to_next_km}
                      totalCoveredKm={ltTotalCoveredKm}
                      statusResponseId={payload?.status_response_id}
                      reportState={reportState}
                      onReportInaccuracy={reportInaccuracy}
                      nextStationName={payload?.next_station}
                      segmentSpeedSignal={payload?.segment_speed_signal}
                      gpsMode={gpsOn}
                      calloutOpen={calloutOpen}
                      onTrainIconPress={toggleCallout}
                      alertArmed={!!stationWatches[(entry.code || "").toUpperCase()]}
                      alertBlocked={ltJourneyLikelyComplete || reallyReachedCodes.has((entry.code || "").toUpperCase())}
                      onBellPress={bellsEnabledForPayload ? openStationAlert : undefined}
                    />
                  </React.Fragment>
                );
              });
            })()}
          </SectionCard>

          <SectionCard title="Crowd prediction" subtitle={payload.crowd_disclaimer}>
            <InfoRow label="Level" value={payload.crowd_level || "—"} />
            <InfoRow label="Score" value={payload.crowd_score != null ? String(payload.crowd_score) : "—"} />
            {!!payload.crowd_basis?.length && (
              <View style={styles.basisList}>
                {payload.crowd_basis.map((b, i) => (
                  <Text key={i} style={styles.basisItem}>• {b}</Text>
                ))}
              </View>
            )}
          </SectionCard>
        </>
      )}

      {/* FEATURE: Smart Alarm, right on Live Tracking (moved off the
          separate More Tools menu — see the top-of-file comment). Only
          shows once a train is actually being tracked; arming an alarm
          before that point doesn't mean anything. */}
      {payload && (
        <SectionCard title="⏰ Smart Alarm" subtitle="Wake-up alert as this train nears a station you pick — rings even if you close the app.">
          <LabeledInput label="Destination station code" value={alarmStation} onChangeText={setAlarmStation} autoCapitalize="characters" editable={!alarmArmed} />
          <Text style={styles.fieldLabel}>Alert me before arrival</Text>
          <View style={styles.chipRow}>
            {["15", "20", "30", "40", "45"].map((m) => (
              <TouchableOpacity
                key={m}
                disabled={alarmArmed}
                onPress={() => { setAlarmLeadMinutes(m); setAlarmCustomOpen(false); }}
                style={[styles.alarmChip, !alarmCustomOpen && alarmLeadMinutes === m && styles.alarmChipActive]}
              >
                <Text style={[styles.alarmChipText, !alarmCustomOpen && alarmLeadMinutes === m && styles.alarmChipTextActive]}>{m} min</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity disabled={alarmArmed} onPress={() => setAlarmCustomOpen(true)} style={[styles.alarmChip, alarmCustomOpen && styles.alarmChipActive]}>
              <Text style={[styles.alarmChipText, alarmCustomOpen && styles.alarmChipTextActive]}>Custom</Text>
            </TouchableOpacity>
          </View>
          {alarmCustomOpen && (
            <LabeledInput
              label="Custom — minutes, or H:MM for 1hr+ (e.g. 1:30 = 1hr 30min)"
              value={alarmCustomText} onChangeText={setAlarmCustomText}
              keyboardType="numbers-and-punctuation" editable={!alarmArmed}
            />
          )}
          <PrimaryButton
            title={alarmArmed ? "Armed" : "Set Alarm"} onPress={setSmartAlarm} loading={alarmBusy}
            disabled={alarmArmed} style={{ marginTop: spacing.sm }}
          />
          {alarmArmed && (
            <TouchableOpacity onPress={cancelSmartAlarm} style={{ marginTop: spacing.sm }}>
              <Text style={styles.removeAlarmText}>Remove alarm for this station</Text>
            </TouchableOpacity>
          )}
          {alarmStatus && <Text style={styles.webNoticeText}>{alarmStatus}</Text>}
        </SectionCard>
      )}
    </ScrollView>
    {showBottomBar && (
      <View style={styles.bottomBar}>
        <View style={styles.bottomBarInfo}>
          <Text style={styles.bottomBarLabel} numberOfLines={1}>
            Next: <Text style={styles.bottomBarStation}>{payload.next_station}</Text>
            {ltNextEtaMinutes != null ? ` in ${ltNextEtaMinutes} min${ltNextEtaMinutes === 1 ? "" : "s"}` : ""}
          </Text>
          {ltEffectiveDelay != null && (
            <Text style={[styles.bottomBarDelay, ltEffectiveDelay > 0 ? styles.bottomBarDelayLate : styles.bottomBarDelayOnTime]}>
              {ltEffectiveDelay === 0 ? "Ontime" : `${ltEffectiveDelay > 0 ? "+" : ""}${formatDelayDuration(ltEffectiveDelay)}${ltEffectiveDelay > 0 ? " late" : " early"}`}
            </Text>
          )}
        </View>
        <View style={styles.bottomBarActions}>
          {/* BUGFIX: both shortcuts now hand along the real train number
              already being tracked, so the destination screen opens
              pre-filled (and, for Time Table, auto-fetched) instead of
              making the user re-type the same number a second time. */}
          <TouchableOpacity
            style={styles.bottomBarBtn}
            onPress={() => navigation?.navigate?.("More", { initialTab: "coach", trainNumber: trainNumber.trim() })}
          >
            <Ionicons name="grid-outline" size={13} color={colors.primary} />
            <Text style={styles.bottomBarBtnText}>Coach layout</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.bottomBarBtn}
            onPress={() => navigation?.navigate?.("Home", { screen: "TrainSchedule", params: { trainNumber: trainNumber.trim() } })}
          >
            <Ionicons name="time-outline" size={13} color={colors.primary} />
            <Text style={styles.bottomBarBtnText}>Time Table</Text>
          </TouchableOpacity>
        </View>
      </View>
    )}
    <DayPickerModal
      visible={dayPickerVisible}
      selected={trackDate}
      onSelect={(v) => {
        setTrackDate(v);
        // Picked from the tracking header ("Today ▾"): switch the tracked
        // run straight away, like RailYatri's Today/Yesterday switch.
        if (datePickForHeaderRef.current && activeParamsRef.current) {
          datePickForHeaderRef.current = false;
          startTracking({ ...activeParamsRef.current, date: v }, false);
        }
      }}
      onClose={() => setDayPickerVisible(false)}
    />

    {/* RailYatri-style "Are you inside the train?" — GPS mode is only
        switched on when the user confirms they're ON this train. */}
    <Modal visible={!!gpsAsk} transparent animationType="fade" onRequestClose={() => setGpsAsk(null)}>
      <View style={styles.askBackdrop}>
        <View style={styles.askCard}>
          <TouchableOpacity style={styles.askClose} onPress={() => setGpsAsk(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={22} color={colors.textMuted} />
          </TouchableOpacity>
          <View style={styles.askIllustration}>
            <Ionicons name="train" size={44} color="#fff" />
          </View>
          <Text style={styles.askTitle}>Are you inside the train?</Text>
          <Text style={styles.askSub}>
            {gpsAsk && gpsAsk.reason === "offline"
              ? "No internet right now. If you're on this train, GPS can keep tracking it without internet."
              : `If you're on train ${activeTrack ? activeTrack.trainNumber : ""}, your phone's GPS gives the most accurate position and ETAs.`}
          </Text>
          <View style={styles.askBtnRow}>
            <TouchableOpacity style={[styles.askBtn, styles.askBtnYes]} onPress={() => answerInTrain(true)}>
              <Text style={styles.askBtnYesText}>Yes</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.askBtn, styles.askBtnNo]} onPress={() => answerInTrain(false)}>
              <Text style={styles.askBtnNoText}>No</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>

    {/* FEATURE: per-station Delay Alert sheet — opened from the bell on
        each reporting station row in "Running status" (openStationAlert). */}
    <DelayAlertModal
      visible={!!delayModalStation}
      onClose={() => setDelayModalStation(null)}
      trainNumber={delayModalStation ? delayModalStation.trainNumber : ""}
      trackDate={delayModalStation ? delayModalStation.date : ""}
      station={delayModalStation}
      active={!!(delayModalStation && stationWatches[delayModalStation.code])}
      busy={delayWatchBusy}
      initialThreshold={delayModalStation && stationWatches[delayModalStation.code] ? stationWatches[delayModalStation.code].threshold : 0}
      initialRepeat={delayModalStation && stationWatches[delayModalStation.code] ? stationWatches[delayModalStation.code].repeatMinutes : 10}
      statusMessage={delayWatchStatus ? delayWatchStatus.message : null}
      onConfirm={confirmDelayAlert}
      onStop={() => {
        const st = delayModalStation;
        setDelayModalStation(null);
        if (st) saveStationWatch(st, null);
      }}
    />
    </View>
  );
}

// REDESIGN (RailYatri-style live position marker): white rounded-square
// train glyph with a small red circular "pin" badge overlapping its
// bottom-right corner — same silhouette as the reference screenshot,
// replacing the plain solid-red circle this screen used before.
// FEATURE: the live-status bubble opens ONLY when the train icon is tapped:
// first tap shows it, second tap hides it. A real button for screen readers.
function TrainMarkerIcon({ onPress, open }) {
  if (onPress) {
    return (
      <TouchableOpacity
        onPress={onPress}
        style={styles.trainMarkerWrap}
        accessibilityRole="button"
        accessibilityState={{ expanded: !!open }}
        accessibilityLabel={open ? "Train position. Tap to hide live status" : "Train position. Tap to show live status"}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <View style={styles.trainMarkerSquare}>
          <Ionicons name="train" size={16} color={colors.primary} />
        </View>
        <View style={styles.trainMarkerPinBadge}>
          <Ionicons name="location" size={9} color="#fff" />
        </View>
      </TouchableOpacity>
    );
  }
  return (
    <View style={styles.trainMarkerWrap}>
      <View style={styles.trainMarkerSquare}>
        <Ionicons name="train" size={16} color={colors.primary} />
      </View>
      <View style={styles.trainMarkerPinBadge}>
        <Ionicons name="location" size={9} color="#fff" />
      </View>
    </View>
  );
}

// REDESIGN (RailYatri-style live position marker): the speech-bubble
// callout at the train's real current position — "As of X ago" (real
// status_updated_at — the true last-real-fetch time, guaranteed <=60s
// stale, see formatAsOfAgo's BUGFIX comment above) + a connection
// heartbeat countdown (the real ~5s server push cadence, see
// _TRACK_POLL_INTERVAL_SECONDS — this is how often a message arrives, not
// how often the position data itself changes), the real distance to the
// next station, the real distance covered so far this run, and a working
// "Report Inaccuracy" link wired to the real /api/feedback endpoint.
function LiveStatusCallout({
  stop, statusUpdatedAt, refreshCountdown, distanceRemainingToNextKm,
  totalCoveredKm, statusResponseId, reportState, onReportInaccuracy, nextStationName, segmentSpeedSignal, gpsMode,
}) {
  return (
    <View style={styles.liveCallout}>
      <View style={styles.liveCalloutHeadRow}>
        <Text style={styles.liveCalloutAsOf}>As of {formatAsOfAgo(statusUpdatedAt)}</Text>
        <View style={styles.liveCalloutRefreshWrap}>
          <Ionicons name="refresh" size={10} color={colors.textMuted} />
          <Text style={styles.liveCalloutRefreshText}>{refreshCountdown}s</Text>
        </View>
      </View>
      <Text style={[styles.liveCalloutMain, gpsMode && { color: colors.accent }]}>
        {gpsMode
          ? `📡 By your GPS: just past ${toDisplayCase(stop.name)}`
          : `🚆 Train is currently at ${toDisplayCase(stop.name)}${stop.halt_minutes ? ` · halt ${stop.halt_minutes} min` : ""}`}
      </Text>
      {distanceRemainingToNextKm != null && (
        // REDESIGN (RailYatri parity): names the real upcoming station
        // (payload.next_station, threaded down from the screen) instead of
        // a generic "next station" — same phrasing as the reference app's
        // "4 kms to Aler".
        <Text style={styles.liveCalloutBold}>
          {distanceRemainingToNextKm} km to {nextStationName ? toDisplayCase(nextStationName) : "next station"}
        </Text>
      )}
      {totalCoveredKm != null && (
        <Text style={styles.liveCalloutMuted}>({totalCoveredKm} km covered so far)</Text>
      )}
      {/* FEATURE PARITY (web frontend's liveTrackCaption addition): closest
          real substitute for "route congestion" this app can honestly
          show — see backend's _compute_segment_speed_signal. Only appears
          when genuinely running well below this SPECIFIC segment's own
          published typical speed (RailRadar's real speedToNextStationKmph),
          never implying a multi-train congestion measurement no provider
          this app uses actually has. */}
      {segmentSpeedSignal && (
        <Text style={styles.liveCalloutSpeedWarn}>
          ⚠ {segmentSpeedSignal.live_kmph} km/h vs. usual ~{segmentSpeedSignal.typical_kmph} km/h here
        </Text>
      )}
      {!gpsMode && <TouchableOpacity
        style={styles.liveCalloutReportLink}
        disabled={reportState !== "idle" || !statusResponseId}
        onPress={() => onReportInaccuracy(statusResponseId)}
      >
        <Text style={styles.liveCalloutReportText}>
          {reportState === "sending" ? "Reporting…" : reportState === "sent" ? "Reported — thanks" : "Report Inaccuracy"}
        </Text>
      </TouchableOpacity>}
    </View>
  );
}

// No "Connecting…" / "Disconnected" flicker while tracking: the screen
// always keeps the last live position on show and reconnects quietly in
// the background — the "Position X ago" next to this says how fresh it is.
function LiveBadge({ connection, hasPayload, gpsOn }) {
  let s;
  if (gpsOn) s = { color: colors.accent, label: "GPS", icon: "navigate" };
  else if (hasPayload) s = { color: colors.success, label: "Live", icon: "radio-outline" };
  else if (connection === "error") s = { color: colors.danger, label: "Can't reach server — check backend URL in Settings", icon: "warning-outline" };
  else s = { color: colors.textMuted, label: "Loading…", icon: "time-outline" };
  return (
    <View style={styles.badgeRowInline}>
      <Ionicons name={s.icon} size={14} color={s.color} />
      <Text style={[styles.badgeText, { color: s.color }]}>{s.label}</Text>
    </View>
  );
}

function ConnectionBadge({ connection }) {
  const map = {
    idle: { color: colors.textMuted, label: "Not connected", icon: "ellipse-outline" },
    connecting: { color: colors.warning, label: "Connecting…", icon: "sync-outline" },
    open: { color: colors.success, label: "Live", icon: "radio-outline" },
    closed: { color: colors.textMuted, label: "Disconnected", icon: "stop-circle-outline" },
    error: { color: colors.danger, label: "Connection error — check backend URL in Settings", icon: "warning-outline" },
  };
  const s = map[connection] || map.idle;
  return (
    <View style={styles.badgeRow}>
      <Ionicons name={s.icon} size={14} color={s.color} />
      <Text style={[styles.badgeText, { color: s.color }]}>{s.label}</Text>
    </View>
  );
}

function InfoRow({ label, value }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

// ============================================================
// REDESIGN (RailYatri-style running status): a small red/green pill for a
// delay figure — reused for the quick bar and every Arrival/Departure line
// in the timeline below, same red-for-late/green-for-on-time convention
// the web frontend's .live-timeline__delay classes use.
// ============================================================
function humanDelay(minutes) {
  const abs = Math.round(Math.abs(minutes));
  if (abs < 60) return `${abs} min`;
  const h = Math.floor(abs / 60), m = abs % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function DelayPill({ minutes, small }) {
  if (minutes == null) return null;
  const late = minutes > 0;
  const early = minutes < 0;
  // REDESIGN (RailYatri): light chip — "10 min late" red on pale red,
  // "On time" green on pale green.
  const bg = late ? "#fdecec" : "#e7f6ec";
  const fg = late ? colors.danger : colors.success;
  const label = minutes === 0 ? "On time" : `${humanDelay(minutes)} ${late ? "late" : "early"}`;
  return (
    <View style={[styles.delayPill, { backgroundColor: bg }, small && styles.delayPillSmall]}>
      <Text style={[styles.delayPillText, { color: fg }, small && styles.delayPillTextSmall]}>{label}</Text>
    </View>
  );
}

// REDESIGN (RailYatri-style): a centered "DayN: <date>" pill inserted at
// each real day-boundary in the timeline (see journeyDayNumber above) —
// only for multi-day journeys does more than one of these ever render.
function DayPill({ label }) {
  return (
    <View style={styles.dayPillRow}>
      <View style={styles.dayPill}>
        <Text style={styles.dayPillText}>{label}</Text>
      </View>
    </View>
  );
}

// FEATURE PARITY (was desktop-only until now): the "locked in" / "confirmed
// via <station>" badge next to a predicted delay — mirrors frontend/app.js's
// predictedDelayBadge() exactly, same real fields, same priority order.
// Backend's _lock_grounded_station_predictions() (app.py) already freezes a
// station's predicted_delay_minutes/predicted_eta once real speed+distance
// math (_lock_confidence_from_speed_distance(), app.py) crosses the 99.5%
// confidence threshold, OR once it's anchored to a nearby real-grounded
// point (predicted_delay_grounded_via) — this only reads that decision, it
// doesn't make one; nothing here recomputes or re-guesses anything.
// ETA line for a no-halt (passing) point ahead — ETA + minutes away only.
function IntermediateEtaLine({ stop }) {
  if (!stop.predicted_eta) return null;
  return (
    <Text style={styles.tlPredictedMuted}>
      Passing ~{stop.predicted_eta}
      {stop.minutes_away != null && stop.minutes_away <= 180 ? ` · in ${stop.minutes_away} min` : ""}
      {stop.predicted_eta_source === "gps" ? " · GPS" : ""}
    </Text>
  );
}

function PredictedDelayLine({ stop }) {
  if (stop.predicted_delay_minutes == null) return null;
  const groundedVia = stop.predicted_delay_grounded_via || stop.predicted_delay_locked_via;
  let badge = null;
  if (groundedVia) {
    badge = { text: `✓ confirmed via ${groundedVia}`, hint: `Anchored to ${groundedVia}'s own real-time-grounded arrival — locked in, won't change again this journey.` };
  } else if (stop.predicted_delay_locked) {
    badge = { text: "✓ locked in", hint: "This station's own real schedule vs. live position math grounded this prediction — locked in, won't change again this journey." };
  } else if (stop.predicted_delay_confidence === "Very High" && stop.prediction_methods_compared) {
    badge = { text: "✓ cross-verified", hint: `${stop.prediction_methods_compared} independent methods agreed within ${stop.prediction_agreement_minutes} min.` };
  }
  // FEATURE PARITY (web frontend's historicalNote/disagreementNote in
  // predictedDelayBadge()): this exact train's own real historical
  // tendency at this exact station (backend's delay_accuracy_store.
  // get_station_history_for_train), and real RailKit-vs-RailRadar
  // disagreement on already-confirmed stations this run
  // (_compute_provider_agreement) — both soft, informational notes, never
  // claiming "verified" the way the green badge above does.
  const historicalNote = stop.predicted_delay_historical_basis || null;
  // FEATURE PARITY (web frontend's historicalLabel): distinguishes this
  // app's OWN logged history from RailRadar's past-date route history
  // (used only when this app hasn't personally logged this station for
  // this train yet) — this app has no hover tooltip, so the label itself
  // is the only place this distinction is visible here.
  const historicalLabel = stop.predicted_delay_historical_source === "railradar_route_history" ? "ⓘ route history" : "ⓘ history";
  const disagreementNote = (stop.provider_disagreement_minutes != null && stop.provider_disagreement_minutes > 2)
    ? `Providers differ ~${stop.provider_disagreement_minutes}m`
    : null;
  return (
    <View style={styles.tlPredictedRow}>
      <Text style={styles.tlPredicted}>
        {stop.predicted_delay_minutes > 0 ? `~${humanDelay(stop.predicted_delay_minutes)} late` : "On time"} (predicted)
        {stop.predicted_eta ? ` · ETA ~${stop.predicted_eta}` : ""}
        {stop.minutes_away != null && stop.minutes_away <= 180 ? ` · in ${stop.minutes_away} min` : ""}
      </Text>
      {stop.predicted_eta_source === "gps" && (
        <View style={[styles.tlInfoBadge, styles.tlGpsBadge]}>
          <Text style={[styles.tlInfoBadgeText, { color: "#9a4d00" }]}>📡 GPS</Text>
        </View>
      )}
      {badge && (
        <View style={styles.tlVerifiedBadge}>
          <Text style={styles.tlVerifiedBadgeText} numberOfLines={1}>{badge.text}</Text>
        </View>
      )}
      {historicalNote && (
        <View style={styles.tlInfoBadge}>
          <Text style={styles.tlInfoBadgeText} numberOfLines={1}>{historicalLabel}</Text>
        </View>
      )}
      {disagreementNote && (
        <View style={[styles.tlInfoBadge, styles.tlInfoBadgeWarn]}>
          <Text style={[styles.tlInfoBadgeText, styles.tlInfoBadgeTextWarn]} numberOfLines={1}>⚠ {disagreementNote}</Text>
        </View>
      )}
    </View>
  );
}

// REDESIGN (RailYatri-style): the collapsed "+N No-Halt stations" row for
// a run of consecutive non-reporting stations between two real halts (see
// gps_tracking.py's group_timeline_for_display) — tap to reveal each of
// those stations with whatever real per-station figures the backend
// already computed for them (never invented here).
//
// BUGFIX ("broken pipeline"): the expanded sub-stations used to sit in
// their OWN narrower, differently-indented rail column (nested a level
// deeper inside the toggle row's body), so the connecting line visibly
// jogged sideways going into and out of an expanded group instead of
// running straight down like every other stretch of the timeline. Every
// row here — the toggle row AND each expanded sub-station — now uses the
// exact same 3-column layout (time-placeholder | tlRail | body |
// time-placeholder) as TimelineStopRow itself, at the identical widths,
// so the rail is one continuous straight line top to bottom, same as the
// reference.
//
// BUGFIX (missing live marker on a no-halt current station): the real
// current position is very often AT a non-reporting station (most of a
// route's stations are non-reporting) — this used to just draw a small
// red dot with no marker/callout at all, unlike a reporting station's
// current row. A no-halt sub-station with status "current" now gets the
// exact same TrainMarkerIcon + LiveStatusCallout as a reporting station.
function NoHaltGroupRow({
  group, expanded, onToggle,
  statusUpdatedAt, refreshCountdown, distanceRemainingToNextKm, totalCoveredKm,
  statusResponseId, reportState, onReportInaccuracy, nextStationName, segmentSpeedSignal, gpsMode,
  calloutOpen, onTrainIconPress,
}) {
  const stations = group.stations || [];
  const firstPassed = stations.length > 0 && stations[0].status === "passed";
  return (
    <>
      <View style={styles.tlRow}>
        <View style={styles.tlTimeCol} />
        <View style={styles.tlRail}>
          <View style={[styles.tlLine, firstPassed && styles.tlLinePassed]} />
        </View>
        <TouchableOpacity onPress={onToggle} style={styles.noHaltToggleBody}>
          <Text style={styles.noHaltToggleText}>
            + {group.count} No-Halt station{group.count === 1 ? "" : "s"}
            {/* BUGFIX (see the expanded sub-station row's own comment
                below): this is the SPAN across the whole collapsed group
                (last stop's distance_km minus first stop's, see _flush()
                in group_timeline_for_display) — real, but easily misread
                as a cumulative distance-from-origin figure the same way
                the sub-station rows were. "span" makes that explicit. */}
            {group.distance_km != null ? ` (${group.distance_km} km span)` : ""}
          </Text>
          <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={13} color={colors.primary} />
        </TouchableOpacity>
        <View style={styles.tlTimeCol} />
      </View>
      {expanded && stations.map((s, i) => {
        const passed = s.status === "passed";
        const current = s.status === "current";
        const dotColor = passed ? colors.success : current ? colors.danger : colors.border;
        return (
          <View key={s.code || i} style={styles.tlRow}>
            <View style={styles.tlTimeCol} />
            <View style={styles.tlRail}>
              <View style={[styles.tlLine, passed && styles.tlLinePassed]} />
              {current ? <TrainMarkerIcon onPress={onTrainIconPress} open={calloutOpen} /> : <View style={[styles.tlDot, { backgroundColor: dotColor }]} />}
              <View style={[styles.tlLine, passed && !current && styles.tlLinePassed]} />
            </View>
            <View style={styles.tlBody}>
              <Text style={styles.tlName}>
                {toDisplayCase(s.name)} <Text style={styles.tlCode}>({s.code})</Text>
                <Text style={styles.timelineKind}>  · passing</Text>
              </Text>
              {/* BUGFIX ("707.2 km covered so far ... not a real
                  cumulative distance from origin" — this row used to show
                  ONLY distance_since_last_stoppage_km (e.g. "90 km") with a
                  bare "km" label, indistinguishable from every OTHER "km"
                  figure on this screen that IS cumulative-from-origin (the
                  reporting-station rows, and the live callout's own "X km
                  covered so far" just below on the current row) — even
                  though this one deliberately means something smaller and
                  more local: distance since the last HALTING station, not
                  since origin. Both real numbers are now shown, each
                  plainly labeled, so neither can be misread as the other. */}
              {(s.distance_since_last_stoppage_km != null || s.distance_km != null) && (
                <Text style={styles.tlMeta}>
                  {s.distance_since_last_stoppage_km != null
                    ? `${s.distance_since_last_stoppage_km} km since ${group.from_station ? toDisplayCase(group.from_station) : "last stop"}`
                    : null}
                  {s.distance_since_last_stoppage_km != null && s.distance_km != null ? "  ·  " : ""}
                  {s.distance_km != null ? `${s.distance_km} km from origin` : ""}
                </Text>
              )}
              {current && calloutOpen && (
                <LiveStatusCallout
                  stop={s}
                  statusUpdatedAt={statusUpdatedAt}
                  refreshCountdown={refreshCountdown}
                  distanceRemainingToNextKm={distanceRemainingToNextKm}
                  totalCoveredKm={totalCoveredKm}
                  statusResponseId={statusResponseId}
                  reportState={reportState}
                  onReportInaccuracy={onReportInaccuracy}
                  nextStationName={nextStationName}
                  segmentSpeedSignal={segmentSpeedSignal}
                  gpsMode={gpsMode}
                />
              )}
              {!current && !passed && <IntermediateEtaLine stop={s} />}
            </View>
            <View style={styles.tlTimeCol} />
          </View>
        );
      })}
    </>
  );
}

// REDESIGN (RailYatri-style): the compact Arrival/Departure side column —
// the scheduled/expected time in small grey text, the real "actual" time
// in bold underneath (that top-grey/bottom-bold pairing is what stands in
// for "Exp"/"Act" labels, same convention the reference uses) — or a
// plain placeholder ("Src"/"Dest") for the one side that structurally
// doesn't apply to an origin/destination stop.
// BUGFIX: staleUnconfirmed (see TimelineStopRow's matching param) — when
// the provider has gone stale for this stop (most often the destination,
// once it stops updating altogether after the train has genuinely
// reached it, sometimes days before this is viewed again), a model-
// PREDICTED "actual" time can be actively wrong rather than a fair
// estimate, so it's hidden rather than shown as if it were confirmed —
// same reasoning the web frontend's timingRow() uses.
function TimeStack({ timing, staleUnconfirmed, placeholder, align }) {
  const textAlign = { textAlign: align === "right" ? "right" : "left" };
  const hasData = timing && (timing.scheduled || timing.expected || timing.actual);
  if (!hasData) {
    return (
      <View style={styles.tlTimeCol}>
        <Text style={[styles.tlTimeExp, textAlign]}>{placeholder || "—"}</Text>
      </View>
    );
  }
  const hideActual = staleUnconfirmed && timing.actual_is_predicted;
  // REDESIGN (RailYatri): scheduled time small/grey on top, the real time
  // bold underneath — red when late, green when on time.
  const late = timing.delay_minutes != null && timing.delay_minutes > 0;
  const actColor = timing.delay_minutes == null ? colors.text : late ? colors.danger : colors.success;
  return (
    <View style={styles.tlTimeCol}>
      <Text style={[styles.tlTimeExp, textAlign]}>{String(timing.scheduled || timing.expected || "—").slice(0, 5)}</Text>
      {!hideActual && !!timing.actual && (
        <Text style={[styles.tlTimeAct, { color: actColor }, textAlign]}>{String(timing.actual).slice(0, 5)}</Text>
      )}
      {!hideActual && !timing.actual && timing.expected && timing.expected !== timing.scheduled ? (
        <Text style={[styles.tlTimeAct, { color: actColor }, textAlign]}>{String(timing.expected).slice(0, 5)}</Text>
      ) : null}
    </View>
  );
}

// A single delay figure for a stop's status pill — prefers arrival (once
// the train has actually arrived) and falls back to departure (the only
// timing an origin stop has), same as the app already does for the quick
// bar's ltEffectiveDelay. Respects staleUnconfirmed the same way TimeStack
// does — a predicted-not-confirmed figure never becomes a status pill.
function stopEffectiveDelay(stop, staleUnconfirmed) {
  const arr = stop.arrival, dep = stop.departure;
  if (arr && arr.delay_minutes != null && !(staleUnconfirmed && arr.actual_is_predicted)) return arr.delay_minutes;
  if (dep && dep.delay_minutes != null && !(staleUnconfirmed && dep.actual_is_predicted)) return dep.delay_minutes;
  return null;
}

// One row of the RailYatri-style running-status timeline: Arrival time
// (left) | connecting vertical line + dot, train icon for the current
// stop, station name/meta/status pill (middle) | Departure time (right).
// Mirrors the reference's own Arrival | Station | Departure layout.
function TimelineStopRow({
  stop, isFirst, isLast, rowRef, journeyLikelyComplete,
  statusUpdatedAt, refreshCountdown, distanceRemainingToNextKm, totalCoveredKm,
  statusResponseId, reportState, onReportInaccuracy, nextStationName, segmentSpeedSignal,
  alertArmed, alertBlocked, onBellPress, gpsMode,
  calloutOpen, onTrainIconPress,
}) {
  // BUGFIX: once the journey looks likely complete (see
  // computeJourneyLikelyComplete near the top of this file), the train
  // has genuinely already gone through every remaining station — even
  // ones RailKit still shows as "upcoming", or a stuck "current" that
  // never advanced past the origin (train 20707 kept SECUNDERABAD JN
  // "current" for 9+ hours after actually finishing at VISAKHAPATNAM).
  // Render every such row as passed (real "passed" rows are untouched)
  // instead of leaving them looking not-yet-reached, and stop showing a
  // live "train is here" callout on a station the train isn't really at
  // anymore — same reasoning as the map marker and quick bar's "Last
  // known" fallback. staleUnconfirmed likewise applies to every row once
  // the journey looks done (harmless on a genuinely-passed row with a
  // real recorded time, since TimeStack only acts on actual_is_predicted
  // rows).
  const staleUnconfirmed = !!journeyLikelyComplete;
  const isCurrent = stop.status === "current" && !journeyLikelyComplete;
  const isPassed = stop.status === "passed" || journeyLikelyComplete;
  const dotColor = isPassed ? colors.success : isCurrent ? colors.danger : colors.border;
  const metaBits = [];
  if (stop.halt_minutes != null && stop.halt_minutes !== "") metaBits.push(`Halt: ${stop.halt_minutes} min`);
  if (stop.distance_km != null) metaBits.push(`${stop.distance_km} km`);
  const effectiveDelay = stopEffectiveDelay(stop, staleUnconfirmed);
  // A status pill only means something once the stop has a real recorded
  // arrival/departure (passed or current) — an "upcoming" stop gets the
  // separate predicted-delay line below instead, never a confident pill.
  const showStatusPill = (isPassed || isCurrent) && effectiveDelay != null;
  return (
    <View ref={rowRef} style={styles.tlRow}>
      <TimeStack timing={stop.arrival} staleUnconfirmed={staleUnconfirmed} placeholder={isFirst ? "Src" : null} />
      <View style={styles.tlRail}>
        {/* BUGFIX ("after visiting every station it should be green"): the
            rail segment leading INTO an already-passed stop, and the one
            LEAVING it (as long as the train has moved on beyond it), are
            now colored green too — not just the dot — so the whole
            already-traveled stretch reads as a continuous green trail
            behind the train, same as the reference app, instead of a
            uniform grey line regardless of what's actually been covered. */}
        <View style={[styles.tlLine, isFirst && styles.tlLineHidden, isPassed && styles.tlLinePassed]} />
        {isCurrent ? <TrainMarkerIcon onPress={onTrainIconPress} open={calloutOpen} /> : <View style={[styles.tlDot, { backgroundColor: dotColor }]} />}
        <View style={[styles.tlLine, isLast && styles.tlLineHidden, isPassed && !isCurrent && styles.tlLinePassed]} />
      </View>
      <View style={styles.tlBody}>
        <View style={styles.tlNameRow}>
          <Text style={[styles.tlName, styles.tlNameFlex]}>
            {stop.name} <Text style={styles.tlCode}>({stop.code})</Text>
            {stop.kind === "intermediate" ? <Text style={styles.timelineKind}>  · passing</Text> : null}
          </Text>
          {/* FEATURE: per-station Delay Alert bell — on every reporting
              station the train hasn't reached yet (a delay alert for a
              station already passed can't fire), plus on any station that
              still has an alert armed so it can be edited/stopped. */}
          {onBellPress && stop.kind !== "intermediate" && stop.code && (alertArmed || (!isPassed && !isCurrent && !alertBlocked)) ? (
            <TouchableOpacity
              onPress={() => onBellPress(stop)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={[styles.tlBell, alertArmed && styles.tlBellArmed]}
              accessibilityLabel={`Delay alert for ${stop.name}`}
            >
              <Ionicons name={alertArmed ? "notifications" : "notifications-outline"} size={16} color={alertArmed ? "#fff" : colors.primary} />
            </TouchableOpacity>
          ) : null}
        </View>
        {metaBits.length > 0 && <Text style={styles.tlMeta}>{metaBits.join(" | ")}</Text>}
        {showStatusPill && <DelayPill minutes={effectiveDelay} />}
        {isCurrent && calloutOpen && (
          <LiveStatusCallout
            stop={stop}
            statusUpdatedAt={statusUpdatedAt}
            refreshCountdown={refreshCountdown}
            distanceRemainingToNextKm={distanceRemainingToNextKm}
            totalCoveredKm={totalCoveredKm}
            statusResponseId={statusResponseId}
            reportState={reportState}
            onReportInaccuracy={onReportInaccuracy}
            nextStationName={nextStationName}
            segmentSpeedSignal={segmentSpeedSignal}
            gpsMode={gpsMode}
          />
        )}
        {/* BUGFIX: suppressed when staleUnconfirmed — see TimeStack's
            matching comment above. A confident-looking predicted delay is
            worse than none once the provider has stopped updating this
            stop altogether (most often the destination, well after the
            train has genuinely reached it). */}
        {!staleUnconfirmed && stop.status === "upcoming" && <PredictedDelayLine stop={stop} />}
      </View>
      <TimeStack timing={stop.departure} staleUnconfirmed={staleUnconfirmed} placeholder={isLast && journeyLikelyComplete ? "Dest" : null} align="right" />
    </View>
  );
}

const styles = StyleSheet.create({
  bgTrackRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: spacing.sm },
  bgTrackText: { flex: 1, fontSize: 12, color: colors.textMuted },
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  row: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  half: { flex: 1 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.textMuted, marginBottom: spacing.xs },
  dateField: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.bg,
    marginBottom: spacing.md,
  },
  dateFieldText: { flex: 1, fontSize: 15, color: colors.text, fontWeight: "600" },
  refreshRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  refreshText: { fontSize: 12, color: colors.primary, fontWeight: "600" },

  // REDESIGN (RailYatri-style quick bar + running-status timeline).
  routeHeaderText: { fontSize: 12.5, fontWeight: "600", color: colors.textMuted, marginBottom: 6 },
  quickBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#eef4fb", borderWidth: 1, borderColor: "#cfe0f3",
    borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12,
    marginBottom: spacing.sm,
  },
  quickBarIconWrap: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: colors.primary,
    alignItems: "center", justifyContent: "center",
  },
  quickBarText: { flex: 1, fontSize: 13, color: colors.text },
  quickBarStation: { fontWeight: "700", color: colors.primary },
  quickBarEta: { fontSize: 12, color: colors.textMuted },
  moreStatsToggle: { alignSelf: "flex-start", marginBottom: spacing.sm, paddingVertical: 4 },
  moreStatsToggleText: { fontSize: 12.5, fontWeight: "600", color: colors.primary },
  delayPill: { borderRadius: 4, paddingVertical: 3, paddingHorizontal: 8, alignSelf: "flex-start", marginTop: 4 },
  delayPillSmall: { paddingVertical: 1, paddingHorizontal: 5 },
  delayPillText: { fontSize: 12, fontWeight: "700", color: "#fff" },
  delayPillTextSmall: { fontSize: 10.5 },
  timingLine: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3, flexWrap: "wrap" },
  timingLabel: { fontSize: 10.5, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3, width: 52 },
  timingVal: { fontSize: 11.5, color: colors.text },
  timingValMuted: { fontSize: 11.5, color: colors.textMuted, fontStyle: "italic" },

  // REDESIGN (RailYatri-style): Arrival | Station | Departure column
  // header, the per-stop time stacks either side of the rail, and the
  // centered "DayN: <date>" / collapsible "+N No-Halt stations" rows.
  tlColHeaderRow: {
    flexDirection: "row", justifyContent: "space-between",
    marginBottom: spacing.sm, paddingHorizontal: 2,
  },
  tlColHeaderSide: { fontSize: 11, fontWeight: "700", color: colors.textMuted, width: 56 },
  tlColHeaderMid: { fontSize: 11, fontWeight: "700", color: colors.textMuted, flex: 1, textAlign: "center" },
  tlColHeaderRight: { textAlign: "right" },
  tlTimeCol: { width: 56 },
  tlTimeExp: { fontSize: 11, color: colors.textMuted },
  tlTimeAct: { fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 1 },
  dayPillRow: { alignItems: "center", marginVertical: spacing.sm },
  dayPill: {
    borderWidth: 1, borderColor: colors.primary, borderRadius: radius.pill,
    paddingVertical: 4, paddingHorizontal: 14, backgroundColor: colors.bg,
  },
  dayPillText: { fontSize: 11.5, fontWeight: "700", color: colors.primary },
  noHaltWrap: { flexDirection: "row" },
  noHaltBody: { flex: 1, paddingLeft: spacing.sm, paddingVertical: 4 },
  noHaltToggle: { flexDirection: "row", alignItems: "center", gap: 4 },
  // BUGFIX ("broken pipeline"): the toggle row now shares the exact same
  // tlTimeCol/tlRail column widths as every other timeline row (see
  // NoHaltGroupRow) so its rail segment lines up perfectly with the ones
  // above and below it — this is its "body" cell, sized like tlBody.
  noHaltToggleBody: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 4,
    paddingLeft: spacing.sm, paddingVertical: spacing.sm,
  },
  noHaltToggleText: { fontSize: 12, fontWeight: "600", color: colors.primary },
  noHaltExpanded: {
    marginTop: 6, paddingLeft: spacing.sm, borderLeftWidth: 2, borderLeftColor: colors.border,
  },
  noHaltStationRow: { marginBottom: 6 },
  noHaltStationText: { fontSize: 12, color: colors.text },
  tlRow: { flexDirection: "row", alignItems: "flex-start" },
  tlRail: { width: 26, alignItems: "center" },
  tlLine: { width: 2, flex: 1, backgroundColor: colors.border, minHeight: 8 },
  tlLineHidden: { backgroundColor: "transparent" },
  tlLinePassed: { backgroundColor: colors.success },
  tlDot: { width: 10, height: 10, borderRadius: 5, marginVertical: 3 },
  tlTrainIconWrap: {
    width: 20, height: 20, borderRadius: 10, backgroundColor: colors.danger,
    alignItems: "center", justifyContent: "center", marginVertical: 2,
  },
  tlBody: { flex: 1, paddingBottom: spacing.md, paddingLeft: spacing.sm },
  tlName: { fontSize: 13, fontWeight: "700", color: colors.text },
  tlCode: { fontWeight: "400", color: colors.textMuted, fontSize: 12 },
  tlMeta: { fontSize: 10.5, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3, marginTop: 1 },
  tlCurrentCallout: {
    backgroundColor: "#fff4f3", borderWidth: 1, borderColor: colors.danger,
    borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8, marginTop: 4, alignSelf: "flex-start",
  },
  tlCurrentCalloutText: { fontSize: 11.5, color: colors.danger, fontWeight: "600" },
  tlPredicted: { fontSize: 11, color: colors.warning, marginTop: 3 },
  tlPredictedRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginTop: 3, gap: 4 },
  // FEATURE PARITY: same "✓ locked in / confirmed via X" look as the web
  // frontend's .live-timeline__verified badge (green outline pill).
  tlVerifiedBadge: {
    borderWidth: 1, borderColor: colors.success, backgroundColor: "#e2f6e9",
    borderRadius: 3, paddingHorizontal: 6, paddingVertical: 1, maxWidth: 180,
  },
  tlVerifiedBadgeText: { fontSize: 9.5, fontWeight: "700", color: colors.success },
  // FEATURE PARITY: same neutral/amber "ⓘ history" / "⚠ providers differ"
  // informational notes as the web frontend's .live-timeline__info /
  // --warn (see predictedDelayBadge() there) - real signals, but not a
  // "verified" claim the way the green badge above is.
  tlInfoBadge: {
    borderWidth: 1, borderColor: "#cbd5e1", backgroundColor: "#f1f5f9",
    borderRadius: 3, paddingHorizontal: 6, paddingVertical: 1, maxWidth: 180,
  },
  tlInfoBadgeText: { fontSize: 9, fontWeight: "600", color: "#64748b" },
  tlInfoBadgeWarn: { borderColor: "#d97706", backgroundColor: "#fef3c7" },
  tlInfoBadgeTextWarn: { color: "#92400e" },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: spacing.sm },
  badgeText: { fontSize: 12, fontWeight: "600" },
  webNotice: { flexDirection: "row", gap: 6, marginTop: spacing.md, alignItems: "flex-start" },
  webNoticeText: { fontSize: 11, color: colors.textMuted, flex: 1, lineHeight: 16 },
  liteNotice: { fontSize: 10.5, color: colors.textMuted, fontStyle: "italic", marginTop: spacing.sm, lineHeight: 15 },
  mapToggleBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start",
    marginTop: spacing.sm, paddingVertical: 6, paddingHorizontal: 12,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.chip,
  },
  mapToggleBtnText: { fontSize: 12.5, fontWeight: "600", color: colors.primary },
  // The map container is ALWAYS mounted (never conditionally rendered) so
  // the Leaflet instance created inside it survives repeated show/hide —
  // mapBoxHidden just collapses it to zero height, matching the show-again
  // "invalidateSize()" nudge already wired up in the toggle effect above.
  mapBox: { height: 220, borderRadius: radius.md, overflow: "hidden", borderWidth: 1, borderColor: colors.border, marginTop: spacing.sm },
  mapBoxHidden: { height: 0, borderWidth: 0, marginTop: 0 },
  mapInner: { flex: 1, minHeight: 220 },
  tripSummaryLine: { fontSize: 12.5, color: colors.text, lineHeight: 17 },
  infoRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  infoLabel: { fontSize: 13, color: colors.textMuted },
  infoValue: { fontSize: 13, color: colors.text, fontWeight: "600", flexShrink: 1, textAlign: "right" },
  errorText: { fontSize: 12, color: colors.danger, marginTop: spacing.sm },
  basisList: { marginTop: spacing.sm },
  basisItem: { fontSize: 12, color: colors.textMuted, marginBottom: 2 },
  timelineRow: { flexDirection: "row", marginBottom: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 4, marginRight: spacing.sm },
  timelineTextWrap: { flex: 1 },
  timelineName: { fontSize: 13, fontWeight: "600", color: colors.text },
  timelineKind: { fontSize: 11, color: colors.textMuted, fontWeight: "400" },
  timelineTimes: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  // FEATURE: Dynamic Re-route Suggestions During Live Tracking.
  rerouteTitle: { fontSize: 13, fontWeight: "700", color: colors.danger, marginBottom: 4 },
  rerouteNote: { fontSize: 12.5, color: colors.text, lineHeight: 17, marginBottom: 6 },
  rerouteSubhead: { fontSize: 12, fontWeight: "700", color: colors.primary, marginTop: 6, marginBottom: 2 },
  rerouteAltLine: { fontSize: 12, color: colors.text, marginBottom: 2 },
  rerouteDisclaimer: { fontSize: 10.5, color: colors.textMuted, fontStyle: "italic", marginTop: 6 },

  // REDESIGN (RailYatri-style live position marker): white rounded-square
  // icon + small red circular pin badge overlapping its corner.
  trainMarkerWrap: { width: 28, height: 28, marginVertical: 2 },
  trainMarkerSquare: {
    width: 26, height: 26, borderRadius: 7, backgroundColor: "#fff",
    borderWidth: 1.5, borderColor: colors.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },
  trainMarkerPinBadge: {
    position: "absolute", right: -4, bottom: -4,
    width: 15, height: 15, borderRadius: 7.5, backgroundColor: colors.danger,
    borderWidth: 1.5, borderColor: "#fff",
    alignItems: "center", justifyContent: "center",
  },

  // REDESIGN (RailYatri-style live position marker): the speech-bubble
  // callout — "As of X ago" + refresh countdown, distance to next station,
  // distance covered so far, and Report Inaccuracy.
  liveCallout: {
    backgroundColor: "#fff", borderWidth: 1, borderColor: colors.danger,
    borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, marginTop: 4,
    alignSelf: "stretch", maxWidth: 260,
    shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1,
  },
  liveCalloutHeadRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 3 },
  liveCalloutAsOf: { fontSize: 10.5, color: colors.textMuted, fontStyle: "italic" },
  liveCalloutRefreshWrap: { flexDirection: "row", alignItems: "center", gap: 2 },
  liveCalloutRefreshText: { fontSize: 10, color: colors.textMuted },
  liveCalloutMain: { fontSize: 11.5, color: colors.danger, fontWeight: "600", marginBottom: 2 },
  liveCalloutBold: { fontSize: 12, fontWeight: "700", color: colors.text },
  liveCalloutMuted: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  liveCalloutSpeedWarn: { fontSize: 10.5, fontWeight: "600", color: "#92400e", marginTop: 2 },
  liveCalloutReportLink: { alignSelf: "flex-end", marginTop: 4 },
  liveCalloutReportText: { fontSize: 11, color: "#4a90d9", textDecorationLine: "underline" },

  // REDESIGN (RailYatri-style): connected-dot mini-rail for an expanded
  // no-halt group's stations.
  noHaltRow: { flexDirection: "row" },
  noHaltRail: { width: 18, alignItems: "center" },
  noHaltRailLine: { width: 2, flex: 1, backgroundColor: colors.border, minHeight: 6 },
  noHaltDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border, marginVertical: 2 },
  noHaltRowBody: { flex: 1, paddingLeft: 6, paddingBottom: 6 },
  noHaltStationDist: { fontSize: 10.5, color: colors.textMuted, marginTop: 1 },

  // REDESIGN (RailYatri-style bottom sticky bar): "Next: X in N mins" +
  // Coach layout / Time Table quick-action buttons pinned to the bottom.
  contentWithBar: { paddingBottom: 76 },
  bottomBar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    gap: 8, backgroundColor: "#fff", borderTopWidth: 1, borderTopColor: colors.border,
    paddingVertical: 10, paddingHorizontal: spacing.lg,
    shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 6, shadowOffset: { width: 0, height: -2 }, elevation: 6,
  },
  bottomBarInfo: { flexShrink: 1 },
  bottomBarLabel: { fontSize: 12.5, color: colors.text, fontWeight: "600" },
  bottomBarStation: { color: colors.primary, fontWeight: "700" },
  bottomBarDelay: { fontSize: 11, fontWeight: "700", marginTop: 1 },
  bottomBarDelayLate: { color: colors.danger },
  bottomBarDelayOnTime: { color: colors.success },
  bottomBarActions: { flexDirection: "row", gap: 6 },
  bottomBarBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill,
    paddingVertical: 6, paddingHorizontal: 10, backgroundColor: colors.chip,
  },
  bottomBarBtnText: { fontSize: 11, fontWeight: "600", color: colors.primary },

  // Delay Alert / Smart Alarm (moved here from MoreToolsScreen.js)
  resultLine: { fontSize: 13, color: colors.text, marginTop: spacing.sm, lineHeight: 18 },
  dangerText: { color: colors.danger, fontWeight: "700" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: spacing.xs },
  alarmChip: {
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.pill,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: "#fff",
  },
  alarmChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  alarmChipText: { fontSize: 13, fontWeight: "600", color: colors.text },
  alarmChipTextActive: { color: "#fff" },
  removeAlarmText: { fontSize: 12.5, fontWeight: "600", color: colors.danger, textAlign: "center" },

  // Per-station Delay Alert bell (TimelineStopRow) — outline when idle,
  // filled when an alert is armed for that station.
  tlNameRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  tlNameFlex: { flex: 1 },
  tlBell: {
    width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: "#cfe0f3",
    backgroundColor: "#eef4fb", alignItems: "center", justifyContent: "center",
  },
  tlBellArmed: { backgroundColor: colors.primary, borderColor: colors.primary },

  everyRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: spacing.sm },
  everyLabel: { fontSize: 12.5, fontWeight: "600", color: colors.text, marginRight: 2 },
  everyChip: {
    paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: "#fff",
  },
  everyChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  everyChipText: { fontSize: 12, fontWeight: "600", color: colors.text },
  everyChipTextActive: { color: "#fff" },
  everySetBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.md, backgroundColor: colors.primary },
  everySetBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  // REDESIGN (RailYatri-style header / status / banners / GPS prompt).
  ryHeader: {
    backgroundColor: "#fff", borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginBottom: spacing.sm,
  },
  ryHeaderTop: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  ryTrainTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  ryTrainSub: { fontSize: 12.5, color: colors.textMuted, marginTop: 2 },
  ryDateBtn: {
    flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.primary,
    borderRadius: 6, paddingVertical: 6, paddingHorizontal: 12,
  },
  ryDateBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  ryHeaderRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: spacing.sm, flexWrap: "wrap" },
  ryIconBtn: {
    width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: "#cfe0f3",
    backgroundColor: "#eef4fb", alignItems: "center", justifyContent: "center",
  },
  ryStopBtn: { paddingVertical: 5, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.danger },
  ryStopBtnText: { color: colors.danger, fontWeight: "700", fontSize: 12 },
  badgeRowInline: { flexDirection: "row", alignItems: "center", gap: 5 },
  modeSwitch: {
    flexDirection: "row", marginTop: spacing.sm, borderRadius: radius.pill, borderWidth: 1,
    borderColor: colors.primary, overflow: "hidden",
  },
  modeBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingVertical: 7, backgroundColor: "#fff" },
  modeBtnActive: { backgroundColor: colors.primary },
  modeBtnText: { fontSize: 12.5, fontWeight: "600", color: colors.primary },
  modeBtnTextActive: { color: "#fff" },
  ryRedBanner: {
    flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#F2453D",
    borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, marginBottom: spacing.sm,
  },
  ryAlertBanner: {
    flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.primary,
    borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, marginBottom: spacing.sm,
  },
  ryRedBannerText: { flex: 1, color: "#fff", fontSize: 13, fontWeight: "600", lineHeight: 18 },
  ryInfoBanner: {
    flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#eef4fb", borderWidth: 1,
    borderColor: "#cfe0f3", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, marginBottom: spacing.sm,
  },
  ryInfoBannerText: { flex: 1, color: colors.text, fontSize: 12.5 },
  ryLoadingCard: {
    flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#fff", borderRadius: 8,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm,
  },
  ryLoadingText: { fontSize: 13, color: colors.textMuted },
  ryStatusCard: {
    flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#fff",
    borderRadius: 10, borderWidth: 1, borderColor: "#dbe6f5", paddingVertical: 12, paddingHorizontal: 12,
    marginTop: spacing.sm, marginBottom: spacing.sm,
    shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1,
  },
  ryStatusIcon: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primary,
    alignItems: "center", justifyContent: "center",
  },
  ryStatusText: { fontSize: 15, fontWeight: "700", color: colors.text, lineHeight: 20 },
  ryStatusSub: { fontSize: 12.5, color: colors.textMuted, marginTop: 2 },
  tlGpsBadge: { borderColor: colors.accent, backgroundColor: "#FFF4E5" },
  tlPredictedMuted: { fontSize: 10.5, color: colors.textMuted, marginTop: 2 },
  askBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", padding: 24 },
  askCard: { width: "100%", maxWidth: 340, backgroundColor: "#fff", borderRadius: 14, padding: 20, alignItems: "center" },
  askClose: { position: "absolute", top: 10, right: 10 },
  askIllustration: {
    width: 110, height: 110, borderRadius: 55, backgroundColor: "#2F86E0",
    alignItems: "center", justifyContent: "center", marginTop: 6, marginBottom: 14,
  },
  askTitle: { fontSize: 17, fontWeight: "700", color: colors.text, textAlign: "center" },
  askSub: { fontSize: 12.5, color: colors.textMuted, textAlign: "center", marginTop: 6, lineHeight: 17 },
  askBtnRow: { flexDirection: "row", gap: 12, marginTop: 18, alignSelf: "stretch" },
  askBtn: { flex: 1, paddingVertical: 11, borderRadius: radius.pill, alignItems: "center" },
  askBtnYes: { backgroundColor: "#0B2F5E" },
  askBtnNo: { backgroundColor: "#E3EEFB" },
  askBtnYesText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  askBtnNoText: { color: colors.primary, fontWeight: "700", fontSize: 15 },
});