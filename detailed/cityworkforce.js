/* ============================================================================
   FILE: cityworkforce.js — "Surviving Adamsville" MUNICIPAL WORKFORCE
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-09):
     All AI agents that can be converted to smart NPCs should be converted.
     Use a large downtown building to house multiple units and departments.

   WHAT THIS DOES:
     Converts the abstract crew/worker systems (road crew, infra crew, code
     enforcement, drone operators) into NAMED SMART NPCs with departments,
     roles, and daily routines — all headquartered in a real downtown tower.

   THE HEADQUARTERS:
     Adamsville Municipal Services HQ — the 312u downtown tower at
     (7750.5, 2574.9). Six departments, each with its own floors:
       Floors 1-3:   Dispatch & Communications
       Floors 4-10:  Road Department
       Floors 11-15: Sign & Signal Department
       Floors 16-20: Infrastructure Department
       Floor 21:     Code Enforcement / Inspection
       Floor 22:     Survey & Inspection (drone ops)

   HOW IT WORKS:
     1. A roster of 58 named workers is created at boot (names, departments,
        roles, shifts). Persisted in localStorage so the roster is stable
        across sessions.
     2. A poll loop (every 2s) inspects the crew systems' public APIs:
          window.__roadCrewOps.jobs()  -> Road Department jobs
          window.INFRACREW.issues      -> Sign/Infrastructure jobs
          window.CODEENFORCE           -> Code Enforcement patrols
        When a worker figure is found in an active job without an identity,
        the next available roster member from that department is assigned:
        the figure gets a floating NAME TAG and the roster tracks them as
        DEPLOYED (with location).
     3. When a job completes/disappears, the worker's status returns to
        AT HQ (they've "returned").
     4. HQ ambient staff: dispatchers and drone operators are visible at
        the HQ entrance plaza and drone control stations (always there —
        they're the ones answering the radios).
     5. HUD 🏢 button opens the workforce panel: departments, floors,
        roster with live status (AT HQ / DEPLOYED @ location / EN ROUTE).

   DAILY ROUTINE (Joshua's spec):
     Workers "spawn from HQ, go to assignments, return when done."
     - Dispatch assigns a job -> roster marks workers DEPLOYED, log notes
       "X (Road Dept) deployed from HQ to (x, z)"
     - Job finishes -> roster marks them RETURNING, then AT HQ
     - The name tags make every deployed worker a visible, named NPC —
       not an anonymous figure.

   30-YEAR VETERAN INTELLIGENCE:
     The repair workflow itself (assess/report/setup/fix/verify) is owned
     by veteran_crew.js, which the crew systems already call. This module
     adds the HUMAN layer: who these veterans ARE (names, departments,
     home base). The foremen from VeteranCrew (Deacon, Big Mike, etc.)
     are cross-referenced in the roster as department leads.

   INTEGRATION (build agent):
     Add AFTER infracrew_system.js in index.html:
         <script src="cityworkforce.js"></script>
     Zero edits to existing files. All crew-system reads are guarded —
     if a system isn't loaded, its department simply shows "standby."

   PUBLIC API (window.CityWorkforce):
     roster()          -> array of worker records {name, dept, role, status, x, z}
     departments()     -> department definitions with floors
     deployLog()       -> recent deployment/return log entries
     assignIdentity(fig, deptId) -> manually attach a roster identity to a figure
     hq()              -> {x, z, name} of the headquarters
     toggle(f)         -> show/hide the workforce HUD panel
   ============================================================================ */
