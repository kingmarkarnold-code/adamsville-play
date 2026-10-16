#!/usr/bin/env node
/* ============================================================================
   Surviving Adamsville: Mollie's Edition — ROAD INSPECTOR + CODE ENFORCEMENT
   The computer-side inspector rig (the phone game keeps "Surviving Adamsville").
   Joshua's idea: like real-world road crews, AI inspector cars drive every
   street in the game and report what's wrong. Code enforcement agents walk
   every placed building and flag violations.

   Run:  node inspect-roads.js        (from ~/workspace/game-map/project/)
   Out:  ~/workspace/game-map/diag/road-inspection.json

   NOT part of the APK. Node-only. Reuses the game's own data files
   (www/roads.js, www/elev.js, www/osm_buildings.js) and replicates the
   game's height math (heightAt / terrainMeshY / roadSitY / smoothHeights)
   exactly, so the crew tests what the player actually drives.
   ========================================================================== */
var fs = require('fs');
var path = require('path');

var PROJ = __dirname;                                   // .../game-map/project
var WWW  = path.join(PROJ, 'www');
var DIAG = path.join(PROJ, 'diag');
var OUT_DIR = path.join(path.dirname(PROJ), 'diag');   // .../game-map/diag
var OUT = path.join(OUT_DIR, 'road-inspection.json');

var t0 = Date.now();
function log(){ console.log.apply(console, arguments); }

/* ---------------- Code Enforcement Office (central filing) -------------- */
var CodeEnforcementOffice = require(path.join(PROJ,'diag','office.js'));
var office = new CodeEnforcementOffice({ outDir: OUT_DIR });
office.registerTeam('roads');
office.registerTeam('buildings');
office.registerTeam('planner');
office.registerTeam('inspector');
office.registerTeam('furniture');

/* ---------------- run mode: single | --every <interval> | --stamp ------- */
var EVERY_MS = 0, STAMP = false;
(function parseArgs(){
  var a = process.argv.slice(2), pass = [];
  for (var i=0;i<a.length;i++){
    if (a[i]==='--every' && a[i+1]){ EVERY_MS = parseEvery(a[i+1]); i++; }
    else if (a[i]==='--stamp'){ STAMP = true; }
    else if (a[i]==='--interval-child'){ /* internal: plain single run */ }
    else pass.push(a[i]);
  }
  function parseEvery(s){
    var m = String(s).match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr)?$/i);
    if (!m) throw new Error('bad --every value: '+s+' (use e.g. 10m, 30s, 1h)');
    var n = parseFloat(m[1]), u = (m[2]||'m').toLowerCase();
    return n * (u[0]==='h'?3600000 : u[0]==='s'?1000 : 60000);
  }
  if (EVERY_MS>0){
    /* Interval mode: this process becomes the dispatcher. Each cycle it
       spawns a FRESH child (no --every flag) so every report re-reads the
       game data and starts clean. Children write timestamped reports. */
    var cp = require('child_process');
    log('interval mode: full inspection every '+(EVERY_MS/60000)+' min — timestamped reports to '+OUT_DIR);
    var cycle = function(){
      try{
        cp.spawnSync(process.execPath, [__filename,'--interval-child','--stamp'].concat(pass), {stdio:'inherit'});
      }catch(e){ log('cycle failed: '+e.message); }
    };
    cycle();
    setInterval(cycle, EVERY_MS);
    global.__DISPATCHER__ = true;   // dispatcher only: do not run inspection inline
    return;
  }
})();
function stampName(){
  var d=new Date(), p=function(n){return (n<10?'0':'')+n;};
  return 'road-inspection-'+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+
    '-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds())+'.json';
}

/* The dispatcher process (interval mode parent) stops here — it only
   spawns children. Everything below is the single inspection run. */
