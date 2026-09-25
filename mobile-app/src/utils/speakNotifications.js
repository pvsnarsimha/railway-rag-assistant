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

const KEY = "liveTracking.readAloud";
const recent = new Map(); // text -> time, to skip the same message arriving twice

export function isSpeechSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function loadReadAloud() {
  try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
}

export function saveReadAloud(on) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) { /* ignore */ }
}

function clean(text) {
  return String(text || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "") // emoji
    .replace(/·/g, ",")
    .replace(/\s+/g, " ")
    .replace(/\bkm\b/g, "kilometres")
    .replace(/\bmin\b/g, "minutes")
    .replace(/\bJn\b/gi, "Junction")
    .trim();
}

// Read ONLY the current notification, once: a newer message cuts off
// anything still being read or queued (older updates are never read after
// a newer one arrives), and the exact same text is never read twice.
export function speak(text) {
  if (!isSpeechSupported()) return false;
  const t = clean(text);
  if (!t) return false;
  const now = Date.now();
  for (const [k, at] of recent) if (now - at > 6 * 3600 * 1000) recent.delete(k);
  if (recent.has(t)) return false;
  recent.set(t, now);
  try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  try {
    const u = new SpeechSynthesisUtterance(t);
    const voices = window.speechSynthesis.getVoices() || [];
    const v = voices.find((x) => /en[-_]IN/i.test(x.lang)) || voices.find((x) => /^en/i.test(x.lang));
    if (v) u.voice = v;
    u.lang = (v && v.lang) || "en-IN";
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
  if (typeof window === "undefined") return () => {};
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
