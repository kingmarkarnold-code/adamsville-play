/* ============================================================================
   MAP REGISTRY + FRAME CONVERSION — Phase C of the Adamsville map programme
   (Joshua's GO, 2026-10-28: the game moves to a multiple-maps system with
   ADAMSVILLE AS THE DEFAULT MAP, one location / one source).

   WHAT THIS FILE OWNS
   -------------------
   1. THE REGISTRY: every playable map, by id — where its Phase B data
      package lives and which legacy zone it corresponds to. Adamsville is
      registered first and is the default map. Adding a future map is a
      registry entry plus a package drop; no loader code changes.

   2. THE ONE FRAME CONVERSION. Phase B packages are authored in TRUE
      METRES (origin = the map's spawn address; x east, z south; elevations
      absolute metres ASL). The game's runtime frame is the converted frame
      index.html's xz()/latLon() define. EVERY package<->runtime transform
      goes through the functions in this file — the loader calls them, the
      renderers call them, nothing else in the game converts package
      coordinates. One conversion, owned here, at load time. Downstream of
      the loader the game sees ONE frame, exactly as it does today.

      Package metres -> runtime, in two exact steps:
        (a) metres -> lat/lon with the package frame formulas (MPDLAT /
            MPDLON computed by the VERBATIM formula from the reference
            sweep tooling — Phase B frame.py, anchor-checked Pass 3;
            do NOT substitute rounded constants).
        (b) lat/lon -> runtime via the game's own xz() math, replicated
            here constant-for-constant (index.html: LON_MIN/LAT_MAX/WX/WZ
            and the split-zones rescale s = 1609/568 about (3772.5, 2009)).
      The inverse (runtime -> package metres) runs the same steps backward
      (it inverts xz() exactly as index.html's latLon() does).

   3. THE VERTICAL CONVERSION. Package elevations are absolute metres ASL
      (USGS 3DEP). The game's runtime Y compresses relief exactly the way
      heightAt() does: y = (elev_m - ELEV.min) * ELEV_SCALE with
      ELEV.min = 225, ELEV.max = 363 (elev.js), ELEV_SCALE = 60/(max-min).
      Package road profiles and the package terrain sampler both convert
      through elevToRuntimeY(), so a road can never disagree with the
      ground it sits on — the same one-truth rule as the horizontal frame.

   PACKAGE MODE (Phase D, 2026-10-28 — THE SWAP)
   ---------------------------------------------
   The package is now the DEFAULT for every map that has one published
   (Adamsville). The decision is made by index.html's zone seam BEFORE
   the world builds (see map_loader.js bootWorld). Legacy zone data
   stays reachable as an explicit opt-out, per map:
     ?mapsrc=legacy         (URL parameter — wins over localStorage), or
     localStorage sa_mapsrc = 'legacy'
   and ?mapsrc=package / a stored 'package' still force package mode
   on. The package location can be overridden for test servings with
     ?pkgbase=<url-or-path>   (defaults to the registry's packageBase).
   Maps and zones WITHOUT a published package always serve legacy zone
   data — zone transitions reload with ?zone=<other>, and this check is
   zone-scoped so a transition can never request a package that does
   not exist. If a package fetch fails, the boot falls back to the
   legacy zone path structurally (the seam in index.html), never to an
   error screen: the player is never stranded on a broken map.

   CLASSIC-ENGINE (APK) NOTE: package mode rides the same fetch() the
   zone JSON loader already uses on the web build. On the classic r128
   engine / file:// shell, if the package cannot be fetched the loader
   reports and the game stays on the legacy zone path — the fallback is
   structural, not a special case.

   PHASE F (2026-10-28, later the same day) — THE MAP IS REMOVED.
   Joshua's restart order: the whole world map comes OUT of the game and
   waits in the archive (adamsville-play-archive, branch
   world-map-removed-2026-10-28) while Adamsville is rebuilt from
   scratch. The registry below is EMPTY — no map is installed — and the
   legacy fallback described above is GONE with the data it loaded:
   ?mapsrc=legacy and the sa_mapsrc setting now name a source that does
   not exist, and the boot seam answers every no-map boot with the
   critical "NO MAP DATA" panel. Nothing can resurrect a map that is
   not installed. A future map registers here again (one entry + a
   package folder) and package mode revives with it.
   ============================================================================ */

/* ---------------------------------------------------------------------------
   The registry. EMPTY since Phase F (2026-10-28) — no map is installed.
   A future map entry looks like:
     adamsville: { id:'adamsville', name:'Adamsville', isDefault:true,
       packageBase:'maps/adamsville/',
       origin:{ lat:33.74110, lon:-84.52645 } }
   packageBase is resolved relative to detailed/ (the game's own
   directory) so web, dev (generated www) and the APK shell all address
   the same layout.
   --------------------------------------------------------------------------- */
var MAP_REGISTRY = {
};
var DEFAULT_MAP_ID = 'adamsville';

