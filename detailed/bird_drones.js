/* ============================================================================
   AIRPLANE DRONES v2.0 (2026-10-10)
   Joshua's directive: REPLACE the bird drones — 500 flapping birds were the
   heaviest performance load in the game and stalled his phone. New tactic:
   miniature airplane drones (like RC planes). Simpler models, no wing-flap
   animation, far fewer units.

   v1.x history: inspection drones disguised as birds (crows, hawks, pigeons,
   cardinals, blue jays, robins) with per-species sinusoidal wing-flap.
   v1.1 5x expansion took the fleet 100 -> 500. That is now reversed.

   v2.0 AIRPLANES:
   - 50 miniature airplane drones (down from 500 birds).
   - Each plane: fuselage + fixed main wing + horizontal stabilizer +
     vertical tail fin, all merged into ONE geometry = 1 InstancedMesh.
   - Propeller: simple 2-blade cross = 1 more InstancedMesh (spins cheaply).
   - Total: 2 draw calls for the whole fleet (was 3 draw calls for birds,
     plus 1500 matrix updates/frame for flap math — now 100/frame).
   - NO wing-flap animation. Wings are static. The only per-frame math is
     patrol position + orientation + prop spin.
   - Same patrol/inspection behavior: elliptical patrol paths, banking into
     turns, cruise altitude above terrain, distance culling.

   Filename kept as bird_drones.js (index.html script tag + ui-manifest entry
   unchanged). window.BIRD_DRONES is still exposed with a .birds array so
   priority_dispatch.js keeps working untouched.

   Self-contained module. Zero edits to index.html logic required: this file
   boot-polls for (THREE, scene, player, animate), then wraps the global
   animate() exactly like traffic_system.js does, so updatePlaneDrones() runs
   every frame.

   Depends on globals: THREE, scene, heightAt, mulberry32, Report (optional).
   ============================================================================ */
