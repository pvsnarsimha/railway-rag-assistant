import React, { useEffect, useRef, useState } from "react";
import { View, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, ScrollView } from "react-native";
import { Text, TextInput } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import { searchStations, suggestStations } from "../api/railwayApi";
import MicButton from "./MicButton";

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 300;

/**
 * IRCTC-style "From"/"To" box with a live auto-suggest dropdown — as the
 * user types, this calls the same /api/stations/search endpoint that
 * powers the dedicated Station Search tool (see StationSearchScreen.js)
 * and shows the real matches (station code + name), rather than a
 * fabricated static list. Tapping a suggestion fills the field with that
 * station's real code, which is exactly what searchTrains already expects.
 *
 * `value` is the raw text the user is searching with; `resolvedName`,
 * when set, is the full station name of whatever was last selected (or
 * of the still-current typed code) and renders as the small line under
 * the big code, the way IRCTC's own box shows "SC / SECUNDERABAD JN".
 */
export default function StationField({
  label,
  placeholder,
  value,
  resolvedName,
  onChangeText,
  onSelectStation,
  apiBaseUrl,
  style,
  icon = "location-outline",
  defaultOptions,
}) {
  const [focused, setFocused] = useState(false);
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);
  const blurTimeoutRef = useRef(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const query = (value || "").trim();
    // A known list (e.g. the reporting stations of the chosen train) is shown
    // as soon as the box is focused and filtered locally while typing.
    if (defaultOptions && defaultOptions.length) {
      const q = query.toLowerCase();
      const local = !q ? defaultOptions : defaultOptions.filter((o) => String(o.code).toLowerCase().includes(q) || String(o.name).toLowerCase().includes(q));
      if (!q || local.length) {
        setMatches(focused ? local : []);
        setLoading(false);
        return;
      }
    }
    if (!focused || query.length < MIN_QUERY_LEN) {
      setMatches([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const myRequestId = ++requestIdRef.current;
      try {
        // Prefix type-ahead first ("vij" -> Vijayawada Jn); the whole-word /
        // semantic search only as a fallback for misspelt or descriptive text.
        let data = await suggestStations(apiBaseUrl, { query, limit: 8 });
        if (!(data.matches || []).length && query.length >= 3) {
          data = await searchStations(apiBaseUrl, { query, topK: 6 });
        }
        if (myRequestId !== requestIdRef.current) return; // a newer keystroke already superseded this call
        setMatches(data.matches || []);
      } catch (e) {
        if (myRequestId === requestIdRef.current) setMatches([]);
      } finally {
        if (myRequestId === requestIdRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused, apiBaseUrl, defaultOptions]);

  useEffect(() => () => clearTimeout(blurTimeoutRef.current), []);

  function handleFocus() {
    clearTimeout(blurTimeoutRef.current);
    setFocused(true);
  }

  function handleBlur() {
    // Delay hiding the dropdown so a tap on a suggestion (which blurs the
    // TextInput first) still lands before the list disappears.
    blurTimeoutRef.current = setTimeout(() => setFocused(false), 150);
  }

  function pickMatch(match) {
    clearTimeout(blurTimeoutRef.current);
    setFocused(false);
    setMatches([]);
    onSelectStation(match);
  }

  const showDropdown = focused && ((defaultOptions && defaultOptions.length > 0 && !(value || "").trim()) || loading || matches.length > 0 || (value || "").trim().length >= MIN_QUERY_LEN);

  return (
    <View style={[styles.wrap, style]}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.box, focused && styles.boxFocused]}>
        <Ionicons name={icon} size={16} color={focused ? colors.orange : colors.textMuted} style={styles.boxIcon} />
        <View style={styles.boxTextCol}>
          <TextInput
            style={styles.codeInput}
            value={value}
            onChangeText={onChangeText}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder={placeholder}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            numberOfLines={1}
          />
          {resolvedName ? (
            <Text numberOfLines={1} style={styles.nameLine}>{resolvedName}</Text>
          ) : null}
        </View>
        {/* Say the station ("vijayawada" or "v s k p"); the dropdown then offers the real matches. */}
        <MicButton kind="station" onValue={(text) => { setFocused(true); onChangeText(text); }} size={18} style={{ padding: 4 }} />
        {value ? (
          <TouchableOpacity
            onPress={() => { onChangeText(""); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.clearBtn}
          >
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>

      {showDropdown ? (
        <View style={styles.dropdown}>
          {loading ? (
            <View style={styles.dropdownRow}>
              <ActivityIndicator size="small" color={colors.orange} />
              <Text style={styles.dropdownMuted}>Searching stations…</Text>
            </View>
          ) : matches.length > 0 ? (
            <ScrollView style={styles.dropdownScroll} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {matches.map((m) => (
              // On web the input's blur fires on mouse-down and the 150ms
              // blur timer unmounts this list before the click's mouse-up
              // can fire onPress — so the tap was lost. Select on press-in
              // there; native keeps the normal onPress (safe while scrolling).
              <TouchableOpacity
                key={m.code}
                style={styles.dropdownRow}
                onPressIn={Platform.OS === "web" ? () => pickMatch(m) : undefined}
                onPress={() => pickMatch(m)}
              >
                <Text numberOfLines={1} style={styles.dropdownName}>{m.name}</Text>
                <Text style={styles.dropdownCode}>{m.code}</Text>
              </TouchableOpacity>
            ))}
            </ScrollView>
          ) : (
            <View style={styles.dropdownRow}>
              <Text style={styles.dropdownMuted}>No matching stations</Text>
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // NOTE: the suggestion list below is laid out INLINE (pushes the rest of
  // the form down) rather than as an absolutely-positioned overlay. This
  // screen's whole layout is the content of one FlatList (see
  // TrainSearchScreen.js's note on why), and an absolute dropdown escaping
  // its row is exactly the kind of thing that gets clipped or loses its
  // z-index ordering inside a ScrollView/FlatList on Android — inline is
  // the version that's guaranteed to actually show up everywhere.
  // Borderless "FROM / KRNT / Kurnool Town" block — the rounded card
  // around the stacked From/To pair lives in TrainSearchScreen.js; focus
  // is shown with a soft orange wash + left accent bar instead of a box.
  wrap: { minWidth: 0 },
  label: { fontSize: 10, fontWeight: "800", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 },
  box: {
    flexDirection: "row",
    alignItems: "center",
    borderLeftWidth: 3,
    borderLeftColor: "transparent",
    borderRadius: radius.sm,
    paddingLeft: spacing.xs,
    paddingRight: spacing.xs,
    paddingVertical: 2,
    minHeight: 48,
  },
  boxFocused: {
    borderLeftColor: colors.orange,
    backgroundColor: colors.orangeLight,
  },
  boxIcon: { marginRight: 8 },
  boxTextCol: { flex: 1, minWidth: 0 },
  clearBtn: { marginLeft: 4, padding: 2 },
  codeInput: {
    fontSize: 22,
    fontWeight: "800",
    color: colors.text,
    padding: 0,
    letterSpacing: 0.5,
  },
  nameLine: { fontSize: 13, fontWeight: "600", color: colors.textMuted, marginTop: 1 },
  dropdown: {
    marginTop: spacing.sm,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    shadowColor: "#1A2233",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  dropdownScroll: { maxHeight: 280 },
  dropdownRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  dropdownCode: { fontSize: 12.5, fontWeight: "800", color: colors.orange, marginLeft: "auto" },
  dropdownName: { fontSize: 14.5, fontWeight: "700", color: colors.text, flexShrink: 1 },
  dropdownMuted: { fontSize: 12, color: colors.textMuted, marginLeft: spacing.sm },
});
