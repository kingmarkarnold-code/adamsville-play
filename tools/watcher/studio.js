/* Adamsville Watcher — Character Studio.
   3D preview + parametric editing for the hero and the 3 NPC archetypes.
   Parametric = sliders adjust the model's numbers (lengths/widths), not mesh
   sculpting. The JSON recipe from "Submit character feedback" is what Muse
   rebuilds verbatim in the game code. three.min.js lazy-loads on first open; nothing here touches the 2D/3D map views. */
window.Studio = (function () {
  'use strict';

  /* ---------- palettes from npc_system.js ---------- */
  var SKINS  = [0x4a2f1c,0x5a3a24,0x6b4429,0x7d5230,0x8a5f36,0x93683c,0xa07a48];
  var SHIRTS = [0xc23b2e,0x2e5fa3,0x2e8b57,0xe0e0e0,0xe8b923,0x1f8a8a,0xd96c2c,
                0x7b4fa3,0x555c66,0x222226,0xb03060,0x3a7d44,0xc7c7c7,0x8a2be2];
  var PANTS  = [0x2e4a6b,0x1f2a3a,0x141414,0x9a8a6a,0x5a4632,0x666c75,0x3b3f4a];
  function hx(n){ var s=n.toString(16); while(s.length<6) s='0'+s; return '#'+s; }

  /* ---------- archetype defaults (stylized 3D-animation proportions) ----------
     headSize is a true radius now. Hero default matches the portrait:
     large expressive head (~1:4 head-to-body, Pixar-like). */
  var ARCH = {
    hero:  { label:'Main Character', kind:'hero',
      def:{ headSize:0.21, torsoW:0.44, torsoH:0.50, torsoD:0.26,
            shoulderW:0.47, hipW:0.34,
            upperArm:0.30, forearm:0.28, armW:0.11, shoulderX:0.28,
            thigh:0.40, shin:0.40, legW:0.15, hipX:0.11, shoeH:0.10,
            heightScale:1.0, hairStyle:'cap',
            colors:{skin:'#8a5a33',shirt:'#c23b2e',pants:'#2e4a6b',shoes:'#f2f2f2',hair:'#16110c'} } },
    man:   { label:'Adult Man', kind:'npc',
      def:{ headSize:0.15, torsoW:0.42, torsoH:0.55, torsoD:0.26,
            shoulderW:0.42, hipW:0.30,
            upperArm:0.29, forearm:0.29, armW:0.11, shoulderX:0.265,
            thigh:0.33, shin:0.33, legW:0.15, hipX:0.115, shoeH:0.0,
            heightScale:1.0, hairStyle:'cap',
            colors:{skin:'#7d5230',shirt:'#2e5fa3',pants:'#1f2a3a',shoes:'#222226',hair:'#16110c'} } },
    woman: { label:'Adult Woman', kind:'npc',
      def:{ headSize:0.14, torsoW:0.37, torsoH:0.55, torsoD:0.24,
            shoulderW:0.37, hipW:0.30,
            upperArm:0.28, forearm:0.28, armW:0.10, shoulderX:0.25,
            thigh:0.34, shin:0.34, legW:0.13, hipX:0.11, shoeH:0.0,
            heightScale:1.0, hairStyle:'long',
            colors:{skin:'#93683c',shirt:'#b03060',pants:'#141414',shoes:'#222226',hair:'#0a0805'} } },
    boy16: { label:'16-Year-Old Boy', kind:'npc',
      def:{ headSize:0.135, torsoW:0.38, torsoH:0.50, torsoD:0.24,
            shoulderW:0.38, hipW:0.28,
            upperArm:0.26, forearm:0.26, armW:0.10, shoulderX:0.24,
            thigh:0.30, shin:0.30, legW:0.13, hipX:0.105, shoeH:0.0,
            heightScale:0.85, hairStyle:'cap',
            colors:{skin:'#6b4429',shirt:'#2e8b57',pants:'#2e4a6b',shoes:'#222226',hair:'#0a0805'} } }
  };
  var ORDER = ['hero','man','woman','boy16'];

  /* ---------- Reference NPC presets — Joshua's uploaded photos, all aged ~16 ----------
     Photo order: MECCA man (photo 1 left), Flag man (photo 1 right), parking-lot woman,
     indoor bearded man, indoor dreads man, bun girl, puppy photo, purple portrait.
     One-click loads. 16 is the floor: NOBODY under 16. Males use the boy16 base;
     females use the woman base scaled to 16 (shorter, slimmer, larger head).
     Glasses/beards/headbands/dreadlocks are noted for future geometry — the
     preset captures everything the parametric system can express today. */
  var REFNPC = [
    { name:'MECCA shirt man', photo:'refphotos/1663_0_kbz7.jpg', sub:'heavier build, short hair',
      arch:'boy16', hairStyle:'cap',
      params:{ headSize:0.15, torsoW:0.50, torsoH:0.54, torsoD:0.34,
               shoulderW:0.46, hipW:0.36, upperArm:0.28, forearm:0.28,
               armW:0.13, shoulderX:0.27, thigh:0.32, shin:0.32,
               legW:0.17, hipX:0.12, heightScale:0.92 },
      colors:{ skin:'#4a2f1c', shirt:'#6b4a2e', pants:'#1f2a3a', shoes:'#222226', hair:'#0a0805' },
      notes:'Reference NPC — heavier man in the brown MECCA shirt, flag photo. Aged to 16.' },
    { name:'Flag photo man', photo:'refphotos/1661_5_jvof.jpg', sub:'glasses, goatee, slim — in 4 photos',
      arch:'boy16', hairStyle:'cap',
      params:{ headSize:0.14, torsoW:0.37, torsoH:0.50, torsoD:0.24,
               shoulderW:0.38, hipW:0.28, upperArm:0.26, forearm:0.26,
               armW:0.10, shoulderX:0.24, thigh:0.30, shin:0.30,
               legW:0.13, hipX:0.105, heightScale:0.88 },
      colors:{ skin:'#5a3a24', shirt:'#e8b923', pants:'#2e4a6b', shoes:'#222226', hair:'#0a0805' },
      notes:'Reference NPC — shirtless man from the flag photo (also parking lot, doorway, van). Wears glasses; light goatee. Aged to 16.' },
    { name:'Yellow shirt woman', photo:'refphotos/1659_1_s263.jpg', sub:'long black hair, parking lot photo',
      arch:'woman', hairStyle:'long',
      params:{ headSize:0.15, torsoW:0.38, torsoH:0.52, torsoD:0.25,
               upperArm:0.26, forearm:0.26, armW:0.10, shoulderX:0.24,
               thigh:0.31, shin:0.31, legW:0.13, hipX:0.11, heightScale:0.85 },
      colors:{ skin:'#7d5230', shirt:'#e8b923', pants:'#141414', shoes:'#222226', hair:'#0a0805' },
      notes:'Reference NPC — woman in yellow, parking lot photo next to the flag-photo man. Long black hair; sunglasses on head. Aged to 16.' },
    { name:'Bearded cap man', photo:'refphotos/1657_2_stvp.jpg', sub:'full beard, black cap, indoor photo',
      arch:'boy16', hairStyle:'cap',
      params:{ headSize:0.145, torsoW:0.42, torsoH:0.52, torsoD:0.27,
               shoulderW:0.42, hipW:0.31, upperArm:0.27, forearm:0.27,
               armW:0.11, shoulderX:0.255, thigh:0.31, shin:0.31,
               legW:0.14, hipX:0.11, heightScale:0.89 },
      colors:{ skin:'#4a2f1c', shirt:'#2e5fa3', pants:'#1f2a3a', shoes:'#222226', hair:'#0a0805' },
      notes:'Reference NPC — bearded man with black cap, indoor photo. Full beard and cap; beard not in geometry yet. Aged to 16.' },
    { name:'Dreadlocks man', photo:'refphotos/1657_2_stvp.jpg', sub:'shoulder dreads, white tee, indoor photo',
      arch:'boy16', hairStyle:'long',
      params:{ headSize:0.14, torsoW:0.36, torsoH:0.50, torsoD:0.24,
               shoulderW:0.37, hipW:0.28, upperArm:0.26, forearm:0.26,
               armW:0.095, shoulderX:0.235, thigh:0.30, shin:0.30,
               legW:0.125, hipX:0.105, heightScale:0.87 },
      colors:{ skin:'#6b4429', shirt:'#e0e0e0', pants:'#9a8a6a', shoes:'#222226', hair:'#0a0805' },
      notes:'Reference NPC — man with shoulder-length dreadlocks (brown tips), indoor photo. Dreads approximated with long hair. Aged to 16.' },
    { name:'Headband bun girl', photo:'refphotos/1658_3_iywu.jpg', sub:'high bun + headband, light blue top',
      arch:'woman', hairStyle:'cap',
      params:{ headSize:0.15, torsoW:0.34, torsoH:0.50, torsoD:0.23,
               upperArm:0.25, forearm:0.25, armW:0.095, shoulderX:0.23,
               thigh:0.30, shin:0.30, legW:0.125, hipX:0.105, heightScale:0.84 },
      colors:{ skin:'#7d5230', shirt:'#9fc3e0', pants:'#2e4a6b', shoes:'#222226', hair:'#0a0805' },
      notes:'Reference NPC — girl with high bun and headband. Bun approximated; headband not in geometry yet. Aged to 16.' },
    { name:'Puppy photo', photo:'refphotos/1664_6_65jl.jpg', sub:'short hair, big smile — different person',
      arch:'boy16', hairStyle:'cap',
      params:{ headSize:0.15, torsoW:0.38, torsoH:0.50, torsoD:0.25,
               shoulderW:0.39, hipW:0.29, upperArm:0.26, forearm:0.26,
               armW:0.10, shoulderX:0.24, thigh:0.30, shin:0.30,
               legW:0.13, hipX:0.105, heightScale:0.86 },
      colors:{ skin:'#6b4429', shirt:'#2e5fa3', pants:'#2e4a6b', shoes:'#222226', hair:'#0a0805' },
      notes:'Reference NPC — the person holding the puppy (a different person, per Joshua). Short hair, big smile. Aged to 16.' },
    { name:'Purple portrait woman', photo:'refphotos/1665_7_71ti.jpg', sub:'short hair, warm smile, studio portrait',
      arch:'woman', hairStyle:'cap',
      params:{ headSize:0.15, torsoW:0.40, torsoH:0.52, torsoD:0.26,
               upperArm:0.26, forearm:0.26, armW:0.10, shoulderX:0.24,
               thigh:0.31, shin:0.31, legW:0.135, hipX:0.11, heightScale:0.85 },
      colors:{ skin:'#8a5f36', shirt:'#7b4fa3', pants:'#141414', shoes:'#222226', hair:'#0a0805' },
      notes:'Reference NPC — woman in the purple top, studio portrait. Short black hair, warm smile. Aged to 16.' }
  ];
  function loadPreset(i){
    var pr=REFNPC[i]; if(!pr) return;
    cur=pr.arch; sliderEls={}; colorEls={};
    P=clone(ARCH[pr.arch].def);
    Object.keys(pr.params).forEach(function(k){ P[k]=pr.params[k]; });
    Object.keys(pr.colors).forEach(function(k){ P.colors[k]=pr.colors[k]; });
    P.hairStyle=pr.hairStyle; P.notes=pr.notes;
    buildPanel(); rebuild(); fitCamera();
    if(savedMsg){ savedMsg.textContent='Loaded: '+pr.name+' ✓';
      setTimeout(function(){ if(savedMsg) savedMsg.textContent=''; },2500); }
  }

  /* ---------- reference-NPC review queue: one person at a time, approve-or-flag ----
     "Needs changes" flags the character and focuses the note field so Joshua can
     say what to fix. "Save & next" approves (or records the flag + note), saves
     the recipe to localStorage, and advances. Progress persists across refreshes. */
  var rq={active:false,i:0,flagged:false,results:[]};
  function rqSave(){ try{localStorage.setItem('aw_studio_rq',
    JSON.stringify({i:rq.i,results:rq.results}));}catch(e){} }
  /* custom character names persist across sessions */
  function nameSave(){ try{
    var names={}; REFNPC.forEach(function(p,i){ names[i]=p.name; });
    localStorage.setItem('aw_refnpc_names', JSON.stringify(names));
  }catch(e){} }
  function nameLoad(){ try{
    var s=JSON.parse(localStorage.getItem('aw_refnpc_names')||'null');
    if(s) REFNPC.forEach(function(p,i){ if(s[i]) p.name=s[i]; });
  }catch(e){} }
  nameLoad();
  function rqLoadState(){ try{var s=JSON.parse(localStorage.getItem('aw_studio_rq')||'null');
    if(s){ rq.i=Math.min(s.i||0,REFNPC.length-1); rq.results=s.results||[]; } }catch(e){} }
  function rqStart(){
    if(rq.results.length>=REFNPC.length){ rq.results=[]; rq.i=0; } // fresh pass
    rq.active=true; rq.flagged=false; rqSave(); loadPreset(rq.i);
  }
  function rqFlag(){ rq.flagged=true; rqPaint();
    if(notesEl){ notesEl.focus();
      try{notesEl.scrollIntoView({block:'center',behavior:'smooth'});}catch(e){} } }
  function rqSubmitResults(){
    if(!rq.results.length) return;
    var md='# Reference NPC review results — '+rq.results.length+' reviewed\n\n';
    rq.results.forEach(function(r,i){
      md+='## '+(i+1)+'. '+r.name+' — '+r.status.toUpperCase()+'\n';
      if(r.note) md+='Note: '+r.note+'\n';
      md+='```json\n'+JSON.stringify(r.recipe,null,1)+'\n```\n\n';
    });
    submitFeedback('Reference NPC review — '+rq.results.length+' done', md, 'character-feedback');
  }
  function rqPaint(){
    var body=document.getElementById('rqbody'); if(!body) return;
    body.innerHTML='';
    if(!rq.active){
      var done=rq.results.length;
      body.appendChild(el('div','chint', done>=REFNPC.length
        ? 'Review complete — '+done+' of '+REFNPC.length+' done.'
        : 'Work through each person from your photos, one at a time: approve them or flag what needs changing.'));
      var row=el('div','brow');
      var b=el('button','cbtn', done? ('▶ Resume review ('+Math.min(done+1,REFNPC.length)+' of '+REFNPC.length+')')
                                   : ('▶ Start review ('+REFNPC.length+' people)'));
      b.addEventListener('click',rqStart); row.appendChild(b);
      if(done){ var r2=el('button','cbtn','↺ Restart');
        r2.addEventListener('click',function(){ rq.i=0; rq.results=[]; rqSave(); rqStart(); });
        row.appendChild(r2);
        var bSub=el('button','cbtn','📤 Submit results');
        bSub.addEventListener('click',rqSubmitResults);
        row.appendChild(bSub); }
      body.appendChild(row); return;
    }
    var pr=REFNPC[rq.i];
    var top=el('div',''); top.style.cssText='display:flex;gap:10px;align-items:flex-start;margin-bottom:8px;';
    if(pr.photo){
      var img=document.createElement('img'); img.src=pr.photo;
      img.style.cssText='width:110px;height:110px;object-fit:cover;border-radius:10px;border:1px solid #2c384a;';
      img.alt='Reference photo'; top.appendChild(img);
    }
    var nmwrap=el('div','');
    nmwrap.appendChild(el('div','chint','<b>Person '+(rq.i+1)+' of '+REFNPC.length+'</b><br>'+pr.sub));
    var nmlab=el('label','','Character name: ');
    var nminp=document.createElement('input'); nminp.type='text'; nminp.value=pr.name;
    nminp.style.cssText='background:#141b28;color:#fff;border:1px solid #2c384a;border-radius:8px;padding:6px 10px;font-size:14px;width:180px;';
    nminp.addEventListener('input',function(){ pr.name=nminp.value; nameSave(); });
    nmlab.appendChild(nminp); nmwrap.appendChild(nmlab);
    top.appendChild(nmwrap); body.appendChild(top);
    var row2=el('div','brow');
    var bF=el('button','cbtn','⚠ Needs changes'); bF.addEventListener('click',rqFlag);
    var bS=el('button','cbtn','💾 Save name & outfit'); bS.addEventListener('click',function(){
      nameSave();
      var rec=recipe();
      try{ localStorage.setItem('aw_refnpc_saved_'+rq.i, JSON.stringify({name:pr.name, recipe:rec})); }catch(e){}
      /* push to GitHub so Muse gets notified */
      var md='# Character saved: '+pr.name+'\n\nPhoto ref: '+(pr.photo||'n/a')+'\n'+
        'Outfit: shirt '+rec.colors.shirt+', pants '+rec.colors.pants+', hair '+rec.hairStyle+'\n\n'+
        '```json\n'+JSON.stringify(rec,null,1)+'\n```';
      submitFeedback('Character saved — '+pr.name, md, 'character-feedback');
      if(savedMsg){ savedMsg.textContent='Saved: '+pr.name+' ✓ — sent to GitHub'; setTimeout(function(){ if(savedMsg) savedMsg.textContent=''; },4000); }
    });
    var bN=el('button','cbtn','✓ Save & next →'); bN.addEventListener('click',rqSaveNext);
    var bQ=el('button','cbtn','✕ stop'); bQ.addEventListener('click',function(){ rq.active=false; rqSave(); rqPaint(); });
    row2.appendChild(bF); row2.appendChild(bS); row2.appendChild(bN); row2.appendChild(bQ);
    body.appendChild(row2);
    if(rq.flagged) body.appendChild(el('div','chint',
      'Flagged for revision — describe what to change in "Suggest changes" below, then press Save & next.'));
  }
  function rqSaveNext(){
    var pr=REFNPC[rq.i]; if(!pr){ rq.active=false; rqPaint(); return; }
    rq.results.push({ name:pr.name, sub:pr.sub, status:rq.flagged?'flagged':'approved',
      note:(notesEl?notesEl.value:''), recipe:recipe() });
    try{ localStorage.setItem('aw_refnpc_saved', JSON.stringify(rq.results)); }catch(e){}
    rq.i++; rq.flagged=false;
    if(rq.i>=REFNPC.length){
      rq.active=false; rq.i=0; rqSave(); buildPanel();
      var ap=rq.results.filter(function(r){return r.status==='approved';}).length;
      if(savedMsg) savedMsg.textContent='Review complete ✓ — '+ap+' approved, '+(rq.results.length-ap)+' flagged for changes.';
      return;
    }
    rqSave(); loadPreset(rq.i);
  }

  /* ---------- slider definitions ---------- */
  var SLIDERS = [
    {k:'headSize', g:'Head', t:'Head size', min:0.10, max:0.30, step:0.005},
    {k:'torsoW', g:'Torso', t:'Torso width', min:0.30, max:0.60, step:0.01},
    {k:'torsoH', g:'Torso', t:'Torso height', min:0.35, max:0.70, step:0.01},
    {k:'torsoD', g:'Torso', t:'Torso depth', min:0.18, max:0.40, step:0.01},
    {k:'shoulderW', g:'Torso', t:'Shoulder bar width', min:0.30, max:0.65, step:0.01, heroOnly:1},
    {k:'hipW', g:'Torso', t:'Hip width', min:0.24, max:0.50, step:0.01, heroOnly:1},
    {k:'upperArm', g:'Arms', t:'Upper arm length', min:0.15, max:0.45, step:0.01},
    {k:'forearm', g:'Arms', t:'Forearm length', min:0.15, max:0.45, step:0.01},
    {k:'armW', g:'Arms', t:'Arm width', min:0.08, max:0.16, step:0.005},
    {k:'shoulderX', g:'Arms', t:'Shoulder spacing', min:0.20, max:0.36, step:0.005},
    {k:'thigh', g:'Legs', t:'Thigh length', min:0.25, max:0.55, step:0.01},
    {k:'shin', g:'Legs', t:'Shin length', min:0.25, max:0.55, step:0.01},
    {k:'legW', g:'Legs', t:'Leg width', min:0.10, max:0.22, step:0.005},
    {k:'hipX', g:'Legs', t:'Hip spacing', min:0.08, max:0.18, step:0.005},
    {k:'shoeH', g:'Legs', t:'Shoe height', min:0.06, max:0.16, step:0.01, heroOnly:1},
    {k:'heightScale', g:'Body', t:'Overall height', min:0.75, max:1.25, step:0.01}
  ];
  var COLORS = [
    {k:'skin', t:'Skin', pal:SKINS},
    {k:'shirt', t:'Shirt', pal:SHIRTS},
    {k:'pants', t:'Pants', pal:PANTS},
    {k:'shoes', t:'Shoes', pal:null, heroOnly:1},
    {k:'hair', t:'Hair', pal:null}
  ];

  /* ---------- state ---------- */
  var loaded=false, loading=null, running=false;
  var renderer, scene, camera, fig=null, spin=false;
  var yaw=0.55, pitch=0.10, dist=4.4, tgtY=1.0;
  var cur='hero';
  var P=null;          // live params for current archetype
  var sliderEls={}, colorEls={}, notesEl=null, savedMsg=null;

  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function lsKey(a){ return 'aw_studio_'+a; }

  function loadScript(src){
    return new Promise(function (res, rej){
      var s=document.createElement('script'); s.src=src;
      s.onload=res; s.onerror=function(){rej(new Error('load '+src));};
      document.head.appendChild(s);
    });
  }

  /* ---------- figure builders ---------- */
  function L(c){ return new THREE.MeshLambertMaterial({color:c}); }
  function box(w,h,d,mt,x,y,z){
    var m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mt);
    m.position.set(x,y,z); return m;
  }
  /* ---- stylized-3D-animation helpers (smooth, no boxes on bodies) ---- */
  function ball(r,mt,x,y,z,seg){
    var m=new THREE.Mesh(new THREE.SphereGeometry(r,seg||18,14),mt);
    m.position.set(x||0,y||0,z||0); return m;
  }
  function ell(rx,ry,rz,mt,x,y,z){
    var m=new THREE.Mesh(new THREE.SphereGeometry(1,20,14),mt);
    m.scale.set(rx,ry,rz); m.position.set(x||0,y||0,z||0); return m;
  }
  function capsule(r,len,mt,x,y,z,axis){
    // smooth limb along Y (axis 'x' lays it along X); total height len+2r
    var g=new THREE.Group();
    var cyl=new THREE.Mesh(new THREE.CylinderGeometry(r,r,len,14),mt); g.add(cyl);
    g.add(ball(r,mt,0,len/2,0,14)); g.add(ball(r,mt,0,-len/2,0,14));
    if(axis==='x') g.rotation.z=Math.PI/2;
    g.position.set(x||0,y||0,z||0); return g;
  }
  /* ---- stylized hand: ONE merged mesh (palm + 4 fingers + thumb) ----
     "Four and a thumb", smooth 3D-animation style. Canonical space: wrist
     at origin, -Y down, +Z forward, 1 unit = armW. RIGHT hand is built;
     hgMirrorX() gives the exact LEFT hand. Mesh is scaled by armW. */
  function hgMerge(geos){
    var vC=0,iC=0,i,g;
    for(i=0;i<geos.length;i++){ g=geos[i];
      vC+=g.attributes.position.count; iC+=g.index.count; }
    var pos=new Float32Array(vC*3), nor=new Float32Array(vC*3),
        uv=new Float32Array(vC*2),
        idx=new (vC>65535?Uint32Array:Uint16Array)(iC);
    var vo=0,io=0,j;
    for(i=0;i<geos.length;i++){ g=geos[i];
      pos.set(g.attributes.position.array,vo*3);
      nor.set(g.attributes.normal.array,vo*3);
      uv.set(g.attributes.uv.array,vo*2);
      var gi=g.index.array;
      for(j=0;j<gi.length;j++) idx[io+j]=gi[j]+vo;
      vo+=g.attributes.position.count; io+=gi.length; }
    var out=new THREE.BufferGeometry();
    out.setAttribute('position',new THREE.BufferAttribute(pos,3));
    out.setAttribute('normal',new THREE.BufferAttribute(nor,3));
    out.setAttribute('uv',new THREE.BufferAttribute(uv,2));
    out.setIndex(new THREE.BufferAttribute(idx,1));
    return out;
  }
  function hgX(geo,x,y,z,sx,sy,sz,rx,rz){
    var m=new THREE.Matrix4().makeRotationX(rx||0)
      .multiply(new THREE.Matrix4().makeRotationZ(rz||0));
    m.scale(new THREE.Vector3(sx==null?1:sx,sy==null?1:sy,sz==null?1:sz));
    m.setPosition(x,y,z);
    var c=geo.clone(); c.applyMatrix4(m); return c;
  }
  function hgFinger(r,len){
    var cyl=new THREE.CylinderGeometry(r*0.72,r,len,10); cyl.translate(0,-len/2,0);
    var tip=new THREE.SphereGeometry(r*0.72,10,8); tip.translate(0,-len,0);
    return hgMerge([cyl,tip]);
  }
  function hgMirrorX(geo){
    var c=geo.clone();
    c.applyMatrix4(new THREE.Matrix4().makeScale(-1,1,1));
    var idx=c.index.array,i,t;
    for(i=0;i<idx.length;i+=3){ t=idx[i+1]; idx[i+1]=idx[i+2]; idx[i+2]=t; }
    c.index.needsUpdate=true; c.computeBoundingSphere();
    return c;
  }
  function buildHandGeo(){
    var parts=[], i;
    parts.push(hgX(new THREE.SphereGeometry(1,14,10), 0,-0.55,0, 0.52,0.62,0.30)); // palm
    var fl=[0.56,0.66,0.62,0.50];                       // index..pinky
    for(i=0;i<4;i++)
      parts.push(hgX(hgFinger(0.145,fl[i]),
        (i-1.5)*0.30,-1.02,0.03,  1,1,1,  -0.14,(i-1.5)*-0.05)); // fingers
    parts.push(hgX(hgFinger(0.16,0.55),
      -0.50,-0.52,0.10,  1,1,1,  -0.20,0.75));          // thumb
    return hgMerge(parts);
  }
  function buildHand3D(mSkin, armW, side){
    // Origin at the wrist; caller positions it. side -1/+1 = left/right.
    var base=buildHandGeo();
    var geo=side<0?hgMirrorX(base):base;
    if(side<0) base.dispose();
    var mesh=new THREE.Mesh(geo,mSkin);
    mesh.scale.setScalar(armW);
    return mesh;
  }
  function hairFor(headG, r, style, mHair, headH){
    if(style==='none') return;
    if(style==='long'){  // smooth back panel down past shoulders
      headG.add(ell(r*0.95, headH*0.5+r*0.6, r*0.55, mHair, 0, -r*0.7, -r*0.72));
    }
    var cap=new THREE.Mesh(
      new THREE.SphereGeometry(r*1.06,20,12,0,Math.PI*2,0,Math.PI*0.52), mHair);
    cap.position.y=r*0.12; cap.rotation.x=-0.38; headG.add(cap);
  }

  /* ---- LEGO-style 3D face: pure geometry, ultra-simple ----
     Joshua 2026-10-09: "just eyes nose and a mouth" like Lego minifigures.
     Two simple black oval eyes, a small nose bump, a smiling mouth curve.
     No iris/pupil/glint, no brows, no nostrils. Units are fractions of
     head radius r; head sphere centered at origin. */
  function sculptFace3D(headG, r, mSkin, mHair){
    var mBlack=L(0x141414), mLip=L(0x7a4438);
    function put(m,x,y,z){ m.position.set(x,y,z); headG.add(m); return m; }
    [-1,1].forEach(function(s){
      var eye=put(ball(0.085*r,mBlack,0,0,0,10),s*0.32*r,0.14*r,0.88*r);  // eye
      eye.scale.set(1,1.35,0.5);
    });
    var nose=put(ball(0.075*r,mSkin,0,0,0,10),0,-0.06*r,0.97*r);        // nose
    nose.scale.set(1,0.9,0.8);
    var zc=0.90*r;                                                       // smile
    var curve=new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.24*r,-0.30*r,zc),
      new THREE.Vector3(0,-0.36*r,zc+0.012*r),
      new THREE.Vector3(0.24*r,-0.30*r,zc)]);
    headG.add(new THREE.Mesh(new THREE.TubeGeometry(curve,12,0.024*r,8),mLip));
  }

  /* Stylized 3D-animation hero: big expressive head (portrait proportions),
     rounded torso/limbs, smooth shading. Pivot hierarchy matches the game
     rig exactly (hips/headG/armL+armR{sh,el}/legL+legR{hp,kn}) so walk
     animation transfers 1:1. */
  function buildHero(p){
    var c=p.colors;
    var mSkin=L(c.skin), mShirt=L(c.shirt), mPants=L(c.pants),
        mShoe=L(c.shoes), mHair=L(c.hair);
    var g=new THREE.Group();
    var hipY=p.thigh+p.shin+p.shoeH+0.02;
    var hips=new THREE.Group(); hips.position.y=hipY; g.add(hips);
    hips.add(ell(p.hipW/2,0.11,p.hipW*0.33,mPants,0,0.03,0));            // pelvis
    var torsoY=0.12+p.torsoH/2;
    hips.add(ell(p.torsoW/2,p.torsoH/2,p.torsoD/2,mShirt,0,torsoY,0));   // torso
    hips.add(capsule(p.torsoD/2+0.01,p.shoulderW,mShirt,0,0.10+p.torsoH,0,'x')); // shoulders
    hips.add(capsule(0.055,0.10,mSkin,0,0.10+p.torsoH+0.03,0));          // neck
    // head — large, stylized
    var headG=new THREE.Group();
    headG.position.y=0.10+p.torsoH+0.10+p.headSize*0.92; hips.add(headG);
    headG.add(ball(p.headSize,mSkin,0,0,0,26));
    hairFor(headG,p.headSize,p.hairStyle,mHair,p.headSize*2);
    sculptFace3D(headG,p.headSize,mSkin,mHair);   // pure 3D face, no 2D plane
    [-1,1].forEach(function(s){                                          // ears
      var ear=ball(p.headSize*0.22,mSkin,p.headSize*0.98*s,-p.headSize*0.05,0,12);
      ear.scale.set(0.45,1,0.7); headG.add(ear);
    });
    // arms: shoulder pivot -> upper arm -> elbow pivot -> forearm + hand
    var armL=null, armR=null;
    [-1,1].forEach(function(s){
      var shY=0.10+p.torsoH-0.04;
      var sh=new THREE.Group(); sh.position.set(p.shoulderX*s,shY,0); hips.add(sh);
      sh.add(ball(p.armW*0.62,mShirt,0,0,0,14));                        // deltoid
      sh.add(capsule(p.armW/2,p.upperArm,mShirt,0,-p.upperArm/2,0));     // sleeve
      var el=new THREE.Group(); el.position.set(0,-p.upperArm,0); sh.add(el);
      el.add(capsule(p.armW*0.45,p.forearm,mSkin,0,-p.forearm/2,0));     // forearm
      var hand=buildHand3D(mSkin,p.armW,s); hand.position.set(0,-p.forearm-0.01,0);
      el.add(hand);                                                     // hand: 4 fingers + thumb
      if(s<0) armL={sh:sh,el:el}; else armR={sh:sh,el:el};
    });
    // legs: hip pivot -> thigh -> knee pivot -> shin + shoe (sole at y=0)
    var legL=null, legR=null;
    [-1,1].forEach(function(s){
      var hp=new THREE.Group(); hp.position.set(p.hipX*s,hipY,0); g.add(hp);
      hp.add(capsule(p.legW/2,p.thigh,mPants,0,-p.thigh/2,0));           // thigh
      var kn=new THREE.Group(); kn.position.set(0,-p.thigh,0); hp.add(kn);
      kn.add(capsule(p.legW*0.44,p.shin,mPants,0,-p.shin/2,0));          // shin
      kn.add(ell(p.legW*0.55,p.shoeH/2,(p.legW+0.13)/2,mShoe,0,          // shoe
        -p.shin-p.shoeH/2+0.01,0.05));
      if(s<0) legL={hp:hp,kn:kn}; else legR={hp:hp,kn:kn};
    });
    g.scale.setScalar(p.heightScale);
    g.userData.rig={armL:armL,armR:armR,legL:legL,legR:legR};
    return g;
  }

  /* Smooth stylized NPC: rounded torso/head/limbs, big friendly head.
     headSize is now a true radius (sphere), not a box width. */
  function buildNPC(p){
    var c=p.colors;
    var mSkin=L(c.skin), mShirt=L(c.shirt), mPants=L(c.pants), mHair=L(c.hair);
    var g=new THREE.Group();
    var hipY=p.thigh+p.shin;
    var torsoYrel=p.torsoH/2+0.14;
    var headR=p.headSize;
    var headYrel=torsoYrel+p.torsoH/2+headR*0.92;
    g.add(ell(p.torsoW/2,p.torsoH/2,p.torsoD/2,mShirt,0,hipY+torsoYrel,0)); // torso
    g.add(ell(p.torsoW*0.42,0.09,p.torsoD*0.42,mPants,0,hipY+0.02,0));     // pelvis
    g.add(capsule(0.05,0.08,mSkin,0,hipY+torsoYrel+p.torsoH/2+0.02,0));    // neck
    var headG=new THREE.Group(); headG.position.set(0,hipY+headYrel,0); g.add(headG);
    headG.add(ball(headR,mSkin,0,0,0,22));
    hairFor(headG,headR,p.hairStyle,mHair,headR*2);
    sculptFace3D(headG,headR,mSkin,mHair);   // pure 3D face, no 2D plane
    [-1,1].forEach(function(s){                                            // ears
      var ear=ball(headR*0.22,mSkin,headR*0.98*s,-headR*0.05,0,10);
      ear.scale.set(0.45,1,0.7); headG.add(ear);
    });
    var armLen=p.upperArm+p.forearm;
    var shYrel=torsoYrel+p.torsoH/2-0.07;
    [-1,1].forEach(function(s){
      g.add(ball(p.armW*0.62,mShirt,p.shoulderX*s,hipY+shYrel,0,12));     // deltoid
      g.add(capsule(p.armW/2,armLen,mSkin,p.shoulderX*s,hipY+shYrel-armLen/2,0)); // arm
      var nhand=buildHand3D(mSkin,p.armW,s);
      nhand.position.set(p.shoulderX*s,hipY+shYrel-armLen-0.01,0); g.add(nhand); // hand
      g.add(capsule(p.legW/2,p.thigh+p.shin,mPants,p.hipX*s,hipY-(p.thigh+p.shin)/2,0)); // leg
    });
    g.scale.setScalar(p.heightScale);
    return g;
  }

  function rebuild(){
    if(fig){ scene.remove(fig);
      fig.traverse(function(o){ if(o.geometry) o.geometry.dispose();
        if(o.material){ if(o.material.map) o.material.map.dispose(); o.material.dispose(); } });
    }
    var a=ARCH[cur];
    fig = (a.kind==='hero') ? buildHero(P) : buildNPC(P);
    scene.add(fig);
  }

  /* ---------- recipe / submit ---------- */
  function r3(n){ return Math.round(n*1000)/1000; }
  function localDate(){ var d=new Date();
    return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
  function recipe(){
    var a=ARCH[cur], p=P, c=p.colors;
    var rec={ archetype:cur, label:a.label, date:localDate(),
      colors:clone(c),
      params:{}, hairStyle:p.hairStyle, heightScale:p.heightScale,
      notes:(notesEl?notesEl.value:'').trim() };
    SLIDERS.forEach(function(s){ rec.params[s.k]=r3(p[s.k]); });
    var hexNum=function(h){ return '0x'+h.replace('#',''); };
    if(a.kind==='hero'){
      rec.game={ target:'www/index.html → buildHero()',
        style:'stylized-smooth (capsule limbs, ellipsoid torso, sphere head, sculpted 3D face — NO boxes, NO 2D portrait plane)',
        colors:{SKIN:hexNum(c.skin),SHIRT:hexNum(c.shirt),PANTS:hexNum(c.pants),
                SHOE:hexNum(c.shoes),HAIR:hexNum(c.hair)},
        dims:clone(rec.params) };
    } else {
      var hipY=p.thigh+p.shin, torsoYrel=p.torsoH/2+0.14, headR=p.headSize;
      rec.game={ target:'www/npc_system.js → renderNPCs() (type "'+cur+'")',
        style:'stylized-smooth: torso/head = unit SPHERE scaled, arms/legs = unit CAPSULE scaled',
        scl:r3(p.heightScale), wid:r3(p.torsoW/0.42),
        colors:{skin:hexNum(c.skin),shirt:hexNum(c.shirt),pants:hexNum(c.pants),hair:hexNum(c.hair)},
        hairStyle:p.hairStyle,
        torso:{cy:r3(hipY+torsoYrel), sx:r3(p.torsoW), sy:r3(p.torsoH), sz:r3(p.torsoD)},
        head:{cy:r3(hipY+torsoYrel+p.torsoH/2+headR*0.92), d:r3(headR*2)},
        arm:{x:r3(p.shoulderX), topY:r3(hipY+torsoYrel+p.torsoH/2-0.07),
             r:r3(p.armW), len:r3(p.upperArm+p.forearm)},
        leg:{x:r3(p.hipX), topY:r3(hipY), r:r3(p.legW), len:r3(p.thigh+p.shin)} };
    }
    return rec;
  }
  function submit(){
    var rec=recipe(), a=ARCH[cur];
    var md='# Character feedback — '+a.label+' — '+rec.date+'\n\n'
      +'## Notes\n'+(rec.notes||'(no notes — proportions/colors only)')+'\n\n'
      +'## Recipe (JSON — rebuild verbatim in game code)\n```json\n'
      +JSON.stringify(rec,null,2)+'\n```\n';
    submitFeedback('Character feedback — '+a.label+' — '+rec.date, md, 'character-feedback');
  }

  /* ---------- panel UI ---------- */
  function el(tag,cls,html){ var e=document.createElement(tag);
    if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; }

  /* ---------- city worker uniform (one shared blocky look, Joshua customizes) ---------- */
  var UNIFORMS={
    roads:{ shirt:'#ff7b1c', pants:'#2a2f38', hat:'#ffd21f', skin:'#8a5f36', vest:true },
    buildings:{ shirt:'#3a7bff', pants:'#2a2f38', hat:'#ffffff', skin:'#8a5f36', vest:true },
    planner:{ shirt:'#2a7b4a', pants:'#2a2f38', hat:'#8a5f36', skin:'#8a5f36', vest:false },
    inspector:{ shirt:'#7b4fa3', pants:'#1f2a3a', hat:'#ffffff', skin:'#8a5f36', vest:false },
    police:{ shirt:'#1a2a4a', pants:'#1a1a2e', hat:'#1a1a2e', skin:'#8a5f36', vest:false }
  };
  var uniformRole='roads';
  var JOBDESC={
    roads:'Road Crew — Verifies every road is drivable. Spends most of the shift in the vehicle, driving all assigned roads to confirm they are passable and correctly connected. Places warning signs at errors found. Never drives on grass; parks and inspects on foot when needed. Reports findings to dispatch.',
    buildings:'Code Enforcement (Building Inspector) — Inspects buildings for proper placement: correct location, not on driveways, not on roadways, facing the right direction (front to street or parking lot), and roofs not overhanging into the roadway. Uses the car only to travel between inspection sites; inspections are done on foot. Calls dispatch to verify records.',
    planner:'City Planner — Tours points of interest across the map, reviewing development and planning concerns. Coordinates with road crew and inspectors on growth areas.',
    inspector:'City Inspector — Senior field inspector. Spot-checks road and building work, verifies crew reports, and signs off on completed fixes.',
    police:'Police — Monitors NPC citizens. When an NPC gets stuck, files a report diagnosing WHY it got stuck (for prevention), then resets the NPC or sends it in a new direction. Dispatches from the 911-style call center; requests more units through Joshua when call volume overwhelms.'
  };
  try{
    var u0=JSON.parse(localStorage.getItem('aw_uniform')||'null');
    if(u0){ if(u0.uniforms) UNIFORMS=Object.assign(UNIFORMS,u0.uniforms); JOBDESC=Object.assign(JOBDESC,u0.jobs||{}); }
  }catch(e){}
  function saveUniform(){
    try{ localStorage.setItem('aw_uniform', JSON.stringify({uniforms:UNIFORMS, jobs:JOBDESC})); }catch(e){}
  }
  function curUniform(){ return UNIFORMS[uniformRole]; }
  var ROLE_NAMES={ roads:'Road Crew', buildings:'Code Enforcement', planner:'City Planner', inspector:'City Inspector', police:'Police' };
  function buildUniformSection(panel){
    var us=el('div','csec'); us.appendChild(el('h4','','City Worker Uniforms — one look per role'));
    us.appendChild(el('div','chint','Blocky uniforms, one per crew type. Flip through with the arrows — numbers stay, no names.'));
    // role arrows
    var nav=el('div',''); nav.style.cssText='display:flex;align-items:center;gap:10px;margin:6px 0;';
    var bL=el('button','cbtn','\u2190'); bL.style.cssText='font-size:18px;padding:4px 14px;';
    var bR=el('button','cbtn','\u2192'); bR.style.cssText='font-size:18px;padding:4px 14px;';
    var rname=el('div',''); rname.id='uniformrolename';
    rname.style.cssText='flex:1;text-align:center;font-weight:bold;font-size:15px;cursor:pointer;';
    rname.title='Click to preview';
    var roles=Object.keys(ROLE_NAMES);
    var setRole=function(d){
      var i=roles.indexOf(uniformRole);
      uniformRole=roles[(i+d+roles.length)%roles.length];
      paintUniformRole();
      previewUniform(); // auto-preview on change
    };
    var selectRole=function(r){
      uniformRole=r; paintUniformRole(); previewUniform();
      if(window._collapseMain) window._collapseMain();
    };
    bL.addEventListener('click',function(){ setRole(-1); });
    bR.addEventListener('click',function(){ setRole(1); });
    rname.addEventListener('click',function(){ previewUniform(); });
    nav.appendChild(bL); nav.appendChild(rname); nav.appendChild(bR);
    us.appendChild(nav);
    // direct role selection buttons
    var roleBtns=el('div',''); roleBtns.style.cssText='display:flex;flex-wrap:wrap;gap:4px;margin:4px 0;';
    roles.forEach(function(r){
      var rb=el('button','cbtn',ROLE_NAMES[r]||r);
      rb.style.cssText='font-size:11px;padding:4px 8px;';
      rb.addEventListener('click',function(){ selectRole(r); });
      roleBtns.appendChild(rb);
    });
    us.appendChild(roleBtns);
    var cwrap=el('div'); cwrap.id='uniformcolors'; us.appendChild(cwrap);
    // job description for the CURRENT role only
    var dlab=el('label','','Job description:'); dlab.style.cssText='display:block;margin:8px 0 4px;font-weight:bold;';
    us.appendChild(dlab);
    var ta=document.createElement('textarea'); ta.id='uniformjobdesc';
    ta.style.cssText='width:100%;min-height:90px;background:#141b28;color:#dfe7f2;border:1px solid #2c384a;border-radius:8px;padding:8px;font-size:13px;';
    ta.addEventListener('input',function(){ JOBDESC[jobKey(uniformRole)]=ta.value; saveUniform(); });
    us.appendChild(ta);
    var brow=el('div',''); brow.style.cssText='display:flex;gap:6px;margin:8px 0;';
    var bS=el('button','cbtn','Save uniform');
    bS.addEventListener('click',function(){ saveUniform(); bS.textContent='Saved ✓'; setTimeout(function(){bS.textContent='Save uniform';},2000); });
    var bP=el('button','cbtn','Preview + save to Reports');
    bP.addEventListener('click',function(){ previewUniform(); saveUniformToReports(); });
    brow.appendChild(bS); brow.appendChild(bP); us.appendChild(brow);
    panel.appendChild(us);
    paintUniformRole();
  }
  function jobKey(role){ return role==='roads'?'roads':role==='buildings'?'buildings':role; }
  function paintUniformRole(){
    var rn=document.getElementById('uniformrolename');
    if(rn) rn.textContent=ROLE_NAMES[uniformRole];
    var cw=document.getElementById('uniformcolors'); if(cw){ cw.innerHTML='';
      var U=curUniform();
      [['shirt','Shirt / vest'],['pants','Pants'],['hat','Hard hat'],['skin','Skin tone']].forEach(function(c){
        var row=el('div','crow'); row.appendChild(el('label','',c[1]));
        var inp=document.createElement('input'); inp.type='color'; inp.value=U[c[0]];
        inp.addEventListener('input',function(){ U[c[0]]=inp.value; saveUniform(); previewUniform(); });
        row.appendChild(inp); cw.appendChild(row);
      });
      var vrow=el('div','crow'); vrow.appendChild(el('label','','Safety vest'));
      var vinp=document.createElement('input'); vinp.type='checkbox'; vinp.checked=!!U.vest;
      vinp.addEventListener('change',function(){ U.vest=vinp.checked; saveUniform(); previewUniform(); });
      vrow.appendChild(vinp); cw.appendChild(vrow);
    }
    var ta=document.getElementById('uniformjobdesc');
    if(ta) ta.value=JOBDESC[jobKey(uniformRole)]||'';
    previewUniform();
  }
  function saveUniformToReports(){
    var U=curUniform();
    var md='# City worker uniform — '+ROLE_NAMES[uniformRole]+'\n\n'
      +'## Uniform colors\n'
      +'- shirt: '+U.shirt+'\n- pants: '+U.pants+'\n- hard hat: '+U.hat+'\n'
      +'- skin: '+U.skin+'\n- safety vest: '+(U.vest?'yes':'no')+'\n\n'
      +'## Job description\n'+(JOBDESC[jobKey(uniformRole)]||'(none)')+'\n';
    submitFeedback('City worker uniform — '+ROLE_NAMES[uniformRole], md, 'feedback');
    if(savedMsg){ savedMsg.textContent='Uniform saved to Reports ✓';
      setTimeout(function(){ if(savedMsg) savedMsg.textContent=''; },2500); }
  }
  function paintUniformColors(){ if(window._paintUniformColors) window._paintUniformColors(); }
  function previewUniform(){
    // swap the main figure for a blocky uniform preview
    if(fig){ scene.remove(fig); }
    var U=curUniform();
    fig=new THREE.Group();
    var B=function(w,h,d,c){ return new THREE.Mesh(new THREE.BoxGeometry(w,h,d), L(c)); };
    var torso=B(0.5,0.6,0.3,U.shirt); torso.position.y=1.0; fig.add(torso);
    if(U.vest){ var v=B(0.54,0.2,0.34,0xffe14d); v.position.y=1.1; fig.add(v); }
    var head=B(0.32,0.32,0.32,U.skin); head.position.y=1.55; fig.add(head);
    var hat=B(0.38,0.12,0.38,U.hat); hat.position.y=1.75; fig.add(hat);
    var armL=B(0.14,0.55,0.14,U.shirt); armL.position.set(-0.35,1.0,0); fig.add(armL);
    var armR=B(0.14,0.55,0.14,U.shirt); armR.position.set(0.35,1.0,0); fig.add(armR);
    var legL=B(0.18,0.6,0.18,U.pants); legL.position.set(-0.14,0.35,0); fig.add(legL);
    var legR=B(0.18,0.6,0.18,U.pants); legR.position.set(0.14,0.35,0); fig.add(legR);
    scene.add(fig);
    if(savedMsg){ savedMsg.textContent='Uniform preview — blocky worker'; 
      setTimeout(function(){ if(savedMsg) savedMsg.textContent=''; },2000); }
  }
  /* ---------- citizen archetypes: 10 looks representing the 1,000 ---------- */
  var CITIZENS=[];
  var CSKINS=['#8a5f36','#6b4429','#7d5230','#a06a3c','#5c3a22','#93704a','#4a2f1c','#b08050','#75522e','#9c6b3f'];
  var CSHIRTS=['#3a6ea5','#a53a3a','#3aa53a','#a58a3a','#6a3aa5','#3aa5a5','#a53a7b','#555f6b','#7b4fa3','#2e8b8b'];
  var CPANTS=['#2e4a6b','#3a3a3a','#5a4a3a','#2a4a2a','#4a2a3a','#1f2a3a','#4a4a4a','#333a2a','#2a3a4a','#3a2a2a'];
  var CHAIRS=['#0a0805','#1a1210','#2e1f14','#0f0f0f','#3a2a1a','#141414','#241812','#0d0b09','#1f1a14','#2a2018'];
  for(var ci=0; ci<10; ci++){
    var cp=clone(ARCH.man.def);
    cp.colors.skin=CSKINS[ci]; cp.colors.shirt=CSHIRTS[ci];
    cp.colors.pants=CPANTS[ci]; cp.colors.hair=CHAIRS[ci];
    CITIZENS.push({
      label:'Citizen '+(ci+1), arch:'man', params:cp,
      desc:'Ordinary citizen #'+(ci+1)+' — one of ten everyday looks spread randomly across the thousand NPCs. Out for a drive, running errands, living life.'
    });
  }
  try{
    var c0=JSON.parse(localStorage.getItem('aw_citizens')||'null');
    if(c0 && c0.length===10) CITIZENS=c0;
  }catch(e){}
  function saveCitizens(){ try{ localStorage.setItem('aw_citizens', JSON.stringify(CITIZENS)); }catch(e){} }
  var citizenIdx=0, editingCitizen=false;
  function buildCitizenSection(panel){
    var cs=el('div','csec'); cs.appendChild(el('h4','','Citizen Archetypes — 10 looks for the 1,000'));
    cs.appendChild(el('div','chint','Ten everyday people, slightly different from each other. The game spreads them randomly across the thousand NPCs. Pick one to edit.'));
    var pick=el('div','brow');
    var sel=document.createElement('select');
    CITIZENS.forEach(function(c,i){
      var o=document.createElement('option'); o.value=i; o.textContent=c.label; sel.appendChild(o);
    });
    sel.value=citizenIdx;
    sel.addEventListener('change',function(){ citizenIdx=+sel.value; enterCitizenMode(); previewCitizen(); });
    pick.appendChild(sel); cs.appendChild(pick);
    // direct citizen buttons
    var cbtns=el('div',''); cbtns.style.cssText='display:flex;flex-wrap:wrap;gap:4px;margin:4px 0;';
    CITIZENS.forEach(function(c,i){
      var cb=el('button','cbtn',c.label);
      cb.style.cssText='font-size:11px;padding:4px 8px;';
      cb.addEventListener('click',function(){ citizenIdx=i; sel.value=i; enterCitizenMode(); previewCitizen(); });
      cbtns.appendChild(cb);
    });
    cs.appendChild(cbtns);
    var cw=el('div'); cw.id='citizenwrap'; cs.appendChild(cw);
    panel.appendChild(cs);
    paintCitizen();
  }
  function enterCitizenMode(){
    if(window._collapseMain) window._collapseMain();
    var c=CITIZENS[citizenIdx];
    editingCitizen=true; cur=c.arch||'man'; P=c.params;
    sliderEls={}; colorEls={};
    buildPanel(); rebuild(); fitCamera(); paintCitizen();
    if(savedMsg){ savedMsg.textContent='Editing '+c.label+' — sliders now affect this citizen';
      setTimeout(function(){ if(savedMsg) savedMsg.textContent=''; },2500); }
  }
  function paintCitizen(){
    var cw=document.getElementById('citizenwrap'); if(!cw) return; cw.innerHTML='';
    var c=CITIZENS[citizenIdx];
    var lab=el('label','','Name: ');
    var ninp=document.createElement('input'); ninp.type='text'; ninp.value=c.label;
    ninp.style.cssText='background:#141b28;color:#fff;border:1px solid #2c384a;border-radius:8px;padding:6px 10px;font-size:14px;width:160px;';
    ninp.addEventListener('input',function(){ c.label=ninp.value; saveCitizens(); });
    lab.appendChild(ninp); cw.appendChild(lab);
    [['skin','Skin'],['shirt','Shirt'],['pants','Pants'],['hair','Hair']].forEach(function(p){
      var row=el('div','crow'); row.appendChild(el('label','',p[1]));
      var inp=document.createElement('input'); inp.type='color'; inp.value=c[p[0]];
      inp.addEventListener('input',function(){ c[p[0]]=inp.value; saveCitizens(); previewCitizen(); });
      row.appendChild(inp); cw.appendChild(row);
    });
    var dlab=el('label','','Description:'); dlab.style.cssText='display:block;margin:8px 0 4px;font-weight:bold;';
    cw.appendChild(dlab);
    var ta=document.createElement('textarea'); ta.value=c.desc;
    ta.style.cssText='width:100%;min-height:70px;background:#141b28;color:#dfe7f2;border:1px solid #2c384a;border-radius:8px;padding:8px;font-size:13px;';
    ta.addEventListener('input',function(){ c.desc=ta.value; saveCitizens(); });
    cw.appendChild(ta);
    var bRow=el('div',''); bRow.style.cssText='display:flex;gap:6px;margin:8px 0;';
    var bS=el('button','cbtn','Save citizen');
    bS.addEventListener('click',function(){ saveCitizens(); bS.textContent='Saved ✓'; setTimeout(function(){bS.textContent='Save citizen';},2000); });
    var bP=el('button','cbtn','Preview'); bP.addEventListener('click',previewCitizen);
    var bPrev2=el('button','cbtn','← Prev'); bPrev2.addEventListener('click',function(){
      citizenIdx=(citizenIdx+9)%10; sel.value=citizenIdx; enterCitizenMode(); previewCitizen(); });
    var bNext2=el('button','cbtn','Next →'); bNext2.addEventListener('click',function(){
      citizenIdx=(citizenIdx+1)%10; sel.value=citizenIdx; enterCitizenMode(); previewCitizen(); });
    bRow.appendChild(bPrev2); bRow.appendChild(bP); bRow.appendChild(bS); bRow.appendChild(bNext2);
    cw.appendChild(bRow);
  }
  function previewCitizen(){
    var c=CITIZENS[citizenIdx];
    if(fig){ scene.remove(fig); }
    // smooth-style citizen preview using the npc builder with citizen colors
    var saveP=clone(P), saveC=clone(P.colors), saveArch=cur;
    cur='man'; P=clone(ARCH.man.def); P.colors.skin=c.skin; P.colors.shirt=c.shirt;
    P.colors.pants=c.pants; P.colors.hair=c.hair;
    fig=buildNPC(P); scene.add(fig);
    P=saveP; cur=saveArch;
    if(savedMsg){ savedMsg.textContent='Preview: '+c.label;
      setTimeout(function(){ if(savedMsg) savedMsg.textContent=''; },2000); }
  }
  function buildPanel(){
    var panel=document.getElementById('charpanel'); panel.innerHTML='';
    panel.appendChild(el('div','chead','Character Studio'));
    // archetype switcher
    var ar=el('div','arow');
    ORDER.forEach(function(a){
      var b=el('button','abtn'+(a===cur?' on':''),ARCH[a].label);
      b.addEventListener('click',function(){ switchArch(a); });
      b.dataset.arch=a; ar.appendChild(b);
    });
    panel.appendChild(ar);
    // reference NPC review queue — one person at a time, in photo order
    rqLoadState();
    var rs=el('div','csec'); rs.appendChild(el('h4','','Reference NPC review — your photos'));
    var rqb=el('div'); rqb.id='rqbody'; rs.appendChild(rqb);
    panel.appendChild(rs);
    rqPaint();
    buildUniformSection(panel);
    buildCitizenSection(panel);
    panel.appendChild(el('div','chint',
      'Stylized 3D-animation look (smooth, Pixar-like — no boxes). '+
      'Sliders change the model\u2019s numbers (lengths, widths) — '+
      'not mesh sculpting. Your recipe below is the exact spec Muse rebuilds in the game code.'));
    // slider groups
    var groups={};
    SLIDERS.forEach(function(s){
      if(s.heroOnly && ARCH[cur].kind!=='hero') return;
      var g=groups[s.g]; if(!g){ g=groups[s.g]=el('div','csec'); g.appendChild(el('h4','',s.g)); }
      var row=el('div','srow');
      var lab=el('label','',s.t+' <span></span>');
      var inp=document.createElement('input');
      inp.type='range'; inp.min=s.min; inp.max=s.max; inp.step=s.step; inp.value=P[s.k];
      var val=lab.querySelector('span');
      var upd=function(){ val.textContent=(+inp.value).toFixed(3).replace(/0+$/,'').replace(/\.$/,'.0'); };
      inp.addEventListener('input',function(){ P[s.k]=+inp.value; upd(); rebuild(); });
      upd(); row.appendChild(lab); row.appendChild(inp); g.appendChild(row);
      sliderEls[s.k]={inp:inp,upd:upd};
    });
    var mainEd=el('div','csec'); mainEd.id='maineditor';
    var mhead=el('h4','','Main Character Editor');
    mhead.style.cssText='cursor:pointer;';
    mhead.title='Click to collapse/expand';
    var mbody=el('div'); mbody.id='maineditorbody';
    ['Head','Torso','Arms','Legs','Body'].forEach(function(g){ if(groups[g]) mbody.appendChild(groups[g]); });
    var collapsed=false;
    mhead.addEventListener('click',function(){
      collapsed=!collapsed;
      mbody.style.display=collapsed?'none':'block';
      mhead.textContent='Main Character Editor '+(collapsed?'▶':'▼');
    });
    mhead.textContent='Main Character Editor ▼';
    mainEd.appendChild(mhead); mainEd.appendChild(mbody);
    panel.appendChild(mainEd);
    // auto-collapse when uniform/citizen selected
    window._collapseMain=function(){
      collapsed=true; mbody.style.display='none';
      mhead.textContent='Main Character Editor ▶';
    };
    // hair style (head group)
    var hs=el('div','srow');
    hs.appendChild(el('label','','Hair style'));
    var sel=document.createElement('select');
    ['cap','long','none'].forEach(function(h){
      var o=document.createElement('option'); o.value=h; o.textContent=h; sel.appendChild(o); });
    sel.value=P.hairStyle;
    sel.addEventListener('change',function(){ P.hairStyle=sel.value; rebuild(); });
    hs.appendChild(sel); sliderEls._hair=sel;
    if(groups.Head) groups.Head.appendChild(hs);
    // colors
    var cs=el('div','csec'); cs.appendChild(el('h4','','Colors'));
    COLORS.forEach(function(cd){
      if(cd.heroOnly && ARCH[cur].kind!=='hero') return;
      var row=el('div','crow'); row.appendChild(el('label','',cd.t));
      var wrap=el('div','swrow');
      if(cd.pal) cd.pal.forEach(function(n){
        var sw=el('button','sw'); sw.style.background=hx(n); sw.title=hx(n);
        sw.addEventListener('click',function(){ setColor(cd.k,hx(n)); });
        wrap.appendChild(sw);
      });
      var ci=document.createElement('input'); ci.type='color'; ci.value=P.colors[cd.k];
      ci.addEventListener('input',function(){ setColor(cd.k,ci.value); });
      wrap.appendChild(ci); row.appendChild(wrap); cs.appendChild(row);
      colorEls[cd.k]=ci;
    });
    panel.appendChild(cs);
    // buttons
    var brow=el('div','brow');
    var bSpin=el('button','cbtn','\u27f3 spin: off');
    bSpin.addEventListener('click',function(){ spin=!spin;
      bSpin.textContent='\u27f3 spin: '+(spin?'on':'off'); });
    var bReset=el('button','cbtn','Reset defaults');
    bReset.addEventListener('click',function(){ resetArch(); });
    var bSave=el('button','cbtn','\uD83D\uDCBE Save my look');
    bSave.addEventListener('click',function(){ saveLook(); });
    brow.appendChild(bSpin); brow.appendChild(bReset); brow.appendChild(bSave);
    panel.appendChild(brow);
    savedMsg=el('div','csaved'); panel.appendChild(savedMsg);
    // notes + submit
    var ns=el('div','csec'); ns.appendChild(el('h4','','Suggest changes'));
    notesEl=document.createElement('textarea');
    notesEl.placeholder='Tell Muse what to change… (e.g. make the shirt blue, longer legs)';
    notesEl.value=P.notes||'';
    notesEl.addEventListener('input',function(){ P.notes=notesEl.value; });
    ns.appendChild(notesEl); panel.appendChild(ns);
    var bSub=el('button','csubmit','Submit character feedback \u2192');
    bSub.addEventListener('click',submit);
    panel.appendChild(bSub);
    panel.appendChild(el('div','cnote',
      'Submit opens a pre-filled GitHub issue (label character-feedback) — hit Submit there and it lands in the repo. Muse reads it before the next build.'));
  }
  function setColor(k,v){ P.colors[k]=v; if(colorEls[k]) colorEls[k].value=v; rebuild(); }
  function refreshPanel(){ Object.keys(sliderEls).forEach(function(k){
      if(k==='_hair'){ sliderEls._hair.value=P.hairStyle; return; }
      var e=sliderEls[k]; e.inp.value=P[k]; e.upd(); });
    Object.keys(colorEls).forEach(function(k){ colorEls[k].value=P.colors[k]; });
    if(notesEl){ notesEl.value=P.notes||''; }
  }
  function saveLook(){
    if(editingCitizen){ saveCitizens();
      if(savedMsg){ savedMsg.textContent='Saved \u2713 ('+CITIZENS[citizenIdx].label+')';
        setTimeout(function(){ if(savedMsg) savedMsg.textContent=''; },2500); }
      return; }
    try{ localStorage.setItem(lsKey(cur), JSON.stringify(P)); }catch(e){}
    if(savedMsg){ savedMsg.textContent='Saved \u2713 ('+ARCH[cur].label+')';
      setTimeout(function(){ savedMsg.textContent=''; },2500); }
  }
  function loadLook(a){
    try{ var s=localStorage.getItem(lsKey(a)); if(s){ var o=JSON.parse(s);
      var d=clone(ARCH[a].def);
      Object.keys(d).forEach(function(k){ if(o[k]!==undefined) d[k]=o[k]; });
      Object.keys(d.colors).forEach(function(k){ if(o.colors&&o.colors[k]) d.colors[k]=o.colors[k]; });
      if(o.notes) d.notes=o.notes; return d; } }catch(e){}
    return clone(ARCH[a].def);
  }
  function switchArch(a){
    editingCitizen=false;
    cur=a; sliderEls={}; colorEls={};
    P=loadLook(a); buildPanel(); rebuild(); fitCamera();
  }
  function resetArch(){
    P=clone(ARCH[cur].def); try{localStorage.removeItem(lsKey(cur));}catch(e){}
    refreshPanel(); rebuild();
  }

  /* ---------- three.js setup ---------- */
  function fitCamera(){
    tgtY = 1.0*(P?P.heightScale:1);
  }
  function init(){
    var canvas=document.getElementById('cchar');
    renderer=new THREE.WebGLRenderer({canvas:canvas,antialias:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));
    scene=new THREE.Scene();
    scene.background=new THREE.Color(0x11151c);
    scene.fog=new THREE.Fog(0x11151c,10,26);
    camera=new THREE.PerspectiveCamera(42,1,0.1,60);
    scene.add(new THREE.HemisphereLight(0xffffff,0x8a8f98,0.95));
    var dl=new THREE.DirectionalLight(0xffffff,0.55); dl.position.set(3,5,4); scene.add(dl);
    var dl2=new THREE.DirectionalLight(0xbfd4ff,0.25); dl2.position.set(-4,3,-3); scene.add(dl2);
    var ground=new THREE.Mesh(new THREE.CircleGeometry(3.2,40),
      new THREE.MeshLambertMaterial({color:0x232a35}));
    ground.rotation.x=-Math.PI/2; scene.add(ground);
    var ring=new THREE.Mesh(new THREE.RingGeometry(3.2,3.28,40),
      new THREE.MeshBasicMaterial({color:0x1c5d8f,side:THREE.DoubleSide}));
    ring.rotation.x=-Math.PI/2; ring.position.y=0.001; scene.add(ring);
    P=loadLook(cur); buildPanel(); rebuild(); bindOrbit(canvas); resize();
    window.addEventListener('resize',resize);
  }
  function resize(){
    var v=document.getElementById('viewchar');
    var w=v.clientWidth, h=v.clientHeight;
    var pw=document.getElementById('charpanel');
    var isNarrow=window.innerWidth<=700;
    var cw=isNarrow?w:Math.max(200,w-pw.offsetWidth);
    var ch=isNarrow?Math.max(200,h-pw.offsetHeight):h;
    renderer.setSize(cw,ch,false);
    camera.aspect=cw/ch; camera.updateProjectionMatrix();
  }
  function bindOrbit(canvas){
    var dragging=false,lx=0,ly=0,pinch0=0,dist0=0;
    canvas.addEventListener('pointerdown',function(e){
      canvas.setPointerCapture(e.pointerId); dragging=true; lx=e.clientX; ly=e.clientY; });
    canvas.addEventListener('pointermove',function(e){
      if(!dragging) return;
      yaw-=(e.clientX-lx)*0.008; pitch+=(e.clientY-ly)*0.006;
      pitch=Math.max(-0.4,Math.min(1.2,pitch)); lx=e.clientX; ly=e.clientY; });
    var end=function(){ dragging=false; };
    canvas.addEventListener('pointerup',end); canvas.addEventListener('pointercancel',end);
    canvas.addEventListener('wheel',function(e){ e.preventDefault();
      dist=Math.max(2,Math.min(12,dist*(1+e.deltaY*0.001))); },{passive:false});
    canvas.addEventListener('touchmove',function(e){
      if(e.touches.length===2){ e.preventDefault();
        var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,
                         e.touches[0].clientY-e.touches[1].clientY);
        if(pinch0>0) dist=Math.max(2,Math.min(12,dist0*(pinch0/d)));
        else { pinch0=d; dist0=dist; }
      } },{passive:false});
    canvas.addEventListener('touchend',function(){ pinch0=0; });
  }
  var lastT=0;
  function loop(t){
    if(!running) return;
    requestAnimationFrame(loop);
    var dt=Math.min(0.05,((t||0)-lastT)/1000||0.016); lastT=t||0;
    if(spin) yaw+=dt*0.5;
    camera.position.set(
      Math.sin(yaw)*Math.cos(pitch)*dist,
      tgtY+Math.sin(pitch)*dist,
      Math.cos(yaw)*Math.cos(pitch)*dist);
    camera.lookAt(0,tgtY,0);
    renderer.render(scene,camera);
  }

  /* ---------- public ---------- */
  function ensure(){
    if(loaded) return Promise.resolve();
    if(loading) return loading;
    loading=loadScript('three.min.js')
      .then(function(){ init(); loaded=true; })
      .catch(function(err){
        var p=document.getElementById('charpanel');
        if(p) p.innerHTML='<div class="chead">Character Studio</div><div class="cnote">Could not load 3D libraries: '+err.message+'. Check connection and retry.</div>';
        loading=null; throw err;
      });
    return loading;
  }
  function start(){ ensure().then(function(){ running=true; lastT=0; resize(); requestAnimationFrame(loop); })
    .catch(function(){}); }
  function stop(){ running=false; }

  return { ensure:ensure, start:start, stop:stop };
})();
