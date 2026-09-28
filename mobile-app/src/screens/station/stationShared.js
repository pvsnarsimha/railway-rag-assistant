import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../../i18n/Localized";
import LabeledInput from "../../components/LabeledInput";
import StationField from "../../components/StationField";
import PrimaryButton from "../../components/PrimaryButton";

/**
 * Shared bits for the redesigned "At the station" tools (Station Navigator,
 * Platform Locator, Coach Position, Live Departures). The trip the rider
 * enters once (train, station, coach, berth) is remembered and shared by
 * all four screens, so "Navigate to B2" or the Live Departures board open
 * already filled in.
 */

// Palette taken from the mockups (clean white cards on a pale blue-grey
// background, bright blue accents, dark navy hero cards).
export const st = {
  bg: "#F3F5F9",
  card: "#FFFFFF",
  ink: "#0F1B33",
  muted: "#6B778C",
  line: "#E3E8EF",
  blue: "#2563EB",
  blueSoft: "#E4ECFD",
  navy: "#0E1F4D",
  navy2: "#1E3A8A",
  green: "#16A34A",
  greenSoft: "#DCFCE7",
  amberSoft: "#FFF4E5",
  amberLine: "#F7D9A8",
  amber: "#B45309",
  red: "#DC2626",
  platform: "#E2E7EF",
  fob: "#CBD3DF",
};

const TRIP_KEY = "stationTools.trip";
const listeners = new Set();
let memoryTrip = null;

/** The remembered trip: { trainNumber, station, stationName, coach, berth }. */
export function useTrip() {
  const [trip, setTripState] = useState(memoryTrip || {});
  useEffect(() => {
    let alive = true;
    if (!memoryTrip) {
      AsyncStorage.getItem(TRIP_KEY).then((raw) => {
        if (!alive || !raw) return;
        try { memoryTrip = JSON.parse(raw) || {}; setTripState(memoryTrip); } catch (e) { /* ignore */ }
      }).catch(() => {});
    }
    const l = (t) => setTripState(t);
    listeners.add(l);
    return () => { alive = false; listeners.delete(l); };
  }, []);
  const setTrip = useCallback((patch) => {
    memoryTrip = { ...(memoryTrip || {}), ...patch };
    listeners.forEach((l) => l(memoryTrip));
    AsyncStorage.setItem(TRIP_KEY, JSON.stringify(memoryTrip)).catch(() => {});
  }, []);
  return [trip, setTrip];
}

