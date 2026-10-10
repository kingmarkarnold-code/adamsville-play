/* ============================================================================
   FILE: dialogue_director_npc.js — "Surviving Adamsville" DIALOGUE DIRECTOR NPC
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-09):
     "Dialogue director can be an NPC. He can push the finalize conversation
      as something that is deployed to a agent."

     The Dialogue Director — previously an active AGENT role — is now a living
     character in the game world. The actual conversation FINALIZATION (code
     work: writing pools, wiring pickers, deploying dialogue systems) STAYS
     with the agent team. What becomes an NPC is the in-world persona: the
     writer behind the city's words.

   WHAT THIS MODULE DOES:
     1. Spawns ONE civilian NPC: the Dialogue Director — a writer/creative
        type. Creative-casual clothes (blazer, turtleneck, jeans), glasses,
        and a NOTEBOOK in hand (writers carry notebooks, not briefcases).
        NOT a crew uniform. NOT hi-vis. A real person.
     2. Gives them a WORKPLACE: the "Dialogue Studio" — a creative office
        wing of the downtown Municipal HQ (same building the HQ staff use;
        reads window.HQ_STAFF.getHQ() when available, else auto-detects the
        largest downtown office building itself).
     3. Gives them a HOME in a residential area (from PLACED_HOUSES).
     4. Daily routine driven by the game clock (window.__daycycle.gameMin,
        the authoritative 124-minute day; falls back to an internal clock):
          22:00-06:00  SLEEP    (hidden at home)
          06:00-07:30  HOME     (morning, visible near home)
          07:30-08:30  TO_WORK  (commuting by car/transit — hidden in transit)
          08:30-17:00  AT_WORK  (at the Dialogue Studio, downtown HQ)
          17:00-18:00  TO_HOME  (commuting home — hidden in transit)
          18:00-22:00  HOME     (evening, visible near home)
        Weekends: stays home all day (writes from the porch).
     5. TALK integration (flavor/lore — the whole point of the character):
        when the player walks up, the universal action button offers TALK
        and the Director speaks from their OWN line pool (TALK_DIRECTOR) —
        first-person lines about writing the city's dialogue. The dialog
        panel labels them "DIALOGUE DIRECTOR" (a title, not a personal
        name — respects Joshua's no-named-characters rule for NPCs).
        Hooked via two tiny guarded blocks in index.html (updateActionButton
        + the action dispatcher); if this module is missing, both degrade
        to no-ops and the game is untouched.

   IN-WORLD ROLE (flavor): they are the one who "writes" NPC dialogue —
     every Atlanta line a stranger says on the sidewalk passed through
     their notebook first. They listen to the city and write it down.

   AGENT ROLE (unchanged): conversation finalization — authoring pools,
     voice rules, wiring npcTalkLine/npcStartTalk, deploying dialogue
     systems — remains with the agent development team. This module never
     touches npc_system.js pools.

   STANDALONE MODULE. Include AFTER the main game script — zero edits to
   index.html game logic required beyond the two guarded TALK hooks:

       <script src="dialogue_director_npc.js"></script>

   Reads (all optional/guarded): THREE, scene, animate, roadDrawData,
   PLACED_HOUSES, OSM_BUILDINGS, heightAt, inWater, bldgGrid, vehLam,
   buildFace3D/addLegoFacePlane (face_platform.js), IS_APK, Report,
   window.HQ_STAFF (workplace), window.__daycycle (game clock),
   npcTalkEligible (TALK gating), showNpcDialog/hideNpcDialog, player.
   Writes: 1 character Group in scene; window.DIALOGUE_DIRECTOR (public
   API); window.directorTalkNearest / window.directorStartTalk (TALK hooks).
   ============================================================================ */
