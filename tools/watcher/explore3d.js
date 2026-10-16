/* ============================================================================
   Adamsville Watcher — 3D Explore view
   Three.js fly-through of the game map: terrain (with road-pass lift hills),
   roads, buildings, exit signs, traffic-light markers, POIs, water.
   Controls: WASD/arrows move · mouse-drag look · wheel dolly · R/F up/down
   Touch: 1-finger drag look · pinch dolly · 2-finger drag altitude.
   Tap any object to pin a feedback note (via Feedback module).
   Budget-phone safe: pixelRatio capped, Lambert materials, no shadows, fog.
   ========================================================================== */
var Explore3D = (function () {
'use strict';

var ready = false, loading = false, active = false;
var renderer, scene, camera, canvas;
var yaw = 0, pitch = -0.48;
var px = 4000, py = 1500, pz = 10300;
var keys = {};
var HF = null, buildings = null;
var clock = 0;

function loadScript(src) {
  return new Promise(function (res, rej) {
    var s = document.createElement('script');
    s.src = src; s.onload = res;
    s.onerror = function () { rej(new Error('failed to load ' + src)); };
    document.head.appendChild(s);
  });
}

function ensure() {
  if (ready || loading) return;
  loading = true;
  var hud = document.getElementById('hud3dmsg');
  if (hud) hud.textContent = 'loading 3D…';
  /* GameSync: live data straight from the published game (single source of
     truth), falling back to local copies when offline. */
  loadScript('three.min.js')
    .then(function () { return GameSync.load('vehicle_meshes.js', null); })
    .then(function () { return GameSync.load('elev.js', 'heightfield.js'); })
    .then(function () {
      if (typeof ELEV !== 'undefined') HF = GameSync.elevToHeightfield();
      else if (typeof HEIGHTFIELD !== 'undefined') HF = HEIGHTFIELD;
      else throw new Error('no elevation data');
    })
    .then(function () { return GameSync.load('osm_buildings.js', 'osm_buildings.js'); })
    .then(function () { return GameSync.load('exit_signs.js', 'exit_signs.js'); })
    .then(function () { return GameSync.load('roads.js', null); })
    .then(function () {
      if (typeof ROAD_DATA !== 'undefined' && typeof WORLD !== 'undefined') {
        var wr = GameSync.roadsToWorld();
        if (wr.length) WORLD.roads = wr;   // live game roads replace the snapshot
      }
      init(); ready = true; loading = false;
      if (hud) hud.textContent = '';
      if (active) requestAnimationFrame(frame); })
    .catch(function (e) {
      loading = false;
      if (hud) hud.textContent = '3D failed to load: ' + e.message + ' — try refreshing the page.';
    });
}

/* bilinear sample of the precomputed heightfield */
function sampleH(x, z) {
  var nx = HF.nx, nz = HF.nz;
  var fx = x / HF.w * (nx - 1), fz = z / HF.h * (nz - 1);
  fx = Math.max(0, Math.min(nx - 1.001, fx));
  fz = Math.max(0, Math.min(nz - 1.001, fz));
  var ix = Math.floor(fx), iz = Math.floor(fz), ax = fx - ix, az = fz - iz;
  var d = HF.data, i00 = iz * nx + ix;
  var h00 = d[i00], h10 = d[i00 + 1], h01 = d[i00 + nx], h11 = d[i00 + nx + 1];
  return h00 + (h10 - h00) * ax + (h01 - h00) * az + (h00 - h10 - h01 + h11) * ax * az;
}

function hash2(x, z) {
  var s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function init() {
  if (!HF) HF = HEIGHTFIELD;
  canvas = document.getElementById('c3d');
  // click to select a house/building
  var rayc=new THREE.Raycaster(), mouse=new THREE.Vector2();
  canvas.addEventListener('click',function(e){
    var r=canvas.getBoundingClientRect();
    mouse.x=((e.clientX-r.left)/r.width)*2-1;
    mouse.y=-((e.clientY-r.top)/r.height)*2+1;
    rayc.setFromCamera(mouse,camera);
    var hits=rayc.intersectObjects(scene.children,true);
    for(var i=0;i<hits.length;i++){
      var h=hits[i], o=h.object;
      // instanced buildings
      if(o.isInstancedMesh&&h.instanceId!==undefined){
        var hud=document.getElementById('hud3dmsg');
        if(hud) hud.textContent='Building #'+h.instanceId+' selected — see Buildings tab for details';
        break;
      }
      var p=o;
      while(p){ if(p.userData&&p.userData.bldgIdx!==undefined) break; p=p.parent; }
      if(p&&p.userData){
        var idx=p.userData.bldgIdx;
        var hud2=document.getElementById('hud3dmsg');
        if(hud2) hud2.textContent='Building #'+idx+' selected — see Buildings tab for details';
        break;
      }
    }
  });
  renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5e0);
  scene.fog = new THREE.Fog(0x87b5e0, 2500, 7000);
  camera = new THREE.PerspectiveCamera(60, 1, 1, 12000);

  scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x4a5d3a, 0.95));
  var sun = new THREE.DirectionalLight(0xfff2d8, 0.85);
  sun.position.set(0.4, 1, 0.25);
  scene.add(sun);

  buildTerrain();
  buildRoads();
  buildRoadLabels();
  buildBuildings();
  buildSigns();
  buildLights();
  buildWater();
  buildPois();
  buildVehicleShowroom();
  bindControls();
  onResize();
  window.addEventListener('resize', onResize);
}

