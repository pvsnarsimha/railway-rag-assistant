import Constants from "expo-constants";

// Falls back sensibly if `extra` isn't populated (e.g. bare workflow).
const extra = Constants.expoConfig?.extra || Constants.manifest?.extra || {};

export const DEFAULT_API_BASE_URL = extra.defaultApiBaseUrl || "http://localhost:8000";
export const DEFAULT_WS_BASE_URL = extra.defaultWsBaseUrl || "ws://localhost:8000";

// AsyncStorage keys, kept in one place so nothing typos a key string.
export const STORAGE_KEYS = {
  API_BASE_URL: "@railway_rag/api_base_url",
  LANGUAGE: "@railway_rag/language",
  // Crowd-Sourced Train Position Reports: anonymous per-device id, see
  // src/utils/reporterId.js.
  REPORTER_ID: "@railway_rag/reporter_id",
};

/**
 * NOTE for the developer running this app:
 * - iOS Simulator can reach a FastAPI server on your Mac via http://localhost:8000
 * - Android Emulator must use http://10.0.2.2:8000 instead of localhost
 * - A physical phone (Expo Go) must use your computer's LAN IP, e.g. http://192.168.1.23:8000
 * The Settings tab lets you change this at runtime without a rebuild, and
 * "Test connection" pings /api/health so you know it's reachable before you
 * start chatting.
 */
