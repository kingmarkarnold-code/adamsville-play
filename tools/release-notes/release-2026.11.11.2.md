# Release release-2026.11.11.2

Pushed 2026-11-11 20:59 UTC.

## Versions
- ui_version: 2026.11.11.1 -> 2026.11.11.2

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- dive_system.js (size 35934 -> 44261)
- hud_move.js (size 78323 -> 88031)
- index.html (size 1367322 -> 1369704)

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
