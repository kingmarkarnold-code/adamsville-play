# Release release-2026.11.07.6

Pushed 2026-11-07 19:13 UTC.

## Versions
- ui_version: 2026.11.07.5 -> 2026.11.07.6

## Changes
- GPS v1.67 navigation truth pass (Joshua 2026-11-07): (1) top HUD arrow UN-MIRRORED — hudArrowTick applied the world bearing directly as a CSS rotation, flipping left/right at every turn while straights read fine; relative angle is now viewYaw-bearing, verified against the turn band end-to-end (arrow and band must never disagree). (2) U-TURN glyph: heading the wrong way (|angle| > 150 deg) now shows a U-turn arrow hooked toward the shorter way around instead of the plain arrow spun backwards. (3) The neon route LINE through the world is removed (arrow-only navigation, Joshua's standing rule); destination beacon, in-world chevron, and the minimap/full-map route line are untouched. gps_system.js only.

## Files changed
- gps_system.js (size 122227 -> 125250)

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
