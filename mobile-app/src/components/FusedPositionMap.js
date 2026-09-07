import React from "react";
import { View, StyleSheet, Platform } from "react-native";
import MapView, { Marker, Circle, PROVIDER_GOOGLE } from "react-native-maps";
import { colors, radius } from "../theme/colors";

/**
 * FusedPositionMap — the "Fused position" map from CrowdPositionScreen.js,
 * pulled into its own component so the web build can swap in a map-free
 * `.web.js` sibling without duplicating the rest of that screen. See
 * LiveTrackingScreen.web.js for the established pattern.
 */
export default function FusedPositionMap({ lat, lng, color, title, description, uncertaintyRadiusM }) {
  if (lat == null || lng == null) return null;
  const markerColor = color || colors.primary;
  return (
    <View style={styles.mapBox}>
      <MapView
        style={styles.map}
        provider={Platform.OS === "android" ? PROVIDER_GOOGLE : undefined}
        initialRegion={{ latitude: lat, longitude: lng, latitudeDelta: 0.08, longitudeDelta: 0.08 }}
      >
        <Marker coordinate={{ latitude: lat, longitude: lng }} pinColor={markerColor} title={title} description={description} />
        {uncertaintyRadiusM ? (
          <Circle
            center={{ latitude: lat, longitude: lng }}
            radius={uncertaintyRadiusM}
            strokeColor={markerColor}
            fillColor={`${markerColor}22`}
          />
        ) : null}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  mapBox: { height: 220, borderRadius: radius.md, overflow: "hidden", borderWidth: 1, borderColor: colors.border, marginBottom: 8 },
  map: { flex: 1 },
});
