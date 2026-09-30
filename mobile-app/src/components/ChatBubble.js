import React, { useState } from "react";
import { View, Image, TouchableOpacity, StyleSheet } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Text } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing } from "../theme/colors";
import FeedbackBar from "./FeedbackBar";
import RouteMapPreview from "./RouteMapPreview";

const EMOTION_ICON = {
  angry: "flame-outline",
  frustrated: "sad-outline",
  happy: "happy-outline",
  neutral: null,
  urgent: "alert-circle-outline",
};

/** Round "AI" avatar shown beside every assistant message (and the typing dots). */
export function AssistantAvatar({ size = 28 }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Ionicons name="sparkles" size={size * 0.55} color={colors.textInverse} />
    </View>
  );
}

/**
 * Assistant replies come back as plain sentences with simple "- " bullets
 * (see the backend prompt), so a tiny line-based renderer is enough: bullets
 * get a hanging indent, "**bold**" markers are dropped. Each line stays ONE
 * <Text> so on-screen translation still sees whole sentences.
 */
function ReplyText({ text }) {
  const lines = String(text || "").replace(/\*\*/g, "").split("\n");
  return (
    <View>
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return <View key={i} style={styles.gap} />;
        const bullet = line.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)$/);
        if (bullet) {
          return (
            <View key={i} style={styles.bulletRow}>
              <Text noSpeak style={styles.bulletDot}>•</Text>
              <Text style={[styles.replyText, styles.bulletText]}>{bullet[1]}</Text>
            </View>
          );
        }
        return <Text key={i} style={styles.replyText}>{line}</Text>;
      })}
    </View>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await Clipboard.setStringAsync(String(text || ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable - nothing to do */ }
  }
  return (
    <TouchableOpacity onPress={copy} style={styles.actionBtn} accessibilityLabel="Copy reply" hitSlop={8}>
      <Ionicons name={copied ? "checkmark" : "copy-outline"} size={16} color={copied ? colors.success : colors.textMuted} />
    </TouchableOpacity>
  );
}

export default function ChatBubble({ message }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          {message.imageUri ? (
            <Image source={{ uri: message.imageUri }} style={styles.attachedImage} resizeMode="cover" />
          ) : null}
          {/* The user's own words stay exactly as typed. */}
          <Text noTranslate style={styles.userText}>{message.text}</Text>
        </View>
      </View>
    );
  }

  const usedAgent = message.agent?.used;
  const hasSources = message.webSources?.length > 0;

  return (
    <View style={styles.aiRow}>
      <AssistantAvatar />
      <View style={styles.aiBody}>
        <ReplyText text={message.text} />

        {message.map && <RouteMapPreview map={message.map} />}

        {(hasSources || message.deepThinkUsed || usedAgent) && (
          <View style={styles.usedRow}>
            {message.deepThinkUsed && (
              <View style={styles.usedBadge}>
                <Ionicons name="bulb-outline" size={12} color={colors.textMuted} />
                <Text style={styles.usedBadgeText}>Deep Think</Text>
              </View>
            )}
            {usedAgent && (
              <View style={styles.usedBadge}>
                <Ionicons name="construct-outline" size={12} color={colors.textMuted} />
                <Text noSpeak style={styles.usedBadgeText}>
                  {message.agent.steps?.length
                    ? `Checked: ${[...new Set(message.agent.steps.map((s) => s.tool.replace(/_/g, " ")))].join(", ")}`
                    : "AI agent"}
                </Text>
              </View>
            )}
            {hasSources && (
              <View style={styles.usedBadge}>
                <Ionicons name="globe-outline" size={12} color={colors.textMuted} />
                <Text noSpeak style={styles.usedBadgeText}>
                  {message.webSources.map((s) => s.title).join(", ")}
                </Text>
              </View>
            )}
          </View>
        )}

        {message.sentiment?.emotion && EMOTION_ICON[message.sentiment.emotion] && (
          <View style={styles.sentimentHint}>
            <Ionicons name={EMOTION_ICON[message.sentiment.emotion]} size={12} color={colors.textMuted} />
            <Text style={styles.sentimentText}>{"detected tone: " + message.sentiment.emotion}</Text>
          </View>
        )}

        {message.error && (
          <View style={styles.errorRow}>
            <Ionicons name="warning-outline" size={13} color={colors.danger} />
            <Text style={styles.errorText}>{message.error}</Text>
          </View>
        )}

        {message.id !== "greeting" && !message.error && (
          <FeedbackBar responseId={message.responseId} leading={<CopyButton text={message.text} />} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // ----- user: soft rounded pill on the right -----
  userRow: { alignItems: "flex-end", paddingHorizontal: spacing.lg, marginVertical: spacing.sm },
  userBubble: {
    maxWidth: "82%",
    backgroundColor: colors.userBubble,
    borderRadius: 22,
    borderBottomRightRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  userText: { fontSize: 16, lineHeight: 23, color: colors.text },
  attachedImage: { width: 180, height: 130, borderRadius: 12, marginBottom: 8 },

  // ----- assistant: avatar + flowing text, no bubble -----
  aiRow: { flexDirection: "row", paddingHorizontal: spacing.lg, marginVertical: spacing.sm, gap: 10 },
  aiBody: { flex: 1, paddingTop: 2 },
  avatar: { backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", marginTop: 2 },
  replyText: { fontSize: 16, lineHeight: 24, color: colors.text },
  gap: { height: 8 },
  bulletRow: { flexDirection: "row", paddingLeft: 2, marginVertical: 1 },
  bulletDot: { width: 16, fontSize: 16, lineHeight: 24, color: colors.textMuted },
  bulletText: { flex: 1 },

  usedRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: spacing.sm },
  usedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    maxWidth: "100%",
  },
  usedBadgeText: { fontSize: 11, color: colors.textMuted, flexShrink: 1 },
  sentimentHint: { flexDirection: "row", alignItems: "center", marginTop: 6, gap: 4 },
  sentimentText: { fontSize: 11, color: colors.textMuted, fontStyle: "italic" },
  errorRow: { flexDirection: "row", alignItems: "center", marginTop: spacing.xs, gap: 4 },
  errorText: { fontSize: 12, color: colors.danger, flexShrink: 1 },
  actionBtn: { padding: 4 },
});
