import React, { useState } from "react";
import { ScrollView, View, Text, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { getPnrStatus } from "../api/railwayApi";
import { describeApiError } from "../api/client";

/**
 * RailYatri-style PNR Status tile. Reuses the EXISTING GET
 * /api/pnr/status/{pnr} endpoint and pnr_tracking.py summary shape
 * (already built for the PNR Auto-Tracking watchlist feature) — this
 * screen is a new, dedicated single-lookup UI for it, no backend change.
 */
export default function PnrStatusScreen() {
  const { apiBaseUrl } = useSettings();
  const [pnr, setPnr] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function lookup() {
    const trimmed = pnr.trim();
    if (!/^\d{10}$/.test(trimmed)) {
      setError("Enter a valid 10-digit PNR number.");
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await getPnrStatus(apiBaseUrl, trimmed);
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
      <SectionCard title="PNR Status" subtitle="Real-time booking status for a 10-digit PNR number.">
        <LabeledInput
          label="PNR Number"
          placeholder="e.g. 2451234567"
          value={pnr}
          onChangeText={setPnr}
          keyboardType="number-pad"
          maxLength={10}
        />
        <PrimaryButton title="Check Status" onPress={lookup} loading={loading} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </SectionCard>

      {result ? (
        <SectionCard title={`Train ${result.train_number || "?"} — ${result.train_name || "Unknown"}`}>
          <Row label="From → To" value={result.from_station && result.to_station ? `${result.from_station} → ${result.to_station}` : "Not available"} />
          <Row label="Date of Journey" value={result.date_of_journey || "Not available"} />
          <Row label="Class" value={result.class || "Not available"} />
          <Row label="Chart Prepared" value={result.chart_prepared === null || result.chart_prepared === undefined ? "Not available" : result.chart_prepared ? "Yes" : "No"} />

          {result.overall_status_text ? (
            <View style={[styles.statusPill, statusPillStyle(result.overall_status_text)]}>
              <Text style={[styles.statusPillText, statusPillTextStyle(result.overall_status_text)]}>{result.overall_status_text}</Text>
            </View>
          ) : (
            <Row label="Overall Status" value="Not available" />
          )}

          {result.passengers?.length ? (
            <View style={styles.passengerBlock}>
              <Text style={styles.passengerHeading}>Passengers</Text>
              {result.passengers.map((p, idx) => (
                <View key={idx} style={styles.passengerRow}>
                  <Text style={styles.passengerNum}>#{p.number ?? idx + 1}</Text>
                  <View style={styles.passengerInfo}>
                    <Text style={styles.passengerStatus}>{p.current_status || p.booking_status || "Status not available"}</Text>
                    {(p.coach || p.berth) ? (
                      <Text style={styles.passengerMeta}>{[p.coach && `Coach ${p.coach}`, p.berth && `Berth ${p.berth}`].filter(Boolean).join(" · ")}</Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <Text style={styles.note}>No individual passenger breakdown available for this PNR.</Text>
          )}
        </SectionCard>
      ) : null}
    </ScrollView>
  );
}

function Row({ label, value, highlight }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, highlight && styles.rowValueHighlight]}>{value}</Text>
    </View>
  );
}

// REDESIGN NOTE: the overall PNR status now reads as a colored pill (green
// confirmed / amber RAC / red waitlisted-or-cancelled) instead of plain
// text, matching how every real IRCTC-adjacent app surfaces this — the
// single most important field on the whole screen deserves to be scannable
// at a glance, not just another row in a list.
function statusPillStyle(text) {
  const t = String(text).toUpperCase();
  if (t.includes("CNF") || t.includes("CONFIRM")) return { backgroundColor: "#E8F8F0" };
  if (t.includes("RAC")) return { backgroundColor: "#FFF6E5" };
  if (t.includes("WL") || t.includes("CAN")) return { backgroundColor: "#FDECEC" };
  return { backgroundColor: colors.chip };
}
function statusPillTextStyle(text) {
  const t = String(text).toUpperCase();
  if (t.includes("CNF") || t.includes("CONFIRM")) return { color: colors.success };
  if (t.includes("RAC")) return { color: colors.warning };
  if (t.includes("WL") || t.includes("CAN")) return { color: colors.danger };
  return { color: colors.primary };
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  note: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },
  row: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  rowLabel: { fontSize: 12, color: colors.textMuted, fontWeight: "600" },
  rowValue: { fontSize: 13, color: colors.text, fontWeight: "600", flexShrink: 1, textAlign: "right" },
  rowValueHighlight: { color: colors.primary },
  statusPill: { borderRadius: radius.md, paddingVertical: spacing.md, alignItems: "center", marginTop: spacing.sm },
  statusPillText: { fontSize: 16, fontWeight: "700" },
  passengerBlock: { marginTop: spacing.md },
  passengerHeading: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: spacing.sm },
  passengerRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.chip, borderRadius: radius.md,
    padding: spacing.sm, marginBottom: spacing.xs,
  },
  passengerNum: { fontWeight: "700", color: colors.primary, marginRight: spacing.sm, fontSize: 12 },
  passengerInfo: { flex: 1 },
  passengerStatus: { fontSize: 13, fontWeight: "600", color: colors.text },
  passengerMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
});
