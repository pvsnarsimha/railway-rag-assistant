import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, radius, spacing } from "../theme/colors";

/**
 * Web build of RoutePositionMap. `react-native-maps` has no web target, so
 * this shows the nearest-stop text (already rendered below the map on
 * native) plus a short list of stops instead of the animated polyline map.
 */
export default function RoutePositionMap({ stops, pos }) {
  if (!stops.length) return null;
  return (
    <View style={styles.box}>
      <Text style={styles.hint}>Animated route map isn't available in the web app — showing the stop list instead.</Text>
      {pos?.nearStop && (
        <Text style={styles.near}>
          Nearest stop right now: {pos.nearStop.name} ({pos.nearStop.code})
        </Text>
      )}
      {stops.map((s, i) => (
        <Text key={s.code + i} style={styles.line}>
          {i + 1}. {s.name} ({s.code}){s.scheduled_arrival ? ` — sch. arr. ${s.scheduled_arrival}` : ""}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: 12,
    backgroundColor: colors.chip,
  },
  hint: { fontSize: 11, color: colors.textMuted, fontStyle: "italic", marginBottom: 6 },
  near: { fontSize: 12.5, color: colors.text, fontWeight: "700", marginBottom: 6 },
  line: { fontSize: 12, color: colors.text, marginBottom: 2 },
});
