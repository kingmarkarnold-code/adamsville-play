/* ============================================================================
   interior_system.js -- Interior interaction system for Surviving Adamsville
   ----------------------------------------------------------------------------
   v1 implements:
     1. Interior doors: open/close with a 0.5s swing animation (~100 degrees).
        Closed doors block the player; open doors don't.
     2. Furniture collision: axis-aligned bounding boxes (AABB) that push the
        player out (slide along walls). Exposed as window.InteriorCollision.
     3. Appliance interactions via the universal action button: sink, stove,
        fridge (Web-Audio sound effects, no external files), bed (sleep with
        fade-to-black), closet (wardrobe via window.ClothingSystem).
     4. Small-object pickup: "PICK UP [name]" -> window.PlayerInventory + toast.
     5. Proximity scan throttled to ~200ms; only runs while player.inside.

   NON-INVASIVE HOOKS (no index.html edits except the script tag itself):
     - Wraps window.updateActionButton: the game decides its own button first;
       this system then overrides it ONLY when an interior target (door /
       appliance / pickupable) is in range while player.inside is true.
     - Wraps window.resolveCollision: after the game's own collision pass,
       applies interior AABB push-out for the player, indoors only.
     - Adds its own 'click' listener on #action-btn. The game's own click
       handler ignores unknown action names (its if/else chain has no
       default else), and this listener only reacts to the action names
       below, so existing game actions are untouched.
     - OPTIONAL one-line index.html integration (not required): as the first
       line of the actionBtn click listener, add:
         if (window.InteriorSystem && window.InteriorSystem.handleAction(actionBtn.dataset.act)) return;
       handleAction() returns true when it consumed the action.

   Building data shapes (passed to the register* APIs; building_spawner.js
   should call these for every walkable building it places):
     building = {
       id: 'house-1',                    // any unique string (optional)
       doors: [                          // interior doors (room-to-room)
         { x, z,                         // hinge position (world units)
           face: 'N'|'S'|'E'|'W',        // which wall the door sits in
           angle: <radians>,             // ...or explicit yaw (wins over face)
           width: 1.2, height: 2.2,      // panel size (optional)
           color: 0x8a5a2b,              // panel color (optional)
           swing: 1 | -1 }               // swing direction (optional)
       ],
       appliances: [                     // {type, x, z}
         { type: 'sink'|'stove'|'fridge'|'bed'|'closet', x, z }
       ],
       furniture: [                      // solid AABB footprints
         { x, z, w, d }                  // center + width/depth
       ],
       pickupables: [                    // small takeable objects
         { name: 'Wrench', x, z }
       ],
       items: [                          // alternate shape (task spec):
         { pickupable: true, name: 'Wrench', x, z }
       ]
     }
   If window.WalkableBuildings exists (array, or {buildings:[...]}), its
   entries are auto-registered on a 2s poll (each entry only once).

   Action names placed on the universal button (none collide with the game's
   existing actions): 'open-door', 'close-door', 'use-sink', 'use-stove',
   'open-fridge', 'sleep', 'get-up', 'change-clothes', 'pickup-item'.

   Defensive coding: every cross-system call (showToast, THREE, scene,
   ClothingSystem, WalkableBuildings, AudioContext) is typeof-guarded, so
   this file is safe to load before or after any of those exist.
   ========================================================================== */
