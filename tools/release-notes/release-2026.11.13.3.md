# Release release-2026.11.13.3

Pushed 2026-11-13 06:30 UTC.

## Versions
- ui_version: 2026.11.13.2 -> 2026.11.13.3

## Changes
- Rose cylinders (Joshua, voice call Nov 13): every standing golden rose now carries a GOLD cylinder, sky-to-ground (400u, the destination beacon's construction, fog-immune), marking its place on the map from far away. Destination cylinder verdict was 'looks perfect' — it stays neon green, untouched (gps_system.js unchanged). The rose cylinder NEVER shrinks: constant 6u radius with only the beacon family's gentle pulse; instead it FADES OUT as the player closes in (full at 170u+, smoothstep to zero at 70u, invisible inside 70u), so the last stretch is hunted by the ambient glow alone and the rose is never pinpointed. Lifecycle rides the glow's: picked/trampled = cylinder gone with the group, regrown = back. All 7 placed sites; the 3 unplaced sites get theirs when Joshua sites them. Verified by real headless boots: scene probes at 300u / 120u / 4u read opacity 0.50 / 0.25 / hidden for the approached rose while the other six stay full; long shot shows the gold column standing over rose 1 with the ambient pool at its base and a second rose's column at frame edge.

## Files changed
- golden_roses.js (size 56432 -> 59767)

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