/** Screen header from the mockups: round back button, title, subtitle. */
export function ToolHeader({ title, subtitle, onBack, dark, right }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={onBack}
        style={[styles.backBtn, dark && styles.backBtnDark]}
        accessibilityRole="button"
        accessibilityLabel="Back to all tools"
      >
        <Ionicons name="arrow-back" size={20} color={dark ? "#E5E9F2" : st.ink} />
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <Text style={[styles.headerTitle, dark && { color: "#F8FAFC" }]}>{title}</Text>
        {subtitle ? <Text numberOfLines={1} style={[styles.headerSub, dark && { color: "#8C9AB5" }]}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

/**
 * Train / station / coach / berth form. `fields` picks which rows show.
 * Calls onSubmit(tripPatch) after saving the values to the shared trip.
 */
export function TripForm({ apiBaseUrl, trip, setTrip, fields = ["train", "station"], submitLabel = "Find", loading, onSubmit, error }) {
  const [trainNumber, setTrainNumber] = useState(trip.trainNumber || "");
  const [station, setStation] = useState(trip.station || "");
  const [stationName, setStationName] = useState(trip.stationName || null);
  const [coach, setCoach] = useState(trip.coach || "");
  const [berth, setBerth] = useState(trip.berth ? String(trip.berth) : "");
  const [localError, setLocalError] = useState(null);

  // The saved trip loads asynchronously on first open — pick it up.
  useEffect(() => {
    if (trip.trainNumber && !trainNumber) setTrainNumber(trip.trainNumber);
    if (trip.station && !station) { setStation(trip.station); setStationName(trip.stationName || null); }
    if (trip.coach && !coach) setCoach(trip.coach);
    if (trip.berth && !berth) setBerth(String(trip.berth));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.trainNumber, trip.station, trip.coach, trip.berth]);

  function submit() {
    const needTrain = fields.includes("train") && !fields.includes("trainOptional");
    if (needTrain && !/^\d{5}$/.test(trainNumber.trim())) { setLocalError("Enter a valid 5-digit train number."); return; }
    if (fields.includes("trainOptional") && trainNumber.trim() && !/^\d{5}$/.test(trainNumber.trim())) { setLocalError("Train number must be 5 digits."); return; }
    if (fields.includes("station") && !station.trim()) { setLocalError("Pick a station."); return; }
    if (fields.includes("coach") && coach.trim() && !/^[A-Za-z]{1,3}\d{1,2}$/.test(coach.trim())) { setLocalError("Coach looks like B2, S4 or A1."); return; }
    setLocalError(null);
    const patch = {
      trainNumber: trainNumber.trim(),
      station: station.trim().toUpperCase(),
      stationName: stationName || null,
      coach: coach.trim().toUpperCase(),
      berth: berth.trim() ? parseInt(berth, 10) || null : null,
    };
    setTrip(patch);
    onSubmit && onSubmit(patch);
  }

  const showTrain = fields.includes("train") || fields.includes("trainOptional");
  return (
    <View style={styles.formCard}>
      {showTrain && (
        <LabeledInput
          label={fields.includes("trainOptional") ? "Train number (optional)" : "Train number"}
          placeholder="e.g. 12785" value={trainNumber} onChangeText={setTrainNumber}
          keyboardType="number-pad" maxLength={5}
        />
      )}
      {fields.includes("station") && (
        <StationField
          label="Station" placeholder="e.g. KRNT or Kurnool" icon="location-outline"
          value={station} resolvedName={stationName}
          onChangeText={(t) => { setStation(t); setStationName(null); }}
          onSelectStation={(m) => { setStation(m.code); setStationName(m.name); }}
          apiBaseUrl={apiBaseUrl} style={{ marginBottom: 12 }}
        />
      )}
      {(fields.includes("coach") || fields.includes("berth")) && (
        <View style={{ flexDirection: "row", gap: 10 }}>
          {fields.includes("coach") && (
            <LabeledInput label="Coach (optional)" placeholder="B2" value={coach} onChangeText={(t) => setCoach(t.toUpperCase())} maxLength={4} style={{ flex: 1 }} />
          )}
          {fields.includes("berth") && (
            <LabeledInput label="Berth (optional)" placeholder="34" value={berth} onChangeText={setBerth} keyboardType="number-pad" maxLength={3} style={{ flex: 1 }} />
          )}
        </View>
      )}
      <PrimaryButton title={submitLabel} onPress={submit} loading={loading} style={{ backgroundColor: st.blue, shadowColor: st.blue }} />
      {(localError || error) ? <Text style={styles.error}>{localError || error}</Text> : null}
    </View>
  );
}

/** Pill / chip used for small status badges. */
export function Pill({ text, bg, color, style, icon }) {
  return (
    <View style={[styles.pill, { backgroundColor: bg }, style]}>
      {icon ? <Ionicons name={icon} size={12} color={color} style={{ marginRight: 4 }} /> : null}
      <Text style={[styles.pillText, { color }]}>{text}</Text>
    </View>
  );
}

/**
 * The rake, engine -> rear, as a row of coach boxes with the rider's coach
 * raised in blue, plus a "STAND HERE" marker under it.
 */
export function CoachStrip({ rake, coach, onPickCoach }) {
  const scrollRef = useRef(null);
  const [width, setWidth] = useState(0);
  const coaches = (rake || []).filter((c) => !(/^(ENG|LOCO|L)$/i.test(c.code || "") || /engine|loco/i.test(c.category || "")));
  const idx = coaches.findIndex((c) => c.code?.toUpperCase() === (coach || "").toUpperCase());
  // Short rakes fit the screen like the mockup; long ones (20+ coaches)
  // scroll, and open with the rider's coach centred over the marker.
  const fits = coaches.length <= 9;
  const BOX = 49;
  useEffect(() => {
    if (fits || idx < 0 || !width || !scrollRef.current) return;
    const x = Math.max(0, (idx + 1) * BOX - width / 2 + BOX / 2);
    scrollRef.current.scrollTo({ x, animated: false });
  }, [fits, idx, width]);
  if (!coaches.length) return null;
  const frac = idx >= 0 ? (idx + 1.5) / (coaches.length + 1) : null; // +1 for the engine box
  const boxes = [
    <View key="engine" style={[styles.coachBox, styles.engineBox, fits && styles.coachFlex]}>
      <Text style={{ fontSize: 16 }} noTranslate>🚂</Text>
    </View>,
    ...coaches.map((c, i) => {
      const mine = i === idx;
      return (
        <TouchableOpacity
          key={`${c.code}-${i}`}
          activeOpacity={onPickCoach ? 0.7 : 1}
          onPress={() => onPickCoach && onPickCoach(c.code)}
          style={[styles.coachBox, fits && styles.coachFlex, mine && styles.coachBoxMine]}
        >
          <Text noTranslate style={[styles.coachCode, mine && { color: "#fff" }]}>{c.code}</Text>
        </TouchableOpacity>
      );
    }),
  ];
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {fits ? (
        <View style={styles.rakeRow}>{boxes}</View>
      ) : (
        <ScrollView ref={scrollRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rakeRow}>{boxes}</ScrollView>
      )}
      <View style={styles.rakeLine} />
      <View style={styles.rakeEnds}>
        <Text style={styles.rakeEnd}>◀ Engine end</Text>
        <Text style={styles.rakeEnd}>Rear end ▶</Text>
      </View>
      {frac != null && width > 0 ? (
        <View style={[styles.standWrap, { left: fits ? Math.min(Math.max(frac * width - 70, 0), width - 140) : width / 2 - 70 }]} pointerEvents="none">
          <Ionicons name="arrow-up" size={16} color={st.ink} />
          <Text style={styles.standHere}>STAND HERE</Text>
          {!fits ? <Text style={styles.standSub}>{Math.round(frac * 100)}% along the train</Text> : null}
        </View>
      ) : null}
      {frac != null ? <View style={{ height: fits ? 30 : 44 }} /> : null}
    </View>
  );
}

export function SectionLabel({ children, dark, style }) {
  return <Text style={[styles.sectionLabel, dark && { color: "#8C9AB5" }, style]}>{children}</Text>;
}

export function Note({ text, dark }) {
  if (!text) return null;
  return <Text style={[styles.note, dark && { color: "#7C89A3" }]}>{text}</Text>;
}

export function EmptyState({ icon, title, text }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={30} color={st.muted} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {text ? <Text style={styles.emptyText}>{text}</Text> : null}
    </View>
  );
}

