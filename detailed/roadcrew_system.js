/* ============================================================================
   FILE: roadcrew_system.js — "Surviving Adamsville" road crew / dispatch sim
   ----------------------------------------------------------------------------
   PURPOSE: Joshua's in-world repair crews. Patrol trucks drive real road
   polylines looking for broken road data; when a unit finds a known defect
   it radios dispatch, and a repair crew arrives with work-zone signage,
   cones, and detour arrows — works the site, lays fresh asphalt, and leaves.
   KEY SYSTEMS:
     - Defect database (embedded from the Street View audit discrepancies.json):
       structural defects get crews; non-structural ones are logged/monitored.
     - Defect state machine: undiscovered → inspecting → found → dispatched →
       repairing → fixed (persists in localStorage; in-progress states reset
       to undiscovered on reload so the crew re-runs).
     - Patrol units (4): drive road polylines at 14 u/s, rotating Day/Evening/
       Night shifts (24/7 operation), shared stuck.js recovery, drive over
       DEFECTS; discover defects within 70u.
     - Repair jobs: crew truck parked to the side, 4 workers with repair
       animation, ROAD WORK AHEAD signs on both approaches, DETOUR markers,
       16-cone taper, 6 detour ground arrows; job lasts 75s, then a fresh
       asphalt patch is laid permanently.
     - v2.1 cone physics: player can knock cones over (speed >4 u/s, within
       1.2u); nearest idle worker fetches it, stands it back up, returns home.
     - Fallback: an undiscovered structural defect older than 240s is called
       in by a "driver report" (motorist) instead of a patrol unit.
     - Dispatch office building near Fulton Industrial with a live spec board
       (canvas texture listing defects/true specs/status) + lead supervisor.
     - HUD 🚧 button opens the dispatch panel (defects + event log).
   JOSHUA SPECS ENCODED:
     - World accuracy first: the dispatch "reference database" holds what the
       map is SUPPOSED to look like (Street View truth data) so repairs follow
       truth specs, not guesses.
     - 24/7 operation — crews never stand down.
     - Simple sim logic: no pathfinding; crews arrive at sites directly.
     - v2.1: colliders on truck/signs/cones so the player can't walk through
       the work zone; cleanup removes all colliders when the crew leaves.
     - Stuck-loop recovery (Joshua's protocol): a looping road worker files a
       report and requests police assistance — police escort it through the
       grass (the authorized no-grass-rule exception) to the nearest road.
   ============================================================================ */
/* ============================================================================
   SURVIVING ADAMSVILLE — ROAD CREW / DISPATCH SYSTEM (v1.0)
   ----------------------------------------------------------------------------
   Joshua's vision: road crew NPCs patrol the map. When one finds a road that
   doesn't function (gap, disconnect, broken junction) it calls DISPATCH, gets
   the true specs, and a repair crew is sent: warning signs, cones, detour
   roads while they work. The dispatch office holds the reference data (what
   the map is SUPPOSED to look like) so the lead supervisor can direct repairs.

   STANDALONE MODULE. Include AFTER the main game script — zero edits to
   index.html required:

       <script src="roadcrew_system.js"></script>

   What it does:
     1. DISPATCH OFFICE — small building near the Fulton Industrial corridor
        with a spec board (canvas texture listing every flagged defect, its
        true specs from the audit, and live status) + lead supervisor NPC.
     2. PATROL UNITS — 2 road-crew trucks driving real road polylines. When a
        unit comes within discovery range of a structural defect it stops,
        radios dispatch (log + toast), and resumes patrol.
     3. REPAIR RESPONSE — dispatch sends a crew truck + 2 workers to the site.
        They place ROAD WORK AHEAD signs, cones, and DETOUR markers, work for
        a while (repair animation), then lay a fresh asphalt patch, pull the
        signs, and leave. Defect marked FIXED in the dispatch log.
     4. DISPATCH LOG — HUD button (🚧) opens a panel: defects, true specs,
        status, and a timestamped event log. Persists in localStorage.

   Defect truth data is embedded from the Street View audit
   (streetview-audit/discrepancies.json) — the dispatch "reference database".

   Design: simple sim logic (Joshua's rule). No pathfinding (road data is
   fragmented) — patrols follow real road polylines; crews arrive at sites
   directly. Everything guarded: if any dependency is missing the module
   stays off and the game is unaffected.
   ============================================================================ */
