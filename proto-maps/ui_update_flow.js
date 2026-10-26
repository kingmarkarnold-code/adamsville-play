/* ============================================================================
   UI UPDATE FLOW v1.0 (2026-10-17) — MID-SESSION "DOWNLOAD NEWEST UI"
   ----------------------------------------------------------------------------
   Joshua's design (2026-10-17 21:49 EDT): "if you are in the menu and you
   tap upload or download the newest UI it should automatically pause the
   game … it can collapse the menu, close the menu, go ahead and download
   the resources allowing you to play around, save the position in cache
   and reload the page with the new specs."

   THE FLOW (this module, start to finish):
     1. TAP "Download newest UI" (Administrator panel, #adm-uiflow).
     2. The game AUTO-PAUSES through the pause system's public API
        (GamePause.setPaused) and every open menu CLOSES — the menus-yield
        rule: after a selection, the window that offered it gets out of
        the way of the thing selected.
     3. The published ui-manifest.json is fetched fresh and diffed
        against the manifest this page BOOTED with. ONLY the changed UI
        files download, one at a time, each verified against the
        manifest's sha256 before it counts. A small progress chip (MB,
        corner of the screen, never the centre, never touchable) narrates.
     4. As soon as the download is RUNNING, the game UNPAUSES (back to
        whatever pause state the player had at tap time) — Joshua plays
        around while the resources land in the background.
     5. When every changed file has landed and verified, the player's
        position is saved into a localStorage RESUME STASH (zone, x/z,
        heading, on-foot vs in-car + the car's spot) and the page RELOADS
        — it boots with the new UI specs (the deferred loader stamps
        every script with the live ui_version, so a reload genuinely
        parses the new files).
     6. On boot, __tryStartGame() calls maybeRestore() right after the
        hot-reload restore: a FRESH stash (< 10 minutes, same zone) puts
        the player — and the car — exactly where they left off, clears
        the stash, and toasts "UI updated — you're where you left off."

   FAILURE PHILOSOPHY (Joshua, 2026-10-17 — logged, plain language,
   never silent, never a half-apply):
     - Already on the newest UI → the chip says so. No download, no
       stash, no reload.
     - A download fails or a file fails its sha256 check → NO reload,
       the old UI keeps running untouched, the chip names the file and
       the reason, and the failure is filed through the report hook
       (Report.note + GitHubReports.queue, both guarded).
     - Offline → the same honest path ("no connection").
     - Version bumped but no file changed → the version is recorded
       (ASSETVER.noteApplied) and the chip says "already the newest";
       nothing reloads.

   WIRING — into the EXISTING machinery, no parallel updater:
     - Versions/pending state: ASSETVER (getActive / noteApplied). This
       module never keeps its own version table.
     - Diff baseline: the boot manifest hotreload.js already stashes
       (localStorage 'sa_ui_manifest_boot'); fallback: the page's own
       boot SRI table (window.__UIHASH + __UIVER), which is the same
       truth in another shape. No baseline at all → the flow applies by
       reload without a download gate and says so in the log.
     - Downloads: this module's own sequential pass, built to
       mapdelivery.js's discipline (fresh fetch, cache:'no-store',
       streaming read with a 20 s inactivity watchdog, sha256 verify
       before a file counts, first failure stops the batch — a partial
       update is never applied). On the APK the AssetDownload bridge is
       the downloader (the same per-file call ASSETVER.forceRedownload
       uses; the native side hash-verifies its downloads — the JS side
       has no read-back API for stored files, so per-file integrity on
       the APK is the bridge's 'OK:' verdict, exactly as the existing
       re-download flow trusts it).
     - Pause: GamePause's public API only (pause_system.js internals
       untouched). Menus: closed by removing 'show', the same class
       every panel uses. Restore: mirrors loadSlot()'s own placement
       code (same ground/surface reads, same locked-zone fallback).

   LOOP GUARD: maybeRestore() records the applied version
   ('sa_ui_update_applied'). If a later start() targets that same
   version — or the finish line is reached for a version already
   consumed — the flow reports "already the newest" instead of
   stashing and reloading a second time.

   STATE KEYS (localStorage):
     sa_ui_update_resume   JSON  the resume stash (consumed on boot)
     sa_ui_update_applied  JSON  {ver, t} of the last consumed stash

   Public API: window.UIUpdateFlow = { start, maybeRestore, diffManifests,
     writeStash, stashAndReload }  (the last two added 2026-10-17: the
     generic stash API the zone transition + post-unlock refresh reuse)
   ============================================================================ */
