/* ============================================================================
   BIRD DRONES v1.0 (2026-10-09)
   Joshua's directive: the 100 inspection drones must be disguised as BIRDS.
   To anyone watching, they are just birds flying over the city — crows,
   hawks, pigeons, cardinals, blue jays, robins. Under the fiction they are
   still the inspection fleet: each bird patrols one sector of the 10x10
   city grid (800x1200u sectors over the 8000x12000 world).

   Follow-up directive: randomize species and colors — NOT all the same bird.

   Self-contained module. Zero edits to index.html logic required: this file
   boot-polls for (THREE, scene, player, animate), then wraps the global
   animate() exactly like traffic_system.js does, so updateBirdDrones() runs
   every frame.

   Performance: 3 InstancedMeshes (bodies / left wings / right wings) = 3 draw
   calls for all 100 birds. 300 matrix updates per frame. frustumCulled=false
   on all three (instances span the whole map; the default bounding sphere
   would wrongly cull them).

   Depends on globals: THREE, scene, heightAt, mulberry32, Report (optional).
   ============================================================================ */
(function birdDrones(){
'use strict';

/* ---------- species table ----------
   body/wing: plumage colors. size: overall scale multiplier.
   flap: wingbeats per second. glide: fraction of time spent gliding with
   wings held flat (hawks soar; pigeons almost never glide).
   count: how many of the 100 birds are this species (sums to 100). */
var BIRD_SPECIES=[
  {name:'crow',     body:0x1b1b1b, wing:0x2a2a2a, size:1.25, flap:9,  glide:0.30, count:22,
   note:'all-black, broad wings, slow rowing flap with glide breaks'},
  {name:'pigeon',   body:0x8b8b98, wing:0x54545e, size:0.95, flap:13, glide:0.05, count:30,
   note:'gray body, darker wingtips, fast constant flutter'},
  {name:'hawk',     body:0x5e3d22, wing:0x4a3018, size:1.70, flap:5,  glide:0.85, count:6,
   note:'red-tailed hawk: brown body, broad wings, mostly soaring'},
  {name:'cardinal', body:0xc22424, wing:0x981818, size:0.85, flap:12, glide:0.10, count:16,
   note:'bright red male northern cardinal'},
  {name:'bluejay',  body:0xb9c2cc, wing:0x2b5fc4, size:0.90, flap:12, glide:0.10, count:14,
   note:'blue wings/tail, pale gray body'},
  {name:'robin',    body:0x8a5c34, wing:0x5e4028, size:0.85, flap:12, glide:0.10, count:12,
   note:'rust-red breast, brown back'}
];
var N_BIRDS=100;

/* ---------- module state ---------- */
var BD=null;           // state object once initialized
var _lastT=0;          // internal clock for dt
var _dummy=null, _m=new (typeof THREE!=='undefined'?THREE.Matrix4:Function)(),
    _q=new (typeof THREE!=='undefined'?THREE.Quaternion:Function)(),
    _q2=new (typeof THREE!=='undefined'?THREE.Quaternion:Function)(),
    _e=new (typeof THREE!=='undefined'?THREE.Euler:Function)(),
    _v=new (typeof THREE!=='undefined'?THREE.Vector3:Function)(),
    _s=new (typeof THREE!=='undefined'?THREE.Vector3:Function)(),
    _wq=new (typeof THREE!=='undefined'?THREE.Quaternion:Function)(),
    _wm=new (typeof THREE!=='undefined'?THREE.Matrix4:Function)();

/* initBirdDrones() — builds the fleet.
   Each bird gets: a species (deterministic via seeded rng so the mix is
   stable across loads), a home sector of the 10x10 grid, an elliptical
   patrol path inside it, a cruise altitude above the local terrain, and
   flight parameters tuned to its species. */
function initBirdDrones(){
  var rng=mulberry32(0xB1BD);   // fixed seed: same birds every load
  // species roster: expand counts into a 100-entry list, then shuffle
  var roster=[];
  BIRD_SPECIES.forEach(function(sp,si){
    for(var k=0;k<sp.count;k++) roster.push(si);
  });
  for(var i=roster.length-1;i>0;i--){
    var j=Math.floor(rng()*(i+1)), t=roster[i]; roster[i]=roster[j]; roster[j]=t;
  }
  // geometries: body = elongated sphere; wings = planes pivoted at the body
  var bodyGeo=new THREE.SphereGeometry(0.55, 8, 6);
  var wingRGeo=new THREE.PlaneGeometry(2.4, 1.0); wingRGeo.translate(1.2, 0, 0);
  var wingLGeo=new THREE.PlaneGeometry(2.4, 1.0); wingLGeo.translate(-1.2, 0, 0);
  var bodyMat=new THREE.MeshLambertMaterial({color:0xffffff});
  var wingMat=new THREE.MeshLambertMaterial({color:0xffffff, side:THREE.DoubleSide});
  var bodies=new THREE.InstancedMesh(bodyGeo, bodyMat, N_BIRDS);
  var wingR=new THREE.InstancedMesh(wingRGeo, wingMat, N_BIRDS);
  var wingL=new THREE.InstancedMesh(wingLGeo, wingMat, N_BIRDS);
  [bodies, wingR, wingL].forEach(function(m){
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled=false;   // instances cover the whole map
    scene.add(m);
  });
  var birds=[];
  for(var b=0;b<N_BIRDS;b++){
    var sp=BIRD_SPECIES[roster[b]];
    // home sector: bird b patrols sector (b%10, floor(b/10)) of the 10x10 grid
    var col=b%10, row=Math.floor(b/10);
    var scx=col*800+400, scz=row*1200+600;
    var gy=30; try{ gy=heightAt(scx, scz); }catch(e){}
    birds.push({
      sp:sp, si:roster[b],
      cx:scx+(rng()-0.5)*300, cz:scz+(rng()-0.5)*400,   // patrol center jitter
      rx:150+rng()*220, rz:150+rng()*260,                // patrol ellipse radii
      alt:gy+28+rng()*38,                               // cruise altitude above terrain
      dir:rng()<0.5?1:-1,                               // clockwise / counter
      spd:(sp.name==='hawk'?7+rng()*3:9+rng()*7),        // hawks soar slow
      ph:rng()*Math.PI*2,                               // path phase
      fp:rng()*Math.PI*2,                               // flap phase
      bobA:1.5+rng()*2.5, bobR:0.5+rng()*0.8             // vertical bob
    });
    var bc=new THREE.Color(sp.body), wc=new THREE.Color(sp.wing);
    // slight per-bird tint variation so no two birds are identical
    var tv=0.92+rng()*0.16;
    bodies.setColorAt(b, bc.multiplyScalar(tv));
    wingR.setColorAt(b, wc.clone().multiplyScalar(tv));
    wingL.setColorAt(b, wc.clone().multiplyScalar(tv*0.96));
  }
  bodies.instanceColor.needsUpdate=true;
  wingR.instanceColor.needsUpdate=true;
  wingL.instanceColor.needsUpdate=true;
  _dummy=new THREE.Object3D();
  BD={birds:birds, bodies:bodies, wingR:wingR, wingL:wingL, t:0};
  _lastT=performance.now()/1000;
  // hook the frame loop (same wrap pattern as traffic_system.js)
  try{
    if(typeof animate==='function' && !animate.__birdWrap){
      var orig=animate;
      var wrapped=function(){ orig(); updateBirdDrones(); };
      wrapped.__birdWrap=true;
      animate=wrapped;
    }
  }catch(e){}
  try{
    var mix={}; BIRD_SPECIES.forEach(function(sp){ mix[sp.name]=sp.count; });
    if(typeof Report!=='undefined') Report.setSys('birds',
      {status:'ok', version:'1.0', count:N_BIRDS, species:mix,
       note:'inspection drones disguised as birds; one per city sector'});
  }catch(e){}
  window.BIRD_DRONES=BD;   // expose only after a clean init
}

/* updateBirdDrones() — per-frame tick. Each bird flies its elliptical patrol,
   banks into the turn, bobs gently, and flaps (or glides, per species).
   Wing matrices are derived from the body matrix so wings stay attached. */
function updateBirdDrones(){
  if(!BD) return;
  var now=performance.now()/1000;
  var dt=Math.min(0.05, now-_lastT); _lastT=now;
  BD.t+=dt;
  var T=BD.t, D=_dummy;
  for(var i=0;i<BD.birds.length;i++){
    var b=BD.birds[i], sp=b.sp;
    var a=b.ph + T*b.dir*b.spd/Math.max(1,(b.rx+b.rz)/2);
    var px=b.cx+Math.cos(a)*b.rx, pz=b.cz+Math.sin(a)*b.rz;
    var py=b.alt+Math.sin(T*b.bobR+b.fp)*b.bobA;
    // velocity -> yaw (face travel direction), pitch, bank
    var vx=-Math.sin(a)*b.rx*b.dir, vz=Math.cos(a)*b.rz*b.dir;
    var yaw=Math.atan2(vx, vz);
    var vy=Math.cos(T*b.bobR+b.fp)*b.bobA*b.bobR;
    var pitch=Math.atan2(vy, Math.hypot(vx,vz))*0.6;
    var bank=-b.dir*0.38;   // bank into the turn
    // flap: sinusoidal wingbeats; gliders hold wings ~flat between bursts
    var cyc=(T+b.fp)%6;
    var gliding=cyc < 6*sp.glide;
    var flapAmp=gliding?0.06:0.85;
    var flap=Math.sin(T*sp.flap*Math.PI*2+b.fp*7)*flapAmp;
    // body matrix
    _e.set(pitch, yaw, bank, 'YXZ'); _q.setFromEuler(_e);
    _v.set(px, py, pz); _s.set(0.75*sp.size, 0.62*sp.size, 1.55*sp.size);
    _m.compose(_v, _q, _s);
    BD.bodies.setMatrixAt(i, _m);
    // wings: body orientation * flap rotation about the forward (Z) axis
    _wq.copy(_q);
    // right wing (+X side)
    _e.set(0, 0, flap); _q2.setFromEuler(_e);
    _wm.compose(_v, _wq.multiply(_q2), _s.set(sp.size, sp.size, sp.size));
    BD.wingR.setMatrixAt(i, _wm);
    // left wing (-X side): mirrored flap
    _wq.copy(_q);
    _e.set(0, 0, -flap); _q2.setFromEuler(_e);
    _wm.compose(_v, _wq.multiply(_q2), _s.set(sp.size, sp.size, sp.size));
    BD.wingL.setMatrixAt(i, _wm);
  }
  BD.bodies.instanceMatrix.needsUpdate=true;
  BD.wingR.instanceMatrix.needsUpdate=true;
  BD.wingL.instanceMatrix.needsUpdate=true;
}

/* Boot: wait until the main script has built the world (scene, player,
   animate all exist), then init exactly once. Same pattern as traffic. */
var bootTries=0;
var bootTimer=setInterval(function(){
  bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined' && typeof scene!=='undefined' &&
           typeof player!=='undefined' && typeof animate==='function' &&
           typeof heightAt==='function');
  }catch(e){ ready=false; }
  if(ready){
    try{ initBirdDrones(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('birds','init failed',String(e&&e.message||e)); }catch(x){}
    }
    clearInterval(bootTimer);
  }else if(bootTries>240){   // 60s — give up quietly, never break the game
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('birds','boot-timeout','deps never ready'); }catch(e){}
  }
}, 250);

})();
