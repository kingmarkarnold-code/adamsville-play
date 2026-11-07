/* ============================================================================
   BODY SYSTEMS — the player's damage, energy and locomotion (Joshua
   2026-11-07). Joshua's rule: all code commented.

   THREE RULINGS LANDED IN ui 2026.11.07.20 (2026-11-07, late session) —
   they reframe much of what the .11/.16 passes built, and the sections
   below describe the CURRENT model:

   A) SPRINT ENGAGEMENT (16:29) — on foot outdoors there are now two
      gears: WALK is the base pace (5.0 u/s, the game's own walk speed)
      and SPRINT (13.8 u/s, the old full-run) must be ENGAGED: on touch,
      holding the stick pushed UP (forward) past a hold threshold
      (SPRINT_HOLD_MS) breaks into the sprint — one unbroken motion, no
      stopping to change gears; on keyboard, SHIFT + forward sprints
      immediately. Releasing the input drops the gear. The sprint state
      machine lives here (createSprintCore, driven by index.html's
      updatePlayer through __BODY.sprintTick); the SPEED CHOICE and the
      energy consequences follow from it — energy drains/recovery is
      keyed to the speed he is actually at, so walking is cheap and
      sprinting burns at the .11 run rate.

   B) SWIM ENERGY IS ITS OWN POOL (16:32) — swimming tiredness is no
      longer the land reserve. Two pools, land and swim, each its own
      meter; using one never drains the other, so going from swimming
      to walking shows the LAND pool, untouched by the swim ("it starts
      back over when I stand up"). FEET ON THE BOTTOM (wading —
      in the water but walking, not swimming) resets the SWIM pool to
      full instantly and completely. Swim tiers mirror the land gears:
      a gentle swim (<= 5.4 u/s) recovers; a hard swim (> 5.4 u/s)
      burns — retuned LONGER than the .11 shared pool (see
      SWIM_DRAIN_PER_GMIN). A topped-out swim pool still forces the
      FLOAT REST (his 15:46 ruling): ~2 game-minutes floating at the
      gentle cap while the pool climbs back at the resting rate.

   C) THE BARS RUN DOWNWARD, THROUGH ZERO (16:51) — HEALTH and ENERGY
      both START at 100%, rendered all green, and tick DOWN as harm /
      exertion accrues — and they do NOT stop at empty: both continue
      INTO THE NEGATIVE. The accrual math underneath is unchanged
      (crash curves, bump points, drain/recovery rates); what changed
      is the orientation and the clamp: the damage store is no longer
      capped at 100, the energy pools have no floor, every threshold
      that fired at damage = 100 now fires at HEALTH <= 0, and every
      threshold that fired at energy = 0 now fires at ENERGY <= 0.
      Recovery climbs the negative back out at the same rates, so
      digging to -40 costs proportionally longer to recover from than
      stopping at 0. The HUD shows the true signed number.

   WHAT SURVIVES FROM .11/.16, UNCHANGED:
   - DAMAGE sources: on-foot tree/boulder bumps +1 (crashlog feed,
     walking mode only); vehicle crashes feed points at the moment of
     impact via addCrashDamage (crash_model.js computes them).
   - DAMAGE >= 50: foot speed capped at DMG_SLOW_CAP (7.6).
   - HEALTH <= 0 (damage >= 100): MAXED OUT (16:00 rule) — energy
     pools held SPENT (pinned at/below 0, no recovery, no drain), top
     speed the slow shuffle DMG_CRITICAL_CAP (2.5) on foot and in the
     water, he CAN move, and healing is standing-still-only at
     DMG_DRAIN_PER_GMIN (20/game-min: five game-minutes from exactly
     0 health back to full — longer from a negative health, because
     the climb out is part of the same rate). The crash model's
     two-game-minute exit block is its own timer, untouched.
   - ENERGY <= 0 (land): spent — foot speed capped at walk until the
     pool climbs back above 0. There is no lockout TIMER any more:
     the old 10-game-minute refill machine was the pre-.20 shape of
     this same rule, replaced by the meter itself under ruling C.
     PUSHING (demanding run speed while spent) keeps draining the
     pool deeper at the run rate — the old pushing debt, expressed
     as depth instead of minutes.
   - RESTING word: row 2 reads RESTING only at a full stop while body
     damage is draining (standing-still healing), else ENERGY.
   - Row 1 is ONE SHARED BAR (15:36): on foot HEALTH (the body's
     meter), in a vehicle DAMAGE (car.damage — displayed, never
     written here, and NOT reframed by ruling C: the car's damage
     still rises 0..100 as before). Row 2 is ENERGY: the LAND pool on
     land, the SWIM pool while swimming (ui .20 choice — the bar
     always shows the pool the water/land state is spending).

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
  /* damage / health (health = 100 - damage; thresholds on damage are
     thresholds on health read backwards: damage 50 = health 50,
     damage 100 = health 0) */
  DMG_SLOW_AT:        50,     // damage >= 50 (health <= 50) -> slowed
  DMG_FORCE_AT:       100,    // damage 100 = HEALTH 0 -> MAXED OUT
                              // (16:00 rule). Since ui .20 the store is
                              // NOT clamped here: damage may exceed 100
                              // and health reads negative (ruling C).
  DMG_DRAIN_PER_GMIN: 20,     // standing-still healing: 100 pts over
                              // exactly 5 game-minutes. Standing still
                              // ONLY (16:00); from a negative health the
                              // same rate climbs the whole depth back.
  DMG_SLOW_CAP:       7.6,    // u/s foot cap while hurt (below run, above walk)
  DMG_CRITICAL_CAP:   2.5,    // u/s cap at health <= 0 (Joshua 16:00:
                              // "you can only walk at a slow pace") —
                              // half the ordinary walk cap (5.0), a third
                              // of the 50-tier cap: a hurt shuffle, on
                              // foot and in the water alike
  /* locomotion gears (Joshua 16:29, ui .20) */
  WALK_SPEED:         5.0,    // u/s base pace on foot outdoors = the
                              // game's own walk pace (indoor speed)
  SPRINT_SPEED:       13.8,   // u/s sprint pace = the game's old full run
  SPRINT_HOLD_MS:     600,    // touch: milliseconds of holding the stick
                              // pushed UP before the sprint engages
  /* energy — land pool */
  WALK_CAP:           5.0,    // u/s foot cap while the pool is spent (<= 0)
  RUN_SPEED_MIN:      8.0,    // u/s: faster than this on foot = running
  MILE_U:             1609.34,// world units per mile (1 unit = 1 metre)
  RUN_DRAIN_PER_UNIT: 100 / 1609.34, // pool points per unit run -> a
                              // continuous run empties a full pool at
                              // 1 mile (Joshua's benchmark, confirmed in
                              // his hands 16:26 at the .11 rate)
  WALK_REC_PER_GMIN:  4,      // pool recovery while walking / driving /
                              // gentle-swimming (25 game-min to full)
  REST_REC_PER_GMIN:  10,     // pool recovery standing still (10 game-min)
  /* energy — swim pool (Joshua 16:32, ui .20) */
  SWIM_TOP_MIN:       5.4,    // u/s: above this = hard (top-speed) swimming
                              // (0.8 x the raised 6.75 u/s top speed)
  SWIM_DRAIN_PER_GMIN: 100 / 15, // hard-swim drain: ~15 game-minutes at
                              // top speed empties a full pool. The .11
                              // shared pool used 100/7 (~7 game-min) and
                              // Joshua found he was WAITING on energy
                              // instead of moving — retuned to a bit
                              // more than double the endurance.
  GENTLE_SWIM_CAP:    4.5,    // u/s swim cap while the swim pool is spent
                              // or the float rest runs = the OLD top
                              // speed: gentle swimming, no top speed
  FLOAT_REST_GMIN:    2,      // game-minutes of forced float rest when
                              // the swim pool tops out (Joshua 15:46:
                              // forced stops rest ~2 game-min floating)
  FLOAT_PUSH_EXT:     0.5,    // demanding hard swim DURING the float
                              // rest extends it +0.5 game-min per
                              // game-minute of demand (the .11 pushing
                              // rule, carried to the swim arm)
  FLOAT_REST_MAX:     7,      // float rest cap: 2 + at most 5 of pushing
  /* colours — the game's own HUD palette (matches the car damage bar) */
  GREEN:  '#3fd34f',
  YELLOW: '#ffd75e',
  RED:    '#ff5b5b'
};

