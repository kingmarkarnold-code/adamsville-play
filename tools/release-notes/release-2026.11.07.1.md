# Release release-2026.11.07.1

Pushed 2026-11-07 16:43 UTC.

## Versions
- ui_version: 2026.11.05.1 -> 2026.11.07.1

## Changes
- Play-test fixes 2026-11-07 (Joshua's 'Game Test' list): (1) action button touch — pointerdown binding added, click kept for mouse/keyboard, one tap = one action; (2) HUD clock now 12-hour with AM/PM; (3) night lighting — hemisphere light colours ride the daycycle keyframe curve + deeper night floor, package water shader darkens via daycycle light level (sky darkened but world didn't); (5) trees-in-creek — placement now tests the true water ring polygons + stream half-width with a 3u bank margin (waterClearForTree); (6) browser-reload resume — ui_update_flow auto-saves the player's spot every 10s + on page hide, so a browser-forced reload resumes in place without the options menu. Items 4 (creek planes) unchanged: data/code verified single-sheet per stream.

## Files changed
- daycycle.js (size 18081 -> 21011)
- index.html (size 1196376 -> 1202727)
- ui_update_flow.js (size 35396 -> 38981)

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
