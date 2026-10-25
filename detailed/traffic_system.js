/* ============================================================================
   FILE: traffic_system.js — "Surviving Adamsville" AI traffic
   ----------------------------------------------------------------------------
   PURPOSE: Ambient AI traffic vehicles driving the highway/arterial/local
   road network, plus real-world gas stations with NPC refueling.
   KEY SYSTEMS:
     - Road index (arc-length tables) + junction graph (grade/heading-checked
       endpoint matches + mid-segment crossings) with an intersection
       reservation protocol — cars hop onto connecting roads at junctions,
       yield by road-class priority, or loop when a road dead-ends.
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
/* Joshua's HALF-MILE FULL-DRAW RULE (2026-10-17): inside 800u of the player
   (800 units = half a mile — the world is true-scale, 1 unit = 1 metre,
   a mile = 1,609u) traffic is drawn IN FULL: every car holds a render
   slot, at every perf level, automatically. The canonical constant is
   FULL_DRAW_R in perf_budget.js (window.FULL_DRAW_R); fullDrawR() below
   reads it lazily because this module loads first — the 800 fallback is
   the same number, used only if perf_budget failed to load. Retuning the
   circle is one number in perf_budget.js. */
function fullDrawR(){ return (typeof window!=='undefined'&&window.FULL_DRAW_R)||800; }
var MAX_RENDERED   = 108;     // render-slot pool = the WHOLE fleet (44 highway + 28 arterial
                              // + 24 local + 12 near-start cars). The full-draw guarantee is
                              // only honourable if a slot always exists for an inside-circle
                              // car; measured densest real case is 39 cars within 800u
                              // (Downtown spawn — FULL-DRAW-CIRCLE-NOTES.md), and a
                              // fleet-sized pool makes the guarantee unconditional.
                              // If the fleet constants below ever grow, grow this too.
var STREAM_DIST    = 1000;    // geometry streams in within this many units — 200u beyond the
                              // full-draw circle, so a car is already drawn before it crosses
                              // into the guaranteed zone (no pop at the 800u boundary), and a
                              // slotted car keeps its slot out to here (the release radius —
                              // this replaces the old RELEASE_DIST=420; release IS stream-out).
var STREAM_DIST2   = STREAM_DIST*STREAM_DIST;
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
   Wraps the road entries traffic may use (highway + arterial + local)
   with arc-length tables so cars advance in world units along the path.
   src defaults to the loaded zone's roadDrawData; the cross-zone
   extension (below) passes neighbouring zones' flattened records
   through the exact same filter so both sets obey identical rules. */
function buildRoadIndex(src){
  var idx=[];
  var list=src||roadDrawData;
  for (var i=0;i<list.length;i++){
    var r=list[i];
    if (!r||!r.pts||r.pts.length<2||!r.ys||r.ys.length!==r.pts.length) continue;
    // v1.13: include local roads so residential areas have traffic
    /* v2.1: new category set — interstate/highway/major/minor/local all carry traffic */
    if (r.cat!=='interstate'&&r.cat!=='highway'&&r.cat!=='major_artery'&&r.cat!=='minor_artery'&&r.cat!=='arterial'&&r.cat!=='local') continue;
    var cum=[0];
    for (var p=1;p<r.pts.length;p++){
      var dx=r.pts[p][0]-r.pts[p-1][0], dz=r.pts[p][1]-r.pts[p-1][1];
      cum.push(cum[p-1]+Math.sqrt(dx*dx+dz*dz));
    }
    var len=cum[cum.length-1];
    if (len<MIN_ROAD_LEN) continue;
    // lanes per direction: interstates carry r.lanes=5; other highways 3-4;
    // arterials are marked 2/dir in the v1.5 striping pass.
    var lpd = r.lanes>0 ? r.lanes : (r.cat==='interstate' ? 5 : (r.cat==='highway' ? 4 : 2));  /* v2.1 */
    idx.push({r:r, cum:cum, len:len, name:r.name||('road#'+i),
              cat:r.cat, w:r.w||10, lanesPerDir:lpd,
              laneW:(r.w||10)/(lpd*2)});
  }
  return idx;
}

/* ============================================================================
   v1.47 JUNCTION GRAPH + INTERSECTION PROTOCOL (2026-10-11) —
   Expert review #7 (David Okafor, AI Programmer).
   ----------------------------------------------------------------------------
   The old findConnection() snapped road ends together within 70u with NO
   grade or heading check, and crossing traffic streams had no protocol —
   two streams would enter a junction together, block each other, and
   deadlock until a tow truck cleared it.

   This builds a TRUE junction graph once at init:
     (1) Endpoint matching with GRADE (<=3u elevation difference) and
         HEADING (departure direction within ~100 deg of arrival direction)
         checks. Bad snaps — bridge-vs-underpass, wrong-way carriageway
         hops and near-U-turns — are rejected; the car loops instead of
         teleporting. Legal 90-degree intersection turns are allowed.
     (2) Mid-segment CROSSING detection (spatial-hash segment pairs, grade
         checked at the crossing point) so overpasses never become fake
         intersections.
     (3) A per-junction RESERVATION protocol: approaching cars queue; the
         highest-priority road class (highway > arterial > local) goes first
         with first-come order inside a class; everyone else waits at a
         12u stop line. One stream at a time = no mutual blocking, no
         deadlocks. Starvation guard: 20s+ waiters get a priority boost.
         Holders that stall release after 25s so nothing wedges forever.
   Data (TR.jx): nodes[], endNode{"ri:end"->node}, endMatch{"ri:end"->{ri,end}},
   crossByRoad[ri]=[{segT,node}] sorted.
   ============================================================================ */
var JX_SNAP=70, JX_GRADE=3, JX_HEADING_DOT=-0.15;  // ~99 deg max turn: 90-deg
                                                  // intersection turns allowed,
                                                  // wrong-way/U-turn hops rejected
var JX_APPROACH=35, JX_STOP=12, JX_CLEAR=18;       // reservation geometry (u)
var JX_HOLD_TIMEOUT=25, JX_STARVE_S=20;            // seconds
/* roadEndTangent(R,end) — unit vector of travel direction INTO the road end.
   Used by the heading check: a hop is only legal when the departure
   direction out of the new road's end roughly continues the arrival
   direction into the old road's end. */
