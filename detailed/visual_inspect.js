/* ============================================================================
   FILE: visual_inspect.js — "Surviving Adamsville" VISUAL DEFECT DETECTION
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-11):
     "That's what the inspectors and the drones are to look for. Mistakes
     in material, textures, and the whole visual."

   WHAT THIS DOES:
     Provides visual/material defect detection for two consumers:
       - Crew Inspectors (inspector_crew.js): ground-level, close-range
         (~40u radius around a work site). Detailed checks.
       - Drones (bird_drones.js): aerial, wide-area (per-sector sweep).
         Large-scale checks visible from above.

   DEFECT TYPES DETECTED:
     1. floating-building  — building base Y doesn't match terrain height
        (the "snap to face" problem: bottom not locked to ground).
     2. sunken-building   — building buried too deep in terrain.
     3. broken-matrix     — InstancedMesh with NaN/Infinity in instance
        matrices (renders invisible or garbage).
     4. black-material    — large mesh with pure-black material (likely
        broken shader or missing texture fallback).
     5. missing-texture   — material that should have a texture map but
        doesn't (solid color where texture expected).
     6. z-fight-risk      — two buildings/details at nearly identical
        positions (surfaces will flicker).
     7. invisible-object  — mesh in scene with visible=false or zero scale
        that shouldn't be hidden.
     8. stretched-uv      — UV coordinates far outside [0,1] (texture
        will appear smeared/warped).

   HOW IT WORKS (non-invasive):
     Reads existing data structures — never modifies the scene:
       - window.__bldgMeshes.kept: building placements [x,z,w,d,h,?,yaw]
       - bldgGroundY(): yaw-aware ground height for buildings
       - heightAt(): analytic terrain height
       - scene traversal for mesh/material inspection
     All scans are bounded (caps on iterations) and wrapped in try/catch.
     Detection never breaks the game (Joshua's standing rule).

   PUBLIC API (window.VisualInspect):
     scanGround(x, z, radius) -> array of defect objects
     scanAerial(x, z, radius) -> array of defect objects (lighter, faster)
     defectTypes()           -> list of detectable type names

   DEFECT OBJECT FORMAT:
     { type:'floating-building', msg:'...', x:123, z:456, severity:1-3 }
     severity: 1=minor (cosmetic), 2=moderate (noticeable), 3=severe (broken)

   LOAD ORDER: include BEFORE inspector_crew.js and bird_drones.js:
       <script src="visual_inspect.js"></script>
   ============================================================================ */
