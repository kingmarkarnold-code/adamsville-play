/* ============================================================================
   FILE: surveyfleet_system.js — "Surviving Adamsville" AUTONOMOUS ROAD SURVEY FLEET
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-09): 5 self-driving survey cars. Their job:
     1. Drive ALL roads in the city systematically.
     2. Report any issues they encounter.
     3. Document every road traveled — explored (green) vs unexplored (red).
     4. Report to the road crew.

   THE TABLET: the road crew gets a tablet (HUD panel 🗺️) showing explored
   (green) vs unexplored (red) roads. Unexplored segments are automatically
   dispatched to the survey cars, which navigate the road network to them
   and survey them.

   RED-FLAG PROTOCOL (Joshua's directive): if a vehicle is detected DRIVING
   THROUGH a road (ghosting/clipping through geometry — below the road
   surface, not on it), a RED FLAG triggers:
     1. POLICE UNITS dispatched FIRST — secure the area, prevent collisions,
        set up a roadblock.
     2. ROAD CREW dispatched second — assess the road.
     3. CHAIN OF REPORTING (one consolidated unit):
          Road Crew → Dispatch → Development Team → Terrain Team → Mesh Team
     4. The consolidated team works the DIAGNOSTIC CHECKLIST:
          - Is the terrain at the right height?
          - Is the road at the right height?
          - Do they have the proper meshes?
          - Do the meshes line up?
          - Is the road missing a piece?
          - Is the road invisible?

   VETERAN WORKFLOW (Joshua's standing rule): crews assess the problem,
   write the report, send it back to dispatch, set up cones, fix the
   problem, and the fix AUTO-SAVES so the problem does not recur.

   v1.18 WAIT-FOR-FIX (Joshua's directive 2026-10-09): a survey car that gets
   stuck follows the SAME protocol as every other vehicle — it does NOT push
   through and does NOT drive off to its next assignment. notDrivable()
   parks the car on the road shoulder via StuckDiag.waitForFix() (right
   shoulder, 8u offset; collider moved with the mesh), sets waitingForFix,
   and registers the car on the spot so StuckDiag.markFixed() releases it.
   updateSurveyFleet() skips ALL movement for waiting cars and runs
   StuckDiag.waitTick() each frame (periodic data re-check auto-releases).
   On release, resumeAfterFix() clears the segment's 'nd' flag and retargets
   the car so it re-surveys the just-fixed segment. INFRACREW.reportIssue +
   RoadFix.autoTriage still file the work order (dispatch → assess → fix →
   auto-save → report); infracrew_system.js finishJob() now calls
   StuckDiag.markFixed() so waiting units are released the moment the crew
   finishes. forceResurvey() releases any parked cars cleanly. The 'nd'
   flag is cleared on release so the segment is re-surveyed; stale flags
   from a previous session are reconciled at boot (and every 5 min) against
   fixed INFRACREW issues and confirmed RoadFix entries. If StuckDiag
   is unavailable, notDrivable() degrades to the legacy report-and-retarget
   path. Ghost scan already skips survey cars (no false red flags on a
   parked car).

   KEY SYSTEMS:
     - 5 survey cars (white "ROAD SURVEY" livery, roof lidar mast, amber
       beacons) driving the real road network via endpoint-connection hops
       (same corridor-following convention as the road-crew patrols).
     - Exploration bitmask persisted in localStorage ('sa_surveyfleet_v1'):
       one bit per roadDrawData segment. A segment is EXPLORRED when a
       survey car has traversed ≥70% of its points. Survives sessions;
       re-surveys automatically if the map version changes.
     - Navigation: per-segment endpoint adjacency + BFS pathfinding over
       the road graph (capped iterations, honest fallback logged if no
       path). Cars never teleport.
     - Red-flag ghost scan: every 3s, up to 25 vehicles from the live fleets
       (traffic cars, parked cars, MARTA buses, semis) are checked against
       the road surface they are most likely on — a vehicle well BELOW its
       road surface is ghosting through geometry. Survey cars also flag
       NaN mesh data, buried roads, and floating roads as they traverse.
     - Red-flag response: police cars with roadblock (flashing light bars),
       road-crew dispatch via the existing repair pipeline, and a written
       case file with the 6-question diagnostic checklist and the 5-tier
       reporting chain — all timestamped and persisted.
     - Tablet UI: progress bar, explored/unexplored counts, per-car status,
       open red-flag cases with checklist + chain status.

   STANDALONE MODULE. Include AFTER the main game script — one <script> tag:

       <script src="surveyfleet_system.js"></script>

   Simple sim logic (Joshua's rule). Fully guarded: if any dependency is
   missing the module stays off and the game is unaffected.
   ============================================================================ */
