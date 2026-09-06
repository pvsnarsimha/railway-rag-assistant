import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Share, Linking } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { buildTrackingWsUrl, saveTripSummary, buildTrackShareUrl, buildTripShareUrl } from "../api/railwayApi";
import { formatDelayDuration } from "../utils/formatDelay";

// FEATURE: Live delay-trend sparkline — same rolling-buffer size as the
// native screen's DelaySparkline and the web app's ltDelaySparkline.
const SPARKLINE_MAX_POINTS = 20;

// A share link built from a private/local host (localhost, a bare LAN IP)
// only ever resolves on this device/WiFi — see the matching comment in
// TrackedTrainCard.js for the full explanation. Same check, duplicated
// here rather than shared, since this file is a separate Metro entry
// point (the web-only fallback) from the native component.
function extractHostname(url) {
  return (url || "").replace(/^[a-zA-Z][\w+.-]*:\/\//, "").split(/[/:?#]/)[0];
}
function isPrivateOrLocalHost(url) {
  const h = extractHostname(url).toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h === "10.0.2.2" || h.endsWith(".local")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}
const LOCAL_SHARE_WARNING =
  "⚠️ Local address — won't open for anyone outside this device/WiFi. See the README's \"Sharing links publicly\" section.";

/**
 * Web build of Live Tracking. `react-native-maps` has no web target — even
 * importing it breaks Metro's web bundle (see MapMarkerNativeComponent's
 * native-only import) — so this file exists purely so Metro's platform
 * resolution (`LiveTrackingScreen.web.js` beats `LiveTrackingScreen.js` on
 * web) picks a map-free screen instead of one that imports react-native-maps.
 * Everything except the map itself — the live WebSocket feed, delay/crowd
 * prediction, and stop timeline — works identically to the native screen.
 * The native/Expo Go build still gets the full map in LiveTrackingScreen.js.
 */

// green = already arrived, yellow = the very next station the train is
// heading to, red = stations further out that haven't been reached yet.
const STATUS_COLOR = {
  passed: colors.success,
  current: colors.warning,
  upcoming: colors.danger,
};

export default function LiveTrackingScreen() {
  const { wsBaseUrl, apiBaseUrl } = useSettings();
  const [trainNumber, setTrainNumber] = useState("");
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");
  const [trackDate, setTrackDate] = useState("");
  const [connection, setConnection] = useState("idle");
  const [payload, setPayload] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const wsRef = useRef(null);

  // FEATURE: Live delay-trend sparkline — shown as compact text on this
  // already text-only fallback screen, rather than a canvas/SVG chart.
  const [delaySparkline, setDelaySparkline] = useState([]);

  // FEATURE: End-of-Trip Summary Card (shareable).
  const tripSummaryShownKeyRef = useRef(null);
  const [tripSummary, setTripSummary] = useState(null);
  const [tripSummaryShareBusy, setTripSummaryShareBusy] = useState(false);
  const [tripSummaryShareStatus, setTripSummaryShareStatus] = useState(null);

  const [shareLinkNote, setShareLinkNote] = useState(null);
  const shareTrackingLink = useCallback(() => {
    if (!trainNumber.trim()) return;
    const url = buildTrackShareUrl(apiBaseUrl, trainNumber.trim(), trackDate.trim() || null);
    setShareLinkNote(isPrivateOrLocalHost(apiBaseUrl) ? LOCAL_SHARE_WARNING : null);
    Share.share({ message: `Track train ${trainNumber.trim()} live: ${url}`, url }).catch(() => {
      Linking.openURL(url).catch(() => {});
    });
  }, [apiBaseUrl, trainNumber, trackDate]);

  const shareTripSummary = useCallback(async () => {
    if (!tripSummary) return;
    setTripSummaryShareBusy(true);
    setTripSummaryShareStatus(null);
    try {
      const res = await saveTripSummary(apiBaseUrl, { trainNumber: tripSummary.train_number, date: tripSummary.date, summary: tripSummary });
      const url = buildTripShareUrl(apiBaseUrl, res.share_id);
      await Share.share({ message: `My trip on train ${tripSummary.train_number}: ${url}`, url });
      setTripSummaryShareStatus(isPrivateOrLocalHost(apiBaseUrl) ? `Link ready: ${url}\n${LOCAL_SHARE_WARNING}` : `Link ready: ${url}`);
    } catch (e) {
      setTripSummaryShareStatus("Couldn't create a shareable link right now.");
    } finally {
      setTripSummaryShareBusy(false);
    }
  }, [apiBaseUrl, tripSummary]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setConnection("idle");
  }, []);

  const refreshNow = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setRefreshing(true);
      wsRef.current.send(JSON.stringify({ type: "refresh" }));
    }
  }, []);

  useEffect(() => disconnect, [disconnect]);

  function connect() {
    if (!trainNumber.trim()) return;
    disconnect();
    setPayload(null);
    setConnection("connecting");
    setDelaySparkline([]);
    tripSummaryShownKeyRef.current = null;
    setTripSummary(null);
    setTripSummaryShareStatus(null);

    const url = buildTrackingWsUrl(wsBaseUrl, trainNumber.trim(), {
      date: trackDate.trim() || undefined,
      source: source.trim() || undefined,
      dest: dest.trim() || undefined,
    });

    const socket = new WebSocket(url);
    wsRef.current = socket;
    socket.onopen = () => setConnection("open");
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setPayload(data);

        // FEATURE: Live delay-trend sparkline.
        const sparkValue = data.predicted_delay_minutes != null ? data.predicted_delay_minutes : data.delay_minutes;
        if (sparkValue != null) {
          setDelaySparkline((prev) => {
            const next = [...prev, sparkValue];
            return next.length > SPARKLINE_MAX_POINTS ? next.slice(next.length - SPARKLINE_MAX_POINTS) : next;
          });
        }

        // FEATURE: End-of-Trip Summary Card — only once a real actual
        // arrival is recorded at the destination.
        if (data.destination_actual_arrival) {
          const key = `${data.train_number}|${data.date || ""}`;
          if (tripSummaryShownKeyRef.current !== key) {
            const stoppages = (data.timeline || []).filter((s) => s.kind !== "intermediate");
            if (stoppages.length >= 2) {
              tripSummaryShownKeyRef.current = key;
              const origin = stoppages[0];
              const destination = stoppages[stoppages.length - 1];
              const delayOf = (s) => {
                if (s.arrival && s.arrival.delay_minutes != null) return s.arrival.delay_minutes;
                if (s.departure && s.departure.delay_minutes != null) return s.departure.delay_minutes;
                return null;
              };
              let worst = null;
              stoppages.forEach((s) => {
                const d = delayOf(s);
                if (d != null && (!worst || d > worst.delay_minutes)) worst = { name: s.name || s.code, delay_minutes: d };
              });
              setTripSummary({
                train_number: data.train_number,
                date: data.date,
                source_station: origin.name || origin.code,
                destination_station: destination.name || destination.code,
                departure: { scheduled: origin.departure && origin.departure.scheduled, delay_minutes: delayOf(origin) },
                arrival: { scheduled: destination.arrival && destination.arrival.scheduled, delay_minutes: delayOf(destination) },
                worst_station: worst,
                total_distance_km: destination.distance_km || null,
                per_station: stoppages.map((s) => ({ name: s.name || s.code, delay_minutes: delayOf(s) || 0 })),
                generated_at: new Date().toISOString(),
              });
            }
          }
        }
        setLastUpdated(new Date());
        setRefreshing(false);
      } catch (e) {
        // ignore malformed frame
      }
    };
    socket.onerror = () => setConnection("error");
    socket.onclose = () => setConnection((c) => (c === "error" ? c : "closed"));
  }

  const timeline = payload?.timeline || [];

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <SectionCard title="Track a train" subtitle="Streams a position + delay + crowd update every ~5s.">
        <LabeledInput label="Train number" placeholder="e.g. 12709" value={trainNumber} onChangeText={setTrainNumber} keyboardType="number-pad" />
        <LabeledInput label="Date (optional \u2014 defaults to today)" placeholder="DD-MM-YYYY" value={trackDate} onChangeText={setTrackDate} />
        <View style={styles.row}>
          <LabeledInput label="Source (optional)" placeholder="e.g. SC" value={source} onChangeText={setSource} style={styles.half} />
          <LabeledInput label="Dest (optional)" placeholder="e.g. BZA" value={dest} onChangeText={setDest} style={styles.half} />
        </View>
        <View style={styles.row}>
          <PrimaryButton title={connection === "open" ? "Reconnect" : "Start tracking"} onPress={connect} loading={connection === "connecting"} style={styles.half} />
          <PrimaryButton title="Stop" variant="secondary" onPress={disconnect} style={styles.half} />
        </View>
        <View style={styles.row}>
          <ConnectionBadge connection={connection} />
          {connection === "open" && (
            <TouchableOpacity onPress={refreshNow} disabled={refreshing} style={styles.refreshRow}>
              <Ionicons name="refresh" size={14} color={colors.primary} />
              <Text style={styles.refreshText}>
                {refreshing ? "Refreshing\u2026" : lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : "Refresh now"}
              </Text>
            </TouchableOpacity>
          )}
          {/* FEATURE: Shareable read-only tracking link */}
          {trainNumber.trim() && (
            <TouchableOpacity onPress={shareTrackingLink} style={styles.refreshRow}>
              <Ionicons name="link-outline" size={14} color={colors.primary} />
              <Text style={styles.refreshText}>Share link</Text>
            </TouchableOpacity>
          )}
        </View>
        {shareLinkNote && <Text style={styles.errorText}>{shareLinkNote}</Text>}
        <Text style={styles.liteNotice}>
          This web preview is already text-only and map-free \u2014 a natural fit for a slow/patchy connection (the native app's own explicit "Lite mode" hides the map on request instead).
        </Text>
        <View style={styles.webNotice}>
          <Ionicons name="map-outline" size={14} color={colors.textMuted} />
          <Text style={styles.webNoticeText}>
            Map view isn't available in the web preview — open this app in Expo Go on a phone to see the live map.
            Position, delay, and timeline data below still work here.
          </Text>
        </View>
      </SectionCard>

      {/* FEATURE: End-of-Trip Summary Card (shareable) */}
      {tripSummary && (
        <SectionCard title="🏁 Trip complete">
          <Text style={styles.tripSummaryLine}>
            {tripSummary.source_station} → {tripSummary.destination_station} · arrived{" "}
            {tripSummary.arrival.delay_minutes ? `+${formatDelayDuration(tripSummary.arrival.delay_minutes)} late` : "on time"}
            {tripSummary.worst_station ? ` · worst delay at ${tripSummary.worst_station.name} (+${formatDelayDuration(tripSummary.worst_station.delay_minutes)})` : ""}.
          </Text>
          <PrimaryButton title={tripSummaryShareBusy ? "Creating link…" : "🔗 Share this trip recap"} onPress={shareTripSummary} loading={tripSummaryShareBusy} style={{ marginTop: spacing.sm }} />
          {tripSummaryShareStatus && <Text style={styles.webNoticeText}>{tripSummaryShareStatus}</Text>}
        </SectionCard>
      )}

      {/* FEATURE: Route-Deviation / Diversion Detection — see
          backend/route_deviation.py + payload.route_deviation. */}
      {payload?.route_deviation?.likely_diversion && (
        <SectionCard title="🚧 Possible route diversion">
          <Text style={styles.rerouteNote}>{payload.route_deviation.note}</Text>
          <Text style={styles.rerouteDisclaimer}>{payload.route_deviation.disclaimer}</Text>
        </SectionCard>
      )}

      {/* FEATURE: Dynamic Re-route Suggestions During Live Tracking — see
          backend/reroute_suggestions.py + payload.reroute_suggestion. GPS
          position-sharing isn't offered on this map-free web fallback
          screen — see the module docstring above for why this file stays
          deliberately reduced; the native screen (LiveTrackingScreen.js /
          TrackedTrainCard.js) is the "mobile-first GPS" target for that. */}
      {payload?.reroute_suggestion?.triggered && (
        <SectionCard title="⚠️ Re-route suggestion">
          <Text style={styles.rerouteTitle}>
            Running {formatDelayDuration(payload.reroute_suggestion.delay_minutes_used)} late ({payload.reroute_suggestion.delay_source})
          </Text>
          <Text style={styles.rerouteNote}>{payload.reroute_suggestion.note}</Text>
          {payload.reroute_suggestion.direct_alternatives?.length > 0 && (
            <>
              <Text style={styles.rerouteSubhead}>
                Alternative trains from {payload.reroute_suggestion.junction_name || payload.reroute_suggestion.junction_code}
                {" "}to {payload.reroute_suggestion.destination_name || payload.reroute_suggestion.destination_code}:
              </Text>
              {payload.reroute_suggestion.direct_alternatives.map((t, i) => (
                <Text key={i} style={styles.rerouteAltLine}>
                  {t.train_number}{t.train_name ? ` — ${t.train_name}` : ""} · dep {t.departure_time || "?"} → arr {t.arrival_time || "?"}
                </Text>
              ))}
            </>
          )}
          {payload.reroute_suggestion.alternative_routes?.length > 0 && (
            <>
              <Text style={styles.rerouteSubhead}>Junction-hopping corridors (no single confirmed train):</Text>
              {payload.reroute_suggestion.alternative_routes.map((r, i) => (
                <Text key={i} style={styles.rerouteAltLine}>
                  Via {r.via_names.join(" → ")} — {r.hops} change(s), ~{r.total_distance_km} km
                </Text>
              ))}
            </>
          )}
          {payload.reroute_suggestion.disclaimer && (
            <Text style={styles.rerouteDisclaimer}>{payload.reroute_suggestion.disclaimer}</Text>
          )}
        </SectionCard>
      )}

      {payload && (
        <>
          <SectionCard title="Live position (text)">
            <InfoRow label="Coordinates" value={payload.lat && payload.lng ? `${payload.lat}, ${payload.lng}` : "—"} />
            <InfoRow label="Current station" value={payload.current_station || "—"} />
            <InfoRow label="Next station" value={payload.next_station || "—"} />
            <InfoRow label="Reported delay" value={payload.delay_minutes != null ? formatDelayDuration(payload.delay_minutes) : "—"} />
            <InfoRow
              label="ML predicted delay"
              value={
                payload.predicted_delay_minutes != null
                  ? `${formatDelayDuration(payload.predicted_delay_minutes)} (${payload.predicted_delay_confidence || "n/a"} confidence)`
                  : "—"
              }
            />
            {/* FEATURE: Live delay-trend sparkline — text form (getting
                better/worse right now), fitting this already text-only
                screen rather than adding a chart library here. */}
            {delaySparkline.length >= 2 && (
              <InfoRow
                label={`Delay trend (last ${delaySparkline.length})`}
                value={`${delaySparkline.map((v) => (v > 0 ? `+${v}` : String(v))).join(", ")} ${
                  delaySparkline[delaySparkline.length - 1] < delaySparkline[0] ? "(improving)"
                  : delaySparkline[delaySparkline.length - 1] > delaySparkline[0] ? "(worsening)" : "(steady)"
                }`}
              />
            )}
            {payload.error ? <Text style={styles.errorText}>{payload.error}</Text> : null}
          </SectionCard>

          <SectionCard title="Crowd prediction" subtitle={payload.crowd_disclaimer}>
            <InfoRow label="Level" value={payload.crowd_level || "—"} />
            <InfoRow label="Score" value={payload.crowd_score != null ? String(payload.crowd_score) : "—"} />
            {!!payload.crowd_basis?.length && (
              <View style={styles.basisList}>
                {payload.crowd_basis.map((b, i) => (
                  <Text key={i} style={styles.basisItem}>• {b}</Text>
                ))}
              </View>
            )}
          </SectionCard>

          <SectionCard title="Stop-by-stop timeline" subtitle={`${timeline.length} stops reported`}>
            {timeline.map((stop, idx) => (
              <View key={`${stop.code}_${idx}`} style={styles.timelineRow}>
                <View style={[styles.dot, { backgroundColor: STATUS_COLOR[stop.status] || colors.textMuted }]} />
                <View style={styles.timelineTextWrap}>
                  <Text style={styles.timelineName}>
                    {stop.name} ({stop.code}){" "}
                    <Text style={styles.timelineKind}>{stop.kind === "intermediate" ? "· passing" : ""}</Text>
                  </Text>
                  <Text style={styles.timelineTimes}>
                    Arr {stop.arrival?.scheduled || "—"} · Dep {stop.departure?.scheduled || "—"}
                    {stop.distance_km ? ` · ${stop.distance_km} km` : ""}
                  </Text>
                </View>
              </View>
            ))}
          </SectionCard>
        </>
      )}
    </ScrollView>
  );
}

