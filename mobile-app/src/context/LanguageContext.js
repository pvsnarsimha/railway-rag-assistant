// LanguageContext.js
// ------------------
// FEATURE: the app's screens in the user's language (Home, Railway
// Assistant, Live Tracking): headings, labels AND station / train names,
// for English + the 22 Eighth-Schedule languages. Default: English.
//
//   const { t, lang } = useT();
//   <Text>{t("Coach layout")}</Text>        // "కోచ్ అమరిక" in Telugu
//   <Text>{t(stop.name)}</Text>             // "కాట్పాడి జం." (transliterated)
//
// t() never blocks: it returns the English text at once, asks the server
// (POST /api/translate, batched) for anything it hasn't seen, and the
// screen re-renders with the translation a moment later. Translations are
// kept on the phone per language, so they're instant next time / offline.
//
// The same choice is the notification language (utils/notifyLanguage.js),
// so screen, notifications and read-aloud always match.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSettings } from "./SettingsContext";
import { getLanguage, loadLanguage } from "../utils/notifyLanguage";
import { applyNotifyLanguage } from "../services/backgroundTracking";
import { makeClient } from "../api/client";

const CACHE_PREFIX = "i18n.cache.";
function fill(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}

const LanguageContext = createContext({
  lang: "en", setLang: () => {}, t: (s) => s, tf: fill, tAuto: (s) => s, translateNow: async (a) => a, translating: false,
});

// Module-level handle so non-hook code (Alert wrapper in i18n/Localized.js)
// can translate too.
let globalTranslator = { lang: "en", tAuto: (s) => s, translateNow: async (a) => a };
export function getTranslator() {
  return globalTranslator;
}

export function needsTranslation(s) {
  if (typeof s !== "string") return false;
  const x = s.trim();
  if (!/[A-Za-z]{2,}/.test(x) || /^[A-Z]{2,5}$/.test(x)) return false;
  if (/^(https?:\/\/|www\.)\S+$/i.test(x) || /^\S+@\S+\.\S+$/.test(x)) return false; // links, e-mails
  // Already (mostly) in an Indian script: e.g. an assistant answer in Telugu
  // that mentions "PNR" — don't send it back for translation.
  const latin = (x.match(/[A-Za-z]/g) || []).length;
  const other = (x.match(/[\u0900-\u0DFF\u0600-\u06FF\uABC0-\uABFF\u1C50-\u1C7F]/g) || []).length;
  return latin > other;
}

// "Arrives in 12 min (13:38)" -> template "Arrives in {0} min ({1}:{2})" +
// ["12","13","38"], so text whose numbers change every few seconds is
// translated once, not on every refresh.
function maskNumbers(s) {
  const nums = [];
  const tpl = s.replace(/\d+(?:[.,]\d+)*/g, (m) => `{${nums.push(m) - 1}}`);
  return { tpl, nums };
}

