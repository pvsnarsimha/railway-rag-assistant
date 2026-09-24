// OfflineTrackingCard.js
// ----------------------
// FEATURE: GPS / Offline Live Tracking (RailYatri-style "works without internet").
//
// REWORK (per request: "GPS should be used when the user is IN the train or
// there's no internet; if the user isn't on that train, show an error"):
// this card no longer decides on its own to switch GPS on. The Live
// Tracking screen owns the mode:
//   - `gpsOn` (controlled): the screen turns GPS on only after the user
//     answers "Yes" to RailYatri's "Are you inside the train?" prompt.
//   - `onNeedGps(reason)`: asked when the internet drops (or the live feed
//     has been dead for a while) so the screen can show that prompt.
//   - `onResult(result)`: every GPS/cell/timetable placement is reported
//     up, so the screen can draw GPS-based predictions straight onto the
//     live timeline (passed stations, train marker, ETA to every stop).
//   - `onOffRoute(result)`: the fix is far from this train's route — the
//     user isn't on this train; the screen shows the error and switches
//     back to internet.
// While online it still quietly saves the train's route + timetable on the
// phone, so GPS placement works with NO internet at all later.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import { saveRouteCache, loadRouteCache, locateOnRoute, estimateFromTimetable } from "../utils/offlineTracker";
import {
  isCellTowerAvailable, locateByCell, downloadCellMap, contributeObservation,
} from "../utils/cellTower";
import { makePoster } from "../api/railwayApi";

const SAVE_EVERY_MS = 60000;
const LIVE_DOWN_AFTER_MS = 45000;
// Only judge "you're not on this train" from a reasonably sharp fix, and
// only after two such fixes in a row agree — one noisy indoor fix must not
// kick a real passenger out of GPS mode.
const OFF_ROUTE_MAX_ACCURACY_M = 1500;
const OFF_ROUTE_CONFIRMATIONS = 2;

export function useOnlineStatus() {
  const [online, setOnline] = useState(
    Platform.OS === "web" && typeof navigator !== "undefined" && "onLine" in navigator ? navigator.onLine : true
  );
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return undefined;
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

// ------------------------------------------------------------- GPS watcher
async function startGpsWatch(onFix, onError) {
  if (Platform.OS === "web") {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      onError("This browser has no location access.");
      return () => {};
    }
    const id = navigator.geolocation.watchPosition(
      (p) => onFix({
        lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy,
        speed: p.coords.speed, source: "gps", at: p.timestamp || Date.now(),
      }),
      (e) => onError(e && e.code === 1
        ? "Location permission denied — allow location for this site to track by GPS."
        : "Waiting for a GPS fix… (move near a window; the first fix can take a minute offline)"),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }
  try {
    // eslint-disable-next-line global-require
    const Location = require("expo-location");
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== "granted") {
      onError("Location permission denied — allow it to track by GPS.");
      return () => {};
    }
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 30 },
      (p) => onFix({
        lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy,
        speed: p.coords.speed, source: "gps", at: p.timestamp || Date.now(),
      })
    );
    return () => sub.remove();
  } catch (e) {
    onError("Location isn't available in this build.");
    return () => {};
  }
}

