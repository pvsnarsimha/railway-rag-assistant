/**
 * pushNotifications.js
 * ---------------------
 * CROWD-POSITION FOLLOW-UP: the mobile app previously only had a
 * foreground, in-app "just crossed X station" notification tied to the
 * Live Tracking screen being open (see TrackedTrainCard.js) — nothing
 * registered a real device push token or told the backend's
 * alert_scheduler.py which trains to watch, so a closed app could never
 * receive a delay-threshold-breach alert the way the web app already can
 * (see frontend/app.js's enablePushNotifications).
 *
 * UPDATE: registerForPushNotifications() now handles Platform.OS ===
 * "web" for real too (see registerForWebPushNotifications below), using
 * the SAME already-configured Firebase project frontend/app.js uses,
 * instead of refusing outright. That refusal was the actual bug behind
 * per-station Delay Alerts/Smart Alarms silently never firing when this
 * app's web build (served at /mobile-app) was used in a browser.
 *
 * This wires the SAME server-side pipeline (push_store.py +
 * alert_scheduler.py + push_notifications.py) the web app already uses,
 * via Expo's push notification service instead of raw FCM device tokens:
 *   - Expo's push service (https://exp.host/--/api/v2/push/send) is a
 *     free, no-credentials-needed relay that forwards to FCM (Android)
 *     and APNs (iOS) on the app's behalf — Notifications.getExpoPushTokenAsync()
 *     returns a token in the "ExponentPushToken[...]" format for it.
 *   - The backend (push_notifications.py) already knows to route a token
 *     in that format to Expo's API instead of firebase-admin/FCM directly
 *     — this keeps the web app (raw FCM/webpush tokens) working exactly
 *     as before, unchanged, while giving mobile a path that doesn't need
 *     a Firebase iOS/Android native project to be configured at all.
 *
 * SETUP (same "leave it unset and get an honest degraded message" pattern
 * as every other provider key in this project):
 *   1. `npx eas init` (or the Expo dashboard) to get a real EAS project ID.
 *   2. Put it in mobile-app/app.json under expo.extra.eas.projectId.
 *   3. Build a real device/dev-client build (Expo Go's remote-notification
 *      support was removed for SDK 53+ on Android) — see IS_EXPO_GO below.
 * Until both of those are true, registerForPushNotifications() returns a
 * clear, typed reason instead of a token, and the UI is expected to show
 * that reason rather than fail silently.
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";

// Same guard TrackedTrainCard.js already established: Expo Go (SDK 53+)
// dropped the native module remote push needs on Android, and can throw
// synchronously rather than just reject a promise.
export const IS_EXPO_GO = Constants.appOwnership === "expo" || Constants.executionEnvironment === "storeClient";

// BUG FIX: registerForPushNotifications() used to immediately return
// { token: null, reason: "Use the web app's own ... button instead." }
// for Platform.OS === "web" — meaning every per-station Delay Alert /
// Smart Alarm set from the Expo web build (served at /mobile-app) was
// saved locally (AsyncStorage) but NEVER synced to the backend's
// alert_scheduler.py watchlist, so nothing could ever fire once the tab
// wasn't open and active. This wires the SAME real, already-configured
// Firebase project the legacy frontend/app.js uses (see
// frontend/firebase-messaging-sw.js + frontend/app.js's
// enablePushNotifications/getOrCreateWebPushToken) so the web build of
// THIS app can register for real background push too, instead of
// punting to a different, unrelated part of the site.
//
// Requires: the "firebase" npm package (added to package.json), and
// mobile-app/public/firebase-messaging-sw.js (Expo copies mobile-app's
// public/ folder into the web export root, so it ends up served at
// /mobile-app/firebase-messaging-sw.js — the scope a service worker
// needs to control pages under /mobile-app/*).
const WEB_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBTSGSVdsnZ0bqOwbdxrt2genJQtadRx5M",
  authDomain: "railway-142a6.firebaseapp.com",
  projectId: "railway-142a6",
  storageBucket: "railway-142a6.firebasestorage.app",
  messagingSenderId: "72786651974",
  appId: "1:72786651974:web:67e9a8337aba65c86e9347",
  measurementId: "G-PQB5J6ET1M",
};
const WEB_VAPID_KEY = "BMu0pxEE23rJpmRM9zYTFN9VxHx5Qeo36SFA51_n70NjdSmA9aFe6814lT_aL80FJKqwh2U2miiCPwjJi4zNxys";
const WEB_SW_PATH = "/mobile-app/firebase-messaging-sw.js";
const WEB_PUSH_TOKEN_KEY = "pushDeviceToken";
// Same stable path public/firebase-messaging-sw.js uses for the
// background case — public/ is copied verbatim into the Expo web export
// root, so this survives unchanged at /mobile-app/notification-icon.png.
const NOTIFICATION_ICON = "/mobile-app/notification-icon.png";

// --- Web audio, no files/hosting needed -----------------------------
// A real background push (delivered while the tab isn't focused/open)
// already gets the phone's own default notification sound for free —
// that's the OS/browser showing it, same as any other app's push. This
// is for the two cases that DON'T get that for free: (1) a push that
// arrives while you're actively looking at the tab — some browsers
// suppress their own sound for a focused tab — gets a short two-note
// "ting-ting" so it's still noticeable; (2) the Smart Alarm, which (see
// scheduleWebAlarm below) rings using this same engine since it isn't a
// real push at all on web, just an on-device timer.
function playWebTone(notes) {
  if (typeof window === "undefined") return () => {};
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return () => {};
  let ctx;
  try { ctx = new AudioCtx(); } catch (e) { return () => {}; }
  let stopped = false;
  const now = ctx.currentTime;
  notes.forEach(({ freq, at, dur }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now + at);
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.35, now + at + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + at);
    osc.stop(now + at + dur);
  });
  const totalMs = Math.max(...notes.map((n) => (n.at + n.dur) * 1000)) + 60;
  const closeTimer = setTimeout(() => { if (!stopped) { try { ctx.close(); } catch (e) { /* ignore */ } } }, totalMs);
  return () => { stopped = true; clearTimeout(closeTimer); try { ctx.close(); } catch (e) { /* ignore */ } };
}

