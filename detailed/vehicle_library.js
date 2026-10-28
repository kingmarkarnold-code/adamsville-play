/* ============================================================================
   VEHICLE LIBRARY (2026-10-28) — Joshua's baked body library.

   Joshua's architecture ruling (2026-10-28): cars are mostly the same
   shapes wearing different paint, so body types are BAKED ONCE and
   stored as game data — never generated per-car at load. Variety
   comes from PALETTE RANDOMIZATION at spawn.

   THE BAKE: vehicle_library.glb (this tree) holds 8 body types baked
   from the Kenney Car Kit (kenney.nl — Creative Commons CC0; GLB
   conversions mirrored in the kvark/raycraft GitHub repo). Per type,
   three geometry buckets, pre-transformed into game space (front +Z,
   ground y=0, sized to the VEHICLE_TYPES footprints in index.html):
     paint_<type>  the paint panels (no vertex colours — tinted)
     glass_<type>  the window band
     trim_<type>   everything else, vertex-coloured from the source
                   materials (plastic, lights, grille, spare tyre…)
   plus a shared detailed `wheel` geometry, a 40-tri `wheel_low` for
   traffic, and wheels_<type> placement nodes (position + radius).

   TYPES: sedan, hatchback, suv, sports, taxi, pickup, van, boxtruck.
   Tri counts (paint+glass+trim): 650–1,040 per body — inside the
   ~1,000 regular-car budget (suv 1,036 is the marginal one).

   CONSUMERS:
   - Specials (parked/drivable): vehicle_meshes.js builders call
     makeBody(type, paintHex) and get a full mesh group honouring the
     driven-car contract (userData.wheels spin groups +
     userData.steerGroups, read by updateCar in index.html).
   - Traffic: traffic_system.js calls trafficGeos(type) and renders
     one InstancedMesh per type (paint bucket tinted per car via
     setColorAt — the PAINTS pattern, generalized) + one shared
     wheel InstancedMesh. Slot/full-draw logic is untouched.

   HEAVY FLEET: school bus, MARTA bus and semi keep their existing
   single-source builders in vehicle_meshes.js (schoolBusMesh /
   martaBusMesh / semiMesh) — already one baked body per type with
   livery-only variety, the same pattern in code form. No shaped
   bus/semi models under a verified license were obtainable in the
   vetting pass (the reodesuxz pack sits behind itch.io's purchase-
   form flow); when they are sourced, they join this library the
   same way. The donk Chevys (boxChevy/bubbleChevy) likewise keep
   their handcrafted builders — they are signature designs, not
   generic bodies.

   FALLBACK (deliberate, not leftover): on the classic r128 engine
   (the file:// APK today) there is no GLTFLoader, and if the GLB
   ever fails to load, `ready` stays false and every consumer keeps
   the procedural builders / legacy traffic pool. The game never
   loses its cars. Every failure is REPORTED through the game's
   report channel (libFail below) — silently keeping the legacy
   bodies is what let a broken library pass unnoticed in Joshua's
   2026-10-28 hands-on, when traffic stayed boxy and nobody knew.
   ============================================================================ */