if (!global.__DISPATCHER__) {

/* ---------------- load game data files (single source of truth) ---------- */
function loadVar(file, name){
  var src = fs.readFileSync(file, 'utf8');
  var val;
  var fn = new Function(src + '\nreturn ' + name + ';');
  val = fn();
  return val;
}
var ROAD_DATA = loadVar(path.join(WWW,'roads.js'), 'ROAD_DATA');
var ELEV      = loadVar(path.join(WWW,'elev.js'), 'ELEV');
var OSM_BUILDINGS = loadVar(path.join(WWW,'osm_buildings.js'), 'OSM_BUILDINGS');
var OSM_REAL_COUNT = 8000;
try { OSM_REAL_COUNT = loadVar(path.join(WWW,'osm_buildings.js'), 'OSM_REAL_COUNT'); } catch(e){}

/* ---------------- world constants (copied from www/index.html) ----------- */
var LON_MIN=-84.6209, LON_RANGE=0.2418, LAT_MAX=33.8392, LAT_RANGE=0.3184;
var WX=8000, WZ=12000;
var ELEV_SCALE = 60/(ELEV.max - ELEV.min);
function xz(lat, lon){ return { x:(lon-LON_MIN)/LON_RANGE*WX, z:(LAT_MAX-lat)/LAT_RANGE*WZ }; }
function latLon(x, z){ return { lat: LAT_MAX - z/WZ*LAT_RANGE, lon: LON_MIN + x/WX*LON_RANGE }; }
var HOME = xz(33.7411, -84.52645);
var DM_ENT = { x:3064, z:3290 };
var TATUM_N = xz(33.75073, -84.52388);

function elevRaw(lat, lon){
  var i=(lon-ELEV.lon0)/ELEV.dLon, j=(lat-ELEV.lat0)/ELEV.dLat;
  i=Math.max(0,Math.min(ELEV.cols-1.001,i));
  j=Math.max(0,Math.min(ELEV.rows-1.001,j));
  var i0=Math.floor(i), j0=Math.floor(j), fi=i-i0, fj=j-j0;
  var a=ELEV.g[j0][i0], b=ELEV.g[j0][i0+1], c=ELEV.g[j0+1][i0], d=ELEV.g[j0+1][i0+1];
  return a+(b-a)*fi+(c-a)*fj+(a-b-c+d)*fi*fj;
}
function gauss(x,z,cx,cz,amp,sig){
  var dx=x-cx, dz=z-cz;
  return amp*Math.exp(-(dx*dx+dz*dz)/(2*sig*sig));
}
/* EXACT replica of heightAt() in www/index.html (v1.8) */
function heightAt(x, z){
  var ll = latLon(x, z);
  var h = (elevRaw(ll.lat, ll.lon) - ELEV.min) * ELEV_SCALE;
  (function(){
    var dx=x-DM_ENT.x, dz=z-DM_ENT.z;
    var u=dx*0.12+dz*0.99;
    var v=-dx*0.99+dz*0.12;
    var sig=u<0?220:420;
    h += 34*Math.exp(-(u*u/(2*sig*sig) + v*v/(2*130*130)));
  })();
  h += gauss(x, z, HOME.x+30, HOME.z-40, 3.0, 55);
  h -= gauss(x, z, HOME.x-70, HOME.z+60, 2.0, 70);
  h += gauss(x, z, TATUM_N.x, TATUM_N.z, -5.0, 55);
  h += 0.5*Math.sin(x*0.011)*Math.cos(z*0.009) + 0.25*Math.sin(x*0.031+1.7)*Math.sin(z*0.027+0.6);
  return h;
}

/* ---------------- rendered-mesh heightfield (v1.8 fixed, no z-flip) ------- */
log('building terrain mesh grid (201x301)...');
var TERR_H = new Float32Array(201*301);
for (var iy=0; iy<301; iy++)
  for (var ix=0; ix<201; ix++)
    TERR_H[iy*201+ix] = heightAt(ix*40, iy*40);

function terrainMeshY(x,z){
  var fx=Math.max(0,Math.min(200-0.001,x/40)), fz=Math.max(0,Math.min(300-0.001,z/40));
  var ix=Math.floor(fx), iz=Math.floor(fz), u=fx-ix, v=fz-iz;
  var i00=iz*201+ix;
  var a=TERR_H[i00], b=TERR_H[i00+1], c=TERR_H[i00+201], d=TERR_H[i00+202];
  return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;
}
function roadSitY(x,z){
  var mh=terrainMeshY(x,z);
  return (mh>-1e8?mh:heightAt(x,z));
}
/* smoothing + roughness: exact replicas */
function maPass(arr, W){
  var hw=(W-1)/2, out=new Array(arr.length);
  for (var i=0;i<arr.length;i++){
    var sum=0, cnt=0;
    for (var k=-hw;k<=hw;k++){
      var j=i+k;
      if (j<0) j=-j;
      if (j>=arr.length) j=2*(arr.length-1)-j;
      sum+=arr[j]; cnt++;
    }
    out[i]=sum/cnt;
  }
  return out;
}
function smoothHeights(pts, raw){
  var p1=maPass(raw, 11), p2=maPass(p1, 11);
  var out=new Array(pts.length);
  for (var i=0;i<pts.length;i++){
    var base=roadSitY(pts[i][0],pts[i][1]);
    out[i]=Math.max(p2[i], base+0.2);
  }
  return out;
}
function roughness(ys){
  if(ys.length<3) return 0;
  var sum=0;
  for (var i=1;i<ys.length-1;i++) sum+=Math.abs(ys[i-1]-2*ys[i]+ys[i+1]);
  return sum/(ys.length-2);
}
function densify(pts, maxStep){
  var out=[];
  for (var i=0;i<pts.length;i++){
    var a=pts[i];
    if (i>0){
      var p=pts[i-1], d=Math.hypot(a[0]-p[0],a[1]-p[1]);
      var n=Math.ceil(d/maxStep);
      for (var k=1;k<n;k++){ var t=k/n; out.push([p[0]+(a[0]-p[0])*t, p[1]+(a[1]-p[1])*t]); }
    }
    out.push(a);
  }
  return out;
}
function clipToWorld(pts, margin){
  margin=(margin===undefined)?100:margin;
  var out=[], cur=[];
  function inside(p){ return p[0]>=-margin && p[0]<=WX+margin && p[1]>=-margin && p[1]<=WZ+margin; }
  for (var i=0;i<pts.length;i++){
    if (inside(pts[i])) cur.push(pts[i]);
    else { if (cur.length>1) out.push(cur); cur=[]; }
  }
  if (cur.length>1) out.push(cur);
  return out;
}
function gapRuns(pts, gaps){
  var runs=[], cur=[];
  pts.forEach(function(p){
    var drop=false;
    for (var i=0;i<gaps.length;i++){ var g=gaps[i];
      if (Math.hypot(p[0]-g[0],p[1]-g[1])<g[2]){ drop=true; break; } }
    if (drop){ if (cur.length>1) runs.push(cur); cur=[]; }
    else cur.push(p);
  });
  if (cur.length>1) runs.push(cur);
  return runs;
}

/* ---------------- replicate buildRoads() -> runs[] ------------------------ */
var ROAD_WIDTHS = { highway: 22, arterial: 11, local: 7 };
var INTERSTATES={'I- 20':1,'State Rte 402':1,'I- 85':1,'State Rte 403':1,
  'I- 75':1,'State Rte 401':1,'I- 285':1,'I-285':1,'State Rte 407':1};
var MLK_GAP=[[4154,3229,120]];
var OP_GAP=[[3646.8,2783.8,48],[3338,2711,48]];   // I-20 overpass decks (visual only)

var runs=[];   // {name,cat,w,lanes,markings,pts,ys,src}
function addRun(name, cat, rawPts, opt){
  opt=opt||{};
  var w=ROAD_WIDTHS[cat];
  var isInterstate=(cat==='highway'&&INTERSTATES[name]);
  if (isInterstate) w=34;
  var split=[rawPts];
  if (/Martin Luther King Jr Dr/.test(name)) split=gapRuns(rawPts, MLK_GAP);
  else if (name==='I- 20'||name==='State Rte 402') split=gapRuns(rawPts, OP_GAP);
  split.forEach(function(pts){
    if (pts.length<2) return;
    clipToWorld(pts,100).forEach(function(cpts){
      var dpts=densify(cpts,20);
      if (dpts.length<2) return;
      var draw=[]; for (var di=0; di<dpts.length; di++) draw.push(roadSitY(dpts[di][0],dpts[di][1])+0.55);
      var dys=smoothHeights(dpts, draw);
      var markings = (cat==='local') ? 'dashes' : 'divider+dashes';
      runs.push({name:name, cat:cat, w:w, lanes:isInterstate?5:0,
        markings:opt.markings||markings, pts:dpts, ys:dys, src:opt.src||'tiger'});
    });
  });
}

log('building road runs (replicating buildRoads)...');
['highway','arterial','local'].forEach(function(cat){
  (ROAD_DATA[cat]||[]).forEach(function(r){ addRun(r.name, cat, r.pts); });
});
/* Fulton Industrial Blvd (manual road, same pipeline) */
(function(){
  var fiPts=[[3806,2060],[3680,2140],[3560,2220],[3470,2300],[3400,2400],[3360,2500],[3342,2606],[3340,2660],[3338,2711],[3336,2780]];
  addRun('Fulton Industrial Blvd SW','arterial',fiPts,{markings:'dashes',src:'manual-fi'});
})();
/* MLK/I-285 overpass ramps + deck (replica of mlkRamps, v1.6 anchored) */
(function(){
  var cx=4154, cz=3229, yaw=1.114;
  var dx=Math.sin(yaw), dz=Math.cos(yaw);
  var deckTopY=heightAt(cx,cz)+9.1, w=11, deckHalf=42;
  function mlkRoadEnd(side){
    var best=null, bd=1e9;
    runs.forEach(function(r){
      if(!/Martin Luther King Jr Dr SW/.test(r.name||'')) return;
      if(/overpass/.test(r.name||'')) return;
      [[r.pts[0],r.ys[0]],[r.pts[r.pts.length-1],r.ys[r.ys.length-1]]].forEach(function(e){
        var x=e[0][0], z=e[0][1];
        if(side<0 ? x>cx-50 : x<cx+50) return;
        var d=Math.hypot(x-cx,z-cz);
        if(d<bd){ bd=d; best={x:x,z:z,y:e[1]}; }
      });
    });
    return best;
  }
  [-1,1].forEach(function(side){
    var deckEdge=[cx+dx*side*deckHalf, cz+dz*side*deckHalf];
    var re=mlkRoadEnd(side), sx, sz, y0;
    if (re){ sx=re.x; sz=re.z; y0=re.y; }
    else { sx=cx+dx*side*125; sz=cz+dz*side*125; y0=roadSitY(sx,sz)+0.55; }
    var dist=Math.hypot(deckEdge[0]-sx, deckEdge[1]-sz);
    var n=Math.max(8, Math.round(dist/10)), pts=[], ys=[];
    for (var i=0;i<=n;i++){
      var t=i/n, s=t*t*(3-2*t);
      pts.push([sx+(deckEdge[0]-sx)*t, sz+(deckEdge[1]-sz)*t]);
      ys.push(y0+(deckTopY-y0)*s);
    }
    runs.push({name:'Martin Luther King Jr Dr SW (overpass ramp)',cat:'arterial',
      w:w,lanes:0,markings:'dashes',pts:pts,ys:ys,src:'mlk-ramp'});
  });
  var dpts=[], dys=[];
  for (var di=0; di<=8; di++){
    var t=-deckHalf+2*deckHalf*di/8;
    dpts.push([cx+dx*t, cz+dz*t]); dys.push(deckTopY+0.1);
  }
  runs.push({name:'Martin Luther King Jr Dr SW (overpass deck)',cat:'arterial',
    w:w,lanes:0,markings:'dashes',pts:dpts,ys:dys,src:'mlk-deck'});
})();
log('  runs built: '+runs.length);

/* ---------------- road surface grid (replica of buildRoadGrids) ---------- */
var roadSurfGrid={cell:40,map:{}};
runs.forEach(function(r){
  var hw=r.w/2+1.5;
  for (var i=0;i<r.pts.length-1;i++){
    var ax=r.pts[i][0], az=r.pts[i][1], bx=r.pts[i+1][0], bz=r.pts[i+1][1];
    var seg=[ax,az,bx,bz,r.ys[i],r.ys[i+1],hw,r.name,r.cat];
    var c0=Math.floor((Math.min(ax,bx)-hw)/40), c1=Math.floor((Math.max(ax,bx)+hw)/40);
    var d0=Math.floor((Math.min(az,bz)-hw)/40), d1=Math.floor((Math.max(az,bz)+hw)/40);
    for (var cx=c0;cx<=c1;cx++) for (var cz=d0;cz<=d1;cz++){
      var k=cx+','+cz;
      (roadSurfGrid.map[k]=roadSurfGrid.map[k]||[]).push(seg);
    }
  }
});
function gridSegsNear(x,z,pad){
  var out=[], ccx=Math.floor(x/40), ccz=Math.floor(z/40), p=pad||1;
  for (var ix=ccx-p; ix<=ccx+p; ix++) for (var iz=ccz-p; iz<=ccz+p; iz++){
    var a=roadSurfGrid.map[ix+','+iz]; if(a) out.push.apply(out,a);
  }
  return out;
}
function distToRoadEdge(x,z){
  var best=1e9, segs=gridSegsNear(x,z,1), seen={};
  for(var i=0;i<segs.length;i++){
    var s=segs[i];
    if(seen[s]) continue; seen[s]=1;
    var vx=s[2]-s[0], vz=s[3]-s[1], len2=vx*vx+vz*vz;
    var t=len2>0?((x-s[0])*vx+(z-s[1])*vz)/len2:0; t=Math.max(0,Math.min(1,t));
    var d=Math.hypot(x-(s[0]+vx*t), z-(s[1]+vz*t))-s[6];
    if(d<best) best=d;
  }
  return best;
}

/* ---------------- water (replica of buildWater) -------------------------- */
var lakeC=xz(33.74946,-84.52388), pondC=xz(33.74795,-84.52161);
pondC={x:pondC.x+40, z:pondC.z-25};
var WATER=[
  {x:lakeC.x, z:lakeC.z, rx:75, rz:48, name:'TATUM LAKE'},
  {x:pondC.x, z:pondC.z, rx:38, rz:26, name:'POND'}
];
var CREEK_OSM=null;
try{
  var idx=fs.readFileSync(path.join(WWW,'index.html'),'utf8');
  var m=idx.match(/var CREEK_OSM=(\[.*?\]);/s);
  if(m) CREEK_OSM=eval('('+m[1]+')');
}catch(e){}
if (CREEK_OSM) WATER.push({creek:CREEK_OSM, name:'creek'});
function distToCreek(x,z){
  var pts=null;
  for (var i=0;i<WATER.length;i++) if (WATER[i].creek) pts=WATER[i].creek;
  if (!pts) return 1e9;
  var best=1e9;
  for (var i=0;i<pts.length-1;i++){
    var ax=pts[i][0], az=pts[i][1], bx=pts[i+1][0], bz=pts[i+1][1];
    var vx=bx-ax, vz=bz-az, len2=vx*vx+vz*vz;
    var t=len2>0?((x-ax)*vx+(z-az)*vz)/len2:0; t=Math.max(0,Math.min(1,t));
    var d=Math.hypot(x-(ax+vx*t), z-(az+vz*t));
    if (d<best) best=d;
  }
  return best;
}
function inWater(x,z){
  for (var i=0;i<WATER.length;i++){
    var w=WATER[i];
    if (w.creek){ if (distToCreek(x,z)<4.5) return w.name; }
    else { var dx=(x-w.x)/w.rx, dz=(z-w.z)/w.rz; if (dx*dx+dz*dz<1) return w.name; }
  }
  return null;
}

/* ============================================================================
   ROAD INSPECTORS — 16 agents, one per map zone (4x4). Each patrols its beat:
   drives every run in a greedy nearest-neighbor route and measures 5 defect
   classes per run: gaps, roughness, float/bury, markings, cliffs.
   ========================================================================== */
var GAP_DIST=80, BORDER_M=150, JOINT_DIST=90;
var issues=[], issueKeys={};
function addIssue(o){
  var key=o.type+'|'+o.road+'|'+Math.round(o.x/20)+'|'+Math.round(o.z/20);
  if (issueKeys[key]) return;
  issueKeys[key]=1; issues.push(o);
  office.submit('roads', o);   // filed with the Code Enforcement Office
}
/* spatial hash of every run point for nearest-point queries */
var PHASH={}, PCELL=100;
function phKey(x,z){ return Math.floor(x/PCELL)+','+Math.floor(z/PCELL); }
runs.forEach(function(r,ri){
  for (var pi=0; pi<r.pts.length; pi++){
    var k=phKey(r.pts[pi][0], r.pts[pi][1]);
    (PHASH[k]=PHASH[k]||[]).push({x:r.pts[pi][0], z:r.pts[pi][1], run:ri, pt:pi, y:r.ys[pi]});
  }
});
function nearestOtherPoint(x, z, skipRun, maxD){
  var c0=Math.floor((x-maxD)/PCELL), c1=Math.floor((x+maxD)/PCELL);
  var d0=Math.floor((z-maxD)/PCELL), d1=Math.floor((z+maxD)/PCELL);
  var best=null, bd=maxD;
  for (var cx=c0;cx<=c1;cx++) for (var cz=d0;cz<=d1;cz++){
    var a=PHASH[cx+','+cz]; if(!a) continue;
    for (var i=0;i<a.length;i++){
      var p=a[i]; if (p.run===skipRun) continue;
      var d=Math.hypot(p.x-x, p.z-z);
      if (d<bd){ bd=d; best=p; }
    }
  }
  return best?{d:bd, p:best}:null;
}
function nearBorder(x,z){ return x<BORDER_M||x>WX-BORDER_M||z<BORDER_M||z>WZ-BORDER_M; }
function nearOverpassDeck(x,z){
  for (var i=0;i<OP_GAP.length;i++)
    if (Math.hypot(x-OP_GAP[i][0], z-OP_GAP[i][1])<150) return true;
  return false;
}
/* normalize road names for "same road?" checks: strip directionals,
   street-type suffixes, parentheticals, spaces/punctuation */
function normName(n){
  return String(n||'').replace(/\([^)]*\)/g,'')
    .replace(/\b(SW|SE|NW|NE)\b/gi,'')
    .replace(/\b(Dr|St|Rd|Ave|Blvd|Ct|Ln|Way|Pkwy|Cir|Pl|Ter|Trail|Drive|Street|Road)\b\.?/gi,'')
    .replace(/[^a-z0-9]/gi,'').toLowerCase();
}

