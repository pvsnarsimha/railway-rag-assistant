import React, { useState, useMemo, useEffect } from "react";
import { View, StyleSheet, FlatList, TouchableOpacity, ScrollView, Linking, ActivityIndicator } from "react-native";
import { Text, TextInput, Alert } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { colors, spacing, radius } from "../theme/colors";
import PrimaryButton from "../components/PrimaryButton";
import StationField from "../components/StationField";
import OptionSheetModal from "../components/OptionSheetModal";
import DateStrip from "../components/DateStrip";
import HandsFreeBar from "../components/HandsFreeBar";
import useHandsFreeForm from "../hooks/useHandsFreeForm";
import { resolveSpokenStation } from "../utils/voiceResolve";
import MonthCalendarModal from "../components/MonthCalendarModal";
import FilterSheetModal from "../components/FilterSheetModal";
import RunningDaysRow from "../components/RunningDaysRow";
import ClassAvailabilityChip from "../components/ClassAvailabilityChip";
import { useSettings } from "../context/SettingsContext";
import { searchTrains } from "../api/railwayApi";
import { describeApiError } from "../api/client";
import { openIrctc } from "../utils/irctc";
import { fromDdMmYyyy, formatLongLabel, hhmmToMinutes, addDays, monthShort } from "../utils/dateFormat";

const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

// Booking is a real hand-off to the IRCTC app/site — see utils/irctc.js.
const bookOnIrctc = openIrctc;

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

