/* ============================================================================
   GOLDEN ROSES — THE QUEST (Joshua, 2026-11-08)
   ----------------------------------------------------------------------------
   Joshua's answer to the beta testers' question "what am I supposed to
   do in this game": TEN golden roses stand planted across the world.
   Find all ten to complete this level. The roses steer testers to the
   places he wants tested. Only SEVEN sites are named so far (below);
   sites 8-10 are Joshua's to name — the system is built for 10 and the
   remaining slots stay empty until he sites them. DO NOT invent sites.

   THE ROSE is the v3 design from the golden-rose previews (same day):
   whole plant gold, every piece class its own shade of gold, the bloom
   the brightest with a gentle EMISSION shine + a small warm point
   light. The geometry/material builders below are the preview builders
   (zone-build/golden-rose-2026-11-08/roseInject3.js + roseDestroyed.js)
   ported unchanged in form, parameterised into a reusable asset.

   SHINE LAW (Joshua): the shine belongs to the LIVING, PLANTED rose
   only. Picked (in inventory / dropped) = intact plant, NO shine.
   Trampled = the crushed build (snapped stem, crushed bloom, scattered
   petals), NO shine, shades dulled.

   RULES (Joshua, 2026-11-08):
   - Pickup is the game's own: stand beside it, ACTION reads "Pick up",
     tap. NO walk-over collection (the pickup system's standing law).
   - Walking OVER THE TOP of a planted rose TRAMPLES it (crushed).
   - A trampled rose REGROWS at its site after ONE GAME HOUR
     (day length 7,440 real s = 24 game h, so 1 game h = 60 game min).
     The quest can never be soft-lock.
   - Picking a rose plays the BEND-DOWN (code-driven posture in
     index.html's animateHero paths — player.bendT; no authored rig
     clip exists and Blender is not on the build VM, stated in the
     build notes).
   - FIRST pickup ever: a full explanation popup — closes by tapping
     the world behind it OR its X (Joshua's corrected ruling 12:54).
   - Later pickups: a small popup — rose symbol on the LEFT + "N of 10".
   - At 10 of 10: a completion popup in the same family.
   - Inventory: roses stack in ONE slot (the general stacking rule
     lives in index.html's doPickup/renderInv); this module owns the
     world side: sites, trample, regrow, drop re-planting.

   WIRING (the eval-scope law): everything this module needs from
   index.html's indirect-eval block is PUBLISHED there (spawnPickup,
   pickups, inventory added to __publishWorldSurface by this build;
   scene/player/heightAt/sun/renderer were already published). Hooks
   the other way are explicit window calls from index.html:
   doPickup() -> __ROSES.onPicked(p) for kind 'rose', and dropItem()
   -> __ROSES.onDropSpawn(x, z). Nothing here typeof-guards a
   load-bearing path: if the published surface is missing the module
   stays unbooted and says so in its Report readout.
   ============================================================================ */
