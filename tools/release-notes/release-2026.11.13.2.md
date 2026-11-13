# Release release-2026.11.13.2

Pushed 2026-11-13 06:20 UTC.

## Versions
- ui_version: 2026.11.13.1 -> 2026.11.13.2

## Changes
- Phase 2 (Joshua, voice call Nov 13; his pick: AMBIENT GLOW): the golden rose area glow in golden_roses.js no longer blows out like a sun up close. Pool gradient flattened to an even ambient wash (centre alpha 0.90 -> 0.34, near-flat to the rim melt), haze vertex peak cut 1.35x -> 0.60x, and a hard close-range cap: inside 40u both pieces fade toward 0.35 opacity at distance zero (glowCloseFade), on per-rose cloned materials (geometry/texture still shared). The .12.1 distance law is untouched: same coverage, same shrink (R(d) 15..120 over 40..500), same never-a-pinpoint floor; beacon untouched. Verified by real headless boots at rose site 1, before/after identical framing: up-close ground band mean luminance 200 -> 103, near-white pixels 9.9% -> 0.0%; rose and grass fully readable through the glow.

## Files changed
- golden_roses.js (size 53923 -> 56432)

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
