/* ============================================================================
   FILE: infracrew_system.js — "Surviving Adamsville" INFRASTRUCTURE REPAIR CREW
   ----------------------------------------------------------------------------
   PURPOSE (Joshua's directive, 2026-10-09): a dedicated NPC team responsible
   for traffic-light construction/repair, road construction/repair, and road
   signage construction/repair. When an issue is reported — a broken or
   mispositioned traffic light, damaged pavement, a down/damaged/misplaced
   sign — the crew DEPLOYS to the location in work trucks with flashing
   lights, sets up cones and warning signs, performs the repair, marks the
   issue fixed, cleans up, and leaves. This makes the city feel maintained
   by actual workers instead of magically healing.

   RELATIONSHIP TO roadcrew_system.js: the road crew handles STRUCTURAL road
   defects (gaps, disconnects) found by patrols against the Street View
   audit. The infra crew handles DAY-TO-DAY infrastructure: signal outages,
   potholes/pavement damage, and sign problems — the things the 25-person
   sign-inspection teams, the helicopter aerial surveys, and watcher
   feedback report. The two crews are visually distinct (infra = lime hi-vis
   + white hard hats; road crew = orange hi-vis + yellow hard hats).

   KEY SYSTEMS:
     - Issue queue: reported → dispatched → repairing → fixed. Persists in
       localStorage (key sa_infracrew_v1); in-progress states reset to
       'reported' on reload so crews re-run — same convention as roadcrew.
     - Seed issues: the two floating I-85 exit signs found by Helicopter
       Unit 2's aerial survey (157u west of the carriageway).
     - Patrol discovery: 2 infra trucks patrol road polylines; each has a
       small chance per tick to discover a signal outage (bulb out) or
       pavement damage at its position — honest sim behavior, not fake data.
     - Repair jobs: truck parked to the side (flashing amber light bar),
       3 workers with repair animation, kind-specific warning signs, an
       8-cone ring, timed repair (signal 60s / road 45s / sign 30s), then a
       permanent repair artifact (fresh asphalt patch for road work) and
       full collider cleanup.
     - Fix-duration tracking (Joshua's rule): every issue records report→fix
       duration, shown in the dispatch log.
     - Public API: window.INFRACREW.reportIssue({kind,x,z,desc}) — the sign
       inspectors, helicopter units, watcher feedback, and any other system
       call this to file an issue. Guards dedupe near-duplicates.

   STANDALONE MODULE. Include AFTER the main game script — zero edits to
   index.html game logic required (one <script> tag):

       <script src="infracrew_system.js"></script>

   Design: simple sim logic (Joshua's rule). No pathfinding — patrols follow
   real road polylines; repair crews arrive at sites directly. Everything is
   guarded: if any dependency is missing the module stays off and the game
   is unaffected.
   ============================================================================ */
