/* ============================================================
   PLATFORM-SPLIT FACES — Surviving Adamsville
   Joshua 2026-10-09: APK = detailed 3D sculpted faces (geometry).
   WEB = lightweight texture-painted Lego faces (flat 2D canvas).
   IS_APK detects the native download bridge (APK-only).
   ============================================================ */
var IS_APK = (function(){
  try{ return (typeof window!=='undefined') && (typeof window.AssetDownload!=='undefined'); }
  catch(e){ return false; }
})();

/* ---- WEB: paint a Lego-style face onto a canvas texture ----
   Simple black oval eyes, small nose bump, smiling mouth.
   Returns a THREE.CanvasTexture (or null). */
function paintLegoFaceTexture(){
  try{
    var cv=document.createElement('canvas'); cv.width=64; cv.height=64;
    var g=cv.getContext('2d'); if(!g) return null;
    g.clearRect(0,0,64,64);
    g.fillStyle='#141414';
    g.beginPath(); g.ellipse(22,26,5,7,0,0,Math.PI*2); g.fill();   // left eye
    g.beginPath(); g.ellipse(42,26,5,7,0,0,Math.PI*2); g.fill();   // right eye
    g.fillStyle='#b57a4a';
    g.beginPath(); g.ellipse(32,37,3.5,4.5,0,0,Math.PI*2); g.fill(); // nose
    g.strokeStyle='#5a2f1e'; g.lineWidth=3; g.lineCap='round';
    g.beginPath(); g.arc(32,44,10,0.25*Math.PI,0.75*Math.PI); g.stroke(); // smile
    return new THREE.CanvasTexture(cv);
  }catch(e){ return null; }
}

/* ---- WEB: attach a texture-painted Lego face plane to a head group ----
   headG: THREE.Group, r: head radius, z: forward offset for the plane. */
function addLegoFacePlane(headG, r, z){
  try{
    var tx=paintLegoFaceTexture(); if(!tx) return;
    var m=new THREE.Mesh(new THREE.PlaneGeometry(r*1.35, r*1.35),
      new THREE.MeshBasicMaterial({map:tx, transparent:true}));
    m.position.set(0, 0, z);
    headG.add(m);
  }catch(e){}
}

/* ---- APK: detailed 3D sculpted face (pure geometry) ----
   Eyes (white + iris + pupil + glint), brows, nose (bridge + tip +
   nostrils), smiling mouth tube. headG: group, r: head radius,
   mSkin/mHair: THREE materials. */
function buildFace3D(headG, r, mSkin, mHair){
  try{
    function LM(c){ return new THREE.MeshLambertMaterial({color:c}); }
    var mWhite=LM(0xffffff), mIris=LM(0x6b3a1a), mPupil=LM(0x0a0a0a),
        mDark=LM(0x241a10), mLip=LM(0x7a4438);
    function put(m,x,y,z){ m.position.set(x,y,z); headG.add(m); return m; }
    function sph(s,mt,x,y,z,sg){
      var m=new THREE.Mesh(new THREE.SphereGeometry(s,sg||12,10),mt);
      return put(m,x,y,z);
    }
    [-1,1].forEach(function(s){
      var ex=s*0.36*r, ey=0.16*r, ez=0.86*r;
      var white=sph(0.20*r,mWhite,ex,ey,ez,14); white.scale.set(1,1.12,0.62);
      var iris=sph(0.105*r,mIris,ex,ey,ez+0.104*r,12); iris.scale.set(1,1.12,0.45);
      var pup=sph(0.055*r,mPupil,ex,ey,ez+0.136*r,10); pup.scale.set(1,1.15,0.40);
      sph(0.026*r,mWhite,ex-0.035*r,ey+0.045*r,ez+0.155*r,8);       // glint
      var brow=sph(0.13*r,mHair,s*0.37*r,0.47*r,0.79*r,8);          // brow
      brow.scale.set(1,0.35,0.5);
    });
    var bridge=sph(0.06*r,mSkin,0,0.03*r,0.95*r,8);                 // nose bridge
    bridge.scale.set(0.7,1.6,0.7);
    var tip=sph(0.105*r,mSkin,0,-0.10*r,1.00*r,12);                 // nose tip
    tip.scale.set(1.18,0.88,0.92);
    [-1,1].forEach(function(s){                                     // nostrils
      sph(0.032*r,mDark,s*0.068*r,-0.175*r,0.962*r,8);
    });
    var zc=0.90*r;                                                 // smile
    var curve=new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.27*r,-0.345*r,zc),
      new THREE.Vector3(0,-0.405*r,zc+0.012*r),
      new THREE.Vector3(0.27*r,-0.345*r,zc)]);
    headG.add(new THREE.Mesh(new THREE.TubeGeometry(curve,14,0.026*r,8),mLip));
  }catch(e){}
}
