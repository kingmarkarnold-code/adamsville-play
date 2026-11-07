# Release release-2026.11.07.3

Pushed 2026-11-07 17:27 UTC.

## Versions
- ui_version: 2026.11.07.2 -> 2026.11.07.3
- map_version: 2026.11.01.4 -> 2026.11.07.1

## Changes
- 2026-11-07 falls/boulders batch: Tatum Lake waterfall restored (stepped creek head at source, 3.4 m trickle, foam 1.0 at lips, pools waded at surface-0.45); boulder system (70 records in structures.json — falls mossy rows + Chattahoochee shoals on exempted natural ground); boulders solid via the mesh-collision solver (same hook as trunks); bump messages name the object ('You hit a tree/boulder. You must go around.') via named-solid providers in crashlog. Harness: 15/15 behaviour checks + 24/24 patcher spot checks + installed-package audit clean. See zone-build/fixes-2026-11-07-falls/BUILD-NOTES.md.

## Files changed
- collision_material.js (size 55321 -> 56182)
- crashlog.js (size 39718 -> 41753)
- index.html (size 1212908 -> 1224734)
- map_loader.js (size 66189 -> 67528)
- maps/adamsville/zone.json (size 8272 -> 10331)
- maps/adamsville/structures.json (size 18 -> 15696)
- maps/adamsville/water.json (size 950527 -> 952780)
- maps/adamsville/heights_base_10m.bin (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part00 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part01 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part04 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part05 (sha256 changed)
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
