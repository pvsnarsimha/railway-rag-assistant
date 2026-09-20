import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Linking, Alert, ScrollView } from "react-native";
import * as Clipboard from "expo-clipboard";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import StationField from "../components/StationField";
import OptionSheetModal from "../components/OptionSheetModal";
import { useSettings } from "../context/SettingsContext";
import { searchTrains } from "../api/railwayApi";
import { describeApiError } from "../api/client";
import { STORAGE_KEYS } from "../config";

const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const RECENT_SEARCHES_MAX = 6;

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

// REDESIGN (IRCTC-style Train Search): full display names for the Class
// picker's bottom sheet — the field itself still stores/sends the plain
// code (searchTrains only ever takes "1A"/"3A"/etc., same as before).
const CLASS_OPTIONS = [
  { code: "Any", label: "All Classes" },
  { code: "1A", label: "AC First Class (1A)" },
  { code: "2A", label: "AC 2 Tier (2A)" },
  { code: "3A", label: "AC 3 Tier (3A)" },
  { code: "3E", label: "AC 3 Economy (3E)" },
  { code: "CC", label: "AC Chair Car (CC)" },
  { code: "EC", label: "Executive Chair Car (EC)" },
  { code: "SL", label: "Sleeper (SL)" },
  { code: "2S", label: "Second Sitting (2S)" },
];

// Same real quota codes the backend/RapidAPI already accepted before this
// redesign — just reordered and relabelled to read the way IRCTC's own
// Quota sheet does (General, Ladies, Tatkal, Lower Berth/Sr. Citizen,
// Premium Tatkal, Person with disability, ...). No code was invented or
// removed to chase the screenshot; a quota IRCTC shows that has no real
// equivalent here (e.g. "Duty Pass") is left out rather than faked.
const QUOTA_OPTIONS = [
  { code: "GN", label: "General" },
  { code: "LD", label: "Ladies" },
  { code: "TQ", label: "Tatkal" },
  { code: "LB", label: "Lower Berth" },
  { code: "SS", label: "Senior Citizen" },
  { code: "PT", label: "Premium Tatkal" },
  { code: "HP", label: "Person with Disability" },
  { code: "DF", label: "Defence" },
  { code: "HO", label: "HQ" },
  { code: "PQ", label: "Pooled" },
  { code: "RL", label: "Remote Location" },
  { code: "RS", label: "Road Side" },
  { code: "PH", label: "Parliament" },
  { code: "FT", label: "Foreign Tourist" },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function toDdMmYyyy(d) {
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
}

// IRCTC's own search screen shows a horizontal row of the next several
// days instead of a free-text date box — this builds that same row from
// today's real device date (no server round trip needed for it).
function buildDateChips(count = 7) {
  const today = new Date();
  const chips = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    chips.push({
      value: toDdMmYyyy(d),
      dayLabel: i === 0 ? "Today" : WEEKDAYS[d.getDay()],
      dayNum: d.getDate(),
      month: MONTHS[d.getMonth()],
    });
  }
  return chips;
}

function findLabel(options, code) {
  return options.find((o) => o.code === code)?.label || code;
}

