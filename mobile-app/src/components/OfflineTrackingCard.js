// OfflineTrackingCard.js
// ----------------------
// FEATURE: Offline Live Tracking (RailYatri-style "works without internet").
//
// Shown under Live Tracking for the train being tracked. While online it
// quietly saves the train's route + timetable on the phone. When the
// internet drops (or the live connection has been down for a while) it
// switches on by itself and places the train using, in order:
//   1. Cell tower  — only on an Android EAS build with the CellTower native
//                    module (see utils/cellTower.js); browsers/Expo Go can't.
//   2. Phone GPS   — works with NO internet / mobile data (GPS is satellite).
//   3. Timetable   — cached schedule + last known delay, labelled "estimate".
// Nothing here makes a network call while offline.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import { saveRouteCache, loadRouteCache, locateOnRoute, estimateFromTimetable } from "../utils/offlineTracker";
import {
  isCellTowerAvailable, cellTowerUnavailableReason, locateByCell, downloadCellMap, contributeObservation,
} from "../utils/cellTower";
import { makePoster } from "../api/railwayApi";

const SAVE_EVERY_MS = 60000;
const LIVE_DOWN_AFTER_MS = 45000;

function useOnlineStatus() {
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
        ? "Location permission denied — allow location for this site to track offline."
        : "Waiting for a GPS fix… (move near a window; first fix can take a minute offline)"),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 60000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }
  try {
    // eslint-disable-next-line global-require
    const Location = require("expo-location");
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== "granted") {
      onError("Location permission denied — allow it to track offline.");
      return () => {};
    }
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 10000, distanceInterval: 50 },
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

const SOURCE_LABEL = { gps: "GPS (no internet needed)", cell: "Cell tower", timetable: "Timetable estimate" };