(function(){
'use strict';

/* Published source of truth — the same base ASSETVER / MAPVER /
   mapdelivery already use (one deployment feeds every copy). */
var BASE='https://kingmarkarnold-code.github.io/adamsville-play/detailed/';
var MANIFEST_NAME='ui-manifest.json';

var LS_BOOT='sa_ui_manifest_boot';      /* hotreload.js's boot stash (read-only here) */
var LS_STASH='sa_ui_update_resume';     /* this flow's resume stash */
var LS_APPLIED='sa_ui_update_applied';  /* {ver, t} — the loop guard */
var STALE_MS=10*60*1000;                /* a stash older than 10 min is not a resume */
var DOWNLOAD_IDLE_MS=20000;             /* progress-based watchdog (mapdelivery's rule) */

/* ---------- tiny localStorage helpers (house pattern) ---------- */
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }

function logLine(msg){
  try{ console.log('[UI-UPDATE] '+msg); }catch(e){}
  try{ if (window.HR && HR.log) HR.log('UI update flow: '+msg); }catch(e){}
}

/* Failure + event reporting through the game's report hook, when it is
   present (Joshua's failure philosophy: logged, never silent). Both
   channels are best-effort and guarded — reporting must never break
   the flow it reports on. */
function reportEvent(kind, data){
  try{ if (window.Report && Report.note) Report.note('ui-update', data||{event:kind}); }catch(e){}
}
function reportFailure(reason){
  try{ if (window.Report && Report.noteError) Report.noteError('ui-update','download failed', String(reason)); }catch(e){}
  try{
    if (window.GitHubReports && typeof GitHubReports.queue==='function')
      GitHubReports.queue('ui-update-failed', {reason:String(reason), at:new Date().toISOString()});
  }catch(e){}
}

/* ---------- the progress chip ----------
   One small pill, top-left corner, pointer-events:none — it narrates
   the flow without covering the viewport centre and can never be
   tapped, dragged, or mistaken for a control. Created on first use. */
var chipEl=null, chipTimer=null;
function chipElGet(){
  if (chipEl) return chipEl;
  try{
    var d=document.createElement('div');
    d.id='uiflow-chip';
    d.style.cssText='position:fixed;left:10px;top:10px;z-index:9990;'+
      'max-width:78vw;padding:8px 12px;border-radius:999px;'+
      'background:rgba(12,14,20,0.88);border:1px solid rgba(255,210,90,0.55);'+
      'color:#ffd75e;font:600 13px/1.35 Arial,sans-serif;'+
      'pointer-events:none;display:none;box-shadow:0 2px 10px rgba(0,0,0,0.45);';
    document.body.appendChild(d);
    chipEl=d;
  }catch(e){}
  return chipEl;
}
function chip(text, ttlMs){
  var el=chipElGet();
  if (!el) return;
  if (chipTimer){ clearTimeout(chipTimer); chipTimer=null; }
  if (text===null){ try{ el.style.display='none'; }catch(e){} return; }
  try{ el.textContent=text; el.style.display='block'; }catch(e){}
  if (ttlMs && ttlMs>0){
    chipTimer=setTimeout(function(){ chip(null); }, ttlMs);
  }
}
function mb(bytes){
  if (!isFinite(bytes) || bytes<0) bytes=0;
  return (bytes/1048576).toFixed(1);
}

/* ---------- menus yield ----------
   Close every open menu panel (the settings panel this button lives
   in first of all). Panels open/close via the 'show' class — the same
   ids pause_system.js watches. The re-download confirm dialog closes
   too, so nothing floats over the game while the flow runs. */
function closeMenus(){
  var ids=['settings','help','gameplay','fullmap','adm-confirm'];
  for (var i=0;i<ids.length;i++){
    try{
      var el=document.getElementById(ids[i]);
      if (el && el.classList) el.classList.remove('show');
    }catch(e){}
  }
}

/* ---------- pause (public API only) ---------- */
var wasPaused=false;      /* the pause state at tap time */
var pauseApplied=false;   /* true once THIS flow has paused the game */
function pauseGame(){
  try{
    if (window.GamePause){
      wasPaused=!!GamePause.isPaused();
      GamePause.setPaused(true);
      pauseApplied=true;
    }
  }catch(e){}
}
/* Hand the game back to the pause state the player had at tap time.
   If he was already paused by his own hand, he stays paused; the flow
   only undoes its OWN pause. setPaused() is idempotent, so calling
   this twice (download start + failure path) is safe. */
function restorePause(){
  try{
    if (pauseApplied && !wasPaused && window.GamePause) GamePause.setPaused(false);
  }catch(e){}
}

/* ---------- ASSETVER (the existing version machinery) ---------- */
function getActiveVer(){
  try{
    if (typeof ASSETVER!=='undefined' && ASSETVER.getActive){
      var v=ASSETVER.getActive('ui');
      if (v && v!=='unknown') return v;
    }
  }catch(e){}
  try{ if (window.__UIVER) return window.__UIVER; }catch(e){}
  return lsGet('sa_asset_version_ui');
}
function noteApplied(ver){
  try{
    if (typeof ASSETVER!=='undefined' && ASSETVER.noteApplied){ ASSETVER.noteApplied('ui', ver); return; }
  }catch(e){}
  try{ lsSet('sa_asset_version_ui', ver); }catch(e){}
}

/* ---------- manifest diff (pure — the harness drives this) ----------
   Same rule as hotreload's diff: a file counts as changed when the
   remote manifest's sha256 differs from the baseline's (or the file
   is new). Hash on either side only → changed. No hash anywhere →
   size decides; no size either → unchanged (never download on a
   guess). */
function entrySha(e){ return (e && (e.sha256 || e.hash)) || ''; }
function diffManifests(oldM, newM){
  var out=[];
  try{
    var of=(oldM&&oldM.files)||[], nf=(newM&&newM.files)||[];
    var o={}, i, k;
    for (i=0;i<of.length;i++) if (of[i] && of[i].name) o[of[i].name]=of[i];
    for (i=0;i<nf.length;i++){
      var rf=nf[i];
      if (!rf || !rf.name || rf.name.indexOf('..')!==-1) continue;
      var le=o[rf.name];
      if (!le){ out.push(rf); continue; }
      var rs=entrySha(rf), ls=entrySha(le);
      if (rs || ls){ if (rs!==ls) out.push(rf); }
      else if (typeof rf.size==='number' && typeof le.size==='number'){
        if (rf.size!==le.size) out.push(rf);
      }
    }
  }catch(e){}
  return out;
}

/* The diff baseline: the manifest this page BOOTED with. First
   hotreload.js's stash; then the boot SRI table (__UIHASH/__UIVER —
   the loader stamped every script from it, so it IS the boot truth);
   else null (the flow then applies by reload, and logs why). */
function readBaseline(){
  try{
    var raw=lsGet(LS_BOOT);
    if (raw){
      var m=JSON.parse(raw);
      if (m && m.files && m.files.length) return m;
    }
  }catch(e){}
  try{
    var hashes=window.__UIHASH;
    if (hashes && typeof hashes==='object'){
      var files=[];
      for (var name in hashes){ if (hashes[name]) files.push({name:name, sha256:hashes[name]}); }
      if (files.length) return {files:files, ui_version:window.__UIVER||''};
    }
  }catch(e){}
  return null;
}

/* ---------- the native bridge (APK), when present ---------- */
function assetBridge(){
  try{
    var b=window.AssetDownload||null;
    if (b && typeof b.downloadAssetFile==='function') return b;
  }catch(e){}
  return null;
}
function anyBridge(){
  try{ return window.AssetDownload||null; }catch(e){ return null; }
}

/* ---------- sha256 (SubtleCrypto; '' when unavailable — the diff
   discipline still applies, verification is skipped, as mapdelivery
   does on non-secure contexts) ---------- */
function sha256Hex(text){
  try{
    if (typeof crypto==='undefined' || !crypto.subtle || !crypto.subtle.digest)
      return Promise.resolve('');
    var bytes=new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', bytes).then(function(buf){
      var out='', view=new Uint8Array(buf);
      for (var i=0;i<view.length;i++) out+=('0'+view[i].toString(16)).slice(-2);
      return out;
    }).catch(function(){ return ''; });
  }catch(e){ return Promise.resolve(''); }
}