function buildTerrain() {
  var nx = HF.nx, nz = HF.nz;
  var pos = new Float32Array(nx * nz * 3);
  var col = new Float32Array(nx * nz * 3);
  var c1 = [0.36, 0.56, 0.29], c2 = [0.45, 0.66, 0.33], c3 = [0.54, 0.65, 0.33];
  for (var j = 0; j < nz; j++) for (var i = 0; i < nx; i++) {
    var x = i / (nx - 1) * HF.w, z = j / (nz - 1) * HF.h;
    var h = HF.data[j * nx + i];
    var k = (i + j * nx) * 3;
    pos[k] = x; pos[k + 1] = h; pos[k + 2] = z;
    var t = hash2(i, j), c = t < 0.5 ? c1 : (t < 0.8 ? c2 : c3);
    var shade = 0.92 + 0.08 * Math.sin(x * 0.01 + z * 0.013);
    // subtle height tint: low areas slightly darker/lusher
    var ht = Math.max(0, Math.min(1, h / 60));
    col[k] = c[0] * shade * (0.9 + 0.1 * ht);
    col[k + 1] = c[1] * shade;
    col[k + 2] = c[2] * shade * (1.05 - 0.1 * ht);
  }
  var idx = [];
  for (var jj = 0; jj < nz - 1; jj++) for (var ii = 0; ii < nx - 1; ii++) {
    var a = jj * nx + ii, b = a + 1, c = a + nx, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));
}

