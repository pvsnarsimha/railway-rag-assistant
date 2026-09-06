import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { predictCrowd } from "../api/railwayApi";
import { describeApiError } from "../api/client";

const LEVEL_COLOR = {
  Low: colors.success,
  Moderate: colors.warning,
  High: colors.danger,
};

export default function CrowdPredictScreen() {
  const { apiBaseUrl } = useSettings();
  const [trainNumber, setTrainNumber] = useState("");
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [date, setDate] = useState("");
  const [travelClass, setTravelClass] = useState("SL");
  const [quota, setQuota] = useState("GN");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function runPredict() {
    if (!trainNumber.trim() || !source.trim() || !dest.trim() || !date.trim()) {
      setError("Train number, source, dest, and date are required.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await predictCrowd(apiBaseUrl, {
        train_number: trainNumber.trim(),
        source: source.trim().toUpperCase(),
        dest: dest.trim().toUpperCase(),
        date: date.trim(),
        travel_class: travelClass.trim() || "SL",
        quota: quota.trim() || "GN",
      });
      setResult(data);
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <SectionCard title="Crowd / capacity prediction" subtitle="Pulls real seat availability from RailKit when possible.">
        <LabeledInput label="Train number" placeholder="e.g. 12709" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" />
        <View style={styles.row}>
          <LabeledInput label="Source" placeholder="SC" value={source} onChangeText={setSource} style={styles.half} />
          <LabeledInput label="Dest" placeholder="BZA" value={dest} onChangeText={setDest} style={styles.half} />
        </View>
        <View style={styles.row}>
          <LabeledInput label="Date (dd-mm-yyyy)" placeholder="02-08-2026" value={date} onChangeText={setDate} style={styles.half} autoCapitalize="none" />
          <LabeledInput label="Class" placeholder="SL" value={travelClass} onChangeText={setTravelClass} style={styles.half} />
        </View>
        <LabeledInput label="Quota" placeholder="GN / TQ / LD…" value={quota} onChangeText={setQuota} />
        <PrimaryButton title="Predict crowd" onPress={runPredict} loading={loading} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </SectionCard>

      {result && (
        <SectionCard title="Result">
          <View style={[styles.levelPill, { backgroundColor: (LEVEL_COLOR[result.level] || colors.primary) + "22" }]}>
            <Text style={[styles.levelText, { color: LEVEL_COLOR[result.level] || colors.primary }]}>
              {result.level || "Unknown"}
            </Text>
          </View>
          <InfoLine label="Score" value={result.score} />
          {result.seat_data_error ? (
            <Text style={styles.warn}>Seat data unavailable: {result.seat_data_error}</Text>
          ) : null}
          {!!result.basis?.length && (
            <View style={styles.basisWrap}>
              <Text style={styles.basisTitle}>Basis</Text>
              {result.basis.map((b, i) => (
                <Text key={i} style={styles.basisItem}>
                  • {b}
                </Text>
              ))}
            </View>
          )}
          {result.disclaimer ? <Text style={styles.disclaimer}>{result.disclaimer}</Text> : null}
        </SectionCard>
      )}
    </ScrollView>
  );
}

function InfoLine({ label, value }) {
  if (value == null) return null;
  return (
    <View style={styles.infoLine}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{String(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  row: { flexDirection: "row", gap: spacing.md },
  half: { flex: 1 },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  warn: { color: colors.warning, fontSize: 12, marginTop: spacing.xs },
  levelPill: {
    alignSelf: "flex-start",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    marginBottom: spacing.sm,
  },
  levelText: { fontWeight: "800", fontSize: 16 },
  infoLine: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  infoLabel: { fontSize: 13, color: colors.textMuted },
  infoValue: { fontSize: 13, color: colors.text, fontWeight: "600" },
  basisWrap: { marginTop: spacing.sm },
  basisTitle: { fontSize: 12, fontWeight: "700", color: colors.text, marginBottom: 4 },
  basisItem: { fontSize: 12, color: colors.textMuted, marginBottom: 2 },
  disclaimer: { fontSize: 11, color: colors.textMuted, fontStyle: "italic", marginTop: spacing.sm },
});