/* ---------- streaming body read with an inactivity watchdog
   (mapdelivery's pattern: a download dies only after DOWNLOAD_IDLE_MS
   with NO bytes arriving — a slow-but-alive download always finishes).
   Falls back to r.text() where streaming reads don't exist. ---------- */
function readBodyText(r, onProgress){
  if (!r || typeof r.text!=='function' || !r.body || typeof r.body.getReader!=='function' || typeof TextDecoder==='undefined'){
    return r.text();
  }
  var total=0;
  try{
    var cl=r.headers && typeof r.headers.get==='function' ? parseInt(r.headers.get('content-length')||'0', 10) : 0;
    if (cl>0) total=cl;
  }catch(e){}
  var reader=r.body.getReader();
  var decoder=new TextDecoder('utf-8');
  return new Promise(function(resolve, reject){
    var text='', received=0, finished=false, idleTimer=null;
    function armIdle(){
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer=setTimeout(function(){
        if (finished) return; finished=true;
        try{ reader.cancel(); }catch(e){}
        reject(new Error('download stalled - no data for '+Math.round(DOWNLOAD_IDLE_MS/1000)+'s'));
      }, DOWNLOAD_IDLE_MS);
    }
    function step(){
      reader.read().then(function(res){
        if (finished) return;
        if (res.done){
          finished=true;
          if (idleTimer) clearTimeout(idleTimer);
          text+=decoder.decode();
          resolve(text);
          return;
        }
        received+=(res.value && res.value.length) || 0;
        text+=decoder.decode(res.value, {stream:true});
        if (onProgress){ try{ onProgress(received, total); }catch(e){} }
        armIdle();
        step();
      }, function(err){
        if (finished) return; finished=true;
        if (idleTimer) clearTimeout(idleTimer);
        reject(err);
      });
    }
    armIdle();
    step();
  });
}

