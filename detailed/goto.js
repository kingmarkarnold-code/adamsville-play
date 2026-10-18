/* ============================================================================
   FILE: goto.js — "Surviving Adamsville" GO TO (search + jump to a place)
   ----------------------------------------------------------------------------
   JOSHUA'S DESIGN (2026-10-18, dictated): a "Go to" function in the web
   view and in the Settings menu. It works like a Google search, except the
   only thing it can search is the GAME'S OWN DATA: browse an exhaustive
   list, or type a name — a street, a church, a store — and the game sends
   the player straight there. His example: type "Elizabeth Baptist Church"
   and land at Elizabeth Baptist Church.

   HIS LANDING LAW (never inside a building, never stuck):
   - IN A VEHICLE: the player AND the vehicle go. The car lands ON the road
     nearest the target, aligned with that road, clear of all geometry.
   - ON FOOT: the player alone goes, landing OUTSIDE the target, on the
     street/shoulder in front of its frontage, with a safety BUFFER, facing
     the place. The ground seating is the game's own (heightAt /
     groundRefY / surfaceYAt), so he never lands under the terrain or
     floating above it.
   - A jump is computed FULLY before anything moves: position changes only
     once a verified landing exists. If no safe landing can be computed,
     the panel says so in plain words and the player stays exactly where
     he is — a failed jump never strands him.

   DATA SOURCES (the game's own data only — nothing invented, nothing
   baked into this file):
   - Streets: the CURRENT zone's ROAD_DATA global (the zone's roads.json,
     loaded by the deferred loader). v1 scope: street search covers the
     zone the player is standing in (other zones' road files are megabytes
     each and are not loaded; their PLACES are covered — see below).
   - Places: zones/<zone>/places.json for ALL SEVEN zones — the game's
     named places (churches, schools, stores, gas stations, parks...).
     These files are small (2–110 KB), so they are fetched lazily the
     first time the panel opens (local map store first, via
     MapDelivery.serveText — the loader's own discipline — then a plain
     fetch), and cached in memory for the session.
   - Hero buildings: the current zone's HERO_BUILDINGS global (535 Dollar
     Mill Rd and friends), searchable by their recorded name/address.
   - Building footprints: the current zone's placed buildings
     (window.__bldgKept — final position + facing yaw from the game's own
     placement pass), falling back to the raw OSM_BUILDINGS records. A
     place point is matched to the nearest footprint within 60 m; places
     with no footprint (a park, a cemetery) land at the shoulder of the
     nearest road by the place point.

   ZONE LOCKS (Step 2 law — a Go To must never become a lock bypass):
   - Target in the CURRENT zone: jump in place, no reload.
   - Target in another zone that is UNLOCKED: the landing is computed
     from that zone's own roads/buildings (fetched on demand, the same
     data its boot will load), the spot is written into the game's resume
     stash (ui_update_flow.js's documented shape — the same stash the
     zone-crossing reload uses), and the page reloads into that zone
     with the player restored at the landing. The car comes only if he
     was driving (his spec: on foot, the player alone goes — the car is
     NOT dragged across zones).
   - Target in a LOCKED zone: refused, plainly, in the panel — naming the
     zone and pointing at Settings -> Advanced Properties, where zones
     unlock. The stash is never written for a locked target, and the
     boot restore's own locked-zone fallback stays as a second net.

   FAILURE PHILOSOPHY (Joshua 2026-10-17): everything is wrapped in
   try/catch; failures file through the crash-report hook (SA_CRASH)
   and show a plain-language line in the panel — never silent, never a
   half-applied jump. Menus yield: choosing a result closes the search
   (and Settings, if it was open) and puts him THERE.

   STRUCTURE: PART 1 is a pure core (no DOM, no game globals) — search,
   matching and landing geometry — exported for the Node harness
   (module.exports, the mapdelivery.js pattern). PART 2 is the browser
   runtime: panel UI, data loading, and the two jump paths. All game
   globals are read through typeof guards, the house pattern, so a
   missing system degrades to a plain refusal instead of an exception.
   ============================================================================ */
