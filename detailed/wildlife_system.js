/* ============================================================================
   WILDLIFE SYSTEM v1.0 (2026-11-07) — Georgia wildlife as real creatures.
   Joshua's design, from his Nov 7 play-test notes and rulings:

   - Birds are CREATURES, not sound effects: they perch IN TREES, sing
     from where they sit (positional — louder as you approach, like the
     water), and flush when you get close, each species with its own
     nerve. The old timer-chirps in ambient_audio.js are retired; this
     module owns every bird sound, sung through __AMB.voice() so it
     rides the ambient master/mute path.
   - Species native to Georgia: Northern Cardinal, Carolina Wren,
     Mourning Dove, Eastern Bluebird, Tufted Titmouse, Brown Thrasher
     (the state bird — visible-only in v1: its song is 1,000+ doubled
     phrases and a fake synth would be cheese, per the research pass).
   - The same system carries squirrels, chipmunks, deer and
     butterflies, mostly AWAY FROM HOUSES (habitat gating): deer and
     chipmunks keep to the woods, a deer crosses a road ONLY when
     wooded habitat waits on the far side, and everything comes down
     to the water to drink now and then. Birds bathe in the shallows.

   ANIMATION ARCHITECTURE (Joshua approved this specifically, after
   his "why was the old bird fleet heavy" research):
   - Bird wing flap is a FORMULA IN THE VERTEX SHADER (hinge weight
     attribute x sin(time x flapHz + per-instance phase) x amplitude).
     Per-frame CPU for flapping: one shared time uniform. Perched
     birds carry amplitude 0 + a fold weight, written only on state
     change. Instance matrices update per frame ONLY for birds in
     flight. (The 2026-10-10 fleet died of 1,500 hand-composed
     matrices/frame for 500 birds — this design never composes a
     matrix for a bird that isn't moving.)
   - Butterflies are FULLY GPU: anchor + seed are instanced
     attributes; position (closed-form wander), heading and flap are
     computed in the vertex shader from the time uniform. Zero CPU
     per butterfly per frame, forever.
   - Squirrel/chipmunk gait is a DISTANCE-DRIVEN formula (Minecraft's
     limbSwing pattern): hop phase advances with distance travelled,
     so the motion is a property the creature carries, not a decision.
   - Deer are the one multi-bone creature (Quaternius CC0 model,
     wildlife/Deer.glb) and keep real clips under an AnimationMixer
     with update-rate LOD: full rate < 40 u, half rate 40–80 u,
     frozen beyond. Never more than 4 deer, one group.
   - Decisions (perch choice, flush checks, drink desire) run on a
     staggered 2–5 Hz per-creature think, never per frame.

   STREAMING — the fish pattern (water_interaction.js), exactly:
   creatures are pure data until near; meshes stream in at 150 u,
   out at 200 u (hysteresis); animation only within 80 u; the
   streaming sweep runs every 0.5 s. Territories are anchored to
   habitat patches near the player, so cost follows the player's
   radius, not the world's population.

   PERCHES ARE DERIVED FROM THE TREE MATH: buildPkgTrees (index.html)
   places every near-field tree by a deterministic hash of its NLCD
   canopy cell. This module recomputes the same anchors and crown
   centres from the same formulas (see deriveTreesInCell), so a bird
   sits in the crown of the very tree the game draws. __WILDLIFE
   .parityCheck() proves it live against the built tiles' own trunk
   records; the batch harness proves it headless.

   Depends on globals: THREE, scene, player, Sim, heightAt,
   MapFrame, __PKG_CANOPY, __PKG_WATER, __AMB. Fully defensive: if
   anything is missing the module quietly does nothing — the game
   never breaks because of wildlife.
   ============================================================================ */