export function LanguageProvider({ children }) {
  const { apiBaseUrl } = useSettings();
  const [lang, setLangState] = useState(getLanguage());
  const [, setVersion] = useState(0);
  const cacheRef = useRef({}); // lang -> { english: translated }
  const pendingRef = useRef(new Set());
  const inFlightRef = useRef(new Set());
  const timerRef = useRef(null);
  const saveTimerRef = useRef(null);
  const langRef = useRef(lang);
  langRef.current = lang;
  const failedRef = useRef(new Map()); // text -> { at: retry-after, tries }
  const retryTimerRef = useRef(null);
  // lang -> Set of translated strings, so text that is already a
  // translation (e.g. "PNR స్థితి") is never sent back to be translated.
  const doneRef = useRef({});
  const markDone = (code, values) => {
    const set = doneRef.current[code] || (doneRef.current[code] = new Set());
    values.forEach((v) => set.add(v));
  };
  const [translating, setTranslating] = useState(false);

  const loadCache = useCallback(async (code) => {
    if (code === "en" || cacheRef.current[code]) return;
    cacheRef.current[code] = {};
    try {
      const raw = await AsyncStorage.getItem(CACHE_PREFIX + code);
      if (raw) {
        // Older app versions stored the English text when the server was
        // asleep; drop those "translations" so they're fetched properly.
        const saved = JSON.parse(raw) || {};
        Object.keys(saved).forEach((k) => { if (saved[k] === k) delete saved[k]; });
        cacheRef.current[code] = { ...saved, ...cacheRef.current[code] };
        markDone(code, Object.values(saved));
      }
    } catch (e) { /* ignore */ }
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    loadLanguage().then((c) => { if (c) { setLangState(c); loadCache(c); } });
  }, [loadCache]);

  const persist = useCallback((code) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const map = cacheRef.current[code] || {};
      const keys = Object.keys(map);
      // keep the phone cache bounded
      const trimmed = keys.length > 3000 ? Object.fromEntries(keys.slice(-3000).map((k) => [k, map[k]])) : map;
      AsyncStorage.setItem(CACHE_PREFIX + code, JSON.stringify(trimmed)).catch(() => {});
    }, 1500);
  }, []);

  // Returns { english: translated } for everything the server translated.
  // Texts the server couldn't translate (or a network failure) are NOT
  // returned, so they're retried later instead of being remembered as
  // English forever — that is what used to leave a freshly chosen
  // language half in English.
  const request = useCallback(async (code, texts, onChunk) => {
    if (!texts.length || !apiBaseUrl) return {};
    const client = makeClient(apiBaseUrl, { timeoutMs: 60000 });
    const out = {};
    const chunks = [];
    for (let i = 0; i < texts.length; i += 40) chunks.push(texts.slice(i, i + 40));
    let next = 0;
    async function worker() {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        const got = {};
        try {
          const { data } = await client.post("/api/translate", { lang: code, texts: chunk });
          const tr = (data && data.translations) || [];
          const failed = new Set((data && data.failed) || []);
          chunk.forEach((s, j) => {
            if (failed.has(j) || typeof tr[j] !== "string") return;
            got[s] = tr[j];
          });
        } catch (e) { /* offline / server asleep: retried later */ }
        Object.assign(out, got);
        if (onChunk) onChunk(got, chunk);
      }
    }
    // A few requests at once so the first screen fills in quickly.
    await Promise.all([worker(), worker(), worker()]);
    return out;
  }, [apiBaseUrl]);

  const storeChunk = useCallback((code, got, asked) => {
    const map = cacheRef.current[code] || (cacheRef.current[code] = {});
    const now = Date.now();
    asked.forEach((s) => {
      if (got[s] != null) {
        map[s] = got[s];
        markDone(code, [got[s]]);
        failedRef.current.delete(s);
      } else {
        const tries = (failedRef.current.get(s)?.tries || 0) + 1;
        failedRef.current.set(s, { at: now + Math.min(60000, 3000 * tries), tries });
      }
    });
    persist(code);
    if (langRef.current === code) setVersion((v) => v + 1);
  }, [persist]);

  const flush = useCallback(async () => {
    timerRef.current = null;
    const code = langRef.current;
    if (code === "en") { pendingRef.current.clear(); return; }
    const have = cacheRef.current[code] || {};
    const texts = [...pendingRef.current].filter((s) => !inFlightRef.current.has(s) && !have[s]);
    pendingRef.current.clear();
    if (!texts.length) return;
    texts.forEach((s) => inFlightRef.current.add(s));
    setTranslating(true);
    try {
      await request(code, texts, (got, chunk) => storeChunk(code, got, chunk));
    } finally {
      texts.forEach((s) => inFlightRef.current.delete(s));
      if (!inFlightRef.current.size) setTranslating(false);
    }
    // Anything that failed is asked for again after a short wait.
    const retry = [...failedRef.current.entries()].filter(([, f]) => f.tries <= 6);
    if (retry.length && langRef.current === code && !retryTimerRef.current) {
      const wait = Math.max(1000, Math.min(...retry.map(([, f]) => f.at)) - Date.now());
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (langRef.current !== code) return;
        retry.forEach(([s]) => pendingRef.current.add(s));
        if (!timerRef.current) timerRef.current = setTimeout(flush, 50);
      }, wait);
    }
  }, [request, storeChunk]);

  const t = useCallback((s) => {
    const code = langRef.current;
    if (code === "en" || !needsTranslation(s)) return s;
    const map = cacheRef.current[code];
    if (map && map[s]) return map[s];
    if (doneRef.current[code] && doneRef.current[code].has(s)) return s;
    const failed = failedRef.current.get(s);
    if (failed && failed.at > Date.now()) return s; // waiting to retry
    pendingRef.current.add(s);
    if (!timerRef.current) timerRef.current = setTimeout(flush, 200);
    return s;
  }, [flush]);

  /** Template with {placeholders}: the template is translated once (numbers
   *  change every few seconds, the sentence doesn't), then filled in. */
  const tf = useCallback((tpl, vars) => fill(t(tpl), vars), [t]);

  /** Any text shown on screen (used by the <Text> in i18n/Localized.js):
   *  keeps surrounding spaces and translates numbers-masked templates. */
  const tAuto = useCallback((s) => {
    if (langRef.current === "en" || !needsTranslation(s)) return s;
    const lead = s.match(/^\s*/)[0];
    const trail = s.slice(lead.length).match(/\s*$/)[0];
    const core = s.slice(lead.length, s.length - trail.length);
    if (!/\d/.test(core)) return lead + t(core) + trail;
    const { tpl, nums } = maskNumbers(core);
    const tr = t(tpl);
    if (tr === tpl) return s;
    // The translation must keep every number, otherwise show English.
    for (let i = 0; i < nums.length; i++) if (!tr.includes(`{${i}}`)) return s;
    return lead + fill(tr, nums) + trail;
  }, [t]);

  /** Translate a list right now (used by "Speak screen"). */
  const translateNow = useCallback(async (texts, code = langRef.current) => {
    if (code === "en") return texts;
    await loadCache(code);
    const map = cacheRef.current[code] || (cacheRef.current[code] = {});
    const done = doneRef.current[code] || new Set();
    const missing = [...new Set(texts.filter((s) => needsTranslation(s) && !map[s] && !done.has(s)))];
    if (missing.length) {
      const got = await request(code, missing);
      Object.assign(map, got);
      markDone(code, Object.values(got));
      persist(code);
    }
    return texts.map((s) => map[s] || s);
  }, [loadCache, request, persist]);

  const setLang = useCallback(async (code) => {
    setLangState(code);
    langRef.current = code;
    failedRef.current.clear();
    await loadCache(code);
    applyNotifyLanguage(apiBaseUrl, code); // notifications + read-aloud follow
    setVersion((v) => v + 1);
  }, [apiBaseUrl, loadCache]);

  const value = useMemo(() => ({ lang, setLang, t, tf, tAuto, translateNow, translating }),
    [lang, setLang, t, tf, tAuto, translateNow, translating]);
  globalTranslator = { lang, tAuto, translateNow };
  // A new object on every translation batch so consumers re-render.
  return <LanguageContext.Provider value={{ ...value }}>{children}</LanguageContext.Provider>;
}

export function useT() {
  return useContext(LanguageContext);
}
