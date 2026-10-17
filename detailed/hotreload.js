/* ============================================================================
   HOTRELOAD v1.0 (2026-10-09) — LIVE UI UPDATE MANAGER
   ----------------------------------------------------------------------------
   Joshua's directive: "If it's able to apply changes retroactively instead of
   restarting the page, let's do that instead. Still keep it in the
   administrative panel." + a visual "Updating..." flash at the bottom.

   WHAT IT DOES
   - Watches the UI artifact channel (ui-manifest.json / ui_version). When a
     newer ui_version is detected mid-session, it diffs the REMOTE manifest
     against the manifest this page BOOTED with (stashed at boot) to learn
     exactly WHICH files changed.
   - TWO application paths:
     (A) TRUE LIVE SWAP — for files verified safe to re-execute in place.
         Re-fetches each changed file (cache-busted) and runs it through a
         fresh <script> element. No reload, no lost session. The game keeps
         running; only the swapped file's globals are refreshed.
     (B) SESSION-PRESERVING APPLY — for everything else (index.html itself
         and all logic modules, which are IIFEs with boot-poll timers that
         would double-initialize if re-executed). Saves the session with the
         game's own saveSlot(), flashes "Updating...", reloads the page, and
         auto-restores the save on boot — Joshua ends up exactly where he
         was (same spot, same camera, same driving state). From his side it
         looks and feels like a retroactive update: no manual restart, no
         lost progress.
   - MAP / VEHICLES / MUSIC channels are NOT touched — map keeps Joshua's
     standing "applies on new game, never hot-swap a running world" rule.
   - On the APK (native AssetDownload bridge present) hot reload is DISABLED
     by design: the WebView loads scripts from staged app storage, not HTTP,
     so a fetch-and-swap would diverge from what the bridge staged. The APK
     keeps the existing download → "restart needed" flow.

   WHY (B) EXISTS — the honest engineering constraint
   Every *_system.js module is a self-contained IIFE that boot-polls for
   (THREE, scene, player, animate) and then WRAPS the global animate().
   Re-executing one would start a second boot timer, build a second set of
   meshes, and wrap animate() a second time — the game would visibly break
   (double speed, duplicated objects). index.html itself (HUD markup, CSS,
   and the three inline script blocks holding the whole game) cannot be
   swapped without a document reload, period. So (B) is the path that fires
   for ~every real push, and it is built to be indistinguishable from a
   live update from Joshua's point of view.

   LIVE-SAFE ALLOWLIST (path A)
   Files verified by inspection to be re-execution safe: pure data
   assignments or stateless API re-assignment, with ZERO timers, listeners,
   or animate() wraps. Re-running them just refreshes globals.
     - marta_data.js      : var MARTA_DATA = {...}            (pure data)
     - marta_bus_data.js  : var MARTA_BUS_DATA = {...}        (pure data)
     - shirt_designs.js   : window.ShirtDesigns = {...}       (stateless API)
     - sign_rules.js      : window.SignRules = (function(){...})() (stateless)
   Caveat (documented, not hidden): consumers that captured the OLD global
   in a closure keep using it until reload; consumers that read the global
   lazily see the new data immediately. Nothing breaks either way.

   ADMIN PANEL (settings → Administrator)
   - "Live UI updates: ON/OFF"  — master toggle (localStorage sa_hr_auto,
     default ON). OFF restores the old behavior (red dot → manual restart).
   - "Check for updates now"    — forces an immediate manifest comparison.
   - "Apply UI update — keep my spot" — appears only when a pending UI
     update needs path (B); runs the session-preserving apply on demand.
   - Update log (#adm-hrlog)    — timestamped entries, last 8 kept.

   STATE KEYS (localStorage)
   - sa_hr_auto          "1"/"0"   master toggle
   - sa_ui_manifest_boot JSON     manifest this session booted with
   - sa_hr_restore       "1"      set before an (B)-path reload; consumed
                                  on boot by HR.maybeRestore()
   The temporary save itself lives in the game's normal slot system as
   'sa_save_hr_update' (invisible in the slot UI, which only lists 1-3).

   INTEGRATION POINTS (index.html)
   - ASSETVER.checkPending() calls HR.onUiPending(ver, manifest) when a new
     ui_version is detected.
   - ASSETVER return table gains HR.noteApplied(type, ver) so a successful
     live swap clears the pending flag / red dot like a normal apply.
   - __tryStartGame() calls HR.maybeRestore() right after animate() starts.
   - Admin rows: #adm-hrauto / #adm-hrcheck / #adm-hrapply, log #adm-hrlog.

   Depends on globals: ASSETVER, showToast, saveSlot, loadSlot (all guarded).
   ============================================================================ */