(function WildlifeSystem(){
'use strict';

/* ---------------------------------------------------------------------------
   Constants — streaming radii/caps follow the fish/NPC pattern.
   --------------------------------------------------------------------------- */
var SPAWN_R = 150, DESPAWN_R = 200, ANIM_R = 80, SWEEP_S = 0.5;
var CAPS = { bird: 10, squirrel: 6, chipmunk: 6, deer: 4, butterfly: 8 };
var CAP_BIRDS = CAPS.bird, CAP_SQUIRRELS = CAPS.squirrel,
    CAP_CHIPMUNKS = CAPS.chipmunk, CAP_BFLY = CAPS.butterfly;
var SONG_R = 40;            /* bird song is a near phenomenon (design) */
var SONG_GAIN = 0.32;       /* v1.2 (Joshua 2026-11-07, live play:
   v1.1's 0.6 was not enough — "they're pretty loud because of their
   pitch", so he first asked another 20% off, then ruled the value
   outright: "instead of the birds being at point 48, let's put them
   at point 32"). One master trim on bird SONG — 68% off every
   species' original peak, applied inside the distance law at both
   sites that use it, so the falloff SHAPE (songPeak *
   (1-d/SONG_R)^1.6) is unchanged. A bird at your shoulder is still
   clearly there; it just no longer rides over everything else.
   The value is his chosen cut for the perceived loudness — the
   PITCH itself is deliberately NOT shifted. Song only — the dove's
   flush whistle, squirrel chatter and every ambient_audio level
   (insects, water, wind) are untouched. */
/* Deer tuning (Joshua's rulings, 2026-11-07): deep habitat only,
   far from houses, no road near the anchor; head-up alert inside
   ~25u, gallop flight inside ~12u. */
var DEER_H = 1.62;          /* runtime units, ground to head top */
var DEER_BUILD_MIN = 60;    /* anchor distance from any building */
var DEER_ROAD_MIN = 25;     /* anchor distance from any road */
var DEER_WOODS_MIN = 45;    /* woods score (mean cover) at anchor */
var DEER_ALERT_R = 25, DEER_FLEE_R = 12;
var DEER_WALK_SPEED = 1.1, DEER_FLEE_SPEED = 7.5;
/* WILDNESS (Joshua's amendment, 2026-11-07 16:36, from his own
   play: "Because there are no houses or streets, I should be
   seeing deer more frequently."): deer presence scales with how
   WILD the ground is. Wildness is read off the two development
   axes the ruling names — distance to the nearest BUILDING and
   distance to the nearest ROAD. Each axis runs from tame (0) at
   the existing spawn minima (DEER_BUILD_MIN / DEER_ROAD_MIN) to
   fully wild (1) DEER_WILD_R units beyond it, and the LESS wild
   axis governs: a meadow far from houses but beside a highway is
   not wild country. Wildness drives how many deer form a group,
   how close they let the player come before alerting/fleeing,
   and how wide they graze — the state machine and the road rule
   are untouched. Evaluated at spawn time only (memoised on a
   coarse cell grid), never per frame. */
var DEER_WILD_R = 120;      /* units past the spawn minima for an
                               axis to count as fully wild */
var DEER_WILD_BOLD = 0.3;   /* at full wildness the alert/flee
                               radii shrink to 70% — deep-country
                               deer hold their ground longer, so
                               they stay a visible sight instead of
                               vanishing at first sight of you */
/* The player's live position object (re-read every tick from the
   game's own player); a plain placeholder until the first tick. */
var playerPos = { x: 0, y: 0, z: 0 };
var VERSION = '1.4';        /* wildlife system version (__WILDLIFE);
   1.1 = the SONG_GAIN trim (Joshua 2026-11-07, birds down some);
   1.2 = SONG_GAIN 0.6 -> 0.32 (Joshua 2026-11-07: "put them at
   point 32");
   1.3 = WILDLIFE PASS (Joshua 2026-11-07, from his hands on .20):
   squirrels BROWN not gray (16:25 ruling); butterflies get real
   per-instance colour variety — six Georgia species through a
   dedicated iColor attribute (16:25); deer density follows
   WILDNESS (16:36) — see the DEER_WILD block below.
   1.4 = WILDLIFE LOOKS PASS (Joshua 2026-11-07 20:01, from his
   hands on .5–.21): birds and squirrels REMODELLED from blocky
   primitives (octahedron body, box tail, flat rectangle wings,
   bent-cone squirrel tail) into shaped, smooth-shaded forms —
   tapered lathe-like bird bodies, fan tails, tapered swept
   wings, an ellipsoid squirrel with muzzle/ears/legs and a
   curved tube tail over its back. MODEL ONLY: behaviour,
   species, colours, the aWing/iFlap flap-shader contract, the
   perch derivation and every animation interface are exactly
   as 1.3 left them. Budgets: bird <= ~600 tris, squirrel
   <= ~1,500 tris (measured in this pass's harness). */
/* The game's player is a global OBJECT ({ x, z, yaw, ... }); some
   rigs also carry a .position Vector3. Either way playerPos ends
   up as an { x, z }-shaped reference the thinks can read. */
function gamePlayer(){
  try { return (typeof player !== 'undefined' && player) ? player : null; }
  catch(e){ return null; }
}
var OS = 1.88 / 1.8;        /* object scale: world units per metre —
                               the SAME constant buildPkgTrees uses */

/* Shared shader clock: ONE uniform object handed to every wildlife
   material; the tick writes it once per frame. */
var U_TIME = { value: 0 };

var _t = 0;                 /* module clock (s) */
var _started = false;

/* Small helpers ------------------------------------------------------------ */
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function lerp(a, b, f){ return a + (b - a) * f; }
function rand(a, b){ return a + Math.random() * (b - a); }
function dist2d(ax, az, bx, bz){
  var dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}
/* th(a, b, k) — the tree placement hash, VERBATIM from buildPkgTrees
   (index.html): placement is a pure hash of the canopy cell + tree
   index, so the same tree stands in the same spot every visit, and
   this module's derivation matches the game's own drawing. */
function th(a, b, k){
  var x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453;
  return x - Math.floor(x);
}
function gameMin(){
  try{
    if (window.__daycycle && isFinite(window.__daycycle.gameMin))
      return window.__daycycle.gameMin;
  }catch(e){}
  return 720;
}
function isDay(){ var gm = gameMin(); return gm >= 360 && gm <= 1200; }
function groundY(x, z){
  /* The trees' own seating rule: analytic height, raised to the
     drawn mesh where the mesh sits higher. */
  var gy = 0;
  try { gy = heightAt(x, z); } catch(e){ return null; }
  try {
    if (typeof terrainMeshY === 'function'){
      var my = terrainMeshY(x, z);
      if (typeof my === 'number' && isFinite(my) && my > gy) gy = my;
    }
  } catch(e){}
  return gy;
}
function matAt(x, z){
  try{
    if (typeof getMaterialAt === 'function' &&
        typeof COLLISION_MATERIALS !== 'undefined')
      return getMaterialAt(x, z, true);
  }catch(e){}
  return (typeof COLLISION_MATERIALS !== 'undefined')
    ? COLLISION_MATERIALS.GRASS : 5;
}
function isGrass(x, z){
  return (typeof COLLISION_MATERIALS !== 'undefined')
    ? matAt(x, z) === COLLISION_MATERIALS.GRASS
    : true;
}

/* ---------------------------------------------------------------------------
   PERCH DERIVATION — recompute buildPkgTrees' trees for a canopy cell.
   The formulas below are buildTile's own (index.html, 2026-11-07):
   per cell (cc, rr) with cover >= threshold, tree k's anchor sits at
   the cell centre plus a hash jitter of ±4 package metres; its size
   hashes ride k-offsets 30/40/50/60; the crown centre is at
   gy + folBot + (H - folBot) * 0.46 with H from the cover fraction.
   Returns runtime-frame records:
   { x, z, gy, f, leanX, leanZ, H, folBot,
     crownX, crownY, crownZ, crownR,
     perchX, perchY, perchZ }
   Filters match buildTile's: the drawn-water clearance and the
   grass mesh-bond are applied when those tests exist, so a derived
   tree the game refused to draw is never offered as a perch.
   --------------------------------------------------------------------------- */
function deriveTreesInCell(cc, rr){
  var out = [];
  var C = window.__PKG_CANOPY, MF = window.MapFrame;
  if (!C || !C.cover || !MF) return out;
  if (cc < 0 || rr < 0 || cc >= C.cols || rr >= C.rows) return out;
  var cov = C.cover[rr * C.cols + cc];
  var THR = C.threshold || 30;
  if (cov < THR) return out;
  var f = cov / 100;
  var expect = f * 3.2;
  var n = Math.floor(expect) +
    ((th(cc, rr, 5) < expect - Math.floor(expect)) ? 1 : 0);
  if (n > 4) n = 4;
  for (var k = 0; k < n; k++){
    var pkx = C.x0 + (cc + 0.5) * C.cellM + (th(cc, rr, 10 + k) - 0.5) * 8;
    var pkz = C.z0 + (rr + 0.5) * C.cellM + (th(cc, rr, 20 + k) - 0.5) * 8;
    var rt = MF.pkgToRuntime(pkx, pkz);
    var gy = groundY(rt.x, rt.z);
    if (gy === null || !isFinite(gy)) continue;
    try{
      if (typeof waterClearForTree === 'function' &&
          !waterClearForTree(rt.x, rt.z, 3)) continue;
    }catch(e){}
    try{
      if (typeof treeGroundIsGrass === 'function' &&
          !treeGroundIsGrass(rt.x, rt.z)) continue;
    }catch(e){}
    var hs = [th(cc, rr, 30 + k), th(cc, rr, 40 + k),
              th(cc, rr, 50 + k), th(cc, rr, 60 + k)];
    var topM = (10 + 14 * f) * (0.82 + 0.36 * hs[0]);
    var H = topM * OS;
    var folBot = 2.44 * OS;
    var leanX = (hs[1] - 0.5) * 0.35, leanZ = (hs[2] - 0.5) * 0.35;
    var cy = gy + folBot + (H - folBot) * 0.46;
    var rv = (H - folBot) * 0.40;
    /* Perch: in the crown's upper half, offset by the tree's own
       hashes so different birds favour different spots in a crown. */
    var px = rt.x + leanX + (th(cc, rr, 70 + k) - 0.5) * rv * 0.9;
    var pz = rt.z + leanZ + (th(cc, rr, 80 + k) - 0.5) * rv * 0.9;
    out.push({
      x: rt.x, z: rt.z, gy: gy, f: f,
      leanX: leanX, leanZ: leanZ, H: H, folBot: folBot,
      crownX: rt.x + leanX, crownY: cy, crownZ: rt.z + leanZ,
      crownR: rv,
      perchX: px, perchY: cy + rv * 0.42, perchZ: pz,
      cc: cc, rr: rr, k: k
    });
  }
  return out;
}
/* deriveTreesNear(x, z, radius) — every derived tree whose anchor is
   within `radius` (runtime units) of a runtime point. Converts the
   search disc to package cells (the frame is axis-monotonic, the
   same assumption buildTreeBondRaster makes) and scans the cells. */
function deriveTreesNear(x, z, radius){
  var out = [];
  var C = window.__PKG_CANOPY, MF = window.MapFrame;
  if (!C || !C.cover || !MF) return out;
  var pA = MF.runtimeToPkg(x - radius, z - radius);
  var pB = MF.runtimeToPkg(x + radius, z + radius);
  var cc0 = clamp(Math.floor((Math.min(pA.x, pB.x) - C.x0) / C.cellM), 0, C.cols - 1);
  var cc1 = clamp(Math.floor((Math.max(pA.x, pB.x) - C.x0) / C.cellM), 0, C.cols - 1);
  var rr0 = clamp(Math.floor((Math.min(pA.z, pB.z) - C.z0) / C.cellM), 0, C.rows - 1);
  var rr1 = clamp(Math.floor((Math.max(pA.z, pB.z) - C.z0) / C.cellM), 0, C.rows - 1);
  for (var rr = rr0; rr <= rr1; rr++)
    for (var cc = cc0; cc <= cc1; cc++){
      var ts = deriveTreesInCell(cc, rr);
      for (var i = 0; i < ts.length; i++)
        if (dist2d(ts[i].x, ts[i].z, x, z) <= radius + 12) out.push(ts[i]);
    }
  return out;
}
/* canopyCoverAt(x, z) — NLCD cover % at a runtime point, -1 when the
   point is outside the grid or the canopy data is absent. */
function canopyCoverAt(x, z){
  var C = window.__PKG_CANOPY, MF = window.MapFrame;
  if (!C || !C.cover || !MF) return -1;
  var p = MF.runtimeToPkg(x, z);
  var cc = Math.floor((p.x - C.x0) / C.cellM);
  var rr = Math.floor((p.z - C.z0) / C.cellM);
  if (cc < 0 || rr < 0 || cc >= C.cols || rr >= C.rows) return -1;
  return C.cover[rr * C.cols + cc];
}
/* woodsScore(x, z, r) — mean cover and wooded fraction over the
   centre + a ring of samples. The habitat currency of the system. */
function woodsScore(x, z, r){
  var pts = [[x, z]];
  for (var i = 0; i < 6; i++){
    var a = i / 6 * Math.PI * 2;
    pts.push([x + Math.cos(a) * r, z + Math.sin(a) * r]);
  }
  var sum = 0, n = 0, wooded = 0, THR = 30;
  try{ THR = (window.__PKG_CANOPY && window.__PKG_CANOPY.threshold) || 30; }catch(e){}
  for (var j = 0; j < pts.length; j++){
    var c = canopyCoverAt(pts[j][0], pts[j][1]);
    if (c < 0) continue;
    sum += c; n++;
    if (c >= THR) wooded++;
  }
  if (!n) return { mean: 0, frac: 0 };
  return { mean: sum / n, frac: wooded / n };
}
/* buildingDist(x, z) — distance to the nearest building footprint
   edge. __PKG_BUILDINGS entries are [cx, cz, w, d, h, type] (the
   legacy-globals shape from map_loader). Infinity when the package
   carries no buildings (the current partial package). */
function buildingDist(x, z){
  var best = Infinity;
  try{
    var B = window.__PKG_BUILDINGS || [];
    for (var i = 0; i < B.length; i++){
      var b = B[i];
      if (!b || typeof b[0] !== 'number') continue;
      var rad = Math.max(b[2] || 1, b[3] || 1) / 2;
      var d = dist2d(x, z, b[0], b[1]) - rad;
      if (d < best) best = d;
    }
  }catch(e){}
  return best;
}
/* roadDistAt(x, z) — approximate distance to the nearest ROAD
   material: probe rings of 8 points at growing radii against the
   ONE material lookup and report the first ring that touches a
   road. -1 when no ring out to 150 u touches one (open country
   as far as deer care). The radii step by 10 u — deliberately
   finer than a road is wide, so a thin street cannot hide
   between two rings (the first probe draft stepped 30–40 u at
   the far end and jumped clean over a 10 u band in harness).
   The answer is the road's distance rounded up to a ring —
   plenty for a wildness judgement. Spawn-time only, memoised
   through wildnessAt; reuses matAt like everything else here,
   no new world scan. */
var ROAD_PROBE_R = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
                    110, 120, 130, 140, 150];
function roadDistAt(x, z){
  if (typeof COLLISION_MATERIALS === 'undefined') return -1;
  var ROAD = COLLISION_MATERIALS.ROAD;
  for (var ri = 0; ri < ROAD_PROBE_R.length; ri++){
    var r = ROAD_PROBE_R[ri];
    for (var a = 0; a < 8; a++){
      if (matAt(x + Math.cos(a * Math.PI / 4) * r,
                z + Math.sin(a * Math.PI / 4) * r) === ROAD)
        return r;
    }
  }
  return -1;
}
/* wildnessAt(x, z) — Joshua's 16:36 measure (see DEER_WILD_R):
   0 = tame, 1 = deep wild country. The building axis runs off
   buildingDist (Infinity when the package carries no buildings —
   that axis is then fully wild and the road axis alone decides);
   the road axis runs off roadDistAt. The LESS wild axis governs.
   Memoised on a 25 u cell grid for 60 s of module time (the
   anchorGate pattern from the funnel build): deer spawn asks
   about clusters of neighbouring candidates, and a wildness
   verdict is a property of the GROUND, not the moment — it does
   not need re-proving per candidate. */
var _wildCache = {};
function wildnessAt(x, z){
  var key = Math.round(x / 25) + ',' + Math.round(z / 25);
  var hit = _wildCache[key];
  if (hit && _t - hit.t < 60) return hit.w;
  var bd = buildingDist(x, z);
  var rd = roadDistAt(x, z);
  var wb = clamp((bd - DEER_BUILD_MIN) / DEER_WILD_R, 0, 1);
  var wr = rd < 0 ? 1 : clamp((rd - DEER_ROAD_MIN) / DEER_WILD_R, 0, 1);
  var w = Math.min(wb, wr);
  _wildCache[key] = { w: w, t: _t };
  return w;
}
/* roadCrossing(x0, z0, x1, z1) — sample the segment every ~2 u
   against the ONE material lookup; returns where road material
   starts/ends along the segment, or null when it never crosses. */
function roadCrossing(x0, z0, x1, z1){
  if (typeof COLLISION_MATERIALS === 'undefined') return null;
  var ROAD = COLLISION_MATERIALS.ROAD;
  var len = dist2d(x0, z0, x1, z1);
  var steps = Math.max(1, Math.ceil(len / 2));
  var first = -1, last = -1;
  for (var i = 0; i <= steps; i++){
    var f = i / steps;
    if (matAt(lerp(x0, x1, f), lerp(z0, z1, f)) === ROAD){
      if (first < 0) first = f;
      last = f;
    }
  }
  if (first < 0) return null;
  return { first: first, last: last, len: len };
}
/* deerRouteOk(x0, z0, x1, z1) — JOSHUA'S ROAD RULE (2026-11-07):
   a deer may cross a road ONLY to reach wooded habitat on the far
   side. Returns { ok, peekAt }:
     ok true  — no crossing at all, or the far side (the ground
                just past the road, along the same line) is woods.
     ok false — refused; peekAt is the last grass point on the
                NEAR side before the road, where the deer may
                stand at the tree line and look out (the edge-peek
                Joshua allowed) without crossing. peekAt is null
                when no grass point exists before the road. */
function deerRouteOk(x0, z0, x1, z1){
  var cross = roadCrossing(x0, z0, x1, z1);
  if (!cross) return { ok: true, peekAt: null };
  var dx = x1 - x0, dz = z1 - z0;
  var L = Math.sqrt(dx * dx + dz * dz) || 1;
  var ux = dx / L, uz = dz / L;
  /* just past the road's far edge, and a little deeper */
  var ex = x0 + ux * (cross.last * L + 3), ez = z0 + uz * (cross.last * L + 3);
  var fx = x0 + ux * (cross.last * L + 16), fz = z0 + uz * (cross.last * L + 16);
  var THR = 30;
  try{ THR = (window.__PKG_CANOPY && window.__PKG_CANOPY.threshold) || 30; }catch(e){}
  if (canopyCoverAt(ex, ez) >= THR || canopyCoverAt(fx, fz) >= THR ||
      woodsScore(fx, fz, 10).mean >= THR)
    return { ok: true, peekAt: null };
  /* blocked: find the tree-line peek point — step back from the
     road's near edge along the route until the ground is grass */
  var pd = Math.max(0, cross.first * L - 1.5);
  for (var i = 0; i < 6 && pd > 0; i++){
    var px = x0 + ux * pd, pz = z0 + uz * pd;
    if (isGrass(px, pz))
      return { ok: false, peekAt: { x: px, z: pz } };
    pd -= 1.2;
  }
  return { ok: false, peekAt: null };
}

/* ---------------------------------------------------------------------------
   SHORE FINDING — drink/bathe points on the package's own water data.
   nearestShore(x, z, maxR): the closest water edge to a point.
   Returns { bankX, bankZ, waterX, waterZ, y, name, kind } or null:
   the BANK point is dry ground at the edge (a drinker stands there);
   the WATER point is just inside the shallows (a bather stands in
   it). Bodies measure to their drawn ring; streams to their spine
   with the local half width.
   --------------------------------------------------------------------------- */
function nearestShore(x, z, maxR){
  var best = null, bestD = maxR || 80;
  function consider(bx, bz, wx, wz, y, name, kind, d){
    if (d < bestD){
      bestD = d;
      best = { bankX: bx, bankZ: bz, waterX: wx, waterZ: wz,
               y: y, name: name || '', kind: kind };
    }
  }
  try{
    var PW = window.__PKG_WATER;
    if (PW){
      var i, j;
      for (i = 0; i < (PW.bodies || []).length; i++){
        var b = PW.bodies[i];
        if (!b.ring || b.ring.length < 3) continue;
        if (dist2d(x, z, b.x, b.z) > Math.max(b.rx, b.rz) + bestD) continue;
        for (j = 0; j < b.ring.length; j++){
          var A = b.ring[j], Bp = b.ring[(j + 1) % b.ring.length];
          var abx = Bp[0] - A[0], abz = Bp[1] - A[1];
          var l2 = abx * abx + abz * abz || 1;
          var tt = clamp(((x - A[0]) * abx + (z - A[1]) * abz) / l2, 0, 1);
          var qx = A[0] + abx * tt, qz = A[1] + abz * tt;
          var d = dist2d(x, z, qx, qz);
          if (d >= bestD) continue;
          /* outward = away from the body centre */
          var ox = qx - b.x, oz = qz - b.z;
          var ol = Math.sqrt(ox * ox + oz * oz) || 1;
          ox /= ol; oz /= ol;
          var y = (typeof b.surfaceY === 'number') ? b.surfaceY
                : (groundY(qx, qz) || 0) + 0.35;
          consider(qx + ox * 0.7, qz + oz * 0.7,
                   qx - ox * 0.8, qz - oz * 0.8,
                   y, b.name, 'body', d);
        }
      }
      for (i = 0; i < (PW.streams || []).length; i++){
        var s = PW.streams[i];
        if (!s.pts || s.pts.length < 2) continue;
        for (j = 0; j < s.pts.length - 1; j++){
          var C0 = s.pts[j], C1 = s.pts[j + 1];
          var sx = C1[0] - C0[0], sz = C1[1] - C0[1];
          var sl2 = sx * sx + sz * sz || 1;
          var st = clamp(((x - C0[0]) * sx + (z - C0[1]) * sz) / sl2, 0, 1);
          var px = C0[0] + sx * st, pz = C0[1] + sz * st;
          /* __PKG_WATER stream widths ride in PACKAGE metres (the
             map_loader conversion keeps halfW in pkg units — the
             same quirk the falls-QA pass documented); runtime half
             width = pkg metres x MapFrame.S. Per-station widths win
             where the stream carries them. */
          var S = (window.MapFrame && window.MapFrame.S) || 1;
          var hw = (s.width || 7) / 2 * S;
          if (s.widths && s.widths.length === s.pts.length)
            hw = Math.max(s.widths[j], s.widths[j + 1]) / 2 * S;
          var dSpine = dist2d(x, z, px, pz);
          var dEdge = Math.max(0, dSpine - hw);
          if (dEdge >= bestD) continue;
          /* near-side direction: from the spine toward the asker */
          var nx = x - px, nz = z - pz;
          var nl = Math.sqrt(nx * nx + nz * nz);
          if (nl < 0.001){ nx = -sz; nz = sx; nl = Math.sqrt(nx * nx + nz * nz) || 1; }
          nx /= nl; nz /= nl;
          var sy = null;
          try{
            if (typeof waterLevelAt === 'function')
              sy = waterLevelAt(px, pz);
          }catch(e){}
          if (typeof sy !== 'number' || !isFinite(sy)){
            sy = (s.ys && s.ys.length === s.pts.length)
              ? lerp(s.ys[j], s.ys[j + 1], st)
              : (groundY(px, pz) || 0) + 0.18;
          }
          consider(px + nx * (hw + 0.6), pz + nz * (hw + 0.6),
                   px + nx * hw * 0.45, pz + nz * hw * 0.45,
                   sy, s.name, 'stream', dEdge);
        }
      }
    }
  }catch(e){}
  return best;
}

/* ---------------------------------------------------------------------------
   GEOMETRY HELPERS — merge primitive parts into one BufferGeometry
   with vertex colours (and, for birds, the aWing hinge-weight
   attribute the flap shader reads). Colours are authored in sRGB and
   converted through THREE.Color, which under the game's colour
   management writes the LINEAR values the renderer expects — the
   lesson the falls-QA boulder fix paid for (authored-as-display
   colours wash out pale under sRGB output).
   --------------------------------------------------------------------------- */
function colArr(hex){
  var c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}
/* parts: [{ geo, mtx (Matrix4|null), color (hex|[r,g,b]),
           colorFn (optional fn(x,y,z)->[r,g,b] in LINEAR space),
           wing (optional fn(x,y,z)->signed hinge weight) }]
   Returns one merged non-indexed BufferGeometry. */
function mergeParts(parts){
  var pos = [], nor = [], col = [], wing = [], hasWing = false;
  var m4 = new THREE.Matrix4(), nm = new THREE.Matrix3();
  for (var p = 0; p < parts.length; p++){
    var part = parts[p];
    var g = part.geo.index ? part.geo.toNonIndexed() : part.geo;
    if (part.mtx){
      g.applyMatrix4(part.mtx);
    }
    var pa = g.attributes.position.array;
    var na = g.attributes.normal.array;
    var base = part.color !== undefined ? colArr(part.color) : [1, 1, 1];
    if (part.wing) hasWing = true;
    for (var i = 0; i < pa.length; i += 3){
      pos.push(pa[i], pa[i + 1], pa[i + 2]);
      nor.push(na[i], na[i + 1], na[i + 2]);
      var c = part.colorFn ? part.colorFn(pa[i], pa[i + 1], pa[i + 2]) : base;
      col.push(c[0], c[1], c[2]);
      wing.push(part.wing ? part.wing(pa[i], pa[i + 1], pa[i + 2]) : 0);
    }
    if (g !== part.geo) { try{ g.dispose(); }catch(e){} }
  }
  var out = new THREE.BufferGeometry();
  out.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal',
    new THREE.BufferAttribute(new Float32Array(nor), 3));
  out.setAttribute('color',
    new THREE.BufferAttribute(new Float32Array(col), 3));
  if (hasWing)
    out.setAttribute('aWing',
      new THREE.BufferAttribute(new Float32Array(wing), 1));
  return out;
}
function M4(px, py, pz, rx, ry, rz, sx, sy, sz){
  var m = new THREE.Matrix4();
  var e = new THREE.Euler(rx || 0, ry || 0, rz || 0);
  m.compose(new THREE.Vector3(px, py, pz),
            new THREE.Quaternion().setFromEuler(e),
            new THREE.Vector3(sx === undefined ? 1 : sx,
                              sy === undefined ? 1 : sy,
                              sz === undefined ? 1 : sz));
  return m;
}