(function(){
'use strict';
if (window.__roadcrewV1) return;
window.__roadcrewV1 = true;

/* ---------------- config ---------------- */
var DISCOVER_R   = 70;     // patrol spots a defect inside this radius (u)
var INSPECT_T    = 3;      // seconds the patrol unit stops to "radio in"
var DISPATCH_T   = 6;      // seconds from found -> crew dispatched
var REPAIR_T     = 75;     // seconds the crew works a site
var PATROL_SPEED = 14;
var N_PATROLS    = 2;
var FALLBACK_T   = 240;    // undiscovered after this long -> "driver report"
var LS_KEY       = 'sa_roadcrew_v1';

/* ---------------- defect database (from discrepancies.json) ----------------
   state: undiscovered | inspecting | found | dispatched | repairing | fixed   */
var DEFECTS=[
 {id:'OPEN-1', kind:'road', structural:true, street:'I-20',
  x:4318.5, z:2871.1, patchW:64, patchD:12,
  desc:'I-20 has a 124-unit gap in the data — the highway ribbon ends abruptly and resumes 124 units later with no deck or connector covering it.',
  truth:'Street View: I-20 runs continuously here. Census TIGER 2024 shows 8 real road points through the gap.',
  fix:'Add the 8 missing I-20 points (TIGER 2024) to close the gap.',
  state:'undiscovered'},
 {id:'OPEN-5', kind:'road', structural:true, street:'Utoy Cir SW x Dollar Mill Rd SW',
  x:3160.1, z:3613.7, patchW:22, patchD:14,
  desc:'Possible road stub sticking into the grass where Utoy Cir meets Dollar Mill Rd at the north junction.',
  truth:'Street View (Feb 2025): normal connected intersection, no stub visible. Joshua reported the stub — his ground truth rules.',
  fix:'Square off / trim the stub if confirmed on the ground; otherwise verify and close.',
  state:'undiscovered'},
 /* non-structural: logged at dispatch, monitored, no crew sent */
 {id:'OPEN-2', kind:'sign', structural:false, street:'I-85 / I-75 / I-285 / I-20 signs',
  x:5638.5, z:7345.9,
  desc:'Highway signs read "I- 85" (stray space) on 21 road segments.',
  truth:'Real signs read "I-85" — no space.', fix:'Strip the space in the label data.',
  state:'monitoring'},
 {id:'OPEN-3', kind:'data', structural:false, street:'8 segments named just "SW"',
  x:-128.4, z:5537.2,
  desc:'8 road segments named just "SW" — a data-parsing artifact.',
  truth:'Real names unknown — needs research.', fix:'Research true names, then rename.',
  state:'monitoring'},
 {id:'OPEN-4', kind:'data', structural:false, street:'"Unnamed St" near home base',
  x:2959.6, z:3894.5,
  desc:'1,934 road segments have no name at all ("Unnamed St").',
  truth:'Real names need Street View research, one street at a time.', fix:'Research and name.',
  state:'monitoring'}
];

/* ---------------- state ---------------- */
var RC={ ready:false, tick:0, time:0,
  patrols:[], jobs:[], log:[],
  dispatch:null, boardTex:null, boardCanvas:null,
  patchMeshes:[], uiBuilt:false, panelOpen:false, repT:0,
  badSegs:[] };   // road segments a unit got stuck on — skipped on reassign

/* ---------------- tiny helpers ---------------- */
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function dist2(ax,az,bx,bz){ var dx=ax-bx,dz=az-bz; return dx*dx+dz*dz; }  // squared dist — avoids sqrt in hot scans
function groundY(x,z){ try{ var y=heightAt(x,z); return isFinite(y)?y:0; }catch(e){ return 0; } }
function toast(msg,ms){ try{ if(typeof showToast==='function') showToast(msg,ms||2600); }catch(e){} }
function nowT(){ var d=new Date(); function p(n){return (n<10?'0':'')+n;} return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }

/* dlog(msg) — timestamped dispatch event log. Capped at 60 entries,
   persisted to localStorage, refreshes the HUD panel + spec board, and
   reports to the Report panel. Every notable road-crew event goes here. */
function dlog(msg){
  RC.log.push({t:nowT(), msg:msg});
  if (RC.log.length>60) RC.log.splice(0, RC.log.length-60);
  saveLS(); refreshPanel(); refreshBoard();
  try{ Report.setSys('roadcrew', sysReport()); }catch(e){}
}
function sysReport(){
  var st={}; DEFECTS.forEach(function(d){ st[d.id]=d.state; });
  return {status:'ok', version:'1.0', defects:st,
    activeRepairs:RC.jobs.length, patrols:RC.patrols.length,
    logEntries:RC.log.length,
    note:'road crew patrols 24/7 + dispatch office + repair crews (audit-driven)'};
}

/* ---------------- persistence ---------------- */
function saveLS(){
  try{
    var st={}; DEFECTS.forEach(function(d){ st[d.id]=d.state; });
    localStorage.setItem(LS_KEY, JSON.stringify({defects:st, log:RC.log.slice(-60)}));
  }catch(e){}
}
function loadLS(){
  try{
    var raw=localStorage.getItem(LS_KEY); if(!raw) return;
    var d=JSON.parse(raw);
    if (d.defects) DEFECTS.forEach(function(x){
      var s=d.defects[x.id];
      if (s==='fixed' && x.structural) x.state='fixed';
      /* in-progress states reset to undiscovered on reload — crew re-runs */
    });
    if (d.log && d.log.length) RC.log=d.log;
  }catch(e){}
}

/* ---------------- canvas texture helpers ---------------- */
function makeCanvas(w,h){
  var c=document.createElement('canvas'); c.width=w; c.height=h;
  return {c:c, ctx:c.getContext('2d')};
}
function signTexture(main, sub){
  var k=makeCanvas(512,320), x=k.ctx;
  x.fillStyle='#e8641b'; x.fillRect(0,0,512,320);
  x.strokeStyle='#111'; x.lineWidth=14; x.strokeRect(10,10,492,300);
  x.fillStyle='#111'; x.textAlign='center'; x.textBaseline='middle';
  x.font='bold 64px sans-serif';
  var words=main.split(' '), lines=[], line='';
  words.forEach(function(w){ if((line+' '+w).trim().length>12){ lines.push(line.trim()); line=w; } else line+=' '+w; });
  lines.push(line.trim());
  var y0=160-(lines.length-1)*38-(sub?28:0);
  lines.forEach(function(L,i){ x.fillText(L,256,y0+i*76); });
  if (sub){ x.font='bold 40px sans-serif'; x.fillText(sub,256,y0+lines.length*76-8); }
  var t=new THREE.CanvasTexture(k.c); t.anisotropy=2; return t;
}
function boardTexture(){
  var k=makeCanvas(640,480), x=k.ctx;
  function draw(){
    x.fillStyle='#20242e'; x.fillRect(0,0,640,480);
    x.fillStyle='#ffd75e'; x.textAlign='left'; x.textBaseline='top';
    x.font='bold 30px sans-serif';
    x.fillText('ROAD DISPATCH — SPEC BOARD', 18, 14);
    x.font='20px sans-serif'; x.fillStyle='#9fb2cc';
    x.fillText('true specs from Street View audit', 18, 50);
    var y=92;
    DEFECTS.forEach(function(d){
      var col = d.state==='fixed' ? '#51d651' :
                d.state==='repairing'||d.state==='dispatched' ? '#ffb02e' :
                d.state==='found'||d.state==='inspecting' ? '#6ec6ff' : '#c9c9c9';
      x.fillStyle=col; x.font='bold 22px sans-serif';
      x.fillText(d.id+'  '+d.street, 18, y);
      x.fillStyle='#8a93a6'; x.font='19px sans-serif';
      var st=d.state.toUpperCase();
      x.fillText('status: '+st, 18, y+26);
      y+=62;
      if (y>430) return;
    });
    x.fillStyle='#5a6376'; x.font='18px sans-serif';
    x.fillText('supervisor on duty — repairs auto-dispatched', 18, 446);
  }
  draw();
  var t=new THREE.CanvasTexture(k.c); t.anisotropy=2;
  return {tex:t, redraw:function(){ draw(); t.needsUpdate=true; }};
}
function labelSprite(text){
  var k=makeCanvas(512,128), x=k.ctx;
  x.fillStyle='rgba(20,24,34,0.85)';
  var w=x.measureText(text).width;
  x.font='bold 52px sans-serif';
  var tw=x.measureText(text).width;
  x.fillRect(256-tw/2-24, 14, tw+48, 100);
  x.strokeStyle='#ffb02e'; x.lineWidth=6;
  x.strokeRect(256-tw/2-24, 14, tw+48, 100);
  x.fillStyle='#ffb02e'; x.textAlign='center'; x.textBaseline='middle';
  x.fillText(text, 256, 66);
  var t=new THREE.CanvasTexture(k.c);
  var m=new THREE.SpriteMaterial({map:t, depthTest:false, transparent:true});
  var s=new THREE.Sprite(m); s.scale.set(26,6.5,1); return s;
}

/* ---------------- mesh factories (stylized, low-poly) ---------------- */
function mat(color, emissive){
  return new THREE.MeshLambertMaterial({color:color, emissive:emissive||0x000000});
}
function box(w,h,d,color,emissive){
  return new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat(color,emissive));
}
/* work truck: cab + utility bed + light bar. faces +Z. */
function makeWorkTruck(){
  var g=new THREE.Group();
  var white=0xf2f2f2, orange=0xe8641b, dark=0x222226;
  var chassis=box(2.2,0.5,5.4,dark); chassis.position.y=0.55; g.add(chassis);
  var cab=box(2.2,1.5,1.9,white); cab.position.set(0,1.55,1.6); g.add(cab);
  var shield=box(1.9,0.8,0.12,0x1c2733); shield.position.set(0,1.7,2.56); g.add(shield);
  var bed=box(2.2,1.0,2.9,white); bed.position.set(0,1.3,-1.0); g.add(bed);
  var stripe=box(2.24,0.3,2.94,orange); stripe.position.set(0,1.35,-1.0); g.add(stripe);
  var bar=box(1.3,0.28,0.45,orange,0xcc5500); bar.position.set(0,2.45,1.6); g.add(bar);
  g.userData.lightBar=bar;
  /* rear arrow board — the unmistakable road-crew signature: chevron panel */
  var ak=makeCanvas(256,128), ax2=ak.ctx;
  ax2.fillStyle='#1a1a1a'; ax2.fillRect(0,0,256,128);
  ax2.fillStyle='#ffb02e';
  for (var ci=0;ci<3;ci++){
    var cx0=40+ci*64;
    ax2.beginPath();
    ax2.moveTo(cx0,14); ax2.lineTo(cx0+44,64); ax2.lineTo(cx0,114);
    ax2.lineTo(cx0+26,114); ax2.lineTo(cx0+70,64); ax2.lineTo(cx0+26,14);
    ax2.closePath(); ax2.fill();
  }
  var atx=new THREE.CanvasTexture(ak.c);
  var aboard=new THREE.Mesh(new THREE.PlaneGeometry(2.6,1.3),
    new THREE.MeshLambertMaterial({map:atx, emissive:0x664400, side:THREE.DoubleSide}));
  aboard.position.set(0,2.6,-2.55); aboard.rotation.y=Math.PI; g.add(aboard);
  g.userData.arrowBoard=aboard;
  var wg=new THREE.CylinderGeometry(0.45,0.45,0.35,10);
  var wm=mat(0x141414);
  [[-1.05,1.7],[1.05,1.7],[-1.05,-1.5],[1.05,-1.5]].forEach(function(p){
    var w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2;
    w.position.set(p[0],0.45,p[1]); g.add(w);
  });
  g.userData.wheels=[];
  return g;
}
/* road worker figure: hi-vis uniform — instantly recognizable as the repair
   crew. Bright safety-orange vest with reflective stripes (emissive so it
   pops at any distance), yellow hard hat. Nobody else in the game dresses
   like this. */
function makeWorker(hatColor){
  var g=new THREE.Group();
  var legs=box(0.5,0.7,0.34,0x2e3a55); legs.position.y=0.35; g.add(legs);
  // hi-vis vest: brighter orange + emissive
  var torso=new THREE.Mesh(new THREE.BoxGeometry(0.62,0.72,0.4),
    new THREE.MeshLambertMaterial({color:0xff6a00, emissive:0x5e2400}));
  torso.position.y=1.06; g.add(torso);
  // two reflective stripes
  var s1=new THREE.Mesh(new THREE.BoxGeometry(0.64,0.1,0.42),
    new THREE.MeshLambertMaterial({color:0xf2f2f2, emissive:0x555555}));
  s1.position.y=1.18; g.add(s1);
  var s2=s1.clone(); s2.position.y=0.98; g.add(s2);
  var head=box(0.36,0.36,0.36,0x6b4429); head.position.y=1.6; g.add(head);
  var hat=new THREE.Mesh(new THREE.BoxGeometry(0.44,0.16,0.44),
    new THREE.MeshLambertMaterial({color:hatColor||0xf5d020, emissive:0x333300}));
  hat.position.y=1.84; g.add(hat);
  var armL=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.6,0.16),
    new THREE.MeshLambertMaterial({color:0xff6a00, emissive:0x5e2400}));
  armL.position.set(-0.4,1.05,0); g.add(armL);
  var armR=armL.clone(); armR.position.set(0.4,1.05,0); g.add(armR);
  g.userData.armL=armL; g.userData.armR=armR;
  return g;
}
/* warning sign: posts + textured panel. */
function makeSign(main, sub){
  var g=new THREE.Group();
  var p1=box(0.18,3.2,0.18,0x555c66); p1.position.set(-1.2,1.6,0); g.add(p1);
  var p2=box(0.18,3.2,0.18,0x555c66); p2.position.set(1.2,1.6,0); g.add(p2);
  var panel=new THREE.Mesh(new THREE.PlaneGeometry(4.4,2.75),
    new THREE.MeshLambertMaterial({map:signTexture(main,sub), side:THREE.DoubleSide}));
  panel.position.y=3.4; g.add(panel);
  return g;
}
/* detour arrow marker laid flat on the ground. */
function makeDetourArrow(){
  var k=makeCanvas(128,128), x=k.ctx;
  x.fillStyle='#e8641b';
  x.beginPath();
  x.moveTo(64,8); x.lineTo(112,70); x.lineTo(80,70);
  x.lineTo(80,120); x.lineTo(48,120); x.lineTo(48,70); x.lineTo(16,70);
  x.closePath(); x.fill();
  var t=new THREE.CanvasTexture(k.c);
  var m=new THREE.Mesh(new THREE.PlaneGeometry(3,3),
    new THREE.MeshLambertMaterial({map:t, transparent:true, side:THREE.DoubleSide}));
  m.rotation.x=-Math.PI/2; m.position.y=0.12;
  return m;
}
/* cone field (instanced) for one work zone. */
function makeCones(cx,cz,y,heading){
  var n=16;
  var geo=new THREE.ConeGeometry(0.55,1.15,8);
  var im=new THREE.InstancedMesh(geo, mat(0xe8641b), n);
  var m4=new THREE.Matrix4(), q=new THREE.Quaternion(), s=new THREE.Vector3(1,1,1), p=new THREE.Vector3();
  var hx=Math.sin(heading), hz=Math.cos(heading);
  var px=hz, pz=-hx;   // perpendicular
  for (var i=0;i<n;i++){
    var t=i/(n-1), lx=(t-0.5)*26;         // 26u taper line across the road
    var off=4+Math.sin(t*Math.PI)*6;      // bow outward around the work area
    var x=cx+hx*lx+px*off, z=cz+hz*lx+pz*off;
    p.set(x, groundY(x,z)+0.58, z); q.identity(); s.set(1,1,1);
    m4.compose(p,q,s); im.setMatrixAt(i,m4);
  }
  im.instanceMatrix.needsUpdate=true;
  im.frustumCulled=false;
  return im;
}
/* fresh asphalt patch laid after a repair. */
function makePatch(d, heading){
  var g=new THREE.PlaneGeometry(d.patchW||24, d.patchD||12);
  var m=new THREE.Mesh(g, mat(0x232326));
  m.rotation.x=-Math.PI/2; m.rotation.z=-heading;
  m.position.set(d.x, groundY(d.x,d.z)+0.08, d.z);
  return m;
}

