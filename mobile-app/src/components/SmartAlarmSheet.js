import React from "react";
import { View, StyleSheet, TouchableOpacity, Modal, ScrollView, TextInput } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../i18n/Localized";
import { colors, spacing } from "../theme/colors";

/**
 * Full-screen Smart Alarm: a dial showing when it will ring, the station
 * you're getting off at, how early to wake you, and one big Set button.
 * All the real alarm logic (scheduling, background registration, live-delay
 * re-check) lives in LiveTrackingScreen's setSmartAlarm — this is only the UI.
 */
const LEADS = ["15", "20", "30", "40", "45"];
const R = 92;
const C = 2 * Math.PI * R;

export default function SmartAlarmSheet({
  visible, onClose, stationCode, onStationChange, stationName, etaClock, kmAway, minutesToArrival,
  leadMinutes, onLeadChange, customOpen, onCustomOpen, customText, onCustomText, leadValue,
  ringsAt, armed, busy, status, onSet, onCancel,
}) {
  const minsToRing = minutesToArrival != null && leadValue ? Math.max(0, minutesToArrival - leadValue) : null;
  // Ring fills as the alarm time approaches (full = about to ring).
  const frac = minutesToArrival && minsToRing != null ? Math.min(1, Math.max(0.04, 1 - minsToRing / Math.max(minutesToArrival, 1))) : 0.04;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.top}>
          <View style={styles.bar}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} style={styles.back}>
              <Ionicons name="chevron-back" size={20} color="#fff" />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
            <Text style={styles.title}>Smart Alarm</Text>
            <View style={{ width: 60 }} />
          </View>
          <View style={styles.dialWrap}>
            <Svg width={210} height={210} viewBox="0 0 210 210">
              <Circle cx={105} cy={105} r={R} stroke="rgba(255,255,255,0.18)" strokeWidth={14} fill="none" />
              <Circle
                cx={105} cy={105} r={R} stroke="#FBBF24" strokeWidth={14} fill="none" strokeLinecap="round"
                strokeDasharray={`${C * frac} ${C}`} transform="rotate(-90 105 105)"
              />
            </Svg>
            <View style={styles.dialCenter} pointerEvents="none">
              <Text style={styles.dialLabel}>ALARM RINGS AT</Text>
              <Text style={styles.dialTime}>{ringsAt || "--:--"}</Text>
              <Text style={styles.dialSub}>{minsToRing != null ? `in ${minsToRing} min · auto-adjusts` : "needs live ETA"}</Text>
              <View style={styles.dialPill}><Text style={styles.dialPillText}>{`${leadValue || "—"} min before ${stationCode || "stop"}`}</Text></View>
            </View>
          </View>
        </View>

        <ScrollView style={styles.sheet} contentContainerStyle={{ padding: 16, paddingBottom: 30 }}>
          <Text style={styles.kicker}>GETTING OFF AT</Text>
          <View style={styles.stationCard}>
            <Ionicons name="flag" size={22} color={colors.primary} />
            <View style={{ flex: 1, marginHorizontal: 10 }}>
              <Text style={styles.stationName} numberOfLines={1}>{stationName || "Choose a station"}</Text>
              <Text style={styles.stationSub}>{[etaClock ? `ETA ${etaClock}` : null, kmAway != null ? `${kmAway} km away` : null].filter(Boolean).join(" · ") || "Type the station code"}</Text>
            </View>
            <TextInput
              value={stationCode} onChangeText={(v) => onStationChange(v.toUpperCase())} editable={!armed}
              autoCapitalize="characters" maxLength={6} style={styles.codeInput} placeholder="CODE"
            />
          </View>

          <Text style={styles.kicker}>WAKE ME BEFORE ARRIVAL</Text>
          <View style={styles.chips}>
            {LEADS.map((m) => {
              const on = !customOpen && leadMinutes === m;
              return (
                <TouchableOpacity key={m} disabled={armed} onPress={() => onLeadChange(m)} style={[styles.chip, on && styles.chipOn]}>
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{`${m}m`}</Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity disabled={armed} onPress={onCustomOpen} style={[styles.chip, customOpen && styles.chipOn]}>
              <Text style={[styles.chipText, customOpen && styles.chipTextOn]}>Custom</Text>
            </TouchableOpacity>
          </View>
          {customOpen ? (
            <TextInput
              value={customText} onChangeText={onCustomText} editable={!armed} keyboardType="numbers-and-punctuation"
              placeholder="Minutes, or H:MM for 1 hr+ (e.g. 1:30)" style={styles.customInput}
            />
          ) : null}

          <View style={styles.note}>
            <Ionicons name="flash" size={16} color="#B45309" />
            <Text style={styles.noteText}>Follows the live delay — if the train runs late, your alarm moves too. Rings even if you close the app.</Text>
          </View>
          {status ? <Text style={styles.status}>{status}</Text> : null}
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity onPress={onSet} disabled={armed || busy} style={[styles.setBtn, (armed || busy) && styles.setBtnOff]} activeOpacity={0.85}>
            <Ionicons name={armed ? "checkmark-circle" : "alarm"} size={20} color="#fff" />
            <Text style={styles.setText}>{busy ? "Checking live ETA…" : armed ? "Alarm is set" : "Set Smart Alarm"}</Text>
          </TouchableOpacity>
          {armed ? (
            <TouchableOpacity onPress={onCancel} style={{ paddingTop: 12 }}>
              <Text style={styles.remove}>Remove alarm</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#F5F7FA" },
  top: { backgroundColor: "#2B2670", paddingTop: 14, paddingBottom: 22, borderBottomLeftRadius: 26, borderBottomRightRadius: 26 },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14 },
  back: { width: 60, flexDirection: "row", alignItems: "center" },
  backText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  title: { color: "#fff", fontSize: 17, fontWeight: "800" },
  dialWrap: { alignItems: "center", justifyContent: "center", marginTop: 8 },
  dialCenter: { position: "absolute", alignItems: "center" },
  dialLabel: { color: "rgba(255,255,255,0.75)", fontSize: 11, fontWeight: "700", letterSpacing: 1.2 },
  dialTime: { color: "#fff", fontSize: 44, fontWeight: "900", marginVertical: 2 },
  dialSub: { color: "rgba(255,255,255,0.8)", fontSize: 11.5 },
  dialPill: { backgroundColor: "rgba(251,191,36,0.2)", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, marginTop: 8 },
  dialPillText: { color: "#FCD34D", fontSize: 11.5, fontWeight: "800" },
  sheet: { flex: 1 },
  kicker: { fontSize: 11.5, fontWeight: "800", color: colors.textMuted, letterSpacing: 1, marginTop: 14, marginBottom: 8 },
  stationCard: { flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderRadius: 16, borderWidth: 2, borderColor: colors.primary, padding: 12 },
  stationName: { fontSize: 16, fontWeight: "800", color: colors.text },
  stationSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  codeInput: { width: 70, flexGrow: 0, flexShrink: 0, textAlign: "center", backgroundColor: "#E8F0FE", borderRadius: 10, paddingVertical: 6, paddingHorizontal: 8, fontWeight: "800", color: colors.primary, fontSize: 14 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { backgroundColor: "#fff", borderWidth: 1, borderColor: colors.border, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 9 },
  chipOn: { backgroundColor: "#4338CA", borderColor: "#4338CA" },
  chipText: { fontSize: 14, fontWeight: "700", color: colors.text },
  chipTextOn: { color: "#fff" },
  customInput: { backgroundColor: "#fff", borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, marginTop: 10, fontSize: 14 },
  note: { flexDirection: "row", gap: 8, backgroundColor: "#FFF7E6", borderRadius: 12, padding: 12, marginTop: 18 },
  noteText: { flex: 1, fontSize: 12.5, color: "#7A4B00" },
  status: { marginTop: 12, fontSize: 12.5, color: colors.textMuted },
  footer: { padding: 16, paddingBottom: 22, backgroundColor: "#fff", borderTopWidth: 1, borderTopColor: colors.border, alignItems: "center" },
  setBtn: { alignSelf: "stretch", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#4338CA", borderRadius: 16, paddingVertical: 15 },
  setBtnOff: { backgroundColor: "#8B8FD0" },
  setText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  remove: { color: colors.danger, fontWeight: "800", fontSize: 13.5 },
});
