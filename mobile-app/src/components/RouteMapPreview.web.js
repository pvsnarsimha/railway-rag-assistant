import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/colors";

/**
 * Web build of RouteMapPreview (see the native version for the payload
 * shapes). `react-native-maps` has no web target, so the chat bubble gets a
 * short text summary instead of an inline map.
 */
export default function RouteMapPreview({ map }) {
  const isRoute = map?.type === "route";
  const stations = isRoute ? (map.stations || []).filter((s) => s.has_coordinates && s.lat && s.lng) : [];
  const hasStationPair = map?.type === "station_pair" && map.source?.lat && map.dest?.lat;

  if (!isRoute && !hasStationPair) return null;
  if (isRoute && !stations.length) return null;

  return (
    <View style={styles.wrap}>
      {isRoute ? (
        <Text style={styles.line}>
          🗺️ Route: {stations[0]?.name} → {stations[stations.length - 1]?.name} ({stations.length} stop
          {stations.length === 1 ? "" : "s"} with known coordinates)
        </Text>
      ) : (
        <Text style={styles.line}>
          🗺️ {map.source.name || map.source.code} → {map.dest.name || map.dest.code} (straight-line preview, not the actual rail path)
        </Text>
      )}
      <Text style={styles.caption}>Map preview isn't available in the web app.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.chip },
  line: { fontSize: 12.5, color: colors.text, fontWeight: "600" },
  caption: { fontSize: 11, color: colors.textMuted, marginTop: 4, fontStyle: "italic" },
});
