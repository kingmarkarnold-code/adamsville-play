/* ============================================================================
   REFNPC — 8 photo-based NPCs with daily schedules + school bus (v1.1)
   ----------------------------------------------------------------------------
   STANDALONE MODULE. Include AFTER the main game script + npc_system.js —
   zero edits to index.html logic required:

       <script src="refnpc_system.js"></script>

   What it does:
     1. Spawns Joshua's 8 photo characters (Character Studio recipes,
        2026-10-08) as residents of the Adamsville / Dollar Mill area, each
        with a distinct home (a real nearby house).
     2. Daily SCHEDULES (simple sim) driven by a game clock
        (24 game hrs = 124 real min, Joshua 2026-10-09; day starts Mon 06:00):
          22:00-06:30 SLEEP at home (hidden)
          06:30-walk  HOME (wander near home)
          ~2 min before bus  walk to bus stop, WAIT (per-stop timed arrival)
          ~07:40-08:40 school bus pickup -> RIDE to Harper Archer High School
          08:40-15:00 AT SCHOOL (wander grounds)
          15:00       bus home -> dropped at stop -> walk TO_HOME
          15:30-22:00 HANGOUT / HOME (evening wander near home)
        Weekends: no bus/school — hang out around the neighborhood all day.
        All 8 are 16 (per the photo recipes) -> all ride the bus to school.
     3. SCHOOL BUS: stylized yellow bus running a morning pickup loop
        (bus stops near each kid's home -> school) and an afternoon
        drop-off loop (school -> stops). Fixed route computed at boot from
        real road data; follows road polylines where consecutive stops share
        a road, short direct hops otherwise.

   Reads (all optional/guarded except where noted): THREE, scene, animate, roadDrawData,
   PLACED_HOUSES, HOME, heightAt, inWater, bldgGrid, ENTERABLES, Report,
   vehLam (material helper, expected global), schoolBusMesh (bus mesh
   builder, expected global), ShirtDesigns (shirt graphics), IS_APK,
   buildFace3D/addLegoFacePlane (face_platform.js), clampVehY.
   Writes: 8 character Groups + 1 bus Group in scene; window.updateRefNPCs;
   window.REFNPC (debug); tiny HUD clock.
   ============================================================================ */
