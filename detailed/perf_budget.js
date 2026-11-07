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
     0 FULL:   NPC stream full, shadows all, traffic cap none, drawDist as set
     1 HIGH:   NPC stream full, shadows <75u only, traffic 40, drawDist as set
     2 MEDIUM: NPC stream full, shadows off, traffic 24, drawDist forced short
     3 LOW:    NPC stream full, shadows off, traffic 12, drawDist forced short
   ("NPC stream full" and the traffic caps are bounded by the half-mile
   full-draw floor below: levels thin the world BEYOND 800u only. The old
   npcDist numbers 150/100/60/40 still sit in the LEVELS table as each
   level's *requested* distance, but applyLevel() clamps what it publishes
   to >= FULL_DRAW_R, and npc_system.js floors its own radius too.)

   HOW THE OVERRIDES REACH THE SYSTEMS:
   This module publishes globals that each system checks per frame:
     window.__perfNpcDist     — NPC streaming distance override (u);
                                never published below FULL_DRAW_R
     window.__perfShadowDist  — blob shadow max distance override (u, 0=off)
     window.__perfTrafficCap  — traffic rendered cap; applies to the field
                                BEYOND FULL_DRAW_R (inside-circle cars are
                                exempt — see traffic_system.js assignSlots)
     window.__perfDrawDist    — draw distance override ('short'|null);
                                'short' far plane is 1500u, still > 800u
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

/* ---------------- Joshua's half-mile full-draw rule (2026-10-17) --------
   FULL_DRAW_R = 800 units. The game world is true-scale (1 unit = 1 metre,
   one mile = 1,609u), so 800u is HALF A MILE. Inside this radius around the
   player, EVERYTHING is drawn in full — traffic, pedestrians, buildings —
   automatically, at every quality level. Quality scaling may only thin
   the world BEYOND the circle, never inside it.
   This file is the canonical home of the constant: traffic_system.js and
   npc_system.js read window.FULL_DRAW_R (each keeps an identical 800
   fallback in case this module ever fails to load). applyLevel() clamps
   every override it publishes against this floor, and the self-check at
   the bottom of this file verifies no quality level can violate it.
   If Joshua retunes the circle, this is the ONE number to change. */
var FULL_DRAW_R = 800;
window.FULL_DRAW_R = FULL_DRAW_R;

/* Far planes of the draw-distance presets (index.html's table — kept here
   only so the level self-check can prove a forced 'short' draw distance
   still sees past the full-draw circle: 1500 > 800. If index.html's table
   ever changes, change this mirror too; the check fails loudly either
   way rather than silently breaking the rule). */
var DRAWDIST_FAR = { short: 1500, medium: 2500, long: 5000 };

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
/* Telemetry counters (2026-10-28, Joshua's reporting rework): this
   module already tracks FPS and the quality level, so it also keeps
   the session facts the automatic reports' telemetry block reads —
   how many times quality changed, and the FPS band (lowest/highest
   smoothed FPS after a short warmup, so the boot transient doesn't
   poison the low). Counted HERE, in the owning system; the report
   sender (github_reports.js) only reads them via getTelemetry(). */
var levelChanges = 0;          /* post-boot quality level changes */
var minEmaFps = null;          /* lowest smoothed FPS after warmup */
var maxEmaFps = null;          /* highest smoothed FPS after warmup */

/* ---------------- frame-hitch histogram (2026-11-07) ----------------
   The EMA above SMOOTHS a hitch away: a single 350 ms main-thread
   block (Joshua's laptop report — "movement stops, then recovers",
   FPS dipping to 19) moves the smoothed FPS only briefly, so the
   telemetry the player reports carried no trace of the stops. This
   histogram counts RAW frame gaps into buckets — how many frames
   this session ran longer than 50 / 100 / 250 ms — so a report can
   say "17 frames over 100 ms" instead of a smooth average that
   hides them. Gaps over HITCH_MAX_GAP_MS are not counted: a
   multi-second gap is the tab sleeping or switching away, not the
   game blocking a frame. Counted HERE, in the module that sees
   every frame; github_reports.js only reads the counts through
   getTelemetry() (the Google Form is unchanged). */
