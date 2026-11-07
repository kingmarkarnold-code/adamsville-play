# Release release-2026.11.07.8

Pushed 2026-11-07 19:37 UTC.

## Versions
- ui_version: 2026.11.07.7 -> 2026.11.07.8

## Changes
- THE FUNNEL (Joshua's design): one rate-limited queue for background world-building — 2.5 ms of job work per frame, jobs sliced at anchor granularity, so bursts can no longer freeze movement on the laptop. Tree tiles are now funnel jobs (same trees, same placement verdicts — proven identical in the harness); anchor water/grass verdicts cached per anchor (60 s TTL); frame-hitch histogram (frames >50/>100/>250 ms) added to report telemetry, form unchanged.

## Files changed
- github_reports.js (size 59451 -> 59903)
- index.html (size 1228471 -> 1240275)
- perf_budget.js (size 18120 -> 19959)

## QA gates
- release lock: PASS
- cooldown: PASS
- remote HEAD readable: PASS
- inventory gate: PASS
- node --check: PASS
- smoke test: PASS
- manifest hashes regenerated: PASS
- www generator + --check: PASS
- remote HEAD stable: PASS

GitHub Pages CDN lags ~10 min; hard-refresh to verify.
