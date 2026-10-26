/* ============================================================================
   PAUSE SYSTEM v1.0 — one game pause for every deployment
   (Joshua 2026-10-17, from playing the dev build: "We need to have a pause.
   Escape on the dev version... and we need a pause for Android and web
   as well.") One source (play/detailed) serves web, dev and APK, so the
   pause is implemented ONCE here and every deployment gets it.

   WHAT PAUSE DOES:
     * Simulation time stops. animate() (index.html) checks
       window.GamePause.paused every frame: while paused it spends NO
       simTick() steps and skips the render-phase module ticks entirely
       (traffic, NPC crews, MARTA, daycycle... those systems take
       wall-clock dt, so letting them run would keep the world moving
       behind the frozen frame). The frame accumulator is zeroed, so
       resuming never fast-forwards to "catch up". The game clock,
       vehicles, NPCs, traffic, fuel — everything driven by the sim —
       simply does not advance. Rendering continues: the player stares
       at the frozen scene under the PAUSED overlay.
     * Music pauses — PAUSE, not stop: the crossfade elements
       (musicAudioA/musicAudioB in index.html) are .pause()d in place,
       so resume continues the same track at the same position. If the
       music was muted or had never started, resume restarts nothing.
     * The shared WebAudio context (engine sounds, ambient audio —
       window.__audioCtx) is suspended so no engine hum hangs frozen
       mid-note, and resumed on unpause. Only when this module
       suspended it does it resume it.

   CONTROLS:
     * ESCAPE key toggles pause on keyboard platforms. Wired with the
       same rule as the v1.67 keyboard-look block (ui.200) and
       keyboard_remap.js: TYPING IS SACRED — an Escape whose target is
       an INPUT / TEXTAREA / SELECT / contentEditable (the zone-unlock
       password box is one) is never touched. Escape also stays out of
       the way while a menu panel (settings / help / gameplay / full
       map) is open: the player is in a menu, not in gameplay. (The
       keyboard-remap capture UI keeps its own capture-phase Escape —
       it swallows the event before this bubble-phase listener ever
       sees it, exactly as before.)
     * The on-screen PAUSE BUTTON (#pause-btn, top-right, next to the
       settings gear; registered in ui_layout.json for BOTH layout
       faces) toggles pause — the guaranteed path on touch/Android,
       where there is no Escape key. While paused it shows ▶.
     * The PAUSED OVERLAY (#pause-overlay) shows the word PAUSED and a
       Resume button. The overlay's backdrop does NOT capture touches
       (pointer-events:none; only its card does), so the settings gear
       and the pause button stay reachable while paused — menu and
       settings access keep working, as they should.
     * POINTER LOCK (web): browsers reserve Escape while the pointer
       is locked — the page never receives that keydown; the lock EXIT
       is the signal. So a pointerlockchange to "no lock" during
       gameplay also pauses. (The game does not request pointer lock
       today, so this listener is inert until a future view mode uses
       it — it is wired now so Esc means pause there too, which is the
       behaviour players expect.)

   STATE SAFETY: pause touches no game state — it only declines to
   advance it. Fuel, clock, deliveries and saves are exactly as they
   were when the player returns, however long the pause lasts.

   DEPENDENCIES: none at load. Every game access (music elements,
   audio context, Report) is typeof/try guarded in the sim_core.js
   pattern, so load order can never throw.
   ============================================================================ */
