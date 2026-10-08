# Changelog
Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

## [1.5.0] - 2026-10-08
### Added
- **Hands-free mode (mobile app).** Settings -> Hands-free mode: each screen asks for its fields out loud, listens, fills them and carries on. Live Tracking asks the train number, the date and (optionally) where you get off, then starts tracking by itself. The same flow is on Train Search (from, to, date), Live Status, Fare, Seat Availability, Time Table, PNR, Station Search and the Assistant chat; the Home screen opens any section when you say its name ("live tracking", "PNR status" ...). Say "skip", "repeat" or "stop" at any prompt. With the setting off, a "Hands-free" chip on each screen starts the same flow on demand.
- **Mic on every field.** Train number, station, date, PNR, time and number boxes all have a mic; the answer is understood, not just pasted: "one two six five one" or "twelve six five one" -> 12651; "28th aug 2025" -> 28-08-2025; "27th aug" (no year) -> 27-08-<this year>; "today / tomorrow / yesterday / day after tomorrow", "twenty eighth of august twenty twenty five" and "28/08" also work. A spoken station like "s c" becomes SC; a name goes through the normal station suggestions.
- Checks for the spoken-input parser: `mobile-app/tests/voice-parse.test.cjs`.
### Notes
- On the phone, speech recognition needs the `expo-speech-recognition` native module (added to `package.json`/`app.json`), so build a new dev/installed app (`eas build`); Expo Go cannot do it. On the web build it uses the browser's own speech recognition (Chrome/Edge).

## [1.4.2] - 2026-10-06
### Changed
- **GPS mode only when you are on the train.** The first GPS reading after switching to GPS must pass the on-train check, otherwise GPS is refused at once with "You are not inside train N. GPS mode works only for the train you are travelling in — please switch to Internet." and the screen goes back to the internet feed. Two tests now: position (the phone must be within ~10 km of where the live feed puts the train, widening only as the feed gets old — was 20 km) and movement (a phone that is not moving while the train is running at 40+ km/h, e.g. someone on a platform or at home, is rejected). Once verified, two failing readings in a row switch GPS off. When there is no live feed to compare with (offline), GPS is still allowed since it cannot be checked.
- Checks for the verdict logic: `mobile-app/tests/gps-verdict.test.cjs`.

## [1.4.1] - 2026-10-05
### Fixed
- **"Trip complete" shown mid-journey:** the server sent the destination's PREDICTED arrival as the real `destination_actual_arrival`, so the end-of-trip card appeared while the train was still running. Only a real recorded arrival is sent now. Regression test added.
- **Journey card destination row:** the "Your stop" tag overlapped the scheduled departure time on narrow screens; it now sits under the station name.
### Docs
- `docs/LIVE_TRACKING_PIPELINE.md`: step 7 already exists (`delay_accuracy_store.py`).
- Both bugs were found by running the real app locally against synthetic provider data (not live data).

