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
export async function registerForPushNotifications() {
  if (Platform.OS === "web") {
    return { token: null, reason: "Use the web app's own \"Enable push notifications\" button on this platform instead." };
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
export async function scheduleLocalAlarm(title, body, fireInSeconds) {
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