/* ---------------------------------------------------------------------------
   BIRD MATERIAL — MeshLambert + the flap injection. The vertex
   shader bends wing vertices (aWing != 0) by
     sin(uTime * iFlap.z + iFlap.x) * iFlap.y
   (phase, amplitude, flapHz, fold) — iFlap is an INSTANCED attribute
   the CPU writes only when a bird changes state or its glide
   amplitude drifts materially. uTime is the module's one shared
   uniform object: the whole flock's flapping costs one uniform
   write per frame, at any population.
   --------------------------------------------------------------------------- */
function makeBirdMaterial(){
  var mat = new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide
  });
  mat.onBeforeCompile = function(sh){
    sh.uniforms.uTime = U_TIME;
    sh.vertexShader =
      'uniform float uTime;\n' +
      'attribute float aWing;\n' +
      'attribute vec4 iFlap;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'float wlW = abs(aWing);',
        /* flight flap: hinge-graded lift of the wing surface */
        'float wlFlap = sin(uTime * iFlap.z + iFlap.x) * iFlap.y;',
        'transformed.y += wlFlap * wlW * 0.34;',
        'transformed.x -= aWing * wlFlap * 0.06;',
        /* perched fold: wings droop and sweep back against the body */
        'transformed.y -= iFlap.w * wlW * 0.15;',
        'transformed.z -= iFlap.w * wlW * 0.16;',
        'transformed.x -= aWing * iFlap.w * 0.05;'
      ].join('\n'));
  };
  mat.customProgramCacheKey = function(){ return 'wildlife-bird-v1'; };
  return mat;
}
/* BUTTERFLY MATERIAL — same Lambert base; the vertex shader computes
   the whole creature: closed-form wander around iAnchor, heading
   from the wander's analytic derivative, flap from the clock.
   iSeed = (phase01, wanderRadius, sizeScale, flapSpeed01). The
   instance matrix stays identity — the CPU never touches these.
   COLOUR (v1.3, Joshua's 16:25 ruling — in his hands every
   butterfly read as ONE colour): each instance carries its
   species tint in a dedicated instanced attribute, iColor,
   written once at spawn and multiplied into the fragment
   diffuse through the vTint varying. This rides the same custom
   instanced-attribute path as iAnchor/iSeed (proven in the game)
   instead of THREE's instanceColor, which is what v1.0 used —
   and which is the path that failed to reach his screen with
   any variety. The geometry's own vertex colours still do the
   body-vs-wing split (dark body, white wings) under the tint. */
function makeButterflyMaterial(){
  var mat = new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide
  });
  mat.onBeforeCompile = function(sh){
    sh.uniforms.uTime = U_TIME;
    sh.vertexShader =
      'uniform float uTime;\n' +
      'attribute float aWing;\n' +
      'attribute vec3 iAnchor;\n' +
      'attribute vec4 iSeed;\n' +
      'attribute vec3 iColor;\n' +
      'varying vec3 vTint;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', [
        'vTint = iColor;',
        'vec3 transformed = vec3(position) * iSeed.z;',
        'float bfPh = iSeed.x * 6.28318;',
        /* flap: both wing tips rise together, graded to the tip */
        'float bfFlap = sin(uTime * (7.0 + iSeed.w * 4.0) + bfPh * 13.0);',
        'transformed.y += abs(aWing) * bfFlap * 0.30;',
        'transformed.x -= aWing * (1.0 - cos(bfFlap * 0.9)) * 0.10;',
        /* closed-form wander (Lissajous) + its derivative = heading */
        'float bfT = uTime * 0.13 + bfPh * 7.0;',
        'vec3 bfOff = vec3(sin(bfT * 1.31 + bfPh * 3.0), 0.0,',
        '                  cos(bfT * 0.97 + bfPh * 5.0)) * iSeed.y;',
        'vec3 bfDer = vec3(cos(bfT * 1.31 + bfPh * 3.0) * 1.31, 0.0,',
        '                  -sin(bfT * 0.97 + bfPh * 5.0) * 0.97);',
        'float bfHd = atan(bfDer.x, bfDer.z);',
        'bfOff.y = sin(uTime * 0.9 + bfPh * 11.0) * 0.35',
        '        + sin(bfT * 2.63) * 0.12;',
        'float bfC = cos(bfHd), bfS = sin(bfHd);',
        'transformed = vec3(transformed.x * bfC + transformed.z * bfS,',
        '                   transformed.y,',
        '                   -transformed.x * bfS + transformed.z * bfC)',
        '              + iAnchor + bfOff;'
      ].join('\n'));
    /* fragment: fold the per-instance species tint into the
       diffuse — after three's own colour_fragment step, so the
       vertex colours (dark body / white wings) multiply in too */
    sh.fragmentShader =
      'varying vec3 vTint;\n' +
      sh.fragmentShader.replace('#include <color_fragment>', [
        '#include <color_fragment>',
        'diffuseColor.rgb *= vTint;'
      ].join('\n'));
  };
  mat.customProgramCacheKey = function(){ return 'wildlife-butterfly-v2'; };
  return mat;
}

/* ---------------------------------------------------------------------------
   SPECIES — six Georgia birds. Colours are sRGB hex (converted at
   geometry build). flushR = the distance at which the bird leaves
   (bluebird sits tight; dove explodes early). phrase = the song as
   [gapAfterPrev, f0, f1, dur, relPeak] notes, sung through the
   bird's own voice gain — parametric phrases per the research:
   whistled species synthesise honestly; the thrasher (phrase null)
   ships visible-only rather than faking a 1,000-phrase song.
   --------------------------------------------------------------------------- */
function wrenPhrase(){
  /* "teakettle-teakettle": three fast 3-note figures */
  var notes = [], g = 0;
  for (var fig = 0; fig < 3; fig++){
    for (var i = 0; i < 3; i++){
      notes.push([g, 2900, 3350, 0.07, 0.8 + i * 0.07]);
      g = 0.025;
    }
    g = 0.17;
  }
  return notes;
}
var BIRD_SPECIES = {
  cardinal: {
    label: 'Northern Cardinal', size: 0.36, crest: true,
    back: 0xc0272d, belly: 0xd84a3a, wing: 0xa81f24, head: 0xc0272d,
    beak: 0xe8762a, tail: 0.36,
    flushR: 7, speed: 11, flapHz: 11, songPeak: 0.13,
    songEvery: [6, 13],
    phrase: [[0, 3000, 2350, 0.34, 0.9], [0.12, 2900, 2250, 0.30, 0.85],
             [0.12, 2750, 2100, 0.30, 0.8], [0.30, 3100, 2500, 0.22, 0.7],
             [0.10, 3100, 2500, 0.22, 0.65]]
  },
  wren: {
    label: 'Carolina Wren', size: 0.27, tailCock: true,
    back: 0x8a5a2b, belly: 0xd9c39a, wing: 0x74491f, head: 0x8a5a2b,
    beak: 0x4a3826, tail: 0.30,
    flushR: 4, speed: 9, flapHz: 13, songPeak: 0.16,
    songEvery: [5, 11], phrase: wrenPhrase()
  },
  dove: {
    label: 'Mourning Dove', size: 0.46,
    back: 0xa89888, belly: 0xc4b4a2, wing: 0x97887a, head: 0xb0a090,
    beak: 0x3d3630, tail: 0.55,
    flushR: 10, speed: 13, flapHz: 10, songPeak: 0.10,
    songEvery: [9, 18],
    phrase: [[0, 640, 520, 0.38, 0.8], [0.15, 430, 380, 0.30, 0.6],
             [0.12, 600, 470, 0.42, 0.85], [0.20, 430, 380, 0.34, 0.55]]
  },
  bluebird: {
    label: 'Eastern Bluebird', size: 0.31,
    back: 0x3e6fd9, belly: 0xc46a3d, wing: 0x355fb8, head: 0x3e6fd9,
    beak: 0x2c2c30, tail: 0.34,
    flushR: 2.5, speed: 10.5, flapHz: 11, songPeak: 0.06,
    songEvery: [8, 16],
    phrase: [[0, 2400, 2750, 0.20, 0.6], [0.05, 2650, 2300, 0.18, 0.55],
             [0.05, 2500, 2850, 0.22, 0.6], [0.06, 2700, 2400, 0.20, 0.5]]
  },
  titmouse: {
    label: 'Tufted Titmouse', size: 0.28, crest: true,
    back: 0x8e979e, belly: 0xe8e6de, wing: 0x7e878e, head: 0x8e979e,
    beak: 0x2e2a26, tail: 0.36,
    flushR: 5, speed: 10, flapHz: 12, songPeak: 0.11,
    songEvery: [6, 12],
    phrase: [[0, 2500, 2050, 0.16, 0.85], [0.14, 2500, 2050, 0.16, 0.85],
             [0.14, 2500, 2050, 0.16, 0.8], [0.14, 2500, 2050, 0.16, 0.8]]
  },
  thrasher: {
    label: 'Brown Thrasher', size: 0.42,
    back: 0x9a5a30, belly: 0xd8c4a2, wing: 0x8a4e28, head: 0x9a5a30,
    beak: 0x4a3421, tail: 0.55,
    flushR: 5, speed: 11, flapHz: 11, songPeak: 0,
    songEvery: [0, 0], phrase: null   /* visible-only in v1 (research) */
  }
};
var BIRD_KEYS = ['cardinal', 'wren', 'dove', 'bluebird', 'titmouse', 'thrasher'];
var BIRD_WEIGHTS = [0.22, 0.20, 0.18, 0.14, 0.16, 0.10];
function pickBirdSpecies(){
  var r = Math.random(), acc = 0;
  for (var i = 0; i < BIRD_KEYS.length; i++){
    acc += BIRD_WEIGHTS[i];
    if (r <= acc) return BIRD_KEYS[i];
  }
  return 'cardinal';
}

/* ---------------------------------------------------------------------------
   LOOKS PASS HELPERS (v1.4) — shaping tools for the bird/squirrel
   remodel. Both helpers edit an INDEXED geometry's vertices in
   place and recompute smooth normals, so the merged result shades
   as one continuous organic surface instead of faceted primitives
   (Joshua 2026-11-07 20:01: the old octahedron/box/cone builds
   read as "cubes and octagons and polygons", Minecraft-like; the
   target is the player characters' register — low-poly but
   SHAPED and smooth-shaded, in between, not finished-product).
   --------------------------------------------------------------------------- */
/* taperAlongZ(geo, halfLen, fn) — scale each vertex's x/y by
   fn(t), where t is the vertex's position along Z in [-1, 1]
   (t = z / halfLen). fn returns the radial scale at t. This is
   what turns a plain ellipsoid into a teardrop body: full chest,
   narrowing neck, pointed-but-rounded tail end. */
function taperAlongZ(geo, halfLen, fn){
  var pa = geo.attributes.position;
  for (var i = 0; i < pa.count; i++){
    var z = pa.getZ(i);
    var t = clamp(z / halfLen, -1, 1);
    var f = fn(t);
    pa.setX(i, pa.getX(i) * f);
    pa.setY(i, pa.getY(i) * f);
  }
  pa.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}
/* buildTailFan(s, tailLen) — a flat FAN tail as a shaped outline
   (root narrow, tip wide with a shallow centre notch), horizontal.
   Replaces the old box tail, whose rectangular silhouette was the
   single most "cube" read on the bird. The shape's root sits at
   the geometry origin so the caller's M4 rotation (level, or the
   wren's cocked-up -0.75) pivots at the body joint, exactly as
   the box's did. Bird material is DoubleSide, so the thin fan
   reads from above and below. */
function buildTailFan(s, tailLen){
  var w0 = 0.055 * s, w1 = 0.15 * s;
  var sh = new THREE.Shape();
  sh.moveTo(-w0, 0);
  sh.lineTo(w0, 0);
  sh.lineTo(w1, tailLen);
  sh.lineTo(0, tailLen * 0.90);      /* shallow V notch at the tip */
  sh.lineTo(-w1, tailLen);
  sh.closePath();
  var g = new THREE.ShapeGeometry(sh);
  g.rotateX(-Math.PI / 2);   /* shape +Y (length) -> world -Z (back) */
  return g;
}

/* buildBirdGeometry(sp) — one shared geometry per species: merged
   body/head/beak/tail + two wing planes carrying the aWing hinge
   weight (0 at the body, ±1 at the tips). Forward is +Z (the game's
   heading convention). Sizes are stylised slightly large, like the
   fish, so the bird reads at play distance.
   LOOKS PASS (v1.4): the body is now a 12x9 sphere TAPERED along
   its length (teardrop: chest full, neck narrow, tail end drawn
   to a soft point) with smooth computed normals; the head is a
   finer sphere with two small dark eyes; the beak/crest cones
   carry 8/6 sides instead of 4; the tail is a fan outline, not a
   box; the wings are 4x2-segment planes TAPERED toward the tip
   and SWEPT back, so the silhouette is a wing, not a rectangle.
   The aWing contract is preserved EXACTLY: the same wing()
   weight function over the same span placement, so the flap
   vertex shader (makeBirdMaterial) displaces the new vertices
   with the same hinge grading — root 0, tips ±1 — and the fold
   terms behave as before. Species touches ride the existing
   data: sp.crest (cardinal/titmouse), sp.tailCock (wren),
   sp.tail (dove/thrasher long tails read longer AND wider-
   fanned), sp.size (small species stay small). */
