import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { colors, radius } from "../theme/colors";

/**
 * Shared horizontal row of selectable "chip" pills — travel class, quota,
 * or any other small fixed option set. Pulled out of TrainSearchScreen.js
 * (which had its own private copy) so the new RailYatri-style Enquiry
 * Center screens (Seat Availability, Fare Calculator, ...) can reuse the
 * exact same look/behavior instead of re-implementing it per screen.
 * Behavior is unchanged from the original inline version — this is a pure
 * extraction, not a redesign.
 */
export default function ChipRow({ options, value, onSelect, getKey, getLabel }) {
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

const styles = StyleSheet.create({
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
});
