/* ============================================================================
   toon_mats.js — shared Pixar-style material palettes
   (expert report #18 — Aria Nakamura, Technical Artist, 30+ yrs, 2026-10-11)

   Joshua's art direction: stylized 3D-animation (Pixar-like) for ALL
   characters. Lambert-only shading reads matte/chalky with zero specular
   response, so this module provides:

     CHARACTERS  -> MeshToonMaterial  (stepped toon shading via a 4-tone
                   gradient map — the soft cel look Pixar-style needs)
     VEHICLE PAINT -> MeshPhongMaterial (specular sheen on bodywork)
     VEHICLE GLASS -> MeshPhongMaterial (hot specular = reflective windows)
     TERRAIN       -> stays MeshLambertMaterial (matte is correct for ground;
                   untouched by this module)

   Every helper is cached per color — ONE material instance per unique
   color, shared fleet-wide (same discipline as vehMat() in
   vehicle_meshes.js, which now delegates here). This keeps the TCL's GPU
   happy: no per-spawn material churn.

   Load order: this file is a deferred script with NO data-dkey, placed
   right after three.min.js, so it always loads before npc_system.js,
   vehicle_meshes.js, shirt_designs.js and the hero builder. Every call
   site ALSO typeof-guards the helpers and falls back to Lambert, so a
   missing/slow load can never break the game.
   ============================================================================ */
(function(){
"use strict";

/* toonGradient() — 4-tone gradient map for MeshToonMaterial.
   RGBA so the shader's `.rgb` sample works on every three.js version;
   NearestFilter gives hard toon steps instead of a smooth ramp.
   Tones: shadow -> mid-shadow -> mid-light -> full light. */
var __toonGrad=null;
function toonGradient(){
  if(__toonGrad) return __toonGrad;
  try{
    var tones=[110,160,215,255], data=new Uint8Array(16), i;
    for(i=0;i<4;i++){
      data[i*4]=tones[i]; data[i*4+1]=tones[i];
      data[i*4+2]=tones[i]; data[i*4+3]=255;
    }
    var tex=new THREE.DataTexture(data,4,1,THREE.RGBAFormat);
    tex.minFilter=THREE.NearestFilter;
    tex.magFilter=THREE.NearestFilter;
    tex.needsUpdate=true;
    __toonGrad=tex;
  }catch(e){ __toonGrad=null; }
  return __toonGrad;
}

var _toonCache={};
/* toonMat(color) — cached MeshToonMaterial for characters (hero, NPCs,
   faces, shirts). Falls back to Lambert if toon is unavailable. */
window.toonMat=function(color){
  var key='t'+color;
  if(_toonCache[key]) return _toonCache[key];
  var m=null;
  try{
    m=new THREE.MeshToonMaterial({color:color, gradientMap:toonGradient()});
  }catch(e){
    try{ m=new THREE.MeshLambertMaterial({color:color}); }catch(e2){ m=null; }
  }
  if(m) _toonCache[key]=m;
  return m;
};

/* toonMatMap(tex,color) — toon material carrying a texture map
   (shirt fronts from shirt_designs.js). Not cached: each shirt texture
   is unique per design. */
window.toonMatMap=function(tex,color){
  var m=null;
  try{
    m=new THREE.MeshToonMaterial({
      map:tex,
      color:(color===undefined?0xffffff:color),
      gradientMap:toonGradient()
    });
  }catch(e){
    try{ m=new THREE.MeshLambertMaterial({map:tex}); }catch(e2){ m=null; }
  }
  return m;
};

var _paintCache={};
/* vehPaintMat(color) — cached MeshPhongMaterial for vehicle bodywork.
   Modest specular (0x555555) + shininess 70: showroom sheen, not chrome.
   Dark colors (tires/trim) pick up only a faint highlight — safe. */
window.vehPaintMat=function(color){
  var key='p'+color;
  if(_paintCache[key]) return _paintCache[key];
  var m=null;
  try{
    m=new THREE.MeshPhongMaterial({color:color, shininess:70, specular:0x555555});
  }catch(e){
    try{ m=new THREE.MeshLambertMaterial({color:color}); }catch(e2){ m=null; }
  }
  if(m) _paintCache[key]=m;
  return m;
};

var _glassCache={};
/* vehGlassMat(color) — cached MeshPhongMaterial for vehicle glass.
   High shininess (140) + cool specular (0xaaccdd) = reflective windows
   that catch the sun. Opaque (no transparency sort issues). */
window.vehGlassMat=function(color){
  var key='g'+color;
  if(_glassCache[key]) return _glassCache[key];
  var m=null;
  try{
    m=new THREE.MeshPhongMaterial({color:color, shininess:140, specular:0xaaccdd});
  }catch(e){
    try{ m=new THREE.MeshLambertMaterial({color:color}); }catch(e2){ m=null; }
  }
  if(m) _glassCache[key]=m;
  return m;
};

/* vehGlassTMat() — transparent glass variant (windows you see through),
   Phong-based so it still catches specular highlights. */
var _glassT=null;
window.vehGlassTMat=function(){
  if(_glassT) return _glassT;
  try{
    _glassT=new THREE.MeshPhongMaterial({
      color:0x8fb4cc, transparent:true, opacity:0.45,
      shininess:140, specular:0xaaccdd
    });
  }catch(e){
    try{ _glassT=new THREE.MeshLambertMaterial({color:0x8fb4cc, transparent:true, opacity:0.45}); }
    catch(e2){ _glassT=null; }
  }
  return _glassT;
};
})();
