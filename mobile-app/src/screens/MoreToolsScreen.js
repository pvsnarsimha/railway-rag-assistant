import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { describeApiError } from "../api/client";
import { getReporterId } from "../utils/reporterId";
import { formatDelayDuration } from "../utils/formatDelay";
import {
  predictPlatform, getPantryMenu, getStationAmenities, getMyTrainsDashboard,
  getCoachLayout, getSeatRecommendation, compareRoutes, estimateRefund, buildFareHeatmap,
  checkDelayAlerts, getStationCrowd, getParcelInfo, getOfflineStationBundle, getJourneyTimeline,
  getProfileSummary, checkPacked, getAlternativePlan, getStationNow, planJourney,
  getDelayHistory, getPnrStatus, checkPnrWatchlist,
  predictDelay,
  registerPushToken, syncPushWatches,
  getPlatformNavigation, getDepartureReminder, checkSmartAlarm, getTransitOptimizer,
  getRouteTimelapse,
  getBookingWindow, findMyCoach, getStationNavigator, checkFareWatches, syncFareWatches,
} from "../api/railwayApi";
import { registerForPushNotifications } from "../services/pushNotifications";

const TOOLS = [
  { key: "platform", label: "🚉 Platform" },
  { key: "pantry", label: "🍽️ Pantry" },
  { key: "amenities", label: "🛋️ Amenities" },
  { key: "mytrains", label: "🧭 My Trains" },
  { key: "delayimpact", label: "⏱️ Delay Impact" },
  { key: "coach", label: "🚃 Coach Layout" },
  { key: "seat", label: "💺 Seat Picker" },
  { key: "compare", label: "⚖️ Route Compare" },
  { key: "refund", label: "💸 Refund" },
  { key: "heatmap", label: "🗓️ Fare Heatmap" },
  { key: "alerts", label: "🔔 Delay Alerts" },
  { key: "crowd", label: "👥 Station Crowd" },
  { key: "parcel", label: "📦 Parcel Tracking" },
  { key: "offline", label: "📴 Offline Stations" },
  { key: "gantt", label: "📊 Journey Timeline" },
  { key: "profile", label: "🙋 Travel Profile" },
  { key: "nearme", label: "📍 Near Me" },
  { key: "journeyplanner", label: "🗺️ Journey Planner" },
  { key: "delayhistory", label: "📈 Delay History" },
  { key: "pnrtrack", label: "🎫 PNR Tracking" },
  { key: "departure", label: "🕐 When Should I Leave?" },
  { key: "platformnav", label: "🧭 Indoor Navigation" },
  { key: "smartalarm", label: "⏰ Smart Alarm" },
  { key: "transitoptimizer", label: "🚄 Transit Optimizer" },
  { key: "timelapse", label: "🎞️ Route Time-Lapse" },
  { key: "bookingwindow", label: "🎟️ Smart Booking" },
  { key: "stationnav", label: "🧭 Station Navigator" },
];
// NOTE: "Live Crowd Map for Train Coaches" and "Water/Restroom Availability
// Live Check" were removed — neither RailKit (RapidAPI) nor RailRadar
// exposes any real per-coach occupancy or water/restroom sensor feed.

const MY_TRAINS_KEY = "moreTools.myTrains";
const ALERTS_KEY = "moreTools.delayAlerts";
const PUSH_TOKEN_KEY = "moreTools.pushToken";
const OFFLINE_KEY = "moreTools.offlineStations";
const PROFILE_KEY = "moreTools.travelProfile";
const PNR_WATCH_KEY = "moreTools.pnrWatchlist";
const FARE_WATCH_KEY = "moreTools.fareWatches";

/* ---------------------------------------------------------------------
 * Shared bits
 * ------------------------------------------------------------------- */
