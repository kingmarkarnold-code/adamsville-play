/* ============================================================================
 * terrainfix.js — TERRAIN FIX AUTO-SAVE for "Surviving Adamsville"
 * ============================================================================
 * Joshua's directive (2026-10-09): "terrain fixes and road fixes [must]
 * auto save too." ("drain" was dictation for "terrain".)
 *
 * WHAT THIS DOES:
 *   Terrain corrections made by the terrain team, road crew, or admin tools
 *   are persisted to localStorage ('sa_terrainfixes_v1') and automatically
 *   re-applied on every game load — the same pattern as:
 *     - road fixes    → roadfix.js      ('sa_roadfixes_v1')
 *     - building fixes→ roadfix.js      ('sa_buildingfixes_v1')
 *                     + index.html v1.19 ('sa_bldg_fixes_v1')
 *
 * HOW IT WORKS:
 *   1. This script loads IMMEDIATELY after terrain_lifts.js (see the
 *      <script> tag order in index.html). At that point the global
 *      TERRAIN_LIFTS array exists but _liftGrid() has NOT been called yet
 *      (it builds lazily on the first heightAt() call, which happens inside
 *      the buildTerrain() IIFE further down the page).
 *   2. On load, _tfBoot() reads every saved fix from localStorage and
 *      appends it to TERRAIN_LIFTS as {x, z, lift, r}. The spatial hash
 *      then indexes them automatically — zero changes to heightAt().
 *   3. TerrainFix.record(x, z, lift, r, by, note) adds a NEW fix at
 *      runtime: it validates, appends to TERRAIN_LIFTS, invalidates the
 *      _LIFT_GRID cache so subsequent heightAt() calls use the corrected
 *      height immediately for gameplay logic (vehicle placement, NPC
 *      ground sampling, road sitting), and persists to localStorage.
 *
 * HONEST LIMIT (same as roadfix.js pin-y patches):
 *   The visible terrain MESH is baked once at load inside buildTerrain().
 *   A fix recorded mid-session corrects heightAt() immediately, but the
 *   already-built mesh vertices only reflect it after the next game load.
 *   This is documented, not hidden — the fix is never lost.
 *
 * FIX FORMAT (localStorage 'sa_terrainfixes_v1', JSON array):
 *   { x, z, lift, r, by, note, fixT }
 *     x, z  — world coordinates of the lift center
 *     lift  — height delta in world units (positive raises, negative carves)
 *     r     — gaussian sigma radius (same units as terrain_lifts.js, ~55)
 *     by    — who applied the fix ('terrain-team', 'road-crew', 'admin'...)
 *     note  — human-readable reason ('raise to meet road', '535 lot grade'...)
 *     fixT  — timestamp (ms since epoch)
 *
 * API (window.TerrainFix):
 *   record(x, z, lift, r, by, note) → fix object or null on validation fail
 *   list()                          → array of all saved fixes
 *   remove(x, z, radiusU)           → removes fixes within radiusU of (x,z)
 *   clear()                         → removes ALL terrain fixes
 *   count()                         → number of saved fixes
 *
 * SAFETY:
 *   - lift is clamped to [-20, +20]u (nothing legitimate needs more; the
 *     tallest bridge deck on this map is ~15u).
 *   - r is clamped to [10, 500]u.
 *   - NaN / non-finite inputs are rejected.
 *   - Duplicate suppression: a new fix within 25u of an existing fix with
 *     a lift within 0.5u REPLACES the old one instead of stacking.
 * ==========================================================================*/
