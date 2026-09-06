import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image, Linking, TextInput, Share, Switch } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE, AnimatedRegion } from "react-native-maps";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "./SectionCard";
import {
  buildTrackingWsUrl, sendFeedback, getTrainRouteStats, reportPosition, checkSmartAlarm, getStationNavigator,
  registerPushToken, syncAlarmWatches, getAlarmWatches, getConnectionRisk, reportCoachCrowd, getCoachCrowd,
  saveTripSummary, buildTrackShareUrl, buildTripShareUrl,
} from "../api/railwayApi";
import { getReporterId } from "../utils/reporterId";
import { formatDelayDuration } from "../utils/formatDelay";
import { scheduleLocalAlarm, cancelLocalAlarm, registerForPushNotifications } from "../services/pushNotifications";
import { describeApiError } from "../api/client";

// Same AsyncStorage keys MoreToolsScreen.js already uses for the device's
// Expo push token and PNR watchlist — reused here (not duplicated) so a
// token registered from either screen works for both, and the Connection-
// Risk form can offer a tracked PNR's train as a one-tap suggestion.
const PUSH_TOKEN_KEY = "moreTools.pushToken";
const PNR_WATCH_KEY = "moreTools.pnrWatchlist";
// Mirrors backend/coach_crowd_store.py's CROWD_LEVELS exactly.
const COACH_CROWD_LEVELS = ["empty", "comfortable", "crowded", "packed"];
const COACH_CROWD_LABEL = { empty: "Empty", comfortable: "Comfortable", crowded: "Crowded", packed: "Packed" };
const COACH_CROWD_COLOR = { empty: colors.success, comfortable: colors.primary, crowded: colors.warning, packed: colors.danger };
// FEATURE: Live delay-trend sparkline — same rolling-buffer size as the
// web app's ltDelaySparkline (frontend/app.js), so both surfaces show the
// same amount of recent history.
const SPARKLINE_MAX_POINTS = 20;
// FEATURE: Real-time per-coach crowding — how often this card re-polls
// the aggregated report list while a train is being tracked (independent
// of the 5s websocket cadence, since crowd reports change far less often).
const COACH_CROWD_REFRESH_MS = 20000;

const TRAIN_ICON = require("../../assets/images/train_marker.png");
// Sized (not the raw asset's native px) so the marker reads as a small
// pin on the map instead of a big sprite covering nearby stations —
// react-native-maps honors width/height when `image` is given as an
// {uri, width, height} object, on both iOS and Android. Kept in step with
// the web app's shrunk 26x19 Leaflet icon.
const TRAIN_MARKER_SIZE = 16;
const TRAIN_MARKER_IMAGE = {
  uri: Image.resolveAssetSource(TRAIN_ICON).uri,
  width: TRAIN_MARKER_SIZE,
  height: TRAIN_MARKER_SIZE,
};

// Expo Go (SDK 53+) removed the native Android module expo-notifications
// needs for scheduling - calling it there can throw synchronously, not
// just reject a promise, so a bare .catch() on the call isn't enough to
// stay safe. Detect Expo Go up front and skip the native call entirely
// there; the in-app banner below (crossingAlert state) is what actually
// delivers the "just crossed X station" alert in that case, and the real
// OS notification becomes a bonus layer only in a custom dev/standalone
// build where the native module is really present.
const IS_EXPO_GO = Constants.appOwnership === "expo" || Constants.executionEnvironment === "storeClient";

// Labels the "Avg. running speed" figure with WHERE it came from, same
// honesty pattern as the "(confidence)" tag already shown next to ML
// predicted delay above. "railkit"/"railradar"/"railkit+railradar_avg" =
// a real measurement from one or both providers (shown unlabeled);
// "railradar_live_gps" = RailRadar's own live GPS speed reading;
// "ml_estimate" = neither provider had real distance/time data yet, so
// this is an ML instant estimate, not a measurement.
// A share link built from a private/local host (localhost, 10.0.2.2 for
// the Android emulator, or a bare LAN IP like 192.168.x.x — the DEFAULT
// while developing, see src/config/index.js) only ever resolves on THIS
// device or THIS WiFi network. Someone else's phone, on mobile data or a
// different WiFi, gets "can't reach this site" no matter what the link's
// path is — this can't be fixed client-side; it means the backend itself
// isn't reachable from the wider internet yet (a quick tunnel like
// Cloudflare Tunnel/ngrok, or a real deploy, fixes it — see the project
// README's "Sharing links publicly" section). Flagged here so it doesn't
// look like a broken feature when a link opens fine on your own phone but
// not anyone else's.
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
  "⚠️ This points at a local address — it'll only open on this device/WiFi, not for someone elsewhere. See the README's \"Sharing links publicly\" section to expose the backend with a real public URL.";

function avgSpeedSourceTag(source) {
  if (source === "railradar_live_gps") return " (live GPS)";
  if (source === "distance_delta_per_ping") return " (per-ping calc)";
  if (source === "ml_estimate") return " (ML estimate)";
  return "";
}

// The marker asset's locomotive faces left by default (rotation 0).
// Rather than a full 360° compass bearing, the icon only needs to say
// "going up" or "going down" the route, so this collapses movement into
// two rotations: latitude increasing (train moving up/north) turns the
// left-facing icon 90° clockwise to point up; latitude decreasing (moving
// down/south) turns it 90° counter-clockwise to point down. No net
// latitude change (pure east-west movement, or a repeated reading) keeps
// whatever rotation was last set, so the icon doesn't jitter.
const ROTATE_UP = 90;
const ROTATE_DOWN = -90;
function directionRotation(prevLat, lat, prevRotation) {
  if (lat > prevLat) return ROTATE_UP;
  if (lat < prevLat) return ROTATE_DOWN;
  return prevRotation;
}

// Before the first real GPS movement is observed (so directionRotation()
// above has nothing to compare yet), seed the marker's orientation from
// the backend's auto-detected UP/DOWN classification instead of leaving
// it flat at 0 — gps_tracking.determine_train_direction() reads the
// train number itself (odd -> UP, even -> DOWN, e.g. 20833 UP / 20834
// DOWN, per the common Indian Railways numbering convention) so a correct
// first-paint orientation doesn't have to wait on two live position
// ticks. Once real coordinates start arriving, directionRotation() above
// takes over and real observed movement always wins.
function initialRotationFromDirection(direction) {
  if (direction === "UP") return ROTATE_UP;
  if (direction === "DOWN") return ROTATE_DOWN;
  return 0;
}

// green = already arrived, yellow = the very next station the train is
// heading to, red = stations further out that haven't been reached yet.
const STATUS_COLOR = {
  passed: colors.success,
  current: colors.warning,
  upcoming: colors.danger,
};

// "As of N mins ago" — best-effort against the device clock vs the
// server's status_updated_at timestamp (see backend app.py /ws/track).
function formatAsOfAgo(iso) {
  if (!iso) return "just now";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "just now";
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (diffMin < 1) return "less than a min ago";
  return `${diffMin} min${diffMin === 1 ? "" : "s"} ago`;
}

/**
 * TrackedTrainCard — one train's full live-tracking panel: connects its
 * own WebSocket (`/ws/track/{train_number}`, optionally scoped to a
 * specific `date` so "track 12709 on 20-08-2026" and "track 12709 today"
 * are two independent, simultaneously-open connections rather than one
 * screen fighting over a single train/date), and owns its own animated
 * marker + station-crossing-notification state — each card in the list
 * is independent, so tracking several trains at once (optionally on
 * different custom dates) just means several of these mounted side by
 * side, not one shared connection juggling multiple trains.
 */
