# Release release-2026.10.25.7

Pushed 2026-10-25 23:05 UTC.

## Versions
- ui_version: 2026.10.25.6 -> 2026.10.25.7

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- basketball.html (size 145389 -> 149379)
- daycycle.js (size 15901 -> 16733)
- index.html (size 1074531 -> 1081046)
- shirt_designs.js (size 7135 -> 7307)
- three.module.js (size 0 -> 662772)
- three.core.js (size 0 -> 1458113)
- three_bridge.js (size 0 -> 3513)
- three_shim.js (size 0 -> 1045)
- three-addons/loaders/GLTFLoader.js (size 0 -> 117570)
- three-addons/utils/BufferGeometryUtils.js (size 0 -> 37712)
- three-addons/utils/SkeletonUtils.js (size 0 -> 11535)

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
