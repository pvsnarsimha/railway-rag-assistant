import React, { useEffect, useState } from "react";
import { View, FlatList, StyleSheet } from "react-native";
import { Text } from "../i18n/AutoText";
import { colors, spacing } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { getTrainSchedule } from "../api/railwayApi";
import { describeApiError } from "../api/client";

/**
 * RailYatri-style "Time Table" tile — the STATIC scheduled timetable
 * (day/distance/scheduled arrival & departure per station), not live
 * running status. Calls the new GET /api/train/schedule/{train_number}
 * endpoint, which parses the same RailKit getTrainInfo route list
 * gps_tracking.parse_route() already uses for the route map, just kept
 * as a plain list here (with halt/day fields the map parser drops).
 */
// BUGFIX: this screen used to always start blank, even when the user had
// already typed a train number on the Live Tracking screen and tapped its
// "Time Table" shortcut — forcing them to type the SAME train number again
// here. `route.params.trainNumber` (passed by LiveTrackingScreen.web.js's
// bottom bar — see its "Time Table" button) now pre-fills the field and
// auto-runs the real lookup on arrival, same as if the user had typed it
// and pressed the button themselves.
export default function TrainScheduleScreen({ route }) {
  const { apiBaseUrl } = useSettings();
  const prefillTrainNumber = route?.params?.trainNumber ? String(route.params.trainNumber).trim() : "";
  const [trainNumber, setTrainNumber] = useState(prefillTrainNumber);
  const [header, setHeader] = useState(null);
  const [stations, setStations] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function runLookup(tn) {
    if (!/^\d{5}$/.test(tn)) {
      setError("Enter a valid 5-digit train number.");
      setStations(null);
      return;
    }
    setLoading(true);
    setError(null);
    setStations(null);
    try {
      const data = await getTrainSchedule(apiBaseUrl, tn);
      if (data.error) {
        setError(data.error);
        return;
      }
      setHeader({ trainNumber: data.train_number, trainName: data.train_name });
      setStations(data.stations || []);
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  function lookup() {
    runLookup(trainNumber.trim());
  }

  // Auto-fetch once on arrival when a train number was handed in via
  // navigation params — intentionally NOT re-running if the user then
  // edits the field by hand (that still requires pressing the button,
  // same as always) or if they navigate here again with the SAME number
  // already prefilled (no [prefillTrainNumber] dependency loop).
  useEffect(() => {
    if (prefillTrainNumber && /^\d{5}$/.test(prefillTrainNumber)) {
      runLookup(prefillTrainNumber);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <FlatList
      style={styles.flex}
      contentContainerStyle={styles.listContent}
      data={stations || []}
      keyExtractor={(item, idx) => `${item.code}_${idx}`}
      ListHeaderComponent={
        <View style={styles.content}>
          <SectionCard title="Time Table" subtitle="Scheduled arrival, departure, halt and day for every station on the route.">
            <LabeledInput label="Train Number" placeholder="e.g. 12841" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
            <PrimaryButton title="Get Schedule" onPress={lookup} loading={loading} />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {header ? <Text style={styles.note}>{header.trainNumber} {header.trainName ? `— ${header.trainName}` : ""}</Text> : null}
          </SectionCard>
          {stations?.length ? (
            <View style={styles.headerRow}>
              <Text style={[styles.headerCell, styles.colStation]}>Station</Text>
              <Text style={[styles.headerCell, styles.colSmall]}>Day</Text>
              <Text style={[styles.headerCell, styles.colTime]}>Arr</Text>
              <Text style={[styles.headerCell, styles.colTime]}>Dep</Text>
              <Text style={[styles.headerCell, styles.colSmall]}>Dist</Text>
            </View>
          ) : null}
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.colStation}>
            <Text style={styles.stationName} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.stationCode}>{item.code}</Text>
          </View>
          <Text style={[styles.cell, styles.colSmall]}>{item.day != null ? item.day : "—"}</Text>
          <Text style={[styles.cell, styles.colTime]}>{item.scheduled_arrival || "—"}</Text>
          <Text style={[styles.cell, styles.colTime]}>{item.scheduled_departure || "—"}</Text>
          <Text style={[styles.cell, styles.colSmall]}>{item.distance_km != null ? `${item.distance_km}` : "—"}</Text>
        </View>
      )}
      ListEmptyComponent={stations ? <Text style={styles.emptyText}>No schedule data to show.</Text> : null}
    />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 0 },
  listContent: { paddingBottom: spacing.lg },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  note: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },
  headerRow: {
    flexDirection: "row", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border,
    marginBottom: 4,
  },
  headerCell: { fontSize: 10, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase" },
  row: {
    flexDirection: "row", alignItems: "center", paddingVertical: 8, paddingHorizontal: spacing.lg,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  colStation: { flex: 2.4 },
  colTime: { flex: 1, fontSize: 12 },
  colSmall: { flex: 0.6, fontSize: 12 },
  cell: { color: colors.text },
  stationName: { fontSize: 12, fontWeight: "600", color: colors.text },
  stationCode: { fontSize: 10, color: colors.textMuted },
  emptyText: { textAlign: "center", color: colors.textMuted, marginTop: spacing.lg },
});
