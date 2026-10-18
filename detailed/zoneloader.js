/* ============================================================================
   FILE: zoneloader.js — "Surviving Adamsville" ZONE-SEPARATED MAP LOADER
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-10): "Break the map up by the zones so it's
   not one continuous map. In order to leave one zone and go to the next
   zone you have to actually load another map."

   WHAT THIS DOES:
   - Each of the 7 zones has its own map data files in zones/<zone_id>/:
       roads.json      (ROAD_DATA)
       buildings.json  (OSM_BUILDINGS, OSM_BLDG_VERSION, OSM_REAL_COUNT)
       pins.json       (JUNCTION_PINS)
       lifts.json      (TERRAIN_LIFTS)
       signs.json      (EXIT_SIGNS)
       zone.json       (metadata: bounds, scale, counts)
   - v1.54 (2026-10-12): .json format (was .js). iOS Safari froze at 18%
     parsing the 1.6M-char single lines — JSON.parse has no such pathology.
     The old .js files are kept as fallback only.
   - On page load, reads ?zone=<id> from URL (defaults to 'adamsville').
   - Dynamically injects <script> tags for that zone's data files using
     document.write() during HTML parsing (synchronous, in-order).
   - Zone files define the SAME globals as the original monolithic files,
     so all existing game code works unchanged (index.html assigns them from
     the fetched JSON).
   - When the player crosses a zone boundary, triggers a full page reload
     with ?zone=<new_id> — "to leave one zone you load another map."

   ADAMSVILLE SCALE FIX:
   - Adamsville data is rescaled to TRUE 1:1 (factor 2.833) in its zone files.
   - New Adamsville bounds: x[-832, 8377], z[-4249, 8267].
   - (Superseded 2026-10-16/17: the FULL-MAP CONVERSION moved every
     zone into the converted frame; all seven zone rects now tile the
     stage rect — see the ZONE_BOUNDS note further down.)

   INTEGRATION:
   - zoneunlock.js provides zone definitions and ZONEUNLOCK.zoneAt().
   - This module exposes window.ZONELOADER with:
       currentZone  — the active zone id
       zoneBounds   — bounds for the active zone (from zone.json or fallback)
       onZoneCross  — called when player crosses into a new zone
       transitionTo — initiates zone transition (page reload)

   STANDALONE MODULE. Loaded via <script> in index.html BEFORE data files.
   ============================================================================ */