// SMS-style ring — Delay Alert chime. A background push already gets the
// phone's own default notification sound for free (see the file header);
// this is only for the foreground case, where some browsers suppress
// that — so it's deliberately louder/longer than the old single "ting"
// (two quick two-note rings, closer to a text message's alert tone) to
// feel like an actual notification going off rather than a soft chime.
function playDelayAlertChime() {
  const ring = [
    { freq: 1046.5, at: 0, dur: 0.16 },
    { freq: 1318.5, at: 0.2, dur: 0.22 },
  ];
  playWebTone(ring);
  setTimeout(() => playWebTone(ring), 480);
}

// Louder, repeating ring — Smart Alarm. Loops for ~24s (or until the
// returned stop() is called), closer to an actual alarm than one beep.
function playSmartAlarmTone() {
  const ring = [
    { freq: 880, at: 0, dur: 0.32 },
    { freq: 659.3, at: 0.4, dur: 0.32 },
  ];
  let cancelled = false;
  const stopFns = [];
  const tick = (cycle) => {
    if (cancelled || cycle >= 10) return;
    stopFns.push(playWebTone(ring));
    setTimeout(() => tick(cycle + 1), 850);
  };
  tick(0);
  return () => { cancelled = true; stopFns.forEach((stop) => stop()); };
}

// Import the "firebase" package lazily (dynamic import) rather than at
// module top-level: this file is also loaded on native (iOS/Android),
// where firebase/app + firebase/messaging are never used and shouldn't
// be forced into the native bundle.
// Set once per page load — onMessage must be attached on EVERY load (not
// only the first time push was enabled), otherwise a push that arrives
// while the app is open is silently dropped after a page refresh.
let webForegroundHandlerAttached = false;