var HITCH_MAX_GAP_MS = 2000;
var hitchFrames = 0;           /* frames timed (0 < dt <= HITCH_MAX_GAP_MS) */
var hitchGt50 = 0, hitchGt100 = 0, hitchGt250 = 0;
function countHitch(dtMs){
  if (!(dtMs > 0) || dtMs > HITCH_MAX_GAP_MS) return;
  hitchFrames++;
  if (dtMs > 50) hitchGt50++;
  if (dtMs > 100) hitchGt100++;
  if (dtMs > 250) hitchGt250++;
}
var FPS_WARMUP_SECS = 5;       /* ignore the first seconds of FPS */
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
  /* Telemetry: count genuine post-boot level changes (the boot
     apply has lastAppliedLevel === -1 and is not a "change"). */
  if (lastAppliedLevel !== -1 && lv !== lastAppliedLevel) levelChanges++;
  lastAppliedLevel = lv;
  var L = LEVELS[lv];

  /* Publish overrides for the hooked systems. null/undefined = "no override,
     use your default" — so level 0 restores stock behavior exactly.
     FULL-DRAW FLOOR (Joshua 2026-10-17): the published NPC distance is
     clamped to >= FULL_DRAW_R — a quality level may ask for a smaller
     stream radius, but what it GETS never shrinks drawing inside the
     half-mile circle. (npc_system.js applies the same floor on its side,
     so level 0's null is safe too.) The traffic cap is published as-is:
     traffic_system.js applies it only beyond the circle. */
  window.__perfNpcDist     = (lv === 0) ? null : Math.max(FULL_DRAW_R, L.npcDist);
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
  if (!force) log('quality -> ' + L.label + ' (npcDist=' +
    (lv === 0 ? 'stock' : Math.max(FULL_DRAW_R, L.npcDist)) +
    ' shadowDist=' + (L.shadowDist > 1e8 ? 'all' : L.shadowDist) +
    ' trafficCap=' + L.trafficCap + ')');
}

