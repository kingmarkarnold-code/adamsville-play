/* ============================================================================
   FILE: proto_maps.js — SEVERAL-MAPS PROTOTYPE (2026-10-25, Joshua's design)
   ----------------------------------------------------------------------------
   Joshua's idea, revived 2026-10-25 21:52 EDT and approved as a prototype
   22:13 EDT ("Prototype one split — Adamsville as its own map"): instead
   of ONE stitched world whose zones unlock, the world is SEPARATE MAPS.
   Only one map is loaded at a time. Roads that leave a map are GATES —
   crossing one loads the next map and places you at the matching gate
   on the other side.

   This prototype proves the feel with two real maps: ADAMSVILLE (the
   home map) and MABLETON (its western neighbour). The gate table
   (proto_gates_data.js) is derived from the live road data: every road
   crossing the shared border x = -832.1294, paired across it — 82 gate
   pairs, all matched exactly.

   WHAT THIS MODULE DOES:
   - Watches the player (on foot or driving). Standing on a gate road
     within reach of the border opens the TRANSITION SCREEN: it names
     the destination map and the road, and shows REAL progress while it
     prefetches that map's data files (the same files the next boot is
     about to load — so the progress is honest, and the boot that
     follows is cache-warm).
   - CONTINUE (one deliberate tap, the launch-flow rule's shape) writes
     the arrival through the game's own resume stash (ui_update_flow —
     player + car + driving state), tagged with the destination map,
     then loads that map (?zone=<dest>, a full separate map load).
     Arrival: on the paired road, just inside the destination map,
     facing along the road. The car comes with you if you were driving.
   - A per-map SESSION record (sessionStorage) remembers which gate
     you left each map by / arrived through — leaving and coming back
     puts you at the gate you crossed.
   - Cold-booting a map directly (no arrival stash) while the spawn
     lands outside it (e.g. the 535 spawn on the Mableton page) places
     you at the map's principal gate instead of in unbuilt space.

   PROTOTYPE SCOPE / DELIBERATE STUBS (see the notes file):
   - Only the Adamsville<->Mableton border has gates. Other borders
     are simply the edge of the world (the map wall).
   - GPS: patched in gps_system.js — a destination in another map
     routes to its gate, labelled "— gate to <Map>".
   - Traffic never leaves its own map (traffic_system.js patch).
   - Unlocks, save slots, home/van special cases: untouched live
     behaviour inside the loaded map; cross-map semantics are a
     full-conversion decision for Joshua, listed in the notes.

   The live game is NOT modified: this file exists only in proto-maps/.
   ============================================================================ */