/* ---------- the published manifest, fetched fresh ----------
   Watcher/ASSETVER pattern: cache:'no-store' + a cache-busting query,
   so no CDN edge can serve a stale stamp. On the APK the bridge's
   fetchText is preferred (it already sends no-cache natively);
   a WebView fetch is the fallback there, as in Test Connection. */
function fetchRemoteManifest(){
  var b=anyBridge();
  if (b && typeof b.fetchText==='function'){
    return Promise.resolve().then(function(){
      var raw=b.fetchText(BASE+MANIFEST_NAME);
      if (!raw) throw new Error('no connection — could not reach the update server');
      return JSON.parse(raw);
    });
  }
  if (typeof fetch!=='function')
    return Promise.reject(new Error('no connection — could not reach the update server'));
  return fetch(BASE+MANIFEST_NAME+'?cb='+Date.now(), {cache:'no-store'}).then(function(r){
    if (!r || !r.ok) throw new Error('the update server answered HTTP '+(r && r.status));
    return r.json();
  }, function(){
    throw new Error('no connection — could not reach the update server');
  });
}

/* ---------- one changed file ----------
   WEB: fetch the bytes, stream them in (progress), then verify the
   sha256 against the remote manifest BEFORE the file counts. The
   verified bytes are what the reload will parse from the deployment
   (every script is stamped ?v=<ui_version> + SRI at boot), so proving
   the published bytes match the manifest here is the integrity gate
   for the reload itself.
   APK: the bridge downloads the file into the app's asset store (the
   same call ASSETVER.forceRedownload uses, one file at a time); its
   'OK:' verdict is the per-file result, as in the existing flow. */
function downloadOne(entry, onProgress){
  var bridge=assetBridge();
  if (bridge){
    return new Promise(function(resolve, reject){
      setTimeout(function(){
        try{
          var r=bridge.downloadAssetFile('ui', BASE+entry.name, entry.name)||'';
          if (r.indexOf('OK:')!==0)
            reject(new Error(entry.name+' — the app downloader said: '+(r||'no answer')));
          else resolve(entry.size||0);
        }catch(e){
          reject(new Error(entry.name+' — the app downloader failed'));
        }
      }, 30);
    });
  }
  if (anyBridge()){
    /* A bridge exists but cannot download asset files (very old APK):
       say so honestly instead of pretending a web fetch could apply. */
    return Promise.reject(new Error('this app build cannot download UI updates in place — restart the app to update'));
  }
  if (typeof fetch!=='function')
    return Promise.reject(new Error(entry.name+' — no connection'));
  var url=BASE+entry.name+'?cb='+Date.now();
  return fetch(url, {cache:'no-store'}).then(function(r){
    if (!r || !r.ok) throw new Error(entry.name+' — the server answered HTTP '+(r && r.status));
    return readBodyText(r, onProgress);
  }, function(){
    throw new Error(entry.name+' — no connection');
  }).then(function(text){
    return sha256Hex(text).then(function(h){
      var want=entrySha(entry);
      if (want && h && h!==want)
        throw new Error(entry.name+' failed its integrity check');
      if (want && !h)
        logLine(entry.name+': no SHA tool in this browser — accepted unverified.');
      return text.length;
    });
  });
}

/* ---------- the resume stash ----------
   snapshot(): the player's spot, in the same field shapes loadSlot()
   reads/writes (player x/z/yaw + state flags, the current car, the
   camera heading), plus the zone and a timestamp. y is NOT stored —
   the ground is re-derived at restore, exactly as loadSlot does, so a
   stash can never float or bury the player. Returns null when there
   is no player yet (menu before start): the reload then just boots
   fresh, which is the honest outcome. */