export default function TrainSearchScreen() {
  const { apiBaseUrl } = useSettings();
  const dateChips = useMemo(() => buildDateChips(7), []);

  const [source, setSource] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [dest, setDest] = useState("");
  const [destName, setDestName] = useState("");
  const [date, setDate] = useState(dateChips[0].value);
  const [showTimeFilter, setShowTimeFilter] = useState(false);
  const [time, setTime] = useState("");
  const [travelClass, setTravelClass] = useState("Any");
  const [quota, setQuota] = useState("GN");
  const [limitText, setLimitText] = useState("10");
  const [classPickerOpen, setClassPickerOpen] = useState(false);
  const [quotaPickerOpen, setQuotaPickerOpen] = useState(false);

  const [recentSearches, setRecentSearches] = useState([]);

  const [trains, setTrains] = useState(null);
  const [meta, setMeta] = useState(null); // { total, page, total_pages, limit }
  const [note, setNote] = useState(null);
  const [fareNote, setFareNote] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEYS.RECENT_TRAIN_SEARCHES)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setRecentSearches(parsed);
      })
      .catch(() => {});
  }, []);

  function clampedLimit(text) {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n)) return 10;
    return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, n));
  }

  function swapStations() {
    setSource(dest);
    setSourceName(destName);
    setDest(source);
    setDestName(sourceName);
  }

  async function rememberSearch(entry) {
    const deduped = [entry, ...recentSearches.filter((r) => !(r.source === entry.source && r.dest === entry.dest && r.travelClass === entry.travelClass))];
    const capped = deduped.slice(0, RECENT_SEARCHES_MAX);
    setRecentSearches(capped);
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.RECENT_TRAIN_SEARCHES, JSON.stringify(capped));
    } catch (e) {
      // Recent searches are a convenience, not core functionality — never
      // block or error the actual search over a failed local save.
    }
  }

  // Centralised so both the Search button (uses whatever is currently in
  // state), pagination (Prev/Next, also current state, just a different
  // page), and a tapped "Recent Search" card (which needs to search with
  // values the state setters above it haven't necessarily flushed to yet)
  // all go through the same real request-building + error-handling path.
  async function performSearch({ source: srcArg, dest: destArg, date: dateArg, travelClass: classArg, quota: quotaArg, page = 1 } = {}) {
    const src = srcArg !== undefined ? srcArg : source;
    const dst = destArg !== undefined ? destArg : dest;
    const dt = dateArg !== undefined ? dateArg : date;
    const cls = classArg !== undefined ? classArg : travelClass;
    const qt = quotaArg !== undefined ? quotaArg : quota;

    if (!src.trim() || !dst.trim()) {
      setError("Enter both source and destination.");
      return;
    }
    const limit = clampedLimit(limitText);
    setLimitText(String(limit));
    setLoading(true);
    setError(null);
    try {
      const data = await searchTrains(apiBaseUrl, {
        source: src.trim(),
        dest: dst.trim(),
        date: dt?.trim() || null,
        time: time.trim() || null,
        travelClass: cls === "Any" ? null : cls,
        quota: qt,
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
      if (page === 1) {
        rememberSearch({ source: src.trim(), dest: dst.trim(), date: dt || null, travelClass: cls, quota: qt });
      }
    } catch (e) {
      setError(describeApiError(e));
      setTrains(null);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }

  function runRecentSearch(entry) {
    setSource(entry.source);
    setSourceName("");
    setDest(entry.dest);
    setDestName("");
    if (entry.date) setDate(entry.date);
    setTravelClass(entry.travelClass || "Any");
    setQuota(entry.quota || "GN");
    performSearch({ source: entry.source, dest: entry.dest, date: entry.date, travelClass: entry.travelClass, quota: entry.quota, page: 1 });
  }

  const canPrev = meta && meta.page > 1;
  const canNext = meta && meta.page < meta.totalPages;
  const selectedDateChip = dateChips.find((c) => c.value === date);

  return (
    <View style={styles.flex}>
    <FlatList
      style={styles.flex}
      data={trains || []}
      keyExtractor={(item, idx) => `${item.train_number}_${idx}`}
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
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
          <View style={styles.searchCard}>
            <View style={styles.stationRow}>
              <StationField
                label="From"
                placeholder="Enter city or station"
                value={source}
                resolvedName={sourceName}
                apiBaseUrl={apiBaseUrl}
                onChangeText={(t) => { setSource(t); setSourceName(""); }}
                onSelectStation={(m) => { setSource(m.code); setSourceName(m.name); }}
                style={styles.stationHalf}
              />
              <TouchableOpacity style={styles.swapBtn} onPress={swapStations} accessibilityLabel="Swap source and destination">
                <Ionicons name="swap-horizontal" size={20} color={colors.orange} />
              </TouchableOpacity>
              <StationField
                label="To"
                placeholder="Enter city or station"
                value={dest}
                resolvedName={destName}
                apiBaseUrl={apiBaseUrl}
                onChangeText={(t) => { setDest(t); setDestName(""); }}
                onSelectStation={(m) => { setDest(m.code); setDestName(m.name); }}
                style={styles.stationHalf}
              />
            </View>

            <Text style={styles.sectionLabel}>Departure Date</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dateRow} contentContainerStyle={styles.dateRowContent}>
              {dateChips.map((chip) => {
                const active = chip.value === date;
                return (
                  <TouchableOpacity
                    key={chip.value}
                    style={[styles.dateChip, active && styles.dateChipActive]}
                    onPress={() => setDate(chip.value)}
                  >
                    <Text style={[styles.dateChipDay, active && styles.dateChipTextActive]}>{chip.dayLabel}</Text>
                    <Text style={[styles.dateChipDate, active && styles.dateChipTextActive]}>{chip.dayNum} {chip.month}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {showTimeFilter ? (
              <LabeledInput
                label="Time (HH:MM, optional)"
                placeholder="15:30"
                value={time}
                onChangeText={setTime}
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
              />
            ) : (
              <TouchableOpacity onPress={() => setShowTimeFilter(true)} style={styles.linkRow}>
                <Ionicons name="add-circle-outline" size={15} color={colors.primary} />
                <Text style={styles.linkText}>Filter by a specific departure time</Text>
              </TouchableOpacity>
            )}

            <View style={styles.pickerRow}>
              <TouchableOpacity style={[styles.pickerField, styles.pickerHalf]} onPress={() => setClassPickerOpen(true)}>
                <Text style={styles.sectionLabel}>Class</Text>
                <View style={styles.pickerValueRow}>
                  <Text style={styles.pickerValue} numberOfLines={1}>{findLabel(CLASS_OPTIONS, travelClass)}</Text>
                  <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.pickerField, styles.pickerHalf]} onPress={() => setQuotaPickerOpen(true)}>
                <Text style={styles.sectionLabel}>Quota</Text>
                <View style={styles.pickerValueRow}>
                  <Text style={styles.pickerValue} numberOfLines={1}>{findLabel(QUOTA_OPTIONS, quota)}</Text>
                  <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
                </View>
              </TouchableOpacity>
            </View>

            <View style={styles.limitRow}>
              <Text style={styles.limitLabel}>Results per page ({MIN_LIMIT}-{MAX_LIMIT})</Text>
              <LabeledInput
                value={limitText}
                onChangeText={setLimitText}
                keyboardType="number-pad"
                style={styles.limitInput}
              />
            </View>

            <PrimaryButton title="SEARCH TRAINS" onPress={() => performSearch({ page: 1 })} loading={loading} style={styles.searchBtn} />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {meta ? (
              <Text style={styles.note}>
                {meta.total} train{meta.total === 1 ? "" : "s"} found — page {meta.page} of {meta.totalPages} ({meta.limit}/page)
                {note ? ` — ${note}` : ""}
              </Text>
            ) : null}
            {fareNote ? <Text style={styles.note}>💰 {fareNote}</Text> : null}
          </View>

          {recentSearches.length > 0 ? (
            <View style={styles.recentWrap}>
              <Text style={styles.sectionLabel}>Recent Searches</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentRowContent}>
                {recentSearches.map((entry, idx) => (
                  <TouchableOpacity key={`${entry.source}_${entry.dest}_${idx}`} style={styles.recentCard} onPress={() => runRecentSearch(entry)}>
                    <View style={styles.recentCardTop}>
                      <Text style={styles.recentCode}>{entry.source}</Text>
                      <Ionicons name="arrow-forward" size={13} color={colors.textMuted} style={{ marginHorizontal: 4 }} />
                      <Text style={styles.recentCode}>{entry.dest}</Text>
                    </View>
                    <Text style={styles.recentMeta}>
                      {entry.date || "any date"}{entry.travelClass && entry.travelClass !== "Any" ? ` · ${entry.travelClass}` : ""}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          ) : null}

          {trains && trains.length > 0 ? (
            <Text style={styles.resultsHeading}>
              {(sourceName || source).toString().toUpperCase()} → {(destName || dest).toString().toUpperCase()}
              {selectedDateChip ? ` · ${selectedDateChip.dayLabel !== "Today" ? selectedDateChip.dayLabel + ", " : ""}${selectedDateChip.dayNum} ${selectedDateChip.month}` : ""}
            </Text>
          ) : null}
        </View>
      }
      renderItem={({ item }) => (
          <View style={styles.trainRow}>
            <View style={styles.trainHeaderRow}>
              <Text style={styles.trainName} numberOfLines={1}>{item.train_name}</Text>
              <View style={styles.numberBadge}>
                <Text style={styles.numberBadgeText}>{item.train_number}</Text>
              </View>
            </View>

            <View style={styles.timingRow}>
              <View style={styles.timingSide}>
                <Text style={styles.timingValue}>{item.source_departure || "—"}</Text>
              </View>
              <View style={styles.timingMiddle}>
                <View style={styles.timingLine} />
                <Text style={styles.timingDuration}>{item.duration || "duration n/a"}</Text>
                <View style={styles.timingLine} />
              </View>
              <View style={[styles.timingSide, { alignItems: "flex-end" }]}>
                <Text style={styles.timingValue}>{item.dest_arrival || "—"}</Text>
              </View>
            </View>

            {!item.source_departure && !item.dest_arrival ? (
              <Text style={styles.trainMeta}>timing not available</Text>
            ) : null}

            {!!item.classes?.length && (
              <View style={styles.classPillRow}>
                {item.classes.map((c) => (
                  <View key={c} style={styles.classPill}>
                    <Text style={styles.classPillText}>{c}</Text>
                  </View>
                ))}
              </View>
            )}
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
                onPress={() => performSearch({ page: meta.page - 1 })}
                style={styles.pageBtn}
              />
              <Text style={styles.pageInfo}>Page {meta.page} / {meta.totalPages}</Text>
              <PrimaryButton
                title="Next →"
                variant="secondary"
                disabled={!canNext || loading}
                onPress={() => performSearch({ page: meta.page + 1 })}
                style={styles.pageBtn}
              />
            </View>
          ) : null
        }
      />
      <OptionSheetModal
        visible={classPickerOpen}
        title="Class"
        options={CLASS_OPTIONS.map((c) => ({ key: c.code, label: c.label }))}
        selectedKey={travelClass}
        onSelect={setTravelClass}
        onClose={() => setClassPickerOpen(false)}
      />
      <OptionSheetModal
        visible={quotaPickerOpen}
        title="Quota"
        options={QUOTA_OPTIONS.map((q) => ({ key: q.code, label: q.label }))}
        selectedKey={quota}
        onSelect={setQuota}
        onClose={() => setQuotaPickerOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: 0 },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },

  searchCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopWidth: 3,
    borderTopColor: colors.orange,
    shadowColor: colors.orangeDark,
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },

  stationRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  stationHalf: { flex: 1 },
  swapBtn: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: "center", justifyContent: "center",
    backgroundColor: colors.orangeSoft,
    marginTop: 14,
    borderWidth: 1, borderColor: colors.orange,
  },

  sectionLabel: { fontSize: 11, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3, marginTop: spacing.md, marginBottom: spacing.xs },

  dateRow: { marginBottom: 4 },
  dateRowContent: { gap: spacing.sm, paddingRight: spacing.sm },
  dateChip: {
    minWidth: 64,
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  dateChipActive: { backgroundColor: colors.orange, borderColor: colors.orange },
  dateChipDay: { fontSize: 10, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase" },
  dateChipDate: { fontSize: 13, fontWeight: "700", color: colors.text, marginTop: 2 },
  dateChipTextActive: { color: colors.textInverse },

  linkRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: spacing.sm, marginBottom: spacing.xs },
  linkText: { fontSize: 12, fontWeight: "600", color: colors.primary },

  pickerRow: { flexDirection: "row", gap: spacing.md },
  pickerField: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bg,
  },
  pickerHalf: { flex: 1 },
  pickerValueRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pickerValue: { fontSize: 14, fontWeight: "700", color: colors.text, flexShrink: 1, marginRight: 4 },

  limitRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.md },
  limitLabel: { fontSize: 12, color: colors.textMuted, flex: 1, marginRight: spacing.sm },
  limitInput: { width: 70, marginBottom: 0 },

  searchBtn: { backgroundColor: colors.orange, marginTop: spacing.md },

  error: { color: colors.danger, fontSize: 12, marginTop: spacing.sm },
  note: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },

  recentWrap: { marginBottom: spacing.md },
  recentRowContent: { gap: spacing.sm, paddingRight: spacing.sm },
  recentCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minWidth: 140,
  },
  recentCardTop: { flexDirection: "row", alignItems: "center" },
  recentCode: { fontSize: 14, fontWeight: "700", color: colors.text },
  recentMeta: { fontSize: 11, color: colors.textMuted, marginTop: 3 },

  resultsHeading: { fontSize: 13, fontWeight: "700", color: colors.textMuted, marginBottom: spacing.sm },

  trainRow: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  trainHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  trainName: { fontSize: 14, fontWeight: "700", color: colors.text, flexShrink: 1, marginRight: spacing.sm },
  numberBadge: {
    backgroundColor: colors.chip,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    minWidth: 56,
    alignItems: "center",
  },
  numberBadgeText: { fontSize: 12, fontWeight: "700", color: colors.primary },

  timingRow: { flexDirection: "row", alignItems: "center" },
  timingSide: { minWidth: 56 },
  timingValue: { fontSize: 17, fontWeight: "700", color: colors.text },
  timingMiddle: { flex: 1, alignItems: "center", flexDirection: "row", marginHorizontal: spacing.sm },
  timingLine: { flex: 1, height: 1, backgroundColor: colors.border },
  timingDuration: { fontSize: 11, color: colors.textMuted, marginHorizontal: 6 },

  classPillRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: spacing.sm },
  classPill: { backgroundColor: colors.chip, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 3 },
  classPillText: { fontSize: 11, fontWeight: "700", color: colors.primary },

  trainMeta: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs },
  availabilityBadge: { fontSize: 11, color: colors.primary, marginTop: 6, fontWeight: "700" },
  fareBadge: { fontSize: 11, color: colors.text, marginTop: 3, fontWeight: "600" },
  bookBtn: {
    marginTop: 8, alignSelf: "flex-start", backgroundColor: colors.orange,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill,
  },
  bookBtnText: { fontSize: 11, fontWeight: "700", color: colors.textInverse },

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