function roadEndTangent(R,end){
  var pts=R.r.pts, n=pts.length, a, b;
  if (end===1){ a=pts[n-2]; b=pts[n-1]; } else { a=pts[1]; b=pts[0]; }
  var dx=b[0]-a[0], dz=b[1]-a[1], l=Math.hypot(dx,dz)||1;
  return [dx/l, dz/l];
}
/* roadEndY(R,end) — smoothed road height at the endpoint (grade check). */
function roadEndY(R,end){
  var ys=R.r.ys, n=ys.length;
  return end===1?ys[n-1]:ys[0];
}
/* roadRank(cat) — intersection priority: highway > arterial > local. */
/* v2.1: road rank for the new category set (legacy 'arterial' -> minor_artery rank). */
function roadRank(cat){
  if (cat==='interstate') return 5;
  if (cat==='highway') return 4;
  if (cat==='major_artery') return 3;
  if (cat==='minor_artery'||cat==='arterial') return 2;
  return 1;
}
/* buildJunctionGraph(roads) — one-time build. Returns the TR.jx structure. */
function buildJunctionGraph(roads){
  var t0=Date.now();
  /* --- 1. endpoint grid + grade/heading-checked matching --- */
  var grid={}, CELL=80;
  function gk(x,z){ return Math.floor(x/CELL)+','+Math.floor(z/CELL); }
  var ends=[];   // {ri,end,x,z,y,tx,tz}
  roads.forEach(function(R,ri){
    for (var e=0;e<2;e++){
      var p=R.r.pts[e===0?0:R.r.pts.length-1];
      var t=roadEndTangent(R,e);
      var rec={ri:ri,end:e,x:p[0],z:p[1],y:roadEndY(R,e),tx:t[0],tz:t[1]};
      ends.push(rec);
      var k=gk(p[0],p[1]);
      (grid[k]=grid[k]||[]).push(rec);
    }
  });
  var SNAP2=JX_SNAP*JX_SNAP;
  var endMatch={};   // "ri:end" -> {ri,end} (best legal match) or undefined
  ends.forEach(function(A){
    var gx=Math.floor(A.x/CELL), gz=Math.floor(A.z/CELL);
    var best=null, bd=SNAP2;
    for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
      var a=grid[ix+','+iz]; if(!a) continue;
      for (var i=0;i<a.length;i++){
        var B=a[i];
        if (B.ri===A.ri&&B.end===A.end) continue;
        var dx=B.x-A.x, dz=B.z-A.z, d2=dx*dx+dz*dz;
        if (d2>=bd) continue;
        if (Math.abs(B.y-A.y)>JX_GRADE) continue;        // grade check (3u)
        // heading check: arrival dir into A vs departure dir out of B must
        // not oppose (dot>-0.15 ~= within 99 deg). Allows legal 90-degree
        // intersection turns; rejects wrong-way carriageway hops and
        // near-U-turn snaps.
        var dot=A.tx*(-B.tx)+A.tz*(-B.tz);
        if (dot<JX_HEADING_DOT) continue;
        bd=d2; best=B;
      }
    }
    if (best) endMatch[A.ri+':'+A.end]={ri:best.ri,end:best.end};
  });
  /* --- 2. union-find: matched endpoint pairs -> junction nodes --- */
  var parent={};
  function find(k){ while(parent[k]!==k){ parent[k]=parent[parent[k]]; k=parent[k]; } return k; }
  function union(a,b){ a=find(a); b=find(b); if(a!==b) parent[a]=b; }
  ends.forEach(function(E){ var k=E.ri+':'+E.end; parent[k]=k; });
  Object.keys(endMatch).forEach(function(k){
    var m=endMatch[k]; union(k, m.ri+':'+m.end);
  });
  var nodes=[];        // {x,z,y,kind,ends[],cross[],holder,holdT,entered}
  var endNode={};      // "ri:end" -> nodeIdx
  var byRoot={};
  ends.forEach(function(E){
    var k=E.ri+':'+E.end;
    if (!endMatch[k]) return;      // unmatched ends are not junctions
    var r=find(k);
    (byRoot[r]=byRoot[r]||[]).push(E);
  });
  var nEndJx=0;
  Object.keys(byRoot).forEach(function(r){
    var list=byRoot[r], sx=0, sz=0, sy=0, ni=nodes.length;
    list.forEach(function(E){ sx+=E.x; sz+=E.z; sy+=E.y;
      endNode[E.ri+':'+E.end]=ni; });
    nodes.push({x:sx/list.length, z:sz/list.length, y:sy/list.length,
      kind:'end', ends:list.map(function(E){return {ri:E.ri,end:E.end};}),
      cross:[], holder:-1, holdT:0, entered:false, holderRoad:-1, holderDir:0,
      waiters:[]});
    nEndJx++;
  });
  /* --- 3. mid-segment crossing detection (spatial hash, grade-checked) --- */
  var SCELL=100, sgrid={};
  function sgk(x,z){ return Math.floor(x/SCELL)+','+Math.floor(z/SCELL); }
  roads.forEach(function(R,ri){
    var pts=R.r.pts;
    for (var s=0;s<pts.length-1;s++){
      var a=pts[s], b=pts[s+1];
      var x0=Math.floor(Math.min(a[0],b[0])/SCELL),
          x1=Math.floor(Math.max(a[0],b[0])/SCELL),
          z0=Math.floor(Math.min(a[1],b[1])/SCELL),
          z1=Math.floor(Math.max(a[1],b[1])/SCELL);
      for (var gx=x0;gx<=x1;gx++) for (var gz=z0;gz<=z1;gz++){
        var k=gx+','+gz;
        (sgrid[k]=sgrid[k]||[]).push({ri:ri,s:s});
      }
    }
  });
  function segYat(R,s,t){ var ys=R.r.ys; return ys[s]+(ys[s+1]-ys[s])*t; }
  function segCross(ax,az,bx,bz,cx,cz,dx,dz){
    var d=(bx-ax)*(dz-cz)-(bz-az)*(dx-cx);
    if (Math.abs(d)<1e-9) return null;
    var t=((cx-ax)*(dz-cz)-(cz-az)*(dx-cx))/d;
    var u=((cx-ax)*(bz-az)-(cz-az)*(bx-ax))/d;
    if (t>0.02&&t<0.98&&u>0.02&&u<0.98)
      return {x:ax+t*(bx-ax), z:az+t*(bz-az), t:t, u:u};
    return null;
  }
  var crossRaw=[];
  Object.keys(sgrid).forEach(function(k){
    var arr=sgrid[k];
    for (var i=0;i<arr.length;i++) for (var j=i+1;j<arr.length;j++){
      var A=arr[i], B=arr[j];
      if (A.ri===B.ri) continue;
      var RA=roads[A.ri], RB=roads[B.ri];
      var p1=RA.r.pts[A.s], p2=RA.r.pts[A.s+1];
      var p3=RB.r.pts[B.s], p4=RB.r.pts[B.s+1];
      var hit=segCross(p1[0],p1[1],p2[0],p2[1],p3[0],p3[1],p4[0],p4[1]);
      if (!hit) continue;
      var yA=segYat(RA,A.s,hit.t), yB=segYat(RB,B.s,hit.u);
      if (Math.abs(yA-yB)>JX_GRADE) continue;   // overpass — not a junction
      crossRaw.push({x:hit.x,z:hit.z,y:(yA+yB)/2,
        a:{ri:A.ri,s:A.s,t:hit.t}, b:{ri:B.ri,s:B.s,t:hit.u}});
    }
  });
  // dedupe: same crossing found via several grid cells
  var seen={}, cross=[];
  crossRaw.forEach(function(c){
    var k1=c.a.ri+'_'+c.b.ri+'_'+Math.round(c.x/5)+'_'+Math.round(c.z/5);
    var k2=c.b.ri+'_'+c.a.ri+'_'+Math.round(c.x/5)+'_'+Math.round(c.z/5);
    if (seen[k1]||seen[k2]) return;
    seen[k1]=1; cross.push(c);
  });
  /* --- 4. fold crossings into nodes (merge near endpoint nodes first) --- */
  var crossByRoad=[];
  roads.forEach(function(){ crossByRoad.push([]); });
  function roadSegT(R,s,t){ return R.cum[s]+t*((R.cum[s+1]-R.cum[s])||0); }
  cross.forEach(function(c){
    var ni=-1, n, dx, dz;
    for (n=0;n<nodes.length;n++){           // near an endpoint junction?
      dx=nodes[n].x-c.x; dz=nodes[n].z-c.z;
      if (dx*dx+dz*dz<35*35){ ni=n; break; }
    }
    if (ni<0) for (n=0;n<nodes.length;n++){ // near another crossing node?
      if (nodes[n].kind!=='cross') continue;
      dx=nodes[n].x-c.x; dz=nodes[n].z-c.z;
      if (dx*dx+dz*dz<25*25){ ni=n; break; }
    }
    if (ni<0){
      ni=nodes.length;
      nodes.push({x:c.x,z:c.z,y:c.y,kind:'cross',ends:[],cross:[],
        holder:-1,holdT:0,entered:false,holderRoad:-1,holderDir:0,
        waiters:[]});
    }
    var N=nodes[ni];
    N.cross.push(c);
    var sA=roadSegT(roads[c.a.ri],c.a.s,c.a.t);
    var sB=roadSegT(roads[c.b.ri],c.b.s,c.b.t);
    crossByRoad[c.a.ri].push({segT:sA,node:ni});
    crossByRoad[c.b.ri].push({segT:sB,node:ni});
  });
  crossByRoad.forEach(function(a,ri){
    a.sort(function(p,q){ return p.segT-q.segT; });
    var w=[], last=-1;
    for (var i=0;i<a.length;i++){
      if (a[i].node===last) continue;   // same node merged twice on one road
      w.push(a[i]); last=a[i].node;
    }
    crossByRoad[ri]=w;
  });
  return {nodes:nodes, endNode:endNode, endMatch:endMatch,
    crossByRoad:crossByRoad, buildMs:Date.now()-t0,
    nEndJx:nEndJx, nCross:cross.length};
}
/* jxReleaseCar(c) — drop any reservation the car holds (called on road hop
   and state changes so a reservation never outlives its holder's pass). */
