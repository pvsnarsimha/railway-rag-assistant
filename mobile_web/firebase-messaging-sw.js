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
// SMS-style presentation: notification-icon.png lives in mobile-app/public/
// (a straight copy of assets/icon.png), which Expo's web export copies
// verbatim to the export root — unlike an asset pulled in via require(),
// that gives it a stable, guaranteed path once this SW is actually
// running (mobile_web/notification-icon.png, served at
// /mobile-app/notification-icon.png), so it's now safe to reference here.
const NOTIFICATION_ICON = "/mobile-app/notification-icon.png";

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "Train delay alert";
  const body = payload.notification?.body || "";
  // `vibrate` + `requireInteraction` make it behave more like a normal
  // SMS/alert notification on Android (buzzes, and stays up instead of
  // auto-dismissing after a couple seconds). `renotify` (paired with a
  // stable `tag`) means a SECOND alert for the same watch — e.g. the
  // predicted delay moved — buzzes/re-alerts again instead of silently
  // swapping the text on an already-dismissed notification. `silent` is
  // left at its default (false): the phone's own default notification
  // sound still plays — there's no web API for a page to pick a custom
  // ringtone file the way a native app can bind one to a channel.
  self.registration.showNotification(title, {
    body,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    data: payload.data || {},
    vibrate: [200, 100, 200, 100, 200],
    requireInteraction: true,
    renotify: true,
    silent: false,
    tag: payload.data?.type || "railway-alert",
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/mobile-app/"));
});