(function(){
'use strict';
/* Single-instance guard — never double-boot if the script tag loads twice. */
if (window.__infracrewV1) return;
window.__infracrewV1 = true;

/* ---------------- config ----------------
   Tuned for a living-city feel without spamming the map with work zones. */
var LS_KEY      = 'sa_infracrew_v1';  // localStorage persistence key
var DISPATCH_T  = 5;      // seconds from 'reported' -> crew dispatched
var REPAIR_T    = {signal:60, road:45, sign:30};  // seconds per kind
var PATROL_SPEED= 13;     // patrol truck speed (u/s)
var N_PATROLS   = 2;      // infra patrol trucks out at all times
var OUTAGE_P    = 0.0015; // per-tick chance a patrol discovers a signal outage
var PAVE_P      = 0.0008; // per-tick chance a patrol discovers pavement damage
var MAX_OPEN_SIG= 6;      // cap concurrent open signal issues (anti-spam)
var MAX_OPEN_RD = 4;      // cap concurrent open road issues (anti-spam)
var DEDUP_R     = 60;     // reports within this radius of an open issue merge

/* ---------------- issue database ----------------
   kind: 'signal' (traffic light) | 'road' (pavement) | 'sign' (road sign)
   state: reported | dispatched | repairing | fixed
   Seed issues below come from VERIFIED findings — Helicopter Unit 2's aerial
   survey (2026-10-09): two I-85 exit signs floating ~157u west of the
   carriageway. These are real, not invented. */
var ISSUES=[
 {id:'INF-SIGN-1', kind:'sign', street:'I-85 — "State Rte 14 Spr" exit sign',
  x:4289, z:8607,
  desc:'Overhead exit sign floats ~157u west of the I-85 carriageway. Reposition over the roadway per SignRules.',
  state:'reported', reportedAt:0, fixedAt:0},
 {id:'INF-SIGN-2', kind:'sign', street:'I-85 — "Godby Rd" exit sign',
  x:4290, z:8609,
  desc:'Overhead exit sign floats ~157u west of the I-85 carriageway. Reposition over the roadway per SignRules.',
  state:'reported', reportedAt:0, fixedAt:0}
];
var _seq=3;  // next auto id number

/* ---------------- runtime state ---------------- */
var IC={jobs:[], patrols:[], log:[], ready:false, time:0, tick:0,
        uiBuilt:false, panelOpen:false, patchMeshes:[]};

/* ---------------- small helpers (module-local, guarded) ---------------- */
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function dist2(ax,az,bx,bz){ var dx=ax-bx,dz=az-bz; return dx*dx+dz*dz; }
/* groundY — terrain height with a safe fallback; never throws. */
function groundY(x,z){ try{ var y=heightAt(x,z); return isFinite(y)?y:0; }catch(e){ return 0; } }
/* toast — HUD toast if the helper exists, silent otherwise. */
function toast(msg,ms){ try{ if(typeof showToast==='function') showToast(msg,ms||2600); }catch(e){} }
function nowT(){ var d=new Date(); function p(n){return (n<10?'0':'')+n;} return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
/* dlog — timestamped dispatch log (capped at 200 entries). */
function dlog(msg){
  IC.log.push({t:nowT(), msg:msg});
  if (IC.log.length>200) IC.log.splice(0, IC.log.length-200);
  try{ refreshPanel(); }catch(e){}
}
/* sysReport — snapshot for the Report panel. */
function sysReport(){
  var st={}; ISSUES.forEach(function(d){ st[d.id]=d.state; });
  return {issues:st, openJobs:IC.jobs.length, patrols:IC.patrols.length};
}
/* saveLS / loadLS — persist issues + log. In-progress states ('dispatched',
   'repairing') reset to 'reported' on load so crews re-run the job — the
   same convention roadcrew_system.js uses. */
function saveLS(){
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({issues:ISSUES, log:IC.log.slice(-60), seq:_seq}));
  }catch(e){}
}
function loadLS(){
  try{
    var raw=localStorage.getItem(LS_KEY); if(!raw) return;
    var o=JSON.parse(raw);
    if (o && o.issues && o.issues.length){
      ISSUES=o.issues;
      ISSUES.forEach(function(d){
        if (d.state==='dispatched'||d.state==='repairing') d.state='reported';
      });
    }
    if (o && o.log) IC.log=o.log;
    if (o && o.seq) _seq=o.seq;
  }catch(e){}
}

/* ---------------- three.js builders ---------------- */
function makeCanvas(w,h){
  var c=document.createElement('canvas'); c.width=w; c.height=h;
  return {c:c, ctx:c.getContext('2d')};
}
/* signTexture — orange diamond-style work sign face. */
function signTexture(main, sub){
  var k=makeCanvas(512,320), x=k.ctx;
  x.fillStyle='#e8641b'; x.fillRect(0,0,512,320);
  x.strokeStyle='#111'; x.lineWidth=14; x.strokeRect(10,10,492,300);
  x.fillStyle='#111'; x.textAlign='center';
  x.font='bold 64px Arial'; x.fillText(main,256,140);
  if (sub){ x.font='bold 44px Arial'; x.fillText(sub,256,225); }
  var t=new THREE.CanvasTexture(k.c); t.anisotropy=4;
  return t;
}
function mat(color, emissive){
  return new THREE.MeshLambertMaterial({color:color, emissive:emissive||0x000000});
}
function box(w,h,d,color,emissive){
  return new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat(color,emissive));
}
/* makeInfraTruck — white utility truck with amber light bar + CITY INFRA
   door decal. Distinct silhouette from the road-crew truck (no chevron
   arrow board; shorter bed, roof beacon). Faces +Z. */
function makeInfraTruck(){
  var g=new THREE.Group();
  var white=0xf4f4f4, navy=0x1c2a4a, dark=0x222226, amber=0xffb02e;
  var chassis=box(2.2,0.5,5.0,dark); chassis.position.y=0.55; g.add(chassis);
  var cab=box(2.2,1.5,1.8,white); cab.position.set(0,1.55,1.5); g.add(cab);
  var shield=box(1.9,0.8,0.12,0x1c2733); shield.position.set(0,1.7,2.42); g.add(shield);
  var bed=box(2.2,0.9,2.6,white); bed.position.set(0,1.25,-1.05); g.add(bed);
  var stripe=box(2.24,0.28,2.64,navy); stripe.position.set(0,1.28,-1.05); g.add(stripe);
  /* CITY INFRA door decal (canvas texture on both doors). */
  try{
    var k=makeCanvas(256,96), x=k.ctx;
    x.fillStyle='#1c2a4a'; x.fillRect(0,0,256,96);
    x.fillStyle='#ffffff'; x.font='bold 40px Arial'; x.textAlign='center';
    x.fillText('CITY INFRA',128,60);
    var dt=new THREE.CanvasTexture(k.c);
    [-1.11,1.11].forEach(function(sx){
      var decal=new THREE.Mesh(new THREE.PlaneGeometry(1.5,0.56),
        new THREE.MeshLambertMaterial({map:dt}));
      decal.position.set(sx,1.5,1.5); decal.rotation.y=sx>0?Math.PI/2:-Math.PI/2;
      g.add(decal);
    });
  }catch(e){}
  /* amber light bar — flashes while the crew works the site. */
  var bar=box(1.3,0.26,0.45,amber,0xcc7700); bar.position.set(0,2.42,1.5); g.add(bar);
  g.userData.lightBar=bar;
  var wg=new THREE.CylinderGeometry(0.45,0.45,0.35,10);
  var wm=mat(0x141414);
  [[-1.05,1.6],[1.05,1.6],[-1.05,-1.4],[1.05,-1.4]].forEach(function(p){
    var w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2;
    w.position.set(p[0],0.45,p[1]); g.add(w);
  });
  return g;
}
/* makeInfraWorker — INFRASTRUCTURE crew figure. Lime/chartreuse hi-vis vest
   with reflective stripes + WHITE hard hat — instantly distinct from the
   road crew (orange vest + yellow hat). Nobody else dresses like this. */