(function goldenRoses(){
'use strict';

var VERSION = '2026.11.08.10';
var LS_KEY = 'sa_roses_v1';
var KIND = 'rose', RNAME = 'Golden Rose';
var TOTAL = 10;                 /* the quest is TEN roses (Joshua) */
var REGROW_GAME_MIN = 60;       /* one game hour (Joshua's ruling) */
var TRAMPLE_R = 0.45;           /* "walking over the top of it" */
/* PICKED-DIRT FADE (Part 8b, ui 2026.11.08.10 — Joshua): the bare dirt
   a pickup leaves HEALS — it fades gradually back to normal ground
   over this many REAL milliseconds (150,000 = 2.5 minutes, gone well
   before his 5-minute walk-away-and-return test), driven off the
   site's persisted pick timestamp so leaving and returning mid-fade
   shows the right stage. The loose petals do NOT fade: they stay
   lying on the restored grass. */
var PICK_FADE_MS = 150000;

/* THE SEVEN NAMED SITES (runtime coords, each one verified against the
   shipped terrain in this build's recon boots: dry grass, not in
   water, not inside a road, visible on approach):
     1 Dollar Mill — the front yard of 535 Dollar Mill Rd SW on the
       spawn approach (the preview-proven spot; spawn is ~11 m away).
       The FIRST rose a tester meets.
     2 Chattahoochee — the east bank at z 2050; the waterline is at
       x ~-596 (surface 42.28), the rose stands at gy 42.44.
     3 Tatum Lake — the east shore; the drawn ring's edge is at
       x ~2132, lake surface 25.70, the rose stands at gy 25.85.
     4 Harper-Archer — the ground where Harper-Archer High School was
       (the game's own POI point for the school).
     5 Hamilton Homes — where Hamilton Homes will sit. No coordinate
       for this exists anywhere in the game's data or Joshua's notes;
       sited by the build at the game's only Hamilton anchor, the
       Hamilton E. Holmes station ground, FLAGGED in the build notes
       for Joshua to move with one word.
     6 MLK x Fairburn — the junction's NE corner (plaza side), off the
       crossing itself.
     7 MLK x Fulton Industrial — the junction's NE corner; the junction
       point was derived from the source road data's crossing of the
       two named roads and converted with the game's own xz(). */
var SITES = [
  { id:1, label:'Dollar Mill',        x: 1933.20, z: 6792.01 },
  { id:2, label:'Chattahoochee',      x: -588.00, z: 2050.00 },
  { id:3, label:'Tatum Lake',         x: 2140.00, z: 6000.00 },
  { id:4, label:'Harper-Archer',      x: 4060.00, z: 2595.00 },
  { id:5, label:'Hamilton Homes',     x: 7233.48, z: 5359.35 },
  { id:6, label:'MLK x Fairburn',     x: 3833.00, z: 2986.00 },
  { id:7, label:'MLK x Fulton Ind.',  x: 2572.00, z: 3691.00 }
  /* ids 8, 9, 10 — Joshua's to site. Intentionally absent. */
];

/* ======================= geometry (ported v3) ======================= */
var S = function(a, b, x){ var t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
var mixc = function(a, b, t){ return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

var GEO = null;   /* shared geometries, built once */
function buildGeos(THREE){
  if (GEO) return GEO;
  function petalGeo(o, PD, PB){
    var su = 14, sv = 10, ds = o.len / su, pos = [], col = [], idx = [];
    var tint = o.tint || 1;
    var cl = []; var r = o.baseR || 0.004, y = 0, i, j;
    for (i = 0; i <= su; i++){
      cl.push({ r: r, y: y });
      var u2 = (i + 1) / su;
      var phi = o.open * Math.pow(u2, 1.3) + (o.roll || 0) * S(0.7, 1, u2);
      r += Math.sin(phi) * ds; y += Math.cos(phi) * ds;
    }
    for (i = 0; i <= su; i++){
      var u = i / su, c = cl[i];
      var ph2 = o.open * Math.pow(u, 1.3) + (o.roll || 0) * S(0.7, 1, u);
      var nr = Math.cos(ph2), ny = -Math.sin(ph2);
      var halfW = o.wid * Math.pow(Math.sin(Math.PI * Math.min(1, 0.10 + 0.90 * u)), 0.75);
      for (j = 0; j <= sv; j++){
        var v = j / sv * 2 - 1;
        var off = o.cup * (v * v) * o.wid + (o.ruffle || 0) * Math.sin(v * Math.PI) * Math.sin(u * Math.PI * 2.5) * 0.12 * o.wid;
        pos.push(v * halfW, c.y + ny * off, c.r + nr * off);
        var t = Math.min(1, 0.10 + 0.55 * u + 0.45 * Math.abs(v) * u + 0.35 * S(0.78, 1, u));
        var cc = mixc(PD, PB, t);
        col.push(cc[0] * tint, cc[1] * tint, cc[2] * tint);
      }
    }
    for (i = 0; i < su; i++) for (j = 0; j < sv; j++){
      var a = i * (sv + 1) + j, b = a + sv + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  function jittered(geo, seed){
    var g = geo.clone();
    var f = 0.93 + ((seed * 37) % 11) / 11 * 0.14;
    var ca = g.attributes.color, i;
    for (i = 0; i < ca.count; i++) ca.setXYZ(i, ca.getX(i) * f, ca.getY(i) * f * 0.995, ca.getZ(i) * f * 0.98);
    return g;
  }
  function leafGeo(THREE, len, wid, deep, brite){
    var su = 8, sv = 6, pos = [], col = [], idx = [], i, j;
    for (i = 0; i <= su; i++){
      var u = i / su;
      var cy = Math.sin(u * Math.PI) * 0.10 * len - u * u * 0.30 * len, cz = u * len;
      var halfW = wid * Math.pow(Math.sin(Math.PI * Math.min(1, 0.07 + 0.93 * u)), 0.8);
      for (j = 0; j <= sv; j++){
        var v = j / sv * 2 - 1;
        pos.push(v * halfW, cy - (v * v) * wid * 0.55 + (1 - Math.abs(v)) * wid * 0.10, cz);
        var t = Math.min(1, 0.08 + 0.72 * u + 0.28 * (1 - Math.abs(v)) * u);
        var cc = mixc(deep, brite, t); col.push(cc[0], cc[1], cc[2]);
      }
    }
    for (i = 0; i < su; i++) for (j = 0; j < sv; j++){
      var a = i * (sv + 1) + j, b = a + sv + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  var PD = [0.365, 0.175, 0.011], PB = [0.86, 0.50, 0.052];
  var DD = [0.325, 0.155, 0.010], DB = [0.76, 0.44, 0.046];
  GEO = {
    petalGeo: petalGeo, jittered: jittered, leafGeo: leafGeo,
    leaflet: leafGeo(THREE, 0.085, 0.031, [0.255, 0.135, 0.008], [0.575, 0.325, 0.034]),
    leafletS: leafGeo(THREE, 0.065, 0.024, [0.255, 0.135, 0.008], [0.575, 0.325, 0.034]),
    leafletD: leafGeo(THREE, 0.085, 0.031, [0.225, 0.118, 0.007], [0.505, 0.285, 0.030]),
    leafletDS: leafGeo(THREE, 0.065, 0.024, [0.225, 0.118, 0.007], [0.505, 0.285, 0.030]),
    sepal: leafGeo(THREE, 0.05, 0.011, [0.235, 0.12, 0.006], [0.475, 0.285, 0.028]),
    sepalD: leafGeo(THREE, 0.05, 0.011, [0.205, 0.105, 0.005], [0.42, 0.25, 0.024]),
    PD: PD, PB: PB, DD: DD, DB: DB
  };
  return GEO;
}

/* ======================= materials (ported v3) ====================== */
function buildMats(THREE, envTex, dull){
  /* dull = the destroyed/picked palette: v3's shades ~10% darker,
     ~0.12 rougher, NO emissive anywhere (the shine law). */
  var M = {};
  if (!dull){
    M.petal = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.62, roughness: 0.43,
      envMap: envTex, envMapIntensity: 0.7, side: THREE.DoubleSide,
      emissive: new THREE.Color(1.0, 0.50, 0.055), emissiveIntensity: 0.34 });
    M.heart = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.295, 0.155, 0.008), metalness: 0.7, roughness: 0.45,
      envMap: envTex, envMapIntensity: 0.8, side: THREE.DoubleSide,
      emissive: new THREE.Color(0.9, 0.40, 0.03), emissiveIntensity: 0.20 });
    M.stem = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.62, 0.385, 0.048), metalness: 0.75, roughness: 0.30, envMap: envTex, envMapIntensity: 0.9 });
    M.shoot = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.50, 0.29, 0.028), metalness: 0.72, roughness: 0.40, envMap: envTex, envMapIntensity: 0.85 });
    M.calyx = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.435, 0.255, 0.026), metalness: 0.7, roughness: 0.48, envMap: envTex, envMapIntensity: 0.8, side: THREE.DoubleSide });
    M.sepal = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.65, roughness: 0.55, envMap: envTex, envMapIntensity: 0.75, side: THREE.DoubleSide });
    M.leaf = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.65, roughness: 0.55, envMap: envTex, envMapIntensity: 0.75, side: THREE.DoubleSide });
    M.thorn = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.22, 0.115, 0.008), metalness: 0.75, roughness: 0.45, envMap: envTex, envMapIntensity: 0.85 });
  } else {
    M.petal = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.60, roughness: 0.55, envMap: envTex, envMapIntensity: 0.65, side: THREE.DoubleSide });
    M.heart = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.26, 0.135, 0.007), metalness: 0.68, roughness: 0.57, envMap: envTex, envMapIntensity: 0.7, side: THREE.DoubleSide });
    M.stem = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.60, 0.37, 0.045), metalness: 0.72, roughness: 0.43, envMap: envTex, envMapIntensity: 0.8 });
    M.shoot = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.44, 0.25, 0.024), metalness: 0.7, roughness: 0.52, envMap: envTex, envMapIntensity: 0.75 });
    M.calyx = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.385, 0.22, 0.022), metalness: 0.68, roughness: 0.6, envMap: envTex, envMapIntensity: 0.7, side: THREE.DoubleSide });
    M.sepal = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.62, roughness: 0.66, envMap: envTex, envMapIntensity: 0.65, side: THREE.DoubleSide });
    M.leaf = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.62, roughness: 0.67, envMap: envTex, envMapIntensity: 0.65, side: THREE.DoubleSide });
    M.thorn = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.195, 0.10, 0.007), metalness: 0.72, roughness: 0.57, envMap: envTex, envMapIntensity: 0.75 });
  }
  return M;
}

