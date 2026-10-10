/* ============================================================================
   FILE: marta_bus_system.js — "Surviving Adamsville" MARTA buses
   ----------------------------------------------------------------------------
   PURPOSE: MARTA bus service: real GTFS routes, instanced bus-stop signs,
   rideable city buses.
   KEY SYSTEMS:
     - Routes: 20 route-direction records from real GTFS data (9 route
       numbers × 2 directions), each with a real-shape arc-length path.
       40 buses total (2 per route, spaced half the path apart).
     - Bus state machine: run → (ease into stop within 60u, snap + dwell 6s)
       → run; REVERSE direction at termini (dir *= -1) — buses shuttle back
       and forth along the route shape (unlike trains, which run to the map
       edge and vanish).
     - Stop arc positions: each GTFS stop is snapped to its nearest path
       point (coarse-then-fine search); outlier stops (>40u from the path)
       are MOVED onto the path so the bus stops where the sign is. Stops are
       then sorted by arc position so buses visit them in path order.
     - Bus stops: instanced pole+sign boards at every in-map stop, ONE draw
       call per part; poles are solid (colliders, v2.1).
     - v2.0 SIGN PLACEMENT RULES (Joshua 2026-10-09): every bus-stop sign is
       validated through SignRules.place() before positioning — signs that
       would spawn in a driving lane are moved to the right shoulder. Buses
       dwell by ARC POSITION (st.s), so moving the sign never changes where
       the bus stops. The audit publishes via SignRules.publish() at load.
     - Boarding/riding: same universal-action-button pattern as trains —
       busCheckBoard returns {act:'board-bus'|'exit-bus'}; board within 25u
       of a dwelling bus; exit drops the player at the nearest stop
       (+4u offset) with terrain height. HUD shows route number + next stop.
     - Bus geometry comes from vehicle_meshes.js — the CANONICAL martaBusMesh
       builder (shared with the watcher studio). NEVER duplicate it here.
   JOSHUA SPECS ENCODED:
     - MARTA bus content queued by Joshua (2026-10-09): real routes, real
       stops, rideable buses, bus-stop signs.
     - Simple sim logic: constant-speed buses, eased stops; no physics.
   ============================================================================ */
/* ============================================================================
   SURVIVING ADAMSVILLE — MARTA BUS SYSTEM (v1.0)
   ----------------------------------------------------------------------------
   STANDALONE MODULE. Include AFTER marta_bus_data.js and the main game script:

       <script src="marta_bus_data.js"></script>
       <script src="marta_bus_system.js"></script>

   What it does:
     1. BUS MODEL — stylized MARTA city bus (white + blue/green stripe),
        low-poly, matching the game's look.
     2. BUS ROUTES — 18 routes (9 route numbers x 2 directions) from real
        GTFS data. Each bus follows its route shape, stopping at every stop,
        dwelling briefly, reversing at termini.
     3. BUS STOPS — instanced sign poles at every in-map stop position.
     4. BOARDING/RIDING — walk up to a dwelling bus; the action button
        offers BOARD BUS N. Ride it; HUD shows route + next stop.
        EXIT BUS drops the player at the nearest stop.

   Design: simple sim logic (Joshua's rule). Constant-speed buses with
   eased station stops; no physics, no pathfinding.

   Integration: self-installs — polls until THREE/scene/animate exist, then
   wraps animate(). Exposes busCheckBoard/busDoBoard/busDoExit for the
   action button (hooked in index.html).
   ============================================================================ */