function buildRoads() {
  var pos = [], col = [], idx = [];
  var widths = { 0: 17, 1: 11, 2: 6 };
  var colors = { 0: [0.13, 0.13, 0.15], 1: [0.17, 0.17, 0.19], 2: [0.21, 0.21, 0.23] };
  var v = 0;
  WORLD.roads.forEach(function (r) {
    var cat = r[0], pts = r[2], n = pts.length / 2;
    if (n < 2) return;
    var w = (widths[cat] || 6) / 2, c = colors[cat] || colors[2];
    for (var i = 0; i < n; i++) {
      var x = pts[i * 2], z = pts[i * 2 + 1];
      var i0 = Math.max(0, i - 1) * 2, i1 = Math.min(n - 1, i + 1) * 2;
      var dx = pts[i1] - pts[i0], dz = pts[i1 + 1] - pts[i0 + 1];
      var len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
      var ox = -dz * w, oz = dx * w;
      var h = sampleH(x, z) + 0.55;
      pos.push(x + ox, h, z + oz, x - ox, h, z - oz);
      col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
      if (i > 0) { var b = v + (i - 1) * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
    }
    v += n * 2;
  });
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  var mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.userData.kind = 'roads';
  scene.add(mesh);
}

/* Editor-only street-name paint on road surfaces (never in the game). */
function buildRoadLabels() {
  try {
    var g = ROADLABELS.build({ heightAt: function (x, z) { return sampleH(x, z) + 1.0; } });
    g.userData.kind = 'roadlabels';
    scene.add(g);
  } catch (e) { /* labels are a review aid; never break the view */ }
}

var TYPENAME = ['house', 'commercial bldg', 'apartment/large', 'structure'];
var TYPECOLOR = [[0.85, 0.79, 0.64], [0.66, 0.75, 0.85], [0.58, 0.65, 0.74], [0.77, 0.71, 0.60]];
var bldgSpots = []; // placed [x,z] per building index (post-nudge, what the game renders)

/* Placement protocol — replicates the game's www/index.html runOsmBuildings()/
   placeStruct(): nudge to nearest clear spot (spiral, max 30u), else skip.
   Without this the 3D view shows raw OSM positions, including buildings on
   roads that the game itself moves or drops. Corridor half-width = roadW/2 +
   1.5, matching the game's buildRoadGrids() (hw = r.w/2 + 1.5). */
var PLACE_HW = [12.5, 7, 5];
/* Programmatic roads the game pushes to roadDrawData (NOT in roads.js data):
   these MUST be in the placement grid or buildings near them never nudge. */
var PLACE_EXTRA_ROADS = [
  /* I-20 bridge connector (game: w:34 -> hw 18.5) */
  { pts: [3711,2778, 3655,2780, 3605,2782, 3573,2784], hw: 18.5 },
  /* MLK overpass deck over I-285 at (4154,3229) yaw 1.114, w:11 -> hw 7 */
  { pts: [4116.3,3210.5, 4191.7,3247.5], hw: 7 },
  /* MLK approach ramps (deck edge -> at-grade road), w:11 -> hw 7 */
  { pts: [4116.3,3210.5, 4028.4,3167.2], hw: 7 },
  { pts: [4191.7,3247.5, 4279.6,3290.8], hw: 7 }
];
var placeGrid = null, placeSegs = [];
function placeAddSeg(ax, az, bx, bz, hw, map, cell) {
  var si = placeSegs.length;
  placeSegs.push([ax, az, bx, bz, hw]);
  var x0 = Math.floor((Math.min(ax, bx) - hw) / cell),
      x1 = Math.floor((Math.max(ax, bx) + hw) / cell),
      z0 = Math.floor((Math.min(az, bz) - hw) / cell),
      z1 = Math.floor((Math.max(az, bz) + hw) / cell);
  for (var cx = x0; cx <= x1; cx++) for (var cz = z0; cz <= z1; cz++) {
    var k = cx + ',' + cz;
    (map[k] || (map[k] = [])).push(si);
  }
}
function placeBuildGrid() {
  if (placeGrid) return placeGrid;
  var cell = 100, map = {};
  (WORLD.roads || []).forEach(function (r) {
    var pts = r[2], hw = PLACE_HW[r[0]] || 5;
    for (var i = 0; i + 3 < pts.length; i += 2) {
      placeAddSeg(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], hw, map, cell);
    }
  });
  /* programmatic game roads (not in roads.js) */
  PLACE_EXTRA_ROADS.forEach(function (er) {
    var p = er.pts;
    for (var i = 0; i + 3 < p.length; i += 2) {
      placeAddSeg(p[i], p[i + 1], p[i + 2], p[i + 3], er.hw, map, cell);
    }
  });
  placeGrid = { cell: cell, map: map };
  return placeGrid;
}
function placeEdgeDist(x, z) {
  var g = placeBuildGrid(), c = g.cell, best = 1e9, seen = {}, pad = 150;
  var x0 = Math.floor((x - pad) / c), x1 = Math.floor((x + pad) / c),
      z0 = Math.floor((z - pad) / c), z1 = Math.floor((z + pad) / c);
  for (var cx = x0; cx <= x1; cx++) for (var cz = z0; cz <= z1; cz++) {
    var a = g.map[cx + ',' + cz]; if (!a) continue;
    for (var i = 0; i < a.length; i++) {
      var si = a[i]; if (seen[si]) continue; seen[si] = 1;
      var s = placeSegs[si];
      var vx = s[2] - s[0], vz = s[3] - s[1], len2 = vx * vx + vz * vz;
      var t = len2 > 0 ? ((x - s[0]) * vx + (z - s[1]) * vz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      var d = Math.hypot(x - (s[0] + vx * t), z - (s[1] + vz * t)) - s[4];
      if (d < best) best = d;
    }
  }
  return best;
}
/* Placed-building footprints for overlap prevention: [[x,z,hw,hd],...].
   The game doesn't check building-vs-building, but Joshua sees overlaps in
   the 3D view — the watcher keeps nudged buildings from landing on each
   other. */
var placedFootprints = [];
function footprintClear(x, z, hw, hd) {
  for (var i = 0; i < placedFootprints.length; i++) {
    var f = placedFootprints[i];
    /* AABB overlap with 1u breathing room */
    if (Math.abs(x - f[0]) < hw + f[2] + 1 &&
        Math.abs(z - f[1]) < hd + f[3] + 1) return false;
  }
  return true;
}
function placeBuildingSpot(b) {
  var need = Math.max(b[2], b[3]) / 2 + 4;
  var hw = Math.max(4, b[2]) / 2, hd = Math.max(4, b[3]) / 2;
  function ok(x, z) {
    return placeEdgeDist(x, z) >= need && footprintClear(x, z, hw, hd);
  }
  if (ok(b[0], b[1])) { placedFootprints.push([b[0], b[1], hw, hd]); return [b[0], b[1]]; }
  /* match the game's placeStruct spiral exactly: r 6..30 step 6, 8 angles */
  for (var r = 6; r <= 30; r += 6) {
    for (var a = 0; a < 8; a++) {
      var nx = b[0] + Math.cos(a / 8 * Math.PI * 2) * r,
          nz = b[1] + Math.sin(a / 8 * Math.PI * 2) * r;
      if (ok(nx, nz)) { placedFootprints.push([nx, nz, hw, hd]); return [nx, nz]; }
    }
  }
  return null; // game skips it too
}

function buildBuildings() {
  buildings = OSM_BUILDINGS;
  var geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  var mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  var mesh = new THREE.InstancedMesh(geo, mat, buildings.length);
  var m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pp = new THREE.Vector3();
  var col = new THREE.Color();
  var placed = 0, skipped = 0;
  bldgSpots = new Array(buildings.length);
  for (var i = 0; i < buildings.length; i++) {
    var b = buildings[i];
    var spot = placeBuildingSpot(b);
    bldgSpots[i] = spot; // null = skipped by game
    if (!spot) { skipped++; continue; } // game drops it too — don't render
    var h = Math.max(2.5, b[4]);
    pp.set(spot[0], sampleH(spot[0], spot[1]) - 0.4, spot[1]);
    sc.set(Math.max(4, b[2]), h, Math.max(4, b[3]));
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
    m.compose(pp, q, sc);
    mesh.setMatrixAt(placed, m);
    var tc = TYPECOLOR[b[5]] || TYPECOLOR[3];
    var v = 0.92 + 0.16 * hash2(i, 7);
    col.setRGB(tc[0] * v, tc[1] * v, tc[2] * v);
    mesh.setColorAt(placed, col);
    placed++;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.userData.kind = 'buildings';
  scene.add(mesh);
}

function buildSigns() {
  if (typeof EXIT_SIGNS === 'undefined') return;
  var geo = new THREE.PlaneGeometry(7.2, 3);
  var mat = new THREE.MeshLambertMaterial({ color: 0x0a7a3c, side: THREE.DoubleSide });
  var mesh = new THREE.InstancedMesh(geo, mat, EXIT_SIGNS.length);
  var m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), pp = new THREE.Vector3();
  var up = new THREE.Vector3(0, 1, 0);
  for (var i = 0; i < EXIT_SIGNS.length; i++) {
    var s = EXIT_SIGNS[i];
    pp.set(s.x, sampleH(s.x, s.z) + 4.5, s.z);
    q.setFromAxisAngle(up, s.yaw || 0);
    m.compose(pp, q, sc);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.userData.kind = 'signs';
  scene.add(mesh);
}

function buildLights() {
  // amber markers where the rig says a traffic light is needed
  var spots = [];
  (WORLD.findings || []).forEach(function (f) {
    if (f[2] === 'light-needed') spots.push(f);
  });
  if (!spots.length) return;
  var geo = new THREE.BoxGeometry(1.2, 7, 1.2);
  geo.translate(0, 3.5, 0);
  var mat = new THREE.MeshLambertMaterial({ color: 0x222222 });
  var mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  var lampG = new THREE.SphereGeometry(0.9, 8, 6);
  var lampM = new THREE.MeshLambertMaterial({ color: 0xffb300, emissive: 0x7a5200 });
  var lamps = new THREE.InstancedMesh(lampG, lampM, spots.length);
  var m = new THREE.Matrix4();
  spots.forEach(function (f, i) {
    var h = sampleH(f[0], f[1]);
    m.makeTranslation(f[0], h, f[1]); mesh.setMatrixAt(i, m);
    m.makeTranslation(f[0], h + 7.4, f[1]); lamps.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  lamps.instanceMatrix.needsUpdate = true;
  mesh.userData.kind = 'lights';
  scene.add(mesh); scene.add(lamps);
}

function buildWater() {
  var mat = new THREE.MeshLambertMaterial({ color: 0x2f6da3 });
  (WORLD.water || []).forEach(function (w) {
    var geo = new THREE.CircleGeometry(1, 24);
    geo.rotateX(-Math.PI / 2);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(w.rx, 1, w.rz);
    mesh.position.set(w.x, sampleH(w.x, w.z) + 0.35, w.z);
    scene.add(mesh);
  });
}

function buildPois() {
  (WORLD.pois || []).forEach(function (p) {
    var cv = document.createElement('canvas');
    cv.width = 256; cv.height = 48;
    var cx = cv.getContext('2d');
    cx.fillStyle = 'rgba(8,12,20,0.78)';
    cx.fillRect(0, 0, 256, 48);
    cx.strokeStyle = '#7fd0ff'; cx.strokeRect(1, 1, 254, 46);
    cx.fillStyle = '#fff'; cx.font = 'bold 20px sans-serif';
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    var label = p.n.length > 24 ? p.n.slice(0, 24) : p.n;
    cx.fillText(label, 128, 25);
    var tex = new THREE.CanvasTexture(cv);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.scale.set(220, 41, 1);
    sp.position.set(p.x, sampleH(p.x, p.z) + 60, p.z);
    sp.userData.poi = p;
    scene.add(sp);
  });
}

/* Vehicle showroom — every game vehicle type, live from the game's
   vehicle_meshes.js (single source of truth). Parked in a row on Dollar Mill
   Rd by the home base so Joshua can see all of them in the watcher. */
function buildVehicleShowroom() {
  if (typeof safariMesh === 'undefined') return;   // game module didn't load
  function labelSprite(text) {
    var cv = document.createElement('canvas');
    cv.width = 256; cv.height = 48;
    var cx = cv.getContext('2d');
    cx.fillStyle = 'rgba(8,12,20,0.78)'; cx.fillRect(0, 0, 256, 48);
    cx.strokeStyle = '#ffd24a'; cx.strokeRect(1, 1, 254, 46);
    cx.fillStyle = '#fff'; cx.font = 'bold 20px sans-serif';
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText(text.length > 24 ? text.slice(0, 24) : text, 128, 25);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv), depthTest: false }));
    sp.scale.set(46, 8.6, 1);
    return sp;
  }
  var defs = [
    ['GMC Safari — your van', function () { return safariMesh(); }],
    ['Sedan',                 function () { return sedanMesh(0x2e5fa3); }],
    ['Box Chevy (donk)',      function () { return boxChevyMesh(pickPaint('boxchevy', 'chrome'), 'chrome'); }],
    ['Bubble Chevy (donk)',   function () { return bubbleChevyMesh(pickPaint('bubblechevy', 'chrome'), 'chrome'); }],
    ['Pickup',                function () { return pickupMesh(pickPaint('pickup', 'chrome'), 'chrome'); }],
    ['SUV',                   function () { return suvMesh(pickPaint('suv', 'chrome'), 'chrome'); }],
    ['18-wheeler semi',       function () { return semiMesh(); }],
    ['MARTA bus',             function () { return martaBusMesh(); }],
    ['School bus',            function () { return schoolBusMesh(); }]
  ];
  var x0 = 3090, z0 = 3700, step = 16;   // along Dollar Mill Rd by home base
  defs.forEach(function (d, i) {
    var fn = d[1], mesh = null;
    try { mesh = fn(); } catch (e) { return; }
    if (!mesh) return;
    var x = x0, z = z0 + i * step;
    mesh.position.set(x, sampleH(x, z) + 0.15, z);
    scene.add(mesh);
    var sp = labelSprite(d[0]);
    sp.position.set(x, sampleH(x, z) + 9, z);
    scene.add(sp);
  });
}

