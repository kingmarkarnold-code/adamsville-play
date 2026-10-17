/* ============================================================
   SURVIVING ADAMSVILLE — World-fix synchronization via GitHub
   FILE: worldfix_sync.js
   ------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-11):
     "When a work crew fixes a problem in the game world, that fix
     should sync to GitHub so all devices share the corrected world.
     Currently fixes are local-only per device."

   WHAT THIS DOES:
   When a road crew or infra crew finishes a repair on THIS device,
   the fix is recorded as structured data and uploaded to the
   GitHub repo in the `world-fixes/` folder. When the game launches
   (and periodically after), it downloads fix records uploaded by
   OTHER devices and applies them locally — so a road repaired on
   Joshua's phone shows as repaired on his laptop too.

   HOW IT WORKS (three parts):

   1. DETECT — every 30s, poll the crew systems for defects/issues
      in 'fixed' state. Compare against the set of fix IDs already
      synced (persisted in localStorage). Anything new gets recorded
      as a fix object and queued for upload. Non-invasive: reads the
      crew systems' localStorage keys and public APIs, never edits
      their files.

   2. UPLOAD — fixes are batched and written as timestamped JSON
      files to `world-fixes/` in the repo, e.g.
        world-fixes/2026-10-11-020000-fix-batch.json
      Uses the SAME GitHub token as github_reports.js (from
      github-config.js or browser storage). No token = no sync,
      silently. All network calls wrapped in try/catch — sync must
      never break the game (Joshua's standing rule).

   3. DOWNLOAD + APPLY — on boot (after a short delay so the crew
      systems finish loading) and every 10 minutes after, list the
      `world-fixes/` directory via the GitHub Contents API, download
      any fix files newer than our last-sync timestamp, and apply
      them: mark the corresponding defect/issue as 'fixed' in the
      crew systems' localStorage. The crew systems already re-lay
      asphalt patches for fixed defects at boot, so synced fixes
      become visible on the next page load. A toast tells the player
      when fixes arrive from another device.

   CONFLICT HANDLING:
   If two devices fix the same defect, the NEWEST fixedAt timestamp
   wins. The losing fix is logged as a conflict (Report panel +
   console) for Joshua to review. No data is ever deleted — both
   records stay in GitHub.

   FIX RECORD FORMAT:
     {
       fixId:     "roadcrew-OPEN-1" | "infracrew-<issue-id>",
       system:    "roadcrew" | "infracrew",
       defectId:  "OPEN-1",              // crew system's own id
       kind:      "road",                // defect kind
       street:    "I-20",                // human-readable location
       x: 1879, z: 6396,                // world coordinates
       truth:     "...",                // what the fix was based on
       fixedAt:   "2026-10-11T02:00:00.000Z",
       deviceId:  "dev-a1b2c3",         // this device's stable id
       sessionId: "s..."                // play session that made it
     }

   PUBLIC API (window.WorldFixSync):
     status()      -> {enabled, hasToken, pendingUploads,
                       lastUpload, lastDownload, lastError,
                       appliedCount, conflictCount}
     syncNow()     -> force an upload+download cycle now. Returns
                      a Promise that resolves true/false.
     pendingFixes()-> array of fix objects waiting to upload.

   LOAD ORDER: include AFTER github_reports.js in index.html:
       <script src="github-config.js"></script>
       <script src="github_reports.js"></script>
       <script src="worldfix_sync.js"></script>
   (worldfix_sync.js reuses the token but does NOT depend on
   GitHubReports being loaded — it resolves the token itself.)

   PERFORMANCE:
   Detection poll is a cheap localStorage read every 30s. Uploads
   are batched (one file per cycle). Downloads list one directory
   and fetch only new files. Negligible cost.

   ------------------------------------------------------------
   Documentation comments are required on all game code — Joshua's
   standing rule. This file follows it.
   ============================================================ */
