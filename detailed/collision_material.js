/* ============================================================================
   COLLISION MATERIAL SYSTEM — Joshua 2026-10-11

   Replaces expensive per-frame collision DETECTION with cheap collision
   MATERIALS. Every position in the world has a material flag. The movement
   system checks the material at the target position BEFORE moving — a single
   grid/flag lookup instead of scanning objects.

   Why this saves resources:
   - Old way: every frame, for every mover, scan all nearby colliders
     (props, buildings, wall segments), compute distances, push out.
     That's O(colliders) per mover per frame.
   - New way: ONE material lookup per move attempt. The material is
     derived from cheap existing queries (road grid, water array, prop
     spatial hash). No per-object iteration in the hot path.

   The old resolveCollision() system is KEPT as a fallback — this module
   runs first (cheap reject), old system runs after (fine push-out).

   PHASE C AMENDMENT (2026-10-28, Joshua's material doctrine restated):
   the fallback arrangement is RETIRED. This module is now the ONE
   collision truth — the gate (canMoveTo), the level-aware lookup
   (getMaterialAtLevel), the rest surfaces (surfaceYAt) and the push-out
   (pushOut, which index.html's resolveCollision now delegates to) all
   read the same registries, including the active map package's baked
   materials (map_loader.js provider). Every mover routes through the
   gate: player, NPC walkers (their private grid is deleted), traffic,
   buses, semis, school buses. Interiors register their boxes here as
   material solids; there is no second solver left.
   ============================================================================ */

/* Material types. The numbers are identifiers — lookup priority comes from
   the if/else chain order in getMaterialAt(), not the numeric values. */
var COLLISION_MATERIALS = {
  NONE:  0,  // Air, decorations — no surface, no restriction
  GRASS: 5,  // Terrain/grass surface — the base layer everything sits on.
             // Walkable (behaves like NONE for movement); exists so the
             // vertical layering model can name what ROAD sits on.
  ROAD:  2,  // Road surface — sits ON grass (see VERTICAL LAYERING below)
  WATER: 3,  // Water — blocks all ground movement
  DOOR:  4,  // Door — solid when closed, passable when open
  SOLID: 1,  // Walls, buildings, trees, fences — cannot pass through
  PERSON: 6  // A living person (hero / civilian NPC), registered
             // dynamically below — blocks VEHICLE movers only; people
             // never block each other. (2026-10-28 amendment.)
};
/* Note: SOLID=1 is intentionally lower than ROAD/WATER/DOOR so that
   specific materials (road, water, door) take priority in the lookup.
   GRASS is the ground itself — the default when nothing else matches. */

/* Mover types for canMoveTo(). */
var MOVER_PLAYER  = 'player';   // Joshua on foot
var MOVER_VEHICLE = 'vehicle';  // Any drivable vehicle
var MOVER_NPC     = 'npc';      // NPC walkers (same rules as player)

/* ---------------------------------------------------------------------------
   Material cache — per-cell caching so repeated lookups in the same area
   don't recompute. Cells are 20x20 world units. Cache is invalidated when
   doors open/close (DOOR material changes).
   --------------------------------------------------------------------------- */
var _matCache = {};       // "cx,cz" -> {mat, time}
var _matCacheTime = 0;    // incremented to invalidate
var MAT_CELL = 20;        // cell size in world units
var MAT_CACHE_TTL = 5000; // ms before a cached cell is recomputed

function _matCellKey(x, z){
  return Math.floor(x / MAT_CELL) + ',' + Math.floor(z / MAT_CELL);
}

function invalidateMaterialCache(){
  /* Call when doors open/close or any dynamic solid changes. */
  _matCacheTime++;
  _matCache = {};
}

/* ---------------------------------------------------------------------------
   getMaterialAt(x, z) — the core lookup. Returns a COLLISION_MATERIALS value.
   Checks in priority order (most specific first). All checks are cheap:
   - WATER: scans the WATER array (typically < 20 entries)
   - ROAD: single grid lookup via onRoad()
   - DOOR: checks registered door positions (small list)
   - SOLID: propGrid 3x3 spatial hash + interior boxes (bounded scan)
   - NONE: default (open ground, grass, etc.)
   --------------------------------------------------------------------------- */
function getMaterialAt(x, z, skipCache){
  /* --- Cache check (skipped for movement-gate lookups: a 20u cell can
     straddle a road edge, so canMoveTo() needs exact from/to materials) --- */
  var key = _matCellKey(x, z);
  var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  if (!skipCache){
    var cached = _matCache[key];
    if (cached && (now - cached.time) < MAT_CACHE_TTL && cached.gen === _matCacheTime){
      return cached.mat;
    }
  }

  /* v1.62 (2026-10-12, Joshua): open ground IS the GRASS material — the
     base layer of the vertical stack. Walkable, like NONE. */
  var mat = COLLISION_MATERIALS.GRASS;

  try {
    /* --- PERSON: highest priority — a person standing on a road (or
       wading) must read PERSON, not ROAD/WATER, or the vehicle gate
       would never see them. People systems re-register every frame;
       entries expire in 600ms (see the registry below). The movement
       gate always calls with skipCache=true, so a moving person is
       never smeared by the 20u cell cache. --- */
    if (_personAt(x, z)){
      mat = COLLISION_MATERIALS.PERSON;
    }
    /* --- PACKAGE (Phase C): the active map package's baked material
       truth (building rings, roads, water, rail corridor, deck
       under-space) — map_loader.js registers its provider via
       setPackageProvider(). A null answer means "the package has
       nothing here" and the legacy probes below still serve (props,
       doors and people are not package data). --- */
    else if (_pkgProvider){
      var _pm = null;
      try { _pm = _pkgProvider.materialAt(x, z); } catch(e){ _pm = null; }
      if (_pm !== null && _pm !== undefined) mat = _pm;
      else if (typeof inWater === 'function' && inWater(x, z)){
        mat = COLLISION_MATERIALS.WATER;
      }
      else if (typeof onRoad === 'function' && onRoad(x, z)){
        mat = COLLISION_MATERIALS.ROAD;
      }
      else if (_isClosedDoorAt(x, z)){
        mat = COLLISION_MATERIALS.DOOR;
      }
      else if (_isSolidAt(x, z)){
        mat = COLLISION_MATERIALS.SOLID;
      }
    }
    /* --- WATER: highest priority after DOOR --- */
    /* inWater() is defined in index.html; scans the small WATER array. */
    else if (typeof inWater === 'function' && inWater(x, z)){
      mat = COLLISION_MATERIALS.WATER;
    }
    /* --- ROAD: grid-based, single lookup --- */
    /* onRoad() is defined in index.html; uses roadSurfGrid. */
    else if (typeof onRoad === 'function' && onRoad(x, z)){
      mat = COLLISION_MATERIALS.ROAD;
    }
    /* --- DOOR: closed doors are solid --- */
    /* Door positions are registered by the interior system. */
    else if (_isClosedDoorAt(x, z)){
      mat = COLLISION_MATERIALS.DOOR;
    }
    /* --- SOLID: props, trees, buildings via spatial hash --- */
    /* propGrid is the game's existing 40u-cell spatial hash (fast). */
    else if (_isSolidAt(x, z)){
      mat = COLLISION_MATERIALS.SOLID;
    }
  } catch(e){
    /* Any lookup failure = treat as GRASS (permissive, old system catches
       it). GRASS and NONE behave identically for movement. */
    mat = COLLISION_MATERIALS.GRASS;
  }

  /* --- Store in cache (movement-gate lookups skip the cache entirely) --- */
  if (!skipCache){
    _matCache[key] = { mat: mat, time: now, gen: _matCacheTime };
  }
  return mat;
}

