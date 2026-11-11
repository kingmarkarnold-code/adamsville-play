# Release release-manual

Pushed 2026-11-11 16:46 UTC.

## Versions
- map_version: 2026.11.08.2 -> 2026.11.11.1

## Changes
- (no staged notes; changes detected from disk)

## Files changed
- maps/adamsville/zone.json (sha256 changed)
- maps/adamsville/heights_near_2m.bin.part05 (size 5579724 -> 5580924)
- maps/adamsville/nearpost_mask.bin (sha256 changed)
- maps/adamsville/nearpost_rows.bin (sha256 changed)
- maps/adamsville/terrain_heights_pkg.bin (sha256 changed)

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