export default function TrackedTrainCard({ trainNumber, date, source, dest, wsBaseUrl, apiBaseUrl, onRemove, onPayloadUpdate }) {
  const [connection, setConnection] = useState("connecting"); // connecting | open | closed | error
  const [payload, setPayload] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const wsRef = useRef(null);

  const animatedCoordRef = useRef(null);
  const [animatedReady, setAnimatedReady] = useState(false);
  const prevCoordRef = useRef(null);
  const [rotation, setRotation] = useState(0);
  const rotationRef = useRef(0);
  const prevStationRef = useRef(null);
  const [crossingAlert, setCrossingAlert] = useState(null);
  // Which "+N No-Halt stations" groups the user has tapped open — keyed by
  // group index within timelineGrouped, RailYatri-style collapse/expand.
  const [expandedGroups, setExpandedGroups] = useState({});
  const toggleGroup = useCallback((idx) => {
    setExpandedGroups((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }, []);
  // Tap-the-train-icon status popup (RailYatri-style "Reached X~ / Crossed
  // X~ ... Report Inaccuracy").
  const [statusPopupOpen, setStatusPopupOpen] = useState(false);
  // Forces the "As of X ago" text to re-render every second while the
  // popup is open — same real-time-ticking freshness indicator as the web
  // app's version (formatAsOfAgo always computes off the current clock;
  // this state var just makes React re-run that computation on a timer
  // instead of freezing it at the moment the popup opened).
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!statusPopupOpen) return undefined;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [statusPopupOpen]);
  const [reportState, setReportState] = useState("idle"); // idle | sending | sent
  const handleReportInaccuracy = useCallback(async (responseId) => {
    if (!responseId) return;
    setReportState("sending");
    try {
      await sendFeedback(apiBaseUrl, {
        responseId,
        rating: "down",
        reason: "Reported inaccurate from live tracking status popup",
      });
      setReportState("sent");
    } catch (e) {
      setReportState("idle");
    }
  }, [apiBaseUrl]);
  const crossingTimeoutRef = useRef(null);

  // FEATURE: "Smart Alarm" — Dynamic Departure Reminder. Unlike the web
  // app (which has to keep polling while the tab stays open — browsers
  // can't schedule a real background notification without service-worker
  // push), a native local notification (see scheduleLocalAlarm) actually
  // fires even if the app is backgrounded/closed, once the OS clock hits
  // it — a genuine mobile advantage. The tradeoff (disclosed in the UI):
  // it's scheduled against the ETA at the moment you arm it, not
  // continuously re-computed like the web version's poll loop; re-arm if
  // the real predicted delay changes a lot afterwards.
  const [alarmPanelOpen, setAlarmPanelOpen] = useState(false);
  const [alarmStation, setAlarmStation] = useState("");
  const [alarmLeadMinutes, setAlarmLeadMinutes] = useState("45");
  const [alarmArmed, setAlarmArmed] = useState(false);
  const [alarmStatus, setAlarmStatus] = useState(null);
  const [alarmBusy, setAlarmBusy] = useState(false);
  const alarmNotificationIdRef = useRef(null);

  // FEATURE: Background-surviving Smart Alarm. The local notification
  // scheduled above already survives the app being backgrounded/closed on
  // THIS device — but relies on this exact JS timer having been scheduled
  // before the app was killed by the OS for memory, which can happen on a
  // long journey. This toggle additionally registers the same alarm with
  // the backend's push_store.alarm_watches (see /api/push/alarms +
  // alert_scheduler.py's smart_alarm_push_check job), which re-checks the
  // real live prediction every couple of minutes server-side and sends a
  // genuine remote push — the same "belt and suspenders" pattern the web
  // app just added, reusing the SAME Expo push token this app already
  // uses for delay-threshold Watch-This-Route alerts (MoreToolsScreen.js).
  const [alarmBackgroundOn, setAlarmBackgroundOn] = useState(false);
  const [alarmBackgroundBusy, setAlarmBackgroundBusy] = useState(false);
  const [alarmBackgroundNote, setAlarmBackgroundNote] = useState(null);

  // Gets a usable Expo push token — reuses whatever's already cached from
  // MoreToolsScreen's "Enable background push" flow, or registers a fresh
  // one on demand (never throws; returns null + sets an explanatory note
  // on any failure, matching registerForPushNotifications' own contract).
  const getOrCreatePushToken = useCallback(async () => {
    const cached = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    if (cached) return cached;
    const { token, platform, reason } = await registerForPushNotifications();
    if (!token) { setAlarmBackgroundNote(reason); return null; }
    try { await registerPushToken(apiBaseUrl, token, platform); } catch (e) { /* best-effort; alarm sync below still tries */ }
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
    return token;
  }, [apiBaseUrl]);

  // Registers/clears THIS card's server-side alarm watch without clobbering
  // any other tracked train's background alarm on the same device — reads
  // the token's current watch list first, replaces just this train+station
  // entry, then writes the merged list back (replace_alarm_watches on the
  // backend replaces the FULL set for a token, so a naive single-item
  // write here would silently cancel a sibling TrackedTrainCard's alarm).
  const syncBackgroundAlarmToServer = useCallback(async (watch) => {
    const token = await getOrCreatePushToken();
    if (!token) return { ok: false };
    let existing = [];
    try { existing = (await getAlarmWatches(apiBaseUrl, token)).watches || []; } catch (e) { existing = []; }
    const merged = existing.filter((w) => !(String(w.train_number) === String(trainNumber) && w.station === (watch ? watch.station : alarmStation.trim().toUpperCase())));
    if (watch) merged.push({ trainNumber, station: watch.station, date: watch.date || null, leadMinutes: watch.leadMinutes });
    await syncAlarmWatches(apiBaseUrl, token, merged.map((w) => ({
      trainNumber: w.trainNumber ?? w.train_number, station: w.station, date: w.date, leadMinutes: w.leadMinutes ?? w.lead_minutes,
    })));
    return { ok: true, watchCount: merged.length };
  }, [apiBaseUrl, trainNumber, alarmStation, getOrCreatePushToken]);

  const armAlarm = useCallback(async () => {
    const station = alarmStation.trim().toUpperCase();
    if (!station) { setAlarmStatus("Enter a station code first."); return; }
    const leadMinutes = parseInt(alarmLeadMinutes, 10) || 45;
    setAlarmBusy(true);
    setAlarmStatus("Checking live prediction…");
    try {
      const data = await checkSmartAlarm(apiBaseUrl, { trainNumber, destinationStation: station, date, leadMinutes });
      if (!data.found) { setAlarmStatus(data.note || "Couldn't check this station."); return; }
      if (data.already_passed) { setAlarmStatus(`Train has already reached ${station}.`); return; }
      if (data.minutes_remaining == null) { setAlarmStatus("No live ETA available yet for this station — try again shortly."); return; }
      const fireInSeconds = (data.minutes_remaining - leadMinutes) * 60;
      const body = `Train ${trainNumber} is due at ${station} soon${data.delay_minutes ? ` (running ${formatDelayDuration(data.delay_minutes)} late)` : ""}. Time to head out!`;
      if (fireInSeconds <= 0) {
        await scheduleLocalAlarm(`⏰ Smart Alarm — ${station}`, body, 1);
        setAlarmStatus(`Already within your ${leadMinutes}-min window — notified now. Train due in ~${data.minutes_remaining} min.`);
        setAlarmArmed(false);
        return;
      }
      const id = await scheduleLocalAlarm(`⏰ Smart Alarm — ${station}`, body, fireInSeconds);
      if (!id) {
        setAlarmStatus("Couldn't schedule a native notification on this build (Expo Go on Android doesn't support it) — keep the app open and re-check manually instead.");
        return;
      }
      alarmNotificationIdRef.current = id;
      setAlarmArmed(true);
      setAlarmStatus(`Armed — you'll be notified ~${leadMinutes} min before arrival at ${station} (based on the current prediction; re-arm if the delay changes a lot).`);

      // FEATURE: Background-surviving Smart Alarm — only reaches the
      // server when the user has explicitly opted in via the toggle below;
      // the local notification above already covers the common case.
      if (alarmBackgroundOn) {
        setAlarmBackgroundBusy(true);
        setAlarmBackgroundNote(null);
        try {
          await syncBackgroundAlarmToServer({ station, date, leadMinutes });
          setAlarmBackgroundNote("Also registered server-side — you'll still get notified even if the app is fully closed or killed.");
        } catch (e) {
          setAlarmBackgroundNote(`Couldn't register the background push: ${describeApiError(e)}`);
        } finally {
          setAlarmBackgroundBusy(false);
        }
      }
    } catch (e) {
      setAlarmStatus(describeApiError(e));
    } finally {
      setAlarmBusy(false);
    }
  }, [apiBaseUrl, trainNumber, date, alarmStation, alarmLeadMinutes, alarmBackgroundOn, syncBackgroundAlarmToServer]);

  const disarmAlarm = useCallback(async () => {
    await cancelLocalAlarm(alarmNotificationIdRef.current);
    alarmNotificationIdRef.current = null;
    setAlarmArmed(false);
    setAlarmStatus("Alarm cancelled.");
    if (alarmBackgroundOn) {
      setAlarmBackgroundBusy(true);
      try { await syncBackgroundAlarmToServer(null); setAlarmBackgroundNote("Background push cancelled too."); }
      catch (e) { setAlarmBackgroundNote(`Couldn't cancel the background push: ${describeApiError(e)}`); }
      finally { setAlarmBackgroundBusy(false); }
    }
  }, [alarmBackgroundOn, syncBackgroundAlarmToServer]);

  // FEATURE: Shareable read-only tracking link — a `/track/{trainNumber}`
  // URL a family member waiting at the station can open directly, no app
  // install and no re-typing the train number (see backend/frontend/track.html).
  // Uses the OS share sheet (falls back to a plain URL open if unavailable)
  // so it can go straight into WhatsApp/SMS/etc.
  const [shareLinkNote, setShareLinkNote] = useState(null);
  const shareTrackingLink = useCallback(async () => {
    const url = buildTrackShareUrl(apiBaseUrl, trainNumber, date);
    setShareLinkNote(isPrivateOrLocalHost(apiBaseUrl) ? LOCAL_SHARE_WARNING : null);
    try {
      await Share.share({
        message: `Track train ${trainNumber} live: ${url}`,
        url, // iOS surfaces this separately from `message`
      });
    } catch (e) {
      Linking.openURL(url).catch(() => {});
    }
  }, [apiBaseUrl, trainNumber, date]);

  // FEATURE: "Station Navigator" — Point of Interest Finder, for the
  // train's real current station (payload.current_station_code, added to
  // the /ws/track payload alongside the display name — see backend/app.py).
  const [stationNavOpen, setStationNavOpen] = useState(false);
  const [stationNavData, setStationNavData] = useState(null);
  const [stationNavBusy, setStationNavBusy] = useState(false);
  const openStationNav = useCallback(async (code) => {
    setStationNavOpen(true);
    setStationNavBusy(true);
    try { setStationNavData(await getStationNavigator(apiBaseUrl, code)); }
    catch (e) { setStationNavData({ found: false, note: describeApiError(e) }); }
    finally { setStationNavBusy(false); }
  }, [apiBaseUrl]);

  // FEATURE: Crowd-Sourced Train Position — mobile-first GPS. Right on the
  // main tracking card (this component IS the main "Live Tracking" screen
  // for a train, not a separate "More Tools" detour): a proactive one-
  // time-per-card prompt the first time a real position arrives, plus an
  // explicit "share automatically" toggle that keeps re-submitting a fresh
  // GPS fix every 30s for as long as it's on — not just a single manual
  // report button. Same anonymous reporter id + backend endpoint the
  // standalone CrowdPositionScreen.js already uses.
  const [shareEnabled, setShareEnabled] = useState(false);
  const [sharePromptVisible, setSharePromptVisible] = useState(false);
  const [shareMsg, setShareMsg] = useState(null); // { success } | { error } | null
  const sharePromptShownRef = useRef(false);
  const reporterIdRef = useRef(null);
  const shareIntervalRef = useRef(null);
  // Mirrors `shareEnabled` state into a ref so the WebSocket onmessage
  // closure below (deliberately NOT re-created on every state change — see
  // its own effect's narrow dependency array) always reads the current
  // value instead of the one captured when the socket connected.
  const shareEnabledRef = useRef(false);
  useEffect(() => { shareEnabledRef.current = shareEnabled; }, [shareEnabled]);

  const submitShareReport = useCallback(async (silent) => {
    try {
      // Lazy import, same reason as CrowdPositionScreen.js — this card
      // still works for plain position TRACKING on builds where the
      // native location module isn't linked yet.
      const Location = require("expo-location");
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        if (!silent) setShareMsg({ error: "Location permission denied — can't share your position without it." });
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const id = reporterIdRef.current || (await getReporterId());
      reporterIdRef.current = id;
      const result = await reportPosition(apiBaseUrl, {
        trainNumber, reporterId: id,
        lat: pos.coords.latitude, lng: pos.coords.longitude,
        accuracyMeters: pos.coords.accuracy || null, date: date || null,
      });
      setShareMsg({
        success: silent
          ? `Auto-shared your position (${result.total_reports} report${result.total_reports === 1 ? "" : "s"} total).`
          : (result.badge
            ? `Thanks! You're a ${result.badge}.`
            : `Thanks! ${result.total_reports} report${result.total_reports === 1 ? "" : "s"} submitted so far.`),
      });
    } catch (e) {
      if (!silent) {
        setShareMsg({
          error: e?.message?.includes("Cannot find module") || e?.message?.includes("expo-location")
            ? "expo-location isn't installed in this build yet — run `npx expo install expo-location` and rebuild."
            : (e?.message || "Couldn't get your location."),
        });
      }
    }
  }, [apiBaseUrl, trainNumber, date]);

  // Starts/stops the 30s auto-share timer whenever the toggle changes (and
  // shares once immediately on turning it on, rather than waiting out the
  // first interval) — cleared on unmount or when the toggle turns off.
  useEffect(() => {
    if (shareIntervalRef.current) { clearInterval(shareIntervalRef.current); shareIntervalRef.current = null; }
    if (shareEnabled) {
      submitShareReport(true);
      shareIntervalRef.current = setInterval(() => submitShareReport(true), 30000);
    }
    return () => {
      if (shareIntervalRef.current) { clearInterval(shareIntervalRef.current); shareIntervalRef.current = null; }
    };
  }, [shareEnabled, submitShareReport]);

  // Real per-halt distance-from-origin (RailRadar), keyed by station code —
  // fetched once per tracked train, used ONLY as a fallback for stations
  // where RailKit's own distance_km is missing (see resolvedDistanceKm
  // below). Never invented: a code with no entry here and no RailKit
  // distance just shows nothing, same as before this fallback existed.
  const [routeStatsByCode, setRouteStatsByCode] = useState({});
  useEffect(() => {
    let cancelled = false;
    setRouteStatsByCode({});
    getTrainRouteStats(apiBaseUrl, trainNumber)
      .then((data) => {
        if (cancelled || !data || !data.available || !Array.isArray(data.stops)) return;
        const byCode = {};
        data.stops.forEach((s) => {
          if (s.code && s.distance_from_origin_km != null) byCode[s.code] = s.distance_from_origin_km;
        });
        setRouteStatsByCode(byCode);
      })
      .catch(() => {}); // best-effort fallback only
    return () => { cancelled = true; };
  }, [apiBaseUrl, trainNumber]);
  const resolvedDistanceKm = useCallback((stop) => {
    if (stop.distance_km != null && stop.distance_km !== "") return stop.distance_km;
    if (stop.code && routeStatsByCode[stop.code] != null) return routeStatsByCode[stop.code];
    return null;
  }, [routeStatsByCode]);

  // FEATURE: Lite/text-only tracking mode — no map, no chart, just the
  // stats/timeline text already rendered below, for 2G/patchy rural
  // connectivity where a MapView's tile fetches would otherwise stall the
  // whole card. Distinct from "Offline Stations" (a pre-download of a
  // station list) — this is about surviving an actively bad connection
  // while live-tracking, so it also skips the sparkline canvas below.
  const [liteMode, setLiteMode] = useState(false);

  // FEATURE: Connection-Risk Alert — cross-references THIS tracked train's
  // real arrival at an interchange station against a connecting train the
  // user picks (or one auto-suggested from their PNR watchlist, since PNR
  // Tracking and Live Tracking otherwise never talk to each other).
  const [connectionRiskOpen, setConnectionRiskOpen] = useState(false);
  const [connectionRiskStation, setConnectionRiskStation] = useState("");
  const [connectionRiskTrain, setConnectionRiskTrain] = useState("");
  const [connectionRiskDate, setConnectionRiskDate] = useState("");
  const [connectionRiskResult, setConnectionRiskResult] = useState(null);
  const [connectionRiskBusy, setConnectionRiskBusy] = useState(false);
  const [connectionRiskError, setConnectionRiskError] = useState(null);
  const [pnrWatchSuggestions, setPnrWatchSuggestions] = useState([]);
  useEffect(() => {
    if (!connectionRiskOpen) return;
    AsyncStorage.getItem(PNR_WATCH_KEY)
      .then((raw) => setPnrWatchSuggestions(raw ? JSON.parse(raw) : []))
      .catch(() => setPnrWatchSuggestions([]));
  }, [connectionRiskOpen]);
  const checkConnectionRisk = useCallback(async () => {
    const station = connectionRiskStation.trim().toUpperCase();
    const connTrain = connectionRiskTrain.trim();
    if (!station || !/^\d{4,5}$/.test(connTrain)) {
      setConnectionRiskError("Enter the interchange station code and a valid connecting train number.");
      return;
    }
    setConnectionRiskBusy(true);
    setConnectionRiskError(null);
    try {
      const data = await getConnectionRisk(apiBaseUrl, {
        primaryTrainNumber: trainNumber, primaryDate: date || null,
        interchangeStation: station, connectingTrainNumber: connTrain,
        connectingDate: connectionRiskDate.trim() || date || null,
      });
      setConnectionRiskResult(data);
    } catch (e) {
      setConnectionRiskError(describeApiError(e));
      setConnectionRiskResult(null);
    } finally {
      setConnectionRiskBusy(false);
    }
  }, [apiBaseUrl, trainNumber, date, connectionRiskStation, connectionRiskTrain, connectionRiskDate]);
  const CONNECTION_RISK_COLOR = {
    missed: colors.danger, at_risk: colors.danger, tight: colors.warning, comfortable: colors.success,
  };

  // FEATURE: Live delay-trend sparkline — a small rolling chart of the
  // last SPARKLINE_MAX_POINTS polls, distinct from the single static
  // "Delay trend" figure already shown in the InfoRow list below (that one
  // is a per-station-average slope; this shows whether things are getting
  // better or worse RIGHT NOW). Rendered as plain Views (bars) rather than
  // react-native-svg/chart-kit to avoid a new native dependency.
  const [delaySparkline, setDelaySparkline] = useState([]);

  // FEATURE: End-of-Trip Summary Card — built once from the SAME
  // per-station figures already in the timeline, the moment a real
  // recorded actual arrival appears at the destination (never invented).
  const tripSummaryShownKeyRef = useRef(null);
  const [tripSummary, setTripSummary] = useState(null);
  const [tripSummaryShareBusy, setTripSummaryShareBusy] = useState(false);
  const [tripSummaryShareStatus, setTripSummaryShareStatus] = useState(null);
  const buildAndShowTripSummary = useCallback((data) => {
    const key = `${data.train_number}|${data.date || ""}`;
    if (tripSummaryShownKeyRef.current === key) return;
    const stoppages = (data.timeline || []).filter((s) => s.kind !== "intermediate");
    if (stoppages.length < 2) return;
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
  }, []);
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

  // FEATURE: Real-Time Per-Coach Crowding (passenger-reported) — distinct
  // from payload.crowd_level (booking-data + heuristics, whole-train) and
  // the static Coach Layout/Seat Picker tools: this is riders on THIS run,
  // right now, one tap. Polls the aggregate independently of the 5s
  // websocket cadence since crowd reports change far less often.
  const [coachCrowdOpen, setCoachCrowdOpen] = useState(false);
  const [coachCrowdCoach, setCoachCrowdCoach] = useState("");
  const [coachCrowdLevel, setCoachCrowdLevel] = useState("comfortable");
  const [coachCrowdBusy, setCoachCrowdBusy] = useState(false);
  const [coachCrowdStatus, setCoachCrowdStatus] = useState(null);
  const [coachCrowdData, setCoachCrowdData] = useState(null);
  const coachCrowdIntervalRef = useRef(null);
  const refreshCoachCrowd = useCallback(async () => {
    try { setCoachCrowdData(await getCoachCrowd(apiBaseUrl, trainNumber)); }
    catch (e) { /* best-effort background refresh */ }
  }, [apiBaseUrl, trainNumber]);
  useEffect(() => {
    if (coachCrowdIntervalRef.current) { clearInterval(coachCrowdIntervalRef.current); coachCrowdIntervalRef.current = null; }
    if (coachCrowdOpen) {
      refreshCoachCrowd();
      coachCrowdIntervalRef.current = setInterval(refreshCoachCrowd, COACH_CROWD_REFRESH_MS);
    }
    return () => {
      if (coachCrowdIntervalRef.current) { clearInterval(coachCrowdIntervalRef.current); coachCrowdIntervalRef.current = null; }
    };
  }, [coachCrowdOpen, refreshCoachCrowd]);
  const submitCoachCrowd = useCallback(async () => {
    const coach = coachCrowdCoach.trim().toUpperCase();
    if (!coach) { setCoachCrowdStatus({ error: "Enter a coach or class code first, e.g. S4 or SL." }); return; }
    setCoachCrowdBusy(true);
    setCoachCrowdStatus(null);
    try {
      const id = reporterIdRef.current || (await getReporterId());
      reporterIdRef.current = id;
      const result = await reportCoachCrowd(apiBaseUrl, { trainNumber, coach, crowdLevel: coachCrowdLevel, date, reporterId: id });
      if (result.ok === false) { setCoachCrowdStatus({ error: result.error || "Couldn't submit that report." }); return; }
      setCoachCrowdStatus({ success: `Thanks — reported ${coach} as ${COACH_CROWD_LABEL[coachCrowdLevel]}.` });
      setCoachCrowdCoach("");
      refreshCoachCrowd();
    } catch (e) {
      setCoachCrowdStatus({ error: describeApiError(e) });
    } finally {
      setCoachCrowdBusy(false);
    }
  }, [apiBaseUrl, trainNumber, date, coachCrowdCoach, coachCrowdLevel, refreshCoachCrowd]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    if (crossingTimeoutRef.current) {
      clearTimeout(crossingTimeoutRef.current);
      crossingTimeoutRef.current = null;
    }
  }, []);

  // Manual "Refresh now" — pings the backend so it wakes up immediately
  // instead of waiting out the rest of its 5s auto-refresh cycle. The
  // socket doesn't care what's in the message, just that one arrived.
  const refreshNow = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setRefreshing(true);
      wsRef.current.send(JSON.stringify({ type: "refresh" }));
    }
  }, []);

  useEffect(() => {
    setConnection("connecting");
    setPayload(null);
    animatedCoordRef.current = null;
    setAnimatedReady(false);
    prevCoordRef.current = null;
    prevStationRef.current = null;
    rotationRef.current = 0;
    setRotation(0);
    // A fresh connection (new train, or the same train re-tracked on a
    // different date) gets its own one-time share-position prompt.
    sharePromptShownRef.current = false;
    setSharePromptVisible(false);
    // Fresh state for the features that key off a single tracking session.
    setDelaySparkline([]);
    tripSummaryShownKeyRef.current = null;
    setTripSummary(null);
    setTripSummaryShareStatus(null);
    setConnectionRiskResult(null);
    setShareLinkNote(null);

    const url = buildTrackingWsUrl(wsBaseUrl, trainNumber, {
      date: date || undefined,
      source: source || undefined,
      dest: dest || undefined,
    });
    const socket = new WebSocket(url);
    wsRef.current = socket;

    socket.onopen = () => setConnection("open");
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setPayload(data);
        setLastUpdated(new Date());
        setRefreshing(false);
        // FEATURE: Track two trains side by side — relays every live
        // payload up to LiveTrackingScreen so it can render a compact
        // side-by-side comparison strip without opening a second websocket
        // to the same train (this card's own connection is reused).
        if (onPayloadUpdate) onPayloadUpdate(data);

        // FEATURE: Crowd-Sourced Train Position — mobile-first GPS. Prompt
        // once per card the first time a real position comes through,
        // instead of waiting for the passenger to find the standalone
        // Crowd Positions tab on their own.
        if (data.lat != null && data.lng != null && !sharePromptShownRef.current && !shareEnabledRef.current) {
          sharePromptShownRef.current = true;
          setSharePromptVisible(true);
        }

        if (data.lat != null && data.lng != null) {
          if (prevCoordRef.current) {
            const nextRotation = directionRotation(prevCoordRef.current.lat, data.lat, rotationRef.current);
            rotationRef.current = nextRotation;
            setRotation(nextRotation);
          } else if (data.direction) {
            // First fix for this train — no prior coordinate to diff yet,
            // so seed the orientation from the backend's train-number-based
            // UP/DOWN classification rather than leaving the icon flat.
            const seeded = initialRotationFromDirection(data.direction);
            rotationRef.current = seeded;
            setRotation(seeded);
          }
          if (animatedCoordRef.current) {
            animatedCoordRef.current
              .timing({ latitude: data.lat, longitude: data.lng, duration: 4000, useNativeDriver: false })
              .start();
          } else {
            animatedCoordRef.current = new AnimatedRegion({
              latitude: data.lat,
              longitude: data.lng,
              latitudeDelta: 0,
              longitudeDelta: 0,
            });
            setAnimatedReady(true);
          }
          prevCoordRef.current = { lat: data.lat, lng: data.lng };
        }

        if (data.current_station && prevStationRef.current && data.current_station !== prevStationRef.current) {
          const crossingMessage = `Just crossed ${prevStationRef.current} \u2014 now near ${data.current_station}${
            data.delay_minutes ? ` (running ${formatDelayDuration(data.delay_minutes)} late)` : ""
          }`;

          // In-app banner: works everywhere (Expo Go or a dev build, iOS
          // or Android), no native module involved - this is what
          // actually delivers the alert reliably.
          setCrossingAlert(crossingMessage);
          if (crossingTimeoutRef.current) clearTimeout(crossingTimeoutRef.current);
          crossingTimeoutRef.current = setTimeout(() => setCrossingAlert(null), 6000);

          // OS notification: bonus layer, only attempted where the native
          // module actually exists. Expo Go (SDK 53+) stripped this for
          // Android and can throw synchronously, so it's skipped there
          // entirely rather than relying on try/catch to survive it.
          if (!IS_EXPO_GO) {
            try {
              Notifications.scheduleNotificationAsync({
                content: { title: `Train ${data.train_number || trainNumber}`, body: crossingMessage },
                trigger: null,
              }).catch(() => {});
            } catch (e) {
              // native module unavailable even outside Expo Go - the
              // in-app banner above already covered it.
            }
          }
        }
        if (data.current_station) {
          if (data.current_station !== prevStationRef.current) {
            // New station reached — close any stale status popup so it
            // doesn't keep showing the previous station's snapshot.
            setStatusPopupOpen(false);
            setReportState("idle");
          }
          prevStationRef.current = data.current_station;
        }

        // FEATURE: Live delay-trend sparkline — same source figure as the
        // "ML predicted delay" InfoRow (falling back to the reported
        // delay), fed into a rolling buffer capped at SPARKLINE_MAX_POINTS.
        const sparkValue = data.predicted_delay_minutes != null ? data.predicted_delay_minutes : data.delay_minutes;
        if (sparkValue != null) {
          setDelaySparkline((prev) => {
            const next = [...prev, sparkValue];
            return next.length > SPARKLINE_MAX_POINTS ? next.slice(next.length - SPARKLINE_MAX_POINTS) : next;
          });
        }

        // FEATURE: End-of-Trip Summary Card — only once the train has
        // genuinely reached its final destination (a real recorded actual
        // arrival, never just "upcoming"/predicted).
        if (data.destination_actual_arrival) {
          buildAndShowTripSummary(data);
        }
      } catch (e) {
        // ignore malformed frame
      }
    };
    socket.onerror = () => setConnection("error");
    socket.onclose = () => setConnection((c) => (c === "error" ? c : "closed"));

    return disconnect;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trainNumber, date, source, dest, wsBaseUrl]);

  const timeline = payload?.timeline || [];
  // RailYatri-style grouped display (no-halt runs collapsed, each upcoming
  // halt carrying its own predicted_delay_minutes) — falls back to the
  // flat timeline (one entry per station, incl. every intermediate stop)
  // if an older/cached payload doesn't have the grouped field yet.
  const timelineGrouped = payload?.timeline_grouped && payload.timeline_grouped.length
    ? payload.timeline_grouped
    : timeline.map((s) => (s.kind === "intermediate" ? { display_type: "station_flat", ...s } : { display_type: "station", ...s }));
  // Real major (halting) stops the train has already passed on THIS run,
  // in route order — every entry here is a genuine station the backend
  // reported as status "passed", never a guess about what "should" have
  // been crossed by now. Used in the tap-icon popup + notification.
  const coveredStops = timelineGrouped
    .filter((e) => e.display_type !== "no_halt_group" && e.status === "passed")
    .map((e) => ({ code: e.code, name: e.name }));
  const withCoords = timeline.filter((s) => s.lat != null && s.lng != null);
  const region =
    payload?.lat && payload?.lng
      ? { latitude: payload.lat, longitude: payload.lng, latitudeDelta: 0.5, longitudeDelta: 0.5 }
      : { latitude: 20.5937, longitude: 78.9629, latitudeDelta: 12, longitudeDelta: 12 };

  return (
    <View style={styles.wrap}>
      <SectionCard
        title={`Train ${trainNumber}${date ? ` \u2014 ${date}` : ""}`}
        subtitle={source && dest ? `${source} \u2192 ${dest}` : undefined}
      >
        <View style={styles.headerRow}>
          <ConnectionBadge connection={connection} />
          <View style={styles.headerActions}>
            <TouchableOpacity
              onPress={refreshNow}
              disabled={connection !== "open" || refreshing}
              style={styles.refreshBtn}
              accessibilityLabel="Refresh position now"
            >
              <Ionicons
                name="refresh"
                size={16}
                color={connection === "open" ? colors.primary : colors.textMuted}
                style={refreshing ? styles.refreshBtnActive : undefined}
              />
            </TouchableOpacity>
            <TouchableOpacity onPress={onRemove} style={styles.removeBtn} accessibilityLabel="Stop tracking this train">
              <Ionicons name="close-circle" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>
        {connection === "open" && (
          <Text style={styles.updatedText}>
            {refreshing ? "Refreshing\u2026" : "Auto-updates every 5s"}
            {lastUpdated ? ` \u00b7 last update ${lastUpdated.toLocaleTimeString()}` : ""}
          </Text>
        )}

        {crossingAlert && (
          <View style={styles.crossingBanner}>
            <Ionicons name="train-outline" size={14} color={colors.primary} />
            <Text style={styles.crossingBannerText}>{crossingAlert}</Text>
          </View>
        )}

        {/* FEATURE: Crowd-Sourced Train Position — mobile-first GPS. */}
        {sharePromptVisible && (
          <View style={styles.sharePromptBanner}>
            <Ionicons name="navigate-circle-outline" size={18} color={colors.primary} />
            <View style={{ flex: 1, marginLeft: spacing.sm }}>
              <Text style={styles.sharePromptText}>
                Riding this train right now? Share your live GPS to help other passengers.
              </Text>
              <View style={styles.sharePromptActions}>
                <TouchableOpacity
                  onPress={() => { setShareEnabled(true); setSharePromptVisible(false); }}
                  style={styles.sharePromptBtnYes}
                >
                  <Text style={styles.sharePromptBtnYesText}>Yes, share</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setSharePromptVisible(false)} style={styles.sharePromptBtnNo}>
                  <Text style={styles.sharePromptBtnNoText}>Not now</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
        <View style={styles.shareToggleRow}>
          <TouchableOpacity
            style={[styles.shareChip, shareEnabled && styles.shareChipActive]}
            onPress={() => setShareEnabled((v) => !v)}
            accessibilityLabel="Toggle sharing my live position for this train"
          >
            <Ionicons
              name={shareEnabled ? "location" : "location-outline"}
              size={14}
              color={shareEnabled ? colors.textInverse : colors.primary}
            />
            <Text style={[styles.shareChipText, shareEnabled && styles.shareChipTextActive]}>
              {shareEnabled ? "Sharing my position" : "Share my position"}
            </Text>
          </TouchableOpacity>
          {shareMsg?.success ? <Text style={styles.shareMsgSuccess} numberOfLines={1}>{shareMsg.success}</Text> : null}
          {shareMsg?.error ? <Text style={styles.shareMsgError} numberOfLines={2}>{shareMsg.error}</Text> : null}
        </View>

        {/* FEATURE: Smart Alarm / On-Board Catering / Station Navigator quick actions. */}
        <View style={styles.quickActionsRow}>
          <TouchableOpacity
            style={[styles.shareChip, (alarmArmed || alarmPanelOpen) && styles.shareChipActive]}
            onPress={() => setAlarmPanelOpen((v) => !v)}
          >
            <Ionicons name={alarmArmed ? "alarm" : "alarm-outline"} size={14} color={(alarmArmed || alarmPanelOpen) ? colors.textInverse : colors.primary} />
            <Text style={[styles.shareChipText, (alarmArmed || alarmPanelOpen) && styles.shareChipTextActive]}>
              {alarmArmed ? "Alarm armed" : "Alarm"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.shareChip}
            onPress={() => {
              const code = payload?.next_station_code || payload?.current_station_code;
              const url = code
                ? `https://www.ecatering.irctc.co.in/station/${encodeURIComponent(code)}/outlets`
                : "https://www.ecatering.irctc.co.in/";
              Linking.openURL(url).catch(() => {});
            }}
          >
            <Ionicons name="restaurant-outline" size={14} color={colors.primary} />
            <Text style={styles.shareChipText}>Order food</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.shareChip}
            disabled={!payload?.current_station_code && !payload?.next_station_code}
            onPress={() => openStationNav(payload.current_station_code || payload.next_station_code)}
          >
            <Ionicons name="compass-outline" size={14} color={colors.primary} />
            <Text style={styles.shareChipText}>Station info</Text>
          </TouchableOpacity>
          {/* FEATURE: Shareable read-only tracking link */}
          <TouchableOpacity style={styles.shareChip} onPress={shareTrackingLink}>
            <Ionicons name="link-outline" size={14} color={colors.primary} />
            <Text style={styles.shareChipText}>Share link</Text>
          </TouchableOpacity>
          {/* FEATURE: Connection-Risk Alert */}
          <TouchableOpacity
            style={[styles.shareChip, connectionRiskOpen && styles.shareChipActive]}
            onPress={() => setConnectionRiskOpen((v) => !v)}
          >
            <Ionicons name="git-merge-outline" size={14} color={connectionRiskOpen ? colors.textInverse : colors.primary} />
            <Text style={[styles.shareChipText, connectionRiskOpen && styles.shareChipTextActive]}>Connection risk</Text>
          </TouchableOpacity>
          {/* FEATURE: Real-Time Per-Coach Crowding */}
          <TouchableOpacity
            style={[styles.shareChip, coachCrowdOpen && styles.shareChipActive]}
            onPress={() => setCoachCrowdOpen((v) => !v)}
          >
            <Ionicons name="people-outline" size={14} color={coachCrowdOpen ? colors.textInverse : colors.primary} />
            <Text style={[styles.shareChipText, coachCrowdOpen && styles.shareChipTextActive]}>Coach crowding</Text>
          </TouchableOpacity>
          {/* FEATURE: Lite/text-only tracking mode */}
          <TouchableOpacity
            style={[styles.shareChip, liteMode && styles.shareChipActive]}
            onPress={() => setLiteMode((v) => !v)}
          >
            <Ionicons name={liteMode ? "cellular" : "map-outline"} size={14} color={liteMode ? colors.textInverse : colors.primary} />
            <Text style={[styles.shareChipText, liteMode && styles.shareChipTextActive]}>{liteMode ? "Lite mode on" : "Lite mode"}</Text>
          </TouchableOpacity>
        </View>

        {/* FEATURE: Shareable read-only tracking link — warn plainly when
            the generated link points at a local/dev address, since it will
            silently fail to open for anyone not on this device/WiFi. */}
        {shareLinkNote && <Text style={styles.shareMsgError}>{shareLinkNote}</Text>}

        {alarmPanelOpen && (
          <View style={styles.alarmPanel}>
            <Text style={styles.subCardTitle}>Smart Alarm</Text>
            <Text style={styles.explainNote}>Notify me before this train reaches:</Text>
            <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}>
              <TextInput
                style={styles.alarmInput}
                placeholder="Station code, e.g. NDLS"
                value={alarmStation}
                onChangeText={(t) => setAlarmStation(t.toUpperCase())}
                autoCapitalize="characters"
                maxLength={6}
              />
              <TextInput
                style={[styles.alarmInput, { width: 70 }]}
                placeholder="45"
                value={alarmLeadMinutes}
                onChangeText={setAlarmLeadMinutes}
                keyboardType="number-pad"
              />
              <Text style={{ fontSize: 12, color: colors.textMuted }}>min before</Text>
            </View>
            {/* FEATURE: Background-surviving Smart Alarm */}
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.sm }}>
              <Switch
                value={alarmBackgroundOn}
                onValueChange={setAlarmBackgroundOn}
                disabled={alarmBackgroundBusy}
              />
              <Text style={styles.explainNote}>Also notify me if the app is fully closed (uses push, may take a couple min to fire)</Text>
            </View>
            <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
              <TouchableOpacity style={styles.alarmBtn} onPress={armAlarm} disabled={alarmBusy}>
                <Text style={styles.alarmBtnText}>{alarmBusy ? "Checking…" : alarmArmed ? "Re-arm" : "Set Alarm"}</Text>
              </TouchableOpacity>
              {alarmArmed && (
                <TouchableOpacity style={[styles.alarmBtn, styles.alarmBtnGhost]} onPress={disarmAlarm}>
                  <Text style={[styles.alarmBtnText, styles.alarmBtnGhostText]}>Cancel</Text>
                </TouchableOpacity>
              )}
            </View>
            {alarmStatus && <Text style={styles.explainNote}>{alarmStatus}</Text>}
            {alarmBackgroundBusy && <Text style={styles.explainNote}>Syncing background alarm…</Text>}
            {alarmBackgroundNote && <Text style={styles.explainNote}>{alarmBackgroundNote}</Text>}
          </View>
        )}

        {stationNavOpen && (
          <View style={styles.alarmPanel}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.subCardTitle}>Station Navigator</Text>
              <TouchableOpacity onPress={() => setStationNavOpen(false)}><Ionicons name="close" size={16} color={colors.textMuted} /></TouchableOpacity>
            </View>
            {stationNavBusy && <Text style={styles.explainNote}>Loading…</Text>}
            {!stationNavBusy && stationNavData && (
              <>
                <Text style={styles.navTitle}>
                  {stationNavData.name || stationNavData.station} {stationNavData.station_platform_count != null ? `· ${stationNavData.station_platform_count} platform(s)` : ""}
                </Text>
                {stationNavData.notable_note && <Text style={styles.navLine}>{stationNavData.notable_note}</Text>}
                {!!stationNavData.entrance_sides?.length && (
                  <>
                    <Text style={styles.navSubhead}>Entrance sides</Text>
                    {stationNavData.entrance_sides.map((s, i) => <Text key={i} style={styles.navLine}>• {s}</Text>)}
                  </>
                )}
                {!!stationNavData.facilities?.length && (
                  <>
                    <Text style={styles.navSubhead}>Facilities</Text>
                    {stationNavData.facilities.map((f, i) => <Text key={i} style={styles.navLine}>• {f.label} — {f.typical_location_note}</Text>)}
                  </>
                )}
                {stationNavData.layout_guidance && (
                  <>
                    <Text style={styles.navSubhead}>Layout guidance</Text>
                    {stationNavData.layout_guidance.map((g, i) => <Text key={i} style={styles.navLine}>• {g}</Text>)}
                  </>
                )}
                {(stationNavData.disclaimer || stationNavData.note) && (
                  <Text style={styles.navDisclaimer}>{stationNavData.disclaimer || stationNavData.note}</Text>
                )}
              </>
            )}
          </View>
        )}

        {/* FEATURE: End-of-Trip Summary Card (shareable) */}
        {tripSummary && (
          <View style={styles.tripSummaryCard}>
            <Text style={styles.tripSummaryTitle}>
              {"🏁"} Trip complete — {tripSummary.source_station} {"→"} {tripSummary.destination_station}
            </Text>
            <Text style={styles.tripSummaryLine}>
              Arrived {tripSummary.arrival.delay_minutes ? `+${formatDelayDuration(tripSummary.arrival.delay_minutes)} late` : "on time"}
              {tripSummary.worst_station ? ` · worst delay was at ${tripSummary.worst_station.name} (+${formatDelayDuration(tripSummary.worst_station.delay_minutes)})` : ""}.
            </Text>
            <TouchableOpacity style={[styles.alarmBtn, { alignSelf: "flex-start", marginTop: spacing.sm }]} onPress={shareTripSummary} disabled={tripSummaryShareBusy}>
              <Text style={styles.alarmBtnText}>{tripSummaryShareBusy ? "Creating link…" : "🔗 Share this trip recap"}</Text>
            </TouchableOpacity>
            {tripSummaryShareStatus && <Text style={styles.explainNote}>{tripSummaryShareStatus}</Text>}
          </View>
        )}

        {/* FEATURE: Route-Deviation / Diversion Detection — see
            backend/route_deviation.py + payload.route_deviation. Distinct
            from the re-route suggestion below: this is about whether the
            TRAIN ITSELF is off its own physical path, not about the
            passenger's plan. */}
        {payload?.route_deviation?.likely_diversion && (
          <View style={styles.deviationCard}>
            <Text style={styles.deviationTitle}>{"🚧"} Possible route diversion</Text>
            <Text style={styles.rerouteNote}>{payload.route_deviation.note}</Text>
            <Text style={styles.rerouteDisclaimer}>{payload.route_deviation.disclaimer}</Text>
          </View>
        )}

        {/* FEATURE: Connection-Risk Alert */}
        {connectionRiskOpen && (
          <View style={styles.alarmPanel}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.subCardTitle}>Connection Risk</Text>
              <TouchableOpacity onPress={() => setConnectionRiskOpen(false)}><Ionicons name="close" size={16} color={colors.textMuted} /></TouchableOpacity>
            </View>
            <Text style={styles.explainNote}>
              Check whether your connecting train at an interchange station leaves enough buffer, based on both trains' real live arrival/departure times.
            </Text>
            {!!pnrWatchSuggestions.length && (
              <>
                <Text style={styles.navSubhead}>From your PNR watchlist</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
                  {pnrWatchSuggestions.map((w) => (
                    <TouchableOpacity
                      key={w.pnr}
                      style={styles.pnrSuggestChip}
                      onPress={() => setConnectionRiskTrain(w.label && /^\d{4,5}$/.test(w.label) ? w.label : connectionRiskTrain)}
                    >
                      <Text style={styles.pnrSuggestChipText}>{w.label || w.pnr}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
            <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
              <TextInput
                style={styles.alarmInput}
                placeholder="Interchange station code"
                value={connectionRiskStation}
                onChangeText={(t) => setConnectionRiskStation(t.toUpperCase())}
                autoCapitalize="characters"
                maxLength={6}
              />
            </View>
            <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
              <TextInput
                style={styles.alarmInput}
                placeholder="Connecting train no."
                value={connectionRiskTrain}
                onChangeText={setConnectionRiskTrain}
                keyboardType="number-pad"
                maxLength={5}
              />
              <TextInput
                style={styles.alarmInput}
                placeholder="Date DD-MM-YYYY (optional)"
                value={connectionRiskDate}
                onChangeText={setConnectionRiskDate}
              />
            </View>
            <TouchableOpacity style={[styles.alarmBtn, { alignSelf: "flex-start", marginTop: spacing.sm }]} onPress={checkConnectionRisk} disabled={connectionRiskBusy}>
              <Text style={styles.alarmBtnText}>{connectionRiskBusy ? "Checking…" : "Check buffer"}</Text>
            </TouchableOpacity>
            {connectionRiskError && <Text style={styles.errorText}>{connectionRiskError}</Text>}
            {connectionRiskResult && connectionRiskResult.found && (
              <View style={{ marginTop: spacing.sm }}>
                <Text style={[styles.statusDelay, { alignSelf: "flex-start", color: "#fff", backgroundColor: CONNECTION_RISK_COLOR[connectionRiskResult.risk_level] || colors.textMuted }]}>
                  {(connectionRiskResult.risk_level || "unknown").replace("_", " ")}
                </Text>
                <Text style={styles.navLine}>{connectionRiskResult.note}</Text>
                <Text style={styles.navDisclaimer}>{connectionRiskResult.disclaimer}</Text>
              </View>
            )}
            {connectionRiskResult && connectionRiskResult.found === false && (
              <Text style={styles.explainNote}>{connectionRiskResult.note}</Text>
            )}
          </View>
        )}

        {/* FEATURE: Real-Time Per-Coach Crowding */}
        {coachCrowdOpen && (
          <View style={styles.alarmPanel}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={styles.subCardTitle}>Coach Crowding — live from riders</Text>
              <TouchableOpacity onPress={() => setCoachCrowdOpen(false)}><Ionicons name="close" size={16} color={colors.textMuted} /></TouchableOpacity>
            </View>
            <Text style={styles.explainNote}>Riding this train right now? Report how crowded your coach is — one tap helps other passengers.</Text>
            <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}>
              <TextInput
                style={[styles.alarmInput, { flex: 0, width: 90 }]}
                placeholder="Coach, e.g. S4"
                value={coachCrowdCoach}
                onChangeText={(t) => setCoachCrowdCoach(t.toUpperCase())}
                autoCapitalize="characters"
                maxLength={6}
              />
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.sm }}>
              {COACH_CROWD_LEVELS.map((lvl) => (
                <TouchableOpacity
                  key={lvl}
                  style={[styles.crowdLevelChip, coachCrowdLevel === lvl && { backgroundColor: COACH_CROWD_COLOR[lvl], borderColor: COACH_CROWD_COLOR[lvl] }]}
                  onPress={() => setCoachCrowdLevel(lvl)}
                >
                  <Text style={[styles.crowdLevelChipText, coachCrowdLevel === lvl && { color: colors.textInverse }]}>{COACH_CROWD_LABEL[lvl]}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={[styles.alarmBtn, { alignSelf: "flex-start", marginTop: spacing.sm }]} onPress={submitCoachCrowd} disabled={coachCrowdBusy}>
              <Text style={styles.alarmBtnText}>{coachCrowdBusy ? "Submitting…" : "Report"}</Text>
            </TouchableOpacity>
            {coachCrowdStatus?.success && <Text style={[styles.explainNote, { color: colors.success }]}>{coachCrowdStatus.success}</Text>}
            {coachCrowdStatus?.error && <Text style={styles.errorText}>{coachCrowdStatus.error}</Text>}
            {!!coachCrowdData?.coaches?.length && (
              <View style={{ marginTop: spacing.sm }}>
                <Text style={styles.navSubhead}>Current reports</Text>
                {coachCrowdData.coaches.map((c) => (
                  <View key={c.coach} style={styles.infoRow}>
                    <Text style={styles.infoLabel}>{c.coach} ({c.report_count} report{c.report_count === 1 ? "" : "s"})</Text>
                    <Text style={[styles.infoValue, { color: COACH_CROWD_COLOR[c.crowd_level] }]}>{COACH_CROWD_LABEL[c.crowd_level] || c.crowd_level}</Text>
                  </View>
                ))}
                <Text style={styles.navDisclaimer}>{coachCrowdData.disclaimer}</Text>
              </View>
            )}
          </View>
        )}

        {/* FEATURE: Dynamic Re-route Suggestions During Live Tracking — see
            backend/reroute_suggestions.py + payload.reroute_suggestion. */}
        {payload?.reroute_suggestion?.triggered && (
          <View style={styles.rerouteCard}>
            <Text style={styles.rerouteTitle}>
              {"⚠️"} Running {formatDelayDuration(payload.reroute_suggestion.delay_minutes_used)} late (
              {payload.reroute_suggestion.delay_source}) {"—"} re-route suggestion
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
                    {t.train_number}{t.train_name ? ` — ${t.train_name}` : ""} {"·"} dep {t.departure_time || "?"} {"→"} arr {t.arrival_time || "?"}
                  </Text>
                ))}
              </>
            )}
            {payload.reroute_suggestion.alternative_routes?.length > 0 && (
              <>
                <Text style={styles.rerouteSubhead}>Junction-hopping corridors (no single confirmed train for every leg):</Text>
                {payload.reroute_suggestion.alternative_routes.map((r, i) => (
                  <Text key={i} style={styles.rerouteAltLine}>
                    Via {r.via_names.join(" → ")} {"—"} {r.hops} change(s), ~{r.total_distance_km} km
                  </Text>
                ))}
              </>
            )}
            {payload.reroute_suggestion.disclaimer && (
              <Text style={styles.rerouteDisclaimer}>{payload.reroute_suggestion.disclaimer}</Text>
            )}
          </View>
        )}

        {payload && (
          <>
            {/* FEATURE: Lite/text-only tracking mode \u2014 no map tiles, no
                chart, just the text stats below, for 2G/patchy rural
                connectivity where MapView's tile fetches would otherwise
                stall the whole card. */}
            {liteMode ? (
              <View style={styles.liteModeBanner}>
                <Ionicons name="cellular-outline" size={14} color={colors.textMuted} />
                <Text style={styles.liteModeText}>Lite mode \u2014 map and charts hidden to save data. Text updates still live every 5s.</Text>
              </View>
            ) : (
              <View style={styles.mapWrap}>
                <MapView style={styles.map} region={region} provider={PROVIDER_GOOGLE}>
                  {withCoords.length > 1 && (
                    <Polyline
                      coordinates={withCoords.map((s) => ({ latitude: s.lat, longitude: s.lng }))}
                      strokeColor={colors.primary}
                      strokeWidth={3}
                    />
                  )}
                  {animatedReady && animatedCoordRef.current ? (
                    <Marker.Animated
                      coordinate={animatedCoordRef.current}
                      title={`Train ${payload.train_number || trainNumber}`}
                      description={payload.current_station || "Current position"}
                      image={TRAIN_MARKER_IMAGE}
                      anchor={{ x: 0.5, y: 0.5 }}
                      flat
                      rotation={rotation}
                      tracksViewChanges={false}
                    />
                  ) : (
                    payload.lat &&
                    payload.lng && (
                      <Marker
                        coordinate={{ latitude: payload.lat, longitude: payload.lng }}
                        title={`Train ${payload.train_number}`}
                        description={payload.current_station || "Current position"}
                        image={TRAIN_MARKER_IMAGE}
                        anchor={{ x: 0.5, y: 0.5 }}
                        rotation={rotation}
                        flat
                        tracksViewChanges={false}
                      />
                    )
                  )}
                </MapView>
              </View>
            )}

            <InfoRow label="Current station" value={payload.current_station || "\u2014"} />
            <InfoRow label="Next station" value={payload.next_station || "\u2014"} />
            <InfoRow
              label="Expected arrival (next stop)"
              value={payload.next_station_expected_arrival || payload.next_station_scheduled_arrival || "\u2014"}
            />
            <InfoRow
              label="Actual arrival (next stop)"
              value={payload.next_station_actual_arrival || "Not yet arrived"}
            />
            <InfoRow
              label="Reported delay"
              value={payload.delay_minutes != null ? formatDelayDuration(payload.delay_minutes) : "\u2014"}
            />
            <InfoRow
              label="ML predicted delay"
              value={
                payload.predicted_delay_minutes != null
                  ? `${formatDelayDuration(payload.predicted_delay_minutes)}${
                      payload.predicted_delay_low_minutes != null && payload.predicted_delay_high_minutes != null
                        ? ` [${formatDelayDuration(payload.predicted_delay_low_minutes)}\u2013${formatDelayDuration(payload.predicted_delay_high_minutes)}]`
                        : ""
                    } (${payload.predicted_delay_confidence || "n/a"} confidence)`
                  : "\u2014"
              }
            />
            <InfoRow
              label="Direction"
              value={payload.direction && payload.direction !== "UNKNOWN" ? payload.direction : "\u2014"}
            />
            <InfoRow
              label="Current speed (live, smoothed)"
              value={
                (payload.recency_weighted_speed_kmph ?? payload.instant_speed_kmph) != null
                  ? `${payload.recency_weighted_speed_kmph ?? payload.instant_speed_kmph} km/h${avgSpeedSourceTag(payload.instant_speed_source)}`
                  : "\u2014 (waiting for next ping)"
              }
            />
            <InfoRow
              label="Avg. running speed (since departure)"
              value={
                payload.avg_speed_kmph != null
                  ? `${payload.avg_speed_kmph} km/h${avgSpeedSourceTag(payload.avg_speed_source)}`
                  : "\u2014"
              }
            />
            <InfoRow
              label="Next station ETA (recalculated live)"
              value={payload.next_station_live_eta || payload.next_station_expected_arrival || "\u2014"}
            />
            <InfoRow
              label="Delay trend"
              value={
                payload.recent_delay_trend_per_stop != null
                  ? `${payload.recent_delay_trend_per_stop > 0 ? "+" : ""}${payload.recent_delay_trend_per_stop.toFixed(1)} min/station`
                  : "\u2014"
              }
            />
            {/* FEATURE: Live delay-trend sparkline \u2014 last ~20 polls, is the
                delay getting better or worse RIGHT NOW (different from the
                static per-station-average figure above). Skipped in lite
                mode along with the map. */}
            {!liteMode && delaySparkline.length >= 2 && (
              <View style={styles.sparklineCard}>
                <Text style={styles.subCardTitle}>Delay trend (last {delaySparkline.length} updates)</Text>
                <DelaySparkline values={delaySparkline} />
              </View>
            )}
            {payload.error ? <Text style={styles.errorText}>{payload.error}</Text> : null}

            <View style={styles.subCard}>
              <Text style={styles.subCardTitle}>Destination</Text>
              <InfoRow label="Destination station" value={payload.destination_station || "\u2014"} />
              <InfoRow
                label="Expected destination arrival"
                value={payload.destination_expected_arrival || payload.destination_scheduled_arrival || "\u2014"}
              />
              <InfoRow label="Actual destination arrival" value={payload.destination_actual_arrival || "Not yet arrived"} />
            </View>

            <View style={styles.subCard}>
              <Text style={styles.subCardTitle}>Crowd prediction</Text>
              <InfoRow label="Level" value={payload.crowd_level || "\u2014"} />
              <InfoRow label="Score" value={payload.crowd_score != null ? String(payload.crowd_score) : "\u2014"} />
              {!!payload.crowd_basis?.length && (
                <View style={styles.basisList}>
                  {payload.crowd_basis.map((b, i) => (
                    <Text key={i} style={styles.basisItem}>
                      {"\u2022 "}{b}
                    </Text>
                  ))}
                </View>
              )}
            </View>

            <View style={styles.subCard}>
              <Text style={styles.subCardTitle}>Stop-by-stop timeline ({timeline.length} stops)</Text>
              {timelineGrouped.map((entry, idx) => {
                if (entry.display_type === "no_halt_group") {
                  const expanded = !!expandedGroups[idx];
                  return (
                    <View key={`nohalt_${idx}`} style={styles.timelineRow}>
                      <View style={styles.timelineLineWrap}>
                        <View style={[styles.dot, { backgroundColor: colors.textMuted }]} />
                      </View>
                      <View style={styles.timelineTextWrap}>
                        <TouchableOpacity onPress={() => toggleGroup(idx)} activeOpacity={0.6}>
                          <Text style={styles.nohaltToggle}>
                            + {entry.count} No-Halt station{entry.count === 1 ? "" : "s"}
                            {entry.distance_km != null ? ` \u00b7 ${entry.distance_km} km` : ""}{" "}
                            {expanded ? "\u25b4" : "\u25be"}
                          </Text>
                        </TouchableOpacity>
                        {expanded && entry.stations.map((st, sIdx) => (
                          <View key={`${st.code}_${sIdx}`} style={styles.nohaltStationRow}>
                            <Text style={styles.nohaltStationName}>{st.name} ({st.code})</Text>
                            {st.distance_since_last_stoppage_km != null && (
                              <Text style={styles.timelineFromLast}>
                                {Math.abs(st.distance_since_last_stoppage_km)} km {st.distance_since_last_stoppage_km >= 0 ? "past" : "before"} {entry.from_station}
                              </Text>
                            )}
                          </View>
                        ))}
                      </View>
                    </View>
                  );
                }

                const stop = entry;
                const isCurrent = stop.status === "current";
                const isIntermediateFlat = stop.display_type === "station_flat";
                const delayed = payload.delay_minutes != null && payload.delay_minutes > 0;
                const stopDistKm = resolvedDistanceKm(stop);
                // Only reported for reporting halts still ahead (see
                // backend's _predict_delay_per_reporting_station) —
                // already-passed halts show their REAL recorded delay
                // above via `delayed`/payload.delay_minutes instead.
                const showPredicted = stop.status === "upcoming" && stop.predicted_delay_minutes != null;
                return (
                  <View key={`${stop.code}_${idx}`} style={[styles.timelineRow, isCurrent && styles.timelineRowCurrent]}>
                    <View style={styles.timelineLineWrap}>
                      <View style={[styles.dot, { backgroundColor: STATUS_COLOR[stop.status] || colors.textMuted }]} />
                      {isCurrent && (
                        <TouchableOpacity
                          onPress={() => {
                            const opening = !statusPopupOpen;
                            setStatusPopupOpen(opening);
                            // Push a real OS notification only when the
                            // popup is being OPENED (tapped on) — mirrors
                            // the web app's Notification API trigger on
                            // the same tap event. Same IS_EXPO_GO guard as
                            // the crossing-alert notification above.
                            if (opening && !IS_EXPO_GO) {
                              const lines = [];
                              if (stopDistKm != null) lines.push(`Total distance covered: ${stopDistKm} km`);
                              if (coveredStops.length) {
                                lines.push(`Stops covered (${coveredStops.length}): ${coveredStops.map((c) => c.name).join(", ")}`);
                              }
                              const body = lines.length ? lines.join("\n") : "Live position updated";
                              try {
                                Notifications.scheduleNotificationAsync({
                                  content: { title: `Train at ${stop.name}`, body },
                                  trigger: null,
                                }).catch(() => {});
                              } catch (e) {
                                // native module unavailable — in-app popup below still shows it
                              }
                            }
                          }}
                          activeOpacity={0.7}
                          accessibilityLabel="Show current status"
                        >
                          <Image
                            source={TRAIN_ICON}
                            style={[styles.timelineTrainIcon, { transform: [{ rotate: `${rotation}deg` }] }]}
                          />
                        </TouchableOpacity>
                      )}
                    </View>
                    <View style={styles.timelineTextWrap}>
                      <Text style={styles.timelineName}>
                        {stop.name} ({stop.code}){" "}
                        <Text style={styles.timelineKind}>{isIntermediateFlat ? "\u00b7 passing" : ""}</Text>
                      </Text>
                      {!isIntermediateFlat && (
                        <Text style={styles.timelineHalt}>
                          Halt: {stop.halt_minutes != null && stop.halt_minutes !== "" ? `${stop.halt_minutes} min` : "\u2014"}
                          {stopDistKm != null ? ` | ${stopDistKm} km` : ""}
                        </Text>
                      )}
                      {isCurrent && (
                        <Text style={[styles.timelineReached, delayed && styles.timelineReachedLate]}>
                          {delayed ? `Running ${formatDelayDuration(payload.delay_minutes)} late` : "On time"}
                        </Text>
                      )}
                      {isCurrent && statusPopupOpen && (
                        <View style={styles.statusPopup}>
                          <View style={styles.statusAsOfBubble}>
                            <Text style={styles.statusAsOfText}>As of {formatAsOfAgo(payload.status_updated_at)}</Text>
                          </View>
                          <Text style={styles.statusHead}>
                            {payload.current_station_kind === "intermediate" ? "Crossed " : "Reached "}
                            <Text style={{ fontWeight: "700" }}>{stop.name}</Text>~
                            {payload.current_station_actual_time ? ` at ${payload.current_station_actual_time}` : ""}
                          </Text>
                          {payload.current_station_halt_minutes != null && payload.current_station_halt_minutes !== "" && (
                            <Text style={styles.statusHalt}>Halt: {payload.current_station_halt_minutes} min</Text>
                          )}
                          {stopDistKm != null && (
                            <Text style={styles.statusHalt}>Total distance covered: {stopDistKm} km</Text>
                          )}
                          {coveredStops.length > 0 && (
                            <Text style={styles.statusHalt} numberOfLines={3}>
                              Stops covered ({coveredStops.length}): {coveredStops.map((c) => c.name).join(", ")}
                            </Text>
                          )}
                          <Text style={[styles.statusDelay, delayed ? styles.statusDelayLate : styles.statusDelayOnTime]}>
                            {delayed ? `${formatDelayDuration(payload.delay_minutes)} late` : "On time"}
                          </Text>
                          <TouchableOpacity
                            style={styles.reportLink}
                            disabled={reportState !== "idle"}
                            onPress={() => handleReportInaccuracy(payload.status_response_id)}
                          >
                            <Text style={styles.reportLinkText}>
                              {reportState === "sending" ? "Reporting\u2026" : reportState === "sent" ? "Reported \u2014 thanks" : "Report Inaccuracy"}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      )}
                      {showPredicted && (
                        <Text style={styles.timelinePredicted}>
                          ~{formatDelayDuration(stop.predicted_delay_minutes)}
                          {stop.predicted_delay_low_minutes != null && stop.predicted_delay_high_minutes != null
                            ? ` [${formatDelayDuration(stop.predicted_delay_low_minutes)}\u2013${formatDelayDuration(stop.predicted_delay_high_minutes)}]`
                            : ""}{" "}
                          late (predicted)
                          {stop.predicted_eta ? ` \u00b7 ETA ~${stop.predicted_eta}` : ""}
                        </Text>
                      )}
                      <Text style={styles.timelineTimes}>
                        Arr {stop.arrival?.scheduled || "\u2014"}
                        {stop.arrival?.expected && stop.arrival.expected !== stop.arrival.scheduled
                          ? ` (exp ${stop.arrival.expected})`
                          : ""}
                        {stop.arrival?.actual ? ` (actual ${stop.arrival.actual})` : ""}
                        {" \u00b7 "}
                        Dep {stop.departure?.scheduled || "\u2014"}
                        {stop.departure?.expected && stop.departure.expected !== stop.departure.scheduled
                          ? ` (exp ${stop.departure.expected})`
                          : ""}
                        {stop.departure?.actual ? ` (actual ${stop.departure.actual})` : ""}
                        {isIntermediateFlat && stop.distance_km ? ` \u00b7 ${stop.distance_km} km` : ""}
                      </Text>
                      {isIntermediateFlat && stop.distance_since_last_stoppage_km != null && stop.last_reporting_station && (
                        <Text style={styles.timelineFromLast}>
                          {Math.abs(stop.distance_since_last_stoppage_km)} km {stop.distance_since_last_stoppage_km >= 0 ? "past" : "before"} {stop.last_reporting_station}
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        )}
      </SectionCard>
    </View>
  );
}

function ConnectionBadge({ connection }) {
  const map = {
    connecting: { color: colors.warning, label: "Connecting\u2026", icon: "sync-outline" },
    open: { color: colors.success, label: "Live", icon: "radio-outline" },
    closed: { color: colors.textMuted, label: "Disconnected", icon: "stop-circle-outline" },
    error: { color: colors.danger, label: "Connection error", icon: "warning-outline" },
  };
  const s = map[connection] || map.connecting;
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

// FEATURE: Live delay-trend sparkline — plain Views (bars), not
// react-native-svg/chart-kit, so this doesn't add a new native dependency
// just for a small in-card chart. Bar height is scaled between the
// buffer's own min/max (never against an arbitrary fixed scale) so a
// train hovering at a steady +5 still shows visible up/down wiggle.
function DelaySparkline({ values }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const last = values[values.length - 1];
  const first = values[0];
  const improving = last < first;
  return (
    <View>
      <View style={styles.sparklineBars}>
        {values.map((v, i) => {
          const heightPct = 8 + ((v - min) / span) * 92; // keep a visible sliver even at the minimum
          const isLate = v > 0;
          return (
            <View key={i} style={styles.sparklineBarWrap}>
              <View
                style={[
                  styles.sparklineBar,
                  { height: `${heightPct}%`, backgroundColor: isLate ? colors.danger : colors.success },
                ]}
              />
            </View>
          );
        })}
      </View>
      <Text style={styles.sparklineCaption}>
        {formatDelayDuration(first)} {"→"} {formatDelayDuration(last)}{" "}
        <Text style={{ color: improving ? colors.success : (last > first ? colors.danger : colors.textMuted) }}>
          {improving ? "(improving)" : last > first ? "(getting worse)" : "(steady)"}
        </Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  refreshBtn: { padding: 4 },
  refreshBtnActive: { opacity: 0.4 },
  removeBtn: { padding: 4 },
  updatedText: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: spacing.sm },
  badgeText: { fontSize: 12, fontWeight: "600" },
  crossingBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.chip,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    marginTop: spacing.sm,
  },
  crossingBannerText: { fontSize: 12, color: colors.primary, fontWeight: "600", flexShrink: 1 },
  mapWrap: {
    height: 200,
    borderRadius: radius.md,
    overflow: "hidden",
    marginTop: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  map: { flex: 1 },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  infoLabel: { fontSize: 13, color: colors.textMuted },
  infoValue: { fontSize: 13, color: colors.text, fontWeight: "600", flexShrink: 1, textAlign: "right" },
  errorText: { fontSize: 12, color: colors.danger, marginTop: spacing.sm },
  subCard: { marginTop: spacing.lg },
  subCardTitle: { fontSize: 13, fontWeight: "700", color: colors.primary, marginBottom: spacing.xs },
  basisList: { marginTop: spacing.sm },
  basisItem: { fontSize: 12, color: colors.textMuted, marginBottom: 2 },
  timelineRow: { flexDirection: "row", marginBottom: spacing.sm },
  timelineRowCurrent: {
    backgroundColor: colors.chip,
    borderRadius: radius.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  timelineLineWrap: { width: 22, alignItems: "center", marginRight: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  timelineTrainIcon: { width: 14, height: 14, marginTop: 4, resizeMode: "contain" },
  timelineTextWrap: { flex: 1 },
  timelineName: { fontSize: 13, fontWeight: "600", color: colors.text },
  timelineKind: { fontSize: 11, color: colors.textMuted, fontWeight: "400" },
  timelineReached: { fontSize: 12, fontWeight: "700", color: colors.success, marginTop: 1 },
  timelineReachedLate: { color: colors.danger },
  timelineTimes: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  timelineFromLast: { fontSize: 11, color: colors.textMuted, fontStyle: "italic", marginTop: 1 },
  timelineHalt: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  timelinePredicted: { fontSize: 12, fontWeight: "700", color: colors.danger, marginTop: 1 },
  nohaltToggle: { fontSize: 13, fontWeight: "600", color: colors.primary || colors.text },
  nohaltStationRow: { paddingLeft: spacing.sm, marginTop: 4 },
  nohaltStationName: { fontSize: 12, color: colors.text },
  statusPopup: {
    marginTop: 6,
    marginBottom: 6,
    padding: 12,
    borderWidth: 1.5,
    borderColor: colors.success,
    borderRadius: 10,
    backgroundColor: "#fff",
    maxWidth: 300,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  // Freshness "As of X ago" bubble — sits at the top of the card, RailYatri-
  // style, rather than a plain italic line (RN doesn't support CSS ::after
  // pointer triangles cleanly cross-platform, so this keeps the bubble
  // inline instead of floating above the card border).
  statusAsOfBubble: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#dde3ec",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginBottom: 8,
    backgroundColor: "#fafbfc",
  },
  statusAsOfText: { fontSize: 10.5, color: colors.textMuted },
  statusHead: { fontSize: 14, fontWeight: "700", color: colors.text, marginBottom: 5 },
  statusHalt: { fontSize: 12, color: colors.textMuted, marginBottom: 4, lineHeight: 16 },
  statusDelay: { fontSize: 12, fontWeight: "700", paddingHorizontal: 7, paddingVertical: 2, borderRadius: 3, alignSelf: "flex-start", marginBottom: 8, overflow: "hidden" },
  statusDelayLate: { color: "#fff", backgroundColor: colors.danger },
  statusDelayOnTime: { color: "#fff", backgroundColor: colors.success },
  // Plain text link, RailYatri-style, right-aligned under the card — not a
  // boxed button.
  reportLink: { alignSelf: "flex-end", marginTop: 2 },
  reportLinkText: { fontSize: 11.5, color: "#4a90d9", textDecorationLine: "underline" },

  // FEATURE: Crowd-Sourced Train Position — mobile-first GPS.
  sharePromptBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.chip,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  sharePromptText: { fontSize: 12.5, color: colors.text, lineHeight: 17 },
  sharePromptActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  sharePromptBtnYes: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  sharePromptBtnYesText: { fontSize: 12, fontWeight: "700", color: colors.textInverse },
  sharePromptBtnNo: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sharePromptBtnNoText: { fontSize: 12, fontWeight: "600", color: colors.textMuted },
  shareToggleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.sm },
  shareChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  shareChipActive: { backgroundColor: colors.success, borderColor: colors.success },
  shareChipText: { fontSize: 11.5, fontWeight: "600", color: colors.primary },
  shareChipTextActive: { color: colors.textInverse },
  shareMsgSuccess: { fontSize: 11, color: colors.success, flexShrink: 1 },
  shareMsgError: { fontSize: 11, color: colors.danger, flexShrink: 1 },

  // FEATURE: Dynamic Re-route Suggestions During Live Tracking.
  rerouteCard: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: "#fff8f7",
  },
  rerouteTitle: { fontSize: 13, fontWeight: "700", color: colors.danger, marginBottom: 4 },
  rerouteNote: { fontSize: 12.5, color: colors.text, lineHeight: 17, marginBottom: 6 },
  rerouteSubhead: { fontSize: 12, fontWeight: "700", color: colors.primary, marginTop: 6, marginBottom: 2 },
  rerouteAltLine: { fontSize: 12, color: colors.text, marginBottom: 2 },
  rerouteDisclaimer: { fontSize: 10.5, color: colors.textMuted, fontStyle: "italic", marginTop: 6 },

  // FEATURE: Smart Alarm / Order Food / Station Navigator quick actions.
  quickActionsRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.sm },
  alarmPanel: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  explainNote: { fontSize: 12, color: colors.textMuted, marginTop: 4, marginBottom: 4, lineHeight: 16 },
  alarmInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm || 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: colors.text,
  },
  alarmBtn: { backgroundColor: colors.primary, paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.pill },
  alarmBtnText: { color: colors.textInverse, fontSize: 12.5, fontWeight: "700" },
  alarmBtnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.border },
  alarmBtnGhostText: { color: colors.textMuted },
  navTitle: { fontSize: 13.5, fontWeight: "700", color: colors.text, marginBottom: 4 },
  navSubhead: { fontSize: 12, fontWeight: "700", color: colors.primary, marginTop: 6, marginBottom: 2 },
  navLine: { fontSize: 12.5, color: colors.text, marginBottom: 2, lineHeight: 17 },
  navDisclaimer: { fontSize: 10.5, color: colors.textMuted, fontStyle: "italic", marginTop: 6 },

  // FEATURE: Route-Deviation / Diversion Detection.
  deviationCard: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: "#fffaf0",
  },
  deviationTitle: { fontSize: 13, fontWeight: "700", color: colors.warning, marginBottom: 4 },

  // FEATURE: End-of-Trip Summary Card (shareable).
  tripSummaryCard: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.success,
    backgroundColor: "#f4fbf6",
  },
  tripSummaryTitle: { fontSize: 13.5, fontWeight: "700", color: colors.success, marginBottom: 4 },
  tripSummaryLine: { fontSize: 12.5, color: colors.text, lineHeight: 17 },

  // FEATURE: Connection-Risk Alert.
  pnrSuggestChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  pnrSuggestChipText: { fontSize: 11.5, color: colors.primary, fontWeight: "600" },

  // FEATURE: Real-Time Per-Coach Crowding.
  crowdLevelChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  crowdLevelChipText: { fontSize: 12, fontWeight: "600", color: colors.text },

  // FEATURE: Live delay-trend sparkline.
  sparklineCard: { marginTop: spacing.md },
  sparklineBars: {
    flexDirection: "row",
    alignItems: "flex-end",
    height: 48,
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: 2,
  },
  sparklineBarWrap: { flex: 1, height: "100%", justifyContent: "flex-end" },
  sparklineBar: { width: "100%", borderRadius: 2, minHeight: 2 },
  sparklineCaption: { fontSize: 11.5, color: colors.textMuted, marginTop: 4 },

  // FEATURE: Lite/text-only tracking mode.
  liteModeBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.chip,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  liteModeText: { fontSize: 11.5, color: colors.textMuted, flexShrink: 1, lineHeight: 15 },
});