/* ---------------------------------------------------------------------------
   VERTICAL SURFACE LAYERING — v1.62 (2026-10-12, Joshua).

   "Use the MATERIAL system, not collision detection." Materials don't just
   gate horizontal movement — they define VERTICAL relationships. The ROAD
   material knows it sits ON the GRASS material:

       ROAD top surface    = GRASS surface + ROAD_LIFT
       ROAD bottom surface = GRASS surface (meets exactly — no clip, no gap)

   Renderers ask "how high is the surface here?" (surfaceHeightAt),
   movers ask "can I be here?" (canMoveTo) — one source of truth, so the
   road mesh, the player snap, and the movement gate can never disagree
   about where the ground is. This is the same "snap to face" philosophy
   as the player-on-road snap, applied to the street-on-grass relationship.

   Layer stack (bottom to top):
     GRASS -> base layer. Top = the rendered terrain mesh surface.
     ROAD  -> sits ON grass. Top = grass + ROAD_LIFT.
     WATER -> its own level (waterLevelAt), independent of terrain.
   --------------------------------------------------------------------------- */

/* ROAD_LIFT — how far the ROAD material's top sits above the GRASS it
   covers. This is the SAME 0.55 the renderer and groundRefY always used —
   now a named material property instead of a magic number, so every
   consumer (road mesh, player snap, car placement) agrees by construction. */
/* STAGE2 DECISION -- APPROVED (Joshua, CONVERSION-DESIGN SS6.1,
   2026-10-16): ROAD_LIFT is 0.01 at cutover, so material consumers
   (materialRoadTopY / surfaceHeightAt) agree with the baked roads'
   drawn +0.01 surface -- one truth with the baked roads. This replaces
   the earlier pending-decision note in the staging copy, which had
   deliberately left the value at 0.55 until Joshua decided SS6.1. */
var ROAD_LIFT = 0.01;

/* MATERIAL_LAYERS — vertical relationship table. For each surface
   material: base = the material it sits ON (null = the world base layer),
   lift = how far its TOP surface sits above its base. A surface's BOTTOM
   meets its base exactly. */
var MATERIAL_LAYERS = {};
MATERIAL_LAYERS[COLLISION_MATERIALS.GRASS] = { base: null, lift: 0 };
MATERIAL_LAYERS[COLLISION_MATERIALS.ROAD]  = { base: COLLISION_MATERIALS.GRASS, lift: ROAD_LIFT };

/* grassSurfaceY(x, z) — the GRASS material's top surface: the RENDERED
   terrain mesh height (the same surface the player sees), via the same
   bilinear grid the mesh was built from. Single source of truth for
   "where is the ground". Falls back to analytic heightAt only if the
   mesh grid isn't built yet. */
function grassSurfaceY(x, z){
  /* Phase C: while a map package is active, its terrain grid (USGS
     3DEP, water carved) is the ground truth — installed via
     setGroundSampler() by map_loader.js. */
  if (_groundSampler){
    try {
      var gy = _groundSampler(x, z);
      if (gy !== null && gy !== undefined && isFinite(gy)) return gy;
    } catch(e){}
  }
  try {
    if (typeof terrainMeshY === 'function'){
      var y = terrainMeshY(x, z);
      if (y > -1e8) return y;
    }
  } catch(e){}
  try { return heightAt(x, z); } catch(e2){ return 0; }
}

/* surfaceHeightAt(x, z) — TOP-surface world Y for the material at (x,z):
     ROAD  -> grass surface + ROAD_LIFT  (road sits ON the grass)
     WATER -> water surface level (falls back to grass surface)
     GRASS / NONE / SOLID / DOOR -> grass surface
   (Solids and doors stand ON the grass; their own meshes define their
   tops. This answers "where is the walkable/drivable surface?".) */
function surfaceHeightAt(x, z){
  var mat = COLLISION_MATERIALS.GRASS;
  try { mat = getMaterialAt(x, z, true); } catch(e){}
  if (mat === COLLISION_MATERIALS.WATER){
    try {
      if (typeof waterLevelAt === 'function'){
        var wl = waterLevelAt(x, z);
        if (wl !== null && wl !== undefined && isFinite(wl)) return wl;
      }
    } catch(e){}
    return grassSurfaceY(x, z);
  }
  if (mat === COLLISION_MATERIALS.ROAD){
    return grassSurfaceY(x, z) + ROAD_LIFT;
  }
  return grassSurfaceY(x, z);
}

/* materialRoadTopY(x, z) — where the ROAD material's top surface sits at
   (x,z), whether or not a road mesh is currently there. Road renderers
   use this to drape pavement onto the grass: the road top follows
   grass+lift along its path (slopes included), and the road bottom meets
   the grass exactly — they cannot clip through each other. */
function materialRoadTopY(x, z){
  return grassSurfaceY(x, z) + ROAD_LIFT;
}

/* ---------------------------------------------------------------------------
   VEHICLE REST SURFACE — v1.63 (Joshua 2026-10-12): "this should be a
   material thing for the cars."

   surfaceYAt(x, z) returns the Y a VEHICLE should rest on at a position,
   based on the MATERIAL there — not on explicit height knowledge in the
   caller. This is the vertical half of the material system for vehicles:
   canMoveTo() gates horizontal movement, surfaceYAt() pins vertical
   placement. A car on a road, sidewalk, driveway, or grass all goes
   through this one function — the material decides, uniformly.

   Material -> rest-surface mapping:
   - ROAD  -> the EXACT rendered road top via roadSurfaceY() (bridge-aware:
              on a bridge deck it returns the deck height, not grass+lift).
              Falls back to grass+ROAD_LIFT when no road surface data exists.
   - WATER -> the SOLID SURFACE BENEATH (lakebed / submerged roadbed).
              Vehicles ford on the bottom — updateCar()'s sink path handles
              deep water separately and never consults this function.
              (A future floating object, e.g. a boat, should query
              waterLevelAt() directly.)
   - SOLID -> null (no rest surface, e.g. inside a wall — the caller keeps
              its last Y rather than teleporting).
   - GRASS / NONE / DOOR -> grass surface, raised by any sidewalk/driveway
              slab on top (thin walkable slabs are material NONE).

   Relationship to surfaceHeightAt(): that function answers "where is the
   walkable surface?" with the simplified layer model (ROAD = grass+lift).
   surfaceYAt() answers "where does a vehicle rest?" with the EXACT
   rendered surface (bridge-aware). On ordinary roads they agree; on
   bridges only surfaceYAt() is correct for vehicles. The two may be
   unified once the renderer work settles — until then, vehicles use this.

   Returns null when no valid surface exists. Callers MUST fall back to
   their previous Y or another reference (never teleport to 0).
   --------------------------------------------------------------------------- */
