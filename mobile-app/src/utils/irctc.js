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

// Launches the installed IRCTC Rail Connect app itself (a plain app launch —
// the app doesn't have to handle irctc.co.in links). If it isn't installed,
// falls back to its Play Store page rather than the desktop website.
const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${IRCTC_ANDROID_PACKAGE}`;
const ANDROID_INTENT = `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${IRCTC_ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`;

/** Copies the trip summary, then opens the IRCTC app (or its site if the app isn't installed). Returns the summary. */
export async function openIrctc(details) {
  const summary = buildBookingSummary(details || {});
  if (Platform.OS === "web" && typeof window !== "undefined") {
    // Browsers only allow navigation straight from the tap, so copy without
    // awaiting and navigate synchronously.
    try { navigator.clipboard?.writeText(summary).catch(() => {}); } catch (e) { /* ignore */ }
    const ua = navigator.userAgent || "";
    const touch = (navigator.maxTouchPoints || 0) > 1;
    // Also catches Chrome's "Desktop site" mode, which hides "Android" from the UA.
    const isAndroid = /Android/i.test(ua) || navigator.userAgentData?.platform === "Android" || (touch && /Linux/i.test(ua) && !/CrOS/i.test(ua));
    const isIos = /iPhone|iPad|iPod/i.test(ua) || (touch && /Macintosh/i.test(ua));
    if (isAndroid) {
      // Launches the installed Rail Connect app (Play Store page if it isn't installed).
      window.location.href = ANDROID_INTENT;
    } else if (isIos) {
      window.location.href = IRCTC_BOOKING_URL;
    } else if (window.confirm("IRCTC Rail Connect is a phone app, so it can't be opened from a computer.\n\nOpen the IRCTC website instead?")) {
      window.open(IRCTC_BOOKING_URL, "_blank", "noopener");
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
