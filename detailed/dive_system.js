/* ============================================================================
   DIVE SYSTEM — the full dive (Joshua 2026-11-07 15:34: "build the full
   dive, all three pieces"; mechanics rulings 15:46–15:54 + 16:32).
   Shipped in ui 2026.11.07.24. Joshua's rule: all code commented.

   ui 2026.11.07.26 FIX (Joshua + Jess, 2026-11-07 19:59: nobody could
   dive in live play, touch OR keyboard, on an iPad or the TCL): the
   .24 wiring RE-SAMPLED its input inside this module via
   diveSampleFwd() — a parallel read. The touch half could never work:
   `joy` is declared inside index.html's indirect-eval scope and was
   never published to window (keys/drive were hand-published;
   __publishWorldSurface's list never carried joy), so an external
   script's `typeof joy` is 'undefined' and the joystick demand
   silently read as zero. The keyboard half depended on this module's
   own snapshot read instead of the values updatePlayer itself had
   just used. THE .26 LAW: the dive demand is the SAME mvz
   updatePlayer computed for surface swimming, passed in as an
   argument (plus the same frame's key snapshot for the arrow keys,
   which are look keys for movement but dive keys per Joshua's
   ruling). Whatever propels him on the surface now dives him —
   by construction, on every input family. diveSampleFwd() survives
   only as a fallback for a caller that passes no demand.

   ui 2026.11.08.3 FIX (Joshua 2026-11-07 22:25, on ui 2026.11.08.2:
   "I'm still unable to dive in the water... And swim underwater."):
   the DEPTH GATE was dead on every real stream. diveDepthUAt()'s
   units repair — the branch that converts a profiled stream's
   surveyed surface-minus-bed gap from terrain-Y units to true
   metres — was guarded on `typeof pkgStreamYAt === 'function'`
   (plus streamSpan / distToPolyline). Those three helpers live
   inside index.html's indirect-eval scope and were never on its
   __publishWorldSurface list, so from THIS module they are
   'undefined' in production and the branch never ran — silently,
   because the guard made the skip look intentional. The river's
   envelope therefore stayed at waterDepthAt()'s raw answer
   (~1.57 terrain-Y units at the surveyed 3.6 m channel), and
   maxDive collapsed to ~0.2u: the head never went under
   (HEAD_UNDER_U is 0.35), breath never drained, and the dive read
   as "not there" on the Chattahoochee everywhere. The .26 harness
   could not see it because its composition evaluated the core
   block in the same context as this module, where the helpers
   ARE globals. Proven in a real headless boot of the shipped
   build (fixes-2026-11-07-divelive): the guards read
   pkgStreamYAt/streamSpan/distToPolyline = 'undefined', the
   deepest stem station's waterDepthAt = 1.658, and a held W at
   the Nov-1 station capped depth at 0.175u. THE FIX: this module
   now carries its own faithful copies of the three tiny geometry
   helpers, run over the PUBLISHED WATER data (the entries carry
   river/profYs/widths), so the conversion executes in production
   exactly as designed — the Chattahoochee's 3.6 m channel now
   yields maxDive ~2.24u, as the .24/.26 harnesses always
   measured in their compositions. Lakes were never affected
   (their branch of waterDepthAt already returns person units).
   The same pass adds the 'dive' Report readout (module version +
   live chain values) so any future device-side divergence is
   visible in Joshua's next Player Report instead of invisible.

   THE THREE PIECES:
   1. SEE-IN WATER — lives in index.html's pwWaterMat (the package water
      sheets are now transparent + double-sided with a tuned opacity);
      this module owns pieces 2 and 3 and the breath.
   2. UNDERWATER LOOK — when the CAMERA goes under the surface, this
      module's render tick lays a depth-graded murk over the scene:
      fog colour + background take a blue-green cast scaled by
      daycycle's published light level (so night underwater is nearly
      black, composing with the ui .1 lighting curve), and fog near/far
      close in with depth (visibility shortens as you go deeper). No
      post-processing — just fog + colour, which the A17 affords. The
      water surface itself is an unlit double-sided shader, so from
      below it stays BRIGHT against the murk: the bright ceiling.
   3. DIVE LOCOMOTION — NO dive button exists and none is added. While
      swimming, the vertical axis is INVERTED on both inputs: pushing
      UP (touch stick up / swipe up / W / up-arrow) swims DOWN, pushing
      DOWN rises. Pushing up at the surface STARTS a dive; pushing down
      until the depth reads zero returns to surface swimming. The camera
      pitches with the swim (updateCamera reads __DIVE.view()) and sinks
      toward the water so the underwater look engages during a dive.

   DEPTH GATE — the dive envelope at the player's position comes from
   the game's own depth truth, evaluated per position (NO per-name
   constants): maxDive = depth - swimTrim - BED_CLEAR, where depth is
   waterDepthAt() — the same function that already decides swimming vs
   wading — with ONE units repair: its profiled-stream branch returns
   the surveyed surface-minus-bed gap in terrain-Y units (the package
   elevation scale, 0.4348 units per metre), while its lake branch
   returns person-scale units (feet x 0.304); diveDepthUAt() converts
   the stream branch to true metres (person-scale, ~1 unit = 1 metre)
   so the Chattahoochee's measured 3.6 m channel dives like 3.6 m.
   MEASURED DATA (fixes-2026-11-07-dive/measure_depths.mjs, the game's
   own D-grid sampler over the shipped package):
   - Chattahoochee main stem: surface-bed = 3.6 m at the MEDIAN station
     (11.8 ft), max 3.81 m (12.5 ft) — deeper than the ~6 ft estimate.
   - Tatum Lake bed (the carved terrain): 0.60 m at the centre — the
     DEM cannot hold lake bathymetry (lidar reads the water surface;
     the zone build carved a 0.6 m anti-burial floor), so a lake's
     operative depth is the game's per-feature model (Tatum 12 ft),
     exactly as index.html's waterDepthAt comment already documents.
     Local carve pockets in Tatum reach 2.55 m.
   - Tatum Outlet Creek: median 0.57 m, max 2.03 m at the falls plunge;
     zero stations at swim depth — creeks stay wading-only in practice.
   The bed is solid: the envelope stops the sink BED_CLEAR above the
   (modelled) bed, and REACHING the bed fires the .20 touch-bottom
   reset through __BODY.touchBottom() — bed contact is bed contact.

   BREATH — 2 GAME MINUTES submerged maximum (the body's other clocks
   are game minutes — the .20 float rest, the damage heal; if Joshua
   meant real minutes this is the one constant to change,
   BREATH_MAX_GMIN, and it is flagged in the ship report the same way
   the crash timer was). Breath drains only while the HEAD is under
   (sink >= HEAD_UNDER_U); it refills at the surface (full from empty
   in half a game-minute). At zero: FORCED RESURFACE — the player is
   carried up regardless of input; when the surface is reached the
   dive calls __BODY.beginFloatRest() and the FORCED-STOP float rest
   (~2 game-minutes) applies, during which the dive axis stays locked.
   A VOLUNTARY ascent carries NO rest and NO penalty (15:46 ruling).
   While any float rest runs, the dive axis is locked (a forced rest
   is a forced stop — no ducking back under in the middle of it).
   Breath is its OWN meter, separate from the .20 swim-energy pool;
   both run while diving (the swim pool follows the .20 demand tiers
   via updatePlayer's demand recording, unchanged).

   BREATH BAR — its own bar, BLUE when full (blue = oxygen) through
   YELLOW to RED when nearly out. VISIBILITY RULE: shown while the
   player is swimming AND (submerged, or breath below full, or a
   forced resurface is running); hidden on land and once breath is
   full again at the surface. It is a HUD control under the .23 UI
   law: built as a positioned direct child of <body> with an id, so
   hud_move v2.2's DOM DISCOVERY picks it up on its own, AND it calls
   HudMove.register like body_systems does (belt and net, verified in
   this pass's harness).

   Structure mirrors body_systems.js: createDiveCore() is a pure state
   machine (no DOM, no game globals) exposed as window.__DIVE_CORE for
   the harness; the wiring below is guarded throughout — no document /
   no Sim / no player -> nothing happens.
   ============================================================================ */
