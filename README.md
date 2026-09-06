# Indian Railways RAG Assistant

A real-time, chat-based passenger assistant for Indian Railways queries — PNR status,
live running status, seat availability, and general FAQ/policy questions (Tatkal rules,
refunds, quotas, classes, etc.) — answered through free-text conversation, not a fixed
menu of buttons. Now with an advanced retrieval pipeline: hybrid + graph-aware,
self-reflective, and multi-modal.

## ⚠️ Honest note on "real-time data"

Indian Railways does not publish a free official public API for PNR status, live
train running status, or seat availability. The enquiry portal (NTES) has no public
API, and scraping it violates its terms of use. So "real-time Indian Railway data"
in this project means: **a registered third-party data provider**, not a government
API and not fabricated demo data.

This project integrates with **[RailKit](https://railkit.rajivdubey.dev)** —
PNR status, train info (route + real per-station coordinates), live tracking,
train search, seat availability, and fare lookup, backed by a real signup and
a real API key. It has a free tier to get started.

**Why there are two backend processes.** RailKit is published only as a
Node.js SDK — there's no publicly documented raw REST endpoint to call
directly from Python. Rather than guess at an undocumented URL, this project
runs a tiny Node.js microservice (`railkit-service/`) that uses the real,
official `railkit` npm package and re-exposes its methods as local REST
endpoints; `backend/railway_api.py` calls that microservice over HTTP. The
microservice is a pure pass-through — it never transforms, filters, or
invents a field.

To go live:

1. Get a free API key at https://railkit.rajivdubey.dev (Dashboard → API Keys).
2. Set up the microservice:
   ```bash
   cd railkit-service
   npm install
   cp .env.example .env        # set RAILKIT_API_KEY
   npm start                   # runs on http://127.0.0.1:4001
   ```
3. Set up the FastAPI backend (separate terminal):
   ```bash
   cd backend
   pip install -r requirements.txt
   cp .env.example .env        # RAILKIT_SERVICE_URL defaults to the port above;
                                # add ANTHROPIC_API_KEY if you want natural-
                                # language synthesis + ticket-photo reading
   uvicorn app:app --reload --port 8000
   ```

If the microservice isn't running, or has no RailKit key configured, the app
**never fabricates data** — it returns a clear error telling the user (and
you) exactly what's missing, while still answering any general policy
question via RAG.

**What changed with the RailKit switch, concretely:**
- **Real-Time GPS Train Tracking** got *more* accurate: RailKit's `getTrainInfo()`
  returns real `{latitude, longitude}` for most stations on a route, so the
  live-position marker now prefers that real per-station coordinate over the
  ~50-station static fallback table (`gps_tracking.py` tags every result with
  `position_source`: `"provider"`, `"estimated_from_last_station"`, or
  `"unavailable"` — it never guesses a position from a *different* station
  just to have something to show).
- **Interactive Route Map with Stations** likewise gets real coordinates for
  (nearly) every stop instead of only the major stations we'd curated.
- **Voice Assistant Integration** and **Smart Help & Tutorial System** are
  unaffected — both are frontend-only features (Web Speech API, canned
  content) with no dependency on the railway data provider.

## Newest additions: Explainable AI delay prediction, crowd-sourced position reports

Both ship on **every client this project has**: the web frontend's 🧰 More Tools
panel (`frontend/index.html`/`app.js`) AND the mobile app's Tools tab
(`mobile-app/`) — same backend endpoints, two UIs.

| Feature | Backend | Web frontend | Mobile app |
|---------|---------|---------------|------------|
| **Train Delay Prediction with Explainable AI** | `backend/delay_explainability.py`, `backend/historical_delay.py` (`headline()`), `POST /api/delay/explain` | 🧰 More Tools → **🧠 Explain Delay (AI)** tab, AND a **🧠 Why this prediction?** button right in the 📡 Live Tracking panel (tap-to-explain the train you're already tracking) | Tools → **Delay** tab, `FeatureImportanceBars.js` |
| **Crowd-Sourced Train Position Reports** | `backend/crowd_position_store.py`, `backend/crowd_position_tracking.py`, `POST/GET /api/crowd-position/*` | 🧰 More Tools → **📡 Crowd Positions** tab (standalone, with leaderboard), AND overlaid directly on the 📡 Live Tracking panel's own map (a "Show crowd-sourced position overlay" checkbox + "📍 Report my position" button) | Tools → **GPS** tab, `CrowdPositionScreen.js` |

The Live Tracking panel's versions are deliberately lighter than the
standalone 🧰 More Tools tabs: **Explain** is a tap-to-run button rather than
running on every ~12s WebSocket poll (SHAP's KernelExplainer takes a couple
of seconds — fine on demand, wasteful every tick for a barely-changed
input), and the **crowd overlay** is a second marker + uncertainty circle
drawn straight onto the map you're already looking at (refreshed on the
same live poll cadence once switched on) rather than a separate map + full
leaderboard. Both share the same anonymous reporter identity/badge count
(`localStorage` key `railwayRagReporterId`) as the standalone tab, so
reports and badges accumulate in one place no matter which UI you used.

**Train Delay Prediction with Explainable AI.** The existing delay ensemble
(RandomForest + MLPRegressor + optional LSTM, blended by RidgeCV — see
`delay_prediction.py`) now comes with a real **SHAP KernelExplainer**
breakdown instead of just a number: a ranked, percentage-attributed list of
exactly which factors pushed the prediction up or down (e.g. "22% due to
weather at current position", "20% due to worsening delay trend"), rendered
as a color-coded bar chart (red = adds delay, green = reduces it — always
paired with a +/− sign and an arrow glyph, never color alone). Weather is
folded in as its own explicit line (it's an additive term on top of the
ensemble, not one of its trained features — see `weather.py`), and — when a
train number is given — a real historical weekday comparison from the
train's own completed-journey history ("usually runs closest to on-time on
Tuesdays") is shown alongside it. SHAP failing never breaks the underlying
prediction — `shap_error` is reported and the headline figure still comes
back. On the web this lives in the 🧰 More Tools modal as its own tab (it
takes optional manual inputs — train number is not required, unlike the
Live Tracking panel's version, so you can explore it without a live train).

**Crowd-Sourced Train Position Reports.** RailKit's official position is
often just a snapped last-known-station coordinate, not a continuous live
GPS fix — this feature lets passengers actually riding a train submit their
device's real GPS position, and fuses those reports with RailKit's official
position using a genuine sequential **Kalman filter** (two independent 1-D
filters over a local flat-earth projection, honestly modelling the official
"estimated_from_last_station" tier as MUCH less precise than a real
agreeing cluster of passenger phones/browsers). Reports are clustered by
distinct reporter (not raw report count, so one device spamming can't
inflate trust), and the response always states plainly how the position
was derived — `"Position confirmed by 3 passenger reports, matches
official tracking"` vs. `"official"` vs. `"crowd_sourced_unconfirmed"` —
never silently presenting a crowd-only guess as an official fix. Simple
gamification (Bronze → Platinum tracker badges, a leaderboard) rewards
frequent reporters without ever weighting a badge-holder's report as more
trustworthy than anyone else's — badges are a thank-you, not a trust
signal. The web version uses the browser's native Geolocation API (with an
anonymous id persisted in `localStorage`, same "no login system" pattern
push notifications already use for device tokens) and renders the fused
position on the same Leaflet map engine the rest of this app's maps use.

## Latest additions: tracking, maps, voice, and onboarding

| Feature | Files | What it does |
|---------|-------|---------------|
| **Real-Time GPS Train Tracking** | `gps_tracking.py` | Parses the same live-status provider response already used for running-status answers. If the provider includes real coordinates, those are plotted directly. If it doesn't (the common case for this class of API), the marker is placed at the train's last known station from `station_coordinates.json` and clearly labelled `"estimated_from_last_station"` — never a fabricated live fix. |
| **Interactive Route Map with Stations** | `gps_tracking.py`, `frontend/app.js` (Leaflet) | Parses the schedule response into an ordered list of stations, looks up coordinates for each, and renders a polyline + station markers with an inline Leaflet map right in the chat. Stations without known coordinates are listed but flagged rather than silently dropped or guessed. |
| **Voice Assistant Integration** | `frontend/app.js` | Browser-native Web Speech API — tap the mic to dictate a question (auto-sent on recognition), and optionally toggle "Speak answers aloud" to have replies read back via speech synthesis. No server-side voice pipeline or API key needed; the mic button disables itself gracefully on browsers without speech recognition support. |
| **Smart Help & Tutorial System** | `help_content.py`, `frontend/index.html`/`app.js` | A dedicated `HELP` intent in `query_router.py` returns a canned, always-consistent walkthrough (not routed through the RAG/Claude pipeline, so it's instant and never varies). A one-time onboarding tour greets first-time visitors, and a persistent "?" button in the header reopens the same content plus a tour replay, any time. |

The `/api/chat` response now also includes a `map` field (`null` when not applicable) — either a `live_position` payload for GPS tracking or a `route` payload with a full station list, for the frontend to render.

## Latest additions: capacity prediction, geo-spatial search, graph routing, multi-language

| Feature | Files | What it does |
|---------|-------|---------------|
| **Train Capacity & Crowd Prediction** | `crowd_prediction.py` | A transparent, rule-based crowd-level ESTIMATE — not a live sensor feed (Indian Railways doesn't publish real-time coach occupancy anywhere this app can reach). Combines real signals when available (the actual waitlist/RAC/available-seat numbers from `railway_api.get_seat_availability()`) with documented heuristics (festival/holiday season windows, weekday vs weekend, time-of-day, and reserved vs unreserved class). Every result carries a `basis` list (exactly which signals fed the score) and a `disclaimer` string the app always surfaces, so it's never mistaken for a real headcount reading. Available both through the chat's `CROWD_PREDICTION` intent and as a dedicated `POST /api/crowd/predict` endpoint (surfaced as its own form inside the 📡 Live Tracking panel), which always returns the full basis + disclaimer alongside the score — never just a bare number. |
| **Nearby Station Recommendations (Geo-Spatial)** | `nearby_stations.py` | A real haversine great-circle distance calculation from an anchor station to every other station in `station_coordinates.json`, sorted and radius-filtered — not a hardcoded per-station list. Widens to "closest N anyway" (clearly labelled) if nothing is within the requested radius, and says so plainly if the anchor station isn't in the ~50-station curated table rather than guessing its location. |
| **Alternative Route Planner (Graph Algorithms)** | `route_planner.py`, `data/rail_network_edges.json` | `railway_api.py` only knows about DIRECT trains between two stations. This module adds an actual weighted-graph algorithm on top: a curated `networkx` graph of ~50 major stations connected along their real, well-known trunk corridors (e.g. Delhi–Chennai via Jhansi–Bhopal–Nagpur–Vijayawada, the Grand Chord via Gaya–Dhanbad, the Delhi–Mumbai line via Kota–Ratlam–Vadodara), with edge weights that are real haversine distances. `shortest_simple_paths` (a genuine k-shortest-paths / Yen's-algorithm implementation) returns the top-k lowest-distance junction-hopping routes. Explicitly documented limit: this models *that a corridor exists*, not *that a specific train runs on it today* — it's a routing suggestion, not a train-number guarantee. |
| **Multi-Language Support (Hindi + Regional Languages)** | `language_support.py`, `frontend/index.html`/`app.js` | Two honest mechanisms, no canned-phrase translation table: (1) genuine Unicode-block script detection on the user's own typed text (Devanagari, Tamil, Telugu, Bengali, Kannada, Malayalam, Gurmukhi, Odia), and (2) an explicit 🌐 dropdown in the header that always overrides detection. Either way, the actual translation happens inside the same Claude synthesis call `app.py` already makes — this module only decides *which* language to ask for, it never fabricates a translation itself. The dropdown selection also drives the Web Speech API's recognition/synthesis locale, so voice input and "speak answers aloud" follow the same language choice. Without `ANTHROPIC_API_KEY` there's no local translation step to fall back on, so the templated fallback view stays in English with a note explaining why. |

The `/api/chat` response's `map` field now also accepts `nearby_stations` (anchor + radius-filtered station list) and `alternative_routes` (multiple ranked polylines through the trunk-corridor graph) payloads, and `ChatRequest` accepts an optional `language` field (`"auto"`, `"English"`, or a supported language name) from the frontend dropdown.

## Latest additions: live WebSocket tracking with a per-train chart, ML delay prediction, semantic geo-search, analytics dashboard

These ship as their own header-toolbar panels (📡 🔍 📊 in `frontend/index.html`/`app.js`), separate from the free-text chat, since each needs its own persistent connection or live-refreshing view rather than a single request/response turn.

| Feature | Files | What it does |
|---------|-------|---------------|
| **Real-Time Train Position via WebSockets** | `app.py` (`/ws/track/{train_number}`) | Streams a live position update (lat/lng, current/next station, reported delay, ML-predicted delay) to the browser every ~12s over a persistent WebSocket, instead of the frontend re-polling `/api/chat`. Reuses the exact same cached `railway_api`/`gps_tracking` calls the chat flow already makes, so multiple open tabs don't multiply provider load — they just get served the same cached response between real refreshes. Reports fetch errors over the socket honestly rather than dropping the connection silently. Accepts optional `date` (DD-MM-YYYY), `source`, `dest`, and `travel_class` query params: `date` is passed straight through to RailKit's live-status lookup, and when `source`+`dest` are both given, each tick ALSO runs a real crowd prediction (see below) for that route/date/class — computed as an independent step, so a live-status outage never also blocks the crowd score. The Live Tracking panel also renders a live-updating Chart.js line chart (actual vs ML-predicted delay) scoped to the ONE train number the user typed in, seeded from that train's real logged history this session via `GET /api/analytics/train/{train_number}` and extended with each new WebSocket update as it arrives. |
| **Train Capacity & Crowd Prediction, done properly** | `crowd_prediction.py`, `app.py` (`POST /api/crowd/predict`, folded into `/ws/track`) | The existing rule-based estimator now has a dedicated endpoint and UI panel (not just a line buried in a chat answer): pulls REAL seat-availability data from RailKit for the given train/route/date/class first, and always returns the full `basis` list plus `disclaimer` so the estimate is genuinely explained rather than just a bare number. Every travel class (SL/2S/GEN, 1A/2A/EC, and now 3A/3E/CC/FC too) gets an explicit, documented line in the explanation instead of silently being skipped. Works for any user-supplied date — the Live Tracking panel's date field is a native date picker converted to `DD-MM-YYYY` before being sent, so there's no freeform-text date-format footgun. |
| **Train Delay Prediction (ML Model)** | `delay_prediction.py` | A genuine fitted `scikit-learn` `RandomForestRegressor` — not a lookup table. No public historical Indian Railways delay dataset exists for this app to train on, so it's trained on a synthetically generated dataset built from the same kind of documented heuristics used in `crowd_prediction.py` (festival/holiday windows, peak-hour congestion, weekday/weekend, route-progress). Every real-data call site — the live-tracking WebSocket, the `LIVE_STATUS` chat intent, and `POST /api/delay/predict` — shares one helper (`app._distance_and_progress_from_route()`) that derives REAL journey distance and route-progress-so-far straight from RailKit's own `getTrainInfo` route data and the train's actual current station, plus the train's own REAL currently-reported delay (the strongest real-world predictor) when live data is available — not just the current delay figure in isolation. Every prediction returns a `confidence` level (`Low`/`Moderate`/`High`, based on how much of the input was real vs assumed) and a `basis` list spelling out exactly which inputs were real vs defaulted, plus a disclaimer that this is a planning estimate, not a guarantee — both are shown in the UI as the estimate's actual explanation, not just its number. |
| **Semantic Station Search with Geo-Coding** | `station_search.py` | Reuses the same dense-embedding/TF-IDF-SVD engine from `semantic_engine.py` (already powering KB search), built instead over a small corpus of station name + code + known city aliases — so a loosely worded query ("the big junction near bangalore", "vizag station") still resolves to the right station. Every match carries its real lat/lng straight from the curated `station_coordinates.json` table ("geo-coding" here means resolving text to those coordinates, not a call to an external geocoding API). Exposed via `POST /api/stations/search`; same ~50-station coverage honesty note as `nearby_stations.py`. |
| **Advanced Charting & Analytics Dashboard** | `analytics.py`, `frontend` (Chart.js) | Logs a small structured event for every `/api/chat` request and every live-tracking update — resolved intent, and (when produced) a real delay figure/ML prediction/crowd score — into an in-memory capped ring buffer. `GET /api/analytics/summary` aggregates this into an intent-distribution chart, an actual-vs-predicted delay trend, a crowd-score trend, and cache/error-rate stats, rendered with Chart.js in the 📊 dashboard panel. `GET /api/analytics/train/{train_number}` filters that same log down to one train, which is what powers the per-train chart inside the Live Tracking panel. Only ever charts real events from the current server process — an empty session means empty charts, never seeded/demo data. |

## What's new: the advanced RAG pipeline

The original TF-IDF retriever has been replaced with a multi-stage pipeline
(`backend/rag_engine.py` orchestrates the core six; the four newest
additions below layer on top of it and `app.py`):

| # | Feature | Module | What it does |
|---|---------|--------|---------------|
| 1 | **Semantic Search Upgrade** | `semantic_engine.py` | Dense embeddings (sentence-transformers `all-MiniLM-L6-v2`) so paraphrased questions match the right KB entry even with almost no shared keywords. Falls back to a TF-IDF + Truncated SVD (LSA) pseudo-embedding automatically if torch/sentence-transformers isn't installed — no crash, no code change needed. |
| 2 | **Hybrid Retrieval (BM25 + Semantic)** | `hybrid_retriever.py` | Runs BM25 (exact-term precision — station codes, quota codes) and semantic search in parallel, fuses the two ranked lists with Reciprocal Rank Fusion (RRF) since their raw scores aren't on comparable scales. |
| 3 | **Contextual Compression (RAG Refinement)** | `compression.py` | Each retrieved KB paragraph is split into sentences; only the sentences most relevant to the *specific* question are kept (reassembled in original order), so Claude — and the no-key fallback view — sees a tight, on-topic excerpt instead of a whole paragraph. |
| 4 | **Adaptive Retrieval (Self-RAG)** | `self_rag.py` | Before answering: decides *whether* retrieval is even needed (skips it for "hi"/"thanks"); grades whether retrieved chunks actually clear a relevance bar; if nothing does, retries once with a broadened search rather than answering ungrounded or returning nothing. |
| 5 | **Multi-Modal RAG** | `multimodal.py` | Query side: attach a photo of a ticket/SMS and Claude's vision input reads out the PNR/train number/date (never guesses a digit it can't see). Answer side: KB entries for coach classes and quota types carry a linked SVG diagram, rendered inline next to the text answer. |
| 6 | **Graph RAG** | `graph_rag.py` | A `networkx` graph built from each KB entry's tagged entities (co-occurrence = edge). A query's mentioned entities are expanded 1 hop out to pull in *related* KB entries the ranked search didn't literally match — e.g. asking about Tatkal waitlists also surfaces the chart-preparation and refund entries. |
| 7 | **User Feedback Loop (RLHF Data Collection)** | `feedback_rlhf.py` | Every `/api/chat` reply carries a `response_id`. `POST /api/feedback` records a 👍/👎 (+ optional correction) against it. `GET /api/feedback/export` shapes the log into `{prompt, chosen, rejected}` preference pairs — the standard pairwise-training data shape for reward-model / DPO-style fine-tuning. |
| 8 | **Few-Shot Learning for New Intents** | `few_shot_intents.py` | `POST /api/intents/teach` lets someone add a new question category from just a handful of example utterances — no code change, no fine-tuning. New questions are matched against those examples via the same embedding engine the RAG pipeline already builds, and only consulted when the rule-based router falls through to a generic FAQ bucket. |
| 9 | **Advanced Graph RAG (Property Graph)** | `property_graph_rag.py` | Layers a typed, directional property graph on top of the Graph RAG entity graph — nodes get a `type` (quota_type/status/process/...), edges get a curated `relation` (`upgrades_to`, `resolved_at`, `triggers`, `leads_to`, ...) instead of a generic co-occurrence weight. Returns explainable multi-hop reasoning chains (e.g. `tatkal --restricts--> refund`) surfaced in `rag_trace.reasoning_paths`. |
| 10 | **Real-Time Sentiment and Emotion Analysis** | `sentiment_analysis.py` | A lightweight lexicon/heuristic scan runs on every message (frustration, urgency, positivity, ALL-CAPS/punctuation cues) and folds a short tone instruction into the synthesis prompt — e.g. leading with one brief acknowledgment for a frustrated message instead of a generic answer. Surfaced in the response's `sentiment` field. |

The `/api/chat` response now includes a `rag_trace` object (which stages fired,
whether the search was broadened, which entities matched in the graph, the
property-graph reasoning paths, any few-shot intent match), a `sentiment`
object, a `response_id` for the feedback loop, and a `diagrams` array,
alongside the existing `answer`/`intent`/`sources` fields — useful for
debugging *why* an answer was (or wasn't) grounded.

## Architecture

```
Browser (chat UI, optional ticket-photo attachment)
      │  free-text question (+ optional image)
      ▼
FastAPI  /api/chat
      │
      ├─► multimodal.py     → (if photo attached) Claude vision reads PNR/train/date
      │
      ├─► query_router.py   → classifies intent + extracts entities
      │     (PNR / live status / seat availability / schedule / FAQ)
      │
      ├─► railway_api.py    → real-time call to the IRCTC data provider (if intent needs it)
      │
      ├─► rag_engine.py     → the 6-stage advanced RAG pipeline (always runs):
      │     self_rag (retrieve? / grade / retry)
      │       → hybrid_retriever (BM25 + semantic, RRF fusion)
      │       → graph_rag (1-hop entity expansion)
      │       → compression (trim chunks to relevant sentences)
      │       → multimodal (attach any linked diagrams)
      │
      └─► Claude (Anthropic API) → synthesizes one natural-language answer
            from live data + retrieved/compressed policy chunks + the user's
            question (falls back to a readable templated answer if no API key is set)
```

## Project structure

```
railway_rag_assistant/
├── backend/
│   ├── app.py                 FastAPI app: routing, synthesis, static file serving
│   ├── query_router.py        Intent classification + entity extraction (incl. HELP, city names, times)
│   ├── railway_api.py         Calls the railkit-service microservice (see below)
│   ├── api_cache.py           In-memory TTL cache to stretch the RailKit quota
│   ├── gps_tracking.py        Real-time GPS position + interactive route map data
│   ├── trains_between.py      Trains-between-stations parsing + time-of-day filtering
│   ├── help_content.py        Smart Help & Tutorial canned content
│   ├── rag_engine.py          Orchestrates the 6-stage advanced RAG pipeline
│   ├── semantic_engine.py     Feature 1: dense embeddings (+ LSA fallback)
│   ├── hybrid_retriever.py    Feature 2: BM25 + semantic, RRF fusion
│   ├── compression.py         Feature 3: contextual compression
│   ├── self_rag.py            Feature 4: adaptive retrieval / relevance grading
│   ├── multimodal.py          Feature 5: ticket-photo reading + diagram lookup
│   ├── graph_rag.py           Feature 6: entity graph + 1-hop expansion
│   ├── feedback_rlhf.py       Feature 7: feedback loop + RLHF preference-pair export
│   ├── few_shot_intents.py    Feature 8: teach new intents from a few example utterances
│   ├── property_graph_rag.py  Feature 9: typed/directional property graph + reasoning chains
│   ├── sentiment_analysis.py  Feature 10: real-time sentiment/emotion detection + tone hints
│   ├── nearby_stations.py     Nearby Station Recommendations: haversine geo-spatial search
│   ├── route_planner.py       Alternative Route Planner: networkx k-shortest-paths over a trunk-corridor graph
│   ├── crowd_prediction.py    Train Capacity & Crowd Prediction: rule-based demand estimate
│   ├── delay_explainability.py  Explainable AI: SHAP KernelExplainer over the delay ensemble
│   ├── crowd_position_tracking.py  Crowd-Sourced Positions: Kalman-filter fusion + clustering
│   ├── crowd_position_store.py     Crowd-Sourced Positions: SQLite report persistence + badges
│   ├── language_support.py    Multi-Language Support: script detection + Claude-side translation
│   ├── push_store.py          Push Notifications: SQLite watch/device-token persistence
│   ├── push_notifications.py  Push Notifications: Firebase Cloud Messaging send wrapper
│   ├── alert_scheduler.py     Push Notifications: background APScheduler job (every 15 min)
│   ├── data/knowledge_base.json       Railway policy/FAQ KB (20 entries, entity-tagged)
│   ├── data/station_coordinates.json  Fallback station code -> lat/lng lookup for maps
│   ├── data/city_aliases.json         City name -> station code (e.g. "hyderabad" -> SC)
│   ├── data/rail_network_edges.json   Curated trunk-corridor graph edges (station pairs + real distances)
│   ├── data/custom_intents.json       Persisted few-shot-taught intents (Feature 8)
│   ├── requirements.txt
│   └── .env.example
├── railkit-service/            Node.js microservice wrapping the official railkit SDK
│   ├── server.js               REST endpoints: /pnr, /track, /train-info, /search,
│   │                           /availability, /fare, /live-station, /history
│   ├── package.json
│   └── .env.example             Set RAILKIT_API_KEY here
├── frontend/
│   ├── index.html             Departure-board styled chat UI (photo, mic, help, tour, maps)
│   ├── style.css
│   ├── app.js                 Chat, Leaflet maps, voice I/O, help modal, onboarding tour
│   ├── firebase-messaging-sw.js  Push Notifications: service worker for background delivery
│   └── assets/diagrams/       SVG diagrams served for multi-modal answers
└── README.md
```

## Running it

Two processes now (see the honest note above for why): the RailKit
microservice, and the FastAPI app.

```bash
# Terminal 1 - RailKit microservice (real data provider)
cd railkit-service
npm install
cp .env.example .env        # set RAILKIT_API_KEY
npm start                   # http://127.0.0.1:4001

# Terminal 2 - FastAPI backend + frontend
cd backend
python3 -m venv venv && source venv/bin/activate      # optional but recommended
pip install -r requirements.txt
cp .env.example .env        # RAILKIT_SERVICE_URL defaults correctly; add ANTHROPIC_API_KEY if you have one
uvicorn app:app --reload --port 8000
```

Open **http://localhost:8000** in a browser — it's a real website, not a console app.
The frontend is served directly by FastAPI, so there's nothing else to run.
The FastAPI app works fine even if the microservice isn't running yet — it
just returns a clear "can't reach the data provider" error for anything
needing live data, and still answers policy/FAQ questions via RAG.

If you skip the `sentence-transformers`/`torch` install (they're the heaviest
dependencies here), the app still runs — `semantic_engine.py` detects the
missing import at startup and transparently uses its TF-IDF/SVD fallback
instead, with no configuration needed.

## Sharing links publicly (Share Tracking Link / Share Trip Recap)

Live Tracking's "Share link" and "Share this trip recap" buttons (web and
mobile) build a URL from whatever address the app is currently pointed
at. If you're running the backend with `uvicorn app:app --reload --port
8000` on your own laptop, that address is `http://localhost:8000` (web)
or whatever you've set as the API Base URL in the mobile app's Settings
tab (`http://localhost:8000` / `http://10.0.2.2:8000` for the Android
emulator / your LAN IP like `http://192.168.1.23:8000` for a physical
phone, per `mobile-app/src/config/index.js`). **All of these only resolve
on your own device or your own WiFi network** — a friend or family
member on a different network gets "can't reach this site," not because
the feature is broken, but because the link points at a private address
that the wider internet has no route to. Both apps now detect this and
show an in-app warning (⚠️ "local address") right after you generate a
link, specifically so this doesn't look like a bug.

There's no code fix for this — it's a hosting question. Two options:

**Quick, free, no signup (good for testing / sharing with one person right now):**
a tunnel exposes your already-running local server at a real public HTTPS
URL for as long as the tunnel stays open.

```bash
# Make sure the backend is listening on 0.0.0.0, not just localhost,
# so the tunnel can actually reach it:
uvicorn app:app --reload --port 8000 --host 0.0.0.0

# In another terminal, either of these works (pick one):
cloudflared tunnel --url http://localhost:8000   # no account needed
# or
ngrok http 8000                                  # free account needed
```

Either command prints a public URL like `https://random-words.trycloudflare.com`
or `https://random-id.ngrok-free.app`. Then:
- **Web**: open the app itself through that public URL in your own
  browser (not `localhost:8000`) before clicking "Share link" — the link
  it builds reflects whatever address is in your browser's address bar.
- **Mobile**: Settings tab → set API Base URL to that public `https://...`
  URL (the WebSocket URL derives from it automatically — `https` becomes
  `wss`). "Share link" and "Share trip recap" will now build public URLs.

The link stops working the moment you close the tunnel or your laptop
sleeps, and a free Cloudflare quick tunnel gets a **new** random URL every
time you restart it (any link you already shared breaks) — fine for a
one-off "here's my train, come pick me up" share, not for anything you
want to keep working long-term.

**Permanent (a link that always works, even with your laptop off):** a
tunnel only forwards to a process running on YOUR machine — turn the
laptop off and there's nothing left to forward to, tunnel or no tunnel.
The only way around that is deploying the backend to a server that isn't
your laptop, one that stays on 24/7. That's what this next section walks
through.

## Deploying it permanently (Render)

This repo includes a `render.yaml` Blueprint that deploys both backend
processes — the RailKit microservice and the FastAPI app — as two
always-on Render web services from one repo, so the resulting link works
whether your own computer is on, asleep, or off.

**0. Prerequisite — get the code onto GitHub.** Render deploys from a git
repository, not a zip upload. If this project isn't already a GitHub repo:

```bash
cd railway_app
git init
git add .
git commit -m "Initial commit"
```

Then create a new (can be private) repository on GitHub and push:

```bash
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

The included `.gitignore` already keeps your real `.env` files, `node_modules`,
`venv`, and SQLite database files out of the repo — your API keys never
leave your machine this way; you'll re-enter them directly into Render's
dashboard in step 2.

**1. Create the two services.** Sign up free at render.com, then
**New +** → **Blueprint**, connect the GitHub repo you just pushed, and
Render will read `render.yaml` and propose two services:
`railkit-service` and `railway-rag-backend`.

**2. Fill in environment variables.** Render will prompt you for every
variable marked `sync: false` in `render.yaml` — for each service, copy
the matching values from your local `railkit-service/.env` and
`backend/.env` files into Render's dashboard fields. Leave
`RAILKIT_SERVICE_URL` and `PUBLIC_APP_URL` blank for now — that's step 4.

For `FIREBASE_SERVICE_ACCOUNT_JSON` specifically: this points to a
credentials *file*, which doesn't exist on Render unless you upload it —
use the backend service's **Environment → Secret Files** tab to upload
your `firebase-service-account.json`, note the path Render shows for it
(typically `/etc/secrets/<filename>`), and set the env var to that path,
not your local machine's path.

**3. Deploy and wait.** Render builds and starts both services (a few
minutes each, mostly for `railkit-service` — the backend's build uses
`requirements-render.txt`, a trimmed dependency list that skips
`sentence-transformers`/`torch` so it fits the free tier's 512MB RAM; see
that file's header comment — every feature still works via the app's
existing TF-IDF fallback). Each service gets its own `https://*.onrender.com` URL.

**4. Wire the two services together.** Once `railkit-service` is live,
copy its URL from its Render dashboard page, and paste it into
`railway-rag-backend`'s `RAILKIT_SERVICE_URL` environment variable (as
`https://railkit-service-xxxx.onrender.com`, no trailing slash) — then do
the same for `PUBLIC_APP_URL`, pointing it at the backend's own URL.
Saving either variable triggers a redeploy of that service.

**5. Use the new URL everywhere.** `railway-rag-backend`'s
`https://*.onrender.com` URL is now your app's permanent home — open it
directly (nothing else to run, no tunnel, no terminal windows to keep
open) for the web app, and set it as the mobile app's Settings → API Base
URL. "Share link" and "Share trip recap" now build links that work for
anyone, anytime, laptop on or off.

**Two honest tradeoffs of Render's free tier**, so neither looks like a
bug later: a free web service spins down after ~15 minutes with no
traffic, so the *first* request after a quiet spell can take 30-50
seconds to wake it back up (a paid instance type removes this); and its
disk is ephemeral, so SQLite-stored state (push tokens, alarm watches,
coach-crowd reports, saved trip summaries) resets on every redeploy or
restart — fine for a demo/portfolio use, worth a paid persistent disk
(Render's "Disks" add-on) if you need that data to survive indefinitely.
Railway and Fly.io are viable alternatives with similar steps if you'd
rather use one of those instead.

There's no `CORSMiddleware` configured in `app.py` — not needed for
same-origin requests from the served frontend or the mobile app's direct
HTTP/WebSocket calls, but add one (`from fastapi.middleware.cors import
CORSMiddleware`) if you later put a *separately hosted* frontend on its
own domain calling this API.

## Setting up Push Notifications (optional)

The Delay Alerts tab now supports real background push, on top of the
in-app checking it already did. This needs a free Firebase project — the
app runs fine without one, it just skips actual push delivery (see the
honest startup log line: `Push notifications configured: False`).

1. **Create a Firebase project** at console.firebase.google.com (free).
2. **Backend credential** — Project Settings → Service Accounts →
   "Generate new private key". Save the JSON file *outside* this repo
   and set its absolute path as `FIREBASE_SERVICE_ACCOUNT_JSON` in
   `backend/.env`.
3. **Frontend config** — Project Settings → General → "Your apps" → add
   a Web app → copy the `firebaseConfig` object into **both**
   `frontend/app.js` (the `FIREBASE_CONFIG` constant near
   `enablePushNotifications`) and `frontend/firebase-messaging-sw.js`
   (same object, `firebase.initializeApp(...)`). This config is not a
   secret — it's fine for it to be visible in browser code.
4. **VAPID key** — Project Settings → Cloud Messaging → "Web Push
   certificates" → generate a key pair. Paste it into
   `FIREBASE_VAPID_KEY` in `frontend/app.js`.
5. `pip install -r requirements.txt` again to pick up `firebase-admin`
   and `APScheduler`.
6. Restart the backend, open the Delay Alerts tab, add a watch, click
   **"Enable push notifications for these watches"**, and accept the
   browser's notification permission prompt.

The background check runs every `ALERT_CHECK_INTERVAL_MINUTES` (default
15, set in `backend/.env`) via `alert_scheduler.py` — see that file's
docstring for the one real limitation worth knowing: this only fires
while the backend **process** stays running, so it needs an always-on
host (a VM or an always-on container), not a scale-to-zero/serverless one.

## Try asking

- "What's the status of PNR 2415678901?" → live data (needs `RAPIDAPI_KEY`)
- "Is train 12951 running late today?" → live running status
- "Seat availability on 12951 from NDLS to BCT on 15-08-2026 in 3A" → live seat check
- "What happens if my Tatkal ticket is still waitlisted after the chart is prepared?" → graph-expanded RAG (pulls in chart-preparation + refund entries too)
- "What's the difference between RAC and waitlist?" → RAG/FAQ
- "Stations near NDLS within 200 km" → geo-spatial nearby-station search
- "Alternative route from NDLS to MAS" → graph-based k-shortest-paths through the trunk-corridor network
- "How crowded will train 12951 be from NDLS to BCT on 15-08-2026 in SL?" → rule-based crowd estimate (booking data + heuristics)
- Ask a question in Hindi/Tamil/etc., or pick a language from the 🌐 dropdown → reply comes back in that language
- Attach a photo of a ticket instead of typing the PNR → multi-modal read

## Extending it

- **More knowledge**: add entries to `backend/data/knowledge_base.json`, including an `entities` list (for Graph RAG) and optionally a `diagram` filename (for multi-modal answers) — no retraining needed, all indexes rebuild from the JSON file on startup.
- **Tune fusion weights**: `hybrid_retriever.py`'s `rrf_k` constant controls how sharply top-ranked results dominate the fusion.
- **Tune adaptiveness**: `self_rag.py`'s `initial_floor`/`broadened_floor` control how strict the relevance bar is before a broadened retry kicks in.
- **More live intents**: add a new `Intent` in `query_router.py`, a matching method in `railway_api.py`, and a branch in `app.py`'s `chat()` handler.
- **Auth / rate limiting**: not included — add before exposing this publicly, since the railway data provider and Anthropic calls both cost quota per request.
#   r a i l w a y - r a g - a s s i s t a n t  
 