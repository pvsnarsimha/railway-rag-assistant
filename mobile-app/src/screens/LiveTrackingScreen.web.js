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
  // FEATURE: auto-scroll straight down to the current-position quick bar
  // the first time real tracking data arrives for a train, instead of
  // leaving the connect form at the top and making the user scroll down
  // manually to see where the train actually is.
  const quickBarRef = useRef(null);
  const autoScrolledRef = useRef(false);
  // More specific than the quick bar above: once the "Running status" list
  // actually has a current-station row, scroll straight to IT instead (see
  // the effect below, which runs after the quick-bar one so it wins when
  // both are available on the same update).
  const currentStationRowRef = useRef(null);
  const timelineAutoScrolledRef = useRef(false);

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
  }, [showMap, payload?.lat, payload?.lng, payload?.current_station, payload?.train_number]);

  // Fires once per train (see the autoScrolledRef reset in connect()) the
  // first time a real payload arrives, scrolling the quick bar (map sits
  // just above it) into view. quickBarRef is a <View ref> which, on this
  // web build, forwards straight to the underlying DOM node — same
  // ref-is-a-div pattern this file already relies on for the Leaflet map
  // container above.
  useEffect(() => {
    if (!payload || autoScrolledRef.current || !quickBarRef.current) return;
    autoScrolledRef.current = true;
    requestAnimationFrame(() => {
      quickBarRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    });
  }, [payload]);

  // Runs after the quick-bar effect above (declared later, so its
  // rAF-scheduled scroll executes second on the same update and wins) —
  // once the current-station row actually exists in the "Running status"
  // list (currentStationRowRef, wired up via TimelineStopRow's rowRef
  // prop below), jump straight to it instead of just the quick bar. If it
  // isn't in the DOM yet on this particular payload, this simply retries
  // on the next one.
  useEffect(() => {
    if (!payload || timelineAutoScrolledRef.current || !currentStationRowRef.current) return;
    timelineAutoScrolledRef.current = true;
    requestAnimationFrame(() => {
      currentStationRowRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    });
  }, [payload]);

  const refreshNow = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setRefreshing(true);
      wsRef.current.send(JSON.stringify({ type: "refresh" }));
    }
  }, []);

  useEffect(() => disconnect, [disconnect]);

  function connect() {
    if (!trainNumber.trim()) return;
    // Reconnecting to the SAME train (socket dropped, user tapped
    // "Reconnect") must not be treated as switching trains — wiping the
    // marker/route/fitBounds state here made the map visibly jump/re-fit
    // to a new pan+zoom on every reconnect instead of just letting the
    // marker glide onto its next real position on a static map.
    const isSameTrainReconnect = trainNumber.trim() === lastConnectedTrainRef.current;
    disconnect();
    setPayload(null);
    setConnection("connecting");
    setDelaySparkline([]);
    tripSummaryShownKeyRef.current = null;
    setTripSummary(null);
    setTripSummaryShareStatus(null);

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
      timelineAutoScrolledRef.current = false;
    }
    lastConnectedTrainRef.current = trainNumber.trim();

    const url = buildTrackingWsUrl(wsBaseUrl, trainNumber.trim(), {
      date: trackDate.trim() || undefined,
      source: source.trim() || undefined,
      dest: dest.trim() || undefined,
    });

    const socket = new WebSocket(url);
    wsRef.current = socket;
    socket.onopen = () => setConnection("open");
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
    socket.onclose = () => setConnection((c) => (c === "error" ? c : "closed"));
  }

  const timeline = payload?.timeline || [];

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
          {/* RailYatri-style "Next: <station>  ETA <time>  <delay pill>"
              quick-glance bar — the headline element now, same idea as the
              web frontend's #liveTrackQuickBar. */}
          <View ref={quickBarRef} style={styles.quickBar}>
            <Text style={styles.quickBarIcon}>🚆</Text>
            <Text style={styles.quickBarText}>
              Next: <Text style={styles.quickBarStation}>{payload.next_station || "—"}</Text>
              <Text style={styles.quickBarEta}>  ETA {payload.next_station_live_eta || payload.next_station_expected_arrival || "—"}</Text>
            </Text>
            <DelayPill minutes={payload.delay_minutes} />
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

          {/* RailYatri-style running status — vertical connecting line,
              colored dots, a train-icon marker at the current stop, and
              red/green delay pills on every Arrival/Departure line. */}
          <SectionCard title="Running status — every station" subtitle={`${timeline.length} stops reported`}>
            {timeline.map((stop, idx) => (
              <TimelineStopRow
                key={`${stop.code}_${idx}`}
                stop={stop}
                isFirst={idx === 0}
                isLast={idx === timeline.length - 1}
                rowRef={stop.status === "current" ? currentStationRowRef : undefined}
              />
            ))}
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
  const label = `${late ? "+" : ""}${formatDelayDuration(minutes)}${late ? " late" : early ? " early" : " on time"}`;
  return (
    <View style={[styles.delayPill, { backgroundColor: bg }, small && styles.delayPillSmall]}>
      <Text style={[styles.delayPillText, small && styles.delayPillTextSmall]}>{label}</Text>
    </View>
  );
}