export default function OfflineTrackingCard({
  trainNumber, date, payload, connection, apiBaseUrl,
  gpsOn, onNeedGps, onResult, onOffRoute, onStopGps, verifying,
}) {
  const online = useOnlineStatus();
  const [cache, setCache] = useState(null);
  const [result, setResult] = useState(null);
  const [locError, setLocError] = useState(null);
  const lastSaveRef = useRef(0);
  const lastFixRef = useRef(null);
  const stopGpsRef = useRef(null);
  const liveOkAtRef = useRef(Date.now());
  const cellMapFetchedRef = useRef(null);
  const lastContribRef = useRef(0);
  const offRouteCountRef = useRef(0);
  const askedRef = useRef(false);
  const [liveDown, setLiveDown] = useState(false);
  const cacheRef = useRef(null);
  useEffect(() => { cacheRef.current = cache; }, [cache]);
  const cbRef = useRef({ onResult, onOffRoute, onNeedGps });
  useEffect(() => { cbRef.current = { onResult, onOffRoute, onNeedGps }; }, [onResult, onOffRoute, onNeedGps]);

  // Load whatever was saved last time (works fully offline).
  useEffect(() => {
    let cancelled = false;
    setCache(null);
    setResult(null);
    askedRef.current = false;
    if (!trainNumber) return undefined;
    loadRouteCache(trainNumber, date).then((c) => { if (!cancelled && c) setCache((prev) => prev || c); });
    return () => { cancelled = true; };
  }, [trainNumber, date]);

  // Save the live route/timetable to the phone while online.
  useEffect(() => {
    if (!payload || !payload.timeline || !payload.timeline.length || payload.gps_overlay) return;
    if (payload.train_number && String(payload.train_number) !== String(trainNumber)) return;
    if (!payload.snapshot) {
      liveOkAtRef.current = Date.now();
      setLiveDown(false);
    }
    if (Date.now() - lastSaveRef.current < SAVE_EVERY_MS && cache) return;
    lastSaveRef.current = Date.now();
    saveRouteCache(payload, { trainNumber, date }).then((c) => {
      if (!c) return;
      setCache(c);
      if (isCellTowerAvailable() && apiBaseUrl && cellMapFetchedRef.current !== trainNumber) {
        cellMapFetchedRef.current = trainNumber;
        downloadCellMap(makePoster(apiBaseUrl), trainNumber, c);
      }
    });
  }, [payload, trainNumber, date, apiBaseUrl, cache]);

  // "Live down" = no good live payload for a while (tunnel, no signal).
  useEffect(() => {
    const id = setInterval(() => {
      if (connection !== "open" && Date.now() - liveOkAtRef.current > LIVE_DOWN_AFTER_MS) setLiveDown(true);
    }, 5000);
    return () => clearInterval(id);
  }, [connection]);

  const offlineMode = !online || liveDown;

  // No internet → ask the screen to show "Are you inside the train?" once.
  useEffect(() => {
    if (offlineMode && !gpsOn && !askedRef.current && trainNumber) {
      askedRef.current = true;
      if (cbRef.current.onNeedGps) cbRef.current.onNeedGps(online ? "live_down" : "offline");
    }
    if (!offlineMode) askedRef.current = false;
  }, [offlineMode, gpsOn, online, trainNumber]);

  const report = useCallback((r) => {
    setResult(r);
    if (cbRef.current.onResult) cbRef.current.onResult(r);
  }, []);

  const recompute = useCallback((c) => {
    const cc = c || cacheRef.current;
    if (!cc) return;
    const fix = lastFixRef.current;
    const fresh = fix && Date.now() - (fix.at || 0) < 3 * 60000;
    if (!fresh) {
      report(estimateFromTimetable(cc));
      return;
    }
    const r = locateOnRoute(cc, fix);
    if (r && r.error && r.offRouteKm != null) {
      const sharp = fix.accuracy == null || fix.accuracy <= OFF_ROUTE_MAX_ACCURACY_M;
      offRouteCountRef.current = sharp ? offRouteCountRef.current + 1 : offRouteCountRef.current;
      if (offRouteCountRef.current >= OFF_ROUTE_CONFIRMATIONS && cbRef.current.onOffRoute) {
        offRouteCountRef.current = 0;
        cbRef.current.onOffRoute(r);
      }
      setResult(r);
      return;
    }
    offRouteCountRef.current = 0;
    report(r);
  }, [report]);

  const stopLocation = useCallback(() => {
    if (stopGpsRef.current) { stopGpsRef.current(); stopGpsRef.current = null; }
  }, []);

  const startLocation = useCallback(async () => {
    if (stopGpsRef.current) return;
    setLocError(null);
    offRouteCountRef.current = 0;
    const stop = await startGpsWatch(
      (fix) => {
        lastFixRef.current = fix;
        setLocError(null);
        recompute();
        if (online && isCellTowerAvailable() && apiBaseUrl && Date.now() - lastContribRef.current > 120000) {
          lastContribRef.current = Date.now();
          contributeObservation(makePoster(apiBaseUrl), fix);
        }
      },
      (msg) => setLocError(msg)
    );
    stopGpsRef.current = stop;
  }, [recompute, online, apiBaseUrl]);

  // Controlled by the screen: GPS runs exactly while gpsOn is true.
  useEffect(() => {
    if (gpsOn) {
      startLocation();
      if (cacheRef.current) recompute(cacheRef.current);
    } else {
      stopLocation();
      lastFixRef.current = null;
      setResult(null);
      if (cbRef.current.onResult) cbRef.current.onResult(null);
    }
  }, [gpsOn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (gpsOn && cache) recompute(cache); }, [cache]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cell-tower fallback + refresh of the estimate every 20s while on GPS.
  useEffect(() => {
    if (!gpsOn) return undefined;
    const id = setInterval(async () => {
      const fix = lastFixRef.current;
      const gpsStale = !fix || fix.source !== "gps" || Date.now() - (fix.at || 0) > 60000;
      if (gpsStale && isCellTowerAvailable()) {
        const cellFix = await locateByCell(trainNumber);
        if (cellFix) lastFixRef.current = { ...cellFix, at: Date.now() };
      }
      recompute();
    }, 20000);
    return () => clearInterval(id);
  }, [gpsOn, trainNumber, recompute]);

  useEffect(() => () => stopLocation(), [stopLocation]);

  if (!trainNumber) return null;

  if (!gpsOn) {
    if (!offlineMode) return null; // online: the Internet/GPS switch on the screen covers it
    return (
      <View style={[styles.strip, styles.stripWarn]}>
        <Ionicons name="cloud-offline-outline" size={16} color={colors.danger} />
        <Text style={styles.stripText}>
          {online ? "Live feed not responding." : "No internet."}
          {cache ? " On the train? Switch to GPS to keep tracking." : " Open this train once with internet to enable GPS tracking."}
        </Text>
        {cache && onNeedGps ? (
          <TouchableOpacity onPress={() => onNeedGps("manual")} style={styles.linkBtn}>
            <Text style={styles.linkBtnText}>Use GPS</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  let line;
  if (!cache) line = `No saved route for train ${trainNumber} yet — open it once with internet.`;
  else if (locError && !result) line = locError;
  else if (!result) line = "Getting your GPS position…";
  else if (result.error) line = result.error;
  else {
    const bits = [];
    if (result.source === "gps" && result.accuracyM != null) bits.push(`±${Math.round(result.accuracyM)} m`);
    if (result.speedKmph != null) bits.push(result.speedKmph > 2 ? `${Math.round(result.speedKmph)} km/h` : "stopped");
    if (result.source === "timetable") bits.push("no GPS fix — timetable estimate");
    if (result.source === "cell") bits.push("cell tower");
    line = bits.join(" · ") || "GPS position on route";
    if (verifying) line = `Checking you're on this train… (${line})`;
  }

  return (
    <View style={styles.strip}>
      <Ionicons name="navigate" size={16} color={colors.accent} />
      <View style={{ flex: 1 }}>
        <Text style={styles.stripTitle}>GPS tracking{offlineMode ? " · no internet needed" : ""}</Text>
        <Text style={[styles.stripText, result && result.error ? { color: colors.danger } : null]}>{line}</Text>
      </View>
      <TouchableOpacity onPress={onStopGps} style={styles.linkBtn}>
        <Text style={styles.linkBtnText}>Stop GPS</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    backgroundColor: "#FFF8EE", borderColor: colors.accent, borderWidth: 1, borderRadius: radius.md, marginBottom: spacing.sm,
  },
  stripWarn: { backgroundColor: "#fdecec", borderColor: "#f3b4b4" },
  stripTitle: { fontSize: 12.5, fontWeight: "700", color: colors.text },
  stripText: { flex: 1, fontSize: 12, color: colors.textMuted },
  linkBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.primary, backgroundColor: "#fff" },
  linkBtnText: { fontSize: 12, color: colors.primary, fontWeight: "600" },
});
