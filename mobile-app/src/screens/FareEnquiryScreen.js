import React, { useState } from "react";
import { ScrollView, View, Text, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import ChipRow from "../components/ChipRow";
import { useSettings } from "../context/SettingsContext";
import { getTrainFare } from "../api/railwayApi";
import { describeApiError } from "../api/client";

const CLASS_OPTIONS = ["1A", "2A", "3A", "3E", "CC", "EC", "SL", "2S"];
const QUOTA_OPTIONS = [
  { code: "GN", label: "General" }, { code: "TQ", label: "Tatkal" },
  { code: "PT", label: "Premium Tatkal" }, { code: "LD", label: "Ladies" },
  { code: "SS", label: "Senior Citizen" },
];

/**
 * RailYatri-style Fare Calculator tile — full fare lookup for one
 * train/route/date/class/quota. Calls the new POST /api/train/fare
 * endpoint, a thin wrapper around railway_api.get_fare +
 * advanced_features.extract_fare_amount, the same real fare source
 * already used inline by /api/trains/search's per-row fare badge.
 */
export default function FareEnquiryScreen() {
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

  async function calculate() {
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
      const data = await getTrainFare(apiBaseUrl, {
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
      <SectionCard title="Fare Calculator" subtitle="Real fare breakdown for a journey — not an estimate.">
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
        <PrimaryButton title="Get Fare" onPress={calculate} loading={loading} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </SectionCard>

      {result ? (
        <SectionCard title={`${result.train_number} — ${source.trim()} → ${dest.trim()}`} subtitle={`${result.travel_class} · ${result.quota} · ${result.date}`}>
          {result.fare != null ? (
            <View style={styles.fareBox}>
              <Text style={styles.fareAmount}>₹{result.fare}</Text>
              <Text style={styles.fareNote}>Total fare, {result.travel_class} class, {result.quota} quota</Text>
            </View>
          ) : (
            <Text style={styles.note}>No fare figure returned for this combination — the class/quota may not run on this train.</Text>
          )}
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
  fareBox: { backgroundColor: colors.chip, borderRadius: radius.md, padding: spacing.lg, alignItems: "center" },
  fareAmount: { fontSize: 28, fontWeight: "700", color: colors.primary },
  fareNote: { fontSize: 12, color: colors.textMuted, marginTop: 4 },
});
