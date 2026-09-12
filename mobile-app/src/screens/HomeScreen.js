import React from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";

/**
 * RailYatri-style "Train Enquiry Center" home screen. REDESIGN NOTE (per
 * explicit request to make this look like a real, polished passenger
 * app): matches RailYatri's own home layout — a 2x4 icon grid inside one
 * white card, each tile with its OWN accent color rather than one flat
 * repeated color, a promo banner below it, and a bottom quick-launch row
 * echoing RailYatri's "My Trips / My Orders / Offers / More" strip.
 *
 * Deliberately scoped to ENQUIRY, not booking: this app shows real
 * live/schedule/fare/availability data via RailKit + RapidAPI (see
 * railway_api.py), but has no IRCTC booking API access, so there's no
 * "book a seat" or bus-booking flow here — same honesty rule TrainSearchScreen
 * already follows for its own "Book on IRCTC" hand-off. The promo banner
 * below reflects that honesty: it advertises a REAL feature this app has
 * (live GPS tracking + ML delay prediction), not a fabricated SmartBus-style
 * offer copied from the reference screenshots.
 *
 * Each tile pushes a screen on THIS tab's own stack (see the HomeStack in
 * App.js) except "More", which jumps to the existing More Tools tab —
 * that tab already has a large, working set of tools; duplicating it here
 * would just be two copies of the same thing to keep in sync.
 */
const TILES = [
  { key: "LiveTrainStatus", label: "Live Train\nStatus", icon: "pulse", bg: "#E9F3FF", fg: "#1467D1" },
  { key: "PnrStatus", label: "PNR\nStatus", icon: "ticket", bg: "#FFF1E3", fg: "#D97A1B" },
  { key: "TrainSchedule", label: "Time\nTable", icon: "time", bg: "#E8F8F0", fg: "#1E8E3E" },
  { key: "SeatAvailability", label: "Seat\nAvailability", icon: "grid", bg: "#F3EAFB", fg: "#7B2FBF" },
  { key: "TrainsBetween", label: "Trains B/W\nStations", icon: "swap-horizontal", bg: "#E9F3FF", fg: "#1467D1" },
  { key: "StationSearch", label: "Station\nSearch", icon: "search", bg: "#FFF1E3", fg: "#D97A1B" },
  { key: "FareEnquiry", label: "Fare\nCalculator", icon: "calculator", bg: "#E8F8F0", fg: "#1E8E3E" },
  { key: "LiveTracking", label: "Live GPS\nTracking", icon: "navigate-circle", bg: "#FDECEC", fg: "#D93025" },
  { key: "More", label: "More", icon: "ellipsis-horizontal-circle", bg: "#EEF1F6", fg: "#5B6472" },
];
// REFORM: "Station Search" moved here from the old standalone "Tools" tab
// (it was one of only two screens that tab held, TrainSearchScreen being
// the other — and TrainsBetween above already reuses that one). With both
// of Tools' screens now reachable from this grid, the Tools tab itself is
// gone from App.js — one less item cluttering the bottom bar for
// something a passenger would only reach for occasionally.

const QUICK_LAUNCH = [
  { key: "Chat", label: "Assistant", icon: "chatbubble-ellipses-outline" },
  { key: "Track", label: "Live Tracking", icon: "navigate-circle-outline" },
  { key: "More", label: "More Tools", icon: "briefcase-outline" },
  { key: "Settings", label: "Settings", icon: "settings-outline" },
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

  function openQuickLaunch(key) {
    navigation.getParent()?.navigate(key);
  }

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <View style={styles.heroBanner}>
        <Text style={styles.heroTitle}>Train Enquiry Center</Text>
        <Text style={styles.heroSubtitle}>Real-time status, schedules, availability and fares — no fabricated data, ever.</Text>
      </View>

      <View style={styles.grid}>
        {TILES.map((tile) => (
          <TouchableOpacity key={tile.key} style={styles.tile} onPress={() => openTile(tile.key)} activeOpacity={0.75}>
            <View style={[styles.tileIconWrap, { backgroundColor: tile.bg }]}>
              <Ionicons name={tile.icon} size={24} color={tile.fg} />
            </View>
            <Text style={styles.tileLabel}>{tile.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.promoCard} activeOpacity={0.85} onPress={() => navigation.getParent()?.navigate("Track")}>
        <View style={styles.promoIconWrap}>
          <Ionicons name="navigate-circle" size={30} color={colors.textInverse} />
        </View>
        <View style={styles.promoTextWrap}>
          <Text style={styles.promoTitle}>Track any train live</Text>
          <Text style={styles.promoSubtitle}>Real GPS position + station-by-station ML delay prediction, updated every few seconds.</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textInverse} style={{ opacity: 0.85 }} />
      </TouchableOpacity>

      <Text style={styles.sectionLabel}>Quick Launch</Text>
      <View style={styles.quickRow}>
        {QUICK_LAUNCH.map((item) => (
          <TouchableOpacity key={item.key} style={styles.quickItem} onPress={() => openQuickLaunch(item.key)} activeOpacity={0.75}>
            <Ionicons name={item.icon} size={22} color={colors.primary} />
            <Text style={styles.quickLabel}>{item.label}</Text>
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
  content: { padding: spacing.lg, paddingBottom: spacing.xl },
  heroBanner: {
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  heroTitle: { color: colors.textInverse, fontSize: 19, fontWeight: "700", marginBottom: 4 },
  heroSubtitle: { color: colors.textInverse, opacity: 0.85, fontSize: 12, lineHeight: 17 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    // Subtle elevation so the enquiry-center card reads as a distinct,
    // "raised" surface — the same visual language RailYatri's own home
    // screen uses for its Train Enquiry Center panel.
    shadowColor: "#0B3D91",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  tile: {
    width: TILE_WIDTH,
    alignItems: "center",
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
  },
  tileIconWrap: {
    width: 52, height: 52, borderRadius: 26,
    alignItems: "center", justifyContent: "center",
    marginBottom: 6,
  },
  tileLabel: { fontSize: 11, fontWeight: "600", color: colors.text, textAlign: "center" },
  promoCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primaryDark,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  promoIconWrap: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center", justifyContent: "center",
  },
  promoTextWrap: { flex: 1 },
  promoTitle: { color: colors.textInverse, fontSize: 14, fontWeight: "700", marginBottom: 2 },
  promoSubtitle: { color: colors.textInverse, opacity: 0.85, fontSize: 11, lineHeight: 15 },
  sectionLabel: {
    fontSize: 11, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase",
    letterSpacing: 0.4, marginTop: spacing.lg, marginBottom: spacing.sm, paddingHorizontal: 2,
  },
  quickRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
  },
  quickItem: { flex: 1, alignItems: "center", gap: 4 },
  quickLabel: { fontSize: 10, fontWeight: "600", color: colors.textMuted, textAlign: "center" },
  footNote: { fontSize: 11, color: colors.textMuted, textAlign: "center", marginTop: spacing.lg, paddingHorizontal: spacing.md },
});
