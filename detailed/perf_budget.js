/* ============================================================================
   PERF BUDGET v1.0 (2026-10-11) — hard TCL performance budget with automatic
   quality scaling.
   Expert report #42 (Dr. Elena Vasquez, Engine Programmer — 31 yrs, Joshua
   approved "Fix 42"): there was no defined performance target. The game got
   whatever FPS the device delivered, with no minimum and no automatic
   degradation when struggling.

   WHAT THIS DOES:
     1. Sets a hard target: 30 FPS minimum on the TCL T513V.
     2. Monitors FPS continuously (EMA-smoothed, sampled every frame).
     3. Steps quality DOWN if FPS stays below 28 for 3+ seconds.
     4. Steps quality back UP if FPS stays above 32 for 10+ seconds.
     5. Shows a subtle on-screen indicator when quality is reduced.
     6. Logs performance data for debugging (console + Report bridge).
     7. Respects a manual override from the launcher (Auto/Full/High/Med/Low).

   QUALITY LEVELS (0=full → 3=minimum):
     0 FULL:   NPC stream 150u, shadows all, traffic 40, drawDist as set
     1 HIGH:   NPC stream 100u, shadows <75u only, traffic 40, drawDist as set
     2 MEDIUM: NPC stream 60u, shadows off, traffic 24, drawDist forced short
     3 LOW:    NPC stream 40u, shadows off, traffic 12, drawDist forced short

   HOW THE OVERRIDES REACH THE SYSTEMS:
   This module publishes globals that each system checks per frame:
     window.__perfNpcDist     — NPC streaming distance override (u)
     window.__perfShadowDist  — blob shadow max distance override (u, 0=off)
     window.__perfTrafficCap  — traffic rendered slot cap override
     window.__perfDrawDist    — draw distance override ('short'|null)
   npc_system.js, traffic_system.js, and blob_shadows.js each have a small
   hook (marked EXPERT #42) that prefers the override when present. Changes
   are smooth, not jarring: NPC/traffic streaming already fades slots in and
   out at the boundary, so moving the boundary just shifts where that
   happens — no popping.

   Never drops below playable: level 3 keeps player, nearby NPCs, roads,
   and buildings. 25 FPS is the absolute floor — below that we log a
   critical warning (something is very wrong; quality can't fix it).

   Integration: registers on the central Sim tick registry ('render',
   priority 5 — before traffic's 10) per expert #14's rule. No animate()
   monkey-patching. Manual override persists in localStorage ('sa_perf_q').
   Documentation comments are required on all game code — Joshua's rule.
   ============================================================================ */
