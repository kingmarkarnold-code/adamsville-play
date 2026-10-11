/* ============================================================================
   FILE: vehicle_meshes.js — "Surviving Adamsville" CANONICAL vehicle builders
   ----------------------------------------------------------------------------
   PURPOSE: SINGLE SOURCE OF TRUTH for every vehicle mesh in the game AND the
   watcher. The watcher loads this SAME file live from the published game URL
   (https://kingmarkarnold-code.github.io/adamsville-play/detailed/), so the
   studio previews the exact geometry the game renders — never duplicate a
   builder elsewhere. The game loads it via play/detailed/index.html.
   CONVENTIONS (all builders):
     - Return a THREE.Group; take no scene argument (callers add to scene).
       Depend only on global THREE.
     - Forward = local +Z (matches yaw movement); left = +X = DRIVER side
       (US left-hand drive — see VAN_SPEC.md; the van was fixed from a
       right-hand-drive build, so verify left/right on every new vehicle).
     - BoxGeometry + MeshLambertMaterial styling (stylized 3D-animation look,
       matching the game's art direction — never photorealistic).
     - userData exposes: wheels[] (spin from distance driven), doors[]
       (hinged, animated via setCarDoors), steerWheel, spinners[]
       (independent spinner-rim parts), body/cab/hood (damage pop), len
       (coupled length).
   BUILDERS: sedanMesh, addCockpit (driver's-seat dash + wheel), safariMesh
     (Joshua's 1985-1994 GMC Safari van — brown/bronze + cream two-tone, the
     player's MAIN DRIVING VAN), boxChevyMesh / bubbleChevyMesh (donk
     Caprices, 1977-1990 / 1991-1996 — candy paint, lifted stance, oversized
     chrome rims; every Chevy is one-of-a-kind, paint+rim combo never
     repeats), pickupMesh (90s single-cab, open bed), suvMesh, semiMesh
     (stylized 18-wheeler), martaBusMesh (MARTA city bus, white + blue/green),
     schoolBusMesh. Shared: pickPaint, pickRimStyle, makeDonkWheel, addCarDoor,
     setCarDoors, addCarInterior, vehMat (cached materials), groundY.
   NOTE: traffic_system.js has its own separate simple instanced sedan meshes
   for ambient traffic — those are NOT these builders (instancing vs. these
   detailed meshes). The player's drivable van is safariMesh.
   Extracted 2026-10-09: sedan/safari/chevys/pickup/suv from index.html,
   semiMesh from semi_system.js, martaBusMesh from marta_bus_system.js,
   schoolBusMesh from refnpc_system.js.
   ========================================================================== */
/* ============================================================================
   SURVIVING ADAMSVILLE — SHARED VEHICLE MESH BUILDERS (canonical module)
   ----------------------------------------------------------------------------
   SINGLE SOURCE OF TRUTH for every vehicle mesh in the game AND the watcher.
   - Game: loaded by play/detailed/index.html (and mirrored to project/www/)
   - Watcher: loaded directly from the published game URL
             (https://kingmarkarnold-code.github.io/adamsville-play/detailed/vehicle_meshes.js)
             — if the game's download source ever moves to Joshua's own server
             (see the DOWNLOAD SOURCE ARCHITECTURE comment at the ASSETVER
             BASE constant in index.html), this watcher URL moves with it.
   Builders take no scene argument and return a THREE.Group — callers add it to
   their own scene. Depends only on global THREE.
   Extracted 2026-10-09: sedan/safari/chevys/pickup/suv from index.html,
   semiMesh from semi_system.js, martaBusMesh from marta_bus_system.js,
   schoolBusMesh from refnpc_system.js.
   ========================================================================== */
/* ============================================================================
   v1.46 VEHICLE GEOMETRY/MATERIAL CACHE (expert report #5 — Dr. Elena Vasquez)
   ----------------------------------------------------------------------------
   BEFORE: every builder minted fresh GPU geometry + materials per spawn
   (~112 constructions across this file; ~35 meshes for one box Chevy, each
   with fresh materials) -> GPU upload stalls / stutter when traffic appears.
   AFTER: one module-level registry. Each unique geometry is built ONCE and
   shared by every mesh; each unique material is built ONCE and shared.
   Spawning a vehicle now only allocates Mesh objects + Groups (cheap CPU
   wrappers) — zero new GPU buffers after warmup.
   RULES (do not break):
   - Cached geometry is NEVER mutated (no rotateZ on a cached geometry —
     rotate the MESH instead, as sedanMesh already does with w.rotation.z).
   - Per-instance paint still works: vehMat(color) caches one material per
     unique color, so unique donk paints each get their own shared entry.
   - Meshes stay separate objects (wheels spin, doors hinge, damage pops —
     those need individual objects, just not individual GPU buffers).
   - Callers must NEVER dispose() a cached asset (cached items carry
     userData.vcached=true). The old traffic_assist retire-dispose path
     targeted its own self-built assist car, not these builders.
   ========================================================================== */
var _vGeoCache={};   // key -> THREE.BufferGeometry (shared, never disposed)
var _vMatCache={};   // key -> THREE.Material (shared, never disposed)
// _vgeo(key, maker) — return cached geometry, building it once on first use.
function _vgeo(key, maker){
  var g=_vGeoCache[key];
  if(!g){ g=maker(); g.userData.vcached=true; _vGeoCache[key]=g; }
  return g;
}
// _rk(v) — round floats for stable cache keys (computed dims like rr*1.7).
function _rk(v){ return Math.round(v*10000)/10000; }
// Cached geometry constructors (same signatures as THREE's):
function _vbg(w,h,d){ return _vgeo('b:'+_rk(w)+','+_rk(h)+','+_rk(d),
  function(){ return new THREE.BoxGeometry(w,h,d); }); }
function _vcg(rt,rb,h,s){ return _vgeo('c:'+_rk(rt)+','+_rk(rb)+','+_rk(h)+','+s,
  function(){ return new THREE.CylinderGeometry(rt,rb,h,s); }); }
function _vtg(r,t,rs,ts){ return _vgeo('t:'+_rk(r)+','+_rk(t)+','+rs+','+ts,
  function(){ return new THREE.TorusGeometry(r,t,rs,ts); }); }
function _vpg(w,h){ return _vgeo('p:'+_rk(w)+','+_rk(h),
  function(){ return new THREE.PlaneGeometry(w,h); }); }
function _vcog(r,h,s){ return _vgeo('o:'+_rk(r)+','+_rk(h)+','+s,
  function(){ return new THREE.ConeGeometry(r,h,s); }); }
// _vmat(key, maker) — return cached material, building it once on first use.
function _vmat(key, maker){
  var m=_vMatCache[key];
  if(!m){ m=maker(); m.userData.vcached=true; _vMatCache[key]=m; }
  return m;
}
// Shared special materials (emissive / transparent variants):
/* v1.48 (#18): transparent vehicle glass -> Phong (catches specular
   highlights) via the shared palette. */
function _glassTMat(){ return _vmat('glassT', function(){
  if(typeof vehGlassTMat==='function'){ var m=vehGlassTMat(); if(m) return m; }
  return new THREE.MeshLambertMaterial({color:0x8fb4cc, transparent:true, opacity:0.45}); }); }
function _headlightMat(){ return _vmat('headlight', function(){
  return new THREE.MeshLambertMaterial({color:0xf5f0d8, emissive:0x444433}); }); }
function _taillightMat(){ return _vmat('taillight', function(){
  return new THREE.MeshLambertMaterial({color:0xa02020, emissive:0x330000}); }); }
function _safariHeadMat(){ return _vmat('safariHead', function(){
  return new THREE.MeshLambertMaterial({color:0xf5f0d8, emissive:0x555544}); }); }
function _semiHeadMat(){ return _vmat('semiHead', function(){
  return new THREE.MeshLambertMaterial({color:0xf5f0d8, emissive:0x333322}); }); }