(function(){
'use strict';
if (window.__refnpcV1) return;
window.__refnpcV1 = true;

/* ---------------- 8 photo recipes (Character Studio, 2026-10-08) ---------- */
var RECIPES=[
 {name:'MECCA shirt man', arch:'boy16', hairStyle:'cap',
  params:{headSize:0.15,torsoW:0.50,torsoH:0.54,torsoD:0.34,shoulderW:0.46,hipW:0.36,
          upperArm:0.28,forearm:0.28,armW:0.13,shoulderX:0.27,thigh:0.32,shin:0.32,
          legW:0.17,hipX:0.12,heightScale:0.92},
  colors:{skin:'#4a2f1c',shirt:'#6b4a2e',pants:'#1f2a3a',shoes:'#222226',hair:'#0a0805'}},
 {name:'Flag photo man', arch:'boy16', hairStyle:'cap',
  params:{headSize:0.14,torsoW:0.37,torsoH:0.50,torsoD:0.24,shoulderW:0.38,hipW:0.28,
          upperArm:0.26,forearm:0.26,armW:0.10,shoulderX:0.24,thigh:0.30,shin:0.30,
          legW:0.13,hipX:0.105,heightScale:0.88},
  colors:{skin:'#5a3a24',shirt:'#e8b923',pants:'#2e4a6b',shoes:'#222226',hair:'#0a0805'}},
 {name:'Yellow shirt woman', arch:'woman', hairStyle:'long',
  params:{headSize:0.15,torsoW:0.38,torsoH:0.52,torsoD:0.25,upperArm:0.26,forearm:0.26,
          armW:0.10,shoulderX:0.24,thigh:0.31,shin:0.31,legW:0.13,hipX:0.11,heightScale:0.85},
  colors:{skin:'#7d5230',shirt:'#e8b923',pants:'#141414',shoes:'#222226',hair:'#0a0805'}},
 {name:'Bearded cap man', arch:'boy16', hairStyle:'cap',
  params:{headSize:0.145,torsoW:0.42,torsoH:0.52,torsoD:0.27,shoulderW:0.42,hipW:0.31,
          upperArm:0.27,forearm:0.27,armW:0.11,shoulderX:0.255,thigh:0.31,shin:0.31,
          legW:0.14,hipX:0.11,heightScale:0.89},
  colors:{skin:'#4a2f1c',shirt:'#2e5fa3',pants:'#1f2a3a',shoes:'#222226',hair:'#0a0805'}},
 {name:'Dreadlocks man', arch:'boy16', hairStyle:'long',
  params:{headSize:0.14,torsoW:0.36,torsoH:0.50,torsoD:0.24,shoulderW:0.37,hipW:0.28,
          upperArm:0.26,forearm:0.26,armW:0.095,shoulderX:0.235,thigh:0.30,shin:0.30,
          legW:0.125,hipX:0.105,heightScale:0.87},
  colors:{skin:'#6b4429',shirt:'#e0e0e0',pants:'#9a8a6a',shoes:'#222226',hair:'#0a0805'}},
 {name:'Headband bun girl', arch:'woman', hairStyle:'cap',
  params:{headSize:0.15,torsoW:0.34,torsoH:0.50,torsoD:0.23,upperArm:0.25,forearm:0.25,
          armW:0.095,shoulderX:0.23,thigh:0.30,shin:0.30,legW:0.125,hipX:0.105,heightScale:0.84},
  colors:{skin:'#7d5230',shirt:'#9fc3e0',pants:'#2e4a6b',shoes:'#222226',hair:'#0a0805'}},
 {name:'Puppy photo', arch:'boy16', hairStyle:'cap',
  params:{headSize:0.15,torsoW:0.38,torsoH:0.50,torsoD:0.25,shoulderW:0.39,hipW:0.29,
          upperArm:0.26,forearm:0.26,armW:0.10,shoulderX:0.24,thigh:0.30,shin:0.30,
          legW:0.13,hipX:0.105,heightScale:0.86},
  colors:{skin:'#6b4429',shirt:'#2e5fa3',pants:'#2e4a6b',shoes:'#222226',hair:'#0a0805'}},
 {name:'Purple portrait woman', arch:'woman', hairStyle:'cap',
  params:{headSize:0.15,torsoW:0.40,torsoH:0.52,torsoD:0.26,upperArm:0.26,forearm:0.26,
          armW:0.10,shoulderX:0.24,thigh:0.31,shin:0.31,legW:0.135,hipX:0.11,heightScale:0.85},
  colors:{skin:'#8a5f36',shirt:'#7b4fa3',pants:'#141414',shoes:'#222226',hair:'#0a0805'}}
];

/* ---------------- config ---------------- */
var WALK_SPEED=1.7, BUS_SPEED=16;
/* Day cycle (Joshua 2026-10-09): 24 game hours = 124 real minutes.
   DAY_SCALE converts real seconds to game minutes. */
var DAY_SCALE=1440/7440; // ≈0.1935 game-min per real-sec; 1 game hr = 310 real sec
/* Bus dwell is a fixed real-seconds pause per stop (deterministic) so kids
   can time their walk to arrive ~2 game-min before the bus. */
var BUS_DWELL_S=20;
/* Schedule (game minutes). T_TOSTOP is gone — each kid gets a personal
   k.leaveForStop computed from their stop's bus arrival time. */
var T_WAKE=390, T_BUS_AM=475, T_SCHOOL=560, T_SCHOOL_END=900,
    T_BUS_PM=905, T_SLEEP=1320; // minutes
var T_WAIT_FALLBACK=620; // 10:20 — walk to school if bus was missed
var DAYS=['MON','TUE','WED','THU','FRI','SAT','SUN'];

var RN=null; // runtime state

/* ---------------- character mesh (stylized, matches shipped NPC look) ----- */
/* Build one photo-based kid mesh from a Character Studio recipe: legs with
   hip pivots, torso whose front face carries that character's original
   shirt graphic (ShirtDesigns, when available), arms with shoulder pivots,
   head + PLATFORM-SPLIT face (APK: buildFace3D geometry; web:
   addLegoFacePlane texture), then cap (crown+brim) or long hair. Limb
   pivots + walk phase are stored in userData for the animation loop. */
function buildKid(r){
  var g=new THREE.Group();
  var P=r.params, C=r.colors, scl=P.heightScale||0.88;
  var skin=new THREE.Color(C.skin), shirt=new THREE.Color(C.shirt),
      pants=new THREE.Color(C.pants), hairC=new THREE.Color(C.hair),
      shoeC=new THREE.Color(C.shoes);
  function box(w,h,d,mat,x,y,z,parent){
    var m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
    m.position.set(x,y,z); (parent||g).add(m); return m;
  }
  var tw=P.torsoW||0.4, td=P.torsoD||0.26;
  // legs (pivot at hip y=0.82)
  function leg(sx){
    var piv=new THREE.Group(); piv.position.set(sx*(P.hipX||0.11),0.82,0); g.add(piv);
    box((P.legW||0.13),0.62,(P.legW||0.13),vehLam(pants),0,-0.31,0,piv);
    box(0.14,0.10,0.24,vehLam(shoeC),0,-0.66,0.04,piv);
    return piv;
  }
  var legL=leg(-1), legR=leg(1);
  // torso — front face carries the character's shirt design (original art only)
  (function(){
    var mats=(typeof ShirtDesigns!=='undefined')?ShirtDesigns.makeShirtMats(C.shirt,r.name):null;
    if (mats){ var tm=new THREE.Mesh(new THREE.BoxGeometry(tw,0.55,td),mats);
      tm.position.set(0,1.10,0); g.add(tm); }
    else box(tw,0.55,td,vehLam(shirt),0,1.10,0);
  })();
  // arms (pivot at shoulder y=1.30)
  function arm(sx){
    var piv=new THREE.Group(); piv.position.set(sx*((P.shoulderX||0.24)),1.30,0); g.add(piv);
    box((P.armW||0.10),0.58,(P.armW||0.10),vehLam(skin),0,-0.29,0,piv);
    return piv;
  }
  var armL=arm(-1), armR=arm(1);
  // head + hair
  var hs=0.26+(P.headSize||0.14);
  box(hs,0.30,hs,vehLam(skin),0,1.56,0);
  // PLATFORM SPLIT (Joshua 2026-10-09): APK = 3D face, WEB = texture face
  (function(){
    var isApk=(typeof IS_APK!=='undefined')&&IS_APK;
    if(isApk && typeof buildFace3D==='function'){
      var hg=new THREE.Group(); hg.position.set(0,1.56,0); g.add(hg);
      buildFace3D(hg, hs*0.42, vehLam(skin), vehLam(hairC));
    } else if(typeof addLegoFacePlane==='function'){
      var hg2=new THREE.Group(); hg2.position.set(0,1.56,0); g.add(hg2);
      addLegoFacePlane(hg2, hs*0.55, hs/2+0.005);
    }
  })();
  if (r.hairStyle==='cap'){
    box(hs+0.04,0.09,hs+0.04,vehLam(hairC),0,1.72,0);          // cap crown
    box(hs+0.04,0.03,0.16,vehLam(hairC),0,1.69,hs/2+0.06);     // brim
  } else {
    box(hs+0.03,0.34,0.10,vehLam(hairC),0,1.52,-hs/2-0.03);    // long hair back
    box(hs+0.03,0.10,hs+0.03,vehLam(hairC),0,1.70,0);          // top
  }
  g.scale.setScalar(scl);
  g.userData={armL:armL,armR:armR,legL:legL,legR:legR,phase:Math.random()*6.28};
  return g;
}


/* ---------------- helpers ---------------- */
/* Safe ground-height lookup (never NaN — falls back to 0). */
function groundY(x,z){ try{ var y=heightAt(x,z); return isFinite(y)?y:0; }catch(e){ return 0; } }
/* spatial hash for PLACED_HOUSES (13k entries — no full loops in hot path) */
/* Build the 40-unit-cell spatial hash over PLACED_HOUSES so walkStep's
   obstacle probes stay O(1)-ish instead of scanning ~13k houses. */
var houseGrid=null;
function buildHouseGrid(){
  houseGrid={};
  try{
    for (var i=0;i<PLACED_HOUSES.length;i++){ var h=PLACED_HOUSES[i];
      var key=Math.floor(h[0]/40)+','+Math.floor(h[1]/40);
      (houseGrid[key]=houseGrid[key]||[]).push(h);
    }
  }catch(e){}
}
/* Blocked-test for walkStep probes: true when the point is in water, inside
   a building collider (bldgGrid, 3x3 cell sweep), or inside a placed-house
   footprint (houseGrid, same sweep). Guarded — returns false on any error. */
function wBlocked(x,z){
  try{
    if (typeof inWater==='function' && inWater(x,z)) return true;
    if (typeof bldgGrid!=='undefined' && bldgGrid){
      var cx=Math.floor(x/40), cz=Math.floor(z/40), gx, gz, i, cell, c, dx, dz, rr;
      for (gx=cx-1;gx<=cx+1;gx++) for (gz=cz-1;gz<=cz+1;gz++){
        cell=bldgGrid[gx+','+gz]; if(!cell) continue;
        for (i=0;i<cell.length;i++){ c=cell[i]; dx=x-c.x; dz=z-c.z; rr=c.r+0.8;
          if (dx*dx+dz*dz<rr*rr) return true; }
      }
    }
    if (houseGrid){
      var hx=Math.floor(x/40), hz=Math.floor(z/40), jx, jz, k, cell2, h2, ex, ez, er;
      for (jx=hx-1;jx<=hx+1;jx++) for (jz=hz-1;jz<=hz+1;jz++){
        cell2=houseGrid[jx+','+jz]; if(!cell2) continue;
        for (k=0;k<cell2.length;k++){ h2=cell2[k];
          ex=x-h2[0]; ez=z-h2[1]; er=Math.max(h2[2],h2[3])/2+1.5;
          if (ex*ex+ez*ez<er*er) return true; }
      }
    }
  }catch(e){}
  return false;
}
/* nearest non-highway road point to (x,z) */
function nearestRoadPt(x,z){
  var best=null, bd=1e18;
  try{
    for (var i=0;i<roadDrawData.length;i++){
      var r=roadDrawData[i];
      if (!r||!r.pts||r.pts.length<2||r.cat==='highway') continue;
      for (var j=0;j<r.pts.length;j++){
        var p=r.pts[j], dx=p[0]-x, dz=p[1]-z, d=dx*dx+dz*dz;
        if (d<bd){ bd=d; best={ri:i,x:p[0],z:p[1]}; }
      }
    }
  }catch(e){}
  return best;
}
/* Build a cumulative arc-length table for a road polyline (for roadPointAt /
   segTOf). */
function arcTable(pts){ var cum=[0];
  for (var i=1;i<pts.length;i++) cum.push(cum[i-1]+Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]));
  return cum; }
