/* ============================================================================
   UI SOUNDS v1.0 (2026-10-11) — procedural interface audio for
   Surviving Adamsville.
   Expert report #39 (Michael Torres, Audio Engineer — Joshua approved
   "Fix 39"): the game had zero UI sound effects. Button taps, menu
   opens, notifications — all silent.

   DESIGN (Joshua's rules honored):
     - 100% PROCEDURAL via the Web Audio API. Zero audio files, zero
       downloads — nothing to cache-bust, nothing to weigh down the TCL.
     - SHARED AudioContext (window.__audioCtx) — adopts the context from
       engine_sounds.js/ambient_audio.js if present, creates and publishes
       it otherwise. One context for all game audio (BUG FIX #4, 2026-10-11:
       was a separate third context — wasteful on mobile).
       Created on first user gesture (browser autoplay policy).
     - All sounds are short synthesized blips: oscillator + gain envelope.
       Total CPU per sound: ~50ms of one oscillator. Negligible.
     - Respects the game's mute: if music is muted (sa_music_muted), UI
       sounds stay silent too. Separate toggle in Settings
       (UI sounds: ON/OFF, persisted as sa_ui_sounds).

   SOUNDS:
     tap()      — button press: short 800Hz square blip, 60ms
     open()     — menu open: rising two-tone (440→660Hz), 120ms
     close()    — menu close: falling two-tone (660→440Hz), 120ms
     notify()   — notification/toast: gentle chime (880Hz sine + harmonic)
     action()   — action button (ENTER CAR etc.): confident confirm blip
     error()    — error/denied: low buzz (180Hz sawtooth), 150ms

   USAGE: window.UISounds.tap() etc. All functions no-op safely if the
   AudioContext isn't ready or sounds are muted.
   ============================================================================ */
