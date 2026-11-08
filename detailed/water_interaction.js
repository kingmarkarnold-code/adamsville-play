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
        - Every other lake/pond: largemouth bass + bluegill, with
          redbreast sunfish and channel catfish mixed in (ui .24).
        - Chattahoochee River: largemouth bass, shoal bass, channel
          catfish, bluegill, redbreast sunfish. River fish swim ALONG the
          channel (upstream/downstream) instead of wandering.
        - CREEK TROUT (ui 2026.11.07.24, Joshua's 15:47 variety ruling):
          a non-Chattahoochee stream whose DATA depth can hold fish
          (adapter depthFt >= 4 — the depth map_loader computed from
          the surveyed surface minus the bed; Tatum Outlet Creek reads
          7) is stocked with creek trout. Shallow creeks (depthFt 2)
          stay fishless, as before.
        - FISH VARIETY (ui 2026.11.07.24): every species has its OWN
          two-tone colours (body + a distinct tail) and its own riding
          depth, so a mixed school reads as various species from above
          (through the see-in water) and underwater. NOTE: fish are
          NOT instanced here — meshes share per-species materials via
          _geoCache — so the variety is delivered by the palette, the
          two-tone split and the mixes, not by a per-instance colour
          attribute (that path belongs to the instanced butterflies).
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
   larger than life so they're visible). speed = cruise u/s.
   FISH VARIETY (ui 2026.11.07.24, Joshua 15:47 — "various species AND
   colors"): color = body, tail = the tail fin's own colour (two-tone,
   so a school reads mixed at a glance), depth = the species' preferred
   riding depth below the surface in units (sunfish high, catfish low).
   The old table failed the ruling on palette alone: bream, bluegill
   and bass were all the same murky green. The new spread is the
   Georgia set he named: largemouth bass (green), bluegill (blue/
   olive), channel catfish (grey-blue), crappie (silvery speckled —
   the dark tail carries the speckle read at this scale), sunfish
   (orange-breasted redbreast), and creek trout. */
var SPECIES = {
  bream:     { color: 0x5f8291, tail: 0x2e4a56, size: 0.55, speed: 2.0, depth: 0.55, label: 'bream' },
  crappie:   { color: 0xd3dde2, tail: 0x707d74, size: 0.60, speed: 1.8, depth: 0.80, label: 'crappie' },
  bass:      { color: 0x4e7a35, tail: 0x39543f, size: 0.85, speed: 2.6, depth: 0.90, label: 'largemouth bass' },
  bluegill:  { color: 0x5b7d8c, tail: 0x2f4a55, size: 0.50, speed: 2.0, depth: 0.50, label: 'bluegill' },
  shoalbass: { color: 0x6b7a3a, tail: 0x44512e, size: 0.80, speed: 2.8, depth: 0.90, label: 'shoal bass' },
  catfish:   { color: 0x64798c, tail: 0x49586a, size: 1.00, speed: 1.6, depth: 1.80, label: 'channel catfish' },
  redbreast: { color: 0x7d6a35, tail: 0xc4671f, size: 0.55, speed: 2.0, depth: 0.60, label: 'redbreast sunfish' },
  trout:     { color: 0x8f8552, tail: 0x745f36, size: 0.55, speed: 2.2, depth: 0.70, label: 'creek trout' }
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
    /* FISH VARIETY (ui 2026.11.07.24): the tail fin gets the species'
       SECOND colour — two-tone fish read as mixed species from above
       and underwater, where one flat colour read as one generic fish. */
    var matTail = new THREE.MeshLambertMaterial({ color: (typeof sp.tail === 'number') ? sp.tail : sp.color });
    _geoCache[key] = { body: bodyGeo, tail: tailGeo, mat: mat, matTail: matTail };
  }
  var c = _geoCache[key];
  var g = new THREE.Group();
  g.add(new THREE.Mesh(c.body, c.mat));
  g.add(new THREE.Mesh(c.tail, c.matTail));
  // Meshes are only created when the school streams in (NPC pattern), so
  // no visibility toggling is needed — presence in the scene means active.
  return g;
}

