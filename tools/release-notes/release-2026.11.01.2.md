# Release release-2026.11.01.2

Pushed 2026-11-01 03:42 UTC.

## Versions
- ui_version: 2026.11.01.1 -> 2026.11.01.2

## Changes
- FIX (Joshua hands-on, ui 2026.11.01.1): game loaded and started in Phase G partial mode but the character was never visible, with a per-frame crash flood 'Cannot read properties of null (reading mesh)'. Root cause proven by stack trace (updateCamera <- simTick <- animate): updateCamera in index.html read car.mesh / car.driving unguarded; in partial mode vehicles are gated off so car stays null all session, the camera function died every frame before placing the camera. Fix: every car read in updateCamera is now null-guarded (the function's own v1.58 idiom) with an explanatory comment; no car = on-foot camera path. Verified in Chrome 156 + SwiftShader harness (also at 6x CPU throttle): before = 600 errors in 20 s and a ground-level camera with no character; after = zero page errors, game starts, hero (GLB) present and visible at the 535 spawn in screenshot. No package data touched; boot-stall fix unregressed (loader still reaches Ready and starts).

## Files changed
- index.html (size 1150004 -> 1151062)

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
