# Changelog
Format: [Keep a Changelog](https://keepachangelog.com). Versioning: [SemVer](https://semver.org).

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
