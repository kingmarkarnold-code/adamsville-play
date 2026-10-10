/* ============================================================================
   FILE: veteran_crew.js — "Surviving Adamsville" 30-YEAR VETERAN CREW INTELLIGENCE
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-09):
     Every crew member has the intelligence of someone who's worked the job
     30+ years. They are NOT random NPCs that look busy — when dispatched,
     each crew follows the EXPERT WORKFLOW:
       1. ASSESS   — the foreman walks the site and diagnoses it with
                     veteran eyes: what's actually wrong, what's the root
                     cause, what's the proper fix.
       2. REPORT   — a detailed field report is written up: problem
                     description, root-cause analysis, recommended fix,
                     materials needed, estimated time, veteran note.
       3. DISPATCH — the report goes back to dispatch through the crew's
                     in-game dispatch log (persisted, HUD-visible).
       4. SETUP    — workers walk out and take their stations; the work
                     zone goes live.
       5. FIX      — the repair is executed with expert technique — a
                     proper permanent fix, not a hack. No shortcuts.
       6. VERIFY   — the foreman walks the finished repair, inspects every
                     inch, and signs off before the crew leaves.
       7. AUTO-SAVE— the crew's normal finish path persists the fix through
                     the existing registries (roadcrew / infracrew /
                     codeenforce localStorage + roadfix's unified registry).

   SHARED MODULE. Loaded BEFORE codeenforce_system.js, roadcrew_system.js,
   and infracrew_system.js — each crew system calls into window.VeteranCrew
   when it dispatches a repair job. Zero scene dependency at load time;
   every external is touched lazily and guarded, so a missing THREE or a
   missing crew system degrades to a no-op, never a crash.

   PUBLIC API (window.VeteranCrew):
     jobState(opts)            — build the vet state for a new repair job.
                                 opts: {crew, kind, issue, fixDur, siteR,
                                 truckPos:{x,z}, workerTargets:[{x,z}],
                                 foremanStyle}
     makeForeman(style)        — veteran foreman figure ('road' | 'infra' |
                                 'constr'). White/gray hard hat + clipboard —
                                 instantly distinct from the crew.
     updateJob(job, dt, ctx)   — drive the phase machine. ctx: {time,
                                 log(msg), toast(msg)}. Returns the current
                                 phase name, or 'done' when the verify phase
                                 finished (caller then runs its normal
                                 finish + job splice).
     assess(issue, crew, foreman)
                               — generate the expert assessment object.
     fileReport(issue, assessment, crew)
                               — persist the report, return the report record.
     reportLine(report)        — one-line dispatch-log rendering of a report.
     fieldNote(kind)           — veteran one-liner for patrol discovery logs.
     radio(phase, vet)         — radio chatter line for a phase.
     listReports()             — persisted reports (oldest first).

   PHASES (durations in seconds; 'fixing' uses the crew's own work window):
     arriving  (5)  — crew on site, staging by the truck.
     assessing (18) — foreman walks the full perimeter, clipboard up.
     reporting (8)  — foreman radios dispatch; the field report is filed.
     setup     (12) — workers walk out to their stations, staggered.
     fixing    (crew work window) — expert repair; radio at 25/50/75%.
     verifying (10) — foreman walks the finished work, bends to inspect,
                      then signs off.
   ============================================================================ */
