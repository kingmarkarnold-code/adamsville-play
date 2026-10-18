# One Source — how the game and its stock are organised

*Joshua's directive, 2026-10-17: "Web, Dev, and APK should always load
with the new edits on all resources... there shouldn't be a bunch of
copies of files, it should be that everything is linked so that what
happens in one thing happens to the other. The only thing that should
be different is how the game is deployed and the different UIs for
different screens and systems."*

This document is the plain-language record of that architecture: what
was true before, what is true now, and the short list of exceptions
that still need Joshua's ruling.

---

## 1. The one tree

There is exactly **one canonical set of game resources**:

- **On GitHub:** the `detailed/` folder of the `adamsville-play` repo.
- **On this machine:** `~/workspace/game-map/play/detailed/` — the
  working mirror of that same folder. Edits are made here and pushed;
  what is pushed is what the repo holds. Same files, two places,
  one truth — and the push/read-back check proves they match.

Every deployment is a way of *delivering* that one tree, never a
separate copy of it:

| Deployment | How it gets the one tree |
|---|---|
| **Web** | GitHub Pages serves the repo's `detailed/` directly. Nothing to copy. |
| **Dev / APK bundle** | `project/www/` is **generated** from `play/detailed/` by `pipeline/generate-www.js`. Nobody edits www by hand any more. `build-apk.sh` regenerates www and verifies it (`--check`) before staging, and stops the build if www is stale or hand-edited. |
| **APK updates after install** | The app already checks the repo at launch and downloads only changed files (the map/UI delivery system), so a fix pushed once reaches installed phones on its own. |

The only differences allowed between deployments:

- **How they are deployed** — Pages serving files vs. the Android
  shell wrapping the same files (the APK's first-run `setup.html`
  page is part of that shell, not of the game).
- **Per-screen UI** — phones and desktops show different layouts, but
  that difference lives *inside* one file, `ui_layout.json`, as its
  Mobile and Desktop "faces". It travels with the one source; it is
  not separate files.

### The daily flow

1. Edit in `play/detailed/` — nowhere else.
2. Push to GitHub (Web now serves it; phones pick it up on launch).
3. Run `node pipeline/generate-www.js` — or just build the APK; the
   build runs the generator and its check first.

---

## 2. What the inventory found (2026-10-17)

Full recursive comparison of `play/detailed/` vs `project/www/`:

- **229 files** in the union of both trees.
- **221 files were already byte-identical** — the hand-conforming of
  the past week had kept most of the trees in step, at the cost of
  doing every fix twice.
- **1 file only in the canonical tree:** `535-building-editor-entry.json`
  (the 535 design entry; no game code loads it). Generation now
  carries it into www like everything else.
- **4 files only in www:** `setup.html` (APK setup page — deployment),
  `player.png`, `input_diag.js`, `keyboard_remap.js` — see the
  exceptions below.
- **3 files in both trees with different content:** `index.html`,
  `ui-manifest.json`, `github-config.js` — see the exceptions below.

After generation, www = the canonical tree except exactly the
sanctioned list in §3. That is verified byte-for-byte, and every
JavaScript file in the generated tree passes a syntax check.

---

## 3. Exceptions — flagged for Joshua's eye

Generation **preserves** these untouched. None of them was silently
overwritten in either direction, because each one holds something the
other side does not have. They stay on this list until Joshua rules.

### 3.1 `index.html` — two parallel builds of the same game page ✅ RESOLVED 2026-10-17

**RESOLVED 2026-10-17** (Joshua's merge method: both old copies renamed
into `backups/2026-10-17-merge/`, the needed code composed into one new
file): the merged page is canonical's build (material road-snap, the
v1.60–v1.66 fixes, the rescaled 535 area) plus www's keyboard-remap /
input-diagnostics loader tags and www's newer terrain cache stamp;
`APP_VERSION` aligned to **1.18.0** (the shipped APK version — the two
copies said 1.15.0 and 1.12.3). Full feature-diff table:
`INDEX-MERGE-NOTES.md`.

