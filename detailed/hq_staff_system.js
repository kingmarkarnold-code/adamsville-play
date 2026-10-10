/* ============================================================================
   FILE: hq_staff_system.js — "Surviving Adamsville" HQ STAFF (civilian workers)
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-09) + CLARIFICATION:
     All AI agents that can be converted to smart NPCs are to be converted.
     They work from a large downtown HQ building housing multiple departments.

   JOSHUA'S CLARIFICATION (the whole point of this module):
     "This new deployed team are to look like REAL PEOPLE from the game
      instead of like the crew, so that they are going back and forth to
      work daily."

     - These NPCs look like REGULAR CITIZENS (normal clothes, varied
       appearances).
     - They are NOT in hi-vis vests, hard hats, or crew uniforms.
     - They commute to the downtown HQ building DAILY:
         Morning: leave home, travel to HQ
         Work day: at HQ (or deployed to assignments)
         Evening: return home
     - They have homes in the residential areas.
     - Daily routine: home → work → home.

     They are office/professional municipal staff — engineers, dispatchers,
     inspectors, administrators — NOT construction workers. They blend in
     as regular citizens with jobs.

   WHAT THIS MODULE DOES:
     1. Spawns 12 civilian staff NPCs (2 per department × 6 departments).
     2. Each gets a distinct civilian appearance: normal office/casual
        clothes, varied skin tones, varied hair — NO uniforms, NO vests,
        NO hard hats. They look like the regular NPC citizens.
     3. Each gets a HOME in a residential area (from PLACED_HOUSES).
     4. Daily COMMUTE driven by the game clock (1 real sec = 1 game min):
          22:00–06:00  SLEEP   (hidden at home)
          06:00–07:30  HOME    (morning routine, visible near home)
          07:30–08:30  TO_WORK (walking to HQ)
          08:30–17:00  AT_WORK (at the HQ building)
          17:00–18:00  TO_HOME (walking home)
          18:00–22:00  HOME    (evening, visible near home)
        Weekends: staff stay home (no commute) — they hang out near home.
     5. The HQ building: auto-detected as a large downtown office building
        from OSM_BUILDINGS, or set explicitly via window.HQ_STAFF.setHQ().

   DEPARTMENTS (6, 2 staff each = 12 total):
     - Road Department        — road engineers
     - Signals Department     — traffic signal engineers
     - Infrastructure Dept    — infrastructure planners
     - Dispatch               — dispatchers / communications
     - Survey & Inspection    — field survey coordinators
     - Administration         — admin / office staff

   STANDALONE MODULE. Include AFTER the main game script — zero edits to
   index.html game logic required (one <script> tag):

       <script src="hq_staff_system.js"></script>

   Reads (all optional/guarded): THREE, scene, animate, roadDrawData,
   PLACED_HOUSES, OSM_BUILDINGS, heightAt, inWater, bldgGrid, vehLam,
   buildFace3D/addLegoFacePlane (face_platform.js), IS_APK, Report.
   Writes: 12 character Groups in scene; window.HQ_STAFF (public API);
   window.updateHQStaff (called from wrapped animate).
   ============================================================================ */
