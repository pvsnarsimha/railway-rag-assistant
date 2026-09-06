import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/colors";

/**
 * FEATURE: Train Delay Prediction with Explainable AI — visual "why"
 * breakdown for /api/delay/explain's `attributions` array (SHAP-derived
 * per-feature minutes + percent-of-total, plus the separate weather line —
 * see backend/delay_explainability.py). A horizontal bar per factor, bar
 * length = share of total attribution, color = whether that factor is
 * currently ADDING delay (amber/red) or REDUCING it (green) — not a
 * generic "importance" magnitude color, since direction is the thing a
 * rider actually cares about.
 *
 * Deliberately plain react-native Views rather than a charting library —
 * a handful of bars with a label and a percentage doesn't need SVG paths
 * or a canvas, and Views lay out identically on iOS/Android/web with zero
 * measurement-timing edge cases.
 */
export default function FeatureImportanceBars({ attributions }) {
  if (!attributions || attributions.length === 0) {
    return <Text style={styles.empty}>No per-factor breakdown available for this prediction.</Text>;
  }

  const maxPct = Math.max(...attributions.map((a) => a.pct_of_total), 1);

  return (
    <View>
      {attributions.map((a) => {
        const increasing = a.minutes >= 0;
        const barColor = increasing ? colors.danger : colors.success;
        const widthPct = Math.max(4, (a.pct_of_total / maxPct) * 100);
        return (
          <View key={a.key} style={styles.row}>
            <View style={styles.labelRow}>
              <Text style={styles.label} numberOfLines={2}>
                {a.label}
                {!a.is_shap ? " •" : ""}
              </Text>
              <Text style={[styles.minutes, { color: barColor }]}>
                {increasing ? "+" : ""}
                {a.minutes.toFixed(1)} min
              </Text>
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${widthPct}%`, backgroundColor: barColor }]} />
            </View>
            <Text style={styles.pct}>{a.pct_of_total}% of total attribution</Text>
          </View>
        );
      })}
      <Text style={styles.legend}>
        Red = adds to the predicted delay · Green = reduces it. "•" marks the weather line, which is
        added on top of the model's own estimate rather than SHAP-attributed (see disclaimer below).
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: spacing.md },
  labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 4 },
  label: { flex: 1, fontSize: 12.5, color: colors.text, fontWeight: "600", marginRight: spacing.sm },
  minutes: { fontSize: 12.5, fontWeight: "700" },
  track: { height: 10, borderRadius: radius.pill, backgroundColor: colors.chip, overflow: "hidden" },
  fill: { height: "100%", borderRadius: radius.pill },
  pct: { fontSize: 11, color: colors.textMuted, marginTop: 3 },
  empty: { fontSize: 12.5, color: colors.textMuted, fontStyle: "italic" },
  legend: { fontSize: 10.5, color: colors.textMuted, marginTop: spacing.xs, fontStyle: "italic" },
});
