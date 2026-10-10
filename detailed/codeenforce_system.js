/* ============================================================================
   FILE: codeenforce_system.js — "Surviving Adamsville" code enforcement
   ----------------------------------------------------------------------------
   PURPOSE: Joshua's in-world building inspectors + construction crews.
   Officers patrol 24/7; when a building looks off (on/near a road, sideways
   to the street) they radio dispatch, and a construction crew rolls out to
   MOVE the building, ROTATE it 90°, or ADD sidewalks/driveways/doors+
   windows. Crews are ALWAYS on duty, day and night.
   KEY SYSTEMS:
     - Boot defect scan: every placed building is checked — encroach
       (footprint inside road clearance: distance-to-road-edge < half-extent
       + 2u) and sideways (commercial long axis perpendicular to the street:
       |tangent·longaxis| < 0.35). Cap 40 live defects. Audit-pending items
       from buildings.json sit as 'monitoring' (no crew sent).
     - Defect states: undiscovered → inspecting → found → dispatched →
       working → fixed | deferred (deferred = uncertain — pending audit
       covers the spot, or no clear spot: lands on Joshua's review list).
     - Patrol units (4 SUVs): drive non-highway roads 24/7, discover defects
       within 60u, shared stuck.js recovery; 24/7 watchdog re-adds a mesh
       that somehow left the scene; "sector clear" heartbeat every 300s.
     - Construction jobs (max 2 concurrent, rest QUEUE): crew truck + 4
       hi-vis workers (lime vest + WHITE hard hat — distinct from road crew's
       orange/yellow), scaffolding, UNDER RENOVATION sign, barriers. The fix
       applies at 35% of the 60s work window; encroach moves SLIDE over ~3s
       (smoothstep easing, animated via updateSlides); then finishing touches
       (sidewalk + driveway for houses + door/windows on the street side).
     - Persistence: corrections (moves/rotates) saved to localStorage and
       RE-APPLIED on boot (instanced transforms + colliders + PLACED_HOUSES
       updated); extras (sidewalks/driveways/doors) are keyed to avoid
       duplicates. In-progress states reset — crews re-run.
     - NEVER deletes a building — only move/rotate/fix (Joshua's standing
       rule: deletion is not an option; when in doubt, flag for review).
     - Shared dispatch office next to the road-crew office
       (window.__dispatchOffice, offset +46,+8 so they don't overlap); the 🏢
       HUD panel lists building defects + road-crew road defects (when loaded)
       + one combined event log.
   INTEGRATION NOTE: requires ONE additive hook in index.html's osmBuildings
   IIFE — window.__bldgMeshes={bodies, roofs, kept} published right before
   scene.add(bodies)/scene.add(roofs), so corrections can rewrite the
   instanced transforms. Without it the module logs an error and stays off.
   JOSHUA SPECS ENCODED:
     - 24/7 operation; simple sim logic, no pathfinding.
     - Officers and crews look DIFFERENT from regular characters (navy
       inspector uniform/gold badge/navy cap/clipboard; white SUV with blue
       stripe + CODE ENFORCEMENT decal) so the player instantly knows them.
     - Stuck-loop recovery: same shared stuck.js protocol as the road crew.
   ============================================================================ */
/* ============================================================================
   SURVIVING ADAMSVILLE — CODE ENFORCEMENT + CONSTRUCTION CREW (v1.0)
   ----------------------------------------------------------------------------
   Joshua's vision: code enforcement officers patrol the map 24/7. When a
   building looks off (on/near a road, sideways to the street, missing
   sidewalk/driveway/door) they contact DISPATCH. Dispatch holds the
   reference data pulled from the internet (OSM building data, Street View
   audit findings in streetview-audit/buildings.json) and tells them what
   the building SHOULD look like. Then a CONSTRUCTION CREW rolls out and
   can MOVE buildings, ROTATE them, ADD sidewalks, driveways, doors,
   windows. Crews are ALWAYS on duty, day and night.

   Officers and crews look DIFFERENT from regular characters so the player
   instantly knows who they are:
     - Code enforcement: navy inspector uniform, gold badge, navy cap,
       clipboard. White SUV with blue stripe + CODE ENFORCEMENT decal.
     - Construction: lime hi-vis vest + WHITE hard hat (road crew wears
       orange/yellow — these are different). Yellow work truck.

   STANDALONE MODULE. Include AFTER the main game script:

       <script src="codeenforce_system.js"></script>

   Requires ONE additive hook inside the osmBuildings IIFE in index.html
   (publish the instanced building meshes so corrections can be applied):
       try{ window.__bldgMeshes={bodies:bodies, roofs:roofs, kept:kept}; }catch(e){}
   placed right before:  scene.add(bodies); scene.add(roofs);

   What it does:
     1. DEFECT SCAN — at boot, every placed building is checked:
        encroach (footprint inside road clearance) and sideways (commercial
        long axis perpendicular to the street). Audit-pending items from
        buildings.json sit on the dispatch board as "monitoring".
     2. PATROL UNITS — 2 code-enforcement SUVs drive residential roads
        24/7. Near a structural defect they stop, radio dispatch (log +
        toast), and a construction crew is dispatched.
     3. CONSTRUCTION — crew truck + 2 hi-vis workers, scaffolding around
        the building, UNDER RENOVATION sign. They MOVE / ROTATE / ADD
        sidewalk / driveway / door+windows, then clear out. Corrections
        persist in localStorage and re-apply on boot.
     4. SHARED DISPATCH LOG — HUD button (🏢) opens the panel: building
        defects with true specs, road defects (when the road-crew system
        is loaded), and one combined event log.

   NEVER deletes a building — only move/rotate/fix. If dispatch data is
   uncertain (a pending audit item covers the spot), the crew flags it and
   moves on; it lands on Joshua's review list.

   Design: simple sim logic (Joshua's rule). Everything guarded: if any
   dependency is missing the module stays off and the game is unaffected.
   ============================================================================ */
