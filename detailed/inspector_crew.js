/* ============================================================================
   FILE: inspector_crew.js — "Surviving Adamsville" CREW INSPECTOR NPCs
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-10):
     "For each member of our work crews, at least for each team, there should
     be at least one NPC that's able to see mesh coding or see through
     computer eyes — basically he should be able to see the stuff that the
     rest of them can't see, to help them identify the problems."

   WHAT THIS DOES:
     Attaches ONE Inspector NPC to every active work-crew team (road crew
     repair jobs + infra crew jobs). The inspector has special "sight":
       - Collision boundaries: during a scan it draws the invisible collider
         circles around the site (X-ray vision the other crew can't see).
       - Overlapping colliders: flags pairs of colliders whose circles
         overlap — a classic map-error signature.
       - Stuck-unit hotspots: reads window.__stuckHotspots near the site.
       - StuckDiag bad spots: reads StuckDiag.badSpots() near the site.
       - Overlapping work zones: flags when another crew's work-zone
         perimeter overlaps this team's site.
     The inspector IDENTIFIES problems only — it never fixes anything.
     Findings get a red "⚠" marker at the spot and are reported:
       - Report panel note (Report.note) — recorded, not displayed
         on the game view (Joshua 2026-10-24: crew reports live in
         the Administrator menu now; the old showToast is gone)
       - window.CrewInspector.findings() log (newest last, capped at 40)

   VISUAL IDENTITY (Joshua: "different color hard hat? glowing eyes?"):
     Cyan hard hat + glowing cyan visor ("computer eyes") + navy vest with
     cyan stripes + floating "🔍 INSPECTOR" tag. Unmistakable on any site.

   HOW IT HOOKS IN (non-invasive — same pattern as cityworkforce.js):
     Polls every 3s for jobs on window.__roadCrewOps.jobs() and
     window.INFRACREW.jobs. Any job without job._inspector gets one.
     The inspector figure + scan FX + finding markers all live inside
     job.group, so when the job finishes and the group is removed from the
     scene, the inspector cleans itself up automatically. Zero edits to
     roadcrew_system.js or infracrew_system.js.

   PERFORMANCE:
     Scans are staggered (one inspector scans every ~8s, offset by index).
     Each scan is a bounded O(n) pass over the flat colliders array with
     squared-distance checks — a few thousand cheap comparisons every 8s
     is nothing next to the per-frame budget. Pairwise overlap checks are
     capped at the first 60 in-radius colliders.

   LOAD ORDER: include AFTER cityworkforce.js in index.html:
       <script src="cityworkforce.js"></script>
       <script src="inspector_crew.js"></script>

   PUBLIC API (window.CrewInspector):
     findings()   -> array of {t, crew, type, msg, x, z}
     inspectors() -> array of {crew, x, z, findings:n}
     scanNow()    -> force every inspector to scan on the next tick
   ============================================================================ */
