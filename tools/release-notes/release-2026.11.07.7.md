# Release release-2026.11.07.7

Pushed 2026-11-07 19:26 UTC.

## Versions
- ui_version: 2026.11.07.6 -> 2026.11.07.7

## Changes
- Boot + resume fix (Joshua 2026-11-07): an active game now resumes with NO Start button and NO tap gate — options skipped, progress bar, downloads finish, straight into the game at the saved coordinates. The resume tap gate ('Ready — tap START to continue') is removed (it was also the Firefox stall-at-100%). Trust window repaired: AUTO spot stashes are trusted for 12 hours (was 10 minutes for everything — stepping away longer than 10 min threw away his Tatum Lake spot and restarted him at 535); the launcher stamps the stash it accepted and the restore honours that stamp, so a slow load can never re-judge it stale. Package loader fetches (map_loader fetchJSON/fetchBin) now carry the codebase's 20 s inactivity watchdog + one retry — they were the only loaders with no timeout, so a stalled connection hung a fresh (incognito) boot forever; failures now surface as the honest NO MAP DATA state. Verified by harness (34 checks): flow-detection truth table, stash save->reload round-trip restoring exact coordinates, stalled fetch rejecting after one retry, bootWorld resolving false on a stalled package load.

## Files changed
- index.html (size 1229967 -> 1228471)
- map_loader.js (size 68245 -> 72443)
- ui_update_flow.js (size 38981 -> 40911)

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
