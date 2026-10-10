/* ============================================================================
   FILE: semi_system.js — "Surviving Adamsville" semi / delivery trucks
   ----------------------------------------------------------------------------
   PURPOSE: 18-wheeler delivery sim on a VERIFIED fixed route — no
   pathfinding needed. Semis run I-20 ↔ Fulton Industrial Blvd ↔ 7 real-world
   warehouses, then despawn "out of town" at the border portal; a spawn timer
   keeps ~5 active (new ones enter at the border as if "coming back from out
   of town" — the same vanish/respawn pattern the MARTA trains use).
   KEY SYSTEMS:
     - Route: I-20 east border portal (segT=49) → west to the Fulton
       Industrial interchange (segT=5397) → FIB (interchange segT=5027) →
       the warehouse's road point (per-warehouse verified fibT) → direct
       off-road hop to the loading dock, load 15-35s → back to FIB → I-20
       east to the portal → despawn. State machine: i20_in / fib_out /
       to_dock / loading / to_fib / fib_back / i20_out.
     - Right-lane discipline: LANE_OFF=3.5u; on +t travel the heading is the
       path tangent, on -t travel it's flipped 180° so the cab always faces
       its direction of motion.
     - The semi mesh comes from semiMesh() in vehicle_meshes.js — the
       CANONICAL builder (US left-hand drive, shared with the watcher).
       Never duplicate it here.
     - VEHICLE_TYPES registration ('semi'): keeps the vehicle registry
       consistent — semis are NEVER offered as drivable; the delivery sim
       owns them.
     - Anti-stuck watchdog: a semi in a road state whose speed stays ≤3 u/s
       for 30s is despawned (stuckT resets whenever speed >3 u/s; dock/loading
       states aren't watched).
   JOSHUA SPECS ENCODED:
     - Simple sim logic: fixed verified route, no pathfinding.
     - Warehouses at verified real-world positions along the Fulton
       Industrial corridor (buildings themselves live in osm_buildings.js).
     - Left-hand drive (US) for all vehicles.
   ============================================================================ */
/* ============================================================================
   SURVIVING ADAMSVILLE — SEMI / DELIVERY SYSTEM (v1.1)
   ----------------------------------------------------------------------------
   STANDALONE MODULE. Include AFTER the main game script — zero edits to
   index.html required:

       <script src="semi_system.js"></script>

   What it does:
     1. WAREHOUSES — 7 distribution warehouses along the Fulton Industrial
        corridor at verified real-world positions (buildings themselves live
        in osm_buildings.js as type 3; this module owns names + dock spots).
     2. 18-WHEELERS — stylized low-poly semi trucks (cab + trailer, US
        left-hand drive) running simple delivery loops on a VERIFIED route:
          I-20 east border portal
            -> west on I-20 to the Fulton Industrial interchange
            -> Fulton Industrial Blvd to the warehouse's road point
            -> short hop to the loading dock, pause (loading)
            -> back to Fulton Industrial, back to I-20
            -> east on I-20 to the border portal -> despawn ("out of town")
        A spawn timer keeps ~5 semis active; new ones appear at the border
        as if "coming back from out of town".
     3. Registers 'semi' in VEHICLE_TYPES for consistency with the car
        registry (never offered as drivable; the delivery sim owns them).

   Design: simple sim logic (Joshua's rule). Fixed verified route — no
   pathfinding needed. An anti-stuck watchdog despawns any semi that
   stalls for 30s.

   Integration: self-installs — polls until roadDrawData/scene/animate
   exist, then wraps animate() so updateSemis() runs every frame.
   ============================================================================ */