function snapshot(targetVer, opts){
  opts=opts||{};
  try{
    if (typeof player==='undefined' || !player) return null;
    var zone=null;
    try{ if (typeof ZONELOADER!=='undefined' && ZONELOADER.currentZone) zone=ZONELOADER.currentZone; }catch(e){}
    /* opts.zone (2026-10-17): a caller reloading INTO a different page
       (zoneloader's zone transition) tags the stash with the TARGET
       zone — maybeRestore's zone-match check runs against the NEW
       page's current zone, so a current-zone tag would be judged
       foreign and discarded there. */
    if (opts.zone) zone=opts.zone;
    var driving=false, carSnap=null, carIdx=-1;
    try{
      if (typeof car!=='undefined' && car){
        driving=!!car.driving;
        carSnap={ x:+car.x.toFixed(2), z:+car.z.toFixed(2), yaw:+((car.yaw||0)).toFixed(3) };
        try{ if (typeof cars!=='undefined' && cars) carIdx=cars.indexOf(car); }catch(e){}
      }
    }catch(e){}
    return {
      kind:'ui-update', v:1, t:Date.now(), forVer:targetVer||'', zone:zone,
      player:{ x:+player.x.toFixed(2), z:+player.z.toFixed(2), yaw:+((player.yaw||0)).toFixed(3),
               inside:!!player.inside, swimming:!!player.swimming, locIdx:(player.locIdx|0) },
      driving:driving, carIdx:carIdx, car:carSnap,
      camYaw:(typeof camYaw!=='undefined') ? +camYaw.toFixed(3) : null,
      lookYawOff:(typeof look!=='undefined' && look) ? +((look.yawOff||0)).toFixed(3) : 0,
      /* opts.toast (2026-10-17): a caller-supplied restore message
         (zone transitions, the post-unlock refresh). maybeRestore
         shows it INSTEAD of the UI-update wording when present. */
      toast:(opts.toast && typeof opts.toast==='string') ? opts.toast : ''
    };
  }catch(e){ return null; }
}

/* applyStash(): put the player (and car) back — loadSlot()'s own
   placement sequence, narrowed to the fields the stash carries:
   ground-derived Y, the material surface read for the car, the
   locked-zone relocation fallback, camera reframe behind the player. */