function buildBirdGeometry(sp){
  var s = sp.size;
  var back = colArr(sp.back), belly = colArr(sp.belly);
  var parts = [];
  /* body: tapered ellipsoid, two-tone by local height */
  var bodyGeo = new THREE.SphereGeometry(0.5, 12, 9);
  bodyGeo.scale(0.40 * s, 0.42 * s, 1.05 * s);
  taperAlongZ(bodyGeo, 0.525 * s, function(t){
    /* t: -1 tail end .. +1 neck end. Chest (t ~ +0.2) fullest;
       neck drawn in to 0.66, tail end to 0.38 — a soft point,
       never a spike (the sphere's own pole rounds it off). */
    return t >= 0 ? 1 - 0.34 * t * t : 1 - 0.62 * t * t;
  });
  parts.push({ geo: bodyGeo,
    colorFn: function(x, y, z){ return y >= 0 ? back : belly; } });
  /* head: finer sphere, seated into the body's neck taper */
  parts.push({ geo: new THREE.SphereGeometry(0.175 * s, 10, 8),
    mtx: M4(0, 0.10 * s, 0.42 * s), color: sp.head });
  /* eyes: two small dark spheres — the cheapest believability
     win at close range; they sit on the head's front sides */
  [-1, 1].forEach(function(side){
    parts.push({ geo: new THREE.SphereGeometry(0.028 * s, 5, 4),
      mtx: M4(side * 0.105 * s, 0.15 * s, 0.53 * s), color: 0x16120e });
  });
  /* crest (cardinal, titmouse): 6-sided cone, slightly flattened */
  if (sp.crest)
    parts.push({ geo: new THREE.ConeGeometry(0.07 * s, 0.24 * s, 6),
      mtx: M4(0, 0.27 * s, 0.36 * s, -0.55, 0, 0, 1, 1, 0.6),
      color: sp.head });
  /* beak: cone tipped forward (+Z), 8 sides (was 4 = a pyramid) */
  parts.push({ geo: new THREE.ConeGeometry(0.048 * s, 0.18 * s, 8),
    mtx: M4(0, 0.09 * s, 0.62 * s, Math.PI / 2, 0, 0), color: sp.beak });
  /* tail: FAN outline at the back; the wren's cocks up */
  var tailLen = s * (0.55 + sp.tail);
  parts.push({ geo: buildTailFan(s, tailLen),
    mtx: M4(0, sp.tailCock ? 0.10 * s : 0.01 * s,
            -0.44 * s,
            sp.tailCock ? -0.75 : 0.12, 0, 0),
    color: sp.wing });
  /* wings: tapered, swept planes either side, hinge weight graded
     outward — the weight FUNCTION and span placement are the
     pre-pass contract, unchanged; only the outline changed:
     chord narrows to 55% at the tip and the tip sweeps 0.18*s
     toward the tail, both graded by span fraction. The 4 span
     segments give the shader's flap bend three interior stations
     to curve through instead of one hinge crease. */
  [-1, 1].forEach(function(side){
    var wg = new THREE.PlaneGeometry(0.68 * s, 0.32 * s, 4, 2);
    wg.rotateX(-Math.PI / 2);
    var wp = wg.attributes.position;
    for (var vi = 0; vi < wp.count; vi++){
      var lx = wp.getX(vi);            /* -0.34s (root) .. +0.34s */
      var spanT = clamp((lx * side + 0.34 * s) / (0.68 * s), 0, 1);
      wp.setZ(vi, wp.getZ(vi) * (1 - 0.45 * spanT)
                  - spanT * spanT * 0.18 * s);
    }
    wp.needsUpdate = true;
    wg.computeVertexNormals();
    wg.translate(side * 0.37 * s, 0.06 * s, 0.02 * s);
    parts.push({ geo: wg, color: sp.wing,
      wing: function(x, y, z){
        var w = clamp((Math.abs(x) - 0.05 * s) / (0.62 * s), 0, 1);
        return Math.sign(x) * w;
      } });
  });
  return mergeParts(parts);
}

/* ---------------------------------------------------------------------------
   SMALL-CRITTER GEOMETRY (squirrel, chipmunk) — one merged mesh
   each, no articulation: the gait lives in the mesh's position/pitch
   (distance-driven, see the tick). Shared Lambert vertex-colour
   material, no shader work at all.
   --------------------------------------------------------------------------- */
var critterMat = null;
function getCritterMat(){
  if (!critterMat)
    critterMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return critterMat;
}
/* buildSquirrelTailGeometry() — LOOKS PASS (v1.4): the signature
   tail as ONE curved, tapered tube following a Catmull-Rom spine:
   out the rear, dipping, then sweeping UP and curling forward
   over the back — the squirrel silhouette. Cross-sections taper
   (narrow base, bushiest past the middle, soft point at the tip)
   and are flattened side-to-side (x * 0.62) so the tail reads as
   the broad, flat plume it is from the side, not a round rope.
   Replaces the two flattened cones of v1.0–1.3, whose hard facets
   and kinked joint were the "bent box" read Joshua flagged.
   Colour rides mergeParts' colorFn on the merged positions:
   dark at the base run, brown over the plume (same split the
   two cones carried). */
function buildSquirrelTailGeometry(){
  var curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.03, -0.15),
    new THREE.Vector3(0, -0.03, -0.30),
    new THREE.Vector3(0, 0.07, -0.43),
    new THREE.Vector3(0, 0.25, -0.47),
    new THREE.Vector3(0, 0.41, -0.39),
    new THREE.Vector3(0, 0.50, -0.25)
  ]);
  var TUB = 14, RAD = 9;
  var geo = new THREE.TubeGeometry(curve, TUB, 0.075, RAD, false);
  var pa = geo.attributes.position;
  var centre = new THREE.Vector3();
  for (var i = 0; i <= TUB; i++){
    var t = i / TUB;
    curve.getPoint(t, centre);
    /* taper profile: 0.55 at the root, swelling to 1.15 at the
       plume (t ~ 0.55), easing to a 0.32 soft point at the tip */
    var prof = t < 0.55
      ? 0.55 + (1.15 - 0.55) * (t / 0.55)
      : 1.15 - (1.15 - 0.32) * ((t - 0.55) / 0.45);
    for (var j = 0; j <= RAD; j++){
      var idx = i * (RAD + 1) + j;
      var ox = pa.getX(idx) - centre.x;
      var oy = pa.getY(idx) - centre.y;
      var oz = pa.getZ(idx) - centre.z;
      pa.setXYZ(idx,
        centre.x + ox * prof * 0.62,   /* flattened side-to-side */
        centre.y + oy * prof,
        centre.z + oz * prof);
    }
  }
  pa.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}
function buildSquirrelGeometry(){
  /* Fox squirrel colourway (Joshua's ruling, 2026-11-07 16:25:
     in his hands the v1.0 squirrels read GRAY — "they should be
     BROWN"). Warm reddish-brown back/head/tail, deep-brown ears
     and tail base, cream belly (the body's two-tone split below).
     The PALETTE is unchanged in the looks pass — only the shapes.
     LOOKS PASS (v1.4, Joshua 2026-11-07 20:01): body is a tapered
     ellipsoid (hips full, shoulders drawn in, belly softly
     flattened) instead of an octahedron; head is a finer sphere
     with a cream muzzle, dark eyes and 6-sided ear cones; four
     small legs and flattened feet ground the body; the tail is
     the curved tube above. The model stays ONE merged mesh with
     NO articulation, exactly as the animation expects: the tick
     drives only the whole mesh's position/pitch/heading through
     writeCritterMatrix (distance-driven hop, trunk-spiral climb
     via trunkPoint, freeze) — no part names or pivots exist for
     it to reference, and none were introduced. Bounding volume
     is the v1.0 volume, so seating (groundY + 0.10) and the
     climb's trunk offsets are untouched. +Z fwd. */
  var brown = 0x9c6630, dark = 0x6e4520, cream = 0xe2d4b8;
  var parts = [];
  /* body: ellipsoid tapered along Z — rear (t=-1) keeps its hip
     width, front (t=+1) draws in toward the shoulders */
  var body = new THREE.SphereGeometry(0.5, 14, 11);
  body.scale(0.15, 0.16, 0.34);
  taperAlongZ(body, 0.17, function(t){
    return t >= 0 ? 1 - 0.20 * t * t : 1 - 0.08 * t * t;
  });
  /* soften the belly flat so it sits, not rolls */
  var bp = body.attributes.position;
  for (var bi = 0; bi < bp.count; bi++)
    if (bp.getY(bi) < -0.045) bp.setY(bi, -0.045 - (bp.getY(bi) + 0.045) * 0.55);
  bp.needsUpdate = true;
  body.computeVertexNormals();
  var bc = colArr(brown), cc = colArr(cream);
  parts.push({ geo: body,
    colorFn: function(x, y, z){ return y < -0.03 ? cc : bc; } });
  /* head + muzzle + eyes + ears */
  parts.push({ geo: new THREE.SphereGeometry(0.085, 11, 9),
    mtx: M4(0, 0.075, 0.30), color: brown });
  var muzzle = new THREE.SphereGeometry(0.045, 8, 6);
  muzzle.scale(0.82, 0.62, 1.35);
  parts.push({ geo: muzzle, mtx: M4(0, 0.052, 0.375), color: cream });
  [-1, 1].forEach(function(side){
    parts.push({ geo: new THREE.SphereGeometry(0.016, 5, 4),
      mtx: M4(side * 0.052, 0.098, 0.362), color: 0x1c130c });
    parts.push({ geo: new THREE.ConeGeometry(0.028, 0.075, 6),
      mtx: M4(side * 0.05, 0.17, 0.28), color: dark });
  });
  /* legs: short cylinders at the four corners; hind thighs as
     fuller blobs against the hips (the sitting-haunch read) */
  [[0.055, 0.17], [-0.055, 0.17], [0.06, -0.13], [-0.06, -0.13]]
    .forEach(function(lp){
      parts.push({ geo: new THREE.CylinderGeometry(0.020, 0.026, 0.09, 7),
        mtx: M4(lp[0], -0.055, lp[1]), color: dark });
      var foot = new THREE.SphereGeometry(0.030, 7, 5);
      foot.scale(0.9, 0.5, 1.9);
      parts.push({ geo: foot, mtx: M4(lp[0], -0.095, lp[1] + 0.025),
        color: dark });
    });
  [-1, 1].forEach(function(side){
    var thigh = new THREE.SphereGeometry(0.052, 8, 6);
    thigh.scale(0.72, 1.05, 1.35);
    parts.push({ geo: thigh, mtx: M4(side * 0.078, -0.015, -0.115),
      color: brown });
  });
  /* tail: the curved plume (colour split by merged position:
     the low rear run is the dark base, the raised plume brown) */
  var dc = colArr(dark);
  parts.push({ geo: buildSquirrelTailGeometry(),
    colorFn: function(x, y, z){
      return (z > -0.34 && y < 0.10) ? dc : bc;
    } });
  return mergeParts(parts);
}
function buildChipmunkGeometry(){
  /* Eastern chipmunk: reddish-brown, the dark dorsal stripe carries
     the species read (a thin dark box laid along the back). */
  var brown = 0x9a6238, dark = 0x3d2c1c;
  var parts = [];
  var body = new THREE.OctahedronGeometry(0.5);
  body.scale(0.10, 0.105, 0.23);
  parts.push({ geo: body, color: brown });
  parts.push({ geo: new THREE.BoxGeometry(0.035, 0.018, 0.30),
    mtx: M4(0, 0.095, -0.01), color: dark });
  parts.push({ geo: new THREE.SphereGeometry(0.058, 6, 5),
    mtx: M4(0, 0.045, 0.20), color: brown });
  parts.push({ geo: new THREE.ConeGeometry(0.03, 0.20, 4),
    mtx: M4(0, 0.09, -0.26, -2.5, 0, 0, 1, 1, 0.45), color: dark });
  return mergeParts(parts);
}
function buildButterflyGeometry(){
  /* Two wing quads + a thin body; aWing = normalised span (-1..1)
     so the shader's flap grades from body to tip. Wing colour comes
     from the per-instance iColor tint (see makeButterflyMaterial);
     the body stays dark through its own near-black vertex colour
     multiplied in. */
  var parts = [];
  var body = new THREE.OctahedronGeometry(0.5);
  body.scale(0.018, 0.018, 0.11);
  parts.push({ geo: body, color: 0x2a2118 });
  [-1, 1].forEach(function(side){
    var wg = new THREE.PlaneGeometry(0.30, 0.20, 1, 1);
    wg.rotateX(-Math.PI / 2);
    wg.translate(side * 0.16, 0, 0);
    parts.push({ geo: wg, color: 0xffffff,
      wing: function(x, y, z){ return clamp(x / 0.30, -1, 1); } });
  });
  return mergeParts(parts);
}
/* BUTTERFLY_KINDS — six real Georgia species, one flat colourway
   each (v1.3: variety was Joshua's 16:25 ruling — "they're all
   one color, they need varied colors"). Flat colour only, no
   texture work: the Buckeye's eyespots and the Monarch's black
   veining are approximated by their ground colour, per the pass
   brief. The palette is chosen so neighbours in a meadow differ
   at a glance: orange / bright yellow / pale lemon / brown /
   white / blue. Spawn deals these out round-robin from a shuffled
   order (see spawnButterflies), so a set always shows as many
   different species as it has members, up to all six. */
var BUTTERFLY_KINDS = [
  { label: 'Monarch', color: 0xe07b24, size: 1.0 },
  { label: 'Eastern Tiger Swallowtail', color: 0xf2d13c, size: 1.15 },
  { label: 'Cloudless Sulphur', color: 0xf0e08c, size: 0.9 },
  { label: 'Common Buckeye', color: 0x8a6844, size: 0.85 },
  { label: 'Cabbage White', color: 0xf6f2e8, size: 0.7 },
  { label: 'Eastern Tailed-Blue', color: 0x7fa8d8, size: 0.6 }
];

/* ---------------------------------------------------------------------------
   BIRD INSTANCE SETS — one InstancedMesh per species. Slot manager
   with swap-remove: freeing a bird moves the LAST bird into its
   slot (matrix + iFlap rewritten), so the mesh count always equals
   the live population and no slot is ever wasted.
   --------------------------------------------------------------------------- */
var birdSets = {};
function getBirdSet(key){
  var set = birdSets[key];
  if (set) return set;
  var sp = BIRD_SPECIES[key];
  var geo = buildBirdGeometry(sp);
  var mesh = new THREE.InstancedMesh(geo, makeBirdMaterial(), CAP_BIRDS);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  var flap = new THREE.InstancedBufferAttribute(
    new Float32Array(CAP_BIRDS * 4), 4);
  flap.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iFlap', flap);
  mesh.count = 0;
  scene.add(mesh);
  set = birdSets[key] = { key: key, sp: sp, mesh: mesh,
                          flap: flap, birds: [] };
  return set;
}
var _dummy = null;
function dummy(){
  if (!_dummy){
    _dummy = new THREE.Object3D();
    _dummy.rotation.order = 'YXZ';
  }
  return _dummy;
}
function writeBirdMatrix(b){
  var d = dummy();
  d.position.set(b.x, b.y, b.z);
  d.rotation.set(b.pitch || 0, b.heading || 0, b.bank || 0);
  d.updateMatrix();
  b.set.mesh.setMatrixAt(b.slot, d.matrix);
  b.set.mesh.instanceMatrix.needsUpdate = true;
}
function setFlap(b, phase, amp, hz, fold, force){
  var cur = b.flap4;
  if (!force && cur &&
      Math.abs(cur[0] - phase) < 0.01 && Math.abs(cur[1] - amp) < 0.03 &&
      Math.abs(cur[2] - hz) < 0.01 && Math.abs(cur[3] - fold) < 0.03)
    return;
  b.flap4 = [phase, amp, hz, fold];
  var a = b.set.flap.array, o = b.slot * 4;
  a[o] = phase; a[o + 1] = amp; a[o + 2] = hz; a[o + 3] = fold;
  b.set.flap.needsUpdate = true;
}
function allocBird(key){
  var set = getBirdSet(key);
  if (set.birds.length >= CAP_BIRDS) return null;
  var b = {
    kind: 'bird', key: key, sp: set.sp, set: set,
    slot: set.birds.length,
    state: 'PERCHED',
    x: 0, y: 0, z: 0, heading: Math.random() * Math.PI * 2,
    pitch: 0, bank: 0,
    perch: null, flight: null,
    flap4: null, phaseSeed: Math.random() * 20,
    nextThink: _t + Math.random() * 0.4,
    nextSong: _t + 2 + Math.random() * 6,
    songUntil: 0, voice: null, songNodes: [],
    visitT: _t + 25 + Math.random() * 55,
    stateT: 0, hopT: _t + 4 + Math.random() * 10,
    splashT: 0, born: _t
  };
  set.birds.push(b);
  set.mesh.count = set.birds.length;
  creatures.push(b);
  return b;
}
function freeBird(b){
  songStop(b, true);
  var set = b.set, arr = set.birds;
  var idx = arr.indexOf(b);
  if (idx >= 0){
    var last = arr[arr.length - 1];
    arr[idx] = last;
    arr.pop();
    if (last !== b){
      last.slot = idx;
      writeBirdMatrix(last);
      var a = set.flap.array, o = idx * 4, s = last.slot * 4;
      /* last.flap4 already holds its values; copy from its record */
      a[o] = last.flap4 ? last.flap4[0] : 0;
      a[o + 1] = last.flap4 ? last.flap4[1] : 0;
      a[o + 2] = last.flap4 ? last.flap4[2] : 0;
      a[o + 3] = last.flap4 ? last.flap4[3] : 0;
      set.flap.needsUpdate = true;
    }
    set.mesh.count = arr.length;
    set.mesh.instanceMatrix.needsUpdate = true;
  }
  var ci = creatures.indexOf(b);
  if (ci >= 0) creatures.splice(ci, 1);
}

