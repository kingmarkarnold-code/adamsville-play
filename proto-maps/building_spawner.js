/* ============================================================================
   BUILDING SPAWNER v1.0 (2026-10-11)
   ----------------------------------------------------------------------------
   Joshua's request: spawn hand-placed "walkable" buildings from the map
   editor's buildings.json, and procedurally fill subdivision polygons from
   subdivisions.json with houses that ROTATE TO FACE THE STREET.

   Data sources (map-editor repo, fetched live at startup):
     buildings.json    - hand-authored building templates (walkable + styles)
     subdivisions.json - named polygons to fill with houses (currently empty)
     water.json        - rivers/streams (centerline + width) and lakes/ponds
                         (polygons); may not exist yet — spawner runs without it

   This module is COMPLEMENTARY to residential_detail.js, not a duplicate:
   residential_detail.js decorates OSM-derived buildings (OSM_BUILDINGS) with
   doors/windows/porches/garages. This module handles the SEPARATE map-editor
   data stream (buildings.json / subdivisions.json), which OSM code never
   touches. Two data sources, two modules, no overlap.

   What it does:
     1. Fetches buildings.json + subdivisions.json + water.json from GitHub.
        On failure it logs a warning and runs with empty arrays — the game
        never crashes.
     2. Walkable buildings (walkable:true): placed at their hand-authored
        position/rotation with full detail (walls, roof, windows, doors) and
        published on window.WalkableBuildings for the interior system.
     3. Subdivision houses: N per polygon (~1 per 2000 sq units, max 50 per
        subdivision, hard cap TOTAL for the TCL phone). Each house is rotated
        so its front_face points at the nearest (or largest, on corner lots)
        road. Rejection sampling ALSO excludes water: no spawned house may
        sit in a river, stream, lake, or pond, or within WATER_BUFFER units
        of the water's edge. Spawned as cheap InstancedMesh boxes —
        non-walkable.

   Exposed API:
     window.BuildingSpawner  = { init(), getWalkableBuildings(),
                                 getSpawnedHouses() }
     window.WalkableBuildings = [ {name, type, def, x, z, yaw, w, d, h,
                                   doors:[{x,z,yaw}], mesh} , ... ]

   Coordinate/rotation conventions (match the existing game code):
     - Building-local "front" = local +Z, exactly like bldgFaceYaw() and the
       l2w() transform in residential_detail.js. yaw = atan2(dx,dz) points
       local +Z at the road.
     - buildings.json "rotation" is editor degrees. ASSUMPTION (flagged for
       Joshua to verify against the map editor): the editor's rotation is
       clockwise when viewed from above, so rotation.y = -radians. Flip
       EDITOR_ROT_SIGN if the editor turns out to be counter-clockwise.
   ============================================================================ */
