/* ============================================================================
   FILE: zoneloader.js — "Surviving Adamsville" ZONE-SEPARATED MAP LOADER
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-10): "Break the map up by the zones so it's
   not one continuous map. In order to leave one zone and go to the next
   zone you have to actually load another map."

   WHAT THIS DOES:
   - Each of the 7 zones has its own map data files in zones/<zone_id>/:
       roads.js      (ROAD_DATA)
       buildings.js  (OSM_BUILDINGS, OSM_BLDG_VERSION, OSM_REAL_COUNT)
       pins.js       (JUNCTION_PINS)
       lifts.js      (TERRAIN_LIFTS)
       signs.js      (EXIT_SIGNS)
       zone.json     (metadata: bounds, scale, counts)
   - On page load, reads ?zone=<id> from URL (defaults to 'adamsville').
   - Dynamically injects <script> tags for that zone's data files using
     document.write() during HTML parsing (synchronous, in-order).
   - Zone files define the SAME globals as the original monolithic files,
     so all existing game code works unchanged.
   - When the player crosses a zone boundary, triggers a full page reload
     with ?zone=<new_id> — "to leave one zone you load another map."

   ADAMSVILLE SCALE FIX:
   - Adamsville data is rescaled to TRUE 1:1 (factor 2.833) in its zone files.
   - New Adamsville bounds: x[-832, 8377], z[-4249, 8267].
   - Other zones remain at original scale until Joshua directs their fix.

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
   These mirror zoneunlock.js. Adamsville bounds are the RESCALED values.
   Other zones use original bounds. */
var ZONE_BOUNDS = {
  'mableton':    {xMin:-200,  xMax:2147,  zMin:-200,  zMax:4218},
  'adamsville':  {xMin:-832,  xMax:8377,  zMin:-4249, zMax:8267},  // RESCALED 1:1
  'downtown':    {xMin:5398,  xMax:8200,  zMin:-200,  zMax:2202},
  'eastatlanta': {xMin:5398,  xMax:8200,  zMin:2202,  zMax:4218},
  'unioncity':   {xMin:-200,  xMax:2147,  zMin:4218,  zMax:12200},
  'southfulton': {xMin:2147,  xMax:5398,  zMin:4218,  zMax:12200},
  'riverdale':   {xMin:5398,  xMax:8200,  zMin:4218,  zMax:12200},
};

/* ---------------- dynamic script injection ----------------
   Called during HTML parsing via document.write to load zone data
   synchronously before the world-building code runs. */
function injectZoneScripts(zoneId){
  var base = 'zones/' + zoneId + '/';
  var files = [
    {src: base + 'roads.js',     key: 'roads'},
    {src: base + 'signs.js',     key: 'signs'},
    {src: base + 'lifts.js',     key: 'lifts'},
    {src: base + 'pins.js',      key: 'pins'},
    {src: base + 'buildings.js', key: 'buildings'},
  ];

  // Use document.write for synchronous in-order loading during parse.
  // Each script gets onload/onerror handlers for the progress bar.
  for (var i = 0; i < files.length; i++){
    var f = files[i];
    document.write(
      '<script src="' + f.src + '" ' +
      'onload="__loadStep(\'' + f.key + '\')" ' +
      'onerror="__loadStep(\'' + f.key + '\',true)"><\/script>'
    );
  }
}

/* ---------------- zone transition ----------------
   Called when the player crosses into a different zone.
   Shows a transition UI, then reloads the page with the new zone. */
var _transitioning = false;
function transitionTo(zoneId){
  if (_transitioning) return;
  _transitioning = true;

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

  var bounds = ZONE_BOUNDS[CURRENT_ZONE];
  if (!bounds) return null;

  // Check if player is outside current zone bounds
  // Use a small margin to avoid flicker at exact boundary
  var margin = 10;
  var outside =
    px < bounds.xMin - margin || px > bounds.xMax + margin ||
    pz < bounds.zMin - margin || pz > bounds.zMax + margin;

  if (!outside) return null;

  // Player has left the zone — determine which zone they entered.
  // Check all zone bounds (using original scale for non-Adamsville).
  // NOTE: With Adamsville rescaled, bounds overlap. We prioritize
  // the zone whose ORIGINAL bounds contain the point, then map
  // rescaled Adamsville coordinates back to original for lookup.
  var targetZone = findZoneForPoint(px, pz);
  if (targetZone && targetZone !== CURRENT_ZONE){
    return targetZone;
  }

  return null;
}

/* ---------------- find zone for a point ----------------
   Handles the scale discontinuity between rescaled Adamsville and
   other zones. For points in the rescaled Adamsville area, we check
   against rescaled bounds. For others, original bounds. */
var ORIGINAL_BOUNDS = {
  'mableton':    {xMin:-200,  xMax:2147,  zMin:-200,  zMax:4218},
  'adamsville':  {xMin:2147,  xMax:5398,  zMin:-200,  zMax:4218},  // ORIGINAL (pre-scale)
  'downtown':    {xMin:5398,  xMax:8200,  zMin:-200,  zMax:2202},
  'eastatlanta': {xMin:5398,  xMax:8200,  zMin:2202,  zMax:4218},
  'unioncity':   {xMin:-200,  xMax:2147,  zMin:4218,  zMax:12200},
  'southfulton': {xMin:2147,  xMax:5398,  zMin:4218,  zMax:12200},
  'riverdale':   {xMin:5398,  xMax:8200,  zMin:4218,  zMax:12200},
};

function findZoneForPoint(px, pz){
  // First check rescaled Adamsville bounds
  var ab = ZONE_BOUNDS['adamsville'];
  if (px >= ab.xMin && px <= ab.xMax && pz >= ab.zMin && pz <= ab.zMax){
    return 'adamsville';
  }
  // Then check other zones by original bounds
  for (var zid in ORIGINAL_BOUNDS){
    if (zid === 'adamsville') continue;
    var b = ORIGINAL_BOUNDS[zid];
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
};

/* ---------------- auto-inject on load ----------------
   This script is loaded BEFORE the data script tags in index.html.
   We inject the zone data scripts immediately via document.write. */
injectZoneScripts(CURRENT_ZONE);

})();
