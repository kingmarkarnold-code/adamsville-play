/* ============================================================================
   BLOB SHADOWS v1.0 (2026-10-11) — cheap grounding shadows for traffic
   vehicles, NPCs, and MARTA buses.
   Expert report #16 (Aria Nakamura, Technical Artist — 31 yrs, Joshua
   approved "Fix 16"): nothing in the game cast real shadows except the
   hero's feet blob. Real shadow mapping is far too expensive for the TCL
   T513V, so this implements the expert's prescribed approach instead:
     1. ONE shared radial-gradient blob texture (same recipe as the hero's
        foot shadow in index.html — soft dark ellipse fading to transparent).
     2. ONE InstancedMesh per category (traffic / NPC / MARTA bus) = exactly
        3 extra draw calls total, as the expert specified.
     3. Shadow offset direction + length + opacity derived per frame from
        the day-cycle sun position: long soft shadows morning/evening,
        short tight shadows at noon, faint moonlight blobs at night.
   Integration: reads sim positions (window.TRAFFIC slots, window.__npcSlots,
   window.MARTA_BUS buses) — never touches the other systems' render code.
   Registers on the central Sim tick registry ('render', priority 60, after
   daycycle's 40) per expert #14's rule — no animate() monkey-patching.
   Honors the launcher "Shadows" toggle (window.__launchOpts.shadows).
   ============================================================================ */
