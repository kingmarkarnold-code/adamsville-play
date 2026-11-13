# Release release-2026.11.13.5

Pushed 2026-11-13 07:15 UTC.

## Versions
- ui_version: 2026.11.13.4 -> 2026.11.13.5

## Changes
- Joshua's voice-call list (Nov 13), items 3+5+6 — index.html only. ITEM 3 (UI panel): the 'big empty dark panel' in his screenshot is the #street-name pill — it drew its dark background at the layout's fixed width even with NO street named (woods at 535); the updater now hides it while the label is empty (and it starts hidden), a real name brings it back, layout-hidden still wins. DOM probe before: #street-name rect 300x24 bg rgba(0,0,0,.5) text ''. After: display none, 0x0 at spawn, zero page errors. ITEM 5 (energy drink): the can at 535 (HOME-10,+5) is now an Energy Drink (kind energydrink, black can + volt-green band); ACTION pickup -> inventory; selecting it turns ACTION into USE (not Equip); USE restores ENERGY to 100 (both pools) and consumes one can; legacy soda cans in old saves count as the same drink. Verified end-to-end through the real UI in a headless boot: pickup -> row 'Energy Drink' -> ACTION 'USE' -> energy 25 -> 100 -> can consumed. ITEM 6 (flashlight): the equipped light no longer hovers in front of the player — the hand mesh re-parents into the hero's RightHand bone when the GLB rig loads (probe: __flashBone='RightHand'; primitive fallback keeps the mesh hold), the beam leaves from the hand's real world position along Joshua's ~15-degree hold angle, and the spot is brighter (intensity 60 -> 150, throw 35 -> 50). Night boot shot: bright pool ahead, lens dot at his hand, ACTION reads UNEQUIP. Items 1+2 of the same list shipped earlier tonight (.13.2/.13.3 roses, .13.4 trees/portrait). Item 4 (shoreline panels) is diagnosed, not in this push — see BUILD-NOTES in fixes-2026-11-13-joshua-list.

## Files changed
- index.html (size 1393716 -> 1395605)

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
