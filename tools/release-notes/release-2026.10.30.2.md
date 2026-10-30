# Release release-2026.10.30.2

Pushed 2026-10-30 18:17 UTC.

## Versions
- ui_version: 2026.10.30.1 -> 2026.10.30.2
- map_version: 2026.10.30.2 -> 2026.10.30.3

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- ambient_audio.js (size 14143 -> 17627)
- daycycle.js (size 16733 -> 18081)
- index.html (size 1129479 -> 1145131)
- map_loader.js (size 57102 -> 59627)
- maps/adamsville/zone.json (size 4254 -> 4945)
- maps/adamsville/water.json (size 239320 -> 237992)
- maps/adamsville/heights_base_10m.bin (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part00 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part01 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part02 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part03 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part04 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part05 (size 4131968 -> 5433396)
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
