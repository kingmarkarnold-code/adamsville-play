/* ============================================================================
   AMBIENT AUDIO v1.0 (2026-10-11) — procedural city ambience.
   Expert report #38 (Michael Torres, Audio Engineer — Joshua approved
   "Fix 38"): the world was silent when the player wasn't driving. No birds,
   no distant traffic hum, no wind, no city life. It felt dead.

   APPROACH — everything is synthesized with the Web Audio API. Zero audio
   files, zero downloads, negligible CPU (a handful of persistent nodes +
   short-lived chirp oscillators). Layers:

     1. TRAFFIC HUM  — looped brown noise through a low-pass. Louder during
        the day, louder near traffic (counts window.TRAFFIC slots near the
        player, same read pattern as blob_shadows.js).
     2. WIND        — looped noise through a band-pass with a slow LFO on
        the gain. Always present, subtle, drifts.
     3. CRICKETS    — 4.3 kHz sine with amplitude pulsing. Night only.
     4. BIRDS       — RETIRED in v1.2 (2026-11-07, wildlife package):
        the old scheduled chirp events (short sine sweeps fired into
        the air with no bird attached) are GONE. Birdsong now comes
        from actual birds — wildlife_system.js sings per-bird phrases
        through __AMB.voice(), positional like the water. See the
        v1.2 changelog block below.
     5. CITY EVENTS — rare distant sirens (two-tone triangle sweep, very
        quiet). More likely downtown.

   LOCATION AWARENESS is deliberately cheap: player position + traffic-slot
   scan + a lazy downtown lookup, recomputed every 2 seconds (not per
   frame), with setTargetAtTime() crossfades so changes glide instead of
   stepping.

   AUDIO POLICY — browsers block audio before a user gesture. We create
   window.__audioCtx early (suspended); the game's existing unlockAudio()
   handler in index.html resumes it on first click/keydown/touch. We share
   that context with the #37 engine-sound module if it created it first.

   MUTE — follows the game's single mute toggle (musicMuted /
   sa_music_muted). No separate ambience switch; Joshua can ask for one.

   TICK — registers on the central Sim registry ('render', priority 80,
   after GPS's 75) per expert #14's rule. No animate() patching.

   Joshua's rule: documentation comments on all game code. This file
   follows it.
   ============================================================================ */
/* ============================================================================
   v1.1 WATER + NATURE AUDIO (2026-11-01, fixes batch item B — Joshua's
   gameplay video + spoken notes on build .4):

   B1 CREEK SOUND WAS MISSING. The v1.0 water layer was brown noise
   through a 750 Hz low-pass at max gain 0.055 — nearly all its energy
   sits under 200 Hz, where a phone speaker emits almost nothing, and
   0.055 sits far under the 0.35 music track. At the creek bank it was,
   for practical purposes, silent. v1.1 re-voices water in the mid band
   (where small speakers live) with distance-based gains (see LEVELS).
   B2 WATERFALL at the Tatum Lake outlet — its own voice (bright
   small-fall trickle, NOT a roar; Joshua: "just a little trickle"),
   anchored at the outlet point with a tight radius.
   B3 CRICKETS + GRASSHOPPERS near the creek — a riparian insect layer
   gated by distance to the nearest stream, daytime-weighted (the
   video is a summer day); the v1.0 night crickets stay as they were.
   B4 WADING + SWIMMING SOUNDS — movement through water splashes:
   stride-synced wading steps in the shallows, a stroke rhythm when
   swimming, faint treads when treading water (the game's three-state
   water model), and a bigger splash on entering the water. Grass
   stays silent; water no longer reuses that silence.
   B5 MIX BALANCE — the music elements (index.html, MUSIC_VOL 0.35)
   are ducked by proximity to nature's strongest voice: this module
   publishes window.__musicDuck (consumed by the music crossfade code
   in index.html) and applies it to the playing element between
   fades. At the bank the music eases to ~55% so water and insects
   stay audible; away from water the music is untouched.

   LEVELS (target gains at each layer's gain node, master = 1):
     creek  0.085 * f^1.6,  f = clamp(1 - d/45),  d = shore distance m
     river  0.110 * f^1.6,  f = clamp(1 - d/70)
     falls  0.075 * f^1.8,  f = clamp(1 - d/38),  d = m to the outlet
     lake shores feed the creek voice at half gain (a gentle lap).
   Joshua's falloff rule holds: inaudible far away (every voice is
   exactly 0 at its radius), growing on approach, clear at the bank.

   VERIFICATION (a headless rig cannot hear): window.__AMB.levels()
   returns the very targets retarget() applies — one code path, so
   the measured numbers ARE the shipped behaviour — and __AMB.gains()
   reads the live node gains + wading state + splash counter.
   ============================================================================ */