The two copies had grown into **two different implementations of the
same features** (529 lines only in the canonical copy, 258 only in
www, across 108 spots): canonical held the road material-snap code
(`roadMatY`, 2026-10-12) www lacked entirely; www held its own
zone-picker/advanced-properties build and the two module loaders.

### 3.2 `input_diag.js` + `keyboard_remap.js` — www-only modules ✅ RESOLVED 2026-10-17

**RESOLVED 2026-10-17**: both modules were copied byte-for-byte into
the canonical tree, are loaded by the merged page, and are inventoried
in the canonical `ui-manifest.json`. One source, like everything else.

### 3.3 `ui-manifest.json` — preserved with index.html ✅ RESOLVED 2026-10-17

**RESOLVED 2026-10-17**: the canonical manifest was regenerated for
the merged page (77 entries, self-consistency verified) with
`ui_version` bumped to **2026.10.17.1**; the file is generated into
www like all the others again.

### 3.4 `github-config.js` — the credential file

The canonical copy has the in-game report token **blanked**; www
still carries a token value — the old one GitHub invalidated on
Oct 11, so it cannot send reports either way. A build script never
copies credential files in either direction, so the generator leaves
both copies alone. (Token renewal itself is Joshua's, deferred at
his word on Oct 16.)

### 3.5 `player.png` — RESOLVED 2026-10-17 (Joshua's one-source picture ruling)

**RESOLVED 2026-10-17:** the portrait now lives in the canonical tree
as **`player.gif`** — converted from the PNG by Joshua's ruling ("create
the one-source picture, but change it to a gif, cause we will be
changing this image later"). The PNG master is preserved untouched in
`game-map/backups/2026-10-17-merge/player.png.master-original`. The
GIF is 1024×2048, 240,372 bytes (PNG was 689,006); its alpha is the
PNG's silhouette thresholded at 50% (GIF transparency is all-or-
nothing). The one textual reference (a stale comment in index.html)
now names player.gif, `ui-manifest.json` carries player.gif
(ui_version 2026.10.17.2), and the generator no longer preserves a
www-only player file — www generates player.gif like everything else.

### 3.6 `setup.html` — not an exception, a deployment file

The APK's first-run setup page. It belongs to the Android shell,
not the game resources, so it correctly lives only in the bundle.
Generation preserves it by design; it is listed here so the
www-only list never surprises anyone.

---

## 4. Stock resources — one library, many shelves

Joshua's example (2026-10-17): *"If I create a table that can go into
a house, it should become a part of the stock resources we have on
GitHub. That in turn makes the list in the Building Editor refresh
to show the new table."*

### The rule

**The repo is the stock library.** Anything an editor or the game
can place, pick, or list — building designs, furniture and props,
subdivisions, vehicles, music, UI layouts — lives in the repo, in
the open, where every tool reads the same list. No app keeps a
private stock list baked inside it. An editor's list on screen is a
*view* over the stock: refresh or reopen, and what another tool
added is simply there.

### Where the stock lives today (inventory, 2026-10-17)

