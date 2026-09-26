// backgroundTracking.js
// ---------------------
// FEATURE: "keep tracking after I close the app" (RailYatri-style).
//
// Two halves:
//   1. Remember on the device which train(s) were being tracked, so the
//      Live Tracking screen reconnects to them BY ITSELF the next time the
//      app is opened — no re-typing, no pressing Start again.
//   2. Tell the server to keep watching that train for this device's push
//      token (POST /api/push/tracking), so a silent, in-place notification
//      ("Crossed Aluva at 17:54 · 26 km to Thrissur") keeps updating while
//      the app is closed — until the train reaches its destination or the
//      user presses Stop.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { registerPushToken, setPushLanguage, startBackgroundTracking, stopBackgroundTracking } from "../api/railwayApi";
import { getLanguage, hasChosenLanguage, saveLanguage } from "../utils/notifyLanguage";
import { registerForPushNotifications, refreshWebPushToken } from "./pushNotifications";

const PUSH_TOKEN_KEY = "moreTools.pushToken"; // shared with the rest of the app
export const ACTIVE_TRACK_KEY = "liveTracking.active"; // web screen: one train
export const NATIVE_TRACKED_KEY = "liveTracking.nativeTracked"; // native screen: list
export const STATUS_EVERY_KEY = "liveTracking.statusEveryMinutes"; // "notify me every N min" (0 = off)

export async function loadStatusEvery() {
  try {
    const v = await AsyncStorage.getItem(STATUS_EVERY_KEY);
    const n = v == null ? 10 : parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 10;
  } catch (e) {
    return 10;
  }
}

export async function saveStatusEvery(minutes) {
  try { await AsyncStorage.setItem(STATUS_EVERY_KEY, String(minutes)); } catch (e) { /* ignore */ }
}
const MAX_AGE_MS = 3 * 24 * 3600 * 1000; // a multi-day run still fits

export async function saveActiveTrack(params) {
  try { await AsyncStorage.setItem(ACTIVE_TRACK_KEY, JSON.stringify({ ...params, startedAt: Date.now() })); } catch (e) { /* ignore */ }
}

export async function loadActiveTrack() {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_TRACK_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || !v.trainNumber || Date.now() - (v.startedAt || 0) > MAX_AGE_MS) {
      await AsyncStorage.removeItem(ACTIVE_TRACK_KEY);
      return null;
    }
    return v;
  } catch (e) {
    return null;
  }
}

export async function clearActiveTrack() {
  try { await AsyncStorage.removeItem(ACTIVE_TRACK_KEY); } catch (e) { /* ignore */ }
}

export async function saveNativeTracked(list) {
  try {
    await AsyncStorage.setItem(NATIVE_TRACKED_KEY, JSON.stringify((list || []).map((t) => ({ ...t, startedAt: t.startedAt || Date.now() }))));
  } catch (e) { /* ignore */ }
}

export async function loadNativeTracked() {
  try {
    const raw = await AsyncStorage.getItem(NATIVE_TRACKED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return (Array.isArray(list) ? list : []).filter((t) => t && t.trainNumber && Date.now() - (t.startedAt || 0) < MAX_AGE_MS);
  } catch (e) {
    return [];
  }
}

/** Returns a push token without prompting unless `prompt` is true. */
async function getToken(apiBaseUrl, prompt) {
  let token = null;
  let platform = null;
  let reason = null;
  try {
    const fresh = await refreshWebPushToken(); // web: current (possibly rotated) token, no prompt
    if (fresh && fresh.token) { token = fresh.token; platform = fresh.platform; }
  } catch (e) { /* ignore */ }
  if (!token) {
    try { token = await AsyncStorage.getItem(PUSH_TOKEN_KEY); } catch (e) { /* ignore */ }
  }
  if (!token && prompt) {
    const r = await registerForPushNotifications();
    token = r.token || null;
    platform = r.platform || null;
    reason = r.reason || null;
  }
  if (token) {
    try { await AsyncStorage.setItem(PUSH_TOKEN_KEY, token); } catch (e) { /* ignore */ }
    try { await registerPushToken(apiBaseUrl, token, platform, hasChosenLanguage() ? getLanguage() : null); } catch (e) { /* the tracking call self-registers too */ }
  }
  return { token, reason };
}

/**
 * Registers the tracked train for background push. Never throws.
 * Returns { ok: true } or { ok: false, reason }.
 */
export async function enableBackgroundTracking(apiBaseUrl, { trainNumber, date, source, dest, intervalMinutes }, { prompt = true } = {}) {
  const { token, reason } = await getToken(apiBaseUrl, prompt);
  if (!token) return { ok: false, reason: reason || "Notifications are off — allow notifications to keep tracking after you close the app." };
  try {
    await startBackgroundTracking(apiBaseUrl, token, {
      trainNumber, date, source, dest, intervalMinutes, lang: hasChosenLanguage() ? getLanguage() : null,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "Couldn't reach the server to start background tracking — it'll retry next time the app opens." };
  }
}

export async function disableBackgroundTracking(apiBaseUrl, { trainNumber, date } = {}) {
  let token = null;
  try { token = await AsyncStorage.getItem(PUSH_TOKEN_KEY); } catch (e) { /* ignore */ }
  if (!token) return;
  try { await stopBackgroundTracking(apiBaseUrl, token, { trainNumber, date }); } catch (e) { /* best-effort */ }
}

/**
 * FEATURE: notification language. Saves the choice on this device and tells
 * the server (so pushes are built in that language), using the stored push
 * token — never prompts. Returns the saved code.
 */
export async function applyNotifyLanguage(apiBaseUrl, code) {
  const lang = await saveLanguage(code);
  let token = null;
  try {
    const fresh = await refreshWebPushToken();
    if (fresh && fresh.token) token = fresh.token;
  } catch (e) { /* ignore */ }
  if (!token) {
    try { token = await AsyncStorage.getItem(PUSH_TOKEN_KEY); } catch (e) { /* ignore */ }
  }
  if (token && apiBaseUrl) {
    try { await setPushLanguage(apiBaseUrl, token, lang); } catch (e) { /* sent again with the next tracking call */ }
  }
  return lang;
}
