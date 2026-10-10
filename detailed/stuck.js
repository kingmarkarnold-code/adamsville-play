/* ============================================================================
   FILE: stuck.js — "Surviving Adamsville" shared stuck-loop detection
   ----------------------------------------------------------------------------
   PURPOSE: Shared stuck-loop detector + recovery used by ALL crew systems
   (road crew, code enforcement, ...). A patrolling unit that repeats the
   same pattern without making progress breaks the loop: it files a report
   and gets reassigned to a fresh patrol area, skipping the bad segment.
   KEY SYSTEMS:
     - StuckDetector: a 40-sample position history (one sample per 2s = 80s
       window). TRIGGERS stuck when: path traveled >150u BUT max spread
       <100u (moved a lot, got nowhere — NOT net displacement, which would
       falsely read ~0 around a legitimate turnaround), OR ≥6 direction
       reversals in the window (oscillation; also catches tight circular
       loops where 2s-apart move directions swing >90°). Jitter under 1u is
       ignored. 90s cooldown before re-reporting.
     - recoverStuckUnit(u, opts): logs the event, blacklists the unit's
       current segment (max 8 kept), then probes up to 14 random points in a
       ±2000u box for a new patrol area: must be a real segment with ≥8
       points (skips tiny stubs/loops — the Utoy Circle problem), must not
       be blacklisted, must be ≥500u away. On success calls opts.reposition.
       Returns false if no clear area found (unit holds and retries next
       detection).
   JOSHUA SPECS ENCODED (stuck-loop recovery protocol):
     - When a road worker is stuck in a loop, it recognizes it can't finish
       its direction of travel — files a report and requests police
       assistance. Police escort it THROUGH THE GRASS (the authorized
       exception to the no-grass rule) to the nearest road, where it resumes
       patrol. Each crew system wires this via opts.reposition.
   USAGE: attach one StuckDetector per unit; call .sample(x,z,dt) each frame
   (skip while legitimately paused at a task); on true call recoverStuckUnit
   with the system's callbacks. Load BEFORE the crew systems that use it;
   all hooks are guarded so a missing stuck.js changes nothing.
   ============================================================================ */
/* ============================================================================
   SURVIVING ADAMSVILLE — STUCK-LOOP DETECTION (shared crew AI module)
   ----------------------------------------------------------------------------
   Joshua's spec: every crew member that patrols or navigates gets a short
   position-history buffer. If it repeats the same pattern without making
   progress (same spots, oscillating between two points, task never
   advancing), it breaks the loop: files a report in the dispatch log and
   gets reassigned to a fresh patrol area, skipping the problematic segment.

   Simple sim logic — no pathfinding, no complex AI.

   Usage (in any crew system):
     // at spawn or first update:
     if (!u.stuck && typeof StuckDetector!=='undefined') u.stuck=new StuckDetector();
     // each frame (skip while legitimately paused at a task):
     if (u.stuck && u.pauseT<=0 && u.stuck.sample(m.position.x, m.position.z, dt)){
       mySystemRecover(u);   // calls recoverStuckUnit() with system callbacks
     }

   STANDALONE MODULE. Include BEFORE the crew systems that use it:
       <script src="stuck.js"></script>
   If it fails to load, crew systems run exactly as before (all hooks guarded).
   ============================================================================ */
