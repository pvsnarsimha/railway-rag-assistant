import React, { useState } from "react";
import { View, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { Text, useSpeakScope } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/colors";
import { useT } from "../context/LanguageContext";
import LanguagePickerModal from "./LanguagePickerModal";
import { languageInfo } from "../utils/notifyLanguage";
import { isSpeechSupported, speak, stopSpeaking } from "../utils/speakNotifications";

/**
 * FEATURE: language + "speak this screen" strip, shown at the top of every
 * screen (Home and its tools, Railway Assistant, Live Tracking, More Tools,
 * Settings).
 *   - 🌐 language chip (default English): changes the screen text,
 *     station names, notifications and read-aloud to that language.
 *   - 🔊 Speak: reads the screen ONLY when tapped, in that language.
 * `getSpeech()` returns the English sentences to read (or already-localized
 * text with `alreadyLocalized`); they're translated, then spoken. Without
 * `getSpeech`, everything currently shown on the screen is read — it is
 * already in the chosen language (see SpeakScope in i18n/Localized.js).
 */
export default function ScreenLanguageBar({ getSpeech, alreadyLocalized = false, style }) {
  const { lang, setLang, t, translateNow, translating } = useT();
  const scope = useSpeakScope();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const info = languageInfo(lang);

  async function onSpeak() {
    if (speaking) { stopSpeaking(); setSpeaking(false); return; }
    const fromScreen = typeof getSpeech !== "function";
    const raw = (fromScreen ? (scope ? scope.texts() : []) : getSpeech()) || "";
    const parts = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x || "").trim()).filter(Boolean);
    if (!parts.length) return;
    setBusy(true);
    try {
      const english = parts.join(". ");
      const localized = fromScreen || alreadyLocalized || lang === "en" ? parts : await translateNow(parts, lang);
      speak(localized.join(". "), { lang, fallbackText: english, force: true });
      setSpeaking(true);
      // No reliable "done" event across web + native: reset the button after
      // a rough reading time so it doesn't stay stuck on "Stop".
      setTimeout(() => setSpeaking(false), Math.min(120000, 4000 + english.length * 90));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.bar, style]}>
      <TouchableOpacity style={styles.chip} onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="Change language">
        <Ionicons name="language-outline" size={16} color={colors.primary} />
        <Text noTranslate noSpeak style={styles.chipText} numberOfLines={1}>{info.native}</Text>
        <Ionicons name="chevron-down" size={14} color={colors.primary} />
      </TouchableOpacity>
      {translating ? (
        <View style={styles.translating}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text noSpeak style={styles.translatingText}>{t("Translating…")}</Text>
        </View>
      ) : null}
      {isSpeechSupported() && (getSpeech || scope) ? (
        <TouchableOpacity style={[styles.chip, styles.speakBtn]} onPress={onSpeak} accessibilityRole="button" accessibilityLabel="Speak this screen">
          {busy ? <ActivityIndicator size="small" color="#fff" /> : (
            <Ionicons name={speaking ? "stop-circle-outline" : "volume-high-outline"} size={16} color="#fff" />
          )}
          <Text noSpeak style={[styles.chipText, { color: "#fff" }]}>{speaking ? t("Stop") : t("Speak screen")}</Text>
        </TouchableOpacity>
      ) : null}
      <LanguagePickerModal
        visible={open}
        selected={lang}
        onSelect={(code) => { setOpen(false); setLang(code); }}
        onClose={() => setOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, marginBottom: 10 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 18, backgroundColor: colors.chip, borderWidth: 1, borderColor: colors.border, maxWidth: 190,
  },
  translating: { flexDirection: "row", alignItems: "center", gap: 4, marginRight: "auto" },
  translatingText: { fontSize: 12, color: colors.textMuted },
  speakBtn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: "700", color: colors.primary },
});