(function perfBudget(){
'use strict';

/* ---------------- tuning constants ---------------- */
/* Joshua's rule: document the why. 30 FPS is the hard target because the
   TCL T513V's GPU can sustain it with the current scene; 28/32 give a 4-FPS
   hysteresis band so we don't oscillate between levels. 3s down / 10s up
   makes step-downs responsive but step-ups cautious (avoid yo-yo). */
var TARGET_FPS      = 30;
var STEP_DOWN_BELOW = 28;
var STEP_DOWN_SECS  = 3;
var STEP_UP_ABOVE   = 32;
var STEP_UP_SECS    = 10;
var ABSOLUTE_MIN_FPS= 25;
var FPS_EMA_ALPHA   = 0.08;   /* smoothing: ~12 frames to converge */

/* ---------------- quality level definitions ---------------- */
var LEVELS = [
  { npcDist: 150, shadowDist: 1e9, trafficCap: 40, drawDist: null,    label: 'FULL'   },
  { npcDist: 100, shadowDist: 75,  trafficCap: 40, drawDist: null,    label: 'HIGH'   },
  { npcDist: 60,  shadowDist: 0,   trafficCap: 24, drawDist: 'short', label: 'MEDIUM' },
  { npcDist: 40,  shadowDist: 0,   trafficCap: 12, drawDist: 'short', label: 'LOW'    }
];
var MAX_LEVEL = LEVELS.length - 1;

/* ---------------- state ---------------- */
var level = 0;                 /* current quality level */
var manualOverride = null;     /* null = auto, else 0..3 forced */
var emaFps = 60;               /* smoothed FPS */
var belowSince = 0;            /* timestamp when FPS first dropped below 28 */
var aboveSince = 0;            /* timestamp when FPS first rose above 32 */
var lastFrameT = 0;
var belowMinLogged = false;    /* rate-limit the critical warning */
var indicatorEl = null;
var userDrawDist = null;       /* user's launcher drawDist, restored on step-up */
var lastAppliedLevel = -1;

/* ---------------- manual override persistence ---------------- */
function loadOverride(){
  try {
    var v = localStorage.getItem('sa_perf_q');
    if (v === null || v === 'auto') { manualOverride = null; return; }
    var n = parseInt(v, 10);
    if (n >= 0 && n <= MAX_LEVEL) manualOverride = n;
  } catch(e){}
}
function saveOverride(v){
  try { localStorage.setItem('sa_perf_q', v); } catch(e){}
}
/* Called by the launcher UI when the player picks a quality setting. */
window.__setPerfQuality = function(mode){
  /* mode: 'auto' | '0' | '1' | '2' | '3' */
  if (mode === 'auto' || mode === null || mode === undefined) {
    manualOverride = null; saveOverride('auto');
  } else {
    var n = parseInt(mode, 10);
    if (n >= 0 && n <= MAX_LEVEL) { manualOverride = n; saveOverride(String(n)); }
  }
  applyLevel(manualOverride !== null ? manualOverride : level, true);
  log('manual override -> ' + (manualOverride === null ? 'AUTO' : LEVELS[manualOverride].label));
};
window.__getPerfQuality = function(){ return manualOverride === null ? 'auto' : String(manualOverride); };

/* ---------------- logging ---------------- */
function log(msg){
  try { console.log('[PerfBudget] ' + msg); } catch(e){}
  try { if (typeof Report !== 'undefined' && Report.note) Report.note('perf', {msg: msg, level: level, fps: Math.round(emaFps)}); } catch(e){}
}

/* ---------------- indicator ---------------- */
/* Subtle badge, bottom-right above the action button zone. Only visible when
   quality is reduced (level > 0) or a manual override is active. */
function ensureIndicator(){
  if (indicatorEl) return;
  try {
    var d = document.createElement('div');
    d.id = 'perf-budget-ind';
    d.style.cssText = 'position:fixed;right:8px;bottom:220px;z-index:55;'
      + 'font:10px monospace;color:#ffcf6e;background:rgba(0,0,0,.55);'
      + 'padding:2px 8px;border-radius:8px;pointer-events:none;display:none;';
    document.body.appendChild(d);
    indicatorEl = d;
  } catch(e){}
}
function updateIndicator(){
  ensureIndicator();
  if (!indicatorEl) return;
  var show = (level > 0) || (manualOverride !== null);
  indicatorEl.style.display = show ? 'block' : 'none';
  if (show) {
    var txt = 'Q:' + LEVELS[level].label + ' ' + Math.round(emaFps) + 'fps';
    if (manualOverride !== null) txt += ' (manual)';
    indicatorEl.textContent = txt;
  }
}

/* ---------------- apply a quality level ---------------- */
function applyLevel(lv, force){
  if (lv === lastAppliedLevel && !force) return;
  lastAppliedLevel = lv;
  var L = LEVELS[lv];

  /* Publish overrides for the hooked systems. null/undefined = "no override,
     use your default" — so level 0 restores stock behavior exactly. */
  window.__perfNpcDist     = (lv === 0) ? null : L.npcDist;
  window.__perfShadowDist  = (lv === 0) ? null : L.shadowDist;
  window.__perfTrafficCap  = (lv === 0) ? null : L.trafficCap;

  /* Draw distance: remember the user's setting the first time we override,
     restore it when stepping back to a level with no override. */
  if (L.drawDist) {
    if (userDrawDist === null) {
      try { userDrawDist = (window.__launchOpts && window.__launchOpts.drawDist) || 'medium'; } catch(e){ userDrawDist = 'medium'; }
    }
    window.__perfDrawDist = 'short';
    try { if (window.__launchOpts) window.__launchOpts.drawDist = 'short'; } catch(e){}
  } else {
    window.__perfDrawDist = null;
    if (userDrawDist !== null) {
      try { if (window.__launchOpts) window.__launchOpts.drawDist = userDrawDist; } catch(e){}
      userDrawDist = null;
    }
  }

  level = lv;
  updateIndicator();
  if (!force) log('quality -> ' + L.label + ' (npcDist=' + L.npcDist +
    ' shadowDist=' + (L.shadowDist > 1e8 ? 'all' : L.shadowDist) +
    ' trafficCap=' + L.trafficCap + ')');
}

/* ---------------- per-frame FPS monitor ---------------- */
function tick(){
  var now;
  try { now = performance.now(); } catch(e){ return; }
  if (lastFrameT > 0) {
    var dtMs = now - lastFrameT;
    if (dtMs > 0 && dtMs < 1000) {   /* ignore huge gaps (tab switch, hitch) */
      var instFps = 1000 / dtMs;
      emaFps += (instFps - emaFps) * FPS_EMA_ALPHA;
    }
  }
  lastFrameT = now;

  /* Manual override: hold the forced level, skip auto logic. */
  if (manualOverride !== null) {
    if (level !== manualOverride) applyLevel(manualOverride);
    updateIndicator();
    return;
  }

  var t = now / 1000;   /* seconds */

  /* Absolute floor check — quality can't fix this, but we must log it. */
  if (emaFps < ABSOLUTE_MIN_FPS) {
    if (!belowMinLogged) {
      belowMinLogged = true;
      log('CRITICAL: FPS ' + Math.round(emaFps) + ' below absolute minimum ' +
          ABSOLUTE_MIN_FPS + ' at quality ' + LEVELS[level].label);
      try { if (typeof Report !== 'undefined' && Report.note) Report.note('perf-critical', {fps: Math.round(emaFps), level: level}); } catch(e){}
    }
  } else if (emaFps > ABSOLUTE_MIN_FPS + 3) {
    belowMinLogged = false;
  }

  /* Step DOWN: sustained below threshold. */
  if (emaFps < STEP_DOWN_BELOW) {
    if (belowSince === 0) belowSince = t;
    aboveSince = 0;
    if (t - belowSince >= STEP_DOWN_SECS && level < MAX_LEVEL) {
      applyLevel(level + 1);
      belowSince = t;   /* require another full window before the next step */
    }
  }
  /* Step UP: sustained above threshold. */
  else if (emaFps > STEP_UP_ABOVE) {
    if (aboveSince === 0) aboveSince = t;
    belowSince = 0;
    if (t - aboveSince >= STEP_UP_SECS && level > 0) {
      applyLevel(level - 1);
      aboveSince = t;
    }
  }
  /* In the hysteresis band: reset both timers, hold current level. */
  else {
    belowSince = 0;
    aboveSince = 0;
  }

  updateIndicator();
}

/* ---------------- public API ---------------- */
window.PerfBudget = {
  getLevel: function(){ return level; },
  getLevelLabel: function(){ return LEVELS[level].label; },
  getFps: function(){ return Math.round(emaFps); },
  getTarget: function(){ return TARGET_FPS; },
  setManual: window.__setPerfQuality,
  getManual: window.__getPerfQuality,
  /* Test/DI hook: force a level without touching the timers. */
  _forceLevel: function(lv){ applyLevel(Math.max(0, Math.min(MAX_LEVEL, lv)), true); }
};

/* ---------------- boot ---------------- */
loadOverride();
if (manualOverride !== null) {
  /* Manual mode from a previous session: apply immediately. */
  applyLevel(manualOverride, true);
  log('boot with manual quality ' + LEVELS[manualOverride].label);
} else {
  /* Auto mode: start at FULL unless this is known-weak hardware — the
     auto stepper will find the right level within seconds, but starting
     one step down on weak hardware avoids the initial stutter. */
  var startLv = 0;
  try { if (window.__weakHardware) startLv = 1; } catch(e){}
  applyLevel(startLv, true);
  log('boot auto mode, start level ' + LEVELS[startLv].label);
}

/* Register on the central tick registry ('render', priority 5 — before
   traffic's 10) per expert #14's rule. Falls back to a direct rAF hook if
   Sim isn't available yet (defensive; Sim is defined in block 1). */
try {
  if (window.Sim && typeof Sim.onTick === 'function') {
    Sim.onTick('render', 5, function(){ tick(); });
  } else {
    (function raf(){ try{ tick(); }catch(e){} requestAnimationFrame(raf); })();
  }
} catch(e){}

})();
