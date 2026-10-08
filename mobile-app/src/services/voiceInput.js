// voiceInput.js
// -------------
// FEATURE: Hands-free mode — one place that listens (speech-to-text) and
// speaks prompts (text-to-speech), on web and on the installed app.
//
//   const text = await listenOnce({ locale: "en-IN" });   // "" if nothing heard
//   await speakPrompt("Say the train number");
//
// Web: the browser's SpeechRecognition. Native: expo-speech-recognition
// (needs the installed/dev build, not Expo Go — see MicButton.js). Only one
// listening session exists at a time; starting a new one ends the old one.

import { Platform } from "react-native";

const IS_WEB = Platform.OS === "web";

let NativeRecognizer = null;
let NativeSpeech = null;
if (!IS_WEB) {
  try { NativeRecognizer = require("expo-speech-recognition").ExpoSpeechRecognitionModule; } catch (e) { NativeRecognizer = null; } // eslint-disable-line global-require
  try { NativeSpeech = require("expo-speech"); } catch (e) { NativeSpeech = null; } // eslint-disable-line global-require
}

function webCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function isListeningSupported() {
  return IS_WEB ? !!webCtor() : !!NativeRecognizer;
}

export function unsupportedReason() {
  if (IS_WEB) return "This browser doesn't support speech recognition. Chrome or Edge work best.";
  return "Voice input needs the installed app build (it isn't available in Expo Go).";
}

let active = null; // { cancel() } of the current listening session

/** End whatever is currently listening (its promise resolves with what was heard so far). */
export function stopListening() {
  if (active) { try { active.cancel(); } catch (e) { /* ignore */ } }
}

/**
 * Listen for one utterance. Resolves with the final transcript ("" when
 * nothing was said). Rejects with Error(code) for 'unsupported' / 'not-allowed'.
 * onPartial(text) receives live interim text.
 */
export function listenOnce({ locale = "en-IN", maxMs = 12000, onPartial } = {}) {
  stopListening();
  return new Promise((resolve, reject) => {
    let finished = false;
    let heard = "";
    let timer = null;
    let cleanup = () => {};
    const done = (text, err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      if (active && active.token === done) active = null;
      if (err) reject(err); else resolve((text != null ? text : heard).trim());
    };

    if (IS_WEB) {
      const Ctor = webCtor();
      if (!Ctor) { done("", Object.assign(new Error("unsupported"), { code: "unsupported" })); return; }
      const rec = new Ctor();
      rec.lang = locale;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      rec.onresult = (e) => {
        let text = "";
        let final = false;
        for (let i = 0; i < e.results.length; i++) { text += e.results[i][0].transcript; if (e.results[i].isFinal) final = true; }
        heard = text;
        if (onPartial) onPartial(text);
        if (final) { try { rec.stop(); } catch (er) { /* ignore */ } }
      };
      rec.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") done("", Object.assign(new Error("not-allowed"), { code: "not-allowed" }));
        else done(heard);
      };
      rec.onend = () => done(heard);
      active = { token: done, cancel: () => { try { rec.abort(); } catch (e) { /* ignore */ } done(heard); } };
      timer = setTimeout(() => { try { rec.stop(); } catch (e) { /* ignore */ } }, maxMs);
      try { rec.start(); } catch (e) { done("", e); }
      return;
    }

    if (!NativeRecognizer) { done("", Object.assign(new Error("unsupported"), { code: "unsupported" })); return; }
    (async () => {
      try {
        const perm = await NativeRecognizer.requestPermissionsAsync();
        if (!perm.granted) { done("", Object.assign(new Error("not-allowed"), { code: "not-allowed" })); return; }
        const subs = [
          NativeRecognizer.addListener("result", (e) => {
            const text = e.results?.[0]?.transcript || "";
            if (text) heard = text;
            if (onPartial && text) onPartial(text);
            if (e.isFinal) done(heard);
          }),
          NativeRecognizer.addListener("end", () => done(heard)),
          NativeRecognizer.addListener("error", () => done(heard)),
        ];
        cleanup = () => subs.forEach((s) => s && s.remove && s.remove());
        active = { token: done, cancel: () => { try { NativeRecognizer.abort ? NativeRecognizer.abort() : NativeRecognizer.stop(); } catch (e) { /* ignore */ } done(heard); } };
        timer = setTimeout(() => { try { NativeRecognizer.stop(); } catch (e) { /* ignore */ } }, maxMs);
        NativeRecognizer.start({ lang: locale, interimResults: true, continuous: false });
      } catch (e) {
        done("", e);
      }
    })();
  });
}

/** Say a short prompt aloud; resolves when finished (or at once if speech isn't available). */
export function speakPrompt(text, locale = "en-IN") {
  return new Promise((resolve) => {
    const msg = String(text || "").trim();
    if (!msg) { resolve(); return; }
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    setTimeout(finish, 15000); // never hang the flow on a stuck voice engine
    try {
      if (IS_WEB) {
        if (typeof window === "undefined" || !("speechSynthesis" in window)) { finish(); return; }
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(msg);
        u.lang = locale;
        u.onend = finish;
        u.onerror = finish;
        window.speechSynthesis.speak(u);
      } else if (NativeSpeech) {
        NativeSpeech.stop();
        NativeSpeech.speak(msg, { language: locale, onDone: finish, onStopped: finish, onError: finish });
      } else finish();
    } catch (e) { finish(); }
  });
}

export function stopSpeaking() {
  try {
    if (IS_WEB) { if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel(); } else if (NativeSpeech) NativeSpeech.stop();
  } catch (e) { /* ignore */ }
}
