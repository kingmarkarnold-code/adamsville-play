# Release release-2026.11.08.7

Pushed 2026-11-08 16:29 UTC.

## Versions
- ui_version: 2026.11.08.6 -> 2026.11.08.7
- map_version: 2026.11.08.1 -> 2026.11.08.2

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- dive_system.js (size 33363 -> 35934)
- maps/adamsville/zone.json (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part00 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part01 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part02 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part03 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part04 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part05 (size 5494324 -> 5579724)
- maps/adamsville/nearpost_mask.bin (sha256 changed)
- maps/adamsville/nearpost_rows.bin (sha256 changed)
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