(function(){
'use strict';

/* --------------------------------------------------------------------------
   0. Small utilities
   -------------------------------------------------------------------------- */

/* toast(msg, ms) -- notification helper. Uses the game's showToast() when it
   exists; silently does nothing before the game has defined it. */
function toast(msg, ms){
  try{ if (typeof showToast === 'function') showToast(msg, ms); }catch(e){}
}

/* getActionBtn() -- cached lookup of the universal action button element. */
var _actionBtn = null;
function getActionBtn(){
  if (_actionBtn) return _actionBtn;
  try{ _actionBtn = document.getElementById('action-btn'); }catch(e){ _actionBtn = null; }
  return _actionBtn;
}

/* dist2(x1,z1,x2,z2) -- 2D world distance. The interior scan is XZ-only;
   floor separation is handled by the game's own floor-aware colliders. */
function dist2(x1, z1, x2, z2){
  var dx = x1 - x2, dz = z1 - z2;
  return Math.sqrt(dx*dx + dz*dz);
}

/* NOTE ON SCOPE: every door / appliance / pickupable / collision box is
   stored at its WORLD position, so only entries near the player can ever
   affect them -- two interiors never share world space, which makes extra
   buildingId filtering unnecessary in v1 (and a strict filter would silently
   disable entries whose id doesn't match the game's interior ids). The
   buildingId is still recorded on every entry for future spawner use
   (e.g. unloading one building's interiors) and shows up in the list()
   accessors for debugging. */

/* --------------------------------------------------------------------------
   1. Registries + tuning constants
   -------------------------------------------------------------------------- */
var doorSeq = 0;        // unique id counter for doors
var doors = [];         // interior door records (see createDoor below)
var applSeq = 0;        // unique id counter for appliances
var appliances = [];    // {id,type,x,z,buildingId}
var pickSeq = 0;        // unique id counter for pickupables
var pickupables = [];   // {id,name,x,z,buildingId,mesh}
var boxSeq = 0;         // unique id counter for collision boxes
var boxes = [];         // AABB records {id,minX,maxX,minZ,maxZ,buildingId}

var sleepState = { asleep: false }; // true after sleeping, until Get Up

var SCAN_MS = 200;        // proximity scan throttle (spec: ~200ms, not per-frame)
var DOOR_RADIUS = 3;      // door prompt range (spec: < 3 units)
var APPLIANCE_RADIUS = 3; // appliance prompt range (spec: within 3 units)
var PICKUP_RADIUS = 2.5;  // pickup prompt range (spec: within 2.5 units)
var DOOR_SWING = 100 * Math.PI / 180; // open angle ~100 degrees (spec)
var DOOR_ANIM_T = 0.5;    // swing animation duration, seconds (spec)

/* --------------------------------------------------------------------------
   2. window.InteriorCollision -- furniture AABB collision API
   -------------------------------------------------------------------------- */

/* checkCollision(x, z) -- spec API: true when the point (x,z) is inside ANY
   registered box. */
function checkCollision(x, z){
  for (var i = 0; i < boxes.length; i++){
    var b = boxes[i];
    if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return true;
  }
  return false;
}

/* resolvePlayer(p, radius) -- circle-vs-AABB push-out so the player slides
   along furniture instead of stopping dead. Called from the wrapped
   resolveCollision() after the game's own pass. Two iterations for
   stability, mirroring the game's own resolveCollision loop. */
function resolvePlayer(p, radius){
  var r = radius || 0.5;
  for (var iter = 0; iter < 2; iter++){
    for (var i = 0; i < boxes.length; i++){
      var b = boxes[i];
      // Closest point on the box to the player center.
      var cx = p.x < b.minX ? b.minX : (p.x > b.maxX ? b.maxX : p.x);
      var cz = p.z < b.minZ ? b.minZ : (p.z > b.maxZ ? b.maxZ : p.z);
      var dx = p.x - cx, dz = p.z - cz;
      var d2 = dx*dx + dz*dz;
      if (d2 < r*r){
        if (d2 > 1e-8){
          // Overlapping but outside: push straight out (slides along the face).
          var d = Math.sqrt(d2), push = (r - d) / d;
          p.x += dx * push; p.z += dz * push;
        } else {
          // Center is inside the box: eject along smallest-penetration axis.
          var pl = p.x - b.minX, pr = b.maxX - p.x;
          var pt = p.z - b.minZ, pb = b.maxZ - p.z;
          var m = Math.min(pl, pr, pt, pb);
          if (m === pl) p.x = b.minX - r;
          else if (m === pr) p.x = b.maxX + r;
          else if (m === pt) p.z = b.minZ - r;
          else p.z = b.maxZ + r;
        }
      }
    }
  }
}

/* The public collision API (spec section 2). addBox returns the box id so
   the caller (e.g. the door system) can remove it later. */
window.InteriorCollision = {
  /* addBox(box) -- box = {minX,maxX,minZ,maxZ[,id][,buildingId]}. */
  addBox: function(box){
    if (!box) return null;
    box.id = box.id || ('ibox' + (++boxSeq));
    boxes.push(box);
    return box.id;
  },
  /* removeBox(id) -- unregister one box; no-op when the id is unknown. */
  removeBox: function(id){
    for (var i = 0; i < boxes.length; i++){
      if (boxes[i].id === id){ boxes.splice(i, 1); return true; }
    }
    return false;
  },
  /* checkCollision(x, z) -- spec point test. */
  checkCollision: checkCollision,
  /* resolvePlayer(p, radius) -- push-out used by the movement hook. */
  resolvePlayer: resolvePlayer,
  /* list() -- snapshot for debugging / the watcher. */
  list: function(){ return boxes.slice(); }
};

/* --------------------------------------------------------------------------
   3. Interior doors (open/close)
   -------------------------------------------------------------------------- */

/* yawFromDef(def) -- base yaw of the door panel. The panel extends along the
   group's local +X axis from the hinge at the group origin. An explicit
   def.angle (radians) wins; otherwise the face maps to a wall direction:
   'N'/'S' walls run east-west (panel along world X, yaw 0), 'E'/'W' walls
   run north-south (panel along world Z, yaw PI/2). */
function yawFromDef(def){
  if (def && typeof def.angle === 'number') return def.angle;
  var f = def && def.face ? String(def.face).toUpperCase() : 'N';
  return (f === 'E' || f === 'W') ? Math.PI / 2 : 0;
}

/* doorFloorY(def) -- the Y the door group sits at. Prefers an explicit
   def.y, then the player's feet (player.mesh.position.y is pinned to the
   floor every frame by updatePlayer), then 0. */
function doorFloorY(def){
  if (def && typeof def.y === 'number') return def.y;
  try{
    if (typeof player !== 'undefined' && player && player.mesh) return player.mesh.position.y;
  }catch(e){}
  return 0;
}

/* createDoor(def, buildingId) -- builds one door record:
     {id, mesh, group, isOpen, position:{x,z}, swingAngle, baseYaw,
      swingDir, width, height, buildingId, colliderId,
      animT, animFrom, animTo}
   The mesh is a THREE.Group hinged at the door's (x,z): the panel mesh is
   offset by half its width so rotation.y swings it like a real hinged door.
   When THREE/scene are unavailable the record is still created (data-only)
   so proximity + collision keep working. */
function createDoor(def, buildingId){
  var door = {
    id: 'door' + (++doorSeq),
    mesh: null, group: null,
    isOpen: false,
    position: { x: def.x, z: def.z },
    swingAngle: 0,                       // current animated swing (radians)
    baseYaw: yawFromDef(def),
    swingDir: (def.swing === -1) ? -1 : 1,
    width: def.width || 1.2,
    height: def.height || 2.2,
    buildingId: buildingId || def.buildingId || null,
    colliderId: null,
    animT: 0, animFrom: 0, animTo: 0      // animation bookkeeping
  };
  // Visual: panel + knob, hinged at the group origin. typeof-guarded so the
  // logic works even if THREE failed to load.
  try{
    if (typeof THREE !== 'undefined'){
      var g = new THREE.Group();
      g.position.set(def.x, doorFloorY(def), def.z);
      var mat = new THREE.MeshLambertMaterial({ color: def.color || 0x8a5a2b });
      var panel = new THREE.Mesh(new THREE.BoxGeometry(door.width, door.height, 0.14), mat);
      panel.position.set(door.width / 2, door.height / 2, 0); // hinge at left edge
      g.add(panel);
      // Small round knob near the swinging edge.
      var knob = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 8, 8),
        new THREE.MeshLambertMaterial({ color: 0xd8d8d8 }));
      knob.position.set(door.width - 0.16, 1.05, 0.12);
      g.add(knob);
      g.rotation.y = door.baseYaw;
      if (typeof scene !== 'undefined' && scene) scene.add(g);
      door.group = g;
      door.mesh = panel;
    }
  }catch(e){ /* visual is optional; the door still functions */ }
  return door;
}

