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
  lang: "en", setLang: () => {}, t: (s) => s, tf: fill, translateNow: async (a) => a,
});

function needsTranslation(s) {
  return typeof s === "string" && /[A-Za-z]{2,}/.test(s) && !/^[A-Z]{2,5}$/.test(s.trim());
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

  const loadCache = useCallback(async (code) => {
    if (code === "en" || cacheRef.current[code]) return;
    cacheRef.current[code] = {};
    try {
      const raw = await AsyncStorage.getItem(CACHE_PREFIX + code);
      if (raw) cacheRef.current[code] = { ...JSON.parse(raw), ...cacheRef.current[code] };
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

  const request = useCallback(async (code, texts) => {
    if (!texts.length || !apiBaseUrl) return {};
    const client = makeClient(apiBaseUrl, { timeoutMs: 45000 });
    const out = {};
    for (let i = 0; i < texts.length; i += 100) {
      const chunk = texts.slice(i, i + 100);
      try {
        const { data } = await client.post("/api/translate", { lang: code, texts: chunk });
        const tr = (data && data.translations) || [];
        chunk.forEach((s, j) => { if (tr[j] && tr[j] !== s) out[s] = tr[j]; });
      } catch (e) { /* offline / server asleep: stay in English */ }
    }
    return out;
  }, [apiBaseUrl]);

  const flush = useCallback(async () => {
    timerRef.current = null;
    const code = langRef.current;
    if (code === "en") { pendingRef.current.clear(); return; }
    const texts = [...pendingRef.current].filter((s) => !inFlightRef.current.has(s));
    pendingRef.current.clear();
    if (!texts.length) return;
    texts.forEach((s) => inFlightRef.current.add(s));
    const got = await request(code, texts);
    texts.forEach((s) => inFlightRef.current.delete(s));
    const map = cacheRef.current[code] || (cacheRef.current[code] = {});
    // Remember "no change" too, so the same string isn't asked for again.
    texts.forEach((s) => { map[s] = got[s] || map[s] || s; });
    persist(code);
    if (langRef.current === code) setVersion((v) => v + 1);
  }, [request, persist]);

  const t = useCallback((s) => {
    const code = langRef.current;
    if (code === "en" || !needsTranslation(s)) return s;
    const map = cacheRef.current[code];
    if (map && map[s]) return map[s];
    pendingRef.current.add(s);
    if (!timerRef.current) timerRef.current = setTimeout(flush, 200);
    return s;
  }, [flush]);

  /** Template with {placeholders}: the template is translated once (numbers
   *  change every few seconds, the sentence doesn't), then filled in. */
  const tf = useCallback((tpl, vars) => fill(t(tpl), vars), [t]);

  /** Translate a list right now (used by "Speak screen"). */
  const translateNow = useCallback(async (texts, code = langRef.current) => {
    if (code === "en") return texts;
    await loadCache(code);
    const map = cacheRef.current[code] || (cacheRef.current[code] = {});
    const missing = texts.filter((s) => needsTranslation(s) && !map[s]);
    if (missing.length) {
      const got = await request(code, missing);
      missing.forEach((s) => { map[s] = got[s] || s; });
      persist(code);
    }
    return texts.map((s) => map[s] || s);
  }, [loadCache, request, persist]);

  const setLang = useCallback(async (code) => {
    setLangState(code);
    langRef.current = code;
    await loadCache(code);
    applyNotifyLanguage(apiBaseUrl, code); // notifications + read-aloud follow
    setVersion((v) => v + 1);
  }, [apiBaseUrl, loadCache]);

  const value = useMemo(() => ({ lang, setLang, t, tf, translateNow }), [lang, setLang, t, tf, translateNow]);
  // A new object on every translation batch so consumers re-render.
  return <LanguageContext.Provider value={{ ...value }}>{children}</LanguageContext.Provider>;
}

export function useT() {
  return useContext(LanguageContext);
}
