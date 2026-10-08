import React from "react";
import { View, StyleSheet } from "react-native";
import { Text, TextInput } from "../i18n/Localized";
import { colors, spacing, radius } from "../theme/colors";
import MicButton from "./MicButton";

// Which spoken-answer parser fits this field? Decided from the label (and
// keyboard) so every form in the app gets a mic without per-field wiring.
// Pass voice={false} to hide the mic, or voice="train" | "date" | ... to force one.
function inferVoiceKind(label, keyboardType) {
  const l = String(label || "").toLowerCase();
  if (/\bpnr\b/.test(l)) return "pnr";
  if (/train number/.test(l) && !/numbers/.test(l)) return "train";
  if (/\bdate\b/.test(l)) return "date";
  if (/\b(hh:mm|time)\b/.test(l)) return "time";
  if (/station|\bfrom\b|\bto\b|\bcode\b|boarding|destination/.test(l) && !/coach/.test(l)) return "station";
  if (keyboardType === "number-pad" || keyboardType === "numeric") return "number";
  return null;
}

// onVoiceValue(parsed): optional override for what a spoken answer does (e.g. look up a station code).
export default function LabeledInput({ label, style, voice, onChangeText, onVoiceValue, maxLength, ...inputProps }) {
  const kind = voice === false ? null : (typeof voice === "string" ? voice : inferVoiceKind(label, inputProps.keyboardType));
  const input = (
    <TextInput
      style={[styles.input, kind && styles.inputFlex]}
      placeholderTextColor={colors.textMuted}
      autoCapitalize="characters"
      onChangeText={onChangeText}
      maxLength={maxLength}
      {...inputProps}
    />
  );
  return (
    <View style={[styles.wrap, style]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      {kind ? (
        <View style={styles.row}>
          {input}
          <MicButton
            kind={kind}
            onValue={(v) => (onVoiceValue ? onVoiceValue(v) : onChangeText && onChangeText(maxLength ? String(v).slice(0, maxLength) : v))}
            style={styles.mic}
          />
        </View>
      ) : input}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  label: { fontSize: 12, fontWeight: "600", color: colors.textMuted, marginBottom: spacing.xs },
  row: { flexDirection: "row", alignItems: "center" },
  mic: { marginLeft: 4 },
  inputFlex: { flex: 1 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bg,
  },
});
