// firebase-messaging-sw.js
// -------------------------
// Push Notifications for Proactive Alerts — service worker.
//
// This file MUST live at the site root (frontend/firebase-messaging-sw.js,
// served as /firebase-messaging-sw.js) — the browser's Push API requires
// the service worker scope to cover the pages that register it, and
// Firebase's default lookup path is exactly this filename at the root.
//
// It's what lets a notification arrive even when the tab is closed —
// the plain frontend/app.js code only runs while a tab is open, but a
// registered service worker keeps running in the background.
//
// SETUP: paste the SAME firebaseConfig object used in frontend/index.html
// (from Firebase Console -> Project Settings -> General -> Your apps ->
// SDK setup and configuration). It's safe for this to be public/visible
// in a browser — it identifies the Firebase project, it is not a secret
// credential (that's the backend's FIREBASE_SERVICE_ACCOUNT_JSON, which
// never touches the frontend).

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

// Handles a push that arrives while no tab has focus — the `notification`
// block on the message the backend sends (see push_notifications.py)
// is normally shown by the browser automatically, but this hook lets us
// customize the icon/click-behaviour and covers browsers that need an
// explicit background handler.
//
// CAVEAT worth knowing while debugging: Firebase's SDK can auto-display a
// message that includes a top-level `notification` payload (which ours
// does) WITHOUT ever calling this handler — it's handled internally by
// the SDK's own push listener before onBackgroundMessage would fire. If
// the console.log below never appears even while this tab is genuinely
// backgrounded, that's not necessarily a bug — check whether the
// notification appeared anyway via the SDK's internal auto-display first.
messaging.onBackgroundMessage((payload) => {
  console.log("[push-sw] onBackgroundMessage fired:", payload);
  const title = payload.notification?.title || "Train delay alert";
  const body = payload.notification?.body || "";
  self.registration.showNotification(title, {
    body,
    icon: "/assets/icons/train-marker.png",
    data: payload.data || {},
  }).then(() => {
    console.log("[push-sw] showNotification() succeeded.");
  }).catch((err) => {
    console.error("[push-sw] showNotification() failed:", err);
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});