/* ---------------------------------------------------------------------------
   bandColor(v) — the colour language for a 0..100 BADNESS value (the
   car's damage bar still speaks it): 0..10 GREEN, above 10 up to 50
   YELLOW, 50..100 RED.
   --------------------------------------------------------------------------- */
function bandColor(v){
  if (v <= 10) return C.GREEN;
  if (v < 50)  return C.YELLOW;
  return C.RED;
}

/* ---------------------------------------------------------------------------
   meterColor(v) — the colour language for a DOWNWARD meter (ruling C):
   HEALTH / ENERGY read as goodness — full is GREEN, the descent passes
   the same staging the old badness bars used, mirrored: above 90
   GREEN, above 50 YELLOW, 50 and below RED, and at/below zero RED
   (the bar is empty; the number carries the negative truth).
   --------------------------------------------------------------------------- */
function meterColor(v){
  if (v > 90) return C.GREEN;
  if (v > 50) return C.YELLOW;
  return C.RED;
}

/* ---------------------------------------------------------------------------
   meterFill(v) — the visible fill of a downward meter, in bar-percent:
   the value itself, clamped to the bar's physical ends for DRAWING
   only (100 at full, 0 at/below zero). The stored value is never
   clamped by this — the numeric readout shows the signed truth.
   --------------------------------------------------------------------------- */
