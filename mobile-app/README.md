# Railway RAG Assistant — Mobile App (React Native / Expo)

Companion mobile app for the existing FastAPI railway assistant backend
(`railway_rag_assistant/backend`). Talks to your own server — nothing is
bundled or hardcoded to a hosted service.

## Screens

| Tab | What it does | Backend endpoint(s) |
|---|---|---|
| **Chat** | Ask PNR/live-status/policy questions, attach a ticket photo, pick a language. Every assistant reply gets a 👍/👎 feedback bar. | `POST /api/chat`, `POST /api/feedback` |
| **Track** | Live GPS position on a map, stop-by-stop IRCTC-style timeline, delay + crowd prediction, streamed in real time, plus an **"Ask about this train"** box (web search + semantic RAG, with a mic button) and expected-vs-actual arrival at the next stop and at the destination. | `WS /ws/track/{train_number}`, `POST /api/chat` |
| **Tools** | Station search, standalone delay prediction, standalone crowd prediction. | `POST /api/stations/search`, `POST /api/delay/predict`, `POST /api/crowd/predict` |
| **Analytics** | Session activity, intent distribution, delay chart, **and the RLHF feedback dashboard** (thumbs up/down counts, approval rate, corrections collected). | `GET /api/analytics/summary`, `GET /api/feedback/stats` |
| **Settings** | Configure and test the backend base URL at runtime — no rebuild needed. | `GET /api/health` |

## The RLHF feedback loop

Every `/api/chat` response includes a `response_id`. The **FeedbackBar**
component under each assistant bubble in Chat sends that id back via
`POST /api/feedback` with `rating: "up" | "down"` and, on a thumbs-down, an
optional free-text **correction** ("what should it have said?"). This is
exactly what `backend/feedback_rlhf.py` logs and later shapes into
`(prompt, chosen, rejected)` preference pairs via
`GET /api/feedback/export` — so rating replies in the app is a real,
functioning human-feedback signal, not a decorative UI element. The
Analytics tab surfaces the aggregate stats (`GET /api/feedback/stats`) so
you can see the loop working end-to-end.

## Live Tracking: passenger Q&A + voice input

The Track tab's "Ask about this train" box sends whatever you type (or
say) to `POST /api/chat` along with the train number already in the
tracking form (`train_number`), so you can ask things like "why might it
be delayed today?" without retyping the train number. The backend answers
using the same semantic/hybrid RAG pipeline as the Chat tab, PLUS a live
web search (`backend/web_search.py`, no API key needed) for anything the
fixed knowledge base and live provider data don't cover — the reply lists
which web sources it used, if any.

**Voice input (mic button):**
- **On web** (`expo start --web`), it uses the browser's built-in
  SpeechRecognition API — works immediately in Chrome/Edge, no setup.
- **On native (Expo Go)**, real on-device speech-to-text needs a native
  module that Expo Go doesn't bundle. Tapping the mic in Expo Go shows an
  explanation instead of silently failing. To enable it for real:
  1. `npx expo install expo-speech-recognition`
  2. Add its config plugin to `app.json` (see that package's docs)
  3. Build a custom dev client: `eas build --profile development`
  4. Run the app from that dev build instead of Expo Go

  Typing always works as a fallback either way.

## Prerequisites

- Node.js 18+
- **Expo Go SDK 54** on your phone (this project targets Expo SDK 54 — if
  your Expo Go app shows a different SDK version, either update Expo Go
  from the App/Play Store, or run `npx expo install --fix` after adjusting
  `expo` in `package.json` to match your installed Expo Go version)
- The FastAPI backend running and reachable from your phone/emulator (see
  below)
- Expo Go app on a physical phone, **or** an iOS Simulator / Android
  Emulator

## Setup

```bash
cd mobile-app
npm install
npx expo start
```

Then press `i` (iOS simulator), `a` (Android emulator), or scan the QR
code with Expo Go on your phone.

## Pointing the app at your backend

Start the FastAPI server so it's reachable on your network, not just
`localhost`:

```bash
cd railway_rag_assistant/backend
uvicorn app:app --host 0.0.0.0 --port 8000
```

Then in the app's **Settings** tab, set the base URL:

| Where the app runs | Base URL |
|---|---|
| iOS Simulator | `http://localhost:8000` |
| Android Emulator | `http://10.0.2.2:8000` |
| Physical phone (Expo Go, same Wi-Fi) | `http://<your-computer's-LAN-IP>:8000` |

Tap **Test connection** — it calls `GET /api/health` and shows the
semantic engine + knowledge-base size if reachable. Tap **Save** to
persist it (stored via `AsyncStorage`, survives app restarts). The Live
Tracking WebSocket URL is derived automatically from the same base URL
(`http…` → `ws…`).

## Maps (Live Tracking tab)

Uses `react-native-maps`. On a bare/EAS build for Android you'll need a
Google Maps API key in `app.json` under
`expo.android.config.googleMaps.apiKey` (a placeholder is already there —
replace it with your own key from the Google Cloud Console, "Maps SDK for
Android"). iOS uses Apple Maps by default and needs no key. In Expo Go,
maps work out of the box on both platforms for development.

## Project structure

```
mobile-app/
  App.js                        # navigation root
  src/
    api/
      client.js                 # axios instance + error formatting
      railwayApi.js              # one function per backend endpoint
    context/
      SettingsContext.js         # persisted backend URL + language
    components/
      ChatBubble.js
      FeedbackBar.js              # RLHF thumbs up/down + correction box
      SectionCard.js
      LabeledInput.js
      PrimaryButton.js
    screens/
      ChatScreen.js
      LiveTrackingScreen.js
      ToolsScreen.js              # segmented: Stations / Delay / Crowd
      StationSearchScreen.js
      DelayPredictScreen.js
      CrowdPredictScreen.js
      AnalyticsScreen.js
      SettingsScreen.js
    theme/
      colors.js
    config/
      index.js
```

## Known limitations / next steps

- Analytics and feedback stats are **in-memory on the backend** (reset on
  server restart) — the app just reflects whatever the server currently
  holds, by design (matches `backend/analytics.py` and
  `backend/feedback_rlhf.py`).
- Push notifications for delay alerts aren't implemented — the Track tab
  is pull/stream-based (WebSocket) while the app is open.
- `few-shot intent teaching` (`/api/intents/teach`) has a working API
  helper in `src/api/railwayApi.js` but no dedicated screen yet; wire it
  into a new "Teach" screen if you want that in-app.