/* the game's own sky, PMREM'd once — the preview recipe, so the gold
   reflects the world's own sky/sun exactly as Joshua approved it */
function buildEnv(THREE, renderer, scene, sun){
  var pmrem = new THREE.PMREMGenerator(renderer);
  var es = new THREE.Scene();
  var sg = new THREE.SphereGeometry(60, 24, 16);
  var sp = sg.attributes.position, sc = [];
  var skyC = new THREE.Color(0x6f9fd0), horC = new THREE.Color(0xdcd6bd), gndC = new THREE.Color(0x46523a);
  try { if (scene.background && scene.background.isColor) skyC.copy(scene.background); } catch (e) {}
  try { if (scene.fog && scene.fog.color) horC.copy(scene.fog.color).lerp(new THREE.Color(0xfff2cf), 0.35); } catch (e) {}
  for (var i = 0; i < sp.count; i++){
    var ny = sp.getY(i) / 60, c;
    if (ny >= 0) c = horC.clone().lerp(skyC, Math.pow(Math.min(1, ny * 1.6), 0.65));
    else c = horC.clone().lerp(gndC, Math.min(1, -ny * 2.2));
    sc.push(c.r, c.g, c.b);
  }
  sg.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
  es.add(new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })));
  try {
    var sd = sun.position.clone().sub(sun.target.position).normalize();
    var disc = new THREE.Mesh(new THREE.CircleGeometry(7, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 7.6, 5.2) }));
    disc.position.copy(sd.multiplyScalar(52)); disc.lookAt(0, 0, 0); es.add(disc);
    var glow = new THREE.Mesh(new THREE.CircleGeometry(16, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 1.25, 0.85), transparent: true, opacity: 0.35 }));
    glow.position.copy(sd.clone().normalize().multiplyScalar(51)); glow.lookAt(0, 0, 0); es.add(glow);
  } catch (e) {}
  var tex = pmrem.fromScene(es, 0.04).texture;
  try { pmrem.dispose(); } catch (e) {}
  return tex;
}

/* ======================= the plant builders ========================= */
function compoundLeaf(THREE, G, M, scale, dull){
  var grp = new THREE.Group();
  var pet = new THREE.Mesh(new THREE.CylinderGeometry(0.0018, 0.0024, 0.07, 5), M.shoot);
  pet.rotation.x = Math.PI / 2 - 0.25; pet.position.set(0, 0.007, 0.034); grp.add(pet);
  var lf = dull ? G.leafletD : G.leaflet, lfS = dull ? G.leafletDS : G.leafletS;
  var put = function(geo, x, y, z, ry, rx){
    var m = new THREE.Mesh(geo, M.leaf);
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0, 'YXZ'); grp.add(m);
  };
  put(lf, 0, 0.014, 0.068, 0, -0.15);
  put(lfS, -0.006, 0.012, 0.047, -0.65, -0.1);
  put(lfS, 0.006, 0.012, 0.047, 0.65, -0.1);
  put(lfS, -0.004, 0.009, 0.028, -0.8, -0.05);
  put(lfS, 0.004, 0.009, 0.028, 0.8, -0.05);
  grp.scale.setScalar(scale || 1);
  return grp;
}

function bloomGroup(THREE, G, M, dull, crushed){
  /* the FULL BLOOM (v2 form, v3 shades). crushed=true keeps only part
     of each whorl attached, less reflexed — the destroyed build. */
  var bloom = new THREE.Group();
  var PD = dull ? G.DD : G.PD, PB = dull ? G.DB : G.PB;
  var calyx = new THREE.Mesh(new THREE.SphereGeometry(0.020, 10, 8), M.calyx);
  calyx.scale.set(1, 0.85, 1); calyx.position.y = -0.009; bloom.add(calyx);
  var sepGeo = dull ? G.sepalD : G.sepal;
  var nSep = crushed ? 4 : 5, k;
  for (k = 0; k < nSep; k++){
    var sp2 = new THREE.Mesh(sepGeo, M.sepal);
    sp2.rotation.set(2.25, k / nSep * Math.PI * 2 + (crushed ? 0.5 : 0.3), 0, 'YXZ');
    sp2.position.y = -0.005; bloom.add(sp2);
  }
  function whorl(spec, nFull, nKeep, seedBase, yOff, angOff){
    var g = G.petalGeo(spec, PD, PB);
    var n = crushed ? nKeep : nFull;
    for (var k2 = 0; k2 < n; k2++){
      var m = new THREE.Mesh(G.jittered(g, seedBase + k2), M.petal);
      m.rotation.y = k2 / nFull * Math.PI * 2 + angOff + (crushed ? (k2 % 2) * 0.3 : 0);
      m.position.y = yOff; bloom.add(m);
    }
  }
  if (!crushed){
    whorl({ len: 0.150, wid: 0.066, open: 2.02, roll: 1.05, cup: -0.30, ruffle: 0.55, baseR: 0.013, tint: 0.88 }, 6, 6, 1, -0.004, 0);
    whorl({ len: 0.122, wid: 0.058, open: 1.52, roll: 0.55, cup: -0.08, ruffle: 0.45, baseR: 0.010, tint: 1.0 }, 7, 7, 11, 0.002, 0.45);
    whorl({ len: 0.098, wid: 0.048, open: 1.05, roll: 0.2, cup: 0.25, ruffle: 0.35, baseR: 0.007, tint: 0.95 }, 7, 7, 21, 0.008, 0.9);
    var innerSpecs = [
      { len: 0.076, wid: 0.038, open: 0.74, cup: 0.5, y: 0.015, n: 6, tint: 1.06 },
      { len: 0.060, wid: 0.031, open: 0.52, cup: 0.62, y: 0.021, n: 5, tint: 1.10 },
      { len: 0.046, wid: 0.024, open: 0.34, cup: 0.75, y: 0.026, n: 5, tint: 1.13 }];
    innerSpecs.forEach(function(sp3, wi){
      var g = G.petalGeo({ len: sp3.len, wid: sp3.wid, open: sp3.open, cup: sp3.cup, roll: 0, ruffle: 0.2, baseR: 0.002, tint: sp3.tint }, PD, PB);
      for (var k3 = 0; k3 < sp3.n; k3++){
        var m = new THREE.Mesh(G.jittered(g, 31 + wi * 7 + k3), M.petal);
        m.rotation.y = k3 * 2.39996 + wi * 0.8;
        m.position.y = sp3.y; bloom.add(m);
      }
    });
    var micro = G.petalGeo({ len: 0.027, wid: 0.015, open: 0.20, cup: 0.85, roll: 0, ruffle: 0.15, baseR: 0.001, tint: 1.13 }, PD, PB);
    for (k = 0; k < 4; k++){
      var mm = new THREE.Mesh(G.jittered(micro, 61 + k), M.petal);
      mm.rotation.y = k * 2.39996 + 0.4; mm.position.y = 0.030; bloom.add(mm);
    }
  } else {
    whorl({ len: 0.150, wid: 0.066, open: 1.85, roll: 0.8, cup: -0.30, ruffle: 0.55, baseR: 0.013, tint: 0.88 }, 6, 4, 1, -0.004, 0);
    whorl({ len: 0.122, wid: 0.058, open: 1.65, roll: 0.6, cup: -0.08, ruffle: 0.45, baseR: 0.010, tint: 1.0 }, 7, 5, 11, 0.002, 0.45);
    whorl({ len: 0.098, wid: 0.048, open: 1.2, roll: 0.25, cup: 0.25, ruffle: 0.35, baseR: 0.007, tint: 0.95 }, 7, 4, 21, 0.008, 0.9);
    var gI = G.petalGeo({ len: 0.070, wid: 0.035, open: 0.8, cup: 0.55, roll: 0, ruffle: 0.2, baseR: 0.002, tint: 1.06 }, PD, PB);
    for (k = 0; k < 4; k++){
      var mi = new THREE.Mesh(G.jittered(gI, 31 + k), M.petal);
      mi.rotation.y = k * 2.39996 + 0.3; mi.position.y = 0.016; bloom.add(mi);
    }
  }
  var dome = new THREE.Mesh(new THREE.SphereGeometry(0.0085, 10, 8), M.heart);
  dome.scale.set(1, crushed ? 0.4 : 0.55, 1); dome.position.y = crushed ? 0.028 : 0.030; bloom.add(dome);
  var stam = new THREE.SphereGeometry(0.0023, 6, 5);
  var nSt = crushed ? 5 : 10;
  for (k = 0; k < nSt; k++){
    var sm = new THREE.Mesh(stam, M.heart);
    var a = k / nSt * Math.PI * 2 + (crushed ? 0.4 : 0), rr = 0.0062;
    sm.position.set(Math.cos(a) * rr, crushed ? 0.033 : 0.036, Math.sin(a) * rr); bloom.add(sm);
  }
  return bloom;
}