(function(){
'use strict';
if (window.__semiV11) return;
window.__semiV11 = true;

/* ---------------- config ---------------- */
var N_SEMIS      = 5;     // target active semis (spawn timer tops up)
var SPAWN_MIN    = 8;     // spawn check interval range (seconds)
var SPAWN_MAX    = 16;
var LOAD_MIN     = 15;    // dock loading pause range (seconds)
var LOAD_MAX     = 35;
var ARRIVE_DOCK  = 22;    // within this many units = "arrived" at dock/road
var STUCK_AFTER  = 30;    // despawn a semi stalled this long in a road state
var SEMI_SPEED   = 20;    // cruise speed u/s
var LANE_OFF     = 3.5;   // right-lane offset

/* Warehouses — verified real-world positions. [name, x, z, w, d, fibSegT]
   fibSegT = arc position on Fulton Industrial Blvd SW nearest the warehouse
   (verified from road data). */
var WAREHOUSES=[
  {name:'Fulton Industrial Distribution', x:1941, z:3651, w:120, d:80,  fibT:6520},
  {name:'Southwest Beverage Depot',       x:2277, z:3445, w:110, d:70,  fibT:6119},
  {name:'Fulton Warehouse Terminal',      x:1566, z:3875, w:130, d:90,  fibT:2203},
  {name:'Westlake Freight Hub',           x:1340, z:4628, w:140, d:80,  fibT:7765},
  {name:'Westpark Logistics',             x:2080, z:3814, w:100, d:70,  fibT:6650},
  {name:'Cold Storage Depot',             x:888,  z:4373, w:90,  d:70,  fibT:1470},
  {name:'Skygate Cold Storage',           x:637,  z:5025, w:120, d:80,  fibT:8522}
];
/* Verified route constants (from road data):
   I-20 seg0: portal segT=49 -> interchange segT=5397
   FIB: interchange segT=5027 */
var I20_PORTAL_T=49, I20_X_T=5397, FIB_X_T=5027;

var SE=null;
var _v=null,_q=null,_e=null,_m=null,_ONE=null;
function makeTemps(){
  _v=new THREE.Vector3(); _q=new THREE.Quaternion();
  _e=new THREE.Euler();   _m=new THREE.Matrix4();
  _ONE=new THREE.Vector3(1,1,1);
}

/* ---------------- semi mesh (stylized, LHD) ---------------- */
try{
  if (typeof VEHICLE_TYPES!=='undefined' && !VEHICLE_TYPES.semi){
    VEHICLE_TYPES.semi={mesh:function(p,r){return semiMesh();},
      eyeH:2.6, lookH:2.2, driverX:0.62, cockpitH:0, oldCockpit:false,
      halfL:9.5, halfW:1.5, label:'semi (18-wheeler)'};
  }
}catch(e){}

/* arcTable(pts) — cumulative arc-length table for a road polyline; the twin
   of buildRoadIndex's table in traffic_system.js (kept local so this module
   stays standalone). s.t moves in world units along the table. */
function arcTable(pts){
  var cum=[0];
  for (var i=1;i<pts.length;i++)
    cum.push(cum[i-1]+Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]));
  return cum;
}
/* findRoad(name, longest) — finds a road by its exact name (e.g. 'I- 20' —
   note the data's label spelling); with longest=true, takes the longest
   matching polyline (I-20 and FIB both have multiple records). */
function findRoad(name, longest){
  var best=null;
  for (var i=0;i<roadDrawData.length;i++){
    var r=roadDrawData[i];
    if (!r||r.name!==name||!r.pts||r.pts.length<2) continue;
    if (!best || (longest && r.pts.length>best.pts.length)) best=r;
  }
  return best;
}
/* roadPoint(R, cum, t, off) — position + heading at arc position t on road R
   with a right-of-travel lane offset. The "right of +t direction" is
   (cos(hd), -sin(hd)) of the tangent heading; callers traveling -t flip the
   returned heading by PI. Binary-searches the arc table; t is clamped to
   [0, R.len]. */
function roadPoint(R, cum, t, off){
  t=Math.max(0,Math.min(R.len,t));
  var pts=R.pts, ys=R.ys, lo=0, hi=cum.length-2;
  if (t<=0) lo=0; else if (t>=R.len) lo=hi;
  else { while(lo<hi){ var mid=(lo+hi)>>1;
    if (cum[mid+1]<t) lo=mid+1; else hi=mid; } }
  var p0=pts[lo], p1=pts[lo+1];
  var dx=p1[0]-p0[0], dz=p1[1]-p0[1];
  var segL=cum[lo+1]-cum[lo]||1, f=(t-cum[lo])/segL;
  // heading for direction of travel (+1 = increasing t)
  var hd=Math.atan2(dx,dz);
  var x=p0[0]+dx*f, z=p0[1]+dz*f;
  var y=ys[lo]+(ys[lo+1]-ys[lo])*f;
  var rx=Math.cos(hd), rz=-Math.sin(hd); // right of +t direction
  var px=x+rx*off, pz=z+rz*off;
  y=(typeof clampVehY==='function')?clampVehY(px,pz,y+0.06):y+0.06;  // v1.12: ground clamp — no sky-floaters
  return {x:px, z:pz, y:y, heading:hd};
}

