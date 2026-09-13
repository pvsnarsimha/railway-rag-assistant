import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Share, Linking } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { buildTrackingWsUrl, saveTripSummary, buildTrackShareUrl, buildTripShareUrl } from "../api/railwayApi";
import { formatDelayDuration } from "../utils/formatDelay";

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
// from the date this train was tracked from (the optional "Date" field
// above, defaulting to today) plus (day - 1).
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
function formatJourneyDayLabel(startDate, dayNumber) {
  const d = new Date(startDate);
  d.setDate(d.getDate() + (dayNumber - 1));
  return d.toLocaleDateString("en-IN", { month: "short", day: "numeric" });
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

export default function LiveTrackingScreen() {
  const { wsBaseUrl, apiBaseUrl } = useSettings();
  const [trainNumber, setTrainNumber] = useState("");
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [trackDate, setTrackDate] = useState("");
  const [connection, setConnection] = useState("idle");
  const [payload, setPayload] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const wsRef = useRef(null);

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
  const reconnectDelayRef = useRef(3000);
  // RailYatri-style collapsed "+N No-Halt stations" groups — which ones the
  // user has tapped open, keyed by index within timelineGrouped below.
  const [expandedGroups, setExpandedGroups] = useState({});

  // FEATURE: "Train on map" toggle — see the module-level comment above
  // loadLeaflet() for why a real Leaflet map is possible here despite
  // react-native-maps having no web target.
  const [showMap, setShowMap] = useState(false);
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
    }
  }, []);

  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      disconnect();
    };
  }, [disconnect]);

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
    const isSameTrainReconnect = params.trainNumber === lastConnectedTrainRef.current;
    wsRef.current?.close();
    wsRef.current = null;
    setConnection("connecting");
    if (!isRetry) {
      setPayload(null);
      setDelaySparkline([]);
      tripSummaryShownKeyRef.current = null;
      setTripSummary(null);
      setTripSummaryShareStatus(null);
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
    lastConnectedTrainRef.current = params.trainNumber;

    const url = buildTrackingWsUrl(wsBaseUrl, params.trainNumber, {
      date: params.date || undefined,
      source: params.source || undefined,
      dest: params.dest || undefined,
    });

    const socket = new WebSocket(url);
    wsRef.current = socket;
    socket.onopen = () => {
      setConnection("open");
      // A successful connection means whatever went wrong last time is
      // over — back off from scratch next time, instead of the delay
      // staying stretched out from an earlier stretch of bad connectivity.
      reconnectDelayRef.current = 3000;
    };
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setPayload(data);

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
      reconnectDelayRef.current = Math.min(delay * 1.5, 20000);
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
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    reconnectDelayRef.current = 3000;
    manualStopRef.current = false;
    const params = {
      trainNumber: trainNumber.trim(),
      date: trackDate.trim(),
      source: source.trim(),
      dest: dest.trim(),
    };
    activeParamsRef.current = params;
    openSocket(params, false);
  }

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
  const journeyStartDate = parseTrackDateInput(trackDate);

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <SectionCard title="Track a train" subtitle="Streams a position + delay + crowd update every ~5s.">
        <LabeledInput label="Train number" placeholder="e.g. 12709" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" />
        <LabeledInput label="Date (optional \u2014 defaults to today)" placeholder="DD-MM-YYYY" value={trackDate} onChangeText={setTrackDate} />
        <View style={styles.row}>
          <LabeledInput label="Source (optional)" placeholder="e.g. SC" value={source} onChangeText={setSource} style={styles.half} />
          <LabeledInput label="Dest (optional)" placeholder="e.g. BZA" value={dest} onChangeText={setDest} style={styles.half} />
        </View>
        <View style={styles.row}>
          <PrimaryButton title={connection === "open" ? "Reconnect" : "Start tracking"} onPress={connect} loading={connection === "connecting"} style={styles.half} />
          <PrimaryButton title="Stop" variant="secondary" onPress={disconnect} style={styles.half} />
        </View>
        <View style={styles.row}>
          <ConnectionBadge connection={connection} />
          {connection === "open" && (
            <TouchableOpacity onPress={refreshNow} disabled={refreshing} style={styles.refreshRow}>
              <Ionicons name="refresh" size={14} color={colors.primary} />
              <Text style={styles.refreshText}>
                {refreshing ? "Refreshing\u2026" : lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : "Refresh now"}
              </Text>
            </TouchableOpacity>
          )}
          {/* FEATURE: Shareable read-only tracking link */}
          {trainNumber.trim() && (
            <TouchableOpacity onPress={shareTrackingLink} style={styles.refreshRow}>
              <Ionicons name="link-outline" size={14} color={colors.primary} />
              <Text style={styles.refreshText}>Share link</Text>
            </TouchableOpacity>
          )}
        </View>
        {shareLinkNote && <Text style={styles.errorText}>{shareLinkNote}</Text>}
        <TouchableOpacity onPress={toggleMap} style={styles.mapToggleBtn}>
          <Ionicons name="map-outline" size={14} color={colors.primary} />
          <Text style={styles.mapToggleBtnText}>{showMap ? "Hide train on map" : "🗺️ Train on map"}</Text>
        </TouchableOpacity>
        {mapError && <Text style={styles.errorText}>{mapError}</Text>}
        <View style={[styles.mapBox, !showMap && styles.mapBoxHidden]}>
          <View ref={mapContainerRef} style={styles.mapInner} />
        </View>
        {showMap && (
          <Text style={styles.webNoticeText}>
            {payload ? "Route + live position for this train." : "Start tracking above to plot this train's route and position."}
          </Text>
        )}
      </SectionCard>

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
          {/* REDESIGN (RailYatri-style header): train number + real route
              (first/last reported stops — never invented), then a plain-
              English running-status line. When the journey is genuinely
              done, this reads "Train has reached destination." exactly
              like RailYatri's own completed-run page; otherwise it's the
              same "Next station · ETA" summary as before. */}
          {timeline.length >= 2 && (
            <Text style={styles.routeHeaderText}>
              Train {trainNumber.trim()} · {timeline[0].name || timeline[0].code} {"→"} {timeline[timeline.length - 1].name || timeline[timeline.length - 1].code}
            </Text>
          )}
          <View ref={quickBarRef} style={styles.quickBar}>
            <View style={styles.quickBarIconWrap}>
              <Ionicons name="train" size={16} color={colors.textInverse} />
            </View>
            {ltJourneyLikelyComplete ? (
              <Text style={styles.quickBarText}>Train has reached destination.</Text>
            ) : (
              <Text style={styles.quickBarText}>
                Next:{" "}
                <Text style={styles.quickBarStation}>{payload.next_station || "—"}</Text>
                <Text style={styles.quickBarEta}>  ETA {payload.next_station_live_eta || payload.next_station_expected_arrival || "—"}</Text>
              </Text>
            )}
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
                    />
                  );
                }
                const dayNum = journeyDayNumber(entry);
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
                    />
                  </React.Fragment>
                );
              });
            })()}
          </SectionCard>
        </>
      )}
    </ScrollView>
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
function DelayPill({ minutes, small }) {
  if (minutes == null) return null;
  const late = minutes > 0;
  const early = minutes < 0;
  const bg = late ? colors.danger : colors.success;
  // minutes === 0 reads as a plain "Ontime" pill, same one-word wording as
  // the RailYatri reference, rather than "0m on time".
  const label = minutes === 0 ? "Ontime" : `${late ? "+" : ""}${formatDelayDuration(minutes)}${late ? " late" : " early"}`;
  return (
    <View style={[styles.delayPill, { backgroundColor: bg }, small && styles.delayPillSmall]}>
      <Text style={[styles.delayPillText, small && styles.delayPillTextSmall]}>{label}</Text>
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

// REDESIGN (RailYatri-style): the collapsed "+N No-Halt stations" row for
// a run of consecutive non-reporting stations between two real halts (see
// gps_tracking.py's group_timeline_for_display) — tap to reveal each of
// those stations with whatever real per-station figures the backend
// already computed for them (never invented here).
function NoHaltGroupRow({ group, expanded, onToggle }) {
  return (
    <View style={styles.noHaltWrap}>
      <View style={styles.tlRail}>
        <View style={styles.tlLine} />
      </View>
      <View style={styles.noHaltBody}>
        <TouchableOpacity onPress={onToggle} style={styles.noHaltToggle}>
          <Text style={styles.noHaltToggleText}>
            + {group.count} No-Halt station{group.count === 1 ? "" : "s"}
            {group.distance_km != null ? ` (${group.distance_km} km)` : ""}
          </Text>
          <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={13} color={colors.primary} />
        </TouchableOpacity>
        {expanded && (
          <View style={styles.noHaltExpanded}>
            {(group.stations || []).map((s, i) => (
              <View key={s.code || i} style={styles.noHaltStationRow}>
                <Text style={styles.noHaltStationText}>
                  {s.name} <Text style={styles.tlCode}>({s.code})</Text>
                  {s.distance_since_last_stoppage_km != null ? ` · ${s.distance_since_last_stoppage_km} km` : ""}
                </Text>
                {s.predicted_delay_minutes != null && (
                  <Text style={styles.tlPredicted}>
                    ~{formatDelayDuration(s.predicted_delay_minutes)} late (predicted)
                    {s.predicted_eta ? ` · ETA ~${s.predicted_eta}` : ""}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
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
  return (
    <View style={styles.tlTimeCol}>
      <Text style={[styles.tlTimeExp, textAlign]}>{timing.expected || timing.scheduled || "—"}</Text>
      {!hideActual && !!timing.actual && <Text style={[styles.tlTimeAct, textAlign]}>{timing.actual}</Text>}
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
function TimelineStopRow({ stop, isFirst, isLast, rowRef, journeyLikelyComplete }) {
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
        <View style={[styles.tlLine, isFirst && styles.tlLineHidden]} />
        {isCurrent ? (
          <View style={styles.tlTrainIconWrap}>
            <Ionicons name="train" size={13} color="#fff" />
          </View>
        ) : (
          <View style={[styles.tlDot, { backgroundColor: dotColor }]} />
        )}
        <View style={[styles.tlLine, isLast && styles.tlLineHidden]} />
      </View>
      <View style={styles.tlBody}>
        <Text style={styles.tlName}>
          {stop.name} <Text style={styles.tlCode}>({stop.code})</Text>
          {stop.kind === "intermediate" ? <Text style={styles.timelineKind}>  · passing</Text> : null}
        </Text>
        {metaBits.length > 0 && <Text style={styles.tlMeta}>{metaBits.join(" | ")}</Text>}
        {showStatusPill && <DelayPill minutes={effectiveDelay} />}
        {isCurrent && (
          <View style={styles.tlCurrentCallout}>
            <Text style={styles.tlCurrentCalloutText}>
              🚆 Train is currently here{stop.halt_minutes ? ` · halt ${stop.halt_minutes} min` : ""}
            </Text>
          </View>
        )}
        {/* BUGFIX: suppressed when staleUnconfirmed — see TimeStack's
            matching comment above. A confident-looking predicted delay is
            worse than none once the provider has stopped updating this
            stop altogether (most often the destination, well after the
            train has genuinely reached it). */}
        {!staleUnconfirmed && stop.status === "upcoming" && stop.predicted_delay_minutes != null && (
          <Text style={styles.tlPredicted}>
            ~{formatDelayDuration(stop.predicted_delay_minutes)} late (predicted)
            {stop.predicted_eta ? ` · ETA ~${stop.predicted_eta}` : ""}
          </Text>
        )}
      </View>
      <TimeStack timing={stop.departure} staleUnconfirmed={staleUnconfirmed} placeholder={isLast && journeyLikelyComplete ? "Dest" : null} align="right" />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  row: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  half: { flex: 1 },
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
});