(function vehicleLibrary(){
'use strict';
var LIB = window.VehicleLibrary = {
  ready: false, failed: false, types: {},   // type -> {paint, glass, trim, wheels:[[x,y,z]x4], wheelR}
  wheelGeo: null, wheelLowGeo: null, _cbs: [],
  onReady: function(fn){
    if (LIB.ready){ try{ fn(); }catch(e){} }
    else if (!LIB.failed) LIB._cbs.push(fn);
  },
  has: function(t){ return !!LIB.types[t]; }
};

var _paintMats = {};
function paintMaterial(hex){
  if (!_paintMats[hex]){
    _paintMats[hex] = (typeof vehPaintMat === 'function')
      ? vehPaintMat(hex) : new THREE.MeshLambertMaterial({ color: hex });
  }
  return _paintMats[hex];
}
var _glassMat = null;
function glassMaterial(){
  if (!_glassMat){
    _glassMat = (typeof glassMat === 'function') ? glassMat()
      : new THREE.MeshLambertMaterial({ color: 0x1c2733 });
  }
  return _glassMat;
}
var _trimMat = null;
function trimMaterial(){
  if (!_trimMat) _trimMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return _trimMat;
}
var _wheelMat = null;
function wheelMaterial(){
  if (!_wheelMat) _wheelMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return _wheelMat;
}

/* makeBody(type, paintHex) — a full special-vehicle body: paint bucket
   in the requested colour, glass + trim buckets shared-material, four
   detailed wheels on spin pivots (front pair inside steer groups) —
   the exact userData contract updateCar() drives. Null when the type
   or library is unavailable (callers fall back to procedural). */
LIB.makeBody = function(type, paintHex){
  var T = LIB.types[type];
  if (!T || !LIB.wheelGeo) return null;
  try {
    var g = new THREE.Group();
    g.add(new THREE.Mesh(T.paint, paintMaterial(paintHex)));
    g.add(new THREE.Mesh(T.glass, glassMaterial()));
    g.add(new THREE.Mesh(T.trim, trimMaterial()));
    var wheels = [], steers = [];
    var wscale = T.wheelR / 0.3;   // baked wheel geometry radius is 0.3
    for (var i = 0; i < T.wheels.length; i++){
      var wp = T.wheels[i];
      var spin = new THREE.Group();
      var wm = new THREE.Mesh(LIB.wheelGeo, wheelMaterial());
      wm.scale.setScalar(wscale);
      if (wp[0] < 0) wm.rotation.y = Math.PI;   // hub face outward on the left
      spin.add(wm);
      if (wp[2] > 0){   // front axle: steer group wraps the spin group
        var steer = new THREE.Group();
        steer.position.set(wp[0], wp[1], wp[2]);
        spin.position.set(0, 0, 0);
        steer.add(spin); g.add(steer); steers.push(steer);
      } else {
        spin.position.set(wp[0], wp[1], wp[2]);
        g.add(spin);
      }
      wheels.push(spin);
    }
    g.userData.wheels = wheels;
    g.userData.steerGroups = steers;
    return g;
  } catch(e){ return null; }
};

/* trafficGeos(type) — {paint, trim} geometries for the instanced
   traffic renderer. Traffic has no separate glass draw (draw-call
   discipline), so the glass bucket is merged into trim here with its
   vertex colours rewritten to the traffic glass slate. Cached. */
var _trafficCache = {};
LIB.trafficGeos = function(type){
  var T = LIB.types[type];
  if (!T) return null;
  if (_trafficCache[type]) return _trafficCache[type];
  try {
    var glass = T.glass.clone();
    var col = glass.getAttribute('color');
    if (col){
      for (var i = 0; i < col.count; i++) col.setXYZ(i, 0.13, 0.16, 0.20);
    }
    var trim = mergeGeos([T.trim, glass]);
    var out = { paint: T.paint, trim: trim };
    _trafficCache[type] = out;
    return out;
  } catch(e){ return null; }
};
/* concat two non-indexed position/normal/color geometries */
function mergeGeos(list){
  var pos = [], nor = [], col = [];
  list.forEach(function(geo){
    var p = geo.getAttribute('position'), n = geo.getAttribute('normal'),
        c = geo.getAttribute('color');
    for (var i = 0; i < p.count; i++){
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      if (n) nor.push(n.getX(i), n.getY(i), n.getZ(i));
      if (c) col.push(c.getX(i), c.getY(i), c.getZ(i));
      else col.push(1, 1, 1);
    }
  });
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (nor.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/* libFail(reason) — F2 REPORTING (2026-10-28, Joshua's hands-on).
   Every library failure path funnels here: mark failed (once), keep
   the console warning, and file a game report NAMING THE REASON via
   Report.note — which github_reports.js forwards to the session
   reports, the same channel every other system uses. This module can
   run before Report exists (it sits early in the deferred script
   queue), so filing retries briefly until the report system is up;
   GitHubReports.queue is the fallback if it is the one available.
   Fail-open is UNCHANGED and deliberate: legacy bodies stay, the
   game never loses its cars — it just no longer fails in silence. */
function libFail(reason){
  if (LIB.failed) return;   // one report per failure, not per caller
  LIB.failed = true;
  try{ console.warn('[vehicle-library] ' + reason + ' — legacy bodies stay'); }catch(e){}
  var tries = 0;
  (function fileReport(){
    try{
      if (typeof Report !== 'undefined' && Report.note){
        Report.note('vehicle-library', { event: 'load-failed', reason: reason });
        return;
      }
      if (typeof GitHubReports !== 'undefined' && GitHubReports.queue){
        GitHubReports.queue('vehicle-library', { event: 'load-failed', reason: reason });
        return;
      }
    }catch(e){}
    if (++tries <= 20) setTimeout(fileReport, 1500);
  })();
}

/* ---------------- load ---------------- */
function install(gltf){
  var root = gltf.scene;
  root.traverse(function(o){
    if (!o.name) return;
    var m;
    if ((m = o.name.match(/^(paint|glass|trim)_(.+)$/)) && o.geometry){
      var T = LIB.types[m[2]] || (LIB.types[m[2]] = { wheels: [], wheelR: 0.34 });
      T[m[1]] = o.geometry;
    } else if (o.name === 'wheel' && o.geometry){
      LIB.wheelGeo = o.geometry;
    } else if (o.name === 'wheel_low' && o.geometry){
      LIB.wheelLowGeo = o.geometry;
    } else if ((m = o.name.match(/^wheels_(.+)$/))){
      var T2 = LIB.types[m[1]] || (LIB.types[m[1]] = { wheels: [], wheelR: 0.34 });
      o.children.forEach(function(k){
        T2.wheels.push([k.position.x, k.position.y, k.position.z]);
        if (k.userData && k.userData.radius) T2.wheelR = k.userData.radius;
      });
      /* bake order is front-first; keep it (front = +Z, z>0) */
    }
  });
  /* a type only counts when all three buckets + wheels arrived */
  Object.keys(LIB.types).forEach(function(t){
    var T = LIB.types[t];
    if (!(T.paint && T.glass && T.trim && T.wheels.length === 4)) delete LIB.types[t];
  });
  if (!Object.keys(LIB.types).length || !LIB.wheelGeo || !LIB.wheelLowGeo){
    libFail('vehicle_library.glb parsed but incomplete — no complete body types or wheels in the file');
    return;
  }
  LIB.ready = true;
  try{ console.log('[vehicle-library] baked bodies ready: ' + Object.keys(LIB.types).join(',')); }catch(e){}
  var cbs = LIB._cbs.slice(); LIB._cbs.length = 0;
  cbs.forEach(function(fn){ try{ fn(); }catch(e){} });
  try{
    if (typeof Report !== 'undefined' && Report.setSys)
      Report.setSys('vehicles', { library: 'kenney-baked-v1', types: Object.keys(LIB.types) });
  }catch(e){}
}

if (typeof THREE !== 'undefined' && THREE.GLTFLoader){
  try {
    var url = 'vehicle_library.glb';
    try { if (window.__UIVER) url += '?v=' + encodeURIComponent(window.__UIVER); } catch(e){}
    new THREE.GLTFLoader().load(url, install, undefined, function(err){
      libFail('vehicle_library.glb failed to load: ' +
        (err && err.message ? err.message : 'network or parse error'));
    });
  } catch(e){
    libFail('GLTFLoader threw before the load could start: ' +
      (e && e.message ? e.message : String(e)));
  }
} else {
  // classic engine: no GLTFLoader (see header) — reported like any
  // other failure, so the APK's known limitation is on the record
  // once per session instead of invisible.
  libFail('THREE.GLTFLoader is unavailable on this engine — baked vehicle bodies cannot load');
}
})();