(function(){
'use strict';
if (window.__codeenforceV1) return;
window.__codeenforceV1 = true;

/* ---------------- config ---------------- */
var DISCOVER_R   = 60;     // patrol spots a defect inside this radius (u)
var INSPECT_T    = 3;      // seconds the patrol unit stops to "radio in"
var DISPATCH_T   = 6;      // seconds from found -> crew dispatched
var WORK_T       = 60;     // seconds the construction crew works a site
var PATROL_SPEED = 12;
var N_PATROLS    = 2;
var LS_KEY       = 'sa_codeenforce_v1';
var MAX_JOBS     = 2;      // concurrent construction jobs (24/7 queue)

/* ---------------- defect database ----------------
   state: undiscovered | inspecting | found | dispatched | working |
          fixed | deferred | monitoring
   Audit-pending items are 'monitoring' (dispatch knows, no crew sent). */
var DEFECTS=[
 {id:'bldg-entrance-001', kind:'code', structural:false, street:'GAME-WIDE', x:0, z:0,
  desc:'OSM buildings render as plain boxes with no doors or entrances. No facing/rotation data exists in the building format.',
  truth:'Street View: real buildings have visible entrances facing streets. Audit says: add door meshes on the street-facing side + rotation (ry) support.',
  fix:'Code change: door meshes + ry rotation in the building format. Residential detail pass already faces doors to the road for houses/apts.',
  state:'monitoring'},
 {id:'bldg-parking-001', kind:'code', structural:false, street:'GAME-WIDE', x:0, z:0,
  desc:'No parking lot renderer exists in the game. Malls and shopping centers need parking lots.',
  truth:'Street View/satellite: large asphalt parking areas around every commercial building.',
  fix:'Code change: parking lot renderer (asphalt rect + painted space lines).',
  state:'monitoring'},
 {id:'bldg-interior-001', kind:'code', structural:false, street:'2841 Greenbriar Pkwy SW', x:0, z:0,
  desc:'Greenbriar Mall needs a walkable interior (Joshua requirement).',
  truth:'Real mall: enclosed concourse with storefronts, 678K sq ft.',
  fix:'Code change: interior layout passable on foot.',
  state:'monitoring'},
 {id:'bldg-interior-002', kind:'code', structural:false, street:'850 Oak St SW', x:0, z:0,
  desc:'West End Mall needs walkable storefronts (Joshua requirement).',
  truth:'Real site: strip shopping center, walkable storefronts.',
  fix:'Code change: walkable storefront interiors.',
  state:'monitoring'}
];

/* ---------------- state ---------------- */
var CE={ ready:false, tick:0, time:0,
  patrols:[], jobs:[], queue:[], log:[],
  dispatch:null, boardTex:null,
  uiBuilt:false, panelOpen:false, repT:0, extras:[],
  badSegs:[] };   // road segments an officer got stuck on — skipped on reassign

/* ---------------- tiny helpers ---------------- */
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function dist2(ax,az,bx,bz){ var dx=ax-bx,dz=az-bz; return dx*dx+dz*dz; }
function groundY(x,z){ try{ var y=heightAt(x,z); return isFinite(y)?y:0; }catch(e){ return 0; } }
function toast(msg,ms){ try{ if(typeof showToast==='function') showToast(msg,ms||2600); }catch(e){} }
function nowT(){ var d=new Date(); function p(n){return (n<10?'0':'')+n;} return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }

/* clog(msg) — timestamped code-enforcement event log (cap 60 entries):
   persists to localStorage, refreshes the HUD panel + spec board, and
   reports to the Report panel. Every dispatch event goes here. */
function clog(msg){
  CE.log.push({t:nowT(), msg:msg});
  if (CE.log.length>60) CE.log.splice(0, CE.log.length-60);
  saveLS(); refreshPanel(); refreshBoard();
  try{ Report.setSys('codeenforce', sysReport()); }catch(e){}
}
function sysReport(){
  var st={}; DEFECTS.forEach(function(d){ st[d.id]=d.state; });
  return {status:'ok', version:'1.0', defects:st,
    activeJobs:CE.jobs.length, queued:CE.queue.length, patrols:CE.patrols.length,
    logEntries:CE.log.length,
    note:'code enforcement patrols 24/7 + construction crews (audit-driven)'};
}

/* ---------------- persistence ---------------- */
function saveLS(){
  try{
    var st={}; DEFECTS.forEach(function(d){ st[d.id]=d.state; });
    localStorage.setItem(LS_KEY, JSON.stringify({
      defects:st, log:CE.log.slice(-60),
      corrections:CE.corrections||{}, extras:CE.extras||[]
    }));
  }catch(e){}
}
function loadLS(){
  try{
    var raw=localStorage.getItem(LS_KEY); if(!raw) return;
    var d=JSON.parse(raw);
    if (d.defects) DEFECTS.forEach(function(x){
      var s=d.defects[x.id];
      /* structural live defects re-scan every boot; audit states persist */
      if (!x.live && s) x.state=s;
    });
    if (d.log && d.log.length) CE.log=d.log;
    if (d.corrections) CE.corrections=d.corrections;
    if (d.extras) CE.extras=d.extras;
  }catch(e){}
}

/* ---------------- canvas texture helpers ---------------- */
function makeCanvas(w,h){
  var c=document.createElement('canvas'); c.width=w; c.height=h;
  return {c:c, ctx:c.getContext('2d')};
}
function signTexture(main, sub, bg){
  var k=makeCanvas(512,320), x=k.ctx;
  x.fillStyle=bg||'#1b4f9c'; x.fillRect(0,0,512,320);
  x.strokeStyle='#fff'; x.lineWidth=14; x.strokeRect(10,10,492,300);
  x.fillStyle='#fff'; x.textAlign='center'; x.textBaseline='middle';
  x.font='bold 60px sans-serif';
  var words=main.split(' '), lines=[], line='';
  words.forEach(function(w){ if((line+' '+w).trim().length>13){ lines.push(line.trim()); line=w; } else line+=' '+w; });
  lines.push(line.trim());
  var y0=160-(lines.length-1)*36-(sub?26:0);
  lines.forEach(function(L,i){ x.fillText(L,256,y0+i*72); });
  if (sub){ x.font='bold 38px sans-serif'; x.fillText(sub,256,y0+lines.length*72-6); }
  var t=new THREE.CanvasTexture(k.c); t.anisotropy=2; return t;
}
function boardTexture(){
  var k=makeCanvas(640,560), x=k.ctx;
  function draw(){
    x.fillStyle='#1a2030'; x.fillRect(0,0,640,560);
    x.fillStyle='#7ec8ff'; x.textAlign='left'; x.textBaseline='top';
    x.font='bold 28px sans-serif';
    x.fillText('CODE ENFORCEMENT — SPEC BOARD', 18, 14);
    x.font='19px sans-serif'; x.fillStyle='#9fb2cc';
    x.fillText('true specs: OSM + Street View audit', 18, 48);
    var y=86, shown=0;
    DEFECTS.forEach(function(d){
      if (shown>=7) return;
      var col = d.state==='fixed' ? '#51d651' :
                d.state==='working'||d.state==='dispatched' ? '#ffb02e' :
                d.state==='found'||d.state==='inspecting' ? '#6ec6ff' :
                d.state==='deferred' ? '#c98aff' : '#c9c9c9';
      x.fillStyle=col; x.font='bold 20px sans-serif';
      x.fillText(d.id+'  '+(d.street||''), 18, y);
      x.fillStyle='#8a93a6'; x.font='18px sans-serif';
      x.fillText('status: '+d.state.toUpperCase(), 18, y+24);
      y+=56; shown++;
    });
    x.fillStyle='#5a6376'; x.font='17px sans-serif';
    x.fillText('crews on duty 24/7 — map stays accurate', 18, 524);
  }
  draw();
  var t=new THREE.CanvasTexture(k.c); t.anisotropy=2;
  return {tex:t, redraw:function(){ draw(); t.needsUpdate=true; }};
}
function labelSprite(text, color){
  var k=makeCanvas(512,128), x=k.ctx;
  x.font='bold 50px sans-serif';
  var tw=x.measureText(text).width;
  x.fillStyle='rgba(20,24,34,0.85)';
  x.fillRect(256-tw/2-24, 14, tw+48, 100);
  x.strokeStyle=color||'#7ec8ff'; x.lineWidth=6;
  x.strokeRect(256-tw/2-24, 14, tw+48, 100);
  x.fillStyle=color||'#7ec8ff'; x.textAlign='center'; x.textBaseline='middle';
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
/* Code enforcement SUV: white, blue stripe, decal, blue light bar. faces +Z. */
function makeInspectorSUV(){
  var g=new THREE.Group();
  var white=0xf4f6f8, blue=0x1b4f9c, dark=0x222226;
  var body=box(2.1,1.1,4.6,white); body.position.y=0.95; g.add(body);
  var cab=box(1.9,0.85,2.4,white); cab.position.set(0,1.85,0.2); g.add(cab);
  var glass=box(1.7,0.6,2.2,0x1c2733); glass.position.set(0,1.85,0.2); g.add(glass);
  var stripe=box(2.14,0.34,4.62,blue); stripe.position.set(0,1.0,0); g.add(stripe);
  var bar=box(1.2,0.26,0.4,blue,0x2266cc); bar.position.set(0,2.45,0.2); g.add(bar);
  g.userData.lightBar=bar;
  // door decal
  var k=makeCanvas(256,128), x=k.ctx;
  x.fillStyle='#1b4f9c'; x.fillRect(0,0,256,128);
  x.fillStyle='#fff'; x.textAlign='center'; x.textBaseline='middle';
  x.font='bold 30px sans-serif'; x.fillText('CODE',128,38); x.fillText('ENFORCE.',128,76);
  var t=new THREE.CanvasTexture(k.c);
  [-1,1].forEach(function(s){
    var dcl=new THREE.Mesh(new THREE.PlaneGeometry(1.5,0.75),
      new THREE.MeshLambertMaterial({map:t}));
    dcl.position.set(s*1.06,1.0,0.2); dcl.rotation.y=s*Math.PI/2; g.add(dcl);
  });
  var wg=new THREE.CylinderGeometry(0.44,0.44,0.34,10), wm=mat(0x141414);
  [[-1.0,1.5],[1.0,1.5],[-1.0,-1.5],[1.0,-1.5]].forEach(function(p){
    var w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2;
    w.position.set(p[0],0.44,p[1]); g.add(w);
  });
  return g;
}
/* Code enforcement officer: navy inspector uniform, gold badge, navy cap, clipboard. */
function makeInspector(){
  var g=new THREE.Group();
  var navy=0x1c2f5e, gold=0xd8a920, skin=0x6b4429;
  var legs=box(0.5,0.72,0.34,0x141f3d); legs.position.y=0.36; g.add(legs);
  var torso=box(0.62,0.72,0.4,navy); torso.position.y=1.08; g.add(torso);
  var badge=box(0.16,0.2,0.05,gold,gold); badge.position.set(-0.18,1.25,0.21); g.add(badge);
  var head=box(0.36,0.36,0.36,skin); head.position.y=1.62; g.add(head);
  var cap=box(0.42,0.14,0.42,navy); cap.position.y=1.85; g.add(cap);
  var brim=box(0.42,0.05,0.2,navy); brim.position.set(0,1.8,0.28); g.add(brim);
  var armL=box(0.16,0.6,0.16,navy); armL.position.set(-0.4,1.06,0); g.add(armL);
  var armR=box(0.16,0.6,0.16,navy); armR.position.set(0.4,1.06,0.12); g.add(armR);
  var clip=box(0.3,0.4,0.04,0xe8e4da); clip.position.set(0.4,0.82,0.3); g.add(clip);
  g.userData.armR=armR;
  return g;
}
/* Construction work truck: yellow utility truck. faces +Z. */
function makeConstrTruck(){
  var g=new THREE.Group();
  var yel=0xe8b820, dark=0x222226;
  var chassis=box(2.2,0.5,5.6,dark); chassis.position.y=0.55; g.add(chassis);
  var cab=box(2.2,1.5,1.9,yel); cab.position.set(0,1.55,1.7); g.add(cab);
  var shield=box(1.9,0.8,0.12,0x1c2733); shield.position.set(0,1.7,2.66); g.add(shield);
  var bed=box(2.2,1.1,3.0,yel); bed.position.set(0,1.35,-1.1); g.add(bed);
  // toolboxes / materials in the bed
  var crate=box(1.2,0.7,1.0,0x8a6a3a); crate.position.set(-0.4,2.2,-1.2); g.add(crate);
  var lumber=box(0.5,0.3,2.4,0xa88450); lumber.position.set(0.6,2.05,-1.1); g.add(lumber);
  var bar=box(1.3,0.28,0.45,0xe8641b,0xcc5500); bar.position.set(0,2.45,1.7); g.add(bar);
  g.userData.lightBar=bar;
  var wg=new THREE.CylinderGeometry(0.46,0.46,0.36,10), wm=mat(0x141414);
  [[-1.05,1.8],[1.05,1.8],[-1.05,-1.6],[1.05,-1.6]].forEach(function(p){
    var w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2;
    w.position.set(p[0],0.46,p[1]); g.add(w);
  });
  return g;
}
/* Construction worker: lime hi-vis vest + WHITE hard hat (distinct from road crew). */
function makeConstrWorker(){
  var g=new THREE.Group();
  var lime=0xb8e62e, skin=0x6b4429;
  var legs=box(0.5,0.7,0.34,0x3a4256); legs.position.y=0.35; g.add(legs);
  var torso=box(0.62,0.72,0.4,lime); torso.position.y=1.06; g.add(torso);
  var stripe=box(0.64,0.14,0.42,0xd8d8d8); stripe.position.y=1.1; g.add(stripe);
  var head=box(0.36,0.36,0.36,skin); head.position.y=1.6; g.add(head);
  var hat=box(0.46,0.18,0.46,0xf2f2f2); hat.position.y=1.85; g.add(hat);
  var armL=box(0.16,0.6,0.16,lime); armL.position.set(-0.4,1.05,0); g.add(armL);
  var armR=box(0.16,0.6,0.16,lime); armR.position.set(0.4,1.05,0); g.add(armR);
  g.userData.armL=armL; g.userData.armR=armR;
  return g;
}
/* scaffolding frame around a building footprint. */
function makeScaffold(w,d,h){
  var g=new THREE.Group();
  var pole=mat(0x8a8f96), hw=w/2+1.2, hd=d/2+1.2, sh=Math.min(h+2,10);
  [[-hw,-hd],[hw,-hd],[-hw,hd],[hw,hd]].forEach(function(p){
    var post=box(0.28,sh,0.28,0x8a8f96); post.position.set(p[0],sh/2,p[1]); g.add(post);
  });
  [2.2, sh-0.6].forEach(function(y){
    var pl1=box(w+2.4,0.22,d+2.4,0xa88450); pl1.position.y=y; g.add(pl1);
  });
  return g;
}

/* ---------------- building registry access ---------------- */
/* bldgReg() — the shared building-registry handle published by the
   index.html hook: {bodies, roofs (InstancedMeshes), kept (placed building
   records [x,z,w,d,h,type])}. Corrections rewrite these instanced
   transforms. Returns null when the hook is missing (module stays off). */
function bldgReg(){
  try{
    if (window.__bldgMeshes && window.__bldgMeshes.kept && window.__bldgMeshes.kept.length)
      return window.__bldgMeshes;
  }catch(e){}
  return null;
}
/* nearestRoad(x,z,highwayOnly) — brute-force nearest road lookup over every
   roadDrawData point (same pattern as roadcrew_system.js, kept local so the
   module stays standalone). Returns {seg, idx, dist} or null. O(road points)
   — used at spawn/recovery/defect-scan time, never per frame. */
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
/* roadTangent(nr) — unit tangent of the road at the nearestRoad result's
   point index. Used for the "sideways" test and to aim doors/sidewalks. */
function roadTangent(nr){
  try{
    var pts=nr.seg.pts, i=clamp(nr.idx,0,pts.length-2);
    var a=pts[i], b=pts[i+1], dx=b[0]-a[0], dz=b[1]-a[1], L=Math.hypot(dx,dz)||1;
    return {x:dx/L, z:dz/L};
  }catch(e){ return {x:1,z:0}; }
}
/* toRoadDir(x,z) — unit direction from (x,z) toward the nearest NON-highway
   road, plus distance and the road's tangent. Patrols and construction use
   it to face buildings at the street. Returns null when no road is found. */
function toRoadDir(x,z){
  var nr=nearestRoad(x,z,false);
  if (!nr) return null;
  try{
    var pts=nr.seg.pts, p=pts[clamp(nr.idx,0,pts.length-1)];
    var dx=p[0]-x, dz=p[1]-z, L=Math.hypot(dx,dz)||1;
    return {x:dx/L, z:dz/L, dist:L, tangent:roadTangent(nr)};
  }catch(e){ return null; }
}
/* clearForBldg(x,z,w,d) — true when a w×d footprint at (x,z) clears the road
   edge with room to spare (half the footprint's long side + 4u). */
function clearForBldg(x,z,w,d){
  var need=Math.max(w,d)/2+4, dd=1e9;
  try{ dd=distToRoadEdge(x,z); }catch(e){ return false; }
  return dd>=need;
}
/* spiralSpot(x,z,w,d) — finds the nearest clear spot for a w×d footprint:
   returns the original spot when it already clears, else a spiral search
   (radius 6→48u, 12 angles per ring). Returns null when nothing clear is
   found — the defect is then flagged for Joshua's review instead of being
   moved anywhere bad. */
function spiralSpot(x,z,w,d){
  if (clearForBldg(x,z,w,d)) return [x,z];
  for (var r=6;r<=48;r+=6){
    for (var a=0;a<12;a++){
      var nx=x+Math.cos(a/12*Math.PI*2)*r, nz=z+Math.sin(a/12*Math.PI*2)*r;
      if (clearForBldg(nx,nz,w,d)) return [nx,nz];
    }
  }
  return null;
}

/* ---------------- defect scan (runs at boot) ---------------- */
/* scanBuildings() — checks every placed building (cap 40 live defects) for:
     ENCROACH: footprint inside road clearance (distToRoadEdge < half the
       long side + 2u) → the crew moves it to the spiralSpot clear spot.
     SIDEWAYS: commercial/industrial (type 1/3) whose long axis is
       perpendicular to the street (|tangent·longaxis| < 0.35, within 80u of
       the road) → the crew rotates it 90°.
   Buildings are found by INDEX (bi) into the shared kept[] array. */
function scanBuildings(){
  var reg=bldgReg(); if(!reg) return;
  var kept=reg.kept, found=0;
  for (var i=0;i<kept.length && found<40;i++){
    var b=kept[i]; if(!b||b.length<6) continue;
    var x=b[0], z=b[1], w=b[2], d=b[3], tp=b[5];
    var need=Math.max(w,d)/2+2, dd=1e9;
    try{ dd=distToRoadEdge(x,z); }catch(e){ continue; }
    if (dd < need){
      var spot=spiralSpot(x,z,w,d);
      DEFECTS.push({id:'CE-'+(1000+found), live:true, kind:'encroach',
        structural:true, street:streetNear(x,z), x:x, z:z, bi:i,
        w:w, d:d, h:b[4], tp:tp, nx:spot?spot[0]:null, nz:spot?spot[1]:null,
        desc:'Building footprint sits inside road clearance ('+dd.toFixed(1)+'u from road edge, needs '+need.toFixed(1)+'u).',
        truth:'Audit rule: no building may sit on or crowd a road. OSM + Street View set the true footprint.',
        fix: spot ? 'Construction crew moves the building to the nearest clear spot.' : 'No clear spot nearby — flagged for Joshua\u2019s review.',
        state:'undiscovered'});
      found++;
      continue;
    }
    /* sideways: commercial long axis perpendicular to the street */
    if ((tp===1||tp===3) && w!==d && dd<80){
      var rd=toRoadDir(x,z);
      if (rd){
        var longX = w>=d ? 1 : 0;      /* long axis: 1=x, 0=z */
        var t = rd.tangent;
        var align = longX ? Math.abs(t.x) : Math.abs(t.z);
        if (align < 0.35){
          DEFECTS.push({id:'CE-'+(1000+found), live:true, kind:'sideways',
            structural:true, street:streetNear(x,z), x:x, z:z, bi:i,
            w:w, d:d, h:b[4], tp:tp,
            desc:'Commercial building sits sideways — long axis runs across the street instead of along it.',
            truth:'Street View: storefronts face the street with the long face parallel to it.',
            fix:'Construction crew rotates the building 90\u00b0 so its face runs with the street.',
            state:'undiscovered'});
          found++;
        }
      }
    }
  }
  if (found) clog('Code enforcement scan: '+found+' building defect(s) found. Officers dispatched on patrol.');
  else clog('Code enforcement scan: no structural building defects — patrols out, monitoring audit items.');
}
/* streetNear(x,z) — nearest non-highway road's name for defect labeling;
   'nearby street' when unknown (never blank in the log/panel). */
function streetNear(x,z){
  try{
    var nr=nearestRoad(x,z,false);
    if (nr && nr.seg && nr.seg.name) return nr.seg.name;
  }catch(e){}
  return 'nearby street';
}

/* ---------------- corrections: apply + persist ---------------- */
CE.corrections={};
function correctionKey(b){ return b[0].toFixed(1)+','+b[1].toFixed(1); }
/* ---------------- corrections: apply + persist ---------------- */
/* setInstanceTransform(i, x, z, w, d, h, rot90) — rewrites the instanced
   body+roof matrices for kept[i]: re-poses the unit-box body (w×bh×d at
   terrain height) and re-proportions the roof cap. rot90 swaps w/d first
   (the rotation fix is a 90° footprint swap on the instanced box — no mesh
   rotation needed for axis-aligned boxes). */
function setInstanceTransform(i, x, z, w, d, h, rot90){
  var reg=bldgReg(); if(!reg) return false;
  var m4=new THREE.Matrix4(), qt=new THREE.Quaternion(), sv=new THREE.Vector3(), pv=new THREE.Vector3();
  var gy=groundY(x,z), bh=Math.max(2.5,h);
  if (rot90){ var t=w; w=d; d=t; }
  pv.set(x,gy-0.6,z); sv.set(w,bh,d); qt.identity();
  m4.compose(pv,qt,sv); reg.bodies.setMatrixAt(i,m4);
  var rh=Math.min(5,Math.max(1.2,w*0.18));
  pv.set(x,gy-0.6+bh,z); sv.set(w*1.06,rh,d*1.06);
  m4.compose(pv,qt,sv); reg.roofs.setMatrixAt(i,m4);
  reg.bodies.instanceMatrix.needsUpdate=true;
  reg.roofs.instanceMatrix.needsUpdate=true;
  return true;
}
/* moveCollider(ox,oz,nx,nz,r) — moves the building's collider entry in the
   game's 40u bldgGrid from the old cell to the new one (matched within
   0.05u of the old position), so the player collides with the building
   WHERE IT IS NOW, not where it was. Skipped if a collider is missing. */
function moveCollider(ox,oz,nx,nz,r){
  try{
    if (typeof bldgGrid==='undefined') return;
    var ok=Math.floor(ox/40)+','+Math.floor(oz/40);
    var cell=bldgGrid[ok];
    if (cell) for (var i=cell.length-1;i>=0;i--){
      var c=cell[i];
      if (Math.abs(c.x-ox)<0.05 && Math.abs(c.z-oz)<0.05){ cell.splice(i,1); break; }
    }
    var nk=Math.floor(nx/40)+','+Math.floor(nz/40);
    (bldgGrid[nk]=bldgGrid[nk]||[]).push({x:nx,z:nz,r:r});
  }catch(e){}
}
/* updatePlacedHouse(ox,oz,nx,nz) — moves the PLACED_HOUSES record when a
   ranch house is corrected, so the house registry and spawn data agree with
   the rendered position. */
function updatePlacedHouse(ox,oz,nx,nz){
  try{
    if (typeof PLACED_HOUSES==='undefined') return;
    for (var i=0;i<PLACED_HOUSES.length;i++){
      var p=PLACED_HOUSES[i];
      if (Math.abs(p[0]-ox)<0.05 && Math.abs(p[1]-oz)<0.05){ p[0]=nx; p[1]=nz; break; }
    }
  }catch(e){}
}
/* applyCorrection(def, animate) — applies a defect's fix:
     encroach + animate=true: queues a CE.slides entry — the building SLIDES
       to the clear spot over ~3s with smoothstep easing (updateSlides), so
       Joshua can watch it move instead of it popping.
     encroach + animate=false / sideways: applies instantly (used on boot
       re-apply and for rotations, which swap the w/d footprint in kept[]).
   Every application updates: kept[] record, instanced transforms,
   bldgGrid collider, PLACED_HOUSES, and CE.corrections (keyed by original
   position for boot re-apply). Returns false when it can't be done in
   place → the defect is deferred to Joshua's review. */
function applyCorrection(def, animate){
  var reg=bldgReg(); if(!reg) return false;
  var kept=reg.kept, i=def.bi;
  if (i==null || i<0 || i>=kept.length) return false;
  var b=kept[i];
  if (def.kind==='encroach' && def.nx!=null){
    var ox=b[0], oz=b[1], r=Math.max(b[2],b[3])/2+0.5;
    if (animate){
      /* slide the building over ~3s */
      var t0=CE.time, dur=3, fx=ox, fz=oz, tx=def.nx, tz=def.nz;
      CE.slides=CE.slides||[];
      CE.slides.push({i:i, b:b, t:0, dur:dur, fx:fx, fz:fz, tx:tx, tz:tz, def:def});
      return true;
    }
    b[0]=def.nx; b[1]=def.nz;
    setInstanceTransform(i, def.nx, def.nz, b[2], b[3], b[4], false);
    moveCollider(ox,oz,def.nx,def.nz,r);
    updatePlacedHouse(ox,oz,def.nx,def.nz);
    CE.corrections[correctionKey([ox,oz])]={nx:def.nx, nz:def.nz, rot:false, bi:i};
    return true;
  }
  if (def.kind==='sideways'){
    var ox2=b[0], oz2=b[1];
    setInstanceTransform(i, ox2, oz2, b[2], b[3], b[4], true);
    var t2=b[2]; b[2]=b[3]; b[3]=t2;
    moveCollider(ox2,oz2,ox2,oz2,Math.max(b[2],b[3])/2+0.5);
    CE.corrections[correctionKey([ox2,oz2])]={nx:ox2, nz:oz2, rot:true, bi:i};
    return true;
  }
  return false;
}
/* updateSlides(dt) — ticks all in-progress building slides: smoothstep
   (k²(3-2k)) interpolation from (fx,fz) to (tx,tz) over 3s, rewriting the
   instanced transform each frame; on completion the kept[] record,
   collider, and PLACED_HOUSES are committed and the correction is saved. */
function updateSlides(dt){
  if (!CE.slides || !CE.slides.length) return;
  for (var s=CE.slides.length-1;s>=0;s--){
    var sl=CE.slides[s]; sl.t+=dt;
    var k=Math.min(1, sl.t/sl.dur), e=k*k*(3-2*k);
    var x=sl.fx+(sl.tx-sl.fx)*e, z=sl.fz+(sl.tz-sl.fz)*e;
    setInstanceTransform(sl.i, x, z, sl.b[2], sl.b[3], sl.b[4], false);
    if (k>=1){
      var b=sl.b, ox=sl.fx, oz=sl.fz, r=Math.max(b[2],b[3])/2+0.5;
      b[0]=sl.tx; b[1]=sl.tz;
      moveCollider(ox,oz,sl.tx,sl.tz,r);
      updatePlacedHouse(ox,oz,sl.tx,sl.tz);
      CE.corrections[correctionKey([ox,oz])]={nx:sl.tx, nz:sl.tz, rot:false, bi:sl.i};
      CE.slides.splice(s,1);
      saveLS();
    }
  }
}
/* reapplyCorrections() — on boot, re-applies every saved correction:
   matches kept[] by original position (±0.06u — kept[] may have shifted
   slightly between builds), applies rot swaps, rewrites transforms and
   colliders. This is visual persistence — the fixed map survives reloads. */
function reapplyCorrections(){
  var reg=bldgReg(); if(!reg || !CE.corrections) return;
  var kept=reg.kept, n=0;
  Object.keys(CE.corrections).forEach(function(key){
    var c=CE.corrections[key];
    for (var i=0;i<kept.length;i++){
      var b=kept[i];
      if (Math.abs(b[0]-parseFloat(key.split(',')[0]))<0.06 &&
          Math.abs(b[1]-parseFloat(key.split(',')[1]))<0.06){
        var ox=b[0], oz=b[1];
        if (c.rot){ var t=b[2]; b[2]=b[3]; b[3]=t; }
        b[0]=c.nx; b[1]=c.nz;
        setInstanceTransform(i, c.nx, c.nz, b[2], b[3], b[4], false);
        moveCollider(ox,oz,c.nx,c.nz,Math.max(b[2],b[3])/2+0.5);
        updatePlacedHouse(ox,oz,c.nx,c.nz);
        n++;
        break;
      }
    }
  });
  if (n) clog(n+' building correction(s) restored from the last session.');
}

/* ---------------- add-on builders (sidewalk / driveway / door+windows) ---- */
/* These run as "finishing touches" after a correction: every extra is keyed
   (kind + rounded position) and placed ONCE per session lifetime —
   hasExtra/markExtra prevents duplicates across jobs and reloads. */
// extraKey/hasExtra/markExtra — dedupe keys for placed extras ('walk',
// 'drive', 'door' at rounded x,z); marking persists to localStorage.
function extraKey(kind,x,z){ return kind+':'+x.toFixed(0)+','+z.toFixed(0); }
function hasExtra(kind,x,z){
  return CE.extras.indexOf(extraKey(kind,x,z))>=0;
}
function markExtra(kind,x,z){ CE.extras.push(extraKey(kind,x,z)); saveLS(); }
/* addSidewalk(x,z,w,dir) — concrete strip (w+6 × 2.2u) on the road-facing
   side of the building (offset half-width + 3.4u toward the road), rotated
   to run along the building's street face. */
function addSidewalk(x,z,w,dir){
  if (hasExtra('walk',x,z)) return;
  var g=new THREE.Group();
  var walk=box(w+6,0.25,2.2,0x9aa0a8); walk.position.y=0.12; g.add(walk);
  var px=dir?dir.z:1, pz=dir?-dir.x:0;   /* perpendicular offset toward road */
  g.position.set(x+px*(Math.max(w,8)/2+3.4), groundY(x,z)+0.02, z+pz*(Math.max(w,8)/2+3.4));
  g.rotation.y=Math.atan2(px,pz);
  scene.add(g); markExtra('walk',x,z);
}
/* addDriveway(x,z,w,dir) — asphalt strip (3.4 × 10u) from the street to the
   house (houses only, type 0), offset half-width + 6u toward the road.
   Joshua's standing QA rule: the entrance must be reachable from the road. */
function addDriveway(x,z,w,dir){
  if (hasExtra('drive',x,z)) return;
  var dx=dir?dir.x:0, dz=dir?dir.z:1;
  var g=new THREE.Group();
  var drive=box(3.4,0.22,10,0x777d85); drive.position.y=0.11; g.add(drive);
  g.position.set(x+dx*(Math.max(w,8)/2+6), groundY(x,z)+0.02, z+dz*(Math.max(w,8)/2+6));
  g.rotation.y=Math.atan2(dx,dz);
  scene.add(g); markExtra('drive',x,z);
}
/* addDoorWindows(x,z,w,h,dir) — street-facing door (1.4 × 2.6u, centered)
   + two windows on the building's street face, rotated to face the road.
   This is the "storefronts face the street" fix from the audit. */
function addDoorWindows(x,z,w,h,dir){
  if (hasExtra('door',x,z)) return;
  var dx=dir?dir.x:0, dz=dir?dir.z:1;
  var g=new THREE.Group();
  var gy=groundY(x,z), hw=w/2;
  var door=box(1.4,2.6,0.25,0x4a3220); door.position.set(0,1.3,hw+0.1); g.add(door);
  [-w*0.3, w*0.3].forEach(function(o){
    var win=box(1.6,1.4,0.2,0x9fc6e8); win.position.set(o,2.2,hw+0.08); g.add(win);
  });
  g.position.set(x,gy-0.6,z);
  g.rotation.y=Math.atan2(dx,dz);
  scene.add(g); markExtra('door',x,z);
}
/* crewFinishingTouches(def) — after a correction, the crew makes the site
   proper: sidewalk (all types), driveway (houses only, type 0), and
   door+windows on the street-facing side. All aimed via toRoadDir so the
   extras face the road. */
function crewFinishingTouches(def){
  try{
    var reg=bldgReg(); if(!reg) return;
    var b=reg.kept[def.bi]; if(!b) return;
    var rd=toRoadDir(b[0],b[1]); if(!rd) return;
    addSidewalk(b[0],b[1],b[2],{x:rd.x,z:rd.z});
    if (b[5]===0) addDriveway(b[0],b[1],b[2],{x:rd.x,z:rd.z});
    addDoorWindows(b[0],b[1],b[2],b[4],{x:rd.x,z:rd.z});
  }catch(e){}
}

/* ---------------- patrol route continuation ---------------- */
/* WHY THIS EXISTS (2026-10-09): patrol units used to bounce back and forth
   on a single road segment forever. On a short segment (e.g. Utoy Cir SW,
   ~200u) that looks exactly like "looping". Now, when a unit reaches a
   segment end, it looks for a CONNECTED segment (endpoint within snap
   radius) and keeps driving onto it instead of bouncing. Bounce is kept as
   the dead-end fallback. Same pattern as traffic_system.js's endpoint grid
   and roadcrew_system.js's patrolAdvance. */
var CE_EP=null;          // lazy endpoint grid over roadDrawData
var CE_EP_CELL=120;      // grid cell size (u)
var CE_SNAP_R=70;        // endpoint snap radius (u) — matches traffic
var CE_MIN_SEG=8;        // never continue onto a stub shorter than this
/* ceBuildEP() — builds the endpoint spatial grid once: every roadDrawData
   segment contributes its two endpoints keyed by grid cell. Lazy — safe to
   call any time; no-ops after the first build. */
function ceBuildEP(){
  if (CE_EP) return CE_EP;
  var grid={};
  try{
    for (var i=0;i<roadDrawData.length;i++){
      var r=roadDrawData[i];
      if (!r||!r.pts||r.pts.length<2) continue;
      for (var e=0;e<2;e++){
        var p=r.pts[e===0?0:r.pts.length-1];
        var k=Math.floor(p[0]/CE_EP_CELL)+','+Math.floor(p[1]/CE_EP_CELL);
        (grid[k]=grid[k]||[]).push({ri:i, end:e, x:p[0], z:p[1],
          name:r.name||'', npts:r.pts.length});
      }
    }
  }catch(e){}
  CE_EP={grid:grid};
  return CE_EP;
}
/* ceFindConnection(x, z, selfSeg, blacklist) — nearest DIFFERENT segment
   whose endpoint is within CE_SNAP_R of (x,z). Prefers the same road name
   (keeps the patrol on its corridor); skips blacklisted and stub segments.
   Returns {seg, idx, end} or null. */
function ceFindConnection(x, z, selfSeg, blacklist){
  ceBuildEP();
  var gx=Math.floor(x/CE_EP_CELL), gz=Math.floor(z/CE_EP_CELL);
  var best=null, bd=CE_SNAP_R*CE_SNAP_R, bestSame=null, bdSame=CE_SNAP_R*CE_SNAP_R;
  var selfName='';
  try{ selfName=selfSeg.name||''; }catch(e){}
  for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
    var a=CE_EP.grid[ix+','+iz]; if(!a) continue;
    for (var i=0;i<a.length;i++){
      var c=a[i];
      var seg=null;
      try{ seg=roadDrawData[c.ri]; }catch(e){ continue; }
      if (!seg||seg===selfSeg) continue;
      if (seg.pts.length<CE_MIN_SEG) continue;      // skip stubs
      if (blacklist && blacklist.indexOf(seg)>=0) continue;
      /* v1.16 (Joshua's directive): the old StuckDiag.isBadSpot avoidance
         was REMOVED — units do not reroute around flagged bad spots; they
         pull over and wait for the data fix. Connection-finding stays. */
      var dx=c.x-x, dz=c.z-z, d2=dx*dx+dz*dz;
      if (d2<bd){ bd=d2; best=c; }
      if (c.name && c.name===selfName && d2<bdSame){ bdSame=d2; bestSame=c; }
    }
  }
  var pick=bestSame||best;
  if (!pick) return null;
  var pseg=null;
  try{ pseg=roadDrawData[pick.ri]; }catch(e){ return null; }
  return {seg:pseg, idx:pick.end===1?pseg.pts.length-1:0, end:pick.end};
}
/* cePatrolAdvance(u, dt) — moves the patrol along its polyline; at a segment
   end, tries to continue onto a connected segment (ceFindConnection).
   On a successful hop the unit starts at the matched endpoint heading
   inward, and its stuck-detector history is cleared. Falls back to bounce
   at true dead ends. */
function cePatrolAdvance(u, dt){
  var pts=u.seg.pts, n=pts.length;
  var a=pts[clamp(Math.round(u.i),0,n-1)], b2=pts[clamp(Math.round(u.i)+u.dir,0,n-1)];
  var dx=b2[0]-a[0], dz=b2[1]-a[1], L=Math.hypot(dx,dz)||1;
  u.i+=u.dir*(u.speed*dt)/L;
  var hitEnd=false, whichEnd=0;
  if (u.i>=n-1){ u.i=n-1; hitEnd=true; whichEnd=1; }
  else if (u.i<=0){ u.i=0; hitEnd=true; whichEnd=0; }
  if (hitEnd){
    var ep=pts[whichEnd===1?n-1:0];
    var conn=null;
    try{ conn=ceFindConnection(ep[0], ep[1], u.seg, CE.badSegs); }catch(e){ conn=null; }
    if (conn){
      u.seg=conn.seg; u.i=conn.idx; u.dir=conn.end===1?-1:1;
      if (u.stuck && u.stuck.noteRecovery) u.stuck.noteRecovery();
      return;
    }
    u.dir=whichEnd===1?-1:1;   // dead end — bounce (old behavior)
  }
}

/* ---------------- patrol units (24/7) ---------------- */
/* spawnPatrol(unitNo, dx, dz) — one code-enforcement SUV on the nearest
   non-highway road to (dx,dz), with an inspector figure riding in the
   passenger seat (+0.55,+0.6). Patrols: home-base/Dollar Mill, downtown
   commercial, Mableton/west, Riverdale/south. */
function spawnPatrol(unitNo, dx, dz){
  var nr=nearestRoad(dx,dz,false);
  if (!nr) return null;
  var suv=makeInspectorSUV();
  var p0=nr.seg.pts[nr.idx];
  var _sy=groundY(p0[0],p0[1]);
  if (typeof clampVehY==='function') _sy=clampVehY(p0[0],p0[1],_sy);  // v1.12 ground clamp
  suv.position.set(p0[0], _sy, p0[1]);
  scene.add(suv);
  var off=makeInspector();
  off.position.set(0.55,0,0.6); suv.add(off);
  var u={no:unitNo, mesh:suv, seg:nr.seg, i:nr.idx, dir:1,
         speed:PATROL_SPEED, pauseT:0, target:null, clearT:0};
  CE.patrols.push(u);
  return u;
}
/* patrolTarget(u) — the nearest STRUCTURAL, still-undiscovered defect.
   Officers discover by proximity (60u); they don't pathfind to defects —
   simple sim logic, Joshua's rule. */
function patrolTarget(u){
  var best=null, bd=1e18;
  DEFECTS.forEach(function(d){
    if (!d.structural || d.state!=='undiscovered') return;
    var dd=dist2(u.mesh.position.x,u.mesh.position.z,d.x,d.z);
    if (dd<bd){ bd=dd; best=d; }
  });
  return best;
}
/* ---------------- stuck-loop recovery (shared stuck.js module) ---------------- */
/* stuckRecoverCE(u) — wraps recoverStuckUnit() for code enforcement:
   'Officer N' label, dispatch-log logging. v1.16 (Joshua's rule): the
   officer pulls over and waits for the data fix — no reassignment, no
   rerouting. The reposition callback below is deprecated (kept for opts
   compatibility but no longer called by recoverStuckUnit). */
function stuckRecoverCE(u){
  if (typeof recoverStuckUnit!=='function') return;
  recoverStuckUnit(u, {
    unitLabel:'Officer '+u.no,
    log:function(m){ clog(m); },
    toast:function(m){ toast(m); },
    nearestRoad:function(x,z){ return nearestRoad(x,z); },  // any road
    blacklist:CE.badSegs,
    reposition:function(u2,nr){
      var p0=nr.seg.pts[nr.idx];
      u2.seg=nr.seg; u2.i=nr.idx; u2.dir=1; u2.pauseT=0; u2.target=null; u2.clearT=0;
      var _ry=groundY(p0[0],p0[1])+0.05;
      if (typeof clampVehY==='function') _ry=clampVehY(p0[0],p0[1],_ry);  // v1.12 ground clamp
      u2.mesh.position.set(p0[0], _ry, p0[1]);
      if (u2.stuck) u2.stuck.noteRecovery();
    }
  });
}
/* updatePatrol(u, dt) — per-frame officer logic:
   1. 24/7 watchdog: re-adds the mesh to the scene if it somehow left it.
   2. If paused to inspect: flash the light bar, count down INSPECT_T; then
      mark 'found' and, after DISPATCH_T (6s), either DEFER (pending audit
      covers the spot, or no clear spot exists — flagged for Joshua's
      review) or mark 'dispatched' and roll the construction crew.
   3. Stuck-loop sampling (shared StuckDetector; skipped while legitimately
      paused).
   4. Drive the road polyline at 12 u/s, bouncing off the ends.
   5. Discovery: within 60u of an undiscovered structural defect → stop and
      inspect. Nothing to find: "sector clear" heartbeat every 300s keeps
      the 24/7 beat honest in the log. */
function updatePatrol(u, dt){
  var m=u.mesh;
  /* 24/7 watchdog: if the mesh somehow left the scene, put the unit back */
  if (!m.parent){ try{ scene.add(m); }catch(e){} }
  /* v1.16 wait-for-fix (Joshua's rule): an officer parked at a bad spot sits
     PATIENTLY by the road until the data team fixes it — no rerouting
     around the problem. waitTick re-checks the data periodically; the
     officer resumes only after the fix is confirmed. */
  if (u.waitingForFix){
    try{
      if (typeof StuckDiag!=='undefined' && typeof StuckDiag.waitTick==='function')
        StuckDiag.waitTick(u, dt, function(mm){ clog(mm); });
    }catch(e){}
    var _wb2=m.userData.lightBar; if (_wb2) _wb2.visible=(CE.tick%10<5);  // flash while waiting
    return;
  }
  if (u.pauseT>0){
    u.pauseT-=dt;
    var b=m.userData.lightBar;
    if (b) b.visible=(CE.tick%10<5);
    if (u.pauseT<=0 && u.target){
      var d=u.target; u.target=null;
      d.state='found';
      clog('Officer '+u.no+' flagged '+d.id+' ('+d.street+') — contacted dispatch.');
      /* v1.18 veteran field note — the officer reads it with 30-year eyes. */
      try{ if(typeof VeteranCrew!=='undefined') clog('Officer '+u.no+' field note: "'+VeteranCrew.fieldNote('building')+'"'); }catch(e){}
      toast('🏢 Code enforcement flagged a building ('+d.street+') — dispatch notified');
      setTimeout(function(){
        if (d.state!=='found') return;
        if (auditCovers(d)){
          d.state='deferred';
          clog(d.id+' DEFERRED — a pending audit item covers this spot. Flagged for Joshua\u2019s review, crew stood down.');
          toast('🏢 '+d.id+' deferred to Joshua\u2019s review');
          saveLS(); refreshPanel(); refreshBoard();
          return;
        }
        if (d.nx==null && d.kind==='encroach' && !d.nx){
          d.state='deferred';
          clog(d.id+' DEFERRED — no clear spot nearby. Flagged for Joshua\u2019s review.');
          saveLS(); refreshPanel(); refreshBoard();
          return;
        }
        d.state='dispatched';
        clog('Dispatch pulled true specs for '+d.id+': "'+d.truth+'" — construction crew rolling.');
        dispatchConstruction(d);
      }, DISPATCH_T*1000);
    }
    return;
  }
  // stuck-loop detection (shared stuck.js module) — not sampled while
  // legitimately paused inspecting a building
  if (typeof StuckDetector!=='undefined'){
    if (!u.stuck) u.stuck=new StuckDetector();
    // v1.14: provide segment data for root-cause diagnosis
    // (Joshua's directive: find WHY it's stuck, not just THAT)
    try{ if (u.stuck && typeof u.stuck.setSegment==='function' && u.seg) u.stuck.setSegment(u.seg); }catch(e){}
    if (u.stuck.sample(m.position.x, m.position.z, dt)) stuckRecoverCE(u);
  }
  // drive along the polyline (continues onto connected roads at ends;
  // bounces only at true dead ends — see cePatrolAdvance)
  cePatrolAdvance(u, dt);
  var pts=u.seg.pts, n=pts.length;
  var t=u.i-Math.floor(u.i), i0=clamp(Math.floor(u.i),0,n-2);
  var p=pts[i0], q=pts[i0+1];
  var x=p[0]+(q[0]-p[0])*t, z=p[1]+(q[1]-p[1])*t;
  var _cy=groundY(x,z)+0.05;
  if (typeof clampVehY==='function') _cy=clampVehY(x,z,_cy);  // v1.12: ground clamp — no sky-floaters
  m.position.set(x, _cy, z);
  var hd=Math.atan2((q[0]-p[0])*u.dir,(q[1]-p[1])*u.dir);
  m.rotation.y=hd;
  var bar=m.userData.lightBar; if (bar) bar.visible=(CE.tick%24<12);
  if (!u.target) u.target=patrolTarget(u);
  if (u.target){
    var d2=u.target;
    if (d2.state!=='undiscovered'){ u.target=null; }
    else if (dist2(x,z,d2.x,d2.z) < DISCOVER_R*DISCOVER_R){
      u.pauseT=INSPECT_T;
      d2.state='inspecting';
      clog('Officer '+u.no+' stopped at a suspect building near '+d2.street+' — inspecting.');
    }
  } else {
    /* nothing to find: keep the 24/7 beat honest */
    u.clearT+=dt;
    if (u.clearT>300){ u.clearT=0; clog('Officer '+u.no+': sector clear — continuing patrol.'); }
  }
}
/* auditCovers(d) — true when a MONITORING (non-structural) audit item sits
   within 120u of the defect. That means dispatch data is uncertain here —
   the crew stands down and the defect is deferred to Joshua's review rather
   than guessing. */
function auditCovers(d){
  for (var i=0;i<DEFECTS.length;i++){
    var a=DEFECTS[i];
    if (a.structural || a.state!=='monitoring') continue;
    if (!a.x && !a.z) continue;
    if (dist2(d.x,d.z,a.x,a.z) < 120*120) return true;
  }
  return false;
}

/* ---------------- dispatch office (shared with road crew) ---------------- */
/* buildDispatch() — the code-enforcement dispatch office (hall + spec board
   + inspector figure + floating label). Placed at window.__dispatchOffice +
   (46, 8) when the road-crew office already claimed the area, so the two
   offices sit side by side instead of overlapping; sets __dispatchOffice if
   it doesn't exist yet (ordering is safe either way). */
function buildDispatch(){
  var bx=2160, bz=3760;
  if (typeof window.__dispatchOffice!=='undefined' && window.__dispatchOffice){
    bx=window.__dispatchOffice.x+46; bz=window.__dispatchOffice.z+8;
  }
  var ok=false;
  outer:
  for (var r=0;r<80;r+=8){
    for (var a=0;a<8;a++){
      var x=bx+Math.cos(a/8*Math.PI*2)*r, z=bz+Math.sin(a/8*Math.PI*2)*r;
      try{ if (typeof onRoad==='function' && onRoad(x,z)) continue; }catch(e){}
      bx=x; bz=z; ok=true; break outer;
    }
  }
  var y=groundY(bx,bz);
  var g=new THREE.Group();
  var hall=box(12,4.6,9,0xcfd6e4); hall.position.y=2.3; g.add(hall);
  var roof=box(13,0.7,10,0x2a3a5e); roof.position.y=4.95; g.add(roof);
  var door=box(2.2,3.2,0.3,0x2a2d33); door.position.set(0,1.6,4.55); g.add(door);
  for (var i=-1;i<=1;i++){
    var win=box(2.2,1.5,0.25,0x9fc6e8); win.position.set(i*3.8,2.9,4.55); g.add(win);
  }
  var sign=new THREE.Mesh(new THREE.PlaneGeometry(10,2.4),
    new THREE.MeshLambertMaterial({map:signTexture('CODE ENFORCEMENT','CITY OF ADAMSVILLE'), side:THREE.DoubleSide}));
  sign.position.set(0,6.2,4.6); g.add(sign);
  var post1=box(0.3,4.6,0.3,0x555c66); post1.position.set(-3.4,2.3,7.6); g.add(post1);
  var post2=box(0.3,4.6,0.3,0x555c66); post2.position.set(3.4,2.3,7.6); g.add(post2);
  var bt=boardTexture(); CE.boardTex=bt;
  var board=new THREE.Mesh(new THREE.PlaneGeometry(7.4,6.4),
    new THREE.MeshLambertMaterial({map:bt.tex, side:THREE.DoubleSide}));
  board.position.set(0,3.6,7.6); g.add(board);
  var insp=makeInspector(); insp.position.set(3.2,0,5.2); g.add(insp);
  var label=labelSprite('🏢 CODE ENFORCEMENT', '#7ec8ff');
  label.position.set(0,10,0); g.add(label);
  g.position.set(bx,y,bz);
  scene.add(g);
  CE.dispatch={x:bx, z:bz, group:g};
  if (typeof window.__dispatchOffice==='undefined' || !window.__dispatchOffice){
    window.__dispatchOffice={x:bx, z:bz, by:'codeenforce'};
  }
  clog('Code enforcement office open — spec board holds OSM + Street View truth data. Crews on duty 24/7.');
}
function refreshBoard(){
  try{ if (CE.boardTex) CE.boardTex.redraw(); }catch(e){}
}

/* ---------------- construction jobs ---------------- */
/* dispatchConstruction(d) — rolls the crew: yellow work truck parked 16u to
   the side, 4 hi-vis workers (lime vest + white hard hat), scaffolding
   around the building's footprint, UNDER RENOVATION sign, and 6 barriers in
   a ring. When MAX_JOBS (2) are already active, the defect QUEUES instead
   (24/7 rotation — the queue drains as jobs finish). defect state →
   'working'. */
function dispatchConstruction(d){
  if (CE.jobs.length>=MAX_JOBS){ CE.queue.push(d); d.state='dispatched';
    clog(d.id+' queued — crews are on other sites (24/7 rotation).'); return; }
  var y=groundY(d.x,d.z);
  var grp=new THREE.Group(); scene.add(grp);
  var rd=toRoadDir(d.x,d.z), heading=rd?Math.atan2(rd.x,rd.z):0;
  var hx=Math.sin(heading), hz=Math.cos(heading), px=hz, pz=-hx;
  /* crew truck parked to the side */
  var truck=makeConstrTruck();
  var txp=d.x+px*16, tzp=d.z+pz*16;
  truck.position.set(txp, groundY(txp,tzp)+0.05, tzp);
  truck.rotation.y=heading+0.25; grp.add(truck);
  /* four hi-vis workers (crew doubled) */
  var workers=[];
  [[-3,3],[3,-2],[-3,-2],[3,3]].forEach(function(o){
    var w=makeConstrWorker();
    var wx=d.x+o[0], wz=d.z+o[1];
    w.position.set(wx, groundY(wx,wz), wz);
    w.rotation.y=Math.random()*6.28; grp.add(w); workers.push(w);
  });
  /* scaffolding + UNDER RENOVATION sign */
  var reg=bldgReg(), b=reg?reg.kept[d.bi]:null;
  var bw=b?b[2]:10, bd=b?b[3]:10, bh=b?Math.max(2.5,b[4]):4;
  var scaf=makeScaffold(bw,bd,bh);
  scaf.position.set(d.x, groundY(d.x,d.z), d.z); grp.add(scaf);
  var usign=new THREE.Mesh(new THREE.PlaneGeometry(5,3.1),
    new THREE.MeshLambertMaterial({map:signTexture('UNDER','RENOVATION','#e8641b'), side:THREE.DoubleSide}));
  var sxp=d.x+px*(bw/2+5), szp=d.z+pz*(bd/2+5);
  usign.position.set(sxp, groundY(sxp,szp)+2.2, szp);
  usign.rotation.y=heading; grp.add(usign);
  /* barriers */
  var barriers=[];
  for (var bi=0;bi<6;bi++){
    var ang=bi/6*Math.PI*2;
    var barx=d.x+Math.cos(ang)*(bw/2+7), barz=d.z+Math.sin(ang)*(bd/2+7);
    var bar=box(2.2,1.0,0.3,0xe8641b);
    bar.position.set(barx, groundY(barx,barz)+0.5, barz);
    bar.rotation.y=-ang; grp.add(bar); barriers.push(bar);
  }
  d.state='working';
  CE.jobs.push({defect:d, group:grp, truck:truck, workers:workers,
    scaf:scaf, sign:usign, barriers:barriers, t:0, applied:false});
  /* v1.18 VETERAN CREW (Joshua 2026-10-09): 30-year-veteran workflow —
     assess → report → dispatch → setup → fix → verify → auto-save.
     A foreman (white hard hat + clipboard) leads the job; the workers
     stage by the truck and walk out to their stations in the setup phase. */
  try{
    if (typeof VeteranCrew!=='undefined'){
      var _job=CE.jobs[CE.jobs.length-1];
      var _vt3=[];
      _job.workers.forEach(function(w){ _vt3.push({x:w.position.x, z:w.position.z}); });
      var _fm3=VeteranCrew.makeForeman('constr');
      if (_fm3){ _fm3.position.set(txp, groundY(txp,tzp), tzp); _job.group.add(_fm3); _job.foreman=_fm3; }
      _job.vet=VeteranCrew.jobState({crew:'CONSTR', kind:d.kind, issue:d,
        fixDur:WORK_T, siteR:(bw/2+7), truckPos:{x:txp, z:tzp},
        workerTargets:_vt3, foremanStyle:'constr'});
      /* stage the crew by the truck — the setup phase walks them out. */
      var _stg3=[[2.5,0.5],[-2.5,0.5],[1.5,3],[-1.5,3]];
      _job.workers.forEach(function(w,k){
        var _s3=_stg3[k%_stg3.length];
        w.position.set(txp+_s3[0], groundY(txp+_s3[0],tzp+_s3[1]), tzp+_s3[1]);
      });
    }
  }catch(e){}
  clog('Construction crew on site at '+d.id+' ('+d.street+') — scaffolding up, renovation underway.');
  toast('🏢 Construction crew fixing a building ('+d.street+')');
  try{ Report.setSys('codeenforce', sysReport()); }catch(e){}
  refreshBoard(); refreshPanel();
}
/* finishJob(job) — end of the 60s work window: finishing touches
   (sidewalk/driveway/door+windows), remove the whole work-zone group, mark
   the defect 'fixed', persist, then pull the next queued job (24/7). */
function finishJob(job){
  var d=job.defect;
  crewFinishingTouches(d);
  scene.remove(job.group);
  d.state='fixed';
  clog(d.id+' ('+d.street+') CORRECTED — '+d.fix+' Crew clear, site clean.');
  toast('✅ Building corrected ('+d.street+')');
  saveLS();
  try{ Report.setSys('codeenforce', sysReport()); }catch(e){}
  refreshBoard(); refreshPanel();
  /* 24/7: pull the next queued job */
  if (CE.queue.length){
    var nxt=CE.queue.shift();
    if (nxt.state==='dispatched') dispatchConstruction(nxt);
  }
}
/* ceFixTick(j, dt) — the legacy per-frame construction work: worker
   repair animation, truck light-bar flash, and the mid-job correction
   apply (at 35% of WORK_T: encroach moves slide animated, sideways
   rotates; a failed apply defers the defect to Joshua's review).
   updateJobs calls this during the 'fixing' phase for veteran jobs, or
   every frame for legacy jobs. */
function ceFixTick(j, dt){
  j.workers.forEach(function(w,k){
    w.position.y+=Math.sin(CE.time*6+k*2.1)*0.014;
    w.rotation.y+=Math.sin(CE.time*1.1+k)*0.012;
    var a=w.userData.armR; if(a) a.rotation.x=Math.sin(CE.time*6+k)*0.8;
  });
  var bar=j.truck.userData.lightBar; if (bar) bar.visible=(CE.tick%14<7);
  /* apply the fix midway through the work */
  if (!j.applied && j.t>WORK_T*0.35){
    j.applied=true;
    var ok=applyCorrection(j.defect, j.defect.kind==='encroach');
    if (!ok && j.defect.kind==='sideways') ok=applyCorrection(j.defect, false);
    if (!ok){
      j.defect.state='deferred';
      clog(j.defect.id+' could not be corrected in place — flagged for Joshua\u2019s review.');
    } else {
      clog(j.defect.id+': correction applied — '+j.defect.fix);
    }
    saveLS(); refreshPanel(); refreshBoard();
  }
}
/* updateJobs(dt) — per-frame job ticks.
   v1.18 VETERAN CREW (Joshua 2026-10-09): jobs carrying vet state run the
   30-year-veteran phase machine (arrive → assess → report → setup → fix →
   verify). The legacy construction animation runs only during 'fixing';
   when the machine returns 'done' the normal finishJob path runs
   (finishing touches, cleanup, localStorage persistence, 24/7 queue pull).
   Jobs without vet state keep the legacy timing. */
function updateJobs(dt){
  for (var i=CE.jobs.length-1;i>=0;i--){
    var j=CE.jobs[i];
    if (j.vet && typeof VeteranCrew!=='undefined'){
      var ph=VeteranCrew.updateJob(j, dt, {time:CE.time,
        log:function(m){ clog(m); }, toast:function(m){ toast(m); }});
      if (ph==='fixing'){ j.t+=dt; ceFixTick(j,dt); }
      else if (ph==='done'){ finishJob(j); CE.jobs.splice(i,1); }
      continue;
    }
    j.t+=dt;
    ceFixTick(j,dt);
    if (j.t>=WORK_T){
      finishJob(j);
      CE.jobs.splice(i,1);
    }
  }
}

/* ---------------- HUD: dispatch button + shared log panel ---------------- */
function buildUI(){
  if (CE.uiBuilt) return; CE.uiBuilt=true;
  try{
    var css=document.createElement('style');
    css.textContent=
      /* v1.21: icon sits in the HUD icon row at top:96px, adjacent to the
         backpack (#inv-btn at left:12px). Title corner is left clear. */
      '#ce-btn{position:fixed;left:72px;top:96px;z-index:20;width:52px;height:52px;border-radius:12px;'+
      'border:2px solid #7ec8ff;background:rgba(20,24,34,.88);color:#7ec8ff;font-size:24px;}'+
      '#ce-panel{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);}'+
      '#ce-panel.show{display:flex;}'+
      '#ce-panel .card{background:#161b26;border-radius:14px;padding:20px 22px;max-width:480px;width:88%;max-height:76vh;display:flex;flex-direction:column;}'+
      '#ce-panel h3{margin:0 0 4px 0;color:#7ec8ff;}'+
      '#ce-panel .sub{color:#8a93a6;font-size:13px;margin-bottom:10px;}'+
      '#ce-list{overflow-y:auto;flex:1;min-height:80px;}'+
      '.ce-def{margin:10px 0;padding:10px 12px;border-radius:10px;border:2px solid #444;background:#222836;color:#fff;font-size:14px;}'+
      '.ce-def .rid{font-weight:bold;color:#7ec8ff;}'+
      '.ce-def .st{float:right;font-weight:bold;}'+
      '.ce-def .truth{color:#9fb2cc;font-size:13px;margin-top:6px;}'+
      '.ce-log{margin:6px 0;padding:6px 10px;font-size:13px;color:#c9c9c9;border-left:3px solid #7ec8ff;}'+
      '.ce-log .lt{color:#8a93a6;margin-right:8px;}'+
      '#ce-close{margin-top:12px;padding:10px 18px;font-size:15px;border-radius:10px;border:none;background:#7ec8ff;color:#111;font-weight:bold;width:100%;}';
    document.head.appendChild(css);
    var btn=document.createElement('button');
    btn.id='ce-btn'; btn.title='Code enforcement dispatch log'; btn.innerHTML='🏢';
    btn.addEventListener('click', function(){ togglePanel(); });
    document.body.appendChild(btn);
    var panel=document.createElement('div');
    panel.id='ce-panel';
    panel.innerHTML='<div class="card"><h3>🏢 Code Enforcement Dispatch</h3>'+
      '<div class="sub">True specs: OSM + Street View audit — crews on duty 24/7</div>'+
      '<div id="ce-list"></div><button id="ce-close">Close</button></div>';
    document.body.appendChild(panel);
    document.getElementById('ce-close').addEventListener('click', function(){ togglePanel(false); });
  }catch(e){}
}
function stateColor(s){
  return s==='fixed' ? '#51d651' :
         (s==='working'||s==='dispatched') ? '#ffb02e' :
         (s==='found'||s==='inspecting') ? '#6ec6ff' :
         s==='deferred' ? '#c98aff' : '#c9c9c9';
}
function refreshPanel(){
  if (!CE.uiBuilt) return;
  try{
    var el=document.getElementById('ce-list'); if(!el) return;
    var h='<div class="sub">BUILDING DEFECTS</div>';
    DEFECTS.forEach(function(d){
      h+='<div class="ce-def"><span class="rid">'+d.id+'</span> '+(d.street||'')+
         '<span class="st" style="color:'+stateColor(d.state)+'">'+d.state.toUpperCase()+'</span><br>'+
         '<div class="truth">TRUE SPECS: '+d.truth+'<br>FIX: '+d.fix+'</div></div>';
    });
    /* shared log: road defects when the road-crew system is loaded */
    try{
      if (window.ROADCREW && window.ROADCREW.defects && window.ROADCREW.defects.length){
        h+='<div class="sub" style="margin-top:10px">ROAD DEFECTS (road crew)</div>';
        window.ROADCREW.defects.forEach(function(d){
          h+='<div class="ce-def"><span class="rid">'+d.id+'</span> '+(d.street||'')+
             '<span class="st" style="color:'+stateColor(d.state)+'">'+String(d.state).toUpperCase()+'</span></div>';
        });
      }
    }catch(e){}
    h+='<div class="sub" style="margin-top:8px">EVENT LOG</div>';
    var logs=CE.log.slice(-20).reverse();
    if (!logs.length) h+='<div class="ce-log">No events yet — officers are on patrol.</div>';
    logs.forEach(function(e){
      h+='<div class="ce-log"><span class="lt">'+e.t+'</span>'+e.msg+'</div>';
    });
    el.innerHTML=h;
  }catch(e){}
}
function togglePanel(force){
  try{
    CE.panelOpen = (typeof force==='boolean') ? force : !CE.panelOpen;
    var p=document.getElementById('ce-panel');
    if (p){ if(CE.panelOpen){ refreshPanel(); p.classList.add('show'); } else p.classList.remove('show'); }
  }catch(e){}
}
window.toggleCodeEnforceLog=togglePanel;

/* ---------------- main loop ---------------- */
/* updateCodeEnforce(dt) — frame tick: ticks all officer patrols, ticks all
   construction jobs, ticks building slides, reports to the Report panel
   every 10s. dt clamped to 50ms. Guarded — never breaks the frame. */
function updateCodeEnforce(dt){
  if (!CE.ready) return;
  try{
    dt=Math.min(0.05, dt||0.016);
    CE.tick++; CE.time+=dt;
    var i;
    for (i=0;i<CE.patrols.length;i++) updatePatrol(CE.patrols[i], dt);
    updateJobs(dt);
    updateSlides(dt);
    CE.repT-=dt;
    if (CE.repT<=0){ CE.repT=10; try{ Report.setSys('codeenforce', sysReport()); }catch(e){} }
  }catch(e){}
}

/* ---------------- init ---------------- */
/* initCodeEnforce() — load saved state, re-apply saved corrections (visual
   persistence), build the dispatch office + HUD, run the boot defect scan,
   spawn 4 patrol SUVs, restore saved extras. Stays OFF (with a Report
   error) when the __bldgMeshes hook is missing — corrections are impossible
   without the shared registry. Wraps the global animate() so
   updateCodeEnforce runs every frame; boot waits for world deps
   (roadDrawData, heightAt, onRoad, distToRoadEdge, __bldgMeshes) and gives
   up after 120s without breaking the game. */
function initCodeEnforce(){
  loadLS();
  if (!bldgReg()){
    try{ if(typeof Report!=='undefined') Report.noteError('codeenforce','no-bldg-meshes','__bldgMeshes hook missing in index.html'); }catch(e){}
    return;
  }
  reapplyCorrections();
  buildDispatch();
  buildUI();
  scanBuildings();
  /* patrol 1: home-base / Dollar Mill neighborhood */
  spawnPatrol(1, 3160, 3614);
  /* patrol 2: downtown commercial */
  spawnPatrol(2, 5600, 7300);
  /* patrol 3: Mableton / west side */
  spawnPatrol(3, 1500, 4500);
  /* patrol 4: Riverdale / south side */
  spawnPatrol(4, 5000, 9000);
  /* restore saved extras (sidewalks/driveways/doors placed in past sessions) */
  restoreExtras();
  if (!CE.log.length) clog('Code enforcement online — officers on 24/7 patrol, construction crews standing by.');
  CE.ready=true;
  try{ Report.setSys('codeenforce', sysReport()); }catch(e){}
  window.CODEENFORCE={defects:DEFECTS, log:CE.log, toggle:togglePanel,
    patrols:CE.patrols,  /* v1.19 CITYWORKFORCE (2026-10-09): expose patrol units
                            so the municipal workforce roster can assign named
                            officer identities. */};
  try{
    if (typeof animate==='function' && !animate.__codeenforceWrap){
      var orig=animate;
      var wrapped=function(){ orig(); updateCodeEnforce(0.016); };
      wrapped.__codeenforceWrap=true;
      animate=wrapped;
    }
  }catch(e){}
}
/* restoreExtras() — after reload: extras are re-created by
   crewFinishingTouches only when jobs run; the persisted markExtra keys
   prevent double-placement. Nothing to rebuild geometrically here — the keys
   simply guard against duplicates. (Kept as a named hook in case Joshua
   later wants physical restore of sidewalks/driveways.) */
function restoreExtras(){
  /* extras are re-created by crewFinishingTouches only when jobs run;
     positions persist via markExtra keys to avoid duplicates. Nothing to
     rebuild geometrically here — the keys simply prevent double-placement. */
}
var bootTries=0;
var bootTimer=setInterval(function(){
  bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined' && typeof scene!=='undefined' &&
      typeof roadDrawData!=='undefined' && roadDrawData.length>100 &&
      typeof animate==='function' &&
      typeof heightAt==='function' && typeof onRoad==='function' &&
      typeof distToRoadEdge==='function' && !!bldgReg());
  }catch(e){ ready=false; }
  if (ready){
    clearInterval(bootTimer);
    try{ initCodeEnforce(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('codeenforce','init failed',String(e&&e.message||e)); }catch(x){}
    }
  } else if (bootTries>240){
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('codeenforce','boot-timeout','deps never ready'); }catch(e){}
  }
},500);
})();
