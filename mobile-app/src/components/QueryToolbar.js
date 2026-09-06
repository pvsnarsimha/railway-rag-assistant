import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";

/**
 * QueryToolbar — the visible Web Search / Deep Think toggle chips shown
 * above the message input in both Chat and the Live Tracking tab's
 * "Ask about this train" box, so both are explicit, user-controlled
 * buttons rather than something the backend silently decides on its own.
 *
 * - Web Search ON: forces a live web lookup for this question even
 *   outside the backend's normal auto-trigger cases (see app.py's
 *   `req.web_search` handling). OFF forces it skipped entirely.
 * - Deep Think ON: backend retrieves more context and is told to reason
 *   step-by-step through the question instead of giving a compressed
 *   6-line answer - slower, more thorough.
 */
export default function QueryToolbar({ webSearch, onToggleWebSearch, deepThink, onToggleDeepThink }) {
  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={[styles.chip, webSearch && styles.chipActive]}
        onPress={() => onToggleWebSearch(!webSearch)}
        accessibilityLabel="Toggle web search"
      >
        <Ionicons name={webSearch ? "globe" : "globe-outline"} size={14} color={webSearch ? colors.textInverse : colors.primary} />
        <Text style={[styles.chipText, webSearch && styles.chipTextActive]}>Web Search</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.chip, deepThink && styles.chipActive]}
        onPress={() => onToggleDeepThink(!deepThink)}
        accessibilityLabel="Toggle deep think"
      >
        <Ionicons name={deepThink ? "bulb" : "bulb-outline"} size={14} color={deepThink ? colors.textInverse : colors.primary} />
        <Text style={[styles.chipText, deepThink && styles.chipTextActive]}>Deep Think</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.xs },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 11.5, fontWeight: "600", color: colors.primary },
  chipTextActive: { color: colors.textInverse },
});
