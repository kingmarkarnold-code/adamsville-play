/* ============================================================================
   FILE: roadfix.js — "Surviving Adamsville" ROAD CREW ↔ DEV TEAM coordination
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-09):
     The road crew (construction/working) and the road development team
     (code) must work HAND IN HAND:
       1. When a road problem is found (drones, helicopters, stuck
          diagnostics), FIRST determine: is this a CODE problem or a
          CONSTRUCTION problem?
       2. CODE problem (bad segment geometry, heightfield data): the dev
          team fixes it — flagged for DATA REPAIR in the dispatch log.
       3. CONSTRUCTION problem (bad junction pin height, stray collider,
          ribbon elevation): the road construction crew is DEPLOYED to the
          location — the existing visual repair pipeline (work truck, crew,
          cones, signs) runs, and the physical patch is computed + recorded.
       4. EVERY fix is SAVED AUTOMATICALLY across sessions (localStorage).
          On game load, saved fixes are applied BEFORE any diagnostics run,
          and the diagnostic system skips already-fixed locations.

   WHAT IT DOES:
     A. classify(cause) — maps a stuck-diagnosis cause to 'construction',
        'code', or 'none' (behavioral / needs manual investigation).
     B. dispatchCrew(x, z, spot) — for construction-classified spots: builds
        a repair defect and sends it through roadcrew's dispatchRepair()
        (truck + workers + cones + signs + 75s work window). A watcher
        finalizes the job: computes the physical patch, records the fix,
        and confirms it (releasing any waiting units).
     C. Unified fix registry 'sa_roadfixes_v1' (localStorage):
          {x, z, cause, causeLabel, road, fixKind, fixT, fixedBy,
           durationMs, patch, status}
        confirmFix() records the fix AND calls StuckDiag.markFixed() so
        waiting units are released and fix times are documented.
     D. Boot-time application (BEFORE diagnostics can run — this script
        executes at load, long before any unit can get stuck):
          - pin-y patches are applied inside the buildRoads IIFE in
            index.html (see the v1.17 hook there) — corrected pin heights
            bake into the road ribbons on THIS load.
          - collider-move patches + asphalt re-lays are applied here at
            top level (colliders and the scene are fully built by now).
     E. suspectCause() is wrapped (decorator): spots with a confirmed fix
        whose current diagnosis is 'unknown' are NOT re-filed — the fix is
        holding, so the diagnostic system skips them. If the anomaly is
        back, the original files it and the spot reopens (repair didn't
        hold).
     F. BuildingFix — Joshua's companion directive (2026-10-09): "make sure
        the buildings that are fixed are saved automatically." A second
        registry 'sa_buildingfixes_v1' persists building collider
        corrections (add/remove/move); applyAll() re-applies them at boot.
        record() is the API the admin panel / future repair missions call.

   PATCH TYPES (road):
     - {type:'pin-y', px, pz, y} — corrected junction-pin height. Applied
       in buildRoads BEFORE the smoothHeights pin pass (index.html hook).
       Ribbons are baked at build, so a mid-game pin correction takes
       effect on the NEXT load — the fix is confirmed via markFixed, and
       waiters are released immediately (the crew did the work).
     - {type:'collider-move', x, z, r, nx, nz} — stray collider relocated
       off the road. Applied LIVE (colliders array mutates instantly) and
       re-applied at boot.
   PATCH TYPES (building):
     - {type:'collider-add'|'collider-remove'|'collider-move', ...}
     - {type:'note'} — documentation-only entry.

   HONEST LIMITS (documented so nobody is misled):
     - Pin corrections cannot rebake already-built road meshes mid-game;
       they bake on the next load. The game must be reloaded (or the app
       restarted) for corrected pins to reshape ribbons. The crew's
       confirmation still releases waiting units immediately.
     - Rough-terrain and segment-geometry causes are classified 'code':
       they need a data rebuild (terrain_lifts.js / roads.js), not a
       field patch. They are flagged, not auto-fixed.

   LOAD ORDER: include AFTER roadcrew_system.js (needs its repair pipeline
   exports) and AFTER stuck_diag.js (wraps suspectCause):
       <script src="stuck.js"></script>
       <script src="stuck_diag.js"></script>
       ...
       <script src="roadcrew_system.js" ...></script>
       <script src="roadfix.js"></script>
   Every external it touches is accessed lazily and guarded — a missing
   dependency degrades to no-ops, never a crash.
   ============================================================================ */