function surfaceYAt(x, z, levelY){
  try {
    /* Exact (uncached) material — a 20u cache cell can straddle a road
       edge, and rest height must match the exact sample point. Phase C:
       when the caller supplies its current surface level (levelY), the
       lookup is level-aware so a mover ON a bridge deck reads the deck,
       not the ground under it. */
    var mat = (typeof levelY === 'number' && isFinite(levelY))
      ? getMaterialAtLevel(x, z, levelY) : getMaterialAt(x, z, true);
    /* SOLID: nothing to rest on. */
    if (mat === COLLISION_MATERIALS.SOLID) return null;
    /* PACKAGE (Phase C): the active package knows its own surfaces —
       deck tops at deck level and road profiles (level-matched when
       stacked roads cross at an interchange). */
    if (_pkgProvider){
      try {
        var psy = _pkgProvider.surfaceY(x, z, levelY);
        if (psy !== null && psy !== undefined && isFinite(psy)) return psy;
      } catch(e){}
    }
    /* ROAD: exact rendered top (bridge-aware). */
    if (mat === COLLISION_MATERIALS.ROAD){
      try {
        if (typeof roadSurfaceY === 'function'){
          var r = roadSurfaceY(x, z);
          if (r !== null && r !== undefined && isFinite(r)) return r;
        }
      } catch(e){}
      /* No road surface data — fall back to the material layer model,
         consistent with surfaceHeightAt(). */
      try { return grassSurfaceY(x, z) + ROAD_LIFT; } catch(e2){ return null; }
    }
    /* GRASS / NONE / DOOR / WATER: the ground beneath. WATER falls through
       here deliberately — vehicles ford on the bottom (see header). */
    var y = grassSurfaceY(x, z);
    /* Sidewalk / driveway slabs sit above the grass; they're material NONE
       (walkable, not blockers), so fold them into the ground case. */
    try {
      if (typeof sidewalkSurfaceY === 'function'){
        var sw = sidewalkSurfaceY(x, z);
        if (sw !== null && sw !== undefined && isFinite(sw) && sw > y) y = sw;
      }
    } catch(e){}
    return y;
  } catch(e){ return null; }
}

/* _isClosedDoorAt(x, z) — true if a CLOSED door is at this position.
   Open doors are passable (material NONE). Door state comes from the
   interior system's door registry. */
var _doorPositions = [];  // {x, z, radius, isOpen} — registered by game code
function _isClosedDoorAt(x, z){
  for (var i = 0; i < _doorPositions.length; i++){
    var d = _doorPositions[i];
    if (d.isOpen) continue;  // open doors don't block
    var dx = x - d.x, dz = z - d.z;
    var r = d.radius || 1.5;
    if (dx*dx + dz*dz < r*r) return true;
  }
  return false;
}

/* registerDoor(x, z, radius) — game code calls this for each door.
   Returns a handle with setOpen(bool) to update state. */
function registerDoor(x, z, radius){
  var door = { x: x, z: z, radius: radius || 1.5, isOpen: false,
    setOpen: function(open){
      if (this.isOpen !== open){
        this.isOpen = open;
        invalidateMaterialCache();  // door state changed -> recompute
      }
    }};
  _doorPositions.push(door);
  return door;
}

/* ---------------------------------------------------------------------------
   DYNAMIC PEOPLE — person-blockers (Joshua's amendment, 2026-10-28).

   The hero and the civilian NPCs register their live position here.
   The material at a registered person's position reads PERSON, and
   canMoveTo() blocks VEHICLE movers from entering it — a person is a
   dynamic material, exactly Joshua's doctrine (material meeting
   material; no separate collider registry for people).

   Registrations carry a timestamp and expire after 600 ms, so people
   systems simply re-register every frame while active. When the hero
   gets into a car (animateHero stops being called) or an NPC is
   culled by zoneunlock, the blocker lapses on its own — no stale
   ghosts standing in the road.

   SCOPE NOTE (updated Phase C, 2026-10-28): the routing half is now
   built — traffic_system.js, marta_bus_system.js, semi_system.js and
   schoolbus_system.js all consult canMoveTo() before advancing, and
   their probes stop the vehicle when this registry puts a PERSON in
   its path. The registration above is the only half that lives here.
   --------------------------------------------------------------------------- */
var _peoplePositions = [];  // {id, x, z, r, t} — registered by people systems
function setPersonBlocker(id, x, z, radius){
  var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  for (var i = 0; i < _peoplePositions.length; i++){
    if (_peoplePositions[i].id === id){
      var p = _peoplePositions[i];
      p.x = x; p.z = z; p.r = radius || 0.9; p.t = now;
      return p;
    }
  }
  var np = { id: id, x: x, z: z, r: radius || 0.9, t: now };
  _peoplePositions.push(np);
  return np;
}
function clearPersonBlocker(id){
  for (var i = _peoplePositions.length - 1; i >= 0; i--){
    if (_peoplePositions[i].id === id) _peoplePositions.splice(i, 1);
  }
}
/* _personAt(x, z) — true if a live (non-expired) registered person
   stands at this position. Expired entries are swept as we scan. */
function _personAt(x, z){
  var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  for (var i = _peoplePositions.length - 1; i >= 0; i--){
    var p = _peoplePositions[i];
    if (now - p.t > 600){ _peoplePositions.splice(i, 1); continue; }
    var dx = x - p.x, dz = z - p.z, rr = p.r + 0.4;
    if (dx*dx + dz*dz < rr*rr) return true;
  }
  return false;
}

/* _isSolidAt(x, z) — true if a solid object (prop, tree, building wall,
   fence, interior furniture) is at this position. Uses the game's
   existing spatial structures — no new per-frame scanning. */