/* doorBoxDef(door) -- thin AABB across the closed doorway, used as the
   movement blocker while the door is closed. */
function doorBoxDef(door){
  var dx = Math.cos(door.baseYaw), dz = -Math.sin(door.baseYaw); // local +X in world
  var ex = door.position.x + dx * door.width;
  var ez = door.position.z + dz * door.width;
  var t = 0.35; // doorway thickness padding
  return {
    id: door.id + '-block',
    minX: Math.min(door.position.x, ex) - t,
    maxX: Math.max(door.position.x, ex) + t,
    minZ: Math.min(door.position.z, ez) - t,
    maxZ: Math.max(door.position.z, ez) + t,
    buildingId: door.buildingId
  };
}

/* setDoorBlock(door, blocked) -- (un)register the closed-door movement blocker. */
function setDoorBlock(door, blocked){
  if (blocked){
    if (!door.colliderId) door.colliderId = window.InteriorCollision.addBox(doorBoxDef(door));
  } else {
    if (door.colliderId){ window.InteriorCollision.removeBox(door.colliderId); door.colliderId = null; }
  }
}

/* registerDoors(building) -- spec API: creates one door per `doors` entry in
   the building data, positioned per its face/angle. Closed doors start out
   blocking movement. Returns the created door records. Safe to call with
   buildings that have no doors (returns []). */
function registerDoors(building){
  var out = [];
  if (!building || !building.doors || !building.doors.length) return out;
  var bid = building.id || building.buildingId || null;
  for (var i = 0; i < building.doors.length; i++){
    var def = building.doors[i];
    if (!def || typeof def.x !== 'number' || typeof def.z !== 'number') continue;
    var door = createDoor(def, bid);
    doors.push(door);
    setDoorBlock(door, true); // closed doors block movement (spec)
    out.push(door);
  }
  return out;
}

/* Door swing animation: a single shared requestAnimationFrame loop that only
   runs while at least one door is animating (cheap on the TCL). */