/* ---------------- semi entities ---------------- */
/* dockSpot(wh) — the loading dock point for a warehouse: from the road
   point at wh.fibT, pushed (warehouse half-extent + 18u) toward the
   warehouse on the FIB-facing side — far enough out that the semi doesn't
   clip the building. */
function dockSpot(wh){
  // dock on the FIB-facing side of the warehouse
  var fp=roadPoint(SE.fib, SE.fibCum, wh.fibT, 0);
  var dx=fp.x-wh.x, dz=fp.z-wh.z, d=Math.hypot(dx,dz)||1;
  var stand=Math.max(wh.w,wh.d)/2+18;
  return {x:wh.x+dx/d*stand, z:wh.z+dz/d*stand};
}
/* spawnSemi() — one delivery run: picks a random warehouse, builds the
   canonical semi mesh, starts at the I-20 portal (state 'i20_in') heading
   west at speed 0 (accelerates up to SEMI_SPEED). */
function spawnSemi(){
  var wh=WAREHOUSES[(SE.rng()*WAREHOUSES.length)|0];
  var mesh=semiMesh();
  scene.add(mesh);
  var s={wh:wh, dock:dockSpot(wh), state:'i20_in',
    t:I20_PORTAL_T, dir:1, speed:0,
    x:0,z:0,y:0,heading:0, loadT:0, stuckT:0, lastD:1e18,
    mesh:mesh, wheelA:SE.rng()*6.28};
  SE.semis.push(s);
  return s;
}
/* despawnSemi(si) — removes the mesh from the scene and the record from
   SE.semis (the run is over — it "left town" at the portal, or the
   anti-stuck watchdog fired). */
function despawnSemi(si){
  var s=SE.semis[si];
  try{ scene.remove(s.mesh); }catch(e){}
  SE.semis.splice(si,1);
}
/* driveDirect(s, tx, tz, dt, maxSpeed) — steers the semi straight at a point
   (used for the off-road dock/FIB hops — no road geometry there). Turn rate
   is capped at 1.4 rad/s, and target speed scales with remaining distance
   (max 4 u/s minimum) so the semi decelerates into the dock instead of
   overshooting. Returns the remaining distance. */
function driveDirect(s, tx, tz, dt, maxSpeed){
  var dx=tx-s.x, dz=tz-s.z, d=Math.hypot(dx,dz);
  var wantHd=Math.atan2(dx,dz), dh=wantHd-s.heading;
  while (dh>Math.PI) dh-=Math.PI*2;
  while (dh<-Math.PI) dh+=Math.PI*2;
  s.heading+=Math.max(-1.4*dt,Math.min(1.4*dt,dh));
  var want=Math.min(maxSpeed, Math.max(4, d*0.5));
  s.speed+=(want-s.speed)*Math.min(1,3*dt);
  s.x+=Math.sin(s.heading)*s.speed*dt;
  s.z+=Math.cos(s.heading)*s.speed*dt;
  try{ s.y=(typeof clampVehY==='function')?clampVehY(s.x,s.z,heightAt(s.x,s.z)+0.06):heightAt(s.x,s.z)+0.06; }catch(e){}  // v1.12 ground clamp
  return d;
}
/* stepSemi(s,dt) — one delivery tick. State machine:
     i20_in: west on I-20 (portal → interchange), accelerating to SEMI_SPEED.
     fib_out: FIB interchange → the warehouse's fibT (either direction).
     to_dock: off-road steer to the dock; arrived (<22u) → 'loading'.
     loading: parked 15-35s, then 'to_fib'.
     to_fib: off-road steer back to the FIB road point; arrived → 'fib_back'.
     fib_back: FIB → the interchange.
     i20_out: east on I-20 (interchange → portal); reaching the portal
       returns done=true → despawned ("out of town").
   Anti-stuck watchdog (road states only): speed ≤3 u/s for 30s returns
   done=true → despawned. Dock/loading states aren't watched (a parked semi
   isn't stuck). Returns done (true = remove this semi). */