function _isSolidAt(x, z){
  var R = 1.0;  // check radius in world units

  /* 1. Prop/tree colliders via propGrid (40u cells, 3x3 neighborhood).
     This is the same grid resolveCollision uses — already fast. */
  try {
    if (typeof propGrid !== 'undefined' && propGrid){
      var gx = Math.floor(x / 40), gz = Math.floor(z / 40);
      for (var ix = gx-1; ix <= gx+1; ix++){
        for (var iz = gz-1; iz <= gz+1; iz++){
          var cell = propGrid[ix + ',' + iz];
          if (!cell) continue;
          for (var i = 0; i < cell.length; i++){
            var c = cell[i];
            var dx = x - c.x, dz = z - c.z;
            var cr = (c.r || 1.0) + R;
            if (dx*dx + dz*dz < cr*cr) return true;
          }
        }
      }
    }
  } catch(e){}

  /* 2. Building colliders via bldgGrid (40u cells, same as propGrid).
     Covers houses, commercial buildings, OSM buildings. */
  try {
    if (typeof bldgGrid !== 'undefined' && bldgGrid){
      var bx = Math.floor(x / 40), bz = Math.floor(z / 40);
      for (var jx = bx-1; jx <= bx+1; jx++){
        for (var jz = bz-1; jz <= bz+1; jz++){
          var bcell = bldgGrid[jx + ',' + jz];
          if (!bcell) continue;
          for (var j = 0; j < bcell.length; j++){
            var bc = bcell[j];
            var bdx = x - bc.x, bdz = z - bc.z;
            if (bc.hw !== undefined){
              /* 2026-10-18 COLLISION TRUTH (Joshua): rect-footprint
                 entries -- test the point against the building's real
                 oriented rectangle (same local-frame math as the
                 solver in index.html), expanded by the check radius R.
                 The old circle test (bounding radius + R) marked open
                 ground beside a house as SOLID metres from its walls. */
              var blx = bdx * bc.cy - bdz * bc.sy, blz = bdx * bc.sy + bdz * bc.cy;
              var bqx = blx < -bc.hw ? -bc.hw : (blx > bc.hw ? bc.hw : blx);
              var bqz = blz < -bc.hd ? -bc.hd : (blz > bc.hd ? bc.hd : blz);
              var bex = blx - bqx, bez = blz - bqz;
              if (bex * bex + bez * bez < R * R) return true;
              continue;
            }
            var br = (bc.r || 2.0) + R;
            if (bdx*bdx + bdz*bdz < br*br) return true;
          }
        }
      }
    }
  } catch(e){}

  /* 3. Interior furniture/walls — Phase C: interior boxes are
     registered as material solids in THIS module (registerSolidBox);
     interior_system.js no longer keeps a private collision store, so
     this is the same truth the gate and the push-out read. */
  if (solidBoxAt(x, z, R)) return true;

  return false;
}

/* ---------------------------------------------------------------------------
   canMoveTo(fromX, fromZ, toX, toZ, moverType) — THE movement gate.

   Returns true if the mover may occupy (toX, toZ), false if blocked.
   This is called BEFORE committing a move. It's a single material lookup,
   not a collision scan.

   Rules:
   - PLAYER/NPC on foot:
     - Blocked by: SOLID, WATER (deep), DOOR (closed)
     - Allowed on: NONE (grass, ground), ROAD (can walk on roads)
   - VEHICLE:
     - Blocked by: SOLID, WATER, DOOR (closed)
     - GRASS rule (Joshua 2026-10-11, refined same night): grass driving
       is LIMITED, not banned.
       * PLAYER-DRIVEN vehicles: always allowed on grass (player exception).
         Pass opts.playerDriven = true.
       * NPC vehicles may leave the road onto grass ONLY when:
         (a) PARKING AT HOME — within HOME_GRASS_RADIUS of their assigned
             home (opts.home) AND moving slow (parking maneuver speed).
         (b) PULLING OVER — an obstacle (stopped vehicle, accident marker,
             roadblock) is ahead on the road AND moving slow AND staying
             near the road shoulder (within SHOULDER_WIDTH of asphalt).
       * Everything else: blocked. No straight-line grass shortcuts or
         off-roading for NPCs.
       * Intersections/driveways: still allowed (pre-existing behavior).
       * GRASS SESSIONS: an NPC vehicle that leaves the road under
         exception (a) or (b) gets a session (keyed by opts.key). Every
         subsequent grass move is re-checked against the exception bounds,
         so a pull-over vehicle can't wander off into a field and a
         home-parking vehicle can't drive away across the lawn. Driving
         back onto the road ends the session.
   --------------------------------------------------------------------------- */
function canMoveTo(fromX, fromZ, toX, toZ, moverType, opts){
  moverType = moverType || MOVER_PLAYER;
  opts = opts || {};  /* {playerDriven, speed, key, home, heading, selfRef, levelY} */
  var targetMat, fromMat;

  /* Phase C LEVELS: opts.levelY is the mover's current surface height.
     When supplied, materials resolve at that level — a vehicle on a
     bridge deck may cross the span; the same vehicle at ground level
     meets the deck's blocked under-space. */
  var _lvl = (typeof opts.levelY === 'number' && isFinite(opts.levelY))
    ? opts.levelY : null;

  /* Fresh (uncached) lookups: the 20u cache cell can straddle a road
     edge, so from and to need exact materials for the grass rules. */
  try {
    targetMat = (_lvl !== null)
      ? getMaterialAtLevel(toX, toZ, _lvl) : getMaterialAt(toX, toZ, true);
  } catch(e){ return true; }  // lookup failed -> permissive

  /* --- Universal blocks --- */
  if (targetMat === COLLISION_MATERIALS.SOLID) return false;
  if (targetMat === COLLISION_MATERIALS.DOOR) return false;  // closed door
  if (targetMat === COLLISION_MATERIALS.PERSON){
    /* PEOPLE (Joshua 2026-10-28): a person is a dynamic material.
       Vehicles stop for people. People never block each other — and
       never block themselves: the gate checks the step AHEAD, and a
       person is allowed to be where a person already is. */
    return moverType !== MOVER_VEHICLE;
  }
  if (targetMat === COLLISION_MATERIALS.WATER){
    /* WATER (Joshua 2026-10-11): "it should be a matter of depth."
       - SHALLOW (at/below SINK_DEPTH, ~3 ft): FORDABLE — vehicles drive
         through, players wade. No block.
       - DEEP (above SINK_DEPTH): the PLAYER may drive in anyway (then the
         car sinks via updateCar's sinking logic — consequences, not walls).
         NPC vehicles stop at the shore — they're not that reckless.
       - On foot: players/NPCs wade up to 3.0u; deeper water is handled by
         the swim system in updatePlayer (swim mode), not by blocking here.
       Without depth info, block conservatively (old behavior). */
    try {
      if (typeof waterDepthAt === 'function'){
        var depth = waterDepthAt(toX, toZ);
        if (moverType === MOVER_PLAYER || moverType === MOVER_NPC){
          if (depth > 3.0) return false;  // too deep to wade — swim system takes over
        } else {  // vehicle
          var sinkD = (typeof SINK_DEPTH !== 'undefined') ? SINK_DEPTH : 0.91;
          if (depth <= sinkD) return true;      // shallow: ford straight through
          if (opts.playerDriven) return true;  // deep: player may enter, car will sink
          return false;                        // deep: NPC vehicles hold at the shore
        }
        /* Shallow water: allow (swim/sink logic handles the rest). */
      } else {
        return false;  // no depth info -> block conservatively
      }
    } catch(e){ return false; }
  }

  /* --- Vehicle grass rules (Joshua 2026-10-11, refined same night) ---
     Grass driving is LIMITED, not banned. The player drives on grass
     freely; NPC vehicles may only pull onto grass to park at home or to
     pull over for an obstacle. */
  if (moverType === MOVER_VEHICLE){
    /* PLAYER EXCEPTION: Joshua's own driving is unrestricted on grass.
       Universal blocks (buildings, deep water, closed doors) still apply. */
    if (opts.playerDriven) return true;

    try { fromMat = (_lvl !== null)
      ? getMaterialAtLevel(fromX, fromZ, _lvl) : getMaterialAt(fromX, fromZ, true); }
    catch(e){ fromMat = COLLISION_MATERIALS.NONE; }

    var vKey = opts.key || null;   // vehicle identity for grass sessions
    var vSpeed = Math.abs(opts.speed || 0);  // world-units/sec

    /* Case 1: leaving the road onto grass. */
    if (fromMat === COLLISION_MATERIALS.ROAD &&
        targetMat !== COLLISION_MATERIALS.ROAD){
      /* (a) PARKING AT HOME: near their own home + slow parking maneuver. */
      if (vSpeed <= PARK_SPEED_US && _nearHome(toX, toZ, opts)){
        _startGrassSession(vKey, 'home', opts);
        return true;
      }
      /* (b) PULLING OVER: obstacle ahead + slow + staying on the shoulder. */
      if (vSpeed <= PULLOVER_SPEED_US &&
          _nearRoadShoulder(toX, toZ) &&
          _obstacleAhead(fromX, fromZ, toX, toZ, opts)){
        _startGrassSession(vKey, 'shoulder', opts);
        return true;
      }
      /* (c) Intersections/driveways (pre-existing allowance). */
      if (_isNearIntersection(toX, toZ) || _isNearDriveway(toX, toZ)){
        return true;
      }
      return false;  // straight-line grass cutting / off-roading: blocked
    }

    /* Case 2: already on grass with an active session — re-check bounds.
       A pull-over vehicle must stay on the shoulder; a home-parking
       vehicle must stay near home. */
    if (vKey && fromMat !== COLLISION_MATERIALS.ROAD &&
        targetMat !== COLLISION_MATERIALS.ROAD){
      var sess = _grassSessions[vKey];
      if (sess && !_grassSessionExpired(sess)){
        if (sess.reason === 'home'){
          var sessHome = opts.home || sess.home;
          if (!_nearHome(toX, toZ, {home: sessHome})) return false;
        } else {  /* 'shoulder' */
          if (!_nearRoadShoulder(toX, toZ)) return false;
        }
      }
    }

    /* Case 3: driving back onto the road ends the grass session. */
    if (vKey && targetMat === COLLISION_MATERIALS.ROAD &&
        _grassSessions[vKey]){
      delete _grassSessions[vKey];
    }
  }

  return true;  // all checks passed
}