(function(){
'use strict';
/* Single-instance guard. */
if (window.CrewInspector) return;

/* ================= tuning ================= */
/* POLL_MS — how often we look for new jobs to attach inspectors to. */
var POLL_MS=3000;
/* SCAN_EVERY_MS — per-inspector scan cadence (staggered by index). */
var SCAN_EVERY_MS=8000;
/* SCAN_R — inspector "sight" radius in game units. */
var SCAN_R=40;
/* SCAN_R2 — squared, for cheap distance checks. */
var SCAN_R2=SCAN_R*SCAN_R;
/* FX_R — radius for drawing collider rings during a scan. */
var FX_R=25;
/* FX_CAP — max collider rings drawn per scan (pool size). */
var FX_CAP=24;
/* PAIR_CAP — max in-radius colliders used for pairwise overlap checks. */
var PAIR_CAP=60;
/* TOAST_R removed 2026-10-24 with the finding toast it gated
   (Joshua): findings are recorded, not shown on the game view. */
/* FINDING_CAP — findings log cap. */
var FINDING_CAP=40;

/* ================= logging ================= */
/* _ilog(msg) — inspector log: Report panel when available, console always.
   Never throws. */
function _ilog(msg){
  try{
    if (typeof Report!=='undefined' && Report.note)
      Report.note('crewinspector', msg);
  }catch(e){}
  try{ console.log('[CrewInspector] '+msg); }catch(e){}
}
/* _toast removed 2026-10-24 (Joshua): inspector findings are
   crew reports — they are recorded via _ilog/Report.note exactly
   as before, but no longer displayed on the game view. */
function _nowT(){
  var d=new Date();
  function p(n){ return (n<10?'0':'')+n; }
  return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}
/* _gY(x,z) — ground height, fully guarded (copies the roadfix.js pattern). */
function _gY(x,z){
  try{
    if (typeof groundRefY==='function'){
      var y=groundRefY(x,z); if (isFinite(y)) return y;
    }
  }catch(e){}
  try{
    if (typeof terrainMeshY==='function'){
      var m=terrainMeshY(x,z); if (isFinite(m)) return m;
    }
  }catch(e){}
  try{
    if (typeof heightAt==='function'){
      /* v1.35 SNAP-TO-FACE (Joshua 2026-10-11). */
      try{ if(typeof snapToGround==='function'){ var sh=snapToGround(x,z,0,0,0); if(isFinite(sh)) return sh; } }catch(_){}
      var h=heightAt(x,z); if (isFinite(h)) return h;
    }
  }catch(e){}
  return 0;
}
/* _playerXZ() removed 2026-10-24: its only caller was the
   finding toast's range check, removed with the toast (above). */

/* ================= inspector figure =================
   Blocky worker in the same style as roadcrew's makeWorker(), but visually
   unmistakable: cyan hard hat, glowing cyan visor ("computer eyes"), navy
   vest with cyan reflective stripes. */
function _box(w,h,d,color,emissive){
  try{
    return new THREE.Mesh(new THREE.BoxGeometry(w,h,d),
      new THREE.MeshLambertMaterial({color:color, emissive:emissive||0x000000}));
  }catch(e){ return null; }
}
function makeInspectorFigure(){
  var g=null;
  try{
    g=new THREE.Group();
    /* legs — dark navy */
    var legs=_box(0.5,0.7,0.34,0x1c2330); legs.position.y=0.35; g.add(legs);
    /* torso — navy inspector vest */
    var torso=_box(0.62,0.72,0.4,0x1c2f4a,0x0a1626); torso.position.y=1.06; g.add(torso);
    /* cyan reflective stripes */
    var s1=_box(0.64,0.1,0.42,0x00e5ff,0x006677); s1.position.y=1.18; g.add(s1);
    var s2=_box(0.64,0.1,0.42,0x00e5ff,0x006677); s2.position.y=0.98; g.add(s2);
    /* head */
    var head=_box(0.36,0.36,0.36,0x6b4429); head.position.y=1.6; g.add(head);
    /* VISOR — the "computer eyes": glowing cyan band across the face. */
    var visor=_box(0.38,0.12,0.05,0x00ffff,0x00aaaa);
    visor.position.set(0,1.62,0.19); g.add(visor);
    /* hard hat — bright cyan, distinct from every crew's hat color */
    var hat=_box(0.44,0.16,0.44,0x00e5ff,0x006677); hat.position.y=1.84; g.add(hat);
    /* arms */
    var armL=_box(0.16,0.6,0.16,0x1c2f4a,0x0a1626); armL.position.set(-0.4,1.05,0); g.add(armL);
    var armR=armL.clone(); armR.position.set(0.4,1.05,0); g.add(armR);
    g.userData.armL=armL; g.userData.armR=armR;
  }catch(e){ return null; }
  return g;
}
/* Floating "🔍 INSPECTOR" tag — canvas sprite, department-cyan pill. */
function makeInspectorTag(){
  try{
    var cv=document.createElement('canvas');
    cv.width=256; cv.height=64;
    var cx=cv.getContext('2d');
    cx.fillStyle='rgba(6,20,28,0.85)';
    if (cx.roundRect){ cx.beginPath(); cx.roundRect(4,8,248,48,14); cx.fill(); }
    else cx.fillRect(4,8,248,48);
    cx.fillStyle='#00e5ff';
    cx.fillRect(4,8,10,48);
    cx.fillStyle='#ffffff';
    cx.font='bold 20px sans-serif';
    cx.textAlign='center'; cx.textBaseline='middle';
    cx.fillText('🔍 INSPECTOR', 136, 33);
    var tex=new THREE.CanvasTexture(cv);
    var sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex, depthTest:false, transparent:true}));
    sp.scale.set(3.6,0.9,1);
    sp.position.set(0,2.5,0);
    return sp;
  }catch(e){ return null; }
}
/* Red "⚠" finding marker sprite. */
function makeWarnMarker(){
  try{
    var cv=document.createElement('canvas');
    cv.width=128; cv.height=128;
    var cx=cv.getContext('2d');
    cx.font='bold 92px sans-serif';
    cx.textAlign='center'; cx.textBaseline='middle';
    cx.fillStyle='#ff3b30';
    cx.fillText('⚠',64,70);
    var tex=new THREE.CanvasTexture(cv);
    var sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex, depthTest:false, transparent:true}));
    sp.scale.set(2.2,2.2,1);
    return sp;
  }catch(e){ return null; }
}

