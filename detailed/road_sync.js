/*
 * Surviving Adamsville — road_sync.js
 *
 * Live road/zone sync from the Adamsville Map Editor's GitHub repo.
 *
 * WHAT IT DOES:
 *   At startup, fetches roads.json and zones.json from
 *   kingmarkarnold-code/adamsville-map-editor (raw.githubusercontent.com).
 *   On success it converts the editor format to the game's internal
 *   ROAD_DATA format and swaps it in place, so every game system that
 *   reads ROAD_DATA lazily (street-name lookup, GPS routing, traffic,
 *   roadNameNear) immediately sees the editor's latest roads.
 *
 * WHAT IT DOES NOT DO (by Joshua's standing rule):
 *   It does NOT rebuild the baked 3D road ribbon geometry mid-session.
 *   buildRoads() is an IIFE that runs during page parse, before this
 *   deferred script executes. New/changed road GEOMETRY becomes visible
 *   on the next page load — "applies on new game, never hot-swap a
 *   running world."
 *
 * FORMAT CONVERSION:
 *   Editor categories -> game categories:
 *     interstate   -> highway   (game already widens named interstates)
 *     major_artery -> arterial
 *     minor_artery -> arterial
 *     arterial     -> arterial  (legacy)
 *     highway      -> highway
 *     local        -> local
 *   Unknown categories fall back to local (never crash).
 *   Editor-only fields (divided_sections, width_class, paint,
 *   sidewalk_*, cul_de_sac, divider_type, ...) are preserved on the
 *   road objects — the current renderer ignores them harmlessly and
 *   the new renderer (in progress) will use them.
 *
 * ZONES:
 *   zones.json ({zones:[{name, points:[[x,z]...], ...}]}) is converted
 *   to bounds and exposed as window.__REMOTE_ZONES for any system that
 *   wants fresher zone boundaries than the baked ZONES list.
 *
 * DEFENSIVE:
 *   Any fetch failure, bad JSON, or unexpected shape -> keep the
 *   bundled local data and log a warning. The game never crashes
 *   because the editor repo was unreachable.
 *
 * Joshua's rule: all code commented.
 */
