/* ============================================================================
   MAP LOADER — Phase C of the Adamsville map programme (Joshua's GO,
   2026-10-28). Loads a Phase B data package (true metres, materials baked
   into every record), converts it ONCE into the game's runtime frame via
   map_registry.js (the single conversion point), and wires it into the
   running game:

     1. MATERIAL TRUTH — the converted geometry is registered with
        collision_material.js as the package provider, so the ONE movement
        gate (canMoveTo / getMaterialAt / surfaceYAt) answers from the
        package's baked materials: building footprint RINGS (not circles),
        road surfaces with real profiles, water bodies + streams, the rail
        corridor, and bridge decks as LEVELS (passable surface over a
        blocked under-space, level crossings at grade).
     2. GROUND — the package terrain grid becomes the material system's
        ground sampler while the package is active.
     3. RENDER — bridge decks and the rail corridor are drawn (deck slabs
        at deck height, track beds + rails along the authored centrelines).
     4. RAIL HANDOFF — window.PACKAGE_RAIL carries the converted MARTA /
        CSX centrelines; marta_system.js aligns its West Line path to the
        authored MARTA corridor while the package is active.
     5. GRAPH — the package roads' shared vertices are byte-exact (Phase B
        welds), so the loader builds a true vertex graph and offers
        directed spot-traces (the Phase B inheritance: routing honours
        shared vertices — verified in the Phase C harness).

   ACTIVATION (Phase D, 2026-10-28 — THE SWAP): the package is the
   default world for Adamsville. index.html's zone seam calls
   bootWorld() BEFORE the deferred queue reaches the world build: the
   package loads, converts, and is re-expressed as the legacy-shaped
   globals the whole game already consumes (ROAD_DATA / OSM_BUILDINGS /
   WATER inputs / heightAt's terrain), so renderer, traffic, GPS and
   every feature layer run on the redrawn map with no per-system
   changes. This module's own late activation (provider + deck/rail
   rendering + PACKAGE_RAIL) then runs on the SAME prebuilt package —
   one load, one conversion. Legacy stays one switch away
   (?mapsrc=legacy), and a package that cannot be fetched (classic-
   engine shell, offline) leaves the game exactly as it was — legacy
   loading is the structural fallback, never an error.

   This module is loadable under Node for the Phase C harness: every
   browser touchpoint (fetch, THREE, scene, Report) is guarded, and the
   data path (fetch -> convert -> build -> provider) runs headless.
   ============================================================================ */