var inspectors=[];
for (var zi=0; zi<16; zi++){
  var qx=zi%4, qz=Math.floor(zi/4);
  var zx0=qx*WX/4, zx1=(qx+1)*WX/4, zz0=qz*WZ/4, zz1=(qz+1)*WZ/4;
  var beat=[];
  runs.forEach(function(r,ri){
    var mx=0,mz=0;
    for (var i=0;i<r.pts.length;i+=Math.max(1,Math.floor(r.pts.length/8))){ mx+=r.pts[i][0]; mz+=r.pts[i][1]; }
    var n=Math.min(8,r.pts.length); mx/=n; mz/=n;
    if (mx>=zx0&&mx<zx1&&mz>=zz0&&mz<zz1) beat.push(ri);
  });
  inspectors.push({id:zi, zone:[Math.round(zx0),Math.round(zz0),Math.round(zx1),Math.round(zz1)],
    beat:beat, runsDriven:0, kmDriven:0, issues:0});
}

function driveRun(insp, ri){
  var r=runs[ri], n=r.pts.length;
  insp.runsDriven++;
  var dist=0;
  for (var i=1;i<n;i++) dist+=Math.hypot(r.pts[i][0]-r.pts[i-1][0], r.pts[i][1]-r.pts[i-1][1]);
  insp.kmDriven+=dist/1000;
  function iss(type, sev, x, z, detail){
    insp.issues++;
    addIssue({crew:'roads', inspector:insp.id, road:r.name, cat:r.cat,
      x:Math.round(x*10)/10, z:Math.round(z*10)/10,
      type:type, severity:sev, detail:detail});
  }
  /* --- 1. GAPS: dead ends that connect to nothing --- */
  [[r.pts[0],r.ys[0],'start'],[r.pts[n-1],r.ys[n-1],'end']].forEach(function(e){
    var x=e[0][0], z=e[0][1];
    if (nearBorder(x,z)) return;                       // map edge: intentional
    var hit=nearestOtherPoint(x,z,ri,GAP_DIST*4);
    if (!hit || hit.d>GAP_DIST){
      var sev=(!hit||hit.d>500)?'critical':(hit.d>200?'high':'medium');
      var detail='road ends at ('+Math.round(x)+','+Math.round(z)+') with '+
        (hit?('nearest other road '+Math.round(hit.d)+'u away ('+runs[hit.p.run].name+')'):'no other road within '+GAP_DIST*4+'u');
      if (nearOverpassDeck(x,z)) detail+=' — at I-20 overpass deck (deck has no drivable surface)';
      iss('gap', sev, x, z, detail);
    } else {
      /* joint cliff: only when the roads actually look like they should join —
         same road (name match after normalization) or very close (<25u).
         (Nearby-but-different roads at different heights are normal.) */
      var step=Math.abs(e[1]-hit.p.y);
      var nn1=normName(r.name), nn2=normName(runs[hit.p.run].name);
      var sameRoad = nn1 && nn1===nn2;
      if (step>1.5 && (sameRoad || hit.d<25)){
        iss('cliff', step>3?'high':'medium', x, z,
          'joint to '+runs[hit.p.run].name+' ('+e[2]+', '+Math.round(hit.d)+'u away): height step '+step.toFixed(2)+'u');
      }
    }
  });
  /* --- 2. ROUGHNESS: road bumpier than the ground under it --- */
  var rr=roughness(r.ys);
  if (n>10){
    var ty=new Array(n);
    for (var i2=0;i2<n;i2++) ty[i2]=terrainMeshY(r.pts[i2][0],r.pts[i2][1]);
    var tr=roughness(ty);
    if (rr>0.3 && rr>2.5*Math.max(tr,0.01))
      iss('roughness','medium', r.pts[Math.floor(n/2)][0], r.pts[Math.floor(n/2)][1],
        'road roughness '+rr.toFixed(3)+' vs terrain '+tr.toFixed(3)+' (v1.8 z-flip class)');
  }
  /* --- 3. FLOATING / BURIED vs the visible terrain --- */
  var worstB=null, worstF=null;
  for (var i3=0;i3<n;i3++){
    var d=r.ys[i3]-terrainMeshY(r.pts[i3][0],r.pts[i3][1]);
    if (d<-0.5 && (!worstB||d<worstB.d)) worstB={d:d,x:r.pts[i3][0],z:r.pts[i3][1]};
    if (d>3.0  && (!worstF||d>worstF.d)) worstF={d:d,x:r.pts[i3][0],z:r.pts[i3][1]};
  }
  if (worstB) iss('buried','high',worstB.x,worstB.z,'road '+worstB.d.toFixed(2)+'u under visible terrain');
  if (worstF) iss('floating',worstF.d>6?'high':'medium',worstF.x,worstF.z,'road '+worstF.d.toFixed(2)+'u above visible terrain');
  /* --- 4. MARKINGS: class-appropriate width/lanes/markings --- */
  var expW = (r.cat==='highway'&&INTERSTATES[r.name])?34:ROAD_WIDTHS[r.cat];
  if (Math.abs(r.w-expW)>0.01)
    iss('markings','medium',r.pts[0][0],r.pts[0][1],'width '+r.w+'u but class '+r.cat+' expects '+expW+'u');
  if (r.cat==='highway'&&INTERSTATES[r.name]&&r.lanes!==5)
    iss('markings','medium',r.pts[0][0],r.pts[0][1],'interstate with lanes='+r.lanes+' (expect 5/dir)');
  if (!r.markings)
    iss('markings','medium',r.pts[0][0],r.pts[0][1],'no lane-marking scheme assigned');
  /* --- 5a. INTERNAL CLIFFS: sudden steps along the run --- */
  for (var i4=1;i4<n;i4++){
    var st=Math.abs(r.ys[i4]-r.ys[i4-1]);
    if (st>2.5){
      iss('cliff', st>4?'high':'medium',
        (r.pts[i4][0]+r.pts[i4-1][0])/2, (r.pts[i4][1]+r.pts[i4-1][1])/2,
        'height step '+st.toFixed(2)+'u between adjacent points');
      i4+=4;  // don't spam one bad joint
    }
  }
}

