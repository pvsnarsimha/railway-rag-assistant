import React, { useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Linking, Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { searchTrains } from "../api/railwayApi";
import { describeApiError } from "../api/client";

const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

// Real official IRCTC booking portal — this app shows real train info but
// can't book tickets itself (no IRCTC booking API access), so booking is
// always a genuine handoff to IRCTC's own site, never a fabricated deep
// link with train/date params IRCTC doesn't officially support prefilling.
const IRCTC_BOOKING_URL = "https://www.irctc.co.in/nget/train-search";

// CROWD-POSITION FOLLOW-UP: since IRCTC's search page genuinely has no
// supported URL params to prefill (see the comment above — this was
// checked, not assumed), the honest next-best thing is a pre-booking
// summary that's copied to the clipboard right before IRCTC opens, so
// the user can paste the train/date/class straight into IRCTC's own
// search box instead of retyping it from memory. This is still a real
// hand-off, never a fabricated "seamless" in-app booking.
function buildBookingSummary({ trainNumber, trainName, source, dest, date, travelClass, quota }) {
  const parts = [
    `Train ${trainNumber}${trainName ? ` (${trainName})` : ""}`,
    source && dest ? `${source} → ${dest}` : null,
    date ? `Date: ${date}` : null,
    travelClass && travelClass !== "Any" ? `Class: ${travelClass}` : null,
    quota ? `Quota: ${quota}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

async function bookOnIrctc(details) {
  const summary = buildBookingSummary(details);
  try {
    await Clipboard.setStringAsync(summary);
    Alert.alert(
      "Trip details copied",
      `${summary}\n\nIRCTC doesn't support pre-filling its search from a link, so these details were copied to your clipboard — paste them into IRCTC's search after it opens.`,
      [{ text: "Open IRCTC", onPress: () => Linking.openURL(IRCTC_BOOKING_URL) }, { text: "Cancel", style: "cancel" }],
    );
  } catch (e) {
    // Clipboard failed for some reason — still let the hand-off through,
    // just without the copy-assist.
    Linking.openURL(IRCTC_BOOKING_URL);
  }
}

const CLASS_OPTIONS = ["Any", "1A", "2A", "3A", "3E", "CC", "EC", "SL", "2S"];
const QUOTA_OPTIONS = [
  { code: "GN", label: "General" }, { code: "PQ", label: "Pooled" },
  { code: "RL", label: "Remote Loc." }, { code: "RS", label: "Road Side" },
  { code: "TQ", label: "Tatkal" }, { code: "PT", label: "Premium Tatkal" },
  { code: "LD", label: "Ladies" }, { code: "SS", label: "Senior Citizen" },
  { code: "HP", label: "Handicapped" }, { code: "LB", label: "Lower Berth" },
  { code: "DF", label: "Defence" }, { code: "HO", label: "HQ" },
  { code: "PH", label: "Parliament" }, { code: "FT", label: "Foreign Tourist" },
];

function ChipRow({ options, value, onSelect, getKey, getLabel }) {
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => {
        const key = getKey(opt);
        const active = key === value;
        return (
          <TouchableOpacity key={key} style={[styles.chip, active && styles.chipActive]} onPress={() => onSelect(key)}>
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{getLabel(opt)}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function TrainSearchScreen() {
  const { apiBaseUrl } = useSettings();
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [travelClass, setTravelClass] = useState("Any");
  const [quota, setQuota] = useState("GN");
  const [limitText, setLimitText] = useState("10");

  const [trains, setTrains] = useState(null);
  const [meta, setMeta] = useState(null); // { total, page, total_pages, limit }
  const [note, setNote] = useState(null);
  const [fareNote, setFareNote] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  function clampedLimit() {
    const n = parseInt(limitText, 10);
    if (!Number.isFinite(n)) return 10;
    return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, n));
  }

  async function runSearch(page) {
    if (!source.trim() || !dest.trim()) {
      setError("Enter both source and destination.");
      return;
    }
    const limit = clampedLimit();
    setLimitText(String(limit));
    setLoading(true);
    setError(null);
    try {
      const data = await searchTrains(apiBaseUrl, {
        source: source.trim(),
        dest: dest.trim(),
        date: date.trim() || null,
        time: time.trim() || null,
        travelClass: travelClass === "Any" ? null : travelClass,
        quota,
        limit,
        page,
      });
      if (data.error && !data.total) {
        setError(data.error);
        setTrains([]);
        setMeta(null);
        return;
      }
      setTrains(data.trains || []);
      setMeta({ total: data.total, page: data.page, totalPages: data.total_pages, limit: data.limit });
      setNote(data.availability_note || data.error || null);
      // FEATURE: fare-on-every-result (was previously only in the
      // separate Route Compare / Fare Heatmap tools) — see fare_note for
      // the honest cap/limitation text (e.g. "class needed" or "only the
      // first N trains checked").
      setFareNote(data.fare_note || null);
    } catch (e) {
      setError(describeApiError(e));
      setTrains(null);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }

  const canPrev = meta && meta.page > 1;
  const canNext = meta && meta.page < meta.totalPages;

  return (
    <FlatList
      style={styles.flex}
      data={trains || []}
      keyExtractor={(item, idx) => `${item.train_number}_${idx}`}
      contentContainerStyle={styles.listContent}
      // NOTE: the search form used to sit in its own fixed View above a
      // separate FlatList. On a short viewport (a phone, or — especially —
      // the web build, where the page can't fall back to body scrolling)
      // that left no way to reach the results below a tall form: two
      // sibling scroll regions inside one flex column both default to
      // flex-shrink, so the results pane could get squeezed to ~0 height
      // instead of getting its own scrollbar. Making the whole screen ONE
      // FlatList (form as its header) gives everything a single, always-
      // reachable scroll container — same idiom used to fix StationSearchScreen.
      ListHeaderComponent={
        <View style={styles.content}>
          <SectionCard
            title="Search trains"
            subtitle="Real-time filter by source, destination, date, time, class and quota — choose how many trains per page (1-50)."
          >
            <View style={styles.row}>
              <LabeledInput label="From" placeholder="e.g. NDLS or Delhi" value={source} onChangeText={setSource} style={styles.half} />
              <LabeledInput label="To" placeholder="e.g. BCT or Mumbai" value={dest} onChangeText={setDest} style={styles.half} />
            </View>
            <View style={styles.row}>
              <LabeledInput label="Date (dd-mm-yyyy, optional)" placeholder="02-08-2026" value={date} onChangeText={setDate} style={styles.half} autoCapitalize="none" />
              <LabeledInput label="Time (HH:MM, optional)" placeholder="15:30" value={time} onChangeText={setTime} style={styles.half} autoCapitalize="none" keyboardType="numbers-and-punctuation" />
            </View>
            <Text style={styles.chipLabel}>Class</Text>
            <ChipRow options={CLASS_OPTIONS} value={travelClass} onSelect={setTravelClass} getKey={(c) => c} getLabel={(c) => c} />
            <Text style={styles.chipLabel}>Quota</Text>
            <ChipRow options={QUOTA_OPTIONS} value={quota} onSelect={setQuota} getKey={(q) => q.code} getLabel={(q) => q.code} />
            <LabeledInput
              label={`Trains per page (${MIN_LIMIT}-${MAX_LIMIT})`}
              placeholder="10"
              value={limitText}
              onChangeText={setLimitText}
              keyboardType="number-pad"
            />
            <PrimaryButton title="Search" onPress={() => runSearch(1)} loading={loading} />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {meta ? (
              <Text style={styles.note}>
                {meta.total} train{meta.total === 1 ? "" : "s"} found — page {meta.page} of {meta.totalPages} ({meta.limit}/page)
                {note ? ` — ${note}` : ""}
              </Text>
            ) : null}
            {fareNote ? <Text style={styles.note}>💰 {fareNote}</Text> : null}
          </SectionCard>
        </View>
      }
      renderItem={({ item }) => (
          <View style={styles.trainRow}>
            <View style={styles.numberBadge}>
              <Text style={styles.numberBadgeText}>{item.train_number}</Text>
            </View>
            <View style={styles.trainInfo}>
              <Text style={styles.trainName}>{item.train_name}</Text>
              <Text style={styles.trainMeta}>
                {[
                  item.source_departure ? `dep ${item.source_departure}` : null,
                  item.dest_arrival ? `arr ${item.dest_arrival}` : null,
                  item.duration || null,
                ].filter(Boolean).join(" · ") || "timing not available"}
              </Text>
              {!!item.classes?.length && <Text style={styles.trainClasses}>{item.classes.join(", ")}</Text>}
              {item.availability_status ? (
                <Text style={styles.availabilityBadge}>{item.availability_status}</Text>
              ) : item.availability_error ? (
                <Text style={styles.trainMeta}>availability unavailable</Text>
              ) : null}
              {item.fare != null ? (
                <Text style={styles.fareBadge}>₹{item.fare}{item.quota ? ` (${item.quota})` : ""} — est. via RailKit, not live IRCTC pricing</Text>
              ) : item.fare_error ? (
                <Text style={styles.trainMeta}>fare unavailable</Text>
              ) : null}
              <TouchableOpacity
                onPress={() => bookOnIrctc({
                  trainNumber: item.train_number, trainName: item.train_name,
                  source: source.trim(), dest: dest.trim(), date: date.trim(),
                  travelClass: travelClass === "Any" ? null : travelClass, quota,
                })}
                style={styles.bookBtn}
              >
                <Text style={styles.bookBtnText}>🎫 Book on IRCTC</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        ListEmptyComponent={
          trains ? <Text style={styles.emptyText}>No trains to show.</Text> : null
        }
        ListFooterComponent={
          meta && meta.totalPages > 1 ? (
            <View style={styles.pagination}>
              <PrimaryButton
                title="← Prev"
                variant="secondary"
                disabled={!canPrev || loading}
                onPress={() => runSearch(meta.page - 1)}
                style={styles.pageBtn}
              />
              <Text style={styles.pageInfo}>Page {meta.page} / {meta.totalPages}</Text>
              <PrimaryButton
                title="Next →"
                variant="secondary"
                disabled={!canNext || loading}
                onPress={() => runSearch(meta.page + 1)}
                style={styles.pageBtn}
              />
            </View>
          ) : null
        }
      />
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 0 },
  row: { flexDirection: "row", gap: spacing.md },
  half: { flex: 1 },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  note: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },
  trainRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  numberBadge: {
    backgroundColor: colors.chip,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    marginRight: spacing.md,
    minWidth: 56,
    alignItems: "center",
  },
  numberBadgeText: { fontSize: 12, fontWeight: "700", color: colors.primary },
  trainInfo: { flex: 1 },
  trainName: { fontSize: 14, fontWeight: "600", color: colors.text },
  trainMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  trainClasses: { fontSize: 11, color: colors.textMuted, marginTop: 2, fontStyle: "italic" },
  availabilityBadge: { fontSize: 11, color: colors.primary, marginTop: 3, fontWeight: "700" },
  fareBadge: { fontSize: 11, color: colors.text, marginTop: 3, fontWeight: "600" },
  bookBtn: {
    marginTop: 6, alignSelf: "flex-start", backgroundColor: colors.accent,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill,
  },
  bookBtnText: { fontSize: 11, fontWeight: "700", color: colors.primaryDark },
  chipLabel: { fontSize: 11, fontWeight: "700", color: colors.textMuted, marginTop: spacing.sm, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 4 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textMuted },
  chipTextActive: { color: colors.textInverse },
  emptyText: { textAlign: "center", color: colors.textMuted, marginTop: spacing.lg },
  pagination: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  pageBtn: { flex: 0, paddingHorizontal: spacing.lg },
  pageInfo: { fontSize: 13, color: colors.textMuted, fontWeight: "600" },
});