/* ---------------- road helpers ---------------- */
/* nearestRoad(x,z,highwayOnly) — brute-force nearest road lookup over every
   roadDrawData point. highwayOnly=true → highways only; false → non-highways
   only; undefined → any road. Returns {seg, idx (nearest point index),
   dist} or null. O(road points) — fine at spawn/recovery time, NOT per frame. */
function nearestRoad(x,z,highwayOnly){
  var best=null, bestD=1e18, bestI=0;
  try{
    for (var i=0;i<roadDrawData.length;i++){
      var r=roadDrawData[i];
      if (!r||!r.pts||r.pts.length<2) continue;
      if (highwayOnly && r.cat!=='highway') continue;
      if (highwayOnly===false && r.cat==='highway') continue;
      for (var j=0;j<r.pts.length;j++){
        var p=r.pts[j], d=dist2(x,z,p[0],p[1]);
        if (d<bestD){ bestD=d; best=r; bestI=j; }
      }
    }
  }catch(e){}
  return best?{seg:best, idx:bestI, dist:Math.sqrt(bestD)}:null;
}
/* roadHeadingAt(nr) — heading (atan2 yaw) of the road at the nearestRoad
   result's point index, clamped to a valid segment. Used to align work
   zones, cones, and signs with the road's direction. */
