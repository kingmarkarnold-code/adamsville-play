/* ============================================================================
   FILE: basketball_court.js — BACKYARD BASKETBALL mini-game, STAGE 1 (v1.0)
   ----------------------------------------------------------------------------
   JOSHUA'S DESIGN (2026-10-17, hand sketch via the Draw-for-Mollie channel
   + his words): "This is the beginning of the mini-game. It's a basketball
   court, in the backyard of 535. The orange is the tree with the basketball
   goal. When you walk in between the trees in the game it should say do
   you want to play a game."

   His sketch: a curved line with trees along it, and ONE distinct orange
   tree standing on the curve. Design corrections (same evening):
     1. The court surface is DIRT — a bare-earth patch in the backyard.
        The curved line in the sketch is the dirt patch's EDGE (where the
        dirt ends and the grass begins), not a painted marking.
     2. NO VISIBLE LINES — no painted court lines of any kind.
     3. YES opens the mini-game FULL SCREEN — a dedicated mode that takes
        over the view and frames the dirt court + goal tree as its own
        scene. Exiting returns the player to exactly where he stood.
   Progress addition (same evening): the mini-game SAVES the player's
   progress — lifetime baskets persist in localStorage and are restored
   when the mini-game next opens.

   WHAT STAGE 1 BUILDS:
   - THE COURT: an elliptical dirt patch in the backyard of the hero house
     (535 Dollar Mill Rd), behind the house (north side), built with the
     hero-house code path: plain meshes added to the scene at build time,
     draped over the real terrain via heightAt(). No zone data is touched,
     nothing is painted on the dirt.
   - THE GOAL TREE: one bigger pine at the far (north) arc of the patch,
     carrying a backboard + rim + net on its trunk, facing the court at
     regulation height (rim 3.05 m above its own ground). Two pines flank
     the south entrance (the way in from the back door); more pines stand
     along the arc, as in the sketch. Every trunk gets a collider that
     matches its visible size (addCollider -> propGrid), exactly like the
     hero house's own yard pines.
   - THE TRIGGER: walking on foot between the two entrance trees (south
     -> north across the gate line) shows the prompt: "Do you want to
     play a game?" [Yes] [No]. No dismisses and the prompt stays away
     until the player leaves the court area and walks in again.
   - YES = FULL-SCREEN MINI-GAME (the framing choice): the SAME scene,
     but this module takes over the camera (window.__bballActive makes
     updateCamera() return early — the exact pattern satellite_view.js
     uses with __satViewActive), pins the player at the shooting spot,
     frames court + goal tree from a court-side camera, hides the roam
     HUD, and shows its own top bar (title + Baskets readout + Leave).
     A separate rendered view was rejected: a second scene/renderer
     would double the memory on Joshua's hardware and could drift from
     the real world; one scene, one camera, zero duplication.
   - THE STUB PLAY (deliberately minimal — the full basketball
     simulation is a future system on Joshua's roadmap): a ball rests at
     the shooting spot. ACTION picks it up, ACTION again shoots it in a
     simple arc at the rim (a small random spread means not every shot
     falls). A made basket is detected honestly — the ball crossing the
     rim plane downward inside the ring — counted, SAVED IMMEDIATELY,
     and shown on the readout. ACTION after a shot re-spots the ball.
   - PROGRESS SAVE: localStorage 'sa.basketball.v1' (the game's
     local-only persistence style, like zone unlocks): {v, baskets,
     sessions}. Written the moment a basket lands — not at exit — and
     read back when the module boots, so leaving, closing the game, and
     coming back keeps his progress. Game data files are never touched.

   FAILURE PHILOSOPHY (Joshua): init is wrapped in try/catch and any
   failure is filed through SA_CRASH (the crash-report queue) — never
   silent, never a hard stop of the game. Every external access (THREE,
   scene, heroHouse, Sim, DOM, storage) is guarded; if anything vital
   is missing the module reports and stays inert.

   HOOKS (all non-invasive, following the house patterns):
   - Sim tick registry: 'input' (freeze controls in play mode), 'sim'
     (trigger + pinning + ball physics), 'render' (camera in play mode).
   - updateActionButton is WRAPPED (interior_system.js pattern) so the
     universal ACTION button serves the ball while playing; a private
     click listener on #action-btn handles act 'bball' (the game's own
     handler ignores unknown acts).
   - ONE line in index.html's updateCamera mirrors the satellite-view
     guard for window.__bballActive; one data-dsrc tag loads this file.

   PUBLIC API (window.BBALL): version, mode(), baskets(), sessions(),
   rim(), court(), gate(), yes(), no(), exit(), action(), ballState(),
   and _ticks (registration proof counters for the test harness).
   ============================================================================ */