/* _isNearIntersection(x, z) — true if within snap distance of a road
   junction. Uses junction_pins data if available. */
function _isNearIntersection(x, z){
  try {
    /* junction_pins.js provides JUNCTION_PINS array. */
    if (typeof JUNCTION_PINS !== 'undefined' && JUNCTION_PINS.length){
      var R2 = 30 * 30;  // 30u radius
      for (var i = 0; i < JUNCTION_PINS.length; i++){
        var j = JUNCTION_PINS[i];
        var dx = x - j.x, dz = z - j.z;
        if (dx*dx + dz*dz < R2) return true;
      }
    }
  } catch(e){}
  /* Fallback: if multiple road segments nearby, it's likely an intersection. */
  try {
    if (typeof gridSegsNear === 'function'){
      var segs = gridSegsNear(x, z, 1);
      /* 3+ distinct segments nearby suggests a junction. */
      if (segs && segs.length >= 3) return true;
    }
  } catch(e){}
  return false;
}

/* _isNearDriveway(x, z) — true if near a driveway or parking area.
   Driveways are building-adjacent road connections. For v1, we check
   proximity to building positions (driveways connect buildings to roads). */
function _isNearDriveway(x, z){
  /* v1: conservative — check if near any building with a parking/driveway
     flag. Full driveway geometry comes in a later version. */
  try {
    /* WalkableBuildings from building_spawner.js have positions. */
    if (typeof window !== 'undefined' && window.WalkableBuildings){
      var buildings = window.WalkableBuildings;
      var R2 = 40 * 40;
      for (var i = 0; i < buildings.length; i++){
        var b = buildings[i];
        var bx = b.x !== undefined ? b.x : (b.position ? b.position[0] : 0);
        var bz = b.z !== undefined ? b.z : (b.position ? b.position[1] : 0);
        var dx = x - bx, dz = z - bz;
        if (dx*dx + dz*dz < R2) return true;
      }
    }
  } catch(e){}
  return false;
}

/* ---------------------------------------------------------------------------
   GRASS-DRIVING LIMITS (Joshua 2026-10-11, refined same night).

   Grass driving is LIMITED, not banned. NPC vehicles may leave the road
   onto grass only to (a) park at their home or (b) pull over for an
   obstacle. The player drives on grass freely.
   --------------------------------------------------------------------------- */

/* Speed conversion: game speeds are world-units/sec. MPH_PER_US is defined
   in index.html (65/30); fall back to the same constant here. */
var _MPH_PER_US = (typeof MPH_PER_US !== 'undefined') ? MPH_PER_US : (65/30);

var HOME_GRASS_RADIUS  = 80;                  // u — "near home" for grass parking
var PARK_SPEED_US      = 10 / _MPH_PER_US;    // 10 mph — parking maneuver speed
var PULLOVER_SPEED_US  = 25 / _MPH_PER_US;    // 25 mph — pull-over maneuver speed
var SHOULDER_WIDTH     = 15;                  // u — off-asphalt "shoulder" band
var OBSTACLE_AHEAD_DIST= 40;                  // u — how far ahead we scan
var GRASS_SESSION_MS   = 60000;               // grass session expiry (1 min)

/* _grassSessions: key -> {reason:'home'|'shoulder', home, start}.
   Tracks NPC vehicles currently on grass under an exception so every
   subsequent grass move stays within the exception bounds. */
var _grassSessions = {};

function _startGrassSession(key, reason, opts){
  /* No identity -> stateless (no session tracking possible). */
  if (!key) return;
  var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  _grassSessions[key] = {
    reason: reason,
    home: opts.home || (opts.vehicle && opts.vehicle.home) || null,
    start: now
  };
}

function _grassSessionExpired(sess){
  var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  return (now - sess.start) > GRASS_SESSION_MS;
}

/* _resolveHome(opts, sess) — the vehicle's home as {x, z} or [x, z].
   Accepts opts.home, opts.vehicle.home, or the session's stored home. */
function _resolveHome(opts, sess){
  var h = opts.home || (opts.vehicle && opts.vehicle.home) ||
          (sess && sess.home) || null;
  if (!h) return null;
  var hx = (h.x !== undefined) ? h.x : h[0];
  var hz = (h.z !== undefined) ? h.z : h[1];
  if (hx === undefined || hz === undefined) return null;
  return {x: hx, z: hz};
}

/* _nearHome(x, z, opts) — true if within HOME_GRASS_RADIUS of the vehicle's
   assigned home/residence. */
function _nearHome(x, z, opts){
  var home = _resolveHome(opts || {}, null);
  if (!home) return false;
  var dx = x - home.x, dz = z - home.z;
  return dx*dx + dz*dz < HOME_GRASS_RADIUS * HOME_GRASS_RADIUS;
}

