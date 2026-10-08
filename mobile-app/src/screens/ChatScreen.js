import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
  Animated,
} from "react-native";
import { Text, TextInput } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { colors, spacing, radius } from "../theme/colors";
import ChatBubble, { AssistantAvatar } from "../components/ChatBubble";
import MicButton from "../components/MicButton";
import HandsFreeBar from "../components/HandsFreeBar";
import useHandsFreeForm from "../hooks/useHandsFreeForm";
import { useSettings } from "../context/SettingsContext";
import { sendChatMessage, getOfflineKnowledgeBase } from "../api/railwayApi";
import { describeApiError } from "../api/client";
import { useT } from "../context/LanguageContext";
import ScreenLanguageBar from "../components/ScreenLanguageBar";
import { languageInfo } from "../utils/notifyLanguage";

const LANGUAGES = [
  "auto", "English", "Hindi", "Bengali", "Tamil", "Telugu", "Kannada",
  "Malayalam", "Marathi", "Gujarati", "Punjabi", "Odia",
];

// -----------------------------------------------------------------------
// FEATURE: Full Offline Knowledge Base (RAG Without Network)
// -----------------------------------------------------------------------
// Same real 54-article KB the online RAG searches, cached to AsyncStorage
// whenever the backend is reachable so a later message sent with no
// network can still answer FAQ/policy questions from real cached text.
//
// CROWD-POSITION FOLLOW-UP: this used to be a literal substring/`.includes()`
// scorer — a real query with 5+ overlapping words could still rank the
// wrong article top, and only ever returned ONE raw article's text
// verbatim with no synthesis. What it's NOT going to become is full
// offline semantic search + LLM synthesis — that needs either an
// embedding model or a live LLM call, and neither can run inside a React
// Native app without bundling a multi-hundred-MB model (see
// backend/semantic_engine.py's real embeddings, which only run
// server-side for exactly that reason). What CAN genuinely improve
// on-device, with no new dependency and no model download, is the
// RANKING and the PRESENTATION:
//   - TF-IDF-weighted term scoring instead of raw substring counting, so
//     a query's rarer/more distinctive words count for more than common
//     ones (the same idea hybrid_retriever.py's BM25 half uses server-side,
//     simplified to fit comfortably in a screen's worth of JS).
//   - The top 1-3 matches are combined into one structured reply instead
//     of dumping a single raw article, so multi-part questions ("what's
//     the refund policy AND do I need ID") have a better chance of being
//     answered by more than one cached article at once.
// This is still explicitly labeled offline/keyword-based/non-AI-generated
// below — it's a better keyword search, not a fake "AI answer".
const OFFLINE_KB_KEY = "chat.offlineKnowledgeBase";

async function primeOfflineKnowledgeBase(apiBaseUrl) {
  try {
    const data = await getOfflineKnowledgeBase(apiBaseUrl);
    if (data.articles && data.articles.length) {
      await AsyncStorage.setItem(OFFLINE_KB_KEY, JSON.stringify(data.articles));
    }
  } catch { /* offline or backend down right now - fine, retried on next screen mount */ }
}

