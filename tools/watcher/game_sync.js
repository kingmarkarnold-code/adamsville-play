/* ============================================================================
   Adamsville Watcher — Game Data Sync (single source of truth)
   ----------------------------------------------------------------------------
   The watcher does NOT keep its own copies of game data. It loads the live
   files directly from the published game:
       https://kingmarkarnold-code.github.io/adamsville-play/detailed/
   so what Joshua sees in the watcher always matches the game.
   If the game URL is unreachable (offline), each load falls back to the
   watcher's local copy.
   Cache-busting uses the game's map_version from map-manifest.json, so a new
   publish is picked up without stale caches. Bump map_version in the game
   whenever ANY published file changes (map data OR code like vehicle_meshes.js).

   ZONE REPOINT (2026-10-16): the zoned game NEVER loads the old root files
   detailed/roads.js, detailed/osm_buildings.js, detailed/exit_signs.js —
   those are the retired pre-zone (TIGER) network. The game actually loads
   per-zone JSON via detailed/zoneloader.js:
       detailed/zones/<zone>/{roads,buildings,signs,pins,...}.json
   for zones adamsville, downtown, eastatlanta, mableton, riverdale,
   southfulton, unioncity. The live sync below therefore fetches the ZONE
   files, merges them across all 7 zones, and adapts the merged records
   into the exact globals/shapes the watcher has always consumed:
       window.ROAD_DATA      merged converted roads, category-grouped
                             {highway, major_artery, minor_artery, local}
                             with records {name, pts, ys, ramp, ...} intact
       window.OSM_BUILDINGS  merged buildings [[x,z,w,d,h,type], ...]
       window.OSM_REAL_COUNT sum of the zones' buildings.json realCounts
       window.EXIT_SIGNS     merged signs [{x,z,yaw,hwy,exit,text}, ...]
       window.JUNCTION_PINS  merged pins [{x,z,y,r,dh}, ...] (on request)
   FAIL-OPEN, per data kind: if every zone fetch for a kind fails, that kind
   falls back to the previous behaviour (live root script, then the
   watcher-local copy). A single zone failing — or a 404 on an optional
   zone file — contributes nothing for that zone and is never fatal.
   elev.js -> HEIGHTFIELD and vehicle_meshes.js are unchanged: the game
   still loads those from detailed/ root, and so does the watcher.
   ========================================================================== */
var GameSync = (function () {
'use strict';

var GAME_URL = 'https://kingmarkarnold-code.github.io/adamsville-play/detailed/';
var _ver = null, _verTried = false;

/* The 7 zones the game loads (mirrors detailed/zoneloader.js). */
var ZONES = ['adamsville', 'downtown', 'eastatlanta', 'mableton',
             'riverdale', 'southfulton', 'unioncity'];

/* Converted + legacy road categories -> watcher WORLD type index
   (0=highway, 1=arterial, 2=local). The game folds legacy 'arterial' into
   minor_artery (its normRoadCat); the watcher only has 3 road classes, so
   both artery classes map to 1 here. Unknown categories are skipped by
   roadsToWorld rather than guessed at. */
var ROAD_CATS = [['highway', 0], ['major_artery', 1], ['minor_artery', 1],
                 ['arterial', 1], ['local', 2]];

function loadScript(src) {
  return new Promise(function (res, rej) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = function () { res(); };
    s.onerror = function () { rej(new Error('failed to load ' + src)); };
    document.head.appendChild(s);
  });
}

/* map_version from the game's manifest — used as ?v= on every game file */
function getVersion() {
  if (_verTried) return Promise.resolve(_ver);
  _verTried = true;
  return fetch(GAME_URL + 'map-manifest.json', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (m) { _ver = (m && m.map_version) || null; return _ver; })
    .catch(function () { _ver = null; return null; });
}

/* Load a game file by name; fall back to the watcher's local copy on failure.
   localName: watcher's fallback filename (null = no fallback, resolve anyway). */
function load(name, localName) {
  return getVersion().then(function (v) {
    var url = GAME_URL + name + (v ? '?v=' + encodeURIComponent(v) : '');
    return loadScript(url).catch(function () {
      if (localName) return loadScript(localName);
      // no fallback — resolve so optional modules (vehicle meshes) just skip
    });
  });
}

/* ---- zone JSON fetching (the data the game actually loads) ---- */

/* Fetch one published game JSON path (relative to detailed/), cache-busted
   with map_version exactly like load(). Rejects on HTTP/network errors;
   callers decide what a failure means (always fail-open). */
function fetchJson(path) {
  return getVersion().then(function (v) {
    var url = GAME_URL + path + (v ? '?v=' + encodeURIComponent(v) : '');
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + path);
      return r.json();
    });
  });
}

