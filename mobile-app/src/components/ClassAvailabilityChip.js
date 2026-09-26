import React, { useState } from "react";
import { TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { Text } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import { checkSeatAvailability } from "../api/railwayApi";

function rankColor(statusText) {
  if (!statusText) return colors.textMuted;
  if (/\bAVAILABLE\b/i.test(statusText)) return colors.success;
  if (/\bRAC\b/i.test(statusText)) return colors.warning;
  if (/\bWL\b|WAITLIST|REGRET/i.test(statusText)) return colors.danger;
  return colors.text;
}

/**
 * One IRCTC-style class box ("SL", "3A", "3E"…) with a tap-to-refresh live
 * check — matches the reference screenshot's per-class boxes ("Refresh ↻"
 * that turns into a real status like "AVAILABLE-45" once tapped). Reuses
 * the exact same /api/train/seat-availability single-lookup endpoint the
 * Seat Availability home-tile already calls (checkSeatAvailability in
 * railwayApi.js) — this is a real per-class-per-train live check, not a
 * static badge, so it only fires on tap (never automatically for every
 * class on every train, which would be a lot of unasked-for RapidAPI
 * calls) and needs a real date to check against.
 *
 * `initialStatusText` is optional: when the search results already ran a
 * live check for THIS exact class (the backend does this once per train
 * for whichever single class the search form's Class filter was set to —
 * see api_trains_search's availability_cache in app.py), that real result
 * is handed in here so the box shows it immediately instead of every card
 * needing its own extra tap for the one class the user actually searched.
 */
export default function ClassAvailabilityChip({ classCode, trainNumber, source, dest, date, quota, apiBaseUrl, onNeedDate, initialStatusText }) {
  const [status, setStatus] = useState(initialStatusText ? "done" : "idle"); // idle | loading | done | error
  const [text, setText] = useState(initialStatusText || null);

  async function refresh() {
    if (!date) {
      onNeedDate?.();
      return;
    }
    setStatus("loading");
    try {
      const data = await checkSeatAvailability(apiBaseUrl, {
        trainNumber, source, dest, date, travelClass: classCode, quota,
      });
      if (data.error) {
        setText(data.error);
        setStatus("error");
      } else {
        setText(data.status_text || "no status returned");
        setStatus("done");
      }
    } catch (e) {
      setText("couldn't reach the backend");
      setStatus("error");
    }
  }

  return (
    <TouchableOpacity style={styles.chip} onPress={refresh} disabled={status === "loading"}>
      <Text style={styles.classCode}>{classCode}</Text>
      {status === "loading" ? (
        <ActivityIndicator size="small" color={colors.orange} style={styles.spinner} />
      ) : status === "idle" ? (
        <Text style={styles.refreshText}>
          Refresh <Ionicons name="refresh" size={11} color={colors.orange} />
        </Text>
      ) : (
        <Text numberOfLines={2} style={[styles.statusText, { color: rankColor(status === "error" ? null : text) }]}>
          {status === "error" ? "unavailable" : text}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 6,
    paddingHorizontal: 8,
    alignItems: "center",
    minWidth: 74,
    maxWidth: 96,
    backgroundColor: colors.bg,
  },
  classCode: { fontSize: 12, fontWeight: "700", color: colors.text, marginBottom: 3 },
  refreshText: { fontSize: 10, color: colors.orange, fontWeight: "600" },
  statusText: { fontSize: 9, fontWeight: "700", textAlign: "center" },
  spinner: { marginTop: 2 },
});