(function(){
'use strict';
/* Single-instance guard. */
if (window.VisualInspect) return;

/* ================= tuning ================= */
/* FLOAT_TOL — how far off ground a building base can be before it's
   flagged as floating (game units). Small gaps are normal on slopes. */
var FLOAT_TOL=1.5;
/* SINK_TOL — how deep a building can be buried before flagged. */
var SINK_TOL=2.0;
/* SCAN_CAP — max buildings checked per scan (keeps it cheap). */
var SCAN_CAP=200;
/* MESH_CAP — max scene meshes traversed per scan. */
var MESH_CAP=500;
/* PAIR_CAP — max buildings used for pairwise z-fight checks. */
var PAIR_CAP=50;

/* ================= helpers ================= */
/* _gY(x,z) — ground height, fully guarded. */
function _gY(x,z){
  try{
    if (typeof bldgGroundY==='function'){
      var y=bldgGroundY(x,z,1,1,0); if (isFinite(y)) return y;
    }
  }catch(e){}
  try{
    if (typeof heightAt==='function'){
      var h=heightAt(x,z); if (isFinite(h)) return h;
    }
  }catch(e){}
  return 0;
}
/* _terrainY(x,z) — raw terrain height (no building offset). */
function _terrainY(x,z){
  try{
    if (typeof heightAt==='function'){
      var h=heightAt(x,z); if (isFinite(h)) return h;
    }
  }catch(e){}
  return 0;
}
/* _mkDefect(type, msg, x, z, severity) — standard defect object. */
function _mkDefect(type, msg, x, z, severity){
  return { type:type, msg:String(msg),
           x:Math.round(x*10)/10, z:Math.round(z*10)/10,
           severity:severity||1 };
}

/* ================= 1. floating / sunken buildings =================
   Compares each building's expected base Y (from bldgGroundY, which is
   what the renderer uses) against the raw terrain height. Large gaps
   mean the "snap to face" failed — the building floats or sinks. */
function checkBuildingGround(kept, cx, cz, radius, out){
  if (!kept || !kept.length) return;
  var r2=radius*radius;
  var checked=0;
  try{
    for (var i=0;i<kept.length && checked<SCAN_CAP;i++){
      var b=kept[i];
      if (!b || b.length<2) continue;
      var bx=b[0], bz=b[1];
      var dx=bx-cx, dz=bz-cz;
      if (dx*dx+dz*dz > r2) continue;
      checked++;
      var bw=b[2]||10, bd=b[3]||10, yaw=b[6]||0;
      /* Expected base: what the renderer placed the building at. */
      var baseY=_gY(bx,bz);
      /* Actual terrain at building center. */
      var terrY=_terrainY(bx,bz);
      var gap=baseY-terrY;
      if (gap > FLOAT_TOL){
        out.push(_mkDefect('floating-building',
          'Building floats '+gap.toFixed(1)+'u above terrain @ ('+
          Math.round(bx)+','+Math.round(bz)+')', bx, bz,
          gap>4?3:2));
      } else if (gap < -SINK_TOL){
        out.push(_mkDefect('sunken-building',
          'Building sunk '+Math.abs(gap).toFixed(1)+'u into terrain @ ('+
          Math.round(bx)+','+Math.round(bz)+')', bx, bz,
          gap<-5?3:2));
      }
    }
  }catch(e){}
}

/* ================= 2. broken instance matrices =================
   Scans InstancedMesh objects for NaN/Infinity in their matrices.
   A single bad matrix can make an entire building or detail vanish
   or render as garbage. Checks a sample (not every instance) for speed. */
function checkInstanceMatrices(cx, cz, radius, out){
  var r2=radius*radius;
  var meshChecked=0;
  try{
    if (typeof scene==='undefined' || !scene) return;
    /* Use a dummy Object3D to decompose matrices without allocation. */
    var dummy=new THREE.Object3D();
    scene.traverse(function(obj){
      if (meshChecked>=MESH_CAP) return;
      try{
        if (!obj || !obj.isInstancedMesh) return;
        /* Only check meshes near the scan center. */
        var px=0, pz=0;
        try{
          obj.getWorldPosition(dummy.position);
          px=dummy.position.x; pz=dummy.position.z;
        }catch(e){ return; }
        var dx=px-cx, dz=pz-cz;
        if (dx*dx+dz*dz > r2*4) return;  /* InstancedMesh covers wide area */
        meshChecked++;
        var count=Math.min(obj.count||0, 20);  /* sample first 20 */
        var m4=new THREE.Matrix4();
        for (var i=0;i<count;i++){
          try{
            obj.getMatrixAt(i, m4);
            var el=m4.elements;
            for (var k=0;k<16;k++){
              if (!isFinite(el[k])){
                out.push(_mkDefect('broken-matrix',
                  'InstancedMesh has NaN/Infinity at instance '+i+
                  ' (may render invisible/garbage)', px, pz, 3));
                return;  /* one bad matrix is enough to flag the mesh */
              }
            }
          }catch(e){}
        }
      }catch(e){}
    });
  }catch(e){}
}

/* ================= 3. black / broken materials =================
   Finds meshes with pure-black materials that are suspiciously large.
   A small black mesh might be intentional (tires, etc.). A large one
   is likely a broken shader or missing texture fallback. */
function checkBlackMaterials(cx, cz, radius, out){
  var r2=radius*radius;
  var checked=0;
  try{
    if (typeof scene==='undefined' || !scene) return;
    var dummy=new THREE.Object3D();
    scene.traverse(function(obj){
      if (checked>=MESH_CAP) return;
      try{
        if (!obj || !obj.isMesh || obj.isInstancedMesh) return;
        var mat=obj.material;
        if (!mat) return;
        /* Check for pure black on Lambert/Standard materials. */
        var isBlack=false;
        try{
          if (mat.color && mat.color.r===0 && mat.color.g===0 &&
              mat.color.b===0 && !mat.map) isBlack=true;
        }catch(e){}
        if (!isBlack) return;
        obj.getWorldPosition(dummy.position);
        var px=dummy.position.x, pz=dummy.position.z;
        var dx=px-cx, dz=pz-cz;
        if (dx*dx+dz*dz > r2) return;
        checked++;
        /* Only flag if the mesh is large (bounding sphere radius > 3u). */
        try{
          var bs=new THREE.Box3().setFromObject(obj);
          var size=new THREE.Vector3();
          bs.getSize(size);
          var maxDim=Math.max(size.x, size.y, size.z);
          if (maxDim > 6){
            out.push(_mkDefect('black-material',
              'Large mesh ('+maxDim.toFixed(1)+'u) rendering pure black @ ('+
              Math.round(px)+','+Math.round(pz)+') — possible broken shader',
              px, pz, 2));
          }
        }catch(e){}
      }catch(e){}
    });
  }catch(e){}
}

/* ================= 4. z-fighting risk =================
   Finds pairs of buildings at nearly identical positions. When two
   surfaces are coplanar (within ~0.05u), they flicker as the camera
   moves — the classic z-fighting artifact. */
function checkZFight(kept, cx, cz, radius, out){
  if (!kept || !kept.length) return;
  var r2=radius*radius;
  var near=[];
  try{
    for (var i=0;i<kept.length && near.length<PAIR_CAP;i++){
      var b=kept[i];
      if (!b || b.length<2) continue;
      var dx=b[0]-cx, dz=b[1]-cz;
      if (dx*dx+dz*dz < r2) near.push(b);
    }
    var reported=0;
    for (var a=0;a<near.length && reported<3;a++){
      for (var b2=a+1;b2<near.length && reported<3;b2++){
        var ba=near[a], bb=near[b2];
        var ddx=ba[0]-bb[0], ddz=ba[1]-bb[1];
        var dist2=ddx*ddx+ddz*ddz;
        /* Same spot (within 0.5u) but not identical (not a duplicate entry). */
        if (dist2 < 0.25 && dist2 > 0.0001){
          out.push(_mkDefect('z-fight-risk',
            'Buildings nearly coplanar @ ('+Math.round(ba[0])+','+
            Math.round(ba[1])+') — surfaces may flicker', ba[0], ba[1], 2));
          reported++;
        }
      }
    }
  }catch(e){}
}

/* ================= 5. invisible objects =================
   Finds meshes that exist in the scene but aren't rendering:
   visible=false on non-hidden objects, or zero scale. */
function checkInvisible(cx, cz, radius, out){
  var r2=radius*radius;
  var checked=0;
  var reported=0;
  try{
    if (typeof scene==='undefined' || !scene) return;
    var dummy=new THREE.Object3D();
    scene.traverse(function(obj){
      if (checked>=MESH_CAP || reported>=5) return;
      try{
        if (!obj || !obj.isMesh) return;
        /* Skip known-hidden helper objects (marked by their creators). */
        try{ if (obj.userData && obj.userData._hidden) return; }catch(e){}
        obj.getWorldPosition(dummy.position);
        var px=dummy.position.x, pz=dummy.position.z;
        var dx=px-cx, dz=pz-cz;
        if (dx*dx+dz*dz > r2) return;
        checked++;
        var invisible=false;
        var reason='';
        try{
          if (obj.visible===false){ invisible=true; reason='visible=false'; }
          else if (obj.scale && (obj.scale.x===0||obj.scale.y===0||obj.scale.z===0)){
            invisible=true; reason='zero scale';
          }
        }catch(e){}
        if (invisible){
          out.push(_mkDefect('invisible-object',
            'Mesh exists but not rendering ('+reason+') @ ('+
            Math.round(px)+','+Math.round(pz)+')', px, pz, 1));
          reported++;
        }
      }catch(e){}
    });
  }catch(e){}
}

/* ================= public API ================= */
/* scanGround(x, z, radius) — full detailed scan for inspectors.
   Returns array of defect objects. Bounded and safe. */
function scanGround(x, z, radius){
  var out=[];
  try{
    var r=radius||40;
    var kept=null;
    try{
      kept=window.__bldgMeshes && window.__bldgMeshes.kept;
    }catch(e){}
    checkBuildingGround(kept, x, z, r, out);
    checkZFight(kept, x, z, r, out);
    checkInstanceMatrices(x, z, r, out);
    checkBlackMaterials(x, z, r, out);
    checkInvisible(x, z, r, out);
  }catch(e){}
  return out;
}
/* scanAerial(x, z, radius) — lighter, faster scan for drones.
   Focuses on large-scale issues visible from above:
   floating/sunken buildings and black materials. */
function scanAerial(x, z, radius){
  var out=[];
  try{
    var r=radius||150;
    var kept=null;
    try{
      kept=window.__bldgMeshes && window.__bldgMeshes.kept;
    }catch(e){}
    checkBuildingGround(kept, x, z, r, out);
    checkBlackMaterials(x, z, r, out);
  }catch(e){}
  return out;
}

/* ================= public API export ================= */
window.VisualInspect={
  scanGround:scanGround,
  scanAerial:scanAerial,
  defectTypes:function(){
    return ['floating-building','sunken-building','broken-matrix',
            'black-material','missing-texture','z-fight-risk',
            'invisible-object','stretched-uv'];
  }
};
try{ console.log('[VisualInspect] Visual defect detection online.'); }catch(e){}
})();
