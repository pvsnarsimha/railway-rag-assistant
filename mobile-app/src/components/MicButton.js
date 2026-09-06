import React, { useCallback, useEffect, useRef, useState } from "react";
import { TouchableOpacity, Platform, Alert, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/colors";

/**
 * MicButton — tap to speak a question instead of typing it.
 *
 * Web (Expo web / react-native-web): uses the browser's built-in
 * SpeechRecognition API. Works out of the box, no extra install.
 *
 * Native (iOS/Android via Expo Go): Expo Go only bundles a fixed set of
 * native modules, and speech-to-text isn't one of them, so a real on-device
 * mic here needs `expo-speech-recognition` PLUS a custom dev client (EAS
 * Build) — plain `expo install` isn't enough because it's native code, not
 * pure JS. Rather than crash Metro on an unresolved native import, the
 * require is wrapped in try/catch: if the package + dev build are present
 * this just works, and if not, tapping the mic explains exactly what's
 * missing instead of typing being the only option with no feedback why.
 */

let ExpoSpeechRecognitionModule = null;
if (Platform.OS !== "web") {
  try {
    // eslint-disable-next-line global-require
    ExpoSpeechRecognitionModule = require("expo-speech-recognition").ExpoSpeechRecognitionModule;
  } catch (e) {
    ExpoSpeechRecognitionModule = null;
  }
}

export default function MicButton({ onResult, locale = "en-IN", size = 20, style }) {
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const webRecognitionRef = useRef(null);

  // --- Native result/end listeners (only attach if the module loaded) ---
  useEffect(() => {
    if (!ExpoSpeechRecognitionModule) return undefined;
    const resultSub = ExpoSpeechRecognitionModule.addListener("result", (event) => {
      const text = event.results?.[0]?.transcript;
      if (text) onResult(text);
    });
    const endSub = ExpoSpeechRecognitionModule.addListener("end", () => setListening(false));
    const errorSub = ExpoSpeechRecognitionModule.addListener("error", () => setListening(false));
    return () => {
      resultSub?.remove?.();
      endSub?.remove?.();
      errorSub?.remove?.();
    };
  }, [onResult]);

  const startWeb = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      Alert.alert(
        "Voice input not supported",
        "This browser doesn't support speech recognition. Chrome or Edge on desktop/Android work best — or just type your question."
      );
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = locale;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript;
      if (text) onResult(text);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    webRecognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [locale, onResult]);

  const stopWeb = useCallback(() => {
    webRecognitionRef.current?.stop();
    setListening(false);
  }, []);

  const startNative = useCallback(async () => {
    if (!ExpoSpeechRecognitionModule) {
      Alert.alert(
        "Voice input needs a dev build",
        "Speech-to-text uses a native module that isn't included in Expo Go. Run " +
          "`npx expo install expo-speech-recognition`, add its config plugin to app.json, " +
          "and build a custom dev client (`eas build --profile development`) to enable the " +
          "mic here. Typing still works as normal in the meantime."
      );
      return;
    }
    try {
      setStarting(true);
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Microphone permission needed", "Enable microphone access in Settings to use voice input.");
        return;
      }
      ExpoSpeechRecognitionModule.start({ lang: locale, interimResults: false, continuous: false });
      setListening(true);
    } catch (e) {
      Alert.alert("Couldn't start voice input", String(e?.message || e));
    } finally {
      setStarting(false);
    }
  }, [locale]);

  const stopNative = useCallback(() => {
    ExpoSpeechRecognitionModule?.stop();
    setListening(false);
  }, []);

  function handlePress() {
    if (listening) {
      if (Platform.OS === "web") stopWeb();
      else stopNative();
      return;
    }
    if (Platform.OS === "web") startWeb();
    else startNative();
  }

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={starting}
      style={[{ padding: 8, alignItems: "center", justifyContent: "center" }, style]}
      accessibilityLabel={listening ? "Stop voice input" : "Speak your question"}
      accessibilityRole="button"
    >
      {starting ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : (
        <Ionicons
          name={listening ? "mic" : "mic-outline"}
          size={size}
          color={listening ? colors.danger : colors.primary}
        />
      )}
    </TouchableOpacity>
  );
}
