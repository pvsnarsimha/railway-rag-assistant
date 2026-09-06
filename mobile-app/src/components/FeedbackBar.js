import React, { useState } from "react";
import { View, Text, TouchableOpacity, TextInput, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import { describeApiError } from "../api/client";
import { sendFeedback } from "../api/railwayApi";
import { useSettings } from "../context/SettingsContext";

/**
 * Renders under an assistant chat bubble that has a response_id. Tapping
 * thumbs-up fires the rating immediately. Tapping thumbs-down opens a small
 * "what should it have said?" box — matching FeedbackRequest.correction on
 * the backend — before submitting, since a bare "down" with no correction
 * is a weaker RLHF signal than one with a concrete replacement answer.
 * Once a rating is sent for this response_id, the bar shows a confirmation
 * instead of the buttons so the same reply can't be rated twice.
 */
export default function FeedbackBar({ responseId }) {
  const { apiBaseUrl } = useSettings();
  const [status, setStatus] = useState("idle"); // idle | submitting | done | error
  const [ratingGiven, setRatingGiven] = useState(null); // "up" | "down"
  const [showCorrectionBox, setShowCorrectionBox] = useState(false);
  const [correction, setCorrection] = useState("");
  const [errorMsg, setErrorMsg] = useState(null);

  if (!responseId) return null;

  async function submit(rating, correctionText) {
    setStatus("submitting");
    setErrorMsg(null);
    try {
      await sendFeedback(apiBaseUrl, { responseId, rating, correction: correctionText });
      setRatingGiven(rating);
      setStatus("done");
      setShowCorrectionBox(false);
    } catch (e) {
      setStatus("error");
      setErrorMsg(describeApiError(e));
    }
  }

  if (status === "done") {
    return (
      <View style={styles.row}>
        <Ionicons
          name={ratingGiven === "up" ? "checkmark-circle" : "checkmark-circle-outline"}
          size={14}
          color={colors.success}
        />
        <Text style={styles.thanksText}>
          {ratingGiven === "up" ? "Thanks — glad that helped." : "Thanks — feedback recorded for retraining."}
        </Text>
      </View>
    );
  }

  return (
    <View>
      <View style={styles.row}>
        <Text style={styles.helpfulText}>Was this helpful?</Text>
        <TouchableOpacity
          style={styles.iconBtn}
          disabled={status === "submitting"}
          onPress={() => submit("up")}
        >
          <Ionicons name="thumbs-up-outline" size={16} color={colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.iconBtn}
          disabled={status === "submitting"}
          onPress={() => setShowCorrectionBox((v) => !v)}
        >
          <Ionicons name="thumbs-down-outline" size={16} color={colors.danger} />
        </TouchableOpacity>
      </View>

      {showCorrectionBox && (
        <View style={styles.correctionWrap}>
          <TextInput
            style={styles.correctionInput}
            placeholder="Optional — what should it have said?"
            placeholderTextColor={colors.textMuted}
            value={correction}
            onChangeText={setCorrection}
            multiline
          />
          <TouchableOpacity
            style={styles.submitBtn}
            disabled={status === "submitting"}
            onPress={() => submit("down", correction.trim() || undefined)}
          >
            <Text style={styles.submitBtnText}>Submit</Text>
          </TouchableOpacity>
        </View>
      )}

      {status === "error" && <Text style={styles.errorText}>{errorMsg}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginTop: spacing.xs, gap: spacing.xs },
  helpfulText: { fontSize: 11, color: colors.textMuted, marginRight: spacing.xs },
  thanksText: { fontSize: 11, color: colors.textMuted, marginLeft: 4 },
  iconBtn: { padding: 4 },
  correctionWrap: { marginTop: spacing.xs },
  correctionInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
    fontSize: 13,
    color: colors.text,
    minHeight: 40,
    backgroundColor: colors.bg,
  },
  submitBtn: {
    alignSelf: "flex-end",
    marginTop: spacing.xs,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
  },
  submitBtnText: { color: colors.textInverse, fontSize: 12, fontWeight: "700" },
  errorText: { fontSize: 11, color: colors.danger, marginTop: 4 },
});
