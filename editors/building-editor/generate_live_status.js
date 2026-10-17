#!/usr/bin/env node
/*
 * Regenerate the per-station LIVE STATUS section of
 * editors/building-editor/gas-station-review.json (the
 * "allStations" list covering all 109 real fuel stations).
 *
 * Why (Joshua, 2026-10-17, Building Editor 1.7.2 amendment 2): the
 * 3D view in the editor labels every station Flagged / Skipped /
 * Placed by how the CURRENTLY SHIPPED game treats it. Stations
 * are never on the flagged list, so the label is Placed or
 * Skipped by the game's own placement gate — the OLD gate,
 * because Joshua ordered "keep the skip station rule for now"
 * (2026-10-17). This script recomputes that gate with the game's
 * verbatim logic (index.html: xz(), distToRoadEdge(),
 * placeStruct() with halfDiag 26 + margin 4) over the real zone
 * roads, and validates itself: the totals MUST come out
 * placed=27 / skipped=82, the audited numbers from the round-1 /
 * round-2 gas-station work (GAS-STATION-FIX-NOTES.md). If they
 * ever differ, the game or the data changed and the file is NOT
 * rewritten.
 *
 * Usage:
 *   node generate_live_status.js <detailed_dir> <review_json_in>
 *        <review_json_out>
 *
 * <detailed_dir> holds gas_stations_real.js and zones/<zone>/
 * {roads.json, zone.json}. The input review file is the current
 * published one; the output is the same document plus the
 * allStations section, live counts, and explanatory notes.
 */
"use strict";
const fs = require("fs");
const path = require("path");

// --- the game's own constants/logic, verbatim ---------------------
const LON_MIN = -84.6209, LON_RANGE = 0.2418;
const LAT_MAX = 33.8392, LAT_RANGE = 0.3184;
const WX = 8000, WZ = 12000;
const RESCALE = 2.8327464788732395; // 1609/568, the conversion scale
const ROAD_WIDTHS = { interstate: 34, highway: 22, major_artery: 20,
                      minor_artery: 18.4, local: 7.2 };

function xz(lat, lon) {
  let x = (lon - LON_MIN) / LON_RANGE * WX;
  let z = (LAT_MAX - lat) / LAT_RANGE * WZ;
  x = 3772.5 + (x - 3772.5) * RESCALE;
  z = 2009 + (z - 2009) * RESCALE;
  return [x, z];
}

function segDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 === 0 ? 0 : ((px - ax) * vx + (pz - az) * vz) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + vx * t), dz = pz - (az + vz * t);
  return Math.hypot(dx, dz);
}

// Road grid over every zone's roads (cell 40, 3x3 neighbourhood —
// the game's gridSegsNear(x, z, 1)).
function buildGrid(zonesDir, zoneNames) {
  const grid = new Map();
  const key = (cx, cz) => cx + "," + cz;
  for (const zone of zoneNames) {
    const roads = JSON.parse(fs.readFileSync(
      path.join(zonesDir, zone, "roads.json"), "utf8"));
    for (const [cls, records] of Object.entries(roads)) {
      const hw = (ROAD_WIDTHS[cls] || 7.2) / 2 + 1.5;
      for (const rec of records || []) {
        const pts = rec.pts || [];
        for (let i = 0; i + 1 < pts.length; i++) {
          const seg = { ax: pts[i][0], az: pts[i][1],
                        bx: pts[i + 1][0], bz: pts[i + 1][1], hw };
          const x0 = Math.floor(Math.min(seg.ax, seg.bx) / 40) - 1;
          const x1 = Math.floor(Math.max(seg.ax, seg.bx) / 40) + 1;
          const z0 = Math.floor(Math.min(seg.az, seg.bz) / 40) - 1;
          const z1 = Math.floor(Math.max(seg.az, seg.bz) / 40) + 1;
          for (let cx = x0; cx <= x1; cx++) {
            for (let cz = z0; cz <= z1; cz++) {
              const k = key(cx, cz);
              if (!grid.has(k)) grid.set(k, []);
              grid.get(k).push(seg);
            }
          }
        }
      }
    }
  }
  return { grid, key };
}