log('16 road inspectors patrolling...');
inspectors.forEach(function(insp){
  /* greedy patrol route: nearest unvisited run midpoint next */
  var mids=insp.beat.map(function(ri){
    var r=runs[ri], mx=0,mz=0,c=0;
    for (var i=0;i<r.pts.length;i+=Math.max(1,Math.floor(r.pts.length/4))){mx+=r.pts[i][0];mz+=r.pts[i][1];c++;}
    return {ri:ri, x:mx/c, z:mz/c};
  });
  var cx=(insp.zone[0]+insp.zone[2])/2, cz=(insp.zone[1]+insp.zone[3])/2, seen={};
  var order=[];
  while (order.length<mids.length){
    var bi=-1, bd=1e18;
    for (var i=0;i<mids.length;i++){
      if (seen[i]) continue;
      var d=Math.hypot(mids[i].x-cx, mids[i].z-cz);
      if (d<bd){ bd=d; bi=i; }
    }
    seen[bi]=1; order.push(mids[bi].ri); cx=mids[bi].x; cz=mids[bi].z;
  }
  order.forEach(function(ri){ driveRun(insp, ri); });
});
log('  road issues found: '+issues.length);

/* --- highway continuity audit (crew-level): same-name corridors must
   connect. Catches the I-75-class holes that endpoint checks miss when
   some other road happens to be nearby. --- */
log('highway continuity audit...');
var HWY_NORM={'I- 20':'I-20','State Rte 402':'I-20','I- 85':'I-85','State Rte 403':'I-85',
  'I- 75':'I-75','State Rte 401':'I-75','I-285':'I-285','I- 285':'I-285','State Rte 407':'I-285'};