function roadHeadingAt(nr){
  try{
    var pts=nr.seg.pts, i=clamp(nr.idx,0,pts.length-2);
    var a=pts[i], b=pts[i+1];
    return Math.atan2(b[0]-a[0], b[1]-a[1]);
  }catch(e){ return 0; }
}

/* ---------------- patrol units ---------------- */
/* spawnPatrol(unitNo, dx, dz, highway) — places one patrol truck on the
   nearest road to (dx,dz) and starts it a quarter-segment down the polyline
   so Joshua sees it driving before it discovers anything. Patrol 1 rides
   highways (covers the I-20 gap OPEN-1); the others ride non-highways. */
function spawnPatrol(unitNo, dx, dz, highway){
  var nr=nearestRoad(dx,dz,highway);
  if (!nr) return null;
  var truck=makeWorkTruck();
  var p0=nr.seg.pts[nr.idx];
  var _ty=groundY(p0[0],p0[1]);
  if (typeof clampVehY==='function') _ty=clampVehY(p0[0],p0[1],_ty);  // v1.12 ground clamp
  truck.position.set(p0[0], _ty, p0[1]);
  scene.add(truck);
  // start a quarter-segment away so the unit is seen driving before it finds anything
  var startI=clamp(Math.round(nr.idx+nr.seg.pts.length/4), 0, nr.seg.pts.length-1);
  var u={no:unitNo, mesh:truck, seg:nr.seg, i:startI, dir:1,
         speed:PATROL_SPEED, pauseT:0, target:null, blink:Math.random()*2};
  RC.patrols.push(u);
  return u;
}
/* patrolTarget(u) — the nearest STRUCTURAL, still-undiscovered defect to the
   unit. Used for the discovery check only (units discover by proximity, they
   don't pathfind to the defect — simple sim logic per Joshua's rule). */
function patrolTarget(u){
  var best=null, bd=1e18;
  DEFECTS.forEach(function(d){
    if (!d.structural || d.state!=='undiscovered') return;
    var dd=dist2(u.mesh.position.x,u.mesh.position.z,d.x,d.z);
    if (dd<bd){ bd=dd; best=d; }
  });
  return best;
}
/* 24/7 operation: crews never stand down. Patrol units rotate through
   Day / Evening / Night shifts so the map is always being watched. */
var SHIFTS=['Day','Evening','Night'], SHIFT_LEN=240;
function patrolShift(u){
  return SHIFTS[Math.floor(RC.time/SHIFT_LEN+u.no)%3];
}
/* ---------------- stuck-loop recovery (shared stuck.js module) ---------------- */
/* stuckRecoverRoadCrew(u) — wraps the shared recoverStuckUnit() with road-crew
   context: logs to the dispatch log, blacklists the bad segment in
   RC.badSegs (skipped on future reassignment), and repositions the truck
   onto the nearest road with a cleared target. This is Joshua's stuck-loop
   recovery protocol: the unit recognizes it can't finish its travel, files a
   report, and requests police assistance — police escort it through the grass
   (the one authorized exception to the no-grass rule) back to a road. */
function stuckRecoverRoadCrew(u){
  if (typeof recoverStuckUnit!=='function') return;
  recoverStuckUnit(u, {
    unitLabel:'Unit '+u.no,
    log:function(m){ dlog(m); },
    toast:function(m){ toast(m); },
    nearestRoad:function(x,z){ return nearestRoad(x,z); },  // any road
    blacklist:RC.badSegs,
    reposition:function(u2,nr){
      var p0=nr.seg.pts[nr.idx];
      u2.seg=nr.seg; u2.i=nr.idx; u2.dir=1; u2.pauseT=0; u2.target=null;
      var _ry=groundY(p0[0],p0[1])+0.05;
      if (typeof clampVehY==='function') _ry=clampVehY(p0[0],p0[1],_ry);  // v1.12 ground clamp
      u2.mesh.position.set(p0[0], _ry, p0[1]);
      if (u2.stuck) u2.stuck.noteRecovery();
    }
  });
}
/* updatePatrol(u, dt) — per-frame patrol logic:
   1. Rotate shifts (Day/Evening/Night, 240s each — logged for flavor).
   2. If paused to inspect a defect: flash the light bar, count down
      INSPECT_T; when done, mark the defect 'found' and schedule a repair
      crew via DISPATCH_T (6s delay) — skipped if the defect's state moved
      on meanwhile.
   3. Run stuck-loop sampling (shared StuckDetector; NOT while legitimately
      paused — a stopped truck inspecting a defect isn't stuck).
   4. Drive along the road polyline at PATROL_SPEED, bouncing off the ends.
   5. Discovery: when within DISCOVER_R (70u) of an undiscovered structural
      defect, stop and inspect (INSPECT_T seconds). */
