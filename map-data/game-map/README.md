# GAME MAP — built from the reference maps (from scratch, 2026-10-14)

This folder is the game world data, converted ONLY from the reference maps in
this repo (roads, water, places, transit, terrain, satellite-verified). It is
completely separate from the old game's data — nothing was copied from it.

## Frame (read this first)
- Projection: local tangent plane. **Origin (0, 0) = 535 Dollar Mill Rd**
  (33.74110, -84.52645). x = meters east, z = meters south.
- **1 unit = 1 meter** (PARAMETERS §2: 1 mile = 1609 u; character 6'1" = 1.85 u).
- Heights are absolute meters above sea level (== units).

## Files
- `roads.json` — [name, osm class, width (m, per PARAMETERS §4 conversion),
  [[x, z], ...], ground profile [terrain height at each point], top material,
  bottom material] for all 65,736 drivable segments. The ground profile is
  the road's snap-to-terrain: the bottom face (roadbed) follows it exactly,
  the top face (asphalt) rides at ground + 0.55 lift.
- `water.json` — [name, "body"|"stream", [[x, z], ...]] — 1,725 features
  (lakes/ponds as body rings; rivers/streams as lines).
- `buildings.json.gz` — (gzipped; decompresses to buildings.json) [name, building type, height (m), [[x, z], ...]] for
  166,816 footprints. Height = OSM height tag, else levels x 3.1, else a
  documented default by type (house 4.5, apartments 12, commercial 7,
  industrial 8, school 8, church 9, garage/shed 3, other 5).
- `places.json` — [name, category, [x, z]] — 4,765 named places (Map 2 data).
- `materials.json` — the material table + layer order (grass 0, water 1,
  concrete/roadbed 2, asphalt 3; higher layer wins where surfaces overlap)
  and the snap rules for buildings and roads.
- `terrain.bin` + `terrain.json` — heightfield, Float32 LE, 1024 x 1536
  samples at ~31.8 u spacing; metadata gives the game-coord corners.
- `viewer.html` — 3D viewer (Three.js) over this data: terrain (decimated
  for viewing), draped roads, water, instanced buildings. Open it from the
  repo's Pages site; it fetches the data files from the same folder.
  Viewer simplifications are display-only; the data files are exact.
  (The viewer decompresses buildings.json.gz in the browser.)

## NOT applied yet (Joshua, 2026-10-14)
- Name changes and specific requested buildings (e.g. the 535 hero build)
  come later. This pass = the real world as close to Google Maps as the
  data allows, turned into a 3D world.
- Still to apply from PARAMETERS when we wire this into the game: zone
  split/unlocking, NPC data, the Dollar Mill ridge & Tatum Lake ground
  truths as checks against this terrain, collision (exact-to-object),
  and the building QA gate (no building on a road).