/* ================= job enumeration =================
   Collect active jobs from both crew systems. Each entry:
   {key, kind:'road'|'infra', job, x, z} */
function enumJobs(){
  var out=[];
  try{
    var ops=window.__roadCrewOps;
    if (ops && typeof ops.jobs==='function'){
      var rj=ops.jobs()||[];
      for (var i=0;i<rj.length;i++){
        var j=rj[i]; if(!j||!j.group) continue;
        var d=j.defect||{};
        out.push({key:'road:'+i+':'+Math.round(d.x||0)+','+Math.round(d.z||0),
                  kind:'road', job:j, x:d.x||0, z:d.z||0});
      }
    }
  }catch(e){}
  try{
    var ij=(window.INFRACREW&&window.INFRACREW.jobs)||[];
    for (var k=0;k<ij.length;k++){
      var q=ij[k]; if(!q||!q.group) continue;
      var is=q.issue||{};
      out.push({key:'infra:'+k+':'+Math.round(is.x||0)+','+Math.round(is.z||0),
                kind:'infra', job:q, x:is.x||0, z:is.z||0});
    }
  }catch(e){}
  return out;
}
/* _ownColliders(job) — the job's own colliders, so the inspector doesn't
   flag its own truck/cones/signs/work-zone as problems. */
function _ownColliders(job){
  var set=[];
  try{
    if (job.truckCol) set.push(job.truckCol);
    (job.signCols||[]).forEach(function(c){ set.push(c); });
    (job.coneCols||[]).forEach(function(c){ set.push(c); });
    if (job.zoneCol) set.push(job.zoneCol);
  }catch(e){}
  return set;
}

/* ================= attach inspector ================= */
var _inspectors=[];   /* {kind, job, fig, x, z, nextScan, scanFx, markers:[], findings:n} */
function attachInspector(entry){
  try{
    var job=entry.job;
    if (job._inspector) return;   /* already has one */
    if (typeof THREE==='undefined' || !job.group) return;
    var fig=makeInspectorFigure();
    if (!fig) return;
    /* Stand off to the side of the site (7u), facing the work. */
    var ix=entry.x+7, iz=entry.z+3;
    fig.position.set(ix, _gY(ix,iz), iz);
    fig.rotation.y=Math.atan2(entry.x-ix, entry.z-iz);
    var tag=makeInspectorTag();
    if (tag) fig.add(tag);
    job.group.add(fig);
    /* Scan pulse ring (hidden until a scan runs). */
    var pulse=null;
    try{
      var pg=new THREE.RingGeometry(0.9,1.0,40);
      var pm=new THREE.MeshBasicMaterial({color:0x00e5ff, transparent:true,
        opacity:0, side:THREE.DoubleSide, depthWrite:false});
      pulse=new THREE.Mesh(pg,pm);
      pulse.rotation.x=-Math.PI/2;
      pulse.position.set(ix,_gY(ix,iz)+0.15,iz);
      job.group.add(pulse);
    }catch(e){}
    /* Collider-ring pool: the "X-ray vision" — faint cyan rings drawn on
       nearby invisible collider circles during a scan. */
    var ringPool=[];
    try{
      for (var r=0;r<FX_CAP;r++){
        var rg=new THREE.RingGeometry(0.92,1.0,28);
        var rm=new THREE.MeshBasicMaterial({color:0x00e5ff, transparent:true,
          opacity:0, side:THREE.DoubleSide, depthWrite:false});
        var ring=new THREE.Mesh(rg,rm);
        ring.rotation.x=-Math.PI/2;
        ring.visible=false;
        job.group.add(ring);
        ringPool.push(ring);
      }
    }catch(e){}
    var rec={kind:entry.kind, job:job, fig:fig, x:entry.x, z:entry.z,
             /* stagger first scan so all inspectors don't fire at once */
             nextScan:Date.now()+2000+_inspectors.length*1500,
             pulse:pulse, ringPool:ringPool, markers:[],
             fxUntil:0, findings:0, scanCount:0};
    job._inspector=rec;
    _inspectors.push(rec);
    _ilog('Inspector assigned to '+entry.kind+' crew @ ('+
          Math.round(entry.x)+', '+Math.round(entry.z)+').');
  }catch(e){}
}
/* Drop inspectors whose jobs are gone (group removed by the crew system). */
function pruneInspectors(liveKeys){
  for (var i=_inspectors.length-1;i>=0;i--){
    var rec=_inspectors[i];
    try{
      var stillThere=false;
      for (var k=0;k<liveKeys.length;k++){
        if (liveKeys[k].job===rec.job){ stillThere=true; break; }
      }
      if (!stillThere){
        /* Job finished — figure/markers/pulse were inside job.group, which
           the crew system already removed from the scene. Just forget it. */
        try{ if (rec.job) rec.job._inspector=null; }catch(e){}
        _inspectors.splice(i,1);
      }
    }catch(e){}
  }
}

