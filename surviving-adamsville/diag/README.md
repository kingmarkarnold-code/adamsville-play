# Surviving Adamsville: Mollie's Edition — Municipal QA Crew

The computer-side inspector rig. (The phone game keeps the name
**Surviving Adamsville** — this edition lives on the computer.)

Joshua's idea: like real-world road crews, AI inspector cars drive every street
in the game and report what's wrong. One crew, one report, filed with the
**Code Enforcement Office** (central intranet endpoint).

## Run

```bash
cd ~/workspace/game-map/project
node inspect-roads.js              # single run → game-map/diag/road-inspection.json
node inspect-roads.js --every 10m  # interval mode: full inspection every 10 minutes
node inspect-roads.js --every 30s  # any unit: s/sec, m/min, h/hr
```

- **Single run** writes `~/workspace/game-map/diag/road-inspection.json` (canonical latest).
- **Interval mode** becomes a dispatcher: every cycle it spawns a fresh child
  (no shared state, re-reads the game data) that writes a **timestamped**
  report `road-inspection-YYYYMMDD-HHMMSS.json` **plus** the canonical latest.
  Every cycle files a report — even when everything is fine ("all clear"
  reports count). Stop with Ctrl-C.
- Runtime: ~40s per full inspection on this machine.

## Architecture

```
inspect-roads.js          # entry: loads data, runs the crew, prints summary
diag/office.js            # CodeEnforcementOffice — central aggregator module
```

Teams never report to the parent directly. Each team files findings via
`office.submit(teamId, finding)`; the office stamps every finding with the
team's **vehicle identity** and compiles the ONE consolidated JSON.

## The crew (one team, four units)

| Unit | Agents | Vehicle (tagged on every finding) | Job |
|---|---|---|---|
| Road Crew | 16 inspectors, one per map zone (4×4) | DOT pickup — orange/white | Drive every road run; 5 defect checks |
| Code Enforcement | 4 agents, one per district (2×2) | sedan — white/blue stripe | Replicate building placement; 6 violation checks |
| City Planner | 1 agent | van — municipal green | POI real-world location checks |
| City Inspector | 1 agent | SUV — safety yellow | POI placement checks |
| Traffic Engineering | 1 agent | utility truck — yellow/black chevron | Intersection audit: traffic-control needs + misplaced signs |

## What gets checked

**Roads** (per run, replicating the game's own pipeline: clip → densify →
`roadSitY` → `smoothHeights`, plus the MLK ramps/deck and Fulton Industrial):
- `gap` — road ends with no connecting road (>80u to nearest, not at map border).
  Highway corridors get an extra same-name continuity audit (catches I-75-class holes).
- `roughness` — road bumpier than the terrain under it (v1.8 z-flip class).
- `floating` / `buried` — ribbon >3u above or >0.5u under the visible terrain.
- `markings` — width/lanes don't match the road class.
- `cliff` — height step >2.5u along a run, or >1.5u at a joint between
  same-named (or very close) roads.

**Buildings** (placement protocol replicated exactly: road-clearance check,
spiral nudge, skip):
- `on-road`, `in-water` (lake/pond/creek), `floating`, `buried`,
  `overlap` (>25% of smaller footprint), `spec` (bad dims/type/nudge).

**Furniture** (Traffic Engineering — replicates the game's `streetFurniture()`
intersection model exactly, then audits it):
- Intersections: points where ≥2 differently-named roads come within 22u,
  deduped to 40u cells. Merges (crossing angle <25°) are continuations, not
  crossings. Same-corridor alias pairs (I-85 = State Rte 403, etc.) are
  flagged `phantom-intersection`, not real crossings.
- `light-needed` — arterial×arterial or highway×arterial (incl. ramp
  terminals) with no traffic light within 70u. Notes when the game's 30-light
  cap is exhausted.
- `stop-needed` — local×arterial, local×highway, or locals meeting at a
  confusing angle (25–60°), with no stop sign within 70u and no light already
  serving it. Notes when the game's 80-stop cap is exhausted.