function makeInfraWorker(){
  var g=new THREE.Group();
  var legs=box(0.5,0.7,0.34,0x232a3a); legs.position.y=0.35; g.add(legs);
  /* lime hi-vis vest, emissive so it pops at any distance */
  var torso=new THREE.Mesh(new THREE.BoxGeometry(0.62,0.72,0.4),
    new THREE.MeshLambertMaterial({color:0xa8d800, emissive:0x3a4a00}));
  torso.position.y=1.06; g.add(torso);
  var s1=new THREE.Mesh(new THREE.BoxGeometry(0.64,0.1,0.42),
    new THREE.MeshLambertMaterial({color:0xf2f2f2, emissive:0x555555}));
  s1.position.y=1.18; g.add(s1);
  var s2=s1.clone(); s2.position.y=0.98; g.add(s2);
  var head=box(0.36,0.36,0.36,0x6b4429); head.position.y=1.6; g.add(head);
  var hat=new THREE.Mesh(new THREE.BoxGeometry(0.44,0.16,0.44),
    new THREE.MeshLambertMaterial({color:0xf4f4f4, emissive:0x222222}));
  hat.position.y=1.84; g.add(hat);
  var armL=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.6,0.16),
    new THREE.MeshLambertMaterial({color:0xa8d800, emissive:0x3a4a00}));
  armL.position.set(-0.4,1.05,0); g.add(armL);
  var armR=armL.clone(); armR.position.set(0.4,1.05,0); g.add(armR);
  g.userData.armL=armL; g.userData.armR=armR;
  return g;
}
/* makeWarnSign — work-zone warning sign; text varies by issue kind. */
function makeWarnSign(main, sub){
  var g=new THREE.Group();
  var p1=box(0.18,3.0,0.18,0x555c66); p1.position.set(-1.1,1.5,0); g.add(p1);
  var p2=box(0.18,3.0,0.18,0x555c66); p2.position.set(1.1,1.5,0); g.add(p2);
  var panel=new THREE.Mesh(new THREE.PlaneGeometry(4.2,2.6),
    new THREE.MeshLambertMaterial({map:signTexture(main,sub), side:THREE.DoubleSide}));
  panel.position.y=3.2; g.add(panel);
  return g;
}
/* makeConeRing — 8 cones in a ring around the work area (instanced). */
function makeConeRing(cx,cz,radius){
  var n=8;
  var geo=new THREE.ConeGeometry(0.55,1.15,8);
  var im=new THREE.InstancedMesh(geo, mat(0xe8641b), n);
  var m4=new THREE.Matrix4(), q=new THREE.Quaternion(),
      s=new THREE.Vector3(1,1,1), p=new THREE.Vector3();
  var positions=[];
  for (var i=0;i<n;i++){
    var a=i/n*Math.PI*2;
    var x=cx+Math.cos(a)*radius, z=cz+Math.sin(a)*radius;
    p.set(x, groundY(x,z)+0.58, z); q.identity(); s.set(1,1,1);
    m4.compose(p,q,s); im.setMatrixAt(i,m4);
    positions.push({x:x, z:z});
  }
  im.instanceMatrix.needsUpdate=true;
  im.frustumCulled=false;  // instances span the site; skip culling
  return {mesh:im, positions:positions};
}
/* makePatch — fresh asphalt patch laid after a road repair (permanent). */
function makePatch(x,z,w,d,heading){
  var g=new THREE.PlaneGeometry(w||18, d||10);
  var m=new THREE.Mesh(g, mat(0x232326));
  m.rotation.x=-Math.PI/2; m.rotation.z=-(heading||0);
  m.position.set(x, groundY(x,z)+0.08, z);
  return m;
}
/* ---------------- road helpers (self-contained; guarded) ---------------- */
function nearestRoad(x,z){
  var best=null, bestD=1e18, bestI=0;
  try{
    for (var i=0;i<roadDrawData.length;i++){
      var r=roadDrawData[i];
      if (!r||!r.pts||r.pts.length<2) continue;
      for (var j=0;j<r.pts.length;j++){
        var p=r.pts[j], d=dist2(x,z,p[0],p[1]);
        if (d<bestD){ bestD=d; best=r; bestI=j; }
      }
    }
  }catch(e){}
  return best?{seg:best, idx:bestI, dist:Math.sqrt(bestD)}:null;
}
function roadHeadingAt(nr){
  try{
    var pts=nr.seg.pts, i=clamp(nr.idx,0,pts.length-2);
    var a=pts[i], b=pts[i+1];
    return Math.atan2(b[0]-a[0], b[1]-a[1]);
  }catch(e){ return 0; }
}