var animDoors = [];
var animRunning = false;
var _animLast = 0;
function kickDoorAnim(){
  if (animRunning) return;
  animRunning = true;
  _animLast = 0;
  try{
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(doorAnimStep);
    else animRunning = false; // no rAF (e.g. node test) -- animation skipped
  }catch(e){ animRunning = false; }
}
function doorAnimStep(ts){
  try{
    var now = ts || Date.now();
    var dt = _animLast ? (now - _animLast) / 1000 : 0.016;
    _animLast = now;
    for (var i = animDoors.length - 1; i >= 0; i--){
      var d = animDoors[i];
      d.animT += dt / DOOR_ANIM_T; // 0 -> 1 over DOOR_ANIM_T seconds
      var t = d.animT >= 1 ? 1 : d.animT;
      // Ease in-out so the swing starts/stops gently instead of snapping.
      var e = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2;
      var yaw = d.animFrom + (d.animTo - d.animFrom) * e;
      d.swingAngle = yaw - d.baseYaw;
      if (d.group){ try{ d.group.rotation.y = yaw; }catch(e2){} }
      if (t >= 1) animDoors.splice(i, 1);
    }
    if (animDoors.length){
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(doorAnimStep);
      else animRunning = false;
    } else {
      animRunning = false;
    }
  }catch(e){ animRunning = false; }
}

/* toggleDoor(door) -- flips open/closed, starts the 0.5s swing animation,
   and swaps the movement blocker (open doors don't block). */
function toggleDoor(door){
  if (!door) return;
  door.isOpen = !door.isOpen;
  var targetYaw = door.baseYaw + (door.isOpen ? door.swingDir * DOOR_SWING : 0);
  door.animFrom = door.group ? door.group.rotation.y : door.baseYaw + door.swingAngle;
  door.animTo = targetYaw;
  door.animT = 0;
  if (animDoors.indexOf(door) < 0) animDoors.push(door);
  setDoorBlock(door, !door.isOpen); // open -> no block; closed -> block
  kickDoorAnim();
}

/* nearestDoor() -- closest door in range, scoped to the current interior. */
function nearestDoor(){
  if (typeof player === 'undefined' || !player) return null;
  var best = null, bestD = DOOR_RADIUS;
  for (var i = 0; i < doors.length; i++){
    var d = doors[i];
    var dd = dist2(player.x, player.z, d.position.x, d.position.z);
    if (dd < bestD){ bestD = dd; best = d; }
  }
  return best;
}

/* --------------------------------------------------------------------------
   4. Appliances (proximity + action button + sounds)
   -------------------------------------------------------------------------- */

/* registerAppliances(building) -- spec API: registers one appliance per
   {type, x, z} entry. Types: 'sink' | 'stove' | 'fridge' | 'bed' | 'closet'.
   Unknown types are kept (harmless) but produce no button prompt. */
function registerAppliances(building){
  var out = [];
  if (!building || !building.appliances || !building.appliances.length) return out;
  var bid = building.id || building.buildingId || null;
  for (var i = 0; i < building.appliances.length; i++){
    var a = building.appliances[i];
    if (!a || !a.type || typeof a.x !== 'number' || typeof a.z !== 'number') continue;
    var rec = { id: 'ap' + (++applSeq), type: String(a.type).toLowerCase(),
                x: a.x, z: a.z, buildingId: bid || a.buildingId || null };
    appliances.push(rec);
    out.push(rec);
  }
  return out;
}

/* registerFurniture(building) -- spec section 2 helper: turns
   building.furniture = [{x,z,w,d}] footprints into InteriorCollision boxes. */
function registerFurniture(building){
  var out = [];
  if (!building || !building.furniture || !building.furniture.length) return out;
  var bid = building.id || building.buildingId || null;
  for (var i = 0; i < building.furniture.length; i++){
    var f = building.furniture[i];
    if (!f || typeof f.x !== 'number' || typeof f.z !== 'number') continue;
    var w = (f.w || 1) / 2, d = (f.d || 1) / 2;
    var id = window.InteriorCollision.addBox({
      minX: f.x - w, maxX: f.x + w, minZ: f.z - d, maxZ: f.z + d,
      buildingId: bid || f.buildingId || null
    });
    out.push(id);
  }
  return out;
}

/* appliancePrompt(ap) -- the button {act,label} for an appliance. The bed
   prompt depends on sleep state: SLEEP before, GET UP after. */
function appliancePrompt(ap){
  switch (ap.type){
    case 'sink':   return { act: 'use-sink',       label: 'USE SINK' };
    case 'stove':  return { act: 'use-stove',      label: 'USE STOVE' };
    case 'fridge': return { act: 'open-fridge',    label: 'OPEN FRIDGE' };
    case 'bed':
      return sleepState.asleep
        ? { act: 'get-up', label: 'GET UP' }
        : { act: 'sleep',  label: 'SLEEP' };
    case 'closet': return { act: 'change-clothes', label: 'CHANGE CLOTHES' };
    default:       return null;
  }
}

/* nearestAppliance() -- closest appliance in range with a valid prompt. */
function nearestAppliance(){
  if (typeof player === 'undefined' || !player) return null;
  var best = null, bestD = APPLIANCE_RADIUS, bestP = null;
  for (var i = 0; i < appliances.length; i++){
    var ap = appliances[i];
    var pr = appliancePrompt(ap);
    if (!pr) continue;
    var dd = dist2(player.x, player.z, ap.x, ap.z);
    if (dd < bestD){ bestD = dd; best = ap; bestP = pr; }
  }
  return best ? { ref: best, prompt: bestP, dist: bestD } : null;
}

