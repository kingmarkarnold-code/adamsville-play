# Release release-2026.11.01.8

Pushed 2026-11-01 16:14 UTC.

## Versions
- ui_version: 2026.11.01.7 -> 2026.11.01.8
- map_version: 2026.11.01.3 -> 2026.11.01.4

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- ambient_audio.js (size 32979 -> 34251)
- index.html (size 1184568 -> 1191123)
- map_loader.js (size 63676 -> 65593)
- maps/adamsville/zone.json (size 6883 -> 8272)
- maps/adamsville/water.json (size 237992 -> 950527)
- maps/adamsville/heights_base_10m.bin (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part00 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part01 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part02 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part03 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part04 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part05 (size 5476976 -> 5494324)
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