(function(){
'use strict';

/* ---------------- zone detection from URL ---------------- */
function getZoneFromURL(){
  try {
    var params = new URLSearchParams(window.location.search);
    var z = params.get('zone');
    // Validate against known zones
    var valid = ['mableton','adamsville','downtown','eastatlanta',
                 'unioncity','southfulton','riverdale'];
    if (z && valid.indexOf(z) !== -1) return z;
  } catch(e){}
  return 'adamsville';  // default: home base
}

var CURRENT_ZONE = getZoneFromURL();

/* ---------------- zone bounds (for transition detection) ----------------
   These are the CONVERTED zone.json bounds — the same numbers
   zoneunlock.js's ZONES table carries (STEP 2: the seven converted
   zones tile the stage rect x[-7481,16315] x z[-4249,30878] with no
   gaps and no overlaps). zoneunlock.js is the SINGLE SOURCE OF TRUTH
   for zone geometry: at call time the crossing functions below prefer
   its live table (liveZoneRects), and this literal copy is only the
   fallback for contexts where zoneunlock.js is absent (headless
   harnesses, partial loads).

   HISTORY (the bug this replaces, found 2026-10-17): this table used
   to hold the PRE-conversion "original frame" bounds for every zone
   except Adamsville. findZoneForPoint() therefore tested the player
   against a map that no longer exists: a crossing into South Fulton
   (converted x[-832,8377] x z[8267,30878]) matched the old Union City
   or Riverdale rects across most of the zone, and matched NOTHING
   south of z=12200 — so the transition into the unlocked zone's built
   environment never fired (or fired for the wrong zone), and the
   player drove into naked space. The two tables disagreed exactly as
   this file's own STAGE2 note below warned. */
var ZONE_BOUNDS = {
  'mableton':    {xMin:-7480.585387323972, xMax:-832.1294014084006,  zMin:-4248.536971831284, zMax:8266.53697183079},
  'adamsville':  {xMin:-832.1294014084006,  xMax:8377.129401408598,  zMin:-4248.536971831284, zMax:8266.53697183079},
  'downtown':    {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:-4248.536971831284, zMax:2555.720070422735},
  'eastatlanta': {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:2555.720070422735,  zMax:8266.53697183079},
  'unioncity':   {xMin:-7480.585387323972, xMax:-832.1294014084006, zMin:8266.53697183079,   zMax:30877.519366197153},
  'southfulton': {xMin:-832.1294014084006,  xMax:8377.129401408598,  zMin:8266.53697183079,   zMax:30877.519366197153},
  'riverdale':   {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:8266.53697183079,   zMax:30877.519366197153}
};

/* liveZoneRects() — the bounds callers should trust RIGHT NOW:
   zoneunlock.js's ZONES table when that module is loaded (it always
   is by the time any crossing check runs — trackPlayer is a per-frame
   call), else this module's literal converted table. Returns a fresh
   {id -> rect} map each call; seven zones, so this is cheap. */
function liveZoneRects(){
  try{
    var zs=(typeof window!=='undefined' && window.ZoneUnlock && window.ZoneUnlock.zones)
      || (typeof ZONEUNLOCK!=='undefined' && ZONEUNLOCK && ZONEUNLOCK.zones) || null;
    if (zs && zs.length){
      var out={};
      for (var i=0;i<zs.length;i++){
        var z=zs[i];
        if (z && z.id && isFinite(z.xMin) && isFinite(z.xMax) && isFinite(z.zMin) && isFinite(z.zMax))
          out[z.id]={xMin:z.xMin, xMax:z.xMax, zMin:z.zMin, zMax:z.zMax};
      }
      if (Object.keys(out).length) return out;
    }
  }catch(e){}
  return ZONE_BOUNDS;
}

/* ---------------- STAGE2: zone.json metadata (conversion cutover) ----------
   CONVERSION-DESIGN SS2.9 / SS5 step 2e: converted zones ship a truthful
   zone.json (id, geographic definition, derived zone-frame bounds,
   counts). The deferred loader fetches it (see the 'zone' entry in
   injectZoneScripts below) and hands it to registerZoneMeta(), which
   adopts its bounds for the CURRENT zone over the literal table above.
   The literals remain the fail-open fallback -- a missing or malformed
   zone.json changes nothing.
   NOTE (updated 2026-10-17): zoneunlock.js's ZONES table is the
   single source of truth for zone geometry. This loader's literals
   now carry the same converted bounds, and the crossing functions
   prefer zoneunlock.js's live table at call time (liveZoneRects) —
   the open item this note used to flag is resolved. */
var _zoneMetaById = {};   // zoneId -> parsed zone.json, as delivered
function _validBounds(b){
  return !!b && isFinite(b.xMin) && isFinite(b.xMax) && isFinite(b.zMin) && isFinite(b.zMax)
    && b.xMax > b.xMin && b.zMax > b.zMin;
}
function registerZoneMeta(meta){
  try{
    if (!meta || typeof meta !== 'object') return false;
    var id = (typeof meta.id === 'string' && meta.id) ? meta.id : CURRENT_ZONE;
    _zoneMetaById[id] = meta;
    if (id === CURRENT_ZONE && _validBounds(meta.bounds)){
      /* Adopt the zone.json bounds verbatim (no rounding -- the file's
         numbers are the truth, design SS2.9). checkZoneCrossing() and
         findZoneForPoint() read ZONE_BOUNDS, so they pick this up. */
      ZONE_BOUNDS[id] = {xMin:meta.bounds.xMin, xMax:meta.bounds.xMax,
                         zMin:meta.bounds.zMin, zMax:meta.bounds.zMax};
      try{
        window.ZONELOADER.bounds = ZONE_BOUNDS[id];
        window.ZONELOADER.zoneMeta = meta;
        if (meta.counts) window.ZONELOADER.counts = meta.counts;
      }catch(e){}
      return true;
    }
    return false;  /* stored for getBounds(), but bounds unusable -> literals stay */
  }catch(e){ return false; }
}
function getEffectiveBounds(zoneId){
  /* Bounds a caller should trust for a zone: the zone.json bounds when
     that zone's metadata has been registered, else the literal table. */
  var id = zoneId || CURRENT_ZONE;
  var m = _zoneMetaById[id];
  if (m && _validBounds(m.bounds))
    return {xMin:m.bounds.xMin, xMax:m.bounds.xMax, zMin:m.bounds.zMin, zMax:m.bounds.zMax};
  return ZONE_BOUNDS[id] || null;
}

/* ---------------- dynamic script injection ----------------
   Called during HTML parsing via document.write to load zone data
   synchronously before the world-building code runs. */
/* v1.29 DEFERRED (Joshua 2026-10-11): zone scripts no longer inject via
   document.write during parsing. Instead, expose the file list; the deferred
   loader in index.html injects them dynamically after launch confirmation. */
function injectZoneScripts(zoneId){
  var base = 'zones/' + zoneId + '/';
  /* v1.54 JSON ZONE DATA (2026-10-12): iOS Safari's JavaScriptCore engine is
     pathologically slow parsing extremely long single lines (1.6M chars in
     adamsville/roads.js), freezing Apple mobile web at 18% load. Zone data
     now ships as pure JSON — JSON.parse is native C++ with no line-length
     pathology. index.html fetches each .json and assigns the globals below.
     The old .js files remain as fallback (loaded if JSON fails). */
  var files = [
    /* STAGE2 (design SS2.9): zone metadata FIRST, so its bounds are
       registered before any consumer can ask for them. Handled
       specially by the deferred loader's assignZoneGlobals (key
       'zone'); global is null because it maps to no single global. */
    {src: base + 'zone.json',      key: 'zone',      global: null},
    {src: base + 'roads.json',     key: 'roads',     global: 'ROAD_DATA'},
    {src: base + 'signs.json',     key: 'signs',     global: 'EXIT_SIGNS'},
    {src: base + 'lifts.json',     key: 'lifts',     global: 'TERRAIN_LIFTS'},
    {src: base + 'pins.json',      key: 'pins',      global: 'JUNCTION_PINS'},
    {src: base + 'buildings.json', key: 'buildings', global: null},  // special: 3 vars, see assignZoneGlobals
    /* v1.66 HERO BUILDINGS (2026-10-12 Joshua: "535 wasn't in the editor"):
       Hero/special buildings (535 Dollar Mill) baked into data per Joshua's
       standing rule — buildings in the editor are baked into game data, no
       runtime spawning. The building editor lists these. */
    {src: base + 'hero_buildings.json', key: 'hero_buildings', global: 'HERO_BUILDINGS'},
  ];
  // Expose for the deferred loader (index.html). Do NOT document.write —
  // this script now runs after HTML parsing via deferred injection.
  window.__zoneScriptFiles = files;
  return files;
}

/* ---------------- zone transition ----------------
   Called when the player crosses into a different zone.
   Shows a transition UI, then reloads the page with the new zone.
   POSITION STASH (2026-10-17): before the reload, the player's exact
   spot is stashed through ui_update_flow.js's resume machinery
   (tagged with the TARGET zone, which is the zone the reloaded page
   will boot into) — so the new page's boot restore puts him right
   where he crossed, inside the new zone's fully built environment,
   instead of at the 535 spawn (whose coordinates belong to
   Adamsville and would strand him in unbuilt space on this page,
   followed by the crossing check bouncing him straight back).
   Best-effort and guarded: no UIUpdateFlow -> the reload proceeds
   exactly as it always did. */
var _transitioning = false;
function transitionTo(zoneId){
  if (_transitioning) return;
  _transitioning = true;

  try{
    if (typeof window!=='undefined' && window.UIUpdateFlow &&
        typeof UIUpdateFlow.writeStash==='function'){
      var zn=(typeof window.ZoneUnlock!=='undefined' && ZoneUnlock.zoneById)
        ? ZoneUnlock.zoneById(zoneId) : null;
      UIUpdateFlow.writeStash({
        zone: zoneId,
        toast: '🗺️ ' + ((zn && zn.name) || zoneId) + ' — its world is loaded around you.'
      });
    }
  }catch(e){}

  // Show transition overlay
  try {
    var overlay = document.createElement('div');
    overlay.id = 'zone-transition-overlay';
    overlay.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;' +
      'background:rgba(10,10,20,0.95);z-index:99999;' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'color:#fff;font-family:Arial,sans-serif;';
    var zoneName = zoneId.charAt(0).toUpperCase() + zoneId.slice(1);
    overlay.innerHTML =
      '<div style="font-size:28px;margin-bottom:16px;">🗺️ Entering ' + zoneName + '</div>' +
      '<div style="font-size:16px;color:#888;">Loading zone map...</div>';
    document.body.appendChild(overlay);
  } catch(e){}

  // Brief delay so the overlay paints, then reload with new zone
  setTimeout(function(){
    var url = new URL(window.location.href);
    url.searchParams.set('zone', zoneId);
    window.location.href = url.toString();
  }, 800);
}

/* ---------------- boundary crossing detection ----------------
   Called from the game loop (hooked into ZONEUNLOCK.trackPlayer or
   called directly). Checks if player has left the current zone bounds. */
function checkZoneCrossing(px, pz){
  if (_transitioning) return null;

  /* Bounds for the current zone: registered zone.json bounds first
     (getEffectiveBounds), then the live zone table — the single
     source of truth — wins over any literal, so this check can never
     again test the player against the retired pre-conversion frame. */
  var bounds = getEffectiveBounds(CURRENT_ZONE);
  var live = liveZoneRects();
  if (live && live[CURRENT_ZONE]) bounds = live[CURRENT_ZONE];
  if (!bounds) return null;

  // Check if player is outside current zone bounds
  // Use a small margin to avoid flicker at exact boundary
  var margin = 10;
  var outside =
    px < bounds.xMin - margin || px > bounds.xMax + margin ||
    pz < bounds.zMin - margin || pz > bounds.zMax + margin;

  if (!outside) return null;

  // Player has left the zone — determine which zone they entered,
  // using the converted bounds (the seven zones tile the stage with
  // no overlaps, so plain containment decides).
  var targetZone = findZoneForPoint(px, pz);
  if (targetZone && targetZone !== CURRENT_ZONE){
    return targetZone;
  }

  return null;
}

/* ---------------- find zone for a point ----------------
   CONVERTED FRAME (2026-10-17): since the full-map conversion every
   zone lives in the same frame and the seven zone rects tile the
   stage exactly — there is no scale discontinuity left to handle.
   findZoneForPoint is a plain containment loop over the live zone
   table (zoneunlock.js's ZONES via liveZoneRects, else the converted
   literals). ORIGINAL_BOUNDS is retained ONLY because the public API
   exports it; it now carries the same converted rects — the
   pre-conversion "original frame" values it used to hold were the
   direct cause of crossings resolving to the wrong zone (or to no
   zone at all south of z=12200). */
var ORIGINAL_BOUNDS = {
  'mableton':    {xMin:-7480.585387323972, xMax:-832.1294014084006,  zMin:-4248.536971831284, zMax:8266.53697183079},
  'adamsville':  {xMin:-832.1294014084006,  xMax:8377.129401408598,  zMin:-4248.536971831284, zMax:8266.53697183079},
  'downtown':    {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:-4248.536971831284, zMax:2555.720070422735},
  'eastatlanta': {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:2555.720070422735,  zMax:8266.53697183079},
  'unioncity':   {xMin:-7480.585387323972, xMax:-832.1294014084006, zMin:8266.53697183079,   zMax:30877.519366197153},
  'southfulton': {xMin:-832.1294014084006,  xMax:8377.129401408598,  zMin:8266.53697183079,   zMax:30877.519366197153},
  'riverdale':   {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:8266.53697183079,   zMax:30877.519366197153}
};

function findZoneForPoint(px, pz){
  var rects = liveZoneRects();
  for (var zid in rects){
    var b = rects[zid];
    if (px >= b.xMin && px <= b.xMax && pz >= b.zMin && pz <= b.zMax){
      return zid;
    }
  }
  return null;
}

/* ---------------- public API ---------------- */
window.ZONELOADER = {
  currentZone: CURRENT_ZONE,
  bounds: ZONE_BOUNDS[CURRENT_ZONE],
  originalBounds: ORIGINAL_BOUNDS[CURRENT_ZONE],
  injectZoneScripts: injectZoneScripts,
  transitionTo: transitionTo,
  checkZoneCrossing: checkZoneCrossing,
  findZoneForPoint: findZoneForPoint,
  ZONE_BOUNDS: ZONE_BOUNDS,
  /* STAGE2 (design SS2.9): zone.json consumption -- registerZoneMeta is
     called by index.html's deferred loader when zone.json arrives;
     getBounds returns metadata bounds when available, else literals.
     zoneMeta/counts are filled in by registerZoneMeta for the current
     zone (null until then). */
  registerZoneMeta: registerZoneMeta,
  getBounds: getEffectiveBounds,
  zoneMeta: null,
  counts: null,
};

/* ---------------- expose zone files on load ----------------
   v1.29 DEFERRED: do not document.write. The deferred loader in index.html
   picks up window.__zoneScriptFiles and injects them after confirmation. */
injectZoneScripts(CURRENT_ZONE);

})();