(function(){
'use strict';
/* Single-instance guard — never double-boot if the script tag loads twice. */
if (window.__surveyfleetV1) return;
window.__surveyfleetV1 = true;

/* ---------------- config ---------------- */
var LS_KEY      = 'sa_surveyfleet_v1';  // localStorage persistence key
var N_CARS      = 5;        // Joshua's directive: five self-driving cars
var CAR_SPEED   = 15;       // survey cruise speed (u/s)
var COVER_FRAC  = 0.70;     // fraction of segment points = explored
var SAVE_EVERY  = 20;       // seconds between periodic persistence writes
var GHOST_T     = 3;        // seconds between ghost scans
var GHOST_N     = 25;       // vehicles checked per ghost scan
var GHOST_DROP  = 5;        // u below road surface = ghosting (red flag)
var GHOST_TER   = 3;        // u below terrain = ghosting (red flag)
var BURY_T      = 4;        // u of road below terrain = buried (red flag)
var FLOAT_T     = 15;       // u of road above terrain = floating (verify)
var STUCK_S     = 20;       // seconds of no progress = not-drivable
var POLICE_HOLD = 120;      // seconds police hold a red-flag scene
var SNAP_R      = 30;       // endpoint connection snap radius (u)
var BFS_CAP     = 3000;     // max BFS iterations for navigation
var CLAIM_R     = 40;       // dedupe radius for red-flag cases (u)

/* ---------------- runtime state ---------------- */
var SF={cars:[], explored:[], segCount:0, mapSig:'', flags:{}, cases:[],
        log:[], ready:false, time:0, tick:0, uiBuilt:false, panelOpen:false,
        ptGrid:null, epGrid:null, adj:null, dirty:false, lastSave:0,
        ghostAcc:0, seq:1, police:[]};

/* ---------------- small helpers (module-local, guarded) ---------------- */
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function dist2(ax,az,bx,bz){ var dx=ax-bx,dz=az-bz; return dx*dx+dz*dz; }
function groundY(x,z){ try{ var y=heightAt(x,z); return isFinite(y)?y:0; }catch(e){ return 0; } }
function toast(msg,ms){ try{ if(typeof showToast==='function') showToast(msg,ms||3000); }catch(e){} }
function nowT(){ var d=new Date(); function p(n){return (n<10?'0':'')+n;} return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
function dlog(msg){
  SF.log.push({t:nowT(), msg:msg});
  if (SF.log.length>250) SF.log.splice(0, SF.log.length-250);
  try{ refreshPanel(); }catch(e){}
}
/* roadY — interpolated road-surface Y from a segment's ys array at point
   index fi (float). Falls back to terrain when ys is missing. */
function segYAt(ri, fi){
  try{
    var seg=roadDrawData[ri]; if(!seg) return 0;
    var ys=seg.ys, n=seg.pts.length;
    if (!ys || !ys.length) return groundY(seg.pts[clamp(Math.round(fi),0,n-1)][0],
                                          seg.pts[clamp(Math.round(fi),0,n-1)][1]);
    var i0=clamp(Math.floor(fi),0,n-2), t=clamp(fi-i0,0,1);
    var a=ys[i0], b=ys[Math.min(i0+1,ys.length-1)];
    if (!isFinite(a)||!isFinite(b)) return NaN;
    return a+(b-a)*t;
  }catch(e){ return 0; }
}

/* ---------------- persistence ---------------- */
/* Explored bitmask: one entry per roadDrawData segment, 1 = explored.
   mapSig = segCount + sample hash — if the map data changed (new version),
   the bitmask no longer lines up, so we re-survey from scratch (honest). */
function mapSignature(){
  try{
    var n=roadDrawData.length, sig=n+':';
    for (var k=0;k<5;k++){
      var r=roadDrawData[Math.floor(n*(k+0.5)/5)];
      sig+=(r&&r.pts?r.pts.length:0)+','+((r&&r.name)||'').length+';';
    }
    return sig;
  }catch(e){ return '0'; }
}
function saveLS(force){
  if (!SF.dirty && !force) return;
  if (!force && (SF.time-SF.lastSave)<SAVE_EVERY) return;
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({
      ver:1, mapSig:SF.mapSig, explored:SF.explored, flags:SF.flags,
      cases:SF.cases.slice(-40), log:SF.log.slice(-80), seq:SF.seq
    }));
    SF.dirty=false; SF.lastSave=SF.time;
  }catch(e){}
}
function loadLS(){
  try{
    var raw=localStorage.getItem(LS_KEY); if(!raw) return;
    var o=JSON.parse(raw); if(!o) return;
    if (o.mapSig && o.mapSig===SF.mapSig && o.explored && o.explored.length===SF.segCount){
      SF.explored=o.explored;
    }
    if (o.flags) SF.flags=o.flags;
    if (o.cases) SF.cases=o.cases;
    if (o.log) SF.log=o.log;
    if (o.seq) SF.seq=o.seq;
  }catch(e){}
}
function markDirty(){ SF.dirty=true; }

/* ---------------- road network index ----------------
   Built once at boot from roadDrawData (stable within a session):
   - ptGrid: coarse point grid (cell 120u) → segment indices, for
     nearest-segment lookups.
   - epGrid: endpoint grid (cell 60u) → {ri, end, x, z}, for connections.
   - adj: "ri:end" → {ri, end} of the nearest DIFFERENT segment endpoint
     within SNAP_R. The road graph the cars navigate. */
var PT_CELL=120, EP_CELL=60;
function buildNetwork(){
  var n=SF.segCount;
  var ptGrid={}, epGrid={};
  try{
    for (var ri=0; ri<n; ri++){
      var r=roadDrawData[ri];
      if (!r||!r.pts||r.pts.length<2) continue;
      /* point grid: index every 3rd point (coarse but fast) */
      for (var j=0;j<r.pts.length;j+=3){
        var p=r.pts[j];
        var k=Math.floor(p[0]/PT_CELL)+','+Math.floor(p[1]/PT_CELL);
        (ptGrid[k]=ptGrid[k]||[]).push(ri);
      }
      /* endpoint grid: both ends */
      for (var e=0;e<2;e++){
        var q=r.pts[e===0?0:r.pts.length-1];
        var k2=Math.floor(q[0]/EP_CELL)+','+Math.floor(q[1]/EP_CELL);
        (epGrid[k2]=epGrid[k2]||[]).push({ri:ri, end:e, x:q[0], z:q[1]});
      }
    }
    /* adjacency: nearest different-segment endpoint within SNAP_R */
    var adj={};
    for (var ri2=0; ri2<n; ri2++){
      var r2=roadDrawData[ri2];
      if (!r2||!r2.pts||r2.pts.length<2) continue;
      for (var e2=0;e2<2;e2++){
        var q2=r2.pts[e2===0?0:r2.pts.length-1];
        var gx=Math.floor(q2[0]/EP_CELL), gz=Math.floor(q2[1]/EP_CELL);
        var best=null, bd=SNAP_R*SNAP_R;
        for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
          var a=epGrid[ix+','+iz]; if(!a) continue;
          for (var i=0;i<a.length;i++){
            var c=a[i];
            if (c.ri===ri2) continue;
            var d2=dist2(c.x,c.z,q2[0],q2[1]);
            if (d2<bd){ bd=d2; best=c; }
          }
        }
        if (best) adj[ri2+':'+e2]={ri:best.ri, end:best.end};
      }
    }
    SF.ptGrid=ptGrid; SF.epGrid=epGrid; SF.adj=adj;
    dlog('Road network indexed: '+n+' segments, '+
         Object.keys(adj).length+' endpoint connections.');
  }catch(e){
    try{ if(typeof Report!=='undefined') Report.noteError('surveyfleet','network-index',String(e&&e.message||e)); }catch(x){}
  }
}
/* nearestSeg(x, z) — nearest segment by 2D distance using the point grid.
   Returns {ri, idx, dist} or null. */
function nearestSeg(x, z){
  var best=null, bd=1e18, bidx=0;
  try{
    var gx=Math.floor(x/PT_CELL), gz=Math.floor(z/PT_CELL), grid=SF.ptGrid;
    for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
      var a=grid[ix+','+iz]; if(!a) continue;
      for (var i=0;i<a.length;i++){
        var r=roadDrawData[a[i]];
        if (!r||!r.pts) continue;
        for (var j=0;j<r.pts.length;j+=2){
          var p=r.pts[j], d=dist2(x,z,p[0],p[1]);
          if (d<bd){ bd=d; best=a[i]; bidx=j; }
        }
      }
    }
  }catch(e){}
  return best===null?null:{ri:best, idx:bidx, dist:Math.sqrt(bd)};
}
/* roadSurfaceY(x, z) — the surface Y of the segment the vehicle is most
   likely ON: among segments within 60u (2D), pick the one whose surface
   is closest to the vehicle's own Y, then interpolate. Returns {y, ri}. */
function roadSurfaceY(x, z, vy){
  var best=null, bd=1e18, bri=-1;
  try{
    var gx=Math.floor(x/PT_CELL), gz=Math.floor(z/PT_CELL), grid=SF.ptGrid;
    for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
      var a=grid[ix+','+iz]; if(!a) continue;
      for (var i=0;i<a.length;i++){
        var r=roadDrawData[a[i]];
        if (!r||!r.pts) continue;
        for (var j=0;j<r.pts.length;j+=4){
          var p=r.pts[j], d2=dist2(x,z,p[0],p[1]);
          if (d2>3600) continue;
          var ry=segYAt(a[i], j);
          if (!isFinite(ry)) continue;
          var dd=Math.abs(vy-ry)+Math.sqrt(d2)*0.02;
          if (dd<bd){ bd=dd; best=ry; bri=a[i]; }
        }
      }
    }
  }catch(e){}
  return bri<0?null:{y:best, ri:bri};
}
/* bfsPath(fromRi, toRi) — shortest segment path over the endpoint graph.
   Returns [ri...] or null (capped iterations, honest null). */
function bfsPath(fromRi, toRi){
  if (fromRi===toRi) return [toRi];
  try{
    var prev={}, seen={}, q=[fromRi]; seen[fromRi]=1; var it=0;
    while (q.length && it<BFS_CAP){
      it++;
      var cur=q.shift();
      for (var e=0;e<2;e++){
        var hop=SF.adj[cur+':'+e];
        if (!hop) continue;
        var nr=hop.ri;
        if (seen[nr]) continue;
        seen[nr]=1; prev[nr]=cur;
        if (nr===toRi){
          var path=[toRi], c=toRi;
          while (c!==fromRi){ c=prev[c]; path.unshift(c); }
          return path;
        }
        q.push(nr);
      }
    }
  }catch(e){}
  return null;
}
/* segMid(ri) — midpoint of a segment (for distance estimates). */
function segMid(ri){
  try{
    var r=roadDrawData[ri]; if(!r||!r.pts||!r.pts.length) return null;
    var p=r.pts[Math.floor(r.pts.length/2)];
    return {x:p[0], z:p[1], n:r.pts.length, name:r.name||'unnamed'};
  }catch(e){ return null; }
}

/* ---------------- three.js builders ---------------- */
function makeCanvas(w,h){
  var c=document.createElement('canvas'); c.width=w; c.height=h;
  return {c:c, ctx:c.getContext('2d')};
}
function mat(color, emissive){
  return new THREE.MeshLambertMaterial({color:color, emissive:emissive||0x000000});
}
function box(w,h,d,color,emissive){
  return new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat(color,emissive));
}
/* makeSurveyCar — white survey SUV: "ROAD SURVEY" door decals, roof lidar
   mast with spinning puck, amber beacons. Faces +Z. Distinct from every
   other fleet (road crew = orange trucks, infra = white utility). */
