import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../../i18n/Localized";
import { getStationMap } from "../../api/railwayApi";
import { describeApiError } from "../../api/client";
import { st, useTrip, ToolHeader, TripForm, Pill, Note, formatIn } from "./stationShared";
import { PlatformScene } from "./stationScenes";

const FACILITY = {
  booking: { icon: "🎫", label: "Booking" },
  toilets: { icon: "🚻", label: "Toilets" },
  canteen: { icon: "🍽️", label: "Canteen" },
  water: { icon: "💧", label: "Water" },
  lift: { icon: "🛗", label: "Lift" },
  atm: { icon: "🏧", label: "ATM" },
  cloak_room: { icon: "🧳", label: "Cloak room" },
  waiting_room: { icon: "🛋️", label: "Waiting" },
  retiring_room: { icon: "🛏️", label: "Retiring" },
  lounge: { icon: "☕", label: "Lounge" },
  wifi: { icon: "📶", label: "WiFi" },
};
const STEP_ICON = { walk: "walk-outline", stairs: "trending-up-outline", lift: "swap-vertical-outline", enter: "enter-outline", flag: "flag-outline" };

const ROW_H = 44;
const ROW_GAP = 26;
const MAX_ROWS = 6;

/** Which platforms to draw: all of them when few, else PF1-2 plus the ones around the target. */
function visiblePlatforms(count, target) {
  if (count <= MAX_ROWS) return Array.from({ length: count }, (_, i) => i + 1);
  const set = new Set([1, 2, target - 1, target, target + 1].filter((p) => p >= 1 && p <= count));
  for (let p = count; set.size < MAX_ROWS && p >= 1; p--) set.add(p);
  return [...set].sort((a, b) => a - b);
}

