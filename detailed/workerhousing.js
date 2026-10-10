/* ============================================================================
   FILE: workerhousing.js — "Surviving Adamsville" WORKER HOUSING
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-09):
     "Use some of the houses all over the city that are not able for the user
      to enter for the NPCs from all the various departments as their houses.
      If you can space them out so that they're not all in the same area that
      would be preferred. This will give more activity, more traffic."

     "This will make it so that those crews that are not 24/7 will have a
      full schedule: they wake up, they go to work, they do their job, they
      get off, they travel home, they go in the house, they go to sleep."

   WHAT THIS DOES:
     1. Assigns a HOME to every worker in the cityworkforce roster (58 workers
        across 6 departments) using non-enterable residential houses from
        PLACED_HOUSES.
     2. GEOGRAPHIC DISTRIBUTION: the residential map is divided into a 4x4
        grid (16 sectors). Workers are assigned round-robin across sectors so
        homes are spread across all neighborhoods — not clustered.
     3. FULL DAILY SCHEDULE for each worker, synced to the daycycle game clock
        (124-min days):
          - WAKE at home (06:00, visible near house)
          - COMMUTE to HQ (07:30, hidden — in vehicle)
          - WORK at HQ (08:30-17:00, inside building)
          - COMMUTE home (17:00, hidden — in vehicle)
          - HOME evening (18:00, visible near house)
          - SLEEP (22:00, hidden — inside house)
        24/7 departments (dispatch, code enforcement) run rotating 8-hour
        shifts so someone is always on duty.
     4. VISUAL: a pool of simple civilian figures represents workers who are
        currently HOME and near the camera. Figures walk to their door when
        leaving/sleeping ("they go in the house").
     5. INTEGRATION: respects cityworkforce deployment status. A DEPLOYED
        worker stays at their job site (represented by the crew figure) and
        does not follow the home routine until the job ends.

   PERFORMANCE (TCL T513V budget):
     - 58 workers are DATA (cheap). Only a pool of 24 simple figures is ever
       rendered, assigned to HOME-state workers nearest the camera.
     - Each figure is 7 boxes (body, head, 2 arms, 2 legs, hair) — ~168 meshes
       max, all tiny. Figures are hidden (visible=false) when not in use.
     - Home "presence" for far workers: a warm window-light sprite at their
       house when they're home (1 sprite each, only within 800u of camera).

   STANDALONE MODULE. Include AFTER cityworkforce.js in index.html:
       <script src="workerhousing.js"></script>
   Zero edits to existing files. All reads are guarded.

   PUBLIC API (window.WorkerHousing):
     workers()       -> array of {name, dept, role, shift, state, homeX, homeZ}
     homes()         -> array of assigned home positions
     stats()         -> {total, home, atWork, commuting, sleeping, deployed}
     toggle(f)       -> show/hide the housing HUD panel
   ============================================================================ */