function makeSurveyCar(){
  var g=new THREE.Group();
  var white=0xf2f3f5, dark=0x1c1e22, amber=0xffb02e, navy=0x1c2a4a;
  var body=box(2.1,0.75,4.6,white); body.position.y=0.85; g.add(body);
  var cab=box(1.9,0.85,2.3,white); cab.position.set(0,1.6,0.2); g.add(cab);
  var glass=box(1.7,0.55,2.0,0x1c2733); glass.position.set(0,1.62,0.2); g.add(glass);
  var stripe=box(2.14,0.3,4.64,navy); stripe.position.y=0.8; g.add(stripe);
  /* ROAD SURVEY door decals (both sides) */
  try{
    var k=makeCanvas(256,64), x=k.ctx;
    x.fillStyle='#1c2a4a'; x.fillRect(0,0,256,64);
    x.fillStyle='#ffb02e'; x.font='bold 34px Arial'; x.textAlign='center';
    x.fillText('ROAD SURVEY',128,44);
    var dt=new THREE.CanvasTexture(k.c);
    [-1.06,1.06].forEach(function(sx){
      var decal=new THREE.Mesh(new THREE.PlaneGeometry(1.7,0.42),
        new THREE.MeshLambertMaterial({map:dt}));
      decal.position.set(sx,1.0,0.2); decal.rotation.y=sx>0?Math.PI/2:-Math.PI/2;
      g.add(decal);
    });
  }catch(e){}
  /* roof lidar mast + spinning puck */
  var mast=box(0.14,0.7,0.14,dark); mast.position.set(0,2.35,0.2); g.add(mast);
  var puck=new THREE.Mesh(new THREE.CylinderGeometry(0.34,0.34,0.22,12),
    new THREE.MeshLambertMaterial({color:0x333a44, emissive:0x1188ff}));
  puck.position.set(0,2.78,0.2); g.add(puck);
  g.userData.lidar=puck;
  /* amber beacons front + rear */
  var b1=box(0.3,0.18,0.3,amber,0xaa6600); b1.position.set(-0.7,2.1,1.9); g.add(b1);
  var b2=box(0.3,0.18,0.3,amber,0xaa6600); b2.position.set(0.7,2.1,1.9); g.add(b2);
  g.userData.beacons=[b1,b2];
  var wg=new THREE.CylinderGeometry(0.42,0.42,0.32,10), wm=mat(0x141414);
  [[-1.0,1.5],[1.0,1.5],[-1.0,-1.5],[1.0,-1.5]].forEach(function(p){
    var w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2;
    w.position.set(p[0],0.42,p[1]); g.add(w);
  });
  return g;
}
/* makePoliceCar — dark navy interceptor, white doors, "POLICE" decals,
   red/blue light bar. Faces +Z. */
function makePoliceCar(){
  var g=new THREE.Group();
  var navy=0x14204a, white=0xf4f4f4, dark=0x141414;
  var body=box(2.1,0.75,4.6,navy); body.position.y=0.85; g.add(body);
  var cab=box(1.9,0.8,2.2,navy); cab.position.set(0,1.58,0.2); g.add(cab);
  var glass=box(1.7,0.5,1.9,0x1c2733); glass.position.set(0,1.6,0.2); g.add(glass);
  try{
    var k=makeCanvas(256,64), x=k.ctx;
    x.fillStyle='#f4f4f4'; x.fillRect(0,0,256,64);
    x.fillStyle='#14204a'; x.font='bold 36px Arial'; x.textAlign='center';
    x.fillText('POLICE',128,45);
    var dt=new THREE.CanvasTexture(k.c);
    [-1.06,1.06].forEach(function(sx){
      var decal=new THREE.Mesh(new THREE.PlaneGeometry(1.7,0.42),
        new THREE.MeshLambertMaterial({map:dt}));
      decal.position.set(sx,1.0,0.2); decal.rotation.y=sx>0?Math.PI/2:-Math.PI/2;
      g.add(decal);
    });
  }catch(e){}
  var barR=box(0.62,0.24,0.4,0xff2222,0xaa0000); barR.position.set(-0.33,2.12,0.2); g.add(barR);
  var barB=box(0.62,0.24,0.4,0x2255ff,0x0011aa); barB.position.set(0.33,2.12,0.2); g.add(barB);
  g.userData.lightR=barR; g.userData.lightB=barB;
  var wg=new THREE.CylinderGeometry(0.42,0.42,0.32,10), wm=mat(dark);
  [[-1.0,1.5],[1.0,1.5],[-1.0,-1.5],[1.0,-1.5]].forEach(function(p){
    var w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2;
    w.position.set(p[0],0.42,p[1]); g.add(w);
  });
  return g;
}
/* makeBarricade — striped sawhorse roadblock. */
function makeBarricade(){
  var g=new THREE.Group();
  try{
    var k=makeCanvas(256,64), x=k.ctx;
    for (var i=0;i<8;i++){ x.fillStyle=(i%2?'#e8641b':'#f4f4f4'); x.fillRect(i*32,0,32,64); }
    var t=new THREE.CanvasTexture(k.c);
    var board=new THREE.Mesh(new THREE.PlaneGeometry(4.4,1.0),
      new THREE.MeshLambertMaterial({map:t, side:THREE.DoubleSide}));
    board.position.y=1.15; g.add(board);
  }catch(e){}
  [-2.0,2.0].forEach(function(sx){
    var leg=box(0.18,1.7,0.9,0x555c66); leg.position.set(sx,0.85,0); g.add(leg);
  });
  return g;
}
/* makeCone — single traffic cone (for the police roadblock ring). */
function makeCone(){
  var g=new THREE.Group();
  var c=new THREE.Mesh(new THREE.ConeGeometry(0.55,1.15,8), mat(0xe8641b));
  c.position.y=0.58; g.add(c);
  var b=box(0.9,0.12,0.9,0xe8641b); b.position.y=0.06; g.add(b);
  return g;
}

/* ---------------- survey car logic ---------------- */
/* claims — segments currently assigned to a car (in-memory; prevents two
   cars surveying the same segment). */
var claims={};
/* segName(ri) — display name for a segment. */
function segName(ri){
  try{ var r=roadDrawData[ri]; return (r&&r.name)||'unnamed road'; }catch(e){ return 'unnamed road'; }
}
/* markVisited(car, ri, idx) — record a traversed point; mark the segment
   explored when coverage ≥ COVER_FRAC (or fully visited for short segs). */
function markVisited(car, ri, idx){
  var key=ri;
  var set=car.visited[key];
  if (!set){ set={}; car.visited[key]=set; }
  set[Math.round(idx)]=1;
  if (SF.explored[ri]) return;
  try{
    var n=roadDrawData[ri].pts.length, cnt=0;
    for (var k in set) cnt++;
    var need=(n<8)?n:Math.ceil(n*COVER_FRAC);
    if (cnt>=need){
      SF.explored[ri]=1;
      if (claims[ri]===car.no) delete claims[ri];
      markDirty(); saveLS(false);
      SF._exploredCount=(SF._exploredCount||0)+1;
      try{ refreshPanel(); }catch(e){}
    }
  }catch(e){}
}
/* coverage(ri) — fraction of points visited by ANY car this session (for
   the tablet's per-segment view; the bitmask is the persisted truth). */
function isExplored(ri){ return !!SF.explored[ri]; }
/* pickTarget(car) — nearest unexplored, unclaimed, drivable segment.
   Samples up to 500 candidates for speed; claims the winner. */
function pickTarget(car){
  var best=-1, bd=1e18, px=car.mesh.position.x, pz=car.mesh.position.z;
  try{
    var tries=0, n=SF.segCount, guard=0;
    var start=Math.floor(Math.random()*n);
    for (var t=0;t<500 && guard<4000;t++,guard++){
      var ri=(start+t*37)%n;  // strided sampling spreads the picks
      if (SF.explored[ri]||claims[ri]||SF.flags[ri]==='nd') continue;
      tries++;
      var m=segMid(ri); if(!m) continue;
      var d=dist2(px,pz,m.x,m.z);
      if (d<bd){ bd=d; best=ri; }
    }
  }catch(e){}
  if (best>=0){ claims[best]=car.no; }
  return best;
}
/* planPath(car, toRi) — BFS over the endpoint graph; null if disconnected. */
function planPath(car, toRi){
  try{
    var p=bfsPath(car.seg, toRi);
    if (!p || p.length<2) return p&&p.length===1?[]:null;
    return p.slice(1);  // drop current segment
  }catch(e){ return null; }
}
/* spawnSurveyCars — 5 cars spread across the map on long segments. */
function spawnSurveyCars(){
  try{
    var cands=[];
    for (var ri=0;ri<SF.segCount;ri++){
      var r=roadDrawData[ri];
      if (r&&r.pts&&r.pts.length>=2) cands.push(ri);
    }
    /* longest first — spread the fleet across substantial roads.
       Take the top 200 longest, then spread geographically among those
       (spreading across the FULL list lands cars on tiny stubs). */
    cands.sort(function(a,b){
      return roadDrawData[b].pts.length-roadDrawData[a].pts.length;
    });
    if (!cands.length) return;
    var pool=cands.slice(0, Math.min(200, cands.length));
    for (var c=0;c<N_CARS;c++){
      /* start each car on one of the longest segments (spread across the
         top of the length-sorted pool) — the most important roads first */
      var pick=pool[Math.min(c*2, pool.length-1)];
      var r2=roadDrawData[pick], mid=Math.floor(r2.pts.length/2);
      var p=r2.pts[mid];
      var mesh=makeSurveyCar();
      var y=segYAt(pick, mid); if(!isFinite(y)) y=groundY(p[0],p[1]);
      mesh.position.set(p[0], y+0.1, p[1]);
      scene.add(mesh);
      var col=null;
      try{
        if (typeof addCollider==='function'){
          col={x:p[0], z:p[1], r:2.6, y0:-1e9, y1:1e9};
          colliders.push(col);
        }
      }catch(e){}
      var car={no:c+1, mesh:mesh, col:col, seg:pick, i:mid, dir:1,
               state:'survey', path:[], target:pick, visited:{},
               stuckT:0, lastX:p[0], lastZ:p[1], task:'surveying',
               waitSeg:-1};   // v1.18 WAIT-FOR-FIX: segment index we are parked waiting on (-1 = not waiting)
      claims[pick]=car.no;
      SF.cars.push(car);
      dlog('Survey Car '+car.no+' online — starting on '+segName(pick)+'.');
    }
  }catch(e){
    try{ if(typeof Report!=='undefined') Report.noteError('surveyfleet','spawn',String(e&&e.message||e)); }catch(x){}
  }
}
/* sfAdvance(car, dt) — move along the current polyline at road-surface
   height; hop across endpoint connections; bounce at true dead ends.
   Marks visited points. Detects NaN mesh data → red flag. */
