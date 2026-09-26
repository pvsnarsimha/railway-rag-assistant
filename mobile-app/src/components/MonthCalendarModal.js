import React, { useState } from "react";
import { Modal, View, TouchableOpacity, StyleSheet } from "react-native";
import { Text } from "../i18n/AutoText";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import { toDdMmYyyy, fromDdMmYyyy, startOfToday, isSameDay } from "../utils/dateFormat";

const WEEKDAY_HEADER = ["M", "T", "W", "T", "F", "S", "S"]; // Mon-first, matches RunningDaysRow
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Monday-first day-of-week index for a Date (native getDay() is Sunday-first). */
function mondayFirstDow(date) {
  return (date.getDay() + 6) % 7;
}

function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingBlanks = mondayFirstDow(first);
  const cells = Array(leadingBlanks).fill(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/**
 * Full month-grid date picker — the calendar-icon destination from the
 * Trains Between Stations toolbar, and an alternate way into the Date
 * field beyond DateStrip's 8-day quick strip. Pure RN (View/Text/
 * TouchableOpacity), no date-picker library — this project has none in
 * its deps and a 7x6 grid doesn't need one.
 */
export default function MonthCalendarModal({ visible, selected, onSelect, onClose }) {
  const selectedDate = fromDdMmYyyy(selected);
  const initial = selectedDate || startOfToday();
  const [viewYear, setViewYear] = useState(initial.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getMonth());

  function shiftMonth(delta) {
    let m = viewMonth + delta;
    let y = viewYear;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setViewMonth(m);
    setViewYear(y);
  }

  const today = startOfToday();
  const cells = buildMonthGrid(viewYear, viewMonth);

  return (
    <Modal visible={!!visible} animationType="fade" transparent onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <TouchableOpacity onPress={() => shiftMonth(-1)} style={styles.navBtn}>
              <Ionicons name="chevron-back" size={20} color={colors.orange} />
            </TouchableOpacity>
            <Text style={styles.headerText}>{MONTH_NAMES[viewMonth]} {viewYear}</Text>
            <TouchableOpacity onPress={() => shiftMonth(1)} style={styles.navBtn}>
              <Ionicons name="chevron-forward" size={20} color={colors.orange} />
            </TouchableOpacity>
          </View>

          <View style={styles.weekRow}>
            {WEEKDAY_HEADER.map((w, i) => (
              <Text key={i} style={styles.weekLabel}>{w}</Text>
            ))}
          </View>

          {Array.from({ length: cells.length / 7 }, (_, row) => (
            <View key={row} style={styles.weekRow}>
              {cells.slice(row * 7, row * 7 + 7).map((cellDate, idx) => {
                if (!cellDate) return <View key={idx} style={styles.dayCell} />;
                const isToday = isSameDay(cellDate, today);
                const isSelected = selectedDate && isSameDay(cellDate, selectedDate);
                return (
                  <TouchableOpacity
                    key={idx}
                    style={[styles.dayCell, isSelected && styles.dayCellSelected]}
                    onPress={() => {
                      onSelect(toDdMmYyyy(cellDate));
                      onClose();
                    }}
                  >
                    <Text style={[
                      styles.dayText,
                      isToday && !isSelected && styles.dayTextToday,
                      isSelected && styles.dayTextSelected,
                    ]}>
                      {cellDate.getDate()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}

          <TouchableOpacity
            style={styles.todayBtn}
            onPress={() => { onSelect(toDdMmYyyy(today)); onClose(); }}
          >
            <Text style={styles.todayBtnText}>Jump to today</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(20,24,33,0.45)", alignItems: "center", justifyContent: "center", padding: spacing.lg },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.lg, width: "100%", maxWidth: 360 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  headerText: { fontSize: 15, fontWeight: "700", color: colors.text },
  navBtn: { padding: 6 },
  weekRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 2 },
  weekLabel: { width: 36, textAlign: "center", fontSize: 11, fontWeight: "700", color: colors.textMuted },
  dayCell: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  dayCellSelected: { backgroundColor: colors.orange },
  dayText: { fontSize: 13, color: colors.text },
  dayTextToday: { color: colors.orange, fontWeight: "700" },
  dayTextSelected: { color: colors.textInverse, fontWeight: "700" },
  todayBtn: { marginTop: spacing.sm, alignSelf: "center", paddingVertical: 6, paddingHorizontal: spacing.md },
  todayBtnText: { color: colors.orange, fontWeight: "700", fontSize: 13 },
});