(function(){
'use strict';
if (window.BBALL) return;  // single instance guard

/* ============================== constants ============================== */

/* Save key — versioned, local-only, in the game's 'sa.<thing>.v1' style. */
var SAVE_KEY = 'sa.basketball.v1';

/* Court layout, stated as offsets from the hero-house centre so the
   court follows the house if its data ever moves. North is -z (the
   house fronts Dollar Mill Rd to the SOUTH; the backyard is behind
   the house, to the north). All values in game units = metres. */
var COURT_OFF   = { x: 0,     z: -19.3 };  // dirt patch centre
var PATCH_RX    = 7;                      // patch half-width  (x)
var PATCH_RZ    = 9;                      // patch half-length (z)
var GOAL_OFF    = { x: 0,     z: -27.5 };  // goal tree, on the north arc
var RIM_H       = 3.05;                   // regulation rim height (10 ft)
var RIM_OUT     = 0.78;                   // rim centre, south of trunk centre
var SHOOT_OFF   = { x: 0,     z: -21.3 };  // where the player stands to shoot
var BALL_FWD    = 0.55;                   // ball spot, this far in front of him
var GATE_Z_OFF  = -9.3;                   // gate line z (between the trees)
var GATE_HALF_X = 4.0;                    // prompt only between the trunks

/* Yard trees: [xOff, zOff, scale] — the two entrance pines first, then
   the arc pines from the sketch. Deterministic on purpose (no rand():
   the forest must be the same every load). */
var YARD_TREES = [
  { x: -4.5, z: -8.8,  s: 1.00 },   // entrance pine, west of the gate
  { x:  4.5, z: -8.8,  s: 1.05 },   // entrance pine, east of the gate
  { x: -8.3, z: -25.3, s: 1.05 },   // arc pines (behind the dirt edge)
  { x:  8.3, z: -25.3, s: 1.00 },
  { x: -8.8, z: -17.3, s: 0.95 },
  { x:  8.8, z: -17.3, s: 1.10 },
  { x: -5.5, z: -29.8, s: 1.15 },
  { x:  5.5, z: -29.8, s: 0.90 }
];

/* Colours — the game's stylized palette, matched to the hero yard. */
var COL_DIRT      = 0x8a6a48;   // bare earth
var COL_DIRT_WORN = 0x96754f;   // lighter worn middle (a tone, not a line)
var COL_TRUNK     = 0x5a4030;   // same brown as the hero lot pines
var COL_CANOPY    = 0x2d5a27;   // same green as the hero lot pines
var COL_BOARD     = 0xf4f1ea;   // backboard off-white
var COL_RIM       = 0xe8722a;   // rim orange
var COL_BALL      = 0xe8722a;   // basketball orange
var COL_ARM       = 0x333333;   // mounting arm

var GRAVITY = 9.8;              // ball physics, metres/sec^2
var BALL_R  = 0.12;             // basketball radius

/* Roam HUD elements hidden while the mini-game owns the screen.
   (action-btn stays — it is the shoot button; pause-btn and help-btn
   stay — they can never trap the player.) */
var HIDE_IDS = ['hud-title','minimap','mode-tag','street-name','ver-tag',
                'inv-btn','music-btn','cam-btn','speedo','dmg-wrap',
                'joy-base','steer-left','steer-right'];

/* ============================== state ============================== */

var booted   = false;   // court built + hooks registered
var bootTries = 0;      // bounded boot polling (see boot())
var mode     = 'roam';  // 'roam' | 'prompt' | 'play'
var armed    = true;    // gate trigger armed (re-arms outside the court area)
var prevZ    = null;    // player's z last sim tick (crossing detection)
var entry    = null;    // where the player stood when he answered Yes
var built    = null;    // {court, rim, gate, shoot} world-space geometry
var ball     = null;    // ball mesh while playing
var ballState = 'ready';// 'ready' | 'held' | 'flying' | 'dead'
var ballVel  = { x: 0, y: 0, z: 0 };
var ballScored = false; // this shot already counted (count once per shot)
var flyT     = 0;       // seconds since the shot left his hands
var hiddenEls = [];     // [{el, display}] roam HUD hidden in play mode

/* Progress — loaded from localStorage at file scope, saved on change. */
var progress = loadProgress();

var ticks = { input: 0, sim: 0, render: 0 };  // tick-run proof counters

/* DOM refs (built lazily by ensureDom). */
var dom = { prompt: null, hud: null, basketsEl: null };

/* ============================== helpers ============================== */

/* File a failure the game's way — the crash-report queue. Guarded: the
   queue shim exists from the first second of boot, but never assume. */
function report(where, err){
  try{
    if (typeof window.SA_CRASH === 'function'){
      window.SA_CRASH('error', { system: 'basketball-court', where: where,
        message: (err && err.message) ? err.message : String(err) });
    }
  }catch(e){}
  try{ console.warn('[basketball] ' + where + ': ' + ((err && err.message) || err)); }catch(e){}
}

/* A note in the game's Report stream (guarded — telemetry only). */
function note(what, data){
  try{ if (typeof Report !== 'undefined' && Report && Report.note) Report.note('basketball', what, data || {}); }catch(e){}
}

/* Toast, if the game has it (guarded). */
function toast(msg, ms){
  try{ if (typeof showToast === 'function') showToast(msg, ms || 2200); }catch(e){}
}

/* Terrain height, guarded — the court's one source of ground truth. */
function groundY(x, z){
  try{
    if (typeof heightAt === 'function'){
      var y = heightAt(x, z);
      if (typeof y === 'number' && isFinite(y)) return y;
    }
  }catch(e){}
  return 0;
}

function el(id){ try{ return document.getElementById(id); }catch(e){ return null; } }

/* ============================== progress save ============================== */

/* Load saved progress. Anything unreadable/corrupt -> a fresh record
   (the corrupt case is reported, not swallowed). */
function loadProgress(){
  var fresh = { v: 1, baskets: 0, sessions: 0 };
  try{
    if (typeof localStorage === 'undefined') return fresh;
    var raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return fresh;
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return fresh;
    fresh.baskets  = Math.max(0, parseInt(p.baskets, 10) || 0);
    fresh.sessions = Math.max(0, parseInt(p.sessions, 10) || 0);
    return fresh;
  }catch(e){
    report('loadProgress', e);
    return fresh;
  }
}

/* Save progress THE MOMENT it changes (a made basket calls this before
   anything else happens). local-only; game data files are untouched. */
function saveProgress(){
  try{
    if (typeof localStorage === 'undefined') return;
    progress.v = 1;
    localStorage.setItem(SAVE_KEY, JSON.stringify(progress));
  }catch(e){ report('saveProgress', e); }
}

/* ============================== court construction ============================== */

/* One yard pine, in the hero lot's own style (same trunk/canopy build
   as buildHeroHouse's ring pines), with a collider that matches the
   visible trunk — Joshua's collision rule. */
function plantTree(x, z, s){
  var gy = groundY(x, z);
  var trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.45, 7, 6),
    new THREE.MeshLambertMaterial({ color: COL_TRUNK }));
  trunk.position.set(x, gy + 3.5 * s, z);
  trunk.scale.set(s, s, s);
  scene.add(trunk);
  var can = new THREE.Mesh(
    new THREE.ConeGeometry(3.1, 13, 7),
    new THREE.MeshLambertMaterial({ color: COL_CANOPY }));
  can.position.set(x, gy + 13.5 * s, z);
  can.scale.set(s, s, s);
  scene.add(can);
  try{ if (typeof addCollider === 'function') addCollider(x, z, 0.45 * s); }catch(e){}
  return { x: x, z: z, gy: gy, s: s };
}

