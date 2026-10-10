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
   Builders take no scene argument and return a THREE.Group — callers add it to
   their own scene. Depends only on global THREE.
   Extracted 2026-10-09: sedan/safari/chevys/pickup/suv from index.html,
   semiMesh from semi_system.js, martaBusMesh from marta_bus_system.js,
   schoolBusMesh from refnpc_system.js.
   ========================================================================== */
/* ----------------------------------------------------------------------------
   CANONICAL BUILDERS — conventions: forward = local +Z; left = +X = driver
   side (US left-hand drive); return a THREE.Group; callers add to scene.
   userData carries wheels[]/doors[]/steerWheel/spinners[]/body/cab/hood/len. */
// sedanMesh(color) — TRUE SCALE (~1.42m roofline: below the 1.85m character's
// eyeline). Body + glasshouse + hood + 4 wheels; exposes userData.body/cab/hood
// for the damage system. The game's stylized sedan archetype.
function sedanMesh(color){
  // TRUE SCALE: overall height ~1.42m (roofline below the 1.85m character's eyeline)
  var g=new THREE.Group();
  var body=new THREE.Mesh(new THREE.BoxGeometry(2.0,0.62,4.6),
    new THREE.MeshLambertMaterial({ color:color }));
  body.position.y=0.55; g.add(body); g.userData.body=body;
  var cab=new THREE.Mesh(new THREE.BoxGeometry(1.75,0.5,2.4),
    new THREE.MeshLambertMaterial({ color:0x1c2733 }));
  cab.position.set(0,1.12,-0.2); g.add(cab); g.userData.cab=cab;
  var hood=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.14,1.1),
    new THREE.MeshLambertMaterial({ color:color }));
  hood.position.set(0,0.92,1.7); g.add(hood); g.userData.hood=hood;
  var wg=new THREE.CylinderGeometry(0.34,0.34,0.3,10);
  var wm=new THREE.MeshLambertMaterial({ color:0x181818 });
  [[0.95,1.5],[-0.95,1.5],[0.95,-1.5],[-0.95,-1.5]].forEach(function(p){
    var w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2;
    w.position.set(p[0],0.34,p[1]); g.add(w);
  });
  return g;
}
// addCockpit(carGroup, h) — dashboard + column + working steering wheel for
// drivable cars (driver's-seat view). h = height offset for taller vehicles
// (Safari van). Returns the steering wheel mesh.
function addCockpit(carGroup, h){
  h=h||0;
  var dash=new THREE.Mesh(new THREE.BoxGeometry(1.7,0.28,0.45),
    new THREE.MeshLambertMaterial({ color:0x2a2a30 }));
  dash.position.set(0,0.98+h,0.95); carGroup.add(dash);
  var col=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,0.5,8),
    new THREE.MeshLambertMaterial({ color:0x222222 }));
  col.position.set(0.5,0.9+h,0.75); col.rotation.x=0.5; carGroup.add(col);
  var wheel=new THREE.Mesh(new THREE.TorusGeometry(0.26,0.05,8,18),
    new THREE.MeshLambertMaterial({ color:0x1a1a1a }));
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
  var g=new THREE.Group();
  var bronze=0x8a5a1e, cream=0xe6d3a3, trimC=0x1c1c1e, glassC=0x1c2733;
  // lower body (bronze)
  var lower=new THREE.Mesh(new THREE.BoxGeometry(2.0,0.95,4.8),
    new THREE.MeshLambertMaterial({ color:bronze }));
  lower.position.y=0.85; g.add(lower); g.userData.body=lower;
  // upper body (cream)
  var upper=new THREE.Mesh(new THREE.BoxGeometry(1.96,0.72,4.5),
    new THREE.MeshLambertMaterial({ color:cream }));
  upper.position.set(0,1.68,-0.1); g.add(upper);
  // dark dividing stripe
  var stripe=new THREE.Mesh(new THREE.BoxGeometry(2.02,0.1,4.82),
    new THREE.MeshLambertMaterial({ color:trimC }));
  stripe.position.y=1.32; g.add(stripe);
  // glasshouse (hidden in driver's-seat view)
  var cab=new THREE.Group();
  var shield=new THREE.Mesh(new THREE.BoxGeometry(1.7,0.6,0.08),
    new THREE.MeshLambertMaterial({ color:glassC }));
  shield.position.set(0,1.92,2.02); shield.rotation.x=-0.24; cab.add(shield);
  [-1,1].forEach(function(s){
    var win=new THREE.Mesh(new THREE.BoxGeometry(0.06,0.52,3.3),
      new THREE.MeshLambertMaterial({ color:glassC }));
    win.position.set(s*0.99,1.92,-0.2); cab.add(win);
  });
  var rear=new THREE.Mesh(new THREE.BoxGeometry(1.7,0.52,0.08),
    new THREE.MeshLambertMaterial({ color:glassC }));
  rear.position.set(0,1.92,-2.32); cab.add(rear);
  var roof=new THREE.Mesh(new THREE.BoxGeometry(1.96,0.1,4.5),
    new THREE.MeshLambertMaterial({ color:cream }));
  roof.position.set(0,2.3,-0.1); cab.add(roof);
  g.add(cab); g.userData.cab=cab;
  // hood / front clip (pops on damage)
  var hood=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.5,0.9),
    new THREE.MeshLambertMaterial({ color:bronze }));
  hood.position.set(0,1.02,2.35); g.add(hood); g.userData.hood=hood;
  // grille + headlights + taillights
  var grille=new THREE.Mesh(new THREE.BoxGeometry(1.2,0.34,0.1),
    new THREE.MeshLambertMaterial({ color:trimC }));
  grille.position.set(0,0.92,2.82); g.add(grille);
  [-1,1].forEach(function(s){
    var hl=new THREE.Mesh(new THREE.BoxGeometry(0.34,0.24,0.08),
      new THREE.MeshLambertMaterial({ color:0xf5f0d8, emissive:0x555544 }));
    hl.position.set(s*0.78,0.95,2.82); g.add(hl);
    var tl=new THREE.Mesh(new THREE.BoxGeometry(0.24,0.4,0.08),
      new THREE.MeshLambertMaterial({ color:0xa02020, emissive:0x330000 }));
    tl.position.set(s*0.85,1.08,-2.42); g.add(tl);
  });
  // bumpers
  [2.82,-2.42].forEach(function(zz){
    var b=new THREE.Mesh(new THREE.BoxGeometry(2.05,0.28,0.25),
      new THREE.MeshLambertMaterial({ color:trimC }));
    b.position.set(0,0.52,zz); g.add(b);
  });
  // gold-style wheels
  var wg=new THREE.CylinderGeometry(0.38,0.38,0.32,10);
  var wm=new THREE.MeshLambertMaterial({ color:0x8a6a2a });
  [[0.95,1.55],[-0.95,1.55],[0.95,-1.55],[-0.95,-1.55]].forEach(function(p){
    var w=new THREE.Mesh(wg,wm); w.rotation.z=Math.PI/2;
    w.position.set(p[0],0.38,p[1]); g.add(w);
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
function _chromeMat(){ return new THREE.MeshLambertMaterial({color:0xdcdce4}); }
function _darkTireMat(){ return new THREE.MeshLambertMaterial({color:0x141414}); }
function _addSpokes(face, n, len, w, mat, xOff){
  for(var i=0;i<n;i++){
    var piv=new THREE.Group();
    var s=new THREE.Mesh(new THREE.BoxGeometry(xOff, w, len), mat);
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
  var g=new THREE.Group();
  var W=R*0.62, chrome=_chromeMat(), darkT=_darkTireMat(),
      black=new THREE.MeshLambertMaterial({color:0x1c1c20});
  var tire=new THREE.Mesh(new THREE.CylinderGeometry(R,R,W,14), darkT);
  tire.rotation.z=Math.PI/2; g.add(tire);
  var barrel=new THREE.Mesh(new THREE.CylinderGeometry(R*0.70,R*0.70,W*1.02,14), chrome);
  barrel.rotation.z=Math.PI/2; g.add(barrel);
  var face=new THREE.Group(); g.add(face);
  var rr=R*0.68;
  if (style==='spokes'){ _addSpokes(face, 5, rr*1.7, rr*0.22, chrome, W*1.06); }
  else if (style==='chrome5'){ _addSpokes(face, 5, rr*1.7, rr*0.42, chrome, W*1.06); }
  else if (style==='mesh'){ _addSpokes(face, 12, rr*1.7, rr*0.10, chrome, W*1.06); }
  else if (style==='deepdish'){
    var lip=new THREE.Mesh(new THREE.TorusGeometry(rr*0.95, rr*0.12, 8, 20), chrome);
    lip.rotation.y=Math.PI/2; lip.position.x=W*0.5; face.add(lip);
    var lip2=lip.clone(); lip2.position.x=-W*0.5; face.add(lip2);
    _addSpokes(face, 5, rr*1.5, rr*0.24, chrome, W*0.9);
  }
  else if (style==='blade'){
    // 5 split-spoke blades: black spokes with polished edges
    for(var b=0;b<5;b++){
      var piv=new THREE.Group();
      [-0.22,0.22].forEach(function(off){
        var s=new THREE.Mesh(new THREE.BoxGeometry(W*1.06, rr*0.16, rr*1.6), black);
        s.position.z=rr*0.5; s.rotation.x=off; piv.add(s);
        var e=new THREE.Mesh(new THREE.BoxGeometry(W*1.08, rr*0.05, rr*1.6), chrome);
        e.position.z=rr*0.5; e.position.y=rr*0.10; e.rotation.x=off; piv.add(e);
      });
      piv.rotation.x=b/5*Math.PI*2; face.add(piv);
    }
    var lipB=new THREE.Mesh(new THREE.TorusGeometry(rr*0.98, rr*0.07, 8, 20), chrome);
    lipB.rotation.y=Math.PI/2; face.add(lipB);
  }
  else if (style==='spinner'){
    // wire-spoke base + 3-blade spinner cap (spins independently)
    _addSpokes(face, 18, rr*1.7, rr*0.055, chrome, W*1.04);
    var spinG=new THREE.Group();
    var hub=new THREE.Mesh(new THREE.CylinderGeometry(rr*0.22,rr*0.28,W*0.5,10), chrome);
    hub.rotation.z=Math.PI/2; spinG.add(hub);
    for(var k=0;k<3;k++){
      var piv=new THREE.Group();
      var bl=new THREE.Mesh(new THREE.BoxGeometry(W*0.9, rr*0.20, rr*1.1), chrome);
      bl.position.z=rr*0.55; piv.add(bl);
      var tip=new THREE.Mesh(new THREE.ConeGeometry(rr*0.14, rr*0.5, 6), chrome);
      tip.rotation.x=Math.PI/2; tip.position.z=rr*1.15; piv.add(tip);
      piv.rotation.x=k/3*Math.PI*2;
      spinG.add(piv);
    }
    spinG.position.x=W*0.55;
    var spinG2=spinG.clone(); spinG2.position.x=-W*0.55; spinG2.rotation.y=Math.PI;
    g.add(spinG); g.add(spinG2);
    g.userData.spinnerParts=[spinG, spinG2];
  }
  // center cap
  var cap=new THREE.Mesh(new THREE.CylinderGeometry(rr*0.16,rr*0.16,W*1.1,8), chrome);
  cap.rotation.z=Math.PI/2; face.add(cap);
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
  var panel=new THREE.Mesh(new THREE.BoxGeometry(0.09, doorH, doorLen), bodyMat);
  panel.position.set(0, 0, -doorLen/2+0.06); piv.add(panel);
  var glassM=new THREE.MeshLambertMaterial({color:0x8fb4cc, transparent:true, opacity:0.45});
  var win=new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.42, doorLen*0.78), glassM);
  win.position.set(0, doorH/2+0.21, -doorLen/2+0.06); piv.add(win);
  var handle=new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.22),
    new THREE.MeshLambertMaterial({color:0xd8d8dc}));
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
  var dark=new THREE.MeshLambertMaterial({color:0x232326});
  var seatM=new THREE.MeshLambertMaterial({color:o.seatColor||0x3a3a40});
  var glassM=new THREE.MeshLambertMaterial({color:0x8fb4cc, transparent:true, opacity:0.45});
  var fl=new THREE.Mesh(new THREE.BoxGeometry(o.width*0.92,0.08,2.7),dark);
  fl.position.set(0,o.floorY,0.05); g.add(fl);
  [-0.52,0.52].forEach(function(sx){
    var st=new THREE.Mesh(new THREE.BoxGeometry(0.58,0.5,0.58),seatM);
    st.position.set(sx,o.floorY+0.32,o.seatZ); g.add(st);
    var bk=new THREE.Mesh(new THREE.BoxGeometry(0.58,0.62,0.18),seatM);
    bk.position.set(sx,o.floorY+0.62,o.seatZ-0.34); g.add(bk);
  });
  var bn=new THREE.Mesh(new THREE.BoxGeometry(1.55,0.45,0.62),seatM);
  bn.position.set(0,o.floorY+0.28,o.seatZ-1.15); g.add(bn);
  var dash=new THREE.Mesh(new THREE.BoxGeometry(o.width*0.88,0.3,0.5),dark);
  dash.position.set(0,o.floorY+0.78,o.dashZ); g.add(dash);
  // steering wheel — LEFT HAND DRIVE (+X), per VAN_SPEC.md
  var col=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,0.5,8),dark);
  col.position.set(0.52,o.floorY+0.70,o.dashZ-0.28); col.rotation.x=0.5; g.add(col);
  var wheel=new THREE.Mesh(new THREE.TorusGeometry(0.24,0.045,8,18),
    new THREE.MeshLambertMaterial({color:0x1a1a1a}));
  wheel.position.set(0.52,o.floorY+0.82,o.dashZ-0.36); wheel.rotation.x=-0.5; g.add(wheel);
  g.userData.steerWheel=wheel;
  return wheel;
}
function glassMat(){ return new THREE.MeshLambertMaterial({color:0x8fb4cc, transparent:true, opacity:0.45}); }
function chromeTrimMat(){ return new THREE.MeshLambertMaterial({color:0xd8d8dc}); }
function paintStripe(g, y, z0, z1, width, color){
  var s=new THREE.Mesh(new THREE.BoxGeometry(width,0.03,z1-z0),
    new THREE.MeshLambertMaterial({color:color}));
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
  var g=new THREE.Group();
  var bodyM=new THREE.MeshLambertMaterial({color:paint.body});
  var roofM=new THREE.MeshLambertMaterial({color:paint.roof||paint.body});
  var chrome=chromeTrimMat(), glass=glassMat(), dark=new THREE.MeshLambertMaterial({color:0x1c1c1e});
  var W=2.0, L=5.3, lift=0.42;   // donk lift
  // lower body
  var lower=new THREE.Mesh(new THREE.BoxGeometry(W,0.72,L), bodyM);
  lower.position.y=0.72+lift; g.add(lower); g.userData.body=lower;
  // upright greenhouse (formal, near-vertical glass)
  var cab=new THREE.Mesh(new THREE.BoxGeometry(1.78,0.62,2.9), glass);
  cab.position.set(0,1.42+lift,-0.25); g.add(cab); g.userData.cab=cab;
  // roof (two-tone capable)
  var roof=new THREE.Mesh(new THREE.BoxGeometry(1.84,0.1,3.0), roofM);
  roof.position.set(0,1.78+lift,-0.25); g.add(roof);
  // pillars (body color, chunky 80s)
  [[0.92,1.05],[-0.92,1.05],[0.92,-1.55],[-0.92,-1.55]].forEach(function(p){
    var pil=new THREE.Mesh(new THREE.BoxGeometry(0.09,0.66,0.14), bodyM);
    pil.position.set(p[0],1.42+lift,p[1]); g.add(pil);
  });
  // long flat hood
  var hood=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.14,1.5), bodyM);
  hood.position.set(0,1.12+lift,1.85); g.add(hood); g.userData.hood=hood;
  // upright trunk
  var trunk=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.5,1.15), bodyM);
  trunk.position.set(0,1.28+lift,-2.05); g.add(trunk);
  // vertical chrome grille + quad headlights (signature box-Chevy face)
  var grille=new THREE.Mesh(new THREE.BoxGeometry(1.5,0.42,0.1), chrome);
  grille.position.set(0,0.95+lift,2.68); g.add(grille);
  [-0.55,-0.19,0.19,0.55].forEach(function(hx){
    var hl=new THREE.Mesh(new THREE.BoxGeometry(0.3,0.24,0.08),
      new THREE.MeshLambertMaterial({color:0xf5f0d8, emissive:0x444433}));
    hl.position.set(hx,0.95+lift,2.70); g.add(hl);
  });
  // chrome bumpers
  [2.72,-2.66].forEach(function(zz){
    var b=new THREE.Mesh(new THREE.BoxGeometry(2.06,0.26,0.22), chrome);
    b.position.set(0,0.62+lift,zz); g.add(b);
  });
  // taillights (full-width 80s bar)
  var tl=new THREE.Mesh(new THREE.BoxGeometry(1.6,0.22,0.08),
    new THREE.MeshLambertMaterial({color:0xa02020, emissive:0x330000}));
  tl.position.set(0,1.15+lift,-2.64); g.add(tl);
  // racing stripes
  if (paint.stripe) paintStripe(g, 1.20+lift, -2.6, 2.6, 0.5, paint.stripe);
  // interior + doors
  addCarInterior(g, {width:W, floorY:0.55+lift, seatZ:0.15, dashZ:1.15, seatColor:0x4a3a30});
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
  var g=new THREE.Group();
  var bodyM=new THREE.MeshLambertMaterial({color:paint.body});
  var roofM=new THREE.MeshLambertMaterial({color:paint.roof||paint.body});
  var chrome=chromeTrimMat(), glass=glassMat(), dark=new THREE.MeshLambertMaterial({color:0x1c1c1e});
  var W=2.0, L=5.4, lift=0.42;
  // sleek lower body
  var lower=new THREE.Mesh(new THREE.BoxGeometry(W,0.66,L), bodyM);
  lower.position.y=0.68+lift; g.add(lower); g.userData.body=lower;
  // flowing greenhouse: curved rear glass (rotated) + sloped windshield
  var cab=new THREE.Mesh(new THREE.BoxGeometry(1.76,0.55,2.7), glass);
  cab.position.set(0,1.32+lift,-0.35); g.add(cab); g.userData.cab=cab;
  var rearGlass=new THREE.Mesh(new THREE.BoxGeometry(1.7,0.5,0.9), glass);
  rearGlass.position.set(0,1.22+lift,-1.85); rearGlass.rotation.x=0.5; g.add(rearGlass);
  var shield=new THREE.Mesh(new THREE.BoxGeometry(1.7,0.5,0.1), glass);
  shield.position.set(0,1.30+lift,1.15); shield.rotation.x=-0.42; g.add(shield);
  // rounded roof
  var roof=new THREE.Mesh(new THREE.BoxGeometry(1.82,0.1,2.5), roofM);
  roof.position.set(0,1.64+lift,-0.35); g.add(roof);
  // sloped aero nose
  var nose=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.4,1.2), bodyM);
  nose.position.set(0,0.95+lift,2.15); nose.rotation.x=0.18; g.add(nose); g.userData.hood=nose;
  // rounded trunk (short, tapered)
  var trunk=new THREE.Mesh(new THREE.BoxGeometry(1.85,0.42,0.9), bodyM);
  trunk.position.set(0,1.05+lift,-2.3); trunk.rotation.x=-0.12; g.add(trunk);
  // flush rounded headlights + slim grille
  [-0.62,0.62].forEach(function(hx){
    var hl=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.2,0.1),
      new THREE.MeshLambertMaterial({color:0xf5f0d8, emissive:0x444433}));
    hl.position.set(hx,0.98+lift,2.72); hl.rotation.x=0.18; g.add(hl);
  });
  var grille=new THREE.Mesh(new THREE.BoxGeometry(0.9,0.18,0.08), dark);
  grille.position.set(0,0.82+lift,2.70); g.add(grille);
  // body-color bumpers (90s aero)
  [2.72,-2.72].forEach(function(zz){
    var b=new THREE.Mesh(new THREE.BoxGeometry(2.02,0.3,0.24), bodyM);
    b.position.set(0,0.60+lift,zz); g.add(b);
  });
  var tl=new THREE.Mesh(new THREE.BoxGeometry(1.5,0.2,0.08),
    new THREE.MeshLambertMaterial({color:0xa02020, emissive:0x330000}));
  tl.position.set(0,1.02+lift,-2.74); g.add(tl);
  if (paint.stripe) paintStripe(g, 1.06+lift, -2.7, 2.7, 0.5, paint.stripe);
  addCarInterior(g, {width:W, floorY:0.52+lift, seatZ:0.05, dashZ:1.05, seatColor:0x2a2a32});
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
  var g=new THREE.Group();
  var bodyM=new THREE.MeshLambertMaterial({color:paint.body});
  var roofM=new THREE.MeshLambertMaterial({color:paint.roof||paint.body});
  var glass=glassMat(), dark=new THREE.MeshLambertMaterial({color:0x1c1c1e});
  var W=2.0, lift=0.15;
  // chassis + cab lower
  var lower=new THREE.Mesh(new THREE.BoxGeometry(W,0.7,2.2), bodyM);
  lower.position.set(0,0.75+lift,1.35); g.add(lower); g.userData.body=lower;
  // cab greenhouse
  var cab=new THREE.Mesh(new THREE.BoxGeometry(1.8,0.62,1.5), glass);
  cab.position.set(0,1.42+lift,1.15); g.add(cab); g.userData.cab=cab;
  var roof=new THREE.Mesh(new THREE.BoxGeometry(1.86,0.1,1.6), roofM);
  roof.position.set(0,1.78+lift,1.15); g.add(roof);
  // hood
  var hood=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.16,1.0), bodyM);
  hood.position.set(0,1.14+lift,2.6); g.add(hood); g.userData.hood=hood;
  // grille + square headlights
  var grille=new THREE.Mesh(new THREE.BoxGeometry(1.4,0.35,0.1), dark);
  grille.position.set(0,0.95+lift,3.12); g.add(grille);
  [-0.7,0.7].forEach(function(hx){
    var hl=new THREE.Mesh(new THREE.BoxGeometry(0.36,0.26,0.08),
      new THREE.MeshLambertMaterial({color:0xf5f0d8, emissive:0x444433}));
    hl.position.set(hx,0.98+lift,3.12); g.add(hl);
  });
  var bumper=new THREE.Mesh(new THREE.BoxGeometry(2.05,0.24,0.2), chromeTrimMat());
  bumper.position.set(0,0.6+lift,3.14); g.add(bumper);
  // OPEN BED with walls
  var bedM=bodyM, bedY=0.78+lift, bedZ0=-2.55, bedZ1=-0.15, bedL=bedZ1-bedZ0;
  var bedFloor=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.1,bedL), dark);
  bedFloor.position.set(0,bedY,(bedZ0+bedZ1)/2); g.add(bedFloor);
  [[0.95,'x'],[-0.95,'x']].forEach(function(s){
    var wall=new THREE.Mesh(new THREE.BoxGeometry(0.08,0.55,bedL), bedM);
    wall.position.set(s[0],bedY+0.32,(bedZ0+bedZ1)/2); g.add(wall);
  });
  var tail=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.55,0.08), bedM);
  tail.position.set(0,bedY+0.32,bedZ0); g.add(tail);
  var cabBack=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.55,0.08), bedM);
  cabBack.position.set(0,bedY+0.32,bedZ1); g.add(cabBack);
  // taillights + rear bumper
  [-0.8,0.8].forEach(function(tx){
    var tl=new THREE.Mesh(new THREE.BoxGeometry(0.2,0.4,0.08),
      new THREE.MeshLambertMaterial({color:0xa02020, emissive:0x330000}));
    tl.position.set(tx,0.95+lift,-2.58); g.add(tl);
  });
  var rb=new THREE.Mesh(new THREE.BoxGeometry(2.05,0.24,0.2), chromeTrimMat());
  rb.position.set(0,0.6+lift,-2.6); g.add(rb);
  if (paint.stripe) paintStripe(g, 1.24+lift, 0.4, 3.1, 0.45, paint.stripe);
  addCarInterior(g, {width:W, floorY:0.55+lift, seatZ:1.0, dashZ:1.95, seatColor:0x3a3f4a});
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
  var g=new THREE.Group();
  var bodyM=new THREE.MeshLambertMaterial({color:paint.body});
  var roofM=new THREE.MeshLambertMaterial({color:paint.roof||paint.body});
  var glass=glassMat(), dark=new THREE.MeshLambertMaterial({color:0x1c1c1e});
  var W=2.0, lift=0.22;
  // tall wagon body
  var lower=new THREE.Mesh(new THREE.BoxGeometry(W,0.85,4.7), bodyM);
  lower.position.y=0.85+lift; g.add(lower); g.userData.body=lower;
  // glasshouse
  var cab=new THREE.Mesh(new THREE.BoxGeometry(1.8,0.68,3.4), glass);
  cab.position.set(0,1.6+lift,-0.3); g.add(cab); g.userData.cab=cab;
  var roof=new THREE.Mesh(new THREE.BoxGeometry(1.86,0.1,3.5), roofM);
  roof.position.set(0,1.99+lift,-0.3); g.add(roof);
  // pillars
  [[0.92,1.25],[-0.92,1.25],[0.92,-1.85],[-0.92,-1.85]].forEach(function(p){
    var pil=new THREE.Mesh(new THREE.BoxGeometry(0.1,0.72,0.16), bodyM);
    pil.position.set(p[0],1.6+lift,p[1]); g.add(pil);
  });
  // hood + grille
  var hood=new THREE.Mesh(new THREE.BoxGeometry(1.9,0.14,1.0), bodyM);
  hood.position.set(0,1.32+lift,2.0); g.add(hood); g.userData.hood=hood;
  var grille=new THREE.Mesh(new THREE.BoxGeometry(1.3,0.32,0.1), dark);
  grille.position.set(0,1.05+lift,2.42); g.add(grille);
  [-0.65,0.65].forEach(function(hx){
    var hl=new THREE.Mesh(new THREE.BoxGeometry(0.34,0.26,0.08),
      new THREE.MeshLambertMaterial({color:0xf5f0d8, emissive:0x444433}));
    hl.position.set(hx,1.08+lift,2.42); g.add(hl);
  });
  // roof rails
  [-0.7,0.7].forEach(function(rx){
    var rail=new THREE.Mesh(new THREE.BoxGeometry(0.08,0.08,3.2), dark);
    rail.position.set(rx,2.08+lift,-0.3); g.add(rail);
  });
  // bumpers + taillights
  [2.44,-2.4].forEach(function(zz){
    var b=new THREE.Mesh(new THREE.BoxGeometry(2.04,0.26,0.2), dark);
    b.position.set(0,0.68+lift,zz); g.add(b);
  });
  [-0.8,0.8].forEach(function(tx){
    var tl=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.5,0.08),
      new THREE.MeshLambertMaterial({color:0xa02020, emissive:0x330000}));
    tl.position.set(tx,1.1+lift,-2.42); g.add(tl);
  });
  if (paint.stripe) paintStripe(g, 1.40+lift, -2.3, 2.5, 0.45, paint.stripe);
  addCarInterior(g, {width:W, floorY:0.62+lift, seatZ:0.6, dashZ:1.6, seatColor:0x424750});
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
  if (!chrome) chrome=new THREE.MeshLambertMaterial({color:0xd8d8d8});
  if (!glass)  glass=new THREE.MeshLambertMaterial({color:0x1c2733});
  dark=new THREE.MeshLambertMaterial({color:0x2a2d33});
  tireM=new THREE.MeshLambertMaterial({color:0x181818});
  var cabC=[0xa33327,0x2e5aa3,0x2e7a4c,0xd8a13c,0x5a4fa3,0xb8b8b8];
  var cabM=new THREE.MeshLambertMaterial({color:cabC[(Math.random()*cabC.length)|0]});
  var trM=new THREE.MeshLambertMaterial({color:TRAILER_COLORS[(Math.random()*TRAILER_COLORS.length)|0]});
  function box(w,h,d,m,x,y,z){
    var ms=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);
    ms.position.set(x,y,z); g.add(ms); return ms;
  }
  box(2.5,1.6,2.2,cabM, 0,1.5,7.6);
  box(2.4,1.1,2.0,glass, 0,2.75,7.7);
  box(2.5,0.35,2.2,cabM, 0,3.45,7.6);
  box(2.5,0.5,0.3,chrome, 0,1.1,8.75);
  box(2.2,0.5,0.15,dark, 0,2.2,8.72);
  box(2.5,2.2,1.6,cabM, 0,1.8,5.9);
  box(0.18,2.6,0.18,chrome, 1.15,2.6,6.6);
  box(0.18,2.6,0.18,chrome, -1.15,2.6,6.6);
  var sw=new THREE.Mesh(new THREE.TorusGeometry(0.28,0.06,6,12), dark);
  sw.position.set(0.62,2.5,7.9); sw.rotation.x=-0.5; g.add(sw);
  box(0.55,0.7,0.55,dark, 0.62,2.1,7.0);
  box(2.0,0.3,1.2,dark, 0,1.35,4.6);
  box(2.6,2.8,11.5,trM, 0,2.5,-1.5);
  box(2.62,0.5,11.5,chrome, 0,1.15,-1.5);
  box(2.62,2.82,0.2,dark, 0,2.5,-7.3);
  box(0.25,1.2,0.25,dark, 0.9,0.6,2.6);
  box(0.25,1.2,0.25,dark, -0.9,0.6,2.6);
  var wheels=[];
  function wheel(x,y,z,r){
    var wgeo=new THREE.CylinderGeometry(r,r,0.35,10);
    wgeo.rotateZ(Math.PI/2);
    var w=new THREE.Mesh(wgeo,tireM);
    w.position.set(x,y,z); g.add(w); wheels.push(w);
  }
  wheel(1.15,0.55,7.9,0.55); wheel(-1.15,0.55,7.9,0.55);
  wheel(1.15,0.55,5.2,0.55); wheel(-1.15,0.55,5.2,0.55);
  wheel(1.15,0.55,4.2,0.55); wheel(-1.15,0.55,4.2,0.55);
  wheel(1.15,0.55,-4.5,0.5); wheel(-1.15,0.55,-4.5,0.5);
  wheel(1.15,0.55,-5.8,0.5); wheel(-1.15,0.55,-5.8,0.5);
  g.userData.wheels=wheels;
  var hlM=new THREE.MeshLambertMaterial({color:0xf5f0d8,emissive:0x333322});
  box(0.4,0.3,0.1,hlM, 0.8,1.35,8.78);
  box(0.4,0.3,0.1,hlM, -0.8,1.35,8.78);
  return g;
}

