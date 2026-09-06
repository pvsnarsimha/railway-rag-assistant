import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { colors, spacing } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import FeatureImportanceBars from "../components/FeatureImportanceBars";
import { useSettings } from "../context/SettingsContext";
import { explainDelay } from "../api/railwayApi";
import { describeApiError } from "../api/client";
import { formatDelayDuration } from "../utils/formatDelay";

export default function DelayPredictScreen() {
  const { apiBaseUrl } = useSettings();
  const [trainNumber, setTrainNumber] = useState("");
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [date, setDate] = useState("");
  const [travelClass, setTravelClass] = useState("SL");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function runPredict() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      // FEATURE: Train Delay Prediction with Explainable AI — one call now
      // gets both the headline ML estimate AND a real SHAP per-factor
      // breakdown + historical weekday comparison (see
      // backend/delay_explainability.py). Falls back gracefully in the UI
      // below if `attributions` comes back empty (SHAP itself failed) —
      // the headline prediction is still always returned.
      const data = await explainDelay(apiBaseUrl, {
        train_number: trainNumber.trim() || null,
        source: source.trim() || null,
        dest: dest.trim() || null,
        date: date.trim() || null,
        travel_class: travelClass.trim() || null,
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
      <SectionCard
        title="Delay prediction (ML)"
        subtitle="Forward-looking estimate with an explainable, factor-by-factor breakdown of why."
      >
        <LabeledInput label="Train number (optional)" placeholder="e.g. 12709" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" />
        <View style={styles.row}>
          <LabeledInput label="Source" placeholder="e.g. SC" value={source} onChangeText={setSource} style={styles.half} />
          <LabeledInput label="Dest" placeholder="e.g. BZA" value={dest} onChangeText={setDest} style={styles.half} />
        </View>
        <View style={styles.row}>
          <LabeledInput label="Date (dd-mm-yyyy)" placeholder="02-08-2026" value={date} onChangeText={setDate} style={styles.half} autoCapitalize="none" />
          <LabeledInput label="Class" placeholder="SL / 3A / 2A…" value={travelClass} onChangeText={setTravelClass} style={styles.half} />
        </View>
        <PrimaryButton title="Predict delay" onPress={runPredict} loading={loading} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </SectionCard>

      {result && (
        <SectionCard title="Result">
          <Text style={styles.bigNumber}>
            {result.predicted_delay_minutes != null ? formatDelayDuration(result.predicted_delay_minutes) : "No estimate"}
          </Text>
          {result.predicted_delay_low_minutes != null && result.predicted_delay_high_minutes != null && (
            <InfoLine
              label="Range"
              value={`${formatDelayDuration(result.predicted_delay_low_minutes)}–${formatDelayDuration(result.predicted_delay_high_minutes)}`}
            />
          )}
          <InfoLine label="Confidence" value={result.confidence} />
          <InfoLine label="Model" value={result.model_name} />
          <InfoLine label="Current station" value={result.current_station} />
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

      {result?.historical_headline && (
        <SectionCard title="📅 Historical comparison" subtitle="From this train's own real completed-journey history.">
          <Text style={styles.historical}>{result.historical_headline}</Text>
        </SectionCard>
      )}

      {result && (
        <SectionCard
          title="⚖️ Why this prediction — Explainable AI"
          subtitle={result.explainer_method || "SHAP attribution over the blended ensemble"}
        >
          {result.narrative?.length ? (
            <View style={styles.narrativeWrap}>
              {result.narrative.map((line, i) => (
                <Text key={i} style={styles.narrativeItem}>
                  • {line}
                </Text>
              ))}
            </View>
          ) : null}
          <FeatureImportanceBars attributions={result.attributions} />
          {result.shap_error ? (
            <Text style={styles.error}>Per-factor breakdown unavailable this time ({result.shap_error}) — the headline estimate above is still real.</Text>
          ) : null}
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
  bigNumber: { fontSize: 32, fontWeight: "800", color: colors.primary, marginBottom: spacing.sm },
  infoLine: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  infoLabel: { fontSize: 13, color: colors.textMuted },
  infoValue: { fontSize: 13, color: colors.text, fontWeight: "600" },
  basisWrap: { marginTop: spacing.sm },
  basisTitle: { fontSize: 12, fontWeight: "700", color: colors.text, marginBottom: 4 },
  basisItem: { fontSize: 12, color: colors.textMuted, marginBottom: 2 },
  disclaimer: { fontSize: 11, color: colors.textMuted, fontStyle: "italic", marginTop: spacing.sm },
  historical: { fontSize: 13, color: colors.text, lineHeight: 19 },
  narrativeWrap: { marginBottom: spacing.md },
  narrativeItem: { fontSize: 13, color: colors.text, fontWeight: "600", marginBottom: 3 },
});