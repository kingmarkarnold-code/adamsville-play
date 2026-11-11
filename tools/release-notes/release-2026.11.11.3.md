# Release release-2026.11.11.3

Pushed 2026-11-11 23:48 UTC.

## Versions
- ui_version: 2026.11.11.2 -> 2026.11.11.3

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- body_systems.js (size 37094 -> 37837)
- dive_system.js (size 44261 -> 44833)
- daycycle.js (size 28435 -> 31605)
- golden_roses.js (size 46868 -> 47067)
- hud_move.js (size 88031 -> 89227)
- index.html (size 1369704 -> 1374792)
- pause_system.js (size 15565 -> 16733)
- poi_map.js (size 12273 -> 13284)
- ui_layout.json (size 181410 -> 165570)

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