var _vehMats={};
// vehMat(color) — cached Lambert materials (one per color), shared by the
// builders and by marta_bus_system.js's instanced stop signs.
function vehMat(color){
  if (!_vehMats[color]) _vehMats[color]=new THREE.MeshLambertMaterial({color:color});
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
  var g=new THREE.Group();
  var white=vehMat(0xe8eaec), blue=vehMat(0x1a5fb4), green=vehMat(0x2a9d4b),
      dark=vehMat(0x22262b),
      glassM=new THREE.MeshLambertMaterial({color:0x1c2733});
  var L=12, W=2.8, H=2.6;
  // body
  var body=new THREE.Mesh(new THREE.BoxGeometry(W,H,L), white);
  body.position.set(0,1.9,0); g.add(body);
  // blue stripe
  var stripe=new THREE.Mesh(new THREE.BoxGeometry(W+0.06,0.4,L+0.06), blue);
  stripe.position.set(0,2.3,0); g.add(stripe);
  // green accent stripe (MARTA livery)
  var accent=new THREE.Mesh(new THREE.BoxGeometry(W+0.06,0.18,L+0.06), green);
  accent.position.set(0,1.5,0); g.add(accent);
  // window band
  var win=new THREE.Mesh(new THREE.BoxGeometry(W+0.06,0.8,L-2), glassM);
  win.position.set(0,2.75,0); g.add(win);
  // windshield
  var shield=new THREE.Mesh(new THREE.BoxGeometry(W-0.4,1.0,0.1), glassM);
  shield.position.set(0,2.6,L/2+0.02); g.add(shield);
  // roof
  var roof=new THREE.Mesh(new THREE.BoxGeometry(W-0.2,0.2,L-0.3), vehMat(0xb9bec5));
  roof.position.set(0,3.3,0); g.add(roof);
  // front destination sign
  try{
  var cv=document.createElement('canvas'); cv.width=256; cv.height=48;
  var c=cv.getContext('2d');
  c.fillStyle='#1a1a1a'; c.fillRect(0,0,256,48);
  c.fillStyle='#ffb400'; c.font='bold 28px Arial';
  c.textAlign='center'; c.textBaseline='middle';
  c.fillText('MARTA',128,26);
  var tex=new THREE.CanvasTexture(cv);
  var dest=new THREE.Mesh(new THREE.PlaneGeometry(1.8,0.35),
    new THREE.MeshBasicMaterial({map:tex}));
  dest.position.set(0,3.0,L/2+0.06); g.add(dest);
  }catch(e){}
  // wheels
  [[-W/2+0.3,3.5],[W/2-0.3,3.5],[-W/2+0.3,-3.5],[W/2-0.3,-3.5]].forEach(function(p){
    var wheel=new THREE.Mesh(new THREE.CylinderGeometry(0.55,0.55,0.4,10), dark);
    wheel.rotation.z=Math.PI/2;
    wheel.position.set(p[0],0.55,p[1]); g.add(wheel);
  });
  // side mirrors
  [-1,1].forEach(function(s){
    var mir=new THREE.Mesh(new THREE.BoxGeometry(0.15,0.4,0.25), dark);
    mir.position.set(s*(W/2+0.15),2.9,L/2-0.3); g.add(mir);
  });
  g.userData.len=L;
  return g;
}

