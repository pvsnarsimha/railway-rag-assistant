import React, { useContext, useState } from "react";
import { View, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { Text } from "../i18n/AutoText";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/colors";
import { useT, SpeakScopeContext, getScreenTexts } from "../context/LanguageContext";
import LanguagePickerModal from "./LanguagePickerModal";
import { languageInfo } from "../utils/notifyLanguage";
import { isSpeechSupported, speak, stopSpeaking } from "../utils/speakNotifications";

const MAX_SPEECH_CHARS = 3500;

/**
 * FEATURE: language + "speak this screen" strip — at the top of Home,
 * Railway Assistant, Live Tracking and More Tools, and (compact, icons only)
 * in the header of every other screen.
 *   - 🌐 language chip (default English): changes the screen text,
 *     station names, notifications and read-aloud to that language.
 *   - 🔊 Speak: reads the screen ONLY when tapped, in that language.
 * `getSpeech()` returns the English sentences to read (or already-localized
 * text with `alreadyLocalized`). Without it, whatever the screen currently
 * shows is read (every <Text> registers itself — see i18n/AutoText).
 * `scopeId` picks the screen when the bar sits outside it (a header).
 */
export default function ScreenLanguageBar({ getSpeech, alreadyLocalized = false, style, compact = false, scopeId }) {
  const { lang, setLang, t, translateNow, translating } = useT();
  const ctxScope = useContext(SpeakScopeContext);
  const scope = scopeId || ctxScope;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const info = languageInfo(lang);

  function collect() {
    if (typeof getSpeech === "function") {
      const raw = getSpeech() || "";
      return (Array.isArray(raw) ? raw : [raw]).map((x) => ({ text: String(x || "").trim(), raw: alreadyLocalized })).filter((p) => p.text);
    }
    const out = [];
    let len = 0;
    for (const p of getScreenTexts(scope)) {
      if (len + p.text.length > MAX_SPEECH_CHARS) break;
      out.push(p);
      len += p.text.length;
    }
    return out;
  }

  async function onSpeak() {
    if (speaking) { stopSpeaking(); setSpeaking(false); return; }
    const parts = collect();
    if (!parts.length) return;
    setBusy(true);
    try {
      const english = parts.map((p) => p.text);
      let localized = english;
      if (lang !== "en") {
        const todo = parts.filter((p) => !p.raw).map((p) => p.text);
        const done = todo.length ? await translateNow(todo, lang) : [];
        let i = 0;
        localized = parts.map((p) => (p.raw ? p.text : done[i++]));
      }
      const sentence = (arr) => arr.map((s) => s.replace(/[.。।:;,\s]+$/u, "")).join(". ");
      speak(sentence(localized), { lang, fallbackText: sentence(english), force: true });
      setSpeaking(true);
      // No reliable "done" event across web + native: reset the button after
      // a rough reading time so it doesn't stay stuck on "Stop".
      const chars = english.join(" ").length;
      setTimeout(() => setSpeaking(false), Math.min(180000, 4000 + chars * 90));
    } finally {
      setBusy(false);
    }
  }

  const canSpeak = isSpeechSupported() && (getSpeech || scope);
  const onDark = compact;
  const fg = onDark ? colors.textInverse : colors.primary;

  return (
    <View style={[styles.bar, compact && styles.barCompact, style]}>
      {translating && !compact ? (
        <View style={styles.translating}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.translatingText} noSpeak>{t("Translating…")}</Text>
        </View>
      ) : null}
      <TouchableOpacity
        style={[styles.chip, compact && styles.chipCompact]}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Change language"
      >
        {translating && compact ? <ActivityIndicator size="small" color={fg} /> : <Ionicons name="language-outline" size={16} color={fg} />}
        {compact ? null : <Text style={styles.chipText} numberOfLines={1} noTranslate noSpeak>{info.native}</Text>}
        {compact ? null : <Ionicons name="chevron-down" size={14} color={fg} />}
      </TouchableOpacity>
      {canSpeak ? (
        <TouchableOpacity
          style={[styles.chip, compact ? styles.chipCompact : styles.speakBtn]}
          onPress={onSpeak}
          accessibilityRole="button"
          accessibilityLabel="Speak this screen"
        >
          {busy ? <ActivityIndicator size="small" color="#fff" /> : (
            <Ionicons name={speaking ? "stop-circle-outline" : "volume-high-outline"} size={compact ? 18 : 16} color="#fff" />
          )}
          {compact ? null : <Text style={[styles.chipText, { color: "#fff" }]} noSpeak>{speaking ? t("Stop") : t("Speak screen")}</Text>}
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
  barCompact: { marginBottom: 0, gap: 4 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 18, backgroundColor: colors.chip, borderWidth: 1, borderColor: colors.border, maxWidth: 190,
  },
  chipCompact: { backgroundColor: "transparent", borderColor: "transparent", paddingHorizontal: 8, paddingVertical: 6 },
  speakBtn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: "700", color: colors.primary },
  translating: { flexDirection: "row", alignItems: "center", gap: 4, marginRight: "auto" },
  translatingText: { fontSize: 12, color: colors.textMuted },
});