function updatePatrol(u, dt){
  var m=u.mesh;
  var sh=patrolShift(u);
  if (u.shift!==sh){
    u.shift=sh;
    dlog('Unit '+u.no+' — '+sh+' shift on duty. Road crew runs 24/7.');
  }
  if (u.pauseT>0){
    u.pauseT-=dt;
    // radio flash while calling dispatch
    var b=u.mesh.userData.lightBar;
    if (b) b.visible=(RC.tick%10<5);
    if (u.pauseT<=0 && u.target){
      var d=u.target; u.target=null;
      d.state='found';
      dlog('Unit '+u.no+' found defect '+d.id+' ('+d.street+') — radioed dispatch.');
      toast('🚧 Road crew found a road defect ('+d.street+') — dispatch notified');
      setTimeout(function(){
        if (d.state!=='found') return;
        d.state='dispatched';
        dlog('Dispatch pulled true specs for '+d.id+': "'+d.truth+'" — sending repair crew.');
        dispatchRepair(d);
      }, DISPATCH_T*1000);
    }
    return;
  }
  // stuck-loop detection (shared stuck.js module) — not sampled while
  // legitimately paused inspecting a defect
  if (typeof StuckDetector!=='undefined'){
    if (!u.stuck) u.stuck=new StuckDetector();
    if (u.stuck.sample(m.position.x, m.position.z, dt)) stuckRecoverRoadCrew(u);
  }
  // drive along the polyline
  var pts=u.seg.pts, n=pts.length;
  var a=pts[clamp(Math.round(u.i),0,n-1)], b=pts[clamp(Math.round(u.i)+u.dir,0,n-1)];
  var dx=b[0]-a[0], dz=b[1]-a[1], L=Math.hypot(dx,dz)||1;
  u.i+=u.dir*(u.speed*dt)/L;
  if (u.i>=n-1){ u.i=n-1; u.dir=-1; }
  if (u.i<=0){ u.i=0; u.dir=1; }
  var t=u.i-Math.floor(u.i), i0=clamp(Math.floor(u.i),0,n-2);
  var p=pts[i0], q=pts[i0+1];
  var x=p[0]+(q[0]-p[0])*t, z=p[1]+(q[1]-p[1])*t;
  var _cy=groundY(x,z)+0.05;
  if (typeof clampVehY==='function') _cy=clampVehY(x,z,_cy);  // v1.12: ground clamp — no sky-floaters
  m.position.set(x, _cy, z);
  var hd=Math.atan2((q[0]-p[0])*u.dir,(q[1]-p[1])*u.dir);
  m.rotation.y=hd;
  var bar=m.userData.lightBar; if (bar) bar.visible=(RC.tick%20<10);
  // discovery check
  if (!u.target) u.target=patrolTarget(u);
  if (u.target){
    var d=u.target;
    if (d.state!=='undiscovered'){ u.target=null; }
    else if (dist2(x,z,d.x,d.z) < DISCOVER_R*DISCOVER_R){
      u.pauseT=INSPECT_T;
      d.state='inspecting';
      dlog('Unit '+u.no+' stopped at suspected defect near '+d.street+' — inspecting.');
    }
  }
}

/* ---------------- dispatch office ---------------- */
function clearGround(x,z){
  try{ if (typeof onRoad==='function' && onRoad(x,z)) return false; }catch(e){}
  return true;
}
function buildDispatch(){
  // near the Fulton Industrial corridor, by the warehouses
  var bx=2100, bz=3700, ok=false;
  outer:
  for (var r=0;r<60;r+=8){
    for (var a=0;a<8;a++){
      var x=bx+Math.cos(a/8*Math.PI*2)*r, z=bz+Math.sin(a/8*Math.PI*2)*r;
      if (clearGround(x,z)){ bx=x; bz=z; ok=true; break outer; }
    }
  }
  var y=groundY(bx,bz);
  var g=new THREE.Group();
  var hall=box(14,5,10,0xd8cfc0); hall.position.y=2.5; g.add(hall);
  var roof=box(15,0.7,11,0x3a3f4a); roof.position.y=5.3; g.add(roof);
  var door=box(2.2,3.4,0.3,0x2a2d33); door.position.set(0,1.7,5.05); g.add(door);
  for (var i=-1;i<=1;i++){
    var win=box(2.4,1.6,0.25,0x9fc6e8); win.position.set(i*4.4,3.1,5.05); g.add(win);
  }
  var sign=new THREE.Mesh(new THREE.PlaneGeometry(9,2.2),
    new THREE.MeshLambertMaterial({map:signTexture('ROAD DISPATCH','OPEN 24/7 — CITY OF ADAMSVILLE'), side:THREE.DoubleSide}));
  sign.position.set(0,6.6,5.1); g.add(sign);
  // spec board on posts out front
  var post1=box(0.3,4.4,0.3,0x555c66); post1.position.set(-3.2,2.2,8.5); g.add(post1);
  var post2=box(0.3,4.4,0.3,0x555c66); post2.position.set(3.2,2.2,8.5); g.add(post2);
  var bt=boardTexture(); RC.boardTex=bt;
  var board=new THREE.Mesh(new THREE.PlaneGeometry(7.2,5.4),
    new THREE.MeshLambertMaterial({map:bt.tex, side:THREE.DoubleSide}));
  board.position.set(0,3.4,8.5); board.rotation.y=0; g.add(board);
  // lead supervisor by the door
  var sup=makeWorker(0xf5f5f5); sup.position.set(3.4,0,5.9); g.add(sup);
  // floating label
  var label=labelSprite('🚧 DISPATCH OFFICE');
  label.position.set(0,10.5,0); g.add(label);
  g.position.set(bx,y,bz);
  g.rotation.y=Math.PI; // face the road side
  scene.add(g);
  RC.dispatch={x:bx, z:bz, group:g, label:label};
  dlog('Dispatch office open near Fulton Industrial corridor — spec board holds the audit truth data.');
}
function refreshBoard(){
  try{ if (RC.boardTex) RC.boardTex.redraw(); }catch(e){}
}

/* ---------------- repair jobs ---------------- */
/* dispatchRepair(d) — sends the repair crew: crew truck parked 14u to the
   side, 4 workers at the defect, ROAD WORK AHEAD signs on both approaches
   (58u out, 7u off the shoulder, facing oncoming traffic), DETOUR markers,
   a 16-cone taper, and 6 ground detour arrows curving around the zone. All
   colliders are tracked on the job so the whole work zone can be cleaned up
   when the crew leaves. defect state → 'repairing'. */
