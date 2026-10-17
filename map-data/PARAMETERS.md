# Surviving Adamsville — Map Parameters (founding spec)

Locked by Joshua. The fresh map data in this repo is built against this spec.
Small tweaks pending Joshua's review (noted 2026-10-13); the structure stands.

## 1. The world & border
- Border polygon (confirmed 2026-10-07; NW vertex REVISED 2026-10-14 by Joshua):
  NW vertex at the Zaxby's pinpoint, 5090 Floyd Rd SW, Mableton — corner point
  (33.83063, -84.57853), offset west from the Zaxby's so the South Cobb Regional
  Library (805 Clay Rd SW) sits exactly 100 YARDS inside the western edge
  (buffer rule; offset recomputed 2026-10-14 against the Wendy's-anchored
  western edge, NW corner moved 48 m further west to restore the buffer) and a good portion of Clay Rd is included → downtown Atlanta NE
  extent — NE vertex REVISED 2026-10-14 (Joshua): Piedmont Rd NE & Monroe Dr NE
  junction (33.79703, -84.36902), right at Piedmont Park's SE corner (the old
  downtown point, 33.7586, -84.38908, is now an interior landmark) → SE corner
  (33.535, -84.392) — SE vertex REVISED 2026-10-14 (Joshua): the exact Taylor Rd
  & Flint River Rd junction, Riverdale (33.51822, -84.39097); the Riverdale
  apartments remain well inside → SW vertex REVISED 2026-10-14 (Joshua): the
  Wendy's at 7835 Senoia Rd, Fairburn (33.54298, -84.57762), the anchor for
  this end (the I-85 Fairburn exit, 33.53045, -84.60615, is now outside the
  border; downtown Fairburn remains inside) → back to the NW vertex.
- Read the western border northbound: US 29 / Roosevelt Hwy runs on the RIGHT
  (east) side going north. Through Fairburn it is West Broad St — there is no
  Main St in Fairburn, GA.
- Reference is CURRENT maps/imagery for what is standing. 1995 is a later,
  separate pass — except street NAMES, which keep approved 1995 names
  (Bankhead Highway, Stewart Ave).

## 2. Scale & travel
- TRUE 1:1: 1 game mile = 1,609 units; 1 unit ≈ 1 meter.
- The ruler is the main character: 6'1" = 1.85 units. Doors 6'8", stories ~10 ft,
  the Safari van ~8 ft tall.
- Real streets and real routes everywhere, but TIME is compressed: Adamsville to
  Riverdale should feel like a trip (~4-6 min at speed), never the real 45-90 min.

## 3. Terrain & elevation
- Real elevation data (USGS/SRTM), Piedmont rolling hills. Terrain mesh 600x800.
- Joshua's verified ground truths outrank the data:
  - Dollar Mill entrance hill: asymmetric ridge — gentle at 535, sustained ~9%
    climb cresting at the subdivision entrance, easing down toward MLK.
  - Tatum Lake sits ON a hill: at its north/east shore the player is BELOW water
    level; only the southwest corner (Boulder Park side) rises above it.
- Roads sit on terrain through the MATERIAL system: road surface drapes over
  grass, never buried or floating. The same material rule keeps every vehicle on
  top of whatever surface it is on.

## 4. Roads (locked specs, 2026-10-10)
- Five categories preserved: residential, minor artery, arterial/major, highway,
  interstate.
- Local streets (e.g. Dollar Mill Rd): 7.2m total, one 3.6m lane each way; no
  center line on small neighborhood streets.
- Arterials (MLK Jr Dr, Fulton Industrial Blvd, Cascade Rd): 4 lanes, ~18.4m
  total, paved center median with double yellow lines, white dashed lane lines.
- Interstates (I-20, I-285): 6 lanes (3 each way), 3.6m lanes, 3m shoulders,
  double-yellow median lines, white dashed lane lines.
- Sidewalks: 1.5m wide, SPORADIC — near commercial areas only, NOT continuous
  on arterials.
- Intersections: arterials get traffic lights; neighborhood intersections get
  stop signs on the minor road; subdivision interiors get no signs.
- Bridges/overpasses ONLY where real ones exist — never invented. I-20 runs
  at-grade through Adamsville; cross streets go over it. Verified: on MLK toward
  Fulton Industrial you pass UNDER I-20, and again under a second bridge after
  turning left onto Fulton Industrial. Ramps: single lane, smooth merge,
  guardrails on the OUTSIDE of curves only.

## 5. Water
- Real water, real shapes: Chattahoochee River, Flint River, Utoy Creek, South
  Utoy Creek, Nickajack Creek, Tatum Lake, Boulder Creek (winds around the lake
  hill), the two ponds/lakes off Dollar Mill Rd, Arnolds Lake, Mount Gilead
  Lake, Cobblestone Creek Pond.
