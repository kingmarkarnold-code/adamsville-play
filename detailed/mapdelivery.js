/* ============================================================================
   MAPDELIVERY v1.0 (2026-10-16) — MAP DELIVERY ARCHITECTURE (Joshua's design)
   ----------------------------------------------------------------------------
   Joshua's design: GitHub (the adamsville-play repo, served by GitHub Pages)
   holds THE map. Every copy of the game — the published web copy, the dev
   copy in project/www, and the APK — checks the published version stamp at
   startup and then runs LOCALLY. Nobody streams the map during play; a copy
   only ever downloads the files that actually changed.

   THE DISCIPLINE (identical in spirit in every copy):
   1. CHECK — at startup, fetch the PUBLISHED map-manifest.json fresh
      (cache-busting query + cache:'no-store', the same pattern the watcher
      uses in game_sync.js) and compare its map_version against the local
      copy's map_version. The check is tiny: one small manifest.
   2. DIFF — if the versions differ, compare the two manifests file by file
      by sha256. ONLY the files whose hash changed are downloads — a
      one-zone change downloads that zone's changed files, never the
      whole map.
   3. STORE, THEN RUN LOCAL — the changed files are stored locally (see
      STORAGE below) and the local manifest record is updated to the
      published manifest. Only then does the game load its map — from the
      local store, exactly as if the update had always been bundled.
   4. FAIL-OPEN — any failure (offline, bad manifest, a download error)
      leaves the local copy untouched and the game runs it. The check
      NEVER blocks play and NEVER throws into the loader.

   This module REPLACES the old map rule ("a newer map applies only on
   New Game" — MAPVER.applyOnNewGame) as the primary path: the startup
   check below runs BEFORE any zone data is fetched (the deferred loader
   in index.html pauses its queue on this module — see the mapdelivery
   hook in loadDeferredScript), so by the time the world loads, the local
   copy already IS the published map. MAPVER.applyOnNewGame survives only
   as a safety net for a publish that lands MID-session: MAPVER.checkPending
   still notices it, stages it through this module's cache (see the call
   in MAPVER.checkPending), and the New Game reload then serves the
   staged bytes. Nothing hot-swaps a running world — the running session
   always keeps the map it started with.

   STORAGE — how updated files are served at runtime:
   - Browser (web play copy + dev www copy opened in a browser): the
     changed files live in the Cache Storage cache named below
     ('sa-map-cache-v1'), keyed by their published URL. The deferred
     loader's zone fetch path (index.html __injectZoneFiles) asks
     serveText() for each zone file BEFORE any network fetch, so cached
     (updated) bytes are what the game parses. The local manifest record
     lives in localStorage ('sa_mapdelivery_manifest'); the active
     version is mirrored to 'sa_map_version_active', the key MAPVER
     already reads.
   - APK (www copy inside the app, native MapDownload bridge present):
     this module delegates storage to the bridge — the copy's existing
     mechanism. Changed files download through bridge.downloadFile()
     into the app's ACTIVE map dir, and MainActivity's
     shouldInterceptRequest serves those bytes to the WebView instead of
     the bundled copies. serveText() is not used in this mode (the
     interceptor does the serving). The Java side runs the same
     discipline natively at app open — see
     MapDownloadBridge.checkAndSyncMapAtOpen().

   SCOPE — what the browser cache can and cannot cover:
   The deferred loader FETCHES the zone data files (zones/<id>/zone.json,
   roads.json, buildings.json, pins.json, lifts.json, signs.json,
   hero_buildings.json), so those are covered: they are exactly the
   .json entries of map-manifest.json. The manifest's .js entries
   (elev.js, gas_stations_real.js, and the per-zone .js fallbacks) load
   through <script> tags, which page code cannot intercept without a
   service worker — so in a browser they are reported as "uncovered"
   (in the APK the bridge covers them, per above). The .js zone files
   are only fallbacks for the .json primaries, so the running map is
   fully covered in practice.

   2026-10-17 HARDENING (Joshua's streetless-world report): three changes
   below — (1) downloads STREAM with an inactivity watchdog (20s of
   silence) instead of starving under absolute caps; (2) every download
   is registered in-flight, so when the loader needs a file the startup
   sync is already downloading, serveText() hands over THAT download's
   bytes instead of the loader starting a second, competing fetch of
   the same file; (3) remember() verifies the text's sha256 against the
   manifest on record before warming the store (downloadOne()'s own
   discipline), so unverified bytes can never be served forever.

   2026-10-18 FRESHNESS DRIFT CHECK (Joshua: a road section deleted in
   the Map Editor, saved and pushed, was still in his game): editor
   saves change zone files WITHOUT moving map_version and without
   regenerating this manifest, so the version fast path cannot see
   them — but Cache Storage would serve the replaced bytes forever.
   The equal-version path therefore runs driftCheck() before declaring
   the map current: HEAD probes (headers only) on the fetch-covered
   files actually sitting in the local store, a size mismatch against
   the local record re-downloads just that file and repairs the
   record's entry (size + the fresh bytes' real sha256). A clean map
   still downloads zero files. Details at driftCheck() below.

   TESTABILITY: the factory (create) takes its environment (fetch,
   caches, storage, bridge, clock, sha) by injection, and the pure
   diffManifests() is exported — the Node verification harness drives
   this exact shipped code with stubs. In the browser the module builds
   a default instance from window globals and exposes it as
   window.MapDelivery.
   ============================================================================ */