/* ---- Web Audio sound effects (no external files; spec section 3) ---- */

/* ensureAudio() -- lazily creates one shared AudioContext. Browsers require
   a user gesture before audio may start; the action-button click counts, so
   creation happens inside the click handler path. typeof-guarded for
   non-browser environments. */
var _ac = null;
function ensureAudio(){
  if (_ac) {
    try{ if (_ac.state === 'suspended') _ac.resume(); }catch(e){}
    return _ac;
  }
  try{
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _ac = new AC();
    if (_ac.state === 'suspended'){ try{ _ac.resume(); }catch(e){} }
  }catch(e){ _ac = null; }
  return _ac;
}

/* noiseBuffer(ac, seconds) -- reusable white-noise buffer for water/crackle. */
function noiseBuffer(ac, seconds){
  var len = Math.max(1, Math.floor(ac.sampleRate * seconds));
  var buf = ac.createBuffer(1, len, ac.sampleRate);
  var ch = buf.getChannelData(0);
  for (var i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  return buf;
}

/* playWaterSound() -- spec: white noise through a ~1000Hz bandpass, 2 seconds. */
function playWaterSound(){
  var ac = ensureAudio(); if (!ac) return;
  try{
    var dur = 2, t0 = ac.currentTime;
    var src = ac.createBufferSource();
    src.buffer = noiseBuffer(ac, dur);
    var bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1000; bp.Q.value = 0.8;
    var g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.15);   // fade in
    g.gain.setValueAtTime(0.25, t0 + dur - 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);  // fade out
    src.connect(bp); bp.connect(g); g.connect(ac.destination);
    src.start(t0); src.stop(t0 + dur);
  }catch(e){}
}

/* playCookingSound() -- spec: a series of short noise bursts (crackling),
   2 seconds. Each burst is bandpassed noise with a fast attack/decay at a
   random pitch and random time, which reads as sizzling. */
function playCookingSound(){
  var ac = ensureAudio(); if (!ac) return;
  try{
    var t0 = ac.currentTime;
    var burst = noiseBuffer(ac, 0.12);
    for (var i = 0; i < 14; i++){
      (function(){
        var t = t0 + Math.random() * 1.8;
        var src = ac.createBufferSource();
        src.buffer = burst;
        src.playbackRate.value = 0.8 + Math.random() * 0.6;
        var bp = ac.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1800 + Math.random() * 2200;
        bp.Q.value = 2;
        var g = ac.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.16 + Math.random() * 0.14, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07 + Math.random() * 0.04);
        src.connect(bp); bp.connect(g); g.connect(ac.destination);
        src.start(t); src.stop(t + 0.16);
      })();
    }
  }catch(e){}
}

/* playFridgeSound() -- spec: low ~55Hz sine with slight amplitude
   modulation (a slow LFO on the gain), 2 seconds. Reads as a motor hum. */
function playFridgeSound(){
  var ac = ensureAudio(); if (!ac) return;
  try{
    var dur = 2, t0 = ac.currentTime;
    var o = ac.createOscillator();
    o.type = 'sine'; o.frequency.value = 55;
    var g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.2);   // motor spins up
    g.gain.setValueAtTime(0.22, t0 + dur - 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); // spins down
    var lfo = ac.createOscillator(); // amplitude modulation: the "wobble"
    lfo.frequency.value = 7;
    var lg = ac.createGain(); lg.gain.value = 0.05;
    lfo.connect(lg); lg.connect(g.gain);
    o.connect(g); g.connect(ac.destination);
    o.start(t0); lfo.start(t0);
    o.stop(t0 + dur); lfo.stop(t0 + dur);
  }catch(e){}
}

/* ---- Sleep (bed) ---- */

/* ensureSleepOverlay() -- full-screen black div with a CSS opacity
   transition, created once and reused. pointer-events is only enabled while
   the screen is black so it blocks input during the sleep beat. */
function ensureSleepOverlay(){
  var ov = null;
  try{ ov = document.getElementById('interior-sleep-overlay'); }catch(e){}
  if (!ov){
    try{
      ov = document.createElement('div');
      ov.id = 'interior-sleep-overlay';
      ov.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;' +
        'pointer-events:none;transition:opacity 0.8s ease;z-index:9999;';
      document.body.appendChild(ov);
    }catch(e){ ov = null; }
  }
  return ov;
}

/* doSleep() -- spec: confirm dialog -> fade to black -> wait 2s -> fade
   back. Sets sleepState.asleep so the bed prompt becomes GET UP. */
