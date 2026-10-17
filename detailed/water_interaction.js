/* ============================================================================
   WATER INTERACTION — sinking cars, shore respawn, and fish (2026-10-11)
   Joshua's rule: all code commented.

   What this module does:
     1. findShore(x, z) — nearest dry-land point from a water position.
        Used when a car sinks: the player washes up on shore on foot.
     2. FISH SYSTEM — automated fish in lakes, ponds, and the Chattahoochee
        River (Joshua's spec).
        - Tatum Lake + the adjacent pond: bream (bluegill) and crappie
          (Joshua's ground truth — that's what's in there).
        - Every other lake/pond: largemouth bass + bluegill.
        - Chattahoochee River: largemouth bass, shoal bass, channel
          catfish, bluegill, redbreast sunfish. River fish swim ALONG the
          channel (upstream/downstream) instead of wandering.
        - Behavior: small schools that wander inside their water body and
          dart away when the player gets close.
        - PERFORMANCE (Joshua's NPC rule — matches npc_system.js exactly):
          fish are PURE DATA until the player is near. No meshes spawn, no
          rendering, no animation updates. Meshes stream in when a school's
          anchor comes within FISH_SPAWN_R (150u = NPC VISIBLE_R) and are
          scene.removed beyond FISH_DESPAWN_R (200u = NPC HIDE_R, same
          anti-pop hysteresis). The streaming sweep runs every 0.5s, same
          cadence as the NPC refreshSlots pass. Tail-wiggle animation only
          within FISH_ANIM_R (80u = NPC ANIM_R).

   Depends on globals: THREE, scene, player, inWater, waterLevelAt, WATER,
   Sim (tick registry). Fully defensive: if anything is missing, the module
   quietly does nothing — the game never breaks because of fish.
   ============================================================================ */
