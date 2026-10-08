// voiceResolve.js
// ---------------
// Hands-free helper: turn a spoken station ("vijayawada", "s c") into the
// real station { code, name } using the same /api/stations/suggest the
// station boxes use. Falls back to the spoken text itself, never invents one.

import { suggestStations, searchStations } from "../api/railwayApi";

export async function resolveSpokenStation(apiBaseUrl, spoken) {
  const q = String(spoken || "").trim();
  if (!q) return null;
  try {
    let data = await suggestStations(apiBaseUrl, { query: q, limit: 3 });
    if (!(data.matches || []).length && q.length >= 3) data = await searchStations(apiBaseUrl, { query: q, topK: 3 });
    const m = (data.matches || [])[0];
    if (m && m.code) return { code: m.code, name: m.name || null };
  } catch (e) { /* offline — use the spoken text */ }
  return /^[A-Z]{2,5}$/.test(q.toUpperCase()) ? { code: q.toUpperCase(), name: null } : { code: q, name: null };
}