/** "10:22" -> minutes-from-now text like "in 14 min" / "2 h 5 min". */
export function formatIn(mins) {
  if (mins == null) return null;
  if (mins <= 0) return mins > -5 ? "Due now" : "Arrived / left";
  if (mins < 60) return `in ${mins} min`;
  return `in ${Math.floor(mins / 60)} h ${mins % 60} min`;
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12 },
  backBtn: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: "#fff", alignItems: "center", justifyContent: "center",
    shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  backBtnDark: { backgroundColor: "#111C33" },
  headerTitle: { fontSize: 20, fontWeight: "800", color: st.ink },
  headerSub: { fontSize: 12.5, color: st.muted, marginTop: 1 },
  formCard: {
    backgroundColor: st.card, borderRadius: 20, padding: 16, marginHorizontal: 16, marginBottom: 14,
    shadowColor: "#0F1B33", shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2,
  },
  error: { color: st.red, fontSize: 13, marginTop: 8 },
  pill: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  pillText: { fontSize: 12.5, fontWeight: "700" },
  rakeRow: { flexDirection: "row", gap: 5, paddingVertical: 8, alignItems: "center" },
  coachFlex: { flex: 1, minWidth: 0, paddingHorizontal: 0 },
  coachBox: { minWidth: 44, height: 46, paddingHorizontal: 6, borderRadius: 8, backgroundColor: st.platform, alignItems: "center", justifyContent: "center" },
  engineBox: { backgroundColor: st.ink, borderTopLeftRadius: 14, borderBottomLeftRadius: 14 },
  coachBoxMine: {
    backgroundColor: st.blue, height: 56, minWidth: 54,
    shadowColor: st.blue, shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 4,
  },
  coachCode: { fontSize: 12.5, fontWeight: "800", color: st.ink },
  rakeLine: { height: 3, backgroundColor: "#94A3B8", borderRadius: 2, marginTop: 2 },
  rakeEnds: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginTop: 4 },
  rakeEnd: { fontSize: 12, color: st.muted },
  standWrap: { position: "absolute", bottom: 0, width: 140, alignItems: "center" },
  standHere: { fontSize: 11, fontWeight: "800", color: st.blue },
  standSub: { fontSize: 10, color: st.muted },
  sectionLabel: { fontSize: 12, fontWeight: "800", letterSpacing: 1.2, color: st.muted, textTransform: "uppercase", marginHorizontal: 16, marginTop: 6, marginBottom: 8 },
  note: { fontSize: 11, color: st.muted, marginHorizontal: 16, marginTop: 8, lineHeight: 15 },
  empty: { alignItems: "center", padding: 24, gap: 6 },
  emptyTitle: { fontSize: 15, fontWeight: "700", color: st.ink, textAlign: "center" },
  emptyText: { fontSize: 13, color: st.muted, textAlign: "center" },
});