(function blobShadows(){
'use strict';

/* ---------------- capacities ---------------- */
/* Joshua's rule: document the why. Traffic streams max 40 rendered cars;
   one reserved slot carries the player's vehicle (exempt from the perf
   shadow budget under his always-fully-draws law, 2026-10-17 — it has no
   shadow otherwise: player.shadow hides while driving). NPC cap matches npc_system.js
   MAX_VISIBLE. Bus cap covers the 18 real MARTA routes + headroom. */
var CAP_TRAFFIC = 44;
var CAP_NPC     = 40;
var CAP_BUS     = 20;

/* Shadow footprint sizes (world units, quad is 1x1 pre-scaled). */
var CAR_W = 2.7, CAR_L = 5.6;    /* sedan-ish footprint + margin */
var VAN_W = 2.9, VAN_L = 5.8;    /* player's Safari van */
var NPC_W = 1.6, NPC_L = 1.6;    /* person blob, roughly circular */
var BUS_W = 3.1, BUS_L = 12.2;   /* MARTA bus footprint + margin */

var tex = null, mat = null;
var trafficIM = null, npcIM = null, busIM = null;
var _m = null, _q = null, _v = null, _s = null, _e = null;

/* Per-frame sun-derived shadow params (recomputed in computeSun()). */
var shDirX = 0, shDirZ = 1;   /* unit XZ vector: shadow fall direction */
var shOff  = 0.6;             /* center offset opposite the sun (world u) */
var shStretch = 0.8;          /* extra length when the sun is low */

/* ------------------------------------------------------------------ */
/* makeBlobTexture() — 64x64 canvas radial gradient, identical recipe
   to the hero foot shadow (index.html ~line 6700): solid-ish dark core
   fading to fully transparent at the rim. One texture shared by all
   three InstancedMeshes. */
function makeBlobTexture(){
  var cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  var g = cv.getContext('2d');
  var gr = g.createRadialGradient(32, 32, 4, 32, 32, 30);
  gr.addColorStop(0, 'rgba(0,0,0,0.42)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

/* ------------------------------------------------------------------ */
/* computeSun() — derive shadow direction/length/opacity from the day
   cycle clock. Mirrors daycycle.js sun math (az = PI*(1-dayT) east->west,
   el = sin(dayT*PI) 0 at horizon -> 1 at noon) so blobs agree with the
   directional light. At night the moon is near-overhead: short faint
   blobs rather than none (moonlight does cast shadows). */
function computeSun(){
  var gm = 720; /* noon fallback if daycycle is absent/opted out */
  try{ if (window.__daycycle && isFinite(window.__daycycle.gameMin)) gm = window.__daycycle.gameMin; }catch(e){}
  var SUNRISE = 360, SUNSET = 1200; /* 06:00 / 20:00, matches daycycle.js */
  var isDay = gm >= SUNRISE && gm <= SUNSET;
  if (isDay){
    var dayT = Math.min(1, Math.max(0, (gm - SUNRISE) / (SUNSET - SUNRISE)));
    var el = Math.sin(dayT * Math.PI);
    var az = Math.PI * (1 - dayT);
    /* Sun offset direction (daycycle.js): x ~ cos(az), z ~ 0.23+0.16*sin(az).
       Shadow falls opposite. */
    var sx = Math.cos(az), sz = 0.23 + 0.16 * Math.sin(az);
    var sl = Math.sqrt(sx*sx + sz*sz) || 1;
    shDirX = -sx / sl; shDirZ = -sz / sl;
    shStretch = 0.4 + 1.8 * (1 - el);   /* long at dawn/dusk, stubby at noon */
    shOff     = 0.25 + 0.85 * (1 - el);
    try{ mat.opacity = 0.30 + 0.18 * el; }catch(e){}
  } else {
    /* Moonlight: near overhead, faint. */
    shDirX = 0.2; shDirZ = 0.97;
    shStretch = 0.5; shOff = 0.25;
    try{ mat.opacity = 0.12; }catch(e){}
  }
}

/* ------------------------------------------------------------------ */
/* putShadow(im, i, x, y, z, yaw, w, l) — write one blob instance.
   Quad keeps the OBJECT's yaw (a car's shadow stays car-shaped) and is
   nudged opposite the sun with extra length when the sun is low. +0.06u
   lift avoids z-fighting the ground/road surface. */
function putShadow(im, i, x, y, z, yaw, w, l){
  _e.set(0, yaw || 0, 0); _q.setFromEuler(_e);
  _v.set(x + shDirX * shOff, y + 0.06, z + shDirZ * shOff);
  _s.set(w + shStretch * 0.35, 1, l + shStretch);
  _m.compose(_v, _q, _s);
  im.setMatrixAt(i, _m);
}

/* ------------------------------------------------------------------ */
/* update() — the per-frame tick. Reads sim positions only (never the
   other systems' instance matrices), so tick order vs traffic/npc/marta
   does not matter. */
function update(){
  if (!trafficIM) return;
  computeSun();
  var on = (!window.__launchOpts || window.__launchOpts.shadows !== false);
  /* EXPERT #42 (Dr. Elena Vasquez, Engine Programmer — Joshua approved "Fix
     42"): perf budget can limit shadow distance. window.__perfShadowDist is
     null at full quality (all shadows), 0 to disable, or a max distance in
     world units. Player position from the global `player` object. */
  var shMaxD2 = 1e18, px = 0, pz = 0, hasP = false, perfOff = false;
  try {
    var _psd = window.__perfShadowDist;
    if (_psd !== null && _psd !== undefined) {
      if (_psd <= 0) { perfOff = true; shMaxD2 = -1; }
      else shMaxD2 = _psd * _psd;
    }
    if (typeof player !== 'undefined' && player) { px = player.x || 0; pz = player.z || 0; hasP = true; }
  } catch(e){}
  /* PLAYER'S VEHICLE EXEMPTION (Joshua's law, 2026-10-17: the player's
     vehicle always fully draws): a perf "shadows off" level no longer
     returns early here. perfOff makes the range test below fail for every
     traffic/NPC/bus shadow (shMaxD2=-1 plus the explicit perfOff check in
     shInRange), while trafficIM stays visible so the player's vehicle
     slot — written unconditionally in the traffic pass below — still
     draws his vehicle's shadow at EVERY quality level. */
  trafficIM.visible = on; npcIM.visible = on && !perfOff; busIM.visible = on && !perfOff;
  if (!on) return;

  var s, ci, c, n, b, i;
  /* Distance filter helper: true if (x,z) is within the perf shadow range. */
  function shInRange(x, z){
    if (perfOff) return false;   /* perf shadows off: nothing is in range (the player's vehicle slot below never consults this test) */
    if (!hasP || shMaxD2 > 1e17) return true;
    var dx = x - px, dz = z - pz;
    return (dx*dx + dz*dz) <= shMaxD2;
  }

  /* --- traffic vehicles (window.TRAFFIC slots) --- */
  var ti = 0;
  try{
    var TR = window.TRAFFIC;
    if (TR && TR.slots && TR.cars){
      var nSlots = Math.min(TR.slots.length, 40);
      for (s = 0; s < nSlots; s++){
        ci = TR.slots[s];
        if (ci >= 0 && TR.cars[ci]){
          c = TR.cars[ci];
          if (isFinite(c.x) && isFinite(c.y) && isFinite(c.z) && shInRange(c.x, c.z)){
            putShadow(trafficIM, ti++, c.x, c.y, c.z, c.heading || 0, CAR_W, CAR_L);
          }
        }
      }
    }
    /* Player's vehicle (Joshua's law, 2026-10-17: the player's vehicle
       always fully draws — shadow included): this reserved slot is EXEMPT
       from the perf shadow budget. It is written at every quality level
       (even when perfOff has switched every other blob shadow off), at
       any distance (no shInRange test), and whether he is driving the
       vehicle or has parked it and walked away. player.shadow hides
       while driving, so without this slot the driven vehicle would cast
       nothing at all. Footprint matches the vehicle kind. */
    if (ti < CAP_TRAFFIC && typeof car !== 'undefined' && car && car.mesh){
      var p = car.mesh.position;
      if (isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) {
        var _pvVan = (car.kind === 'safari');
        putShadow(trafficIM, ti++, p.x, p.y, p.z, car.yaw || 0, _pvVan ? VAN_W : CAR_W, _pvVan ? VAN_L : CAR_L);
      }
    }
  }catch(e){}
  trafficIM.count = ti;
  trafficIM.instanceMatrix.needsUpdate = true;

  /* --- NPC pedestrians (window.__npcSlots, exposed by npc_system.js) --- */
  var ni = 0;
  try{
    if (!window.__launchOpts || window.__launchOpts.npcs !== false){
      var NS = window.__npcSlots;
      if (NS && NS.length){
        var nMax = Math.min(NS.length, CAP_NPC);
        for (s = 0; s < nMax; s++){
          n = NS[s];
          if (n && isFinite(n.x) && isFinite(n.y) && isFinite(n.z) && shInRange(n.x, n.z)){
            putShadow(npcIM, ni++, n.x, n.y, n.z, 0, NPC_W, NPC_L);
          }
        }
      }
    }
  }catch(e){}
  npcIM.count = ni;
  npcIM.instanceMatrix.needsUpdate = true;

  /* --- MARTA buses (window.MARTA_BUS) --- */
  var bi = 0;
  try{
    var MB = window.MARTA_BUS;
    if (MB && MB.ready && MB.buses && MB.buses.length){
      var bMax = Math.min(MB.buses.length, CAP_BUS);
      for (i = 0; i < bMax; i++){
        b = MB.buses[i];
        if (b && b.mesh && isFinite(b.x) && isFinite(b.z) && shInRange(b.x, b.z)){
          var by = b.mesh.position.y;
          if (isFinite(by)){
            putShadow(busIM, bi++, b.x, by, b.z, b.yaw || 0, BUS_W, BUS_L);
          }
        }
      }
    }
  }catch(e){}
  busIM.count = bi;
  busIM.instanceMatrix.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* init() — build the shared texture/material and the three instanced
   meshes. frustumCulled=false: each mesh spans the whole map, and three
   r128 would cull it as a tiny sphere at the origin (same v1.17 lesson
   as the bus-stop signs). renderOrder=2 draws blobs right after the
   opaque ground so they sit cleanly on terrain/roads. */
function init(){
  tex = makeBlobTexture();
  mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  var geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2); /* lie flat, facing up; per-instance yaw then works */
  trafficIM = new THREE.InstancedMesh(geo, mat, CAP_TRAFFIC);
  npcIM     = new THREE.InstancedMesh(geo, mat, CAP_NPC);
  busIM     = new THREE.InstancedMesh(geo, mat, CAP_BUS);
  var ims = [trafficIM, npcIM, busIM], k;
  for (k = 0; k < ims.length; k++){
    ims[k].frustumCulled = false;
    ims[k].renderOrder = 2;
    ims[k].count = 0;
    scene.add(ims[k]);
  }
  _m = new THREE.Matrix4(); _q = new THREE.Quaternion();
  _v = new THREE.Vector3();  _s = new THREE.Vector3();
  _e = new THREE.Euler();
  /* Register on the central tick registry (expert #14 pattern): 'render'
     phase, priority 60 — after daycycle (40) so the clock has advanced. */
  try{
    if (window.Sim && typeof window.Sim.onTick === 'function' && !window.__blobTickReg){
      window.__blobTickReg = true;
      window.Sim.onTick('render', 60, function(){ try{ update(); }catch(e){} });
    }
  }catch(e){}
  try{ if (typeof Report !== 'undefined' && Report.setSys) Report.setSys('blobshadows', 'ok', 'instanced blob shadows live (3 draw calls)'); }catch(e){}
}

/* ---------------- boot poll ---------------- */
/* Deferred scripts load after launcher confirmation; scene/THREE/Sim come
   from index.html block 1. Poll until they exist (900 x 500ms cap, same
   as daycycle.js). */
var _tries = 0;
(function boot(){
  _tries++;
  var ok = (typeof THREE !== 'undefined' && typeof scene !== 'undefined' &&
            typeof window !== 'undefined' && window.Sim &&
            typeof document !== 'undefined');
  if (ok){
    try{ init(); }
    catch(e){ try{ if (typeof console !== 'undefined') console.warn('[blob_shadows] init failed', e); }catch(e2){} }
    return;
  }
  if (_tries < 900) setTimeout(boot, 500);
})();

})();
