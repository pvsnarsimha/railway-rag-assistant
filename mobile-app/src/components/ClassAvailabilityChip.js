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

// Tinted box per status family (AVL green · RAC blue · WL amber · idle
// neutral) — purely presentational, reads the same status text rankColor()
// already classifies, so no new status logic is introduced.
const TONES = {
  avl: { bg: "#EAF7EE", border: "#9AD3AC", fg: "#16753A" },
  rac: { bg: "#EAF1FD", border: "#A9C3F0", fg: "#1F4FA8" },
  wl: { bg: "#FFF7E0", border: "#F1D27A", fg: "#9A6A00" },
  err: { bg: "#FDEEEE", border: "#F2B8B5", fg: colors.danger },
  idle: { bg: colors.card, border: colors.border, fg: colors.text },
};

function toneFor(status, text) {
  if (status === "error") return TONES.err;
  if (status !== "done" || !text) return TONES.idle;
  if (/\bAVAILABLE\b|\bAVL\b/i.test(text)) return TONES.avl;
  if (/\bRAC\b/i.test(text)) return TONES.rac;
  if (/\bWL\b|WAITLIST|REGRET/i.test(text)) return TONES.wl;
  return TONES.idle;
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
export default function ClassAvailabilityChip({ classCode, trainNumber, source, dest, date, quota, apiBaseUrl, onNeedDate, initialStatusText, fare }) {
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

  const tone = toneFor(status, text);

  return (
    <TouchableOpacity
      style={[styles.chip, { backgroundColor: tone.bg, borderColor: tone.border }]}
      onPress={refresh}
      disabled={status === "loading"}
      activeOpacity={0.75}
    >
      <Text style={[styles.classCode, { color: tone.fg }]}>
        {classCode}
        {fare != null ? <Text style={[styles.fareText, { color: tone.fg }]}>{`  ₹${fare}`}</Text> : null}
      </Text>
      {status === "loading" ? (
        <ActivityIndicator size="small" color={colors.orange} style={styles.spinner} />
      ) : status === "idle" ? (
        <Text style={styles.refreshText}>
          Refresh <Ionicons name="refresh" size={11} color={colors.orange} />
        </Text>
      ) : (
        <Text
          numberOfLines={2}
          style={[styles.statusText, { color: tone === TONES.idle ? rankColor(status === "error" ? null : text) : tone.fg }]}
        >
          {status === "error" ? "unavailable" : text}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 10,
    alignItems: "flex-start",
    minWidth: 92,
    maxWidth: 124,
    marginRight: spacing.sm,
  },
  classCode: { fontSize: 13, fontWeight: "800", marginBottom: 3 },
  fareText: { fontSize: 12, fontWeight: "700" },
  refreshText: { fontSize: 11, color: colors.orange, fontWeight: "700" },
  statusText: { fontSize: 11, fontWeight: "800" },
  spinner: { marginTop: 2, alignSelf: "center" },
});
