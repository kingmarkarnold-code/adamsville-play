/* ============================================================================
   Adamsville Watcher — live 2D top-down watch room for the municipal QA crew.
   "Surviving Adamsville: Mollie's Edition — Watcher"
   Plain 2D canvas. No dependencies. Works from file:// on laptop + phone.
   World data: world.js (built by build-world.js from the game's real files
   and the real inspector report — the same logic as inspect-roads.js).
   ========================================================================== */
(function () {
'use strict';

/* If the world data didn't load (slow network, blocked script),
   say so plainly instead of hanging on "loading…". */
window.addEventListener('error', function (e) {
  var el = document.getElementById('reportline');
  if (el) el.textContent = 'Error: ' + (e.message || 'a script failed to load') +
    ' — try refreshing the page (world.js may not have finished loading).';
});
if (typeof WORLD === 'undefined') {
  document.getElementById('reportline').textContent =
    'Error: world data did not load (world.js missing or still loading) — refresh the page and try again.';
  return;
}

/* ---------------- teams (match office.js vehicle identities) ---------------- */
var TEAMS = {
  roads:     { unit: 'Road Crew',        color: '#ff8c1a', n: 16 },
  buildings: { unit: 'Code Enforcement', color: '#3a7bff', n: 16 },
  planner:   { unit: 'City Planner',     color: '#2fbf5a', n: 1 },
  inspector: { unit: 'City Inspector',    color: '#ffd21f', n: 1 },
  police:    { unit: 'Police',            color: '#1a2a6b', n: 0 }
};
var SEVC = ['#8e8e93', '#ffcc00', '#ff7a1a', '#ff3b30'];
var SEVN = ['info', 'medium', 'high', 'critical'];

/* ---------------- world data ---------------- */
var W = WORLD.W, H = WORLD.H;
// roads: [cat, name, flatXY] -> runs with cumulative lengths for patrol
var runs = WORLD.roads.map(function (r) {
  var pts = [], cum = [0];
  for (var i = 0; i < r[2].length; i += 2) {
    pts.push([r[2][i], r[2][i + 1]]);
    if (i > 0) cum.push(cum[cum.length - 1] + Math.hypot(r[2][i] - r[2][i - 2], r[2][i + 1] - r[2][i - 1]));
  }
  var mx = 0, mz = 0;
  for (var j = 0; j < pts.length; j += Math.max(1, Math.floor(pts.length / 6))) { mx += pts[j][0]; mz += pts[j][1]; }
  var n = Math.min(6, pts.length);
  return { cat: r[0], name: r[1], pts: pts, len: cum[cum.length - 1], cum: cum, mx: mx / n, mz: mz / n };
});
var buildings = WORLD.buildings; // flat [x,z,type,...]
var findings = WORLD.findings.map(function (f) {
  return { x: f[0], z: f[1], t: f[2], s: f[3], team: f[4], road: f[5], d: f[6] };
});
var pois = WORLD.pois;

/* ---------------- canvas + view ---------------- */
var cv = document.getElementById('map'), ctx = cv.getContext('2d');
var staticCv = document.createElement('canvas'), sctx = staticCv.getContext('2d');
var DPR = Math.min(2, window.devicePixelRatio || 1);
var view = { cx: W / 2, cy: H / 2, scale: 0.05 }; // px per world unit
var staticDirty = true;

function resize() {
  var w = window.innerWidth, h = window.innerHeight;
  cv.width = w * DPR; cv.height = h * DPR;
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  staticCv.width = w * DPR; staticCv.height = h * DPR;
  staticDirty = true;
}
window.addEventListener('resize', resize);

function fit() {
  var s = Math.min(window.innerWidth / W, window.innerHeight / H) * 0.96;
  view.scale = s; view.cx = W / 2; view.cy = H / 2; staticDirty = true;
}
function w2s(x, z) {
  return [(x - view.cx) * view.scale + cv.width / DPR / 2,
          (z - view.cy) * view.scale + cv.height / DPR / 2];
}
function s2w(sx, sy) {
  return [view.cx + (sx - cv.width / DPR / 2) / view.scale,
          view.cy + (sy - cv.height / DPR / 2) / view.scale];
}

/* ---------------- layers ---------------- */
var show = { roads: true, bldg: true, npc: true, flags: true };
['Roads', 'Bldg', 'Npc', 'Flags'].forEach(function (k) {
  document.getElementById('lyr' + k).addEventListener('change', function (e) {
    show[k.toLowerCase()] = e.target.checked; staticDirty = true;
  });
});

/* ---------------- static layer ---------------- */
function renderStatic() {
  var w = staticCv.width / DPR, h = staticCv.height / DPR;
  sctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  sctx.fillStyle = '#0b0e14'; sctx.fillRect(0, 0, w, h);
  var x0 = view.cx - (w / 2) / view.scale, x1 = view.cx + (w / 2) / view.scale;
  var z0 = view.cy - (h / 2) / view.scale, z1 = view.cy + (h / 2) / view.scale;

  // water
  sctx.fillStyle = '#14406b';
  WORLD.water.forEach(function (wt) {
    var p = w2s(wt.x, wt.z);
    sctx.beginPath();
    sctx.ellipse(p[0], p[1], wt.rx * view.scale, wt.rz * view.scale, 0, 0, 7);
    sctx.fill();
  });
  if (WORLD.creek.length > 1) {
    sctx.strokeStyle = '#1c5a94'; sctx.lineWidth = Math.max(1, 3 * view.scale);
    sctx.beginPath();
    WORLD.creek.forEach(function (p, i) {
      var s = w2s(p[0], p[1]); i ? sctx.lineTo(s[0], s[1]) : sctx.moveTo(s[0], s[1]);
    });
    sctx.stroke();
  }
  // buildings (dots)
  if (show.bldg) {
    sctx.fillStyle = '#3d4a63';
    var bs = Math.max(1.2, 4 * view.scale);
    for (var i = 0; i < buildings.length; i += 3) {
      var bx = buildings[i], bz = buildings[i + 1];
      if (bx < x0 || bx > x1 || bz < z0 || bz > z1) continue;
      var bp = w2s(bx, bz);
      sctx.fillRect(bp[0] - bs / 2, bp[1] - bs / 2, bs, bs);
    }
  }
  // roads
  if (show.roads) {
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r], pts = run.pts;
      // rough viewport cull via midpoint
      if (run.mx < x0 - 200 || run.mx > x1 + 200 || run.mz < z0 - 200 || run.mz > z1 + 200) continue;
      sctx.strokeStyle = run.cat === 0 ? '#8a7a5c' : (run.cat === 1 ? '#5a6478' : '#454e61');
      sctx.lineWidth = run.cat === 0 ? Math.max(1.5, 30 * view.scale) :
                       run.cat === 1 ? Math.max(1, 11 * view.scale) : Math.max(0.7, 7 * view.scale);
      sctx.beginPath();
      var started = false;
      for (var j = 0; j < pts.length; j++) {
        if (pts[j][0] < x0 - 50 || pts[j][0] > x1 + 50 || pts[j][1] < z0 - 50 || pts[j][1] > z1 + 50) { started = false; continue; }
        var sp = w2s(pts[j][0], pts[j][1]);
        started ? sctx.lineTo(sp[0], sp[1]) : sctx.moveTo(sp[0], sp[1]);
        started = true;
      }
      sctx.stroke();
    }
  }
  // POIs
  sctx.font = '600 10px sans-serif'; sctx.textAlign = 'left';
  pois.forEach(function (p) {
    if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) return;
    var pp = w2s(p.x, p.z);
    sctx.fillStyle = p.k === 'home' ? '#ff5a5a' : '#7fd0ff';
    sctx.beginPath(); sctx.arc(pp[0], pp[1], 4, 0, 7); sctx.fill();
    if (view.scale > 0.25) { sctx.fillStyle = '#c8d4e8'; sctx.fillText(p.n, pp[0] + 7, pp[1] + 3); }
  });
  // issue flags (diamonds, size by severity)
  if (show.flags) {
    for (var f = 0; f < findings.length; f++) {
      var fl = findings[f];
      if (fl.x < x0 || fl.x > x1 || fl.z < z0 || fl.z > z1) continue;
      var fp = w2s(fl.x, fl.z), sz = 3 + fl.s * 1.6;
      sctx.fillStyle = SEVC[fl.s];
      sctx.save(); sctx.translate(fp[0], fp[1]); sctx.rotate(Math.PI / 4);
      sctx.fillRect(-sz / 2, -sz / 2, sz, sz); sctx.restore();
    }
  }
  // feedback pins (Ctrl+click markers — persistent, from the note collection)
  try {
    var pins = Feedback.list();
    for (var pi = 0; pi < pins.length; pi++) {
      var pn = pins[pi];
      if (pn.x == null || pn.z == null) continue;
      if (pn.x < x0 || pn.x > x1 || pn.z < z0 || pn.z > z1) continue;
      var pp2 = w2s(pn.x, pn.z), pr = Math.max(6, 7 * Math.sqrt(view.scale));
      sctx.fillStyle = '#ff4fd8';
      sctx.beginPath(); sctx.arc(pp2[0], pp2[1] - pr * 0.55, pr * 0.62, 0, 7); sctx.fill();
      sctx.beginPath();
      sctx.moveTo(pp2[0] - pr * 0.45, pp2[1] - pr * 0.25);
      sctx.lineTo(pp2[0] + pr * 0.45, pp2[1] - pr * 0.25);
      sctx.lineTo(pp2[0], pp2[1] + pr * 0.75);
      sctx.closePath(); sctx.fill();
      sctx.fillStyle = '#1a0f16';
      sctx.beginPath(); sctx.arc(pp2[0], pp2[1] - pr * 0.55, pr * 0.28, 0, 7); sctx.fill();
    }
  } catch (e) {}
  staticDirty = false;
}

