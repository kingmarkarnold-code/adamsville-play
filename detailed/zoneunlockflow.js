/* ============================================================================
   FILE: zoneunlockflow.js — ZONE UNLOCK DOWNLOAD CEREMONY
   ----------------------------------------------------------------------------
   JOSHUA'S SPEC (2026-10-17, from live play): he unlocked South Fulton
   with its code; the wall came down and he could drive in, but nothing
   downloaded and the zone was naked space. What SHOULD happen on a
   successful unlock:

     1. The game PAUSES (via pause_system.js — window.GamePause).
     2. A DOWNLOAD PROGRESS BAR shows, with MB figures (the game's
        standing progress style, same format as __zoneFileProgress).
     3. That zone's data DOWNLOADS — the same dataset the loader
        fetches for the home zone at startup (zoneloader.js's list:
        zone / roads / signs / lifts / pins / buildings /
        hero_buildings), through the mapdelivery path: the local map
        store is consulted FIRST (serveText), fetched bytes are
        sha256-verified against the map manifest where it covers the
        file, and stored back through MapDelivery.remember() so the
        eventual zone transition serves them locally.
     4. The MINIMAP UPDATES to include the newly unlocked zone: the
        downloaded roads join window.__mmExtraRoads, which
        drawMinimap / drawFullMap (index.html) draw alongside the
        current zone's roadDrawData; the locked-zone dark overlay
        lifts by itself once the unlock commits (zoneunlock.js's
        drawZoneOverlay skips unlocked zones).
     5. Only THEN does the unlock COMMIT (ZoneUnlock.commitUnlock,
        handed in by zoneunlock.js) and play resumes — on the
        player's Continue tap, never automatically.

   UNLOCK ALL runs the same ceremony sequentially, one zone at a
   time, committing each zone as its own data lands.

   FAILURE LAW (Joshua's philosophy — nothing silent, nothing
   fake-unlocked): if a zone's download fails, that zone STAYS
   LOCKED, the overlay says what failed and offers Retry (resume the
   sequence at the failed zone) or Cancel (keep whatever committed,
   return to the game). The failure is filed to the crash log
   (CrashLog.error) at the moment it happens. A zone NEVER opens
   onto naked space.

   ALREADY-LOCAL: when every file is already in the local store
   (browser map cache, or the APK bundle / active map dir served by
   the native interceptor), the bar completes near-instantly and the
   overlay says "already on device" — the ceremony still shows, so
   the player sees the unlock register.

   UNLOCK STATE stays localStorage-only and passwords stay inside
   zoneunlock.js — this module never sees a password; zoneunlock.js
   hands it zone ids + a commit callback after the password checks
   out (see ZoneUnlock.setUnlockFlow).

   STANDALONE MODULE. Loaded deferred right after zoneunlock.js.
   Every external access (ZoneUnlock, GamePause, MapDelivery,
   CrashLog, the DOM) is guarded — if this file is missing,
   zoneunlock.js falls back to its original immediate unlock.
   ============================================================================ */
