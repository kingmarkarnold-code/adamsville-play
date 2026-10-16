# Adamsville Watcher

**Surviving Adamsville: Mollie's Edition — Watcher**

Live at **https://kingmarkarnold-code.github.io/adamsville-watcher/** — open it
in any browser, no download needed.

Five views, one review loop:

- **2D Map** — top-down watch room for the municipal QA crew. Watch the AI
  inspector teams patrol live, see every issue flag they filed, follow any
  unit around the map.
- **3D Explore** — fly-through 3D view of the game map (terrain with the
  road-pass lift hills, roads, 13,000+ buildings, exit signs, traffic-light
  markers, water, landmarks). WASD/arrows + mouse-drag on desktop; touch
  controls on phone. Built for reviewing structures and terrain changes.
  Buildings render at their game-placed positions (the game's nudge/skip
  placement protocol is replicated, so what you see is what the game renders).
- **Characters** — parametric 3D editor for the game's people (see below).
- **Buildings** — flip through every building in 3D, adjust
  height/footprint/roof/colors, and run the pre-compile QA checks
  (on-road violations, wrong-facing). Submit per-building feedback.
- **Vehicles** — the game's vehicles in 3D: the main van built to Joshua's
  spec (70s/80s two-tone conversion van, every door opens, visible interior)
  plus the sedan. Adjust dimensions/colors, toggle doors, submit feedback.

## Standing pre-compile QA gate (Joshua's rule)

Before anything is published or compiled, the double-check runs **in order**:

1. **Roads verified** — the road network is correct.
2. **No buildings on the (adjusted) roads** — no building/house footprint
   intersects a road corridor.
3. **Buildings face the street** — every building's front (+Z, entrance side)
   faces the street so the entrance is reachable from the road — UNLESS the
   building has a parking lot, in which case the front faces the lot (which
   itself connects to the street).

The **Buildings** tab runs checks 2 and 3 automatically against every
building at its game-placed position:

- **On-road violations** — rig-confirmed (from the inspector's own findings)
  plus computed in-view. Each row has a one-tap **Submit →** that opens a
  pre-filled `building-feedback` issue.
- **Possibly wrong-facing** — heuristic: no road within 200u inside the
  front 120° sector. Tap **🅿 lot** to exempt a building that has a parking
  lot (persisted in the browser); **Submit →** files the violation.

## The feedback loop

This is how map review reaches the builds:

1. **Explore** — fly through the 3D view (or pan the 2D map).
2. **Tap** — tap any building, road, sign, place, or flag → a comment box pops up.
3. **Note** — type what you see ("this building is too tall", "this road still floats").
4. **Submit** — open the 📝 Feedback panel, hit **Submit feedback →**. It opens a
   pre-filled GitHub issue in your browser; hit Submit there and the report
   lands directly in this repo as a `feedback`-labeled issue.
5. **Muse reads** — before every fix pass and every game compile, Muse reads
   the open `feedback` issues and works them as the fix list.

No tokens in the page, no copy-paste. The issue format is stable Markdown:
`# Map Feedback — YYYY-MM-DD` with one `## N. [type] name` section per note
(object type, name, map coords, your words).

## Character Studio

The **Characters** tab is a parametric 3D editor for the game's people:

- **Archetype switcher** — Main Character | Adult Man | Adult Woman | 16-Year-Old
  Boy. Defaults match the game code (`buildHero()` in `www/index.html`,
  `renderNPCs()` dims in `www/npc_system.js`); NPC colors start from the
  game's SKINS/SHIRTS/PANTS palettes.
- **Parametric sliders** — head, torso, arms, legs, overall height. These change
  the model's numbers (lengths/widths), not sculpted mesh.
- **Colors** — palette swatches + custom color pickers; 💾 Save my look stores
  the design in the browser.
- **Suggest changes** — notes box + **Submit character feedback →** opens a
  pre-filled GitHub issue (label `character-feedback`) containing the full
  recipe JSON. Muse reads `character-feedback` issues before character work
  and rebuilds the design verbatim in the game code.

## Buildings Studio

The **Buildings** tab covers the game's structures (`OSM_BUILDINGS` —
`[x, z, width, depth, height, type]`, type 0 house / 1 commercial /
2 apartment-large / 3 other):

- **Browser** — type filter (All/Houses/Commercial/Apartments/Other),
  Prev/Next, 🎲 Random, 📍 Near landmark. The 3D preview rebuilds the game's
  construction (box body + pyramid roof) with your numbers.
