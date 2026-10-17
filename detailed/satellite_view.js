/* ============================================================================
   FILE: satellite_view.js — "Surviving Adamsville" SATELLITE VIEW
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-10):
   "Create a satellite [view] that will give us a top view down of the area
   so that when he opens the map he's able to do a 3D map."
   Terminology: call it "Satellite View" in all UI labels and buttons.

   WHAT IT DOES:
   - From the full map (tap the minimap), a "Satellite View" button switches
     from the 2D canvas map to a LIVE 3D top-down view of the actual game
     world, rendered by the game's own Three.js scene.
   - 2D mode: camera directly overhead looking straight down (satellite style,
     north-up).
   - 3D mode: camera tilted for a perspective view of terrain and buildings.
   - Drag to pan, pinch / mouse-wheel / +/- buttons to zoom.
   - Shows zone boundaries (from ZONEUNLOCK.zones) as terrain-hugging lines,
     zone name labels, a pulsing player marker, and a recenter button.

   HOW IT WORKS:
   - While active, window.__satViewActive is true, which makes the game's
     normal updateCamera() return early — this module owns the camera.
   - SATVIEW.update(dt) is called from the game's animate() loop; it
     positions the camera, updates the player marker, and projects zone
     labels to screen coordinates.
   - Scene fog is disabled while active (a satellite sees clearly) and
     restored on close. camera.up is adjusted for the top-down view and
     restored on close.

   PUBLIC API (window.SATVIEW):
     open()        — enter satellite view (call after closing the 2D full map)
     close()       — exit satellite view, restore normal camera
     isActive()    — true while satellite view is open
     toggleMode()  — switch between 2D top-down and 3D perspective
     setMode3d(b)  — false = 2D top-down, true = 3D perspective
     zoomIn() / zoomOut() — button zoom controls
     recenter()    — snap the view back onto the player
     update(dt)    — per-frame camera/label/marker update (called by animate)

   Include AFTER zoneunlock.js in index.html:
       <script src="satellite_view.js"></script>
   All hooks are guarded — the game works normally if this module is missing.
   ============================================================================ */