/** Dots along a polyline, spaced ~10 px. */
function dotsAlong(points, gap = 10) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(1, Math.floor(len / gap));
    for (let k = 0; k < n; k++) out.push([x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Station Navigator — a schematic of the station (platforms, foot over
 * bridge, concourse facilities) with the walking route from the main entry
 * to the rider's platform/coach, step-by-step directions and a step-free
 * (lift) variant. The target platform comes from the live platform when a
 * train is given (see Platform Locator), or the platform picked here.
 */
export default function StationNavigatorView({ apiBaseUrl, onBack, initialTarget }) {
  const [trip, setTrip] = useTrip();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [stepFree, setStepFree] = useState(false);
  const [platform, setPlatform] = useState(initialTarget?.platform ? parseInt(initialTarget.platform, 10) || null : null);
  const [guideStep, setGuideStep] = useState(null);
  const [width, setWidth] = useState(0);
  const autoRan = useRef(false);

  const load = useCallback(async (t, opts = {}) => {
    if (!t?.station) return;
    setLoading(true); setError(null);
    try {
      const pf = opts.platform !== undefined ? opts.platform : platform;
      const res = await getStationMap(apiBaseUrl, t.station, {
        platform: pf || undefined,
        trainNumber: pf ? undefined : (t.trainNumber || undefined),
        coach: t.coach || undefined,
        stepFree: opts.stepFree !== undefined ? opts.stepFree : stepFree,
      });
      setData(res);
      setEditing(false);
      setGuideStep(null);
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, platform, stepFree]);

  useEffect(() => {
    if (autoRan.current || !trip.station) return;
    autoRan.current = true;
    load(trip);
  }, [trip.station]); // eslint-disable-line react-hooks/exhaustive-deps

  const showForm = editing || !data;
  const target = data?.target_platform;
  const rows = useMemo(() => (data ? visiblePlatforms(data.platform_count, target) : []), [data, target]);

  // ---- schematic geometry ------------------------------------------------
  const pad = 16;
  const top = 26; // room for the "FOB" label
  const platformsH = rows.length * ROW_H + (rows.length - 1) * ROW_GAP;
  const concourseTop = top + platformsH + 14;
  const concourseH = 120;
  const entryY = concourseTop + concourseH + 8;
  const mapH = entryY + 20 + 38 + 12;
  const fobX = width * 0.66;
  const fobW = 26;
  const entryX = width * 0.46;
  // Top row = highest platform; PF1 sits next to the concourse.
  const rowY = (pf) => {
    const idx = rows.length - 1 - rows.indexOf(pf);
    return top + idx * (ROW_H + ROW_GAP);
  };

  let route = [];
  if (data && width > 0 && rows.includes(target)) {
    const yT = rowY(target) + ROW_H / 2;
    const yC = concourseTop + concourseH - 36;
    const fobC = fobX + fobW / 2;
    const cp = data.coach_position;
    const endX = cp ? pad + 30 + cp.fraction * (width - 2 * pad - 60) : fobC + 70;
    // Entry -> across the concourse -> foot over bridge -> onto the platform -> coach.
    route = dotsAlong([[entryX, entryY], [entryX, yC], [fobC, yC], [fobC, yT], [endX, yT]]);
  }
  const routeEnd = route.length ? route[route.length - 1] : null;

  const coachLabel = data?.coach || trip.coach;
  const subtitle = data ? `${data.station_name} (${data.station}) · Ground floor` : "Walk to your platform";

  return (
    <View style={{ flex: 1, backgroundColor: st.bg }}>
      <ToolHeader
        title="Station Navigator" subtitle={subtitle} onBack={onBack}
        right={data && !showForm ? (
          <TouchableOpacity onPress={() => setEditing(true)} style={styles.changeBtn}>
            <Text style={styles.changeText}>Change</Text>
          </TouchableOpacity>
        ) : null}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        {showForm && (
          <TripForm
            apiBaseUrl={apiBaseUrl} trip={trip} setTrip={setTrip}
            fields={["station", "trainOptional", "coach"]}
            submitLabel="Show route" loading={loading} error={error}
            onSubmit={(p) => { setPlatform(null); load({ ...trip, ...p }, { platform: null }); }}
          />
        )}
        {loading && !data ? <ActivityIndicator color={st.blue} style={{ marginTop: 24 }} /> : null}

        {data && !showForm && (
          <>
            {/* Platform picker — switch the destination instantly. */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pfChips}>
              {Array.from({ length: data.platform_count }, (_, i) => i + 1).map((p) => (
                <TouchableOpacity
                  key={p}
                  onPress={() => { setPlatform(p); load(trip, { platform: p }); }}
                  style={[styles.pfChip, p === target && styles.pfChipOn]}
                >
                  <Text style={[styles.pfChipText, p === target && { color: "#fff" }]}>PF {p}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* The platform as you'll see it on arrival: PF board, station
                board, LED display and the train (when one was entered). */}
            <PlatformScene
              stationName={data.station_name}
              stationCode={data.station}
              platform={target}
              trainNumber={data.train?.train_number}
              trainName={data.train?.train_name}
              time={data.train?.expected_arrival}
              status={data.train
                ? (data.train.arrives_in_minutes != null && data.train.arrives_in_minutes <= 0 && data.train.arrives_in_minutes > -5
                  ? "Arriving" : data.train.arrives_in_minutes != null ? formatIn(data.train.arrives_in_minutes) : "Expected")
                : "Welcome"}
              rake={data.train?.rake}
              coach={coachLabel}
            />

            <View style={[styles.map, { height: mapH }]} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
              {width > 0 && (
                <>
                  {rows.map((pf, i) => {
                    const y = rowY(pf);
                    const on = pf === target;
                    const prev = rows[i - 1];
                    return (
                      <React.Fragment key={pf}>
                        <View style={[styles.platform, { top: y, left: pad, right: pad }, on && styles.platformOn]}>
                          <Text style={[styles.platformText, on && { color: st.blue }]}>PF {pf}</Text>
                        </View>
                        {/* Track between two drawn platforms (a gap marker if some are skipped). */}
                        {i < rows.length - 1 ? (
                          <View style={[styles.track, { top: y - ROW_GAP / 2 - 1, left: pad, right: pad }]} />
                        ) : null}
                        {prev != null && pf - prev > 1 ? (
                          <Text style={[styles.gapText, { top: y + ROW_H + 4 }]}>⋯ PF {prev + 1}–{pf - 1}</Text>
                        ) : null}
                      </React.Fragment>
                    );
                  })}
                  <Text style={[styles.fobLabel, { left: fobX - 2 }]}>FOB</Text>
                  <View style={[styles.fob, { left: fobX, width: fobW, top: top - 6, height: concourseTop - top + 6 }]} />
                  {/* Concourse with its facilities */}
                  <View style={[styles.concourse, { top: concourseTop, left: pad, right: pad, height: concourseH }]}>
                    <View style={styles.facilityGrid}>
                      {data.concourse_facilities.slice(0, 8).map((f) => {
                        const meta = FACILITY[f];
                        if (!meta) return null;
                        const confirmed = data.facilities_confirmed?.includes(f);
                        return (
                          <View key={f} style={styles.facility}>
                            <Text style={{ fontSize: 20 }} noTranslate>{meta.icon}</Text>
                            <Text style={[styles.facilityText, confirmed && { color: st.ink, fontWeight: "700" }]}>{meta.label}</Text>
                          </View>
                        );
                      })}
                    </View>
                  </View>
                  {route.map(([x, y], i) => (
                    <View key={i} style={[styles.dot, { left: x - 3.5, top: y - 3.5 }, guideStep != null && styles.dotGuide]} />
                  ))}
                  {routeEnd ? (
                    <View style={[styles.endPin, { left: routeEnd[0] - 11, top: routeEnd[1] - 11 }]}>
                      <Ionicons name="flag" size={12} color="#fff" />
                    </View>
                  ) : null}
                  <View style={[styles.youHalo, { left: entryX - 18, top: entryY - 18 }]}>
                    <View style={styles.you} />
                  </View>
                  <View style={[styles.entry, { top: entryY + 20, left: entryX - 60 }]}>
                    <Text style={styles.entryText}>Main Entry</Text>
                  </View>
                </>
              )}
            </View>

            {/* Bottom sheet */}
            <View style={styles.sheet}>
              <View style={styles.sheetHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sheetKicker}>
                    To {coachLabel ? `Coach ${coachLabel} · ` : ""}Platform {target}
                  </Text>
                  <Text style={styles.sheetTitle}>{data.walk_minutes} min walk · {data.walk_meters} m</Text>
                </View>
                {data.train?.arrives_in_minutes != null ? (
                  <Pill
                    bg={data.train.arrives_in_minutes < 10 ? "#FEE2E2" : st.greenSoft}
                    color={data.train.arrives_in_minutes < 10 ? st.red : "#15803D"}
                    text={`Train ${formatIn(data.train.arrives_in_minutes)}`}
                  />
                ) : null}
              </View>
              {data.platform_source && data.platform_source.startsWith("estimate") ? (
                <Text style={styles.sheetWarn}>Platform is an estimate — no live platform for this train yet.</Text>
              ) : null}

              {data.steps.map((s, i) => {
                const active = guideStep === i;
                const done = guideStep != null && i < guideStep;
                return (
                  <View key={i} style={[styles.step, active && styles.stepActive]}>
                    <View style={[styles.stepNum, (active || done) && { backgroundColor: st.blue }]}>
                      {done ? <Ionicons name="checkmark" size={14} color="#fff" /> : (
                        <Text style={[styles.stepNumText, active && { color: "#fff" }]}>{i + 1}</Text>
                      )}
                    </View>
                    <Ionicons name={STEP_ICON[s.icon] || "walk-outline"} size={16} color={st.muted} style={{ marginRight: 6 }} />
                    <Text style={[styles.stepText, done && { color: st.muted }]}>{s.text} · {s.meters} m</Text>
                  </View>
                );
              })}

              <View style={styles.sheetBtns}>
                {guideStep == null ? (
                  <TouchableOpacity style={styles.startBtn} onPress={() => setGuideStep(0)}>
                    <Text style={styles.startText}>▶ Start</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={styles.startBtn}
                    onPress={() => setGuideStep((g) => (g + 1 >= data.steps.length ? null : g + 1))}
                  >
                    <Text style={styles.startText}>{guideStep + 1 >= data.steps.length ? "✓ Arrived" : "Next step ▶"}</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.freeBtn, stepFree && styles.freeBtnOn]}
                  onPress={() => { const v = !stepFree; setStepFree(v); load(trip, { stepFree: v }); }}
                  accessibilityState={{ selected: stepFree }}
                >
                  <Text style={[styles.freeText, stepFree && { color: st.blue }]}>♿ Step-free{stepFree ? " ✓" : ""}</Text>
                </TouchableOpacity>
              </View>
              {loading ? <ActivityIndicator color={st.blue} style={{ marginTop: 10 }} /> : null}
              {error ? <Text style={{ color: st.red, marginTop: 8 }}>{error}</Text> : null}
            </View>

            {data.entrance_sides?.length ? (
              <View style={styles.infoCard}>
                <Text style={styles.infoTitle}>Entrances</Text>
                {data.entrance_sides.map((e, i) => <Text key={i} style={styles.infoLine}>• {e}</Text>)}
                {data.notable_note ? <Text style={styles.infoLine}>{data.notable_note}</Text> : null}
              </View>
            ) : null}
            <Note text={data.disclaimer} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  pfChips: { gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  pfChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: st.card, borderWidth: 1, borderColor: st.line },
  pfChipOn: { backgroundColor: st.blue, borderColor: st.blue },
  pfChipText: { fontSize: 13, fontWeight: "700", color: st.ink },
  map: { backgroundColor: "#EEF2F7", marginHorizontal: 0 },
  fobLabel: { position: "absolute", top: 6, fontSize: 11, fontWeight: "800", color: "#475569" },
  fob: { position: "absolute", backgroundColor: st.fob, borderRadius: 4 },
  platform: { position: "absolute", height: ROW_H, borderRadius: 8, backgroundColor: st.platform, justifyContent: "center", paddingLeft: 12 },
  platformOn: { backgroundColor: st.blueSoft, borderWidth: 1.5, borderColor: "#93B4F5" },
  platformText: { fontSize: 13, fontWeight: "800", color: "#334155" },
  track: { position: "absolute", height: 0, borderTopWidth: 2, borderStyle: "dashed", borderColor: "#A5B0C2" },
  gapText: { position: "absolute", left: 20, fontSize: 10, color: st.muted },
  concourse: {
    position: "absolute", backgroundColor: "#fff", borderRadius: 14, borderWidth: 1, borderColor: st.line,
    paddingHorizontal: 8, paddingVertical: 10,
  },
  facilityGrid: { flexDirection: "row", flexWrap: "wrap", rowGap: 8 },
  facility: { width: "25%", alignItems: "center", gap: 2 },
  facilityText: { fontSize: 10.5, color: st.muted },
  dot: { position: "absolute", width: 7, height: 7, borderRadius: 3.5, backgroundColor: st.blue },
  dotGuide: { backgroundColor: "#1D4ED8" },
  endPin: {
    position: "absolute", width: 22, height: 22, borderRadius: 11, backgroundColor: st.blue,
    alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#fff",
  },
  youHalo: { position: "absolute", width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(37,99,235,0.18)", alignItems: "center", justifyContent: "center" },
  you: { width: 18, height: 18, borderRadius: 9, backgroundColor: st.blue, borderWidth: 2, borderColor: "#fff" },
  entry: { position: "absolute", width: 120, height: 38, borderRadius: 10, backgroundColor: st.ink, alignItems: "center", justifyContent: "center" },
  entryText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  sheet: {
    backgroundColor: st.card, marginTop: -6, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 18,
    shadowColor: "#0F1B33", shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: -4 }, elevation: 6,
  },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 12 },
  sheetKicker: { fontSize: 13, color: st.muted },
  sheetTitle: { fontSize: 24, fontWeight: "900", color: st.ink, marginTop: 2 },
  sheetWarn: { fontSize: 12, color: st.amber, marginBottom: 8 },
  step: { flexDirection: "row", alignItems: "center", paddingVertical: 7, paddingHorizontal: 6, borderRadius: 12 },
  stepActive: { backgroundColor: st.blueSoft },
  stepNum: { width: 28, height: 28, borderRadius: 14, backgroundColor: st.blueSoft, alignItems: "center", justifyContent: "center", marginRight: 10 },
  stepNumText: { color: st.blue, fontWeight: "800", fontSize: 13 },
  stepText: { flex: 1, fontSize: 14.5, color: st.ink },
  sheetBtns: { flexDirection: "row", gap: 10, marginTop: 14 },
  startBtn: { flex: 1, backgroundColor: st.blue, borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  startText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  freeBtn: { flex: 1, backgroundColor: "#EEF2F7", borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  freeBtnOn: { backgroundColor: st.blueSoft, borderWidth: 1, borderColor: st.blue },
  freeText: { color: st.ink, fontWeight: "800", fontSize: 15 },
  changeBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: st.blueSoft },
  changeText: { color: st.blue, fontWeight: "700", fontSize: 13 },
  infoCard: { backgroundColor: st.card, marginHorizontal: 16, marginTop: 14, borderRadius: 16, padding: 14 },
  infoTitle: { fontSize: 14, fontWeight: "800", color: st.ink, marginBottom: 4 },
  infoLine: { fontSize: 12.5, color: st.muted, marginTop: 2 },
});
