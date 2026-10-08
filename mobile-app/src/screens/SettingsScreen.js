import React, { useEffect, useState } from "react";
import { View, StyleSheet, ScrollView, TouchableOpacity, Switch } from "react-native";
import { Text } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing } from "../theme/colors";
import SectionCard from "../components/SectionCard";
import LabeledInput from "../components/LabeledInput";
import PrimaryButton from "../components/PrimaryButton";
import { useSettings } from "../context/SettingsContext";
import { checkHealth, registerPushToken, getNativePushStatus } from "../api/railwayApi";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { describeApiError } from "../api/client";
import LanguagePickerModal from "../components/LanguagePickerModal";
import { getLanguage, languageInfo, loadLanguage } from "../utils/notifyLanguage";
import { useT } from "../context/LanguageContext";
import { isListeningSupported, unsupportedReason } from "../services/voiceInput";
import { Platform } from "react-native";
import { registerNotificationActions, replaceNotification, ensureLocalNotificationPermission, STATUS_ON_COLOR, getNativePushToken } from "../services/pushNotifications";

// Shown in Settings so it's easy to tell which build is installed.
export const NOTIFY_BUTTONS_VERSION = "notification buttons v6";

export default function SettingsScreen() {
  const { apiBaseUrl, setApiBaseUrl, wsBaseUrl, handsFree, setHandsFree } = useSettings();
  const [draftUrl, setDraftUrl] = useState(apiBaseUrl);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, detail }
  // FEATURE: notification language (English + 22 Indian languages).
  const { lang: screenLang, setLang: setScreenLang } = useT();
  const [lang, setLang] = useState(getLanguage());
  useEffect(() => { setLang(screenLang); }, [screenLang]);
  const [langOpen, setLangOpen] = useState(false);
  useEffect(() => { loadLanguage().then((c) => { if (c) setLang(c); }); }, []);

  const [notifyTest, setNotifyTest] = useState(null);
  const [serverButtons, setServerButtons] = useState(null);
  // Shows a sample train notification with the "Turn off updates" button
  // straight from this phone (no server) — proves the installed app has the
  // buttons. Tapping the button there works like on a real update.
  async function handleNotifyTest() {
    if (Platform.OS === "web") { setNotifyTest("On the website, buttons appear on real train notifications."); return; }
    const ok = await ensureLocalNotificationPermission();
    if (!ok) { setNotifyTest("Notifications are blocked for this app — allow them in Android settings."); return; }
    await registerNotificationActions();
    const id = await replaceNotification(null, {
      title: "Test: 12760 Charminar Exp · on time",
      body: "Crossed Kazipet Jn at 18:44. Expand this notification and tap Turn off updates — it turns green without opening the app.",
      categoryIdentifier: "train_status",
      color: STATUS_ON_COLOR,
      data: { type: "running_status", train_number: "12760", interval_minutes: "10" },
    });
    setNotifyTest(id ? "Sent — pull down the notification shade and expand it." : "Couldn't show a notification (Expo Go can't show buttons — use the installed app).");
    // Real train updates come from the server: check it can send them with
    // the buttons (data-only through Firebase) to this phone.
    setServerButtons("Checking train updates from the server…");
    try {
      const token = await AsyncStorage.getItem("moreTools.pushToken");
      const native = await getNativePushToken();
      if (!token) { setServerButtons("Start Live Tracking with notifications on once — then train updates get the buttons."); return; }
      if (!native) { setServerButtons("This phone didn't give a Firebase token — train updates will come without buttons."); return; }
      const r = await registerPushToken(apiBaseUrl, token, "android");
      if (r && r.native_push === undefined) { setServerButtons("✖ The server on Render is an older version — redeploy it, then check again."); return; }
      if (!(r && r.native_push)) {
        setServerButtons("✖ The server can't send through Firebase (FIREBASE_SERVICE_ACCOUNT_JSON not set on Render) — train updates come without buttons.");
        return;
      }
      // The server just sent a silent test message; wait for this phone to
      // confirm it (background task -> /api/push/native-ack).
      let confirmed = false;
      for (let i = 0; i < 8 && !confirmed; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        try { confirmed = !!(await getNativePushStatus(apiBaseUrl, token)).confirmed; } catch (e) { /* retry */ }
      }
      setServerButtons(confirmed
        ? "✔ Train updates from the server will show Turn off updates, even with the app closed."
        : "✖ This phone didn't confirm the server's test message, so train updates come the normal way (no buttons). Allow Auto-launch and set Battery to Unrestricted for this app, then check again.");
    } catch (e) {
      setServerButtons("Couldn't reach the server to check — try again when online.");
    }
  }

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

      <SectionCard title="Hands-free mode" subtitle="The app asks for the train number, stations and date out loud, listens, and fills the fields for you.">
        <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 4 }}>
          <Ionicons name="mic-circle-outline" size={22} color={colors.primary} style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: "700", color: colors.text }}>Ask by voice on every screen</Text>
            <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
              Say “one two six five one”, “28th aug 2025” or just “tomorrow”. A date without a year means this year. Say “skip”, “repeat” or “stop” any time.
            </Text>
          </View>
          <Switch value={!!handsFree} onValueChange={setHandsFree} accessibilityLabel="Hands-free mode" />
        </View>
        {!isListeningSupported() ? (
          <Text style={{ fontSize: 12, color: colors.danger, marginTop: 6 }}>{unsupportedReason()}</Text>
        ) : null}
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

      <SectionCard title="Notification buttons" subtitle="Check that this installed app shows Turn off updates on train notifications.">
        <PrimaryButton title="Test notification buttons" variant="secondary" onPress={handleNotifyTest} />
        {notifyTest ? <Text style={styles.aboutText}>{notifyTest}</Text> : null}
        {serverButtons ? <Text style={styles.aboutText}>{serverButtons}</Text> : null}
        <Text style={styles.aboutText}>Build: {NOTIFY_BUTTONS_VERSION}</Text>
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