function sfAdvance(car, dt){
  try{
    var seg=roadDrawData[car.seg];
    if (!seg||!seg.pts||seg.pts.length<2){ retarget(car,'segment data missing'); return; }
    var pts=seg.pts, n=pts.length;
    var a=pts[clamp(Math.round(car.i),0,n-1)], b=pts[clamp(Math.round(car.i)+car.dir,0,n-1)];
    var dx=b[0]-a[0], dz=b[1]-a[1], L=Math.hypot(dx,dz)||1;
    car.i+=car.dir*(CAR_SPEED*dt)/L;
    var hitEnd=false, whichEnd=0;
    if (car.i>=n-1){ car.i=n-1; hitEnd=true; whichEnd=1; }
    else if (car.i<=0){ car.i=0; hitEnd=true; whichEnd=0; }
    /* per-point: visited + NaN mesh check */
    var pi=Math.round(car.i);
    markVisited(car, car.seg, pi);
    var pp=pts[pi];
    if (!isFinite(pp[0])||!isFinite(pp[1])||!isFinite(segYAt(car.seg, car.i))){
      redFlag('mesh-nan', car.mesh.position.x, car.mesh.position.z,
              'Survey Car '+car.no, 'NaN in segment geometry/height ('+segName(car.seg)+')');
      retarget(car,'NaN mesh flagged');
      return;
    }
    if (hitEnd){
      var hop=null;
      try{ hop=SF.adj[car.seg+':'+whichEnd]||null; }catch(e){}
      if (car.path.length && hop && hop.ri===car.path[0]){
        /* planned hop onto the next path segment */
        car.path.shift();
        car.seg=hop.ri;
        car.i=(hop.end===1)?roadDrawData[hop.ri].pts.length-1:0;
        car.dir=(hop.end===1)?-1:1;
        car.state='travel';
        car.task='en route';
      } else if (hop){
        /* opportunistic hop — keeps the car on the network, exploring */
        car.seg=hop.ri;
        car.i=(hop.end===1)?roadDrawData[hop.ri].pts.length-1:0;
        car.dir=(hop.end===1)?-1:1;
      } else {
        car.dir=(whichEnd===1)?-1:1;  // dead end — bounce
      }
      if (car.target>=0 && car.seg===car.target){
        car.state='survey'; car.task='surveying '+segName(car.target);
      }
      if (car.target>=0 && SF.explored[car.target] && claims[car.target]===car.no){
        delete claims[car.target];
        assignNext(car);
      }
    }
    /* position the car ON the road surface (bridges included) */
    var cp=pts[clamp(Math.round(car.i),0,n-1)];
    var ry=segYAt(car.seg, car.i);
    if (!isFinite(ry)) ry=groundY(cp[0],cp[1]);
    car.mesh.position.set(cp[0], ry+0.12, cp[1]);
    var hd=Math.atan2(dx*car.dir, dz*car.dir);
    car.mesh.rotation.y=hd;
    if (car.col){ car.col.x=cp[0]; car.col.z=cp[1]; }
    /* beacons + lidar animation */
    var tk=SF.tick;
    car.mesh.userData.beacons.forEach(function(bm,k){
      bm.visible=(tk%16<8);
    });
    if (car.mesh.userData.lidar) car.mesh.userData.lidar.rotation.y+=dt*6;
    /* stuck check — no progress while surveying = not drivable */
    var moved=Math.hypot(cp[0]-car.lastX, cp[1]-car.lastZ);
    if (moved<0.4 && car.state==='survey'){
      car.stuckT+=dt;
      if (car.stuckT>STUCK_S){
        notDrivable(car, car.seg);
        car.stuckT=0;
      }
    } else { car.stuckT=0; car.lastX=cp[0]; car.lastZ=cp[1]; }
  }catch(e){}
}
/* retarget(car, why) — drop current assignment, pick a fresh target. */
function retarget(car, why){
  try{
    if (car.target>=0 && claims[car.target]===car.no) delete claims[car.target];
    car.target=-1; car.path=[]; car.state='travel'; car.task='re-routing ('+why+')';
    assignNext(car);
  }catch(e){}
}
/* assignNext(car) — claim the nearest unexplored segment and plan a path. */
function assignNext(car){
  try{
    var t=pickTarget(car);
    if (t<0){
      car.task='standby — map fully surveyed';
      car.state='idle';
      dlog('Survey Car '+car.no+': no unexplored segments left — standing by.');
      return;
    }
    car.target=t;
    var path=planPath(car, t);
    if (path===null){
      dlog('Survey Car '+car.no+': no road path to '+segName(t)+' — flagged for review.');
      SF.flags[t]='nopath';
      if (claims[t]===car.no) delete claims[t];
      markDirty();
      assignNext(car); return;
    }
    car.path=path||[];
    car.state=car.path.length?'travel':'survey';
    car.task=(car.path.length?'en route to ':'surveying ')+segName(t);
  }catch(e){}
}
/* notDrivable(car, ri) — survey car could not traverse the segment.
   v1.18 WAIT-FOR-FIX (Joshua's directive 2026-10-09): the survey car follows
   the SAME protocol as every other vehicle — it does NOT push through and
   does NOT drive off to the next assignment. It pulls safely to the road
   shoulder via StuckDiag.waitForFix(), waits patiently while the dispatch
   team assesses/fixes the problem (INFRACREW.reportIssue + RoadFix.autoTriage
   file the work order), and resumes its route only after the fix is
   confirmed (StuckDiag.markFixed from the crew, or the waitTick auto-recheck).
   Auto-save + reporting ride on the existing crew systems. */
function notDrivable(car, ri){
  try{
    if (SF.flags[ri]==='nd') return;
    SF.flags[ri]='nd';
    markDirty(); saveLS(true);
    dlog('⚠️ Survey Car '+car.no+': '+segName(ri)+' NOT DRIVABLE — pulling over and WAITING for the fix crew (Joshua\'s rule: no pushing through).');
    toast('⚠️ Road not drivable: '+segName(ri)+' — survey car waiting for fix');
    try{
      if (window.INFRACREW) window.INFRACREW.reportIssue({
        kind:'road', x:car.mesh.position.x, z:car.mesh.position.z,
        street:segName(ri), desc:'Survey fleet: segment not drivable — crew assessment requested.'});
    }catch(e){}
    try{
      if (window.RoadFix) window.RoadFix.autoTriage(car.mesh.position.x, car.mesh.position.z, {cause:'not-drivable'});
    }catch(e){}
    /* WAIT-FOR-FIX: park on the shoulder, set waitingForFix, register with
       the spot so markFixed() releases us. StuckDiag.waitForFix reads
       unit.seg.pts — the survey car keeps seg as an INDEX, so swap in the
       real segment object for the (synchronous) call and restore after. */
    var parked=false;
    try{
      if (window.StuckDiag && typeof StuckDiag.waitForFix==='function'){
        var mx=car.mesh.position.x, mz=car.mesh.position.z;
        var savedSeg=car.seg;
        try{ car.seg=roadDrawData[car.seg]; }catch(e2){}
        parked=StuckDiag.waitForFix(mx, mz, car, 'Survey Car '+car.no,
          function(m){ dlog(m); });
        car.seg=savedSeg;
        if (parked && car.col){
          /* keep the physical collider on the parked mesh, not in the lane */
          car.col.x=car.mesh.position.x; car.col.z=car.mesh.position.z;
        }
      }
    }catch(e){ parked=false; }
    if (!parked){
      /* StuckDiag unavailable — degrade to legacy behavior: report and move on */
      dlog('Survey Car '+car.no+': wait-for-fix unavailable — falling back to re-routing.');
      retarget(car,'segment not drivable');
    } else {
      car.waitSeg=ri;   // set ONLY once we are genuinely parked and waiting
      car.task='waiting for fix — '+segName(ri);
    }
  }catch(e){}
}
/* resumeAfterFix(car) — the fix at our wait location was confirmed
   (crew markFixed or the waitTick auto-recheck). Clear the 'nd' flag so the
   segment is surveyable again, then re-enter the normal assignment loop —
   the nearest unexplored segment (usually the just-fixed one) gets picked. */
