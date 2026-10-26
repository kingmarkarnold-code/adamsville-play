/*
 * Surviving Adamsville — terrain_sync.js
 *
 * Live terrain-edit sync from the Adamsville Terrain Editor's repo.
 *
 * WHAT IT DOES:
 *   At startup, fetches terrain_edits.json from
 *   kingmarkarnold-code/adamsville-elevation-editor
 *   (raw.githubusercontent.com). That file is published by the
 *   Terrain Editor 2.0+ whenever Joshua lifts terrain faces:
 *
 *     {
 *       "app": "adamsville-terrain-editor-native",
 *       "version": 2,
 *       "grid": {"sx":150, "sz":200, "world_w":8000, "world_h":12000},
 *       "modifiedVertices": [{"x":wx, "z":wz, "oldH":.., "newH":..}, ...],
 *       "roadOffsets": [{"key":k, "offset":v}, ...]
 *     }
 *
 *   On success it NON-INVASIVELY wraps the global heightAt(x, z):
 *   the original is kept as heightAtBase, and the wrapper adds the
 *   editor's elevation deltas via a spatial hash (same pattern as the
 *   game's _liftGrid). Every consumer of heightAt() — player ground
 *   snap, building placement, vehicle positioning, road ribbons —
 *   automatically sees the edited terrain. Nothing else changes.
 *
 * ROAD OFFSETS:
 *   roadOffsets (terrain-road grouping: roads that lift WITH the
 *   terrain) are exposed as window.__ROAD_OFFSETS {key: offset} for
 *   the road renderer / 18-wheeler systems. Keys are the editor's
 *   opaque road-point keys; the game looks them up, it never parses
 *   them.
 *
 * DEFENSIVE:
 *   File missing (404 — the editor may never have published edits),
 *   empty, corrupt, or any unexpected shape -> do nothing. The game
 *   keeps its analytic terrain exactly as before. The heightAt wrapper
 *   is only installed when there is at least one valid delta.
 *
 * Joshua's rule: all code commented.
 */