/* ================= findings ================= */
var _findings=[];   /* {t, crew, type, msg, x, z} newest last */
function addFinding(rec, type, msg, fx, fz){
  try{
    var f={t:_nowT(), crew:rec.kind, type:type, msg:String(msg),
           x:Math.round(fx), z:Math.round(fz)};
    _findings.push(f);
    while (_findings.length>FINDING_CAP) _findings.shift();
    rec.findings++;
    /* Red ⚠ marker at the spot (inside job.group → auto-cleanup). */
    try{
      var m=makeWarnMarker();
      if (m){
        m.position.set(fx, _gY(fx,fz)+3.2, fz);
        rec.job.group.add(m);
        rec.markers.push(m);
      }
    }catch(e){}
    _ilog('['+rec.kind+' @ '+f.x+','+f.z+'] '+type+': '+msg);
    /* No viewport toast (Joshua 2026-10-24): the finding is
       recorded by _ilog above; crew reports are read in the
       Administrator menu, not on the game view. */
  }catch(e){}
}
function clearMarkers(rec){
  try{
    for (var i=0;i<rec.markers.length;i++){
      var m=rec.markers[i];
      if (m && m.parent) m.parent.remove(m);
    }
    rec.markers=[];
  }catch(e){}
}

/* ================= the scan =================
   The inspector's "computer eyes": one bounded pass over the collider
   array plus stuck-system reads. Everything squared-distance, everything
   capped. */
