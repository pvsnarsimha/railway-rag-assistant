// cellTower.js
// ------------
// FEATURE (plan + wiring): RailYatri-style cell-tower location for offline
// Live Tracking.
//
// Reading the phone's serving cell tower (MCC/MNC/LAC-or-TAC/Cell ID) needs
// Android's TelephonyManager — a NATIVE API that browsers and Expo Go do not
// expose at all. It becomes available only after the native module in
// mobile-app/native-modules-plan/cell-tower is moved into mobile-app/modules/
// and the app is rebuilt as an EAS dev/production build (see
// docs/CELL_TOWER_OFFLINE_PLAN.md). Until then every function here returns
// "unavailable" and the app uses GPS instead — nothing breaks.
//
// Flow once the module exists:
//   online : while tracking, pair each GPS fix with the serving cell and send
//            it to the backend (crowdsourced tower map, like RailYatri's own)
//            + download the towers near this train's route to the phone.
//   offline: serving cell -> look it up in the downloaded map -> lat/lng ->
//            offlineTracker.locateOnRoute(..., { source: "cell" }).

import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

let nativeModule;
function getNative() {
  if (nativeModule !== undefined) return nativeModule;
  nativeModule = null;
  if (Platform.OS !== "android") return nativeModule;
  try {
    // eslint-disable-next-line global-require
    const { requireOptionalNativeModule } = require("expo-modules-core");
    nativeModule = requireOptionalNativeModule("CellTower") || null;
  } catch (e) {
    nativeModule = null;
  }
  return nativeModule;
}

export function isCellTowerAvailable() {
  return !!getNative();
}

export function cellTowerUnavailableReason() {
  if (Platform.OS === "web") return "Browsers can't read cell-tower IDs — using GPS instead.";
  if (Platform.OS !== "android") return "Cell-tower lookup is Android-only — using GPS instead.";
  return "Needs the CellTower native module (EAS build, not Expo Go) — using GPS instead.";
}

/** { radio, mcc, mnc, area, cid, dbm } | null */
export async function getServingCell() {
  const mod = getNative();
  if (!mod) return null;
  try {
    const cells = await mod.getServingCells();
    return Array.isArray(cells) && cells.length ? cells[0] : null;
  } catch (e) {
    return null;
  }
}

export function cellKey(c) {
  return c ? `${c.radio || ""}:${c.mcc}:${c.mnc}:${c.area}:${c.cid}` : "";
}

const MAP_PREFIX = "liveTracking.cellMap.";

/** Downloads (online) the known towers near this train's cached route. */
export async function downloadCellMap(apiClientPost, trainNumber, routeCache) {
  if (!routeCache || !routeCache.stops) return null;
  const points = routeCache.stops.filter((s) => s.lat != null && s.lng != null).map((s) => [s.lat, s.lng]);
  if (points.length < 2) return null;
  try {
    const data = await apiClientPost("/api/offline/cell-map", { points });
    const map = {};
    (data.cells || []).forEach((c) => { map[cellKey(c)] = { lat: c.lat, lng: c.lng, samples: c.samples }; });
    await AsyncStorage.setItem(MAP_PREFIX + trainNumber, JSON.stringify({ savedAt: Date.now(), map }));
    return map;
  } catch (e) {
    return null;
  }
}

export async function loadCellMap(trainNumber) {
  try {
    const raw = await AsyncStorage.getItem(MAP_PREFIX + trainNumber);
    return raw ? JSON.parse(raw).map : null;
  } catch (e) {
    return null;
  }
}

/** Offline: current serving cell -> { lat, lng, accuracy, source: "cell" } | null */
export async function locateByCell(trainNumber) {
  const cell = await getServingCell();
  if (!cell) return null;
  const map = await loadCellMap(trainNumber);
  const hit = map && map[cellKey(cell)];
  if (!hit) return null;
  return { lat: hit.lat, lng: hit.lng, accuracy: 1500, source: "cell", cell };
}

/** Online: pair a real GPS fix with the serving cell and contribute it. */
export async function contributeObservation(apiClientPost, gpsFix) {
  if (!gpsFix || gpsFix.accuracy == null || gpsFix.accuracy > 100) return;
  const cell = await getServingCell();
  if (!cell) return;
  try {
    await apiClientPost("/api/offline/cell-observations", {
      observations: [{ ...cell, lat: gpsFix.lat, lng: gpsFix.lng, accuracy: gpsFix.accuracy }],
    });
  } catch (e) { /* best-effort */ }
}
