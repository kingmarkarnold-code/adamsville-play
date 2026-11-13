# Release release-manual

Pushed 2026-11-13 16:11 UTC.

## Versions
- map_version: 2026.11.13.1 -> 2026.11.13.2

## Changes
- REVERT of map 2026.11.13.1 (shoreline ground build, commit c8396864) at Joshua's direct order after it failed in his hands: ground gaps/cracks, walk-through ground, destroyed Tatum Outlet river reaches, creek water reading as dirt.
- Restored the exact pre-build package (map 2026.11.12.2 state, parent commit 6191eec0) for all 41 files the campaign changed: heights grids, nearpost data, terrain package, zone.json, tiles-manifest and the 29 edited bench tiles. Water data and all ui files untouched.
- Verified in real headless boots of the restored bytes: 535 ground whole (shot matches the .12.2 baseline framing pixel-for-pixel in scene content), Tatum Outlet Creek reads as water, WADING registers in the channel, banks intact, feet tracked the drawn ground everywhere sampled (no fall-through, no step drops).
- Publish path note: pushed as a map-scoped atomic commit replicating release.py's manifest regeneration, because the canonical tree currently carries the next ui build's unshipped edits (golden_roses.js, index.html) which a full release.py run would have swept into this release; the ui line is untouched here and ships separately.

## Files changed
- maps/adamsville/zone.json (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/heights_base_10m.bin (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/heights_near_2m.bin.part00 (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/heights_near_2m.bin.part01 (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/heights_near_2m.bin.part02 (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/heights_near_2m.bin.part03 (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/heights_near_2m.bin.part04 (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/heights_near_2m.bin.part05 (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/nearpost_mask.bin (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/nearpost_rows.bin (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/terrain_heights_pkg.bin (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/tiles-manifest.json (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_00_01.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_00_02.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_01_04.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_01_07.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_02_04.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_02_07.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_03_01.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_03_02.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_04_00.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_04_01.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_04_04.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_04_05.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_05_00.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_05_03.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_05_04.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_06_00.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_06_01.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_06_03.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_06_04.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_08_00.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_10_02.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_10_03.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_11_00.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_11_01.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_11_02.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_11_03.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_11_08.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_12_00.glb (restored to pre-2026.11.13.1 bytes)
- maps/adamsville/tiles/todays-look/tile_12_01.glb (restored to pre-2026.11.13.1 bytes)

## QA gates
- restore source = GitHub parent commit of c8396864; every restored file's sha256 verified against the .12.2 manifest: PASS
- headless boot verification (4 boots, 0 page errors): PASS
- ui line untouched (no ui files in this commit): PASS

GitHub Pages CDN lags ~10 min; hard-refresh to verify.