(function(){
'use strict';

/* Server base — mirrors ASSETVER's BASE so a future server move is one edit
   in each place (kept separate deliberately: no cross-module coupling). */
var BASE='https://kingmarkarnold-code.github.io/adamsville-play/detailed/';

var LS_AUTO='sa_hr_auto';
var LS_BOOT='sa_ui_manifest_boot';
var LS_RESTORE='sa_hr_restore';
var SAVE_KEY='hr_update';          /* -> localStorage key 'sa_save_hr_update' */
var LOG_MAX=8;

/* Files verified (2026-10-09, by source inspection) safe to re-execute live.
   See the header for the criteria and the caveat. */
var LIVE_SAFE=['marta_data.js','marta_bus_data.js','shirt_designs.js','sign_rules.js'];

var bootManifest=null;             /* manifest this page booted with */
var handledVer=null;               /* ui_version already processed */
var apkMode=false;
var logLines=[];

/* ---------- tiny helpers ---------- */
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }
function nowT(){ try{ return new Date().toLocaleTimeString(); }catch(e){ return ''; } }

function autoOn(){
  var v=lsGet(LS_AUTO);
  return v===null ? true : v==='1';
}

/* Update log: newest first in #adm-hrlog (admin panel), mirrored to console. */
function log(msg){
  var line='['+nowT()+'] '+msg;
  logLines.unshift(line);
  if(logLines.length>LOG_MAX) logLines.length=LOG_MAX;
  try{
    var el=document.getElementById('adm-hrlog');
    if(el) el.textContent=logLines.join('\n');
  }catch(e){}
  try{ console.log('[HOTRELOAD] '+msg); }catch(e2){}
}

function setStatus(t){
  try{ var el=document.getElementById('adm-status'); if(el) el.textContent=t; }catch(e){}
}

/* The "Updating..." flash Joshua asked for — reuses the existing #toast
   flash UI (showToast), held visible with a long timeout while work runs. */
function flashUpdating(msg){
  try{ if(typeof showToast==='function') showToast(msg||'Updating…', 30000); }catch(e){}
}
function flashDone(msg){
  try{ if(typeof showToast==='function') showToast(msg||'UI updated ✓', 2600); }catch(e){}
}

function showApplyBtn(show){
  try{
    var b=document.getElementById('adm-hrapply');
    if(b) b.style.display=show?'':'none';
  }catch(e){}
}

function refreshTags(){
  try{ if(typeof ASSETVER!=='undefined'){ ASSETVER.updateGearBadge(); ASSETVER.refreshAdmTags(); } }catch(e){}
}

/* ---------- manifest diff ---------- */
/* Returns the file names whose sha256 differs between the boot manifest and
   the remote manifest (or that are new in the remote). */
function diffManifests(oldM, newM){
  var o={}, n={}, out=[], k;
  try{
    var of=(oldM&&oldM.files)||[], nf=(newM&&newM.files)||[];
    for(var i=0;i<of.length;i++) o[of[i].name]=of[i].sha256;
    for(var j=0;j<nf.length;j++) n[nf[j].name]=nf[j].sha256;
    for(k in n){ if(o[k]!==n[k]) out.push(k); }
  }catch(e){}
  return out;
}

/* ---------- path (A): true live swap ---------- */
function doLiveSwap(files, ver){
  flashUpdating('Updating UI…');
  log('Hot-swapping '+files.length+' file(s)…');
  var i=0;
  (function next(){
    if(i>=files.length){ finishLiveSwap(ver, files); return; }
    var name=files[i++];
    var url=BASE+name+'?v='+encodeURIComponent(ver);
    fetch(url,{cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.text();
    }).then(function(txt){
      /* Fresh classic <script>: runs in global scope exactly like the
         original tag. Element removed right after execution. */
      var s=document.createElement('script');
      s.textContent=txt;
      document.head.appendChild(s);
      document.head.removeChild(s);
      log('\u2713 '+name+' swapped live');
      next();
    }).catch(function(err){
      /* A failed swap must never half-apply: fall back to path (B). */
      log('\u2717 '+name+' failed ('+String(err&&err.message||err)+') — use reload path');
      flashDone('Update needs reload');
      showApplyBtn(true);
      refreshTags();
    });
  })();
}

function finishLiveSwap(ver, files){
  /* Tell ASSETVER the UI channel is now current: clears pending['ui'],
     persists the version, clears the red dot. */
  try{
    if(typeof ASSETVER!=='undefined' && ASSETVER.noteApplied) ASSETVER.noteApplied('ui', ver);
    else refreshTags();
  }catch(e){ refreshTags(); }
  try{ lsSet('sa_asset_version_ui', ver); }catch(e){}
  showApplyBtn(false);
  flashDone('UI updated \u2713');
  log('Live swap complete ('+files.join(', ')+') — no reload needed.');
  setStatus('UI updated \u2713 — no reload needed.');
}

/* ---------- path (B): session-preserving apply ---------- */
/* Saves the session with the game's own saveSlot(), reloads, and restores
   on boot via maybeRestore(). Joshua keeps his exact spot. */
function applyWithRestore(){
  flashUpdating('Updating…');
  log('Saving session before apply…');
  var ok=false;
  try{ ok=(typeof saveSlot==='function') ? !!saveSlot(SAVE_KEY) : false; }catch(e){ ok=false; }
  lsSet(LS_RESTORE,'1');
  log(ok ? 'Session saved — reloading to apply update…'
         : 'Save unavailable — reloading anyway (fresh spawn)…');
  setStatus('Updating… reloading.');
  setTimeout(function(){ try{ location.reload(); }catch(e){} }, 900);
}

/* Called from __tryStartGame() right after animate() starts. If the previous
   page set the restore flag, load the temp save and clean up. */
function maybeRestore(){
  var flag=null;
  try{ flag=lsGet(LS_RESTORE); }catch(e){}
  if(flag!=='1') return;
  lsDel(LS_RESTORE);
  var ok=false;
  try{ ok=(typeof loadSlot==='function') ? !!loadSlot(SAVE_KEY) : false; }catch(e){ ok=false; }
  try{ lsDel('sa_save_'+SAVE_KEY); }catch(e){}
  showApplyBtn(false);
  if(ok){
    flashDone('Update applied — welcome back \u2713');
    log('Session restored after update — same spot, same state.');
  }else{
    flashDone('Update applied');
    log('Restore failed — started fresh (old save format?).');
  }
  refreshTags();
}

/* ---------- entry points ---------- */
/* Called by ASSETVER.checkPending() when a newer ui_version is detected.
   remoteManifest is the freshly-fetched manifest (no second fetch needed). */
function onUiPending(ver, remoteManifest){
  if(handledVer===ver) return;
  handledVer=ver;
  if(apkMode){
    log('UI v'+ver+' available — APK uses the restart flow (hot reload web-only).');
    return;
  }
  var active=null;
  try{ active=ASSETVER.getActive('ui'); }catch(e){}
  var oldM=bootManifest;
  if(!oldM || !remoteManifest){
    log('UI v'+ver+' pending — manifest unavailable; restart to apply.');
    showApplyBtn(true);
    return;
  }
  var changed=diffManifests(oldM, remoteManifest);
  var cl=changed.length?(' ('+changed.join(', ')+')'):'';
  log('UI v'+active+' \u2192 v'+ver+': '+changed.length+' file(s) changed'+cl);
  if(changed.length===0){
    /* Version bumped but no file changed — just record it. */
    try{ if(typeof ASSETVER!=='undefined'&&ASSETVER.noteApplied) ASSETVER.noteApplied('ui', ver); }catch(e){}
    log('No file changes — version recorded, nothing to apply.');
    return;
  }
  var reloadNeeded=changed.filter(function(f){ return LIVE_SAFE.indexOf(f)<0; });
  if(reloadNeeded.length===0 && autoOn()){
    doLiveSwap(changed, ver);
  }else{
    if(reloadNeeded.length===0 && !autoOn())
      log('Live swap available but auto-update is OFF — waiting for manual apply.');
    else
      log('Needs reload path: '+reloadNeeded.join(', '));
    showApplyBtn(true);
    refreshTags();
    setStatus('UI update ready — Apply it from the Administrator panel (keeps your spot).');
  }
}

/* Manual "Check for updates now" — forces a manifest comparison outside the
   2-minute timer. */
function checkNow(){
  setStatus('Checking for updates…');
  fetch(BASE+'ui-manifest.json',{cache:'no-store'}).then(function(r){
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  }).then(function(m){
    var rv=m.ui_version||m.version||'';
    var active=null;
    try{ active=ASSETVER.getActive('ui'); }catch(e){}
    if(rv && active && rv!==active && rv!=='unknown'){
      log('Manual check: UI v'+active+' \u2192 v'+rv+' found.');
      onUiPending(rv, m);
    }else{
      log('Manual check: UI up to date (v'+active+').');
      setStatus('UI is up to date.');
    }
  }).catch(function(err){
    setStatus('UI check failed — no connection.');
    log('Manual check failed: '+String(err&&err.message||err));
  });
}

/* ---------- admin wiring ---------- */
function wireAdmin(){
  try{
    var autoBtn=document.getElementById('adm-hrauto');
    if(autoBtn){
      var paint=function(){
        autoBtn.textContent='Live UI updates: '+(autoOn()?'ON':'OFF');
      };
      paint();
      autoBtn.addEventListener('click', function(){
        lsSet(LS_AUTO, autoOn()?'0':'1');
        paint();
        log('Live UI updates '+(autoOn()?'ENABLED':'DISABLED')+'.');
      });
    }
    var chk=document.getElementById('adm-hrcheck');
    if(chk) chk.addEventListener('click', function(){
      try{ if(typeof ASSETVER!=='undefined') ASSETVER.checkPending(); }catch(e){}
      setTimeout(checkNow, 1200);
    });
    var ap=document.getElementById('adm-hrapply');
    if(ap) ap.addEventListener('click', function(){ applyWithRestore(); });
  }catch(e){}
}

/* ---------- boot ---------- */
function boot(){
  try{ apkMode=!!window.AssetDownload; }catch(e){ apkMode=false; }
  /* Stash the manifest this page booted with — the diff baseline.
     Falls back to the last stashed copy if the fetch fails. */
  try{
    fetch('ui-manifest.json',{cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(m){
      bootManifest=m;
      try{ lsSet(LS_BOOT, JSON.stringify(m)); }catch(e){}
    }).catch(function(){
      try{ var raw=lsGet(LS_BOOT); if(raw) bootManifest=JSON.parse(raw); }catch(e){}
    });
  }catch(e){}
  wireAdmin();
  log(apkMode ? 'APK bridge detected — hot reload disabled, restart flow applies.'
              : 'Hot reload ready (live-swap: '+LIVE_SAFE.join(', ')+').');
}

if(document.readyState==='complete'||document.readyState==='interactive'){ setTimeout(boot,1500); }
else{ document.addEventListener('DOMContentLoaded', function(){ setTimeout(boot,1500); }); }

/* Public API — called from ASSETVER.checkPending, __tryStartGame, admin. */
window.HR={
  onUiPending:onUiPending,
  checkNow:checkNow,
  applyWithRestore:applyWithRestore,
  maybeRestore:maybeRestore,
  autoOn:autoOn,
  log:log
};
})();