(function(){
'use strict';

/* ---------------- constants ----------------
   PUBLISHED_BASE mirrors mapdelivery.js: the play copy's GitHub
   Pages deployment is the source of truth for downloads. */
var PUBLISHED_BASE='https://kingmarkarnold-code.github.io/adamsville-play/detailed/';

/* A download is abandoned only after this long with NO bytes
   arriving — the same progress-based watchdog discipline the zone
   loader and mapdelivery use (20s of silence, never a flat cap:
   slow links must be allowed to finish). */
var IDLE_MS=20000;

/* Friendly file names in the game's own loader vocabulary
   (__criticalLoadKeys in index.html uses the same words). */
var FILE_LABELS={
  zone:'Zone info', roads:'Road data', signs:'Exit signs',
  lifts:'Terrain lifts', pins:'Junction pins', buildings:'Buildings',
  hero_buildings:'Hero buildings'
};
function fileLabel(key){
  try{
    if (window.__criticalLoadKeys && window.__criticalLoadKeys[key])
      return window.__criticalLoadKeys[key];
  }catch(e){}
  return FILE_LABELS[key] || key;
}
function mb(bytes){ return (bytes/1048576).toFixed(1)+' MB'; }

/* ---------------- the zone dataset ----------------
   The exact file list zoneloader.js injects for a zone (its
   injectZoneScripts): metadata, roads, signs, lifts (the zone's
   heights), pins, buildings, hero buildings. Paths are manifest
   names — the same keys MapDelivery's store and map-manifest.json
   use. hero_buildings.json exists only for Adamsville today, and
   zone.json is metadata the game treats as optional, so both are
   optional here too: a 404 on either never fails a zone. */
function zoneFiles(zoneId){
  var base='zones/'+zoneId+'/';
  return [
    {src:base+'zone.json',           key:'zone',           optional:true},
    {src:base+'roads.json',          key:'roads',          optional:false},
    {src:base+'signs.json',          key:'signs',          optional:false},
    {src:base+'lifts.json',          key:'lifts',          optional:false},
    {src:base+'pins.json',           key:'pins',           optional:false},
    {src:base+'buildings.json',      key:'buildings',      optional:false},
    {src:base+'hero_buildings.json', key:'hero_buildings', optional:true}
  ];
}

/* ---------------- small guarded helpers ---------------- */
function el(id){ try{ return document.getElementById(id); }catch(e){ return null; } }
function zoneName(id){
  try{
    if (window.ZoneUnlock && ZoneUnlock.zoneById){
      var zn=ZoneUnlock.zoneById(id);
      if (zn && zn.name) return zn.name;
    }
  }catch(e){}
  return id;
}
function bridgeMode(){
  // APK: the native MapDownload bridge exists; the WebView
  // interceptor serves bundle / active-map-dir bytes for relative
  // URLs, so a relative fetch IS an on-device read there.
  try{ return !!(window.MapDownload && typeof window.MapDownload.downloadFile==='function'); }
  catch(e){ return false; }
}
function logFailure(zoneId, err, fileKey){
  // Joshua's failure philosophy: write it down at the moment it
  // happens — the crash log is the game's one growing record.
  var msg=(err && err.message) ? err.message : String(err);
  try{
    if (window.CrashLog && CrashLog.error)
      CrashLog.error('zone-unlock-download',
        'Zone download failed: '+zoneName(zoneId)+' ('+fileLabel(fileKey||'')+')', err,
        'zoneunlockflow.js downloadZone');
  }catch(e){}
  try{
    if (window.Report && Report.note)
      Report.note('zoneunlock', {zone:zoneId, file:fileKey||'', error:msg});
  }catch(e){}
  try{ console.warn('[zoneunlockflow] '+zoneId+' download failed: '+msg); }catch(e){}
}

/* sha256 hex via SubtleCrypto when available (same discipline as
   mapdelivery.js): resolves '' when unavailable, and callers treat
   '' as "cannot verify — proceed" rather than as a mismatch. */
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

/* The map manifest ON RECORD (MapDelivery's stored record of the
   last applied published manifest): the reference for each file's
   expected size + sha256. Null when no record exists yet. */
var _manifestCache=null, _manifestCacheAt=0;
function manifestEntry(name){
  try{
    var now=Date.now();
    if (!_manifestCache || now-_manifestCacheAt>30000){
      _manifestCache=(window.MapDelivery && MapDelivery.readStoredManifest)
        ? MapDelivery.readStoredManifest() : null;
      _manifestCacheAt=now;
    }
    if (_manifestCache && _manifestCache.files){
      for (var i=0;i<_manifestCache.files.length;i++){
        var f=_manifestCache.files[i];
        if (f && f.name===name) return f;
      }
    }
  }catch(e){}
  return null;
}

/* Streaming text fetch with the progress watchdog (mirrors
   mapdelivery.js's readBodyText): reports (received, total) as
   bytes arrive, rejects only after IDLE_MS of silence, and rejects
   HTTP errors with err.status set so callers can spot a 404.
   Falls back to r.text() where stream reads are unavailable. */
function fetchText(url, onProgress){
  return fetch(url).then(function(r){
    if (!r || !r.ok){
      var err=new Error('HTTP '+((r && r.status) || '?')+' for '+url);
      err.status=(r && r.status) || 0;
      throw err;
    }
    if (!r.body || typeof r.body.getReader!=='function' || typeof TextDecoder==='undefined'){
      return r.text().then(function(t){
        if (onProgress){ try{ onProgress(t.length, t.length); }catch(e){} }
        return t;
      });
    }
    var total=0;
    try{
      var cl=r.headers && typeof r.headers.get==='function'
        ? parseInt(r.headers.get('content-length')||'0', 10) : 0;
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
          reject(new Error('download stalled — no data for '+Math.round(IDLE_MS/1000)+'s'));
        }, IDLE_MS);
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
  });
}

/* Verify fetched bytes against the manifest on record (when it
   covers the file and a sha function exists). Throws on mismatch —
   corrupt bytes must never count as a downloaded zone. */
function verifyBytes(name, text){
  var entry=manifestEntry(name);
  var want=(entry && (entry.sha256 || entry.hash)) || '';
  if (!want) return Promise.resolve();
  return sha256Hex(text).then(function(hex){
    if (hex && hex!==want) throw new Error('integrity check failed for '+name);
  });
}

/* Warm the local map store with freshly fetched bytes so the
   eventual zone transition serves them locally (best effort —
   MapDelivery.remember applies its own integrity discipline). */
function rememberLocal(name, text){
  try{
    if (window.MapDelivery && MapDelivery.remember) MapDelivery.remember(name, text);
  }catch(e){}
}

/* ---------------- one file of the zone dataset ----------------
   Resolution order per file (the mapdelivery discipline):
     1. The local map store (MapDelivery.serveText) — already local.
     2. A relative fetch — in the APK this reads the bundle/active
        map dir through the native interceptor (already on device);
        in a browser it reads this deployment's own copy.
     3. APK only, when (2) failed: the native bridge downloads the
        published file into the active map dir, then (2) reads it.
     4. The published URL (mapdelivery's source of truth), stored
        back through remember() for later local serving.
   Fetched bytes are JSON-parsed (garbage must not count) and
   sha-verified where the manifest covers the file. Resolves
   {text, data, fromLocal} or {skipped:true} (optional file, 404
   everywhere); rejects with the last error otherwise. */
function downloadZoneFile(zf, onProgress){
  var name=zf.src;
  function parseChecked(text){
    var data=JSON.parse(text);  // throws on garbage — caller treats as failure
    return data;
  }
  // 1) local map store first
  var served=null;
  try{
    if (window.MapDelivery && MapDelivery.serveText) served=MapDelivery.serveText(name);
  }catch(e){}
  var chain=Promise.resolve(null);
  if (served && typeof served.then==='function'){
    chain=served.then(function(text){
      if (text==null) return null;
      // Unusable cached bytes (corrupt/truncated) must not fail the
      // zone: fall through to a fresh fetch, the loader's discipline.
      try{ return {text:text, data:parseChecked(text), fromLocal:true}; }
      catch(e){ return null; }
    }, function(){ return null; });
  }
  return chain.then(function(hit){
    if (hit) return hit;
    // 2) relative fetch (loader-style cache-bust with the map version)
    var mver='';
    try{ mver=window.__MAPVER || ''; }catch(e){}
    var relUrl=name+(name.indexOf('?')===-1?'?':'&')+'v='+encodeURIComponent(mver);
    return fetchText(relUrl, onProgress).then(function(text){
      return verifyBytes(name, text).then(function(){
        rememberLocal(name, text);
        return {text:text, data:parseChecked(text), fromLocal:bridgeMode()};
      });
    }).catch(function(relErr){
      // 3) APK bridge: pull the published file into the active map
      //    dir natively, then read it back through the interceptor.
      if (bridgeMode()){
        var dl='';
        try{ dl=window.MapDownload.downloadFile(PUBLISHED_BASE+name, name) || ''; }catch(e){}
        if (dl.indexOf('OK:')===0){
          return fetchText(relUrl, onProgress).then(function(text2){
            return {text:text2, data:parseChecked(text2), fromLocal:false};
          });
        }
      }
      // 4) published URL, fresh (watcher pattern: no-store + bust)
      var pubUrl=PUBLISHED_BASE+name+'?cb='+Date.now();
      return fetch(pubUrl, {cache:'no-store'}).then(function(r){
        if (!r || !r.ok){
          var err=new Error('HTTP '+((r && r.status) || '?')+' for '+name);
          err.status=(r && r.status) || 0;
          throw err;
        }
        return r.text();
      }).then(function(text){
        return verifyBytes(name, text).then(function(){
          rememberLocal(name, text);
          return {text:text, data:parseChecked(text), fromLocal:false};
        });
      }).catch(function(pubErr){
        // Optional files may simply not exist (a 404 on every path):
        // that is a skip, never a failed zone.
        if (zf.optional && ((pubErr && pubErr.status===404) || (relErr && relErr.status===404)))
          return {skipped:true};
        throw pubErr || relErr;
      });
    });
  });
}

/* ---------------- one whole zone ----------------
   Sequential files (the game's download discipline: one at a time,
   so a slow phone link is never flooded). hooks.onProgress gets
   {zoneId, fileKey, received, total} with received/total across the
   WHOLE zone dataset, in bytes — the overlay's bar math. Resolves
   {ok:true, alreadyLocal, bytes, roads} or
   {ok:false, error, fileKey} (never rejects). */
function downloadZone(zoneId, hooks){
  hooks=hooks || {};
  var files=zoneFiles(zoneId);
  var totalBytes=0, i;
  for (i=0;i<files.length;i++){
    var e=manifestEntry(files[i].src);
    if (e && typeof e.size==='number') totalBytes+=e.size;
  }
  var doneBytes=0, allLocal=true, roadsData=null;
  function report(fileKey, fileReceived, fileTotal, fileDone){
    if (!hooks.onProgress) return;
    var received=doneBytes+(fileDone ? 0 : (fileReceived || 0));
    try{
      hooks.onProgress({zoneId:zoneId, fileKey:fileKey,
        fileReceived:fileReceived || 0, fileTotal:fileTotal || 0,
        received:received, total:totalBytes});
    }catch(e){}
  }
  var chain=Promise.resolve();
  var failure=null;
  files.forEach(function(zf){
    chain=chain.then(function(){
      if (failure) return null;  // stop at the first failed file
      var entry=manifestEntry(zf.src);
      var fsize=(entry && typeof entry.size==='number') ? entry.size : 0;
      return downloadZoneFile(zf, function(rec, tot){
        report(zf.key, rec, tot || fsize, false);
      }).then(function(res){
        if (res && res.skipped) return;
        if (!res || typeof res.text!=='string') throw new Error('empty download for '+zf.src);
        doneBytes+=(fsize || res.text.length);
        if (!res.fromLocal) allLocal=false;
        if (zf.key==='roads') roadsData=res.data;
        report(zf.key, fsize || res.text.length, fsize || res.text.length, true);
      }).catch(function(err){
        failure={error:err, fileKey:zf.key};
      });
    });
  });
  return chain.then(function(){
    if (failure) return {ok:false, error:failure.error, fileKey:failure.fileKey};
    return {ok:true, alreadyLocal:allLocal, bytes:doneBytes, roads:roadsData};
  });
}

/* ---------------- minimap ----------------
   The downloaded zone's roads join window.__mmExtraRoads — the
   extra collection drawMinimap / drawFullMap (index.html) draw
   alongside the current zone's roadDrawData. Entries carry the
   same shape the world builder pushes for the live zone
   ({pts, mmPts, cat, name}) with mmPts decimated every 4th point
   exactly like the builder does, plus the zone id for replacement.
   The 3D world itself still builds on the zone transition (page
   reload), as designed — this is the minimap's update, per spec. */
if (!window.__mmExtraRoads) window.__mmExtraRoads=[];
function addZoneRoadsToMinimap(zoneId, roadsData){
  try{
    if (!roadsData || typeof roadsData!=='object') return 0;
    var out=[];
    Object.keys(roadsData).forEach(function(cat){
      var list=roadsData[cat];
      if (!list || !list.length) return;
      for (var i=0;i<list.length;i++){
        var r=list[i];
        if (!r || !r.pts || r.pts.length<2) continue;
        var mmPts=[];
        for (var mi=0;mi<r.pts.length;mi+=4) mmPts.push(r.pts[mi]);
        if (r.pts.length>1) mmPts.push(r.pts[r.pts.length-1]);
        out.push({pts:mmPts, mmPts:mmPts, cat:cat, name:r.name || '', zone:zoneId});
      }
    });
    // Replace any earlier entries for this zone (re-downloads and
    // the boot restore must not double-draw).
    window.__mmExtraRoads=window.__mmExtraRoads.filter(function(x){ return x.zone!==zoneId; });
    window.__mmExtraRoads=window.__mmExtraRoads.concat(out);
    return out.length;
  }catch(e){ return 0; }
}

/* Boot restore (browser map store only): zones unlocked in EARLIER
   sessions had their data downloaded at unlock time, so their roads
   belong on the minimap from the start — read them back out of the
   local store (serveText; no network) once the game is up. In the
   APK serveText is inert (the native side serves files, not JS),
   so this simply finds nothing there and the unlock-time update
   remains the path — by design, not by accident. */
var _bootRestored=false;
function restoreMinimapExtras(){
  if (_bootRestored) return; _bootRestored=true;
  try{
    if (!window.ZoneUnlock || !ZoneUnlock.zones) return;
    var current=null;
    try{ if (window.ZONELOADER) current=ZONELOADER.currentZone; }catch(e){}
    ZoneUnlock.zones.forEach(function(z){
      if (z.id===current) return;
      var unlocked=false;
      try{ unlocked=ZoneUnlock.isUnlocked(z.id); }catch(e){}
      if (!unlocked) return;
      var p=null;
      try{ if (window.MapDelivery && MapDelivery.serveText) p=MapDelivery.serveText('zones/'+z.id+'/roads.json'); }catch(e){}
      if (p && typeof p.then==='function'){
        p.then(function(text){
          if (text==null) return;
          try{ addZoneRoadsToMinimap(z.id, JSON.parse(text)); }catch(e){}
        }, function(){});
      }
    });
  }catch(e){}
}

/* ---------------- the ceremony ----------------
   Overlay: #zone-load-overlay (markup + CSS in index.html, modelled
   on the PAUSED overlay). The overlay captures the whole screen
   while a download runs — unlike the pause card, nothing under it
   is reachable until Continue/Cancel, because the world state is
   mid-ceremony (paused, zone half-decided). */
var busy=false;

/* Button actions live in mutable slots, wired to the DOM exactly
   once: the Retry/Cancel meaning changes with every failure (which
   zone, which position in the sequence), so the handlers must call
   the CURRENT slot — a closure wired at the first failure would
   retry the wrong zone at the second. */
var _onContinue=null, _onRetry=null, _onCancel=null;
var _buttonsWired=false;
function wireButtonsOnce(){
  if (_buttonsWired) return; _buttonsWired=true;
  var cont=el('zone-load-continue');
  if (cont) cont.addEventListener('click', function(){ if (_onContinue) _onContinue(); });
  var retry=el('zone-load-retry');
  if (retry) retry.addEventListener('click', function(){ if (_onRetry) _onRetry(); });
  var cancel=el('zone-load-cancel');
  if (cancel) cancel.addEventListener('click', function(){ if (_onCancel) _onCancel(); });
}

function showOverlay(){ var ov=el('zone-load-overlay'); if (ov) ov.classList.add('show'); }
function hideOverlay(){ var ov=el('zone-load-overlay'); if (ov) ov.classList.remove('show'); }
function setTitle(t){ var n=el('zone-load-title'); if (n) n.textContent=t; }
function setStatus(lines){
  var n=el('zone-load-status');
  if (n) n.textContent=(lines || []).join('\n');
}
function setBar(received, total){
  var fill=el('zone-load-fill');
  var pct=(total>0) ? Math.max(0, Math.min(100, Math.floor(100*received/total))) : 0;
  if (fill) fill.style.width=pct+'%';
  return pct;
}
function setDetail(t){ var n=el('zone-load-detail'); if (n) n.textContent=t; }
function showButton(id, visible){
  var b=el(id);
  if (b) b.style.display=visible ? '' : 'none';
  return b;
}

function pauseGame(){
  try{ if (window.GamePause && GamePause.setPaused) GamePause.setPaused(true); }catch(e){}
}
function resumeGame(){
  try{ if (window.GamePause && GamePause.setPaused) GamePause.setPaused(false); }catch(e){}
}
function closeMenus(){
  // The unlock starts inside Settings → Advanced Properties; when
  // the ceremony ends the player returns to the GAME, not the menu,
  // so those panels close as the overlay takes over.
  var ids=['advpass','advprops','settings'];
  for (var i=0;i<ids.length;i++){
    var p=el(ids[i]);
    if (p && p.classList) p.classList.remove('show');
  }
}

/* startFlow(req) — the ZoneUnlock hook. req = {zones:[ids in
   order], source, commit:function(id)->bool}. Returns true when
   the ceremony takes over. The sequence runs one zone at a time;
   each zone commits the moment its own data has landed. */
function startFlow(req){
  if (busy) return false;
  if (!req || !req.zones || !req.zones.length || typeof req.commit!=='function') return false;
  var ids=[];
  for (var i=0;i<req.zones.length;i++){
    var id=req.zones[i];
    var stillLocked=true, known=false;
    try{
      known=!!ZoneUnlock.zoneById(id);
      stillLocked=!ZoneUnlock.isUnlocked(id);
    }catch(e){}
    if (known && stillLocked) ids.push(id);
  }
  if (!ids.length) return false;

  busy=true;
  pauseGame();
  closeMenus();
  showOverlay();
  wireButtonsOnce();
  showButton('zone-load-retry', false);
  showButton('zone-load-cancel', false);
  showButton('zone-load-continue', false);

  var results=[];  // per-zone outcome lines for the final summary
  var newlyCommitted=[];  // names of zones whose unlock COMMITTED in
    // this ceremony — drives the post-unlock environment refresh in
    // finish() (Joshua's ruling, 2026-10-17: the environment must
    // change after an unlock, even if that means an automatic page
    // refresh). Zones that were already open, or whose download
    // failed, never land in this list — so a failed download can
    // never reach the refresh, exactly as the ceremony's law says.

  function finish(){
    // Ceremony over: success, partial success, or a cancelled
    // failure — in every case the player reads the summary and
    // taps Continue to resume. The game stays paused until then.
    setTitle('🗺️ Zone unlock');
    setBar(1, 1);
    setDetail('');
    setStatus(results);
    showButton('zone-load-continue', true);
    showButton('zone-load-retry', false);
    showButton('zone-load-cancel', false);
    _onRetry=null; _onCancel=null;
    _onContinue=function(){
      /* ENVIRONMENT REFRESH (Joshua's ruling, 2026-10-17): when this
         ceremony actually unlocked something, Continue does NOT just
         unpause — the page refreshes so the world rebuilds with the
         newly unlocked zones in it (the world builds one zone per
         page load; without the refresh the unlocked zone stayed
         naked space on entry). The reload rides ui_update_flow's
         resume stash: his exact spot/zone/heading/in-car state are
         restored on boot and he does not move — the restore toast
         tells him the new worlds wait at the boundary. His CURRENT
         zone stays the page's zone (no teleport): the refresh
         changes what crossing will find, not where he stands.
         When nothing committed (all already open, or a cancelled
         failure with no commits) there is nothing new for a reload
         to build — plain resume, no refresh. If the stash cannot be
         written (no live player), fall back to plain resume too:
         the unlock itself already committed and stands. */
      if (newlyCommitted.length){
        try{
          if (window.UIUpdateFlow && typeof UIUpdateFlow.stashAndReload==='function'){
            var toast=(newlyCommitted.length===1)
              ? '🗺️ '+newlyCommitted[0]+' unlocked — its world is ready when you cross.'
              : '🗺️ '+newlyCommitted.length+' zones unlocked — their worlds are ready when you cross.';
            if (UIUpdateFlow.stashAndReload({toast:toast})){
              hideOverlay();
              busy=false;
              return;  // the page is reloading; do NOT resume first
            }
          }
        }catch(e){}
      }
      hideOverlay();
      busy=false;
      resumeGame();
    };
    try{
      if (window.Report && Report.note)
        Report.note('zoneunlock', {done:true, results:results.length});
    }catch(e){}
  }

  function runAt(idx){
    if (idx>=ids.length){ finish(); return; }
    var id=ids[idx];
    var name=zoneName(id);
    setTitle('🗺️ Unlocking '+name);
    setStatus(results.concat(['Downloading '+name+'…']));
    setBar(0, 1);
    setDetail('');
    downloadZone(id, {
      onProgress:function(p){
        var pct=setBar(p.received, p.total);
        var fileTxt=fileLabel(p.fileKey)+': '+mb(p.fileReceived)+
          (p.fileTotal>0 ? ' of '+mb(p.fileTotal) : ' downloaded');
        var zoneTxt=(p.total>0)
          ? name+': '+mb(p.received)+' of '+mb(p.total)+' ('+pct+'%)'
          : name+': '+mb(p.received)+' downloaded';
        setDetail(fileTxt+'\n'+zoneTxt);
      }
    }).then(function(res){
      if (res.ok){
        // Data landed: NOW the unlock commits, and the minimap
        // gains the zone's roads (the dark locked overlay lifts
        // with the commit itself — drawZoneOverlay skips unlocked).
        var committed=false;
        try{ committed=req.commit(id); }catch(e){}
        if (res.roads) addZoneRoadsToMinimap(id, res.roads);
        if (committed){
          newlyCommitted.push(name);
          results.push(res.alreadyLocal
            ? '✓ '+name+' unlocked — already on device, minimap updated.'
            : '✓ '+name+' unlocked — downloaded '+mb(res.bytes)+', minimap updated.');
        } else {
          results.push('✓ '+name+' — data ready (zone was already open).');
        }
        runAt(idx+1);
        return;
      }
      // FAILURE: the zone stays locked. Say why, log it, offer
      // Retry (resume the sequence right here) or Cancel (keep
      // whatever committed and return to the game).
      logFailure(id, res.error, res.fileKey);
      var reason=(res.error && res.error.message) ? res.error.message : 'download failed';
      setTitle('🗺️ '+name+' could not download');
      setStatus(results.concat([
        '✗ '+name+' stayed locked.',
        fileLabel(res.fileKey || '')+' failed: '+reason,
        'Check your connection, then tap RETRY — or Cancel and unlock it later.'
      ]));
      setDetail('');
      showButton('zone-load-retry', true);
      showButton('zone-load-cancel', true);
      showButton('zone-load-continue', false);
      _onContinue=null;
      _onRetry=function(){
        showButton('zone-load-retry', false);
        showButton('zone-load-cancel', false);
        _onRetry=null; _onCancel=null;
        runAt(idx);  // resume the sequence at the failed zone
      };
      _onCancel=function(){
        results.push('✗ '+name+' stayed locked — download cancelled.');
        // Any zones after this one were not attempted; they
        // stay locked too, and the summary must say so.
        for (var j=idx+1;j<ids.length;j++)
          results.push('✗ '+zoneName(ids[j])+' stayed locked — not attempted.');
        showButton('zone-load-retry', false);
        showButton('zone-load-cancel', false);
        _onRetry=null; _onCancel=null;
        finish();
      };
    });
  }

  runAt(0);
  return true;
}

/* ---------------- registration ----------------
   zoneunlock.js loads immediately before this module in the
   deferred queue, so the hook normally registers on first try; the
   poll covers any future load-order change (hotreload, partial
   loads) without ever throwing. */
function tryRegister(){
  try{
    if (window.ZoneUnlock && typeof ZoneUnlock.setUnlockFlow==='function'){
      ZoneUnlock.setUnlockFlow(startFlow);
      return true;
    }
  }catch(e){}
  return false;
}
if (!tryRegister()){
  var _regTries=0;
  var _regIv=setInterval(function(){
    if (tryRegister() || ++_regTries>240) clearInterval(_regIv);
  }, 500);
}

/* Boot restore poll: once the game reports ready (pause_system.js
   reads the same window.__gameReadyFired flag), pull already-
   unlocked zones' roads back onto the minimap from the local
   store. Runs at most once; gives up quietly after ~60s. */
var _bootTries=0;
var _bootIv=setInterval(function(){
  _bootTries++;
  var ready=false;
  try{ ready=!!window.__gameReadyFired; }catch(e){}
  if (ready || _bootTries>120){
    clearInterval(_bootIv);
    restoreMinimapExtras();
  }
}, 500);

/* Public surface (also the verification harness's handle). */
window.ZoneUnlockFlow={
  start:startFlow,
  downloadZone:downloadZone,
  filesFor:zoneFiles,
  addZoneRoadsToMinimap:addZoneRoadsToMinimap,
  isBusy:function(){ return busy; }
};

/* Self-report so Joshua can verify the module loaded (Report panel). */
try{
  if (typeof Report!=='undefined' && Report.setSys){
    Report.setSys('zoneunlockflow', {status:'ok', version:'1.0',
      note:'Unlock = pause + download bar + minimap update, commit on landing (Joshua 2026-10-17)'});
  }
}catch(e){}

})();