// One Arrival or Departure line for a timeline stop — "Exp HH:MM  Act
// HH:MM  [delay pill]", matching the web frontend's timingRow().
function TimingLine({ label, timing }) {
  if (!timing || (!timing.scheduled && !timing.expected && !timing.actual)) return null;
  const actLabel = timing.actual_is_predicted ? "Act (pred.)" : "Act";
  return (
    <View style={styles.timingLine}>
      <Text style={styles.timingLabel}>{label}</Text>
      <Text style={styles.timingVal}>Exp {timing.expected || timing.scheduled || "—"}</Text>
      <Text style={styles.timingVal}>{actLabel} {timing.actual || "—"}</Text>
      <DelayPill minutes={timing.delay_minutes} small />
    </View>
  );
}

// One row of the RailYatri-style running-status timeline: a connecting
// vertical line + dot (train icon for the current stop) on the left, the
// station name/meta/times on the right. Mirrors the web frontend's
// .live-timeline__row structure closely enough to look like the same
// feature on both platforms.
function TimelineStopRow({ stop, isFirst, isLast, rowRef }) {
  const isCurrent = stop.status === "current";
  const isPassed = stop.status === "passed";
  const dotColor = isPassed ? colors.success : isCurrent ? colors.danger : colors.border;
  const metaBits = [];
  if (stop.halt_minutes != null && stop.halt_minutes !== "") metaBits.push(`Halt: ${stop.halt_minutes} min`);
  if (stop.distance_km != null) metaBits.push(`${stop.distance_km} km`);
  return (
    <View ref={rowRef} style={styles.tlRow}>
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
        {isCurrent && (
          <View style={styles.tlCurrentCallout}>
            <Text style={styles.tlCurrentCalloutText}>
              🚆 Train is currently here{stop.halt_minutes ? ` · halt ${stop.halt_minutes} min` : ""}
            </Text>
          </View>
        )}
        {stop.status === "upcoming" && stop.predicted_delay_minutes != null && (
          <Text style={styles.tlPredicted}>
            ~{formatDelayDuration(stop.predicted_delay_minutes)} late (predicted)
            {stop.predicted_eta ? ` · ETA ~${stop.predicted_eta}` : ""}
          </Text>
        )}
        <TimingLine label="Arrival" timing={stop.arrival} />
        <TimingLine label="Departure" timing={stop.departure} />
      </View>
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
  quickBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#eef4fb", borderWidth: 1, borderColor: "#cfe0f3",
    borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12,
    marginBottom: spacing.sm,
  },
  quickBarIcon: { fontSize: 16 },
  quickBarText: { flex: 1, fontSize: 13, color: colors.text },
  quickBarStation: { fontWeight: "700", color: colors.primary },
  quickBarEta: { fontSize: 12, color: colors.textMuted },
  moreStatsToggle: { alignSelf: "flex-start", marginBottom: spacing.sm, paddingVertical: 4 },
  moreStatsToggleText: { fontSize: 12.5, fontWeight: "600", color: colors.primary },
  delayPill: { borderRadius: 4, paddingVertical: 3, paddingHorizontal: 8 },
  delayPillSmall: { paddingVertical: 1, paddingHorizontal: 5 },
  delayPillText: { fontSize: 12, fontWeight: "700", color: "#fff" },
  delayPillTextSmall: { fontSize: 10.5 },
  timingLine: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3, flexWrap: "wrap" },
  timingLabel: { fontSize: 10.5, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3, width: 52 },
  timingVal: { fontSize: 11.5, color: colors.text },
  tlRow: { flexDirection: "row" },
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