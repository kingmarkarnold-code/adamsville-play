/* ============================================================================
   BODY SYSTEMS — the player's own damage meter + fatigue (Joshua 2026-11-07)
   Joshua's rule: all code commented.

   TWO SYSTEMS, both his specs and his numbers (2026-11-07) — implemented as
   stated, not rebalanced:

   1) DAMAGE METER — running into trees and boulders hurts the BODY.
      - Fed by crashlog.js: every ACCEPTED (post-cooldown) tree/boulder bump
        in WALKING mode adds exactly 1 point. (Driving impacts feed the CAR's
        damage instead — a bent fender is not a hurt body.)
      - Scale 0..100. The HUD bar renders as a STAGED PROGRESSION (his
        words: "the 10 decreases of the green and then starts going up in
        the yellow"): at damage 0 the bar shows its 10 of GREEN; each point
        eats the green (10 -> 0 across damage 0..10); then the YELLOW fill
        climbs with damage up to 50; from 50 the RED climbs to 100. Rest
        drains damage back down through the same stages in reverse — red
        falls, yellow falls, the green returns to its 10.
      - 50+: the player SLOWS (foot speed capped) until rested.
      - 100: FORCED REST — movement is locked for 5 minutes of GAME time
        while the meter drains 100 -> 0, then he can move again.
      - REST = standing still. ANY rest drains the damage visibly and
        proportionally (DMG_DRAIN_PER_GMIN below): a partial rest gives
        partial recovery — he SEES himself getting better as he rests.
      - The meter lives on screen ALWAYS (on foot and in a vehicle) and is
        SEPARATE from the car's damage/gas HUD (#dmg-wrap).

   2) FATIGUE — one shared run reserve for land and water (a tired body is
      tired in water too).
      - The reserve drains while RUNNING, by DISTANCE: calibrated so a
        continuous run empties it after ~1 MILE of running (Joshua's own
        benchmark: "I run a mile and a little bit at 10 minutes give or
        take"). The world is real scale (1 unit = 1 metre), so the drain
        is 100 points per 1609.34 units run; at the game's 13.8 u/s full
        run that is ~22.6 game-minutes of continuous running.
      - Walking recovers it slowly; standing still recovers it faster.
        Intervals (run/walk/rest mixing) therefore stretch the total run
        distance before lockout — that emerges from the rates, no special
        cases.
      - Reserve empty -> LOCKOUT: 10 minutes of GAME time at walking pace
        (running locked out) while the reserve refills to full.
      - PUSHING: demanding run (full stick / WASD) DURING the lockout
        accrues debt — each game-minute of pushing adds half a game-minute
        to the lockout (capped at +5). Simple, legible, shown in state.
      - Fatigue NEVER locks movement — it caps speed at walk. (Damage-100
        is the only full lock.) Where both apply, the stricter cap wins.
      - SWIM ARM: top swim speed was raised 4.5 -> 6.75 u/s (x1.5) in
        updatePlayer (index.html) per Joshua ("a little slow"). Swimming
        at top speed (> 5.4 u/s) drains the SAME reserve by TIME: ~7
        minutes of GAME time at top speed empties it. Easing off to a
        gentle swim (<= 5.4 u/s) recovers it at the walking rate while
        still swimming. Surface swimming only — breath/diving are a
        separate pass, NOT here.

   HUD READOUT (Joshua 2026-11-07, 15:06 refinement): the second row's
   state word defaults to FATIGUE. FATIGUE is presented as a badness meter
   like DAMAGE — it RISES with exertion and DRAINS with rest, coloured by
   the same bands (<= 10 green, < 50 yellow, else red; low = green). The
   word changes to RESTING only while the player is at a FULL STOP with
   tree/boulder damage draining — that includes the whole damage-100
   forced rest — and returns to the default word the moment he moves
   again or the damage reaches 0. No other label is ever a default.

   BAR RESTRUCTURE (Joshua 2026-11-07, 15:31 + 15:36 — supersedes the
   DMG / FATIGUE row labels above):
   - Row 2's default word is ENERGY now, not FATIGUE (15:31: "change
     the name from fatigue ... to energy"). The system underneath is
     still the fatigue reserve; only the word the player reads
     changed. The row stays on screen ALWAYS, on foot and in a
     vehicle, so he always knows his body's energy (15:36).
   - Row 1 is ONE SHARED BAR whose word follows the mode (15:36):
     on foot it reads HEALTH and shows the BODY's bump damage (the
     staged progression of section 1 — it is his body, so the bar
     says health); in a vehicle the same bar element reads DAMAGE
     and shows the VEHICLE's damage instead — car.damage, the value
     index.html's car system already maintains (the same value its
     own #dmg-wrap renders). This module only DISPLAYS the car's
     value while driving; it never writes it. The body's own health
     is not shown while driving — it keeps existing underneath and
     reappears unchanged when he gets out and the word flips back
     to HEALTH.
   - The RESTING mechanism is untouched: the word still appears
     only on row 2, only while fully stopped (not driving/swimming)
     with body damage draining, forced rest included.

   CRASH FEED (2026-11-07, crash model pass — Joshua 15:39): vehicle
   crashes hurt the BODY too, scaled by speed and by what was hit. The
   crash model (crash_model.js) computes the points; this module's
   meter RECEIVES them via addCrashDamage() — the store, the staged
   bar and every consequence stay here, nothing is duplicated there.
   One interaction matters: crash damage can set the meter to 100
   while he is still SEATED in the wreck. The forced rest is an
   on-foot state, so while driving the meter HOLDS at 100 (no rest
   drain — he is not resting, he is stuck; the crash model's own
   two-game-minute exit block runs meanwhile). The first tick out of
   the car engages the forced rest (see tick()) and the usual
   5-game-minute drain runs on foot, exactly as a bump-earned 100 does.

   FORCED-REST VISUAL: index.html's animation paths read
   window.__BODY.forcedRest(). The GLB path plays an authored 'Exhausted'
   clip IF one ever ships in hero.glb (R.actions.Exhausted); none exists
   yet, so both rigs fall back to a hands-on-knees bent-over pose (the
   same inner-wrapper pitch trick the swim pose uses, plus a hip drop).
   The authored clip replaces the pose later — see the build notes.

   Time is GAME time: deltas come from WorldClock (dayNum/gameMin), the
   same clock daycycle renders. Pausing the sim pauses the body.

   Structure: createBodyCore() is a pure state machine (no DOM, no game
   globals) so the pass harness can drive it with a stubbed clock —
   window.__BODY_CORE exposes it. The game wiring (HUD, Sim tick, the
   window.__BODY facade index.html/crashlog.js call) is below and fully
   defensive: if anything is missing the module quietly does nothing.
   ============================================================================ */