/* ============================================================================
   v1.2 WILDLIFE PACKAGE (2026-11-07, Joshua's design — built on the
   two Nov 7 research passes):

   W1 LEGACY TIMER BIRDS RETIRED. scheduleBird()/chirp() are deleted
   outright: birdsong that fires on a timer with no bird making it
   was the thing Joshua objected to ("it's like the water when I got
   closer to the water the water got louder — when I get closer to a
   bird the bird should get louder"). Real birds (wildlife_system.js)
   own their voices now, through the door in W3.
   W2 SPLASH RECIPE REBUILT. Joshua wading Tatum Outlet Creek on
   ui 2026.11.07.3: "instead of sounding like splashing it sounded
   like tapping." The old burst was ONE band-passed ping of
   pre-smoothed noise at a fixed pitch — a knock, not liquid. The
   new splashBurst() is three components: a raw-noise IMPACT whose
   low-pass sweeps 3 kHz -> 600 Hz, a falling sine BLOOP
   (420 -> 140 Hz, the displaced-water cavity), and 3–6 high-passed
   DROPLET micro-bursts scattered 40–350 ms behind the impact, each
   burst starting at a random offset in the noise buffer so no two
   steps share a waveform. Peaks/cadence are unchanged (the
   2026-11-01 gain staging stands — a splash is a stride sound).
   W3 __AMB.voice() — a per-creature voice door into THIS master:
   the caller gets {ctx, out, now(), running(), setGain(), destroy()}
   and schedules its own oscillators into `out`. Wildlife song
   therefore rides the same mute/enabled/gesture path as every
   other ambient voice — it cannot sound while the game is muted,
   and it dies with the context like everything else.
   W4 RIPARIAN INSECTS REBALANCED 0.0060 -> 0.0130. The layer was
   firing at Joshua's creek position (research-verified) but sat
   ~24 dB under the creek's own voice — present and imperceptible
   on a phone speaker. 0.013 puts the shimmer just under the water
   it lives beside.
   ============================================================================ */
