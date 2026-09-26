// speakNotifications.js
// ---------------------
// FEATURE: "Read notifications aloud" (opt-in checkbox on Live Tracking).
// When ON, every train notification — the general running-status update
// ("Crossed Eluru · 12 km to Rajahmundry …") and every bell / delay alert —
// is read out with the phone's own text-to-speech (Web Speech API).
//
// Browser limit, stated plainly: a web page can only speak while it is
// open (visible, or still alive in a background tab). With the app fully
// closed only the normal notification + sound can appear; the Android/iOS
// app build would be needed to speak from a closed state.

import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLanguage, languageInfo } from "./notifyLanguage";

// NATIVE (Android/iOS app build): speech uses expo-speech, and the setting
// is kept in AsyncStorage so the background notification task
// (services/readAloudTask.js) can read it even when the app is closed.
const IS_WEB = Platform.OS === "web";
let NativeSpeech = null;
if (!IS_WEB) {
  try { NativeSpeech = require("expo-speech"); } catch (e) { NativeSpeech = null; } // eslint-disable-line global-require
}
let nativeReadAloud = false;

const KEY = "liveTracking.readAloud";
const recent = new Map(); // text -> time, to skip the same message arriving twice

export function isSpeechSupported() {
  if (!IS_WEB) return !!NativeSpeech;
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function loadReadAloud() {
  if (!IS_WEB) return nativeReadAloud;
  try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
}

/** Native: the stored setting (async). Web: same as loadReadAloud. */
export async function loadReadAloudAsync() {
  if (IS_WEB) return loadReadAloud();
  try { nativeReadAloud = (await AsyncStorage.getItem(KEY)) === "1"; } catch (e) { /* keep */ }
  return nativeReadAloud;
}

export function saveReadAloud(on) {
  if (!IS_WEB) {
    nativeReadAloud = !!on;
    AsyncStorage.setItem(KEY, on ? "1" : "0").catch(() => {});
    return;
  }
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) { /* ignore */ }
}

function clean(text, english = true) {
  let t = String(text || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "") // emoji
    .replace(/·/g, ",")
    .replace(/\s+/g, " ");
  if (english) {
    t = t.replace(/\bkm\b/g, "kilometres")
      .replace(/\bmin\b/g, "minutes");
  }
  return t.replace(/\bJn\b/gi, "Junction").trim();
}

// FEATURE (multi-language read-aloud): which installed voice can read the
// chosen language? Tries the language's own locale, then its fallback
// (e.g. Maithili -> Hindi voice), else null (caller reads English).
let nativeVoices = null;
function loadNativeVoices() {
  if (!NativeSpeech || nativeVoices) return Promise.resolve(nativeVoices);
  return NativeSpeech.getAvailableVoicesAsync()
    .then((v) => { nativeVoices = Array.isArray(v) ? v : []; return nativeVoices; })
    .catch(() => { nativeVoices = []; return nativeVoices; });
}
if (!IS_WEB) loadNativeVoices();

function prefix(locale) {
  return String(locale || "").toLowerCase().split(/[-_]/)[0];
}

function voiceLocaleFor(lang, voices) {
  const info = languageInfo(lang);
  const wanted = [info.tts, info.fallback].filter(Boolean);
  if (!voices || !voices.length) return wanted[0]; // unknown: let the engine try
  for (const loc of wanted) {
    const p = prefix(loc);
    const v = voices.find((x) => prefix(x.language || x.lang) === p);
    if (v) return v.language || v.lang || loc;
  }
  return null;
}

// Read ONLY the current notification, once: a newer message cuts off
// anything still being read or queued (older updates are never read after
// a newer one arrives), and the exact same text is never read twice.
// opts.lang: language of `text` (default: the user's chosen language);
// opts.fallbackText: the same message in English, read when the phone has
// no voice for that language.
export function speak(text, opts = {}) {
  if (!isSpeechSupported()) return false;
  const lang = opts.lang || getLanguage();
  const t = clean(text, lang === "en");
  if (!t) return false;
  const now = Date.now();
  for (const [k, at] of recent) if (now - at > 6 * 3600 * 1000) recent.delete(k);
  if (recent.has(t) && !opts.force) return false;
  recent.set(t, now);
  const english = opts.fallbackText ? clean(opts.fallbackText, true) : null;
  if (!IS_WEB) {
    try {
      NativeSpeech.stop();
      loadNativeVoices().then((voices) => {
        const loc = lang === "en" ? "en-IN" : voiceLocaleFor(lang, voices);
        try {
          if (loc) NativeSpeech.speak(t, { language: loc, rate: 0.95 });
          else NativeSpeech.speak(english || t, { language: english ? "en-IN" : languageInfo(lang).tts, rate: 0.95 });
        } catch (e) { /* ignore */ }
      });
      return true;
    } catch (e) {
      return false;
    }
  }
  try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  try {
    const voices = window.speechSynthesis.getVoices() || [];
    let utterText = t;
    let loc = lang === "en" ? "en-IN" : voiceLocaleFor(lang, voices);
    if (!loc) { utterText = english || t; loc = english ? "en-IN" : languageInfo(lang).tts; }
    const u = new SpeechSynthesisUtterance(utterText);
    const p = prefix(loc);
    const v = voices.find((x) => String(x.lang).replace("_", "-").toLowerCase() === String(loc).toLowerCase())
      || voices.find((x) => prefix(x.lang) === p);
    if (v) u.voice = v;
    u.lang = (v && v.lang) || loc;
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
    return true;
  } catch (e) {
    return false;
  }
}

/** Calls handler({title, body, type}) for every train push received while
 *  the page is alive — foreground (in-page Firebase handler) or background
 *  tab (relayed by the service worker). Returns an unsubscribe function. */
export function onTrainPush(handler) {
  // Phone app: App.js's notification listener + the background task speak
  // pushes there (window events don't exist in React Native).
  if (!IS_WEB || typeof window === "undefined" || !window.addEventListener) return () => {};
  const fromPage = (e) => handler(e.detail || {});
  const fromSw = (e) => { if (e.data && e.data.kind === "rail-push") handler(e.data); };
  window.addEventListener("rail-push", fromPage);
  const sw = typeof navigator !== "undefined" && navigator.serviceWorker;
  if (sw) sw.addEventListener("message", fromSw);
  return () => {
    window.removeEventListener("rail-push", fromPage);
    if (sw) sw.removeEventListener("message", fromSw);
  };
}

/** Should this push be read aloud? Only the current, alerting one:
 *  - silent in-place status refreshes (alert="0") are not read,
 *  - a push older than 3 minutes (delivered late, e.g. after reopening the
 *    browser) is past news and is not read,
 *  - an older push arriving after a newer one for the same train is skipped. */
const lastSentAt = new Map(); // train -> newest sent_at seen
export function shouldSpeakPush(m) {
  if (!m) return false;
  if (m.type === "running_status" && m.alert === "0") return false;
  const sent = parseInt(m.sent_at, 10);
  if (Number.isFinite(sent)) {
    if (Date.now() / 1000 - sent > 180) return false;
    const key = m.train_number || "_";
    const prev = lastSentAt.get(key) || 0;
    if (sent < prev) return false;
    lastSentAt.set(key, sent);
  }
  return true;
}

export function stopSpeaking() {
  try {
    if (!IS_WEB) { if (NativeSpeech) NativeSpeech.stop(); return; }
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  } catch (e) { /* ignore */ }
}