// _martaDestMatGet() — the MARTA destination sign is identical on every bus
// ("MARTA" amber on black), so its canvas texture + material are built once.
var _martaDestMat=null;
function _martaDestMatGet(){
  if(_martaDestMat) return _martaDestMat;
  var cv=document.createElement('canvas'); cv.width=256; cv.height=48;
  var c=cv.getContext('2d');
  c.fillStyle='#1a1a1a'; c.fillRect(0,0,256,48);
  c.fillStyle='#ffb400'; c.font='bold 28px Arial';
  c.textAlign='center'; c.textBaseline='middle';
  c.fillText('MARTA',128,26);
  var tex=new THREE.CanvasTexture(cv);
  _martaDestMat=new THREE.MeshBasicMaterial({map:tex});
  _martaDestMat.userData.vcached=true;
  return _martaDestMat;
}
/* ================= end v1.46 cache block ================= */
/* ============================================================================
   v1.49 MERGED STATIC GEOMETRY (expert report #19 — Roberto Silva)
   ----------------------------------------------------------------------------
   #5 (v1.46) cached GPU buffers, but every vehicle still issued dozens of
   draw calls (a box Chevy built ~66 separate Meshes). This pass merges all
   STATIC parts — body panels, glass, trim, lights, interior — into ONE mesh
   per material, per vehicle.
   - _vmergeGeos(list): concatenates indexed BufferGeometries (position,
     normal, uv + index). The bundled three.min.js does NOT ship
     BufferGeometryUtils, so this is hand-rolled for the primitives used
     here (Box/Cylinder/Torus/Plane/Cone — all indexed, all carry
     position+normal+uv).
   - _vmat4(x,y,z,rx,ry,rz): compose a Matrix4 from position + euler.
   - _vbatch(): collects (cachedGeometry, slot, matrix) triples.
     flush(group, key, slotMats) groups parts by material slot, transforms
     CLONES of the #5-cached primitives (the cache itself is NEVER mutated),
     merges each slot, and caches the merged geometry under
     key+':'+slot — shared fleet-wide. Meshes stay per-instance because
     materials differ per paint job; merged geometries do not.
     Returns {slot: mergedMesh} so builders can keep userData.body/cab/hood
     refs (damage-pop API compatibility — they now point at the merged
     slot mesh containing that part).
   RULES (do not break):
   - Only STATIC parts go in the batch. Wheels (spin via rotation.x),
     doors (hinge via pivot), spinner caps (independent spin), police
     beacons + takedown light (visibility flash), the school-bus stop sign
     (swings out), warning lights (flash), and steerWheel (exposed ref)
     MUST stay separate meshes.
   - All builder dims are hardcoded constants, so merged geometry is
     identical for every instance of a builder — only materials vary.
   ========================================================================== */
var _vMergeCache={}; // key 'builder:slot[:variant]' -> merged BufferGeometry
function _vmergeGeos(list){
  var pos=[], nor=[], uv=[], idx=[], vOff=0, i, j;
  for(i=0;i<list.length;i++){
    var g=list[i];
    var p=g.attributes.position.array, n=g.attributes.normal.array;
    var u=g.attributes.uv ? g.attributes.uv.array : null;
    for(j=0;j<p.length;j++) pos.push(p[j]);
    for(j=0;j<n.length;j++) nor.push(n[j]);
    var vc=g.attributes.position.count, k;
    if(u){ for(j=0;j<u.length;j++) uv.push(u[j]); }
    else { for(k=0;k<vc;k++){ uv.push(0,0); } }
    if(g.index){ var ix=g.index.array;
      for(j=0;j<ix.length;j++) idx.push(ix[j]+vOff);
    } else { for(k=0;k<vc;k++) idx.push(k+vOff); }
    vOff+=vc;
  }
  var out=new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  out.setAttribute('normal',   new THREE.Float32BufferAttribute(nor,3));
  out.setAttribute('uv',       new THREE.Float32BufferAttribute(uv,2));
  out.setIndex(idx);
  return out;
}
// _vmat4(x,y,z,rx,ry,rz) — compose a transform matrix (Euler XYZ order,
// matching how the builders set mesh.rotation before this pass).
function _vmat4(x,y,z,rx,ry,rz){
  var m=new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(rx||0, ry||0, rz||0));
  m.setPosition(x||0, y||0, z||0);
  return m;
}
function _vbatch(){
  var parts=[]; // {g: cachedGeo, s: slot, m: Matrix4}
  return {
    // add(geo, slot, x,y,z, rx,ry,rz) — queue one static part.
    add: function(geo, slot, x, y, z, rx, ry, rz){
      parts.push({g:geo, s:slot, m:_vmat4(x,y,z,rx,ry,rz)});
    },
    // addM(geo, slot, matrix) — queue with a pre-composed matrix
    // (for nested pivots, e.g. wheel spokes / spinner blades).
    addM: function(geo, slot, matrix){
      parts.push({g:geo, s:slot, m:matrix});
    },
    // flush(group, key, slotMats) — merge per slot, add meshes, return refs.
    flush: function(group, key, slotMats){
      var bySlot={}, order=[], i, j;
      for(i=0;i<parts.length;i++){ var p=parts[i];
        if(!bySlot[p.s]){ bySlot[p.s]=[]; order.push(p.s); }
        bySlot[p.s].push(p);
      }
      var refs={};
      for(i=0;i<order.length;i++){
        var s=order[i], arr=bySlot[s], ck=key+':'+s, mg=_vMergeCache[ck];
        if(!mg){
          var geos=[];
          for(j=0;j<arr.length;j++){
            var c=arr[j].g.clone();   // clone: #5 cache is never mutated
            c.applyMatrix4(arr[j].m);  // normals fixed up by applyMatrix4
            geos.push(c);
          }
          mg=_vmergeGeos(geos);
          mg.userData.vcached=true;    // like #5: never dispose a cached asset
          _vMergeCache[ck]=mg;
        }
        var mesh=new THREE.Mesh(mg, slotMats[s]);
        group.add(mesh);
        refs[s]=mesh;
      }
      return refs;
    }
  };
}
/* ================= end v1.49 merge block ================= */
/* ----------------------------------------------------------------------------
   CANONICAL BUILDERS — conventions: forward = local +Z; left = +X = driver
   side (US left-hand drive); return a THREE.Group; callers add to scene.
   userData carries wheels[]/doors[]/steerWheel/spinners[]/body/cab/hood/len. */
// sedanMesh(color) — TRUE SCALE (~1.42m roofline: below the 1.85m character's
// eyeline). Body + glasshouse + hood + 4 wheels; exposes userData.body/cab/hood
// for the damage system. The game's stylized sedan archetype.
function sedanMesh(color){
  // TRUE SCALE: overall height ~1.42m (roofline below the 1.85m character's eyeline)
  // v1.49: static body merged per material (3 meshes -> 2 merged); wheels stay
  // separate (spin via rotation.x).
  var g=new THREE.Group();
  var B=_vbatch();
  B.add(_vbg(2.0,0.62,4.6),'paint', 0,0.55,0);
  B.add(_vbg(1.9,0.14,1.1),'paint', 0,0.92,1.7);
  B.add(_vbg(1.75,0.5,2.4),'glass', 0,1.12,-0.2);
  var refs=B.flush(g,'sedan',{paint:vehMat(color), glass:vehMat(0x1c2733)});
  g.userData.body=refs.paint; g.userData.cab=refs.glass; g.userData.hood=refs.paint;
  var wg=_vcg(0.34,0.34,0.3,10);
  var wm=vehMat(0x181818);
  /* v1.50 WHEEL SPIN + STEER (expert report #23, Katherine Brooks 2026-10-11):
     wheels register in g.userData.wheels (spun by updateCar via rotation.x —
     same distance-driven pattern as semi_system.js); front wheels (z>0,
     forward=+Z) sit in steer groups so updateCar can yaw them with steering. */
  g.userData.wheels=[];
  g.userData.steerGroups=[];
  [[0.95,1.5],[-0.95,1.5],[0.95,-1.5],[-0.95,-1.5]].forEach(function(p){
    var w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2;
    w.position.set(p[0],0.34,p[1]);
    if (p[1]>0){ var sg=new THREE.Group(); sg.position.copy(w.position);
      w.position.set(0,0,0); sg.add(w); g.add(sg); g.userData.steerGroups.push(sg);
    } else { g.add(w); }
    g.userData.wheels.push(w);
  });
  return g;
}
// addCockpit(carGroup, h) — dashboard + column + working steering wheel for
// drivable cars (driver's-seat view). h = height offset for taller vehicles
// (Safari van). Returns the steering wheel mesh.
function addCockpit(carGroup, h){
  h=h||0;
  var dash=new THREE.Mesh(_vbg(1.7,0.28,0.45),
    vehMat(0x2a2a30));
  dash.position.set(0,0.98+h,0.95); carGroup.add(dash);
  var col=new THREE.Mesh(_vcg(0.05,0.05,0.5,8),
    vehMat(0x222222));
  col.position.set(0.5,0.9+h,0.75); col.rotation.x=0.5; carGroup.add(col);
  var wheel=new THREE.Mesh(_vtg(0.26,0.05,8,18),
    vehMat(0x1a1a1a));
  wheel.position.set(0.5,1.02+h,0.68); wheel.rotation.x=-0.5; carGroup.add(wheel);
  return wheel;
}
/* safariMesh() — GMC SAFARI (first-gen 1985-1994): JOSHUA'S VAN, the
   player's MAIN DRIVING VAN from his group photo. Brown/bronze + cream
   two-tone 70s/80s conversion-van look (~2.35m tall). LEFT-hand drive:
   wheel at +X, double doors on the right/passenger side (fixed 2026-10-08 —
   it was built right-hand drive). Near-van interaction (Joshua's spec):
   per-door choice — ENTER vehicle OR OPEN door without entering. */
