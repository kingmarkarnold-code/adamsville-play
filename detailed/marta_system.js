/* ============================================================================
   SURVIVING ADAMSVILLE — MARTA RAIL SYSTEM (v1.0)
   ----------------------------------------------------------------------------
   STANDALONE MODULE. Include AFTER marta_data.js and the main game script:

       <script src="marta_data.js"></script>
       <script src="marta_system.js"></script>

   What it does:
     1. STATIONS — 20 in-map MARTA rail stations at real positions: platform,
        canopy, stairs, station-name sign, blue "M" pylon. Walkable.
     2. TRAIN MODEL — stylized 4-car MARTA train (silver + blue stripe),
        low-poly, matching the game's look.
     3. TRAIN SERVICE — 2 trains per line (Blue/Gold/Green/Red) running back
        and forth along the real GTFS track shapes, dwelling at each station.
     4. BOARDING/RIDING — walk onto a platform; when a train is stopped,
        the action button offers BOARD TRAIN. Ride it; the HUD shows the
        line and next station. EXIT TRAIN at any station.

   Design: simple sim logic (Joshua's rule). Constant-speed trains with
   eased station stops; no physics, no pathfinding.

   Integration: self-installs — polls until THREE/scene/animate exist, then
   wraps animate(). Exposes martaCheckBoard/martaDoBoard/martaDoExit for
   the action button (hooked in index.html).
   ============================================================================ */
(function(){
'use strict';
if (window.__martaV1) return;
window.__martaV1 = true;

/* ---------------- config ---------------- */
var TRAIN_SPEED   = 30;    // units/sec cruising
var DWELL_TIME    = 9;     // seconds stopped at each station
var TRAINS_PER_LINE = 2;
var BRAKE_DIST    = 90;    // start slowing this far from a stop
var BOARD_RANGE   = 30;    // how close player must be to board
var PLATFORM_W    = 10, PLATFORM_L = 76, PLATFORM_H = 1.4;
/* v1.1 despawn/respawn (Joshua): trains run past the last in-map station to
   the map edge, VANISH (like the 18-wheelers), then respawn later coming back
   "from out of town". No more turn-around at terminal stations. */
var TRAIN_TARGET_PER_LINE = 2;   // spawn timer keeps this many per line
var SPAWN_CHECK_INTERVAL  = 8;   // seconds between spawn checks
var EXTEND_STEP           = 100; // track extension step (units)
var EXTEND_MAX            = 1500;// max overrun past terminal (units)
var MAP_X0=60, MAP_X1=7940, MAP_Z0=60, MAP_Z1=11940; // map edge (WX=8000, WZ=12000)

var MT = { lines: [], trains: [], stations: [], ready: false, spawnT: SPAWN_CHECK_INTERVAL };

/* ---------------- arc-length path ---------------- */
function makePath(pts){
  var cum=[0], i, dx, dz;
  for (i=1;i<pts.length;i++){
    dx=pts[i][0]-pts[i-1][0]; dz=pts[i][1]-pts[i-1][1];
    cum.push(cum[i-1]+Math.hypot(dx,dz));
  }
  var total=cum[cum.length-1];
  function segAt(s){
    s=Math.max(0,Math.min(total,s));
    var lo=0, hi=cum.length-1;
    while (lo<hi-1){ var m=(lo+hi)>>1; if (cum[m]<=s) lo=m; else hi=m; }
    return lo;
  }
  return {
    length: total,
    posAt: function(s){
      var i=segAt(s), t=(s-cum[i])/Math.max(0.001,(cum[i+1]-cum[i]));
      t=Math.max(0,Math.min(1,t));
      return [pts[i][0]+(pts[i+1][0]-pts[i][0])*t,
              pts[i][1]+(pts[i+1][1]-pts[i][1])*t];
    },
    dirAt: function(s){
      var i=segAt(s);
      var dx=pts[i+1][0]-pts[i][0], dz=pts[i+1][1]-pts[i][1];
      var l=Math.hypot(dx,dz)||1;
      return [dx/l, dz/l];
    }
  };
}
/* extend a track polyline past both ends toward the map edge (capped).
   Returns {pts: newPts, sOffset: arc length prepended at the start}. */
function extendPtsToEdge(pts){
  function inBounds(x,z){ return x>MAP_X0&&x<MAP_X1&&z>MAP_Z0&&z<MAP_Z1; }
  // outward direction using a ~400u baseline (smooths local end-curves so the
  // overrun follows the line's general direction, not a last-segment wiggle)
  function outDir(endIdx){
    var n=pts.length, ax, ay, bx, by, dist=0, i;
    if (endIdx===0){ ax=pts[0][0]; ay=pts[0][1]; i=1;
      while (i<n-1&&dist<400){ dist+=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]); i++; }
      bx=pts[i][0]; by=pts[i][1];
    } else { ax=pts[n-1][0]; ay=pts[n-1][1]; i=n-2;
      while (i>0&&dist<400){ dist+=Math.hypot(pts[i+1][0]-pts[i][0],pts[i+1][1]-pts[i][1]); i--; }
      bx=pts[i][0]; by=pts[i][1];
    }
    var dx=ax-bx, dz=ay-by, l=Math.hypot(dx,dz)||1;
    return [dx/l, dz/l];
  }
  var n=pts.length, guard, px, pz, qx, qz;
  // prepend: walk outward from pts[0]
  var d0=outDir(0), dx=d0[0], dz=d0[1];
  var pre=[]; px=pts[0][0]; pz=pts[0][1]; guard=0;
  while (guard++*EXTEND_STEP<EXTEND_MAX){
    px+=dx*EXTEND_STEP; pz+=dz*EXTEND_STEP;
    pre.unshift([px,pz]);
    if (!inBounds(px,pz)) break;
  }
  var sOffset=pre.length*EXTEND_STEP;
  // append: walk outward from pts[n-1]
  var d1=outDir(n-1); dx=d1[0]; dz=d1[1];
  var post=[]; qx=pts[n-1][0]; qz=pts[n-1][1]; guard=0;
  while (guard++*EXTEND_STEP<EXTEND_MAX){
    qx+=dx*EXTEND_STEP; qz+=dz*EXTEND_STEP;
    post.push([qx,qz]);
    if (!inBounds(qx,qz)) break;
  }
  return { pts: pre.concat(pts, post), sOffset: sOffset };
}