/* Fetch zones/<zone>/<kind>.json for every zone, in parallel.
   Resolves to [{zone, data}, ...] with data === null for any zone whose
   file failed for any reason (offline, 404 on an optional file, bad JSON) —
   a missing zone file is empty, never fatal. Never rejects. */
function fetchAllZones(kind) {
  if (typeof fetch === 'undefined') {
    return Promise.resolve(ZONES.map(function (z) { return { zone: z, data: null }; }));
  }
  return Promise.all(ZONES.map(function (z) {
    return fetchJson('zones/' + z + '/' + kind + '.json')
      .then(function (data) { return { zone: z, data: data }; })
      .catch(function () { return { zone: z, data: null }; });
  }));
}

var _zoneRoadsP = null, _zoneBuildingsP = null, _zoneSignsP = null, _zonePinsP = null;
var lastZoneSummary = null;

/* Roads: merge the category-grouped zone roads.json payloads into one
   ROAD_DATA-shaped object. Records are carried through untouched (name,
   pts, ys, ramp and any other converted fields survive the merge); only
   the grouping is flattened across zones. On total zone failure, falls
   back to the previous behaviour: the live root roads.js script (which
   sets the legacy ROAD_DATA global), resolving either way. */
function loadZoneRoads() {
  if (_zoneRoadsP) return _zoneRoadsP;
  _zoneRoadsP = fetchAllZones('roads').then(function (parts) {
    var merged = { highway: [], major_artery: [], minor_artery: [], local: [] };
    var count = 0, zonesOk = 0;
    parts.forEach(function (p) {
      if (!p.data || typeof p.data !== 'object') return;
      var zc = 0;
      Object.keys(merged).forEach(function (cat) {
        var list = p.data[cat];
        if (Array.isArray(list)) { merged[cat] = merged[cat].concat(list); zc += list.length; }
      });
      /* tolerate any extra category a future conversion adds */
      Object.keys(p.data).forEach(function (cat) {
        if (!(cat in merged) && Array.isArray(p.data[cat])) {
          merged[cat] = p.data[cat].slice(); zc += p.data[cat].length;
        }
      });
      if (zc) zonesOk++;
      count += zc;
    });
    if (count > 0) {
      window.ROAD_DATA = merged;
      lastZoneSummary = lastZoneSummary || {};
      lastZoneSummary.roads = { count: count, zonesOk: zonesOk, source: 'zones' };
      return { ok: true, count: count, zonesOk: zonesOk, source: 'zones' };
    }
    return load('roads.js', null).then(function () {
      var n = 0;
      if (window.ROAD_DATA) Object.keys(window.ROAD_DATA).forEach(function (c) {
        if (Array.isArray(window.ROAD_DATA[c])) n += window.ROAD_DATA[c].length;
      });
      lastZoneSummary = lastZoneSummary || {};
      lastZoneSummary.roads = { count: n, zonesOk: 0, source: 'legacy-fallback' };
      return { ok: n > 0, count: n, zonesOk: 0, source: 'legacy-fallback' };
    });
  }).catch(function () { return { ok: false, count: 0, zonesOk: 0, source: 'none' }; });
  return _zoneRoadsP;
}

/* Buildings: buildings.json = {version, realCount, buildings:[[x,z,w,d,h,
   type], ...]} — the buildings array IS the OSM_BUILDINGS shape, so the
   merge is a plain concatenation plus the realCount sum (the same three
   globals the game's own loader derives from this file). On total zone
   failure, falls back to the previous behaviour: live root
   osm_buildings.js, then the watcher-local copy. */