(function(){
'use strict';

/* ============================ small geometry ============================ */
function distToSeg(px, pz, x1, z1, x2, z2){
  var vx = x2 - x1, vz = z2 - z1;
  var len2 = vx * vx + vz * vz;
  var t = len2 > 0 ? ((px - x1) * vx + (pz - z1) * vz) / len2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  var cx = x1 + vx * t, cz = z1 + vz * t;
  var dx = px - cx, dz = pz - cz;
  return { d: Math.sqrt(dx * dx + dz * dz), t: t, cx: cx, cz: cz };
}
function pointInRing(px, pz, ring){
  /* Ray-casting point-in-polygon over a [[x,z],...] ring. */
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++){
    var xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (((zi > pz) !== (zj > pz)) &&
        (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}
function ringEdgeDist(px, pz, ring){
  var best = 1e18;
  for (var i = 0; i < ring.length - 1; i++){
    var r = distToSeg(px, pz, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
    if (r.d < best) best = r.d;
  }
  return best;
}
/* A point guaranteed inside a (possibly concave) ring: scanline through
   the ring's own centroid height, midpoint of the first inside interval.
   Used for material-coverage sampling in the harness. */
function ringInteriorPoint(ring){
  var cx = 0, cz = 0, i;
  for (i = 0; i < ring.length; i++){ cx += ring[i][0]; cz += ring[i][1]; }
  cx /= ring.length; cz /= ring.length;
  if (pointInRing(cx, cz, ring)) return [cx, cz];
  var xs = [];
  for (i = 0; i < ring.length - 1; i++){
    var a = ring[i], b = ring[i + 1];
    if ((a[1] > cz) !== (b[1] > cz))
      xs.push(a[0] + (cz - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
  }
  xs.sort(function(p, q){ return p - q; });
  if (xs.length >= 2) return [(xs[0] + xs[1]) / 2, cz];
  return [ring[0][0], ring[0][1]];
}

/* Spatial hash (40u cells, the game's standard) over segment records. */
function segHash(cell){
  var h = {};
  function add(rec){
    var minX = Math.min(rec.x1, rec.x2) - rec.hw, maxX = Math.max(rec.x1, rec.x2) + rec.hw;
    var minZ = Math.min(rec.z1, rec.z2) - rec.hw, maxZ = Math.max(rec.z1, rec.z2) + rec.hw;
    for (var gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx++)
      for (var gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz++){
        var k = gx + ',' + gz;
        (h[k] = h[k] || []).push(rec);
      }
  }
  function near(x, z){
    var gx = Math.floor(x / cell), gz = Math.floor(z / cell), out = [], seen = {};
    for (var ix = gx - 1; ix <= gx + 1; ix++)
      for (var iz = gz - 1; iz <= gz + 1; iz++){
        var c = h[ix + ',' + iz]; if (!c) continue;
        for (var i = 0; i < c.length; i++)
          if (!seen[c[i]._uid]){ seen[c[i]._uid] = 1; out.push(c[i]); }
      }
    return out;
  }
  return { add: add, near: near };
}
var _uidSeq = 1;

/* ============================ fetch helpers ============================= */
function fetchJSON(url){
  return fetch(url, { cache: 'no-store' }).then(function(r){
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r.json();
  });
}
function fetchBin(url){
  return fetch(url, { cache: 'no-store' }).then(function(r){
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r.arrayBuffer();
  });
}
function note(msg, extra){
  try { console.log('[map-loader] ' + msg); } catch(e){}
  try {
    if (typeof Report !== 'undefined' && Report.setSys)
      Report.setSys('mapsystem', { note: msg, extra: extra || null });
  } catch(e){}
}

/* ============================ package build ============================= */
/* buildPackage(raw, meta) — raw = {zone, roads, buildings, water, rail,
   structures, places, pins, signs, terrain: Float32Array}. Converts every
   coordinate through MapFrame.pkgToRuntime (THE conversion) and every
   elevation through MapFrame.elevToRuntimeY. Pure data in, pure data out —
   this is the function the Phase C harness exercises headless. */
function buildPackage(raw){
  var F = window.MapFrame;
  function P(pt){ var r = F.pkgToRuntime(pt[0], pt[1]); return [r.x, r.z]; }
  function ring(pts){ return pts.map(P); }
  function Y(m){ return F.elevToRuntimeY(m); }

  var pkg = { id: raw.zone.id, name: raw.zone.name, zone: raw.zone,
              spawn: F.pkgToRuntime(0, 0) };

  /* The terrain sampler is built FIRST (before the roads below) so a
     road whose authored profile stops short of its last points can be
     completed from the ground itself — see the profile repair in the
     roads conversion. */
  var terrainSampler = F.makePkgTerrainSampler(raw.zone, raw.terrain);

  /* --- roads: pts + per-point profile -> runtime pts + ys; arc lengths --- */
  pkg.roads = raw.roads.records.map(function(r){
    var pts = ring(r.pts);
    var ys = (r.profile || []).map(Y);
    /* PROFILE REPAIR (Phase D): 4 of 8,579 Phase B records carry a
       profile 1-3 entries shorter than their point list (the profile
       stops before the tail points). A short ys would drop the record
       off the renderer's baked path and onto legacy re-derivation.
       The missing tail heights are sampled from the package terrain —
       the same ground the profile itself follows — except on deck
       records, where the last authored height extends instead (a deck
       tail must never be pulled to the ground). Over-long profiles
       truncate. Authored values are never altered. */
    if (ys.length !== pts.length){
      if (ys.length > pts.length) ys.length = pts.length;
      var onDeck = (r.deck_structs || []).length > 0;
      while (ys.length < pts.length){
        var ti = ys.length;
        if (onDeck || !terrainSampler) ys.push(ys[ys.length - 1] || 0);
        else {
          var e = terrainSampler.sampleElevM(r.pts[ti][0], r.pts[ti][1]);
          ys.push(e === null ? (ys[ys.length - 1] || 0) : Y(e));
        }
      }
    }
    var cum = [0];
    for (var i = 1; i < pts.length; i++){
      var dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1];
      cum.push(cum[i - 1] + Math.sqrt(dx * dx + dz * dz));
    }
    return { id: r.id, name: r.name, cls: r.class, pts: pts, ys: ys, cum: cum,
             len: cum[cum.length - 1], lanes: r.lanes, width_m: r.width_m,
             ramp: !!r.ramp, deckStructs: r.deck_structs || [],
             material: r.material };
  });

  /* --- buildings: real footprint rings (collision truth), centroid, height --- */
  pkg.buildings = raw.buildings.records.map(function(b){
    var rg = ring(b.ring);
    var c = b.centroid ? P(b.centroid) : ringInteriorPoint(rg);
    var rr = 0;
    for (var i = 0; i < rg.length; i++){
      var dx = rg[i][0] - c[0], dz = rg[i][1] - c[1];
      var d = Math.sqrt(dx * dx + dz * dz); if (d > rr) rr = d;
    }
    return { id: b.id, name: b.name, use: b.use, ring: rg, centroid: c,
             r: rr, height_m: b.height_m, groundY: Y(b.ground_elev_m || 0),
             material: b.material };
  });

  /* --- water: bodies (rings) + streams (centrelines) --- */
  pkg.waterBodies = []; pkg.waterStreams = [];
  raw.water.records.forEach(function(w){
    if (w.kind === 'body')
      pkg.waterBodies.push({ id: w.id, name: w.name, ring: ring(w.ring),
                             surfaceY: (typeof w.surface_m === 'number') ? Y(w.surface_m) : null,
                             material: w.material });
    else
      pkg.waterStreams.push({ id: w.id, name: w.name, pts: ring(w.pts),
                              halfW: 3.0, material: w.material });
  });

  /* --- rail: centrelines with profiles; layer: -1 under, 0 grade, 1 over --- */
  pkg.rail = raw.rail.records.map(function(r){
    return { id: r.id, name: r.name, operator: r.operator, kind: r.kind,
             tracks: r.tracks || 1, layer: r.layer || 0, pts: ring(r.pts),
             ys: (r.profile || []).map(Y), structures: r.structures || [],
             material: r.material };
  });

  /* --- structures: level structures (deck/bridge/viaduct) carry a span
     polygon + deck/under elevations; level crossings are at-grade polys;
     airport pavement kinds are ground surfaces (converted, no level). --- */
  pkg.decks = []; pkg.levelCrossings = []; pkg.groundStructures = [];
  raw.structures.records.forEach(function(s){
    if (s.kind === 'level_crossing'){
      pkg.levelCrossings.push({ id: s.id, name: s.name, poly: ring(s.span_poly),
                                material: s.material });
    } else if (s.kind === 'deck' || s.kind === 'bridge' || s.kind === 'viaduct'){
      pkg.decks.push({ id: s.id, kind: s.kind, name: s.name, over: s.over,
                       under: s.under, poly: ring(s.span_poly),
                       deckY: Y(s.deck_elev_m), underY: Y(s.under_elev_m),
                       surfaceMat: s.surface_material, underMat: s.under_material,
                       material: s.material });
    } else if (s.span_poly){
      pkg.groundStructures.push({ id: s.id, kind: s.kind, name: s.name,
                                  poly: ring(s.span_poly), material: s.material });
    } else if (s.pts){
      /* Centreline pavement (the FTY runway, taxilanes): carries its
         authored width + elevation profile so the renderer can draw
         the strip at its real width on its real grade (Phase D). */
      pkg.groundStructures.push({ id: s.id, kind: s.kind, name: s.name,
                                  pts: ring(s.pts),
                                  width_m: (typeof s.width_m === 'number') ? s.width_m : null,
                                  ys: (s.profile || []).map(Y),
                                  material: s.material });
    }
  });

  /* --- places / pins / signs: converted points (+ rings where authored) --- */
  function convPointRec(r){
    var o = { id: r.id, kind: r.kind, name: r.name, material: r.material };
    if (r.at) o.at = P(r.at);
    if (r.ring) o.ring = ring(r.ring);
    return o;
  }
  pkg.places = raw.places.records.map(convPointRec);
  pkg.pins = raw.pins.records.map(convPointRec);
  pkg.signs = raw.signs.records.map(convPointRec);

  /* --- runtime-frame extent of the package. The minimap / full map
     scope themselves to this in package mode (Joshua 2026-10-28:
     the map must not zoom out past the active map or pan into the
     old world's empty space). bounds_m corners through THE
     conversion — the frame map is affine, so the corner bbox is
     exact. Fallback: the roads' own bbox, if a package ever ships
     without bounds_m. --- */
  pkg.boundsRuntime = (function(){
    var pts = [];
    var bm = raw.zone && raw.zone.bounds_m;
    if (bm && isFinite(bm.xMin) && isFinite(bm.xMax) &&
        isFinite(bm.zMin) && isFinite(bm.zMax)){
      pts = [F.pkgToRuntime(bm.xMin, bm.zMin), F.pkgToRuntime(bm.xMin, bm.zMax),
             F.pkgToRuntime(bm.xMax, bm.zMin), F.pkgToRuntime(bm.xMax, bm.zMax)];
    } else {
      pkg.roads.forEach(function(r){ pts = pts.concat(r.pts); });
    }
    if (!pts.length) return null;
    var x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
    pts.forEach(function(p){
      var px = (p.x !== undefined) ? p.x : p[0];
      var pz = (p.z !== undefined) ? p.z : p[1];
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
    });
    return { x0: x0, x1: x1, z0: z0, z1: z1 };
  })();

  /* --- terrain (sampler built at the top of this function) --- */
  pkg.terrain = terrainSampler;

  /* --- welded vertex graph over PACKAGE coords (welds are byte-exact in
     the package data, so exact keys are the truth; conversion happens only
     for display of the endpoints). Adjacency: vertexKey -> [{to, road}] --- */
  var graph = {};
  function vkey(pt){ return pt[0].toFixed(2) + ',' + pt[1].toFixed(2); }
  raw.roads.records.forEach(function(r){
    for (var i = 1; i < r.pts.length; i++){
      var a = vkey(r.pts[i - 1]), b = vkey(r.pts[i]);
      (graph[a] = graph[a] || []).push({ to: b, road: r.id, cls: r.class });
      (graph[b] = graph[b] || []).push({ to: a, road: r.id, cls: r.class });
    }
  });
  pkg.graph = graph;
  pkg.vkey = vkey;
  /* trace(fromPkgPt, toPkgPt, classSet) — BFS over shared vertices.
     Returns {found, hops, roads:[ids]} — the routing-honours-vertices
     spot check (Phase B inheritance #6). */
  pkg.trace = function(fromPt, toPt, classSet){
    var start = vkey(fromPt), goal = vkey(toPt);
    if (start === goal) return { found: true, hops: 0, roads: [] };
    var prev = {}, q = [start]; prev[start] = null;
    while (q.length){
      var cur = q.shift();
      var edges = graph[cur] || [];
      for (var i = 0; i < edges.length; i++){
        var e = edges[i];
        if (classSet && !classSet[e.cls]) continue;
        if (prev[e.to] !== undefined) continue;
        prev[e.to] = { from: cur, road: e.road };
        if (e.to === goal){
          var roads = [], n = goal;
          while (prev[n]){ roads.unshift(prev[n].road); n = prev[n].from; }
          return { found: true, hops: roads.length, roads: roads };
        }
        q.push(e.to);
      }
    }
    return { found: false, hops: -1, roads: [] };
  };

  /* --- collision provider structures (runtime frame) --- */
  var prov = buildProvider(pkg);
  pkg.provider = prov;
  return pkg;
}

/* ==================== collision provider (runtime) ====================== */
/* The provider owns ALL package-geometry material queries. collision_
   material.js consults it (when a package is active) before its legacy
   probes. Materials come from the records' baked classes — no per-object
   registration exists to forget (Joshua's doctrine). */
function buildProvider(pkg){
  var MAT = (typeof COLLISION_MATERIALS !== 'undefined')
    ? COLLISION_MATERIALS
    : { NONE: 0, SOLID: 1, ROAD: 2, WATER: 3, DOOR: 4, GRASS: 5, PERSON: 6 };
  function matByName(n){
    if (n === 'ROAD') return MAT.ROAD;
    if (n === 'WATER') return MAT.WATER;
    if (n === 'SOLID') return MAT.SOLID;
    if (n === 'GRASS') return MAT.GRASS;
    return MAT.SOLID;   /* RAIL and anything structural block ground movers */
  }

  /* segment hashes */
  var roadHash = segHash(40), railHash = segHash(40);
  pkg.roads.forEach(function(r){
    var hw = Math.max(1.5, (r.width_m || 7.3) / 2);
    for (var i = 1; i < r.pts.length; i++){
      roadHash.add({ _uid: _uidSeq++, x1: r.pts[i - 1][0], z1: r.pts[i - 1][1],
                     x2: r.pts[i][0], z2: r.pts[i][1], hw: hw,
                     y1: r.ys[i - 1], y2: r.ys[i], road: r });
    }
  });
  pkg.rail.forEach(function(r){
    var hw = (r.tracks || 1) * 1.6 + 1.6;   /* corridor half width */
    for (var i = 1; i < r.pts.length; i++){
      railHash.add({ _uid: _uidSeq++, x1: r.pts[i - 1][0], z1: r.pts[i - 1][1],
                     x2: r.pts[i][0], z2: r.pts[i][1], hw: hw, layer: r.layer,
                     y1: r.ys[i - 1], y2: r.ys[i], rail: r });
    }
  });
  /* building rings hashed by centroid cell; the scan span derives from
     the largest ring in the package, so even a mall- or campus-scale
     footprint is found from any point inside it */
  var bldgHash = {}, maxBldgR = 0;
  pkg.buildings.forEach(function(b){
    if (b.r > maxBldgR) maxBldgR = b.r;
    var k = Math.floor(b.centroid[0] / 40) + ',' + Math.floor(b.centroid[1] / 40);
    (bldgHash[k] = bldgHash[k] || []).push(b);
  });
  var bldgSpan = Math.max(1, Math.ceil((maxBldgR + 5) / 40));
  function buildingsNear(x, z){
    var gx = Math.floor(x / 40), gz = Math.floor(z / 40), out = [];
    for (var ix = gx - bldgSpan; ix <= gx + bldgSpan; ix++)
      for (var iz = gz - bldgSpan; iz <= gz + bldgSpan; iz++){
        var c = bldgHash[ix + ',' + iz]; if (!c) continue;
        for (var i = 0; i < c.length; i++){
          var b = c[i];
          var dx = x - b.centroid[0], dz = z - b.centroid[1];
          if (dx * dx + dz * dz < (b.r + 5) * (b.r + 5)) out.push(b);
        }
      }
    return out;
  }

  function onRoad(x, z){
    var segs = roadHash.near(x, z);
    for (var i = 0; i < segs.length; i++){
      var s = segs[i];
      if (distToSeg(x, z, s.x1, s.z1, s.x2, s.z2).d <= s.hw) return s;
    }
    return null;
  }
  function inWater(x, z){
    var i, s;
    for (i = 0; i < pkg.waterBodies.length; i++)
      if (pointInRing(x, z, pkg.waterBodies[i].ring)) return true;
    for (i = 0; i < pkg.waterStreams.length; i++){
      var w = pkg.waterStreams[i];
      for (var j = 1; j < w.pts.length; j++){
        s = distToSeg(x, z, w.pts[j - 1][0], w.pts[j - 1][1], w.pts[j][0], w.pts[j][1]);
        if (s.d <= w.halfW) return true;
      }
    }
    return false;
  }
  function inBuilding(x, z){
    var bs = buildingsNear(x, z);
    for (var i = 0; i < bs.length; i++)
      if (pointInRing(x, z, bs[i].ring)) return bs[i];
    return null;
  }
  function railHit(x, z){
    var segs = railHash.near(x, z);
    for (var i = 0; i < segs.length; i++){
      var s = segs[i];
      if (distToSeg(x, z, s.x1, s.z1, s.x2, s.z2).d <= s.hw) return s;
    }
    return null;
  }
  function inCrossing(x, z){
    for (var i = 0; i < pkg.levelCrossings.length; i++)
      if (pointInRing(x, z, pkg.levelCrossings[i].poly)) return pkg.levelCrossings[i];
    return null;
  }
  function deckAt(x, z){
    for (var i = 0; i < pkg.decks.length; i++)
      if (pointInRing(x, z, pkg.decks[i].poly)) return pkg.decks[i];
    return null;
  }

  /* Ground-level material from package data, or null when the package
     has nothing to say (caller falls through to legacy probes — props,
     doors, people are not package data). LEVEL-BLIND by design: decks
     and elevated rail are level structures and only materialAtLevel
     may speak for them — an elevated line must never poison the ground
     beneath it (a road under the MARTA viaduct is a road; a creek
     under a bridge is water). Ground truth, in order:
       road surface > building ring > water > at-grade rail corridor.
     Roads outrank buildings: service roads and drive-through canopies
     overlap footprints in the source data, and the travelled surface
     is the truth a mover meets; off-road ring interiors stay SOLID. */
  function materialAt(x, z){
    if (onRoad(x, z)) return MAT.ROAD;
    if (inBuilding(x, z)) return MAT.SOLID;
    if (inWater(x, z)) return MAT.WATER;
    var rh = railHit(x, z);
    if (rh && !inCrossing(x, z) && (rh.layer | 0) === 0) return MAT.SOLID;
    return null;
  }
  /* railYAt(x, z): runtime Y of the nearest rail profile near (x, z). */
  function railYAt(x, z){
    var segs = railHash.near(x, z), best = null, bd = 1e18, bt = 0;
    for (var ci = 0; ci < segs.length; ci++){
      var e = segs[ci], r = distToSeg(x, z, e.x1, e.z1, e.x2, e.z2);
      if (r.d < bd){ bd = r.d; best = e; bt = r.t; }
    }
    if (!best || bd > best.hw + 2) return null;
    return best.y1 + (best.y2 - best.y1) * bt;
  }
  /* deckForLevel(x, z, levelY): the deck a mover at levelY stands on —
     among the spans containing the point, the one whose deck height is
     closest to the mover's level, and only when it is within the deck
     band. Stacked crossings (the MLK / I-285 decks) sit ~1 runtime
     unit apart in places, so a first-match or a wide band would claim
     the wrong surface: a road passing just under a rail viaduct reads
     that viaduct's surface. Deck road profiles equal deck_elev by
     construction (Phase B), so the band can stay tight. */
  var DECK_BAND = 0.75;
  function deckForLevel(x, z, levelY){
    if (typeof levelY !== 'number' || !isFinite(levelY)) return null;
    var best = null, bd = 1e18;
    for (var i = 0; i < pkg.decks.length; i++){
      var d = pkg.decks[i];
      if (!pointInRing(x, z, d.poly)) continue;
      var dd = Math.abs(levelY - d.deckY);
      if (dd < bd){ bd = dd; best = d; }
    }
    return (best && bd <= DECK_BAND) ? best : null;
  }
  /* roadYAt(x, z): interpolated profile Y of the nearest road segment
     whose surface covers (x, z), else null. */
  function roadYAt(x, z){
    var segs = roadHash.near(x, z), best = null, bd = 1e18;
    for (var i = 0; i < segs.length; i++){
      var s = segs[i], r = distToSeg(x, z, s.x1, s.z1, s.x2, s.z2);
      if (r.d <= s.hw + 1.5 && r.d < bd){ bd = r.d; best = s.y1 + (s.y2 - s.y1) * r.t; }
    }
    return best;
  }
  /* Level-aware material: the mover's current surface Y decides which
     side of a level structure it is on — a deck's surface at deck
     height, the rail corridor at its own height, else ground truth.
     NEAREST SURFACE WINS: where a road passes just under a deck (MLK
     under the MARTA station viaduct, ~0.5u of vertical air), a mover
     at the road's own profile height is on the road, not the deck —
     the deck only claims a mover whose level is nearer the deck than
     any road surface under it. (On a deck road the two coincide, so
     the deck claim stands.) */
  function materialAtLevel(x, z, levelY){
    if (typeof levelY === 'number' && isFinite(levelY)){
      var roadY = roadYAt(x, z);
      var deck = deckForLevel(x, z, levelY);
      if (deck){
        if (roadY === null || Math.abs(levelY - roadY) >= Math.abs(levelY - deck.deckY))
          return matByName(deck.surfaceMat);
      }
      /* the rail corridor claims its own height — except at grade
         crossings, where the road surface IS the crossing surface and
         is nearer the mover's level */
      var ry = railYAt(x, z);
      if (ry !== null && Math.abs(levelY - ry) <= 1.6 &&
          (roadY === null || Math.abs(levelY - ry) < Math.abs(levelY - roadY)))
        return MAT.SOLID;
    }
    return materialAt(x, z);
  }
  /* Rest surface Y at (x, z): deck surface when the mover is at deck
     level; otherwise the package road profile under the point (the
     candidate nearest the mover's level when stacked roads cross);
     null when no package surface applies. */
  function surfaceY(x, z, levelY){
    var deck = deckForLevel(x, z, levelY);
    var segs = roadHash.near(x, z), best = null, bestScore = 1e18;
    for (var i = 0; i < segs.length; i++){
      var s = segs[i];
      var r = distToSeg(x, z, s.x1, s.z1, s.x2, s.z2);
      if (r.d > s.hw + 1.5) continue;
      var y = s.y1 + (s.y2 - s.y1) * r.t;
      var score = (typeof levelY === 'number' && isFinite(levelY))
        ? Math.abs(y - levelY) : -y;   /* no level hint: lowest surface */
      if (score < bestScore){ bestScore = score; best = y; }
    }
    /* nearest surface wins, as in materialAtLevel: a road passing just
       under the deck keeps its own surface */
    if (deck && (best === null || Math.abs(deck.deckY - levelY) <= bestScore))
      return deck.deckY;
    return best;
  }
  /* Push-out for package building rings (used by CollisionMaterial.
     pushOut): if p is inside a ring or within radius of its edge, push
     to the nearest edge point + radius. Returns true if it moved p. */
  function pushOutRings(p, radius){
    var bs = buildingsNear(p.x, p.z), moved = false;
    for (var i = 0; i < bs.length; i++){
      var ring = bs[i].ring;
      var inside = pointInRing(p.x, p.z, ring);
      var ed = ringEdgeDist(p.x, p.z, ring);
      if (!inside && ed >= radius) continue;
      /* nearest edge point */
      var bestD = 1e18, bx = 0, bz = 0;
      for (var j = 0; j < ring.length - 1; j++){
        var r = distToSeg(p.x, p.z, ring[j][0], ring[j][1], ring[j + 1][0], ring[j + 1][1]);
        if (r.d < bestD){ bestD = r.d; bx = r.cx; bz = r.cz; }
      }
      var dx = p.x - bx, dz = p.z - bz, d = Math.sqrt(dx * dx + dz * dz);
      if (inside){
        /* Eject through the nearest edge: (dx, dz) points from the edge
           INTO the building, so the exit is the edge point MINUS that
           direction, one radius beyond the wall. */
        if (d > 0.001){ p.x = bx - dx / d * radius; p.z = bz - dz / d * radius; }
        else { p.x = bx + radius; }
        moved = true;
      } else if (d > 0.001 && d < radius){
        var push = (radius - d) / d;
        p.x += dx * push; p.z += dz * push; moved = true;
      }
    }
    return moved;
  }

  return { materialAt: materialAt, materialAtLevel: materialAtLevel,
           surfaceY: surfaceY, pushOutRings: pushOutRings,
           onRoad: onRoad, inWater: inWater, inBuilding: inBuilding,
           railHit: railHit, railYAt: railYAt, deckAt: deckAt, _pkg: pkg };
}

/* ============================ rendering ================================= */
/* Deck slabs + rail corridor meshes. Only in the browser build with a
   live scene; purely visual (collision truth is the provider above). */
function buildRenderGroup(pkg){
  if (typeof THREE === 'undefined' || typeof scene === 'undefined' || !scene)
    return null;
  var g = new THREE.Group();
  g.name = 'packageRender_' + pkg.id;
  /* decks: a flat slab whose top is the deck surface */
  var deckMat = new THREE.MeshLambertMaterial({ color: 0x8b8f94 });
  var edgeMat = new THREE.MeshLambertMaterial({ color: 0x5d6066 });
  pkg.decks.forEach(function(d){
    try {
      var shape = new THREE.Shape();
      d.poly.forEach(function(pt, i){
        if (i === 0) shape.moveTo(pt[0], -pt[1]); else shape.lineTo(pt[0], -pt[1]);
      });
      var geo = new THREE.ExtrudeGeometry(shape, { depth: 0.6, bevelEnabled: false });
      var mesh = new THREE.Mesh(geo, d.surfaceMat === 'RAIL' ? edgeMat : deckMat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = d.deckY - 0.6;
      g.add(mesh);
    } catch(e){}
  });
  /* rail: bed ribbon + steel rails along each centreline */
  var bedMat = new THREE.MeshLambertMaterial({ color: 0x4a4238 });
  var railMat = new THREE.LineBasicMaterial({ color: 0xb9c0c7 });
  pkg.rail.forEach(function(r){
    try {
      var w = (r.tracks || 1) * 1.6 + 1.6;
      var pos = [];
      for (var i = 1; i < r.pts.length; i++){
        var a = r.pts[i - 1], b = r.pts[i];
        var dx = b[0] - a[0], dz = b[1] - a[1];
        var len = Math.sqrt(dx * dx + dz * dz) || 1;
        var nx = -dz / len * w, nz = dx / len * w;
        var ya = (r.ys[i - 1] || 0) + 0.07, yb = (r.ys[i] || 0) + 0.07;
        pos.push(a[0] + nx, ya, a[1] + nz, a[0] - nx, ya, a[1] - nz, b[0] - nx, yb, b[1] - nz);
        pos.push(a[0] + nx, ya, a[1] + nz, b[0] - nx, yb, b[1] - nz, b[0] + nx, yb, b[1] + nz);
      }
      var bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      var bed = new THREE.Mesh(bg, bedMat);
      bed.frustumCulled = false;
      g.add(bed);
      var lp = [];
      for (var j = 1; j < r.pts.length; j++){
        var a2 = r.pts[j - 1], b2 = r.pts[j];
        var dx2 = b2[0] - a2[0], dz2 = b2[1] - a2[1];
        var len2 = Math.sqrt(dx2 * dx2 + dz2 * dz2) || 1;
        var ox = -dz2 / len2 * 0.75, oz = dx2 / len2 * 0.75;
        var ya2 = (r.ys[j - 1] || 0) + 0.16, yb2 = (r.ys[j] || 0) + 0.16;
        lp.push(a2[0] + ox, ya2, a2[1] + oz, b2[0] + ox, yb2, b2[1] + oz);
        lp.push(a2[0] - ox, ya2, a2[1] - oz, b2[0] - ox, yb2, b2[1] - oz);
      }
      var lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
      var rails = new THREE.LineSegments(lg, railMat);
      rails.frustumCulled = false;
      g.add(rails);
    } catch(e){}
  });
  /* ground structures (Phase D): the airport pavement the Phase C
     renderer skipped — aprons/taxiways as flat shapes seated on the
     terrain, the runway + taxilanes as width-true strips on their
     authored elevation profiles. Purely visual: movers meet this
     ground through the terrain and road surfaces, as before. */
  var paveMat = new THREE.MeshLambertMaterial({ color: 0x74777c });
  var closedMat = new THREE.MeshLambertMaterial({ color: 0x55524a });
  pkg.groundStructures.forEach(function(s){
    try {
      if (s.poly && s.poly.length >= 3){
        var cx = 0, cz = 0, i;
        for (i = 0; i < s.poly.length; i++){ cx += s.poly[i][0]; cz += s.poly[i][1]; }
        cx /= s.poly.length; cz /= s.poly.length;
        var gy = pkg.terrain.heightYAtRuntime(cx, cz);
        var shp = new THREE.Shape();
        s.poly.forEach(function(pt, j){
          if (j === 0) shp.moveTo(pt[0], -pt[1]); else shp.lineTo(pt[0], -pt[1]);
        });
        var gm = new THREE.Mesh(new THREE.ShapeGeometry(shp),
                                s.kind === 'runway_closed' ? closedMat : paveMat);
        gm.rotation.x = -Math.PI / 2;
        gm.position.y = (gy === null ? 0 : gy) + 0.06;
        g.add(gm);
      } else if (s.pts && s.pts.length >= 2){
        var hw = ((s.width_m || 10) * window.MapFrame.S) / 2;
        var pos = [];
        for (var i2 = 1; i2 < s.pts.length; i2++){
          var a = s.pts[i2 - 1], b = s.pts[i2];
          var dx = b[0] - a[0], dz = b[1] - a[1];
          var len = Math.sqrt(dx * dx + dz * dz) || 1;
          var nx = -dz / len * hw, nz = dx / len * hw;
          var ya = (typeof s.ys[i2 - 1] === 'number') ? s.ys[i2 - 1] + 0.06
                   : (pkg.terrain.heightYAtRuntime(a[0], a[1]) || 0) + 0.06;
          var yb = (typeof s.ys[i2] === 'number') ? s.ys[i2] + 0.06
                   : (pkg.terrain.heightYAtRuntime(b[0], b[1]) || 0) + 0.06;
          pos.push(a[0] + nx, ya, a[1] + nz, a[0] - nx, ya, a[1] - nz, b[0] - nx, yb, b[1] - nz);
          pos.push(a[0] + nx, ya, a[1] + nz, b[0] - nx, yb, b[1] - nz, b[0] + nx, yb, b[1] + nz);
        }
        var bg2 = new THREE.BufferGeometry();
        bg2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        var strip = new THREE.Mesh(bg2, s.kind === 'runway_closed' ? closedMat : paveMat);
        strip.frustumCulled = false;
        g.add(strip);
      }
    } catch(e){}
  });
  scene.add(g);
  return g;
}

/* ================== legacy-shaped world (Phase D) ===================== */
/* The world build (renderer, traffic, GPS, feature layers) consumes
   legacy-shaped globals. Rather than rewriting any of them for the
   swap, the converted package is RE-EXPRESSED in those shapes here —
   one adapter, next to the one conversion. Shapes:
     ROAD_DATA      {cat: [{name, pts, ys, ramp?}]} — records carrying
                    ys take buildRoads' BAKED path (stored profile, no
                    re-derivation), and the roadDrawData built from
                    them feeds traffic + GPS unchanged.
     OSM_BUILDINGS  [[x, z, w, d, h, type], ...] — each building's real
                    ring reduced to its minimum-area oriented rectangle
                    (centre + side lengths); h is the package height,
                    carried in the same units the legacy records used
                    (their height distributions match — same source).
                    Collision truth stays the provider's real rings;
                    this shape is the render/placement form, exactly
                    the role it plays in legacy mode.
     __PKG_WATER    {bodies: [{x, z, rx, rz, ring, surfaceY, depthFt,
                    name}], streams: [{pts, name}]} for buildWater's
                    package branch in index.html.
   Category mapping follows the renderer's own table (ROAD_WIDTHS /
   the INTERSTATES name rule in index.html): freeways land in
   'highway' so I-20 / I-285 records pick up the interstate width by
   name; arterials land in 'major_artery', the legacy big-street
   bucket. */
var PKG_ROAD_CAT = { motorway: 'highway', motorway_link: 'highway',
                     arterial: 'major_artery', local: 'local',
                     service: 'local' };
/* Building type codes per index.html's osmBuildings: 0 house,
   1 commercial, 2 apartment/large, 3 other. */
var PKG_BLDG_TYPE = { house: 0, yes: 0, retail: 1, commercial: 1,
                      apartments: 2 };
function minAreaRect(ring){
  /* Minimum-area oriented rectangle over a ring (each edge direction
     tried as a candidate axis — rings are small). Returns
     {cx, cz, w, d} in the ring's own coordinates. */
  var best = null, i, j;
  for (i = 0; i < ring.length - 1; i++){
    var ex = ring[i + 1][0] - ring[i][0], ez = ring[i + 1][1] - ring[i][1];
    var el = Math.sqrt(ex * ex + ez * ez);
    if (el < 1e-9) continue;
    var ux = ex / el, uz = ez / el, vx = -uz, vz = ux;
    var mnU = 1e18, mxU = -1e18, mnV = 1e18, mxV = -1e18;
    for (j = 0; j < ring.length; j++){
      var pu = ring[j][0] * ux + ring[j][1] * uz;
      var pv = ring[j][0] * vx + ring[j][1] * vz;
      if (pu < mnU) mnU = pu; if (pu > mxU) mxU = pu;
      if (pv < mnV) mnV = pv; if (pv > mxV) mxV = pv;
    }
    var area = (mxU - mnU) * (mxV - mnV);
    if (!best || area < best.area){
      var cu = (mnU + mxU) / 2, cvv = (mnV + mxV) / 2;
      best = { area: area, cx: cu * ux + cvv * vx, cz: cu * uz + cvv * vz,
               w: mxU - mnU, d: mxV - mnV };
    }
  }
  if (!best){ /* degenerate ring: fall back to the plain bbox */
    var mnx = 1e18, mxx = -1e18, mnz = 1e18, mxz = -1e18;
    for (i = 0; i < ring.length; i++){
      if (ring[i][0] < mnx) mnx = ring[i][0]; if (ring[i][0] > mxx) mxx = ring[i][0];
      if (ring[i][1] < mnz) mnz = ring[i][1]; if (ring[i][1] > mxz) mxz = ring[i][1];
    }
    best = { cx: (mnx + mxx) / 2, cz: (mnz + mxz) / 2, w: mxx - mnx, d: mxz - mnz };
  }
  return best;
}
function buildLegacyGlobals(pkg){
  var roadData = { highway: [], major_artery: [], minor_artery: [], local: [] };
  pkg.roads.forEach(function(r){
    var cat = PKG_ROAD_CAT[r.cls] || 'local';
    var rec = { name: r.name || 'Unnamed St', pts: r.pts, ys: r.ys };
    if (r.ramp) rec.ramp = true;
    roadData[cat].push(rec);
  });
  var buildings = pkg.buildings.map(function(b){
    var rect = minAreaRect(b.ring);
    var t = PKG_BLDG_TYPE[b.use];
    return [rect.cx, rect.cz, Math.max(1, rect.w), Math.max(1, rect.d),
            (typeof b.height_m === 'number' && b.height_m > 0) ? b.height_m : 4.5,
            (t === undefined) ? 3 : t];
  });
  var water = { bodies: [], streams: [] };
  pkg.waterBodies.forEach(function(w){
    var mnx = 1e18, mxx = -1e18, mnz = 1e18, mxz = -1e18, i;
    for (i = 0; i < w.ring.length; i++){
      if (w.ring[i][0] < mnx) mnx = w.ring[i][0]; if (w.ring[i][0] > mxx) mxx = w.ring[i][0];
      if (w.ring[i][1] < mnz) mnz = w.ring[i][1]; if (w.ring[i][1] > mxz) mxz = w.ring[i][1];
    }
    var cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2;
    /* Depth from the data: surveyed surface minus the carved bed at
       the body's centre, in feet (the game's U_PER_FT = 0.304). */
    var depthFt = 8;
    if (typeof w.surfaceY === 'number'){
      var bed = pkg.terrain.heightYAtRuntime(cx, cz);
      if (typeof bed === 'number')
        depthFt = Math.max(2, Math.min(40, (w.surfaceY - bed) / 0.304));
    }
    water.bodies.push({ x: cx, z: cz, rx: (mxx - mnx) / 2, rz: (mxz - mnz) / 2,
                        ring: w.ring, surfaceY: w.surfaceY, depthFt: depthFt,
                        name: w.name });
  });
  pkg.waterStreams.forEach(function(s){
    water.streams.push({ pts: s.pts, name: s.name });
  });
  return { roadData: roadData, buildings: buildings, water: water };
}

/* bootWorld() — the Phase D seam entry, called by index.html's zone
   seam BEFORE the deferred queue continues to the world build. Loads
   the package, re-expresses it as the legacy-shaped globals (stashed
   on window.__PKG_* for the seam to install), makes the package
   terrain heightAt's source and the terrain mesh's precompute, and
   resolves true. ANY failure resolves false and the seam falls back
   to the legacy zone files — the swap fails safe, never strands the
   boot. The loaded package is kept (__PKG_PREBUILT) so the late
   activation below runs on the SAME load and conversion. */
var _bootWorldPromise = null;
function bootWorld(){
  if (_bootWorldPromise) return _bootWorldPromise;
  _bootWorldPromise = loadPackage(window.MapRegistry.defaultMapId,
                                  window.MapSystem.packageBaseOverride())
    .then(function(pkg){
      window.__PKG_PREBUILT = pkg;
      var g = buildLegacyGlobals(pkg);
      window.__PKG_ROAD_DATA = g.roadData;
      window.__PKG_BUILDINGS = g.buildings;
      window.__PKG_BLDG_COUNT = g.buildings.length;
      window.__PKG_WATER = g.water;
      window.__PKG_HEIGHT_AT = pkg.terrain.heightYAtRuntime;
      window.__PKG_WORLD = true;
      /* Zone identity for the systems that read __ZONE_META (report
         routing, crash logs, road sync's converted marker): the legacy
         zone.json is not fetched in package mode, so publish the
         package's identity in its place. Bounds stay on zoneloader's
         literal table, which the package bounds match exactly. */
      window.__ZONE_META = { id: pkg.id, converted: true, source: 'package' };
      note('package world ready: ' + pkg.id + ' — adapter globals built (' +
           g.buildings.length + ' buildings)');
      /* The terrain mesh's precompute for the package heights, in the
         identical vertex order the legacy bin uses (600x800 segments,
         481,401 values). A miss is not fatal: __TERR_H_PRE = null makes
         buildTerrain compute the mesh from heightAt — the same
         package terrain through the hook, just slower. */
      return fetchBin(pkg.base + 'terrain_heights_600x800.bin')
        .then(function(buf){
          var arr = new Float32Array(buf);
          window.__TERR_H_PRE = (arr.length === 481401) ? arr : null;
          return true;
        })
        .catch(function(){ window.__TERR_H_PRE = null; return true; });
    })
    .catch(function(err){
      note('package world boot failed (' + err.message + ') — legacy zone data serves');
      return false;
    });
  return _bootWorldPromise;
}

/* ============================ load + activate =========================== */
function loadPackage(mapId, baseOverride){
  var entry = window.MapRegistry.get(mapId);
  if (!entry) return Promise.reject(new Error('unknown map ' + mapId));
  var base = baseOverride || entry.packageBase;
  if (!/\/$/.test(base)) base += '/';
  return Promise.all([
    fetchJSON(base + 'zone.json'), fetchJSON(base + 'roads.json'),
    fetchJSON(base + 'buildings.json'), fetchJSON(base + 'water.json'),
    fetchJSON(base + 'rail.json'), fetchJSON(base + 'structures.json'),
    fetchJSON(base + 'places.json'), fetchJSON(base + 'pins.json'),
    fetchJSON(base + 'signs.json'), fetchBin(base + 'terrain.bin')
  ]).then(function(parts){
    var raw = { zone: parts[0], roads: parts[1], buildings: parts[2],
                water: parts[3], rail: parts[4], structures: parts[5],
                places: parts[6], pins: parts[7], signs: parts[8],
                terrain: new Float32Array(parts[9]) };
    var pkg = buildPackage(raw);
    pkg.base = base;
    return pkg;
  });
}

function activatePackage(pkg){
  if (pkg._activated) return pkg;   /* one package, one activation */
  pkg._activated = true;
  /* 1+2. material truth + ground sampler into the ONE gate */
  try {
    if (typeof CollisionMaterial !== 'undefined' && CollisionMaterial.setPackageProvider)
      CollisionMaterial.setPackageProvider(pkg.provider);
    if (typeof CollisionMaterial !== 'undefined' && CollisionMaterial.setGroundSampler)
      CollisionMaterial.setGroundSampler(pkg.terrain.heightYAtRuntime);
  } catch(e){ note('provider registration failed: ' + e.message); }
  /* 3. render decks + rail */
  try { pkg.renderGroup = buildRenderGroup(pkg); } catch(e){}
  /* 4. rail handoff for marta_system (converted centrelines) */
  try {
    var marta = null, csx = [];
    pkg.rail.forEach(function(r){
      if (/MARTA/.test(r.operator || '') || /MARTA/.test(r.name || '')) marta = r;
      else csx.push(r);
    });
    window.PACKAGE_RAIL = { marta: marta, csx: csx, all: pkg.rail, pkg: pkg };
  } catch(e){}
  /* 5. proven signals handoff (2026-10-28 audit fix): the package's
     surveyed traffic signals (pkg.signs, kind 'signal') as a named
     surface. buildPackage's convPointRec already converted these
     points to RUNTIME coordinates (the same conversion the package
     places and rail carry) — they are published as-is, never
     converted twice. index.html's street-furniture pass reads the
     same records off the prebuilt package at world-build time (it
     runs before activation in the boot order) and places its traffic
     lights from them in package mode — see streetFurniture there. */
  try {
    window.PACKAGE_SIGNALS = pkg.signs.filter(function(s){ return s.kind === 'signal' && s.at; })
      .map(function(s){
        return { id: s.id || null, name: s.name || 'signal', kind: 'signal',
                 x: s.at[0], z: s.at[1], at: [s.at[0], s.at[1]] };
      });
  } catch(e){}
  window.PACKAGE_MAP = pkg;
  window.MapSystem.activePackage = pkg;
  note('package ACTIVE: ' + pkg.id + ' — ' + pkg.roads.length + ' roads, ' +
       pkg.buildings.length + ' buildings, ' + pkg.decks.length + ' decks, ' +
       pkg.rail.length + ' rail records (base ' + pkg.base + ')');
  return pkg;
}

/* ===================== activation driver (2026-10-28 audit fix) =====
   THE DEFECT THIS REPLACES: tryBootPackage used to fire ONCE, 50 ms
   after DOMContentLoaded. The seam stamps __PKG_SEAM_DONE at the START
   of zone injection, but __PKG_PREBUILT only lands when the ~25 MB
   package fetch resolves — seconds later. The one-shot call therefore
   saw "seam done, no prebuilt package" and returned, and NOTHING ever
   called it again: on a normal package boot the collision provider,
   the deck/rail rendering and PACKAGE_RAIL silently never activated.

   THE DRIVER: a bounded poll (every 250 ms) that rides the seam's own
   load instead of racing it —
     * activation happens only after bootWorld() has resolved (the
       prebuilt package exists) AND collision_material.js has defined
       its registration API, so activatePackage can never half-apply
       (provider missing while decks render);
     * bootWorld() is idempotent (one cached promise), so the driver
       can safely start it when the seam hasn't — the package is never
       fetched twice, whichever path gets there first;
     * a seam fallback (__PKG_SEAM_FELL_BACK) settles the driver at
       once: legacy serves, and no package provider may be layered
       over a legacy world (a second truth);
     * direct servings without index.html's seam keep working: if the
       seam has not run within the grace window, the driver starts
       bootWorld() itself (the old no-seam path, now through the same
       idempotent entry). */
var _pkgDriverTicks = 0, _pkgDriverSettled = false;
var PKG_DRIVER_TICK_MS = 250, PKG_DRIVER_MAX_TICKS = 480,  /* ~2 minutes */
    PKG_NO_SEAM_GRACE_TICKS = 12;                          /* ~3 seconds */
function _collisionApiReady(){
  return typeof CollisionMaterial !== 'undefined' &&
         typeof CollisionMaterial.setPackageProvider === 'function' &&
         typeof CollisionMaterial.setGroundSampler === 'function';
}
function tryBootPackage(){
  if (_pkgDriverSettled) return;
  _pkgDriverTicks++;
  /* A prebuilt package + the collision API = activate, exactly once
     (activatePackage also guards on pkg._activated). */
  if (window.__PKG_PREBUILT){
    if (_collisionApiReady()){
      _pkgDriverSettled = true;
      activatePackage(window.__PKG_PREBUILT);
    } else if (_pkgDriverTicks >= PKG_DRIVER_MAX_TICKS){
      _pkgDriverSettled = true;
      note('package built but collision_material never became ready — ' +
           'provider NOT registered (world serves without the package gate)');
    }
    return;
  }
  /* The seam fell back to legacy: settle, activate nothing. */
  if (window.__PKG_SEAM_FELL_BACK){ _pkgDriverSettled = true; return; }
  /* Every remaining path is bounded: a hung fetch or a seam that
     never runs must not leave this poll alive for the whole session. */
  if (_pkgDriverTicks >= PKG_DRIVER_MAX_TICKS){
    _pkgDriverSettled = true;
    note('package activation driver gave up waiting — legacy zone data serves');
    return;
  }
  /* The seam's load is in flight (bootWorld called, promise pending):
     keep polling — __PKG_PREBUILT appears when it resolves. */
  if (_bootWorldPromise) return;
  if (window.__PKG_SEAM_DONE){
    /* The seam decided but never started bootWorld (e.g. the loader
       was not ready at seam time). Start it here — idempotent, so the
       seam's own later call would still share the one fetch. If the
       seam chose legacy outright, settle instead. */
    if (window.MapSystem && window.MapSystem.packageModeRequested()) bootWorld();
    else _pkgDriverSettled = true;
    return;
  }
  /* No seam yet. Inside the grace window, keep waiting for it; past
     the grace window this serving has no seam — drive bootWorld()
     directly (never a second fetch: bootWorld caches its promise). */
  if (_pkgDriverTicks > PKG_NO_SEAM_GRACE_TICKS) bootWorld();
}

/* Boot attempt: start the activation driver. Deferred scripts run
   before the world builds; the driver polls until the seam's package
   load and collision_material are both ready, then activates once. */
try {
  if (typeof window !== 'undefined' && window.MapSystem &&
      window.MapSystem.packageModeRequested()){
    var _pkgDriverTimer = setInterval(function(){
      try { tryBootPackage(); } catch(e){}
      if (_pkgDriverSettled) clearInterval(_pkgDriverTimer);
    }, PKG_DRIVER_TICK_MS);
  }
} catch(e){}

window.MapLoader = {
  loadPackage: loadPackage,
  buildPackage: buildPackage,
  activatePackage: activatePackage,
  bootWorld: bootWorld,
  buildLegacyGlobals: buildLegacyGlobals,
  /* exposed for the Phase C/D harnesses + debugging */
  _distToSeg: distToSeg, _pointInRing: pointInRing,
  _ringInteriorPoint: ringInteriorPoint, _minAreaRect: minAreaRect
};
})();
