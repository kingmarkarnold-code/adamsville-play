/* ============================================================================
   FILE: schoolbus_system.js — "Surviving Adamsville" school bus stop-sign law
   ----------------------------------------------------------------------------
   PURPOSE: Real school bus behavior (Joshua's directive, 2026-10-09):
     1. School buses drive fixed routes past schools, stopping at bus stops.
     2. When a bus stops to pick up children, its STOP SIGN ANIMATES OUT
        from the LEFT (driver's) side and the red roof warning lights flash.
     3. ALL approaching vehicles MUST STOP AND WAIT while the sign is out —
        AI traffic yields (see traffic_system.js v1.17 hook) and the
        player's van is held (see index.html driving hook) with a dashboard
        warning. When pickup finishes the sign RETRACTS and traffic resumes.
     4. Nearby 16-year-old NPCs (Joshua's age rule: nobody under 16) walk to
        the bus door and board; they ride until the route terminus, then get
        off and resume wandering.

   STANDALONE MODULE. Include AFTER the main game script and AFTER
   marta_bus_system.js (it copies that file's proven route/shuttle pattern):
       <script src="schoolbus_system.js"></script>
   No edits to index.html are required for the bus itself; the two traffic
   hooks (traffic_system.js, index.html driving code) are documented below.

   INTEGRATION CONTRACTS (what other files must provide):
     - traffic_system.js stepCar(): reads window.__sbActive [{x,z}...] and
       zeroes c.desired for cars approaching an active bus (v1.17).
     - index.html player driving: reads window.__sbActive, brakes the van
       and shows the "SCHOOL BUS — STOP" toast (v1.17).
     - vehicle_meshes.js schoolBusMesh(): exposes userData.stopSign,
       userData.signT, userData.warnLights (v1.17).

   JOSHUA SPECS ENCODED:
     - Stop sign on the LEFT (driver's) side — never the right.
     - Children are 16-year-old NPCs (boy16 type); nobody under 16 exists.
     - No map elements deleted: routes are built from existing roadDrawData.
   ============================================================================ */