/* ---------------- vehicles (live patrol sim) ---------------- */
// road inspectors: 16, one per 4x4 zone, drive zone runs nearest-first (like the rig)
var vehicles = [];
function zoneRuns(qx, qz) {
  var zx0 = qx * W / 4, zx1 = (qx + 1) * W / 4, zz0 = qz * H / 4, zz1 = (qz + 1) * H / 4;
  var out = [];
  for (var i = 0; i < runs.length; i++)
    if (runs[i].mx >= zx0 && runs[i].mx < zx1 && runs[i].mz >= zz0 && runs[i].mz < zz1) out.push(i);
  return out;
}
for (var zi = 0; zi < 16; zi++) {
  var beat = zoneRuns(zi % 4, Math.floor(zi / 4));
  vehicles.push({ team: 'roads', id: zi, beat: beat, bi: 0, seg: 0, t: 0, speed: 55 + (zi % 5) * 6, x: W / 2, z: H / 2, dir: 1, report: [], seen: {} });
}
vehicles.forEach(function (v) {
  if (v.beat.length) { var r = runs[v.beat[0]]; v.x = r.pts[0][0]; v.z = r.pts[0][1]; }
});
// code enforcement: 4, walk building districts
for (var ai = 0; ai < 16; ai++) {
  vehicles.push({ team: 'buildings', id: ai, speed: 6, x: (ai % 4) * W / 4 + W / 8, z: Math.floor(ai / 4) * H / 4 + H / 8, tx: 0, tz: 0, walk: true });
}
// planner + inspector: tour POIs
[['planner', 0], ['inspector', 1]].forEach(function (t) {
  vehicles.push({ team: t[0], id: t[1], speed: 60, poi: 0, x: pois[0].x, z: pois[0].z, tour: true });
});
/* crew display names for the roster */
vehicles.forEach(function (v) {
  v.name = TEAMS[v.team].unit + ' ' + (v.id + 1);
});
vehicles.forEach(function (v) {
  if (v.team === 'planner') v.name = 'City Planner';
  if (v.team === 'inspector') v.name = 'City Inspector';
});
function nearestRunInBeat(v, x, z) {
  var best = -1, bd = 1e18;
  for (var i = 0; i < v.beat.length; i++) {
    if (i === v.bi) continue; // never pick the run we're already on — that's the ping-pong loop
    var r = runs[v.beat[i]];
    var d = Math.hypot(r.mx - x, r.mz - z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function stepVehicle(v, dt) {
  if (v.team === 'roads') {
    if (!v.beat.length) return;
    if (v.stuck) { stepStuckWorker(v, dt); return; } // waiting for / following police escort
    var r = runs[v.beat[v.bi]], pts = r.pts;
    var move = v.speed * dt;
    while (move > 0) {
      var a = pts[v.seg], b = pts[v.seg + v.dir];
      if (!b) { // end of run -> next nearest run in beat
        var nb = nearestRunInBeat(v, v.x, v.z);
        var prevRoad = v.beat[v.bi];
        v.bi = nb < 0 ? (v.bi + 1) % v.beat.length : nb;
        // loop detection: track recent roads
        v.roadHist = v.roadHist || [];
        v.roadHist.push(v.beat[v.bi]);
        if (v.roadHist.length > 8) v.roadHist.shift();
        var recent = v.roadHist.slice(-6);
        var repeats = recent.filter(function(ri){ return ri===v.beat[v.bi]; }).length;
        if (repeats >= 3 && !v.stuck) { triggerStuck(v); return; }
        var nr = runs[v.beat[v.bi]];
        // start at nearer end
        var d0 = Math.hypot(nr.pts[0][0] - v.x, nr.pts[0][1] - v.z);
        var d1 = Math.hypot(nr.pts[nr.pts.length - 1][0] - v.x, nr.pts[nr.pts.length - 1][1] - v.z);
        v.dir = d0 < d1 ? 1 : -1;
        v.seg = v.dir === 1 ? 0 : nr.pts.length - 1;
        v.x = nr.pts[v.seg][0]; v.z = nr.pts[v.seg][1];
        break;
      }
      var segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      var remain = segLen * (1 - v.t);
      if (move < remain) { v.t += move / segLen; move = 0; }
      else { move -= remain; v.seg += v.dir; v.t = 0; }
    }
    r = runs[v.beat[v.bi]]; // re-read: v.bi may have switched runs above
    var pa = r.pts[v.seg] || r.pts[0], pb = r.pts[v.seg + v.dir] || pa;
    v.x = pa[0] + (pb[0] - pa[0]) * v.t;
    v.z = pa[1] + (pb[1] - pa[1]) * v.t;
    // log nearby findings into this unit's report (once each)
    if (v.report) {
      for (var fi = 0; fi < findings.length; fi++) {
        if (v.seen[fi]) continue;
        var fl2 = findings[fi];
        if (Math.hypot(fl2.x - v.x, fl2.z - v.z) < 60) {
          v.seen[fi] = 1;
          v.report.push({ t: fl2.t, road: fl2.road, d: fl2.d, s: fl2.s, x: Math.round(fl2.x), z: Math.round(fl2.z) });
        }
      }
    }
/* Stuck-loop recovery: worker reports, police escorts through grass to nearest road */
function triggerStuck(v){
  v.stuck = 'waiting';
  var roadName = (function(){ var rr=runs[v.beat[v.bi]]; return rr.name||'unnamed road'; })();
  v.report = v.report || [];
  // worker radios DISPATCH: lost, repeating streets, requesting help
  v.report.push({ t:'LOST — CONTACTED DISPATCH', road:roadName,
    d:'Repeating the same streets over and over, cannot finish direction of travel. '
      +'Radioed dispatch (HQ Level 2) for help. Dispatch coordinating police escort.',
    s:3, x:Math.round(v.x), z:Math.round(v.z) });
  // dispatch sends police escort
  var p = { team:'police', id:vehicles.length, name:'Police Escort',
    x:v.x+200, z:v.z+200, speed:90, escortFor:v, phase:'toWorker' };
  vehicles.push(p);
  if(typeof updateOutboxBtn==='function') updateOutboxBtn();
}
function stepStuckWorker(v, dt){
  // worker waits for police, then follows across grass to nearest road
  var p = null;
  for(var i=0;i<vehicles.length;i++) if(vehicles[i].escortFor===v){ p=vehicles[i]; break; }
  if(!p){ v.stuck=null; return; }
  if(p.phase==='escorting'){
    // follow the police car across the grass
    var dx=p.x-v.x, dz=p.z-v.z, d=Math.hypot(dx,dz);
    if(d>30){ v.x+=dx/d*v.speed*dt; v.z+=dz/d*v.speed*dt; }
  }
  // if police delivered us to a road, resume patrol
  if(p.phase==='done'){
    v.stuck=null; v.roadHist=[];
    v.report.push({ t:'ESCORT COMPLETE', road:'—',
      d:'Police escort delivered unit to road. Resuming patrol.', s:0,
      x:Math.round(v.x), z:Math.round(v.z) });
    // remove the escort unit
    var pi=vehicles.indexOf(p); if(pi>=0) vehicles.splice(pi,1);
  }
}
function stepPolice(p, dt){
  var v=p.escortFor;
  if(!v || v.stuck!=='waiting' && v.stuck!=='following' && v.stuck!=='analyzing'){ 
    var pi=vehicles.indexOf(p); if(pi>=0) vehicles.splice(pi,1); return;
  }
  if(p.phase==='toWorker'){
    var dx=v.x-p.x, dz=v.z-p.z, d=Math.hypot(dx,dz);
    if(d<40){
      // INVESTIGATE FIRST: note the loop, analyze why
      p.phase='analyzing'; p.analyzeT=0; v.stuck='analyzing';
      var hist=(v.roadHist||[]).slice(-6);
      var names=hist.map(function(ri){ var rr=runs[v.beat[ri]]||runs[ri]; return (rr&&rr.name)||'unnamed'; });
      v.report=v.report||[];
      v.report.push({ t:'POLICE ON SCENE — INVESTIGATING', road:'—',
        d:'Police arrived. Observing loop: cycling ['+names.join(' → ')+']. '
          +'Analyzing why no exit exists before assisting.',
        s:2, x:Math.round(v.x), z:Math.round(v.z) });
    } else { p.x+=dx/d*p.speed*dt; p.z+=dz/d*p.speed*dt; }
  } else if(p.phase==='analyzing'){
    p.analyzeT=(p.analyzeT||0)+dt;
    if(p.analyzeT>3){ // 3 seconds of analysis
      p.phase='escorting'; v.stuck='following';
      var hist2=(v.roadHist||[]).slice(-4);
      var loopRoads={}; hist2.forEach(function(ri){ loopRoads[ri]=1; });
      // find a road NOT in the loop, nearest to worker
      var bd=1e18, bx=v.x, bz=v.z, bri=-1;
      for(var i=0;i<runs.length;i++){
        if(loopRoads[v.beat.indexOf(i)]!==undefined) continue;
        var rr=runs[i];
        for(var j=0;j<rr.pts.length;j+=4){
          var dd=Math.hypot(rr.pts[j][0]-v.x, rr.pts[j][1]-v.z);
          if(dd<bd && dd>150){ bd=dd; bx=rr.pts[j][0]; bz=rr.pts[j][1]; bri=i; }
        }
      }
      p.tx=bx; p.tz=bz;
      var rname=bri>=0?((runs[bri].name)||'unnamed road'):'nearest open road';
      v.report.push({ t:'ANALYSIS COMPLETE — REDIRECTING', road:'—',
        d:'Loop caused by isolated road pair with no connecting exit. '
          +'Directing unit toward '+rname+' to resume patrol on a new path.',
        s:2, x:Math.round(v.x), z:Math.round(v.z) });
    } else { p.x+=dx/d*p.speed*dt; p.z+=dz/d*p.speed*dt; }
  } else if(p.phase==='escorting'){
    var dx2=p.tx-p.x, dz2=p.tz-p.z, d2=Math.hypot(dx2,dz2);
    if(d2<50){ p.phase='done'; }
    else { p.x+=dx2/d2*p.speed*dt; p.z+=dz2/d2*p.speed*dt; }
  }
}
  } else if (v.team === 'police' && v.escortFor) {
    stepPolice(v, dt);
  } else if (v.walk) {
    var dx = v.tx - v.x, dz = v.tz - v.z, d = Math.hypot(dx, dz);
    if (d < 8) { // pick a random building in district
      var qx = v.id % 4, qz = Math.floor(v.id / 4);
      for (var k = 0; k < 20; k++) {
        var bi2 = Math.floor(Math.random() * buildings.length / 3) * 3;
        var bx2 = buildings[bi2], bz2 = buildings[bi2 + 1];
        if (bx2 >= qx * W / 4 && bx2 < (qx + 1) * W / 4 && bz2 >= qz * H / 4 && bz2 < (qz + 1) * H / 4) {
          v.tx = bx2; v.tz = bz2; break;
        }
      }
    } else { v.x += dx / d * v.speed * dt; v.z += dz / d * v.speed * dt; }
  } else if (v.tour) {
    var p = pois[v.poi % pois.length];
    var px = p.x - v.x, pz = p.z - v.z, pd = Math.hypot(px, pz);
    if (pd < 20) v.poi++;
    else { v.x += px / pd * v.speed * dt; v.z += pz / pd * v.speed * dt; }
  }
}

/* ---------------- NPC dots (faint, wandering) ---------------- */
var npcs = [];
for (var ni = 0; ni < 260; ni++) {
  npcs.push({ x: Math.random() * W, z: Math.random() * H, a: Math.random() * 6.28, sp: 4 + Math.random() * 8 });
}
function stepNpcs(dt) {
  for (var i = 0; i < npcs.length; i++) {
    var n = npcs[i];
    if (Math.random() < 0.01) n.a += (Math.random() - 0.5) * 2;
    n.x += Math.cos(n.a) * n.sp * dt; n.z += Math.sin(n.a) * n.sp * dt;
    if (n.x < 60 || n.x > W - 60 || n.z < 60 || n.z > H - 60) n.a += Math.PI;
  }
}

/* ---------------- interaction ---------------- */
var follow = null; // vehicle being followed
var popup = document.getElementById('popup');
function vehAt(sx, sy) {
  var w = s2w(sx, sy), best = null, bd = 26 / view.scale;
  for (var i = 0; i < vehicles.length; i++) {
    var d = Math.hypot(vehicles[i].x - w[0], vehicles[i].z - w[1]);
    if (d < bd) { bd = d; best = vehicles[i]; }
  }
  return best;
}
function flagAt(sx, sy) {
  var w = s2w(sx, sy), best = null, bd = 30 / view.scale;
  for (var i = 0; i < findings.length; i++) {
    var d = Math.hypot(findings[i].x - w[0], findings[i].z - w[1]);
    if (d < bd) { bd = d; best = findings[i]; }
  }
  return best;
}
function showPopup(fl, sx, sy) {
  window.AW2D = window.AW2D || {};
  window.AW2D.currentFlag = fl;
  document.getElementById('popt').innerHTML =
    '<span class="sev' + fl.s + '">◆</span> ' + fl.t + ' <span style="color:#7d8aa3">· ' + SEVN[fl.s] + '</span>';
  document.getElementById('popm').textContent =
    (TEAMS[fl.team] ? TEAMS[fl.team].unit : fl.team) + (fl.road ? ' · ' + fl.road : '');
  document.getElementById('popd').textContent = fl.d;
  popup.style.display = 'block';
  var pw = 280, px = Math.min(window.innerWidth - pw - 8, sx + 14), py = Math.min(window.innerHeight - 130, sy + 14);
  popup.style.left = Math.max(8, px) + 'px'; popup.style.top = Math.max(8, py) + 'px';
}
function hidePopup() { popup.style.display = 'none'; }
document.getElementById('popx').addEventListener('click', hidePopup);

var followbar = document.getElementById('followbar');
document.getElementById('unfollow').addEventListener('click', function () {
  follow = null; followbar.style.display = 'none';
});
function getOutbox(){ try{ return JSON.parse(localStorage.getItem('aw_outbox')||'[]'); }catch(e){ return []; } }
function saveOutbox(o){ try{ localStorage.setItem('aw_outbox', JSON.stringify(o)); }catch(e){} }
function queueReport(title, body){
  var o=getOutbox(); o.push({t:title, b:body, when:new Date().toISOString()}); saveOutbox(o);
  updateOutboxBtn();
}
function updateOutboxBtn(){
  var b=document.getElementById('outboxbtn'); if(!b) return;
  var n=(typeof fbGetOutbox==='function'?fbGetOutbox():getOutbox()).length;
  b.innerHTML='\u2699 Settings'
    +(n? ' <span style="display:inline-block;min-width:18px;height:18px;line-height:18px;'
      +'text-align:center;background:#e5484d;color:#fff;border-radius:9px;'
      +'font-size:11px;font-weight:bold;padding:0 5px;">'+n+'</span>':'');
  b.style.display='';
}
document.getElementById('restaff').addEventListener('click', function () {
  if (!follow) return;
  var v = follow, rep = v.report || [];
  // submit whatever report he was generating
  var title = 'Crew report — ' + v.name;
  var body = '# ' + title + '\n\n'
    + '- unit: ' + v.name + ' (' + (TEAMS[v.team] ? TEAMS[v.team].unit : v.team) + ')\n'
    + '- findings logged this patrol: ' + rep.length + '\n\n'
    + (rep.length ? rep.map(function (r, i) {
        return (i + 1) + '. [' + r.t + '] ' + (r.road || 'unnamed road')
          + ' — ' + r.d + ' (severity ' + r.s + ') @ ' + r.x + ', ' + r.z;
      }).join('\n') : '_No findings logged this patrol._')
    + '\n\n_Submitted on redirect/restart._';
  queueReport(title, body); // always saved locally first — GitHub may be down
  try{
    window.open('https://github.com/kingmarkarnold-code/adamsville-watcher/issues/new'
      + '?title=' + encodeURIComponent(title)
      + '&body=' + encodeURIComponent(body)
      + '&labels=' + encodeURIComponent('feedback'), '_blank');
  }catch(e){}
  // start him on a new mission: fresh beat, fresh position, empty report
  if (v.team === 'roads') {
    var nz = Math.floor(Math.random() * 16);
    v.beat = zoneRuns(nz % 4, Math.floor(nz / 4)); v.bi = 0; v.seg = 0; v.t = 0; v.dir = 1;
    if (v.beat.length) { var rr = runs[v.beat[0]]; v.x = rr.pts[0][0]; v.z = rr.pts[0][1]; }
  }
  v.report = []; v.seen = {};
  document.getElementById('followtxt').textContent = 'Following ' + v.name + ' (redirected)';
});
function setFollow(v) {
  follow = v; hidePopup();
  document.getElementById('followtxt').textContent = 'Following ' + v.name;
  followbar.style.display = 'block';
  if (view.scale < 1.2) { view.scale = 1.5; staticDirty = true; }  // zoom in so you can actually see them
}

var dragging = false, lastX = 0, lastY = 0, moved = 0, pinArm = false;
/* Ctrl+click (pin mode): drops a feedback marker + opens the note popup,
   same pin-and-note flow as the 3D Explorer's tap-to-pin. */
function dropPin2D(sx, sy) {
  var w = s2w(sx, sy);
  Feedback.openComment({ type: 'pin', name: 'map pin',
    x: Math.round(w[0]), z: Math.round(w[1]), view: '2d' });
}
window.AW2D = window.AW2D || {};
window.AW2D.refreshPins = function () { staticDirty = true; };
var pinchD0 = 0, pinchScale0 = 1;
var touches = {};

cv.addEventListener('mousedown', function (e) {
  pinArm = !!(e.ctrlKey || e.metaKey);
  dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener('mousemove', function (e) {
  if (!dragging || pinArm) return;
  var dx = e.clientX - lastX, dy = e.clientY - lastY;
  moved += Math.abs(dx) + Math.abs(dy);
  view.cx -= dx / view.scale; view.cy -= dy / view.scale;
  lastX = e.clientX; lastY = e.clientY; staticDirty = true;
});
window.addEventListener('mouseup', function (e) {
  if (!dragging) return; dragging = false;
  var wasPin = pinArm; pinArm = false;
  if (moved < 6) { if (wasPin) dropPin2D(e.clientX, e.clientY); else handleTap(e.clientX, e.clientY); }
});
cv.addEventListener('wheel', function (e) {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY));
}, { passive: false });
function zoomAt(sx, sy, f) {
  var w = s2w(sx, sy);
  view.scale = Math.min(4, Math.max(0.02, view.scale * f));
  view.cx = w[0] - (sx - cv.width / DPR / 2) / view.scale;
  view.cy = w[1] - (sy - cv.height / DPR / 2) / view.scale;
  staticDirty = true;
}
/* touch: 1-finger drag/tap, 2-finger pinch */
cv.addEventListener('touchstart', function (e) {
  e.preventDefault();
  for (var i = 0; i < e.changedTouches.length; i++) {
    var t = e.changedTouches[i];
    touches[t.identifier] = { x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY };
  }
  var ids = Object.keys(touches);
  if (ids.length === 2) {
    var a = touches[ids[0]], b = touches[ids[1]];
    pinchD0 = Math.hypot(a.x - b.x, a.y - b.y); pinchScale0 = view.scale;
  } else if (ids.length === 1) {
    lastX = touches[ids[0]].x; lastY = touches[ids[0]].y;
  }
  moved = 0;
}, { passive: false });
cv.addEventListener('touchmove', function (e) {
  e.preventDefault();
  for (var i = 0; i < e.changedTouches.length; i++) {
    var t = e.changedTouches[i];
    if (touches[t.identifier]) { touches[t.identifier].x = t.clientX; touches[t.identifier].y = t.clientY; }
  }
  var ids = Object.keys(touches);
  if (ids.length === 2) {
    var a = touches[ids[0]], b = touches[ids[1]];
    var d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchD0 > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinchScale0 * d / pinchD0) / view.scale);
  } else if (ids.length === 1) {
    var p = touches[ids[0]];
    var dx = p.x - lastX, dy = p.y - lastY;
    if (lastX !== undefined) {
      moved += Math.abs(dx) + Math.abs(dy);
      view.cx -= dx / view.scale; view.cy -= dy / view.scale; staticDirty = true;
    }
    lastX = p.x; lastY = p.y;
  }
}, { passive: false });
cv.addEventListener('touchend', function (e) {
  e.preventDefault();
  var ids = Object.keys(touches), tapped = null;
  if (ids.length === 1 && moved < 12) tapped = touches[ids[0]];
  for (var i = 0; i < e.changedTouches.length; i++) delete touches[e.changedTouches[i].identifier];
  lastX = undefined;
  if (tapped) handleTap(tapped.sx, tapped.sy);
}, { passive: false });

function handleTap(sx, sy) {
  var v = vehAt(sx, sy);
  if (v) { setFollow(v); return; }
  var fl = flagAt(sx, sy);
  if (fl) { follow = null; followbar.style.display = 'none'; showPopup(fl, sx, sy); return; }
  hidePopup();
  follow = null; followbar.style.display = 'none';
}
window.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' && window.WatcherTyping && window.WatcherTyping()) return;
  if (e.key === 'Escape') { follow = null; followbar.style.display = 'none'; hidePopup(); rosterHide(); return; }
  var k = e.key;
  if (k === '+' || k === '=') { zoomAt(cv.width / DPR / 2, cv.height / DPR / 2, 1.25); e.preventDefault(); }
  else if (k === '-' || k === '_') { zoomAt(cv.width / DPR / 2, cv.height / DPR / 2, 0.8); e.preventDefault(); }
  else if (k === 'ArrowUp') { view.cy -= 120 / view.scale; staticDirty = true; e.preventDefault(); }
  else if (k === 'ArrowDown') { view.cy += 120 / view.scale; staticDirty = true; e.preventDefault(); }
  else if (k === 'ArrowLeft') { view.cx -= 120 / view.scale; staticDirty = true; e.preventDefault(); }
  else if (k === 'ArrowRight') { view.cx += 120 / view.scale; staticDirty = true; e.preventDefault(); }
});