/* The hoop on the goal tree's trunk: support arm, backboard, rim ring,
   and a simple wireframe net. Faces SOUTH (+z, toward the court).
   Returns the rim centre in world space — the one point all the ball
   math aims at. */
function buildHoop(tree){
  var gy = tree.gy;
  var boardY = gy + RIM_H + 0.45;         // board centre height
  var faceZ  = tree.z + 0.50 * tree.s;    // trunk's south face at board height
  var g = new THREE.Group();

  /* mounting arm from the trunk to the board */
  var arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.6),
    new THREE.MeshLambertMaterial({ color: COL_ARM }));
  arm.position.set(tree.x, boardY + 0.25, tree.z + 0.25 * tree.s);
  g.add(arm);

  /* backboard: 1.8 wide x 1.05 high, off-white */
  var board = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.05, 0.08),
    new THREE.MeshLambertMaterial({ color: COL_BOARD }));
  board.position.set(tree.x, boardY, faceZ + 0.04);
  g.add(board);

  /* rim: orange ring at regulation height, centre RIM_OUT from trunk */
  var rim = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.022, 8, 20),
    new THREE.MeshLambertMaterial({ color: COL_RIM }));
  rim.rotation.x = Math.PI / 2;
  rim.position.set(tree.x, gy + RIM_H, tree.z + RIM_OUT);
  g.add(rim);

  /* net: open wireframe cone hanging from the rim */
  var net = new THREE.Mesh(
    new THREE.CylinderGeometry(0.23, 0.15, 0.4, 8, 3, true),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true }));
  net.position.set(tree.x, gy + RIM_H - 0.2, tree.z + RIM_OUT);
  g.add(net);

  scene.add(g);
  return { x: tree.x, y: gy + RIM_H, z: tree.z + RIM_OUT };
}

