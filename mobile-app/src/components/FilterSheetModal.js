import React, { useState, useEffect } from "react";
import { Modal, View, TouchableOpacity, ScrollView, StyleSheet, Switch } from "react-native";
import { Text } from "../i18n/Localized";
import { colors, spacing, radius } from "../theme/colors";

// IRCTC's own quick departure/arrival time bands — the backend
// (TrainSearchRequest in app.py) already accepts an arbitrary
// departure_start/end + arrival_start/end range; these four presets are
// just the well-known IRCTC quick-picks mapped onto that same range API,
// not a new filtering concept.
const TIME_BANDS = [
  { key: "00-06", label: "00:00 – 06:00", sub: "Early morning", start: "00:00", end: "06:00" },
  { key: "06-12", label: "06:00 – 12:00", sub: "Morning", start: "06:00", end: "12:00" },
  { key: "12-18", label: "12:00 – 18:00", sub: "Afternoon", start: "12:00", end: "18:00" },
  { key: "18-24", label: "18:00 – 24:00", sub: "Night", start: "18:00", end: "23:59" },
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
              <Text style={[styles.bandChipSub, active && styles.bandChipTextActive]}>{band.sub}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function CheckRow({ label, checked, onToggle }) {
  return (
    <TouchableOpacity style={styles.checkRow} onPress={onToggle} activeOpacity={0.7}>
      <Text style={styles.checkLabel}>{label}</Text>
      <Switch
        value={!!checked}
        onValueChange={onToggle}
        trackColor={{ false: "#D5DAE3", true: colors.success }}
        thumbColor={colors.card}
        ios_backgroundColor="#D5DAE3"
      />
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
          <Text style={styles.title}>Filter trains</Text>
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
              <Text style={styles.applyBtnText}>Apply filters</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(20,24,33,0.5)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: spacing.lg + 4, paddingTop: spacing.sm + 2, paddingBottom: spacing.lg + 4, maxHeight: "85%",
  },
  handle: { alignSelf: "center", width: 44, height: 5, borderRadius: 3, backgroundColor: "#D5DAE3", marginBottom: spacing.md },
  title: { fontSize: 20, fontWeight: "800", color: colors.text, marginBottom: spacing.md },
  body: { flexGrow: 0 },
  section: { marginBottom: spacing.lg },
  sectionTitle: { fontSize: 11, fontWeight: "800", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 1, marginBottom: spacing.sm },
  bandGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 10 },
  bandChip: {
    width: "48.5%", paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.card,
  },
  bandChipActive: { backgroundColor: "#FFF3EA", borderColor: colors.orange },
  bandChipText: { fontSize: 13, fontWeight: "800", color: colors.text },
  bandChipSub: { fontSize: 11, fontWeight: "600", color: colors.textMuted, marginTop: 2 },
  bandChipTextActive: { color: colors.orangeDark },
  checkRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 },
  checkLabel: { fontSize: 15, fontWeight: "700", color: colors.text, flex: 1 },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  footer: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm },
  clearBtn: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 14, borderRadius: radius.lg, backgroundColor: "#F1F3F7" },
  clearBtnText: { fontWeight: "800", fontSize: 15, color: colors.textMuted },
  applyBtn: {
    flex: 2, alignItems: "center", justifyContent: "center", paddingVertical: 14, borderRadius: radius.lg, backgroundColor: colors.orange,
    shadowColor: colors.orange, shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 4,
  },
  applyBtnText: { fontWeight: "800", fontSize: 16, color: colors.textInverse, letterSpacing: 0.3 },
});