function applyStash(s){
  if (typeof player==='undefined' || !player || !s.player) return false;
  var p={ x:s.player.x, z:s.player.z, yaw:s.player.yaw||0,
          inside:!!s.player.inside, swimming:!!s.player.swimming, locIdx:(s.player.locIdx|0) };
  var carSnap=s.car ? { x:s.car.x, z:s.car.z, yaw:s.car.yaw||0 } : null;
  var driving=!!s.driving;
  /* Locked-zone fallback (loadSlot's STEP2 rule): unlocks live in
     localStorage only, so a stash could point into a zone locked in
     this profile. Never soft-lock the player inside the union walls —
     relocate to the 535 spawn, park the car in its driveway. */
  try{
    if (typeof ZONEUNLOCK!=='undefined' && ZONEUNLOCK.isPlayable && !ZONEUNLOCK.isPlayable(p.x, p.z)){
      p.x=HOME.x-14; p.z=HOME.z+8; p.yaw=Math.PI/2;
      p.inside=false; p.swimming=false; p.locIdx=-1;
      if (carSnap && typeof heroHouse!=='undefined' && heroHouse.drivewayPark){
        carSnap.x=heroHouse.drivewayPark.x; carSnap.z=heroHouse.drivewayPark.z; carSnap.yaw=0;
      }
      driving=false;
      try{ if (typeof showToast==='function') showToast('That spot is in a locked zone — started you at 535 Dollar Mill Rd.', 3600); }catch(e){}
    }
  }catch(e){}
  /* Player — stop current driving first (loadSlot does the same). */
  try{ if (typeof car!=='undefined' && car && car.driving){ car.driving=false; car.speed=0; } }catch(e){}
  player.x=p.x; player.z=p.z; player.yaw=p.yaw;
  player.inside=p.inside; player.swimming=p.swimming; player.speed=0;
  player.locIdx=p.locIdx||-1;
  try{
    player.locFloorY=(player.locIdx>=0 && typeof ENTERABLES!=='undefined' && ENTERABLES[player.locIdx]) ? ENTERABLES[player.locIdx].floorY : 0;
    if (player.locIdx>=0 && typeof ENTERABLES!=='undefined' && ENTERABLES[player.locIdx])
      ENTERABLES[player.locIdx].roofs.forEach(function(r){ r.visible=false; });
  }catch(e){}
  try{
    if (player.mesh){
      player.mesh.visible=true;
      player.mesh.position.set(player.x, groundRefY(player.x, player.z), player.z);
      player.mesh.rotation.y=player.yaw;
    }
  }catch(e){}
  /* Car — the same car the stash names (by index, like loadSlot),
     seated on the surface that is actually there. */
  var c=null;
  try{
    if (typeof cars!=='undefined' && cars && cars.length){
      c=(typeof s.carIdx==='number' && s.carIdx>=0 && cars[s.carIdx]) ? cars[s.carIdx] : ((typeof car!=='undefined' && car) || cars[0]);
    }
  }catch(e){}
  if (c && carSnap){
    try{
      c.x=carSnap.x; c.z=carSnap.z; c.yaw=carSnap.yaw; c.speed=0; c.sinking=false;
      var ly=0;
      try{
        var ls=(typeof surfaceYAt==='function') ? surfaceYAt(c.x, c.z) : null;
        ly=(ls===null || ls===undefined) ? groundRefY(c.x, c.z) : ls;
      }catch(e){ try{ ly=heightAt(c.x, c.z); }catch(e2){} }
      var atHome=false;
      try{
        if (typeof heroHouse!=='undefined' && heroHouse.drivewayPark)
          atHome=Math.hypot(c.x-heroHouse.drivewayPark.x, c.z-heroHouse.drivewayPark.z)<2;
      }catch(e){}
      if (c.mesh){ c.mesh.position.set(c.x, ly+(atHome?0.32:0), c.z); c.mesh.rotation.y=c.yaw; }
      try{ car=c; }catch(e){}
    }catch(e){}
  }
  /* Driving state + camera (loadSlot's tail). */
  try{
    if (typeof setDrivingUI==='function'){
      if (driving && c){ c.driving=true; setDrivingUI(true); }
      else setDrivingUI(false);
    } else if (driving && c){ c.driving=true; }
  }catch(e){}
  try{
    camYaw=(s.camYaw!==null && s.camYaw!==undefined) ? s.camYaw : p.yaw;
    if (typeof look!=='undefined' && look) look.yawOff=s.lookYawOff||0;
    if (typeof camera!=='undefined' && camera){
      var cb=camYaw+Math.PI, gy=heightAt(player.x, player.z);
      camera.position.set(player.x+Math.sin(cb)*4.6, gy+3.0, player.z+Math.cos(cb)*4.6);
      camera.lookAt(player.x, gy+1.4, player.z);
    }
  }catch(e){}
  return true;
}

/* maybeRestore() — called from __tryStartGame() right after
   HR.maybeRestore(). A stash is consumed (deleted) the moment it is
   judged ours, BEFORE applying, so a failed apply can never loop.
   Stale, foreign, or other-zone stashes are discarded silently. */
function maybeRestore(){
  var raw=lsGet(LS_STASH);
  if (!raw) return false;
  var s=null;
  try{ s=JSON.parse(raw); }catch(e){}
  if (!s || s.kind!=='ui-update' || typeof s.t!=='number' || !s.player ||
      (Date.now()-s.t)>STALE_MS){
    /* A discarded TRIP stash (it carries a caller toast — Go To jumps,
       zone crossings, unlock refreshes) must never vanish silently
       (2026-10-18: a stale Go To stash read to Joshua as "dumped at
       the launch options with no word"). Say so in plain words. */
    var tripNote=(s && typeof s.toast==='string' && s.toast) ? s.toast : '';
    lsDel(LS_STASH);
    if (tripNote){
      logLine('Resume stash too old to use — trip set aside, started fresh.');
      try{ if (typeof showToast==='function') showToast('That trip took too long to load, so it was set aside — you started at the home spawn. Your place is still in Go to.', 5200); }catch(e){}
    }
    return false;
  }
  var curZone=null;
  try{ if (typeof ZONELOADER!=='undefined') curZone=ZONELOADER.currentZone; }catch(e){}
  if (s.zone && curZone && s.zone!==curZone){
    var tripNote2=(typeof s.toast==='string' && s.toast) ? s.toast : '';
    lsDel(LS_STASH);   /* other-context stash — discard, but a trip says why */
    if (tripNote2){
      logLine('Resume stash was for zone '+(s.zone||'?')+', this page booted '+(curZone||'?')+' — trip set aside.');
      try{ if (typeof showToast==='function') showToast('A saved trip to another zone was set aside — you started at the home spawn.', 5200); }catch(e){}
    }
    return false;
  }
  lsDel(LS_STASH);     /* consume first: no restore loops, ever */
  try{ lsSet(LS_APPLIED, JSON.stringify({ver:s.forVer||'', t:Date.now()})); }catch(e){}
  var ok=false;
  try{ ok=applyStash(s); }catch(e){ ok=false; }
  if (ok){
    try{
      if (typeof showToast==='function')
        showToast(s.toast ? s.toast : 'UI updated \u2014 you\u2019re where you left off.', 3200);
    }catch(e){}
    reportEvent('restored', {event:'ui-update-restored', ver:s.forVer||''});
    logLine('Resume stash applied — player restored to ('+Math.round(s.player.x)+', '+Math.round(s.player.z)+').');
  }else{
    logLine('Resume stash found but could not be applied — started fresh.');
  }
  return ok;
}

