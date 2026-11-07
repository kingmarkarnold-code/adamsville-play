# Release release-2026.11.07.21

Pushed 2026-11-07 22:14 UTC.

## Versions
- ui_version: 2026.11.07.20 -> 2026.11.07.21

## Changes
- WILDLIFE PASS (Joshua's rulings from his hands on .20; wildlife_system.js 1.2 -> 1.3): (1) SQUIRRELS BROWN (16:25) — fox-squirrel palette 0x9c6630 back / 0x6e4520 dark / 0xe2d4b8 belly, geometry and behaviour unchanged. (2) BUTTERFLIES VARIED (16:25) — six Georgia colourways (Monarch, Eastern Tiger Swallowtail, Cloudless Sulphur, Common Buckeye, Cabbage White, Eastern Tailed-Blue) dealt round-robin from a shuffle so a set always shows min(count,6) distinct species, carried on a dedicated iColor instanced attribute into the fragment diffuse (vTint); instanceColor/setColorAt removed — the path whose variety never reached his screen; program key v2. (3) DEER WILDNESS (16:36) — wildnessAt = min(building axis, road axis), 0 at the spawn minima, 1 at +120u, memoised per 25u cell/60s; spawn takes the wildest of up to 8 gate-passing anchors; group size 2 + round(2w) (tame pair -> wild 4); alert/flee radii scale (1 - 0.3w) (25/12 -> 17.5/8.4); graze circuit widens 20u -> 50u with wildness; state machine + road rule untouched. Includes one repair: the .5 deer woods gate compared the woodsScore object to a number (never true) — now compares .mean as designed. Harness 34/34 (suburb pair vs deep-woods four, end to end); regressions: wildlife .5 41/41, content-launch .18 84/84, locomotion .20 84/84, funnel .19 23/24 (1 superseded: B1b pins the VERSION literal this pass advances).

## Files changed
- wildlife_system.js (size 88569 -> 98225)

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
