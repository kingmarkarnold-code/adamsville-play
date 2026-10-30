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

   PHASE G (2026-10-30) — that future map is here: the rebuilt
   Adamsville terrain + fresh water package is registered below as a
   PARTIAL map (see the registry comment). The legacy fallback stays
   revoked; a partial package is the only installed map.
   ============================================================================ */

/* ---------------------------------------------------------------------------
   The registry. EMPTY from Phase F (2026-10-28) until Phase G.

   PHASE G (2026-10-30, Joshua's directive) — ADAMSVILLE RETURNS AS A
   PARTIAL MAP. The rebuilt terrain (Stage 1-3: USGS/Google ground,
   pads, channels) plus the fresh verified water layer are published
   as a package, and the game loads it in PARTIAL mode: the player
   spawns at 535 and can run the whole board on foot on the real
   ground, while buildings, NPCs, vehicles/traffic, crews and every
   system that needs a complete map stay disabled (map_loader.js and
   index.html gate on pkg.partial / window.__PKG_PARTIAL) until their
   own build steps land. The entry's `partial: true` is part of the
   package contract: zone.json in the package carries the same flag.
   packageBase is resolved relative to detailed/ (the game's own
   directory) so web, dev (generated www) and the APK shell all address
   the same layout.
   --------------------------------------------------------------------------- */
