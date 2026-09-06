import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
  Image,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { colors, spacing, radius } from "../theme/colors";
import ChatBubble from "../components/ChatBubble";
import MicButton from "../components/MicButton";
import QueryToolbar from "../components/QueryToolbar";
import { useSettings } from "../context/SettingsContext";
import { sendChatMessage, getOfflineKnowledgeBase } from "../api/railwayApi";
import { describeApiError } from "../api/client";

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

export default function ChatScreen({ navigation }) {
  const { apiBaseUrl, language, setLanguage } = useSettings();
  const [messages, setMessages] = useState([
    {
      id: nextId(),
      role: "assistant",
      text:
        "Hi! Ask me about a PNR, a train's live running status, seat/crowd predictions, or any railway policy question. You can also attach a photo of your ticket.",
    },
  ]);
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

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed && !pendingImage) return;

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
        language,
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

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
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

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ChatBubble message={item} />}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={scrollToEnd}
      />

      {sending && (
        <View style={styles.typingRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.typingText}>Thinking…</Text>
        </View>
      )}

      {pendingImage && (
        <View style={styles.previewRow}>
          <Image source={{ uri: pendingImage.uri }} style={styles.previewImage} />
          <Text style={styles.previewText}>Ticket photo attached</Text>
          <TouchableOpacity onPress={() => setPendingImage(null)}>
            <Ionicons name="close-circle" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      )}

      <QueryToolbar
        webSearch={webSearchOn}
        onToggleWebSearch={setWebSearchOn}
        deepThink={deepThinkOn}
        onToggleDeepThink={setDeepThinkOn}
      />

      <View style={styles.inputRow}>
        <TouchableOpacity style={styles.attachBtn} onPress={pickImage}>
          <Ionicons name="camera-outline" size={22} color={colors.primary} />
        </TouchableOpacity>
        <TextInput
          style={styles.textInput}
          placeholder="Ask about a PNR, train status, fares…"
          placeholderTextColor={colors.textMuted}
          value={input}
          onChangeText={setInput}
          multiline
        />
        <MicButton onResult={(text) => setInput((prev) => (prev ? `${prev} ${text}` : text))} />
        <TouchableOpacity
          style={[styles.sendBtn, (!input.trim() && !pendingImage) && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={sending || (!input.trim() && !pendingImage)}
        >
          <Ionicons name="send" size={18} color={colors.textInverse} />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  langRow: { borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.card },
  langScroll: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs },
  langChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.chip,
    marginRight: spacing.xs,
  },
  langChipActive: { backgroundColor: colors.primary },
  langChipText: { fontSize: 12, color: colors.primary, fontWeight: "600" },
  langChipTextActive: { color: colors.textInverse },
  listContent: { paddingVertical: spacing.md, flexGrow: 1 },
  typingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
    gap: spacing.xs,
  },
  typingText: { fontSize: 12, color: colors.textMuted },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
    gap: spacing.sm,
  },
  previewImage: { width: 36, height: 36, borderRadius: radius.sm },
  previewText: { flex: 1, fontSize: 12, color: colors.textMuted },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    gap: spacing.sm,
  },
  attachBtn: { padding: spacing.sm },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxHeight: 100,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  sendBtn: {
    backgroundColor: colors.primary,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { opacity: 0.4 },
});