/* ---------------- material helpers ---------------- */
var _mats={};
function mat(color){
  if (!_mats[color]) _mats[color]=new THREE.MeshLambertMaterial({color:color});
  return _mats[color];
}
function groundY(x,z){
  try{ return heightAt(x,z); }catch(e){ return 0; }
}
function signBoard(text,x,y,z,ry,w,bg){
  var cv=document.createElement('canvas'); cv.width=512; cv.height=96;
  var c=cv.getContext('2d');
  c.fillStyle=bg||'#123a7d'; c.fillRect(0,0,512,96);
  c.fillStyle='#ffffff'; c.font='bold 40px Arial';
  c.textAlign='center'; c.textBaseline='middle';
  var t=text.length>22?text.slice(0,22):text;
  c.fillText(t,256,50);
  var tex=new THREE.CanvasTexture(cv);
  var m=new THREE.Mesh(new THREE.PlaneGeometry(w,w*96/512),
    new THREE.MeshBasicMaterial({map:tex,side:THREE.DoubleSide}));
  m.position.set(x,y,z); m.rotation.y=ry||0; scene.add(m);
  return m;
}

/* ---------------- train mesh (stylized MARTA, silver/blue) ---------------- */
function martaTrainMesh(){
  var g=new THREE.Group();
  var silver=mat(0xc9ced4), blue=mat(0x1a5fb4), dark=mat(0x22262b),
      glassM=new THREE.MeshLambertMaterial({color:0x1c2733});
  var CAR_L=19, CAR_W=3.2, CAR_H=3.4, GAP=1.2;
  for (var ci=0; ci<4; ci++){
    var car=new THREE.Group();
    var zoff=-(ci*(CAR_L+GAP));
    // body
    var body=new THREE.Mesh(new THREE.BoxGeometry(CAR_W,CAR_H,CAR_L), silver);
    body.position.set(0,2.2,zoff); car.add(body);
    // blue stripe
    var stripe=new THREE.Mesh(new THREE.BoxGeometry(CAR_W+0.06,0.5,CAR_L+0.06), blue);
    stripe.position.set(0,2.6,zoff); car.add(stripe);
    // window band
    var win=new THREE.Mesh(new THREE.BoxGeometry(CAR_W+0.06,0.9,CAR_L-3), glassM);
    win.position.set(0,3.3,zoff); car.add(win);
    // roof
    var roof=new THREE.Mesh(new THREE.BoxGeometry(CAR_W-0.3,0.25,CAR_L-0.5), mat(0x9aa0a8));
    roof.position.set(0,4.0,zoff); car.add(roof);
    // skirt
    var skirt=new THREE.Mesh(new THREE.BoxGeometry(CAR_W-0.4,0.7,CAR_L-1), dark);
    skirt.position.set(0,0.75,zoff); car.add(skirt);
    // front cab face on first/last car
    if (ci===0||ci===3){
      var face=new THREE.Mesh(new THREE.BoxGeometry(CAR_W-0.2,2.6,0.3), silver);
      var fz=zoff+(ci===0?CAR_L/2:-CAR_L/2);
      face.position.set(0,2.3,fz); car.add(face);
      var shield=new THREE.Mesh(new THREE.BoxGeometry(CAR_W-0.8,1.0,0.1), glassM);
      shield.position.set(0,3.2,fz+(ci===0?0.18:-0.18)); car.add(shield);
      // headlights
      [-0.9,0.9].forEach(function(hx){
        var hl=new THREE.Mesh(new THREE.BoxGeometry(0.35,0.35,0.1),
          new THREE.MeshBasicMaterial({color:0xfff2b0}));
        hl.position.set(hx,1.6,fz+(ci===0?0.18:-0.18)); car.add(hl);
      });
    }
    // wheels (simple dark boxes)
    for (var w=-1;w<=1;w+=2){
      var bogie=new THREE.Mesh(new THREE.BoxGeometry(CAR_W-0.6,0.8,3), dark);
      bogie.position.set(0,0.45,zoff+w*(CAR_L/2-2.5)); car.add(bogie);
    }
    g.add(car);
  }
  g.userData.len=4*(CAR_L+GAP);
  return g;
}

