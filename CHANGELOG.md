# Changelog
Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

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
