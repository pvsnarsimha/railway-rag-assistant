import React, { useEffect, useRef, useState } from "react";
import { View, TouchableOpacity, ActivityIndicator, StyleSheet, Platform } from "react-native";
import { Text, TextInput } from "../i18n/Localized";
import { colors, spacing, radius } from "../theme/colors";
import { suggestTrains } from "../api/railwayApi";
import MicButton from "./MicButton";

/**
 * Train-number box with a live dropdown, like a search engine's suggestions:
 * type "1" or "17" or "172" and every train whose number starts with that
 * is listed (number, name, route); type a full number like 12706 and only
 * that one train shows; a number that doesn't exist says "No train found".
 * Suggestions come from /api/trains/suggest (real data, never invented).
 */
const DEBOUNCE_MS = 250;

export default function TrainNumberField({ label, placeholder, value, onChangeText, onSelectTrain, apiBaseUrl, style }) {
  const [focused, setFocused] = useState(false);
  const [matches, setMatches] = useState([]);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  const blurRef = useRef(null);

  useEffect(() => {
    const digits = String(value || "").replace(/\D/g, "");
    if (!focused || !digits) { setMatches([]); setNotFound(false); setLoading(false); return undefined; }
    setLoading(true);
    const id = setTimeout(async () => {
      const mine = ++reqRef.current;
      try {
        const data = await suggestTrains(apiBaseUrl, digits);
        if (mine !== reqRef.current) return;
        setMatches(data.matches || []);
        setNotFound(!!data.not_found);
      } catch (e) {
        if (mine === reqRef.current) { setMatches([]); setNotFound(false); }
      } finally {
        if (mine === reqRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [value, focused, apiBaseUrl]);

  useEffect(() => () => clearTimeout(blurRef.current), []);

  const pick = (m) => {
    clearTimeout(blurRef.current);
    setFocused(false);
    setMatches([]);
    onChangeText(m.number);
    if (onSelectTrain) onSelectTrain(m);
  };

  const digits = String(value || "").replace(/\D/g, "");
  const show = focused && digits.length > 0;
  return (
    <View style={[styles.wrap, style]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={styles.inputRow}>
      <TextInput
        style={[styles.input, styles.inputFlex, focused && styles.inputFocused]}
        value={value}
        onChangeText={(v) => onChangeText(String(v).replace(/\D/g, "").slice(0, 5))}
        onFocus={() => { clearTimeout(blurRef.current); setFocused(true); }}
        onBlur={() => { blurRef.current = setTimeout(() => setFocused(false), 150); }}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        keyboardType="number-pad"
        maxLength={5}
        autoCorrect={false}
      />
      {/* Say the number ("one two six five one") instead of typing it. */}
      <MicButton kind="train" onValue={(digits) => { setFocused(true); onChangeText(digits); }} style={styles.mic} />
      </View>
      {show ? (
        <View style={styles.dropdown}>
          {loading && !matches.length ? (
            <View style={styles.row}><ActivityIndicator size="small" color={colors.primary} /><Text style={styles.muted}>Searching trains…</Text></View>
          ) : matches.length ? (
            matches.map((m) => (
              <TouchableOpacity
                key={m.number}
                style={styles.row}
                // Web: blur's 150ms timer hides the list before click's mouse-up, so select on press-in.
                onPressIn={Platform.OS === "web" ? () => pick(m) : undefined}
                onPress={() => pick(m)}
                activeOpacity={0.7}
              >
                <Text style={styles.number}>{m.number}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>{m.name}</Text>
                  {m.from || m.to ? <Text style={styles.route} numberOfLines={1}>{`${m.from || "—"} → ${m.to || "—"}`}</Text> : null}
                </View>
              </TouchableOpacity>
            ))
          ) : notFound ? (
            <View style={styles.row}><Text style={styles.muted}>No train found for “{digits}”</Text></View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  label: { fontSize: 12, fontWeight: "600", color: colors.textMuted, marginBottom: spacing.xs },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, fontSize: 15, color: colors.text, backgroundColor: colors.bg,
  },
  inputFocused: { borderColor: colors.primary },
  inputRow: { flexDirection: "row", alignItems: "center" },
  inputFlex: { flex: 1 },
  mic: { marginLeft: 4 },
  dropdown: {
    marginTop: spacing.xs, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    overflow: "hidden", shadowColor: "#1A2233", shadowOpacity: 0.08, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  number: { width: 56, fontSize: 15, fontWeight: "800", color: colors.primary },
  name: { fontSize: 14, fontWeight: "700", color: colors.text },
  route: { fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  muted: { fontSize: 13, color: colors.textMuted },
});