/* One draped dirt fan: an ellipse outline triangulated from its centre,
   every vertex sitting on heightAt() + lift. `scale` < 1 builds the
   smaller, lighter "worn middle" tone patch. DoubleSide so the patch
   reads from any camera angle; polygonOffset keeps it off the grass. */
function dirtFan(cx, cz, rx, rz, lift, color){
  var SEG = 56, i, a, x, z;
  var pos = [cx, groundY(cx, cz) + lift, cz];
  for (i = 0; i <= SEG; i++){
    a = (i / SEG) * Math.PI * 2;
    x = cx + Math.cos(a) * rx;
    z = cz + Math.sin(a) * rz;
    pos.push(x, groundY(x, z) + lift, z);
  }
  var idx = [];
  for (i = 1; i <= SEG; i++) idx.push(0, i, i + 1);
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  var mat = new THREE.MeshLambertMaterial({ color: color, side: THREE.DoubleSide });
  mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
  var m = new THREE.Mesh(geo, mat);
  scene.add(m);
  return m;
}

/* Build the whole court from the hero house's real position. Runs once,
   lazily but eagerly at boot — the geometry is a handful of small
   meshes (~30), the same weight class as the hero house itself. */
function buildCourt(){
  var hx = heroHouse.cx, hz = heroHouse.cz;
  var court = { x: hx + COURT_OFF.x, z: hz + COURT_OFF.z };

  /* the dirt patch and its worn middle — the patch's EDGE is the only
     "line" on this court (Joshua's correction: dirt, no painted lines) */
  dirtFan(court.x, court.z, PATCH_RX, PATCH_RZ, 0.05, COL_DIRT);
  dirtFan(court.x, court.z, PATCH_RX * 0.7, PATCH_RZ * 0.7, 0.065, COL_DIRT_WORN);

  /* the trees: entrance pair + arc pines, then the goal tree */
  var i, t;
  for (i = 0; i < YARD_TREES.length; i++){
    t = YARD_TREES[i];
    plantTree(hx + t.x, hz + t.z, t.s);
  }
  var goalTree = plantTree(hx + GOAL_OFF.x, hz + GOAL_OFF.z, 1.3);
  var rim = buildHoop(goalTree);

  built = {
    court: court,
    rim: rim,
    goalTree: { x: goalTree.x, z: goalTree.z },
    shoot: { x: hx + SHOOT_OFF.x, z: hz + SHOOT_OFF.z },
    gate: { z: hz + GATE_Z_OFF, x0: hx - GATE_HALF_X, x1: hx + GATE_HALF_X },
    /* court area for re-arming the gate trigger (a touch larger than
       the dirt, so stepping off the patch counts as leaving) */
    region: { x0: hx - 8.5, x1: hx + 8.5, z0: hz - 30.5, z1: hz - 9.8 }
  };
  return built;
}

/* ============================== DOM (prompt + mini-game bar) ============================== */

