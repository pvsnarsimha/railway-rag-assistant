import React, { useRef, useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { colors, spacing, radius } from "../theme/colors";

/**
 * RouteMapPreview — renders the `map` field the backend already attaches
 * to chat responses (route-map / trains-between questions) as an actual
 * inline map, instead of just a text hint saying a map is available.
 *
 * Handles both payload shapes app.py sends:
 *   - {type: "route", train_number, stations: [{code,name,lat,lng,...}]}
 *     -> full stop-by-stop route with a real polyline through every
 *        station that has coordinates.
 *   - {type: "station_pair", source: {...}, dest: {...}}
 *     -> just the two endpoints (trains-between / seat-availability
 *        questions never fetch a real route shape), shown as a dashed
 *        straight line and clearly labeled as a preview, not the actual
 *        rail path.
 */
export default function RouteMapPreview({ map }) {
  const mapRef = useRef(null);

  const isRoute = map?.type === "route";
  const stations = isRoute ? (map.stations || []).filter((s) => s.has_coordinates && s.lat && s.lng) : [];
  const hasStationPair = map?.type === "station_pair" && map.source?.lat && map.dest?.lat;

  const coordinates = isRoute
    ? stations.map((s) => ({ latitude: s.lat, longitude: s.lng }))
    : hasStationPair
    ? [
        { latitude: map.source.lat, longitude: map.source.lng },
        { latitude: map.dest.lat, longitude: map.dest.lng },
      ]
    : [];

  useEffect(() => {
    if (coordinates.length > 1 && mapRef.current) {
      // Fit to the whole route/pair rather than guessing a region delta —
      // route spans vary hugely (a 40km local vs. a 2000km Rajdhani).
      const t = setTimeout(() => {
        mapRef.current?.fitToCoordinates(coordinates, {
          edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
          animated: true,
        });
      }, 200);
      return () => clearTimeout(t);
    }
  }, [JSON.stringify(coordinates)]);

  if (!coordinates.length) return null;

  const initialRegion = {
    latitude: coordinates[0].latitude,
    longitude: coordinates[0].longitude,
    latitudeDelta: 4,
    longitudeDelta: 4,
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.mapBox}>
        <MapView ref={mapRef} style={styles.map} initialRegion={initialRegion} provider={PROVIDER_GOOGLE}>
          {isRoute && coordinates.length > 1 && (
            <Polyline coordinates={coordinates} strokeColor={colors.primary} strokeWidth={3} />
          )}
          {hasStationPair && (
            <Polyline
              coordinates={coordinates}
              strokeColor={colors.primary}
              strokeWidth={2}
              lineDashPattern={[6, 6]}
            />
          )}

          {isRoute &&
            stations.map((s, idx) => {
              const isEndpoint = idx === 0 || idx === stations.length - 1;
              if (!isEndpoint && stations.length > 12) return null; // keep dense routes readable
              return (
                <Marker
                  key={`${s.code}_${idx}`}
                  coordinate={{ latitude: s.lat, longitude: s.lng }}
                  title={`${s.name} (${s.code})`}
                  description={s.scheduled_arrival ? `Arr ${s.scheduled_arrival}` : undefined}
                  pinColor={idx === 0 ? colors.success : idx === stations.length - 1 ? colors.danger : colors.accent}
                />
              );
            })}

          {hasStationPair && (
            <>
              <Marker
                coordinate={{ latitude: map.source.lat, longitude: map.source.lng }}
                title={map.source.name || map.source.code}
                pinColor={colors.success}
              />
              <Marker
                coordinate={{ latitude: map.dest.lat, longitude: map.dest.lng }}
                title={map.dest.name || map.dest.code}
                pinColor={colors.danger}
              />
            </>
          )}
        </MapView>
      </View>
      <Text style={styles.caption}>
        {isRoute
          ? `Full route \u2014 ${stations.length} stop${stations.length === 1 ? "" : "s"} with known coordinates`
          : "Straight-line preview between the two stations \u2014 not the actual rail path"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm },
  mapBox: {
    height: 180,
    borderRadius: radius.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
  },
  map: { flex: 1 },
  caption: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
});