function vehLam(c){ return new THREE.MeshLambertMaterial({color:c}); }
// schoolBusMesh() — stylized school bus: yellow body, black rub stripe,
// window band, hood, fold-out stop sign (left side), roof warning lights,
// 6 wheels on g.userData.wheels.
function schoolBusMesh(){
  var g=new THREE.Group();
  var yellow=vehLam(0xe8a913), black=vehLam(0x1a1a1a), glass=vehLam(0x1c2733),
      chrome=vehLam(0xd8d8d8), tireM=vehLam(0x222222);
  function box(w,h,d,mat,x,y,z){ var m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
    m.position.set(x,y,z); g.add(m); return m; }
  box(2.6,1.9,9.6,yellow,0,1.85,0);                 // body
  box(2.62,0.28,9.62,black,0,1.05,0);               // rub stripe
  box(2.62,0.5,9.0,glass,0,2.35,0);                 // window band
  box(2.4,1.0,0.15,glass,0,2.2,4.85);               // windshield
  box(2.6,0.9,1.6,yellow,0,1.35,5.4);               // hood
  box(2.62,0.18,9.62,black,0,2.86,0);               // roof edge
  // stop sign (folded out on the left side)
  var sign=new THREE.Mesh(new THREE.CylinderGeometry(0.45,0.45,0.06,8),vehLam(0xc23b2e));
  sign.rotation.z=Math.PI/2; sign.position.set(1.45,2.0,3.2); g.add(sign); // v1.16: left side per Joshua
  // wheels
  function wheel(x,z){ var w=new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.5,0.4,12),tireM);
    w.rotation.z=Math.PI/2; w.position.set(x,0.5,z); g.add(w);
    var hub=new THREE.Mesh(new THREE.CylinderGeometry(0.2,0.2,0.42,8),chrome);
    hub.rotation.z=Math.PI/2; hub.position.set(x,0.5,z); g.add(hub); return w; }
  var wheels=[wheel(-1.25,3.4),wheel(1.25,3.4),wheel(-1.25,-2.6),wheel(1.25,-2.6),
              wheel(-1.25,-3.6),wheel(1.25,-3.6)];
  // roof warning lights
  box(0.3,0.15,0.15,vehLam(0xff3300),-0.5,2.95,4.7);
  box(0.3,0.15,0.15,vehLam(0xff3300),0.5,2.95,4.7);
  g.userData.wheels=wheels;
  return g;
}

/* ---------------- helpers ---------------- */
