import React, { useState, useMemo } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, ScrollView, Linking, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import StationField from "../components/StationField";
import OptionSheetModal from "../components/OptionSheetModal";
import DateStrip from "../components/DateStrip";
import MonthCalendarModal from "../components/MonthCalendarModal";
import FilterSheetModal from "../components/FilterSheetModal";
import RunningDaysRow from "../components/RunningDaysRow";
import ClassAvailabilityChip from "../components/ClassAvailabilityChip";
import { useSettings } from "../context/SettingsContext";
import { searchTrains } from "../api/railwayApi";
import { describeApiError } from "../api/client";
import { fromDdMmYyyy, formatLongLabel, hhmmToMinutes, addDays } from "../utils/dateFormat";

const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

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

// Full IRCTC-style names for the Class picker sheet — same codes the
// backend's travel_class filter has always accepted (see app.py's
// TrainSearchRequest docstring), just given the long label IRCTC itself
// shows rather than the bare 2-3 letter code.
const CLASS_OPTIONS = [
  { key: "Any", label: "All Classes" },
  { key: "1A", label: "AC First Class (1A)" },
  { key: "2A", label: "AC 2 Tier (2A)" },
  { key: "3A", label: "AC 3 Tier (3A)" },
  { key: "3E", label: "AC 3 Economy (3E)" },
  { key: "CC", label: "AC Chair car (CC)" },
  { key: "EC", label: "Exec. Chair Car (EC)" },
  { key: "SL", label: "Sleeper (SL)" },
  { key: "2S", label: "Second Sitting (2S)" },
];
const QUOTA_OPTIONS = [
  { key: "GN", label: "General" }, { key: "PQ", label: "Pooled Quota" },
  { key: "RL", label: "Remote Location" }, { key: "RS", label: "Road Side" },
  { key: "TQ", label: "Tatkal" }, { key: "PT", label: "Premium Tatkal" },
  { key: "LD", label: "Ladies" }, { key: "SS", label: "Lower Berth/Sr. Citizen" },
  { key: "HP", label: "Person with Disability" }, { key: "LB", label: "Lower Berth" },
  { key: "DF", label: "Defence" }, { key: "HO", label: "Duty Pass" },
  { key: "PH", label: "Parliament" }, { key: "FT", label: "Foreign Tourist" },
];
const SORT_OPTIONS = [
  { key: "departure", label: "Departure Time" },
  { key: "arrival", label: "Arrival Time" },
  { key: "duration", label: "Duration (shortest first)" },
];

function classLabel(code) {
  return CLASS_OPTIONS.find((c) => c.key === code)?.label || code;
}
function quotaLabel(code) {
  const opt = QUOTA_OPTIONS.find((q) => q.key === code);
  return opt ? `${opt.label} (${opt.key})` : code;
}