export default function OfflineTrackingCard({ trainNumber, date, payload, connection, apiBaseUrl }) {
  const online = useOnlineStatus();
  const [cache, setCache] = useState(null);
  const [active, setActive] = useState(false); // location tracking running
  const [result, setResult] = useState(null);
  const [locError, setLocError] = useState(null);
  const lastSaveRef = useRef(0);
  const lastFixRef = useRef(null);
  const stopGpsRef = useRef(null);
  const liveOkAtRef = useRef(Date.now());
  const cellMapFetchedRef = useRef(null);
  const lastContribRef = useRef(0);
  const [liveDown, setLiveDown] = useState(false);
  const cacheRef = useRef(null);
  useEffect(() => { cacheRef.current = cache; }, [cache]);

  // Load whatever was saved last time (works fully offline).
  useEffect(() => {
    let cancelled = false;
    setCache(null);
    setResult(null);
    if (!trainNumber) return undefined;
    loadRouteCache(trainNumber, date).then((c) => { if (!cancelled && c) setCache(c); });
    return () => { cancelled = true; };
  }, [trainNumber, date]);

  // Save the live route/timetable to the phone while online.
  useEffect(() => {
    if (!payload || !payload.timeline || !payload.timeline.length) return;
    if (payload.train_number && String(payload.train_number) !== String(trainNumber)) return;
    liveOkAtRef.current = Date.now();
    setLiveDown(false);
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
      // `connection` is optional (the native screen doesn't expose it) —
      // without it, "no fresh live payload for 45s" alone decides.
      if (connection !== "open" && Date.now() - liveOkAtRef.current > LIVE_DOWN_AFTER_MS) setLiveDown(true);
    }, 5000);
    return () => clearInterval(id);
  }, [connection]);

  const offlineMode = !online || liveDown;

  const recompute = useCallback((c) => {
    const cc = c || cacheRef.current;
    if (!cc) return;
    const fix = lastFixRef.current;
    const fresh = fix && Date.now() - (fix.at || 0) < 3 * 60000;
    const r = fresh ? locateOnRoute(cc, fix) : estimateFromTimetable(cc);
    setResult(r);
  }, []);

  const stopLocation = useCallback(() => {
    if (stopGpsRef.current) { stopGpsRef.current(); stopGpsRef.current = null; }
    setActive(false);
  }, []);

  const startLocation = useCallback(async () => {
    if (stopGpsRef.current) return;
    setActive(true);
    setLocError(null);
    stopGpsRef.current = await startGpsWatch(
      (fix) => {
        lastFixRef.current = fix;
        setLocError(null);
        recompute();
        // Online + a sharp GPS fix: contribute a (cell, location) pair to the
        // crowdsourced tower map — only possible on the native cell build.
        if (online && isCellTowerAvailable() && apiBaseUrl && Date.now() - lastContribRef.current > 120000) {
          lastContribRef.current = Date.now();
          contributeObservation(makePoster(apiBaseUrl), fix);
        }
      },
      (msg) => setLocError(msg)
    );
  }, [recompute, online, apiBaseUrl]);

  // Auto-switch on when offline; auto-release GPS when back online.
  useEffect(() => {
    if (offlineMode && cache) {
      startLocation();
      recompute(cache);
    } else if (!offlineMode && active) {
      stopLocation();
    }
  }, [offlineMode, cache]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cell-tower fallback + refresh of the timetable estimate every 30s.
  useEffect(() => {
    if (!offlineMode) return undefined;
    const id = setInterval(async () => {
      const fix = lastFixRef.current;
      const gpsStale = !fix || fix.source !== "gps" || Date.now() - (fix.at || 0) > 60000;
      if (gpsStale && isCellTowerAvailable()) {
        const cellFix = await locateByCell(trainNumber);
        if (cellFix) lastFixRef.current = { ...cellFix, at: Date.now() };
      }
      recompute();
    }, 30000);
    return () => clearInterval(id);
  }, [offlineMode, trainNumber, recompute]);

  useEffect(() => () => stopLocation(), [stopLocation]);

  if (!trainNumber) return null;

  // Online & healthy: a single slim "ready" line so people know it exists.
  if (!offlineMode && !active) {
    return (
      <View style={styles.readyRow}>
        <Ionicons name={cache ? "cloud-done-outline" : "cloud-download-outline"} size={16} color={cache ? colors.success : colors.textMuted} />
        <Text style={styles.readyText}>
          {cache
            ? `Offline tracking ready — route saved ${cache.savedAt ? new Date(cache.savedAt).toTimeString().slice(0, 5) : ""}. Works on GPS if you lose internet.`
            : "Saving this train's route for offline tracking…"}
        </Text>
        {cache ? (
          <TouchableOpacity onPress={() => { startLocation(); recompute(); }} style={styles.linkBtn}>
            <Text style={styles.linkBtnText}>Try GPS</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name={offlineMode ? "cloud-offline-outline" : "navigate-outline"} size={18} color={colors.accent} />
        <Text style={styles.title}>{offlineMode ? "Offline tracking" : "GPS tracking"}</Text>
        {result && !result.error ? (
          <View style={styles.badge}><Text style={styles.badgeText}>{SOURCE_LABEL[result.source] || result.source}</Text></View>
        ) : null}
      </View>

      {!cache ? (
        <Text style={styles.muted}>No saved route for train {trainNumber} yet — open it once with internet so it can be tracked offline.</Text>
      ) : result && result.error ? (
        <Text style={styles.warn}>{result.error}</Text>
      ) : result ? (
        <>
          <Text style={styles.headline}>{result.headline}</Text>
          {result.nextHalt ? (
            <Text style={styles.detail}>
              Next halt {result.nextHalt}{result.nextHaltEta ? ` · est. ${result.nextHaltEta}` : ""}
              {result.delayMinutes > 0 ? ` · last known ${result.delayMinutes} min late` : ""}
            </Text>
          ) : null}
          <Text style={styles.muted}>
            {result.source === "gps" && result.accuracyM != null ? `GPS ±${Math.round(result.accuracyM)} m · ` : ""}
            {result.speedKmph != null && result.speedKmph > 1 ? `${Math.round(result.speedKmph)} km/h · ` : ""}
            {result.source === "timetable" ? "No location fix — estimated from timetable + last known delay · " : ""}
            Route saved {result.cacheAgeMinutes} min ago
          </Text>
        </>
      ) : (
        <Text style={styles.muted}>Getting your position…</Text>
      )}

      {locError ? <Text style={styles.muted}>{locError}</Text> : null}
      {!isCellTowerAvailable() ? <Text style={styles.footnote}>{cellTowerUnavailableReason()}</Text> : null}

      <View style={styles.btnRow}>
        {active ? (
          <TouchableOpacity onPress={stopLocation} style={styles.linkBtn}><Text style={styles.linkBtnText}>Stop GPS</Text></TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={() => { startLocation(); recompute(); }} style={styles.linkBtn}><Text style={styles.linkBtnText}>Use GPS</Text></TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  readyRow: {
    flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    backgroundColor: colors.chip, borderRadius: radius.md, marginBottom: spacing.md,
  },
  readyText: { flex: 1, fontSize: 12, color: colors.textMuted },
  card: {
    backgroundColor: "#FFF8EE", borderColor: colors.accent, borderWidth: 1, borderRadius: radius.lg,
    padding: spacing.lg, marginBottom: spacing.md,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: spacing.sm, flexWrap: "wrap" },
  title: { fontSize: 15, fontWeight: "700", color: colors.text },
  badge: { backgroundColor: colors.card, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderColor: colors.border },
  badgeText: { fontSize: 11, color: colors.primary, fontWeight: "600" },
  headline: { fontSize: 16, fontWeight: "700", color: colors.primary, marginBottom: 4 },
  detail: { fontSize: 13, color: colors.text, marginBottom: 4 },
  muted: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  warn: { fontSize: 13, color: colors.danger },
  footnote: { fontSize: 11, color: colors.textMuted, marginTop: 6, fontStyle: "italic" },
  btnRow: { flexDirection: "row", marginTop: spacing.sm },
  linkBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.primary },
  linkBtnText: { fontSize: 12, color: colors.primary, fontWeight: "600" },
});