function ConnectionBadge({ connection }) {
  const map = {
    idle: { color: colors.textMuted, label: "Not connected", icon: "ellipse-outline" },
    connecting: { color: colors.warning, label: "Connecting…", icon: "sync-outline" },
    open: { color: colors.success, label: "Live", icon: "radio-outline" },
    closed: { color: colors.textMuted, label: "Disconnected", icon: "stop-circle-outline" },
    error: { color: colors.danger, label: "Connection error — check backend URL in Settings", icon: "warning-outline" },
  };
  const s = map[connection] || map.idle;
  return (
    <View style={styles.badgeRow}>
      <Ionicons name={s.icon} size={14} color={s.color} />
      <Text style={[styles.badgeText, { color: s.color }]}>{s.label}</Text>
    </View>
  );
}

function InfoRow({ label, value }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  row: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  half: { flex: 1 },
  refreshRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  refreshText: { fontSize: 12, color: colors.primary, fontWeight: "600" },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: spacing.sm },
  badgeText: { fontSize: 12, fontWeight: "600" },
  webNotice: { flexDirection: "row", gap: 6, marginTop: spacing.md, alignItems: "flex-start" },
  webNoticeText: { fontSize: 11, color: colors.textMuted, flex: 1, lineHeight: 16 },
  liteNotice: { fontSize: 10.5, color: colors.textMuted, fontStyle: "italic", marginTop: spacing.sm, lineHeight: 15 },
  tripSummaryLine: { fontSize: 12.5, color: colors.text, lineHeight: 17 },
  infoRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  infoLabel: { fontSize: 13, color: colors.textMuted },
  infoValue: { fontSize: 13, color: colors.text, fontWeight: "600", flexShrink: 1, textAlign: "right" },
  errorText: { fontSize: 12, color: colors.danger, marginTop: spacing.sm },
  basisList: { marginTop: spacing.sm },
  basisItem: { fontSize: 12, color: colors.textMuted, marginBottom: 2 },
  timelineRow: { flexDirection: "row", marginBottom: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 4, marginRight: spacing.sm },
  timelineTextWrap: { flex: 1 },
  timelineName: { fontSize: 13, fontWeight: "600", color: colors.text },
  timelineKind: { fontSize: 11, color: colors.textMuted, fontWeight: "400" },
  timelineTimes: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  // FEATURE: Dynamic Re-route Suggestions During Live Tracking.
  rerouteTitle: { fontSize: 13, fontWeight: "700", color: colors.danger, marginBottom: 4 },
  rerouteNote: { fontSize: 12.5, color: colors.text, lineHeight: 17, marginBottom: 6 },
  rerouteSubhead: { fontSize: 12, fontWeight: "700", color: colors.primary, marginTop: 6, marginBottom: 2 },
  rerouteAltLine: { fontSize: 12, color: colors.text, marginBottom: 2 },
  rerouteDisclaimer: { fontSize: 10.5, color: colors.textMuted, fontStyle: "italic", marginTop: 6 },
});