(function(){
'use strict';
if (window.__martaBusV1) return;
window.__martaBusV1 = true;

/* ---------------- config ---------------- */
var BUS_SPEED     = 22;    // units/sec cruising (slower than trains)
var DWELL_TIME    = 6;     // seconds stopped at each bus stop
var BUSES_PER_ROUTE = 2;
var BRAKE_DIST    = 60;    // start slowing this far from a stop
var BOARD_RANGE   = 25;    // how close player must be to board

var MB = { routes: [], buses: [], stops: [], ready: false };

/* ---------------- arc-length path ---------------- */
/* makePath(pts) — arc-length path lookup (same pattern as marta_system.js):
   binary-searched cumulative table → posAt(s)/dirAt(s). Buses advance in
   world units, so speed is constant regardless of GTFS point spacing. */
function makePath(pts){
  var cum=[0], i, dx, dz;
  for (i=1;i<pts.length;i++){
    dx=pts[i][0]-pts[i-1][0]; dz=pts[i][1]-pts[i-1][1];
    cum.push(cum[i-1]+Math.hypot(dx,dz));
  }
  var total=cum[cum.length-1];
  function segAt(s){
    s=Math.max(0,Math.min(total,s));
    var lo=0, hi=cum.length-1;
    while (lo<hi-1){ var m=(lo+hi)>>1; if (cum[m]<=s) lo=m; else hi=m; }
    return lo;
  }
  return {
    length: total,
    posAt: function(s){
      var i=segAt(s), t=(s-cum[i])/Math.max(0.001,(cum[i+1]-cum[i]));
      t=Math.max(0,Math.min(1,t));
      return [pts[i][0]+(pts[i+1][0]-pts[i][0])*t,
              pts[i][1]+(pts[i+1][1]-pts[i][1])*t];
    },
    dirAt: function(s){
      var i=segAt(s);
      var dx=pts[i+1][0]-pts[i][0], dz=pts[i+1][1]-pts[i][1];
      var l=Math.hypot(dx,dz)||1;
      return [dx/l, dz/l];
    }
  };
}

/* ---------------- material helpers ---------------- */

/* ---------------- bus stops (instanced signs) ---------------- */
/* buildStops() — instanced bus-stop signs for every in-map stop (one pole
   InstancedMesh + one sign-board InstancedMesh = 2 draw calls total). Each
   sign position is validated through SignRules.place() FIRST: any sign that
   would land in a driving lane is moved to the right shoulder of travel
   (the stop record is updated in place). Buses dwell by ARC POSITION
   (st.s), so repositioning a sign never moves where the bus stops. Poles
   get solid colliders (v2.1). Note: vehMat() and groundY() are global
   helpers from vehicle_meshes.js. */
function buildStops(){
  var allStops=[];
  MB.routes.forEach(function(r){
    var n=r.stops.length;
    r.stops.forEach(function(s, si){
      /* v2.0 SIGN PLACEMENT RULES (Joshua 2026-10-09): every bus-stop sign is
         validated against road geometry — signs in a driving lane are moved
         to the right shoulder. Buses still dwell by arc position (st.s), so
         moving the sign never affects where the bus stops. */
      try{
        if(typeof SignRules!=='undefined'){
          var pa=r.stops[Math.max(0,si-1)], pb=r.stops[Math.min(n-1,si+1)];
          var v=SignRules.place(s.x, s.z, {type:'busstop', margin:3.0,
            dir:{dx:pb.x-pa.x, dz:pb.z-pa.z}});
          s.x=v.x; s.z=v.z;
        }
      }catch(e){}
      allStops.push(s);
    });
  });
  if (!allStops.length) return;
  // instanced poles + sign boards
  var poleGeo=new THREE.BoxGeometry(0.18,3.2,0.18);
  var signGeo=new THREE.BoxGeometry(1.1,0.7,0.08);
  var poleMesh=new THREE.InstancedMesh(poleGeo, vehMat(0x707880), allStops.length);
    poleMesh.frustumCulled=false; // v1.17 FIX: InstancedMesh spans the map — r128 culls it as a tiny sphere at origin, making meshes invisible
  var signMesh=new THREE.InstancedMesh(signGeo, vehMat(0x1a5fb4), allStops.length);
    signMesh.frustumCulled=false; // v1.17 FIX: InstancedMesh spans the map — r128 culls it as a tiny sphere at origin, making meshes invisible
  var m4=new THREE.Matrix4();
  allStops.forEach(function(s,i){
    var gy=groundY(s.x,s.z);
    m4.makeTranslation(s.x, gy+1.6, s.z);
    poleMesh.setMatrixAt(i, m4);
    m4.makeTranslation(s.x, gy+3.4, s.z);
    signMesh.setMatrixAt(i, m4);
    s.gy=gy;
    MB.stops.push(s);
    try{ if(typeof addCollider==='function') addCollider(s.x, s.z, 0.35); }catch(e){}  // v2.1: solid bus-stop poles
  });
  poleMesh.instanceMatrix.needsUpdate=true;
  signMesh.instanceMatrix.needsUpdate=true;
  scene.add(poleMesh); scene.add(signMesh);
}

/* ---------------- buses ---------------- */
/* spawnBus(route, s0, dir) — one bus record {route, mesh, s (arc pos), dir,
   speed, state, dwellT, stopIdx, world x/z/yaw, nextStop}. The mesh comes
   from martaBusMesh() in vehicle_meshes.js — the CANONICAL builder shared
   with the watcher studio (never duplicate it here). */
function spawnBus(route, s0, dir){
  var mesh=martaBusMesh();
  scene.add(mesh);
  var b={ route:route, mesh:mesh, s:s0, dir:dir||1, speed:0,
          state:'run', dwellT:0, stopIdx:-1, x:0, z:0, yaw:0, nextStop:null };
  MB.buses.push(b);
  return b;
}
/* busStopIdx(b) — index of the next stop AHEAD of the bus in its travel
   direction (ds>1 skips the stop just left). -1 = none ahead (shouldn't
   happen mid-route; the terminus check below reverses before it does). */
function busStopIdx(b){
  var stops=b.route.stops, best=-1, bd=1e18, i, ds;
  for (i=0;i<stops.length;i++){
    ds=(stops[i].s-b.s)*b.dir;
    if (ds>1&&ds<bd){ bd=ds; best=i; }
  }
  return best;
}
/* updateBus(b, dt) — one bus tick. Dwell: countdown, then 'run'; at a
   TERMINUS (first/last stop in the direction of travel) the bus REVERSES
   (dir *= -1) and shuttles back — unlike trains, buses never leave the
   map. Run: ease speed toward the next stop (linear slowdown inside
   BRAKE_DIST=60u), snap + dwell 6s within 5u of a stop (toasts the stop
   name for a riding player). The path-end clamp ALSO reverses direction as
   a failsafe so a bus can never run off its shape. */
function updateBus(b, dt){
  var route=b.route;
  if (b.state==='dwell'){
    b.dwellT-=dt;
    b.speed=0;
    if (b.dwellT<=0){
      b.state='run';
      var nst=route.stops.length;
      if ((b.dir>0&&b.stopIdx===nst-1)||(b.dir<0&&b.stopIdx===0)) b.dir*=-1;
      b.stopIdx=-1;
    }
  } else {
    var ni=busStopIdx(b);
    b.nextStop=ni;
    var target=BUS_SPEED;
    if (ni>=0){
      var ds=Math.abs(route.stops[ni].s-b.s);
      if (ds<BRAKE_DIST) target=BUS_SPEED*Math.max(0,(ds-3)/BRAKE_DIST);
      if (ds<5){
        b.s=route.stops[ni].s; b.state='dwell'; b.dwellT=DWELL_TIME;
        b.stopIdx=ni; b.speed=0;
        if (player.ridingBus===b){
          showToast('Bus '+route.num+' — '+route.stops[ni].name, 2500);
        }
      }
    }
    if (b.s>=route.path.length-1||b.s<=1){
      b.s=Math.max(1,Math.min(route.path.length-1,b.s));
      if (b.state!=='dwell') b.dir*=-1;
    }
    b.speed+=(target-b.speed)*Math.min(1,dt*1.8);
    b.s+=b.dir*b.speed*dt;
    b.s=Math.max(0,Math.min(route.path.length,b.s));
  }
  var p=route.path.posAt(b.s), d=route.path.dirAt(b.s);
  if (b.dir<0){ d=[-d[0],-d[1]]; }
  b.x=p[0]; b.z=p[1];
  b.yaw=Math.atan2(d[0],d[1]);
  var y=route.roadY(b.s);
  if (typeof clampVehY==='function') y=clampVehY(b.x,b.z,y);  // v1.12: ground clamp — no sky-floaters
  b.mesh.position.set(b.x, y, b.z);
  b.mesh.rotation.y=b.yaw;
}

/* ---------------- boarding / riding ---------------- */
/* nearestDwellingBus() — closest DWELLING bus (doors open, stopIdx>=0)
   within BOARD_RANGE=25u of the player. Boarding only at a stopped bus. */
function nearestDwellingBus(){
  if (typeof player==='undefined') return null;
  var best=null, bd=1e18;
  for (var i=0;i<MB.buses.length;i++){
    var b=MB.buses[i];
    if (b.state!=='dwell'||b.stopIdx<0) continue;
    var st=b.route.stops[b.stopIdx];
    var d=Math.hypot(player.x-st.x, player.z-st.z);
    if (d<BOARD_RANGE&&d<bd){ bd=d; best=b; }
  }
  return best;
}
/* busCheckBoard() — universal action-button hook (called from
   updateActionButton() in index.html). Returns {act:'board-bus', label,
   bus} when a dwelling bus is in range, {act:'exit-bus'} when riding, else
   null. Guarded: no boarding while driving, inside a building, or on a
   train (one ride at a time). */
window.busCheckBoard=function(){
  if (typeof player==='undefined'||car.driving) return null;
  if (player.ridingBus){
    return { act:'exit-bus', label:'EXIT BUS' };
  }
  if (player.inside||player.ridingTrain) return null;
  var b=nearestDwellingBus();
  if (b) return { act:'board-bus', label:'BOARD BUS '+b.route.num, bus:b };
  return null;
};
/* busDoBoard() — action-button handler: stages the nearest dwelling bus in
   window.__busPendingBus; the frame loop boards it next tick (only while
   it's still dwelling — a bus that left during the click is ignored). */
window.busDoBoard=function(){
  var b=nearestDwellingBus();
  if (!b) return;
  window.__busPendingBus=b;
};
/* doBoardBus(b) — boards: sets player.ridingBus, hides the player mesh,
   toasts the route. */
function doBoardBus(b){
  player.ridingBus=b;
  try{ player.mesh.visible=false; }catch(e){}
  showToast('Riding Bus '+b.route.num+' — '+b.route.name, 2200);
  try{ Report.note('bus-board',{route:b.route.num}); }catch(e){}
}
/* busDoExit() — action-button handler: drops the player at the nearest stop
   on the current route (+4u offset, terrain height), restores the player
   mesh. Falls back to beside the bus if no stop record exists. */
window.busDoExit=function(){
  var b=player.ridingBus;
  if (!b) return;
  var best=null, bd=1e18, i, st;
  for (i=0;i<b.route.stops.length;i++){
    st=b.route.stops[i];
    var d=Math.abs(st.s-b.s);
    if (d<bd){ bd=d; best=st; }
  }
  if (best){
    player.x=best.x+4; player.z=best.z+4;
    try{ player.mesh.position.y=(best.gy||groundY(best.x,best.z)); }catch(e){}
  } else {
    player.x=b.x+5; player.z=b.z+5;
  }
  player.ridingBus=null;
  try{ player.mesh.visible=true; }catch(e){}
  showToast(best?best.name:'', 2000);
  try{ Report.note('bus-exit',{stop:best?best.name:'?'}); }catch(e){}
};
/* updateRiding(dt) — while the player rides: position follows the bus
   (+1.0u up on the bus mesh); HUD mode tag shows "BUS <num> — Next: <stop>"
   (or "END OF LINE", or "doors open" while dwelling). */
function updateRiding(dt){
  var b=player.ridingBus;
  if (!b) return;
  player.x=b.x; player.z=b.z;
  try{ player.mesh.position.set(b.x, b.mesh.position.y+1.0, b.z); }catch(e){}
  var nx='END OF LINE';
  if (b.nextStop>=0&&b.route.stops[b.nextStop]) nx=b.route.stops[b.nextStop].name;
  else if (b.state==='dwell'&&b.stopIdx>=0) nx=b.route.stops[b.stopIdx].name+' (doors open)';
  var want='BUS '+b.route.num+' — Next: '+nx;
  try{
    var mt=document.getElementById('mode-tag');
    if (mt&&mt.textContent!==want) mt.textContent=want;
  }catch(e){}
}

/* ---------------- init ---------------- */
/* initBus() — builds every route from MARTA_BUS_DATA: arc-length path, per-
   stop arc positions (coarse-then-fine nearest-path search; outlier stops
   >40u off the path are SNAPPED onto the path so bus and sign agree),
   stops sorted by arc position (buses visit in path order), and a smoothed
   roadY(s) terrain-height function (3 smoothing passes — the bus never
   bounces on terrain noise). Then builds all stop signs (SignRules
   validated), spawns 2 buses per route spaced half a path apart, publishes
   the sign audit, and exposes window.MARTA_BUS. */
/* ============================================================================
   BUS ROUTE TESTER FIX (v1.15, 2026-10-09):
   Trim bus routes to the in-map portion. Real GTFS data extends beyond the
   game border (e.g. Route 55 to Forest Park, Route 2 to Candler Park). Without
   trimming, buses drive through empty terrain outside the road network.
   
   trimRouteToMap(pts) finds the longest contiguous run of points within the
   playable map bounds and returns the trimmed array. Buses then shuttle on
   the in-map portion only, reversing at the trimmed termini.
   
   Map bounds derived from road network extent: X [-200, 8200], Z [-200, 12200].
   A point is "in-map" if within these bounds with a 50u margin.
   ============================================================================ */
var BUS_MAP_X0=-250, BUS_MAP_X1=8250, BUS_MAP_Z0=-250, BUS_MAP_Z1=12250;

function busPtInMap(x, z){
  return x>=BUS_MAP_X0 && x<=BUS_MAP_X1 && z>=BUS_MAP_Z0 && z<=BUS_MAP_Z1;
}

function trimRouteToMap(pts){
  if (!pts || pts.length<2) return pts;
  // Find all in-map runs
  var bestStart=0, bestLen=0, curStart=-1, curLen=0;
  for (var i=0;i<pts.length;i++){
    if (busPtInMap(pts[i][0], pts[i][1])){
      if (curStart<0){ curStart=i; curLen=0; }
      curLen++;
      if (curLen>bestLen){ bestLen=curLen; bestStart=curStart; }
    } else {
      curStart=-1; curLen=0;
    }
  }
  // If no in-map points or all in-map, return as-is
  if (bestLen===0) return pts.slice(0,2); // degenerate: keep 2 pts to avoid crash
  if (bestLen===pts.length) return pts;
  // Return the longest in-map run
  return pts.slice(bestStart, bestStart+bestLen);
}

function initBus(){
  if (!window.MARTA_BUS_DATA) throw new Error('MARTA_BUS_DATA missing');
  var D=window.MARTA_BUS_DATA, ri;
  for (ri=0;ri<D.routes.length;ri++){
    var R=D.routes[ri];
    // v1.15: trim to in-map portion before building path (bus route tester fix)
    var trimmedPts=trimRouteToMap(R.pts);
    var route={ id:R.id, num:R.num, name:R.name, color:R.color,
                headway:R.headway, stops:[], path:makePath(trimmedPts) };
    // compute arc position for each stop (nearest point on path)
    // outlier stops (>40u from path) get snapped to the path so the
    // bus actually stops where the sign is
    R.stops.forEach(function(s){
      var bestS=0, bd=1e18, bp=null;
      // coarse search then refine
      var step=Math.max(1,Math.floor(route.path.length/200));
      for (var ss=0;ss<=route.path.length;ss+=step){
        var p=route.path.posAt(ss);
        var d=Math.hypot(p[0]-s.x,p[1]-s.z);
        if (d<bd){ bd=d; bestS=ss; bp=p; }
      }
      var sx=s.x, sz=s.z;
      if (bd>40&&bp){ sx=bp[0]; sz=bp[1]; } // snap to path
      route.stops.push({name:s.name, x:sx, z:sz, s:bestS, gy:groundY(sx,sz)});
    });
    // sort stops by arc position so buses visit them in path order
    route.stops.sort(function(a,b2){ return a.s-b2.s; });
    // road height function (buses drive on roads at terrain height)
    var n=Math.floor(route.path.length/10);
    var ys=[];
    for (var i=0;i<=n;i++){ var pp=route.path.posAt(i*10); ys.push(groundY(pp[0],pp[1])); }
    for (var k=0;k<3;k++){
      var ys2=ys.slice();
      for (i=1;i<n;i++) ys2[i]=(ys[i-1]+ys[i]*2+ys[i+1])/4;
      ys=ys2;
    }
    route.roadY=function(s){
      var f=Math.max(0,Math.min(n, s/10)), i0=Math.floor(f), t=f-i0;
      if (i0>=n) return ys[n];
      return ys[i0]+(ys[i0+1]-ys[i0])*t;
    };
    MB.routes.push(route);
  }
  buildStops();
  // spawn buses: 2 per route, spaced half apart
  MB.routes.forEach(function(route){
    var half=route.path.length/2;
    spawnBus(route, route.path.length*0.1, 1);
    spawnBus(route, route.path.length*0.1+half, -1);
  });
  MB.ready=true;
  /* v2.0 SIGN PLACEMENT RULES: publish the load-time sign audit */
  try{ if(typeof SignRules!=='undefined') SignRules.publish(); }catch(e){}
  try{ Report.setSys('martabus',{status:'ok',version:'1.0',
    routes:MB.routes.length, buses:MB.buses.length, stops:MB.stops.length,
    note:'MARTA buses: real routes + rideable'}); }catch(e){}
  window.MARTA_BUS=MB;
}
/* updateBusSys() — frame tick: steps all 40 buses, updates a riding player,
   processes the pending board action. dt clamped to 60ms. Self-installed:
   wraps the global animate() once world deps (THREE/scene/animate/
   MARTA_BUS_DATA/heightAt) exist; boot gives up after 60s without breaking
   the game. */
var _lastT=0;
function updateBusSys(){
  if (!MB.ready) return;
  var now;
  try{ now=performance.now(); }catch(e){ now=0; }
  var dt=_lastT?Math.min(0.06,(now-_lastT)/1000):0.016;
  _lastT=now;
  var i;
  for (i=0;i<MB.buses.length;i++) updateBus(MB.buses[i], dt);
  if (typeof player!=='undefined'&&player.ridingBus) updateRiding(dt);
  if (window.__busPendingBus){
    var b=window.__busPendingBus; window.__busPendingBus=null;
    if (b.state==='dwell') doBoardBus(b);
  }
}
var _bootTries=0;
var _bootTimer=setInterval(function(){
  _bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined'&&typeof scene!=='undefined'&&
      typeof animate==='function'&&typeof MARTA_BUS_DATA!=='undefined'&&
      typeof heightAt==='function');
  }catch(e){ ready=false; }
  if (ready){
    try{ initBus(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('martabus','init failed',String(e&&e.message||e)); }catch(x){}
    }
    try{
      if (typeof animate==='function'&&!animate.__busWrap){
        var orig=animate;
        var wrapped=function(){ orig(); updateBusSys(); };
        wrapped.__busWrap=true;
        animate=wrapped;
      }
    }catch(e){}
    clearInterval(_bootTimer);
  } else if (_bootTries>240){
    clearInterval(_bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('martabus','boot-timeout','deps never ready'); }catch(e){}
  }
},250);
})();
