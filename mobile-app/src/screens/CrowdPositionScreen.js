import React, { useState, useEffect, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import FusedPositionMap from "../components/FusedPositionMap";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { reportPosition, getFusedPosition, getReporterStats, getPositionLeaderboard } from "../api/railwayApi";
import { describeApiError } from "../api/client";
import { getReporterId } from "../utils/reporterId";

// Color per fused position_source (see backend/crowd_position_tracking.py)
// — matches how trustworthy/confirmed the fix currently is, not a generic
// "importance" color.
const SOURCE_COLOR = {
  official_confirmed_by_crowd: colors.success,
  official: colors.primary,
  crowd_sourced: colors.accent,
  crowd_sourced_unconfirmed: colors.warning,
  unavailable: colors.textMuted,
};

export default function CrowdPositionScreen() {
  const { apiBaseUrl } = useSettings();
  const [trainNumber, setTrainNumber] = useState("");
  const [date, setDate] = useState("");
  const [fused, setFused] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [reporterId, setReporterId] = useState(null);
  const [reporterStats, setReporterStats] = useState(null);
  const [reporting, setReporting] = useState(false);
  const [reportMsg, setReportMsg] = useState(null);

  const [leaderboard, setLeaderboard] = useState(null);

  useEffect(() => {
    (async () => {
      const id = await getReporterId();
      setReporterId(id);
      try {
        const stats = await getReporterStats(apiBaseUrl, id);
        setReporterStats(stats);
      } catch (e) {
        // non-fatal — badge panel just stays empty until the first report
      }
    })();
  }, []);

  const refreshLeaderboard = useCallback(async () => {
    try {
      const data = await getPositionLeaderboard(apiBaseUrl, 10);
      setLeaderboard(data);
    } catch (e) {
      // silent — leaderboard is a nice-to-have, never blocks the core flow
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    refreshLeaderboard();
  }, [refreshLeaderboard]);

  async function runFetchPosition() {
    if (!trainNumber.trim()) {
      setError("Enter a train number first.");
      return;
    }
    setLoading(true);
    setError(null);
    setFused(null);
    try {
      const data = await getFusedPosition(apiBaseUrl, trainNumber.trim(), date.trim() || undefined);
      setFused(data);
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  async function runReportPosition() {
    if (!trainNumber.trim()) {
      setReportMsg({ error: "Enter a train number first — the report needs to know which train you're on." });
      return;
    }
    setReporting(true);
    setReportMsg(null);
    try {
      // Lazy import so the app doesn't crash on platforms/builds where the
      // native location module isn't linked yet — this screen still works
      // for VIEWING fused positions without it.
      const Location = require("expo-location");
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setReportMsg({ error: "Location permission denied — can't submit a report without it." });
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const id = reporterId || (await getReporterId());
      const result = await reportPosition(apiBaseUrl, {
        trainNumber: trainNumber.trim(),
        reporterId: id,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyMeters: pos.coords.accuracy || null,
        date: date.trim() || null,
      });
      setReporterStats(result);
      setReportMsg({
        success: result.badge
          ? `Thanks! You're a ${result.badge} (${result.total_reports} reports total).`
          : `Thanks! ${result.total_reports} report${result.total_reports === 1 ? "" : "s"} submitted so far.`,
      });
      refreshLeaderboard();
    } catch (e) {
      setReportMsg({ error: e?.message?.includes("Cannot find module") || e?.message?.includes("expo-location")
        ? "expo-location isn't installed in this build yet — run `npx expo install expo-location` and rebuild."
        : (describeApiError(e) || "Couldn't get your location.") });
    } finally {
      setReporting(false);
    }
  }

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <SectionCard
        title="📡 Crowd-Sourced Train Position"
        subtitle="Official GPS tracking is often just a snapped last-station coordinate. Passenger reports fill the gap — fused via a Kalman filter, not a simple average."
      >
        <LabeledInput label="Train number" placeholder="e.g. 12709" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" />
        <LabeledInput label="Date (dd-mm-yyyy, optional)" placeholder="02-08-2026" value={date} onChangeText={setDate} autoCapitalize="none" />
        <View style={styles.row}>
          <PrimaryButton title="View fused position" onPress={runFetchPosition} loading={loading} style={styles.half} />
          <PrimaryButton title="Report my position" onPress={runReportPosition} loading={reporting} style={styles.half} />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {reportMsg?.success ? <Text style={styles.success}>{reportMsg.success}</Text> : null}
        {reportMsg?.error ? <Text style={styles.error}>{reportMsg.error}</Text> : null}
      </SectionCard>

      {fused && (
        <SectionCard title="Fused position">
          {fused.lat != null && fused.lng != null ? (
            <>
              <FusedPositionMap
                lat={fused.lat}
                lng={fused.lng}
                color={SOURCE_COLOR[fused.position_source] || colors.primary}
                title={fused.current_station || `Train ${fused.train_number}`}
                description={fused.confidence_label}
                uncertaintyRadiusM={fused.uncertainty_radius_m}
              />
              <InfoLine label="Confidence" value={fused.confidence_label} />
              <InfoLine label="Source" value={fused.position_source} />
              <InfoLine label="Confirming reports" value={`${fused.n_confirming_reports} of ${fused.n_total_reports} recent`} />
              <InfoLine label="Uncertainty radius" value={fused.uncertainty_radius_m != null ? `~${fused.uncertainty_radius_m} m` : null} />
              <InfoLine label="Current station" value={fused.current_station} />
            </>
          ) : (
            <Text style={styles.empty}>
              No official GPS and no recent passenger reports for this train yet — be the first to report!
            </Text>
          )}
          <Text style={styles.disclaimer}>{fused.disclaimer}</Text>
        </SectionCard>
      )}

      {reporterStats && (
        <SectionCard title="🏅 Your tracker badge">
          <InfoLine label="Reports submitted" value={reporterStats.total_reports} />
          <InfoLine label="Badge" value={reporterStats.badge || "None yet"} />
          {reporterStats.next_badge && (
            <InfoLine
              label="Next badge"
              value={`${reporterStats.next_badge.next_badge} in ${reporterStats.next_badge.reports_needed} more report(s)`}
            />
          )}
        </SectionCard>
      )}

      {leaderboard?.leaderboard?.length > 0 && (
        <SectionCard title="🏆 Top trackers" subtitle={`${leaderboard.stats?.total_reports || 0} reports from ${leaderboard.stats?.registered_reporters || 0} devices so far.`}>
          {leaderboard.leaderboard.map((r, i) => (
            <View key={r.reporter_id} style={styles.leaderRow}>
              <Text style={styles.leaderRank}>#{i + 1}</Text>
              <Text style={styles.leaderName} numberOfLines={1}>
                {r.display_name || `${r.reporter_id.slice(0, 8)}…`}
                {r.reporter_id === reporterId ? " (you)" : ""}
              </Text>
              <Text style={styles.leaderBadge}>{r.badge || "—"}</Text>
              <Text style={styles.leaderCount}>{r.total_reports}</Text>
            </View>
          ))}
        </SectionCard>
      )}
    </ScrollView>
  );
}

function InfoLine({ label, value }) {
  if (value == null || value === "") return null;
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
  row: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm },
  half: { flex: 1 },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  success: { color: colors.success, fontSize: 12, marginTop: spacing.sm, fontWeight: "600" },
  empty: { fontSize: 12.5, color: colors.textMuted, fontStyle: "italic", marginBottom: spacing.sm },
  mapBox: { height: 220, borderRadius: radius.md, overflow: "hidden", borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm },
  map: { flex: 1 },
  infoLine: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  infoLabel: { fontSize: 13, color: colors.textMuted },
  infoValue: { fontSize: 13, color: colors.text, fontWeight: "600", flexShrink: 1, textAlign: "right", marginLeft: spacing.sm },
  disclaimer: { fontSize: 11, color: colors.textMuted, fontStyle: "italic", marginTop: spacing.sm },
  leaderRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  leaderRank: { width: 28, fontSize: 12, color: colors.textMuted, fontWeight: "700" },
  leaderName: { flex: 1, fontSize: 12.5, color: colors.text, fontWeight: "600" },
  leaderBadge: { fontSize: 12, marginRight: spacing.sm },
  leaderCount: { fontSize: 12, color: colors.textMuted, fontWeight: "700", minWidth: 24, textAlign: "right" },
});