(function(){
'use strict';
if (window.RoadFix) return;   // singleton — never double-install

/* ---------------- tuning / keys ---------------- */
var LS_ROAD='sa_roadfixes_v1';    // unified road-fix registry
var LS_BLDG='sa_buildingfixes_v1';// building-fix registry
var FIX_DEDUP_R2=2500;            // 50u^2 — same-place dedup
var JOB_WATCH_MS=5000;            // dispatched-repair completion poll
var JOB_TIMEOUT_MS=10*60*1000;    // 10 min — then finalize regardless
var REPAIR_T_S=75;                // roadcrew work window (informational)

/* ---------------- A. classification: CODE vs CONSTRUCTION ---------------- */
/* FIELD_CAUSES — the construction crew can fix these in the field:
     pin-pull       → pin re-survey (corrected pin height)
     road-elevation → ribbon re-seat via nearest pin
     road-clip      → ribbon re-seat via nearest pin
     collider-block → relocate the stray collider off the road          */
var FIELD_CAUSES={'pin-pull':1,'road-elevation':1,'road-clip':1,'collider-block':1};
/* CODE_CAUSES — need a dev-team data rebuild (roads.js / terrain data):
     seg-loop / stub-segment / sharp-turn → segment geometry redesign
     rough-terrain                          → heightfield data rebuild  */
var CODE_CAUSES={'seg-loop':1,'stub-segment':1,'sharp-turn':1,'rough-terrain':1};
/* classify(cause) → 'construction' | 'code' | 'none'.
   'none' = behavioral (pos-loop, oscillation) or unknown — no road fix
   applies; the spot is logged for manual investigation only. */
function classify(cause){
  if (FIELD_CAUSES[cause]) return 'construction';
  if (CODE_CAUSES[cause]) return 'code';
  return 'none';
}

/* ---------------- logging ---------------- */
/* _rlog(msg) — roadfix event log: Report panel when available, console
   otherwise. Never throws. */
function _rlog(msg){
  try{
    if (typeof Report!=='undefined' && Report.setSys)
      Report.setSys('roadfix', {status:'ok', last:msg, t:Date.now()});
  }catch(e){}
  try{ if (typeof console!=='undefined'&&console.log) console.log('[roadfix] '+msg); }catch(e){}
}

/* ---------------- C. unified road-fix registry ---------------- */
/* fixes: [{x,z,cause,causeLabel,road,fixKind,fixT,fixedBy,durationMs,
            patch, status}]
   status: 'fixed' (only confirmed fixes are stored — the stuck_diag
   registry remains the system of record for OPEN spots). */
var fixes=[];
function _rLoad(){
  try{
    var raw=null;
    try{ raw=window.localStorage.getItem(LS_ROAD); }catch(e){ return; }
    if (!raw) return;
    var a=JSON.parse(raw);
    if (a&&a.length) fixes=a.slice(0,200);
  }catch(e){ fixes=[]; }
}
function _rSave(){
  try{ try{ window.localStorage.setItem(LS_ROAD, JSON.stringify(fixes)); }catch(e){} }catch(e){}
}
_rLoad();
/* _findFix(x,z) — nearest registry entry within 50u, or null. */
function _findFix(x,z){
  try{
    for (var i=0;i<fixes.length;i++){
      var f=fixes[i], dx=f.x-x, dz=f.z-z;
      if (dx*dx+dz*dz<FIX_DEDUP_R2) return f;
    }
  }catch(e){}
  return null;
}
/* isFixed(x,z) — public: does a confirmed fix exist here? Used by the
   stuck.js hotspot guard so already-fixed spots aren't re-flagged. */
function isFixed(x,z){
  var f=_findFix(x,z);
  return !!(f && f.status==='fixed');
}
/* confirmFix(x, z, by, fixKind, patch) — the single choke point for
   recording a repair. Writes the unified registry entry (with fix time
   and duration), then calls StuckDiag.markFixed() so waiting units are
   released and the dispatch log gets the fix-time line. Returns the entry. */
function confirmFix(x, z, by, fixKind, patch){
  var entry=null;
  try{
    var spot=null;
    try{
      if (window.StuckDiag && StuckDiag.badSpots){
        var bs=StuckDiag.badSpots();
        for (var i=0;i<bs.length;i++){
          var s=bs[i], dx=s.x-x, dz=s.z-z;
          if (dx*dx+dz*dz<FIX_DEDUP_R2){ spot=s; break; }
        }
      }
    }catch(e){}
    var now=Date.now();
    entry={x:Math.round(x), z:Math.round(z),
      cause:(spot&&spot.cause)||'unknown',
      causeLabel:(spot&&spot.causeLabel)||'',
      road:(spot&&spot.road)||'?',
      fixKind:fixKind||'code',
      fixT:now, fixedBy:by||'dev team',
      durationMs:(spot&&spot.reportT)?(now-spot.reportT):0,
      patch:patch||null, status:'fixed', note:''};
    var old=_findFix(x,z);
    if (old){ for (var k in entry){ old[k]=entry[k]; } entry=old; }
    else fixes.push(entry);
    while (fixes.length>200) fixes.shift();
    _rSave();
    var res=null;
    try{
      if (window.StuckDiag && typeof StuckDiag.markFixed==='function')
        res=StuckDiag.markFixed(x, z, by);
    }catch(e){}
    _rlog('🔧 '+(fixKind||'code')+' fix recorded near ('+entry.x+', '+entry.z+
      ') by '+(by||'dev team')+(patch&&patch.type?' ['+patch.type+']':'')+
      (res&&res.line?' — '+res.line:''));
  }catch(e){}
  return entry;
}

/* ---------------- B. construction dispatch ---------------- */
/* _dispatched — in-flight crew repairs: {id:{defect, t, spot, done}} */
var _dispatched={};
/* dispatchCrew(x, z, spot) — sends the road construction crew to a
   construction-classified spot via roadcrew's dispatchRepair() (work
   truck + 4 workers + cones + signs + 75s work window). The job watcher
   finalizes it: computes the physical patch, records the fix, confirms.
   Returns {ok, id|why}. Safe no-op when the crew pipeline is missing. */
function dispatchCrew(x, z, spot){
  try{
    var ops=window.__roadCrewOps;
    if (!ops || typeof ops.dispatchRepair!=='function')
      return {ok:false, why:'road crew repair pipeline unavailable'};
    var cause=(spot&&spot.cause)||'unknown';
    if (classify(cause)!=='construction')
      return {ok:false, why:'cause "'+cause+'" is not construction-classified'};
    var id='STUCK-'+Math.round(x)+'-'+Math.round(z);
    if (_dispatched[id] && !_dispatched[id].done)
      return {ok:false, why:'crew already dispatched to this spot'};
    var d={id:id, kind:'road', structural:true,
      street:(spot&&spot.road)||'road',
      x:Math.round(x), z:Math.round(z),
      patchW:40, patchD:14,
      truth:((spot&&spot.causeLabel)||'stuck-loop')+' — '+
            ((spot&&spot.detail)||'diagnosed by stuck-loop root-cause'),
      fix:'Field repair per stuck-diagnosis (crew re-survey / relocate).',
      state:'dispatched'};
    _dispatched[id]={defect:d, t:Date.now(), spot:spot||null, done:false, seen:false};
    ops.dispatchRepair(d);
    _rlog('🚧 crew dispatched to ('+d.x+', '+d.z+') — "'+
      ((spot&&spot.causeLabel)||cause)+'" ['+cause+' → construction]');
    return {ok:true, id:id};
  }catch(e){ return {ok:false, why:String((e&&e.message)||e)}; }
}
/* _nearestPin(x,z) — nearest junction pin within 100u (mirrors the
   stuck_diag check; kept local so this module stands alone). */
function _nearestPin(x, z){
  try{
    if (typeof JUNCTION_PINS==='undefined' || !JUNCTION_PINS) return null;
    var best=null, bd=100*100;
    for (var i=0;i<JUNCTION_PINS.length;i++){
      var p=JUNCTION_PINS[i]; if(!p) continue;
      var dx=p.x-x, dz=p.z-z, d2=dx*dx+dz*dz;
      if (d2<bd){ bd=d2; best=p; }
    }
    return best;
  }catch(e){ return null; }
}
/* _terrainAt(x,z) — guarded analytic terrain height. */
function _terrainAt(x,z){
  try{
    if (typeof roadSitY==='function'){ var y=roadSitY(x,z); if(isFinite(y)) return y; }
    if (typeof heightAt==='function'){ var h=heightAt(x,z); if(isFinite(h)) return h; }
  }catch(e){}
  return null;
}
/* _computePatch(x, z, cause) — the physical patch for a finished crew
   repair, derived from CURRENT live data:
     pin-pull / road-elevation / road-clip → {type:'pin-y', px, pz, y}:
       the crew "re-surveyed" the junction: pin y := terrain height at
       the pin (ribbons must sit on the ground, not yank through it).
     collider-block → {type:'collider-move', x, z, r, nx, nz}: the stray
       collider is shoved 15u to the road shoulder (applied LIVE now,
       re-applied at boot).
   Returns null when no patch is computable (fix is recorded anyway). */
function _computePatch(x, z, cause){
  try{
    if (cause==='collider-block' && typeof colliders!=='undefined'){
      var best=null, bd=15*15;
      for (var i=0;i<colliders.length;i++){
        var c=colliders[i]; if(!c) continue;
        var dx=c.x-x, dz=c.z-z, d2=dx*dx+dz*dz;
        if (d2<bd){ bd=d2; best=c; }
      }
      if (best){
        // shove it off the road: 15u along the radial from the stuck spot
        var ox=best.x-x, oz=best.z-z, L=Math.hypot(ox,oz)||1;
        var nx=Math.round(best.x+ox/L*15), nz=Math.round(best.z+oz/L*15);
        var patch={type:'collider-move', x:Math.round(best.x), z:Math.round(best.z),
                   r:best.r||1, nx:nx, nz:nz};
        // apply LIVE — the array mutates instantly, no reload needed
        best.x=nx; best.z=nz;
        _rlog('🚧 stray collider relocated ('+patch.x+','+patch.z+') → ('+nx+','+nz+')');
        return patch;
      }
      return null;
    }
    if (cause==='pin-pull'||cause==='road-elevation'||cause==='road-clip'){
      var pin=_nearestPin(x,z);
      if (pin){
        var ty=_terrainAt(pin.x, pin.z);
        if (ty!=null){
          return {type:'pin-y', px:Math.round(pin.x), pz:Math.round(pin.z),
                  y:Math.round(ty*100)/100};
        }
      }
      return null;
    }
  }catch(e){}
  return null;
}
/* _onCrewFinished(rec) — the dispatched repair's work window ended:
   compute the physical patch, record + confirm the fix (releases waiters). */
function _onCrewFinished(rec){
  try{
    var x=rec.defect.x, z=rec.defect.z;
    var cause=(rec.spot&&rec.spot.cause)||'unknown';
    var patch=_computePatch(x, z, cause);
    confirmFix(x, z, 'road crew', 'construction', patch);
  }catch(e){}
}
/* _watchJobs() — polls the crew's active job list; when a dispatched
   repair job disappears it has finished (finishRepair ran its 75s
   window). Times out after 10 min (finalize with whatever we have). */
function _watchJobs(){
  try{
    var ops=window.__roadCrewOps;
    var jobs=(ops&&typeof ops.jobs==='function')?ops.jobs():[];
    var now=Date.now();
    for (var id in _dispatched){
      if (!_dispatched.hasOwnProperty(id)) continue;
      var rec=_dispatched[id];
      if (!rec || rec.done) continue;
      var alive=false;
      for (var i=0;i<jobs.length;i++){
        if (jobs[i] && jobs[i].defect===rec.defect){ alive=true; rec.seen=true; break; }
      }
      if (!alive && rec.seen){ rec.done=true; _onCrewFinished(rec); }
      else if (!alive && (now-rec.t)>JOB_TIMEOUT_MS){
        rec.done=true;
        _rlog('⚠️ dispatched repair '+id+' never appeared in the job list — finalizing with computed patch');
        _onCrewFinished(rec);
      }
    }
  }catch(e){}
}

/* ---------------- D. boot-time application ---------------- */
/* _roadHeading(x,z) — local heading of the nearest road segment (for
   aligning re-laid asphalt patches). Boot-only scan; guarded. */
function _roadHeading(x, z){
  try{
    if (typeof roadDrawData==='undefined') return 0;
    var best=null, bd=1e18, bi=0;
    for (var i=0;i<roadDrawData.length;i++){
      var seg=roadDrawData[i];
      if (!seg||!seg.pts) continue;
      for (var p=0;p<seg.pts.length;p++){
        var dx=seg.pts[p][0]-x, dz=seg.pts[p][1]-z, d2=dx*dx+dz*dz;
        if (d2<bd){ bd=d2; best=seg; bi=p; }
      }
    }
    if (best){
      var pts=best.pts, i0=Math.max(0,Math.min(bi,pts.length-2));
      var a=pts[i0], b=pts[i0+1];
      return Math.atan2(b[0]-a[0], b[1]-a[1]);
    }
  }catch(e){}
  return 0;
}
/* _applyBootPatches() — runs ONCE at load, BEFORE any unit can get stuck:
     1. collider-move patches → mutate the live colliders array
     2. asphalt re-lay for fixed construction entries (fresh pavement is
        permanent — matches roadcrew's own "re-laid on later loads" rule)
   Pin-y patches are applied EARLIER, inside the buildRoads IIFE
   (index.html v1.17 hook), because ribbons bake before this script loads. */
function _applyBootPatches(){
  var nCol=0, nAsp=0;
  try{
    for (var i=0;i<fixes.length;i++){
      var f=fixes[i];
      if (!f || f.status!=='fixed') continue;
      var p=f.patch;
      if (p && p.type==='collider-move' && typeof colliders!=='undefined'){
        for (var c=0;c<colliders.length;c++){
          var col=colliders[c];
          if (!col) continue;
          if (Math.abs(col.x-p.x)<2 && Math.abs(col.z-p.z)<2 &&
              Math.abs((col.r||1)-p.r)<1){
            col.x=p.nx; col.z=p.nz; nCol++;
            break;
          }
        }
      }
      if (f.fixKind==='construction'){
        try{
          var ops=window.__roadCrewOps;
          if (ops && typeof ops.makePatch==='function' && typeof scene!=='undefined'){
            var mesh=ops.makePatch({x:f.x, z:f.z, patchW:40, patchD:14},
                                   _roadHeading(f.x, f.z));
            scene.add(mesh); nAsp++;
          }
        }catch(e){}
      }
    }
  }catch(e){}
  if (nCol||nAsp) _rlog('🛣️ boot: re-applied '+nCol+' collider patch(es), '+nAsp+' asphalt patch(es) from saved fixes');
  return {colliders:nCol, asphalt:nAsp};
}

/* ---------------- E. diagnostics skip confirmed fixes ---------------- */
/* Decorator on StuckDiag.suspectCause: a spot with a CONFIRMED fix whose
   current diagnosis is 'unknown' (fix holding) is NOT re-filed. If the
   anomaly is back, the original runs and the spot reopens (repair
   didn't hold) — exactly the reopen semantics record() already has. */
function _wrapSuspectCause(){
  try{
    if (!window.StuckDiag || typeof StuckDiag.suspectCause!=='function') return;
    if (StuckDiag._roadfixWrapped) return;
    var orig=StuckDiag.suspectCause;
    StuckDiag.suspectCause=function(x, z, unit){
      try{
        if (isFixed(x, z) && typeof StuckDiag.diagnose==='function'){
          var d=StuckDiag.diagnose(x, z, unit);
          d.count=0; d.flagged=false;
          if (d.cause==='unknown') return d;  // fixed and holding: skip
        }
      }catch(e){}
      return orig(x, z, unit);
    };
    StuckDiag._roadfixWrapped=true;
  }catch(e){}
}

/* ---------------- F. BuildingFix — building fixes saved automatically ---- */
/* Joshua's companion directive (2026-10-09): "make sure the buildings that
   are fixed are saved automatically."
   Registry 'sa_buildingfixes_v1': [{type, payload, fixT, by, note}]
   Supported types (applied at boot, re-applied every load):
     collider-add    {x,z,r,y0,y1}   — add a missing building collider
     collider-remove {x,z,r}         — remove a phantom collider (match ≤2u, r±1)
     collider-move   {x,z,r,nx,nz}   — relocate a misplaced collider
     note            {text}          — documentation-only entry
   record() is the API the admin panel / repair missions / dev tools call;
   applyAll() runs at boot (buildings and colliders are fully built by the
   time this script executes). */
var bfixes=[];
function _bLoad(){
  try{
    var raw=null;
    try{ raw=window.localStorage.getItem(LS_BLDG); }catch(e){ return; }
    if (!raw) return;
    var a=JSON.parse(raw);
    if (a&&a.length) bfixes=a.slice(0,200);
  }catch(e){ bfixes=[]; }
}
function _bSave(){
  try{ try{ window.localStorage.setItem(LS_BLDG, JSON.stringify(bfixes)); }catch(e){} }catch(e){}
}
_bLoad();
var BuildingFix={
  /* record(type, payload, by, note) — persist a building fix. The fix is
     applied LIVE immediately and re-applied automatically on every
     future load via applyAll(). */
  record:function(type, payload, by, note){
    var e=null;
    try{
      e={type:type, payload:payload||{}, fixT:Date.now(),
         by:by||'dev team', note:note||''};
      bfixes.push(e);
      while (bfixes.length>200) bfixes.shift();
      _bSave();
      _applyOneBuildingFix(e);   // live now
      _rlog('🏠 building fix recorded ['+type+'] by '+(by||'dev team'));
    }catch(err){}
    return e;
  },
  list:function(){ try{ return bfixes.slice(); }catch(e){ return []; } },
  /* applyAll() — re-apply every saved building fix (boot path). */
  applyAll:function(){
    var n=0;
    try{
      for (var i=0;i<bfixes.length;i++){
        if (_applyOneBuildingFix(bfixes[i])) n++;
      }
    }catch(e){}
    if (n) _rlog('🏠 boot: re-applied '+n+' saved building fix(es)');
    return n;
  }
};
/* _applyOneBuildingFix(e) — applies a single building-fix entry to the
   live colliders array. Returns true when it changed something. */
function _applyOneBuildingFix(e){
  try{
    if (!e || typeof colliders==='undefined') return false;
    var p=e.payload||{};
    if (e.type==='collider-add'){
      colliders.push({x:p.x, z:p.z, r:p.r||1,
        y0:(p.y0!=null?p.y0:-1e9), y1:(p.y1!=null?p.y1:1e9)});
      return true;
    }
    if (e.type==='collider-remove' || e.type==='collider-move'){
      for (var i=0;i<colliders.length;i++){
        var c=colliders[i]; if(!c) continue;
        if (Math.abs(c.x-p.x)<2 && Math.abs(c.z-p.z)<2 &&
            Math.abs((c.r||1)-(p.r||1))<1){
          if (e.type==='collider-remove'){ colliders.splice(i,1); }
          else { c.x=p.nx; c.z=p.nz; }
          return true;
        }
      }
    }
  }catch(err){}
  return false;
}

/* ---------------- boot ---------------- */
try{
  _applyBootPatches();     // collider patches + asphalt re-lay (roads)
  BuildingFix.applyAll();  // saved building fixes
  _wrapSuspectCause();     // skip fixed-and-holding spots in diagnostics
}catch(e){}
try{ setInterval(_watchJobs, JOB_WATCH_MS); }catch(e){}

/* ---------------- public API ---------------- */
window.RoadFix={
  classify:classify,
  dispatchCrew:dispatchCrew,
  confirmFix:confirmFix,
  isFixed:isFixed,
  list:function(){ try{ return fixes.slice(); }catch(e){ return []; } },
  /* autoTriage(x, z, spot) — the HAND-IN-HAND router (Joshua 2026-10-09):
     construction → deploy the road crew; code → flag for the dev team;
     none → log for manual investigation. Returns the routing decision. */
  autoTriage:function(x, z, spot){
    var cause=(spot&&spot.cause)||'unknown';
    var kind=classify(cause);
    try{
      if (kind==='construction'){
        var r=dispatchCrew(x, z, spot);
        _rlog('🔀 triage ('+Math.round(x)+','+Math.round(z)+'): "'+cause+
          '" → CONSTRUCTION'+(r.ok?' — crew dispatched ('+r.id+')':' — dispatch FAILED: '+r.why));
        return {kind:kind, dispatched:r.ok, id:r.id||null, why:r.why||null};
      }
      if (kind==='code'){
        _rlog('🔀 triage ('+Math.round(x)+','+Math.round(z)+'): "'+cause+
          '" → CODE — flagged for the dev team (data rebuild required)');
        return {kind:kind, dispatched:false, why:'needs dev-team data rebuild'};
      }
      _rlog('🔀 triage ('+Math.round(x)+','+Math.round(z)+'): "'+cause+
        '" → no road fix applies (behavioral / manual investigation)');
      return {kind:kind, dispatched:false, why:'no applicable road fix'};
    }catch(e){ return {kind:kind, dispatched:false, why:String((e&&e.message)||e)}; }
  },
  _cfg:{LS_ROAD:LS_ROAD, LS_BLDG:LS_BLDG, JOB_WATCH_MS:JOB_WATCH_MS}
};
window.BuildingFix=BuildingFix;
_rlog('roadfix.js loaded — crew↔dev coordination active ('+fixes.length+
      ' road fix(es), '+bfixes.length+' building fix(es) on record)');
})();