function tokenize(text) {
  return (text || "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
}

/** Ranks cached KB articles against the query with TF-IDF-weighted term
 * overlap (computed fresh each call — cheap at ~54 articles, no need to
 * cache the index). Returns the top `topN` articles with scores > 0,
 * best first. Never invents an answer for a term that isn't actually
 * present in any article. */
function rankOfflineArticles(articles, query, topN = 3) {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length) return [];

  const docs = articles.map((a) => ({
    article: a,
    terms: tokenize(`${a.category} ${a.text} ${(a.entities || []).join(" ")}`),
  }));
  const N = docs.length;

  // Document frequency per query term, for IDF — a term only 2 of 54
  // articles mention is a much stronger signal than one 40 of them share.
  const df = {};
  queryTerms.forEach((t) => {
    df[t] = docs.reduce((count, d) => count + (d.terms.includes(t) ? 1 : 0), 0);
  });

  const scored = docs.map((d) => {
    let score = 0;
    queryTerms.forEach((t) => {
      const tf = d.terms.filter((x) => x === t).length;
      if (tf === 0 || !df[t]) return;
      const idf = Math.log((N + 1) / df[t]); // +1 keeps idf finite/positive even when df===N
      score += tf * idf;
    });
    // A whole-phrase match (the exact typed question, not just its
    // words) is still a strong real signal on top of the term score.
    const haystack = `${d.article.category} ${d.article.text}`.toLowerCase();
    if (query.length > 4 && haystack.includes(query.toLowerCase())) score += 2;
    return { article: d.article, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

async function searchOfflineKnowledgeBase(query, topN = 3) {
  let articles = [];
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_KB_KEY);
    articles = raw ? JSON.parse(raw) : [];
  } catch { articles = []; }
  if (!articles.length || !query) return [];
  return rankOfflineArticles(articles, query, topN);
}

/** Combines the top-ranked cached articles into one structured reply
 * instead of a single raw dump — still just cached text, stitched
 * together, never an LLM-generated sentence. */
function synthesizeOfflineAnswer(ranked) {
  if (!ranked.length) return null;
  const [top, ...rest] = ranked;
  let text = `${top.article.category}\n${top.article.text}`;
  if (rest.length) {
    text += `\n\nRelated cached articles that may also help:\n`;
    text += rest.map((r) => `• ${r.article.category}: ${r.article.text}`).join("\n");
  }
  return text;
}

let messageIdCounter = 0;
function nextId() {
  messageIdCounter += 1;
  return `m${Date.now()}_${messageIdCounter}`;
}

const SUGGESTIONS = [
  { icon: "location-outline", title: "Where is train 12728 now?" },
  { icon: "flash-outline", title: "When does Tatkal booking open?" },
  { icon: "swap-horizontal-outline", title: "Trains from Hyderabad to Vijayawada tomorrow" },
  { icon: "cash-outline", title: "What is the refund rule if my train is cancelled?" },
];

const GREETING = {
  id: "greeting",
  role: "assistant",
  text:
    "Hi! Ask me about a PNR, a train's live running status, seat/crowd predictions, or any railway policy question. You can also attach a photo of your ticket.",
};

/** Three pulsing dots inside an assistant row, shown while a reply is loading. */
function TypingDots() {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    const loops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(v, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.3, duration: 320, useNativeDriver: true }),
        ])
      )
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);
  return (
    <View style={styles.typingRow}>
      <AssistantAvatar />
      <View style={styles.typingDots}>
        {dots.map((v, i) => <Animated.View key={i} style={[styles.dot, { opacity: v }]} />)}
      </View>
    </View>
  );
}