(function ambientAudio(){
'use strict';

/* Day bounds match daycycle.js and blob_shadows.js (06:00–20:00). */
var DAY_START = 360, DAY_END = 1200;

/* Recompute layer targets every 2 s — audio glides via setTargetAtTime,
   so per-frame updates would be wasted work. */
var RETARGET_S = 2.0;

/* Downtown Atlanta landmark (game coords resolved lazily via xz()). */
var DOWNTOWN_LATLNG = [33.7586, -84.38908];

/* ---- module state ---- */
var ctx = null, master = null, noiseBuf = null, waterBuf = null;
var whiteBuf = null;   /* v1.2: RAW white noise — the splash recipe's
                          impact/droplet source (waterBuf is pre-smoothed
                          for the continuous voices; a splash needs the
                          transient grain the smoother removes) */
var gTraffic = null, gWind = null, gCrickets = null;
var gCreek = null, gRiver = null, gFalls = null, gInsects = null;
var fallsFlutter = null;                   /* falls gain LFO depth */
var wLFOdepth = null, crLFOdepth = null;   /* LFO depth gains (see buildLayers) */
var fallsPt = null;        /* {x,z} Tatum Lake outlet, resolved lazily */
/* B4 wading state: position-tracked speed + water state, splash timer. */
var splashCount = 0;
var splashLog = [];        /* last 16 bursts {kind, peak, at} — __AMB evidence */
var lastSplash = null;
var wadeState = { inWater: false, swimming: false, depth: 0, speed: 0,
                  nextSplash: 0, wasInWater: false, lx: null, lz: null, lt: 0 };
var retargetT = 0, enabled = true;
var downtown = null;                        /* {x,z} once resolved */
var sirenTO = null;
var bootTries = 0, bootTimer = null;

/* ------------------------------------------------------------------ */
/* Small helpers — all typeof-guarded so the module survives any load
   order or opted-out system.                                          */
function gameMin(){
  try{
    if (window.__daycycle && isFinite(window.__daycycle.gameMin))
      return window.__daycycle.gameMin;
  }catch(e){}
  return 720; /* noon fallback */
}
function isDay(gm){ return gm >= DAY_START && gm <= DAY_END; }
function isMuted(){
  try{ if (window.__musicState) return !!window.__musicState.muted; }catch(e){}
  try{ return (typeof musicMuted !== 'undefined' && musicMuted); }catch(e){}
  try{ return localStorage.getItem('sa_music_muted') === '1'; }catch(e){}
  return false;
}
function playerPos(){
  try{
    if (typeof player !== 'undefined' && player &&
        isFinite(player.x) && isFinite(player.z))
      return { x: player.x, z: player.z };
  }catch(e){}
  return null;
}
/* Traffic density 0..1 near the player — same slot-read pattern as
   blob_shadows.js (TR.slots -> TR.cars[ci], x/z checked). */
function trafficDensity(px, pz){
  try{
    var TR = window.TRAFFIC;
    if (!TR || !TR.slots || !TR.cars) return 0.5;
    var n = 0, R2 = 150 * 150;
    var nSlots = Math.min(TR.slots.length, 40);
    for (var s = 0; s < nSlots; s++){
      var ci = TR.slots[s];
      var c = (ci >= 0) ? TR.cars[ci] : null;
      if (c && isFinite(c.x) && isFinite(c.z)){
        var dx = c.x - px, dz = c.z - pz;
        if (dx * dx + dz * dz < R2) n++;
      }
    }
    return Math.min(1, n / 10);
  }catch(e){ return 0.5; }
}
function downtownXZ(){
  if (downtown) return downtown;
  try{
    if (typeof xz === 'function'){
      var d = xz(DOWNTOWN_LATLNG[0], DOWNTOWN_LATLNG[1]);
      if (d && isFinite(d.x) && isFinite(d.z)) downtown = { x: d.x, z: d.z };
    }
  }catch(e){}
  return downtown;
}

/* ------------------------------------------------------------------ */
/* ensureCtx() — create (or adopt) the shared AudioContext. Created
   suspended is fine: index.html's unlockAudio() resumes
   window.__audioCtx on the first user gesture. Returns true when the
   graph is live. */
function ensureCtx(){
  if (ctx) return ctx.state !== 'closed';
  try{
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (window.__audioCtx && window.__audioCtx.state !== 'closed'){
      ctx = window.__audioCtx;   /* #37 engine sounds may have made it */
    } else {
      ctx = new AC();
      window.__audioCtx = ctx;   /* unlockAudio() will resume this */
    }
    master = ctx.createGain();
    master.gain.value = 0;       /* fades in on first retarget */
    master.connect(ctx.destination);
    noiseBuf = makeNoise(ctx);
    waterBuf = makeWaterNoise(ctx);
    whiteBuf = makeWhiteNoise(ctx);
    buildLayers();
    return true;
  }catch(e){ ctx = null; return false; }
}

/* 2 s of brown noise — warmer than white, good for rumble and wind. */
function makeNoise(c){
  var len = Math.floor(c.sampleRate * 2);
  var buf = c.createBuffer(1, len, c.sampleRate);
  var d = buf.getChannelData(0), last = 0;
  for (var i = 0; i < len; i++){
    var w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    d[i] = last * 3.2;
  }
  return buf;
}
/* Water noise: white noise through a one-pole smoother — a soft hiss
   with body, none of brown noise's sub-200 Hz rumble dominance. The
   band-pass voices below shape it into creek/river/falls. */
function makeWaterNoise(c){
  var len = Math.floor(c.sampleRate * 2);
  var buf = c.createBuffer(1, len, c.sampleRate);
  var d = buf.getChannelData(0), last = 0;
  for (var i = 0; i < len; i++){
    var w = Math.random() * 2 - 1;
    last += 0.32 * (w - last);
    d[i] = last * 1.9;
  }
  return buf;
}
/* 2 s of RAW white noise (v1.2) — splash impacts and droplets. No
   smoothing: the crackle IS the content. */
function makeWhiteNoise(c){
  var len = Math.floor(c.sampleRate * 2);
  var buf = c.createBuffer(1, len, c.sampleRate);
  var d = buf.getChannelData(0);
  for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
function loopNoise(rate){
  var s = ctx.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  if (rate) s.playbackRate.value = rate;
  return s;
}

/* Persistent nodes: 2 noise loops, 1 wind LFO, 2 cricket oscs.
   LFO depths are separate gain nodes so retarget() can silence them
   (an LFO wired straight into a gain param would keep adding ±depth
   even when the target level is 0). */
function buildLayers(){
  var t = ctx.currentTime;

  /* --- traffic hum: brown noise -> low-pass --- */
  var tr = loopNoise(1), trF = ctx.createBiquadFilter();
  trF.type = 'lowpass'; trF.frequency.value = 170;
  gTraffic = ctx.createGain(); gTraffic.gain.value = 0;
  tr.connect(trF); trF.connect(gTraffic); gTraffic.connect(master);
  tr.start(t);

  /* --- wind: noise -> band-pass, slow LFO breathing on the gain --- */
  var w = loopNoise(0.7), wF = ctx.createBiquadFilter();
  wF.type = 'bandpass'; wF.frequency.value = 480; wF.Q.value = 0.5;
  gWind = ctx.createGain(); gWind.gain.value = 0;
  var wLFO = ctx.createOscillator();
  wLFO.type = 'sine'; wLFO.frequency.value = 0.06;
  wLFOdepth = ctx.createGain(); wLFOdepth.gain.value = 0;
  wLFO.connect(wLFOdepth); wLFOdepth.connect(gWind.gain);
  w.connect(wF); wF.connect(gWind); gWind.connect(master);
  w.start(t); wLFO.start(t);

  /* --- water voices (v1.1, item B): all fed by the smoothed
     water-noise buffer and band-passed into the mid band, so they
     read on small speakers (the v1.0 brown-noise low-pass voice was
     inaudible there). Creek = SOFT rushing water (band ~950 Hz, not
     ocean surf); river = the same family lower and stronger;
     falls = a bright small-fall trickle (~1900 Hz) with a fast
     flutter on its gain. Each is proximity-driven in retarget(). --- */
  function waterVoice(freq, q){
    var s = ctx.createBufferSource();
    s.buffer = waterBuf; s.loop = true;
    s.playbackRate.value = 0.9 + Math.random() * 0.2;
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 240;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    var g = ctx.createGain(); g.gain.value = 0;
    s.connect(hp); hp.connect(bp); bp.connect(g); g.connect(master);
    s.start(t);
    return { g: g, bp: bp };
  }
  var cv = waterVoice(950, 0.55); gCreek = cv.g;
  var rv = waterVoice(430, 0.5);  gRiver = rv.g;
  var fv = waterVoice(1900, 0.7); gFalls = fv.g;
  /* Creek burble: a slow wander of the creek band frequency, so the
     rush breathes instead of sitting on one filtered tone. */
  var bLFO = ctx.createOscillator();
  bLFO.type = 'sine'; bLFO.frequency.value = 0.13;
  var bDepth = ctx.createGain(); bDepth.gain.value = 210;
  bLFO.connect(bDepth); bDepth.connect(cv.bp.frequency); bLFO.start(t);
  /* Falls flutter: 4.7 Hz shimmer depth, scaled with the falls level
     in retarget (0 when the falls voice is silent). */
  var fLFO = ctx.createOscillator();
  fLFO.type = 'sine'; fLFO.frequency.value = 4.7;
  fallsFlutter = ctx.createGain(); fallsFlutter.gain.value = 0;
  fLFO.connect(fallsFlutter); fallsFlutter.connect(gFalls.gain);
  fLFO.start(t);

  /* --- riparian insects (v1.1, B3): two pulse-gated sines — cricket
     4.4 kHz at a 13 Hz pulse, grasshopper 5.6 kHz at 21 Hz — summed
     into one gain. retarget() gates it by distance to the nearest
     stream and by daylight, so the chorus lives along the creek. --- */
  gInsects = ctx.createGain(); gInsects.gain.value = 0;
  [[4400, 13], [5600, 21]].forEach(function(cfg){
    var o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = cfg[0];
    var og = ctx.createGain(); og.gain.value = 0.5;
    var lfo = ctx.createOscillator();
    lfo.type = 'square'; lfo.frequency.value = cfg[1];
    var lg = ctx.createGain(); lg.gain.value = 0.5;
    lfo.connect(lg); lg.connect(og.gain);
    o.connect(og); og.connect(gInsects);
    o.start(t); lfo.start(t);
  });
  gInsects.connect(master);

  /* --- crickets: 4.3 kHz sine, pulsed by a 17 Hz LFO --- */
  var cr = ctx.createOscillator(), crLFO = ctx.createOscillator();
  cr.type = 'sine'; cr.frequency.value = 4300;
  gCrickets = ctx.createGain(); gCrickets.gain.value = 0;
  crLFO.type = 'sine'; crLFO.frequency.value = 17;
  crLFOdepth = ctx.createGain(); crLFOdepth.gain.value = 0;
  crLFO.connect(crLFOdepth); crLFOdepth.connect(gCrickets.gain);
  cr.connect(gCrickets); gCrickets.connect(master);
  cr.start(t); crLFO.start(t);
}

/* ------------------------------------------------------------------ */
/* retarget() — every 2 s, glide each layer toward its new target. */
function retarget(){
  if (!ctx || !master) return;
  var t = ctx.currentTime;
  var running = (ctx.state === 'running');
  var gm = gameMin(), day = isDay(gm);

  /* Master follows gesture state + the game's mute toggle. */
  var mT = (running && enabled && !isMuted()) ? 1 : 0;
  master.gain.setTargetAtTime(mT, t, 0.4);

  /* Traffic: busier mid-day, near-silent at night; scaled by how many
     simulated cars are actually around the player. */
  var busy = day
    ? 0.55 + 0.45 * Math.sin(Math.PI *
        Math.min(1, Math.max(0, (gm - 420) / (1140 - 420))))
    : 0.22;
  var p = playerPos();
  var dens = p ? trafficDensity(p.x, p.z) : 0.5;
  gTraffic.gain.setTargetAtTime(
    running ? 0.028 * busy * (0.45 + 0.55 * dens) : 0, t, 1.2);

  /* Wind (Joshua, 2026-10-30): audible ONLY over 5 mph, strength
     following the SAME wind signal that sways the trees and drives
     the weather (daycycle's window.__windMphNow) — silent at or
     below the threshold, so sound, sway and weather never disagree. */
  var mph = 0;
  try{ if (typeof window.__windMphNow === 'function') mph = window.__windMphNow(); }catch(e){}
  var wT = (running && mph > 5) ? 0.012 + Math.min(0.05, (mph - 5) * 0.0028) : 0;
  gWind.gain.setTargetAtTime(wT, t, 1.5);
  wLFOdepth.gain.setTargetAtTime(wT * 0.6, t, 1.5);

  /* Water + riparian insects + mix (v1.1, item B): all targets come
     from computeLevels() — the same function __AMB.levels() exposes
     for instrumented verification, so the measured numbers are the
     shipped behaviour. Recomputed on the normal 2 s cadence. */
  var L = computeLevels(p, gm, running);
  if (gCreek) gCreek.gain.setTargetAtTime(L.creek, t, 0.9);
  if (gRiver) gRiver.gain.setTargetAtTime(L.river, t, 0.9);
  if (gFalls) gFalls.gain.setTargetAtTime(L.falls, t, 0.9);
  if (fallsFlutter) fallsFlutter.gain.setTargetAtTime(L.falls * 0.3, t, 0.9);
  if (gInsects) gInsects.gain.setTargetAtTime(L.insects, t, 1.2);
  /* B5 mix balance: publish the duck. The music elements are private
     to index.html's music block (no other file can reach them — the
     harness probe verified this), so the APPLYING lives there: the
     crossfade targets multiply by musicDuck() and a 1.5 s applier in
     the music block holds the playing element at MUSIC_VOL * duck
     between fades. Presence = the strongest nature voice's proximity
     fraction, so the music eases down only where the water and
     insects actually are. */
  window.__musicDuck = L.duck;

  /* Crickets: night only. */
  var nightF = day ? 0 : 1;
  gCrickets.gain.setTargetAtTime(running ? 0.0075 * nightF : 0, t, 2.0);
  crLFOdepth.gain.setTargetAtTime(running ? 0.0035 * nightF : 0, t, 2.0);
}

/* ------------------------------------------------------------------ */
/* waterProximity(p) — v1.1 proximity model for the water voices.
   Distances are SHORE distances in runtime units (~metres): 0 in the
   water or at the bank. Streams measure to the centreline segments
   minus half width (exact segment projection, not point sampling);
   bodies use the v1.0 ellipse approximation on their bboxes. Falls
   distance is to the Tatum outlet anchor point. Fractions are the
   falloff curves from the header (0 at the radius, 1 at the shore). */
function segDist(px, pz, ax, az, bx, bz){
  var abx = bx - ax, abz = bz - az;
  var l2 = abx * abx + abz * abz;
  var t = l2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  var dx = px - (ax + abx * t), dz = pz - (az + abz * t);
  return Math.sqrt(dx * dx + dz * dz);
}
function fallsAnchor(){
  if (fallsPt) return fallsPt;
  try{
    var PW = window.__PKG_WATER;
    if (!PW) return null;
    var lake = null;
    (PW.bodies || []).forEach(function(b){
      if (/tatum/i.test(b.name || '')) lake = b;
    });
    if (!lake) return null;
    var best = null, bd = Infinity;
    (PW.streams || []).forEach(function(s){
      if (!/outlet/i.test(s.name || '') || !s.pts || !s.pts.length) return;
      [s.pts[0], s.pts[s.pts.length - 1]].forEach(function(pt){
        var d = Math.hypot(pt[0] - lake.x, pt[1] - lake.z);
        if (d < bd){ bd = d; best = { x: pt[0], z: pt[1] }; }
      });
    });
    if (best) fallsPt = best;
  }catch(e){}
  return fallsPt;
}
function waterProximity(p){
  var out = { creekF: 0, riverF: 0, fallsF: 0,
              dCreek: null, dRiver: null, dFalls: null,
              dLake: null, dStream: null };
  if (!p) return out;
  function upd(key, d){
    if (d !== null && isFinite(d) && (out[key] === null || d < out[key]))
      out[key] = d;
  }
  function streamDist(s){
    var best = Infinity;
    var pts = s.pts || [];
    for (var k = 0; k < pts.length - 1; k++){
      var d = segDist(p.x, p.z, pts[k][0], pts[k][1],
                      pts[k + 1][0], pts[k + 1][1]);
      if (d < best) best = d;
    }
    if (pts.length === 1)
      best = Math.hypot(p.x - pts[0][0], p.z - pts[0][1]);
    return best - ((s.width || 7) / 2);
  }
  try{
    var PW = window.__PKG_WATER;
    if (PW){
      (PW.streams || []).forEach(function(s){
        var d = Math.max(0, streamDist(s));
        upd('dStream', d);
        if ((s.width || 7) >= 30) upd('dRiver', d); else upd('dCreek', d);
      });
      (PW.bodies || []).forEach(function(b){
        var qx = (p.x - b.x) / Math.max(1, b.rx),
            qz = (p.z - b.z) / Math.max(1, b.rz);
        var q = Math.sqrt(qx * qx + qz * qz);
        upd('dLake', q < 1 ? 0 : (q - 1) * Math.min(b.rx, b.rz));
      });
      var fa = fallsAnchor();
      if (fa) out.dFalls = Math.hypot(p.x - fa.x, p.z - fa.z);
    } else if (typeof WATER !== 'undefined'){
      /* Legacy registry fallback (same classes as the package path). */
      for (var m = 0; m < WATER.length; m++){
        var w = WATER[m];
        if (w.river){
          var ss = { pts: w.river, width: w.width || (w.creek ? 8 : 30) };
          var dd = Math.max(0, streamDist(ss));
          upd('dStream', dd);
          if (w.creek) upd('dCreek', dd); else upd('dRiver', dd);
        } else if (typeof w.rx === 'number'){
          var ex = (p.x - w.x) / Math.max(1, w.rx),
              ez = (p.z - w.z) / Math.max(1, w.rz);
          var eq = Math.sqrt(ex * ex + ez * ez);
          upd('dLake', eq < 1 ? 0 : (eq - 1) * Math.min(w.rx, w.rz));
        }
      }
    }
  }catch(e){}
  function fall(d, R){ return d === null ? 0 : Math.max(0, 1 - d / R); }
  out.creekF = Math.max(fall(out.dCreek, 45), 0.5 * fall(out.dLake, 45));
  out.riverF = fall(out.dRiver, 70);
  out.fallsF = fall(out.dFalls, 38);
  return out;
}

/* computeLevels(p, gm, running) — THE target gains for the water,
   insect and duck values, in one place: retarget() applies exactly
   these numbers and __AMB.levels() reports exactly these numbers. */
function computeLevels(p, gm, running){
  var prox = waterProximity(p);
  var creek = running ? 0.085 * Math.pow(prox.creekF, 1.6) : 0;
  var river = running ? 0.110 * Math.pow(prox.riverF, 1.6) : 0;
  var falls = running ? 0.075 * Math.pow(prox.fallsF, 1.8) : 0;
  /* Insects: along any stream (shore distance), daytime-weighted —
     grasshoppers sing by day (the video is a summer day); a low
     night floor near water keeps a cricket character after dark,
     under the v1.0 night-cricket layer. */
  var dayF = isDay(gm) ? 1 : 0.3;
  var insF = prox.dStream === null ? 0
    : Math.max(0, 1 - Math.max(0, prox.dStream - 2) / 38);
  /* v1.2 (W4): 0.0060 -> 0.0130 — the layer fired at the creek but
     sat ~24 dB under the creek voice, imperceptible on a phone
     speaker (Joshua heard no insects on ui 2026.11.07.3). */
  var insects = running ? 0.0130 * insF * dayF : 0;
  var presence = Math.max(prox.creekF, prox.riverF, prox.fallsF);
  return { creek: creek, river: river, falls: falls, insects: insects,
           duck: 1 - 0.45 * presence, prox: prox };
}

/* ------------------------------------------------------------------ */
/* B4 — wading / swimming sound engine. Runs on the render tick (not
   the 2 s retarget): reads the player's water state from the game's
   own model (waterDepthAt + player.swimming, i.e. the three states:
   wade / swim-moving / tread) and his speed from position deltas.
   Every splash is a short shaped burst of the water-noise buffer —
   generated in-code, no assets. splashCount is the instrumentation
   the harness reads to prove the voices fire.

   GAIN STAGING FIX (2026-11-01 fix batch v2, item 4): Joshua ran
   the Tatum creek's length on build .6 and heard NO splashing,
   though the triggers fired (harness-proven: state reads wading,
   bursts trigger, grass stays silent). The bursts were inaudible
   because the step peak scaled with depth/SWIM_DEPTH: in the
   shallow creek (0.24 u of 1.216) a step peaked at 0.055 — UNDER
   the creek's own continuous layer (0.085) and in the same band
   (760 Hz vs the layer's ~950 Hz), so the water masked its own
   splashes. A splash is a STRIDE sound, not a depth sound: steps
   now peak 0.15-0.26 scaled by SPEED, brighter (1280 Hz) and a
   touch longer so they read as splatter over the bed layer;
   strokes rise to 0.20 over the river layer (0.110); enter 0.22.
   Every burst is logged (kind, peak, time) on __AMB.gains() so
   the audibility staging is verifiable, not asserted. */
function splashBurst(kind, opt){
  opt = opt || {};
  if (!ctx || ctx.state !== 'running' || !master || isMuted() || !enabled)
    return;
  try{
    var t = ctx.currentTime;
    var speedF = Math.max(0, Math.min(1, opt.speed || 0));
    /* Peak staging UNCHANGED from the 2026-11-01 fix (a splash is a
       stride sound, scaled by speed — see the header above). Only
       the RECIPE changed (v1.2, W2 in the changelog): the old
       single band-passed ping of pre-smoothed noise read as a TAP;
       a real splash is broadband impact + falling cavity + spray. */
    var peak = kind === 'stroke' ? 0.20 : kind === 'enter' ? 0.22 :
               kind === 'tread' ? 0.045 :
               0.15 + 0.11 * speedF;
    var srcBuf = whiteBuf || waterBuf;
    /* --- 1. IMPACT: raw white noise, low-pass sweeping 3 kHz down
       to 600 Hz over ~0.12 s — the foot/body displacing water. A
       random buffer offset per burst: no two steps share a
       waveform onset (the old loop replayed the same grain every
       step, one more reason it read as the same object tapped). */
    var s = ctx.createBufferSource();
    s.buffer = srcBuf; s.loop = true;
    s.playbackRate.value = 0.9 + Math.random() * 0.25;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 0.4;
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(600, t + 0.12);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001,
      t + (kind === 'tread' ? 0.16 : 0.20));
    s.connect(lp); lp.connect(g); g.connect(master);
    s.start(t, Math.random() * 1.5); s.stop(t + 0.30);
    /* --- 2. BLOOP: a sine glissando ~420 -> ~140 Hz under the
       impact — the falling resonance of displaced water, the part
       that makes ears say "liquid". Low gain; skipped for the
       faint 'tread' voice, where it would only muddy. */
    if (kind !== 'tread'){
      var o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(420 * (0.94 + Math.random() * 0.12), t);
      o.frequency.exponentialRampToValueAtTime(140,
        t + 0.10 + Math.random() * 0.05);
      var og = ctx.createGain();
      var bpk = Math.min(0.08, peak * 0.35);
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(bpk, t + 0.02);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(og); og.connect(master);
      o.start(t); o.stop(t + 0.20);
    }
    /* --- 3. DROPLET PATTER: 3–6 micro-bursts of high-passed noise
       (≥ 4 kHz), 8–25 ms each, scattered 40–350 ms behind the
       impact at decaying gains — the spray landing back on the
       surface. A step is an event PLUS its spray; the old recipe
       had the event only. */
    var nD = 3 + Math.floor(Math.random() * 4);
    var span = kind === 'tread' ? 0.18 : 0.35;
    for (var di = 0; di < nD; di++){
      var dAt = 0.04 + Math.random() * span;
      var dDur = 0.008 + Math.random() * 0.017;
      var ds = ctx.createBufferSource();
      ds.buffer = srcBuf; ds.loop = true;
      ds.playbackRate.value = 1.1 + Math.random() * 0.5;
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 4000 + Math.random() * 1500;
      var dg = ctx.createGain();
      var dpk = Math.max(0.004,
        peak * (0.10 + Math.random() * 0.12) * (1 - (dAt / (span + 0.1)) * 0.5));
      dg.gain.setValueAtTime(0.0001, t + dAt);
      dg.gain.exponentialRampToValueAtTime(dpk, t + dAt + 0.004);
      dg.gain.exponentialRampToValueAtTime(0.0001, t + dAt + dDur + 0.01);
      ds.connect(hp); hp.connect(dg); dg.connect(master);
      ds.start(t + dAt, Math.random() * 1.5); ds.stop(t + dAt + dDur + 0.05);
    }
    splashCount++;
    lastSplash = { kind: kind, peak: +peak.toFixed(3), at: Date.now() };
    splashLog.push(lastSplash);
    if (splashLog.length > 16) splashLog.shift();
  }catch(e){}
}
function tickWading(dt){
  var p = playerPos();
  if (!p) return;
  var now = performance.now() / 1000;
  /* Wall-clock dt for the splash countdown (NOT the Sim tick's dt):
     the cadence must track the player's real movement — on a slow
     device the render-step dt runs behind wall time and would space
     the splashes far apart while he is plainly striding. Speed is
     likewise measured on wall time, with the per-sample contribution
     clamped so a teleport (or a hitch) cannot poison the EMA. */
  var wallDt = wadeState.lt > 0 ? Math.min(0.25, now - wadeState.lt) : 0;
  if (wadeState.lx !== null && wadeState.lt > 0){
    var dtt = Math.max(0.001, now - wadeState.lt);
    var dsp = Math.hypot(p.x - wadeState.lx, p.z - wadeState.lz);
    var inst = Math.min(40, dsp / dtt);
    wadeState.speed = 0.6 * wadeState.speed + 0.4 * inst;
  }
  wadeState.lx = p.x; wadeState.lz = p.z; wadeState.lt = now;
  var depth = 0, swimming = false;
  try{
    if (typeof waterDepthAt === 'function'){
      var wd = waterDepthAt(p.x, p.z);
      if (typeof wd === 'number' && isFinite(wd)) depth = Math.max(0, wd);
    }
  }catch(e){}
  try{
    swimming = (typeof player !== 'undefined' && player && !!player.swimming);
  }catch(e){}
  var inWater = depth > 0.03 || swimming;
  wadeState.inWater = inWater;
  wadeState.swimming = swimming;
  wadeState.depth = depth;
  if (inWater && !wadeState.wasInWater) splashBurst('enter', {});
  wadeState.wasInWater = inWater;
  if (!inWater || !ctx || ctx.state !== 'running') return;
  wadeState.nextSplash -= wallDt;
  if (wadeState.nextSplash > 0) return;
  var moving = wadeState.speed > 0.6;
  var speedF = Math.min(1, wadeState.speed / 6);
  if (swimming && moving){
    splashBurst('stroke', { speed: speedF });
    wadeState.nextSplash = 0.55;          /* stroke rhythm */
  } else if (swimming && !moving){
    splashBurst('tread', {});
    wadeState.nextSplash = 1.7;           /* faint, occasional */
  } else if (moving){
    splashBurst('step', { speed: speedF });
    /* stride cadence: a step every ~2.4 u of travel, clamped */
    wadeState.nextSplash =
      Math.min(0.85, Math.max(0.30, 2.4 / Math.max(1, wadeState.speed)));
  } else {
    wadeState.nextSplash = 0.3;  /* standing in shallows: silent */
  }
}

/* ------------------------------------------------------------------ */
/* BIRDS — RETIRED (v1.2, W1). The scheduled chirp events that used
   to live here (chirp()/scheduleBird(): 1–3 random sine sweeps every
   2.5–7.5 s, straight into the master — no bird, no position, no
   distance) are DELETED, not disabled. Birdsong is wildlife now:
   wildlife_system.js keeps one voice per bird through ambVoice()
   below, gained by the bird's distance exactly the way the water
   voices are gained by shore distance. Nothing in this module
   makes a bird sound any more. */

/* ambVoice() — the wildlife voice door (v1.2, W3). Creates a gain
   node INTO the ambient master and hands it to the caller with the
   shared context, so a creature's song rides the same
   gesture/mute/enabled path as every ambient layer (master gain is
   retarget()'s — a muted or suspended game silences wildlife too,
   by construction, not by the caller remembering to check).
   Returns null when audio is unavailable; callers must cope.
   Handle: { ctx, out, now(), running(), setGain(v, tc), destroy() } */
function ambVoice(){
  if (!ensureCtx() || !master || !ctx) return null;
  try{
    var g = ctx.createGain();
    g.gain.value = 1;
    g.connect(master);
    return {
      ctx: ctx, out: g,
      now: function(){ return ctx ? ctx.currentTime : 0; },
      running: function(){
        return !!(ctx && ctx.state === 'running' && enabled && !isMuted());
      },
      setGain: function(v, tc){
        try{
          g.gain.setTargetAtTime(Math.max(0, v), ctx.currentTime,
                                 (typeof tc === 'number') ? tc : 0.25);
        }catch(e){}
      },
      destroy: function(){ try{ g.disconnect(); }catch(e){} }
    };
  }catch(e){ return null; }
}

/* ------------------------------------------------------------------ */
/* Distant siren — a rare, very quiet two-tone sweep. More likely
   downtown, where emergency traffic actually is. */
function siren(){
  if (!ctx || ctx.state !== 'running' || !master) return;
  try{
    var t = ctx.currentTime + 0.05;
    var o = ctx.createOscillator(), g = ctx.createGain(),
        f = ctx.createBiquadFilter();
    o.type = 'triangle';
    f.type = 'lowpass'; f.frequency.value = 1400;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.016, t + 1.2);
    g.gain.setValueAtTime(0.016, t + 4.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 6.0);
    for (var i = 0; i < 6; i++)
      o.frequency.setValueAtTime(i % 2 ? 940 : 680, t + i * 0.55);
    o.connect(f); f.connect(g); g.connect(master);
    o.start(t); o.stop(t + 6.5);
  }catch(e){}
}
function sirenProb(day){
  var base = day ? 0.5 : 0.25;
  try{
    var p = playerPos();
    if (!p) return base * 0.5;
    var d = downtownXZ();
    if (d){
      var dx = p.x - d.x, dz = p.z - d.z;
      if (dx * dx + dz * dz < 1200 * 1200) return Math.min(0.9, base * 1.6);
    }
  }catch(e){}
  return base * 0.5;
}
function scheduleSiren(){
  if (sirenTO){ clearTimeout(sirenTO); sirenTO = null; }
  sirenTO = setTimeout(function(){
    sirenTO = null;
    try{
      if (ctx && ctx.state === 'running' && enabled && !isMuted() &&
          Math.random() < sirenProb(isDay(gameMin()))) siren();
    }catch(e){}
    scheduleSiren();
  }, 70000 + Math.random() * 110000);
}

/* ------------------------------------------------------------------ */
/* Render-tick: accumulate time, retarget every RETARGET_S. */
function tick(dt){
  if (!ctx) return;
  /* B4 wading engine runs every frame (splashes are events, not
     levels, so they cannot ride the 2 s retarget). */
  try{ tickWading(dt); }catch(e){}
  retargetT += dt;
  if (retargetT >= RETARGET_S){
    retargetT = 0;
    try{ retarget(); }catch(e){}
  }
}

/* ------------------------------------------------------------------ */
/* Boot — same deferred pattern as gps_system.js: poll until the Sim
   registry exists, then wire up. Never throws; never blocks load. */
function boot(){
  if (!ensureCtx()) return false;
  try{
    if (window.Sim && typeof window.Sim.onTick === 'function'){
      window.Sim.onTick('render', 80, function(dt){
        try{ tick(dt); }catch(e){}
      });
    } else {
      return false;
    }
  }catch(e){ return false; }
  scheduleSiren();
  try{ retarget(); }catch(e){}
  /* Debug / tuning handle (v1.1: instrumented verification surface —
     levels() returns the exact targets retarget() applies, gains()
     reads the live node values, and the splash counter + wading
     snapshot prove the B4 voices fire in each water state). */
  window.__AMB = {
    version: '1.2',
    retarget: retarget, siren: siren,
    splash: splashBurst,
    voice: ambVoice,
    setEnabled: function(v){ enabled = !!v; try{ retarget(); }catch(e){} },
    levels: function(){
      var L = computeLevels(playerPos(), gameMin(),
                            !!(ctx && ctx.state === 'running'));
      return { creek: +L.creek.toFixed(4), river: +L.river.toFixed(4),
               falls: +L.falls.toFixed(4), insects: +L.insects.toFixed(4),
               duck: +L.duck.toFixed(3),
               dCreekM: L.prox.dCreek, dRiverM: L.prox.dRiver,
               dFallsM: L.prox.dFalls, dStreamM: L.prox.dStream,
               fallsPt: fallsPt };
    },
    gains: function(){
      function gv(g){ return g ? +g.gain.value.toFixed(4) : null; }
      return { creek: gv(gCreek), river: gv(gRiver), falls: gv(gFalls),
               insects: gv(gInsects), crickets: gv(gCrickets),
               traffic: gv(gTraffic), wind: gv(gWind),
               master: gv(master),
               ctxState: ctx ? ctx.state : null,
               musicDuck: window.__musicDuck || 1,
               musicVol: (typeof musicAudio !== 'undefined' && musicAudio)
                         ? musicAudio.volume : null,
               musicPlaying: (typeof musicAudio !== 'undefined' &&
                              musicAudio) ? !musicAudio.paused : null,
               splashes: splashCount,
               lastSplash: lastSplash,
               splashLog: splashLog.slice(),
               wading: { inWater: wadeState.inWater,
                         swimming: wadeState.swimming,
                         depth: +wadeState.depth.toFixed(3),
                         speed: +wadeState.speed.toFixed(2) } };
    },
    get state(){
      return {
        version: '1.2',
        running: !!(ctx && ctx.state === 'running'),
        muted: isMuted(), gameMin: gameMin(), enabled: enabled
      };
    }
  };
  try{
    if (typeof Report !== 'undefined')
      Report.note('ambient-audio', { boot: 'ok' });
  }catch(e){}
  return true;
}

bootTimer = setInterval(function(){
  bootTries++;
  var ok = false;
  try{ ok = boot(); }catch(e){ ok = false; }
  if (ok){ clearInterval(bootTimer); bootTimer = null; }
  else if (bootTries > 240){
    clearInterval(bootTimer); bootTimer = null;
    try{
      if (typeof Report !== 'undefined')
        Report.noteError('ambient-audio', 'boot-timeout', 'Sim registry never ready');
    }catch(e){}
  }
}, 500);

})();
