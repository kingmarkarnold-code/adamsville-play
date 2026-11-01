# Release release-2026.11.01.3

Pushed 2026-11-01 04:29 UTC.

## Versions
- ui_version: 2026.11.01.2 -> 2026.11.01.3
- map_version: 2026.10.30.3 -> 2026.11.01.1

## Changes
- FIX (Joshua hands-on, ui 2026.11.01.2) ITEM 2 — creek across from 535 partly underground. Audit of the SHIPPED package with the game's own sampler (D-grid replica verified exact against the game's spot checks; mesh bake proven NOT stale — shipped terrain_heights_pkg.bin equals the bake formula on the shipped grids, max diff 0.000 m over 580,041 verts): at surveyed stations the v2 carve was intact, but (A) 511 m of the creek's 6,229 m centreline (8.2%) was buried against the FINE ground itself — water.json stations are ~12 m apart, so on bends the straight drawn chords leave the narrow carved channel and cross bank ground (worst margin -3.15 m); and (B) 2,898 m (46.5%) was buried against the VISIBLE 13.3x15 m terrain mesh only, because the coarse mesh bilinearly bridges a channel narrower than its cells (worst -3.14 m at the 535 reach itself). Bodies had no genuine interior defect (worst true-interior margin +0.26 m) and were left untouched. Fix at the owning layer — the terrain data, bed-first per Joshua's ruling; water.json and all water surfaces/profiles UNCHANGED, creek stays a shallow wading creek: a falloff-template re-carve under the DRAWN stream lines on the shipped 2 m grid (lowering only; creek bed = surface - 0.55 m with a widened flat + 8 m feather; Chattahoochee stem bed = surface - 1.70 m swim bench, flat + 10 m feather; extra gorge pass within 450 m of 535). 235,751 posts lowered, all within 36.9 m of a stream line; 4,886 newly-stored near posts; spot checks on the repacked package pass exactly (535 spawn post 244.235 m, Dollar Mill crest 914.4 ft). POST-FIX AUDIT: creek buried vs fine ground 0 m (min margin +0.55 m over the whole 6,229 m); vs mesh 48 m (0.8%), worst -0.34 m at a far-west reach, NOT at 535 (the 535 gorge reach is clear); stem 0 m buried vs fine and vs mesh (min +1.70 m). Harness screenshot at the 535 reach: before = a small blue shard diving under a smooth bank; after = one continuous ribbon in a visible channel. Package files changed: heights_near_2m.bin parts 00-05, nearpost_mask.bin, nearpost_rows.bin, terrain_heights_pkg.bin, zone.json (descriptor + dated phase note).
- FIX (Joshua hands-on, ui 2026.11.01.2) ITEM 1 — 'that trees don't look like trees'. Diagnosis: buildPkgCanopy draws the whole woodland as ONE crown surface on the coarse terrain lattice at the TERRAIN elevation scale (0.435 units/m) — at eye level a green roof on a brown skirt wall, no trunks anywhere, and its 8 ft foliage bottom lands at ~1.1 world units (waist height on the 1.88-unit hero). Fix (index.html, package mode only, legacy untouched): (1) new buildPkgTrees system — individual deterministic trees (hash of NLCD cell + index, same tree every visit) streamed in 64-unit tiles around the player (build radius 235, kill 330): a 5-sided trunk from the ground up INTO a two-puff icosahedron crown, heights from the canopy's own data rule (10 + 14*cover/100 m) but at the OBJECT scale (hero 1.88 units ~ 1.8 m), so the foliage bottom sits at a true 8 ft (2.54 units, just over the hero's head) per the TREE FORM RULE; anchors keep out of drawn water (inWater); crowns sway via the same wind shader injection + shared uniforms as the canopy, trunks carry aSway 0. (2) The canopy mass sinks below ground inside a player-following hole (uHoleC/uHoleR in its shader, radius 218) so woodland is never double-drawn — near field = trees, far field = mass, silhouettes meet because both use the same height rule. (3) Crown proportions tuned after the first harness shot (crowns as wide as the tree was tall read as a ceiling): crown vertical radius 0.40 of the crown zone, radius just under that. Cost in the harness (same rig, 6x CPU throttle): drawn triangles 2.17-2.20M after vs ~2.10M geometry-accounted before (terrain 1.16M + canopy 941,704 proven from __PKG_CANOPY_BUILT) — the tree layer adds ~3-4% triangles while the sunk mass inside the hole rasterises ~nothing; rAF-rate deltas in SwiftShader were noise-level. Before/after eye-level screenshots at a woodland spot near 535 are in workspace/game-map/verification/. Joshua's laptop verdict is the final proof.
- FIX (Joshua hands-on, ui 2026.11.01.2) ITEM 3 — 'the mini map should show the terrain'. Diagnosis: drawMinimap painted one flat #0e2a1a disc; package streams did not even draw (minimap strokes only legacy w.creek entries). Fix (index.html, package mode only): mmTerrainTile() renders ONE offscreen tile (693x837) from TERR_H — the exact lattice the 3D terrain mesh drew from, already in memory, no extra download — hypsometric tint (Chattahoochee low green ~228 m to MLK ridge tan ~280 m) x NW hillshade from lattice gradients; drawMinimap blits it inside the Adamsville scope clip through the same rotate/scale transform as every other feature (rotate(yaw+PI), verified against toMap's matrix), and drawFullMap blits it through the fmPt transform, so relief aligns exactly with the player marker, water and roads in both views. Harness screenshots: the creek valley, the hills around 535 and the tan crest ground all read as relief on the minimap. Also noted for the record: the NEW one-shot crash in ui .2 ('Cannot read properties of null (reading x)' at (2115, 6434.9)) could NOT be reproduced in two harness attempts totalling ~11 min of walking including Joshua's exact reported path and the crash point — it fired exactly once (a one-time code path, not a per-frame defect); the fish system is exonerated by its try/catch-wrapped tick and updateCamera is fully guarded since .2. NO fix was invented for it; if it recurs, the next report's full function-name stack is the evidence needed (Chrome line numbers in this document have proven unreliable twice).

## Files changed
- index.html (size 1151062 -> 1168818)
- maps/adamsville/zone.json (size 4945 -> 5312)
- maps/adamsville/heights_near_2m.bin.part00 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part01 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part02 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part03 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part04 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part05 (size 5433396 -> 5452940)
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