function resumeAfterFix(car){
  try{
    var ri=car.waitSeg;
    if (typeof ri==='number' && SF.flags[ri]==='nd'){
      delete SF.flags[ri];
      markDirty(); saveLS(true);
    }
    car.waitSeg=-1;
    car.stuckT=0;
    if (car.mesh){ try{ car.lastX=car.mesh.position.x; car.lastZ=car.mesh.position.z; }catch(e){} }
    dlog('✅ Survey Car '+car.no+': fix confirmed — resuming survey route.');
    toast('✅ Survey Car '+car.no+' resuming — fix confirmed');
    retarget(car,'fix confirmed');
  }catch(e){}
}
/* reconcileStaleFlags() — v1.18 WAIT-FOR-FIX. 'nd' flags persist across
   sessions, but a fix may have landed while the game was closed (the crew
   systems persist their own 'fixed' states). For each not-drivable segment,
   check the crew records: a fixed INFRACREW issue within 50u, or a
   confirmed RoadFix entry at the segment midpoint, means the road is
   repaired — clear the flag so the fleet surveys it again. Runs at boot
   and every 5 minutes of fleet time (covers crew systems that boot later). */
var lastReconcile=-1e9;
function reconcileStaleFlags(){
  try{
    var cleared=0;
    for (var ri=0; ri<SF.segCount; ri++){
      if (SF.flags[ri]!=='nd') continue;
      var m=null;
      try{ m=segMid(ri); }catch(e){}
      if (!m) continue;
      var fixed=false;
      try{
        if (window.INFRACREW && INFRACREW.issues){
          var iss=INFRACREW.issues;
          for (var k=0;k<iss.length;k++){
            var d=iss[k];
            if (d && d.state==='fixed'){
              var dx=d.x-m.x, dz=d.z-m.z;
              if (dx*dx+dz*dz<2500){ fixed=true; break; }
            }
          }
        }
      }catch(e){}
      try{
        if (!fixed && window.RoadFix && typeof RoadFix.isFixed==='function'){
          fixed=!!RoadFix.isFixed(m.x, m.z);
        }
      }catch(e){}
      if (fixed){ delete SF.flags[ri]; cleared++; }
    }
    if (cleared){ markDirty(); saveLS(true); dlog('🧹 Cleared '+cleared+' stale not-drivable flag(s) — crew fixes confirmed.'); }
    lastReconcile=SF.time;
  }catch(e){}
}

/* ---------------- red-flag detection ---------------- */
/* ghostScan — every GHOST_T seconds, sample up to GHOST_N vehicles from
   the live fleets. A vehicle is ghosting through geometry when it sits
   well BELOW the road surface it is most likely on, or below the terrain.
   Bridges are safe: the match picks the surface closest to the vehicle. */
function fleetVehicles(){
  var out=[];
  try{
    if (typeof TR!=='undefined' && TR.cars) TR.cars.forEach(function(c){ out.push({m:c.mesh||c, kind:'traffic car'}); });
    if (typeof cars!=='undefined') cars.forEach(function(c){ out.push({m:c.mesh||c, kind:'parked car'}); });
    if (typeof MB!=='undefined' && MB.buses) MB.buses.forEach(function(b){ out.push({m:b.mesh||b, kind:'MARTA bus'}); });
    if (typeof SE!=='undefined' && SE.semis) SE.semis.forEach(function(s){ out.push({m:s.mesh||s, kind:'semi'}); });
  }catch(e){}
  return out;
}
function ghostScan(){
  try{
    var vehs=fleetVehicles();
    if (!vehs.length) return;
    var checked=0;
    for (var i=0;i<vehs.length && checked<GHOST_N;i++){
      var v=vehs[Math.floor(Math.random()*vehs.length)];
      checked++;
      var m=v.m; if(!m||!m.position) continue;
      /* skip the survey cars themselves (they ride the surface by design) */
      var isSurvey=false;
      for (var c=0;c<SF.cars.length;c++){ if (SF.cars[c].mesh===m){ isSurvey=true; break; } }
      if (isSurvey) continue;
      var x=m.position.x, y=m.position.y, z=m.position.z;
      if (!isFinite(x)||!isFinite(y)||!isFinite(z)) continue;
      var surf=roadSurfaceY(x, z, y);
      var ter=groundY(x,z);
      var belowRoad=surf && isFinite(surf.y) && (y < surf.y-GHOST_DROP);
      var belowTer=(y < ter-GHOST_TER);
      if (belowRoad || belowTer){
        redFlag('ghost', x, z, v.kind,
          'vehicle '+(belowRoad?Math.round(surf.y-y)+'u below road surface':'')+
          (belowRoad&&belowTer?' + ':'')+
          (belowTer?Math.round(ter-y)+'u below terrain':''));
        return;  // one red flag per scan — the chain handles the rest
      }
    }
  }catch(e){}
}
/* surveySelfCheck — as each survey car traverses, check the road against
   the terrain: buried (road under terrain) → red flag; floating high
   above terrain → verify flag (may be a legitimate overpass). */
function surveySelfCheck(car){
  try{
    if (SF.tick%90!==car.no*7%90) return;  // stagger the checks
    var seg=roadDrawData[car.seg]; if(!seg||!seg.pts) return;
    var n=seg.pts.length, burial=0, float=0, nanY=0;
    for (var j=0;j<n;j+=Math.max(1,Math.floor(n/12))){
      var p=seg.pts[j], ry=segYAt(car.seg, j), ty=groundY(p[0],p[1]);
      if (!isFinite(ry)){ nanY++; continue; }
      if (!isFinite(ty)) continue;
      burial=Math.max(burial, ty-ry);
      float=Math.max(float, ry-ty);
    }
    var x=car.mesh.position.x, z=car.mesh.position.z;
    if (nanY>0){
      redFlag('mesh-nan', x, z, 'Survey Car '+car.no,
              nanY+' NaN height samples on '+segName(car.seg));
    } else if (burial>BURY_T){
      redFlag('buried', x, z, 'Survey Car '+car.no,
              'road surface '+Math.round(burial)+'u BELOW terrain on '+segName(car.seg));
    } else if (float>FLOAT_T){
      redFlag('floating', x, z, 'Survey Car '+car.no,
              'road surface '+Math.round(float)+'u ABOVE terrain on '+segName(car.seg)+' — verify (possible overpass)');
    }
  }catch(e){}
}
/* ---------------- diagnostic checklist ----------------
   Joshua's six questions, answered by automated inspection where possible.
   Each returns {status:'pass'|'fail'|'verify', detail}. 'verify' = needs
   human/drone eyes — the module says so honestly instead of guessing. */
