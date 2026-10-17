// After a train reaches a halt station (real recorded arrival, e.g. Khammam
// 11:09 / 11:10), the provider flips its "current" pointer on to the next
// stop almost immediately, so the train marker jumped away within seconds.
// Keep the train shown AT that station for DWELL_HOLD_MINUTES after the
// recorded arrival, then let the provider's own position take over again.
// Display-only: nothing is invented, the arrival time must be a real
// (non-predicted) actual.
export const DWELL_HOLD_MINUTES = 10;

// Times from the providers are IST wall-clock strings ("11:12", or
// "11:12 17-Oct"); compare against the IST clock whatever the phone's zone.
function istMinutesNow(nowMs) {
  const d = new Date(nowMs + 330 * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function minutesSinceClock(hhmm, nowMs) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || "").trim());
  if (!m) return null;
  return (((istMinutesNow(nowMs) - (+m[1] * 60 + +m[2])) % 1440) + 1440) % 1440;
}

function heldStopIndex(timeline, nowMs) {
  let lastReached = -1;
  timeline.forEach((s, i) => { if (s.status === "passed" || s.status === "current") lastReached = i; });
  for (let i = lastReached; i >= 0; i--) {
    const s = timeline[i];
    if (s.kind === "intermediate" || !s.code) continue;
    const arr = s.arrival;
    // The provider's own "current" pointer may already sit on a stop with
    // no recorded arrival yet; look further back for the last real one.
    if (!arr || !arr.actual || arr.actual_is_predicted !== false) continue;
    const since = minutesSinceClock(arr.actual, nowMs);
    return since != null && since <= DWELL_HOLD_MINUTES ? i : -1;
  }
  return -1;
}

const asHeld = (s) => ({ ...s, status: "current", dwell_hold: true });
const asPassed = (s) => (s.status === "current" ? { ...s, status: "passed" } : s);

export function applyStationDwell(payload, nowMs = Date.now()) {
  if (!payload || !Array.isArray(payload.timeline) || !payload.timeline.length) return payload;
  const idx = heldStopIndex(payload.timeline, nowMs);
  if (idx === -1) return payload;
  const code = payload.timeline[idx].code;
  const timeline = payload.timeline.map((s, i) => (i === idx ? asHeld(s) : asPassed(s)));
  let timeline_grouped = payload.timeline_grouped;
  if (Array.isArray(timeline_grouped)) {
    timeline_grouped = timeline_grouped.map((e) => {
      if (e.display_type === "no_halt_group") {
        return { ...e, stations: (e.stations || []).map((s) => (s.code === code ? asHeld(s) : asPassed(s))) };
      }
      return e.code === code ? asHeld(e) : asPassed(e);
    });
  }
  return { ...payload, timeline, timeline_grouped };
}
