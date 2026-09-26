import React from "react";
import { Modal, View, TouchableOpacity, StyleSheet } from "react-native";
import { Text } from "../i18n/AutoText";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import { toDdMmYyyy, fromDdMmYyyy, addDays, startOfToday, isSameDay, weekdayShort, monthShort } from "../utils/dateFormat";

/**
 * RailYatri-style "Change Start Day" dialog — a centered card with a plain
 * radio-button list (Tomorrow / Today / Yesterday / 2-4 days ago), each row
 * showing the *actual* calendar date computed off `new Date()` right now,
 * so "Today"/"Tomorrow" always line up with the real current date rather
 * than a stale hardcoded label. Selecting a row and tapping GO is the only
 * way out other than the backdrop/X (mirrors the reference screenshot).
 *
 * `selected` is a "dd-mm-yyyy" string or falsy (falsy == "Today", matching
 * how the rest of this app treats a blank date field as "defaults to
 * today"). `onSelect` is called with a "dd-mm-yyyy" string — never null —
 * so the caller always has an explicit, unambiguous date to send to the
 * API, even when the user picked "Today".
 */
const DAY_OPTIONS = [
  { key: "tomorrow", label: "Tomorrow", offset: 1 },
  { key: "today", label: "Today", offset: 0 },
  { key: "yesterday", label: "Yesterday", offset: -1 },
  { key: "2ago", label: "2 days ago", offset: -2 },
  { key: "3ago", label: "3 days ago", offset: -3 },
  { key: "4ago", label: "4 days ago", offset: -4 },
];

export default function DayPickerModal({ visible, selected, onSelect, onClose, title = "Change Start Day" }) {
  const today = startOfToday();
  const selectedDate = fromDdMmYyyy(selected) || today;

  const options = DAY_OPTIONS.map((opt) => {
    const date = addDays(today, opt.offset);
    return { ...opt, date, ddmmyyyy: toDdMmYyyy(date) };
  });

  const initialActiveKey = options.find((o) => isSameDay(o.date, selectedDate))?.key || "today";
  const [activeKey, setActiveKey] = React.useState(initialActiveKey);

  // Re-sync the highlighted row whenever the dialog is (re)opened, so it
  // always reflects whatever date is currently applied rather than
  // whatever was last clicked before it was closed without confirming.
  React.useEffect(() => {
    if (visible) setActiveKey(initialActiveKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, selected]);

  function confirm() {
    const chosen = options.find((o) => o.key === activeKey) || options[1];
    onSelect(chosen.ddmmyyyy);
    onClose();
  }

  return (
    <Modal visible={!!visible} animationType="fade" transparent onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={styles.list}>
            {options.map((opt) => {
              const active = opt.key === activeKey;
              return (
                <TouchableOpacity
                  key={opt.key}
                  style={styles.row}
                  onPress={() => setActiveKey(opt.key)}
                  activeOpacity={0.6}
                >
                  <View style={[styles.radioOuter, active && styles.radioOuterActive]}>
                    {active ? <View style={styles.radioInner} /> : null}
                  </View>
                  <Text style={[styles.rowLabel, active && styles.rowLabelActive]}>{opt.label}</Text>
                  <Text style={[styles.rowDate, active && styles.rowDateActive]}>
                    {weekdayShort(opt.date)}, {opt.date.getDate()} {monthShort(opt.date)} {opt.date.getFullYear()}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity style={styles.goBtn} onPress={confirm} activeOpacity={0.85}>
            <Text style={styles.goBtnText}>GO</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(20,24,33,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 17, fontWeight: "700", color: colors.text },
  list: { marginBottom: spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuterActive: { borderColor: colors.primary },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
  rowLabel: { fontSize: 15, fontWeight: "700", color: colors.text, flex: 1 },
  rowLabelActive: { color: colors.primary },
  rowDate: { fontSize: 12.5, color: colors.textMuted, fontWeight: "600" },
  rowDateActive: { color: colors.primary },
  goBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.primary,
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  goBtnText: { color: colors.textInverse, fontWeight: "700", fontSize: 15, letterSpacing: 0.5 },
});