| Stock | Home today | Who reads it | GitHub-sourced? |
|---|---|---|---|
| Building designs (the design set) | `editors/building-editor/design-buildings.json` (5 designs incl. 535) | Building Editor | ✅ downloads on open; saves push back by the round-trip rule |
| Flagged buildings list (1,532) | `editors/building-editor/flagged_buildings.json` | Building Editor | ✅ since 1.7.2 — no longer baked into the app |
| Gas-station review + station edits | `editors/building-editor/gas-station-review.json`; edits file created on first save | Building Editor | ✅ |
| Building indexes (browse lists) | `editors/building-editor/index/<zone>.json` | Building Editor | ✅ generated from the zone data; regenerated on every editor save |
| Placed buildings (166,444) | `detailed/zones/<zone>/buildings*.json` | Game + Building Editor | ✅ game data itself |
| Hero buildings (535 house) | `detailed/zones/adamsville/hero_buildings.json` | Game (renders), Building Editor (read-only) | ✅ (Adamsville is the only zone with hero data so far) |
| Gas stations (109 real) | `detailed/gas_stations_real.js` | Game | ✅ |
| Vehicles | `detailed/vehicle_meshes.js` + `vehicles-manifest.json` | Game + watcher (loads the same file live) | ✅ |
| Music | `detailed/music/` + `music-manifest.json` | Game | ✅ |
| UI layout | `detailed/ui_layout.json` | UI Editor + game | ✅ the editor edits the game's own file |
| Prop/furniture 3D models (78 .glb: tables, chairs, beds, sofas…) | `editors/map-editor/blender/assets/` — 8 categories (dining, education, hospitality, nightlife, parks, residential, retail, worship) | Map Editor's Blender work | ⚠️ in the repo, but filed under one editor — see drift notes |
| Subdivisions | `editors/map-editor/subdivisions.json` (584 B — the old "Subdivision 1") **and** the Building Editor's designated path `editors/building-editor/subdivisions.json` (not yet created — created on its first save) | Map Editor / Building Editor respectively | ⚠️ split home — see drift notes |

### The working example (proof this already works)

**Building Editor 1.7.2** is the pattern made real: it bakes
*nothing* in. On open it downloads the design set, the flagged list,
the station review list and the light building indexes from the
repo; on save it pushes back and re-downloads to prove the save.
Its lists are views over the GitHub stock — exactly the behaviour
Joshua's table example asks for. The Map Editor (1.9.4) works the
same way for map data, and the UI Editor edits the game's own
`ui_layout.json` in the repo.

### Drift-class findings (private or duplicated stock)

1. **Lists baked into the Building Editor app itself** — its code
   carries fixed vocabularies: floor-plan templates, fence styles,
   floor types, driveway materials, garage sides, the 20 placeholder
   house styles, and the decoration types (Picture Frame, Plant,
   Lamp, Rug, Curtains). Under the stock rule these belong in a
   repo data file the app downloads, so adding a decoration type
   never needs an app rebuild. *Not migrated in this task.*
2. **The prop-model library sits under one editor's folder**
   (`editors/map-editor/blender/assets/`). The models are safe in
   the repo, but a future Detail Editor — or the Building Editor —
   should find them on a shared shelf, not inside the Map Editor's
   drawer. Same-named models also repeat across categories
   (`table.glb` exists in four of them), which a shared shelf
   should organise once.
3. **Subdivisions have two homes** (table above). The Building
   Editor and Map Editor cannot see each other's subdivisions
   today. One home, chosen once, fixes it.
4. **The 535 design exists three times** — as an entry in the
   design set (the editor stock), as the standalone
   `detailed/535-building-editor-entry.json` file, and baked into
   `hero_buildings.json` (the game data). Design → bake is a real
   step (the game needs the baked form), but the standalone entry
   file duplicates the design-set entry and can retire into it.
