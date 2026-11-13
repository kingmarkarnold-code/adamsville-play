# Release release-2026.11.13.6

Pushed 2026-11-13 10:50 UTC.

## Versions
- ui_version: 2026.11.13.5 -> 2026.11.13.6

## Changes
- Rose cylinder fade distance set by Joshua (Nov 13, later on the call): the gold rose cylinder's fade band is re-anchored to the tree line in his 535 screenshot, measured in the Defect A pass at 50 units (about 164 ft). Fade now begins at 120u (about 394 ft, full strength beyond) and is COMPLETE at 50u (about 164 ft) — inside that distance only the ambient glow marks the rose, per his ruling. Was 170 -> 70 in .13.3. golden_roses.js only: CYL_FADE_FAR 170 -> 120, CYL_FADE_NEAR 70 -> 50. Verified: node --check; cylFade extracted verbatim from the shipped file and evaluated (full >=394 ft, half at 279 ft, zero <=164 ft); mechanism unchanged from the boot-proven .13.3 build. (In-browser probe rigs could not complete a boot on the build VM after its restart — 135 MB free RAM, renderer killed — rig/cyl-probe-spawn.mjs in the job workdir re-checks it when the VM has headroom.)

## Files changed
- golden_roses.js (size 59767 -> 60435)

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