function meterFill(v){
  return Math.max(0, Math.min(100, v));
}

/* ---------------------------------------------------------------------------
   dmgSegments(damage) — the DAMAGE bar's STAGED PROGRESSION (Joshua
   2026-11-07, 15:07), kept for the one place that still renders a
   rising badness meter: the CAR's damage on the shared row while
   driving (ruling C does not reframe the car's store). Three
   contiguous segments whose widths are pure functions of damage —
     green  = the 10 of green, eaten 10 -> 0 across damage 0..10
     yellow = climbs 0 -> 40 across damage 10..50 ("starts going up")
     red    = climbs 0 -> 50 across damage 50..100
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
   createSprintCore() — the sprint-engagement state machine (Joshua
   16:29, ruling A). Pure: updatePlayer feeds it one demand sample per
   frame and reads back whether the sprint gear is engaged.
     demand.touchFwd  — stick pushed mostly UP (the hold gesture)
     demand.touchHeld — stick still pushed (gear survives steering)
     demand.shiftFwd  — keyboard SHIFT + forward (immediate)
   Touch: the hold timer accrues ONLY on the forward push; once it
   crosses SPRINT_HOLD_MS the gear engages and stays engaged while
   the stick stays pushed in ANY direction (one unbroken motion);
   releasing the stick drops the gear and zeroes the timer.
   Keyboard: SHIFT + forward engages at once, no timer — the key
   combination is already a deliberate act.
   --------------------------------------------------------------------------- */
function createSprintCore(){
  var S = { engaged: false, holdMs: 0 };
  function tick(dtSec, demand){
    demand = demand || {};
    if (demand.shiftFwd){
      S.engaged = true; S.holdMs = C.SPRINT_HOLD_MS;
    } else if (S.engaged){
      if (!demand.touchHeld){ S.engaged = false; S.holdMs = 0; }
    } else if (demand.touchFwd){
      S.holdMs += (dtSec > 0 ? dtSec * 1000 : 0);
      if (S.holdMs >= C.SPRINT_HOLD_MS) S.engaged = true;
    } else {
      S.holdMs = 0;
    }
    return S.engaged;
  }
  return { state: S, tick: tick };
}