(function(){
'use strict';

/* ---------------- data + map identity ---------------- */
var META = window.PROTO_META || {borderX:-832.1294014084006, zones:{}};
var GATES = window.PROTO_GATES || [];
var BX = META.borderX;
/* Zone rectangles (converted frame — same table zoneloader carries).
   Used for zoneOfPoint (GPS gate substitution + spawn checks). */
var RECTS = {
  'mableton':    {xMin:-7480.585387323972, xMax:-832.1294014084006,  zMin:-4248.536971831284, zMax:8266.53697183079},
  'adamsville':  {xMin:-832.1294014084006,  xMax:8377.129401408598,  zMin:-4248.536971831284, zMax:8266.53697183079},
  'downtown':    {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:-4248.536971831284, zMax:2555.720070422735},
  'eastatlanta': {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:2555.720070422735,  zMax:8266.53697183079},
  'unioncity':   {xMin:-7480.585387323972, xMax:-832.1294014084006, zMin:8266.53697183079,   zMax:30877.519366197153},
  'southfulton': {xMin:-832.1294014084006,  xMax:8377.129401408598,  zMin:8266.53697183079,   zMax:30877.519366197153},
  'riverdale':   {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:8266.53697183079,   zMax:30877.519366197153}
};
var NAMES = {adamsville:'Adamsville', mableton:'Mableton', downtown:'Downtown',
             eastatlanta:'East Atlanta', unioncity:'Union City',
             southfulton:'South Fulton', riverdale:'Riverdale'};
function currentMap(){
  try{
    var z = new URLSearchParams(window.location.search).get('zone');
    if (z && RECTS[z]) return z;
  }catch(e){}
  return 'adamsville';
}
var CUR = currentMap();
/* The only gate pair in the prototype. */
var PAIR = {adamsville:'mableton', mableton:'adamsville'};
var DEST = PAIR[CUR] || null;
function zoneOfPoint(x, z){
  for (var k in RECTS){
    var r = RECTS[k];
    if (x>=r.xMin && x<=r.xMax && z>=r.zMin && z<=r.zMax) return k;
  }
  return null;
}
function destName(id){ return NAMES[id] || id; }

/* ---------------- live state (also the test rig's window in) ---------------- */
var S = window.__protoState = {
  proto: true, map: CUR, destMap: DEST, gates: GATES.length,
  phase: 'idle',            // idle | prefetch | ready | error | navigating
  gateId: null, roadName: null,
  prefetchBytes: 0, prefetchTotal: 0, prefetchPct: 0,
  timing: {},               // triggerAt / prefetchDoneAt / continueAt (ms)
  arrivalApplied: null,     // 'stash' | 'fallback' | 'spawn-fix' | null
  session: null, lastError: null
};
function testlog(ev){
  try{
    var k = 'proto_maps_testlog';
    var a = JSON.parse(sessionStorage.getItem(k) || '[]');
    a.push({t: Date.now(), ev: ev});
    sessionStorage.setItem(k, JSON.stringify(a));
  }catch(e){}
}

/* ---------------- per-map session record ----------------
   sessionStorage — survives the map-to-map reload inside the tab,
   never touches the live game's localStorage saves. Shape:
   { exits: {fromMap: gateId}, visits: {map: {x,z,yaw,gateId,via}} } */
var SS_KEY = 'proto_maps_session_v1';
function sessionRead(){
  try{ return JSON.parse(sessionStorage.getItem(SS_KEY) || 'null') || {exits:{}, visits:{}}; }
  catch(e){ return {exits:{}, visits:{}}; }
}
function sessionWrite(s){
  try{ sessionStorage.setItem(SS_KEY, JSON.stringify(s)); }catch(e){}
  S.session = s;
}
S.session = sessionRead();

/* ---------------- geometry helpers ---------------- */
function distToPolyline(px, pz, pts){
  var best = Infinity, bx = 0, bz = 0;
  /* A one-point "corridor" measures to the point itself (a gate side
     whose road record ends AT the border used to return Infinity
     here, which silently disarmed that gate from that side). */
  if (pts.length === 1) return {d: Math.hypot(px - pts[0][0], pz - pts[0][1]), x: pts[0][0], z: pts[0][1]};
  for (var i = 0; i < pts.length; i++){
    if (i < pts.length - 1){
      var ax = pts[i][0], az = pts[i][1], cx = pts[i+1][0], cz = pts[i+1][1];
      var dx = cx - ax, dz = cz - az;
      var L2 = dx*dx + dz*dz;
      var t = L2 ? ((px - ax)*dx + (pz - az)*dz) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      var qx = ax + dx*t, qz = az + dz*t;
      var d = Math.hypot(px - qx, pz - qz);
      if (d < best){ best = d; bx = qx; bz = qz; }
    }
  }
  return {d: best, x: bx, z: bz};
}
/* Unit direction INTO the given map along the gate road at the border.
   dirE points east (into Adamsville); into Mableton is its opposite. */
function dirInto(gate, mapId){
  if (mapId === 'adamsville') return [gate.dirE[0], gate.dirE[1]];
  return [-gate.dirE[0], -gate.dirE[1]];
}
function gatePointIn(gate, mapId, dist){
  var d = dirInto(gate, mapId);
  return {x: BX + d[0]*dist, z: gate.z + d[1]*dist, dirX: d[0], dirZ: d[1]};
}
function gateById(id){
  for (var i = 0; i < GATES.length; i++) if (GATES[i].id === id) return GATES[i];
  return null;
}

/* ---------------- GPS hook: destination in another map -> its gate ------
   Called by the patched gps_system.js setDestination(). Returns a point
   just inside the CURRENT map on the gate road nearest the destination,
   with the label the GPS should announce. */
function gateForDestination(destZone, x, z){
  if (!DEST || destZone !== DEST) return null;   // only the paired map has gates
  var best = null, bestScore = Infinity;
  for (var i = 0; i < GATES.length; i++){
    var g = GATES[i];
    var p = gatePointIn(g, CUR, 14);
    var score = Math.hypot(p.x - x, p.z - z);
    if (score < bestScore){ bestScore = score; best = {g: g, p: p}; }
  }
  if (!best) return null;
  var road = (best.g.name && best.g.name !== 'Unnamed St') ? best.g.name : 'Border crossing';
  return {x: best.p.x, z: best.p.z, gateId: best.g.id,
          label: road + ' — gate to ' + destName(destZone)};
}

/* ---------------- player access (guarded, the game's own globals) ------- */
function playerPos(){
  try{
    if (typeof car !== 'undefined' && car && car.driving)
      return {x: car.x, z: car.z, driving: true};
    if (typeof player !== 'undefined' && player)
      return {x: player.x, z: player.z, driving: false};
  }catch(e){}
  return null;
}
function worldReady(){
  /* __gameStarted is the gate that matters: the bake can finish while
     the page still sits at the loader's START tap, and the resume
     stash is applied inside __tryStartGame — acting before it (an
     earlier build of this file did) mistook the unrestored spawn for
     a stranding and fired gates at a player who wasn't in the world
     yet. Nothing in this module moves until the game has started. */
  try{
    return window.__gameStarted === true &&
           typeof player !== 'undefined' && player && player.mesh &&
           window.__bakeState && __bakeState.total > 0 &&
           __bakeState.done >= __bakeState.total;
  }catch(e){ return false; }
}

/* ---------------- transition screen ----------------
   The game's own idiom: dark full-screen overlay, a named destination,
   a progress bar that fills as the destination map's data lands, then
   ONE deliberate Continue tap (the launch-flow rule's shape). */
var overlay = null, elBar = null, elPct = null, elStatus = null, elGo = null, elTitle = null, elSub = null;
function buildOverlay(){
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'proto-transition';
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(8,10,18,0.96);z-index:100000;' +
    'display:none;flex-direction:column;align-items:center;justify-content:center;' +
    'color:#fff;font-family:Arial,sans-serif;text-align:center;padding:24px;';
  overlay.innerHTML =
    '<div id="pt-title" style="font-size:30px;margin-bottom:8px;">🗺️ Entering </div>' +
    '<div id="pt-sub" style="font-size:16px;color:#9fb2bf;margin-bottom:26px;"></div>' +
    '<div style="width:min(520px,84vw);height:14px;background:#232a35;border-radius:7px;overflow:hidden;">' +
      '<div id="pt-bar" style="height:100%;width:0%;background:#57b25e;transition:width .15s;"></div></div>' +
    '<div id="pt-pct" style="margin-top:10px;font-size:14px;color:#cfe3cf;">0%</div>' +
    '<div id="pt-status" style="margin-top:6px;font-size:13px;color:#8fa3b0;">Loading map data…</div>' +
    '<div style="margin-top:30px;display:flex;gap:14px;">' +
      '<button id="pt-go" disabled style="font-size:17px;padding:12px 26px;border-radius:10px;border:0;' +
        'background:#3a4353;color:#aeb9c4;cursor:pointer;">Continue</button>' +
      '<button id="pt-cancel" style="font-size:17px;padding:12px 22px;border-radius:10px;border:1px solid #556;' +
        'background:transparent;color:#dfe7ee;cursor:pointer;">Stay here</button>' +
    '</div>' +
    '<div style="margin-top:22px;font-size:12px;color:#5f7182;">Several-maps prototype — this map will be left behind; only ' +
      'the destination map stays loaded.</div>';
  document.body.appendChild(overlay);
  elBar = overlay.querySelector('#pt-bar');
  elPct = overlay.querySelector('#pt-pct');
  elStatus = overlay.querySelector('#pt-status');
  elGo = overlay.querySelector('#pt-go');
  elTitle = overlay.querySelector('#pt-title');
  elSub = overlay.querySelector('#pt-sub');
  elGo.addEventListener('click', function(){ if (S.phase === 'ready') doTransition(); });
  overlay.querySelector('#pt-cancel').addEventListener('click', cancelTransition);
  return overlay;
}
function paintProgress(){
  var pct = S.prefetchTotal ? Math.min(100, Math.round(100 * S.prefetchBytes / S.prefetchTotal)) : 0;
  S.prefetchPct = pct;
  if (elBar) elBar.style.width = pct + '%';
  if (elPct) elPct.textContent = pct + '%';
}

/* ---------------- prefetch: the destination map's own data files --------
   The exact file list the next boot will load through zoneloader
   (zone/roads/signs/lifts/pins/buildings/hero_buildings), streamed so
   the progress bar reports real bytes. Warming the HTTP cache with
   them is also what makes the following map load fast. */
var ZONE_FILES = ['zone.json','roads.json','signs.json','lifts.json','pins.json','buildings.json','hero_buildings.json'];
function prefetch(dest, done){
  var sizes = (META.zones[dest] && META.zones[dest].files) || {};
  var total = 0, files = [];
  ZONE_FILES.forEach(function(f){
    if (sizes[f]){ files.push(f); total += sizes[f]; }
    else if (f !== 'hero_buildings.json'){ files.push(f); }  // unknown size: still fetch
  });
  S.prefetchBytes = 0; S.prefetchTotal = total; paintProgress();
  var chain = Promise.resolve();
  files.forEach(function(f){
    chain = chain.then(function(){
      return fetch('../detailed/zones/' + dest + '/' + f, {cache: 'force-cache'})
        .then(function(r){
          if (!r.ok){
            if (f === 'hero_buildings.json') return;      // optional (Mableton ships none)
            throw new Error(f + ' — HTTP ' + r.status);
          }
          if (!r.body || !r.body.getReader){ return r.arrayBuffer().then(function(b){ S.prefetchBytes += b.byteLength; paintProgress(); }); }
          var reader = r.body.getReader();
          function step(){
            return reader.read().then(function(res){
              if (res.done) return;
              S.prefetchBytes += res.value.byteLength; paintProgress();
              return step();
            });
          }
          return step();
        });
    });
  });
  chain.then(function(){ done(null); }, function(err){ done(err); });
}

/* ---------------- the crossing itself ---------------- */
var activeGate = null, suppressedGate = null, suppressUntil = 0;
function beginTransition(gate){
  if (S.phase !== 'idle' || !DEST) return;
  activeGate = gate;
  S.phase = 'prefetch'; S.gateId = gate.id; S.roadName = gate.name;
  S.timing.triggerAt = Date.now();
  buildOverlay();
  elTitle.textContent = '🗺️ Entering ' + destName(DEST);
  elSub.textContent = 'via ' + (gate.name !== 'Unnamed St' ? gate.name : 'a border crossing') +
                    ' — leaving ' + destName(CUR) + ' behind';
  elStatus.textContent = 'Loading ' + destName(DEST) + ' map data…';
  elGo.disabled = true;
  elGo.textContent = 'Continue to ' + destName(DEST);
  elGo.style.background = '#3a4353'; elGo.style.color = '#aeb9c4';
  overlay.style.display = 'flex';
  testlog('transition-begin:' + gate.id + ':' + CUR + '>' + DEST);
  /* Still the car so it doesn't roll away behind the screen. */
  try{ if (typeof car !== 'undefined' && car && car.driving) car.speed = 0; }catch(e){}
  prefetch(DEST, function(err){
    if (S.phase !== 'prefetch') return;   // cancelled meanwhile
    if (err){
      S.phase = 'error'; S.lastError = String(err && err.message || err);
      elStatus.textContent = '⚠ ' + S.lastError + ' — the map did not load. You can stay here and try again.';
      testlog('transition-error:' + S.lastError);
      return;
    }
    S.phase = 'ready'; S.timing.prefetchDoneAt = Date.now();
    elStatus.textContent = destName(DEST) + ' is ready.';
    elGo.disabled = false;
    elGo.style.background = '#57b25e'; elGo.style.color = '#fff';
    testlog('transition-ready:' + gate.id);
  });
}
function cancelTransition(){
  if (overlay) overlay.style.display = 'none';
  if (activeGate){ suppressedGate = activeGate.id; suppressUntil = Date.now() + 9000; }
  S.phase = 'idle'; activeGate = null;
  testlog('transition-cancel');
}
function doTransition(){
  var gate = activeGate; if (!gate || !DEST) return;
  S.phase = 'navigating'; S.timing.continueAt = Date.now();
  testlog('transition-continue:' + gate.id);
  var arr = gatePointIn(gate, DEST, 26);           // just inside the destination, on the road
  var yaw = Math.atan2(arr.dirX, arr.dirZ);        // facing along the road, into the map
  var pos = playerPos();
  var driving = !!(pos && pos.driving);
  try{
    if (typeof car !== 'undefined' && car){
      if (driving){
        car.x = arr.x; car.z = arr.z; car.yaw = yaw; car.speed = 0;
      } else {
        /* PROTOTYPE CHOICE: crossing on foot brings your car along,
           parked just off the arrival point — otherwise the resume
           stash would seat it at its origin-map coordinates, which are
           unbuilt space on this side. (Full conversion must decide
           per-map vehicle persistence properly; see the notes.) */
        car.x = arr.x - arr.dirZ * 7; car.z = arr.z + arr.dirX * 7; car.yaw = yaw; car.speed = 0;
      }
    }
    if (typeof player !== 'undefined' && player){
      player.x = arr.x; player.z = arr.z; player.yaw = yaw; player.speed = 0;
    }
  }catch(e){}
  /* Per-map session record: the gate this map was left by, and the
     arrival the next map should show for this visit. */
  var sess = sessionRead();
  sess.exits[CUR] = gate.id;
  sess.visits[DEST] = {x: Math.round(arr.x*10)/10, z: Math.round(arr.z*10)/10,
                       yaw: Math.round(yaw*1000)/1000, gateId: gate.id, via: CUR};
  sessionWrite(sess);
  /* The game's own resume stash carries player + car + driving state
     into the next map's boot (tagged with the DESTINATION map so the
     boot restore accepts it). Fallback: our own session arrival,
     applied by bootDuties() if the stash didn't land. */
  var stashed = false;
  try{
    if (window.UIUpdateFlow && UIUpdateFlow.writeStash){
      stashed = UIUpdateFlow.writeStash({zone: DEST,
        toast: '🗺️ ' + destName(DEST) + ' — its world is loaded around you. (entered via ' +
               (gate.name !== 'Unnamed St' ? gate.name : 'a border crossing') + ')'});
    }
  }catch(e){}
  if (!stashed){
    try{ sessionStorage.setItem('proto_maps_arrival_v1', JSON.stringify(
      {map: DEST, x: arr.x, z: arr.z, yaw: yaw, driving: driving, gateId: gate.id})); }catch(e){}
  }
  var url = new URL(window.location.href);
  url.searchParams.set('zone', DEST);
  window.location.href = url.toString();
}
/* Safety net for zoneloader.transitionTo (patched to call this): a
   border crossing that somehow bypassed the gates still lands at the
   nearest gate on the other side, never in unbuilt space. */
function legacyTransition(zoneId){
  if (!PAIR[zoneId] && zoneId !== DEST) return;
  var pos = playerPos(); if (!pos) return;
  var best = null, bd = Infinity;
  GATES.forEach(function(g){
    var d = Math.abs(g.z - pos.z);
    if (d < bd){ bd = d; best = g; }
  });
  if (best){ DEST = zoneId; beginTransition(best); }
}

/* ---------------- gate trigger loop ----------------
   On a gate road + within reach of the border = at the gate. The
   corridor test uses the road's own points (proto_gates_data.js), so
   border-parallel streets and open ground never trigger.
   ARRIVAL SUPPRESSION: you ARRIVE standing in a gate corridor (that
   is the point of a gate), so after any arrival the gates stay quiet
   until you have actually left that gate's area — otherwise arriving
   would instantly offer the trip back (an earlier build did exactly
   that). */
var suppressGateId = null;
function armSuppression(gateId){ if (gateId) suppressGateId = gateId; }
function gateCheck(){
  if (S.phase !== 'idle' || !DEST || !worldReady()) return;
  var pos = playerPos(); if (!pos) return;
  if (suppressGateId){
    var sg = gateById(suppressGateId);
    if (sg){
      var spts = (CUR === 'adamsville') ? sg.aPts : sg.mPts;
      var sd = distToPolyline(pos.x, pos.z, spts).d;
      if (sd < sg.w / 2 + 70 && Math.abs(pos.x - BX) < 200) return;  // still in the arrival area
    }
    suppressGateId = null;   // left the area — gates are live again
  }
  if (Math.abs(pos.x - BX) > 120) return;                       // nowhere near the border
  if (suppressedGate && Date.now() > suppressUntil) suppressedGate = null;
  var best = null, bestD = Infinity;
  for (var i = 0; i < GATES.length; i++){
    var g = GATES[i];
    if (g.id === suppressedGate) continue;
    if (Math.abs(pos.z - g.z) > 200) continue;
    var pts = (CUR === 'adamsville') ? g.aPts : g.mPts;
    var r = distToPolyline(pos.x, pos.z, pts);
    var reach = g.w / 2 + 9;
    if (r.d < reach && r.d < bestD){ bestD = r.d; best = g; }
  }
  if (best) beginTransition(best);
}

/* ---------------- boot duties ----------------
   1. Fallback arrival (only if the resume stash didn't carry us).
   2. Spawn fix: a cold boot whose spawn lands OUTSIDE the loaded map
      (the 535 spawn on the Mableton page) is placed at the principal
      gate (Mableton Parkway) instead of unbuilt space.
   3. The prototype badge. */
var bootDone = false;
function bootDuties(){
  if (bootDone || !worldReady()) return;
  /* Resume-stash self-drive: if the stash that carried us here is
     still sitting unconsumed, the start sequence raced past it (the
     flow module can execute after the game has already started on a
     slow load, and the guarded restore call at start then silently
     skips). Drive the flow's own restore from here — it consumes the
     stash itself, so this can never double-apply. While the module
     isn't up yet, keep waiting WITHOUT latching bootDone. */
  var stashRaw = null;
  try{ stashRaw = localStorage.getItem('sa_ui_update_resume'); }catch(e){}
  if (stashRaw){
    var sj = null; try{ sj = JSON.parse(stashRaw); }catch(e){}
    if (sj && sj.zone === CUR && typeof sj.t === 'number' && (Date.now() - sj.t) < 10 * 60 * 1000){
      if (window.UIUpdateFlow && UIUpdateFlow.maybeRestore){
        var applied = false;
        try{ applied = !!UIUpdateFlow.maybeRestore(); }catch(e){}
        if (applied){
          bootDone = true;
          var sv = sessionRead();
          S.arrivalApplied = 'stash';
          armSuppression(sv.visits && sv.visits[CUR] ? sv.visits[CUR].gateId : null);
          testlog('arrival:stash-late');
          finishBootBadge();
          return;
        }
        /* the flow discarded the stash itself — fall through */
      } else {
        return;   /* module not up yet — retry next tick */
      }
    }
  }
  bootDone = true;
  var pos = playerPos(); if (!pos) return;
  try{
    var fb = JSON.parse(sessionStorage.getItem('proto_maps_arrival_v1') || 'null');
    if (fb && fb.map === CUR){
      sessionStorage.removeItem('proto_maps_arrival_v1');
      if (typeof player !== 'undefined' && player){
        player.x = fb.x; player.z = fb.z; player.yaw = fb.yaw;
        if (player.mesh){ player.mesh.position.set(fb.x, player.mesh.position.y, fb.z); player.mesh.rotation.y = fb.yaw; }
      }
      if (fb.driving && typeof car !== 'undefined' && car){
        car.x = fb.x; car.z = fb.z; car.yaw = fb.yaw;
      }
      S.arrivalApplied = 'fallback';
      armSuppression(fb.gateId);
      testlog('arrival:fallback:' + fb.gateId);
      return;
    }
  }catch(e){}
  var r = RECTS[CUR];
  if (pos.x < r.xMin || pos.x > r.xMax || pos.z < r.zMin || pos.z > r.zMax){
    var g = gateById('g26') || GATES[0];
    var arr = gatePointIn(g, CUR, 26);
    var yaw = Math.atan2(arr.dirX, arr.dirZ);
    try{
      if (typeof player !== 'undefined' && player){
        player.x = arr.x; player.z = arr.z; player.yaw = yaw;
        if (player.mesh){ player.mesh.position.set(arr.x, player.mesh.position.y, arr.z); player.mesh.rotation.y = yaw; }
      }
    }catch(e){}
    S.arrivalApplied = 'spawn-fix';
    armSuppression(g.id);
    testlog('arrival:spawn-fix:' + g.id);
  } else {
    /* Inside the map after a gate crossing = the resume stash landed. */
    var sess = sessionRead();
    if (sess.visits && sess.visits[CUR] && Math.abs(pos.x - BX) < 400){
      S.arrivalApplied = 'stash';
      armSuppression(sess.visits[CUR].gateId);
      testlog('arrival:stash:' + sess.visits[CUR].gateId);
    }
  }
  finishBootBadge();
}
/* Badge: which map am I in, and that this is the prototype. */
function finishBootBadge(){
  if (document.getElementById('proto-badge')) return;
  try{
    var b = document.createElement('div');
    b.id = 'proto-badge';
    b.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99990;background:rgba(10,14,20,.82);' +
      'color:#dfe7ee;font:13px Arial,sans-serif;padding:7px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.18);';
    b.textContent = '🧪 Several-maps prototype · Map: ' + destName(CUR) + ' · ' + GATES.length + ' gates to ' + (DEST ? destName(DEST) : '—');
    document.body.appendChild(b);
  }catch(e){}
}

/* ---------------- autotest hooks (rig only; ?protoautotest=1) ---------- */
var AUTOTEST = false;
try{ AUTOTEST = new URLSearchParams(window.location.search).get('protoautotest') === '1'; }catch(e){}
if (AUTOTEST){
  var walkTimer = null;
  window.__protoTest = {
    /* Stand on the gate road, `dist` units inside the current map, facing the border. */
    gotoRoad: function(gateId, dist){
      var g = gateById(gateId); if (!g) return false;
      var p = gatePointIn(g, CUR, dist || 130);
      var yaw = Math.atan2(-p.dirX, -p.dirZ);   // face back toward the border
      if (typeof player !== 'undefined' && player){
        player.x = p.x; player.z = p.z; player.yaw = yaw; player.speed = 0;
        if (player.mesh){ player.mesh.position.set(p.x, player.mesh.position.y, p.z); player.mesh.rotation.y = yaw; }
      }
      testlog('test:gotoRoad:' + gateId);
      return {x: p.x, z: p.z};
    },
    /* Walk (or drive) toward the border along the road until the gate fires. */
    advance: function(gateId, driving){
      var g = gateById(gateId); if (!g) return false;
      var into = dirInto(g, CUR, 0);           // direction of travel = OUT of current map
      var outDir = [-into[0], -into[1]];
      var yaw = Math.atan2(outDir[0], outDir[1]);
      if (walkTimer) clearInterval(walkTimer);
      var step = driving ? 1.6 : 0.7;          // per 100ms tick: 16 u/s driving, 7 u/s walking
      walkTimer = setInterval(function(){
        try{
          if (S.phase !== 'idle'){ clearInterval(walkTimer); walkTimer = null; return; }
          if (driving && typeof car !== 'undefined' && car){
            car.x += outDir[0] * step; car.z += outDir[1] * step; car.yaw = yaw;
            if (typeof player !== 'undefined' && player){ player.x = car.x; player.z = car.z; player.yaw = yaw; player.speed = 16; }
          } else if (typeof player !== 'undefined' && player){
            player.x += outDir[0] * step; player.z += outDir[1] * step; player.yaw = yaw; player.speed = 7;
            if (player.mesh){ player.mesh.position.set(player.x, player.mesh.position.y, player.z); player.mesh.rotation.y = yaw; }
          }
        }catch(e){}
      }, 100);
      testlog('test:advance:' + gateId + (driving ? ':driving' : ':foot'));
      return true;
    },
    /* Get into the hero car (the stash pattern from ui_update_flow.applyStash). */
    enterCar: function(){
      try{
        if (typeof cars !== 'undefined' && cars && cars.length){
          var c = (typeof car !== 'undefined' && car) || cars[0];
          var pos = playerPos(); if (!pos) return false;
          c.x = pos.x; c.z = pos.z; c.yaw = (typeof player !== 'undefined' && player) ? player.yaw : 0;
          if (c.mesh){ c.mesh.position.set(c.x, c.mesh.position.y, c.z); c.mesh.rotation.y = c.yaw; }
          try{ car = c; }catch(e){}
          c.driving = true;
          if (typeof setDrivingUI === 'function') setDrivingUI(true);
          if (typeof player !== 'undefined' && player && player.mesh) player.mesh.visible = false;
          testlog('test:enterCar');
          return true;
        }
      }catch(e){}
      return false;
    },
    confirm: function(){
      if (S.phase === 'ready'){ doTransition(); return true; }
      return false;
    },
    state: function(){ return S; }
  };
}

/* ---------------- go ---------------- */
window.PROTO_MAPS = {
  zoneOfPoint: zoneOfPoint,
  gateForDestination: gateForDestination,
  legacyTransition: legacyTransition,
  state: S
};
setInterval(function(){ bootDuties(); gateCheck(); }, 150);
testlog('boot:' + CUR);
})();
