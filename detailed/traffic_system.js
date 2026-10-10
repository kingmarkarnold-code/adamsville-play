/* ============================================================================
   FILE: traffic_system.js — "Surviving Adamsville" AI traffic
   ----------------------------------------------------------------------------
   PURPOSE: Ambient AI traffic vehicles driving the highway/arterial/local
   road network, plus real-world gas stations with NPC refueling.
   KEY SYSTEMS:
     - Road index (arc-length tables) + endpoint connection grid — cars hop
       onto connecting roads at junctions or loop when a road dead-ends.
     - Car state machine: drive / toGas / refueling / backToRoad / pulling /
       parked / resuming — 35% of cars are "owned" NPC cars that pull over,
       park on the shoulder, and resume.
     - Streaming InstancedMesh renderer: only the <=40 nearest cars within
       ~350u get geometry (3 draw calls total). Distant cars stay data-only.
     - Joshua's live road audit: a car trying to move but at ~0 speed for
       >5s logs a "stuck spot" to TRAFFIC.stuckSpots (surfaced in the Report
       panel) so broken road geometry gets flagged for fixing.
     - Gas stations: ~109 REAL OSM fuel-station positions, 6 draw calls for
       all stations, drivable lots, per-object colliders (no station-wide
       invisible wall). NPCs refuel when fuel < FUEL_LOW.
     - Self-install: polls until world deps exist, then wraps the global
       animate() so updateTraffic() runs every frame. Never breaks the frame
       (all hot-path calls guarded).
   JOSHUA SPECS ENCODED:
     - Stuck-spot audit (his live road audit rule: >5s at ~0 speed = bad spot).
     - Gas stations at real OSM positions; fictitious display brands only
       (trademark avoidance — never real brand names in game).
     - Drivable cars live in v1.6 `cars[]`; traffic cars are NEVER drivable.
     - Joshua's ground truth (v1.14): gas station on Fairburn Rd just north
       of MLK Jr Dr, WEST side (left heading north).
   ============================================================================ */
/* ============================================================================
   SURVIVING ADAMSVILLE — TRAFFIC SYSTEM (v1.12)
   ----------------------------------------------------------------------------
   STANDALONE MODULE. Include AFTER the main game script — zero edits to
   index.html required:

       <script src="traffic_system.js"></script>

   What it does:
     1. HIGHWAY TRAFFIC  — moving cars on I-285/I-20/I-85/I-75, both directions,
        following real roadDrawData paths, right-hand lane discipline.
     2. ARTERIAL TRAFFIC — lighter, slower traffic on arterial roads.
     3. GAS STATIONS     — REAL OSM fuel-station positions (~109, deduped),
        fully instanced (6 draw calls), drivable lots, per-object colliders.
        NPC cars refuel at pumps when low (simple sim).
     4. NPC DRIVERS      — a share of cars are "owned": they occasionally pull
        over to the shoulder, sit parked a while, then resume. Simple spacing
        so cars don't drive through each other or the player.
     5. STUCK-SPOT LOG   — Joshua's live road audit: a car trying to move but
        at ~0 speed for >5s logs {x,z,road,t} to TRAFFIC.stuckSpots, exposed
        via Report.setSys('traffic', ...).
     6. STREAMING        — distant cars are DATA ONLY. InstancedMesh geometry
        (3 draw calls total) is assigned only to the <=25 nearest cars within
        ~200u of the player. No per-frame allocations in the hot loop.

   The 8 existing driveway parked cars (v1.6, in `cars[]`) are untouched —
   traffic cars live in their own TRAFFIC.cars array and are never offered
   as drivable.

   Integration: the module self-installs — it polls until roadDrawData/scene/
   player/animate exist, then wraps the global animate() so updateTraffic()
   runs every frame. window.updateTraffic(dt, px, pz) is also exposed for
   explicit wiring if a future build prefers a manual hook.
   ============================================================================ */
