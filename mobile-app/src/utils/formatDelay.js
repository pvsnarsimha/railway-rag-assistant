/**
 * formatDelay.js
 * ---------------
 * Shared delay-duration formatter — mirrors frontend/app.js's
 * formatDelayDuration exactly (e.g. 75 -> "1h 15m", 45 -> "45m", -10 -> "-10m")
 * so a delay reads identically on web and mobile.
 *
 * RESTORED: this file is imported by six other mobile files
 * (TrackedTrainCard.js, LiveTrackingScreen.web.js, MoreToolsScreen.js,
 * DelayPredictScreen.js) but was missing from this upload, which would
 * crash the Metro bundle (module not found) before the app could even
 * start — not just break Live Tracking. See the project's own notes on
 * uploads intermittently reverting/omitting previously-fixed files.
 */

export function formatDelayDuration(mins) {
  if (mins == null || Number.isNaN(mins)) return null;
  const sign = mins < 0 ? "-" : "";
  const abs = Math.round(Math.abs(mins));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m}m`;
  if (m === 0) return `${sign}${h}h`;
  return `${sign}${h}h ${m}m`;
}

export default formatDelayDuration;