function ensureDom(){
  if (dom.prompt) return;
  var style = document.createElement('style');
  style.textContent =
    '#bball-prompt{position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
      'z-index:9990;background:rgba(0,0,0,.35);font-family:inherit;}' +
    '#bball-prompt.show{display:flex;}' +
    '#bball-panel{background:rgba(22,17,12,.94);border:2px solid #e8722a;border-radius:14px;' +
      'padding:22px 26px;text-align:center;color:#fff;max-width:86vw;box-shadow:0 8px 30px rgba(0,0,0,.5);}' +
    '#bball-panel .q{font-size:22px;font-weight:700;margin:0 0 6px;}' +
    '#bball-panel .sub{font-size:13px;opacity:.75;margin:0 0 16px;}' +
    '#bball-panel button{font-size:18px;font-weight:700;border:0;border-radius:10px;' +
      'padding:12px 28px;margin:0 6px;cursor:pointer;}' +
    '#bball-yes{background:#e8722a;color:#fff;}' +
    '#bball-no{background:#4a4a4a;color:#eee;}' +
    '#bball-hud{position:fixed;top:0;left:0;right:0;display:none;z-index:9980;' +
      'background:rgba(22,17,12,.88);color:#fff;padding:10px 14px;' +
      'align-items:center;justify-content:space-between;font-family:inherit;}' +
    '#bball-hud.show{display:flex;}' +
    '#bball-hud .t{font-size:16px;font-weight:700;}' +
    '#bball-hud .b{font-size:16px;font-weight:700;color:#ffb37a;}' +
    '#bball-exit{background:#e8722a;color:#fff;border:0;border-radius:8px;' +
      'font-size:14px;font-weight:700;padding:8px 14px;cursor:pointer;}';
  document.head.appendChild(style);

  /* ---- the invitation prompt ---- */
  var prompt = document.createElement('div');
  prompt.id = 'bball-prompt';
  var panel = document.createElement('div');
  panel.id = 'bball-panel';
  var q = document.createElement('p');
  q.className = 'q';
  q.textContent = 'Do you want to play a game?';
  var sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = '🏀 Backyard basketball at the goal tree';
  var yes = document.createElement('button');
  yes.id = 'bball-yes';
  yes.textContent = 'Yes';
  yes.addEventListener('click', function(){ answerYes(); });
  var no = document.createElement('button');
  no.id = 'bball-no';
  no.textContent = 'No';
  no.addEventListener('click', function(){ answerNo(); });
  panel.appendChild(q); panel.appendChild(sub);
  panel.appendChild(yes); panel.appendChild(no);
  prompt.appendChild(panel);
  document.body.appendChild(prompt);

  /* ---- the mini-game top bar (play mode) ---- */
  var hud = document.createElement('div');
  hud.id = 'bball-hud';
  var t = document.createElement('span');
  t.className = 't';
  t.textContent = '🏀 Backyard Basketball';
  var b = document.createElement('span');
  b.className = 'b';
  b.id = 'bball-baskets';
  var exit = document.createElement('button');
  exit.id = 'bball-exit';
  exit.textContent = '✕ Leave';
  exit.addEventListener('click', function(){ exitPlay(true); });
  hud.appendChild(t); hud.appendChild(b); hud.appendChild(exit);
  document.body.appendChild(hud);

  dom.prompt = prompt;
  dom.hud = hud;
  dom.basketsEl = b;
  updateReadout();
}

/* The Baskets readout reads the SAVED total (restored at boot, bumped
   the moment a basket lands). */
function updateReadout(){
  if (dom.basketsEl) dom.basketsEl.textContent = 'Baskets: ' + progress.baskets;
}

/* ============================== prompt flow ============================== */

function showPrompt(){
  ensureDom();
  mode = 'prompt';
  dom.prompt.classList.add('show');
  note('prompt', { x: Math.round(player.x), z: Math.round(player.z) });
}
function hidePrompt(){
  if (dom.prompt) dom.prompt.classList.remove('show');
}
function answerYes(){
  hidePrompt();
  enterPlay();
}
function answerNo(){
  hidePrompt();
  mode = 'roam';
  armed = false;   // don't re-ask until he leaves the court area
  note('declined', {});
}

/* ============================== play mode ============================== */

/* Hide the roam HUD (the mini-game owns the screen now) — remembering
   exactly what each element showed so exit restores it untouched. */
function hideRoamHud(){
  hiddenEls = [];
  for (var i = 0; i < HIDE_IDS.length; i++){
    var e = el(HIDE_IDS[i]);
    if (e){ hiddenEls.push({ el: e, display: e.style.display }); e.style.display = 'none'; }
  }
}
function restoreRoamHud(){
  for (var i = 0; i < hiddenEls.length; i++){
    try{ hiddenEls[i].el.style.display = hiddenEls[i].display; }catch(e){}
  }
  hiddenEls = [];
}

/* The shooting stance: at the shoot spot, facing the rim. */
function stancePose(){
  var s = built.shoot, r = built.rim;
  return { x: s.x, z: s.z, yaw: Math.atan2(r.x - s.x, r.z - s.z), gy: groundY(s.x, s.z) };
}

/* Court-side framing: behind + above + a step to the side of the
   shooter, looking at the rim — court, ball, and goal tree in frame. */
function applyCamera(){
  try{
    if (typeof camera === 'undefined') return;
    var st = stancePose(), r = built.rim;
    camera.up.set(0, 1, 0);
    camera.position.set(st.x + 2.8, st.gy + 3.6, st.z + 8.2);
    camera.lookAt(r.x, r.y - 0.3, r.z);
  }catch(e){}
}