function jxReleaseCar(c){
  var JX=TR&&TR.jx; if(!JX) return;
  for (var n=0;n<JX.nodes.length;n++){
    var N=JX.nodes[n];
    if (N.holder===c.id){ N.holder=-1; N.holdT=0; N.entered=false;
      N.holderRoad=-1; N.holderDir=0; }
  }
  c.jxNode=-1; c.jxWait=false;
}
/* jxTick(dt) — the reservation protocol, once per frame BEFORE cars step.
   For every car in 'drive'/'resuming': determine junction candidacy
   (approaching a road end inside a junction node, or approaching a crossing
   point on its road), then per node: grant the reservation to the
   top-priority candidate (highway > arterial > local, first-come inside a
   class, 20s+ waiters boosted), mark the rest as waiting. Waiting cars get
   c.jxWait=true; stepCar() zeroes their desired speed at the stop line. */
function jxTick(dt){
  var JX=TR.jx; if(!JX) return;
  TR.jxClock=(TR.jxClock||0)+dt;
  var clock=TR.jxClock, nodes=JX.nodes, i, c;
  for (i=0;i<TR.cars.length;i++){
    c=TR.cars[i]; c.jxWait=false; c.jxNode=-1;
  }
  var touched={};   // nodeIdx -> true (nodes with candidates this frame)
  for (i=0;i<TR.cars.length;i++){
    c=TR.cars[i];
    var st=c.state;
    if (st!=='drive'&&st!=='resuming') continue;
    var R=TR.roads[c.road], ni=-1, dist=1e18;
    // (a) endpoint junction: approaching our road's end inside a node
    var toEnd=c.dir>0 ? R.len-c.segT : c.segT;
    if (toEnd<JX_APPROACH){
      var key=c.road+':'+(c.dir>0?1:0);
      var en=JX.endNode[key];
      if (en!==undefined){ ni=en; dist=toEnd; }
    }
    // (b) crossing junction: approaching a crossing point on our road
    var cl=JX.crossByRoad[c.road];
    if (cl&&cl.length){
      var lo=0, hi=cl.length-1;
      while (lo<hi){ var mid=(lo+hi)>>1;
        if (cl[mid].segT<c.segT) lo=mid+1; else hi=mid; }
      for (var k=Math.max(0,lo-1);k<=Math.min(cl.length-1,lo+1);k++){
        var e=cl[k], dseg=e.segT-c.segT;
        if (Math.abs(dseg)<JX_APPROACH && dseg*c.dir>0 && Math.abs(dseg)<dist){
          ni=e.node; dist=Math.abs(dseg);
        }
      }
    }
    if (ni<0) continue;
    c.jxNode=ni; touched[ni]=true;
    if (c.jxAt===undefined) c.jxAt={};
    if (c.jxAt[ni]===undefined) c.jxAt[ni]=clock;
    var N=nodes[ni];
    // same-road same-direction followers of the holder stream through
    if (N.holder>=0 && c.road===N.holderRoad && c.dir===N.holderDir) continue;
    var w=N.waiters, found=false;
    for (var q=0;q<w.length;q++) if (w[q]===c.id){ found=true; break; }
    if (!found) w.push(c.id);
  }
  // per-node: validate holder, grant, mark waiters
  for (var nkey in touched){
    var N=nodes[nkey], nidx=+nkey;
    // validate current holder
    var H=N.holder>=0?TR.cars[N.holder]:null;
    var hOK=H&&(H.state==='drive'||H.state==='resuming')&&H.jxNode===nidx;
    if (hOK){
      var hdx=H.x-N.x, hdz=H.z-N.z, hd=Math.hypot(hdx,hdz);
      N.holdT+=dt;
      if (hd<JX_STOP) N.entered=true;
      // release: cleared the box, timed out, or left the protocol
      if ((N.entered&&hd>JX_CLEAR)||N.holdT>JX_HOLD_TIMEOUT||!hOK){
        N.holder=-1; N.holdT=0; N.entered=false;
        N.holderRoad=-1; N.holderDir=0; H.jxNode=-1;
      }
    } else if (N.holder>=0){
      N.holder=-1; N.holdT=0; N.entered=false;
      N.holderRoad=-1; N.holderDir=0;
    }
    // prune waiters that are no longer candidates
    var w2=[];
    for (var q2=0;q2<N.waiters.length;q2++){
      var wc=TR.cars[N.waiters[q2]];
      if (wc&&wc.jxNode===nidx&&(wc.state==='drive'||wc.state==='resuming'))
        w2.push(N.waiters[q2]);
    }
    N.waiters=w2;
    // grant to top-priority candidate when free
    if (N.holder<0&&w2.length){
      var best=-1, bestScore=null;
      for (var q3=0;q3<w2.length;q3++){
        var cc=TR.cars[w2[q3]];
        var rank=roadRank(TR.roads[cc.road].cat);
        if (clock-(cc.jxAt[nidx]||0)>JX_STARVE_S) rank+=10;  // anti-starvation
        var score=[rank, -(cc.jxAt[nidx]||0)];
        if (!bestScore||score[0]>bestScore[0]||
            (score[0]===bestScore[0]&&score[1]>bestScore[1])){
          bestScore=score; best=w2[q3];
        }
      }
      if (best>=0){
        N.holder=best; N.holdT=0; N.entered=false;
        var bc=TR.cars[best];
        N.holderRoad=bc.road; N.holderDir=bc.dir;
      }
    }
    // everyone waiting (not holder, not exempt follower) stops at the line
    for (var q4=0;q4<N.waiters.length;q4++){
      var vc=TR.cars[N.waiters[q4]];
      if (N.waiters[q4]===N.holder) continue;
      if (vc.road===N.holderRoad&&vc.dir===N.holderDir) continue;
      var vdx=vc.x-N.x, vdz=vc.z-N.z;
      if (Math.hypot(vdx,vdz)<JX_STOP) vc.jxWait=true;
    }
  }
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
  c.passing=false; c.passT=0;          // v1.31: cancel any pass maneuver on road change
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
  /* v1.13 (2026-10-09): FLOAT FIX — Joshua reported traffic hovering in the air.
     Road path heights (ys) can come from floating/duplicate road meshes. If the
     road height is more than 8u above terrain, the road data is suspect — snap
     the car to terrain instead. Real bridges on this map are handled by the
     road corridor system; anything above 8u without a bridge is a data error. */
  try{
    var _terr=heightAt(c.x,c.z);
    if (isFinite(_terr) && (y-_terr)>8) y=_terr;
  }catch(e){}
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
  /* v1.47 JUNCTION PROTOCOL: release any reservation held at this road end
     before hopping — a reservation never outlives its holder's pass. */
  try{ jxReleaseCar(c); }catch(e){}
  var selfEnd = c.dir>0 ? 1 : 0;
  /* v1.47: the hop target comes from the precomputed junction match table
     (grade <=3u and heading-checked at build). No match -> loop the path. */
  var hit=TR.jx ? TR.jx.endMatch[c.road+':'+selfEnd] : null;
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
    c.desired=c.targetSpeed;
    /* v1.31: an active pass maneuver owns laneTarget until it finishes —
       don't stomp it back to the lane center every frame.
       v1.32 LANE RESPECT (Joshua 2026-10-10): this snap-back IS the lane
       discipline rule — every frame, a non-passing car returns to its own
       lane center. The ONLY legal deviations are (a) a verified in-lane
       pass, (b) an assist-directed opposite-lane pass (c.assistPass, set
       solely by TrafficAssist while directing), and (c) pull-over states.
       Anything else gets pulled back here. */
    if (!c.passing) c.laneTarget=c.laneOffBase;
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
  /* v1.31 — JOSHUA'S NO-DRIVE-THROUGH-VEHICLES RULE (2026-10-10): a bus drove
     straight through his van. No vehicle may pass through another — not NPC
     cars, not buses, not the player's van. If ANY vehicle (bus, semi, school
     bus, oncoming car, the driven van) blocks our lane ahead:
       (1) when the asphalt is wide enough to slip around it, ease left and
           pass — the escape corridor is pre-checked for oncoming traffic,
           and the maneuver never leaves the road surface (no grass, ever);
       (2) otherwise STOP and WAIT for the blocker to clear. Waiting cars
           queue naturally behind each other via the spacing check above.
     TIMEOUT (Joshua: "find an alternate route"): after 30s against a blocker
     that looks parked, try the pull-over shoulder corridor once — still road
     corridor, never grass — then keep waiting. All known blockers are
     transient (dwells end, the player drives off, parked cars resume), so a
     wait always resolves. */
  c.blockedByVehicle=false;
  try{
    if (c.passing){ c.passT-=dt; if (c.passT<=0){ c.passing=false; c.laneTarget=c.laneOffBase;
      /* v1.32: a completed assist-directed pass retires the vehicle from the
         jam queue — the incident drops it on its next refresh. */
      if (c.assistPass){ c.assistPass=false; c.assistDone=true; } } }
    if (window.VehicleAvoid && (st==='drive'||st==='resuming')
        && !c.blockedByPlayer && !c.blockedByBus && !c.blockedBySchoolBus){
      var _vh=Math.sin(c.heading), _vc=Math.cos(c.heading);
      var _vAhead=VehicleAvoid.blockedAhead(c.x,c.z,_vh,_vc,c,26,1.1,false);
      if (_vAhead && c.desired>0.5){
        var _o=_vAhead.o, _oSpd=_o.speed||0;
        if (_oSpd>5 && _vAhead.dist>12){
          /* blocker is pulling away briskly — just follow at its speed */
          if (_oSpd<c.desired) c.desired=_oSpd;
          c.waitVehT=0; c.shoulderTried=false;
        } else {
          var _R=TR.roads[c.road], _halfW=_R.w/2;
          var _need=_o.halfW+1.1+0.9;      // their half-width + ours + margin
          var _passOff=c.off-_need;         // pass on the left (US convention)
          /* v1.32 LANE DISCIPLINE (Joshua 2026-10-10): the opposite (oncoming)
             lane is legal ONLY when traffic assistance is directing this
             vehicle around a jam (c.assistPass). Normal passing stays in the
             travel lanes. The corridor check below proves no oncoming traffic
             before the maneuver — no head-on collisions. Merge-back when past
             is handled by the passT timer restoring laneTarget=laneOffBase. */
          var _useOff=null, _useT=2.5;
          if (_passOff>=-( _halfW-0.6) &&
              VehicleAvoid.corridorClear(c.x,c.z,_vh,_vc,_passOff-c.off,
                                         _vAhead.dist+12,c,1.1)){
            _useOff=_passOff;               // normal left pass, in-lane
          } else if (c.assistPass && window.TrafficAssist){
            var _opp=TrafficAssist.oppositeLaneOff(c,_halfW);
            if (_opp!==null &&
                VehicleAvoid.corridorClear(c.x,c.z,_vh,_vc,_opp-c.off,
                                           _vAhead.dist+18,c,1.1)){
              _useOff=_opp; _useT=6.0;      // directed pass: longer window
            }
          }
          if (_useOff!==null){
            /* ROOM ON THE ASPHALT: ease around, merge back when past */
            c.laneTarget=_useOff; c.passing=true; c.passT=_useT;
            c.waitVehT=0; c.shoulderTried=false;
            c.desired=Math.min(c.desired,Math.max(4,c.desired*0.55)); // creep past
          } else {
            /* NO ROOM: stop and wait for the blocker to clear */
            c.desired=0; c.blockedByVehicle=true;
            c.waitVehT=(c.waitVehT||0)+dt;
            if (c.waitVehT>30 && !c.shoulderTried){
              c.shoulderTried=true;         // one attempt, then keep waiting
              var _shOff=c.off-_need;
              if (_shOff>=-c.shoulderOff &&
                  VehicleAvoid.corridorClear(c.x,c.z,_vh,_vc,_shOff-c.off,
                                             _vAhead.dist+14,c,1.1)){
                c.laneTarget=_shOff; c.passing=true; c.passT=3.2; c.waitVehT=0;
              }
            }
            /* v1.32 WAIT TIMEOUT (Joshua 2026-10-10): don't wait forever. After
               WAIT_S seconds behind a blocker, radio traffic assistance — the
               assist unit drives out, directs the queue around (opposite lane
               when clear), or tows the blocker. One request per wait. */
            if (window.TrafficAssist && c.waitVehT>TrafficAssist.WAIT_S && !c.assistReq){
              c.assistReq=true;
              TrafficAssist.request({x:c.x, z:c.z, yaw:c.heading, ref:c, kind:'traf'});
            }
          }
        }
      } else if (!_vAhead){ c.waitVehT=0; c.shoulderTried=false; c.assistReq=false; }
    } else if (c.passing && !(st==='drive'||st==='resuming')){
      c.passing=false; c.laneTarget=c.laneOffBase;   // left drive states mid-pass
    }
  }catch(e){}
  /* v1.47 JUNCTION PROTOCOL: waiting at a stop line because another
     stream holds the junction — stop, don't creep into the box. */
  if (c.jxWait) c.desired=0;
  var dv=c.desired-c.speed, mx=dv>0?ACCEL_US*dt:BRAKE_US*dt;
  c.speed+=Math.max(-mx,Math.min(mx,dv));
  if (c.speed<0) c.speed=0;
  // stuck audit (only when genuinely trying, not when yielding)
  var trying=(st==='drive'||st==='pulling'||st==='resuming')&&c.desired>1;
  if (trying&&c.speed<0.35&&!c.blockedByPlayer&&!c.blockedByBus&&!c.blockedBySchoolBus&&!c.jxWait){
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
   InstancedMesh. Slots are reassigned every 0.3s under Joshua's half-mile
   full-draw rule (see assignSlots): every car within 800u is rendered,
   cars stream in by 1000u, distant cars are pure data (positions only).
   Wheel spin is faked from distance driven
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
/* assignSlots(px,pz) — rebinds the instanced slots every 0.3s under
   Joshua's HALF-MILE FULL-DRAW RULE (2026-10-17):
     1. GUARANTEE — every car within FULL_DRAW_R (800u) of the player
        holds a slot, before any other car is considered, at every perf
        level. The pool is fleet-sized (MAX_RENDERED=108) so this can
        always be honoured; if the fleet ever outgrew the pool, the
        nearest inside cars would win.
     2. STICKINESS — a car that already holds a slot keeps it while it
        stays within STREAM_DIST (1000u): beyond-circle slot claims go to
        current holders first, so a car oscillating across the 800u line
        (790 <-> 810u) never flickers. A holder is displaced only when the
        budget is exhausted by inside-circle cars (rule 1 outranks it).
     3. BUDGET — EXPERT #42's perf cap (window.__perfTrafficCap, null at
        full quality) remains a cap on TOTAL rendered cars, but
        inside-circle cars are EXEMPT: the beyond-circle allowance is
        cap - insideCount (floored at 0), so quality scaling thins only
        the field beyond 800u, never inside it.
   Cars that lose a slot keep driving as data; emptied slots are
   zero-scaled (hidden). */
function assignSlots(px,pz){
  var fdr=fullDrawR(), fdr2=fdr*fdr;
  var inside=[], sticky=[], fresh=[], i, c, dx, dz, d2;
  for (i=0;i<TR.cars.length;i++){ c=TR.cars[i];
    dx=c.x-px; dz=c.z-pz; d2=dx*dx+dz*dz;
    if (d2<=fdr2) inside.push([d2,i]);
    else if (d2<STREAM_DIST2){
      if (c.slot>=0) sticky.push([d2,i]); else fresh.push([d2,i]);
    }
  }
  var byDist=function(a,b){return a[0]-b[0];};
  inside.sort(byDist); sticky.sort(byDist); fresh.sort(byDist);
  var _cap=(typeof window!=='undefined'&&window.__perfTrafficCap)||MAX_RENDERED;
  var outsideAllow=Math.max(0, Math.min(_cap,MAX_RENDERED)-inside.length);
  var picked=[], k;
  for (k=0;k<inside.length;k++) picked.push(inside[k][1]);
  for (k=0;k<sticky.length&&outsideAllow>0;k++){ picked.push(sticky[k][1]); outsideAllow--; }
  for (k=0;k<fresh.length&&outsideAllow>0;k++){ picked.push(fresh[k][1]); outsideAllow--; }
  var n=Math.min(picked.length,MAX_RENDERED);
  for (var s=0;s<MAX_RENDERED;s++){
    var prev=TR.slots[s];
    if (prev>=0&&TR.cars[prev]) TR.cars[prev].slot=-1;
    var ci=s<n?picked[s]:-1;
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

/* ---------------- station edits (Building Editor overrides) ----------------
   Joshua's Building Editor (1.7.2+) lets him flip a problem gas station
   to editable, drag/resize it in the editor's 3D view, and mark it
   Walkable. Those edits live in ONE file in this repo —
   editors/building-editor/station-edits.json — which the editor saves
   by the standing rule (save locally -> push -> close -> re-download
   the proof copy). The game NEVER edits that file; it only reads it.

   Format (the editor's own — see StationEdits in the editor's
   zonedata.py):
     { "version": 1, "updatedBy": "...",
       "stations": { "<stationIndex>": { "editable": true/false,
                     "walkable": true/false,
                     "dx": <units east of the real spot>,
                     "dz": <units south of the real spot>,
                     "w": <footprint width>, "d": <depth>,
                     "h": <height> } } }
   stationIndex is the station's index in REAL_FUEL_STATIONS (the
   editor's station list is built in the same order — verified against
   all 109 entries). Positions are OFFSETS from the station's real
   spot — the editor's anchor rule is realPosition + (dx, dz) — never
   absolute coordinates.

   The download starts the moment this script loads (cache-busted,
   cache:'no-store' — the same pattern map delivery and the watcher
   use), so by the time the world is built and stations place, it has
   settled. placeGasStations() waits for it; the promise ALWAYS
   resolves, so placement can never be blocked by this file.

   Failure behaviour (Joshua's failure philosophy — never silent):
   - file missing (404): nobody has published a station edit yet —
     a normal state; stations place by the standing rules, noted in
     the console log.
   - network error / bad JSON / wrong shape / timeout: stations place
     by the standing rules AND the failure is reported (console +
     Report), never swallowed. */
var STATION_EDITS_URL='https://kingmarkarnold-code.github.io/adamsville-play/editors/building-editor/station-edits.json';
var STATION_EDITS={ byIndex:{}, loaded:false, applied:0, walkable:0, error:'' };
var stationEditsReady=(function(){
  function settle(map, err){
    STATION_EDITS.byIndex=map||{};
    STATION_EDITS.loaded=!err;
    STATION_EDITS.error=err||'';
    if (err){
      try{ console.error('[STATION-EDITS] '+err); }catch(e){}
      try{ if (typeof Report!=='undefined') Report.noteError('gasStations','station-edits load failed',err); }catch(e){}
    }
    return STATION_EDITS;
  }
  if (typeof fetch!=='function')
    return Promise.resolve(settle(null,'fetch unavailable in this environment — stations placed by the standing rules'));
  var timedOut=false;
  var timeoutP=new Promise(function(res){ setTimeout(function(){ timedOut=true; res(null); },25000); });
  var fetchP=fetch(STATION_EDITS_URL+'?cb='+Date.now(), {cache:'no-store'}).then(function(r){
    if (r.status===404) return null;   // no edits published yet — a normal state, handled below
    if (!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }).then(function(doc){
    if (doc===null) return null;
    if (!doc || typeof doc!=='object' || !doc.stations || typeof doc.stations!=='object')
      throw new Error('station-edits.json has no "stations" object — the file is malformed');
    return doc.stations;
  });
  return Promise.race([fetchP, timeoutP]).then(function(map){
    if (map===null && timedOut)
      return settle(null,'download timed out after 25s — stations placed by the standing rules');
    if (map===null){
      try{ console.log('[STATION-EDITS] no station-edits.json published yet — stations placed by the standing rules'); }catch(e){}
      return settle({},'');
    }
    try{ console.log('[STATION-EDITS] loaded '+Object.keys(map).length+' station edit entr(ies) from the repo'); }catch(e){}
    return settle(map,'');
  }, function(err){
    return settle(null, String(err&&err.message||err));
  });
})();
/* stationEditFor(i) — Joshua's override for REAL_FUEL_STATIONS[i], or
   null. An entry counts ONLY when its "editable" flag is true: the
   editor keeps a station's saved values in the file when he flips it
   back to review-only (editable:false), and those kept values must
   NOT apply — review-only means the game treats it as unedited. */
function stationEditFor(i){
  var e=STATION_EDITS.byIndex[String(i)];
  return (e && e.editable===true) ? e : null;
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
/* buildGasStation(sx,sz,brand,colorHex,ov) — builds one station from the shared
   instanced parts (pad, canopy, kiosk, roof, 6 columns, 4 pump islands),
   rotated so +z local faces the nearest road. Registers 4 pump parking spots
   (on the approach side, +4.6u local z) for NPC fueling and the player's
   refuel hook, adds per-object colliders (columns, pumps, kiosk only — the
   LOT stays drivable), and pushes the business into BUSINESSES/LANDMARKS.
   ov (optional) is Joshua's Building Editor override for this station
   ({w,d,h,walkable} from station-edits.json). Without ov the station is
   the standard 48x38x8.5 cluster, built exactly as it always was. With
   ov the whole cluster scales PROPORTIONALLY from the standard size —
   the same rule the editor's 3D view uses (its station_parts) — so the
   station Joshua sized in the editor is the station that stands here.
   WALKABLE (ov.walkable): the station registers NO colliders at all —
   the player can walk through the whole cluster (under the canopy,
   through the kiosk and pumps). Stations have no interior geometry in
   this game, so non-solid IS the enterable treatment for a station;
   the lot was already drivable either way. */
function buildGasStation(sx,sz,brand,colorHex,ov){
  var S=gasShared(); gasInstancing();
  if (S.n>=GAS_MAX) return null;
  var GW=(ov&&+ov.w)||48, GD=(ov&&+ov.d)||38, GH=(ov&&+ov.h)||8.5;
  var fsx=GW/48, fsz=GD/38, fsy=GH/8.5;      // proportional scale factors (all 1 without ov)
  var walkable=!!(ov&&ov.walkable);
  var _sv=new THREE.Vector3(fsx,fsy,fsz);    // per-instance part scale
  var gy=heightAt(sx,sz);
  var a=gasFaceAngle(sx,sz);
  var ca=Math.cos(a), sa=Math.sin(a);
  function L2W(lx,lz){ return {x:sx+(lx*fsx)*ca+(lz*fsz)*sa, z:sz-(lx*fsx)*sa+(lz*fsz)*ca}; }
  var idx=S.n++;
  _e.set(0,a,0); _q.setFromEuler(_e);
  function setIM(im,i,lx,ly,lz){
    _v.set(sx+(lx*fsx)*ca+(lz*fsz)*sa, gy+ly*fsy, sz-(lx*fsx)*sa+(lz*fsz)*ca);
    _m.compose(_v,_q,_sv); im.setMatrixAt(i,_m);
  }
  setIM(S.padIM,idx, 0,0.15,0);
  // canopy gets per-instance brand color
  _v.set(sx,gy+7.2*fsy,sz); _m.compose(_v,_q,_sv);
  S.canopyIM.setMatrixAt(idx,_m);
  try{ S.canopyIM.setColorAt(idx,_c.setHex(colorHex)); }catch(e){}
  setIM(S.kioskIM,idx, 18,1.95,-14);
  setIM(S.roofIM,idx, 18,3.95,-14);
  // 6 canopy columns (colliders skipped entirely when walkable)
  var ci=idx*6, cn=0;
  [[-15,-9],[0,-9],[15,-9],[-15,9],[0,9],[15,9]].forEach(function(p){
    setIM(S.colIM,ci+cn,p[0],3.6,p[1]);
    var w=L2W(p[0],p[1]);
    if (!walkable){ try{ addBldgCollider(w.x,w.z,Math.sqrt(Math.pow(0.45*fsx,2)+Math.pow(0.45*fsz,2)),undefined,{hw:0.45*fsx,hd:0.45*fsz,yaw:a}); }catch(e){} }  // 2026-10-18: the column's real 0.9x0.9 footprint (was circle r=0.9)
    cn++;
  });
  // 4 pump islands + pump spots (parking positions on approach side)
  var pi=idx*4, pumpSpots=[];
  [-15.75,-5.25,5.25,15.75].forEach(function(px){
    setIM(S.pumpIM,pi,px,1.05,0);
    var w=L2W(px,0);
    if (!walkable){ try{ addBldgCollider(w.x,w.z,Math.sqrt(Math.pow(0.7*fsx,2)+Math.pow(0.45*fsz,2)),undefined,{hw:0.7*fsx,hd:0.45*fsz,yaw:a}); }catch(e){} }  // 2026-10-18: the pump's real 1.4x0.9 footprint (was circle r=1.4)
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
  if (!walkable){
    var kw=L2W(18,-14);
    try{ addBldgCollider(kw.x,kw.z,Math.sqrt(Math.pow(4.5*fsx,2)+Math.pow(3.5*fsz,2)),undefined,{hw:4.5*fsx,hd:3.5*fsz,yaw:a}); }catch(e){}  // 2026-10-18: the kiosk's real 9x7 footprint (was circle r=6 -- 2.5u past its short-side walls)
  }
  try{ LANDMARKS.push({x:sx,z:sz,name:brand}); }catch(e){}
  var biz={x:sx,z:sz,y:gy,w:GW,d:GD,h:GH,type:'gas',name:brand,
           pumpSpots:pumpSpots,faceAngle:a};
  if (ov){ biz.edited=true; biz.walkable=walkable; }
  try{ BUSINESSES.push(biz); }catch(e){}
  TR.gas.push(biz);
  return biz;
}
/* placeGasStations() — the gate: station placement runs once Joshua's
   station-edits download has settled (see the loader above). The edits
   promise ALWAYS resolves — edits loaded, no file yet, or a logged
   failure all lead here — so stations can never be blocked by it, and
   every other part of traffic init proceeds without waiting. */
function placeGasStations(){
  stationEditsReady.then(function(){
    try{ placeGasStationsNow(); }
    catch(e){ try{ Report.noteError('gasStations','placement failed',String(e&&e.message||e)); }catch(x){} }
  });
}
/* placeGasStationsNow() — places all stations: prefers REAL_FUEL_STATIONS
   (real OSM coordinates converted with xz()) placed via placeStruct so they
   never collide with buildings/roads; falls back to procedural arterial
   placement if the data file is missing (should never happen — it's
   bundled). Then adds Joshua's hand-verified ground-truth station
   (Fairburn Rd north of MLK, west side). Reports placed/skipped counts.
   Joshua's station edits (station-edits.json) layer ON TOP of the
   standing rules: an edited station places at HIS position and size —
   the skip rule is not consulted for it, because his edit IS the
   ruling. Stations with no edit take the standing path, untouched. */
function placeGasStationsNow(){
  var list=(typeof REAL_FUEL_STATIONS!=='undefined'&&REAL_FUEL_STATIONS.length)
    ? REAL_FUEL_STATIONS : null;
  var made=0, skipped=0;
  if (list){
    // REAL stations at verified OSM positions
    for (var i=0;i<list.length&&made<GAS_MAX;i++){
      var s=list[i], p=xz(s.lat,s.lon);
      var edit=stationEditFor(i);
      if (edit){
        // Joshua's override: his position (real spot + his dx/dz
        // offset), his size, his walkable flag — placed unconditionally.
        var ebrand=uniqueGasName(GAS_BRANDS[made%GAS_BRANDS.length]);
        var eb=buildGasStation(p.x+(+edit.dx||0), p.z+(+edit.dz||0), ebrand,
          GAS_CANOPY[made%GAS_CANOPY.length],
          { w:+edit.w||48, d:+edit.d||38, h:+edit.h||8.5, walkable:!!edit.walkable });
        if (eb){ eb.stationIndex=i; made++; STATION_EDITS.applied++;
                 if (eb.walkable) STATION_EDITS.walkable++; }
        else skipped++;
        continue;
      }
      var spot=null;
      try{ spot=placeStruct(p.x,p.z,26,4,'gasStation-real'+i); }catch(e){}
      if (!spot){ skipped++; continue; }
      var brand=uniqueGasName(GAS_BRANDS[made%GAS_BRANDS.length]);
      var ub=buildGasStation(spot.x,spot.z,brand,GAS_CANOPY[made%GAS_CANOPY.length]);
      if (ub){ ub.stationIndex=i; made++; }
      else skipped++;
    }
  } else {
    // fallback: procedural (should never happen — data file is bundled)
    var arts=TR.roads.filter(function(R){return R.cat==='minor_artery'||R.cat==='major_artery'||R.cat==='arterial';});  /* v2.1 */
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
    stationEdits:{loaded:STATION_EDITS.loaded, applied:STATION_EDITS.applied,
      walkable:STATION_EDITS.walkable, error:STATION_EDITS.error||undefined},
    note:'real OSM positions; drivable lots; per-object colliders; Building Editor station edits applied on top'}); }catch(e){}
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
    try{ jxTick(dt); }catch(e){}   // v1.47: intersection reservation protocol
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
/* ============================================================================
   CROSS-ZONE TRAFFIC (2026-10-25 — Joshua's rule: "when it comes to anybody
   but the player, the zone borders do not apply").
   ----------------------------------------------------------------------------
   Traffic's junction graph is built from the LOADED zone's roadDrawData
   only, so a street that continues across a zone seam simply ended at the
   border: cars hit a dead end and looped at an invisible fence, even
   though the road carries on. The zone unlock wall never applied to them
   (zoneunlock.js gates the player only) — the border they felt was the
   missing data on the other side.

   Fix, following the GPS system's proven pattern (gps_system.js v1.65):
   a few seconds after boot, fetch each NEIGHBOURING zone's roads.json
   (local map store first via MapDelivery, else a cache-busted fetch),
   append its roads to TR.roads — APPEND-ONLY, so every existing road
   keeps its index and every car's current road reference stays valid —
   then rebuild the junction graph once over the combined set. The graph
   builder's own endpoint/crossing rules stitch the two halves of a
   seam-crossing street together, so cars now drive across zone borders
   onto the continuing road and back, locked zone or not. Spawning is
   unchanged (cars still spawn in the loaded zone only — that is
   placement, not a border rule), and if a fetch fails (offline,
   file://) the game keeps exactly the behaviour it had before.
   ============================================================================ */
var TR_ZONE_RECTS={
  adamsville:{xMin:-832.1294014084006, xMax:8377.129401408598,  zMin:-4248.536971831284, zMax:8266.53697183079},
  mableton:{xMin:-7480.585387323972,   xMax:-832.1294014084006, zMin:-4248.536971831284, zMax:8266.53697183079},
  downtown:{xMin:8377.129401408598,    xMax:16314.485035211088, zMin:-4248.536971831284, zMax:2555.720070422735},
  eastatlanta:{xMin:8377.129401408598, xMax:16314.485035211088, zMin:2555.720070422735,  zMax:8266.53697183079},
  unioncity:{xMin:-7480.585387323972,  xMax:-832.1294014084006, zMin:8266.53697183079,   zMax:30877.519366197153},
  southfulton:{xMin:-832.1294014084006,xMax:8377.129401408598,  zMin:8266.53697183079,   zMax:30877.519366197153},
  riverdale:{xMin:8377.129401408598,   xMax:16314.485035211088, zMin:8266.53697183079,   zMax:30877.519366197153}
};
/* trafficNeighborZones(zid) — zones sharing a tile EDGE with zid (the
   same edge-share test gps_system.js uses; corner touches don't count). */
function trafficNeighborZones(zid){
  var r=TR_ZONE_RECTS[zid]; if (!r) return [];
  var out=[];
  for (var k in TR_ZONE_RECTS){
    if (k===zid) continue;
    var o=TR_ZONE_RECTS[k];
    var shareV=(Math.abs(o.xMax-r.xMin)<1 || Math.abs(o.xMin-r.xMax)<1) &&
               Math.min(o.zMax, r.zMax)>Math.max(o.zMin, r.zMin);
    var shareH=(Math.abs(o.zMax-r.zMin)<1 || Math.abs(o.zMin-r.zMax)<1) &&
               Math.min(o.xMax, r.xMax)>Math.max(o.xMin, r.xMin);
    if (shareV || shareH) out.push(k);
  }
  return out;
}
/* trafficFetchZoneRoads(zid) — the zone's roads.json as text: local map
   store first (MapDelivery.serveText), else a cache-busted fetch.
   Mirrors gps_system.js's fetchZoneRoadsText. */
function trafficFetchZoneRoads(zid){
  var path='zones/'+zid+'/roads.json';
  function network(){
    var v='';
    try{ v=window.__MAPVER||''; }catch(e){}
    var url=path+(v?('?v='+encodeURIComponent(v)):'');
    return fetch(url, {cache:'no-store'}).then(function(r){
      if (!r || !r.ok) throw new Error(path+' — HTTP '+(r&&r.status));
      return r.text();
    });
  }
  try{
    if (typeof MapDelivery!=='undefined' && MapDelivery.serveText){
      return MapDelivery.serveText(path).then(function(t){
        return (t!==null && t!==undefined)? t : network();
      }, function(){ return network(); });
    }
  }catch(e){}
  return network();
}
/* trafficFlattenZoneRoads(data) — a zone roads.json ({class: [records]})
   in the roadDrawData record shape buildRoadIndex consumes. Same
   flattening gps_system.js uses, widths included. */
function trafficFlattenZoneRoads(data){
  var out=[];
  var W={interstate:34, highway:22, major_artery:20, minor_artery:18.4, local:7.2};
  try{ if (typeof ROAD_WIDTHS!=='undefined' && ROAD_WIDTHS) W=ROAD_WIDTHS; }catch(e){}
  for (var k in data){
    var arr=data[k]; if (!arr) continue;
    for (var i=0;i<arr.length;i++){
      var r=arr[i]; if (!r) continue;
      out.push({pts:r.pts, ys:r.ys, name:r.name, cat:k, w:W[k]||10});
    }
  }
  return out;
}
var _trafficXZoneStarted=false;
function extendTrafficAcrossZones(){
  if (_trafficXZoneStarted) return; _trafficXZoneStarted=true;
  if (!TR || !TR.roads || !TR.jx) return;
  var zid='adamsville';
  try{ if (typeof ZONELOADER!=='undefined' && ZONELOADER.currentZone) zid=ZONELOADER.currentZone; }catch(e){}
  var nbs=trafficNeighborZones(zid);
  if (!nbs.length) return;
  var added=0, doneZones=[];
  // Fetch neighbours one at a time, then rebuild the graph ONCE.
  var chain=Promise.resolve();
  nbs.forEach(function(nz){
    chain=chain.then(function(){
      return trafficFetchZoneRoads(nz).then(function(text){
        var data=null;
        try{ data=JSON.parse(text); }catch(e){}
        if (!data) return;
        var entries=buildRoadIndex(trafficFlattenZoneRoads(data));
        if (entries.length){
          // APPEND-ONLY: existing indices (and every car's current
          // road reference) stay exactly as they were.
          TR.roads=TR.roads.concat(entries);
          added+=entries.length; doneZones.push(nz);
        }
      }, function(){ /* this zone's fetch failed — traffic keeps
                        today's behaviour on that border */ });
    });
  });
  chain.then(function(){
    if (!added) return;
    try{
      // One rebuild over the combined set: the builder's own endpoint
      // and crossing rules stitch seam-crossing streets together.
      TR.jx=buildJunctionGraph(TR.roads); TR.jxClock=0;
      if (window.Report && Report.setSys){
        var _jx={nodes:TR.jx.nodes.length, endJx:TR.jx.nEndJx,
                 crossings:TR.jx.nCross, buildMs:TR.jx.buildMs};
        Report.setSys('traffic',{status:'ok', version:'1.9',
          cars:TR.cars.length, rendered:TR.rendered||0,
          gasStations:TR.gas.length, stuckSpots:TR.stuckSpots,
          roads:TR.roads.length, junctions:_jx,
          note:'cross-zone graph live: +'+added+' roads from '+
               doneZones.join(', ')+' — traffic crosses zone borders '+
               'freely (player-only walls unchanged)'});
      }
    }catch(e){}
  });
}

/* initTraffic() — builds the road index, junction graph, render pool, and
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
  /* v1.47 JUNCTION GRAPH: true junction nodes (grade+heading-checked
     endpoint matches + mid-segment crossings) with the intersection
     reservation protocol. */
  TR.jx=buildJunctionGraph(TR.roads); TR.jxClock=0;
  buildRenderPool();
  /* v1.61 FIX (2026-10-12 Joshua: no vehicles near Dollar Mill):
     Was R.cat==='highway' only — but I-20 and other interstates are categorized
     as 'interstate', so ZERO highway cars spawned on them. Now includes both. */
  var hw=TR.roads.filter(function(R){return R.cat==='highway'||R.cat==='interstate';});
  var ar=TR.roads.filter(function(R){return R.cat==='minor_artery'||R.cat==='major_artery'||R.cat==='arterial';});  /* v2.1 */
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
    /* v1.51 TICK REGISTRY (expert report #14, James Park, Joshua approved):
       was an animate() monkey-patch — now registers on the central Sim tick
       registry. Same once-per-frame timing, deterministic priority order. */
    if(window.Sim && typeof Sim.onTick==='function' && !window.__trafTickReg){
      window.__trafTickReg=true;
      /* v1.22 LAUNCHER (Joshua 2026-10-10): skip when traffic disabled in launch options. */
      Sim.onTick('render', 10, function(dt){ if(!window.__launchOpts || window.__launchOpts.traffic!==false) updateTraffic(); });
    }
  }catch(e){}
  /* v1.63 CRASH LOG (Joshua 2026-10-17): a clean init that spawned ZERO
     cars is a named critical, not a quiet empty world. */
  try{
    if (window.SA_CRASH && TR.cars.length===0)
      SA_CRASH('critical',{code:'traffic-none-spawned',
        message:'traffic initialised but spawned 0 cars (roads indexed: '+TR.roads.length+')',
        where:'traffic_system.js initTraffic()'});
  }catch(e){}
  try{
    var _jx=TR.jx?{nodes:TR.jx.nodes.length,endJx:TR.jx.nEndJx,
      crossings:TR.jx.nCross,buildMs:TR.jx.buildMs}:null;
    Report.setSys('traffic',{status:'ok',version:'1.9',
      cars:TR.cars.length, rendered:0, gasStations:TR.gas.length,
      stuckSpots:TR.stuckSpots,
      roads:TR.roads.length, junctions:_jx,
      note:'highway+arterial traffic; junction protocol v1.47; stuck-spot road audit live'});
  }catch(e){}
  window.TRAFFIC=TR;   // expose only after a clean init
  /* CROSS-ZONE TRAFFIC (2026-10-25): once boot settles, pull the
     neighbouring zones' roads into the graph so traffic crosses zone
     borders onto the continuing streets (see extendTrafficAcrossZones
     above). Fully guarded — any failure leaves traffic exactly as it
     was with the loaded zone alone. */
  setTimeout(function(){ try{ extendTrafficAcrossZones(); }catch(e){} }, 3000);
}

/* Boot: wait until the main script has built the world (roadDrawData,
   scene, player, animate all exist), then init exactly once. Works whether
   this file is included before or after the main game script. */
var bootTries=0;
var bootTimer=setInterval(function(){

  /* v1.34 LAUNCHER SKIP (Joshua 2026-10-11): player unchecked this system
     in launch options — do not initialize at all. The deferred loader
     normally skips the script entirely; this is the backstop. */
  if (window.__launchOpts && window.__launchOpts.traffic===false){ try{clearInterval(bootTimer);}catch(e){} return; }
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
      /* v1.63 CRASH LOG: same failure, second record — the one growing
         markdown log (the Report panel entry above stays for in-game QA). */
      try{ if(window.SA_CRASH) SA_CRASH('error',{code:'traffic-init-failed',
        errorName:(e&&e.name)||'Error', message:String(e&&e.message||e),
        where:'traffic_system.js initTraffic()'}); }catch(y){}
    }
    clearInterval(bootTimer);
  } else if (bootTries>240){   // 120s — give up, never break the game (2026-10-18 SWITCH AUDIT: window harmonized to the crew standard; at 60s, slow device loads timed traffic out while the 120s crews survived)
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('traffic','boot-timeout','deps never ready'); }catch(e){}
    /* v1.63 CRASH LOG: this path used to "give up quietly" — silent
       continuation is banned; the timeout is on the record. */
    try{ if(window.SA_CRASH) SA_CRASH('error',{code:'traffic-boot-timeout',
      message:'traffic dependencies never became ready within 120s; traffic did not start',
      where:'traffic_system.js boot poll'}); }catch(x){}
  }
},500);

})();
