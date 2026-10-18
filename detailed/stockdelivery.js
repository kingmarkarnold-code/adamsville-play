/* ============================================================================
   STOCKDELIVERY v1.0 (2026-10-17) — UNIFIED STOCK DELIVERY (Joshua's design)
   ----------------------------------------------------------------------------
   Joshua's design (ONE-SOURCE.md section 4, extended 2026-10-17): the
   repo is ONE stock library and the game is a first-class consumer of
   it, the same way the editors are. A first install downloads the stock
   with progress shown in MB; after that, a launch downloads ONLY the
   files that changed. MAPDELIVERY already proved that discipline for
   the map area. This module is that discipline GENERALIZED, not forked:
     - same published base, same local store (the Cache Storage cache
       'sa-map-cache-v1' and localStorage records — see STORAGE below),
     - same rules: fresh manifest check, per-file sha256 diff,
       changed-files-only downloads, sha-verified stores, fail-open,
     - one manifest (stock-manifest.json) whose sections mirror the
       four existing per-area manifests (map / ui / vehicles / music),
       so the whole stock is diffed in a single check.

   OWNERSHIP — adopted incrementally, on purpose:
   The per-area deliveries that already work are NOT replaced. The map
   area stays owned by mapdelivery.js (its startup check runs at this
   same launch and covers the zone data far more deeply — serving,
   in-flight de-dup, the loader's pause). This layer therefore never
   downloads a map-section file: it reports map changes as 'delegated'
   so a slow link never pays for the same bytes twice (the
   streetless-world lesson). For the other areas it downloads only
   FETCH-COVERED files (.json — the files page code can actually serve
   back from Cache Storage, exactly mapdelivery's SCOPE rule): today
   that is the UI area's ui_layout.json / menu_layout.json when they
   change. Script files, images and audio are loaded by mechanisms page
   code cannot intercept without a service worker, so they are
   reported in the plan as 'uncovered', never downloaded into a store
   nothing could serve. In the APK (native bridge present) the native
   shell owns asset downloads, so this layer checks + plans + reports
   only, and says so in its result.

   FAILURE PHILOSOPHY (Joshua, 2026-10-17): fail-open, but NEVER
   silent. Any failure — offline, a bad manifest, a sha mismatch, a
   failed download — leaves the local copy untouched and play
   proceeds, exactly like mapdelivery. But every failure is LOGGED
   (console) and real defects (bad manifest, sha mismatch, download
   or store failure) are also REPORTED through the game's report hook
   (GitHubReports.queue / Report.note when present — best effort: the
   hook may load later than this module, so undeliverable reports are
   kept in memory and retried once shortly after launch). Offline is
   an environment fact, not a defect: it is logged, not reported.

   THE STARTUP CHECK resolves (never rejects) with one of:
     { status:'current',          ... } stock matches the published manifest
     { status:'updated',          ... } changed covered files downloaded+stored
     { status:'update-available', ... } changes exist, none coverable here
                                        (delegated and/or uncovered lists say why)
     { status:'offline',          ... } published manifest unreachable
     { status:'failed',           ... } a defect: bad manifest / sha / download
     { status:'no-baseline',      ... } no local stock manifest known
   On 'current'/'updated' the local record has advanced to the
   published manifest; on every other status NOTHING is touched, so a
   partial update can never be served and the next launch retries.

   PROGRESS: env.progress(name, receivedBytes, totalBytes) fires per
   chunk (mapdelivery's shape), and env.progressTotal(doneBytes,
   totalBytes, name) tracks the whole batch in bytes — the load screen
   reads it via window.__STOCKDELIVERY_PROGRESS ({file, fileReceived,
   fileTotal, bytesDone, bytesTotal}) and can render it as MB. The
   loader is never paused on this module (see the index.html hook), so
   the readout is available, not gating.

   STORAGE — deliberately the same store mapdelivery uses:
   - Browser: Cache Storage 'sa-map-cache-v1', keyed by published URL;
     serveText(name) reads any stock file back from that cache (the
     map area's zone files included — one cache, one key scheme).
     localStorage 'sa_stockdelivery_manifest' holds the last published
     stock manifest this layer applied or confirmed current;
     'sa_stockdelivery_seen_version' deduplicates update reports.
   - APK (native MapDownload bridge present): check + plan + report
     only (see OWNERSHIP above); serveText returns null — the native
     interceptor serves updated files itself.

   TESTABILITY: the factory (create) takes its environment by
   injection and the pure planDownloads() is exported — the Node
   verification harness drives this exact shipped code with stubs. In
   the browser the module builds a default instance from window
   globals and exposes it as window.StockDelivery.
   ============================================================================ */