function safariMesh(){
  // v1.49: static body merged per material (16 meshes -> 6 merged); the old
  // cab Group is gone — glass parts merge into the 'glass' slot. Wheels stay
  // separate (spin via rotation.x).
  var g=new THREE.Group();
  var bronze=0x8a5a1e, cream=0xe6d3a3, trimC=0x1c1c1e, glassC=0x1c2733;
  var B=_vbatch();
  B.add(_vbg(2.0,0.95,4.8),'bronze', 0,0.85,0);            // lower body
  B.add(_vbg(1.96,0.72,4.5),'cream', 0,1.68,-0.1);         // upper body
  B.add(_vbg(2.02,0.1,4.82),'trim', 0,1.32,0);            // dividing stripe
  B.add(_vbg(1.7,0.6,0.08),'glass', 0,1.92,2.02, -0.24,0,0); // windshield
  [-1,1].forEach(function(s){
    B.add(_vbg(0.06,0.52,3.3),'glass', s*0.99,1.92,-0.2); // side glass
  });
  B.add(_vbg(1.7,0.52,0.08),'glass', 0,1.92,-2.32);       // rear glass
  B.add(_vbg(1.96,0.1,4.5),'cream', 0,2.3,-0.1);          // roof
  B.add(_vbg(1.9,0.5,0.9),'bronze', 0,1.02,2.35);          // hood / front clip
  B.add(_vbg(1.2,0.34,0.1),'trim', 0,0.92,2.82);          // grille
  [-1,1].forEach(function(s){
    B.add(_vbg(0.34,0.24,0.08),'shead', s*0.78,0.95,2.82);
    B.add(_vbg(0.24,0.4,0.08),'tail', s*0.85,1.08,-2.42);
  });
  [2.82,-2.42].forEach(function(zz){
    B.add(_vbg(2.05,0.28,0.25),'trim', 0,0.52,zz);        // bumpers
  });
  var refs=B.flush(g,'safari',{bronze:vehMat(bronze), cream:vehMat(cream),
    trim:vehMat(trimC), glass:vehMat(glassC), shead:_safariHeadMat(),
    tail:_taillightMat()});
  g.userData.body=refs.bronze; g.userData.cab=refs.glass; g.userData.hood=refs.bronze;
  // gold-style wheels
  var wg=_vcg(0.38,0.38,0.32,10);
  var wm=vehMat(0x8a6a2a);
  /* v1.50 WHEEL SPIN + STEER (expert report #23, Katherine Brooks 2026-10-11):
     wheels register in g.userData.wheels (spun by updateCar via rotation.x —
     same distance-driven pattern as semi_system.js); front wheels (z>0,
     forward=+Z) sit in steer groups so updateCar can yaw them with steering. */
  g.userData.wheels=[];
  g.userData.steerGroups=[];
  [[0.95,1.55],[-0.95,1.55],[0.95,-1.55],[-0.95,-1.55]].forEach(function(p){
    var w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2;
    w.position.set(p[0],0.38,p[1]);
    if (p[1]>0){ var sg=new THREE.Group(); sg.position.copy(w.position);
      w.position.set(0,0,0); sg.add(w); g.add(sg); g.userData.steerGroups.push(sg);
    } else { g.add(w); }
    g.userData.wheels.push(w);
  });
  return g;
}
/* ================= NEW VEHICLES v1.12 — Box/Bubble Chevy (donk), Pickup, SUV ===
   Stylized to match sedanMesh/safariMesh (BoxGeometry + MeshLambertMaterial).
   Forward = local +Z. Left = +X = DRIVER side (VAN_SPEC.md, US left-hand drive).
   Chevys are donk-customized: candy paint, lifted stance, oversized chrome rims.
   Every Chevy is one-of-a-kind (paint+rim combo never repeats). */

// ---------- paint: candy, metallic, two-tone. Chevys never repeat a combo. ----------
var CANDY_PAINTS=[0xc01818,0x1848c0,0x7a1fa0,0xd4a017,0x18a058,0xe05818,0xb01848,0x18b0a0,0xe01878,0x4818c0,0xf0e018,0x08c8b0];
var METAL_PAINTS=[0x8a8a92,0x3a3a40,0x5a6a7a,0x6a2a1a,0x1a2a5a,0xc0c0c8,0x4a5a3a];
var ROOF_PAINTS=[0xe8e0d0,0x181818,0xc0c0c8,0x8a1a1a,0x1848c0,0xd4a017];
var _usedChevyPaint={};
// pickPaint(kind, rimStyle) — returns {body, roof, stripe, style} from the
// candy/metallic palettes with a style roll (28% two-tone / 14% stripes /
// 8% fade / rest solid). For Chevys (boxchevy/bubblechevy) the
// kind+body+roof+style+rimStyle key is tracked in _usedChevyPaint so every
// Chevy is one-of-a-kind — no duplicate paint+rim combos in the fleet.
function pickPaint(kind, rimStyle){
  var isChevy=(kind==='boxchevy'||kind==='bubblechevy');
  var body, roof, stripe, style, key, tries=0;
  do{
    body=CANDY_PAINTS[(Math.random()*CANDY_PAINTS.length)|0];
    if (Math.random()<0.15) body=METAL_PAINTS[(Math.random()*METAL_PAINTS.length)|0];
    style='solid'; roof=null; stripe=null;
    var r=Math.random();
    if (r<0.28){ style='twotone'; roof=ROOF_PAINTS[(Math.random()*ROOF_PAINTS.length)|0]; if(roof===body) roof=0x181818; }
    else if (r<0.42){ style='stripes'; stripe=0xf0f0f0; }
    else if (r<0.50){ style='fade'; roof=CANDY_PAINTS[(Math.random()*CANDY_PAINTS.length)|0]; if(roof===body) roof=0x181818; }
    key=kind+'|'+body.toString(16)+'|'+(roof?roof.toString(16):'-')+'|'+style+'|'+rimStyle;
    tries++;
  }while(isChevy && _usedChevyPaint[key] && tries<80);
  if (isChevy) _usedChevyPaint[key]=1;
  return {body:body, roof:roof, stripe:stripe, style:style};
}

