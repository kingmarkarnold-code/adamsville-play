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
   ========================================================================== */
var GameSync = (function () {
'use strict';

var GAME_URL = 'https://kingmarkarnold-code.github.io/adamsville-play/detailed/';
var _ver = null, _verTried = false;

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

/* ---- adapters: game formats -> watcher formats ---- */

/* game's ROAD_DATA {highway,arterial,local:[{name,pts:[[x,z]...]}]}
   -> WORLD.roads [[typeIdx,name,flatPts]] (0=highway,1=arterial,2=local) */
function roadsToWorld() {
  var out = [];
  var cats = [['highway', 0], ['arterial', 1], ['local', 2]];
  cats.forEach(function (c) {
    var list = (window.ROAD_DATA && window.ROAD_DATA[c[0]]) || [];
    list.forEach(function (r) {
      var flat = [];
      (r.pts || []).forEach(function (p) { flat.push(p[0], p[1]); });
      if (flat.length >= 4) out.push([c[1], r.name || '', flat]);
    });
  });
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
  load: load,
  getVersion: getVersion,
  roadsToWorld: roadsToWorld,
  elevToHeightfield: elevToHeightfield
};
})();