function groundDiscs(THREE, plant, scuffed){
  var soil = new THREE.Mesh(new THREE.CircleGeometry(0.17, 20),
    new THREE.MeshStandardMaterial({ color: 0x3a2c1c, roughness: 1 }));
  soil.rotation.x = -Math.PI / 2; soil.position.y = 0.006; plant.add(soil);
  if (scuffed){
    var scuff = new THREE.Mesh(new THREE.CircleGeometry(0.15, 18),
      new THREE.MeshStandardMaterial({ color: 0x2e2115, roughness: 1 }));
    scuff.rotation.x = -Math.PI / 2; scuff.position.set(-0.845, 0.007, -0.305); plant.add(scuff);
  }
  var cv = document.createElement('canvas'); cv.width = cv.height = 128;
  var cx2 = cv.getContext('2d');
  var gr = cx2.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, 'rgba(0,0,0,0.42)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  cx2.fillStyle = gr; cx2.fillRect(0, 0, 128, 128);
  var blob = new THREE.Mesh(new THREE.CircleGeometry(0.34, 20),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.012; plant.add(blob);
}

/* INTACT rose, rooted at origin. shine=true gives the living planted
   rose (v3 emissives + the warm point light at the bowl); shine=false
   gives the picked/dropped plant — same form, dull palette, no light. */
function buildIntact(THREE, G, matsShine, matsDull, shine){
  var M = shine ? matsShine : matsDull;
  var plant = new THREE.Group();
  var stemCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.03, 0), new THREE.Vector3(0.020, 0.36, 0.010),
    new THREE.Vector3(-0.014, 0.72, 0.020), new THREE.Vector3(0.008, 1.04, 0.004)]);
  plant.add(new THREE.Mesh(new THREE.TubeGeometry(stemCurve, 24, 0.015, 7), M.stem));
  function shoot(from, dir, len, lift){
    var p0 = stemCurve.getPoint(from);
    var p1 = p0.clone().add(new THREE.Vector3(dir.x * len * 0.5, lift * 0.55, dir.z * len * 0.5));
    var p2 = p0.clone().add(new THREE.Vector3(dir.x * len, lift, dir.z * len));
    var c = new THREE.CatmullRomCurve3([p0, p1, p2]);
    plant.add(new THREE.Mesh(new THREE.TubeGeometry(c, 10, 0.0055, 6), M.shoot));
    return p2;
  }
  var s1 = shoot(0.42, new THREE.Vector3(0.9, 0, 0.35), 0.20, 0.10);
  var s2 = shoot(0.63, new THREE.Vector3(-0.8, 0, -0.5), 0.15, 0.07);
  var tg = new THREE.ConeGeometry(0.0042, 0.016, 6); tg.translate(0, 0.008, 0);
  for (var i = 0; i < 9; i++){
    var t = 0.14 + i * 0.095, p = stemCurve.getPoint(t);
    var th = new THREE.Mesh(tg, M.thorn);
    var az = i * 2.4, dir = new THREE.Vector3(Math.cos(az), -0.55, Math.sin(az)).normalize();
    th.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    th.position.copy(p); plant.add(th);
  }
  function addLeaf(at, az2, tilt, s){
    var lf = compoundLeaf(THREE, G, M, s, !shine);
    lf.position.copy(at); lf.rotation.set(tilt, az2, 0, 'YXZ');
    plant.add(lf);
  }
  addLeaf(stemCurve.getPoint(0.22), 3.3, 0.95, 1.35);
  addLeaf(stemCurve.getPoint(0.30), 0.7, 0.85, 1.4);
  addLeaf(stemCurve.getPoint(0.42), 5.6, 0.9, 1.35);
  addLeaf(stemCurve.getPoint(0.55), 2.6, 0.95, 1.5);
  addLeaf(stemCurve.getPoint(0.74), 4.4, 0.8, 1.35);
  addLeaf(stemCurve.getPoint(0.90), 1.9, 0.7, 1.15);
  addLeaf(s1, 0.9, 0.9, 1.3);
  addLeaf(s1, 2.2, 0.75, 1.1);
  addLeaf(s2, 3.6, 0.9, 1.15);
  var bloom = bloomGroup(THREE, G, M, !shine, false);
  var topP = stemCurve.getPoint(1.0);
  bloom.position.copy(topP).add(new THREE.Vector3(0, 0.05, 0));
  bloom.scale.setScalar(1.18);
  plant.add(bloom);
  if (shine){
    /* the shine made real (Joshua's v3 ruling): a very small warm
       light at the bowl — living, planted rose ONLY. */
    var gl = new THREE.PointLight(0xffbe5a, 0.45, 1.6, 2);
    gl.position.set(0, 0.05, 0); bloom.add(gl);
    plant.userData.shineLight = gl;
  }
  groundDiscs(THREE, plant, false);
  plant.userData.shine = !!shine;
  return plant;
}

