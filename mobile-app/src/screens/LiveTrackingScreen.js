import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import MicButton from "../components/MicButton";
import QueryToolbar from "../components/QueryToolbar";
import TrackedTrainCard from "../components/TrackedTrainCard";
import { useSettings } from "../context/SettingsContext";
import { sendChatMessage } from "../api/railwayApi";
import { describeApiError } from "../api/client";

let trackIdCounter = 0;
function nextTrackId() {
  trackIdCounter += 1;
  return `track_${Date.now()}_${trackIdCounter}`;
}

export default function LiveTrackingScreen() {
  const { wsBaseUrl, apiBaseUrl, language } = useSettings();

  // --- Multi-train tracking: each entry in `tracked` gets its own
  // <TrackedTrainCard>, which owns its own WebSocket connection, animated
  // marker, and station-crossing notifications independently — so you can
  // track train 12709 today AND 20833 on a custom date at the same time,
  // not just one train at a time. ---
  const [tracked, setTracked] = useState([]);
  const [trainNumber, setTrainNumber] = useState("");
  const [trackDate, setTrackDate] = useState(""); // DD-MM-YYYY, optional - blank = today
  const [source, setSource] = useState("");
  const [dest, setDest] = useState("");

  // FEATURE: Track two trains side by side. Each TrackedTrainCard already
  // owns its own websocket, so this doesn't open any extra connections —
  // it just relays each card's latest live payload up here (keyed by the
  // same tracked-list id) so a compact two-column comparison strip can be
  // rendered above the full cards, useful for a connection or deciding
  // between two options before boarding.
  const [payloadsById, setPayloadsById] = useState({});
  const [compareIds, setCompareIds] = useState([]); // up to 2 tracked-list ids
  function toggleCompare(id) {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  }

  function addTrackedTrain() {
    const num = trainNumber.trim();
    if (!num) return;
    setTracked((prev) => [
      ...prev,
      {
        id: nextTrackId(),
        trainNumber: num,
        date: trackDate.trim() || null,
        source: source.trim().toUpperCase() || null,
        dest: dest.trim().toUpperCase() || null,
      },
    ]);
    setTrainNumber("");
    setTrackDate("");
    setSource("");
    setDest("");
  }

  function removeTrackedTrain(id) {
    setTracked((prev) => prev.filter((t) => t.id !== id));
    setPayloadsById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setCompareIds((prev) => prev.filter((x) => x !== id));
  }

  // --- Passenger Q&A: web search + semantic RAG, scoped to whichever
  // train number is typed here (independent of the tracked list above —
  // you can ask about a train before deciding to track it). ---
  const [qaTrainNumber, setQaTrainNumber] = useState("");
  const [question, setQuestion] = useState("");
  const [qa, setQa] = useState(null); // { answer, sources, error }
  const [asking, setAsking] = useState(false);
  const [webSearchOn, setWebSearchOn] = useState(true);
  const [deepThinkOn, setDeepThinkOn] = useState(false);

  async function askQuestion(text) {
    const trimmed = (text ?? question).trim();
    if (!trimmed || !qaTrainNumber.trim()) return;
    setAsking(true);
    setQa(null);
    try {
      const data = await sendChatMessage(apiBaseUrl, {
        message: trimmed,
        trainNumber: qaTrainNumber.trim(),
        language,
        webSearch: webSearchOn,
        deepThink: deepThinkOn,
      });
      setQa({ answer: data.answer, sources: data.web_sources || [], deepThinkUsed: data.deep_think_used });
    } catch (e) {
      setQa({ error: describeApiError(e) });
    } finally {
      setAsking(false);
      setQuestion("");
    }
  }

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <SectionCard
        title="Track a train"
        subtitle="Add one or more trains — each streams its own position + delay + crowd update every ~5s (tap the refresh icon on a card for an instant update), on today's date or a date you pick."
      >
        <LabeledInput
          label="Train number"
          placeholder="e.g. 12709"
          value={trainNumber}
          onChangeText={setTrainNumber}
          keyboardType="number-pad"
        />
        <LabeledInput
          label="Date (optional — defaults to today)"
          placeholder="DD-MM-YYYY, e.g. 20-08-2026"
          value={trackDate}
          onChangeText={setTrackDate}
        />
        <View style={styles.row}>
          <LabeledInput
            label="Source (optional)"
            placeholder="e.g. SC"
            value={source}
            onChangeText={setSource}
            style={styles.half}
          />
          <LabeledInput
            label="Dest (optional)"
            placeholder="e.g. BZA"
            value={dest}
            onChangeText={setDest}
            style={styles.half}
          />
        </View>
        <PrimaryButton title="+ Track this train" onPress={addTrackedTrain} disabled={!trainNumber.trim()} />
      </SectionCard>

      <SectionCard
        title="Ask about a train"
        subtitle="Answered from railway knowledge + a live web search — type or tap the mic."
      >
        <LabeledInput
          label="Train number"
          placeholder="e.g. 12709"
          value={qaTrainNumber}
          onChangeText={setQaTrainNumber}
          keyboardType="number-pad"
        />
        <QueryToolbar
          webSearch={webSearchOn}
          onToggleWebSearch={setWebSearchOn}
          deepThink={deepThinkOn}
          onToggleDeepThink={setDeepThinkOn}
        />
        <View style={styles.qaInputRow}>
          <TextInput
            style={styles.qaInput}
            placeholder={
              qaTrainNumber.trim() ? "e.g. why might it be delayed today?" : "Enter a train number above first"
            }
            placeholderTextColor={colors.textMuted}
            value={question}
            onChangeText={setQuestion}
            editable={!!qaTrainNumber.trim()}
            multiline
            onSubmitEditing={() => askQuestion()}
          />
          <MicButton onResult={(text) => askQuestion(text)} style={styles.qaMic} />
          <TouchableOpacity
            style={[styles.qaSendBtn, (!question.trim() || !qaTrainNumber.trim()) && styles.qaSendBtnDisabled]}
            onPress={() => askQuestion()}
            disabled={asking || !question.trim() || !qaTrainNumber.trim()}
          >
            <Ionicons name="send" size={16} color={colors.textInverse} />
          </TouchableOpacity>
        </View>

        {asking && (
          <View style={styles.qaThinkingRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.qaThinkingText}>
              {deepThinkOn ? "Thinking it through carefully\u2026" : "Checking live data, knowledge base, and the web\u2026"}
            </Text>
          </View>
        )}

        {qa?.error && <Text style={styles.errorText}>{qa.error}</Text>}

        {qa?.answer && (
          <View style={styles.qaAnswerBox}>
            <Text style={styles.qaAnswerText}>{qa.answer}</Text>
            {!!qa.sources?.length && (
              <View style={styles.basisList}>
                {qa.sources.map((s, i) => (
                  <Text key={i} style={styles.basisItem}>
                    {"\u2022 "}{s.title}
                  </Text>
                ))}
              </View>
            )}
          </View>
        )}
      </SectionCard>

      {/* FEATURE: Track two trains side by side — pick any two currently-
          tracked trains for a compact comparison strip, useful for a
          connection or deciding between two options before boarding. */}
      {tracked.length >= 2 && (
        <SectionCard title="Compare trains" subtitle="Pick two tracked trains to compare side by side.">
          <View style={styles.compareChipRow}>
            {tracked.map((t) => (
              <TouchableOpacity
                key={t.id}
                style={[styles.compareChip, compareIds.includes(t.id) && styles.compareChipActive]}
                onPress={() => toggleCompare(t.id)}
              >
                <Text style={[styles.compareChipText, compareIds.includes(t.id) && styles.compareChipTextActive]}>
                  {t.trainNumber}{t.date ? ` (${t.date})` : ""}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {compareIds.length === 2 && (
            <View style={styles.compareCols}>
              {compareIds.map((id) => {
                const t = tracked.find((x) => x.id === id);
                const p = payloadsById[id];
                return (
                  <View key={id} style={styles.compareCol}>
                    <Text style={styles.compareColTitle}>Train {t?.trainNumber}</Text>
                    {!p ? (
                      <Text style={styles.compareRowValue}>Waiting for live data…</Text>
                    ) : (
                      <>
                        <CompareRow label="Current" value={p.current_station || "—"} />
                        <CompareRow label="Next" value={p.next_station || "—"} />
                        <CompareRow label="Next ETA" value={p.next_station_live_eta || p.next_station_expected_arrival || "—"} />
                        <CompareRow
                          label="Delay"
                          value={p.delay_minutes != null ? `${p.delay_minutes > 0 ? "+" : ""}${p.delay_minutes}m` : "—"}
                          danger={p.delay_minutes > 0}
                        />
                        <CompareRow
                          label="Speed"
                          value={(p.recency_weighted_speed_kmph ?? p.instant_speed_kmph) != null ? `${p.recency_weighted_speed_kmph ?? p.instant_speed_kmph} km/h` : "—"}
                        />
                      </>
                    )}
                  </View>
                );
              })}
            </View>
          )}
          {compareIds.length < 2 && (
            <Text style={styles.compareHint}>Select two trains above to compare.</Text>
          )}
        </SectionCard>
      )}

      {tracked.map((t) => (
        <TrackedTrainCard
          key={t.id}
          trainNumber={t.trainNumber}
          date={t.date}
          source={t.source}
          dest={t.dest}
          wsBaseUrl={wsBaseUrl}
          apiBaseUrl={apiBaseUrl}
          onRemove={() => removeTrackedTrain(t.id)}
          onPayloadUpdate={(data) => setPayloadsById((prev) => ({ ...prev, [t.id]: data }))}
        />
      ))}
    </ScrollView>
  );
}

function CompareRow({ label, value, danger }) {
  return (
    <View style={styles.compareRow}>
      <Text style={styles.compareRowLabel}>{label}</Text>
      <Text style={[styles.compareRowValue, danger && { color: colors.danger }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  row: { flexDirection: "row", gap: spacing.md },
  half: { flex: 1 },
  errorText: { fontSize: 12, color: colors.danger, marginTop: spacing.sm },
  basisList: { marginTop: spacing.sm },
  basisItem: { fontSize: 12, color: colors.textMuted, marginBottom: 2 },
  qaInputRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  qaInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxHeight: 90,
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  qaMic: { marginBottom: 2 },
  qaSendBtn: {
    backgroundColor: colors.primary,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  qaSendBtnDisabled: { opacity: 0.4 },
  qaThinkingRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: spacing.sm },
  qaThinkingText: { fontSize: 12, color: colors.textMuted },
  qaAnswerBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.chip,
    borderRadius: radius.md,
  },
  qaAnswerText: { fontSize: 14, color: colors.text, lineHeight: 20 },

  // FEATURE: Track two trains side by side.
  compareChipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  compareChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card || colors.bg,
  },
  compareChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  compareChipText: { fontSize: 12.5, fontWeight: "600", color: colors.primary },
  compareChipTextActive: { color: colors.textInverse },
  compareHint: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm },
  compareCols: { flexDirection: "row", gap: spacing.md, marginTop: spacing.md },
  compareCol: { flex: 1, padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  compareColTitle: { fontSize: 13, fontWeight: "700", color: colors.primary, marginBottom: spacing.xs },
  compareRow: { marginBottom: 6 },
  compareRowLabel: { fontSize: 10.5, color: colors.textMuted },
  compareRowValue: { fontSize: 12.5, fontWeight: "600", color: colors.text },
});
