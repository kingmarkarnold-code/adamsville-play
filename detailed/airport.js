/* ============================================================================
   AIRPORT v1.0 (2026-10-11)
   ----------------------------------------------------------------------------
   Joshua's request: Hartsfield-Jackson Atlanta International Airport is
   inside the map bounds but missing from the game. This module adds it.

   What it does:
     1. Fetches detailed/airport.json (runways, terminals, concourses,
        connector roads). Falls back to the embedded DEFAULT_AIRPORT if the
        fetch fails — the airport still renders.
     2. Runways: flat dark-asphalt strips with a canvas-generated texture
        (white edge stripes, threshold "piano keys", centerline dashes, and
        the runway designator painted at each end).
     3. Terminals/concourses: box buildings in the map-editor buildings.json
        field format (name, position, width, depth, floors, wall_color,
        roof_color) so they can be copied into buildings.json later for the
        walkable-building system. Rendered here as solid detailed boxes with
        window bands.
     4. Connector road: asphalt ribbon from I-85 to the Airport Loop Rd.

   Coordinate anchor: the MARTA AIRPORT station (5780.0, 7476.2) sits at
   the Domestic Terminal west end. 1 world unit ~ 1 meter.

   Defensive: fully no-op if THREE/scene/heightAt are unavailable, or if
   the JSON is missing/corrupt. Never throws at load.

   Exposed API:
     window.Airport = { init(), getRunways(), getTerminals() }

   Joshua's rule: all code commented.
   ============================================================================ */