// ---------- rims: big donk rims. spinner + blade in the Chevy rotation. ----------
var RIM_STYLES=['spokes','mesh','deepdish','spinner','blade','chrome5'];
// pickRimStyle(kind) — one of spokes/mesh/deepdish/spinner/blade/chrome5.
// All styles are in the rotation for Chevys (incl. spinner & blade — the donk
// signature); regular cars can clone freely.
function pickRimStyle(kind){
  // Chevys: full rotation incl spinner & blade. Regular cars: any style, clones fine.
  return RIM_STYLES[(Math.random()*RIM_STYLES.length)|0];
}
function _chromeMat(){ return vehMat(0xdcdce4); }
function _darkTireMat(){ return vehMat(0x141414); }
function _addSpokes(face, n, len, w, mat, xOff){
  for(var i=0;i<n;i++){
    var piv=new THREE.Group();
    var s=new THREE.Mesh(_vbg(xOff, w, len), mat);
    s.position.z=len*0.30;
    piv.add(s); piv.rotation.x=i/n*Math.PI*2; face.add(piv);
  }
}
// makeDonkWheel(style, R) — oversized chrome-rim wheel (axle along X):
// tire + chrome barrel + styled face + center cap. 'spinner' style gets two
// independently-spinning 3-blade caps (g.userData.spinnerParts — callers
// register them in g.userData.spinners[] with a random velocity). R = tire
// radius; rim width derives from it (W=R*0.62).
function makeDonkWheel(style, R){
  // v1.49: wheel internals merged per material (tire + chrome + black).
  // The wheel GROUP still spins as one unit (callers animate rotation.x);
  // spinner caps stay separate groups (independent spin) with merged
  // internals of their own.
  var g=new THREE.Group();
  var W=R*0.62, chrome=_chromeMat(), darkT=_darkTireMat(),
      black=vehMat(0x1c1c20);
  var WB=_vbatch();
  var rr=R*0.68;
  WB.add(_vcg(R,R,W,14),'tire', 0,0,0, 0,0,Math.PI/2);                 // tire
  WB.add(_vcg(R*0.70,R*0.70,W*1.02,14),'chrome', 0,0,0, 0,0,Math.PI/2); // barrel
  function spokes(n, len, w, xOff){
    for(var i=0;i<n;i++){
      WB.addM(_vbg(xOff, w, len),'chrome',
        _vmat4(0,0,0, i/n*Math.PI*2,0,0).multiply(_vmat4(0,0,len*0.30, 0,0,0)));
    }
  }
  if (style==='spokes'){ spokes(5, rr*1.7, rr*0.22, W*1.06); }
  else if (style==='chrome5'){ spokes(5, rr*1.7, rr*0.42, W*1.06); }
  else if (style==='mesh'){ spokes(12, rr*1.7, rr*0.10, W*1.06); }
  else if (style==='deepdish'){
    WB.add(_vtg(rr*0.95, rr*0.12, 8, 20),'chrome', W*0.5,0,0, 0,Math.PI/2,0);
    WB.add(_vtg(rr*0.95, rr*0.12, 8, 20),'chrome', -W*0.5,0,0, 0,Math.PI/2,0);
    spokes(5, rr*1.5, rr*0.24, W*0.9);
  }
  else if (style==='blade'){
    // 5 split-spoke blades: black spokes with polished edges
    for(var b=0;b<5;b++){
      var pivM=_vmat4(0,0,0, b/5*Math.PI*2,0,0);
      [-0.22,0.22].forEach(function(off){
        WB.addM(_vbg(W*1.06, rr*0.16, rr*1.6),'black',
          pivM.clone().multiply(_vmat4(0,0,rr*0.5, off,0,0)));
        WB.addM(_vbg(W*1.08, rr*0.05, rr*1.6),'chrome',
          pivM.clone().multiply(_vmat4(0,rr*0.10,rr*0.5, off,0,0)));
      });
    }
    WB.add(_vtg(rr*0.98, rr*0.07, 8, 20),'chrome', 0,0,0, 0,Math.PI/2,0);
  }
  else if (style==='spinner'){
    // wire-spoke base + 3-blade spinner caps (spin independently)
    spokes(18, rr*1.7, rr*0.055, W*1.04);
    function spinnerCap(){
      var sg=new THREE.Group(), SB=_vbatch();
      SB.add(_vcg(rr*0.22,rr*0.28,W*0.5,10),'chrome', 0,0,0, 0,0,Math.PI/2);
      for(var k=0;k<3;k++){
        var km=_vmat4(0,0,0, k/3*Math.PI*2,0,0);
        SB.addM(_vbg(W*0.9, rr*0.20, rr*1.1),'chrome',
          km.clone().multiply(_vmat4(0,0,rr*0.55, 0,0,0)));
        SB.addM(_vcog(rr*0.14, rr*0.5, 6),'chrome',
          km.clone().multiply(_vmat4(0,0,rr*1.15, Math.PI/2,0,0)));
      }
      SB.flush(sg,'donkSpin:'+_rk(R),{chrome:chrome});
      return sg;
    }
    var spinG=spinnerCap(); spinG.position.x=W*0.55; g.add(spinG);
    var spinG2=spinnerCap(); spinG2.position.x=-W*0.55;
    spinG2.rotation.y=Math.PI; g.add(spinG2);
    g.userData.spinnerParts=[spinG, spinG2];
  }
  WB.add(_vcg(rr*0.16,rr*0.16,W*1.1,8),'chrome', 0,0,0, 0,0,Math.PI/2); // cap
  WB.flush(g,'donkWheel:'+style+':'+_rk(R),
    {tire:darkT, chrome:chrome, black:black});
  return g;
}

// addCarDoor(g, xPos, frontZ, doorLen, doorH, doorY, bodyMat) — hinged door:
// a pivot Group at the door's front edge (xPos = ±W/2; driver door at +X)
// with body panel + semi-transparent glass + handle. Animate via
// setCarDoors; the pivot rotation sign (openRot ±1.15 rad) swings each door
// outward on its own side. Registered on g.userData.doors[].
function addCarDoor(g, xPos, frontZ, doorLen, doorH, doorY, bodyMat){
  var piv=new THREE.Group();
  piv.position.set(xPos, doorY, frontZ);
  var panel=new THREE.Mesh(_vbg(0.09, doorH, doorLen), bodyMat);
  panel.position.set(0, 0, -doorLen/2+0.06); piv.add(panel);
  var glassM=_glassTMat();
  var win=new THREE.Mesh(_vbg(0.07, 0.42, doorLen*0.78), glassM);
  win.position.set(0, doorH/2+0.21, -doorLen/2+0.06); piv.add(win);
  var handle=new THREE.Mesh(_vbg(0.04, 0.06, 0.22),
    vehMat(0xd8d8dc));
  handle.position.set(xPos>0?0.07:-0.07, 0.12, -doorLen+0.35); piv.add(handle);
  g.add(piv);
  var d={pivot:piv, open:false, openRot:xPos>0?-1.15:1.15};
  (g.userData.doors=g.userData.doors||[]).push(d);
  return d;
}
// setCarDoors(car, open) — opens/closes every door registered on the car's
// mesh (userData.doors). car = the entity record {mesh}; safe no-op when
// the record or doors are missing.
function setCarDoors(car, open){
  if(!car||!car.mesh||!car.mesh.userData.doors) return;
  car.mesh.userData.doors.forEach(function(d){ d.open=open; });
}
// addCarInterior(g, o) — floor, two front seats + bench, dash, and the
// LEFT-HAND-DRIVE steering wheel at +X (VAN_SPEC.md — the van flip lesson:
// always verify +X = driver). o = {width, floorY, seatZ, dashZ, seatColor}.
// Exposes g.userData.steerWheel.
function addCarInterior(g, o){
  var dark=vehMat(0x232326);
  var seatM=vehMat(o.seatColor||0x3a3a40);
  var glassM=_glassTMat();
  var fl=new THREE.Mesh(_vbg(o.width*0.92,0.08,2.7),dark);
  fl.position.set(0,o.floorY,0.05); g.add(fl);
  [-0.52,0.52].forEach(function(sx){
    var st=new THREE.Mesh(_vbg(0.58,0.5,0.58),seatM);
    st.position.set(sx,o.floorY+0.32,o.seatZ); g.add(st);
    var bk=new THREE.Mesh(_vbg(0.58,0.62,0.18),seatM);
    bk.position.set(sx,o.floorY+0.62,o.seatZ-0.34); g.add(bk);
  });
  var bn=new THREE.Mesh(_vbg(1.55,0.45,0.62),seatM);
  bn.position.set(0,o.floorY+0.28,o.seatZ-1.15); g.add(bn);
  var dash=new THREE.Mesh(_vbg(o.width*0.88,0.3,0.5),dark);
  dash.position.set(0,o.floorY+0.78,o.dashZ); g.add(dash);
  // steering wheel — LEFT HAND DRIVE (+X), per VAN_SPEC.md
  var col=new THREE.Mesh(_vcg(0.05,0.05,0.5,8),dark);
  col.position.set(0.52,o.floorY+0.70,o.dashZ-0.28); col.rotation.x=0.5; g.add(col);
  var wheel=new THREE.Mesh(_vtg(0.24,0.045,8,18),
    vehMat(0x1a1a1a));
  wheel.position.set(0.52,o.floorY+0.82,o.dashZ-0.36); wheel.rotation.x=-0.5; g.add(wheel);
  g.userData.steerWheel=wheel;
  return wheel;
}
// _vinterior(B, o) — v1.49 batch version of addCarInterior: queues the
// static interior (floor, seats, dash, column) into batch B under the
// 'dark' and 'seat' slots. The steering wheel is NOT batched — it stays a
// separate mesh so g.userData.steerWheel keeps pointing at a real wheel.
// Returns the wheel spec so the caller can add it: {geo, x,y,z, rx}.
function _vinterior(B, o){
  var dark='dark', seat='seat';
  B.add(_vbg(o.width*0.92,0.08,2.7),dark, 0,o.floorY,0.05);
  [-0.52,0.52].forEach(function(sx){
    B.add(_vbg(0.58,0.5,0.58),seat, sx,o.floorY+0.32,o.seatZ);
    B.add(_vbg(0.58,0.62,0.18),seat, sx,o.floorY+0.62,o.seatZ-0.34);
  });
  B.add(_vbg(1.55,0.45,0.62),seat, 0,o.floorY+0.28,o.seatZ-1.15);
  B.add(_vbg(o.width*0.88,0.3,0.5),dark, 0,o.floorY+0.78,o.dashZ);
  B.add(_vcg(0.05,0.05,0.5,8),dark, 0.52,o.floorY+0.70,o.dashZ-0.28, 0.5,0,0);
  return {geo:_vtg(0.24,0.045,8,18), x:0.52, y:o.floorY+0.82, z:o.dashZ-0.36, rx:-0.5};
}
function glassMat(){ return _glassTMat(); }
function chromeTrimMat(){ return vehMat(0xd8d8dc); }
function paintStripe(g, y, z0, z1, width, color){
  var s=new THREE.Mesh(_vbg(width,0.03,z1-z0),
    vehMat(color));
  s.position.set(0,y,(z0+z1)/2); g.add(s);
}

