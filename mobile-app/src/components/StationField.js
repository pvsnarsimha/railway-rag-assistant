import React, { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import { searchStations } from "../api/railwayApi";

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
    if (!focused || query.length < MIN_QUERY_LEN) {
      setMatches([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const myRequestId = ++requestIdRef.current;
      try {
        const data = await searchStations(apiBaseUrl, { query, topK: 6 });
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
  }, [value, focused, apiBaseUrl]);

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

  const showDropdown = focused && (loading || matches.length > 0 || (value || "").trim().length >= MIN_QUERY_LEN);

  return (
    <View style={[styles.wrap, style]}>
      <Text style={styles.label}>{label}</Text>
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
      />
      {resolvedName ? (
        <Text numberOfLines={1} style={styles.nameLine}>{resolvedName}</Text>
      ) : null}

      {showDropdown ? (
        <View style={styles.dropdown}>
          {loading ? (
            <View style={styles.dropdownRow}>
              <ActivityIndicator size="small" color={colors.orange} />
              <Text style={styles.dropdownMuted}>Searching stations…</Text>
            </View>
          ) : matches.length > 0 ? (
            matches.map((m) => (
              <TouchableOpacity key={m.code} style={styles.dropdownRow} onPress={() => pickMatch(m)}>
                <Text style={styles.dropdownCode}>{m.code}</Text>
                <Text numberOfLines={1} style={styles.dropdownName}>{m.name}</Text>
              </TouchableOpacity>
            ))
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
  wrap: {},
  label: { fontSize: 11, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 2 },
  codeInput: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
    paddingVertical: 2,
  },
  nameLine: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  dropdown: {
    marginTop: spacing.sm,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  dropdownRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  dropdownCode: { fontSize: 12, fontWeight: "700", color: colors.orange, minWidth: 42 },
  dropdownName: { fontSize: 13, color: colors.text, flexShrink: 1 },
  dropdownMuted: { fontSize: 12, color: colors.textMuted, marginLeft: spacing.sm },
});