- `sign-misplaced` — a placed light/stop/name-sign that is orphaned (>100u
  from any intersection), inside the road corridor (blocks traffic), or >25u
  from the road edge (adrift).

**POIs** — churches, schools, businesses, civic landmarks (registry transcribed
from the LANDMARKS section of `www/index.html`):
- Planner: lat/lon converts, in-bounds, no duplicates; roll-call by kind
  (church / school / business). Notes when a kind has nothing placed yet.
- Inspector: boxes sit on terrain, off roads, out of water, collider sane;
  vacant lots (Techwood) stay vacant.

## Report format

```json
{
  "generated": "...", "crew": "Adamsville Municipal QA Crew — one team, one report",
  "office": "Code Enforcement Office (central filing)",
  "summary": "CREW REPORT: 332 road issues (...) · 2733 building violations (...) · 22 POI flags (...) — filed with the Code Enforcement Office",
  "sections": {
    "roads":     { "unit", "vehicle", "agents": [...], "summary": {...}, "issues": [...] },
    "buildings": { "unit", "vehicle", "agents": [...], "summary": {...}, "issues": [...] },
    "furniture": { "unit", "vehicle", "agents": [...], "summary": {...}, "issues": [...] },
    "pois":      { "unit", "vehicles": [...], "agents": [...], "summary": {...}, "issues": [...] }
  }
}

### Furniture issue schema (for the watcher)

```json
{ "crew": "furniture", "team": "furniture",
  "unit": "Traffic Engineering", "vehicle": "utility truck — yellow/black chevron",
  "x": 4230.0, "z": 1972.9,
  "type": "light-needed | stop-needed | sign-misplaced | phantom-intersection",
  "severity": "high | medium",
  "detail": "human-readable, e.g. 'no traffic light within 70u of highway×arterial crossing (I- 285 / Bankhead Hwy NW, angle 90°) — game light cap (30) exhausted'",
  "intersection": { "x": 4230.0, "z": 1972.9 },
  "roads": ["I- 285", "Bankhead Hwy NW"], "cats": ["highway", "arterial"], "angle": 90,
  "item": "light | stop | name", "name": "I- 85" }
```

- `light-needed` / `stop-needed` carry `intersection`, `roads`, `cats`, `angle`.
  Render the marker at `intersection` (or `x`,`z` — same point).
- `sign-misplaced` carries `item` (which sign type) and `name`. Render at `x`,`z`.
- `phantom-intersection` carries `count` + `example`; one per run, informational.
- Suggested watcher colors: `light-needed` red, `stop-needed` amber,
  `sign-misplaced` purple, `phantom-intersection` gray.
```

Every issue carries `team`, `unit`, `vehicle` — the office report always shows
whose vehicle found what. Severities: `critical` / `high` / `medium` / `low` / `info`.

## Known limitations (honest)

- The rig replicates the game's math from `www/` **as of run time** — it tests
  current data, not a pinned version.
- Placed-furniture positions are replicated from the game's `streetFurniture()`
  algorithm (same intersection model, same 30/80/50 caps); the exact 30 lights
  chosen on-device may differ slightly if the game's road order differs.
- NPC dispatch-call data (in-game glitch reports phoned in to the dispatch
  center) is live on the phone, not visible to this static rig. If a
  `game-map/diag/npc-dispatch.json` file is ever exported with entries shaped
  like `{npc, x, z, what, why, problem, t}`, a future rig pass can ingest it as
  a fifth evidence source for furniture needs.
- The v1.8 device report's I-75 (1969u) / I-20 (288u) highway gaps were measured
  on raw TIGER data **including off-map segments**; in-world corridors check out
  continuous in this rig. Both views are in the record.
- The POI registry is hand-transcribed from `www/index.html`; if landmarks move
  in the game, update the `POIS` table in `inspect-roads.js`.
- `overlap` flags pairs; dense OSM blocks (e.g. townhouse rows) can produce many
  — the `high` (>50%) ones are the priority.
- Interval mode re-reads all data files every cycle, so back-to-back runs after
  a game edit test the new build.
