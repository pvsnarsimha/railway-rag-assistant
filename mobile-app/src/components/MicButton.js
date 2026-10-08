import React, { useCallback, useEffect, useRef, useState } from "react";
import { TouchableOpacity } from "react-native";
import { Alert } from "../i18n/Localized";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/colors";
import { listenOnce, stopListening, isListeningSupported, unsupportedReason } from "../services/voiceInput";
import { PARSERS } from "../utils/voiceParse";

/**
 * MicButton — tap, speak, and the answer fills the field.
 *
 * Two ways to use it:
 *   <MicButton onResult={(text) => ...} />                     raw text (Chat box)
 *   <MicButton kind="train" onValue={(digits) => ...} />       parsed value
 *
 * `kind` picks how the spoken words are understood (utils/voiceParse.js):
 *   train   "one two six five one" -> "12651"
 *   date    "28th aug 2025" -> "28-08-2025"; "27th aug" -> 27-08-<this year>
 *   station "s c" -> "SC", "vijayawada" -> "vijayawada"
 *   pnr / number / time / text
 * Anything it cannot understand calls onError instead of filling junk.
 *
 * Speech engine: services/voiceInput.js — the browser's SpeechRecognition on
 * web; on the phone it needs `expo-speech-recognition` in a dev/installed
 * build (Expo Go does not include it, and the tap says so).
 */
export default function MicButton({ onResult, onValue, onError, kind, locale = "en-IN", size = 20, style }) {
  const [listening, setListening] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; stopListening(); }, []);

  const handlePress = useCallback(async () => {
    if (listening) { stopListening(); return; }
    if (!isListeningSupported()) {
      Alert.alert("Voice input not available", `${unsupportedReason()} Typing still works as normal.`);
      return;
    }
    setListening(true);
    try {
      const text = await listenOnce({ locale });
      if (!mounted.current) return;
      if (!text) { if (onError) onError("nothing-heard", ""); return; }
      if (kind && onValue) {
        const parsed = (PARSERS[kind] || PARSERS.text)(text);
        if (parsed == null || parsed === "") { if (onError) onError("not-understood", text); } else onValue(parsed, text);
      } else if (onResult) onResult(text);
    } catch (e) {
      if (!mounted.current) return;
      if (e && e.code === "not-allowed") Alert.alert("Microphone permission needed", "Enable microphone access in Settings to use voice input.");
      else Alert.alert("Couldn't start voice input", String((e && e.message) || e));
    } finally {
      if (mounted.current) setListening(false);
    }
  }, [listening, locale, kind, onValue, onResult, onError]);

  return (
    <TouchableOpacity
      onPress={handlePress}
      style={[{ padding: 8, alignItems: "center", justifyContent: "center" }, style]}
      accessibilityLabel={listening ? "Stop voice input" : "Speak"}
      accessibilityRole="button"
    >
      {listening ? (
        <Ionicons name="mic" size={size} color={colors.danger} />
      ) : (
        <Ionicons name="mic-outline" size={size} color={colors.primary} />
      )}
    </TouchableOpacity>
  );
}