var MAP_REGISTRY = {
  adamsville: { id: 'adamsville', name: 'Adamsville', isDefault: true,
    packageBase: 'maps/adamsville/',
    origin: { lat: 33.74110, lon: -84.52645 },
    partial: true }
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
   D-GRID TERRAIN SAMPLER (Phase G, 2026-10-30). The rebuilt Adamsville
   terrain ships in the two-level "D-grid" encoding Joshua ruled in Q2
   (2 m posts near roads & houses, 10 m elsewhere) — the sampler learns
   that layout; the data is NOT flattened to a single coarse grid.

   Encoding (Stage 1 near_index.json, format-verified at publish time):
     heights_base_10m.bin  Float32, nx x nz posts at 10 m over the whole
                           bounds (row 0 = north edge = bounds zMin).
     heights_near_2m.bin   Float32 values for the STORED 2 m posts only,
                           in row-major scan order over the post mask.
     nearpost_mask.bin     one bit per 2 m post (MSB-first within each
                           byte, global bit index = row*nx + col); a post
                           is stored iff its bit is set.
     nearpost_rows.bin     Uint64 LE, nz+1 entries: entry r is the value
                           index of row r's first stored post; the value
                           index of a stored post (row, col) is
                           rows[row] + (set bits in the row before col).
                           (The loader converts the u64 table to a plain
                           Uint32Array before calling this factory.)
   Base posts are every 5th near post, bit-identical in the source, so
   one surface exists: a stored post reads its 2 m value; an unstored
   post reads the 10 m base grid bilinearly at its own location; a
   sample bilinearly blends its four surrounding 2 m posts. Continuous
   everywhere, exact 2 m truth wherever the near field is stored.
   --------------------------------------------------------------------------- */
function makeDGridSampler(zoneMeta, data){
  var t = (zoneMeta && zoneMeta.terrain) || {};
  var b = (zoneMeta && zoneMeta.bounds_m) || {};
  var nearMeta = t.near || {};
  var bnx = t.nx || 0, bnz = t.nz || 0, bpost = t.post_m || 10;
  var nnx = nearMeta.nx || 0, nnz = nearMeta.nz || 0, npost = nearMeta.post_m || 2;
  var x0 = b.xMin, z0 = b.zMin;   /* west edge, NORTH edge */
  var base = data && data.base, near = data && data.near,
      mask = data && data.mask, rows = data && data.rows;
  /* Byte popcount LUT + a global byte-prefix table, so the within-row
     rank of any post is O(1): full bytes come from the prefix table,
     the two partial bytes are counted bit by bit (MSB-first order). */
  var lut = new Uint8Array(256);
  for (var li = 0; li < 256; li++){
    var lv = li, lc = 0;
    while (lv){ lc += lv & 1; lv >>= 1; }
    lut[li] = lc;
  }
  var bytePref = new Uint32Array(mask ? mask.length + 1 : 1);
  if (mask) for (var bi = 0; bi < mask.length; bi++)
    bytePref[bi + 1] = bytePref[bi] + lut[mask[bi]];
  function bitAt(gi){ return (mask[gi >> 3] >> (7 - (gi & 7))) & 1; }
  function countBits(from, to){
    var n = 0, i = from;
    while (i < to && (i & 7) !== 0){ n += bitAt(i); i++; }
    var eb = to >> 3;
    if ((i >> 3) < eb){ n += bytePref[eb] - bytePref[i >> 3]; i = eb << 3; }
    while (i < to){ n += bitAt(i); i++; }
    return n;
  }
  function baseAt(px, pz){
    var fx = (px - x0) / bpost, fz = (pz - z0) / bpost;
    if (fx < 0) fx = 0; if (fz < 0) fz = 0;
    if (fx > bnx - 1) fx = bnx - 1; if (fz > bnz - 1) fz = bnz - 1;
    var i0 = Math.floor(fx), j0 = Math.floor(fz);
    var i1 = Math.min(i0 + 1, bnx - 1), j1 = Math.min(j0 + 1, bnz - 1);
    var ax = fx - i0, az = fz - j0;
    var a = base[j0 * bnx + i0], bb = base[j0 * bnx + i1];
    var c = base[j1 * bnx + i0], d = base[j1 * bnx + i1];
    return a + (bb - a) * ax + (c - a) * az + (a - bb - c + d) * ax * az;
  }
  function postValue(row, col){
    var gi = row * nnx + col;
    if (bitAt(gi))
      return near[rows[row] + countBits(row * nnx, gi)];
    return baseAt(x0 + col * npost, z0 + row * npost);
  }
  function sampleElevM(px, pz){
    if (!base || !near || !mask || !rows || !nnx || !nnz) return null;
    var fx = (px - x0) / npost, fz = (pz - z0) / npost;
    if (fx < 0) fx = 0; if (fz < 0) fz = 0;
    if (fx > nnx - 1) fx = nnx - 1; if (fz > nnz - 1) fz = nnz - 1;
    var i0 = Math.floor(fx), j0 = Math.floor(fz);
    var i1 = Math.min(i0 + 1, nnx - 1), j1 = Math.min(j0 + 1, nnz - 1);
    var ax = fx - i0, az = fz - j0;
    var a = postValue(j0, i0), bb = postValue(j0, i1);
    var c = postValue(j1, i0), d = postValue(j1, i1);
    return a + (bb - a) * ax + (c - a) * az + (a - bb - c + d) * ax * az;
  }
  return {
    nx: nnx, nz: nnz, post_m: npost, dgrid: true,
    sampleElevM: sampleElevM,
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
  makePkgTerrainSampler: makePkgTerrainSampler,
  makeDGridSampler: makeDGridSampler
};
window.MapSystem = {
  /* Filled by map_loader.js when a package activates; null in legacy mode. */
  activePackage: null,
  packageActive: function(){ return !!window.MapSystem.activePackage; },
  packageModeRequested: _mapPackageMode,
  packageBaseOverride: _mapPackageBaseOverride,
  /* Phase F (2026-10-28): true only when at least one map is registered.
     With the registry empty after the map removal this was false and the
     boot seam answered with the NO MAP DATA state. Phase G (2026-10-30)
     registers Adamsville again (partial), so this is true once more. */
  anyMapInstalled: function(){
    for (var k in MAP_REGISTRY){ if (MAP_REGISTRY.hasOwnProperty(k)) return true; }
    return false;
  }
};