/* Interpolate a point on road R at arc-length t: x/z (linear), y (from the
   road's ys profile, or groundY fallback), and heading (atan2 of segment
   direction). Binary search over the arc table. */
function roadPointAt(R,cum,t){
  t=Math.max(0,Math.min(R.len,t));
  var pts=R.pts, ys=R.ys, lo=0, hi=cum.length-2, segL, f, dx, dz, hd;
  if (t<=0) lo=0; else if (t>=R.len) lo=hi;
  else { while(lo<hi){ var mid=(lo+hi)>>1; if (cum[mid+1]<t) lo=mid+1; else hi=mid; } }
  var p0=pts[lo], p1=pts[lo+1];
  dx=p1[0]-p0[0]; dz=p1[1]-p0[1]; segL=cum[lo+1]-cum[lo]||1; f=(t-cum[lo])/segL;
  hd=Math.atan2(dx,dz);
  return {x:p0[0]+dx*f, z:p0[1]+dz*f,
          y:(ys?ys[lo]+(ys[lo+1]-ys[lo])*f:groundY(p0[0]+dx*f,p0[1]+dz*f)),
          heading:hd};
}
/* Arc-length t of the nearest road-polyline point to (x,z) — used to snap
   bus stops / bus position onto a road at route build time. */
function segTOf(R,cum,x,z){
  var best=0, bd=1e18;
  for (var i=0;i<R.pts.length;i++){ var p=R.pts[i], dx=p[0]-x, dz=p[1]-z, d=dx*dx+dz*dz;
    if (d<bd){ bd=d; best=cum[i]; } }
  return best;
}

/* ---------------- schedule state machine ---------------- */
/* State ids: SLEEP / HOME / TO_STOP / WAIT / RIDE / SCHOOL / TO_HOME / HANGOUT. */
var ST={SLEEP:0,HOME:1,TO_STOP:2,WAIT:3,RIDE:4,SCHOOL:5,TO_HOME:6,HANGOUT:7};
/* day0 = MON; first 5 days are school days, weekends are hangout-only. */
function isSchoolDay(){ return (RN.day%7)<5; } // day0=MON
/* Transition a kid to a state and reset its state timer. */
function setKidState(k,st){ k.state=st; k.stateT=0; }

/* The kid's daily-schedule brain (called once per frame per kid):
   - 22:00-05:30 is a GLOBAL sleep override (goSleep hides the mesh)
   - SLEEP: wake at T_WAKE -> HOME on school days, HANGOUT on weekends
   - HOME: leave for the bus stop at k.leaveForStop (timed so the kid
     arrives ~2 game-min before the bus), wander otherwise, evening
     hangout 16:00-21:00; missed the bus -> walk to school
   - TO_STOP: walk to the bus stop (or school stop in the afternoon);
     arrival -> WAIT
   - WAIT: bus pickup happens via busBoardCheck; fallback: walk to school if
     the bus was missed (T_WAIT_FALLBACK)
   - RIDE: the bus moves the kid (no per-kid logic)
   - SCHOOL: wander the grounds; at T_SCHOOL_END walk to the school stop
   - TO_HOME: walk to home (or school on the missed-bus fallback);
     arrival -> HOME (or SCHOOL)
   - HANGOUT: wander the neighborhood via hangoutTick; back to TO_STOP on
     school mornings at k.leaveForStop */
