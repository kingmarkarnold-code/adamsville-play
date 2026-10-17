/* ============================================================================
   POI LAYER FOR MINIMAP + FULL MAP v1.0 (2026-10-09)
   Joshua's spec: the minimap (especially the EXPANDED full-screen view) shows
   points of interest with distinct icons/colors per category, a legend, and
   names on the expanded view.

   Categories: gas stations (109 OSM positions), Waffle Spots (9),
   Joshua's named schools (4), Marriott Marquis (hotel), strip clubs (6).

   Self-contained. Depends on globals: TR (traffic gas stations), CD_LOG
   (club/waffle final placements), MQ (marriott), LANDMARKS, mm (minimap
   context), fmCanvas, fmView, car, player, drawMinimap, drawFullMap.
   Loaded via <script src="poi_map.js"> AFTER clubs_diners.js.
   ============================================================================ */

var POIS = [];  // {type, name, x, z}
var POI_STYLE = {
  gas:    { color: '#ff9a3c', label: 'Gas Station'  },
  waffle: { color: '#ffd75e', label: 'Waffle Spot'  },
  school: { color: '#4ecb71', label: 'School'       },
  hotel:  { color: '#4ea8ff', label: 'Hotel'        },
  club:   { color: '#ff4e8a', label: 'Club'         }
};

function collectPOIs(){
  POIS = [];
  // 1. gas stations (TR.gas: {x, z, name:brand, type:'gas'})
  try {
    if (typeof TR !== 'undefined' && TR.gas) {
      TR.gas.forEach(function(g){
        POIS.push({ type: 'gas', name: g.name || 'Gas', x: g.x, z: g.z });
      });
    }
  } catch (e) {}
  // 2. clubs + waffle spots (CD_LOG has FINAL placed coords after placeStruct nudge)
  try {
    if (typeof CD_LOG !== 'undefined') {
      CD_LOG.forEach(function(e){
        if (e.type === 'club')
          POIS.push({ type: 'club', name: e.name, x: e.x, z: e.z });
        else if (e.type === 'waffle_spot')
          POIS.push({ type: 'waffle', name: 'Waffle Spot', x: e.x, z: e.z });
      });
    }
  } catch (e) {}
  // 3. Joshua's named schools
  POIS.push({ type: 'school', name: 'Harper Archer High School', x: 4060, z: 2595 });
  POIS.push({ type: 'school', name: 'Adamsville Elementary',      x: 3554, z: 3185 });
  POIS.push({ type: 'school', name: 'Usher Middle School',        x: 4220, z: 2525 });
  POIS.push({ type: 'school', name: 'Mays High School',           x: 3875, z: 3952 });
  // 4. Marriott Marquis (hotel)
  try {
    if (typeof MQ !== 'undefined')
      POIS.push({ type: 'hotel', name: 'Marriott Marquis', x: MQ.cx, z: MQ.cz });
  } catch (e) {}

  // Prune LANDMARKS of entries now rendered by the POI layer (avoid double markers).
  // Match by coordinates — robust against name differences.
  try {
    LANDMARKS = LANDMARKS.filter(function(L){
      for (var j = 0; j < POIS.length; j++) {
        var P = POIS[j];
        if (Math.abs(P.x - L.x) < 2 && Math.abs(P.z - L.z) < 2) return false;
      }
      return true;
    });
  } catch (e) {}
  try {
    var counts = {};
    POIS.forEach(function(P){ counts[P.type] = (counts[P.type] || 0) + 1; });
    if (typeof Report !== 'undefined') Report.note('poi', { total: POIS.length, byType: counts });
  } catch (e) {}
}

/* ---------- marker shapes (canvas) ---------- */
function poiStar(g, x, y, r){
  g.beginPath();
  for (var i = 0; i < 10; i++) {
    var rr = (i % 2 === 0) ? r : r * 0.45;
    var a = -Math.PI / 2 + i * Math.PI / 5;
    var px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i) g.lineTo(px, py); else g.moveTo(px, py);
  }
  g.closePath(); g.fill(); g.stroke();
}
function drawPOIMarker(g, x, y, type, sz){
  var st = POI_STYLE[type]; if (!st) return;
  g.fillStyle = st.color;
  g.strokeStyle = 'rgba(0,0,0,.75)'; g.lineWidth = 1.5;
  if (type === 'gas') {                       // orange square
    g.fillRect(x - sz, y - sz, sz * 2, sz * 2);
    g.strokeRect(x - sz, y - sz, sz * 2, sz * 2);
  } else if (type === 'waffle') {             // yellow diamond
    g.beginPath();
    g.moveTo(x, y - sz); g.lineTo(x + sz, y); g.lineTo(x, y + sz); g.lineTo(x - sz, y);
    g.closePath(); g.fill(); g.stroke();
  } else if (type === 'school') {             // green triangle
    g.beginPath();
    g.moveTo(x, y - sz); g.lineTo(x + sz, y + sz); g.lineTo(x - sz, y + sz);
    g.closePath(); g.fill(); g.stroke();
  } else if (type === 'hotel') {              // blue circle
    g.beginPath(); g.arc(x, y, sz, 0, Math.PI * 2); g.fill(); g.stroke();
  } else if (type === 'club') {               // pink star
    poiStar(g, x, y, sz);
  }
}

