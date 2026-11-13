# Release release-2026.11.13.4

Pushed 2026-11-13 07:01 UTC.

## Versions
- ui_version: 2026.11.13.3 -> 2026.11.13.4

## Changes
- Defect A (trees missing at 535): entry now waits for the pre-grow tree ring to complete (was: fixed 10s settle, census ignored — slow phones entered a treeless field). Item D (snap-to-ground rule): trees seat on the DRAWN bench-tile surface via per-tile height rasters (raycast audit at spawn: 70/388 trunks hovered, worst 1.88u — now 0) + a permanent re-seat sweep rebuilds any tile whose ground moved (mechanism proven by corruption test). Defect B (portrait UI): layout scales from the portrait frame (390x844 / picked phone table) instead of the 1280x800 landscape frame — minimap/button grid/top-right row/bars back at their .11.3 spec spots in portrait; street-name narrowed to 240 in the portrait phone tables so it clears the button grid; clock moves below the top clusters on portrait phones (300px). Landscape untouched.

## Files changed
- daycycle.js (size 31605 -> 32187)
- index.html (size 1381965 -> 1393716)
- ui_layout.json (sha256 changed)
- ui_layout_apply.js (size 38724 -> 40926)

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