function distToRoadEdge(gridObj, x, z) {
  const cx = Math.floor(x / 40), cz = Math.floor(z / 40);
  let best = Infinity;
  for (let ix = cx - 1; ix <= cx + 1; ix++) {
    for (let iz = cz - 1; iz <= cz + 1; iz++) {
      const segs = gridObj.grid.get(gridObj.key(ix, iz)) || [];
      for (const s of segs) {
        const d = segDist(x, z, s.ax, s.az, s.bx, s.bz) - s.hw;
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// placeStruct(x, z, halfDiag, margin): the centre must sit at
// least halfDiag + margin from every road edge; nudge rings
// r = 6..30 step 6 at 8 angles; else null (skipped).
function placeStruct(gridObj, x, z, halfDiag, margin) {
  const need = halfDiag + margin;
  if (distToRoadEdge(gridObj, x, z) >= need) return [x, z];
  for (let r = 6; r <= 30; r += 6) {
    for (let a = 0; a < 8; a++) {
      const ang = a / 8 * Math.PI * 2;
      const nx = x + Math.cos(ang) * r;
      const nz = z + Math.sin(ang) * r;
      if (distToRoadEdge(gridObj, nx, nz) >= need) return [nx, nz];
    }
  }
  return null;
}

// --- main -----------------------------------------------------------
function main() {
  const [detailedDir, reviewIn, reviewOut] = process.argv.slice(2);
  if (!detailedDir || !reviewIn || !reviewOut) {
    console.error("usage: node generate_live_status.js " +
                  "<detailed_dir> <review_in> <review_out>");
    process.exit(2);
  }
  const zonesDir = path.join(detailedDir, "zones");
  const zoneNames = fs.readdirSync(zonesDir).filter(
    (n) => fs.existsSync(path.join(zonesDir, n, "zone.json")));
  const bounds = {};
  for (const zone of zoneNames) {
    bounds[zone] = JSON.parse(fs.readFileSync(
      path.join(zonesDir, zone, "zone.json"), "utf8")).bounds;
  }
  const zoneFor = (x, z) => {
    for (const zone of zoneNames) {
      const b = bounds[zone];
      if (b && x >= b.xMin && x <= b.xMax && z >= b.zMin &&
          z <= b.zMax) return zone;
    }
    return null;
  };

  const stationsSrc = fs.readFileSync(
    path.join(detailedDir, "gas_stations_real.js"), "utf8");
  const stations = JSON.parse(stationsSrc.slice(
    stationsSrc.indexOf("["),
    stationsSrc.lastIndexOf("]") + 1));

  const gridObj = buildGrid(zonesDir, zoneNames);
  const all = [];
  let placed = 0, skipped = 0;
  stations.forEach((s, i) => {
    const [x, z] = xz(s.lat, s.lon);
    const spot = placeStruct(gridObj, x, z, 26, 4);
    const status = spot ? "placed" : "skipped";
    if (spot) placed++; else skipped++;
    all.push({
      stationIndex: i,
      name: s.name || s.brand || "Unnamed station",
      brand: s.brand || "",
      address: s.addr || "",
      zone: zoneFor(x, z),
      lat: s.lat, lon: s.lon,
      realPosition: [Math.round(x * 10) / 10,
                     Math.round(z * 10) / 10],
      liveStatus: status,
      placedPosition: spot
        ? [Math.round(spot[0] * 10) / 10,
           Math.round(spot[1] * 10) / 10]
        : null,
      nudged: spot
        ? Math.hypot(spot[0] - x, spot[1] - z) > 0.05
        : false,
    });
  });
  console.log(`live gate totals: placed=${placed} skipped=${skipped}`);
  if (placed !== 27 || skipped !== 82) {
    console.error("VALIDATION FAILED: expected placed=27 " +
      "skipped=82 (the audited gate outcome). The game or the " +
      "data changed — NOT writing the file.");
    process.exit(1);
  }
  // Cross-check the zones against the review file's own records.
  const doc = JSON.parse(fs.readFileSync(reviewIn, "utf8"));
  let agree = 0, total = 0;
  for (const st of doc.stations || []) {
    const mine = all[st.stationIndex];
    if (mine) {
      total++;
      if (mine.zone === st.zone) agree++;
    }
  }
  console.log(`zone cross-check vs review file: ${agree}/${total}`);
  if (total && agree !== total) {
    console.error("VALIDATION FAILED: zone derivation disagrees " +
                  "with the review file — NOT writing.");
    process.exit(1);
  }

  doc.allStations = all;
  doc.counts = Object.assign({}, doc.counts,
                             { livePlaced: placed,
                               liveSkipped: skipped });
  doc._liveStatusNote =
    "liveStatus / placedPosition / nudged per station: whether " +
    "the CURRENTLY SHIPPED game places the station, recomputed " +
    "with the game's own placement gate (the old skip rule, " +
    "kept by Joshua's order 2026-10-17) by " +
    "generate_live_status.js. Totals validate at 27 placed / " +
    "82 skipped. allStations covers all 109 stations; the " +
    "stations list above stays the 53 problems for review.";
  doc._note = (doc._note || "") +
    " [1.7.2: this file is downloaded from GitHub by the editor " +
    "on open — never bundled. Editor-side station edits live in " +
    "station-edits.json beside it.]";
  fs.writeFileSync(reviewOut, JSON.stringify(doc, null, 1));
  console.log(`wrote ${reviewOut}: ` +
              `${fs.statSync(reviewOut).size} bytes, ` +
              `${all.length} stations`);
}

main();