function dispatchRepair(d){
  var nr=nearestRoad(d.x,d.z, d.id==='OPEN-1');
  var heading=nr?roadHeadingAt(nr):0;
  var y=groundY(d.x,d.z);
  var hx=Math.sin(heading), hz=Math.cos(heading);
  var px=hz, pz=-hx;
  var grp=new THREE.Group(); scene.add(grp);
  // crew truck parked to the side
  var truck=makeWorkTruck();
  var tx=d.x+px*14, tz=d.z+pz*14;
  truck.position.set(tx, groundY(tx,tz)+0.05, tz);
  truck.rotation.y=heading+0.3; grp.add(truck);
  // v2.1: solid truck — player can't walk through it
  var truckCol=null;
  try{ if(typeof addCollider==='function'){
    var tc={x:tx, z:tz, r:3.2, y0:-1e9, y1:1e9};
    colliders.push(tc); truckCol=tc;
  }}catch(e){}
  // four workers at the defect (crew doubled)
  var workers=[];
  [[-4,2],[4,-3],[-4,-3],[4,2]].forEach(function(o){
    var w=makeWorker();
    var wx=d.x+o[0], wz=d.z+o[1];
    w.position.set(wx, groundY(wx,wz), wz);
    w.rotation.y=Math.random()*6.28; grp.add(w); workers.push(w);
  });
  // signs: ROAD WORK AHEAD both approaches + DETOUR pair
  var signs=[];
  var signCols=[];  // v2.1: track for cleanup
  [[-58,0],[58,0]].forEach(function(o){
    var s=makeSign('ROAD WORK AHEAD','');
    var sx=d.x+hx*o[0]+px*7, sz=d.z+hz*o[0]+pz*7;
    s.position.set(sx, groundY(sx,sz), sz);
    s.rotation.y=heading+(o[0]<0?0:Math.PI); grp.add(s); signs.push(s);
    try{ if(typeof addCollider==='function'){
      var sc={x:sx, z:sz, r:0.4, y0:-1e9, y1:1e9};
      colliders.push(sc); signCols.push(sc);
    }}catch(e){}
  });
  [[-30,1],[30,1]].forEach(function(o){
    var s=makeSign('DETOUR','FOLLOW ARROWS');
    var sx=d.x+hx*o[0]-px*9, sz=d.z+hz*o[0]-pz*9;
    s.position.set(sx, groundY(sx,sz), sz);
    s.rotation.y=heading+(o[0]<0?0:Math.PI); grp.add(s); signs.push(s);
    try{ if(typeof addCollider==='function'){
      var sc2={x:sx, z:sz, r:0.4, y0:-1e9, y1:1e9};
      colliders.push(sc2); signCols.push(sc2);
    }}catch(e){}
  });
  // cones taper + detour arrow trail curving around the zone
  var coneData=makeCones(d.x,d.z,y,heading); grp.add(coneData.mesh);
  var cones=coneData.mesh, conePos=coneData.positions;
  // v2.1: small colliders per cone (knockable — see updateJobs)
  var coneCols=[];
  conePos.forEach(function(cp){
    try{ if(typeof addCollider==='function'){
      var cc={x:cp.x, z:cp.z, r:0.5, y0:-1e9, y1:1e9, _cone:cp, _job:null};
      colliders.push(cc); coneCols.push(cc); cp._collider=cc;
    }}catch(e){}
  });
  var arrows=[];
  for (var i=0;i<6;i++){
    var t=i/5, ax=d.x+hx*(t-0.5)*70-px*(10+Math.sin(t*Math.PI)*10);
    var az=d.z+hz*(t-0.5)*70-pz*(10+Math.sin(t*Math.PI)*10);
    var ar=makeDetourArrow();
    ar.position.set(ax, groundY(ax,az)+0.12, az);
    ar.rotation.z=-heading;
    grp.add(ar); arrows.push(ar);
  }
  d.state='repairing';
  var job={defect:d, group:grp, truck:truck, workers:workers,
    signs:signs, cones:cones, conePos:conePos, arrows:arrows, t:0, heading:heading,
    truckCol:truckCol, signCols:signCols, coneCols:coneCols};
  // link cone colliders back to this job for knock-over handling
  coneCols.forEach(function(cc){ cc._job=job; });
  // store worker home positions for fetch-and-return behavior
  workers.forEach(function(w){ w.userData.homeX=w.position.x; w.userData.homeZ=w.position.z; w.userData.fetchState=null; });
  RC.jobs.push(job);
  dlog('Repair crew on site at '+d.id+' ('+d.street+') — signs, cones and detour placed.');
  toast('🚧 Repair crew working on '+d.street+' — detour in place');
  try{ Report.setSys('roadcrew', sysReport()); }catch(e){}
}
/* finishRepair(job) — end of the 75s work window: lays the fresh asphalt
   patch (permanent, re-laid on later loads for already-fixed defects),
   removes EVERY work-zone collider (truck, signs, cones — so no invisible
   walls linger after the crew leaves), deletes the work-zone group, marks
   the defect 'fixed', and persists to localStorage. */
function finishRepair(job){
  var d=job.defect;
  // lay the fresh asphalt patch
  var patch=makePatch(d, job.heading);
  scene.add(patch); RC.patchMeshes.push(patch);
  // v2.1: remove all work-zone colliders
  try{
    if(typeof removeCollider==='function'){
      if(job.truckCol) removeCollider(job.truckCol);
      (job.signCols||[]).forEach(function(c){ removeCollider(c); });
      (job.coneCols||[]).forEach(function(c){ removeCollider(c); });
    }else if(typeof colliders!=='undefined'){
      // fallback: filter by identity
      var doomed={};
      if(job.truckCol) doomed[colliders.indexOf(job.truckCol)]=1;
      (job.signCols||[]).forEach(function(c){ doomed[colliders.indexOf(c)]=1; });
      (job.coneCols||[]).forEach(function(c){ doomed[colliders.indexOf(c)]=1; });
      for(var di=colliders.length-1;di>=0;di--){ if(doomed[di]) colliders.splice(di,1); }
    }
  }catch(e){}
  // pull the work zone
  scene.remove(job.group);
  d.state='fixed';
  dlog(d.id+' ('+d.street+') REPAIRED — fresh asphalt laid per true specs. Crew clear.');
  toast('✅ '+d.street+' repaired — road is fixed');
  saveLS();
  try{ Report.setSys('roadcrew', sysReport()); }catch(e){}
  refreshBoard(); refreshPanel();
}
/* updateConePhysics(j, dt) — cone knock-over + worker fetch-and-replace:
   a cone counts as knocked when the player is within 1.2u AND moving faster
   than 4 u/s (brush-bys don't count). The knocked cone's collider is removed
   (so the player can walk past), then the nearest idle worker is assigned a
   fetchState ('goto' → walk to cone, stand it back up, restore collider →
   'return' → walk home). Workers on a fetch are skipped by the repair
   animation. Only one knock per frame max (break). */