(function airport(){
'use strict';

/* ---------- configuration ------------------------------------------------- */
/* Relative to detailed/ — same folder as this script. */
var AIRPORT_URL = 'airport.json?v=1';
/* Height offsets so airport geometry sits above the terrain skin. */
var RUNWAY_LIFT = 0.6;   // runways float just above the ground plane
var ROAD_LIFT   = 0.5;   // connector road ribbon lift
var BLDG_SINK   = 0.6;   // sink building bases slightly (matches spawner)
/* Floor height for terminal boxes (world units). */
var FLOOR_H = 4.5;
/* Runway texture size (px). Aspect matches a 3000x50 runway (60:1). */
var TEX_W = 2048, TEX_H = 40;

/* ---------- embedded fallback data -----------------------------------------
   Same content as airport.json. Used when the fetch fails (offline, 404).
   Keep in sync with airport.json when the data changes. */
var DEFAULT_AIRPORT = {
  runways: [
    {id:"08L/26R", heading:90, length:3000, width:50, center:[7000,6776]},
    {id:"08R/26L", heading:90, length:3000, width:50, center:[7000,7076]},
    {id:"09L/27R", heading:90, length:3000, width:50, center:[7000,7676]},
    {id:"09R/27L", heading:90, length:3000, width:50, center:[7000,7976]},
    {id:"10/28",   heading:90, length:3000, width:50, center:[7000,8276]}
  ],
  terminals: [
    {name:"Domestic Terminal", type:"airport_terminal", position:[5780,7426],
     width:500, depth:260, floors:2, walkable:false,
     wall_color:"#cfc8b8", roof_color:"#6a6f75"},
    {name:"Maynard H. Jackson Jr. International Terminal", type:"airport_terminal",
     position:[7930,7426], width:460, depth:260, floors:2, walkable:false,
     wall_color:"#cfc8b8", roof_color:"#6a6f75"}
  ],
  concourses: [
    {name:"Concourse T", type:"airport_concourse", position:[6110,7426],
     width:90, depth:460, floors:1, walkable:false,
     wall_color:"#c4bda9", roof_color:"#6a6f75"},
    {name:"Concourse A", type:"airport_concourse", position:[6360,7426],
     width:90, depth:460, floors:1, walkable:false,
     wall_color:"#c4bda9", roof_color:"#6a6f75"},
    {name:"Concourse B", type:"airport_concourse", position:[6610,7426],
     width:90, depth:460, floors:1, walkable:false,
     wall_color:"#c4bda9", roof_color:"#6a6f75"},
    {name:"Concourse C", type:"airport_concourse", position:[6860,7426],
     width:90, depth:460, floors:1, walkable:false,
     wall_color:"#c4bda9", roof_color:"#6a6f75"},
    {name:"Concourse D", type:"airport_concourse", position:[7110,7426],
     width:90, depth:460, floors:1, walkable:false,
     wall_color:"#c4bda9", roof_color:"#6a6f75"},
    {name:"Concourse E", type:"airport_concourse", position:[7360,7426],
     width:90, depth:460, floors:1, walkable:false,
     wall_color:"#c4bda9", roof_color:"#6a6f75"},
    {name:"Concourse F", type:"airport_concourse", position:[7610,7426],
     width:90, depth:460, floors:1, walkable:false,
     wall_color:"#c4bda9", roof_color:"#6a6f75"}
  ],
  airport_roads: [
    {name:"Airport Connector (I-85 to Terminal Loop)", width:16,
     pts:[[5660,7390],[5800,7340],[5950,7240],[6100,7130],[6139,7050]]}
  ]
};

/* ---------- module state --------------------------------------------------- */
var inited = false;
var built  = [];   // meshes added (for future teardown/refresh)
var data   = null; // resolved airport data (fetched or fallback)

/* ---------- tiny utilities ------------------------------------------------- */
/* Safe terrain height lookup; falls back to 0 when heightAt isn't ready. */
function groundY(x, z){
  try{
    if (typeof heightAt === 'function'){
      var y = heightAt(x, z);
      if (typeof y === 'number' && isFinite(y)) return y;
    }
  }catch(e){}
  return 0;
}
/* Clamp any value to a safe #rrggbb color string. */
function safeColor(v, fallback){
  if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return v;
  return fallback;
}
/* Shared Lambert materials (one per color — cheap). */
var matCache = {};
function mat(color){
  if (!matCache[color]) matCache[color] = new THREE.MeshLambertMaterial({color:color});
  return matCache[color];
}

/* ---------- runway texture ---------------------------------------------------
   One canvas texture per runway: asphalt + white edge stripes + threshold
   piano keys + centerline dashes + designator text at each end.
   id like "08L/26R" is split so "08L" paints at the west end and "26R"
   at the east end. */
function runwayTexture(rwy){
  var cv = document.createElement('canvas');
  cv.width = TEX_W; cv.height = TEX_H;
  var g = cv.getContext('2d');
  // Asphalt base.
  g.fillStyle = '#26262b'; g.fillRect(0, 0, TEX_W, TEX_H);
  // White edge stripes (top and bottom of the strip).
  g.fillStyle = '#e8e8e8';
  g.fillRect(0, 1, TEX_W, 2); g.fillRect(0, TEX_H-3, TEX_W, 2);
  // Threshold piano keys: 8 white bars near each end.
  var keys = 8, keyW = 14, keyGap = 10, keyLen = TEX_H - 12;
  var startX = 60;
  g.fillStyle = '#f2f2f2';
  for (var k = 0; k < keys; k++){
    var kx = startX + k * (keyW + keyGap);
    g.fillRect(kx, 6, keyW, keyLen);                       // west end
    g.fillRect(TEX_W - startX - kx + startX - keyW, 6, keyW, keyLen); // east end
  }
  // Centerline dashes (skip the threshold zones).
  var dashLen = 46, gapLen = 34;
  for (var x = startX + keys*(keyW+keyGap) + 40; x < TEX_W - startX - keys*(keyW+keyGap) - 40; x += dashLen + gapLen){
    g.fillRect(x, TEX_H/2 - 1, dashLen, 2);
  }
  // Runway designators at each end.
  var parts = String(rwy.id || '').split('/');
  g.fillStyle = '#f2f2f2';
  g.font = 'bold 22px sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (parts[0]) g.fillText(parts[0], startX + keys*(keyW+keyGap) + 70, TEX_H/2);
  if (parts[1]) g.fillText(parts[1], TEX_W - startX - keys*(keyW+keyGap) - 70, TEX_H/2);
  var tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  return tex;
}

/* ---------- builders ------------------------------------------------------- */
/* Build one runway: textured flat strip at the averaged terrain height. */
function buildRunway(rwy){
  var cx = rwy.center[0], cz = rwy.center[1];
  var L = rwy.length || 3000, W = rwy.width || 50;
  // Sample the terrain at center + both ends so the flat strip sits
  // on the average grade (airports are graded flat in reality).
  var hx = Math.cos(0), hz = 0; // heading 90 = east-west; see yaw below
  var y0 = groundY(cx - L/2, cz), y1 = groundY(cx, cz), y2 = groundY(cx + L/2, cz);
  var y = (y0 + y1 + y2) / 3 + RUNWAY_LIFT;
  var geo = new THREE.PlaneGeometry(L, W);
  var mtl = new THREE.MeshLambertMaterial({map: runwayTexture(rwy)});
  var mesh = new THREE.Mesh(geo, mtl);
  mesh.rotation.x = -Math.PI/2;
  // Heading 90 = east-west (long axis along X). General yaw for others.
  var heading = (typeof rwy.heading === 'number') ? rwy.heading : 90;
  mesh.rotation.z = (90 - heading) * Math.PI/180;
  mesh.position.set(cx, y, cz);
  mesh.userData.airport = true;
  scene.add(mesh);
  built.push(mesh);
}

/* Build one terminal/concourse: detailed solid box with window band + roof.
   Field names match the map-editor buildings.json format. */
function buildTerminal(t){
  var x = t.position[0], z = t.position[1];
  var w = t.width || 100, d = t.depth || 100;
  var h = Math.max(1, t.floors || 1) * FLOOR_H;
  var yBase = groundY(x, z) - BLDG_SINK;
  var grp = new THREE.Group();
  // Main walls.
  var walls = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    mat(safeColor(t.wall_color, '#cfc8b8'))
  );
  walls.position.y = h/2;
  grp.add(walls);
  // Window band: dark glass strip near the top of the walls.
  var band = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.8, Math.min(2.4, h*0.3), d + 0.8),
    mat('#1c2733')
  );
  band.position.y = h - Math.min(2.4, h*0.3)/2 - 1.2;
  grp.add(band);
  // Flat roof slab with a small overhang.
  var roof = new THREE.Mesh(
    new THREE.BoxGeometry(w + 4, 1.6, d + 4),
    mat(safeColor(t.roof_color, '#6a6f75'))
  );
  roof.position.y = h + 0.8;
  grp.add(roof);
  grp.position.set(x, yBase, z);
  grp.userData.airport = true;
  scene.add(grp);
  built.push(grp);
}

