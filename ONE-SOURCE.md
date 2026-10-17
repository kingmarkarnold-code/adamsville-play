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

### 3.1 `index.html` — two parallel builds of the same game page ⚠️ the big one

The two copies grew into **two different implementations of the same
features** (529 lines only in the canonical copy, 258 only in www,
across 108 spots):

- The **canonical** copy has the road material-snap code
  (`roadMatY` — roads sit on the grass material, added 2026-10-12)
  which **www does not have at all**, and reports `APP_VERSION 1.15.0`.
- The **www** copy has its own zone-picker/advanced-properties build,
  small style differences in the unlock panels, a newer terrain
  cache stamp (.197 vs .195 — the terrain data file itself is
  identical), and the two loader tags for the modules below.
- Neither copy is simply "the newer one". A real merge — taking the
  best of both, once — is a task of its own, and it needs Joshua's
  go because it changes game code.

### 3.2 `input_diag.js` + `keyboard_remap.js` — www-only modules

Input diagnostics and the keyboard-remap backup controls (both
Joshua's, 2026-10-16) were built **into the dev copy only**. www's
`index.html` loads them and www's `ui-manifest.json` lists them; the
canonical tree has neither the files nor the listings. They travel
with exception 3.1 — when index.html is merged, these either move
into the canonical tree (one source) or are retired, by Joshua's word.

### 3.3 `ui-manifest.json` — preserved with index.html

It lists www's index.html fingerprint and the two www-only modules,
so it must stay consistent with www's real file set. Once 3.1/3.2 are
resolved, this file goes back to being generated like all the others.

### 3.4 `github-config.js` — the credential file

The canonical copy has the in-game report token **blanked**; www
still carries a token value — the old one GitHub invalidated on
Oct 11, so it cannot send reports either way. A build script never
copies credential files in either direction, so the generator leaves
both copies alone. (Token renewal itself is Joshua's, deferred at
his word on Oct 16.)

### 3.5 `player.png` — referenced everywhere, filed nowhere

Both index.html copies reference `player.png`, and the APK bundle
has the file (689 KB) — but **the canonical tree does not**. If www
were generated with no exceptions, the player would lose its image
in the APK. The generator preserves www's copy. The one-source fix
is to add `player.png` to the repo's `detailed/` — a five-minute
job, held for Joshua's go only because it changes what the repo
serves to the web build too.

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