(function(){
'use strict';

/* Published source of truth — the play copy's GitHub Pages deployment.
   Same base the watcher (game_sync.js), MAPVER and ASSETVER already use. */
var PUBLISHED_BASE='https://kingmarkarnold-code.github.io/adamsville-play/detailed/';
var MANIFEST_NAME='map-manifest.json';
var MANIFEST_URL=PUBLISHED_BASE+MANIFEST_NAME;

/* Browser store: Cache Storage name + localStorage keys. LS_VERSION is
   MAPVER's own key — writing it keeps MAPVER's "active version" honest
   without MAPVER needing to know this module exists. */
var CACHE_NAME='sa-map-cache-v1';
var LS_MANIFEST='sa_mapdelivery_manifest';
var LS_VERSION='sa_map_version_active';

/* ---------------- pure helpers (exported for the harness) ---------------- */

/* A manifest entry's hash, whichever field the manifest used. */
function entrySha(e){ return (e && (e.sha256 || e.hash)) || ''; }

/* Fetch-loaded map files — the ones page code can serve from the cache.
   Today that is exactly the .json zone data (see SCOPE in the header). */
function isFetchCovered(name){ return /\.json$/i.test(name || ''); }

/* diffManifests(localM, remoteM) — the per-file sha256 diff at the heart
   of the discipline. Returns the remote entries whose sha256 differs
   from the local manifest's (including files the local manifest does
   not list at all). Pure: no I/O, no globals — the harness tests this
   function directly. When neither side carries a hash for a file, size
   is the fallback signal; when neither hash nor size is known, the file
   is treated as unchanged (never download on a guess). */
function diffManifests(localM, remoteM){
  var out=[];
  try{
    var localFiles=(localM && localM.files) || [];
    var remoteFiles=(remoteM && remoteM.files) || [];
    var localByName={};
    for (var i=0;i<localFiles.length;i++){
      var lf=localFiles[i];
      if (lf && lf.name) localByName[lf.name]=lf;
    }
    for (var j=0;j<remoteFiles.length;j++){
      var rf=remoteFiles[j];
      if (!rf || !rf.name || rf.name.indexOf('..')!==-1) continue;
      var le=localByName[rf.name];
      if (!le){ out.push(rf); continue; }
      var rs=entrySha(rf), ls=entrySha(le);
      if (rs || ls){
        if (rs!==ls) out.push(rf);
      } else if (typeof rf.size==='number' && typeof le.size==='number'){
        if (rf.size!==le.size) out.push(rf);
      }
    }
  }catch(e){}
  return out;
}

/* A manifest's version stamp, whichever field it used. */
function manifestVersion(m){ return (m && (m.map_version || m.version)) || ''; }

/* Full download URL for a manifest entry (entries carry absolute URLs;
   fall back to the published base + name, mirroring the bridges). */
function entryUrl(e){ return (e && e.url) || (PUBLISHED_BASE + (e && e.name)); }

/* ---------------- the delivery engine (environment injected) ----------------
   env = {
     fetch:      (url, opts) -> Promise<Response-like>   (browser: window.fetch)
     caches:     Cache Storage-like, or null             (browser: window.caches)
     storage:    localStorage-like {getItem,setItem}     (browser: localStorage)
     bridge:     () -> native MapDownload bridge or null (APK detection)
     sha256Hex:  (text) -> Promise<hex string> or null   (integrity check)
     now:        () -> ms timestamp                      (cache-busting)
     log:        (msg) -> void                           (diagnostics)
     progress:   (name, receivedBytes, totalBytes) -> void (optional)
   } */
function create(env){
  env=env || {};
  var fetchFn=env.fetch || null;
  var cachesObj=env.caches || null;
  var storage=env.storage || null;
  var bridgeFn=env.bridge || function(){ return null; };
  var sha256Hex=env.sha256Hex || null;
  var nowFn=env.now || function(){ return Date.now(); };
  var logFn=env.log || function(){};
  var progressFn=env.progress || null;

  /* PROGRESS-BASED TIMEOUT (2026-10-17 — Joshua's streetless-world fix):
     a download is abandoned only after this long with NO bytes arriving.
     A slow download that keeps making progress is allowed to finish —
     flat absolute caps are what starved the 2.4MB zone files on slow
     links when the loader raced this module's sync. */
  var DOWNLOAD_IDLE_MS=20000;

  /* In-flight download registry (2026-10-17 de-dup): entry name ->
     {settled, text, error, lastActivity}. downloadOne() registers BEFORE
     its fetch starts; serveText() waits on the record and returns its
     bytes instead of a second, competing fetch of the same file. */
  var inflight={};

  function log(m){ try{ logFn('[MAPDELIVERY] '+m); }catch(e){} }

  /* The native bridge, when this copy runs inside the APK. Detection is
     done per-call (not at load) so the answer is never stale. */
  function nativeBridge(){
    try{
      var b=bridgeFn();
      if (b && typeof b.downloadFile==='function') return b;
    }catch(e){}
    return null;
  }

  /* ----- local manifest record (localStorage) ----- */
  function readStoredManifest(){
    try{
      if (!storage) return null;
      var raw=storage.getItem(LS_MANIFEST);
      if (!raw) return null;
      var m=JSON.parse(raw);
      return (m && typeof m==='object') ? m : null;
    }catch(e){ return null; }
  }
  function writeStoredManifest(m, rawText){
    try{
      if (!storage || !m) return;
      storage.setItem(LS_MANIFEST, rawText || JSON.stringify(m));
      var v=manifestVersion(m);
      if (v) storage.setItem(LS_VERSION, v);
    }catch(e){}
  }

  /* ----- Cache Storage helpers (browser store) ----- */
  function cacheOpen(){
    if (!cachesObj || typeof cachesObj.open!=='function') return Promise.resolve(null);
    return cachesObj.open(CACHE_NAME).catch(function(){ return null; });
  }
  /* Store one file's text under its published URL. */
  function cachePut(name, text){
    return cacheOpen().then(function(cache){
      if (!cache) return false;
      var resp;
      try{
        resp=new Response(text, {headers:{'Content-Type': /\.json$/i.test(name) ? 'application/json' : 'text/plain'}});
      }catch(e){
        /* Node stubs / older engines: a minimal Response-like is enough
           for our own match().text() round-trip. */
        resp={ _text:text, text:function(){ return Promise.resolve(text); } };
      }
      return cache.put(PUBLISHED_BASE+name, resp).then(function(){ return true; });
    }).catch(function(){ return false; });
  }
  /* Read one file's text back from the cache, or null on any miss/error.
     This is what the deferred loader calls before fetching a zone file. */
  function cacheGetText(name){
    return cacheOpen().then(function(cache){
      if (!cache) return null;
      return cache.match(PUBLISHED_BASE+name).then(function(resp){
        if (!resp) return null;
        return resp.text();
      });
    }).catch(function(){ return null; });
  }

  /* ----- the published manifest, fetched fresh -----
     Watcher pattern (game_sync.js): cache:'no-store' + a cache-busting
     query, so no CDN edge or browser cache can serve a stale stamp.
     In bridge mode the native fetchText is used instead — it already
     sends Cache-Control: no-cache (see MapDownloadBridge.fetchText). */
  function fetchRemoteManifest(bridge){
    if (bridge && typeof bridge.fetchText==='function'){
      return Promise.resolve().then(function(){
        var raw=bridge.fetchText(MANIFEST_URL);
        if (!raw) throw new Error('bridge manifest fetch empty');
        return { manifest: JSON.parse(raw), rawText: raw };
      });
    }
    if (!fetchFn) return Promise.reject(new Error('no fetch available'));
    var url=MANIFEST_URL+'?cb='+nowFn();
    return fetchFn(url, {cache:'no-store'}).then(function(r){
      if (!r || !r.ok) throw new Error('manifest HTTP '+(r && r.status));
      return r.text();
    }).then(function(text){
      return { manifest: JSON.parse(text), rawText: text };
    });
  }

  /* ----- streaming body reader with an inactivity watchdog -----
     Reads a fetch Response's body as text, reporting (received, total)
     progress per chunk. The watchdog is PROGRESS-BASED: it fires only
     after DOWNLOAD_IDLE_MS with no bytes arriving, so a slow-but-alive
     download always finishes. Falls back to r.text() when streaming
     reads are unavailable (older engines, harness stubs) — behaviour
     there is unchanged from the original downloadOne(). */
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

  /* ----- one changed file, downloaded into the local store -----
     Browser mode: network fetch -> integrity check -> Cache Storage.
     Bridge mode: the bridge downloads into the ACTIVE map dir (the
     copy's existing mechanism — MainActivity serves those bytes). */
  function downloadOne(entry, bridge){
    var url=entryUrl(entry);
    if (bridge){
      return Promise.resolve().then(function(){
        var r=bridge.downloadFile(url, entry.name) || '';
        if (r.indexOf('OK:')!==0) throw new Error('bridge download failed for '+entry.name+': '+r);
        return entry.size || 0;
      });
    }
    if (!fetchFn) return Promise.reject(new Error('no fetch available'));
    /* IN-FLIGHT REGISTRY (2026-10-17 de-dup): record this download
       BEFORE the fetch starts, so a serveText() arriving mid-download
       waits for THESE bytes instead of racing a second fetch of the
       same file (on a slow link the two copies split the bandwidth and
       both starved — part of the streetless-world failure). Progress
       callbacks keep rec.lastActivity honest for the waiter's watchdog. */
    var rec={ settled:false, text:null, error:null, lastActivity:nowFn() };
    inflight[entry.name]=rec;
    var textP=fetchFn(url+(url.indexOf('?')===-1?'?':'&')+'cb='+nowFn(), {cache:'no-store'})
      .then(function(r){
        if (!r || !r.ok) throw new Error('HTTP '+(r && r.status)+' for '+entry.name);
        return readBodyText(r, function(received, total){
          rec.lastActivity=nowFn();
          if (progressFn){ try{ progressFn(entry.name, received, total); }catch(e){} }
        });
      })
      .then(function(text){
        /* Integrity: when a sha function is available and the manifest
           carries a hash, the stored bytes must match it — a corrupted
           or truncated download must never enter the local store. */
        var verify=Promise.resolve();
        if (sha256Hex && entrySha(entry)){
          verify=Promise.resolve(sha256Hex(text)).then(function(h){
            if (h && h!==entrySha(entry)) throw new Error('sha256 mismatch for '+entry.name);
          });
        }
        return verify.then(function(){ return cachePut(entry.name, text); })
          .then(function(stored){
            if (!stored) throw new Error('cache store failed for '+entry.name);
            return text;
          });
      });
    /* Settle bookkeeping: waiters already holding rec keep it; the
       registry entry itself is dropped once settled, so LATER
       serveText() calls go straight to Cache Storage (the bytes are
       stored by the time textP settles — cachePut precedes it). */
    textP.then(function(text){
      rec.settled=true; rec.text=text;
      if (inflight[entry.name]===rec) delete inflight[entry.name];
    }, function(err){
      rec.settled=true; rec.error=err;
      if (inflight[entry.name]===rec) delete inflight[entry.name];
    });
    return textP.then(function(text){ return text.length; });
  }

  /* ----- THE STARTUP CHECK (Joshua's discipline) -----
     localHint: the local copy's manifest when the caller already has it
     (index.html's __fetchLoadManifests fetches the local map-manifest.json
     before the deferred queue runs and passes it in). The stored record
     (localStorage) wins when present — it is the record of the last
     applied update, which is the copy's true local state.
     Resolves (never rejects) with:
       { status:'current',  from, to, downloads:[], uncovered:[] }
       { status:'updated',  from, to, downloads:[names], uncovered:[names], bytes }
       { status:'offline',  ... }  manifest unreachable — run local
       { status:'failed',   ... }  a download failed — run local, retry next launch
       { status:'no-baseline', ... } no local manifest known — run local
     On 'updated'/'current' the local manifest record has been advanced
     to the published manifest; on every other status NOTHING is touched. */
  function runStartupCheck(localHint){
    var bridge=nativeBridge();
    var localM=readStoredManifest() || localHint || null;
    if (!localM){
      log('no local manifest baseline — running local copy as-is.');
      return Promise.resolve({status:'no-baseline', from:'', to:'', downloads:[], uncovered:[]});
    }
    var localVer=manifestVersion(localM);
    return fetchRemoteManifest(bridge).then(function(remote){
      var remoteM=remote.manifest;
      var remoteVer=manifestVersion(remoteM);
      if (!remoteVer) throw new Error('published manifest has no map_version');
      if (remoteVer===localVer){
        /* Same stamp — persist the record if it came from the hint, so
           later launches skip the hint fetch. */
        if (!readStoredManifest()) writeStoredManifest(remoteM, remote.rawText);
        if (bridge){
          /* Bridge mode: the native side runs its own sync at app
             open — the drift check below is the browser store's. */
          log('map is current (v'+localVer+') — zero downloads.');
          return {status:'current', from:localVer, to:remoteVer, downloads:[], uncovered:[]};
        }
        /* Same stamp no longer proves same map (2026-10-18 drift fix):
           an editor save changes zone files without moving the stamp,
           so before declaring the map current, probe the stored files
           against the server's own headers and repair any that drifted
           (see driftCheck). Costs a few header-only responses; a clean
           map still downloads zero files. */
        return driftCheck(localM).then(function(drift){
          if (drift.downloads.length){
            return {status:'updated', drift:true, from:localVer, to:remoteVer,
                    downloads:drift.downloads, uncovered:[], bytes:drift.bytes};
          }
          log('map is current (v'+localVer+') — zero downloads.');
          return {status:'current', from:localVer, to:remoteVer, downloads:[], uncovered:[]};
        });
      }
      var changed=diffManifests(localM, remoteM);
      var covered=[], uncovered=[];
      for (var i=0;i<changed.length;i++){
        /* In bridge mode the native store covers every file; in a
           browser only the fetch-loaded (.json) files can be served
           from Cache Storage — the rest are reported, not downloaded
           into a store nothing could serve. */
        if (bridge || isFetchCovered(changed[i].name)) covered.push(changed[i]);
        else uncovered.push(changed[i].name);
      }
      log('map v'+localVer+' -> v'+remoteVer+': '+changed.length+' file(s) changed, '+
          covered.length+' to download'+(uncovered.length?(', '+uncovered.length+' uncovered in browser: '+uncovered.join(', ')):'')+'.');
      /* Sequential downloads (the game's own forceRedownload pattern):
         one at a time, so a phone on a slow connection is never flooded,
         and the first failure stops the batch with the local copy
         untouched — the record only advances when EVERY covered file
         landed, so a partial update can never be served. */
      var downloads=[], bytes=0, chain=Promise.resolve();
      covered.forEach(function(entry){
        chain=chain.then(function(){
          return downloadOne(entry, bridge).then(function(n){
            downloads.push(entry.name);
            bytes+=(typeof n==='number' ? n : (entry.size || 0));
          });
        });
      });
      return chain.then(function(){
        writeStoredManifest(remoteM, remote.rawText);
        if (bridge && typeof bridge.markSetupComplete==='function'){
          try{ bridge.markSetupComplete(remoteVer); }catch(e){}
        }
        log('map updated to v'+remoteVer+' ('+downloads.length+' file(s), '+bytes+' bytes) — running local store.');
        return {status: changed.length ? 'updated' : 'current',
                versionAdopted: changed.length===0,
                from:localVer, to:remoteVer, downloads:downloads, uncovered:uncovered, bytes:bytes};
      });
    }).catch(function(err){
      /* FAIL-OPEN: offline, a bad manifest, or a failed download all
         land here. The local copy is untouched; play proceeds. The
         manifest-fetch failure is the ordinary offline case; download
         failures are distinguished in the message only — behaviour is
         identical (run local, retry next launch). */
      var msg=String((err && err.message) || err);
      log('check did not complete ('+msg+') — running local copy.');
      return {status: /HTTP|fetch|bridge manifest|no fetch/.test(msg) ? 'offline' : 'failed',
              from:localVer, to:'', downloads:[], uncovered:[], error:msg};
    });
  }

  /* ----- FRESHNESS DRIFT CHECK (2026-10-18 — Joshua's report: a road
     section he deleted in the Map Editor, saved and pushed, was still
     in his game) -----
     Editor saves push changed zone files straight to the repo: they do
     NOT move map_version and do NOT regenerate map-manifest.json (the
     per-file hash/size entries keep describing the pre-save bytes). So
     the version fast path in runStartupCheck() cannot see those saves,
     while Cache Storage goes on serving the replaced bytes forever.
     The server's own headers are the ground truth: GitHub Pages
     answers a HEAD request with the file's current Content-Length.
     This check probes ONLY the fetch-covered files that are actually
     sitting in the local store — the only bytes serveText() could ever
     serve stale — so a normal launch costs a few header-only responses
     and zero file downloads.
     A size mismatch means the server bytes changed under an unmoved
     stamp: re-download just that file (the manifest's recorded hash
     describes the OLD bytes in exactly this situation, so it is
     stripped from the download entry — integrity is re-established by
     recording the fresh bytes' real sha256 in the local record) and
     repair the local manifest record (size + sha256), so the record
     describes reality again and remember()'s integrity check accepts
     the new bytes from then on.
     FAIL-OPEN, like everything in this module: any probe or download
     error leaves the local copy untouched and the game runs it. */
  function headSize(url){
    if (!fetchFn) return Promise.resolve(null);
    return fetchFn(url, {method:'HEAD', cache:'no-store'}).then(function(r){
      if (!r || !r.ok) return null;
      var cl=null;
      try{
        if (r.headers && typeof r.headers.get==='function'){
          var v=r.headers.get('content-length');
          if (v!=null){ var n=parseInt(v, 10); if (isFinite(n) && n>=0) cl=n; }
        }
      }catch(e){}
      return cl;
    }).catch(function(){ return null; });
  }

  /* Is this file's bytes sitting in the local store right now? */
  function cacheHas(name){
    return cacheOpen().then(function(cache){
      if (!cache) return false;
      return cache.match(PUBLISHED_BASE+name).then(function(resp){ return !!resp; });
    }).catch(function(){ return false; });
  }

  /* Patch one entry of the local manifest record to describe the bytes
     actually stored (size + real sha256; hash fields removed when no
     sha could be computed — never store a hash we did not verify).
     Persists after each repair so partial progress is kept. */
  function repairRecordEntry(record, name, size, sha){
    if (!record || !record.files) return;
    for (var i=0;i<record.files.length;i++){
      var e=record.files[i];
      if (e && e.name===name){
        e.size=size;
        if (sha){ e.sha256=sha; delete e.hash; }
        else { delete e.sha256; delete e.hash; }
        break;
      }
    }
    writeStoredManifest(record);
  }

  function driftCheck(baseM){
    var result={downloads:[], bytes:0};
    if (!fetchFn || !cachesObj) return Promise.resolve(result);
    var files=(baseM && baseM.files) || [];
    var candidates=[];
    for (var i=0;i<files.length;i++){
      var e=files[i];
      if (e && e.name && isFetchCovered(e.name) && typeof e.size==='number') candidates.push(e);
    }
    if (!candidates.length) return Promise.resolve(result);
    /* Presence first (local, free), then HEAD probes (headers only). */
    return Promise.all(candidates.map(function(e){
      return cacheHas(e.name).then(function(has){ return has ? e : null; });
    })).then(function(present){
      var drifted=[];
      var probes=[];
      present.forEach(function(e){
        if (!e) return;
        probes.push(headSize(entryUrl(e)).then(function(size){
          if (size!=null && size!==e.size) drifted.push({entry:e, serverSize:size});
        }));
      });
      return Promise.all(probes).then(function(){ return drifted; });
    }).then(function(drifted){
      if (!drifted.length) return result;
      /* The working record starts from the stored manifest (the
         client's true local state); absent one, from the baseline the
         caller passed. Each successful repair is persisted at once. */
      var working=readStoredManifest();
      if (!working){
        try{ working=JSON.parse(JSON.stringify(baseM)); }catch(e){ working=null; }
      }
      var chain=Promise.resolve();
      drifted.forEach(function(d){
        chain=chain.then(function(){
          /* Hash stripped on purpose (see the header note): the
             recorded hash describes the replaced bytes and would make
             downloadOne() reject the fresh ones. */
          var dl={name:d.entry.name, url:entryUrl(d.entry), size:d.serverSize};
          return downloadOne(dl, null).then(function(){
            return cacheGetText(d.entry.name);
          }).then(function(text){
            if (typeof text!=='string') throw new Error('drift readback failed for '+d.entry.name);
            result.downloads.push(d.entry.name);
            result.bytes+=text.length;
            var shaP=sha256Hex ? Promise.resolve(sha256Hex(text)).catch(function(){ return ''; })
                                : Promise.resolve('');
            return shaP.then(function(sha){
              repairRecordEntry(working, d.entry.name, text.length, sha || '');
              log('drift repaired '+d.entry.name+': server had '+d.serverSize+
                  ' bytes, local record said '+d.entry.size+' — fresh copy stored.');
            });
          }).catch(function(err){
            log('drift repair skipped '+d.entry.name+' ('+String((err && err.message) || err)+') — local copy kept.');
          });
        });
      });
      return chain.then(function(){ return result; });
    });
  }

  /* ----- serving: the loader's pre-fetch lookup -----
     Returns the cached text for a manifest-named file, or null when the
     cache has nothing (the loader then does its normal network fetch —
     which, for unchanged files, returns bytes identical to the cache's
     would-be content, because the sha diff proved them equal).
     In bridge mode always null: the native interceptor serves updated
     files; a JS-side cache would only duplicate it. */
  function serveText(name){
    if (nativeBridge()) return Promise.resolve(null);
    if (!name) return Promise.resolve(null);
    return cacheGetText(name).then(function(text){
      if (text!=null) return text;
      var rec=inflight[name];
      if (!rec) return null;
      /* DE-DUP (2026-10-17): the startup sync is downloading THIS file
         right now — wait for its bytes instead of starting a competing
         fetch. The wait is progress-based, mirroring the download's own
         watchdog: it gives up only after DOWNLOAD_IDLE_MS with no bytes
         moving, after which serveText returns null and the loader runs
         its own fetch with its own inactivity watchdog. */
      return new Promise(function(resolve){
        var iv=setInterval(function(){
          if (rec.settled){ clearInterval(iv); resolve(rec.error ? null : rec.text); }
          else if (nowFn()-rec.lastActivity>DOWNLOAD_IDLE_MS){ clearInterval(iv); resolve(null); }
        }, 250);
        if (rec.settled){ clearInterval(iv); resolve(rec.error ? null : rec.text); }
      }).then(function(t){
        return t!=null ? t : cacheGetText(name);
      });
    });
  }

  /* Warm the cache with bytes the loader already fetched from the
     network (see __injectZoneFiles): after one online launch the cache
     holds the full current zone set, so later launches can serve even
     unchanged files locally. Only fetch-covered names are stored. */
  function remember(name, text){
    if (nativeBridge()) return Promise.resolve(false);
    if (!name || !isFetchCovered(name) || typeof text!=='string') return Promise.resolve(false);
    /* INTEGRITY (2026-10-17 hardening): never warm the store with bytes
       that fail verification — the same discipline downloadOne() applies
       to its own downloads. The manifest ON RECORD (the stored manifest:
       the last published manifest this copy applied) is the reference;
       when it carries a sha256 for this file and a sha function is
       available, the text must match it or the store is refused. A
       refusal costs nothing — the next launch fetches the file again —
       while a poisoned entry would be served on EVERY launch. When no
       reference hash exists the bytes are stored as before. */
    var stored=readStoredManifest();
    var entry=null;
    if (stored && stored.files){
      for (var i=0;i<stored.files.length;i++){
        if (stored.files[i] && stored.files[i].name===name){ entry=stored.files[i]; break; }
      }
    }
    var want=entrySha(entry);
    if (!want || !sha256Hex) return cachePut(name, text);
    return Promise.resolve(sha256Hex(text)).then(function(h){
      if (h && h!==want){
        log('remember refused '+name+': sha256 does not match the manifest on record.');
        return false;
      }
      return cachePut(name, text);
    }).catch(function(){ return false; });
  }

  return {
    runStartupCheck: runStartupCheck,
    serveText: serveText,
    remember: remember,
    driftCheck: driftCheck,
    diffManifests: diffManifests,
    isFetchCovered: isFetchCovered,
    readStoredManifest: readStoredManifest,
    PUBLISHED_BASE: PUBLISHED_BASE,
    CACHE_NAME: CACHE_NAME
  };
}

/* ---------------- browser default instance ----------------
   Built from the real window globals. sha256Hex uses SubtleCrypto when
   available (secure contexts: https Pages + the APK's file:// WebView);
   when it is not, integrity verification is skipped — the manifest diff
   and the record discipline still apply. */
function browserSha256Hex(text){
  try{
    if (typeof crypto==='undefined' || !crypto.subtle || !crypto.subtle.digest) return Promise.resolve('');
    var bytes=new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', bytes).then(function(buf){
      var out='';
      var view=new Uint8Array(buf);
      for (var i=0;i<view.length;i++) out+=('0'+view[i].toString(16)).slice(-2);
      return out;
    }).catch(function(){ return ''; });
  }catch(e){ return Promise.resolve(''); }
}

