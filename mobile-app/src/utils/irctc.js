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

const ANDROID_INTENT = `intent://www.irctc.co.in/nget/train-search#Intent;scheme=https;package=${IRCTC_ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(IRCTC_BOOKING_URL)};end`;

/** Copies the trip summary, then opens the IRCTC app (or its site if the app isn't installed). Returns the summary. */
export async function openIrctc(details) {
  const summary = buildBookingSummary(details || {});
  if (Platform.OS === "web" && typeof window !== "undefined") {
    // Browsers only allow navigation straight from the tap, so copy without
    // awaiting and navigate synchronously.
    try { navigator.clipboard?.writeText(summary).catch(() => {}); } catch (e) { /* ignore */ }
    const ua = (navigator.userAgent || "");
    if (/Android/i.test(ua)) {
      // Chrome on Android: the intent opens the installed IRCTC app, else the website.
      window.location.href = ANDROID_INTENT;
    } else {
      // iOS / desktop: the https link opens the IRCTC app when it handles the link, else the site.
      window.location.href = IRCTC_BOOKING_URL;
    }
    return summary;
  }
  try { await Clipboard.setStringAsync(summary); } catch (e) { /* hand-off still proceeds */ }
  if (Platform.OS === "android") {
    try { await Linking.openURL(ANDROID_INTENT); return summary; } catch (e) { /* fall through */ }
  }
  try { await Linking.openURL(IRCTC_BOOKING_URL); } catch (e) { /* nothing more to try */ }
  return summary;
}