var hwyGroups={};
runs.forEach(function(r,ri){
  var h=HWY_NORM[r.name]; if(h){ (hwyGroups[h]=hwyGroups[h]||[]).push(ri); }
});
Object.keys(hwyGroups).sort().forEach(function(h){
  var members=hwyGroups[h], worst=0, wx=0, wz=0, wn='';
  members.forEach(function(ri){
    var r=runs[ri];
    [[r.pts[0],r.ys[0]],[r.pts[r.pts.length-1],r.ys[r.ys.length-1]]].forEach(function(e){
      var x=e[0][0], z=e[0][1];
      if (nearBorder(x,z)) return;
      var best=1e9, bn='';
      members.forEach(function(oj){
        if (oj===ri) return;
        var o=runs[oj];
        [[o.pts[0]],[o.pts[o.pts.length-1]]].forEach(function(f){
          var d=Math.hypot(x-f[0][0],z-f[0][1]);
          if(d<best){best=d;bn=o.name;}
        });
      });
      if (best>worst){ worst=best; wx=x; wz=z; wn=bn; }
      if (best>150){
        addIssue({crew:'roads', inspector:'crew', road:r.name, cat:r.cat,
          x:Math.round(x*10)/10, z:Math.round(z*10)/10,
          type:'gap', severity: best>500?'critical':'high',
          detail:h+' corridor broken: '+Math.round(best)+'u to next '+h+' segment'+(bn?(' ('+bn+')'):'')});
      }
    });
  });
  log('  '+h+': '+members.length+' runs, max same-corridor gap '+Math.round(worst)+'u');
});

/* ============================================================================
   CODE ENFORCEMENT — 4 agents. Each inspects every placed building in its
   district (replicating the game's placement protocol exactly) and flags:
     on-road    — footprint inside a road corridor
     in-water   — footprint in the lake, pond, or creek
     floating   — corners hang above the terrain
     buried     — terrain swallows the building
     overlap    — two buildings intersect
     spec       — degenerate footprint data (bad size/type, nudge beyond limit)
   ========================================================================== */
log('code enforcement: replicating building placement protocol...');
function bldgClear(x,z,need){ return distToRoadEdge(x,z) >= need; }
var placed=[], skipped=0, nudged=0;
for (var bi=0; bi<OSM_BUILDINGS.length; bi++){
  var b=OSM_BUILDINGS[bi];
  if (!b || b.length<6) { skipped++; continue; }
  var need=Math.max(b[2],b[3])/2+4;
  if (bldgClear(b[0],b[1],need)){ placed.push({x:b[0],z:b[1],w:b[2],d:b[3],h:b[4],type:b[5],spec:bi,nudged:0,ox:b[0],oz:b[1]}); continue; }
  var p2=null;
  for (var r=6;r<=24 && !p2;r+=6)
    for (var a=0;a<8 && !p2;a++){
      var nx=b[0]+Math.cos(a/8*Math.PI*2)*r, nz=b[1]+Math.sin(a/8*Math.PI*2)*r;
      if (bldgClear(nx,nz,need)) p2=[nx,nz];
    }
  if (p2){ nudged++; placed.push({x:p2[0],z:p2[1],w:b[2],d:b[3],h:b[4],type:b[5],spec:bi,nudged:Math.hypot(p2[0]-b[0],p2[1]-b[1]),ox:b[0],oz:b[1]}); }
  else skipped++;
}
log('  placed: '+placed.length+', skipped: '+skipped+', nudged: '+nudged);

/* AABB overlap hash (buildings are axis-aligned — the game never rotates).
   Uses EXACT footprints: the +0.5 collider margin is the game's business;
   the crew flags what the player SEES overlapping. */
var BHASH={}, BCELL=120;
placed.forEach(function(p,idx){
  var hw=p.w/2, hd=p.d/2;
  p.x0=p.x-hw; p.x1=p.x+hw; p.z0=p.z-hd; p.z1=p.z+hd; p.idx=idx;
  var c0=Math.floor(p.x0/BCELL), c1=Math.floor(p.x1/BCELL);
  var d0=Math.floor(p.z0/BCELL), d1=Math.floor(p.z1/BCELL);
  for (var cx=c0;cx<=c1;cx++) for (var cz=d0;cz<=d1;cz++){
    var k=cx+','+cz; (BHASH[k]=BHASH[k]||[]).push(idx);
  }
});
var violations=[], vKeys={};
function addV(o){
  var key=o.type+'|'+o.spec;
  if (vKeys[key]) return; vKeys[key]=1; violations.push(o);
  office.submit('buildings', o);   // filed with the Code Enforcement Office
}
var agents=[];
for (var ai=0; ai<4; ai++){
  var ax0=(ai%2)*WX/2, ax1=((ai%2)+1)*WX/2, az0=Math.floor(ai/2)*WZ/2, az1=(Math.floor(ai/2)+1)*WZ/2;
  agents.push({id:ai, district:[ax0,az0,ax1,az1], inspected:0, violations:0});
}
placed.forEach(function(p){
  var ag=agents[(p.x>=WX/2?1:0)+(p.z>=WZ/2?2:0)];
  ag.inspected++;
  function vio(type, sev, detail){
    ag.violations++;
    addV({crew:'buildings', agent:ag.id, spec:p.spec, x:Math.round(p.x*10)/10, z:Math.round(p.z*10)/10,
      w:p.w, d:p.d, h:p.h, btype:p.type, nudged:+p.nudged.toFixed(1),
      type:type, severity:sev, detail:detail});
  }
  var need=Math.max(p.w,p.d)/2+4;
  /* on-road */
  var edge=distToRoadEdge(p.x,p.z);
  if (edge<need) vio('on-road','high','distToRoadEdge '+edge.toFixed(1)+'u < need '+need.toFixed(1)+'u');
  /* in-water */
  var wtr=inWater(p.x,p.z);
  if (wtr) vio('in-water','high','footprint inside '+wtr);
  /* floating / buried: game sets base from ANALYTIC heightAt; corners judged on the mesh */
  var gy=heightAt(p.x,p.z), bottom=gy-0.6, bh=Math.max(2.5,p.h);
  var minG=1e9, maxG=-1e9;
  [[p.x-p.w/2,p.z-p.d/2],[p.x+p.w/2,p.z-p.d/2],[p.x-p.w/2,p.z+p.d/2],[p.x+p.w/2,p.z+p.d/2],[p.x,p.z]].forEach(function(c){
    var g=terrainMeshY(c[0],c[1]); if(g<minG)minG=g; if(g>maxG)maxG=g;
  });
  if (bottom-minG>1.5) vio('floating','high','base '+bottom.toFixed(1)+'u but lowest corner ground '+minG.toFixed(1)+'u (gap '+(bottom-minG).toFixed(1)+'u)');
  else if (bottom-minG>0.8) vio('floating','medium','base '+bottom.toFixed(1)+'u, lowest corner '+minG.toFixed(1)+'u');
  if (maxG-bottom>bh+2.5) vio('buried','high','highest corner '+maxG.toFixed(1)+'u vs base '+bottom.toFixed(1)+'u — hill swallows building');
  /* overlap with neighbors */
  var c0=Math.floor(p.x0/BCELL), c1=Math.floor(p.x1/BCELL);
  var d0=Math.floor(p.z0/BCELL), d1=Math.floor(p.z1/BCELL);
  var seenO={};
  for (var cx=c0;cx<=c1 && !seenO.hit;cx++) for (var cz=d0;cz<=d1 && !seenO.hit;cz++){
    var cell=BHASH[cx+','+cz]; if(!cell) continue;
    for (var oi=0;oi<cell.length;oi++){
      var q=placed[cell[oi]];
      if (q.idx<=p.idx || seenO[q.idx]) continue; seenO[q.idx]=1;
      var ox=Math.min(p.x1,q.x1)-Math.max(p.x0,q.x0);
      var oz=Math.min(p.z1,q.z1)-Math.max(p.z0,q.z0);
      if (ox>1 && oz>1){
        var area=ox*oz, smaller=Math.min((p.x1-p.x0)*(p.z1-p.z0),(q.x1-q.x0)*(q.z1-q.z0));
        var frac=area/smaller;
        if (frac>0.25){
          vio('overlap', frac>0.5?'high':'medium',
            'overlaps building spec #'+q.spec+' by '+ox.toFixed(1)+'x'+oz.toFixed(1)+'u ('+Math.round(frac*100)+'% of smaller)');
          seenO.hit=1; break;
        }
      }
    }
  }
  /* spec sanity */
  if (!(p.w>0&&p.d>0&&p.h>0) || !isFinite(p.w+p.d+p.h))
    vio('spec','high','degenerate footprint dims w='+p.w+' d='+p.d+' h='+p.h);
  else if (p.w>400||p.d>400||p.h>100)
    vio('spec','medium','absurd footprint size w='+p.w+' d='+p.d+' h='+p.h);
  if (p.type<0||p.type>3||!isFinite(p.type))
    vio('spec','medium','bad type '+p.type);
  if (p.nudged>24.5)
    vio('spec','medium','nudge '+p.nudged.toFixed(1)+'u exceeds protocol max 24u');
});
log('  building violations: '+violations.length);