/* ---------------- track rendering ---------------- */
function buildTrack(line){
  var path=line.path, total=path.length;
  var step=8, n=Math.floor(total/step);
  var bedGeo=new THREE.BufferGeometry(), railGeo=new THREE.BufferGeometry();
  var bedPos=[], bedIdx=[], railPos=[], railIdx=[];
  var vi=0, ri=0;
  // smoothed heights
  function trackY(s){
    var p=path.posAt(s);
    return groundY(p[0],p[1])+0.55;
  }
  var ys=[];
  for (var i=0;i<=n;i++) ys.push(trackY(i*step));
  // smooth
  for (var k=0;k<3;k++){
    var ys2=ys.slice();
    for (i=1;i<n;i++) ys2[i]=(ys[i-1]+ys[i]*2+ys[i+1])/4;
    ys=ys2;
  }
  line.trackY=function(s){
    var f=Math.max(0,Math.min(n, s/step)), i0=Math.floor(f), t=f-i0;
    if (i0>=n) return ys[n];
    return ys[i0]+(ys[i0+1]-ys[i0])*t;
  };
  for (i=0;i<=n;i++){
    var s=i*step, p=path.posAt(s), d=path.dirAt(s);
    var px=-d[1], pz=d[0]; // perpendicular
    var y=ys[i];
    // bed (5 wide)
    bedPos.push(p[0]-px*2.5,y-0.25,p[1]-pz*2.5, p[0]+px*2.5,y-0.25,p[1]+pz*2.5);
    if (i<n){ var a=vi,b=vi+1,c=vi+2,e=vi+3; bedIdx.push(a,b,c,b,e,c); }
    vi+=2;
    // two rails (0.3 wide, at +/-0.9)
    [-0.9,0.9].forEach(function(off){
      var cx=p[0]+px*off, cz=p[1]+pz*off;
      railPos.push(cx-px*0.15,y+0.05,cz-pz*0.15, cx+px*0.15,y+0.05,cz+pz*0.15);
      if (i<n){ var a2=ri,b2=ri+1,c2=ri+2,e2=ri+3; railIdx.push(a2,b2,c2,b2,e2,c2); }
      ri+=2;
    });
  }
  bedGeo.setAttribute('position', new THREE.Float32BufferAttribute(bedPos,3));
  bedGeo.setIndex(bedIdx); bedGeo.computeVertexNormals();
  railGeo.setAttribute('position', new THREE.Float32BufferAttribute(railPos,3));
  railGeo.setIndex(railIdx); railGeo.computeVertexNormals();
  var bed=new THREE.Mesh(bedGeo, new THREE.MeshLambertMaterial({color:0x3d3a36}));
  var rail=new THREE.Mesh(railGeo, new THREE.MeshLambertMaterial({color:0x8a8f96}));
  scene.add(bed); scene.add(rail);
}
/* ---------------- stations ---------------- */
function buildStation(st, line){
  var path=line.path;
  // find arc position of this stop
  var stop=null;
  for (var i=0;i<line.stops.length;i++) if (line.stops[i].name===st.name){ stop=line.stops[i]; break; }
  if (!stop) return null;
  var s=stop.s, p=path.posAt(s), d=path.dirAt(s);
  var px=-d[1], pz=d[0];
  var ty=line.trackY(s);
  // choose platform side away from nearest road
  var roadD=1e9;
  try{ roadD=distToRoadEdge(p[0]+px*9, p[1]+pz*9); }catch(e){}
  var roadD2=1e9;
  try{ roadD2=distToRoadEdge(p[0]-px*9, p[1]-pz*9); }catch(e){}
  var side=(roadD>=roadD2)?1:-1;
  // nudge along the track to find a spot clear of roads (dense downtown)
  var bestS=s, bestClear=-1e9;
  try{
    [0,15,-15,30,-30].forEach(function(off){
      var ss=Math.max(0,Math.min(line.path.length,s+off));
      var pp=path.posAt(ss), dd=path.dirAt(ss);
      var qx=-dd[1], qz=dd[0];
      var clear=distToRoadEdge(pp[0]+qx*9*side, pp[1]+qz*9*side);
      if (clear>bestClear){ bestClear=clear; bestS=ss; }
    });
  }catch(e){}
  s=bestS;
  stop.s=bestS; // train dwells at the (possibly nudged) platform
  p=path.posAt(s); d=path.dirAt(s);
  px=-d[1]; pz=d[0];
  ty=line.trackY(s);
  var cx=p[0]+px*9*side, cz=p[1]+pz*9*side;
  var gy=groundY(cx,cz);
  var platY=Math.max(ty+0.4, gy+0.2); // platform deck height
  var g=new THREE.Group();
  // platform slab
  var slab=new THREE.Mesh(new THREE.BoxGeometry(PLATFORM_W,PLATFORM_H,PLATFORM_L), mat(0x9aa0a8));
  var ang=Math.atan2(d[0],d[1]);
  slab.position.set(cx,platY-PLATFORM_H/2,cz); slab.rotation.y=ang; g.add(slab);
  // platform edge (yellow safety line)
  var edge=new THREE.Mesh(new THREE.BoxGeometry(0.6,0.08,PLATFORM_L), mat(0xd4a723));
  var ex=cx-px*side*(PLATFORM_W/2-0.6), ez=cz-pz*side*(PLATFORM_W/2-0.6);
  edge.position.set(ex,platY+0.04,ez); edge.rotation.y=ang; g.add(edge);
  // canopy: roof over middle of platform on columns
  var canLen=44;
  var roof=new THREE.Mesh(new THREE.BoxGeometry(PLATFORM_W+2,0.35,canLen), mat(0x2a4a7d));
  roof.position.set(cx,platY+4.6,cz); roof.rotation.y=ang; g.add(roof);
  for (var ci2=-1;ci2<=1;ci2+=2){
    for (var cj=-1;cj<=1;cj++){
      var col=new THREE.Mesh(new THREE.BoxGeometry(0.5,4.6,0.5), mat(0x707880));
      var ox=ci2*(PLATFORM_W/2-0.8), oz=cj*canLen/2.6;
      // rotate offset by platform angle
      var wx=cx+ox*Math.cos(ang)+oz*Math.sin(ang);
      var wz=cz-ox*Math.sin(ang)+oz*Math.cos(ang);
      col.position.set(wx,platY+2.3,wz); g.add(col);
    }
  }
  // stairs at south end down to ground
  var stairX=cx+d[0]*(PLATFORM_L/2+4), stairZ=cz+d[1]*(PLATFORM_L/2+4);
  var steps=6;
  for (var si2=0;si2<steps;si2++){
    var stp=new THREE.Mesh(new THREE.BoxGeometry(3,0.35,1.4), mat(0x8a9098));
    var t=si2/(steps-1);
    stp.position.set(stairX, platY-0.4-t*(platY-gy-0.4), stairZ);
    stp.rotation.y=ang; g.add(stp);
  }
  // benches
  for (var b=-1;b<=1;b+=2){
    var bench=new THREE.Mesh(new THREE.BoxGeometry(2.2,0.5,0.7), mat(0x5a4632));
    var bx=cx+px*side*2.5, bz=cz+pz*side*2.5;
    var wbx=bx+ (b*10)*d[0], wbz=bz+(b*10)*d[1];
    bench.position.set(wbx,platY+0.45,wbz); bench.rotation.y=ang; g.add(bench);
  }
  scene.add(g);
  // station name sign on canopy (faces track)
  signBoard(st.name, cx-px*side*(PLATFORM_W/2+0.4), platY+3.4, cz-pz*side*(PLATFORM_W/2+0.4),
    ang+Math.PI/2*side, 16, '#123a7d');
  // blue "M" pylon at street level near stairs
  var py=groundY(stairX+6, stairZ+4);
  var pole=new THREE.Mesh(new THREE.BoxGeometry(0.5,7,0.5), mat(0x707880));
  pole.position.set(stairX+6,py+3.5,stairZ+4); scene.add(pole);
  signBoard('M', stairX+6, py+7.6, stairZ+4, ang, 3, '#1a5fb4');
  return { name:st.name, x:cx, z:cz, platY:platY, line:line,
           trackX:p[0], trackZ:p[1], s:s, side:side, px:px, pz:pz };
}