/* ---------------- crew roster (tap "Crews" to pick a unit) ---------------- */
var roster = document.getElementById('roster');
function rosterShow() {
  var html = '<div class="hd">Crew roster — tap to follow <span id="rosterx">✕</span></div><div class="rlist">';
  vehicles.forEach(function (v, i) {
    html += '<div class="rrow" data-i="' + i + '"><span class="dot" style="background:' +
      TEAMS[v.team].color + '"></span>' + v.name + '</div>';
  });
  roster.innerHTML = html + '</div>';
  roster.style.display = 'block';
  document.getElementById('rosterx').addEventListener('click', rosterHide);
  var mbtns = roster.querySelectorAll('.cmgr button');
  for (var mi=0; mi<mbtns.length; mi++) (function(b){
    b.addEventListener('click', function(e){
      e.stopPropagation();
      var t=b.getAttribute('data-t');
      if(b.getAttribute('data-d')==='1') addCrew(t); else removeCrew(t);
    });
  })(mbtns[mi]);
  var rows = roster.getElementsByClassName('rrow');
  for (var i = 0; i < rows.length; i++) (function (r) {
    r.addEventListener('click', function () {
      setFollow(vehicles[+r.getAttribute('data-i')]);
      rosterHide();
    });
  })(rows[i]);
}
function rosterHide() { roster.style.display = 'none'; }
var _refreshTimer=null;
function startAutoRefresh(){
  stopAutoRefresh();
  _refreshTimer=setInterval(function(){
    // live feed update: refresh map data without reloading page
    var roster=document.getElementById('roster');
    if(roster&&roster.style.display==='block') return;
    // force a full redraw to keep map accurate
    if(typeof staticDirty!=='undefined') staticDirty=true;
    if(typeof tickStats==='function') tickStats();
  },30000);
}
function stopAutoRefresh(){
  if(_refreshTimer){ clearInterval(_refreshTimer); _refreshTimer=null; }
}
// auto-refresh every 30s to clear ReferenceErrors (2D mode)
if(typeof window!=='undefined'){
  window.addEventListener('load',function(){ startAutoRefresh(); });
}
// render loop: redraw when dirty (throttled to avoid drag freeze)
var _lastRender=0;
(function renderLoop(){
  try{
    var now=Date.now();
    if(typeof staticDirty!=='undefined'&&staticDirty&&typeof renderStatic==='function'){
      if(now-_lastRender>50){ // max 20fps for static layer
        renderStatic();
        _lastRender=now;
      }
    }
  }catch(e){}
  requestAnimationFrame(renderLoop);
})();
function showSettings(){
  var html='<div class="hd">Settings <span id="rosterx">\\u2715</span></div>';
  html+='<div class="stabs"><button class="stab on" data-tab="reports">Reports</button></div>';
  html+='<div id="stabbody"></div>';
  roster.innerHTML=html; roster.style.display='block';
  document.getElementById('rosterx').addEventListener('click', rosterHide);
  var stabs=roster.querySelectorAll('.stab');
  for(var sti=0; sti<stabs.length; sti++)(function(b){
    b.addEventListener('click',function(){
      var sx=roster.querySelectorAll('.stab');
      for(var sj=0; sj<sx.length; sj++) sx[sj].classList.remove('on');
      b.classList.add('on'); paintSettingsTab(b.getAttribute('data-tab'));
    });
  })(stabs[sti]);
  paintSettingsTab('reports');
}
function paintSettingsTab(tab){
  var body=document.getElementById('stabbody'); if(!body) return;
  if(tab!=='reports'){ body.innerHTML=''; return; }
  function getToken(){ try{ return localStorage.getItem('aw_gh_token')||''; }catch(e){ return ''; } }
  function fbGetToken(){ return getToken(); }
  function getOutbox(){ try{ return JSON.parse(localStorage.getItem('aw_outbox')||'[]'); }catch(e){ return []; } }
  function fbGetOutbox(){ return getOutbox(); }
  var o=[], tok='';
  try{ o=fbGetOutbox()||[]; }catch(e){}
  try{ tok=fbGetToken()||''; }catch(e){}
  var html='<div style="margin-bottom:10px;font-size:12px;color:#9aa7bd">GitHub token:<br>'
    +'<input id="tokinp" type="password" placeholder="paste token" value="'+tok+'" '
    +'style="background:#141b28;color:#fff;border:1px solid #2c384a;border-radius:8px;padding:6px 8px;width:200px;font-size:12px;margin:4px 0;"> '
    +'<button class="obtn" id="toksave">Save</button><br>'
    +'<span style="font-size:11px;color:#66738c">stays on this device; files reports without signing in</span></div>';
  html+='<div class="hd" style="margin:8px 0 4px">Unpublished reports ('+o.length+')</div>';
  if(o.length){
    html+='<div style="margin-bottom:8px"><button class="obtn" id="sendall" style="width:100%;padding:8px">'
      +'Submit all unpublished ('+o.length+')</button></div>';
  } else {
    html+='<div class="chint">Nothing waiting. All caught up.</div>';
  }
  html+='<div class="rlist">';
  o.forEach(function(r,i){
    html+='<div class="rrow" style="cursor:default"><div style="flex:1"><b>'+r.t+'</b><br>'
      +'<span style="color:#9aa7bd;font-size:11px">'+String(r.when||'').slice(0,16).replace('T',' ')+'</span></div>'
      +'<button class="obtn" data-i="'+i+'" data-a="send">Send</button>'
      +'<button class="obtn" data-i="'+i+'" data-a="copy">Copy</button>'
      +'<button class="obtn" data-i="'+i+'" data-a="del">\\u2715</button></div>';
  });
  body.innerHTML=html+'</div>';
  var tokinpEl=document.getElementById('tokinp');
  try{ tokinpEl.value=localStorage.getItem('aw_gh_token')||''; }catch(e){}
  tokinpEl.addEventListener('input',function(){
    try{ localStorage.setItem('aw_gh_token',tokinpEl.value.trim()); }catch(e){}
  });
  document.getElementById('toksave').addEventListener('click',function(){
    var btn=this, tok=tokinpEl.value.trim();
    try{ localStorage.setItem('aw_gh_token',tok); }catch(e){}
    if(!tok){ btn.textContent='Paste a token first'; return; }
    btn.textContent='Checking…'; btn.disabled=true;
    // validate: can this token actually file issues?
    fetch('https://api.github.com/repos/kingmarkarnold-code/adamsville-watcher',{
      headers:{ 'Authorization':'Bearer '+tok, 'Accept':'application/vnd.github+json' }
    }).then(function(r){
      btn.disabled=false;
      if(r.ok){ btn.textContent='✓ Valid — saved';
        setTimeout(function(){ if(typeof rosterHide==='function') rosterHide(); },1500); }
      else if(r.status===401||r.status===403){ btn.textContent='✗ Invalid token'; }
      else { btn.textContent='✓ Saved (could not verify)'; }
      setTimeout(function(){ btn.textContent='Save'; },3000);
    }).catch(function(){
      btn.disabled=false; btn.textContent='✓ Saved (offline — not verified)';
      setTimeout(function(){ btn.textContent='Save'; },3000);
    });
  });
  var sa=document.getElementById('sendall');
  if(sa) sa.addEventListener('click',submitAllReports);
  var btns=body.querySelectorAll('.obtn[data-i]');
  for(var bi=0;bi<btns.length;bi++)(function(b){
    b.addEventListener('click',function(e){
      e.stopPropagation();
      var i=+b.getAttribute('data-i'), a=b.getAttribute('data-a');
      if(a==='send') sendOneReport(i);
      else if(a==='copy'){
        var oo2=(typeof fbGetOutbox==='function'?fbGetOutbox():getOutbox()), r=oo2[i]; if(!r) return;
        var ta=document.createElement('textarea'); ta.value=r.t+'\\n\\n'+r.b;
        document.body.appendChild(ta); ta.select();
        try{ document.execCommand('copy'); }catch(e){}
        document.body.removeChild(ta); b.textContent='Copied';
      } else {
        var oo3=(typeof fbGetOutbox==='function'?fbGetOutbox():getOutbox());
        oo3.splice(i,1);
        (typeof fbSaveOutbox==='function'?fbSaveOutbox:saveOutbox)(oo3);
        if(typeof updateOutboxBtn==='function') updateOutboxBtn();
        paintSettingsTab('reports');
      }
    });
  })(btns[bi]);
}
function sendOneReport(i){
  var oo=(typeof fbGetOutbox==='function'?fbGetOutbox():getOutbox()), r=oo[i]; if(!r) return;
  var done=function(ok){
    if(ok){ oo.splice(i,1); (typeof fbSaveOutbox==='function'?fbSaveOutbox:saveOutbox)(oo); }
    if(typeof updateOutboxBtn==='function') updateOutboxBtn();
    paintSettingsTab('reports');
  };
  if(typeof fbFileAPI==='function' && fbGetToken()) fbFileAPI(r.t,r.b,'feedback',done);
  else {
    window.open('https://github.com/kingmarkarnold-code/adamsville-watcher/issues/new'
      +'?title='+encodeURIComponent(r.t)+'&body='+encodeURIComponent(r.b)
      +'&labels='+encodeURIComponent('feedback'),'_blank');
    done(true);
  }
}
function submitAllReports(){
  var btn=document.getElementById('sendall'); if(btn){ btn.textContent='Submitting…'; btn.disabled=true; }
  var tok=(typeof fbGetToken==='function'?fbGetToken():getToken());
  if(!tok){ alert('Paste your GitHub token first — batch submit needs it.'); paintSettingsTab('reports'); return; }
  var oo=(typeof fbGetOutbox==='function'?fbGetOutbox():getOutbox());
  var pending=oo.slice(), idx=0;
  function next(){
    if(idx>=pending.length){
      var rest=(typeof fbGetOutbox==='function'?fbGetOutbox():getOutbox());
      var confirmedKeys={};
      pending.forEach(function(r){ if(r._ok) confirmedKeys[r.t+'|'+r.when]=1; });
      rest=rest.filter(function(r){ return !confirmedKeys[r.t+'|'+r.when]; });
      (typeof fbSaveOutbox==='function'?fbSaveOutbox:saveOutbox)(rest);
      if(typeof updateOutboxBtn==='function') updateOutboxBtn();
      paintSettingsTab('reports');
      return;
    }
    var r=pending[idx++];
    if(btn) btn.textContent='Submitting '+idx+' of '+pending.length+'…';
    fetch('https://api.github.com/repos/kingmarkarnold-code/adamsville-watcher/issues',{
      method:'POST',
      headers:{ 'Authorization':'Bearer '+tok, 'Accept':'application/vnd.github+json',
        'Content-Type':'application/json' },
      body: JSON.stringify({ title:r.t, body:r.b, labels:['feedback'] })
    }).then(function(resp){ r._ok=resp.ok; next(); }).catch(function(){ next(); });
  }
  next();
}

