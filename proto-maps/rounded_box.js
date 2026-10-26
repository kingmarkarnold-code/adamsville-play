/* ============================================================================
   rounded_box.js — shared Pixar-style rounded-box geometry helper
   (expert report #21 — Roberto Silva, 3D Modeler, 30+ yrs, 2026-10-11)

   Joshua's art direction: stylized 3D-animation (Pixar-like). Hard 90-degree
   box edges read as harsh/cheap; a subtle corner radius catches light on
   edges and sells the soft animated look.

   Joshua's scoping rule (2026-10-11): "Some things are supposed to have 90
   degree edges." So this module is SELECTIVE, not global:
     ROUND: vehicle body panels (painted shells, hoods, bumpers, bus bodies)
     KEEP SHARP: buildings (architectural edges), curbs, glass panes, trim,
                 interior parts, and anything else intentionally boxy.
   When in doubt, callers keep the sharp box — Joshua will name anything
   else he wants rounded.

   HOW IT WORKS:
     roundedBoxGeo(w,h,d,radius) builds a rounded box by subdividing a
     BoxGeometry, pulling each vertex toward the nearest point of the inner
     (w-2r,h-2r,d-2r) box onto a sphere of radius r around it, then MERGING
     duplicate vertices so computeVertexNormals() yields SMOOTH normals
     across the rounded edges (without the merge, each face keeps its own
     vertices and the rounding shades faceted — defeating the purpose).
     The bundled three.min.js does not ship BufferGeometryUtils, so the
     merge is hand-rolled here for position+uv (normals are recomputed).

   CACHING (same discipline as #5 in vehicle_meshes.js):
     Every unique (w,h,d,radius) is built ONCE and shared. Cached items
     carry userData.vcached=true — callers must NEVER dispose() them and
     must NEVER mutate the returned geometry (clone + applyMatrix4 first,
     exactly as the v1.49 _vbatch() merge does).

   AUTO-GUARD:
     If the smallest dimension is < 0.09u the part is too thin to round
     (glass panes, trim strips, door skins) — a plain BoxGeometry is
     returned so thin parts keep their crisp edges automatically.
     Requested radius is clamped to 25% of the smallest dimension, so a
     0.14u-thick hood gets r=0.035, never a pillow.

   LOAD ORDER: deferred script with NO data-dkey (always loads, like
   toon_mats.js), placed BEFORE vehicle_meshes.js in index.html. Every call
   site typeof-guards `roundedBoxGeo` and falls back to a sharp box, so a
   missing/slow load can never break the game. Module top-level touches
   nothing but function definitions and the cache object — safe to parse
   before THREE exists; THREE is only touched inside the builder on first
   use (by then three.min.js has always loaded).
   ========================================================================== */
(function(){
"use strict";

/* _rbCache — 'w,h,d,r' -> THREE.BufferGeometry (shared, never disposed). */
var _rbCache={};

/* _rr(v) — round floats for stable cache keys (computed dims like W*1.06). */
function _rr(v){ return Math.round(v*10000)/10000; }

/* _mergeDupVerts(geo) — merge position-duplicate vertices (BoxGeometry keeps
   separate verts per face) and recompute SMOOTH normals. Carries uv through
   (solid colors don't need it, but the v1.49 _vmergeGeos merge expects it).
   Returns a new indexed BufferGeometry. */
function _mergeDupVerts(geo){
  var pos=geo.attributes.position, uvA=geo.attributes.uv;
  var vmap={}, newPos=[], newUv=[], newIdx=[];
  var i, key;
  for(i=0;i<pos.count;i++){
    /* Quantize to 1e-4: true duplicates (shared corners/edges) merge;
       genuinely distinct verts never collide at this scale. */
    key=Math.round(pos.getX(i)*1e4)+','+
        Math.round(pos.getY(i)*1e4)+','+
        Math.round(pos.getZ(i)*1e4);
    var ni=vmap[key];
    if(ni===undefined){
      ni=newPos.length/3; vmap[key]=ni;
      newPos.push(pos.getX(i),pos.getY(i),pos.getZ(i));
      newUv.push(uvA?uvA.getX(i):0, uvA?uvA.getY(i):0);
    }
    newIdx.push(ni);
  }
  var out=new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(newPos,3));
  out.setAttribute('uv',       new THREE.Float32BufferAttribute(newUv,2));
  out.setIndex(newIdx);
  out.computeVertexNormals(); /* smooth across the rounded edges */
  return out;
}

/* _buildRoundedBox(w,h,d,r) — the actual geometry construction. */
function _buildRoundedBox(w,h,d,r){
  /* 2 segments per side: enough verts to describe the rounding, cheap
     enough to share fleet-wide (merged down to ~tens of verts). */
  var geo=new THREE.BoxGeometry(w,h,d,2,2,2);
  var pos=geo.attributes.position;
  var ix=w/2-r, iy=h/2-r, iz=d/2-r; /* inner-box half extents */
  var i, qx,qy,qz, dx,dy,dz, len, s;
  for(i=0;i<pos.count;i++){
    var x=pos.getX(i), y=pos.getY(i), z=pos.getZ(i);
    /* Nearest point on the inner box: */
    qx=Math.max(-ix,Math.min(ix,x));
    qy=Math.max(-iy,Math.min(iy,y));
    qz=Math.max(-iz,Math.min(iz,z));
    dx=x-qx; dy=y-qy; dz=z-qz;
    len=Math.sqrt(dx*dx+dy*dy+dz*dz);
    if(len>1e-9){
      /* Project onto the radius-r sphere around the inner-box point: */
      s=r/len;
      pos.setXYZ(i, qx+dx*s, qy+dy*s, qz+dz*s);
    }
    /* len==0 means the vert is strictly inside the inner box: stays put. */
  }
  pos.needsUpdate=true;
  /* Merge + smooth normals (see _mergeDupVerts doc). The merged geometry
     is what gets cached and shared. */
  var out=_mergeDupVerts(geo);
  geo.dispose();
  return out;
}

/* roundedBoxGeo(w,h,d,radius) — PUBLIC. Cached rounded-box geometry.
   radius default 0.05u (Joshua's expert spec: 0.03–0.06u). Thin parts
   (<0.09u smallest dim) automatically get a sharp BoxGeometry instead.
   Returns a shared cached geometry — NEVER mutate or dispose it. */
function roundedBoxGeo(w,h,d,radius){
  var m=Math.min(w,h,d);
  /* Too thin to round (glass, trim, skins): keep the crisp 90° edge. */
  if(m<0.09 || !(m>0)){
    return new THREE.BoxGeometry(w,h,d);
  }
  var r=radius===undefined?0.05:radius;
  /* Clamp: never more than a quarter of the smallest dimension. */
  r=Math.min(r, m*0.25);
  if(r<0.015){ return new THREE.BoxGeometry(w,h,d); }
  var key='rb:'+_rr(w)+','+_rr(h)+','+_rr(d)+','+_rr(r);
  var g=_rbCache[key];
  if(!g){
    g=_buildRoundedBox(w,h,d,r);
    g.userData.vcached=true; /* #5 discipline: shared, never disposed */
    _rbCache[key]=g;
  }
  return g;
}

/* Export globally (typeof-guarded by callers). */
window.roundedBoxGeo=roundedBoxGeo;
window.__roundedBoxCache=_rbCache; /* introspection / tests */
})();
