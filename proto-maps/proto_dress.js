/* ============================================================================
   PROTO-DRESS (2026-10-26) — several-maps PROTOTYPE only.
   Dresses ONE block — 535 Dollar Mill Road Southwest and its street
   stretch — to the standard of Joshua's target picture (the polished
   street scene he ruled as the design target on 2026-10-25: porch
   houses, flower beds, fences, sidewalks, full trees, clouds, warm
   light). The live game does NOT have this file; the prototype's other
   maps and streets stay exactly as they were ("near rich / far
   simple" — richness concentrated where the player stands).

   HOW: a purely ADDITIVE scenery layer built once, after the world
   bake, from the game's own runtime data —
     houses:  window.__bldgMeshes.kept  ([x,z,w,d,h,type,yaw], the same
              published list residential_detail.js consumes, so every
              porch lands exactly on the body the game placed)
     roads:   roadDrawData (polylines + widths + names)
     ground:  heightAt(x,z)
   Nothing in the underlying map data is moved or altered. The hero
   house keeps its identity (buildHeroHouse) and gets the fullest
   treatment on top of what it already has (porch slab/roof, driveway,
   walkway, brick mailbox, pine ring).

   TECHNIQUE (the picture, at phone cost):
     - one merged vertex-coloured box mesh carries every porch slab,
       step, rail, post, planter, mailbox body and fence rail
       (1 draw call for all of it)
     - InstancedMesh for the repeated small things: fence pickets,
       flower heads, leaf puffs, shrubs, grass tufts, fallen leaves,
       tree trunks, canopy puffs, pine cones
     - continuous sidewalk ribbons along Dollar Mill via the game's
       own ribbonGeom + SAtex concrete texture
     - soft "baked-feeling" shade: radial-gradient decal planes under
       the new trees and along house bases (the game has no shadow
       mapping for buildings — blob_shadows.js covers vehicles/NPCs
       only — so the dressing grounds its own objects the same cheap
       way)
     - clouds: canvas-painted soft puffs as sprites, warm white,
       drifting slowly; one warm PointLight on the hero porch
   No colliders are added (visual proof pass — noted in the build
   report). Deterministic: a local mulberry32 seed makes the block
   identical on every boot.

   Exposes window.__protoDress = {built, reason, stats{...}} for the
   test rig. Fails soft: any error leaves the prototype untouched.
   ============================================================================ */