function kidThink(k, nowMin){
  // global sleep window: 22:00 -> 05:30 — overrides any daytime state
  if (k.state!==ST.SLEEP && (nowMin>=T_SLEEP || nowMin<T_WAKE-60)){ goSleep(k); return; }
  var schoolDay=isSchoolDay();
  switch(k.state){
    case ST.SLEEP:
      if (nowMin>=T_WAKE){ setKidState(k, schoolDay?ST.HOME:ST.HANGOUT); k.mesh.visible=true; }
      break;
    case ST.HOME:
      if (schoolDay){
        if (nowMin>=k.leaveForStop && nowMin<=k.busArrival+5){ setKidState(k,ST.TO_STOP); k.tx=k.stop.x; k.tz=k.stop.z; }
        else if (nowMin>k.busArrival+5 && nowMin<T_SCHOOL_END){ k.tx=RN.school.x; k.tz=RN.school.z; setKidState(k,ST.TO_HOME); k.toSchool=true; } // missed bus: walk to school
        else if (nowMin>=960 && nowMin<T_SLEEP-60){ setKidState(k,ST.HANGOUT); pickHangout(k); } // evening hangout 16:00-21:00
        else if (nowMin>=T_SLEEP){ goSleep(k); }
        else wanderTick(k);
      } else {
        if (nowMin>=T_WAKE+30 && nowMin<1200){ setKidState(k,ST.HANGOUT); pickHangout(k); }
        else if (nowMin>=960 && nowMin<T_SLEEP-60){ setKidState(k,ST.HANGOUT); pickHangout(k); }
        else if (nowMin>=T_SLEEP){ goSleep(k); }
        else wanderTick(k);
      }
      break;
    case ST.TO_STOP:
      var ax=k.busAtSchool?RN.schoolStop.x:k.stop.x, az=k.busAtSchool?RN.schoolStop.z:k.stop.z;
      if (arrived(k,ax,az,4)) setKidState(k,ST.WAIT);
      break;
    case ST.WAIT:
      // bus pickup handled by bus logic; fallback: walk to school if bus long gone
      if (nowMin>=T_WAIT_FALLBACK){ k.tx=RN.school.x; k.tz=RN.school.z; setKidState(k,ST.TO_HOME); k.toSchool=true; }
      break;
    case ST.RIDE:
      break; // bus moves the kid
    case ST.SCHOOL:
      if (schoolDay && nowMin>=T_SCHOOL_END){ setKidState(k,ST.TO_STOP); k.tx=RN.schoolStop.x; k.tz=RN.schoolStop.z; k.toSchool=false; k.busAtSchool=true; }
      else if (!schoolDay){ setKidState(k,ST.HANGOUT); pickHangout(k); }
      else wanderTick(k, RN.school.x, RN.school.z, 55);
      break;
    case ST.TO_HOME:
      var gx=k.toSchool?RN.school.x:k.home.x, gz=k.toSchool?RN.school.z:k.home.z;
      // home arrival uses wider radius (house collider keeps them in the yard)
      if (arrived(k,gx,gz,k.toSchool?5:12)){
        if (k.toSchool){ setKidState(k,ST.SCHOOL); }
        else { k.x=gx; k.z=gz; k.y=groundY(gx,gz); setKidState(k,ST.HOME); }
      }
      break;
    case ST.HANGOUT:
      if (nowMin>=T_SLEEP){ goSleep(k); }
      else if (schoolDay && nowMin>=k.leaveForStop && nowMin<=k.busArrival+5){ setKidState(k,ST.TO_STOP); k.tx=k.stop.x; k.tz=k.stop.z; }
      else if (schoolDay && nowMin>k.busArrival+5 && nowMin<T_SCHOOL_END){ k.tx=RN.school.x; k.tz=RN.school.z; setKidState(k,ST.TO_HOME); k.toSchool=true; } // missed bus
      else hangoutTick(k);
      break;
  }
}
/* Put a kid to sleep: state SLEEP + hide the mesh (kid is "inside" home). */
function goSleep(k){ setKidState(k,ST.SLEEP); k.mesh.visible=false; }
/* True when the kid is within radius r of (tx,tz). */
function arrived(k,tx,tz,r){ var dx=k.x-tx, dz=k.z-tz; return dx*dx+dz*dz<r*r; }
/* Pick a hangout target ~40-250u from home (friend's house / yard / corner),
   retrying up to 10 times to avoid blocked (water/building) spots. */
function pickHangout(k){
  // friend's house, yard, or nearby corner — within ~250u of home
  var a=Math.random()*Math.PI*2, d=40+Math.random()*210;
  var tx=k.home.x+Math.cos(a)*d, tz=k.home.z+Math.sin(a)*d, tries=0;
  while (wBlocked(tx,tz) && tries<10){ a=Math.random()*Math.PI*2; d=40+Math.random()*210;
    tx=k.home.x+Math.cos(a)*d; tz=k.home.z+Math.sin(a)*d; tries++; }
  k.hx=tx; k.hz=tz; k.pauseT=2+Math.random()*6;
}
/* Wander around (cx,cz) within rad: pick a random unblocked target, walk to
   it, pause, repeat. Defaults to the kid's home. */
function wanderTick(k, cx, cz, rad){
  cx=(cx===undefined)?k.home.x:cx; cz=(cz===undefined)?k.home.z:cz; rad=rad||40;
  k.stateT-=1/60;
  if (k.stateT<=0){
    if (!k.wt){ var a=Math.random()*Math.PI*2, d=8+Math.random()*rad;
      var tx=cx+Math.cos(a)*d, tz=cz+Math.sin(a)*d;
      if (!wBlocked(tx,tz)){ k.wt={x:tx,z:tz}; } k.stateT=1+Math.random()*3; }
    else k.stateT=0.5;
  }
  if (k.wt){ if (arrived(k,k.wt.x,k.wt.z,2.5)) k.wt=null; else walkStep(k,k.wt.x,k.wt.z,1/60); }
}
/* Evening/weekend behavior: walk to the current hangout spot, pause
   (pauseT), then pick a new spot. */