/* ---- BOX CHEVY (1977-1990 Caprice, donk) — boxy upright silhouette ----
   Reference: tall formal roofline, vertical chrome grille, quad headlights,
   long flat hood/trunk, sharp edges. Lifted donk stance, big chrome rims. */
// boxChevyMesh(paint, rimStyle) — BOX CHEVY (1977-1990 Caprice, donk):
// tall formal roofline, vertical chrome grille + quad headlights, long flat
// hood/trunk, sharp edges; lifted donk stance (0.42u lift), big chrome rims
// (R=0.48), full interior + hinged doors. paint = pickPaint output.
function boxChevyMesh(paint, rimStyle){
  // v1.49: static exterior + interior merged per material (~21 meshes ->
  // ~9 merged). Doors hinge, wheels spin, spinners spin — all stay separate.
  var g=new THREE.Group();
  var bodyM=vehMat(paint.body);
  var roofM=vehMat(paint.roof||paint.body);
  var chrome=chromeTrimMat(), glass=glassMat(), dark=vehMat(0x1c1c1e);
  var W=2.0, L=5.3, lift=0.42;   // donk lift
  var B=_vbatch();
  B.add(_vbg(W,0.72,L),'body', 0,0.72+lift,0);                 // lower body
  B.add(_vbg(1.78,0.62,2.9),'glass', 0,1.42+lift,-0.25);       // greenhouse
  B.add(_vbg(1.84,0.1,3.0),'roof', 0,1.78+lift,-0.25);         // roof
  [[0.92,1.05],[-0.92,1.05],[0.92,-1.55],[-0.92,-1.55]].forEach(function(p){
    B.add(_vbg(0.09,0.66,0.14),'body', p[0],1.42+lift,p[1]);   // pillars
  });
  B.add(_vbg(1.9,0.14,1.5),'body', 0,1.12+lift,1.85);           // hood
  B.add(_vbg(1.9,0.5,1.15),'body', 0,1.28+lift,-2.05);         // trunk
  B.add(_vbg(1.5,0.42,0.1),'chrome', 0,0.95+lift,2.68);        // grille
  [-0.55,-0.19,0.19,0.55].forEach(function(hx){
    B.add(_vbg(0.3,0.24,0.08),'head', hx,0.95+lift,2.70);      // quad headlights
  });
  [2.72,-2.66].forEach(function(zz){
    B.add(_vbg(2.06,0.26,0.22),'chrome', 0,0.62+lift,zz);      // bumpers
  });
  B.add(_vbg(1.6,0.22,0.08),'tail', 0,1.15+lift,-2.64);        // taillight bar
  if (paint.stripe) B.add(_vbg(0.5,0.03,5.2),'stripe', 0,1.20+lift,0); // stripe
  var swSpec=_vinterior(B,{width:W, floorY:0.55+lift, seatZ:0.15, dashZ:1.15});
  var refs=B.flush(g,'boxChevy'+(paint.stripe?'S':''),
    {body:bodyM, roof:roofM, glass:glass, chrome:chrome, dark:dark,
     head:_headlightMat(), tail:_taillightMat(),
     stripe:vehMat(paint.stripe||0xffffff), seat:vehMat(0x4a3a30)});
  g.userData.body=refs.body; g.userData.cab=refs.glass; g.userData.hood=refs.body;
  var swheel=new THREE.Mesh(swSpec.geo, vehMat(0x1a1a1a));
  swheel.position.set(swSpec.x,swSpec.y,swSpec.z); swheel.rotation.x=swSpec.rx;
  g.add(swheel); g.userData.steerWheel=swheel;
  // doors (hinged — stay separate)
  addCarDoor(g, W/2, 1.05, 1.35, 0.62, 1.05+lift, bodyM);
  addCarDoor(g, -W/2, 1.05, 1.35, 0.62, 1.05+lift, bodyM);
  // BIG donk rims
  var R=0.48;
  [[0.95,1.65],[-0.95,1.65],[0.95,-1.65],[-0.95,-1.65]].forEach(function(p){
    var w=makeDonkWheel(rimStyle, R); w.position.set(p[0],R,p[1]); g.add(w);
    (g.userData.wheels=g.userData.wheels||[]).push(w);
    if (w.userData.spinnerParts) (g.userData.spinners=g.userData.spinners||[]).push(
      {parts:w.userData.spinnerParts, vel:1+Math.random()*2});
  });
  return g;
}

/* ---- BUBBLE CHEVY (1991-1996 Caprice, donk) — rounded flowing silhouette ----
   Reference: sleek aero body, curved rear glass flowing into trunk, sloped nose,
   flush rounded styling. Same donk treatment: candy paint, big chrome rims. */