/* ---------------------------------------------------------------------------
   SONG — each singing bird owns one __AMB.voice (a GainNode into
   the ambient master); phrase notes are scheduled oscillators into
   it, plus a breath of band-passed noise per note (real song has an
   air component; a pure sine reads as a phone beep). The sweep sets
   the voice gain from the distance law; flush stops the phrase
   mid-note and destroys the voice.
   --------------------------------------------------------------------------- */
/* ambVoice() — one per-creature voice from the ambient module
   (a GainNode into the ambient master, so wildlife sound follows
   the game's own mute/master path and survives the master being
   rebuilt). Null when audio is unavailable — callers treat a
   silent creature as normal, never an error. */
function ambVoice(){
  try {
    if (window.__AMB && typeof window.__AMB.voice === 'function')
      return window.__AMB.voice();
  } catch(e){}
  return null;
}
function songStop(b, destroyVoice){
  try {
    for (var i = 0; i < b.songNodes.length; i++){
      try { b.songNodes[i].stop(); } catch(e){}
      try { b.songNodes[i].disconnect(); } catch(e){}
    }
  } catch(e){}
  b.songNodes.length = 0;
  b.songUntil = 0;
  if (destroyVoice && b.voice){
    try { b.voice.destroy(); } catch(e){}
    b.voice = null;
  }
}
function songStart(b){
  if (!b.sp.phrase || !b.sp.songPeak) return;
  var v = b.voice;
  if (!v){
    v = ambVoice();
    if (!v) return;
    b.voice = v;
  }
  var ctx = v.ctx;
  var t0 = ctx.currentTime + 0.03;
  var jit = 0.97 + Math.random() * 0.06;      /* pitch jitter */
  var tj = 0.94 + Math.random() * 0.12;       /* tempo jitter */
  var cursor = t0, endT = t0;
  for (var i = 0; i < b.sp.phrase.length; i++){
    var n = b.sp.phrase[i];
    cursor += n[0] * tj;
    var f0 = n[1] * jit, f1 = n[2] * jit, dur = n[3] * tj;
    var peak = Math.max(0.05, Math.min(1, n[4]));
    try {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0, cursor);
      osc.frequency.exponentialRampToValueAtTime(Math.max(60, f1),
                                                 cursor + dur);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, cursor);
      g.gain.exponentialRampToValueAtTime(peak, cursor + dur * 0.25);
      g.gain.setValueAtTime(peak, cursor + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, cursor + dur);
      osc.connect(g); g.connect(v.out);
      osc.start(cursor); osc.stop(cursor + dur + 0.05);
      b.songNodes.push(osc);
    } catch(e){}
    try {
      /* the breath: band-passed noise at the note's centre pitch */
      var nb = ctx.createBufferSource();
      nb.buffer = whiteBuf(ctx); nb.loop = true;
      nb.playbackRate.value = 0.7 + Math.random() * 0.6;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = (f0 + f1) / 2; bp.Q.value = 2.5;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, cursor);
      ng.gain.exponentialRampToValueAtTime(peak * 0.18,
                                           cursor + dur * 0.3);
      ng.gain.exponentialRampToValueAtTime(0.0001, cursor + dur);
      nb.connect(bp); bp.connect(ng); ng.connect(v.out);
      nb.start(cursor, Math.random() * 1.5);
      nb.stop(cursor + dur + 0.05);
      b.songNodes.push(nb);
    } catch(e){}
    endT = cursor + dur;
    cursor = endT;
  }
  b.songUntil = endT;
}
/* white noise buffer for the song breath — created in the AUDIO
   context (ambient_audio's whiteBuf makes one in ITS context,
   which is the same shared context in the game, but the helper is
   module-private; keep a local cache keyed by context). */
var _wnCache = null;
function whiteBuf(ctx){
  if (_wnCache && _wnCache.ctx === ctx) return _wnCache.buf;
  var len = Math.floor(ctx.sampleRate * 1.2);
  var buf = ctx.createBuffer(1, len, ctx.sampleRate);
  var d = buf.getChannelData(0);
  for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  _wnCache = { ctx: ctx, buf: buf };
  return buf;
}
/* Mourning Dove flush whistle: 0.3s of wing-flutter noise, the
   sound a startled dove actually makes leaving. */
function doveWhistle(b){
  var v = ambVoice();
  if (!v) return;
  try {
    var ctx = v.ctx, t0 = ctx.currentTime;
    var src = ctx.createBufferSource();
    src.buffer = whiteBuf(ctx); src.loop = true;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(2600, t0);
    bp.frequency.exponentialRampToValueAtTime(1700, t0 + 0.3);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.10, t0 + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
    src.connect(bp); bp.connect(g); g.connect(v.out);
    v.setGain(1, t0);
    src.start(t0, Math.random()); src.stop(t0 + 0.32);
    pendingCleanup.push({ t: _t + 0.6, fn: function(){ try{ v.destroy(); }catch(e){} } });
  } catch(e){
    try { v.destroy(); } catch(e2){}
  }
}
var pendingCleanup = [];

/* ---------------------------------------------------------------------------
   BIRD FLIGHT — precomputed quadratic bezier arcs. The CPU writes
   the matrix per frame ONLY while a bird flies (the v1 lesson);
   everything else about flight — flap — is the shader's.
   --------------------------------------------------------------------------- */
function startFlight(b, tx, ty, tz, kind, opts){
  opts = opts || {};
  var dx = tx - b.x, dz = tz - b.z;
  var dist = Math.sqrt(dx * dx + dz * dz);
  var lift = opts.lift !== undefined ? opts.lift :
             (2.2 + dist * 0.12);
  var dur = clamp(dist / b.sp.speed, 0.45, 9);
  b.flight = {
    x0: b.x, y0: b.y, z0: b.z,
    x1: (b.x + tx) / 2 + (opts.sway || 0), z1: (b.z + tz) / 2,
    y1: Math.max(b.y, ty) + lift,
    x2: tx, y2: ty, z2: tz,
    t: 0, dur: dur, kind: kind,
    perch: opts.perch || null,
    groundPt: opts.groundPt || null,
    shore: opts.shore || null,
    lastAmp: -1
  };
  b.state = 'FLIGHT';
  b.bank = 0;
  songStop(b, false);
  /* fold -> flight: amp ramps in the tick; set phase/hz now */
  setFlap(b, b.phaseSeed - _t * b.sp.flapHz, 0.7, b.sp.flapHz, 0, true);
}
function bez(p, t){
  var u = 1 - t;
  return u * u * p[0] + 2 * u * t * p[1] + t * t * p[2];
}
function landFlight(b){
  var f = b.flight;
  b.flight = null;
  b.x = f.x2; b.y = f.y2; b.z = f.z2;
  b.pitch = 0; b.bank = 0;
  if (f.kind === 'perch'){
    b.state = 'PERCHED';
    b.perch = f.perch;
    b.nextSong = _t + 1.5 + Math.random() * 5;
    b.hopT = _t + 5 + Math.random() * 12;
    setFlap(b, 0, 0, b.sp.flapHz, 1, true);
  } else if (f.kind === 'ground'){
    b.state = 'GROUND';
    b.stateT = _t + 2 + Math.random() * 5;
    setFlap(b, 0, 0, b.sp.flapHz, 1, true);
  } else if (f.kind === 'drink'){
    b.state = 'DRINK';
    b.stateT = _t + 3 + Math.random() * 2;
    b.shore = f.shore;
    setFlap(b, 0, 0, b.sp.flapHz, 1, true);
  } else if (f.kind === 'bathe'){
    b.state = 'BATHE';
    b.stateT = _t + 4 + Math.random() * 3;
    b.shore = f.shore;
    b.splashT = _t + 0.4;
    setFlap(b, 0, 0, b.sp.flapHz, 1, true);
  }
  writeBirdMatrix(b);
}
function flushBird(b){
  if (b.state === 'FLIGHT') return;
  songStop(b, true);
  if (b.key === 'dove') doveWhistle(b);
  var px = playerPos.x, pz = playerPos.z;
  if (b.key === 'thrasher'){
    /* DOWN into cover: a grass point away from the player, low arc */
    var away = Math.atan2(b.x - px, b.z - pz);
    for (var i = 0; i < 6; i++){
      var gx = b.x + Math.sin(away) * (8 + i * 3) +
               (Math.random() - 0.5) * 6;
      var gz = b.z + Math.cos(away) * (8 + i * 3) +
               (Math.random() - 0.5) * 6;
      if (isGrass(gx, gz)){
        startFlight(b, gx, groundY(gx, gz) + 0.06, gz, 'ground',
                    { lift: 0.8 });
        return;
      }
    }
  }
  var perch = pickPerch(b.x, b.z, 18, 65, px, pz);
  if (perch){
    startFlight(b, perch.perchX, perch.perchY, perch.perchZ, 'perch',
                { perch: perch });
  } else {
    /* no perch found: a long low arc away, land on grass */
    var a2 = Math.atan2(b.x - px, b.z - pz);
    var lx = b.x + Math.sin(a2) * 40, lz = b.z + Math.cos(a2) * 40;
    startFlight(b, lx, groundY(lx, lz) + 0.06, lz, 'ground',
                { lift: 3 });
  }
}
/* pickPerch — a derived-tree perch in the ring [rMin, rMax] around
   (x,z), preferring points AWAY from (avoidX, avoidZ) when given. */
function pickPerch(x, z, rMin, rMax, avoidX, avoidZ){
  var trees = deriveTreesNear(x, z, rMax);
  var best = null, bestScore = -1e9;
  for (var i = 0; i < trees.length; i++){
    var tr = trees[i];
    var dx = tr.perchX - x, dz = tr.perchZ - z;
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d < rMin || d > rMax) continue;
    var score = Math.random() * 10;
    if (avoidX !== undefined){
      var adx = tr.perchX - avoidX, adz = tr.perchZ - avoidZ;
      score += Math.sqrt(adx * adx + adz * adz) * 0.2;
    }
    if (score > bestScore){ bestScore = score; best = tr; }
  }
  return best;
}

/* ---------------------------------------------------------------------------
   BIRD THINK + TICK
   --------------------------------------------------------------------------- */
var creatures = [];
function birdThink(b){
  var dx = playerPos.x - b.x, dz = playerPos.z - b.z;
  var d = Math.sqrt(dx * dx + dz * dz);
  if (b.state === 'PERCHED'){
    if (d < b.sp.flushR){ flushBird(b); return; }
    /* song bouts: start when due, only while perched */
    if (b.sp.phrase && _t >= b.nextSong){
      songStart(b);
      b.nextSong = _t + (b.sp.songEvery[0] +
        Math.random() * (b.sp.songEvery[1] - b.sp.songEvery[0]));
    }
    /* in-crown / near-crown hop */
    if (_t >= b.hopT){
      b.hopT = _t + 5 + Math.random() * 14;
      var hp = pickPerch(b.x, b.z, 2, 16);
      if (hp && Math.random() < 0.7)
        startFlight(b, hp.perchX, hp.perchY, hp.perchZ, 'perch',
                    { perch: hp, lift: 0.7 });
    }
    /* water visit: fly to a shore point, drink (all birds) or
       bathe (any species, in the shallows) */
    if (_t >= b.visitT){
      b.visitT = _t + 30 + Math.random() * 70;
      var sh = nearestShore(b.x, b.z, 70);
      if (sh && Math.random() < 0.75){
        if (Math.random() < 0.45){
          startFlight(b, sh.waterX,
                      (sh.y !== null ? sh.y : groundY(sh.waterX, sh.waterZ)) + 0.03,
                      sh.waterZ, 'bathe', { shore: sh, lift: 1.2 });
        } else {
          startFlight(b, sh.bankX, groundY(sh.bankX, sh.bankZ) + 0.05,
                      sh.bankZ, 'drink', { shore: sh, lift: 1.2 });
        }
        return;
      }
    }
  } else if (b.state === 'GROUND'){
    if (d < b.sp.flushR){ flushBird(b); return; }
    if (_t >= b.stateT){
      var p2 = pickPerch(b.x, b.z, 6, 40);
      if (p2) startFlight(b, p2.perchX, p2.perchY, p2.perchZ, 'perch',
                          { perch: p2, lift: 1.6 });
      else b.stateT = _t + 3;
    }
  } else if (b.state === 'DRINK' || b.state === 'BATHE'){
    if (d < b.sp.flushR + 1.5){ flushBird(b); return; }
    if (_t >= b.stateT){
      var p3 = pickPerch(b.x, b.z, 8, 55);
      if (p3) startFlight(b, p3.perchX, p3.perchY, p3.perchZ, 'perch',
                          { perch: p3, lift: 1.8 });
      else { /* stay a little longer */ b.stateT = _t + 2; }
    }
  }
}
function birdTick(b, dt){
  if (b.state === 'FLIGHT' && b.flight){
    var f = b.flight;
    f.t += dt / f.dur;
    if (f.t >= 1){ landFlight(b); return; }
    var t = f.t;
    var nx = bez([f.x0, f.x1, f.x2], t);
    var ny = bez([f.y0, f.y1, f.y2], t);
    var nz = bez([f.z0, f.z1, f.z2], t);
    var vx = nx - b.x, vy = ny - b.y, vz = nz - b.z;
    if (vx * vx + vz * vz > 1e-8){
      var targetH = Math.atan2(vx, vz);
      var dh = targetH - b.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      b.heading += dh * Math.min(1, dt * 6);
      b.bank = clamp(-dh * 2.2, -0.8, 0.8);
    }
    b.pitch = clamp(-Math.atan2(vy, Math.sqrt(vx * vx + vz * vz) + 1e-6)
                    * 0.7, -0.6, 0.6);
    b.x = nx; b.y = ny; b.z = nz;
    /* burst-and-glide: hard flap on the climb and the final
       approach, soft bursts between — amplitude only, the shader
       does the rest */
    var amp;
    if (t < 0.28 || t > 0.86) amp = 0.9;
    else {
      var burst = Math.sin((t * 3.1 + b.phaseSeed) * Math.PI);
      amp = 0.22 + 0.55 * Math.max(0, burst) * Math.max(0, burst);
    }
    if (Math.abs(amp - f.lastAmp) > 0.05){
      f.lastAmp = amp;
      setFlap(b, b.phaseSeed - _t * b.sp.flapHz, amp, b.sp.flapHz, 0);
    }
    writeBirdMatrix(b);
  } else if (b.state === 'DRINK'){
    /* head-dip cycle: pitch down, pause, up — a drinking bird */
    var ph = (_t * 0.9 + b.phaseSeed) % 1;
    b.pitch = ph < 0.4 ? (ph / 0.4) * 0.75 :
              (ph < 0.62 ? 0.75 : (1 - (ph - 0.62) / 0.38) * 0.75);
    writeBirdMatrix(b);
  } else if (b.state === 'BATHE'){
    /* flutter bursts + splashing in the shallows */
    b.pitch = Math.sin(_t * 9 + b.phaseSeed) * 0.16;
    var ampB = (Math.sin(_t * 2.2 + b.phaseSeed) > 0.25) ? 0.55 : 0.05;
    setFlap(b, b.phaseSeed, ampB, 17, 0);
    if (_t >= b.splashT){
      b.splashT = _t + 0.8 + Math.random() * 0.7;
      var dp = distToPlayer(b.x, b.z);
      if (dp <= 25 && window.__AMB && window.__AMB.splash)
        try { window.__AMB.splash('tread'); } catch(e){}
    }
    writeBirdMatrix(b);
  }
}
function distToPlayer(x, z){
  var dx = playerPos.x - x, dz = playerPos.z - z;
  return Math.sqrt(dx * dx + dz * dz);
}
/* spawnBird — a perch 45–140u out, in or near woods (birds live
   where trees are; density rides the canopy score implicitly
   because perches only exist on tree cells). */
