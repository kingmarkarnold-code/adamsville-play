# Release release-2026.11.07.9

Pushed 2026-11-07 19:48 UTC.

## Versions
- ui_version: 2026.11.07.8 -> 2026.11.07.9

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- ambient_audio.js (size 40089 -> 46990)
- engine_sounds.js (size 22821 -> 23529)
- hud_move.js (size 55250 -> 55281)
- index.html (size 1240275 -> 1248362)
- pause_system.js (size 10784 -> 10806)
- ui_sounds.js (size 8332 -> 9023)

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