(function protoDress(){
'use strict';
var S = window.__protoDress = { built:false, reason:'waiting', stats:null };
try{

/* ---------------- deterministic rng ---------------- */
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0;
  var t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t;
  return ((t^t>>>14)>>>0)/4294967296; }; }
var rand = mulberry32(535535);

/* ---------------- boot gate ----------------
   The bake publishes __bldgMeshes.kept; the hero publishes heroHouse;
   proto_maps publishes __protoState. Wait for all of them (they are
   the same readiness signals the rig already trusts), then build. */
var tries = 0;
var timer = setInterval(function(){
  tries++;
  try{
    if (window.__protoState && __protoState.map && __protoState.map !== 'adamsville'){
      S.reason = 'not-adamsville (' + __protoState.map + ') — dressing is a 535/Adamsville proof';
      clearInterval(timer); return;
    }
    var ready = window.__gameStarted && window.__bldgMeshes && __bldgMeshes.kept &&
      (typeof heroHouse !== 'undefined') && heroHouse && heroHouse.cx &&
      (typeof roadDrawData !== 'undefined') && roadDrawData.length &&
      (typeof scene !== 'undefined') && (typeof heightAt === 'function');
    if (ready){ clearInterval(timer); build(); }
    else if (tries > 480){ S.reason = 'timeout waiting for world'; clearInterval(timer); }
  }catch(e){ if (tries > 480){ S.reason = 'gate-error: ' + (e && e.message || e); clearInterval(timer); } }
}, 500);

/* ---------------- small geometry helpers ----------------
   Merge many transformed boxes into ONE vertex-coloured geometry.
   Works identically on the r186 module engine and the r128 fallback
   (both expose the same BufferGeometry API). */
function BoxBatch(){
  this.pos = []; this.nor = []; this.col = []; this.uv = []; this.count = 0;
}
BoxBatch.prototype.add = function(geo, colorHex, matrix){
  var g = geo.index ? geo.toNonIndexed() : geo;
  g.applyMatrix4(matrix);
  var p = g.attributes.position.array, n = g.attributes.normal.array;
  var u = g.attributes.uv ? g.attributes.uv.array : null;
  var c = new THREE.Color(colorHex);
  for (var i = 0; i < p.length; i += 3){
    this.pos.push(p[i], p[i+1], p[i+2]);
    this.nor.push(n[i], n[i+1], n[i+2]);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(u ? u[(i/3)*2] : 0, u ? u[(i/3)*2+1] : 0);
  }
  this.count += p.length / 3;
  if (g !== geo && g.dispose) g.dispose();
};
BoxBatch.prototype.addBox = function(w, h, d, colorHex, matrix){
  this.add(new THREE.BoxGeometry(w, h, d), colorHex, matrix);
};
BoxBatch.prototype.mesh = function(){
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
  var m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  m.frustumCulled = false;
  return m;
};
/* matrix from a house-local frame: origin (ox,oy,oz), yaw around Y,
   then local offset (lx,ly,lz) and local tilt around the local X axis. */
function localMatrix(ox, oy, oz, yaw, lx, ly, lz, tiltX){
  var m = new THREE.Matrix4().makeRotationY(yaw);
  m.setPosition(ox, oy, oz);
  var t = new THREE.Matrix4().makeTranslation(lx, ly, lz);
  m.multiply(t);
  if (tiltX) m.multiply(new THREE.Matrix4().makeRotationX(tiltX));
  return m;
}
function worldMatrix(x, y, z, yaw, sx, sy, sz){
  var m = new THREE.Matrix4().makeRotationY(yaw || 0);
  m.scale(new THREE.Vector3(sx || 1, sy || 1, sz || 1));
  m.setPosition(x, y, z);
  return m;
}
/* house-local -> world, same convention as residential_detail's l2w */
function l2w(bx, bz, yaw, lx, lz){
  var c = Math.cos(yaw), s = Math.sin(yaw);
  return [bx + lx*c + lz*s, bz - lx*s + lz*c];
}
function jitterGeo(geo, amt, seed){
  var r = mulberry32(seed);
  var p = geo.attributes.position;
  var seen = {};
  for (var i = 0; i < p.count; i++){
    var key = p.getX(i).toFixed(3) + ',' + p.getY(i).toFixed(3) + ',' + p.getZ(i).toFixed(3);
    if (!seen[key]) seen[key] = [(r()-0.5)*amt, (r()-0.5)*amt, (r()-0.5)*amt];
    var j = seen[key];
    p.setXYZ(i, p.getX(i)+j[0], p.getY(i)+j[1], p.getZ(i)+j[2]);
  }
  geo.computeVertexNormals();
  return geo;
}
/* soft radial blob texture (shade decals) */
function blobTexture(){
  var cv = document.createElement('canvas'); cv.width = cv.height = 128;
  var g = cv.getContext('2d');
  var gr = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  gr.addColorStop(0, 'rgba(20,26,16,0.85)');
  gr.addColorStop(0.65, 'rgba(20,26,16,0.38)');
  gr.addColorStop(1, 'rgba(20,26,16,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  var t = new THREE.CanvasTexture(cv); return t;
}
/* soft cloud puff texture */
function cloudTexture(){
  var cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
  var g = cv.getContext('2d');
  var puffs = [[70,84,44],[118,70,56],[168,80,48],[100,88,40],[146,90,38],[52,92,30],[196,92,30]];
  for (var i = 0; i < puffs.length; i++){
    var p = puffs[i];
    var gr = g.createRadialGradient(p[0], p[1], 4, p[0], p[1], p[2]);
    gr.addColorStop(0, 'rgba(255,250,242,0.55)');
    gr.addColorStop(0.7, 'rgba(255,246,236,0.28)');
    gr.addColorStop(1, 'rgba(255,246,236,0)');
    g.fillStyle = gr;
    g.fillRect(p[0]-p[2], p[1]-p[2], p[2]*2, p[2]*2);
  }
  return new THREE.CanvasTexture(cv);
}
/* grass-blade tuft texture (painted blades, alpha tested) */
function tuftTexture(){
  var cv = document.createElement('canvas'); cv.width = cv.height = 64;
  var g = cv.getContext('2d');
  g.clearRect(0, 0, 64, 64);
  var r = mulberry32(777);
  for (var i = 0; i < 46; i++){
    var x = 4 + r()*56, bend = (r()-0.5)*14, h = 26 + r()*34;
    var grad = g.createLinearGradient(0, 64, 0, 64-h);
    grad.addColorStop(0, '#3d6b26'); grad.addColorStop(1, '#7fae4a');
    g.strokeStyle = grad; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(x, 64);
    g.quadraticCurveTo(x + bend*0.3, 64 - h*0.6, x + bend, 64 - h);
    g.stroke();
  }
  return new THREE.CanvasTexture(cv);
}

/* ---------------- the build ---------------- */
function build(){
  var t0 = Date.now();
  var HX = heroHouse.cx, HZ = heroHouse.cz;
  var group = new THREE.Group();
  group.name = 'proto-dress-535';
  var stats = { houses: 0, porches: 0, pickets: 0, flowers: 0, leafPuffs: 0,
    shrubs: 0, tufts: 0, leaves: 0, trees: 0, canopyPuffs: 0, mailboxes: 0,
    sidewalkSegs: 0, clouds: 0, tris: 0, meshes: 0 };

  /* ----- pick the block's houses from the bake's kept list ----- */
  var kept = __bldgMeshes.kept;
  var houses = [];
  for (var i = 0; i < kept.length; i++){
    var b = kept[i];
    if (b[5] !== 0) continue;                              /* type 0 = House */
    var dx = b[0]-HX, dz = b[1]-HZ;
    if (dx*dx + dz*dz > 125*125) continue;                 /* the block */
    if (Math.abs(dx) < 13 && Math.abs(dz) < 11) continue;  /* hero lot itself */
    houses.push({ x:b[0], z:b[1], w:b[2], d:b[3], h:b[4], yaw:b[6] || 0,
                  gy: heightAt(b[0], b[1]) });
  }
  if (houses.length < 5){
    S.reason = 'too few houses found (' + houses.length + ') — aborting';
    return;
  }
  stats.houses = houses.length;

  var boxes = new BoxBatch();       /* every coloured box, one mesh */
  var WHITE = 0xf0ead8, CREAM = 0xe6dec8, ROOFC = 0x453b31,
      CONC = 0xa9a49a, WOOD = 0xa08156, WOOD_D = 0x8a6c46,
      MULCH = 0x3a2a1a, TERRA = 0xb56545;

  /* ----- per-house dressing ----- */
  var picketMats = [], flowerMats = [], flowerCols = [],
      leafMats = [], shrubMats = [], shrubCols = [],
      trunkMats = [], canopyMats = [], canopyCols = [], coneMats = [],
      decalMats = [];
  var FLOWER_COLS = [0xf27bb5, 0xffd94a, 0xa678e8, 0xffffff, 0xe84a5f, 0xff9a3d, 0xf6c6e8];
  var dummy = new THREE.Object3D();

  function addFlower(x, y, z){
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rand()*Math.PI, 0);
    var s = 0.75 + rand()*0.7;
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    flowerMats.push(dummy.matrix.clone());
    flowerCols.push(new THREE.Color(FLOWER_COLS[Math.floor(rand()*FLOWER_COLS.length)]));
  }
  function addLeafPuff(x, y, z, s){
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rand()*Math.PI, 0);
    dummy.scale.set(s, s*0.55, s);
    dummy.updateMatrix();
    leafMats.push(dummy.matrix.clone());
  }
  function addShrub(x, y, z, s){
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rand()*Math.PI, 0);
    dummy.scale.set(s*(0.85+rand()*0.4), s*(0.7+rand()*0.35), s*(0.85+rand()*0.4));
    dummy.updateMatrix();
    shrubMats.push(dummy.matrix.clone());
    var g = 0.32 + rand()*0.2;
    shrubCols.push(new THREE.Color(0.25*g/0.4, g, 0.18*g/0.4));
  }
  function bedFlowers(hx2, hz2, yaw, lx0, lx1, lz, gy, n){
    for (var k = 0; k < n; k++){
      var lx = lx0 + rand()*(lx1-lx0), lz2 = lz + (rand()-0.5)*0.55;
      var p = l2w(hx2, hz2, yaw, lx, lz2);
      if (k % 3 === 0) addLeafPuff(p[0], gy + 0.16, p[1], 0.5 + rand()*0.3);
      addFlower(p[0], gy + 0.3 + rand()*0.1, p[1]);
      stats.flowers++;
    }
  }

  houses.forEach(function(hs, hi){
    var yaw = hs.yaw, gy = hs.gy;
    var porchHalf = Math.min(hs.w*0.35, 3.0);
    var front = hs.d/2;

    /* --- porch: slab + roof + own posts + railing + steps ---
       (residential_detail already lays a slab + 2 posts on ~half the
       houses; this completes every porch on the block with a roof,
       railing and steps, sized to sit with theirs, not against it) */
    var slabM = localMatrix(hs.x, gy, hs.z, yaw, 0, 0.3, front + 1.3);
    boxes.addBox(Math.min(hs.w*0.78, 7.2), 0.22, 2.9, CONC, slabM);
    var roofM = localMatrix(hs.x, gy, hs.z, yaw, 0, 3.02, front + 1.45, 0.16);
    boxes.addBox(Math.min(hs.w*0.84, 7.8), 0.14, 3.3, ROOFC, roofM);
    var trimM = localMatrix(hs.x, gy, hs.z, yaw, 0, 2.9, front + 2.95, 0.16);
    boxes.addBox(Math.min(hs.w*0.84, 7.8), 0.16, 0.1, WHITE, trimM);
    [-1, 1].forEach(function(sgn){
      var pm = localMatrix(hs.x, gy, hs.z, yaw, sgn*(porchHalf + 0.35), 1.62, front + 2.55);
      boxes.addBox(0.2, 2.75, 0.2, CREAM, pm);
    });
    /* railing: front edge, gap at the centre steps */
    [-1, 1].forEach(function(sgn){
      var segLen = porchHalf - 0.7;
      if (segLen < 0.6) return;
      var cxL = sgn*(0.85 + segLen/2);
      var rm = localMatrix(hs.x, gy, hs.z, yaw, cxL, 1.28, front + 2.62);
      boxes.addBox(segLen, 0.09, 0.09, WHITE, rm);
      var rm2 = localMatrix(hs.x, gy, hs.z, yaw, cxL, 0.82, front + 2.62);
      boxes.addBox(segLen, 0.06, 0.06, WHITE, rm2);
      var nb = Math.floor(segLen / 0.3);
      for (var bi = 0; bi <= nb; bi++){
        var bm = localMatrix(hs.x, gy, hs.z, yaw,
          sgn*0.85 + (segLen)*(nb ? bi/nb : 0)*sgn, 0.82, front + 2.62);
        boxes.addBox(0.055, 0.85, 0.055, WHITE, bm);
      }
    });
    /* steps down from the slab, centre front */
    var st1 = localMatrix(hs.x, gy, hs.z, yaw, 0, 0.19, front + 3.05);
    boxes.addBox(1.7, 0.2, 0.5, CONC, st1);
    var st2 = localMatrix(hs.x, gy, hs.z, yaw, 0, 0.06, front + 3.35);
    boxes.addBox(1.9, 0.1, 0.45, CONC, st2);
    stats.porches++;

    /* --- flower beds flanking the porch + shrubs --- */
    [-1, 1].forEach(function(sgn){
      var bx0 = sgn*(porchHalf + 0.45), bx1 = sgn*(hs.w*0.47);
      if (Math.abs(bx1 - bx0) < 0.8) return;
      var lo = Math.min(bx0, bx1), hi2 = Math.max(bx0, bx1);
      var bedM = localMatrix(hs.x, gy, hs.z, yaw, (lo+hi2)/2, 0.07, front + 0.62);
      boxes.addBox(hi2 - lo, 0.15, 0.95, MULCH, bedM);
      bedFlowers(hs.x, hs.z, yaw, lo + 0.2, hi2 - 0.2, front + 0.62, gy, 22);
      var sp = l2w(hs.x, hs.z, yaw, sgn*(porchHalf + 0.75), front + 1.15);
      addShrub(sp[0], gy + 0.42, sp[1], 0.95);
      stats.shrubs++;
    });

    /* --- side fences: pickets instanced, rails in the box batch ---
       From the front corners running back along the lot sides.
       Skipped on a side whose neighbour crowds the line. */
    [-1, 1].forEach(function(sgn){
      var mid = l2w(hs.x, hs.z, yaw, sgn*(hs.w/2 + 1.6), front - 6);
      for (var ni = 0; ni < houses.length; ni++){
        if (houses[ni] === hs) continue;
        var ndx = houses[ni].x - mid[0], ndz = houses[ni].z - mid[1];
        if (ndx*ndx + ndz*ndz < 30) return;         /* crowded — skip side */
      }
      var a = l2w(hs.x, hs.z, yaw, sgn*(hs.w/2 + 1.6), front + 0.4);
      var bpt = l2w(hs.x, hs.z, yaw, sgn*(hs.w/2 + 1.6), front - 11.5);
      var len = Math.hypot(bpt[0]-a[0], bpt[1]-a[1]);
      var n = Math.floor(len / 0.29);
      for (var pi = 0; pi <= n; pi++){
        var t = pi / n;
        var px = a[0] + (bpt[0]-a[0])*t, pz = a[1] + (bpt[1]-a[1])*t;
        dummy.position.set(px, heightAt(px, pz) + 0.52, pz);
        dummy.rotation.set(0, yaw - Math.PI/2, 0);   /* wide face along the fence line */
        dummy.scale.set(1, 0.95 + rand()*0.12, 1);
        dummy.updateMatrix();
        picketMats.push(dummy.matrix.clone());
        stats.pickets++;
      }
      [0.55, 0.92].forEach(function(ry){
        /* rails: one long thin box rotated to the fence direction */
        var midx = (a[0]+bpt[0])/2, midz = (a[1]+bpt[1])/2;
        var dirx = bpt[0]-a[0], dirz = bpt[1]-a[1];
        var fang = Math.atan2(dirx, dirz);
        var fm = worldMatrix(midx, heightAt(midx, midz) + ry, midz, fang, 1, 1, 1);
        boxes.addBox(0.05, 0.09, len, WOOD_D, fm);
      });
    });

    /* --- a yard tree for most houses (side/back, off the road) --- */
    var hsh = rand();
    if (hsh < 0.72){
      var side = rand() < 0.5 ? -1 : 1;
      var tp = l2w(hs.x, hs.z, yaw, side*(hs.w/2 + 4.2), -hs.d/2 - 2.5 - rand()*3);
      var ok = true;
      try{ if (distToRoadEdge(tp[0], tp[1]) < 6.5) ok = false; }catch(e){}
      if (ok && Math.hypot(tp[0]-HX, tp[1]-HZ) > 15) addTree(tp[0], tp[1], 0.85 + rand()*0.4, rand() < 0.25);
    }

    /* --- mailbox at the curb for the houses nearest the road --- */
    var fp = l2w(hs.x, hs.z, yaw, hs.w*0.28, front + 1.0);
    var rd = 1e9;
    try{ rd = distToRoadEdge(fp[0], fp[1]); }catch(e){}
    if (rd < 9){
      var mp = l2w(hs.x, hs.z, yaw, hs.w*0.28, front + 1.0 + Math.max(0, rd - 1.2));
      var mgy = heightAt(mp[0], mp[1]);
      var mm = worldMatrix(mp[0], mgy, mp[1], yaw, 1, 1, 1);
      boxes.addBox(0.12, 1.05, 0.12, WOOD_D, mm.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.52, 0)));
      boxes.addBox(0.62, 0.34, 0.36, 0x2f3a33, mm.clone().multiply(new THREE.Matrix4().makeTranslation(0, 1.2, 0)));
      boxes.addBox(0.05, 0.3, 0.05, 0xd33a2c, mm.clone().multiply(new THREE.Matrix4().makeTranslation(0.3, 1.3, 0)));
      stats.mailboxes++;
    }
  });

  /* ----- trees (shared helper, used by yards + feature trees) ----- */
  function addTree(x, z, s, pine){
    var gy = heightAt(x, z);
    dummy.position.set(x, gy + 1.5*s, z);
    dummy.rotation.set(0, rand()*Math.PI, 0);
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    trunkMats.push(dummy.matrix.clone());
    if (pine){
      dummy.position.set(x, gy + (3.0 + 2.6)*s, z);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      coneMats.push(dummy.matrix.clone());
    } else {
      var puffs = 4 + Math.floor(rand()*3);
      for (var i = 0; i < puffs; i++){
        var a = (i / puffs) * Math.PI * 2 + rand()*0.8;
        var rr = (i === 0) ? 0 : 1.15*s;
        var px = x + Math.cos(a)*rr, pz = z + Math.sin(a)*rr;
        var py = gy + (3.1 + rand()*0.9 + (i === 0 ? 0.7 : 0))*s;
        dummy.position.set(px, py, pz);
        dummy.rotation.set(rand()*0.4, rand()*Math.PI, rand()*0.4);
        var ps = (1.5 + rand()*0.8)*s;
        dummy.scale.set(ps, ps*0.82, ps);
        dummy.updateMatrix();
        canopyMats.push(dummy.matrix.clone());
        var warm = rand();
        canopyCols.push(new THREE.Color(warm < 0.18 ? 0x8fae3e :
          (warm < 0.55 ? 0x4d8033 : 0x5f9440)));
        stats.canopyPuffs++;
      }
    }
    /* baked-feeling ground shade under the canopy */
    var dm = new THREE.Matrix4().makeRotationX(-Math.PI/2);
    dm.setPosition(x, gy + 0.07, z);
    dm.multiply(new THREE.Matrix4().makeScale(3.6*s, 3.6*s, 1));
    decalMats.push(dm);
    stats.trees++;
  }

  /* ----- hero house: the fullest treatment ----- */
  (function dressHero(){
    var gy = heightAt(HX, HZ);
    var mainY = (typeof heroHouse !== 'undefined' && heroHouse.mainY) || gy + 2.4;
    var D = 8.0, frontZ = HZ + D/2;      /* front face (road side, +z) */
    /* railing across the existing porch (slab 4.0 x 2.5 at mainY,
       steps at centre) — white rails both sides of the stair gap */
    [-1, 1].forEach(function(sgn){
      var rx = HX + sgn*1.55;
      boxes.addBox(1.05, 0.09, 0.09, WHITE, worldMatrix(rx, mainY + 0.95, frontZ + 2.28, 0, 1, 1, 1));
      boxes.addBox(1.05, 0.06, 0.06, WHITE, worldMatrix(rx, mainY + 0.5, frontZ + 2.28, 0, 1, 1, 1));
      for (var bi = 0; bi < 4; bi++)
        boxes.addBox(0.055, 0.9, 0.055, WHITE,
          worldMatrix(rx - 0.45 + bi*0.3, mainY + 0.48, frontZ + 2.28, 0, 1, 1, 1));
      /* side rail return */
      boxes.addBox(0.09, 0.09, 2.2, WHITE, worldMatrix(HX + sgn*2.02, mainY + 0.95, frontZ + 1.2, 0, 1, 1, 1));
    });
    /* planters with flowers on the porch, flanking the door */
    [-1, 1].forEach(function(sgn){
      var px = HX + sgn*1.7;
      boxes.addBox(0.55, 0.4, 0.55, TERRA, worldMatrix(px, mainY + 0.32, frontZ + 1.9, 0, 1, 1, 1));
      for (var fi = 0; fi < 7; fi++)
        addFlower(px + (rand()-0.5)*0.4, mainY + 0.62 + rand()*0.12, frontZ + 1.9 + (rand()-0.5)*0.4);
      stats.flowers += 7;
    });
    /* warm porch light: emissive lamp + one PointLight */
    var lamp = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 0.16),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0 }));
    lamp.position.set(HX + 1.05, mainY + 2.25, frontZ + 0.25);
    group.add(lamp); stats.meshes++;
    var pl = new THREE.PointLight(0xffbf78, 0.85, 21, 2);
    pl.position.set(HX, mainY + 2.1, frontZ + 2.4);
    group.add(pl);
    /* foundation flower beds, the full width both sides of the steps */
    [-1, 1].forEach(function(sgn){
      var cxB = HX + sgn*4.35;
      boxes.addBox(4.3, 0.16, 1.0, MULCH, worldMatrix(cxB, gy + 0.08, frontZ + 0.62, 0, 1, 1, 1));
      for (var k = 0; k < 34; k++){
        var fx = cxB + (rand()-0.5)*3.9, fz = frontZ + 0.62 + (rand()-0.5)*0.6;
        if (k % 3 === 0) addLeafPuff(fx, gy + 0.17, fz, 0.55 + rand()*0.3);
        addFlower(fx, gy + 0.32 + rand()*0.1, fz);
        stats.flowers++;
      }
      addShrub(HX + sgn*6.9, gy + 0.45, frontZ + 0.7, 1.1); stats.shrubs++;
      addShrub(HX + sgn*2.35, gy + 0.4, frontZ + 1.5, 0.85); stats.shrubs++;
    });
    /* hero lot side fences (pickets + rails), front left open for the
       driveway on the east side; back left open for the basketball
       court approach */
    [-1, 1].forEach(function(sgn){
      var fx = HX + sgn*15.5;
      for (var pz = HZ + 6; pz > HZ - 14; pz -= 0.29){
        if (sgn > 0 && pz > HZ + 4) continue;      /* driveway gap */
        dummy.position.set(fx, heightAt(fx, pz) + 0.52, pz);
        dummy.rotation.set(0, -Math.PI/2, 0);   /* wide face along the z-running fence */
        dummy.scale.set(1, 0.95 + rand()*0.12, 1);
        dummy.updateMatrix();
        picketMats.push(dummy.matrix.clone());
        stats.pickets++;
      }
      [0.55, 0.92].forEach(function(ry){
        boxes.addBox(0.05, 0.09, 18, WOOD_D,
          worldMatrix(fx, heightAt(fx, HZ - 5) + ry, HZ - 5, 0, 1, 1, 1));
      });
    });
    /* two feature maples framing the front yard + one across the
       street (picture composition), validated off-road */
    [[HX - 13.5, HZ + 13], [HX + 16, HZ + 11], [HX - 30, HZ + 26]].forEach(function(tp){
      var ok = true;
      try{ if (distToRoadEdge(tp[0], tp[1]) < 5.5) ok = false; }catch(e){}
      if (ok) addTree(tp[0], tp[1], 1.5, false);
    });
    /* a bicycle leaning by the driveway + a skateboard on the
       walkway — the picture's street-life props, kept tiny */
    var bike = new THREE.Group();
    var bmat = new THREE.MeshLambertMaterial({ color: 0x2a4a7f });
    var tmat = new THREE.MeshLambertMaterial({ color: 0x1c1c1e });
    [0, 0.95].forEach(function(off){
      var wheel = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 6, 14), tmat);
      wheel.position.set(off, 0.34, 0); bike.add(wheel);
    });
    var bar1 = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.0, 5), bmat);
    bar1.position.set(0.47, 0.55, 0); bar1.rotation.z = 1.15; bike.add(bar1);
    var bar2 = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.72, 5), bmat);
    bar2.position.set(0.3, 0.62, 0); bar2.rotation.z = 0.5; bike.add(bar2);
    var seat = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.09), tmat);
    seat.position.set(0.18, 0.86, 0); bike.add(seat);
    bike.position.set(HX + 7.6, heightAt(HX + 7.6, HZ + 19.5), HZ + 19.5);
    bike.rotation.y = 0.5; bike.rotation.z = 0.1;
    group.add(bike); stats.meshes += 6;
    var deck = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.04, 0.24),
      new THREE.MeshLambertMaterial({ color: 0x7a4a9e }));
    deck.position.set(HX - 1.8, heightAt(HX - 1.8, HZ + 15.2) + 0.1, HZ + 15.2);
    deck.rotation.y = 0.4;
    group.add(deck); stats.meshes++;
  })();

  /* ----- continuous sidewalks along Dollar Mill (both sides) ----- */
  (function sidewalks(){
    var recs = [];
    for (var i = 0; i < roadDrawData.length; i++){
      var r = roadDrawData[i];
      if (!r.name || r.name.toLowerCase().indexOf('dollar mill') < 0) continue;
      recs.push(r);
    }
    if (!recs.length || typeof ribbonGeom !== 'function') return;
    var concMat = null;
    try{ concMat = SAtex.mat('concpave', { color: 0xbdb8ac }); }catch(e){}
    if (!concMat) concMat = new THREE.MeshLambertMaterial({ color: 0xb0aa9e });
    var curbMat = new THREE.MeshLambertMaterial({ color: 0x8f8c85 });
    var sidesDone = {};
    /* all sidewalk ribbons merge into ONE geometry (and curbs into a
       second) — 2 draw calls for the whole street, not 2 per segment */
    var walkGeos = [], curbGeos = [];
    function bucketPush(list, geo){
      var g = geo.index ? geo.toNonIndexed() : geo;
      list.push(g);
    }
    function bucketMesh(list, mat){
      if (!list.length) return;
      var pos = [], nor = [], uv = [];
      list.forEach(function(g){
        var pa = g.attributes.position.array, na = g.attributes.normal.array,
            ua = g.attributes.uv ? g.attributes.uv.array : null;
        for (var i = 0; i < pa.length; i++){ pos.push(pa[i]); nor.push(na[i]); }
        for (var j = 0; j < pa.length/3*2; j++) uv.push(ua ? ua[j] : 0);
      });
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      var m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      group.add(m); stats.meshes++;
    }
    recs.forEach(function(r){
      for (var si = 0; si < r.pts.length - 1; si++){
        var a = r.pts[si], b = r.pts[si+1];
        var mx = (a[0]+b[0])/2, mz = (a[1]+b[1])/2;
        if (Math.abs(mx - HX) > 175 || Math.abs(mz - HZ) > 60) continue;
        var dx = b[0]-a[0], dz = b[1]-a[1], len = Math.hypot(dx, dz);
        if (len < 2) continue;
        var nx = -dz/len, nz = dx/len;
        [-1, 1].forEach(function(sgn){
          var off = r.w/2 + 1.85;
          var p1 = [a[0] + nx*off*sgn, a[1] + nz*off*sgn];
          var p2 = [b[0] + nx*off*sgn, b[1] + nz*off*sgn];
          var key = Math.round(p1[0]/4) + '_' + Math.round(p1[1]/4) + '_' + sgn;
          if (sidesDone[key]) return; sidesDone[key] = 1;
          var geo = ribbonGeom([p1, p2], 1.9, 0.13);
          try{ SAtex.worldUV(geo, 'concpave'); }catch(e){}
          bucketPush(walkGeos, geo);
          var coff = r.w/2 + 0.28;
          var c1 = [a[0] + nx*coff*sgn, a[1] + nz*coff*sgn];
          var c2 = [b[0] + nx*coff*sgn, b[1] + nz*coff*sgn];
          bucketPush(curbGeos, ribbonGeom([c1, c2], 0.55, 0.1));
          stats.sidewalkSegs++;
        });
      }
    });
    bucketMesh(walkGeos, concMat);
    bucketMesh(curbGeos, curbMat);
  })();

  /* ----- grass tufts + fallen leaves across the block's lawns ----- */
  (function groundLife(){
    var tuftMats = [], leafMatsG = [], leafCols = [];
    var LEAF_COLS = [0xc46a24, 0xd8892e, 0xa84e22, 0xb8862e, 0x96602a];
    var placedT = 0, guard = 0;
    while (placedT < 1500 && guard++ < 9000){
      var a = rand()*Math.PI*2, rr = Math.sqrt(rand())*128;
      var x = HX + Math.cos(a)*rr, z = HZ + Math.sin(a)*rr*0.85;
      var rd = 1e9; try{ rd = distToRoadEdge(x, z); }catch(e){}
      if (rd < 1.1) continue;
      var bad = false;
      for (var hi = 0; hi < houses.length; hi++){
        var hd = houses[hi];
        if (Math.abs(x - hd.x) < hd.w/2 + 1.6 && Math.abs(z - hd.z) < hd.d/2 + 1.6){ bad = true; break; }
      }
      if (bad) continue;
      if (Math.abs(x - HX) < 12 && Math.abs(z - HZ) < 10) continue;      /* hero footprint */
      if (Math.hypot(x - HX, z - (HZ - 21)) < 10.5) continue;            /* basketball dirt */
      if (Math.hypot(x - (HX - 3), z - (HZ + 16)) < 5) continue;         /* driveway line */
      dummy.position.set(x, heightAt(x, z) + 0.02, z);
      dummy.rotation.set(0, rand()*Math.PI, 0);
      var s = 0.7 + rand()*0.8;
      dummy.scale.set(s, s*(0.8 + rand()*0.5), s);
      dummy.updateMatrix();
      tuftMats.push(dummy.matrix.clone());
      placedT++;
    }
    stats.tufts = placedT;
    var placedL = 0; guard = 0;
    while (placedL < 320 && guard++ < 4000){
      var a2 = rand()*Math.PI*2, rr2 = Math.sqrt(rand())*120;
      var lx = HX + Math.cos(a2)*rr2, lz = HZ + Math.sin(a2)*rr2*0.85;
      var rd2 = 1e9; try{ rd2 = distToRoadEdge(lx, lz); }catch(e){}
      if (rd2 < 0.2 || rd2 > 26) continue;
      dummy.position.set(lx, heightAt(lx, lz) + 0.055, lz);
      dummy.rotation.set(-Math.PI/2, 0, rand()*Math.PI);
      var ls = 0.22 + rand()*0.22;
      dummy.scale.set(ls, ls, ls);
      dummy.updateMatrix();
      leafMatsG.push(dummy.matrix.clone());
      leafCols.push(new THREE.Color(LEAF_COLS[Math.floor(rand()*LEAF_COLS.length)]));
      placedL++;
    }
    stats.leaves = placedL;

    var tuftGeo = (function(){
      var g1 = new THREE.PlaneGeometry(0.85, 0.55); g1.translate(0, 0.26, 0);
      var g2 = g1.clone(); g2.rotateY(Math.PI/2);
      var merged = new THREE.BufferGeometry();
      var parts = [g1.toNonIndexed(), g2.toNonIndexed()];
      var pos = [], nor = [], uv = [];
      parts.forEach(function(p){
        var pa = p.attributes.position.array, na = p.attributes.normal.array, ua = p.attributes.uv.array;
        for (var i = 0; i < pa.length; i++){ pos.push(pa[i]); nor.push(na[i]); }
        for (var j = 0; j < ua.length; j++) uv.push(ua[j]);
      });
      merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      merged.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      return merged;
    })();
    var tuftMat = new THREE.MeshLambertMaterial({ map: tuftTexture(),
      alphaTest: 0.4, side: THREE.DoubleSide });
    var tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, tuftMats.length);
    tuftMats.forEach(function(m, ix){ tufts.setMatrixAt(ix, m); });
    tufts.frustumCulled = false;
    group.add(tufts); stats.meshes++;

    var leafGeo = new THREE.PlaneGeometry(1, 1);
    var leafMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    var leaves = new THREE.InstancedMesh(leafGeo, leafMat, leafMatsG.length);
    leafMatsG.forEach(function(m, ix){ leaves.setMatrixAt(ix, m); leaves.setColorAt(ix, leafCols[ix]); });
    leaves.frustumCulled = false;
    group.add(leaves); stats.meshes++;
  })();

  stats.leafPuffs = leafMats.length;
  stats.flowers = flowerMats.length;

  /* ----- assemble the instanced sets ----- */
  function makeInstanced(geo, mat, mats, cols){
    if (!mats.length) return null;
    var im = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach(function(m, ix){
      im.setMatrixAt(ix, m);
      if (cols) im.setColorAt(ix, cols[ix]);
    });
    im.frustumCulled = false;
    group.add(im); stats.meshes++;
    return im;
  }
  var picketGeo = jitterGeo(new THREE.BoxGeometry(0.14, 1.05, 0.045), 0.012, 41);
  makeInstanced(picketGeo, new THREE.MeshLambertMaterial({ color: 0xb08e5e }),
    picketMats, null);
  var flowerGeo = new THREE.IcosahedronGeometry(0.13, 0);
  makeInstanced(flowerGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }),
    flowerMats, flowerCols);
  var leafGeo2 = jitterGeo(new THREE.IcosahedronGeometry(0.34, 0), 0.08, 97);
  makeInstanced(leafGeo2, new THREE.MeshLambertMaterial({ color: 0x55803a }),
    leafMats, null);
  var shrubGeo = jitterGeo(new THREE.IcosahedronGeometry(0.62, 1), 0.16, 123);
  makeInstanced(shrubGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }),
    shrubMats, shrubCols);
  var trunkGeo = new THREE.CylinderGeometry(0.16, 0.3, 3.0, 6);
  makeInstanced(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x5a4030 }),
    trunkMats, null);
  var canopyGeo = jitterGeo(new THREE.IcosahedronGeometry(1, 1), 0.3, 55);
  makeInstanced(canopyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }),
    canopyMats, canopyCols);
  var coneGeo = new THREE.ConeGeometry(2.6, 6.4, 7);
  /* cones are placed with their own matrices (position pre-offset) */
  if (coneMats.length){
    var cones = new THREE.InstancedMesh(coneGeo,
      new THREE.MeshLambertMaterial({ color: 0x2d5a27 }), coneMats.length);
    coneMats.forEach(function(m, ix){
      var fix = m.clone();
      cones.setMatrixAt(ix, fix);
    });
    cones.frustumCulled = false;
    group.add(cones); stats.meshes++;
  }

  /* shade decals under trees (merged planes, one material) */
  if (decalMats.length){
    var planeGeo = new THREE.PlaneGeometry(2, 2).toNonIndexed();
    var dPos = [], dNor = [], dUv = [];
    var pa = planeGeo.attributes.position.array,
        na = planeGeo.attributes.normal.array,
        ua = planeGeo.attributes.uv.array;
    decalMats.forEach(function(m){
      var g2 = planeGeo.clone(); g2.applyMatrix4(m);
      var p2 = g2.attributes.position.array, n2 = g2.attributes.normal.array, u2 = g2.attributes.uv.array;
      for (var i = 0; i < p2.length; i++){ dPos.push(p2[i]); dNor.push(n2[i]); }
      for (var j = 0; j < u2.length; j++) dUv.push(u2[j]);
    });
    var dGeo = new THREE.BufferGeometry();
    dGeo.setAttribute('position', new THREE.Float32BufferAttribute(dPos, 3));
    dGeo.setAttribute('normal', new THREE.Float32BufferAttribute(dNor, 3));
    dGeo.setAttribute('uv', new THREE.Float32BufferAttribute(dUv, 2));
    var dMesh = new THREE.Mesh(dGeo, new THREE.MeshBasicMaterial({
      map: blobTexture(), transparent: true, opacity: 0.5, depthWrite: false }));
    dMesh.renderOrder = 2;
    dMesh.frustumCulled = false;
    group.add(dMesh); stats.meshes++;
  }

  /* the one merged box mesh (porches, rails, steps, beds, mailboxes…) */
  var boxMesh = boxes.mesh();
  group.add(boxMesh); stats.meshes++;

  /* ----- clouds: painted puffs, warm, slow drift ----- */
  var cloudSprites = [];
  (function clouds(){
    var tex = cloudTexture();
    var n = 10;
    for (var i = 0; i < n; i++){
      var cx = HX + (rand()-0.5)*1300, cz = HZ + (rand()-0.5)*1300;
      var cy = 125 + rand()*65;
      var puffs = 3 + Math.floor(rand()*2);
      for (var p = 0; p < puffs; p++){
        var sm = new THREE.SpriteMaterial({ map: tex, transparent: true,
          opacity: 0.5 + rand()*0.3, depthWrite: false, fog: false,
          color: 0xfff3e2 });
        var sp = new THREE.Sprite(sm);
        var sc = 90 + rand()*110;
        sp.position.set(cx + (rand()-0.5)*70, cy + (rand()-0.5)*14, cz + (rand()-0.5)*40);
        sp.scale.set(sc, sc*0.42, 1);
        group.add(sp);
        cloudSprites.push(sp);
        stats.clouds++;
        stats.meshes++;
      }
    }
    var vx = 0.55;
    (function drift(){
      requestAnimationFrame(drift);
      for (var i = 0; i < cloudSprites.length; i++){
        var sp = cloudSprites[i];
        sp.position.x += vx * 0.016;
        if (sp.position.x > HX + 750) sp.position.x = HX - 750;
      }
    })();
  })();

  /* ----- count triangles honestly ----- */
  group.traverse(function(o){
    if (o.isMesh || o.isSprite){
      if (o.isSprite){ stats.tris += 2; return; }
      var g = o.geometry; if (!g) return;
      var per = g.index ? g.index.count/3 : (g.attributes.position ? g.attributes.position.count/3 : 0);
      var inst = o.isInstancedMesh ? o.count : 1;
      stats.tris += Math.round(per * inst);
    }
  });

  scene.add(group);
  S.built = true;
  S.reason = 'dressed';
  S.group = group;
  S.stats = stats;
  S.buildMs = Date.now() - t0;
  try{ console.log('[proto-dress] 535 block dressed: ' + JSON.stringify(stats)); }catch(e){}
}

}catch(e){
  S.reason = 'build-failed: ' + (e && e.message || e);
  try{ console.warn('[proto-dress] ' + S.reason); }catch(_){}
}
})();
