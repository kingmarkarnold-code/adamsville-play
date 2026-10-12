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
   ============================================================================ */

/* Material types. Higher number = more restrictive (for priority). */
var COLLISION_MATERIALS = {
  NONE:  0,  // Air, decorations, open ground — no restriction
  ROAD:  2,  // Road surface — vehicles constrained to road network
  WATER: 3,  // Water — blocks all ground movement
  DOOR:  4,  // Door — solid when closed, passable when open
  SOLID: 1   // Walls, buildings, trees, fences — cannot pass through
};
/* Note: SOLID=1 is intentionally lower than ROAD/WATER/DOOR so that
   specific materials (road, water, door) take priority in the lookup.
   The numeric order is: NONE < SOLID < ROAD < WATER < DOOR. */

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

  var mat = COLLISION_MATERIALS.NONE;

  try {
    /* --- WATER: highest priority after DOOR --- */
    /* inWater() is defined in index.html; scans the small WATER array. */
    if (typeof inWater === 'function' && inWater(x, z)){
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
    /* Any lookup failure = treat as NONE (permissive, old system catches it). */
    mat = COLLISION_MATERIALS.NONE;
  }

  /* --- Store in cache (movement-gate lookups skip the cache entirely) --- */
  if (!skipCache){
    _matCache[key] = { mat: mat, time: now, gen: _matCacheTime };
  }
  return mat;
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
            var br = (bc.r || 2.0) + R;
            if (bdx*bdx + bdz*bdz < br*br) return true;
          }
        }
      }
    }
  } catch(e){}

  /* 3. Interior furniture/walls via InteriorCollision (only when inside). */
  try {
    if (typeof window !== 'undefined' && window.InteriorCollision &&
        window.InteriorCollision.checkCollision(x, z)){
      return true;
    }
  } catch(e){}

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
  opts = opts || {};  /* {playerDriven, speed, key, home, heading, selfRef} */
  var targetMat, fromMat;

  /* Fresh (uncached) lookups: the 20u cache cell can straddle a road
     edge, so from and to need exact materials for the grass rules. */
  try {
    targetMat = getMaterialAt(toX, toZ, true);
  } catch(e){ return true; }  // lookup failed -> permissive

  /* --- Universal blocks --- */
  if (targetMat === COLLISION_MATERIALS.SOLID) return false;
  if (targetMat === COLLISION_MATERIALS.DOOR) return false;  // closed door
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

    try { fromMat = getMaterialAt(fromX, fromZ, true); }
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
  invalidateCache: invalidateMaterialCache
};

/* Also expose the key functions globally for index.html integration. */
window.getMaterialAt = getMaterialAt;
window.canMoveTo = canMoveTo;
