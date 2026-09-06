import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius } from "../theme/colors";
import FeedbackBar from "./FeedbackBar";
import RouteMapPreview from "./RouteMapPreview";

const EMOTION_ICON = {
  angry: "flame-outline",
  frustrated: "sad-outline",
  happy: "happy-outline",
  neutral: null,
  urgent: "alert-circle-outline",
};

export default function ChatBubble({ message }) {
  const isUser = message.role === "user";

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        {message.imageUri ? (
          <Image source={{ uri: message.imageUri }} style={styles.attachedImage} resizeMode="cover" />
        ) : null}

        <Text style={[styles.text, isUser ? styles.textUser : styles.textAssistant]}>{message.text}</Text>

        {!isUser && message.map && <RouteMapPreview map={message.map} />}

        {!isUser && (message.webSources?.length > 0 || message.deepThinkUsed) && (
          <View style={styles.usedRow}>
            {message.deepThinkUsed && (
              <View style={styles.usedBadge}>
                <Ionicons name="bulb" size={11} color={colors.primary} />
                <Text style={styles.usedBadgeText}>Deep Think</Text>
              </View>
            )}
            {message.webSources?.length > 0 && (
              <View style={styles.usedBadge}>
                <Ionicons name="globe" size={11} color={colors.primary} />
                <Text style={styles.usedBadgeText}>
                  Web: {message.webSources.map((s) => s.title).join(", ")}
                </Text>
              </View>
            )}
          </View>
        )}

        {!isUser && message.sentiment?.emotion && EMOTION_ICON[message.sentiment.emotion] && (
          <View style={styles.sentimentHint}>
            <Ionicons name={EMOTION_ICON[message.sentiment.emotion]} size={12} color={colors.textMuted} />
            <Text style={styles.sentimentText}>detected tone: {message.sentiment.emotion}</Text>
          </View>
        )}

        {!isUser && message.error && (
          <View style={styles.errorRow}>
            <Ionicons name="warning-outline" size={13} color={colors.danger} />
            <Text style={styles.errorText}>{message.error}</Text>
          </View>
        )}

        {!isUser && !message.error && <FeedbackBar responseId={message.responseId} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginVertical: spacing.xs, paddingHorizontal: spacing.lg },
  rowUser: { alignItems: "flex-end" },
  rowAssistant: { alignItems: "flex-start" },
  bubble: {
    maxWidth: "86%",
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  bubbleUser: { backgroundColor: colors.bubbleUser, borderBottomRightRadius: 4 },
  bubbleAssistant: {
    backgroundColor: colors.bubbleAssistant,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  text: { fontSize: 15, lineHeight: 21 },
  textUser: { color: colors.textInverse },
  textAssistant: { color: colors.text },
  attachedImage: { width: 160, height: 120, borderRadius: radius.sm, marginBottom: spacing.xs },
  sentimentHint: { flexDirection: "row", alignItems: "center", marginTop: 4, gap: 4 },
  sentimentText: { fontSize: 11, color: colors.textMuted, fontStyle: "italic" },
  errorRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.xs, gap: 4 },
  errorText: { fontSize: 12, color: colors.danger, flexShrink: 1 },
  usedRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: spacing.xs },
  usedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: colors.chip,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  usedBadgeText: { fontSize: 10.5, color: colors.primary, fontWeight: "600" },
});
