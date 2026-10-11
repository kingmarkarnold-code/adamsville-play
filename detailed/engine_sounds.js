/* ============================================================================
   ENGINE SOUNDS v1.0 (2026-10-11) — procedural vehicle audio for
   Surviving Adamsville.
   Expert report #37 (Michael Torres, Audio Engineer — Joshua approved
   "Fix 37", then EXPANDED the scope himself): the van was silent when
   driving. Joshua's expanded scope: engine sounds for ALL player-drivable
   vehicles, plus distinct sounds for buses, trains, trucks, and city work
   crews — each vehicle type with its own characteristic engine note.

   DESIGN (Joshua's rules honored):
     - 100% PROCEDURAL via the Web Audio API. Zero audio files, zero
       downloads — nothing to cache-bust, nothing to weigh down the TCL.
     - One shared AudioContext, created lazily on the first user gesture
       (browser autoplay policy). Resumed on every gesture while suspended.
     - Each "voice" = 2 oscillators (main + sub-octave) + 1 looped noise
       source (diesel rumble / rail clatter) -> lowpass filter -> gain.
       Pitch tracks speed: idle sits at the base frequency, full throttle
       pushes ~2.2x. Volume tracks throttle + distance.
     - PLAYER voice (1): follows whatever the player drives or rides —
       van/sedan/Chevy/pickup/SUV by car.kind, MARTA bus, school bus, train.
     - AMBIENT pool (8 voices): nearest audible vehicles within 70u —
       NPC traffic, MARTA buses, school bus, semis, trains, work-crew
       patrols. Volume fades with distance. Reassigned ~4x/second.
     - TRAINS get rail rumble (louder noise bed) + a two-tone horn when
       they pull out of a station near the player.
   Integration: reads sim positions only (car, player.ridingBus,
   player.ridingSchoolBus, player.ridingTrain, window.TRAFFIC,
   window.MARTA_BUS, window.__SB, window.SEMIS, window.MARTA, RC/CE
   patrols) — never touches the other systems' code. Registers on the
   central Sim tick registry ('render', priority 80) per expert #14's
   rule — no animate() monkey-patching.
   Mute: honors its own Settings toggle (Engine sounds: ON/OFF, persisted
   in localStorage) AND the existing Music mute — if the player muted
   audio, engines stay silent too.
   ============================================================================ */
