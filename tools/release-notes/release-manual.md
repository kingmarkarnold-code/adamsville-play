# Release release-manual

Pushed 2026-11-13 12:26 UTC.

## Versions
- map_version: 2026.11.12.2 -> 2026.11.13.1

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- maps/adamsville/zone.json (sha256 changed)
- maps/adamsville/heights_base_10m.bin (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part00 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part01 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part02 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part03 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part04 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part05 (size 5580924 -> 5670456)
- maps/adamsville/nearpost_mask.bin (sha256 changed)
- maps/adamsville/nearpost_rows.bin (sha256 changed)
- maps/adamsville/terrain_heights_pkg.bin (sha256 changed)
- maps/adamsville/tiles/tiles-manifest.json (size 59279 -> 59888)
- maps/adamsville/tiles/todays-look/tile_00_01.glb (size 179440 -> 291616)
- maps/adamsville/tiles/todays-look/tile_00_02.glb (size 180288 -> 211612)
- maps/adamsville/tiles/todays-look/tile_01_04.glb (size 177548 -> 216108)
- maps/adamsville/tiles/todays-look/tile_01_07.glb (size 178224 -> 230976)
- maps/adamsville/tiles/todays-look/tile_02_04.glb (size 177548 -> 264924)
- maps/adamsville/tiles/todays-look/tile_02_07.glb (size 178228 -> 309256)
- maps/adamsville/tiles/todays-look/tile_03_01.glb (size 178504 -> 275748)
- maps/adamsville/tiles/todays-look/tile_03_02.glb (size 179296 -> 195528)
- maps/adamsville/tiles/todays-look/tile_04_00.glb (size 179916 -> 202052)
- maps/adamsville/tiles/todays-look/tile_04_01.glb (size 177600 -> 222444)
- maps/adamsville/tiles/todays-look/tile_04_04.glb (size 178444 -> 227720)
- maps/adamsville/tiles/todays-look/tile_04_05.glb (size 177588 -> 185192)
- maps/adamsville/tiles/todays-look/tile_05_00.glb (size 180828 -> 247892)
- maps/adamsville/tiles/todays-look/tile_05_03.glb (size 179356 -> 206820)
- maps/adamsville/tiles/todays-look/tile_05_04.glb (size 179304 -> 202292)
- maps/adamsville/tiles/todays-look/tile_06_00.glb (size 179004 -> 222216)
- maps/adamsville/tiles/todays-look/tile_06_01.glb (size 176768 -> 201108)
- maps/adamsville/tiles/todays-look/tile_06_03.glb (size 177540 -> 264052)
- maps/adamsville/tiles/todays-look/tile_06_04.glb (size 177480 -> 292668)
- maps/adamsville/tiles/todays-look/tile_08_00.glb (size 179072 -> 225900)
- maps/adamsville/tiles/todays-look/tile_10_02.glb (size 178436 -> 208092)
- maps/adamsville/tiles/todays-look/tile_10_03.glb (size 178436 -> 205776)
- maps/adamsville/tiles/todays-look/tile_11_00.glb (size 180828 -> 441052)
- maps/adamsville/tiles/todays-look/tile_11_01.glb (size 178536 -> 668940)
- maps/adamsville/tiles/todays-look/tile_11_02.glb (size 179292 -> 614272)
- maps/adamsville/tiles/todays-look/tile_11_03.glb (size 179292 -> 589528)
- maps/adamsville/tiles/todays-look/tile_11_08.glb (size 178532 -> 204992)
- maps/adamsville/tiles/todays-look/tile_12_00.glb (size 179004 -> 185508)
- maps/adamsville/tiles/todays-look/tile_12_01.glb (size 176700 -> 184908)

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