/* _nearRoadShoulder(x, z) — true if asphalt is within SHOULDER_WIDTH of
   this off-road position (i.e. it's the grass shoulder, not a field).
   Samples 8 points around the position; any onRoad hit counts. */
function _nearRoadShoulder(x, z){
  if (typeof onRoad !== 'function') return false;
  try {
    var R = SHOULDER_WIDTH, D = SHOULDER_WIDTH * 0.7;
    var pts = [[R,0],[-R,0],[0,R],[0,-R],[D,D],[-D,D],[D,-D],[-D,-D]];
    for (var i = 0; i < pts.length; i++){
      if (onRoad(x + pts[i][0], z + pts[i][1])) return true;
    }
  } catch(e){}
  return false;
}

/* _obstacleAhead(fromX, fromZ, toX, toZ, opts) — true if something is
   blocking the road ahead of the vehicle (a stopped vehicle, accident,
   or roadblock), giving it a reason to pull onto the grass shoulder.
   Direction comes from the move vector, or opts.heading (radians, same
   convention as car.yaw: x += sin(h), z += cos(h)). */
function _obstacleAhead(fromX, fromZ, toX, toZ, opts){
  /* Prefer the vehicle's actual heading: a pull-over move is lateral
     (toward the shoulder), but the obstacle sits ahead along the road —
     i.e. in the heading direction, not along the move vector. Fall back
     to the move vector when no heading is given. */
  var hx, hz;
  var h = opts.heading;
  if (h !== undefined && h !== null){
    hx = Math.sin(h); hz = Math.cos(h);  // same convention as car.yaw
  } else {
    hx = toX - fromX; hz = toZ - fromZ;
    var len = Math.sqrt(hx*hx + hz*hz);
    if (len < 0.01) return false;  // not moving and no heading: no info
    hx /= len; hz /= len;
  }

  /* 1. Stopped/slow vehicles ahead, via the game's vehicle-avoid grid. */
  try {
    if (typeof window !== 'undefined' && window.VehicleAvoid &&
        typeof window.VehicleAvoid.blockedAhead === 'function'){
      var hit = window.VehicleAvoid.blockedAhead(
        fromX, fromZ, hx, hz, opts.selfRef || null,
        OBSTACLE_AHEAD_DIST, 1.1, false);
      if (hit) return true;
    }
  } catch(e){}

  /* 2. Accident markers / road-closed flags (set by game systems when an
     accident or roadblock exists; empty array = none). */
  try {
    var markers = (typeof window !== 'undefined') ? window.ACCIDENT_MARKERS : null;
    if (markers && markers.length){
      var latBound = 6;  // must be roughly in our lane
      for (var i = 0; i < markers.length; i++){
        var m = markers[i];
        var dx = m.x - fromX, dz = m.z - fromZ;
        var fwd = dx*hx + dz*hz;
        if (fwd < 0 || fwd > OBSTACLE_AHEAD_DIST) continue;
        var lat = Math.abs(dx * (-hz) + dz * hx);
        if (lat < latBound) return true;
      }
    }
  } catch(e){}

  return false;
}

/* ---------------------------------------------------------------------------
   tryMove(mover, newX, newZ, moverType, opts) — convenience wrapper.

   mover: {x, z} object (player, car, NPC).
   opts: same options as canMoveTo (playerDriven, speed, key, home, ...).
   Returns true if the move was applied, false if blocked by material.
   If blocked, the mover stays at its current position (no slide — the
   old resolveCollision handles sliding as fallback).
   --------------------------------------------------------------------------- */
function tryMove(mover, newX, newZ, moverType, opts){
  if (!mover) return false;
  if (canMoveTo(mover.x, mover.z, newX, newZ, moverType, opts)){
    mover.x = newX;
    mover.z = newZ;
    return true;
  }
  return false;
}


/* ===========================================================================
   PHASE C (2026-10-28) — ONE GATE FOR EVERY MOVER, PACKAGE TRUTH, LEVELS,
   AND THE ONLY PUSH-OUT.

   - setPackageProvider(provider): map_loader.js registers the active map
     package's material provider (materialAt / materialAtLevel / surfaceY /
     pushOutRings over the package's baked data). getMaterialAt consults it
     after PERSON; surfaceYAt consults its surfaces. One provider at a
     time; registering replaces and invalidates the material cache.
   - getMaterialAtLevel(x, z, levelY): material at a point FOR A MOVER AT
     levelY — bridge decks read as their surface on deck level and as
     blocked under-space at ground level. Without a package, levels change
     nothing (legacy world has no deck data) and this equals getMaterialAt.
   - registerSolidBox / solidBoxAt: the interior system's furniture and
     wall boxes live HERE now (material solids). interior_system.js
     registers its boxes into this registry (early registrations stage
     through window.__pendingSolidBoxes, adopted below at load).
   - registerWallSegment: wall segments (hero-house walls, school and
     hotel walls — zero-thickness, floor-banded) register here from
     index.html's addSegCollider. A point lookup cannot see a zero-
     thickness wall, so segments are push-out truth only — the gate
     governs destinations, pushOut resolves contact, both read this one
     registry (plus propGrid / bldgGrid, the same data _isSolidAt reads).
   - pushOut(p, radius): THE solver. index.html's resolveCollision()
     delegates here; its old private solvers (prop circles / building
     rects / segment loop) were deleted with it. Two iterations, same
     contact math the old solvers used, over the same registries the
     gate reads — one truth, no second system.
   =========================================================================== */
var _pkgProvider = null;      // active map package provider (map_loader.js)
var _groundSampler = null;    // active package terrain sampler (runtime Y)

function setPackageProvider(provider){
  _pkgProvider = provider || null;
  invalidateMaterialCache();
}
function setGroundSampler(fn){
  _groundSampler = (typeof fn === 'function') ? fn : null;
  invalidateMaterialCache();
}

/* getMaterialAtLevel(x, z, levelY) — level-aware material lookup. */
function getMaterialAtLevel(x, z, levelY){
  if (typeof levelY !== 'number' || !isFinite(levelY))
    return getMaterialAt(x, z, true);
  /* People read at every level — a person on a deck still stops cars. */
  try { if (_personAt(x, z)) return COLLISION_MATERIALS.PERSON; } catch(e){}
  if (_pkgProvider){
    try {
      var m = _pkgProvider.materialAtLevel(x, z, levelY);
      if (m !== null && m !== undefined) return m;
    } catch(e){}
  }
  return getMaterialAt(x, z, true);
}

