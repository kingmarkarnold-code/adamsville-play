/* ============================================================================
   FILE: basketball_court.js — BACKYARD BASKETBALL, the in-world court (v1.2)
   ----------------------------------------------------------------------------
   JOSHUA'S DESIGN (2026-10-17, hand sketch via the Draw-for-Mollie channel
   + his words): "This is the beginning of the mini-game. It's a basketball
   court, in the backyard of 535. The orange is the tree with the basketball
   goal. When you walk in between the trees in the game it should say do
   you want to play a game."

   His sketch: a curved line with trees along it, and ONE distinct orange
   tree standing on the curve. His corrections, same evening:
     1. The court surface is DIRT — a bare-earth patch in the backyard.
        The curved line in the sketch is the dirt patch's EDGE (where the
        dirt ends and the grass begins), not a painted marking.
     2. NO VISIBLE LINES — no painted court lines of any kind.
     3. The mini-game itself STARTS AS A WEB PLAYER: the standalone
        player page — detailed/basketball.html (same Pages origin, so
        the saved progress in localStorage is shared). Modes
        ("1 on 1" / "3 on 3" — Joshua) are chosen on the page.
     4. (v1.2, Joshua 2026-10-18) THE PLAY MOVES IN GAME: answering Yes
        now opens that same player page FULL SCREEN *inside* the game —
        a full-viewport overlay hosting basketball.html in an iframe —
        so he can test the mini-game without leaving the world. The
        world PAUSES behind it in the game's own pause terms
        (window.GamePause), the player's keys are cleared so nothing
        walks behind the overlay, and closing the mini-game (its own
        leave flow, or its close control) removes the overlay and hands
        the world back with the player standing exactly where he was.
        The standalone page is untouched and behaves as before.

   WHAT THIS MODULE OWNS (the world side):
   - THE COURT: an elliptical dirt patch in the backyard of the hero
     house (535 Dollar Mill Rd), behind the house (north side), built
     with the hero-house code path: plain meshes added to the scene at
     build time, draped over the real terrain via heightAt(). No zone
     data is touched, nothing is painted on the dirt.
   - THE GOAL TREE: one bigger pine at the far (north) arc of the patch,
     carrying a backboard + rim + net on its trunk, facing the court at
     regulation height (rim 3.05 m above its own ground). Two pines
     flank the south entrance (the way in from the back door); more
     pines stand along the arc, as in the sketch. Every trunk gets a
     collider that matches its visible size (addCollider -> propGrid),
     exactly like the hero house's own yard pines.
   - THE TRIGGER: walking on foot between the two entrance trees (south
     -> north across the gate line) shows the prompt: "Do you want to
     play a game?" [Yes] [No]. Yes opens the mini-game in game (the
     full-screen overlay above). No dismisses and the prompt stays
     away until the player leaves the court area and walks in again.

   PROGRESS (Joshua): the mini-game saves the player's progress in
   localStorage 'sa.basketball.v1' — lifetime baskets, sessions, and
   the last mode played ("1 on 1" / "3 on 3"). The player page writes
   it (on every made basket, the moment it happens); this module only
   READS it, so BBALL.baskets() always reports the shared saved total.
   Game data files are never touched.

   FAILURE PHILOSOPHY (Joshua): init is wrapped in try/catch and any
   failure is filed through SA_CRASH (the crash-report queue) — never
   silent, never a hard stop of the game. Every external access (THREE,
   scene, heroHouse, Sim, DOM, storage) is guarded; if anything vital
   is missing the module reports and stays inert.

   HOOKS: the Sim tick registry only ('sim' phase — the gate trigger),
   plus a window 'message' listener that exists solely to hear the
   mini-game overlay ask to close (validated by sender identity).
   No camera or action-button hooks: the play itself lives on the
   player page, hosted by the overlay.

   PUBLIC API (window.BBALL): version, mode(), baskets(), sessions(),
   lastMode(), rim(), court(), gate(), yes(), no(), playerUrl(),
   closeGame(), gameOpen(), and _ticks (registration proof counters
   for the test harness).
   ============================================================================ */
