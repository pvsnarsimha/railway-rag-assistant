import React from "react";
import { View, ScrollView, TouchableOpacity, StyleSheet } from "react-native";
import { Text } from "../i18n/Localized";
import { colors, spacing, radius } from "../theme/colors";
import MicButton from "./MicButton";
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
  // A spoken date can be outside the 8-day strip — then the mic pill shows it.
  const outsideStrip = !!selected && !days.some((d) => toDdMmYyyy(d) === selected);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll} contentContainerStyle={styles.content}>
      {/* "28th aug" / "tomorrow" / "27th aug 2025" — no year means this year. */}
      <View style={[styles.micPill, outsideStrip && styles.micPillActive]}>
        <MicButton kind="date" onValue={(ddmmyyyy) => onSelect(ddmmyyyy)} size={20} />
        <Text style={[styles.micLabel, outsideStrip && { color: colors.orange }]} noTranslate={outsideStrip}>{outsideStrip ? selected : "Say date"}</Text>
      </View>
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
  micPill: { minWidth: 64, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 6 },
  micPillActive: { borderColor: colors.orange, backgroundColor: colors.orangeLight },
  micLabel: { fontSize: 10.5, fontWeight: "700", color: colors.textMuted, marginTop: -4, marginBottom: 4 },
  scroll: { marginTop: spacing.xs, marginBottom: spacing.xs },
  content: { gap: 8, paddingVertical: 4, paddingRight: spacing.sm },
  pill: {
    minWidth: 64,
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    backgroundColor: "#F1F3F7",
  },
  pillActive: {
    backgroundColor: colors.orange,
    shadowColor: colors.orange,
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  pillTop: { fontSize: 13, fontWeight: "800", color: colors.text },
  pillBottom: { fontSize: 11, fontWeight: "600", color: colors.textMuted, marginTop: 1 },
  pillTextActive: { color: colors.textInverse },
});