/* ---------------- controls ---------------- */
function onResize() {
  var w = canvas.clientWidth || window.innerWidth;
  var h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function bindControls() {
  var touches = new Map();
  window.addEventListener('keydown', function (e) {
    if (!active) return;
    if (e.key !== 'Escape' && window.WatcherTyping && window.WatcherTyping()) return;
    keys[e.key.toLowerCase()] = true;
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(e.key.toLowerCase()) >= 0) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });

  var dragging = false, lx = 0, ly = 0, moved = 0, downT = 0;
  var pinchD = 0, twoY = 0;

  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) { dragging = true; lx = e.clientX; ly = e.clientY; moved = 0; downT = performance.now(); }
    else if (touches.size === 2) {
      dragging = false;
      var t = Array.from(touches.values());
      pinchD = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y);
      twoY = (t[0].y + t[1].y) / 2;
    }
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1 && dragging) {
      var dx = e.clientX - lx, dy = e.clientY - ly;
      moved += Math.abs(dx) + Math.abs(dy);
      yaw -= dx * 0.0042;
      pitch = Math.max(-1.45, Math.min(0.2, pitch - dy * 0.0042));
      lx = e.clientX; ly = e.clientY;
    } else if (touches.size === 2) {
      var t = Array.from(touches.values());
      var d = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y);
      var cy = (t[0].y + t[1].y) / 2;
      dolly((pinchD - d) * 1.2);
      py = Math.max(20, py + (twoY - cy) * 2.5);
      pinchD = d; twoY = cy;
    }
  });
  function endTouch(e) {
    var wasTap = touches.size === 1 && dragging && moved < 12 && (performance.now() - downT) < 400;
    touches.delete(e.pointerId);
    if (touches.size === 0) dragging = false;
    if (wasTap) handleTap(e.clientX, e.clientY);
  }
  canvas.addEventListener('pointerup', endTouch);
  canvas.addEventListener('pointercancel', function (e) { touches.delete(e.pointerId); dragging = false; });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    dolly(e.deltaY * 1.6);
  }, { passive: false });
}