(function(){
'use strict';
if (window.BBALL) return;  // single instance guard

/* ============================== constants ============================== */

/* Save key — versioned, local-only, in the game's 'sa.<thing>.v1' style.
   SHARED with the player page (same Pages origin = same localStorage). */
var SAVE_KEY = 'sa.basketball.v1';

/* The mini-game's own player page, relative to detailed/ (this file's
   home). Same origin as the game page, so progress carries over. */
var PLAYER_URL = 'basketball.html';

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
var COL_ARM       = 0x333333;   // mounting arm

/* ============================== state ============================== */

var booted   = false;   // court built + tick registered
var bootTries = 0;      // bounded boot polling (see boot())
var mode     = 'roam';  // 'roam' | 'prompt'  (play lives on the player page)
var armed    = true;    // gate trigger armed (re-arms outside the court area)
var prevZ    = null;    // player's z last sim tick (crossing detection)
var built    = null;    // {court, rim, gate, region} world-space geometry

/* Progress — READ from localStorage (the player page owns the writes).
   Read fresh on each API call so a total earned on the page is never
   stale here after a return trip. */
var ticks = { sim: 0 };   // tick-run proof counter

/* DOM refs (built lazily by ensureDom / ensureGameDom). */
var dom = { prompt: null, overlay: null, frame: null };

/* In-game mini-game state (v1.2): is the overlay up, and was the world
   already paused when it opened (so closing restores exactly that)? */
var gameOpen = false;
var wasPausedBeforeGame = false;

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

/* ============================== progress (read side) ============================== */

/* Read the saved progress the player page maintains. Anything
   unreadable -> a zeroed record (the page rewrites it on its next
   save). Never written from here: one writer (the page), no races. */
function loadProgress(){
  var fresh = { v: 1, baskets: 0, sessions: 0, lastMode: '' };
  try{
    if (typeof localStorage === 'undefined') return fresh;
    var raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return fresh;
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return fresh;
    fresh.baskets  = Math.max(0, parseInt(p.baskets, 10) || 0);
    fresh.sessions = Math.max(0, parseInt(p.sessions, 10) || 0);
    if (p.lastMode === '1on1' || p.lastMode === '3on3') fresh.lastMode = p.lastMode;
    return fresh;
  }catch(e){
    return fresh;
  }
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
   Returns the rim centre in world space. (The playable hoop lives on
   the player page; this one is the landmark the page mirrors.) */
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
     "line" on this court (Joshua: dirt, no painted lines) */
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
    gate: { z: hz + GATE_Z_OFF, x0: hx - GATE_HALF_X, x1: hx + GATE_HALF_X },
    /* court area for re-arming the gate trigger (a touch larger than
       the dirt, so stepping off the patch counts as leaving) */
    region: { x0: hx - 8.5, x1: hx + 8.5, z0: hz - 30.5, z1: hz - 9.8 }
  };
  return built;
}

/* ============================== DOM (the invitation prompt) ============================== */

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
    '#bball-no{background:#4a4a4a;color:#eee;}';
  document.head.appendChild(style);

  var prompt = document.createElement('div');
  prompt.id = 'bball-prompt';
  var panel = document.createElement('div');
  panel.id = 'bball-panel';
  var q = document.createElement('p');
  q.className = 'q';
  q.textContent = 'Do you want to play a game?';
  var sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = '🏀 Basketball at the goal tree — opens the basketball game';
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

  dom.prompt = prompt;
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
/* Yes: open the mini-game IN GAME (v1.2) — the player page hosted in
   a full-screen overlay, the world paused behind it. Same Pages
   origin, so the saved progress (sa.basketball.v1) is shared. */
function answerYes(){
  hidePrompt();
  mode = 'roam';
  armed = false;
  openGame();
}
function answerNo(){
  hidePrompt();
  mode = 'roam';
  armed = false;   // don't re-ask until he leaves the court area
  note('declined', {});
}

/* ====================== the in-game mini-game overlay ====================== */
/* v1.2 (Joshua, 2026-10-18): the mini-game plays WITHOUT leaving the
   game page. The overlay is one full-viewport layer above every game
   surface (z-index 99995 — only the crash-report window at 99999 sits
   higher, deliberately, so a critical error can still reach him) and
   hosts basketball.html in an iframe. Same origin, so the page reads
   the same localStorage progress as the standalone tab, and this
   module can hear its close request. */

function ensureGameDom(){
  if (dom.overlay) return;
  var style = document.createElement('style');
  style.textContent =
    '#bball-overlay{position:fixed;inset:0;display:none;z-index:99995;background:#10131c;}' +
    '#bball-overlay.show{display:block;}' +
    '#bball-overlay iframe{width:100%;height:100%;border:0;display:block;background:#10131c;}';
  document.head.appendChild(style);

  var overlay = document.createElement('div');
  overlay.id = 'bball-overlay';
  var frame = document.createElement('iframe');
  frame.id = 'bball-frame';
  frame.title = 'Basketball — 535 Backyard Court';
  frame.setAttribute('aria-label', 'Basketball mini-game');
  /* Focus follows the frame as soon as its page is in, so the
     mini-game's keys (and gamepad) work the moment it appears. */
  frame.addEventListener('load', function(){
    try{ if (gameOpen && frame.contentWindow) frame.contentWindow.focus(); }catch(e){}
  });
  overlay.appendChild(frame);
  document.body.appendChild(overlay);

  dom.overlay = overlay;
  dom.frame = frame;
}

/* Release any movement keys the world is holding. The world reads
   window.keys / window.drive (the v1.64 published pair); if the
   player walks into the gate holding a key and that key's release
   lands inside the mini-game's frame instead, the world would keep
   the key "down" forever and walk on its own when play resumes.
   Clearing on open AND on close makes a stuck key impossible. Only
   boolean entries are touched — drive's numeric channels are left
   exactly as they are. */
function clearGameKeys(){
  try{
    if (window.keys){ for (var k in window.keys) if (typeof window.keys[k] === 'boolean') window.keys[k] = false; }
  }catch(e){}
  try{
    if (window.drive){ for (var d in window.drive) if (typeof window.drive[d] === 'boolean') window.drive[d] = false; }
  }catch(e){}
}

/* Open the mini-game over the world: pause the world in the game's
   own terms (window.GamePause — music holds its place, sim steps
   stop), clear held keys, then load the page and show the layer.
   The player himself is never moved: he stays standing at the gate. */
function openGame(){
  ensureGameDom();
  if (gameOpen) return;
  gameOpen = true;
  wasPausedBeforeGame = false;
  try{
    if (window.GamePause && typeof window.GamePause.isPaused === 'function')
      wasPausedBeforeGame = !!window.GamePause.isPaused();
  }catch(e){}
  try{
    if (window.GamePause && typeof window.GamePause.setPaused === 'function')
      window.GamePause.setPaused(true);
  }catch(e){ report('pauseWorld', e); }
  clearGameKeys();
  try{ dom.frame.src = PLAYER_URL; }catch(e){ report('openGame', e); }
  dom.overlay.classList.add('show');
  note('open-ingame', { url: PLAYER_URL });
}

/* Close the mini-game and hand the world back: unload the frame (the
   mini-game fully leaves memory — the suite's single-residency rule),
   hide the layer, and resume the world unless it was already paused
   before the game opened. Idempotent: a duplicate close request is
   a no-op. */
function closeGame(){
  if (!gameOpen) return;
  gameOpen = false;
  try{ if (dom.frame) dom.frame.src = 'about:blank'; }catch(e){}
  if (dom.overlay) dom.overlay.classList.remove('show');
  clearGameKeys();
  try{
    if (window.GamePause && typeof window.GamePause.setPaused === 'function' && !wasPausedBeforeGame)
      window.GamePause.setPaused(false);
  }catch(e){ report('resumeWorld', e); }
  try{ window.focus(); }catch(e){}
  note('close-ingame', {});
}

/* The mini-game asks to close (its leave flow / close control) with a
   postMessage. The sender must be OUR frame — identity, not origin
   strings, so nothing else on the page can fake the request. */
window.addEventListener('message', function(ev){
  try{
    if (!gameOpen || !dom.frame) return;
    if (ev.source !== dom.frame.contentWindow) return;
    if (ev.data && ev.data.type === 'bball-close') closeGame();
  }catch(e){}
});

/* ============================== the gate trigger ============================== */

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

/* 'sim' phase — fixed 30 Hz: the gate trigger + the prompt's
   walk-away dismissal. That is all the world side needs per-tick;
   the play itself lives on the player page. */
function simTick(){
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
  }
  prevZ = player.z;
}

