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
function StuckDetector(){
  this.hist=[];        // [{x,z,dx,dz}] dx,dz = normalized move dir this sample
  this._acc=0;
  this.cooldown=0;
  this.events=0;
}
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
StuckDetector.prototype._trigger=function(){
  this.events++;
  this.cooldown=COOLDOWN;
  this.hist.length=0;
  return true;
};
/* call after a recovery so the fresh start isn't judged on stale data */
StuckDetector.prototype.noteRecovery=function(){
  this.hist.length=0;
  this.cooldown=Math.max(this.cooldown, 30);
};

/* ---------------- shared recovery ----------------
   opts: {
     unitLabel : string  ("Unit 2" / "Officer 3"),
     log       : function(msg),
     toast     : function(msg),
     nearestRoad: function(x,z) -> {seg, idx} | null   (any road ok),
     reposition: function(u, nr),
     blacklist : array   (bad segments are pushed here, max 8 kept)
   } */
function recoverStuckUnit(u, opts){
  var x=u.mesh.position.x, z=u.mesh.position.z;
  var where='('+Math.round(x)+', '+Math.round(z)+')';
  opts.log('⚠️ '+opts.unitLabel+' STUCK IN A LOOP near '+where+
    ' — 80s of movement with no progress. Report filed, requesting reassignment.');
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

window.StuckDetector=StuckDetector;
window.recoverStuckUnit=recoverStuckUnit;
window.__stuckCfg={SAMPLE_EVERY:SAMPLE_EVERY, HISTORY_LEN:HISTORY_LEN,
  MIN_PATH:MIN_PATH, MAX_SPREAD:MAX_SPREAD, MAX_REVERSALS:MAX_REVERSALS,
  COOLDOWN:COOLDOWN, REASSIGN_MIN_D:REASSIGN_MIN_D, MIN_SEG_PTS:MIN_SEG_PTS};
})();