(function(){
'use strict';

/* Published source of truth — the same base mapdelivery, the watcher
   and MAPVER use: the play copy's GitHub Pages deployment. */
var PUBLISHED_BASE='https://kingmarkarnold-code.github.io/adamsville-play/detailed/';
var STOCK_MANIFEST_NAME='stock-manifest.json';
var STOCK_MANIFEST_URL=PUBLISHED_BASE+STOCK_MANIFEST_NAME;

/* The store is mapdelivery's store — literally the same Cache Storage
   cache name and published-URL keys, so bytes either module stores are
   bytes both can serve. The localStorage keys are this module's own. */
var CACHE_NAME='sa-map-cache-v1';
var LS_STOCK_RECORD='sa_stockdelivery_manifest';
var LS_STOCK_SEEN='sa_stockdelivery_seen_version';

/* The stock areas, mirroring the four per-area manifests. 'owner'
   says who downloads an area's changed files:
   - 'mapdelivery': the map area — owned by mapdelivery.js; this layer
     reports its changes as delegated and never downloads them.
   - 'stock': this layer downloads the area's fetch-covered files. */
var AREAS=[
  { id:'map',      manifest:'map-manifest.json',      versionKey:'map_version',      owner:'mapdelivery' },
  { id:'ui',       manifest:'ui-manifest.json',       versionKey:'ui_version',       owner:'stock' },
  { id:'vehicles', manifest:'vehicles-manifest.json', versionKey:'vehicles_version', owner:'stock' },
  { id:'music',    manifest:'music-manifest.json',    versionKey:'music_version',    owner:'stock' }
];
function areaById(id){
  for (var i=0;i<AREAS.length;i++) if (AREAS[i].id===id) return AREAS[i];
  return null;
}

/* ---------------- pure helpers (exported for the harness) ---------------- */

/* A manifest entry's hash, whichever field the manifest used. */
function entrySha(e){ return (e && (e.sha256 || e.hash)) || ''; }

/* Fetch-loaded stock files — the ones page code can serve from the
   cache. Today that is .json (data/layout files), exactly
   mapdelivery's SCOPE rule. */
function isFetchCovered(name){ return /\.json$/i.test(name || ''); }

/* One section's entry list from a stock manifest (or [] when absent). */
function sectionFiles(stockM, areaId){
  var s=(stockM && stockM.sections && stockM.sections[areaId]) || null;
  return (s && s.files) || [];
}

/* The unified manifest's version stamp. */
function stockVersion(m){ return (m && m.stock_version) || ''; }

/* planDownloads(localStock, remoteStock) — the per-file sha256 diff
   across ALL sections, the generalized diffManifests(). Pure: no I/O,
   no globals — the harness tests this function directly. Returns
   { changed:[{area,name,size,sha256,url}], byArea:{areaId:[entries]},
     totalBytes } — every remote entry whose sha256 differs from the
   local manifest's (including files the local manifest does not list
   at all). When neither side carries a hash for a file, size is the
   fallback signal; when neither hash nor size is known, the file is
   treated as unchanged (never download on a guess) — mapdelivery's
   diff discipline, unchanged. */
function planDownloads(localM, remoteM){
  var changed=[], byArea={}, totalBytes=0;
  try{
    for (var a=0;a<AREAS.length;a++){
      var areaId=AREAS[a].id;
      var remoteFiles=sectionFiles(remoteM, areaId);
      var localFiles=sectionFiles(localM, areaId);
      var localByName={};
      for (var i=0;i<localFiles.length;i++){
        var lf=localFiles[i];
        if (lf && lf.name) localByName[lf.name]=lf;
      }
      for (var j=0;j<remoteFiles.length;j++){
        var rf=remoteFiles[j];
        if (!rf || !rf.name || rf.name.indexOf('..')!==-1) continue;
        var le=localByName[rf.name];
        var isChanged=false;
        if (!le){ isChanged=true; }
        else {
          var rs=entrySha(rf), ls=entrySha(le);
          if (rs || ls){ isChanged=(rs!==ls); }
          else if (typeof rf.size==='number' && typeof le.size==='number'){
            isChanged=(rf.size!==le.size);
          }
        }
        if (isChanged){
          var entry={ area:areaId, name:rf.name, size:(typeof rf.size==='number'?rf.size:0),
                      sha256:entrySha(rf), url:rf.url || (PUBLISHED_BASE+rf.name) };
          changed.push(entry);
          (byArea[areaId]=byArea[areaId] || []).push(entry);
          totalBytes+=entry.size;
        }
      }
    }
  }catch(e){}
  return { changed:changed, byArea:byArea, totalBytes:totalBytes };
}

/* Full download URL for a plan entry. */
function entryUrl(e){ return (e && e.url) || (PUBLISHED_BASE + (e && e.name)); }

/* Find one file's entry across all sections of a stock manifest. */
function findStockEntry(stockM, name){
  if (!stockM || !name) return null;
  for (var a=0;a<AREAS.length;a++){
    var files=sectionFiles(stockM, AREAS[a].id);
    for (var i=0;i<files.length;i++){
      if (files[i] && files[i].name===name) return files[i];
    }
  }
  return null;
}

/* ---------------- the delivery engine (environment injected) ----------------
   env = {
     fetch:        (url, opts) -> Promise<Response-like>   (browser: window.fetch)
     caches:       Cache Storage-like, or null             (browser: window.caches)
     storage:      localStorage-like {getItem,setItem}     (browser: localStorage)
     bridge:       () -> native MapDownload bridge or null (APK detection)
     sha256Hex:    (text) -> Promise<hex string> or null   (integrity check)
     now:          () -> ms timestamp                      (cache-busting)
     log:          (msg) -> void                           (diagnostics, always on)
     report:       (kind, details) -> void                 (defect reports — the
                       game's report hook; optional, failures here are real)
     progress:     (name, receivedBytes, totalBytes)       (per-file, optional)
     progressTotal:(doneBytes, totalBytes, name)           (whole batch, optional)
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
  var reportFn=env.report || null;
  var progressFn=env.progress || null;
  var progressTotalFn=env.progressTotal || null;

  /* PROGRESS-BASED TIMEOUT — mapdelivery's rule, unchanged: a download
     is abandoned only after this long with NO bytes arriving. A slow
     download that keeps making progress is allowed to finish. */
  var DOWNLOAD_IDLE_MS=20000;

  function log(m){ try{ logFn('[STOCKDELIVERY] '+m); }catch(e){} }
  /* Defects are reported, not just logged (failure philosophy). The
     report hook itself must never be able to break delivery. */
  function report(kind, details){
    log('REPORT '+kind+(details ? ' — '+details : ''));
    if (reportFn){ try{ reportFn(kind, details); }catch(e){} }
  }

  /* The native bridge, when this copy runs inside the APK. Detection
     is done per-call (not at load) so the answer is never stale. */
  function nativeBridge(){
    try{
      var b=bridgeFn();
      if (b && typeof b.downloadFile==='function') return b;
    }catch(e){}
    return null;
  }

  /* ----- local manifest record (localStorage) ----- */
  function readStoredRecord(){
    try{
      if (!storage) return null;
      var raw=storage.getItem(LS_STOCK_RECORD);
      if (!raw) return null;
      var m=JSON.parse(raw);
      return (m && typeof m==='object') ? m : null;
    }catch(e){ return null; }
  }
  function writeStoredRecord(m, rawText){
    try{
      if (!storage || !m) return;
      storage.setItem(LS_STOCK_RECORD, rawText || JSON.stringify(m));
    }catch(e){}
  }
  function readSeenVersion(){
    try{ return (storage && storage.getItem(LS_STOCK_SEEN)) || ''; }catch(e){ return ''; }
  }
  function writeSeenVersion(v){
    try{ if (storage && v) storage.setItem(LS_STOCK_SEEN, v); }catch(e){}
  }

  /* ----- Cache Storage helpers — mapdelivery's store, shared -----
     Same cache name, same published-URL keys: a file either module
     stored is a file both can serve. */
  function cacheOpen(){
    if (!cachesObj || typeof cachesObj.open!=='function') return Promise.resolve(null);
    return cachesObj.open(CACHE_NAME).catch(function(){ return null; });
  }
  function cachePut(name, text){
    return cacheOpen().then(function(cache){
      if (!cache) return false;
      var resp;
      try{
        resp=new Response(text, {headers:{'Content-Type': /\.json$/i.test(name) ? 'application/json' : 'text/plain'}});
      }catch(e){
        resp={ _text:text, text:function(){ return Promise.resolve(text); } };
      }
      return cache.put(PUBLISHED_BASE+name, resp).then(function(){ return true; });
    }).catch(function(){ return false; });
  }
  function cacheGetText(name){
    return cacheOpen().then(function(cache){
      if (!cache) return null;
      return cache.match(PUBLISHED_BASE+name).then(function(resp){
        if (!resp) return null;
        return resp.text();
      });
    }).catch(function(){ return null; });
  }

  /* ----- manifest fetches -----
     Published manifest: watcher pattern (cache:'no-store' + a
     cache-busting query, so no CDN edge or browser cache can serve a
     stale stamp); in bridge mode the native fetchText is used, as in
     mapdelivery. Bundled manifest: the stock-manifest.json shipped
     beside this code — this copy's own baseline, fetched relatively. */
  function fetchRemoteManifest(bridge){
    if (bridge && typeof bridge.fetchText==='function'){
      return Promise.resolve().then(function(){
        var raw=bridge.fetchText(STOCK_MANIFEST_URL);
        if (!raw) throw new Error('bridge stock manifest fetch empty');
        return { manifest: JSON.parse(raw), rawText: raw };
      });
    }
    if (!fetchFn) return Promise.reject(new Error('no fetch available'));
    var url=STOCK_MANIFEST_URL+'?cb='+nowFn();
    return fetchFn(url, {cache:'no-store'}).then(function(r){
      if (!r || !r.ok) throw new Error('stock manifest HTTP '+(r && r.status));
      return r.text();
    }).then(function(text){
      return { manifest: JSON.parse(text), rawText: text };
    });
  }
  function fetchBundledManifest(){
    if (!fetchFn) return Promise.resolve(null);
    return fetchFn(STOCK_MANIFEST_NAME+'?cb='+nowFn(), {cache:'no-store'}).then(function(r){
      if (!r || !r.ok) return null;
      return r.text();
    }).then(function(text){
      if (!text) return null;
      try{ return JSON.parse(text); }catch(e){ return null; }
    }).catch(function(){ return null; });
  }

  /* ----- streaming body reader with an inactivity watchdog -----
     mapdelivery's reader, generalized unchanged: reads a fetch
     Response's body as text, reporting (received, total) progress per
     chunk; the watchdog fires only after DOWNLOAD_IDLE_MS with no
     bytes arriving. Falls back to r.text() when streaming reads are
     unavailable (older engines, harness stubs). */
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

  /* ----- one changed file, downloaded into the shared local store -----
     Browser mode only (bridge mode never downloads — see OWNERSHIP):
     network fetch -> sha256 integrity check -> Cache Storage, under
     the same published-URL key mapdelivery uses. */
  function downloadOne(entry, batch){
    if (!fetchFn) return Promise.reject(new Error('no fetch available'));
    var url=entryUrl(entry);
    return fetchFn(url+(url.indexOf('?')===-1?'?':'&')+'cb='+nowFn(), {cache:'no-store'})
      .then(function(r){
        if (!r || !r.ok) throw new Error('HTTP '+(r && r.status)+' for '+entry.name);
        return readBodyText(r, function(received, total){
          if (progressFn){ try{ progressFn(entry.name, received, total); }catch(e){} }
          if (progressTotalFn && batch){
            try{ progressTotalFn(batch.doneBytes+received, batch.totalBytes, entry.name); }catch(e){}
          }
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
            return text.length;
          });
      });
  }

  /* ----- THE STARTUP CHECK (the generalized discipline) -----
     localHint: the local copy's stock manifest when the caller already
     has it. The stored record wins when present — it is the record of
     the last applied/confirmed state; otherwise the bundled manifest
     shipped beside this code is the baseline.
     Resolves (never rejects) — see the header for the statuses. */
  function runStartupCheck(localHint){
    var bridge=nativeBridge();
    var baselineP=localHint ? Promise.resolve(localHint)
      : (readStoredRecord() ? Promise.resolve(readStoredRecord()) : fetchBundledManifest());
    return baselineP.then(function(localM){
      if (!localM){
        log('no local stock manifest baseline — running local copy as-is.');
        return { status:'no-baseline', from:'', to:'', downloads:[], delegated:[], uncovered:[], bytes:0 };
      }
      var localVer=stockVersion(localM);
      return fetchRemoteManifest(bridge).then(function(remote){
        var remoteM=remote.manifest;
        var remoteVer=stockVersion(remoteM);
        if (!remoteVer) throw new Error('published stock manifest has no stock_version');
        var plan=planDownloads(localM, remoteM);
        /* Classify the plan by ownership and cover (see OWNERSHIP):
           map area -> delegated to mapdelivery; fetch-covered files in
           stock-owned areas -> downloadable here (browser only);
           everything else -> uncovered, reported not downloaded. */
        var delegated=[], covered=[], uncovered=[];
        for (var i=0;i<plan.changed.length;i++){
          var e=plan.changed[i];
          var area=areaById(e.area);
          if (area && area.owner==='mapdelivery') delegated.push(e.name);
          else if (!bridge && isFetchCovered(e.name)) covered.push(e);
          else uncovered.push(e.name);
        }
        /* A newly published stock version is NEWS, once: log it and
           send it through the report hook, so an update never arrives
           silently — then remember we said it. */
        if (remoteVer!==readSeenVersion()){
          report('stock-update-published',
                 'stock v'+(localVer||'?')+' -> v'+remoteVer+': '+plan.changed.length+
                 ' file(s) changed ('+plan.totalBytes+' bytes) — map: '+delegated.length+
                 ' delegated, downloadable here: '+covered.length+
                 ', uncovered: '+uncovered.length+'.');
          writeSeenVersion(remoteVer);
        }
        if (!plan.changed.length){
          writeStoredRecord(remoteM, remote.rawText);
          log('stock is current (v'+remoteVer+') — zero downloads.');
          return { status:'current', from:localVer, to:remoteVer, downloads:[], delegated:[], uncovered:[], bytes:0 };
        }
        log('stock v'+(localVer||'?')+' -> v'+remoteVer+': '+plan.changed.length+' file(s) changed, '+
            delegated.length+' delegated to per-area delivery, '+covered.length+' to download here'+
            (uncovered.length?(', '+uncovered.length+' uncovered in browser: '+uncovered.join(', ')):'')+'.');
        if (!covered.length){
          /* Nothing this layer may download — the record does NOT
             advance: this copy is still behind until its owners act,
             and the plan stays visible in every result. */
          return { status:'update-available', from:localVer, to:remoteVer, downloads:[],
                   delegated:delegated, uncovered:uncovered, bytes:0, totalBytes:plan.totalBytes };
        }
        /* Sequential downloads (the game's own pattern): one at a
           time, so a phone on a slow connection is never flooded, and
           the first failure stops the batch with the local copy
           untouched — the record only advances when EVERY covered
           file landed, so a partial update can never be served. */
        var batch={ doneBytes:0, totalBytes:0 };
        covered.forEach(function(en){ batch.totalBytes+=en.size; });
        var downloads=[], bytes=0, chain=Promise.resolve();
        covered.forEach(function(entry){
          chain=chain.then(function(){
            return downloadOne(entry, batch).then(function(){
              downloads.push(entry.name);
              bytes+=entry.size;
              batch.doneBytes+=entry.size;
              if (progressTotalFn){ try{ progressTotalFn(batch.doneBytes, batch.totalBytes, entry.name); }catch(e){} }
            });
          });
        });
        return chain.then(function(){
          writeStoredRecord(remoteM, remote.rawText);
          log('stock updated to v'+remoteVer+' ('+downloads.length+' file(s), '+bytes+' bytes) — running local store.');
          return { status:'updated', from:localVer, to:remoteVer, downloads:downloads,
                   delegated:delegated, uncovered:uncovered, bytes:bytes, totalBytes:plan.totalBytes };
        });
      }).catch(function(err){
        /* FAIL-OPEN, never silent: offline, a bad manifest, or a
           failed download all land here. The local copy is untouched;
           play proceeds. A manifest-fetch failure is the ordinary
           offline case (logged only); anything else is a defect and
           is reported as well. */
        var msg=String((err && err.message) || err);
        var offline=/HTTP|fetch|bridge stock manifest|no fetch/.test(msg);
        if (offline){
          log('check did not complete ('+msg+') — running local copy.');
        } else {
          report('stock-check-failed', msg+' — running local copy, will retry next launch.');
        }
        return { status: offline ? 'offline' : 'failed',
                 from:localVer, to:'', downloads:[], delegated:[], uncovered:[], bytes:0, error:msg };
      });
    }).catch(function(err){
      /* The baseline path itself failed (a broken local manifest):
         still fail-open, still logged — and reported, because a
         broken local baseline is a defect, not weather. */
      var msg=String((err && err.message) || err);
      report('stock-baseline-failed', msg+' — running local copy.');
      return { status:'failed', from:'', to:'', downloads:[], delegated:[], uncovered:[], bytes:0, error:msg };
    });
  }

  /* ----- serving: read any stock file back from the shared store -----
     Returns the cached text for a manifest-named file, or null when
     the store has nothing (the caller then does its normal fetch).
     One cache serves both modules: files mapdelivery stored (zone
     data) and files this module stored (stock data) alike.
     In bridge mode always null: the native interceptor serves updated
     files; a JS-side cache would only duplicate it. */
  function serveText(name){
    if (nativeBridge()) return Promise.resolve(null);
    if (!name) return Promise.resolve(null);
    return cacheGetText(name);
  }

  /* Warm the store with bytes a loader already fetched from the
     network. Only fetch-covered names are stored. INTEGRITY: the same
     discipline downloadOne() applies — when the manifest on record
     (or the bundled manifest) carries a sha256 for this file and a
     sha function is available, the text must match it or the store is
     refused and the refusal is logged. A refusal costs nothing; a
     poisoned entry would be served on every launch. */
  var bundledCache=null;
  function remember(name, text){
    if (nativeBridge()) return Promise.resolve(false);
    if (!name || !isFetchCovered(name) || typeof text!=='string') return Promise.resolve(false);
    var record=readStoredRecord();
    var entry=findStockEntry(record, name) || findStockEntry(bundledCache, name);
    var want=entrySha(entry);
    if (want && sha256Hex){
      return Promise.resolve(sha256Hex(text)).then(function(h){
        if (h && h!==want){
          log('remember refused '+name+': sha256 does not match the stock manifest.');
          return false;
        }
        return cachePut(name, text);
      }).catch(function(){ return false; });
    }
    if (!record && !bundledCache){
      return fetchBundledManifest().then(function(m){
        bundledCache=m;
        var e2=findStockEntry(m, name);
        var w2=entrySha(e2);
        if (w2 && sha256Hex){
          return Promise.resolve(sha256Hex(text)).then(function(h){
            if (h && h!==w2){
              log('remember refused '+name+': sha256 does not match the stock manifest.');
              return false;
            }
            return cachePut(name, text);
          }).catch(function(){ return false; });
        }
        return cachePut(name, text);
      });
    }
    return cachePut(name, text);
  }

  return {
    runStartupCheck: runStartupCheck,
    serveText: serveText,
    remember: remember,
    planDownloads: planDownloads,
    isFetchCovered: isFetchCovered,
    readStoredRecord: readStoredRecord,
    PUBLISHED_BASE: PUBLISHED_BASE,
    CACHE_NAME: CACHE_NAME,
    AREAS: AREAS
  };
}

/* ---------------- browser default instance ----------------
   Built from the real window globals. sha256Hex uses SubtleCrypto
   when available (secure contexts: https Pages + the APK's file://
   WebView); when it is not, integrity verification is skipped — the
   manifest diff and the record discipline still apply. */
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
  planDownloads: planDownloads,
  isFetchCovered: isFetchCovered,
  PUBLISHED_BASE: PUBLISHED_BASE,
  STOCK_MANIFEST_URL: STOCK_MANIFEST_URL,
  CACHE_NAME: CACHE_NAME,
  AREAS: AREAS
};

