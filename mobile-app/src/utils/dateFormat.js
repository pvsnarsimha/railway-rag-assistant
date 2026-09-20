// Small, dependency-free date helpers shared by DateStrip and
// MonthCalendarModal — this project has no date library in its deps
// (see App.js's package list), and these are simple enough (calendar-day
// math, not timezone-aware scheduling) not to need one.

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "dd-mm-yyyy" — the exact format backend/trains_between.py's
 * filter_by_running_date() and the rest of the search API expect. */
export function toDdMmYyyy(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${d}-${m}-${y}`;
}

/** Parses a "dd-mm-yyyy" string back into a local Date (midnight), or null
 * if it isn't in that exact shape — never guesses at another format. */
export function fromDdMmYyyy(text) {
  if (!text || typeof text !== "string") return null;
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  // Guard against a rollover (e.g. "31-02-2026") producing a valid-looking
  // Date object for the WRONG day rather than the requested one.
  if (d.getDate() !== Number(dd) || d.getMonth() !== Number(mm) - 1 || d.getFullYear() !== Number(yyyy)) {
    return null;
  }
  return d;
}

export function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function isSameDay(a, b) {
  return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function weekdayShort(date) {
  return WEEKDAY_SHORT[date.getDay()];
}

export function monthShort(date) {
  return MONTH_SHORT[date.getMonth()];
}

/** "Today" / "Tomorrow" / "Mon" style label for the DateStrip's top line. */
export function relativeDayLabel(date) {
  const today = startOfToday();
  if (isSameDay(date, today)) return "Today";
  if (isSameDay(date, addDays(today, 1))) return "Tomorrow";
  return weekdayShort(date);
}

/** "Sun, 20 Sep 2026" — the results header's date line. */
export function formatLongLabel(date) {
  return `${weekdayShort(date)}, ${date.getDate()} ${monthShort(date)} ${date.getFullYear()}`;
}

/** "HH:MM" -> minutes since midnight, or null if not parseable. Shared by
 * the results toolbar's client-side Sort By (departure/arrival time). */
export function hhmmToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== "string" || !hhmm.includes(":")) return null;
  const [h, m] = hhmm.split(":");
  const hours = Number(h);
  const mins = Number(m);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null;
  return hours * 60 + mins;
}