function loadZoneBuildings() {
  if (_zoneBuildingsP) return _zoneBuildingsP;
  _zoneBuildingsP = fetchAllZones('buildings').then(function (parts) {
    var all = [], real = 0, zonesOk = 0, version = null;
    parts.forEach(function (p) {
      if (!p.data || !Array.isArray(p.data.buildings)) return;
      all = all.concat(p.data.buildings);
      real += (typeof p.data.realCount === 'number') ? p.data.realCount : p.data.buildings.length;
      if (p.data.buildings.length) zonesOk++;
      if (!version && p.data.version) version = p.data.version;
    });
    if (all.length > 0) {
      window.OSM_BUILDINGS = all;
      window.OSM_REAL_COUNT = real;
      if (version) window.OSM_BLDG_VERSION = version;
      lastZoneSummary = lastZoneSummary || {};
      lastZoneSummary.buildings = { count: all.length, realCount: real, zonesOk: zonesOk, source: 'zones' };
      return { ok: true, count: all.length, realCount: real, zonesOk: zonesOk, source: 'zones' };
    }
    return load('osm_buildings.js', 'osm_buildings.js').then(function () {
      var n = (window.OSM_BUILDINGS || []).length;
      lastZoneSummary = lastZoneSummary || {};
      lastZoneSummary.buildings = { count: n, realCount: n, zonesOk: 0, source: 'legacy-fallback' };
      return { ok: n > 0, count: n, realCount: n, zonesOk: 0, source: 'legacy-fallback' };
    });
  }).catch(function () { return { ok: false, count: 0, realCount: 0, zonesOk: 0, source: 'none' }; });
  return _zoneBuildingsP;
}

/* Signs: signs.json is a plain array of {x,z,yaw,hwy,exit,text} — the exact
   EXIT_SIGNS shape — so the merge is a concatenation. On total zone failure,
   falls back to the previous behaviour: live root exit_signs.js, then the
   watcher-local copy. */
function loadZoneSigns() {
  if (_zoneSignsP) return _zoneSignsP;
  _zoneSignsP = fetchAllZones('signs').then(function (parts) {
    var all = [], zonesOk = 0;
    parts.forEach(function (p) {
      if (!Array.isArray(p.data)) return;
      all = all.concat(p.data);
      if (p.data.length) zonesOk++;
    });
    if (all.length > 0) {
      window.EXIT_SIGNS = all;
      lastZoneSummary = lastZoneSummary || {};
      lastZoneSummary.signs = { count: all.length, zonesOk: zonesOk, source: 'zones' };
      return { ok: true, count: all.length, zonesOk: zonesOk, source: 'zones' };
    }
    return load('exit_signs.js', 'exit_signs.js').then(function () {
      var n = (window.EXIT_SIGNS || []).length;
      lastZoneSummary = lastZoneSummary || {};
      lastZoneSummary.signs = { count: n, zonesOk: 0, source: 'legacy-fallback' };
      return { ok: n > 0, count: n, zonesOk: 0, source: 'legacy-fallback' };
    });
  }).catch(function () { return { ok: false, count: 0, zonesOk: 0, source: 'none' }; });
  return _zoneSignsP;
}

/* Pins: pins.json is a plain array of {x,z,y,r,dh} — the game's
   JUNCTION_PINS shape. No current watcher view consumes junction pins, so
   this loader is opt-in (loadZoneData({pins:true}) or direct call) and has
   no script fallback: failure simply leaves JUNCTION_PINS unset. */
function loadZonePins() {
  if (_zonePinsP) return _zonePinsP;
  _zonePinsP = fetchAllZones('pins').then(function (parts) {
    var all = [], zonesOk = 0;
    parts.forEach(function (p) {
      if (!Array.isArray(p.data)) return;
      all = all.concat(p.data);
      if (p.data.length) zonesOk++;
    });
    if (all.length > 0) window.JUNCTION_PINS = all;
    lastZoneSummary = lastZoneSummary || {};
    lastZoneSummary.pins = { count: all.length, zonesOk: zonesOk, source: all.length ? 'zones' : 'none' };
    return { ok: all.length > 0, count: all.length, zonesOk: zonesOk, source: all.length ? 'zones' : 'none' };
  }).catch(function () { return { ok: false, count: 0, zonesOk: 0, source: 'none' }; });
  return _zonePinsP;
}

/* Load every live data kind the watcher inspects (roads + buildings +
   signs; pins only when opts.pins). Never rejects — each kind fails open
   on its own. Resolves to the per-kind summary. */
function loadZoneData(opts) {
  var jobs = [loadZoneRoads(), loadZoneBuildings(), loadZoneSigns()];
  if (opts && opts.pins) jobs.push(loadZonePins());
  return Promise.all(jobs).then(function () { return lastZoneSummary; });
}