function spawnBird(){
  var key = pickBirdSpecies();
  var perch = pickPerch(playerPos.x, playerPos.z, 45, 140);
  if (!perch) return false;
  var b = allocBird(key);
  if (!b) return false;
  b.perch = perch;
  b.x = perch.perchX; b.y = perch.perchY; b.z = perch.perchZ;
  b.heading = Math.random() * Math.PI * 2;
  setFlap(b, 0, 0, b.sp.flapHz, 1, true);
  writeBirdMatrix(b);
  return true;
}

/* ---------------------------------------------------------------------------
   SQUIRRELS — one merged mesh each. Territory: one home tree plus
   the ground around it. The gait is a FUNCTION OF DISTANCE
   TRAVELLED (Minecraft limbSwing doctrine): hop height and body
   pitch read off distAcc, never off a wall-clock phase, so a
   squirrel that stops mid-hop lands mid-hop.
   --------------------------------------------------------------------------- */
var squirrelGeo = null, chipmunkGeo = null;
function spawnSquirrel(){
  var trees = deriveTreesNear(playerPos.x, playerPos.z, 130);
  var cands = [];
  for (var i = 0; i < trees.length; i++){
    var tr = trees[i];
    var d = distToPlayer(tr.x, tr.z);
    if (d < 55 || d > 130) continue;
    if (buildingDist(tr.x, tr.z) < 25) continue;
    cands.push(tr);
  }
  if (!cands.length) return false;
  var tree = cands[(Math.random() * cands.length) | 0];
  if (!squirrelGeo) squirrelGeo = buildSquirrelGeometry();
  var mesh = new THREE.Mesh(squirrelGeo, getCritterMat());
  mesh.frustumCulled = false;
  scene.add(mesh);
  var c = {
    kind: 'squirrel', mesh: mesh, tree: tree,
    state: 'FORAGE',
    x: tree.x + 2, y: 0, z: tree.z + 1, heading: Math.random() * 6.28,
    pitch: 0,
    tx: tree.x + 2, tz: tree.z + 1, moving: false, pauseT: 0,
    distAcc: Math.random() * 3,
    nextThink: _t + Math.random() * 0.4,
    stateT: 0, climb: null,
    visitT: _t + 40 + Math.random() * 60,
    shore: null, born: _t
  };
  c.y = groundY(c.x, c.z) + 0.10;
  creatures.push(c);
  writeCritterMatrix(c);
  return true;
}
function trunkPoint(tree, y, ang){
  /* a point on the trunk surface at height y, spiral angle ang —
     the trunk axis leans from its base toward the crown centre */
  var frac = clamp((y - tree.gy) / Math.max(1.5, tree.folBot), 0, 1);
  var cx = tree.x + tree.leanX * 0.8 * frac;
  var cz = tree.z + tree.leanZ * 0.8 * frac;
  var r = (0.30 - 0.20 * frac) + 0.09;
  return { x: cx + Math.cos(ang) * r, z: cz + Math.sin(ang) * r,
           cx: cx, cz: cz };
}
function squirrelStartle(c){
  if (c.state === 'CLIMB' || c.state === 'TREE') return;
  c.state = 'SPRINT';
  c.tx = c.tree.x; c.tz = c.tree.z;
  squirrelChatter(c);
}
function squirrelChatter(c){
  /* optional startle chatter: 3–4 band-passed ticks ~3 kHz */
  if (distToPlayer(c.x, c.z) > 30) return;
  var v = ambVoice();
  if (!v) return;
  try {
    var ctx = v.ctx, t0 = ctx.currentTime + 0.02;
    v.setGain(0.10, t0);
    var n = 3 + (Math.random() * 2 | 0);
    for (var i = 0; i < n; i++){
      var src = ctx.createBufferSource();
      src.buffer = whiteBuf(ctx); src.loop = true;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 2900 + Math.random() * 400;
      bp.Q.value = 6;
      var g = ctx.createGain();
      var st = t0 + i * 0.09;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.8, st + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.05);
      src.connect(bp); bp.connect(g); g.connect(v.out);
      src.start(st, Math.random()); src.stop(st + 0.07);
    }
    pendingCleanup.push({ t: _t + 1.2,
      fn: function(){ try{ v.destroy(); }catch(e){} } });
  } catch(e){ try{ v.destroy(); }catch(e2){} }
}
function squirrelThink(c){
  var d = distToPlayer(c.x, c.z);
  if (d < 6 && c.state !== 'CLIMB' && c.state !== 'TREE'){
    squirrelStartle(c);
    return;
  }
  if (c.state === 'FORAGE'){
    if (_t >= c.visitT){
      c.visitT = _t + 45 + Math.random() * 75;
      var sh = nearestShore(c.x, c.z, 45);
      if (sh){
        c.state = 'TO_DRINK';
        c.tx = sh.bankX; c.tz = sh.bankZ; c.shore = sh;
        return;
      }
    }
    if (!c.moving && _t >= c.pauseT){
      /* forage: a new ground point near the home tree, or
         occasionally UP the tree for a sit */
      if (Math.random() < 0.22){
        c.state = 'CLIMB';
        c.climb = { dir: 1, ang: Math.atan2(c.z - c.tree.z, c.x - c.tree.x),
                    y: c.tree.gy + 0.15,
                    yTop: c.tree.gy + c.tree.folBot * (0.55 + Math.random() * 0.3) };
        return;
      }
      for (var i = 0; i < 5; i++){
        var gx = c.tree.x + (Math.random() - 0.5) * 22;
        var gz = c.tree.z + (Math.random() - 0.5) * 22;
        if (isGrass(gx, gz)){ c.tx = gx; c.tz = gz; c.moving = true; break; }
      }
    }
  } else if (c.state === 'TREE'){
    if (_t >= c.stateT){
      c.state = 'CLIMB';
      c.climb = { dir: -1, ang: c.climbAng || 0,
                  y: c.y, yTop: c.tree.gy + 0.15 };
    }
  } else if (c.state === 'DRINK'){
    if (_t >= c.stateT){
      c.state = 'FORAGE'; c.moving = true;
      c.tx = c.tree.x + (Math.random() - 0.5) * 8;
      c.tz = c.tree.z + (Math.random() - 0.5) * 8;
    }
  }
}
function squirrelTick(c, dt){
  var tree = c.tree;
  if (c.state === 'FORAGE' || c.state === 'SPRINT' ||
      c.state === 'TO_DRINK'){
    var speed = c.state === 'SPRINT' ? 4.4 :
                (c.state === 'TO_DRINK' ? 2.0 : 1.15);
    if (c.moving || c.state === 'SPRINT' || c.state === 'TO_DRINK'){
      var dx = c.tx - c.x, dz = c.tz - c.z;
      var dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 0.25){
        if (c.state === 'SPRINT'){
          c.state = 'CLIMB';
          c.climb = { dir: 1,
            ang: Math.atan2(c.z - tree.z, c.x - tree.x),
            y: tree.gy + 0.15,
            yTop: tree.gy + tree.folBot * 0.8 };
        } else if (c.state === 'TO_DRINK'){
          c.state = 'DRINK';
          c.stateT = _t + 3 + Math.random() * 2;
          c.heading = Math.atan2(c.shore.waterX - c.x,
                                 c.shore.waterZ - c.z);
        } else {
          c.moving = false;
          c.pauseT = _t + 0.5 + Math.random() * 2.2;
        }
      } else {
        var step = Math.min(dist, speed * dt);
        c.x += dx / dist * step;
        c.z += dz / dist * step;
        c.distAcc += step;
        var targetH = Math.atan2(dx, dz);
        var dh = targetH - c.heading;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        c.heading += dh * Math.min(1, dt * 10);
      }
    }
    var gy = groundY(c.x, c.z);
    var hopPh = c.distAcc * 2.4;
    var movingNow = (c.moving || c.state === 'SPRINT' ||
                     c.state === 'TO_DRINK');
    c.y = gy + 0.10 + (movingNow ? Math.abs(Math.sin(hopPh)) * 0.13 : 0);
    c.pitch = movingNow ? Math.sin(hopPh + 0.7) * 0.22 :
              (c.state === 'DRINK' ? dipPitch(c) : -0.42);
    writeCritterMatrix(c);
  } else if (c.state === 'CLIMB' && c.climb){
    var cl = c.climb;
    cl.ang += dt * 2.3 * cl.dir;
    cl.y += dt * 1.05 * cl.dir;
    var done = cl.dir > 0 ? cl.y >= cl.yTop : cl.y <= cl.yTop;
    var p = trunkPoint(tree, cl.y, cl.ang);
    c.x = p.x; c.z = p.z; c.y = cl.y;
    c.heading = Math.atan2(p.cx - c.x, p.cz - c.z) +
                (cl.dir > 0 ? 0 : Math.PI);
    c.pitch = cl.dir > 0 ? -1.05 : 1.0;
    writeCritterMatrix(c);
    if (done){
      if (cl.dir > 0){
        c.state = 'TREE';
        c.climbAng = cl.ang;
        /* frozen, watching: 2–4s after a startle climb, shorter
           for a voluntary sit */
        c.stateT = _t + 2 + Math.random() * 2.5;
        c.pitch = -0.5;
        writeCritterMatrix(c);
      } else {
        c.state = 'FORAGE';
        c.moving = false;
        c.pauseT = _t + 0.4 + Math.random();
        c.x = tree.x + Math.cos(cl.ang) * 0.5;
        c.z = tree.z + Math.sin(cl.ang) * 0.5;
      }
      c.climb = null;
    }
  } else if (c.state === 'TREE'){
    /* stillness is the behaviour; nothing to do per frame */
  } else if (c.state === 'DRINK'){
    c.pitch = dipPitch(c);
    writeCritterMatrix(c);
  }
}
function dipPitch(c){
  var ph = (_t * 0.8 + (c.phaseSeed || 0)) % 1;
  return ph < 0.4 ? (ph / 0.4) * 0.7 :
         (ph < 0.62 ? 0.7 : (1 - (ph - 0.62) / 0.38) * 0.7);
}

/* ---------------------------------------------------------------------------
   CHIPMUNKS — dash-freeze-dash between cover points; startled,
   they run for the burrow point and are GONE (mesh hidden) for a
   few seconds. Silent by design.
   --------------------------------------------------------------------------- */
function spawnChipmunk(){
  for (var tries = 0; tries < 8; tries++){
    var trees = deriveTreesNear(playerPos.x, playerPos.z, 120);
    if (!trees.length) return false;
    var tr = trees[(Math.random() * trees.length) | 0];
    var d = distToPlayer(tr.x, tr.z);
    if (d < 50 || d > 120) continue;
    if (buildingDist(tr.x, tr.z) < 25) continue;
    var ax = tr.x + (Math.random() - 0.5) * 10;
    var az = tr.z + (Math.random() - 0.5) * 10;
    if (!isGrass(ax, az)) continue;
    if (woodsScore(ax, az, 12) < 18) continue;
    var covers = [{ x: ax, z: az }];
    for (var i = 0; i < 5 && covers.length < 5; i++){
      var cx2 = ax + (Math.random() - 0.5) * 16;
      var cz2 = az + (Math.random() - 0.5) * 16;
      if (isGrass(cx2, cz2)) covers.push({ x: cx2, z: cz2 });
    }
    if (covers.length < 3) continue;
    if (!chipmunkGeo) chipmunkGeo = buildChipmunkGeometry();
    var mesh = new THREE.Mesh(chipmunkGeo, getCritterMat());
    mesh.frustumCulled = false;
    scene.add(mesh);
    var c = {
      kind: 'chipmunk', mesh: mesh, covers: covers,
      burrow: covers[0], ci: 0,
      state: 'FREEZE',
      x: ax, y: 0, z: az, heading: Math.random() * 6.28, pitch: 0,
      tx: ax, tz: az, moving: false,
      distAcc: Math.random() * 2,
      nextThink: _t + Math.random() * 0.4,
      stateT: _t + 0.5 + Math.random(),
      visitT: _t + 35 + Math.random() * 60,
      shore: null, phaseSeed: Math.random(), born: _t
    };
    c.y = groundY(ax, az) + 0.055;
    creatures.push(c);
    writeCritterMatrix(c);
    return true;
  }
  return false;
}
function chipmunkThink(c){
  var d = distToPlayer(c.x, c.z);
  if (c.state === 'HIDE'){
    if (_t >= c.stateT){
      c.state = 'FREEZE';
      c.stateT = _t + 0.6;
      c.x = c.burrow.x; c.z = c.burrow.z;
      c.y = groundY(c.x, c.z) + 0.055;
      c.mesh.visible = true;
      writeCritterMatrix(c);
    }
    return;
  }
  if (d < 4 && c.state !== 'TO_BURROW'){
    c.state = 'TO_BURROW';
    c.tx = c.burrow.x; c.tz = c.burrow.z;
    c.moving = true;
    return;
  }
  if (c.state === 'FREEZE' && _t >= c.stateT){
    if (_t >= c.visitT){
      c.visitT = _t + 40 + Math.random() * 70;
      var sh = nearestShore(c.x, c.z, 40);
      if (sh){
        c.state = 'TO_DRINK';
        c.tx = sh.bankX; c.tz = sh.bankZ; c.shore = sh;
        c.moving = true;
        return;
      }
    }
    var nxt = c.covers[(Math.random() * c.covers.length) | 0];
    c.tx = nxt.x; c.tz = nxt.z;
    c.state = 'DASH';
    c.moving = true;
  }
  if (c.state === 'DRINK' && _t >= c.stateT){
    c.state = 'DASH';
    c.tx = c.burrow.x; c.tz = c.burrow.z;
    c.moving = true;
  }
}
function chipmunkTick(c, dt){
  if (c.state === 'HIDE') return;
  if (c.moving){
    var dx = c.tx - c.x, dz = c.tz - c.z;
    var dist = Math.sqrt(dx * dx + dz * dz);
    var speed = c.state === 'TO_BURROW' ? 5.2 : 4.2;
    if (dist < 0.2){
      c.moving = false;
      if (c.state === 'TO_BURROW'){
        c.state = 'HIDE';
        c.stateT = _t + 4 + Math.random() * 5;
        c.mesh.visible = false;
        return;
      }
      if (c.state === 'TO_DRINK'){
        c.state = 'DRINK';
        c.stateT = _t + 2.5 + Math.random() * 1.5;
        c.heading = Math.atan2(c.shore.waterX - c.x,
                               c.shore.waterZ - c.z);
      } else {
        c.state = 'FREEZE';
        c.stateT = _t + 0.8 + Math.random() * 1.8;
        if (Math.random() < 0.4)
          c.heading += (Math.random() - 0.5) * 1.6;
      }
    } else {
      var step = Math.min(dist, speed * dt);
      c.x += dx / dist * step;
      c.z += dz / dist * step;
      c.distAcc += step;
      c.heading = Math.atan2(dx, dz);
    }
  }
  var gy = groundY(c.x, c.z);
  c.y = gy + 0.055 + (c.moving ? Math.abs(Math.sin(c.distAcc * 4.2)) * 0.05 : 0);
  c.pitch = c.state === 'DRINK' ? dipPitch(c) :
            (c.moving ? Math.sin(c.distAcc * 4.2 + 0.7) * 0.15 : 0);
  writeCritterMatrix(c);
}
function writeCritterMatrix(c){
  var d = dummy();
  d.position.set(c.x, c.y, c.z);
  d.rotation.set(c.pitch || 0, c.heading || 0, 0);
  d.updateMatrix();
  c.mesh.matrixAutoUpdate = false;
  c.mesh.matrix.copy(d.matrix);
  c.mesh.matrixWorldNeedsUpdate = true;
}
function freeCritter(c){
  try { scene.remove(c.mesh); } catch(e){}
  var ci = creatures.indexOf(c);
  if (ci >= 0) creatures.splice(ci, 1);
}