function hangoutTick(k){
  if (k.pauseT>0){ k.pauseT-=1/60; k.moving=false; return; }
  if (!k.hx || arrived(k,k.hx,k.hz,3)){ pickHangout(k); return; }
  walkStep(k,k.hx,k.hz,1/60);
}
/* goal-directed walk with obstacle sweep: try headings around the want
   direction, nearest-first (biased by the kid's avoid side), take the first
   with a clear 3u probe. Robust slide-around for houses. */
/* (see block comment above — obstacle-sweep walk; also steers heading at
   most 4 rad/s and advances WALK_SPEED; fully-surrounded kids wait.) */
var SWEEP=[0,0.45,-0.45,0.9,-0.9,1.35,-1.35,1.8,-1.8,2.25,-2.25,2.7,-2.7,3.14];
function walkStep(k,tx,tz,dt){
  var dx=tx-k.x, dz=tz-k.z, d=Math.hypot(dx,dz);
  if (d<0.5){ k.moving=false; return; }
  var want=Math.atan2(dx,dz), chosen=null, i, h, px, pz;
  for (i=0;i<SWEEP.length;i++){
    h=want+SWEEP[i]*k.avoidDir;
    px=k.x+Math.sin(h)*3.0; pz=k.z+Math.cos(h)*3.0;
    if (!wBlocked(px,pz)){ chosen=h; break; }
  }
  if (chosen===null){ k.moving=false; return; } // fully surrounded: wait
  var dh=chosen-k.heading;
  while (dh>Math.PI) dh-=Math.PI*2; while (dh<-Math.PI) dh+=Math.PI*2;
  k.heading+=Math.max(-4*dt,Math.min(4*dt,dh));
  var step=Math.min(WALK_SPEED*dt, d);
  k.x+=Math.sin(k.heading)*step; k.z+=Math.cos(k.heading)*step;
  k.y=groundY(k.x,k.z); k.moving=true; k.phase+=dt*7;
}

/* ---------------- bus ---------------- */
/* Build the bus route (once, at init): order the 8 stops nearest-neighbor
   from the first home; then connect consecutive waypoints with 'road' legs
   (follow the shared road polyline by arc-length) or 'hop' legs (short
   direct hops when consecutive stops aren't on the same road). Builds both
   the AM pickup route (stops -> school) and the reversed PM dropoff route
   (school -> stops). */
function buildRoute(){
  // order stops nearest-neighbor from the first home
  var order=[0], used={0:true};
  while (order.length<RN.kids.length){
    var last=RN.kids[order[order.length-1]], bi=-1, bd=1e18;
    for (var i=0;i<RN.kids.length;i++){ if (used[i]) continue;
      var k=RN.kids[i], dx=k.stop.x-last.stop.x, dz=k.stop.z-last.stop.z, d=dx*dx+dz*dz;
      if (d<bd){ bd=d; bi=i; } }
    used[bi]=true; order.push(bi);
  }
  RN.stopOrder=order;
  // waypoints: stops (road pts) then school stop
  var wps=order.map(function(i){ return RN.kids[i].stop; });
  wps.push(RN.schoolStop);
  // legs: consecutive waypoint pairs -> road-follow if same road else direct hop
  var legs=[];
  for (var w=0;w<wps.length-1;w++){
    var A=wps[w], B=wps[w+1];
    if (A.ri===B.ri && A.ri>=0){
      var R=roadDrawData[A.ri], cum=arcTable(R.pts);
      if (!R.len) R.len=cum[cum.length-1];
      var tA=segTOf(R,cum,A.x,A.z), tB=segTOf(R,cum,B.x,B.z);
      legs.push({type:'road',ri:A.ri,t0:tA,t1:tB,stopAt:B,stopKid:order[w+1]});
    } else {
      legs.push({type:'hop',x0:A.x,z0:A.z,x1:B.x,z1:B.z,stopAt:B,stopKid:order[w+1]});
    }
  }
  RN.amLegs=legs;
  // afternoon: school -> stops reversed (direct hops + road legs, reversed)
  var wps2=[RN.schoolStop].concat(order.slice().reverse().map(function(i){ return RN.kids[i].stop; }));
  var legs2=[];
  for (var w2=0;w2<wps2.length-1;w2++){
    var A2=wps2[w2], B2=wps2[w2+1];
    if (A2.ri===B2.ri && A2.ri>=0){
      var R2=roadDrawData[A2.ri], cum2=arcTable(R2.pts);
      if (!R2.len) R2.len=cum2[cum2.length-1];
      legs2.push({type:'road',ri:A2.ri,t0:segTOf(R2,cum2,A2.x,A2.z),t1:segTOf(R2,cum2,B2.x,B2.z),stopAt:B2,
                  stopKid:order[order.length-1-w2]});
    } else {
      legs2.push({type:'hop',x0:A2.x,z0:A2.z,x1:B2.x,z1:B2.z,stopAt:B2,
                  stopKid:order[order.length-1-w2]});
    }
  }
  RN.pmLegs=legs2;
}
/* Per-stop bus arrival times + per-kid departure times (Joshua 2026-10-09).
   The AM bus is fully deterministic now: spawns at stopOrder[0] at
   T_BUS_AM-15, dwells BUS_DWELL_S (real sec) per stop, drives legs at
   BUS_SPEED. Arrival at each stop is computed in game minutes; each kid's
   walk time (straight-line * 1.5 for detours, at WALK_SPEED) is subtracted
   along with a 2-game-minute buffer so the kid arrives just before the bus
   instead of standing around for an hour. */
