// LanguageContext.js
// ------------------
// FEATURE: EVERY screen in the user's language (Home and its tools, Railway
// Assistant, Live Tracking, More Tools, Settings): headings, labels, buttons,
// hints, alerts AND station / train names, for English + the 22
// Eighth-Schedule languages. Default: English.
//
// Most text needs nothing: <Text> / <TextInput> come from i18n/AutoText,
// which translates their string children / placeholder through t().
// For strings that aren't rendered by <Text> (tab titles, Alert, speech):
//
//   const { t, tf, lang } = useT();
//   t("Coach layout")                      // "కోచ్ అమరిక" in Telugu
//   t("Next station in 12 min")            // numbers are masked: the
//                                          // sentence is translated once
//   tf("{n} min late", { n: 5 })
//
// t() never blocks: it returns the English text at once, asks the server
// (POST /api/translate, batched + parallel) for anything it hasn't seen, and
// the screen re-renders with the translation a moment later. Translations
// are kept on the phone per language, so they're instant next time / offline.
//
// FIRST-TIME FIX: a failed / timed-out request used to be remembered as
// "English is the translation", so after a slow first try (server waking
// up, LLM busy) the screen stayed English for good. Now only real answers
// are kept; failures are retried. Every string the app has ever shown is
// also remembered, so choosing a language translates all of them at once —
// screens you open next are already in that language.
//
// The same choice is the notification language (utils/notifyLanguage.js),
// so screen, notifications and read-aloud always match.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSettings } from "./SettingsContext";
import { getLanguage, loadLanguage } from "../utils/notifyLanguage";
import { applyNotifyLanguage } from "../services/backgroundTracking";
import { makeClient } from "../api/client";
// Fixed text of every screen (scripts/extract-ui-strings.js), sent for
// translation as soon as a language is chosen.
import UI_STRINGS from "../i18n/uiStrings.json";

// v2: v1 caches could hold English "translations" saved after a failed
// request — they're ignored.
const CACHE_PREFIX = "i18n.cache.v2.";
const SEEN_KEY = "i18n.seen.v1";
const CHUNK = 40;
const PARALLEL = 4;
const RETRY_MS = [4000, 10000, 20000, 45000];

function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}

/** "Next station in 12 min" -> { tpl: "Next station in {0} min", nums: ["12"] }
 *  so a changing number doesn't make a new sentence to translate. */
function mask(s) {
  const nums = [];
  // Web addresses are kept as they are too.
  const tpl = s.replace(/\b(?:https?|wss?):\/\/\S+|\d+(?:[.:,/]\d+)*/g, (m) => { nums.push(m); return `{${nums.length - 1}}`; });
  return { tpl, nums };
}
function unmask(tr, nums) {
  if (!nums.length) return tr;
  // A translation that lost a number is useless: keep the English.
  for (let i = 0; i < nums.length; i += 1) if (!tr.includes(`{${i}}`)) return null;
  return tr.replace(/\{(\d+)\}/g, (m, i) => (nums[i] != null ? nums[i] : m));
}

export function needsTranslation(s) {
  if (typeof s !== "string" || s.length >= 2000 || !/[A-Za-z]{2,}/.test(s) || /^[A-Z]{2,5}$/.test(s.trim())) return false;
  // Mostly another script already (a translation with "GPS" in it, an
  // answer in Hindi): leave it.
  const letters = s.match(/\p{L}/gu) || [];
  const latin = letters.filter((c) => c <= "\u024f").length;
  return latin / letters.length >= 0.5;
}

// Speak-screen registry: every <Text> on a screen registers what it shows
// (the English source), so "Speak screen" can read ANY screen without a
// hand-written script. scope = the navigation route key.
const speakRegistry = new Map(); // scope -> Map(entry -> true)
let speakOrder = 0;
export function registerSpeakText(scope, entry) {
  if (!scope) return () => {};
  entry.order = speakOrder++;
  let m = speakRegistry.get(scope);
  if (!m) { m = new Map(); speakRegistry.set(scope, m); }
  m.set(entry, true);
  return () => { m.delete(entry); if (!m.size) speakRegistry.delete(scope); };
}
/** English lines currently shown on that screen, top to bottom. */
export function getScreenTexts(scope) {
  const m = speakRegistry.get(scope);
  if (!m) return [];
  const out = [];
  const seen = new Set();
  [...m.keys()].sort((a, b) => a.order - b.order).forEach((e) => {
    const s = String(e.text || "").replace(/\s+/g, " ").trim();
    if (s && /[\p{L}]/u.test(s) && !seen.has(s)) { seen.add(s); out.push({ text: s, raw: !!e.raw }); }
  });
  return out;
}
export const SpeakScopeContext = createContext(null);
export function SpeakScope({ id, children }) {
  return <SpeakScopeContext.Provider value={id}>{children}</SpeakScopeContext.Provider>;
}

const LanguageContext = createContext({
  lang: "en", setLang: () => {}, t: (s) => s, tf: fill, translateNow: async (a) => a, translating: false,
});