(function WaterInteraction(){
'use strict';

/* ---------------------------------------------------------------------------
   findShore(x, z) — nearest dry land.
   Casts 16 rays outward from (x,z), stepping 5u at a time up to 150u, and
   returns the first point where inWater() is false. Returns null if no
   shore is found (shouldn't happen — every water body has a shore).
   --------------------------------------------------------------------------- */
function findShore(x, z){
  try {
    if (typeof inWater !== 'function') return null;
    if (!inWater(x, z)) return { x: x, z: z };  // already dry
    var RAYS = 16, STEP = 5, MAXD = 150;
    for (var d = STEP; d <= MAXD; d += STEP){
      for (var r = 0; r < RAYS; r++){
        var a = (r / RAYS) * Math.PI * 2;
        var px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
        if (!inWater(px, pz)) return { x: px, z: pz };
      }
    }
  } catch(e){}
  return null;
}

/* ---------------------------------------------------------------------------
   FISH SYSTEM
   --------------------------------------------------------------------------- */

/* Species table. size = body length in world units (stylized, slightly
   larger than life so they're visible). speed = cruise u/s. */
var SPECIES = {
  bream:     { color: 0x6b8f3e, size: 0.55, speed: 2.0, label: 'bream' },
  crappie:   { color: 0xb9c6cb, size: 0.60, speed: 1.8, label: 'crappie' },
  bass:      { color: 0x2e5b2e, size: 0.85, speed: 2.6, label: 'largemouth bass' },
  bluegill:  { color: 0x5f7f3f, size: 0.50, speed: 2.0, label: 'bluegill' },
  shoalbass: { color: 0x4a5d3a, size: 0.80, speed: 2.8, label: 'shoal bass' },
  catfish:   { color: 0x3a3a42, size: 1.00, speed: 1.6, label: 'channel catfish' },
  redbreast: { color: 0x8a6a3a, size: 0.55, speed: 2.0, label: 'redbreast sunfish' }
};

/* STREAMING — the NPC performance pattern, applied to fish (Joshua's rule).
   Matches npc_system.js: VISIBLE_R=150, HIDE_R=200, refreshSlots every 0.5s,
   ANIM_R=80. Fish are pure data (no meshes, no rendering, no animation)
   until a school's anchor comes within range. */
var FISH_SPAWN_R   = 150;   // = NPC VISIBLE_R: stream meshes in
var FISH_DESPAWN_R = 200;   // = NPC HIDE_R: release meshes (anti-pop hysteresis)
var FISH_ANIM_R    = 80;    // = NPC ANIM_R: tail wiggle only near camera
var FISH_REFRESH_T = 0.5;   // = NPC refreshSlots cadence, seconds
var FISH_DART_DIST = 16;    // player this close (in water): fish dart away
var FISH_DART_TIME = 1.5;   // seconds of burst speed after a dart
var MAX_FISH_PER_BODY = 16;
var MIN_FISH_PER_BODY = 6;

var fishes = [];    // every fish: {mesh, x,z, heading, speed, species, school, dartT, phase, ...}
var schools = [];   // {kind, cx,cz,rx,rz (lake) | pts,cum,total,t,dir,width (river), ax,az, heading, _meshed}
var _spawnedOn = []; // WATER entries already stocked (so re-scans don't double up)
var _t = 0;

/* _isTatumWater(name) — Tatum Lake and its adjacent pond get bream+crappie
   (Joshua's ground truth). Everything else gets bass+bluegill. */
function _isTatumWater(name){
  if (!name) return false;
  return (/tatum/i.test(name) || name === 'POND');
}

/* _makeFishMesh(sp) — one cheap fish: elongated diamond body + tail fin.
   Two meshes sharing per-species geometries/materials (created once). */
var _geoCache = {};
function _makeFishMesh(sp){
  var key = sp.label;
  if (!_geoCache[key]){
    var s = sp.size;
    // Body: octahedron stretched along Z (direction of travel).
    var bodyGeo = new THREE.OctahedronGeometry(0.5);
    bodyGeo.scale(0.30*s, 0.42*s, 1.0*s);
    // Tail: flattened cone at the back (-Z), tip pointing backward.
    var tailGeo = new THREE.ConeGeometry(0.20*s, 0.45*s, 4);
    tailGeo.rotateX(-Math.PI/2);   // tip -> -Z (length axis is now Z)
    tailGeo.scale(0.35, 1, 1);     // thin side-to-side: vertical tail fin
    tailGeo.translate(0, 0, -0.62*s);
    var mat = new THREE.MeshLambertMaterial({ color: sp.color });
    _geoCache[key] = { body: bodyGeo, tail: tailGeo, mat: mat };
  }
  var c = _geoCache[key];
  var g = new THREE.Group();
  g.add(new THREE.Mesh(c.body, c.mat));
  g.add(new THREE.Mesh(c.tail, c.mat));
  // Meshes are only created when the school streams in (NPC pattern), so
  // no visibility toggling is needed — presence in the scene means active.
  return g;
}

/* _stockWater(w) — stock one lake/pond's fish, in schools of 4-6.
   w: a WATER entry with {x, z, rx, rz, name} (lake/pond ellipse).
   PURE DATA — no meshes (NPC pattern: meshes stream in when near). */
function _stockWater(w){
  if (_spawnedOn.indexOf(w) >= 0) return;
  _spawnedOn.push(w);
  var cx = w.x, cz = w.z, rx = w.rx || 30, rz = w.rz || 30;
  // Headcount scales with water size (stylized — real lakes hold thousands).
  var n = Math.round(Math.sqrt(rx * rz) / 4);
  n = Math.max(MIN_FISH_PER_BODY, Math.min(MAX_FISH_PER_BODY, n));
  var tatum = _isTatumWater(w.name);
  var schoolCount = Math.max(1, Math.round(n / 5));
  for (var s = 0; s < schoolCount; s++){
    // School anchor starts at a random spot inside the ellipse.
    var aa = Math.random()*Math.PI*2, ar = Math.random()*0.5;
    var school = {
      kind: 'lake',
      cx: cx, cz: cz, rx: rx, rz: rz,
      ax: cx + Math.cos(aa)*ar*rx, az: cz + Math.sin(aa)*ar*rz,
      heading: Math.random()*Math.PI*2,
      _meshed: false   // NPC pattern: meshes stream in only when near
    };
    schools.push(school);
    var per = Math.ceil(n / schoolCount);
    for (var f = 0; f < per; f++){
      // Species mix per water body.
      var sp;
      if (tatum) sp = (Math.random() < 0.5) ? SPECIES.bream : SPECIES.crappie;
      else       sp = (Math.random() < 0.5) ? SPECIES.bass  : SPECIES.bluegill;
      var fa = Math.random()*Math.PI*2, fr = 2 + Math.random()*6;
      fishes.push({
        mesh: null,  // streamed in when the player comes in range
        x: school.ax + Math.cos(fa)*fr, z: school.az + Math.sin(fa)*fr,
        heading: Math.random()*Math.PI*2,
        speed: sp.speed, species: sp, school: school,
        dartT: 0, phase: Math.random()*Math.PI*2,
        ox: Math.cos(fa)*fr, oz: Math.sin(fa)*fr  // personal offset from anchor
      });
    }
  }
  try {
    if (typeof Report !== 'undefined' && Report.setSys)
      Report.setSys('fish', { water: w.name || '?', count: n });
  } catch(e){}
}

/* ---- Chattahoochee River fish (Joshua's spec) ----------------------------
   River fish swim ALONG the channel (upstream/downstream) instead of
   wandering an ellipse. Schools anchor at an arc-length position t on the
   river polyline and drift with the school direction. */

/* _isChattahoochee(name) — fish go in the Chattahoochee (Joshua's spec).
   Flint River stays fishless for now. */
function _isChattahoochee(name){
  return !!name && /chattahoochee/i.test(name);
}

/* _polyCum(pts) — cumulative segment lengths of a polyline.
   Returns [0, len1, len1+len2, ...]; total = last entry. */
function _polyCum(pts){
  var cum = [0];
  for (var i = 1; i < pts.length; i++){
    var dx = pts[i][0]-pts[i-1][0], dz = pts[i][1]-pts[i-1][1];
    cum.push(cum[i-1] + Math.sqrt(dx*dx + dz*dz));
  }
  return cum;
}

/* _pointAtArc(pts, cum, t) — position + unit tangent at arc-length t.
   Returns {x, z, tx, tz}. Clamps t to [0, total]. */
function _pointAtArc(pts, cum, t){
  var total = cum[cum.length-1];
  if (t <= 0) t = 0; else if (t >= total) t = total;
  var i = 1;
  while (i < cum.length-1 && cum[i] < t) i++;
  var segLen = cum[i]-cum[i-1] || 1;
  var f = (t-cum[i-1]) / segLen;
  return {
    x:  pts[i-1][0] + (pts[i][0]-pts[i-1][0])*f,
    z:  pts[i-1][1] + (pts[i][1]-pts[i-1][1])*f,
    tx: (pts[i][0]-pts[i-1][0])/segLen,
    tz: (pts[i][1]-pts[i-1][1])/segLen
  };
}

/* _nearestArc(pts, cum, x, z) — arc-length t of the closest point on the
   polyline to (x,z). Used after a dart to snap a fish back into the channel. */
function _nearestArc(pts, cum, x, z){
  var bestT = 0, bestD = Infinity;
  for (var i = 1; i < pts.length; i++){
    var ax = pts[i-1][0], az = pts[i-1][1];
    var bx = pts[i][0],   bz = pts[i][1];
    var abx = bx-ax, abz = bz-az;
    var len2 = abx*abx + abz*abz || 1;
    var f = ((x-ax)*abx + (z-az)*abz) / len2;
    f = f < 0 ? 0 : (f > 1 ? 1 : f);
    var px = ax+abx*f, pz = az+abz*f;
    var d = (x-px)*(x-px) + (z-pz)*(z-pz);
    if (d < bestD){ bestD = d; bestT = cum[i-1] + Math.sqrt(len2)*f; }
  }
  return bestT;
}

/* _chattahoocheeSpecies() — weighted pick: bass and bluegill common,
   shoal bass and redbreast regulars, channel catfish occasional. */
function _chattahoocheeSpecies(){
  var r = Math.random();
  if (r < 0.25) return SPECIES.bass;
  if (r < 0.45) return SPECIES.shoalbass;
  if (r < 0.70) return SPECIES.bluegill;
  if (r < 0.90) return SPECIES.redbreast;
  return SPECIES.catfish;
}

/* _stockRiver(w) — stock the Chattahoochee. w: {river: pts, width, name}.
   Schools anchor at arc-length positions along the channel; each fish holds
   a personal arc offset (ot) and lateral offset (olat) inside the ribbon.
   PURE DATA — no meshes (NPC pattern). */
function _stockRiver(w){
  if (_spawnedOn.indexOf(w) >= 0) return;
  _spawnedOn.push(w);
  var pts = w.river, width = w.width || 40;
  if (!pts || pts.length < 2) return;
  var cum = _polyCum(pts), total = cum[cum.length-1];
  if (total < 10) return;
  // Headcount scales with river length (~1 fish per 250u, stylized).
  var n = Math.round(total / 250);
  n = Math.max(MIN_FISH_PER_BODY, Math.min(20, n));
  var schoolCount = Math.max(1, Math.round(n / 5));
  var halfW = width/2 - 3;  // lateral room inside the ribbon
  for (var s = 0; s < schoolCount; s++){
    // Spread school anchors along the river with jitter.
    var t0 = ((s+0.5)/schoolCount)*total +
             (Math.random()-0.5)*total/schoolCount*0.5;
    t0 = Math.max(0, Math.min(total, t0));
    var p0 = _pointAtArc(pts, cum, t0);
    var dir = (Math.random() < 0.5) ? 1 : -1;
    var school = {
      kind: 'river', pts: pts, cum: cum, total: total, width: width,
      t: t0, dir: dir,
      ax: p0.x, az: p0.z,
      heading: Math.atan2(p0.tx*dir, p0.tz*dir),
      _meshed: false
    };
    schools.push(school);
    var per = Math.ceil(n / schoolCount);
    for (var f = 0; f < per; f++){
      var sp = _chattahoocheeSpecies();
      var ot = (Math.random()-0.5)*60;        // personal arc offset (u)
      var olat = (Math.random()-0.5)*2*halfW; // personal lateral offset (u)
      var pos = _pointAtArc(pts, cum, t0+ot);
      fishes.push({
        mesh: null,  // streamed in when the player comes in range
        x: pos.x + (-pos.tz)*olat, z: pos.z + (pos.tx)*olat,
        heading: school.heading,
        speed: sp.speed, species: sp, school: school,
        dartT: 0, phase: Math.random()*Math.PI*2,
        ot: ot, olat: olat
      });
    }
  }
  try {
    if (typeof Report !== 'undefined' && Report.setSys)
      Report.setSys('fish', { water: w.name || '?', count: n, kind: 'river' });
  } catch(e){}
}

/* _scanWater() — find fishable WATER entries and stock any that are new.
   Runs at boot and re-runs periodically (water_render.js loads async). */
function _scanWater(){
  try {
    if (typeof WATER === 'undefined' || !WATER.length) return;
    for (var i = 0; i < WATER.length; i++){
      var w = WATER[i];
      if (!w) continue;
      if (w.river){
        // Chattahoochee gets channel fish; other rivers/streams stay fishless.
        if (_isChattahoochee(w.name)) _stockRiver(w);
        continue;
      }
      if (typeof w.rx !== 'number' || typeof w.rz !== 'number') continue;
      _stockWater(w);
    }
  } catch(e){}
}

/* _refreshMeshes(px, pz) — the streaming pass (NPC refreshSlots pattern).
   Every FISH_REFRESH_T seconds: stream meshes IN for schools whose anchor
   is inside FISH_SPAWN_R, and scene.remove (despawn) schools beyond
   FISH_DESPAWN_R. The hysteresis gap stops popping at the boundary.
   Geometry/materials are shared per species (_geoCache), so streaming only
   adds/removes Groups — no allocation churn. */
function _refreshMeshes(px, pz){
  var SR2 = FISH_SPAWN_R*FISH_SPAWN_R, DR2 = FISH_DESPAWN_R*FISH_DESPAWN_R;
  for (var s = 0; s < schools.length; s++){
    var sc = schools[s];
    var dx = sc.ax-px, dz = sc.az-pz, d2 = dx*dx + dz*dz;
    if (!sc._meshed && d2 < SR2){
      // Stream in: create meshes, snap fish to their anchor-relative spots
      // (anchors drifted while data-only, so stale x/z would pop).
      sc._meshed = true;
      for (var i = 0; i < fishes.length; i++){
        var f = fishes[i];
        if (f.school !== sc || f.mesh) continue;
        try { f.mesh = _makeFishMesh(f.species); scene.add(f.mesh); }
        catch(e){ f.mesh = null; }
        if (f.mesh){
          if (sc.kind === 'river'){
            var q = _pointAtArc(sc.pts, sc.cum, sc.t + f.ot);
            f.x = q.x + (-q.tz)*f.olat; f.z = q.z + (q.tx)*f.olat;
            f.heading = sc.heading;
          } else {
            f.x = sc.ax + f.ox; f.z = sc.az + f.oz;
          }
        }
      }
    } else if (sc._meshed && d2 > DR2){
      // Stream out: back to pure data (NPC pattern — bodies are released,
      // the AI data stays).
      sc._meshed = false;
      for (var j = 0; j < fishes.length; j++){
        var g = fishes[j];
        if (g.school !== sc || !g.mesh) continue;
        try { scene.remove(g.mesh); } catch(e){}
        g.mesh = null;
      }
    }
  }
}

/* _updateFish(dt) — the per-frame fish tick.
   School anchors always drift (cheap per-school sim, like NPC AI). Only
   meshed (streamed-in) fish get behavior + mesh placement — the rest are
   pure data (NPC pattern). */
function _updateFish(dt){
  _t += dt;
  var px = 0, pz = 0, playerInWater = false;
  try {
    px = player.x; pz = player.z;
    playerInWater = (typeof inWater === 'function') && inWater(px, pz);
  } catch(e){ return; }

  var AR2 = FISH_ANIM_R*FISH_ANIM_R;

  // Drift school anchors (cheap: a few schools, not per fish — like NPC AI).
  for (var s = 0; s < schools.length; s++){
    var sc = schools[s];
    if (sc.kind === 'river'){
      // River: drift the anchor along the channel; bounce at the ends.
      sc.t += sc.dir * 1.0 * dt;
      if (sc.t >= sc.total){ sc.t = sc.total; sc.dir = -1; }
      else if (sc.t <= 0){ sc.t = 0; sc.dir = 1; }
      var rp = _pointAtArc(sc.pts, sc.cum, sc.t);
      sc.ax = rp.x; sc.az = rp.z;
      sc.heading = Math.atan2(rp.tx*sc.dir, rp.tz*sc.dir);
    } else {
      // Lake: slow wander of the anchor inside 70% of the ellipse.
      sc.heading += (Math.random()-0.5) * 1.6 * dt;
      var sp = 0.8;  // slow drift u/s
      var nx = sc.ax + Math.cos(sc.heading)*sp*dt;
      var nz = sc.az + Math.sin(sc.heading)*sp*dt;
      var ex = (nx-sc.cx)/(sc.rx*0.7), ez = (nz-sc.cz)/(sc.rz*0.7);
      if (ex*ex + ez*ez < 1){ sc.ax = nx; sc.az = nz; }
      else sc.heading += Math.PI * dt * 2;  // turn back toward center
    }
  }

  // Update each fish — meshed (streamed-in) ones only.
  for (var i = 0; i < fishes.length; i++){
    var f = fishes[i];
    var sc2 = f.school;
    if (!sc2._meshed || !f.mesh) continue;  // data-only: skip everything

    // Dart: player splashing nearby scares the fish.
    var pdx = px - f.x, pdz = pz - f.z;
    var pd2 = pdx*pdx + pdz*pdz;
    if (playerInWater && pd2 < FISH_DART_DIST*FISH_DART_DIST && f.dartT <= 0){
      f.dartT = FISH_DART_TIME;
      f.heading = Math.atan2(-pdx, -pdz);  // away from the player
    }

    var spd = f.speed;
    if (f.dartT > 0){
      // Burst away, free movement; then rejoin the water body.
      f.dartT -= dt; spd = f.speed * 3.2;
      f.x += Math.sin(f.heading) * spd * dt;
      f.z += Math.cos(f.heading) * spd * dt;
      if (f.dartT <= 0 && sc2.kind === 'river'){
        // Dart over: snap back into the channel (nearest arc position).
        var nt = _nearestArc(sc2.pts, sc2.cum, f.x, f.z);
        f.ot = nt - sc2.t; f.olat = 0;
      }
    } else if (sc2.kind === 'river'){
      // River: cruise along the channel with the school direction.
      var wantH = sc2.heading;
      var dh = wantH - f.heading;
      while (dh >  Math.PI) dh -= Math.PI*2;
      while (dh < -Math.PI) dh += Math.PI*2;
      f.heading += dh * Math.min(1, 3*dt);
      f.heading += (Math.random()-0.5) * 0.5 * dt;  // jitter
      spd = f.speed * (0.75 + 0.25*Math.sin(_t*1.3 + f.phase));
      var ft = f.ot + sc2.dir*spd*dt;   // personal arc offset follows the school
      if (ft > 80) ft = 80; else if (ft < -80) ft = -80;  // school stays together
      f.ot = ft;
      f.olat += (Math.random()-0.5) * 4 * dt;  // lateral wander
      var hw = sc2.width/2 - 3;               // stay inside the ribbon
      if (f.olat > hw) f.olat = hw; else if (f.olat < -hw) f.olat = -hw;
      var q = _pointAtArc(sc2.pts, sc2.cum, sc2.t + f.ot);
      f.x = q.x + (-q.tz)*f.olat; f.z = q.z + (q.tx)*f.olat;
      f.heading = Math.atan2(q.tx*sc2.dir, q.tz*sc2.dir);
    } else {
      // Lake: gentle wander around the school anchor + personal offset.
      var tx = sc2.ax + f.ox, tz = sc2.az + f.oz;
      var want = Math.atan2(tx - f.x, tz - f.z);
      var dh2 = want - f.heading;
      while (dh2 >  Math.PI) dh2 -= Math.PI*2;
      while (dh2 < -Math.PI) dh2 += Math.PI*2;
      f.heading += dh2 * Math.min(1, 3*dt);
      f.heading += (Math.random()-0.5) * 0.8 * dt;  // jitter
      spd = f.speed * (0.75 + 0.25*Math.sin(_t*1.3 + f.phase));
      f.x += Math.sin(f.heading) * spd * dt;
      f.z += Math.cos(f.heading) * spd * dt;
      // Stay inside the water: steer back at 85% of the ellipse edge.
      var qx = (f.x-sc2.cx)/sc2.rx, qz = (f.z-sc2.cz)/sc2.rz;
      if (qx*qx + qz*qz > 0.72){
        f.heading = Math.atan2(sc2.cx - f.x, sc2.cz - f.z);
      }
    }

    // Place the mesh just under the surface, wiggling.
    var mdx = px - f.x, mdz = pz - f.z;
    var nearAnim = (mdx*mdx + mdz*mdz) < AR2;  // NPC ANIM_R pattern
    var wl = 0;
    try { wl = waterLevelAt(f.x, f.z); } catch(e){}
    if (wl === null || wl === undefined){
      try { wl = heightAt(f.x, f.z) + 0.35; } catch(e2){ wl = 0; }
    }
    f.mesh.position.set(f.x, wl - 0.55, f.z);
    f.mesh.rotation.y = f.heading;
    // Tail wiggle only near the camera (NPC ANIM_R pattern); static pose beyond.
    f.mesh.rotation.z = nearAnim ? Math.sin(_t*9 + f.phase) * 0.18 : 0;
  }
}

/* ---------------------------------------------------------------------------
   Boot: poll for dependencies (THREE, scene, player, WATER), then stock
   fish and register the per-frame tick. Same boot-poll pattern as the
   other deferred modules — never blocks the game if deps never arrive.
   --------------------------------------------------------------------------- */
var _bootTries = 0;
var _rescanT = 0;
var _refreshT = 0;   // accumulator for the 0.5s streaming pass (NPC cadence)
var bootTimer = setInterval(function(){
  _bootTries++;
  var ready = false;
  try {
    ready = (typeof THREE !== 'undefined' && typeof scene !== 'undefined' &&
             typeof player !== 'undefined' && typeof WATER !== 'undefined' &&
             typeof inWater === 'function');
  } catch(e){ ready = false; }
  if (ready){
    clearInterval(bootTimer);
    try { _scanWater(); } catch(e){}
    try {
      if (window.Sim && typeof window.Sim.onTick === 'function' &&
          !window.__fishTickReg){
        window.__fishTickReg = true;
        // Re-scan for late water entries every ~5s, stream meshes every
        // 0.5s (NPC refreshSlots cadence), update fish every frame.
        window.Sim.onTick('render', 70, function(dt){
          try {
            _rescanT += dt;
            if (_rescanT > 5){ _rescanT = 0; _scanWater(); }
            _refreshT += dt;
            if (_refreshT > FISH_REFRESH_T){
              _refreshT = 0;
              var _px = 0, _pz = 0;
              try { _px = player.x; _pz = player.z; } catch(e){}
              _refreshMeshes(_px, _pz);
            }
            _updateFish(dt || 0.016);
          } catch(e){}
        });
      }
    } catch(e){}
    try {
      if (typeof Report !== 'undefined' && Report.setSys)
        Report.setSys('water_interaction', { status: 'ok', fish: fishes.length });
    } catch(e){}
  } else if (_bootTries > 240){  // 60s — give up quietly, never break the game
    clearInterval(bootTimer);
  }
}, 250);

/* Public API (index.html's sinking logic calls findShore). */
window.WaterInteraction = {
  findShore: findShore,
  fishCount: function(){ return fishes.length; }
};

})();