(function buildingSpawner(){
'use strict';

/* ---------- configuration (tweakables in one place) ------------------------ */
var BUILDINGS_URL   = 'https://raw.githubusercontent.com/kingmarkarnold-code/adamsville-map-editor/main/buildings.json';
var SUBDIVISIONS_URL= 'https://raw.githubusercontent.com/kingmarkarnold-code/adamsville-map-editor/main/subdivisions.json';
/* Water features (rivers, lakes, ponds, streams). The file may not exist yet
   (the map editor hasn't published it) — the loader below treats ANY failure
   as "no water data" and spawning works exactly as before. */
var WATER_URL       = 'https://raw.githubusercontent.com/kingmarkarnold-code/adamsville-map-editor/main/water.json';
var WATER_BUFFER    = 20;    // extra clearance beyond the water edge (world
                             // units) — houses should not hug the waterline
var AREA_PER_HOUSE  = 2000;  // ~1 spawned house per this many sq world units
var MAX_PER_SUBDIV  = 50;    // per-subdivision perf cap (Joshua's TCL phone)
var MAX_TOTAL       = 500;   // hard cap across all subdivisions
var MIN_SPACING     = 30;    // min center distance between spawned houses
var CORNER_LOT_DIST = 60;    // 2+ roads within this => corner lot
var ROAD_MARGIN     = 4;     // extra clearance beyond the road edge (matches
                             // the margin osmBuildings uses via placeStruct)
var GROUND_EMBED    = 0.6;   // sink bases slightly (same as osmBuildings)
/* Editor rotation sign: +1 = editor rotation is counter-clockwise from
   above (Three.js rotation.y as-is); -1 = clockwise-on-screen editor. */
var EDITOR_ROT_SIGN = -1;
/* Road class rank for corner lots: larger road wins (highway > arterial >
   local). Matches the class keys in ROAD_DATA. */
/* v2.1: new road category set (2026-10-11, Joshua). Legacy 'arterial' kept for old data. */
var CLASS_RANK = {interstate:5, highway:4, major_artery:3, minor_artery:2, arterial:2, local:1};
/* front_face -> yaw offset added to atan2(dx,dz) (local +Z = front). */
var FACE_OFFSET = {front:0, right:-Math.PI/2, back:Math.PI, left:Math.PI/2};
/* Default footprints per building type (world units; 1u ~ 1m). buildings.json
   carries no width/depth, so these are derived from the type field. Height is
   FLOOR_H * floors. */
var FLOOR_H = 3.4;
var TYPE_FOOTPRINT = {
  House:      {w:14, d:11},
  Store:      {w:18, d:14},
  Restaurant: {w:20, d:14},
  Apartment:  {w:24, d:16}
};
var DEFAULT_FOOTPRINT = {w:14, d:12};
/* Fallback palette when a template has a bad/missing color string. */
var FALLBACK_WALL = '#c9bfa8';
var FALLBACK_ROOF = '#5a3a2a';

/* ---------- module state --------------------------------------------------- */
var walkablePlaced = [];   // {name,type,def,x,z,yaw,w,d,h,doors,mesh}
var spawnedHouses  = [];   // {x,z,yaw,w,d,h,name,subdivision}
var inited = false;
var spawnMeshes = null;    // {bodies, roofs} InstancedMesh refs
/* Normalized water data: {rivers:[], lakes:[], ponds:[], streams:[]}.
   Empty until water.json loads; an empty set means "no water exclusion". */
var water = {rivers:[], lakes:[], ponds:[], streams:[]};

/* ---------- tiny utilities ------------------------------------------------- */
/* Clamp any value to a safe #rrggbb color string. */
function safeColor(v, fallback){
  if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return v;
  return fallback;
}
/* Deterministic string -> seed for mulberry32 (stable spawns per subdivision). */
function hashSeed(str){
  var h = 2166136261;
  str = String(str);
  for (var i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/* Shared materials so walkable-building detail doesn't multiply draw state. */
var matCache = {};
function mat(color){
  if (!matCache[color]) matCache[color] = new THREE.MeshLambertMaterial({color:color});
  return matCache[color];
}
function flatMat(color){
  var k = 'flat:'+color;
  if (!matCache[k]) matCache[k] = new THREE.MeshBasicMaterial({color:color});
  return matCache[k];
}
/* Ground Y for a footprint — same recipe as snapToGround(), minimum of the
   rendered-mesh heights so the base never floats on a slope. Falls back to
   heightAt() when the mesh grid isn't ready yet. */
function groundY(x, z, w, d, yaw){
  try{
    if (typeof snapToGround === 'function') return snapToGround(x, z, w, d, yaw);
  }catch(e){}
  try{
    if (typeof heightAt === 'function') return heightAt(x, z);
  }catch(e2){}
  return 0;
}
/* Distance from (x,z) to the nearest road EDGE (uses the game's spatial
   grid — same test osmBuildings/residential_detail use). */
function roadEdgeDist(x, z){
  try{
    if (typeof distToRoadEdge === 'function') return distToRoadEdge(x, z);
  }catch(e){}
  return 1e9;
}

/* ---------- house mesh builder (walkable buildings + template preview) ---- */
/* Footprint from template: type table first, explicit w/d fields if the
   editor ever adds them, then the default. */
function footprintOf(def){
  var fp = TYPE_FOOTPRINT[def && def.type] || DEFAULT_FOOTPRINT;
  var w = (def && typeof def.width  === 'number' && def.width  > 0) ? def.width  : fp.w;
  var d = (def && typeof def.depth  === 'number' && def.depth  > 0) ? def.depth  : fp.d;
  var floors = (def && typeof def.floors === 'number' && def.floors > 0) ? Math.min(def.floors, 52) : 1;
  return {w:w, d:d, h:FLOOR_H*floors, floors:floors};
}
/* Which local face is "front"/"back"/"left"/"right". Local +Z is the front
   (matches bldgFaceYaw + l2w in residential_detail.js). Returns the plane
   center and its yaw for a point at fractions (fx: 0..1 left->right as seen
   facing that face from outside, fy: 0..1 bottom->top of the wall). */
function facePlane(face, fx, fy, fw, fh, w, d, h){
  var lx = (fx-0.5)*fw, wy = fy*h;
  var off = 0.03;  // sit just proud of the wall to avoid z-fighting
  if (face === 'front') return {x:lx,                y:wy, z: d/2+off, yaw:0};
  if (face === 'back')  return {x:lx,                y:wy, z:-d/2-off, yaw:Math.PI};
  if (face === 'right') return {x: w/2+off,          y:wy, z:(0.5-fx)*fw, yaw:Math.PI/2};
  /* 'left' (and anything unknown falls back to front-like left face) */
  return {x:-w/2-off, y:wy, z:(fx-0.5)*fw, yaw:-Math.PI/2};
}
/* Build a house/store/restaurant mesh from a buildings.json template.
   detail=true adds window/door planes (walkable buildings only); detail=false
   is a plain colored body+roof (kept for a future template preview). */
function buildTemplateMesh(def, detail){
  var fp = footprintOf(def);
  var w = fp.w, d = fp.d, h = fp.h;
  var wallC = safeColor(def && def.wall_color, FALLBACK_WALL);
  var roofC = safeColor(def && def.roof_color, FALLBACK_ROOF);
  var group = new THREE.Group();
  /* Body: origin at ground level, centered in x/z. */
  var body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(wallC));
  body.position.y = h/2;
  group.add(body);
  /* Roof: hip (4-sided cone) like the main game's roofs, or a flat slab when
     the template says "Flat" (e.g. the Downtown Store). */
  var flat = def && typeof def.roof_texture === 'string' &&
             def.roof_texture.toLowerCase() === 'flat';
  if (flat){
    var slab = new THREE.Mesh(new THREE.BoxGeometry(w+0.5, 0.5, d+0.5), mat(roofC));
    slab.position.y = h+0.25;
    group.add(slab);
  } else {
    var roofH = Math.min(w, d)*0.38 + 0.8;
    var cone = new THREE.Mesh(
      new THREE.ConeGeometry(Math.hypot(w, d)/2*1.02, 1, 4), mat(roofC));
    cone.rotation.y = Math.PI/4;      // square base aligned to the walls
    cone.scale.y = roofH;
    cone.position.y = h + roofH/2;
    group.add(cone);
  }
  if (detail){
    /* Windows: flat dark planes on the authored faces. */
    var wins = (def && def.windows) || [];
    for (var i=0;i<wins.length;i++){
      var wn = wins[i];
      var p = facePlane(wn.face||'front', wn.x||0.5, wn.y||0.5,
                        (wn.w||0.15)*w, (wn.h||0.25)*h, w, d, h);
      var wp = new THREE.Mesh(new THREE.PlaneGeometry((wn.w||0.15)*w, (wn.h||0.25)*h),
                              flatMat('#26313d'));
      wp.position.set(p.x, p.y, p.z);
      wp.rotation.y = p.yaw;
      group.add(wp);
    }
    /* Doors: wood-brown planes; recorded separately for the interior system. */
    var doors = (def && def.doors) || [];
    for (var j=0;j<doors.length;j++){
      var dr = doors[j];
      var dh = Math.min(2.6, h*0.75);          // door height, never taller than the wall
      var q = facePlane(dr.face||'front', dr.x||0.5, 0, (dr.w||0.12)*w, dh, w, d, h);
      var dp = new THREE.Mesh(new THREE.PlaneGeometry((dr.w||0.12)*w, dh),
                              flatMat('#5a3a22'));
      dp.position.set(q.x, dh/2, q.z);        // door base sits on the ground
      dp.rotation.y = q.yaw;
      group.add(dp);
    }
  }
  group.userData.fp = fp;
  return group;
}
/* Local (lx,lz) -> world for a rotated building. Same math as Three.js
   rotation.y and the l2w() in residential_detail.js: local +Z stays front. */
function rotXZ(lx, lz, yaw){
  var c = Math.cos(yaw), s = Math.sin(yaw);
  return [lx*c + lz*s, -lx*s + lz*c];
}

/* ---------- walkable building placement ------------------------------------ */
/* Hand-placed buildings (walkable:true) go exactly where the editor put them.
   We only WARN (never move/delete) if one sits on a road — Joshua's data
   wins, and he fixes placement in the editor. */
function placeWalkable(def){
  var pos = def.position;
  if (!pos || typeof pos[0] !== 'number' || typeof pos[1] !== 'number'){
    try{ console.warn('[buildingSpawner] walkable "'+(def.name||'?')+'" has no valid position — skipped'); }catch(e){}
    return null;
  }
  var x = pos[0], z = pos[1];
  var fp = footprintOf(def);
  /* Editor degrees -> radians. EDITOR_ROT_SIGN is the (flagged) assumption
     that editor rotation runs clockwise from above. */
  var yaw = EDITOR_ROT_SIGN * (Number(def.rotation)||0) * Math.PI/180;
  /* Road sanity check only — never moves the building (Joshua's rule: his
     hand-placed data is never auto-deleted or auto-moved). */
  var halfDiag = Math.hypot(fp.w, fp.d)/2;
  try{
    if (roadEdgeDist(x, z) < halfDiag)
      console.warn('[buildingSpawner] walkable "'+(def.name||'?')+'" at ('+x+','+z+
                   ') is on/near a road — left as hand-placed for editor fix');
  }catch(e){}
  /* Water sanity check — same warn-only pattern as roads: Joshua's
     hand-placed data is never auto-moved or auto-deleted. */
  try{
    if (inWater(x, z, halfDiag))
      console.warn('[buildingSpawner] walkable "'+(def.name||'?')+'" at ('+x+','+z+
                   ') is in/near water — left as hand-placed for editor fix');
  }catch(e){}
  var baseY = groundY(x, z, fp.w, fp.d, yaw) - GROUND_EMBED;
  var mesh = buildTemplateMesh(def, true);
  mesh.position.set(x, baseY, z);
  mesh.rotation.y = yaw;
  try{ scene.add(mesh); }catch(e){
    try{ console.warn('[buildingSpawner] scene not ready, walkable skipped'); }catch(e2){}
    return null;
  }
  /* Collider so the player/NPCs walk around it (circle approx, like OSM). */
  try{
    if (typeof addBldgCollider === 'function') addBldgCollider(x, z, halfDiag, fp.h);
  }catch(e){}
  /* World-space door positions for the interior system (front face + yaw). */
  var doors = [];
  var dlist = def.doors || [];
  for (var i=0;i<dlist.length;i++){
    var dr = dlist[i];
    var p = facePlane(dr.face||'front', dr.x||0.5, 0, 0, 0, fp.w, fp.d, fp.h);
    var wp = rotXZ(p.x, p.z, yaw);
    doors.push({x:x+wp[0], z:z+wp[1], yaw:yaw+p.yaw, face:dr.face||'front'});
  }
  var rec = {name:def.name||'Walkable', type:def.type||'', def:def,
             x:x, z:z, yaw:yaw, w:fp.w, d:fp.d, h:fp.h, doors:doors, mesh:mesh};
  walkablePlaced.push(rec);
  /* window.WalkableBuildings stays the LIVE array (interior system reads it). */
  window.WalkableBuildings = walkablePlaced;
  return rec;
}

/* ---------- road queries for street-facing rotation ----------------------- */
/* Distinct roads near (x,z): gridSegsNear() returns raw segments
   [x1,z1,x2,z2,y1,y2,halfW,name,class]; group by road NAME so two segments
   of the same road don't fake a corner lot. The grid neighborhood EXPANDS
   (pad 2 -> 4 -> 6 -> 8) until at least one road is found — the nearest road
   can be far away, so the search must not stop at a fixed small radius.
   Returns [{name, cls, dist, dx, dz}] sorted by edge distance, dx/dz = unit
   direction house->nearest point on the road. */
function roadsNear(x, z){
  var byName = {};
  var pads = [2, 4, 6, 8];
  for (var pi=0; pi<pads.length; pi++){
    var segs = [];
    try{
      segs = (typeof gridSegsNear === 'function') ? gridSegsNear(x, z, pads[pi]) : [];
    }catch(e){}
    for (var i=0;i<segs.length;i++){
      var s = segs[i];
      var vx = s[2]-s[0], vz = s[3]-s[1];
      var len2 = vx*vx + vz*vz;
      var t = len2 > 0 ? ((x-s[0])*vx + (z-s[1])*vz)/len2 : 0;
      t = Math.max(0, Math.min(1, t));
      var px = s[0]+vx*t, pz = s[1]+vz*t;
      var d = Math.hypot(x-px, z-pz) - (s[6]||0);
      var name = s[7] || ('road#'+i);
      var prev = byName[name];
      if (!prev || d < prev.dist){
        byName[name] = {name:name, cls:(s[8]||null), dist:d, dx:px-x, dz:pz-z};
      }
    }
    var found = false;
    for (var k in byName){ if (byName.hasOwnProperty(k)){ found = true; break; } }
    if (found) break;   // nearest road(s) found — no need to search wider
  }
  var out = [];
  for (var k2 in byName){ if (byName.hasOwnProperty(k2)) out.push(byName[k2]); }
  out.sort(function(a,b){ return a.dist-b.dist; });
  /* Unit direction house -> nearest point on the road. */
  for (var j=0;j<out.length;j++){
    var l = Math.hypot(out[j].dx, out[j].dz) || 1;
    out[j].dx /= l; out[j].dz /= l;
  }
  return out;
}
/* Street-facing yaw for a house at (x,z) with a given front_face.
   - Corner lot (2+ distinct roads within CORNER_LOT_DIST): face the LARGER
     road class (highway > arterial > local); ties go to the nearest.
   - Otherwise face the nearest road.
   Returns null when no road is near (caller keeps the default yaw). */
function streetFacingYaw(x, z, frontFace){
  var near = roadsNear(x, z);
  if (!near.length) return null;
  var chosen = near[0];   // nearest road by default
  /* Corner lot: 2+ DISTINCT roads within CORNER_LOT_DIST — face the LARGER
     road class (highway > arterial > local); ties go to the nearest. */
  var close = [];
  for (var c=0;c<near.length;c++) if (near[c].dist <= CORNER_LOT_DIST) close.push(near[c]);
  if (close.length > 1){
    chosen = close[0];
    for (var i=1;i<close.length;i++){
      var ra = CLASS_RANK[close[i].cls] || 0;
      var rb = CLASS_RANK[chosen.cls] || 0;
      if (ra > rb) chosen = close[i];
    }
  }
  var offset = FACE_OFFSET[frontFace];
  if (typeof offset !== 'number') offset = 0;   // unknown -> treat as front
  return Math.atan2(chosen.dx, chosen.dz) + offset;
}
/* Overlap test vs already-placed OSM building circles (bldgGrid, 40u cells).
   Guarded: if the grid isn't there yet, no test (spawner never crashes). */
function overlapsExisting(x, z, r){
  try{
    if (typeof bldgGrid === 'undefined' || !bldgGrid) return false;
    var cx = Math.floor(x/40), cz = Math.floor(z/40);
    for (var gx=cx-1; gx<=cx+1; gx++) for (var gz=cz-1; gz<=cz+1; gz++){
      var cell = bldgGrid[gx+','+gz];
      if (!cell) continue;
      for (var i=0;i<cell.length;i++){
        var c = cell[i];
        if (Math.hypot(x-c.x, z-c.z) < r + (c.r||4)) return true;
      }
    }
  }catch(e){}
  return false;
}
/* Overlap test vs houses this spawner already placed: simple circle
   rejection — centers must stay at least MIN_SPACING apart. */
function overlapsSpawned(x, z){
  for (var i=0;i<spawnedHouses.length;i++){
    var h = spawnedHouses[i];
    if (Math.hypot(x-h.x, z-h.z) < MIN_SPACING) return true;
  }
  return false;
}

/* ---------- water features (rivers, lakes, ponds, streams) ------------------- */
/* Joshua's rule (2026-10-11): when water features are added to the map, NO
   spawned house may sit in a lake, river, stream, or pond.

   Expected water.json shape (map-editor repo):
     { rivers:  [{name, pts:[[x,z],...], width}],
       streams: [{name, pts:[[x,z],...], width}],
       lakes:   [{name, polygon:[[x,z],...]}],
       ponds:   [{name, polygon:[[x,z],...]}] }
   Anything else (missing file, 404, bad JSON, wrong shape) normalizes to an
   empty set — spawning then behaves exactly as if there were no water. */
/* Normalize whatever fetchJson returned into the canonical water shape.
   fetchJson gives [] on ANY load failure, which lands here as "no water". */
function normalizeWater(raw){
  var w = {rivers:[], lakes:[], ponds:[], streams:[]};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return w;
  var keys = ['rivers', 'lakes', 'ponds', 'streams'];
  for (var i=0;i<keys.length;i++){
    if (Array.isArray(raw[keys[i]])) w[keys[i]] = raw[keys[i]];
  }
  return w;
}
/* Distance from point (x,z) to segment (ax,az)-(bx,bz), clamped to the
   segment. Used for river/stream centerlines and lake/pond edges. */
function distToSeg(x, z, ax, az, bx, bz){
  var vx = bx-ax, vz = bz-az;
  var len2 = vx*vx + vz*vz;
  var t = len2 > 0 ? ((x-ax)*vx + (z-az)*vz)/len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x-(ax+vx*t), z-(az+vz*t));
}
/* True if a candidate house CENTER (x,z) with footprint half-diagonal
   halfDiag would touch water (or sit inside the WATER_BUFFER ring around it):
     - lakes/ponds: reject when the center is INSIDE the polygon, or when any
       polygon edge comes within halfDiag + WATER_BUFFER of the center
       (so the house footprint can't overhang the shoreline).
     - rivers/streams: reject when the centerline comes within
       width/2 + halfDiag + WATER_BUFFER (the house footprint plus the
       clearance ring, measured from the water's edge). */
function inWater(x, z, halfDiag){
  var i, j, p, q, pts, poly, d;
  /* Lakes + ponds: solid polygons. */
  var bodies = water.lakes.concat(water.ponds);
  for (i=0;i<bodies.length;i++){
    poly = bodies[i] && bodies[i].polygon;
    if (!Array.isArray(poly) || poly.length < 3) continue;
    if (pointInPoly(x, z, poly)) return true;   // center in the water
    for (j=0;j<poly.length;j++){
      p = poly[j]; q = poly[(j+1)%poly.length];
      if (!p || !q) continue;
      d = distToSeg(x, z, p[0], p[1], q[0], q[1]);
      if (d < halfDiag + WATER_BUFFER) return true;
    }
  }
  /* Rivers + streams: centerline polylines with a width in world units. */
  var flows = water.rivers.concat(water.streams);
  for (i=0;i<flows.length;i++){
    pts = flows[i] && flows[i].pts;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    var clearance = (Number(flows[i].width)||0)/2 + halfDiag + WATER_BUFFER;
    for (j=0;j<pts.length-1;j++){
      p = pts[j]; q = pts[j+1];
      if (!p || !q) continue;
      d = distToSeg(x, z, p[0], p[1], q[0], q[1]);
      if (d < clearance) return true;
    }
  }
  return false;
}

/* ---------- subdivision spawning ------------------------------------------ */
/* Shoelace polygon area (absolute, world units^2). */
function polyArea(poly){
  var a = 0;
  for (var i=0;i<poly.length;i++){
    var p = poly[i], q = poly[(i+1)%poly.length];
    a += p[0]*q[1] - q[0]*p[1];
  }
  return Math.abs(a)/2;
}
/* Ray-cast point-in-polygon. Polygon points are [x,z] pairs. */
function pointInPoly(x, z, poly){
  var inside = false;
  for (var i=0, j=poly.length-1; i<poly.length; j=i++){
    var xi = poly[i][0], zi = poly[i][1];
    var xj = poly[j][0], zj = poly[j][1];
    if (((zi > z) !== (zj > z)) &&
        (x < (xj-xi)*(z-zi)/(zj-zi) + xi)) inside = !inside;
  }
  return inside;
}
/* Spawn houses inside one subdivision polygon using `template` (a
   buildings.json def). Returns the number placed. */
function spawnSubdivision(sub, template){
  var poly = sub.polygon;
  if (!poly || poly.length < 3) return 0;
  /* Bounding box for rejection sampling. */
  var minX=1e9, maxX=-1e9, minZ=1e9, maxZ=-1e9, ok=true;
  for (var i=0;i<poly.length;i++){
    var p = poly[i];
    if (typeof p[0] !== 'number' || typeof p[1] !== 'number'){ ok = false; break; }
    if (p[0]<minX) minX=p[0]; if (p[0]>maxX) maxX=p[0];
    if (p[1]<minZ) minZ=p[1]; if (p[1]>maxZ) maxZ=p[1];
  }
  if (!ok || maxX<=minX || maxZ<=minZ) return 0;
  var target = Math.round(polyArea(poly)/AREA_PER_HOUSE);
  target = Math.max(0, Math.min(target, MAX_PER_SUBDIV));
  if (target <= 0) return 0;
  /* SIMPLIFICATION (flagged): the 20 real subdivision styles don't exist in
     buildings.json yet, so EVERY style uses the first non-walkable template.
     When styles land, pick the template by sub.style here. */
  var fp = footprintOf(template);
  var halfDiag = Math.hypot(fp.w, fp.d)/2;
  var frontFace = template.front_face || 'front';
  var rng = (typeof mulberry32 === 'function')
    ? mulberry32(hashSeed(sub.name || ('sub'+target)))
    : Math.random;
  var placed = 0, attempts = 0;
  var maxAttempts = target*40;
  while (placed < target && attempts < maxAttempts &&
         spawnedHouses.length < MAX_TOTAL){
    attempts++;
    var x = minX + rng()*(maxX-minX);
    var z = minZ + rng()*(maxZ-minZ);
    if (!pointInPoly(x, z, poly)) continue;
    /* Reject: on a road (reuse the game's own clearance test). */
    if (roadEdgeDist(x, z) < halfDiag + ROAD_MARGIN) continue;
    /* Reject: in or near water (Joshua 2026-10-11 — no spawned house in a
       lake, river, stream, or pond, plus a WATER_BUFFER clearance ring). */
    if (inWater(x, z, halfDiag)) continue;
    /* Reject: overlapping this spawner's houses (min 30u apart). */
    if (overlapsSpawned(x, z)) continue;
    /* Reject: overlapping an existing OSM building. */
    if (overlapsExisting(x, z, halfDiag)) continue;
    /* Street-facing rotation: yaw so front_face points at the road. */
    var yaw = streetFacingYaw(x, z, frontFace);
    if (yaw === null) yaw = rng()*Math.PI*2;   // no road near: random yaw
    spawnedHouses.push({x:x, z:z, yaw:yaw, w:fp.w, d:fp.d, h:fp.h,
                        r:halfDiag, name:template.name||'House',
                        subdivision:sub.name||''});
    placed++;
    /* Collider so the player can't walk through the spawned house. */
    try{
      if (typeof addBldgCollider === 'function')
        addBldgCollider(x, z, halfDiag, fp.h);
    }catch(e){}
  }
  return placed;
}
/* ---------- spawned-house rendering (InstancedMesh, phone-friendly) -------- */
/* One InstancedMesh for bodies + one for hip roofs across ALL spawned houses
   (they share the template, so one material each = 2 draw calls total).
   Detail (windows/doors) is skipped at this distance per the task spec. */
function buildSpawnMeshes(template){
  if (!spawnedHouses.length) return;
  var wallC = safeColor(template.wall_color, FALLBACK_WALL);
  var roofC = safeColor(template.roof_color, FALLBACK_ROOF);
  var flat = template.roof_texture &&
             String(template.roof_texture).toLowerCase() === 'flat';
  /* Body: unit box, origin at ground (same trick as osmBuildings). */
  var bodyGeo = new THREE.BoxGeometry(1,1,1);
  bodyGeo.translate(0, 0.5, 0);
  var bodies = new THREE.InstancedMesh(bodyGeo, mat(wallC), spawnedHouses.length);
  /* Roof: hip cone (origin at its base so it sits on the wall top) or a
     flat slab. Geometry is unit-sized; per-instance scale sets real size. */
  var roofGeo, roofIsCone;
  if (flat){
    roofGeo = new THREE.BoxGeometry(1.04, 1, 1.04);
    roofGeo.translate(0, 0.5, 0);
    roofIsCone = false;
  } else {
    roofGeo = new THREE.ConeGeometry(0.72, 1, 4);
    roofGeo.rotateY(Math.PI/4);
    roofGeo.translate(0, 0.5, 0);
    roofIsCone = true;
  }
  var roofs = new THREE.InstancedMesh(roofGeo, mat(roofC), spawnedHouses.length);
  var m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  var up = new THREE.Vector3(0,1,0), pv = new THREE.Vector3();
  for (var i=0;i<spawnedHouses.length;i++){
    var h = spawnedHouses[i];
    var baseY = groundY(h.x, h.z, h.w, h.d, h.yaw) - GROUND_EMBED;
    h.y = baseY;   // record for debug/inspection
    q.setFromAxisAngle(up, h.yaw);
    /* Body matrix: scale (w,h,d), yaw, base at ground. */
    pv.set(h.x, baseY, h.z);
    sc.set(h.w, h.h, h.d);
    m.compose(pv, q, sc);
    bodies.setMatrixAt(i, m);
    /* Roof matrix: hip cone base is a square (45° base rotation) with
       half-width 0.72/sqrt(2) ≈ 0.51 of the unit geometry, so scale (w, roofH,
       d) covers the w×d footprint edge-to-edge, like the main game's roofs. */
    var roofH = roofIsCone ? (Math.min(h.w,h.d)*0.38 + 0.8) : 0.5;
    pv.set(h.x, baseY + h.h, h.z);
    sc.set(h.w, roofH, h.d);
    m.compose(pv, q, sc);
    roofs.setMatrixAt(i, m);
  }
  bodies.instanceMatrix.needsUpdate = true;
  roofs.instanceMatrix.needsUpdate = true;
  try{
    scene.add(bodies); scene.add(roofs);
  }catch(e){
    try{ console.warn('[buildingSpawner] scene not ready, spawn meshes skipped'); }catch(e2){}
    return;
  }
  spawnMeshes = {bodies:bodies, roofs:roofs};
}

/* ---------- data loading + init -------------------------------------------- */
/* Fetch one JSON URL; on ANY failure return the fallback ([]). The game must
   never crash because the editor data didn't download. */
function fetchJson(url){
  return fetch(url, {cache:'no-store'}).then(function(r){
    if (!r.ok) throw new Error('http '+r.status);
    return r.json();
  }).catch(function(err){
    try{
      console.warn('[buildingSpawner] could not load '+url+
                   ' — running without it ('+(err && err.message)+')');
    }catch(e){}
    return [];
  });
}
function init(){
  if (inited) return;
  inited = true;
  /* Guard: this script loads after the main inline block, but if THREE or
     scene aren't there yet, bail loudly instead of throwing mid-load. */
  try{
    if (typeof THREE === 'undefined' || typeof scene === 'undefined'){
      console.warn('[buildingSpawner] THREE/scene not ready — spawner disabled');
      return;
    }
  }catch(e){ return; }
  /* Async data load: buildings pop in when the fetch resolves; the game
     keeps running meanwhile. */
  var p1 = fetchJson(BUILDINGS_URL);
  var p2 = fetchJson(SUBDIVISIONS_URL);
  /* Water features (rivers, lakes, ponds, streams). fetchJson returns [] on
     ANY failure (including 404 when water.json doesn't exist yet) and
     normalizeWater turns that into an empty set — spawning then works
     exactly as before, with no water exclusion. */
  var p3 = fetchJson(WATER_URL);
  Promise.all([p1, p2, p3]).then(function(res){
    var buildings = res[0] || [];
    var subdivs   = res[1] || [];
    water = normalizeWater(res[2]);
    try{
      if (!Array.isArray(buildings)) buildings = [];
      if (!Array.isArray(subdivs))   subdivs = [];
      /* 1) Walkable buildings: hand-placed, full detail. */
      var nWalk = 0;
      for (var i=0;i<buildings.length;i++){
        if (buildings[i] && buildings[i].walkable === true){
          if (placeWalkable(buildings[i])) nWalk++;
        }
      }
      /* 2) Subdivision spawning. Empty subdivisions.json => this loop does
         nothing (graceful no-op, no errors). */
      var template = null;
      for (var t=0;t<buildings.length;t++){
        if (buildings[t] && buildings[t].walkable !== true){ template = buildings[t]; break; }
      }
      var nSpawn = 0, nSubs = 0;
      if (template && subdivs.length){
        for (var s=0;s<subdivs.length;s++){
          if (spawnedHouses.length >= MAX_TOTAL) break;
          nSpawn += spawnSubdivision(subdivs[s], template);
          nSubs++;
        }
        buildSpawnMeshes(template);
      } else if (!template && subdivs.length){
        try{ console.warn('[buildingSpawner] subdivisions present but no house template in buildings.json'); }catch(e){}
      }
      try{
        console.log('[buildingSpawner] done: '+nWalk+' walkable placed, '+
                    nSpawn+' houses spawned in '+nSubs+' subdivisions');
      }catch(e){}
      /* Publish stats for the admin/report system (guarded like other
         systems). */
      try{
        if (typeof Report !== 'undefined' && Report && Report.setSys)
          Report.setSys('buildingSpawner', {status:'ok', walkable:nWalk,
                                            spawned:nSpawn, subdivisions:nSubs});
      }catch(e){}
    }catch(err){
      try{ console.warn('[buildingSpawner] init failed: '+(err && err.message)); }catch(e){}
    }
  });
}
/* ---------- public API ------------------------------------------------------ */
var api = {
  init: init,
  getWalkableBuildings: function(){ return walkablePlaced.slice(); },
  getSpawnedHouses: function(){ return spawnedHouses.slice(); }
};
try{ window.BuildingSpawner = api; }catch(e){}
/* Auto-start at load, like residential_detail.js's IIFE: the script tag sits
   after the main inline game block, so THREE/scene/roads exist. init() is
   idempotent, so the parent can also call BuildingSpawner.init() safely. */
try{ init(); }catch(e){}

})();
