import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_API_BASE_URL, STORAGE_KEYS } from "../config";

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [apiBaseUrl, setApiBaseUrlState] = useState(DEFAULT_API_BASE_URL);
  const [language, setLanguageState] = useState("auto");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [storedUrl, storedLang] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.API_BASE_URL),
          AsyncStorage.getItem(STORAGE_KEYS.LANGUAGE),
        ]);
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

  const wsBaseUrl = useMemo(() => apiBaseUrl.replace(/^http/, "ws"), [apiBaseUrl]);

  const value = useMemo(
    () => ({ apiBaseUrl, wsBaseUrl, setApiBaseUrl, language, setLanguage, loaded }),
    [apiBaseUrl, wsBaseUrl, setApiBaseUrl, language, setLanguage, loaded]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within a SettingsProvider");
  return ctx;
}