/* ---------------------------------------------------------------------------
   createBodyCore() — the pure state machine. env for tick():
     { mode: 'foot'|'swim'|'drive', speed: u/s (post-cap, actual),
       demandSpeed: u/s (PRE-cap demand — what he is asking for; the
         exertion drain reads this, so pushing against the spent cap
         still digs, per ruling C),
       dtSec: real seconds this tick (for distance), resting: bool,
       runIntent: bool (full stick / WASD demand),
       wading: bool (in water, feet on the bottom — resets swim pool) }
   tick's first argument is elapsed GAME minutes (daycycle time).
   --------------------------------------------------------------------------- */
function createBodyCore(){
  var S = {
    damage: 0,          // body damage accrual (bumps + vehicle crashes).
                        // NO upper clamp since ui .20 — health = 100 -
                        // damage reads negative past 100 (ruling C).
    energy: 100,        // LAND pool: 100 = fresh, drains running,
                        // recovers walking/resting, NO floor (ruling C)
    swimEnergy: 100,    // SWIM pool: its own meter (ruling B), same shape
    floatRest: 0,       // game-minutes of forced float rest remaining
                        // (0 = none); set when the swim pool tops out
    restingShow: false  // HUD state word: true -> RESTING, false -> ENERGY
  };

  /* HEALTH — the presented meter (ruling C): starts at 100, ticks
     down with damage, reads negative when damage exceeds 100. */
  function health(){ return 100 - S.damage; }

  /* One accepted tree/boulder bump = +1 damage. Unchecked kinds are
     ignored (crashlog only ever feeds tree/boulder). No clamp: a
     bump at health -20 takes him to -21 — depth is the ruling-C
     point, for healing time as much as for the number. */
  function addBump(kind){
    if (kind !== 'tree' && kind !== 'boulder') return false;
    S.damage += 1;
    return true;
  }

  /* Vehicle-crash damage (crash_model.js): points land on the same
     meter bumps feed, AT THE MOMENT OF IMPACT (Joshua 15:55). Returns
     the meter's new value — crash_model reads >= DMG_FORCE_AT (100)
     as the maxed-out / incapacitation case, which stays true for
     every value past it. No clamp (ruling C). */
  function addCrashDamage(n){
    n = Math.max(0, n || 0);
    if (n <= 0) return S.damage;
    S.damage += n;
    return S.damage;
  }

  function tick(g, env){
    if (!(g > 0)) g = 0;

    /* --- DAMAGE: standing still — and ONLY standing still — drains
       it, visibly and proportionally (Joshua 16:00: "increase health
       by standing still for five game minutes"; the 20-per-game-minute
       rate spans exactly 100 -> 0 in those five — and keeps spanning
       the negative the same way: health -40 is 140 of damage, seven
       game-minutes of standing to full). Moving never heals, not even
       the maxed-out slow shuffle: env.resting is a full stop. Seated
       in a car the wiring never reports resting, so a meter maxed in
       a wreck holds through the stuck wait unaided. The floor is 0
       damage: health never exceeds 100. --- */
    if (env.resting && S.damage > 0){
      S.damage = Math.max(0, S.damage - C.DMG_DRAIN_PER_GMIN * g);
      /* snap the last hair to exactly 0: fractional frame deltas can
         otherwise leave the meter at 1e-14 forever, holding the
         RESTING word and the 50-tier logic on a ghost of damage */
      if (S.damage < 0.01) S.damage = 0;
    }

    /* --- MAXED OUT (health <= 0): energy is SPENT (Joshua 16:00) —
       both pools are pinned at/below zero (a positive pool drops to
       0; a pool already dug negative keeps its depth — no gift), and
       NEITHER pool drains or recovers while maxed: the body's whole
       economy waits on the standing-still healing above. The float
       rest, if one was running, is moot under the critical cap and
       is cleared. The tick damage drops below 100 the ordinary rules
       below resume from the held values. --- */
    if (S.damage >= C.DMG_FORCE_AT){
      if (S.energy > 0) S.energy = 0;
      if (S.swimEnergy > 0) S.swimEnergy = 0;
      S.floatRest = 0;
    } else if (env.mode === 'swim'){
      /* --- SWIM POOL (ruling B): hard swimming burns it by TIME at
         the retuned rate; gentle swimming recovers it at the walking
         rate while still in the water. The LAND pool is not touched
         here — a tired swimmer who climbs out walks on a fresh pool. */
      if (S.floatRest > 0){
        /* FLOAT REST (Joshua 15:46): a topped-out pool forces ~2
           game-minutes floating. capSpeed holds him at the gentle
           cap meanwhile; the pool climbs back at the RESTING rate
           (he is resting, on the water). Demanding hard swim during
           the rest extends it (the pushing rule) instead of draining
           — he is capped at gentle either way, so the demand can only
           cost him time. */
        S.floatRest -= g;
        if (env.runIntent && env.demandSpeed > C.SWIM_TOP_MIN){
          /* the extension may never push the REMAINING rest past the
             cap (2 + at most 5 of pushing = FLOAT_REST_MAX) */
          if (S.floatRest + C.FLOAT_PUSH_EXT * g <= C.FLOAT_REST_MAX)
            S.floatRest += C.FLOAT_PUSH_EXT * g;
        }
        if (S.floatRest < 0) S.floatRest = 0;
        S.swimEnergy = Math.min(100, S.swimEnergy + C.REST_REC_PER_GMIN * g);
      } else if (env.speed > C.SWIM_TOP_MIN || env.demandSpeed > C.SWIM_TOP_MIN){
        /* Hard swim: drain by the DEMANDED pace when he is pushing
           past the gentle line (env.speed is post-cap; a spent pool
           caps the actual, the demand is the exertion — ruling C's
           no-clamp logic, same as land). Crossing zero tops the pool
           out and the float rest begins. */
        S.swimEnergy -= C.SWIM_DRAIN_PER_GMIN * g;
        if (S.swimEnergy <= 0 && env.speed > C.SWIM_TOP_MIN)
          S.floatRest = C.FLOAT_REST_GMIN;
      } else {
        S.swimEnergy = Math.min(100, S.swimEnergy + C.WALK_REC_PER_GMIN * g);
      }
      /* Wading cannot occur in swim mode (swimming means off the
         bottom by definition in updatePlayer) — the reset lives in
         the foot branch below. */
    } else {
      /* --- LAND POOL: mode 'foot' or 'drive' (driving exerts nothing
         and recovers at the walking rate, as .11). The SWIM pool
         recovers here too — out of the water he is resting from
         swimming (walking rate moving, resting rate standing), so a
         later swim starts from what rest earned it. Only the DRAIN
         is pool-specific; recovery is the body recovering. --- */
      var rec = (env.mode === 'foot' && env.speed < 0.1 && !env.runIntent)
                  ? C.REST_REC_PER_GMIN : C.WALK_REC_PER_GMIN;
      if (!env.wading)
        S.swimEnergy = Math.min(100, S.swimEnergy + rec * g);

      if (env.mode === 'foot'){
        /* Exertion reads the DEMAND (pre-cap): at full health the
           demand and the actual agree; while spent, the cap holds
           the actual at walk but a player still demanding run speed
           keeps digging (ruling C) instead of recovering. */
        var exert = Math.max(env.speed, env.runIntent ? (env.demandSpeed || 0) : 0);
        if (exert > C.RUN_SPEED_MIN){
          S.energy -= exert * env.dtSec * C.RUN_DRAIN_PER_UNIT; // by DISTANCE
        } else if (env.speed < 0.1){
          S.energy = Math.min(100, S.energy + C.REST_REC_PER_GMIN * g);
        } else {
          S.energy = Math.min(100, S.energy + C.WALK_REC_PER_GMIN * g);
        }
      } else { /* drive */
        S.energy = Math.min(100, S.energy + C.WALK_REC_PER_GMIN * g);
      }
    }

    /* --- TOUCH BOTTOM = RESET (Joshua 16:32, ruling B): feet on the
       bottom — in the water but WALKING in it, not swimming — clears
       the swim pool completely: full, immediately, and any pending
       float rest is moot (he is standing in the shallows). Applies
       in any non-swim mode; while swimming he is off the bottom by
       definition, so the swim branch never sees it. --- */
    if (env.wading && env.mode !== 'swim'){
      S.swimEnergy = 100;
      S.floatRest = 0;
    }

    /* --- HUD state word: RESTING only at a FULL STOP while damage is
       draining (standing-still healing — the health <= 0 case
       included). Evaluated AFTER the drain, so the tick the damage
       reaches 0 the word is already ENERGY again. --- */
    S.restingShow = !!(env.resting && S.damage > 0);
  }

  /* Speed governor — updatePlayer calls this on its computed speed.
     Health <= 0 = the slow shuffle (DMG_CRITICAL_CAP), foot and swim
     alike: he CAN move (Joshua 16:00 replaced the zero-input lock).
     Damage 50-99 caps foot speed at the hurt tier. A SPENT pool
     (energy <= 0, ruling C's threshold) caps foot speed at walk and
     swim speed at gentle; a running FLOAT REST caps swim at gentle.
     Where caps apply together the stricter (smaller) cap wins. */
  function capSpeed(spd, mode){
    var cap = spd;
    if (mode === 'foot'){
      if (S.damage >= C.DMG_FORCE_AT) cap = Math.min(cap, C.DMG_CRITICAL_CAP);
      else {
        if (S.energy <= 0) cap = Math.min(cap, C.WALK_CAP);
        if (S.damage >= C.DMG_SLOW_AT) cap = Math.min(cap, C.DMG_SLOW_CAP);
      }
    } else if (mode === 'swim'){
      if (S.damage >= C.DMG_FORCE_AT) cap = Math.min(cap, C.DMG_CRITICAL_CAP);
      else if (S.swimEnergy <= 0 || S.floatRest > 0)
        cap = Math.min(cap, C.GENTLE_SWIM_CAP);
    }
    return cap;
  }

  /* ---- FULL DIVE HOOKS (ui 2026.11.07.24) --------------------------
     Two small doors for dive_system.js, so the dive EXTENDS this
     system instead of reaching into its state:
     touchBottom() — the player touched the bed while diving: the same
       reset this tick's wading arm applies (swim pool full, any float
       rest cleared), because bed contact is bed contact.
     beginFloatRest() — a FORCED stop starts now (the dive calls it
       when a breath-out forced resurface reaches the surface): the
       float rest runs its full ruled length from this moment. */
  function touchBottom(){
    S.swimEnergy = 100;
    S.floatRest = 0;
  }
  function beginFloatRest(){
    if (S.floatRest < C.FLOAT_REST_GMIN) S.floatRest = C.FLOAT_REST_GMIN;
  }

  return {
    state: S,
    addBump: addBump,
    addCrashDamage: addCrashDamage,
    tick: tick,
    capSpeed: capSpeed,
    touchBottom: touchBottom,
    beginFloatRest: beginFloatRest,
    health: health,
    /* fatigue(): the pre-.20 badness readout of the LAND pool, kept
       for any reader still speaking that language — 100 - energy,
       unclamped (a dug-negative pool reads above 100). */
    fatigue: function(){ return 100 - S.energy; },
    label: function(){ return S.restingShow ? 'RESTING' : 'ENERGY'; }
  };
}

