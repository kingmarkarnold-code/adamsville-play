/* ============================================================================
   CRASH MODEL — vehicle crashes hurt the CAR and the PLAYER (Joshua
   2026-11-07, 15:39-15:40). Joshua's rule: all code commented.

   Joshua's words: "Driving into something should damage the car and the
   vehicle and the player depending on speed. 35 miles per hour hit a
   building it damages the car. 125 miles per hour and hit a building and
   the player becomes incapacitated — so let's for now make it so that it
   maxes you out and you're stuck in the car for two minutes before you
   can get out even though the car is fully damaged." And: "make the
   vehicle know what it hit so it knows how much damage to take off."

   WHAT WAS ALREADY THERE (audit before this pass — nothing duplicated):
   - car.damage (0..100) is index.html's store, fed ONLY by its addDamage()
     (dents at 35, smoke at 65, engine dead at 100, HUD + toasts). Three
     call sites, all flat speed multiples with NO idea what was hit:
     the push-out seam (spd*1.7), car-vs-car (spd*1.2), and the
     bus/semi/traffic push-out (spd*1.2). A fourth stop — the material
     gate (canMoveTo) refusing the move — dealt NO damage at all, which
     is the path a head-on building hit usually takes (the gate stops
     the car before the push-out solver ever sees an overlap).
   - The BODY's damage meter is body_systems.js (window.__BODY): on-foot
     tree/boulder bumps only. This pass adds its crash feed
     (__BODY.addCrashDamage); the store and its rules stay there.
   - WHAT WAS HIT is identified by the game's own collision diagnostics:
     crashlog.js's identify() (CrashLog._identify) reads the same
     registries the bump messages use — package tree trunks and boulders
     name themselves, bldgGrid names buildings, segColliders walls, and
     the legacy propGrid lumps its props together. The vehicle-vehicle
     seams know their object directly (another vehicle). index.html's
     crashKindAt() wraps this (with the material at the refused
     destination as fallback for what the registries can't name — a
     person is a dynamic material, not a registry entry).

   THE MODEL (this file's craft, anchored on Joshua's two points):
   - CAR damage: 0 at <= 5 mph, then 100 * s^1.15 with s = (mph-5)/120,
     scaled by the struck object's hardness. 35 mph into a building =
     20 (real damage, well short of totalled — the old flat formula
     gave ~28 there). 125 mph into a building = 100 (fully damaged).
   - PLAYER damage: 0 at <= 12 mph (a parking-lot tap costs the player
     nothing), then 100 * s^1.6 with s = (mph-12)/113, hardness-scaled.
     35 mph into a building = 8. 125 mph into a building = 100 = MAXED
     OUT (the HEALTH scale's 100) -> INCAPACITATED.
   - Hardness order (both stores): building > wall > boulder > tree >
     unknown > vehicle > prop > person. A person is soft: the car takes
     ~nothing and the player nothing — running someone down is not a
     crash model question. 'prop' is the legacy registry's lump (tree,
     sign or post — the registry itself cannot tell them apart, so the
     model honestly prices the lump, mid-table). 'unknown' is whatever
     stopped the car that no registry could name.
   - Both curves are monotone in speed for any fixed object, and
     monotone in hardness for any fixed speed (harness-proven).

   INCAPACITATION: a crash whose player damage takes the body meter to
   100 leaves him STUCK IN THE CAR for TWO MINUTES — exitCar refuses
   (water exits excepted: a sinking car is not a waiting room) and a
   banner counts the wait down. The two minutes run on the GAME clock
   (WorldClock game-minutes — the same basis as every body-systems
   timer; stated plainly so Joshua can correct it if he meant real
   minutes: 2 game-minutes ≈ 10 real seconds at the game's clock rate).
   While he is seated the body meter HOLDS at 100 (healing requires
   standing still, and he is not standing); the moment he gets out, the
   damage-100 rule applies on foot (Joshua 16:00, replacing the old
   forced rest): ENERGY spent, top speed cut to a slow walk, and
   standing still for five game-minutes heals him back to 0.

   SCOPE: vehicle crashes only. On-foot bumps are untouched (.11).
   The bars (.14) only DISPLAY these stores; nothing here paints.

   Structure mirrors body_systems.js: createCrashCore() is a pure state
   machine (no DOM, no game globals) exposed as window.__CRASH_CORE for
   the pass harness; the game wiring below is fully defensive.
   ============================================================================ */