/* ---------------- issue intake ---------------- */
/* kindLabel — human-readable kind name for logs/toasts. */
function kindLabel(k){
  return k==='signal'?'traffic light':(k==='road'?'road':'sign');
}
/* reportIssue({kind,x,z,desc,street}) — PUBLIC intake. Called by the sign
   inspectors, helicopter units, watcher feedback, stuck diagnostics, or the
   admin panel. Near-duplicate open issues (within DEDUP_R) are merged, not
   duplicated — the log notes the merge. Returns the issue id. */
function reportIssue(o){
  if (!o || typeof o.x!=='number' || typeof o.z!=='number') return null;
  var kind=(o.kind==='signal'||o.kind==='road')?o.kind:'sign';
  for (var i=0;i<ISSUES.length;i++){
    var e=ISSUES[i];
    if (e.state==='fixed') continue;
    if (e.kind===kind && dist2(e.x,e.z,o.x,o.z)<DEDUP_R*DEDUP_R){
      dlog('Duplicate '+kindLabel(kind)+' report near '+e.id+' merged — already on the board.');
      return e.id;
    }
  }
  var id='INF-'+kind.slice(0,3).toUpperCase()+'-'+(_seq++);
  ISSUES.push({id:id, kind:kind, street:o.street||'reported location',
    x:o.x, z:o.z, desc:o.desc||('Crew report: '+kindLabel(kind)+' needs service.'),
    state:'reported', reportedAt:Date.now(), fixedAt:0});
  dlog('New '+kindLabel(kind)+' issue '+id+' reported'+(o.street?(' ('+o.street+')'):'')+' — dispatching crew.');
  /* v1.18 veteran field note — the reporting unit reads it with 30-year eyes. */
  try{ if(typeof VeteranCrew!=='undefined') dlog('Field note: "'+VeteranCrew.fieldNote(kind)+'"'); }catch(e){}
  toast('🔧 Infra crew dispatched: '+kindLabel(kind)+' issue'+(o.street?(' @ '+o.street):''));
  saveLS();
  try{ Report.setSys('infracrew', sysReport()); }catch(e){}
  return id;
}
/* ---------------- patrols ---------------- */
/* Patrol trucks drive real road polylines (simple sim: advance along pts,
   hop to a connected segment at the end via endpoint snap — same idea as
   the road-crew continuation). While patrolling they can DISCOVER issues:
   signal outages (bulb out) and pavement damage. Discovery is honest sim
   behavior with low probabilities, capped so the map never floods. */