function ResultBox({ children, style }) {
  if (!children) return null;
  return <View style={[styles.resultBox, style]}>{children}</View>;
}
function Disclaimer({ text }) {
  if (!text) return null;
  return <Text style={styles.disclaimer}>{text}</Text>;
}
function ErrorText({ text }) {
  if (!text) return null;
  return <Text style={styles.error}>{text}</Text>;
}
function Chips({ options, value, onSelect, multi, selected }) {
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => {
        const key = typeof opt === "string" ? opt : opt.key;
        const label = typeof opt === "string" ? opt : opt.label;
        const active = multi ? selected?.includes(key) : value === key;
        return (
          <TouchableOpacity key={key} style={[styles.chip, active && styles.chipActive]} onPress={() => onSelect(key)}>
            <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const CLASS_OPTIONS = ["SL", "3A", "2A", "1A", "3E", "CC", "EC", "2S"];

/* ---------------------------------------------------------------------
 * 1. Platform Predictor
 * ------------------------------------------------------------------- */
function PlatformTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [station, setStation] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!/^\d{5}$/.test(trainNumber) || !station.trim()) { setError("Enter a valid train number and station code."); return; }
    setLoading(true); setError(null);
    try { setData(await predictPlatform(apiBaseUrl, { trainNumber, station: station.trim() })); }
    catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Platform Predictor" subtitle="Pattern-based estimate — not a live/booked platform.">
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <LabeledInput label="Station code" value={station} onChangeText={setStation} />
      <PrimaryButton title="Predict Platform" onPress={run} loading={loading} />
      <ErrorText text={error} />
      <ResultBox>
        {data && (
          <>
            <Text style={styles.resultTitle}>Platform {data.predicted_platform} (most likely)</Text>
            <Text style={styles.resultLine}>Alternate: Platform {data.alternate_platform}</Text>
            <Text style={styles.resultLine}>Confidence: {data.confidence}</Text>
            {data.platform_count_note && <Text style={styles.resultLine}>{data.platform_count_note}</Text>}
            <Disclaimer text={data.disclaimer} />
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 2. Pantry Menu
 * ------------------------------------------------------------------- */
function PantryTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!/^\d{5}$/.test(trainNumber)) { setError("Enter a valid train number."); return; }
    setLoading(true); setError(null);
    try { setData(await getPantryMenu(apiBaseUrl, { trainNumber })); }
    catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Pantry Car Menu" subtitle="General IRCTC catering reference, not this train's live menu.">
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <PrimaryButton title="Show Menu" onPress={run} loading={loading} />
      <ErrorText text={error} />
      <ResultBox>
        {data && (
          <>
            <Text style={styles.resultTitle}>{data.train_name || `Train ${trainNumber}`} — pantry {data.pantry_status}</Text>
            {Object.entries(data.menu || {}).map(([cat, items]) => (
              <View key={cat} style={{ marginTop: spacing.sm }}>
                <Text style={styles.resultSubhead}>{cat}</Text>
                <Text style={styles.resultLine}>{items.join(", ")}</Text>
              </View>
            ))}
            <Disclaimer text={data.disclaimer} />
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 3. Station Amenities
 * ------------------------------------------------------------------- */
function AmenitiesTool({ apiBaseUrl }) {
  const [station, setStation] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!station.trim()) return;
    setLoading(true); setError(null);
    try { setData(await getStationAmenities(apiBaseUrl, station.trim())); }
    catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Station Amenities" subtitle="Food courts, lounges, retiring rooms — major stations only.">
      <LabeledInput label="Station code" value={station} onChangeText={setStation} />
      <PrimaryButton title="Look Up" onPress={run} loading={loading} />
      <ErrorText text={error} />
      <ResultBox>
        {data && !data.found && <Text style={styles.resultLine}>No curated data for this station yet.</Text>}
        {data && data.found && (
          <>
            <Text style={styles.resultTitle}>{data.amenities.name} ({data.station})</Text>
            {["food_court", "executive_lounge", "retiring_room", "wifi", "cloak_room", "waiting_room"].map((k) => (
              <Text key={k} style={styles.resultLine}>{data.amenities[k] ? "✓" : "✕"} {k.replace(/_/g, " ")}</Text>
            ))}
            <Disclaimer text={data.disclaimer} />
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 4. My Trains dashboard
 * ------------------------------------------------------------------- */
function MyTrainsTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [dateText, setDateText] = useState("");
  const [label, setLabel] = useState("");
  const [list, setList] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const raw = await AsyncStorage.getItem(MY_TRAINS_KEY);
    const saved = raw ? JSON.parse(raw) : [];
    setList(saved);
    if (!saved.length) return;
    setLoading(true);
    try {
      const data = await getMyTrainsDashboard(apiBaseUrl, saved.map((t) => ({ train_number: t.trainNumber, date: t.date || null, label: t.label || null })));
      const byTrain = {};
      (data.trains || []).forEach((r) => { byTrain[r.train_number] = r; });
      setStatuses(byTrain);
    } catch (e) { setError(describeApiError(e)); }
    finally { setLoading(false); }
  }, [apiBaseUrl]);

  React.useEffect(() => { load(); }, [load]);

  async function add() {
    if (!/^\d{5}$/.test(trainNumber)) { setError("Enter a valid train number."); return; }
    const updated = [...list, { trainNumber, date: dateText.trim() || null, label: label.trim() || null }];
    await AsyncStorage.setItem(MY_TRAINS_KEY, JSON.stringify(updated));
    setTrainNumber(""); setDateText(""); setLabel("");
    load();
  }
  async function remove(idx) {
    const updated = list.filter((_, i) => i !== idx);
    await AsyncStorage.setItem(MY_TRAINS_KEY, JSON.stringify(updated));
    load();
  }

  return (
    <SectionCard title='"My Train" Dashboard' subtitle="Saved journeys with a combined live-status summary.">
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <LabeledInput label="Date (dd-mm-yyyy, optional)" value={dateText} onChangeText={setDateText} />
      <LabeledInput label="Label (optional)" value={label} onChangeText={setLabel} autoCapitalize="sentences" />
      <PrimaryButton title="Add Journey" onPress={add} />
      <ErrorText text={error} />
      {loading && <Text style={styles.resultLine}>Refreshing…</Text>}
      {list.map((t, idx) => {
        const row = statuses[t.trainNumber] || {};
        return (
          <View key={idx} style={styles.listRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.resultTitle}>{t.trainNumber}{t.label ? ` — ${t.label}` : ""}</Text>
              <Text style={styles.resultLine}>
                {row.error ? "live status unavailable" : row.current_station ? `at ${row.current_station}${row.delay_minutes != null ? ` · +${formatDelayDuration(row.delay_minutes)}` : ""}` : "no live data yet"}
              </Text>
            </View>
            <TouchableOpacity onPress={() => remove(idx)}><Text style={styles.removeBtn}>×</Text></TouchableOpacity>
          </View>
        );
      })}
      {!list.length && <Text style={styles.resultLine}>No journeys saved yet.</Text>}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 5. Delay Impact Calculator
 * ------------------------------------------------------------------- */
function DelayImpactTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [station, setStation] = useState("");
  const [dateText, setDateText] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");
  const [buffer, setBuffer] = useState("30");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!/^\d{5}$/.test(trainNumber) || !/^\d{1,2}:\d{2}$/.test(scheduledTime)) {
      setError("Enter a valid train number and scheduled time as HH:MM."); return;
    }
    setLoading(true); setError(null);
    try {
      const pred = await predictDelay(apiBaseUrl, { train_number: trainNumber, date: dateText.trim() || null, source: station.trim() || null });
      const predicted = pred.predicted_delay_minutes;
      if (predicted == null) { setData({ predicted: null }); return; }
      const [h, m] = scheduledTime.split(":").map(Number);
      const totalMin = h * 60 + m + predicted;
      const eta = `${String(Math.floor((totalMin % 1440) / 60)).padStart(2, "0")}:${String(totalMin % 60).padStart(2, "0")}`;
      const bufferMin = parseInt(buffer, 10) || 0;
      const spare = bufferMin - predicted;
      setData({ predicted, eta, spare, atRisk: spare < 0, raw: pred });
    } catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Delay Impact Calculator" subtitle="Predicted delay turned into a real expected arrival + connection risk.">
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <LabeledInput label="Arrival station code" value={station} onChangeText={setStation} />
      <LabeledInput label="Date (dd-mm-yyyy, optional)" value={dateText} onChangeText={setDateText} />
      <LabeledInput label="Scheduled arrival (HH:MM, 24h)" value={scheduledTime} onChangeText={setScheduledTime} keyboardType="numbers-and-punctuation" />
      <LabeledInput label="Connection buffer (min)" value={buffer} onChangeText={setBuffer} keyboardType="number-pad" />
      <PrimaryButton title="Calculate Impact" onPress={run} loading={loading} />
      <ErrorText text={error} />
      <ResultBox>
        {data && data.predicted == null && <Text style={styles.resultLine}>Not enough live data to predict a delay yet.</Text>}
        {data && data.predicted != null && (
          <>
            <Text style={styles.resultTitle}>Expected arrival ≈ {data.eta} — {data.atRisk ? "Connection at risk" : "Connection should hold"}</Text>
            <Text style={styles.resultLine}>Predicted delay: {formatDelayDuration(data.predicted)}</Text>
            <Text style={styles.resultLine}>{data.atRisk ? `Buffer falls short by ${Math.abs(data.spare)} min.` : `${data.spare} min to spare.`}</Text>
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 6. Coach Layout (simplified text listing — no pixel-grid on mobile)
 * ------------------------------------------------------------------- */
function CoachLayoutTool({ apiBaseUrl }) {
  const [travelClass, setTravelClass] = useState("SL");
  const [trainNumber, setTrainNumber] = useState("");
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [dateText, setDateText] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // FEATURE: Coach & Seat "Find My Coach" Guide
  const [coachNumber, setCoachNumber] = useState("");
  const [findCoachData, setFindCoachData] = useState(null);
  const [findCoachError, setFindCoachError] = useState(null);
  const [findCoachLoading, setFindCoachLoading] = useState(false);
  async function runFindCoach() {
    if (!coachNumber.trim()) { setFindCoachError("Enter a coach number, e.g. S4."); return; }
    setFindCoachLoading(true); setFindCoachError(null);
    try { setFindCoachData(await findMyCoach(apiBaseUrl, { coachNumber: coachNumber.trim(), trainNumber: trainNumber.trim() || undefined })); }
    catch (e) { setFindCoachError(describeApiError(e)); setFindCoachData(null); }
    finally { setFindCoachLoading(false); }
  }

  async function run() {
    setLoading(true); setError(null);
    try {
      setData(await getCoachLayout(apiBaseUrl, travelClass, trainNumber.trim() || undefined, {
        source: source.trim() || undefined, dest: dest.trim() || undefined,
        date: dateText.trim() || undefined, quota: "GN",
      }));
    }
    catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  // CROWD-POSITION FOLLOW-UP: occupied_berths (when present) is a
  // probabilistic estimate distributed over these real berth numbers
  // from the real aggregate AVAILABLE/RAC/WL count — see
  // occupancy.disclaimer, always rendered alongside it below. A berth
  // NOT in this set is "likely open" per the same estimate, not a
  // guarantee.
  function seatLabel(num, occupiedSet) {
    return occupiedSet && occupiedSet.has(num) ? `${num}✕` : `${num}`;
  }
  function bayLine(bay, occupiedSet) {
    const left = bay.left.map((s) => seatLabel(s.number, occupiedSet)).join(",");
    const right = bay.right.length ? ` | ${bay.right.map((s) => seatLabel(s.number, occupiedSet)).join(",")}` : "";
    const side = bay.side.length ? ` (side: ${bay.side.map((s) => seatLabel(s.number, occupiedSet)).join(",")})` : "";
    return `${typeof bay.bay === "string" ? bay.bay + ": " : ""}${left}${right}${side}`;
  }

  const occ = data?.occupancy_estimate;
  const occupiedSet = occ?.occupied_berths ? new Set(occ.occupied_berths) : null;

  return (
    <SectionCard title="Coach Layout Visualization" subtitle="Real seat numbers, standard ICF pattern for the class. Add train/route/date below for an occupancy estimate.">
      <LabeledInput label="Train number (optional)" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <LabeledInput label="From (optional)" value={source} onChangeText={setSource} style={{ flex: 1 }} />
        <LabeledInput label="To (optional)" value={dest} onChangeText={setDest} style={{ flex: 1 }} />
      </View>
      <LabeledInput label="Date (dd-mm-yyyy, optional)" value={dateText} onChangeText={setDateText} />
      <Chips options={CLASS_OPTIONS} value={travelClass} onSelect={setTravelClass} />
      <PrimaryButton title="Show Layout" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      <ResultBox>
        {data && data.found && (
          <>
            <Text style={styles.resultTitle}>
              {data.train_number ? `Train ${data.train_number}${data.train_name ? ` — ${data.train_name}` : ""} · ` : ""}
              {data.layout.label} — {data.seat_map ? data.seat_map.total : data.layout.total_berths} berths/seats
            </Text>
            {occ && occ.estimated_occupied != null && (
              <Text style={[styles.resultLine, styles.dangerText]}>
                ✕ = likely occupied (estimate) — ~{occ.estimated_occupied} of {occ.total} berths, based on real {occ.basis} status "{occ.source_status_text}"
              </Text>
            )}
            {data.seat_map?.kind === "bay" && data.seat_map.bays.slice(0, 12).map((bay, i) => (
              <Text key={i} style={styles.resultLine}>{bayLine(bay, occupiedSet)}</Text>
            ))}
            {data.seat_map?.kind === "row" && data.seat_map.rows.slice(0, 12).map((row) => (
              <Text key={row.row} style={styles.resultLine}>Row {row.row}: {row.seats.map((s) => seatLabel(s.number, occupiedSet)).join(",")}</Text>
            ))}
            {data.capacity_note && <Disclaimer text={data.capacity_note} />}
            {occ && <Disclaimer text={occ.disclaimer} />}
            <Disclaimer text={data.disclaimer} />
          </>
        )}
      </ResultBox>

      {/* FEATURE: Coach & Seat "Find My Coach" Guide */}
      <Text style={[styles.resultSubhead, { marginTop: spacing.lg }]}>🚃 Find My Coach — which end of the platform?</Text>
      <Text style={styles.disclaimer}>Enter your specific coach (e.g. S4, B2, A1) to see roughly where it sits in its class's block, and both platform-end scenarios — Indian Railways doesn't publish real per-train rake orientation through any API this app can reach.</Text>
      <LabeledInput label="Coach number, e.g. S4" value={coachNumber} onChangeText={(t) => setCoachNumber(t.toUpperCase())} autoCapitalize="characters" maxLength={6} />
      <PrimaryButton title="Find My Coach" onPress={runFindCoach} loading={findCoachLoading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={findCoachError} />
      <ResultBox>
        {findCoachData && findCoachData.found && (
          <>
            <Text style={styles.resultTitle}>Coach {findCoachData.coach_number} — {findCoachData.class_block_position}</Text>
            <Text style={styles.resultLine}>Coach {findCoachData.coach_index_in_class} of a typical {findCoachData.typical_class_coach_count}-coach {findCoachData.travel_class} block.</Text>
            {findCoachData.platform_end_scenarios.map((s, i) => <Text key={i} style={styles.resultLine}>• {s}</Text>)}
            <Text style={styles.resultLine}>Typical order (front to rear): {findCoachData.typical_marshalling_order.join(" → ")}</Text>
            <Disclaimer text={findCoachData.recommendation} />
            <Disclaimer text={findCoachData.disclaimer} />
          </>
        )}
        {findCoachData && !findCoachData.found && <Text style={styles.resultLine}>{findCoachData.note}</Text>}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 7. Seat Recommendation Engine
 * ------------------------------------------------------------------- */
const SEAT_PREFS = [
  { key: "window", label: "Window seat" }, { key: "lower_berth", label: "Lower berth" },
  { key: "avoid_middle", label: "Avoid middle" }, { key: "family_together", label: "With family/group" },
  { key: "quiet_corner", label: "Quiet corner" }, { key: "easy_toilet_access", label: "Near toilet" },
];
const TRAVELER_OPTIONS = [
  { key: "solo", label: "Solo" }, { key: "family", label: "Family/group" },
  { key: "with_children", label: "With young children" }, { key: "senior", label: "Senior citizen (60+)" },
];

function SeatPickerTool({ apiBaseUrl }) {
  const [travelClass, setTravelClass] = useState("SL");
  const [prefs, setPrefs] = useState([]);
  // FEATURE 2: Best Seat/Berth Automatic Recommendation Based on Trip
  // Profile — these three are optional; only sent to the backend when
  // departure or arrival time is actually filled in.
  const [departureTime, setDepartureTime] = useState("");
  const [arrivalTime, setArrivalTime] = useState("");
  const [travelers, setTravelers] = useState("solo");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  function togglePref(key) {
    setPrefs((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p, key]));
  }
  async function run() {
    setLoading(true); setError(null);
    const tripProfile = (departureTime || arrivalTime) ? { departureTime: departureTime || null, arrivalTime: arrivalTime || null, travelers } : null;
    try { setData(await getSeatRecommendation(apiBaseUrl, { travelClass, preferences: prefs, tripProfile })); }
    catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Seat Recommendation Engine" subtitle="What to request based on class + preferences. Add your trip's timing for an automatic Lower/Upper (or window/aisle) pick.">
      <Chips options={CLASS_OPTIONS} value={travelClass} onSelect={setTravelClass} />
      <View style={{ marginTop: spacing.sm }}>
        <Chips options={SEAT_PREFS} multi selected={prefs} onSelect={togglePref} />
      </View>
      <LabeledInput label="Departure time (HH:MM, optional)" placeholder="22:30" value={departureTime} onChangeText={setDepartureTime} keyboardType="numbers-and-punctuation" />
      <LabeledInput label="Arrival time (HH:MM, optional)" placeholder="06:00" value={arrivalTime} onChangeText={setArrivalTime} keyboardType="numbers-and-punctuation" />
      <Text style={styles.chipLabel}>Travelling as</Text>
      <Chips options={TRAVELER_OPTIONS} value={travelers} onSelect={setTravelers} />
      <PrimaryButton title="Recommend" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      <ResultBox>
        {data && (
          <>
            <Text style={styles.resultTitle}>{data.layout_label || travelClass}</Text>
            {data.trip_profile_used && (
              <View style={{ marginBottom: spacing.sm }}>
                <Text style={styles.resultSubhead}>
                  Recommended: {data.recommended_berth_type ? `${data.recommended_berth_type} berth` : `${data.recommended_seat_type} seat`}
                  {data.duration_hours != null ? ` (${data.duration_hours}h${data.overnight ? ", overnight" : ""})` : ""}
                </Text>
                {(data.recommendation_reasoning || []).map((r, i) => <Text key={i} style={styles.resultLine}>• {r}</Text>)}
              </View>
            )}
            {(data.advice || []).map((a, i) => <Text key={i} style={styles.resultLine}>• {a}</Text>)}
            <Disclaimer text={data.note} />
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 8. Cross-Train Route Compare
 * ------------------------------------------------------------------- */
function RouteCompareTool({ apiBaseUrl }) {
  const [trainsText, setTrainsText] = useState("");
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [dateText, setDateText] = useState("");
  const [travelClass, setTravelClass] = useState("SL");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    const trainNumbers = trainsText.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 4);
    if (!trainNumbers.length || !source.trim() || !dest.trim() || !dateText.trim()) {
      setError("Enter train numbers, source, destination, and date."); return;
    }
    setLoading(true); setError(null);
    try { setData(await compareRoutes(apiBaseUrl, { trainNumbers, source: source.trim(), dest: dest.trim(), date: dateText.trim(), travelClass })); }
    catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Cross-Train Route Compare" subtitle="Live fare + availability across up to 4 trains.">
      <LabeledInput label="Train numbers (comma-separated)" value={trainsText} onChangeText={setTrainsText} />
      <LabeledInput label="From (code)" value={source} onChangeText={setSource} />
      <LabeledInput label="To (code)" value={dest} onChangeText={setDest} />
      <LabeledInput label="Date (dd-mm-yyyy)" value={dateText} onChangeText={setDateText} />
      <Chips options={CLASS_OPTIONS} value={travelClass} onSelect={setTravelClass} />
      <PrimaryButton title="Compare" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      <ResultBox>
        {data && (data.results || []).map((r) => (
          <View key={r.train_number} style={{ marginBottom: spacing.sm }}>
            <Text style={styles.resultTitle}>{r.train_number}{r.train_name ? ` — ${r.train_name}` : ""}</Text>
            <Text style={styles.resultLine}>Fare: {r.fare != null ? `₹${r.fare}` : "unavailable"}</Text>
            <Text style={styles.resultLine}>Availability: {r.availability_status || "unavailable"}</Text>
          </View>
        ))}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 9. Cancellation Refund Estimator
 * ------------------------------------------------------------------- */
function RefundTool({ apiBaseUrl }) {
  const [fare, setFare] = useState("");
  const [travelClass, setTravelClass] = useState("SL");
  const [status, setStatusVal] = useState("confirmed");
  const [hours, setHours] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    const fareAmount = parseFloat(fare);
    if (!Number.isFinite(fareAmount) || fareAmount <= 0) { setError("Enter a valid fare amount."); return; }
    setLoading(true); setError(null);
    try {
      setData(await estimateRefund(apiBaseUrl, {
        fareAmount, travelClass, ticketStatus: status, hoursBeforeDeparture: hours.trim() ? parseFloat(hours) : null,
      }));
    } catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Cancellation Refund Estimator" subtitle="Based on IRCTC's published cancellation slabs.">
      <LabeledInput label="Fare paid (₹)" value={fare} onChangeText={setFare} keyboardType="number-pad" />
      <Chips options={CLASS_OPTIONS} value={travelClass} onSelect={setTravelClass} />
      <View style={{ marginTop: spacing.sm }}>
        <Chips options={["confirmed", "rac", "waitlist"]} value={status} onSelect={setStatusVal} />
      </View>
      <LabeledInput label="Hours before departure (optional)" value={hours} onChangeText={setHours} keyboardType="number-pad" />
      <PrimaryButton title="Estimate Refund" onPress={run} loading={loading} />
      <ErrorText text={error} />
      <ResultBox>
        {data && (
          <>
            <Text style={styles.resultTitle}>Estimated refund: ₹{data.estimated_refund} (deduction ₹{data.deduction})</Text>
            {(data.breakdown || []).map((b, i) => <Text key={i} style={styles.resultLine}>• {b}</Text>)}
            <Disclaimer text={data.disclaimer} />
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 10. Fare & Availability Heatmap
 * ------------------------------------------------------------------- */
function FareHeatmapTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [startDate, setStartDate] = useState("");
  const [travelClass, setTravelClass] = useState("SL");
  const [days, setDays] = useState("7");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // FEATURE: Fare & Availability "Alert Zone" — "Watch This Route" only
  // becomes available once a real heatmap has loaded, since the watch
  // needs a real baseline fare to measure a real drop against (see
  // push_store.replace_fare_watches on the backend).
  const [baselineFare, setBaselineFare] = useState(null);
  const [thresholdPct, setThresholdPct] = useState("10");
  const [watchLabel, setWatchLabel] = useState("");
  const [watches, setWatches] = useState([]);
  const [watchResults, setWatchResults] = useState({});
  const [watchStatus, setWatchStatus] = useState(null);
  const [watchLoading, setWatchLoading] = useState(false);

  const loadWatches = useCallback(async () => {
    const raw = await AsyncStorage.getItem(FARE_WATCH_KEY);
    const saved = raw ? JSON.parse(raw) : [];
    setWatches(saved);
    if (!saved.length) return;
    setWatchLoading(true);
    try {
      const res = await checkFareWatches(apiBaseUrl, saved);
      const byIdx = {};
      (res.watches || []).forEach((w, i) => { byIdx[i] = w; });
      setWatchResults(byIdx);
      setWatchStatus(res.note);
    } catch (e) { setWatchStatus(describeApiError(e)); }
    finally { setWatchLoading(false); }
  }, [apiBaseUrl]);

  React.useEffect(() => { loadWatches(); }, [loadWatches]);

  async function syncFareWatchesIfEnabled(currentList) {
    const token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    if (!token) return;
    try { await syncFareWatches(apiBaseUrl, token, currentList); } catch (e) { /* best-effort */ }
  }

  async function run() {
    if (!/^\d{5}$/.test(trainNumber) || !source.trim() || !dest.trim() || !startDate.trim()) {
      setError("Enter train number, source, destination, and start date."); return;
    }
    setLoading(true); setError(null);
    try {
      const result = await buildFareHeatmap(apiBaseUrl, {
        trainNumber, source: source.trim(), dest: dest.trim(), startDate: startDate.trim(),
        days: Math.max(1, Math.min(parseInt(days, 10) || 7, 10)), travelClass,
      });
      setData(result);
      const firstFare = (result.cells || []).find((c) => c.fare != null)?.fare ?? null;
      setBaselineFare(firstFare);
    } catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  async function addFareWatch() {
    if (baselineFare == null) return;
    const updated = [...watches, {
      trainNumber, source: source.trim().toUpperCase(), dest: dest.trim().toUpperCase(),
      date: startDate.trim(), travelClass, quota: "GN",
      thresholdPct: parseInt(thresholdPct, 10) || 10, label: watchLabel.trim() || null, baselineFare,
    }];
    await AsyncStorage.setItem(FARE_WATCH_KEY, JSON.stringify(updated));
    setWatchLabel("");
    await syncFareWatchesIfEnabled(updated);
    loadWatches();
  }
  async function removeFareWatch(idx) {
    const updated = watches.filter((_, i) => i !== idx);
    await AsyncStorage.setItem(FARE_WATCH_KEY, JSON.stringify(updated));
    await syncFareWatchesIfEnabled(updated);
    loadWatches();
  }

  return (
    <SectionCard title="Fare & Availability Heatmap" subtitle="Live fare/availability across the next several days.">
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <LabeledInput label="From (code)" value={source} onChangeText={setSource} />
      <LabeledInput label="To (code)" value={dest} onChangeText={setDest} />
      <LabeledInput label="Start date (dd-mm-yyyy)" value={startDate} onChangeText={setStartDate} />
      <Chips options={CLASS_OPTIONS} value={travelClass} onSelect={setTravelClass} />
      <LabeledInput label="Days (max 10)" value={days} onChangeText={setDays} keyboardType="number-pad" style={{ marginTop: spacing.sm }} />
      <PrimaryButton title="Build Heatmap" onPress={run} loading={loading} />
      <ErrorText text={error} />
      <ResultBox>
        {data && (data.cells || []).map((c) => (
          <Text key={c.date} style={styles.resultLine}>{c.date} ({c.weekday}): {c.fare != null ? `₹${c.fare}` : "—"} · {c.status_text || (c.error ? "unavailable" : "n/a")}</Text>
        ))}
      </ResultBox>

      {/* FEATURE: Fare & Availability "Alert Zone" */}
      <Text style={[styles.resultSubhead, { marginTop: spacing.lg }]}>🔔 Watch This Route</Text>
      <Text style={styles.disclaimer}>Build a heatmap above first (real baseline fare needed). You'll be notified when fare drops past your threshold or availability improves (WL → RAC → AVAILABLE) — checked here on refresh, plus in the background if push is enabled on the Delay Alerts tab.</Text>
      <LabeledInput label="Alert if fare drops by ≥ (%)" value={thresholdPct} onChangeText={setThresholdPct} keyboardType="number-pad" />
      <LabeledInput label="Label (optional)" value={watchLabel} onChangeText={setWatchLabel} />
      <PrimaryButton title="Watch This Route" onPress={addFareWatch} disabled={baselineFare == null} style={{ marginTop: spacing.sm }} />
      <PrimaryButton title="Refresh Watches" onPress={loadWatches} loading={watchLoading} variant="secondary" style={{ marginTop: spacing.sm }} />
      {watchStatus && <Text style={styles.disclaimer}>{watchStatus}</Text>}
      {watches.map((w, idx) => {
        const r = watchResults[idx] || {};
        return (
          <View key={idx} style={styles.listRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.resultTitle}>{w.trainNumber}{w.label ? ` — ${w.label}` : ""} {w.source}→{w.dest} ({w.travelClass})</Text>
              <Text style={[styles.resultLine, r.breached && styles.dangerText]}>
                baseline ₹{w.baselineFare} · {r.fare != null ? `now ₹${r.fare}` : "checking…"}{r.fare_drop_pct != null && r.fare_drop_pct > 0 ? ` (-${r.fare_drop_pct}%)` : ""}{r.status_text ? ` · ${r.status_text}` : ""}
              </Text>
            </View>
            <TouchableOpacity onPress={() => removeFareWatch(idx)}><Text style={styles.removeBtn}>×</Text></TouchableOpacity>
          </View>
        );
      })}
      {!watches.length && <Text style={styles.resultLine}>No routes watched yet.</Text>}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 11. NEW — Proactive Delay Alerts
 * ------------------------------------------------------------------- */
function AlertsTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [dateText, setDateText] = useState("");
  const [label, setLabel] = useState("");
  const [threshold, setThreshold] = useState("15");
  const [list, setList] = useState([]);
  const [results, setResults] = useState({});
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Background push (crowd-position follow-up — was in-app-only before):
  // pushToken is null until the user opts in via "Enable Background Push".
  // pushStatus renders either a success confirmation or the exact reason
  // registration failed/isn't possible yet (Expo Go, no EAS project ID,
  // permission denied, ...) — see pushNotifications.registerForPushNotifications.
  const [pushToken, setPushToken] = useState(null);
  const [pushStatus, setPushStatus] = useState(null);
  const [pushEnabling, setPushEnabling] = useState(false);

  const load = useCallback(async () => {
    const raw = await AsyncStorage.getItem(ALERTS_KEY);
    const saved = raw ? JSON.parse(raw) : [];
    setList(saved);
    if (!saved.length) return;
    setLoading(true);
    try {
      const data = await checkDelayAlerts(apiBaseUrl, saved.map((w) => ({
        train_number: w.trainNumber, date: w.date || null, threshold_minutes: w.threshold, label: w.label,
      })));
      const byTrain = {};
      (data.watches || []).forEach((w) => { byTrain[w.train_number] = w; });
      setResults(byTrain);
      setNote(data.note);
    } catch (e) { setError(describeApiError(e)); }
    finally { setLoading(false); }
  }, [apiBaseUrl]);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    AsyncStorage.getItem(PUSH_TOKEN_KEY).then((t) => { if (t) setPushToken(t); });
  }, []);

  const syncWatchesIfEnabled = useCallback(async (currentToken, currentList) => {
    if (!currentToken) return;
    try { await syncPushWatches(apiBaseUrl, currentToken, currentList); }
    catch (e) { /* best-effort — in-app checking above still works regardless */ }
  }, [apiBaseUrl]);

  async function enableBackgroundPush() {
    setPushEnabling(true);
    setPushStatus(null);
    try {
      const { token, platform, reason } = await registerForPushNotifications();
      if (!token) {
        setPushStatus({ ok: false, message: reason });
        return;
      }
      await registerPushToken(apiBaseUrl, token, platform);
      await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
      setPushToken(token);
      await syncWatchesIfEnabled(token, list);
      setPushStatus({ ok: true, message: "Background push enabled for your current watches — you'll get an alert even with the app closed." });
    } catch (e) {
      setPushStatus({ ok: false, message: describeApiError(e) });
    } finally {
      setPushEnabling(false);
    }
  }

  async function add() {
    if (!/^\d{5}$/.test(trainNumber)) { setError("Enter a valid train number."); return; }
    const updated = [...list, { trainNumber, date: dateText.trim() || null, label: label.trim() || null, threshold: parseInt(threshold, 10) || 15 }];
    await AsyncStorage.setItem(ALERTS_KEY, JSON.stringify(updated));
    setTrainNumber(""); setDateText(""); setLabel(""); setThreshold("15");
    await syncWatchesIfEnabled(pushToken, updated);
    load();
  }
  async function remove(idx) {
    const updated = list.filter((_, i) => i !== idx);
    await AsyncStorage.setItem(ALERTS_KEY, JSON.stringify(updated));
    await syncWatchesIfEnabled(pushToken, updated);
    load();
  }

  return (
    <SectionCard
      title="Proactive Delay Alerts"
      subtitle={
        pushToken
          ? "Checked live on refresh, PLUS a real background push when a watch breaches its threshold — even with the app closed."
          : "Checked live when this screen opens/refreshes. Tap \"Enable Background Push\" below to also get alerted with the app closed."
      }
    >
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <LabeledInput label="Date (dd-mm-yyyy, optional)" value={dateText} onChangeText={setDateText} />
      <LabeledInput label="Label (optional)" value={label} onChangeText={setLabel} autoCapitalize="sentences" />
      <LabeledInput label="Alert if delay ≥ (min)" value={threshold} onChangeText={setThreshold} keyboardType="number-pad" />
      <PrimaryButton title="Add Watch" onPress={add} />
      <PrimaryButton title="Refresh" onPress={load} loading={loading} variant="secondary" style={{ marginTop: spacing.sm }} />
      {!pushToken && (
        <PrimaryButton
          title="🔔 Enable Background Push"
          onPress={enableBackgroundPush}
          loading={pushEnabling}
          variant="secondary"
          style={{ marginTop: spacing.sm }}
        />
      )}
      {pushStatus && (
        <Text style={[styles.disclaimer, !pushStatus.ok && styles.dangerText]}>{pushStatus.message}</Text>
      )}
      <ErrorText text={error} />
      {note && <Text style={styles.disclaimer}>{note}</Text>}
      {list.map((w, idx) => {
        const r = results[w.trainNumber] || {};
        return (
          <View key={idx} style={styles.listRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.resultTitle}>{w.trainNumber}{w.label ? ` — ${w.label}` : ""} (≥{w.threshold}m)</Text>
              <Text style={[styles.resultLine, r.breached && styles.dangerText]}>
                {r.error ? "check failed" : r.predicted_delay_minutes == null ? "no prediction yet" : `${r.breached ? "⚠ " : ""}+${formatDelayDuration(r.predicted_delay_minutes)}${r.breached ? " — threshold breached" : ""}`}
              </Text>
            </View>
            <TouchableOpacity onPress={() => remove(idx)}><Text style={styles.removeBtn}>×</Text></TouchableOpacity>
          </View>
        );
      })}
      {!list.length && <Text style={styles.resultLine}>No watches yet.</Text>}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 12. NEW — Live Station Crowd Estimation
 * ------------------------------------------------------------------- */
function StationCrowdTool({ apiBaseUrl }) {
  const [station, setStation] = useState("");
  const [hours, setHours] = useState("2");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!station.trim()) return;
    setLoading(true); setError(null);
    try { setData(await getStationCrowd(apiBaseUrl, station.trim(), parseInt(hours, 10) || 2)); }
    catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Live Station Crowd Estimation" subtitle="Estimated from real train frequency + time-of-day — not a live camera/sensor count.">
      <LabeledInput label="Station code" value={station} onChangeText={setStation} />
      <Chips options={[{ key: "2", label: "Next 2h" }, { key: "4", label: "Next 4h" }, { key: "8", label: "Next 8h" }]} value={hours} onSelect={setHours} />
      <PrimaryButton title="Estimate Crowd" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      <ResultBox>
        {data && !data.error && (
          <>
            <Text style={styles.resultTitle}>{data.station} — {data.label}</Text>
            <Text style={styles.resultLine}>{data.trains_in_window} train(s) due in the next {data.hours_window}h{data.is_rush_hour ? " · rush hour" : ""}</Text>
            <Disclaimer text={data.disclaimer} />
          </>
        )}
        {data && data.error && <Text style={styles.error}>{data.error}</Text>}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 13. NEW — Smart Luggage/Parcel Tracking (informational)
 * ------------------------------------------------------------------- */
function ParcelTool({ apiBaseUrl }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  React.useEffect(() => {
    (async () => {
      try { setData(await getParcelInfo(apiBaseUrl)); }
      catch (e) { setError(describeApiError(e)); }
      finally { setLoading(false); }
    })();
  }, [apiBaseUrl]);

  return (
    <SectionCard title="Smart Luggage/Parcel Tracking" subtitle="Not available through this app's data provider.">
      {loading && <Text style={styles.resultLine}>Loading…</Text>}
      <ErrorText text={error} />
      {data && (
        <>
          <Text style={styles.resultLine}>{data.reason}</Text>
          <Text style={[styles.resultLine, { marginTop: spacing.sm }]}>{data.what_you_can_track_there}</Text>
          <PrimaryButton
            title={`Open ${data.official_portal_label}`}
            onPress={() => Linking.openURL(data.official_portal_url)}
            variant="secondary"
            style={{ marginTop: spacing.md }}
          />
        </>
      )}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 14. NEW — Offline Route Maps & Station Information
 * ------------------------------------------------------------------- */
function OfflineTool({ apiBaseUrl }) {
  const [lookup, setLookup] = useState("");
  const [savedAt, setSavedAt] = useState(null);
  const [entry, setEntry] = useState(null);
  const [status, setStatusMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    (async () => {
      const raw = await AsyncStorage.getItem(OFFLINE_KEY);
      if (raw) setSavedAt(JSON.parse(raw).savedAt);
    })();
  }, []);

  async function download() {
    setLoading(true); setStatusMsg(null);
    try {
      const data = await getOfflineStationBundle(apiBaseUrl);
      const bundle = { stations: data.stations, savedAt: new Date().toISOString() };
      await AsyncStorage.setItem(OFFLINE_KEY, JSON.stringify(bundle));
      setSavedAt(bundle.savedAt);
      setStatusMsg(`Saved ${Object.keys(data.stations).length} stations for offline use.`);
    } catch (e) { setStatusMsg(describeApiError(e)); }
    finally { setLoading(false); }
  }

  async function lookupStation() {
    const raw = await AsyncStorage.getItem(OFFLINE_KEY);
    if (!raw) { setStatusMsg("No offline data saved yet — download first (needs network once)."); return; }
    const bundle = JSON.parse(raw);
    const code = lookup.trim().toUpperCase();
    setEntry(bundle.stations[code] || { notFound: true });
  }

  return (
    <SectionCard title="Offline Route Maps & Station Information" subtitle="Download once, look up major stations with no network afterward.">
      <PrimaryButton title="Download for offline use" onPress={download} loading={loading} />
      {savedAt && <Text style={styles.disclaimer}>Last saved: {new Date(savedAt).toLocaleString()}</Text>}
      {status && <Text style={styles.resultLine}>{status}</Text>}
      <LabeledInput label="Station code" value={lookup} onChangeText={setLookup} style={{ marginTop: spacing.md }} />
      <PrimaryButton title="Look up (offline)" onPress={lookupStation} variant="secondary" />
      <ResultBox>
        {entry && entry.notFound && <Text style={styles.resultLine}>Not in the saved offline set.</Text>}
        {entry && !entry.notFound && (
          <>
            <Text style={styles.resultTitle}>{entry.name}</Text>
            <Text style={styles.resultLine}>Coordinates: {entry.lat}, {entry.lng}</Text>
            {entry.amenities && ["food_court", "executive_lounge", "retiring_room", "wifi", "cloak_room", "waiting_room"].map((k) => (
              <Text key={k} style={styles.resultLine}>{entry.amenities[k] ? "✓" : "✕"} {k.replace("_", " ")}</Text>
            ))}
            <MapView
              style={styles.offlineMap}
              provider={PROVIDER_GOOGLE}
              initialRegion={{ latitude: entry.lat, longitude: entry.lng, latitudeDelta: 0.05, longitudeDelta: 0.05 }}
              region={{ latitude: entry.lat, longitude: entry.lng, latitudeDelta: 0.05, longitudeDelta: 0.05 }}
            >
              <Marker coordinate={{ latitude: entry.lat, longitude: entry.lng }} title={entry.name} />
            </MapView>
            <Text style={styles.disclaimer}>
              This map view needs network (react-native-maps/Google Maps here has no built-in offline tile
              download). For a genuinely offline map of this area, open it in Google Maps and use Google
              Maps' own "Download area" feature before you lose signal.
            </Text>
            <PrimaryButton
              title="Open in Google Maps (to download offline area)"
              variant="secondary"
              style={{ marginTop: spacing.sm }}
              onPress={() => Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${entry.lat},${entry.lng}`)}
            />
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 15. NEW — Interactive Journey Timeline (Gantt-style)
 * ------------------------------------------------------------------- */
function GanttTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [dateText, setDateText] = useState("");
  const [stops, setStops] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!/^\d{5}$/.test(trainNumber)) { setError("Enter a valid train number."); return; }
    setLoading(true); setError(null);
    try {
      const data = await getJourneyTimeline(apiBaseUrl, trainNumber, dateText.trim() || null);
      if (data.error) { setError(data.error); setStops(null); return; }
      setStops((data.stops || []).filter((s) => s.kind === "stoppage"));
    } catch (e) { setError(describeApiError(e)); setStops(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Interactive Journey Timeline" subtitle="Stop-by-stop schedule vs actual, Gantt-style.">
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <LabeledInput label="Date (dd-mm-yyyy, optional)" value={dateText} onChangeText={setDateText} />
      <PrimaryButton title="Show Timeline" onPress={run} loading={loading} />
      <ErrorText text={error} />
      {stops && stops.length > 0 && (
        <View style={{ marginTop: spacing.md }}>
          {stops.map((s, i) => {
            const pct = Math.round((i / Math.max(stops.length - 1, 1)) * 100);
            const barColor = s.status === "passed" ? colors.success : s.status === "current" ? colors.accent : colors.border;
            const delay = s.arrival?.delay_minutes ?? s.departure?.delay_minutes;
            return (
              <View key={s.code + i} style={styles.ganttRow}>
                <Text style={styles.ganttName} numberOfLines={1}>{s.name}</Text>
                <View style={styles.ganttTrack}>
                  <View style={[styles.ganttBar, { width: `${Math.max(pct, 4)}%`, backgroundColor: barColor }]} />
                </View>
                <Text style={[styles.ganttDelay, delay > 10 && styles.dangerText]}>{delay != null ? `+${formatDelayDuration(delay)}` : "—"}</Text>
              </View>
            );
          })}
        </View>
      )}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * 16. NEW — Personalized Travel Assistant (Profile & History)
 * ------------------------------------------------------------------- */
function ProfileTool({ apiBaseUrl }) {
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [travelClass, setTravelClass] = useState("SL");
  const [dateText, setDateText] = useState("");
  const [history, setHistory] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // sub-tool state: Packed? / Alternative plan
  const [checkTrain, setCheckTrain] = useState("");
  const [checkDate, setCheckDate] = useState("");
  const [threshold, setThreshold] = useState("20");
  const [packedResult, setPackedResult] = useState(null);
  const [altResult, setAltResult] = useState(null);
  const [subError, setSubError] = useState(null);
  const [subLoading, setSubLoading] = useState(false);

  const load = useCallback(async () => {
    const raw = await AsyncStorage.getItem(PROFILE_KEY);
    const saved = raw ? JSON.parse(raw) : [];
    setHistory(saved);
    if (!saved.length) { setSummary(null); return; }
    setLoading(true);
    try {
      setSummary(await getProfileSummary(apiBaseUrl, saved.map((t) => ({
        source: t.source, dest: t.dest, travel_class: t.travelClass, date: t.date,
      }))));
    } catch (e) { setError(describeApiError(e)); }
    finally { setLoading(false); }
  }, [apiBaseUrl]);

  React.useEffect(() => { load(); }, [load]);

  async function logTrip() {
    if (!source.trim() || !dest.trim() || !dateText.trim()) { setError("Enter source, destination, and date (dd-mm-yyyy)."); return; }
    const updated = [...history, { source: source.trim().toUpperCase(), dest: dest.trim().toUpperCase(), travelClass, date: dateText.trim() }];
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(updated));
    setSource(""); setDest(""); setDateText("");
    load();
  }
  async function removeTrip(idx) {
    const updated = history.filter((_, i) => i !== idx);
    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(updated));
    load();
  }

  const lastTrip = history[history.length - 1];

  async function runPacked() {
    if (!/^\d{5}$/.test(checkTrain) || !checkDate.trim()) { setSubError("Enter a valid train number and date."); return; }
    if (!lastTrip) { setSubError("Log a trip above first, so I know the route/class to check."); return; }
    setSubLoading(true); setSubError(null); setPackedResult(null); setAltResult(null);
    try {
      setPackedResult(await checkPacked(apiBaseUrl, {
        trainNumber: checkTrain, source: lastTrip.source, dest: lastTrip.dest, date: checkDate.trim(), travelClass: lastTrip.travelClass,
      }));
    } catch (e) { setSubError(describeApiError(e)); }
    finally { setSubLoading(false); }
  }
  async function runAlternative() {
    if (!/^\d{5}$/.test(checkTrain) || !checkDate.trim()) { setSubError("Enter a valid train number and date."); return; }
    if (!lastTrip) { setSubError("Log a trip above first, so I know the route/class to check."); return; }
    setSubLoading(true); setSubError(null); setPackedResult(null); setAltResult(null);
    try {
      setAltResult(await getAlternativePlan(apiBaseUrl, {
        trainNumber: checkTrain, source: lastTrip.source, dest: lastTrip.dest, date: checkDate.trim(),
        travelClass: lastTrip.travelClass, delayThresholdMinutes: parseInt(threshold, 10) || 20,
      }));
    } catch (e) { setSubError(describeApiError(e)); }
    finally { setSubLoading(false); }
  }

  return (
    <>
      <SectionCard title="Personalized Travel Assistant" subtitle="Built from trips you log here — frequent route, preferred class, home station, and a booking reminder if a weekday pattern shows up.">
        <LabeledInput label="From (code)" value={source} onChangeText={setSource} />
        <LabeledInput label="To (code)" value={dest} onChangeText={setDest} />
        <Chips options={CLASS_OPTIONS} value={travelClass} onSelect={setTravelClass} />
        <LabeledInput label="Date (dd-mm-yyyy)" value={dateText} onChangeText={setDateText} style={{ marginTop: spacing.sm }} />
        <PrimaryButton title="Log Trip" onPress={logTrip} />
        <ErrorText text={error} />
        {loading && <Text style={styles.resultLine}>Summarizing…</Text>}
        {summary && summary.has_data && (
          <ResultBox>
            <Text style={styles.resultTitle}>{summary.trip_count} trip(s) logged</Text>
            {summary.frequent_route && <Text style={styles.resultLine}>Frequent route: {summary.frequent_route.source} → {summary.frequent_route.dest} ({summary.frequent_route.count}×)</Text>}
            <Text style={styles.resultLine}>Preferred class: {summary.preferred_class || "n/a"} · Home station: {summary.home_station || "n/a"}</Text>
            {summary.booking_reminder && (
              <Text style={[styles.resultLine, { color: colors.accent, fontWeight: "700", marginTop: 4 }]}>
                🔔 You often travel {summary.booking_reminder.route} on {summary.booking_reminder.weekday}s — next one is {summary.booking_reminder.next_date} ({summary.booking_reminder.days_away} day(s) away).
              </Text>
            )}
          </ResultBox>
        )}
        {history.map((t, idx) => (
          <View key={idx} style={styles.listRow}>
            <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>{t.source} → {t.dest} · {t.travelClass} ({t.date})</Text>
            <TouchableOpacity onPress={() => removeTrip(idx)}><Text style={styles.removeBtn}>×</Text></TouchableOpacity>
          </View>
        ))}
      </SectionCard>

      <SectionCard title="Packed? / Alternative Plan" subtitle="Uses your most recently logged route/class.">
        <LabeledInput label="Train number" value={checkTrain} onChangeText={setCheckTrain} keyboardType="number-pad" maxLength={5} />
        <LabeledInput label="Date (dd-mm-yyyy)" value={checkDate} onChangeText={setCheckDate} />
        <LabeledInput label="Alt-plan delay threshold (min)" value={threshold} onChangeText={setThreshold} keyboardType="number-pad" />
        <PrimaryButton title="Check Crowd (Packed?)" onPress={runPacked} loading={subLoading} />
        <PrimaryButton title="Check for Alternatives" onPress={runAlternative} loading={subLoading} variant="secondary" style={{ marginTop: spacing.sm }} />
        <ErrorText text={subError} />
        <ResultBox>
          {packedResult && (
            <>
              <Text style={styles.resultTitle}>Train {checkTrain}: {packedResult.your_train.level}</Text>
              {packedResult.alternatives.map((a) => <Text key={a.train_number} style={styles.resultLine}>Alt {a.train_number}: {a.level}</Text>)}
              <Disclaimer text={packedResult.note} />
            </>
          )}
          {altResult && (
            <>
              <Text style={styles.resultTitle}>{altResult.delayed_beyond_threshold ? "⚠ Alternative suggested" : "✓ No alternative needed"} ({altResult.predicted_delay_minutes != null ? `+${formatDelayDuration(altResult.predicted_delay_minutes)}` : "no prediction"})</Text>
              {(altResult.alternatives || []).map((a) => (
                <Text key={a.train_number} style={styles.resultLine}>{a.train_number}{a.train_name ? ` — ${a.train_name}` : ""} · crowd {a.level} · {a.availability_status || "availability unavailable"}</Text>
              ))}
              <Disclaimer text={altResult.note} />
            </>
          )}
        </ResultBox>
      </SectionCard>
    </>
  );
}

/* ---------------------------------------------------------------------
 * 17. NEW — "Near Me" Real-Time Platform Information
 * ------------------------------------------------------------------- */
function NearMeTool({ apiBaseUrl }) {
  const [station, setStation] = useState("");
  const [hours, setHours] = useState("2");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!station.trim()) return;
    setLoading(true); setError(null);
    try { setData(await getStationNow(apiBaseUrl, station.trim(), parseInt(hours, 10) || 2)); }
    catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title='"Near Me": Real-Time Platform Info' subtitle="Trains due at a station, reported platforms, and the next arrival. Platform numbers only show when the provider actually reports one.">
      <LabeledInput label="Station code" value={station} onChangeText={setStation} />
      <Chips options={[{ key: "2", label: "Next 2h" }, { key: "4", label: "Next 4h" }, { key: "8", label: "Next 8h" }]} value={hours} onSelect={setHours} />
      <PrimaryButton title="Show Trains Now" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      {data && data.error && !data.trains?.length && <Text style={styles.error}>{data.error}</Text>}
      {data && data.next_arrival && (
        <ResultBox>
          <Text style={styles.resultTitle}>Next to arrive: Train {String(data.next_arrival.train_number || "?")}{data.next_arrival.train_name ? ` — ${data.next_arrival.train_name}` : ""}</Text>
          <Text style={styles.resultLine}>
            {data.next_arrival.scheduled_time ? `Scheduled: ${data.next_arrival.scheduled_time}` : ""}
            {data.next_arrival.platform ? ` · Platform ${data.next_arrival.platform}` : ""}
          </Text>
        </ResultBox>
      )}
      {data && data.platform_heatmap && data.platform_heatmap.platform_data_available && (
        <View style={styles.heatmapRow}>
          {data.platform_heatmap.platforms.map((p) => (
            <View key={p.platform} style={styles.heatmapCell}>
              <Text style={styles.heatmapCellLabel}>Platform {p.platform}</Text>
              <Text style={styles.heatmapCellCount}>{p.trains.length}</Text>
            </View>
          ))}
          {data.platform_heatmap.trains_without_reported_platform > 0 && (
            <View style={[styles.heatmapCell, styles.heatmapCellMuted]}>
              <Text style={styles.heatmapCellLabelMuted}>Not reported</Text>
              <Text style={styles.heatmapCellCountMuted}>{data.platform_heatmap.trains_without_reported_platform}</Text>
            </View>
          )}
        </View>
      )}
      {(data?.trains || []).map((t, i) => (
        <View key={i} style={styles.listRow}>
          <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>
            {String(t.train_number || "?")}{t.train_name ? ` — ${t.train_name}` : ""}{t.scheduled_time ? ` (${t.scheduled_time})` : ""}
          </Text>
          <Text style={styles.resultLine}>{t.platform ? `PF ${t.platform}` : "not reported"}</Text>
        </View>
      ))}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * NEW — Personalized Journey Planner
 * ------------------------------------------------------------------- */
function uberDeepLink({ lat, lng, name }) {
  const p = new URLSearchParams();
  p.set("action", "setPickup");
  p.set("pickup[latitude]", String(lat));
  p.set("pickup[longitude]", String(lng));
  p.set("pickup[nickname]", name || "");
  return `https://m.uber.com/ul/?${p.toString()}`;
}
function olaDeepLink({ lat, lng }) {
  const p = new URLSearchParams();
  p.set("lat", String(lat));
  p.set("lng", String(lng));
  return `olacabs://app/launch?${p.toString()}`;
}

function JourneyPlannerTool({ apiBaseUrl }) {
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [travelClass, setTravelClass] = useState("");
  const [preference, setPreference] = useState("fastest");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!source.trim() || !dest.trim()) { setError("Enter both a source and destination."); return; }
    setLoading(true); setError(null);
    try {
      setData(await planJourney(apiBaseUrl, { source: source.trim(), dest: dest.trim(), preference, travelClass: travelClass || undefined }));
    } catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  const destStation = data?.last_mile?.dest_station;

  return (
    <SectionCard title="Personalized Journey Planner" subtitle="Real direct trains plus real junction-hopping alternatives, ranked by what you pick. No class means no live fare — 'cheapest' then falls back to sorting by duration, said plainly below.">
      <LabeledInput label="From (code or name)" value={source} onChangeText={setSource} autoCapitalize="none" />
      <LabeledInput label="To (code or name)" value={dest} onChangeText={setDest} autoCapitalize="none" />
      <Text style={styles.chipLabel}>Class (optional — needed for real fare ranking)</Text>
      <Chips options={[{ key: "", label: "Any" }, ...CLASS_OPTIONS]} value={travelClass} onSelect={setTravelClass} />
      <Text style={styles.chipLabel}>Preference</Text>
      <Chips
        options={[{ key: "fastest", label: "Fastest" }, { key: "cheapest", label: "Cheapest" }, { key: "fewest_changes", label: "Fewest changes" }]}
        value={preference} onSelect={setPreference}
      />
      <PrimaryButton title="Plan My Journey" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      {data && data.error && <Text style={styles.error}>{data.error}</Text>}

      {data && (data.note || data.fare_note) && <Disclaimer text={[data.note, data.fare_note].filter(Boolean).join(" ")} />}

      {data && data.direct_options?.length > 0 && (
        <>
          <Text style={[styles.resultTitle, { marginTop: spacing.md }]}>Direct trains</Text>
          {data.direct_options.map((o, i) => (
            <View key={i} style={styles.listRow}>
              <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>
                {o.train_number}{o.train_name ? ` — ${o.train_name}` : ""} · dep {o.departure_time || "?"} → arr {o.arrival_time || "?"}{o.duration_display ? ` (${o.duration_display})` : ""}
              </Text>
              <Text style={styles.resultLine}>{o.fare != null ? `₹${o.fare}` : (o.fare_note ? "no fare" : "")}</Text>
            </View>
          ))}
        </>
      )}

      {data && data.alternative_routes?.length > 0 && (
        <>
          <Text style={[styles.resultTitle, { marginTop: spacing.md }]}>Junction-hopping alternatives</Text>
          {data.alternative_routes.map((r, i) => (
            <ResultBox key={i}>
              <Text style={styles.resultTitle}>Via {r.via_names.join(" → ")}</Text>
              <Text style={styles.resultLine}>{r.hops} change(s) · ~{r.total_distance_km} km</Text>
              {r.legs.map((l, j) => (
                <Text key={j} style={[styles.resultLine, { marginTop: spacing.xs }]}>
                  {l.from_name} → {l.to_name}: {l.train_found ? `train ${l.train_number}${l.train_name ? ` (${l.train_name})` : ""}, dep ${l.departure_time || "?"} → arr ${l.arrival_time || "?"}` : "no confirmed train found for this leg"}
                </Text>
              ))}
              {!r.all_legs_confirmed && <Disclaimer text="One or more legs has no confirmed real train — the corridor exists, but no specific train was found for it." />}
            </ResultBox>
          ))}
        </>
      )}

      {/* FEATURE: Trip Planning with Alternative Transport (Bus/Flight) —
          see backend/alt_transport.py. Only present when the backend found
          no usable train option at all for this route/date. */}
      {data && data.alt_transport && (
        <ResultBox style={{ borderColor: colors.danger, borderWidth: 1 }}>
          <Text style={[styles.resultTitle, { color: colors.danger }]}>
            No train option found{data.alt_transport.distance_known ? ` — ~${data.alt_transport.rail_distance_km} km by rail distance` : ""}
          </Text>
          {!data.alt_transport.distance_known ? (
            <Text style={styles.resultLine}>{data.alt_transport.note}</Text>
          ) : (
            <>
              {(data.alt_transport.guidance || []).map((g, i) => (
                <Text key={i} style={[styles.resultLine, { marginTop: spacing.xs }]}>
                  {g.mode === "flight" ? "✈️" : "🚌"} {g.text}
                </Text>
              ))}
              <Disclaimer text={data.alt_transport.disclaimer} />
            </>
          )}
        </ResultBox>
      )}

      {destStation && destStation.lat != null && (
        <ResultBox>
          <Text style={styles.resultTitle}>Continue from {destStation.name}</Text>
          <Text style={styles.resultLine}>Opens Uber/Ola with the station set as pickup — pick your drop-off in their app for real live pricing (no fare shown here, this app has no partner fare API).</Text>
          <View style={{ flexDirection: "row", marginTop: spacing.sm }}>
            <PrimaryButton title="Open in Uber" onPress={() => Linking.openURL(uberDeepLink(destStation))} variant="secondary" style={{ flex: 1, marginRight: spacing.sm }} />
            <PrimaryButton title="Open in Ola" onPress={() => Linking.openURL(olaDeepLink(destStation))} variant="secondary" style={{ flex: 1 }} />
          </View>
        </ResultBox>
      )}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * NEW — Real-Time Delay Dashboard with Historical Patterns
 * ------------------------------------------------------------------- */
function DelayHistoryTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [days, setDays] = useState("14");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!/^\d{5}$/.test(trainNumber)) { setError("Enter a valid 5-digit train number."); return; }
    setLoading(true); setError(null);
    try { setData(await getDelayHistory(apiBaseUrl, trainNumber, parseInt(days, 10) || 14)); }
    catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Delay History" subtitle="Real completed-journey history for this train, grouped by weekday — days with no data are shown as such, never averaged in as zero.">
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <Chips options={[{ key: "7", label: "7 days" }, { key: "14", label: "14 days" }, { key: "30", label: "30 days" }]} value={days} onSelect={setDays} />
      <PrimaryButton title="Show History" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      {data && (
        <>
          <Disclaimer text={data.note} />
          <Text style={[styles.resultTitle, { marginTop: spacing.md }]}>By weekday ({data.days_with_data}/{data.lookback_days} days had data)</Text>
          {data.weekday_summary.map((w) => (
            <View key={w.weekday} style={styles.listRow}>
              <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>{w.weekday}</Text>
              <Text style={styles.resultLine}>{w.avg_delay_minutes != null ? `+${w.avg_delay_minutes}m avg (${w.samples})` : "no data"}</Text>
            </View>
          ))}
          <Text style={[styles.resultTitle, { marginTop: spacing.md }]}>Day-by-day</Text>
          {data.days.map((d, i) => (
            <View key={i} style={styles.listRow}>
              <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>{d.date} ({d.weekday})</Text>
              <Text style={styles.resultLine}>{d.data_available ? `+${formatDelayDuration(d.delay_minutes)}` : "no data"}</Text>
            </View>
          ))}
          {(() => {
            const unmatched = data.days.find((d) => d.raw_keys && d.raw_keys.length);
            return unmatched ? (
              <Disclaimer text={`Provider returned data but no field matched a delay figure — real fields seen for ${unmatched.date}: ${unmatched.raw_keys.join(", ")}`} />
            ) : null;
          })()}
        </>
      )}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * NEW — PNR Auto-Tracking & Status Change Alerts
 * ------------------------------------------------------------------- */
function PnrTrackTool({ apiBaseUrl }) {
  const [pnr, setPnr] = useState("");
  const [label, setLabel] = useState("");
  const [lookup, setLookup] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [watchlist, setWatchlist] = useState([]);
  const [changedNote, setChangedNote] = useState(null);
  const [watchLoading, setWatchLoading] = useState(false);

  const loadWatchlist = useCallback(async () => {
    const raw = await AsyncStorage.getItem(PNR_WATCH_KEY);
    setWatchlist(raw ? JSON.parse(raw) : []);
  }, []);
  React.useEffect(() => { loadWatchlist(); }, [loadWatchlist]);

  async function check() {
    if (!/^\d{10}$/.test(pnr)) { setError("Enter a valid 10-digit PNR."); return; }
    setLoading(true); setError(null);
    try { setLookup(await getPnrStatus(apiBaseUrl, pnr)); }
    catch (e) { setError(describeApiError(e)); setLookup(null); }
    finally { setLoading(false); }
  }

  async function addToWatchlist() {
    if (!/^\d{10}$/.test(pnr)) { setError("Enter a valid 10-digit PNR first."); return; }
    if (watchlist.some((w) => w.pnr === pnr)) { setError("Already on your watchlist."); return; }
    const updated = [...watchlist, { pnr, label: label.trim() || null, last_known_status: null }];
    await AsyncStorage.setItem(PNR_WATCH_KEY, JSON.stringify(updated));
    setWatchlist(updated);
  }

  async function removeFromWatchlist(targetPnr) {
    const updated = watchlist.filter((w) => w.pnr !== targetPnr);
    await AsyncStorage.setItem(PNR_WATCH_KEY, JSON.stringify(updated));
    setWatchlist(updated);
  }

  async function refreshWatchlist() {
    if (!watchlist.length) return;
    setWatchLoading(true); setChangedNote(null);
    try {
      const data = await checkPnrWatchlist(apiBaseUrl, watchlist);
      const changed = [];
      const updated = watchlist.map((entry) => {
        const row = (data.results || []).find((r) => r.pnr === entry.pnr);
        if (!row) return entry;
        if (row.status_changed) changed.push(entry.label || entry.pnr);
        return { ...entry, last_known_status: row.overall_status_text || entry.last_known_status };
      });
      await AsyncStorage.setItem(PNR_WATCH_KEY, JSON.stringify(updated));
      setWatchlist(updated);
      setChangedNote(changed.length ? `🔔 Status changed for: ${changed.join(", ")}` : "Refreshed — no status changes.");
    } catch (e) { setError(describeApiError(e)); }
    finally { setWatchLoading(false); }
  }

  return (
    <SectionCard title="PNR Auto-Tracking" subtitle="Real current status, plus a watchlist that flags when a status changes since you last checked. In-app checking on refresh — no background push (needs your own Firebase/Apple credentials).">
      <LabeledInput label="PNR (10-digit)" value={pnr} onChangeText={setPnr} keyboardType="number-pad" maxLength={10} />
      <LabeledInput label="Label (optional)" value={label} onChangeText={setLabel} autoCapitalize="sentences" />
      <PrimaryButton title="Check PNR" onPress={check} loading={loading} style={{ marginTop: spacing.sm }} />
      <PrimaryButton title="➕ Add to watchlist" onPress={addToWatchlist} variant="secondary" style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      {lookup && !lookup.error && (
        <ResultBox>
          <Text style={styles.resultTitle}>{lookup.train_number || "?"}{lookup.train_name ? ` — ${lookup.train_name}` : ""}</Text>
          <Text style={styles.resultLine}>{lookup.overall_status_text || "status unknown"}</Text>
          <Text style={styles.resultLine}>{lookup.from_station || "?"} → {lookup.to_station || "?"}{lookup.date_of_journey ? ` · ${lookup.date_of_journey}` : ""}</Text>
          <Text style={styles.resultLine}>Chart: {lookup.chart_prepared == null ? "unknown" : (lookup.chart_prepared ? "prepared" : "not yet prepared")}</Text>
          {(lookup.passengers || []).map((p, i) => (
            <Text key={i} style={styles.resultLine}>Passenger {p.number}: {p.current_status || "unknown"}{p.coach ? ` · Coach ${p.coach}` : ""}{p.berth ? ` · Berth ${p.berth}` : ""}</Text>
          ))}
          {!lookup.train_number && !lookup.overall_status_text && !lookup.from_station && lookup.raw_keys && lookup.raw_keys.length > 0 && (
            <Disclaimer text={`Couldn't match any fields yet — real fields seen: ${lookup.raw_keys.join(", ")}. Share this with support so the exact field names can be wired in.`} />
          )}
        </ResultBox>
      )}
      {lookup && lookup.error && <Text style={styles.error}>{lookup.error}</Text>}

      <Text style={[styles.resultTitle, { marginTop: spacing.lg }]}>Watchlist</Text>
      <PrimaryButton title="🔄 Refresh all" onPress={refreshWatchlist} loading={watchLoading} variant="secondary" />
      {changedNote && <Disclaimer text={changedNote} />}
      {watchlist.map((w, idx) => (
        <View key={idx} style={styles.listRow}>
          <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>{w.label || w.pnr} ({w.pnr}) — {w.last_known_status || "not checked yet"}</Text>
          <TouchableOpacity onPress={() => removeFromWatchlist(w.pnr)}><Text style={styles.removeBtn}>×</Text></TouchableOpacity>
        </View>
      ))}
      {!watchlist.length && <Text style={styles.resultLine}>No PNRs on your watchlist yet.</Text>}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * FEATURE 1: "When Should I Leave?" Smart Departure Reminder
 * ------------------------------------------------------------------- */
const MODE_OPTIONS = [
  { key: "walk", label: "🚶 Walk" }, { key: "auto", label: "🛺 Auto" }, { key: "bike", label: "🏍️ Bike" },
  { key: "car", label: "🚗 Car" }, { key: "taxi", label: "🚕 Taxi" }, { key: "bus", label: "🚌 Bus" }, { key: "metro", label: "🚇 Metro" },
];
function DepartureReminderTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [station, setStation] = useState("");
  const [mode, setMode] = useState("walk");
  const [distanceKm, setDistanceKm] = useState("");
  const [bufferMin, setBufferMin] = useState("25");
  const [coords, setCoords] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [locLoading, setLocLoading] = useState(false);

  async function useMyLocation() {
    setLocLoading(true); setError(null);
    try {
      const Location = require("expo-location");
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") { setError("Location permission denied."); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      setDistanceKm("");
    } catch (e) {
      setError(e?.message?.includes("expo-location") ? "expo-location isn't installed in this build yet." : "Couldn't get your location.");
    } finally { setLocLoading(false); }
  }

  async function run() {
    if (!/^\d{5}$/.test(trainNumber) || !station.trim()) { setError("Enter a valid train number and boarding station."); return; }
    setLoading(true); setError(null);
    try {
      setData(await getDepartureReminder(apiBaseUrl, {
        trainNumber, boardingStation: station.trim(), mode,
        distanceKm: distanceKm ? parseFloat(distanceKm) : null,
        userLat: distanceKm ? null : coords?.lat, userLng: distanceKm ? null : coords?.lng,
        boardingBufferMinutes: parseInt(bufferMin, 10) || 25,
      }));
    } catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="When Should I Leave?" subtitle="Real live departure time (with delay folded in) minus your real travel time to the station.">
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <LabeledInput label="Boarding station code" value={station} onChangeText={setStation} autoCapitalize="characters" />
      <Text style={styles.chipLabel}>Mode of travel to the station</Text>
      <Chips options={MODE_OPTIONS} value={mode} onSelect={setMode} />
      <LabeledInput label="Distance to station (km) — or use location below" value={distanceKm} onChangeText={setDistanceKm} keyboardType="decimal-pad" />
      <PrimaryButton title={coords ? "📍 Location set" : "📍 Use my current location"} onPress={useMyLocation} loading={locLoading} variant="secondary" style={{ marginTop: spacing.sm }} />
      <LabeledInput label="Boarding buffer (min)" value={bufferMin} onChangeText={setBufferMin} keyboardType="number-pad" />
      <PrimaryButton title="When should I leave?" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      <ResultBox>
        {data && !data.found && <Text style={styles.resultLine}>{data.note}</Text>}
        {data && data.found && !data.leave_by && <Text style={styles.resultLine}>{data.note || "Give a distance or your location for a leave-by time."}</Text>}
        {data && data.leave_by && (
          <>
            <Text style={styles.resultTitle}>Leave by {data.leave_by} ({data.urgency.replace(/_/g, " ")})</Text>
            <Text style={styles.resultLine}>Departure ({data.station}): sch. {data.scheduled_departure || "?"}{data.expected_departure && data.expected_departure !== data.scheduled_departure ? `, exp. ${data.expected_departure}` : ""}{data.delay_minutes ? ` (+${formatDelayDuration(data.delay_minutes)})` : ""}</Text>
            <Text style={styles.resultLine}>{data.distance_km} km by {data.mode} (~{data.assumed_speed_kmph} km/h) ≈ {data.travel_minutes} min + {data.boarding_buffer_minutes} min buffer</Text>
            <Text style={styles.resultLine}>{data.minutes_until_leave > 0 ? `About ${data.minutes_until_leave} min before you should leave.` : `${Math.abs(data.minutes_until_leave)} min past the recommended leave time.`}</Text>
            <Disclaimer text={data.disclaimer} />
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * FEATURE 9: "Platform Finder" with Indoor Navigation
 * ------------------------------------------------------------------- */
function PlatformNavTool({ apiBaseUrl }) {
  const [station, setStation] = useState("");
  const [platformNumber, setPlatformNumber] = useState("");
  const [trainNumber, setTrainNumber] = useState("");
  const [entryPoint, setEntryPoint] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!station.trim() || (!platformNumber && !trainNumber)) { setError("Enter a station, and either a platform number or a train number."); return; }
    setLoading(true); setError(null);
    try {
      setData(await getPlatformNavigation(apiBaseUrl, {
        station: station.trim(), platformNumber: platformNumber ? parseInt(platformNumber, 10) : null,
        trainNumber: trainNumber.trim() || null, entryPoint: entryPoint.trim() || null,
      }));
    } catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Platform Finder — Indoor Navigation" subtitle="Generic step-by-step wayfinding — no Indian station publishes a real indoor map via any reachable API.">
      <LabeledInput label="Station code" value={station} onChangeText={setStation} autoCapitalize="characters" />
      <LabeledInput label="Platform number (optional)" value={platformNumber} onChangeText={setPlatformNumber} keyboardType="number-pad" />
      <LabeledInput label="...or train number to predict it" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <LabeledInput label="Your entrance (optional)" value={entryPoint} onChangeText={setEntryPoint} placeholder="e.g. Ajmeri Gate side" />
      <PrimaryButton title="Get Directions" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      <ResultBox>
        {data && (
          <>
            <Text style={styles.resultTitle}>To Platform {data.platform_number} (~{data.estimated_walk_minutes} min walk)</Text>
            {data.platform_source === "predicted_from_train_number" && <Text style={styles.resultLine}>Platform predicted from train number ({data.platform_predict_confidence}).</Text>}
            {(data.steps || []).map((s, i) => <Text key={i} style={styles.resultLine}>{i + 1}. {s}</Text>)}
            {data.nearby_amenities_note && <Text style={styles.resultLine}>{data.nearby_amenities_note}</Text>}
            <Disclaimer text={data.disclaimer} />
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * FEATURE 3: "Smart Alarm" Based on Real-Time Train Position
 * ------------------------------------------------------------------- */
function SmartAlarmTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [station, setStation] = useState("");
  const [leadMinutes, setLeadMinutes] = useState("10");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [autoCheck, setAutoCheck] = useState(false);

  const check = useCallback(async () => {
    if (!/^\d{5}$/.test(trainNumber) || !station.trim()) { setError("Enter a valid train number and destination station."); return; }
    setLoading(true); setError(null);
    try {
      setData(await checkSmartAlarm(apiBaseUrl, { trainNumber, destinationStation: station.trim(), leadMinutes: parseFloat(leadMinutes) || 10 }));
    } catch (e) { setError(describeApiError(e)); }
    finally { setLoading(false); }
  }, [apiBaseUrl, trainNumber, station, leadMinutes]);

  React.useEffect(() => {
    if (!autoCheck) return undefined;
    const id = setInterval(check, 60000);
    return () => clearInterval(id);
  }, [autoCheck, check]);

  return (
    <SectionCard title="Smart Alarm" subtitle="Checks this train's real live position/ETA — same feed the live map uses. Keep the app open for auto-check to keep working.">
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <LabeledInput label="Destination station code" value={station} onChangeText={setStation} autoCapitalize="characters" />
      <LabeledInput label="Alert me (min before arrival)" value={leadMinutes} onChangeText={setLeadMinutes} keyboardType="number-pad" />
      <PrimaryButton title="Check now" onPress={check} loading={loading} style={{ marginTop: spacing.sm }} />
      <TouchableOpacity style={styles.listRow} onPress={() => setAutoCheck((v) => !v)}>
        <Text style={{ fontSize: 13, color: colors.text }}>{autoCheck ? "☑" : "☐"} Auto-check every minute (while app is open)</Text>
      </TouchableOpacity>
      <ErrorText text={error} />
      <ResultBox>
        {data && !data.found && <Text style={styles.resultLine}>{data.note}</Text>}
        {data && data.already_passed && <Text style={styles.resultLine}>{data.note}</Text>}
        {data && data.found && !data.already_passed && data.note && !data.scheduled_arrival && !data.expected_arrival && <Text style={styles.resultLine}>{data.note}</Text>}
        {data && data.found && !data.already_passed && !(data.note && !data.scheduled_arrival && !data.expected_arrival) && (
          <>
            <Text style={[styles.resultTitle, data.alarm_now && styles.dangerText]}>{data.alarm_now ? "🔔 Get ready — you're close!" : "Not yet"}</Text>
            <Text style={styles.resultLine}>Arrival at {data.station}: sch. {data.scheduled_arrival || "?"}{data.expected_arrival && data.expected_arrival !== data.scheduled_arrival ? `, exp. ${data.expected_arrival}` : ""}{data.delay_minutes ? ` (+${formatDelayDuration(data.delay_minutes)})` : ""}</Text>
            {data.minutes_remaining != null && <Text style={styles.resultLine}>~{data.minutes_remaining} min remaining</Text>}
            {data.distance_remaining_km != null && <Text style={styles.resultLine}>~{data.distance_remaining_km} km remaining</Text>}
            <Disclaimer text={data.disclaimer} />
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * FEATURE 5: "Transit Time Optimizer"
 * ------------------------------------------------------------------- */
function TransitOptimizerTool({ apiBaseUrl }) {
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [departAfter, setDepartAfter] = useState("");
  const [departBefore, setDepartBefore] = useState("");
  const [arriveAfter, setArriveAfter] = useState("");
  const [arriveBefore, setArriveBefore] = useState("");
  const [preferredArrival, setPreferredArrival] = useState("");
  const [maxDuration, setMaxDuration] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!source.trim() || !dest.trim()) { setError("Enter both stations."); return; }
    setLoading(true); setError(null);
    try {
      setData(await getTransitOptimizer(apiBaseUrl, {
        source: source.trim(), dest: dest.trim(), departAfter, departBefore, arriveAfter, arriveBefore,
        preferredArrival, maxDurationHours: maxDuration ? parseFloat(maxDuration) : null,
      }));
    } catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Transit Time Optimizer" subtitle="Ranks every real train on this route against the schedule window you give.">
      <LabeledInput label="From (code)" value={source} onChangeText={setSource} autoCapitalize="characters" />
      <LabeledInput label="To (code)" value={dest} onChangeText={setDest} autoCapitalize="characters" />
      <LabeledInput label="Depart after (HH:MM)" value={departAfter} onChangeText={setDepartAfter} keyboardType="numbers-and-punctuation" />
      <LabeledInput label="Depart before (HH:MM)" value={departBefore} onChangeText={setDepartBefore} keyboardType="numbers-and-punctuation" />
      <LabeledInput label="Arrive after (HH:MM)" value={arriveAfter} onChangeText={setArriveAfter} keyboardType="numbers-and-punctuation" />
      <LabeledInput label="Arrive before (HH:MM)" value={arriveBefore} onChangeText={setArriveBefore} keyboardType="numbers-and-punctuation" />
      <LabeledInput label="Preferred arrival time (HH:MM)" value={preferredArrival} onChangeText={setPreferredArrival} keyboardType="numbers-and-punctuation" />
      <LabeledInput label="Max journey length (hours)" value={maxDuration} onChangeText={setMaxDuration} keyboardType="decimal-pad" />
      <PrimaryButton title="Find Best Trains" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      {data?.error && <Text style={styles.error}>{data.error}</Text>}
      {data?.trains?.map((t, i) => (
        <ResultBox key={t.train_number + i}>
          <Text style={styles.resultTitle}>#{i + 1} {t.train_number} — {t.train_name}{!t.fits_schedule ? " (outside your window)" : ""}</Text>
          <Text style={styles.resultLine}>Departs {t.source_departure || "?"} → Arrives {t.dest_arrival || "?"} ({t.duration || "?"})</Text>
          {(t.why || []).map((w, j) => <Text key={j} style={styles.resultLine}>• {w}</Text>)}
        </ResultBox>
      ))}
      {data && <Disclaimer text={data.disclaimer} />}
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * FEATURE 6: "Route Visualization" with Time-Lapse
 * ------------------------------------------------------------------- */
function _tlPositionAt(stops, progress0to1) {
  if (!stops.length) return null;
  let before = stops[0], after = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (stops[i].progress <= progress0to1 && stops[i + 1].progress >= progress0to1) { before = stops[i]; after = stops[i + 1]; break; }
  }
  const span = (after.progress - before.progress) || 1;
  const ratio = Math.min(1, Math.max(0, (progress0to1 - before.progress) / span));
  return {
    latitude: before.lat + (after.lat - before.lat) * ratio,
    longitude: before.lng + (after.lng - before.lng) * ratio,
    nearStop: ratio < 0.5 ? before : after,
  };
}
function RouteTimelapseTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [data, setData] = useState(null);
  const [stops, setStops] = useState([]);
  const [progress, setProgress] = useState(0); // 0..1
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const mapRef = React.useRef(null);

  async function run() {
    if (!/^\d{5}$/.test(trainNumber)) { setError("Enter a valid 5-digit train number."); return; }
    setLoading(true); setError(null); setPlaying(false); setProgress(0);
    try {
      const result = await getRouteTimelapse(apiBaseUrl, trainNumber);
      setData(result);
      const plottable = result.found ? (result.stops || []).filter((s) => s.lat != null && s.lng != null && s.progress != null) : [];
      setStops(plottable);
      if (plottable.length > 1 && mapRef.current) {
        setTimeout(() => mapRef.current?.fitToCoordinates(
          plottable.map((s) => ({ latitude: s.lat, longitude: s.lng })),
          { edgePadding: { top: 40, right: 40, bottom: 40, left: 40 }, animated: true },
        ), 300);
      }
    } catch (e) { setError(describeApiError(e)); setData(null); setStops([]); }
    finally { setLoading(false); }
  }

  React.useEffect(() => {
    if (!playing || stops.length < 2) return undefined;
    const id = setInterval(() => {
      setProgress((p) => {
        const next = p + 0.02;
        if (next >= 1) { setPlaying(false); return 1; }
        return next;
      });
    }, 200);
    return () => clearInterval(id);
  }, [playing, stops.length]);

  const pos = stops.length > 1 ? _tlPositionAt(stops, progress) : null;

  return (
    <SectionCard title="Route Time-Lapse" subtitle="Animates your train's real route stop-by-stop, paced by real distance between stops.">
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <PrimaryButton title="Load Route" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      {data && !data.found && <Text style={styles.resultLine}>{data.note}</Text>}
      {stops.length > 1 && (
        <>
          <MapView
            ref={mapRef}
            style={{ width: "100%", height: 220, borderRadius: radius.md, marginTop: spacing.md }}
            provider={PROVIDER_GOOGLE}
            initialRegion={{ latitude: stops[0].lat, longitude: stops[0].lng, latitudeDelta: 4, longitudeDelta: 4 }}
          >
            <Polyline coordinates={stops.map((s) => ({ latitude: s.lat, longitude: s.lng }))} strokeColor={colors.primary} strokeWidth={3} />
            {stops.map((s, i) => (
              <Marker key={s.code + i} coordinate={{ latitude: s.lat, longitude: s.lng }} title={`${s.name} (${s.code})`} pinColor={colors.border} opacity={0.6} />
            ))}
            {pos && <Marker coordinate={{ latitude: pos.latitude, longitude: pos.longitude }} title="Train" pinColor={colors.accent} />}
          </MapView>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: spacing.sm, gap: 8 }}>
            <PrimaryButton title={playing ? "⏸ Pause" : "▶ Play"} onPress={() => setPlaying((p) => !p)} style={{ flex: 1 }} />
            <PrimaryButton title="⏮ Reset" onPress={() => { setPlaying(false); setProgress(0); }} variant="secondary" style={{ flex: 1 }} />
          </View>
          {pos?.nearStop && (
            <ResultBox>
              <Text style={styles.resultLine}>Nearest stop: {pos.nearStop.name} ({pos.nearStop.code}){pos.nearStop.scheduled_arrival ? ` — sch. arr. ${pos.nearStop.scheduled_arrival}` : ""}</Text>
            </ResultBox>
          )}
          <Disclaimer text={data?.disclaimer} />
        </>
      )}
    </SectionCard>
  );
}

// NOTE: "Live Crowd Map for Train Coaches" and "Water/Restroom Availability
// Live Check" were removed — neither RailKit (RapidAPI) nor RailRadar, the
// two live-data providers this app has access to, expose any real
// per-coach occupancy or water/restroom sensor feed.

/* ---------------------------------------------------------------------
 * NEW — "Optimal Booking Window" Predictor
 * ------------------------------------------------------------------- */
function BookingWindowTool({ apiBaseUrl }) {
  const [trainNumber, setTrainNumber] = useState("");
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [dateText, setDateText] = useState("");
  const [travelClass, setTravelClass] = useState("SL");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!/^\d{5}$/.test(trainNumber) || !source.trim() || !dest.trim()) {
      setError("Enter train number, source, and destination."); return;
    }
    setLoading(true); setError(null);
    try {
      setData(await getBookingWindow(apiBaseUrl, {
        trainNumber, source: source.trim(), dest: dest.trim(), date: dateText.trim() || null, travelClass,
      }));
    } catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  const URGENCY_LABEL = { open: "🟢 Open", tightening: "🟡 Tightening", tight: "🔴 Tight", unknown: "No live status" };

  return (
    <SectionCard title="Optimal Booking Window" subtitle="Real IRCTC booking rules (120-day ARP, Tatkal timing) + this train's real current availability — not a fabricated demand forecast.">
      <LabeledInput label="Train number" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" maxLength={5} />
      <LabeledInput label="From (code)" value={source} onChangeText={setSource} />
      <LabeledInput label="To (code)" value={dest} onChangeText={setDest} />
      <LabeledInput label="Date (dd-mm-yyyy, optional)" value={dateText} onChangeText={setDateText} />
      <Chips options={CLASS_OPTIONS} value={travelClass} onSelect={setTravelClass} />
      <PrimaryButton title="Check Booking Window" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      <ResultBox>
        {data && (
          <>
            <Text style={styles.resultTitle}>
              {trainNumber} {source}→{dest} ({travelClass}) {URGENCY_LABEL[data.urgency] || ""}
            </Text>
            {data.days_until_departure != null && <Text style={styles.resultLine}>{data.days_until_departure} day(s) until departure.</Text>}
            {(data.advice || []).map((a, i) => <Text key={i} style={styles.resultLine}>• {a}</Text>)}
            {data.session_crowd_trend && (
              <Disclaimer text={`${data.session_crowd_trend.note} (${data.session_crowd_trend.points_this_session} point(s) logged this session.)`} />
            )}
            <Disclaimer text={data.disclaimer} />
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * NEW — "Station Navigator" — Point of Interest Finder
 * ------------------------------------------------------------------- */
function StationNavigatorTool({ apiBaseUrl }) {
  const [station, setStation] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run() {
    if (!station.trim()) { setError("Enter a station code."); return; }
    setLoading(true); setError(null);
    try { setData(await getStationNavigator(apiBaseUrl, station.trim().toUpperCase())); }
    catch (e) { setError(describeApiError(e)); setData(null); }
    finally { setLoading(false); }
  }

  return (
    <SectionCard title="Station Navigator" subtitle="Facilities reference — platform count, entrance sides (for a few major termini where genuinely documented), and where things typically cluster. Not a live/confirmed indoor map.">
      <LabeledInput label="Station code, e.g. NDLS" value={station} onChangeText={(t) => setStation(t.toUpperCase())} autoCapitalize="characters" />
      <PrimaryButton title="Look Up" onPress={run} loading={loading} style={{ marginTop: spacing.sm }} />
      <ErrorText text={error} />
      <ResultBox>
        {data && (
          <>
            <Text style={styles.resultTitle}>
              {data.name || data.station} {data.station_platform_count != null ? `· ${data.station_platform_count} platform(s)${data.platform_count_basis === "known" ? "" : " (estimated)"}` : ""}
            </Text>
            {data.notable_note && <Text style={styles.resultLine}>{data.notable_note}</Text>}
            {!!data.entrance_sides?.length && (
              <>
                <Text style={styles.resultSubhead}>Entrance sides</Text>
                {data.entrance_sides.map((s, i) => <Text key={i} style={styles.resultLine}>• {s}</Text>)}
              </>
            )}
            {!!data.facilities?.length && (
              <>
                <Text style={[styles.resultSubhead, { marginTop: spacing.sm }]}>Facilities</Text>
                {data.facilities.map((f, i) => <Text key={i} style={styles.resultLine}>• {f.label} — {f.typical_location_note}</Text>)}
              </>
            )}
            {!!data.layout_guidance?.length && (
              <>
                <Text style={[styles.resultSubhead, { marginTop: spacing.sm }]}>Layout guidance</Text>
                {data.layout_guidance.map((g, i) => <Text key={i} style={styles.resultLine}>• {g}</Text>)}
              </>
            )}
            <Disclaimer text={data.disclaimer} />
          </>
        )}
      </ResultBox>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------
 * Screen shell
 * ------------------------------------------------------------------- */
const TOOL_COMPONENTS = {
  platform: PlatformTool, pantry: PantryTool, amenities: AmenitiesTool, mytrains: MyTrainsTool,
  delayimpact: DelayImpactTool, coach: CoachLayoutTool, seat: SeatPickerTool, compare: RouteCompareTool,
  refund: RefundTool, heatmap: FareHeatmapTool, alerts: AlertsTool, crowd: StationCrowdTool,
  parcel: ParcelTool, offline: OfflineTool, gantt: GanttTool, profile: ProfileTool, nearme: NearMeTool,
  journeyplanner: JourneyPlannerTool, delayhistory: DelayHistoryTool, pnrtrack: PnrTrackTool,
  departure: DepartureReminderTool, platformnav: PlatformNavTool, smartalarm: SmartAlarmTool,
  transitoptimizer: TransitOptimizerTool, timelapse: RouteTimelapseTool,
  bookingwindow: BookingWindowTool, stationnav: StationNavigatorTool,
};

export default function MoreToolsScreen() {
  const { apiBaseUrl } = useSettings();
  const [active, setActive] = useState("platform");
  const ActiveComponent = TOOL_COMPONENTS[active];

  return (
    <View style={styles.flex}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabScroll} contentContainerStyle={styles.tabScrollContent}>
        {TOOLS.map((t) => (
          <TouchableOpacity key={t.key} style={[styles.tab, active === t.key && styles.tabActive]} onPress={() => setActive(t.key)}>
            <Text style={[styles.tabText, active === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        {ActiveComponent && <ActiveComponent apiBaseUrl={apiBaseUrl} />}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  tabScroll: { flexGrow: 0, backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border },
  tabScrollContent: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 8 },
  tab: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill,
    borderWidth: 1.5, borderColor: colors.primary, marginRight: 8,
  },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: "600", color: colors.primary },
  tabTextActive: { color: colors.textInverse },
  content: { padding: spacing.lg },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  chipLabel: { fontSize: 12, fontWeight: "600", color: colors.textMuted, marginTop: spacing.sm, marginBottom: 2 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textMuted },
  chipTextActive: { color: colors.textInverse },
  resultBox: { marginTop: spacing.md, padding: spacing.md, backgroundColor: colors.bg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  resultTitle: { fontSize: 14, fontWeight: "700", color: colors.text, marginBottom: 4 },
  resultSubhead: { fontSize: 12, fontWeight: "700", color: colors.primary },
  resultLine: { fontSize: 13, color: colors.text, marginBottom: 2 },
  disclaimer: { fontSize: 11, color: colors.textMuted, fontStyle: "italic", marginTop: 6 },
  error: { fontSize: 13, color: colors.danger, marginTop: 6 },
  dangerText: { color: colors.danger, fontWeight: "700" },
  listRow: {
    flexDirection: "row", alignItems: "center", paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  removeBtn: { fontSize: 20, color: colors.danger, paddingHorizontal: spacing.sm },
  ganttRow: { flexDirection: "row", alignItems: "center", marginBottom: 6, gap: 8 },
  ganttName: { width: 90, fontSize: 11, fontWeight: "600", color: colors.text },
  ganttTrack: { flex: 1, height: 8, backgroundColor: colors.border, borderRadius: 4, overflow: "hidden" },
  ganttBar: { height: "100%", borderRadius: 4 },
  ganttDelay: { width: 50, fontSize: 11, textAlign: "right", color: colors.textMuted },
  heatmapRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: spacing.md },
  heatmapCell: { minWidth: 80, padding: 8, borderRadius: radius.sm, backgroundColor: "#fbeaea", borderWidth: 1, borderColor: colors.danger, alignItems: "center" },
  heatmapCellMuted: { backgroundColor: colors.bg, borderColor: colors.border },
  heatmapCellLabel: { fontSize: 10, fontWeight: "700", color: colors.danger },
  heatmapCellCount: { fontSize: 16, fontWeight: "700", color: colors.danger },
  heatmapCellLabelMuted: { fontSize: 10, fontWeight: "700", color: colors.textMuted },
  heatmapCellCountMuted: { fontSize: 16, fontWeight: "700", color: colors.textMuted },
  offlineMap: { width: "100%", height: 180, borderRadius: radius.md, marginTop: spacing.md },
});