(function engineSounds(){
'use strict';

/* ---------------- tuning ---------------- */
/* Joshua's rule: document the why. 9 voices total: 1 player + 8 ambient.
   8 ambient voices cover the nearest audible vehicles; anything farther
   than 70 world units is inaudible over road noise anyway. Each voice is
   3 nodes (2 osc + 1 noise) — 27 oscillators worst case, trivial for the
   TCL's CPU next to the 3D render load. */
var N_AMBIENT   = 8;
var AUDIBLE_R   = 70;     /* world units: beyond this, volume is 0 */
var RESCAN_EVERY= 15;     /* frames between ambient re-assignment (~4Hz) */
var HORN_COOLDOWN_S = 25; /* seconds between train horns per train */

/* ---------------- vehicle sound profiles ---------------- */
/* base: idle frequency (Hz). Pitch scales with speed: f = base * (1 + 1.2 *
   min(speed,maxSpd)/maxSpd), so full throttle ~= 2.2x idle — the classic
   engine-rev feel. sub: sub-octave oscillator level (0-1). filter: lowpass
   cutoff (Hz) — lower = darker/more muffled. noise: rumble-bed level (0-1).
   gain: master voice level (0-1). maxSpd: world u/s at full rev. */
var PROFILES = {
  /* Joshua's GMC Safari van: V8 rumble, low and throaty. */
  safari:     { base:52, wave:'sawtooth', sub:0.55, filter:420, noise:0.16, gain:0.50, maxSpd:28 },
  sedan:      { base:68, wave:'sawtooth', sub:0.40, filter:620, noise:0.08, gain:0.42, maxSpd:30 },
  /* Donk Chevys: big-block muscle, more growl. */
  boxchevy:   { base:58, wave:'sawtooth', sub:0.60, filter:520, noise:0.12, gain:0.50, maxSpd:32 },
  bubblechevy:{ base:58, wave:'sawtooth', sub:0.60, filter:520, noise:0.12, gain:0.50, maxSpd:32 },
  pickup:     { base:62, wave:'sawtooth', sub:0.45, filter:560, noise:0.10, gain:0.46, maxSpd:30 },
  suv:        { base:60, wave:'sawtooth', sub:0.45, filter:540, noise:0.10, gain:0.46, maxSpd:30 },
  /* Generic NPC traffic cars: quieter so the player's own engine leads. */
  traffic:    { base:70, wave:'sawtooth', sub:0.30, filter:600, noise:0.06, gain:0.26, maxSpd:25 },
  /* City buses: diesel clatter — deeper base, heavy noise bed. */
  bus:        { base:42, wave:'sawtooth', sub:0.70, filter:300, noise:0.34, gain:0.52, maxSpd:22 },
  schoolbus:  { base:44, wave:'sawtooth', sub:0.65, filter:320, noise:0.30, gain:0.50, maxSpd:20 },
  /* 18-wheelers: the biggest diesel on the road. */
  semi:       { base:38, wave:'sawtooth', sub:0.80, filter:250, noise:0.44, gain:0.58, maxSpd:26 },
  /* MARTA rail: electric whine + rail rumble (noise bed dominates). */
  train:      { base:95, wave:'sine',     sub:0.30, filter:900, noise:0.50, gain:0.44, maxSpd:35 },
  /* Work-crew pickups/patrols: mid truck note. */
  patrol:     { base:64, wave:'sawtooth', sub:0.40, filter:550, noise:0.10, gain:0.38, maxSpd:24 }
};

/* ---------------- state ---------------- */
var ctx = null;            /* shared AudioContext, lazy */
var master = null;         /* master gain (mute lives here) */
var noiseBuf = null;       /* shared 2s white-noise buffer */
var playerVoice = null;    /* the one player-following voice */
var ambient = [];          /* pool of N_AMBIENT voices */
var frame = 0;
var engineMuted = false;   /* own Settings toggle */
var hornLast = {};         /* trainId -> last horn time (seconds) */
var _gestureHooked = false;

try{ engineMuted = localStorage.getItem('sa_engine_muted') === '1'; }catch(e){}

/* ==================================================================
   ensureCtx() — build the shared AudioContext on first user gesture.
   Browsers block AudioContext before a gesture; the game already unlocks
   music the same way (index.html unlockAudio), so we piggyback the same
   events. Safe to call repeatedly — no-ops after the first build. */
function ensureCtx(){
  if (ctx) {
    try{ if (ctx.state === 'suspended') ctx.resume(); }catch(e){}
    return true;
  }
  try{
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    /* SHARED context: adopt window.__audioCtx if the sibling ambient-audio
       module (#38) or the game's unlockAudio() already made one; otherwise
       create it and publish it so they (and unlockAudio's resume logic)
       all share the same context. One context for all game audio. */
    if (window.__audioCtx && window.__audioCtx.state !== 'closed'){
      ctx = window.__audioCtx;
    } else {
      ctx = new AC();
      window.__audioCtx = ctx;
    }
    master = ctx.createGain();
    master.gain.value = isMuted() ? 0 : 1;
    master.connect(ctx.destination);
    /* Shared noise buffer: 2 seconds of white noise, looped per voice.
       One buffer for all voices — each voice just gets its own lightweight
       BufferSource pointing at it. */
    var len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    hookGestures();
    return true;
  }catch(e){ return false; }
}

/* Keep the context resumed: mobile browsers love to re-suspend it. */
function hookGestures(){
  if (_gestureHooked) return;
  _gestureHooked = true;
  var resume = function(){ try{ if (ctx && ctx.state === 'suspended') ctx.resume(); }catch(e){} };
  try{
    document.addEventListener('pointerdown', function(){ ensureCtx(); resume(); }, {passive:true});
    document.addEventListener('keydown',     function(){ ensureCtx(); resume(); });
    document.addEventListener('touchstart',  function(){ ensureCtx(); resume(); }, {passive:true});
  }catch(e){}
}

/* ==================================================================
   Mute handling. Engine sounds obey BOTH their own toggle and the
   existing music mute — "mute when game is muted", per the task. */
function isMuted(){
  if (engineMuted) return true;
  try{
    /* The music system exposes musicMuted as a global var in index.html.
       typeof-guard: if the music block hasn't run, treat as unmuted. */
    if (typeof musicMuted !== 'undefined' && musicMuted) return true;
  }catch(e){}
  return false;
}
function applyMute(){
  if (!master) return;
  try{ master.gain.setTargetAtTime(isMuted() ? 0 : 1, ctx.currentTime, 0.05); }catch(e){}
}
function setEngineMuted(m){
  engineMuted = !!m;
  try{ localStorage.setItem('sa_engine_muted', engineMuted ? '1' : '0'); }catch(e){}
  applyMute();
  var b = document.getElementById('set-engine');
  if (b) b.textContent = 'Engine sounds: ' + (engineMuted ? 'OFF' : 'ON');
  try{ if (typeof Report !== 'undefined' && Report.note) Report.note('engine-mute', {muted:engineMuted}); }catch(e){}
}

/* ==================================================================
   Voice — one sounding vehicle. Two oscillators (main + sub-octave)
   plus a noise source for rumble, through a lowpass filter into a gain.
   setTarget() is called per frame with the vehicle's speed and a 0..1
   loudness; update() slews actual params toward targets with
   setTargetAtTime so there is no zipper noise. */
function Voice(){
  this.osc1 = null; this.osc2 = null; this.noise = null;
  this.filter = null; this.gain = null; this.noiseGain = null;
  this.profile = null; this.on = false;
  this._f = 0; this._g = 0; this._n = 0;
}
Voice.prototype.start = function(profile){
  if (!ctx || this.on) return;
  try{
    this.profile = profile;
    this.osc1 = ctx.createOscillator();
    this.osc1.type = profile.wave;
    this.osc1.frequency.value = profile.base;
    /* Sub-octave: half frequency, adds body without extra harshness. */
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'sine';
    this.osc2.frequency.value = profile.base / 2;
    var subG = ctx.createGain();
    subG.gain.value = profile.sub;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = profile.filter;
    this.filter.Q.value = 0.8;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    /* Noise bed: looped shared buffer -> bandpass-ish lowpass -> gain. */
    this.noise = ctx.createBufferSource();
    this.noise.buffer = noiseBuf;
    this.noise.loop = true;
    var nf = ctx.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.value = Math.min(900, profile.filter * 1.6);
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.osc1.connect(this.filter);
    this.osc2.connect(subG); subG.connect(this.filter);
    this.filter.connect(this.gain);
    this.noise.connect(nf); nf.connect(this.noiseGain); this.noiseGain.connect(master);
    this.gain.connect(master);
    this.osc1.start(); this.osc2.start(); this.noise.start();
    this._f = profile.base; this._g = 0; this._n = 0;
    this.on = true;
  }catch(e){ this.on = false; }
};
/* speed: world u/s. loud: 0..1 overall loudness (distance fade for
   ambient, throttle feel for the player). */
Voice.prototype.setTarget = function(speed, loud){
  if (!this.on || !this.profile) return;
  try{
    var p = this.profile;
    var frac = Math.min(1, Math.max(0, speed) / p.maxSpd);
    /* Idle never fully silent while the voice is assigned: a parked bus
       still idles. Floor the frequency at idle, scale loudness by loud. */
    var f = p.base * (1 + 1.2 * frac);
    var g = p.gain * loud * (0.35 + 0.65 * Math.min(1, 0.25 + frac));
    var n = p.noise * loud * (0.4 + 0.6 * frac);
    var t = ctx.currentTime;
    /* Slew fast enough to feel responsive, slow enough to avoid zipper. */
    this.osc1.frequency.setTargetAtTime(f, t, 0.06);
    this.osc2.frequency.setTargetAtTime(f / 2, t, 0.06);
    this.gain.gain.setTargetAtTime(g, t, 0.08);
    this.noiseGain.gain.setTargetAtTime(n, t, 0.10);
    this._f = f; this._g = g; this._n = n;
  }catch(e){}
};
Voice.prototype.silence = function(){
  if (!this.on) return;
  try{
    var t = ctx.currentTime;
    this.gain.gain.setTargetAtTime(0, t, 0.10);
    this.noiseGain.gain.setTargetAtTime(0, t, 0.10);
    this._g = 0; this._n = 0;
  }catch(e){}
};
Voice.prototype.stop = function(){
  if (!this.on) return;
  try{
    var t = ctx.currentTime;
    this.gain.gain.setTargetAtTime(0, t, 0.05);
    this.noiseGain.gain.setTargetAtTime(0, t, 0.05);
    var o1 = this.osc1, o2 = this.osc2, nz = this.noise;
    setTimeout(function(){ try{ o1.stop(); }catch(e){} try{ o2.stop(); }catch(e){} try{ nz.stop(); }catch(e){} }, 300);
  }catch(e){}
  this.on = false; this.profile = null;
};

/* ==================================================================
   Train horn — two-tone (A3+E4-ish), 1.1s blast through a bandpass so
   it cuts through the mix. One shared helper, not per-voice. */
function horn(){
  if (!ctx || isMuted()) return;
  try{
    var t = ctx.currentTime;
    [233.1, 311.1].forEach(function(f){
      var o = ctx.createOscillator();
      o.type = 'square'; o.frequency.value = f;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 2;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.05);
      g.gain.setValueAtTime(0.16, t + 0.9);
      g.gain.linearRampToValueAtTime(0, t + 1.15);
      o.connect(bp); bp.connect(g); g.connect(master);
      o.start(t); o.stop(t + 1.25);
    });
  }catch(e){}
}

/* ==================================================================
   Vehicle census — gather every sounding vehicle near the player.
   Returns [{x, z, speed, profile, id}]. Reads sim state only. */
function census(){
  var out = [];
  var px = 0, pz = 0;
  try{
    if (typeof player !== 'undefined' && player){ px = player.x || 0; pz = player.z || 0; }
  }catch(e){}
  function push(x, z, speed, profile, id){
    if (!isFinite(x) || !isFinite(z)) return;
    var dx = x - px, dz = z - pz;
    var d2 = dx * dx + dz * dz;
    if (d2 > AUDIBLE_R * AUDIBLE_R) return;
    out.push({ x:x, z:z, speed:speed || 0, profile:profile, id:id || '', d:Math.sqrt(d2) });
  }
  try{
    /* NPC traffic (traffic_system.js): TR.cars[] {x,y,z,heading,speed}. */
    var TR = window.TRAFFIC;
    if (TR && TR.cars){
      var n = Math.min(TR.cars.length, 40);
      for (var i = 0; i < n; i++){
        var c = TR.cars[i];
        if (c) push(c.x, c.z, c.speed, PROFILES.traffic, 'traf' + c.id);
      }
    }
  }catch(e){}
  try{
    /* MARTA city buses: MB.buses[] {x,z,speed}. */
    var MB = window.MARTA_BUS;
    if (MB && MB.buses){
      for (var i = 0; i < MB.buses.length; i++){
        var b = MB.buses[i];
        if (b && !(typeof player !== 'undefined' && player && player.ridingBus === b))
          push(b.x, b.z, b.speed, PROFILES.bus, 'mbus' + i);
      }
    }
  }catch(e){}
  try{
    /* School bus: window.__SB {buses[]} or single bus {x,z,speed}. */
    var SB = window.__SB;
    if (SB){
      var sbs = SB.buses || [SB];
      for (var i = 0; i < sbs.length; i++){
        var sb = sbs[i];
        if (sb && sb.x !== undefined &&
            !(typeof player !== 'undefined' && player && player.ridingSchoolBus === sb))
          push(sb.x, sb.z, sb.speed, PROFILES.schoolbus, 'sbus' + i);
      }
    }
  }catch(e){}
  try{
    /* Semis: window.SEMIS {semis[] {x,z,speed}}. */
    var SE = window.SEMIS;
    if (SE && SE.semis){
      for (var i = 0; i < SE.semis.length; i++){
        var s = SE.semis[i];
        if (s) push(s.x, s.z, s.speed, PROFILES.semi, 'semi' + i);
      }
    }
  }catch(e){}
  try{
    /* MARTA trains: window.MARTA {trains[] {x,z,speed}}. */
    var MT = window.MARTA;
    if (MT && MT.trains){
      for (var i = 0; i < MT.trains.length; i++){
        var t = MT.trains[i];
        if (t && !(typeof player !== 'undefined' && player && player.ridingTrain === t))
          push(t.x, t.z, t.speed, PROFILES.train, 'train' + i);
      }
    }
  }catch(e){}
  try{
    /* Work-crew patrols: road crew (RC) + code enforcement (CE).
       Position lives on the mesh; speed on the record. */
    var RC = (typeof window.RC !== 'undefined') ? window.RC : null;
    if (RC && RC.patrols){
      for (var i = 0; i < RC.patrols.length; i++){
        var r = RC.patrols[i];
        if (r && r.mesh) push(r.mesh.position.x, r.mesh.position.z, r.speed, PROFILES.patrol, 'rc' + i);
      }
    }
    var CE = (typeof window.CE !== 'undefined') ? window.CE : null;
    if (CE && CE.patrols){
      for (var i = 0; i < CE.patrols.length; i++){
        var ce = CE.patrols[i];
        if (ce && ce.mesh) push(ce.mesh.position.x, ce.mesh.position.z, ce.speed, PROFILES.patrol, 'ce' + i);
      }
    }
  }catch(e){}
  return out;
}

/* ==================================================================
   Player vehicle — what the player is driving or riding right now.
   Returns {speed, profile} or null. */
function playerVehicle(){
  try{
    if (typeof car !== 'undefined' && car && car.driving){
      var prof = PROFILES[car.kind] || PROFILES.sedan;
      return { speed: Math.abs(car.speed || 0), profile: prof };
    }
    if (typeof player !== 'undefined' && player){
      if (player.ridingBus)      return { speed: Math.abs(player.ridingBus.speed || 0),      profile: PROFILES.bus };
      if (player.ridingSchoolBus) return { speed: Math.abs(player.ridingSchoolBus.speed || 0), profile: PROFILES.schoolbus };
      if (player.ridingTrain)    return { speed: Math.abs(player.ridingTrain.speed || 0),    profile: PROFILES.train };
    }
  }catch(e){}
  return null;
}

/* ==================================================================
   Per-frame update (runs on the Sim 'render' tick, throttled inside). */
function update(){
  if (!ctx) return;
  frame++;
  var pv = playerVehicle();

  /* --- player voice: full volume, follows the driven/ridden vehicle --- */
  if (!playerVoice) playerVoice = new Voice();
  if (pv){
    if (!playerVoice.on || playerVoice.profile !== pv.profile){
      playerVoice.stop();
      playerVoice.start(pv.profile);
    }
    /* Idle still rumbles: floor loudness at 0.55 so a stopped engine is
       heard idling, not silent. */
    playerVoice.setTarget(pv.speed, pv.speed > 0.3 ? 1 : 0.55);
  } else {
    playerVoice.silence();
  }

  /* --- train horns: pulling out of a station near the player --- */
  try{
    var MT = window.MARTA;
    if (MT && MT.trains){
      var now = ctx.currentTime;
      var px = (typeof player !== 'undefined' && player) ? player.x || 0 : 0;
      var pz = (typeof player !== 'undefined' && player) ? player.z || 0 : 0;
      for (var i = 0; i < MT.trains.length; i++){
        var t = MT.trains[i];
        if (!t || !isFinite(t.x)) continue;
        var dx = t.x - px, dz = t.z - pz;
        if (dx * dx + dz * dz > 60 * 60) continue;
        /* Horn when a stopped train starts moving (leaving a station). */
        var wasStopped = t._esWasStopped;
        var stopped = (t.speed || 0) < 0.5;
        t._esWasStopped = stopped;
        if (wasStopped && !stopped && (!hornLast[i] || now - hornLast[i] > HORN_COOLDOWN_S)){
          hornLast[i] = now;
          horn();
        }
      }
    }
  }catch(e){}

  /* --- ambient pool: reassign every RESCAN_EVERY frames --- */
  if (frame % RESCAN_EVERY !== 0){
    /* Between rescans, keep slewing current voices toward fresh speeds. */
    for (var a = 0; a < ambient.length; a++){
      var v = ambient[a];
      if (v && v.on && v._cand) v.setTarget(v._cand.speed, v._loud || 0);
    }
    return;
  }
  var cands = census();
  /* Nearest first — the 8 closest audible vehicles win voices. */
  cands.sort(function(a, b){ return a.d - b.d; });
  var n = Math.min(N_AMBIENT, cands.length);
  while (ambient.length < N_AMBIENT) ambient.push(new Voice());
  for (var k = 0; k < N_AMBIENT; k++){
    var vv = ambient[k];
    if (k < n){
      var cd = cands[k];
      var loud = Math.max(0, 1 - cd.d / AUDIBLE_R);
      /* Parked silent vehicles get a whisper of idle, not full silence,
         so a bus at a stop still breathes. */
      if (cd.speed < 0.3) loud *= 0.45;
      if (!vv.on || vv.profile !== cd.profile){
        vv.stop();
        vv.start(cd.profile);
      }
      vv._cand = cd;
      vv._loud = loud;
      vv.setTarget(cd.speed, loud);
    } else {
      vv._cand = null;
      vv.silence();
    }
  }
}

/* ==================================================================
   Public API (window.EngineSound): mute toggle, manual refresh hook. */
function init(){
  /* Build the voice pool shells now; oscillators start lazily on the
     first user gesture (autoplay policy). */
  playerVoice = new Voice();
  ambient = [];
  for (var i = 0; i < N_AMBIENT; i++) ambient.push(new Voice());
  /* First-gesture unlock: any tap/click/keypress builds the context. */
  try{
    var kick = function(){ ensureCtx(); };
    document.addEventListener('pointerdown', kick, {passive:true, once:false});
    document.addEventListener('keydown', kick, {once:false});
  }catch(e){}

  /* Settings toggle row lives next to the Music row (index.html wires
     the click; we also wire here in case this module loads first). */
  try{
    var b = document.getElementById('set-engine');
    if (b){
      b.textContent = 'Engine sounds: ' + (engineMuted ? 'OFF' : 'ON');
      b.addEventListener('click', function(){ setEngineMuted(!engineMuted); });
    }
  }catch(e){}

  /* Register on the central tick registry (expert #14 pattern):
     'render' phase, priority 80 — after blob shadows (60) and GPS (75). */
  try{
    if (window.Sim && typeof window.Sim.onTick === 'function' && !window.__engineSndTickReg){
      window.__engineSndTickReg = true;
      window.Sim.onTick('render', 80, function(){ try{ update(); }catch(e){} });
    }
  }catch(e){}

  window.EngineSound = {
    setMuted: setEngineMuted,
    isMuted: isMuted,
    refresh: function(){ ensureCtx(); applyMute(); }
  };
  try{ if (typeof Report !== 'undefined' && Report.setSys) Report.setSys('enginesounds', 'ok', 'procedural engine audio live (1 player + 8 ambient voices)'); }catch(e){}
}

/* ---------------- boot poll ---------------- */
/* Deferred scripts load after launcher confirmation; Sim comes from
   index.html block 1. Poll until the world is ready (900 x 500ms cap,
   same as blob_shadows.js). AudioContext itself is created lazily on
   first gesture — boot only needs Sim + document. */
var _tries = 0;
(function boot(){
  _tries++;
  var ok = (typeof window !== 'undefined' && window.Sim &&
            typeof document !== 'undefined');
  if (ok){
    try{ init(); }
    catch(e){ try{ if (typeof console !== 'undefined') console.warn('[engine_sounds] init failed', e); }catch(e2){} }
    return;
  }
  if (_tries < 900) setTimeout(boot, 500);
})();

})();