- Mechanics: cars ford shallow water but sink around 3 ft deep; the player
  floats, then swims around 4 ft; a sunk car forces the player out into
  treading/swimming. If the player is not in the water, fish are data only —
  no fish meshes.

## 6. Buildings & placement
- Pre-build QA gate, every time: (1) verify roads are correct, THEN (2) verify
  no building sits on a road.
- Every building's front faces its street, entrance reachable from the road —
  unless it has a parking lot, in which case the front faces the lot (which
  connects to the street).
- Two tiers: HERO tier is 535 only (real house, enterable front and back, real
  window placement, walkable yard). Everything else is neighborhood tier —
  believable shells matched to local styles (Adamsville brick ranch, Riverdale
  90s suburbia, Fairburn brick row, garden apartments), no interiors.
- Buildings placed in the building editor are BAKED into game data permanently.

## 7. Home base — 535 Dollar Mill Rd SW, Atlanta, GA 30331
- Ridgecrest Forest subdivision, on a street curve with a slight decline after
  it — a neighborhood, not a lone house.
- Driveway follows the terrain; the van parks in it. Verified game position
  (1938.0, 6791.3); driveway parking (1935.5, 6813.3).
- Behind the house: a half-court basketball court, goal fastened to a TREE,
  PLAYABLE. ("One thing I know for sure." — Joshua)

## 8. Collision
- Every collider matches the visible physical object — tree collision is the
  trunk, not a bubble. The player walks right up to a surface and stops AT it.
  No invisible fortresses, for any object class.

## 9. Vehicles & traffic
- NO vehicle ever drives on grass. An agent that needs to go off-road parks on
  the road, gets out, walks, comes back. Parking on home grass/driveways and
  shoulder pull-overs are the only exceptions, through the proper checks.
- Vehicles and NPCs outside the player's view are data only — no rendering.

## 10. People
- ~1,000 NPCs: adult men, adult women, a smaller number of 16-year-old boys.
  NOBODY under 16, NOBODY over 65.
- Stylized 3D-animation look for everyone, matching the main character's
  portrait — except city workers, who share ONE uniform blocky look that
  Joshua customizes himself.

## 11. Zones & streaming
- Zone transitions: ~100u overlap strips. NPC ghosts despawn after 1 game-hour
  off-screen. Weak hardware fallback: quick fade ("blink"), not fog.
- Extend the Mableton/Adamsville dividing line south past Cascade, splitting
  the area below into 70% / 30% zones. Zone unlocking and distance culling.

## 12. Named places that must be on the map
- Adamsville Rec Center at its TRUE spot (3201 MLK Jr Dr SW — 2+ miles from
  535, NOT next door) — world-scale sanity check.
- Fulton County Airport–Brown Field (33.77716, -84.52134) on MLK toward Fulton
  Industrial, with parked airplanes.
- Car wash on Bakers Ferry Rd toward MLK.
- Riverdale High School, 160 Roberts Dr, Riverdale.
- Riverdale apartments: south of the school on Roberts Dr, just past the Hwy
  138 light, east side heading south (exact complex TBD, Joshua's 2009 memory).
- Harper Archer High School (story location).
- MARTA: bus model, train model, stations — queued.

## 13. Process rules
- NEVER delete a map element unless the data AND all sources say it does not
  belong. When in doubt: keep it, flag it for Joshua, find another fix.
- Joshua's geographic memory outranks map/code data whenever they disagree.
- Game logic stays simplistic and sim-natured; world accuracy is the point.
- Stylized look stays — no chasing higher resolution or photorealism.
- All editors pull from the game's actual data as source of truth. No editor
  maintains its own separate list.

## Addendum (2026-10-14, Joshua)
- The border polygon is a DATA boundary ONLY — never render it in the game.
  The first build showed a red line around the map in-game; Joshua ordered it
  removed. Resource/reference maps may show the outline; the game must not.
- Resource maps: `resource-map-1-roads-water.html` (roads + street names,
  water, parks, golf, railroads, bridges/overpasses) and
  `resource-map-2-places.html` (businesses, gas stations, schools, churches,
  all named places) are the standing reference — check them before
  re-researching anything on Google.
- Railroads and bridges/overpasses are first-class map data (railroads.geojson,
  bridges.geojson), per Joshua 2026-10-14.

## Addendum 2 (2026-10-14, Joshua) — game map stage
- A GAME MAP now lives in `game-map/` in this repo, converted only from the
  reference maps above: roads, water, 166,816 building footprints, named
  places, and a ~31.8 u heightfield. Origin (0,0) = 535 Dollar Mill Rd;
  1 unit = 1 meter. See `game-map/README.md`.
- For THIS stage the goal is the real world as close to Google Maps as the
  data allows, turned into a 3D world. Name changes and Joshua's specific
  requested buildings are DEFERRED — they layer on later.
- Airports belong on the Places map (Map 2) as their own layer.
