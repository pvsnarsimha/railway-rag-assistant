// AutoText.js
// -----------
// FEATURE: drop-in <Text> / <TextInput> that show their text in the app
// language (LanguageContext) — so every heading, label, button, hint and
// station name on every screen changes language without wrapping each
// string in t() by hand. Screens import these instead of react-native's.
//
//   <Text>Seat Availability</Text>            // translated
//   <Text noTranslate>{userTypedText}</Text>  // left exactly as it is
//   <Text noSpeak>Stop</Text>                // not read by "Speak screen"
//   <TextInput placeholder="e.g. 12709" />    // placeholder translated
//
// Each <Text> also tells the screen's "Speak screen" button what it shows
// (see registerSpeakText), so any screen can be read aloud in the chosen
// language.

import React, { forwardRef, useContext, useEffect, useRef } from "react";
import { Text as RNText, TextInput as RNTextInput } from "react-native";
import { useT, SpeakScopeContext, registerSpeakText } from "../context/LanguageContext";

// Text inside a <Text> is part of its parent's sentence: only the outermost
// one registers for Speak screen (with the whole sentence).
const InsideText = React.createContext(false);

function plain(children) {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(plain).join("");
  if (React.isValidElement(children)) return plain(children.props && children.props.children);
  return "";
}

function translateChildren(children, t) {
  if (typeof children === "string") return t(children);
  if (Array.isArray(children)) return children.map((c) => translateChildren(c, t));
  return children;
}

export const Text = forwardRef(function Text({ children, noTranslate, noSpeak, ...rest }, ref) {
  const { t, lang } = useT();
  const scope = useContext(SpeakScopeContext);
  const nested = useContext(InsideText);
  const entryRef = useRef(null);
  if (!entryRef.current) entryRef.current = { text: "", raw: false };
  entryRef.current.text = nested || noSpeak ? "" : plain(children);
  entryRef.current.raw = !!noTranslate;
  useEffect(() => (nested ? undefined : registerSpeakText(scope, entryRef.current)), [scope, nested]);
  const kids = noTranslate || lang === "en" ? children : translateChildren(children, t);
  return (
    <InsideText.Provider value>
      <RNText ref={ref} {...rest}>{kids}</RNText>
    </InsideText.Provider>
  );
});

export const TextInput = forwardRef(function TextInput({ placeholder, noTranslate, ...rest }, ref) {
  const { t, lang } = useT();
  const ph = typeof placeholder === "string" && !noTranslate && lang !== "en" ? t(placeholder) : placeholder;
  return <RNTextInput ref={ref} placeholder={ph} {...rest} />;
});