(function(){
'use strict';
/* Single-instance guard. */
if (window.WorkerHousing) return;

/* ================= config ================= */
var LS_HOMES = 'sa_workerhousing_v1';   // persisted home assignments
var POOL_SIZE = 24;          // max simultaneous worker figures (TCL budget)
var FIGURE_RANGE = 600;      // figures assigned to HOME workers within this range (u)
var LIGHT_RANGE = 800;       // window-light sprites within this range (u)

/* Schedule times in game-minutes (day shift). Shift offsets added for 24/7 depts. */
var T_WAKE   = 360;    // 06:00 — wake up, appear at home
var T_TOWORK = 450;    // 07:30 — leave for work (commute)
var T_ATWORK = 510;    // 08:30 — arrive at HQ
var T_TOHOME = 1020;   // 17:00 — leave work (commute)
var T_ATHOME = 1080;   // 18:00 — arrive home
var T_SLEEP  = 1320;   // 22:00 — go inside to sleep

/* Worker states. */
var ST = {
  SLEEP: 0,     // 22:00-06:00, inside house (hidden)
  HOME: 1,      // at home, visible near house
  TO_WORK: 2,   // commuting to HQ (hidden, in vehicle)
  AT_WORK: 3,   // at HQ (hidden, inside building)
  TO_HOME: 4,   // commuting home (hidden, in vehicle)
  DEPLOYED: 5   // on a job site (represented by crew figure, hidden here)
};
var ST_NAMES = ['SLEEP','HOME','TO_WORK','AT_WORK','TO_HOME','DEPLOYED'];

/* 24/7 departments run rotating shifts. Others are day-shift only. */
var SHIFT_DEPTS = { dispatch: true, code: true };

/* ================= state ================= */
var WH = null;  // { workers:[], homesAssigned, ready, hq }

/* Deterministic pseudo-random (stable across sessions). */
var _seed = 1234567;
function srand(){
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}

/* ================= home assignment ================= */
/* getResidentialHouses — PLACED_HOUSES filtered to non-enterable residential.
   Excludes downtown and any house near an ENTERABLES door (player-enterable). */
function getResidentialHouses(){
  var houses = [];
  try {
    if (typeof PLACED_HOUSES === 'undefined' || !PLACED_HOUSES.length) return houses;
    /* Collect enterable door positions to exclude. */
    var doors = [];
    try {
      if (typeof ENTERABLES !== 'undefined' && ENTERABLES.length){
        for (var e = 0; e < ENTERABLES.length; e++){
          var en = ENTERABLES[e];
          if (en && typeof en.doorX === 'number'){
            doors.push({ x: en.doorX, z: en.doorZ });
          }
        }
      }
    } catch(x){}
    /* Also exclude the 535 home base (player's house). */
    var homeBase = null;
    try {
      if (typeof HOME !== 'undefined' && HOME && typeof HOME.x === 'number'){
        homeBase = { x: HOME.x, z: HOME.z };
      }
    } catch(x){}

    for (var i = 0; i < PLACED_HOUSES.length; i++){
      var h = PLACED_HOUSES[i];
      if (!h || h.length < 2) continue;
      var x = h[0], z = h[1];
      if (!isFinite(x) || !isFinite(z)) continue;
      /* Skip downtown (x > 6000 && z < 4000) — that's offices, not homes. */
      if (x > 6000 && z < 4000) continue;
      /* Skip near enterable doors (player-enterable buildings). */
      var skip = false;
      for (var d = 0; d < doors.length; d++){
        var dx = x - doors[d].x, dz = z - doors[d].z;
        if (dx*dx + dz*dz < 30*30){ skip = true; break; }
      }
      if (skip) continue;
      /* Skip the player's home base. */
      if (homeBase){
        var hx = x - homeBase.x, hz = z - homeBase.z;
        if (hx*hx + hz*hz < 40*40) continue;
      }
      houses.push({ x: x, z: z, w: h[2] || 10, d: h[3] || 10 });
    }
  } catch(e){}
  return houses;
}

/* assignHomesGeographic — divide residential map into 4x4 sectors, assign
   workers round-robin across sectors for geographic distribution.
   Returns array of {x, z} homes, one per worker, persisted to localStorage. */
function assignHomesGeographic(count){
  /* Try loading persisted assignments first (stable across sessions). */
  try {
    var saved = null;
    try { saved = window.localStorage.getItem(LS_HOMES); } catch(e){}
    if (saved){
      var arr = JSON.parse(saved);
      if (arr && arr.length >= count){
        /* Validate: all have x/z. */
        var ok = true;
        for (var v = 0; v < count; v++){
          if (!arr[v] || typeof arr[v].x !== 'number'){ ok = false; break; }
        }
        if (ok) return arr.slice(0, count);
      }
    }
  } catch(e){}

  var houses = getResidentialHouses();
  if (!houses.length){
    /* Fallback: synthetic positions spread across the map. */
    var fb = [];
    for (var f = 0; f < count; f++){
      fb.push({ x: 2000 + (f % 8) * 800, z: 4500 + Math.floor(f / 8) * 700 });
    }
    return fb;
  }

  /* Compute bounding box of residential houses. */
  var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (var i = 0; i < houses.length; i++){
    var h = houses[i];
    if (h.x < minX) minX = h.x;
    if (h.x > maxX) maxX = h.x;
    if (h.z < minZ) minZ = h.z;
    if (h.z > maxZ) maxZ = h.z;
  }
  /* 4x4 grid = 16 sectors. */
  var GRID = 4;
  var cellW = (maxX - minX) / GRID || 1;
  var cellD = (maxZ - minZ) / GRID || 1;
  var sectors = [];
  for (var s = 0; s < GRID * GRID; s++) sectors.push([]);
  for (var j = 0; j < houses.length; j++){
    var hh = houses[j];
    var cx = Math.min(GRID - 1, Math.max(0, Math.floor((hh.x - minX) / cellW)));
    var cz = Math.min(GRID - 1, Math.max(0, Math.floor((hh.z - minZ) / cellD)));
    sectors[cz * GRID + cx].push(hh);
  }
  /* Sort sectors by house count (descending) so we fill from dense areas. */
  var sectorOrder = [];
  for (var k = 0; k < sectors.length; k++){
    if (sectors[k].length > 0) sectorOrder.push(k);
  }
  /* Shuffle sector order deterministically for spread. */
  for (var m = sectorOrder.length - 1; m > 0; m--){
    var rn = Math.floor(srand() * (m + 1));
    var tmp = sectorOrder[m]; sectorOrder[m] = sectorOrder[rn]; sectorOrder[rn] = tmp;
  }

  /* Assign round-robin across sectors. */
  var assigned = [];
  var usedKeys = {};
  var sectorIdx = 0;
  var attempts = 0;
  while (assigned.length < count && attempts < count * 50){
    attempts++;
    var secId = sectorOrder[sectorIdx % sectorOrder.length];
    sectorIdx++;
    var sec = sectors[secId];
    if (!sec.length) continue;
    /* Pick a house in this sector (deterministic stride). */
    var pickIdx = Math.floor(srand() * sec.length);
    var pick = sec[pickIdx];
    var key = Math.floor(pick.x) + ',' + Math.floor(pick.z);
    if (usedKeys[key]) continue;
    /* Enforce minimum spacing from already-assigned (50u) for spread. */
    var tooClose = false;
    for (var a = 0; a < assigned.length; a++){
      var ax = assigned[a].x - pick.x, az = assigned[a].z - pick.z;
      if (ax*ax + az*az < 50*50){ tooClose = true; break; }
    }
    if (tooClose) continue;
    usedKeys[key] = true;
    assigned.push({ x: pick.x, z: pick.z });
  }
  /* If we couldn't fill all (sparse map), allow closer spacing. */
  while (assigned.length < count){
    var hpick = houses[Math.floor(srand() * houses.length)];
    var hkey = Math.floor(hpick.x) + ',' + Math.floor(hpick.z);
    if (usedKeys[hkey]){ attempts++; if (attempts > count * 200) break; continue; }
    usedKeys[hkey] = true;
    assigned.push({ x: hpick.x, z: hpick.z });
  }

  /* Persist. */
  try {
    try { window.localStorage.setItem(LS_HOMES, JSON.stringify(assigned)); } catch(e){}
  } catch(e){}
  return assigned;
}

/* ================= worker roster ================= */
/* buildWorkers — create worker records from the cityworkforce roster.
   Each gets a home, a shift, and schedule state. */
function buildWorkers(){
  var workers = [];
  var roster = [];
  try {
    if (window.CityWorkforce && typeof window.CityWorkforce.roster === 'function'){
      roster = window.CityWorkforce.roster() || [];
    }
  } catch(e){ roster = []; }

  if (!roster.length){
    /* cityworkforce not loaded yet — return empty, boot will retry. */
    return workers;
  }

  var homes = assignHomesGeographic(roster.length);
  var hq = getHQ();

  for (var i = 0; i < roster.length; i++){
    var r = roster[i];
    var dept = r.dept || 'road';
    /* Shift assignment: 24/7 depts rotate, others are day shift. */
    var shift = 0;
    if (SHIFT_DEPTS[dept]){
      /* Count workers in this dept so far to distribute shifts. */
      var deptCount = 0;
      for (var c = 0; c < i; c++){
        if (workers[c] && workers[c].dept === dept) deptCount++;
      }
      shift = deptCount % 3;  // 0=day, 1=evening, 2=night
    }
    var home = homes[i % homes.length] || { x: 3000, z: 6000 };

    workers.push({
      id: i,
      name: r.name || ('Worker ' + (i + 1)),
      dept: dept,
      role: r.role || 'Crew',
      shift: shift,
      shiftOffset: shift * 480,  // 0, 480 (8h), or 960 (16h)
      home: { x: home.x, z: home.z },
      /* Current position (starts at home). */
      x: home.x + (srand() - 0.5) * 8,
      z: home.z + (srand() - 0.5) * 8,
      y: 0,
      heading: srand() * Math.PI * 2,
      state: ST.HOME,
      stateT: 0,
      /* Commute timer. */
      commuteT: 0,
      commuteDestX: 0,
      commuteDestZ: 0,
      /* Door approach (walking into house). */
      doorT: 0,
      /* Figure pool slot (-1 = no figure assigned). */
      figIdx: -1,
      /* Wandering. */
      tx: 0, tz: 0,
      moving: false
    });
  }
  return workers;
}

/* getHQ — headquarters location (from cityworkforce or hq_staff). */
function getHQ(){
  try {
    if (window.CityWorkforce && typeof window.CityWorkforce.hq === 'function'){
      var h = window.CityWorkforce.hq();
      if (h && typeof h.x === 'number') return { x: h.x, z: h.z };
    }
  } catch(e){}
  try {
    if (window.HQ_STAFF && typeof window.HQ_STAFF.getHQ === 'function'){
      var h2 = window.HQ_STAFF.getHQ();
      if (h2 && typeof h2.x === 'number') return { x: h2.x, z: h2.z };
    }
  } catch(e){}
  return { x: 7750.5, z: 2574.9 };  // fallback: downtown tower
}

/* ================= schedule ================= */
/* schedTime — apply shift offset to a base schedule time. */
function schedTime(base, shiftOffset){
  return (base + shiftOffset) % 1440;
}

/* workerThink — daily schedule state machine for one worker.
   nowMin: current game-minutes (0-1439) from the daycycle clock. */
function workerThink(w, nowMin){
  /* If deployed on a job, stay deployed (crew figure represents them). */
  if (w._deployed){
    if (w.state !== ST.DEPLOYED){
      setState(w, ST.DEPLOYED);
      releaseFigure(w);
    }
    return;
  } else if (w.state === ST.DEPLOYED){
    /* Job ended — return to routine. Go to current schedule state. */
    setState(w, ST.AT_WORK);  // will be corrected below
  }

  var off = w.shiftOffset;
  var tWake   = schedTime(T_WAKE, off);
  var tTowork = schedTime(T_TOWORK, off);
  var tAtwork = schedTime(T_ATWORK, off);
  var tTohome = schedTime(T_TOHOME, off);
  var tAthome = schedTime(T_ATHOME, off);
  var tSleep  = schedTime(T_SLEEP, off);

  /* Helper: is nowMin in [a, b) handling midnight wrap. */
  function inWin(a, b){
    if (a < b) return nowMin >= a && nowMin < b;
    return nowMin >= a || nowMin < b;  // wraps midnight
  }

  switch (w.state){
    case ST.SLEEP:
      /* Wake up at T_WAKE. */
      if (inWin(tWake, tTowork)){
        /* Appear at the door (just woke up, coming outside). */
        w.x = w.home.x + (srand() - 0.5) * 4;
        w.z = w.home.z + (srand() - 0.5) * 4;
        setState(w, ST.HOME);
      }
      break;

    case ST.HOME:
      if (inWin(tSleep, tWake)){
        /* Time for bed — walk to door, then sleep. */
        startDoorApproach(w, ST.SLEEP);
      } else if (inWin(tTowork, tTohome)){
        /* Time to go to work — walk to door, then commute. */
        startDoorApproach(w, ST.TO_WORK);
      }
      /* Otherwise: stay home, wander near house. */
      break;

    case ST.TO_WORK:
      /* Commute timer ticks in update loop. */
      break;

    case ST.AT_WORK:
      if (inWin(tTohome, tAthome)){
        startCommute(w, ST.TO_HOME);
      } else if (inWin(tSleep, tWake)){
        /* Somehow still at work at bedtime — go home to sleep. */
        goHomeToSleep(w);
      }
      break;

    case ST.TO_HOME:
      /* Commute timer ticks in update loop. */
      break;

    case ST.DEPLOYED:
      /* Handled at top. */
      break;
  }
}

/* startDoorApproach — worker walks to their house door, then transitions.
   This sells "they go in the house." */
function startDoorApproach(w, nextState){
  w.doorT = 3;  // 3 seconds to walk to door
  w.doorNext = nextState;
  /* Target: the house center (door). */
  w.tx = w.home.x;
  w.tz = w.home.z;
}

/* tickDoorApproach — move toward door, transition when arrived or timeout. */
function tickDoorApproach(w, dt){
  if (w.doorT <= 0) return false;
  w.doorT -= dt;
  var dx = w.tx - w.x, dz = w.tz - w.z;
  var d = Math.sqrt(dx*dx + dz*dz);
  if (d > 1.5 && w.doorT > 0){
    /* Walk toward door. */
    var spd = 2.0;  // u/s walking
    w.heading = Math.atan2(dx, dz);
    w.x += (dx / d) * spd * dt;
    w.z += (dz / d) * spd * dt;
    w.moving = true;
    try { w.y = groundY(w.x, w.z); } catch(e){}
    return true;  // still approaching
  }
  /* Arrived at door (or timeout) — transition. */
  w.doorT = 0;
  w.moving = false;
  var next = w.doorNext;
  if (next === ST.SLEEP){
    goSleep(w);
  } else if (next === ST.TO_WORK){
    startCommute(w, ST.TO_WORK);
  }
  return false;
}

/* startCommute — begin a timed commute (hidden, in vehicle). */
function startCommute(w, toState){
  var destX, destZ;
  if (toState === ST.TO_WORK){
    destX = WH.hq.x + (srand() - 0.5) * 30;
    destZ = WH.hq.z + (srand() - 0.5) * 30;
  } else {
    destX = w.home.x;
    destZ = w.home.z;
  }
  var dx = destX - w.x, dz = destZ - w.z;
  var dist = Math.sqrt(dx*dx + dz*dz);
  /* Commute duration in real seconds. Driving ~25 u/s. */
  var durSec = Math.max(8, dist / 25);
  /* Convert to game-minutes: divide by GAME_MIN_PER_SEC. */
  var gmpersec = 1440 / (124 * 60);  // daycycle rate
  w.commuteT = durSec * gmpersec;     // in game-minutes
  w.commuteDestX = destX;
  w.commuteDestZ = destZ;
  setState(w, toState);
  releaseFigure(w);  // hidden while commuting
}

/* tickCommute — advance commute timer (in game-minutes). */
function tickCommute(w, dtGameMin){
  w.commuteT -= dtGameMin;
  if (w.commuteT <= 0){
    w.x = w.commuteDestX + (srand() - 0.5) * 6;
    w.z = w.commuteDestZ + (srand() - 0.5) * 6;
    try { w.y = groundY(w.x, w.z); } catch(e){ w.y = 0; }
    if (w.state === ST.TO_WORK){
      setState(w, ST.AT_WORK);
    } else if (w.state === ST.TO_HOME){
      setState(w, ST.HOME);
    }
    return true;
  }
  return false;
}

function setState(w, st){
  w.state = st;
  w.stateT = 0;
  w.doorT = 0;
}

function goSleep(w){
  setState(w, ST.SLEEP);
  releaseFigure(w);
  /* Position at home (inside). */
  w.x = w.home.x;
  w.z = w.home.z;
}

function goHomeToSleep(w){
  /* Emergency: teleport home and sleep. */
  w.x = w.home.x;
  w.z = w.home.z;
  goSleep(w);
}

/* ================= deployment sync ================= */
/* syncDeployments — check cityworkforce roster for deployed workers.
   A deployed worker's housing figure is hidden (crew figure represents them). */
function syncDeployments(){
  if (!WH || !WH.workers.length) return;
  try {
    if (!window.CityWorkforce || typeof window.CityWorkforce.roster !== 'function') return;
    var roster = window.CityWorkforce.roster();
    if (!roster || !roster.length) return;
    for (var i = 0; i < WH.workers.length && i < roster.length; i++){
      var w = WH.workers[i];
      var r = roster[i];
      var isDeployed = (r.status === 'deployed');
      if (isDeployed && !w._deployed){
        w._deployed = true;
      } else if (!isDeployed && w._deployed){
        w._deployed = false;
        /* Job ended — worker returns to AT_WORK state (at HQ). */
        if (w.state === ST.DEPLOYED){
          w.x = WH.hq.x + (srand() - 0.5) * 20;
          w.z = WH.hq.z + (srand() - 0.5) * 20;
          setState(w, ST.AT_WORK);
        }
      }
    }
  } catch(e){}
}

/* ================= figure pool ================= */
/* Simple civilian figure builder — 7 boxes, shared geometries/materials. */
var _figGeo = null;
var _figMats = {};
function getFigGeo(){
  if (_figGeo) return _figGeo;
  _figGeo = {
    body: new THREE.BoxGeometry(0.42, 0.55, 0.28),
    head: new THREE.BoxGeometry(0.30, 0.30, 0.30),
    arm:  new THREE.BoxGeometry(0.10, 0.58, 0.10),
    leg:  new THREE.BoxGeometry(0.13, 0.62, 0.13),
    hair: new THREE.BoxGeometry(0.32, 0.08, 0.32),
    shoe: new THREE.BoxGeometry(0.14, 0.10, 0.24)
  };
  return _figGeo;
}
function getFigMat(color){
  var key = 'c' + color.toString(16);
  if (!_figMats[key]){
    _figMats[key] = new THREE.MeshLambertMaterial({ color: color });
  }
  return _figMats[key];
}

/* Civilian color palettes (normal clothes, no uniforms). */
var WH_SHIRTS = [0x4a6fa5,0xffffff,0x8a9a5b,0x6b4a6b,0x3a3a3a,0xc4a77d,
                 0x5b8a8a,0x9a5b5b,0x4a4a6a,0x7a7a7a,0x2e5f4a,0x8b6f47,
                 0xa85b32,0x3d6b35,0x7a4a5a,0x4a5a7a];
var WH_PANTS = [0x2a2a3a,0x1f2a3a,0x3a3a3a,0x4a3a2a,0x2a3a4a];
var WH_SKINS = [0x8d5a3b,0xa06a42,0xc68863,0xe0ac82,0xf0c8a0,0x6b4226];
var WH_HAIR = [0x1a1a1a,0x2a2a2a,0x4a3520,0x6b4a2a,0x8a8a8a,0xd0d0d0];

function buildWorkerFigure(){
  var geo = getFigGeo();
  var g = new THREE.Group();
  var shirtC = WH_SHIRTS[Math.floor(srand() * WH_SHIRTS.length)];
  var pantsC = WH_PANTS[Math.floor(srand() * WH_PANTS.length)];
  var skinC  = WH_SKINS[Math.floor(srand() * WH_SKINS.length)];
  var hairC  = WH_HAIR[Math.floor(srand() * WH_HAIR.length)];

  function addMesh(gm, mat, x, y, z){
    var m = new THREE.Mesh(gm, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  }
  /* Legs. */
  addMesh(geo.leg, getFigMat(pantsC), -0.11, 0.51, 0);
  addMesh(geo.leg, getFigMat(pantsC),  0.11, 0.51, 0);
  /* Body. */
  addMesh(geo.body, getFigMat(shirtC), 0, 1.10, 0);
  /* Arms. */
  var armL = addMesh(geo.arm, getFigMat(shirtC), -0.26, 1.05, 0);
  var armR = addMesh(geo.arm, getFigMat(shirtC),  0.26, 1.05, 0);
  /* Head. */
  addMesh(geo.head, getFigMat(skinC), 0, 1.56, 0);
  /* Hair. */
  addMesh(geo.hair, getFigMat(hairC), 0, 1.70, 0);

  g.visible = false;
  g.userData = { armL: armL, armR: armR, phase: srand() * 6.28 };
  return g;
}

/* Figure pool management. */
var _figPool = [];  // {mesh, workerId (-1 = free)}

function initFigurePool(){
  _figPool = [];
  try {
    for (var i = 0; i < POOL_SIZE; i++){
      var mesh = buildWorkerFigure();
      scene.add(mesh);
      _figPool.push({ mesh: mesh, workerId: -1 });
    }
  } catch(e){}
}

function releaseFigure(w){
  if (w.figIdx >= 0 && w.figIdx < _figPool.length){
    _figPool[w.figIdx].workerId = -1;
    _figPool[w.figIdx].mesh.visible = false;
    w.figIdx = -1;
  }
}

function assignFigure(w){
  if (w.figIdx >= 0) return true;  // already has one
  for (var i = 0; i < _figPool.length; i++){
    if (_figPool[i].workerId < 0){
      _figPool[i].workerId = w.id;
      w.figIdx = i;
      _figPool[i].mesh.visible = true;
      return true;
    }
  }
  return false;  // pool exhausted
}

/* updateFigures — assign pool figures to HOME-state workers nearest camera. */
var _camPos = { x: 0, z: 0 };
function updateFigures(){
  if (!WH || !WH.workers.length) return;
  try {
    /* Get camera position. */
    if (typeof camera !== 'undefined' && camera.position){
      _camPos.x = camera.position.x;
      _camPos.z = camera.position.z;
    } else if (typeof player !== 'undefined'){
      _camPos.x = player.x || 0;
      _camPos.z = player.z || 0;
    }
  } catch(e){}

  /* Find HOME-state workers (not deployed, not commuting). */
  var candidates = [];
  for (var i = 0; i < WH.workers.length; i++){
    var w = WH.workers[i];
    if (w._deployed) continue;
    if (w.state !== ST.HOME) continue;
    /* Door approach in progress — needs a figure. */
    var dx = w.x - _camPos.x, dz = w.z - _camPos.z;
    var d2 = dx*dx + dz*dz;
    if (d2 > FIGURE_RANGE * FIGURE_RANGE && w.doorT <= 0) continue;
    candidates.push({ w: w, d2: d2 });
  }
  /* Sort by distance (nearest first). */
  candidates.sort(function(a, b){ return a.d2 - b.d2; });

  /* Workers who should have figures: top N by distance. */
  var wantSet = {};
  for (var c = 0; c < Math.min(candidates.length, POOL_SIZE); c++){
    wantSet[candidates[c].w.id] = true;
  }

  /* Release figures from workers who don't need them. */
  for (var r = 0; r < WH.workers.length; r++){
    var wr = WH.workers[r];
    if (wr.figIdx >= 0 && !wantSet[wr.id]){
      releaseFigure(wr);
    }
  }
  /* Assign figures to workers who need them. */
  for (var a = 0; a < candidates.length && a < POOL_SIZE; a++){
    var wa = candidates[a].w;
    if (wa.figIdx < 0){
      assignFigure(wa);
    }
  }

  /* Update figure positions and walk animation. */
  for (var f = 0; f < _figPool.length; f++){
    var slot = _figPool[f];
    if (slot.workerId < 0) continue;
    var wkr = WH.workers[slot.workerId];
    if (!wkr){ slot.workerId = -1; slot.mesh.visible = false; continue; }
    var mesh = slot.mesh;
    try {
      var gy = wkr.y || 0;
      try { gy = groundY(wkr.x, wkr.z); } catch(e){}
      mesh.position.set(wkr.x, gy, wkr.z);
      mesh.rotation.y = wkr.heading;
      /* Simple walk bob. */
      var u = mesh.userData;
      if (wkr.moving){
        u.phase += 0.016 * 7;
        var sw = Math.sin(u.phase) * 0.4;
        u.armL.rotation.x = sw;
        u.armR.rotation.x = -sw;
        mesh.position.y = gy + Math.abs(Math.sin(u.phase)) * 0.05;
      } else {
        u.armL.rotation.x *= 0.9;
        u.armR.rotation.x *= 0.9;
      }
    } catch(e){}
  }
}

/* ================= home presence lights ================= */
/* Warm window-light sprites at homes where workers are currently home.
   Cheap (1 sprite each), only within LIGHT_RANGE of camera. */
var _lightPool = [];
var LIGHT_POOL_SIZE = 32;
function initLightPool(){
  _lightPool = [];
  try {
    var canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    var ctx = canvas.getContext('2d');
    var grad = ctx.createRadialGradient(16, 16, 2, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255, 220, 150, 1)');
    grad.addColorStop(0.5, 'rgba(255, 200, 120, 0.5)');
    grad.addColorStop(1, 'rgba(255, 200, 120, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    var tex = new THREE.CanvasTexture(canvas);
    for (var i = 0; i < LIGHT_POOL_SIZE; i++){
      var mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      var spr = new THREE.Sprite(mat);
      spr.scale.set(6, 6, 1);
      spr.visible = false;
      scene.add(spr);
      _lightPool.push({ spr: spr, workerId: -1 });
    }
  } catch(e){}
}

function updateLights(){
  if (!WH || !WH.workers.length || !_lightPool.length) return;
  /* Find HOME/SLEEP workers within range. */
  var candidates = [];
  for (var i = 0; i < WH.workers.length; i++){
    var w = WH.workers[i];
    if (w._deployed) continue;
    if (w.state !== ST.HOME && w.state !== ST.SLEEP) continue;
    var dx = w.home.x - _camPos.x, dz = w.home.z - _camPos.z;
    var d2 = dx*dx + dz*dz;
    if (d2 > LIGHT_RANGE * LIGHT_RANGE) continue;
    candidates.push({ w: w, d2: d2 });
  }
  candidates.sort(function(a, b){ return a.d2 - b.d2; });

  /* Reset all. */
  for (var r = 0; r < _lightPool.length; r++){
    _lightPool[r].spr.visible = false;
    _lightPool[r].workerId = -1;
  }
  /* Assign to nearest. */
  for (var c = 0; c < Math.min(candidates.length, LIGHT_POOL_SIZE); c++){
    var wc = candidates[c].w;
    var slot = _lightPool[c];
    slot.workerId = wc.id;
    try {
      var gy = 3;  // window height
      try { gy = groundY(wc.home.x, wc.home.z) + 3; } catch(e){}
      slot.spr.position.set(wc.home.x, gy, wc.home.z);
      /* Brighter in evening/night. */
      var nowMin = 720;
      try { nowMin = window.__daycycle.gameMin; } catch(e){}
      var isNight = (nowMin < 360 || nowMin >= 1080);
      slot.spr.material.opacity = isNight ? 0.9 : 0.4;
      slot.spr.visible = true;
    } catch(e){}
  }
}

/* ================= wandering ================= */
/* wanderNearHome — casual wandering near the worker's house. */
function wanderNearHome(w, dt){
  w.stateT -= dt;
  if (w.stateT <= 0){
    var a = srand() * Math.PI * 2;
    var r = 4 + srand() * 12;  // 4-16u from home
    w.tx = w.home.x + Math.cos(a) * r;
    w.tz = w.home.z + Math.sin(a) * r;
    w.stateT = 4 + srand() * 6;
  }
  var dx = w.tx - w.x, dz = w.tz - w.z;
  var d = Math.sqrt(dx*dx + dz*dz);
  w.moving = false;
  if (d > 1.0){
    var spd = 1.2;  // casual walk
    /* Simple obstacle check: don't walk into water. */
    var nx = w.x + (dx/d) * spd * dt;
    var nz = w.z + (dz/d) * spd * dt;
    var blocked = false;
    try {
      if (typeof inWater === 'function' && inWater(nx, nz)) blocked = true;
    } catch(e){}
    if (!blocked){
      w.heading = Math.atan2(dx, dz);
      w.x = nx; w.z = nz;
      try { w.y = groundY(w.x, w.z); } catch(e){}
      w.moving = true;
    }
  }
}

/* ================= ground helper ================= */
function groundY(x, z){
  try {
    if (typeof heightAt === 'function') return heightAt(x, z);
  } catch(e){}
  return 0;
}

/* ================= main update ================= */
var _lastSync = 0;
var _lastLight = 0;
function updateWorkerHousing(dtReal){
  if (!WH || !WH.ready || !WH.workers.length) return;
  try {
    dtReal = Math.min(0.1, dtReal || 0.016);

    /* Get game time from daycycle (authoritative clock). */
    var nowMin = 720, dayNum = 1;
    try {
      if (window.__daycycle){
        nowMin = window.__daycycle.gameMin;
        dayNum = window.__daycycle.dayNum;
      }
    } catch(e){}
    /* Game-minutes elapsed this frame. */
    var gmpersec = 1440 / (124 * 60);
    var dtGameMin = dtReal * gmpersec;

    /* Sync deployments every 3 seconds. */
    _lastSync += dtReal;
    if (_lastSync > 3){
      _lastSync = 0;
      syncDeployments();
    }

    /* Update each worker. */
    for (var i = 0; i < WH.workers.length; i++){
      var w = WH.workers[i];

      /* Think: schedule state machine. */
      workerThink(w, nowMin);

      /* Act based on state. */
      if (w.doorT > 0){
        /* Walking to door (entering house). */
        tickDoorApproach(w, dtReal);
      } else if (w.state === ST.TO_WORK || w.state === ST.TO_HOME){
        tickCommute(w, dtGameMin);
      } else if (w.state === ST.HOME){
        wanderNearHome(w, dtReal);
      }
      /* SLEEP/AT_WORK/DEPLOYED: no movement. */
    }

    /* Update figure pool (every frame — cheap). */
    updateFigures();

    /* Update home lights (every 2 seconds). */
    _lastLight += dtReal;
    if (_lastLight > 2){
      _lastLight = 0;
      updateLights();
    }
  } catch(e){}
}

/* ================= init ================= */
function initWorkerHousing(){
  WH = {
    workers: [],
    hq: getHQ(),
    ready: false
  };

  var workers = buildWorkers();
  if (!workers.length){
    /* cityworkforce not ready — will retry via boot poller. */
    return false;
  }

  WH.workers = workers;
  WH.hq = getHQ();

  /* Initialize figure and light pools. */
  try { initFigurePool(); } catch(e){}
  try { initLightPool(); } catch(e){}

  WH.ready = true;

  try {
    if (typeof Report !== 'undefined' && Report.note){
      /* Count homes per sector for the report. */
      Report.note('workerhousing',
        'Worker housing online: ' + workers.length + ' workers housed across ' +
        'the city. Day/evening/night shifts for 24/7 depts.');
    }
  } catch(e){}
  return true;
}

/* ================= HUD panel ================= */
var _panel = null;
var _panelVisible = false;
function togglePanel(force){
  _panelVisible = (typeof force === 'boolean') ? force : !_panelVisible;
  try {
    if (!_panel){
      _panel = document.createElement('div');
      _panel.style.cssText =
        'position:fixed;right:12px;top:120px;width:280px;max-height:60vh;' +
        'overflow-y:auto;background:rgba(10,14,20,0.92);color:#dfe8f0;' +
        'border:1px solid #3a4a5a;border-radius:10px;padding:12px;' +
        'font:12px/1.5 system-ui,sans-serif;z-index:9998;display:none;';
      document.body.appendChild(_panel);
    }
    _panel.style.display = _panelVisible ? 'block' : 'none';
    if (_panelVisible) refreshPanel();
  } catch(e){}
}
function refreshPanel(){
  if (!_panel || !_panelVisible) return;
  try {
    var s = stats();
    var html = '<div style="font-weight:bold;font-size:14px;margin-bottom:8px;">' +
      '🏠 Worker Housing</div>';
    html += '<div style="color:#9ab;">' + s.total + ' workers housed citywide</div>';
    html += '<div style="margin:8px 0;">';
    html += '<div>🏠 Home: <b>' + s.home + '</b></div>';
    html += '<div>🏢 At work: <b>' + s.atWork + '</b></div>';
    html += '<div>🚗 Commuting: <b>' + s.commuting + '</b></div>';
    html += '<div>😴 Sleeping: <b>' + s.sleeping + '</b></div>';
    html += '<div>🦺 Deployed: <b>' + s.deployed + '</b></div>';
    html += '</div>';
    /* Department breakdown. */
    html += '<div style="font-weight:bold;margin:8px 0 4px;">By department:</div>';
    var depts = s.byDept;
    for (var d in depts){
      if (depts.hasOwnProperty(d)){
        html += '<div style="color:#9ab;">' + d + ': ' + depts[d] + '</div>';
      }
    }
    /* Clock. */
    var clock = '?';
    try {
      if (window.__daycycle){
        var gm = window.__daycycle.gameMin;
        var hh = Math.floor(gm / 60), mm = Math.floor(gm % 60);
        clock = 'Day ' + window.__daycycle.dayNum + ' ' +
          (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
      }
    } catch(e){}
    html += '<div style="margin-top:8px;color:#7a8;">' + clock + '</div>';
    _panel.innerHTML = html;
  } catch(e){}
}

function stats(){
  var s = { total: 0, home: 0, atWork: 0, commuting: 0, sleeping: 0,
            deployed: 0, byDept: {} };
  if (!WH || !WH.workers.length) return s;
  s.total = WH.workers.length;
  for (var i = 0; i < WH.workers.length; i++){
    var w = WH.workers[i];
    if (!s.byDept[w.dept]) s.byDept[w.dept] = 0;
    s.byDept[w.dept]++;
    if (w._deployed || w.state === ST.DEPLOYED) s.deployed++;
    else if (w.state === ST.HOME) s.home++;
    else if (w.state === ST.AT_WORK) s.atWork++;
    else if (w.state === ST.TO_WORK || w.state === ST.TO_HOME) s.commuting++;
    else if (w.state === ST.SLEEP) s.sleeping++;
  }
  return s;
}

/* HUD button. */
function addHudButton(){
  try {
    var btn = document.createElement('button');
    btn.innerHTML = '🏠';
    btn.title = 'Worker Housing';
    btn.style.cssText =
      'position:fixed;right:12px;top:80px;width:44px;height:44px;' +
      'border-radius:50%;border:2px solid #3a4a5a;background:rgba(10,14,20,0.85);' +
      'color:#fff;font-size:20px;z-index:9997;cursor:pointer;';
    btn.onclick = function(){ togglePanel(); };
    document.body.appendChild(btn);
    /* Refresh panel every 5s while visible. */
    setInterval(function(){ if (_panelVisible) refreshPanel(); }, 5000);
  } catch(e){}
}

/* ================= public API ================= */
window.WorkerHousing = {
  workers: function(){
    if (!WH || !WH.workers.length) return [];
    return WH.workers.map(function(w){
      return {
        name: w.name, dept: w.dept, role: w.role, shift: w.shift,
        state: ST_NAMES[w.state] || '?',
        homeX: Math.round(w.home.x), homeZ: Math.round(w.home.z),
        x: Math.round(w.x), z: Math.round(w.z)
      };
    });
  },
  homes: function(){
    if (!WH || !WH.workers.length) return [];
    return WH.workers.map(function(w){
      return { x: Math.round(w.home.x), z: Math.round(w.home.z),
               name: w.name, dept: w.dept };
    });
  },
  stats: stats,
  toggle: togglePanel
};
window.updateWorkerHousing = function(dt){ updateWorkerHousing(dt || 0.016); };

/* ================= boot ================= */
function wrapAnimate(){
  try {
    if (typeof animate === 'function' && !animate.__workerhousingWrap){
      var orig = animate;
      var wrapped = function(){ orig(); updateWorkerHousing(0.016); };
      wrapped.__workerhousingWrap = true;
      animate = wrapped;
    }
  } catch(e){}
}

var bootTries = 0;
var bootTimer = setInterval(function(){
  bootTries++;
  var ready = false;
  try {
    ready = (typeof THREE !== 'undefined' &&
             typeof scene !== 'undefined' &&
             typeof PLACED_HOUSES !== 'undefined' && PLACED_HOUSES.length > 0 &&
             typeof animate === 'function' &&
             typeof heightAt === 'function' &&
             window.CityWorkforce &&
             typeof window.CityWorkforce.roster === 'function' &&
             window.CityWorkforce.roster().length >= 58);
  } catch(e){ ready = false; }
  if (ready){
    var ok = false;
    try { ok = initWorkerHousing(); } catch(e){
      try {
        if (typeof Report !== 'undefined') Report.noteError('workerhousing', 'init failed', String(e && e.message || e));
      } catch(x){}
    }
    if (ok){
      try { wrapAnimate(); } catch(e){}
      try { addHudButton(); } catch(e){}
      clearInterval(bootTimer);
    } else if (bootTries > 300){
      /* cityworkforce roster never reached 58 — give up. */
      clearInterval(bootTimer);
      try {
        if (typeof Report !== 'undefined') Report.noteError('workerhousing', 'boot-timeout', 'cityworkforce roster not ready');
      } catch(e){}
    }
    /* If init returned false but tries remain, keep polling. */
    if (!ok && bootTries > 300){
      clearInterval(bootTimer);
    }
  } else if (bootTries > 300){
    clearInterval(bootTimer);
    try {
      if (typeof Report !== 'undefined') Report.noteError('workerhousing', 'boot-timeout', 'deps never ready');
    } catch(e){}
  }
}, 500);

})();