(function(){
'use strict';
if (window.__schoolBusV1) return;      // never double-load
window.__schoolBusV1 = true;

/* ---------------- config ---------------- */
var BUS_SPEED   = 19;     // units/sec cruising (school zones are slow)
var BOARD_TIME  = 9;      // seconds dwelled with the sign out per stop
var BRAKE_DIST  = 55;     // start slowing this far from a stop
var SIGN_RANGE  = 60;     // traffic yields within this many units of an active bus
var KID_RANGE   = 45;     // how far away a teen can be and still walk to board
var MAX_KIDS    = 3;      // kids picked up per stop
var KID_SPEED   = 3.6;    // teen walk speed toward the bus door

var SB = { buses: [], ready: false };

/* ---------------- arc-length path (same proven pattern as marta_bus_system) */
function makePath(pts, ys){
  var cum=[0], i, dx, dz;
  for (i=1;i<pts.length;i++){
    dx=pts[i][0]-pts[i-1][0]; dz=pts[i][1]-pts[i-1][1];
    cum.push(cum[i-1]+Math.sqrt(dx*dx+dz*dz));
  }
  var total=cum[cum.length-1];
  function segAt(s){
    s=Math.max(0,Math.min(total,s));
    var lo=0, hi=cum.length-1;
    while (lo<hi){ var mid=(lo+hi)>>1; if (cum[mid]<s) lo=mid+1; else hi=mid; }
    return Math.max(1,lo);
  }
  return {
    length: total,
    posAt: function(s){
      var j=segAt(s), s0=cum[j-1], s1=cum[j], t=s1>s0?(s-s0)/(s1-s0):0;
      return [pts[j-1][0]+(pts[j][0]-pts[j-1][0])*t,
              pts[j-1][1]+(pts[j][1]-pts[j-1][1])*t];
    },
    dirAt: function(s){
      var j=segAt(s), dx=pts[j][0]-pts[j-1][0], dz=pts[j][1]-pts[j-1][1];
      var l=Math.sqrt(dx*dx+dz*dz)||1; return [dx/l, dz/l];
    },
    yAt: function(s){
      if (!ys || !ys.length) return 0;
      var j=segAt(s), s0=cum[j-1], s1=cum[j], t=s1>s0?(s-s0)/(s1-s0):0;
      var k=Math.min(ys.length-1,j), k0=Math.max(0,k-1);
      return ys[k0]+(ys[k]-ys[k0])*t;
    }
  };
}

/* ---------------- route building ----------------
   findSchoolRoad(x, z) — the longest LOCAL road (by point count) whose
   midpoint passes near a school. Local roads keep buses in neighborhoods
   where kids actually wait. Returns {pts, ys} or null. */
function findSchoolRoad(x, z, avoid){
  if (typeof roadDrawData==='undefined' || !roadDrawData.length) return null;
  var best=null, bd=1e18, i, k, R, d;
  for (i=0;i<roadDrawData.length;i++){
    R=roadDrawData[i];
    if (!R || R.cat!=='local' || !R.pts || R.pts.length<25) continue;
    if (avoid && avoid.indexOf(i)>=0) continue;
    // nearest sampled point to the school
    var nd=1e18;
    for (k=0;k<R.pts.length;k+=4){
      var dx=R.pts[k][0]-x, dz=R.pts[k][1]-z, q=dx*dx+dz*dz;
      if (q<nd) nd=q;
    }
    d=Math.sqrt(nd);
    // prefer roads that pass close to the school AND are long
    var score=d - R.pts.length*0.15;
    if (d<700 && score<bd){ bd=score; best={ri:i, pts:R.pts, ys:R.ys}; }
  }
  return best;
}

/* ---------------- bus entity ---------------- */
function spawnSchoolBus(path, s0, dir, label){
  var mesh=schoolBusMesh();
  try{ scene.add(mesh); }catch(e){}
  var b={ path:path, s:s0, dir:dir||1, speed:0, state:'run',
          boardT:0, stopIdx:-1, x:0, z:0, yaw:0, signT:0, mesh:mesh,
          riders:[], label:label||'SCHOOL BUS' };
  SB.buses.push(b);
  return b;
}

/* nextStopIdx(b) — next stop AHEAD of the bus in its travel direction. */
function nextStopIdx(b){
  var stops=b.stops, best=-1, bd=1e18, i, ds;
  for (i=0;i<stops.length;i++){
    ds=(stops[i]-b.s)*b.dir;
    if (ds>1 && ds<bd){ bd=ds; best=i; }
  }
  return best;
}

/* doorPos(b) — world position of the bus entry door (front-left). */
function doorPos(b){
  var fx=Math.sin(b.yaw), fz=Math.cos(b.yaw);   // forward
  var lx=Math.cos(b.yaw), lz=-Math.sin(b.yaw);  // left
  return [b.x+fx*3.4+lx*1.6, b.z+fz*3.4+lz*1.6];
}

/* pickKids(b) — up to MAX_KIDS boy16 NPCs near the stop walk to the door.
   Joshua's age rule: the only children in the world are 16-year-old boys
   (type 2). Crew members are never in npc_system's population, so no
   crew filtering is needed. */
function pickKids(b){
  var npcs=null;
  try{ npcs=window.NPC_DEBUG.npcs; }catch(e){}
  if (!npcs || !npcs.length) return;
  var dp=doorPos(b), got=0, i, n, dx, dz, d;
  for (i=0;i<npcs.length && got<MAX_KIDS;i++){
    n=npcs[i];
    try{
      if (!n || n.type!==2 || n.onBus || n.boarding) continue;
      dx=n.x-dp[0]; dz=n.z-dp[1]; d=Math.sqrt(dx*dx+dz*dz);
      if (d<KID_RANGE){ n.boarding=b; n.focus=true; got++; }  // focus pauses wander AI
    }catch(e){}
  }
}

/* stepKids(b, dt) — walk boarding teens to the door; board on arrival. */
function stepKids(b, dt){
  var npcs=null;
  try{ npcs=window.NPC_DEBUG.npcs; }catch(e){}
  if (!npcs) return;
  var dp=doorPos(b), i, n, dx, dz, d, h;
  for (i=0;i<npcs.length;i++){
    n=npcs[i];
    try{
      if (!n || n.boarding!==b) continue;
      dx=dp[0]-n.x; dz=dp[1]-n.z; d=Math.sqrt(dx*dx+dz*dz);
      if (d<2.2){
        // boarded: ride inside the bus (hidden within the body) until terminus
        n.boarding=null; n.onBus=b; n.focus=false;
        b.riders.push(n);
      } else {
        h=Math.atan2(dx,dz); n.heading=h;
        n.x+=Math.sin(h)*KID_SPEED*dt; n.z+=Math.cos(h)*KID_SPEED*dt;
        try{ n.y=heightAt(n.x,n.z); }catch(e){}
      }
    }catch(e){}
  }
  // riders stay glued inside the bus while it moves
  for (i=0;i<b.riders.length;i++){
    n=b.riders[i];
    try{ n.x=b.x; n.z=b.z; n.y=b.y||n.y; }catch(e){}
  }
}

/* dropRiders(b) — at the route terminus, kids get off and resume wandering. */
function dropRiders(b){
  var i, n;
  for (i=0;i<b.riders.length;i++){
    n=b.riders[i];
    try{
      n.onBus=null; n.focus=false; n.stateT=0.2;
      var a=Math.random()*Math.PI*2;
      n.x=b.x+Math.sin(a)*6; n.z=b.z+Math.cos(a)*6;
      try{ n.y=heightAt(n.x,n.z); }catch(e){}
    }catch(e){}
  }
  b.riders.length=0;
}

/* updateBus(b, dt) — one bus tick.
   run: ease toward next stop, brake inside BRAKE_DIST, dwell on arrival.
   boarding: countdown BOARD_TIME with the sign OUT and reds flashing;
     teens walk up and board; at zero the sign retracts and the bus goes.
   At a terminus the bus reverses (shuttle) and drops riders — school buses
   never leave the map. */
function updateBus(b, dt){
  if (b.state==='boarding'){
    b.boardT-=dt; b.speed=0;
    try{ stepKids(b, dt); }catch(e){}
    if (b.boardT<=0){
      b.state='run';
      var nst=b.stops.length;
      if ((b.dir>0 && b.stopIdx===nst-1) || (b.dir<0 && b.stopIdx===0)){
        b.dir*=-1;
        try{ dropRiders(b); }catch(e){}
      }
      b.stopIdx=-1;
    }
  } else {
    var ni=nextStopIdx(b);
    var target=BUS_SPEED;
    if (ni>=0){
      var ds=Math.abs(b.stops[ni]-b.s);
      if (ds<BRAKE_DIST) target=BUS_SPEED*Math.max(0,(ds-3)/BRAKE_DIST);
      if (ds<5){
        b.s=b.stops[ni]; b.state='boarding'; b.boardT=BOARD_TIME;
        b.stopIdx=ni; b.speed=0;
        try{ pickKids(b); }catch(e){}
        try{ if (typeof showToast==='function') showToast('🚌 School bus picking up students — STOP', 2500); }catch(e){}
      }
    }
    if (b.s>=b.path.length-1 || b.s<=1){
      b.s=Math.max(1,Math.min(b.path.length-1,b.s));
      if (b.state!=='boarding') b.dir*=-1;
    }
    b.speed+=(target-b.speed)*Math.min(1,dt*1.8);
    b.s+=b.dir*b.speed*dt;
    b.s=Math.max(0,Math.min(b.path.length,b.s));
  }
  /* pose */
  var p=b.path.posAt(b.s), d=b.path.dirAt(b.s);
  if (b.dir<0){ d=[-d[0],-d[1]]; }
  b.x=p[0]; b.z=p[1];
  b.yaw=Math.atan2(d[0],d[1]);
  var y=b.path.yAt(b.s)+0.06;
  try{ if (typeof clampVehY==='function') y=clampVehY(b.x,b.z,y); }catch(e){}
  b.y=y;
  try{
    b.mesh.position.set(b.x, y, b.z);
    b.mesh.rotation.y=b.yaw;
  }catch(e){}
  /* v1.17 STOP-SIGN ANIMATION: ease signT toward 1 while boarding, 0
     otherwise; slide the sign out from the left side of the bus. */
  var want=(b.state==='boarding')?1:0;
  b.signT+=(want-b.signT)*Math.min(1,dt*3.2);
  if (Math.abs(want-b.signT)<0.01) b.signT=want;
  try{
    var ud=b.mesh.userData;
    if (ud && ud.stopSign) ud.stopSign.position.x=1.32+b.signT*0.8; // 1.32 flush -> 2.12 out
    /* red warning lights alternate while the sign is out */
    if (ud && ud.warnLights){
      var on=b.signT>0.4;
      var ph=Math.floor((performance.now()/450)%2);
      var cA=on&&ph===0?0xff2222:0x551111, cB=on&&ph===1?0xff2222:0x551111;
      ud.warnLights[0].material.color.setHex(cA);
      ud.warnLights[1].material.color.setHex(cB);
    }
  }catch(e){}
}

/* ---------------- init ---------------- */
function initSB(){
  /* Schools that anchor the two routes (verified coordinates). */
  var schools=[[4060,2595],[3554,3185],[3875,3952]];
  var used=[], made=0, si, rd, path, stops, b;
  for (si=0; si<schools.length && made<2; si++){
    try{
      rd=findSchoolRoad(schools[si][0], schools[si][1], used);
      if (!rd) continue;
      used.push(rd.ri);
      path=makePath(rd.pts, rd.ys);
      if (path.length<900) continue;      // too short to be a real route
      stops=[path.length*0.3, path.length*0.55, path.length*0.8];
      b=spawnSchoolBus(path, path.length*0.08, 1, 'SCHOOL BUS');
      b.stops=stops;
      var b2=spawnSchoolBus(path, path.length*0.62, -1, 'SCHOOL BUS');
      b2.stops=stops;
      made++;
    }catch(e){}
  }
  SB.ready=SB.buses.length>0;
  /* Publish the stop-sign law feed: every frame, buses with the sign
     effectively out (signT>0.5) are listed so traffic + the player yield. */
  window.__sbActive=[];
  try{
    if (typeof Report!=='undefined') Report.note('schoolbus',
      { buses: SB.buses.length, note: 'stop-sign law active' });
  }catch(e){}
}

/* ---------------- frame tick (self-installed: wraps animate) ---------------- */
var _lastT=0;
function updateSchoolBusSys(){
  if (!SB.ready) return;
  var now;
  try{ now=performance.now(); }catch(e){ now=0; }
  var dt=_lastT?Math.min(0.06,(now-_lastT)/1000):0.016;
  _lastT=now;
  var i, act=[];
  for (i=0;i<SB.buses.length;i++){
    try{ updateBus(SB.buses[i], dt); }catch(e){}
    try{ if (SB.buses[i].signT>0.5) act.push({x:SB.buses[i].x, z:SB.buses[i].z}); }catch(e){}
  }
  window.__sbActive=act;   // traffic_system + player driving read this
}
var _bootTries=0;
var _bootTimer=setInterval(function(){
  _bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined' && typeof scene!=='undefined' &&
      typeof animate==='function' && typeof roadDrawData!=='undefined' &&
      roadDrawData.length>0 && typeof schoolBusMesh==='function' &&
      typeof heightAt==='function');
  }catch(e){ ready=false; }
  if (ready){
    clearInterval(_bootTimer);
    try{ initSB(); }catch(e){
      try{ if (typeof Report!=='undefined') Report.noteError('schoolbus','init failed',String(e&&e.message||e)); }catch(x){}
    }
    try{
      if (typeof animate==='function' && !animate.__sbWrap){
        var orig=animate;
        var wrapped=function(){ orig(); updateSchoolBusSys(); };
        wrapped.__sbWrap=true;
        animate=wrapped;
      }
    }catch(e){}
  } else if (_bootTries>600){ clearInterval(_bootTimer); }  // give up after 60s, never break the game
}, 100);

})();
