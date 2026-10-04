# Changelog
Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

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
