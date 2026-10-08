// useHandsFreeForm.js
// -------------------
// FEATURE: Hands-free mode. A screen describes its voice questions once:
//
//   const hf = useHandsFreeForm({
//     steps: [
//       { key: "train", ask: "Which train number?", kind: "train", apply: setTrainNumber },  // kind may also be your own (text) => value|null
//       { key: "date",  ask: "Which date?",         kind: "date",  apply: setDate, optional: true },
//     ],
//     onDone: () => lookup(),
//   });
//   <HandsFreeBar hf={hf} />
//
// and the app asks each question aloud, listens, understands the answer
// (utils/voiceParse.js), fills the field, and finally runs onDone. With
// Settings -> Hands-free mode ON it starts by itself every time the screen
// opens; otherwise the bar's "Hands-free" chip starts it on demand.
// Say "skip" for an optional step, "repeat" to hear the question again,
// "stop" to end.

import { useCallback, useEffect, useRef, useState } from "react";
import { useIsFocused } from "@react-navigation/native";
import { useSettings } from "../context/SettingsContext";
import { listenOnce, speakPrompt, stopListening, stopSpeaking, isListeningSupported } from "../services/voiceInput";
import { PARSERS, parseVoiceCommand } from "../utils/voiceParse";

const MAX_TRIES = 3;
const START_DELAY_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function useHandsFreeForm({ steps, onDone, autoStart = true, locale = "en-IN" }) {
  const { handsFree } = useSettings();
  const focused = useIsFocused();
  const [state, setState] = useState({ running: false, prompt: "", heard: "", stepKey: null });
  const runIdRef = useRef(0);
  const stepsRef = useRef(steps);
  const onDoneRef = useRef(onDone);
  stepsRef.current = steps;
  onDoneRef.current = onDone;
  const supported = isListeningSupported();

  const stop = useCallback(() => {
    runIdRef.current += 1;
    stopListening();
    stopSpeaking();
    setState({ running: false, prompt: "", heard: "", stepKey: null });
  }, []);

  const start = useCallback(async () => {
    const myRun = ++runIdRef.current;
    const alive = () => runIdRef.current === myRun;
    const say = async (text) => { if (alive()) await speakPrompt(text, locale); };
    if (!isListeningSupported()) return;
    let completed = true;
    try {
      for (const step of stepsRef.current) {
        if (!alive()) return;
        if (step.skipIf && step.skipIf()) continue;
        let tries = 0;
        let filled = false;
        while (alive() && tries < MAX_TRIES && !filled) {
          setState({ running: true, prompt: step.ask, heard: "", stepKey: step.key });
          await say(step.ask);
          if (!alive()) return;
          let text = "";
          try {
            text = await listenOnce({ locale, onPartial: (p) => alive() && setState((s) => ({ ...s, heard: p })) });
          } catch (e) {
            if (e && e.code === "not-allowed") { await say("Microphone permission is needed for hands-free mode."); stop(); return; }
            text = "";
          }
          if (!alive()) return;
          setState((s) => ({ ...s, heard: text }));
          const cmd = parseVoiceCommand(text);
          if (cmd === "stop") { await say("Okay, stopping."); stop(); return; }
          if (cmd === "skip") { if (step.optional) { filled = true; break; } await say("This one can't be skipped."); tries += 1; continue; }
          if (cmd === "repeat") continue;
          const parse = typeof step.kind === "function" ? step.kind : (PARSERS[step.kind] || PARSERS.text);
          const value = text ? parse(text) : null;
          if (value == null || value === "") {
            tries += 1;
            if (tries >= MAX_TRIES) break;
            await say(text ? "Sorry, I didn't understand that." : "I didn't hear anything.");
            continue;
          }
          let result = value;
          if (step.resolve) {
            try { result = await step.resolve(value); } catch (e) { result = value; }
          }
          if (!alive()) return;
          step.apply(result, value);
          filled = true;
          if (step.confirm) await say(step.confirm(result));
        }
        if (!filled && !step.optional) {
          completed = false;
          await say("I couldn't get that. You can type it or tap the mic.");
          break;
        }
      }
      if (alive() && completed) {
        await sleep(80); // let the last field update render before onDone reads it
        if (alive() && onDoneRef.current) onDoneRef.current();
      }
    } finally {
      if (alive()) setState({ running: false, prompt: "", heard: "", stepKey: null });
    }
  }, [locale, stop]);

  // Auto-start whenever the screen comes into view with hands-free ON.
  useEffect(() => {
    if (!autoStart || !handsFree || !focused || !supported) return undefined;
    const id = setTimeout(() => { start(); }, START_DELAY_MS);
    return () => { clearTimeout(id); stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsFree, focused, autoStart, supported]);

  // Leaving the screen always ends the conversation.
  useEffect(() => () => { runIdRef.current += 1; stopListening(); stopSpeaking(); }, []);

  return { ...state, start, stop, supported, handsFree };
}
