/* ============================================================================
   SURVIVING ADAMSVILLE — Truck Restrictions (truck_restrictions.js)
   ============================================================================
   Joshua's rule (2026-10-11): 18-wheelers must avoid low-clearance
   overpasses. The map editor exports overpass data with
   `truck_restricted: true` for any overpass below 16ft clearance.
   This module loads that data and answers one question for the semi
   system: "is there a truck-restricted overpass at / ahead of (x, z)?"

   DATA FORMAT (overpasses.json, in the game's detailed/ folder):
     {
       "overpasses": [
         {
           "id": "ovp_1",
           "name": "Main St",
           "x": 1234, "z": 5678,          // overpass center (world units)
           "clearance_ft": 12.5,            // deck clearance in feet
           "truck_restricted": true,        // true when clearance_ft < 16
           "radius": 120                    // restricted zone radius (world units)
         }
       ]
     }

   DESIGN (Joshua's "keep it simple" rule):
   - No pathfinding. Semis run a fixed route; if a restricted overpass is
     ahead, the semi brakes to a hold and waits (like it does for blocked
     lanes). Waiting is NOT stuck — the watchdog is paused.
   - Cars, vans, and all other vehicles ignore restrictions entirely.
   - Fully defensive: if overpasses.json is missing or corrupt, there are
     zero restrictions and the game behaves exactly as before.

   Exposes: window.TruckRestrictions = {
     ready: bool,                    // true once data load attempted
     all: function(),                 // array of restriction objects
     isRestricted: function(x, z),   // is (x,z) inside a restricted zone?
     aheadBlocked: function(x, z, hx, hz, maxDist)
                                     // scan ahead along heading (hx,hz);
                                     // returns {dist, ovp} or null
   }
   ============================================================================ */
(function(){
'use strict';
if (window.TruckRestrictions) return;  // already loaded

/* ---------------------------------------------------------------------------
   State: list of {id, name, x, z, clearance_ft, radius}.
   Only overpasses with truck_restricted=true are kept.
   --------------------------------------------------------------------------- */
var _restrictions = [];
var _ready = false;

/* ---------------------------------------------------------------------------
   loadOverpasses() — fetch overpasses.json (cache-busted). On any failure
   (missing file, bad JSON, network error) we keep an empty list: no
   restrictions, game unchanged. Never throws.
   --------------------------------------------------------------------------- */
function loadOverpasses(){
  // Try the ui-manifest version for cache busting, fall back to Date.now().
  var v = '';
  try {
    if (window.UI_MANIFEST && window.UI_MANIFEST.ui_version) v = '?v=' + window.UI_MANIFEST.ui_version;
    else v = '?v=' + Date.now();
  } catch(e){ v = '?v=' + Date.now(); }
  var url = 'overpasses.json' + v;
  // Use fetch if available, else XMLHttpRequest. Either way, async + quiet.
  function done(list){
    _restrictions = list || [];
    _ready = true;
  }
  function parse(json){
    var list = [];
    try {
      var doc = (typeof json === 'string') ? JSON.parse(json) : json;
      var arr = (doc && doc.overpasses) || [];
      for (var i = 0; i < arr.length; i++){
        var o = arr[i] || {};
        // Only truck-restricted overpasses matter to semis.
        if (!o.truck_restricted) continue;
        // Support both {x, z} and {position: [x, z]} formats
        // (map editor 1.6.0 exports position arrays).
        var x, z;
        if (o.position && o.position.length >= 2) {
          x = parseFloat(o.position[0]);
          z = parseFloat(o.position[1]);
        } else {
          x = parseFloat(o.x);
          z = parseFloat(o.z);
        }
        if (!isFinite(x) || !isFinite(z)) continue;
        list.push({
          id: String(o.id || ('ovp_' + i)),
          name: String(o.name || 'Overpass'),
          x: x, z: z,
          clearance_ft: parseFloat(o.clearance_ft) || 0,
          // Restricted zone: overpass footprint + approach. Default 120u.
          radius: (isFinite(parseFloat(o.radius)) && parseFloat(o.radius) > 0)
                  ? parseFloat(o.radius) : 120
        });
      }
    } catch(e){ /* corrupt JSON -> no restrictions */ }
    done(list);
  }
  try {
    if (typeof fetch === 'function'){
      fetch(url, {cache: 'no-store'}).then(function(r){
        if (!r.ok) throw new Error('http ' + r.status);
        return r.text();
      }).then(parse).catch(function(){ done([]); });
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onreadystatechange = function(){
        if (xhr.readyState === 4){
          if (xhr.status >= 200 && xhr.status < 300) parse(xhr.responseText);
          else done([]);
        }
      };
      xhr.send();
    }
  } catch(e){ done([]); }
}

/* ---------------------------------------------------------------------------
   isRestricted(x, z) — true if (x,z) is inside any restricted overpass zone.
   --------------------------------------------------------------------------- */
function isRestricted(x, z){
  for (var i = 0; i < _restrictions.length; i++){
    var r = _restrictions[i];
    var dx = x - r.x, dz = z - r.z;
    if (dx*dx + dz*dz <= r.radius * r.radius) return true;
  }
  return false;
}

/* ---------------------------------------------------------------------------
   aheadBlocked(x, z, hx, hz, maxDist) — scan ahead along the unit heading
   (hx, hz) for a restricted zone. Steps in 20u increments (cheap: a handful
   of distance checks per call). Returns {dist, ovp} for the nearest hit,
   or null when the path ahead is clear.
   --------------------------------------------------------------------------- */
function aheadBlocked(x, z, hx, hz, maxDist){
  maxDist = maxDist || 500;  // Joshua's spec: ~500 world units lookahead
  var step = 20;
  var best = null;
  for (var d = step; d <= maxDist; d += step){
    var px = x + hx * d, pz = z + hz * d;
    for (var i = 0; i < _restrictions.length; i++){
      var r = _restrictions[i];
      var dx = px - r.x, dz = pz - r.z;
      if (dx*dx + dz*dz <= r.radius * r.radius){
        // Approach distance = distance to the zone edge, not the center.
        var edgeDist = Math.max(0, d - r.radius);
        if (!best || edgeDist < best.dist) best = {dist: edgeDist, ovp: r};
        break;  // one hit per step is enough
      }
    }
    if (best && best.dist <= d - step) break;  // found the nearest; stop early
  }
  return best;
}

/* ---------------------------------------------------------------------------
   Public API
   --------------------------------------------------------------------------- */
window.TruckRestrictions = {
  get ready(){ return _ready; },
  all: function(){ return _restrictions.slice(); },
  isRestricted: isRestricted,
  aheadBlocked: aheadBlocked
};

// Kick off the async load immediately; semis boot-poll for deps anyway,
// and every call is safe before data arrives (empty list = no restrictions).
try { loadOverpasses(); } catch(e){ _ready = true; }

})();