(function BodySystems(){
'use strict';

/* ---------------------------------------------------------------------------
   CONSTANTS — every number is Joshua's spec or derived from it (see header).
   --------------------------------------------------------------------------- */
var C = {
  /* damage */
  DMG_SLOW_AT:        50,     // damage >= 50 -> slowed (his threshold)
  DMG_FORCE_AT:       100,    // damage 100 -> forced rest (his threshold)
  DMG_DRAIN_PER_GMIN: 20,     // rest drain: 100 pts over 5 game-min (the
                              // forced rest), 50 pts over 2.5 game-min —
                              // resting out the 50-tier's 2 game-minutes at
                              // 50 damage lands him at 10 (green, unslowed)
  DMG_SLOW_CAP:       7.6,    // u/s foot cap while hurt (below run, above walk)
  /* fatigue — land */
  WALK_CAP:           5.0,    // u/s = the game's own walk pace (indoor speed)
  RUN_SPEED_MIN:      8.0,    // u/s: faster than this on foot = running
  MILE_U:             1609.34,// world units per mile (1 unit = 1 metre)
  RUN_DRAIN_PER_UNIT: 100 / 1609.34, // reserve points per unit run -> a
                              // continuous run empties the reserve at 1 mile
  WALK_REC_PER_GMIN:  4,      // reserve recovery while walking / driving /
                              // gentle-swimming (25 game-min to full)
  REST_REC_PER_GMIN:  10,     // reserve recovery standing still (10 game-min)
  LOCK_MINUTES:       10,     // game-minutes of walk-only after empty (his 10)
  PUSH_EXT_PER_GMIN:  0.5,    // pushing during lockout: +0.5 game-min owed
                              // per game-minute of pushing
  LOCK_TOTAL_MAX:     15,     // lockout cap: 10 + at most 5 of debt
  /* fatigue — swim */
  SWIM_TOP_MIN:       5.4,    // u/s: above this = top-speed swimming
                              // (0.8 x the raised 6.75 u/s top speed)
  SWIM_DRAIN_PER_GMIN: 100 / 7, // ~7 game-minutes at top speed empties it
  GENTLE_SWIM_CAP:    4.5,    // u/s swim cap during lockout = the OLD top
                              // speed: gentle swimming, no top speed
  /* colours — the game's own HUD palette (matches the car damage bar) */
  GREEN:  '#3fd34f',
  YELLOW: '#ffd75e',
  RED:    '#ff5b5b'
};

/* ---------------------------------------------------------------------------
   bandColor(v) — the shared colour language for a 0..100 badness value:
   0..10 GREEN, above 10 up to 50 YELLOW, 50..100 RED. (The damage BAR does
   not use this — it renders the staged green/yellow/red segments below.
   The fatigue fill and both numeric readouts do.)
   --------------------------------------------------------------------------- */
function bandColor(v){
  if (v <= 10) return C.GREEN;
  if (v < 50)  return C.YELLOW;
  return C.RED;
}

/* ---------------------------------------------------------------------------
   dmgSegments(damage) — the damage bar's STAGED PROGRESSION (Joshua
   2026-11-07, 15:07): three contiguous segments whose widths are pure
   functions of damage —
     green  = the 10 of green, eaten 10 -> 0 across damage 0..10
     yellow = climbs 0 -> 40 across damage 10..50 ("starts going up")
     red    = climbs 0 -> 50 across damage 50..100
   Rest runs it backwards on its own: red falls, yellow falls, green
   returns to its 10. Segment widths are in bar-percent (bar = 100 wide).
   --------------------------------------------------------------------------- */
function dmgSegments(d){
  d = Math.max(0, Math.min(100, d));
  return {
    g: Math.max(0, 10 - d),
    y: Math.max(0, Math.min(40, d - 10)),
    r: Math.max(0, Math.min(50, d - 50))
  };
}

/* ---------------------------------------------------------------------------
   createBodyCore() — the pure state machine. env for tick():
     { mode: 'foot'|'swim'|'drive', speed: u/s (post-cap, actual),
       dtSec: real seconds this tick (for distance), resting: bool,
       runIntent: bool (full stick / WASD demand) }
   tick's first argument is elapsed GAME minutes (daycycle time).
   --------------------------------------------------------------------------- */
function createBodyCore(){
  var S = {
    damage: 0,          // 0..100 body damage from tree/boulder bumps
    forcedRest: false,  // damage-100 movement lock
    reserve: 100,       // fatigue reserve 100..0 (100 = fresh)
    lockout: false,     // fatigue walk-only period active
    lockElapsed: 0,     // game-minutes spent in the current lockout
    lockTotal: C.LOCK_MINUTES, // game-minutes this lockout lasts (10 + debt)
    debtMin: 0,         // extra lockout minutes owed from pushing
    restingShow: false  // HUD state word: true -> RESTING, false -> ENERGY
  };

  /* One accepted tree/boulder bump = +1 damage. At 100 the forced rest
     begins. Bumps during the forced rest change nothing (already maxed). */
  function addBump(kind){
    if (kind !== 'tree' && kind !== 'boulder') return false;
    if (S.forcedRest) return false;
    S.damage = Math.min(C.DMG_FORCE_AT, S.damage + 1);
    if (S.damage >= C.DMG_FORCE_AT) S.forcedRest = true;
    return true;
  }

  /* Vehicle-crash damage (crash_model.js): points land on the same
     meter bumps feed. Deliberately does NOT engage the forced rest by
     itself — a maxed meter earned in a car seat takes effect on foot
     (tick() below engages it the first tick he is out of the car), so
     the meter can HOLD at 100 for the whole stuck-in-car wait instead
     of draining away inside it. Returns the meter's new value. */
  function addCrashDamage(n){
    n = Math.max(0, n || 0);
    if (n <= 0) return S.damage;
    S.damage = Math.min(C.DMG_FORCE_AT, S.damage + n);
    return S.damage;
  }

  function tick(g, env){
    if (!(g > 0)) g = 0;

    /* --- CRASH HOLD: a meter at 100 that is not already in the forced
       rest got there in a car seat (bumps engage the rest themselves).
       Out of the car, the forced rest engages now — and its drain
       below runs the .11 five game-minutes on foot. In the car the
       meter simply holds: not resting, not draining. --- */
    if (!S.forcedRest && S.damage >= C.DMG_FORCE_AT && env.mode !== 'drive')
      S.forcedRest = true;

    /* --- DAMAGE: rest drains it, visibly and proportionally. During the
       forced rest he is resting by construction (movement is locked), so
       the drain runs and the meter empties over exactly 5 game-minutes —
       that drain IS the forced rest's 5 minutes, after which the lock
       releases with the meter at 0. --- */
    if ((env.resting || S.forcedRest) && S.damage > 0){
      S.damage = Math.max(0, S.damage - C.DMG_DRAIN_PER_GMIN * g);
      if (S.forcedRest && S.damage <= 0){ S.damage = 0; S.forcedRest = false; }
    }

    /* --- FATIGUE --- */
    if (S.lockout){
      /* Walk-only period: the reserve refills on schedule, linearly, so
         the readout drains back toward green as the minutes pass. */
      S.lockElapsed += g;
      /* PUSHING: still demanding run while locked out digs the hole
         deeper — the remaining wait grows (debt), capped at +5 game-min. */
      if (env.runIntent && (env.mode === 'foot' || env.mode === 'swim')){
        var ext = Math.min(C.PUSH_EXT_PER_GMIN * g, C.LOCK_TOTAL_MAX - S.lockTotal);
        if (ext > 0){ S.lockTotal += ext; S.debtMin = S.lockTotal - C.LOCK_MINUTES; }
      }
      if (S.lockElapsed >= S.lockTotal){
        S.lockout = false; S.reserve = 100;
        S.lockElapsed = 0; S.lockTotal = C.LOCK_MINUTES; S.debtMin = 0;
      } else {
        S.reserve = 100 * (S.lockElapsed / S.lockTotal);
      }
    } else {
      var dR = 0;
      if (env.mode === 'foot'){
        if (env.speed > C.RUN_SPEED_MIN)
          dR = -env.speed * env.dtSec * C.RUN_DRAIN_PER_UNIT; // by DISTANCE
        else if (env.speed < 0.1)
          dR = C.REST_REC_PER_GMIN * g;   // standing still: fastest recovery
        else
          dR = C.WALK_REC_PER_GMIN * g;   // walking: slow recovery
      } else if (env.mode === 'swim'){
        if (env.speed > C.SWIM_TOP_MIN)
          dR = -C.SWIM_DRAIN_PER_GMIN * g; // by TIME at top speed (~7 gmin)
        else
          dR = C.WALK_REC_PER_GMIN * g;   // gentle swim recovers, still wet
      } else { /* drive: seated, not exerting — recovers at the walking rate */
        dR = C.WALK_REC_PER_GMIN * g;
      }
      if (dR !== 0){
        S.reserve += dR;
        if (S.reserve <= 0){
          /* Emptied: the 10-game-minute walk-only lockout begins. */
          S.reserve = 0; S.lockout = true;
          S.lockElapsed = 0; S.lockTotal = C.LOCK_MINUTES; S.debtMin = 0;
        } else if (S.reserve > 100) S.reserve = 100;
      }
    }

    /* --- HUD state word: RESTING only at a FULL STOP while tree/boulder
       damage is draining (the forced rest included — he is stopped by
       the lock and the meter is draining). Evaluated AFTER the drain, so
       the tick the damage reaches 0 the word is already ENERGY again. --- */
    S.restingShow = !!(S.forcedRest || (env.resting && S.damage > 0));
  }

  /* Speed governor — updatePlayer calls this on its computed speed.
     Forced rest = 0 (no movement at all). Damage >= 50 caps foot speed.
     Fatigue lockout caps foot speed at walk, swim speed at gentle.
     Where both apply the stricter (smaller) cap wins. */
  function capSpeed(spd, mode){
    if (S.forcedRest) return 0;
    var cap = spd;
    if (mode === 'foot'){
      if (S.lockout) cap = Math.min(cap, C.WALK_CAP);
      if (S.damage >= C.DMG_SLOW_AT) cap = Math.min(cap, C.DMG_SLOW_CAP);
    } else if (mode === 'swim'){
      if (S.lockout) cap = Math.min(cap, C.GENTLE_SWIM_CAP);
    }
    return cap;
  }

  return {
    state: S,
    addBump: addBump,
    addCrashDamage: addCrashDamage,
    tick: tick,
    capSpeed: capSpeed,
    fatigue: function(){ return 100 - S.reserve; },  // badness readout 0..100
    label: function(){ return S.restingShow ? 'RESTING' : 'ENERGY'; }
  };
}

/* Test seam (same pattern as crashlog's _identify): the pass harness loads
   this file with stubbed globals and drives createBodyCore directly. */
if (typeof window !== 'undefined'){
  window.__BODY_CORE = {
    create: createBodyCore, C: C,
    bandColor: bandColor, dmgSegments: dmgSegments
  };
}

/* ===========================================================================
   GAME WIRING — HUD + Sim tick + the window.__BODY facade. Everything below
   is guarded: no document / no Sim / no player -> nothing happens.
   =========================================================================== */
if (typeof document === 'undefined' || typeof window === 'undefined') return;

var core = createBodyCore();

/* The facade index.html and crashlog.js call:
   - __BODY.addBump(kind, mode): crashlog hook — WALKING bumps only.
   - __BODY.forcedRest(): updatePlayer input lock + animation poses.
   - __BODY.capSpeed(spd, mode): updatePlayer speed governor. */
window.__BODY = {
  core: core,
  addBump: function(kind, mode){
    if (mode !== 'walking') return false;
    return core.addBump(kind);
  },
  /* crash_model.js's feed: vehicle-crash points onto the body meter.
     Returns the meter's new value so the crash model can spot the
     maxed-out (incapacitation) case. */
  addCrashDamage: function(n){ return core.addCrashDamage(n); },
  forcedRest: function(){ return core.state.forcedRest; },
  capSpeed: function(spd, mode){ return core.capSpeed(spd, mode); }
};

/* --- HUD: two compact rows above the minimap, styled like the car's
   #dmg-wrap (same pill, same 10px bars, same palette). Built here (the
   daycycle/crashlog pattern) so index.html needs no markup edits.
   Row 1: HEALTH (on foot) / DAMAGE (in a vehicle) — the staged
   green/yellow/red progression segments over whichever value the
   mode shows (body damage on foot, car.damage while driving).
   Row 2: ENERGY/RESTING — one fill of fatigue, band-coloured. --- */
var hud = null;
function buildHud(){
  if (hud || !document.body) return;
  var st = document.createElement('style');
  st.textContent =
    '#body-wrap{position:fixed;z-index:11;left:14px;bottom:174px;display:none;' +
    'background:rgba(0,0,0,.5);padding:7px 10px;border-radius:10px;color:#fff;' +
    'font-size:11px;font-weight:bold;pointer-events:none;}' +
    '#body-wrap .brow{display:flex;align-items:center;gap:7px;}' +
    '#body-wrap .brow+.brow{margin-top:5px;}' +
    '#body-wrap .btag{width:56px;letter-spacing:.5px;color:#ffd75e;}' +
    '#body-wrap .bbar{width:118px;height:10px;border-radius:5px;' +
    'background:#3a3f45;overflow:hidden;display:flex;}' +
    '#body-wrap .bseg{height:100%;}' +
    '#body-wrap .bnum{width:24px;text-align:right;font-variant-numeric:tabular-nums;}' +
    '@media (max-width:520px){#body-wrap .bbar{width:84px;}}';
  document.head.appendChild(st);
  var el = document.createElement('div');
  el.id = 'body-wrap';
  el.innerHTML =
    '<div class="brow"><span class="btag" id="bd-tag">HEALTH</span>' +
      '<div class="bbar"><div class="bseg" id="bd-g"></div>' +
      '<div class="bseg" id="bd-y"></div><div class="bseg" id="bd-r"></div></div>' +
      '<span class="bnum" id="bd-num">0</span></div>' +
    '<div class="brow"><span class="btag" id="bf-tag">ENERGY</span>' +
      '<div class="bbar"><div class="bseg" id="bf-fill"></div></div>' +
      '<span class="bnum" id="bf-num">0</span></div>';
  document.body.appendChild(el);
  hud = {
    wrap: el,
    dTag: document.getElementById('bd-tag'),
    g: document.getElementById('bd-g'), y: document.getElementById('bd-y'),
    r: document.getElementById('bd-r'), dNum: document.getElementById('bd-num'),
    fFill: document.getElementById('bf-fill'),
    fTag: document.getElementById('bf-tag'), fNum: document.getElementById('bf-num'),
    last: ''
  };
  hud.g.style.background = C.GREEN;
  hud.y.style.background = C.YELLOW;
  hud.r.style.background = C.RED;
}

/* HUD refresh: writes only when a displayed value actually changed.
   Row 1 follows the mode (Joshua 2026-11-07 15:36): on foot it shows
   the BODY's damage under the word HEALTH; in a vehicle it shows the
   CAR's damage (car.damage, sampled fresh each tick by bodyTick into
   dispVehDmg) under the word DAMAGE. One bar, two sources — both run
   through the same staged segments and band colours. Row 2 (ENERGY)
   is the body's own in both modes and never leaves the screen. */
function paintHud(){
  if (!hud) return;
  var S = core.state;
  var shown = dispDriving ? dispVehDmg : S.damage;
  var shownRound = Math.round(shown), fRound = Math.round(core.fatigue());
  var word = dispDriving ? 'DAMAGE' : 'HEALTH';
  var key = word + '|' + shownRound + '|' + fRound + '|' + core.label();
  if (key === hud.last) return;
  hud.last = key;
  var seg = dmgSegments(shown);
  hud.g.style.width = seg.g + '%';
  hud.y.style.width = seg.y + '%';
  hud.r.style.width = seg.r + '%';
  hud.dTag.textContent = word;
  hud.dNum.textContent = shownRound;
  hud.dNum.style.color = bandColor(shown);
  hud.fFill.style.width = fRound + '%';
  hud.fFill.style.background = bandColor(core.fatigue());
  hud.fNum.textContent = fRound;
  hud.fNum.style.color = bandColor(core.fatigue());
  hud.fTag.textContent = core.label();
}

/* --- per-frame body tick, registered on the Sim render phase once the
   game globals exist. Game-minute deltas come from WorldClock so a paused
   sim pauses the body and the rate matches the rendered day/night clock
   exactly; if the clock is unreachable this tick, fall back to the
   documented rate (1440 game-min per 7440 real seconds). --- */
var lastClockTotal = null;
/* Row-1 display context for paintHud (Joshua 2026-11-07 15:36): while
   driving, row 1 shows the CAR's damage under the word DAMAGE. The
   value is index.html's car.damage — the same one its #dmg-wrap HUD
   renders — read defensively each tick; this module never writes it. */
var dispDriving = false, dispVehDmg = 0;
function bodyTick(dt){
  try{
    if (typeof player === 'undefined' || !player) return;
    if (!hud){ buildHud(); if (hud) hud.wrap.style.display = 'block'; }
    var dtSec = (typeof dt === 'number' && dt > 0) ? dt : 0;

    /* game minutes elapsed since the last tick */
    var gMin = dtSec * (1440 / 7440);
    try{
      var clk = window.WorldClock || window.__daycycle;
      if (clk && typeof clk.gameMin === 'number' && typeof clk.dayNum === 'number'){
        var total = clk.dayNum * 1440 + clk.gameMin;
        if (lastClockTotal !== null){
          var delta = total - lastClockTotal;
          /* A sane frame delta only: clock SETS (Time Control jumps,
             stash restores) must not drain or heal the body in a burst. */
          if (delta >= 0 && delta <= 1) gMin = delta;
        }
        lastClockTotal = total;
      }
    }catch(e){}

    /* environment snapshot */
    var driving = false;
    try{ driving = (typeof car !== 'undefined' && !!car && !!car.driving); }catch(e){}
    /* row 1's display source (see dispVehDmg above): the car's damage
       while driving, the body's the rest of the time */
    dispDriving = driving;
    dispVehDmg = 0;
    if (driving){
      try{ if (typeof car !== 'undefined' && car &&
                typeof car.damage === 'number') dispVehDmg = car.damage; }
      catch(e){}
    }
    var swimming = !!player.swimming;
    var mode = driving ? 'drive' : (swimming ? 'swim' : 'foot');
    var speed = driving ? 0 : (player.speed || 0);
    var resting = !driving && !swimming && speed < 0.1;
    /* run demand: WASD (sampled snapshot, like updatePlayer) or a hard
       stick push — used only for the lockout pushing debt. */
    var runIntent = false;
    try{
      var ik = (window.Input && Input.sampled) ? Input.keys : window.keys;
      if (ik && (ik['w'] || ik['a'] || ik['s'] || ik['d'])) runIntent = true;
      if (!runIntent && typeof joy !== 'undefined' && joy && joy.active &&
          Math.hypot(joy.dx || 0, joy.dy || 0) > 0.55) runIntent = true;
    }catch(e){}

    core.tick(gMin, { mode: mode, speed: speed, dtSec: dtSec,
                      resting: resting, runIntent: runIntent });
    paintHud();
  }catch(e){}
}

/* Boot poll (the wildlife pattern): wait for the player + Sim registry,
   then register on the render phase. Priority 46: after daycycle (40),
   before wildlife (66) — order among these consumers is not load-bearing;
   what matters is that updatePlayer (the speed consumer) runs its own
   phase and reads the facade, which is live from this file's eval. */
var bootTries = 0;
var bootTimer = setInterval(function(){
  bootTries++;
  try{
    if (typeof player !== 'undefined' && player &&
        typeof Sim !== 'undefined' && Sim && typeof Sim.onTick === 'function'){
      clearInterval(bootTimer);
      Sim.onTick('render', 46, bodyTick);
    } else if (bootTries > 600){ clearInterval(bootTimer); } // ~2 min, give up quietly
  }catch(e){ if (bootTries > 600) clearInterval(bootTimer); }
}, 200);

})();