function updateConePhysics(j, dt){
  var px=0, pz=0, pSpeed=0;
  try{
    if(typeof player!=='undefined' && player.mesh){
      px=player.mesh.position.x; pz=player.mesh.position.z;
      pSpeed=Math.hypot(player.vx||0, player.vz||0);
      // fallback: estimate from position delta
      if(!pSpeed && player._lx!==undefined){
        pSpeed=Math.hypot(px-player._lx, pz-player._lz)/Math.max(dt,0.001);
      }
      player._lx=px; player._lz=pz;
    }
  }catch(e){ return; }
  if(!j.conePos) return;
  for(var ci=0; ci<j.conePos.length; ci++){
    var cp=j.conePos[ci];
    if(!cp.standing) continue;  // already knocked
    var dx=px-cp.x, dz=pz-cp.z;
    var d=Math.hypot(dx,dz);
    // player hit the cone hard (within 1.2u and moving fast)
    if(d < 1.2 && pSpeed > 4){
      cp.standing=false;
      tipCone(j.cones, cp);
      // remove its collider so player can walk past the fallen cone
      try{ if(cp._collider && typeof removeCollider==='function') removeCollider(cp._collider); }catch(e){}
      // assign nearest idle worker to fetch it
      var best=null, bestD=1e18;
      j.workers.forEach(function(w){
        if(w.userData.fetchState) return;  // already on a fetch
        var wd=Math.hypot(w.position.x-cp.x, w.position.z-cp.z);
        if(wd<bestD){ bestD=wd; best=w; }
      });
      if(best){
        best.userData.fetchState={cone:cp, phase:'goto', tx:cp.x, tz:cp.z};
        try{ dlog('Worker '+ (j.workers.indexOf(best)+1) +' going to reset a knocked cone.'); }catch(e){}
      }
      break;  // one knock per frame max
    }
  }
  // worker fetch-and-return state machine
  j.workers.forEach(function(w){
    var fs=w.userData.fetchState;
    if(!fs) return;
    var tx=fs.tx, tz=fs.tz;
    if(fs.phase==='return'){
      tx=w.userData.homeX; tz=w.userData.homeZ;
    }
    var dx=tx-w.position.x, dz=tz-w.position.z;
    var d=Math.hypot(dx,dz);
    var spd=6;  // worker walk speed
    if(d < 0.8){
      if(fs.phase==='goto'){
        // pick up the cone: stand it back up, restore collider
        var cp=fs.cone;
        cp.standing=true;
        standCone(j.cones, cp);
        try{
          if(typeof addCollider==='function' && cp._collider){
            // re-add only if not already present
            if(colliders.indexOf(cp._collider)<0) colliders.push(cp._collider);
          }
        }catch(e){}
        fs.phase='return';
      }else{
        // back home — resume work
        w.userData.fetchState=null;
        w.position.x=w.userData.homeX; w.position.z=w.userData.homeZ;
      }
    }else{
      // walk toward target
      var step=Math.min(d, spd*dt);
      w.position.x+=dx/d*step; w.position.z+=dz/d*step;
      try{ w.position.y=groundY(w.position.x, w.position.z); }catch(e){}
      w.rotation.y=Math.atan2(dx,dz);
      // walking bob
      w.position.y+=Math.abs(Math.sin(RC.time*10))*0.08;
    }
  });
}
/* updateJobs(dt) — per-frame job ticks: repair animation (workers bob and
   swing arms; workers on a cone-fetch are skipped), cone physics, light-bar
   flash; at REPAIR_T (75s) the job finishes and is removed. */
function updateJobs(dt){
  for (var i=RC.jobs.length-1;i>=0;i--){
    var j=RC.jobs[i]; j.t+=dt;
    // workers: repair animation OR fetch-and-return (not both)
    j.workers.forEach(function(w,k){
      if(w.userData.fetchState) return;  // handled by updateConePhysics
      w.position.y+=Math.sin(RC.time*7+k*2.4)*0.012;
      w.rotation.y+=Math.sin(RC.time*1.3+k)*0.01;
      var a=w.userData.armR; if(a) a.rotation.x=Math.sin(RC.time*7+k)*0.7;
    });
    try{ updateConePhysics(j, dt); }catch(e){}
    var bar=j.truck.userData.lightBar; if (bar) bar.visible=(RC.tick%14<7);
    if (j.t>=REPAIR_T){
      finishRepair(j);
      RC.jobs.splice(i,1);
    }
  }
}

/* ---------------- HUD: dispatch button + log panel ---------------- */
function buildUI(){
  if (RC.uiBuilt) return; RC.uiBuilt=true;
  try{
    var css=document.createElement('style');
    css.textContent=
      '#rc-btn{position:fixed;left:76px;top:10px;z-index:20;width:52px;height:52px;border-radius:12px;'+
      'border:2px solid #ffb02e;background:rgba(20,24,34,.88);color:#ffb02e;font-size:24px;}'+
      '@media (max-width:820px),(pointer:coarse){#rc-btn{left:90px!important;top:52px!important;bottom:auto!important;}}'+
      '#rc-panel{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);}'+
      '#rc-panel.show{display:flex;}'+
      '#rc-panel .card{background:#161b26;border-radius:14px;padding:20px 22px;max-width:470px;width:88%;max-height:74vh;display:flex;flex-direction:column;}'+
      '#rc-panel h3{margin:0 0 4px 0;color:#ffb02e;}'+
      '#rc-panel .sub{color:#8a93a6;font-size:13px;margin-bottom:10px;}'+
      '#rc-list{overflow-y:auto;flex:1;min-height:80px;}'+
      '.rc-def{margin:10px 0;padding:10px 12px;border-radius:10px;border:2px solid #444;background:#222836;color:#fff;font-size:14px;}'+
      '.rc-def .rid{font-weight:bold;color:#ffb02e;}'+
      '.rc-def .st{float:right;font-weight:bold;}'+
      '.rc-def .truth{color:#9fb2cc;font-size:13px;margin-top:6px;}'+
      '.rc-log{margin:6px 0;padding:6px 10px;font-size:13px;color:#c9c9c9;border-left:3px solid #ffb02e;}'+
      '.rc-log .lt{color:#8a93a6;margin-right:8px;}'+
      '#rc-close{margin-top:12px;padding:10px 18px;font-size:15px;border-radius:10px;border:none;background:#ffb02e;color:#111;font-weight:bold;width:100%;}';
    document.head.appendChild(css);
    var btn=document.createElement('button');
    btn.id='rc-btn'; btn.title='Road dispatch log'; btn.innerHTML='🚧';
    btn.addEventListener('click', function(){ togglePanel(); });
    document.body.appendChild(btn);
    var panel=document.createElement('div');
    panel.id='rc-panel';
    panel.innerHTML='<div class="card"><h3>🚧 Road Dispatch</h3>'+
      '<div class="sub">True specs from the Street View audit — crew on duty 24/7</div>'+
      '<div id="rc-list"></div><button id="rc-close">Close</button></div>';
    document.body.appendChild(panel);
    document.getElementById('rc-close').addEventListener('click', function(){ togglePanel(false); });
  }catch(e){}
}
function stateColor(s){
  return s==='fixed' ? '#51d651' :
         (s==='repairing'||s==='dispatched') ? '#ffb02e' :
         (s==='found'||s==='inspecting') ? '#6ec6ff' : '#c9c9c9';
}
function refreshPanel(){
  if (!RC.uiBuilt) return;
  try{
    var el=document.getElementById('rc-list'); if(!el) return;
    var h='';
    DEFECTS.forEach(function(d){
      h+='<div class="rc-def"><span class="rid">'+d.id+'</span> '+d.street+
         '<span class="st" style="color:'+stateColor(d.state)+'">'+d.state.toUpperCase()+'</span><br>'+
         '<div class="truth">TRUE SPECS: '+d.truth+'<br>FIX: '+d.fix+'</div></div>';
    });
    h+='<div class="sub" style="margin-top:8px">EVENT LOG</div>';
    var logs=RC.log.slice(-20).reverse();
    if (!logs.length) h+='<div class="rc-log">No events yet — patrols are out.</div>';
    logs.forEach(function(e){
      h+='<div class="rc-log"><span class="lt">'+e.t+'</span>'+e.msg+'</div>';
    });
    el.innerHTML=h;
  }catch(e){}
}
function togglePanel(force){
  try{
    RC.panelOpen = (typeof force==='boolean') ? force : !RC.panelOpen;
    var p=document.getElementById('rc-panel');
    if (p){ if(RC.panelOpen){ refreshPanel(); p.classList.add('show'); } else p.classList.remove('show'); }
  }catch(e){}
}
window.toggleDispatchLog=togglePanel;