/* ---------------- material solid boxes (interiors) ---------------- */
var _solidBoxes = [];            // {id,minX,maxX,minZ,maxZ,buildingId}
var _solidBoxHash = {};          // "gx,gz" -> [box] (40u cells)
var _solidBoxSeq = 0;
function _solidBoxCells(b, fn){
  var gx0 = Math.floor(b.minX / 40), gx1 = Math.floor(b.maxX / 40);
  var gz0 = Math.floor(b.minZ / 40), gz1 = Math.floor(b.maxZ / 40);
  /* A pathological box spanning the map would flood the hash; interior
     boxes are room-scale — cap the span and fall back to a full scan in
     solidBoxAt when a box was too large to hash (flagged _huge). */
  if (gx1 - gx0 > 8 || gz1 - gz0 > 8){ b._huge = true; return; }
  for (var gx = gx0; gx <= gx1; gx++)
    for (var gz = gz0; gz <= gz1; gz++) fn(gx + ',' + gz);
}
function registerSolidBox(box){
  if (!box) return null;
  box.id = box.id || ('mbox' + (++_solidBoxSeq));
  _solidBoxes.push(box);
  _solidBoxCells(box, function(k){ (_solidBoxHash[k] = _solidBoxHash[k] || []).push(box); });
  invalidateMaterialCache();
  return box.id;
}
function unregisterSolidBox(id){
  for (var i = 0; i < _solidBoxes.length; i++){
    if (_solidBoxes[i].id === id){
      var b = _solidBoxes[i];
      _solidBoxes.splice(i, 1);
      _solidBoxCells(b, function(k){
        var cell = _solidBoxHash[k]; if (!cell) return;
        var j = cell.indexOf(b); if (j >= 0) cell.splice(j, 1);
      });
      invalidateMaterialCache();
      return true;
    }
  }
  return false;
}
function solidBoxAt(x, z, pad){
  /* pad (optional mover radius) restores the circle-vs-box semantics
     the interior system's own checkCollision used before Phase C */
  var p = pad || 0;
  var k = Math.floor(x / 40) + ',' + Math.floor(z / 40);
  var cell = _solidBoxHash[k];
  if (cell){
    for (var i = 0; i < cell.length; i++){
      var b = cell[i];
      if (x >= b.minX - p && x <= b.maxX + p && z >= b.minZ - p && z <= b.maxZ + p) return b;
    }
  }
  for (var j = 0; j < _solidBoxes.length; j++){
    var hb = _solidBoxes[j];
    if (hb._huge && x >= hb.minX - p && x <= hb.maxX + p && z >= hb.minZ - p && z <= hb.maxZ + p)
      return hb;
  }
  return null;
}
function listSolidBoxes(){ return _solidBoxes.slice(); }
function setSolidBoxes(arr){
  _solidBoxes = []; _solidBoxHash = {};
  if (arr) for (var i = 0; i < arr.length; i++){
    var b = arr[i];
    b.id = b.id || ('mbox' + (++_solidBoxSeq));
    _solidBoxes.push(b);
    _solidBoxCells(b, function(k){ (_solidBoxHash[k] = _solidBoxHash[k] || []).push(b); });
  }
  invalidateMaterialCache();
}
/* Adopt boxes the interior system staged before this module loaded
   (it sits earlier in the deferred queue). After adoption the registry
   here is the only store; interior_system delegates to it. */
try {
  if (typeof window !== 'undefined' && window.__pendingSolidBoxes &&
      window.__pendingSolidBoxes.length){
    setSolidBoxes(window.__pendingSolidBoxes);
    window.__pendingSolidBoxes = [];
  }
} catch(e){}

/* ---------------- wall segments (push-out truth) ---------------- */
var _wallSegs = [];              // {x1,z1,x2,z2,y0,y1}
var _wallSegHash = {};           // "gx,gz" -> [seg] (40u cells, bbox-filed)
function registerWallSegment(s){
  if (!s) return;
  var seg = { x1: s.x1, z1: s.z1, x2: s.x2, z2: s.z2,
              y0: (s.y0 === undefined ? -1e9 : s.y0),
              y1: (s.y1 === undefined ? 1e9 : s.y1) };
  _wallSegs.push(seg);
  var gx0 = Math.floor(Math.min(seg.x1, seg.x2) / 40), gx1 = Math.floor(Math.max(seg.x1, seg.x2) / 40);
  var gz0 = Math.floor(Math.min(seg.z1, seg.z2) / 40), gz1 = Math.floor(Math.max(seg.z1, seg.z2) / 40);
  for (var gx = gx0; gx <= gx1; gx++)
    for (var gz = gz0; gz <= gz1; gz++)
      (_wallSegHash[gx + ',' + gz] = _wallSegHash[gx + ',' + gz] || []).push(seg);
  return seg;
}
function wallSegmentsNear(x, z){
  var gx = Math.floor(x / 40), gz = Math.floor(z / 40), out = [], seen = [];
  for (var ix = gx - 1; ix <= gx + 1; ix++)
    for (var iz = gz - 1; iz <= gz + 1; iz++){
      var c = _wallSegHash[ix + ',' + iz]; if (!c) continue;
      for (var i = 0; i < c.length; i++)
        if (seen.indexOf(c[i]) === -1){ seen.push(c[i]); out.push(c[i]); }
    }
  return out;
}
/* Adopt any wall segments index.html staged before this module loaded
   (its segColliders array is the staging buffer; addSegCollider keeps
   registering new ones here as walls are built). */
try {
  if (typeof window !== 'undefined' && window.segColliders &&
      window.segColliders.length){
    for (var _wsi = 0; _wsi < window.segColliders.length; _wsi++)
      registerWallSegment(window.segColliders[_wsi]);
  }
} catch(e){}

/* ---------------- pushOut(p, radius) — THE solver ----------------
   Contact resolution over the SAME registries the gate reads:
   propGrid circles (floor-banded), bldgGrid rects/circles, package
   building rings, material solid boxes, wall segments (floor-banded).
   Mutates p in place; two iterations so stacked overlaps settle. */