/* ---------------------------------------------------------------------------
   Package frame constants (Phase B frame.py — formulas verbatim).
   MPDLAT/MPDLON are metres per degree at the origin latitude.
   --------------------------------------------------------------------------- */
var PKG_LAT0 = 33.74110, PKG_LON0 = -84.52645;
var _PKG_D = Math.PI / 180.0;
var PKG_MPDLAT = 111132.92 - 559.82 * Math.cos(2 * PKG_LAT0 * _PKG_D)
               + 1.175 * Math.cos(4 * PKG_LAT0 * _PKG_D);
var PKG_MPDLON = 111412.84 * Math.cos(PKG_LAT0 * _PKG_D)
               - 93.5 * Math.cos(3 * PKG_LAT0 * _PKG_D);

/* ---------------------------------------------------------------------------
   Game runtime frame constants — replicated from index.html xz()/latLon()
   (the game's own definitions; if index.html's frame ever changes, this
   block is the one place that must change with it).
   --------------------------------------------------------------------------- */
var FRAME_LON_MIN = -84.6209, FRAME_LON_RANGE = 0.2418;
var FRAME_LAT_MAX = 33.8392,  FRAME_LAT_RANGE = 0.3184;
var FRAME_WX = 8000, FRAME_WZ = 12000;
var FRAME_CX = 3772.5, FRAME_CZ = 2009;
var FRAME_S = 2.8327464788732395;   /* 1609/568 split-zones rescale */

/* Vertical conversion constants — mirror heightAt()/elev.js exactly:
   ELEV.min = 225, ELEV.max = 363, ELEV_SCALE = 60 / (max - min). */
var PKG_ELEV_MIN = 225, PKG_ELEV_MAX = 363;
var PKG_ELEV_SCALE = 60 / (PKG_ELEV_MAX - PKG_ELEV_MIN);

/* --- package metres -> lat/lon (package frame formulas) --- */
function pkgToLatLon(x, z){
  return { lat: PKG_LAT0 - z / PKG_MPDLAT, lon: PKG_LON0 + x / PKG_MPDLON };
}
/* --- lat/lon -> package metres (exact inverse) --- */
function latLonToPkg(lat, lon){
  return { x: (lon - PKG_LON0) * PKG_MPDLON, z: (PKG_LAT0 - lat) * PKG_MPDLAT };
}
/* --- lat/lon -> runtime (index.html xz(), replicated) --- */
function latLonToRuntime(lat, lon){
  var x = (lon - FRAME_LON_MIN) / FRAME_LON_RANGE * FRAME_WX;
  var z = (FRAME_LAT_MAX - lat) / FRAME_LAT_RANGE * FRAME_WZ;
  x = FRAME_CX + (x - FRAME_CX) * FRAME_S;
  z = FRAME_CZ + (z - FRAME_CZ) * FRAME_S;
  return { x: x, z: z };
}
/* --- runtime -> lat/lon (index.html latLon(), replicated) --- */
function runtimeToLatLon(x, z){
  var ox = FRAME_CX + (x - FRAME_CX) / FRAME_S;
  var oz = FRAME_CZ + (z - FRAME_CZ) / FRAME_S;
  return { lat: FRAME_LAT_MAX - oz / FRAME_WZ * FRAME_LAT_RANGE,
           lon: FRAME_LON_MIN + ox / FRAME_WX * FRAME_LON_RANGE };
}
/* --- package metres -> runtime: THE conversion (steps a+b) --- */
function pkgToRuntime(x, z){
  var ll = pkgToLatLon(x, z);
  return latLonToRuntime(ll.lat, ll.lon);
}
/* --- runtime -> package metres (exact inverse of pkgToRuntime) --- */
function runtimeToPkg(x, z){
  var ll = runtimeToLatLon(x, z);
  return latLonToPkg(ll.lat, ll.lon);
}
/* --- package elevation (absolute m ASL) -> runtime Y --- */
function elevToRuntimeY(elevM){
  return (elevM - PKG_ELEV_MIN) * PKG_ELEV_SCALE;
}
/* --- runtime Y -> package elevation (inverse; reference/debugging) --- */
function runtimeYToElev(y){
  return y / PKG_ELEV_SCALE + PKG_ELEV_MIN;
}

/* ---------------------------------------------------------------------------
   Package terrain sampler. terrain.bin is a Float32 LE grid over the
   package bounds (zone.json 'terrain': nx x nz postings at post_m spacing,
   row 0 = north edge = bounds zMin, rows run south, cols run east), values
   in absolute metres ASL with water carved below banks (Phase B TR items).
   The sampler works in package metres and in runtime coordinates; the
   runtime entry point converts through this file's one conversion.
   --------------------------------------------------------------------------- */