(function(){
'use strict';
if (window.SATVIEW) return;  // single instance guard

/* ---------------- state ---------------- */
var active = false;      // satellite view is open
var mode3d = false;      // false = 2D top-down, true = 3D tilted perspective
var tx = 4000, tz = 6000; // camera target in world coordinates
var height = 700;         // camera altitude (zoom level)
var MIN_H = 150, MAX_H = 2200;
var savedFog = undefined; // original scene.fog (restored on close)
var zoneGroup = null;     // THREE.Group holding zone boundary lines
var playerRing = null;    // pulsing ring marker at the player
var playerDot = null;     // center dot of the player marker
var labelDivs = [];       // HTML zone label divs
var pulseT = 0;

/* DOM refs (lazy — grabbed on first open) */
var uiRoot = null, touchLayer = null, labelLayer = null, modeBtn = null;

/* ---------------- helpers ---------------- */
// Where the player is right now (car position when driving).
function playerPos(){
  try{
    if (typeof car !== 'undefined' && car && car.driving) return {x: car.x, z: car.z};
    if (typeof player !== 'undefined' && player) return {x: player.x, z: player.z};
  }catch(e){}
  return {x: 4000, z: 6000};
}
// Terrain height at a world point (safe fallback to 0).
function groundY(x, z){
  try{ if (typeof heightAt === 'function'){ var y = heightAt(x, z); if (isFinite(y)) return y; } }catch(e){}
  return 0;
}
// Zone list — from ZONEUNLOCK when available, else empty.
function zones(){
  try{ if (window.ZONEUNLOCK && ZONEUNLOCK.zones) return ZONEUNLOCK.zones; }catch(e){}
  return [];
}
function zoneUnlocked(id){
  try{ if (window.ZONEUNLOCK && ZONEUNLOCK.isUnlocked) return ZONEUNLOCK.isUnlocked(id); }catch(e){}
  return true;
}
function $(id){ return document.getElementById(id); }

/* ---------------- DOM setup (lazy) ---------------- */
function ensureDom(){
  if (uiRoot) return;
  uiRoot    = $('satview-ui');
  touchLayer= $('satview-touch');
  labelLayer= $('satview-labels');
  modeBtn   = $('satview-mode');
  if (!uiRoot || !touchLayer) return;  // HTML not present — stay inert

  // Mode toggle button: label shows the mode you'll switch TO.
  $('satview-mode').addEventListener('click', function(e){ e.stopPropagation(); toggleMode(); });
  $('satview-zin').addEventListener('click', function(e){ e.stopPropagation(); zoomIn(); });
  $('satview-zout').addEventListener('click', function(e){ e.stopPropagation(); zoomOut(); });
  $('satview-recenter').addEventListener('click', function(e){ e.stopPropagation(); recenter(); });
  $('satview-close').addEventListener('click', function(e){ e.stopPropagation(); close(); });

  /* ----- gesture handling: drag to pan, pinch/wheel to zoom ----- */
  var pan = null, pinch = null;
  function toWorld(dxPx, dyPx){
    // Screen pixels -> world units. Scale with altitude so panning feels
    // consistent at any zoom. In 3D tilt mode, screen-up maps to -z.
    var s = height / 700;
    if (!mode3d) return {dx: dxPx * s, dz: dyPx * s};
    return {dx: dxPx * s, dz: dyPx * s * 1.15};
  }
  touchLayer.addEventListener('touchstart', function(e){
    var ts = e.touches;
    if (ts.length === 1){
      pan = {id: ts[0].identifier, lx: ts[0].clientX, ly: ts[0].clientY};
      pinch = null;
    } else if (ts.length === 2){
      var a = ts[0], b = ts[1];
      pinch = {d: Math.hypot(a.clientX-b.clientX, a.clientY-b.clientY), h: height};
      pan = null;
    }
    e.preventDefault();
  }, {passive:false});
  touchLayer.addEventListener('touchmove', function(e){
    var ts = e.touches;
    if (pinch && ts.length === 2){
      var a = ts[0], b = ts[1];
      var d = Math.hypot(a.clientX-b.clientX, a.clientY-b.clientY);
      if (d > 10 && pinch.d > 10) setHeight(pinch.h * pinch.d / d);
    } else if (pan && ts.length === 1){
      var t = null;
      for (var i = 0; i < ts.length; i++) if (ts[i].identifier === pan.id) t = ts[i];
      if (t){
        var w = toWorld(-(t.clientX - pan.lx), -(t.clientY - pan.ly));
        tx += w.dx; tz += w.dz;
        pan.lx = t.clientX; pan.ly = t.clientY;
      }
    }
    e.preventDefault();
  }, {passive:false});
  function endTouch(){ pan = null; pinch = null; }
  touchLayer.addEventListener('touchend', endTouch);
  touchLayer.addEventListener('touchcancel', endTouch);

  // Mouse: drag to pan, wheel to zoom (desktop/laptop).
  var mDown = false, mLx = 0, mLy = 0;
  touchLayer.addEventListener('mousedown', function(e){
    if (e.button !== 0) return;
    mDown = true; mLx = e.clientX; mLy = e.clientY;
    e.preventDefault();
  });
  touchLayer.addEventListener('mousemove', function(e){
    if (!mDown) return;
    var w = toWorld(-(e.clientX - mLx), -(e.clientY - mLy));
    tx += w.dx; tz += w.dz;
    mLx = e.clientX; mLy = e.clientY;
  });
  touchLayer.addEventListener('mouseup', function(){ mDown = false; });
  touchLayer.addEventListener('mouseleave', function(){ mDown = false; });
  touchLayer.addEventListener('wheel', function(e){
    e.preventDefault();
    setHeight(height * (e.deltaY < 0 ? 0.85 : 1.18));
  }, {passive:false});
}

/* ---------------- 3D scene objects ---------------- */
// Build terrain-hugging boundary lines for every zone.
function buildZoneLines(){
  disposeZoneLines();
  if (typeof THREE === 'undefined' || typeof scene === 'undefined') return;
  zoneGroup = new THREE.Group();
  var list = zones();
  var SEG = 20;  // points per edge — enough to hug hills
  list.forEach(function(zn){
    var color;
    if (zn.start) color = 0xffd75e;                       // home base: gold
    else if (zoneUnlocked(zn.id)) color = 0x4ecb71;        // unlocked: green
    else color = 0xff5566;                                // locked: red
    var pts = [];
    function edge(x0,z0,x1,z1){
      for (var i = 0; i <= SEG; i++){
        var x = x0 + (x1-x0)*i/SEG, z = z0 + (z1-z0)*i/SEG;
        pts.push(new THREE.Vector3(x, groundY(x,z) + 4, z));
      }
    }
    edge(zn.xMin, zn.zMin, zn.xMax, zn.zMin);
    edge(zn.xMax, zn.zMin, zn.xMax, zn.zMax);
    edge(zn.xMax, zn.zMax, zn.xMin, zn.zMax);
    edge(zn.xMin, zn.zMax, zn.xMin, zn.zMin);
    var geo = new THREE.BufferGeometry();
    var arr = new Float32Array(pts.length * 3);
    pts.forEach(function(p, i){ arr[i*3] = p.x; arr[i*3+1] = p.y; arr[i*3+2] = p.z; });
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    var line = new THREE.Line(geo, new THREE.LineBasicMaterial({color: color}));
    zoneGroup.add(line);
  });
  scene.add(zoneGroup);

  // Player marker: pulsing ring + center dot, billboarded flat on the ground.
  var ringGeo = new THREE.RingGeometry(7, 10, 40);
  playerRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({color: 0xffd75e, side: THREE.DoubleSide}));
  playerRing.rotation.x = -Math.PI/2;
  var dotGeo = new THREE.CircleGeometry(3, 24);
  playerDot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({color: 0xffffff, side: THREE.DoubleSide}));
  playerDot.rotation.x = -Math.PI/2;
  zoneGroup.add(playerRing);
  zoneGroup.add(playerDot);
}
function disposeZoneLines(){
  if (zoneGroup && typeof scene !== 'undefined'){
    try{ scene.remove(zoneGroup); }catch(e){}
    zoneGroup.traverse(function(o){
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  zoneGroup = null; playerRing = null; playerDot = null;
}
// HTML labels, one per zone, positioned by projection each frame.
function buildLabels(){
  clearLabels();
  if (!labelLayer) return;
  zones().forEach(function(zn){
    var d = document.createElement('div');
    d.className = 'sat-label' + (zn.start ? ' sat-home' : '') + (zoneUnlocked(zn.id) ? '' : ' sat-locked');
    d.textContent = (zoneUnlocked(zn.id) ? '' : '🔒 ') + zn.name + (zn.start ? ' ★' : '');
    labelLayer.appendChild(d);
    labelDivs.push({zn: zn, el: d});
  });
}
function clearLabels(){
  labelDivs.forEach(function(l){ try{ l.el.remove(); }catch(e){} });
  labelDivs = [];
}

/* ---------------- camera ---------------- */
function setHeight(h){
  height = Math.max(MIN_H, Math.min(MAX_H, h));
}
function applyCamera(){
  if (typeof camera === 'undefined') return;
  if (!mode3d){
    // 2D satellite: directly overhead, north-up. camera.up must not be
    // parallel to the view direction, so use -Z as up.
    camera.up.set(0, 0, -1);
    camera.position.set(tx, height, tz);
    camera.lookAt(tx, 0, tz);
  } else {
    // 3D perspective: tilted view for terrain/building depth.
    camera.up.set(0, 1, 0);
    camera.position.set(tx, height * 0.62, tz + height * 0.78);
    camera.lookAt(tx, 0, tz);
  }
}

/* ---------------- public API ---------------- */
function open(){
  ensureDom();
  if (!uiRoot || typeof camera === 'undefined' || typeof scene === 'undefined') return;
  var p = playerPos();
  tx = p.x; tz = p.z;
  setHeight(700);
  mode3d = false;
  updateModeBtn();
  // Satellite sees clearly: disable fog while active (restored on close).
  try{ savedFog = scene.fog; scene.fog = null; }catch(e){}
  buildZoneLines();
  buildLabels();
  active = true;
  window.__satViewActive = true;
  uiRoot.classList.add('show');
  applyCamera();
}
function close(){
  if (!active) return;
  active = false;
  window.__satViewActive = false;
  try{ if (uiRoot) uiRoot.classList.remove('show'); }catch(e){}
  disposeZoneLines();
  clearLabels();
  // Restore fog and camera orientation; the normal updateCamera() takes
  // over on the next frame and repositions behind the player.
  try{ if (typeof scene !== 'undefined' && savedFog !== undefined) scene.fog = savedFog; }catch(e){}
  try{ if (typeof camera !== 'undefined') camera.up.set(0, 1, 0); }catch(e){}
  savedFog = undefined;
}
function isActive(){ return active; }
function updateModeBtn(){
  if (modeBtn) modeBtn.textContent = mode3d ? '2D' : '3D';
}
function toggleMode(){ setMode3d(!mode3d); }
function setMode3d(b){
  mode3d = !!b;
  updateModeBtn();
  if (active) applyCamera();
}
function zoomIn(){ setHeight(height * 0.75); if (active) applyCamera(); }
function zoomOut(){ setHeight(height * 1.33); if (active) applyCamera(); }
function recenter(){
  var p = playerPos();
  tx = p.x; tz = p.z;
  if (active) applyCamera();
}
// Per-frame update, called from the game's animate() loop.
function update(dt){
  if (!active) return;
  applyCamera();
  // Player marker follows the player and pulses.
  var p = playerPos();
  pulseT += dt || 0.016;
  if (playerRing && playerDot){
    var gy = groundY(p.x, p.z) + 3;
    playerRing.position.set(p.x, gy, p.z);
    playerDot.position.set(p.x, gy + 0.5, p.z);
    var s = 1 + 0.18 * Math.sin(pulseT * 4);
    playerRing.scale.set(s, s, 1);
  }
  // Project zone centers to screen for the HTML labels.
  if (typeof THREE !== 'undefined' && typeof camera !== 'undefined'){
    var W = window.innerWidth, H = window.innerHeight;
    var v = new THREE.Vector3();
    labelDivs.forEach(function(l){
      var cx = (l.zn.xMin + l.zn.xMax) / 2, cz = (l.zn.zMin + l.zn.zMax) / 2;
      v.set(cx, groundY(cx, cz) + 40, cz).project(camera);
      var behind = v.z > 1;
      var sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
      if (behind || sx < -80 || sx > W + 80 || sy < -40 || sy > H + 40){
        l.el.style.display = 'none';
      } else {
        l.el.style.display = 'block';
        l.el.style.left = sx + 'px';
        l.el.style.top = sy + 'px';
      }
    });
  }
}

window.SATVIEW = {
  open: open,
  close: close,
  isActive: isActive,
  toggleMode: toggleMode,
  setMode3d: setMode3d,
  zoomIn: zoomIn,
  zoomOut: zoomOut,
  recenter: recenter,
  update: update
};
})();