5. **UI Editor's factory-default layout** — `editors/ui-editor/
   ui_layout_default.json` is a seed copy kept next to the editor.
   The live stock is `detailed/ui_layout.json`; the seed is
   harmless as a "reset to factory" source but should be labelled
   as such so nobody mistakes it for the live file.
6. **Legacy editor-folder data** — `editors/map-editor/` root
   still holds `buildings.json`, `roads.json`, `zones.json` from
   before the consolidation. The live data is in `detailed/`;
   these are archive-age duplicates that should be retired on
   Joshua's word, like the old repos were.

### The designated stock home (for Joshua's approval)

- **Game stock stays in `detailed/`** — buildings, heroes, stations,
  vehicles, music, layouts: the game's own shelves of the library,
  already one-source after this task.
- **Editor stock stays in the repo under `editors/`**, one file per
  kind, downloaded on open and pushed on save — the Building
  Editor pattern.
- **`editors/stock/` is designated as the one shared shelf for
  placeable items** — props, furniture, building designs — the
  things more than one editor (or an editor and the game) uses.
  When Joshua approves, these migrate there:
  the design set (from `editors/building-editor/`), the prop-model
  library (from `editors/map-editor/blender/assets/`), the
  Building Editor's baked-in vocabularies (out of app code into a
  stock data file), and subdivisions (merged to the single home).
- **The future Detail Editor creates directly into the stock** —
  a new table is saved to the shelf on GitHub, and every other
  editor's list shows it on refresh. Nothing in this task builds
  the Detail Editor or changes how the game loads props at
  runtime; this section is the map it will be built from.

---

## 5. What was built for this (2026-10-17)

- `pipeline/generate-www.js` — the generator + `--check` mode, with
  the sanctioned-differences list in its header.
- `build-apk.sh` — regenerates www and runs `--check` before
  staging; a stale or hand-edited www now fails the build.
- `project/GENERATED-WWW.md` — the marker explaining www is
  generated and how to work with it.
- `~/AGENTS.md` + `game-map/README.md` — instructions updated to
  canonical + generate. The terrain pipeline scripts were audited:
  all three already work on the canonical tree (no changes needed).
- Verification: post-generation byte-compare (222/225 shared files
  identical; the 3 differences are exceptions 3.1/3.3/3.4), JavaScript
  syntax check across the generated tree, and manifest
  self-consistency on both trees (every listed file present with
  matching size and fingerprint — the same checks that gated
  v1.18.0; www: 77 UI entries, 80 map entries, 0 mismatches).
  No APK was built in this task, and no game content changed:
  ui_version stays 2026.10.16.203, map_version 2026.10.16.10.
- **2026-10-17 (later): the index.html merge** (exceptions 3.1–3.3
  above) — one canonical game page, ui_version 2026.10.17.1, pushed
  and read back byte-identical; the generator's exception list is
  down to `github-config.js` alone. See `INDEX-MERGE-NOTES.md`.
- **2026-10-17 (later): the release tool's old www sync RETIRED —
  ✅ RESOLVED** (the caution raised in the one-source completion
  audit): `tools/release.py` Step 6 no longer hand-copies changed
  files into `project/www/detailed/` — a layout that no longer
  exists — and no longer overwrites www's `index.html` without its
  `ui-manifest.json`. Per Joshua's ruling ("Retire the old sync —
  use the generator"), Step 6 now runs `pipeline/generate-www.js`
  plus its `--check`, and a failed check aborts the release before
  the push, exactly as in `build-apk.sh`. The Pages root page
  (`play/index.html`) still mirrors a changed `index.html` directly;
  it is not generator output. Pre-change tool backed up untouched at
  `backups/2026-10-17-release-sync/release.py.before`; functional
  test evidence in `RELEASE-SYNC-RETIREMENT-NOTES.md`.
- **2026-10-17 (later): the swallowed loader tag FIXED.** The
  retirement work had found the release tool unable to publish: its
  step-3 smoke gate counted 76 `data-dsrc` loader tags in the game
  page but only 75 parsed. Cause: the `truck_restrictions.js` tag
  was never closed, so the parser swallowed the `airport.js` tag
  into its body and the airport module never loaded. Parser counts
  on both pre-merge backups prove the defect **pre-existed the
  merge** (from-play 74 text / 73 parsed; from-www 76 / 75) — the
  merge carried it over faithfully. Fix: one `</script>` added;
  loader set, order and files unchanged; page now parses 76/76 and
  the step-3 gate passes. ui_version 2026.10.17.3; the stale Pages
  root mirror (`play/index.html`, previously a 63-tag older page)
  was refreshed by direct copy of the fixed canonical page and
  pushed. Also reconciled: the tool's "80 map files changed"
  classification is a phantom — `release.py`'s config assumes the
  map manifest truncates hashes to 16 chars, but the manifest
  carries full 64-char hashes, so every entry mismatches on length
  alone; verified directly, all 80 map entries match disk exactly
  (size + full sha256). Detail in `LOADER-TAG-FIX-NOTES.md`.

---

## 6. The clean repository (2026-10-17)

Joshua's ruling, after the fossils kept surfacing one at a time
("this is like the 20th time you've said something about something
old"): rebuild the repository from what is actually used, verify it
line for line, and leave the old data behind — with a backup, always.

What happened:

- **The old repo was renamed, not deleted:** `adamsville-play`
  became `adamsville-play-archive` (full history intact), and this
  repo was created fresh under the name `adamsville-play`, so every
  existing link — the web player, the testers' bookmarks, the phone
  app's update address, the editors' paths — keeps working.
- **Before anything moved, a full local mirror of the old repo was
  downloaded and verified file by file** (534 files, every one
  matching its git fingerprint).
- **The used-list was derived, not hand-kept** — from the game
  pages' loaders, the four delivery manifests, the zone-dataset
  patterns, the editors' repo-path constants, the watcher's sync
  list and the workflow files. 474 files crossed, each
  byte-for-byte identical to the old repo (the only content changes
  are the two items below), and six new files were born with the
  repo: the inventory gate, its registry, INVENTORY.md, the stock
  shelf's charter, and the reports/ and world-fixes/ folder markers. Everything else stayed in the archive:
  the stale app snapshot under `surviving-adamsville/`, the retired
  overlay scripts, the legacy editor-folder data, the fossil root
  app, and the pre-conversion terrain lift table (its data was
  eliminated by the conversion; pins and lifts ship per-zone now).
  The full list of what did not move, with reasons, is in the
  migration record kept with the workspace
  (`CLEAN-REPO-MIGRATION-NOTES.md`).
- **The inventory gate was born with the repo** (Phase 3 of the
  migration): `INVENTORY.md` + `tools/check_inventory.py` +
  `tools/inventory-registry.json`. The used-list is regenerated from
  the code at check time — Joshua's amendment, after he caught the
  loop in keeping a roster by hand — and stock/tooling/doc files are
  legitimate when declared in the one registry. A file that is
  neither referenced nor declared fails the gate, and so does a
  reference to a file that does not exist. Follow-up left open:
  wiring the gate into `tools/release.py`'s flow.
- **The manifest registration was completed:** `ui-manifest.json`
  now registers `airport.js`, `truck_restrictions.js`,
  `water_interaction.js` and `water_render.js` — loaded by the game
  all along but in no manifest, so the APK updater would have missed
  their changes — and no longer registers the three retired
  overlays. ui_version 2026.10.17.4.
- **The stock shelf was born:** the prop/furniture model library
  moved from `editors/map-editor/blender/assets/` to
  `editors/stock/props/<category>/` (see `editors/stock/README.md`).
  The Building Editor's vocabulary shelf is designated there too;
  its data files arrive with the app change that reads them.
- `MIGRATION-MANIFEST.json` at the root is the generated snapshot
  of the move: every file that crossed, its fingerprint, and what
  uses it or declares it.

---

## 7. The developer hub (2026-10-17)

Joshua's directive, the same evening: *"make all of our HTMLs that
are on GitHub into a website — I should be able to go to one location
and click on new web pages as they're created."*

- **The repo root page is now the developer hub** — a small,
  hand-owned doorway page (the repo-root `index.html`) linking every
  page the repo serves: the game, the diagnostics and preview pages,
  the tools (including the Decision Deck, now hosted at
  `tools/decision-deck/`), and the docs. It is generated by nothing
  and mirrors nothing.
- **The game lives at `/detailed/`** — the address it has always
  had. Nothing about the game moved; only the root page changed
  tenants, from mirror-of-the-game to doorway.
- **The release tool no longer mirrors the game page onto the
  root.** The kept mirror behaviour from the loader-tag fix retired
  the same day the hub landed (dated note in `tools/release.py`):
  the root page is the hub's own file now, edited by hand and pushed
  as itself. Adding a page to the hub is one line in its marked
  link lists.
