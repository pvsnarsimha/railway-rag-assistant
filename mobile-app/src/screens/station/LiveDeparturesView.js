import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator, Linking, AppState } from "react-native";
import { Text } from "../../i18n/Localized";
import { getLiveBoard } from "../../api/railwayApi";
import { describeApiError } from "../../api/client";
import { useTrip, ToolHeader, TripForm } from "./stationShared";

const REFRESH_MS = 30 * 1000;
const HOURS = [2, 4, 8];

const dk = {
  bg: "#050B18",
  panel: "#0B1428",
  head: "#101B33",
  row: "#0B1428",
  rowMine: "#1C2230",
  line: "#18233D",
  text: "#F1F5F9",
  sub: "#A5B1C8",
  muted: "#7D8AA5",
  yellow: "#FBBF24",
  green: "#34D399",
  orange: "#FB923C",
  red: "#F87171",
  chip: "#131F38",
};

function mapsSearch(query) {
  const q = encodeURIComponent(query);
  Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {});
}

/**
 * Live Departures — the station's running board (RailKit live-at-station,
 * RapidAPI as fallback), dark like a real platform display. Refreshes
 * every 30 s while open; pausing when the app is in the background.
 */
export default function LiveDeparturesView({ apiBaseUrl, onBack, onOpenTrain }) {
  const [trip, setTrip] = useTrip();
  const [station, setStation] = useState(trip.station || null);
  const [mode, setMode] = useState("departures");
  const [hours, setHours] = useState(2);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const reqId = useRef(0);

  useEffect(() => { if (!station && trip.station) setStation(trip.station); }, [trip.station]); // eslint-disable-line

  const load = useCallback(async ({ quiet } = {}) => {
    if (!station) return;
    const my = ++reqId.current;
    quiet ? setRefreshing(true) : setLoading(true);
    try {
      const res = await getLiveBoard(apiBaseUrl, station, { mode, hours });
      if (my !== reqId.current) return;
      setData(res); setError(null);
    } catch (e) {
      if (my === reqId.current) setError(describeApiError(e));
    } finally {
      if (my === reqId.current) { setLoading(false); setRefreshing(false); }
    }
  }, [apiBaseUrl, station, mode, hours]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 30 s, only while the app is in the foreground.
  useEffect(() => {
    if (!station) return undefined;
    let id = setInterval(() => load({ quiet: true }), REFRESH_MS);
    const sub = AppState.addEventListener("change", (s) => {
      clearInterval(id);
      if (s === "active") { load({ quiet: true }); id = setInterval(() => load({ quiet: true }), REFRESH_MS); }
    });
    return () => { clearInterval(id); sub.remove(); };
  }, [station, load]);

  const title = mode === "arrivals" ? "Live Arrivals" : "Live Departures";
  const stationLabel = data?.station_name || trip.stationName || station;
  const subtitle = station ? `${stationLabel || ""} · ${station} · auto-refresh 30s` : "Your station's running board";
  const showForm = !station || editing;
  const trains = data?.trains || [];
  const amen = data?.amenities || {};

  const atStation = [
    { key: "waiting", icon: "🛋️", label: "Waiting hall", onPress: () => mapsSearch(`waiting room ${stationLabel} railway station`) },
    { key: "cloak", icon: "🧳", label: "Cloak room", onPress: () => mapsSearch(`cloak room ${stationLabel} railway station`) },
    { key: "taxi", icon: "🚕", label: "Taxi / Auto", onPress: () => mapsSearch(`taxi stand near ${stationLabel} railway station`) },
    { key: "parking", icon: "🅿️", label: "Parking", onPress: () => mapsSearch(`parking ${stationLabel} railway station`) },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: dk.bg }}>
      <ToolHeader
        dark title={title} subtitle={subtitle} onBack={onBack}
        right={station && !showForm ? (
          <TouchableOpacity onPress={() => setEditing(true)} style={styles.changeBtn}>
            <Text style={styles.changeText}>Station</Text>
          </TouchableOpacity>
        ) : null}
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load({ quiet: true })} tintColor={dk.yellow} />}
      >
        {showForm ? (
          <TripForm
            apiBaseUrl={apiBaseUrl} trip={trip} setTrip={setTrip}
            fields={["station"]} submitLabel="Show board"
            onSubmit={(p) => { setEditing(false); setData(null); setStation(p.station); }}
          />
        ) : null}

        {station ? (
          <>
            <View style={styles.tabs}>
              {[["departures", "Departures"], ["arrivals", "Arrivals"]].map(([k, label]) => (
                <TouchableOpacity key={k} onPress={() => setMode(k)} style={[styles.tab, mode === k && styles.tabOn]}>
                  <Text style={[styles.tabText, mode === k && styles.tabTextOn]}>{label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                onPress={() => setHours(HOURS[(HOURS.indexOf(hours) + 1) % HOURS.length])}
                style={styles.tab}
                accessibilityLabel="Change time window"
              >
                <Text style={styles.tabText}>Next {hours} hrs ▾</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.board}>
              <View style={styles.boardHead}>
                <Text style={[styles.th, { width: 64 }]}>TIME</Text>
                <Text style={[styles.th, { flex: 1 }]}>{mode === "arrivals" ? "TRAIN / FROM" : "TRAIN / TO"}</Text>
                <Text style={[styles.th, { width: 36, textAlign: "center" }]}>PF</Text>
                <Text style={[styles.th, { width: 84, textAlign: "right" }]}>STATUS</Text>
              </View>
              {loading && !data ? <ActivityIndicator color={dk.yellow} style={{ margin: 24 }} /> : null}
              {!loading && !trains.length ? (
                <Text style={styles.empty}>{error || data?.error || "No trains reported in this window."}</Text>
              ) : null}
              {trains.map((t, i) => {
                const mine = trip.trainNumber && t.train_number === trip.trainNumber;
                return (
                  <TouchableOpacity
                    key={`${t.train_number}-${i}`}
                    activeOpacity={0.7}
                    onPress={() => onOpenTrain && onOpenTrain(t)}
                    style={[styles.row, mine && styles.rowMine, i === trains.length - 1 && { borderBottomWidth: 0 }]}
                  >
                    <Text style={[styles.time, { width: 64 }]} noTranslate>{t.time || "—"}</Text>
                    <View style={{ flex: 1, paddingRight: 6 }}>
                      <Text style={[styles.num, mine && { color: dk.yellow }]} noTranslate>{t.train_number}</Text>
                      <Text numberOfLines={1} style={styles.dest}>
                        {(mode === "arrivals" ? t.source : t.destination) || t.train_name || ""}
                      </Text>
                    </View>
                    <Text style={[styles.pf, mine && { color: dk.yellow }]} noTranslate>{t.platform || "—"}</Text>
                    <StatusCell t={t} />
                  </TouchableOpacity>
                );
              })}
            </View>
            {error && trains.length ? <Text style={styles.staleNote}>Couldn't refresh: {error}</Text> : null}
            {data ? (
              <Text style={styles.staleNote}>
                Updated {data.updated_at} IST · source: {data.source === "rapidapi" ? "RapidAPI (IRCTC)" : data.source === "railkit" ? "RailKit" : "—"}
                {refreshing ? " · refreshing…" : ""}
              </Text>
            ) : null}

            <Text style={styles.section}>AT THIS STATION</Text>
            <View style={styles.tiles}>
              {atStation.map((a) => (
                <TouchableOpacity key={a.key} style={styles.tile} onPress={a.onPress}>
                  <Text style={{ fontSize: 22 }} noTranslate>{a.icon}</Text>
                  <Text style={styles.tileText}>{a.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function StatusCell({ t }) {
  let text = "—";
  let color = dk.muted;
  let strike = false;
  if (t.status === "cancelled") { text = "Cancelled"; color = dk.muted; strike = true; }
  else if (t.status === "delayed") { text = `+${t.delay_minutes} min`; color = t.delay_minutes >= 30 ? dk.red : dk.orange; }
  else if (t.status === "on_time") { text = "On time"; color = dk.green; }
  else if (t.status_text) { text = t.status_text; }
  return (
    <Text
      numberOfLines={2}
      style={[styles.status, { color }, strike && { textDecorationLine: "line-through" }]}
    >
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: 16, marginBottom: 14, flexWrap: "wrap" },
  tab: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999, backgroundColor: dk.chip },
  tabOn: { backgroundColor: dk.yellow },
  tabText: { color: dk.sub, fontWeight: "700", fontSize: 13.5 },
  tabTextOn: { color: "#1A1300" },
  board: { marginHorizontal: 16, borderRadius: 20, backgroundColor: dk.panel, overflow: "hidden" },
  boardHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, backgroundColor: dk.head },
  th: { color: dk.muted, fontSize: 11.5, fontWeight: "800", letterSpacing: 0.6 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: dk.line },
  rowMine: { backgroundColor: dk.rowMine },
  time: { color: dk.yellow, fontSize: 16, fontWeight: "800" },
  num: { color: dk.text, fontSize: 15, fontWeight: "800" },
  dest: { color: dk.sub, fontSize: 12.5, marginTop: 1 },
  pf: { width: 36, textAlign: "center", color: dk.text, fontSize: 16, fontWeight: "800" },
  status: { width: 84, textAlign: "right", fontSize: 12.5, fontWeight: "600" },
  empty: { color: dk.sub, padding: 20, textAlign: "center", fontSize: 13 },
  staleNote: { color: dk.muted, fontSize: 11, marginHorizontal: 18, marginTop: 8 },
  section: { color: dk.muted, fontSize: 12, fontWeight: "800", letterSpacing: 1.3, marginHorizontal: 16, marginTop: 22, marginBottom: 10 },
  tiles: { flexDirection: "row", gap: 8, paddingHorizontal: 16 },
  tile: { flex: 1, backgroundColor: dk.head, borderRadius: 16, paddingVertical: 12, alignItems: "center", gap: 4 },
  tileText: { color: dk.sub, fontSize: 11, fontWeight: "700", textAlign: "center" },
  changeBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: dk.chip },
  changeText: { color: dk.yellow, fontWeight: "700", fontSize: 13 },
});