export default function TrainSearchScreen() {
  const { apiBaseUrl } = useSettings();

  // --- search form state ---
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [sourceName, setSourceName] = useState(null);
  const [destName, setDestName] = useState(null);
  const [date, setDate] = useState("");
  const [travelClass, setTravelClass] = useState("Any");
  const [quota, setQuota] = useState("GN");
  const [limitText, setLimitText] = useState(String(DEFAULT_LIMIT));

  // --- filters (Filter sheet — real backend fields, previously unwired) ---
  const [filters, setFilters] = useState({
    departureBand: null, arrivalBand: null,
    departureStart: null, departureEnd: null, arrivalStart: null, arrivalEnd: null,
    availableOnly: false, waitlistedOnly: false,
  });

  // --- results state ---
  const [trains, setTrains] = useState(null);
  const [meta, setMeta] = useState(null);
  const [note, setNote] = useState(null);
  const [fareNote, setFareNote] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [formCollapsed, setFormCollapsed] = useState(false);

  // --- toolbar state ---
  const [sortBy, setSortBy] = useState("departure");
  const [resultQuery, setResultQuery] = useState("");
  const [classModalVisible, setClassModalVisible] = useState(false);
  const [quotaModalVisible, setQuotaModalVisible] = useState(false);
  const [sortModalVisible, setSortModalVisible] = useState(false);
  const [calendarVisible, setCalendarVisible] = useState(false);
  const [filterVisible, setFilterVisible] = useState(false);

  function clampedLimit() {
    const n = parseInt(limitText, 10);
    if (!Number.isFinite(n)) return DEFAULT_LIMIT;
    return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, n));
  }

  function sortTrains(list, key) {
    const sorted = [...list];
    if (key === "duration") {
      sorted.sort((a, b) => (a.duration_minutes ?? 1e9) - (b.duration_minutes ?? 1e9));
    } else if (key === "arrival") {
      sorted.sort((a, b) => (hhmmToMinutes(a.dest_arrival) ?? 1e9) - (hhmmToMinutes(b.dest_arrival) ?? 1e9));
    } else {
      sorted.sort((a, b) => (hhmmToMinutes(a.source_departure) ?? 1e9) - (hhmmToMinutes(b.source_departure) ?? 1e9));
    }
    return sorted;
  }

  // `overrides` lets a toolbar action (Tatkal toggle, date strip, filter
  // sheet Apply) pass the field(s) it just changed straight into this
  // call, instead of relying on React state that won't have updated yet
  // inside the same event handler (classic stale-closure trap).
  async function runSearch(page, overrides = {}) {
    const effSource = overrides.source ?? source;
    const effDest = overrides.dest ?? dest;
    const effDate = overrides.date ?? date;
    const effClass = overrides.travelClass ?? travelClass;
    const effQuota = overrides.quota ?? quota;
    const effFilters = overrides.filters ?? filters;

    if (!effSource.trim() || !effDest.trim()) {
      setError("Enter both source and destination.");
      return;
    }
    const limit = clampedLimit();
    setLoading(true);
    setError(null);
    try {
      const data = await searchTrains(apiBaseUrl, {
        source: effSource.trim(),
        dest: effDest.trim(),
        date: effDate.trim() || null,
        travelClass: effClass === "Any" ? null : effClass,
        quota: effQuota,
        departureStart: effFilters.departureStart,
        departureEnd: effFilters.departureEnd,
        arrivalStart: effFilters.arrivalStart,
        arrivalEnd: effFilters.arrivalEnd,
        availableOnly: effFilters.availableOnly,
        waitlistedOnly: effFilters.waitlistedOnly,
        limit,
        page,
      });
      if (data.error && !data.total) {
        setError(data.error);
        setTrains([]);
        setMeta(null);
        // Still switch to the results view (orange header + toolbar) even
        // on a genuine error, same as the rest of this flow — staying on
        // the plain form would bury the error below an unrelated "Search"
        // button instead of showing it where results normally appear.
        setFormCollapsed(true);
        return;
      }
      setTrains(sortTrains(data.trains || [], sortBy));
      setMeta({ total: data.total, page: data.page, totalPages: data.total_pages, limit: data.limit });
      setNote(data.availability_note || data.error || null);
      setFareNote(data.fare_note || null);
      setFormCollapsed(true);
    } catch (e) {
      setError(describeApiError(e));
      setTrains(null);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }

  function applySort(key) {
    setSortBy(key);
    if (trains) setTrains((prev) => sortTrains(prev, key));
  }

  function toggleTatkal() {
    const next = quota === "TQ" ? "GN" : "TQ";
    setQuota(next);
    if (formCollapsed) runSearch(1, { quota: next });
  }

  function pickDate(ddmmyyyy) {
    setDate(ddmmyyyy);
    if (formCollapsed) runSearch(1, { date: ddmmyyyy });
  }

  function applyFilters(next) {
    setFilters(next);
    if (formCollapsed) runSearch(1, { filters: next });
  }

  const selectedDateObj = fromDdMmYyyy(date);
  const headerDateLabel = selectedDateObj ? formatLongLabel(selectedDateObj) : "any date";

  const filteredTrains = useMemo(() => {
    if (!trains) return [];
    const q = resultQuery.trim().toLowerCase();
    if (!q) return trains;
    return trains.filter(
      (t) => t.train_number?.toLowerCase().includes(q) || t.train_name?.toLowerCase().includes(q),
    );
  }, [trains, resultQuery]);

  const canPrev = meta && meta.page > 1;
  const canNext = meta && meta.page < meta.totalPages;
  const activeFilterCount =
    (filters.departureBand ? 1 : 0) + (filters.arrivalBand ? 1 : 0) + (filters.availableOnly ? 1 : 0) + (filters.waitlistedOnly ? 1 : 0);

  return (
    <View style={styles.flex}>
      {formCollapsed ? (
        // IRCTC-style orange results header — a real gradient library isn't
        // in this project's deps, so a solid orange tone stands in for the
        // diagonal gradient in the reference screenshots (see colors.js's
        // headerGradientFrom/To, kept defined for if one gets added later).
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setFormCollapsed(false)} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={colors.textInverse} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text numberOfLines={1} style={styles.headerRoute}>
              {(sourceName || source).toString().toUpperCase()} TO {(destName || dest).toString().toUpperCase()}
            </Text>
            <Text style={styles.headerDate}>{headerDateLabel}</Text>
          </View>
        </View>
      ) : null}

      <FlatList
        style={styles.flex}
        data={filteredTrains}
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
            {!formCollapsed ? (
              <SectionCard
                title="Search trains"
                subtitle="Real-time filter by source, destination, date, class and quota — dropdowns and live suggestions, just like IRCTC."
              >
                <View style={styles.row}>
                  <StationField
                    label="From" placeholder="e.g. NDLS or Delhi"
                    value={source} resolvedName={sourceName}
                    onChangeText={(t) => { setSource(t); setSourceName(null); }}
                    onSelectStation={(m) => { setSource(m.code); setSourceName(m.name); }}
                    apiBaseUrl={apiBaseUrl} style={styles.half}
                  />
                  <StationField
                    label="To" placeholder="e.g. BCT or Mumbai"
                    value={dest} resolvedName={destName}
                    onChangeText={(t) => { setDest(t); setDestName(null); }}
                    onSelectStation={(m) => { setDest(m.code); setDestName(m.name); }}
                    apiBaseUrl={apiBaseUrl} style={styles.half}
                  />
                </View>

                <Text style={styles.fieldLabel}>Departure date</Text>
                <TouchableOpacity style={styles.dateRow} onPress={() => setCalendarVisible(true)}>
                  <Ionicons name="calendar-outline" size={16} color={colors.orange} />
                  <Text style={styles.dateRowText}>
                    {selectedDateObj ? formatLongLabel(selectedDateObj) : "Any date (whole weekly timetable)"}
                  </Text>
                </TouchableOpacity>
                <DateStrip selected={date} onSelect={pickDate} />

                <View style={styles.row}>
                  <TouchableOpacity style={[styles.pickerField, styles.half]} onPress={() => setClassModalVisible(true)}>
                    <Text style={styles.fieldLabel}>Class</Text>
                    <Text style={styles.pickerValue}>{classLabel(travelClass)}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.pickerField, styles.half]} onPress={() => setQuotaModalVisible(true)}>
                    <Text style={styles.fieldLabel}>Quota</Text>
                    <Text style={styles.pickerValue}>{quotaLabel(quota)}</Text>
                  </TouchableOpacity>
                </View>

                <LabeledInput
                  label={`Results per page (${MIN_LIMIT}-${MAX_LIMIT})`}
                  placeholder={String(DEFAULT_LIMIT)}
                  value={limitText}
                  onChangeText={setLimitText}
                  keyboardType="number-pad"
                />
                <PrimaryButton title="Search" onPress={() => runSearch(1)} loading={loading} />
                {error ? <Text style={styles.error}>{error}</Text> : null}
              </SectionCard>
            ) : (
              <>
                {/* Toolbar — Sort By / Tatkal / in-results search / calendar / filter,
                    matching the IRCTC results screen's own top row. */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.toolbar} contentContainerStyle={styles.toolbarContent}>
                  <TouchableOpacity style={styles.toolbarBtn} onPress={() => setSortModalVisible(true)}>
                    <Ionicons name="swap-vertical" size={14} color={colors.text} />
                    <Text style={styles.toolbarBtnText}>Sort By</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.toolbarBtn, quota === "TQ" && styles.toolbarBtnActive]}
                    onPress={toggleTatkal}
                  >
                    <Text style={[styles.toolbarBtnText, quota === "TQ" && styles.toolbarBtnTextActive]}>Tatkal</Text>
                  </TouchableOpacity>
                  <View style={styles.resultSearchBox}>
                    <Ionicons name="search" size={13} color={colors.textMuted} />
                    <TextInput
                      style={styles.resultSearchInput}
                      value={resultQuery}
                      onChangeText={setResultQuery}
                      placeholder="Train name/number"
                      placeholderTextColor={colors.textMuted}
                    />
                    <Text style={styles.resultSearchCount}>({meta?.total ?? trains?.length ?? 0})</Text>
                  </View>
                  <TouchableOpacity style={styles.iconBtn} onPress={() => setCalendarVisible(true)}>
                    <Ionicons name="calendar-outline" size={18} color={colors.text} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.iconBtn} onPress={() => setFilterVisible(true)}>
                    <Ionicons name="filter" size={18} color={colors.text} />
                    {activeFilterCount > 0 ? (
                      <View style={styles.filterBadge}><Text style={styles.filterBadgeText}>{activeFilterCount}</Text></View>
                    ) : null}
                  </TouchableOpacity>
                </ScrollView>

                <DateStrip selected={date} onSelect={pickDate} />

                <View style={styles.summaryRow}>
                  <Text style={styles.summaryText}>
                    {classLabel(travelClass)} · {quotaLabel(quota)}
                  </Text>
                  <TouchableOpacity onPress={() => setFormCollapsed(false)}>
                    <Text style={styles.modifyLink}>Modify search</Text>
                  </TouchableOpacity>
                </View>

                {error ? <Text style={styles.error}>{error}</Text> : null}
                {meta ? (
                  <Text style={styles.note}>
                    {meta.total} train{meta.total === 1 ? "" : "s"} found — page {meta.page} of {meta.totalPages} ({meta.limit}/page)
                    {note ? ` — ${note}` : ""}
                  </Text>
                ) : null}
                {fareNote ? <Text style={styles.note}>💰 {fareNote}</Text> : null}
              </>
            )}
          </View>
        }
        renderItem={({ item }) => {
          const depMin = hhmmToMinutes(item.source_departure);
          const wrapsToNextDay = depMin != null && item.duration_minutes != null && depMin + item.duration_minutes >= 1440;
          const arrivalDateLabel = selectedDateObj
            ? formatLongLabel(wrapsToNextDay ? addDays(selectedDateObj, 1) : selectedDateObj)
            : null;
          const departureDateLabel = selectedDateObj ? formatLongLabel(selectedDateObj) : null;

          return (
            <View style={styles.trainCard}>
              <View style={styles.trainHeaderRow}>
                <Text style={styles.trainName}>{item.train_name}</Text>
                <Text style={styles.trainNumber}>({item.train_number})</Text>
              </View>
              <RunningDaysRow runningDays={item.running_days} />

              <View style={styles.timingRow}>
                <View style={styles.timingCol}>
                  <Text style={styles.timeText}>{item.source_departure || "--:--"}</Text>
                  {departureDateLabel ? <Text style={styles.dateSubText}>{departureDateLabel}</Text> : null}
                </View>
                <View style={styles.timingMid}>
                  <View style={styles.timingLine} />
                  <Text style={styles.durationText}>{item.duration || "duration n/a"}</Text>
                </View>
                <View style={[styles.timingCol, { alignItems: "flex-end" }]}>
                  <Text style={styles.timeText}>{item.dest_arrival || "--:--"}</Text>
                  {arrivalDateLabel ? <Text style={styles.dateSubText}>{arrivalDateLabel}</Text> : null}
                </View>
              </View>

              {!!item.classes?.length && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.classRow}>
                  {item.classes.map((cls) => (
                    <ClassAvailabilityChip
                      key={cls}
                      classCode={cls}
                      trainNumber={item.train_number}
                      source={source.trim()}
                      dest={dest.trim()}
                      date={date.trim()}
                      quota={quota}
                      apiBaseUrl={apiBaseUrl}
                      initialStatusText={cls === travelClass ? item.availability_status : null}
                      onNeedDate={() => {
                        Alert.alert("Pick a date first", "Live availability needs a travel date — pick one from the calendar.", [
                          { text: "Pick date", onPress: () => setCalendarVisible(true) },
                          { text: "Cancel", style: "cancel" },
                        ]);
                      }}
                    />
                  ))}
                </ScrollView>
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
          );
        }}
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

      <OptionSheetModal
        visible={classModalVisible}
        title="Select Class"
        options={CLASS_OPTIONS}
        selectedKey={travelClass}
        onSelect={setTravelClass}
        onClose={() => setClassModalVisible(false)}
      />
      <OptionSheetModal
        visible={quotaModalVisible}
        title="Quota"
        options={QUOTA_OPTIONS}
        selectedKey={quota}
        onSelect={setQuota}
        onClose={() => setQuotaModalVisible(false)}
      />
      <OptionSheetModal
        visible={sortModalVisible}
        title="Sort By"
        options={SORT_OPTIONS}
        selectedKey={sortBy}
        onSelect={applySort}
        onClose={() => setSortModalVisible(false)}
      />
      <MonthCalendarModal
        visible={calendarVisible}
        selected={date}
        onSelect={pickDate}
        onClose={() => setCalendarVisible(false)}
      />
      <FilterSheetModal
        visible={filterVisible}
        initial={filters}
        onApply={applyFilters}
        onClose={() => setFilterVisible(false)}
      />
    </View>
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

  fieldLabel: { fontSize: 11, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4, marginTop: spacing.sm },
  dateRow: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  dateRowText: { fontSize: 13, color: colors.text, fontWeight: "600" },
  pickerField: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginBottom: spacing.md },
  pickerValue: { fontSize: 13, fontWeight: "700", color: colors.text },

  // --- IRCTC-style results header ---
  header: {
    backgroundColor: colors.orange,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  backBtn: { padding: 4 },
  headerTextWrap: { flex: 1 },
  headerRoute: { color: colors.textInverse, fontWeight: "700", fontSize: 15 },
  headerDate: { color: colors.orangeLight, fontSize: 11, marginTop: 2 },

  toolbar: { marginTop: spacing.sm },
  toolbarContent: { flexDirection: "row", alignItems: "center", gap: 8, paddingRight: spacing.md },
  toolbarBtn: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.card },
  toolbarBtnActive: { backgroundColor: colors.orange, borderColor: colors.orange },
  toolbarBtnText: { fontSize: 12, fontWeight: "700", color: colors.text },
  toolbarBtnTextActive: { color: colors.textInverse },
  resultSearchBox: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.card, minWidth: 140 },
  resultSearchInput: { fontSize: 12, color: colors.text, flex: 1, padding: 0 },
  resultSearchCount: { fontSize: 11, color: colors.textMuted, fontWeight: "600" },
  iconBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, padding: 8, backgroundColor: colors.card },
  filterBadge: { position: "absolute", top: -4, right: -4, backgroundColor: colors.orange, borderRadius: radius.pill, minWidth: 16, height: 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  filterBadgeText: { color: colors.textInverse, fontSize: 9, fontWeight: "700" },

  summaryRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.xs, marginBottom: spacing.xs },
  summaryText: { fontSize: 12, color: colors.textMuted, fontWeight: "600" },
  modifyLink: { fontSize: 12, color: colors.orange, fontWeight: "700" },

  // --- train result card ---
  trainCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  trainHeaderRow: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  trainName: { fontSize: 14, fontWeight: "700", color: colors.text, flexShrink: 1 },
  trainNumber: { fontSize: 12, color: colors.textMuted, fontWeight: "600" },
  trainMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },

  timingRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.sm, marginBottom: spacing.sm },
  timingCol: { minWidth: 64 },
  timeText: { fontSize: 18, fontWeight: "700", color: colors.text },
  dateSubText: { fontSize: 10, color: colors.textMuted, marginTop: 1 },
  timingMid: { flex: 1, alignItems: "center", paddingHorizontal: spacing.sm },
  timingLine: { height: 1, backgroundColor: colors.border, width: "100%", marginBottom: 4 },
  durationText: { fontSize: 11, color: colors.textMuted, fontWeight: "600" },

  classRow: { marginBottom: spacing.sm },
  availabilityBadge: { fontSize: 11, color: colors.primary, marginTop: 3, fontWeight: "700" },
  fareBadge: { fontSize: 11, color: colors.text, marginTop: 3, fontWeight: "600" },
  bookBtn: {
    marginTop: 8, alignSelf: "flex-start", backgroundColor: colors.accent,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill,
  },
  bookBtnText: { fontSize: 11, fontWeight: "700", color: colors.primaryDark },

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
