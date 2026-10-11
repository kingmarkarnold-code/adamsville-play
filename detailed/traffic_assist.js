/* ============================================================================
   FILE: traffic_assist.js — traffic assistance & jam management
   ----------------------------------------------------------------------------
   JOSHUA'S TRAFFIC MANAGEMENT RULES (2026-10-10) — extends the v1.31
   no-drive-through-vehicles rule (vehicle_avoid.js):

   1. WAIT TIMEOUT: no vehicle waits forever. After WAIT_S seconds stuck
      behind a blocker, the vehicle radios for traffic assistance instead of
      sitting indefinitely. (60 real seconds ~= 11.6 game minutes, given
      Joshua's 24-game-hours = 124-real-minutes compression. Tunable.)

   2. TRAFFIC JAM DETECTION: when vehicles queue up behind a waiting vehicle
      (front vehicle + 2 or more backed up = JAM_QUEUE), the front vehicle
      radios for assistance.

   3. ASSISTANCE RESPONSE: a marked traffic-assist vehicle drives to the
      scene, parks with flashing red/blue lights (VISIBLE to the player —
      this is the point), and directs queued vehicles around the jam ONE AT
      A TIME. This INCLUDES the opposite lane of travel, but ONLY after the
      corridor check proves no oncoming traffic (no head-on collisions).
      Once the queue clears, normal traffic resumes.

   4. LANE RESPECT: vehicles stay in their lane during normal driving — the
      laneTarget snaps back to laneOffBase every frame unless a pass is
      active. The opposite lane is legal ONLY while assistPass is set by the
      directing assist unit, and the vehicle merges back when past.

   5. TOW: if the blocker itself hasn't moved for TOW_AFTER_S, assistance
      tows it — a stuck NPC car is guided to the shoulder (still on road,
      NEVER grass); anything else is just directed around. The player's van
      is NEVER towed.

   WHO CALLS THIS:
     - traffic_system.js  (stepCar)      — wait-timeout request + assistPass
       opposite-lane directed pass
     - marta_bus_system.js (updateBus)   — wait-timeout request (buses never
       overtake, but the queue behind them gets directed around)
     - schoolbus_system.js (updateBus)  — same as MARTA buses
     - semi_system.js     (stepSemi)     — wait-timeout request

   PERFORMANCE: tick() runs inside updateTraffic's wrapper. Per incident it
   does one small queue scan (bounded by TR.cars, early-outs on distance)
   and a handful of arithmetic ops. The assist vehicle is ONE extra mesh,
   culled beyond RENDER_DIST like everything else (Joshua's rule: invisible
   = data only). Incidents self-clean when resolved.
   ========================================================================== */