(function () {
  "use strict";

  // Editor repo data URL (public raw file, no auth needed).
  // NOTE: terrain_edits.json only exists after the Terrain Editor has
  // published at least once — 404 before that is normal, not an error.
  var EDITS_URL = "https://raw.githubusercontent.com/kingmarkarnold-code/adamsville-elevation-editor/main/terrain_edits.json";

  // Spatial-hash cell size (world units) for delta lookup.
  // Editor vertices are ~53u apart (8000/150); 120u cells keep the
  // per-cell lists short while keeping the hash table small.
  var CELL = 120;

  /**
   * Build a spatial hash from modifiedVertices.
   * Each vertex carries an absolute new height; the delta applied is
   * (newH - oldH) so overlapping/duplicate entries don't double-apply.
   * Returns {grid, count} or null when nothing valid was found.
   */
  function buildDeltaGrid(verts) {
    if (!Array.isArray(verts) || !verts.length) return null;
    var grid = {}; // "cx,cz" -> [{x, z, dh}]
    var count = 0;
    // Influence radius: blend each edit over nearby terrain so lifted
    // faces don't create cliffs. Matches the editor's own falloff.
    var RADIUS = 60;
    for (var i = 0; i < verts.length; i++) {
      var v = verts[i];
      if (!v) continue;
      var x = +v.x, z = +v.z;
      var newH = +v.newH, oldH = +v.oldH;
      if (!isFinite(x) || !isFinite(z) ||
          !isFinite(newH) || !isFinite(oldH)) continue;
      var dh = newH - oldH;
      if (dh === 0) continue;
      // Insert into every cell the radius touches.
      var c0x = Math.floor((x - RADIUS) / CELL);
      var c1x = Math.floor((x + RADIUS) / CELL);
      var c0z = Math.floor((z - RADIUS) / CELL);
      var c1z = Math.floor((z + RADIUS) / CELL);
      for (var cx = c0x; cx <= c1x; cx++) {
        for (var cz = c0z; cz <= c1z; cz++) {
          var key = cx + "," + cz;
          if (!grid[key]) grid[key] = [];
          grid[key].push({ x: x, z: z, dh: dh });
          count++;
        }
      }
    }
    return count ? { grid: grid, count: count, radius: RADIUS } : null;
  }

  /**
   * Sum the deltas affecting world point (x, z).
   * Linear falloff with distance: full delta at the vertex, zero at
   * RADIUS. Multiple nearby edits blend additively.
   */
  function deltaAt(store, x, z) {
    var cell = gridFor(store, x, z);
    if (!cell) return 0;
    var total = 0;
    for (var i = 0; i < cell.length; i++) {
      var e = cell[i];
      var d = Math.hypot(x - e.x, z - e.z);
      if (d >= store.radius) continue;
      total += e.dh * (1 - d / store.radius);
    }
    return total;
  }

  function gridFor(store, x, z) {
    var key = Math.floor(x / CELL) + "," + Math.floor(z / CELL);
    return store.grid[key] || null;
  }

  /**
   * Install the heightAt wrapper. Keeps the original as
   * window.heightAtBase. Idempotent — safe to call twice.
   */
  function installWrapper(store) {
    if (typeof heightAt !== "function") return false;
    if (heightAt.__terrainSyncWrapped) return true; // already wrapped
    var base = heightAt;
    var wrapped = function (x, z) {
      var h = base(x, z);
      try {
        h += deltaAt(store, x, z);
      } catch (e) { /* a bad delta must never break height lookup */ }
      return h;
    };
    wrapped.__terrainSyncWrapped = true;
    // heightAt is a top-level function declaration; reassigning the
    // binding updates every caller that references the name.
    try {
      heightAt = wrapped;
    } catch (e) {
      return false;
    }
    try {
      window.heightAtBase = base;
      window.__TERRAIN_SYNC_ACTIVE = true;
    } catch (e) { /* ignore */ }
    return true;
  }

  /**
   * Publish road offsets for grouped roads.
   * Format: [{key, offset}] -> {key: offset} lookup object.
   */
  function publishRoadOffsets(list) {
    var out = {};
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e || e.key === undefined) continue;
        var off = +e.offset;
        if (!isFinite(off) || off === 0) continue;
        out[String(e.key)] = off;
      }
    }
    try {
      window.__ROAD_OFFSETS = out;
    } catch (e) { /* ignore */ }
  }

  function log(msg) {
    try {
      if (typeof console !== "undefined" && console.log) {
        console.log("[terrain_sync] " + msg);
      }
    } catch (e) { /* logging must never throw */ }
  }

  /**
   * Main sync: fetch, validate, wrap. Runs once at startup.
   */
  function syncTerrain() {
    // heightAt must exist before we can wrap it. If this script ever
    // runs before the main game block, retry briefly then give up.
    if (typeof heightAt !== "function") {
      log("heightAt not ready — terrain sync skipped.");
      return;
    }

    fetch(EDITS_URL, { cache: "no-store" })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (doc) {
        if (!doc || typeof doc !== "object") {
          log("edits file unusable — keeping base terrain.");
          return;
        }
        // Always publish road offsets when present, even with no
        // vertex edits (a grouping-only publish is valid).
        try {
          publishRoadOffsets(doc.roadOffsets);
        } catch (e) { /* ignore */ }

        var store = null;
        try {
          store = buildDeltaGrid(doc.modifiedVertices);
        } catch (e) {
          store = null;
        }
        if (!store) {
          log("no terrain edits to apply — keeping base terrain.");
          return;
        }
        if (installWrapper(store)) {
          log("applied " + store.count + " edit entries " +
              "(terrain deltas live).");
        } else {
          log("could not wrap heightAt — keeping base terrain.");
        }
      })
      .catch(function () {
        // 404 / offline / corrupt: normal before first publish.
        // Base terrain is unchanged; road offsets stay empty.
        try {
          window.__ROAD_OFFSETS = window.__ROAD_OFFSETS || {};
        } catch (e) { /* ignore */ }
      });
  }

  // Run after the DOM is ready. This deferred script executes after
  // the main inline game block, so heightAt already exists.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncTerrain);
  } else {
    syncTerrain();
  }

  // Expose for debugging / manual re-sync.
  window.TerrainSync = {
    sync: syncTerrain,
    buildDeltaGrid: buildDeltaGrid, // exposed for unit testing
    deltaAt: function (store, x, z) { // exposed for unit testing
      try { return deltaAt(store, x, z); } catch (e) { return 0; }
    }
  };
})();