var IC_EP=null, IC_EP_CELL=120, IC_SNAP_R=70;
function icBuildEP(){
  if (IC_EP) return;
  IC_EP={};
  try{
    for (var i=0;i<roadDrawData.length;i++){
      var r=roadDrawData[i]; if(!r||!r.pts||r.pts.length<2) continue;
      var a=r.pts[0], b=r.pts[r.pts.length-1];
      [[a,i,0],[b,i,1]].forEach(function(e){
        var k=Math.floor(e[0][0]/IC_EP_CELL)+':'+Math.floor(e[0][1]/IC_EP_CELL);
        (IC_EP[k]=IC_EP[k]||[]).push(e);
      });
    }
  }catch(e){}
}
function icFindConnection(x,z,selfI){
  icBuildEP();
  var best=null, bestD=IC_SNAP_R*IC_SNAP_R;
  try{
    var ck=Math.floor(x/IC_EP_CELL)+':'+Math.floor(z/IC_EP_CELL);
    var cands=IC_EP[ck]||[];
    for (var i=0;i<cands.length;i++){
      var c=cands[i]; if (c[1]===selfI) continue;
      var r=roadDrawData[c[1]]; if(!r||!r.pts||r.pts.length<8) continue;
      var p=r.pts[c[2]?r.pts.length-1:0], d=dist2(x,z,p[0],p[1]);
      if (d<bestD){ bestD=d; best={seg:r, rev:c[2]===0}; }
    }
  }catch(e){}
  return best;
}
function spawnInfraPatrol(n, sx, sz){
  try{
    var truck=makeInfraTruck(); scene.add(truck);
    var nr=nearestRoad(sx,sz);
    var u={n:n, mesh:truck, seg:nr?nr.seg:null, idx:nr?nr.idx:0, dir:1,
           x:sx, z:sz, waitT:0};
    IC.patrols.push(u);
    dlog('Infra patrol unit '+n+' on duty — signal/road/sign inspection rounds.');
  }catch(e){}
}
function patrolAdvance(u, dt){
  try{
    if (!u.seg||!u.seg.pts||u.seg.pts.length<2){
      var nr=nearestRoad(u.x,u.z);
      if (!nr) return;
      u.seg=nr.seg; u.idx=nr.idx; u.dir=1;
    }
    var pts=u.seg.pts;
    u.idx+=u.dir;
    if (u.idx>=pts.length-1||u.idx<0){
      /* end of segment — hop to a connected one, bounce as fallback */
      var ex=u.idx<0?pts[0]:pts[pts.length-1];
      var conn=icFindConnection(ex[0],ex[1],roadDrawData.indexOf(u.seg));
      if (conn){
        u.seg=conn.seg; u.idx=conn.rev?conn.seg.pts.length-1:0; u.dir=conn.rev?-1:1;
      } else { u.dir*=-1; u.idx=clamp(u.idx,0,pts.length-1); }
      return;
    }
    var a=pts[u.idx], b=pts[clamp(u.idx+u.dir,0,pts.length-1)];
    var dx=b[0]-a[0], dz=b[1]-a[1], len=Math.hypot(dx,dz)||1;
    var step=PATROL_SPEED*dt;
    /* move along the segment toward the next point */
    var t=clamp(step/len,0,1);
    u.x=a[0]+dx*t; u.z=a[1]+dz*t;
    var y=groundY(u.x,u.z);
    u.mesh.position.set(u.x, y+0.05, u.z);
    u.mesh.rotation.y=Math.atan2(dx,dz);
    /* light bar idle blink while patrolling */
    var bar=u.mesh.userData.lightBar;
    if (bar) bar.visible=(IC.tick%30<3);
  }catch(e){}
}
/* patrolDiscover — the honest-sim part: a patrol can spot a signal outage
   or pavement damage at its position. Low probabilities + caps keep this
   believable; every discovery is a real new issue on the board. */
function patrolDiscover(u){
  try{
    var openSig=0, openRd=0;
    for (var i=0;i<ISSUES.length;i++){
      if (ISSUES[i].state==='fixed') continue;
      if (ISSUES[i].kind==='signal') openSig++;
      else if (ISSUES[i].kind==='road') openRd++;
    }
    var roll=Math.random();
    if (roll<OUTAGE_P && openSig<MAX_OPEN_SIG){
      reportIssue({kind:'signal', x:u.x, z:u.z,
        street:'patrol discovery',
        desc:'Patrol unit '+u.n+' found a traffic light out (bulb/service needed) — flagged for signal crew.'});
    } else if (roll<OUTAGE_P+PAVE_P && openRd<MAX_OPEN_RD){
      reportIssue({kind:'road', x:u.x, z:u.z,
        street:'patrol discovery',
        desc:'Patrol unit '+u.n+' found pavement damage (pothole/cracking) — flagged for road crew.'});
    }
  }catch(e){}
}
function updatePatrols(dt){
  for (var i=0;i<IC.patrols.length;i++){
    var u=IC.patrols[i];
    patrolAdvance(u, dt);
    patrolDiscover(u);
  }
}

/* ---------------- repair jobs ---------------- */
/* warnText — kind-specific warning sign copy. */
function warnText(kind){
  if (kind==='signal') return ['SIGNAL CREW','AHEAD'];
  if (kind==='road')   return ['ROAD WORK','AHEAD'];
  return ['SIGN CREW','AHEAD'];
}
/* dispatchCrew(issue) — sends the infra crew: work truck parked 12u to the
   side (amber bar flashing), 3 lime-vest workers at the site, kind-specific
   warning signs on both approaches, an 8-cone ring. Colliders tracked for
   cleanup. State → 'repairing'. */
