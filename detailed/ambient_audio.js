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
     4. BIRDS       — scheduled chirp events (short sine sweeps), daytime
        only. More frequent in quiet/low-traffic areas (parks, side
        streets); sparse near busy roads.
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
var ctx = null, master = null, noiseBuf = null;
var gTraffic = null, gWind = null, gCrickets = null;
var wLFOdepth = null, crLFOdepth = null;   /* LFO depth gains (see buildLayers) */
var retargetT = 0, enabled = true;
var downtown = null;                        /* {x,z} once resolved */
var birdTO = null, sirenTO = null;
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
  try{ return (typeof musicMuted !== 'undefined' && musicMuted); }catch(e){}
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

  /* Wind: always a faint bed, breathing slowly. */
  gWind.gain.setTargetAtTime(running ? 0.010 : 0, t, 1.5);
  wLFOdepth.gain.setTargetAtTime(running ? 0.006 : 0, t, 1.5);

  /* Crickets: night only. */
  var nightF = day ? 0 : 1;
  gCrickets.gain.setTargetAtTime(running ? 0.0075 * nightF : 0, t, 2.0);
  crLFOdepth.gain.setTargetAtTime(running ? 0.0035 * nightF : 0, t, 2.0);
}

/* ------------------------------------------------------------------ */
/* Birds — scheduled chirp events, daytime only. A chirp is 1–3 short
   sine sweeps; each is its own throwaway node so nothing accumulates. */
function chirp(){
  if (!ctx || ctx.state !== 'running' || !master) return;
  try{
    var t = ctx.currentTime + 0.05;
    var n = 1 + Math.floor(Math.random() * 3);
    for (var i = 0; i < n; i++){
      (function(i){
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        var f0 = 2400 + Math.random() * 1200;
        var st = t + i * 0.22;
        o.frequency.setValueAtTime(f0, st);
        o.frequency.exponentialRampToValueAtTime(Math.max(800, f0 * 1.35), st + 0.09);
        o.frequency.exponentialRampToValueAtTime(Math.max(800, f0 * 0.9), st + 0.16);
        g.gain.setValueAtTime(0.0001, st);
        g.gain.exponentialRampToValueAtTime(0.045, st + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, st + 0.18);
        o.connect(g); g.connect(master);
        o.start(st); o.stop(st + 0.25);
      })(i);
    }
  }catch(e){}
}
function scheduleBird(){
  if (birdTO){ clearTimeout(birdTO); birdTO = null; }
  birdTO = setTimeout(function(){
    birdTO = null;
    try{
      var gm = gameMin();
      if (isDay(gm) && ctx && ctx.state === 'running' &&
          enabled && !isMuted()){
        var p = playerPos();
        var dens = p ? trafficDensity(p.x, p.z) : 0.5;
        /* Quiet/green areas chirp more often than busy roadsides. */
        var prob = dens < 0.35 ? 0.8 : 0.35;
        if (Math.random() < prob) chirp();
      }
    }catch(e){}
    scheduleBird();
  }, 2500 + Math.random() * 5000);
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
  scheduleBird();
  scheduleSiren();
  try{ retarget(); }catch(e){}
  /* Debug / tuning handle. */
  window.__AMB = {
    retarget: retarget, chirp: chirp, siren: siren,
    setEnabled: function(v){ enabled = !!v; try{ retarget(); }catch(e){} },
    get state(){
      return {
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