/* ---------- FULL (expanded) map: markers + names + legend is HTML ---------- */
function drawPOIsFullMap(){
  var g = fmCanvas.getContext('2d');
  var W = fmCanvas.width, H = fmCanvas.height;
  var sc = fmView.sc, rot = fmView.rot || 0;
  var cr = Math.cos(rot), sr = Math.sin(rot);
  function M(x, z){
    var dx = x - fmView.cx, dz = z - fmView.cz;
    return [W / 2 + sc * (dx * cr - dz * sr), H / 2 + sc * (dx * sr + dz * cr)];
  }
  // Names: always for the few key POIs; gas-station names only when zoomed in
  // enough to read them (avoids a wall of text at whole-map zoom).
  var showGasNames = sc > 0.1;
  var showNames = sc > (fmView.scFit || 0) * 1.4;  // whole-map zoom-out -> markers only
  g.textAlign = 'center';
  POIS.forEach(function(P){
    var m = M(P.x, P.z);
    if (m[0] < -50 || m[0] > W + 50 || m[1] < -50 || m[1] > H + 50) return;
    var sz = 7;
    drawPOIMarker(g, m[0], m[1], P.type, sz);
    var want = (P.type !== 'gas') ? showNames : (showNames && showGasNames);
    if (want) {
      g.font = 'bold 12px Arial';
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.85)';
      g.strokeText(P.name, m[0], m[1] - sz - 6);
      g.fillStyle = '#ffffff';
      g.fillText(P.name, m[0], m[1] - sz - 6);
    }
  });
}

/* ---------- SMALL rotating minimap: colored dots + compass ---------- */
function drawPOIsMinimap(){
  var S = 296, R = S / 2, range = 260;
  var px = car.driving ? car.x : player.x, pz = car.driving ? car.z : player.z;
  var yaw = car.driving ? car.yaw : player.yaw;
  var c = Math.cos(yaw), s = Math.sin(yaw);
  mm.save();
  mm.beginPath(); mm.arc(R, R, R - 2, 0, Math.PI * 2); mm.clip();
  for (var i = 0; i < POIS.length; i++) {
    var P = POIS[i];
    var dx = P.x - px, dz = P.z - pz;
    if (Math.abs(dx) > range || Math.abs(dz) > range) continue;
    var rx = -(dx * c - dz * s), rz = -(dx * s + dz * c);
    var mx = R + rx / range * R, my = R + rz / range * R;
    mm.fillStyle = POI_STYLE[P.type].color;
    mm.beginPath(); mm.arc(mx, my, 3.5, 0, Math.PI * 2); mm.fill();
  }
  mm.restore();
}
function drawMinimapCompass(){
  var S = 296, R = S / 2;
  var yaw = car.driving ? car.yaw : player.yaw;
  // world north (0,-1) through the minimap's rotation -> screen direction
  var nx = -Math.sin(yaw), ny = Math.cos(yaw);
  var ccx = R, ccy = 36, rr = 18;
  mm.save();
  mm.beginPath(); mm.arc(R, R, R - 2, 0, Math.PI * 2); mm.clip();
  mm.fillStyle = 'rgba(0,0,0,.55)';
  mm.beginPath(); mm.arc(ccx, ccy, rr, 0, Math.PI * 2); mm.fill();
  mm.strokeStyle = 'rgba(255,255,255,.8)'; mm.lineWidth = 2;
  mm.beginPath(); mm.arc(ccx, ccy, rr, 0, Math.PI * 2); mm.stroke();
  mm.fillStyle = '#ff5b5b';                       // red needle half -> north
  mm.beginPath();
  mm.moveTo(ccx + nx * 14, ccy + ny * 14);
  mm.lineTo(ccx - ny * 5, ccy + nx * 5);
  mm.lineTo(ccx + ny * 5, ccy - nx * 5);
  mm.closePath(); mm.fill();
  mm.fillStyle = '#dddddd';                       // white tail half -> south
  mm.beginPath();
  mm.moveTo(ccx - nx * 14, ccy - ny * 14);
  mm.lineTo(ccx - ny * 5, ccy + nx * 5);
  mm.lineTo(ccx + ny * 5, ccy - nx * 5);
  mm.closePath(); mm.fill();
  mm.fillStyle = '#ffffff'; mm.font = 'bold 12px Arial'; mm.textAlign = 'center';
  mm.fillText('N', ccx + nx * (rr + 10), ccy + ny * (rr + 10));
  mm.restore();
}

/* ---------- hook into the existing map draws ---------- */
(function poiInit(){
  collectPOIs();
  // v1.1 (2026-10-09): TR.gas populates ASYNC via initTraffic's boot timer,
  // AFTER this script loads — so a load-time-only collectPOIs() misses all
  // 109 gas stations. Re-collect whenever the data sources grow, on every
  // full-map draw and minimap draw (cheap: ~130 items) plus a delayed boot
  // re-check. This also catches any other late-arriving data.
  var _lastSrcCount = -1;
  function srcCount(){
    var n = 0;
    try { n += (typeof TR !== 'undefined' && TR.gas) ? TR.gas.length : 0; } catch (e) {}
    try { n += (typeof CD_LOG !== 'undefined') ? CD_LOG.length : 0; } catch (e) {}
    return n;
  }
  function refreshIfStale(){
    var n = srcCount();
    if (n !== _lastSrcCount) { _lastSrcCount = n; collectPOIs(); }
  }
  try {
    var _drawFullMap = drawFullMap;
    drawFullMap = function(){
      _drawFullMap();
      try { refreshIfStale(); drawPOIsFullMap(); } catch (e) {}
    };
  } catch (e) {}
  try {
    var _drawMinimap = drawMinimap;
    drawMinimap = function(dt){
      _drawMinimap(dt);
      try { refreshIfStale(); drawPOIsMinimap(); } catch (e) {}
      try { drawMinimapCompass(); } catch (e) {}
    };
  } catch (e) {}
  try { setTimeout(function(){ try { refreshIfStale(); } catch (e) {} }, 5000); } catch (e) {}
})();
