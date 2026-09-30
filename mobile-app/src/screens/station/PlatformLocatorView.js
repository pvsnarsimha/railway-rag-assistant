import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, View, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../../i18n/Localized";
import { locatePlatform } from "../../api/railwayApi";
import { describeApiError } from "../../api/client";
import { scheduleLocalAlarm, ensureLocalNotificationPermission } from "../../services/pushNotifications";
import { enablePlatformAlert, disablePlatformAlert } from "../../services/backgroundTracking";
import {
  st, useTrip, ToolHeader, TripForm, Pill, CoachStrip, SectionLabel, Note, formatIn,
} from "./stationShared";
import { PlatformScene, CoachSeatMap, CoachPositionScene } from "./stationScenes";

const SEEN_KEY = "stationTools.platformSeen";
const ALERT_KEY = "stationTools.platformAlerts";
const POLL_MS = 60 * 1000;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const SOURCE_BADGE = {
  station_board_railkit: { text: "✓ Confirmed by station", bg: st.green, color: "#fff" },
  station_board_rapidapi: { text: "✓ Confirmed by station", bg: st.green, color: "#fff" },
  railradar_live: { text: "Expected · RailRadar", bg: "#3B82F6", color: "#fff" },
  railradar_coach_alignment: { text: "Expected · RailRadar", bg: "#3B82F6", color: "#fff" },
  estimate: { text: "Estimate only", bg: "#475569", color: "#fff" },
};

/**
 * Platform Locator (mode="platform") and Coach Position (mode="coach").
 * Same data — which platform the train comes in on, the real rake and
 * where the rider's coach stops — with the coach strip leading in coach
 * mode. The platform is re-checked every minute while the screen is open.
 * "Alert on change" also registers the trip with the server, which keeps
 * checking and sends a push the moment the platform changes — with the
 * app open or closed.
 */