/* Build one connector road polyline as flat asphalt ribbon segments. */
function buildAirportRoad(r){
  var pts = r.pts || [];
  var W = r.width || 14;
  for (var i = 0; i < pts.length - 1; i++){
    var a = pts[i], b = pts[i+1];
    var dx = b[0]-a[0], dz = b[1]-a[1];
    var len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    var mx = (a[0]+b[0])/2, mz = (a[1]+b[1])/2;
    var y = (groundY(a[0],a[1]) + groundY(b[0],b[1]))/2 + ROAD_LIFT;
    var mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(len, W),
      mat('#2e2e33')  // asphalt, matches the game's road tint
    );
    mesh.rotation.x = -Math.PI/2;
    mesh.rotation.z = -Math.atan2(dz, dx);
    mesh.position.set(mx, y, mz);
    mesh.userData.airport = true;
    scene.add(mesh);
    built.push(mesh);
  }
}

/* Build everything from the resolved data object. */
function buildAll(d){
  (d.runways    || []).forEach(function(r){ try{ buildRunway(r);    }catch(e){} });
  (d.terminals  || []).forEach(function(t){ try{ buildTerminal(t);  }catch(e){} });
  (d.concourses || []).forEach(function(t){ try{ buildTerminal(t);  }catch(e){} });
  (d.airport_roads || []).forEach(function(r){ try{ buildAirportRoad(r); }catch(e){} });
  try{ console.log('[airport] built ' + built.length + ' meshes'); }catch(e){}
}

/* ---------- data loading ----------------------------------------------------
   Fetch airport.json; fall back to DEFAULT_AIRPORT on any failure. */
function loadData(cb){
  function done(d){ data = d || DEFAULT_AIRPORT; cb(); }
  try{
    fetch(AIRPORT_URL).then(function(resp){
      if (!resp.ok) throw new Error('http ' + resp.status);
      return resp.json();
    }).then(function(j){
      // Minimal validation: must have a runways array.
      if (!j || !Array.isArray(j.runways)) throw new Error('bad schema');
      done(j);
    }).catch(function(){ done(DEFAULT_AIRPORT); });
  }catch(e){ done(DEFAULT_AIRPORT); }
}

/* ---------- public API ------------------------------------------------------ */
function init(){
  if (inited) return true;
  /* Scene/THREE must exist (this script loads after the main game block,
     same as building_spawner.js). Bail quietly otherwise. */
  if (typeof THREE === 'undefined' || typeof scene === 'undefined'){
    try{ console.warn('[airport] THREE/scene not ready — airport disabled'); }catch(e){}
    return false;
  }
  inited = true;
  loadData(function(){ buildAll(data); });
  return true;
}

/* Expose the module. init() runs at load; callable again for retry. */
window.Airport = {
  init: init,
  getRunways:   function(){ return (data && data.runways)   || []; },
  getTerminals: function(){ return (data && data.terminals) || []; }
};
try{ init(); }catch(e){}

})();