document.getElementById('crewshead').addEventListener('click', function () {
  if (roster.style.display === 'block') rosterHide(); else rosterShow();
});
document.getElementById('outboxbtn').addEventListener('click', showSettings);
updateOutboxBtn();

/* ---------------- main loop ---------------- */
var lastT = 0;
function frame(t) {
  if (window.AW_ACTIVE_VIEW === '3d') { requestAnimationFrame(frame); return; }
  var dt = Math.min(0.1, (t - lastT) / 1000 || 0.016); lastT = t;
  for (var i = 0; i < vehicles.length; i++) stepVehicle(vehicles[i], dt);
  if (show.npc) stepNpcs(dt);
  if (follow) {
    view.cx += (follow.x - view.cx) * 0.12;
    view.cy += (follow.z - view.cy) * 0.12;
    staticDirty = true;
  }
  if (staticDirty) renderStatic();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.drawImage(staticCv, 0, 0, staticCv.width / DPR, staticCv.height / DPR);
  // NPCs
  if (show.npc) {
    ctx.fillStyle = 'rgba(160,170,190,0.35)';
    for (var n = 0; n < npcs.length; n++) {
      var np = w2s(npcs[n].x, npcs[n].z);
      if (np[0] < -5 || np[0] > cv.width / DPR + 5 || np[1] < -5 || np[1] > cv.height / DPR + 5) continue;
      ctx.fillRect(np[0] - 1, np[1] - 1, 2, 2);
    }
  }
  // vehicles
  for (var vi = 0; vi < vehicles.length; vi++) {
    var v = vehicles[vi], sp = w2s(v.x, v.z);
    if (sp[0] < -20 || sp[0] > cv.width / DPR + 20 || sp[1] < -20 || sp[1] > cv.height / DPR + 20) continue;
    var col = TEAMS[v.team].color, r = (v === follow) ? 8 : 5.5;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(sp[0], sp[1], r, 0, 7); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = v === follow ? 2.5 : 1.2;
    ctx.beginPath(); ctx.arc(sp[0], sp[1], r, 0, 7); ctx.stroke();
    if (v === follow || view.scale > 0.6) {
      ctx.fillStyle = '#fff'; ctx.font = '600 10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(TEAMS[v.team].unit.split(' ')[0] + ' ' + (v.id + 1), sp[0], sp[1] - r - 4);
      if(v.stuck){
        ctx.strokeStyle='#ff3b30'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.arc(sp[0], sp[1], r+6+Math.sin(Date.now()/200)*2, 0, 7); ctx.stroke();
      }
      if(v.escortFor){
        ctx.strokeStyle='#3a7bff'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.arc(sp[0], sp[1], r+6, 0, 7); ctx.stroke();
      }
    }
  }
  requestAnimationFrame(frame);
}

/* ---------------- boot ---------------- */
document.getElementById('reportline').textContent = WORLD.reportSummary || '';
function tickStats() {
  var el = document.getElementById('stats');
  var d = new Date();
  el.innerHTML = '<b>' + vehicles.length + '</b> units live · <b>' + findings.length + '</b> flags<br>' +
    d.toLocaleTimeString() + ' · data ' + String(WORLD.generated || '').slice(0, 10);
}
setInterval(tickStats, 1000); tickStats();
resize(); fit();
requestAnimationFrame(frame);
})();