(function(){
'use strict';
if (window.__trafficV19) return;          // never double-load
window.__trafficV19 = true;

/* ---------------- config ---------------- */
var MAX_RENDERED   = 40;      // rendered vehicle cap (raised v1.13: local traffic)
var STREAM_DIST    = 350;     // geometry only within this many units (raised v1.13)
var STREAM_DIST2   = STREAM_DIST*STREAM_DIST;
var RELEASE_DIST   = 420;     // hysteresis is handled by 0.3s reassign cadence
var MIN_ROAD_LEN   = 120;     // roads shorter than this get no traffic
var STUCK_AFTER_S  = 5;       // "speed ~0 while trying" seconds before logging
var STUCK_COOLDOWN = 25;      // seconds before the same car can log again
var STUCK_MAX      = 200;     // cap the audit array
var N_HW_CARS      = 44, N_ART_CARS = 28, N_LOCAL_CARS = 24;
var N_LOCAL_NEAR   = 12;      // v1.13: extra cars spawned on local roads near player start
var LOCAL_NEAR_RADIUS = 1200; // v1.13: radius around player start for near-spawn
var ACCEL_US = 8, BRAKE_US = 22;   // u/s^2 — gentle 90s-sedan feel

// 90s paint palette (fictitious world — colors only, no branding)
var PAINTS=[0x7a1f1f,0x1f3a5f,0x5a5a5a,0x2e5a2e,0x8a7a3a,0x4a2e5a,
            0x2e5a5a,0xb8b8b8,0x141414,0xd8cfc0];
// FICTITIOUS fuel brands — never real trademarks. (The existing business
// namer already owns ZoomFuel/QuickFuel/etc.; this pool is deliberately
// disjoint so names never collide with it.)
var GAS_BRANDS=["PetroPal","GasNGo","TurboTank","MileMax","FillFast",
  "CruiseFuel","RocketRefuel","Octane Oasis","PistonPump","ZipZap Fuel"];
var GAS_CANOPY=[0xd23c2e,0x2e7ad2,0x2ea44c,0xe8a13c,0x7a4fd2,0x2e9aa4,
  0xc2c2c2,0x8a2e5a,0x3a6b2e,0xd27a2e];
// wheel offsets (local car space, matches sedanMesh proportions)
var WO=[[0.95,1.5],[-0.95,1.5],[0.95,-1.5],[-0.95,-1.5]];

/* ---------------- module state ---------------- */
var TR=null;   // set at init; window.TRAFFIC points at it

/* Hot-loop temps — allocated ONCE, reused every frame (no per-frame allocs). */
var _v=null,_q=null,_e=null,_m=null,_c=null,_ONE=null,_ZERO_M=null;
function makeTemps(){
  _v=new THREE.Vector3(); _q=new THREE.Quaternion();
  _e=new THREE.Euler();   _m=new THREE.Matrix4();
  _c=new THREE.Color();   _ONE=new THREE.Vector3(1,1,1);
  _ZERO_M=new THREE.Matrix4().makeScale(0,0,0);
}
function zeroSlot(s){  // hide one render slot (body+glass+4 wheels)
  TR.bodyIM.setMatrixAt(s,_ZERO_M); TR.glassIM.setMatrixAt(s,_ZERO_M);
  for (var k=0;k<4;k++) TR.wheelIM.setMatrixAt(s*4+k,_ZERO_M);
}
function tsLocal(){
  var d=new Date(), p=function(n){return (n<10?'0':'')+n;};
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+
         p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}

/* ---------------- road index ----------------
   Wraps the roadDrawData entries traffic may use (highway + arterial) with
   arc-length tables so cars advance in world units along the path. */
function buildRoadIndex(){
  var idx=[];
  for (var i=0;i<roadDrawData.length;i++){
    var r=roadDrawData[i];
    if (!r||!r.pts||r.pts.length<2||!r.ys||r.ys.length!==r.pts.length) continue;
    // v1.13: include local roads so residential areas have traffic
    if (r.cat!=='highway'&&r.cat!=='arterial'&&r.cat!=='local') continue;
    var cum=[0];
    for (var p=1;p<r.pts.length;p++){
      var dx=r.pts[p][0]-r.pts[p-1][0], dz=r.pts[p][1]-r.pts[p-1][1];
      cum.push(cum[p-1]+Math.sqrt(dx*dx+dz*dz));
    }
    var len=cum[cum.length-1];
    if (len<MIN_ROAD_LEN) continue;
    // lanes per direction: interstates carry r.lanes=5; other highways 3-4;
    // arterials are marked 2/dir in the v1.5 striping pass.
    var lpd = r.lanes>0 ? r.lanes : (r.cat==='highway' ? 4 : 2);
    idx.push({r:r, cum:cum, len:len, name:r.name||('road#'+i),
              cat:r.cat, w:r.w||10, lanesPerDir:lpd,
              laneW:(r.w||10)/(lpd*2)});
  }
  return idx;
}

/* Endpoint spatial grid — lets a car at a road end find a CONNECTED road
   (or discover there is none and loop). Built once. */
function buildEndpointGrid(roads){
  var grid={}, CELL=80;
  function key(x,z){ return Math.floor(x/CELL)+','+Math.floor(z/CELL); }
  roads.forEach(function(R,ri){
    for (var e=0;e<2;e++){
      var p=R.r.pts[e===0?0:R.r.pts.length-1];
      var k=key(p[0],p[1]);
      (grid[k]=grid[k]||[]).push({ri:ri,end:e,x:p[0],z:p[1]});
    }
  });
  return {grid:grid,cell:CELL,key:key};
}
function findConnection(ep, selfRi, selfEnd){
  // Finds a DIFFERENT road whose endpoint is within 70u of this road's end,
  // so the car can continue onto the connected road instead of looping.
  // Checks the 3x3 neighboring grid cells; excludes the car's own road end.
  var CELL=ep.cell, gx=Math.floor(ep.x0/ep.cell), gz=Math.floor(ep.z0/ep.cell);
  var best=null,bd=70*70;   // 70u snap radius
  for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
    var a=ep.grid[ix+','+iz]; if(!a) continue;
    for (var i=0;i<a.length;i++){
      var c=a[i];
      if (c.ri===selfRi&&c.end===selfEnd) continue;
      var dx=c.x-ep.x0, dz=c.z-ep.z0, d2=dx*dx+dz*dz;
      if (d2<bd){ bd=d2; best=c; }
    }
  }
  return best;
}

/* ---------------- car data ---------------- */
/* Assigns a random lane on road R. Lanes are numbered from the anatomical
   right of the direction of travel (US right-hand driving); laneTarget is
   the lateral offset the car eases toward each frame, and shoulderOff is
   where "owned" cars park when they pull over. Also clamps the car's current
   lateral offset so merges onto the new road stay inside its corridor. */
function newLane(c,R){
  c.lane=(TR.rng()*R.lanesPerDir)|0;
  c.laneOffBase=(c.lane+0.5)*R.laneW;   // anatomical-right lane center
  c.shoulderOff=R.w/2+2.5;             // pull-over spot, just off the asphalt
  // keep the merge continuous but inside the new road's corridor
  c.off=Math.max(-c.shoulderOff,Math.min(c.shoulderOff,c.off));
  if (c.state==='drive'||c.state==='resuming') c.laneTarget=c.laneOffBase;
}
/* Spawns n cars spread along the given road list, weighted by road length.
   Each car starts at 60% of its target speed (avoids a spawn burst), picks
   a random travel direction, and retries up to 8 times to find a spawn
   position at least 22u from another same-road/same-direction car. */
function spawnOn(list,n,v0,v1){
  var tot=0,i;
  for (i=0;i<list.length;i++) tot+=list[i].len;
  if (tot<=0) return;
  for (var k=0;k<n;k++){
    var pick=TR.rng()*tot, li=0;
    while (li<list.length-1 && pick>list[li].len){ pick-=list[li].len; li++; }
    var R=list[li], gi=TR.roads.indexOf(R);
    var segT=TR.rng()*R.len, dir=TR.rng()<0.5?1:-1, ok=false;
    for (var t=0;t<8&&!ok;t++){         // keep spawn spacing sane
      ok=true;
      for (i=0;i<TR.cars.length;i++){ var o=TR.cars[i];
        if (o.road===gi&&o.dir===dir&&Math.abs(o.segT-segT)<22){
          ok=false; segT=TR.rng()*R.len; break; } }
    }
    if (!ok) continue;
    var ts=v0+TR.rng()*(v1-v0);
    var c={id:TR.cars.length, x:0,z:0,y:0,heading:0, speed:ts*0.6,
      desired:ts, targetSpeed:ts, road:gi, segT:segT, dir:dir,
      lane:0, off:0, laneOffBase:0, laneTarget:0, shoulderOff:0,
      state:'drive', owned:TR.rng()<0.35,          // 35% are "owned" NPC cars
      pullT:20+TR.rng()*50, parkT:0, stuckT:0,
      fuel:65+TR.rng()*35, gasSt:null, gasSpot:null, gasLeave:null, refuelT:0,  // v1.12 fuel
      blockedByPlayer:false, blockedByBus:false, wheelA:TR.rng()*6.28, slot:-1,
      color:PAINTS[(TR.rng()*PAINTS.length)|0]};
    newLane(c,R); c.off=c.laneOffBase;
    TR.cars.push(c);
    roadPose(c);
  }
}

/* Pose: interpolate the path at segT, apply lane offset on the anatomical
   right of travel, sit on the road's own smoothed heights (ys). */
function roadPose(c){
  var R=TR.roads[c.road], pts=R.r.pts, ys=R.r.ys, cum=R.cum;
  var s=c.segT; if (s<0)s=0; if (s>R.len)s=R.len;
  var lo=0, hi=cum.length-2;               // binary search the segment
  if (s<=0) lo=0; else if (s>=R.len) lo=hi;
  else { while (lo<hi){ var mid=(lo+hi)>>1;
    if (cum[mid+1]<s) lo=mid+1; else hi=mid; } }
  var p0=pts[lo], p1=pts[lo+1];
  var dx=p1[0]-p0[0], dz=p1[1]-p0[1];
  var segL=cum[lo+1]-cum[lo]||1, f=(s-cum[lo])/segL;
  var hd=Math.atan2(dx*c.dir, dz*c.dir);   // yaw convention: fwd=(sin,cos)
  var x=p0[0]+dx*f, z=p0[1]+dz*f;
  var y=ys[lo]+(ys[lo+1]-ys[lo])*f;
  var rx=-Math.cos(hd), rz=Math.sin(hd);   // anatomical right of heading
  c.x=x+rx*c.off; c.z=z+rz*c.off;
  c.y=(typeof clampVehY==='function')?clampVehY(c.x,c.z,y+0.06):y+0.06;  // v1.12: ground clamp — no sky-floaters
  c.heading=hd;
}

/* Road end: hop onto a connected road when one exists, else loop the path.
   When a connection is found the car starts at the matching end of the new
   road (its segT and direction are re-anchored) and gets a fresh lane. */
function roadEnd(c){
  var R=TR.roads[c.road];
  var atEnd = c.dir>0 ? c.segT>=R.len : c.segT<=0;
  if (!atEnd){ c.segT=Math.max(0,Math.min(R.len,c.segT)); return; }
  var selfEnd = c.dir>0 ? 1 : 0;
  var p=R.r.pts[selfEnd===1?R.r.pts.length-1:0];
  var hit=findConnection({x0:p[0],z0:p[1],grid:TR.ep.grid,cell:TR.ep.cell},c.road,selfEnd);
  if (hit){
    var NR=TR.roads[hit.ri];
    c.road=hit.ri;
    c.segT = hit.end===1 ? NR.len : 0;
    c.dir  = hit.end===1 ? -1 : 1;
    newLane(c,NR);
  } else {
    c.segT = c.dir>0 ? 0 : R.len;          // loop: teleport to the far end
  }
  roadPose(c);
}

/* Joshua's live road audit: a car TRYING to move but at ~0 speed for >5s
   (and NOT simply yielding to the player) names a bad road spot. */
function logStuck(c){
  var R=TR.roads[c.road];
  for (var i=0;i<TR.stuckSpots.length;i++){
    var s=TR.stuckSpots[i], dx=s.x-c.x, dz=s.z-c.z;
    if (dx*dx+dz*dz<2500) return;          // already logged nearby — no spam
  }
  TR.stuckSpots.push({x:Math.round(c.x), z:Math.round(c.z),
    road:R?R.name:'?', t:tsLocal()});
  if (TR.stuckSpots.length>STUCK_MAX) TR.stuckSpots.shift();
  /* v1.15 (StuckDiag): attach the root-cause data diagnosis to the stuck
     spot — Joshua's live road audit now says WHY, not just WHERE. The
     registry also learns the spot (persistent across sessions). */
  try{
    if (typeof StuckDiag!=='undefined' && StuckDiag.suspectCause){
      var _sd=StuckDiag.suspectCause(c.x, c.z, null);
      var _sp=TR.stuckSpots[TR.stuckSpots.length-1];
      _sp.cause=_sd.cause; _sp.causeLabel=_sd.causeLabel;
      if (_sd.detail) _sp.causeDetail=_sd.detail;
      if (_sd.flagged) _sp.dataRepair=true;
    }
  }catch(e){}
  try{ Report.note('traffic-stuck', TR.stuckSpots[TR.stuckSpots.length-1]); }catch(e){}
}

/* ---------------- per-frame car step ---------------- */
/* stepCar — one physics/AI tick for a single car (dt seconds).
   Params: c (car), dt (delta time), px/pz (player position for the
   player-yield check). Handles:
     - drive: cruise; drains fuel; 35%-owned cars count down to a pull-over;
       low fuel diverts to a gas station (state 'toGas').
     - toGas/backToRoad: free-steer off the road network (uses the collision
       resolver, not road geometry) to a pump spot / back to the leave point.
     - refueling: parked at the pump for 6-12s, then tank refills to 100%.
     - pulling/parked/resuming: owned-car shoulder stop cycle (12-42s parked).
     - Simple spacing: matches the speed of the car ahead on the same
       road+direction (stops if <7u behind). Never drives through the player
       or the player's van (stops when either is <11u ahead of the nose).
     - Stuck audit: trying to move but speed <0.35 u/s for >5s logs a stuck
       spot (Joshua's live road audit); yielding to the player doesn't count.
     - Lane easing: lateral offset glides toward laneTarget at <=3 u/s
       (pull-over / merge-back motion). */
/* ============================================================================
   v1.16 — JOSHUA'S MARTA BUS TRAFFIC RULE (2026-10-09):
   When a MARTA bus stops to pick up passengers (dwelling at a stop), ALL
   traffic vehicles BEHIND the bus must STOP and WAIT. They cannot go around
   it and cannot drive through it — they wait until the bus finishes boarding
   and pulls away, then proceed. Real bus behavior.

   How it works: the bus system publishes window.MARTA_BUS (see
   marta_bus_system.js) with MB.ready and MB.buses[]; each bus carries
   state ('run'|'dwell'), x, z, stopIdx. Once per frame updateTraffic()
   rebuilds _dwellBuses (usually 0-3 buses), and stepCar() checks whether a
   dwelling bus sits ahead of the car in its lane. Cars have NO lane-change
   / overtake logic anywhere in this module, so a forced stop behind the bus
   inherently means "no going around" — the car simply waits.

   The waiting car is also excluded from the stuck-spot audit (same as
   blockedByPlayer): waiting behind a bus is correct behavior, not a bad
   road spot.
   ============================================================================ */
var _dwellBuses=[];   // per-frame cache: MARTA buses currently dwelling
/* refreshDwellBuses() — rebuild the dwelling-bus cache once per frame.
   Called from updateTraffic() before stepping cars so stepCar() does a
   cheap list scan instead of touching window.MARTA_BUS per car. Guarded:
   if the bus module isn't loaded/ready yet, the cache is just empty and
   traffic behaves as before. */
function refreshDwellBuses(){
  _dwellBuses.length=0;
  var MB=null;
  try{ MB=window.MARTA_BUS; }catch(e){}
  if (!MB||!MB.ready||!MB.buses) return;
  for (var i=0;i<MB.buses.length;i++){
    var b=MB.buses[i];
    if (b&&b.state==='dwell'&&b.stopIdx>=0) _dwellBuses.push(b);
  }
}
/* busDwellsAhead(c) — true when a dwelling MARTA bus is in front of car c
   in c's lane: within 28u, ahead in the heading cone (dot>0.8), and within
   7u laterally (same lane/road, not a parallel street). A bus overlapping
   the car (<4u) is skipped — that's not "behind the bus". */
function busDwellsAhead(c){
  if (!_dwellBuses.length) return false;
  var sy=Math.sin(c.heading), cy=Math.cos(c.heading);
  for (var i=0;i<_dwellBuses.length;i++){
    var b=_dwellBuses[i];
    var dx=b.x-c.x, dz=b.z-c.z;
    var dist=Math.hypot(dx,dz);
    if (dist>28||dist<4) continue;
    var dot=(dx*sy+dz*cy)/dist;
    if (dot<0.8) continue;
    var lat=Math.abs(dx*cy-dz*sy);
    if (lat>7) continue;
    return true;
  }
  return false;
}
var _targets=[[0,0],[0,0]];   // scratch: player + driven van positions
function stepCar(c,dt,px,pz){
  var st=c.state;
  if (st==='drive'){
    c.desired=c.targetSpeed; c.laneTarget=c.laneOffBase;
    // v1.12 NPC FUEL (simple sim): fuel drains with distance driven
    c.fuel-=c.speed*dt*FUEL_DRAIN;
    if (c.fuel<FUEL_LOW){
      var gs=nearestGasStation(c.x,c.z,GAS_SEARCH_R);
      if (gs){
        c.state='toGas'; c.gasSt=gs; c.gasSpot=freePumpSpot(gs);
        c.gasSpot.busy=1;
        c.gasLeave={road:c.road,segT:c.segT,off:c.off,x:c.x,z:c.z};
      } else { c.fuel=35; }   // no station in range — top up abstractly, keep driving
    }
    if (c.owned && c.state==='drive'){ c.pullT-=dt;
      if (c.pullT<=0){ c.state='pulling'; c.laneTarget=c.shoulderOff; } }
  } else if (st==='toGas'){
    // v1.12: steer off-road to the pump spot, park, refuel
    var tx=c.gasSpot.x, tz=c.gasSpot.z;
    var gdx=tx-c.x, gdz=tz-c.z, gd=Math.hypot(gdx,gdz);
    if (gd<4.5){ c.state='refueling'; c.refuelT=6+TR.rng()*6; c.speed=0; }
    else {
      var wantH=Math.atan2(gdx,gdz), dh=wantH-c.heading;
      while(dh>Math.PI)dh-=2*Math.PI; while(dh<-Math.PI)dh+=2*Math.PI;
      c.heading+=Math.max(-2.2*dt,Math.min(2.2*dt,dh));
      c.speed=Math.min(c.speed+ACCEL_US*dt,9);
      var gnx=c.x+Math.sin(c.heading)*c.speed*dt,
          gnz=c.z+Math.cos(c.heading)*c.speed*dt;
      var gtmp={x:gnx,z:gnz};
      try{ resolveCollision(gtmp,2.2); }catch(e){}
      c.x=gtmp.x; c.z=gtmp.z;
      try{ c.y=(typeof clampVehY==='function')?clampVehY(c.x,c.z,heightAt(c.x,c.z)+0.06):heightAt(c.x,c.z)+0.06; }catch(e){}  // v1.12 ground clamp
    }
  } else if (st==='refueling'){
    c.speed=0; c.refuelT-=dt;
    if (c.refuelT<=0){
      c.fuel=100; c.gasSpot.busy=0;
      c.state='backToRoad';
    }
  } else if (st==='backToRoad'){
    // v1.12: steer back to where we left the road, then rejoin
    var lx=c.gasLeave.x, lz=c.gasLeave.z;
    var ldx=lx-c.x, ldz=lz-c.z, ld=Math.hypot(ldx,ldz);
    if (ld<9){
      c.road=c.gasLeave.road; c.segT=c.gasLeave.segT; c.off=c.gasLeave.off;
      c.gasSt=null; c.gasSpot=null; c.gasLeave=null;
      try{ roadPose(c); }catch(e){}
      c.state='resuming'; c.laneTarget=c.laneOffBase;
    } else {
      var wantH2=Math.atan2(ldx,ldz), dh2=wantH2-c.heading;
      while(dh2>Math.PI)dh2-=2*Math.PI; while(dh2<-Math.PI)dh2+=2*Math.PI;
      c.heading+=Math.max(-2.2*dt,Math.min(2.2*dt,dh2));
      c.speed=Math.min(c.speed+ACCEL_US*dt,9);
      var bnx=c.x+Math.sin(c.heading)*c.speed*dt,
          bnz=c.z+Math.cos(c.heading)*c.speed*dt;
      var btmp={x:bnx,z:bnz};
      try{ resolveCollision(btmp,2.2); }catch(e){}
      c.x=btmp.x; c.z=btmp.z;
      try{ c.y=(typeof clampVehY==='function')?clampVehY(c.x,c.z,heightAt(c.x,c.z)+0.06):heightAt(c.x,c.z)+0.06; }catch(e){}  // v1.12 ground clamp
    }
  } else if (st==='pulling'){
    c.desired=0;
    if (c.speed<0.5){ c.state='parked'; c.parkT=12+TR.rng()*30; }
  } else if (st==='parked'){
    c.desired=0; c.parkT-=dt;
    if (c.parkT<=0){ c.state='resuming'; c.laneTarget=c.laneOffBase;
      c.pullT=25+TR.rng()*55; }
  } else { // resuming
    c.desired=c.targetSpeed;
    if (c.speed>c.targetSpeed*0.7) c.state='drive';
  }
  // simple spacing: don't drive through the car ahead (same road + direction)
  for (var i=0;i<TR.cars.length;i++){
    var o=TR.cars[i];
    if (o===c||o.road!==c.road||o.dir!==c.dir) continue;
    var ds=(o.segT-c.segT)*c.dir;
    if (ds>0&&ds<16){
      if (o.speed<c.desired) c.desired=o.speed;
      if (ds<7) c.desired=0;
    }
  }
  // never drive through Joshua or his van: stop when either is ahead
  c.blockedByPlayer=false;
  c.blockedByBus=false;
  _targets[0][0]=px; _targets[0][1]=pz;
  var nT=1;
  try{ if (typeof car!=='undefined'&&car){ _targets[1][0]=car.x; _targets[1][1]=car.z; nT=2; } }catch(e){}
  var sy=Math.sin(c.heading), cy=Math.cos(c.heading);
  for (var t=0;t<nT;t++){
    var dx=_targets[t][0]-c.x, dz=_targets[t][1]-c.z, d2=dx*dx+dz*dz;
    if (d2<121){                            // within 11u
      var dot=(dx*sy+dz*cy)/(Math.sqrt(d2)||1);
      if (dot>0.75){ c.desired=0; c.blockedByPlayer=true; break; }
    }
  }
  /* v1.16 — JOSHUA'S MARTA BUS RULE: a dwelling bus ahead in our lane means
     stop and wait. No going around (this module has no lane-change/overtake
     logic, so a forced stop IS the wait), no driving through. The bus
     resumes on its own when boarding finishes (dwellT expires) and the
     cache clears next frame, releasing the queue. */
  if (!c.blockedByPlayer){
    try{ if (busDwellsAhead(c)){ c.desired=0; c.blockedByBus=true; } }catch(e){}
  }
  /* v1.17 — JOSHUA'S SCHOOL BUS STOP LAW: while a school bus has its stop
     sign out (window.__sbActive, published by schoolbus_system.js), ALL
     approaching vehicles must stop and wait — both travel directions (real
     stop-arm law). The sign retracts when boarding finishes and the queue
     releases on its own. Blocked cars are excluded from the stuck audit. */
  c.blockedBySchoolBus=false;
  if (!c.blockedByPlayer && !c.blockedByBus){
    try{
      var _sbA=window.__sbActive;
      if (_sbA && _sbA.length){
        for (var _bi=0; _bi<_sbA.length; _bi++){
          var _sb=_sbA[_bi];
          var _bx=_sb.x-c.x, _bz=_sb.z-c.z, _bd2=_bx*_bx+_bz*_bz;
          if (_bd2<3600){                       // within 60u
            var _bd=Math.sqrt(_bd2)||1;
            var _sdot=(_bx*sy+_bz*cy)/_bd;
            if (Math.abs(_sdot)>0.6){ c.desired=0; c.blockedBySchoolBus=true; break; }
          }
        }
      }
    }catch(e){}
  }
  // integrate speed toward desired
  var dv=c.desired-c.speed, mx=dv>0?ACCEL_US*dt:BRAKE_US*dt;
  c.speed+=Math.max(-mx,Math.min(mx,dv));
  if (c.speed<0) c.speed=0;
  // stuck audit (only when genuinely trying, not when yielding)
  var trying=(st==='drive'||st==='pulling'||st==='resuming')&&c.desired>1;
  if (trying&&c.speed<0.35&&!c.blockedByPlayer&&!c.blockedByBus&&!c.blockedBySchoolBus){
    c.stuckT+=dt;
    if (c.stuckT>STUCK_AFTER_S){ logStuck(c); c.stuckT=-STUCK_COOLDOWN; }
  } else if (c.stuckT>0) c.stuckT=0;
  // ease toward the target lane offset (pull-over / merge-back)
  var dl=c.laneTarget-c.off;
  c.off+=Math.max(-3*dt,Math.min(3*dt,dl));
  // advance along the path (road states only — fuel states steer freely)
  if (st==='drive'||st==='pulling'||st==='parked'||st==='resuming'){
    c.segT+=c.dir*c.speed*dt;
    var R=TR.roads[c.road];
    if (c.segT>=R.len||c.segT<=0) roadEnd(c); else roadPose(c);
  }
}

/* ---------------- streaming renderer ----------------
   3 draw calls for ALL traffic: bodies + glasshouses + wheels as
   InstancedMesh. Slots are reassigned every 0.3s to the nearest cars.
   PERFORMANCE: geometry exists only for cars near the player; distant cars
   are pure data (positions only). Wheel spin is faked from distance driven
   (wheelA += speed*dt / wheelRadius). */
function buildRenderPool(){
  var bodyG=new THREE.BoxGeometry(2.0,0.62,4.6); bodyG.translate(0,0.55,0);
  var glassG=new THREE.BoxGeometry(1.75,0.5,2.4); glassG.translate(0,1.12,-0.2);
  var wheelG=new THREE.CylinderGeometry(0.34,0.34,0.3,10); wheelG.rotateZ(Math.PI/2);
  TR.bodyIM=new THREE.InstancedMesh(bodyG,
    new THREE.MeshLambertMaterial({color:0xffffff}), MAX_RENDERED);
  TR.glassIM=new THREE.InstancedMesh(glassG,
    new THREE.MeshLambertMaterial({color:0x1c2733}), MAX_RENDERED);
  TR.wheelIM=new THREE.InstancedMesh(wheelG,
    new THREE.MeshLambertMaterial({color:0x181818}), MAX_RENDERED*4);
  [TR.bodyIM,TR.glassIM,TR.wheelIM].forEach(function(im){
    im.frustumCulled=false;                 // instances span the whole map
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(im);
  });
  TR.slots=[]; for (var s=0;s<MAX_RENDERED;s++){ TR.slots.push(-1); zeroSlot(s); }
  TR.bodyIM.instanceMatrix.needsUpdate=true;
  TR.glassIM.instanceMatrix.needsUpdate=true;
  TR.wheelIM.instanceMatrix.needsUpdate=true;
}
/* assignSlots(px,pz) — rebinds the MAX_RENDERED instanced slots to the
   nearest cars within STREAM_DIST of the player (nearest-first sort).
   Cars that lose a slot keep driving as data; emptied slots are zero-scaled
   (hidden). Reassigns at most every 0.3s — the hysteresis-free cadence
   keeps pop-in cheap while tracking a moving player. */
function assignSlots(px,pz){
  var cand=[], i;
  for (i=0;i<TR.cars.length;i++){ var c=TR.cars[i];
    var dx=c.x-px, dz=c.z-pz, d2=dx*dx+dz*dz;
    if (d2<STREAM_DIST2) cand.push([d2,i]);
  }
  cand.sort(function(a,b){return a[0]-b[0];});
  var n=Math.min(cand.length,MAX_RENDERED);
  for (var s=0;s<MAX_RENDERED;s++){
    var prev=TR.slots[s];
    if (prev>=0&&TR.cars[prev]) TR.cars[prev].slot=-1;
    var ci=s<n?cand[s][1]:-1;
    TR.slots[s]=ci;
    if (ci>=0){ TR.cars[ci].slot=s; TR.bodyIM.setColorAt(s,_c.setHex(TR.cars[ci].color)); }
    else zeroSlot(s);
  }
  if (TR.bodyIM.instanceColor) TR.bodyIM.instanceColor.needsUpdate=true;
  TR.rendered=n;
}
/* renderSlots(dt) — writes body/glass/wheel matrices for every assigned slot.
   Wheels are rotated by wheelA (distance-driven spin) on a 'YXZ' euler so
   spin and steering yaw compose correctly; offsets are rotated into heading
   space so wheels track the body. */
function renderSlots(dt){
  for (var s=0;s<MAX_RENDERED;s++){
    var ci=TR.slots[s]; if (ci<0) continue;
    var c=TR.cars[ci];
    _e.set(0,c.heading,0); _q.setFromEuler(_e);
    _v.set(c.x,c.y,c.z); _m.compose(_v,_q,_ONE);
    TR.bodyIM.setMatrixAt(s,_m); TR.glassIM.setMatrixAt(s,_m);
    c.wheelA=(c.wheelA+c.speed*dt/0.34)%(Math.PI*2);
    var ch=Math.cos(c.heading), sh=Math.sin(c.heading);
    for (var k=0;k<4;k++){
      var ox=WO[k][0], oz=WO[k][1];
      _v.set(c.x+ox*ch+oz*sh, c.y+0.34, c.z-ox*sh+oz*ch);
      _e.set(c.wheelA,c.heading,0,'YXZ'); _q.setFromEuler(_e);
      _m.compose(_v,_q,_ONE);
      TR.wheelIM.setMatrixAt(s*4+k,_m);
    }
  }
  TR.bodyIM.instanceMatrix.needsUpdate=true;
  TR.glassIM.instanceMatrix.needsUpdate=true;
  TR.wheelIM.instanceMatrix.needsUpdate=true;
}

/* ---------------- gas stations (v1.12) ----------------
   REAL OSM locations: REAL_FUEL_STATIONS (deduped amenity=fuel, pulled
   2026-10-09 from Geofabrik Georgia extract). Positions verified against
   real-world data — see streetview-audit/gas_stations.md.
   Fully instanced rendering — pad/canopy/kiosk/roof/columns/pumps =
   6 draw calls for ALL stations. Per-object colliders only (kiosk, pumps,
   columns); the lot itself is DRIVABLE with pull-through lanes. No more
   station-wide invisible wall (that was the stuck-in-gas-station bug).
   Fictitious display names only (trademark rule); real brands kept in the
   audit file, never shown in game.
   Layout (station-local, +z = approach/drive side, faces nearest road):
     pad 48x38 | canopy 38x1.1x24 at y7.2 | 4 pump islands (x=-15.75..15.75, z=0)
     kiosk 9x3.6x7 at (18,-14) — clear of lanes | 6 canopy columns
   NPC fuel + player refuel hook into TR.gas[].pumpSpots. */
var GAS_MAX=130;          // instanced capacity (real station count: ~109)
var FUEL_DRAIN=0.0167;    // fuel per unit driven — ~5 min of driving per tank
var FUEL_LOW=18;          // NPC heads for a station below this level
var GAS_SEARCH_R=600;     // NPC station search radius (u)
var GAS_PUMP_SPOTS=[];    // flat [{x,z}] for player refuel + NPC targeting

/* uniqueGasName(base) — appends a number if base collides with the game's
   business namer (BUSINESSES), so gas-station brands never duplicate names
   the world already owns. */
function uniqueGasName(base){
  var nm=base, n=2;
  var taken=function(x){ for (var i=0;i<BUSINESSES.length;i++)
    if (BUSINESSES[i].name===x) return true; return false; };
  while (taken(nm)) nm=base+' '+(n++);
  return nm;
}
/* Shared geometries/materials + six global InstancedMeshes (one per part). */
var _gasShared=null;
function gasShared(){
  if (_gasShared) return _gasShared;
  function mat(c){ return new THREE.MeshLambertMaterial({color:c}); }
  _gasShared={
    padG:new THREE.BoxGeometry(48,0.3,38), padM:mat(0x6a6e74),
    canopyG:new THREE.BoxGeometry(38,1.1,24), canopyM:{},
    kioskG:new THREE.BoxGeometry(9,3.6,7),   kioskM:mat(0xd8d2c4),
    roofG:new THREE.BoxGeometry(9.6,0.4,7.6), roofM:mat(0x4a4e54),
    colG:new THREE.BoxGeometry(0.9,7.2,0.9), colM:mat(0xe8e8e8),
    pumpG:new THREE.BoxGeometry(1.4,1.5,0.9), pumpM:mat(0xb03030),
    padIM:null, canopyIM:null, kioskIM:null, roofIM:null, colIM:null, pumpIM:null,
    n:0
  };
  return _gasShared;
}
function gasInstancing(){
  var S=gasShared();
  if (S.padIM) return;
  function mk(geo,mt,cap){
    var im=new THREE.InstancedMesh(geo,mt,cap);
    im.frustumCulled=false; scene.add(im);
    for (var i=0;i<cap;i++) im.setMatrixAt(i,_ZERO_M);
    im.instanceMatrix.needsUpdate=true; return im;
  }
  S.padIM=mk(S.padG,S.padM,GAS_MAX);
  S.canopyIM=mk(S.canopyG,new THREE.MeshLambertMaterial({color:0xffffff}),GAS_MAX);
  S.kioskIM=mk(S.kioskG,S.kioskM,GAS_MAX);
  S.roofIM=mk(S.roofG,S.roofM,GAS_MAX);
  S.colIM=mk(S.colG,S.colM,GAS_MAX*6);
  S.pumpIM=mk(S.pumpG,S.pumpM,GAS_MAX*4);
}
/* gasFaceAngle(x,z) — aims the station's approach side (+z local) at the
   nearest road centerline point (sampled every 4th path point for speed),
   so the lot always faces the road players/NPCs drive past. */
function gasFaceAngle(x,z){
  var bx=x,bz=z,bd=1e18;
  try{
    for (var i=0;i<TR.roads.length;i++){
      var pts=TR.roads[i].r.pts;
      for (var p=0;p<pts.length;p+=4){
        var dx=pts[p][0]-x, dz=pts[p][1]-z, d2=dx*dx+dz*dz;
        if (d2<bd){ bd=d2; bx=pts[p][0]; bz=pts[p][1]; }
      }
    }
  }catch(e){}
  return Math.atan2(bx-x,bz-z);
}
/* buildGasStation(sx,sz,brand,colorHex) — builds one station from the shared
   instanced parts (pad, canopy, kiosk, roof, 6 columns, 4 pump islands),
   rotated so +z local faces the nearest road. Registers 4 pump parking spots
   (on the approach side, +4.6u local z) for NPC fueling and the player's
   refuel hook, adds per-object colliders (columns, pumps, kiosk only — the
   LOT stays drivable), and pushes the business into BUSINESSES/LANDMARKS. */
function buildGasStation(sx,sz,brand,colorHex){
  var S=gasShared(); gasInstancing();
  if (S.n>=GAS_MAX) return null;
  var gy=heightAt(sx,sz);
  var a=gasFaceAngle(sx,sz);
  var ca=Math.cos(a), sa=Math.sin(a);
  function L2W(lx,lz){ return {x:sx+lx*ca+lz*sa, z:sz-lx*sa+lz*ca}; }
  var idx=S.n++;
  _e.set(0,a,0); _q.setFromEuler(_e);
  function setIM(im,i,lx,ly,lz){
    _v.set(sx+lx*ca+lz*sa, gy+ly, sz-lx*sa+lz*ca);
    _m.compose(_v,_q,_ONE); im.setMatrixAt(i,_m);
  }
  setIM(S.padIM,idx, 0,0.15,0);
  // canopy gets per-instance brand color
  _v.set(sx,gy+7.2,sz); _m.compose(_v,_q,_ONE);
  S.canopyIM.setMatrixAt(idx,_m);
  try{ S.canopyIM.setColorAt(idx,_c.setHex(colorHex)); }catch(e){}
  setIM(S.kioskIM,idx, 18,1.95,-14);
  setIM(S.roofIM,idx, 18,3.95,-14);
  // 6 canopy columns
  var ci=idx*6, cn=0;
  [[-15,-9],[0,-9],[15,-9],[-15,9],[0,9],[15,9]].forEach(function(p){
    setIM(S.colIM,ci+cn,p[0],3.6,p[1]);
    var w=L2W(p[0],p[1]);
    try{ addBldgCollider(w.x,w.z,0.9); }catch(e){}
    cn++;
  });
  // 4 pump islands + pump spots (parking positions on approach side)
  var pi=idx*4, pumpSpots=[];
  [-15.75,-5.25,5.25,15.75].forEach(function(px){
    setIM(S.pumpIM,pi,px,1.05,0);
    var w=L2W(px,0);
    try{ addBldgCollider(w.x,w.z,1.4); }catch(e){}
    var sp=L2W(px,4.6);
    pumpSpots.push({x:sp.x,z:sp.z,busy:0});
    GAS_PUMP_SPOTS.push({x:sp.x,z:sp.z});
    pi++;
  });
  [S.padIM,S.canopyIM,S.kioskIM,S.roofIM,S.colIM,S.pumpIM].forEach(function(im){
    im.instanceMatrix.needsUpdate=true;
  });
  if (S.canopyIM.instanceColor) S.canopyIM.instanceColor.needsUpdate=true;
  // kiosk collider (the only big one — everything else is a small post/pump)
  var kw=L2W(18,-14);
  try{ addBldgCollider(kw.x,kw.z,6); }catch(e){}
  try{ LANDMARKS.push({x:sx,z:sz,name:brand}); }catch(e){}
  var biz={x:sx,z:sz,y:gy,w:48,d:38,h:8.5,type:'gas',name:brand,
           pumpSpots:pumpSpots,faceAngle:a};
  try{ BUSINESSES.push(biz); }catch(e){}
  TR.gas.push(biz);
  return biz;
}
/* placeGasStations() — places all stations: prefers REAL_FUEL_STATIONS
   (real OSM coordinates converted with xz()) placed via placeStruct so they
   never collide with buildings/roads; falls back to procedural arterial
   placement if the data file is missing (should never happen — it's
   bundled). Then adds Joshua's hand-verified ground-truth station
   (Fairburn Rd north of MLK, west side). Reports placed/skipped counts. */
function placeGasStations(){
  var list=(typeof REAL_FUEL_STATIONS!=='undefined'&&REAL_FUEL_STATIONS.length)
    ? REAL_FUEL_STATIONS : null;
  var made=0, skipped=0;
  if (list){
    // REAL stations at verified OSM positions
    for (var i=0;i<list.length&&made<GAS_MAX;i++){
      var s=list[i], p=xz(s.lat,s.lon);
      var spot=null;
      try{ spot=placeStruct(p.x,p.z,26,4,'gasStation-real'+i); }catch(e){}
      if (!spot){ skipped++; continue; }
      var brand=uniqueGasName(GAS_BRANDS[made%GAS_BRANDS.length]);
      if (buildGasStation(spot.x,spot.z,brand,GAS_CANOPY[made%GAS_CANOPY.length])) made++;
      else skipped++;
    }
  } else {
    // fallback: procedural (should never happen — data file is bundled)
    var arts=TR.roads.filter(function(R){return R.cat==='arterial';});
    if (!arts.length) return;
    var want=10, guard=0;
    while (made<want&&guard++<120){
      var R=arts[(TR.rng()*arts.length)|0];
      var keep={road:TR.roads.indexOf(R),segT:TR.rng()*R.len,dir:1,
                off:(R.w/2+34)*(TR.rng()<0.5?1:-1),laneTarget:0,x:0,z:0,y:0,heading:0};
      roadPose(keep);
      var spot=null;
      try{ spot=placeStruct(keep.x,keep.z,26,4,'gasStation'+made); }catch(e){}
      if (!spot) continue;
      var brand2=uniqueGasName(GAS_BRANDS[made%GAS_BRANDS.length]);
      if (buildGasStation(spot.x,spot.z,brand2,GAS_CANOPY[made%GAS_CANOPY.length])) made++;
    }
  }
  /* v1.14 (2026-10-09): Joshua's ground truth — gas station on Fairburn Rd,
     just north of MLK Jr Dr, WEST side (left heading north). Real-world
     check: CITGO/BP stations at this intersection (3657 MLK Jr Dr SW,
     490 Fairburn Rd SW). Fictitious display name per trademark rule. */
  try{
    var mlkSpot=placeStruct(3810,2930,26,4,'gasStation-mlk-fairburn');
    if (mlkSpot){
      var mlkBrand=uniqueGasName('FairburnFuel');
      if (buildGasStation(mlkSpot.x,mlkSpot.z,mlkBrand,GAS_CANOPY[1])) made++;
      else skipped++;
    } else { skipped++; }
  }catch(e){ try{ Report.noteError('gasStations','mlk-fairburn failed',String(e&&e.message||e)); }catch(x){} }
  try{ Report.setSys('gasStations',{placed:made,skipped:skipped,
    real:!!list,status:'ok',
    note:'real OSM positions; drivable lots; per-object colliders'}); }catch(e){}
}
window.GAS_PUMP_SPOTS=GAS_PUMP_SPOTS;
/* nearestGasStation(x,z,maxD) — closest station within maxD units. Used by
   NPC cars in the 'drive' state when fuel drops below FUEL_LOW. */
function nearestGasStation(x,z,maxD){
  var best=null,bd=maxD*maxD;
  for (var i=0;i<TR.gas.length;i++){
    var g=TR.gas[i], dx=g.x-x, dz=g.z-z, d2=dx*dx+dz*dz;
    if (d2<bd){ bd=d2; best=g; }
  }
  return best;
}
/* freePumpSpot(g) — least-busy of the station's 4 pump spots. Returns the
   first free spot (busy=0) when ties occur; caller marks spot.busy=1 so two
   NPCs never target the same pump. */
function freePumpSpot(g){
  var best=g.pumpSpots[0],bb=1e18;
  for (var i=0;i<g.pumpSpots.length;i++){
    var s=g.pumpSpots[i];
    if (s.busy<bb){ bb=s.busy; best=s; }
  }
  return best;
}

/* ---------------- public update ---------------- */
/* updateTraffic(dt,px,pz) — frame tick. Steps every car, reassigns render
   slots every 0.3s, writes instances, and reports to the Report panel every
   2s. All args optional: dt falls back to performance.now() clamped to 50ms
   (prevents physics explosions after tab switches); px/pz fall back to the
   player. Never throws — a traffic bug must never break the game frame. */
var _lastT=0;
function updateTraffic(dt,px,pz){
  if (!TR) return;
  try{
    if (dt===undefined||dt===null){
      var now=(typeof performance!=='undefined'?performance.now():Date.now());
      dt=_lastT>0?Math.min(0.05,(now-_lastT)/1000):1/60; _lastT=now;
    }
    if (px===undefined){ try{ px=player.x; pz=player.z; }catch(e){ px=0;pz=0; } }
    var i;
    refreshDwellBuses();   // v1.16: rebuild the dwelling-MARTA-bus cache once per frame
    for (i=0;i<TR.cars.length;i++) stepCar(TR.cars[i],dt,px,pz);
    TR.assignT-=dt;
    if (TR.assignT<=0){ assignSlots(px,pz); TR.assignT=0.3; }
    renderSlots(dt);
    TR.repT-=dt;
    if (TR.repT<=0){
      try{ Report.setSys('traffic',{status:'ok', version:'1.9',
        cars:TR.cars.length, rendered:TR.rendered,
        gasStations:TR.gas.length, stuckSpots:TR.stuckSpots}); }catch(e){}
      TR.repT=2;
    }
  }catch(e){ /* traffic must never break the frame */ }
}
window.updateTraffic=updateTraffic;

/* ---------------- init + self-install ---------------- */
/* initTraffic() — builds the road index, endpoint grid, render pool, and
   spawns the car fleet: 44 highway cars (25-31 u/s ≈ 54-67 mph), 28 arterial
   (13-19 u/s ≈ 28-41 mph), 24 local (8-14 u/s ≈ 17-30 mph neighborhood
   pace). A guaranteed cluster of up to 12 local cars spawns within 1200u of
   the player's start so Joshua sees traffic immediately at home base
   (535 Dollar Mill Rd SW). Finally wraps the global animate() so the inner
   requestAnimationFrame(animate) re-reads the wrapped binding every frame —
   updateTraffic runs with zero edits to index.html. */
function initTraffic(){
  TR={ cars:[], stuckSpots:[], gas:[], slots:[], rendered:0,
       rng:mulberry32(0x7AFF1C), assignT:0, repT:0, time:0 };
  makeTemps();
  TR.roads=buildRoadIndex();
  if (!TR.roads.length) throw new Error('no traffic roads');
  TR.ep=buildEndpointGrid(TR.roads);
  buildRenderPool();
  var hw=TR.roads.filter(function(R){return R.cat==='highway';});
  var ar=TR.roads.filter(function(R){return R.cat==='arterial';});
  var lo=TR.roads.filter(function(R){return R.cat==='local';});
  // highway pace: 25-31 u/s ≈ 54-67 mph (MPH_PER_US = 65/30)
  spawnOn(hw,N_HW_CARS,25,31);
  // arterial pace: 13-19 u/s ≈ 28-41 mph
  spawnOn(ar,N_ART_CARS,13,19);
  // v1.13: local-road traffic so residential areas aren't empty.
  // Local pace: 8-14 u/s ≈ 17-30 mph (neighborhood speeds).
  // Split: some spread map-wide, plus a guaranteed cluster near player start
  // so Joshua sees traffic immediately at 535 Dollar Mill.
  var loNear=[], loFar=[];
  var spx=0, spz=0;
  try{ spx=player.x; spz=player.z; }catch(e){}
  var i2;
  for (i2=0;i2<lo.length;i2++){
    var R2=lo[i2], mid=R2.r.pts[(R2.r.pts.length>>1)];
    var d2=(mid[0]-spx)*(mid[0]-spx)+(mid[1]-spz)*(mid[1]-spz);
    if (d2<LOCAL_NEAR_RADIUS*LOCAL_NEAR_RADIUS) loNear.push(R2); else loFar.push(R2);
  }
  if (loNear.length) spawnOn(loNear, Math.min(N_LOCAL_NEAR, loNear.length*2), 8, 14);
  if (loFar.length) spawnOn(loFar, N_LOCAL_CARS, 8, 14);
  else if (lo.length && !loNear.length) spawnOn(lo, N_LOCAL_CARS, 8, 14);
  placeGasStations();
  // hook the frame loop — the inner requestAnimationFrame(animate) re-reads
  // the global binding every frame, so wrapping it here takes effect.
  try{
    if (typeof animate==='function'&&!animate.__trafWrap){
      var orig=animate;
      var wrapped=function(){ orig(); updateTraffic(); };
      wrapped.__trafWrap=true;
      animate=wrapped;
    }
  }catch(e){}
  try{
    Report.setSys('traffic',{status:'ok',version:'1.9',
      cars:TR.cars.length, rendered:0, gasStations:TR.gas.length,
      stuckSpots:TR.stuckSpots,
      roads:TR.roads.length,
      note:'highway+arterial traffic; stuck-spot road audit live'});
  }catch(e){}
  window.TRAFFIC=TR;   // expose only after a clean init
}

/* Boot: wait until the main script has built the world (roadDrawData,
   scene, player, animate all exist), then init exactly once. Works whether
   this file is included before or after the main game script. */
var bootTries=0;
var bootTimer=setInterval(function(){
  bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined'&&typeof scene!=='undefined'&&
      typeof roadDrawData!=='undefined'&&roadDrawData.length>100&&
      typeof player!=='undefined'&&typeof animate==='function');
  }catch(e){ ready=false; }
  if (ready){
    try{ initTraffic(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('traffic','init failed',String(e&&e.message||e)); }catch(x){}
    }
    clearInterval(bootTimer);
  } else if (bootTries>240){   // 60s — give up quietly, never break the game
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('traffic','boot-timeout','deps never ready'); }catch(e){}
  }
},250);

})();
