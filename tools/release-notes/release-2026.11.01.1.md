# Release release-2026.11.01.1

Pushed 2026-11-01 01:48 UTC.

## Versions
- ui_version: 2026.10.31.1 -> 2026.11.01.1

## Changes
- BOOT-STALL FIX (2026-11-01): package boots were trapped on the loader forever — the map seam's success path marked only roads/lifts/pins/buildings done, leaving elev/signs (critical) and gasdata/busdata with no completion source since their legacy data files were removed with the old map. __tryStartGame refuses to start while any step is pending and the progress watchdog only stands down on an empty pending list, so the built world sat at 'Still loading 100%', false boot-stall reports fired at 45s (stage 'Elevation data', sub-stage 'buildings-placement'), and the 180s failsafe put elev/signs on the critical-failure panel. Fix in index.html's world-data seam: a successful package boot now also marks elev + signs (the package IS the elevation and sign data), and in partial mode marks gasdata + busdata (systems disabled by Phase G design). Legacy/no-map paths untouched; no timeouts raised.

## Files changed
- index.html (size 1147707 -> 1150004)

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
