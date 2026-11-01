# Release release-2026.11.01.6

Pushed 2026-11-01 08:49 UTC.

## Versions
- ui_version: 2026.11.01.5 -> 2026.11.01.6
- map_version: 2026.11.01.2 -> 2026.11.01.3

## Changes
- Fixes from Joshua's Nov 1 gameplay video:
- • CREEK SEEP FIXED END-TO-END: the whole Tatum creek (all 6.2 km, every stream record) and the Chattahoochee were audited against BOTH the fine ground and the visible terrain mesh — 2.5 km of creek was bleeding through the coarse mesh. The bed was re-carved (lowering only, water untouched); the whole creek now audits 0 m buried against both grounds.
- • CHATTAHOOCHEE DEEPENED: the shipped bed was a flat bench only ~0.74 units deep — waist-deep walking water, which is why he could walk across in the video. The channel is now a real profile: 1.57 units (swim depth) mid-channel, shelving to wading depth at both shores so he can still walk in and climb out. Harness-proven: wade at the shore, swimming mid-crossing, wade at the far shore.
- • WATER + NATURE AUDIO (all generated in code, no files): soft creek sound with distance falloff (explicitly not ocean surf), a separate small waterfall trickle at the Tatum Lake outlet, crickets/grasshoppers along the creek, wading splashes and swim strokes synced to movement using the three-state water model (wade / swim-moving / tread — grass stays silent, water doesn't), and the music now ducks gently near water so ambience stays audible without drowning the track.
- • RED LINE REMOVED: the crimson creation-era world-border line is no longer drawn on the full map (verified: 2,005 crimson pixels before, 0 after). The border DATA stays in the game, just never drawn.
- • NAVIGATION KNOWS FEET FROM WHEELS: the GPS module now loads in the package world (it was disabled there — navigation never ran at all in this build). On foot it guides straight to ANY point on the board — bearing arrow + distance, updating as he walks. Vehicle routing still follows streets; the package has none yet, so that branch falls back gracefully and never blocks on-foot guidance. When roads ship, vehicle routing consumes them without changing the on-foot path.

## Files changed
- ambient_audio.js (size 17627 -> 32979)
- gps_system.js (size 116383 -> 122227)
- index.html (size 1181167 -> 1183979)
- maps/adamsville/zone.json (size 5961 -> 6883)
- maps/adamsville/heights_base_10m.bin (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part00 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part01 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part02 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part03 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part04 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part05 (size 5464656 -> 5476976)
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
