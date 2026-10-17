#!/usr/bin/env node
/* Adamsville Watcher — world snapshot builder.
   Reads the game's real data files + the latest inspector report and emits
   a compact world.js for the lightweight 2D watcher. Run from this dir:
     node build-world.js
*/
var fs = require('fs');
var path = require('path');
var PROJ = '/home/hatch/workspace/game-map/project';
var WWW = path.join(PROJ, 'www');
var DIAG = '/home/hatch/workspace/game-map/diag';

function loadVar(file, name) {
  var src = fs.readFileSync(file, 'utf8');
  return new Function(src + '\nreturn ' + name + ';')();
}
var ROAD_DATA = loadVar(path.join(WWW, 'roads.js'), 'ROAD_DATA');
var OSM_BUILDINGS = loadVar(path.join(WWW, 'osm_buildings.js'), 'OSM_BUILDINGS');
var REPORT = JSON.parse(fs.readFileSync(path.join(DIAG, 'road-inspection.json'), 'utf8'));

/* simplify a polyline: keep first/last, drop points closer than minStep */
function decimate(pts, minStep) {
  var out = [pts[0]];
  for (var i = 1; i < pts.length - 1; i++) {
    var p = out[out.length - 1];
    if (Math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]) >= minStep) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function r1(n) { return Math.round(n); }

var roads = [];
var CAT = { highway: 0, arterial: 1, local: 2 };
['highway', 'arterial', 'local'].forEach(function (cat) {
  (ROAD_DATA[cat] || []).forEach(function (rd) {
    if (!rd.pts || rd.pts.length < 2) return;
    var pts = decimate(rd.pts, cat === 'local' ? 55 : 40);
    if (pts.length < 2) return;
    /* compact: [cat, name, flat xy pairs] */
    var flat = [];
    pts.forEach(function (p) { flat.push(r1(p[0]), r1(p[1])); });
    roads.push([CAT[cat], cat === 'local' ? '' : rd.name, flat]);
  });
});

/* water: replicate lake/pond/creek placement from the rig */
var LON_MIN = -84.6209, LON_RANGE = 0.2418, LAT_MAX = 33.8392, LAT_RANGE = 0.3184, WX = 8000, WZ = 12000;
function xz(lat, lon) { return { x: (lon - LON_MIN) / LON_RANGE * WX, z: (LAT_MAX - lat) / LAT_RANGE * WZ }; }
var lakeC = xz(33.74946, -84.52388), pondC = xz(33.74795, -84.52161);
pondC = { x: pondC.x + 40, z: pondC.z - 25 };
var water = [
  { x: r1(lakeC.x), z: r1(lakeC.z), rx: 75, rz: 48, n: 'Tatum Lake' },
  { x: r1(pondC.x), z: r1(pondC.z), rx: 38, rz: 26, n: 'Pond' }
];
var creek = [];
try {
  var idx = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  var m = idx.match(/var CREEK_OSM=(\[.*?\]);/s);
  if (m) {
    var cp = eval('(' + m[1] + ')');
    creek = decimate(cp, 25).map(function (p) { return [r1(p[0]), r1(p[1])]; });
  }
} catch (e) {}

/* buildings: raw OSM positions are fine for top-down dots (nudge <= 24u);
   store as flat [x,z,t] integers to keep it light */
var buildings = [];
OSM_BUILDINGS.forEach(function (b) { buildings.push(r1(b[0]), r1(b[1]), b[5]); });

/* POIs transcribed from the rig's registry (same coords) */
var POI_DEF = [
  ['ADAMSVILLE REC CENTER', 'civic', 33.75378, -84.49187],
  ['SOUTH COBB LIBRARY', 'civic', 33.81297, -84.57214],
  ['RIVERDALE HIGH', 'school', 33.55658, -84.40224],
  ['RIVERDALE APARTMENTS', 'housing', 33.543, -84.399],
  ['DOWNTOWN ATLANTA', 'district', 33.7586, -84.38908],
  ['OLYMPIC STADIUM', 'civic', 33.732, -84.39],
  ['FULTON COUNTY STADIUM', 'civic', 33.73528, -84.38944],
  ['THE OMNI', 'business', 33.75750, -84.39667],
  ['TECHWOOD (VACANT)', 'vacant', 33.767, -84.395],
  ['W BROAD ST — FAIRBURN', 'business', 33.57, -84.574],
  ['FULTON COUNTY AIRPORT', 'business', 33.77716, -84.52134],
  ['CAR WASH', 'business', 33.7485, -84.5450],
  ['535 DOLLAR MILL RD (HOME)', 'home', 33.7411, -84.52645]
];
var pois = POI_DEF.map(function (p) {
  var w = xz(p[2], p[3]);
  return { n: p[0], k: p[1], x: r1(w.x), z: r1(w.z) };
});

/* findings: compact the real rig output */
var SEVMAP = { critical: 3, high: 2, medium: 1, info: 0 };
var findings = [];
Object.keys(REPORT.sections || {}).forEach(function (sk) {
  var sec = REPORT.sections[sk];
  (sec.issues || []).forEach(function (f) {
    if (!isFinite(f.x + f.z)) return;
    findings.push({
      x: r1(f.x), z: r1(f.z),
      t: f.type || '?', s: SEVMAP[f.severity] === undefined ? 1 : SEVMAP[f.severity],
      team: f.team || sk,
      road: (f.road || f.poi || '').slice(0, 40),
      d: String(f.detail || '').slice(0, 140)
    });
  });
});

var world = {
  W: WX, H: WZ,
  generated: REPORT.generated,
  reportSummary: REPORT.summary,
  roads: roads, water: water, creek: creek,
  buildings: buildings, pois: pois, findings: findings
};
/* findings as compact arrays: [x,z,type,sev,team,road,detail] */
world.findings = findings.map(function (f) { return [f.x, f.z, f.t, f.s, f.team, f.road, f.d]; });
var out = 'var WORLD = ' + JSON.stringify(world) + ';';
fs.writeFileSync(path.join('/home/hatch/workspace/game-map/watcher', 'world.js'), out);
console.log('world.js written: ' + (out.length / 1024).toFixed(0) + ' KB');
console.log('  roads: ' + roads.length + ' runs, buildings: ' + buildings.length + ', findings: ' + findings.length + ', pois: ' + pois.length);
