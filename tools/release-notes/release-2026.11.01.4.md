# Release release-2026.11.01.4

Pushed 2026-11-01 05:50 UTC.

## Versions
- ui_version: 2026.11.01.3 -> 2026.11.01.4
- map_version: 2026.11.01.1 -> 2026.11.01.2

## Changes
- FIX (Joshua hands-on ui 2026.11.01.3 + his Galaxy A17 phone session) ITEM 0 — the crash flood: 200+ reports, all 'Cannot read properties of null (reading x)' at index.html line 10558. Reproduced in mobile emulation with the REAL stack: drawFullMap <- openFullMap <- minimap tap, then again on EVERY full-map pan/zoom redraw. The null object is 'car': in Phase G partial mode no car ever spawns, and drawFullMap's CAR marker read car.x/car.z unguarded — the one unguarded car read left in that function (its player marker already had the v1.58 guard). Opening the full map threw once and every redraw threw again — the flood. (The same signature fired once in his desktop .2 session and was wrongly treated as a one-off; it was this.) Fix (index.html): the CAR marker is wrapped in if (car){...} in the function's own guard idiom — no try/catch, no swallowing; with a car present it draws exactly as before. Proof: mobile emulation on Joshua's exact phone path (touch boot, joystick walk, tap minimap to open the full map, touch-pan it, close, walk on) — zero exceptions, zero crash reports; desktop rig likewise zero exceptions across the whole session. Joshua's correction is on the record: he was NOT stuck on the phone — the session's '1 m travelled' was him standing at spawn inspecting the map/trees/creek; the defect was the crash flood and zero crash reports is the proof.
- FIX (Joshua hands-on, ui 2026.11.01.3) ITEM 1 — 'the main map was not showing the creeks'. Root cause: package-mode water data registers streams in the WATER array as {river: pts} (map_loader adapter), but drawFullMap AND drawMinimap only stroked the legacy w.creek shape — package streams fell into the lake-body branch with undefined geometry and silently drew nothing. BOTH views were affected (the .3 minimap terrain tile drew, but no stream lines on either map). Fix (index.html): both functions now stroke w.creek || w.river, aligned through the same transforms as the .3 terrain tile. Sibling defect found and fixed in the same pass: poi_map.js read car.driving unguarded — in package mode those draws threw inside a swallowed wrapper try/catch, so POI dots and the minimap compass silently never drew; now guarded (car && car.driving) x3. Evidence: desktop full map shows the creek winding past 535 with Wildwood Lake (13,561 water-colour px counted on the canvas at local zoom; screenshot in verification/2026-11-01-fullmap-creeks-desktop.png), the phone full map shows Tatum Lake, its creek and Wildwood Lake (~4,236 sampled water px; verification/2026-11-01-fullmap-creeks-phone.png), and the minimap shows the creek line as well.
- FIX (Joshua hands-on, ui 2026.11.01.3) ITEM 2 — 'the character is not able to walk through them': tree trunks are now solid. Per Joshua's COLLISION DOCTRINE (collision is material meeting material, one registry), buildPkgTrees' tile builder registers the game's standard addCollider(x, z, r) for every streamed near-field tree, with r = the drawn trunk's own base radius (~0.27-0.45 world units); the tile kill path removes each collider with its mesh via removeCollider — tiles streaming in/out add/remove consistently, no ghost colliders, no leaks. Far canopy mass unchanged: no colliders there, per Joshua's earlier ruling. __PKG_TREES.stats() now also reports live trunk count. Harness proof: 3,204 trunk colliders live near spawn; walking AT a trunk stops the player at trunk surface + 0.5 body radius (measured stop 0.84 from centre for r=0.34); walking BESIDE a trunk on a clear lane passes it; teleporting ~2,600 units away kills the tile and its collider (standing on the dead anchor: 0.00 push drift — no invisible wall); walking back rebuilds it (collider present again). Zero exceptions throughout.
- FIX (Joshua hands-on, ui 2026.11.01.3) ITEM 3 — 'at the very part where it meets Tatum Lake, the ground is bleeding through the water surface'. Audit of the SHIPPED package (D-grid port verified exact on the game's own spot checks; bake proven equal to the shipped grids, worst diff 0.000): the creek centreline carve from .3 was intact (min margin +0.39), but (a) 54 terrain posts INSIDE the Tatum Lake rings stood above the lake surface (worst +0.52 m), and (b) against the VISIBLE coarse mesh, 214 water-covered posts bled across the junction (worst +1.86 m beside the creek's first reach) — the 13x15 m mesh chords bridge the carved channel exactly where the creek surface dives 5.25 m from the flat lake in ~90 m. Fix at the owning layer — terrain data, bed-first, LOWERING ONLY, water.json UNCHANGED (lake level still 250.698 m = 822.5 ft exact, creek profile untouched, creek stays shallow): lake bed enforced at surface-0.60 m inside all five Tatum rings; a shore apron (<=16 m) outside the rings in the junction area; the creek's first 460 m re-carved wider (flat bed surface-0.55 out to halfW+2, 18 m feather); then two vertex-targeted passes lowering the posts under the specific mesh vertices still cresting over drawn water. 5,779 + 600 + 283 posts lowered (2,683 newly stored in the first pass). POST-FIX AUDIT, minimums printed per the standing water rule: junction posts vs fine ground min margin +0.55 m, 0 bleeding; drawn surface sampled at 1 m over ALL drawn water in the lake+junction area (17,589 samples) — 0 negative samples; the only remaining sub-surface crossings sit on the dry bank 2-3 m BESIDE the ribbon, where a bank slope naturally crosses the water's level plane and no water is drawn. Whole-creek fine-ground min +0.55 m / 0 bleeding (matches .3); Chattahoochee stem fine min +1.70 m (matches .3); 535 spawn post 244.235 m and Dollar Mill crest 914.4 ft unchanged; in-game screenshot: the creek runs in its bed from the lake with no ground through the water (verification/2026-11-01-tatum-mouth-AFTER.png). Known residue, pre-dating this fix and outside the reported mouth: the far-west creek reach still bridges against the coarse mesh (worst -2.9 m by corridor-post sampling; .3's station audit measured the same reach at 48 m / -0.34 m). Package files changed: heights_base_10m.bin, heights_near_2m.bin.part00-05, nearpost_mask.bin, nearpost_rows.bin, terrain_heights_pkg.bin, zone.json (descriptor + dated phase note). NOT in this release (per Joshua): the fourth reported defect — the creek 'overlapping' somewhere downstream toward Dollar Mill — awaits his screenshot; no guess was made and nothing was changed for it.

## Files changed
- index.html (size 1168818 -> 1172393)
- poi_map.js (size 11805 -> 12273)
- maps/adamsville/zone.json (size 5312 -> 5961)
- maps/adamsville/heights_base_10m.bin (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part04 (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part05 (size 5452940 -> 5464656)
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
