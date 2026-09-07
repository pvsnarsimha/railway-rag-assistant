import React from "react";
import { View, StyleSheet } from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE } from "react-native-maps";
import { radius, colors } from "../theme/colors";

/**
 * NearbyStationMap — single-marker map for a looked-up station (used by the
 * "Offline Route Maps & Station Information" tool in MoreToolsScreen.js).
 * Pulled out into its own component so the web build can swap in a map-free
 * `.web.js` sibling without duplicating the much larger screen file — see
 * LiveTrackingScreen.web.js for the established pattern this follows.
 */
export default function NearbyStationMap({ latitude, longitude, title }) {
  if (latitude == null || longitude == null) return null;
  return (
    <View style={styles.mapBox}>
      <MapView
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={{ latitude, longitude, latitudeDelta: 0.05, longitudeDelta: 0.05 }}
        region={{ latitude, longitude, latitudeDelta: 0.05, longitudeDelta: 0.05 }}
      >
        <Marker coordinate={{ latitude, longitude }} title={title} />
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  mapBox: {
    height: 180,
    borderRadius: radius.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 8,
  },
  map: { flex: 1 },
});