/* Test seam (same pattern as crashlog's _identify): the pass harness loads
   this file with stubbed globals and drives the cores directly. */
if (typeof window !== 'undefined'){
  window.__BODY_CORE = {
    create: createBodyCore, createSprint: createSprintCore, C: C,
    bandColor: bandColor, dmgSegments: dmgSegments,
    meterColor: meterColor, meterFill: meterFill
  };
}

/* ===========================================================================
   GAME WIRING — HUD + Sim tick + the window.__BODY facade. Everything below
   is guarded: no document / no Sim / no player -> nothing happens.
   =========================================================================== */
if (typeof document === 'undefined' || typeof window === 'undefined') return;

var core = createBodyCore();
var sprint = createSprintCore();

/* The facade index.html and crashlog.js call:
   - __BODY.addBump(kind, mode): crashlog hook — WALKING bumps only.
   - __BODY.addCrashDamage(n): crash_model.js's feed (points at impact).
   - __BODY.forcedRest(): the ANIMATION paths' exhaustion-posture
     condition — since the 16:00 amendment it reports "health <= 0"
     (maxed out) and gates NO movement; the name is historical.
   - __BODY.capSpeed(spd, mode): updatePlayer speed governor.
   - __BODY.sprintTick(dtSec, demand): updatePlayer's sprint gear
     (ruling A) — returns true while the sprint gear is engaged. */
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
  forcedRest: function(){ return core.state.damage >= C.DMG_FORCE_AT; },
  capSpeed: function(spd, mode){ return core.capSpeed(spd, mode); },
  sprintTick: function(dtSec, demand){ return sprint.tick(dtSec, demand); },
  /* FULL DIVE (ui 2026.11.07.24): dive_system.js's two doors into the
     body — bed contact while diving resets the swim pool (the wading
     rule), and a breath-out forced resurface starts the float rest
     when it reaches the surface. */
  touchBottom: function(){ return core.touchBottom(); },
  beginFloatRest: function(){ return core.beginFloatRest(); }
};