(function(){
'use strict';
if (window.StuckDetector) return;

/* ---------------- tuning ---------------- */
var SAMPLE_EVERY  = 2;    // seconds between position samples
var HISTORY_LEN   = 40;   // samples kept  -> 80 seconds of movement history
var MIN_PATH      = 150;  // must have traveled this far (u) to count as "moving"
var MAX_SPREAD    = 100;  // ...but never got this far (u) from anywhere it's
                          // been in the window = going nowhere
var MAX_REVERSALS = 6;    // direction flips inside the window = oscillating
var COOLDOWN      = 90;   // seconds before the same unit can report stuck again
var REASSIGN_MIN_D= 500;  // new patrol area must be at least this far (u) away
var MIN_SEG_PTS   = 8;    // don't reassign onto tiny segments (the Utoy Circle
                          // problem: a stub/loop too short to patrol)

/* ---------------- detector ---------------- */
/* StuckDetector — one instance per patrolling unit. Keeps a 40-sample
   position history (sampled every 2s → 80s window), each sample storing
   position + normalized move direction. Call .sample(x,z,dt) each frame;
   it returns true exactly once per detection (cooldown then applies). */
function StuckDetector(){
  this.hist=[];        // [{x,z,dx,dz}] dx,dz = normalized move dir this sample
  this._acc=0;
  this.cooldown=0;
  this.events=0;
}
/* sample(x,z,dt) — records position every 2s; once the 40-sample window is
   full, tests two stuck conditions and returns true if either fires:
     (1) path>150u but max spread<100u — the unit covered ground yet never
         got anywhere (max spread, not net displacement: a unit sitting
         symmetrically around a legitimate turnaround would read ~0 net
         displacement without being stuck).
     (2) ≥6 direction reversals (move directions >90° apart) in the window —
         oscillation or a tight circular loop — with max spread <200u.
   Sub-1u moves are ignored as jitter. Returns false on cooldown or until
   the window fills. */
StuckDetector.prototype.sample=function(x,z,dt){
  if (this.cooldown>0){ this.cooldown-=dt; return false; }
  this._acc+=dt;
  if (this._acc<SAMPLE_EVERY) return false;
  this._acc=0;
  var dx=0, dz=0;
  if (this.hist.length){
    var last=this.hist[this.hist.length-1];
    var mx=x-last.x, mz=z-last.z, L=Math.hypot(mx,mz);
    if (L>1){ dx=mx/L; dz=mz/L; }   // ignore sub-unit jitter
  }
  this.hist.push({x:x, z:z, dx:dx, dz:dz});
  if (this.hist.length>HISTORY_LEN) this.hist.shift();
  if (this.hist.length<HISTORY_LEN) return false;   // need a full window
  // path length: total ground covered in the window
  var path=0, i, a, b, j, dd;
  for (i=1;i<this.hist.length;i++){
    a=this.hist[i-1]; b=this.hist[i];
    path+=Math.hypot(b.x-a.x, b.z-a.z);
  }
  // max spread: farthest apart any two samples are. A unit making progress
  // gets far from somewhere it's been; a stuck unit never does — even when
  // the window sits symmetrically around a legitimate turnaround (where
  // first-to-last net displacement would falsely read ~0).
  var maxD=0;
  for (i=0;i<this.hist.length;i++){
    for (j=i+1;j<this.hist.length;j++){
      dd=Math.hypot(this.hist[i].x-this.hist[j].x,
                     this.hist[i].z-this.hist[j].z);
      if (dd>maxD) maxD=dd;
    }
  }
  // direction reversals inside the window (oscillation check). Note this also
  // catches tight circular loops: on a small circle the move direction
  // between 2s-apart samples swings >90 degrees, counting as reversals.
  var rev=0;
  for (i=1;i<this.hist.length;i++){
    a=this.hist[i-1]; b=this.hist[i];
    if ((a.dx||a.dz)&&(b.dx||b.dz)){
      if (a.dx*b.dx+a.dz*b.dz < -0.5) rev++;
    }
  }
  if (path>MIN_PATH && maxD<MAX_SPREAD) return this._trigger();
  if (rev>=MAX_REVERSALS && maxD<MAX_SPREAD*2) return this._trigger();
  return false;
};
/* _trigger() — internal: counts the event, starts the 90s cooldown, clears
   the history so a re-detection starts fresh, returns true to the caller.
   v1.14: Now performs root-cause diagnosis before triggering — analyzes the
   unit's current segment for data problems (loops, sharp turns, short
   segments) and stores the diagnosis for the recovery report. This is
   Joshua's directive: find WHY it's stuck, not just THAT it's stuck. */
StuckDetector.prototype._trigger=function(){
  this.events++;
  this.cooldown=COOLDOWN;
  // v1.14: Diagnose the root cause from the position history + segment data
  this.diagnosis=this._diagnose();
  this.hist.length=0;
  return true;
};
/* _diagnose() — v1.14: analyzes WHY the unit got stuck. Returns a diagnosis
   object with the most likely root cause. Checks (in order):
   1. SEGMENT_LOOP: the unit's road segment forms a closed loop (start ≈ end)
   2. SHARP_TURN: the segment has a turn >90° that vehicles can't navigate
   3. SHORT_SEGMENT: the segment is too short to patrol (<8 points)
   4. OSCILLATION: the unit bounced between endpoints (behavioral, not data)
   5. UNKNOWN: none of the above — needs manual investigation
   Joshua's rule: fix the DATA, not just the behavior. */
StuckDetector.prototype._diagnose=function(){
  var diag={cause:'UNKNOWN', detail:'', segLen:0, isLoop:false, sharpTurn:0};
  try{
    // Analyze position history for loop pattern
    if (this.hist.length >= 10){
      var first=this.hist[0], last=this.hist[this.hist.length-1];
      var endDist=Math.hypot(last.x-first.x, last.z-first.z);
      // If we ended near where we started after traveling far = loop
      var path=0;
      for (var i=1;i<this.hist.length;i++){
        path+=Math.hypot(this.hist[i].x-this.hist[i-1].x,
                         this.hist[i].z-this.hist[i-1].z);
      }
      if (path > 100 && endDist < 50){
        diag.cause='POSITION_LOOP';
        diag.detail='Traveled '+Math.round(path)+'u but ended '+
          Math.round(endDist)+'u from start — circular path';
      }
    }
    // Analyze the road segment if available (set by crew systems via u.seg)
    if (this._seg && this._seg.pts && this._seg.pts.length){
      var pts=this._seg.pts;
      diag.segLen=pts.length;
      // Check for loop: start ≈ end
      var s0=pts[0], sN=pts[pts.length-1];
      var loopD=Math.hypot(sN[0]-s0[0], sN[1]-s0[1]);
      if (loopD < 50){
        diag.isLoop=true;
        if (diag.cause==='UNKNOWN'){
          diag.cause='SEGMENT_LOOP';
          diag.detail='Road segment forms a closed loop ('+
            Math.round(loopD)+'u start-to-end gap)';
        }
      }
      // Check for sharp turns
      var maxAngle=0;
      for (var j=1;j<pts.length-1;j++){
        var v1x=pts[j][0]-pts[j-1][0], v1z=pts[j][1]-pts[j-1][1];
        var v2x=pts[j+1][0]-pts[j][0], v2z=pts[j+1][1]-pts[j][1];
        var l1=Math.hypot(v1x,v1z), l2=Math.hypot(v2x,v2z);
        if (l1>0.1 && l2>0.1){
          var cosA=Math.max(-1,Math.min(1,(v1x*v2x+v1z*v2z)/(l1*l2)));
          var ang=Math.acos(cosA)*180/Math.PI;
          if (ang>maxAngle) maxAngle=ang;
        }
      }
      diag.sharpTurn=Math.round(maxAngle);
      if (maxAngle > 90 && diag.cause==='UNKNOWN'){
        diag.cause='SHARP_TURN';
        diag.detail='Segment has '+Math.round(maxAngle)+'° turn — '+
          'geometrically difficult for vehicles';
      }
      // Check for short segment
      if (pts.length < 8 && diag.cause==='UNKNOWN'){
        diag.cause='SHORT_SEGMENT';
        diag.detail='Segment has only '+pts.length+' points — '+
          'too short for meaningful patrol';
      }
    }
  }catch(e){
    diag.detail='Diagnosis error: '+(e&&e.message||e);
  }
  return diag;
};
/* setSegment(seg) — v1.14: crew systems should call this when assigning a
   unit to a segment, so _diagnose() can analyze the road data. */
StuckDetector.prototype.setSegment=function(seg){
  this._seg=seg;
};
/* getDiagnosis() — v1.14: returns the last diagnosis object, or null if no
   stuck event has occurred yet. */
StuckDetector.prototype.getDiagnosis=function(){
  return this.diagnosis||null;
};
/* call after a recovery so the fresh start isn't judged on stale data */
StuckDetector.prototype.noteRecovery=function(){
  this.hist.length=0;
  this.cooldown=Math.max(this.cooldown, 30);
};

/* recoverStuckUnit(u, opts) — shared stuck recovery. Logs the filed report,
   blacklists the unit's current segment (cap 8), then hunts for a fresh
   patrol area: up to 14 random probes in a ±2000u box, each run through
   opts.nearestRoad. A candidate is rejected when: it's a stub (<8 points —
   the Utoy Circle problem), it's blacklisted, or it's within 500u of the
   stuck spot. On success opts.reposition(u, nr) moves the unit and the
   event is logged; on failure the unit holds position and the NEXT
   detection retries. Returns true/false.
   opts = { unitLabel, log(msg), toast(msg), nearestRoad(x,z)→{seg,idx}|null,
            reposition(u, nr), blacklist:[seg] }. */
function recoverStuckUnit(u, opts){
  var x=u.mesh.position.x, z=u.mesh.position.z;
  var where='('+Math.round(x)+', '+Math.round(z)+')';
  // v1.14: Include root-cause diagnosis in the report (Joshua's directive:
  // find WHY, not just THAT). The diagnosis comes from the unit's
  // StuckDetector, which analyzed the segment data at trigger time.
  var diagMsg='';
  try{
    if (u.stuck && typeof u.stuck.getDiagnosis==='function'){
      var d=u.stuck.getDiagnosis();
      if (d && d.cause && d.cause!=='UNKNOWN'){
        diagMsg=' Root cause: '+d.cause+
          (d.detail ? ' — '+d.detail : '')+'.';
        // v1.14: Track repeat stuck locations for automatic data-repair flagging.
        // If the same area causes 3+ stuck events, it's a DATA problem.
        trackStuckLocation(x, z, d.cause, opts.log);
      }
    }
  }catch(e){}
  opts.log('⚠️ '+opts.unitLabel+' STUCK IN A LOOP near '+where+
    ' — 80s of movement with no progress.'+diagMsg+
    ' Report filed, requesting reassignment.');
  try{ opts.toast('⚠️ '+opts.unitLabel+' was stuck in a loop — reassigning patrol'); }catch(e){}
  if (u.seg && opts.blacklist){
    if (opts.blacklist.indexOf(u.seg)<0) opts.blacklist.push(u.seg);
    while (opts.blacklist.length>8) opts.blacklist.shift();
  }
  var nr=null, tries=0;
  while (tries<14 && !nr){
    tries++;
    var ax=x+(Math.random()-0.5)*4000, az=z+(Math.random()-0.5)*4000;
    var cand=null;
    try{ cand=opts.nearestRoad(ax,az); }catch(e){ cand=null; }
    if (!cand||!cand.seg||!cand.seg.pts) continue;
    if (cand.seg.pts.length<MIN_SEG_PTS) continue;      // skip tiny stubs/loops
    if (opts.blacklist && opts.blacklist.indexOf(cand.seg)>=0) continue;
    var p=cand.seg.pts[Math.max(0,Math.min(cand.idx,cand.seg.pts.length-1))];
    if (Math.hypot(p[0]-x,p[1]-z)<REASSIGN_MIN_D) continue;
    nr=cand;
  }
  if (!nr){
    opts.log('⚠️ '+opts.unitLabel+' reassignment found no clear area — holding position, will retry on next detection.');
    return false;
  }
  opts.reposition(u, nr);
  var np=nr.seg.pts[Math.max(0,Math.min(nr.idx,nr.seg.pts.length-1))];
  opts.log('✅ '+opts.unitLabel+' reassigned to a new patrol area near ('+
    Math.round(np[0])+', '+Math.round(np[1])+') — resuming patrol, problem segment skipped.');
  return true;
}

/* ---------------- stuck-location tracking (v1.14) ---------------- */
/* trackStuckLocation(x, z, cause, logFn) — v1.14: automatic data-repair
   flagging (Joshua's directive: prevent it on its own).

   When the same map area (within 200u) causes 3+ stuck events, it's almost
   certainly a DATA problem (bad pins, broken geometry, impossible turn) —
   not a behavioral fluke. This function tracks stuck locations and logs a
   DATA REPAIR NEEDED alert when the threshold is hit.

   The alert includes the location and the diagnosed cause, so the data team
   knows exactly what to fix. Locations are also exposed via
   window.__stuckHotspots for the watcher/debugging tools. */
var _stuckHotspots=[];  // [{x, z, count, causes:{}, firstSeen, lastSeen}]
function trackStuckLocation(x, z, cause, logFn){
  try{
    var found=null;
    for (var i=0;i<_stuckHotspots.length;i++){
      var h=_stuckHotspots[i];
      if (Math.hypot(h.x-x, h.z-z) < 200){ found=h; break; }
    }
    if (!found){
      found={x:Math.round(x), z:Math.round(z), count:0, causes:{},
             firstSeen:Date.now(), lastSeen:Date.now()};
      _stuckHotspots.push(found);
    }
    found.count++;
    found.lastSeen=Date.now();
    found.causes[cause]=(found.causes[cause]||0)+1;
    // Threshold: 3 stuck events in the same area = DATA problem
    if (found.count===3 && logFn){
      var causeList=Object.keys(found.causes).map(function(k){
        return k+'×'+found.causes[k];
      }).join(', ');
      logFn('🔧 DATA REPAIR NEEDED near ('+found.x+', '+found.z+') — '+
        '3 stuck events in this area ('+causeList+'). '+
        'This is a road/data problem, not a behavior problem. '+
        'Check junction pins, road geometry, and terrain at this location.');
    }
  }catch(e){}
}

window.StuckDetector=StuckDetector;
window.recoverStuckUnit=recoverStuckUnit;
window.__stuckHotspots=_stuckHotspots;  // v1.14: expose for debugging/watcher
window.__stuckCfg={SAMPLE_EVERY:SAMPLE_EVERY, HISTORY_LEN:HISTORY_LEN,
  MIN_PATH:MIN_PATH, MAX_SPREAD:MAX_SPREAD, MAX_REVERSALS:MAX_REVERSALS,
  COOLDOWN:COOLDOWN, REASSIGN_MIN_D:REASSIGN_MIN_D, MIN_SEG_PTS:MIN_SEG_PTS};
})();
