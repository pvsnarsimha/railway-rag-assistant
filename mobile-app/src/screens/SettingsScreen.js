import React, { useEffect, useState } from "react";
import { View, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { Text } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { checkHealth } from "../api/railwayApi";
import { describeApiError } from "../api/client";
import LanguagePickerModal from "../components/LanguagePickerModal";
import { getLanguage, languageInfo, loadLanguage } from "../utils/notifyLanguage";
import { useT } from "../context/LanguageContext";

export default function SettingsScreen() {
  const { apiBaseUrl, setApiBaseUrl, wsBaseUrl } = useSettings();
  const [draftUrl, setDraftUrl] = useState(apiBaseUrl);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, detail }
  // FEATURE: notification language (English + 22 Indian languages).
  const { lang: screenLang, setLang: setScreenLang } = useT();
  const [lang, setLang] = useState(getLanguage());
  useEffect(() => { setLang(screenLang); }, [screenLang]);
  const [langOpen, setLangOpen] = useState(false);
  useEffect(() => { loadLanguage().then((c) => { if (c) setLang(c); }); }, []);

  async function handleSave() {
    await setApiBaseUrl(draftUrl);
    setTestResult(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await checkHealth(draftUrl.trim().replace(/\/+$/, ""));
      setTestResult({
        ok: true,
        detail: `Reachable. Semantic engine: ${data.semantic_engine || "n/a"} · KB entries: ${
          data.kb_entries ?? "n/a"
        }`,
      });
    } catch (e) {
      setTestResult({ ok: false, detail: describeApiError(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <SectionCard title="Backend server" subtitle="Points this app at your FastAPI railway assistant server.">
        <LabeledInput
          label="Base URL"
          placeholder="http://192.168.1.23:8000"
          value={draftUrl}
          onChangeText={setDraftUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <View style={styles.buttonRow}>
          <PrimaryButton title="Test connection" variant="secondary" onPress={handleTest} loading={testing} style={styles.flexBtn} />
          <PrimaryButton title="Save" onPress={handleSave} style={styles.flexBtn} />
        </View>

        {testResult && (
          <View style={styles.testRow}>
            <Ionicons
              name={testResult.ok ? "checkmark-circle" : "close-circle"}
              size={16}
              color={testResult.ok ? colors.success : colors.danger}
            />
            <Text style={[styles.testText, { color: testResult.ok ? colors.success : colors.danger }]}>
              {testResult.detail}
            </Text>
          </View>
        )}

        <View style={styles.currentBox}>
          <Text style={styles.currentLabel}>Currently active</Text>
          <Text style={styles.currentValue}>{apiBaseUrl}</Text>
          <Text style={styles.currentValue}>{wsBaseUrl} (WebSocket, for Live Tracking)</Text>
        </View>
      </SectionCard>

      <SectionCard title="App language" subtitle="Screens, station names, notifications and read-aloud use this language.">
        <TouchableOpacity
          onPress={() => setLangOpen(true)}
          accessibilityRole="button"
          style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8 }}
        >
          <Ionicons name="language-outline" size={20} color={colors.primary} />
          <Text style={{ flex: 1, marginLeft: 8, fontSize: 16, color: colors.text }}>
            {languageInfo(lang).native}
            {languageInfo(lang).native !== languageInfo(lang).name ? `  (${languageInfo(lang).name})` : ""}
          </Text>
          <Text style={{ color: colors.primary, fontWeight: "700" }}>Change</Text>
        </TouchableOpacity>
        <LanguagePickerModal
          visible={langOpen}
          selected={lang}
          onSelect={(code) => { setLangOpen(false); setLang(code); setScreenLang(code); }}
          onClose={() => setLangOpen(false)}
        />
      </SectionCard>

      <SectionCard title="Connecting from different devices">
        <Tip text="iOS Simulator: use http://localhost:8000 — it shares your Mac's network." />
        <Tip text="Android Emulator: use http://10.0.2.2:8000 — localhost inside the emulator refers to the emulator itself." />
        <Tip text="Physical phone via Expo Go: use your computer's LAN IP, e.g. http://192.168.1.23:8000, and make sure the phone is on the same Wi-Fi as the server." />
        <Tip text="Run the backend with: uvicorn app:app --host 0.0.0.0 --port 8000  (the --host 0.0.0.0 part is required for LAN/emulator access)." />
      </SectionCard>

      <SectionCard title="About">
        <Text style={styles.aboutText}>
          Companion mobile app for the Indian Railways RAG Assistant. Chat answers, live GPS
          tracking, delay/crowd predictions, station search, and the RLHF feedback loop all talk
          to your own FastAPI backend — no data leaves your configured server.
        </Text>
      </SectionCard>
    </ScrollView>
  );
}

function Tip({ text }) {
  return (
    <View style={styles.tipRow}>
      <Ionicons name="information-circle-outline" size={14} color={colors.primary} style={{ marginTop: 2 }} />
      <Text style={styles.tipText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg },
  buttonRow: { flexDirection: "row", gap: spacing.md },
  flexBtn: { flex: 1 },
  testRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: spacing.md },
  testText: { fontSize: 12, flexShrink: 1 },
  currentBox: {
    marginTop: spacing.lg,
    backgroundColor: colors.chip,
    borderRadius: 10,
    padding: spacing.md,
  },
  currentLabel: { fontSize: 11, color: colors.textMuted, marginBottom: 2 },
  currentValue: { fontSize: 12, color: colors.text, fontWeight: "600" },
  tipRow: { flexDirection: "row", gap: 6, marginBottom: spacing.sm },
  tipText: { fontSize: 12, color: colors.textMuted, flex: 1, lineHeight: 17 },
  aboutText: { fontSize: 13, color: colors.textMuted, lineHeight: 19 },
});