(function(){
'use strict';
/* Single-instance guard — never double-boot if the script tag loads twice. */
if (window.__hqstaffV1) return;
window.__hqstaffV1 = true;

/* ---------------- config ---------------- */
var N_STAFF = 12;             // 2 per department × 6 departments
var WALK_SPEED = 1.6;         // walking speed (u/s) — casual commuter pace
/* Schedule (game clock: 1 real sec = 1 game min).
   Times in minutes from midnight. */
var T_WAKE     = 360;   // 06:00 — wake up
var T_TOWORK   = 450;   // 07:30 — leave for work
var T_ATWORK   = 510;   // 08:30 — arrive at HQ (work starts)
var T_TOHOME   = 1020;  // 17:00 — leave work
var T_ATHOME   = 1080;  // 18:00 — arrive home (evening)
var T_SLEEP    = 1320;  // 22:00 — sleep (hidden)
var DAYS = ['MON','TUE','WED','THU','FRI','SAT','SUN'];

/* Departments — 6 departments, 2 staff each. */
var DEPARTMENTS = [
  { id: 'road',    name: 'Road Dept',        titles: ['Road Engineer', 'Pavement Analyst'] },
  { id: 'signals', name: 'Signals Dept',     titles: ['Signal Engineer', 'Timing Specialist'] },
  { id: 'infra',   name: 'Infrastructure',   titles: ['Infra Planner', 'Utilities Coord'] },
  { id: 'dispatch',name: 'Dispatch',         titles: ['Dispatcher', 'Comms Operator'] },
  { id: 'survey',  name: 'Survey & Insp',    titles: ['Survey Coord', 'Field Inspector'] },
  { id: 'admin',   name: 'Administration',   titles: ['Office Manager', 'Admin Assistant'] }
];

/* Civilian staff names — regular people names, diverse. */
var STAFF_NAMES = [
  'Marcus T.', 'Denise W.', 'Andre B.', 'Keisha R.',
  'Terrell J.', 'Monica S.', 'Darius L.', 'Tanya H.',
  'Chris P.', 'Latoya M.', 'Jamal K.', 'Renee D.'
];

/* Civilian clothing palettes — OFFICE CASUAL / NORMAL CLOTHES.
   Deliberately NO hi-vis colors, NO safety orange, NO lime.
   Shirts: button-downs, blouses, polos, sweaters in normal colors.
   Pants: slacks, jeans, skirts in dark/neutral tones. */
var CIV_SHIRTS = [
  0x4a6fa5,  // blue button-down
  0xffffff,  // white blouse
  0x8a9a5b,  // olive polo
  0x6b4a6b,  // plum sweater
  0x3a3a3a,  // charcoal
  0xc4a77d,  // tan
  0x5b8a8a,  // teal
  0x9a5b5b,  // muted red
  0x4a4a6a,  // navy
  0x7a7a7a,  // gray
  0x2e5f4a,  // forest green
  0x8b6f47   // brown
];
var CIV_PANTS = [
  0x2a2a3a,  // dark slacks
  0x1f2a3a,  // dark jeans
  0x3a3a3a,  // charcoal
  0x4a3728,  // brown
  0x2e2e2e,  // black
  0x5a5a6a   // gray slacks
];
var CIV_SKINS = [
  0x4a2f1c, 0x5a3a24, 0x6b4429, 0x7d5230,
  0x8a5f36, 0x3a2415, 0x6b3a20, 0x5a2f18
];
var CIV_HAIR = [
  0x0a0805, 0x1a1a1a, 0x2a2a2a, 0x3a2a1a,
  0x4a4a4a, 0x0a0a0a
];

var HS = null; // runtime state

/* ---------------- helpers ---------------- */
/* groundY — safe terrain height lookup, never NaN. */
function groundY(x, z){
  try { var y = heightAt(x, z); return isFinite(y) ? y : 0; }
  catch(e){ return 0; }
}
/* Seeded random for deterministic staff generation. */
var _seed = 12345;
function srand(){
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}
/* vehLam — Lambert material helper, guarded. */
function lam(color){
  try {
    if (typeof vehLam === 'function') return vehLam(color);
  } catch(e){}
  return new THREE.MeshLambertMaterial({ color: color });
}

/* ---------------- HQ building ---------------- */
/* findHQBuilding — auto-detect a large downtown office building.
   Looks for the largest OSM building in the downtown area (high x, low z
   = NE = downtown Atlanta). Falls back to a default downtown coordinate. */
function findHQBuilding(){
  var best = null, bestArea = 0;
  try {
    /* Downtown bounds: x > 6000, z < 4000 (NE quadrant, near Marriott). */
    if (typeof OSM_BUILDINGS !== 'undefined' && OSM_BUILDINGS.length){
      for (var i = 0; i < OSM_BUILDINGS.length; i++){
        var b = OSM_BUILDINGS[i];
        if (!b || b.length < 5) continue;
        var x = b[0], z = b[1], w = b[2] || 10, d = b[3] || 10;
        /* Downtown filter. */
        if (x < 6000 || z > 4000) continue;
        var area = w * d;
        if (area > bestArea){
          bestArea = area;
          best = { x: x, z: z, w: w, d: d, name: 'Municipal HQ' };
        }
      }
    }
  } catch(e){}
  /* Fallback: downtown default near the Marriott (7801, 2925). */
  if (!best){
    best = { x: 7750, z: 2950, w: 60, d: 40, name: 'Municipal HQ (default)' };
  }
  return best;
}

/* ---------------- civilian character mesh ---------------- */
/* buildStaffMember — a REGULAR CITIZEN figure. Normal office/casual clothes.
   NO hi-vis vest. NO hard hat. NO uniform. Just a person going to work.

   Visual design (matches the game's stylized NPC look):
   - Head with normal hair (varied styles/colors)
   - Button-down / blouse / polo / sweater (varied normal colors)
   - Slacks / jeans (dark/neutral)
   - Shoes
   - Briefcase for some (office workers carry briefcases!) */
function buildStaffMember(opts){
  var g = new THREE.Group();
  var skin = new THREE.Color(opts.skin);
  var shirtC = new THREE.Color(opts.shirt);
  var pantsC = new THREE.Color(opts.pants);
  var hairC = new THREE.Color(opts.hair);
  var shoeC = new THREE.Color(0x222226);

  function box(w, h, d, mat, x, y, z, parent){
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    (parent || g).add(m);
    return m;
  }

  var scl = opts.scale || 1.0;

  /* Legs (pivot at hip for walk animation). */
  function leg(sx){
    var piv = new THREE.Group();
    piv.position.set(sx * 0.11, 0.82, 0);
    g.add(piv);
    box(0.13, 0.62, 0.13, lam(pantsC), 0, -0.31, 0, piv);
    box(0.14, 0.10, 0.24, lam(shoeC), 0, -0.66, 0.04, piv);
    return piv;
  }
  var legL = leg(-1), legR = leg(1);

  /* Torso — NORMAL SHIRT. Not a vest. Not a uniform. Just a shirt. */
  box(0.42, 0.55, 0.28, lam(shirtC), 0, 1.10, 0);

  /* Arms (pivot at shoulder for walk animation). */
  function arm(sx){
    var piv = new THREE.Group();
    piv.position.set(sx * 0.26, 1.30, 0);
    g.add(piv);
    /* Sleeves match shirt (long sleeves) or skin (short sleeves). */
    var sleeveMat = opts.shortSleeves ? lam(skin) : lam(shirtC);
    box(0.10, 0.58, 0.10, sleeveMat, 0, -0.29, 0, piv);
    /* Hands. */
    box(0.09, 0.09, 0.09, lam(skin), 0, -0.60, 0, piv);
    return piv;
  }
  var armL = arm(-1), armR = arm(1);

  /* Head. */
  var hs = 0.30;
  box(hs, 0.30, hs, lam(skin), 0, 1.56, 0);

  /* Face — platform split (APK: 3D, web: texture), same as other NPCs. */
  (function(){
    var isApk = (typeof IS_APK !== 'undefined') && IS_APK;
    if (isApk && typeof buildFace3D === 'function'){
      var hg = new THREE.Group();
      hg.position.set(0, 1.56, 0);
      g.add(hg);
      buildFace3D(hg, hs * 0.42, lam(skin), lam(hairC));
    } else if (typeof addLegoFacePlane === 'function'){
      var hg2 = new THREE.Group();
      hg2.position.set(0, 1.56, 0);
      g.add(hg2);
      addLegoFacePlane(hg2, hs * 0.55, hs / 2 + 0.005);
    }
  })();

  /* Hair — NORMAL hair, varied styles. NOT a hard hat. */
  if (opts.hairStyle === 'long'){
    /* Long hair. */
    box(hs + 0.03, 0.34, 0.10, lam(hairC), 0, 1.52, -hs/2 - 0.03);
    box(hs + 0.03, 0.10, hs + 0.03, lam(hairC), 0, 1.70, 0);
  } else if (opts.hairStyle === 'short'){
    /* Short hair. */
    box(hs + 0.02, 0.08, hs + 0.02, lam(hairC), 0, 1.70, 0);
  } else if (opts.hairStyle === 'bun'){
    /* Bun. */
    box(hs + 0.02, 0.08, hs + 0.02, lam(hairC), 0, 1.70, 0);
    box(0.12, 0.12, 0.12, lam(hairC), 0, 1.78, -0.05);
  } else {
    /* Default: neat short hair. */
    box(hs + 0.02, 0.07, hs + 0.02, lam(hairC), 0, 1.69, 0);
  }

  /* Briefcase — some office workers carry one. It's a normal thing
     people carry to work. */
  if (opts.briefcase){
    var bc = box(0.28, 0.20, 0.10, lam(0x4a3728), 0.38, 0.55, 0);
    /* Attach to right hand area — just position it near the hand. */
    bc.position.set(0.38, 0.45, 0.05);
  }

  /* Glasses — some people wear them. Normal accessory. */
  if (opts.glasses){
    box(hs + 0.02, 0.04, 0.02, lam(0x1a1a1a), 0, 1.58, hs/2 + 0.01);
  }

  g.scale.setScalar(scl);
  g.userData = {
    armL: armL, armR: armR, legL: legL, legR: legR,
    phase: Math.random() * 6.28
  };
  return g;
}

/* ---------------- home assignment ---------------- */
/* assignHome — pick a residential house for a staff member.
   Uses PLACED_HOUSES, preferring residential areas (not downtown).
   Each staff member gets a DIFFERENT home. */
var _usedHomes = {};
function assignHome(staffIdx){
  try {
    if (typeof PLACED_HOUSES === 'undefined' || !PLACED_HOUSES.length){
      return { x: 3000 + staffIdx * 50, z: 6000, name: 'Home ' + staffIdx };
    }
    /* Filter to residential: not downtown (x < 6000 or z > 4000),
       reasonable house size. */
    var candidates = [];
    for (var i = 0; i < PLACED_HOUSES.length; i++){
      var h = PLACED_HOUSES[i];
      if (!h || h.length < 2) continue;
      var x = h[0], z = h[1];
      /* Skip downtown. */
      if (x > 6000 && z < 4000) continue;
      /* Skip already-assigned. */
      var key = Math.floor(x) + ',' + Math.floor(z);
      if (_usedHomes[key]) continue;
      candidates.push({ x: x, z: z, idx: i });
    }
    if (!candidates.length){
      /* Fallback: any unassigned house. */
      for (var j = 0; j < PLACED_HOUSES.length; j++){
        var h2 = PLACED_HOUSES[j];
        if (!h2 || h2.length < 2) continue;
        var key2 = Math.floor(h2[0]) + ',' + Math.floor(h2[1]);
        if (_usedHomes[key2]) continue;
        candidates.push({ x: h2[0], z: h2[1], idx: j });
      }
    }
    if (!candidates.length){
      return { x: 3000 + staffIdx * 50, z: 6000, name: 'Home ' + staffIdx };
    }
    /* Pick deterministically by staff index. */
    var pick = candidates[(staffIdx * 7) % candidates.length];
    var pkey = Math.floor(pick.x) + ',' + Math.floor(pick.z);
    _usedHomes[pkey] = true;
    return { x: pick.x, z: pick.z, name: 'Home ' + (staffIdx + 1) };
  } catch(e){
    return { x: 3000 + staffIdx * 50, z: 6000, name: 'Home ' + staffIdx };
  }
}

/* ---------------- staff states ---------------- */
var ST = {
  SLEEP: 0,    // 22:00-06:00, hidden at home
  HOME: 1,     // at home, visible, wandering nearby
  TO_WORK: 2,  // COMMUTING to HQ (driving/transit — not walking the map)
  AT_WORK: 3,  // at HQ building
  TO_HOME: 4   // COMMUTING home (driving/transit — not walking the map)
};
var ST_NAMES = ['SLEEP', 'HOME', 'TO_WORK', 'AT_WORK', 'TO_HOME'];

/* Commute: staff DRIVE or take TRANSIT to work like real commuters.
   They don't walk across the entire map. Commute duration is based on
   distance at driving speed (~25 u/s), with a minimum for realism.
   During commute the staff member is "in transit" (not visible on foot). */
var DRIVE_SPEED = 25;      // commute speed (u/s) — driving/transit
var MIN_COMMUTE = 15;      // minimum commute time (game-minutes)

/* ---------------- staff think ---------------- */
/* staffThink — daily schedule state machine.
   Weekdays: commute to HQ. Weekends: stay home.
   Commuting is by car/transit (timed), not on foot across the map. */
function staffThink(s, nowMin){
  var isWeekend = (HS.day % 7) >= 5; // SAT=5, SUN=6

  if (isWeekend){
    /* Weekends: stay home all day. */
    if (s.state === ST.TO_WORK || s.state === ST.AT_WORK || s.state === ST.TO_HOME){
      /* If somehow at work on weekend, head home. */
      startCommute(s, ST.TO_HOME);
    }
    if (s.state === ST.SLEEP && nowMin >= T_WAKE && nowMin < T_SLEEP){
      setStaffState(s, ST.HOME);
      s.mesh.visible = true;
    } else if (s.state !== ST.SLEEP && (nowMin >= T_SLEEP || nowMin < T_WAKE)){
      goSleep(s);
    }
    return;
  }

  /* Weekday schedule. */
  switch(s.state){
    case ST.SLEEP:
      /* Wake at 06:00, but only if it's actually morning
         (not evening — 22:00 >= 06:00 would wake immediately). */
      if (nowMin >= T_WAKE && nowMin < T_SLEEP){
        setStaffState(s, ST.HOME);
        s.mesh.visible = true;
      }
      break;
    case ST.HOME:
      if (nowMin >= T_SLEEP || nowMin < T_WAKE){
        goSleep(s);
      } else if (nowMin >= T_TOWORK && nowMin < T_TOHOME){
        /* Morning: time to go to work.
           (Evening HOME after T_TOHOME: stay home, don't go back.) */
        startCommute(s, ST.TO_WORK);
      }
      break;
    case ST.TO_WORK:
      /* Commuting — timer ticks in the update loop via tickCommute(). */
      break;
    case ST.AT_WORK:
      if (nowMin >= T_TOHOME){
        startCommute(s, ST.TO_HOME);
      } else if (nowMin >= T_SLEEP || nowMin < T_WAKE){
        goSleep(s);
      }
      break;
    case ST.TO_HOME:
      /* Commuting home — tick down, arrive when done. */
      break;
  }
}

/* startCommute — begin a car/transit commute.
   Calculates duration from distance, hides the pedestrian mesh
   (they're in a vehicle), sets the timer. */
function startCommute(s, toState){
  var destX, destZ;
  if (toState === ST.TO_WORK){
    destX = HS.hq.x + (srand() - 0.5) * 20;
    destZ = HS.hq.z + (srand() - 0.5) * 20;
  } else {
    destX = s.home.x;
    destZ = s.home.z;
  }
  var dx = destX - s.x, dz = destZ - s.z;
  var dist = Math.sqrt(dx*dx + dz*dz);
  /* Commute time in game-minutes: distance / speed, min 15 min. */
  /* Note: 1 real second = 1 game minute, so this is also real seconds. */
  var commuteMin = Math.max(MIN_COMMUTE, dist / DRIVE_SPEED / 60);
  s.commuteT = commuteMin;
  s.commuteDestX = destX;
  s.commuteDestZ = destZ;
  setStaffState(s, toState);
  /* Hide while in transit — they're in a car/bus, not walking. */
  s.mesh.visible = false;
  s.moving = false;
}

/* tickCommute — advance the commute timer, arrive when done. */
function tickCommute(s, dt){
  /* dt is in real seconds = game minutes. */
  s.commuteT -= dt;
  if (s.commuteT <= 0){
    /* Arrived! Place at destination, make visible. */
    s.x = s.commuteDestX + (srand() - 0.5) * 4;
    s.z = s.commuteDestZ + (srand() - 0.5) * 4;
    try { s.y = groundY(s.x, s.z); } catch(e){ s.y = 0; }
    s.mesh.visible = true;
    if (s.state === ST.TO_WORK){
      setStaffState(s, ST.AT_WORK);
    } else if (s.state === ST.TO_HOME){
      setStaffState(s, ST.HOME);
    }
    return true;
  }
  return false;
}

function setStaffState(s, st){
  s.state = st;
  s.stateT = 0;
}

function goSleep(s){
  setStaffState(s, ST.SLEEP);
  s.mesh.visible = false;
  /* Teleport home for the night. */
  s.x = s.home.x + (srand() - 0.5) * 6;
  s.z = s.home.z + (srand() - 0.5) * 6;
  try { s.y = groundY(s.x, s.z); } catch(e){ s.y = 0; }
}

/* ---------------- movement ---------------- */
/* wBlocked — obstacle check for walking. Guarded. */
function wBlocked(x, z){
  try {
    if (typeof inWater === 'function' && inWater(x, z)) return true;
    if (typeof bldgGrid !== 'undefined' && bldgGrid){
      var cx = Math.floor(x/40), cz = Math.floor(z/40);
      for (var gx = cx-1; gx <= cx+1; gx++){
        for (var gz = cz-1; gz <= cz+1; gz++){
          var cell = bldgGrid[gx+','+gz];
          if (!cell) continue;
          for (var i = 0; i < cell.length; i++){
            var c = cell[i];
            var dx = x - c.x, dz = z - c.z, rr = c.r + 0.8;
            if (dx*dx + dz*dz < rr*rr) return true;
          }
        }
      }
    }
  } catch(e){}
  return false;
}

/* wanderNear — casual wandering near a point (home or HQ). */
function wanderNear(s, cx, cz, radius, dt){
  s.stateT -= dt;
  if (s.stateT <= 0){
    /* Pick a new wander target. */
    var a = srand() * Math.PI * 2;
    var r = srand() * radius;
    s.tx = cx + Math.cos(a) * r;
    s.tz = cz + Math.sin(a) * r;
    s.stateT = 3 + srand() * 5;
  }
  var dx = s.tx - s.x, dz = s.tz - s.z;
  var d = Math.sqrt(dx*dx + dz*dz);
  if (d > 1.0){
    if (!wBlocked(s.x + (dx/d)*2, s.z + (dz/d)*2)){
      s.heading = Math.atan2(dx, dz);
      s.x += (dx/d) * WALK_SPEED * 0.5 * dt;
      s.z += (dz/d) * WALK_SPEED * 0.5 * dt;
      try { s.y = groundY(s.x, s.z); } catch(e){}
      s.moving = true;
    } else {
      s.moving = false;
    }
  } else {
    s.moving = false;
  }
}

/* ---------------- init ---------------- */
function initHQStaff(){
  HS = {
    staff: [],
    hq: findHQBuilding(),
    day: 0,
    clockMin: 360, // start Monday 06:00
    ready: false
  };

  /* Allow external override of HQ location (for the parent conversion task). */
  if (window.__hqstaffHQOverride){
    HS.hq = window.__hqstaffHQOverride;
  }

  /* Create staff members. */
  var staffIdx = 0;
  for (var d = 0; d < DEPARTMENTS.length; d++){
    var dept = DEPARTMENTS[d];
    for (var s = 0; s < 2; s++){
      var name = STAFF_NAMES[staffIdx % STAFF_NAMES.length];
      var title = dept.titles[s % dept.titles.length];
      var home = assignHome(staffIdx);

      /* Civilian appearance — varied, normal clothes. */
      var isWoman = srand() < 0.5;
      var appearance = {
        skin: CIV_SKINS[(srand() * CIV_SKINS.length) | 0],
        shirt: CIV_SHIRTS[(srand() * CIV_SHIRTS.length) | 0],
        pants: CIV_PANTS[(srand() * CIV_PANTS.length) | 0],
        hair: CIV_HAIR[(srand() * CIV_HAIR.length) | 0],
        hairStyle: isWoman ?
          (srand() < 0.4 ? 'long' : (srand() < 0.5 ? 'bun' : 'short')) :
          'short',
        scale: isWoman ? 0.92 + srand() * 0.08 : 0.95 + srand() * 0.10,
        briefcase: srand() < 0.6,  // 60% carry a briefcase
        glasses: srand() < 0.25,   // 25% wear glasses
        shortSleeves: srand() < 0.3
      };

      var mesh = buildStaffMember(appearance);
      /* Start at home. */
      var sx = home.x + (srand() - 0.5) * 10;
      var sz = home.z + (srand() - 0.5) * 10;
      var sy = 0;
      try { sy = groundY(sx, sz); } catch(e){}

      mesh.position.set(sx, sy, sz);
      scene.add(mesh);

      var staff = {
        id: staffIdx,
        name: name,
        title: title,
        dept: dept.id,
        deptName: dept.name,
        home: home,
        x: sx, z: sz, y: sy,
        heading: srand() * Math.PI * 2,
        tx: sx, tz: sz,
        state: ST.HOME,
        stateT: 2 + srand() * 4,
        moving: false,
        mesh: mesh,
        appearance: appearance,
        isWoman: isWoman,
        /* Commute fields (car/transit, not walking). */
        commuteT: 0,
        commuteDestX: sx,
        commuteDestZ: sz
      };

      HS.staff.push(staff);
      staffIdx++;
    }
  }

  HS.ready = true;

  /* Register HQ as a landmark for the minimap. */
  try {
    if (typeof LANDMARKS !== 'undefined'){
      LANDMARKS.push({ x: HS.hq.x, z: HS.hq.z, name: 'MUNICIPAL HQ' });
    }
  } catch(e){}

  try {
    if (typeof Report !== 'undefined' && Report.note){
      Report.note('hqstaff', 'HQ staff online: ' + HS.staff.length +
        ' civilian workers, HQ at (' + Math.round(HS.hq.x) + ',' +
        Math.round(HS.hq.z) + ')');
    }
  } catch(e){}
}

/* ---------------- main loop ---------------- */
function updateHQStaff(dt){
  if (!HS || !HS.ready || !HS.staff.length) return;
  try {
    dt = Math.min(0.05, dt || 0.016);

    /* Game clock: 1 real second = 1 game minute. */
    HS.clockMin += dt;
    if (HS.clockMin >= 1440){
      HS.clockMin -= 1440;
      HS.day++;
    }
    var nowMin = HS.clockMin;

    for (var i = 0; i < HS.staff.length; i++){
      var s = HS.staff[i];
      s.moving = false;

      /* Think: update state based on schedule. */
      staffThink(s, nowMin);

      /* Act: move based on state. */
      if (s.state === ST.TO_WORK || s.state === ST.TO_HOME){
        /* Commuting by car/transit — tick the timer, not walking. */
        tickCommute(s, dt);
      } else if (s.state === ST.HOME){
        wanderNear(s, s.home.x, s.home.z, 15, dt);
      } else if (s.state === ST.AT_WORK){
        /* At HQ — wander near the building entrance. */
        wanderNear(s, HS.hq.x, HS.hq.z, 12, dt);
      }
      /* SLEEP: hidden, no movement. */

      /* Pose mesh. */
      if (s.mesh.visible){
        s.mesh.position.set(s.x, s.y, s.z);
        s.mesh.rotation.y = s.heading;
        var u = s.mesh.userData;
        if (s.moving){
          u.phase += dt * 7;
          var sw = Math.sin(u.phase) * 0.5;
          u.armL.rotation.x = sw;
          u.armR.rotation.x = -sw;
          u.legL.rotation.x = -sw;
          u.legR.rotation.x = sw;
        } else {
          /* Ease back to neutral. */
          u.armL.rotation.x *= 0.9;
          u.armR.rotation.x *= 0.9;
          u.legL.rotation.x *= 0.9;
          u.legR.rotation.x *= 0.9;
        }
      }
    }
  } catch(e){}
}

/* ---------------- public API ---------------- */
window.HQ_STAFF = {
  /* setHQ(x, z, name) — override the HQ building location.
     Called by the parent conversion task if it picks a specific building. */
  setHQ: function(x, z, name){
    window.__hqstaffHQOverride = { x: x, z: z, name: name || 'Municipal HQ' };
    if (HS && HS.ready){
      HS.hq = window.__hqstaffHQOverride;
    }
  },
  /* getStaff() — list of staff with current state. */
  getStaff: function(){
    if (!HS || !HS.ready) return [];
    return HS.staff.map(function(s){
      return {
        name: s.name, title: s.title, dept: s.deptName,
        state: ST_NAMES[s.state],
        x: Math.round(s.x), z: Math.round(s.z)
      };
    });
  },
  /* getHQ() — HQ building location. */
  getHQ: function(){
    if (!HS || !HS.ready) return null;
    return { x: HS.hq.x, z: HS.hq.z, name: HS.hq.name };
  },
  /* clock() — current game time. */
  clock: function(){
    if (!HS) return null;
    var hh = Math.floor(HS.clockMin / 60), mm = Math.floor(HS.clockMin % 60);
    return 'DAY ' + (HS.day + 1) + ' ' + DAYS[HS.day % 7] + ' ' +
      (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
};

/* Expose the update function for the animate() wrapper. */
window.updateHQStaff = function(dt){ updateHQStaff(dt || 0.016); };

/* ---------------- boot ---------------- */
/* Wrap animate() to call updateHQStaff each frame. */
function wrapAnimate(){
  try {
    if (typeof animate === 'function' && !animate.__hqstaffWrap){
      var orig = animate;
      /* v1.22 LAUNCHER (Joshua 2026-10-10): skip when HQ staff disabled in launch options. */
      var wrapped = function(){ orig(); if(!window.__npcPaused && (!window.__launchOpts || window.__launchOpts.hqStaff!==false)) updateHQStaff(0.016); };
      wrapped.__hqstaffWrap = true;
      animate = wrapped;
    }
  } catch(e){}
}

/* Boot poller: init when THREE, scene, roadDrawData, PLACED_HOUSES,
   and animate are ready. */
var bootTries = 0;
var bootTimer = setInterval(function(){
  bootTries++;
  var ready = false;
  try {
    ready = (typeof THREE !== 'undefined' &&
             typeof scene !== 'undefined' &&
             typeof roadDrawData !== 'undefined' && roadDrawData.length > 100 &&
             typeof PLACED_HOUSES !== 'undefined' && PLACED_HOUSES.length > 0 &&
             typeof animate === 'function' &&
             typeof heightAt === 'function');
  } catch(e){ ready = false; }
  if (ready){
    try { initHQStaff(); } catch(e){
      try {
        if (typeof Report !== 'undefined') Report.noteError('hqstaff', 'init failed', String(e && e.message || e));
      } catch(x){}
    }
    try { wrapAnimate(); } catch(e){}
    clearInterval(bootTimer);
  } else if (bootTries > 240){
    clearInterval(bootTimer);
    try {
      if (typeof Report !== 'undefined') Report.noteError('hqstaff', 'boot-timeout', 'deps never ready');
    } catch(e){}
  }
}, 250);

})();