function dispatchCrew(d){
  var nr=nearestRoad(d.x,d.z);
  var heading=nr?roadHeadingAt(nr):0;
  var y=groundY(d.x,d.z);
  var hx=Math.sin(heading), hz=Math.cos(heading);
  var px=hz, pz=-hx;
  var grp=new THREE.Group(); scene.add(grp);
  /* truck parked to the side */
  var truck=makeInfraTruck();
  var tx=d.x+px*12, tz=d.z+pz*12;
  truck.position.set(tx, groundY(tx,tz)+0.05, tz);
  truck.rotation.y=heading+0.25; grp.add(truck);
  var truckCol=null;
  try{ if(typeof addCollider==='function'){
    var tc={x:tx, z:tz, r:3.0, y0:-1e9, y1:1e9};
    colliders.push(tc); truckCol=tc;
  }}catch(e){}
  /* three workers at the site */
  var workers=[];
  [[-3,2],[3,-2],[0,4]].forEach(function(o){
    var w=makeInfraWorker();
    var wx=d.x+o[0], wz=d.z+o[1];
    w.position.set(wx, groundY(wx,wz), wz);
    w.rotation.y=Math.random()*6.28; grp.add(w); workers.push(w);
  });
  /* warning signs on both approaches */
  var wt=warnText(d.kind), signs=[], signCols=[];
  [[-46,0],[46,0]].forEach(function(o){
    var s=makeWarnSign(wt[0], wt[1]);
    var sx=d.x+hx*o[0]+px*6, sz=d.z+hz*o[0]+pz*6;
    s.position.set(sx, groundY(sx,sz), sz);
    s.rotation.y=heading+(o[0]<0?0:Math.PI); grp.add(s); signs.push(s);
    try{ if(typeof addCollider==='function'){
      var sc={x:sx, z:sz, r:0.4, y0:-1e9, y1:1e9};
      colliders.push(sc); signCols.push(sc);
    }}catch(e){}
  });
  /* cone ring around the work area */
  var coneData=makeConeRing(d.x,d.z,9); grp.add(coneData.mesh);
  var coneCols=[];
  coneData.positions.forEach(function(cp){
    try{ if(typeof addCollider==='function'){
      var cc={x:cp.x, z:cp.z, r:0.5, y0:-1e9, y1:1e9};
      colliders.push(cc); coneCols.push(cc);
    }}catch(e){}
  });
  d.state='repairing';
  var job={issue:d, group:grp, truck:truck, workers:workers, signs:signs,
    coneData:coneData, t:0, dur:REPAIR_T[d.kind]||45,
    truckCol:truckCol, signCols:signCols, coneCols:coneCols};
  IC.jobs.push(job);
  /* v1.18 VETERAN CREW (Joshua 2026-10-09): 30-year-veteran workflow —
     assess → report → dispatch → setup → fix → verify → auto-save.
     A foreman (gray hard hat + clipboard) leads the job; the workers
     stage by the truck and walk out to their stations in the setup phase. */
  try{
    if (typeof VeteranCrew!=='undefined'){
      var _vt2=[];
      workers.forEach(function(w){ _vt2.push({x:w.position.x, z:w.position.z}); });
      var _fm2=VeteranCrew.makeForeman('infra');
      if (_fm2){ _fm2.position.set(tx, groundY(tx,tz), tz); grp.add(_fm2); job.foreman=_fm2; }
      job.vet=VeteranCrew.jobState({crew:'INFRA', kind:d.kind, issue:d,
        fixDur:job.dur, siteR:9, truckPos:{x:tx, z:tz},
        workerTargets:_vt2, foremanStyle:'infra'});
      /* stage the crew by the truck — the setup phase walks them out. */
      var _stg2=[[2.5,0.5],[-2.5,0.5],[0,3]];
      workers.forEach(function(w,k){
        var _s2=_stg2[k%_stg2.length];
        w.position.set(tx+_s2[0], groundY(tx+_s2[0],tz+_s2[1]), tz+_s2[1]);
      });
    }
  }catch(e){}
  dlog('Infra crew on site at '+d.id+' ('+d.street+') — '+kindLabel(d.kind)+' repair underway.');
  toast('🔧 Infra crew repairing '+kindLabel(d.kind)+(d.street?(' @ '+d.street):''));
  saveLS();
  try{ Report.setSys('infracrew', sysReport()); }catch(e){}
}
/* removeJobColliders — pull every work-zone collider so no invisible walls
   linger after the crew leaves. */
function removeJobColliders(job){
  try{
    if (typeof removeCollider==='function'){
      if (job.truckCol) removeCollider(job.truckCol);
      (job.signCols||[]).forEach(function(c){ removeCollider(c); });
      (job.coneCols||[]).forEach(function(c){ removeCollider(c); });
    } else if (typeof colliders!=='undefined'){
      var doomed={};
      if (job.truckCol) doomed[colliders.indexOf(job.truckCol)]=1;
      (job.signCols||[]).forEach(function(c){ doomed[colliders.indexOf(c)]=1; });
      (job.coneCols||[]).forEach(function(c){ doomed[colliders.indexOf(c)]=1; });
      for (var i=colliders.length-1;i>=0;i--){ if (doomed[i]) colliders.splice(i,1); }
    }
  }catch(e){}
}
/* finishJob — end of the repair window: lay a permanent asphalt patch for
   road work, clean the work zone, mark fixed, record the report→fix
   duration (Joshua's rule), persist. */
