import React from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";

/**
 * RailYatri-style "Train Enquiry Center" home screen — a plain icon grid
 * of the informational (enquiry) tools RailYatri's own home screen leads
 * with. Deliberately scoped to ENQUIRY, not booking: this app shows real
 * live/schedule/fare/availability data via RailKit + RapidAPI (see
 * railway_api.py), but has no IRCTC booking API access, so there's no
 * "book a seat" or bus-booking flow here — same honesty rule TrainSearchScreen
 * already follows for its own "Book on IRCTC" hand-off.
 *
 * Each tile pushes a screen on THIS tab's own stack (see the HomeStack in
 * App.js) except "More", which jumps to the existing More Tools tab —
 * that tab already has a large, working set of tools; duplicating it here
 * would just be two copies of the same thing to keep in sync.
 */
const TILES = [
  { key: "LiveTrainStatus", label: "Live Train\nStatus", icon: "pulse-outline" },
  { key: "PnrStatus", label: "PNR Status", icon: "ticket-outline" },
  { key: "TrainSchedule", label: "Time Table", icon: "time-outline" },
  { key: "SeatAvailability", label: "Seat\nAvailability", icon: "grid-outline" },
  { key: "TrainsBetween", label: "Trains B/W\nStations", icon: "swap-horizontal-outline" },
  { key: "FareEnquiry", label: "Fare\nCalculator", icon: "calculator-outline" },
  { key: "LiveTracking", label: "Live GPS\nTracking", icon: "navigate-circle-outline" },
  { key: "More", label: "More", icon: "ellipsis-horizontal-circle-outline" },
];

export default function HomeScreen({ navigation }) {
  function openTile(key) {
    if (key === "More") {
      // Jump to the existing "More Tools" tab rather than duplicating it
      // as a stack screen — see the module comment above.
      navigation.getParent()?.navigate("More");
      return;
    }
    if (key === "LiveTracking") {
      navigation.getParent()?.navigate("Track");
      return;
    }
    navigation.navigate(key);
  }

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <View style={styles.banner}>
        <Text style={styles.bannerTitle}>Train Enquiry Center</Text>
        <Text style={styles.bannerSubtitle}>Real-time status, schedules, availability and fares — no fabricated data, ever.</Text>
      </View>
      <View style={styles.grid}>
        {TILES.map((tile) => (
          <TouchableOpacity key={tile.key} style={styles.tile} onPress={() => openTile(tile.key)} activeOpacity={0.75}>
            <View style={styles.tileIconWrap}>
              <Ionicons name={tile.icon} size={26} color={colors.primary} />
            </View>
            <Text style={styles.tileLabel}>{tile.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.footNote}>
        Live data via RailKit + RapidAPI. Enquiry only — this app hands off to IRCTC for actual booking.
      </Text>
    </ScrollView>
  );
}

const TILE_WIDTH = "23%";

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  banner: {
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  bannerTitle: { color: colors.textInverse, fontSize: 18, fontWeight: "700", marginBottom: 4 },
  bannerSubtitle: { color: colors.textInverse, opacity: 0.85, fontSize: 12 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  tile: {
    width: TILE_WIDTH,
    alignItems: "center",
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  tileIconWrap: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: colors.chip,
    alignItems: "center", justifyContent: "center",
    marginBottom: 6,
  },
  tileLabel: { fontSize: 11, fontWeight: "600", color: colors.text, textAlign: "center" },
  footNote: { fontSize: 11, color: colors.textMuted, textAlign: "center", marginTop: spacing.lg, paddingHorizontal: spacing.md },
});