async function registerForWebPushNotifications({ prompt = true } = {}) {
  if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) {
    return { token: null, reason: "This browser doesn't support push notifications." };
  }
  try {
    if (!prompt && Notification.permission !== "granted") {
      return { token: null, reason: "Notification permission was not granted." };
    }
    const permission = prompt ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") {
      return { token: null, reason: "Notification permission was not granted." };
    }

    const { initializeApp, getApps, getApp } = await import("firebase/app");
    const { getMessaging, getToken, onMessage } = await import("firebase/messaging");

    const app = getApps().length ? getApp() : initializeApp(WEB_FIREBASE_CONFIG);
    const messaging = getMessaging(app);

    // Foreground delivery: a push arriving while this exact tab is
    // focused is routed here instead of the service worker's
    // onBackgroundMessage (that only fires when the tab is backgrounded
    // or closed) — without this, a push that arrives while you're
    // looking at the app would succeed silently with no visible banner.
    if (!webForegroundHandlerAttached) {
    webForegroundHandlerAttached = true;
    onMessage(messaging, (payload) => {
      const title = payload.notification?.title || "Train delay alert";
      const body = payload.notification?.body || "";
      playDelayAlertChime();
      if (Notification.permission === "granted") {
        try {
          // vibrate + requireInteraction match the background service
          // worker's presentation (see public/firebase-messaging-sw.js) so a
          // push looks/feels the same whether the tab is focused or not.
          new Notification(title, {
            body,
            icon: NOTIFICATION_ICON,
            vibrate: [200, 100, 200, 100, 200],
            requireInteraction: true,
            // Per train (and station for station-specific types), so an
            // alert for one train never replaces another train's alert.
            tag: notificationTag(payload.data),
            renotify: true,
          });
        } catch (e) { /* ignore */ }
      }
    });
    }

    const registration = await navigator.serviceWorker.register(WEB_SW_PATH);
    // register() resolves once registration is accepted, not once the
    // worker is active — calling getToken() immediately after can race
    // the worker's install/activate steps. navigator.serviceWorker.ready
    // waits for an active worker at this scope, closing that race.
    await navigator.serviceWorker.ready;

    // BUGFIX (alerts for earlier trains stopped arriving): this used to
    // call deleteToken() first on every registration, which INVALIDATED
    // the token every already-saved watch on the server was stored under
    // — the next push to it failed as "not registered" and the backend
    // then deleted all of that device's watches. getToken() already
    // returns the current valid token (or mints a new one only when the
    // old subscription is really gone), so no delete is needed.

    const token = await getToken(messaging, { vapidKey: WEB_VAPID_KEY, serviceWorkerRegistration: registration });
    if (!token) {
      return { token: null, reason: "Couldn't get a push token from this browser." };
    }
    try { window.localStorage.setItem(WEB_PUSH_TOKEN_KEY, token); } catch (e) { /* ignore */ }
    return { token, platform: "web" };
  } catch (e) {
    return { token: null, reason: e && e.message ? e.message : String(e) };
  }
}

// Foreground display behavior — without this, Notifications delivered
// while the app is open and focused are silently swallowed (no banner,
// no sound) even though delivery itself succeeded. Call once at app
// startup (see App.js).
export function configureForegroundNotificationHandler() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
      // SDK 53+ split shouldShowAlert into these two — set both so the
      // banner actually shows on both older and newer expo-notifications.
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/**
 * Requests permission and returns a real Expo push token, or a typed
 * failure reason — never throws, mirrors push_notifications.py's
 * never-raises contract on the backend so a caller can always render
 * *something* honest instead of crashing the Alerts screen.
 *
 * Returns: { token: string, platform: "android"|"ios" } on success, or
 *          { token: null, reason: string } on any failure/unavailability.
 */
// Tag used for a displayed notification: one slot per train (+ station
// for station-specific alerts), never one shared slot for every train.
export function notificationTag(data) {
  const d = data || {};
  const type = d.type || "railway-alert";
  const train = d.train_number ? `-${d.train_number}` : "";
  const station = (type === "smart_alarm" || type === "station_reached") && (d.station || d.predicted_for_station)
    ? `-${d.station || d.predicted_for_station}` : "";
  return `${type}${train}${station}`;
}

// Silent, no-prompt refresh for a device that already granted permission:
// re-attaches the foreground handler for this page load and returns the
// CURRENT token (which the browser may have rotated since it was cached).
export async function refreshWebPushToken() {
  if (Platform.OS !== "web") return { token: null, reason: "web only" };
  return registerForWebPushNotifications({ prompt: false });
}