/* _lakeSpecies() — the generic lake/pond mix (ui 2026.11.07.24):
   bass and bluegill stay the backbone (Joshua's original spec), with
   redbreast sunfish regulars and channel catfish mixed in, so a lake
   school is visibly various. Tatum water does NOT use this — it keeps
   its bream+crappie ground truth (see _stockWater). */
function _lakeSpecies(){
  var r = Math.random();
  if (r < 0.38) return SPECIES.bass;
  if (r < 0.68) return SPECIES.bluegill;
  if (r < 0.85) return SPECIES.redbreast;
  return SPECIES.catfish;
}

/* ---------------------------------------------------------------------------
   DRAWN-RING CONTAINMENT (ui 2026.11.07.26, Joshua's 20:01 report:
   "fish are swimming above the ground OUTSIDE the water, between the
   two pieces of Tatum Lake"). THE OLD LAW WAS AN ELLIPSE: schools
   wandered an {x, z, rx, rz} ellipse fitted over the lake, and the
   mesh placer, when waterLevelAt() said "not water", still rendered
   the fish at heightAt + 0.35 — swimming in the air over dry land.
   An ellipse over an irregular lake covers the shore indentations
   and the ground between Tatum's two bodies, so fish legally
   wandered onto land inside "their" ellipse.
   THE NEW LAW IS JOSHUA'S MATERIAL DOCTRINE APPLIED TO FISH: the
   DRAWN water governs — the same outline ring the .4 drawn-ring
   test uses for the player's own swimming (the WATER entry's ring,
   carried from the package body; the legacy polygon rides along as
   w.polygon). Every lake/pond movement step (wander AND dart) tests
   its candidate position against the school's ring; a step that
   would leave the water is not taken — the fish turns back toward
   its anchor instead. Anchors and personal offsets are validated
   against the ring at stock time. And if a fish somehow finds
   waterLevelAt() null at its position, it is NOT rendered above the
   ground: its mesh hides and the fish recovers to a validated
   in-water point at its school. Rivers keep their channel/arc
   system (it already contains them) — this section is lakes/ponds
   only. Cost: one point-in-polygon per meshed fish per frame — the
   meshed set is the only set that ticks (NPC pattern). The ring is
   resolved once per school at stock time (sc.ring), never re-looked
   up per frame.
   --------------------------------------------------------------------------- */
