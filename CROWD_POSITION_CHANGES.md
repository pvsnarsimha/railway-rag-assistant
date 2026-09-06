# Crowd Position Follow-Up: What Changed

This documents the code changes made in response to the crowd-position feedback verified earlier. Per your direction, every item got a best-effort real implementation where the underlying data/API exists, and an honest, better-labeled heuristic where it doesn't (no fabricated IRCTC/live-data integrations).

**Update:** a bug was found and fixed after your screenshot showed "Couldn't reach the backend just now" on the Coach Layout tool. Root cause: `frontend/app.js` has two separate top-level IIFEs (self-contained scopes) — the `ddmmyyyy()` date-formatting helper only exists in the first one, but the new Coach Layout date field I added called it from code living in the *second* IIFE, where it's undefined. That threw a `ReferenceError` before the request ever reached your server (which is why it never showed up in your backend's terminal log). Fixed by using that scope's own existing equivalent helper, `toDDMMYYYY()`, instead. Verified with a headless-browser test that clicks through the actual UI end-to-end (fill train/route/date → submit → confirm the request now reaches the backend and the layout renders) — this is fixed in the zip below.

## 1. Mobile push notifications for delay alerts — now real, not just foreground

The gap was specific to the mobile app (the backend and web app already had this working). Mobile now has a full opt-in push pipeline:

- `mobile-app/src/services/pushNotifications.js` (new): requests permission, registers a real device push token via Expo's push service, and configures the foreground notification handler.
- Why Expo's push service rather than raw FCM: it forwards to both Android (FCM) and iOS (APNs) without needing a native Firebase project configured in this app — just a free EAS project ID (`mobile-app/app.json` → `expo.extra.eas.projectId`, currently a placeholder, same "leave it unset and get an honest degraded message" pattern the rest of the project already uses for provider keys).
- `backend/push_notifications.py`: now detects an Expo-format token and routes it through Expo's HTTPS push API instead of `firebase-admin`; every existing web/FCM token keeps working exactly as before, unchanged.
- `mobile-app/src/screens/MoreToolsScreen.js` (Delay Alerts tool): added an "Enable Background Push" button that registers the token with the backend and syncs your watch list to `alert_scheme.py`'s server-side scheduler — same mechanism the web app already uses.
- `App.js`: configures the foreground notification handler and a tap-response listener at startup.

**Still needed for this to fire on a real device:** a real EAS project ID in `app.json`, and a dev/standalone build (Expo Go dropped Android remote push support in SDK 53+, noted directly in the UI when detected).

## 2. Fare shown on every search result, not just opt-in tools

- `backend/app.py` (`/api/trains/search`): now attaches a real RailKit fare lookup to each result whenever a class + date are given, reusing the same capped live-availability check already made per search (capped at 6 trains/page, same budget `journey_planner.py` uses, kept in sync via a shared constant rather than duplicated).
- Mobile (`TrainSearchScreen.js`) and web (`frontend/app.js`) now render a fare badge per train, and surface the honest `fare_note` (e.g. "pick a class to see fare," or "checked for the first 6 trains only").
- Still true and unavoidable: this is RailKit's (third-party) cached fare, not IRCTC's own live/dynamic Tatkal pricing — no public IRCTC fare API exists to integrate with, so this is labeled as an estimate everywhere it appears.

## 3. Booking hand-off: pre-filled clipboard summary before IRCTC

IRCTC's search page genuinely has no supported URL parameters to prefill (checked in the existing code comments, not assumed) — an in-app booking completion or a fabricated deep link were both off the table. Instead:

- Mobile (`TrainSearchScreen.js`) and web (`frontend/app.js`): "Book on IRCTC" now copies a formatted trip summary (train, route, date, class, quota) to the clipboard immediately before opening IRCTC, so it can be pasted into IRCTC's own search box instead of retyped from memory.
- `mobile-app/package.json`: added `expo-clipboard`.

## 4. Platform prediction: broader, better-informed coverage

- `backend/advanced_features.py`: the flat "20 known stations, 5-platform default for everyone else" heuristic is replaced with a three-tier system: (1) documented real counts for the same 20 major stations, (2) a topology-informed estimate for any other station in the app's real route graph (`data/rail_network_edges.json`) — a station's junction degree (how many lines meet there) is real, derivable structure that genuinely correlates with size, (3) a smaller, more honest default (3, not 5) for a station with no data at all, since most of India's 7,000+ stations are small halts, not junctions.
- The response now includes `platform_count_basis` / `platform_count_note` so the UI can say *why* a count is what it is — both mobile and web now render that note.
- Genuinely can't fix: real per-station platform-count data for all 7,000+ stations isn't published anywhere this app can reach. This makes the existing heuristic meaningfully better-informed, not a real data source.

## 5. Offline mode: TF-IDF ranking + multi-article synthesis (not full semantic RAG)

- `mobile-app/src/screens/ChatScreen.js`: replaced the literal substring/`.includes()` keyword scorer with TF-IDF-weighted term scoring (rarer, more distinctive query words count for more — the same idea as the backend's BM25 retrieval, sized down to run in-app with no new dependency), and the top 1-3 matches are combined into one structured reply instead of a single raw article dump.
- Genuinely can't fix: real offline semantic search needs a bundled embedding model, and natural-language synthesis needs either a local LLM or a live API call — neither fits in a React Native app without a multi-hundred-MB download. This remains explicitly labeled offline/keyword-based, never presented as an AI-generated answer.

## 6. Seat/berth occupancy: probabilistic estimate from real aggregate counts

- `backend/advanced_features.py`: new `estimate_seat_occupancy()` shades the coach's real, sequentially-numbered berths (from the existing seat-map generator) using the real aggregate AVAILABLE/RAC/WL count already fetched for that train/date/class/quota — a genuine improvement over the previous bare geometry diagram, but explicitly labeled a distribution estimate, not a live per-berth sensor (which Indian Railways doesn't publish).
- `backend/app.py` (`/api/advanced/coach-layout/...`): now accepts optional `source`/`dest`/`date`/`quota` and attaches the occupancy estimate when all are present.
- Mobile (`MoreToolsScreen.js`) and web (`frontend/app.js`) now render shaded/crossed-out berths for the estimated-occupied ones, with the honest disclaimer directly underneath.

## Verification performed

- `python -m py_compile` across every modified backend file.
- Babel (`@babel/preset-react` + `@babel/preset-env`) transform-check across every modified/new mobile-app `.js` file (no JSX/syntax errors).
- `node --check` on `frontend/app.js`.
- Unit-style smoke tests (no network) for: platform-prediction tiering (known / topology-estimate / unlisted-default), seat-occupancy estimation math, availability-status parsing, and Expo-vs-FCM push routing.
- JSON validity check on `app.json` / `package.json`.

Not run: a live end-to-end test against real RailKit/RapidAPI/Firebase/Expo credentials, since none are configured in this environment — the same "can't verify without real provider keys" limitation that applies to the rest of this project's optional integrations.
