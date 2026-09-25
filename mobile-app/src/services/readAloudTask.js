// readAloudTask.js
// ----------------
// FEATURE (native Android/iOS build): read train notifications aloud even
// when the app is CLOSED or in the background.
//
// How: the backend sends every alerting train notification to an Expo push
// token twice — the normal visible notification, plus a data-only "speak"
// message (see push_notifications._send_via_expo_speak). A data-only message
// wakes this headless background task, which reads the text with the
// phone's text-to-speech if the user ticked "Read notifications aloud".
// While the app is open, the foreground listener in App.js does the same.
//
// Limits, stated plainly:
//   - Needs a real app build (EAS / dev client), not Expo Go.
//   - Android: works with the app in the background or swiped away, as long
//     as the OS hasn't blocked it (battery saver / "restricted" background
//     usage for this app will stop it — set the app to "Unrestricted").
//   - iOS: Apple does not let an app speak from a background push; iPhone
//     users get the notification + sound only when the app isn't open.

import * as TaskManager from "expo-task-manager";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { loadReadAloudAsync, speak, shouldSpeakPush } from "../utils/speakNotifications";

export const READ_ALOUD_TASK = "railway-read-aloud-notification";

function extract(data) {
  // Expo delivers the push payload in slightly different shapes per
  // platform / state; read tolerantly.
  const n = (data && (data.notification || data)) || {};
  let d = n.data || n.body || data?.data || {};
  if (typeof d === "string") { try { d = JSON.parse(d); } catch (e) { d = {}; } }
  if (d && d.dataString) { try { d = JSON.parse(d.dataString); } catch (e) { /* keep */ } }
  return d || {};
}

export function speakPushData(d) {
  if (!d) return;
  const text = d.speak_text || [d.title, d.body].filter(Boolean).join(". ");
  if (!text) return;
  if (!shouldSpeakPush(d)) return;
  speak(text);
}

// Must be defined at module scope (imported from App.js) so the OS can
// start it without the UI.
if (Platform.OS !== "web") {
  TaskManager.defineTask(READ_ALOUD_TASK, async ({ data, error }) => {
    if (error) return;
    try {
      if (!(await loadReadAloudAsync())) return;
      speakPushData(extract(data));
    } catch (e) { /* never crash the headless task */ }
  });
}

export async function registerReadAloudTask() {
  if (Platform.OS === "web") return;
  try { await Notifications.registerTaskAsync(READ_ALOUD_TASK); } catch (e) { /* Expo Go / unsupported */ }
}