function _pointInRing(px, pz, ring){
  /* Ray-casting point-in-polygon over a [[x,z],...] ring — the same
     test map_loader.js runs for the drawn water. */
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++){
    var xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > pz) !== (zj > pz)) &&
        (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

/* _ringSafePoint(ring, cx, cz) — a point PROVEN inside the ring: the
   centroid when it qualifies, else the first hit of a coarse grid
   scan over the ring's bounding box, else ring vertex 0 (a vertex is
   ON the water's edge — never on the far shore). Used as the stock
   fallback and the out-of-water recovery point. */
function _ringSafePoint(ring, cx, cz){
  if (_pointInRing(cx, cz, ring)) return { x: cx, z: cz };
  var mnx = 1e18, mxx = -1e18, mnz = 1e18, mxz = -1e18, i;
  for (i = 0; i < ring.length; i++){
    if (ring[i][0] < mnx) mnx = ring[i][0]; if (ring[i][0] > mxx) mxx = ring[i][0];
    if (ring[i][1] < mnz) mnz = ring[i][1]; if (ring[i][1] > mxz) mxz = ring[i][1];
  }
  var gx, gz, STEPS = 24;
  for (gx = 0; gx <= STEPS; gx++) for (gz = 0; gz <= STEPS; gz++){
    var px = mnx + (mxx - mnx) * gx / STEPS, pz = mnz + (mxz - mnz) * gz / STEPS;
    if (_pointInRing(px, pz, ring)) return { x: px, z: pz };
  }
  return { x: ring[0][0], z: ring[0][1] };
}

/* _pickRingPoint(ring, cx, cz, rx, rz, safe) — sample the old ellipse
   area until a point lands inside the drawn ring (bounded tries);
   fall back to the proven safe point. Stock-time only. */
function _pickRingPoint(ring, cx, cz, rx, rz, safe){
  for (var t = 0; t < 24; t++){
    var aa = Math.random()*Math.PI*2, ar = Math.random()*0.85;
    var px = cx + Math.cos(aa)*ar*rx, pz = cz + Math.sin(aa)*ar*rz;
    if (_pointInRing(px, pz, ring)) return { x: px, z: pz };
  }
  return safe;
}

/* _stockWater(w) — stock one lake/pond's fish, in schools of 4-6.
   w: a WATER entry with {x, z, rx, rz, name} (lake/pond ellipse) —
   and, in the package build, {ring} (the drawn outline; the legacy
   renderer carries it as {polygon}). When a ring is present it is
   the containment law (ui .26, above); the ellipse remains the
   fallback for an entry that carries no outline.
   PURE DATA — no meshes (NPC pattern: meshes stream in when near). */
function _stockWater(w){
  if (_spawnedOn.indexOf(w) >= 0) return;
  _spawnedOn.push(w);
  var cx = w.x, cz = w.z, rx = w.rx || 30, rz = w.rz || 30;
  var ring = (w.ring && w.ring.length > 2) ? w.ring
           : ((w.polygon && w.polygon.length > 2) ? w.polygon : null);
  var safe = ring ? _ringSafePoint(ring, cx, cz) : { x: cx, z: cz };
  // Headcount scales with water size (stylized — real lakes hold thousands).
  var n = Math.round(Math.sqrt(rx * rz) / 4);
  n = Math.max(MIN_FISH_PER_BODY, Math.min(MAX_FISH_PER_BODY, n));
  var tatum = _isTatumWater(w.name);
  var schoolCount = Math.max(1, Math.round(n / 5));
  for (var s = 0; s < schoolCount; s++){
    /* School anchor: a random spot inside the ellipse — and, when a
       ring governs, VALIDATED inside the drawn water (re-picked
       until inside; the safe point is the bounded fallback). */
    var aa = Math.random()*Math.PI*2, ar = Math.random()*0.5;
    var ax = cx + Math.cos(aa)*ar*rx, az = cz + Math.sin(aa)*ar*rz;
    if (ring && !_pointInRing(ax, az, ring)){
      var ap = _pickRingPoint(ring, cx, cz, rx, rz, safe);
      ax = ap.x; az = ap.z;
    }
    var school = {
      kind: 'lake',
      cx: cx, cz: cz, rx: rx, rz: rz,
      ring: ring, safeX: safe.x, safeZ: safe.z,
      ax: ax, az: az,
      heading: Math.random()*Math.PI*2,
      _meshed: false   // NPC pattern: meshes stream in only when near
    };
    schools.push(school);
    var per = Math.ceil(n / schoolCount);
    for (var f = 0; f < per; f++){
      // Species mix per water body.
      var sp;
      if (tatum) sp = (Math.random() < 0.5) ? SPECIES.bream : SPECIES.crappie;
      else       sp = _lakeSpecies();
      /* Personal offset: validated the same way — an offset that
         would put the fish on land is re-picked (bounded), else the
         fish rides at the anchor itself. */
      var fa = Math.random()*Math.PI*2, fr = 2 + Math.random()*6;
      var ox = Math.cos(fa)*fr, oz = Math.sin(fa)*fr;
      if (ring && !_pointInRing(school.ax + ox, school.az + oz, ring)){
        ox = 0; oz = 0;
        for (var ot2 = 0; ot2 < 12; ot2++){
          var fa2 = Math.random()*Math.PI*2, fr2 = 2 + Math.random()*6;
          var ox2 = Math.cos(fa2)*fr2, oz2 = Math.sin(fa2)*fr2;
          if (_pointInRing(school.ax + ox2, school.az + oz2, ring)){ ox = ox2; oz = oz2; break; }
        }
      }
      fishes.push({
        mesh: null,  // streamed in when the player comes in range
        x: school.ax + ox, z: school.az + oz,
        heading: Math.random()*Math.PI*2,
        speed: sp.speed, species: sp, school: school,
        dartT: 0, phase: Math.random()*Math.PI*2,
        dOff: (Math.random()-0.5)*0.3,  // ui .24: personal depth jitter
        ox: ox, oz: oz  // personal offset from anchor (ring-validated, ui .26)
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

/* _isTroutCreek(w) — CREEK TROUT gate (ui 2026.11.07.24, Joshua's
   15:47 ruling: "creek trout where creeks are deep enough to hold
   fish at all"). The gate reads the entry's DATA depth: depthFt is
   the figure map_loader's adapter computed from the surveyed surface
   profile minus the terrain bed (max over stations, feet). A creek
   whose deepest water is under 4 ft holds no fish; Tatum Outlet
   Creek reads 7 (its falls plunge runs 2.03 m) and qualifies, the
   legacy home creek reads 2 and does not. The Chattahoochee is
   excluded — it has its own mix. */
function _isTroutCreek(w){
  if (!w || !w.river || _isChattahoochee(w.name)) return false;
  return (typeof w.depthFt === 'number' && w.depthFt >= 4);
}
/* _troutSpecies() — a qualifying creek holds creek trout. */
function _troutSpecies(){
  return SPECIES.trout;
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

/* _stockRiver(w, picker) — stock a river/creek along its channel.
   w: {river: pts, width, name}. picker: the species function —
   _chattahoocheeSpecies for the river, _troutSpecies for a trout
   creek; defaults to the Chattahoochee mix.
   Schools anchor at arc-length positions along the channel; each fish holds
   a personal arc offset (ot) and lateral offset (olat) inside the ribbon.
   PURE DATA — no meshes (NPC pattern). */
function _stockRiver(w, picker){
  if (_spawnedOn.indexOf(w) >= 0) return;
  _spawnedOn.push(w);
  var pick = (typeof picker === 'function') ? picker : _chattahoocheeSpecies;
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
      var sp = pick();
      var ot = (Math.random()-0.5)*60;        // personal arc offset (u)
      var olat = (Math.random()-0.5)*2*halfW; // personal lateral offset (u)
      var pos = _pointAtArc(pts, cum, t0+ot);
      fishes.push({
        mesh: null,  // streamed in when the player comes in range
        x: pos.x + (-pos.tz)*olat, z: pos.z + (pos.tx)*olat,
        heading: school.heading,
        speed: sp.speed, species: sp, school: school,
        dartT: 0, phase: Math.random()*Math.PI*2,
        dOff: (Math.random()-0.5)*0.3,  // ui .24: personal depth jitter
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
        // Chattahoochee gets channel fish; a creek deep enough in the
        // data gets creek trout (ui .24); other rivers/streams stay
        // fishless.
        if (_isChattahoochee(w.name)) _stockRiver(w);
        else if (_isTroutCreek(w)) _stockRiver(w, _troutSpecies);
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
            /* ui .26: the stream-in snap obeys the ring too — an
               anchor that drifted while data-only plus a personal
               offset can land outside the drawn water; fall back to
               the school's validated safe point. */
            if (sc.ring && !_pointInRing(f.x, f.z, sc.ring)){
              f.x = sc.safeX; f.z = sc.safeZ;
            }
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
      // Lake: slow wander of the anchor inside 70% of the ellipse —
      // and, when a drawn ring governs (ui .26), the candidate must
      // also be inside the ring: an anchor may never drift onto land
      // the ellipse happens to cover.
      sc.heading += (Math.random()-0.5) * 1.6 * dt;
      var sp = 0.8;  // slow drift u/s
      var nx = sc.ax + Math.cos(sc.heading)*sp*dt;
      var nz = sc.az + Math.sin(sc.heading)*sp*dt;
      var ex = (nx-sc.cx)/(sc.rx*0.7), ez = (nz-sc.cz)/(sc.rz*0.7);
      var anchorOk = (ex*ex + ez*ez < 1) &&
                     (!sc.ring || _pointInRing(nx, nz, sc.ring));
      if (anchorOk){ sc.ax = nx; sc.az = nz; }
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
      var dcx = f.x + Math.sin(f.heading) * spd * dt;
      var dcz = f.z + Math.cos(f.heading) * spd * dt;
      if (sc2.kind === 'lake' && sc2.ring && !_pointInRing(dcx, dcz, sc2.ring)){
        /* ui .26: a dart may not carry a lake fish onto land — the
           step is refused and the fish turns back toward its anchor
           (turn, don't teleport). */
        f.heading = Math.atan2(sc2.ax - f.x, sc2.az - f.z);
      } else {
        f.x = dcx; f.z = dcz;
      }
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
      var wcx = f.x + Math.sin(f.heading) * spd * dt;
      var wcz = f.z + Math.cos(f.heading) * spd * dt;
      if (sc2.ring && !_pointInRing(wcx, wcz, sc2.ring)){
        /* ui .26: THE DRAWN RING IS THE LAW — a wander step that
           would leave the water is not taken; steer back toward the
           school anchor instead. (Turn, don't teleport.) */
        f.heading = Math.atan2(sc2.ax - f.x, sc2.az - f.z);
      } else {
        f.x = wcx; f.z = wcz;
        // Stay inside the water: steer back at 85% of the ellipse edge.
        var qx = (f.x-sc2.cx)/sc2.rx, qz = (f.z-sc2.cz)/sc2.rz;
        if (qx*qx + qz*qz > 0.72){
          f.heading = Math.atan2(sc2.cx - f.x, sc2.cz - f.z);
        }
      }
    }

    // Place the mesh in the water column, wiggling.
    var mdx = px - f.x, mdz = pz - f.z;
    var nearAnim = (mdx*mdx + mdz*mdz) < AR2;  // NPC ANIM_R pattern
    var wl = 0;
    try { wl = waterLevelAt(f.x, f.z); } catch(e){}
    if (wl === null || wl === undefined){
      if (sc2.kind === 'lake'){
        /* ui .26: OUT OF WATER — the old code rendered the fish at
           heightAt + 0.35 here, which is the "swimming in the air"
           Joshua saw. A lake fish out of water is NEVER rendered
           above ground: hide the mesh and recover the fish to its
           school's validated in-water point. If even that reads dry
           this frame, stay hidden and unplaced — next frame retries. */
        try { f.mesh.visible = false; } catch(e){}
        f.x = (typeof sc2.safeX === 'number') ? sc2.safeX : sc2.ax;
        f.z = (typeof sc2.safeZ === 'number') ? sc2.safeZ : sc2.az;
        try { wl = waterLevelAt(f.x, f.z); } catch(e){}
        if (wl === null || wl === undefined) continue;
      } else {
        /* Rivers keep their channel system (and its legacy fallback). */
        try { wl = heightAt(f.x, f.z) + 0.35; } catch(e2){ wl = 0; }
      }
    }
    /* Back in water: a fish hidden by the recovery above shows again. */
    if (f.mesh.visible === false){ try { f.mesh.visible = true; } catch(e){} }
    /* FISH VARIETY (ui 2026.11.07.24): each species rides at its OWN
       depth (catfish low over the bed, sunfish near the surface) plus
       a per-fish jitter — the old code pinned every fish at wl-0.55,
       one flat layer. The bed clamp keeps a fish out of the bed in
       shallow water (a creek trout in 0.6 m of water rides low but
       never underground), and the surface cap keeps it submerged. */
    var fDepth = (f.species && typeof f.species.depth === 'number') ? f.species.depth : 0.55;
    var fy = wl - fDepth + (f.dOff || 0);
    try {
      var bedY = heightAt(f.x, f.z);
      if (typeof bedY === 'number'){
        if (fy < bedY + 0.22) fy = bedY + 0.22;
        if (fy > wl - 0.18) fy = wl - 0.18;
      }
    } catch(e){}
    f.mesh.position.set(f.x, fy, f.z);
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