/* ---------------- trains ---------------- */
function spawnTrain(line, s0, dir){
  var mesh=martaTrainMesh();
  scene.add(mesh);
  var t={ line:line, mesh:mesh, s:s0, dir:dir||1, speed:0,
          state:'run', dwellT:0, stopIdx:-1, x:0, z:0, yaw:0, nextStop:null };
  MT.trains.push(t);
  return t;
}
function trainStopIdx(t){
  // next stop ahead in travel direction
  var stops=t.line.stops, best=-1, bd=1e18, i, ds;
  for (i=0;i<stops.length;i++){
    ds=(stops[i].s-t.s)*t.dir;
    if (ds>1&&ds<bd){ bd=ds; best=i; }
  }
  return best;
}
/* remove a train from the world (it vanished past the map edge) */
function despawnTrain(idx){
  var t=MT.trains[idx];
  // safety: never strand the player on a vanishing train
  if (typeof player!=='undefined' && player.ridingTrain===t) martaAutoExit(t);
  try{ scene.remove(t.mesh); }catch(e){}
  MT.trains.splice(idx,1);
}
/* drop a rider on the current platform (used at terminals / despawn safety) */
function martaAutoExit(t){
  var st=(t.stopIdx>=0&&t.line.stops[t.stopIdx])?t.line.stops[t.stopIdx]:null;
  var bs=st?builtStation(st.name):null;
  if (bs){
    player.x=bs.x; player.z=bs.z;
    try{ player.mesh.position.y=bs.platY; }catch(e){}
  } else {
    player.x=t.x+6; player.z=t.z+6;
  }
  player.ridingTrain=null;
  try{ player.mesh.visible=true; }catch(e){}
  showToast(st?('End of the line — '+st.name):'End of the line', 2200);
  try{ Report.note('marta-autoexit',{station:st?st.name:'?'}); }catch(e){}
}
function updateTrain(t, dt){
  var line=t.line;
  var done=false; // true => reached the map edge, despawn
  if (t.state==='dwell'){
    t.dwellT-=dt;
    t.speed=0;
    if (t.dwellT<=0){
      t.state='run';
      // v1.1: NO reversal at terminals. The train keeps going to the map edge
      // and vanishes. If the player is still aboard, drop them on the platform.
      var nst=t.line.stops.length;
      var isTerminal=(t.dir>0&&t.stopIdx===nst-1)||(t.dir<0&&t.stopIdx===0);
      if (isTerminal && typeof player!=='undefined' && player.ridingTrain===t){
        martaAutoExit(t);
      }
      t.stopIdx=-1;
    }
  } else {
    var ni=trainStopIdx(t);
    t.nextStop=ni;
    var target=TRAIN_SPEED;
    if (ni>=0){
      var ds=Math.abs(line.stops[ni].s-t.s);
      if (ds<BRAKE_DIST) target=TRAIN_SPEED*Math.max(0,(ds-4)/BRAKE_DIST);
      if (ds<6){
        // arrived: snap, dwell
        t.s=line.stops[ni].s; t.state='dwell'; t.dwellT=DWELL_TIME;
        t.stopIdx=ni; t.speed=0;
        if (player.ridingTrain===t){
          showToast(line.name+' line — '+line.stops[ni].name, 2500);
        }
      }
    }
    t.speed+=(target-t.speed)*Math.min(1,dt*1.6);
    t.s+=t.dir*t.speed*dt;
    t.s=Math.max(0,Math.min(line.path.length,t.s));
    // v1.1: reached the map edge while heading outward => vanish (semi pattern)
    if ((t.dir>0&&t.s>=line.path.length-2)||(t.dir<0&&t.s<=2)) done=true;
  }
  if (!done){
    var p=line.path.posAt(t.s), d=line.path.dirAt(t.s);
    if (t.dir<0){ d=[-d[0],-d[1]]; }
    t.x=p[0]; t.z=p[1];
    t.yaw=Math.atan2(d[0],d[1]);
    var y=line.trackY(t.s);
    if (typeof clampVehY==='function') y=clampVehY(t.x,t.z,y);  // v1.12: ground clamp — no sky-floaters (never clamps downward: tunnels legit)
    t.mesh.position.set(t.x, y-0.55, t.z);
    t.mesh.rotation.y=t.yaw;
  }
  return done;
}
/* ---------------- boarding / riding ---------------- */
function nearestDwellingTrain(){
  if (typeof player==='undefined') return null;
  var best=null, bd=1e18;
  for (var i=0;i<MT.trains.length;i++){
    var t=MT.trains[i];
    if (t.state!=='dwell'||t.stopIdx<0) continue;
    var st=t.line.stops[t.stopIdx];
    var d=Math.hypot(player.x-st.x, player.z-st.z);
    if (d<BOARD_RANGE&&d<bd){ bd=d; best=t; }
  }
  return best;
}
/* called from updateActionButton() in index.html */
window.martaCheckBoard=function(){
  if (typeof player==='undefined'||car.driving) return null;
  if (player.ridingTrain){
    return { act:'exit-train', label:'EXIT TRAIN' };
  }
  if (player.inside) return null;
  var t=nearestDwellingTrain();
  if (t) return { act:'board-train', label:'BOARD '+t.line.name+' TRAIN', train:t };
  return null;
};
window.martaDoBoard=function(){
  var t=nearestDwellingTrain();
  if (!t) return;
  window.__martaPendingTrain=t;
};
function doBoardTrain(t){
  player.ridingTrain=t;
  try{ player.mesh.visible=false; }catch(e){}
  showToast('Riding MARTA '+t.line.name+' line', 2200);
  try{ Report.note('marta-board',{line:t.line.name}); }catch(e){}
}
window.martaDoExit=function(){
  var t=player.ridingTrain;
  if (!t) return;
  // drop player on the platform of the nearest stop on this line
  var best=null, bd=1e18, i, st;
  for (i=0;i<t.line.stops.length;i++){
    st=t.line.stops[i];
    var d=Math.abs(st.s-t.s);
    if (d<bd){ bd=d; best=st; }
  }
  var bs=builtStation(best.name);
  if (bs){
    player.x=bs.x; player.z=bs.z;
    try{ player.mesh.position.y=bs.platY; }catch(e){}
  } else {
    player.x=t.x+6; player.z=t.z+6;
  }
  player.ridingTrain=null;
  try{ player.mesh.visible=true; }catch(e){}
  showToast(best?best.name:'', 2000);
  try{ Report.note('marta-exit',{station:best?best.name:'?'}); }catch(e){}
};
function builtStation(name){
  for (var i=0;i<MT.stations.length;i++) if (MT.stations[i].name===name) return MT.stations[i];
  return null;
}
function updateRiding(dt){
  var t=player.ridingTrain;
  if (!t) return;
  // follow the train head
  player.x=t.x; player.z=t.z;
  try{ player.mesh.position.set(t.x, t.mesh.position.y+1.2, t.z); }catch(e){}
  // HUD: line + next station
  var nx='END OF LINE';
  if (t.nextStop>=0&&t.line.stops[t.nextStop]) nx=t.line.stops[t.nextStop].name;
  else if (t.state==='dwell'&&t.stopIdx>=0) nx=t.line.stops[t.stopIdx].name+' (doors open)';
  var want='MARTA '+t.line.name+' — Next: '+nx;
  try{
    var mt=document.getElementById('mode-tag');
    if (mt&&mt.textContent!==want) mt.textContent=want;
  }catch(e){}
}