function finishJob(job){
  var d=job.issue;
  if (d.kind==='road'){
    var nr=nearestRoad(d.x,d.z);
    var patch=makePatch(d.x, d.z, 18, 10, nr?roadHeadingAt(nr):0);
    scene.add(patch); IC.patchMeshes.push(patch);
  }
  removeJobColliders(job);
  scene.remove(job.group);
  d.state='fixed';
  d.fixedAt=Date.now();
  var durMs=d.reportedAt?(d.fixedAt-d.reportedAt):0;
  d.fixDurationMs=durMs;
  var durStr=durMs>0?(' (report→fix: '+Math.round(durMs/60000)+'m)'):'';
  dlog(d.id+' ('+d.street+') REPAIRED — '+kindLabel(d.kind)+' serviced per spec'+durStr+'. Crew clear.');
  toast('✅ '+kindLabel(d.kind)+' repaired'+(d.street?(' @ '+d.street):''));
  saveLS();
  try{ Report.setSys('infracrew', sysReport()); }catch(e){}
  try{ refreshPanel(); }catch(e){}
}
/* icFixTick(j, dt) — the legacy per-frame repair work: worker repair
   animation + amber light-bar flash. updateJobs calls this during the
   'fixing' phase for veteran jobs, or every frame for legacy jobs. */
function icFixTick(j, dt){
  j.workers.forEach(function(w,k){
    w.position.y+=Math.sin(IC.time*7+k*2.4)*0.012;
    w.rotation.y+=Math.sin(IC.time*1.3+k)*0.01;
    var a=w.userData.armR; if(a) a.rotation.x=Math.sin(IC.time*7+k)*0.7;
  });
  var bar=j.truck.userData.lightBar; if (bar) bar.visible=(IC.tick%14<7);
}
/* updateJobs(dt) — per-frame job ticks.
   v1.18 VETERAN CREW (Joshua 2026-10-09): jobs carrying vet state run the
   30-year-veteran phase machine (arrive → assess → report → setup → fix →
   verify). The legacy repair animation runs only during 'fixing'; when the
   machine returns 'done' the normal finishJob path runs (permanent patch,
   collider cleanup, localStorage persistence). Jobs without vet state keep
   the legacy timing. */
function updateJobs(dt){
  for (var i=IC.jobs.length-1;i>=0;i--){
    var j=IC.jobs[i];
    if (j.vet && typeof VeteranCrew!=='undefined'){
      var ph=VeteranCrew.updateJob(j, dt, {time:IC.time,
        log:function(m){ dlog(m); }, toast:function(m){ toast(m); }});
      if (ph==='fixing') icFixTick(j,dt);
      else if (ph==='done'){ finishJob(j); IC.jobs.splice(i,1); }
      continue;
    }
    j.t+=dt;
    icFixTick(j,dt);
    if (j.t>=j.dur){ finishJob(j); IC.jobs.splice(i,1); }
  }
}
/* intakeCheck — newly 'reported' issues get a crew after DISPATCH_T. */
function intakeCheck(dt){
  IC._acc=(IC._acc||0)+dt;
  if (IC._acc<1) return;
  IC._acc=0;
  for (var i=0;i<ISSUES.length;i++){
    var d=ISSUES[i];
    if (d.state!=='reported') continue;
    d._age=(d._age||0)+1;
    if (d._age>=DISPATCH_T){
      d.state='dispatched';
      dlog('Dispatch acknowledged '+d.id+' — infra crew rolling.');
      try{ dispatchCrew(d); }catch(e){
        d.state='reported'; d._age=0;
        try{ if(typeof Report!=='undefined') Report.noteError('infracrew','dispatch failed',String(e&&e.message||e)); }catch(x){}
      }
    }
  }
}
/* ---------------- HUD ---------------- */
function stateColor(s){
  return s==='fixed' ? '#51d651' :
         (s==='repairing'||s==='dispatched') ? '#ffb02e' : '#c9c9c9';
}
function buildUI(){
  if (IC.uiBuilt) return; IC.uiBuilt=true;
  try{
    var css=document.createElement('style');
    css.textContent=
      '#ic-btn{position:fixed;left:188px;top:8px;z-index:20;width:52px;height:52px;border-radius:12px;'+
      'border:2px solid #a8d800;background:rgba(20,24,34,.88);color:#a8d800;font-size:24px;}'+
      '@media (max-width:820px),(pointer:coarse){#ic-btn{left:128px!important;top:96px!important;bottom:auto!important;}}'+
      '#ic-panel{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);}'+
      '#ic-panel.show{display:flex;}'+
      '#ic-panel .card{background:#161b26;border-radius:14px;padding:20px 22px;max-width:470px;width:88%;max-height:74vh;display:flex;flex-direction:column;}'+
      '#ic-panel h3{margin:0 0 4px 0;color:#a8d800;}'+
      '#ic-panel .sub{color:#8a93a6;font-size:13px;margin-bottom:10px;}'+
      '#ic-list{overflow-y:auto;flex:1;min-height:80px;}'+
      '.ic-iss{margin:10px 0;padding:10px 12px;border-radius:10px;border:2px solid #444;background:#222836;color:#fff;font-size:14px;}'+
      '.ic-iss .iid{font-weight:bold;color:#a8d800;}'+
      '.ic-iss .st{float:right;font-weight:bold;}'+
      '.ic-iss .ds{color:#9fb2cc;font-size:13px;margin-top:6px;}'+
      '.ic-log{margin:6px 0;padding:6px 10px;font-size:13px;color:#c9c9c9;border-left:3px solid #a8d800;}'+
      '.ic-log .lt{color:#8a93a6;margin-right:8px;}'+
      '#ic-close{margin-top:12px;padding:10px 18px;font-size:15px;border-radius:10px;border:none;background:#a8d800;color:#111;font-weight:bold;width:100%;}';
    document.head.appendChild(css);
    var btn=document.createElement('button');
    btn.id='ic-btn'; btn.title='Infrastructure crew dispatch'; btn.innerHTML='🔧';
    btn.addEventListener('click', function(){ togglePanel(); });
    document.body.appendChild(btn);
    var panel=document.createElement('div');
    panel.id='ic-panel';
    panel.innerHTML='<div class="card"><h3>🔧 Infrastructure Crew</h3>'+
      '<div class="sub">Traffic lights · roads · signs — crew on duty 24/7</div>'+
      '<div id="ic-list"></div><button id="ic-close">Close</button></div>';
    document.body.appendChild(panel);
    document.getElementById('ic-close').addEventListener('click', function(){ togglePanel(false); });
  }catch(e){}
}
function refreshPanel(){
  if (!IC.uiBuilt) return;
  try{
    var el=document.getElementById('ic-list'); if(!el) return;
    var h='';
    ISSUES.forEach(function(d){
      var dur=d.fixDurationMs?(' · fixed in '+Math.round(d.fixDurationMs/60000)+'m'):'';
      h+='<div class="ic-iss"><span class="iid">'+d.id+'</span> ['+d.kind+'] '+d.street+
         '<span class="st" style="color:'+stateColor(d.state)+'">'+d.state.toUpperCase()+'</span><br>'+
         '<div class="ds">'+d.desc+dur+'</div></div>';
    });
    h+='<div class="sub" style="margin-top:8px">EVENT LOG</div>';
    var logs=IC.log.slice(-20).reverse();
    if (!logs.length) h+='<div class="ic-log">No events yet — crews are out.</div>';
    logs.forEach(function(e){
      h+='<div class="ic-log"><span class="lt">'+e.t+'</span>'+e.msg+'</div>';
    });
    el.innerHTML=h;
  }catch(e){}
}
function togglePanel(force){
  try{
    IC.panelOpen=(typeof force==='boolean')?force:!IC.panelOpen;
    var p=document.getElementById('ic-panel');
    if (p){ if(IC.panelOpen){ refreshPanel(); p.classList.add('show'); } else p.classList.remove('show'); }
  }catch(e){}
}
/* ---------------- main loop ---------------- */
function updateInfraCrew(dt){
  if (!IC.ready) return;
  try{
    IC.time+=dt; IC.tick++;
    updatePatrols(dt);
    updateJobs(dt);
    intakeCheck(dt);
    if (IC.tick%600===0){ try{ Report.setSys('infracrew', sysReport()); }catch(e){} }
  }catch(e){}
}
/* initInfraCrew — builds UI, spawns 2 patrol units, re-lays asphalt patches
   for road issues fixed in past sessions, wraps animate() (chains with other
   module wraps). */