(function uiSounds(){
'use strict';

/* ---------------- state ---------------- */
var ctx = null;              /* lazy AudioContext */
var uiMuted = false;         /* own Settings toggle */
try{ uiMuted = localStorage.getItem('sa_ui_muted') === '1'; }catch(e){}

/* ---------------- context ---------------- */
/* ensureCtx() — build the AudioContext on first user gesture.
   Browsers block AudioContext before a gesture. Safe to call repeatedly.
   BUG FIX #4 (Team 3 audit 2026-10-11, Joshua approved): use the SHARED
   AudioContext (window.__audioCtx) instead of creating a third one.
   engine_sounds.js and ambient_audio.js already share one context — three
   live contexts on mobile = memory/GC pressure + browser context caps.
   Adopt-or-create pattern: use the shared one if it exists and isn't
   closed, otherwise create it and publish it for others. */
function ensureCtx(){
  if (ctx){
    try{ if (ctx.state === 'suspended') ctx.resume(); }catch(e){}
    return true;
  }
  try{
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (window.__audioCtx && window.__audioCtx.state !== 'closed'){
      ctx = window.__audioCtx;
    } else {
      ctx = new AC();
      window.__audioCtx = ctx;
    }
    hookGestures();
    return true;
  }catch(e){ return false; }
}

/* Keep the context resumed: mobile browsers love to re-suspend it. */
var _gestureHooked = false;
function hookGestures(){
  if (_gestureHooked) return;
  _gestureHooked = true;
  var resume = function(){
    try{ if (ctx && ctx.state === 'suspended') ctx.resume(); }catch(e){}
  };
  try{
    document.addEventListener('pointerdown', function(){ ensureCtx(); resume(); }, {passive:true});
    document.addEventListener('keydown',     function(){ ensureCtx(); resume(); });
    document.addEventListener('touchstart',  function(){ ensureCtx(); resume(); }, {passive:true});
  }catch(e){}
}

/* ---------------- mute ---------------- */
/* isMuted() — UI sounds are muted if EITHER the UI toggle is off OR the
   master music mute is on. Joshua's rule: mute means mute. */
function isMuted(){
  if (uiMuted) return true;
  try{ if (localStorage.getItem('sa_music_muted') === '1') return true; }catch(e){}
  /* Also respect the in-memory musicMuted flag if it exists (index.html). */
  try{ if (typeof musicMuted !== 'undefined' && musicMuted) return true; }catch(e){}
  return false;
}

/* ---------------- synth helper ---------------- */
/* blip(freq, dur, type, vol, slideTo) — play a single oscillator note with
   exponential decay envelope. slideTo: optional end frequency for sweeps. */
function blip(freq, dur, type, vol, slideTo){
  if (isMuted()) return;
  if (!ensureCtx()) return;
  try{
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    /* Envelope: quick attack, exponential decay. Prevents clicks. */
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol || 0.15, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }catch(e){}
}

/* ---------------- public sounds ---------------- */
var UISounds = {
  /* Button tap: short, crisp click. */
  tap: function(){ blip(800, 0.06, 'square', 0.08); },

  /* Menu open: rising two-tone. */
  open: function(){
    blip(440, 0.07, 'sine', 0.12);
    var self = this;
    setTimeout(function(){ blip(660, 0.09, 'sine', 0.12); }, 60);
  },

  /* Menu close: falling two-tone. */
  close: function(){
    blip(660, 0.07, 'sine', 0.12);
    setTimeout(function(){ blip(440, 0.09, 'sine', 0.12); }, 60);
  },

  /* Notification: gentle chime with harmonic. */
  notify: function(){
    blip(880, 0.15, 'sine', 0.10);
    setTimeout(function(){ blip(1320, 0.20, 'sine', 0.06); }, 80);
  },

  /* Action button: confident confirm. */
  action: function(){ blip(520, 0.10, 'triangle', 0.14, 780); },

  /* Error/denied: low buzz. */
  error: function(){ blip(180, 0.15, 'sawtooth', 0.10); },

  /* Toggle the UI sounds setting. Returns new state. */
  toggle: function(){
    uiMuted = !uiMuted;
    try{ localStorage.setItem('sa_ui_muted', uiMuted ? '1' : '0'); }catch(e){}
    return !uiMuted;
  },

  /* Check if UI sounds are enabled. */
  isEnabled: function(){ return !isMuted(); }
};

/* Expose globally. */
window.UISounds = UISounds;

/* Settings toggle row (wired here; lives next to Music/Engine rows). */
try{
  var _usb = document.getElementById('set-uisounds');
  if (_usb){
    var _updateUIBtn = function(){
      _usb.textContent = 'UI sounds: ' + (uiMuted ? 'OFF' : 'ON');
    };
    _updateUIBtn();
    _usb.addEventListener('click', function(){
      UISounds.toggle();
      _updateUIBtn();
      /* Play a tap to confirm the new state (only if now enabled). */
      if (!uiMuted) UISounds.tap();
    });
  }
}catch(e){}

/* Hook common UI events automatically:
   - All <button> clicks get a tap sound (unless they have data-no-sound).
   - Settings menu open/close gets open/close sounds.
   This is additive — existing click handlers are untouched. */
try{
  document.addEventListener('click', function(e){
    try{
      var t = e.target;
      /* Walk up to find the button (clicks may land on inner spans). */
      while (t && t !== document && t.tagName !== 'BUTTON') t = t.parentNode;
      if (!t || t === document) return;
      if (t.hasAttribute('data-no-sound')) return;
      /* Don't double-sound the action button (it gets action() instead). */
      if (t.id === 'action-btn'){ UISounds.action(); return; }
      UISounds.tap();
    }catch(e2){}
  }, {passive:true});

  /* Settings menu open/close. */
  var _origSettingsShow = null;
  var settingsEl = document.getElementById('settings');
  if (settingsEl){
    var obs = new MutationObserver(function(mutations){
      mutations.forEach(function(m){
        if (m.attributeName === 'class'){
          var showing = settingsEl.classList.contains('show');
          if (showing !== _origSettingsShow){
            _origSettingsShow = showing;
            if (showing) UISounds.open(); else UISounds.close();
          }
        }
      });
    });
    try{ obs.observe(settingsEl, {attributes:true}); }catch(e){}
  }
}catch(e){}

})();
