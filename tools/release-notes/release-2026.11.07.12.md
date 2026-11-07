# Release release-2026.11.07.12

Pushed 2026-11-07 20:22 UTC.

## Versions
- ui_version: 2026.11.07.11 -> 2026.11.07.12

## Changes
- v1.68 navigation markers (Joshua 2026-11-07 15:03-15:05): destination beacon is fog-immune (fog:false) so the white pillar pushes through the fog at any range — size/colour/depth unchanged; the in-world chevron now hovers just above the player's head at frame-fitting size (was 16.5u up, geometrically out of frame) and gains a U-turn state — hooked form facing the player, hooked toward the shorter way around, on the same |rel|>150deg band and bearing math as the top HUD arrow (untouched). gps_system.js only.

## Files changed
- gps_system.js (size 125250 -> 132931)

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
