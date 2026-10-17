/* ============================================================================
 * stayawake.js — v1.0 — "Surviving Adamsville"
 * ----------------------------------------------------------------------------
 * STAY AWAKE / STAY IN FOREGROUND — lets Joshua leave the game running
 * overnight so the NPC crews (road, infra, code enforcement, survey cars,
 * drones, helicopters) keep working the Adamsville priority zone while he
 * sleeps. Two layers:
 *
 *   Layer 1 — WEB (this module, live immediately):
 *     Uses the Wake Lock API (navigator.wakeLock.request('screen')) to stop
 *     the phone/tablet screen from timing out. Works in mobile Chrome and
 *     in the APK's WebView (Chromium-based). Toggle lives in the
 *     Administrator section of the Settings panel. Default OFF.
 *
 *   Layer 2 — NATIVE (APK rebuild required):
 *     StayAwakeService.java (foreground service, "Surviving Adamsville —
 *     crews working overnight" notification) + StayAwakeBridge.java
 *     (JavaScript bridge). Keeps Android from killing/throttling the app
 *     even if the screen does turn off, and can hold FLAG_KEEP_SCREEN_ON
 *     as a bulletproof native fallback for the wake lock. This module calls
 *     the bridge when present (window.StayAwakeBridge) and degrades
 *     gracefully to pure Wake Lock API on plain web.
 *
 * Behavior notes:
 *  - The Wake Lock spec auto-releases the lock when the document is hidden
 *    (tab switch, screen off via power button, etc.). We re-request on
 *    every visibilitychange -> visible while the toggle is ON.
 *  - Some browsers fire a 'release' event on the sentinel spontaneously
 *    (battery saver, etc.). We re-request there too, while ON + visible.
 *  - Toggle state persists in localStorage['sa_stayawake_v1'] so a reload
 *    keeps Joshua's choice; the lock itself is re-requested on boot if ON.
 *  - A small on-screen badge (#stayawake-badge) shows while the lock or
 *    the native service is active, so Joshua can see at a glance that
 *    overnight mode is engaged.
 *  - Everything is try/catch guarded — a missing Wake Lock API or a
 *    denied request must never break the game.
 *
 * Public API: window.STAYAWAKE = { isOn(), setOn(bool), isLocked(),
 *   nativeActive(), toggle() }
 * ========================================================================== */