/* --- HUD: two compact rows above the minimap, styled like the car's
   #dmg-wrap (same pill, same 10px bars, same palette). Built here (the
   daycycle/crashlog pattern) so index.html needs no markup edits.
   Row 1: HEALTH (on foot) / DAMAGE (in a vehicle) — on foot the body's
   DOWNWARD health meter (ruling C: one fill, meterColor staging, the
   signed number); while driving the car's damage in the staged
   green/yellow/red progression segments, exactly as before.
   Row 2: ENERGY/RESTING — the downward meter of whichever pool the
   state is spending (land on land, swim in the water), meterColor
   staging, signed number. --- */
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
    /* the number column is wide enough for a signed 3-digit value
       ("-100") — ruling C's negatives must never clip */
    '#body-wrap .bnum{width:32px;text-align:right;font-variant-numeric:tabular-nums;}' +
    '@media (max-width:520px){#body-wrap .bbar{width:84px;}}';
  document.head.appendChild(st);
  var el = document.createElement('div');
  el.id = 'body-wrap';
  el.innerHTML =
    '<div class="brow"><span class="btag" id="bd-tag">HEALTH</span>' +
      '<div class="bbar"><div class="bseg" id="bd-g"></div>' +
      '<div class="bseg" id="bd-y"></div><div class="bseg" id="bd-r"></div></div>' +
      '<span class="bnum" id="bd-num">100</span></div>' +
    '<div class="brow"><span class="btag" id="bf-tag">ENERGY</span>' +
      '<div class="bbar"><div class="bseg" id="bf-fill"></div></div>' +
      '<span class="bnum" id="bf-num">100</span></div>';
  document.body.appendChild(el);
  /* UI CHECK PASS (2026-11-07): these bars are a HUD control and
     must be in the move/layout system the moment they exist —
     Joshua could NOT move the HEALTH bar because nothing ever
     registered it. hud_move v2.2 also DISCOVERS body-level
     controls on its own; this register() call (the v2.1 extension
     point, built for exactly this) is the belt to that net, and
     it carries the friendly name + resizable flag. Guarded: no
     HudMove module, no change at all. */
  try {
    if (window.HudMove && HudMove.register)
      HudMove.register('body-wrap', { name: 'Health + energy bars', resizable: true });
  } catch (e) { /* the layout system is an enhancement, never a dependency */ }
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
   the BODY's health under the word HEALTH — since ui .20 a DOWNWARD
   meter (ruling C): one fill of meterFill(health) wearing the
   meterColor staging, the other two segments parked at 0, and the
   number the signed health itself (negative past empty). In a
   vehicle it shows the CAR's damage (car.damage, sampled fresh each
   tick by bodyTick into dispVehDmg) under the word DAMAGE, rendered
   by the original staged segments — the car's store is not reframed.
   Row 2 (ENERGY) is the body's own in both modes: the LAND pool on
   land and in a vehicle, the SWIM pool while swimming (dispSwimming,
   sampled by bodyTick) — always a downward meter with its signed
   number. */