/* ---------------- fallback: driver reports ---------------- */
/* fallbackCheck(dt) — safety net: any structural defect undiscovered for
   longer than FALLBACK_T (240s) gets called in by a "driver report" (an
   imaginary motorist) instead of a patrol unit, so no defect sits forever
   just because patrols never drove past it. */
function fallbackCheck(dt){
  RC.time+=dt;
  DEFECTS.forEach(function(d){
    if (!d.structural || d.state!=='undiscovered') return;
    d._age=(d._age||0)+dt;
    if (d._age>FALLBACK_T){
      d.state='found';
      dlog('Driver report: defect '+d.id+' ('+d.street+') called in by a motorist — dispatching.');
      toast('🚧 Driver reported a road defect ('+d.street+') — dispatch notified');
      setTimeout(function(){
        if (d.state!=='found') return;
        d.state='dispatched';
        dlog('Dispatch pulled true specs for '+d.id+' — sending repair crew.');
        dispatchRepair(d);
      }, DISPATCH_T*1000);
    }
  });
}

/* ---------------- main loop ---------------- */
/* updateRoadCrew(dt) — frame tick: ticks all patrols, ticks all repair
   jobs, runs the driver-report fallback, and reports to the Report panel
   every 10s. dt clamped to 50ms (tab-switch safety). Guarded — a road-crew
   bug must never break the frame. */
function updateRoadCrew(dt){
  if (!RC.ready) return;
  try{
    dt=Math.min(0.05, dt||0.016);
    RC.tick++;
    var i;
    for (i=0;i<RC.patrols.length;i++) updatePatrol(RC.patrols[i], dt);
    updateJobs(dt);
    fallbackCheck(dt);
    RC.repT-=dt;
    if (RC.repT<=0){ RC.repT=10; try{ Report.setSys('roadcrew', sysReport()); }catch(e){} }
  }catch(e){}
}

/* ---------------- init ---------------- */
/* initRoadCrew() — builds the dispatch office, the HUD, and spawns 4 patrol
   units (I-20 corridor, home-base/Dollar Mill area, Fulton Industrial,
   Fairburn/south), then re-lays asphalt patches for defects fixed in past
   sessions. Wraps the global animate() (chains with other module wraps) so
   updateRoadCrew runs every frame. Boot waits until the world (roadDrawData,
   scene, heightAt, onRoad) exists; gives up after 120s without breaking. */
function initRoadCrew(){
  loadLS();
  buildDispatch();
  buildUI();
  // patrol 1: I-20 corridor (covers OPEN-1)
  spawnPatrol(1, 4318.5, 2871.1, true);
  // patrol 2: home-base / Dollar Mill area (covers OPEN-5)
  spawnPatrol(2, 3160.1, 3613.7, false);
  // patrol 3: Fulton Industrial corridor
  spawnPatrol(3, 2000, 3800, false);
  // patrol 4: Fairburn / south sector
  spawnPatrol(4, 3500, 5500, false);
  // re-lay patches for defects already fixed in a past session
  DEFECTS.forEach(function(d){
    if (d.structural && d.state==='fixed'){
      var nr=nearestRoad(d.x,d.z, d.id==='OPEN-1');
      var patch=makePatch(d, nr?roadHeadingAt(nr):0);
      scene.add(patch); RC.patchMeshes.push(patch);
    }
  });
  if (!RC.log.length) dlog('Road crew system online — 4 patrol units out, 24/7 operation. Continuously repairing the map, keeping it accurate.');
  RC.ready=true;
  try{ Report.setSys('roadcrew', sysReport()); }catch(e){}
  window.ROADCREW={defects:DEFECTS, log:RC.log, toggle:togglePanel};
  // hook into the frame loop (chains with other module wraps)
  try{
    if (typeof animate==='function' && !animate.__roadcrewWrap){
      var orig=animate;
      var wrapped=function(){ orig(); updateRoadCrew(0.016); };
      wrapped.__roadcrewWrap=true;
      animate=wrapped;
    }
  }catch(e){}
}
var bootTries=0;
var bootTimer=setInterval(function(){
  bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined' && typeof scene!=='undefined' &&
      typeof roadDrawData!=='undefined' && roadDrawData.length>100 &&
      typeof animate==='function' &&
      typeof heightAt==='function' && typeof onRoad==='function');
  }catch(e){ ready=false; }
  if (ready){
    clearInterval(bootTimer);
    try{ initRoadCrew(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('roadcrew','init failed',String(e&&e.message||e)); }catch(x){}
    }
  } else if (bootTries>240){
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('roadcrew','boot-timeout','deps never ready'); }catch(e){}
  }
},500);
})();
