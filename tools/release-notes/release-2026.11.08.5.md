# Release release-2026.11.08.5

Pushed 2026-11-08 15:43 UTC.

## Versions
- ui_version: 2026.11.08.4 -> 2026.11.08.5

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- dive_system.js (size 32214 -> 33099)
- index.html (size 1279825 -> 1280448)
- map_loader.js (size 72443 -> 73845)
- map_registry.js (size 19831 -> 23620)

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