// bubbleChevyMesh(paint, rimStyle) — BUBBLE CHEVY (1991-1996 Caprice, donk):
// sleek aero body, curved rear glass flowing into the trunk, sloped nose,
// flush rounded styling; same donk treatment as the box Chevy.
function bubbleChevyMesh(paint, rimStyle){
  // v1.49: static exterior + interior merged per material. Doors hinge,
  // wheels spin — stay separate.
  var g=new THREE.Group();
  var bodyM=vehMat(paint.body);
  var roofM=vehMat(paint.roof||paint.body);
  var chrome=chromeTrimMat(), glass=glassMat(), dark=vehMat(0x1c1c1e);
  var W=2.0, L=5.4, lift=0.42;
  var B=_vbatch();
  B.add(_vbg(W,0.66,L),'body', 0,0.68+lift,0);                  // lower body
  B.add(_vbg(1.76,0.55,2.7),'glass', 0,1.32+lift,-0.35);        // greenhouse
  B.add(_vbg(1.7,0.5,0.9),'glass', 0,1.22+lift,-1.85, 0.5,0,0); // rear glass
  B.add(_vbg(1.7,0.5,0.1),'glass', 0,1.30+lift,1.15, -0.42,0,0); // windshield
  B.add(_vbg(1.82,0.1,2.5),'roof', 0,1.64+lift,-0.35);          // roof
  B.add(_vbg(1.9,0.4,1.2),'body', 0,0.95+lift,2.15, 0.18,0,0);  // aero nose
  B.add(_vbg(1.85,0.42,0.9),'body', 0,1.05+lift,-2.3, -0.12,0,0); // trunk
  [-0.62,0.62].forEach(function(hx){
    B.add(_vbg(0.5,0.2,0.1),'head', hx,0.98+lift,2.72, 0.18,0,0);
  });
  B.add(_vbg(0.9,0.18,0.08),'dark', 0,0.82+lift,2.70);          // slim grille
  [2.72,-2.72].forEach(function(zz){
    B.add(_vbg(2.02,0.3,0.24),'body', 0,0.60+lift,zz);          // bumpers
  });
  B.add(_vbg(1.5,0.2,0.08),'tail', 0,1.02+lift,-2.74);
  if (paint.stripe) B.add(_vbg(0.5,0.03,5.4),'stripe', 0,1.06+lift,0);
  var swSpec=_vinterior(B,{width:W, floorY:0.52+lift, seatZ:0.05, dashZ:1.05});
  var refs=B.flush(g,'bubbleChevy'+(paint.stripe?'S':''),
    {body:bodyM, roof:roofM, glass:glass, dark:dark,
     head:_headlightMat(), tail:_taillightMat(),
     stripe:vehMat(paint.stripe||0xffffff), seat:vehMat(0x2a2a32)});
  g.userData.body=refs.body; g.userData.cab=refs.glass; g.userData.hood=refs.body;
  var swheel=new THREE.Mesh(swSpec.geo, vehMat(0x1a1a1a));
  swheel.position.set(swSpec.x,swSpec.y,swSpec.z); swheel.rotation.x=swSpec.rx;
  g.add(swheel); g.userData.steerWheel=swheel;
  addCarDoor(g, W/2, 0.95, 1.35, 0.58, 1.0+lift, bodyM);
  addCarDoor(g, -W/2, 0.95, 1.35, 0.58, 1.0+lift, bodyM);
  var R=0.48;
  [[0.95,1.7],[-0.95,1.7],[0.95,-1.7],[-0.95,-1.7]].forEach(function(p){
    var w=makeDonkWheel(rimStyle, R); w.position.set(p[0],R,p[1]); g.add(w);
    (g.userData.wheels=g.userData.wheels||[]).push(w);
    if (w.userData.spinnerParts) (g.userData.spinners=g.userData.spinners||[]).push(
      {parts:w.userData.spinnerParts, vel:1+Math.random()*2});
  });
  return g;
}

// pickupMesh(paint, rimStyle) — 90s American single-cab pickup: open bed
// with walls + tailgate, grille with square headlights, interior + doors,
// donk wheels (R=0.40).
function pickupMesh(paint, rimStyle){
  // v1.49: static exterior + bed + interior merged per material. Doors
  // hinge, wheels spin — stay separate.
  var g=new THREE.Group();
  var bodyM=vehMat(paint.body);
  var roofM=vehMat(paint.roof||paint.body);
  var glass=glassMat(), dark=vehMat(0x1c1c1e), chrome=chromeTrimMat();
  var W=2.0, lift=0.15;
  var B=_vbatch();
  B.add(_vbg(W,0.7,2.2),'body', 0,0.75+lift,1.35);          // chassis/cab lower
  B.add(_vbg(1.8,0.62,1.5),'glass', 0,1.42+lift,1.15);      // greenhouse
  B.add(_vbg(1.86,0.1,1.6),'roof', 0,1.78+lift,1.15);       // roof
  B.add(_vbg(1.9,0.16,1.0),'body', 0,1.14+lift,2.6);        // hood
  B.add(_vbg(1.4,0.35,0.1),'dark', 0,0.95+lift,3.12);       // grille
  [-0.7,0.7].forEach(function(hx){
    B.add(_vbg(0.36,0.26,0.08),'head', hx,0.98+lift,3.12); // headlights
  });
  B.add(_vbg(2.05,0.24,0.2),'chrome', 0,0.6+lift,3.14);     // front bumper
  var bedY=0.78+lift, bedZ0=-2.55, bedZ1=-0.15, bedL=bedZ1-bedZ0;
  B.add(_vbg(1.9,0.1,bedL),'dark', 0,bedY,(bedZ0+bedZ1)/2); // bed floor
  [0.95,-0.95].forEach(function(sx){
    B.add(_vbg(0.08,0.55,bedL),'body', sx,bedY+0.32,(bedZ0+bedZ1)/2); // walls
  });
  B.add(_vbg(1.9,0.55,0.08),'body', 0,bedY+0.32,bedZ0);     // tailgate
  B.add(_vbg(1.9,0.55,0.08),'body', 0,bedY+0.32,bedZ1);     // cab back
  [-0.8,0.8].forEach(function(tx){
    B.add(_vbg(0.2,0.4,0.08),'tail', tx,0.95+lift,-2.58);   // taillights
  });
  B.add(_vbg(2.05,0.24,0.2),'chrome', 0,0.6+lift,-2.6);      // rear bumper
  if (paint.stripe) B.add(_vbg(0.45,0.03,2.7),'stripe', 0,1.24+lift,1.75);
  var swSpec=_vinterior(B,{width:W, floorY:0.55+lift, seatZ:1.0, dashZ:1.95});
  var refs=B.flush(g,'pickup'+(paint.stripe?'S':''),
    {body:bodyM, roof:roofM, glass:glass, dark:dark, chrome:chrome,
     head:_headlightMat(), tail:_taillightMat(),
     stripe:vehMat(paint.stripe||0xffffff), seat:vehMat(0x3a3f4a)});
  g.userData.body=refs.body; g.userData.cab=refs.glass; g.userData.hood=refs.body;
  var swheel=new THREE.Mesh(swSpec.geo, vehMat(0x1a1a1a));
  swheel.position.set(swSpec.x,swSpec.y,swSpec.z); swheel.rotation.x=swSpec.rx;
  g.add(swheel); g.userData.steerWheel=swheel;
  addCarDoor(g, W/2, 1.7, 1.15, 0.6, 1.05+lift, bodyM);
  addCarDoor(g, -W/2, 1.7, 1.15, 0.6, 1.05+lift, bodyM);
  var R=0.40;
  [[0.95,2.0],[-0.95,2.0],[0.95,-1.7],[-0.95,-1.7]].forEach(function(p){
    var w=makeDonkWheel(rimStyle, R); w.position.set(p[0],R,p[1]); g.add(w);
    (g.userData.wheels=g.userData.wheels||[]).push(w);
    if (w.userData.spinnerParts) (g.userData.spinners=g.userData.spinners||[]).push(
      {parts:w.userData.spinnerParts, vel:1+Math.random()*2});
  });
  return g;
}

// suvMesh(paint, rimStyle) — stylized family SUV: tall wagon body, roof
// rails, interior + doors, donk wheels (R=0.42).
function suvMesh(paint, rimStyle){
  // v1.49: static exterior + interior merged per material. Doors hinge,
  // wheels spin — stay separate.
  var g=new THREE.Group();
  var bodyM=vehMat(paint.body);
  var roofM=vehMat(paint.roof||paint.body);
  var glass=glassMat(), dark=vehMat(0x1c1c1e);
  var W=2.0, lift=0.22;
  var B=_vbatch();
  B.add(_vbg(W,0.85,4.7),'body', 0,0.85+lift,0);               // wagon body
  B.add(_vbg(1.8,0.68,3.4),'glass', 0,1.6+lift,-0.3);          // glasshouse
  B.add(_vbg(1.86,0.1,3.5),'roof', 0,1.99+lift,-0.3);          // roof
  [[0.92,1.25],[-0.92,1.25],[0.92,-1.85],[-0.92,-1.85]].forEach(function(p){
    B.add(_vbg(0.1,0.72,0.16),'body', p[0],1.6+lift,p[1]);     // pillars
  });
  B.add(_vbg(1.9,0.14,1.0),'body', 0,1.32+lift,2.0);           // hood
  B.add(_vbg(1.3,0.32,0.1),'dark', 0,1.05+lift,2.42);          // grille
  [-0.65,0.65].forEach(function(hx){
    B.add(_vbg(0.34,0.26,0.08),'head', hx,1.08+lift,2.42);    // headlights
  });
  [-0.7,0.7].forEach(function(rx){
    B.add(_vbg(0.08,0.08,3.2),'dark', rx,2.08+lift,-0.3);      // roof rails
  });
  [2.44,-2.4].forEach(function(zz){
    B.add(_vbg(2.04,0.26,0.2),'dark', 0,0.68+lift,zz);         // bumpers
  });
  [-0.8,0.8].forEach(function(tx){
    B.add(_vbg(0.22,0.5,0.08),'tail', tx,1.1+lift,-2.42);      // taillights
  });
  if (paint.stripe) B.add(_vbg(0.45,0.03,4.8),'stripe', 0,1.40+lift,0.1);
  var swSpec=_vinterior(B,{width:W, floorY:0.62+lift, seatZ:0.6, dashZ:1.6});
  var refs=B.flush(g,'suv'+(paint.stripe?'S':''),
    {body:bodyM, roof:roofM, glass:glass, dark:dark,
     head:_headlightMat(), tail:_taillightMat(),
     stripe:vehMat(paint.stripe||0xffffff), seat:vehMat(0x424750)});
  g.userData.body=refs.body; g.userData.cab=refs.glass; g.userData.hood=refs.body;
  var swheel=new THREE.Mesh(swSpec.geo, vehMat(0x1a1a1a));
  swheel.position.set(swSpec.x,swSpec.y,swSpec.z); swheel.rotation.x=swSpec.rx;
  g.add(swheel); g.userData.steerWheel=swheel;
  addCarDoor(g, W/2, 1.35, 1.25, 0.66, 1.2+lift, bodyM);
  addCarDoor(g, -W/2, 1.35, 1.25, 0.66, 1.2+lift, bodyM);
  var R=0.42;
  [[0.95,1.55],[-0.95,1.55],[0.95,-1.55],[-0.95,-1.55]].forEach(function(p){
    var w=makeDonkWheel(rimStyle, R); w.position.set(p[0],R,p[1]); g.add(w);
    (g.userData.wheels=g.userData.wheels||[]).push(w);
    if (w.userData.spinnerParts) (g.userData.spinners=g.userData.spinners||[]).push(
      {parts:w.userData.spinnerParts, vel:1+Math.random()*2});
  });
  return g;
}

