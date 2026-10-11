/* ============================================================================
   FILE: police_system.js — "Surviving Adamsville" POLICE PATROL & TRAFFIC ASSIST
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-10 ~11:50pm EDT):
   Scale up the in-game police force to realistic Adamsville staffing AND give
   them more tasks — including the new traffic-assistance duty (directing
   traffic around blockages when a jam is radioed in).

   STAFFING MATH (researched 2026-10-10 — real numbers, not guesses):
     - Adamsville neighborhood population: ~2,400 (city-data) to ~4,300
       (areavibes); planning figure ~3,400 residents.
     - Atlanta PD: ~1,661 sworn officers for ~498,715 city residents
       = ~3.3 officers per 1,000 residents (department goal: 2,000).
       FBI national average for cities: ~2.2 per 1,000.
     - Adamsville is policed by APD Zone 4 (southwest Atlanta).
     - Adamsville's share at APD's actual rate: 3,400 x 3.3/1,000
       = ~11 officers assigned. APD runs 3 shifts -> ~4 on duty any hour.
     - Estimated registered vehicles in Adamsville: ~1,280 households
       (2.73 avg size) x ~1.5 vehicles = ~1,900 vehicles, plus through-traffic
       on I-285 / MLK / Fulton Industrial.
   JOSHUA'S OPERATIONAL REQUIREMENT (2026-10-10): the force must clear 2-3
   SIMULTANEOUS traffic jams IN PARALLEL — no jam ever sits waiting for an
   officer to free up — PLUS keep regular patrol coverage on the beats.
     ON-DUTY STRENGTH: 8 cruisers
       4 x patrol beats  — MLK corridor, Fulton Industrial corridor,
                          Cascade/Boulder Park, Dollar Mill/Bakers Ferry
       3 x traffic-assist responders — staged across Adamsville, ONE dedicated
                          unit per simultaneous jam (parallel response)
       1 x supervisor — roams all corridors, backs up a 4th jam if needed

   POLICE DUTIES:
     1. PATROL — cruise assigned beat roads (lane-respecting, right-lane),
        endpoint-hop onto connected roads like the road-crew patrols.
     2. TRAFFIC ASSIST — when a jam is radioed in, the nearest FREE assist
        unit drives to the scene (roads only — never grass), parks at the
        roadside with light bar flashing + takedown light on, and DIRECTS
        traffic until the jam clears (or a timeout), then returns to staging.
     3. INCIDENT RESPONSE — supervisor diverts to assist when all 3
        responders are committed.

   DISPATCH CONTRACT (for the traffic-jam system, built in parallel):
     The jam system radios for help by pushing onto EITHER:
       window.__trafficAssistRequests  (array of {id, x, z, t})
     or window.TrafficAssist.requests (same shape),
     or by calling window.POLICE.requestAssist(x, z) directly.
     A request is "cleared" when the jam system sets req.handled=true or
     removes it from the queue. Police mark req._pu while committed.

   VEHICLE RULES (Joshua's standing rules, applied to police too):
     - NO vehicle drives through another — police use VehicleAvoid.
       blockedAhead() and STOP for blockers; they pass on the left only when
       the asphalt is wide enough AND the escape corridor is pre-checked
       clear of oncoming traffic (same v1.31 rule as civilian traffic).
     - Lane respect: cruisers drive in the right-hand lanes, never the
       wrong way, never on grass.
     - Police ARE registered in VehicleAvoid.gather() (kind 'cop'), so
       civilian traffic, buses, and semis yield to THEM too.
   RENDER RULE (Joshua's 2-football-field rule): cruiser meshes render only
   within 200u of the player; beyond that they are pure data (position,
   state, assignment keep simulating). Light-bar flashers animate only when
   visible.

   ARCHITECTURE: standalone module, plain <script> tag after
   traffic_system.js (no __loadStep — boots itself when scene exists, like
   inspector_crew.js). Zero edits to other files' logic required, EXCEPT
   vehicle_avoid.js gains the 'cop' dimension + a gather() block (documented
   there). All hooks guarded — the game runs fine if this file is absent.

   PUBLIC API (window.POLICE):
     patrols        — the 8 unit records {x,z,heading,speed,state,role}
     requestAssist(x,z) — radio for traffic assistance; returns request id
     findRequest(id)    — look up a request across all channels
     units()        — snapshot [{no,role,state,x,z}] for HUD/debug
     version        — '1.0'
   ============================================================================ */