(function pauseSystem(){
'use strict';

/* The one pause flag for the whole game. animate() reads
   window.GamePause.paused each frame; nothing else may write it —
   all changes go through setPaused()/toggle() so the music, the
   audio context and the overlay can never disagree with the flag. */
var paused = false;

/* Was the (audible) music element actually playing when we paused?
   Resume restarts the music ONLY if it was — a player who muted the
   music, or never started it, gets silence back, not a surprise. */
var musicWasPlaying = false;

/* True only while THIS module holds the shared WebAudio context
   suspended, so resume never "helpfully" resumes a context some
   other system suspended on purpose. */
var ctxSuspendedByUs = false;

/* ---------------------------------------------------------------------------
   Music + audio context
   ---------------------------------------------------------------------------
   The music system (index.html) crossfades between TWO Audio
   elements; `musicAudio` always points at the audible one. Pause
   BOTH (the inactive one may be mid-fade-in); resume plays only the
   active one, and only under the same conditions the game's own
   unmute path uses (started + not muted). */
function pauseAudio(){
  musicWasPlaying = false;
  try {
    var a = window.musicAudioA, b = window.musicAudioB;
    var act = window.musicAudio || a;
    if (act && !act.paused) musicWasPlaying = true;
    if (a) a.pause();
    if (b) b.pause();
  } catch(e){}
  /* Engine + ambient sounds ride the shared WebAudio context;
     suspending it freezes them along with the world. */
  try {
    var ctx = window.__audioCtx;
    if (ctx && ctx.state === 'running'){
      var p = ctx.suspend();
      if (p && p.catch) p.catch(function(){});
      ctxSuspendedByUs = true;
    }
  } catch(e){}
}

function resumeAudio(){
  try {
    var ctx = window.__audioCtx;
    if (ctxSuspendedByUs && ctx && ctx.state === 'suspended'){
      var p = ctx.resume();
      if (p && p.catch) p.catch(function(){});
    }
  } catch(e){}
  ctxSuspendedByUs = false;
  try {
    if (musicWasPlaying && window.musicStarted && !window.musicMuted){
      var act = window.musicAudio;
      if (act){ var p2 = act.play(); if (p2 && p2.catch) p2.catch(function(){}); }
    }
  } catch(e){}
  musicWasPlaying = false;
}

/* ---------------------------------------------------------------------------
   On-screen UI — the button + overlay live in index.html markup
   (HUD family, next to #music-btn); this module owns their behaviour.
   --------------------------------------------------------------------------- */
function syncUI(){
  try {
    var ov = document.getElementById('pause-overlay');
    if (ov) ov.classList.toggle('show', paused);
    var btn = document.getElementById('pause-btn');
    if (btn){
      /* ⏸ while running, ▶ while paused (tap = resume). */
      btn.innerHTML = paused ? '&#9654;' : '&#9208;';
      btn.setAttribute('aria-label', paused ? 'Resume game' : 'Pause game');
    }
  } catch(e){}
}

function wireUI(){
  try {
    var btn = document.getElementById('pause-btn');
    if (btn && !btn.__pauseWired){
      btn.__pauseWired = true;
      btn.addEventListener('click', function(){ togglePaused(); });
    }
    var rs = document.getElementById('pause-resume');
    if (rs && !rs.__pauseWired){
      rs.__pauseWired = true;
      rs.addEventListener('click', function(){ setPaused(false); });
    }
  } catch(e){}
  syncUI();
}

/* ---------------------------------------------------------------------------
   The public API — window.GamePause
   --------------------------------------------------------------------------- */
function setPaused(v){
  v = !!v;
  if (v === paused) return;
  paused = v;
  if (paused) pauseAudio(); else resumeAudio();
  syncUI();
  try {
    if (window.Report && Report.note) Report.note('pause', {paused: paused});
  } catch(e){}
}
function togglePaused(){ setPaused(!paused); }

window.GamePause = {
  /* Read by animate() every frame. Treat as read-only outside this
     module — change it via setPaused()/toggle() only. */
  get paused(){ return paused; },
  setPaused: setPaused,
  toggle: togglePaused,
  isPaused: function(){ return paused; }
};

/* ---------------------------------------------------------------------------
   Escape key — same typing guard as the v1.67 keyboard-look block:
   events aimed at text entry (INPUT / TEXTAREA / SELECT /
   contentEditable — the zone-unlock password box among them) are
   never touched, and Escape does nothing while a menu panel is
   open (the player is in a menu, not in gameplay).
   --------------------------------------------------------------------------- */
function typingTarget(e){
  var t = e && e.target;
  if (!t) return false;
  var tag = (t.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
}
function menuOpen(){
  try {
    var ids = ['settings', 'help', 'gameplay', 'fullmap'];
    for (var i = 0; i < ids.length; i++){
      var el = document.getElementById(ids[i]);
      if (el && el.classList && el.classList.contains('show')) return true;
    }
  } catch(e){}
  return false;
}
window.addEventListener('keydown', function(e){
  if (typingTarget(e)) return;
  var k = (e.key || '').toLowerCase();
  if (k !== 'escape' && k !== 'esc') return;
  if (e.repeat) return;            /* holding Esc must not strobe the pause */
  if (menuOpen()) return;          /* menus own Escape while they are open */
  togglePaused();
  try { e.preventDefault(); } catch(err){}
});

/* ---------------------------------------------------------------------------
   Pointer lock — on the web, Escape during pointer lock exits the
   lock INSTEAD of reaching the page. Players still mean "pause" by
   it, so a lock loss during gameplay pauses. Inert today (no view
   mode requests the lock yet); wired for the day one does.
   --------------------------------------------------------------------------- */
try {
  document.addEventListener('pointerlockchange', function(){
    try {
      if (!document.pointerLockElement && !paused && window.__gameReadyFired){
        setPaused(true);
      }
    } catch(e){}
  });
} catch(e){}

/* Wire the button/overlay. The deferred queue runs after the DOM is
   parsed, so the elements normally exist already; if a future load
   order ever beats the DOM, wire on DOMContentLoaded instead. */
if (document.getElementById && document.getElementById('pause-btn')) wireUI();
else if (document.addEventListener)
  document.addEventListener('DOMContentLoaded', wireUI);

/* Self-report so Joshua can verify the module loaded (Report panel). */
try {
  if (typeof Report !== 'undefined' && Report.setSys){
    Report.setSys('pause', {status:'ok', version:'1.0',
      note:'Esc / pause button freezes sim + music (Joshua 2026-10-17)'});
  }
} catch(e){}

})();
