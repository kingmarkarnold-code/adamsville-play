# Release release-2026.11.07.23

Pushed 2026-11-07 22:57 UTC.

## Versions
- ui_version: 2026.11.07.22 -> 2026.11.07.23

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- body_systems.js (size 35173 -> 35885)
- crashlog.js (size 42233 -> 41821)
- crash_model.js (size 14030 -> 14309)
- daycycle.js (size 21011 -> 21675)
- hud_move.js (size 55281 -> 76975)
- index.html (size 1269653 -> 1269717)

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