var TRAILER_COLORS=[0xb8bcc2,0x9aa2ab,0xc2c6cb,0x8a949e,0xd8d8d8,0x7a8a99];
// semiMesh() — stylized 18-wheeler: cab (random fleet color) + sleeper +
// 11.5u trailer (random light color), exhaust stacks, 10 wheels on
// g.userData.wheels. No paint arg — the fleet color is randomized. Used by
// semi_system.js for the delivery sim (verify LHD: driver wheel at +X).
function semiMesh(){
  var g=new THREE.Group();
  var chrome=null, glass=null, dark=null, tireM=null;
  try{ chrome=chromeTrimMat(); glass=glassMat(); }catch(e){}
  if (!chrome) chrome=vehMat(0xd8d8d8);
  if (!glass)  glass=vehMat(0x1c2733);
  dark=vehMat(0x2a2d33);
  tireM=vehMat(0x181818);
  var cabC=[0xa33327,0x2e5aa3,0x2e7a4c,0xd8a13c,0x5a4fa3,0xb8b8b8];
  var cabM=vehMat(cabC[(Math.random()*cabC.length)|0]);
  var trM=vehMat(TRAILER_COLORS[(Math.random()*TRAILER_COLORS.length)|0]);
  // v1.49: static boxes merged per material (16 meshes -> 6 merged).
  // Wheels spin — stay separate single meshes.
  var B=_vbatch();
  B.add(_vbg(2.5,1.6,2.2),'cab', 0,1.5,7.6);            // cab
  B.add(_vbg(2.4,1.1,2.0),'glass', 0,2.75,7.7);        // glass upper
  B.add(_vbg(2.5,0.35,2.2),'cab', 0,3.45,7.6);         // cab roof
  B.add(_vbg(2.5,0.5,0.3),'chrome', 0,1.1,8.75);      // bumper
  B.add(_vbg(2.2,0.5,0.15),'dark', 0,2.2,8.72);        // grille area
  B.add(_vbg(2.5,2.2,1.6),'cab', 0,1.8,5.9);           // sleeper
  B.add(_vbg(0.18,2.6,0.18),'chrome', 1.15,2.6,6.6);   // exhaust stacks
  B.add(_vbg(0.18,2.6,0.18),'chrome', -1.15,2.6,6.6);
  B.add(_vtg(0.28,0.06,6,12),'dark', 0.62,2.5,7.9, -0.5,0,0); // steering wheel
  B.add(_vbg(0.55,0.7,0.55),'dark', 0.62,2.1,7.0);     // column/dash
  B.add(_vbg(2.0,0.3,1.2),'dark', 0,1.35,4.6);         // chassis
  B.add(_vbg(2.6,2.8,11.5),'trailer', 0,2.5,-1.5);     // trailer
  B.add(_vbg(2.62,0.5,11.5),'chrome', 0,1.15,-1.5);    // trailer skirt
  B.add(_vbg(2.62,2.82,0.2),'dark', 0,2.5,-7.3);       // trailer rear
  B.add(_vbg(0.25,1.2,0.25),'dark', 0.9,0.6,2.6);      // landing gear
  B.add(_vbg(0.25,1.2,0.25),'dark', -0.9,0.6,2.6);
  var hlM=_semiHeadMat();
  B.add(_vbg(0.4,0.3,0.1),'head', 0.8,1.35,8.78);      // headlights
  B.add(_vbg(0.4,0.3,0.1),'head', -0.8,1.35,8.78);
  B.flush(g,'semi',{cab:cabM, glass:glass, chrome:chrome, dark:dark,
    trailer:trM, head:hlM});
  var wheels=[];
  function wheel(x,y,z,r){
    // v1.46: geometry is shared fleet-wide — rotate the mesh, never the geometry.
    var w=new THREE.Mesh(_vcg(r,r,0.35,10),tireM);
    w.rotation.z=Math.PI/2;
    w.position.set(x,y,z); g.add(w); wheels.push(w);
  }
  wheel(1.15,0.55,7.9,0.55); wheel(-1.15,0.55,7.9,0.55);
  wheel(1.15,0.55,5.2,0.55); wheel(-1.15,0.55,5.2,0.55);
  wheel(1.15,0.55,4.2,0.55); wheel(-1.15,0.55,4.2,0.55);
  wheel(1.15,0.55,-4.5,0.5); wheel(-1.15,0.55,-4.5,0.5);
  wheel(1.15,0.55,-5.8,0.5); wheel(-1.15,0.55,-5.8,0.5);
  g.userData.wheels=wheels;
  return g;
}

var _vehMats={};
// vehMat(color) — cached Lambert materials (one per color), shared by the
// builders and by marta_bus_system.js's instanced stop signs.
function vehMat(color){
  // v1.46: this is THE single construction site for vehMat — must NOT call
  // vehMat() itself (infinite recursion). Raw construction is intentional here.
  /* v1.48 (#18, Aria Nakamura): vehicle paint uses MeshPhongMaterial via the
     shared palette — specular sheen on bodywork (toon_mats.js). Falls back
     to Lambert if the palette hasn't loaded. */
  if (!_vehMats[color]) _vehMats[color]=((typeof vehPaintMat==='function')?vehPaintMat(color):new THREE.MeshLambertMaterial({color:color}));
  return _vehMats[color];
}
function groundY(x,z){
  try{ return heightAt(x,z); }catch(e){ return 0; }
}

/* martaBusMesh() — stylized MARTA city bus (12u long): white body, blue
   stripe + green accent stripe (MARTA livery), window band, windshield,
   canvas-texture "MARTA" destination sign, side mirrors.
   g.userData.len = body length. Used by marta_bus_system.js for all 40
   route buses. */
function martaBusMesh(){
  // v1.49: static body merged per material (11 meshes -> 7 merged).
  // Wheels spin — stay separate.
  var g=new THREE.Group();
  var white=vehMat(0xe8eaec), blue=vehMat(0x1a5fb4), green=vehMat(0x2a9d4b),
      dark=vehMat(0x22262b),
      glassM=vehMat(0x1c2733);
  var L=12, W=2.8, H=2.6;
  var B=_vbatch();
  B.add(_vbg(W,H,L),'white', 0,1.9,0);                    // body
  B.add(_vbg(W+0.06,0.4,L+0.06),'blue', 0,2.3,0);         // blue stripe
  B.add(_vbg(W+0.06,0.18,L+0.06),'green', 0,1.5,0);      // green accent
  B.add(_vbg(W+0.06,0.8,L-2),'glass', 0,2.75,0);          // window band
  B.add(_vbg(W-0.4,1.0,0.1),'glass', 0,2.6,L/2+0.02);    // windshield
  B.add(_vbg(W-0.2,0.2,L-0.3),'roof', 0,3.3,0);          // roof
  try{ B.add(_vpg(1.8,0.35),'dest', 0,3.0,L/2+0.06); }catch(e){} // dest sign
  [-1,1].forEach(function(s){
    B.add(_vbg(0.15,0.4,0.25),'dark', s*(W/2+0.15),2.9,L/2-0.3); // mirrors
  });
  B.flush(g,'martaBus',{white:white, blue:blue, green:green, glass:glassM,
    roof:vehMat(0xb9bec5), dest:_martaDestMatGet(), dark:dark});
  // wheels
  [[-W/2+0.3,3.5],[W/2-0.3,3.5],[-W/2+0.3,-3.5],[W/2-0.3,-3.5]].forEach(function(p){
    var wheel=new THREE.Mesh(_vcg(0.55,0.55,0.4,10), dark);
    wheel.rotation.z=Math.PI/2;
    wheel.position.set(p[0],0.55,p[1]); g.add(wheel);
  });
  g.userData.len=L;
  return g;
}

