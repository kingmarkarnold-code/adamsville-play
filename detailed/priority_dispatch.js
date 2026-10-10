/* ============================================================================
   FILE: priority_dispatch.js — "Surviving Adamsville" PRIORITY DISPATCH
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-09 ~10:25pm EDT):
   All non-civilian NPCs (24/7 workers) converge on the Adamsville area and
   work overnight. Municipal workers STAY at their assigned tasks — they do
   NOT go to Adamsville. Everyone else goes.

   PRIORITY CORRIDORS (in order):
     1. I-285
     2. Martin Luther King Jr Dr (MLK)
     3. Fulton Industrial Blvd
     4. Boulder Park
     5. Dollar Mill Road
     6. Bakers Ferry Rd

   Crews work through these in priority order — 285 first, then MLK, etc.

   ADAMSVILLE ZONE (from Joshua's driving report 2026-10-09):
     - West: 1/4 mile west of Fulton Industrial Blvd
     - East: 1/4 mile east of I-285
     - North: ~1 mile north of MLK Jr Dr
     - South: Cascade Rd
     Corridor bounds extracted from roads.js 2026-10-09.

   ARCHITECTURE:
   This is a COORDINATOR module. It does not move units itself — it publishes
   the priority zone/corridors via window.PRIORITY_DISPATCH, and each crew
   system checks it in its targeting logic (minimal hooks, guarded).
   - Road crew patrols bias defect discovery toward priority corridors
   - Survey cars bias unexplored-segment picks toward priority corridors
   - Helicopters concentrate waypoints on priority corridors
   - Bird drones reassign patrol centers into the zone
   - Infra crew prioritizes issues in the zone
   - Municipal workforce (cityworkforce.js) is EXCLUDED per Joshua's order

   PERSISTENCE: active flag + activity log in localStorage['sa_prioritydispatch_v1'].
   The directive survives reloads until Joshua recalls it.

   PUBLIC API (window.PRIORITY_DISPATCH):
     active, corridors, zone,
     inZone(x,z), corridorAt(x,z), priorityAt(x,z),
     activate(), recall(), log (array), dlog(msg)

   STANDALONE MODULE. Include AFTER the crew systems in index.html:
       <script src="priority_dispatch.js"></script>
   Zero edits to index.html logic required. All hooks are guarded — if a crew
   system is missing, this module still loads and the game is unaffected.
   ============================================================================ */