/* DESTROYED rose (trampled): the preview's wreck, ported — snapped
   stem lying flat, crushed bloom at its end, scattered petals and
   leaflets, scuffed dirt. Dull materials, no light, no emissive. */
function buildDestroyed(THREE, G, matsDull, seed){
  var M = matsDull;
  var rng = mulberry32(seed || 20261108);
  var plant = new THREE.Group();
  plant.rotation.y = -1.565;
  var stemCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.03, 0),
    new THREE.Vector3(0.008, 0.10, 0.004),
    new THREE.Vector3(0.020, 0.185, 0.010),
    new THREE.Vector3(-0.10, 0.155, -0.045),
    new THREE.Vector3(-0.34, 0.045, -0.125),
    new THREE.Vector3(-0.60, 0.016, -0.215),
    new THREE.Vector3(-0.82, 0.014, -0.295)]);
  plant.add(new THREE.Mesh(new THREE.TubeGeometry(stemCurve, 36, 0.0155, 7), M.stem));
  {
    var p0 = stemCurve.getPoint(0.30);
    var c = new THREE.CatmullRomCurve3([
      p0,
      p0.clone().add(new THREE.Vector3(-0.05, 0.015, -0.05)),
      p0.clone().add(new THREE.Vector3(-0.11, -0.045, -0.10))]);
    plant.add(new THREE.Mesh(new THREE.TubeGeometry(c, 8, 0.005, 6), M.shoot));
  }
  var tg = new THREE.ConeGeometry(0.0042, 0.016, 6); tg.translate(0, 0.008, 0);
  for (var i = 0; i < 4; i++){
    var t = 0.08 + i * 0.09, p = stemCurve.getPoint(t);
    var th = new THREE.Mesh(tg, M.thorn);
    var az = i * 2.4 + 0.7, dir = new THREE.Vector3(Math.cos(az), -0.4, Math.sin(az)).normalize();
    th.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    th.position.copy(p); plant.add(th);
  }
  function flatLeaf(at, az2, s){
    var lf = compoundLeaf(THREE, G, M, s, true);
    lf.position.copy(at); lf.position.y = Math.max(0.012, at.y + 0.002);
    lf.rotation.set(0.95, az2, 0.35, 'YXZ');
    plant.add(lf);
  }
  flatLeaf(stemCurve.getPoint(0.13), 2.8, 1.3);
  flatLeaf(stemCurve.getPoint(0.55), 5.9, 1.4);
  flatLeaf(stemCurve.getPoint(0.78), 3.9, 1.25);
  var bloomFlat = new THREE.Group();
  bloomFlat.position.set(-0.845, 0.045, -0.305);
  bloomFlat.scale.set(1.12, 0.42, 1.12);
  plant.add(bloomFlat);
  var bloom = bloomGroup(THREE, G, M, true, true);
  bloom.rotation.set(0.30, 0.7, 1.45, 'YXZ');
  bloomFlat.add(bloom);
  {
    var geos = [
      G.petalGeo({ len: 0.150, wid: 0.066, open: 2.02, roll: 1.05, cup: -0.30, ruffle: 0.55, baseR: 0.013, tint: 0.88 }, G.DD, G.DB),
      G.petalGeo({ len: 0.122, wid: 0.058, open: 1.52, roll: 0.55, cup: -0.08, ruffle: 0.45, baseR: 0.010, tint: 1.0 }, G.DD, G.DB),
      G.petalGeo({ len: 0.098, wid: 0.048, open: 1.05, roll: 0.2, cup: 0.25, ruffle: 0.35, baseR: 0.007, tint: 0.95 }, G.DD, G.DB),
      G.petalGeo({ len: 0.070, wid: 0.035, open: 0.74, cup: 0.5, roll: 0, ruffle: 0.2, baseR: 0.002, tint: 1.06 }, G.DD, G.DB)];
    var fallAng = Math.atan2(-0.33, -0.94);
    for (var i2 = 0; i2 < 16; i2++){
      var g = G.jittered(geos[i2 % 4], 101 + i2);
      var m = new THREE.Mesh(g, M.petal);
      var biased = i2 < 11;
      var ang = biased ? fallAng + (rng() - 0.5) * 2.6 : rng() * Math.PI * 2;
      var r = 0.20 + rng() * 0.85;
      var holder = new THREE.Group();
      holder.position.set(Math.cos(ang) * r, 0.012 + rng() * 0.005, Math.sin(ang) * r);
      holder.rotation.y = rng() * Math.PI * 2;
      m.rotation.x = (rng() < 0.5 ? -1 : 1) * (Math.PI / 2) + (rng() - 0.5) * 0.4;
      holder.add(m); plant.add(holder);
    }
    for (var i3 = 0; i3 < 5; i3++){
      var ml = new THREE.Mesh(i3 % 2 ? G.leafletD : G.leafletDS, M.leaf);
      var ang2 = fallAng + (rng() - 0.5) * 3.2, r2 = 0.25 + rng() * 0.8;
      var holder2 = new THREE.Group();
      holder2.position.set(Math.cos(ang2) * r2, 0.011 + rng() * 0.004, Math.sin(ang2) * r2);
      holder2.rotation.y = rng() * Math.PI * 2;
      ml.rotation.x = (rng() - 0.5) * 0.25;
      holder2.add(ml); plant.add(holder2);
    }
    var sep = new THREE.Mesh(G.sepalD, M.sepal);
    var sh = new THREE.Group();
    sh.position.set(-0.45, 0.012, -0.5); sh.rotation.y = 1.1;
    sep.rotation.x = 0.15; sh.add(sep); plant.add(sh);
  }
  groundDiscs(THREE, plant, true);
  plant.userData.shine = false;
  return plant;
}

/* PICKED site (ui 2026.11.08.10 — Joshua's ruling from his hands on
   .9: "the pickup rose animation is correct" but the ground it left
   showed the DAMAGED rose): a rose that was PICKED leaves the bare
   dirt spot it grew from — the planting disc — plus a few loose
   petals. NO crushed stem, NO crushed bloom: the wreck belongs to
   TRAMPLING only. Dirt from groundDiscs (un-scuffed); petals reuse
   the destroyed build's loose-petal geometries, dull and unlit. */