function computeStopSchedule(){
  RN.stopArrivals={};
  var t=T_BUS_AM-15; // bus spawns at the first stop
  RN.stopArrivals[RN.stopOrder[0]]=t;
  t+=BUS_DWELL_S*DAY_SCALE;
  for (var w=0; w<RN.amLegs.length-1; w++){
    var leg=RN.amLegs[w];
    var dist=(leg.type==='road')?Math.abs(leg.t1-leg.t0)
                                :Math.hypot(leg.x1-leg.x0,leg.z1-leg.z0);
    t+=(dist/BUS_SPEED)*DAY_SCALE; // drive this leg
    RN.stopArrivals[RN.stopOrder[w+1]]=t; // bus reaches the next stop
    t+=BUS_DWELL_S*DAY_SCALE; // dwell there
  }
  for (var i=0;i<RN.kids.length;i++){
    var k=RN.kids[i];
    k.busArrival=RN.stopArrivals[k.stopIdx];
    var wd=Math.hypot(k.stop.x-k.home.x,k.stop.z-k.home.z);
    var walkMin=(wd/WALK_SPEED)*DAY_SCALE*1.5; // 1.5x for obstacle detours
    k.leaveForStop=Math.max(T_WAKE, k.busArrival-walkMin-2); // 2-min buffer
  }
}
/* Board kids near the bus (25u): AM — a WAITing kid boards for school;
   PM — boarding at the school stop for the ride home (records the kid's
   dropStop), and drop-off when the bus reaches that kid's stop (kid becomes
   TO_HOME, mesh shown at the bus). */
function busBoardCheck(){
  var b=RN.bus;
  if (b.mode!=='am' && b.mode!=='pm') return;
  for (var i=0;i<RN.kids.length;i++){
    var k=RN.kids[i];
    var dx=k.x-b.x, dz=k.z-b.z, near=dx*dx+dz*dz<25*25;
    if (b.mode==='am' && k.state===ST.WAIT && !k.busAtSchool && near){
      setKidState(k,ST.RIDE); k.mesh.visible=false; k.busSeat=i; k.busAtSchool=false;
    }
    if (b.mode==='pm' && b.boarding && k.busAtSchool && (k.state===ST.WAIT||k.state===ST.TO_STOP) && near){
      // board at school for the ride home
      setKidState(k,ST.RIDE); k.mesh.visible=false; k.dropStop=k.stopIdx; k.busAtSchool=false;
    }
    if (b.mode==='pm' && !b.boarding && k.state===ST.RIDE && k.dropStop===b.atStop){
      // drop at this kid's stop
      setKidState(k,ST.TO_HOME); k.toSchool=false; k.busAtSchool=false; k.mesh.visible=true;
      k.x=b.x+2; k.z=b.z+2; k.y=groundY(k.x,k.z);
    }
  }
}
/* all pm riders aboard? (no one left heading to the school stop) */
/* True when no kid is still walking to / waiting at the school stop — i.e.
   the PM bus can end its boarding phase and roll. */
function pmReady(){
  for (var i=0;i<RN.kids.length;i++){ var k=RN.kids[i];
    if (k.busAtSchool && (k.state===ST.TO_STOP||k.state===ST.WAIT)) return false; }
  return true;
}

/* Park the bus visibly when not running its route (Joshua: school buses
   should be visible in the world, not vanish). Per Joshua: between runs,
   always park AT THE SCHOOL (Harper Archer High lot) — midday, after PM
   dropoff, overnight, and weekends. */
function parkBus(b, where){
  var px, pz;
  px=RN.school.x+40; pz=RN.school.z+25;
  b.x=px; b.z=pz;
  try{ b.y=groundY(px,pz); }catch(e){ b.y=0; }
  b.heading=0.6;
  if (typeof clampVehY==='function') b.y=clampVehY(b.x,b.z,b.y);  // v1.12 ground clamp
  b.mesh.position.set(b.x,b.y,b.z);
  b.mesh.rotation.y=b.heading;
  b.mesh.visible=true;
}
/* Drive the bus state machine per frame. Modes:
   - off / parked_off: idle — park at the school
   - am: morning pickup loop (spawns near T_BUS_AM); pauses at each stop
     (60s) until that stop's kid boards (max wait)
   - pm: afternoon — first a boarding phase at the school (waits for riders
     or 150s timeout), then the reversed dropoff legs
   - midday / done_pm: route finished — park at the school
   Weekends and non-school days: always parked at the school. The bus mesh
   stays visible while parked (Joshua: buses don't vanish). Riding kids are
   pinned to the bus; AM riders become SCHOOL kids at the school, PM riders
   become TO_HOME kids at their stops. */