function dolly(amount) {
  var cp = Math.cos(pitch);
  var f = 1 + amount / 1200;
  f = Math.max(0.85, Math.min(1.18, f));
  // move camera toward/away from look target: scale offset from a point ahead
  var tx = px + Math.sin(yaw) * cp * 600;
  var tz = pz - Math.cos(yaw) * cp * 600;
  px = tx + (px - tx) * f;
  pz = tz + (pz - tz) * f;
  py = Math.max(15, 30 + (py - 30) * f);
}

function updateCamera() {
  var cp = Math.cos(pitch), sp = Math.sin(pitch);
  camera.position.set(px, py, pz);
  camera.lookAt(px + Math.sin(yaw) * cp, py + sp, pz - Math.cos(yaw) * cp);
}

function move(dt) {
  var sp = 60 + py * 0.45;
  var cp = Math.cos(pitch);
  var fx = Math.sin(yaw) * cp, fz = -Math.cos(yaw) * cp;
  var rx = Math.cos(yaw), rz = Math.sin(yaw);
  var mx = 0, mz = 0, my = 0;
  if (keys['w'] || keys['arrowup']) { mx += fx; mz += fz; }
  if (keys['s'] || keys['arrowdown']) { mx -= fx; mz -= fz; }
  if (keys['a'] || keys['arrowleft']) { mx -= rx; mz -= rz; }
  if (keys['d'] || keys['arrowright']) { mx += rx; mz += rz; }
  if (keys['r'] || keys['q']) my += 1;
  if (keys['f'] || keys['e']) my -= 1;
  var l = Math.hypot(mx, mz);
  if (l > 0) { mx /= l; mz /= l; }
  px = Math.max(0, Math.min(HF.w, px + mx * sp * dt));
  pz = Math.max(0, Math.min(HF.h, pz + mz * sp * dt));
  py = Math.max(15, Math.min(4000, py + my * sp * dt));
}