function buildPickedMark(THREE, G, matsDull, seed){
  var M = matsDull;
  var rng = mulberry32((seed || 20261108) + 777);
  var plant = new THREE.Group();
  plant.rotation.y = -1.565;
  groundDiscs(THREE, plant, false);
  var geos = [
    G.petalGeo({ len: 0.150, wid: 0.066, open: 2.02, roll: 1.05, cup: -0.30, ruffle: 0.55, baseR: 0.013, tint: 0.88 }, G.DD, G.DB),
    G.petalGeo({ len: 0.122, wid: 0.058, open: 1.52, roll: 0.55, cup: -0.08, ruffle: 0.45, baseR: 0.010, tint: 1.0 }, G.DD, G.DB),
    G.petalGeo({ len: 0.098, wid: 0.048, open: 1.05, roll: 0.2, cup: 0.25, ruffle: 0.35, baseR: 0.007, tint: 0.95 }, G.DD, G.DB),
    G.petalGeo({ len: 0.070, wid: 0.035, open: 0.74, cup: 0.5, roll: 0, ruffle: 0.2, baseR: 0.002, tint: 1.06 }, G.DD, G.DB)];
  for (var i = 0; i < 7; i++){
    var g = G.jittered(geos[i % 4], 401 + i);
    var m = new THREE.Mesh(g, M.petal);
    var ang = rng() * Math.PI * 2;
    var r = 0.10 + rng() * 0.55;
    var holder = new THREE.Group();
    holder.position.set(Math.cos(ang) * r, 0.012 + rng() * 0.005, Math.sin(ang) * r);
    holder.rotation.y = rng() * Math.PI * 2;
    m.rotation.x = (rng() < 0.5 ? -1 : 1) * (Math.PI / 2) + (rng() - 0.5) * 0.4;
    holder.add(m); plant.add(holder);
  }
  plant.userData.shine = false;
  plant.userData.pickedMark = true;
  /* Part 8b: the two ground discs (soil + shadow blob — the only
     CircleGeometry meshes in the group) are the DIRT that heals.
     Collect them with PRIVATE material clones set transparent, so
     the fade can drive their opacity without ever touching the
     intact plant's or the wreck's discs. The petals are not in this
     list: they never fade. */
  var dirt = [];
  plant.traverse(function(o){
    if (o.isMesh && o.geometry && o.geometry.type === 'CircleGeometry'){
      o.material = o.material.clone();
      o.material.transparent = true;
      dirt.push(o);
    }
  });
  plant.userData.dirt = dirt;
  plant.userData.dirtF = 1;
  return plant;
}

/* ============================ popups ================================ */
/* First-pickup + completion share the big card; later pickups get the
   small count toast. Styled to the game's HUD family (dark card, gold
   heading). The big card does NOT block the world: it floats centred,
   and a pointerdown that lands on the game canvas (the world behind
   it) closes it — Joshua's two close paths: world-touch OR the X. */
var ui = null;
function buildUI(){
  if (ui) return ui;
  var css = document.createElement('style');
  css.textContent =
    '#rose-pop{position:fixed;inset:0;z-index:64;display:none;align-items:center;justify-content:center;pointer-events:none;}' +
    '#rose-pop.show{display:flex;}' +
    '#rose-pop .card{pointer-events:auto;position:relative;background:#161b26;border:2px solid #c9a227;border-radius:14px;' +
    'padding:22px 26px;max-width:430px;width:86%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.55);}' +
    '#rose-pop .sym{font-size:44px;line-height:1;}' +
    '#rose-pop h3{margin:8px 0 10px 0;color:#ffd75e;font-size:22px;}' +
    '#rose-pop p{margin:0;color:#e8e4d8;font-size:16px;line-height:1.45;}' +
    '#rose-pop-x{position:absolute;top:6px;right:10px;background:none;border:none;color:#ffd75e;' +
    'font-size:24px;font-weight:bold;cursor:pointer;padding:4px 8px;}' +
    '#rose-toast{position:fixed;left:50%;bottom:12%;transform:translateX(-50%);z-index:64;display:none;' +
    'align-items:center;gap:10px;background:#161b26;border:2px solid #c9a227;border-radius:999px;' +
    'padding:10px 20px 10px 14px;box-shadow:0 6px 24px rgba(0,0,0,.5);cursor:pointer;}' +
    '#rose-toast.show{display:flex;}' +
    '#rose-toast .sym{font-size:26px;line-height:1;}' +
    '#rose-toast .n{color:#ffd75e;font-size:19px;font-weight:bold;}';
  document.head.appendChild(css);
  var pop = document.createElement('div');
  pop.id = 'rose-pop';
  pop.innerHTML = '<div class="card"><button id="rose-pop-x" aria-label="Close">✕</button>' +
    '<div class="sym">🌹</div><h3 id="rose-pop-title"></h3><p id="rose-pop-text"></p></div>';
  document.body.appendChild(pop);
  var toast = document.createElement('div');
  toast.id = 'rose-toast';
  toast.innerHTML = '<span class="sym">🌹</span><span class="n" id="rose-toast-n"></span>';
  document.body.appendChild(toast);
  var toastTimer = 0;
  function hidePop(){ pop.classList.remove('show'); }
  document.getElementById('rose-pop-x').addEventListener('click', function(ev){ ev.stopPropagation(); hidePop(); });
  /* world-touch close: a pointerdown whose target is the game canvas
     (the world itself) dismisses the card. Taps on HUD controls are
     not the world and leave it up; the X always works. */
  document.addEventListener('pointerdown', function(ev){
    if (!pop.classList.contains('show')) return;
    if (ev.target && ev.target.tagName === 'CANVAS') hidePop();
  }, true);
  toast.addEventListener('click', function(){ toast.classList.remove('show'); });
  ui = {
    showBig: function(title, text){
      document.getElementById('rose-pop-title').textContent = title;
      document.getElementById('rose-pop-text').textContent = text;
      pop.classList.add('show');
    },
    hideBig: hidePop,
    bigShown: function(){ return pop.classList.contains('show'); },
    showCount: function(n){
      document.getElementById('rose-toast-n').textContent = n + ' of ' + TOTAL;
      toast.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function(){ toast.classList.remove('show'); }, 4000);
    },
    countShown: function(){ return toast.classList.contains('show'); },
    countText: function(){ return document.getElementById('rose-toast-n').textContent; }
  };
  return ui;
}

