import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, StyleSheet, TouchableOpacity, Linking, Platform, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../../i18n/Localized";
import { getPickupPoints, getPickupRoute, getWalkRoute } from "../../api/railwayApi";
import { describeApiError } from "../../api/client";
import { openRide } from "../../components/BookRideCard";
import { speak, stopSpeaking, isSpeechSupported } from "../../utils/speakNotifications";
import { st } from "./stationShared";
import { guideTick, newGuideState } from "../../utils/walkGuide";

const STEP_ICON = { walk: "walk-outline", stairs: "trending-up-outline", lift: "swap-vertical-outline", enter: "enter-outline", flag: "flag-outline" };

function openUrl(url) {
  if (Platform.OS === "web") { try { window.open(url, "_blank", "noopener"); return; } catch (e) { /* fall through */ } }
  Linking.openURL(url).catch(() => {});
}

/** Google Maps walking directions to the point (by coordinates when they are
 *  known, else by place name), opened in the Maps app or the browser. */
function mapsUrl(route) {
  const p = route.point;
  const dest = p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : route.maps_query;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=walking`;
}

/**
 * Cab pickup points for the station, with step-by-step walking guidance to the
 * chosen one: tap a point, then "Start" - each step is shown AND read aloud;
 * "Next" moves on, "Repeat" reads it again. Also opens Google Maps walking
 * directions and the Uber / Ola apps for the ride itself.
 */
export default function PickupGuide({ apiBaseUrl, station, stationName, platform, stepFree }) {
  const [points, setPoints] = useState([]);
  const [pointId, setPointId] = useState(null);
  const [route, setRoute] = useState(null);
  const [step, setStep] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [voice, setVoice] = useState(true);
  const voiceRef = useRef(true);
  voiceRef.current = voice;

  // Live GPS guidance (Google-Maps style): follows the phone and speaks turns.
  const [live, setLive] = useState(null); // { info, note } while guiding
  const subRef = useRef(null);
  const liveRef = useRef({ route: null, state: null, fetching: false, lastFetch: 0 });
  const stopLive = useCallback(() => {
    if (subRef.current) { try { subRef.current.remove(); } catch (e) { /* ignore */ } subRef.current = null; }
    liveRef.current = { route: null, state: null, fetching: false, lastFetch: 0 };
    setLive(null);
  }, []);
  useEffect(() => stopLive, [stopLive]);

  useEffect(() => {
    let alive = true;
    setPoints([]); setPointId(null); setRoute(null); setStep(null); setError(null);
    if (!station) return undefined;
    getPickupPoints(apiBaseUrl, station).then((r) => { if (alive) setPoints(r.points || []); }).catch(() => {});
    return () => { alive = false; stopSpeaking(); };
  }, [apiBaseUrl, station]);

  const choose = useCallback(async (id) => {
    setPointId(id); setStep(null); setRoute(null); setError(null); setLoading(true);
    stopSpeaking(); stopLive();
    try { setRoute(await getPickupRoute(apiBaseUrl, station, { point: id, platform, stepFree })); }
    catch (e) { setError(describeApiError(e)); }
    finally { setLoading(false); }
  }, [apiBaseUrl, station, platform, stepFree, stopLive]);

  async function startLive(point) {
    if (point.lat == null || point.lng == null) {
      setError("This pickup point has no map position yet — use the Google Maps button.");
      return;
    }
    setError(null);
    try {
      const Location = require("expo-location");
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") { setError("Location permission denied — allow it to get live guidance."); return; }
      const dest = { lat: point.lat, lng: point.lng };
      liveRef.current = { route: null, state: newGuideState(), fetching: false, lastFetch: 0 };
      setLive({ info: null, note: "Finding your position…" });
      const onFix = async (loc) => {
        const L = liveRef.current;
        const pos = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        const needRoute = !L.route || L.needReroute;
        if (needRoute && !L.fetching && Date.now() - L.lastFetch > 15000) {
          L.fetching = true; L.lastFetch = Date.now();
          try {
            L.route = await getWalkRoute(apiBaseUrl, pos, dest);
            L.state = newGuideState(); L.needReroute = false;
            if (voiceRef.current && L.route.fallback) speak("Walking map is unavailable, so I will only give the direction and distance.", { force: true });
          } catch (e) { setLive({ info: null, note: "Couldn't get walking directions right now. Retrying…" }); }
          L.fetching = false;
        }
        if (!L.route) return;
        const r = guideTick(L.state, pos, L.route, dest);
        L.state = r.state;
        if (r.offRoute) { L.needReroute = true; if (voiceRef.current && !L.offSaid) { L.offSaid = true; speak("You are off the route. Recalculating.", { force: true }); } return; }
        L.offSaid = false;
        r.say.forEach((t) => { if (voiceRef.current) speak(t, { force: true }); });
        setLive({ info: { remainingM: r.remainingM, nextText: r.nextText, nextDistM: r.nextDistM, arrived: r.arrived }, note: null });
        if (r.arrived) stopLive();
      };
      subRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 4 }, onFix,
      );
    } catch (e) {
      setError("Couldn't read your GPS location right now.");
      stopLive();
    }
  }

  // Re-plan when the platform / step-free choice changes under a chosen point.
  useEffect(() => { if (pointId) choose(pointId); }, [platform, stepFree]); // eslint-disable-line react-hooks/exhaustive-deps

  const say = useCallback((i, r) => {
    if (!voiceRef.current || !r) return;
    const s = r.steps[i];
    if (s) speak(`Step ${i + 1}. ${s.text}.`, { force: true });
  }, []);

  function start() { setStep(0); say(0, route); }
  function next() {
    const n = step + 1;
    if (n >= route.steps.length) {
      setStep(null);
      if (voiceRef.current) speak(`You have reached the ${route.point.name} pickup point. You can book your cab now.`, { force: true });
    } else { setStep(n); say(n, route); }
  }

  if (!points.length) return null;
  const chosen = points.find((p) => p.id === pointId);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>🚕 Cab pickup points</Text>
      <Text style={styles.sub}>Pick where you want your cab to meet you at {stationName || station}. Tap “Guide me with GPS” and we'll direct you there, turn by turn, by voice.</Text>
      <View style={styles.chips}>
        {points.map((p) => (
          <TouchableOpacity key={p.id} onPress={() => choose(p.id)} style={[styles.chip, p.id === pointId && styles.chipOn]}>
            <Text style={[styles.chipText, p.id === pointId && { color: "#fff" }]}>{p.name}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {loading ? <ActivityIndicator color={st.blue} style={{ marginTop: 10 }} /> : null}
      {error ? <Text style={{ color: st.red, marginTop: 8 }}>{error}</Text> : null}

      {route && chosen ? (
        <View style={{ marginTop: 12 }}>
          <Text style={styles.head}>PF {route.platform} → {route.point.name} · about {route.walk_minutes} min walk</Text>
          {route.steps.map((s, i) => (
            <View key={i} style={[styles.step, step === i && styles.stepOn]}>
              <View style={[styles.num, (step === i || (step != null && i < step)) && { backgroundColor: st.blue }]}>
                {step != null && i < step
                  ? <Ionicons name="checkmark" size={14} color="#fff" />
                  : <Text style={[styles.numText, step === i && { color: "#fff" }]}>{i + 1}</Text>}
              </View>
              <Ionicons name={STEP_ICON[s.icon] || "walk-outline"} size={16} color={st.muted} style={{ marginRight: 6 }} />
              <Text style={styles.stepText}>{s.text}{s.meters ? ` · ${s.meters} m` : ""}</Text>
            </View>
          ))}
          <View style={styles.row}>
            {step == null ? (
              <TouchableOpacity style={styles.primary} onPress={start}><Text style={styles.primaryText}>▶ Start guidance</Text></TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity style={styles.primary} onPress={next}>
                  <Text style={styles.primaryText}>{step + 1 >= route.steps.length ? "✓ Arrived" : "Next step ▶"}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.secondary} onPress={() => say(step, route)}><Text style={styles.secondaryText}>🔁 Repeat</Text></TouchableOpacity>
              </>
            )}
            {isSpeechSupported() ? (
              <TouchableOpacity style={styles.secondary} onPress={() => { if (voice) stopSpeaking(); setVoice(!voice); }}>
                <Text style={styles.secondaryText}>{voice ? "🔊 Voice on" : "🔇 Voice off"}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          <View style={styles.row}>
            {live ? (
              <TouchableOpacity style={[styles.primary, { backgroundColor: st.red }]} onPress={() => { stopLive(); stopSpeaking(); }}>
                <Text style={styles.primaryText}>■ Stop live guidance</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.primary} onPress={() => startLive(chosen)}>
                <Text style={styles.primaryText}>📍 Guide me with GPS</Text>
              </TouchableOpacity>
            )}
          </View>
          {live ? (
            <View style={styles.liveBox}>
              {live.info ? (
                <>
                  <Text style={styles.liveNext}>{live.info.nextText}</Text>
                  <Text style={styles.liveMeta}>
                    {live.info.nextDistM != null ? `in ${live.info.nextDistM} m · ` : ""}{live.info.remainingM} m to {route.point.name}
                  </Text>
                </>
              ) : <Text style={styles.liveMeta}>{live.note}</Text>}
            </View>
          ) : null}
          <View style={styles.row}>
            <TouchableOpacity style={styles.secondary} onPress={() => openUrl(mapsUrl(route))}><Text style={styles.secondaryText}>🗺️ Google Maps (walk)</Text></TouchableOpacity>
            <TouchableOpacity style={styles.secondary} onPress={() => openRide("uber", { name: stationName || station, code: station, lat: chosen.lat, lng: chosen.lng })}><Text style={styles.secondaryText}>Uber</Text></TouchableOpacity>
            <TouchableOpacity style={styles.secondary} onPress={() => openRide("ola", { name: stationName || station, code: station, lat: chosen.lat, lng: chosen.lng })}><Text style={styles.secondaryText}>Ola</Text></TouchableOpacity>
          </View>
          <Text style={styles.note}>{route.disclaimer}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: st.card, marginHorizontal: 16, marginTop: 14, borderRadius: 16, padding: 14 },
  title: { fontSize: 15, fontWeight: "800", color: st.ink },
  sub: { fontSize: 12.5, color: st.muted, marginTop: 2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: "#EEF2F7", borderWidth: 1, borderColor: st.line },
  chipOn: { backgroundColor: st.blue, borderColor: st.blue },
  chipText: { fontSize: 13, fontWeight: "700", color: st.ink },
  head: { fontSize: 14, fontWeight: "800", color: st.ink, marginBottom: 6 },
  step: { flexDirection: "row", alignItems: "center", paddingVertical: 7, paddingHorizontal: 6, borderRadius: 12 },
  stepOn: { backgroundColor: st.blueSoft },
  num: { width: 26, height: 26, borderRadius: 13, backgroundColor: st.blueSoft, alignItems: "center", justifyContent: "center", marginRight: 8 },
  numText: { color: st.blue, fontWeight: "800", fontSize: 12 },
  stepText: { flex: 1, fontSize: 14, color: st.ink },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  primary: { flexGrow: 1, backgroundColor: st.blue, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center" },
  primaryText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  secondary: { backgroundColor: "#EEF2F7", borderRadius: 999, paddingVertical: 12, paddingHorizontal: 14, alignItems: "center" },
  secondaryText: { color: st.ink, fontWeight: "700", fontSize: 13 },
  liveBox: { backgroundColor: st.blueSoft, borderRadius: 14, padding: 12, marginTop: 10 },
  liveNext: { fontSize: 16, fontWeight: "800", color: st.ink },
  liveMeta: { fontSize: 13, color: st.muted, marginTop: 2 },
  note: { fontSize: 11.5, color: st.muted, marginTop: 10 },
});