export default function TrainSearchScreen({ route }) {
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

  // From / To typed on the Home screen: prefill them and search straight away.
  const homeParams = route && route.params;
  useEffect(() => {
    if (!homeParams || !homeParams.source || !homeParams.dest) return;
    setSource(homeParams.source); setDest(homeParams.dest);
    setSourceName(homeParams.sourceName || null); setDestName(homeParams.destName || null);
    runSearch(1, { source: homeParams.source, dest: homeParams.dest });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeParams && homeParams.nonce]);

  function toggleTatkal() {
    const next = quota === "TQ" ? "GN" : "TQ";
    setQuota(next);
    if (formCollapsed) runSearch(1, { quota: next });
  }

  function pickDate(ddmmyyyy) {
    setDate(ddmmyyyy);
    if (formCollapsed) runSearch(1, { date: ddmmyyyy });
  }

  // HANDS-FREE: asks From, To and the date by voice, then searches.
  // (A date without a year means this year — see utils/voiceParse.js.)
  const hf = useHandsFreeForm({
    autoStart: !formCollapsed,
    steps: [
      { key: "from", ask: "Which station are you travelling from?", kind: "station", resolve: (v) => resolveSpokenStation(apiBaseUrl, v),
        apply: (st) => { setSource(st.code); setSourceName(st.name); }, confirm: (st) => `From ${st.name || st.code}` },
      { key: "to", ask: "And where to?", kind: "station", resolve: (v) => resolveSpokenStation(apiBaseUrl, v),
        apply: (st) => { setDest(st.code); setDestName(st.name); }, confirm: (st) => `To ${st.name || st.code}` },
      { key: "date", ask: "Which date? Say skip for any date.", kind: "date", optional: true,
        apply: (d) => setDate(d), confirm: (d) => `Searching trains on ${d}` },
    ],
    onDone: () => runSearch(1),
  });

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
          <View style={styles.headerGlow} pointerEvents="none" />
          <TouchableOpacity onPress={() => setFormCollapsed(false)} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={20} color={colors.textInverse} />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text numberOfLines={1} style={styles.headerRoute}>
              {source.trim().toUpperCase()} <Text style={styles.headerArrow}>→</Text> {dest.trim().toUpperCase()}
            </Text>
            <Text numberOfLines={1} style={styles.headerDate}>
              {headerDateLabel} · {travelClass === "Any" ? "All classes" : travelClass} · {QUOTA_OPTIONS.find((q) => q.key === quota)?.label || quota}
            </Text>
            {sourceName || destName ? (
              <Text numberOfLines={1} style={styles.headerNames}>
                {sourceName || source} → {destName || dest}
              </Text>
            ) : null}
          </View>
        </View>
      ) : (
        // Search-form hero — same orange as the results header so the whole
        // flow reads as one "booking" surface (see colors.js orange tokens).
        <View style={[styles.header, styles.heroHeader]}>
          <View style={styles.headerGlow} pointerEvents="none" />
          <Text style={styles.heroTitle}>Trains Between Stations</Text>
          <Text style={styles.heroSub}>Plan your journey · live availability</Text>
        </View>
      )}

      <FlatList
        style={styles.flex}
        keyboardShouldPersistTaps="handled"
        // Gated on formCollapsed (not just "do we have trains") so a
        // result set that's already in state can never render underneath
        // the still-open search form — the two must only ever be visible
        // one at a time, matching the toolbar/orange-header switch below.
        data={formCollapsed ? filteredTrains : []}
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
              <>
                <HandsFreeBar hf={hf} />
                {/* From / To — stacked in one card with a round swap button,
                    same StationField auto-suggest as before. */}
                <View style={[styles.formCard, styles.stationCard]}>
                  <StationField
                    label="From" placeholder="e.g. NDLS or Delhi" icon="radio-button-on-outline"
                    value={source} resolvedName={sourceName}
                    onChangeText={(t) => { setSource(t); setSourceName(null); }}
                    onSelectStation={(m) => { setSource(m.code); setSourceName(m.name); }}
                    apiBaseUrl={apiBaseUrl} style={styles.stationField}
                  />
                  <View style={styles.stationDividerRow}>
                    <View style={styles.stationDivider} />
                    <TouchableOpacity
                      style={styles.swapBtn}
                      activeOpacity={0.7}
                      onPress={() => {
                        const s = source, sn = sourceName, d = dest, dn = destName;
                        setSource(d); setSourceName(dn);
                        setDest(s); setDestName(sn);
                      }}
                    >
                      <Ionicons name="swap-vertical" size={18} color={colors.orange} />
                    </TouchableOpacity>
                  </View>
                  <StationField
                    label="To" placeholder="e.g. BCT or Mumbai" icon="flag-outline"
                    value={dest} resolvedName={destName}
                    onChangeText={(t) => { setDest(t); setDestName(null); }}
                    onSelectStation={(m) => { setDest(m.code); setDestName(m.name); }}
                    apiBaseUrl={apiBaseUrl} style={styles.stationField}
                  />
                </View>

                <View style={styles.formCard}>
                  <View style={styles.cardHeadRow}>
                    <Text style={styles.cardLabel}>Journey date</Text>
                    <TouchableOpacity style={styles.calendarLink} onPress={() => setCalendarVisible(true)}>
                      <Ionicons name="calendar-outline" size={14} color={colors.orange} />
                      <Text numberOfLines={1} style={styles.calendarLinkText}>
                        {selectedDateObj ? formatLongLabel(selectedDateObj) : "Any date"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <DateStrip selected={date} onSelect={pickDate} />
                </View>

                <View style={[styles.formCard, styles.row]}>
                  <TouchableOpacity style={styles.half} onPress={() => setClassModalVisible(true)}>
                    <Text style={styles.cardLabel}>Class</Text>
                    <View style={styles.pickerValueRow}>
                      <Text numberOfLines={1} style={styles.pickerValue}>{classLabel(travelClass)}</Text>
                      <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
                    </View>
                  </TouchableOpacity>
                  <View style={styles.vDivider} />
                  <TouchableOpacity style={styles.half} onPress={() => setQuotaModalVisible(true)}>
                    <Text style={styles.cardLabel}>Quota</Text>
                    <View style={styles.pickerValueRow}>
                      <Text numberOfLines={1} style={styles.pickerValue}>{quotaLabel(quota)}</Text>
                      <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
                    </View>
                  </TouchableOpacity>
                </View>

                <View style={[styles.formCard, styles.limitRow]}>
                  <Text style={styles.limitLabel}>Results per page ({MIN_LIMIT}-{MAX_LIMIT})</Text>
                  <TextInput
                    style={styles.limitInput}
                    placeholder={String(DEFAULT_LIMIT)}
                    placeholderTextColor={colors.textMuted}
                    value={limitText}
                    onChangeText={setLimitText}
                    keyboardType="number-pad"
                  />
                </View>

                <TouchableOpacity
                  style={[styles.searchBtn, loading && styles.searchBtnDisabled]}
                  onPress={() => runSearch(1)}
                  disabled={loading}
                  activeOpacity={0.85}
                >
                  {loading ? (
                    <ActivityIndicator color={colors.textInverse} />
                  ) : (
                    <Text style={styles.searchBtnText}>Search Trains →</Text>
                  )}
                </TouchableOpacity>
                {error ? <Text style={styles.error}>{error}</Text> : null}
              </>
            ) : (
              <>
                {/* Toolbar — Sort By / Tatkal / calendar / filter, then in-results
                    search. Two fixed rows (not a sideways scroll) so Sort / Tatkal /
                    Calendar / Filter are always on screen, even with longer
                    translated labels on narrow phones. */}
                <View style={styles.toolbar}>
                  <View style={styles.toolbarRow}>
                    <TouchableOpacity style={styles.toolbarBtn} onPress={() => setSortModalVisible(true)}>
                      <Ionicons name="swap-vertical" size={14} color={colors.orange} />
                      <Text style={[styles.toolbarBtnText, styles.toolbarBtnTextAccent]}>
                        Sort: {SORT_OPTIONS.find((o) => o.key === sortBy)?.label.replace(/ Time$| \(.*\)$/, "") || "Departure"}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.toolbarBtn, quota === "TQ" && styles.toolbarBtnActive]}
                      onPress={toggleTatkal}
                    >
                      <Text style={[styles.toolbarBtnText, quota === "TQ" && styles.toolbarBtnTextActive]}>Tatkal</Text>
                      <View style={[styles.radio, quota === "TQ" && styles.radioOn]} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.iconBtn} onPress={() => setCalendarVisible(true)}>
                      <Ionicons name="calendar-outline" size={16} color={colors.text} />
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.toolbarBtn, activeFilterCount > 0 && styles.toolbarBtnActive]} onPress={() => setFilterVisible(true)}>
                      <Ionicons name="options-outline" size={14} color={activeFilterCount > 0 ? colors.textInverse : colors.orange} />
                      <Text style={[styles.toolbarBtnText, activeFilterCount > 0 ? styles.toolbarBtnTextActive : styles.toolbarBtnTextAccent]}>
                        Filter{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <View style={[styles.resultSearchBox, styles.resultSearchBoxFull]}>
                    <Ionicons name="search" size={13} color={colors.textMuted} />
                    <TextInput
                      style={styles.resultSearchInput}
                      value={resultQuery}
                      onChangeText={setResultQuery}
                      placeholder="Train name/number"
                      placeholderTextColor={colors.textMuted}
                    />
                    <Text style={styles.resultSearchCount}>{meta?.total ?? trains?.length ?? 0} trains</Text>
                  </View>
                </View>

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
          // Compact "28 Sep" under each time — the header already carries the full date.
          const shortDate = (d) => `${d.getDate()} ${monthShort(d)}`;
          const arrivalDateLabel = selectedDateObj
            ? shortDate(wrapsToNextDay ? addDays(selectedDateObj, 1) : selectedDateObj)
            : null;
          const departureDateLabel = selectedDateObj ? shortDate(selectedDateObj) : null;

          return (
            <View style={styles.trainCard}>
              <View style={styles.trainHeaderRow}>
                <Text numberOfLines={1} style={styles.trainName}>
                  <Text style={styles.trainNumber}>{item.train_number} </Text>
                  {item.train_name}
                </Text>
              </View>
              <RunningDaysRow runningDays={item.running_days} />

              <View style={styles.timingRow}>
                <View style={styles.timingCol}>
                  <Text style={styles.timeText}>{item.source_departure || "--:--"}</Text>
                  <Text numberOfLines={1} style={styles.dateSubText}>
                    {source.trim().toUpperCase()}{departureDateLabel ? ` · ${departureDateLabel}` : ""}
                  </Text>
                </View>
                <View style={styles.timingMid}>
                  <Text style={styles.durationText}>{item.duration || "duration n/a"}</Text>
                  <View style={styles.timingLine} />
                </View>
                <View style={[styles.timingCol, { alignItems: "flex-end" }]}>
                  <Text style={styles.timeText}>{item.dest_arrival || "--:--"}</Text>
                  <Text numberOfLines={1} style={styles.dateSubText}>
                    {dest.trim().toUpperCase()}{arrivalDateLabel ? ` · ${arrivalDateLabel}` : ""}
                  </Text>
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
                      fare={cls === travelClass ? item.fare : null}
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
                <Ionicons name="ticket-outline" size={14} color={colors.orange} />
                <Text style={styles.bookBtnText}>Book on IRCTC</Text>
              </TouchableOpacity>
            </View>
          );
        }}
        ListEmptyComponent={
          formCollapsed && trains ? <Text style={styles.emptyText}>No trains to show.</Text> : null
        }
        ListFooterComponent={
          formCollapsed && meta && meta.totalPages > 1 ? (
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

const CARD_SHADOW = {
  shadowColor: "#1A2233",
  shadowOpacity: 0.07,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 2,
};

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: 0 },
  row: { flexDirection: "row", gap: spacing.md },
  half: { flex: 1, minWidth: 0 },
  listContent: { paddingBottom: spacing.xl },
  error: { color: colors.danger, fontSize: 13, fontWeight: "600", marginTop: spacing.sm, textAlign: "center" },
  note: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm, lineHeight: 17 },

  // --- search form ---
  formCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...CARD_SHADOW,
  },
  stationCard: { paddingVertical: spacing.md },
  stationField: { width: "100%" },
  stationDividerRow: { flexDirection: "row", alignItems: "center", marginVertical: 2 },
  stationDivider: { flex: 1, height: 1, backgroundColor: colors.border },
  swapBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFF3EA",
    borderWidth: 1.5,
    borderColor: colors.orange,
    marginLeft: spacing.sm,
  },
  cardHeadRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  cardLabel: { fontSize: 10, fontWeight: "800", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 },
  calendarLink: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, marginBottom: 4 },
  calendarLinkText: { fontSize: 12, fontWeight: "700", color: colors.orange },
  pickerValueRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  pickerValue: { fontSize: 15, fontWeight: "800", color: colors.text, flexShrink: 1 },
  vDivider: { width: 1, backgroundColor: colors.border, alignSelf: "stretch" },
  limitRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing.md },
  limitLabel: { fontSize: 13, fontWeight: "700", color: colors.textMuted, flex: 1 },
  limitInput: {
    width: 64,
    textAlign: "center",
    fontSize: 15,
    fontWeight: "800",
    color: colors.text,
    backgroundColor: "#F1F3F7",
    borderRadius: radius.sm,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  searchBtn: {
    backgroundColor: colors.orange,
    borderRadius: radius.lg,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    shadowColor: colors.orange,
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 5,
  },
  searchBtnDisabled: { opacity: 0.6 },
  searchBtnText: { color: colors.textInverse, fontSize: 17, fontWeight: "800", letterSpacing: 0.3 },

  // --- orange header (form hero + results) ---
  header: {
    backgroundColor: colors.orange,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
    overflow: "hidden",
  },
  // A lighter wash in the top-left corner stands in for the diagonal
  // headerGradientFrom → headerGradientTo gradient (no gradient lib).
  headerGlow: {
    position: "absolute",
    top: -80,
    left: -60,
    width: 240,
    height: 200,
    borderRadius: 120,
    backgroundColor: colors.headerGradientFrom,
    opacity: 0.7,
  },
  heroHeader: { flexDirection: "column", alignItems: "flex-start", gap: 2, paddingTop: spacing.lg },
  heroTitle: { color: colors.textInverse, fontSize: 22, fontWeight: "800", letterSpacing: 0.2 },
  heroSub: { color: "#FFE3D2", fontSize: 13, fontWeight: "600" },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  headerTextWrap: { flex: 1, minWidth: 0 },
  headerRoute: { color: colors.textInverse, fontWeight: "800", fontSize: 22, letterSpacing: 0.5 },
  headerArrow: { color: "#FFE3D2", fontWeight: "700" },
  headerDate: { color: "#FFE3D2", fontSize: 13, fontWeight: "600", marginTop: 2 },
  headerNames: { color: "rgba(255,255,255,0.75)", fontSize: 11, marginTop: 2 },

  // --- results toolbar ---
  toolbar: {
    padding: 8,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
    ...CARD_SHADOW,
  },
  toolbarContent: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8 },
  toolbarRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8 },
  toolbarBtn: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#F5F6F9" },
  toolbarBtnActive: { backgroundColor: colors.orange },
  toolbarBtnText: { fontSize: 12, fontWeight: "800", color: colors.text },
  toolbarBtnTextAccent: { color: colors.orange },
  toolbarBtnTextActive: { color: colors.textInverse },
  radio: { width: 11, height: 11, borderRadius: 6, borderWidth: 1.5, borderColor: colors.textMuted },
  radioOn: { borderColor: colors.textInverse, backgroundColor: colors.textInverse },
  resultSearchBox: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: "#F5F6F9", minWidth: 150 },
  resultSearchBoxFull: { minWidth: 0, width: "100%" },
  resultSearchInput: { fontSize: 12, color: colors.text, flex: 1, padding: 0 },
  resultSearchCount: { fontSize: 11, color: colors.text, fontWeight: "800" },
  iconBtn: { borderRadius: radius.pill, padding: 7, backgroundColor: "#F5F6F9" },

  summaryRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.xs, marginBottom: spacing.xs },
  summaryText: { fontSize: 12, color: colors.textMuted, fontWeight: "700", flexShrink: 1 },
  modifyLink: { fontSize: 12, color: colors.orange, fontWeight: "800" },

  // --- train result card ---
  trainCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    ...CARD_SHADOW,
  },
  trainHeaderRow: { flexDirection: "row", alignItems: "center" },
  trainName: { fontSize: 15, fontWeight: "800", color: colors.text, flexShrink: 1 },
  trainNumber: { fontSize: 15, fontWeight: "800", color: colors.text },
  trainMeta: { fontSize: 11, color: colors.textMuted, marginTop: 4 },

  timingRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.md, marginBottom: spacing.md },
  timingCol: { minWidth: 64, maxWidth: "38%" },
  timeText: { fontSize: 22, fontWeight: "800", color: colors.text, letterSpacing: 0.3 },
  dateSubText: { fontSize: 10, fontWeight: "600", color: colors.textMuted, marginTop: 2 },
  timingMid: { flex: 1, alignItems: "center", paddingHorizontal: spacing.sm },
  timingLine: { borderTopWidth: 1.5, borderStyle: "dashed", borderColor: "#C9CFDA", width: "100%", marginTop: 4, height: 0 },
  durationText: { fontSize: 11, color: colors.textMuted, fontWeight: "700" },

  classRow: { marginBottom: spacing.xs },
  availabilityBadge: { fontSize: 11, color: colors.primary, marginTop: 6, fontWeight: "800" },
  fareBadge: { fontSize: 11, color: colors.textMuted, marginTop: 4, fontWeight: "600" },
  bookBtn: {
    marginTop: spacing.md,
    alignSelf: "flex-end",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1.5,
    borderColor: colors.orange,
    backgroundColor: "#FFF3EA",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  bookBtnText: { fontSize: 12, fontWeight: "800", color: colors.orange },

  emptyText: { textAlign: "center", color: colors.textMuted, marginTop: spacing.lg, fontWeight: "600" },
  pagination: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.md,
    marginBottom: spacing.lg,
    marginHorizontal: spacing.lg,
  },
  pageBtn: { flex: 0, paddingHorizontal: spacing.lg },
  pageInfo: { fontSize: 13, color: colors.textMuted, fontWeight: "700" },
});
