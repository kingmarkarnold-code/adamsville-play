/* ============================================================================
   FILE: stuck_diag.js — "Surviving Adamsville" stuck-loop ROOT-CAUSE diagnostics
   ----------------------------------------------------------------------------
   PURPOSE: Joshua's mandate (2026-10-09): when a vehicle gets stuck in a
   loop, DO NOT just force it to continue. Investigate WHY, log the suspected
   cause, and fix the DATA (pins, terrain, road geometry) — not just the
   behavior.

   RELATIONSHIP TO stuck.js v1.14: the shared StuckDetector already diagnoses
   SEGMENT-SHAPE problems (SEGMENT_LOOP, SHORT_SEGMENT, SHARP_TURN via
   setSegment/getDiagnosis) and tracks in-memory hotspots. This module is the
   COMPLEMENT — it runs the checks v1.14 does NOT do:
     (1) junction pins    — misaligned / strong height pull near the spot
     (2) ground/terrain    — rough ground (bumps, dips, cliffs)
     (3) elevation         — road ribbon floats above / sinks below terrain
     (4) road clipping     — vehicle sank THROUGH the road surface
     (5) colliders         — invisible blocker sitting on the path
   ...plus a PERSISTENT bad-spot registry (localStorage — the system LEARNS
   across sessions, v1.14's hotspots are memory-only).

   v1.16 (Joshua's directive, 2026-10-09): ROUTING AVOIDANCE IS REMOVED.
   When a vehicle gets stuck it does NOT reroute around the bad spot — it
   PULLS OVER to the road shoulder and WAITS PATIENTLY until the data team
   fixes the problem. The registry now tracks fix times (report → fix
   duration) so the dev team can document how long each repair took, and
   waiting units are released only after the fix is confirmed (manual
   StuckDiag.markFixed() or the periodic auto-recheck).

   WHAT IT DOES:
     1. diagnose(x, z, unit) — merges the v1.14 segment diagnosis (when the
        unit has one) with the 5 data checks above; returns the strongest
        finding: {cause, causeLabel, detail, findings, x, z, road, t}.
     2. record(diag) — the bad-spot registry. Repeat stuck events at the same
        place (within 50u) increment a counter; 3+ events flags the spot for
        DATA REPAIR. Each spot tracks reportT/fixT so fix durations are
        documented. Persisted to localStorage so it survives restarts.
     3. isBadSpot(x, z) — DEPRECATED v1.16: always returns false. Joshua
        forbade auto-avoidance; kept so old callers don't throw.
     4. waitForFix(x, z, unit, unitLabel, logFn) — parks the unit on the
        road shoulder, sets u.waitingForFix, registers the unit on the spot.
     5. waitTick(u, dt, logFn) — called per-frame while waiting; every
        WAIT_RECHECK_S seconds re-runs the diagnosis and auto-releases the
        unit if the data no longer shows an anomaly.
     6. markFixed(x, z, by) — the data team calls this when the road data is
        repaired: records fix time + duration, releases waiting units.
     7. suspectCause(x, z, unit) — diagnose + record in one call (what the
        traffic audit uses).
     8. badSpots() / waitingSummary() — registry snapshots for the admin
        panel / Report.

   WIRING (all hooks guarded — a missing stuck_diag.js changes nothing):
     - stuck.js recoverStuckUnit(): calls waitForFix() — the unit pulls over
       and waits; NO reassignment, NO bad-spot skipping (v1.16).
     - roadcrew_system.js / codeenforce_system.js updatePatrol(): when
       u.waitingForFix is set, skip all movement and call waitTick().
     - traffic_system.js logStuck(): attaches the data-cause diagnosis to the
       stuck spot in Joshua's live road audit.

   STANDALONE MODULE. Include AFTER stuck.js:
       <script src="stuck.js"></script>
       <script src="stuck_diag.js"></script>
   Every global it touches (roadDrawData, JUNCTION_PINS, heightAt, colliders,
   localStorage) is accessed lazily inside functions and guarded, so load
   order is forgiving.
   ============================================================================ */