function readApplied(){
  try{
    var raw=lsGet(LS_APPLIED);
    if (!raw) return null;
    var a=JSON.parse(raw);
    return (a && typeof a==='object') ? a : null;
  }catch(e){ return null; }
}

/* ---------- generic resume-stash API (2026-10-17) ----------
   writeStash(opts): snapshot the player's exact spot into the SAME
   resume stash this module's own reload path uses, WITHOUT
   reloading. opts: {zone (tag: the zone the NEXT page boots into),
   toast (shown by maybeRestore after the restore)}. Returns true
   when a stash was written. Callers: zoneloader.transitionTo (the
   reload is zoneloader's own — it changes ?zone= in the URL, which a
   plain reload() cannot do).
   stashAndReload(opts): writeStash + reload THIS page a moment
   later. Returns true when it took over — the caller should stand
   down (no resume, no further UI). Returns false when no stash
   could be written (no live player): the caller falls back to its
   no-reload behaviour. Caller: zoneunlockflow's finish (Joshua's
   ruling — a successful unlock refreshes the page so the world can
   change around an unmoved player). */
function writeStash(opts){
  opts=opts||{};
  var s=snapshot('', opts);
  if (!s) return false;
  try{
    lsSet(LS_STASH, JSON.stringify(s));
    logLine('Resume stash written for '+(opts.zone ? ('zone '+opts.zone) : 'this page')+'.');
    return true;
  }catch(e){ return false; }
}
function stashAndReload(opts){
  opts=opts||{};
  if (!writeStash(opts)) return false;
  setTimeout(function(){
    try{ window.location.reload(); }catch(e){}
  }, (typeof opts.delayMs==='number' && opts.delayMs>=0) ? opts.delayMs : 600);
  return true;
}

/* ---------- the flow ---------- */
var running=false;

function finishCurrent(ver){
  running=false;
  restorePause();
  chip('UI is already the newest (v'+ver+').', 3500);
  logLine('UI already current (v'+ver+') — no download, no reload.');
}
function fail(reason){
  running=false;
  restorePause();   /* if the failure hit before the unpause, hand control back */
  chip('UI update failed \u2014 '+reason+'. Your current UI keeps running.', 6000);
  logLine('FAILED: '+reason+' — old UI untouched, no reload.');
  reportEvent('failed', {event:'ui-update-failed', reason:String(reason)});
  reportFailure(reason);
}
function finishSuccess(ver, downloadedNames){
  /* Loop guard, second gate (the spec's exact case): a version whose
     stash was already consumed must never be stashed/reloaded again. */
  var applied=readApplied();
  if (applied && applied.ver && applied.ver===ver){ finishCurrent(ver); return; }
  noteApplied(ver);
  /* APK bookkeeping: mirror forceRedownload's native record so the
     bridge's own version table agrees with ASSETVER's. */
  try{
    var b=assetBridge();
    if (b){
      if (typeof b.markAssetsComplete==='function') b.markAssetsComplete(ver, '', '');
      if (typeof b.clearPendingAssetUpdate==='function') b.clearPendingAssetUpdate('ui');
    }
  }catch(e){}
  var stash=snapshot(ver);
  if (stash){
    lsSet(LS_STASH, JSON.stringify(stash));
    logLine('Spot stashed ('+(stash.zone||'?')+' @ '+Math.round(stash.player.x)+', '+Math.round(stash.player.z)+
            (stash.driving?', in car':'')+') — reloading with the new UI.');
  }else{
    logLine('No live player state to stash — reloading to a fresh spawn with the new UI.');
  }
  chip('UI updated \u2014 reloading\u2026', 0);
  reportEvent('applied', {event:'ui-update-applied', ver:ver, files:downloadedNames.length});
  running=false;
  setTimeout(function(){ try{ location.reload(); }catch(e){} }, 800);
}