function runScan(rec){
  var now=Date.now();
  rec.scanCount++;
  clearMarkers(rec);   /* fresh markers each scan; resolved issues vanish */
  var sx=rec.x, sz=rec.z;
  var own=_ownColliders(rec.job);
  var ownSet=null;
  try{
    ownSet=new Set();
    for (var o=0;o<own.length;o++) ownSet.add(own[o]);
  }catch(e){ ownSet=null; }
  function isOwn(c){
    if (!c) return true;
    try{ if (ownSet && ownSet.has(c)) return true; }catch(e){}
    /* belt & suspenders: job cones/zones flagged at creation */
    try{ if (c._cone || c._workzone) return true; }catch(e){}
    return false;
  }
  /* --- 1. colliders in radius (bounded single pass) --- */
  var near=[];
  try{
    var arr=(typeof colliders!=='undefined' && colliders)||[];
    for (var i=0;i<arr.length;i++){
      var c=arr[i];
      if (!c || isOwn(c)) continue;
      var dx=c.x-sx, dz=c.z-sz;
      if (dx*dx+dz*dz < SCAN_R2){
        near.push(c);
        if (near.length>=200) break;   /* hard cap — dense areas stay cheap */
      }
    }
  }catch(e){}
  /* --- 2. overlapping collider pairs (map-error signature) --- */
  try{
    var n=Math.min(near.length, PAIR_CAP);
    var reported=0;
    for (var a=0;a<n && reported<3;a++){
      for (var b=a+1;b<n && reported<3;b++){
        var ca=near[a], cb=near[b];
        var ddx=ca.x-cb.x, ddz=ca.z-cb.z;
        var rr=(ca.r||1)+(cb.r||1);
        /* overlap, but not near-identical duplicates (same prop twice) */
        if (ddx*ddx+ddz*ddz < rr*rr && ddx*ddx+ddz*ddz > 0.01){
          addFinding(rec,'collider-overlap',
            'Overlapping colliders @ ('+Math.round(ca.x)+','+Math.round(ca.z)+
            ') r='+(ca.r||1)+' + ('+Math.round(cb.x)+','+Math.round(cb.z)+
            ') r='+(cb.r||1),
            (ca.x+cb.x)/2,(ca.z+cb.z)/2);
          reported++;
        }
      }
    }
  }catch(e){}
  /* --- 3. stuck-unit hotspots near the site --- */
  try{
    var hs=window.__stuckHotspots||[];
    for (var h=0;h<hs.length;h++){
      var sp=hs[h]; if(!sp) continue;
      var hx=sp.x||0, hz=sp.z||0;
      var hdx=hx-sx, hdz=hz-sz;
      if (hdx*hdx+hdz*hdz < SCAN_R2){
        addFinding(rec,'stuck-hotspot',
          'Stuck-unit hotspot @ ('+Math.round(hx)+','+Math.round(hz)+')'+
          (sp.count?' — '+sp.count+' events':''),
          hx,hz);
        break;   /* one is enough to flag the area */
      }
    }
  }catch(e){}
  /* --- 4. StuckDiag bad spots near the site --- */
  try{
    if (window.StuckDiag && typeof window.StuckDiag.badSpots==='function'){
      var bs=window.StuckDiag.badSpots()||[];
      for (var s=0;s<bs.length;s++){
        var bp=bs[s]; if(!bp) continue;
        var bx=bp.x||0, bz=bp.z||0;
        var bdx=bx-sx, bdz=bz-sz;
        if (bdx*bdx+bdz*bdz < SCAN_R2){
          addFinding(rec,'bad-spot',
            'StuckDiag bad spot ('+(bp.cause||'unknown')+') @ ('+
            Math.round(bx)+','+Math.round(bz)+')', bx,bz);
          break;
        }
      }
    }
  }catch(e){}
  /* --- 5. overlapping work zones (another crew's perimeter on our site) --- */
  try{
    for (var q=0;q<_inspectors.length;q++){
      var other=_inspectors[q];
      if (other===rec || !other.job) continue;
      var zc=other.job.zoneCol;
      if (!zc) continue;
      var zdx=(zc.x||0)-sx, zdz=(zc.z||0)-sz;
      var zrr=(zc.r||10)+12;   /* this site's own perimeter ≈12u */
      if (zdx*zdx+zdz*zdz < zrr*zrr){
        addFinding(rec,'zone-overlap',
          'Overlapping work zone — '+other.kind+' crew perimeter @ ('+
          Math.round(zc.x||0)+','+Math.round(zc.z||0)+')',
          zc.x||0, zc.z||0);
        break;
      }
    }
  }catch(e){}
  /* --- 6. VISUAL/MATERIAL DEFECTS (Joshua 2026-10-11):
         "That's what the inspectors and the drones are to look for.
         Mistakes in material, textures, and the whole visual."
         Ground-level detailed scan via window.VisualInspect. */
  try{
    if (window.VisualInspect && typeof window.VisualInspect.scanGround==='function'){
      var vdefs=window.VisualInspect.scanGround(sx, sz, SCAN_R)||[];
      /* Cap visual findings per scan so one bad area doesn't spam. */
      var vmax=Math.min(vdefs.length, 4);
      for (var v=0;v<vmax;v++){
        var vd=vdefs[v];
        if (!vd) continue;
        addFinding(rec, 'visual-'+(vd.type||'defect'),
          '[visual] '+(vd.msg||'visual defect'), vd.x, vd.z);
      }
    }
  }catch(e){}
  /* --- scan FX: pulse + collider rings (the visible "X-ray") --- */
  rec.fxUntil=now+1400;
  try{
    var shown=0;
    for (var f=0;f<rec.ringPool.length;f++){
      var ring=rec.ringPool[f];
      if (f<near.length && shown<FX_CAP){
        var nc=near[f];
        var ndx=nc.x-sx, ndz=nc.z-sz;
        if (ndx*ndx+ndz*ndz < FX_R*FX_R){
          var rr2=nc.r||1;
          ring.scale.set(rr2,rr2,1);
          ring.position.set(nc.x,_gY(nc.x,nc.z)+0.25,nc.z);
          ring.visible=true;
          shown++;
        } else ring.visible=false;
      } else ring.visible=false;
    }
  }catch(e){}
  rec.nextScan=now+SCAN_EVERY_MS;
}

