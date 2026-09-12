import React, { useState } from "react";
import { ScrollView, View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import ChipRow from "../components/ChipRow";
import { useSettings } from "../context/SettingsContext";
import { checkSeatAvailability } from "../api/railwayApi";
import { describeApiError } from "../api/client";

const CLASS_OPTIONS = ["1A", "2A", "3A", "3E", "CC", "EC", "SL", "2S"];

// REDESIGN NOTE: trimmed from the original 14-quota list down to the ones
// an ordinary passenger can actually select and would recognize — General,
// the two Tatkal tiers, Ladies, Senior Citizen, Pooled (common on many
// routes), and Handicapped/accessibility (kept deliberately, unlike the
// other niche codes, since cutting it would remove a real accessibility
// option). Dropped: Remote Location, Road Side, Defence, HQ, Parliament,
// Foreign Tourist — these are real RailKit quota codes, but they're
// allocation-only categories a passenger can't actually pick when checking
// availability through any consumer channel (railway staff/administrative
// allotments), so surfacing all 14 up front was clutter, not honesty — the
// data these codes would return isn't something a passenger acts on anyway.
const QUOTA_OPTIONS = [
  { code: "GN", label: "General" }, { code: "TQ", label: "Tatkal" },
  { code: "PT", label: "Premium Tatkal" }, { code: "LD", label: "Ladies" },
  { code: "SS", label: "Senior Citizen" }, { code: "PQ", label: "Pooled" },
  { code: "HP", label: "Handicapped" },
];

/**
 * RailYatri-style Seat Availability tile — real-time berth/seat
 * availability for one train/route/date/class/quota. Calls the
 * POST /api/train/seat-availability endpoint, a thin wrapper around the
 * same railway_api.get_seat_availability + advanced_features status/
 * prediction extraction /api/trains/search already uses inline per result
 * row — this is just a dedicated single-check form for it.
 *
 * REDESIGN NOTE: result card restyled to read like a real booking-adjacent
 * app's availability row (colored status chip, route summary bar, refresh
 * action) instead of a plain form-result block — same real data as before,
 * just presented the way a passenger actually scans this kind of screen.
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
  const [checkedAt, setCheckedAt] = useState(null);
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
        setCheckedAt(new Date());
      }
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  const statusIsPositive = result?.status_text && /AVBL|AVAILABLE|RAC/i.test(result.status_text);
  const statusIsWaitlist = result?.status_text && /WL|WAITLIST/i.test(result.status_text);

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
        <ChipRow options={QUOTA_OPTIONS} value={quota} onSelect={setQuota} getKey={(q) => q.code} getLabel={(q) => q.label} />
        <PrimaryButton title="Check Availability" onPress={check} loading={loading} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </SectionCard>

      {result ? (
        <View style={styles.resultCard}>
          <View style={styles.resultHeaderRow}>
            <View>
              <Text style={styles.resultTrain}>{result.train_number}</Text>
              <Text style={styles.resultRoute}>{source.trim()} <Ionicons name="arrow-forward" size={11} /> {dest.trim()} · {result.date}</Text>
            </View>
            <TouchableOpacity onPress={check} style={styles.refreshBtn} activeOpacity={0.7}>
              <Ionicons name="refresh" size={16} color={colors.primary} />
            </TouchableOpacity>
          </View>
          <View style={styles.resultTagsRow}>
            <View style={styles.tag}><Text style={styles.tagText}>{result.travel_class}</Text></View>
            <View style={styles.tag}><Text style={styles.tagText}>{QUOTA_OPTIONS.find((q) => q.code === result.quota)?.label || result.quota}</Text></View>
          </View>

          {result.status_text ? (
            <View style={[
              styles.statusBox,
              statusIsPositive && styles.statusBoxGood,
              statusIsWaitlist && styles.statusBoxWarn,
            ]}>
              <Text style={[
                styles.statusText,
                statusIsPositive && styles.statusTextGood,
                statusIsWaitlist && styles.statusTextWarn,
              ]}>{result.status_text}</Text>
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

          {checkedAt ? (
            <Text style={styles.freshness}>Checked at {checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
          ) : null}
        </View>
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
  resultCard: {
    backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg,
    borderWidth: 1, borderColor: colors.border,
    shadowColor: "#0B3D91", shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  resultHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  resultTrain: { fontSize: 16, fontWeight: "700", color: colors.text },
  resultRoute: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  refreshBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.chip, alignItems: "center", justifyContent: "center" },
  resultTagsRow: { flexDirection: "row", gap: 6, marginTop: spacing.sm, marginBottom: spacing.sm },
  tag: { backgroundColor: colors.chip, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { fontSize: 11, fontWeight: "700", color: colors.primary },
  statusBox: {
    backgroundColor: colors.chip, borderRadius: radius.md, padding: spacing.md, alignItems: "center",
  },
  statusBoxGood: { backgroundColor: "#E8F8F0" },
  statusBoxWarn: { backgroundColor: "#FFF6E5" },
  statusText: { fontSize: 18, fontWeight: "700", color: colors.primary },
  statusTextGood: { color: colors.success },
  statusTextWarn: { color: colors.warning },
  predictionBox: { marginTop: spacing.md },
  predictionTitle: { fontSize: 11, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", marginBottom: 4 },
  predictionText: { fontSize: 13, color: colors.text, marginTop: 2 },
  freshness: { fontSize: 10, color: colors.textMuted, textAlign: "right", marginTop: spacing.sm },
});
