// voiceParse.js
// -------------
// FEATURE: Hands-free mode. Turns what the speech recogniser heard into the
// exact values the forms expect — pure functions, no React, easy to test.
//
//   parseSpokenTrainNumber("one two six five one")  -> "12651"
//   parseSpokenDate("28th aug 2025")                -> Date 28-08-2025
//   parseSpokenDate("27th aug")                     -> Date 27-08-<THIS YEAR>
//   parseSpokenStation("s c")                       -> "SC"
//
// When a date is spoken without a year, the CURRENT year is used.

const UNITS = {
  zero: 0, oh: 0, o: 0, shunya: 0, sunna: 0,
  one: 1, ek: 1, won: 1, first: 1,
  two: 2, to: 2, too: 2, do: 2, second: 2,
  three: 3, teen: 3, third: 3,
  four: 4, for: 4, char: 4, chaar: 4, fourth: 4,
  five: 5, panch: 5, paanch: 5, fifth: 5,
  six: 6, chhe: 6, chhah: 6, che: 6, sixth: 6,
  seven: 7, saat: 7, seventh: 7,
  eight: 8, ate: 8, aath: 8, eighth: 8,
  nine: 9, nau: 9, ninth: 9,
};
const TEENS = {
  ten: 10, tenth: 10, eleven: 11, eleventh: 11, twelve: 12, twelfth: 12, thirteen: 13, thirteenth: 13,
  fourteen: 14, fourteenth: 14, fifteen: 15, fifteenth: 15, sixteen: 16, sixteenth: 16,
  seventeen: 17, seventeenth: 17, eighteen: 18, eighteenth: 18, nineteen: 19, nineteenth: 19,
};
const TENS = {
  twenty: 20, twentieth: 20, thirty: 30, thirtieth: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
const FILLER = new Set(["of", "the", "on", "at", "is", "it", "its", "date", "train", "number", "no", "please", "and", "my", "dated", "day", "for", "from", "station"]);

/** Lower-case, split into word / number tokens, expand "double 5" / "triple 7". */
function tokenize(text) {
  const raw = String(text || "").toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1") // "12,651"
    .replace(/[^a-z0-9/:.\-\s]/g, " ")
    .replace(/([a-z])-([a-z])/g, "$1 $2") // "twenty-eight"
    .split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    if ((w === "double" || w === "triple") && i + 1 < raw.length) {
      const d = raw[i + 1];
      const times = w === "double" ? 2 : 3;
      for (let k = 0; k < times; k++) out.push(d);
      i++;
    } else {
      out.push(w);
    }
  }
  return out;
}

const isNumWord = (w) => w in UNITS || w in TEENS || w in TENS || w === "hundred" || w === "thousand";

/** A run of number words ("twenty eight", "twelve six five one") -> groups of < 100. */
function wordGroups(words) {
  const groups = [];
  let afterBig = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let val = null;
    let pad = false;
    if (w in TENS) {
      val = TENS[w];
      const nx = words[i + 1];
      if (nx in UNITS && UNITS[nx] >= 1 && nx !== "o" && nx !== "oh") { val += UNITS[nx]; i++; }
    } else if (w in TEENS) {
      val = TEENS[w];
    } else if (w in UNITS) {
      val = UNITS[w];
      const nx = words[i + 1];
      if (val === 0 && nx in UNITS && UNITS[nx] >= 1 && nx !== "o" && nx !== "oh") { val = UNITS[nx]; pad = true; i++; }
    } else if (w === "hundred" || w === "thousand") {
      if (groups.length) groups[groups.length - 1].v *= w === "hundred" ? 100 : 1000;
      afterBig = true;
      continue;
    }
    if (val == null) continue;
    if (afterBig && groups.length) { groups[groups.length - 1].v += val; afterBig = false; } else groups.push({ v: val, pad });
  }
  return groups;
}

/** "28th" / "2" / "2025" -> number, else null. */
function digitToken(w) {
  const m = /^(\d+)(?:st|nd|rd|th)?$/.exec(w);
  return m ? Number(m[1]) : null;
}

/** Digits only — "one two six five one", "12651", "twelve six five one" -> "12651". */
export function wordsToDigits(text) {
  const toks = tokenize(text);
  let out = "";
  let run = [];
  const flush = () => {
    if (run.length) { out += wordGroups(run).map((g) => (g.pad ? `0${g.v}` : String(g.v))).join(""); run = []; }
  };
  for (const w of toks) {
    if (isNumWord(w)) { run.push(w); continue; }
    flush();
    if (/^\d+$/.test(w)) out += w;
  }
  flush();
  return out;
}

/** Train number: 1–5 digits, or null when nothing numeric (or too long) was heard. */
export function parseSpokenTrainNumber(text) {
  const d = wordsToDigits(text);
  if (!d || d.length > 5) return null;
  return d;
}

/** Any plain number (PNR, fare, minutes …) as a digit string. */
export function parseSpokenNumber(text, maxLen = 12) {
  const d = wordsToDigits(text);
  return d && d.length <= maxLen ? d : null;
}

/** PNR: exactly 10 digits. */
export function parseSpokenPnr(text) {
  const d = wordsToDigits(text);
  return d.length === 10 ? d : null;
}

function validDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

/** Fold word groups into values, treating a trailing "twenty twenty five" as a year. */
function groupValues(groups) {
  const vals = groups.map((g) => g.v);
  const n = vals.length;
  if (n >= 2 && (vals[n - 2] === 19 || vals[n - 2] === 20) && vals[n - 1] < 100) {
    return [...vals.slice(0, n - 2), vals[n - 2] * 100 + vals[n - 1]];
  }
  return vals;
}

/**
 * Spoken date -> local Date (midnight), or null. `now` is injectable for tests.
 * No year spoken => the current year.
 */
export function parseSpokenDate(text, now = new Date()) {
  const s = String(text || "").toLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
  if (/day after tomorrow|overmorrow/.test(s)) return shift(2);
  if (/day before yesterday/.test(s)) return shift(-2);
  if (/\btomorrow\b|\bkal\b.*\bagle\b/.test(s)) return shift(1);
  if (/\byesterday\b/.test(s)) return shift(-1);
  if (/\btoday\b|\baaj\b|\bnow\b/.test(s)) return today;

  // Numeric: 28/08/2025, 28-8-25, 28.08 …
  const num = /\b(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?:\s*[/\-.]\s*(\d{2,4}))?\b/.exec(s);
  if (num) {
    let y = num[3] ? Number(num[3]) : today.getFullYear();
    if (y < 100) y += 2000;
    return validDate(y, Number(num[2]), Number(num[1]));
  }

  const toks = tokenize(s).filter((w) => !FILLER.has(w));
  let month = null;
  const values = [];
  let run = [];
  const flush = () => {
    if (run.length) { values.push(...groupValues(wordGroups(run))); run = []; }
  };
  for (const w of toks) {
    if (w in MONTHS) { flush(); if (month == null) month = MONTHS[w]; continue; }
    if (isNumWord(w)) { run.push(w); continue; }
    flush();
    const d = digitToken(w);
    if (d != null) values.push(d);
  }
  flush();

  const year = values.find((v) => v >= 1900 && v <= 2200);
  const day = values.find((v) => v >= 1 && v <= 31);
  if (day == null) return null;
  return validDate(year ?? today.getFullYear(), month ?? today.getMonth() + 1, day);
}

/** "dd-mm-yyyy" — the format every date field in the app uses. */
export function toDdMmYyyyString(date) {
  if (!date) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
}

export function parseSpokenDateString(text, now = new Date()) {
  return toDdMmYyyyString(parseSpokenDate(text, now));
}

/** "HH:MM" (24h) from "10:30", "ten thirty", "6 pm", "22 15". */
export function parseSpokenTime(text) {
  const s = String(text || "").toLowerCase();
  const pm = /\bp\.?\s?m\b|\bevening\b|\bnight\b|\bafternoon\b/.test(s);
  const am = /\ba\.?\s?m\b|\bmorning\b/.test(s);
  let h; let m = 0;
  const clock = /\b(\d{1,2})\s*[:.]\s*(\d{2})\b/.exec(s);
  if (clock) { h = Number(clock[1]); m = Number(clock[2]); } else {
    const toks = tokenize(s);
    const vals = [];
    let run = [];
    const flush = () => { if (run.length) { vals.push(...wordGroups(run).map((g) => g.v)); run = []; } };
    for (const w of toks) {
      if (isNumWord(w)) { run.push(w); continue; }
      flush();
      const d = digitToken(w);
      if (d != null) vals.push(d);
    }
    flush();
    if (!vals.length) return null;
    if (vals.length === 1 && vals[0] >= 100) { h = Math.floor(vals[0] / 100); m = vals[0] % 100; } else { h = vals[0]; m = vals[1] || 0; }
  }
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Station: a spelt code ("s c", "v s k p") becomes "SC" / "VSKP"; a name
 * ("vijayawada junction") is returned as typed text — the field's own
 * auto-suggest turns it into the real station.
 */
export function parseSpokenStation(text) {
  const words = String(text || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter((w) => w && !["from", "to", "station", "the", "please", "going", "travelling", "traveling"].includes(w));
  if (!words.length) return null;
  if (words.length >= 2 && words.length <= 5 && words.every((w) => w.length === 1)) return words.join("").toUpperCase();
  return words.join(" ");
}

/** Plain text: just tidy it. */
export function parseSpokenText(text) {
  const t = String(text || "").trim();
  return t || null;
}

/** Voice commands usable at any hands-free prompt. */
export function parseVoiceCommand(text) {
  const s = String(text || "").toLowerCase();
  if (/\b(stop|cancel|exit|quit|never ?mind|band karo)\b/.test(s)) return "stop";
  if (/\b(skip|next|pass)\b/.test(s)) return "skip";
  if (/\b(repeat|again|dobara)\b/.test(s)) return "repeat";
  return null;
}

export const PARSERS = {
  train: parseSpokenTrainNumber,
  date: (t) => parseSpokenDateString(t),
  station: parseSpokenStation,
  pnr: parseSpokenPnr,
  number: (t) => parseSpokenNumber(t),
  time: parseSpokenTime,
  text: parseSpokenText,
};