function initInfraCrew(){
  loadLS();
  buildUI();
  /* patrol 1: downtown / I-20 corridor — signal-dense */
  spawnInfraPatrol(1, 4200, 2900);
  /* patrol 2: south sector — Fairburn / Riverdale */
  spawnInfraPatrol(2, 3500, 6500);
  /* re-lay patches for road issues already fixed in a past session */
  ISSUES.forEach(function(d){
    if (d.kind==='road' && d.state==='fixed'){
      var nr=nearestRoad(d.x,d.z);
      var patch=makePatch(d.x, d.z, 18, 10, nr?roadHeadingAt(nr):0);
      scene.add(patch); IC.patchMeshes.push(patch);
    }
  });
  if (!IC.log.length) dlog('Infrastructure crew online — 2 patrol units out, 24/7 operation. Signals, roads, signs.');
  IC.ready=true;
  try{ Report.setSys('infracrew', sysReport()); }catch(e){}
  /* PUBLIC API — this is how the sign inspectors, helicopter units, watcher
     feedback, stuck diagnostics, and the admin panel file issues. */
  window.INFRACREW={
    reportIssue:reportIssue,
    issues:ISSUES,
    log:IC.log,
    toggle:function(f){ togglePanel(f); }
  };
  /* hook into the frame loop — chains with other module wraps */
  try{
    if (typeof animate==='function' && !animate.__infracrewWrap){
      var orig=animate;
      var wrapped=function(){ orig(); updateInfraCrew(0.016); };
      wrapped.__infracrewWrap=true;
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
    try{ initInfraCrew(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('infracrew','init failed',String(e&&e.message||e)); }catch(x){}
    }
  } else if (bootTries>240){
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('infracrew','boot-timeout','deps never ready'); }catch(e){}
  }
},500);
})();