function doSleep(){
  var ok = false;
  try{ ok = window.confirm('Do you want to go to sleep?'); }catch(e){ ok = false; }
  if (!ok) return;
  var ov = ensureSleepOverlay();
  if (!ov){ // overlay unavailable (shouldn't happen): still count the sleep
    sleepState.asleep = true;
    toast('You feel rested.', 2500);
    return;
  }
  ov.style.pointerEvents = 'auto';
  ov.style.opacity = '1'; // fade to black (0.8s CSS transition)
  setTimeout(function(){
    sleepState.asleep = true;
    setTimeout(function(){           // ...wait 2s in the dark (spec)...
      ov.style.opacity = '0';       // ...then fade back in.
      setTimeout(function(){ ov.style.pointerEvents = 'none'; }, 850);
      toast('You feel rested.', 2500);
    }, 2000);
  }, 850);
}

/* --------------------------------------------------------------------------
   5. Small-object pickup
   -------------------------------------------------------------------------- */

/* registerPickupables(building) -- spec API: registers objects with
   pickupable:true (via building.pickupables = [{name,x,z}] or
   building.items filtered by item.pickupable). v1 keeps them data-only
   (position + name); a visual mesh can be attached later via rec.mesh. */
function registerPickupables(building){
  var out = [];
  if (!building) return out;
  var bid = building.id || building.buildingId || null;
  function addOne(it){
    if (!it || typeof it.x !== 'number' || typeof it.z !== 'number') return;
    var rec = { id: 'pk' + (++pickSeq),
                name: String(it.name || 'Item'),
                x: it.x, z: it.z,
                buildingId: bid || it.buildingId || null,
                mesh: it.mesh || null };
    pickupables.push(rec);
    out.push(rec);
  }
  var i;
  if (building.pickupables && building.pickupables.length){
    for (i = 0; i < building.pickupables.length; i++) addOne(building.pickupables[i]);
  }
  if (building.items && building.items.length){
    for (i = 0; i < building.items.length; i++){
      if (building.items[i] && building.items[i].pickupable) addOne(building.items[i]);
    }
  }
  return out;
}

/* nearestPickupable() -- closest pickupable in range, current interior only. */
function nearestPickupable(){
  if (typeof player === 'undefined' || !player) return null;
  var best = null, bestD = PICKUP_RADIUS;
  for (var i = 0; i < pickupables.length; i++){
    var pk = pickupables[i];
    var dd = dist2(player.x, player.z, pk.x, pk.z);
    if (dd < bestD){ bestD = dd; best = pk; }
  }
  return best;
}

/* doInteriorPickup() -- spec: remove from the world, add to
   window.PlayerInventory (created when missing), toast "Picked up [name]". */
function doInteriorPickup(){
  var pk = IS._pendingPickupable || nearestPickupable();
  if (!pk) return;
  var i = pickupables.indexOf(pk);
  if (i >= 0) pickupables.splice(i, 1);
  try{ // remove the world mesh when one was attached
    if (pk.mesh && typeof scene !== 'undefined' && scene) scene.remove(pk.mesh);
  }catch(e){}
  try{
    window.PlayerInventory = window.PlayerInventory || [];
    window.PlayerInventory.push({ name: pk.name, buildingId: pk.buildingId || null, at: Date.now() });
  }catch(e){}
  toast('Picked up ' + pk.name, 2200);
  IS._pendingPickupable = null;
  IS._target = null; // force a rescan so the button updates immediately
}

/* --------------------------------------------------------------------------
   6. Proximity scan + action-button integration
   -------------------------------------------------------------------------- */

/* IS -- forward reference to the public window.InteriorSystem object
   (assigned at the bottom). Internal functions use it for shared state. */
var IS = null;

/* scanInterior() -- one proximity pass over doors, appliances and
   pickupables. Returns {kind, ref, act, label, dist} for the best target or
   null. Nearest target wins across categories. */
function scanInterior(){
  if (typeof player === 'undefined' || !player || !player.inside) return null;
  var best = null;
  function consider(dist, kind, ref, act, label){
    if (!best || dist < best.dist) best = { kind: kind, ref: ref, act: act, label: label, dist: dist };
  }
  var i, dd;
  for (i = 0; i < doors.length; i++){ // doors: < 3 units
    var d = doors[i];
    dd = dist2(player.x, player.z, d.position.x, d.position.z);
    if (dd < DOOR_RADIUS)
      consider(dd, 'door', d, d.isOpen ? 'close-door' : 'open-door',
               d.isOpen ? 'CLOSE DOOR' : 'OPEN DOOR');
  }
  var na = nearestAppliance(); // appliances: within 3 units
  if (na) consider(na.dist, 'appliance', na.ref, na.prompt.act, na.prompt.label);
  var np = nearestPickupable(); // pickupables: within 2.5 units
  if (np) consider(dist2(player.x, player.z, np.x, np.z),
                   'pickupable', np, 'pickup-item',
                   'PICK UP ' + String(np.name).toUpperCase());
  return best;
}

/* targetInRange(t) -- revalidates a cached scan result with a single cheap
   distance check, so a stale cache never shows a prompt the player walked
   away from. */