function runDiagnostics(x, z){
  var d={};
  try{
    var nr=nearestSeg(x,z);
    if (!nr){ d.error='no road segment near the scene'; return d; }
    var seg=roadDrawData[nr.ri], n=seg.pts.length;
    /* Q3: proper meshes? */
    var badP=0, badY=0;
    for (var j=0;j<n;j++){
      var p=seg.pts[j];
      if (!isFinite(p[0])||!isFinite(p[1])) badP++;
      if (seg.ys && !isFinite(seg.ys[j])) badY++;
    }
    var ysOK=!!(seg.ys && seg.ys.length===n);
    d.properMeshes=(n>=2&&badP===0&&ysOK&&badY===0)
      ? {status:'pass', detail:n+' points, heights clean'}
      : {status:'fail', detail:'points='+n+' badPts='+badP+' ysOK='+ysOK+' badHeights='+badY};
    /* Q1+Q2: terrain height / road height */
    var burial=0, float=0, nanT=0, spike=0, lastT=null;
    var step=Math.max(1,Math.floor(n/12));
    for (var k=0;k<n;k+=step){
      var q=seg.pts[k], ry=segYAt(nr.ri,k), ty=groundY(q[0],q[1]);
      if (!isFinite(ty)){ nanT++; continue; }
      if (lastT!==null && Math.abs(ty-lastT)>30) spike++;
      lastT=ty;
      if (!isFinite(ry)) continue;
      burial=Math.max(burial, ty-ry); float=Math.max(float, ry-ty);
    }
    d.terrainHeight=(nanT>0||spike>0)
      ? {status:'fail', detail:'NaN samples='+nanT+' spikes='+spike}
      : {status:'pass', detail:'terrain continuous along segment'};
    d.roadHeight=(burial>BURY_T)
      ? {status:'fail', detail:'road '+Math.round(burial)+'u BELOW terrain (buried/submerged)'}
      : (float>FLOAT_T
        ? {status:'verify', detail:'road '+Math.round(float)+'u above terrain — possible overpass, visual verify'}
        : {status:'pass', detail:'road sits on terrain (max dev '+Math.round(Math.max(burial,float))+'u)'});
    /* Q4: meshes line up? */
    var c0=SF.adj[nr.ri+':0'], c1=SF.adj[nr.ri+':1'];
    d.meshesLineUp=(c0&&c1)
      ? {status:'pass', detail:'both ends connect to the network'}
      : (c0||c1)
        ? {status:'verify', detail:'one end is a dead end — confirm intended'}
        : {status:'fail', detail:'NEITHER end connects — isolated segment'};
    /* Q5: road missing a piece? (same-name gap nearby) */
    var gap=null;
    try{
      var gx=Math.floor(x/PT_CELL), gz=Math.floor(z/PT_CELL);
      var nm=seg.name||'';
      outer:
      for (var ix=gx-2;ix<=gx+2;ix++) for (var iz=gz-2;iz<=gz+2;iz++){
        var a=SF.ptGrid[ix+','+iz]; if(!a) continue;
        for (var s=0;s<a.length;s++){
          if (a[s]===nr.ri) continue;
          var r2=roadDrawData[a[s]];
          if (!r2||r2.name!==nm||!r2.pts) continue;
          for (var e=0;e<2;e++){
            var ep=r2.pts[e===0?0:r2.pts.length-1];
            var gd=Math.sqrt(dist2(x,z,ep[0],ep[1]));
            if (gd>12&&gd<150){ gap={name:nm, dist:Math.round(gd)}; break outer; }
          }
        }
      }
    }catch(e){}
    d.missingPiece=gap
      ? {status:'verify', detail:'same-name road "'+gap.name+'" ends '+gap.dist+'u away — possible missing piece'}
      : {status:'pass', detail:'no same-name gaps nearby'};
    /* Q6: road invisible? — cannot be answered in code. Honest. */
    d.invisible={status:'verify', detail:'requires visual drone inspection — cannot verify in code'};
    d.segRi=nr.ri; d.segName=seg.name||'unnamed road';
  }catch(e){ d.error=String(e&&e.message||e); }
  return d;
}
/* ---------------- the consolidated reporting chain ----------------
   Road Crew → Dispatch → Development Team → Terrain Team → Mesh Team.
   Each tier appends a timestamped verdict derived from the checklist. */
function chainReport(c){
  var d=c.diag, tiers=[];
  function verdict(key, teamIfFail, teamIfPass){
    var q=d[key];
    if (!q) return null;
    return q.status==='pass'?teamIfPass:teamIfFail+' — '+q.detail;
  }
  tiers.push({tier:'Road Crew', t:nowT(),
    note:'Field assessment @ '+c.x+', '+c.z+'. '+
      (d.properMeshes&&d.properMeshes.status!=='pass' ? 'Mesh data suspect. ' : '')+
      (d.roadHeight&&d.roadHeight.status==='fail' ? 'Road/terrain height mismatch confirmed on site. ' : '')+
      'Cones set, scene secured. Report filed to dispatch.'});
  tiers.push({tier:'Dispatch', t:nowT(),
    note:'Case '+c.id+' logged ('+c.kind+'). Routed to development team for data review.'});
  tiers.push({tier:'Development Team', t:nowT(),
    note:verdict('properMeshes',
      'DATA REPAIR REQUIRED in roads.js','road geometry data nominal')+'. '+
      verdict('meshesLineUp','Network topology defect','topology nominal')+'.'});
  tiers.push({tier:'Terrain Team', t:nowT(),
    note:verdict('terrainHeight','TERRAIN DATA DEFECT','terrain data nominal')+'. '+
      verdict('roadHeight','ROAD ELEVATION DEFECT','road elevation nominal')+'.'});
  tiers.push({tier:'Mesh Team', t:nowT(),
    note:verdict('meshesLineUp','MESH ALIGNMENT DEFECT','mesh alignment nominal')+'. '+
      verdict('missingPiece','POSSIBLE MISSING SEGMENT — survey','no missing pieces detected')+'. '+
      verdict('invisible','VISUAL INSPECTION QUEUED (drone fleet)','')});
  /* consolidated root cause = first failing check */
  var cause='no defect reproduced — monitoring';
  var order=['properMeshes','terrainHeight','roadHeight','meshesLineUp','missingPiece'];
  for (var i=0;i<order.length;i++){
    var q=d[order[i]];
    if (q&&(q.status==='fail')){ cause=order[i]+': '+q.detail; break; }
  }
  tiers.push({tier:'CONSOLIDATED', t:nowT(),
    note:'All teams working as one unit. Root cause: '+cause+'. '+
      (cause.indexOf('no defect')===0?'':'Action: '+
        (/DATA|TERRAIN|MESH ALIGNMENT/.test(cause)?'data repair by dev team; ':'')+
        (/ROAD ELEVATION|buried/.test(cause)?'field repair by road crew; ':'')+
        (/MISSING/.test(cause)?'segment survey by fleet; ':'')+
        'fix auto-saves on completion.')});
  c.chain=tiers;
  tiers.forEach(function(t){ dlog('['+c.id+' | '+t.tier+'] '+t.note); });
}
/* ---------------- red-flag response ---------------- */
/* redFlag(kind, x, z, vehicle, detail) — the full protocol:
   1. RED FLAG alert. 2. Police first. 3. Road crew. 4. Chain. 5. Persist. */
function redFlag(kind, x, z, vehicle, detail){
  try{
    /* dedupe: an open case within CLAIM_R merges */
    for (var i=0;i<SF.cases.length;i++){
      var e=SF.cases[i];
      if (e.state!=='open') continue;
      if (dist2(e.x,e.z,x,z)<CLAIM_R*CLAIM_R){
        dlog('🚩 Red-flag report near '+e.id+' merged — case already open.');
        return e.id;
      }
    }
    var id='RF-'+(SF.seq++);
    var c={id:id, kind:kind, x:Math.round(x), z:Math.round(z), vehicle:vehicle,
           detail:detail||'', state:'open', reportedAt:Date.now(),
           diag:null, chain:[], policeAt:0};
    SF.cases.push(c);
    dlog('🚩 RED FLAG '+id+': '+vehicle+' — '+c.detail+' @ '+c.x+', '+c.z);
    toast('🚩 RED FLAG — '+vehicle+' driving through road', 4200);
    /* diagnostics + consolidated chain */
    c.diag=runDiagnostics(x, z);
    chainReport(c);
    /* police FIRST, then road crew (Joshua's order) */
    policeRespond(c);
    crewRespond(c);
    markDirty(); saveLS(true);
    try{ refreshPanel(); }catch(e){}
    try{ Report.setSys('surveyfleet', sysReport()); }catch(e){}
    return id;
  }catch(e){ return null; }
}
/* policeRespond — 2 police cars to the scene, roadblock, flashing lights.
   They hold POLICE_HOLD seconds, then clear. */