(function(){
'use strict';
if (window.PRIORITY_DISPATCH) return;  // single instance

/* ---------------- corridor definitions ----------------
   Bounds extracted from roads.js (2026-10-09). priority: 0 = highest.
   keywords: matched against road names (lowercase) for corridor assignment. */
var CORRIDORS=[
  {name:'I-285', priority:0,
   keywords:['i-285','i285'],
   xMin:3879, xMax:8031, zMin:-195, zMax:8415,
   note:'Interstate loop — highest priority'},
  {name:'Martin Luther King Jr Dr', priority:1,
   keywords:['martin luther king','mlk'],
   xMin:2890, xMax:8130, zMin:2264, zMax:3460,
   note:'MLK Jr Dr — east-west arterial'},
  {name:'Fulton Industrial Blvd', priority:2,
   keywords:['fulton industrial'],
   xMin:247, xMax:4212, zMin:1763, zMax:5581,
   note:'Fulton Industrial corridor'},
  {name:'Boulder Park', priority:3,
   keywords:['boulder park','boulders park'],
   xMin:1740, xMax:4313, zMin:3302, zMax:4824,
   note:'Boulder Park area'},
  {name:'Dollar Mill Rd', priority:4,
   keywords:['dollar mill'],
   xMin:3064, xMax:3155, zMin:3286, zMax:3712,
   note:'Dollar Mill Rd (home base area)'},
  {name:'Bakers Ferry Rd', priority:5,
   keywords:['bakers ferry','baker ferry'],
   xMin:1544, xMax:3842, zMin:2967, zMax:4356,
   note:'Bakers Ferry Rd'}
];

/* ---------------- Adamsville priority zone ----------------
   Bounding box covering the focus area. Derived from Joshua's boundaries:
   1/4 mi west of Fulton Industrial, 1/4 mi east of I-285,
   ~1 mi north of MLK, south to Cascade Rd.
   Scale estimate: ~425 units/mile (map spans ~20 miles over ~8500 units). */
var ZONE={
  xMin:100, xMax:5200,
  zMin:1800, zMax:4700,
  name:'Adamsville Priority Zone'
};

var LS_KEY='sa_prioritydispatch_v1';

/* ---------------- state ---------------- */
var PD={
  active:true,  // Joshua's order: active immediately on load
  corridors:CORRIDORS,
  zone:ZONE,
  log:[],
  activatedAt:null
};

/* ---------------- persistence ---------------- */
function saveLS(){
  try{
    window.localStorage.setItem(LS_KEY, JSON.stringify({
      active:PD.active,
      activatedAt:PD.activatedAt,
      log:PD.log.slice(-100)  // keep last 100 entries
    }));
  }catch(e){}
}
function loadLS(){
  try{
    var raw=window.localStorage.getItem(LS_KEY);
    if(!raw) return;
    var o=JSON.parse(raw);
    if(typeof o.active==='boolean') PD.active=o.active;
    if(o.activatedAt) PD.activatedAt=o.activatedAt;
    if(o.log && o.log.length) PD.log=o.log;
  }catch(e){}
}

/* ---------------- logging ---------------- */
function dlog(msg){
  var entry={t:new Date().toISOString(), msg:msg};
  PD.log.push(entry);
  if(PD.log.length>200) PD.log=PD.log.slice(-200);
  saveLS();
  try{ if(typeof Report!=='undefined') Report.note('prioritydispatch', msg); }catch(e){}
}

/* ---------------- zone/corridor queries ---------------- */
/* inZone(x,z) — is this point inside the Adamsville priority zone? */
function inZone(x,z){
  return x>=ZONE.xMin && x<=ZONE.xMax && z>=ZONE.zMin && z<=ZONE.zMax;
}
/* corridorAt(x,z) — which priority corridor contains this point?
   Returns the corridor object (highest priority wins on overlap), or null. */
function corridorAt(x,z){
  var best=null;
  for(var i=0;i<CORRIDORS.length;i++){
    var c=CORRIDORS[i];
    if(x>=c.xMin && x<=c.xMax && z>=c.zMin && z<=c.zMax){
      if(!best || c.priority<best.priority) best=c;
    }
  }
  return best;
}
/* priorityAt(x,z) — priority rank 0-5 at this point, or 99 if outside all corridors. */
function priorityAt(x,z){
  var c=corridorAt(x,z);
  return c ? c.priority : 99;
}
/* corridorForRoad(roadName) — match a road name to its corridor (for targeting). */
function corridorForRoad(roadName){
  if(!roadName) return null;
  var n=String(roadName).toLowerCase();
  for(var i=0;i<CORRIDORS.length;i++){
    var c=CORRIDORS[i];
    for(var k=0;k<c.keywords.length;k++){
      if(n.indexOf(c.keywords[k])>=0) return c;
    }
  }
  return null;
}

/* ---------------- control ---------------- */
function activate(){
  PD.active=true;
  PD.activatedAt=new Date().toISOString();
  dlog('PRIORITY DISPATCH ACTIVATED — all non-civilian crews to Adamsville corridors (I-285 → MLK → Fulton Industrial → Boulder Park → Dollar Mill → Bakers Ferry). Municipal workers hold position.');
  saveLS();
  try{ if(typeof toast==='function') toast('🚨 Priority dispatch: all crews to Adamsville'); }catch(e){}
}
function recall(){
  PD.active=false;
  dlog('Priority dispatch RECALLED — crews resuming normal patrol patterns.');
  saveLS();
  try{ if(typeof toast==='function') toast('Priority dispatch recalled — normal operations'); }catch(e){}
}

/* ---------------- corridor inspection seeding ----------------
   When priority dispatch activates, file inspection issues at intervals along
   each priority corridor so the infra crew rolls out to check signs, signals,
   and road surface. Dedup in reportIssue prevents duplicates on re-activation.
   One seed per ~600u of corridor length, capped for sanity. */
var _seeded=false;
function seedCorridorInspections(){
  if (_seeded || !PD.active) return;
  try{
    if(!window.INFRACREW || typeof window.INFRACREW.reportIssue!=='function') return;
  }catch(e){ return; }
  try{
    var count=0;
    CORRIDORS.forEach(function(cor){
      // clamp corridor to zone for seeding
      var x0=Math.max(ZONE.xMin,cor.xMin), x1=Math.min(ZONE.xMax,cor.xMax);
      var z0=Math.max(ZONE.zMin,cor.zMin), z1=Math.min(ZONE.zMax,cor.zMax);
      if(x1<=x0){ x0=ZONE.xMin; x1=ZONE.xMax; }
      if(z1<=z0){ z0=ZONE.zMin; z1=ZONE.zMax; }
      var dx=x1-x0, dz=z1-z0;
      var len=Math.sqrt(dx*dx+dz*dz);
      var n=Math.min(8, Math.max(2, Math.floor(len/600)));
      for(var i=0;i<n;i++){
        var t=(i+0.5)/n;
        var sx=x0+dx*t, sz=z0+dz*t;
        // jitter so crews don't stack on the exact centerline
        sx+=(Math.random()-0.5)*120;
        sz+=(Math.random()-0.5)*120;
        window.INFRACREW.reportIssue({
          kind:'road',
          x:Math.round(sx), z:Math.round(sz),
          street:cor.name+' (priority inspection)',
          desc:'Priority dispatch overnight sweep: inspect road surface, signs, and signals along '+cor.name+'.'
        });
        count++;
      }
    });
    _seeded=true;
    dlog('Seeded '+count+' priority corridor inspection issues for infra crew (Adamsville overnight sweep).');
  }catch(e){}
}

/* ---------------- bird drone redirection ----------------
   The 100 bird-disguised inspection drones each patrol a fixed sector.
   When priority dispatch is active, reassign their patrol centers into the
   Adamsville priority corridors — spread across all 6 corridors by priority
   (more birds on higher-priority corridors). Runs once at boot; re-runs if
   the fleet re-initializes. */
var _birdsRedirected=false;
function redirectBirds(){
  if (_birdsRedirected) return;
  var BD=null;
  try{ BD=window.BIRD_DRONES; }catch(e){}
  if (!BD || !BD.birds || !BD.birds.length) return;  // fleet not ready yet
  if (!PD.active) return;
  try{
    // Assign birds to corridors by priority: I-285 gets the most, then MLK, etc.
    // Weights: 30, 25, 20, 12, 8, 5 = 100 birds
    var weights=[30,25,20,12,8,5];
    var assignments=[];
    for(var c=0;c<CORRIDORS.length;c++){
      for(var k=0;k<weights[c];k++) assignments.push(c);
    }
    var rng=(typeof mulberry32==='function')?mulberry32(0xADA1):Math.random;
    if(typeof rng==='function' && rng.length!==0){ /* seeded */ }
    // shuffle assignments
    for(var i=assignments.length-1;i>0;i--){
      var j=Math.floor(Math.random()*(i+1));
      var t=assignments[i]; assignments[i]=assignments[j]; assignments[j]=t;
    }
    for(var b=0;b<BD.birds.length && b<assignments.length;b++){
      var bird=BD.birds[b];
      var cor=CORRIDORS[assignments[b]];
      // random point inside the corridor bounds (clamped to zone)
      var zx=Math.max(ZONE.xMin,cor.xMin), zx2=Math.min(ZONE.xMax,cor.xMax);
      var zz=Math.max(ZONE.zMin,cor.zMin), zz2=Math.min(ZONE.zMax,cor.zMax);
      if(zx2<=zx){ zx=ZONE.xMin; zx2=ZONE.xMax; }
      if(zz2<=zz){ zz=ZONE.zMin; zz2=ZONE.zMax; }
      bird.cx=zx+Math.random()*(zx2-zx);
      bird.cz=zz+Math.random()*(zz2-zz);
      // tighten patrol ellipse for focused corridor coverage
      bird.rx=120+Math.random()*150;
      bird.rz=120+Math.random()*150;
      try{
        var gy=heightAt(bird.cx,bird.cz);
        bird.alt=gy+28+Math.random()*38;
      }catch(e){}
    }
    _birdsRedirected=true;
    dlog('100 bird-drones reassigned to Adamsville priority corridors (I-285×30, MLK×25, Fulton Industrial×20, Boulder Park×12, Dollar Mill×8, Bakers Ferry×5).');
  }catch(e){}
}

/* ---------------- boot ---------------- */
function init(){
  loadLS();
  // Joshua's standing order: active on load unless explicitly recalled.
  // If no saved state, activate now.
  try{
    var raw=window.localStorage.getItem(LS_KEY);
    if(!raw){
      activate();
    } else if(PD.active){
      dlog('Priority dispatch still ACTIVE from previous session — crews holding Adamsville focus.');
    }
  }catch(e){
    if(!PD.activatedAt) activate();
  }
  try{
    if(typeof Report!=='undefined') Report.setSys('prioritydispatch',
      {status:PD.active?'active':'standby', version:'1.0',
       corridors:CORRIDORS.map(function(c){return c.name;}),
       zone:ZONE.name,
       note:'Joshua 2026-10-09: non-civilian crews converge on Adamsville; municipal workers hold position'});
  }catch(e){}
}

/* ---------------- public API ---------------- */
window.PRIORITY_DISPATCH={
  get active(){ return PD.active; },
  corridors:CORRIDORS,
  zone:ZONE,
  inZone:inZone,
  corridorAt:corridorAt,
  priorityAt:priorityAt,
  corridorForRoad:corridorForRoad,
  activate:activate,
  recall:recall,
  log:PD.log,
  dlog:dlog
};

/* boot poll — wait for localStorage/Report only; no THREE dependency.
   Retries bird redirection until the fleet is ready. */
var bootTries=0;
var bootTimer=setInterval(function(){
  bootTries++;
  try{
    init();
    /* redirect birds once the fleet exists (may take a few seconds) */
    if (PD.active && !_birdsRedirected){
      redirectBirds();
    }
    /* seed corridor inspections once infra crew is ready */
    if (PD.active && !_seeded){
      seedCorridorInspections();
    }
    if ((_birdsRedirected && _seeded) || bootTries>40){
      clearInterval(bootTimer);
    }
  }catch(e){
    if(bootTries>20){
      clearInterval(bootTimer);
      try{ if(typeof Report!=='undefined') Report.noteError('prioritydispatch','init failed',String(e&&e.message||e)); }catch(x){}
    }
  }
},500);

})();