/* ---- adapters: game formats -> watcher formats ---- */

/* game's ROAD_DATA {category: [{name, pts:[[x,z]...], ys?, ramp?}]}
   -> WORLD.roads [[typeIdx,name,flatPts]] (0=highway,1=arterial,2=local).
   Handles BOTH the converted categories (highway / major_artery /
   minor_artery / local) and the legacy root-file categories (highway /
   arterial / local). The full merged records — ys, ramp and all — stay
   available untouched on window.ROAD_DATA for any consumer that can use
   them; the WORLD tuple itself has no slot for them and its consumers
   (2D patrol, 3D ribbons, road labels, placement grid) read only
   [typeIdx, name, flatPts]. */
function roadsToWorld(data) {
  var src = data || window.ROAD_DATA;
  var out = [];
  if (!src) return out;
  ROAD_CATS.forEach(function (c) {
    var list = src[c[0]] || [];
    list.forEach(function (r) {
      var flat = [];
      (r.pts || []).forEach(function (p) { flat.push(p[0], p[1]); });
      if (flat.length >= 4) out.push([c[1], r.name || '', flat]);
    });
  });
  return out;
}

/* game's OSM_BUILDINGS [[x,z,w,d,h,type], ...]
   -> the 2D snapshot's flat building triplets [x,z,type, ...] (integers,
   matching build-world.js). The 3D views keep using OSM_BUILDINGS itself;
   this adapter exists for any WORLD-shaped consumer of the live data. */
function buildingsToWorldFlat(list) {
  var src = list || window.OSM_BUILDINGS || [];
  var out = [];
  src.forEach(function (b) { out.push(Math.round(b[0]), Math.round(b[1]), b[5]); });
  return out;
}

/* game's ELEV {lat0,dLat,lon0,dLon,rows,cols,min,max,g} (raw meters, lat/lon grid)
   -> HEIGHTFIELD-shaped {nx,nz,w,h,data} in game units, using the game's own
   geo mapping (LON_MIN/LON_RANGE/LAT_MAX/LAT_RANGE) and elevation formula
   h = (meters - ELEV.min) * 60/(ELEV.max - ELEV.min).
   NOTE: the game adds hand-tuned local hills on top of this in heightAt();
   the watcher shows the base terrain. */
function elevToHeightfield() {
  var E = window.ELEV;
  var nx = 100, nz = 150, w = 8000, h = 12000;
  var data = new Array(nx * nz);
  function elevRaw(lat, lon) {
    var i = (lon - E.lon0) / E.dLon, j = (lat - E.lat0) / E.dLat;
    i = Math.max(0, Math.min(E.cols - 1.001, i));
    j = Math.max(0, Math.min(E.rows - 1.001, j));
    var i0 = Math.floor(i), j0 = Math.floor(j), fi = i - i0, fj = j - j0;
    var a = E.g[j0][i0], b = E.g[j0][i0 + 1], c = E.g[j0 + 1][i0], d = E.g[j0 + 1][i0 + 1];
    return a + (b - a) * fi + (c - a) * fj + (a - b - c + d) * fi * fj;
  }
  var scale = 60 / (E.max - E.min);
  for (var iz = 0; iz < nz; iz++) {
    for (var ix = 0; ix < nx; ix++) {
      var x = ix / (nx - 1) * w, z = iz / (nz - 1) * h;
      var lat = 33.8392 - z / 12000 * 0.3184;
      var lon = -84.6209 + x / 8000 * 0.2418;
      data[iz * nx + ix] = (elevRaw(lat, lon) - E.min) * scale;
    }
  }
  return { nx: nx, nz: nz, w: w, h: h, data: data };
}

return {
  GAME_URL: GAME_URL,
  ZONES: ZONES,
  load: load,
  getVersion: getVersion,
  fetchJson: fetchJson,
  loadZoneRoads: loadZoneRoads,
  loadZoneBuildings: loadZoneBuildings,
  loadZoneSigns: loadZoneSigns,
  loadZonePins: loadZonePins,
  loadZoneData: loadZoneData,
  zoneSummary: function () { return lastZoneSummary; },
  roadsToWorld: roadsToWorld,
  buildingsToWorldFlat: buildingsToWorldFlat,
  elevToHeightfield: elevToHeightfield
};
})();
