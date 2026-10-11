/* ============================================================================
   SIM CORE v1.0 — Simulation/Render Separation (expert report #15, James Park)
   Joshua approved 2026-10-11.

   PURPOSE:
   Separates game SIMULATION state (plain data) from RENDERING (Three.js).
   Before this module, sim and render were fused: game logic read wall-clock
   time directly, input was read live from event handlers mid-frame, and
   entity state lived inside mesh objects. This module provides:

     1. window.Sim        — plain-data entity store (no THREE, no DOM).
                          Entities are JSON-safe records: {id, type, x,y,z...}.
                          Render code READS from Sim; sim code WRITES to Sim.
     2. window.WorldClock — tick-driven game clock. Advances by SIM_STEP per
                          simTick(), NOT by wall-clock. Day/night, seasons,
                          and weather now pause when the sim pauses and run
                          identically on 30fps and 60fps devices.
     3. window.Input      — per-tick input sampling. Captures keys[] and
                          drive{} into frozen plain-data snapshots once per
                          simTick(). Game logic reads the snapshot, never
                          the live event-driven objects.

   HEADLESS OPERATION:
   Set Sim.headless=true and the sim core (WorldClock + Input + entity store)
   runs with zero THREE/DOM dependencies — suitable for automated testing
   and future server-side simulation. Sim.serialize() returns a JSON-safe
   snapshot of all entity state.

   DEPENDENCIES: none. Must load before simTick() first runs (deferred
   script order guarantees this — all deferred scripts load before
   __tryStartGame). All consumers use typeof-guards so a failed load can
   never break the game.
   ============================================================================ */
