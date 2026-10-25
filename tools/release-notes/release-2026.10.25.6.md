# Release release-2026.10.25.6

Pushed 2026-10-25 22:53 UTC.

## Versions
- ui_version: 2026.10.25.5 -> 2026.10.25.6
- map_version: 2026.10.25.1 -> 2026.10.25.2

## Changes
- Team 3 bug fixes: heightAt NaN guard (fixes invisible van), weak hardware detection for TCL, Sim tick array slice, shared AudioContext for UI sounds. UI v2026.10.11.178.

## Files changed
- basketball_court.js (size 31161 -> 31596)
- index.html (size 1059361 -> 1074531)
- residential_detail.js (size 26797 -> 28312)
- school_plaza.js (size 22740 -> 23995)
- zones/adamsville/buildings.js (size 836699 -> 836650)
- zones/riverdale/roads.js (size 5345051 -> 5345093)
- zones/adamsville/buildings.json (size 836547 -> 836498)
- zones/riverdale/roads.json (size 5344923 -> 5344915)

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