var api={
  create: create,
  diffManifests: diffManifests,
  isFetchCovered: isFetchCovered,
  PUBLISHED_BASE: PUBLISHED_BASE,
  MANIFEST_URL: MANIFEST_URL,
  CACHE_NAME: CACHE_NAME
};

if (typeof window!=='undefined'){
  var defaultInstance=create({
    fetch: (typeof window.fetch==='function') ? window.fetch.bind(window) : null,
    caches: (typeof window.caches!=='undefined') ? window.caches : null,
    storage: (function(){ try{ return window.localStorage; }catch(e){ return null; } })(),
    bridge: function(){ try{ return window.MapDownload || null; }catch(e){ return null; } },
    sha256Hex: browserSha256Hex,
    now: function(){ return Date.now(); },
    log: function(m){ try{ console.log(m); }catch(e){} },
    /* Live download progress -> the loader's progress line in index.html
       (window.__zoneFileProgress), so a slow map sync reads as loading.
       The progress key is the loader's step key: the file's base name
       minus .json ('zones/adamsville/roads.json' -> 'roads'). */
    progress: function(name, received, total){
      try{
        if (typeof window.__zoneFileProgress==='function'){
          window.__zoneFileProgress(String(name).split('/').pop().replace(/\.json$/i,''), received, total);
        }
      }catch(e){}
    }
  });
  api.runStartupCheck=defaultInstance.runStartupCheck;
  api.serveText=defaultInstance.serveText;
  api.remember=defaultInstance.remember;
  api.readStoredManifest=defaultInstance.readStoredManifest;
  window.MapDelivery=api;
}

/* Node (verification harness): export the factory without a window. */
if (typeof module!=='undefined' && module.exports){ module.exports=api; }

})();