/* ============================================================================
   CITY PLANNER + CITY INSPECTOR — POI division (one crew with the rest).
   The planner verifies every point of interest (churches, schools,
   businesses, civic landmarks) sits at its correct real-world location;
   the inspector verifies each is properly placed (on terrain, off roads,
   out of water, collider sane). Both file with the Code Enforcement Office.
   POI registry is transcribed from the LANDMARKS section of www/index.html.
   ========================================================================== */
log('city planner + inspector: checking points of interest...');
var POIS=[
 {name:'ADAMSVILLE REC CENTER', kind:'civic', lat:33.75378, lon:-84.49187, verified:'code comment: REAL location (verified)',
  boxes:[{dx:0,dz:0,w:45,h:9,d:28},{dx:34,dz:6,w:20,h:6,d:14}], collider:26},
 {name:'SOUTH COBB LIBRARY (1967-2006)', kind:'civic', lat:33.81297, lon:-84.57214,
  boxes:[{dx:0,dz:0,w:16,h:5.5,d:11}], collider:11},
 {name:'RIVERDALE HIGH', kind:'school', lat:33.55658, lon:-84.40224,
  boxes:[{dx:0,dz:0,w:60,h:7,d:16}], collider:32},
 {name:'RIVERDALE APARTMENTS', kind:'housing', lat:33.543, lon:-84.399,
  boxes:[{dx:-30,dz:0,w:24,h:14,d:14},{dx:0,dz:18,w:24,h:14,d:14},{dx:30,dz:0,w:24,h:14,d:14}], collider:17},
 {name:'DOWNTOWN ATLANTA — 1995', kind:'district', lat:33.7586, lon:-84.38908,
  boxes:[{dx:0,dz:0,w:16,h:60,d:16},{dx:24,dz:-10,w:16,h:44,d:16},{dx:-22,dz:8,w:16,h:38,d:16},
         {dx:12,dz:22,w:16,h:30,d:16},{dx:-14,dz:-20,w:16,h:50,d:16},{dx:38,dz:10,w:16,h:24,d:16}],
  cylinders:[{dx:-42,dz:18,r:11,h:68}], collider:12},
 {name:'OLYMPIC STADIUM — OPENS 1996', kind:'civic', lat:33.732, lon:-84.39,
  boxes:[], cylinders:[{dx:0,dz:0,r:29,h:16}], collider:0, note:'open bowl, no collider in game'},
 {name:'FULTON COUNTY STADIUM', kind:'civic', lat:33.73528, lon:-84.38944,
  boxes:[], cylinders:[{dx:0,dz:0,r:27,h:14}], collider:0, note:'no collider in game'},
 {name:'THE OMNI (1972-1997)', kind:'business', lat:33.75750, lon:-84.39667,
  boxes:[{dx:0,dz:0,w:44,h:20,d:34}], collider:28},
 {name:'TECHWOOD — DEMOLISHED 1995 (VACANT LOT)', kind:'vacant', lat:33.767, lon:-84.395,
  boxes:[], lot:{w:120,d:80}, collider:0, note:'must stay empty per 1995 demolition rule'},
 {name:'W BROAD ST — FAIRBURN', kind:'business', lat:33.57, lon:-84.574,
  boxes:[{dx:-42,dz:0,w:18,h:10,d:14},{dx:-18,dz:0,w:18,h:13,d:14},{dx:6,dz:0,w:18,h:10,d:14},{dx:30,dz:0,w:18,h:13,d:14}], collider:14},
 {name:'I-85 SOUTH — FAIRBURN EXIT', kind:'sign', lat:33.53045, lon:-84.60615, boxes:[], collider:0, note:'label only'},
 {name:'FULTON COUNTY AIRPORT', kind:'business', lat:33.77716, lon:-84.52134, verified:'code comment: verified 33.77716,-84.52134',
  boxes:[{dx:0,dz:0,w:26,h:0.4,d:520,ry:0.35}], collider:0, note:'runway rotated 0.35 rad; no collider in game'},
 {name:'CAR WASH (1995)', kind:'business', lat:33.7485, lon:-84.5450,
  boxes:[{dx:0,dz:0,w:22,h:6,d:14}], collider:15},
 {name:'535 DOLLAR MILL RD (home)', kind:'home', lat:33.7411, lon:-84.52645, custom:true,
  boxes:[], collider:0, note:'custom hero-house build, not a box() landmark — location only'}
];
POIS.forEach(function(p){ var w=xz(p.lat,p.lon); p.x=w.x; p.z=w.z; });

var poiIssues=0;
function poiFile(team, o){
  poiIssues++;
  office.submit(team, o);
}
/* --- city planner: correct real-world location --- */
var plannerChecked=0, plannerIssues=0;
POIS.forEach(function(p){
  plannerChecked++;
  function flag(type, sev, detail){
    plannerIssues++;
    poiFile('planner',{poi:p.name, kind:p.kind, lat:p.lat, lon:p.lon,
      x:Math.round(p.x*10)/10, z:Math.round(p.z*10)/10,
      type:type, severity:sev, detail:detail});
  }
  if (!isFinite(p.x+p.z)) flag('location','high','lat/lon failed to convert to world coords');
  else if (p.x<-100||p.x>WX+100||p.z<-100||p.z>WZ+100)
    flag('location','high','world position ('+Math.round(p.x)+','+Math.round(p.z)+') is off the map');
  POIS.forEach(function(q){
    if (q===p) return;
    if (Math.hypot(p.x-q.x,p.z-q.z)<60)
      flag('location','medium','within 60u of '+q.name+' — possible duplicate/wrong site');
  });
});
/* churches / schools / businesses roll-call */
var kinds={};
POIS.forEach(function(p){ kinds[p.kind]=(kinds[p.kind]||0)+1; });
if (!kinds.church) poiFile('planner',{poi:'(none)',kind:'church',type:'missing-poi',severity:'info',
  detail:'no churches placed in-game yet — nothing to verify'});