function updateBus(dt, nowMin){
  var b=RN.bus, schoolDay=isSchoolDay();
  if (!schoolDay){ if(b.mode!=='parked_off'){ parkBus(b,'school'); b.mode='parked_off'; } return; }
  b.mesh.visible=true;
  if (b.mode==='off' || b.mode==='parked_off'){ parkBus(b,'school'); b.mode='off'; }
  if (nowMin>=T_BUS_AM-15 && nowMin<T_BUS_AM+120 && b.mode==='off'){
    b.mode='am'; b.leg=0; b.t=0; b.tInit=false; b.pauseT=BUS_DWELL_S; b.atStop=RN.stopOrder[0];
    b.waitKid=RN.stopOrder[0];
    var s0=RN.kids[RN.stopOrder[0]].stop; b.x=s0.x; b.z=s0.z; b.y=groundY(s0.x,s0.z);
  }
  if (nowMin>=T_BUS_PM && nowMin<T_BUS_PM+180 && b.mode!=='pm' && b.mode!=='done_pm'){
    // afternoon: bus waits at the school stop while kids walk over and board
    b.mode='pm'; b.leg=0; b.t=0; b.tInit=false; b.pauseT=0; b.atStop=-1; b.waitKid=-1;
    b.boarding=true; b.boardT=0;
    b.x=RN.schoolStop.x; b.z=RN.schoolStop.z; b.y=groundY(b.x,b.z);
    if (typeof clampVehY==='function') b.y=clampVehY(b.x,b.z,b.y);  // v1.12 ground clamp
  b.mesh.position.set(b.x,b.y,b.z); b.mesh.visible=true;
  }
  if (b.mode!=='am' && b.mode!=='pm') return;
  // pm boarding phase: wait at school until riders are aboard (or 150s timeout)
  if (b.mode==='pm' && b.boarding){
    b.boardT+=dt;
    busBoardCheck();
    if (pmReady() || b.boardT>150){ b.boarding=false; }
    else return;
  }
  var legs=(b.mode==='am')?RN.amLegs:RN.pmLegs;
  if (b.leg>=legs.length){
    // route done
    if (b.mode==='am'){
      for (var j=0;j<RN.kids.length;j++){ var k2=RN.kids[j];
        if (k2.state===ST.RIDE){ setKidState(k2,ST.SCHOOL); k2.mesh.visible=true;
          k2.x=RN.school.x+(Math.random()-0.5)*30; k2.z=RN.school.z+(Math.random()-0.5)*30;
          k2.y=groundY(k2.x,k2.z); } }
      b.mode='midday'; parkBus(b,'school');
    } else { b.mode='done_pm'; parkBus(b,'school'); }
    return;
  }
  if (b.pauseT>0){
    b.pauseT-=dt;
    /* Dwell is deterministic (BUS_DWELL_S) so kids can time their arrival.
       No early departure — the schedule is the schedule. */
    busBoardCheck(); return;
  }
  var leg=legs[b.leg], arrived=false;
  if (leg.type==='road'){
    var R=roadDrawData[leg.ri], cum=arcTable(R.pts);
    var dir=leg.t1>=leg.t0?1:-1;
    if (!b.tInit){ b.t=leg.t0; b.tInit=true; }
    b.t+=dir*BUS_SPEED*dt;
    if ((dir>0&&b.t>=leg.t1)||(dir<0&&b.t<=leg.t1)){ b.t=leg.t1; arrived=true; }
    var rp=roadPointAt(R,cum,b.t);
    b.x=rp.x; b.z=rp.z; b.heading=dir>0?rp.heading:rp.heading+Math.PI;
    b.y=rp.y;
  } else {
    var dx=leg.x1-b.x, dz=leg.z1-b.z, d=Math.hypot(dx,dz);
    var want=Math.atan2(dx,dz), dh=want-b.heading;
    while (dh>Math.PI) dh-=Math.PI*2; while (dh<-Math.PI) dh+=Math.PI*2;
    b.heading+=Math.max(-1.2*dt,Math.min(1.2*dt,dh));
    if (d<3){ arrived=true; } else {
      var step=Math.min(BUS_SPEED*dt,d);
      b.x+=Math.sin(b.heading)*step; b.z+=Math.cos(b.heading)*step;
      b.y=groundY(b.x,b.z);
    }
  }
  if (arrived){
    b.atStop=leg.stopKid;
    b.pauseT=(b.mode==='am')?BUS_DWELL_S:6; b.waitKid=(b.mode==='am')?leg.stopKid:-1;
    b.leg++; b.tInit=false;
    if (b.mode==='am'){ /* kids board during pause via busBoardCheck */ }
    else { // pm: drop this kid now
      for (var m=0;m<RN.kids.length;m++){ var k3=RN.kids[m];
        if (k3.state===ST.RIDE && k3.stopIdx===leg.stopKid){
          setKidState(k3,ST.TO_HOME); k3.toSchool=false; k3.mesh.visible=true;
          k3.x=b.x+2.5; k3.z=b.z+2.5; k3.y=groundY(k3.x,k3.z);
        } }
    }
  }
  // pose bus
  if (typeof clampVehY==='function') b.y=clampVehY(b.x,b.z,b.y);  // v1.12 ground clamp
  b.mesh.position.set(b.x,b.y,b.z);
  b.mesh.rotation.y=b.heading;
  var wa=b.mesh.userData.wheels;
  for (var wI=0;wI<wa.length;wI++) wa[wI].rotation.x+=BUS_SPEED*dt/0.5;
  // riding kids stick with the bus
  for (var rI=0;rI<RN.kids.length;rI++){ var kr=RN.kids[rI];
    if (kr.state===ST.RIDE){ kr.x=b.x; kr.z=b.z; kr.y=b.y; } }
  busBoardCheck();
}

/* ---------------- init ---------------- */
/* Find the school's coordinates: prefer the 'HARPER ARCHER' enterable's
   door, fall back to the schools3 build constants. */
function findSchool(){
  var sx=4060, sz=2595; // Harper Archer High School (per schools3 build)
  try{
    if (typeof ENTERABLES!=='undefined' && ENTERABLES.length){
      for (var i=0;i<ENTERABLES.length;i++){
        var e=ENTERABLES[i];
        if (e && e.name && /HARPER ARCHER/i.test(e.name)){ sx=e.doorX; sz=e.doorZ; break; }
      }
    }
  }catch(e){}
  return {x:sx, z:sz};
}
/* One-time init: pick 8 distinct homes (nearest placed houses to HOME,
   spread >=45u apart, fallback = random spots), spawn each kid with their
   recipe + nearest-road bus stop, create the school bus, build the route,
   add the tiny HUD clock, and wrap the global animate() so updateRefNPCs
   runs every frame. Game clock starts Mon 06:00. */