function makeBall(){
  var m = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 14, 12),
    new THREE.MeshLambertMaterial({ color: COL_BALL }));
  m.frustumCulled = false;
  scene.add(m);
  return m;
}

/* Put the ball back on its spot in front of the shooter. */
function spotBall(){
  var st = stancePose();
  var fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
  ball.position.set(st.x + fx * BALL_FWD, groundY(st.x + fx * BALL_FWD, st.z + fz * BALL_FWD) + BALL_R, st.z + fz * BALL_FWD);
  ballVel.x = 0; ballVel.y = 0; ballVel.z = 0;
  ballState = 'ready';
}

function enterPlay(){
  if (!built) return;
  entry = { x: player.x, z: player.z, yaw: player.yaw };  // restored on exit
  progress.sessions++;
  saveProgress();
  mode = 'play';
  window.__bballActive = true;      // updateCamera() yields to this module
  var st = stancePose();
  player.x = st.x; player.z = st.z; player.yaw = st.yaw; player.speed = 0;
  if (player.mesh){ player.mesh.position.set(st.x, st.gy, st.z); player.mesh.rotation.y = st.yaw; }
  if (!ball) ball = makeBall();
  spotBall();
  ensureDom();
  hideRoamHud();
  dom.hud.classList.add('show');
  updateReadout();                   // shows the restored, saved total
  applyCamera();
  note('enter', { sessions: progress.sessions, baskets: progress.baskets });
}

function exitPlay(restore){
  if (mode !== 'play') return;
  mode = 'roam';
  armed = false;                     // re-arms once he steps off the court area
  window.__bballActive = false;
  if (ball){ try{ scene.remove(ball); }catch(e){} ball = null; }
  ballState = 'ready';
  restoreRoamHud();
  if (dom.hud) dom.hud.classList.remove('show');
  try{ if (typeof camera !== 'undefined') camera.up.set(0, 1, 0); }catch(e){}
  if (restore && entry){
    player.x = entry.x; player.z = entry.z; player.yaw = entry.yaw; player.speed = 0;
    if (player.mesh){ player.mesh.position.set(entry.x, groundY(entry.x, entry.z), entry.z); player.mesh.rotation.y = entry.yaw; }
  }
  entry = null;
  note('exit', { baskets: progress.baskets });
}

/* ============================== the stub play ============================== */

/* The universal ACTION button while playing. Called from the wrapped
   updateActionButton (the game's own act stands when not playing). */
function claimButton(btn){
  if (mode !== 'play') return;
  if (ballState === 'ready'){ btn.style.display = 'block'; btn.textContent = 'PICK UP BALL'; btn.dataset.act = 'bball'; }
  else if (ballState === 'held'){ btn.style.display = 'block'; btn.textContent = 'SHOOT'; btn.dataset.act = 'bball'; }
  else if (ballState === 'dead'){ btn.style.display = 'block'; btn.textContent = 'GET BALL'; btn.dataset.act = 'bball'; }
  else { btn.style.display = 'none'; btn.dataset.act = ''; }   // ball in the air
}

/* ACTION pressed (my own #action-btn listener; the game's handler
   ignores the unknown 'bball' act). */
function ballAction(){
  if (mode !== 'play' || !ball) return;
  if (ballState === 'ready'){
    ballState = 'held';
  } else if (ballState === 'held'){
    shoot();
  } else if (ballState === 'dead'){
    spotBall();
  }
}

/* Shoot: a simple parabolic arc from the player's hands through (or
   near) the rim centre. The flight time grows with distance; the small
   random spread is aimed AROUND the rim centre, so clean shots fall
   and off shots miss honestly — the basket is then DETECTED, not
   granted: the ball must cross the rim plane downward inside the ring. */
function shoot(){
  var st = stancePose(), r = built.rim;
  var fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
  var p0 = { x: st.x + fx * 0.45, y: st.gy + 1.35, z: st.z + fz * 0.45 };
  var tx = r.x + (Math.random() * 0.44 - 0.22);
  var tz = r.z + (Math.random() * 0.44 - 0.22);
  var dx = tx - p0.x, dz = tz - p0.z;
  var dist = Math.sqrt(dx * dx + dz * dz);
  var T = 0.8 + dist * 0.05;                       // time to reach the rim
  ballVel.x = dx / T;
  ballVel.z = dz / T;
  ballVel.y = (r.y - p0.y) / T + 0.5 * GRAVITY * T;
  ball.position.set(p0.x, p0.y, p0.z);
  ballScored = false;
  flyT = 0;
  ballState = 'flying';
}

