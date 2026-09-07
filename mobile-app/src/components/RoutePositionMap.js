import React, { useRef, useEffect } from "react";
import { View, StyleSheet } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { colors, radius } from "../theme/colors";

/**
 * RoutePositionMap — the animated Route Time-Lapse map from
 * MoreToolsScreen.js's RouteTimelapseTool, pulled out into its own
 * component (native map + fit-to-bounds logic together) so the web build
 * can swap in a map-free `.web.js` sibling without duplicating the rest of
 * that 2000+ line screen. See LiveTrackingScreen.web.js for the pattern.
 *
 * `stops` — array of {code, name, lat, lng, progress, scheduled_arrival}
 * `pos`   — {latitude, longitude, nearStop} | null, the current interpolated
 *           train position (see _tlPositionAt in MoreToolsScreen.js)
 */
export default function RoutePositionMap({ stops, pos }) {
  const mapRef = useRef(null);

  useEffect(() => {
    if (stops.length > 1 && mapRef.current) {
      const t = setTimeout(() => {
        mapRef.current?.fitToCoordinates(
          stops.map((s) => ({ latitude: s.lat, longitude: s.lng })),
          { edgePadding: { top: 40, right: 40, bottom: 40, left: 40 }, animated: true },
        );
      }, 300);
      return () => clearTimeout(t);
    }
  }, [stops]);

  if (!stops.length) return null;

  return (
    <MapView
      ref={mapRef}
      style={styles.map}
      provider={PROVIDER_GOOGLE}
      initialRegion={{ latitude: stops[0].lat, longitude: stops[0].lng, latitudeDelta: 4, longitudeDelta: 4 }}
    >
      <Polyline coordinates={stops.map((s) => ({ latitude: s.lat, longitude: s.lng }))} strokeColor={colors.primary} strokeWidth={3} />
      {stops.map((s, i) => (
        <Marker key={s.code + i} coordinate={{ latitude: s.lat, longitude: s.lng }} title={`${s.name} (${s.code})`} pinColor={colors.border} opacity={0.6} />
      ))}
      {pos && <Marker coordinate={{ latitude: pos.latitude, longitude: pos.longitude }} title="Train" pinColor={colors.accent} />}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: { width: "100%", height: 220, borderRadius: radius.md, marginTop: 12 },
});