function policeRespond(c){
  try{
    var nr=nearestSeg(c.x, c.z);
    var bx=c.x, bz=c.z, hd=0;
    if (nr){
      var seg=roadDrawData[nr.ri], pts=seg.pts;
      var i0=clamp(nr.idx,0,pts.length-2);
      bx=pts[i0][0]; bz=pts[i0][1];
      hd=Math.atan2(pts[i0+1][0]-pts[i0][0], pts[i0+1][1]-pts[i0][1]);
    }
    var grp=new THREE.Group();
    var cols=[];
    [-14, 14].forEach(function(off, k){
      var px=bx+Math.cos(hd)*off, pz=bz+Math.sin(hd)*off;
      var py=groundY(px,pz);
      var pc=makePoliceCar();
      pc.position.set(px, py+0.1, pz);
      pc.rotation.y=hd+Math.PI/2+(k?-0.12:0.12);  // angled across the lane
      grp.add(pc);
      cols.push({mesh:pc, k:k});
      for (var ci=0;ci<3;ci++){
        var cone=makeCone();
        var cx=px+Math.cos(hd)*(ci-1)*6, cz=pz+Math.sin(hd)*(ci-1)*6;
        cone.position.set(cx, groundY(cx,cz), cz);
        grp.add(cone);
      }
    });
    var bar=makeBarricade();
    bar.position.set(bx, groundY(bx,bz), bz); bar.rotation.y=hd+Math.PI/2;
    grp.add(bar);
    scene.add(grp);
    /* colliders so nobody drives through the roadblock */
    var cc=[];
    try{
      if (typeof addCollider==='function'){
        [-14,0,14].forEach(function(off){
          var q={x:bx+Math.cos(hd)*off, z:bz+Math.sin(hd)*off, r:4, y0:-1e9, y1:1e9};
          colliders.push(q); cc.push(q);
        });
      }
    }catch(e){}
    SF.police.push({group:grp, cars:cols, cols:cc, t:0, caseId:c.id});
    c.policeAt=Date.now();
    dlog('🚔 Police on scene for '+c.id+' — roadblock set, area secured.');
    toast('🚔 Police responding — roadblock ahead', 3200);
  }catch(e){}
}
function updatePolice(dt){
  for (var i=SF.police.length-1;i>=0;i--){
    var p=SF.police[i]; p.t+=dt;
    var on=(SF.tick%10<5);
    p.cars.forEach(function(c){
      c.mesh.userData.lightR.visible=on;
      c.mesh.userData.lightB.visible=!on;
    });
    if (p.t>=POLICE_HOLD){
      try{
        scene.remove(p.group);
        if (typeof removeCollider==='function') p.cols.forEach(function(q){ removeCollider(q); });
        else { p.cols.forEach(function(q){ var ix=colliders.indexOf(q); if(ix>=0) colliders.splice(ix,1); }); }
      }catch(e){}
      SF.police.splice(i,1);
      dlog('🚔 Police clear from '+p.caseId+' — roadblock lifted, crew has the scene.');
    }
  }
}
/* crewRespond — road crew second (Joshua's order), via the existing repair
   pipeline; the veteran workflow (assess → report → cones → fix →
   auto-save) lives in that pipeline + roadfix.js. */
function crewRespond(c){
  try{
    var dispatched=false;
    try{
      if (window.__roadCrewOps && window.__roadCrewOps.dispatchRepair){
        window.__roadCrewOps.dispatchRepair({
          x:c.x, z:c.z, street:(c.diag&&c.diag.segName)||'red-flag scene',
          kind:'redflag', caseId:c.id,
          desc:'RED FLAG '+c.id+': '+c.detail});
        dispatched=true;
      }
    }catch(e){}
    if (!dispatched){
      try{
        if (window.INFRACREW) window.INFRACREW.reportIssue({
          kind:'road', x:c.x, z:c.z, street:'red-flag scene',
          desc:'RED FLAG '+c.id+': '+c.detail});
        dispatched=true;
      }catch(e){}
    }
    dlog(dispatched
      ? '🦺 Road crew dispatched to '+c.id+' — assess, report, cone, fix, auto-save.'
      : '⚠️ No crew pipeline available for '+c.id+' — case held open for manual dispatch.');
  }catch(e){}
}

/* ---------------- tablet UI (road crew tablet) ----------------
   🗺️ button with live exploration %; the panel is the crew's tablet:
   explored (green) vs unexplored (red), per-car status, red-flag cases
   with diagnostics + chain, event log. */
