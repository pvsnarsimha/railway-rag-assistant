# Monitoring & testing

## Tests
```
pip install -r backend/requirements-render.txt pytest
python -m pytest backend/tests -q            # unit + API + regression tests (no API keys/network)
python backend/evaluation/run_eval.py --check # accuracy + latency gate, writes docs/EVAL_REPORT.md
```
Both run on every PR and on `main` (`.github/workflows/ci.yml`). Provider calls (RailKit, RailRadar,
Gemini, Claude) are faked or disabled, so CI is deterministic and free.

## What is monitored

| Signal | Where | Notes |
|---|---|---|
| Liveness | `GET /healthz` | cheap, no I/O; Render health check + uptime monitor |
| Running build | `GET /api/version`, `X-App-Commit` header | detects stale deploys |
| Diagnostics | `GET /api/health` | keys loaded, KB size, delay-model status |
| Request rate / errors / latency | `GET /api/metrics` (JSON), `GET /metrics` (Prometheus) | per route template; p50/p95/p99 over last 1000 requests per route |
| Chat intent mix | `app_counter{name="chat_intent.*"}` in `/metrics` | spot routing shifts / odd traffic |
| Structured access log | logger `access`, one JSON line per request with `rid`, `route`, `status`, `ms`, `slow` | `X-Request-ID` ties client reports to log lines |
| Synthetic check | `.github/workflows/monitor.yml`, every 15 min | health + version + real chat answer + latency + 5xx rate |

Limits to know: metrics are in-process (reset on restart, per-worker). For history, point Prometheus/Grafana
Cloud (or Better Stack/UptimeRobot for the `/healthz` ping) at `/metrics`. GitHub scheduled workflows can
lag several minutes and are disabled after 60 days of repo inactivity.

## Suggested alerts
- `/healthz` fails 2 checks in a row
- `error_rate_5xx` > 5%
- p95 of `POST /api/chat` > 5 s
- live `commit` != last merged `main` commit 10 minutes after a merge
