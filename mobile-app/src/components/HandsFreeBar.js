import React from "react";
import { View, TouchableOpacity, StyleSheet } from "react-native";
import { Text } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";

/**
 * Status strip for useHandsFreeForm: a "Hands-free" chip when idle, and
 * "Listening… <question> / heard: <words>" with a Stop button while the app
 * is talking to the user. Renders nothing where voice input isn't available.
 */
export default function HandsFreeBar({ hf, style }) {
  if (!hf || !hf.supported) return null;
  if (!hf.running) {
    return (
      <TouchableOpacity style={[styles.chip, hf.handsFree && styles.chipOn, style]} onPress={hf.start} accessibilityRole="button" accessibilityLabel="Start hands-free voice input">
        <Ionicons name="mic-circle-outline" size={18} color={hf.handsFree ? colors.success : colors.primary} />
        <Text style={[styles.chipText, hf.handsFree && { color: colors.success }]} noTranslate>
          {hf.handsFree ? "Hands-free · tap to ask again" : "Hands-free"}
        </Text>
      </TouchableOpacity>
    );
  }
  return (
    <View style={[styles.bar, style]}>
      <Ionicons name="mic" size={20} color={colors.danger} />
      <View style={{ flex: 1 }}>
        <Text style={styles.prompt} noTranslate>{hf.prompt}</Text>
        {hf.heard ? <Text style={styles.heard} noTranslate>{`Heard: “${hf.heard}”`}</Text> : <Text style={styles.heard} noTranslate>Say “skip”, “repeat” or “stop” any time</Text>}
      </View>
      <TouchableOpacity onPress={hf.stop} style={styles.stopBtn} accessibilityRole="button" accessibilityLabel="Stop hands-free">
        <Text style={styles.stopText} noTranslate>Stop</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, marginBottom: spacing.sm },
  chipOn: { borderColor: colors.success },
  chipText: { fontSize: 12.5, fontWeight: "700", color: colors.primary },
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: "#FDECEA", borderWidth: 1, borderColor: colors.danger, marginBottom: spacing.sm },
  prompt: { fontSize: 14, fontWeight: "800", color: colors.text },
  heard: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  stopBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.sm, backgroundColor: colors.danger },
  stopText: { color: "#fff", fontWeight: "800", fontSize: 12.5 },
});