/** Empty state: shown until the first message, like a new ChatGPT conversation. */
function Hero({ onPick }) {
  return (
    <ScrollView contentContainerStyle={styles.hero} keyboardShouldPersistTaps="handled">
      <View style={styles.orb}>
        <Ionicons name="sparkles" size={34} color={colors.textInverse} />
      </View>
      <Text style={styles.heroTitle}>How can I help you travel today?</Text>
      <Text style={styles.heroSub}>Live tracking · PNR · Schedules · Seats & fares · Rules</Text>
      <View style={styles.cards}>
        {SUGGESTIONS.map((sg) => (
          <TouchableOpacity key={sg.title} style={styles.card} onPress={() => onPick(sg.title)} activeOpacity={0.7}>
            <Ionicons name={sg.icon} size={18} color={colors.accent} />
            <Text style={styles.cardText}>{sg.title}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

export default function ChatScreen({ navigation }) {
  const { apiBaseUrl, language, setLanguage } = useSettings();
  // FEATURE: app language (🌐 chip at the top). English = the old
  // behaviour (auto-detect from what you type); any other language = the
  // assistant answers in it.
  const { t, lang: appLang } = useT();
  const chatLanguage = appLang && appLang !== "en" ? languageInfo(appLang).name : language;
  const [messages, setMessages] = useState([GREETING]);
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState(null); // { uri, base64, mediaType }
  const [sending, setSending] = useState(false);
  const [webSearchOn, setWebSearchOn] = useState(true);
  const [deepThinkOn, setDeepThinkOn] = useState(false);
  const listRef = useRef(null);

  useEffect(() => { primeOfflineKnowledgeBase(apiBaseUrl); }, [apiBaseUrl]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  async function pickImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.6,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const mediaType = asset.mimeType || "image/jpeg";
    setPendingImage({ uri: asset.uri, base64: asset.base64, mediaType });
  }

  async function handleSend(overrideText) {
    const trimmed = (typeof overrideText === "string" ? overrideText : input).trim();
    if (!trimmed && !pendingImage) return;
    if (sending) return;

    const userMessage = {
      id: nextId(),
      role: "user",
      text: trimmed || "(sent a ticket photo)",
      imageUri: pendingImage?.uri,
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    const imageToSend = pendingImage;
    setPendingImage(null);
    setSending(true);
    scrollToEnd();

    try {
      const data = await sendChatMessage(apiBaseUrl, {
        message: trimmed,
        imageBase64: imageToSend?.base64,
        imageMediaType: imageToSend?.mediaType,
        language: chatLanguage,
        webSearch: webSearchOn,
        deepThink: deepThinkOn,
      });
      const assistantMessage = {
        id: nextId(),
        role: "assistant",
        text: data.answer,
        responseId: data.response_id,
        map: data.map,
        sentiment: data.sentiment,
        intent: data.intent,
        webSources: data.web_sources,
        deepThinkUsed: data.deep_think_used,
        agent: data.agent,
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (e) {
      const ranked = await searchOfflineKnowledgeBase(trimmed);
      const offlineAnswer = synthesizeOfflineAnswer(ranked);
      if (offlineAnswer) {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: `🔌 No network reached — answering from cached FAQ articles (TF-IDF keyword ranking), not a live AI-generated answer.\n\n${offlineAnswer}`,
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: "I couldn't reach the assistant backend, and no cached offline FAQ article matched this question closely enough.",
            error: describeApiError(e),
          },
        ]);
      }
    } finally {
      setSending(false);
      scrollToEnd();
    }
  }

  // HANDS-FREE: ask the question out loud and it is sent straight away.
  const hf = useHandsFreeForm({
    steps: [{ key: "q", ask: "What would you like to know?", kind: "text", apply: (text) => handleSend(text) }],
  });

  const isEmpty = messages.length <= 1 && !sending;
  const canSend = !sending && (input.trim().length > 0 || !!pendingImage);

  function newChat() {
    setMessages([GREETING]);
    setInput("");
    setPendingImage(null);
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <ScreenLanguageBar
        style={{ paddingHorizontal: spacing.md, paddingTop: spacing.sm, marginBottom: 0 }}
        getSpeech={() => {
          const last = [...messages].reverse().find((m) => m.role === "assistant");
          return last ? last.text : "";
        }}
      />
      {appLang === "en" ? (
        <View style={styles.langRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.langScroll}>
            {LANGUAGES.map((lang) => (
              <TouchableOpacity
                key={lang}
                style={[styles.langChip, language === lang && styles.langChipActive]}
                onPress={() => setLanguage(lang)}
              >
                <Text style={[styles.langChipText, language === lang && styles.langChipTextActive]}>
                  {lang === "auto" ? "Auto-detect" : lang}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <View style={styles.topBar}>
        <Text style={styles.topTitle}>Railway AI</Text>
        {!isEmpty && (
          <TouchableOpacity onPress={newChat} style={styles.newChatBtn} accessibilityLabel="New chat" hitSlop={8}>
            <Ionicons name="create-outline" size={20} color={colors.text} />
          </TouchableOpacity>
        )}
      </View>

      {isEmpty ? (
        <Hero onPick={(q) => handleSend(q)} />
      ) : (
        <FlatList
          ref={listRef}
          data={messages.filter((m) => m.id !== "greeting")}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ChatBubble message={item.id === "greeting" ? { ...item, text: t(item.text) } : item} />}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={scrollToEnd}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={sending ? <TypingDots /> : null}
        />
      )}

      {/* Floating composer: text on top, tools underneath, send on the right. */}
      <View style={styles.composerWrap}>
        <View style={styles.composer}>
          <HandsFreeBar hf={hf} style={{ marginHorizontal: 12 }} />
          {pendingImage && (
            <View style={styles.previewRow}>
              <Image source={{ uri: pendingImage.uri }} style={styles.previewImage} />
              <Text style={styles.previewText}>{t("Ticket photo attached")}</Text>
              <TouchableOpacity onPress={() => setPendingImage(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={20} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          )}
          <TextInput
            style={styles.textInput}
            placeholder={t("Ask about a PNR, train status, fares…")}
            placeholderTextColor={colors.textMuted}
            value={input}
            onChangeText={setInput}
            multiline
          />
          <View style={styles.toolRow}>
            <TouchableOpacity style={styles.roundBtn} onPress={pickImage} accessibilityLabel="Attach ticket photo">
              <Ionicons name="add" size={22} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toolChip, webSearchOn && styles.toolChipOn]}
              onPress={() => setWebSearchOn(!webSearchOn)}
              accessibilityLabel="Toggle web search"
            >
              <Ionicons name="globe-outline" size={15} color={webSearchOn ? colors.primary : colors.textMuted} />
              <Text style={[styles.toolChipText, webSearchOn && styles.toolChipTextOn]}>Search</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toolChip, deepThinkOn && styles.toolChipOn]}
              onPress={() => setDeepThinkOn(!deepThinkOn)}
              accessibilityLabel="Toggle deep think"
            >
              <Ionicons name="bulb-outline" size={15} color={deepThinkOn ? colors.primary : colors.textMuted} />
              <Text style={[styles.toolChipText, deepThinkOn && styles.toolChipTextOn]}>Think</Text>
            </TouchableOpacity>
            <View style={styles.flexSpacer} />
            <MicButton onResult={(text) => setInput((prev) => (prev ? `${prev} ${text}` : text))} />
            <TouchableOpacity
              style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
              onPress={() => handleSend()}
              disabled={!canSend}
              accessibilityLabel="Send"
            >
              <Ionicons name="arrow-up" size={20} color={colors.textInverse} />
            </TouchableOpacity>
          </View>
        </View>
        <Text style={styles.disclaimer}>{t("AI can make mistakes. Check live details before you travel.")}</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.chatSurface },
  langRow: { backgroundColor: colors.chatSurface },
  langScroll: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs },
  langChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    marginRight: spacing.xs,
  },
  langChipActive: { backgroundColor: colors.text, borderColor: colors.text },
  langChipText: { fontSize: 12, color: colors.textMuted, fontWeight: "600" },
  langChipTextActive: { color: colors.textInverse },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    minHeight: 36,
  },
  topTitle: { fontSize: 17, fontWeight: "700", color: colors.text },
  newChatBtn: { padding: 4 },

  listContent: { paddingTop: spacing.sm, paddingBottom: spacing.md, flexGrow: 1 },

  // ----- empty state -----
  hero: { flexGrow: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  orb: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
    borderWidth: 4,
    borderColor: colors.chip,
  },
  heroTitle: { fontSize: 22, fontWeight: "700", color: colors.text, textAlign: "center" },
  heroSub: { fontSize: 13, color: colors.textMuted, textAlign: "center", marginTop: 6, marginBottom: spacing.xl },
  cards: { width: "100%", flexDirection: "row", flexWrap: "wrap", gap: 10 },
  card: {
    width: "48%",
    flexGrow: 1,
    minHeight: 84,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 12,
    gap: 8,
    backgroundColor: colors.chatSurface,
  },
  cardText: { fontSize: 13.5, lineHeight: 18, color: colors.text },

  // ----- typing -----
  typingRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.lg, marginVertical: spacing.sm, gap: 10 },
  typingDots: { flexDirection: "row", gap: 5, alignItems: "center", height: 28 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textMuted },

  // ----- composer -----
  composerWrap: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.sm, backgroundColor: colors.chatSurface },
  composer: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 26,
    backgroundColor: colors.chatSurface,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  previewRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingBottom: spacing.xs },
  previewImage: { width: 40, height: 40, borderRadius: 8 },
  previewText: { flex: 1, fontSize: 12, color: colors.textMuted },
  textInput: {
    maxHeight: 120,
    minHeight: 40,
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 6,
  },
  toolRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  flexSpacer: { flex: 1 },
  roundBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  toolChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toolChipOn: { backgroundColor: colors.chip, borderColor: colors.chip },
  toolChipText: { fontSize: 12.5, fontWeight: "600", color: colors.textMuted },
  toolChipTextOn: { color: colors.primary },
  sendBtn: {
    backgroundColor: colors.text,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { backgroundColor: "#C9CFDA" },
  disclaimer: { fontSize: 11, color: colors.textMuted, textAlign: "center", marginTop: 6 },
});
