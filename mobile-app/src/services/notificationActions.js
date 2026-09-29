// notificationActions.js
// ----------------------
// FEATURE: "Turn off updates" / "Turn on updates" work right inside the
// notification — the app does not open.
//
// The buttons are registered with opensAppToForeground: false
// (pushNotifications.registerNotificationActions). Android then delivers
// the tap to:
//   - the response listener in App.js while the app is open, and
//   - the headless background task (readAloudTask.js) when the app is in
//     the background or swiped away.
// Both call handleStatusAction. A tap can reach both (and Android replays
// it to the listener the next time the app opens), so each tap is handled
// once: remembered in memory and in AsyncStorage.
//
// Off: status updates stop on the server and this phone, and the same
// notification turns into "Live updates off" with a green "Turn on updates".
// On: the server restores the old interval and the notification turns back
// into one with the red "Turn off updates".

import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_API_BASE_URL, STORAGE_KEYS } from "../config";
import {
  STATUS_OFF_ACTION, STATUS_ON_ACTION, STATUS_ON_COLOR, STATUS_OFF_COLOR,
  replaceNotification, registerNotificationActions,
} from "./pushNotifications";
import { turnOffStatusUpdates, turnOnStatusUpdates } from "./backgroundTracking";
import { stopSpeaking } from "../utils/speakNotifications";

const HANDLED_KEY = "notify.handledActions";
const handledNow = new Set();

async function apiBase() {
  try { return (await AsyncStorage.getItem(STORAGE_KEYS.API_BASE_URL)) || DEFAULT_API_BASE_URL; } catch (e) { return DEFAULT_API_BASE_URL; }
}

/** Marks a tap as handled; false if it already was (here or in storage). */
async function claim(key) {
  if (handledNow.has(key)) return false;
  handledNow.add(key);
  try {
    const list = JSON.parse((await AsyncStorage.getItem(HANDLED_KEY)) || "[]");
    if (list.includes(key)) return false;
    await AsyncStorage.setItem(HANDLED_KEY, JSON.stringify([...list, key].slice(-30)));
  } catch (e) { /* in-memory guard still applies */ }
  return true;
}

/** Notification data, whether it came as an object or a JSON string. */
function contentData(content) {
  let d = content?.data;
  if (!d && content?.dataString) d = content.dataString;
  if (typeof d === "string") { try { d = JSON.parse(d); } catch (e) { d = {}; } }
  if (d && d.dataString) { try { d = JSON.parse(d.dataString); } catch (e) { /* keep */ } }
  return d || {};
}

/**
 * Handles the Off / On buttons of a train notification.
 * `response` is an expo-notifications NotificationResponse (listener) or
 * the same shape from the background task. Returns true if it was one.
 */
export async function handleStatusAction(response) {
  const action = response?.actionIdentifier;
  if (action !== STATUS_OFF_ACTION && action !== STATUS_ON_ACTION) return false;
  const notification = response?.notification || {};
  const id = notification?.request?.identifier;
  // The replaced notification keeps its identifier, so include its date —
  // tapping Off, On, Off again on one notification must all work.
  if (!(await claim(`${id}|${action}|${notification?.date || ""}`))) return true;

  // A headless start may run before App.js did — the flipped notification
  // needs the categories to show its button.
  await registerNotificationActions();
  const data = contentData(notification?.request?.content);
  const train = data.train_number ? `${data.train_number}: ` : "";
  const base = await apiBase();

  if (action === STATUS_ON_ACTION) {
    const n = await turnOnStatusUpdates(base, { minutes: data.interval_minutes });
    await replaceNotification(id, {
      title: "Live updates on",
      body: `${train}status updates every ${n} min again.`,
      categoryIdentifier: "train_status",
      color: STATUS_ON_COLOR,
      data: { ...data, type: "status_on_confirm", interval_minutes: String(n) },
    });
    return true;
  }
  try { stopSpeaking(); } catch (e) { /* no speech running */ }
  const prev = await turnOffStatusUpdates(base, { previous: data.interval_minutes });
  await replaceNotification(id, {
    title: "Live updates off",
    body: `${train}no more status updates. Station alerts and alarms still work.`,
    categoryIdentifier: "train_status_off",
    color: STATUS_OFF_COLOR,
    data: { ...data, type: "status_off_confirm", interval_minutes: String(prev) },
  });
  return true;
}
