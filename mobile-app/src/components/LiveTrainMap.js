// LiveTrainMap.js (Android / iOS)
// --------------------------------
// "Train on map" for the phone app's Live Tracking screen — the native
// counterpart of the Leaflet map the website draws inline in
// LiveTrackingScreen.js (web-only code there). Same idea: route line,
// a dot per station (green passed / red current / grey upcoming), and the
// train's live position, fitted to the route once.
import React, { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import MapView, { Marker, Polyline, Circle, PROVIDER_GOOGLE } from "react-native-maps";
import { colors, radius } from "../theme/colors";

export default function LiveTrainMap({ timeline, lat, lng, trainLabel }) {
  const mapRef = useRef(null);
  const fittedRef = useRef(false);
  const points = (timeline || []).filter((s) => s.lat != null && s.lng != null);

  useEffect(() => {
    if (fittedRef.current || points.length < 2 || !mapRef.current) return undefined;
    const t = setTimeout(() => {
      mapRef.current?.fitToCoordinates(
        points.map((s) => ({ latitude: s.lat, longitude: s.lng })),
        { edgePadding: { top: 30, right: 30, bottom: 30, left: 30 }, animated: false },
      );
      fittedRef.current = true;
    }, 300);
    return () => clearTimeout(t);
  }, [points.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (points.length < 2) return null;
  return (
    <MapView
      ref={mapRef}
      style={styles.map}
      provider={PROVIDER_GOOGLE}
      initialRegion={{ latitude: points[0].lat, longitude: points[0].lng, latitudeDelta: 4, longitudeDelta: 4 }}
      scrollEnabled={false}
    >
      <Polyline coordinates={points.map((s) => ({ latitude: s.lat, longitude: s.lng }))} strokeColor="#16324F" strokeWidth={3} />
      {points.map((s, i) => (
        <Circle
          key={`${s.code || i}_${i}`}
          center={{ latitude: s.lat, longitude: s.lng }}
          radius={s.kind === "intermediate" ? 400 : 900}
          fillColor={s.status === "passed" ? "#2E8B57" : s.status === "current" ? "#C1272D" : "#8a93a1"}
          strokeColor="transparent"
        />
      ))}
      {lat != null && lng != null ? (
        <Marker coordinate={{ latitude: lat, longitude: lng }} title={trainLabel || "Train"} pinColor={colors.danger} />
      ) : null}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: { width: "100%", height: 220, borderRadius: radius.md },
});