function initRefNPC(){
  RN={kids:[], bus:null, day:0, clockMin:360, hud:null};
  buildHouseGrid();
  var hx=(typeof HOME!=='undefined'&&HOME)?HOME.x:3160,
      hz=(typeof HOME!=='undefined'&&HOME)?HOME.z:3614;
  // 8 distinct homes: nearest houses to HOME, spread apart
  var cands=[];
  try{
    for (var i=0;i<PLACED_HOUSES.length;i++){ var h=PLACED_HOUSES[i];
      var dx=h[0]-hx, dz=h[1]-hz, d=Math.hypot(dx,dz);
      if (d<1200) cands.push({x:h[0],z:h[1],d:d});
    }
  }catch(e){}
  cands.sort(function(a,b){return a.d-b.d;});
  var homes=[];
  for (var c=0;c<cands.length && homes.length<8;c++){
    var ok=true;
    for (var hh=0;hh<homes.length;hh++){
      var ex=homes[hh].x-cands[c].x, ez=homes[hh].z-cands[c].z;
      if (ex*ex+ez*ez<45*45){ ok=false; break; }
    }
    if (ok) homes.push(cands[c]);
  }
  while (homes.length<8) homes.push({x:hx+(Math.random()-0.5)*400, z:hz+(Math.random()-0.5)*400, d:999});
  var school=findSchool();
  var sStop=nearestRoadPt(school.x,school.z)||{ri:-1,x:school.x,z:school.z};
  RN.school=school; RN.schoolStop=sStop;
  // spawn kids
  for (var k=0;k<8;k++){
    var r=RECIPES[k], home=homes[k];
    var stop=nearestRoadPt(home.x,home.z)||{ri:-1,x:home.x,z:home.z};
    var mesh=buildKid(r);
    var kx=home.x+6, kz=home.z+6, tries=0;
    while (wBlocked(kx,kz)&&tries<8){ kx=home.x+6+tries*3; kz=home.z+6; tries++; }
    mesh.position.set(kx,groundY(kx,kz),kz);
    scene.add(mesh);
    RN.kids.push({name:r.name, recipe:r, mesh:mesh,
      home:{x:home.x,z:home.z}, stop:stop, stopIdx:k,
      x:kx, z:kz, y:groundY(kx,kz), heading:Math.random()*6.28,
      state:ST.HOME, stateT:0, phase:Math.random()*6.28, moving:false,
      wt:null, hx:0, hz:0, pauseT:0, toSchool:false, busSeat:-1, dropStop:-1,
      busAtSchool:false, avoidDir:(k%2?1:-1), detour:0});
  }
  // bus
  var busMesh=schoolBusMesh(); busMesh.visible=false; scene.add(busMesh);
  RN.bus={mesh:busMesh, mode:'off', leg:0, t:0, tInit:false, pauseT:0,
          x:0, z:0, y:0, heading:0, atStop:-1, waitKid:-1,
          boarding:false, boardT:0};
  buildRoute();
  computeStopSchedule(); // per-stop arrivals + per-kid leave times (v1.1)
  /* v1.2 (Joshua 2026-10-09): REMOVED the tiny blue HUD clock — daycycle.js
     already shows DAY/DATE/TIME/WEATHER/SEASON in the large top-center HUD.
     The duplicate small blue clock just cluttered the screen. RN.hud stays
     undefined; the update loop guards on it. */
  // hook animate
  try{
    if (typeof animate==='function' && !animate.__refnpcWrap){
      var orig=animate;
      /* v1.22 LAUNCHER (Joshua 2026-10-10): photo NPCs follow the NPCs launch option. */
      var wrapped=function(){ orig(); if(!window.__npcPaused && (!window.__launchOpts || window.__launchOpts.npcs!==false)) updateRefNPCs(); };
      wrapped.__refnpcWrap=true; animate=wrapped;
    }
  }catch(e){}
  try{ if (typeof Report!=='undefined' && Report.setSys)
    Report.setSys('refnpc',{status:'ok',version:'1.1',kids:RN.kids.length,
      note:'8 photo NPCs w/ daily schedules + school bus (Harper Archer High); 124-min day, per-stop timed arrivals'}); }catch(e){}
  window.REFNPC=RN;
}

/* ---------------- main loop ---------------- */
var hudT=0;
/* Per-frame tick (called from the wrapped animate(), dt clamped to 50ms):
   advance the game clock (24 game hrs = 124 real min via DAY_SCALE, day
   rolls at 1440), run kidThink + walk movement per kid, pose visible meshes
   with a simple limb-swing walk animation, drive the bus, and update the
   HUD clock once per second. */
function updateRefNPCs(dt){
  if (!RN || !RN.kids.length) return;
  try{
    dt=Math.min(0.05, dt||0.016);
    // game clock: 24 game hrs = 124 real min (Joshua 2026-10-09)
    RN.clockMin+=dt*DAY_SCALE;
    if (RN.clockMin>=1440){ RN.clockMin-=1440; RN.day++; }
    var nowMin=RN.clockMin;
    for (var i=0;i<RN.kids.length;i++){
      var k=RN.kids[i];
      k.moving=false;
      kidThink(k, nowMin);
      // walk movement handled inside states via walkStep/wanderTick
      if (k.state===ST.TO_STOP) walkStep(k,k.tx,k.tz,dt);
      else if (k.state===ST.TO_HOME){
        var gx=k.toSchool?RN.school.x:k.home.x, gz=k.toSchool?RN.school.z:k.home.z;
        walkStep(k,gx,gz,dt);
      }
      // pose mesh
      if (k.mesh.visible){
        k.mesh.position.set(k.x,k.y,k.z);
        k.mesh.rotation.y=k.heading;
        var u=k.mesh.userData;
        if (k.moving){ k.phase+=dt*7;
          var sw=Math.sin(k.phase)*0.5;
          u.armL.rotation.x=sw; u.armR.rotation.x=-sw;
          u.legL.rotation.x=-sw; u.legR.rotation.x=sw;
        } else {
          u.armL.rotation.x*=0.9; u.armR.rotation.x*=0.9;
          u.legL.rotation.x*=0.9; u.legR.rotation.x*=0.9;
        }
      }
    }
    updateBus(dt, nowMin);
    // HUD clock
    hudT-=dt;
    if (hudT<=0 && RN.hud){ hudT=1;
      var hh=Math.floor(nowMin/60), mm=Math.floor(nowMin%60);
      RN.hud.textContent='DAY '+(RN.day+1)+' '+DAYS[RN.day%7]+' '+
        (hh<10?'0':'')+hh+':'+(mm<10?'0':'')+mm;
    }
  }catch(e){}
}
window.updateRefNPCs=function(dt){ updateRefNPCs(dt||0.016); };

/* Boot poller: init runs only when THREE, scene, roadDrawData (>100 roads),
   PLACED_HOUSES, and animate are all ready — checked every 250ms, giving up
   with a logged error after 60s (240 tries). Module is single-instance via
   window.__refnpcV1. */
var bootTries=0;
var bootTimer=setInterval(function(){
  bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined'&&typeof scene!=='undefined'&&
      typeof roadDrawData!=='undefined'&&roadDrawData.length>100&&
      typeof PLACED_HOUSES!=='undefined'&&PLACED_HOUSES.length>0&&
      typeof animate==='function');
  }catch(e){ ready=false; }
  if (ready){
    try{ initRefNPC(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('refnpc','init failed',String(e&&e.message||e)); }catch(x){}
    }
    clearInterval(bootTimer);
  } else if (bootTries>240){
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('refnpc','boot-timeout','deps never ready'); }catch(e){}
  }
},250);

})();
