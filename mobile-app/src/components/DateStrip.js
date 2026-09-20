import React from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import { toDdMmYyyy, addDays, startOfToday, isSameDay, relativeDayLabel, monthShort } from "../utils/dateFormat";

const DAYS_SHOWN = 8; // today + next 7 — matches the IRCTC quick-pick strip's width

/**
 * IRCTC's horizontal "Departure Date / 21 Sep Monday / 22 Sep Tuesday…"
 * quick-pick strip (see the Quota-sheet reference screenshot). Used both
 * under the search form's Date field and on the results header, so
 * changing the day is always a single tap away without opening the full
 * MonthCalendarModal. `selected` is a "dd-mm-yyyy" string or null/empty
 * (no date chosen yet); tapping a pill calls onSelect with that same
 * "dd-mm-yyyy" shape the rest of the search API already expects.
 */
export default function DateStrip({ selected, onSelect }) {
  const today = startOfToday();
  const days = Array.from({ length: DAYS_SHOWN }, (_, i) => addDays(today, i));

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll} contentContainerStyle={styles.content}>
      {days.map((d) => {
        const ddmmyyyy = toDdMmYyyy(d);
        const active = selected === ddmmyyyy || (!selected && isSameDay(d, today));
        return (
          <TouchableOpacity
            key={ddmmyyyy}
            style={[styles.pill, active && styles.pillActive]}
            onPress={() => onSelect(ddmmyyyy)}
          >
            <Text style={[styles.pillTop, active && styles.pillTextActive]}>{relativeDayLabel(d)}</Text>
            <Text style={[styles.pillBottom, active && styles.pillTextActive]}>
              {d.getDate()} {monthShort(d)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { marginTop: spacing.xs, marginBottom: spacing.sm },
  content: { gap: 6, paddingVertical: 2 },
  pill: {
    minWidth: 58,
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  pillActive: { backgroundColor: colors.orange, borderColor: colors.orange },
  pillTop: { fontSize: 10, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase" },
  pillBottom: { fontSize: 12, fontWeight: "700", color: colors.text, marginTop: 1 },
  pillTextActive: { color: colors.textInverse },
});
