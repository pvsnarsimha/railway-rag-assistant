import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_API_BASE_URL, STORAGE_KEYS } from "../config";

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [apiBaseUrl, setApiBaseUrlState] = useState(DEFAULT_API_BASE_URL);
  const [language, setLanguageState] = useState("auto");
  const [handsFree, setHandsFreeState] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [storedUrl, storedLang, storedHandsFree] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.API_BASE_URL),
          AsyncStorage.getItem(STORAGE_KEYS.LANGUAGE),
          AsyncStorage.getItem(STORAGE_KEYS.HANDS_FREE),
        ]);
        if (storedHandsFree === "1") setHandsFreeState(true);
        if (storedUrl) setApiBaseUrlState(storedUrl);
        if (storedLang) setLanguageState(storedLang);
      } catch (e) {
        // Non-fatal — just keep the in-memory defaults.
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const setApiBaseUrl = useCallback(async (url) => {
    const trimmed = url.trim().replace(/\/+$/, ""); // strip trailing slash(es)
    setApiBaseUrlState(trimmed);
    await AsyncStorage.setItem(STORAGE_KEYS.API_BASE_URL, trimmed);
  }, []);

  const setLanguage = useCallback(async (lang) => {
    setLanguageState(lang);
    await AsyncStorage.setItem(STORAGE_KEYS.LANGUAGE, lang);
  }, []);

  // Hands-free mode: screens ask for their fields by voice and fill them.
  const setHandsFree = useCallback(async (on) => {
    setHandsFreeState(!!on);
    try { await AsyncStorage.setItem(STORAGE_KEYS.HANDS_FREE, on ? "1" : "0"); } catch (e) { /* non-fatal */ }
  }, []);

  const wsBaseUrl = useMemo(() => apiBaseUrl.replace(/^http/, "ws"), [apiBaseUrl]);

  const value = useMemo(
    () => ({ apiBaseUrl, wsBaseUrl, setApiBaseUrl, language, setLanguage, handsFree, setHandsFree, loaded }),
    [apiBaseUrl, wsBaseUrl, setApiBaseUrl, language, setLanguage, handsFree, setHandsFree, loaded]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within a SettingsProvider");
  return ctx;
}