function sysReport(){
  var ex=0;
  try{ for (var i=0;i<SF.segCount;i++) if (SF.explored[i]) ex++; }catch(e){}
  return {explored:ex, total:SF.segCount,
    openCases:SF.cases.filter(function(c){return c.state==='open';}).length,
    cars:SF.cars.length};
}
function buildUI(){
  if (SF.uiBuilt) return; SF.uiBuilt=true;
  try{
    var css=document.createElement('style');
    css.textContent=
      '#sf-btn{position:fixed;left:248px;top:8px;z-index:20;min-width:52px;height:52px;border-radius:12px;'+
      'border:2px solid #4da3ff;background:rgba(20,24,34,.88);color:#4da3ff;font-size:13px;font-weight:bold;padding:0 8px;}'+
      '@media (max-width:820px),(pointer:coarse){#sf-btn{left:188px!important;top:96px!important;bottom:auto!important;}}'+
      '#sf-panel{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);}'+
      '#sf-panel.show{display:flex;}'+
      '#sf-panel .card{background:#141a26;border-radius:14px;padding:20px 22px;max-width:520px;width:90%;max-height:78vh;display:flex;flex-direction:column;border:2px solid #4da3ff;}'+
      '#sf-panel h3{margin:0 0 4px 0;color:#4da3ff;}'+
      '#sf-panel .sub{color:#8a93a6;font-size:13px;margin-bottom:10px;}'+
      '#sf-list{overflow-y:auto;flex:1;min-height:80px;}'+
      '.sf-bar{height:18px;border-radius:9px;background:#2a3040;overflow:hidden;margin:6px 0 10px 0;}'+
      '.sf-bar .fill{height:100%;background:linear-gradient(90deg,#2fae5f,#51d651);width:0%;}'+
      '.sf-row{display:flex;justify-content:space-between;font-size:14px;color:#dfe6f2;margin:3px 0;}'+
      '.sf-g{color:#51d651;font-weight:bold;} .sf-r{color:#ff5f5f;font-weight:bold;} .sf-b{color:#4da3ff;}'+
      '.sf-case{margin:10px 0;padding:10px 12px;border-radius:10px;border:2px solid #ff5f5f;background:#2a1e22;color:#fff;font-size:13px;}'+
      '.sf-case .cid{font-weight:bold;color:#ff8f8f;}'+
      '.sf-case .ck{margin-top:6px;}'+
      '.sf-case .pass{color:#51d651;} .sf-case .fail{color:#ff5f5f;font-weight:bold;} .sf-case .verify{color:#ffb02e;}'+
      '.sf-case .tier{color:#9fb2cc;margin-top:4px;}'+
      '.sf-car{font-size:13px;color:#c9d4e8;margin:2px 0;}'+
      '.sf-log{margin:6px 0;padding:6px 10px;font-size:12px;color:#c9c9c9;border-left:3px solid #4da3ff;}'+
      '.sf-log .lt{color:#8a93a6;margin-right:8px;}'+
      '#sf-close{margin-top:12px;padding:10px 18px;font-size:15px;border-radius:10px;border:none;background:#4da3ff;color:#111;font-weight:bold;width:100%;}';
    document.head.appendChild(css);
    var btn=document.createElement('button');
    btn.id='sf-btn'; btn.title='Survey fleet tablet — road exploration status';
    btn.innerHTML='🗺️<br><span id="sf-pct" style="font-size:11px">0%</span>';
    btn.addEventListener('click', function(){ togglePanel(); });
    document.body.appendChild(btn);
    var panel=document.createElement('div');
    panel.id='sf-panel';
    panel.innerHTML='<div class="card"><h3>🗺️ Survey Fleet Tablet</h3>'+
      '<div class="sub">5 self-driving survey cars · road crew issue board</div>'+
      '<div id="sf-list"></div><button id="sf-close">Close</button></div>';
    document.body.appendChild(panel);
    document.getElementById('sf-close').addEventListener('click', function(){ togglePanel(false); });
  }catch(e){}
}
function refreshPanel(){
  if (!SF.uiBuilt) return;
  try{
    var pctEl=document.getElementById('sf-pct');
    var rep=sysReport();
    var pct=rep.total?Math.round(100*rep.explored/rep.total):0;
    if (pctEl) pctEl.textContent=pct+'%';
    var el=document.getElementById('sf-list'); if(!el) return;
    var h='<div class="sf-row"><span>Exploration progress</span><span class="sf-b">'+pct+'%</span></div>'+
      '<div class="sf-bar"><div class="fill" style="width:'+pct+'%"></div></div>'+
      '<div class="sf-row"><span class="sf-g">● Explored: '+rep.explored+'</span>'+
      '<span class="sf-r">● Unexplored: '+(rep.total-rep.explored)+'</span></div>'+
      '<div class="sub" style="margin-top:10px">SURVEY CARS</div>';
    SF.cars.forEach(function(car){
      h+='<div class="sf-car">🚗 Car '+car.no+': <span class="sf-b">'+car.task+'</span></div>';
    });
    var open=SF.cases.filter(function(c){return c.state==='open';});
    h+='<div class="sub" style="margin-top:10px">RED-FLAG CASES ('+open.length+' open)</div>';
    if (!open.length) h+='<div class="sf-car">No open cases — roads holding.</div>';
    open.slice(-5).reverse().forEach(function(c){
      h+='<div class="sf-case"><span class="cid">'+c.id+'</span> ['+c.kind+'] '+c.vehicle+
         '<br>'+c.detail+' @ '+c.x+', '+c.z;
      if (c.diag){
        h+='<div class="ck">';
        [['properMeshes','Proper meshes'],['terrainHeight','Terrain height'],
         ['roadHeight','Road height'],['meshesLineUp','Meshes line up'],
         ['missingPiece','Missing piece'],['invisible','Invisible?']].forEach(function(q){
          var r=c.diag[q[0]];
          if (r) h+='<div class="'+r.status+'">'+(r.status==='pass'?'✓':r.status==='fail'?'✗':'?')+
                   ' '+q[1]+': '+r.detail+'</div>';
        });
        h+='</div>';
      }
      if (c.chain&&c.chain.length){
        h+='<div class="tier">CHAIN: '+c.chain.map(function(t){return t.tier;}).join(' → ')+'</div>';
      }
      h+='</div>';
    });
    h+='<div class="sub" style="margin-top:8px">EVENT LOG</div>';
    var logs=SF.log.slice(-12).reverse();
    if (!logs.length) h+='<div class="sf-log">Fleet spooling up…</div>';
    logs.forEach(function(e){
      h+='<div class="sf-log"><span class="lt">'+e.t+'</span>'+e.msg+'</div>';
    });
    el.innerHTML=h;
  }catch(e){}
}
function togglePanel(force){
  try{
    SF.panelOpen=(typeof force==='boolean')?force:!SF.panelOpen;
    var p=document.getElementById('sf-panel');
    if (p){ if(SF.panelOpen){ refreshPanel(); p.classList.add('show'); } else p.classList.remove('show'); }
  }catch(e){}
}
/* ---------------- main loop ---------------- */
function updateSurveyFleet(dt){
  if (!SF.ready) return;
  try{
    SF.time+=dt; SF.tick++;
    for (var i=0;i<SF.cars.length;i++){
      var car=SF.cars[i];
      if (car.state==='idle') continue;
      /* v1.18 WAIT-FOR-FIX (Joshua's directive): a car whose wait ended
         EXTERNALLY (crew called StuckDiag.markFixed while we were parked)
         has waitingForFix already cleared — run the resume path so the
         'nd' flag is lifted and the car re-surveys the fixed segment. */
      if (car.waitSeg>=0 && !car.waitingForFix){
        resumeAfterFix(car);
        continue;
      }
      /* while a survey car is waiting for the fix crew, it does NOT move —
         same as road crew / code-enforcement units. waitTick() re-checks
         the data periodically and auto-releases; crew markFixed() releases
         immediately (handled by the branch above). */
      if (car.waitingForFix){
        try{
          if (typeof StuckDiag!=='undefined' && typeof StuckDiag.waitTick==='function'){
            if (StuckDiag.waitTick(car, dt, function(m){ dlog(m); })){
              resumeAfterFix(car);   // fix confirmed — back to work
            }
          }
        }catch(e){}
        continue;
      }
      if (car.target<0 || (car.target>=0 && !claims[car.target] && !SF.explored[car.target])){
        /* target lost or finished without claim — reassign */
        if (car.target>=0 && SF.explored[car.target]) assignNext(car);
        else if (car.target<0) assignNext(car);
      }
      sfAdvance(car, dt);
      surveySelfCheck(car);
    }
    /* ghost scan on a timer */
    SF.ghostAcc+=dt;
    if (SF.ghostAcc>=GHOST_T){ SF.ghostAcc=0; ghostScan(); }
    /* v1.18: periodic stale-flag reconciliation (covers crew systems that
       boot after the fleet, and fixes that land mid-session) */
    if (SF.time-lastReconcile>300) reconcileStaleFlags();
    updatePolice(dt);
    saveLS(false);
    if (SF.tick%1200===0){ try{ Report.setSys('surveyfleet', sysReport()); }catch(e){} }
  }catch(e){}
}
/* ---------------- init + boot ---------------- */
function initSurveyFleet(){
  SF.segCount=0;
  try{ SF.segCount=roadDrawData.length||0; }catch(e){}
  if (SF.segCount<100) return;  // not enough road data — stay off
  SF.mapSig=mapSignature();
  SF.explored=new Array(SF.segCount);
  for (var i=0;i<SF.segCount;i++) SF.explored[i]=0;
  loadLS();  // restores explored bitmask if the map signature matches
  var ex=0; for (var j=0;j<SF.segCount;j++) if (SF.explored[j]) ex++;
  reconcileStaleFlags();  // v1.18: lift 'nd' flags whose fixes landed while away
  buildNetwork();
  buildUI();
  spawnSurveyCars();
  SF.cars.forEach(function(car){ assignNext(car); });
  if (!SF.log.length) dlog('Survey fleet online — 5 self-driving cars mapping the city. Tablet live.');
  else dlog('Survey fleet resumed — '+ex+'/'+SF.segCount+' segments already explored.');
  SF.ready=true;
  try{ Report.setSys('surveyfleet', sysReport()); }catch(e){}
  /* PUBLIC API */
  window.SURVEYFLEET={
    stats:sysReport,
    cases:SF.cases,
    tablet:function(f){ togglePanel(f); },
    reportIssue:function(o){
      if(!o||typeof o.x!=='number') return null;
      return redFlag(o.kind||'report', o.x, o.z, o.vehicle||'report', o.desc||'');
    },
    resolveCase:function(id, note){
      for (var i=0;i<SF.cases.length;i++){
        if (SF.cases[i].id===id){
          SF.cases[i].state='fixed';
          SF.cases[i].fixedAt=Date.now();
          SF.cases[i].fixNote=note||'';
          dlog('✅ '+id+' RESOLVED — '+(note||'fix confirmed')+'. Auto-saved.');
          markDirty(); saveLS(true);
          try{ refreshPanel(); }catch(e){}
          return true;
        }
      }
      return false;
    },
    forceResurvey:function(){
      for (var k=0;k<SF.segCount;k++) SF.explored[k]=0;
      SF.flags={}; markDirty(); saveLS(true);
      dlog('Fleet ordered to re-survey the entire map.');
      /* v1.18 WAIT-FOR-FIX: a car parked waiting has nothing to wait for
         once every flag is wiped — release it cleanly (mirror of
         StuckDiag's internal release) before re-tasking. */
      SF.cars.forEach(function(car){
        if (car.waitingForFix){
          car.waitingForFix=false; car.waitStartT=null; car.waitSpot=null;
          car._waitAcc=0; car.waitSeg=-1; car.stuckT=0;
        }
        retarget(car,'re-survey ordered');
      });
    }
  };
  /* hook into the frame loop — chains with other module wraps */
  try{
    if (typeof animate==='function' && !animate.__surveyfleetWrap){
      var orig=animate;
      var wrapped=function(){ orig(); updateSurveyFleet(0.016); };
      wrapped.__surveyfleetWrap=true;
      animate=wrapped;
    }
  }catch(e){}
}
/* boot — wait until the world exists (THREE, scene, roadDrawData, animate,
   heightAt); give up after 120s without breaking the game. */
var bootTries=0;
var bootTimer=setInterval(function(){
  bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined' && typeof scene!=='undefined' &&
      typeof roadDrawData!=='undefined' && roadDrawData.length>100 &&
      typeof animate==='function' && typeof heightAt==='function');
  }catch(e){ ready=false; }
  if (ready){
    clearInterval(bootTimer);
    try{ initSurveyFleet(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('surveyfleet','init failed',String(e&&e.message||e)); }catch(x){}
    }
  } else if (bootTries>240){
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('surveyfleet','boot-timeout','deps never ready'); }catch(e){}
  }
},500);
})();
