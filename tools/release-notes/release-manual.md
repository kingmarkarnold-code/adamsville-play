# Release release-manual

Pushed 2026-11-12 18:40 UTC.

## Versions
- map_version: 2026.11.11.2 -> 2026.11.12.1

## Changes
- Tatum Lake full shoreline (Joshua's water-edge rule, Nov 12): ground edge snapped down to the water plane across the whole Tatum shoreline (tiles 10_02/10_03 rebuilt from the edited height sheet so drawn ground == height lookup); below-water moat removed, lake bed profile restored, Tatum outlet cliff reach by 535 untouched (84-point profile + max grade identical). Height grids regenerated from the same edit (base + near part04 + pkg). Verified by real headless boot of the shipped bytes: drawn-vs-lookup sweep worst 0.00003 m, tiles 0 failures, waterDepthAt unchanged.

## Files changed
- maps/adamsville/zone.json (size 14290 -> 14395)
- maps/adamsville/heights_base_10m.bin (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part04 (sha256 changed)
- maps/adamsville/terrain_heights_pkg.bin (sha256 changed)
- maps/adamsville/tiles/tiles-manifest.json (size 59280 -> 59279)
- maps/adamsville/tiles/todays-look/tile_10_02.glb (size 178368 -> 178436)
- maps/adamsville/tiles/todays-look/tile_10_03.glb (size 178368 -> 178436)

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