/* ---------------- tap-to-feedback ---------------- */
function groundPoint(cx, cy) {
  var r = canvas.getBoundingClientRect();
  var nx = ((cx - r.left) / r.width) * 2 - 1;
  var ny = -((cy - r.top) / r.height) * 2 + 1;
  var vec = new THREE.Vector3(nx, ny, 0.5).unproject(camera);
  var dir = vec.sub(camera.position).normalize();
  // march the ray, refine against terrain
  var t = 0, x = 0, y = 0, z = 0;
  for (var i = 0; i < 40; i++) {
    t += 60;
    x = camera.position.x + dir.x * t;
    y = camera.position.y + dir.y * t;
    z = camera.position.z + dir.z * t;
    if (x < 0 || x > HF.w || z < 0 || z > HF.h) return null;
    if (y <= sampleH(x, z)) break;
  }
  return { x: x, z: z };
}

function nearest(px2, pz2, list, fn, maxD) {
  var best = null, bd = maxD;
  for (var i = 0; i < list.length; i++) {
    var p = fn(list[i], i);
    var d = Math.hypot(p[0] - px2, p[1] - pz2);
    if (d < bd) { bd = d; best = { item: list[i], idx: i, d: d }; }
  }
  return best;
}
function segDist(x, z, ax, az, bx, bz) {
  var dx = bx - ax, dz = bz - az;
  var L2 = dx * dx + dz * dz || 1;
  var t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}
