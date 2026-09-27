import React from "react";
import { View, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import { Text } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import { useT } from "../context/LanguageContext";
import ScreenLanguageBar from "../components/ScreenLanguageBar";

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
  const { t } = useT();
  const label = (l) => t(l.replace(/\n/g, " "));
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

  // Greeting follows the phone's own clock — display only.
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <ScreenLanguageBar
        style={styles.langBar}
        getSpeech={() => [
          "Train Enquiry Center",
          "Where to today? Search trains between stations.",
          "Quick services: " + TILES.map((x) => x.label.replace(/\n/g, " ")).join(", "),
          "AI delay prediction. Know delays before you leave.",
          "Ask anything about your train journey.",
        ]}
      />

      {/* Blue hero with a rounded bottom edge; the search card below
          overlaps it, like the reference home-screen design. */}
      <View style={styles.hero}>
        <View style={styles.heroGlow} pointerEvents="none" />
        <Text style={styles.heroGreeting}>{t(greeting)} 👋</Text>
        <Text style={styles.heroTitle}>{t("Where to today?")}</Text>
        <Text style={styles.heroSubtitle}>{t("Real-time status, schedules, availability and fares — no fabricated data, ever.")}</Text>
      </View>

      {/* Search card — a shortcut into the existing Trains Between Stations
          screen (the From/To/date/class form itself lives there). */}
      <TouchableOpacity style={styles.searchCard} activeOpacity={0.9} onPress={() => openTile("TrainsBetween")}>
        <View style={styles.searchRow}>
          <View style={[styles.searchDot, { borderColor: colors.primary }]} />
          <View style={styles.searchRowText}>
            <Text style={styles.searchLabel}>{t("From")}</Text>
            <Text style={styles.searchValue}>{t("Choose station")}</Text>
          </View>
        </View>
        <View style={styles.searchDividerRow}>
          <View style={styles.searchDivider} />
          <View style={styles.swapCircle}>
            <Ionicons name="swap-vertical" size={16} color={colors.textInverse} />
          </View>
        </View>
        <View style={styles.searchRow}>
          <Ionicons name="location" size={16} color={colors.orange} style={styles.searchPin} />
          <View style={styles.searchRowText}>
            <Text style={styles.searchLabel}>{t("To")}</Text>
            <Text style={styles.searchValue}>{t("Choose station")}</Text>
          </View>
        </View>
        <View style={styles.searchChipRow}>
          <View style={styles.searchChipBlue}>
            <Ionicons name="calendar-outline" size={13} color={colors.primary} />
            <Text style={styles.searchChipBlueText}>{t("Any date")}</Text>
          </View>
          <View style={styles.searchChipGrey}>
            <Text style={styles.searchChipGreyText}>{t("All Classes")}</Text>
            <Ionicons name="chevron-down" size={12} color={colors.text} />
          </View>
        </View>
        <View style={styles.searchBtn}>
          <Text style={styles.searchBtnText}>{t("Search Trains")}</Text>
          <Ionicons name="arrow-forward" size={16} color={colors.textInverse} />
        </View>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>{t("Quick Services")}</Text>
      <View style={styles.grid}>
        {TILES.map((tile) => (
          <TouchableOpacity key={tile.key} style={styles.tile} onPress={() => openTile(tile.key)} activeOpacity={0.75}>
            <View style={[styles.tileIconWrap, { backgroundColor: tile.bg }]}>
              <Ionicons name={tile.icon} size={24} color={tile.fg} />
            </View>
            <Text style={styles.tileLabel}>{label(tile.label)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Same destination as before (Live Tracking tab, which carries the
          GPS position + ML delay prediction). */}
      <TouchableOpacity style={styles.promoCard} activeOpacity={0.85} onPress={() => navigation.getParent()?.navigate("Track")}>
        <View style={styles.promoGlow} pointerEvents="none" />
        <View style={styles.promoTextWrap}>
          <Text style={styles.promoKicker}>{t("AI Delay Prediction")}</Text>
          <Text style={styles.promoTitle}>{t("Know delays before you leave")}</Text>
          <Text style={styles.promoSubtitle}>{t("Real GPS position + station-by-station ML delay prediction, updated every few seconds.")}</Text>
        </View>
        <View style={styles.promoIconWrap}>
          <Ionicons name="navigate-circle" size={30} color={colors.textInverse} />
        </View>
      </TouchableOpacity>

      {/* Railway Assistant shortcut — examples show what can be asked;
          tapping opens the existing chat tab. */}
      <TouchableOpacity style={styles.askCard} activeOpacity={0.85} onPress={() => openQuickLaunch("Chat")}>
        <View style={styles.askHeadRow}>
          <Text style={styles.askSpark}>✨</Text>
          <Text style={styles.askTitle}>{t("Ask anything about your train journey")}</Text>
        </View>
        <Text style={styles.askExample}>“{t("Is 12785 running late today?")}”</Text>
        <View style={styles.askChipRow}>
          {["Platform no.?", "PNR status", "Trains to Hyderabad"].map((c) => (
            <View key={c} style={styles.askChip}>
              <Text style={styles.askChipText}>{t(c)}</Text>
            </View>
          ))}
        </View>
        <View style={styles.askCta}>
          <Text style={styles.askCtaText}>{t("Ask the assistant")}</Text>
          <Ionicons name="arrow-forward" size={14} color="#5B4BDB" />
        </View>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>{t("Quick Launch")}</Text>
      <View style={styles.quickRow}>
        {QUICK_LAUNCH.map((item) => (
          <TouchableOpacity key={item.key} style={styles.quickItem} onPress={() => openQuickLaunch(item.key)} activeOpacity={0.75}>
            <View style={styles.quickIconWrap}>
              <Ionicons name={item.icon} size={22} color={colors.primary} />
            </View>
            <Text style={styles.quickLabel}>{t(item.label)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.footNote}>
        {t("Live data via RailKit + RapidAPI. Enquiry only — this app hands off to IRCTC for actual booking.")}
      </Text>
    </ScrollView>
  );
}

const CARD_SHADOW = {
  shadowColor: "#0B3D91",
  shadowOpacity: 0.08,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 6 },
  elevation: 3,
};
const GUTTER = spacing.lg;

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { paddingBottom: spacing.xl },
  langBar: { paddingHorizontal: GUTTER, paddingTop: spacing.md, marginBottom: spacing.md },

  // --- hero ---
  hero: {
    backgroundColor: colors.primary,
    paddingHorizontal: GUTTER + 4,
    paddingTop: spacing.lg,
    paddingBottom: 64, // room for the overlapping search card
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    overflow: "hidden",
  },
  heroGlow: {
    position: "absolute", top: -90, right: -70, width: 240, height: 240, borderRadius: 120,
    backgroundColor: "#1467D1", opacity: 0.55,
  },
  heroGreeting: { color: "#CFE0FF", fontSize: 13, fontWeight: "600", marginBottom: 2 },
  heroTitle: { color: colors.textInverse, fontSize: 26, fontWeight: "800", letterSpacing: 0.2, marginBottom: 6 },
  heroSubtitle: { color: colors.textInverse, opacity: 0.8, fontSize: 12, lineHeight: 17, maxWidth: "92%" },

  // --- search card ---
  searchCard: {
    backgroundColor: colors.card,
    borderRadius: 22,
    marginHorizontal: GUTTER,
    marginTop: -46,
    padding: spacing.lg,
    ...CARD_SHADOW,
  },
  searchRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  searchDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 3, marginHorizontal: 1 },
  searchPin: { width: 16 },
  searchRowText: { flex: 1 },
  searchLabel: { fontSize: 10, fontWeight: "800", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1 },
  searchValue: { fontSize: 17, fontWeight: "800", color: colors.text, marginTop: 1 },
  searchDividerRow: { flexDirection: "row", alignItems: "center", marginVertical: 6, paddingLeft: 30 },
  searchDivider: { flex: 1, height: 1, backgroundColor: colors.border },
  swapCircle: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primary,
    alignItems: "center", justifyContent: "center", marginLeft: spacing.sm,
  },
  searchChipRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: spacing.md },
  searchChipBlue: {
    flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#E9F1FF",
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill,
  },
  searchChipBlueText: { fontSize: 12, fontWeight: "700", color: colors.primary },
  searchChipGrey: {
    flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#F1F3F7",
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill,
  },
  searchChipGreyText: { fontSize: 12, fontWeight: "700", color: colors.text },
  searchBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: colors.orange, borderRadius: radius.md + 2, paddingVertical: 14, marginTop: spacing.md,
    shadowColor: colors.orange, shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  searchBtnText: { color: colors.textInverse, fontSize: 16, fontWeight: "800", letterSpacing: 0.3 },

  sectionTitle: {
    fontSize: 17, fontWeight: "800", color: colors.text,
    marginTop: spacing.xl, marginBottom: spacing.md, paddingHorizontal: GUTTER + 2,
  },

  // --- quick services grid ---
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-start",
    paddingHorizontal: GUTTER - 4,
  },
  tile: {
    width: "33.333%", // 9 tiles → a neat 3×3 grid
    alignItems: "center",
    paddingHorizontal: 4,
    marginBottom: spacing.md,
  },
  tileIconWrap: {
    width: 58, height: 58, borderRadius: 18,
    alignItems: "center", justifyContent: "center",
    marginBottom: 6,
  },
  tileLabel: { fontSize: 11, fontWeight: "700", color: colors.text, textAlign: "center", lineHeight: 14 },

  // --- AI delay prediction promo ---
  promoCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0F8A7E",
    borderRadius: 20,
    padding: spacing.lg,
    marginHorizontal: GUTTER,
    marginTop: spacing.sm,
    gap: spacing.md,
    overflow: "hidden",
  },
  promoGlow: {
    position: "absolute", top: -60, left: -40, width: 200, height: 160, borderRadius: 100,
    backgroundColor: "#16A394", opacity: 0.8,
  },
  promoIconWrap: {
    width: 52, height: 52, borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center", justifyContent: "center",
  },
  promoTextWrap: { flex: 1 },
  promoKicker: { color: "#C9F2EC", fontSize: 11, fontWeight: "700", marginBottom: 2 },
  promoTitle: { color: colors.textInverse, fontSize: 16, fontWeight: "800", marginBottom: 4 },
  promoSubtitle: { color: colors.textInverse, opacity: 0.85, fontSize: 11, lineHeight: 15 },

  // --- ask the assistant ---
  askCard: {
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: spacing.lg,
    marginHorizontal: GUTTER,
    marginTop: spacing.md,
    ...CARD_SHADOW,
  },
  askHeadRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  askSpark: { fontSize: 18 },
  askTitle: { flex: 1, fontSize: 15, fontWeight: "800", color: colors.text },
  askExample: { fontSize: 13, color: colors.textMuted, marginBottom: spacing.sm },
  askChipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  askChip: { backgroundColor: "#EEF0FF", paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill },
  askChipText: { fontSize: 12, fontWeight: "700", color: "#5B4BDB" },
  askCta: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: spacing.md },
  askCtaText: { fontSize: 13, fontWeight: "800", color: "#5B4BDB" },

  // --- quick launch ---
  quickRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderRadius: 20,
    marginHorizontal: GUTTER,
    paddingVertical: spacing.md,
    ...CARD_SHADOW,
  },
  quickItem: { flex: 1, alignItems: "center", gap: 6 },
  quickIconWrap: {
    width: 42, height: 42, borderRadius: 14, backgroundColor: "#E9F1FF",
    alignItems: "center", justifyContent: "center",
  },
  quickLabel: { fontSize: 11, fontWeight: "700", color: colors.textMuted, textAlign: "center" },
  footNote: { fontSize: 11, color: colors.textMuted, textAlign: "center", marginTop: spacing.lg, paddingHorizontal: spacing.xl },
});
