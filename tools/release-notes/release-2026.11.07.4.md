# Release release-2026.11.07.4

Pushed 2026-11-07 18:39 UTC.

## Versions
- ui_version: 2026.11.07.3 -> 2026.11.07.4
- map_version: 2026.11.07.1 -> 2026.11.07.2

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- index.html (size 1224734 -> 1229704)
- map_loader.js (size 67528 -> 68245)
- maps/adamsville/zone.json (size 10331 -> 11819)
- maps/adamsville/structures.json (size 15696 -> 14607)
- maps/adamsville/water.json (size 952780 -> 915819)

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
