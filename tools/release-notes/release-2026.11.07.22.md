# Release release-2026.11.07.22

Pushed 2026-11-07 22:41 UTC.

## Versions
- ui_version: 2026.11.07.21 -> 2026.11.07.22
- map_version: 2026.11.07.2 -> 2026.11.07.3

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- index.html (size 1269556 -> 1269653)
- maps/adamsville/zone.json (size 11819 -> 13480)
- maps/adamsville/structures.json (size 14607 -> 14846)
- maps/adamsville/water.json (size 915819 -> 925944)
- maps/adamsville/canopy_cover_10m.bin (sha256 changed)

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