function targetInRange(t){
  if (!t || !t.ref) return false;
  if (typeof player === 'undefined' || !player || !player.inside) return false;
  var r = t.kind === 'pickupable' ? PICKUP_RADIUS :
          t.kind === 'appliance' ? APPLIANCE_RADIUS : DOOR_RADIUS;
  var px, pz;
  if (t.kind === 'door'){ px = t.ref.position.x; pz = t.ref.position.z; }
  else { px = t.ref.x; pz = t.ref.z; }
  return dist2(player.x, player.z, px, pz) < r;
}

/* applyButton() -- called after the game's own updateActionButton() via the
   non-invasive wrapper. Overrides the universal button ONLY when an interior
   target is in range; otherwise leaves the game's act/label untouched. The
   full scan runs at most every SCAN_MS (200ms); between scans the cached
   target is revalidated with one distance check. */
function applyButton(){
  var btn = getActionBtn();
  if (!btn || !IS) return;
  // Not indoors: clear interior state (and the sleep flag) and get out of
  // the way so the outdoor button logic owns the button again.
  if (typeof player === 'undefined' || !player || !player.inside){
    IS._target = null; IS._pendingDoor = null; IS._pendingPickupable = null;
    sleepState.asleep = false;
    return;
  }
  var now = Date.now();
  var t = IS._target;
  if (t && !targetInRange(t)) t = null; // walked away: drop the stale target
  if (!t || (now - IS._scanT) >= SCAN_MS){
    t = scanInterior();
    IS._scanT = now;
  }
  IS._target = t;
  // Keep the pending refs in lockstep with the live target (the click
  // handler re-resolves anyway, so these are a fast path, not authority).
  IS._pendingDoor = (t && t.kind === 'door') ? t.ref : null;
  IS._pendingPickupable = (t && t.kind === 'pickupable') ? t.ref : null;
  if (t){
    btn.style.display = 'block';
    btn.textContent = t.label;
    btn.dataset.act = t.act;
  }
  // No target: say nothing -- the game's own act/label from this tick stands.
}

/* --------------------------------------------------------------------------
   7. Action handling (universal action button)
   -------------------------------------------------------------------------- */

/* handleAction(a) -- spec API. Returns true when the action name belongs to
   this system and was handled, false otherwise. The game's own click handler
   ignores these names, so this can ALSO be wired as the first line of the
   game's listener (see file header) -- either path works. */
function handleAction(a){
  if (!a) return false;
  switch (a){
    case 'open-door':
    case 'close-door': {
      // Re-resolve the nearest door at click time (robust against a stale
      // pending ref); fall back to the pending ref from the last scan.
      var d = nearestDoor() || (IS && IS._pendingDoor) || null;
      if (d){ toggleDoor(d); toast(d.isOpen ? 'Door opened.' : 'Door closed.', 1500); }
      return true;
    }
    case 'use-sink':
      playWaterSound();
      toast('You wash your hands.', 2000);
      return true;
    case 'use-stove':
      playCookingSound();
      toast('Something sizzles on the stove.', 2000);
      return true;
    case 'open-fridge':
      playFridgeSound();
      toast('The fridge hums.', 2000);
      return true;
    case 'sleep':
      doSleep();
      return true;
    case 'get-up':
      sleepState.asleep = false;
      toast('You get up.', 2000);
      return true;
    case 'change-clothes':
      // typeof-guarded: ClothingSystem may not exist yet (spec).
      try{
        if (window.ClothingSystem && typeof window.ClothingSystem.openWardrobe === 'function'){
          window.ClothingSystem.openWardrobe();
        } else {
          toast('Wardrobe not available', 2200);
        }
      }catch(e){ toast('Wardrobe not available', 2200); }
      return true;
    case 'pickup-item':
      doInteriorPickup();
      return true;
    default:
      return false; // not ours -- leave it for the game's own handler
  }
}

/* hookActionClick() -- own 'click' listener on #action-btn. It is registered
   AFTER the game's listener (this file loads later in the deferred queue),
   so for game actions the game's handler runs first and ours no-ops, and
   for interior actions the game's handler no-ops (unknown name) and ours
   handles it. The __interiorClickHooked flag makes re-evaluation safe. */
function hookActionClick(){
  try{
    var btn = getActionBtn();
    if (!btn) return false;
    if (btn.__interiorClickHooked) return true;
    btn.__interiorClickHooked = true;
    btn.addEventListener('click', function(){
      var a = null;
      try{ a = btn.dataset.act; }catch(e){}
      try{ handleAction(a); }catch(e){}
    });
    return true;
  }catch(e){ return false; }
}

/* --------------------------------------------------------------------------
   8. Non-invasive game hooks
   -------------------------------------------------------------------------- */

/* hookUpdateActionButton() -- wraps the game's updateActionButton() (called
   on its ~8Hz throttle tick). The game computes its own act/label first;
   applyButton() then overrides ONLY for in-range interior targets. The
   __interiorHooked flag prevents double-wrapping on re-evaluation. */