(function DiveSystem(){

/* --- tunables ------------------------------------------------------------ */
var DIVE_C = {
  /* breath budget: 2 GAME minutes with the head under (see header) */
  BREATH_MAX_GMIN: 2.0,
  /* surface refill: 200 per game-minute = full from empty in 0.5 */
  BREATH_REFILL_PER_GMIN: 200,
  /* sink (u below surface-swim trim) at which the head goes under and
     breath starts draining — the trim already sits the origin ~1.1u
     under the surface with head + shoulders out; 0.35u more puts the
     head under */
  HEAD_UNDER_U: 0.35,
  /* vertical swim speed, u per real second (all game speeds are
     real-time; only the METERS run on game minutes) */
  DIVE_SPEED: 1.6,
  /* forced-resurface ascent, u per real second — faster than the
     voluntary axis so an empty breath always wins */
  RESURFACE_SPEED: 2.4,
  /* the envelope stops this far above the modelled bed */
  BED_CLEAR_U: 0.25,
  /* camera: sink per unit of dive depth, and the cap */
  CAM_SINK_PER_U: 0.9,
  CAM_SINK_MAX: 2.4,
  /* camera: look-target Y offset at full pitch, u */
  CAM_PITCH_Y: 2.6
};

/* This module's build stamp (ui 2026.11.08.3): carried on window.__DIVE
   and in every 'dive' Report readout, so a Player Report shows WHICH
   dive module actually ran on the device — a stale or missing module
   (the deferred loader skips this file silently: its script tag has
   an empty data-dkey) can never again masquerade as a wiring bug. */
var DIVE_MODULE_VERSION = '2026.11.08.3';

/* Breath bar colour staging (Joshua's progression): BLUE = oxygen,
   full and healthy; YELLOW = warning; RED = nearly out. */
function breathColor(b){
  if (b > 50) return '#35a7ff';   /* blue */
  if (b > 25) return '#ffd75e';   /* yellow (the HUD's house warning) */
  return '#e5484d';               /* red */
}

/* ============================================================================
   createDiveCore() — the pure state machine.
   tick(gMin, dtSec, env) -> events { bottomStart, breathOut,
   forcedSurfaced } (edge-triggered, this tick only).
   env: { swimming, fwd, maxDepthU, restLocked }
     fwd: the INVERTED dive axis demand, -1..1: +1 = the player is
       pushing UP (stick up / W) = descend; -1 = pushing DOWN = rise.
     maxDepthU: the envelope at this position (wiring computes it from
       the game's depth truth minus the swim trim and the bed
       clearance; the core only clamps).
     restLocked: a float rest is running — the dive axis is locked.
   ============================================================================ */
function createDiveCore(){
  var S = {
    depth: 0,          /* u below the surface-swim trim */
    breath: 100,       /* 0..100, percent of BREATH_MAX_GMIN */
    forced: false,     /* a breath-out forced resurface is running */
    submerged: false,  /* head under (breath draining) */
    bottom: false,     /* resting on the envelope floor (the bed) */
    pitch: 0,          /* smoothed vertical pitch, -1 (rising) .. 1 (diving) */
    prevDepth: 0
  };
  function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }

  function tick(gMin, dtSec, env){
    var ev = { bottomStart: false, breathOut: false, forcedSurfaced: false };
    if (!env || !env.swimming){
      /* out of the water: the dive is over — depth snaps home, breath
         tops back up, no latches survive */
      S.depth = 0; S.prevDepth = 0; S.forced = false;
      S.submerged = false; S.bottom = false; S.pitch = 0;
      S.breath = Math.min(100, S.breath + DIVE_C.BREATH_REFILL_PER_GMIN * (gMin || 0));
      return ev;
    }
    var maxD = Math.max(0, env.maxDepthU || 0);
    var wasBottom = S.bottom;

    if (S.forced){
      /* FORCED RESURFACE: input does not matter — an empty breath
         carries him up at RESURFACE_SPEED until the trim is home. */
      S.depth -= DIVE_C.RESURFACE_SPEED * dtSec;
      if (S.depth <= 0){
        S.depth = 0; S.forced = false;
        ev.forcedSurfaced = true;   /* wiring starts the float rest */
      }
    } else if (!env.restLocked && dtSec > 0){
      /* THE INVERTED AXIS: fwd +1 (pushing UP) descends. */
      S.depth += (env.fwd || 0) * DIVE_C.DIVE_SPEED * dtSec;
    }
    if (S.depth < 0) S.depth = 0;
    if (S.depth > maxD) S.depth = maxD;

    /* bed contact: at the envelope floor. Edge-triggered so the
       swim-pool reset fires on arrival, not every frame. */
    S.bottom = maxD > 0 && S.depth >= maxD - 0.02;
    if (S.bottom && !wasBottom) ev.bottomStart = true;

    /* camera pitch follows the vertical velocity, smoothed so the
       view leans into a descent and lifts out of a rise — no snapping */
    var vel = dtSec > 0 ? (S.depth - S.prevDepth) / dtSec : 0;
    S.prevDepth = S.depth;
    var pTgt = clamp(vel / DIVE_C.DIVE_SPEED, -1, 1);
    var pk = Math.min(1, dtSec * 5);
    S.pitch += (pTgt - S.pitch) * pk;
    if (Math.abs(S.pitch) < 0.001 && pTgt === 0) S.pitch = 0;

    /* breath: drains only with the head under; refills at the surface */
    S.submerged = S.depth >= DIVE_C.HEAD_UNDER_U;
    if (S.submerged){
      S.breath -= (100 / DIVE_C.BREATH_MAX_GMIN) * (gMin || 0);
      if (S.breath <= 0){
        S.breath = 0;
        if (!S.forced){ S.forced = true; ev.breathOut = true; }
      }
    } else {
      S.breath = Math.min(100, S.breath + DIVE_C.BREATH_REFILL_PER_GMIN * (gMin || 0));
    }
    return ev;
  }

  return { state: S, tick: tick };
}

/* Test seam (the body_systems pattern): the pass harness loads this
   file with stubbed globals and drives the core directly. */
if (typeof window !== 'undefined'){
  window.__DIVE_CORE = { create: createDiveCore, C: DIVE_C, breathColor: breathColor,
                         version: DIVE_MODULE_VERSION };
}

/* ============================================================================
   GAME WIRING — facade + breath HUD + underwater grade. Guarded: no
   document / no window -> nothing below runs.
   ============================================================================ */
if (typeof document === 'undefined' || typeof window === 'undefined') return;

var diveCore = createDiveCore();

/* Last live chain values swimY computed (ui 2026.11.08.3 telemetry):
   the report readout below republishes these ~1 Hz while swimming,
   so a Player Report from a failing device shows exactly where the
   chain stood — demand (fwd), envelope (maxD), lock (restLocked),
   and whether the water level read null (wlNull). */
var diveTele = { fwd: 0, maxD: 0, restLocked: false, wlNull: false };

/* --- game-minute clock (the bodyTick pattern: WorldClock deltas with
   a sane-frame guard, documented fallback rate) ---------------------- */
var diveLastClockTotal = null;
function diveGMin(dtSec){
  var gMin = dtSec * (1440 / 7440);
  try{
    var clk = window.WorldClock || window.__daycycle;
    if (clk && typeof clk.gameMin === 'number' && typeof clk.dayNum === 'number'){
      var total = clk.dayNum * 1440 + clk.gameMin;
      if (diveLastClockTotal !== null){
        var delta = total - diveLastClockTotal;
        if (delta >= 0 && delta <= 1) gMin = delta;
      }
      diveLastClockTotal = total;
    }
  }catch(e){}
  return gMin;
}

/* --- the dive axis demand: +1 = pushing UP/forward (descend), -1 =
   pushing DOWN/back (rise). ui .26: the demand ARRIVES from
   updatePlayer (swimY's mvzIn/ikIn arguments — the very values that
   propel surface swimming this frame); this sampler remains ONLY as
   a fallback for a caller that passes no demand. Its touch read was
   the .24 live failure: `joy` never escapes index.html's eval scope,
   so from this file it is always undefined. ------------------------- */
function diveSampleFwd(){
  var raw = 0;
  try{
    var ik = (window.Input && Input.sampled) ? Input.keys : window.keys;
    if (ik){
      if (ik['w'] || ik['arrowup']) raw -= 1;
      if (ik['s'] || ik['arrowdown']) raw += 1;
    }
    if (window.Input && Input.sampled && typeof Input.sampled.analogY === 'number')
      raw += Input.sampled.analogY;
    if (typeof joy !== 'undefined' && joy && joy.active) raw += (joy.dy || 0);
  }catch(e){}
  raw = Math.max(-1, Math.min(1, raw));
  return -raw;   /* forward reads negative in every source above */
}

/* --- stream geometry helpers (ui 2026.11.08.3): faithful local
   copies of index.html's distToPolyline / streamSpan / pkgStreamYAt.
   The originals live inside index.html's indirect-eval scope and
   are NOT published to window, so this module can never call them
   in production (that invisibility is what killed the .24 depth
   conversion — see the header). The math below is the same math,
   run over the same PUBLISHED WATER entries (river pts, profYs,
   widths all ride the entries themselves). If index.html's versions
   ever change semantics, these must change with them. ------------ */
function diveDistToPolyline(pts, x, z){
  if (!pts || pts.length < 2) return 1e9;
  var best = 1e9;
  for (var i = 0; i < pts.length - 1; i++){
    var ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
    var vx = bx - ax, vz = bz - az, len2 = vx * vx + vz * vz;
    var t = len2 > 0 ? ((x - ax) * vx + (z - az) * vz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var ddx = x - (ax + vx * t), ddz = z - (az + vz * t);
    var d = Math.sqrt(ddx * ddx + ddz * ddz);
    if (d < best) best = d;
  }
  return best;
}
function diveStreamSpan(w, x, z){
  var pts = w.river, ws = w.widths, best = 1e9, hw = (w.width || 30) / 2;
  for (var i = 0; i < pts.length - 1; i++){
    var ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
    var vx = bx - ax, vz = bz - az, len2 = vx * vx + vz * vz;
    var t = len2 > 0 ? ((x - ax) * vx + (z - az) * vz) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var dx = x - (ax + vx * t), dz = z - (az + vz * t);
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d < best){ best = d; if (ws) hw = (ws[i] + (ws[i + 1] - ws[i]) * t) / 2; }
  }
  return { d: best, hw: hw };
}
function diveStreamSurfaceY(w, x, z){
  var pts = w.river, ys = w.profYs, best = 1e18, by = null;
  for (var i = 0; i < pts.length - 1; i++){
    var ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
    var abx = bx - ax, abz = bz - az, l2 = abx * abx + abz * abz || 1;
    var tt = ((x - ax) * abx + (z - az) * abz) / l2;
    tt = tt < 0 ? 0 : (tt > 1 ? 1 : tt);
    var dx = x - (ax + abx * tt), dz = z - (az + abz * tt), d2 = dx * dx + dz * dz;
    if (d2 < best){ best = d2; by = ys[i] + (ys[i + 1] - ys[i]) * tt; }
  }
  return by;
}

/* --- the depth envelope's depth truth (see the header): waterDepthAt
   with its profiled-stream branch converted from terrain-Y units to
   true metres. Everything else is waterDepthAt's own answer.
   ui 2026.11.08.3: the conversion now runs on the local helpers
   above (the index.html originals are unreachable from here — see
   the header). Guards remain only on the PUBLISHED surface this
   module has always used (waterDepthAt / WATER / heightAt). ------ */
function diveDepthUAt(x, z){
  try{
    if (typeof waterDepthAt !== 'function') return 0;
    var d = waterDepthAt(x, z);
    if (typeof WATER !== 'undefined' && typeof heightAt === 'function'){
      for (var i = 0; i < WATER.length; i++){
        var w = WATER[i];
        if (!w.river || !w.profYs) continue;
        var rd = 1e18, hw = (w.width || 30) / 2;
        if (w.widths){
          var sp = diveStreamSpan(w, x, z); rd = sp.d; hw = sp.hw;
        } else {
          rd = diveDistToPolyline(w.river, x, z);
        }
        if (rd < hw){
          var sy = diveStreamSurfaceY(w, x, z);
          if (sy !== null){
            var bedY = heightAt(x, z);
            var dm;
            if (window.MapFrame && typeof MapFrame.runtimeYToElev === 'function')
              dm = MapFrame.runtimeYToElev(sy) - MapFrame.runtimeYToElev(bedY);
            else dm = (sy - bedY) / 0.4347826087;   /* PKG_ELEV_SCALE */
            /* metres -> person-scale units: 1 u = 1 m for the player
               (1.85 u = 6'1"), and feet x U_PER_FT (0.304) x 3.28084
               ft/m = 0.9974 — kept explicit so the units stay honest */
            if (dm > 0) d = Math.max(d, dm * 0.9974);
          }
        }
      }
    }
    return d;
  }catch(e){ return 0; }
}

/* --- the facade index.html calls --------------------------------------
   swimY(dt, gy, wl, sub, mvzIn, ikIn): updatePlayer's swim branch
     computes the surface-trim mesh Y (gy) exactly as before, then
     hands it here ALONG WITH THIS FRAME'S OWN INPUT (ui .26):
     mvzIn is the movement vector updatePlayer just computed from the
     joystick + keys (negative = pushing UP/forward), and ikIn is the
     same frame's key snapshot (the arrow keys ride it — they are
     look keys for movement but dive keys per Joshua's ruling). The
     dive ticks on that call (perfect frame order with the input and
     the mesh) and returns the Y to actually use — gy minus the dive
     depth. Any failure returns gy untouched: surface swimming is
     never at risk from this module.
   view(): updateCamera's on-foot branch asks for the dive's camera
     adjustments; null unless a dive is live. -------------------------- */
window.__DIVE = {
  core: diveCore,
  C: DIVE_C,
  version: DIVE_MODULE_VERSION,
  swimY: function(dtSec, gy, wl, sub, mvzIn, ikIn){
    try{
      if (typeof player === 'undefined' || !player || !player.swimming) return gy;
      var depthU = (wl === null || wl === undefined) ? 0 : diveDepthUAt(player.x, player.z);
      var maxD = Math.max(0, depthU - sub - DIVE_C.BED_CLEAR_U);
      var restLocked = false;
      try{
        restLocked = !!(window.__BODY && window.__BODY.core &&
                        window.__BODY.core.state &&
                        window.__BODY.core.state.floatRest > 0);
      }catch(e){}
      /* THE DEMAND (ui .26 — see the header): derived from the
         caller's own live input values, never re-sampled here.
         mvzIn negative (stick up / W) -> fwd +1 = descend; the
         arrows add their own demand from the same snapshot. Only a
         caller that passes NO demand falls back to the old sampler. */
      var fwd;
      if (typeof mvzIn === 'number' && isFinite(mvzIn)){
        fwd = -mvzIn;
        if (ikIn){
          if (ikIn['arrowup']) fwd += 1;
          if (ikIn['arrowdown']) fwd -= 1;
        }
        if (fwd > 1) fwd = 1; else if (fwd < -1) fwd = -1;
      } else {
        fwd = diveSampleFwd();
      }
      /* telemetry stash (ui 2026.11.08.3): the readout below
         republishes these so a report carries the live chain */
      diveTele.fwd = fwd; diveTele.maxD = maxD;
      diveTele.restLocked = restLocked;
      diveTele.wlNull = (wl === null || wl === undefined);
      var ev = diveCore.tick(diveGMin(dtSec), dtSec, {
        swimming: true, fwd: fwd,
        maxDepthU: maxD, restLocked: restLocked
      });
      /* bed contact while diving = the .20 touch-bottom reset */
      if (ev.bottomStart){
        try{ if (window.__BODY && window.__BODY.touchBottom) window.__BODY.touchBottom(); }catch(e){}
      }
      /* a breath-out resurface that reached the surface starts the
         FORCED-STOP float rest (voluntary ascents never reach here) */
      if (ev.forcedSurfaced){
        try{ if (window.__BODY && window.__BODY.beginFloatRest) window.__BODY.beginFloatRest(); }catch(e){}
      }
      return gy - diveCore.state.depth;
    }catch(e){ return gy; }
  },
  view: function(){
    try{
      if (typeof player === 'undefined' || !player || !player.swimming) return null;
      var d = diveCore.state.depth;
      if (d <= 0.02) return null;
      return {
        sink: Math.min(d * DIVE_C.CAM_SINK_PER_U, DIVE_C.CAM_SINK_MAX),
        lookY: -diveCore.state.pitch * DIVE_C.CAM_PITCH_Y
      };
    }catch(e){ return null; }
  }
};

/* --- report telemetry (ui 2026.11.08.3) --------------------------------
   Publishes the 'dive' readout into the report system: once at load
   (so divePresent + the module version ride EVERY report, even one
   filed on land) and ~1 Hz while swimming (the live chain values
   swimY last computed). Tiny and guarded throughout: no Report, no
   player, no cost. If a future device-side failure differs from
   every harness again, Joshua's next Player Report carries the
   chain's own testimony instead of another round of guessing. ----- */
function divePublishReport(){
  try{
    if (typeof Report === 'undefined' || !Report.setSys) return;
    var swimming = false;
    try{ swimming = !!(typeof player !== 'undefined' && player && player.swimming); }catch(e){}
    Report.setSys('dive', {
      v: DIVE_MODULE_VERSION,
      divePresent: true,
      swimming: swimming,
      fwd: +diveTele.fwd.toFixed(3),
      maxD: +diveTele.maxD.toFixed(3),
      depth: +diveCore.state.depth.toFixed(3),
      breath: +diveCore.state.breath.toFixed(1),
      restLocked: !!diveTele.restLocked,
      wlNull: !!diveTele.wlNull
    });
  }catch(e){}
}
divePublishReport();
setInterval(function(){
  try{
    if (typeof player !== 'undefined' && player && player.swimming) divePublishReport();
  }catch(e){}
}, 1000);

/* --- breath HUD ---------------------------------------------------------
   One row, styled like the body bars (same pill, same 10px bar). Built
   here so index.html needs no markup edits. Positioned direct child of
   <body> with an id = a HUD control under the .23 law (discovered by
   hud_move AND registered explicitly, the body_systems belt-and-net). */
var breathHud = null;
function buildBreathHud(){
  if (breathHud || !document.body) return;
  var st = document.createElement('style');
  st.textContent =
    '#breath-wrap{position:fixed;z-index:11;left:14px;bottom:232px;display:none;' +
    'background:rgba(0,0,0,.5);padding:7px 10px;border-radius:10px;color:#fff;' +
    'font-size:11px;font-weight:bold;pointer-events:none;}' +
    '#breath-wrap .brow{display:flex;align-items:center;gap:7px;}' +
    '#breath-wrap .btag{width:56px;letter-spacing:.5px;color:#9fd8ff;}' +
    '#breath-wrap .bbar{width:118px;height:10px;border-radius:5px;' +
    'background:#3a3f45;overflow:hidden;}' +
    '#breath-wrap .bfill{height:100%;}' +
    '#breath-wrap .bnum{width:32px;text-align:right;font-variant-numeric:tabular-nums;}' +
    '@media (max-width:520px){#breath-wrap .bbar{width:84px;}}';
  document.head.appendChild(st);
  var el = document.createElement('div');
  el.id = 'breath-wrap';
  el.innerHTML =
    '<div class="brow"><span class="btag">BREATH</span>' +
      '<div class="bbar"><div class="bfill" id="br-fill"></div></div>' +
      '<span class="bnum" id="br-num">100</span></div>';
  document.body.appendChild(el);
  try{
    if (window.HudMove && HudMove.register)
      HudMove.register('breath-wrap', { name: 'Breath bar', resizable: true });
  }catch(e){}
  breathHud = { wrap: el,
                fill: el.querySelector('#br-fill'),
                num: el.querySelector('#br-num'),
                shown: false };
}

/* --- underwater grade state: the fog near/far the day world had when
   the camera went under, restored on exit. Fog/background COLOUR is
   daycycle's to lerp — it eases back to the sky on its own next ticks,
   so only the distances are saved/restored here. --------------------- */
var grade = { on: false, near: 0, far: 0 };
function gradeRestore(){
  if (!grade.on) return;
  grade.on = false;
  try{
    if (typeof scene !== 'undefined' && scene && scene.fog){
      scene.fog.near = grade.near;
      scene.fog.far = grade.far;
    }
  }catch(e){}
}

/* --- the render tick: underwater grade + breath bar + out-of-water
   core reset. Priority 47: after daycycle (40) and the water tick
   (45), so the murk is laid over the day's colours every frame and
   daycycle never fights it mid-frame. -------------------------------- */
function diveTick(dt){
  try{
    if (typeof player === 'undefined' || !player){ gradeRestore(); return; }
    if (!breathHud) buildBreathHud();

    /* out of the water the core resets itself (depth home, breath
       refilling) — driven from here because updatePlayer only calls
       swimY while swimming */
    if (!player.swimming && (diveCore.state.depth > 0 || diveCore.state.breath < 100)){
      diveCore.tick(diveGMin((typeof dt === 'number' && dt > 0) ? dt : 0.016), 0,
                    { swimming: false });
    }

    /* --- underwater grade: keyed on the CAMERA, not the player — the
       look changes when the eye goes under --- */
    var under = false, depthU = 0, wl = null;
    try{
      if (typeof camera !== 'undefined' && camera && camera.position &&
          typeof waterLevelAt === 'function'){
        wl = waterLevelAt(camera.position.x, camera.position.z);
        if (wl !== null && wl !== undefined && camera.position.y < wl - 0.05){
          under = true;
          depthU = wl - camera.position.y;
        }
      }
    }catch(e){}
    if (under){
      try{
        if (typeof scene !== 'undefined' && scene && scene.fog){
          if (!grade.on){
            grade.on = true;
            grade.near = scene.fog.near;
            grade.far = scene.fog.far;
          }
          /* visibility shortens with depth: 64u of sight at the
             surface closing to 10u in the deep; near scales with it */
          var far = Math.max(10, Math.min(64, 64 - depthU * 15));
          scene.fog.near = far * 0.12;
          scene.fog.far = far;
          /* the murk: a blue-green cast whose brightness rides
             daycycle's light level, so the .1 curve composes —
             noon underwater is a lit teal, midnight is near-black */
          var light = (typeof window.__dayLightLevel === 'number')
            ? window.__dayLightLevel : 1;
          var k = 0.22 + 0.78 * Math.max(0, Math.min(1, light));
          var r = 0.045 * k, g = 0.21 * k, b = 0.31 * k;
          if (scene.fog.color && scene.fog.color.setRGB)
            scene.fog.color.setRGB(r, g, b);
          if (scene.background && scene.background.setRGB)
            scene.background.setRGB(r, g, b);
        }
      }catch(e){}
    } else if (grade.on){
      gradeRestore();
    }

    /* --- breath bar paint: visibility per the header's rule; display
       is written only on transitions so the layout system's own
       show/hide is never fought frame-to-frame --- */
    if (breathHud){
      var driving = false;
      try{ driving = (typeof car !== 'undefined' && !!car && !!car.driving); }catch(e){}
      var S = diveCore.state;
      var show = !!player.swimming && !driving &&
                 (S.depth > 0.02 || S.breath < 99.5 || S.forced);
      if (show !== breathHud.shown){
        breathHud.shown = show;
        breathHud.wrap.style.display = show ? 'block' : 'none';
      }
      if (show){
        var b = Math.max(0, Math.min(100, S.breath));
        breathHud.fill.style.width = b + '%';
        breathHud.fill.style.background = breathColor(b);
        breathHud.num.textContent = String(Math.ceil(b));
      }
    }
  }catch(e){}
}

/* Boot poll (the body_systems pattern): wait for the player + Sim
   registry, then register on the render phase. */
var diveBootTries = 0;
var diveBootTimer = setInterval(function(){
  diveBootTries++;
  try{
    if (typeof player !== 'undefined' && player &&
        typeof Sim !== 'undefined' && Sim && typeof Sim.onTick === 'function'){
      clearInterval(diveBootTimer);
      Sim.onTick('render', 47, diveTick);
    } else if (diveBootTries > 600){ clearInterval(diveBootTimer); }
  }catch(e){ if (diveBootTries > 600) clearInterval(diveBootTimer); }
}, 200);

})();   /* end DiveSystem */