(function(){
'use strict';
/* Single-instance guard. */
if (window.CityWorkforce) return;

/* ================= HQ ================= */
var HQ = {
  x: 7750.5, z: 2574.9,
  name: 'Adamsville Municipal Services HQ',
  /* Entrance plaza: offset from tower base toward the street (south side). */
  plazaX: 7750.5, plazaZ: 2595.0
};

/* ================= DEPARTMENTS ================= */
var DEPTS = [
  {id:'dispatch', name:'Dispatch & Communications', floors:'1–3',
   desc:'Radios, job assignments, field-report intake. The voice on every crew radio.',
   vest:0x2e5fa3, hat:0xf4f4f4},
  {id:'road', name:'Road Department', floors:'4–10',
   desc:'Paving, patching, ribbon re-seating. The asphalt crew.',
   vest:0xff6a00, hat:0xf5d020},
  {id:'sign', name:'Sign & Signal Department', floors:'11–15',
   desc:'Street signs, stop signs, traffic signals. If it talks to drivers, it\'s theirs.',
   vest:0xffc400, hat:0xf4f4f4},
  {id:'infra', name:'Infrastructure Department', floors:'16–20',
   desc:'Drainage, pavement structure, roadbed. What\'s under the asphalt.',
   vest:0xa8d800, hat:0x9aa0a8},
  {id:'code', name:'Code Enforcement', floors:'21',
   desc:'Building inspectors. Patrols 24/7 — if it\'s on the road or sideways, they find it.',
   vest:0x555c66, hat:0x222226},
  {id:'survey', name:'Survey & Inspection', floors:'22',
   desc:'Drone operators and aerial survey. One hundred eyes in the sky.',
   vest:0x1f8a8a, hat:0xf4f4f4}
];
function deptById(id){
  for (var i=0;i<DEPTS.length;i++) if (DEPTS[i].id===id) return DEPTS[i];
  return DEPTS[0];
}

/* ================= ROSTER =================
   58 named workers. Deterministic order (stable across sessions).
   status: 'hq' | 'deployed' | 'returning'
   figure: the THREE.Group when deployed (null at HQ).
   Names are plain, working-class Atlanta — these are 30-year veterans. */
var FIRST=['Marcus','Darryl','Terrence','Willie','Jerome','Calvin','Eddie',
  'Roosevelt','Leroy','Nathaniel','Clifton','Alvin','Reginald','Otis','Vernon',
  'Howard','Bernard','Curtis','Dennis','Floyd','Grady','Harold','Isaac',
  'Jesse','Kenneth','Leonard','Marvin','Norman','Oliver','Percy','Quincy',
  'Robert','Samuel','Thomas','Ulysses','Victor','Walter','Xavier','Yusuf',
  'Zachary','Anita','Barbara','Carolyn','Dorothy','Evelyn','Fannie','Gloria',
  'Harriet','Irene','Janice','Linda','Martha','Nancy','Olivia','Patricia',
  'Rosa','Shirley','Tanya','Valerie'];
var LAST=['Johnson','Williams','Brown','Jones','Davis','Miller','Wilson',
  'Moore','Taylor','Thomas','Harris','Martin','Thompson','Garcia','Martinez',
  'Robinson','Clark','Rodriguez','Lewis','Lee','Walker','Hall','Allen',
  'Young','King','Wright','Scott','Green','Baker','Adams','Nelson','Carter',
  'Mitchell','Turner','Phillips','Campbell','Parker','Evans','Edwards'];
var ROSTER_SPEC=[
  /* dept, count, roles (cycled) */
  ['dispatch', 6, ['Dispatcher','Dispatcher','Shift Lead','Dispatcher','Radio Op','Dispatcher']],
  ['road',    16, ['Foreman','Crew Chief','Paver','Paver','Roller Op','Crew Chief','Paver','Paver',
                   'Foreman','Crew Chief','Paver','Paver','Roller Op','Paver','Crew Chief','Paver']],
  ['sign',    10, ['Signal Tech','Sign Tech','Signal Tech','Crew Chief','Sign Tech',
                   'Signal Tech','Sign Tech','Crew Chief','Signal Tech','Sign Tech']],
  ['infra',   10, ['Foreman','Dozer Op','Crew Chief','Pipe Layer','Crew Chief',
                   'Dozer Op','Pipe Layer','Crew Chief','Foreman','Pipe Layer']],
  ['code',     8, ['Inspector','Inspector','Senior Inspector','Inspector',
                   'Inspector','Senior Inspector','Inspector','Inspector']],
  ['survey',   8, ['Drone Op','Drone Op','Survey Lead','Drone Op',
                   'Drone Op','Survey Lead','Drone Op','Drone Op']]
];
var LS_ROSTER='sa_cityworkforce_v1';
var LS_LOG='sa_cityworkforce_log_v1';
var roster=[];       // {name, dept, role, status, x, z, figure, tagSprite}
var deployLog=[];    // {t, msg} newest last, capped
var _nameSeq=0;

function _nowT(){
  var d=new Date();
  function p(n){ return (n<10?'0':'')+n; }
  return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}
function _log(msg){
  deployLog.push({t:_nowT(), msg:String(msg)});
  while (deployLog.length>80) deployLog.shift();
  try{
    try{ window.localStorage.setItem(LS_LOG, JSON.stringify(deployLog.slice(-80))); }catch(e){}
  }catch(e){}
}
function _saveRoster(){
  try{
    var slim=roster.map(function(w){
      return {name:w.name, dept:w.dept, role:w.role, status:w.status,
              x:Math.round(w.x||0), z:Math.round(w.z||0)};
    });
    try{ window.localStorage.setItem(LS_ROSTER, JSON.stringify(slim)); }catch(e){}
  }catch(e){}
}
function _loadPersisted(){
  var saved=null, savedLog=null;
  try{
    try{ saved=window.localStorage.getItem(LS_ROSTER); }catch(e){}
    try{ savedLog=window.localStorage.getItem(LS_LOG); }catch(e){}
  }catch(e){}
  if (saved){
    try{
      var arr=JSON.parse(saved);
      if (arr && arr.length) return {roster:arr, log:savedLog?JSON.parse(savedLog):[]};
    }catch(e){}
  }
  return null;
}
function buildRoster(){
  var persisted=_loadPersisted();
  if (persisted && persisted.roster && persisted.roster.length===58){
    /* Restore names/depts/roles; everyone starts AT HQ on a fresh load
       (deployed figures don't survive reload — crews re-dispatch). */
    roster=persisted.roster.map(function(s){
      return {name:s.name, dept:s.dept, role:s.role, status:'hq',
              x:HQ.plazaX, z:HQ.plazaZ, figure:null, tagSprite:null};
    });
    deployLog=persisted.log||[];
    _log('Workforce roster restored — 58 personnel reporting to HQ.');
    return;
  }
  /* Fresh roster: deterministic names. */
  roster=[];
  var fi=0, li=0;
  ROSTER_SPEC.forEach(function(spec){
    var dept=spec[0], count=spec[1], roles=spec[2];
    for (var i=0;i<count;i++){
      var name=FIRST[fi%FIRST.length]+' '+LAST[li%LAST.length];
      fi+=7; li+=3;  /* stride so names don't cluster */
      roster.push({name:name, dept:dept, role:roles[i%roles.length],
                   status:'hq', x:HQ.plazaX, z:HQ.plazaZ,
                   figure:null, tagSprite:null});
    }
  });
  _log('Workforce roster created — 58 personnel across 6 departments.');
  _saveRoster();
}
function workersInDept(deptId, status){
  return roster.filter(function(w){
    return w.dept===deptId && (!status || w.status===status);
  });
}
function nextAvailable(deptId){
  var c=workersInDept(deptId,'hq');
  return c.length?c[0]:null;
}

/* ================= NAME TAGS =================
   Floating canvas-sprite name tags above deployed workers.
   Small, cheap, readable — only for DEPLOYED workers (not the HQ crowd). */
var _tagCache={};
function makeNameTag(name, deptId){
  var key=deptId+'|'+name;
  if (_tagCache[key]) return _tagCache[key].clone();
  try{
    var d=deptById(deptId);
    var cv=document.createElement('canvas');
    cv.width=256; cv.height=64;
    var cx=cv.getContext('2d');
    /* pill background in department color */
    cx.fillStyle='rgba(10,10,14,0.78)';
    var r=14;
    cx.beginPath();
    if (cx.roundRect) cx.roundRect(4,8,248,48,r);
    else cx.rect(4,8,248,48);
    cx.fill();
    /* department color bar */
    var hex='#'+('000000'+d.vest.toString(16)).slice(-6);
    cx.fillStyle=hex;
    cx.fillRect(4,8,10,48);
    /* name text */
    cx.fillStyle='#ffffff';
    cx.font='bold 21px sans-serif';
    cx.textAlign='center'; cx.textBaseline='middle';
    var label=name.length>18?name.slice(0,17)+'…':name;
    cx.fillText(label, 134, 33);
    var tex=new THREE.CanvasTexture(cv);
    var mat=new THREE.SpriteMaterial({map:tex, depthTest:false, transparent:true});
    var sp=new THREE.Sprite(mat);
    sp.scale.set(3.4, 0.85, 1);
    _tagCache[key]={tex:tex, mat:mat};
    return sp;
  }catch(e){ return null; }
}
function attachTag(fig, worker){
  try{
    if (!fig || worker.tagSprite) return;
    var tag=makeNameTag(worker.name, worker.dept);
    if (!tag) return;
    tag.position.set(0, 2.45, 0);
    fig.add(tag);
    worker.tagSprite=tag;
  }catch(e){}
}
function detachTag(worker){
  try{
    if (worker.tagSprite && worker.tagSprite.parent)
      worker.tagSprite.parent.remove(worker.tagSprite);
    worker.tagSprite=null;
  }catch(e){}
}

/* ================= HQ VISUALS =================
   Entrance signage + department directory board at the tower's south face.
   Built once at boot, fully guarded. */
var hqGroup=null, hqStaff=[];
function _gY(x,z){
  try{ var y=heightAt(x,z); return isFinite(y)?y:0; }catch(e){ return 0; }
}
function makeTextPanel(lines, w, h, opts){
  /* Canvas-texture sign panel. lines: array of {text, size, color, bold}. */
  try{
    opts=opts||{};
    var cv=document.createElement('canvas');
    cv.width=opts.px||512; cv.height=Math.round((opts.px||512)*h/w);
    var cx=cv.getContext('2d');
    cx.fillStyle=opts.bg||'#0d1b2a';
    cx.fillRect(0,0,cv.width,cv.height);
    if (opts.border){
      cx.strokeStyle=opts.border; cx.lineWidth=10;
      cx.strokeRect(8,8,cv.width-16,cv.height-16);
    }
    var y=(opts.padTop||40);
    lines.forEach(function(L){
      cx.font=(L.bold?'bold ':'')+(L.size||36)+'px sans-serif';
      cx.fillStyle=L.color||'#ffffff';
      cx.textAlign='center';
      cx.fillText(L.text, cv.width/2, y);
      y+=(L.size||36)+18;
    });
    var tex=new THREE.CanvasTexture(cv);
    var m=new THREE.Mesh(
      new THREE.PlaneGeometry(w,h),
      new THREE.MeshBasicMaterial({map:tex, transparent:false}));
    return m;
  }catch(e){ return null; }
}
function buildHQ(){
  try{
    if (typeof THREE==='undefined' || !scene) return;
    hqGroup=new THREE.Group();
    var gy=_gY(HQ.plazaX, HQ.plazaZ);
    /* --- Main HQ sign: freestanding pylon at the plaza --- */
    var sign=makeTextPanel([
      {text:'ADAMSVILLE', size:54, color:'#ffd75e', bold:true},
      {text:'MUNICIPAL SERVICES HQ', size:34, color:'#ffffff', bold:true},
      {text:'Road • Signs & Signals • Infrastructure', size:24, color:'#bcd2ff'},
      {text:'Code Enforcement • Survey & Inspection', size:24, color:'#bcd2ff'}
    ], 14, 7, {bg:'#0d1b2a', border:'#ffd75e', padTop:60});
    if (sign){
      sign.position.set(HQ.plazaX, gy+4.4, HQ.plazaZ);
      /* Face south (toward approaching viewers from downtown streets). */
      sign.rotation.y=Math.PI;
      hqGroup.add(sign);
      /* pylon posts */
      var postMat=new THREE.MeshLambertMaterial({color:0x39424e});
      [-5,5].forEach(function(px){
        try{
          var post=new THREE.Mesh(new THREE.BoxGeometry(0.7,4.6,0.7), postMat);
          post.position.set(HQ.plazaX+px, gy+1.4, HQ.plazaZ+0.2);
          hqGroup.add(post);
        }catch(e){}
      });
    }
    /* --- Department directory board --- */
    var dirLines=[{text:'DEPARTMENT DIRECTORY', size:40, color:'#ffd75e', bold:true}];
    DEPTS.forEach(function(d){
      dirLines.push({text:d.name+' — Floors '+d.floors, size:26, color:'#ffffff'});
    });
    var dir=makeTextPanel(dirLines, 12, 9.5, {bg:'#101418', border:'#8fa3bf', padTop:52});
    if (dir){
      dir.position.set(HQ.plazaX+11, gy+3.4, HQ.plazaZ+2);
      dir.rotation.y=Math.PI-0.5;
      hqGroup.add(dir);
    }
    scene.add(hqGroup);
    try{ if (typeof Report!=='undefined' && Report.note)
      Report.note('cityworkforce','HQ signage installed at ('+HQ.x+', '+HQ.z+')'); }catch(e){}
  }catch(e){}
}
/* --- HQ ambient staff: dispatchers + drone ops visible at the plaza.
   These are the folks answering the radios. Simple figures, name-tagged,
   idle-animated in the frame loop. --- */
function _box(w,h,d,color,emissive){
  try{ return new THREE.Mesh(new THREE.BoxGeometry(w,h,d),
    new THREE.MeshLambertMaterial({color:color, emissive:emissive||0x000000})); }
  catch(e){ return null; }
}
function makeStaffFigure(deptId){
  var d=deptById(deptId);
  var g=null;
  try{
    g=new THREE.Group();
    var legs=_box(0.5,0.7,0.34,0x2b2f3a); legs.position.y=0.35; g.add(legs);
    var torso=_box(0.62,0.72,0.4,d.vest,0x1a1a1a); torso.position.y=1.06; g.add(torso);
    var head=_box(0.36,0.36,0.36,0x6b4429); head.position.y=1.6; g.add(head);
    var hat=_box(0.44,0.16,0.44,d.hat,0x222222); hat.position.y=1.84; g.add(hat);
    var armL=_box(0.16,0.6,0.16,d.vest,0x1a1a1a); armL.position.set(-0.4,1.05,0); g.add(armL);
    var armR=armL.clone(); armR.position.set(0.4,1.05,0); g.add(armR);
    g.userData.armL=armL; g.userData.armR=armR;
  }catch(e){ return null; }
  return g;
}
function spawnHQStaff(){
  try{
    if (typeof THREE==='undefined' || !scene || !hqGroup) return;
    /* 4 dispatchers near the directory + 3 drone ops at a control station. */
    var spots=[
      {dept:'dispatch', dx:-6, dz:3, ry:2.6},
      {dept:'dispatch', dx:-4, dz:4, ry:2.9},
      {dept:'dispatch', dx:6,  dz:4, ry:-2.7},
      {dept:'dispatch', dx:8,  dz:3, ry:-2.4},
      {dept:'survey',   dx:-9, dz:-4, ry:0.6},
      {dept:'survey',   dx:-7, dz:-5, ry:0.3},
      {dept:'survey',   dx:-5, dz:-4, ry:0.9}
    ];
    var poolD=workersInDept('dispatch','hq').slice(0,4);
    var poolS=workersInDept('survey','hq').slice(0,3);
    var assign=poolD.concat(poolS);
    spots.forEach(function(s,i){
      var w=assign[i];
      if (!w) return;
      var fig=makeStaffFigure(s.dept);
      if (!fig) return;
      var x=HQ.plazaX+s.dx, z=HQ.plazaZ+s.dz;
      fig.position.set(x, _gY(x,z), z);
      fig.rotation.y=s.ry;
      attachTag(fig, w);
      w.figure=fig;
      w.status='hq-duty';   /* at HQ but on duty (visible staff) */
      w.x=x; w.z=z;
      hqGroup.add(fig);
      hqStaff.push({fig:fig, worker:w, seed:Math.random()*10});
    });
    /* Drone control station: small console table the survey ops stand at. */
    try{
      var con=_box(4.5,1.0,1.2,0x1c2330,0x0a0e14);
      if (con){
        var cxp=HQ.plazaX-7, czp=HQ.plazaZ-6.5;
        con.position.set(cxp, _gY(cxp,czp)+0.5, czp);
        hqGroup.add(con);
        /* glowing screens */
        for (var k=0;k<3;k++){
          var scr=_box(1.1,0.7,0.08,0x1f8a8a,0x0f4a4a);
          if (scr){
            scr.position.set(cxp-1.4+k*1.4, _gY(cxp,czp)+1.35, czp);
            scr.rotation.x=-0.25;
            hqGroup.add(scr);
          }
        }
      }
    }catch(e){}
    _log('HQ staff on duty: 4 dispatchers + 3 drone operators at the plaza.');
  }catch(e){}
}

/* ================= CREW-SYSTEM POLL =================
   Every 2s: look for worker figures in active jobs that lack identities,
   and assign roster members. Also detect finished jobs -> mark RETURNING. */
var _tracked=new WeakMap();  /* figure -> worker record */
var _jobSeen={};              /* jobKey -> {dept, workers:[records]} */
var pollT=0;

function _jobKey(sys, j){
  try{
    var d=j.defect||j.issue||j;
    return sys+':'+Math.round(d.x||0)+','+Math.round(d.z||0);
  }catch(e){ return sys+':'+Math.random(); }
}
function _assignFigures(figs, deptId, jx, jz, sysLabel){
  figs.forEach(function(fig){
    if (!fig || _tracked.has(fig)) return;
    var w=nextAvailable(deptId);
    if (!w){
      /* department fully deployed — pull from HQ-duty pool as overflow. */
      var over=roster.filter(function(r){ return r.dept===deptId && r.status==='hq-duty'; })[0];
      if (!over) return;
      w=over;
    }
    w.status='deployed';
    w.x=jx; w.z=jz;
    w.figure=fig;
    _tracked.set(fig, w);
    attachTag(fig, w);
    _log(w.name+' ('+deptById(deptId).name+', '+w.role+') deployed from HQ to '+sysLabel+' site ('+Math.round(jx)+', '+Math.round(jz)+').');
  });
  _saveRoster();
}
function _releaseJobWorkers(key){
  var rec=_jobSeen[key];
  if (!rec) return;
  rec.workers.forEach(function(w){
    try{
      detachTag(w);
      if (w.figure) _tracked.delete(w.figure);
    }catch(e){}
    w.figure=null;
    w.status='returning';
    w.x=HQ.plazaX; w.z=HQ.plazaZ;
    _log(w.name+' ('+w.role+') returning to HQ.');
  });
  delete _jobSeen[key];
  _saveRoster();
}
function pollCrews(){
  try{
    var activeKeys={};
    /* --- Road Department: window.__roadCrewOps.jobs() --- */
    try{
      var ops=window.__roadCrewOps;
      if (ops && typeof ops.jobs==='function'){
        var jobs=ops.jobs()||[];
        jobs.forEach(function(j){
          if (!j || !j.workers || !j.workers.length) return;
          var key=_jobKey('road', j);
          activeKeys[key]=true;
          if (!_jobSeen[key]){
            var d=j.defect||{};
            _jobSeen[key]={dept:'road', workers:[]};
            _assignFigures(j.workers,'road', d.x||0, d.z||0, 'road');
            /* collect the records we just assigned */
            j.workers.forEach(function(f){
              var w=_tracked.get(f);
              if (w) _jobSeen[key].workers.push(w);
            });
          }
        });
      }
    }catch(e){}
    /* --- Sign & Infrastructure: window.INFRACREW.jobs ---
       Infra jobs carry issue.kind: 'signal' | 'sign' | 'road'. Map to departments:
       signal/sign -> 'sign' dept; road -> 'infra' dept. */
    try{
      var IC=window.INFRACREW;
      var ijobs=(IC && IC.jobs)||[];
      ijobs.forEach(function(j){
        if (!j || !j.workers || !j.workers.length) return;
        var kind=(j.issue&&j.issue.kind)||'road';
        var dept=(kind==='signal'||kind==='sign')?'sign':'infra';
        var key=_jobKey('infra', j.issue||j);
        activeKeys[key]=true;
        if (!_jobSeen[key]){
          _jobSeen[key]={dept:dept, workers:[]};
          var ix=(j.issue&&j.issue.x)||0, iz=(j.issue&&j.issue.z)||0;
          _assignFigures(j.workers, dept, ix, iz,
            dept==='sign'?'sign/signal':'infrastructure');
          j.workers.forEach(function(f){
            var w=_tracked.get(f);
            if (w) _jobSeen[key].workers.push(w);
          });
        }
      });
    }catch(e){}
    /* --- Code Enforcement: patrol units get officer names.
       Patrols are long-lived; assign once per patrol object. --- */
    try{
      var CEp=(window.CODEENFORCE&&window.CODEENFORCE.patrols)||[];
      CEp.forEach(function(p, idx){
        if (!p || p._wfAssigned) return;
        p._wfAssigned=true;
        var w=nextAvailable('code');
        if (w){
          w.status='deployed';
          try{ w.x=p.mesh?p.mesh.position.x:0; w.z=p.mesh?p.mesh.position.z:0; }catch(e){}
          _log(w.name+' ('+w.role+', Code Enforcement) on patrol — unit '+(p.no||(idx+1))+'.');
          _saveRoster();
        }
      });
    }catch(e){}
    /* --- Release: jobs that vanished finished -> workers return --- */
    Object.keys(_jobSeen).forEach(function(key){
      if (!activeKeys[key]) _releaseJobWorkers(key);
    });
    /* --- Returning -> HQ after a beat (they've driven back) --- */
    var now=Date.now();
    roster.forEach(function(w){
      if (w.status==='returning' && (!w._retT || now-w._retT>8000)){
        w.status='hq';
        w._retT=now;
        w.x=HQ.plazaX; w.z=HQ.plazaZ;
      }
      if (w.status==='returning' && !w._retT) w._retT=now;
    });
  }catch(e){}
}

/* ================= FRAME TICK =================
   Idle animation for HQ staff; poll timer. Chained into animate(). */
var _t=0;
function tick(dt){
  _t+=dt;
  try{
    hqStaff.forEach(function(s){
      try{
        s.fig.position.y+=Math.sin(_t*2.2+s.seed)*0.006;
        s.fig.rotation.y+=Math.sin(_t*0.5+s.seed)*0.003;
      }catch(e){}
    });
    pollT+=dt;
    if (pollT>2){ pollT=0; pollCrews(); }
  }catch(e){}
}

/* ================= HUD PANEL ================= */
var panel=null, panelOn=false;
function statusLabel(w){
  if (w.status==='hq') return 'AT HQ';
  if (w.status==='hq-duty') return 'ON DUTY @ HQ';
  if (w.status==='deployed') return 'DEPLOYED ('+Math.round(w.x)+', '+Math.round(w.z)+')';
  if (w.status==='returning') return 'RETURNING';
  return w.status.toUpperCase();
}
function renderPanel(){
  if (!panel) return;
  try{
    var h='<div style="font-weight:bold;font-size:16px;margin-bottom:6px">🏢 Municipal Workforce — '+HQ.name+'</div>';
    h+='<div style="color:#9fb3c8;font-size:12px;margin-bottom:10px">HQ tower ('+HQ.x+', '+HQ.z+') — 58 personnel, 6 departments</div>';
    DEPTS.forEach(function(d){
      var ws=workersInDept(d.id);
      var dep=ws.filter(function(w){return w.status==='deployed';}).length;
      var hex='#'+('000000'+d.vest.toString(16)).slice(-6);
      h+='<div style="margin:8px 0;padding:8px;border-left:4px solid '+hex+';background:rgba(255,255,255,0.04);border-radius:4px">';
      h+='<div style="font-weight:bold">'+d.name+' <span style="color:#9fb3c8;font-weight:normal">— Floors '+d.floors+'</span></div>';
      h+='<div style="color:#9fb3c8;font-size:12px">'+d.desc+'</div>';
      h+='<div style="font-size:12px;margin-top:4px">'+ws.length+' staff • '+dep+' deployed</div>';
      h+='<div style="font-size:12px;color:#c8d4e0;max-height:96px;overflow-y:auto;margin-top:4px">';
      ws.forEach(function(w){
        h+='<div>• <b>'+w.name+'</b> ('+w.role+') — '+statusLabel(w)+'</div>';
      });
      h+='</div></div>';
    });
    h+='<div style="margin-top:10px;font-weight:bold">📻 Deployment log</div>';
    h+='<div style="font-size:12px;color:#c8d4e0;max-height:140px;overflow-y:auto">';
    deployLog.slice(-14).reverse().forEach(function(e){
      h+='<div><span style="color:#8fa3bf">'+e.t+'</span> '+e.msg+'</div>';
    });
    h+='</div>';
    panel.innerHTML=h;
  }catch(e){}
}
function togglePanel(force){
  try{
    panelOn=(typeof force==='boolean')?force:!panelOn;
    if (panelOn && !panel){
      panel=document.createElement('div');
      panel.style.cssText='position:fixed;top:70px;right:12px;width:380px;max-height:75vh;overflow-y:auto;'+
        'background:rgba(8,12,18,0.94);color:#e8eef6;border:1px solid #3a4a5e;border-radius:10px;'+
        'padding:14px;z-index:9998;font-family:sans-serif;font-size:13px;';
      document.body.appendChild(panel);
      /* HUD toggle button */
      var btn=document.createElement('button');
      btn.id='wf-hud-btn';
      btn.textContent='🏢';
      btn.title='Municipal Workforce';
      btn.style.cssText='position:fixed;top:70px;right:404px;width:44px;height:44px;font-size:22px;'+
        'background:rgba(8,12,18,0.9);border:1px solid #3a4a5e;border-radius:10px;z-index:9998;cursor:pointer;';
      btn.onclick=function(){ togglePanel(); };
      document.body.appendChild(btn);
    }
    if (panel) panel.style.display=panelOn?'block':'none';
    var b=document.getElementById('wf-hud-btn');
    if (b) b.style.display='block';
    if (panelOn) renderPanel();
  }catch(e){}
}
/* Re-render the panel content periodically while open. */
setInterval(function(){ if (panelOn) renderPanel(); }, 3000);

/* ================= BOOT ================= */
function boot(){
  try{
    buildRoster();
    buildHQ();
    spawnHQStaff();
    /* chain into animate() */
    try{
      if (typeof animate==='function' && !animate.__cityworkforceWrap){
        var orig=animate;
        var wrapped=function(){ orig(); tick(0.016); };
        wrapped.__cityworkforceWrap=true;
        animate=wrapped;
      }
    }catch(e){}
    try{
      if (typeof Report!=='undefined' && Report.setSys)
        Report.setSys('cityworkforce',{
          active:true, hq:[HQ.x,HQ.z],
          roster:roster.length, deployed:roster.filter(function(w){return w.status==='deployed';}).length,
          note:'58 named personnel across 6 departments, HQ downtown tower'});
    }catch(e){}
    _log('Municipal Workforce online — HQ at downtown tower.');
  }catch(e){}
}

/* Boot when scene exists; retry a few times (late-load safe). */
var _tries=0;
var _bootTimer=setInterval(function(){
  _tries++;
  try{
    if (typeof THREE!=='undefined' && typeof scene!=='undefined' && scene){
      clearInterval(_bootTimer);
      boot();
    } else if (_tries>40){
      clearInterval(_bootTimer);
      /* Scene never arrived — still build the roster so the API works. */
      try{ buildRoster(); }catch(e){}
    }
  }catch(e){}
}, 500);

/* ================= PUBLIC API ================= */
window.CityWorkforce={
  hq:function(){ return {x:HQ.x, z:HQ.z, name:HQ.name}; },
  departments:function(){ return DEPTS.map(function(d){
    return {id:d.id, name:d.name, floors:d.floors, desc:d.desc}; }); },
  roster:function(){
    return roster.map(function(w){
      return {name:w.name, dept:w.dept, role:w.role,
              status:w.status, x:Math.round(w.x||0), z:Math.round(w.z||0)}; }); },
  deployLog:function(){ return deployLog.slice(); },
  toggle:function(f){ togglePanel(f); },
  assignIdentity:function(fig, deptId){
    /* Manually attach the next available roster member to a figure. */
    try{
      if (!fig || _tracked.has(fig)) return null;
      var w=nextAvailable(deptId||'road');
      if (!w) return null;
      w.status='deployed';
      try{ w.x=fig.position.x; w.z=fig.position.z; }catch(e){}
      w.figure=fig;
      _tracked.set(fig, w);
      attachTag(fig, w);
      _log(w.name+' ('+w.role+') assigned to field duty.');
      _saveRoster();
      return w.name;
    }catch(e){ return null; }
  }
};
})();
