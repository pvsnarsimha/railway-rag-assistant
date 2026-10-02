import React, { useMemo, useState } from "react";
import { View, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../i18n/Localized";
import { colors, spacing } from "../theme/colors";

/**
 * Condensed "Journey" card for Live Tracking: instead of 40 stations the
 * passenger sees only what matters — the last halt, where the train is NOW,
 * the next few halts, and their destination with Alarm / Ride shortcuts.
 * Everything else is folded into "N stations passed" / "N more halts".
 * The full station-by-station table stays available below.
 */

const titleCase = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
export function clock(v) {
  const m = /(\d{1,2}):(\d{2})/.exec(String(v || ""));
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}
export function stopEtaClock(s) {
  return clock(s?.predicted_eta) || clock(s?.arrival?.expected) || clock(s?.arrival?.scheduled);
}
export function minusMinutes(hhmm, mins) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return null;
  let t = (Number(m[1]) * 60 + Number(m[2]) - mins) % 1440;
  if (t < 0) t += 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
const delayOf = (s) => {
  const d = s?.arrival?.delay_minutes ?? s?.departure?.delay_minutes;
  return d == null || Number.isNaN(Number(d)) ? null : Number(d);
};

export default function JourneyGlance({ timeline, complete, destCode, alarmCode, alarmTime, alarmArmed, speed, onAlarm, onRide, onJumpFull }) {
  const [openPassed, setOpenPassed] = useState(false);
  const [openMore, setOpenMore] = useState(false);

  const model = useMemo(() => {
    const halts = (timeline || []).filter((s) => s && s.code && s.kind !== "intermediate");
    if (!halts.length) return null;
    let reached = -1;
    halts.forEach((s, i) => { if (s.status === "passed" || s.status === "current") reached = i; });
    if (complete) reached = halts.length - 1;
    const code = String(destCode || "").toUpperCase();
    let destIdx = halts.findIndex((s) => String(s.code).toUpperCase() === code);
    if (destIdx < 0 || destIdx <= reached - 1) destIdx = halts.length - 1;
    const cur = reached >= 0 ? halts[reached] : null;
    const atStation = !!cur && cur.status === "current" && !complete;
    const next = !complete ? halts[reached + 1] || null : null;
    const passed = reached > 0 ? halts.slice(0, reached) : [];
    const mids = halts.slice(reached + 1, destIdx);
    const dest = halts[destIdx];
    const km = (a, b) => (a?.distance_km != null && b?.distance_km != null ? Math.round(Math.abs(b.distance_km - a.distance_km)) : null);
    return { halts, passed, cur, atStation, next, mids, dest, destIdx, reached,
      kmToDest: cur ? km(cur, dest) : null, kmToNext: cur && next ? km(cur, next) : null };
  }, [timeline, complete, destCode]);

  if (!model) return null;
  const { passed, cur, atStation, next, mids, dest, kmToDest, kmToNext } = model;
  const shownMids = openMore ? mids : mids.slice(0, 2);
  const hiddenMids = mids.length - 2;
  const lastPassed = passed.length ? passed[passed.length - 1] : null;
  const olderPassed = passed.length > 1 ? passed.slice(0, -1) : [];

  const Row = ({ stop, dim, last, actions }) => {
    const d = delayOf(stop);
    const isAlarm = alarmArmed && String(stop.code).toUpperCase() === String(alarmCode || "").toUpperCase();
    return (
      <View style={styles.row}>
        <Text style={[styles.time, dim && styles.dim]}>{stopEtaClock(stop) || "—"}</Text>
        <View style={styles.rail}>
          <View style={[styles.line, !last && styles.lineOn]} />
          <View style={[styles.dot, dim ? styles.dotDone : styles.dotNext]} />
        </View>
        <View style={styles.body}>
          <Text style={[styles.name, dim && styles.dim]} numberOfLines={1}>{titleCase(stop.name || stop.code)}</Text>
          <Text style={styles.sub}>{`${stop.code}${stop.distance_km != null ? ` · ${stop.distance_km} km` : ""}`}</Text>
        </View>
        {d != null && d !== 0 ? <Text style={[styles.delay, d > 0 ? styles.late : styles.early]}>{d > 0 ? `+${d}` : d}</Text> : null}
        {actions ? (
          <View style={styles.rowActions}>
            <TouchableOpacity onPress={() => onAlarm(stop)} style={[styles.mini, isAlarm && styles.miniOn]} hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }} accessibilityLabel={`Set alarm for ${stop.name || stop.code}`}>
              <Ionicons name={isAlarm ? "alarm" : "alarm-outline"} size={16} color={isAlarm ? "#fff" : colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onRide(stop)} style={styles.mini} hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }} accessibilityLabel={`Book a ride from ${stop.name || stop.code}`}>
              <Ionicons name="car-outline" size={16} color={colors.primary} />
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    );
  };

  const FoldRow = ({ label, onPress, open }) => (
    <TouchableOpacity onPress={onPress} style={styles.fold} activeOpacity={0.7}>
      <View style={styles.rail}><View style={[styles.line, styles.lineOn]} /></View>
      <Text style={styles.foldText}>{`${open ? "▾" : "▸"} ${label}`}</Text>
    </TouchableOpacity>
  );

  const destDelay = delayOf(dest);
  const destAlarmOn = alarmArmed && String(alarmCode || "").toUpperCase() === String(dest.code).toUpperCase();
  return (
    <View style={styles.card}>
      {lastPassed ? <Row stop={lastPassed} dim /> : null}
      {olderPassed.length ? (
        <>
          <FoldRow label={`${olderPassed.length} station${olderPassed.length > 1 ? "s" : ""} passed`} open={openPassed} onPress={() => setOpenPassed((v) => !v)} />
          {openPassed ? olderPassed.map((s) => <Row key={s.code} stop={s} dim />) : null}
        </>
      ) : null}

      {!complete && cur ? (
        <View style={styles.now}>
          <View style={styles.nowTag}><Ionicons name="train" size={14} color="#fff" /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.nowTitle} numberOfLines={1}>
              {atStation ? `At ${titleCase(cur.name || cur.code)}` : `${titleCase(cur.name || cur.code)} → ${next ? titleCase(next.name || next.code) : ""}`}
            </Text>
            <Text style={styles.nowSub}>
              {[speed != null ? `${speed} km/h` : null, !atStation && kmToNext != null ? `~${kmToNext} km between halts` : null, kmToDest != null ? `${kmToDest} km to destination` : null].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <Text style={styles.nowWord}>NOW</Text>
        </View>
      ) : null}

      {shownMids.map((s) => <Row key={s.code} stop={s} actions={!complete} />)}
      {hiddenMids > 0 ? (
        <FoldRow label={openMore ? "Show fewer halts" : `${hiddenMids} more halt${hiddenMids > 1 ? "s" : ""}`} open={openMore} onPress={() => setOpenMore((v) => !v)} />
      ) : null}

      <View style={styles.dest}>
        <View style={styles.destTop}>
          <Text style={[styles.time, { color: "#B45309" }]}>{stopEtaClock(dest) || "—"}</Text>
          <View style={styles.rail}><View style={[styles.dot, styles.dotDest]} /></View>
          <View style={styles.body}>
            <Text style={styles.name} numberOfLines={1}>{titleCase(dest.name || dest.code)}</Text>
            <Text style={styles.sub}>{`${dest.code}${dest.distance_km != null ? ` · ${dest.distance_km} km` : ""}${destDelay ? ` · ${destDelay > 0 ? "+" : ""}${destDelay} min` : ""}`}</Text>
          </View>
          <Text style={styles.endTag}>{complete ? "Arrived" : "Your stop"}</Text>
        </View>
        {!complete ? (
          <View style={styles.chipRow}>
            <TouchableOpacity onPress={() => onAlarm(dest)} style={[styles.chip, destAlarmOn && styles.chipOn]} activeOpacity={0.8}>
              <Ionicons name="alarm" size={14} color={destAlarmOn ? "#fff" : "#B45309"} />
              <Text style={[styles.chipText, destAlarmOn && { color: "#fff" }]}>{destAlarmOn && alarmTime ? `Alarm ${alarmTime}` : "Set alarm"}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onRide(dest)} style={styles.chip} activeOpacity={0.8}>
              <Ionicons name="car" size={14} color="#B45309" />
              <Text style={styles.chipText}>Ride</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
      {onJumpFull ? (
        <TouchableOpacity onPress={onJumpFull} style={{ paddingTop: spacing.sm }}>
          <Text style={styles.fullLink}>All stations — full running status</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#fff", borderRadius: 20, padding: 14, marginBottom: spacing.md, shadowColor: "#0B3D91", shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 52 },
  time: { width: 46, fontSize: 12.5, fontWeight: "700", color: colors.text },
  dim: { color: colors.textMuted },
  rail: { width: 26, alignItems: "center", justifyContent: "center", alignSelf: "stretch" },
  line: { position: "absolute", top: 0, bottom: 0, width: 2, backgroundColor: "transparent" },
  lineOn: { backgroundColor: "#D5DDEB" },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 3 },
  dotDone: { backgroundColor: "#2E8B57", borderColor: "#2E8B57" },
  dotNext: { backgroundColor: "#fff", borderColor: "#9FB0D3" },
  dotDest: { backgroundColor: "#E4570F", borderColor: "#E4570F", width: 14, height: 14, borderRadius: 7 },
  body: { flex: 1, paddingLeft: 6 },
  name: { fontSize: 14.5, fontWeight: "800", color: colors.text },
  sub: { fontSize: 11.5, color: colors.textMuted, marginTop: 1 },
  delay: { fontSize: 12.5, fontWeight: "800", marginLeft: 6 },
  late: { color: "#C62828" },
  early: { color: "#2E7D32" },
  fold: { flexDirection: "row", alignItems: "center", minHeight: 34, paddingLeft: 46 },
  foldText: { fontSize: 12.5, fontWeight: "700", color: colors.primary, paddingLeft: 6 },
  now: { flexDirection: "row", alignItems: "center", backgroundColor: "#E8F0FE", borderRadius: 14, padding: 10, marginVertical: 6 },
  nowTag: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", marginRight: 10 },
  nowTitle: { fontSize: 14.5, fontWeight: "800", color: colors.primary },
  nowSub: { fontSize: 11.5, color: colors.textMuted, marginTop: 2 },
  nowWord: { fontSize: 11, fontWeight: "800", color: colors.primary, letterSpacing: 1, marginLeft: 6 },
  dest: { backgroundColor: "#FFF4E5", borderWidth: 1, borderColor: "#F8CE95", borderRadius: 14, padding: 10, marginTop: 6 },
  destTop: { flexDirection: "row", alignItems: "center" },
  endTag: { fontSize: 11, fontWeight: "800", color: "#B45309" },
  chipRow: { flexDirection: "row", gap: 8, marginTop: 10, paddingLeft: 46 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: "#fff", borderWidth: 1, borderColor: "#F2B968", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  chipOn: { backgroundColor: "#2E7D32", borderColor: "#2E7D32" },
  chipText: { fontSize: 12.5, fontWeight: "800", color: "#B45309" },
  rowActions: { flexDirection: "row", gap: 6, marginLeft: 8 },
  mini: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#EAF0FB", alignItems: "center", justifyContent: "center" },
  miniOn: { backgroundColor: "#2E7D32" },
  fullLink: { textAlign: "center", fontSize: 12.5, fontWeight: "700", color: colors.primary },
});