/* ============================ state ================================= */
var W = null;      /* world surface, captured at boot */
var state = null;  /* persisted quest state */
var runtime = {};  /* siteId -> { pickup, wreck } live objects */

function loadState(){
  var d = { firstShown: false, doneShown: false, sites: {}, loose: [] };
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw){
      var o = JSON.parse(raw);
      if (o && typeof o === 'object'){
        d.firstShown = !!o.firstShown; d.doneShown = !!o.doneShown;
        d.sites = o.sites || {}; d.loose = Array.isArray(o.loose) ? o.loose : [];
      }
    }
  } catch (e) {}
  SITES.forEach(function(s){
    if (!d.sites[s.id]) d.sites[s.id] = { s: 'planted', at: 0 };
  });
  return d;
}
function saveState(){
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
}
function absGameMin(){
  try {
    var dc = window.__daycycle;
    if (dc && typeof dc.gameMin === 'number' && typeof dc.dayNum === 'number')
      return dc.dayNum * 1440 + dc.gameMin;
  } catch (e) {}
  return null;
}
function roseCount(){
  try {
    var inv = W.inventory;
    for (var i = 0; i < inv.length; i++)
      if (inv[i].kind === KIND) return inv[i].n || 1;
  } catch (e) {}
  return 0;
}

/* ========================== world ops =============================== */
function plantSite(site){
  var mesh = buildIntact(W.THREE, W.G, W.matsShine, W.matsDull, true);
  var p = W.spawnPickup(RNAME, KIND, site.x, site.z, mesh);
  p.roseSite = site.id;
  runtime[site.id] = { pickup: p, wreck: null, mark: null };
  state.sites[site.id].s = 'planted';
}
function wreckSite(site){
  var g = buildDestroyed(W.THREE, W.G, W.matsDull, 20261108 + site.id * 131);
  g.position.set(site.x, W.heightAt(site.x, site.z), site.z);
  W.scene.add(g);
  runtime[site.id] = { pickup: null, wreck: g, mark: null };
}
/* The picked site's resting face (ui 2026.11.08.10): bare dirt disc +
   a few loose petals where the plant stood. */
function markSite(site){
  var g = buildPickedMark(W.THREE, W.G, W.matsDull, 20261108 + site.id * 131);
  g.position.set(site.x, W.heightAt(site.x, site.z), site.z);
  W.scene.add(g);
  runtime[site.id] = { pickup: null, wreck: null, mark: g };
  applyMarkFade(site);
}
/* Part 8b: set the picked mark's dirt opacity from the site's
   persisted pick timestamp (state.sites[id].at, real ms). f=1 is
   fresh dirt, f=0 is fully healed — the discs then hide outright.
   A site with no timestamp (picked before this build) reads as
   already healed: petals only. Petals are never touched here. */
function applyMarkFade(site){
  var rt = runtime[site.id];
  if (!rt || !rt.mark) return;
  var st = state.sites[site.id];
  var at = (st && typeof st.at === 'number' && st.at > 0) ? st.at : 0;
  var f = at ? Math.max(0, 1 - (Date.now() - at) / PICK_FADE_MS) : 0;
  var dirt = rt.mark.userData.dirt || [];
  for (var i = 0; i < dirt.length; i++){
    dirt[i].material.opacity = f;
    dirt[i].visible = f > 0;
  }
  rt.mark.userData.dirtF = f;
}
function clearSiteObjects(site){
  var rt = runtime[site.id];
  if (!rt) return;
  if (rt.pickup){
    var ix = W.pickups.indexOf(rt.pickup);
    if (ix >= 0) W.pickups.splice(ix, 1);
    if (rt.pickup.mesh) W.scene.remove(rt.pickup.mesh);
  }
  if (rt.wreck) W.scene.remove(rt.wreck);
  if (rt.mark) W.scene.remove(rt.mark);
  runtime[site.id] = { pickup: null, wreck: null, mark: null };
}
function crushSite(site){
  clearSiteObjects(site);
  wreckSite(site);
  var now = absGameMin();
  state.sites[site.id].s = 'crushed';
  /* regrow deadline in absolute game minutes; if the clock is somehow
     unavailable, fall back to 310 real seconds per game hour */
  state.sites[site.id].at = (now !== null) ? now + REGROW_GAME_MIN : -Date.now() - 310000;
  saveState();
}
function regrowSite(site){
  clearSiteObjects(site);
  plantSite(site);
  saveState();
}

/* ============================ hooks ================================= */
/* called by index.html's doPickup() AFTER the rose is in the
   inventory (so roseCount() already includes it). */
function onPicked(p){
  try { if (W.player) W.player.bendT = 1.15; } catch (e) {}   /* the bend-down */
  if (p && p.roseSite){
    var st = state.sites[p.roseSite];
    if (st && (st.s === 'planted' || st.s === 'crushed')){
      /* PICKED (ui 2026.11.08.10): the site becomes 'gone' and shows
         the bare dirt + loose petals (markSite) — never the wreck.
         The 'crushed' arm covers the raced tap: the player stepped
         onto the plant and tapped Pick up in the same moment, the
         trample landed first, and on .9 the wreck then stayed up as
         if the rose had been destroyed. He picked it — dirt it is. */
      st.s = 'gone';
      st.at = Date.now();   /* Part 8b: the dirt fade runs off this */
      var _site = null;
      for (var _si = 0; _si < SITES.length; _si++) if (SITES[_si].id === p.roseSite) _site = SITES[_si];
      if (_site){ clearSiteObjects(_site); markSite(_site); }
    }
    if (runtime[p.roseSite]) runtime[p.roseSite].pickup = null;
  } else if (p){
    /* a loose (dropped) rose picked back up: forget its resting spot
       so it does not respawn there on the next boot */
    for (var li = 0; li < state.loose.length; li++){
      var L = state.loose[li];
      var ldx = L.x - p.x, ldz = L.z - p.z;
      if (ldx * ldx + ldz * ldz < 1){ state.loose.splice(li, 1); break; }
    }
  }
  var n = roseCount();
  var u = buildUI();
  if (!state.firstShown){
    state.firstShown = true;
    u.showBig('A Golden Rose!',
      'You have collected one of ten golden roses. Find all ten to complete this level.');
  } else if (n >= TOTAL && !state.doneShown){
    state.doneShown = true;
    u.showBig('All Ten Roses!',
      'You found all ten golden roses. This level is complete — well done!');
  } else {
    u.showCount(n);
  }
  saveState();
  reportSys();
}
/* called by index.html's dropItem() when a Golden Rose leaves the
   inventory: the dropped rose is re-planted where it fell — intact,
   but with the shine GONE (a picked rose does not shine). It is a
   loose rose, not a site rose: walking over it does not trample it
   (same as any other dropped item), and picking it back up simply
   returns it to the stack. Returns true = handled. */
