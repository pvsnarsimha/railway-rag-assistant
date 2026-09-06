import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../config";

/**
 * FEATURE: Crowd-Sourced Train Position Reports — anonymous, per-device
 * reporter id. Same "no login system in this app" pattern push
 * notifications already uses for FCM device tokens (see backend's
 * push_store.py docstring) — this id identifies a DEVICE for badge
 * counting and clustering "agreeing reports", not a real person. Generated
 * once and persisted in AsyncStorage so a device's lifetime report count
 * (and badge) survives app restarts.
 *
 * Deliberately a plain Math.random-based v4-shaped id, not a crypto RNG —
 * this only needs to be practically unique across devices for
 * badge-counting and report-clustering purposes, not security-sensitive,
 * so it avoids pulling in an extra native crypto dependency for it.
 */
function _generateId() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
  return template.replace(/[xy]/g, (c) => {
    if (c === "y") {
      const r = Math.floor(Math.random() * 16);
      return ((r & 0x3) | 0x8).toString(16);
    }
    return hex();
  });
}

let _cached = null;

export async function getReporterId() {
  if (_cached) return _cached;
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEYS.REPORTER_ID);
    if (stored) {
      _cached = stored;
      return stored;
    }
  } catch (e) {
    // fall through to generating a fresh one for this session
  }
  const fresh = _generateId();
  try {
    await AsyncStorage.setItem(STORAGE_KEYS.REPORTER_ID, fresh);
  } catch (e) {
    // non-fatal — this session just won't persist its id across restarts
  }
  _cached = fresh;
  return fresh;
}
