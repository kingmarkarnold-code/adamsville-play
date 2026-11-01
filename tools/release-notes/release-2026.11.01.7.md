# Release release-2026.11.01.7

Pushed 2026-11-01 08:58 UTC.

## Versions
- ui_version: 2026.11.01.6 -> 2026.11.01.7

## Changes
- Item F (Joshua, Nov 1): CAM button hidden unless driving. The camera button toggles the CAR's camera (chase/driver), but a v1.11 mobile exception forced it on screen in every state — it sat in the top-left stack throughout his gameplay video while his state read ON FOOT. The exception is removed: CAM now follows the same player-state signal as the steering/gas/brake pedals and the mode tag (setDrivingUI) — shown in a vehicle, hidden on foot, swimming, and inside. Button and function untouched; visibility only. Harness-verified on the A17 profile: hidden at spawn (ON FOOT), hidden while SWIMMING, and the gate flips to visible with the driving state signal.

## Files changed
- index.html (size 1183979 -> 1184568)

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