(function simCore(){
'use strict';

/* ---------------------------------------------------------------------------
   Sim — plain-data entity store.
   ---------------------------------------------------------------------------
   An "entity" here is a JSON-safe record: {id, type, ...plain fields}.
   NEVER store THREE objects, DOM nodes, or functions in an entity — that
   re-fuses sim and render. Meshes live in the render layer and read entity
   records each frame (or on change) to position themselves.

   Migration pattern for existing systems (player, car, NPCs):
     // SIM side (in simTick or system update):
     Sim.update('player', {x: player.x, z: player.z, health: player.health});
     // RENDER side (in render pass):
     var p = Sim.get('player');
     if (p) player.mesh.position.set(p.x, p.y, p.z);
   ------------------------------------------------------------------------- */
window.Sim = {
  /* id -> plain-data record. */
  entities: {},

  /* Number of simTick() calls since boot. Monotonic; never resets. */
  tickCount: 0,

  /* When true, render-layer code should skip all THREE work. The sim core
     itself never touches THREE regardless of this flag. */
  headless: false,

  /* Register a plain-data entity. `data` must be JSON-safe. Returns the record. */
  register: function(id, type, data){
    var rec = {id: id, type: type};
    if (data && typeof data === 'object'){
      for (var k in data){
        if (Object.prototype.hasOwnProperty.call(data, k)) rec[k] = data[k];
      }
    }
    this.entities[id] = rec;
    return rec;
  },

  /* Get an entity record by id, or null. */
  get: function(id){
    return Object.prototype.hasOwnProperty.call(this.entities, id)
      ? this.entities[id] : null;
  },

  /* Patch fields on an existing entity. Returns the record, or null. */
  update: function(id, patch){
    var e = this.get(id);
    if (!e || !patch) return e;
    for (var k in patch){
      if (Object.prototype.hasOwnProperty.call(patch, k)) e[k] = patch[k];
    }
    return e;
  },

  /* Remove an entity. */
  remove: function(id){
    delete this.entities[id];
  },

  /* JSON-safe snapshot of all entity state. Used by headless tests and
     future server sync. Throws nothing — returns '{}' on failure. */
  serialize: function(){
    try { return JSON.stringify(this.entities); }
    catch(e){ return '{}'; }
  },

  /* Restore entity state from a serialize() snapshot. */
  deserialize: function(json){
    try {
      var o = JSON.parse(json);
      if (o && typeof o === 'object') this.entities = o;
    } catch(e){}
  },

  /* Render-layer subscription: fn(entityId, record) called when Sim.update
     touches an entity. Lets render systems react without polling. */
  _subs: [],
  onUpdate: function(fn){
    if (typeof fn === 'function') this._subs.push(fn);
  },
  _notify: function(id){
    for (var i=0;i<this._subs.length;i++){
      try { this._subs[i](id, this.entities[id]); } catch(e){}
    }
  }
};

/* Wrap Sim.update so subscribers are notified. (Kept as a wrapper rather
   than inline code so the core update path stays trivially readable.) */
(function(){
  var _origUpdate = window.Sim.update;
  window.Sim.update = function(id, patch){
    var r = _origUpdate.call(window.Sim, id, patch);
    if (r) window.Sim._notify(id);
    return r;
  };
})();

/* ---------------------------------------------------------------------------
   WorldClock — tick-driven game clock (expert report #15).
   ---------------------------------------------------------------------------
   BEFORE: daycycle.js advanced game time from performance.now() wall-clock,
   so the day/night cycle ran per real second on every client independently.
   AFTER: WorldClock.tick(dt) is called once per simTick() with the fixed
   SIM_STEP (1/30s). Game time advances per SIMULATION tick, not per wall
   second — pausing the sim pauses time, and 30fps/60fps devices agree.

   Joshua's time spec (unchanged): 24 game hours = 124 real minutes at full
   speed; game opens Monday 07:08; 7-day seasons starting in summer.
   ------------------------------------------------------------------------- */
(function(){
  var DAY_LEN_S = 124*60;              // real seconds per 24 game hours
  var GAME_MIN_PER_SEC = 1440/DAY_LEN_S;
  var START_MIN = 7*60+8, START_DAY = 1;
  var LS_KEY = 'sa_daycycle_v1';       // same key daycycle.js uses

  /* Read persisted clock (written by daycycle.js) so time survives reloads.
     WorldClock does NOT write persistence itself — daycycle.js remains the
     single writer, avoiding two modules fighting over one localStorage key. */
  function readPersist(){
    try{
      var raw = (typeof localStorage!=='undefined')
        ? localStorage.getItem(LS_KEY) : null;
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (typeof o.gameMin==='number' && typeof o.dayNum==='number') return o;
    }catch(e){}
    return null;
  }

  var saved = readPersist();

  window.WorldClock = {
    gameMin: saved ? saved.gameMin : START_MIN,
    dayNum:  saved ? saved.dayNum  : START_DAY,
    /* Total simulated seconds since boot (excludes time before this page
       load — dayNum/gameMin carry the persisted wall of time instead). */
    simTime: 0,
    tickCount: 0,
    GAME_MIN_PER_SEC: GAME_MIN_PER_SEC,

    /* Advance the clock by one fixed sim step. Called from simTick(dt). */
    tick: function(dt){
      if (typeof dt !== 'number' || dt <= 0) return;
      this.simTime += dt;
      this.tickCount++;
      this.gameMin += dt * GAME_MIN_PER_SEC;
      if (this.gameMin >= 1440){
        this.gameMin -= 1440;
        this.dayNum++;
      }
    },

    /* Direct set (used by daycycle.js init to apply its own loaded save,
       and by __daycycle.setTime). */
    setTime: function(min, day){
      if (typeof min === 'number') this.gameMin = min;
      if (typeof day === 'number') this.dayNum = day;
    },

    /* How much sim time elapsed since the last readDelta() call. Lets
       render-layer systems (daycycle.js sky rendering) consume tick time
       at their own cadence without tracking wall-clock themselves. */
    _lastReadSimTime: 0,
    readDelta: function(){
      var d = this.simTime - this._lastReadSimTime;
      if (d < 0) d = 0;
      this._lastReadSimTime = this.simTime;
      return d;
    },

    /* Plain-data snapshot for Sim.serialize()/headless use. */
    toData: function(){
      return {gameMin: this.gameMin, dayNum: this.dayNum,
              simTime: this.simTime, tickCount: this.tickCount};
    }
  };

  /* Register the clock as a Sim entity so headless snapshots include time. */
  window.Sim.register('worldclock', 'system', window.WorldClock.toData());
})();

/* ---------------------------------------------------------------------------
   Input — per-tick input sampling (expert report #15).
   ---------------------------------------------------------------------------
   BEFORE: keydown/keyup handlers wrote directly to the global `keys` and
   `drive` objects, and game logic read those live objects mid-frame. Input
   state could change between two reads inside one frame.
   AFTER: Input.sample() runs ONCE at the top of simTick() and copies the
   live objects into plain-data snapshots (Input.keys, Input.drive). All
   game logic reads the snapshot — input is now deterministic per tick,
   and headless tests can inject synthetic input via Input.inject().

   The live `keys`/`drive` objects are still written by event handlers and
   touch controls exactly as before; only the READ side moves to snapshots.
   ------------------------------------------------------------------------- */
window.Input = {
  /* Plain-data snapshots, refreshed by sample(). */
  keys: {},
  drive: {gas:false, brake:false, hb:false, left:false, right:false},
  /* True once sample() has run at least once. Consumers fall back to the
     live objects when false (e.g. sim_core.js failed to load). */
  sampled: false,
  /* Monotonic sample counter — equals Sim.tickCount when healthy. */
  sampleCount: 0,

  /* Copy live input state into plain-data snapshots. Called once per
     simTick(), before any game logic reads input. */
  sample: function(){
    var i, k;
    /* Keyboard state. `keys` is a global var in index.html; reach it
       defensively so a load-order surprise can never throw. */
    var liveKeys = null;
    try { liveKeys = (typeof window.keys !== 'undefined') ? window.keys : null; }
    catch(e){ liveKeys = null; }
    var ks = {};
    if (liveKeys){
      for (k in liveKeys){
        if (Object.prototype.hasOwnProperty.call(liveKeys, k)) ks[k] = !!liveKeys[k];
      }
    }
    this.keys = ks;

    /* Drive state (van pedals / WASD). Same defensive reach. */
    var liveDrive = null;
    try { liveDrive = (typeof window.drive !== 'undefined') ? window.drive : null; }
    catch(e){ liveDrive = null; }
    var dr = {gas:false, brake:false, hb:false, left:false, right:false};
    if (liveDrive){
      for (i=0;i<5;i++){
        k = ['gas','brake','hb','left','right'][i];
        dr[k] = !!liveDrive[k];
      }
    }
    this.drive = dr;

    this.sampled = true;
    this.sampleCount++;
  },

  /* Read a key from the snapshot (false if never sampled). */
  getKey: function(k){
    return !!(this.sampled && this.keys[k]);
  },

  /* Headless/synthetic input injection for automated tests. Merges into
     the CURRENT snapshot; the next sample() overwrites with live state. */
  inject: function(keysPatch, drivePatch){
    var k;
    if (keysPatch){
      for (k in keysPatch){
        if (Object.prototype.hasOwnProperty.call(keysPatch, k))
          this.keys[k] = !!keysPatch[k];
      }
    }
    if (drivePatch){
      for (k in drivePatch){
        if (Object.prototype.hasOwnProperty.call(drivePatch, k) &&
            Object.prototype.hasOwnProperty.call(this.drive, k))
          this.drive[k] = !!drivePatch[k];
      }
    }
    this.sampled = true;
  },

  /* Plain-data snapshot for Sim.serialize()/headless use. */
  toData: function(){
    return {keys: this.keys, drive: this.drive, sampleCount: this.sampleCount};
  }
};

/* Register input state as a Sim entity for headless snapshots. */
window.Sim.register('input', 'system', window.Input.toData());

/* Self-report so Joshua can verify the module loaded (Report panel). */
try{
  if (typeof Report !== 'undefined' && Report.setSys){
    Report.setSys('simcore', {status:'ok', version:'1.0',
      note:'Sim/WorldClock/Input separation live (expert #15)'});
  }
}catch(e){}

})();
