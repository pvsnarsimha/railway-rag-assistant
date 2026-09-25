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

// Guarded: if Firebase's scripts can't be fetched (first install on a flaky
// network, a blocked CDN) the worker must STILL install, so the offline app
// shell below keeps working. Push just stays off until the next update.
var messaging = null;
try {
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
  messaging = firebase.messaging();
} catch (e) {
  messaging = null;
}

// One notification slot per TRAIN (RailYatri-style): delay alerts,
// "station reached" notices and the background running-status update
// ("Crossed X at HH:MM · N km to Y") all replace each other in place.
// Smart Alarms keep their own slot so a wake-up alarm is never overwritten.
function notificationTagFor(d) {
  d = d || {};
  var type = d.type || "railway-alert";
  if (type === "smart_alarm") return "smart_alarm-" + (d.train_number || "") + "-" + (d.station || "");
  if (type === "fare_alert") return "fare_alert-" + (d.train_number || "");
  if (d.train_number) return "train-" + d.train_number;
  return type;
}

// BUGFIX (every alert showed up TWICE — one with the train icon, one with
// a plain "R" letter icon): the backend's push carries a `notification`
// block, which the Firebase SDK ALREADY displays by itself (with the
// backend's own icon/tag/vibrate settings) — and then it still calls this
// handler, which showed a second copy. Now this handler only displays
// data-only pushes; notification pushes are left to the SDK's own display.
if (messaging) messaging.onBackgroundMessage((payload) => {
  if (payload && payload.notification) return;
  const d = (payload && payload.data) || {};
  const title = d.title || "Train update";
  const body = d.body || "";
  const silent = d.type === "running_status" && d.completed !== "1";
  self.registration.showNotification(title, {
    body,
    data: d,
    icon: "/assets/icons/train-marker.png",
    vibrate: silent ? undefined : [200, 100, 200],
    requireInteraction: true,
    silent: silent,
    tag: notificationTagFor(d),
    renotify: !silent,
  });
});

// FEATURE: offline app shell. Once /mobile-app has been opened online, the
// app itself (HTML + JS bundle + icon fonts + Leaflet + icons) is served
// from this cache when there's no internet — so the offline GPS tracker on
// Live Tracking can still open on a train with no mobile data. Network-
// first: online you always get the latest deploy; the cache is only the
// fallback. API calls (/api, /ws) are never cached.
var SHELL_CACHE = "railway-shell-v1";
self.addEventListener("install", function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) { return c.addAll(["/mobile-app/"]).catch(function () {}); })
  );
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  var p = url.pathname;
  var cacheable = p.indexOf("/mobile-app/") === 0 || p.indexOf("/assets/") === 0;
  if (!cacheable || p.indexOf("/api/") === 0 || p.indexOf("/ws/") === 0) return;
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        // Navigations to any /mobile-app/ route fall back to the shell page.
        if (req.mode === "navigate") return caches.match("/mobile-app/");
        return Response.error();
      });
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/mobile-app/"));
});


// FEATURE: "Read notifications aloud" — when a push arrives while the app
// is open in a background tab, relay it to the page so it can be spoken
// (a service worker itself cannot use text-to-speech). Runs alongside the
// Firebase SDK's own handling; displays nothing by itself.
self.addEventListener("push", function (event) {
  var p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { return; }
  var n = p.notification || {};
  var d = p.data || {};
  var msg = { kind: "rail-push", title: n.title || d.title || "", body: n.body || d.body || "", type: d.type || "", train_number: d.train_number || "" };
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) { try { c.postMessage(msg); } catch (e) {} });
  }));
});
