// Localized.js
// ------------
// FEATURE: EVERY screen in the user's language, without wrapping each
// string in t() by hand. Screens and components import Text / TextInput /
// Alert from here instead of "react-native":
//
//   import { Text, TextInput, Alert } from "../i18n/Localized";
//
//   <Text>Coach layout</Text>              -> "కోచ్ అమరిక" in Telugu
//   <Text>Delay: {mins} min</Text>         -> each English piece translated
//   <TextInput placeholder="Train no." />  -> placeholder translated
//   Alert.alert("Pick a date first", ...)  -> title, message, buttons
//
// Text that must stay as typed (user's own chat message, a language's own
// name) opts out with <Text noTranslate>.
//
// Every translated <Text> inside a <SpeakScope> also reports what it shows,
// so "Speak screen" can read the whole screen in the chosen language.

import React, { createContext, forwardRef, useContext, useEffect, useRef } from "react";
import { Text as RNText, TextInput as RNTextInput, Alert as RNAlert } from "react-native";
import { useT, getTranslator } from "../context/LanguageContext";

// ---------------------------------------------------------------------------
// Speak scope: collects the (already localized) text shown on one screen.
// ---------------------------------------------------------------------------
const SpeakScopeContext = createContext(null);
let nextId = 1;

export function SpeakScope({ children }) {
  const itemsRef = useRef(new Map()); // id -> text, in first-mount order
  const scopeRef = useRef(null);
  if (!scopeRef.current) {
    scopeRef.current = {
      set(id, text) {
        if (text) itemsRef.current.set(id, text);
        else itemsRef.current.delete(id);
      },
      remove(id) { itemsRef.current.delete(id); },
      texts() {
        const out = [];
        itemsRef.current.forEach((v) => { if (out[out.length - 1] !== v) out.push(v); });
        return out;
      },
    };
  }
  return <SpeakScopeContext.Provider value={scopeRef.current}>{children}</SpeakScopeContext.Provider>;
}

export function useSpeakScope() {
  return useContext(SpeakScopeContext);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
function localize(node, tAuto) {
  if (typeof node === "string") return tAuto(node);
  if (Array.isArray(node)) return node.map((n) => localize(n, tAuto));
  return node;
}

function plain(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plain).join("");
  return ""; // nested <Text> reports itself

}

export const Text = forwardRef(function Text({ children, noTranslate, noSpeak, ...rest }, ref) {
  const { lang, tAuto } = useT();
  const scope = useContext(SpeakScopeContext);
  const idRef = useRef(0);
  if (!idRef.current) idRef.current = nextId++;

  const shown = noTranslate || lang === "en" ? children : localize(children, tAuto);
  const spoken = scope && !noSpeak ? plain(shown).replace(/\s+/g, " ").trim() : "";

  useEffect(() => {
    if (scope) scope.set(idRef.current, spoken);
  }, [scope, spoken]);
  useEffect(() => () => { if (scope) scope.remove(idRef.current); }, [scope]);

  // Spread the children back as separate arguments (like JSX does), so
  // React doesn't ask for keys on a mixed "text + {value}" list.
  const kids = Array.isArray(shown) ? shown : [shown];
  return React.createElement(RNText, { ref, ...rest }, ...kids);
});

// ---------------------------------------------------------------------------
// TextInput: only the placeholder is translated, never what the user types.
// ---------------------------------------------------------------------------
export const TextInput = forwardRef(function TextInput({ placeholder, ...rest }, ref) {
  const { tAuto } = useT();
  return <RNTextInput ref={ref} placeholder={typeof placeholder === "string" ? tAuto(placeholder) : placeholder} {...rest} />;
});

// ---------------------------------------------------------------------------
// Alert: same API as react-native's Alert. The pop-up is shown once its
// title / message / button labels are translated (instantly when cached).
// ---------------------------------------------------------------------------
export const Alert = {
  alert(title, message, buttons, options) {
    const tr = getTranslator();
    if (!tr || tr.lang === "en") return RNAlert.alert(title, message, buttons, options);
    const texts = [title || "", message || "", ...(buttons || []).map((b) => (b && b.text) || "")];
    Promise.resolve(tr.translateNow(texts))
      .catch(() => texts)
      .then((out) => {
        const btns = buttons ? buttons.map((b, i) => (b && b.text ? { ...b, text: out[2 + i] } : b)) : buttons;
        RNAlert.alert(out[0], message == null ? message : out[1], btns, options);
      });
  },
  prompt: (...args) => RNAlert.prompt(...args),
};