function stepSemi(s,dt){
  var done=false;
  if (s.state==='i20_in'){
    // west on I-20: portal -> interchange
    s.t+=s.speed*dt; s.speed=Math.min(SEMI_SPEED,s.speed+8*dt);
    if (s.t>=I20_X_T){ s.state='fib_out'; s.t=FIB_X_T; }
    else { var p=roadPoint(SE.i20,SE.i20Cum,s.t,LANE_OFF);
      s.x=p.x;s.z=p.z;s.y=p.y;s.heading=p.heading; }
  } else if (s.state==='fib_out'){
    // FIB interchange -> warehouse road point
    var target=s.wh.fibT;
    var dir=target>s.t?1:-1;
    s.t+=dir*Math.min(SEMI_SPEED,s.speed+8*dt)*dt;
    s.speed=Math.min(SEMI_SPEED,s.speed+8*dt);
    if ((dir>0&&s.t>=target)||(dir<0&&s.t<=target)){ s.state='to_dock'; }
    else { var p2=roadPoint(SE.fib,SE.fibCum,s.t,dir>0?LANE_OFF:-LANE_OFF);
      s.x=p2.x;s.z=p2.z;s.y=p2.y;s.heading=dir>0?p2.heading:p2.heading+Math.PI; }
  } else if (s.state==='to_dock'){
    var d=driveDirect(s,s.dock.x,s.dock.z,dt,SEMI_SPEED*0.5);
    if (d<ARRIVE_DOCK){
      s.state='loading'; s.loadT=LOAD_MIN+SE.rng()*(LOAD_MAX-LOAD_MIN); s.speed=0;
    }
  } else if (s.state==='loading'){
    s.loadT-=dt; s.speed=0;
    if (s.loadT<=0){ s.state='to_fib'; }
  } else if (s.state==='to_fib'){
    var fp=roadPoint(SE.fib,SE.fibCum,s.wh.fibT,0);
    var d2=driveDirect(s,fp.x,fp.z,dt,SEMI_SPEED*0.5);
    if (d2<ARRIVE_DOCK){ s.state='fib_back'; s.t=s.wh.fibT; }
  } else if (s.state==='fib_back'){
    // FIB -> interchange
    var dir2=FIB_X_T>s.t?1:-1;
    s.t+=dir2*Math.min(SEMI_SPEED,s.speed+8*dt)*dt;
    s.speed=Math.min(SEMI_SPEED,s.speed+8*dt);
    if ((dir2>0&&s.t>=FIB_X_T)||(dir2<0&&s.t<=FIB_X_T)){ s.state='i20_out'; s.t=I20_X_T; }
    else { var p3=roadPoint(SE.fib,SE.fibCum,s.t,dir2>0?LANE_OFF:-LANE_OFF);
      s.x=p3.x;s.z=p3.z;s.y=p3.y;s.heading=dir2>0?p3.heading:p3.heading+Math.PI; }
  } else if (s.state==='i20_out'){
    // east on I-20: interchange -> portal, then despawn
    s.t-=Math.min(SEMI_SPEED,s.speed+8*dt)*dt;
    s.speed=Math.min(SEMI_SPEED,s.speed+8*dt);
    if (s.t<=I20_PORTAL_T){ done=true; }
    else { var p4=roadPoint(SE.i20,SE.i20Cum,s.t,-LANE_OFF);
      s.x=p4.x;s.z=p4.z;s.y=p4.y;s.heading=p4.heading+Math.PI; }
  }
  // stuck watchdog (only for road states)
  if (!done && (s.state==='i20_in'||s.state==='fib_out'||s.state==='fib_back'||s.state==='i20_out')){
    s.stuckT+=dt;
    if (s.stuckT>STUCK_AFTER) done=true;
    else if (s.speed>3) s.stuckT=0;
  } else if (!done){ s.stuckT=0; }
  return done;
}
/* renderSemi(s,dt) — writes the semi mesh transform; spins the wheels from
   distance driven (wheelA += speed*dt / wheelRadius 0.55). */