(function CrashModel(){
'use strict';

/* ---------------------------------------------------------------------------
   CONSTANTS — Joshua's anchors are exact; the curve between them is craft.
   --------------------------------------------------------------------------- */
var K = {
  STUCK_MINUTES: 2,      // game-minutes stuck in the car when incapacitated
                         // (Joshua: "stuck in the car for two minutes")
  CAR_ZERO_MPH: 5,       // at/below this the car takes nothing
  CAR_FULL_MPH: 125,     // his incapacitation anchor speed (building)
  BODY_ZERO_MPH: 12,     // at/below this the player takes nothing
  BODY_FULL_MPH: 125     // (125 - 12 = the 113 in the body curve)
};

/* Hardness factors per struck-object kind, one per store. The ORDER is
   the doctrine (harder object = more damage at the same speed); the
   values space the kinds so the differences are felt, not just ranked. */
var HARD = {
  building: { car: 1.00, body: 1.00 },
  wall:     { car: 0.95, body: 0.95 },
  boulder:  { car: 0.90, body: 0.90 },
  tree:     { car: 0.75, body: 0.70 },
  unknown:  { car: 0.70, body: 0.65 },
  vehicle:  { car: 0.60, body: 0.55 },
  prop:     { car: 0.50, body: 0.45 },
  person:   { car: 0.05, body: 0.00 }
};
function hardness(kind){
  return HARD[kind] || HARD.unknown;
}

/* Car damage for an impact at `mph` into `kind` (0..100 points).
   s runs 0 at 5 mph to 1 at 125 mph; the 1.15 exponent keeps low-speed
   hits light and lets the top end arrive exactly at the anchor. */
function carDamageFor(mph, kind){
  mph = Math.abs(mph || 0);
  if (mph <= K.CAR_ZERO_MPH) return 0;
  var s = Math.min(1, (mph - K.CAR_ZERO_MPH) / (K.CAR_FULL_MPH - K.CAR_ZERO_MPH));
  return Math.round(100 * Math.pow(s, 1.15) * hardness(kind).car);
}

/* Player (body) damage for the same impact (0..100 points on the HEALTH
   scale). The 12 mph deadband is the parking-lot rule; the 1.6 exponent
   keeps the player safer than the car at street speeds and still lands
   exactly on 100 at the 125 mph building anchor. */
function bodyDamageFor(mph, kind){
  mph = Math.abs(mph || 0);
  if (mph <= K.BODY_ZERO_MPH) return 0;
  var s = Math.min(1, (mph - K.BODY_ZERO_MPH) / (K.BODY_FULL_MPH - K.BODY_ZERO_MPH));
  return Math.round(100 * Math.pow(s, 1.6) * hardness(kind).body);
}

/* ---------------------------------------------------------------------------
   createCrashCore() — the pure state machine. It computes the two damage
   numbers and owns the ONE piece of state the model adds: the stuck
   timer (game-minutes remaining on the exit block). The stores
   themselves live elsewhere (car.damage in index.html, body damage in
   body_systems.js) — this core never writes them; the wiring feeds them
   and reports the body's resulting value back via noteCrash().
   --------------------------------------------------------------------------- */
function createCrashCore(){
  var S = {
    stuckMin: 0,      // game-minutes of exit block remaining (0 = free)
    lastCrash: null   // {mph, kind, car, body} of the latest registration
  };

  function damageFor(mph, kind){
    return { car: carDamageFor(mph, kind), body: bodyDamageFor(mph, kind) };
  }

  /* Record a registered crash. `bodyAfter` is the body meter's value
     AFTER this crash's player damage was fed (null when no player
     damage applied or the body module is absent). A crash that deals
     player damage and leaves the meter maxed = incapacitation: the
     stuck timer starts at Joshua's two minutes. */
  function noteCrash(mph, kind, bodyAfter){
    var d = damageFor(mph, kind);
    S.lastCrash = { mph: Math.abs(mph || 0), kind: kind || 'unknown',
                    car: d.car, body: d.body };
    if (d.body > 0 && typeof bodyAfter === 'number' && bodyAfter >= 100)
      S.stuckMin = K.STUCK_MINUTES;
    return d;
  }

  /* Advance the stuck timer by elapsed GAME minutes. */
  function tick(g){
    if (S.stuckMin > 0) S.stuckMin = Math.max(0, S.stuckMin - (g > 0 ? g : 0));
  }

  function exitBlocked(){ return S.stuckMin > 0; }

  return { state: S, damageFor: damageFor, noteCrash: noteCrash,
           tick: tick, exitBlocked: exitBlocked };
}

/* Test seam (the body_systems / crashlog pattern): the pass harness
   loads this file with stubbed globals and drives the core directly. */
if (typeof window !== 'undefined'){
  window.__CRASH_CORE = {
    create: createCrashCore, K: K, HARD: HARD,
    carDamageFor: carDamageFor, bodyDamageFor: bodyDamageFor
  };
}

/* ===========================================================================
   GAME WIRING — the window.__CRASH facade index.html's seams call, the
   stuck banner, and the game-clock countdown. Guarded throughout: no
   document / no Sim / no body module -> the model quietly does nothing
   and index.html's seams fall back to their pre-.15 flat formulas.
   =========================================================================== */
if (typeof document === 'undefined' || typeof window === 'undefined') return;

var core = createCrashCore();

function fmtStuckLeft(){
  var totalSec = Math.max(0, Math.ceil(core.state.stuckMin * 60));
  var m = Math.floor(totalSec / 60), s = totalSec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/* The facade. apply() is called by index.html's crashImpact() with the
   car's damage feeder passed IN (index.html's own addDamage — the one
   function that writes car.damage, with its dents/smoke/death/HUD), so
   this module never touches the car store directly. */
window.__CRASH = {
  core: core,
  damageFor: function(mph, kind){ return core.damageFor(mph, kind); },
  apply: function(carObj, mph, kind, feedCarDamage){
    var d = core.damageFor(mph, kind);
    /* the car: through index.html's feeder only */
    if (d.car > 0 && typeof feedCarDamage === 'function'){
      try{ feedCarDamage(carObj, d.car); }catch(e){}
    }
    /* the player: through body_systems' crash feed only */
    var bodyAfter = null;
    if (d.body > 0){
      try{
        if (window.__BODY && window.__BODY.addCrashDamage)
          bodyAfter = window.__BODY.addCrashDamage(d.body);
      }catch(e){}
      /* UI CHECK PASS (Joshua 2026-11-07 16:14): the harm pop-up
         that fired here ("That one hurt YOU, not just the car")
         is removed by his ruling — the HEALTH bar shows the body
         damage (on exit, per the 15:55 design), and the pop-up
         only duplicated it. The damage itself is unchanged. */
    }
    core.noteCrash(mph, kind, bodyAfter);
    /* The badly-hurt pop-up that fired here on exit-block is also
       removed (same ruling) — the #crash-stuck banner below
       carries that state persistently, with its countdown, for
       exactly as long as the block lasts. */
    return d;
  },
  exitBlocked: function(){ return core.exitBlocked(); },
  stuckText: function(){
    return "You're badly hurt — stuck in the car (" + fmtStuckLeft() + ' left)';
  }
};

/* --- the stuck banner: a small fixed notice, visible only while the
   exit block runs, counting down on the game clock. Built here (the
   body_systems pattern) so index.html needs no markup edits. --- */
var banner = null;
function buildBanner(){
  if (banner || !document.body) return;
  var el = document.createElement('div');
  el.id = 'crash-stuck';
  el.style.cssText = 'position:fixed;left:50%;top:16%;transform:translateX(-50%);' +
    'z-index:99990;pointer-events:none;display:none;' +
    'background:rgba(60,10,10,0.88);color:#ffd7d7;border:1px solid #ff5b5b;' +
    'border-radius:9px;padding:9px 16px;font:600 15px system-ui,sans-serif;' +
    'text-align:center;max-width:88vw;';
  document.body.appendChild(el);
  banner = el;
}
function paintBanner(){
  if (!banner) return;
  if (core.exitBlocked()){
    banner.textContent = "💥 You're badly hurt — stuck in the car (" +
      fmtStuckLeft() + ' left)';
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }
}

/* --- countdown tick on the Sim render phase. Game-minute deltas come
   from WorldClock, exactly as body_systems takes them (a paused sim
   pauses the wait; clock SETS never count). The tick the block expires
   he is told he can get out. --- */
var lastClockTotal = null, wasBlocked = false;
function crashTick(dt){
  try{
    if (!banner) buildBanner();
    var dtSec = (typeof dt === 'number' && dt > 0) ? dt : 0;
    var gMin = dtSec * (1440 / 7440);
    try{
      var clk = window.WorldClock || window.__daycycle;
      if (clk && typeof clk.gameMin === 'number' && typeof clk.dayNum === 'number'){
        var total = clk.dayNum * 1440 + clk.gameMin;
        if (lastClockTotal !== null){
          var delta = total - lastClockTotal;
          if (delta >= 0 && delta <= 1) gMin = delta;
        }
        lastClockTotal = total;
      }
    }catch(e){}
    core.tick(gMin);
    paintBanner();
    if (wasBlocked && !core.exitBlocked()){
      try{ showToast('You can get out now', 2200); }catch(e){}
    }
    wasBlocked = core.exitBlocked();
  }catch(e){}
}

/* Boot poll (the body_systems pattern): register once the Sim registry
   exists. Priority 47: just after body_systems (46) — order between the
   two consumers is not load-bearing; both read the same clock. */
var bootTries = 0;
var bootTimer = setInterval(function(){
  bootTries++;
  try{
    if (typeof Sim !== 'undefined' && Sim && typeof Sim.onTick === 'function'){
      clearInterval(bootTimer);
      Sim.onTick('render', 47, crashTick);
    } else if (bootTries > 600){ clearInterval(bootTimer); } // ~2 min, give up quietly
  }catch(e){ if (bootTries > 600) clearInterval(bootTimer); }
}, 200);

})();
