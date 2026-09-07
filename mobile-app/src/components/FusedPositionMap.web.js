import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, radius, spacing } from "../theme/colors";

/**
 * Web build of FusedPositionMap. `react-native-maps` has no web target, so
 * this shows the fused coordinates as text instead of a marker/circle map.
 */
export default function FusedPositionMap({ lat, lng, color, title, description, uncertaintyRadiusM }) {
  if (lat == null || lng == null) return null;
  return (
    <View style={[styles.box, { borderColor: color || colors.border }]}>
      <Text style={styles.line}>
        📍 {title || "Current position"}: {lat.toFixed(5)}, {lng.toFixed(5)}
      </Text>
      {description ? <Text style={styles.desc}>{description}</Text> : null}
      {uncertaintyRadiusM ? <Text style={styles.hint}>Uncertainty radius: ~{uncertaintyRadiusM} m</Text> : null}
      <Text style={styles.hint}>Map preview isn't available in the web app.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radius.md, borderWidth: 1, padding: spacing.md, marginBottom: 8, backgroundColor: colors.chip },
  line: { fontSize: 13, color: colors.text, fontWeight: "600" },
  desc: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 4, fontStyle: "italic" },
});