(function(){
  'use strict';
  /* Single-instance guard: never double-init (hot-reload safe). */
  if (window.STAYAWAKE && window.STAYAWAKE.__v === 1) return;

  /* ---------- tiny localStorage helpers (guarded) ---------- */
  var LS_KEY = 'sa_stayawake_v1';
  function lsGet(k){ try{ return window.localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k,v){ try{ window.localStorage.setItem(k,v); }catch(e){} }

  /* ---------- state ---------- */
  var wantOn = (lsGet(LS_KEY) === '1');   /* Joshua's toggle choice, default OFF */
  var sentinel = null;                    /* WakeLockSentinel while held, else null */
  var nativeOn = false;                   /* true while the native foreground service runs */
  var badgeEl = null;

  /* ---------- native bridge (APK only) ---------- */
  function bridge(){
    try{ return (typeof window.StayAwakeBridge !== 'undefined') ? window.StayAwakeBridge : null; }
    catch(e){ return null; }
  }

  /* ---------- badge ---------- */
  function ensureBadge(){
    if (badgeEl) return badgeEl;
    try{
      var b = document.createElement('div');
      b.id = 'stayawake-badge';
      b.textContent = '\uD83D\uDD12 AWAKE';  /* 🔒 AWAKE */
      b.style.cssText = 'position:fixed;top:64px;right:10px;z-index:65;'
        + 'background:rgba(20,40,20,.85);color:#8f8;font-size:11px;font-weight:bold;'
        + 'padding:4px 8px;border:1px solid #484;border-radius:12px;display:none;'
        + 'pointer-events:none;';
      document.body.appendChild(b);
      badgeEl = b;
    }catch(e){}
    return badgeEl;
  }
  function paintBadge(){
    var b = ensureBadge(); if(!b) return;
    try{ b.style.display = (isLocked() || nativeOn) ? 'block' : 'none'; }catch(e){}
  }

  /* ---------- admin button label ---------- */
  function paintButton(){
    try{
      var btn = document.getElementById('adm-stayawake');
      if(!btn) return;
      var wl = ('wakeLock' in navigator);
      var br = !!bridge();
      var suffix = '';
      if(!wl && !br) suffix = ' (unavailable)';
      else if(!wl && br) suffix = ' (native)';
      btn.textContent = 'Stay Awake: ' + (wantOn ? 'ON' : 'OFF') + suffix;
    }catch(e){}
  }

  /* ---------- wake lock core ---------- */
  function requestLock(){
    /* Returns a Promise<boolean>. Never throws. */
    try{
      if(!('wakeLock' in navigator)) return Promise.resolve(false);
      if(sentinel) return Promise.resolve(true);  /* already held */
      return navigator.wakeLock.request('screen').then(function(s){
        sentinel = s;
        try{
          /* If the OS releases it out from under us, try to get it back
             while the toggle is still ON and the page is visible. */
          sentinel.addEventListener('release', function(){
            sentinel = null;
            paintBadge();
            if(wantOn && !document.hidden){
              setTimeout(function(){ if(wantOn && !document.hidden) requestLock().then(paintBadge); }, 800);
            }
          });
        }catch(e){}
        paintBadge();
        return true;
      }).catch(function(err){
        /* Denied (battery saver, no gesture yet, etc.) — plain-words log. */
        try{ diag('Stay Awake: screen lock request denied (' + String(err && err.name || err) + ').'); }catch(e){}
        sentinel = null;
        paintBadge();
        return false;
      });
    }catch(e){ return Promise.resolve(false); }
  }
  function releaseLock(){
    try{
      if(sentinel){
        var s = sentinel; sentinel = null;
        /* release() returns a promise; ignore failures. */
        try{ var p = s.release(); if(p && p.catch) p.catch(function(){}); }catch(e){}
      }
    }catch(e){}
    paintBadge();
  }

  /* ---------- native foreground service ---------- */
  function nativeStart(){
    var br = bridge(); if(!br) return;
    try{ br.setKeepScreenOn(true); }catch(e){}
    try{ br.startForeground(); nativeOn = true; }catch(e){}
    paintBadge();
  }
  function nativeStop(){
    var br = bridge(); if(!br){ nativeOn = false; paintBadge(); return; }
    try{ br.setKeepScreenOn(false); }catch(e){}
    try{ br.stopForeground(); }catch(e){}
    nativeOn = false;
    paintBadge();
  }

  /* ---------- public control ---------- */
  function applyState(){
    if(wantOn){
      if(!document.hidden){ requestLock().then(paintBadge); }
      nativeStart();
    }else{
      releaseLock();
      nativeStop();
    }
    paintButton();
    paintBadge();
  }
  function setOn(on){
    wantOn = !!on;
    lsSet(LS_KEY, wantOn ? '1' : '0');
    applyState();
    try{ diag('Stay Awake ' + (wantOn ? 'ENABLED — screen will stay on; crews keep working overnight.' : 'disabled.')); }catch(e){}
  }
  function isOn(){ return wantOn; }
  function isLocked(){ return !!sentinel; }
  function isNativeActive(){ return nativeOn; }
  function toggle(){ setOn(!wantOn); }

  /* ---------- admin wiring ---------- */
  function diag(msg){
    /* Mirror to the admin diagnostics box if present (same as other systems). */
    try{
      var el = document.getElementById('adm-diag');
      if(el){ el.textContent += (el.textContent ? '\n' : '') + msg; }
    }catch(e){}
  }
  function wireAdmin(){
    try{
      var btn = document.getElementById('adm-stayawake');
      if(btn && !btn.__saWired){
        btn.__saWired = true;
        btn.addEventListener('click', function(){ toggle(); });
      }
    }catch(e){}
    paintButton();
  }

  /* ---------- visibility handling ----------
     Wake locks die when the page hides. Re-request when visible again
     (only if Joshua left the toggle ON). The native service, once
     started, survives on its own — no re-start needed here. */
  function onVis(){
    try{
      if(!document.hidden && wantOn){ requestLock().then(paintBadge); }
    }catch(e){}
  }

  /* ---------- boot ---------- */
  function boot(){
    try{
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('focus', onVis);
    }catch(e){}
    /* Re-poll for the admin button: the settings panel markup is static,
       but hotreload.js taught us late wiring is cheap insurance. */
    var tries = 0;
    var poll = setInterval(function(){
      try{
        tries++;
        if(document.getElementById('adm-stayawake') || tries > 40){
          clearInterval(poll);
          wireAdmin();
        }
      }catch(e){ clearInterval(poll); }
    }, 500);
    wireAdmin();
    /* If Joshua left it ON across a reload, re-engage. */
    if(wantOn){
      setTimeout(function(){ if(wantOn && !document.hidden) requestLock().then(paintBadge); }, 2500);
      /* Native side re-engages too (harmless if the APK is already gone). */
      setTimeout(function(){ if(wantOn) nativeStart(); }, 3000);
    }
    paintBadge();
  }

  window.STAYAWAKE = {
    __v: 1,
    isOn: isOn, setOn: setOn, toggle: toggle,
    isLocked: isLocked, nativeActive: isNativeActive
  };

  if(document.readyState === 'complete' || document.readyState === 'interactive'){
    setTimeout(boot, 1200);
  }else{
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(boot, 1200); });
  }
})();