function renderSemi(s,dt){
  var m=s.mesh;
  m.position.set(s.x,s.y,s.z);
  m.rotation.y=s.heading;
  s.wheelA=(s.wheelA+s.speed*dt/0.55)%(Math.PI*2);
  var ws=m.userData.wheels||[];
  for (var i=0;i<ws.length;i++) ws[i].rotation.x=s.wheelA;
}

/* ---------------- public update ---------------- */
/* updateSemis(dt) — frame tick: the spawn timer (every 8-16s) tops the fleet
   back up to 5; each semi steps (done → despawned); Report publishes every
   5s. dt falls back to performance.now() clamped to 50ms. Never throws. */
var _lastT=0;
function updateSemis(dt){
  if (!SE) return;
  try{
    if (dt===undefined||dt===null){
      var now=(typeof performance!=='undefined'?performance.now():Date.now());
      dt=_lastT>0?Math.min(0.05,(now-_lastT)/1000):1/60; _lastT=now;
    }
    SE.spawnT-=dt;
    if (SE.spawnT<=0){
      SE.spawnT=SPAWN_MIN+SE.rng()*(SPAWN_MAX-SPAWN_MIN);
      if (SE.semis.length<N_SEMIS) spawnSemi();
    }
    for (var i=SE.semis.length-1;i>=0;i--){
      var s=SE.semis[i];
      if (stepSemi(s,dt)){ despawnSemi(i); continue; }
      renderSemi(s,dt);
    }
    SE.repT-=dt;
    if (SE.repT<=0){
      try{ Report.setSys('semis',{status:'ok',version:'1.1',
        active:SE.semis.length, warehouses:WAREHOUSES.length}); }catch(e){}
      SE.repT=5;
    }
  }catch(e){}
}
window.updateSemis=updateSemis;
window.SEMI_WAREHOUSES=WAREHOUSES;

/* ---------------- init + self-install ---------------- */
/* initSemis() — resolves the two route roads by name ('I- 20' longest record,
   'Fulton Industrial Blvd SW' longest record), builds their arc tables, and
   seeds 3 semis already en route (one inbound on I-20, one on FIB, one
   halfway down I-20) so the map isn't empty at load. Wraps the global
   animate() so updateSemis() runs every frame; boot waits for world deps
   and gives up after 60s without breaking the game. */
function initSemis(){
  SE={semis:[], rng:mulberry32(0x5EED01), spawnT:2, repT:0};
  makeTemps();
  SE.i20=findRoad('I- 20', true);
  SE.fib=findRoad('Fulton Industrial Blvd SW', true);
  if (!SE.i20||!SE.fib) throw new Error('route roads missing');
  SE.i20Cum=arcTable(SE.i20.pts);
  SE.i20.len=SE.i20Cum[SE.i20Cum.length-1];
  SE.fibCum=arcTable(SE.fib.pts);
  SE.fib.len=SE.fibCum[SE.fibCum.length-1];
  // seed 3 semis already en route
  for (var i=0;i<3;i++){
    var s=spawnSemi();
    // stagger: advance some partway along the inbound leg
    if (i===1){ s.state='fib_out'; s.t=FIB_X_T; }
    if (i===2){ s.state='i20_in'; s.t=(I20_PORTAL_T+I20_X_T)/2; }
  }
  try{
    if (typeof animate==='function'&&!animate.__semiWrap){
      var orig=animate;
      var wrapped=function(){ orig(); updateSemis(); };
      wrapped.__semiWrap=true;
      animate=wrapped;
    }
  }catch(e){}
  try{ Report.setSys('semis',{status:'ok',version:'1.1',
    active:SE.semis.length, warehouses:WAREHOUSES.length,
    note:'delivery semis: I-20 <-> Fulton Industrial warehouses'}); }catch(e){}
  window.SEMIS=SE;
}
var bootTries=0;
var bootTimer=setInterval(function(){
  bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined'&&typeof scene!=='undefined'&&
      typeof roadDrawData!=='undefined'&&roadDrawData.length>100&&
      typeof animate==='function');
  }catch(e){ ready=false; }
  if (ready){
    try{ initSemis(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('semis','init failed',String(e&&e.message||e)); }catch(x){}
    }
    clearInterval(bootTimer);
  } else if (bootTries>240){
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('semis','boot-timeout','deps never ready'); }catch(e){}
  }
},250);

})();