/* ---------------------------------------------------------------------------
   DEER — Quaternius CC0 GLB (wildlife/Deer.glb, License.txt beside
   it). A territory is a FIXED anchor in deep habitat; the group
   grazes a small circuit of route-checked points around it. The
   ROAD RULE lives in deerRouteOk: a leg that would cross a road
   needs woods on the far side, or the deer does not go — it peeks
   at the tree line instead (PEEK state). Mixers update on the
   rate LOD: full rate < 40u, half 40–80u, frozen beyond.
   --------------------------------------------------------------------------- */
var deerProto = null;      /* { scene, clips: {name: AnimationClip} } */
var deerLoading = false;
var deerAnchor = null;     /* { x, z } chosen once per session */
function loadDeerProto(cb){
  if (deerProto){ cb(deerProto); return; }
  if (deerLoading) return;
  deerLoading = true;
  try {
    var url = 'wildlife/Deer.glb';
    try {
      var base = document.querySelector('base');
      if (base && base.href) url = new URL(url, base.href).href;
    } catch(e){}
    var loader = new THREE.GLTFLoader();
    loader.load(url, function(gltf){
      try {
        var clips = {};
        (gltf.animations || []).forEach(function(cl){
          clips[cl.name] = cl;
        });
        /* scale: measure and set a unit scale so the deer stands
           DEER_H runtime units at the shoulder-to-head frame —
           the raw model is ~4.26 units tall, far too big */
        var box = new THREE.Box3().setFromObject(gltf.scene);
        var h = Math.max(0.01, box.max.y - box.min.y);
        gltf.scene.scale.setScalar(DEER_H / h);
        var wrap = new THREE.Group();
        wrap.add(gltf.scene);
        deerProto = { scene: wrap, clips: clips };
        cb(deerProto);
      } catch(e){ deerLoading = false; deerAnchor = null; }
    }, undefined, function(){ deerLoading = false; deerAnchor = null; });
  } catch(e){ deerLoading = false; deerAnchor = null; }
}
function deerSetClip(d, name, fade){
  var proto = deerProto;
  if (!proto || !d.mixer) return;
  var clip = proto.clips[name] || proto.clips['Idle'] || null;
  if (!clip || d.clipName === name) return;
  var action = d.mixer.clipAction(clip);
  action.enabled = true;
  action.setEffectiveWeight(1);
  action.play();
  if (d.action && d.action !== action){
    d.action.crossFadeTo(action, fade || 0.35, false);
  }
  d.action = action;
  d.clipName = name;
}
/* deerGroupSize(wild) — how many deer a territory holds, from
   its wildness (Joshua 16:36: density follows wildness): a tame
   edge territory holds a pair; deep country holds a full group
   (the CAPS.deer ceiling stands — never more than 4). */
function deerGroupSize(wild){
  return clamp(2 + Math.round((wild || 0) * 2), 2, CAPS.deer);
}
/* Effective alert/flee radii for one deer: the base radii scaled
   by the deer's territory wildness (DEER_WILD_BOLD). Tame deer
   keep the full .5 nerve (25 / 12); wild-country deer are bolder
   (down to 17.5 / 8.4) — they hold, graze and stay visible. */
function deerAlertR(d){ return DEER_ALERT_R * (1 - DEER_WILD_BOLD * (d.wild || 0)); }
function deerFleeR(d){ return DEER_FLEE_R * (1 - DEER_WILD_BOLD * (d.wild || 0)); }
function spawnDeerGroup(){
  if (deerAnchor) return false;
  /* TERRITORY GATE — Joshua's rulings: only deep habitat, far from
     houses, no road nearby. Sampled on a ring around the player
     (the group lives where the player can WANDER into it, not on
     the road past it). WILDLIFE PASS (16:36): among the spots
     that pass the gates, the group now forms at the WILDEST one
     (up to 8 gate-passing candidates are scored) — so near
     development the only territories are tame ones (a shy pair),
     and in undeveloped country the group forms deep, at full
     strength. First-match became best-match; the gates are the
     .5 gates, with one repair noted inline. */
  var trees = deriveTreesNear(playerPos.x, playerPos.z, 190);
  var anchor = null, passed = 0;
  for (var i = 0; i < trees.length && passed < 8; i++){
    var tr = trees[i];
    var d = distToPlayer(tr.x, tr.z);
    if (d < 80 || d > 185) continue;
    if (buildingDist(tr.x, tr.z) < DEER_BUILD_MIN) continue;
    /* no road within DEER_ROAD_MIN of the anchor (buildings are
       gated separately by buildingDist above; SOLID here would
       also match tree trunks, so the ring tests ROAD only) */
    var roadNear = false;
    var ROAD_M = (typeof COLLISION_MATERIALS !== 'undefined')
      ? COLLISION_MATERIALS.ROAD : 2;
    for (var a = 0; a < 8 && !roadNear; a++){
      var sx = tr.x + Math.cos(a * Math.PI / 4) * DEER_ROAD_MIN;
      var sz = tr.z + Math.sin(a * Math.PI / 4) * DEER_ROAD_MIN;
      if (matAt(sx, sz) === ROAD_M) roadNear = true;
    }
    if (roadNear) continue;
    /* woods gate — REPAIR (wildlife pass): the .5 line compared
       the woodsScore OBJECT to DEER_WOODS_MIN, which is never
       true in JS, so this gate silently never bit; deerRouteOk
       has always compared .mean. Compare .mean here too, as the
       .5 design intended (DEER_WOODS_MIN = mean cover). */
    if (woodsScore(tr.x, tr.z, 30).mean < DEER_WOODS_MIN) continue;
    passed++;
    var w = wildnessAt(tr.x, tr.z);
    if (!anchor || w > anchor.wild)
      anchor = { x: tr.x, z: tr.z, wild: w };
  }
  if (!anchor) return false;
  deerAnchor = anchor;
  loadDeerProto(function(proto){
    try {
      /* group size rides the territory's wildness (16:36):
         tame pair -> deep-country full group */
      var n = deerGroupSize(anchor.wild);
      for (var i = 0; i < n; i++){
        var clone;
        if (THREE.SkeletonUtils && THREE.SkeletonUtils.clone)
          clone = THREE.SkeletonUtils.clone(proto.scene);
        else
          clone = proto.scene.clone(true);
        scene.add(clone);
        var gx = anchor.x + (Math.random() - 0.5) * 10;
        var gz = anchor.z + (Math.random() - 0.5) * 10;
        var d = {
          kind: 'deer', obj: clone, anchor: anchor,
          /* territory wildness, fixed at spawn: drives this
             deer's nerve (alert/flee radii) and graze range */
          wild: anchor.wild || 0,
          state: 'GRAZE',
          x: gx, y: groundY(gx, gz), z: gz,
          heading: Math.random() * 6.28, pitch: 0,
          tx: gx, tz: gz, moving: false,
          mixer: new THREE.AnimationMixer(clone),
          action: null, clipName: '',
          nextThink: _t + Math.random() * 0.5,
          stateT: _t + 2 + Math.random() * 5,
          visitT: _t + 50 + Math.random() * 80,
          mixAcc: 0, shore: null, born: _t,
          grazeSeed: Math.random() * 100
        };
        deerSetClip(d, 'Idle_Headlow', 0.1);
        creatures.push(d);
        writeDeerMatrix(d);
      }
    } catch(e){
      deerAnchor = null;
    }
  });
  return true;
}
function writeDeerMatrix(d){
  var obj = d.obj;
  obj.position.set(d.x, d.y, d.z);
  obj.rotation.set(0, d.heading || 0, 0);
}
function deerPickGraze(d){
  /* a new graze point near the anchor whose leg from HERE passes
     the road rule; blocked legs become a PEEK at the tree line.
     WILDLIFE PASS (16:36): the circuit WIDENS with wildness —
     tame deer hug the anchor's tree line (the .5 circuit, up to
     ~20 u out); deep-country deer range up to ~50 u out, grazing
     in the open where he can see them. */
  for (var i = 0; i < 6; i++){
    var a = Math.random() * Math.PI * 2;
    var r = 4 + Math.random() * (16 + 30 * (d.wild || 0));
    var gx = d.anchor.x + Math.cos(a) * r;
    var gz = d.anchor.z + Math.sin(a) * r;
    if (!isGrass(gx, gz)) continue;
    var verdict = deerRouteOk(d.x, d.z, gx, gz);
    if (verdict.ok){
      d.tx = gx; d.tz = gz; d.moving = true;
      d.state = 'GRAZE';
      return;
    }
    if (verdict.peekAt){
      d.tx = verdict.peekAt.x; d.tz = verdict.peekAt.z;
      d.moving = true;
      d.state = 'TO_PEEK';
      return;
    }
    /* hard-blocked (crossing into non-habitat): try another point */
  }
  d.stateT = _t + 3 + Math.random() * 4;   /* stay and graze here */
}
function deerThink(d){
  var dist = distToPlayer(d.x, d.z);
  if (d.state === 'FLEE'){
    if (dist > 30 && _t >= d.stateT){
      d.state = 'GRAZE'; d.moving = false;
      deerSetClip(d, 'Idle_Headlow');
      deerPickGraze(d);
    }
    return;
  }
  if (dist < deerFleeR(d)){
    /* FLEE — away from the player, deeper into the habitat; every
       flee leg is route-checked too (a deer does not flee ACROSS a
       road into a yard — it runs along the woods) */
    var away = Math.atan2(d.x - playerPos.x, d.z - playerPos.z);
    var fx = d.x + Math.sin(away) * 30, fz = d.z + Math.cos(away) * 30;
    var v = deerRouteOk(d.x, d.z, fx, fz);
    if (!v.ok && v.peekAt){ fx = v.peekAt.x; fz = v.peekAt.z; }
    else if (!v.ok){
      fx = d.x + Math.cos(away) * 18; fz = d.z - Math.sin(away) * 18;
    }
    d.tx = fx; d.tz = fz; d.moving = true;
    d.state = 'FLEE';
    d.stateT = _t + 1.2;
    deerSetClip(d, 'Gallop');
    return;
  }
  if (dist < deerAlertR(d)){
    if (d.state !== 'ALERT'){
      d.state = 'ALERT'; d.moving = false;
      deerSetClip(d, 'Idle');
    }
    d.heading = Math.atan2(playerPos.x - d.x, playerPos.z - d.z);
    writeDeerMatrix(d);
    return;
  }
  if (d.state === 'ALERT'){
    d.state = 'GRAZE';
    deerSetClip(d, 'Idle_Headlow');
    d.stateT = _t + 1 + Math.random() * 3;
    return;
  }
  if (d.state === 'DRINK'){
    if (_t >= d.stateT){
      d.state = 'GRAZE';
      deerSetClip(d, 'Idle_Headlow');
      d.tx = d.anchor.x; d.tz = d.anchor.z; d.moving = true;
    }
    return;
  }
  if (d.state === 'GRAZE' && !d.moving){
    if (_t >= d.visitT){
      d.visitT = _t + 60 + Math.random() * 90;
      var sh = nearestShore(d.anchor.x, d.anchor.z, 80);
      if (sh){
        var v2 = deerRouteOk(d.x, d.z, sh.bankX, sh.bankZ);
        if (v2.ok){
          d.state = 'TO_DRINK';
          d.tx = sh.bankX; d.tz = sh.bankZ; d.shore = sh;
          d.moving = true;
          deerSetClip(d, 'Walk');
          return;
        }
      }
    }
    if (_t >= d.stateT) deerPickGraze(d);
  }
  if (d.state === 'PEEK' && _t >= d.stateT){
    d.state = 'GRAZE';
    deerSetClip(d, 'Idle_Headlow');
    d.tx = d.anchor.x; d.tz = d.anchor.z; d.moving = true;
    deerSetClip(d, 'Walk');
  }
}
function deerTick(d, dt){
  var dist = distToPlayer(d.x, d.z);
  /* animation-rate LOD */
  if (d.mixer){
    if (dist < 40) d.mixer.update(dt);
    else if (dist < ANIM_R){
      d.mixAcc += dt;
      if (d.mixAcc >= 0.066){
        d.mixer.update(d.mixAcc);
        d.mixAcc = 0;
      }
    }
    /* beyond ANIM_R: frozen (and not ticked at all by the caller) */
  }
  if (d.moving){
    var speed = d.state === 'FLEE' ? DEER_FLEE_SPEED :
                (d.state === 'GRAZE' || d.state === 'TO_PEEK' ||
                 d.state === 'TO_DRINK' ? DEER_WALK_SPEED : 0);
    if (speed > 0){
      if (d.state === 'GRAZE' || d.state === 'TO_DRINK' ||
          d.state === 'TO_PEEK')
        deerSetClip(d, 'Walk');   /* FLEE's Gallop is set in think */
      var dx = d.tx - d.x, dz = d.tz - d.z;
      var len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.4){
        d.moving = false;
        if (d.state === 'TO_PEEK'){
          d.state = 'PEEK';
          d.stateT = _t + 5 + Math.random() * 5;
          /* head out at the tree line, facing the road it will
             not cross */
          d.heading = Math.atan2(d.tx - d.anchor.x, d.tz - d.anchor.z);
          deerSetClip(d, 'Idle');
        } else if (d.state === 'TO_DRINK'){
          d.state = 'DRINK';
          d.stateT = _t + 5;
          d.heading = Math.atan2(d.shore.waterX - d.x,
                                 d.shore.waterZ - d.z);
          deerSetClip(d, 'Idle_Headlow');
        } else {
          d.state = 'GRAZE';
          d.stateT = _t + 4 + Math.random() * 7;
          deerSetClip(d, Math.random() < 0.65 ? 'Idle_Headlow' : 'Idle');
        }
        writeDeerMatrix(d);
      } else {
        var step = Math.min(len, speed * dt);
        d.x += dx / len * step;
        d.z += dz / len * step;
        var targetH = Math.atan2(dx, dz);
        var dh = targetH - d.heading;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        d.heading += dh * Math.min(1, dt * (d.state === 'FLEE' ? 5 : 3));
        d.y = groundY(d.x, d.z);
        writeDeerMatrix(d);
      }
    }
  }
}
function freeDeer(d){
  try { scene.remove(d.obj); } catch(e){}
  try { if (d.mixer) d.mixer.stopAllAction(); } catch(e){}
  var ci = creatures.indexOf(d);
  if (ci >= 0) creatures.splice(ci, 1);
}

