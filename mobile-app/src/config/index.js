import { Platform } from "react-native";
import Constants from "expo-constants";

// Falls back sensibly if `extra` isn't populated (e.g. bare workflow).
const extra = Constants.expoConfig?.extra || Constants.manifest?.extra || {};

// Same local/LAN-address check used by LiveTrackingScreen.web.js's share-link
// warning — duplicated here rather than imported since this file has no
// screen dependencies and shouldn't gain one just for this.
function isLocalOrLanHost(hostname) {
  const h = (hostname || "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h === "10.0.2.2" || h.endsWith(".local")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

// The web build (Expo `export --platform web`, served by the FastAPI backend
// itself at /mobile-app — see backend/app.py's device-based "/" route) is
// always hosted on the SAME domain as the API, unlike the native app where
// the phone and the server are separate machines. So on web, when the page
// isn't being viewed from a local/dev address, default straight to
// `window.location.origin` instead of the native-app default of
// "http://localhost:8000" — otherwise every deployed mobile-web visitor
// would need to manually fix the API URL in Settings before anything works.
function computeDefaultApiBaseUrl() {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.location?.origin) {
    if (!isLocalOrLanHost(window.location.hostname)) {
      return window.location.origin;
    }
  }
  return extra.defaultApiBaseUrl || "http://localhost:8000";
}

export const DEFAULT_API_BASE_URL = computeDefaultApiBaseUrl();
export const DEFAULT_WS_BASE_URL = DEFAULT_API_BASE_URL.replace(/^http/, "ws");

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