(function(){
'use strict';
/* Single-instance guard — never double-install if the tag loads twice. */
if (window.VeteranCrew) return;

/* ---------------- config ---------------- */
var LS_REPORTS='sa_veteran_reports_v1';  // persisted field-report registry
var MAX_REPORTS=100;                     // cap the registry
/* Phase durations (seconds). 'fixing' always uses the crew's own window. */
var PHASE_DUR={arriving:5, assessing:18, reporting:8, setup:12, verifying:10};
var WALK_SPEED=5.5;   // foreman/worker walk speed (u/s)

/* ---------------- tiny helpers (module-local, guarded) ---------------- */
function _gY(x,z){ try{ var y=heightAt(x,z); return isFinite(y)?y:0; }catch(e){ return 0; } }
function _nowT(){ var d=new Date(); function p(n){return (n<10?'0':'')+n;} return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
function _pick(a,i){ if(!a||!a.length) return ''; i=Math.abs(i|0); return a[i%a.length]; }
function _short(s,n){ s=String(s||''); return s.length>n ? s.slice(0,n-3)+'...' : s; }

/* ---------------- foreman names ----------------
   Thirty-year veterans all have a name the crew actually uses. Assigned
   round-robin so every job gets its own foreman. */
var FOREMAN_NAMES=['Deacon','Big Mike','Sarge','Pops','Mack','Red','Sonny',
  'Hank','Preacher','T-Bone','Walt','Gus',
  /* v1.1 CREW 5X (Joshua 2026-10-09): expanded roster for 5x crews */
  'Chief','Dusty','Iron','Slim','Bubba','Tank','Cletus','Roscoe','Jed','Elmer',
  'Virgil','Otis','Grady','Floyd','Lester','Buford','Jethro','Cooter','Enos',
  'Boss','Doc','Sarge2','Gunny','Top','Chief2','Duke','Ace','Tex','Buck','Colt'];
var _foremanSeq=0;
function _nextForeman(){ return FOREMAN_NAMES[(_foremanSeq++)%FOREMAN_NAMES.length]; }
var _chatterIdx=0;  // rotates radio lines + field notes so they don't repeat

/* ---------------- veteran voice ----------------
   Plain-spoken, seen-it-all, no fluff. Every line below reads like
   something a 30-year man would actually say on the radio. */
var RADIO={
 arriving:[
  'Foreman {F}: crew on site — everybody out, let\'s see what we got.',
  '{C} rolling in. Foreman {F} taking the lead.'],
 assessing:[
  'Walking the whole site before anybody touches a thing.',
  'Seen this a hundred times — still gonna look twice.',
  '{F}: nobody moves till I\'ve walked the full perimeter.'],
 reporting:[
  'Dispatch, {F} — report {R} filed. Root cause: {RC}',
  'Paperwork\'s done, dispatch has the full write-up. We\'re cleared to work.'],
 setup:[
  'Cones and signs — do it like the book says.',
  'Work zone\'s live. Nobody past the cones.'],
 fixing25:[
  'Doing it right, not doing it twice.',
  '{F}: the first quarter is the prep — prep right and the rest follows.'],
 fixing50:[
  'Halfway there — no shortcuts.',
  '{F}: the middle of the job is where rookies rush. We don\'t rush.'],
 fixing75:[
  'Buttoning it up — last pass now.',
  '{F}: almost home. Finish like you started.'],
 verifying:[
  'Walking it now — gonna put eyes on every inch.',
  '{F}: if it ain\'t right, we ain\'t leaving. Checking now.'],
 done:[
  'That\'s solid. Signing off — {R} closed.',
  'Site\'s clean, crew\'s clear. {R} closed out.']
};
/* radio(phase, vet) — a radio chatter line for a phase. {F}=foreman name,
   {C}=crew label, {R}=report id, {RC}=short root cause. */
function radio(phase, vet){
  var lines=RADIO[phase]||[];
  if(!lines.length||!vet) return '';
  var s=_pick(lines,_chatterIdx++);
  return s.split('{F}').join('Foreman '+vet.foremanName)
          .split('{C}').join(vet.crew)
          .split('{R}').join(vet.report?vet.report.id:'report')
          .split('{RC}').join(vet.assessment?_short(vet.assessment.rootCause,90):'');
}
/* FIELD_NOTES — veteran one-liners patrols drop in the dispatch log when
   they spot something. fieldNote(kind) -> string. */
var FIELD_NOTES={
 road:['That ribbon\'s been wrong since the lift pass — I\'ll get eyes on it.',
       'Thirty years and I can smell a bad pin from the truck. Checking it out.'],
 signal:['Signal\'s out — that intersection\'s flying blind. Sending it up.',
         'Dark signal. Somebody\'s gonna get hurt if we don\'t move on this.'],
 sign:['Sign\'s turned — or it was never set right. Flagging it for the sign crew.',
       'Can\'t read that sign from the lane. That\'s a fix, not a suggestion.'],
 building:['That footprint\'s on the right-of-way — code\'s gonna want to see this.',
          'Building\'s turned wrong to the street. Seen it before, know the fix.']
};
function fieldNote(kind){
  return _pick(FIELD_NOTES[kind]||FIELD_NOTES.road,_chatterIdx++);
}

/* ---------------- assessment engine ----------------
   assess(issue, crew, foreman) -> assessment object:
     {kind, foreman, problem, rootCause, recommendation, materials[],
      estMin, confidence, note, observations[]}
   The foreman "reads" the issue with 30 years of pattern-matching:
   problem = what the report says; rootCause = what his eyes say;
   recommendation = the proper permanent fix. */
var CAUSE_RC={
 'pin-pull':'Junction pin got yanked below grade by the terrain-lift pass — the ribbon\'s following bad data, not bad ground.',
 'road-elevation':'Ribbon elevation drifted off the terrain — the road thinks it\'s somewhere it ain\'t.',
 'road-clip':'Ribbon\'s clipping through the grade — the seat\'s wrong, not the road.',
 'collider-block':'Stray collider sitting in the travel lane — phantom wall, nothing physical there.',
 'seg-loop':'Segment geometry loops on itself — that\'s a data cut. Needs the dev team to re-cut it.',
 'stub-segment':'Stub segment dead-ends in the grass — needs the dev team to tie it in or trim it.',
 'sharp-turn':'Turn\'s too sharp for the ribbon — geometry needs re-cutting by the dev team.',
 'rough-terrain':'Ground under this road is rough — heightfield data needs rebuilding. That\'s dev-team work.'
};
var ASSESS_T={
 road:{
  obs:['Ribbon\'s been pulling at this pin since the last lift pass — seen it a hundred times.',
       'Shoulder\'s holding, so this is data-side, not washout.',
       'No standing water — drainage ain\'t the culprit.'],
  rc:'Segment geometry\'s off — walking it to confirm, then we fix what the ground tells us.',
  rec:'Re-survey to grade, re-seat the ribbon, lay fresh asphalt over the seam. Do it right once — don\'t come back twice.',
  materials:['asphalt patch','16 cones','2 ROAD WORK AHEAD signs','2 DETOUR signs','6 ground arrows'],
  estMin:2},
 signal:{
  obs:['Head\'s dark from every approach — not a bulb flicker, a full outage.',
       'Pole\'s plumb, so it ain\'t wind damage. Electrical.',
       'Ped heads are dark too — whole cabinet\'s down, not just one lamp.'],
  rc:'Bulb\'s burned out or the controller dropped the phase — either way this intersection\'s flying blind.',
  rec:'Swap the head, check the controller, verify all three phases before we clear the site.',
  materials:['replacement signal head','bucket truck','8 cones','2 SIGNAL CREW AHEAD signs'],
  estMin:2},
 sign:{
  obs:['Can\'t read it from the lane at speed — that\'s the whole test.',
       'Mounting bolts are loose — wind\'s been working on it a while.',
       'It\'s on the wrong side for the approach — never should\'ve passed inspection.'],
  rc:'Sign\'s out of position per SignRules — wind, a knock, or it was never set right to begin with.',
  rec:'Re-set the sign on the proper side at the proper offset, face it square to traffic, verify readability from the lane.',
  materials:['post driver','level','8 cones','2 SIGN CREW AHEAD signs'],
  estMin:1},
 encroach:{
  obs:['Footprint\'s over the right-of-way line — tape don\'t lie.',
       'Curb line\'s clean, so the building moved, not the street.',
       'Setback\'s short on the whole face — bad placement data, not bad concrete.'],
  rc:'Footprint\'s sitting on the right-of-way — bad placement data, not bad concrete.',
  rec:'Shift the footprint clear of the road, square it to the lot, verify against the spec board before we clear.',
  materials:['scaffolding','6 barriers','UNDER RENOVATION sign','survey tape'],
  estMin:2},
 sideways:{
  obs:['Entrance ain\'t facing the street — you can tell from the sidewalk.',
       'Whole building\'s clocked ninety degrees off the lot.',
       'Windows face the alley. Nobody builds like that on purpose.'],
  rc:'Building\'s turned wrong to the street — entrance ain\'t facing the road.',
  rec:'Rotate the footprint square to the street, re-seat it on the lot, verify the entrance faces the road.',
  materials:['scaffolding','6 barriers','UNDER RENOVATION sign','survey tape'],
  estMin:2}
};
function assess(issue, crew, foreman){
  issue=issue||{};
  var kind=issue.kind||'road';
  var t=ASSESS_T[kind]||ASSESS_T.road;
  /* root cause: the foreman pattern-matches the diagnosed cause first,
     falls back to the kind template. */
  var rc=(issue.cause&&CAUSE_RC[issue.cause])||t.rc;
  var a={
    kind:kind, foreman:foreman||'Foreman',
    problem:String(issue.desc||issue.truth||'reported defect at site'),
    rootCause:rc,
    /* recommendation: prefer the dispatch spec-board fix when the issue
       carries one (roadcrew/codeenforce truth data), else the template. */
    recommendation:String(issue.fix||t.rec),
    materials:t.materials.slice(), estMin:t.estMin,
    confidence:'high — thirty years, I know what I\'m looking at',
    note:_pick(t.obs,Math.abs(Math.round((issue.x||0)+(issue.z||0)))),
    observations:t.obs.slice()
  };
  return a;
}

/* ---------------- report registry ----------------
   Every field report is persisted (localStorage) so the paper trail
   survives sessions. The report id is also stamped on the issue
   (issue.vetReportId) for cross-reference in the crew's own log. */
var _reports=[];
var _repSeq=1;
function _loadReports(){
  try{
    var raw=null;
    try{ raw=window.localStorage.getItem(LS_REPORTS); }catch(e){ return; }
    if(!raw) return;
    var o=JSON.parse(raw);
    if(o&&o.reports&&o.reports.length) _reports=o.reports.slice(-MAX_REPORTS);
    if(o&&o.seq) _repSeq=o.seq;
  }catch(e){}
}
function _saveReports(){
  try{
    try{ window.localStorage.setItem(LS_REPORTS,
      JSON.stringify({reports:_reports.slice(-MAX_REPORTS), seq:_repSeq})); }catch(e){}
  }catch(e){}
}
_loadReports();
/* fileReport(issue, assessment, crew) — persist the report, stamp the
   issue, return the report record. */
function fileReport(issue, a, crew){
  issue=issue||{}; a=a||{};
  var id='RPT-'+(_repSeq++);
  var r={id:id, t:_nowT(), ts:Date.now(), crew:String(crew||'CREW'),
    foreman:String(a.foreman||'Foreman'),
    site:String(issue.street||'site')+' ('+Math.round(issue.x||0)+', '+Math.round(issue.z||0)+')',
    kind:String(a.kind||issue.kind||'road'),
    problem:String(a.problem||''), rootCause:String(a.rootCause||''),
    recommendation:String(a.recommendation||''),
    materials:(a.materials||[]).slice(), estMin:a.estMin||1,
    confidence:String(a.confidence||''), note:String(a.note||'')};
  _reports.push(r);
  while(_reports.length>MAX_REPORTS) _reports.shift();
  _saveReports();
  try{ issue.vetReportId=id; }catch(e){}
  return r;
}
/* reportLine(r) — one-line rendering of a report for the dispatch log. */
function reportLine(r){
  return '📋 FIELD REPORT '+r.id+' — Foreman '+r.foreman+' ('+r.crew+')'+
    ' | SITE: '+r.site+
    ' | PROBLEM: '+_short(r.problem,110)+
    ' | ROOT CAUSE: '+_short(r.rootCause,130)+
    ' | FIX: '+_short(r.recommendation,130)+
    ' | MATERIALS: '+r.materials.join(', ')+
    ' | EST: ~'+r.estMin+' min'+
    ' | VETERAN NOTE: "'+r.note+'"';
}
function listReports(){ return _reports.slice(); }

/* ---------------- foreman figure ----------------
   makeForeman(style) — the veteran. White or gray hard hat (nobody else
   on the crew wears one) + clipboard in the left hand + the crew's vest
   colors so he reads as THEIR foreman. style: 'road' | 'infra' | 'constr'.
   Returns a THREE.Group with userData.armL/armR/clipboard. */
function _mat(color, emissive){
  try{ return new THREE.MeshLambertMaterial({color:color, emissive:emissive||0x000000}); }
  catch(e){ return null; }
}
function _box(w,h,d,color,emissive){
  try{ return new THREE.Mesh(new THREE.BoxGeometry(w,h,d), _mat(color,emissive)); }
  catch(e){ return null; }
}
var FOREMAN_STYLE={
 road: {vest:0xff6a00, vestEm:0x5e2400, hat:0xf4f4f4},
 infra:{vest:0xa8d800, vestEm:0x3a4a00, hat:0x9aa0a8},
 constr:{vest:0xffc400, vestEm:0x4a3200, hat:0xf4f4f4}
};
function makeForeman(style){
  var st=FOREMAN_STYLE[style]||FOREMAN_STYLE.road;
  var g=null;
  try{
    g=new THREE.Group();
    var legs=_box(0.5,0.7,0.34,0x2b2f3a); legs.position.y=0.35; g.add(legs);
    var torso=new THREE.Mesh(new THREE.BoxGeometry(0.64,0.74,0.42),
      new THREE.MeshLambertMaterial({color:st.vest, emissive:st.vestEm}));
    torso.position.y=1.07; g.add(torso);
    var stripe=new THREE.Mesh(new THREE.BoxGeometry(0.66,0.1,0.44),
      new THREE.MeshLambertMaterial({color:0xf2f2f2, emissive:0x555555}));
    stripe.position.y=1.2; g.add(stripe);
    var head=_box(0.37,0.37,0.37,0x6b4429); head.position.y=1.62; g.add(head);
    /* white/gray hard hat — the foreman's mark. Nobody else wears one. */
    var hat=new THREE.Mesh(new THREE.BoxGeometry(0.46,0.17,0.46),
      new THREE.MeshLambertMaterial({color:st.hat, emissive:0x2a2a2a}));
    hat.position.y=1.86; g.add(hat);
    var armL=new THREE.Mesh(new THREE.BoxGeometry(0.16,0.6,0.16),
      new THREE.MeshLambertMaterial({color:st.vest, emissive:st.vestEm}));
    armL.position.set(-0.42,1.06,0); g.add(armL);
    var armR=armL.clone(); armR.position.set(0.42,1.06,0); g.add(armR);
    /* clipboard in the left hand — the veteran's other tool. */
    var clip=_box(0.3,0.05,0.42,0x8a5a2b);
    if(clip){ clip.position.set(-0.42,0.72,0.18); clip.rotation.x=-0.35; g.add(clip); }
    g.userData.armL=armL; g.userData.armR=armR;
    g.userData.clipboard=clip||null; g.userData.isForeman=true;
  }catch(e){ return null; }
  return g;
}
/* raiseClipboard(fig, on) — foreman holds the clipboard up while
   assessing/reporting, drops it while supervising. */
function raiseClipboard(fig, on){
  try{
    var a=fig&&fig.userData&&fig.userData.armL;
    if(a) a.rotation.x=on?-1.15:0;
  }catch(e){}
}

/* ---------------- job state ----------------
   jobState(opts) — the vet state attached to a repair job (job.vet).
   opts: {crew, kind, issue, fixDur, siteR, truckPos:{x,z},
          workerTargets:[{x,z}], foremanStyle} */
function jobState(opts){
  opts=opts||{};
  var issue=opts.issue||{};
  return {
    phase:'arriving', phaseT:0, entered:false,
    crew:String(opts.crew||'CREW'), kind:String(opts.kind||issue.kind||'road'),
    issue:issue, foremanName:_nextForeman(),
    foremanStyle:String(opts.foremanStyle||'road'),
    fixDur:Number(opts.fixDur)||60, siteR:Number(opts.siteR)||9,
    truckPos:opts.truckPos||{x:issue.x||0, z:issue.z||0},
    workerTargets:(opts.workerTargets||[]).slice(),
    assessment:null, report:null,
    wpIdx:0, waypoints:[], verIdx:0, verT:0, verPts:[],
    milestones:{}, supT:0, supTarget:-1, setupDone:{}
  };
}

/* ---------------- walking ----------------
   _walkTo(fig, tx, tz, dt, time) — move a figure toward (tx,tz) with
   facing + walk bob. Returns true when arrived. Guarded throughout. */
function _walkTo(fig, tx, tz, dt, time){
  try{
    var dx=tx-fig.position.x, dz=tz-fig.position.z;
    var d=Math.sqrt(dx*dx+dz*dz);
    if(d<0.9){
      try{ fig.position.y=_gY(fig.position.x,fig.position.z); }catch(e){}
      return true;
    }
    var step=Math.min(d, WALK_SPEED*dt);
    fig.position.x+=dx/d*step; fig.position.z+=dz/d*step;
    fig.position.y=_gY(fig.position.x,fig.position.z)+Math.abs(Math.sin(time*9))*0.09;
    fig.rotation.y=Math.atan2(dx,dz);
    return false;
  }catch(e){ return true; }
}
/* _idleBob(fig, time, k) — subtle standing idle so staged crew look alive. */
function _idleBob(fig, time, k){
  try{
    fig.position.y+=Math.sin(time*2.2+(k||0)*1.7)*0.008;
    fig.rotation.y+=Math.sin(time*0.6+(k||0))*0.004;
  }catch(e){}
}

/* ---------------- phase machine ---------------- */
function _nextPhase(p){
  return p==='arriving'?'assessing':
         p==='assessing'?'reporting':
         p==='reporting'?'setup':
         p==='setup'?'fixing':
         p==='fixing'?'verifying':
         p==='verifying'?'done':'done';
}
/* _siteXY(vet) — the issue's ground position. */
function _siteXY(vet){
  var d=vet.issue||{};
  return {x:Number(d.x)||0, z:Number(d.z)||0};
}
/* _enterPhase(job, vet, phase, ctx) — phase-entry behavior: build
   waypoints, file the report, fire radio chatter. */
function _enterPhase(job, vet, phase, ctx){
  vet.phase=phase; vet.phaseT=0; vet.entered=true;
  var fm=job.foreman, s=_siteXY(vet);
  try{
    if(phase==='arriving'){
      /* crew's out of the truck, staging. Foreman takes the lead. */
      if(ctx&&ctx.log) ctx.log('['+vet.crew+'] '+radio('arriving',vet));
    }
    else if(phase==='assessing'){
      /* foreman walks the full perimeter — 8 waypoints around the site. */
      vet.waypoints=[]; vet.wpIdx=0;
      for(var i=0;i<8;i++){
        var a=i/8*Math.PI*2;
        vet.waypoints.push({x:s.x+Math.cos(a)*vet.siteR, z:s.z+Math.sin(a)*vet.siteR});
      }
      raiseClipboard(fm,true);
      if(ctx&&ctx.log) ctx.log('['+vet.crew+'] '+radio('assessing',vet));
    }
    else if(phase==='reporting'){
      /* the write-up: assess, file, send to dispatch. */
      raiseClipboard(fm,true);
      vet.assessment=assess(vet.issue, vet.crew, vet.foremanName);
      vet.report=fileReport(vet.issue, vet.assessment, vet.crew);
      if(ctx&&ctx.log) ctx.log(reportLine(vet.report));
      if(ctx&&ctx.toast) ctx.toast('📋 Foreman '+vet.foremanName+' filed '+vet.report.id+' — '+_short(vet.assessment.rootCause,80));
      if(ctx&&ctx.log) ctx.log('['+vet.crew+'] '+radio('reporting',vet));
      /* foreman heads back to the truck to radio it in. */
      vet._reportWalk=true;
    }
    else if(phase==='setup'){
      raiseClipboard(fm,false);
      vet.setupDone={};
      if(ctx&&ctx.log) ctx.log('['+vet.crew+'] '+radio('setup',vet));
      /* foreman takes a supervise post at the site edge. */
      vet._supPost={x:s.x+vet.siteR*0.7, z:s.z-vet.siteR*0.7};
    }
    else if(phase==='fixing'){
      vet.milestones={};
      /* workers should be at their stations; foreman supervises. */
    }
    else if(phase==='verifying'){
      /* three inspection points across the finished work. */
      vet.verPts=[{x:s.x-vet.siteR*0.45,z:s.z},{x:s.x,z:s.z+vet.siteR*0.45},{x:s.x+vet.siteR*0.45,z:s.z}];
      vet.verIdx=0; vet.verT=0;
      raiseClipboard(fm,true);
      if(ctx&&ctx.log) ctx.log('['+vet.crew+'] '+radio('verifying',vet));
    }
  }catch(e){}
}
/* _tickPhase(job, vet, dt, ctx, time) — per-frame phase behavior. */
function _tickPhase(job, vet, dt, ctx, time){
  var fm=job.foreman, workers=job.workers||[], s=_siteXY(vet);
  try{
    if(vet.phase==='arriving'){
      /* crew stages by the truck; foreman steps forward. */
      workers.forEach(function(w,k){ _idleBob(w,time,k); });
      if(fm){
        _idleBob(fm,time,9);
        try{ fm.rotation.y=Math.atan2(s.x-fm.position.x, s.z-fm.position.z); }catch(e){}
      }
    }
    else if(vet.phase==='assessing'){
      /* foreman walks the perimeter waypoints, clipboard up. */
      if(fm&&vet.waypoints.length){
        var wp=vet.waypoints[vet.wpIdx];
        if(_walkTo(fm,wp.x,wp.z,dt,time)){
          /* pause at each waypoint — the veteran LOOKS. */
          vet._wpPause=(vet._wpPause||0)+dt;
          if(vet._wpPause>1.6){ vet._wpPause=0; vet.wpIdx=(vet.wpIdx+1)%vet.waypoints.length; }
        }
      }
      workers.forEach(function(w,k){ _idleBob(w,time,k); });
    }
    else if(vet.phase==='reporting'){
      /* foreman at the truck, radioing the report in. */
      if(fm){
        var tp=vet.truckPos;
        _walkTo(fm,tp.x,tp.z,dt,time);
        /* radio hand up while reporting. */
        try{ var a=fm.userData&&fm.userData.armR; if(a) a.rotation.x=-2.2; }catch(e){}
      }
      workers.forEach(function(w,k){ _idleBob(w,time,k); });
    }
    else if(vet.phase==='setup'){
      /* workers walk out to their stations, staggered. */
      var allIn=true;
      workers.forEach(function(w,k){
        var tgt=vet.workerTargets[k];
        if(!tgt){ return; }
        if(vet.phaseT<k*1.5){ allIn=false; return; }  // stagger
        if(!vet.setupDone[k]){
          if(_walkTo(w,tgt.x,tgt.z,dt,time)) vet.setupDone[k]=true;
          else allIn=false;
        }
      });
      /* foreman walks to his supervise post. */
      if(fm&&vet._supPost) _walkTo(fm,vet._supPost.x,vet._supPost.z,dt,time);
      /* early advance: everybody's in position. */
      if(allIn&&workers.length) vet.phaseT=Math.max(vet.phaseT,PHASE_DUR.setup);
    }
    else if(vet.phase==='fixing'){
      /* milestone radio at 25/50/75% — the foreman keeps dispatch posted. */
      var frac=vet.phaseT/Math.max(1,vet.fixDur);
      [['fixing25',0.25],['fixing50',0.5],['fixing75',0.75]].forEach(function(mm){
        if(frac>=mm[1]&&!vet.milestones[mm[0]]){
          vet.milestones[mm[0]]=true;
          if(ctx&&ctx.log) ctx.log('['+vet.crew+'] '+radio(mm[0],vet));
        }
      });
      /* foreman supervises: faces each worker in turn, clipboard checks. */
      if(fm&&workers.length){
        vet.supT+=dt;
        if(vet.supT>4){ vet.supT=0; vet.supTarget=(vet.supTarget+1)%workers.length; }
        var w=workers[vet.supTarget<0?0:vet.supTarget];
        if(w){ try{ fm.rotation.y=Math.atan2(w.position.x-fm.position.x,w.position.z-fm.position.z); }catch(e){} }
        raiseClipboard(fm, vet.supT<1.2);
      }
      /* NOTE: the crew's own repair animation runs via the caller during
         'fixing' (it owns j.t and the work visuals). */
    }
    else if(vet.phase==='verifying'){
      /* foreman walks the three inspection points, bends to look close. */
      if(fm&&vet.verPts.length){
        var p=vet.verPts[Math.min(vet.verIdx,vet.verPts.length-1)];
        if(_walkTo(fm,p.x,p.z,dt,time)){
          vet.verT+=dt;
          /* bend down to inspect — 1.2s per point. */
          try{ fm.scale.y=vet.verT<1.2?0.82:1; }catch(e){}
          if(vet.verT>=2.2){
            vet.verT=0; vet.verIdx++;
            try{ fm.scale.y=1; }catch(e){}
          }
        }
      }
      workers.forEach(function(w,k){ _idleBob(w,time,k); });
    }
  }catch(e){}
}
/* _exitVerify(job, vet, ctx) — the sign-off: foreman raises his arm,
   dispatch gets the verify line + toast. Called once as verifying ends. */
function _exitVerify(job, vet, ctx){
  try{
    var fm=job.foreman;
    if(fm){
      try{ fm.scale.y=1; }catch(e){}
      /* arm up — the veteran's sign-off. */
      try{ var a=fm.userData&&fm.userData.armR; if(a) a.rotation.x=-2.6; }catch(e){}
      raiseClipboard(fm,false);
    }
    var rid=vet.report?vet.report.id:'report';
    if(ctx&&ctx.log) ctx.log('['+vet.crew+'] '+radio('done',vet));
    if(ctx&&ctx.log) ctx.log('['+vet.crew+'] ✅ Foreman '+vet.foremanName+' verified the repair — '+rid+' signed off. Fix recorded (auto-save).');
    if(ctx&&ctx.toast) ctx.toast('✅ Foreman '+vet.foremanName+' signed off — fix verified & saved');
  }catch(e){}
}
/* updateJob(job, dt, ctx) — drive the phase machine. ctx: {time,
   log(msg), toast(msg)}. Returns the current phase name, or 'done' when
   the verify phase completed (caller then runs its normal finish path:
   finishRepair/finishJob + job splice + persistence). */
function updateJob(job, dt, ctx){
  var vet=job?job.vet:null;
  if(!vet) return 'done';
  ctx=ctx||{};
  var time=(typeof ctx.time==='number')?ctx.time:0;
  try{
    if(!vet.entered) _enterPhase(job,vet,'arriving',ctx);
    vet.phaseT+=dt;
    _tickPhase(job,vet,dt,ctx,time);
    var dur=(vet.phase==='fixing')?Math.max(1,vet.fixDur):(PHASE_DUR[vet.phase]||5);
    if(vet.phaseT>=dur){
      if(vet.phase==='verifying') _exitVerify(job,vet,ctx);
      var next=_nextPhase(vet.phase);
      if(next==='done') return 'done';
      _enterPhase(job,vet,next,ctx);
    }
    return vet.phase;
  }catch(e){
    /* a veteran-crew bug must never break the frame — fall back to the
       crew's legacy timing. */
    return 'fixing';
  }
}

/* ---------------- public API ---------------- */
window.VeteranCrew={
  jobState:jobState,
  makeForeman:makeForeman,
  updateJob:updateJob,
  assess:assess,
  fileReport:fileReport,
  reportLine:reportLine,
  fieldNote:fieldNote,
  radio:radio,
  listReports:listReports,
  PHASE_DUR:PHASE_DUR
};
})();
