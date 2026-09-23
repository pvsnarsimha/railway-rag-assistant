// firebase-messaging-sw.js — mobile-app (Expo web) copy
// -------------------------------------------------------
// BUG FIX (per-station Delay Alert / Smart Alarm not firing on web):
// mobile-app/src/services/pushNotifications.js used to give up
// immediately on Platform.OS === "web" instead of actually registering
// for push, so a threshold set from the web build (Edge/Chrome/etc,
// served at /mobile-app) was only ever saved on-device and never told
// the backend to watch for it. This service worker is the missing half
// of that fix — it's what lets a push notification arrive even when the
// browser tab is closed or backgrounded, exactly like the plain
// frontend/firebase-messaging-sw.js already does for the legacy site
// mounted at "/".
//
// SCOPE: this file MUST be served at /mobile-app/firebase-messaging-sw.js
// (not just /firebase-messaging-sw.js) because the browser's Push API
// only lets a service worker control pages under its own path. Placing
// this in mobile-app/public/ makes Expo's web export copy it to the
// root of mobile_web/, which backend/app.py serves at exactly
// /mobile-app/firebase-messaging-sw.js via
// app.mount("/mobile-app", StaticFiles(directory=MOBILE_WEB_DIR, ...)).
//
// Config below is the SAME real Firebase project (railway-142a6)
// already used by frontend/app.js and frontend/firebase-messaging-sw.js
// — this is the public, non-secret client config (safe to ship), not
// the backend's FIREBASE_SERVICE_ACCOUNT_JSON credential.

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBTSGSVdsnZ0bqOwbdxrt2genJQtadRx5M",
  authDomain: "railway-142a6.firebaseapp.com",
  projectId: "railway-142a6",
  storageBucket: "railway-142a6.firebasestorage.app",
  messagingSenderId: "72786651974",
  appId: "1:72786651974:web:67e9a8337aba65c86e9347",
});

const messaging = firebase.messaging();

// Handles a push that arrives while no /mobile-app tab has focus. See the
// CAVEAT in the legacy frontend/firebase-messaging-sw.js: Firebase's SDK
// can auto-display a `notification`-payload push without ever calling
// this handler — that's normal, not a sign this file isn't working.
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "Train delay alert";
  const body = payload.notification?.body || "";
  // No bundled icon path is guaranteed to survive the Expo web export
  // unchanged, so this intentionally omits `icon` rather than risk a
  // 404'd image — the browser falls back to a sane default. `vibrate` +
  // `requireInteraction` make it behave more like a normal SMS/alert
  // notification on Android (buzzes, and stays up instead of
  // auto-dismissing after a couple seconds) — the actual sound itself is
  // the phone's own default notification sound, which Android/Chrome
  // plays automatically for a background push; there's no way for a
  // web page to pick a custom sound the way a native app can.
  self.registration.showNotification(title, {
    body,
    data: payload.data || {},
    vibrate: [200, 100, 200],
    requireInteraction: true,
    // One notification slot per train (+ station for station-specific
    // alerts) — a shared per-type tag made each train's alert REPLACE the
    // previous train's alert on the device.
    tag: (function (d) {
      d = d || {};
      var type = d.type || "railway-alert";
      var train = d.train_number ? "-" + d.train_number : "";
      var st = (type === "smart_alarm" || type === "station_reached") && (d.station || d.predicted_for_station)
        ? "-" + (d.station || d.predicted_for_station) : "";
      return type + train + st;
    })(payload.data),
    renotify: true,
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/mobile-app/"));
});
