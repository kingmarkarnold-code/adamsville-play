# Release release-2026.11.13.12

Pushed 2026-11-13 16:18 UTC.

## Versions
- ui_version: 2026.11.13.11 -> 2026.11.13.12

## Changes
- Golden rose cylinder fade re-anchored to Joshua's latest ruling: fully gone by 150u (~492 ft), full strength beyond 220u — the same 70u fade width shifted out, superseding the 120 -> 50 band.
- Rose glows now seat on the drawn bench ground via treeSeatY (seatY() + reseatGlows() on the rose tick cadence): the Tatum Lake glow was buried 1.79u under the drawn ground on the analytic seat; all seven sites verified seated on the drawn ground in real boots. Glow strength, radius law and close fade untouched (the 535 visibility question is a strength verdict, not seating).
- index.html: window.treeSeatY published from inside buildPkgTrees (the closure-private seat), the pattern used by __saPregrowSettle/__PKG_TREES.
- Publish path note: pushed as a ui-scoped atomic commit replicating release.py's manifest regeneration and __DOC_UIVER stamp, sequenced after the map 2026.11.13.2 revert (commit be616bf8); no map file is in this commit and the on-disk map state was verified byte-equal to live map 2026.11.13.2 before the push.

## Files changed
- golden_roses.js (cylinder band 220 -> 150; glow drawn-ground seating)
- index.html (window.treeSeatY publication; __DOC_UIVER stamp)

## QA gates
- real headless boots of the prepared bytes: cylinder invisible at 100u, visible at 250u (opacity 0.50): PASS
- seating: glow group == treeSeatY at all seven sites, pool above drawn ground: PASS
- release.py dry run: inventory PASS, node --check PASS, smoke PASS, classification exactly these 2 ui files: PASS
- map line untouched (no map files in this commit): PASS

GitHub Pages CDN lags ~10 min; hard-refresh to verify.
