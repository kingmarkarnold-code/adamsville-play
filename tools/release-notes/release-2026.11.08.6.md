# Release release-2026.11.08.6

Pushed 2026-11-08 16:00 UTC.

## Versions
- ui_version: 2026.11.08.5 -> 2026.11.08.6
- map_version: 2026.11.07.3 -> 2026.11.08.1

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- dive_system.js (size 33099 -> 33363)
- index.html (size 1280448 -> 1280541)
- map_loader.js (size 73845 -> 74250)
- map_registry.js (size 23620 -> 27117)
- maps/adamsville/terrain_heights_pkg.bin (sha256 changed)

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