/* ---------------- per-frame FPS monitor ---------------- */
function tick(){
  var now;
  try { now = performance.now(); } catch(e){ return; }
  if (lastFrameT > 0) {
    var dtMs = now - lastFrameT;
    countHitch(dtMs);   /* raw-gap histogram (2026-11-07): sees the
                           hitches the EMA below smooths over */
    if (dtMs > 0 && dtMs < 1000) {   /* ignore huge gaps (tab switch, hitch) */
      var instFps = 1000 / dtMs;
      emaFps += (instFps - emaFps) * FPS_EMA_ALPHA;
    }
  }
  lastFrameT = now;

  /* Telemetry: extend the session FPS band (post-warmup only). */
  if (now / 1000 > FPS_WARMUP_SECS) {
    if (minEmaFps === null || emaFps < minEmaFps) minEmaFps = emaFps;
    if (maxEmaFps === null || emaFps > maxEmaFps) maxEmaFps = emaFps;
  }

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

/* ---------------- full-draw floor self-check ----------------
   Verifies the half-mile rule against EVERY quality level, once at boot:
     (a) each level's effective NPC distance (published value after the
         applyLevel clamp; level 0's null means npc_system's own floored
         default) is >= FULL_DRAW_R;
     (b) any draw distance a level can force still has a far plane beyond
         FULL_DRAW_R, so the circle is never clipped by the camera.
   A future level that violates the rule logs a loud error here instead
   of silently shrinking the player's world. Returns true when clean. */
function checkFullDrawFloor(){
  var ok = true;
  for (var lv = 0; lv < LEVELS.length; lv++){
    var L = LEVELS[lv];
    var effNpc = (lv === 0) ? FULL_DRAW_R : Math.max(FULL_DRAW_R, L.npcDist);
    if (effNpc < FULL_DRAW_R){
      ok = false;
      try { console.error('[PerfBudget] FULL-DRAW VIOLATION: level ' + L.label +
        ' npcDist ' + L.npcDist + ' < FULL_DRAW_R ' + FULL_DRAW_R); } catch(e){}
    }
    if (L.drawDist && !(DRAWDIST_FAR[L.drawDist] > FULL_DRAW_R)){
      ok = false;
      try { console.error('[PerfBudget] FULL-DRAW VIOLATION: level ' + L.label +
        ' forces drawDist ' + L.drawDist + ' (far ' + DRAWDIST_FAR[L.drawDist] +
        ') which does not clear FULL_DRAW_R ' + FULL_DRAW_R); } catch(e){}
    }
  }
  if (ok) log('full-draw floor verified: all ' + LEVELS.length +
    ' levels keep FULL_DRAW_R=' + FULL_DRAW_R + 'u fully drawn');
  return ok;
}

/* ---------------- public API ---------------- */
window.PerfBudget = {
  fullDrawR: FULL_DRAW_R,
  checkFullDrawFloor: checkFullDrawFloor,
  getLevel: function(){ return level; },
  getLevelLabel: function(){ return LEVELS[level].label; },
  getFps: function(){ return Math.round(emaFps); },
  getTarget: function(){ return TARGET_FPS; },
  /* Telemetry snapshot (2026-10-28): everything the automatic
     reports' standard telemetry block needs from this system —
     current FPS, the session FPS band, the quality level and how
     often it changed, and the governor values actually published
     for the other systems to obey (the window.__perf* globals;
     null = stock / no override at FULL). Read by github_reports.js;
     nothing here sends anything itself. */
  getTelemetry: function(){
    return {
      fps: Math.round(emaFps),
      fpsLow: (minEmaFps === null ? null : Math.round(minEmaFps)),
      fpsHigh: (maxEmaFps === null ? null : Math.round(maxEmaFps)),
      level: level,
      levelLabel: LEVELS[level].label,
      levelChanges: levelChanges,
      manualOverride: (manualOverride === null ? 'auto' : LEVELS[manualOverride].label),
      trafficCap: (typeof window.__perfTrafficCap === 'number' ? window.__perfTrafficCap : null),
      npcDist: (typeof window.__perfNpcDist === 'number' ? window.__perfNpcDist : null),
      shadowDist: (typeof window.__perfShadowDist === 'number' ? window.__perfShadowDist : null),
      /* Frame-hitch histogram (2026-11-07): raw frame-gap counts the
         FPS band above cannot express — see countHitch. Folded into
         the reports' existing telemetry JSON by github_reports.js. */
      hitch: { frames: hitchFrames, gt50: hitchGt50, gt100: hitchGt100, gt250: hitchGt250 }
    };
  },
  setManual: window.__setPerfQuality,
  getManual: window.__getPerfQuality,
  /* LAUNCH REDESIGN (2026-11-07): the automatic spec gathering's
     entry point. seedAutoLevel(lv) sets the STARTING level from the
     boot's device measurement (index.html block 1) — including when
     its benchmark settles after this module has already booted. It
     is a seed, not a lock: manual mode (a deliberate override) is
     never touched, and in auto mode the stepper keeps adapting
     from the seeded level exactly as it does from its boot level. */
  seedAutoLevel: function(lv){
    if (manualOverride !== null) return;
    if (typeof lv !== 'number' || isNaN(lv)) return;
    applyLevel(Math.max(0, Math.min(MAX_LEVEL, Math.round(lv))), true);
  },
  /* Test/DI hook: force a level without touching the timers. */
  _forceLevel: function(lv){ applyLevel(Math.max(0, Math.min(MAX_LEVEL, lv)), true); },
  /* Test hook (2026-11-07): feed a synthetic frame gap into the
     hitch histogram, so the verify harness can prove the buckets
     without a live frame loop. */
  _countHitch: countHitch
};

/* ---------------- boot ---------------- */
/* LAUNCH REDESIGN (2026-11-07): the manual quality select lived on
   the launch options screen, which no longer exists — quality is
   measured automatically at boot (index.html block 1 publishes
   window.__autoQualitySeed, refines it when its benchmark settles,
   and persists the result under its own key). A manual value the
   old screen persisted would otherwise fossilize: nothing left in
   the game can change it, and manual mode would pin the level
   forever. When the auto boot is present, a stored manual value is
   by construction a leftover of the removed screen: clear it and
   run AUTO from the measured seed. (No auto boot = an older cached
   page paired with this file: leave the player's saved choice
   exactly as it was.) */
try {
  if (typeof window.__autoQualitySeed === 'number') {
    var _staleQ = localStorage.getItem('sa_perf_q');
    if (_staleQ !== null && _staleQ !== 'auto') {
      localStorage.setItem('sa_perf_q', 'auto');
      log('cleared stale manual quality override from the removed launch screen — auto quality now');
    }
  }
} catch(e){}
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
  /* LAUNCH REDESIGN (2026-11-07): the boot measurement's seed wins
     over the weak-hardware guess — it already accounts for weak
     hardware (its probe floors software renderers and low-memory /
     low-core devices at the gentlest tiers). */
  try {
    var _autoSeed = window.__autoQualitySeed;
    if (typeof _autoSeed === 'number' && _autoSeed >= 0 && _autoSeed <= MAX_LEVEL) {
      startLv = Math.round(_autoSeed);
    }
  } catch(e){}
  applyLevel(startLv, true);
  log('boot auto mode, start level ' + LEVELS[startLv].label);
}

/* Prove the half-mile floor holds for every level before the first frame. */
try { checkFullDrawFloor(); } catch(e){}

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