/* Ball physics, one fixed sim step. Runs the held-ball follow, the
   flight (gravity, rim detection, ground bounce), and rest. */
function stepBall(dt){
  if (!ball) return;
  if (ballState === 'held'){
    var st = stancePose();
    var fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
    ball.position.set(st.x + fx * 0.45, st.gy + 1.35, st.z + fz * 0.45);
    return;
  }
  if (ballState !== 'flying') return;
  flyT += dt;
  var prevY = ball.position.y;
  ballVel.y -= GRAVITY * dt;
  ball.position.x += ballVel.x * dt;
  ball.position.y += ballVel.y * dt;
  ball.position.z += ballVel.z * dt;

  /* MADE BASKET detection: crossing the rim plane downward, inside
     the ring (rim radius 0.23 + the ball's own slack). Counted once,
     saved immediately — before the ball even lands. */
  var r = built.rim;
  if (!ballScored && ballVel.y < 0 && prevY > r.y && ball.position.y <= r.y){
    var ddx = ball.position.x - r.x, ddz = ball.position.z - r.z;
    if (Math.sqrt(ddx * ddx + ddz * ddz) < 0.27){
      ballScored = true;
      progress.baskets++;
      saveProgress();
      updateReadout();
      toast('Basket! 🏀  (' + progress.baskets + ' total)', 2400);
      note('basket', { baskets: progress.baskets });
    }
  }

  /* Ground: bounce with damping, then rest where it fell. */
  var gy = groundY(ball.position.x, ball.position.z) + BALL_R;
  if (ball.position.y <= gy){
    ball.position.y = gy;
    if (ballVel.y < -1.4){
      ballVel.y = -ballVel.y * 0.55;
      ballVel.x *= 0.7; ballVel.z *= 0.7;
    } else {
      ballVel.x = 0; ballVel.y = 0; ballVel.z = 0;
      ballState = 'dead';
    }
  }
  if (flyT > 6){ ballVel.x = 0; ballVel.y = 0; ballVel.z = 0; ballState = 'dead'; }
}

/* ============================== ticks ============================== */

/* Is the player inside the court area (for trigger re-arming)? */
function inRegion(x, z){
  var R = built.region;
  return x > R.x0 && x < R.x1 && z > R.z0 && z < R.z1;
}
function onFoot(){
  try{
    if (typeof player === 'undefined' || !player) return false;
    if (player.inside) return false;
    if (typeof car !== 'undefined' && car && car.driving) return false;
    if (player.ridingTrain || player.ridingBus || player.ridingSchoolBus) return false;
    return true;
  }catch(e){ return false; }
}

/* 'input' phase — runs before the sim steps sample the controls. In
   play mode the player is a spectator of his own shot: movement inputs
   are zeroed so the stance (pinned again in the sim tick) never drifts
   and the walk cycle never plays. */
function inputTick(){
  ticks.input++;
  if (mode !== 'play') return;
  try{
    if (typeof keys !== 'undefined' && keys){ keys['w'] = false; keys['a'] = false; keys['s'] = false; keys['d'] = false; }
  }catch(e){}
  try{
    if (typeof joy !== 'undefined' && joy){ joy.dx = 0; joy.dy = 0; }
  }catch(e){}
}

/* 'sim' phase — fixed 30 Hz: the gate trigger, the prompt's walk-away
   dismissal, play-mode pinning + abnormal-exit cleanup, ball physics. */
function simTick(dt){
  ticks.sim++;
  if (!built || typeof player === 'undefined' || !player) return;

  if (mode === 'roam'){
    if (!armed && !inRegion(player.x, player.z)) armed = true;
    if (armed && onFoot() && prevZ !== null){
      var g = built.gate;
      /* crossed the gate line south -> north, BETWEEN the two trees */
      if (prevZ >= g.z && player.z < g.z && player.x > g.x0 && player.x < g.x1){
        showPrompt();
      }
    }
  } else if (mode === 'prompt'){
    /* walked away from the gate instead of answering: same as No */
    var gg = built.gate;
    var dx = player.x - (gg.x0 + gg.x1) / 2, dz = player.z - gg.z;
    if (Math.sqrt(dx * dx + dz * dz) > 7) answerNo();
  } else if (mode === 'play'){
    /* abnormal exit: something else moved the player (teleport, zone
       reload, got in a car) — clean up WITHOUT yanking him back */
    if (player.inside || (typeof car !== 'undefined' && car && car.driving)){
      exitPlay(false);
    } else {
      var st = stancePose();
      player.x = st.x; player.z = st.z; player.yaw = st.yaw; player.speed = 0;
      stepBall((typeof dt === 'number' && dt > 0) ? dt : 1 / 30);
    }
  }
  prevZ = player.z;
}