['school','business'].forEach(function(k){
  poiFile('planner',{poi:'(roll-call)',kind:k,type:'inventory',severity:'info',
    detail:(kinds[k]||0)+' '+k+' POI(s) registered: '+
      POIS.filter(function(p){return p.kind===k;}).map(function(p){return p.name;}).join('; ')});
});
/* --- city inspector: properly placed --- */
var inspectorChecked=0, inspectorIssues=0;
function boxCorners(cx,cz,b){
  var hw=b.w/2, hd=b.d/2, ry=b.ry||0, c=Math.cos(ry), s=Math.sin(ry), out=[];
  [[-hw,-hd],[hw,-hd],[-hw,hd],[hw,hd],[0,0]].forEach(function(o){
    out.push([cx+o[0]*c-o[1]*s, cz+o[0]*s+o[1]*c]);
  });
  return out;
}
POIS.forEach(function(poi){
  if (poi.custom) return;   // home is a custom build — location checked above only
  poi.boxes.forEach(function(b,bi){
    inspectorChecked++;
    var cx=poi.x+b.dx, cz=poi.z+b.dz;
    function flag(type, sev, detail){
      inspectorIssues++;
      poiFile('inspector',{poi:poi.name+' box#'+bi, kind:poi.kind,
        x:Math.round(cx*10)/10, z:Math.round(cz*10)/10,
        type:type, severity:sev, detail:detail});
    }
    var base=heightAt(cx,cz), minG=1e9, maxG=-1e9;
    boxCorners(cx,cz,b).forEach(function(c){
      var g=terrainMeshY(c[0],c[1]); if(g<minG)minG=g; if(g>maxG)maxG=g;
    });
    if (base-minG>1.5) flag('floating','high','base '+base.toFixed(1)+'u, lowest corner ground '+minG.toFixed(1)+'u');
    else if (base-minG>0.8) flag('floating','medium','base '+base.toFixed(1)+'u, lowest corner '+minG.toFixed(1)+'u');
    if (maxG-base>b.h+2.5) flag('buried','high','hill '+maxG.toFixed(1)+'u swallows '+b.h+'u box at base '+base.toFixed(1)+'u');
    /* on-road: flag only if the corridor actually reaches the box —
       use the box's narrow half-width (a 520u runway near a road is fine) */
    var need=Math.min(b.w,b.d)/2, edge=distToRoadEdge(cx,cz);
    if (edge<need) flag('on-road','high','distToRoadEdge '+edge.toFixed(1)+'u < narrow half-width '+need.toFixed(1)+'u');
    var wtr=inWater(cx,cz);
    if (wtr) flag('in-water','high','box inside '+wtr);
    if (!poi.collider) flag('collider','info','no collider registered in game');
    else if (poi.collider<Math.max(b.w,b.d)/2) flag('collider','medium','collider r='+poi.collider+'u < halfdiag '+Math.max(b.w,b.d)/2+'u');
  });
  /* vacant lot must stay vacant */
  if (poi.lot){
    inspectorChecked++;
    var bad=placed.filter(function(p){
      return Math.abs(p.x-poi.x)<poi.lot.w/2 && Math.abs(p.z-poi.z)<poi.lot.d/2;
    });
    if (bad.length){
      inspectorIssues++;
      poiFile('inspector',{poi:poi.name, kind:poi.kind, x:Math.round(poi.x), z:Math.round(poi.z),
        type:'lot-occupied', severity:'high',
        detail:bad.length+' placed building(s) inside the vacant lot (spec #'+bad.slice(0,5).map(function(b){return b.spec;}).join(',')+'…)'});
    }
  }
});
log('  POIs checked: '+POIS.length+' ('+plannerChecked+' location, '+inspectorChecked+' placement); flags: '+poiIssues);

/* ============================================================================
   TRAFFIC ENGINEERING — furniture analysis (Joshua's directive).
   Replicates the game's streetFurniture() intersection model exactly, then
   audits it: flags where traffic control is NEEDED but missing, and where
   placed signs/lights are MISPLACED (orphaned or off the road).
   ========================================================================== */
log('traffic engineering: furniture analysis...');
var FCELL=60, fhash={};
function fhkey(x,z){ return Math.floor(x/FCELL)+','+Math.floor(z/FCELL); }
runs.forEach(function(r,ri){
  if (!r.pts || r.pts.length<2) return;
  var step=Math.max(1, Math.floor(r.pts.length/8));
  for (var i=0;i<r.pts.length;i+=step){
    var p=r.pts[i], k=fhkey(p[0],p[1]);
    (fhash[k]=fhash[k]||[]).push({ri:ri, x:p[0], z:p[1], name:r.name||'', cat:r.cat||'local', w:r.w||7});
  }
});
var found=[], seenCell={};
Object.keys(fhash).forEach(function(k){
  var pts=fhash[k];
  for (var i=0;i<pts.length;i++) for (var j=i+1;j<pts.length;j++){
    var a=pts[i], b=pts[j];
    if (a.name===b.name) continue;
    if (Math.hypot(a.x-b.x,a.z-b.z)>22) continue;
    var mx=(a.x+b.x)/2, mz=(a.z+b.z)/2;
    var ck=Math.round(mx/40)+','+Math.round(mz/40);
    if (seenCell[ck]) continue;
    seenCell[ck]=1;
    found.push({x:mx, z:mz, a:a, b:b});
  }
});
log('  intersections: '+found.length);
var foundPts=found.map(function(f){ return {x:f.x, z:f.z}; });

/* road direction at a point (merge vs real-crossing test) */
function roadDirAt(ri, x, z){
  var r=runs[ri], bi=0, bd=1e18;
  for (var i=0;i<r.pts.length;i++){
    var d=Math.hypot(r.pts[i][0]-x, r.pts[i][1]-z);
    if (d<bd){ bd=d; bi=i; }
  }
  var pa=r.pts[Math.max(0,bi-3)], pb=r.pts[Math.min(r.pts.length-1,bi+3)];
  var dx=pb[0]-pa[0], dz=pb[1]-pa[1], l=Math.hypot(dx,dz)||1;
  return [dx/l, dz/l];
}
found.forEach(function(f){
  var d1=roadDirAt(f.a.ri,f.x,f.z), d2=roadDirAt(f.b.ri,f.x,f.z);
  var dot=Math.min(1,Math.abs(d1[0]*d2[0]+d1[1]*d2[1]));
  f.angle=Math.acos(dot)*180/Math.PI;   // 0 = parallel/merge, 90 = clean crossing
});

/* replicate the game's placed furniture (same algorithm, same caps) */
function furnItem(f){
  var rA=runs[f.a.ri];
  var p0=rA.pts[0], p1=rA.pts[rA.pts.length-1];
  var dx=p1[0]-p0[0], dz=p1[1]-p0[1], len=Math.hypot(dx,dz)||1; dx/=len; dz/=len;
  var off=(f.a.w||7)/2+2.5;
  var side=((Math.round(f.x+f.z)%2)===0)?1:-1;
  var sx=f.x+(-dz)*off*side, sz=f.z+(dx)*off*side;
  return {x:sx, z:sz, y:roadSitY(sx,sz), yaw:Math.atan2(dx,dz),
    name:f.a.name, nameB:f.b.name, ix:f.x, iz:f.z};
}
var expLights=[], expStops=[], expNameSigns=[];
found.forEach(function(f){
  var cats=[f.a.cat,f.b.cat];
  var major=cats.indexOf('highway')>=0 || (cats[0]==='arterial'&&cats[1]==='arterial');
  var it=furnItem(f); it.major=major; it.cats=cats; it.angle=f.angle;
  (major?expLights:expStops).push(it);
});
(function(){
  var cand=found.filter(function(f){ return f.a.cat!=='local'||f.b.cat!=='local'; });
  var seen={};
  for (var si=0; si<cand.length && expNameSigns.length<50; si++){
    var f2=cand[si], ck2=Math.round(f2.x/120)+','+Math.round(f2.z/120);
    if (seen[ck2]) continue; seen[ck2]=1;
    expNameSigns.push(furnItem(f2));
  }
})();
expLights=expLights.slice(0,30); expStops=expStops.slice(0,80);
log('  replicated placed furniture: '+expLights.length+' lights, '+expStops.length+
  ' stops, '+expNameSigns.length+' name signs');

