# Release release-2026.11.08.10

Pushed 2026-11-08 20:16 UTC.

## Versions
- ui_version: 2026.11.08.9 -> 2026.11.08.10

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- golden_roses.js (size 40851 -> 46365)
- hud_move.js (size 76975 -> 77008)
- index.html (size 1303160 -> 1308475)
- pause_system.js (size 14210 -> 15565)
- ui_layout.json (size 172576 -> 181410)
- ui_layout_apply.js (size 36542 -> 38724)
- wildlife_system.js (size 115705 -> 118965)
- app.webmanifest (size 1 -> 370)
- sw.js (size 1 -> 917)
- icon-512.png (size 1 -> 312617)

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