- **Parametric sliders** — height, footprint width/depth, roof height, roof
  style (pyramid/flat), body + roof colors.
- **QA checklists** — on-road violations and wrong-facing (see QA gate above),
  each row with one-tap submit.
- **Suggest changes** — notes box + **Submit building feedback →** opens a
  pre-filled GitHub issue (label `building-feedback`) with the building's
  ID/coords/type plus the recipe JSON. Muse reads `building-feedback` issues
  before fix passes and compiles.

## Vehicles Studio

The **Vehicles** tab covers the game's vehicles:

- **Main Van (your spec)** — 70s/80s full-size two-tone conversion van
  (brown lower + tan/gold upper, dark dividing stripe), modeled from Joshua's
  photo. **Every door opens**: front driver + passenger (hinged), right-side
  sliding door (slides rearward), double rear doors — with a modeled interior
  (floor, dashboard, left-hand-drive steering wheel, front seats, rear
  benches) visible when doors open. Toggle each door; Open all / Close all.
  In the game the action menu offers ENTER vehicle or OPEN door per door.
- **Sedan** — the game's `sedanMesh()`: body color + dimension sliders.
- **Suggest changes** — notes box + **Submit vehicle feedback →** opens a
  pre-filled GitHub issue (label `vehicle-feedback`) with the full recipe
  JSON. Muse reads `vehicle-feedback` issues before vehicle work and builds.

## How to open it

- **Recommended:** the live link above, in Firefox/Chrome on phone or laptop.
- **Offline:** the page also works from local files (open `index.html`).

## What you see (2D)

- **Roads** — thin gray lines (highways drawn wider/tan). **Water** — Tatum
  Lake, the pond, the creek in blue. **Buildings** — small dots.
  **POIs** — named landmarks (home is red).
- **Moving dots** = live inspector units, colored by team (see legend):
  - Orange — Road Crew ×16 (patrol the streets, zone by zone)
  - Blue — Code Enforcement ×4 (walk the buildings)
  - Green — City Planner · Yellow — City Inspector (tour landmarks)
- **Faint gray dots** = residents going about their day.
- **Diamond flags** = issues filed with the Code Enforcement Office, colored
  by severity (red critical → gray info).

## Controls

| Action | Laptop | Phone |
|---|---|---|
| Pan | drag | 1-finger drag |
| Zoom | mouse wheel | pinch |
| Follow a unit | click it | tap it |
| Issue details | click a flag | tap a flag |
| Stop following / close | Esc or click empty map | tap empty map |

The header shows the crew's latest report summary. Layer toggles (roads,
buildings, people, flags) are in the legend panel.

## Data

`world.js` is a compact snapshot built from the game's real files
(`project/www/roads.js`, `osm_buildings.js`) and the real inspector report
(`diag/road-inspection.json`) — the same logic as `project/inspect-roads.js`.
Regenerate it after game data changes:

```
cd ~/workspace/game-map/watcher
node build-world.js
```

The unit motion is a live patrol simulation over the real road network; the
issue flags are the crew's actual findings.

## Files

- `index.html` — the viewer page (2D Map + 3D Explore + Characters + Buildings + Vehicles tabs, feedback UI)
- `app.js` — 2D canvas viewer (no dependencies)
- `explore3d.js` — 3D fly-through view (Three.js, lazy-loaded); buildings render at game-placed positions (nudge/skip protocol replicated)
- `feedback.js` — in-map feedback: tap-to-note, staged list, GitHub issue submit
- `studio.js` — Character Studio: 3D preview, parametric sliders, color
  customization, save-look, GitHub issue submit (Three.js + face.js lazy-loaded)
- `buildings.js` — Buildings Studio: 3D preview, parametric sliders, QA
  checklists (on-road violations, wrong-facing with parking-lot exemptions),
  GitHub issue submit (Three.js + osm_buildings.js lazy-loaded)
- `vehicles.js` — Vehicles Studio: spec van with working doors + interior,
  sedan, parametric sliders, GitHub issue submit (Three.js lazy-loaded)
- `face.js` — hero portrait face texture (`FACE_WEBP_DATAURL` from the game, lazy-loaded)
- `world.js` — compact world + findings snapshot (~1.3 MB)
- `heightfield.js` — precomputed terrain heights for the 3D view (100×150 grid)
- `three.min.js` — Three.js (same build the game uses)
- `osm_buildings.js` — full building footprints for 3D (x,z,w,d,h,type)
- `exit_signs.js` — placed exit signs for 3D
- `build-world.js` — regenerates `world.js` from game data
