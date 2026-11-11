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
   3. DIVE LOCOMOTION — NO dive button exists and none is added.
      (ui 2026.11.11.2 REDESIGN, Joshua 2026-11-11 ~14:01 — SUPERSEDES
      the inverted axis this piece originally shipped with: pushing UP
      used to swim DOWN, which he called "a little bit different from
      what I was expecting.") TWO controls now steer the vertical:
      a. THE MOTION CONTROLLER is NATURAL: floating on the surface and
         pushing DOWN (stick down / S) STARTS a dive; underwater,
         pushing UP (stick up / W) SURFACES. The motion demand is the
         same mvz that propels him (the .26 law) read at face value:
         mvz positive (push down/back) descends, negative rises.
      b. THE LOOK CONTROLLER steers the BODY through the FEET while
         swimming — an analog body-pitch (attitude) control: LOOK DOWN
         angles his FEET down, which lifts his head, so swimming
         carries him UP; LOOK UP angles his FEET up, his head drops,
         and he dives DEEPER. How hard he pushes the look input sets
         how strongly the feet angle ("kind of a speed control" —
         his words): the look demand is the game's own camera-pitch
         state (footPitch, which every look input already writes —
         touch drag, gamepad stick, arrow keys), normalised to -1..1
         and passed in by updatePlayer like every other demand. The
         attitude eases toward the demand; a pitched body gains a
         vertical rate of its own — a gentle drift while treading,
         growing with his forward swim speed, because a swimmer's
         angled body is what carries him up or down. Returning the
         look to level levels the body. The arrow keys are LOOK keys
         in this model (they feed footPitch via LookInput) — they no
         longer add a direct dive demand of their own.
      The camera pitches with the swim (updateCamera reads
      __DIVE.view()) and sinks toward the water so the underwater
      look engages during a dive — with one exit repair (also
      2026.11.11.2, Joshua's same report: "I exit the water and where
      the camera is causes for me to see the water and I can't see
      the character"): view()'s look pitch now FADES OUT over the
      last 1.2u of an ascent — it used to follow the rise velocity
      at full strength all the way up, pinning the aim at the sky
      and pushing the character out of the bottom of the frame for
      the whole exit (measured on the .11.1 bytes: lookY +2.57,
      character centre at NDC y -0.93, at depth 0.43) — and
      updateCamera holds the eye above the surface through the
      exit band (see the clamp there).

   DEPTH GATE — the dive envelope at the player's position comes from
   the game's own depth truth, evaluated per position (NO per-name
   constants): maxDive = depth - swimTrim - BED_CLEAR, where depth is
   waterDepthAt() — the same function that already decides swimming vs
   wading — with ONE units repair: its profiled-stream branch returns
   the surveyed surface-minus-bed gap in terrain-Y units (the package
   elevation scale — 0.4348 units per metre when these measurements
   were taken; true scale 1.00 since ui 2026.11.08.6), while its lake
   branch returns person-scale units (feet x 0.304); diveDepthUAt()
   converts the stream branch to true metres (person-scale, ~1 unit =
   1 metre) so the Chattahoochee's measured 3.6 m channel dives like
   3.6 m. (ui 2026.11.08.5: the conversion divides by the ACTIVE
   elevation scale — the ?elev= switch in map_registry.js — so the
   dive envelope is identical at every view scale.)
   MEASURED DATA (fixes-2026-11-07-dive/measure_depths.mjs, the game's
   own D-grid sampler over the shipped package):
   - Chattahoochee main stem: surface-bed = 3.6 m at the MEDIAN station
     (11.8 ft), max 3.81 m (12.5 ft) — deeper than the ~6 ft estimate.
   - Tatum Lake bed: was 0.60 m at the centre in the shipped DEM (it
     cannot hold lake bathymetry — lidar reads the water surface;
     the zone build carved a 0.6 m anti-burial floor) while the
     game's per-feature model promised 12 ft, and the dive gate
     trusted the model: diving at the centre sank THROUGH the bed
     and swam under the ground sheet (Joshua's hands, Nov 8), and
     high bed spots read walkable where the model said swim.
     FIXED ui 2026.11.08.7 (fixes-2026-11-08-bedcarve): the bed is
     now CARVED IN THE HEIGHT DATA to the promise — a smooth bowl
     inside every lake/pond body's own drawn ring (centre = model
     depth + 0.20 m, easing to zero over a 4 m shore feather; lower
     only; banks and above-surface shore posts untouched; the
     boulder-066 pond island exempt). 23,724 posts lowered across
     56 bodies; promised-vs-real now agrees on every post beyond
     the feather and on the dense sampler from 5 m inside any ring.
     AND the envelope below is clamped by the REAL bed (heightAt)
     as well, so no position can ever dive past the ground that is
     actually drawn there.
   - Tatum Outlet Creek: median 0.57 m, max 2.03 m at the falls plunge;
     zero stations at swim depth — creeks stay wading-only in practice.
     (The creek's cross-sections were NOT touched by the bed carve:
     old-vs-new sampler along its whole line is identical but for a
     1 mm float rounding at the lake outlet.)
   The bed is solid: the envelope stops the sink BED_CLEAR above the
   REAL bed (the gate takes the smaller of the model envelope and
   surface - heightAt - BED_CLEAR), and REACHING the bed fires the
   .20 touch-bottom reset through __BODY.touchBottom() — bed contact
   is bed contact.

   BREATH — 1 REAL MINUTE submerged maximum (Joshua's ruling,
   Nov 8, ui 2026.11.08.7 — supersedes the original 2 game minutes
   ≈ 10 real seconds; the body's OTHER clocks stay on game minutes:
   the .20 float rest, the damage heal). Breath drains on REAL
   elapsed time (tick's dtSec), only while the HEAD is under
   (sink >= HEAD_UNDER_U): a full breath is 60 real seconds from
   full to empty. It refills at the surface on real time too — full
   from empty in 10 real seconds (a few real breaths). At zero:
   FORCED RESURFACE — the player is
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
  /* breath budget: 1 REAL minute with the head under (Nov 8 ruling,
     see header) — drained and refilled on real elapsed seconds */
  BREATH_MAX_SEC: 60,
  /* surface refill: 10 points per real second = full from empty in
     10 real seconds */
  BREATH_REFILL_PER_SEC: 10,
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
  /* the envelope stops this far above the REAL bed (the gate clamp
     in swimY takes the smaller of the model envelope and
     surface - heightAt - this clearance) */
  BED_CLEAR_U: 0.25,
  /* camera: sink per unit of dive depth, and the cap */
  CAM_SINK_PER_U: 0.9,
  CAM_SINK_MAX: 2.4,
  /* camera: look-target Y offset at full pitch, u */
  CAM_PITCH_Y: 2.6,
  /* camera: the look pitch fades out over this much remaining dive
     depth on the way up, so the exit crosses with a level camera
     and the character framed (ui 2026.11.11.2 — see the header) */
  CAM_EXIT_FADE_U: 1.2,
  /* ATTITUDE (ui 2026.11.11.2 — the look-steered body pitch):
     how fast the body angle eases toward the look demand, 1/s */
  ATT_RATE: 3.2,
  /* a fully pitched body's own vertical drift while treading
     water, u/s — an angled swimmer's kick moves him even at a
     standstill, gently */
  ATT_BASE_U: 0.5,
  /* extra vertical rate per u/s of forward swim speed at full
     attitude — swimming forward along a pitched body is what
     really carries him shallower or deeper */
  ATT_GAIN: 0.35,
  /* the attitude's total vertical rate never exceeds this, u/s
     (an empty breath's forced resurface runs at the same 2.4) */
  ATT_RATE_MAX: 2.4,
  /* the visible body pitch per unit of attitude, radians — read
     by index.html's animateHero through __DIVE.C so the feet/head
     angle he sees IS the angle that steers him */
  ATT_PITCH_RAD: 0.5
};

/* This module's build stamp (ui 2026.11.08.3): carried on window.__DIVE
   and in every 'dive' Report readout, so a Player Report shows WHICH
   dive module actually ran on the device — a stale or missing module
   (the deferred loader skips this file silently: its script tag has
   an empty data-dkey) can never again masquerade as a wiring bug. */
var DIVE_MODULE_VERSION = '2026.11.11.2';

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
   env: { swimming, fwd, look, fwdSpd, maxDepthU, restLocked }
     fwd: the MOTION dive demand, -1..1, NATURAL (ui 2026.11.11.2):
       +1 = pushing DOWN (stick down / S) = descend; -1 = pushing
       UP (stick up / W) = rise.
     look: the LOOK attitude demand, -1..1 (ui 2026.11.11.2): +1 =
       looking fully UP (feet angle up, head drops, he deepens);
       -1 = looking fully DOWN (feet angle down, head rises, he
       climbs). The core eases `att` toward it.
     fwdSpd: his forward swim speed along his facing, u/s (>= 0) —
       the attitude's vertical rate grows with it.
     maxDepthU: the envelope at this position (wiring computes it from
       the game's depth truth minus the swim trim and the bed
       clearance; the core only clamps).
     restLocked: a float rest is running — the dive axis is locked.
   ============================================================================ */
function createDiveCore(){
  var S = {
    depth: 0,          /* u below the surface-swim trim */
    breath: 100,       /* 0..100, percent of BREATH_MAX_SEC (60 real s) */
    forced: false,     /* a breath-out forced resurface is running */
    submerged: false,  /* head under (breath draining) */
    bottom: false,     /* resting on the envelope floor (the bed) */
    pitch: 0,          /* smoothed vertical pitch, -1 (rising) .. 1 (diving) */
    att: 0,            /* the look-steered body attitude, -1 (feet down /
                          head up, climbing) .. 1 (feet up / head down,
                          deepening) — eased toward the look demand */
    prevDepth: 0
  };
  function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }

  function tick(gMin, dtSec, env){
    var ev = { bottomStart: false, breathOut: false, forcedSurfaced: false };
    if (!env || !env.swimming){
      /* out of the water: the dive is over — depth snaps home, breath
         tops back up, no latches survive */
      S.depth = 0; S.prevDepth = 0; S.forced = false;
      S.submerged = false; S.bottom = false; S.pitch = 0; S.att = 0;
      S.breath = Math.min(100, S.breath + DIVE_C.BREATH_REFILL_PER_SEC * (dtSec || 0));
      return ev;
    }
    var maxD = Math.max(0, env.maxDepthU || 0);
    var wasBottom = S.bottom;

    if (S.forced){
      /* FORCED RESURFACE: input does not matter — an empty breath
         carries him up at RESURFACE_SPEED until the trim is home.
         The body levels out too: no attitude survives an empty
         breath. */
      S.depth -= DIVE_C.RESURFACE_SPEED * dtSec;
      S.att += (0 - S.att) * Math.min(1, dtSec * DIVE_C.ATT_RATE);
      if (S.depth <= 0){
        S.depth = 0; S.forced = false;
        ev.forcedSurfaced = true;   /* wiring starts the float rest */
      }
    } else if (env.restLocked){
      /* a forced rest is a forced stop: the whole vertical is
         locked (as it always was) and the body eases level. */
      S.att += (0 - S.att) * Math.min(1, dtSec * DIVE_C.ATT_RATE);
    } else if (dtSec > 0){
      /* THE NATURAL MOTION AXIS (ui 2026.11.11.2): fwd +1 (pushing
         DOWN) descends, fwd -1 (pushing UP) rises. */
      S.depth += (env.fwd || 0) * DIVE_C.DIVE_SPEED * dtSec;
      /* THE LOOK ATTITUDE (ui 2026.11.11.2): the body angle eases
         toward the look demand — how hard he pushes the look sets
         how far the feet angle — and a pitched body carries him:
         a gentle drift while treading, growing with his forward
         swim speed, capped at the resurface rate. att +1 (feet up,
         head down) deepens; att -1 (feet down, head up) climbs. */
      var attTgt = clamp(env.look || 0, -1, 1);
      S.att += (attTgt - S.att) * Math.min(1, dtSec * DIVE_C.ATT_RATE);
      var attRate = S.att * Math.min(DIVE_C.ATT_RATE_MAX,
        DIVE_C.ATT_BASE_U + DIVE_C.ATT_GAIN * Math.max(0, env.fwdSpd || 0));
      S.depth += attRate * dtSec;
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

    /* breath: drains only with the head under, on REAL elapsed time
       (Nov 8 ruling: a full breath is 1 real minute); refills at the
       surface on real time too */
    S.submerged = S.depth >= DIVE_C.HEAD_UNDER_U;
    if (S.submerged){
      S.breath -= (100 / DIVE_C.BREATH_MAX_SEC) * (dtSec || 0);
      if (S.breath <= 0){
        S.breath = 0;
        if (!S.forced){ S.forced = true; ev.breathOut = true; }
      }
    } else {
      S.breath = Math.min(100, S.breath + DIVE_C.BREATH_REFILL_PER_SEC * (dtSec || 0));
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
var diveTele = { fwd: 0, look: 0, att: 0, maxD: 0, restLocked: false, wlNull: false };

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

/* --- the dive axis demand: +1 = pushing DOWN (descend), -1 =
   pushing UP (rise) — the NATURAL axis of ui 2026.11.11.2. ui .26:
   the demand ARRIVES from updatePlayer (swimY's mvzIn argument —
   the very value that propels surface swimming this frame); this
   sampler remains ONLY as a fallback for a caller that passes no
   demand. Its touch read was the .24 live failure: `joy` never
   escapes index.html's eval scope, so from this file it is always
   undefined. The arrow keys are NOT read here any more: in the
   2026.11.11.2 model they are look input (they write footPitch
   through LookInput) and reach the dive through the look channel
   (diveSampleLook below), never as a direct axis. -------------- */
function diveSampleFwd(){
  var raw = 0;
  try{
    var ik = (window.Input && Input.sampled) ? Input.keys : window.keys;
    if (ik){
      if (ik['s']) raw += 1;   /* pushing DOWN descends */
      if (ik['w']) raw -= 1;   /* pushing UP rises */
    }
    /* every analog source reads push-down as positive, which IS
       the descend demand under the natural axis — no flip */
    if (window.Input && Input.sampled && typeof Input.sampled.analogY === 'number')
      raw += Input.sampled.analogY;
    if (typeof joy !== 'undefined' && joy && joy.active) raw += (joy.dy || 0);
  }catch(e){}
  return Math.max(-1, Math.min(1, raw));
}

/* --- the LOOK demand fallback: the normalised camera-pitch state,
   +1 = looking fully UP (feet up / deepen), -1 = fully DOWN (feet
   down / climb). swimY's caller passes this in (updatePlayer owns
   footPitch); this fallback serves a caller that passes nothing,
   reading index.html's PUBLISHED getter — never the raw variable,
   which lives in its eval scope (the .24/.26 lesson). The clamp
   constants mirror index.html's FOOT_PITCH_UP / FOOT_PITCH_DOWN;
   if those ever change, change this pair with them. ------------ */
function diveSampleLook(){
  try{
    if (typeof window.__footPitchState !== 'function') return 0;
    var fp = window.__footPitchState();
    if (typeof fp !== 'number' || !isFinite(fp)) return 0;
    var n = fp >= 0 ? fp / 1.45 : fp / 1.30;
    return Math.max(-1, Math.min(1, n));
  }catch(e){ return 0; }
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
            /* ELEV SWITCH (ui 2026.11.08.5; default flipped ui
               2026.11.08.6): the primary path above is already
               scale-true at any ?elev= — runtimeYToElev divides by
               the ACTIVE scale, so the gap comes back in true
               metres and the dive envelope does not change with
               the view scale. This fallback (MapFrame somehow
               absent) must divide by the same active scale,
               published as __SA_ELEV by map_registry.js — never a
               stale hardcoded constant, which would shrink the
               envelope exactly when a taller world is being
               tested. The literal below is only the last resort
               if even __SA_ELEV is missing, and names the world's
               default scale: true scale, 1.00 (Joshua's ruling,
               2026-11-08). */
            else dm = (sy - bedY) / ((window.__SA_ELEV && window.__SA_ELEV.scale) || 1);
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
   swimY(dt, gy, wl, sub, mvzIn, ikIn, lookIn): updatePlayer's swim
     branch computes the surface-trim mesh Y (gy) exactly as before,
     then hands it here ALONG WITH THIS FRAME'S OWN INPUT (ui .26):
     mvzIn is the movement vector updatePlayer just computed from the
     joystick + keys (negative = pushing UP/forward, positive =
     pushing DOWN/back), ikIn is the same frame's key snapshot, and
     lookIn (ui 2026.11.11.2) is the normalised look demand from the
     same frame's footPitch (-1..1, + = looking up). The dive ticks
     on that call (perfect frame order with the input and the mesh)
     and returns the Y to actually use — gy minus the dive depth.
     Any failure returns gy untouched: surface swimming is never at
     risk from this module.
   view(): updateCamera's on-foot branch asks for the dive's camera
     adjustments; null unless a dive is live. -------------------------- */
window.__DIVE = {
  core: diveCore,
  C: DIVE_C,
  version: DIVE_MODULE_VERSION,
  swimY: function(dtSec, gy, wl, sub, mvzIn, ikIn, lookIn){
    try{
      if (typeof player === 'undefined' || !player || !player.swimming) return gy;
      var depthU = (wl === null || wl === undefined) ? 0 : diveDepthUAt(player.x, player.z);
      var maxD = Math.max(0, depthU - sub - DIVE_C.BED_CLEAR_U);
      /* REAL-BED CLAMP (ui 2026.11.08.7 — the bed-carve pass): the
         model envelope above is a promise; the ground that is
         actually drawn is heightAt's surface (the carved D-grid).
         The dive may never reach past it: cap maxD so the sink stops
         BED_CLEAR_U above the REAL bed at this position. This is the
         hard invariant behind the carve — wherever the model and the
         bed still differ (the shore feather, a bank's bilinear
         shadow), the bed wins and nobody swims under the ground.
         heightAt is index.html's published terrain truth; if it is
         somehow absent the model envelope alone applies (the carve
         has already reconciled the two at every post). */
      if (typeof wl === 'number' && isFinite(wl) &&
          typeof heightAt === 'function'){
        try{
          var bedY = heightAt(player.x, player.z);
          if (typeof bedY === 'number' && isFinite(bedY)){
            var bedCap = wl - bedY - DIVE_C.BED_CLEAR_U;
            if (bedCap < maxD) maxD = Math.max(0, bedCap);
          }
        }catch(e){}
      }
      var restLocked = false;
      try{
        restLocked = !!(window.__BODY && window.__BODY.core &&
                        window.__BODY.core.state &&
                        window.__BODY.core.state.floatRest > 0);
      }catch(e){}
      /* THE DEMAND (ui .26 — see the header): derived from the
         caller's own live input values, never re-sampled here.
         ui 2026.11.11.2 — THE NATURAL AXIS: mvzIn IS the descend
         demand (positive = pushing DOWN/back = descend; negative =
         pushing UP/forward = rise), read at face value, no flip.
         The arrow keys no longer add demand (they are look keys
         now — see the LOOK DEMAND below). Only a caller that passes
         NO demand falls back to the sampler. */
      var fwd;
      if (typeof mvzIn === 'number' && isFinite(mvzIn)){
        fwd = mvzIn;
        if (fwd > 1) fwd = 1; else if (fwd < -1) fwd = -1;
      } else {
        fwd = diveSampleFwd();
      }
      /* THE LOOK DEMAND (ui 2026.11.11.2): the normalised look
         pitch from the caller (+1 = looking up = feet up = deepen;
         -1 = looking down = feet down = climb), with the published
         -getter fallback for a caller that passes none. */
      var look;
      if (typeof lookIn === 'number' && isFinite(lookIn)){
        look = lookIn;
        if (look > 1) look = 1; else if (look < -1) look = -1;
      } else {
        look = diveSampleLook();
      }
      /* his forward swim speed along his facing, for the attitude
         rate: his governed speed times the forward share of this
         frame's own stick (pushing back or sideways gives the
         attitude nothing to work with). */
      var fwdSpd = 0;
      try{
        if (typeof player.speed === 'number' && isFinite(player.speed) &&
            typeof mvzIn === 'number' && isFinite(mvzIn))
          fwdSpd = player.speed * Math.max(0, Math.min(1, -mvzIn));
      }catch(e){}
      /* telemetry stash (ui 2026.11.08.3): the readout below
         republishes these so a report carries the live chain */
      diveTele.fwd = fwd; diveTele.look = look; diveTele.maxD = maxD;
      diveTele.restLocked = restLocked;
      diveTele.wlNull = (wl === null || wl === undefined);
      var ev = diveCore.tick(diveGMin(dtSec), dtSec, {
        swimming: true, fwd: fwd, look: look, fwdSpd: fwdSpd,
        maxDepthU: maxD, restLocked: restLocked
      });
      diveTele.att = diveCore.state.att;
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
      /* THE EXIT FADE (ui 2026.11.11.2): the look pitch eases out
         over the last CAM_EXIT_FADE_U of depth, so an ascent crosses
         the surface with the camera level and the character framed
         — before this, the pitch followed the rise velocity at full
         strength to the very top (measured lookY +2.57 with the
         character at the frame's bottom edge at depth 0.43, the
         exact "I see the water and I can't see the character"
         stretch of Joshua's report). The sink already fades with
         depth by construction (it is proportional to d). depth and
         att ride along so updateCamera can run its exit-band clamp
         and a report can see the live attitude. */
      var fade = Math.max(0, Math.min(1, d / DIVE_C.CAM_EXIT_FADE_U));
      return {
        sink: Math.min(d * DIVE_C.CAM_SINK_PER_U, DIVE_C.CAM_SINK_MAX),
        lookY: -diveCore.state.pitch * DIVE_C.CAM_PITCH_Y * fade,
        att: diveCore.state.att,
        depth: d
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
      look: +diveTele.look.toFixed(3),
      att: +diveCore.state.att.toFixed(3),
      maxD: +diveTele.maxD.toFixed(3),
      depth: +diveCore.state.depth.toFixed(3),
      breath: +diveCore.state.breath.toFixed(1),
      breathMaxSec: DIVE_C.BREATH_MAX_SEC,
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