## [1.4.0] - 2026-10-05
### Added
- **Live-tracking pipeline, step 4 (`backend/timeline_validation.py`):** provider "actual" times are now checked before anything treats them as real, with day-aware logic for long multi-day trains (e.g. 12295) where the same HH:MM occurs on day 1, 2 and 3. A reading is rejected only when provably impossible (ahead of the clock, a stop scheduled hours from now, or earlier than the previous stop's reading); RailRadar entries get the same checks. 8 new tests. The full workflow and remaining steps are in `docs/LIVE_TRACKING_PIPELINE.md`.

## [1.3.4] - 2026-10-05
### Fixed
- **Day pill:** "Day 2" now starts only after a stop's scheduled time wraps past 23:59 (20834 Visakhapatnam, ETA 23:30, wrongly showed Day 2). Day numbers are worked out from the scheduled times along the route instead of the provider's per-stop day field.
- **Timeline ETD:** for stops not yet reached, the departure column shows ETA + halt (Samalkot ETA 21:43, halt 2 min → ETD 21:45). The provider's own predicted departure no longer overrides it.

## [1.3.3] - 2026-10-05
### Fixed
- **ETD now follows the halt time:** for a stop the train hasn't left yet, ETD = ETA + halt (Vijayawada: ETA 19:00 + 5 min halt = ETD 19:05) on the Journey card and the running-status timeline. The server also parses halt values like "5 min" so predicted departure is no longer stuck equal to arrival.

## [1.3.2] - 2026-10-05
### Fixed
- **Live Tracking destination showed a false large delay** (20834 Visakhapatnam: "~1 hr late, confirmed via RailRadar" while the train was still near Secunderabad; the day before it had arrived 11 min early). RailRadar can return an undated "actual" for a far-ahead stop (a projection or the previous run's record), which was accepted as a real arrival and then locked in for the rest of the journey. It is now ignored when the time is ahead of the clock or the stop is more than 150 km ahead of the train. Regression test added.

## [1.3.1] - 2026-10-04
### Changed
- **Seat Availability:** after a train number is entered, the From and To boxes list that train's reporting (halting) stations as soon as they are tapped, and filter while typing; other stations can still be searched. The date is picked from a calendar instead of typed.

## [1.3.0] - 2026-10-04
### Added
- **Native Android build ready:** default API address now points at the deployed backend (`wss://` for the live socket), the Google Maps key is injected from the `GOOGLE_MAPS_API_KEY` build environment variable via `mobile-app/app.config.js` (no key in the repo), and the README documents `eas build -p android --profile preview`.
- **Book on IRCTC (native app):** launches the installed IRCTC Rail Connect app by package name (`expo-intent-launcher`), with its Play Store page as the fallback when it isn't installed. The web version is unchanged.

## [1.2.5] - 2026-10-04
### Fixed
- **Book on IRCTC:** phone detection now also works when Chrome is in "Desktop site" mode, so Android phones always launch the Rail Connect app. On a computer (where an Android app can't open) it now asks before opening the IRCTC website instead of silently opening it.

## [1.2.4] - 2026-10-04
### Fixed
- **Book on IRCTC / Book Now** now launches the installed IRCTC Rail Connect app on Android (a plain app launch, with the Play Store page as fallback if it isn't installed — never the desktop site); on iOS it uses the IRCTC link. Previously the web build only opened a new browser tab.

## [1.2.3] - 2026-10-04
### Changed
- **Seat Availability:** the train number box now has the same suggestion dropdown as Live Tracking (and fills From/To when empty). The result card has a "Book Now on IRCTC" button, enabled only when seats are available/RAC or waitlisted.
- **Booking hand-off:** "Book Now" and "Book on IRCTC" (Search Trains) open the IRCTC app directly on Android (falling back to the website), and the site on web/iOS. The trip summary is copied to the clipboard first, since IRCTC can't be prefilled from a link. The old pop-up that never showed on web is gone.
- Rebuilt `mobile_web/`.

## [1.2.2] - 2026-10-04
### Changed
- **Live Tracking Journey:** each row shows scheduled arrival + ETA on the left and scheduled departure + ETD on the right, plus the halt time. ETD is now ETA + halt, so it can no longer fall before the ETA.
- **Running status timeline:** every reporting station shows its halt time, ETA (left), ETD (right) and an ⓘ button (why delayed, then details).
- Rebuilt `mobile_web/`.

## [1.2.1] - 2026-10-04
### Added
- **Live Tracking:** ETA / ETD beside the alarm and ride icons on Journey rows; halt time and predicted arrival/departure in the "+N No-Halt stations" list, with an ⓘ button (why delayed, then details).
- Rebuilt `mobile_web/` with these changes.

## [1.2.0] - 2026-10-01
### Changed
- **Live Tracking redesign:** blue hero header (train number and name, route ends with times, journey progress bar with km covered/left), a "Right now" card (position, delay chip, speed / next-halt ETA / halts-to-go tiles, source and Report inaccuracy) and a "Journey timeline" heading with "Jump to train".
- **Main page is clean:** after Stop (or "Change"), only the "Track a train" page shows. The "Next:" bar, GPS card, banners, tiles and timeline of the previous train are hidden. They stay mounted while the form is open so GPS/map state isn't lost.
- Rebuilt `mobile_web/` (served at `/mobile-app`) with the new screen.

## [1.1.0] - 2026-10-01
### Changed
- **Routing:** cue-based rules for train-number questions (live/seat/schedule/crowd), route questions without the exact phrases, "stations near X", "backup options" for alternative routes, and a policy gate so refund/cancel/rules questions containing "delay", "route" or "how do I" go to the knowledge base. Unseen-data accuracy 56.4% -> 76.9% (39 blind queries).
- **Fixed:** "helpline" matched the app-help keyword "help", so "what is the railway helpline number" returned the tutorial instead of 139.
- **Fixed:** ordinary words ("carry", "coach") were extracted as station codes.
- Added 12 city aliases (Varanasi, Mangalore, Gorakhpur, Dehradun, Haridwar, Jammu, Mysore, Rajkot, Warangal and alternate spellings).
- **Compression:** sentence selection now blends semantic score with exact word overlap and boosts number-bearing sentences on quantity questions. Required facts reaching the LLM 80.0% -> 86.7%; answers containing every fact 83.3% -> 90.0% (offline path).
### Added
- `backend/evaluation/answer_eval.py`: evaluation of generated answers (fact recall, unsupported numbers, decline and honesty checks, optional LLM judge, works against the deployed app with `--url`). CI gate `answer_thresholds.json`.
- Blind routing set, held-out, validation and regression routing sets.
### Known gaps (measured, not fixed)
- The offline answer path does not decline off-topic questions (0 of 6): it returns unrelated railway text.

## [1.0.2] - 2026-10-01
### Fixed
- A web search that failed soft (empty result) was cached for 15 minutes, blocking good results for that question. Empty results are no longer cached (`cached(..., skip_empty=True)`).

## [1.0.1] - 2026-10-01
### Added
- Per-request step timings: the JSON access-log line for a slow request now names the intent and how long each outside call took (`railkit`, `rapidapi`, `railradar`, `web_search`, `gemini`, `claude`, `agent`, `rag_retrieve`). The same steps are aggregated (count, errors, p50/p95/max) in `/api/metrics` and `/metrics`.
- Production chat requests were observed taking about 9 s; this makes the cause visible.

## [1.0.0] - 2026-10-01
First versioned release. Baseline of everything on `main` plus release, monitoring and measurement tooling.

### Added
- `VERSION`, `/api/version`, `/healthz`, and `X-App-Version` / `X-App-Commit` / `X-Request-ID` headers so the running build is verifiable.
- `/api/metrics` and `/metrics`: per-route request counts, error rates, p50/p95/p99 latency, chat-intent counters; JSON access log.
- GitHub Actions: CI (tests + evaluation gate), Release (tag checks + notes), Production monitor (every 15 min).
- `tools/verify_deploy.py`: post-deploy stale-code / health / latency check.
- `backend/evaluation/`: labelled intent and retrieval sets, accuracy + latency harness, thresholds; report in `docs/EVAL_REPORT.md`.
- Tests for observability, version identity and regression guards.
- `docs/RELEASING.md`, `docs/OPERATIONS.md`, `docs/EVALUATION.md`.

### Changed
- `render.yaml`: deploy only from `main`, only after CI passes; health check on `/healthz`.
- 37 historical `.patch` files moved from the repo root to `docs/patch-archive/` (already applied; CI now rejects new loose patches).