/* ---------------------------------------------------------------------------
   BUTTERFLIES — one InstancedMesh, fully GPU (see the material).
   The CPU writes the anchor/seed attributes ONCE at spawn; the
   only per-frame cost is the shared uTime uniform the whole module
   already writes. Day-only: at night the mesh hides.
   --------------------------------------------------------------------------- */
var butterflySet = null;
function spawnButterflies(){
  if (butterflySet) return true;
  var geo = buildButterflyGeometry();
  var anchors = new Float32Array(CAP_BFLY * 3);
  var seeds = new Float32Array(CAP_BFLY * 4);
  var placed = 0;
  for (var i = 0; i < CAP_BFLY * 6 && placed < CAP_BFLY; i++){
    var a = Math.random() * Math.PI * 2;
    var r = 12 + Math.random() * 45;
    var x = playerPos.x + Math.cos(a) * r;
    var z = playerPos.z + Math.sin(a) * r;
    if (!isGrass(x, z)) continue;
    /* grass near water or a field edge (canopy edge) */
    var sh = nearestShore(x, z, 30);
    var ws = woodsScore(x, z, 14);
    if (!sh && !(ws > 4 && ws < 45)) continue;
    anchors[placed * 3] = x;
    anchors[placed * 3 + 1] = groundY(x, z) + 0.8 + Math.random() * 0.5;
    anchors[placed * 3 + 2] = z;
    seeds[placed * 4] = Math.random();
    seeds[placed * 4 + 1] = 1.2 + Math.random() * 1.8;
    seeds[placed * 4 + 2] = 0.8 + Math.random() * 0.5;
    seeds[placed * 4 + 3] = Math.random();
    placed++;
  }
  if (!placed) return false;
  var mesh = new THREE.InstancedMesh(geo, makeButterflyMaterial(), placed);
  mesh.frustumCulled = false;
  var d = dummy();
  d.position.set(0, 0, 0); d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1);
  d.updateMatrix();
  /* species deal (v1.3): shuffle the kind order, then deal
     round-robin — every species shows before any repeats, so two
     butterflies side by side in one meadow are two different
     species whenever the set is smaller than the palette. The
     tint rides the iColor instanced attribute (LINEAR values via
     THREE.Color, the colArr lesson), NOT instanceColor. */
  var deal = [];
  for (var di = 0; di < BUTTERFLY_KINDS.length; di++) deal.push(di);
  for (var dj = deal.length - 1; dj > 0; dj--){
    var dk = (Math.random() * (dj + 1)) | 0;
    var dtmp = deal[dj]; deal[dj] = deal[dk]; deal[dk] = dtmp;
  }
  var tintArr = new Float32Array(placed * 3);
  var kindIdx = [];
  for (var j = 0; j < placed; j++){
    mesh.setMatrixAt(j, d.matrix);
    var kind = BUTTERFLY_KINDS[deal[j % deal.length]];
    kindIdx.push(deal[j % deal.length]);
    var tc = new THREE.Color(kind.color);
    tintArr[j * 3] = tc.r; tintArr[j * 3 + 1] = tc.g;
    tintArr[j * 3 + 2] = tc.b;
    seeds[j * 4 + 2] *= kind.size;
  }
  mesh.count = placed;
  geo.setAttribute('iAnchor',
    new THREE.InstancedBufferAttribute(anchors, 3));
  geo.setAttribute('iSeed',
    new THREE.InstancedBufferAttribute(seeds, 4));
  geo.setAttribute('iColor',
    new THREE.InstancedBufferAttribute(tintArr, 3));
  scene.add(mesh);
  butterflySet = { mesh: mesh, count: placed, kinds: kindIdx,
                   cx: playerPos.x, cz: playerPos.z };
  return true;
}
/* day/night rides part 1's isDay() (the daycycle's own clock) */

/* ---------------------------------------------------------------------------
   CORE LOOP — fish pattern: one render tick; a 0.5s sweep owns
   spawning, despawning, voice gains and cleanup; thinks stagger at
   0.2–0.5s per creature; per-frame updates only animate movers
   within ANIM_R.
   --------------------------------------------------------------------------- */
var _t = 0, _sweepT = 0, _spawnT = 0, _spawnKind = 0;
function countKind(kind){
  var n = 0;
  for (var i = 0; i < creatures.length; i++)
    if (creatures[i].kind === kind) n++;
  return n;
}
function sweep(){
  var i, c;
  /* despawn beyond DESPAWN_R */
  for (i = creatures.length - 1; i >= 0; i--){
    c = creatures[i];
    if (distToPlayer(c.x, c.z) > DESPAWN_R){
      if (c.kind === 'bird') freeBird(c);
      else if (c.kind === 'deer'){
        freeDeer(c);
        /* the whole group leaves together; a new territory may
           form elsewhere later */
        if (!creatures.some(function(o){ return o.kind === 'deer'; }))
          deerAnchor = null;
      }
      else freeCritter(c);
    }
  }
  /* song gains follow the distance law; finished phrases release
     their nodes */
  for (i = 0; i < creatures.length; i++){
    c = creatures[i];
    if (c.kind !== 'bird') continue;
    if (c.voice){
      if (c.state !== 'PERCHED' && c.songUntil === 0){
        /* voice exists but nothing scheduled (post-flush remnant) */
      } else if (c.voice.running && c.voice.running()){
        var dd = distToPlayer(c.x, c.z);
        var g = dd >= SONG_R ? 0 :
          SONG_GAIN * c.sp.songPeak * Math.pow(1 - dd / SONG_R, 1.6);
        c.voice.setGain(g, c.voice.now());
      }
      if (c.songUntil && c.voice.ctx &&
          c.voice.ctx.currentTime > c.songUntil + 0.1){
        c.songNodes.length = 0;
        c.songUntil = 0;
      }
      if (c.state !== 'PERCHED' && !c.songUntil){
        songStop(c, true);
      }
    }
  }
  /* scheduled cleanups (dove whistles, chatter voices) */
  for (i = pendingCleanup.length - 1; i >= 0; i--){
    if (_t >= pendingCleanup[i].t){
      try { pendingCleanup[i].fn(); } catch(e){}
      pendingCleanup.splice(i, 1);
    }
  }
  /* butterflies: day-only visibility; the set re-forms near the
     player when he has wandered well away from its anchors */
  if (butterflySet){
    butterflySet.mesh.visible = isDay();
    if (distToPlayer(butterflySet.cx, butterflySet.cz) > 260){
      try { scene.remove(butterflySet.mesh); } catch(e){}
      butterflySet = null;
    }
  }
}
function spawnRotation(){
  /* one spawn attempt every 2s, rotating kinds, caps enforced */
  _spawnKind = (_spawnKind + 1) % 5;
  try {
    if (_spawnKind === 0 && countKind('bird') < CAP_BIRDS) spawnBird();
    else if (_spawnKind === 1 && countKind('squirrel') < CAP_SQUIRRELS) spawnSquirrel();
    else if (_spawnKind === 2 && countKind('chipmunk') < CAP_CHIPMUNKS) spawnChipmunk();
    else if (_spawnKind === 3) spawnDeerGroup();
    else if (_spawnKind === 4 && !butterflySet) spawnButterflies();
  } catch(e){}
}
function tick(dt){
  _t += dt;
  U_TIME.value = _t;
  var P = gamePlayer();
  if (!P) return;
  playerPos = (P.position && typeof P.position.x === 'number')
    ? P.position : P;
  var i, c;
  for (i = 0; i < creatures.length; i++){
    c = creatures[i];
    if (_t >= c.nextThink){
      c.nextThink = _t + 0.22 + Math.random() * 0.25;
      try {
        if (c.kind === 'bird') birdThink(c);
        else if (c.kind === 'squirrel') squirrelThink(c);
        else if (c.kind === 'chipmunk') chipmunkThink(c);
        else if (c.kind === 'deer') deerThink(c);
      } catch(e){}
    }
  }
  for (i = 0; i < creatures.length; i++){
    c = creatures[i];
    if (distToPlayer(c.x, c.z) > ANIM_R) continue;
    try {
      if (c.kind === 'bird') birdTick(c, dt);
      else if (c.kind === 'squirrel') squirrelTick(c, dt);
      else if (c.kind === 'chipmunk') chipmunkTick(c, dt);
      else if (c.kind === 'deer') deerTick(c, dt);
    } catch(e){}
  }
  if (_t - _sweepT >= SWEEP_S){
    _sweepT = _t;
    try { sweep(); } catch(e){}
  }
  if (_t - _spawnT >= 2){
    _spawnT = _t;
    spawnRotation();
  }
}

/* ---------------------------------------------------------------------------
   DEBUG HANDLE — window.__WILDLIFE (fish precedent)
   --------------------------------------------------------------------------- */
function parityCheck(){
  /* every trunk the game actually built must have a derived
     anchor within 0.02u — the two transcriptions of the tree math
     agree, or this says so */
  var out = { trunks: 0, matched: 0, pct: 0, checked: 0 };
  try {
    var T = window.__PKG_TREES;
    if (!T || !T.tiles) return out;
    var MF = window.MapFrame;
    var keys = Object.keys(T.tiles);
    for (var ki = 0; ki < keys.length; ki++){
      var tile = T.tiles[keys[ki]];
      if (!tile || !tile.trunks) continue;
      for (var ti = 0; ti < tile.trunks.length; ti++){
        var tr = tile.trunks[ti];
        out.trunks++;
        if (out.checked >= 400) continue;
        out.checked++;
        var trees = deriveTreesInCell(tr.cc !== undefined ? tr.cc : -1,
                                      tr.rr !== undefined ? tr.rr : -1);
        /* trunk records do not carry their cell; fall back to a
           neighbourhood derivation around the trunk point */
        if (!trees.length && MF){
          var near = deriveTreesNear(tr.x, tr.z, 2);
          trees = near;
        }
        var ok = false;
        for (var j = 0; j < trees.length; j++){
          var dx = trees[j].x - tr.x, dz = trees[j].z - tr.z;
          if (dx * dx + dz * dz <= 0.02 * 0.02){ ok = true; break; }
        }
        if (ok) out.matched++;
      }
    }
    out.pct = out.checked ? (out.matched / out.checked) * 100 : 0;
  } catch(e){}
  return out;
}
window.__WILDLIFE = {
  version: VERSION,
  counts: function(){
    var out = { total: creatures.length, byKind: {}, byState: {} };
    for (var i = 0; i < creatures.length; i++){
      var c = creatures[i];
      var k = c.kind === 'bird' ? 'bird:' + c.key : c.kind;
      out.byKind[k] = (out.byKind[k] || 0) + 1;
      var s = c.kind + ':' + c.state;
      out.byState[s] = (out.byState[s] || 0) + 1;
    }
    if (butterflySet)
      out.byKind.butterflies = butterflySet.count;
    return out;
  },
  nearestBird: function(){
    var best = null, bd = 1e9;
    for (var i = 0; i < creatures.length; i++){
      var c = creatures[i];
      if (c.kind !== 'bird') continue;
      var d = distToPlayer(c.x, c.z);
      if (d < bd){ bd = d; best = c; }
    }
    if (!best) return null;
    var g = bd >= SONG_R ? 0 :
      SONG_GAIN * best.sp.songPeak * Math.pow(1 - bd / SONG_R, 1.6);
    return { species: best.key, dist: bd, songGain: g,
             state: best.state };
  },
  parityCheck: parityCheck,
  deerRouteOk: deerRouteOk,
  deriveTreesInCell: deriveTreesInCell,
  creatures: function(){ return creatures; },
  /* harness hooks: deterministic placement for the acceptance
     tests (spawn at a chosen perch, teleport the player reference
     is the game's own — tests drive the real player object) */
  _test: {
    spawnBirdAt: function(key, treeRec){
      var b = allocBird(key);
      if (!b) return null;
      b.perch = treeRec;
      b.x = treeRec.perchX; b.y = treeRec.perchY; b.z = treeRec.perchZ;
      setFlap(b, 0, 0, b.sp.flapHz, 1, true);
      writeBirdMatrix(b);
      return b;
    },
    pickPerch: pickPerch,
    nearestShore: nearestShore,
    setVisitNow: function(c){ c.visitT = _t - 1; },
    think: function(c){
      if (c.kind === 'bird') birdThink(c);
      else if (c.kind === 'squirrel') squirrelThink(c);
      else if (c.kind === 'chipmunk') chipmunkThink(c);
      else if (c.kind === 'deer') deerThink(c);
    },
    tickCreature: function(c, dt){
      if (c.kind === 'bird') birdTick(c, dt);
      else if (c.kind === 'squirrel') squirrelTick(c, dt);
      else if (c.kind === 'chipmunk') chipmunkTick(c, dt);
      else if (c.kind === 'deer') deerTick(c, dt);
    },
    now: function(){ return _t; },
    advance: function(dt){ tick(dt); },
    /* wildlife-pass hooks (v1.3): the wildness measure and the
       deer density machinery, exposed so the acceptance harness
       can prove suburb-vs-deep-woods behaviour headlessly */
    wildnessAt: wildnessAt,
    roadDistAt: roadDistAt,
    deerGroupSize: deerGroupSize,
    deerAlertR: deerAlertR,
    deerFleeR: deerFleeR,
    deerPickGraze: deerPickGraze,
    spawnDeerGroup: spawnDeerGroup,
    butterflyKinds: BUTTERFLY_KINDS,
    butterflySet: function(){ return butterflySet; }
  }
};

/* ---------------------------------------------------------------------------
   BOOT — poll for the game's pieces, then register (fish pattern).
   In partial mode the package terrain/water globals exist, so the
   system runs there too (birds over the falls country included).
   --------------------------------------------------------------------------- */
var _tries = 0;
function boot(){
  _tries++;
  var ready = false;
  try {
    ready = typeof THREE !== 'undefined' &&
            typeof window.scene !== 'undefined' && !!window.scene &&
            !!gamePlayer() &&
            typeof Sim !== 'undefined' && !!Sim.onTick &&
            !!window.__PKG_CANOPY && !!window.MapFrame;
  } catch(e){}
  if (!ready){
    if (_tries < 240) setTimeout(boot, 250);
    return;
  }
  scene = window.scene;
  try {
    Sim.onTick('render', 66, function(dt){
      try { tick(typeof dt === 'number' ? dt : 0.016); } catch(e){}
    });
  } catch(e){}
}
if (typeof window !== 'undefined') boot();

})();