function vehLam(c){ return vehMat(c); }
// schoolBusMesh() — stylized school bus: yellow body, black rub stripe,
// window band, hood, fold-out stop sign (left side), roof warning lights,
// 6 wheels on g.userData.wheels.
function schoolBusMesh(){
  // v1.49: static body merged per material (wheel hubs merge into the
  // 'chrome' slot — they don't spin). Stop sign swings out, warning
  // lights flash, tires spin — all stay separate.
  var g=new THREE.Group();
  var yellow=vehLam(0xe8a913), black=vehLam(0x1a1a1a), glass=vehLam(0x1c2733),
      chrome=vehLam(0xd8d8d8), tireM=vehLam(0x222222);
  var B=_vbatch();
  B.add(_vbg(2.6,1.9,9.6),'yellow', 0,1.85,0);        // body
  B.add(_vbg(2.62,0.28,9.62),'black', 0,1.05,0);     // rub stripe
  B.add(_vbg(2.62,0.5,9.0),'glass', 0,2.35,0);       // window band
  B.add(_vbg(2.4,1.0,0.15),'glass', 0,2.2,4.85);     // windshield
  B.add(_vbg(2.6,0.9,1.6),'yellow', 0,1.35,5.4);     // hood
  B.add(_vbg(2.62,0.18,9.62),'black', 0,2.86,0);     // roof edge
  // wheel hubs are static (don't spin) — merge them now, tires below
  var _hubSpots=[[-1.25,3.4],[1.25,3.4],[-1.25,-2.6],[1.25,-2.6],
                 [-1.25,-3.6],[1.25,-3.6]];
  _hubSpots.forEach(function(p){
    B.add(_vcg(0.2,0.2,0.42,8),'chrome', p[0],0.5,p[1], 0,0,Math.PI/2);
  });
  B.flush(g,'schoolBus',{yellow:yellow, black:black, glass:glass,
    chrome:chrome});
  // stop sign (driver's/left side) — v1.17: animated. Retracted flush
  // against the body (x=1.32); schoolbus_system.js eases userData.signT
  // 0->1 to swing it out to x=2.12 when children board, then retracts.
  // Joshua's rule: the sign lives on the LEFT (driver's) side.
  var sign=new THREE.Mesh(_vcg(0.45,0.45,0.06,8),vehLam(0xc23b2e));
  sign.rotation.z=Math.PI/2; sign.position.set(1.32,2.0,3.2); g.add(sign);
  // wheels (tires spin — stay separate; hubs already merged above)
  function wheel(x,z){ var w=new THREE.Mesh(_vcg(0.5,0.5,0.4,12),tireM);
    w.rotation.z=Math.PI/2; w.position.set(x,0.5,z); g.add(w); return w; }
  var wheels=[wheel(-1.25,3.4),wheel(1.25,3.4),wheel(-1.25,-2.6),wheel(1.25,-2.6),
              wheel(-1.25,-3.6),wheel(1.25,-3.6)];
  // roof warning lights — v1.17: refs stored so schoolbus_system.js can
  // flash them red while the stop sign is out (real school bus behavior).
  // They flash — stay separate meshes.
  function warnBox(x){ var m=new THREE.Mesh(_vbg(0.3,0.15,0.15),vehLam(0xff3300));
    m.position.set(x,2.95,4.7); g.add(m); return m; }
  var warnL=warnBox(-0.5);
  var warnR=warnBox(0.5);
  g.userData.wheels=wheels;
  g.userData.stopSign=sign;        // animated stop-sign mesh
  g.userData.signT=0;              // 0=retracted, 1=fully out
  g.userData.warnLights=[warnL,warnR];
  return g;
}

/* ---------------- helpers ---------------- */
// policeCruiserMesh() — "Surviving Adamsville" APD-STYLE PATROL CRUISER
// (added 2026-10-10 for the police staffing expansion — Joshua's directive:
// the force must clear 2-3 simultaneous traffic jams in parallel, so the
// game fields 8 on-duty cruisers: 4 patrol beats + 3 traffic-assist
// responders + 1 supervisor).
//   Stylized sedan-scale cruiser (~1.45m roofline, true scale like
// sedanMesh): white body, dark-blue door band (APD-style markings), black
// push bar on the nose, roof light bar with SEPARATE red/blue beacons so
// police_system.js can alternate-flash them, plus a steady white "takedown"
// light used while directing traffic at a jam scene.
//   Conventions (match this file): THREE.Group, BoxGeometry +
// MeshLambertMaterial, LEFT-hand drive (no interior needed — cruisers are
// never drivable), userData carries body + light refs. Callers add to scene.
/* eslint-disable no-unused-vars */
function policeCruiserMesh(){
  // v1.49: static body merged per material (11 meshes -> 4 merged).
  // Red/blue beacons + takedown light flash via .visible — stay separate.
  var g=new THREE.Group();
  var white=0xf2f4f6, blue=0x1a3a8f, glassC=0x1c2733, trimC=0x14161a;
  var B=_vbatch();
  B.add(_vbg(2.0,0.62,4.6),'white', 0,0.55,0);              // lower body
  [-1,1].forEach(function(s){
    B.add(_vbg(0.06,0.34,2.6),'blue', s*1.0,0.62,-0.1);    // door bands
  });
  B.add(_vbg(1.75,0.5,2.4),'glass', 0,1.12,-0.2);          // glasshouse
  B.add(_vbg(1.9,0.14,1.1),'white', 0,0.92,1.7);           // hood
  [-0.55,0.55].forEach(function(x){
    B.add(_vbg(0.12,0.5,0.12),'trim', x,0.55,2.36);        // push-bar posts
  });
  B.add(_vbg(1.3,0.12,0.12),'trim', 0,0.72,2.36);          // push-bar crossbar
  B.add(_vbg(1.5,0.1,0.3),'trim', 0,1.42,0.1);             // light-bar base
  var refs=B.flush(g,'policeCruiser',{white:vehMat(white), blue:vehMat(blue),
    glass:vehMat(glassC), trim:vehMat(trimC)});
  g.userData.body=refs.white;
  var redB=new THREE.Mesh(_vbg(0.55,0.22,0.26),
    vehMat(0xff2222));
  redB.position.set(-0.42,1.58,0.1); g.add(redB);
  var blueB=new THREE.Mesh(_vbg(0.55,0.22,0.26),
    vehMat(0x2244ff));
  blueB.position.set(0.42,1.58,0.1); g.add(blueB);
  // takedown light (steady white, on while directing traffic at a scene)
  var take=new THREE.Mesh(_vbg(1.1,0.1,0.12),
    vehMat(0xffffff));
  take.position.set(0,1.5,0.32); take.visible=false; g.add(take);
  // wheels
  var wg=_vcg(0.34,0.34,0.3,10);
  var wm=vehMat(0x181818);
  [[0.95,1.5],[-0.95,1.5],[0.95,-1.5],[-0.95,-1.5]].forEach(function(p){
    var w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2;
    w.position.set(p[0],0.34,p[1]); g.add(w);
  });
  // refs for police_system.js
  g.userData.redBeacon=redB;    // flash while responding / directing
  g.userData.blueBeacon=blueB;  // alternate with redBeacon
  g.userData.takedown=take;     // steady-on while directing at a scene
  g.userData.lightBar={ visible:true };  // compat flag (some systems probe it)
  return g;
}
/* eslint-enable no-unused-vars */