function pushOut(p, radius){
  if (!p) return;
  radius = radius || 0.5;
  var py = -1e9;
  try { py = (p.y !== undefined) ? p.y
    : ((typeof player !== 'undefined' && player && player.mesh)
        ? player.mesh.position.y : -1e9); } catch(e){}
  for (var iter = 0; iter < 2; iter++){
    /* (1) prop/tree circles via propGrid (floor-aware) */
    try {
      if (typeof propGrid !== 'undefined' && propGrid){
        var cx = Math.floor(p.x / 40), cz = Math.floor(p.z / 40);
        for (var gx = cx - 1; gx <= cx + 1; gx++)
        for (var gz = cz - 1; gz <= cz + 1; gz++){
          var cell = propGrid[gx + ',' + gz]; if (!cell) continue;
          for (var i = 0; i < cell.length; i++){
            var c = cell[i];
            if (py < c.y0 || py > c.y1) continue;
            var dx = p.x - c.x, dz = p.z - c.z;
            var d = Math.sqrt(dx * dx + dz * dz), min = c.r + radius;
            if (d < min && d > 0.001){
              var push = (min - d) / d;
              p.x += dx * push; p.z += dz * push;
            }
          }
        }
      }
    } catch(e){}
    /* (2) buildings via bldgGrid — oriented rect where the entry carries
       the real footprint (2026-10-18 collision truth), circle otherwise */
    try {
      if (typeof bldgGrid !== 'undefined' && bldgGrid){
        var bx = Math.floor(p.x / 40), bz = Math.floor(p.z / 40);
        for (var hx = bx - 1; hx <= bx + 1; hx++)
        for (var hz = bz - 1; hz <= bz + 1; hz++){
          var bcell = bldgGrid[hx + ',' + hz]; if (!bcell) continue;
          for (var j = 0; j < bcell.length; j++){
            var bc = bcell[j];
            if (bc.hw !== undefined){
              var rdx = p.x - bc.x, rdz = p.z - bc.z;
              var lx = rdx * bc.cy - rdz * bc.sy, lz = rdx * bc.sy + rdz * bc.cy;
              var qx = lx < -bc.hw ? -bc.hw : (lx > bc.hw ? bc.hw : lx);
              var qz = lz < -bc.hd ? -bc.hd : (lz > bc.hd ? bc.hd : lz);
              var ex = lx - qx, ez = lz - qz;
              var ed2 = ex * ex + ez * ez;
              if (ed2 > 0.000001){
                var ed = Math.sqrt(ed2);
                if (ed < radius){
                  var rp = (radius - ed) / ed;
                  var wpx = ex * rp, wpz = ez * rp;
                  p.x += wpx * bc.cy + wpz * bc.sy;
                  p.z += -wpx * bc.sy + wpz * bc.cy;
                }
              } else {
                var pxa = bc.hw - Math.abs(lx), pza = bc.hd - Math.abs(lz);
                if (pxa < pza) lx = (lx < 0 ? -1 : 1) * (bc.hw + radius);
                else lz = (lz < 0 ? -1 : 1) * (bc.hd + radius);
                p.x = bc.x + lx * bc.cy + lz * bc.sy;
                p.z = bc.z - lx * bc.sy + lz * bc.cy;
              }
              continue;
            }
            var bdx = p.x - bc.x, bdz = p.z - bc.z;
            var bd = Math.sqrt(bdx * bdx + bdz * bdz), bmin = bc.r + radius;
            if (bd < bmin && bd > 0.001){
              var bpush = (bmin - bd) / bd;
              p.x += bdx * bpush; p.z += bdz * bpush;
            }
          }
        }
      }
    } catch(e){}
    /* (3) package building rings (baked footprint truth) */
    if (_pkgProvider){
      try { _pkgProvider.pushOutRings(p, radius); } catch(e){}
    }
    /* (4) material solid boxes (interiors): AABB push-out, slides along
       faces; a centre inside the box ejects by the smallest penetration */
    for (var bi = 0; bi < _solidBoxes.length; bi++){
      var bb = _solidBoxes[bi];
      if (p.x < bb.minX - radius || p.x > bb.maxX + radius ||
          p.z < bb.minZ - radius || p.z > bb.maxZ + radius) continue;
      var ccx = p.x < bb.minX ? bb.minX : (p.x > bb.maxX ? bb.maxX : p.x);
      var ccz = p.z < bb.minZ ? bb.minZ : (p.z > bb.maxZ ? bb.maxZ : p.z);
      var bdx2 = p.x - ccx, bdz2 = p.z - ccz;
      var bd2 = bdx2 * bdx2 + bdz2 * bdz2;
      if (bd2 < radius * radius){
        if (bd2 > 1e-8){
          var bd3 = Math.sqrt(bd2), bp2 = (radius - bd3) / bd3;
          p.x += bdx2 * bp2; p.z += bdz2 * bp2;
        } else {
          var pl = p.x - bb.minX, pr = bb.maxX - p.x;
          var pt = p.z - bb.minZ, pb = bb.maxZ - p.z;
          var m = Math.min(pl, pr, pt, pb);
          if (m === pl) p.x = bb.minX - radius;
          else if (m === pr) p.x = bb.maxX + radius;
          else if (m === pt) p.z = bb.minZ - radius;
          else p.z = bb.maxZ + radius;
        }
      }
    }
    /* (5) wall segments (floor-banded, zero thickness) */
    var segs = wallSegmentsNear(p.x, p.z);
    for (var si = 0; si < segs.length; si++){
      var sg = segs[si];
      if (py < sg.y0 || py > sg.y1) continue;
      var vx = sg.x2 - sg.x1, vz = sg.z2 - sg.z1;
      var len2 = vx * vx + vz * vz; if (len2 < 0.0001) continue;
      var t = ((p.x - sg.x1) * vx + (p.z - sg.z1) * vz) / len2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      var sx = sg.x1 + vx * t, sz = sg.z1 + vz * t;
      var sex = p.x - sx, sez = p.z - sz;
      var sed = Math.sqrt(sex * sex + sez * sez);
      if (sed < radius && sed > 0.001){
        var sp = (radius - sed) / sed;
        p.x += sex * sp; p.z += sez * sp;
      } else if (sed <= 0.001){
        /* centre exactly ON the zero-thickness wall: no push direction
           exists along the offset — step off along the wall's normal */
        var nl = Math.sqrt(len2);
        p.x += (-vz / nl) * radius; p.z += (vx / nl) * radius;
      }
    }
  }
}

/* ---------------------------------------------------------------------------
   Public API
   --------------------------------------------------------------------------- */
window.CollisionMaterial = {
  MATERIALS: COLLISION_MATERIALS,
  MOVER_PLAYER: MOVER_PLAYER,
  MOVER_VEHICLE: MOVER_VEHICLE,
  MOVER_NPC: MOVER_NPC,
  getMaterialAt: getMaterialAt,
  canMoveTo: canMoveTo,
  tryMove: tryMove,
  registerDoor: registerDoor,
  invalidateCache: invalidateMaterialCache,
  /* v1.62 vertical layering (Joshua: material system owns the
     road-on-grass relationship). */
  ROAD_LIFT: ROAD_LIFT,
  MATERIAL_LAYERS: MATERIAL_LAYERS,
  grassSurfaceY: grassSurfaceY,
  surfaceHeightAt: surfaceHeightAt,
  materialRoadTopY: materialRoadTopY,
  /* v1.63 vehicle rest surface (Joshua: "this should be a material thing
     for the cars"). */
  surfaceYAt: surfaceYAt,
  /* Phase C: levels, package provider, interior solid boxes, wall
     segments, and the one push-out solver. */
  getMaterialAtLevel: getMaterialAtLevel,
  setPackageProvider: setPackageProvider,
  setGroundSampler: setGroundSampler,
  registerSolidBox: registerSolidBox,
  unregisterSolidBox: unregisterSolidBox,
  solidBoxAt: solidBoxAt,
  listSolidBoxes: listSolidBoxes,
  setSolidBoxes: setSolidBoxes,
  registerWallSegment: registerWallSegment,
  pushOut: pushOut,
  setPersonBlocker: setPersonBlocker,
  clearPersonBlocker: clearPersonBlocker
};

/* Also expose the key functions globally for index.html integration. */
window.getMaterialAt = getMaterialAt;
window.getMaterialAtLevel = getMaterialAtLevel;
window.canMoveTo = canMoveTo;
window.surfaceHeightAt = surfaceHeightAt;
window.grassSurfaceY = grassSurfaceY;
window.surfaceYAt = surfaceYAt;