function onDropSpawn(x, z){
  if (!W) return false;
  var mesh = buildIntact(W.THREE, W.G, W.matsShine, W.matsDull, false);
  var p = W.spawnPickup(RNAME, KIND, x, z, mesh);
  p.roseSite = 0;
  state.loose.push({ x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 });
  saveState();
  return true;
}

function reportSys(){
  try {
    if (W.Report && W.Report.setSys){
      var planted = 0, crushed = 0, gone = 0;
      SITES.forEach(function(s){
        var st = state.sites[s.id].s;
        if (st === 'planted') planted++; else if (st === 'crushed') crushed++; else gone++;
      });
      W.Report.setSys('roses', { version: VERSION, count: roseCount(),
        planted: planted, crushed: crushed, gone: gone,
        sitesNamed: SITES.length, total: TOTAL });
    }
  } catch (e) {}
}

/* ============================= tick ================================= */
var tickAcc = 0;
function roseTick(dt){
  if (!state || !W) return;
  tickAcc += (typeof dt === 'number' && dt > 0 && dt < 1) ? dt : 0.016;
  if (tickAcc < 0.15) return;
  tickAcc = 0;
  var pl = W.player;
  /* regrow first (cheap, runs regardless of player state) */
  var now = absGameMin();
  var i, site, st;
  for (i = 0; i < SITES.length; i++){
    site = SITES[i]; st = state.sites[site.id];
    if (st.s !== 'crushed') continue;
    var due = false;
    if (st.at >= 0 && now !== null) due = now >= st.at;
    else if (st.at < 0) due = Date.now() >= -st.at;
    if (due) regrowSite(site);
  }
  /* Part 8b: picked sites' dirt heals a little more each tick —
     a pure function of the persisted pick timestamp, so the stage
     is right whenever the player comes back, near or far. */
  for (i = 0; i < SITES.length; i++) {
    site = SITES[i]; st = state.sites[site.id];
    if (st.s === 'gone') applyMarkFade(site);
  }
  /* trample: the player, on foot and outdoors, standing where a
     planted rose stands — walking over the top of it. Beside it
     (the pickup distance) never triggers: the radius is the plant's
     own footprint. */
  if (!pl || pl.inside || pl.swimming) return;
  try { if (typeof W.car !== 'undefined' && W.car && W.car.driving) return; } catch (e) {}
  for (i = 0; i < SITES.length; i++){
    site = SITES[i]; st = state.sites[site.id];
    if (st.s !== 'planted') continue;
    var rt = runtime[site.id];
    if (!rt || !rt.pickup) continue;
    var dx = pl.x - site.x, dz = pl.z - site.z;
    if (dx * dx + dz * dz < TRAMPLE_R * TRAMPLE_R) crushSite(site);
  }
}

/* ============================= boot ================================= */
var booted = false;
function boot(){
  if (booted) return;
  var THREE = window.THREE;
  var ok = !!(THREE && window.__gameStarted &&
    typeof window.scene !== 'undefined' && window.scene &&
    typeof window.player !== 'undefined' && window.player &&
    typeof window.heightAt === 'function' &&
    typeof window.spawnPickup === 'function' &&
    typeof window.pickups !== 'undefined' && window.pickups &&
    typeof window.inventory !== 'undefined' && window.inventory &&
    typeof window.Sim !== 'undefined' && window.Sim && typeof window.Sim.onTick === 'function' &&
    window.sun && window.renderer);
  if (!ok) return;
  booted = true;
  var G = buildGeos(THREE);
  var envTex = buildEnv(THREE, window.renderer, window.scene, window.sun);
  W = {
    THREE: THREE, G: G,
    matsShine: buildMats(THREE, envTex, false),
    matsDull: buildMats(THREE, envTex, true),
    scene: window.scene, player: window.player,
    heightAt: window.heightAt, spawnPickup: window.spawnPickup,
    pickups: window.pickups, inventory: window.inventory,
    Report: window.Report || null,
    get car(){ try { return window.car; } catch (e) { return null; } }
  };
  state = loadState();
  /* the tick + UI go live FIRST, so a failure while placing any one
     rose can never take the whole quest down with it */
  buildUI();
  window.Sim.onTick('render', 68, roseTick);
  /* restore the world from the persisted state */
  var now = absGameMin();
  SITES.forEach(function(site){
    try {
      var st = state.sites[site.id];
      if (st.s === 'planted') plantSite(site);
      else if (st.s === 'crushed'){
        var due = (st.at >= 0 && now !== null) ? now >= st.at : (st.at < 0 && Date.now() >= -st.at);
        if (due){ plantSite(site); }
        else wreckSite(site);
      }
      else if (st.s === 'gone'){ markSite(site); }
      /* 'gone' — collected; the bare dirt + petals mark stands there
         (ui 2026.11.08.10 — a picked site never shows the wreck) */
    } catch (e) {
      try { if (window.Report && Report.note) Report.note('roses', { code: 'plant-failed', site: site.id, err: String(e && e.message || e).slice(0, 160) }); } catch (x) {}
    }
  });
  state.loose.forEach(function(l){
    try {
      var mesh = buildIntact(THREE, G, W.matsShine, W.matsDull, false);
      var p = W.spawnPickup(RNAME, KIND, l.x, l.z, mesh);
      p.roseSite = 0;
    } catch (e) {}
  });
  reportSys();
}

window.__ROSES = {
  version: VERSION,
  onPicked: onPicked,
  onDropSpawn: onDropSpawn,
  count: function(){ return W ? roseCount() : 0; },
  sites: function(){
    return SITES.map(function(s){
      var rt = runtime[s.id] || {};
      return { id: s.id, label: s.label, x: s.x, z: s.z,
        state: state ? state.sites[s.id].s : 'unbooted',
        regrowAt: state ? state.sites[s.id].at : 0,
        hasPickup: !!(rt && rt.pickup), hasWreck: !!(rt && rt.wreck),
        hasMark: !!(rt && rt.mark),
        dirtF: (rt && rt.mark && typeof rt.mark.userData.dirtF === 'number') ? Math.round(rt.mark.userData.dirtF * 100) / 100 : null,
        shine: !!(rt && rt.pickup && rt.pickup.mesh && rt.pickup.mesh.userData.shine) };
    });
  },
  ui: function(){ var u = buildUI(); return { big: u.bigShown(), count: u.countShown(), countText: u.countText() }; },
  booted: function(){ return booted; }
};

var tries = 0;
var iv = setInterval(function(){
  tries++;
  boot();
  if (booted || tries > 1200) clearInterval(iv);
}, 250);
boot();

})();
