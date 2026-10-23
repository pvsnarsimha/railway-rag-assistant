// walkGuide.js
// ------------
// Live "like Google Maps" walking guidance. Pure JS: takes the route from
// /api/station/walk-route ({ steps:[{text,meters,lat,lng}], geometry:[[lat,lng]] })
// plus the phone's latest GPS fix and says what to do next.

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function distM(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance (m) from p to the polyline [[lat,lng],...]; Infinity when empty. */
export function distToPolylineM(p, geom) {
  if (!geom || !geom.length) return Infinity;
  const kx = Math.cos(rad(p.lat)) * 111320, ky = 110570;
  const px = p.lng * kx, py = p.lat * ky;
  let best = Infinity;
  for (let i = 0; i < geom.length; i++) {
    const ax = geom[i][1] * kx, ay = geom[i][0] * ky;
    const b = geom[i + 1] || geom[i];
    const bx = b[1] * kx, by = b[0] * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

export const ARRIVE_M = 20;     // within this of the pickup point = arrived
export const REACH_M = 18;      // within this of a turn = turn done
export const WARN_M = 60;       // "In N metres, turn left" is said inside this
export const OFF_ROUTE_M = 45;  // further than this from the line = re-route

export function newGuideState() { return { cur: 1, warned: -1, started: false, arrived: false }; }

/**
 * One GPS fix -> { state, say: [strings], remainingM, nextText, nextDistM, offRoute, arrived }.
 * `dest` is {lat,lng}. Never mutates `state`.
 */
export function guideTick(state, pos, route, dest) {
  const s = { ...state };
  const say = [];
  const steps = route.steps || [];
  const out = (extra = {}) => ({ state: s, say, remainingM: null, nextText: null, nextDistM: null, offRoute: false, arrived: s.arrived, ...extra });
  if (s.arrived) return out();
  const toDest = dest ? distM(pos, dest) : Infinity;
  if (toDest <= ARRIVE_M) {
    s.arrived = true;
    say.push("You have arrived at your pickup point. You can book your cab now.");
    return out({ remainingM: 0, arrived: true });
  }
  if (distToPolylineM(pos, route.geometry) > OFF_ROUTE_M && !route.fallback) {
    return out({ offRoute: true, remainingM: Math.round(toDest) });
  }
  // Skip every turn already reached.
  while (s.cur < steps.length - 1 && steps[s.cur].lat != null && distM(pos, steps[s.cur]) <= REACH_M) s.cur += 1;
  const step = steps[Math.min(s.cur, steps.length - 1)];
  const d = step && step.lat != null ? distM(pos, step) : toDest;
  const isLast = s.cur >= steps.length - 1;
  const nextText = isLast ? "Continue to the pickup point" : step.text;
  if (!s.started) {
    s.started = true;
    say.push(isLast ? `Walk about ${Math.round(toDest)} metres to the pickup point.`
      : `Walk about ${Math.round(d)} metres, then ${nextText.charAt(0).toLowerCase()}${nextText.slice(1)}.`);
  } else if (!isLast && d <= WARN_M && s.warned !== s.cur) {
    s.warned = s.cur;
    say.push(`In ${Math.max(10, Math.round(d / 10) * 10)} metres, ${nextText.charAt(0).toLowerCase()}${nextText.slice(1)}.`);
  }
  let remaining = d;
  for (let i = s.cur; i < steps.length; i++) remaining += steps[i].meters || 0;
  if (isLast) remaining = toDest;
  return out({ remainingM: Math.round(remaining), nextText, nextDistM: Math.round(d) });
}