function beginDownload(remote, ver, changed){
  var totalBytes=0, i;
  for (i=0;i<changed.length;i++) totalBytes+=(typeof changed[i].size==='number' ? changed[i].size : 0);
  var doneBytes=0;
  function paintProgress(){
    if (totalBytes>0) chip('Downloading UI update \u2014 '+mb(doneBytes)+' / '+mb(totalBytes)+' MB', 0);
    else chip('Downloading UI update \u2014 '+mb(doneBytes)+' MB so far', 0);
  }
  paintProgress();
  /* The FIRST changed file starts NOW, synchronously, so the order on
     the wire is exactly Joshua's: pause → menu closed → download
     running → unpause. The rest chain behind it, one at a time (a
     phone on a slow link is never flooded, and the first failure stops
     the batch with the old UI untouched). */
  var chain=null;
  for (i=0;i<changed.length;i++){
    (function(entry, isFirst){
      var step=function(){
        var cur=0;
        return downloadOne(entry, function(received){
          cur=received;
          if (totalBytes>0) chip('Downloading UI update \u2014 '+mb(doneBytes+cur)+' / '+mb(totalBytes)+' MB', 0);
        }).then(function(n){
          doneBytes+=(typeof n==='number' ? n : (entry.size||0));
          paintProgress();
        });
      };
      chain = isFirst ? step() : chain.then(step);
    })(changed[i], i===0);
  }
  /* The download is running — hand the game back (spec step 2). The
     player plays around while the rest lands in the background. */
  restorePause();
  chain.then(function(){
    finishSuccess(ver, changed.map(function(e){ return e.name; }));
  }).catch(function(err){
    fail(String((err && err.message) || err));
  });
}

function runCheck(){
  fetchRemoteManifest().then(function(remote){
    var ver=(remote && (remote.ui_version || remote.version)) || '';
    if (!ver){ fail('the update list carried no version \u2014 nothing was changed'); return; }
    var activeVer=getActiveVer();
    var applied=readApplied();
    if ((activeVer && ver===activeVer) || (applied && applied.ver===ver)){
      finishCurrent(ver);
      return;
    }
    var base=readBaseline();
    var changed=base ? diffManifests(base, remote) : null;
    if (changed && changed.length===0){
      /* Version stamp moved but no file did — record it and stop
         (hotreload's rule for the same case). */
      noteApplied(ver);
      finishCurrent(ver);
      return;
    }
    if (!changed){
      logLine('No boot baseline to diff against \u2014 applying v'+ver+' by reload (the boot re-reads the manifest + SRI table).');
      finishSuccess(ver, []);
      return;
    }
    logLine('UI v'+(activeVer||'?')+' \u2192 v'+ver+': '+changed.length+' changed file(s) to download.');
    beginDownload(remote, ver, changed);
  }).catch(function(err){
    fail(String((err && err.message) || err));
  });
}

/* start() — the button. Joshua's order, literally:
   pause → menus close → check + download → (download running) unpause
   → verified → stash → reload. */
function start(){
  if (running){ chip('A UI update is already in progress\u2026', 2500); return; }
  running=true;
  wasPaused=false; pauseApplied=false;
  pauseGame();
  closeMenus();
  chip('Checking for the newest UI\u2026', 0);
  /* A breath so the pause and the closed menu paint before any work —
     the bridge's manifest read is synchronous on the APK. */
  setTimeout(runCheck, 60);
}

/* ---------- admin wiring ---------- */
function wireButton(){
  try{
    var b=document.getElementById('adm-uiflow');
    if (b && !b.__uiflowWired){
      b.__uiflowWired=true;
      b.addEventListener('click', function(){ start(); });
    }
  }catch(e){}
}
if (typeof document!=='undefined'){
  if (document.readyState==='complete' || document.readyState==='interactive') setTimeout(wireButton, 1500);
  else if (document.addEventListener) document.addEventListener('DOMContentLoaded', function(){ setTimeout(wireButton, 1500); });
}

/* Public API — start is the button (and any future caller);
   maybeRestore is __tryStartGame's boot hook; diffManifests is the
   pure core the harness drives; writeStash/stashAndReload are the
   generic stash API zoneloader + zoneunlockflow reuse (2026-10-17). */
window.UIUpdateFlow={
  start:start,
  maybeRestore:maybeRestore,
  diffManifests:diffManifests,
  writeStash:writeStash,
  stashAndReload:stashAndReload
};

/* Self-report so Joshua can verify the module loaded (Report panel). */
try{
  if (typeof Report!=='undefined' && Report.setSys){
    Report.setSys('ui-update', {status:'ok', version:'1.0',
      note:'Menu "Download newest UI": pause, close menu, verified background download, stash spot, reload, restore (Joshua 2026-10-17)'});
  }
}catch(e){}

})();