function paintHud(){
  if (!hud) return;
  var S = core.state;
  var word = dispDriving ? 'DAMAGE' : 'HEALTH';
  var pool = dispSwimming ? S.swimEnergy : S.energy;
  var poolRound = Math.round(pool);
  if (dispDriving){
    var carRound = Math.round(dispVehDmg);
    var key = word + '|' + carRound + '|' + poolRound + '|' + core.label();
    if (key === hud.last) return;
    hud.last = key;
    var seg = dmgSegments(dispVehDmg);
    hud.g.style.width = seg.g + '%';
    hud.y.style.width = seg.y + '%';
    hud.r.style.width = seg.r + '%';
    hud.g.style.background = C.GREEN;
    hud.y.style.background = C.YELLOW;
    hud.r.style.background = C.RED;
    hud.dNum.textContent = carRound;
    hud.dNum.style.color = bandColor(dispVehDmg);
  } else {
    var h = core.health(), hRound = Math.round(h);
    var key2 = word + '|' + hRound + '|' + poolRound + '|' + core.label();
    if (key2 === hud.last) return;
    hud.last = key2;
    hud.g.style.width = meterFill(h) + '%';
    hud.g.style.background = meterColor(h);
    hud.y.style.width = '0%';
    hud.r.style.width = '0%';
    hud.dNum.textContent = hRound;
    hud.dNum.style.color = meterColor(h);
  }
  hud.dTag.textContent = word;
  hud.fFill.style.width = meterFill(pool) + '%';
  hud.fFill.style.background = meterColor(pool);
  hud.fNum.textContent = poolRound;
  hud.fNum.style.color = meterColor(pool);
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
   renders — read defensively each tick; this module never writes it.
   dispSwimming (ui .20) is row 2's context: while swimming the ENERGY
   row shows the SWIM pool; everywhere else the LAND pool. */
var dispDriving = false, dispVehDmg = 0, dispSwimming = false;
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
    dispSwimming = swimming && !driving;
    var mode = driving ? 'drive' : (swimming ? 'swim' : 'foot');
    var speed = driving ? 0 : (player.speed || 0);
    /* the PRE-governor demand updatePlayer recorded (ui .20): the
       exertion drain reads it, so pushing against a spent cap digs */
    var demandSpeed = driving ? 0 : (player.demandSpeed || 0);
    var resting = !driving && !swimming && speed < 0.1;
    /* WADING (ui .20): in the water but NOT swimming — updatePlayer
       only sets swimming at depth >= SWIM_DEPTH, so in-water-on-foot
       is feet-on-the-bottom by construction. Drives the core's
       touch-bottom swim-pool reset (Joshua 16:32). */
    var wading = false;
    if (!driving && !swimming){
      try{ wading = !player.inside && typeof inWater === 'function' &&
                    !!inWater(player.x, player.z); }catch(e){}
    }
    /* run demand: WASD (sampled snapshot, like updatePlayer) or a hard
       stick push — used for the exertion demand and float-rest pushing. */
    var runIntent = false;
    try{
      var ik = (window.Input && Input.sampled) ? Input.keys : window.keys;
      if (ik && (ik['w'] || ik['a'] || ik['s'] || ik['d'])) runIntent = true;
      if (!runIntent && typeof joy !== 'undefined' && joy && joy.active &&
          Math.hypot(joy.dx || 0, joy.dy || 0) > 0.55) runIntent = true;
    }catch(e){}

    core.tick(gMin, { mode: mode, speed: speed, demandSpeed: demandSpeed,
                      dtSec: dtSec, resting: resting,
                      runIntent: runIntent, wading: wading });
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