var furnList=[];
function fissue(type, sev, x, z, detail, extra){
  var o={crew:'furniture', x:Math.round(x*10)/10, z:Math.round(z*10)/10,
    type:type, severity:sev, detail:detail};
  for (var k in (extra||{})) o[k]=extra[k];
  furnList.push(o);
  office.submit('furniture', o);   // filed with the Code Enforcement Office
}
function nearestIn(x,z,list){
  var bd=1e18;
  for (var i=0;i<list.length;i++){
    var d=Math.hypot(list[i].x-x, list[i].z-z);
    if (d<bd) bd=d;
  }
  return bd;
}
var SERVE=70, ORPHAN=100;
/* --- NEEDS (Joshua's spec): light where arterials meet or highway×arterial;
   stop where a local meets an arterial/highway, or locals meet at a
   confusing angle. Merges (<25°) are continuations, not crossings. --- */
var needCounts={light:0, stop:0}, phantomCount=0, phantomEx=null;
found.forEach(function(f){
  /* phantom first: same corridor under two TIGER names (I-85 = State Rte 403,
     etc.) — near-parallel by nature, not a real crossing, needs no control */
  var h0=HWY_NORM[f.a.name], h1=HWY_NORM[f.b.name];
  if (h0 && h0===h1){ phantomCount++; if(!phantomEx) phantomEx=f; return; }
  if (f.angle<25) return;
  var c0=f.a.cat, c1=f.b.cat;
  var hw=(c0==='highway'||c1==='highway');
  var need=null, sev=null;
  if (hw && c0!=='local' && c1!=='local'){ need='light'; sev='high'; }
  else if (c0==='arterial' && c1==='arterial'){ need='light'; sev='medium'; }
  else if (hw){ need='stop'; sev='high'; }
  else if ((c0==='arterial')!==(c1==='arterial')){ need='stop'; sev='medium'; }
  else if (c0==='local' && f.angle<60){ need='stop'; sev='medium'; }
  if (!need) return;
  var pair=f.a.name+' / '+f.b.name;
  var info={intersection:{x:+f.x.toFixed(1), z:+f.z.toFixed(1)},
    roads:[f.a.name, f.b.name], cats:[c0,c1], angle:Math.round(f.angle)};
  if (need==='light'){
    if (nearestIn(f.x,f.z,expLights)>SERVE){
      needCounts.light++;
      var cap=expLights.length>=30?' — game light cap (30) exhausted':'';
      fissue('light-needed', sev, f.x, f.z,
        'no traffic light within '+SERVE+'u of '+c0+'×'+c1+' crossing ('+pair+
        ', angle '+Math.round(f.angle)+'°)'+cap, info);
    }
  } else if (nearestIn(f.x,f.z,expStops)>SERVE){
    if (nearestIn(f.x,f.z,expLights)<=SERVE) return;  // already controlled by a light
    needCounts.stop++;
    var cap2=expStops.length>=80?' — game stop-sign cap (80) exhausted':'';
    fissue('stop-needed', sev, f.x, f.z,
      'no stop sign within '+SERVE+'u of '+c0+'×'+c1+' crossing ('+pair+
      ', angle '+Math.round(f.angle)+'°)'+cap2, info);
  }
});
if (phantomCount>0){
  fissue('phantom-intersection','medium',phantomEx.x,phantomEx.z,
    phantomCount+' intersections are same-corridor alias pairs (e.g. '+phantomEx.a.name+
    ' × '+phantomEx.b.name+' = '+(HWY_NORM[phantomEx.a.name]||'?')+
    ') — not real crossings; no control needed, and placed furniture there is suspect',
    {count:phantomCount, example:{x:+phantomEx.x.toFixed(1), z:+phantomEx.z.toFixed(1),
      roads:[phantomEx.a.name,phantomEx.b.name]}});
}
/* --- MISPLACED: orphaned (no intersection nearby), on the road, or adrift --- */
[['light',expLights,'traffic light'],['stop',expStops,'stop sign'],['name',expNameSigns,'street-name sign']]
.forEach(function(pr){
  var kind=pr[0], list=pr[1], label=pr[2];
  list.forEach(function(s){
    var di=nearestIn(s.x,s.z,foundPts);
    var edge=distToRoadEdge(s.x,s.z);
    var nm=s.name+(s.nameB?'/'+s.nameB:'');
    if (di>ORPHAN){
      fissue('sign-misplaced','medium',s.x,s.z,
        label+' orphaned: nearest intersection '+Math.round(di)+'u away ('+nm+')',
        {item:kind, name:s.name});
    } else if (edge<-1){
      fissue('sign-misplaced','high',s.x,s.z,
        label+' INSIDE the road corridor (edge '+edge.toFixed(1)+'u) — blocks traffic ('+nm+')',
        {item:kind, name:s.name});
    } else if (edge>25){
      fissue('sign-misplaced','medium',s.x,s.z,
        label+' '+edge.toFixed(1)+'u from road edge — too far from the road it serves ('+nm+')',
        {item:kind, name:s.name});
    }
  });
});
log('  furniture needs: '+needCounts.light+' lights, '+needCounts.stop+
  ' stops; misplaced sweep done; findings: '+furnList.length);

/* ---------------- report ---------------- */
/* The office compiles ONE consolidated report from all teams' filings. */
function countBy(arr,k){ var o={}; arr.forEach(function(i){ o[i[k]]=(o[i[k]]||0)+1; }); return o; }
office.setTeamSummary('roads',
  { runs:runs.length, issues:issues.length,
    byType:countBy(issues,'type'), bySeverity:countBy(issues,'severity') },
  inspectors.map(function(i){ return {id:i.id, zone:i.zone, runsDriven:i.runsDriven,
    kmDriven:+i.kmDriven.toFixed(1), issues:i.issues}; }));
office.setTeamSummary('buildings',
  { in:OSM_BUILDINGS.length, placed:placed.length, skipped:skipped, nudged:nudged,
    violations:violations.length, byType:countBy(violations,'type'),
    bySeverity:countBy(violations,'severity'),
    realOSM:OSM_REAL_COUNT, procedural:OSM_BUILDINGS.length-OSM_REAL_COUNT,
    note:'present-day OSM footprints (NOT 1995), per game limitation' },
  agents.map(function(a){ return {id:a.id, district:a.district, inspected:a.inspected, violations:a.violations}; }));
office.setTeamSummary('planner',
  { pois:POIS.length, checked:plannerChecked, issues:plannerIssues,
    kinds:countBy(POIS,'kind') },
  [{id:0, role:'city-planner', checked:plannerChecked, issues:plannerIssues}]);
office.setTeamSummary('inspector',
  { boxes:inspectorChecked, issues:inspectorIssues },
  [{id:1, role:'city-inspector', checked:inspectorChecked, issues:inspectorIssues}]);
office.setTeamSummary('furniture',
  { intersections:found.length,
    lightsPlaced:expLights.length, stopsPlaced:expStops.length, nameSignsPlaced:expNameSigns.length,
    lightNeeds:needCounts.light, stopNeeds:needCounts.stop,
    issues:furnList.length, byType:countBy(furnList,'type'), bySeverity:countBy(furnList,'severity') },
  [{id:0, role:'traffic-engineering', intersections:found.length, issues:furnList.length}]);

var report = office.compile({
  game:{ note:'replicated from www/ as of run time (roads.js, elev.js, osm_buildings.js, index.html math)' },
  runtimeMs: Date.now()-t0,
  poiCount: POIS.length
});
var written=[];
written.push(office.emit(report, 'road-inspection.json'));       // canonical latest
if (STAMP) written.push(office.emit(report, stampName()));      // timestamped copy
log('');
log(report.summary);
written.forEach(function(f){ log('filed: '+f); });
log('done in '+((Date.now()-t0)/1000).toFixed(1)+'s');
} /* end if (!global.__DISPATCHER__) */
