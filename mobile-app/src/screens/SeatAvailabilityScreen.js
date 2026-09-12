import React, { useState } from "react";
import { ScrollView, View, Text, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import ChipRow from "../components/ChipRow";
import { useSettings } from "../context/SettingsContext";
import { checkSeatAvailability } from "../api/railwayApi";
import { describeApiError } from "../api/client";

// Same option sets as TrainSearchScreen — kept in sync intentionally so a
// class/quota code means the same thing everywhere in this app. "Any" is
// dropped here since a real availability check needs one specific class.
const CLASS_OPTIONS = ["1A", "2A", "3A", "3E", "CC", "EC", "SL", "2S"];
const QUOTA_OPTIONS = [
  { code: "GN", label: "General" }, { code: "PQ", label: "Pooled" },
  { code: "RL", label: "Remote Loc." }, { code: "RS", label: "Road Side" },
  { code: "TQ", label: "Tatkal" }, { code: "PT", label: "Premium Tatkal" },
  { code: "LD", label: "Ladies" }, { code: "SS", label: "Senior Citizen" },
  { code: "HP", label: "Handicapped" }, { code: "LB", label: "Lower Berth" },
  { code: "DF", label: "Defence" }, { code: "HO", label: "HQ" },
  { code: "PH", label: "Parliament" }, { code: "FT", label: "Foreign Tourist" },
];

/**
 * RailYatri-style Seat Availability tile — real-time berth/seat
 * availability for one train/route/date/class/quota. Calls the new POST
 * /api/train/seat-availability endpoint, a thin wrapper around the same
 * railway_api.get_seat_availability + advanced_features status/prediction
 * extraction /api/trains/search already uses inline per result row — this
 * is just a dedicated single-check form for it.
 */
export default function SeatAvailabilityScreen() {
  const { apiBaseUrl } = useSettings();
  const [trainNumber, setTrainNumber] = useState("");
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [date, setDate] = useState("");
  const [travelClass, setTravelClass] = useState("3A");
  const [quota, setQuota] = useState("GN");

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function check() {
    const tn = trainNumber.trim();
    if (!/^\d{5}$/.test(tn)) {
      setError("Enter a valid 5-digit train number.");
      return;
    }
    if (!source.trim() || !dest.trim() || !date.trim()) {
      setError("Enter source, destination and date.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await checkSeatAvailability(apiBaseUrl, {
        trainNumber: tn, source: source.trim(), dest: dest.trim(),
        date: date.trim(), travelClass, quota,
      });
      if (data.error) {
        setError(data.error);
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <SectionCard title="Seat Availability" subtitle="Real-time berth availability for a specific train, route, date and class.">
        <LabeledInput label="Train Number" placeholder="e.g. 12201" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
        <View style={styles.row}>
          <LabeledInput label="From" placeholder="e.g. LTT or Mumbai" value={source} onChangeText={setSource} style={styles.half} />
          <LabeledInput label="To" placeholder="e.g. KCVL or Kochuveli" value={dest} onChangeText={setDest} style={styles.half} />
        </View>
        <LabeledInput label="Date (dd-mm-yyyy)" placeholder="15-09-2026" value={date} onChangeText={setDate} autoCapitalize="none" />
        <Text style={styles.chipLabel}>Class</Text>
        <ChipRow options={CLASS_OPTIONS} value={travelClass} onSelect={setTravelClass} getKey={(c) => c} getLabel={(c) => c} />
        <Text style={styles.chipLabel}>Quota</Text>
        <ChipRow options={QUOTA_OPTIONS} value={quota} onSelect={setQuota} getKey={(q) => q.code} getLabel={(q) => q.code} />
        <PrimaryButton title="Check Availability" onPress={check} loading={loading} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </SectionCard>

      {result ? (
        <SectionCard title={`${result.train_number} — ${source.trim()} → ${dest.trim()}`} subtitle={`${result.travel_class} · ${result.quota} · ${result.date}`}>
          {result.status_text ? (
            <View style={styles.statusBox}>
              <Text style={styles.statusText}>{result.status_text}</Text>
            </View>
          ) : (
            <Text style={styles.note}>No availability status returned for this combination — the class/quota may not run on this train, or the booking window (ARP) may not be open yet.</Text>
          )}
          {result.prediction ? (
            <View style={styles.predictionBox}>
              <Text style={styles.predictionTitle}>Prediction</Text>
              {result.prediction.prediction ? <Text style={styles.predictionText}>{result.prediction.prediction}</Text> : null}
              {result.prediction.prediction_percentage != null ? (
                <Text style={styles.predictionText}>Confirmation chance: {result.prediction.prediction_percentage}%</Text>
              ) : null}
              {result.prediction.can_book != null ? (
                <Text style={styles.predictionText}>Bookable now: {result.prediction.can_book ? "Yes" : "No"}</Text>
              ) : null}
            </View>
          ) : null}
        </SectionCard>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  row: { flexDirection: "row", gap: spacing.md },
  half: { flex: 1 },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  note: { color: colors.textMuted, fontSize: 12 },
  chipLabel: { fontSize: 11, fontWeight: "700", color: colors.textMuted, marginTop: spacing.sm, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 },
  statusBox: {
    backgroundColor: colors.chip, borderRadius: radius.md, padding: spacing.md, alignItems: "center",
  },
  statusText: { fontSize: 18, fontWeight: "700", color: colors.primary },
  predictionBox: { marginTop: spacing.md },
  predictionTitle: { fontSize: 11, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", marginBottom: 4 },
  predictionText: { fontSize: 13, color: colors.text, marginTop: 2 },
});
