# Release release-2026.11.13.1

Pushed 2026-11-13 06:10 UTC.

## Versions
- ui_version: 2026.11.12.3 -> 2026.11.13.1

## Changes
- Phase 1 (Joshua, voice call Nov 13): delete the ?uiv= from the address bar. index.html: the very first script of the document now strips the uiv param in place via history.replaceState the moment any page carrying it starts parsing — the self-heal's ?uiv= hop (its cache-buster) is untouched, the sessionStorage loop guard is untouched, nothing reads ?uiv= so nothing can break; the play URL stays the plain detailed/ link all session. Verified by real headless boots: direct ?uiv= load ends clean; simulated stale-doc heal still hops to ?uiv=<live> and lands clean; game reaches gameplay, zero page errors.

## Files changed
- index.html (size 1380638 -> 1381965)

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
