# Release release-2026.10.26.3

Pushed 2026-10-26 12:15 UTC.

## Versions
- ui_version: 2026.10.26.2 -> 2026.10.26.3

## Changes
- Phone HUD layout fix (Joshua's report): the layout pass now FITS the measured visible screen - every control clamped on-screen and separated so nothing stacks (the pedals/steering included); the old CSS position pins that fought the layout are removed; the worker-housing button joined the layout; Stats reports now name the device's real screen size and the layout it picked; the Agent Reports icon moved off the main screen into Administrator > Agent Reports.

## Files changed
- agentdock.js (size 5200 -> 7588)
- github_reports.js (size 43380 -> 44638)
- index.html (size 1101996 -> 1100605)
- ui_layout.json (size 165772 -> 172576)
- ui_layout_apply.js (size 20033 -> 36542)
- workerhousing.js (size 37574 -> 38527)

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