if (typeof window!=='undefined'){
  /* Defect reports: console always; the game's report hook
     (GitHubReports.queue / Report.note) when it exists. The hook's
     own module may load after this one, so an undeliverable report is
     kept and retried once shortly after launch — best effort, and the
     console line is never lost either way. */
  var pendingReports=[];
  function deliverReport(kind, details){
    var delivered=false;
    try{
      if (window.GitHubReports && typeof GitHubReports.queue==='function'){
        GitHubReports.queue('stock-delivery', { kind:kind, details:String(details || '') });
        delivered=true;
      }
    }catch(e){}
    try{
      if (window.Report && typeof Report.note==='function'){
        Report.note('[STOCKDELIVERY] '+kind+(details ? ' — '+details : ''));
        delivered=true;
      }
    }catch(e){}
    return delivered;
  }
  function reportHook(kind, details){
    try{ console.warn('[STOCKDELIVERY] '+kind+(details ? ' — '+details : '')); }catch(e){}
    if (!deliverReport(kind, details)){
      pendingReports.push({ kind:kind, details:details });
      setTimeout(function(){
        var retry=pendingReports.splice(0, pendingReports.length);
        for (var i=0;i<retry.length;i++) deliverReport(retry[i].kind, retry[i].details);
      }, 15000);
    }
  }
  var defaultInstance=create({
    fetch: (typeof window.fetch==='function') ? window.fetch.bind(window) : null,
    caches: (typeof window.caches!=='undefined') ? window.caches : null,
    storage: (function(){ try{ return window.localStorage; }catch(e){ return null; } })(),
    bridge: function(){ try{ return window.MapDownload || null; }catch(e){ return null; } },
    sha256Hex: browserSha256Hex,
    now: function(){ return Date.now(); },
    log: function(m){ try{ console.log(m); }catch(e){} },
    report: reportHook,
    /* Progress -> window.__STOCKDELIVERY_PROGRESS, the readout the
       load screen can render as MB: per-file (received/total) plus the
       whole batch's bytes done/total. Available, never gating. */
    progress: function(name, received, total){
      try{
        var p=window.__STOCKDELIVERY_PROGRESS || (window.__STOCKDELIVERY_PROGRESS={});
        p.file=name; p.fileReceived=received; p.fileTotal=total;
      }catch(e){}
    },
    progressTotal: function(doneBytes, totalBytes, name){
      try{
        var p=window.__STOCKDELIVERY_PROGRESS || (window.__STOCKDELIVERY_PROGRESS={});
        p.file=name; p.bytesDone=doneBytes; p.bytesTotal=totalBytes;
      }catch(e){}
    }
  });
  api.runStartupCheck=defaultInstance.runStartupCheck;
  api.serveText=defaultInstance.serveText;
  api.remember=defaultInstance.remember;
  api.readStoredRecord=defaultInstance.readStoredRecord;
  window.StockDelivery=api;
}

/* Node (verification harness): export the factory without a window. */
if (typeof module!=='undefined' && module.exports){ module.exports=api; }

})();
