import React, { useState, useEffect } from "react";
import { Modal, View, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import { Text } from "../i18n/AutoText";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";

// IRCTC's own quick departure/arrival time bands — the backend
// (TrainSearchRequest in app.py) already accepts an arbitrary
// departure_start/end + arrival_start/end range; these four presets are
// just the well-known IRCTC quick-picks mapped onto that same range API,
// not a new filtering concept.
const TIME_BANDS = [
  { key: "00-06", label: "00:00 – 06:00", start: "00:00", end: "06:00" },
  { key: "06-12", label: "06:00 – 12:00", start: "06:00", end: "12:00" },
  { key: "12-18", label: "12:00 – 18:00", start: "12:00", end: "18:00" },
  { key: "18-24", label: "18:00 – 24:00", start: "18:00", end: "23:59" },
];

function BandRow({ title, selectedKey, onSelect }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.bandGrid}>
        {TIME_BANDS.map((band) => {
          const active = band.key === selectedKey;
          return (
            <TouchableOpacity
              key={band.key}
              style={[styles.bandChip, active && styles.bandChipActive]}
              onPress={() => onSelect(active ? null : band.key)}
            >
              <Text style={[styles.bandChipText, active && styles.bandChipTextActive]}>{band.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function CheckRow({ label, checked, onToggle }) {
  return (
    <TouchableOpacity style={styles.checkRow} onPress={onToggle}>
      <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
        {checked ? <Ionicons name="checkmark" size={14} color={colors.textInverse} /> : null}
      </View>
      <Text style={styles.checkLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * Filter bottom sheet — departure/arrival time bands + Available-only /
 * Waitlisted-only, exactly the fields TrainSearchRequest (backend/app.py)
 * has always accepted but the mobile Trains Between Stations screen never
 * exposed a UI for. Combinable, same as the backend already allows.
 */
export default function FilterSheetModal({ visible, initial, onApply, onClose }) {
  const [departureBand, setDepartureBand] = useState(initial?.departureBand || null);
  const [arrivalBand, setArrivalBand] = useState(initial?.arrivalBand || null);
  const [availableOnly, setAvailableOnly] = useState(!!initial?.availableOnly);
  const [waitlistedOnly, setWaitlistedOnly] = useState(!!initial?.waitlistedOnly);

  useEffect(() => {
    if (visible) {
      setDepartureBand(initial?.departureBand || null);
      setArrivalBand(initial?.arrivalBand || null);
      setAvailableOnly(!!initial?.availableOnly);
      setWaitlistedOnly(!!initial?.waitlistedOnly);
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  function apply() {
    const dep = TIME_BANDS.find((b) => b.key === departureBand);
    const arr = TIME_BANDS.find((b) => b.key === arrivalBand);
    onApply({
      departureBand, arrivalBand,
      departureStart: dep?.start || null, departureEnd: dep?.end || null,
      arrivalStart: arr?.start || null, arrivalEnd: arr?.end || null,
      availableOnly, waitlistedOnly,
    });
    onClose();
  }

  function clearAll() {
    setDepartureBand(null);
    setArrivalBand(null);
    setAvailableOnly(false);
    setWaitlistedOnly(false);
  }

  return (
    <Modal visible={!!visible} animationType="slide" transparent onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <Text style={styles.title}>Filters</Text>
          <ScrollView bounces={false} style={styles.body}>
            <BandRow title="Departure time" selectedKey={departureBand} onSelect={setDepartureBand} />
            <BandRow title="Arrival time" selectedKey={arrivalBand} onSelect={setArrivalBand} />
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Availability</Text>
              <CheckRow label="Available only" checked={availableOnly} onToggle={() => setAvailableOnly((v) => !v)} />
              <CheckRow label="Waitlisted only" checked={waitlistedOnly} onToggle={() => setWaitlistedOnly((v) => !v)} />
              <Text style={styles.hint}>Needs a class and date picked above — live-checked against the closest-matching trains.</Text>
            </View>
          </ScrollView>
          <View style={styles.footer}>
            <TouchableOpacity style={styles.clearBtn} onPress={clearAll}>
              <Text style={styles.clearBtnText}>Clear all</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.applyBtn} onPress={apply}>
              <Text style={styles.applyBtnText}>Apply</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(20,24,33,0.45)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.lg, maxHeight: "80%",
  },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: spacing.md },
  title: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: spacing.sm, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  body: { flexGrow: 0 },
  section: { marginBottom: spacing.md },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: spacing.sm },
  bandGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bandChip: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  bandChipActive: { backgroundColor: colors.orange, borderColor: colors.orange },
  bandChipText: { fontSize: 12, fontWeight: "600", color: colors.text },
  bandChipTextActive: { color: colors.textInverse },
  checkRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: spacing.sm },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: colors.orange, borderColor: colors.orange },
  checkLabel: { fontSize: 14, color: colors.text },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  footer: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm },
  clearBtn: { flex: 1, alignItems: "center", paddingVertical: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  clearBtnText: { fontWeight: "700", color: colors.textMuted },
  applyBtn: { flex: 1, alignItems: "center", paddingVertical: spacing.md, borderRadius: radius.pill, backgroundColor: colors.orange },
  applyBtnText: { fontWeight: "700", color: colors.textInverse },
});