/* ---------------- init ---------------- */
function initMarta(){
  if (!window.MARTA_DATA) throw new Error('MARTA_DATA missing');
  var D=window.MARTA_DATA, li, si;
  // build lines (dedup stations across lines for structure building)
  var built={};
  for (li=0;li<D.lines.length;li++){
    var L=D.lines[li];
    var ext=extendPtsToEdge(L.pts);
    for (var so=0;so<L.stops.length;so++) L.stops[so].s+=ext.sOffset;
    var line={ id:L.id, name:L.name, color:L.color, headway:L.headway,
               stops:L.stops, path:makePath(ext.pts), spawnEnd:1 };
    buildTrack(line);
    MT.lines.push(line);
    for (si=0;si<L.stops.length;si++){
      var sn=L.stops[si].name;
      if (!built[sn]){
        var stRec=null;
        for (var k=0;k<D.stations.length;k++) if (D.stations[k].name===sn){ stRec=D.stations[k]; break; }
        if (stRec){
          var bs=buildStation(stRec, line);
          if (bs){ MT.stations.push(bs); built[sn]=bs; }
        }
      }
    }
  }
  // spawn trains: 2 per line, one at each map-edge end heading inward
  // ("from out of town"). The spawn timer keeps this topped up.
  for (li=0;li<MT.lines.length;li++){
    var ln=MT.lines[li];
    spawnTrain(ln, 2, 1);
    spawnTrain(ln, ln.path.length-2, -1);
  }
  MT.ready=true;
  try{ Report.setSys('marta',{status:'ok',version:'1.0',
    stations:MT.stations.length, lines:MT.lines.length, trains:MT.trains.length,
    note:'MARTA rail: stations + rideable trains'}); }catch(e){}
  window.MARTA=MT;
}
var _lastT=0;
function updateMarta(){
  if (!MT.ready) return;
  var now;
  try{ now=performance.now(); }catch(e){ now=0; }
  var dt=_lastT?Math.min(0.06,(now-_lastT)/1000):0.016;
  _lastT=now;
  var i;
  for (i=MT.trains.length-1;i>=0;i--){
    if (updateTrain(MT.trains[i], dt)) despawnTrain(i);
  }
  // spawn timer (semi pattern): keep TRAIN_TARGET_PER_LINE per line, new ones
  // appear at alternating map-edge ends "from out of town"
  MT.spawnT-=dt;
  if (MT.spawnT<=0){
    MT.spawnT=SPAWN_CHECK_INTERVAL;
    for (var li=0;li<MT.lines.length;li++){
      var ln=MT.lines[li], cnt=0, k;
      for (k=0;k<MT.trains.length;k++) if (MT.trains[k].line===ln) cnt++;
      if (cnt<TRAIN_TARGET_PER_LINE){
        var ed=ln.spawnEnd; ln.spawnEnd*=-1;
        spawnTrain(ln, ed>0?2:ln.path.length-2, ed);
      }
    }
  }
  if (typeof player!=='undefined'&&player.ridingTrain) updateRiding(dt);
  // pending board from action button (set synchronously on click)
  if (window.__martaPendingTrain){
    var t=window.__martaPendingTrain; window.__martaPendingTrain=null;
    if (t.state==='dwell') doBoardTrain(t);
  }
}
var _bootTries=0;
var _bootTimer=setInterval(function(){
  _bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined'&&typeof scene!=='undefined'&&
      typeof animate==='function'&&typeof MARTA_DATA!=='undefined'&&
      typeof heightAt==='function');
  }catch(e){ ready=false; }
  if (ready){
    try{ initMarta(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('marta','init failed',String(e&&e.message||e)); }catch(x){}
    }
    try{
      if (typeof animate==='function'&&!animate.__martaWrap){
        var orig=animate;
        var wrapped=function(){ orig(); updateMarta(); };
        wrapped.__martaWrap=true;
        animate=wrapped;
      }
    }catch(e){}
    clearInterval(_bootTimer);
  } else if (_bootTries>240){
    clearInterval(_bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('marta','boot-timeout','deps never ready'); }catch(e){}
  }
},250);
})();