(function(){
'use strict';

/* ---------------- tunables ----------------
   WAIT_S: real seconds a vehicle waits before radioing for help.
   60s real ~= 11.6 game minutes (24 game hrs = 124 real min). A minute of
   real waiting feels long to the player; much shorter would spam assistance. */
var WAIT_S       = 60;
/* JAM_QUEUE: front vehicle + this many queued behind = traffic jam. */
var JAM_QUEUE    = 3;
/* QUEUE_DIST: how far behind the front vehicle to look for a queue (u). */
var QUEUE_DIST   = 35;
/* TOW_AFTER_S: blocker unmoved this long -> tow it to the shoulder. */
var TOW_AFTER_S  = 180;
/* ASSIST_SPEED: assist vehicle cruise speed (u/s). */
var ASSIST_SPEED = 22;
/* RENDER_DIST: assist vehicle mesh visible within this of the player (u).
   Matches Joshua's ~2-football-field culling rule. */
var RENDER_DIST  = 200;
/* DIRECT_STAGGER_S: seconds between directing each queued vehicle through. */
var DIRECT_STAGGER_S = 4;
/* DEDUP_R2: requests within this radius merge into one incident (u^2). */
var DEDUP_R2     = 40*40;

var incidents = [];
var incSeq = 0;

/* ---------------- small helpers ---------------- */
function hsin(yaw){ return Math.sin(yaw); }
function hcos(yaw){ return Math.cos(yaw); }
function px(){ try{ return player.x; }catch(e){ return 0; } }
function pz(){ try{ return player.z; }catch(e){ return 0; } }
function groundAt(x,z){
  var y = 0;
  try{ if (typeof clampVehY==='function') y = clampVehY(x,z,0); }catch(e){}
  try{ if (typeof groundY==='function' && !(y>0)) y = groundY(x,z); }catch(e){}
  return y;
}
function toast(msg, ms){
  try{ if (typeof showToast==='function') showToast(msg, ms||3500); }catch(e){}
}
function note(msg){
  try{ if (typeof Report!=='undefined' && Report && Report.note)
    Report.note('trafficassist', msg); }catch(e){}
}

/* ---------------- assist vehicle mesh ----------------
   makeAssistCar() — a marked traffic-assist car: white body, dark glass,
   red/blue light bar. Distinct from the orange road-crew trucks and from
   regular traffic. The flashing bar is the "assistance is here" signal
   Joshua asked to be visible. */
function makeAssistCar(){
  var g = new THREE.Group();
  function box(w,h,d,color,emissive){
    var m = new THREE.Mesh(
      new THREE.BoxGeometry(w,h,d),
      new THREE.MeshLambertMaterial({color:color, emissive:emissive||0x000000}));
    g.add(m); return m;
  }
  var body = box(2.2,0.65,4.6,0xf5f5f5); body.position.y = 0.62;
  var cab  = box(1.9,0.55,2.2,0x1a2430);  cab.position.set(0,1.15,-0.2);
  var stripe = box(2.24,0.22,4.62,0x14335c); stripe.position.y = 0.62;
  /* light bar: red left, blue right — flashing = assistance on scene */
  var rl = box(0.55,0.22,0.4,0xaa0000,0xff2222); rl.position.set(-0.45,1.55,0.1);
  var bl = box(0.55,0.22,0.4,0x0000aa,0x2255ff); bl.position.set( 0.45,1.55,0.1);
  g.userData.redLight = rl; g.userData.blueLight = bl;
  var wg = new THREE.CylinderGeometry(0.36,0.36,0.32,10); wg.rotateZ(Math.PI/2);
  var wm = new THREE.MeshLambertMaterial({color:0x141414});
  [[-1.0,1.5],[1.0,1.5],[-1.0,-1.5],[1.0,-1.5]].forEach(function(p){
    var w = new THREE.Mesh(wg,wm); w.position.set(p[0],0.36,p[1]); g.add(w);
  });
  g.visible = false;   // culled until the player is near (Joshua's rule)
  return g;
}

/* ---------------- queue scan ----------------
   queueBehind(x, z, yaw) — traffic cars queued behind (x,z) facing yaw.
   Returns array of car objects, front-most first. Bounded scan with
   early-outs; only TR.cars (buses/semis don't "queue" the same way). */
function queueBehind(x, z, yaw){
  var out = [], i, c, dx, dz, fwd, lat, align;
  var hx = hsin(yaw), hz = hcos(yaw);
  try{
    if (typeof TR==='undefined' || !TR || !TR.cars) return out;
    for (i=0;i<TR.cars.length;i++){
      c = TR.cars[i];
      dx = c.x - x; dz = c.z - z;
      if (dx*dx + dz*dz > QUEUE_DIST*QUEUE_DIST) continue;
      fwd = dx*hx + dz*hz;
      if (fwd > -2 || fwd < -QUEUE_DIST) continue;   // must be behind us
      lat = dx*hz - dz*hx;
      if (lat > 4 || lat < -4) continue;              // same lane corridor
      align = hsin(c.heading)*hx + hcos(c.heading)*hz;
      if (align < 0.7) continue;                     // same direction only
      out.push({c:c, back:-fwd});
    }
  }catch(e){}
  out.sort(function(a,b){ return a.back - b.back; });
  return out.map(function(e){ return e.c; });
}

/* ---------------- public: request ----------------
   request(v) — a waiting vehicle radios for traffic assistance.
   v = {x, z, yaw, ref, kind} where kind is 'traf'|'bus'|'school'|'semi'.
   Dedups: a second request within DEDUP_R2 joins the existing incident. */
function request(v){
  if (!v || !isFinite(v.x) || !isFinite(v.z)) return null;
  var i, inc;
  for (i=0;i<incidents.length;i++){
    inc = incidents[i];
    var dx = inc.x - v.x, dz = inc.z - v.z;
    if (dx*dx + dz*dz < DEDUP_R2){
      if (inc.queue.indexOf(v.ref) < 0 && v.kind==='traf') inc.queue.unshift(v.ref);
      return inc;
    }
  }
  /* identify the blocker so we can time its stillness for a tow */
  var blocker = null;
  try{
    if (window.VehicleAvoid)
      blocker = VehicleAvoid.blockedAhead(v.x, v.z, hsin(v.yaw), hcos(v.yaw),
                                          v.ref, 30, 1.2, false);
  }catch(e){}
  inc = {
    id: ++incSeq,
    x: v.x, z: v.z, yaw: v.yaw,
    requester: v.ref, reqKind: v.kind||'traf',
    blocker: blocker ? blocker.o : null,
    queue: (v.kind==='traf') ? [v.ref] : [],
    state: 'dispatched',   // dispatched -> onscene -> directing -> clearing -> done
    t: 0, stillT: 0, directT: 0, directedIdx: 0,
    assistVeh: null, stageX: 0, stageZ: 0, leaveX: 0, leaveZ: 0,
    towed: false
  };
  /* seed the queue with whoever is already backed up behind the requester */
  var q = queueBehind(v.x, v.z, v.yaw);
  for (i=0;i<q.length;i++) if (inc.queue.indexOf(q[i]) < 0) inc.queue.push(q[i]);
  spawnAssist(inc);
  incidents.push(inc);
  note('assist requested at ('+Math.round(v.x)+','+Math.round(v.z)+
       ') queue='+inc.queue.length+
       (blocker ? ' blocker='+blocker.o.kind : ' no-blocker-seen'));
  return inc;
}

/* spawnAssist(inc) — put the assist car on the road ~60u behind the jam and
   drive it to a staging point just past the jam, offset to the right
   shoulder side so it doesn't block the lane it's about to direct. */
function spawnAssist(inc){
  try{
    var hx = hsin(inc.yaw), hz = hcos(inc.yaw);
    var sx = inc.x - hx*60, sz = inc.z - hz*60;
    var mesh = makeAssistCar();
    mesh.position.set(sx, groundAt(sx,sz), sz);
    mesh.rotation.y = inc.yaw;
    if (typeof scene!=='undefined' && scene) scene.add(mesh);
    /* staging: past the jam, pulled right */
    inc.stageX = inc.x + hx*28 + hz*7;
    inc.stageZ = inc.z + hz*28 - hx*7;
    inc.leaveX = inc.stageX + hx*80;
    inc.leaveZ = inc.stageZ + hz*80;
    inc.assistVeh = { mesh:mesh, x:sx, z:sz, yaw:inc.yaw,
                      tx:inc.stageX, tz:inc.stageZ, arrived:false, flash:0 };
  }catch(e){ inc.assistVeh = null; }
}

/* driveAssist(a, dt) — simple kinematic drive toward (a.tx,a.tz); returns
   true on arrival. The trip is short (under ~100u on the same road), so a
   straight-line steer is fine — no pathfinding needed. */
function driveAssist(a, dt){
  var dx = a.tx - a.x, dz = a.tz - a.z;
  var d = Math.sqrt(dx*dx + dz*dz);
  if (d < 3){ a.arrived = true; return true; }
  var want = Math.atan2(dx, dz), dy = want - a.yaw;
  while (dy >  Math.PI) dy -= Math.PI*2;
  while (dy < -Math.PI) dy += Math.PI*2;
  a.yaw += Math.max(-2.2*dt, Math.min(2.2*dt, dy));
  var sp = Math.min(ASSIST_SPEED, Math.max(4, d*0.8));
  a.x += Math.sin(a.yaw)*sp*dt;
  a.z += Math.cos(a.yaw)*sp*dt;
  return false;
}

/* ---------------- public: oppositeLaneOff ----------------
   oppositeLaneOff(c, halfW) — the lane center mirrored across the road
   center (the oncoming lane). Returns null when it wouldn't fit on the
   asphalt. Called ONLY for assist-directed passes (assistPass) — never for
   normal driving. The caller MUST corridorClear() it first. */
function oppositeLaneOff(c, halfW){
  try{
    var opp = -((c.laneOffBase)||0);
    if (Math.abs(opp) > halfW - 1.7) return null;  // needs our half-width + margin
    return opp;
  }catch(e){ return null; }
}

/* ---------------- tow ----------------
   towBlocker(inc) — the blocker hasn't moved for TOW_AFTER_S. A stuck NPC
   traffic car gets guided to the shoulder (still on road, NEVER grass) and
   resumes; the player's van is NEVER towed. Anything else is directed
   around, not moved. */
function towBlocker(inc){
  var b = inc.blocker;
  if (!b || !b.ref || inc.towed) return;
  inc.towed = true;
  try{
    if (b.kind === 'traf'){
      var c = b.ref;
      /* guide to the shoulder: reuse the pass machinery, then resume */
      c.laneTarget = c.shoulderOff;
      c.passing = true; c.passT = 5.0;
      c.desired = Math.max(c.desired, 6);
      c.waitVehT = 0; c.assistReq = false;
      note('towed stuck car to shoulder at ('+Math.round(c.x)+','+Math.round(c.z)+')');
      toast('Traffic assistance towed a stalled car to the shoulder', 4000);
    } else {
      note('blocker kind='+b.kind+' not towable — directing around it');
    }
  }catch(e){}
}

/* ---------------- incident tick ---------------- */
function tickIncident(inc, dt){
  inc.t += dt;
  var i, c;

  /* refresh the queue: drop vehicles that drove off, re-scan behind */
  try{
    var hx = hsin(inc.yaw), hz = hcos(inc.yaw);
    var fresh = queueBehind(inc.x, inc.z, inc.yaw);
    var set = {};
    for (i=0;i<fresh.length;i++) set[fresh[i].id] = true;
    inc.queue = inc.queue.filter(function(qc){
      if (qc.assistDone) return false;
      return set[qc.id]===true;
    });
    for (i=0;i<fresh.length;i++)
      if (inc.queue.indexOf(fresh[i]) < 0) inc.queue.push(fresh[i]);
    /* keep the requester at the front if it's a traffic car still waiting */
    if (inc.reqKind==='traf' && inc.requester && !inc.requester.assistDone &&
        inc.queue.indexOf(inc.requester) < 0 &&
        inc.requester.blockedByVehicle) inc.queue.unshift(inc.requester);
  }catch(e){}

  /* blocker stillness -> tow */
  try{
    var bspd = (inc.blocker && inc.blocker.ref &&
                typeof inc.blocker.ref.speed==='number')
               ? Math.abs(inc.blocker.ref.speed) : 0;
    /* the player's van is never towed — the player will move on their own */
    var isPlayer = inc.blocker && inc.blocker.ref &&
                   typeof car!=='undefined' && inc.blocker.ref===car;
    if (!isPlayer && bspd < 0.5) inc.stillT += dt; else inc.stillT = 0;
    if (inc.stillT > TOW_AFTER_S) towBlocker(inc);
  }catch(e){}

  /* jam resolved? re-check whether the requester is still blocked */
  var stillBlocked = false;
  try{
    if (inc.requester && window.VehicleAvoid){
      var rx = inc.requester.x, rz = inc.requester.z;
      var ryaw = (typeof inc.requester.heading==='number') ? inc.requester.heading
               : (typeof inc.requester.yaw==='number') ? inc.requester.yaw : inc.yaw;
      var nb = VehicleAvoid.blockedAhead(rx, rz, hsin(ryaw), hcos(ryaw),
                                         inc.requester, 30, 1.2, false);
      stillBlocked = !!nb;
      /* if the blocker changed (old one towed/cleared), track the new one */
      if (nb && (!inc.blocker || nb.o.ref!==inc.blocker.ref)){
        inc.blocker = nb.o; inc.stillT = 0; inc.towed = false;
      }
    }
  }catch(e){}

  /* ---- state machine ---- */
  var a = inc.assistVeh;
  if (inc.state === 'dispatched'){
    if (a && driveAssist(a, dt)){
      inc.state = 'onscene'; inc.t = 0;
      var d2 = (a.x-px())*(a.x-px()) + (a.z-pz())*(a.z-pz());
      if (d2 < 150*150) toast('Traffic assistance on scene — directing vehicles around the jam', 4000);
      note('assist on scene, queue='+inc.queue.length);
    }
  } else if (inc.state === 'onscene'){
    if (inc.t > 2){ inc.state = 'directing'; inc.directT = 0; inc.directedIdx = 0; }
  } else if (inc.state === 'directing'){
    /* grant assistPass front-to-back, staggered so they go one at a time */
    inc.directT += dt;
    if (inc.directT >= DIRECT_STAGGER_S && inc.directedIdx < inc.queue.length){
      c = inc.queue[inc.directedIdx++];
      try{
        c.assistPass = true; c.waitVehT = 0;
        note('directing car id='+c.id+' around via opposite lane (if clear)');
      }catch(e){}
      inc.directT = 0;
    }
    var pending = inc.queue.filter(function(qc){ return !qc.assistDone; }).length;
    if ((!stillBlocked && pending===0) || inc.queue.length===0){
      inc.state = 'clearing';
      for (i=0;i<inc.queue.length;i++)
        try{ inc.queue[i].assistPass = false; }catch(e){}
      if (a){ a.tx = inc.leaveX; a.tz = inc.leaveZ; a.arrived = false; }
      note('jam cleared, assistance standing down');
    }
  } else if (inc.state === 'clearing'){
    if (a && driveAssist(a, dt)){
      /* drove off — remove the mesh and retire the incident */
      try{ if (typeof scene!=='undefined' && scene) scene.remove(a.mesh); }catch(e){}
      try{
        a.mesh.traverse(function(n){
          if (n.geometry) n.geometry.dispose();
        });
      }catch(e){}
      inc.assistVeh = null;
      inc.state = 'done';
    }
    /* safety: never leave an incident hanging */
    if (inc.t > 600) inc.state = 'done';
  }

  /* ---- assist vehicle visuals ---- */
  if (a && a.mesh){
    try{
      a.mesh.position.set(a.x, groundAt(a.x,a.z), a.z);
      a.mesh.rotation.y = a.yaw;
      /* flashing light bar while on scene/directing */
      a.flash += dt;
      var on = (inc.state==='onscene' || inc.state==='directing') &&
               (Math.floor(a.flash*4)%2===0);
      if (a.mesh.userData.redLight)
        a.mesh.userData.redLight.material.emissiveIntensity = on?2.2:0.25;
      if (a.mesh.userData.blueLight)
        a.mesh.userData.blueLight.material.emissiveIntensity = on?0.25:2.2;
      /* Joshua's culling rule: invisible = data only beyond RENDER_DIST */
      var pdx = a.x-px(), pdz = a.z-pz();
      a.mesh.visible = (pdx*pdx + pdz*pdz) < RENDER_DIST*RENDER_DIST;
    }catch(e){}
  }
}

function tick(dt){
  var i;
  for (i=incidents.length-1;i>=0;i--){
    try{ tickIncident(incidents[i], dt); }catch(e){}
    if (incidents[i].state==='done') incidents.splice(i,1);
  }
}

/* ---------------- self-install ----------------
   Wrap window.updateTraffic (the global the animate() wrapper re-reads every
   frame) so tick() runs with zero edits to traffic_system.js or index.html.
   Plain script tag — no __loadStep, so the launcher's step count is untouched
   (same pattern as vehicle_avoid.js). */
var bootTries = 0;
var bootTimer = setInterval(function(){
  bootTries++;
  try{
    /* v1.34 LAUNCHER SKIP (Joshua 2026-10-11): no traffic system, no assist. */
    if (window.__launchOpts && window.__launchOpts.traffic===false){ try{clearInterval(bootTimer);}catch(e){} return; }
    if (typeof window.updateTraffic==='function' && !window.updateTraffic.__assistWrap){
      var orig = window.updateTraffic;
      window.updateTraffic = function(dt, pxx, pzz){
        orig(dt, pxx, pzz);
        try{ tick(typeof dt==='number' ? dt : 0.016); }catch(e){}
      };
      window.updateTraffic.__assistWrap = true;
      clearInterval(bootTimer);
      note('TrafficAssist online: wait-timeout + jam response active');
    }
  }catch(e){}
  if (bootTries > 240) clearInterval(bootTimer);
}, 500);

window.TrafficAssist = {
  request: request,
  tick: tick,
  oppositeLaneOff: oppositeLaneOff,
  WAIT_S: WAIT_S,
  incidents: function(){ return incidents; }
};

})();