function nearestRoad(x, z, maxD) {
  var best = null, bd = maxD;
  WORLD.roads.forEach(function (r) {
    var pts = r[2], n = pts.length / 2;
    for (var i = 0; i < n - 1; i++) {
      var d = segDist(x, z, pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3]);
      if (d < bd) { bd = d; best = r; }
    }
  });
  return best ? { run: best, d: bd } : null;
}

function handleTap(cx, cy) {
  var g = groundPoint(cx, cy);
  if (!g) return;
  var cands = [];
  var b = nearest(g.x, g.z, buildings, function (it, idx) {
    var s = bldgSpots[idx]; return s ? s : [it[0], it[1]];
  }, 35);
  if (b) cands.push({ k: 'building', d: b.d, it: b.item });
  var r = nearestRoad(g.x, g.z, 22);
  if (r) cands.push({ k: 'road', d: r.d, it: r.run });
  if (typeof EXIT_SIGNS !== 'undefined') {
    var s = nearest(g.x, g.z, EXIT_SIGNS, function (it) { return [it.x, it.z]; }, 30);
    if (s) cands.push({ k: 'sign', d: s.d, it: s.item });
  }
  var p = nearest(g.x, g.z, WORLD.pois || [], function (it) { return [it.x, it.z]; }, 80);
  if (p) cands.push({ k: 'poi', d: p.d / 2, it: p.item });
  var f = nearest(g.x, g.z, WORLD.findings || [], function (it) { return [it[0], it[1]]; }, 35);
  if (f) cands.push({ k: 'flag', d: f.d, it: f.item });
  if (!cands.length) return;
  cands.sort(function (a, b2) { return a.d - b2.d; });
  var w = cands[0], note;
  if (w.k === 'building') {
    var wsp = bldgSpots[w.idx];
    note = { type: 'building', name: TYPENAME[w.it[5]] || 'structure',
             x: wsp ? wsp[0] : w.it[0], z: wsp ? wsp[1] : w.it[1] };
  } else if (w.k === 'road') {
    note = { type: 'road', name: w.it[1] || 'unnamed road', x: g.x, z: g.z };
  } else if (w.k === 'sign') {
    note = { type: 'sign', name: 'exit sign: ' + (w.it.text || w.it.exit), x: w.it.x, z: w.it.z };
  } else if (w.k === 'poi') {
    note = { type: 'place', name: w.it.n, x: w.it.x, z: w.it.z };
  } else {
    note = { type: 'flag', name: w.it[2] + (w.it[5] ? ' — ' + w.it[5] : ''), x: w.it[0], z: w.it[1] };
  }
  note.view = '3d';
  Feedback.openComment(note);
}

/* ---------------- main loop / lifecycle ---------------- */
function frame(t) {
  if (!active || !ready) return;
  var dt = Math.min(0.1, (t - clock) / 1000 || 0.016);
  clock = t;
  move(dt);
  updateCamera();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function start() {
  active = true;
  window.AW_ACTIVE_VIEW = '3d';
  if (ready) { clock = performance.now(); requestAnimationFrame(frame); }
}
function stop() {
  active = false;
  window.AW_ACTIVE_VIEW = '2d';
}

return { ensure: ensure, start: start, stop: stop };
})();