/* 'render' phase — once per frame after render: the mini-game camera.
   (updateCamera() is yielded via __bballActive, so what this sets is
   what the next frame draws.) Also keeps the hero mesh glued to the
   stance between sim steps. */
function renderTick(){
  ticks.render++;
  if (mode !== 'play' || !built) return;
  applyCamera();
  try{
    var st = stancePose();
    if (player.mesh){ player.mesh.position.set(st.x, st.gy, st.z); player.mesh.rotation.y = st.yaw; }
  }catch(e){}
}

/* ============================== hooks + boot ============================== */

/* Wrap updateActionButton (interior_system.js pattern): the game
   computes its own act first; while playing, the ball claims it. */
function hookUpdateActionButton(){
  try{
    if (typeof window.updateActionButton !== 'function') return false;
    if (window.updateActionButton.__bballHooked) return true;
    var orig = window.updateActionButton;
    var wrapped = function(){
      orig();
      try{
        var btn = el('action-btn');
        if (btn) claimButton(btn);
      }catch(e){}
    };
    wrapped.__bballHooked = true;
    window.updateActionButton = wrapped;
    return true;
  }catch(e){ return false; }
}

/* Own click listener on #action-btn (registered after the game's, so
   for game actions the game's handler runs and this no-ops; for
   'bball' the game's handler no-ops and this handles it). */
function hookActionClick(){
  try{
    var btn = el('action-btn');
    if (!btn) return false;
    if (btn.__bballClickHooked) return true;
    btn.__bballClickHooked = true;
    btn.addEventListener('click', function(){
      var a = null;
      try{ a = btn.dataset.act; }catch(e){}
      if (a === 'bball'){ try{ ballAction(); }catch(e){ report('ballAction', e); } }
    });
    return true;
  }catch(e){ return false; }
}

function ready(){
  return typeof THREE !== 'undefined' && typeof scene !== 'undefined' &&
         typeof heightAt === 'function' &&
         typeof heroHouse !== 'undefined' && heroHouse &&
         typeof heroHouse.cx === 'number' &&
         typeof player !== 'undefined' && !!player &&
         typeof window.Sim !== 'undefined' && window.Sim &&
         typeof window.Sim.onTick === 'function' &&
         typeof document !== 'undefined' && !!document.body;
}

/* Boot: wait (bounded, politely) for the world to exist, then build
   the court, register the ticks, and hook the ACTION button. Any
   failure is FILED, never silent, and never stops the game. */
function boot(){
  if (booted) return;
  try{
    if (!ready()){
      bootTries++;
      if (bootTries === 150){   // ~60 s of polling: give up, but SAY so
        report('boot', new Error('game world never became ready — basketball court not built'));
        return;
      }
      setTimeout(boot, 400);
      return;
    }
    buildCourt();
    ensureDom();
    window.Sim.onTick('input', 5, inputTick);
    window.Sim.onTick('sim', 90, simTick);
    window.Sim.onTick('render', 90, renderTick);
    hookUpdateActionButton();
    hookActionClick();
    booted = true;
    note('ready', { baskets: progress.baskets, sessions: progress.sessions,
                   rim: { x: Math.round(built.rim.x), z: Math.round(built.rim.z) } });
  }catch(e){
    report('boot', e);
  }
}

/* ============================== public API ============================== */

window.BBALL = {
  version: '1.0.0',
  mode: function(){ return mode; },
  baskets: function(){ return progress.baskets; },
  sessions: function(){ return progress.sessions; },
  rim: function(){ return built ? { x: built.rim.x, y: built.rim.y, z: built.rim.z } : null; },
  court: function(){ return built ? { x: built.court.x, z: built.court.z, rx: PATCH_RX, rz: PATCH_RZ } : null; },
  gate: function(){ return built ? { z: built.gate.z, x0: built.gate.x0, x1: built.gate.x1 } : null; },
  yes: function(){ if (mode === 'prompt') answerYes(); },
  no: function(){ if (mode === 'prompt') answerNo(); },
  exit: function(){ exitPlay(true); },
  action: function(){ ballAction(); },
  ballState: function(){ return ballState; },
  _ticks: ticks
};

try{ boot(); }catch(e){ report('boot', e); }
})();
