import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, RefreshControl, Dimensions } from "react-native";
import { LineChart } from "react-native-chart-kit";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import { useSettings } from "../context/SettingsContext";
import { getAnalyticsSummary, getFeedbackStats } from "../api/railwayApi";
import { describeApiError } from "../api/client";

const screenWidth = Dimensions.get("window").width - spacing.lg * 4;

const chartConfig = {
  backgroundGradientFrom: colors.card,
  backgroundGradientTo: colors.card,
  decimalPlaces: 0,
  color: (opacity = 1) => `rgba(11, 61, 145, ${opacity})`,
  labelColor: () => colors.textMuted,
  propsForDots: { r: "3" },
};

export default function AnalyticsScreen() {
  const { apiBaseUrl } = useSettings();
  const [summary, setSummary] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [summaryData, feedbackData] = await Promise.all([
        getAnalyticsSummary(apiBaseUrl),
        getFeedbackStats(apiBaseUrl),
      ]);
      setSummary(summaryData);
      setFeedback(feedbackData);
    } catch (e) {
      setError(describeApiError(e));
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const delaySeries = summary?.delay_series || [];
  const actualPoints = delaySeries.filter((p) => p.actual != null).slice(-15);
  const predictedPoints = delaySeries.filter((p) => p.predicted != null).slice(-15);

  const hasChartData = actualPoints.length > 1 || predictedPoints.length > 1;

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {error ? (
        <SectionCard>
          <Text style={styles.error}>{error}</Text>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Session activity"
        subtitle="In-memory, this server process's real events since its last restart."
      >
        <StatGrid
          items={[
            { label: "Total events", value: summary?.total_events ?? "—" },
            { label: "Live-data error rate", value: summary ? `${summary.live_error_rate_pct}%` : "—" },
          ]}
        />
        {summary?.intent_distribution && (
          <View style={styles.intentWrap}>
            <Text style={styles.intentTitle}>Intent distribution</Text>
            {Object.entries(summary.intent_distribution).map(([intent, count]) => (
              <View key={intent} style={styles.intentRow}>
                <Text style={styles.intentName}>{intent}</Text>
                <Text style={styles.intentCount}>{count}</Text>
              </View>
            ))}
          </View>
        )}
      </SectionCard>

      <SectionCard
        title="RLHF feedback loop"
        subtitle="Every thumbs up/down from the Chat tab lands here — this is the human-preference signal /api/feedback/export shapes into training pairs."
      >
        <StatGrid
          items={[
            { label: "Total ratings", value: feedback?.total_feedback ?? "—" },
            { label: "👍 up", value: feedback?.thumbs_up ?? "—" },
            { label: "👎 down", value: feedback?.thumbs_down ?? "—" },
            { label: "Approval rate", value: feedback?.approval_rate_pct != null ? `${feedback.approval_rate_pct}%` : "—" },
            { label: "Corrections collected", value: feedback?.corrections_collected ?? "—" },
          ]}
        />
      </SectionCard>

      <SectionCard title="Recent delay: actual vs predicted" subtitle="Last 15 logged points this session.">
        {hasChartData ? (
          <LineChart
            data={{
              labels: actualPoints.map((_, i) => String(i + 1)),
              datasets: [
                { data: actualPoints.length ? actualPoints.map((p) => p.actual) : [0], color: () => colors.primary },
                { data: predictedPoints.length ? predictedPoints.map((p) => p.predicted) : [0], color: () => colors.accent },
              ],
              legend: ["Actual delay (min)", "Predicted delay (min)"],
            }}
            width={screenWidth}
            height={200}
            chartConfig={chartConfig}
            bezier
            style={styles.chart}
          />
        ) : (
          <Text style={styles.emptyText}>
            No delay data logged yet this session — check a train's live status or predict a delay first.
          </Text>
        )}
      </SectionCard>
    </ScrollView>
  );
}

function StatGrid({ items }) {
  return (
    <View style={styles.statGrid}>
      {items.map((item) => (
        <View key={item.label} style={styles.statCell}>
          <Text style={styles.statValue}>{String(item.value)}</Text>
          <Text style={styles.statLabel}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  error: { color: colors.danger, fontSize: 13 },
  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  statCell: {
    minWidth: "42%",
    backgroundColor: colors.chip,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
    flexGrow: 1,
  },
  statValue: { fontSize: 20, fontWeight: "800", color: colors.primary },
  statLabel: { fontSize: 11, color: colors.textMuted, marginTop: 2, textAlign: "center" },
  intentWrap: { marginTop: spacing.md },
  intentTitle: { fontSize: 12, fontWeight: "700", color: colors.text, marginBottom: spacing.xs },
  intentRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  intentName: { fontSize: 12, color: colors.textMuted },
  intentCount: { fontSize: 12, color: colors.text, fontWeight: "600" },
  chart: { borderRadius: radius.md },
  emptyText: { fontSize: 13, color: colors.textMuted },
});