function makePkgTerrainSampler(zoneMeta, float32){
  var t = (zoneMeta && zoneMeta.terrain) || {};
  var b = (zoneMeta && zoneMeta.bounds_m) || {};
  var nx = t.nx || 0, nz = t.nz || 0, post = t.post_m || 10;
  var x0 = b.xMin, z0 = b.zMin;   /* grid origin: west edge, NORTH edge */
  function sampleElevM(px, pz){
    if (!nx || !nz || !float32 || float32.length < nx * nz) return null;
    var fx = (px - x0) / post, fz = (pz - z0) / post;
    if (fx < 0) fx = 0; if (fz < 0) fz = 0;
    if (fx > nx - 1) fx = nx - 1; if (fz > nz - 1) fz = nz - 1;
    var i0 = Math.floor(fx), j0 = Math.floor(fz);
    var i1 = Math.min(i0 + 1, nx - 1), j1 = Math.min(j0 + 1, nz - 1);
    var ax = fx - i0, az = fz - j0;
    var a = float32[j0 * nx + i0], bb = float32[j0 * nx + i1];
    var c = float32[j1 * nx + i0], d = float32[j1 * nx + i1];
    return a + (bb - a) * ax + (c - a) * az + (a - bb - c + d) * ax * az;
  }
  return {
    nx: nx, nz: nz, post_m: post,
    sampleElevM: sampleElevM,
    /* Runtime-frame ground height from the package terrain — installed
       as the collision material system's ground sampler in package mode. */
    heightYAtRuntime: function(x, z){
      var p = runtimeToPkg(x, z);
      var e = sampleElevM(p.x, p.z);
      return (e === null) ? null : elevToRuntimeY(e);
    }
  };
}

/* ---------------------------------------------------------------------------
   Package-mode resolution (Phase D: package is the default per map).
   Zone-scoped: the CURRENT zone (from ?zone=, default the default map)
   must have a registry entry WITH a packageBase, or the answer is
   legacy — the other six zones have no package and always serve their
   legacy zone data. Explicit opt-outs beat the default; the URL beats
   localStorage (same precedence as Phase C).
   --------------------------------------------------------------------------- */
function _currentZoneId(){
  try {
    var m = /[?&]zone=([a-z]+)/.exec(window.location.search || '');
    return m ? m[1] : DEFAULT_MAP_ID;
  } catch(e){ return DEFAULT_MAP_ID; }
}
function _mapPackageMode(){
  var entry = MAP_REGISTRY[_currentZoneId()];
  if (!entry || !entry.packageBase) return false;
  try {
    var q = new URLSearchParams(window.location.search);
    var m = q.get('mapsrc');
    if (m) return m === 'package';
    if (window.localStorage){
      var s = localStorage.getItem('sa_mapsrc');
      if (s === 'legacy') return false;
      if (s === 'package') return true;
    }
  } catch(e){}
  return true;
}
function _mapPackageBaseOverride(){
  try {
    var q = new URLSearchParams(window.location.search);
    return q.get('pkgbase') || null;
  } catch(e){ return null; }
}

/* ---------------------------------------------------------------------------
   Public API
   --------------------------------------------------------------------------- */
window.MapRegistry = {
  maps: MAP_REGISTRY,
  defaultMapId: DEFAULT_MAP_ID,
  get: function(id){ return MAP_REGISTRY[id || DEFAULT_MAP_ID] || null; }
};
window.MapFrame = {
  PKG_LAT0: PKG_LAT0, PKG_LON0: PKG_LON0,
  PKG_MPDLAT: PKG_MPDLAT, PKG_MPDLON: PKG_MPDLON,
  /* Runtime units per package metre along a converted axis run (the
     frame's distance scale — pkgToRuntime applies it about the frame
     centre). Renderers sizing package-authored widths (runway strips,
     aprons) convert through this, never a hand-typed constant. */
  S: FRAME_S,
  pkgToLatLon: pkgToLatLon, latLonToPkg: latLonToPkg,
  latLonToRuntime: latLonToRuntime, runtimeToLatLon: runtimeToLatLon,
  pkgToRuntime: pkgToRuntime, runtimeToPkg: runtimeToPkg,
  elevToRuntimeY: elevToRuntimeY, runtimeYToElev: runtimeYToElev,
  makePkgTerrainSampler: makePkgTerrainSampler
};
window.MapSystem = {
  /* Filled by map_loader.js when a package activates; null in legacy mode. */
  activePackage: null,
  packageActive: function(){ return !!window.MapSystem.activePackage; },
  packageModeRequested: _mapPackageMode,
  packageBaseOverride: _mapPackageBaseOverride,
  /* Phase F (2026-10-28): true only when at least one map is registered.
     The registry is empty after the map removal, so this is false and the
     boot seam answers with the NO MAP DATA state. */
  anyMapInstalled: function(){
    for (var k in MAP_REGISTRY){ if (MAP_REGISTRY.hasOwnProperty(k)) return true; }
    return false;
  }
};