/* ============================== boot ============================== */

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
   the court and register the trigger tick. Any failure is FILED,
   never silent, and never stops the game. */
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
    window.Sim.onTick('sim', 90, simTick);
    booted = true;
    var p = loadProgress();
    note('ready', { baskets: p.baskets, sessions: p.sessions, lastMode: p.lastMode,
                    rim: { x: Math.round(built.rim.x), z: Math.round(built.rim.z) } });
  }catch(e){
    report('boot', e);
  }
}

/* ============================== public API ============================== */

window.BBALL = {
  version: '1.2.0',
  mode: function(){ return mode; },
  baskets: function(){ return loadProgress().baskets; },
  sessions: function(){ return loadProgress().sessions; },
  lastMode: function(){ return loadProgress().lastMode; },
  rim: function(){ return built ? { x: built.rim.x, y: built.rim.y, z: built.rim.z } : null; },
  court: function(){ return built ? { x: built.court.x, z: built.court.z, rx: PATCH_RX, rz: PATCH_RZ } : null; },
  gate: function(){ return built ? { z: built.gate.z, x0: built.gate.x0, x1: built.gate.x1 } : null; },
  yes: function(){ if (mode === 'prompt') answerYes(); },
  no: function(){ if (mode === 'prompt') answerNo(); },
  playerUrl: function(){ return PLAYER_URL; },
  /* v1.2: the in-game overlay — the mini-game page can also call
     closeGame() directly (same origin), as a fallback to its
     postMessage. gameOpen() lets tests (and the page) see the state. */
  closeGame: function(){ closeGame(); },
  gameOpen: function(){ return gameOpen; },
  _ticks: ticks
};

try{ boot(); }catch(e){ report('boot', e); }
})();
