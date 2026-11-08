# Release release-2026.11.08.11

Pushed 2026-11-08 20:39 UTC.

## Versions
- ui_version: 2026.11.08.10 -> 2026.11.08.11

## Changes
- Time Control + World Calendar (Joshua 2026-11-08): shared calendar in daycycle.js anchored at GO-LIVE DAY ONE = October 9, 2026 (one named constant, GO_LIVE_DAY_ONE); window.__WORLD_CALENDAR published (today/dateForDay/skipDays/jumpToHour/overrides/passcode). Season effective = override ?? calendar season, driving HUD + __trees.setSeason via one applySeason(); weather override holds the existing weather machine at rainy (rain visuals + ambient rain audio follow). Time Control section inside Advanced Properties behind passcode 920 (check lives only in daycycle.js): date readout at top of the section, Skip +30/+180 days (time of day preserved), Jump to 2 AM / 3 AM, season override Auto/Winter/Fall, weather override Auto/Rainy day; overrides persist in sa_timecontrol_v1. Boot-proven on shipped bytes; regressions green (joints 75, wildlife-pass 34, content-launch 84, bed-carve 21, divefix 36, controls verify, roses quest).

## Files changed
- daycycle.js (size 21675 -> 28435)
- index.html (size 1308476 -> 1314490)

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
