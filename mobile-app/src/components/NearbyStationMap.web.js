import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { radius, colors, spacing } from "../theme/colors";

/**
 * Web build of NearbyStationMap. `react-native-maps` has no web target, so
 * this shows the coordinates as text instead — the screen already offers an
 * "Open in Google Maps" button right below this for an actual map view.
 */
export default function NearbyStationMap({ latitude, longitude, title }) {
  if (latitude == null || longitude == null) return null;
  return (
    <View style={styles.box}>
      <Text style={styles.line}>
        📍 {title ? `${title} — ` : ""}
        {latitude.toFixed(5)}, {longitude.toFixed(5)}
      </Text>
      <Text style={styles.hint}>Map preview isn't available in the web app — use "Open in Google Maps" below.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: 8,
    backgroundColor: colors.chip,
  },
  line: { fontSize: 13, color: colors.text, fontWeight: "600" },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 4, fontStyle: "italic" },
});
