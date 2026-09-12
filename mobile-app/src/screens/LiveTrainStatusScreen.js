import React, { useState } from "react";
import { View, Text, FlatList, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { getTrainLiveStatus } from "../api/railwayApi";
import { describeApiError } from "../api/client";

/**
 * RailYatri-style plain running-status list (station, sch/exp/act,
 * delay) — the NTES-style enquiry, not the full GPS map/prediction
 * experience the "Track" tab (LiveTrackingScreen) already covers. Calls
 * the new GET /api/train/live-status/{train_number} endpoint, which is a
 * thin wrapper around the exact same gps_tracking.get_full_timeline /
 * timeline_to_json parse the Track tab's WebSocket uses to seed ITS
 * timeline — so the numbers here always agree with Track, just without
 * the map or the ML delay prediction layered on top.
 */
export default function LiveTrainStatusScreen() {
  const { apiBaseUrl } = useSettings();
  const [trainNumber, setTrainNumber] = useState("");
  const [date, setDate] = useState("");
  const [header, setHeader] = useState(null);
  const [stations, setStations] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function lookup() {
    const tn = trainNumber.trim();
    if (!/^\d{5}$/.test(tn)) {
      setError("Enter a valid 5-digit train number.");
      setStations(null);
      return;
    }
    setLoading(true);
    setError(null);
    setStations(null);
    try {
      const data = await getTrainLiveStatus(apiBaseUrl, tn, date.trim() || undefined);
      if (data.error) {
        setError(data.error);
        return;
      }
      setHeader({ trainNumber: data.train_number, trainName: data.train_name, date: data.date });
      // Reporting halts only for this list (kind !== "intermediate") — the
      // small passing/signalling points are real data too, but a plain
      // enquiry list is meant to read like IRCTC's own running-status
      // page, which only shows scheduled halts.
      setStations((data.stations || []).filter((s) => s.kind !== "intermediate"));
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <FlatList
      style={styles.flex}
      contentContainerStyle={styles.listContent}
      data={stations || []}
      keyExtractor={(item, idx) => `${item.code}_${idx}`}
      ListHeaderComponent={
        <View style={styles.content}>
          <SectionCard title="Live Train Status" subtitle="Real-time station-by-station running status (RailKit).">
            <LabeledInput label="Train Number" placeholder="e.g. 12841" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
            <LabeledInput label="Date (dd-mm-yyyy, optional — defaults to today)" placeholder="12-09-2026" value={date} onChangeText={setDate} autoCapitalize="none" />
            <PrimaryButton title="Check Status" onPress={lookup} loading={loading} />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {header ? (
              <Text style={styles.note}>{header.trainNumber} {header.trainName ? `— ${header.trainName}` : ""} · {header.date || "today"}</Text>
            ) : null}
          </SectionCard>
        </View>
      }
      renderItem={({ item, index }) => (
        <View style={[styles.stationRow, item.status === "current" && styles.stationRowCurrent]}>
          <View style={styles.stationLeft}>
            <View style={[styles.dot, item.status === "passed" && styles.dotPassed, item.status === "current" && styles.dotCurrent]} />
            {index < (stations?.length || 0) - 1 ? <View style={styles.line} /> : null}
          </View>
          <View style={styles.stationInfo}>
            <Text style={styles.stationName}>{item.name} <Text style={styles.stationCode}>({item.code})</Text></Text>
            <Text style={styles.stationMeta}>
              {item.distance_km != null ? `${item.distance_km} km` : "distance n/a"}
              {item.halt_minutes ? ` · Halt ${item.halt_minutes}m` : ""}
              {" · "}{item.status === "passed" ? "Departed" : item.status === "current" ? "Currently here" : "Upcoming"}
            </Text>
            <TimingRow label="Arr" timing={item.arrival} />
            <TimingRow label="Dep" timing={item.departure} />
          </View>
        </View>
      )}
      ListEmptyComponent={stations ? <Text style={styles.emptyText}>No station data to show.</Text> : null}
    />
  );
}

function TimingRow({ label, timing }) {
  if (!timing || (!timing.scheduled && !timing.actual)) return null;
  const delay = timing.delay_minutes;
  return (
    <View style={styles.timingRow}>
      <Text style={styles.timingLabel}>{label}</Text>
      <Text style={styles.timingText}>
        Sch {timing.scheduled || "—"}{timing.actual ? ` · Act ${timing.actual}` : ""}
      </Text>
      {delay != null ? (
        <Text style={[styles.delayBadge, delay > 10 ? styles.delayBad : delay > 0 ? styles.delayMinor : styles.delayGood]}>
          {delay > 0 ? `+${delay}m` : "On time"}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 0 },
  listContent: { paddingBottom: spacing.lg },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  note: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },
  stationRow: { flexDirection: "row", paddingHorizontal: spacing.lg },
  stationRowCurrent: { backgroundColor: colors.chip },
  stationLeft: { width: 20, alignItems: "center" },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.border, marginTop: 6 },
  dotPassed: { backgroundColor: colors.success },
  dotCurrent: { backgroundColor: colors.accent, width: 12, height: 12, borderRadius: 6 },
  line: { flex: 1, width: 2, backgroundColor: colors.border, marginVertical: 2 },
  stationInfo: { flex: 1, paddingBottom: spacing.md },
  stationName: { fontSize: 14, fontWeight: "700", color: colors.text },
  stationCode: { fontWeight: "400", color: colors.textMuted },
  stationMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2, marginBottom: 4 },
  timingRow: { flexDirection: "row", alignItems: "center", marginTop: 2, gap: 6 },
  timingLabel: { fontSize: 11, fontWeight: "700", color: colors.textMuted, width: 28 },
  timingText: { fontSize: 12, color: colors.text, flex: 1 },
  delayBadge: { fontSize: 11, fontWeight: "700", paddingHorizontal: 6, borderRadius: radius.sm },
  delayGood: { color: colors.success },
  delayMinor: { color: colors.warning },
  delayBad: { color: colors.danger },
  emptyText: { textAlign: "center", color: colors.textMuted, marginTop: spacing.lg },
});
