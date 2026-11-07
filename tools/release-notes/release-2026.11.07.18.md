# Release release-2026.11.07.18

Pushed 2026-11-07 21:43 UTC.

## Versions
- ui_version: 2026.11.07.17 -> 2026.11.07.18

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- ambient_audio.js (size 47919 -> 48265)
- engine_sounds.js (size 23529 -> 23929)
- gps_system.js (size 128313 -> 128855)
- index.html (size 1262373 -> 1266798)
- interior_system.js (size 42021 -> 42725)
- npc_system.js (size 98763 -> 98891)
- pause_system.js (size 10806 -> 12702)
- ui_sounds.js (size 9023 -> 9565)
- ui_update_flow.js (size 40911 -> 43161)

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
