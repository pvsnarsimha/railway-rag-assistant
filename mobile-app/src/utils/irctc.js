import { Linking, Platform } from "react-native";
import * as Clipboard from "expo-clipboard";

// Official IRCTC booking portal. IRCTC has no supported URL params to
// prefill a search, so booking is always a real hand-off: the trip summary
// is copied to the clipboard and IRCTC's own app/site opens.
export const IRCTC_BOOKING_URL = "https://www.irctc.co.in/nget/train-search";
// IRCTC Rail Connect (Android package id).
const IRCTC_ANDROID_PACKAGE = "cris.org.in.prs.ima";

export function buildBookingSummary({ trainNumber, trainName, source, dest, date, travelClass, quota }) {
  return [
    `Train ${trainNumber}${trainName ? ` (${trainName})` : ""}`,
    source && dest ? `${source} → ${dest}` : null,
    date ? `Date: ${date}` : null,
    travelClass && travelClass !== "Any" ? `Class: ${travelClass}` : null,
    quota ? `Quota: ${quota}` : null,
  ].filter(Boolean).join(" · ");
}

/** Copies the trip summary, then opens the IRCTC app (or its site if the app isn't installed). Returns the summary. */
export async function openIrctc(details) {
  const summary = buildBookingSummary(details || {});
  try { await Clipboard.setStringAsync(summary); } catch (e) { /* hand-off still proceeds */ }
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") window.open(IRCTC_BOOKING_URL, "_blank", "noopener");
    return summary;
  }
  if (Platform.OS === "android") {
    // Opens the IRCTC app directly; falls back to the website if it isn't installed.
    const intent = `intent://www.irctc.co.in/nget/train-search#Intent;scheme=https;package=${IRCTC_ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(IRCTC_BOOKING_URL)};end`;
    try { await Linking.openURL(intent); return summary; } catch (e) { /* fall through */ }
  }
  // iOS: the https link opens the IRCTC app when it handles the link, else Safari.
  try { await Linking.openURL(IRCTC_BOOKING_URL); } catch (e) { /* nothing more to try */ }
  return summary;
}