export default function PlatformLocatorView({ apiBaseUrl, onBack, onNavigate, mode = "platform" }) {
  const [trip, setTrip] = useTrip();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [change, setChange] = useState(null);
  const [alertOn, setAlertOn] = useState(false);
  const autoRan = useRef(false);
  const [alertNote, setAlertNote] = useState(null);
  const alertRef = useRef(false);
  // True once the server is watching: its push then covers the change, so
  // the app doesn't also fire its own local notification (a duplicate).
  const serverWatchRef = useRef(false);
  alertRef.current = alertOn;

  const run = useCallback(async (t, { quiet } = {}) => {
    if (!t?.trainNumber || !t?.station) return;
    quiet ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const res = await locatePlatform(apiBaseUrl, {
        trainNumber: t.trainNumber, station: t.station, coach: t.coach || undefined, berth: t.berth || undefined,
      });
      setData(res);
      setEditing(false);
      await checkChange(t, res);
    } catch (e) {
      setError(describeApiError(e));
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [apiBaseUrl]);

  // Remember the last platform seen per train/station/day; a different
  // one on a later check is a platform change.
  async function checkChange(t, res) {
    const key = `${t.trainNumber}:${res.station}:${todayKey()}`;
    let seen = {};
    try { seen = JSON.parse((await AsyncStorage.getItem(SEEN_KEY)) || "{}") || {}; } catch (e) { seen = {}; }
    const prev = seen[key];
    if (prev && prev.platform && res.platform && prev.platform !== res.platform) {
      const notified = alertRef.current;
      if (notified && !serverWatchRef.current) {
        scheduleLocalAlarm(
          `Platform changed: ${t.trainNumber}`,
          `Now arriving at ${res.station_name || res.station} on PF ${res.platform} (was PF ${prev.platform}).`,
          1,
        );
      }
      setChange({ from: prev.platform, to: res.platform, at: nowHHMM(), notified });
      if (notified) enablePlatformAlert(apiBaseUrl, { trainNumber: t.trainNumber, station: res.station, platform: res.platform }).catch(() => {});
    }
    // Keep only today's entries so the store stays tiny.
    const next = Object.fromEntries(Object.entries(seen).filter(([k]) => k.endsWith(todayKey())));
    next[key] = { platform: res.platform, at: nowHHMM() };
    AsyncStorage.setItem(SEEN_KEY, JSON.stringify(next)).catch(() => {});
  }

  // Open straight on the result when the trip is already known.
  useEffect(() => {
    if (autoRan.current) return;
    if (trip.trainNumber && trip.station) { autoRan.current = true; run(trip); }
  }, [trip.trainNumber, trip.station]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the platform number fresh while the screen is open (it used to
  // refresh only with the alert on, so the shown platform went stale).
  useEffect(() => {
    if (!data || editing) return undefined;
    const id = setInterval(() => run(trip, { quiet: true }), POLL_MS);
    return () => clearInterval(id);
  }, [data, editing, trip, run]);

  // Re-check when the app comes back to the foreground.
  useEffect(() => {
    if (!data) return undefined;
    const sub = AppState.addEventListener("change", (st2) => { if (st2 === "active") run(trip, { quiet: true }); });
    return () => sub.remove();
  }, [data, trip, run]);

  // Restore "Alert is on" for this train + station (and refresh the server watch).
  const alertKey = data ? `${data.train_number}:${data.station}` : null;
  useEffect(() => {
    if (!alertKey) return;
    let cancelled = false;
    AsyncStorage.getItem(ALERT_KEY).then((raw) => {
      let map = {};
      try { map = JSON.parse(raw || "{}") || {}; } catch (e) { map = {}; }
      if (cancelled || !map[alertKey]) return;
      setAlertOn(true);
      enablePlatformAlert(apiBaseUrl, { trainNumber: data.train_number, station: data.station, platform: data.platform })
        .then((r) => { serverWatchRef.current = !!r.ok; }).catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [alertKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleAlert() {
    if (!data) return;
    const turnOn = !alertOn;
    setAlertOn(turnOn);
    setAlertNote(null);
    let map = {};
    try { map = JSON.parse((await AsyncStorage.getItem(ALERT_KEY)) || "{}") || {}; } catch (e) { map = {}; }
    if (turnOn) {
      ensureLocalNotificationPermission();
      map[alertKey] = Date.now();
      const r = await enablePlatformAlert(apiBaseUrl, { trainNumber: data.train_number, station: data.station, platform: data.platform });
      serverWatchRef.current = !!r.ok;
      if (!r.ok) setAlertNote(r.reason);
    } else {
      delete map[alertKey];
      serverWatchRef.current = false;
      disablePlatformAlert(apiBaseUrl, { trainNumber: data.train_number, station: data.station }).catch(() => {});
    }
    AsyncStorage.setItem(ALERT_KEY, JSON.stringify(map)).catch(() => {});
  }

  const isCoach = mode === "coach";
  const title = isCoach ? "Coach Position" : "Platform Locator";
  const subtitle = data
    ? `${data.train_number}${data.train_name ? ` · ${data.train_name}` : ""}`
    : isCoach ? "Where to stand for your coach" : "Live platform number";
  const showForm = editing || !data;

  const badge = data ? (SOURCE_BADGE[data.platform_source] || SOURCE_BADGE.estimate) : null;
  const arrTime = data?.scheduled_arrival || data?.scheduled_departure;
  const expTime = data?.expected_arrival || data?.expected_departure;
  const coachLabel = data?.coach || trip.coach;

  // LED-board status line for the platform scene.
  const sceneStatus = !data ? null
    : data.cancelled ? { text: "Cancelled", color: "#F87171" }
    : data.arrives_in_minutes != null && data.arrives_in_minutes <= 0 && data.arrives_in_minutes > -5 ? { text: "Arriving", color: "#4ADE80" }
    : data.delay_minutes > 0 ? { text: `Late ${data.delay_minutes} min`, color: "#FB923C" }
    : data.delay_minutes === 0 ? { text: "On time", color: "#4ADE80" }
    : { text: data.arrives_in_minutes != null ? formatIn(data.arrives_in_minutes) : "Expected", color: "#4ADE80" };

  const scene = data && (
    <PlatformScene
      stationName={data.station_name || trip.stationName || data.station}
      stationCode={data.station}
      platform={data.platform}
      trainNumber={data.train_number}
      trainName={data.train_name}
      time={expTime || arrTime}
      status={sceneStatus?.text}
      statusColor={sceneStatus?.color}
      rake={data.rake}
      coach={coachLabel}
    />
  );

  const rakeEntry = data?.rake?.find((c) => String(c.code || "").toUpperCase() === String(coachLabel || "").toUpperCase());
  const seatMap = data && coachLabel ? (
    <CoachSeatMap
      apiBaseUrl={apiBaseUrl}
      coach={String(coachLabel).toUpperCase()}
      category={rakeEntry?.category}
      trainNumber={data.train_number}
      trainName={data.train_name}
      berth={data.berth?.berth ?? trip.berth}
      position={data.coach_position}
    />
  ) : null;

  const platformCard = data && (
    <View style={[styles.hero, styles.heroCompact]}>
      <Text style={styles.heroKicker}>
        {data.cancelled ? "Cancelled today at" : "Arriving at"} {data.station_name || data.station} on
      </Text>
      <Text style={[styles.heroNumber, { fontSize: 64, lineHeight: 72 }]} noTranslate>{data.platform || "—"}</Text>
      <Text style={styles.heroLabel}>PLATFORM</Text>
      <View style={styles.heroPills}>
        {arrTime ? (
          <Pill
            bg="rgba(255,255,255,0.14)" color="#E6ECFA"
            text={expTime && expTime !== arrTime ? `Arr ${arrTime} → ${expTime}` : `Arr ${arrTime}`}
          />
        ) : null}
        {badge ? <Pill bg={badge.bg} color={badge.color} text={badge.text} /> : null}
      </View>
      {data.arrives_in_minutes != null && !data.cancelled ? (
        <Text style={styles.heroIn}>
          {formatIn(data.arrives_in_minutes)}
          {data.delay_minutes > 0 ? ` · running ${data.delay_minutes} min late` : data.delay_minutes === 0 ? " · on time" : ""}
        </Text>
      ) : null}
      {data.platform_source === "estimate" && data.alternate_platform ? (
        <Text style={styles.heroIn}>No live platform yet — could also be PF {data.alternate_platform}</Text>
      ) : null}
    </View>
  );

  const pickCoach = (code) => { const t = { ...trip, coach: code }; setTrip({ coach: code }); run(t, { quiet: true }); };

  const coachSection = data && (
    <View style={{ marginHorizontal: 16 }}>
      <Text style={styles.coachHead}>COACH POSITION · ENGINE → REAR</Text>
      {data.rake?.length ? (
        <>
          {isCoach ? (
            <CoachPositionScene rake={data.rake} coach={coachLabel} onPickCoach={pickCoach} />
          ) : (
            <CoachStrip rake={data.rake} coach={coachLabel} onPickCoach={pickCoach} />
          )}
          {coachLabel && data.coach_found_in_rake === false ? (
            <Text style={styles.warnText}>Coach {coachLabel} isn't in today's formation — tap your coach above.</Text>
          ) : !coachLabel ? (
            <Text style={styles.hint}>Tap your coach to see where to stand{isCoach ? " and its seat layout" : ""}.</Text>
          ) : null}
        </>
      ) : (
        <View style={styles.noRake}>
          <Ionicons name="information-circle-outline" size={18} color={st.muted} />
          <Text style={styles.noRakeText}>
            RailRadar has no coach formation for this train today. Check the coach position display on the platform.
          </Text>
        </View>
      )}
    </View>
  );

  const berth = data?.berth;
  const pos = data?.coach_position;
  const berthCard = data && (berth || pos) && (
    <View style={styles.berthCard}>
      {berth ? (
        <Text style={styles.berthTitle}>
          Your berth: {coachLabel ? `${coachLabel} · ` : ""}{berth.berth}{berth.type ? ` (${berth.type})` : ""}
        </Text>
      ) : (
        <Text style={styles.berthTitle}>Coach {coachLabel}</Text>
      )}
      <Text style={styles.berthText}>
        {berth?.nearest_door ? `Door nearest to ${berth.berth} → ${berth.nearest_door} door of ${coachLabel || "your coach"}. ` : ""}
        {pos ? `Coach ${pos.index + 1} of ${pos.total} from the engine — stand at the ${pos.zone} of PF ${data.platform}.` : ""}
      </Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: st.bg }}>
      <ToolHeader
        title={title}
        subtitle={subtitle}
        onBack={onBack}
        right={data && !showForm ? (
          <TouchableOpacity onPress={() => setEditing(true)} style={styles.changeBtn}>
            <Text style={styles.changeText}>Change</Text>
          </TouchableOpacity>
        ) : null}
      />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => run(trip, { quiet: true })} />}
      >
        {showForm && (
          <TripForm
            apiBaseUrl={apiBaseUrl} trip={trip} setTrip={setTrip}
            fields={["train", "station", "coach", "berth"]}
            submitLabel={isCoach ? "Find my coach" : "Find platform"}
            loading={loading} error={error}
            onSubmit={(patch) => run({ ...trip, ...patch })}
          />
        )}
        {loading && !data ? <ActivityIndicator color={st.blue} style={{ marginTop: 24 }} /> : null}
        {!showForm && error ? <Text style={styles.errorBar}>{error}</Text> : null}

        {data && !showForm && (
          <>
            {isCoach ? coachSection : scene}
            {isCoach ? seatMap : null}
            {change ? (
              <View style={styles.changeBanner}>
                <Text style={styles.changeBannerText}>
                  ⚠️ Changed from <Text style={{ fontWeight: "800" }}>PF {change.from}</Text> at {change.at}
                  {change.notified ? " — we notified you" : ""}
                </Text>
              </View>
            ) : null}
            {isCoach ? platformCard : (
              <>
                {platformCard}
                {coachSection}
              </>
            )}
            {berthCard}
            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.navBtn}
                onPress={() => onNavigate && onNavigate({ platform: data.platform, coach: coachLabel })}
              >
                <Text style={styles.navBtnText}>🗺️ Navigate to {coachLabel || `PF ${data.platform}`}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.alertBtn, alertOn && styles.alertBtnOn]}
                onPress={toggleAlert}
                accessibilityState={{ selected: alertOn }}
              >
                <Text style={[styles.alertBtnText, alertOn && { color: st.blue }]}>
                  {alertOn ? "🔔 Alert is on" : "🔔 Alert on change"}
                </Text>
              </TouchableOpacity>
            </View>
            {alertOn ? (
              <Note text={alertNote
                ? `${alertNote} Re-checking every minute while this screen is open.`
                : "You'll get a notification if the platform changes — even when the app is closed."} />
            ) : null}
            <Note text={`Checked at ${data.checked_at} IST. ${data.disclaimer}`} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    marginHorizontal: 16, marginBottom: 14, borderRadius: 24, paddingVertical: 22, paddingHorizontal: 16,
    backgroundColor: st.navy, alignItems: "center",
    borderWidth: 1, borderColor: st.navy2,
    shadowColor: st.navy, shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5,
  },
  heroCompact: { paddingVertical: 16, marginTop: 14 },
  heroKicker: { color: "#C7D2EA", fontSize: 14 },
  heroNumber: { color: "#fff", fontSize: 96, fontWeight: "900", lineHeight: 104, marginTop: 2 },
  heroLabel: { color: "#fff", fontSize: 16, fontWeight: "800", letterSpacing: 0.5 },
  heroPills: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 14 },
  heroIn: { color: "#AFC0E3", fontSize: 12.5, marginTop: 10, textAlign: "center" },
  changeBanner: {
    marginHorizontal: 16, marginBottom: 14, borderRadius: 16, paddingVertical: 11, paddingHorizontal: 14,
    backgroundColor: st.amberSoft, borderWidth: 1, borderColor: st.amberLine,
  },
  changeBannerText: { color: st.ink, fontSize: 13.5 },
  coachHead: { fontSize: 12, fontWeight: "800", letterSpacing: 1.3, color: st.muted, marginBottom: 2 },
  hint: { fontSize: 12, color: st.muted, marginTop: 6 },
  warnText: { fontSize: 12, color: st.amber, marginTop: 6 },
  noRake: { flexDirection: "row", gap: 8, alignItems: "flex-start", backgroundColor: st.card, padding: 12, borderRadius: 14, marginTop: 6 },
  noRakeText: { flex: 1, fontSize: 12.5, color: st.muted },
  berthCard: {
    backgroundColor: st.card, marginHorizontal: 16, marginTop: 16, borderRadius: 18, padding: 16,
    shadowColor: "#0F1B33", shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 1,
  },
  berthTitle: { fontSize: 16, fontWeight: "800", color: st.ink },
  berthText: { fontSize: 12.5, color: st.muted, marginTop: 4, lineHeight: 17 },
  actions: { flexDirection: "row", gap: 10, marginHorizontal: 16, marginTop: 16 },
  navBtn: { flex: 1, backgroundColor: st.blue, borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  navBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  alertBtn: { flex: 1, backgroundColor: st.card, borderRadius: 999, paddingVertical: 14, alignItems: "center", borderWidth: 1, borderColor: st.line },
  alertBtnOn: { borderColor: st.blue, backgroundColor: st.blueSoft },
  alertBtnText: { color: st.ink, fontWeight: "800", fontSize: 14 },
  changeBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: st.blueSoft },
  changeText: { color: st.blue, fontWeight: "700", fontSize: 13 },
  errorBar: { color: st.red, marginHorizontal: 16, marginBottom: 10, fontSize: 13 },
});
