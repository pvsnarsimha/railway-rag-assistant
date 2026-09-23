import React from "react";
import { Modal, View, Text, TouchableOpacity, TextInput, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";

// Threshold ("alert when delay >= X") and repeat ("notify every Y") use
// separate preset rows: repeat is offered as 10/20/30 min per request.
const THRESHOLD_PRESETS = ["10", "15", "20", "30", "45"];
const REPEAT_PRESETS = ["10", "20", "30"];
const DEFAULT_THRESHOLD = "20";
const DEFAULT_REPEAT = "10";

function ChipRow({ presets, value, isCustomOpen, onPick, onPickCustom, disabled }) {
  return (
    <View style={styles.chipRow}>
      {presets.map((m) => {
        const active = !isCustomOpen && value === m;
        return (
          <TouchableOpacity
            key={m}
            disabled={disabled}
            onPress={() => onPick(m)}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{m} min</Text>
          </TouchableOpacity>
        );
      })}
      <TouchableOpacity
        disabled={disabled}
        onPress={onPickCustom}
        style={[styles.chip, isCustomOpen && styles.chipActive]}
      >
        <Text style={[styles.chipText, isCustomOpen && styles.chipTextActive]}>Custom</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * FEATURE: Delay Alert settings sheet — opened from the bell icon on Live
 * Tracking (see LiveTrackingScreen.web.js's delayModalVisible/FAB). This
 * REPLACES the old behavior where a watch auto-armed itself silently the
 * instant a train connected (fixed 15-min threshold, no repeat control).
 * Now a watch is only ever created here, explicitly, for whatever train
 * number + date is currently sitting in the "Track a train" form — passed
 * in as `trainNumber`/`trackDate` props, never read off a live connection
 * — with a threshold AND a repeat cadence the user actually picks: preset
 * chips (10/15/20/30/45 min) or free-text Custom for either one.
 *
 * `initialThreshold`/`initialRepeat` seed the sheet from whatever's
 * already armed for this train+date (or the last-used values), and the
 * sheet re-syncs to them every time it's reopened (see the effect below)
 * so it never shows stale picks from a previous open that was dismissed
 * without confirming.
 */
export default function DelayAlertModal({
  visible,
  onClose,
  trainNumber,
  trackDate,
  station,
  active,
  busy,
  initialThreshold,
  initialRepeat,
  statusMessage,
  onConfirm,
  onStop,
}) {
  const [thresholdChip, setThresholdChip] = React.useState(DEFAULT_THRESHOLD);
  const [thresholdCustomOpen, setThresholdCustomOpen] = React.useState(false);
  const [thresholdCustomText, setThresholdCustomText] = React.useState("");

  const [repeatChip, setRepeatChip] = React.useState(DEFAULT_REPEAT);
  const [repeatCustomOpen, setRepeatCustomOpen] = React.useState(false);
  const [repeatCustomText, setRepeatCustomText] = React.useState("");

  React.useEffect(() => {
    if (!visible) return;
    const t = String(initialThreshold || DEFAULT_THRESHOLD);
    const r = String(initialRepeat || DEFAULT_REPEAT);
    setThresholdChip(THRESHOLD_PRESETS.includes(t) ? t : "");
    setThresholdCustomOpen(!THRESHOLD_PRESETS.includes(t));
    setThresholdCustomText(!THRESHOLD_PRESETS.includes(t) ? t : "");
    setRepeatChip(REPEAT_PRESETS.includes(r) ? r : "");
    setRepeatCustomOpen(!REPEAT_PRESETS.includes(r));
    setRepeatCustomText(!REPEAT_PRESETS.includes(r) ? r : "");
  }, [visible, initialThreshold, initialRepeat]);

  const thresholdValue = thresholdCustomOpen ? parseInt(thresholdCustomText, 10) : parseInt(thresholdChip, 10);
  const repeatValue = repeatCustomOpen ? parseInt(repeatCustomText, 10) : parseInt(repeatChip, 10);
  const num = (trainNumber || "").trim();
  const canConfirm = !!num && thresholdValue > 0 && repeatValue > 0 && !busy;

  return (
    <Modal visible={!!visible} animationType="fade" transparent onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>🔔 Delay Alert</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <Text style={styles.subject}>
            {num ? `Train ${num}` : "Enter a train number above first"}
            {num && station ? ` · ${station.name}${station.code ? ` (${station.code})` : ""}` : ""}
            {num ? ` · ${trackDate || "today"}` : ""}
          </Text>

          <Text style={styles.fieldLabel}>
            Alert me when delay{station ? ` at ${station.name}` : ""} is at least
          </Text>
          <ChipRow
            presets={THRESHOLD_PRESETS}
            value={thresholdChip}
            isCustomOpen={thresholdCustomOpen}
            onPick={(m) => { setThresholdChip(m); setThresholdCustomOpen(false); }}
            onPickCustom={() => setThresholdCustomOpen(true)}
          />
          {thresholdCustomOpen && (
            <TextInput
              value={thresholdCustomText}
              onChangeText={setThresholdCustomText}
              placeholder="Minutes"
              keyboardType="number-pad"
              style={styles.input}
            />
          )}

          <Text style={[styles.fieldLabel, { marginTop: spacing.md }]}>Repeat the alert every</Text>
          <ChipRow
            presets={REPEAT_PRESETS}
            value={repeatChip}
            isCustomOpen={repeatCustomOpen}
            onPick={(m) => { setRepeatChip(m); setRepeatCustomOpen(false); }}
            onPickCustom={() => setRepeatCustomOpen(true)}
          />
          {repeatCustomOpen && (
            <TextInput
              value={repeatCustomText}
              onChangeText={setRepeatCustomText}
              placeholder="Minutes"
              keyboardType="number-pad"
              style={styles.input}
            />
          )}
          <Text style={styles.hint}>
            While {num || "this train"} is predicted to reach {station ? station.name : "this station"} at or past
            your threshold, you'll get a push this often — even with the app closed. Stops by itself once the
            train reaches the station.
          </Text>

          {statusMessage ? <Text style={styles.status}>{statusMessage}</Text> : null}

          <TouchableOpacity
            style={[styles.confirmBtn, !canConfirm && styles.confirmBtnDisabled]}
            disabled={!canConfirm}
            onPress={() => onConfirm(thresholdValue, repeatValue)}
          >
            <Text style={styles.confirmBtnText}>{busy ? "Saving…" : active ? "Update alert" : "Arm delay alert"}</Text>
          </TouchableOpacity>

          {active && (
            <TouchableOpacity onPress={onStop} disabled={busy} style={styles.stopBtn}>
              <Text style={styles.stopBtnText}>Stop alert for this station</Text>
            </TouchableOpacity>
          )}
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
    marginBottom: spacing.xs,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 17, fontWeight: "700", color: colors.text },
  subject: { fontSize: 13, fontWeight: "600", color: colors.primary, marginTop: spacing.sm, marginBottom: spacing.md },
  fieldLabel: { fontSize: 12.5, fontWeight: "700", color: colors.textMuted, marginBottom: spacing.xs },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: "#fff",
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.text },
  chipTextActive: { color: "#fff" },
  input: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 14,
    color: colors.text,
    backgroundColor: "#fff",
  },
  hint: { fontSize: 11.5, color: colors.textMuted, lineHeight: 16, marginTop: spacing.md },
  status: { fontSize: 12, color: colors.text, marginTop: spacing.sm, lineHeight: 16 },
  confirmBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.lg,
  },
  confirmBtnDisabled: { backgroundColor: colors.border },
  confirmBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  stopBtn: { marginTop: spacing.md, alignItems: "center" },
  stopBtnText: { color: colors.danger, fontWeight: "700", fontSize: 13 },
});