function hookUpdateActionButton(){
  try{
    if (typeof window.updateActionButton !== 'function') return false;
    if (window.updateActionButton.__interiorHooked) return true;
    var orig = window.updateActionButton;
    var wrapped = function(){
      orig();
      try{ applyButton(); }catch(e){}
    };
    wrapped.__interiorHooked = true;
    window.updateActionButton = wrapped;
    return true;
  }catch(e){ return false; }
}

/* hookResolveCollision() -- wraps the game's resolveCollision(p, radius).
   After the game's own pass, applies the interior AABB push-out, but ONLY
   for the player and ONLY while player.inside is true, so outdoor movement
   and other entities are completely unaffected. */
function hookResolveCollision(){
  try{
    if (typeof window.resolveCollision !== 'function') return false;
    if (window.resolveCollision.__interiorHooked) return true;
    var orig = window.resolveCollision;
    var wrapped = function(p, radius){
      orig(p, radius);
      try{
        if (p && typeof player !== 'undefined' && p === player && player.inside){
          resolvePlayer(p, radius || 0.5);
        }
      }catch(e){}
    };
    wrapped.__interiorHooked = true;
    window.resolveCollision = wrapped;
    return true;
  }catch(e){ return false; }
}

/* --------------------------------------------------------------------------
   9. WalkableBuildings auto-registration + init
   -------------------------------------------------------------------------- */

/* scanWalkableBuildings() -- spec: walkable buildings are exposed via
   window.WalkableBuildings (placed by building_spawner.js, which may not
   exist yet -- typeof-guarded). Accepts an array or {buildings:[...]} /
   {list:[...]}. Each building is registered once (flagged), on a 2s poll,
   so spawners that place buildings after load are picked up automatically. */
function scanWalkableBuildings(){
  try{
    var wb = window.WalkableBuildings;
    if (!wb) return;
    var list = Array.isArray(wb) ? wb : (wb.buildings || wb.list || null);
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++){
      var b = list[i];
      if (!b || b.__interiorRegistered) continue;
      b.__interiorRegistered = true;
      try{ registerDoors(b); }catch(e){}
      try{ registerAppliances(b); }catch(e){}
      try{ registerFurniture(b); }catch(e){}
      try{ registerPickupables(b); }catch(e){}
    }
  }catch(e){}
}

/* Public API (spec): registration entry points the spawner calls, the
   action dispatcher, and read accessors for debugging / the watcher. */
window.InteriorSystem = {
  registerDoors: registerDoors,
  registerAppliances: registerAppliances,
  registerFurniture: registerFurniture,
  registerPickupables: registerPickupables,
  handleAction: handleAction,
  doors: function(){ return doors.slice(); },
  appliances: function(){ return appliances.slice(); },
  pickupables: function(){ return pickupables.slice(); },
  isAsleep: function(){ return sleepState.asleep; },
  /* reset() -- test/dev helper: clears every registry and sleep state. */
  reset: function(){
    doors = []; appliances = []; pickupables = []; boxes = [];
    animDoors = []; sleepState.asleep = false;
    if (IS){ IS._target = null; IS._pendingDoor = null; IS._pendingPickupable = null; }
  },
  /* _target / _pendingDoor / _pendingPickupable / _scanT -- live proximity
     state, managed by applyButton(). Underscored: internal but readable. */
  _target: null, _pendingDoor: null, _pendingPickupable: null, _scanT: 0
};
IS = window.InteriorSystem; // let the internal functions reach shared state

/* tryInit() -- installs the non-invasive hooks once the game globals exist.
   Returns true when everything hooked. */
function tryInit(){
  var okBtn = hookActionClick();
  var okUab = hookUpdateActionButton();
  var okCol = hookResolveCollision();
  if (okBtn && okUab && okCol){
    try{ scanWalkableBuildings(); }catch(e){}
    return true;
  }
  return false;
}

/* Boot: try immediately (deferred queue runs us after the game code, so the
   globals are usually present), then retry every 500ms for up to ~25s in
   case this file ever loads before the game finished booting. A 2s poll
   keeps picking up late-placed WalkableBuildings. The 200ms tick is the
   spec's proximity loop: it revalidates the cached target and -- only when
   the updateActionButton wrapper could NOT be installed (older build) --
   drives the button itself as a fallback. */
var _initTries = 0;
var _initTimer = setInterval(function(){
  try{
    if (tryInit() || (++_initTries > 50)) clearInterval(_initTimer);
  }catch(e){ clearInterval(_initTimer); }
}, 500);
try{ tryInit(); }catch(e){}

setInterval(function(){
  try{ scanWalkableBuildings(); }catch(e){}
}, 2000);

setInterval(function(){
  try{
    // Fallback path: the game tick normally drives the button through the
    // wrapped updateActionButton(); this only fires when that hook is absent.
    if (!window.updateActionButton || !window.updateActionButton.__interiorHooked){
      applyButton();
    }
  }catch(e){}
}, SCAN_MS);

})();