(function () {
  "use strict";

  // Editor repo data URLs (public raw files, no auth needed).
  var ROADS_URL = "https://raw.githubusercontent.com/kingmarkarnold-code/adamsville-map-editor/main/roads.json";
  var ZONES_URL = "https://raw.githubusercontent.com/kingmarkarnold-code/adamsville-map-editor/main/zones.json";

  // Game's internal road categories (what buildRoads() iterates).
  var GAME_CATS = ["highway", "arterial", "local"];

  // Editor category -> game category mapping.
  var CAT_MAP = {
    interstate: "highway",
    highway: "highway",
    major_artery: "arterial",
    minor_artery: "arterial",
    arterial: "arterial",   // legacy editor value
    local: "local"
  };

  /**
   * Validate one editor road object. Returns a clean road or null.
   * Keeps name/pts plus any editor-only fields (harmless to the
   * current renderer, used by the new one).
   */
  function cleanRoad(r) {
    if (!r || !Array.isArray(r.pts) || r.pts.length < 2) return null;
    // Deep-copy points as [x, z] number pairs; drop bad points.
    var pts = [];
    for (var i = 0; i < r.pts.length; i++) {
      var p = r.pts[i];
      if (!Array.isArray(p) || p.length < 2) continue;
      var x = +p[0], z = +p[1];
      if (!isFinite(x) || !isFinite(z)) continue;
      pts.push([x, z]);
    }
    if (pts.length < 2) return null;
    var out = {
      name: (typeof r.name === "string" && r.name) || "Unnamed St",
      pts: pts
    };
    // Preserve editor-only fields the new renderer will use.
    // Unknown fields are simply carried along, never interpreted here.
    var passthrough = [
      "divided_sections", "width_class", "paint",
      "sidewalk_left", "sidewalk_right", "sidewalk_width",
      "cul_de_sac", "divider_type", "direction_labels",
      "ramp", "oneway"
    ];
    for (var k = 0; k < passthrough.length; k++) {
      var key = passthrough[k];
      if (r[key] !== undefined) out[key] = r[key];
    }
    return out;
  }

  /**
   * Convert the editor's roads.json ({cat: [roads]}) to the game's
   * ROAD_DATA shape ({highway: [...], arterial: [...], local: [...]}).
   * Returns null if the doc is unusable.
   */
  function convertRoads(doc) {
    if (!doc || typeof doc !== "object") return null;
    var out = { highway: [], arterial: [], local: [] };
    var cats = Object.keys(doc);
    var anyValid = false;
    for (var i = 0; i < cats.length; i++) {
      var ecat = cats[i];
      var gcat = CAT_MAP[ecat] || "local"; // unknown -> local, never crash
      var list = doc[ecat];
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) {
        var road = cleanRoad(list[j]);
        if (road) {
          // Remember the editor category for the new renderer.
          road._editorCat = ecat;
          out[gcat].push(road);
          anyValid = true;
        }
      }
    }
    return anyValid ? out : null;
  }

  /**
   * Swap converted roads into the global ROAD_DATA in place.
   * In-place swap (not rebinding) so any module holding a reference
   * to the ROAD_DATA object sees the update.
   */
  function swapRoadData(converted) {
    if (typeof ROAD_DATA === "undefined" || !ROAD_DATA) return false;
    try {
      for (var i = 0; i < GAME_CATS.length; i++) {
        var c = GAME_CATS[i];
        ROAD_DATA[c] = converted[c] || [];
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Convert zones.json ({zones:[{name, points}...]}) to bounds list:
   * [{name, xMin, xMax, zMin, zMax}]. Returns null on bad input.
   */
  function convertZones(doc) {
    var list = (doc && Array.isArray(doc.zones)) ? doc.zones : null;
    if (!list) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var z = list[i];
      if (!z || !Array.isArray(z.points) || z.points.length < 3) continue;
      var xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
      var ok = false;
      for (var j = 0; j < z.points.length; j++) {
        var p = z.points[j];
        if (!Array.isArray(p) || p.length < 2) continue;
        var x = +p[0], zz = +p[1];
        if (!isFinite(x) || !isFinite(zz)) continue;
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (zz < zMin) zMin = zz;
        if (zz > zMax) zMax = zz;
        ok = true;
      }
      if (!ok) continue;
      out.push({
        name: (typeof z.name === "string" && z.name) || ("zone_" + i),
        xMin: xMin, xMax: xMax, zMin: zMin, zMax: zMax
      });
    }
    return out.length ? out : null;
  }

  /**
   * Fetch JSON with a timeout. Resolves null on any failure.
   */
  function fetchJson(url, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(null); }
      }, timeoutMs || 15000);
      fetch(url, { cache: "no-store" })
        .then(function (resp) {
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          return resp.json();
        })
        .then(function (doc) {
          if (!done) { done = true; clearTimeout(timer); resolve(doc); }
        })
        .catch(function () {
          if (!done) { done = true; clearTimeout(timer); resolve(null); }
        });
    });
  }

  function log(msg) {
    try {
      if (typeof console !== "undefined" && console.log) {
        console.log("[road_sync] " + msg);
      }
    } catch (e) { /* logging must never throw */ }
  }

  /**
   * Main sync: fetch, convert, swap. Runs once at startup.
   * Exposed for manual re-sync / debugging.
   */
  function syncRoads() {
    // Roads and zones fetch in parallel; each is independent.
    fetchJson(ROADS_URL).then(function (doc) {
      if (!doc) {
        log("roads.json unreachable — keeping bundled roads.");
        return;
      }
      var converted = null;
      try {
        converted = convertRoads(doc);
      } catch (e) {
        converted = null;
      }
      if (!converted) {
        log("roads.json unusable — keeping bundled roads.");
        return;
      }
      // Stash the converted data even if the swap fails, so
      // debugging tools can inspect what the editor published.
      try { window.__REMOTE_ROAD_DATA = converted; } catch (e) {}
      if (swapRoadData(converted)) {
        var n = converted.highway.length + converted.arterial.length +
                converted.local.length;
        log("live roads applied: " + n + " roads " +
            "(geometry refreshes on next load).");
        try { window.__ROAD_SYNC_ACTIVE = true; } catch (e) {}
      } else {
        log("ROAD_DATA not present — remote roads stashed only.");
      }
    });

    fetchJson(ZONES_URL).then(function (doc) {
      if (!doc) {
        log("zones.json unreachable — keeping baked zones.");
        return;
      }
      var zones = null;
      try {
        zones = convertZones(doc);
      } catch (e) {
        zones = null;
      }
      if (!zones) {
        log("zones.json unusable — keeping baked zones.");
        return;
      }
      try {
        window.__REMOTE_ZONES = zones;
        log("live zones stashed: " + zones.length + " zones.");
      } catch (e) { /* ignore */ }
    });
  }

  // Kick off after the DOM is ready (deferred script — ROAD_DATA from
  // the bundled zone files already exists by now).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncRoads);
  } else {
    syncRoads();
  }

  // Expose for debugging / manual re-sync.
  window.RoadSync = {
    sync: syncRoads,
    convertRoads: convertRoads, // exposed for unit testing
    convertZones: convertZones
  };
})();