export async function registerForPushNotifications() {
  if (Platform.OS === "web") {
    return registerForWebPushNotifications();
  }
  if (IS_EXPO_GO && Platform.OS === "android") {
    return {
      token: null,
      reason: "Expo Go no longer supports remote push notifications on Android (SDK 53+). Build a dev client or standalone app to test this (the in-app \"just crossed X\" banner still works in Expo Go either way).",
    };
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  if (!projectId || projectId.startsWith("YOUR_")) {
    return {
      token: null,
      reason: "No EAS project ID configured (app.json expo.extra.eas.projectId is empty) — run `npx eas init` and add the project ID, same as every other provider key in this project.",
    };
  }

  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") {
      return { token: null, reason: "Notification permission was not granted." };
    }

    if (Platform.OS === "android") {
      // Required once per channel before Android will show a heads-up
      // notification for anything delivered to it, including remote push.
      await Notifications.setNotificationChannelAsync("delay-alerts", {
        name: "Delay alerts",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) {
      return { token: null, reason: "Couldn't obtain a push token from this device." };
    }
    return { token, platform: Platform.OS };
  } catch (e) {
    return { token: null, reason: e && e.message ? e.message : String(e) };
  }
}

/**
 * FEATURE: "Smart Alarm" — Dynamic Departure Reminder. Unlike
 * registerForPushNotifications() above (a REMOTE Expo push token, which
 * needs an EAS project id + a real device/dev-client build), this fires a
 * LOCAL notification scheduled entirely on-device — no server round trip,
 * no EAS project, works in Expo Go too (the "just crossed X station" and
 * tap-icon-status notifications in TrackedTrainCard.js already use the
 * same `trigger: null` immediate-fire form of this call). Returns the
 * scheduled notification's identifier (for cancelLocalAlarm), or null if
 * the native module isn't available (same IS_EXPO_GO guard used
 * elsewhere) — callers should fall back to an in-app timer/banner in
 * that case, same pattern as the crossing-alert banner.
 */
// BUG FIX (same root cause as registerForWebPushNotifications above):
// expo-notifications doesn't support a delayed/scheduled trigger on
// Platform.OS === "web" the way it does on native — calling
// scheduleNotificationAsync there just throws, which the try/catch below
// swallowed into a silent `null`, so the Smart Alarm badge quietly did
// nothing on web. There's no real background delivery to fall back to
// here without also syncing this to the backend watchlist (a bigger
// change, and the Delay Alert path above already covers real background
// delivery) — so on web this now does the best available thing: a plain
// setTimeout-based local alarm, which fires as long as this browser tab
// stays open, and is at least an honest, working "foreground" alarm
// instead of a silent no-op.
const _webAlarmTimers = new Map(); // id -> { timer, stopRinging }
let _webAlarmSeq = 0;

function scheduleWebAlarm(title, body, fireInSeconds) {
  if (typeof window === "undefined") return null;
  const id = `web-alarm-${++_webAlarmSeq}`;
  const timer = setTimeout(() => {
    const entry = _webAlarmTimers.get(id);
    // Ring first (this is the part that actually sounds like an alarm —
    // a single silent Notification doesn't), then also try a system
    // notification/banner so it's visible if you glance at the phone.
    const stopRinging = playSmartAlarmTone();
    if (entry) entry.stopRinging = stopRinging;
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { new Notification(title, { body, vibrate: [300, 150, 300, 150, 300] }); } catch (e) { /* ignore */ }
    } else {
      // No/blocked notification permission — still surface *something*
      // visible, the ring above is already audible either way.
      try { window.alert(`${title}\n\n${body}`); } catch (e) { /* ignore */ }
    }
  }, Math.max(1, Math.round(fireInSeconds)) * 1000);
  _webAlarmTimers.set(id, { timer, stopRinging: null });
  return id;
}

export async function scheduleLocalAlarm(title, body, fireInSeconds) {
  if (Platform.OS === "web") return scheduleWebAlarm(title, body, fireInSeconds);
  if (IS_EXPO_GO && Platform.OS === "android") return null;
  try {
    return await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: { seconds: Math.max(1, Math.round(fireInSeconds)) },
    });
  } catch (e) {
    return null;
  }
}

export async function cancelLocalAlarm(identifier) {
  if (!identifier) return;
  if (typeof identifier === "string" && identifier.startsWith("web-alarm-")) {
    const entry = _webAlarmTimers.get(identifier);
    if (entry) {
      clearTimeout(entry.timer);
      // If it already fired and is mid-ring, silence it too — otherwise
      // "Remove alarm for this station" wouldn't actually stop the sound.
      if (entry.stopRinging) entry.stopRinging();
      _webAlarmTimers.delete(identifier);
    }
    return;
  }
  try { await Notifications.cancelScheduledNotificationAsync(identifier); } catch (e) { /* already fired/cleared */ }
}

/** Attach a listener for a notification tapped while the app is backgrounded/closed and then opened via it. Returns an unsubscribe function. */
export function addNotificationResponseListener(handler) {
  const sub = Notifications.addNotificationResponseReceivedListener(handler);
  return () => sub.remove();
}

/** Attach a listener for a notification arriving while the app is foregrounded. Returns an unsubscribe function. */
export function addNotificationReceivedListener(handler) {
  const sub = Notifications.addNotificationReceivedListener(handler);
  return () => sub.remove();
}