(function(){
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */
  var LS_TERRAIN = 'sa_terrainfixes_v1'; // localStorage key — terrain registry
  var MAX_LIFT   = 20;   // max |lift| in world units (safety clamp)
  var MIN_R      = 10;   // min gaussian radius
  var MAX_R      = 500;  // max gaussian radius
  var DEDUP_R2   = 625;  // 25u^2 — same-spot dedup radius squared
  var DEDUP_LIFT = 0.5;  // lifts within 0.5u at the same spot replace, not stack

  /* ------------------------------------------------------------------ */
  /* Internal state                                                      */
  /* ------------------------------------------------------------------ */
  var _fixes = [];       // in-memory copy of the registry
  var _bootApplied = 0;  // how many fixes were injected at boot

  /* ------------------------------------------------------------------ */
  /* _tfLoad() — read the registry from localStorage.                   */
  /* ------------------------------------------------------------------ */
  function _tfLoad(){
    _fixes = [];
    try{
      var raw = window.localStorage.getItem(LS_TERRAIN);
      if(!raw) return;
      var arr = JSON.parse(raw);
      if(!Array.isArray(arr)) return;
      for(var i=0;i<arr.length;i++){
        var f = arr[i];
        if(f && isFinite(f.x) && isFinite(f.z) && isFinite(f.lift) && isFinite(f.r)){
          _fixes.push(f);
        }
      }
    }catch(e){ /* corrupted registry → start empty; never crash boot */ }
  }

  /* ------------------------------------------------------------------ */
  /* _tfSave() — write the registry to localStorage.                   */
  /* ------------------------------------------------------------------ */
  function _tfSave(){
    try{
      window.localStorage.setItem(LS_TERRAIN, JSON.stringify(_fixes));
    }catch(e){ /* storage full/blocked → fixes still apply this session */ }
  }

  /* ------------------------------------------------------------------ */
  /* _invalidateLiftGrid() — force heightAt() to re-index lifts.        */
  /*                                                                     */
  /* _LIFT_GRID is a top-level `var` in the inline game script, which   */
  /* makes it a window property in classic scripts. Setting it to null  */
  /* forces _liftGrid() to rebuild on the next heightAt() call, picking */
  /* up any TERRAIN_LIFTS entries appended since the last build.        */
  /* ------------------------------------------------------------------ */
  function _invalidateLiftGrid(){
    try{ window._LIFT_GRID = null; }catch(e){}
  }

  /* ------------------------------------------------------------------ */
  /* _toLiftEntry(f) — convert a fix to a TERRAIN_LIFTS entry.          */
  /*                                                                     */
  /* _liftGrid() skips entries where !L.lift, so zero-lift fixes are    */
  /* dropped here (they would be dead weight in the spatial hash).      */
  /* ------------------------------------------------------------------ */
  function _toLiftEntry(f){
    if(!f.lift) return null;
    return { x:f.x, z:f.z, lift:f.lift, r:f.r };
  }

  /* ------------------------------------------------------------------ */
  /* _tfBoot() — inject saved fixes into TERRAIN_LIFTS before the first */
  /* heightAt() call. Runs once at script load (this file is placed     */
  /* immediately after terrain_lifts.js in index.html).                 */
  /* ------------------------------------------------------------------ */
  function _tfBoot(){
    _tfLoad();
    if(!_fixes.length) return;
    try{
      if(typeof TERRAIN_LIFTS === 'undefined' || !TERRAIN_LIFTS.push) return;
      for(var i=0;i<_fixes.length;i++){
        var e = _toLiftEntry(_fixes[i]);
        if(e){ TERRAIN_LIFTS.push(e); _bootApplied++; }
      }
    }catch(e){}
  }

  /* ------------------------------------------------------------------ */
  /* _validate(x, z, lift, r) — sanitize inputs, return cleaned object  */
  /* or null.                                                           */
  /* ------------------------------------------------------------------ */
  function _validate(x, z, lift, r){
    x = Number(x); z = Number(z); lift = Number(lift); r = Number(r);
    if(!isFinite(x) || !isFinite(z) || !isFinite(lift) || !isFinite(r)) return null;
    if(lift >  MAX_LIFT) lift =  MAX_LIFT;
    if(lift < -MAX_LIFT) lift = -MAX_LIFT;
    if(lift === 0) return null; // no-op fix — nothing to persist
    if(r < MIN_R) r = MIN_R;
    if(r > MAX_R) r = MAX_R;
    return { x:x, z:z, lift:lift, r:r };
  }

  /* ------------------------------------------------------------------ */
  /* PUBLIC API                                                          */
  /* ------------------------------------------------------------------ */
  var TerrainFix = {

    /* record(x, z, lift, r, by, note) — add a terrain fix.
       Applies immediately to heightAt() (via grid invalidation) and
       persists to localStorage so it auto-applies on every future load.
       Returns the saved fix object, or null if validation failed. */
    record: function(x, z, lift, r, by, note){
      var v = _validate(x, z, lift, r);
      if(!v) return null;

      // Dedup: same spot + similar lift → replace instead of stacking.
      for(var i=0;i<_fixes.length;i++){
        var f = _fixes[i];
        var dx = f.x - v.x, dz = f.z - v.z;
        if((dx*dx + dz*dz) <= DEDUP_R2 && Math.abs(f.lift - v.lift) <= DEDUP_LIFT){
          f.lift = v.lift; f.r = v.r;
          f.by = by || f.by; f.note = note || f.note; f.fixT = Date.now();
          _tfSave();
          // Rebuild the live lift entry too.
          try{
            if(typeof TERRAIN_LIFTS !== 'undefined'){
              for(var j=TERRAIN_LIFTS.length-1;j>=0;j--){
                var L = TERRAIN_LIFTS[j];
                if(L && L._tf && Math.abs(L.x - f.x) < 1 && Math.abs(L.z - f.z) < 1){
                  TERRAIN_LIFTS.splice(j,1);
                }
              }
              var e = _toLiftEntry(f); if(e){ e._tf = 1; TERRAIN_LIFTS.push(e); }
            }
          }catch(e2){}
          _invalidateLiftGrid();
          return f;
        }
      }

      var fix = {
        x:v.x, z:v.z, lift:v.lift, r:v.r,
        by: by || 'terrain-team',
        note: note || '',
        fixT: Date.now()
      };
      _fixes.push(fix);
      _tfSave();

      // Apply live: append to TERRAIN_LIFTS and invalidate the grid cache
      // so heightAt() picks it up on its next call.
      try{
        if(typeof TERRAIN_LIFTS !== 'undefined' && TERRAIN_LIFTS.push){
          var le = _toLiftEntry(fix);
          if(le){ le._tf = 1; TERRAIN_LIFTS.push(le); }
        }
      }catch(e){}
      _invalidateLiftGrid();
      return fix;
    },

    /* list() — return a copy of all saved fixes. */
    list: function(){
      return _fixes.slice();
    },

    /* count() — number of saved fixes. */
    count: function(){
      return _fixes.length;
    },

    /* bootApplied() — how many fixes were injected at boot time. */
    bootApplied: function(){
      return _bootApplied;
    },

    /* remove(x, z, radiusU) — delete fixes within radiusU of (x,z).
       Returns the number removed. */
    remove: function(x, z, radiusU){
      var r2 = Math.pow(Number(radiusU) || 25, 2);
      var kept = [], removed = 0;
      for(var i=0;i<_fixes.length;i++){
        var f = _fixes[i];
        var dx = f.x - x, dz = f.z - z;
        if((dx*dx + dz*dz) <= r2){ removed++; continue; }
        kept.push(f);
      }
      if(removed){
        _fixes = kept;
        _tfSave();
        try{
          if(typeof TERRAIN_LIFTS !== 'undefined'){
            for(var j=TERRAIN_LIFTS.length-1;j>=0;j--){
              if(TERRAIN_LIFTS[j] && TERRAIN_LIFTS[j]._tf) TERRAIN_LIFTS.splice(j,1);
            }
            for(var k=0;k<_fixes.length;k++){
              var e = _toLiftEntry(_fixes[k]);
              if(e){ e._tf = 1; TERRAIN_LIFTS.push(e); }
            }
          }
        }catch(e){}
        _invalidateLiftGrid();
      }
      return removed;
    },

    /* clear() — delete ALL terrain fixes. Use with care. */
    clear: function(){
      var n = _fixes.length;
      _fixes = [];
      _tfSave();
      try{
        if(typeof TERRAIN_LIFTS !== 'undefined'){
          for(var j=TERRAIN_LIFTS.length-1;j>=0;j--){
            if(TERRAIN_LIFTS[j] && TERRAIN_LIFTS[j]._tf) TERRAIN_LIFTS.splice(j,1);
          }
        }
      }catch(e){}
      _invalidateLiftGrid();
      return n;
    }
  };

  // Boot: inject saved fixes before the first heightAt() call.
  _tfBoot();

  // Publish the API.
  window.TerrainFix = TerrainFix;

  /* Diagnostic: report boot injection count to the console (and to the
     game's Report system if it exists yet — it doesn't at this load
     stage, so console only). */
  try{
    if(_bootApplied > 0 && window.console){
      console.log('[terrainfix] applied ' + _bootApplied + ' saved terrain fix(es) from ' + LS_TERRAIN);
    }
  }catch(e){}
})();