// Alert.alert(...) everywhere shows in the chosen language too.
let currentT = (s) => s;
const origAlert = Alert.alert;
Alert.alert = (title, message, buttons, options) => {
  const tr = (s) => (typeof s === "string" ? currentT(s) : s);
  const btns = Array.isArray(buttons) ? buttons.map((b) => (b && b.text ? { ...b, text: tr(b.text) } : b)) : buttons;
  return origAlert.call(Alert, tr(title), tr(message), btns, options);
};

export function LanguageProvider({ children }) {
  const { apiBaseUrl } = useSettings();
  const [lang, setLangState] = useState(getLanguage());
  const [version, setVersion] = useState(0);
  const [inFlight, setInFlight] = useState(0);
  const cacheRef = useRef({}); // lang -> { englishTemplate: translated }
  const outputsRef = useRef({}); // lang -> Set(translated) — never re-translate our own output
  const failRef = useRef({}); // lang -> { template: attempts }
  const pendingRef = useRef(new Set());
  const inFlightRef = useRef(new Set());
  const timerRef = useRef(null);
  const saveTimerRef = useRef(null);
  const seenRef = useRef(new Set());
  const seenDirtyRef = useRef(false);
  const langRef = useRef(lang);
  langRef.current = lang;
  const apiRef = useRef(apiBaseUrl);
  apiRef.current = apiBaseUrl;
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const remember = useCallback((code, src, dst) => {
    (cacheRef.current[code] || (cacheRef.current[code] = {}))[src] = dst;
    (outputsRef.current[code] || (outputsRef.current[code] = new Set())).add(dst);
  }, []);

  const loadCache = useCallback(async (code) => {
    if (code === "en" || cacheRef.current[code]) return;
    cacheRef.current[code] = {};
    try {
      const raw = await AsyncStorage.getItem(CACHE_PREFIX + code);
      if (raw) Object.entries(JSON.parse(raw)).forEach(([s, d]) => { if (!cacheRef.current[code][s]) remember(code, s, d); });
    } catch (e) { /* ignore */ }
    bump();
  }, [bump, remember]);

  const persist = useCallback((code) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const map = cacheRef.current[code] || {};
      const keys = Object.keys(map);
      // keep the phone cache bounded
      const trimmed = keys.length > 4000 ? Object.fromEntries(keys.slice(-4000).map((k) => [k, map[k]])) : map;
      AsyncStorage.setItem(CACHE_PREFIX + code, JSON.stringify(trimmed)).catch(() => {});
      if (seenDirtyRef.current) {
        seenDirtyRef.current = false;
        AsyncStorage.setItem(SEEN_KEY, JSON.stringify([...seenRef.current].slice(-4000))).catch(() => {});
      }
    }, 1500);
  }, []);

  /** Ask the server; resolves { src: translation } for the ones it could do.
   *  Chunks run in parallel and each one updates the screen as it lands. */
  const request = useCallback(async (code, texts, onChunk) => {
    const base = apiRef.current;
    if (!texts.length || !base) return {};
    const client = makeClient(base, { timeoutMs: 40000 });
    const chunks = [];
    for (let i = 0; i < texts.length; i += CHUNK) chunks.push(texts.slice(i, i + CHUNK));
    const out = {};
    let next = 0;
    async function worker() {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        const got = {};
        try {
          const { data } = await client.post("/api/translate", { lang: code, texts: chunk });
          const tr = (data && data.translations) || [];
          const ok = (data && data.ok) || null;
          chunk.forEach((s, j) => {
            // Old servers send no "ok": trust only a changed string then.
            const good = ok ? ok[j] : tr[j] && tr[j] !== s;
            if (good && typeof tr[j] === "string" && tr[j]) got[s] = tr[j];
          });
        } catch (e) { /* offline / server asleep: retried later */ }
        Object.assign(out, got);
        if (onChunk) onChunk(chunk, got);
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
    return out;
  }, []);

  const scheduleFlush = useCallback((ms = 150) => {
    if (!timerRef.current) timerRef.current = setTimeout(() => flushRef.current(), ms);
  }, []);

  // Result handling shared by the background queue and translateNow().
  const absorb = useCallback((code, chunk, got) => {
    const fails = failRef.current[code] || (failRef.current[code] = {});
    let retry = false;
    chunk.forEach((s) => {
      if (got[s] != null) { remember(code, s, got[s]); delete fails[s]; }
      else {
        fails[s] = (fails[s] || 0) + 1;
        if (fails[s] <= RETRY_MS.length) retry = true;
      }
    });
    persist(code);
    if (retry) {
      const attempt = Math.min(...chunk.filter((s) => got[s] == null).map((s) => fails[s]));
      setTimeout(() => {
        if (langRef.current !== code) return;
        chunk.forEach((s) => { if (got[s] == null && !cacheRef.current[code]?.[s]) pendingRef.current.add(s); });
        scheduleFlush(0);
      }, RETRY_MS[Math.max(0, attempt - 1)] || 45000);
    }
    if (langRef.current === code) bump();
  }, [remember, persist, bump, scheduleFlush]);

  const flush = useCallback(async () => {
    timerRef.current = null;
    const code = langRef.current;
    if (code === "en") { pendingRef.current.clear(); return; }
    if (!cacheRef.current[code]) await loadCache(code);
    const map = cacheRef.current[code] || {};
    const fails = failRef.current[code] || {};
    const texts = [...pendingRef.current].filter((s) => !map[s] && !inFlightRef.current.has(s) && (fails[s] || 0) <= RETRY_MS.length);
    pendingRef.current.clear();
    if (!texts.length) return;
    texts.forEach((s) => inFlightRef.current.add(s));
    setInFlight((n) => n + 1);
    try {
      await request(code, texts, (chunk, got) => {
        chunk.forEach((s) => inFlightRef.current.delete(s));
        absorb(code, chunk, got);
      });
    } finally {
      texts.forEach((s) => inFlightRef.current.delete(s));
      setInFlight((n) => Math.max(0, n - 1));
    }
  }, [request, absorb, loadCache]);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const lookup = useCallback((code, s) => {
    const map = cacheRef.current[code];
    const hit = map && map[s];
    if (hit) return hit;
    pendingRef.current.add(s); // sent once the phone cache / server URL is ready
    scheduleFlush();
    return null;
  }, [scheduleFlush]);

  const t = useCallback((s) => {
    const code = langRef.current;
    if (code === "en" || !needsTranslation(s)) return s;
    const outs = outputsRef.current[code];
    if (outs && outs.has(s)) return s; // already translated text
    const lead = s.match(/^\s*/)[0];
    const trail = s.match(/\s*$/)[0];
    const core = s.trim();
    const { tpl, nums } = mask(core);
    if (!needsTranslation(tpl)) return s; // e.g. only a web address
    if (!seenRef.current.has(tpl)) { seenRef.current.add(tpl); seenDirtyRef.current = true; }
    const hit = lookup(code, tpl);
    if (!hit) return s;
    const done = unmask(hit, nums);
    return done == null ? s : lead + done + trail;
  }, [lookup]);

  /** Template with {placeholders}: the template is translated once (numbers
   *  change every few seconds, the sentence doesn't), then filled in. */
  const tf = useCallback((tpl, vars) => fill(t(tpl), vars), [t]);

  /** Translate a list right now (used by "Speak screen"). */
  const translateNow = useCallback(async (texts, code = langRef.current) => {
    if (code === "en") return texts;
    await loadCache(code);
    const map = cacheRef.current[code] || (cacheRef.current[code] = {});
    const parts = texts.map((s) => {
      if (!needsTranslation(s)) return { s };
      const core = String(s).trim();
      const { tpl, nums } = mask(core);
      return needsTranslation(tpl) ? { s, tpl, nums } : { s };
    });
    const missing = [...new Set(parts.filter((p) => p.tpl && !map[p.tpl]).map((p) => p.tpl))];
    if (missing.length) {
      const got = await request(code, missing);
      absorb(code, missing, got);
    }
    return parts.map((p) => {
      if (!p.tpl || !map[p.tpl]) return p.s;
      const done = unmask(map[p.tpl], p.nums);
      return done == null ? p.s : done;
    });
  }, [loadCache, request, absorb]);

  /** Translate every screen's text in the background — what the app has
   *  shown before plus the fixed text of all screens — so screens not opened
   *  yet are already in the chosen language, from the very first choice.
   *  Text on the open screen was queued first and goes out first. */
  const prewarm = useCallback((code) => {
    if (code === "en") return;
    const map = cacheRef.current[code] || {};
    seenRef.current.forEach((s) => { if (!map[s]) pendingRef.current.add(s); });
    UI_STRINGS.forEach((s) => { if (!map[s]) pendingRef.current.add(s); });
    scheduleFlush(0);
  }, [scheduleFlush]);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(SEEN_KEY);
        if (raw) JSON.parse(raw).forEach((s) => seenRef.current.add(s));
      } catch (e) { /* ignore */ }
      const c = await loadLanguage();
      if (c) { setLangState(c); langRef.current = c; await loadCache(c); prewarm(c); }
    })();
  }, [loadCache, prewarm]);

  // Server URL arrived / changed: send anything still waiting.
  useEffect(() => { if (apiBaseUrl && langRef.current !== "en") { failRef.current = {}; prewarm(langRef.current); } }, [apiBaseUrl, prewarm]);

  const setLang = useCallback(async (code) => {
    setLangState(code);
    langRef.current = code;
    failRef.current[code] = {};
    applyNotifyLanguage(apiRef.current, code); // notifications + read-aloud follow
    await loadCache(code);
    prewarm(code);
    bump();
  }, [loadCache, prewarm, bump]);

  currentT = t;
  const translating = inFlight > 0 && lang !== "en";
  // A new object on every translation batch (version) so consumers re-render.
  const value = useMemo(
    () => ({ lang, setLang, t, tf, translateNow, translating }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, setLang, t, tf, translateNow, translating, version],
  );
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useT() {
  return useContext(LanguageContext);
}