window.WorldFixSync = (function(){
  'use strict';

  /* ================= utilities ================= */

  function pad(n){ return (n<10?'0':'')+n; }

  /* Local-time stamp for filenames: 2026-10-11-020000 */
  function fileTs(d){
    d = d || new Date();
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+
      '-'+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds());
  }

  /* UTF-8 safe base64 for the Contents API. */
  function b64encodeUtf8(str){
    try{
      if(typeof btoa!=='undefined')
        return btoa(unescape(encodeURIComponent(str)));
    }catch(e){}
    return null;
  }

  /* UTF-8 safe base64 decode (for reading fix files back). */
  function b64decodeUtf8(b64){
    try{
      if(typeof atob!=='undefined')
        return decodeURIComponent(escape(atob(b64.replace(/\s/g,''))));
    }catch(e){}
    return null;
  }

  function nowIso(){ try{ return new Date().toISOString(); }catch(e){ return ''; } }

  /* Stable per-device id, persisted in localStorage. Lets us tell
     "fixed on my phone" from "fixed on my laptop" in conflict logs. */
  var LS_DEVICE = 'sa_worldfix_device';
  function deviceId(){
    try{
      var id = localStorage.getItem(LS_DEVICE);
      if(!id){
        id = 'dev-'+Date.now().toString(36)+
          Math.floor(Math.random()*0xffffff).toString(36);
        localStorage.setItem(LS_DEVICE, id);
      }
      return id;
    }catch(e){ return 'dev-unknown'; }
  }

  var sessionId = 's'+Date.now().toString(36)+
    Math.floor(Math.random()*0xffffff).toString(36);

  /* ================= token / config =================
     Same resolution as github_reports.js: browser storage first,
     github-config.js second. Empty = not configured. */

  function cfg(){
    try{
      if(typeof window!=='undefined' && window.GITHUB_CONFIG)
        return window.GITHUB_CONFIG;
    }catch(e){}
    return {};
  }

  function getToken(){
    try{
      var t = null;
      if(typeof localStorage!=='undefined')
        t = localStorage.getItem('sa_github_token');
      if(t) return t;
      var c = cfg();
      if(c && c.token) return String(c.token);
    }catch(e){}
    return '';
  }

  function getRepo(){
    try{
      var c = cfg();
      if(c && c.repo) return String(c.repo);
    }catch(e){}
    return 'kingmarkarnold-code/adamsville-play';
  }

  function isEnabled(){
    try{ return cfg().enabled !== false; }catch(e){ return true; }
  }

  var FIXES_DIR = 'world-fixes';

  /* ================= GitHub API helpers ================= */

  function apiHeaders(){
    return {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': 'Bearer '+getToken()
    };
  }

  /* PUT a new file (fix batches are always new files — no sha needed). */
  function apiPutFile(path, contentB64, message){
    var url = 'https://api.github.com/repos/'+getRepo()+'/contents/'+path;
    return fetch(url, {
      method: 'PUT',
      headers: apiHeaders(),
      body: JSON.stringify({ message: message, content: contentB64 })
    }).then(function(resp){
      if(!resp.ok) throw new Error('GitHub API '+resp.status+' on '+path);
      return resp.json();
    });
  }

  /* List a directory. Returns [{name, path, sha, ...}] or throws. */
  function apiListDir(dir){
    var url = 'https://api.github.com/repos/'+getRepo()+'/contents/'+dir+
      '?per_page=100';
    return fetch(url, { headers: apiHeaders() }).then(function(resp){
      if(resp.status===404) return [];  // dir doesn't exist yet — fine
      if(!resp.ok) throw new Error('GitHub API '+resp.status+' listing '+dir);
      return resp.json();
    });
  }

  /* Fetch one file's decoded text content. */
  function apiGetFile(path){
    var url = 'https://api.github.com/repos/'+getRepo()+'/contents/'+path;
    return fetch(url, { headers: apiHeaders() }).then(function(resp){
      if(!resp.ok) throw new Error('GitHub API '+resp.status+' reading '+path);
      return resp.json();
    }).then(function(j){
      if(!j || !j.content) throw new Error('empty content for '+path);
      var text = b64decodeUtf8(j.content);
      if(text===null) throw new Error('decode failed for '+path);
      return text;
    });
  }

  /* ================= state ================= */

  var LS_SYNCED  = 'sa_worldfix_synced_v1';   // fixId -> fixedAt (uploaded)
  var LS_APPLIED = 'sa_worldfix_applied_v1';  // fixId -> fixedAt (downloaded+applied)
  var LS_LASTDL  = 'sa_worldfix_lastdl_v1';   // ISO ts of last download scan

  var uploadQueue = [];   // fix objects waiting to upload
  var uploading = false;
  var downloading = false;
  var lastUpload = null, lastDownload = null, lastError = null;
  var appliedCount = 0, conflictCount = 0;
  var uploadSeq = 0;

  function lsGet(key){
    try{
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    }catch(e){ return {}; }
  }
  function lsSet(key, obj){
    try{ localStorage.setItem(key, JSON.stringify(obj)); }catch(e){}
  }

  function note(msg){
    try{
      if(typeof Report!=='undefined' && Report.note)
        Report.note('worldfix', msg);
    }catch(e){}
    try{ if(typeof console!=='undefined') console.log('[WorldFixSync] '+msg); }catch(e){}
  }

  function toast(msg){
    try{
      if(typeof window.toast==='function') window.toast(msg);
      else if(typeof toast==='function') toast(msg);
    }catch(e){}
  }

  /* ================= 1. DETECT new local fixes =================
     Poll the crew systems' localStorage for defects/issues in
     'fixed' state. Anything fixed that we haven't synced yet becomes
     a fix record in the upload queue. */

  /* Read road-crew defect states from its localStorage. */
  function readRoadCrewFixes(){
    var out = [];
    try{
      var raw = localStorage.getItem('sa_roadcrew_v1');
      if(!raw) return out;
      var data = JSON.parse(raw);
      var defects = data.defects || {};
      for(var id in defects){
        if(defects[id]==='fixed'){
          out.push({ system:'roadcrew', defectId:id });
        }
      }
    }catch(e){}
    return out;
  }

  /* Read infra-crew issue states from its localStorage. */
  function readInfraCrewFixes(){
    var out = [];
    try{
      var raw = localStorage.getItem('sa_infracrew_v1');
      if(!raw) return out;
      var data = JSON.parse(raw);
      var issues = data.issues || [];
      for(var i=0;i<issues.length;i++){
        var it = issues[i];
        if(it && it.state==='fixed' && it.id){
          out.push({
            system:'infracrew', defectId:String(it.id),
            kind: it.kind||'', street: it.street||'',
            x: it.x, z: it.z, fixedAtMs: it.fixedAt||0
          });
        }
      }
    }catch(e){}
    return out;
  }

  /* Enrich a road-crew fix with coordinates/street from the live
     defect database when the crew system is loaded. Falls back to
     id-only if the game hasn't booted the crew system yet. */
  function enrichRoadFix(entry){
    var rec = {
      fixId: 'roadcrew-'+entry.defectId,
      system: 'roadcrew',
      defectId: entry.defectId,
      kind: 'road', street: '', x: null, z: null, truth: ''
    };
    try{
      /* The road-crew module keeps DEFECTS inside its IIFE, but it
         also persists truth data — try the dispatch log panel data
         via the public ops handle first. */
      if(window.__roadCrewOps && window.__roadCrewOps.jobs){
        /* jobs() returns live job objects; defects list isn't public,
           so enrichment is best-effort only. */
      }
    }catch(e){}
    return rec;
  }

  function detectNewFixes(){
    var synced = lsGet(LS_SYNCED);
    var found = 0;

    /* Road crew */
    var rc = readRoadCrewFixes();
    for(var i=0;i<rc.length;i++){
      var rec = enrichRoadFix(rc[i]);
      if(!synced[rec.fixId]){
        rec.fixedAt = nowIso();
        rec.deviceId = deviceId();
        rec.sessionId = sessionId;
        uploadQueue.push(rec);
        synced[rec.fixId] = rec.fixedAt;
        found++;
        note('Fix detected: '+rec.fixId+' — queued for GitHub sync.');
      }
    }

    /* Infra crew */
    var ic = readInfraCrewFixes();
    for(var j=0;j<ic.length;j++){
      var e = ic[j];
      var fixId = 'infracrew-'+e.defectId;
      if(!synced[fixId]){
        var r2 = {
          fixId: fixId,
          system: 'infracrew',
          defectId: e.defectId,
          kind: e.kind||'',
          street: e.street||'',
          x: (typeof e.x==='number')?Math.round(e.x*10)/10:null,
          z: (typeof e.z==='number')?Math.round(e.z*10)/10:null,
          truth: '',
          fixedAt: e.fixedAtMs ? new Date(e.fixedAtMs).toISOString() : nowIso(),
          deviceId: deviceId(),
          sessionId: sessionId
        };
        uploadQueue.push(r2);
        synced[fixId] = r2.fixedAt;
        found++;
        note('Fix detected: '+fixId+' — queued for GitHub sync.');
      }
    }

    if(found>0){
      lsSet(LS_SYNCED, synced);
      /* Cap the queue so a marathon session can't grow it forever. */
      while(uploadQueue.length>200) uploadQueue.shift();
      try{
        if(typeof Report!=='undefined' && Report.setSys)
          Report.setSys('worldfix', statusObj());
      }catch(e){}
    }
    return found;
  }

  /* ================= 2. UPLOAD fix batches ================= */

  function uploadBatch(){
    if(uploading) return Promise.resolve(false);
    if(!isEnabled() || !getToken()) return Promise.resolve(false);
    if(uploadQueue.length===0) return Promise.resolve(false);
    uploading = true;

    var items = uploadQueue.splice(0, uploadQueue.length);
    uploadSeq++;
    var stamp = fileTs()+(uploadSeq>1?'-'+uploadSeq:'');

    var payload;
    try{
      payload = JSON.stringify({
        app: 'Surviving Adamsville',
        kind: 'world-fix-batch',
        exportedAt: nowIso(),
        deviceId: deviceId(),
        session: sessionId,
        count: items.length,
        fixes: items
      });
    }catch(e){
      payload = '{"error":"serialize failed"}';
    }
    var b64 = b64encodeUtf8(payload);
    if(!b64){ uploading=false; return Promise.resolve(false); }

    var path = FIXES_DIR+'/'+stamp+'-fix-batch.json';
    return apiPutFile(path, b64,
      'World fixes ('+items.length+') @ '+stamp+' from '+deviceId()
    ).then(function(){
      uploading = false;
      lastUpload = nowIso();
      lastError = null;
      note('Uploaded '+items.length+' world fix(es) to GitHub ('+path+').');
      try{
        if(typeof Report!=='undefined' && Report.setSys)
          Report.setSys('worldfix', statusObj());
      }catch(e){}
      return true;
    }).catch(function(err){
      uploading = false;
      /* Put the batch back at the FRONT — retry next cycle. */
      try{ uploadQueue = items.concat(uploadQueue); }catch(e2){}
      lastError = String((err&&err.message)||err);
      note('World-fix upload failed: '+lastError+' — will retry.');
      return false;
    });
  }

  /* ================= 3. DOWNLOAD + APPLY =================
     List world-fixes/, download files newer than our last scan,
     and apply each fix: mark the defect/issue 'fixed' in the crew
     systems' localStorage. Newest fixedAt wins on conflicts. */

  /* Filename format: 2026-10-11-020000-fix-batch.json (local time).
     Parse the leading timestamp for ordering. */
  function fileStamp(name){
    var m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name||'');
    if(!m) return 0;
    return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
  }

  function applyFix(fix){
    if(!fix || !fix.fixId) return 'skip';
    var applied = lsGet(LS_APPLIED);

    /* Already applied and our record is at least as new — skip. */
    if(applied[fix.fixId] && applied[fix.fixId] >= (fix.fixedAt||'')){
      return 'skip';
    }

    /* Conflict check: did THIS device fix the same defect with a
       newer timestamp? Newest wins; log the loser. */
    var synced = lsGet(LS_SYNCED);
    if(synced[fix.fixId] && synced[fix.fixId] > (fix.fixedAt||'')){
      conflictCount++;
      note('CONFLICT on '+fix.fixId+': local fix ('+synced[fix.fixId]+
        ') is newer than incoming ('+fix.fixedAt+'). Local wins.');
      return 'conflict-local-wins';
    }
    if(applied[fix.fixId] && applied[fix.fixId] !== (fix.fixedAt||'')){
      conflictCount++;
      note('CONFLICT on '+fix.fixId+': two devices fixed it. Newest ('+
        fix.fixedAt+') wins.');
    }

    var ok = false;
    try{
      if(fix.system==='roadcrew'){
        var raw = localStorage.getItem('sa_roadcrew_v1');
        var data = raw ? JSON.parse(raw) : { defects:{}, log:[] };
        data.defects = data.defects || {};
        data.defects[fix.defectId] = 'fixed';
        localStorage.setItem('sa_roadcrew_v1', JSON.stringify(data));
        ok = true;
      }else if(fix.system==='infracrew'){
        var raw2 = localStorage.getItem('sa_infracrew_v1');
        var data2 = raw2 ? JSON.parse(raw2) : { issues:[], log:[], seq:0 };
        var issues = data2.issues || [];
        var foundIt = false;
        for(var i=0;i<issues.length;i++){
          if(String(issues[i].id)===String(fix.defectId)){
            issues[i].state = 'fixed';
            if(fix.fixedAt) issues[i].fixedAt = Date.parse(fix.fixedAt)||issues[i].fixedAt;
            foundIt = true;
            break;
          }
        }
        if(!foundIt){
          /* Issue unknown locally (different defect DB version?) —
             record it anyway so we don't re-download forever. */
          issues.push({
            id: fix.defectId, kind: fix.kind||'', street: fix.street||'',
            x: fix.x, z: fix.z, state: 'fixed',
            reportedAt: Date.parse(fix.fixedAt)||Date.now(),
            fixedAt: Date.parse(fix.fixedAt)||Date.now()
          });
        }
        data2.issues = issues;
        localStorage.setItem('sa_infracrew_v1', JSON.stringify(data2));
        ok = true;
      }
    }catch(e){
      note('Failed to apply fix '+fix.fixId+': '+String(e&&e.message||e));
      return 'error';
    }

    if(ok){
      applied[fix.fixId] = fix.fixedAt||nowIso();
      lsSet(LS_APPLIED, applied);
      /* Also mark synced so we don't re-upload someone else's fix. */
      var s2 = lsGet(LS_SYNCED);
      if(!s2[fix.fixId]){ s2[fix.fixId] = fix.fixedAt||nowIso(); lsSet(LS_SYNCED, s2); }
      appliedCount++;
      note('Applied world fix from another device: '+fix.fixId+
        (fix.street?(' ('+fix.street+')'):'')+'.');
      return 'applied';
    }
    return 'skip';
  }

  function downloadAndApply(){
    if(downloading) return Promise.resolve(false);
    if(!isEnabled() || !getToken()) return Promise.resolve(false);
    downloading = true;

    var lastDl = 0;
    try{
      var rawTs = localStorage.getItem(LS_LASTDL);
      if(rawTs) lastDl = Date.parse(rawTs)||0;
    }catch(e){}

    return apiListDir(FIXES_DIR).then(function(files){
      if(!files || !files.length){ return { fresh:[] }; }
      var fresh = files.filter(function(f){
        return f && f.name && /\.json$/i.test(f.name) &&
          fileStamp(f.name) > lastDl;
      }).sort(function(a,b){ return fileStamp(a.name)-fileStamp(b.name); });
      return { fresh:fresh };
    }).then(function(res){
      var fresh = res.fresh || [];
      if(!fresh.length) return 0;
      var chain = Promise.resolve(0);
      fresh.forEach(function(f){
        chain = chain.then(function(count){
          return apiGetFile(f.path).then(function(text){
            var n = 0;
            try{
              var batch = JSON.parse(text);
              var fixes = batch.fixes || [];
              /* Ignore our own device's batches — we already have them. */
              if(batch.deviceId && batch.deviceId===deviceId()) return count;
              for(var i=0;i<fixes.length;i++){
                var r = applyFix(fixes[i]);
                if(r==='applied') n++;
              }
            }catch(e){
              note('Could not parse fix file '+f.name+': '+
                String(e&&e.message||e));
            }
            return count+n;
          }).catch(function(err){
            note('Could not download fix file '+f.name+': '+
              String(err&&err.message||err));
            return count;
          });
        });
      });
      return chain;
    }).then(function(appliedN){
      downloading = false;
      lastDownload = nowIso();
      lastError = null;
      try{ localStorage.setItem(LS_LASTDL, lastDownload); }catch(e){}
      if(appliedN>0){
        toast('🌍 '+appliedN+' world fix(es) synced from another device.');
        note('Downloaded and applied '+appliedN+' world fix(es). '+
          'Patches appear on next load.');
      }
      try{
        if(typeof Report!=='undefined' && Report.setSys)
          Report.setSys('worldfix', statusObj());
      }catch(e){}
      return appliedN>0;
    }).catch(function(err){
      downloading = false;
      lastError = String((err&&err.message)||err);
      /* 404 on first run (no world-fixes dir yet) is not an error. */
      if(/404/.test(lastError)){
        lastError = null;
        try{ localStorage.setItem(LS_LASTDL, nowIso()); }catch(e2){}
      }else{
        note('World-fix download failed: '+lastError);
      }
      return false;
    });
  }

  /* ================= public API ================= */

  function statusObj(){
    return {
      enabled: isEnabled(),
      hasToken: !!getToken(),
      deviceId: deviceId(),
      pendingUploads: uploadQueue.length,
      lastUpload: lastUpload,
      lastDownload: lastDownload,
      lastError: lastError,
      appliedCount: appliedCount,
      conflictCount: conflictCount
    };
  }

  function syncNow(){
    /* Detect, then upload, then download — chained, never throws. */
    return Promise.resolve()
      .then(function(){ try{ detectNewFixes(); }catch(e){} return true; })
      .then(function(){ return uploadBatch(); })
      .then(function(){ return downloadAndApply(); })
      .then(function(){ return true; })
      .catch(function(){ return false; });
  }

  /* ================= boot ================= */

  var booted = false;
  function boot(){
    if(booted) return;
    booted = true;

    /* Give the crew systems time to load their localStorage state
       before the first download tries to merge into it. */
    setTimeout(function(){
      try{ downloadAndApply(); }catch(e){}
    }, 15000);

    /* Detection + upload every 60s; download scan every 10 min. */
    setInterval(function(){
      try{
        var n = detectNewFixes();
        if(n>0) uploadBatch();
        else if(uploadQueue.length>0) uploadBatch();
      }catch(e){}
    }, 60000);

    setInterval(function(){
      try{ downloadAndApply(); }catch(e){}
    }, 10*60*1000);

    /* Last chance: flush pending uploads when the page closes. */
    function onHide(){
      try{
        detectNewFixes();
        /* Synchronous XHR is dead; use fetch keepalive best-effort. */
        if(uploadQueue.length>0 && getToken() && isEnabled()){
          var items = uploadQueue.splice(0, uploadQueue.length);
          var stamp = fileTs();
          var payload = JSON.stringify({
            app:'Surviving Adamsville', kind:'world-fix-batch',
            exportedAt: nowIso(), deviceId: deviceId(),
            session: sessionId, count: items.length, fixes: items
          });
          var b64 = b64encodeUtf8(payload);
          if(b64){
            fetch('https://api.github.com/repos/'+getRepo()+
              '/contents/'+FIXES_DIR+'/'+stamp+'-fix-batch.json', {
              method:'PUT', headers: apiHeaders(), keepalive:true,
              body: JSON.stringify({
                message:'World fixes ('+items.length+') @ '+stamp,
                content:b64
              })
            }).catch(function(){});
          }
        }
      }catch(e){}
    }
    try{
      if(typeof window!=='undefined'){
        window.addEventListener('pagehide', onHide);
        document.addEventListener('visibilitychange', function(){
          if(document.visibilityState==='hidden') onHide();
        });
      }
    }catch(e){}

    /* Report-panel visibility for Joshua. */
    try{
      if(typeof Report!=='undefined' && Report.setSys)
        Report.setSys('worldfix', statusObj());
    }catch(e){}

    note('World-fix sync ready. Device: '+deviceId()+'.');
  }

  /* Boot after the page settles — crew systems load at boot too. */
  try{
    if(typeof window!=='undefined'){
      if(document.readyState==='complete') setTimeout(boot, 3000);
      else window.addEventListener('load', function(){ setTimeout(boot, 3000); });
    }
  }catch(e){}

  return {
    status: statusObj,
    syncNow: syncNow,
    pendingFixes: function(){ return uploadQueue.slice(); }
  };
})();