(function(){
'use strict';

/* ==========================================================================
   PART 1 — PURE CORE
   ========================================================================== */

/* Landing constants (metres; 1 game unit = 1 metre). */
var GOTO_BUFFER_M   = 3.0;  /* his buffer: min clearance from the target footprint */
var GOTO_SHOULDER_M = 2.0;  /* on-foot landings step this far off the road centreline toward the place */
var GOTO_MATCH_R    = 60;   /* a place point matches a footprint within this radius */
var GOTO_CAR_CLEAR  = 1.5;  /* car landings keep this much clearance from any footprint */

/* ---- name matching -------------------------------------------------------
   Normalise for comparison: lowercase, punctuation becomes spaces, runs
   of whitespace collapse. "Dollar Mill Rd. SW" and "dollar mill road
   southwest" still differ in the suffix word — that's fine: the word
   rules below carry partial queries. */
function gotoNormName(s){
  return String(s === null || s === undefined ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Score a candidate name against a normalised query. 0 = no match.
   Higher is better: 5 exact, 4 name starts with query, 3 every query
   word starts some name word, 2 query is a substring, 1 every query
   word appears somewhere. An empty query scores 1 (browse mode). */
function gotoMatchScore(name, query){
  var q = query || '';
  if (!q) return 1;
  var n = gotoNormName(name);
  if (!n) return 0;
  if (n === q) return 5;
  if (n.indexOf(q) === 0) return 4;
  var nw = n.split(' '), qw = q.split(' '), i, j, ok;
  ok = true;
  for (i = 0; i < qw.length; i++){
    var found = false;
    for (j = 0; j < nw.length; j++){ if (nw[j].indexOf(qw[i]) === 0){ found = true; break; } }
    if (!found){ ok = false; break; }
  }
  if (ok) return 3;
  if (n.indexOf(q) !== -1) return 2;
  ok = true;
  for (i = 0; i < qw.length; i++){ if (n.indexOf(qw[i]) === -1){ ok = false; break; } }
  return ok ? 1 : 0;
}

/* ---- roads ---------------------------------------------------------------
   Flatten a zone's ROAD_DATA (the roads.json shape: {class: [{name,
   pts:[[x,z],...]}, ...]}, or a bare record array from the .js twin)
   into segments + a name index. Records without usable points are
   skipped, never guessed at. */
function gotoFlattenRoads(roadData){
  var recs = [];
  if (Array.isArray(roadData)) recs = roadData;
  else if (roadData && typeof roadData === 'object'){
    for (var k in roadData){
      if (Object.prototype.hasOwnProperty.call(roadData, k) && Array.isArray(roadData[k]))
        recs = recs.concat(roadData[k]);
    }
  }
  var segs = [], byName = {};
  for (var ri = 0; ri < recs.length; ri++){
    var r = recs[ri];
    if (!r) continue;
    var pts = r.pts || r.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    var nm = (typeof r.name === 'string' && r.name) ? r.name : 'Unnamed St';
    for (var i = 0; i < pts.length - 1; i++){
      var a = pts[i], b = pts[i + 1];
      if (!a || !b || !isFinite(a[0]) || !isFinite(a[1]) || !isFinite(b[0]) || !isFinite(b[1])) continue;
      var s = { x1: a[0], z1: a[1], x2: b[0], z2: b[1], name: nm };
      segs.push(s);
      (byName[nm] || (byName[nm] = [])).push(s);
    }
  }
  return { segs: segs, byName: byName, names: Object.keys(byName) };
}

/* Closest point on one segment to (x, z): {x, z, dist, dirx, dirz}
   where dir is the segment's own direction (unit, as stored). */
function gotoSegClosest(s, x, z){
  var vx = s.x2 - s.x1, vz = s.z2 - s.z1;
  var len2 = vx * vx + vz * vz;
  var t = len2 > 0 ? ((x - s.x1) * vx + (z - s.z1) * vz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  var px = s.x1 + vx * t, pz = s.z1 + vz * t;
  var len = Math.sqrt(len2);
  return { x: px, z: pz, dist: Math.hypot(x - px, z - pz),
           dirx: len > 0 ? vx / len : 1, dirz: len > 0 ? vz / len : 0 };
}

/* Nearest road point to (x, z) over a segment list. When nameFilter is
   given, only segments of that street count. Returns the closest point
   plus the street name and segment direction, or null. */
function gotoNearestRoadPoint(segs, x, z, nameFilter){
  var best = null;
  for (var i = 0; i < segs.length; i++){
    var s = segs[i];
    if (nameFilter && s.name !== nameFilter) continue;
    var c = gotoSegClosest(s, x, z);
    if (!best || c.dist < best.dist){
      best = { x: c.x, z: c.z, dist: c.dist, name: s.name, dirx: c.dirx, dirz: c.dirz };
    }
  }
  return best;
}

/* Search street names: scored, best first, name order inside a score. */
function gotoSearchRoads(flat, query, limit){
  var q = gotoNormName(query);
  var out = [];
  for (var i = 0; i < flat.names.length; i++){
    var sc = gotoMatchScore(flat.names[i], q);
    if (sc > 0) out.push({ name: flat.names[i], score: sc });
  }
  out.sort(function(a, b){
    if (b.score !== a.score) return b.score - a.score;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return out.slice(0, limit || 40);
}

/* ---- buildings ------------------------------------------------------------
   A building record is the game's own shape: [x, z, w, d, h, type]
   with an optional 7th element, the facing yaw the placement pass
   stored (kept records). The rendered body is a w-by-d box rotated by
   that yaw around its centre, front = local +z. Distance from a point
   to that footprint (0 when inside) uses the same convention as the
   renderer (quaternion about Y): local lx along w, local lz along d. */
function gotoFootprintDist(px, pz, b){
  var dx = px - b[0], dz = pz - b[1];
  var hw = (b[2] || 0) / 2, hd = (b[3] || 0) / 2;
  var yaw = (b.length > 6 && typeof b[6] === 'number') ? b[6] : 0;
  var lx, lz;
  if (yaw){
    var c = Math.cos(yaw), s = Math.sin(yaw);
    lx = dx * c - dz * s;
    lz = dx * s + dz * c;
  } else { lx = dx; lz = dz; }
  var ex = Math.max(Math.abs(lx) - hw, 0);
  var ez = Math.max(Math.abs(lz) - hd, 0);
  return Math.hypot(ex, ez);
}

/* Nearest building record (by centre) to a point, within maxR. */
function gotoNearestBuilding(buildings, x, z, maxR){
  var best = null, bestD = maxR;
  if (!buildings) return null;
  for (var i = 0; i < buildings.length; i++){
    var b = buildings[i];
    if (!b || b.length < 4 || !isFinite(b[0]) || !isFinite(b[1])) continue;
    var d = Math.hypot(b[0] - x, b[1] - z);
    if (d <= bestD){ bestD = d; best = b; }
  }
  return best ? { b: best, centreDist: bestD } : null;
}

/* Smallest footprint distance from a point to ANY building in the list
   (cheap centre reject first). Used to prove a landing is clear of the
   whole street's geometry, not just the target's. */
function gotoMinFootprintDist(buildings, x, z){
  var best = Infinity;
  if (!buildings) return best;
  for (var i = 0; i < buildings.length; i++){
    var b = buildings[i];
    if (!b || b.length < 4) continue;
    var cd = Math.hypot(b[0] - x, b[1] - z);
    if (cd - Math.hypot(b[2] || 0, b[3] || 0) / 2 >= best) continue; /* can't beat best */
    var d = gotoFootprintDist(x, z, b);
    if (d < best) best = d;
  }
  return best;
}

/* ---- landings --------------------------------------------------------------
   landingForBuilding: the heart of the feature. Given a building
   record and the zone's roads, compute:
     - the ON-FOOT landing: the shoulder of the building's fronting
       road (the road point nearest the building), stepped toward the
       building off the centreline, then pushed radially outward until
       it clears the footprint by the buffer. If that somehow cannot
       clear (huge footprints can swallow their own front road), fall
       back to the point directly in front of the front face at buffer
       distance. Facing yaw looks AT the building.
     - the VEHICLE landing: on that same fronting road, slid along the
       road until it clears the footprint by the car clearance (a road
       can pass through a mega-footprint in the data — the car still
       never lands inside it). Yaw aligned with the road.
   Returns null when no verified landing exists. opts.buffer overrides
   the foot buffer; opts.buildings is the full list for a final
   clear-of-everything proof + neighbour dodge. */
function gotoLandingForBuilding(b, flat, opts){
  opts = opts || {};
  var buffer = (typeof opts.buffer === 'number') ? opts.buffer : GOTO_BUFFER_M;
  var cx = b[0], cz = b[1];
  var P = gotoNearestRoadPoint(flat.segs, cx, cz);
  if (!P) return null;

  /* Front direction: from the building toward its fronting road. */
  var fx = P.x - cx, fz = P.z - cz, fl = Math.hypot(fx, fz);
  if (fl < 0.001){
    var by = (b.length > 6 && typeof b[6] === 'number') ? b[6] : 0;
    fx = Math.sin(by); fz = Math.cos(by); fl = 1;
  }
  fx /= fl; fz /= fl;

  /* On-foot candidate: shoulder point, then radial push-out. */
  var L = { x: P.x - fx * GOTO_SHOULDER_M, z: P.z - fz * GOTO_SHOULDER_M };
  var d = gotoFootprintDist(L.x, L.z, b), steps = 0;
  while (d < buffer && steps < 160){
    var ox = L.x - cx, oz = L.z - cz, ol = Math.hypot(ox, oz);
    if (ol < 0.001){ ox = fx; oz = fz; ol = 1; }
    L.x += (ox / ol) * 0.5; L.z += (oz / ol) * 0.5;
    d = gotoFootprintDist(L.x, L.z, b);
    steps++;
  }
  if (d < buffer){
    /* Fallback: directly in front of the front face. Exit distance of
       the front ray through the footprint, in local axes. */
    var yaw = (b.length > 6 && typeof b[6] === 'number') ? b[6] : 0;
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var flx = fx * c - fz * s, flz = fx * s + fz * c;
    var hw = (b[2] || 0) / 2, hd = (b[3] || 0) / 2;
    var tExit = Infinity;
    if (Math.abs(flx) > 1e-6) tExit = Math.min(tExit, hw / Math.abs(flx));
    if (Math.abs(flz) > 1e-6) tExit = Math.min(tExit, hd / Math.abs(flz));
    if (!isFinite(tExit)) return null;
    L = { x: cx + fx * (tExit + buffer + 0.5), z: cz + fz * (tExit + buffer + 0.5) };
    d = gotoFootprintDist(L.x, L.z, b);
    if (d < buffer) return null;
    /* The fallback must still be near the fronting road to count. */
    var back = gotoNearestRoadPoint(flat.segs, L.x, L.z);
    if (!back || back.dist > 60) return null;
  }

  /* Vehicle candidate: the road point itself, slid along the road
     until it clears the footprint by the car clearance. */
  var car = { x: P.x, z: P.z };
  var cd = gotoFootprintDist(car.x, car.z, b);
  if (cd < GOTO_CAR_CLEAR){
    var cleared = false;
    for (var slide = 1; slide <= 80 && !cleared; slide++){
      var tries = [slide, -slide];
      for (var ti = 0; ti < 2 && !cleared; ti++){
        var tx = P.x + P.dirx * tries[ti], tz = P.z + P.dirz * tries[ti];
        if (gotoFootprintDist(tx, tz, b) >= GOTO_CAR_CLEAR){
          car = { x: tx, z: tz }; cleared = true;
        }
      }
    }
    if (!cleared){ car = { x: L.x, z: L.z }; } /* shoulder fallback — still never inside */
  }

  var out = {
    x: L.x, z: L.z,
    yaw: Math.atan2(cx - L.x, cz - L.z),          /* face the building */
    roadName: P.name,
    footprintDist: gotoFootprintDist(L.x, L.z, b),
    carX: car.x, carZ: car.z,
    carYaw: Math.atan2(P.dirx, P.dirz),           /* aligned with the road */
    carFootprintDist: gotoFootprintDist(car.x, car.z, b)
  };

  /* Final proof against the WHOLE building list (when supplied): the
     landings must also clear every neighbouring footprint. The foot
     landing keeps 1.0 m from neighbours (the full buffer is owed to
     the target); if a neighbour crowds it, step along the fronting
     road a little at a time until clear. */
  if (opts.buildings){
    var guard = 0;
    while (gotoMinFootprintDist(opts.buildings, out.x, out.z) < 1.0 && guard < 30){
      out.x += P.dirx * 2; out.z += P.dirz * 2; guard++;
      if (gotoFootprintDist(out.x, out.z, b) < buffer){ out.x -= P.dirx * 4; out.z -= P.dirz * 4; }
    }
    guard = 0;
    while (gotoMinFootprintDist(opts.buildings, out.carX, out.carZ) < 1.0 && guard < 30){
      out.carX += P.dirx * 2; out.carZ += P.dirz * 2; guard++;
    }
    out.footprintDist = gotoFootprintDist(out.x, out.z, b);
    out.carFootprintDist = gotoFootprintDist(out.carX, out.carZ, b);
  }
  return out;
}

/* Landing for a PLACE (a named point). Matches the place to its
   building footprint (kept records first at runtime — this function
   just takes the list it is given) and reuses the building landing.
   With no footprint nearby (a park, a cemetery, a transit stop), the
   landing is the shoulder of the nearest road by the place point,
   facing the point. opts.buildings is the full list for the final
   clear-of-everything proof. */
function gotoLandingForPlace(place, buildings, flat, opts){
  opts = opts || {};
  var m = gotoNearestBuilding(buildings, place.x, place.z, GOTO_MATCH_R);
  if (m){
    var L = gotoLandingForBuilding(m.b, flat, opts);
    if (L){ L.matchedBuilding = true; return L; }
  }
  var P = gotoNearestRoadPoint(flat.segs, place.x, place.z);
  if (!P) return null;
  var fx = P.x - place.x, fz = P.z - place.z, fl = Math.hypot(fx, fz) || 1;
  fx /= fl; fz /= fl;
  var out = {
    x: P.x - fx * GOTO_SHOULDER_M, z: P.z - fz * GOTO_SHOULDER_M,
    yaw: Math.atan2(place.x - (P.x - fx * GOTO_SHOULDER_M), place.z - (P.z - fz * GOTO_SHOULDER_M)),
    roadName: P.name, footprintDist: Infinity, matchedBuilding: false,
    carX: P.x, carZ: P.z, carYaw: Math.atan2(P.dirx, P.dirz), carFootprintDist: Infinity
  };
  if (opts.buildings){
    /* Never land inside some OTHER building that fronts this road. */
    var guard = 0;
    while (gotoMinFootprintDist(opts.buildings, out.x, out.z) < 1.0 && guard < 30){
      out.x += P.dirx * 2; out.z += P.dirz * 2; guard++;
    }
    guard = 0;
    while (gotoMinFootprintDist(opts.buildings, out.carX, out.carZ) < 1.0 && guard < 30){
      out.carX += P.dirx * 2; out.carZ += P.dirz * 2; guard++;
    }
  }
  return out;
}

/* Landing for a STREET name: the point on that street nearest the
   player's current position (his spec — on the road itself). The same
   point serves on foot and in a vehicle; yaw runs along the road. */
function gotoLandingForRoad(flat, name, fromX, fromZ){
  var segs = flat.byName[name];
  if (!segs || !segs.length) return null;
  var P = gotoNearestRoadPoint(segs, fromX, fromZ);
  if (!P) return null;
  return {
    x: P.x, z: P.z, yaw: Math.atan2(P.dirx, P.dirz), roadName: name,
    footprintDist: Infinity,
    carX: P.x, carZ: P.z, carYaw: Math.atan2(P.dirx, P.dirz), carFootprintDist: Infinity
  };
}

/* ---- places ---------------------------------------------------------------
   Normalise a zone's places.json ({places: [[name, kind, [x, z]], ...]}
   or a bare array) into {name, kind, x, z} records. */
function gotoNormalizePlaces(data){
  var raw = Array.isArray(data) ? data : (data && Array.isArray(data.places) ? data.places : []);
  var out = [];
  for (var i = 0; i < raw.length; i++){
    var p = raw[i];
    if (!p) continue;
    if (Array.isArray(p) && p[2] && isFinite(p[2][0]) && isFinite(p[2][1]))
      out.push({ name: String(p[0] || 'Place'), kind: String(p[1] || 'place'), x: p[2][0], z: p[2][1] });
    else if (typeof p === 'object' && isFinite(p.x) && isFinite(p.z))
      out.push({ name: String(p.name || 'Place'), kind: String(p.kind || 'place'), x: p.x, z: p.z });
  }
  return out;
}

/* Search one zone's places: scored, best first, name order inside a
   score (the same ranking streets use). */
function gotoSearchPlaces(places, query, limit){
  var q = gotoNormName(query);
  var out = [];
  for (var i = 0; i < (places || []).length; i++){
    var sc = gotoMatchScore(places[i].name, q);
    if (sc > 0) out.push({ place: places[i], score: sc });
  }
  out.sort(function(a, b){
    if (b.score !== a.score) return b.score - a.score;
    return a.place.name < b.place.name ? -1 : (a.place.name > b.place.name ? 1 : 0);
  });
  return out.slice(0, limit || 40);
}

/* The zone gate — the lock law as a pure decision, shared by the UI and
   the harness: 'here' (same zone), 'go' (other zone, unlocked),
   'locked' (other zone, locked — refuse, never bypass). */
function gotoZoneGate(zoneId, currentZoneId, isUnlocked){
  if (zoneId === currentZoneId) return 'here';
  return isUnlocked(zoneId) ? 'go' : 'locked';
}

var GoToCore = {
  BUFFER_M: GOTO_BUFFER_M,
  SHOULDER_M: GOTO_SHOULDER_M,
  MATCH_R: GOTO_MATCH_R,
  CAR_CLEAR: GOTO_CAR_CLEAR,
  normName: gotoNormName,
  matchScore: gotoMatchScore,
  flattenRoads: gotoFlattenRoads,
  segClosest: gotoSegClosest,
  nearestRoadPoint: gotoNearestRoadPoint,
  searchRoads: gotoSearchRoads,
  footprintDist: gotoFootprintDist,
  nearestBuilding: gotoNearestBuilding,
  minFootprintDist: gotoMinFootprintDist,
  landingForBuilding: gotoLandingForBuilding,
  landingForPlace: gotoLandingForPlace,
  landingForRoad: gotoLandingForRoad,
  normalizePlaces: gotoNormalizePlaces,
  searchPlaces: gotoSearchPlaces,
  zoneGate: gotoZoneGate
};

/* Node export for the verification harness (the mapdelivery.js pattern).
   In the browser this branch is inert. */
if (typeof module !== 'undefined' && module.exports){ module.exports = GoToCore; }
if (typeof window === 'undefined' || typeof document === 'undefined') return;

/* ==========================================================================
   PART 2 — BROWSER RUNTIME
   ========================================================================== */

var CORE = GoToCore;

/* Plain labels for the place kinds in places.json. */
var KIND_LABELS = {
  church: 'Church', school: 'School', gas_station: 'Gas station',
  restaurant: 'Restaurant', shop_business: 'Shop / business', park: 'Park',
  cemetery: 'Cemetery', plaza_commercial: 'Shopping plaza', medical: 'Medical',
  library: 'Library', fire_police: 'Fire / police', airport: 'Airport',
  transit_station: 'Transit station', post_office: 'Post office',
  amenity_other: 'Place', leisure_other: 'Leisure', landuse_other: 'Place',
  hero: 'Hero building', place: 'Place'
};
function kindLabel(kind){
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  return String(kind || 'place').replace(/_/g, ' ').replace(/^\w/, function(ch){ return ch.toUpperCase(); });
}

/* ---- failure reporting (the crash-report hook, guarded) ---- */
function fileError(where, err){
  try{
    if (typeof window.SA_CRASH === 'function')
      window.SA_CRASH('error', { system: 'goto', where: where,
        message: String((err && err.message) || err) });
  }catch(e){}
  try{ console.warn('[GOTO] ' + where + ': ' + ((err && err.message) || err)); }catch(e){}
}
function toast(msg, ms){
  try{ if (typeof showToast === 'function') showToast(msg, ms || 3200); }catch(e){}
}

/* ---- zone helpers ---- */
function currentZoneId(){
  try{
    if (typeof ZONELOADER !== 'undefined' && ZONELOADER.currentZone) return ZONELOADER.currentZone;
  }catch(e){}
  return 'adamsville';
}
function zoneNameOf(zoneId){
  try{
    if (typeof ZoneUnlock !== 'undefined' && ZoneUnlock.zoneById){
      var z = ZoneUnlock.zoneById(zoneId);
      if (z && z.name) return z.name;
    }
  }catch(e){}
  return zoneId.charAt(0).toUpperCase() + zoneId.slice(1);
}
function zoneIsUnlocked(zoneId){
  try{
    if (typeof ZoneUnlock !== 'undefined' && ZoneUnlock.isUnlocked) return !!ZoneUnlock.isUnlocked(zoneId);
  }catch(e){}
  return zoneId === currentZoneId(); /* fail closed for other zones */
}
function landingIsPlayable(x, z){
  try{
    if (typeof ZONEUNLOCK !== 'undefined' && ZONEUNLOCK.isPlayable) return !!ZONEUNLOCK.isPlayable(x, z);
  }catch(e){}
  return true;
}

/* ---- zone data loading -----------------------------------------------------
   Places for every zone are fetched lazily (they are small). Zone road
   + building files are fetched ONLY when a cross-zone jump needs a
   landing computed from them (they are the same megabytes the zone's
   own boot will load). Reads try the local map store first —
   MapDelivery.serveText, the deferred loader's discipline — then a
   plain cache-busted fetch of the relative path. */
var _placesByZone = {};   /* zoneId -> {status, places:[{name,kind,x,z}]} */
var _flatByZone = {};     /* zoneId -> flattened roads (on demand) */

function fetchZoneText(path){
  var fromStore = null;
  try{
    if (typeof MapDelivery !== 'undefined' && MapDelivery.serveText)
      fromStore = MapDelivery.serveText(path);
  }catch(e){}
  function network(){
    var v = '';
    try{ v = window.__MAPVER || ''; }catch(e){}
    var url = path + (v ? ('?v=' + encodeURIComponent(v)) : '');
    return fetch(url, { cache: 'no-store' }).then(function(r){
      if (!r || !r.ok) throw new Error(path + ' — HTTP ' + (r && r.status));
      return r.text();
    });
  }
  if (fromStore && typeof fromStore.then === 'function'){
    return fromStore.then(function(text){
      if (text !== null && text !== undefined) return text;
      return network();
    }, function(){ return network(); });
  }
  return network();
}
function fetchZoneJson(path){
  return fetchZoneText(path).then(function(text){ return JSON.parse(text); });
}

function ensurePlaces(zoneId){
  var slot = _placesByZone[zoneId];
  if (slot && (slot.status === 'ok' || slot.status === 'loading')) return slot;
  slot = _placesByZone[zoneId] = { status: 'loading', places: [] };
  fetchZoneJson('zones/' + zoneId + '/places.json').then(function(data){
    slot.places = CORE.normalizePlaces(data);
    slot.status = 'ok';
    if (panelOpen) renderResults();
  }).catch(function(err){
    slot.status = 'fail';
    fileError('places-load-' + zoneId, err);
    if (panelOpen) renderResults();
  });
  return slot;
}
function ensureAllPlaces(){
  var ids = ['adamsville', 'mableton', 'downtown', 'eastatlanta', 'unioncity', 'southfulton', 'riverdale'];
  for (var i = 0; i < ids.length; i++) ensurePlaces(ids[i]);
}

/* The current zone's flattened roads, from the loaded ROAD_DATA. */
function currentFlat(){
  var zid = currentZoneId();
  if (_flatByZone[zid]) return _flatByZone[zid];
  var rd = null;
  try{ rd = (typeof ROAD_DATA !== 'undefined') ? ROAD_DATA : null; }catch(e){}
  if (!rd) return null;
  _flatByZone[zid] = CORE.flattenRoads(rd);
  return _flatByZone[zid];
}
/* The current zone's footprints for matching: the game's placed
   buildings first (final positions + facing yaw), raw records as the
   fallback (a place whose building the placement pass skipped — e.g.
   a footprint the road corridor rejected — still resolves, and the
   landing math keeps him clear of where it stands in the data). */
function currentBuildings(preferKept){
  var kept = null, raw = null;
  try{ kept = (typeof window !== 'undefined' && window.__bldgKept) ? window.__bldgKept : null; }catch(e){}
  try{ raw = (typeof OSM_BUILDINGS !== 'undefined') ? OSM_BUILDINGS : null; }catch(e){}
  return preferKept ? (kept || raw) : (raw || kept);
}
/* Hero buildings of the current zone, as searchable places. */
function currentHeroes(){
  var out = [];
  try{
    var hb = (typeof HERO_BUILDINGS !== 'undefined') ? HERO_BUILDINGS : null;
    var list = hb && Array.isArray(hb.buildings) ? hb.buildings : [];
    for (var i = 0; i < list.length; i++){
      var h = list[i];
      if (h && isFinite(h.x) && isFinite(h.z))
        out.push({ name: h.name || h.address || 'Hero building', kind: 'hero',
                   x: h.x, z: h.z, hero: h });
    }
  }catch(e){}
  return out;
}

/* ==========================================================================
   THE PANEL — built by this module (one file owns the whole feature).
   Relative layout per Joshua's law: the card takes a share of the
   viewport, the results list is the flexible region and SCROLLS (his
   editor UI rule), nothing is sized off-screen on a small phone.
   ========================================================================== */
var panelOpen = false;
var elPanel = null, elInput = null, elResults = null, elStatus = null;

var PANEL_CSS =
  '#goto-panel{position:fixed;inset:0;z-index:80;display:none;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,.55);font-family:Arial,sans-serif;}' +
  '#goto-panel.show{display:flex;}' +
  '#goto-card{background:#161b26;border:2px solid #ffd75e;border-radius:14px;color:#fff;' +
    'width:min(94vw,560px);height:min(88vh,660px);display:flex;flex-direction:column;padding:14px;box-sizing:border-box;}' +
  '#goto-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;}' +
  '#goto-head h3{margin:0;color:#ffd75e;font-size:22px;flex:0 0 auto;}' +
  '#goto-close{margin-left:auto;flex:0 0 auto;width:40px;height:40px;border-radius:10px;border:none;' +
    'background:#2a3247;color:#fff;font-size:18px;}' +
  '#goto-input{width:100%;box-sizing:border-box;padding:12px;font-size:18px;border-radius:10px;' +
    'border:2px solid #3a4560;background:#0d1119;color:#fff;}' +
  '#goto-status{font-size:13px;color:#9fb3c8;min-height:18px;margin:8px 2px 4px;}' +
  '#goto-results{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch;min-height:0;}' +
  '.goto-section{font-size:12px;letter-spacing:2px;color:#ffd75e;margin:12px 2px 6px;text-transform:uppercase;}' +
  '.goto-row{display:block;width:100%;text-align:left;margin:6px 0;padding:12px;border-radius:10px;' +
    'border:1px solid #3a4560;background:#1d2536;color:#fff;box-sizing:border-box;}' +
  '.goto-row .goto-name{display:block;font-size:17px;font-weight:bold;}' +
  '.goto-row .goto-sub{display:block;font-size:13px;color:#9fb3c8;margin-top:2px;}' +
  '.goto-note{font-size:13px;color:#9fb3c8;padding:10px 2px;}';

function buildPanel(){
  if (elPanel) return;
  var style = document.createElement('style');
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);

  elPanel = document.createElement('div');
  elPanel.id = 'goto-panel';
  elPanel.innerHTML =
    '<div id="goto-card">' +
      '<div id="goto-head"><h3>&#129517; Go to</h3>' +
      '<button id="goto-close" aria-label="Close Go to">&#10005;</button></div>' +
      '<input id="goto-input" type="text" autocomplete="off" autocapitalize="off" ' +
        'placeholder="Type a street, church, store..." />' +
      '<div id="goto-status"></div>' +
      '<div id="goto-results"></div>' +
    '</div>';
  document.body.appendChild(elPanel);
  elInput = elPanel.querySelector('#goto-input');
  elResults = elPanel.querySelector('#goto-results');
  elStatus = elPanel.querySelector('#goto-status');

  elPanel.querySelector('#goto-close').addEventListener('click', closePanel);

  /* Menu currency (2026-10-18, UI Editor 1.9.0): this panel is built
     here, AFTER menu_layout_apply.js has already run, so the applier
     cannot reach it — it stashes the parsed menu_layout.json on
     window.__SA_MENU_LAYOUT instead, and the entries for THIS panel
     are applied here. Visibility only: the panel's one static button
     is a ✕ glyph whose menu label is its accessible name ("Close
     Go to"), and swapping the glyph for words would change the
     panel's look, not its wording. Defensive throughout — with no
     stashed document the panel keeps its authored state. */
  try {
    var _saDoc = window.__SA_MENU_LAYOUT;
    var _saMenu = _saDoc && _saDoc.menus && _saDoc.menus.goto;
    if (_saMenu) {
      var _saDefs = [];
      (_saMenu.groups || []).forEach(function (g) {
        _saDefs = _saDefs.concat(g.items || []);
      });
      _saDefs = _saDefs.concat(_saMenu.ungrouped || []);
      _saDefs.forEach(function (def) {
        if (!def || !def.id || def.visible !== false) return;
        var _saEl = elPanel.querySelector('#' + def.id);
        if (_saEl) _saEl.style.display = 'none';
      });
    }
  } catch (e) { /* menu entries are decoration; the panel stands */ }
  elPanel.addEventListener('click', function(ev){ if (ev.target === elPanel) closePanel(); });
  elInput.addEventListener('input', renderResults);
  document.addEventListener('keydown', function(ev){
    if (panelOpen && (ev.key === 'Escape' || ev.keyCode === 27)) closePanel();
  });
}

function setStatus(msg){ if (elStatus) elStatus.textContent = msg || ''; }

function openPanel(){
  try{
    buildPanel();
    panelOpen = true;
    elPanel.classList.add('show');
    /* Menus yield BOTH ways: opening Go to from Settings closes it. */
    try{
      var st = document.getElementById('settings');
      if (st) st.classList.remove('show');
    }catch(e){}
    ensureAllPlaces();
    renderResults();
    try{ elInput.focus(); }catch(e){}
  }catch(err){
    fileError('open-panel', err);
    toast('Go to could not open — the error was filed.', 3600);
  }
}
function closePanel(){
  panelOpen = false;
  if (elPanel) elPanel.classList.remove('show');
}

/* ---- results rendering -----------------------------------------------------
   One scrollable list. Typed search: streets of this zone, then places
   of every zone (locked zones are marked, and tapping one refuses
   plainly). Browse mode (empty box): the streets and places A–Z,
   capped, with a keep-typing note — the listis exhaustive underneath,
   the cap is only on rows painted at once. */
var ROW_CAP_TYPED = 40;
var ROW_CAP_BROWSE = 150;

function makeRow(name, sub, onTap){
  var btn = document.createElement('button');
  btn.className = 'goto-row';
  var n = document.createElement('span'); n.className = 'goto-name'; n.textContent = name;
  var s = document.createElement('span'); s.className = 'goto-sub'; s.textContent = sub;
  btn.appendChild(n); btn.appendChild(s);
  btn.addEventListener('click', function(){
    try{ onTap(); }catch(err){ fileError('row-tap', err); setStatus('That did not work — the error was filed. You have not moved.'); }
  });
  return btn;
}
function sectionEl(text){
  var d = document.createElement('div');
  d.className = 'goto-section';
  d.textContent = text;
  return d;
}
function noteEl(text){
  var d = document.createElement('div');
  d.className = 'goto-note';
  d.textContent = text;
  return d;
}

function renderResults(){
  if (!elResults) return;
  try{
    elResults.innerHTML = '';
    var q = elInput ? elInput.value : '';
    var browsing = !gotoNormName(q);
    var zid = currentZoneId();
    var zname = zoneNameOf(zid);
    var flat = currentFlat();

    /* --- streets (current zone) --- */
    elResults.appendChild(sectionEl('Streets — ' + zname));
    if (!flat){
      elResults.appendChild(noteEl('The map is still loading — streets will appear in a moment.'));
    } else {
      var roads = browsing
        ? flat.names.slice().sort().map(function(n){ return { name: n, score: 1 }; })
        : CORE.searchRoads(flat, q, ROW_CAP_TYPED);
      var roadCap = browsing ? ROW_CAP_BROWSE : ROW_CAP_TYPED;
      var shown = 0;
      for (var i = 0; i < roads.length && shown < roadCap; i++){
        (function(rn){
          elResults.appendChild(makeRow(rn, 'Street · ' + zname, function(){ jumpToRoad(rn); }));
        })(roads[i].name);
        shown++;
      }
      if (!roads.length) elResults.appendChild(noteEl('No street matches that here.'));
      else if (roads.length > shown) elResults.appendChild(noteEl('Keep typing to narrow the list.'));
    }

    /* --- places (all zones) --- */
    elResults.appendChild(sectionEl('Places'));
    var heroes = currentHeroes();
    var anyPlace = false;
    /* Heroes of this zone first (they are places too). */
    var heroHits = [];
    for (var hi = 0; hi < heroes.length; hi++){
      if (browsing || CORE.matchScore(heroes[hi].name, gotoNormName(q)) > 0) heroHits.push(heroes[hi]);
    }
    for (var hh = 0; hh < heroHits.length; hh++){
      (function(h){
        anyPlace = true;
        elResults.appendChild(makeRow(h.name, 'Hero building · ' + zname, function(){ jumpToPlace({
          name: h.name, kind: 'hero', x: h.x, z: h.z, zoneId: zid, hero: h.hero }); }));
      })(heroHits[hh]);
    }
    var zoneIds = Object.keys(_placesByZone);
    /* Current zone's places first, then the rest — one merged, scored
       list per zone keeps locked-zone rows honestly labelled. */
    zoneIds.sort(function(a, b){
      if (a === zid) return -1; if (b === zid) return 1; return a < b ? -1 : 1;
    });
    var placeShown = 0;
    var placeCap = browsing ? ROW_CAP_BROWSE : ROW_CAP_TYPED;
    for (var zi = 0; zi < zoneIds.length; zi++){
      var slot = _placesByZone[zoneIds[zi]];
      if (!slot || slot.status !== 'ok') continue;
      var hits = browsing
        ? slot.places.slice().sort(function(a, b){ return a.name < b.name ? -1 : 1; })
            .map(function(p){ return { place: p, score: 1 }; })
        : CORE.searchPlaces(slot.places, q, placeCap);
      for (var pi = 0; pi < hits.length && placeShown < placeCap; pi++){
        (function(p, pzone){
          anyPlace = true;
          var locked = CORE.zoneGate(pzone, zid, zoneIsUnlocked) === 'locked';
          var sub = kindLabel(p.kind) + ' · ' + zoneNameOf(pzone) + (locked ? ' · 🔒 locked' : '');
          elResults.appendChild(makeRow(p.name, sub, function(){
            jumpToPlace({ name: p.name, kind: p.kind, x: p.x, z: p.z, zoneId: pzone });
          }));
        })(hits[pi].place, zoneIds[zi]);
        placeShown++;
      }
    }
    if (!anyPlace){
      var anyLoading = zoneIds.some(function(k){ return _placesByZone[k].status === 'loading'; });
      elResults.appendChild(noteEl(anyLoading ? 'Loading places…' :
        (browsing ? 'No places loaded yet.' : 'Nothing in the game matches that. Try a street or place name.')));
    } else if (placeShown >= placeCap){
      elResults.appendChild(noteEl('Keep typing to narrow the list.'));
    }
    if (!browsing) setStatus('');
  }catch(err){
    fileError('render-results', err);
  }
}

/* ==========================================================================
   THE JUMPS
   ========================================================================== */
function playerState(){
  var p = null, c = null, driving = false;
  try{ p = (typeof player !== 'undefined') ? player : null; }catch(e){}
  try{ c = (typeof car !== 'undefined') ? car : null; }catch(e){}
  try{ driving = !!(c && c.driving); }catch(e){}
  return { player: p, car: c, driving: driving };
}
function requirePlayer(){
  var st = playerState();
  if (!st.player || !isFinite(st.player.x) || !isFinite(st.player.z)){
    setStatus('Start the game first — then Go to can take you places.');
    toast('Start the game first — then Go to can take you places.', 3200);
    return null;
  }
  return st;
}

/* Seat a value through the game's own surface reads (applyStash's
   order: surfaceYAt for the car, groundRefY for the mesh). */
function seatY(x, z, forCar){
  var y = null;
  try{
    if (forCar && typeof surfaceYAt === 'function') y = surfaceYAt(x, z);
    if (y === null || y === undefined) y = (typeof groundRefY === 'function') ? groundRefY(x, z) : heightAt(x, z);
  }catch(e){
    try{ y = heightAt(x, z); }catch(e2){ y = 0; }
  }
  return y;
}

/* Apply a verified landing in THIS zone — loadSlot/applyStash's own
   placement sequence, narrowed to what a jump changes. Only called
   after the landing has been computed and proved. */
function applyLandingHere(landing, label){
  var st = playerState();
  var p = st.player, c = st.car;
  /* Locked-wall law: never land somewhere the walls would fight. The
     point that matters is the one he will actually occupy — the car's
     spot when driving, the foot landing otherwise. */
  var occupy = st.driving ? { x: landing.carX, z: landing.carZ } : { x: landing.x, z: landing.z };
  if (!landingIsPlayable(occupy.x, occupy.z)){
    setStatus('That spot is behind a locked zone wall — you have not moved.');
    return false;
  }
  try{
    if (st.driving && c){
      /* Vehicle: align with the road, choosing the direction nearest
         his current heading so the car never flips end-for-end. */
      var yaw = landing.carYaw;
      try{
        var cur = c.yaw || 0;
        var fwd = { x: Math.sin(cur), z: Math.cos(cur) };
        var dir = { x: Math.sin(yaw), z: Math.cos(yaw) };
        if (fwd.x * dir.x + fwd.z * dir.z < 0) yaw += Math.PI;
      }catch(e){}
      c.x = landing.carX; c.z = landing.carZ; c.yaw = yaw; c.speed = 0; c.sinking = false;
      var atHome = false;
      try{
        if (typeof heroHouse !== 'undefined' && heroHouse.drivewayPark)
          atHome = Math.hypot(c.x - heroHouse.drivewayPark.x, c.z - heroHouse.drivewayPark.z) < 2;
      }catch(e){}
      if (c.mesh){ c.mesh.position.set(c.x, seatY(c.x, c.z, true) + (atHome ? 0.32 : 0), c.z); c.mesh.rotation.y = c.yaw; }
      p.x = c.x; p.z = c.z; p.yaw = c.yaw;
    } else {
      p.x = landing.x; p.z = landing.z; p.yaw = landing.yaw;
    }
    p.inside = false; p.swimming = false; p.speed = 0; p.locIdx = -1; p.locFloorY = 0;
    if (p.mesh){
      p.mesh.visible = true;
      p.mesh.position.set(p.x, seatY(p.x, p.z, false), p.z);
      p.mesh.rotation.y = p.yaw;
    }
    /* Camera settles behind him, facing the place (applyStash's math).
       Street-name banner + minimap derive from position every frame,
       so they agree with the new spot on the next frame by themselves. */
    try{ camYaw = p.yaw; }catch(e){}
    try{ if (typeof look !== 'undefined' && look) look.yawOff = 0; }catch(e){}
    try{
      if (typeof camera !== 'undefined' && camera){
        var cb = p.yaw + Math.PI, gy = heightAt(p.x, p.z);
        camera.position.set(p.x + Math.sin(cb) * 4.6, gy + 3.0, p.z + Math.cos(cb) * 4.6);
        camera.lookAt(p.x, gy + 1.4, p.z);
      }
    }catch(e){}
    try{ if (typeof setDrivingUI === 'function') setDrivingUI(!!(st.driving && c)); }catch(e){}
  }catch(err){
    fileError('apply-landing', err);
    setStatus('The jump failed partway — the error was filed.');
    return false;
  }
  closePanel();
  toast('📍 You\'re at ' + label + '.', 3200);
  return true;
}

/* Street jump — current zone only (v1 scope, stated in the header). */
function jumpToRoad(name){
  var st = requirePlayer(); if (!st) return;
  var flat = currentFlat();
  if (!flat){ setStatus('The map is still loading — try again in a moment.'); return; }
  var landing = CORE.landingForRoad(flat, name, st.player.x, st.player.z);
  if (!landing){ setStatus('Could not find a safe spot on ' + name + ' — you have not moved.'); return; }
  if (st.driving){
    landing.carX = landing.x; landing.carZ = landing.z; landing.carYaw = landing.yaw;
    if (CORE.minFootprintDist(currentBuildings(false), landing.x, landing.z) < GOTO_CAR_CLEAR){
      setStatus('That stretch of ' + name + ' is blocked by a building — you have not moved.');
      return;
    }
  }
  applyLandingHere(landing, name);
}

/* Place jump — the zone gate decides: here / go (reload) / locked. */
function jumpToPlace(target){
  var st = requirePlayer(); if (!st) return;
  var zid = currentZoneId();
  var gate = CORE.zoneGate(target.zoneId, zid, zoneIsUnlocked);
  if (gate === 'locked'){
    var zn = zoneNameOf(target.zoneId);
    setStatus(zn + ' is locked — unlock it in Settings → Advanced Properties first. You have not moved.');
    toast('🔒 ' + zn + ' is locked — unlock it in Settings → Advanced Properties.', 3600);
    return;
  }
  if (gate === 'here'){
    var flat = currentFlat();
    if (!flat){ setStatus('The map is still loading — try again in a moment.'); return; }
    var landing = null;
    try{
      if (target.hero && target.hero.dimensions){
        /* A hero building: land by its own recorded footprint. */
        var hb = [target.x, target.z, target.hero.dimensions.W || 10, target.hero.dimensions.D || 10, 4, 0,
                  (typeof target.hero.rotation === 'number') ? target.hero.rotation : 0];
        landing = CORE.landingForBuilding(hb, flat, { buildings: currentBuildings(false) });
        if (landing && target.hero.drivewayPark && st.driving){
          landing.carX = target.hero.drivewayPark.x; landing.carZ = target.hero.drivewayPark.z;
        }
      } else {
        var kept = currentBuildings(true);
        landing = CORE.landingForPlace(target, kept, flat, { buildings: currentBuildings(false) });
        if (landing && !landing.matchedBuilding){
          /* The kept list missed it (placement-skipped building) —
             retry against the raw records before settling for the
             road-shoulder fallback. */
          var raw = currentBuildings(false);
          if (raw && raw !== kept){
            var m = CORE.nearestBuilding(raw, target.x, target.z, CORE.MATCH_R);
            if (m){
              var L2 = CORE.landingForBuilding(m.b, flat, { buildings: raw });
              if (L2){ L2.matchedBuilding = true; landing = L2; }
            }
          }
        }
      }
    }catch(err){ fileError('compute-landing', err); }
    if (!landing){
      setStatus('Could not find a safe spot in front of ' + target.name + ' — you have not moved.');
      return;
    }
    applyLandingHere(landing, target.name);
    return;
  }
  jumpCrossZone(target, st);
}

/* Cross-zone jump: fetch the target zone's roads + buildings (the same
   files its boot loads), compute the landing there, write the resume
   stash in ui_update_flow.js's documented shape tagged with the TARGET
   zone, and reload into that zone — zoneloader.transitionTo's pattern,
   with a Go To landing instead of the crossing spot. */
function jumpCrossZone(target, st){
  var zid = target.zoneId;
  var zn = zoneNameOf(zid);
  setStatus('Getting the map for ' + zn + '…');
  Promise.all([
    fetchZoneJson('zones/' + zid + '/roads.json'),
    fetchZoneJson('zones/' + zid + '/buildings.json')
  ]).then(function(parts){
    try{
      var flat = CORE.flattenRoads(parts[0]);
      var rawB = (parts[1] && Array.isArray(parts[1].buildings)) ? parts[1].buildings : parts[1];
      var landing = CORE.landingForPlace(target, rawB, flat, { buildings: rawB });
      if (!landing){
        setStatus('Could not find a safe spot in front of ' + target.name + ' — you have not moved.');
        return;
      }
      /* Build the stash — snapshot()'s documented shape, pointed at
         the landing. Player and (only when driving) car positions are
         the landing; on foot the car is deliberately left behind
         (car: null) — his spec: the player alone goes. */
      var driving = !!st.driving;
      var px = driving ? landing.carX : landing.x;
      var pz = driving ? landing.carZ : landing.z;
      var pyaw = driving ? landing.carYaw : landing.yaw;
      var carIdx = -1;
      try{
        if (driving && typeof cars !== 'undefined' && cars && st.car) carIdx = cars.indexOf(st.car);
      }catch(e){}
      var stash = {
        kind: 'ui-update', v: 1, t: Date.now(), forVer: '', zone: zid,
        player: { x: +px.toFixed(2), z: +pz.toFixed(2), yaw: +pyaw.toFixed(3),
                  inside: false, swimming: false, locIdx: -1 },
        driving: driving, carIdx: carIdx,
        car: driving ? { x: +landing.carX.toFixed(2), z: +landing.carZ.toFixed(2),
                         yaw: +landing.carYaw.toFixed(3) } : null,
        camYaw: +pyaw.toFixed(3), lookYawOff: 0,
        toast: '📍 You\'re at ' + target.name + '.'
      };
      try{ localStorage.setItem('sa_ui_update_resume', JSON.stringify(stash)); }
      catch(e){ setStatus('Could not save your spot for the trip — you have not moved.'); return; }
      closePanel();
      /* Transition overlay + reload with ?zone= (transitionTo's own
         sequence, so the new page boots the target zone's world). */
      try{
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;' +
          'background:rgba(10,10,20,0.95);z-index:99999;display:flex;flex-direction:column;' +
          'align-items:center;justify-content:center;color:#fff;font-family:Arial,sans-serif;';
        overlay.innerHTML = '<div style="font-size:28px;margin-bottom:16px;">🗺️ Going to ' +
          target.name.replace(/</g, '&lt;') + '</div>' +
          '<div style="font-size:16px;color:#888;">Loading ' + zn + '...</div>';
        document.body.appendChild(overlay);
      }catch(e){}
      setTimeout(function(){
        try{
          var url = new URL(window.location.href);
          url.searchParams.set('zone', zid);
          window.location.href = url.toString();
        }catch(e){ window.location.reload(); }
      }, 800);
    }catch(err){
      fileError('cross-zone-jump', err);
      setStatus('The trip to ' + zn + ' failed — the error was filed. You have not moved.');
    }
  }).catch(function(err){
    fileError('cross-zone-fetch', err);
    setStatus('Could not download the map for ' + zn + ' — check your connection. You have not moved.');
  });
}

/* ==========================================================================
   WIRING — the two entry points Joshua named: the on-screen button in
   the web view (#goto-btn, registered in ui_layout.json, both faces)
   and the Settings menu row (#set-goto). Both are plain DOM in
   index.html; this module only listens.
   ========================================================================== */
function wire(){
  try{
    var btn = document.getElementById('goto-btn');
    if (btn && !btn.__gotoWired){ btn.__gotoWired = true; btn.addEventListener('click', openPanel); }
    var row = document.getElementById('set-goto');
    if (row && !row.__gotoWired){ row.__gotoWired = true; row.addEventListener('click', openPanel); }
  }catch(err){ fileError('wire', err); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();

window.GoTo = { open: openPanel, close: closePanel, core: CORE };

})();