(function(){
'use strict';
/* Single-instance guard — never double-boot if the script tag loads twice. */
if (window.__directorNpcV1) return;
window.__directorNpcV1 = true;

/* ---------------- config ---------------- */
var WALK_SPEED = 1.6;         // casual pace (u/s)
/* Schedule (game minutes from midnight). Mirrors the HQ staff rhythm so
   the whole municipal workforce moves on one believable schedule. */
var T_WAKE     = 360;   // 06:00 — wake up
var T_TOWORK   = 450;   // 07:30 — leave for work
var T_ATWORK   = 510;   // 08:30 — arrive at the Dialogue Studio
var T_TOHOME   = 1020;  // 17:00 — leave work
var T_ATHOME   = 1080;  // 18:00 — arrive home (evening)
var T_SLEEP    = 1320;  // 22:00 — sleep (hidden)
var DAYS = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
/* TALK ranges — match npc_system.js (TALK_R=4.5, TALK_FACE_R=8, TALK_END_R=6). */
var TALK_R = 4.5, TALK_FACE_R = 8, TALK_END_R = 6;
/* Commute: drives/takes transit like a real commuter — never walks the map. */
var DRIVE_SPEED = 25;         // commute speed (u/s)
var MIN_COMMUTE = 15;         // minimum commute (game-minutes)

/* ---------------- the Director's own line pool ----------------
   TALK_DIRECTOR — first-person, casual, PG. The in-world writer of the
   city's dialogue talks about WRITING the city's dialogue. Atlanta-creative
   voice: notebooks, listening, neighborhoods, rain. Never the same line
   twice in a row (talkLastKey pattern, same as npcTalkLine). */
var TALK_DIRECTOR = [
  "I write what folks say around here. Every line you hear on these streets — I typed it.",
  "People think the city just talks. Nah. Somebody's gotta give 'em the words. That's me.",
  "I'm always listening — a good line at the bus stop ends up in somebody's mouth by Friday.",
  "My studio's downtown. Walls full of notebooks. Every conversation in this city starts on those pages.",
  "You got a story? Tell me. I might just write you into the neighborhood.",
  "Folks ask where I get my lines. I walk these blocks and I listen. Atlanta talks — I just write it down.",
  "The crews fix the roads. I fix the silence. Somebody's gotta keep this city talking.",
  "Every 'hey' and 'how you doing' you hear out here passed through my desk first.",
  "Rainy day like this? Great writing weather. The city sounds different in the rain.",
  "I keep a notebook for every neighborhood. Adamsville's is getting thick.",
  "You ever notice strangers here just... talk to you? You're welcome.",
  "Sixteen-year-old me would've loved this job. Now I write the words kids say on their way to school."
];
var dirTalkLast = -1;
function directorTalkLine(){
  var i, guard = 0;
  do { i = (Math.random() * TALK_DIRECTOR.length) | 0; guard++; }
  while (i === dirTalkLast && guard < 10);
  dirTalkLast = i;
  return TALK_DIRECTOR[i];
}

var DD = null; // runtime state

/* ---------------- helpers ---------------- */
/* groundY — safe terrain height lookup, never NaN. */
function groundY(x, z){
  try { var y = heightAt(x, z); return isFinite(y) ? y : 0; }
  catch(e){ return 0; }
}
/* Seeded random for deterministic generation. */
var _seed = 987654;
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
/* gameMin — authoritative game clock when daycycle is loaded; otherwise
   the internal fallback clock (1 real sec = 1 game min, HQ-staff style). */
function gameMin(){
  try {
    if (window.__daycycle && isFinite(window.__daycycle.gameMin))
      return window.__daycycle.gameMin;
  } catch(e){}
  return DD ? DD.fallbackMin : 480;
}
function gameDay(){
  try {
    if (window.__daycycle && isFinite(window.__daycycle.dayNum))
      return window.__daycycle.dayNum;
  } catch(e){}
  return DD ? DD.fallbackDay : 0;
}

/* ---------------- workplace ---------------- */
/* findStudio — the "Dialogue Studio": a creative-office wing of the
   downtown Municipal HQ. Prefers the HQ staff module's detected HQ so the
   whole workforce shares one building (Joshua's directive); otherwise
   auto-detects the largest downtown office building itself. */
function findStudio(){
  /* 1. Ask the HQ staff module — one building for all departments. */
  try {
    if (window.HQ_STAFF && typeof window.HQ_STAFF.getHQ === 'function'){
      var hq = window.HQ_STAFF.getHQ();
      if (hq && isFinite(hq.x) && isFinite(hq.z)){
        return { x: hq.x, z: hq.z, name: 'Dialogue Studio (Municipal HQ)' };
      }
    }
  } catch(e){}
  /* 2. Auto-detect: largest OSM building in the downtown NE quadrant. */
  try {
    var best = null, bestArea = 0;
    if (typeof OSM_BUILDINGS !== 'undefined' && OSM_BUILDINGS.length){
      for (var i = 0; i < OSM_BUILDINGS.length; i++){
        var b = OSM_BUILDINGS[i];
        if (!b || b.length < 5) continue;
        var x = b[0], z = b[1], w = b[2] || 10, d = b[3] || 10;
        if (x < 6000 || z > 4000) continue;   /* downtown filter */
        var area = w * d;
        if (area > bestArea){ bestArea = area; best = { x: x, z: z }; }
      }
    }
    if (best) return { x: best.x, z: best.z, name: 'Dialogue Studio (downtown)' };
  } catch(e){}
  /* 3. Fallback: downtown default near the Marriott. */
  return { x: 7750, z: 2950, name: 'Dialogue Studio (default)' };
}

/* ---------------- home ---------------- */
/* assignHome — a residential house for the Director, NOT downtown.
   Deterministic pick with a different stride than the HQ staff module to
   avoid doubling up on the same house. */
function assignHome(){
  try {
    if (typeof PLACED_HOUSES === 'undefined' || !PLACED_HOUSES.length){
      return { x: 3200, z: 6200, name: 'Director home' };
    }
    var cands = [];
    for (var i = 0; i < PLACED_HOUSES.length; i++){
      var h = PLACED_HOUSES[i];
      if (!h || h.length < 2) continue;
      var x = h[0], z = h[1];
      if (x > 6000 && z < 4000) continue;   /* skip downtown */
      cands.push({ x: x, z: z });
    }
    if (!cands.length) return { x: 3200, z: 6200, name: 'Director home' };
    var pick = cands[(cands.length * 5 + 11) % cands.length];
    return { x: pick.x, z: pick.z, name: 'Director home' };
  } catch(e){
    return { x: 3200, z: 6200, name: 'Director home' };
  }
}

/* ---------------- the Director's look ---------------- */
/* buildDirector — a WRITER/CREATIVE type. Creative-casual, NOT office, NOT
   crew. Corduroy-blazer tone over a tee, dark jeans, glasses (very likely
   for a writer), slightly artistic longer hair, and a NOTEBOOK carried in
   the left hand — the tool of the trade. Distinct silhouette from the HQ
   staff (who wear office shirts and carry briefcases). */
function buildDirector(){
  var g = new THREE.Group();
  /* Fixed, curated appearance — one character, one look. */
  var skin  = new THREE.Color(0x6b4429);
  var blazerC = new THREE.Color(0x5a4632);  /* warm brown blazer */
  var teeC    = new THREE.Color(0x2e4a5a);  /* deep teal tee */
  var jeansC  = new THREE.Color(0x1f2a3a);  /* dark jeans */
  var hairC   = new THREE.Color(0x1a1a1a);
  var shoeC   = new THREE.Color(0x2a2018);

  function box(w, h, d, mat, x, y, z, parent){
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    (parent || g).add(m);
    return m;
  }

  /* Legs (pivot at hip for walk animation). */
  function leg(sx){
    var piv = new THREE.Group();
    piv.position.set(sx * 0.11, 0.82, 0);
    g.add(piv);
    box(0.13, 0.62, 0.13, lam(jeansC), 0, -0.31, 0, piv);
    box(0.14, 0.10, 0.24, lam(shoeC), 0, -0.66, 0.04, piv);
    return piv;
  }
  var legL = leg(-1), legR = leg(1);

  /* Torso: tee with an open blazer suggestion — blazer panels on the
     sides, tee visible down the middle. Creative-casual. */
  box(0.30, 0.55, 0.28, lam(teeC), 0, 1.10, 0);            /* tee */
  box(0.08, 0.55, 0.30, lam(blazerC), -0.19, 1.10, 0);     /* blazer L */
  box(0.08, 0.55, 0.30, lam(blazerC),  0.19, 1.10, 0);     /* blazer R */
  box(0.44, 0.10, 0.30, lam(blazerC), 0, 1.33, 0);         /* shoulders */

  /* Arms (pivot at shoulder). Blazer sleeves. */
  function arm(sx){
    var piv = new THREE.Group();
    piv.position.set(sx * 0.27, 1.30, 0);
    g.add(piv);
    box(0.10, 0.58, 0.10, lam(blazerC), 0, -0.29, 0, piv);
    box(0.09, 0.09, 0.09, lam(skin), 0, -0.60, 0, piv);    /* hand */
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

  /* Hair — slightly longer, artistic. NOT a hard hat. */
  box(hs + 0.03, 0.10, hs + 0.03, lam(hairC), 0, 1.70, 0);
  box(hs + 0.03, 0.30, 0.10, lam(hairC), 0, 1.54, -hs/2 - 0.03);  /* back */

  /* Glasses — the writer look. */
  box(hs + 0.02, 0.045, 0.02, lam(0x1a1a1a), 0, 1.58, hs/2 + 0.01);

  /* NOTEBOOK in the left hand — the tool of the trade. Tan/brown,
     held at the side. This is what makes them the Director, not staff. */
  var nb = box(0.22, 0.30, 0.05, lam(0x8b6f47), -0.40, 0.62, 0.06);
  nb.rotation.z = 0.12;

  g.userData = {
    armL: armL, armR: armR, legL: legL, legR: legR,
    phase: 1.3
  };
  return g;
}

/* ---------------- states ---------------- */
var ST = { SLEEP: 0, HOME: 1, TO_WORK: 2, AT_WORK: 3, TO_HOME: 4 };
var ST_NAMES = ['SLEEP', 'HOME', 'TO_WORK', 'AT_WORK', 'TO_HOME'];

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

/* wanderNear — casual wandering near a point (home or studio). */
function wanderNear(cx, cz, radius, dt){
  var d = DD;
  d.stateT -= dt;
  if (d.stateT <= 0){
    var a = srand() * Math.PI * 2, r = srand() * radius;
    d.tx = cx + Math.cos(a) * r;
    d.tz = cz + Math.sin(a) * r;
    d.stateT = 3 + srand() * 5;
  }
  var dx = d.tx - d.x, dz = d.tz - d.z;
  var dist = Math.sqrt(dx*dx + dz*dz);
  if (dist > 1.0){
    if (!wBlocked(d.x + (dx/dist)*2, d.z + (dz/dist)*2)){
      d.heading = Math.atan2(dx, dz);
      d.x += (dx/dist) * WALK_SPEED * 0.5 * dt;
      d.z += (dz/dist) * WALK_SPEED * 0.5 * dt;
      try { d.y = groundY(d.x, d.z); } catch(e){}
      d.moving = true;
    } else d.moving = false;
  } else d.moving = false;
}

function setState(st){ DD.state = st; DD.stateT = 0; }

function goSleep(){
  setState(ST.SLEEP);
  DD.mesh.visible = false;
  DD.x = DD.home.x + (srand() - 0.5) * 6;
  DD.z = DD.home.z + (srand() - 0.5) * 6;
  try { DD.y = groundY(DD.x, DD.z); } catch(e){ DD.y = 0; }
}

/* startCommute — car/transit commute (timed, hidden in transit). */
function startCommute(toState){
  var destX, destZ;
  if (toState === ST.TO_WORK){
    destX = DD.studio.x + (srand() - 0.5) * 20;
    destZ = DD.studio.z + (srand() - 0.5) * 20;
  } else {
    destX = DD.home.x; destZ = DD.home.z;
  }
  var dx = destX - DD.x, dz = destZ - DD.z;
  var dist = Math.sqrt(dx*dx + dz*dz);
  DD.commuteT = Math.max(MIN_COMMUTE, dist / DRIVE_SPEED / 60);
  DD.commuteDestX = destX; DD.commuteDestZ = destZ;
  setState(toState);
  DD.mesh.visible = false;
  DD.moving = false;
}

function tickCommute(dt){
  DD.commuteT -= dt;
  if (DD.commuteT <= 0){
    DD.x = DD.commuteDestX + (srand() - 0.5) * 4;
    DD.z = DD.commuteDestZ + (srand() - 0.5) * 4;
    try { DD.y = groundY(DD.x, DD.z); } catch(e){ DD.y = 0; }
    DD.mesh.visible = true;
    if (DD.state === ST.TO_WORK) setState(ST.AT_WORK);
    else if (DD.state === ST.TO_HOME) setState(ST.HOME);
    return true;
  }
  return false;
}

/* think — daily schedule state machine. Weekends: home all day. */
function think(nowMin){
  var d = DD;
  var isWeekend = (gameDay() % 7) >= 5;   /* SAT=5, SUN=6 */
  if (isWeekend){
    if (d.state === ST.TO_WORK || d.state === ST.AT_WORK || d.state === ST.TO_HOME)
      startCommute(ST.TO_HOME);
    if (d.state === ST.SLEEP && nowMin >= T_WAKE && nowMin < T_SLEEP){
      setState(ST.HOME); d.mesh.visible = true;
    } else if (d.state !== ST.SLEEP && (nowMin >= T_SLEEP || nowMin < T_WAKE)){
      goSleep();
    }
    return;
  }
  switch(d.state){
    case ST.SLEEP:
      if (nowMin >= T_WAKE && nowMin < T_SLEEP){
        setState(ST.HOME); d.mesh.visible = true;
      }
      break;
    case ST.HOME:
      if (nowMin >= T_SLEEP || nowMin < T_WAKE) goSleep();
      else if (nowMin >= T_TOWORK && nowMin < T_TOHOME) startCommute(ST.TO_WORK);
      break;
    case ST.TO_WORK: break;   /* ticked in the main loop */
    case ST.AT_WORK:
      if (nowMin >= T_TOHOME) startCommute(ST.TO_HOME);
      else if (nowMin >= T_SLEEP || nowMin < T_WAKE) goSleep();
      break;
    case ST.TO_HOME: break;   /* ticked in the main loop */
  }
}

/* ---------------- TALK hooks ---------------- */
/* talkEligible — same gating as npcTalkEligible (on foot, outside). */
function talkEligible(){
  try {
    if (typeof npcTalkEligible === 'function') return npcTalkEligible();
  } catch(e){}
  try {
    if (typeof car !== 'undefined' && car && car.driving) return false;
    if (typeof player !== 'undefined' && player &&
        (player.inside || player.ridingTrain || player.ridingBus)) return false;
  } catch(e){}
  return true;
}
/* playerPos — guarded player position. */
function playerPos(){
  try {
    if (typeof player !== 'undefined' && player &&
        isFinite(player.x) && isFinite(player.z))
      return { x: player.x, z: player.z };
  } catch(e){}
  return null;
}
/* directorTalkNearest(px,pz) — the Director as a TALK target: visible,
   within TALK_R, and TALK-eligible. Returns a pseudo-NPC handle. */
function directorTalkNearest(px, pz){
  try {
    if (!DD || !DD.ready) return null;
    if (!DD.mesh.visible) return null;
    if (!talkEligible()) return null;
    var dx = px - DD.x, dz = pz - DD.z;
    if (dx*dx + dz*dz > TALK_R * TALK_R) return null;
    return { isDirector: true, x: DD.x, z: DD.z };
  } catch(e){ return null; }
}
/* directorStartTalk() — opens the dialog with the Director's own lines.
   Panel label is the TITLE "DIALOGUE DIRECTOR" (no personal names — per
   Joshua's no-named-characters rule). Sets talking so the walk-away check
   can close the conversation. */
function directorStartTalk(){
  try {
    if (!DD || !DD.ready) return;
    DD.talking = true;
    DD.focus = true;
    var line = directorTalkLine();
    if (typeof showNpcDialog === 'function')
      showNpcDialog('DIALOGUE DIRECTOR', line);
  } catch(e){}
}
function directorEndTalk(){
  try { if (DD){ DD.talking = false; DD.focus = false; } } catch(e){}
}
window.directorTalkNearest = directorTalkNearest;
window.directorStartTalk = directorStartTalk;
window.directorEndTalk = directorEndTalk;

/* ---------------- init ---------------- */
function initDirector(){
  DD = {
    studio: findStudio(),
    home: assignHome(),
    x: 0, z: 0, y: 0, heading: 0, tx: 0, tz: 0,
    state: ST.HOME, stateT: 3, moving: false,
    mesh: null, talking: false, focus: false,
    commuteT: 0, commuteDestX: 0, commuteDestZ: 0,
    fallbackMin: 480, fallbackDay: 0,   /* internal clock if no daycycle */
    ready: false
  };
  var mesh = buildDirector();
  var sx = DD.home.x + (srand() - 0.5) * 10;
  var sz = DD.home.z + (srand() - 0.5) * 10;
  DD.x = sx; DD.z = sz; DD.tx = sx; DD.tz = sz;
  try { DD.y = groundY(sx, sz); } catch(e){ DD.y = 0; }
  mesh.position.set(DD.x, DD.y, DD.z);
  scene.add(mesh);
  DD.mesh = mesh;
  DD.ready = true;
  try {
    if (typeof Report !== 'undefined' && Report.note){
      Report.note('director', 'Dialogue Director NPC online — studio at (' +
        Math.round(DD.studio.x) + ',' + Math.round(DD.studio.z) + '), home at (' +
        Math.round(DD.home.x) + ',' + Math.round(DD.home.z) + ')');
    }
  } catch(e){}
}

/* ---------------- main loop ---------------- */
function updateDirector(dt){
  if (!DD || !DD.ready || !DD.mesh) return;
  try {
    dt = Math.min(0.05, dt || 0.016);
    /* Fallback clock ticks only when daycycle is absent. */
    try {
      if (!(window.__daycycle && isFinite(window.__daycycle.gameMin))){
        DD.fallbackMin += dt;
        if (DD.fallbackMin >= 1440){ DD.fallbackMin -= 1440; DD.fallbackDay++; }
      }
    } catch(e){}
    var nowMin = gameMin();
    DD.moving = false;

    think(nowMin);

    if (DD.state === ST.TO_WORK || DD.state === ST.TO_HOME){
      tickCommute(dt);
    } else if (DD.state === ST.HOME){
      wanderNear(DD.home.x, DD.home.z, 15, dt);
    } else if (DD.state === ST.AT_WORK){
      wanderNear(DD.studio.x, DD.studio.z, 12, dt);
    }

    /* Face the player when near and TALK-eligible (Joshua: NPCs turn
       toward the individual). Walk-away ends the conversation. */
    var pp = playerPos();
    if (pp && DD.mesh.visible && talkEligible()){
      var dx = pp.x - DD.x, dz = pp.z - DD.z;
      var d2 = dx*dx + dz*dz;
      if (d2 < TALK_FACE_R * TALK_FACE_R){
        var want = Math.atan2(dx, dz);
        var diff = want - DD.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        DD.heading += diff * Math.min(1, 10 * dt);
      }
      if (DD.talking && d2 > TALK_END_R * TALK_END_R){
        try { if (typeof hideNpcDialog === 'function') hideNpcDialog(); } catch(e){}
        directorEndTalk();
      }
    }
    /* BYE button path: hideNpcDialog -> npcEndTalk; clear our flag if the
       panel was closed out from under us. */
    if (DD.talking){
      try {
        var dlg = document.getElementById('npc-dialog');
        if (dlg && dlg.style.display === 'none') directorEndTalk();
      } catch(e){}
    }

    if (DD.mesh.visible){
      DD.mesh.position.set(DD.x, DD.y, DD.z);
      DD.mesh.rotation.y = DD.heading;
      var u = DD.mesh.userData;
      if (DD.moving){
        u.phase += dt * 7;
        var sw = Math.sin(u.phase) * 0.5;
        u.armL.rotation.x = sw; u.armR.rotation.x = -sw;
        u.legL.rotation.x = -sw; u.legR.rotation.x = sw;
      } else {
        u.armL.rotation.x *= 0.9; u.armR.rotation.x *= 0.9;
        u.legL.rotation.x *= 0.9; u.legR.rotation.x *= 0.9;
      }
    }
  } catch(e){}
}

/* ---------------- public API ---------------- */
window.DIALOGUE_DIRECTOR = {
  /* getInfo() — the Director's current state (for admin/debug). */
  getInfo: function(){
    if (!DD || !DD.ready) return null;
    return {
      role: 'Dialogue Director (NPC)',
      state: ST_NAMES[DD.state],
      talking: DD.talking,
      studio: { x: Math.round(DD.studio.x), z: Math.round(DD.studio.z), name: DD.studio.name },
      home: { x: Math.round(DD.home.x), z: Math.round(DD.home.z) },
      note: 'In-world writer of the city\'s dialogue. Conversation ' +
            'finalization (code) stays with the agent team.'
    };
  },
  /* getStudio() — workplace location. */
  getStudio: function(){
    if (!DD || !DD.ready) return null;
    return { x: DD.studio.x, z: DD.studio.z, name: DD.studio.name };
  },
  /* talkLine() — serve a Director line (debug/console use). */
  talkLine: function(){ return directorTalkLine(); },
  /* clock() — current game time as the Director sees it. */
  clock: function(){
    var m = gameMin(), d = gameDay();
    var hh = Math.floor(m / 60), mm = Math.floor(m % 60);
    return 'DAY ' + (d + 1) + ' ' + DAYS[d % 7] + ' ' +
      (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
};

/* Expose the update function for the animate() wrapper. */
window.updateDirector = function(dt){ updateDirector(dt || 0.016); };

/* ---------------- boot ---------------- */
function wrapAnimate(){
  try {
    if (typeof animate === 'function' && !animate.__directorWrap){
      var orig = animate;
      var wrapped = function(){ orig(); updateDirector(0.016); };
      wrapped.__directorWrap = true;
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
             typeof roadDrawData !== 'undefined' && roadDrawData.length > 100 &&
             typeof PLACED_HOUSES !== 'undefined' && PLACED_HOUSES.length > 0 &&
             typeof animate === 'function' &&
             typeof heightAt === 'function');
  } catch(e){ ready = false; }
  if (ready){
    try { initDirector(); } catch(e){
      try {
        if (typeof Report !== 'undefined') Report.noteError('director', 'init failed', String(e && e.message || e));
      } catch(x){}
    }
    try { wrapAnimate(); } catch(e){}
    clearInterval(bootTimer);
  } else if (bootTries > 240){
    clearInterval(bootTimer);
    try {
      if (typeof Report !== 'undefined') Report.noteError('director', 'boot-timeout', 'deps never ready');
    } catch(e){}
  }
}, 250);

})();