/* ================= frame tick =================
   Chained into animate(). Handles scan scheduling + FX animation.
   The FX is a handful of lerps — negligible per-frame cost. */
var _t=0;
function tick(dt){
  _t+=dt;
  var now=Date.now();
  try{
    for (var i=0;i<_inspectors.length;i++){
      var rec=_inspectors[i];
      if (!rec || !rec.fig) continue;
      /* schedule scans (staggered) */
      if (now>=rec.nextScan) runScan(rec);
      /* inspector slowly sweeps while idle — the "looking around" read */
      try{
        rec.fig.rotation.y+=Math.sin(_t*0.6+i)*0.004;
      }catch(e){}
      /* scan pulse FX */
      var fxOn=now<rec.fxUntil;
      try{
        if (rec.pulse){
          if (fxOn){
            var k=1-(rec.fxUntil-now)/1400;   /* 0→1 */
            var s=2+k*(SCAN_R-2);
            rec.pulse.scale.set(s,s,1);
            rec.pulse.material.opacity=0.55*(1-k);
            rec.pulse.visible=true;
          } else {
            rec.pulse.visible=false;
            /* hide collider rings when the pulse ends */
            for (var r=0;r<rec.ringPool.length;r++)
              rec.ringPool[r].visible=false;
          }
        }
        /* finding markers bob gently so they catch the eye */
        for (var m=0;m<rec.markers.length;m++){
          var mk=rec.markers[m];
          if (mk) mk.position.y+=Math.sin(_t*3+m)*0.008;
        }
      }catch(e){}
    }
  }catch(e){}
}

/* ================= poll loop ================= */
function poll(){
  try{
    var jobs=enumJobs();
    for (var i=0;i<jobs.length;i++) attachInspector(jobs[i]);
    pruneInspectors(jobs);
  }catch(e){}
}

/* ================= boot ================= */
function boot(){
  try{
    poll();
    setInterval(poll, POLL_MS);
    /* chain into animate() */
    try{
      /* v1.51 TICK REGISTRY (expert report #14, James Park, Joshua approved):
         was an animate() monkey-patch — now registers on the central Sim tick
         registry. Same once-per-frame timing, deterministic priority order. */
      if(window.Sim && typeof Sim.onTick==='function' && !window.__inspectorTickReg){
        window.__inspectorTickReg=true;
        Sim.onTick('render', 63, function(dt){ tick(0.016); });
      }
    }catch(e){}
    try{
      if (typeof Report!=='undefined' && Report.setSys)
        Report.setSys('crewinspector',{active:true,
          note:'One X-ray inspector NPC per work-crew team'});
    }catch(e){}
    _ilog('Crew Inspector online — one inspector per work-crew team.');
  }catch(e){}
}
/* Boot when scene exists; retry (late-load safe). */
var _tries=0;
var _bootTimer=setInterval(function(){

  /* v1.34 LAUNCHER SKIP (Joshua 2026-10-11): player unchecked this system
     in launch options — do not initialize at all. The deferred loader
     normally skips the script entirely; this is the backstop. */
  if (window.__launchOpts && window.__launchOpts.roadCrew===false && window.__launchOpts.infraCrew===false){ try{clearInterval(_bootTimer);}catch(e){} return; }
  _tries++;
  try{
    if (typeof THREE!=='undefined' && typeof scene!=='undefined' && scene){
      clearInterval(_bootTimer);
      boot();
    } else if (_tries>40){
      clearInterval(_bootTimer);
    }
  }catch(e){}
}, 500);

/* ================= public API ================= */
window.CrewInspector={
  findings:function(){ return _findings.slice(); },
  inspectors:function(){
    return _inspectors.map(function(r){
      return {crew:r.kind, x:Math.round(r.x), z:Math.round(r.z),
              scans:r.scanCount, findings:r.findings};
    });
  },
  scanNow:function(){
    try{
      var now=Date.now();
      _inspectors.forEach(function(r){ r.nextScan=Math.min(r.nextScan,now); });
      return _inspectors.length;
    }catch(e){ return 0; }
  }
};
})();