(function(){
'use strict';
if (window.StuckDiag) return;   // singleton — never double-install

/* ---------------- tuning ---------------- */
var PIN_SEARCH_R   = 100;  // junction-pin search radius (u)
var PIN_DH_BAD     = 1.0;  // |dh| at/above this = suspicious height pull (u)
var TERR_R         = 10;   // terrain roughness sample radius (u)
var TERR_VAR_BAD   = 4.0;  // height variance above this (u^2) = rough ground
var TURN_BAD_DEG   = 150;  // fallback turn-angle check (v1.14 uses 90° w/ setSegment)
var ELEV_BAD       = 3.0;  // road-ribbon vs terrain above this (u) = bad data
var COLLIDER_R     = 15;   // collider search radius (u)
var CLIP_TOL       = 1.5;  // vehicle this far BELOW terrain = drove through road
var SPOT_DEDUP_R2  = 2500; // 50u^2 — same-place dedup for the registry
var SPOT_FLAG_N    = 3;    // events at/above this = flagged for DATA REPAIR
var SPOT_MAX       = 100;  // cap stored spots (oldest unflagged evicted first)
var LS_KEY         = 'sa_badspots_v1';
/* v1.16 wait-for-fix tuning (Joshua's directive, 2026-10-09): a stuck unit
   pulls over instead of rerouting. */
var WAIT_OFFSET    = 8;    // shoulder pull-over distance from road center (u)
var WAIT_RECHECK_S = 300;  // re-diagnose every 5 min while waiting (auto-release
                           // if the data no longer shows an anomaly)

/* Cause severity — highest wins when several checks fire. v1.14's segment
   causes are mapped in so the merge picks the most actionable finding. */
var SEV_ORDER = ['collider-block','stub-segment','seg-loop','sharp-turn',
                 'road-clip','road-elevation','pin-pull','rough-terrain',
                 'pos-loop','oscillation','unknown'];
var CAUSE_LABELS = {
  'collider-block': 'collider blocking the path',
  'stub-segment':   'stub road segment (too short to patrol)',
  'seg-loop':       'road segment forms a closed loop',
  'sharp-turn':     'geometrically impossible turn',
  'road-clip':      'vehicle drove THROUGH the road surface',
  'road-elevation': 'road ribbon floats above / sinks below terrain',
  'pin-pull':       'junction pin pulling road height sharply',
  'rough-terrain':  'rough terrain (bump / dip / cliff)',
  'pos-loop':       'unit drove in a circle (behavioral loop)',
  'oscillation':    'unit oscillating between points (behavioral)',
  'unknown':        'no data anomaly found — needs manual investigation'
};
/* v1.14 cause names → this module's cause names (for the merge). */
var V14_MAP = {SEGMENT_LOOP:'seg-loop', SHORT_SEGMENT:'stub-segment',
  SHARP_TURN:'sharp-turn', POSITION_LOOP:'pos-loop', OSCILLATION:'oscillation',
  UNKNOWN:'unknown'};

/* ---------------- bad-spot registry ---------------- */
/* spots: [{x,z,cause,causeLabel,detail,road,count,firstT,lastT,flagged,
            status,reportT,fixT,fixDurationMs,fixedBy,waitingUnits}]
   v1.16: each spot tracks its full lifecycle for Joshua's fix-time
   documentation — reportT (first report), fixT (repair confirmed),
   fixDurationMs (report→fix), and the units currently waiting on it. */
var spots = [];
/* _load() — restores the learned bad spots from localStorage at boot so the
   system remembers across sessions. v1.14's hotspots are memory-only; this
   registry is the durable memory. Corrupt data is discarded silently.
   v1.16: normalizes older entries that lack the lifecycle fields. */
function _load(){
  try{
    var raw = null;
    try{ raw = window.localStorage.getItem(LS_KEY); }catch(e){ return; }
    if (!raw) return;
    var a = JSON.parse(raw);
    if (a && a.length){
      spots = a.slice(0, SPOT_MAX);
      for (var i=0;i<spots.length;i++){
        var s=spots[i];
        if (!s.status) s.status='open';
        if (!s.waitingUnits) s.waitingUnits=[];
        if (!s.reportT) s.reportT=Date.now();
      }
    }
  }catch(e){ spots = []; }
}
/* _save() — persists the registry. Best-effort: private-mode / quota errors
   must never break the game. */
function _save(){
  try{
    try{ window.localStorage.setItem(LS_KEY, JSON.stringify(spots)); }catch(e){}
  }catch(e){}
}
_load();

/* ---------------- helpers ---------------- */
/* _nearestSegPoint(x, z) — brute-force nearest point on any roadDrawData
   segment. Returns {seg, pi, d2} or null. Guarded. */
function _nearestSegPoint(x, z){
  var best=null, bd=1e18;
  try{
    if (typeof roadDrawData==='undefined' || !roadDrawData) return null;
    for (var i=0;i<roadDrawData.length;i++){
      var seg=roadDrawData[i];
      if (!seg||!seg.pts) continue;
      var pts=seg.pts;
      for (var p=0;p<pts.length;p++){
        var dx=pts[p][0]-x, dz=pts[p][1]-z, d2=dx*dx+dz*dz;
        if (d2<bd){ bd=d2; best={seg:seg, pi:p, d2:d2}; }
      }
    }
  }catch(e){ return null; }
  return best;
}
/* _v14finding(unit) — pulls the v1.14 segment-shape diagnosis off the unit's
   StuckDetector (set via setSegment by the crew systems). Returns a finding
   or null. This is the merge point: v1.14 owns segment SHAPE, this module
   owns the DATA around it. */
function _v14finding(unit){
  try{
    if (!unit||!unit.stuck||typeof unit.stuck.getDiagnosis!=='function') return null;
    var d=unit.stuck.getDiagnosis();
    if (!d||!d.cause||d.cause==='UNKNOWN') return null;
    var cause=V14_MAP[d.cause]||'unknown';
    return {cause:cause, detail:d.detail||('v1.14 segment diagnosis: '+d.cause)};
  }catch(e){ return null; }
}

/* ---------------- the 5 data checks (v1.14 doesn't do these) ---------------- */
/* _checkCollider(x, z) — any registered collider within COLLIDER_R? A stray
   collider (misplaced building, tree trunk, sign post) sitting ON the road
   will trap a vehicle forever. colliders entries: {x,z,r,y0,y1}. */
function _checkCollider(x, z){
  try{
    if (typeof colliders==='undefined' || !colliders) return null;
    var best=null, bd=COLLIDER_R*COLLIDER_R;
    for (var i=0;i<colliders.length;i++){
      var c=colliders[i];
      if (!c) continue;
      var dx=c.x-x, dz=c.z-z, d2=dx*dx+dz*dz;
      if (d2<bd){ bd=d2; best=c; }
    }
    if (best){
      return {cause:'collider-block',
        detail:'collider r='+best.r+'u at ('+Math.round(best.x)+','+
               Math.round(best.z)+'), '+Math.round(Math.sqrt(bd))+
               'u from stuck spot — invisible blocker on the path. '+
               'DATA FIX: move or remove the misplaced collider.'};
    }
  }catch(e){}
  return null;
}
/* _checkClip(x, z, unit) — is the vehicle BELOW the terrain surface? Then it
   drove THROUGH the road — the ribbon/collision data disagrees with where
   the vehicle thinks the road is. (clampVehY usually masks this; if it
   still reads below, the data is badly off.) */
function _checkClip(x, z, unit){
  try{
    if (!unit||!unit.mesh||!unit.mesh.position) return null;
    if (typeof heightAt!=='function') return null;
    var vy=unit.mesh.position.y, g=heightAt(x,z);
    if (isFinite(vy)&&isFinite(g)&&vy<g-CLIP_TOL){
      return {cause:'road-clip',
        detail:'vehicle y='+vy.toFixed(1)+'u is '+(g-vy).toFixed(1)+
               'u BELOW terrain ('+g.toFixed(1)+'u) — it drove THROUGH the '+
               'road surface. DATA FIX: check road ribbon Y vs terrain here.'};
    }
  }catch(e){}
  return null;
}
/* _checkElevation(x, z) — road ribbon height (smoothed ys[]) vs terrain
   height at the spot. A ribbon floating 3u+ above (or buried 3u+ below)
   the ground is bad elevation data — vehicles get launched or buried. */
function _checkElevation(x, z){
  try{
    if (typeof heightAt!=='function') return null;
    var np=_nearestSegPoint(x,z);
    if (!np||np.d2>2500) return null;
    if (!np.seg.ys||np.seg.ys.length!==np.seg.pts.length) return null;
    var ry=np.seg.ys[np.pi], g=heightAt(x,z), nm='';
    try{ nm=np.seg.name||''; }catch(e){}
    if (isFinite(ry)&&isFinite(g)&&Math.abs(ry-g)>ELEV_BAD){
      var dir=ry>g?'floats':'sinks';
      return {cause:'road-elevation',
        detail:'road "'+nm+'" ribbon y='+ry.toFixed(1)+'u '+dir+' '+
               Math.abs(ry-g).toFixed(1)+'u vs terrain '+g.toFixed(1)+
               'u. DATA FIX: check junction pins / elev data here.'};
    }
  }catch(e){}
  return null;
}
/* _checkPin(x, z) — nearest junction pin with a strong height pull. Pins
   yank nearby road heights toward a shared value so merged ribbons meet
   with no seam; a big |dh| where a vehicle crosses can launch it skyward
   or slam it into the ground. Checks Joshua's list: "are the pins off?" */
function _checkPin(x, z){
  try{
    if (typeof JUNCTION_PINS==='undefined' || !JUNCTION_PINS) return null;
    var best=null, bd=PIN_SEARCH_R*PIN_SEARCH_R;
    for (var i=0;i<JUNCTION_PINS.length;i++){
      var p=JUNCTION_PINS[i];
      if (!p) continue;
      var dx=p.x-x; if (dx>PIN_SEARCH_R||dx<-PIN_SEARCH_R) continue;
      var dz=p.z-z; if (dz>PIN_SEARCH_R||dz<-PIN_SEARCH_R) continue;
      var d2=dx*dx+dz*dz;
      if (d2<bd){ bd=d2; best=p; }
    }
    if (best && best.dh!=null && Math.abs(best.dh)>=PIN_DH_BAD){
      return {cause:'pin-pull',
        detail:'junction pin at ('+Math.round(best.x)+','+Math.round(best.z)+
               '), '+Math.round(Math.sqrt(bd))+'u away, has dh='+
               best.dh+'u — a sharp height pull at this junction. '+
               'DATA FIX: review this pin in junction_pins.js.'};
    }
  }catch(e){}
  return null;
}
/* _checkTerrain(x, z) — sample the analytic heightfield on a 10u circle.
   High variance = bump/dip/cliff the road data doesn't account for.
   Checks Joshua's list: "is the ground off?" */
function _checkTerrain(x, z){
  try{
    if (typeof heightAt!=='function') return null;
    var hs=[], h0=heightAt(x,z);
    if (!isFinite(h0)) return null;
    hs.push(h0);
    for (var a=0;a<8;a++){
      var h=heightAt(x+Math.cos(a/8*Math.PI*2)*TERR_R,
                     z+Math.sin(a/8*Math.PI*2)*TERR_R);
      if (isFinite(h)) hs.push(h);
    }
    var mean=0, i;
    for (i=0;i<hs.length;i++) mean+=hs[i];
    mean/=hs.length;
    var v=0, mn=1e18, mx=-1e18;
    for (i=0;i<hs.length;i++){
      v+=(hs[i]-mean)*(hs[i]-mean);
      if (hs[i]<mn) mn=hs[i];
      if (hs[i]>mx) mx=hs[i];
    }
    v/=hs.length;
    if (v>TERR_VAR_BAD){
      return {cause:'rough-terrain',
        detail:'terrain variance '+v.toFixed(1)+'u² in a '+TERR_R+
               'u circle (range '+(mx-mn).toFixed(1)+
               'u) — bump/dip/cliff the road doesn\'t follow. '+
               'DATA FIX: check terrain_lifts.js / elev.js here.'};
    }
  }catch(e){}
  return null;
}
/* _checkTurnFallback(x, z, unit) — backup sharp-turn check for callers
   WITHOUT a v1.14 segment diagnosis (e.g. traffic cars, unit=null). Uses a
   stricter 150° threshold so it only fires on truly impossible kinks. */
function _checkTurnFallback(x, z, unit){
  try{
    var pts=null, nm='';
    if (unit && unit.seg && unit.seg.pts){ pts=unit.seg.pts; }
    else {
      var np=_nearestSegPoint(x,z);
      if (!np||np.d2>2500) return null;
      pts=np.seg.pts;
    }
    try{ nm=(unit&&unit.seg&&unit.seg.name)||((np&&np.seg&&np.seg.name)||''); }catch(e){}
    var worst=0, wi=-1;
    for (var i=1;i<pts.length-1;i++){
      var ax=pts[i][0]-pts[i-1][0], az=pts[i][1]-pts[i-1][1];
      var bx=pts[i+1][0]-pts[i][0], bz=pts[i+1][1]-pts[i][1];
      var la=Math.hypot(ax,az), lb=Math.hypot(bx,bz);
      if (la<0.5||lb<0.5) continue;
      var dot=Math.max(-1,Math.min(1,(ax*bx+az*bz)/(la*lb)));
      var turn=Math.acos(dot)*180/Math.PI;
      if (turn>worst){ worst=turn; wi=i; }
    }
    if (worst>=TURN_BAD_DEG){
      return {cause:'sharp-turn',
        detail:'turn of '+Math.round(worst)+'° at vertex '+wi+' on "'+nm+
               '" — geometrically impossible to drive. DATA FIX: smooth it.'};
    }
  }catch(e){}
  return null;
}

/* diagnose(x, z, unit) — the full root-cause workup. Merges the v1.14
   segment-shape diagnosis (when the unit has one) with this module's 5
   data checks, then returns the strongest finding:
     {cause, causeLabel, detail, findings, x, z, road, t}
   unit may be null (traffic cars) — unit-specific checks degrade gracefully.
   Never throws; worst case returns cause 'unknown'. */
function diagnose(x, z, unit){
  var findings=[];
  try{
    var f;
    if ((f=_v14finding(unit))) findings.push(f);       // v1.14: segment shape
    if ((f=_checkCollider(x,z))) findings.push(f);     // (1) stray collider?
    if ((f=_checkClip(x,z,unit))) findings.push(f);    // (2) through the road?
    if ((f=_checkElevation(x,z))) findings.push(f);    // (3) floating/buried?
    if ((f=_checkPin(x,z))) findings.push(f);          // (4) pins off?
    if ((f=_checkTerrain(x,z))) findings.push(f);      // (5) ground off?
    // fallback turn check only when v1.14 had no segment to analyze
    var hasV14Seg=false;
    for (var k=0;k<findings.length;k++){
      if (findings[k].cause==='seg-loop'||findings[k].cause==='stub-segment'||
          findings[k].cause==='sharp-turn'){ hasV14Seg=true; break; }
    }
    if (!hasV14Seg && (f=_checkTurnFallback(x,z,unit))) findings.push(f);
  }catch(e){}
  var cause='unknown', detail='', best=SEV_ORDER.length;
  for (var i=0;i<findings.length;i++){
    var s=SEV_ORDER.indexOf(findings[i].cause);
    if (s>=0&&s<best){ best=s; cause=findings[i].cause; detail=findings[i].detail; }
  }
  var road='?';
  try{
    if (unit&&unit.seg&&unit.seg.name) road=unit.seg.name;
    else { var np=_nearestSegPoint(x,z); if (np&&np.seg&&np.seg.name) road=np.seg.name; }
  }catch(e){}
  var t='';
  try{ var d=new Date(); t=d.toLocaleString(); }catch(e){}
  return {cause:cause, causeLabel:CAUSE_LABELS[cause]||cause, detail:detail,
          findings:findings, x:Math.round(x), z:Math.round(z), road:road, t:t};
}

/* ---------------- registry + learning ---------------- */
/* record(diag) — files the diagnosis in the bad-spot registry. A repeat
   stuck event at the same place (within 50u) bumps the counter instead of
   duplicating; 3+ events flags the spot for DATA REPAIR. Keeps the
   strongest cause seen at each spot. v1.16: new spots start their fix-time
   lifecycle (status='open', reportT=now). Returns the spot entry. */
function record(diag){
  var spot=null;
  try{
    for (var i=0;i<spots.length;i++){
      var s=spots[i], dx=s.x-diag.x, dz=s.z-diag.z;
      if (dx*dx+dz*dz<SPOT_DEDUP_R2){ spot=s; break; }
    }
    if (spot){
      spot.count++;
      spot.lastT=diag.t;
      // v1.16: a NEW stuck event on a previously-fixed spot reopens it —
      // the repair didn't hold, and the fix-time clock restarts.
      if (spot.status==='fixed'){
        spot.status='open'; spot.fixT=null; spot.fixDurationMs=null;
        spot.fixedBy=null; spot.reportT=Date.now();
      }
      var so=SEV_ORDER.indexOf(spot.cause), sn=SEV_ORDER.indexOf(diag.cause);
      if (sn>=0&&(so<0||sn<so)){
        spot.cause=diag.cause; spot.causeLabel=diag.causeLabel; spot.detail=diag.detail;
      }
    }else{
      spot={x:diag.x, z:diag.z, cause:diag.cause, causeLabel:diag.causeLabel,
            detail:diag.detail, road:diag.road, count:1,
            firstT:diag.t, lastT:diag.t, flagged:false,
            status:'open', reportT:Date.now(), fixT:null, fixDurationMs:null,
            fixedBy:null, waitingUnits:[]};
      spots.push(spot);
    }
    if (spot.count>=SPOT_FLAG_N) spot.flagged=true;
    // cap: evict oldest UNFLAGGED first (flagged spots are precious evidence)
    while (spots.length>SPOT_MAX){
      var ei=-1;
      for (var j=0;j<spots.length;j++){
        if (!spots[j].flagged){ ei=j; break; }
      }
      spots.splice(ei<0?0:ei, 1);
    }
    _save();
  }catch(e){}
  if (!spot)
    spot={x:diag.x,z:diag.z,cause:diag.cause,causeLabel:diag.causeLabel,
      detail:diag.detail,road:diag.road,count:1,firstT:diag.t,lastT:diag.t,flagged:false,
      status:'open',reportT:Date.now(),fixT:null,fixDurationMs:null,fixedBy:null,waitingUnits:[]};
  return spot;
}
/* isBadSpot(x, z) — DEPRECATED v1.16. Joshua's 2026-10-09 directive: vehicles
   must NOT auto-reroute around problem spots — they pull over and WAIT for
   the data fix instead. This function now always returns false so every old
   avoidance call site (stuck.js, roadcrew, codeenforce) is inert. Kept
   (not deleted) so any other callers and the admin panel don't throw. */
function isBadSpot(x, z){ return false; }
/* suspectCause(x, z, unit) — the one call the traffic audit makes: run the
   full workup, file it in the registry, return the diagnosis with the
   spot's count/flagged status attached. */
function suspectCause(x, z, unit){
  var d=null;
  try{
    d=diagnose(x, z, unit);
    var s=record(d);
    d.count=s.count; d.flagged=!!s.flagged;
  }catch(e){
    if (!d) d={cause:'unknown', causeLabel:CAUSE_LABELS.unknown, detail:'',
      findings:[], x:Math.round(x), z:Math.round(z), road:'?', t:'',
      count:1, flagged:false};
  }
  return d;
}
/* badSpots() — registry snapshot for the admin panel / Report. Returns a
   copy (callers must not mutate the registry). Flagged spots first. */
function badSpots(){
  try{
    var a=spots.slice();
    a.sort(function(p,q){
      return ((q.flagged?1:0)-(p.flagged?1:0))||(q.count-p.count);
    });
    return a;
  }catch(e){ return []; }
}

/* ---------------- v1.16 wait-for-fix (Joshua's directive, 2026-10-09) ---------------- */
/* _waiters — live unit OBJECTS currently parked in wait mode, so markFixed()
   can clear their flags and release them. (Labels live on the spot entries;
   objects live here.) */
var _waiters=[];
/* _fmtDur(ms) — human-readable duration for the fix-time record Joshua
   asked for ("document how long it takes to fix the problem"). */
function _fmtDur(ms){
  try{
    var s=Math.round(ms/1000);
    if (s<60) return s+'s';
    var m=Math.floor(s/60); s%=60;
    if (m<60) return m+'m '+s+'s';
    var h=Math.floor(m/60); m%=60;
    if (h<24) return h+'h '+m+'m';
    var d=Math.floor(h/24); h%=24;
    return d+'d '+h+'h';
  }catch(e){ return '?'; }
}
/* _releaseUnit(u, why) — clears the wait state and resets the unit's stuck
   detector so the fresh start isn't judged on stale history. Removes the
   unit from the live _waiters list. */
function _releaseUnit(u, why){
  try{
    u.waitingForFix=false;
    u.waitStartT=null; u.waitSpot=null; u._waitAcc=0;
    if (u.stuck && typeof u.stuck.noteRecovery==='function') u.stuck.noteRecovery();
    for (var i=_waiters.length-1;i>=0;i--){
      if (_waiters[i]===u){ _waiters.splice(i,1); break; }
    }
  }catch(e){}
}
/* waitForFix(x, z, unit, unitLabel, logFn) — v1.16. The unit PULLS OVER to
   the right shoulder of the road and WAITS PATIENTLY for the data team to
   fix the problem. It does NOT reroute around the bad spot — Joshua's
   explicit rule. Sets u.waitingForFix (the crew update loops check this
   flag and skip all movement while it is set), parks the mesh off the
   road, and registers the unit on the spot's waitingUnits so markFixed()
   can release it. Returns true when the unit is parked in wait mode. */
function waitForFix(x, z, unit, unitLabel, logFn){
  try{
    if (!unit) return false;
    var m=unit.mesh;
    // travel direction → pull over to the RIGHT shoulder (conventional side)
    var dx=0, dz=1;
    try{
      var pts=unit.seg&&unit.seg.pts, n=pts?pts.length:0;
      if (n>1){
        var i0=Math.max(0,Math.min(Math.floor(unit.i||0), n-2));
        var p=pts[i0], q=pts[i0+1], dir=unit.dir||1;
        dx=(q[0]-p[0])*dir; dz=(q[1]-p[1])*dir;
        var L=Math.hypot(dx,dz)||1; dx/=L; dz/=L;
      }
    }catch(e){}
    var px=dz, pz=-dx;  // right-hand perpendicular of the travel direction
    var wx=x+px*WAIT_OFFSET, wz=z+pz*WAIT_OFFSET;
    var wy=0;
    try{ wy=(typeof heightAt==='function'?heightAt(wx,wz):0)+0.05; }catch(e){}
    try{ if (typeof clampVehY==='function') wy=clampVehY(wx,wz,wy); }catch(e){}
    if (m&&m.position){ m.position.set(wx,wy,wz); }
    try{ if (m) m.rotation.y=Math.atan2(dx,dz); }catch(e){}
    unit.waitingForFix=true;
    unit.waitStartT=Date.now();
    unit.waitSpot={x:Math.round(wx), z:Math.round(wz)};
    unit._waitAcc=0;
    var dup=false;
    for (var w=0;w<_waiters.length;w++){ if (_waiters[w]===unit){ dup=true; break; } }
    if (!dup) _waiters.push(unit);
    // register the label on the spot so the fix-time record names the crew
    try{
      var spot=null;
      for (var i=0;i<spots.length;i++){
        var s=spots[i], ox=s.x-x, oz=s.z-z;
        if (ox*ox+oz*oz<SPOT_DEDUP_R2){ spot=s; break; }
      }
      if (spot){
        spot.waitingUnits=spot.waitingUnits||[];
        if (spot.waitingUnits.indexOf(unitLabel)<0) spot.waitingUnits.push(unitLabel);
        _save();
      }
    }catch(e){}
    if (logFn) logFn('🅿️ '+unitLabel+' pulled over to the road shoulder near ('+
      Math.round(wx)+', '+Math.round(wz)+
      ') and is WAITING PATIENTLY for the data fix — not rerouting (Joshua\'s rule).');
    return true;
  }catch(e){ return false; }
}
/* waitTick(u, dt, logFn) — v1.16. Called every frame by the crew update loop
   while u.waitingForFix is set. Every WAIT_RECHECK_S seconds it re-runs the
   data-cause diagnosis at the wait location: if the data no longer shows an
   anomaly ('unknown'), the fix must have landed — the unit is released
   automatically and the spot's fix time is recorded. Returns true when the
   unit was released, false while it keeps waiting. */
function waitTick(u, dt, logFn){
  try{
    u._waitAcc=(u._waitAcc||0)+dt;
    if (u._waitAcc<WAIT_RECHECK_S) return false;
    u._waitAcc=0;
    var wx=u.waitSpot?u.waitSpot.x:(u.mesh?u.mesh.position.x:0);
    var wz=u.waitSpot?u.waitSpot.z:(u.mesh?u.mesh.position.z:0);
    var d=diagnose(wx, wz, u);
    if (d.cause==='unknown'){
      // data no longer anomalous — the repair landed; record the fix time
      var spot=null;
      for (var i=0;i<spots.length;i++){
        var s=spots[i], ox=s.x-wx, oz=s.z-wz;
        if (ox*ox+oz*oz<SPOT_DEDUP_R2){ spot=s; break; }
      }
      var now=Date.now();
      if (spot && spot.status!=='fixed'){
        spot.status='fixed'; spot.fixT=now;
        spot.reportT=spot.reportT||now;
        spot.fixDurationMs=now-spot.reportT;
        spot.fixedBy='auto-recheck';
        spot.waitingUnits=[];
        _save();
      }
      _releaseUnit(u,'auto-recheck: data no longer anomalous');
      if (logFn) logFn('✅ '+(spot?('Fix auto-confirmed near ('+spot.x+', '+spot.z+')'):'Data no longer anomalous')+
        ' — fix time '+(spot?_fmtDur(spot.fixDurationMs||0):'?')+'. Unit released, resuming route.');
      return true;
    }
    // still broken — keep waiting; log a heartbeat so the dispatch log
    // shows the crew is still parked and the clock is still running
    if (logFn){
      var s2=null, nowH=Date.now();
      for (var j=0;j<spots.length;j++){
        var t2=spots[j], qx=t2.x-wx, qz=t2.z-wz;
        if (qx*qx+qz*qz<SPOT_DEDUP_R2){ s2=t2; break; }
      }
      if (s2 && s2.reportT)
        logFn('⏳ Unit still waiting near ('+s2.x+', '+s2.z+') — "'+
          (s2.causeLabel||s2.cause)+'" open for '+_fmtDur(nowH-s2.reportT)+'.');
    }
  }catch(e){}
  return false;
}
/* markFixed(x, z, by) — v1.16. The DATA team calls this (admin panel /
   console: StuckDiag.markFixed(x,z,'name')) when the road data at a flagged
   spot has been repaired. Records the fix time and HOW LONG the fix took
   (report→fix duration — Joshua's documentation requirement), releases every
   unit waiting on this spot so they resume their routes, and returns a
   summary line for the dispatch log. Returns null if no spot matches. */
function markFixed(x, z, by){
  try{
    var spot=null;
    for (var i=0;i<spots.length;i++){
      var s=spots[i], dx=s.x-x, dz=s.z-z;
      if (dx*dx+dz*dz<SPOT_DEDUP_R2){ spot=s; break; }
    }
    if (!spot) return null;
    var now=Date.now();
    spot.status='fixed';
    spot.fixT=now;
    spot.reportT=spot.reportT||now;
    spot.fixDurationMs=now-spot.reportT;
    spot.fixedBy=by||'dev team';
    var released=0;
    for (var j=_waiters.length-1;j>=0;j--){
      var u=_waiters[j];
      if (!u){ _waiters.splice(j,1); continue; }
      var ws=u.waitSpot;
      if (ws){
        var ox=ws.x-x, oz=ws.z-z;
        if (ox*ox+oz*oz<SPOT_DEDUP_R2){
          _releaseUnit(u,'fix confirmed by '+(by||'dev team'));
          _waiters.splice(j,1);
          released++;
        }
      }
    }
    spot.waitingUnits=[];
    _save();
    var line='🔧 FIX CONFIRMED near ('+spot.x+', '+spot.z+') — "'+
      (spot.causeLabel||spot.cause)+'" repaired by '+(by||'dev team')+
      '. Report→fix: '+_fmtDur(spot.fixDurationMs)+'. '+
      released+' waiting unit'+(released===1?'':'s')+' released to resume route.';
    try{
      if (typeof Report!=='undefined'&&Report.note)
        Report.note('fix-time',{x:spot.x,z:spot.z,cause:spot.cause,
          durationMs:spot.fixDurationMs,released:released,by:by||'dev team'});
    }catch(e){}
    return {spot:spot, line:line, released:released};
  }catch(e){ return null; }
}
/* waitingSummary() — v1.16. Open spots with units currently parked waiting,
   plus how long each has been open. For the admin panel / dispatch log. */
function waitingSummary(){
  var out=[];
  try{
    var now=Date.now();
    for (var i=0;i<spots.length;i++){
      var s=spots[i];
      if (s.status==='fixed') continue;
      var wu=s.waitingUnits||[];
      if (!wu.length) continue;
      var openMs=now-(s.reportT||now);
      out.push({x:s.x, z:s.z, road:s.road, cause:s.causeLabel||s.cause,
        units:wu.slice(), openForMs:openMs, openFor:_fmtDur(openMs)});
    }
  }catch(e){}
  return out;
}

window.StuckDiag={diagnose:diagnose, record:record, isBadSpot:isBadSpot,
  suspectCause:suspectCause, badSpots:badSpots,
  waitForFix:waitForFix, waitTick:waitTick, markFixed:markFixed,
  waitingSummary:waitingSummary,
  _cfg:{PIN_DH_BAD:PIN_DH_BAD, TERR_VAR_BAD:TERR_VAR_BAD,
        TURN_BAD_DEG:TURN_BAD_DEG, ELEV_BAD:ELEV_BAD, SPOT_FLAG_N:SPOT_FLAG_N,
        WAIT_OFFSET:WAIT_OFFSET, WAIT_RECHECK_S:WAIT_RECHECK_S}};
})();
