# Release release-2026.11.01.9

Pushed 2026-11-01 18:16 UTC.

## Versions
- ui_version: 2026.11.01.8 -> 2026.11.01.9

## Changes
- v1.17.2 page-side fix (2026-11-01): SHELL FETCH TRANSPORT in index.html — inside the APK shell only (file: origin + MapDownload bridge present), relative fetch() references are rewritten to the shell's reserved https origin (https://sa-map.invalid/) and the shell's interceptor serves the gate-verified package from the phone. Fixes the 1.17.1 handoff failure: gate census COMPLETE and route GAME, but bootWorld()'s relative fetches were refused on the file: origin, so the page booted 'No map data' and vehicle_library.glb died with 'Failed to fetch' — same root, both fixed. Inert on the web build (verified: shim does not activate over http; package boots as before). map_registry.js CLASSIC-ENGINE note corrected (the legacy fallback it described was removed in Phase F); map_loader.js fetch helpers carry a pointer to the transport. Shell half (MainActivity/LaunchGate) ships in APK 1.17.2.

## Files changed
- index.html (size 1191123 -> 1194980)
- map_loader.js (size 65593 -> 66189)
- map_registry.js (size 19195 -> 19831)

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