(function airplaneDrones(){
'use strict';

/* ---------- configuration ----------
   N_PLANES: fleet size. 50 is the sweet spot Joshua approved — enough for
   visible coverage, cheap enough for a 3GB phone. Bump only if profiling
   says the phone can take it. */
var N_PLANES=50;

/* Paint schemes for the fleet (fuselage color).
   Miniature RC-plane look: bright, high-visibility colors. One material for
   the whole airframe, so wings share the body color per instance — full
   two-tone would need a second InstancedMesh (not worth a draw call). */
var PAINT_SCHEMES=[
  {body:0xd42a1e, note:'red'},
  {body:0x1e5fd4, note:'blue'},
  {body:0xf2c41e, note:'yellow'},
  {body:0x2a9d3a, note:'green'},
  {body:0xe06a1e, note:'orange'}
];

/* ---------- module state ---------- */
var PD=null;           // state object once initialized
var _lastT=0;          // internal clock for dt
var _dummy=null, _m=new (typeof THREE!=='undefined'?THREE.Matrix4:Function)(),
    _q=new (typeof THREE!=='undefined'?THREE.Quaternion:Function)(),
    _q2=new (typeof THREE!=='undefined'?THREE.Quaternion:Function)(),
    _e=new (typeof THREE!=='undefined'?THREE.Euler:Function)(),
    _v=new (typeof THREE!=='undefined'?THREE.Vector3:Function)(),
    _s=new (typeof THREE!=='undefined'?THREE.Vector3:Function)(),
    _nose=new (typeof THREE!=='undefined'?THREE.Vector3:Function)();

/* mergeBoxParts(parts) — build ONE BufferGeometry out of several boxes.
   Each part: {w,h,d, x,y,z, rx,ry,rz} (size, offset, optional rotation).
   We convert each BoxGeometry to non-indexed and concatenate the position /
   normal / uv arrays manually, so this works without BufferGeometryUtils.
   Returns a single merged BufferGeometry. */
function mergeBoxParts(parts){
  var pos=[], nor=[], uv=[];
  parts.forEach(function(p){
    var g=new THREE.BoxGeometry(p.w, p.h, p.d);
    if(p.rx||p.ry||p.rz){
      _e.set(p.rx||0, p.ry||0, p.rz||0); _q.setFromEuler(_e);
      g.applyQuaternion(_q);
    }
    g.translate(p.x||0, p.y||0, p.z||0);
    var ng=g.toNonIndexed();
    var pa=ng.getAttribute('position').array,
        na=ng.getAttribute('normal').array,
        ua=ng.getAttribute('uv').array;
    for(var i=0;i<pa.length;i++) pos.push(pa[i]);
    for(var j=0;j<na.length;j++) nor.push(na[j]);
    for(var k=0;k<ua.length;k++) uv.push(ua[k]);
    g.dispose(); ng.dispose();
  });
  var out=new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  out.setAttribute('normal',   new THREE.Float32BufferAttribute(nor,3));
  out.setAttribute('uv',       new THREE.Float32BufferAttribute(uv,2));
  return out;
}

/* initPlaneDrones() — builds the fleet.
   Each plane gets: a paint scheme (deterministic via seeded rng so the mix
   is stable across loads), a home sector of a 10x5 grid (800x2400u sectors
   over the 8000x12000 world = 50 sectors, one plane each), an elliptical
   patrol path inside it, a cruise altitude above the local terrain, and
   flight parameters. */
function initPlaneDrones(){
  var rng=mulberry32(0xA1B5);   // fixed seed: same fleet every load
  // airframe geometry: fuselage + main wing + tailplane + fin, merged.
  // Forward = +Z (matches the yaw math: yaw=atan2(vx,vz) faces +Z along
  // the velocity vector). Units are game units; the plane is ~4 long.
  var airframeGeo=mergeBoxParts([
    {w:0.7, h:0.7, d:4.0, x:0, y:0,    z:0},     // fuselage
    {w:6.0, h:0.12,d:1.1, x:0, y:0.15, z:0.3},   // main wing (fixed, no flap)
    {w:2.4, h:0.1, d:0.7, x:0, y:0.12, z:-1.7},  // horizontal stabilizer
    {w:0.1, h:1.0, d:0.8, x:0, y:0.55, z:-1.7}   // vertical tail fin
  ]);
  // propeller: 2-blade cross at the nose (z=+2.05), spins about the Z axis
  var propGeo=mergeBoxParts([
    {w:0.16, h:2.4, d:0.08, x:0, y:0, z:0},
    {w:2.4, h:0.16, d:0.08, x:0, y:0, z:0}
  ]);
  var frameMat=new THREE.MeshLambertMaterial({color:0xffffff});
  var propMat=new THREE.MeshLambertMaterial({color:0x2b2b2b});
  var frames=new THREE.InstancedMesh(airframeGeo, frameMat, N_PLANES);
  var props=new THREE.InstancedMesh(propGeo, propMat, N_PLANES);
  [frames, props].forEach(function(m){
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled=false;   // instances cover the whole map
    scene.add(m);
  });
  var birds=[];   // kept named "birds" — priority_dispatch.js reads BD.birds
  for(var b=0;b<N_PLANES;b++){
    var scheme=PAINT_SCHEMES[b%PAINT_SCHEMES.length];
    // home sector: plane b patrols sector (b%10, floor(b/10)) of the 10x5 grid
    var col=b%10, row=Math.floor(b/10);
    var scx=col*800+400, scz=row*2400+1200;
    var gy=30; try{ gy=heightAt(scx, scz); }catch(e){}
    birds.push({
      scheme:scheme,
      cx:scx+(rng()-0.5)*300, cz:scz+(rng()-0.5)*600,   // patrol center jitter
      rx:180+rng()*260, rz:220+rng()*340,                // patrol ellipse radii
      alt:gy+42+rng()*55,                                // cruise altitude (higher than birds)
      dir:rng()<0.5?1:-1,                                // clockwise / counter
      spd:17+rng()*13,                                   // planes cruise faster than birds
      ph:rng()*Math.PI*2,                                // path phase
      prop:rng()*Math.PI*2,                              // propeller phase
      propSpd:28+rng()*14,                               // propeller rad/sec
      bobA:1.0+rng()*1.5, bobR:0.4+rng()*0.6             // gentle vertical bob
    });
    var bc=new THREE.Color(scheme.body);
    // slight per-plane tint variation so no two planes are identical
    var tv=0.92+rng()*0.16;
    frames.setColorAt(b, bc.multiplyScalar(tv));
  }
  frames.instanceColor.needsUpdate=true;
  _dummy=new THREE.Object3D();
  PD={birds:birds, frames:frames, props:props, t:0};
  _lastT=performance.now()/1000;
  // hook the frame loop (same wrap pattern as traffic_system.js)
  try{
    if(typeof animate==='function' && !animate.__planeWrap){
      var orig=animate;
      /* v1.22 LAUNCHER (Joshua 2026-10-10): skip when drones disabled in launch options. */
      var wrapped=function(){ orig(); if(!window.__launchOpts || window.__launchOpts.drones!==false) updatePlaneDrones(); };
      wrapped.__planeWrap=true;
      animate=wrapped;
    }
  }catch(e){}
  try{
    if(typeof Report!=='undefined') Report.setSys('drones',
      {status:'ok', version:'2.0', count:N_PLANES,
       note:'miniature airplane inspection drones; one per city sector'});
  }catch(e){}
  window.BIRD_DRONES=PD;   // keep legacy name: priority_dispatch.js reads this
  window.PLANE_DRONES=PD;  // new canonical name
}

/* updatePlaneDrones() — per-frame tick. Each plane flies its elliptical
   patrol, banks into the turn, bobs gently. Wings are STATIC (no flap) —
   the only per-plane work is one airframe matrix + one propeller matrix.
   2 matrix composes x 50 planes = 100/frame (was 3 x 500 = 1500/frame). */
function updatePlaneDrones(){
  if(!PD) return;
  var now=performance.now()/1000;
  var dt=Math.min(0.05, now-_lastT); _lastT=now;
  PD.t+=dt;
  var T=PD.t;
  // DISTANCE CULLING (Joshua 2026-10-10): skip matrix updates for planes
  // beyond cull distance — they freeze in place until the player nears.
  var _zu=null; try{ _zu=window.ZONEUNLOCK; }catch(e){}
  for(var i=0;i<PD.birds.length;i++){
    var b=PD.birds[i];
    if(_zu && _zu.shouldCull(b.cx, b.cz)) continue;
    var avgR=Math.max(1,(b.rx+b.rz)/2);
    var a=b.ph + T*b.dir*b.spd/avgR;
    var px=b.cx+Math.cos(a)*b.rx, pz=b.cz+Math.sin(a)*b.rz;
    var py=b.alt+Math.sin(T*b.bobR+b.prop)*b.bobA;
    // velocity -> yaw (face travel direction), pitch, bank
    var vx=-Math.sin(a)*b.rx*b.dir, vz=Math.cos(a)*b.rz*b.dir;
    var yaw=Math.atan2(vx, vz);
    var vy=Math.cos(T*b.bobR+b.prop)*b.bobA*b.bobR;
    var pitch=Math.atan2(vy, Math.hypot(vx,vz))*0.6;
    var bank=-b.dir*0.35;   // bank into the turn
    // airframe matrix (one compose per plane)
    _e.set(pitch, yaw, bank, 'YXZ'); _q.setFromEuler(_e);
    _v.set(px, py, pz); _s.set(1, 1, 1);
    _m.compose(_v, _q, _s);
    PD.frames.setMatrixAt(i, _m);
    // propeller: nose offset in plane-local space, spun about the forward axis
    b.prop+=dt*b.propSpd;
    _nose.set(0, 0, 2.05).applyQuaternion(_q);  // nose world offset
    _e.set(0, 0, b.prop); _q2.setFromEuler(_e);  // spin about local Z
    _q2.premultiply(_q);                          // plane orientation * spin
    _v.set(px+_nose.x, py+_nose.y, pz+_nose.z);
    _s.set(1, 1, 1);
    _m.compose(_v, _q2, _s);
    PD.props.setMatrixAt(i, _m);
  }
  PD.frames.instanceMatrix.needsUpdate=true;
  PD.props.instanceMatrix.needsUpdate=true;
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
    try{ initPlaneDrones(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('drones','init failed',String(e&&e.message||e)); }catch(x){}
    }
    clearInterval(bootTimer);
  }else if(bootTries>240){   // 60s — give up quietly, never break the game
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('drones','boot-timeout','deps never ready'); }catch(e){}
  }
}, 250);

})();