(function(){
'use strict';
if (window.__policeV1) return;          // never double-load
window.__policeV1 = true;

/* ---------------- local helpers (module-private) ---------------- */
function pclamp(v,a,b){ return v<a?a:(v>b?b:v); }
function pdist2(ax,az,bx,bz){ var dx=ax-bx,dz=az-bz; return dx*dx+dz*dz; }
function pgroundY(x,z){
  try{
    if (typeof groundRefY==='function'){ var y=groundRefY(x,z); return isFinite(y)?y:0; }
    var mh=(typeof terrainMeshY==='function')?terrainMeshY(x,z):-1e9;
    var yy=(mh>-1e8)?mh:heightAt(x,z);
    return isFinite(yy)?yy:0;
  }catch(e){ return 0; }
}
function ptoast(msg,ms){ try{ if(typeof showToast==='function') showToast(msg,ms||2600); }catch(e){} }

/* ---------------- tuning ---------------- */
var PATROL_SPEED   = 12;    // u/s — unhurried beat cruise
var RESPONSE_SPEED = 24;    // u/s — hustle to a jam (lights on)
var CULL_R2        = 200*200; // 2-football-field render rule (squared)
var ARRIVE_R2      = 45*45;   // "on scene" radius (squared)
var STAGE_R2       = 40*40;   // "back at staging" radius (squared)
var RESP_TIMEOUT   = 150;    // s — give up reaching a scene after this
var DIRECT_TIMEOUT = 240;    // s — max time directing one jam
var EP_CELL        = 120;    // endpoint grid cell (matches roadcrew)
var SNAP_R2        = 70*70;   // endpoint snap radius (matches traffic)

/* ---------------- state ---------------- */
var PC={
  units:[],        // the 8 cruisers
  epGrid:null,     // lazy endpoint grid over roadDrawData
  tick:0,
  internalQ:[],    // requests via window.POLICE.requestAssist()
  reqSeq:1
};

/* ---------------- endpoint grid (road-network hops) ---------------- */
/* Same pattern as roadcrew's rcBuildEP/rcFindConnection: lets a cruiser
   continue onto a CONNECTED road at a polyline end instead of bouncing. */
function pcBuildEP(){
  if (PC.epGrid) return PC.epGrid;
  var grid={};
  try{
    for (var i=0;i<roadDrawData.length;i++){
      var r=roadDrawData[i];
      if (!r||!r.pts||r.pts.length<2) continue;
      for (var e=0;e<2;e++){
        var p=r.pts[e===0?0:r.pts.length-1];
        var k=Math.floor(p[0]/EP_CELL)+','+Math.floor(p[1]/EP_CELL);
        (grid[k]=grid[k]||[]).push({ri:i,end:e,x:p[0],z:p[1]});
      }
    }
  }catch(e){}
  PC.epGrid={grid:grid};
  return PC.epGrid;
}
function pcFindConnection(x,z,selfSeg){
  pcBuildEP();
  var gx=Math.floor(x/EP_CELL), gz=Math.floor(z/EP_CELL);
  var best=null,bd=SNAP_R2;
  for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
    var a=PC.epGrid.grid[ix+','+iz]; if(!a) continue;
    for (var i=0;i<a.length;i++){
      var c=a[i], seg=null;
      try{ seg=roadDrawData[c.ri]; }catch(e){ continue; }
      if (!seg||seg===selfSeg||seg.pts.length<8) continue;
      var d2=pdist2(x,z,c.x,c.z);
      if (d2<bd){ bd=d2; best=c; }
    }
  }
  if (!best) return null;
  var pseg=null;
  try{ pseg=roadDrawData[best.ri]; }catch(e){ return null; }
  return {seg:pseg, idx:best.end===1?pseg.pts.length-1:0, end:best.end};
}

/* ---------------- road helpers ---------------- */
function pcRoadLen(r){
  var L=0;
  try{
    for (var i=1;i<r.pts.length;i++){
      var dx=r.pts[i][0]-r.pts[i-1][0], dz=r.pts[i][1]-r.pts[i-1][1];
      L+=Math.sqrt(dx*dx+dz*dz);
    }
  }catch(e){}
  return L;
}
/* findRoad(keywords) — longest roadDrawData road whose name matches any
   keyword. Assigns each patrol beat to its real corridor. */
function findRoad(keywords){
  var best=null,bl=0;
  try{
    for (var i=0;i<roadDrawData.length;i++){
      var r=roadDrawData[i];
      if (!r||!r.pts||r.pts.length<2) continue;
      var nm=(r.name||'').toLowerCase(), hit=false;
      for (var k=0;k<keywords.length;k++){
        if (nm.indexOf(keywords[k])>=0){ hit=true; break; }
      }
      if (!hit) continue;
      var L=pcRoadLen(r);
      if (L>bl){ bl=L; best=r; }
    }
  }catch(e){}
  return best;
}
/* nearestRoadPt(x,z) — closest roadDrawData point to (x,z). */
function nearestRoadPt(x,z){
  var best=null,bestD=1e18,bestI=0;
  try{
    for (var i=0;i<roadDrawData.length;i++){
      var r=roadDrawData[i];
      if (!r||!r.pts||r.pts.length<2) continue;
      for (var j=0;j<r.pts.length;j++){
        var p=r.pts[j], d=pdist2(x,z,p[0],p[1]);
        if (d<bestD){ bestD=d; best=r; bestI=j; }
      }
    }
  }catch(e){}
  return best?{seg:best,idx:bestI,dist:Math.sqrt(bestD)}:null;
}

/* ---------------- movement ---------------- */
/* cruiseAdvance(u,dt) — moves the unit along its polyline at u.speed;
   hops onto a connected road at ends, reverses at true dead ends. */
function cruiseAdvance(u,dt){
  var pts=u.seg.pts, n=pts.length;
  var ai=pclamp(Math.round(u.i),0,n-1), bi=pclamp(Math.round(u.i)+u.dir,0,n-1);
  var a=pts[ai], b=pts[bi];
  var dx=b[0]-a[0], dz=b[1]-a[1];
  var L=Math.sqrt(dx*dx+dz*dz)||1;
  u.i+=u.dir*(u.speed*dt)/L;
  var hit=false,which=0;
  if (u.i>=n-1){ u.i=n-1; hit=true; which=1; }
  else if (u.i<=0){ u.i=0; hit=true; which=0; }
  if (hit){
    var ep=pts[which===1?n-1:0], conn=null;
    try{ conn=pcFindConnection(ep[0],ep[1],u.seg); }catch(e){ conn=null; }
    if (conn){ u.seg=conn.seg; u.i=conn.idx; u.dir=conn.end===1?-1:1; return; }
    u.dir=which===1?-1:1;   // dead end — turn around
  }
}
/* poseUnit(u) — writes world position/heading from the polyline index,
   with a right-lane offset (lane respect — cruisers keep right, never the
   wrong way). Uses the (rx,rz)=(-hz,hx) "anatomical right" convention from
   VehicleAvoid.corridorClear. */
function poseUnit(u){
  var pts=u.seg.pts, n=pts.length;
  var t=u.i-Math.floor(u.i), i0=pclamp(Math.floor(u.i),0,n-2);
  var p=pts[i0], q=pts[i0+1];
  var hd=Math.atan2((q[0]-p[0])*u.dir,(q[1]-p[1])*u.dir);
  var hx=Math.sin(hd), hz=Math.cos(hd);
  var rx=-hz, rz=hx;                       // anatomical right of heading
  var x=p[0]+(q[0]-p[0])*t + rx*u.curOff;
  var z=p[1]+(q[1]-p[1])*t + rz*u.curOff;
  u.x=x; u.z=z; u.heading=hd;
  var y=pgroundY(x,z)+0.05;
  if (typeof clampVehY==='function'){ try{ y=clampVehY(x,z,y); }catch(e){} }
  u.mesh.position.set(x,y,z);
  u.mesh.rotation.y=hd;
}
/* chooseDirToward(u,dt,tx,tz) — greedy routing: every ~0.5s, walk the
   polyline ~150u ahead in each direction (distance-based, not index-based)
   and keep the direction whose lookahead lands closer to the target.
   Simple, road-bound, no pathfinding. */
function chooseDirToward(u,dt,tx,tz){
  u._rT=(u._rT||0)+dt;
  if (u._rT<=0.5) return;
  u._rT=0;
  var best=1e18,bd=u.dir;
  for (var d=-1;d<=1;d+=2){
    var px=u.x,pz=u.z,ii=u.i,travel=0;
    for (var s=0;s<40 && travel<150;s++){
      var pts=u.seg.pts,n=pts.length, ni=ii+d;
      if (ni<1||ni>n-1) break;
      var a=pts[pclamp(Math.round(ii),0,n-1)], b=pts[pclamp(Math.round(ni),0,n-1)];
      travel+=Math.sqrt(pdist2(a[0],a[1],b[0],b[1]));
      px=b[0]; pz=b[1]; ii=ni;
    }
    var dd=pdist2(px,pz,tx,tz);
    if (dd<best){ best=dd; bd=d; }
  }
  u.dir=bd;
}
/* directDrive(u,dt,tx,tz) — straight-line final approach toward a nearby
   target (within 150u). Used when the jam/scene sits just off the current
   polyline — e.g. 100u east on the cross street — where greedy polyline
   routing would drive past it. The unit temporarily leaves its polyline
   (sets u._offRoad so the next polyline leg re-snaps via ensureOnRoad).
   Vehicle respect still applies; the heading is the true travel direction. */
function directDrive(u,dt,tx,tz){
  var dx=tx-u.x, dz=tz-u.z;
  var L=Math.sqrt(dx*dx+dz*dz)||1;
  u.heading=Math.atan2(dx,dz);
  u._offRoad=true;
  var step=Math.min(u.speed*dt,L);
  u.x+=dx/L*step; u.z+=dz/L*step;
  u.curOff=0;
  var y=pgroundY(u.x,u.z)+0.05;
  if (typeof clampVehY==='function'){ try{ y=clampVehY(u.x,u.z,y); }catch(e){} }
  u.mesh.position.set(u.x,y,u.z);
  u.mesh.rotation.y=u.heading;
}
/* ensureOnRoad(u) — after a direct-drive leg, re-snap the unit to the
   nearest road polyline so polyline routing resumes from a sane index. */
function ensureOnRoad(u){
  if (!u._offRoad) return;
  u._offRoad=false;
  var nr=nearestRoadPt(u.x,u.z);
  if (nr){
    u.seg=nr.seg; u.i=pclamp(nr.idx,0,nr.seg.pts.length-1); u.dir=1;
    var w=nr.seg.w||10; u.baseOff=w/4;
  }
}

/* ---------------- vehicle respect ---------------- */
/* policeRespect(u,dt) — Joshua's no-drive-through rule applies to cruisers
   too. Stop for any vehicle ahead in our lane; ease around on the left ONLY
   when the asphalt is wide enough AND the escape corridor is pre-checked
   clear of oncoming traffic (mirrors traffic_system.js v1.31). Sets u._hold
   when the unit must stop this tick. Never leaves the road (no grass). */
function policeRespect(u,dt){
  u._hold=false;
  if (!window.VehicleAvoid) return;
  var hx=Math.sin(u.heading), hz=Math.cos(u.heading);
  try{
    var blk=window.VehicleAvoid.blockedAhead(u.x,u.z,hx,hz,u,26,1.1,false);
    if (blk && u.speed>0.5){
      var halfW=1.1, need=blk.o.halfW+halfW+0.9;
      var passOff=u.baseOff-need, roadHalf=(u.seg.w||10)/2;
      if (u.passT>0){
        u.passT-=dt;
        u.curOff+=(passOff-u.curOff)*Math.min(1,dt*4);
      } else if (passOff>=-(roadHalf-0.6) &&
          window.VehicleAvoid.corridorClear(u.x,u.z,hx,hz,passOff-u.curOff,
                                            blk.dist+12,u,halfW)){
        u.passT=2.5;                       // room on the asphalt: ease around
        u.curOff+=(passOff-u.curOff)*Math.min(1,dt*4);
      } else {
        u.passT=0;
        u.curOff+=(u.baseOff-u.curOff)*Math.min(1,dt*4);
        u._hold=true;                      // no room: STOP and wait
      }
    } else {
      u.passT=Math.max(0,(u.passT||0)-dt);
      var tgt=(u.passT>0)?u.baseOff:u.baseOff;
      u.curOff+=(tgt-u.curOff)*Math.min(1,dt*4);
    }
  }catch(e){}
}

/* ---------------- dispatch ---------------- */
/* collectRequests() — gather jam radio calls from every known channel:
   the sibling traffic-jam system's queue (either name), plus our own
   public requestAssist() queue. */
function collectRequests(){
  var out=[];
  try{
    var a=window.__trafficAssistRequests;
    if (a&&a.length) for (var i=0;i<a.length;i++) out.push(a[i]);
  }catch(e){}
  try{
    var b=window.TrafficAssist&&window.TrafficAssist.requests;
    if (b&&b.length) for (var j=0;j<b.length;j++) out.push(b[j]);
  }catch(e){}
  for (var k=0;k<PC.internalQ.length;k++) out.push(PC.internalQ[k]);
  return out;
}
/* nearestFreeAssist(x,z) — closest assist unit in standby/staging.
   Falls back to the supervisor (when it's supervising, not committed).
   Returns null when everyone is committed — the request simply stays
   queued, but with 3-4 responders Joshua's "no jam waits" rule holds for
   any realistic number of simultaneous jams. */
function nearestFreeAssist(x,z){
  var best=null,bd=1e18;
  for (var i=0;i<PC.units.length;i++){
    var u=PC.units[i];
    var ok=(u.role==='assist'&&(u.state==='standby'||u.state==='staging'))||
           (u.role==='supervisor'&&u.state==='supervise'&&!u.req);
    if (!ok) continue;
    var d=pdist2(u.x,u.z,x,z);
    if (d<bd){ bd=d; best=u; }
  }
  return best;
}
/* dispatchTick() — claim each unhandled request with the nearest free
   assist unit. 3 assist units = 3 simultaneous jams cleared IN PARALLEL. */
function dispatchTick(){
  var reqs=collectRequests();
  for (var i=0;i<reqs.length;i++){
    var req=reqs[i];
    if (!req||req.handled||req._pu) continue;
    var u=nearestFreeAssist(req.x,req.z);
    if (!u) continue;                       // all committed — stays queued
    req._pu=u;
    u.req=req; u.state='responding'; u.respT=0;
    ptoast('🚔 Unit '+u.no+' responding to traffic jam');
    try{ if (PC._log) PC._log.push('Unit '+u.no+' -> jam '+req.id); }catch(e){}
  }
}
function requestCleared(u){
  var req=u.req;
  if (!req) return true;
  if (req.handled) return true;
  // jam system removed it from every queue = cleared
  var reqs=collectRequests();
  for (var i=0;i<reqs.length;i++) if (reqs[i]===req) return false;
  return true;
}
function releaseUnit(u,markHandled){
  if (u.req&&markHandled){ try{ u.req.handled=true; }catch(e){} }
  if (u.req){ try{ u.req._pu=null; }catch(e){} }
  u.req=null;
  u.state=(u.role==='assist')?'returning':'supervise';
}

/* ---------------- per-unit tick ---------------- */
function unitTick(u,dt,px,pz){
  var m=u.mesh;
  /* --- state machine: decide desired speed + navigation target --- */
  u.speed=PATROL_SPEED;
  var tx=null,tz=null;   // navigation target when routing
  if (u.state==='responding'){
    u.respT+=dt; u.speed=RESPONSE_SPEED; tx=u.req.x; tz=u.req.z;
    if (requestCleared(u)){ releaseUnit(u,false); }
    else if (u.respT>RESP_TIMEOUT){ releaseUnit(u,false); } // another unit can try
  }
  else if (u.state==='directing'){
    u.dirT+=dt; u.speed=0;
    if (requestCleared(u)||u.dirT>DIRECT_TIMEOUT) releaseUnit(u,true);
  }
  else if (u.state==='returning'){ tx=u.stageX; tz=u.stageZ; }
  else if (u.state==='staging'||u.state==='standby'){
    u.speed=PATROL_SPEED*0.4;                 // slow presence cruise
    u.state='staging';
    if (pdist2(u.x,u.z,u.stageX,u.stageZ)>120*120){ tx=u.stageX; tz=u.stageZ; }
  }
  else { // 'patrol' / 'supervise'
    if (u.role==='supervisor'){
      u.speed=PATROL_SPEED*1.2; u.state='supervise';
      u._supT=(u._supT||0)+dt;
      if (u._supT>180){ u._supT=0; assignSupervisorBeat(u); }
    }
  }

  /* --- arrival checks (before moving) --- */
  if (u.state==='responding'&&tx!==null&&pdist2(u.x,u.z,tx,tz)<ARRIVE_R2){
    u.state='directing'; u.dirT=0; u.speed=0; tx=null;
    ensureOnRoad(u);
    ptoast('Unit '+u.no+' on scene - directing traffic');
  }
  else if (u.state==='returning'&&tx!==null&&pdist2(u.x,u.z,tx,tz)<STAGE_R2){
    u.state='staging'; tx=null;
    ensureOnRoad(u);
  }

  /* --- vehicle respect BEFORE moving (no driving through anything) --- */
  if (u.speed>0.5) policeRespect(u,dt); else u._hold=false;
  var move=u._hold?0:u.speed;

  /* --- single movement step: freeze when holding for traffic (no teleport,
         no drift); straight-line final approach when the target is close;
         polyline routing otherwise --- */
  var save=u.speed; u.speed=move;
  if (move<=0){
    /* holding for a blocker: stay exactly put */
  } else if (tx!==null&&pdist2(u.x,u.z,tx,tz)<150*150){
    directDrive(u,dt,tx,tz);
  } else {
    if (tx!==null){ ensureOnRoad(u); chooseDirToward(u,dt,tx,tz); }
    cruiseAdvance(u,dt);
    poseUnit(u);
  }
  u.speed=save;

  /* --- light bar: alternate red/blue while responding/directing --- */
  var active=(u.state==='responding'||u.state==='directing');
  var rb=m.userData.redBeacon, bb=m.userData.blueBeacon, tk=m.userData.takedown;
  if (rb&&bb){
    if (active){ var ph=Math.floor(PC.tick/4)%2; rb.visible=(ph===0); bb.visible=(ph===1); }
    else { rb.visible=false; bb.visible=false; }
  }
  if (tk) tk.visible=(u.state==='directing');

  /* --- 2-football-field render rule: data always simulates, mesh only
         renders near the player --- */
  var vis=true;
  try{ if (px!==null&&pz!==null) vis=pdist2(u.x,u.z,px,pz)<CULL_R2; }catch(e){}
  m.visible=vis;
}

/* ---------------- beats ---------------- */
var BEATS=[
  {kw:['martin luther king','mlk'],   label:'MLK corridor'},
  {kw:['fulton industrial'],          label:'Fulton Industrial'},
  {kw:['cascade','boulder park'],     label:'Cascade / Boulder Park'},
  {kw:['dollar mill','bakers ferry'], label:'Dollar Mill / Bakers Ferry'},
];
var STAGE_PTS=[ [3000,2900],[2900,4100],[5500,2900] ]; // assist staging areas
function assignSupervisorBeat(u){
  var b=BEATS[(Math.random()*BEATS.length)|0];
  var r=findRoad(b.kw);
  if (r){ u.seg=r; u.i=(r.pts.length/2)|0; u.dir=1; u.label=b.label; }
}

/* ---------------- spawn ---------------- */
function spawnUnit(no,role,beatIdx,sx,sz){
  var mesh=null;
  try{ mesh=policeCruiserMesh(); }catch(e){ return null; }
  var nr=nearestRoadPt(sx,sz);
  if (!nr) return null;
  var w=nr.seg.w||10;
  var u={
    no:no, role:role, mesh:mesh, seg:nr.seg,
    i:pclamp(nr.idx,0,nr.seg.pts.length-1), dir:1,
    x:0,z:0,heading:0,speed:0,
    baseOff:w/4, curOff:w/4, passT:0, _hold:false,
    state:(role==='assist')?'staging':'patrol',
    stageX:sx, stageZ:sz, req:null, respT:0, dirT:0, _rT:0, _supT:0,
    label:''
  };
  // patrol units start ON their beat road
  if (role==='patrol'&&beatIdx!==null){
    var r=findRoad(BEATS[beatIdx].kw);
    if (r){ u.seg=r; u.i=(r.pts.length/2)|0; w=r.w||10; u.baseOff=w/4; u.curOff=w/4; }
    u.label=BEATS[beatIdx].label;
  }
  if (role==='supervisor') assignSupervisorBeat(u);
  poseUnit(u);
  try{ scene.add(mesh); }catch(e){ return null; }
  PC.units.push(u);
  return u;
}

/* ---------------- main tick (chained into animate) ---------------- */
function tick(dt){
  PC.tick++;
  var px=null,pz=null;
  try{
    if (typeof player!=='undefined'&&player&&player.mesh&&player.mesh.position){
      px=player.mesh.position.x; pz=player.mesh.position.z;
    }
  }catch(e){}
  try{ dispatchTick(); }catch(e){}
  for (var i=0;i<PC.units.length;i++){
    try{ unitTick(PC.units[i],dt,px,pz); }catch(e){}
  }
  if (PC.tick%300===0){   // throttled HUD report
    try{
      if (typeof Report!=='undefined'&&Report.setSys){
        var st={};
        for (var j=0;j<PC.units.length;j++){
          var u=PC.units[j]; st['unit'+u.no]=u.role+':'+u.state;
        }
        Report.setSys('police',{status:'ok',version:'1.0',units:st});
      }
    }catch(e){}
  }
}

/* ---------------- boot ---------------- */
function boot(){
  try{
    if (!window.roadDrawData||!window.roadDrawData.length) return false;
  }catch(e){ return false; }
  PC._log=[];
  for (var b=0;b<4;b++) spawnUnit(b+1,'patrol',b,3000,2900);       // 4 beats
  for (var a=0;a<3;a++) spawnUnit(5+a,'assist',null,STAGE_PTS[a][0],STAGE_PTS[a][1]); // 3 responders
  spawnUnit(8,'supervisor',null,3500,3400);                          // 1 supervisor
  if (!PC.units.length) return false;
  try{ ptoast('🚔 APD Adamsville detail on duty — 8 cruisers'); }catch(e){}
  try{
    if (typeof animate==='function'&&!animate.__policeWrap){
      var orig=animate;
      var wrapped=function(){ orig(); tick(0.016); };
      wrapped.__policeWrap=true;
      animate=wrapped;
    }
  }catch(e){}
  try{
    if (typeof Report!=='undefined'&&Report.setSys)
      Report.setSys('police',{status:'ok',version:'1.0',
        note:'8 cruisers: 4 patrol beats + 3 traffic-assist + 1 supervisor'});
  }catch(e){}
  return true;
}
var _tries=0;
var _bootTimer=setInterval(function(){
  _tries++;
  try{
    if (typeof THREE!=='undefined'&&typeof scene!=='undefined'&&scene&&
        typeof policeCruiserMesh==='function'){
      if (boot()) clearInterval(_bootTimer);
      else if (_tries>60) clearInterval(_bootTimer);
    } else if (_tries>60){ clearInterval(_bootTimer); }
  }catch(e){}
},500);

/* ---------------- public API ---------------- */
window.POLICE={
  /* patrols — VehicleAvoid.gather() reads x/z/heading/speed off these so
     civilian traffic, buses, and semis yield to cruisers too. */
  patrols:PC.units,
  version:'1.0',
  /* requestAssist(x,z) — radio for traffic assistance. Returns a request
     id; clear it with POLICE.findRequest(id).handled=true (or remove it
     from your queue). */
  requestAssist:function(x,z){
    var req={id:'pa'+(PC.reqSeq++),x:x,z:z,t:Date.now(),handled:false,_pu:null};
    PC.internalQ.push(req);
    if (PC.internalQ.length>20) PC.internalQ.shift();
    return req.id;
  },
  findRequest:function(id){
    var all=collectRequests();
    for (var i=0;i<all.length;i++) if (all[i]&&all[i].id===id) return all[i];
    return null;
  },
  units:function(){
    return PC.units.map(function(u){
      return {no:u.no,role:u.role,state:u.state,
              x:Math.round(u.x),z:Math.round(u.z)};
    });
  }
};
})();
