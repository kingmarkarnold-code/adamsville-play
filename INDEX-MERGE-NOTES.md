# Index Merge Notes — one canonical game page (2026-10-17)

Joshua's ruling (2026-10-17 17:05 EDT): *"Do the merge by renaming the
older versions, [take] the needed code to a new file with the proper
file name. This creates two backups if needed."*

## Method (his, followed exactly)

1. **Backups first.** Both pre-merge copies were copied, renamed, and
   checksum-verified in `~/workspace/game-map/backups/2026-10-17-merge/`:
   - `index.html.from-play` — sha256 `4384965f…` (961,025 B)
   - `index.html.from-www` — sha256 `a973af66…` (945,662 B)
   - `ui-manifest.json.from-play` — sha256 `1a58a6ed…`
   - `ui-manifest.json.from-www` — sha256 `e9e713f3…`
2. **A new file was composed** from the canonical (play) build plus the
   three things www had that play didn't (below), and installed as
   `play/detailed/index.html` — neither old copy was edited in place.
3. `input_diag.js` + `keyboard_remap.js` were copied byte-for-byte from
   www into the canonical tree (sha256 `6bd68789…` / `0fbedc5c…`).
4. The canonical `ui-manifest.json` was regenerated for the merged
   page (77 entries, all sizes/fingerprints verified against disk)
   and `ui_version` bumped **2026.10.16.203 → 2026.10.17.1**.
5. All four files were pushed to the repo and read back
   **byte-identical** (commits `331c97e9` index.html, `59f1a498`
   input_diag.js, `e2258dcd` keyboard_remap.js, `67769953`
   ui-manifest.json).
6. The generator's exception list shrank to **`github-config.js`
   only**; www regenerated; `generate-www.js --check` **passes** —
   the two trees now hold identical index.html / ui-manifest.json.

## The diff, classified (59 differing spots)

- **(a) Canonical-only features/fixes — kept: 40 spots.** Everything
  www never received from the 2026-10-12 work: the material system
  (roadMatY + ribbon drape + lane-dash drape, v1.62/1.63 surfaceYAt
  car placement), the collision audit (colliders matched to objects,
  v1.60/1.61), the chunk-culling offset fixes (v1.61), the van /
  parked-car spawn retries (v1.61/1.62), the hero-house data loader
  (v1.66), and the 1:1 rescale of the 535 area — creek, driveway,
  mailbox, anchors (v1.65).
- **(b) www-only features — ported in: 1 spot.** The two loader tags
  (`keyboard_remap.js`, `input_diag.js`) after `gamepad_input.js`,
  in www's exact position, plus the two module files themselves.
- **(c) Same feature, two implementations — canonical kept: 16
  spots.** Mostly comment wording (8 spots) and equivalent code.
  The real ones are flagged below.
- **(d) Stamp difference — newer value taken: 1 spot.** Terrain
  cache stamp `.195` (play) → **`.197`** (www). The terrain data
  file itself is byte-identical in both trees.
- **Version constant — aligned: 1 spot.** See below.

## Behaviour-relevant conflicts (canonical won — for Joshua's eye)

1. **Zone picker + Advanced Properties wiring** (the STEP2 unlock
   UI, one big rewrite spot + its CSS). Two complete implementations
   of the same feature. Canonical's was kept whole (its CSS and its
   rendering code match each other). www's version differed in
   plumbing, not in behaviour: a name-lookup helper instead of
   `ZoneUnlock.zoneById`, status tags built as DOM nodes instead of
   HTML with inline colours, dimming via a CSS class (55%) instead
   of inline (65%), and re-focusing the password field after a
   wrong try. Same passwords, same locks, same messages either way.
2. **GPS destination pin.** www redrew the full map after a pin was
   dropped; canonical **closes the map** (Joshua's v1.62 spec: the
   HUD arrow takes over guidance). Canonical kept.
3. **Creek position (www data was stale, class (a) but visible).**
   www's creek still sat at pre-rescale coordinates; canonical's
   v1.65 rescaled path is what the merged page draws.
4. **`clampToStage` null guard.** www returned early on a missing
   entity; canonical has no guard. The function is only ever called
   with the player or the car, which always exist — no live
   behaviour difference; noted for completeness.

## APP_VERSION decision

Both copies were wrong, differently: play said **1.15.0**, www said
**1.12.3**, and the shipped game is **APK v1.18.0**. The constant is
display-only (it stamps the HUD subtitle, the version tag, and the
help title — nothing compares it to anything), so the merged file
sets **`APP_VERSION = '1.18.0'`** to match the shipped APK. The web
HUD will now read "demo v1.18.0".

## Verification (in the shipped files themselves)

- Merged file vs old play copy: exactly the 3 intended changes
  (stamp, APP_VERSION, loader tags) — every other byte is canonical.
- Residual sweep: every key function (`roadMatY`, `showZonePicker`,
  `renderAdvZones`, `spawnPlayerVan`, …) defined **exactly once**;
  each module loader tag appears exactly once.
- Syntax: all **238** `.js` files in both trees + all **4** inline
  script blocks of the merged page pass `node --check`.
- Loader list: the merged page's 76 deferred loaders are exactly
  www's shipped set (play's set + the 2 modules); every file exists
  on disk; manifest self-consistency 77/77.
- Generator `--check`: **passes**; remaining sanctioned differences
  are `github-config.js` (credential file — untouched, exception
  3.4 stands) and the www-only deployment files `setup.html` +
  `player.png` (exceptions 3.5/3.6 stand).
- **No headless render was possible on this machine** (no browser
  binary installed), so per Joshua's proof standard this merge is
  verified by bytes, syntax, and consistency — it is *proven* when
  he loads the web player / reopens the app and sees it run.
