/* Adamsville Watcher — Buildings Studio.
   3D preview + parametric editing for the game's buildings.
   Buildings come from osm_buildings.js: [x, z, width, depth, height, type]
   type: 0 house, 1 commercial, 2 large/apt, 3 other.
   The preview rebuilds the game's construction (box body + pyramid roof)
   with adjustable numbers. The JSON recipe from "Submit building feedback"
   is what Muse rebuilds verbatim in the game code.
   three.min.js + osm_buildings.js lazy-load on first open. */
window.BldgStudio = (function () {
  'use strict';

  /* ---------- game construction (www/index.html osmBuildings()) ---------- */
  var TYPE_NAMES = ['house', 'commercial', 'apartment/large', 'other'];
  // body colors by type, roof colors: commercial gray else brown
  function typeBodyColor(t){ return t===1?0x9aa0a8:(t===2?0x8a7f72:0xb5a88f); }
  function typeRoofColor(t){ return t===1?0x5a6068:0x6b4a3a; }
  function hx(n){ var s=n.toString(16); while(s.length<6) s='0'+s; return '#'+s; }

  /* ---------- selection ---------- */
  var ALL = [];        // all buildings [x,z,w,d,h,type]
  var filt = -1;       // -1 = all types
  var list = [];       // filtered indices into ALL
  var li = 0;          // position in list

  /* ---------- params (live, per current building) ---------- */
  var P = null;        // {h,w,d,roofH,roofStyle,bodyColor,roofColor}
  function defaultsFor(b){
    return {
      h: Math.max(2.5, b[4]), w: b[2], d: b[3],
      roofH: Math.min(5, Math.max(1.2, Math.max(b[2],b[3])*0.18)),
      roofStyle: 'pyramid',
      bodyColor: hx(typeBodyColor(b[5])), roofColor: hx(typeRoofColor(b[5])),
      moveF: 0, moveS: 0,          // nudge, building-local: forward / right (units)
      rot: 0,                       // rotation radians (y)
      openings: []                  // {kind:'window'|'door', wall, at:0..1}
    };
  }
  // building-local offset (moveF forward, moveS right) -> world offset, given rotation
  function worldOffset(){
    var s = Math.sin(P.rot), c = Math.cos(P.rot);
    return { x: s*P.moveF + c*P.moveS, z: c*P.moveF - s*P.moveS };
  }
  var uiWall = 'front', uiAlong = 0.5; // add-window/door placement UI state

  var SLIDERS = [
    {k:'h', g:'Structure', t:'Height', min:2.5, max:40, step:0.1},
    {k:'w', g:'Structure', t:'Width (footprint)', min:3, max:40, step:0.5},
    {k:'d', g:'Structure', t:'Depth (footprint)', min:3, max:40, step:0.5},
    {k:'roofH', g:'Roof', t:'Roof height', min:0, max:8, step:0.1}
  ];

  /* ---------- state ---------- */
  var loaded=false, loading=null, running=false;
  var renderer, scene, camera, bldg=null;
  var yaw=0.6, pitch=0.35, dist=30, tgtY=4, tgtX=0, tgtZ=0;
  var notesEl=null, savedMsg=null, infoEl=null;

  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function el(tag,cls,html){ var e=document.createElement(tag);
    if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; }

  function loadScript(src){
    return new Promise(function (res, rej){
      var s=document.createElement('script'); s.src=src;
      s.onload=res; s.onerror=function(){rej(new Error('load '+src));};
      document.head.appendChild(s);
    });
  }

  /* ---------- 3D ---------- */
  function L(c){ return new THREE.MeshLambertMaterial({color:c}); }
  function rebuild(){
    if (bldg) { scene.remove(bldg); }
    bldg = new THREE.Group();
    var bodyM = L(new THREE.Color(P.bodyColor).getHex());
    var body = new THREE.Mesh(new THREE.BoxGeometry(P.w, P.h, P.d), bodyM);
    body.position.y = P.h/2; bldg.add(body);
    if (P.roofStyle === 'flat') {
      var slab = new THREE.Mesh(new THREE.BoxGeometry(P.w*1.04, 0.35, P.d*1.04),
        L(new THREE.Color(P.roofColor).getHex()));
      slab.position.y = P.h + 0.17; bldg.add(slab);
    } else { // pyramid — matches the game's ConeGeometry(0.72,1,4)
      var cone = new THREE.ConeGeometry(0.72, 1, 4);
      cone.rotateY(Math.PI/4);
      var roof = new THREE.Mesh(cone, L(new THREE.Color(P.roofColor).getHex()));
      roof.scale.set(P.w*1.06, Math.max(0.01,P.roofH), P.d*1.06);
      roof.position.y = P.h + Math.max(0.01,P.roofH)/2; bldg.add(roof);
    }
    // door hint on the front face
    var door = new THREE.Mesh(new THREE.BoxGeometry(Math.min(2,P.w*0.25), 2.6, 0.12),
      L(0x3a2c1c));
    door.position.set(0, 1.3, P.d/2 + 0.02); bldg.add(door);
    // user-added windows / doors (on selected wall faces)
    (P.openings||[]).forEach(function(o){
      var isDoor = o.kind==='door';
      var ww = isDoor?1.9:1.7, hh = isDoor?2.7:1.7;
      var om = new THREE.Mesh(new THREE.PlaneGeometry(ww,hh),
        L(isDoor?0x4a3220:0xcfe4f2));
      var yy = isDoor ? hh/2 : Math.min(P.h-1, 2.4), at = (o.at-0.5);
      if(o.wall==='front'){ om.position.set(at*P.w, yy, P.d/2+0.04); }
      else if(o.wall==='back'){ om.position.set(at*P.w, yy, -P.d/2-0.04); om.rotation.y=Math.PI; }
      else if(o.wall==='left'){ om.position.set(-P.w/2-0.04, yy, at*P.d); om.rotation.y=-Math.PI/2; }
      else { om.position.set(P.w/2+0.04, yy, at*P.d); om.rotation.y=Math.PI/2; }
      bldg.add(om);
    });
    // user-added sidewalks: flat concrete strip in front of the entrance side
    (P.openings||[]).forEach(function(o){
      if(o.kind!=='sidewalk') return;
      var sw=new THREE.Mesh(new THREE.BoxGeometry(P.w*0.9, 0.15, 2.2), L(0x9aa0a8));
      // place fully in front of the building face, clear of the door swing
      var swz=P.d/2+1.1+1.1; // face + half sidewalk depth
      sw.position.set((o.at-0.5)*P.w*0.5+(o.ox||0), 0.08, swz+(o.oz||0)); bldg.add(sw);
    });
    scene.add(bldg);
    tgtY = P.h*0.45; dist = Math.max(14, Math.max(P.w,P.d,P.h)*2.2);
    // in-situ context: place at game position, render surroundings
    var gspot = gameSpot(curB(), list[li]);
    var gx = gspot ? gspot[0] : curB()[0], gz = gspot ? gspot[1] : curB()[1];
    var wo = worldOffset();
    bldg.rotation.y = P.rot;
    bldg.position.set(gx + wo.x, 0, gz + wo.z);
    tgtX = gx + wo.x; tgtZ = gz + wo.z;
    buildContext(curB(), list[li], gspot);
  }

  /* ---------- in-situ context: streets + terrain + neighbors ----------
     Shows the building at its GAME position (placement protocol applied),
     with nearby roads, terrain, and neighboring buildings around it.
     Red highlight under the footprint when the raw OSM spot is on-road. */
  var ctxGroup = null, spotCache = {};
  function gameSpot(b, idx){
    if (idx in spotCache) return spotCache[idx];
    var half = Math.max(b[2], b[3]) / 2, need = half + 4, spot = null;
    try {
      var q = qaNearest(b[0], b[1], 150);
      if (q.edge >= need) spot = [b[0], b[1]];
      else {
        outer:
        for (var r = 6; r <= 30; r += 6) for (var a = 0; a < 8; a++) {
          var nx = b[0] + Math.cos(a / 8 * Math.PI * 2) * r,
              nz = b[1] + Math.sin(a / 8 * Math.PI * 2) * r;
          if (qaNearest(nx, nz, 150).edge >= need) { spot = [nx, nz]; break outer; }
        }
      }
    } catch (e) { spot = [b[0], b[1]]; }
    spotCache[idx] = spot;
    return spot;
  }
  function buildContext(b, idx, gspot){
    if (ctxGroup) { scene.remove(ctxGroup); }
    ctxGroup = new THREE.Group();
    var cx = gspot ? gspot[0] : b[0], cz = gspot ? gspot[1] : b[1];
    var R = 170;
    // terrain disc
    var gnd = new THREE.Mesh(new THREE.CircleGeometry(R, 40),
      new THREE.MeshLambertMaterial({ color: 0x4d7a3c }));
    gnd.rotation.x = -Math.PI / 2; gnd.position.set(cx, -0.15, cz);
    ctxGroup.add(gnd);
    // nearby roads as ribbons (from the QA segment grid)
    try {
      qaBuildGrid();
      var pos = [], col = [], vx = [], seen = {};
      var x0 = Math.floor((cx - R - 30) / 100), x1 = Math.floor((cx + R + 30) / 100),
          z0 = Math.floor((cz - R - 30) / 100), z1 = Math.floor((cz + R + 30) / 100);
      for (var gx = x0; gx <= x1; gx++) for (var gz = z0; gz <= z1; gz++) {
        var arr = QA.grid.map[gx + ',' + gz]; if (!arr) continue;
        for (var i = 0; i < arr.length; i++) {
          var si = arr[i]; if (seen[si]) continue; seen[si] = 1;
          var s = SEGS[si];
          var mx = (s[0] + s[2]) / 2, mz = (s[1] + s[3]) / 2;
          if (Math.hypot(mx - cx, mz - cz) > R + 40) continue;
          var dx = s[2] - s[0], dz = s[3] - s[1], len = Math.hypot(dx, dz) || 1;
          var ox = -dz / len * s[4], oz = dx / len * s[4];
          var shade = s[4] > 10 ? 0.16 : (s[4] > 6 ? 0.2 : 0.24);
          var base = pos.length / 3;
          pos.push(s[0]+ox, 0.3, s[1]+oz,  s[0]-ox, 0.3, s[1]-oz,
                   s[2]+ox, 0.3, s[3]+oz,  s[2]-ox, 0.3, s[3]-oz);
          for (var k = 0; k < 4; k++) col.push(shade, shade, shade + 0.02);
          vx.push(base, base+2, base+1, base+1, base+2, base+3);
        }
      }
      if (pos.length) {
        var rg = new THREE.BufferGeometry();
        rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        rg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        rg.setIndex(vx); rg.computeVertexNormals();
        ctxGroup.add(new THREE.Mesh(rg, new THREE.MeshLambertMaterial({ vertexColors: true })));
      }
    } catch (e) {}
    // neighboring buildings (raw OSM spots, simple gray boxes, capped)
    try {
      var ngeo = new THREE.BoxGeometry(1, 1, 1); ngeo.translate(0, 0.5, 0);
      var nmat = new THREE.MeshLambertMaterial({ color: 0x9a938a });
      var spots = [], spotIdx = [];
      for (var n = 0; n < ALL.length && spots.length < 400; n++) {
        if (n === idx) continue;
        var nb = ALL[n];
        if (Math.hypot(nb[0] - cx, nb[1] - cz) > R) continue;
        spots.push(nb); spotIdx.push(n);
      }
      ctxGroup.userData.spotIdx = spotIdx;
      if (spots.length) {
        var im = new THREE.InstancedMesh(ngeo, nmat, spots.length);
        var m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(),
            vv = new THREE.Vector3(), ss = new THREE.Vector3();
        for (var j = 0; j < spots.length; j++) {
          var sb = spots[j];
          vv.set(sb[0], 0, sb[1]); ss.set(Math.max(3, sb[2]), Math.max(2.5, sb[4]), Math.max(3, sb[3]));
          m4.compose(vv, qq, ss); im.setMatrixAt(j, m4);
        }
        im.instanceMatrix.needsUpdate = true;
        ctxGroup.add(im);
      }
    } catch (e) {}
    // on-road violation cue: red highlight at the RAW spot
    var half = Math.max(b[2], b[3]) / 2;
    var rawOnRoad = false;
    try { rawOnRoad = qaNearest(b[0], b[1], 150).edge < half; } catch (e) {}
    if (rawOnRoad) {
      var red = new THREE.Mesh(new THREE.PlaneGeometry(b[2] + 4, b[3] + 4),
        new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
      red.rotation.x = -Math.PI / 2; red.position.set(b[0], 0.45, b[1]);
      ctxGroup.add(red);
      var ghost = new THREE.Mesh(new THREE.BoxGeometry(b[2], Math.max(2.5, b[4]), b[3]),
        new THREE.MeshBasicMaterial({ color: 0xff2a1a, wireframe: true }));
      ghost.position.set(b[0], Math.max(2.5, b[4]) / 2, b[1]);
      ctxGroup.add(ghost);
    }
    // editor-only street-name paint on nearby roads (never in the game)
    try {
      var lg = ROADLABELS.build({
        heightAt: function () { return 0.85; },
        cx: cx, cz: cz, radius: R + 60, labelH: 7
      });
      ctxGroup.add(lg);
    } catch (e) {}
    scene.add(ctxGroup);
    // placement status line
    var moved = gspot ? Math.hypot(gspot[0] - b[0], gspot[1] - b[1]) : 0;
    placeNote = !gspot ? '⚠ game DROPS this building (no clear spot within 30u)'
      : (moved > 0.5 ? '⚠ ON ROAD at OSM spot — game nudges it ' + moved.toFixed(0) + 'u to (' +
        Math.round(gspot[0]) + ', ' + Math.round(gspot[1]) + ')'
        : '✓ clear of roads at game position');
  }
  var placeNote = '';

  function curB(){ return ALL[list[li]]; }
  function bldgStreet(idx){
    try{
      if (typeof BLDG_STREET!=='undefined' && typeof BLDG_STREET_NAMES!=='undefined' &&
          idx>=0 && idx<BLDG_STREET.length) return BLDG_STREET_NAMES[BLDG_STREET[idx]];
    }catch(e){}
    return null;
  }
  function bldgLabel(b, idx){
    var st=bldgStreet(idx);
    return 'Building #'+idx+' · '+TYPE_NAMES[b[5]]+
      (st ? ' · '+st : '')+
      ' ('+Math.round(b[0])+', '+Math.round(b[1])+')';
  }
  function select(i){
    if (!list.length) return;
    li = ((i % list.length) + list.length) % list.length;
    P = defaultsFor(curB());
    applySaved(); // restore Joshua's saved placement / openings / colors
    rebuild(); buildPanel(); updateInfo();
  }
  var BLDG_NAMES={};
  try{ BLDG_NAMES=JSON.parse(localStorage.getItem('aw_bldg_names')||'{}'); }catch(e){}
  function saveBldgNames(){ try{ localStorage.setItem('aw_bldg_names', JSON.stringify(BLDG_NAMES)); }catch(e){} }
  function bldgName(idx){ return BLDG_NAMES[idx]||''; }
  function updateInfo(){
    if(!infoEl) return;
    infoEl.innerHTML='';
    var idx=list[li];
    infoEl.appendChild(el('div','', bldgLabel(curB(), idx)+' — showing '+(li+1)+' of '+list.length
      +(placeNote ? '\n'+placeNote : '')));
    var nrow=el('div',''); nrow.style.cssText='margin-top:6px;display:flex;gap:6px;align-items:center;';
    nrow.appendChild(el('label','','Name: '));
    var ninp=document.createElement('input'); ninp.type='text';
    ninp.value=bldgName(idx); ninp.placeholder='e.g. Shell, Waffle House…';
    ninp.style.cssText='background:#141b28;color:#fff;border:1px solid #2c384a;border-radius:8px;padding:5px 8px;font-size:13px;width:150px;';
    var nsave=el('button','cbtn','Save name');
    nsave.addEventListener('click',function(){
      var v=ninp.value.trim();
      if(v) BLDG_NAMES[idx]=v; else delete BLDG_NAMES[idx];
      saveBldgNames();
      // queue to outbox so the Settings badge lights up
      var md='# Building name — #'+idx+'\n\n- name: '+(v||'(cleared)')+'\n- type: '+bldgLabel(curB(),idx)+'\n';
      if(typeof submitFeedback==='function') submitFeedback('Building name — #'+idx, md, 'building-feedback');
      nsave.textContent='Saved ✓'; setTimeout(function(){ nsave.textContent='Save name'; },2000);
    });
    nrow.appendChild(ninp); nrow.appendChild(nsave); infoEl.appendChild(nrow);
  }
  function applyFilter(t){
    filt = t; list = [];
    for (var i=0;i<ALL.length;i++){ if (filt<0 || ALL[i][5]===filt) list.push(i); }
    select(0);
    var btns = document.querySelectorAll('#bldgpanel .abtn');
    for (var j=0;j<btns.length;j++){
      btns[j].classList.toggle('on', +btns[j].dataset.ft === filt);
    }
  }
  function nearLandmark(){
    // nearest building to a named POI in world.js
    try{
      if (typeof WORLD==='undefined' || !WORLD.pois || !WORLD.pois.length) return;
      var best=-1, bd=1e18, bi=-1;
      for (var p=0;p<WORLD.pois.length;p++){
        var q=WORLD.pois[p];
        for (var i=0;i<list.length;i++){
          var b=ALL[list[i]];
          var d=Math.hypot(b[0]-q.x, b[1]-q.z);
          if (d<bd){ bd=d; best=i; bi=p; }
        }
      }
      if (best>=0){ select(best); }
    }catch(e){}
  }

  /* ---------- recipe / submit ---------- */
  function r3(n){ return Math.round(n*1000)/1000; }
  function localDate(){ var d=new Date();
    return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
  function recipe(){
    var b=curB(), idx=list[li];
    var hexNum=function(h){ return '0x'+h.replace('#',''); };
    var wo=worldOffset();
    var openings=(P.openings||[]).map(function(o){
      return { kind:o.kind, wall:o.wall, alongWall:r3(o.at) };
    });
    return {
      buildingIndex: idx,
      mapCoords: { x: r3(b[0]), z: r3(b[1]) },
      type: TYPE_NAMES[b[5]],
      original: { w: r3(b[2]), d: r3(b[3]), h: r3(b[4]) },
      date: localDate(),
      notes: (notesEl?notesEl.value:'').trim(),
      params: { h:r3(P.h), w:r3(P.w), d:r3(P.d), roofH:r3(P.roofH), roofStyle:P.roofStyle },
      colors: { body:P.bodyColor, roof:P.roofColor },
      placement: {
        moveFwd: r3(P.moveF), moveSide: r3(P.moveS),
        worldOffset: { x: r3(wo.x), z: r3(wo.z) },
        rotationDeg: Math.round(P.rot*180/Math.PI)
      },
      openings: openings,
      game: { target:'www/osm_buildings.js → OSM_BUILDINGS['+idx+']',
        set:[r3(b[0]), r3(b[1]), r3(P.w), r3(P.d), r3(P.h), b[5]],
        move:[r3(wo.x), r3(wo.z)],
        rotationDeg: Math.round(P.rot*180/Math.PI),
        openings: openings,
        roof:{ style:P.roofStyle, height:r3(P.roofH), color:hexNum(P.roofColor) },
        bodyColor:hexNum(P.bodyColor) }
    };
  }
  function submit(){
    var rec=recipe(), b=curB();
    var bname=bldgName(rec.buildingIndex);
    var md='# Building feedback — #'+rec.buildingIndex+(bname?' ('+bname+')':'')+' ('+rec.type+') — '+rec.date+'\n\n'
      +'## Notes\n'+(rec.notes||'(no notes — proportions/colors only)')+'\n\n'
      +'## Recipe (JSON — rebuild verbatim in game code)\n```json\n'
      +JSON.stringify(rec,null,2)+'\n```\n';
    submitFeedback('Building feedback — #'+rec.buildingIndex+' ('+rec.type+')', md, 'building-feedback');
  }

  /* ---------- QA: pre-compile gate (Joshua's standing rule) ----------
     (1) roads verified, THEN (2) no buildings on the adjusted roads.
     On-road: footprint intersects a road corridor (game's own rule:
     distToRoadEdge < max(w,d)/2, corridor half-width = roadW/2 + 1.5).
     Facing: building front is +Z (game's door face). Wrong-facing = nearest
     road is outside the front 120-degree sector AND no parking lot
     (Joshua's refinement: front may face a parking lot that meets the street).
     Parking-lot exemptions are his call — per-row toggle, persisted. */
  var QA = { grid:null, onroad:[], rigOnroad:[], facing:[], done:false,
             running:false, parking:{} };
  try{ QA.parking=JSON.parse(localStorage.getItem('aw_bldg_parking')||'{}'); }catch(e){ QA.parking={}; }
  function saveParking(){ try{ localStorage.setItem('aw_bldg_parking',JSON.stringify(QA.parking)); }catch(e){} }
  // per-building saved edits (Joshua's save buttons — no auto-save)
  var EDITS={};
  try{ EDITS=JSON.parse(localStorage.getItem('aw_bldg_edits')||'{}'); }catch(e){ EDITS={}; }
  function saveEdits(){ try{ localStorage.setItem('aw_bldg_edits',JSON.stringify(EDITS)); }catch(e){} }
  function editKey(){ return 'b'+list[li]; } // building idx
  function applySaved(){
    var e=EDITS[editKey()]; if(!e) return;
    if(e.place){ P.moveF=e.place.f||0; P.moveS=e.place.s||0; P.rot=e.place.r||0; }
    if(e.colors){ P.bodyColor=e.colors.b; P.roofColor=e.colors.r; }
    if(e.openings){ P.openings=JSON.parse(JSON.stringify(e.openings)); }
  }
  var ROAD_HW=[12.5,7,5]; // per category 0 highway, 1 arterial, 2 local
  /* Programmatic game roads (pushed to roadDrawData, NOT in roads.js data).
     Must be in the QA grid or buildings near them never flag. Matches
     explore3d.js PLACE_EXTRA_ROADS. */
  var QA_EXTRA_ROADS=[
    { pts:[3711,2778, 3655,2780, 3605,2782, 3573,2784], hw:18.5 },  // I-20 connector
    { pts:[4116.3,3210.5, 4191.7,3247.5], hw:7 },                    // MLK deck
    { pts:[4116.3,3210.5, 4028.4,3167.2], hw:7 },                    // MLK ramp W
    { pts:[4191.7,3247.5, 4279.6,3290.8], hw:7 }                     // MLK ramp E
  ];
  var SEGS=[];
  function qaAddSeg(ax,az,bx,bz,hw,nm,map,cell){
    var si=SEGS.length;
    SEGS.push([ax,az,bx,bz,hw,nm]);
    var x0=Math.floor((Math.min(ax,bx)-hw)/cell),
        x1=Math.floor((Math.max(ax,bx)+hw)/cell),
        z0=Math.floor((Math.min(az,bz)-hw)/cell),
        z1=Math.floor((Math.max(az,bz)+hw)/cell);
    for(var cx=x0;cx<=x1;cx++)for(var cz=z0;cz<=z1;cz++){
      var k=cx+','+cz;
      (map[k]||(map[k]=[])).push(si);
    }
  }
  function qaBuildGrid(){
    if(QA.grid) return QA.grid;
    var cell=100, map={};
    (WORLD.roads||[]).forEach(function(r){
      var pts=r[2], hw=ROAD_HW[r[0]]||5, nm=r[1]||'';
      for(var i=0;i+3<pts.length;i+=2){
        qaAddSeg(pts[i],pts[i+1],pts[i+2],pts[i+3],hw,nm,map,cell);
      }
    });
    QA_EXTRA_ROADS.forEach(function(er){
      var p=er.pts;
      for(var i=0;i+3<p.length;i+=2){
        qaAddSeg(p[i],p[i+1],p[i+2],p[i+3],er.hw,'',map,cell);
      }
    });
    QA.grid={cell:cell,map:map}; return QA.grid;
  }
  function qaNearest(x,z,pad){
    var g=qaBuildGrid(), c=g.cell, best=1e9, bn=null, bnx=0, bnz=0, seen={};
    var x0=Math.floor((x-pad)/c),x1=Math.floor((x+pad)/c),
        z0=Math.floor((z-pad)/c),z1=Math.floor((z+pad)/c);
    for(var cx=x0;cx<=x1;cx++)for(var cz=z0;cz<=z1;cz++){
      var a=g.map[cx+','+cz]; if(!a) continue;
      for(var i=0;i<a.length;i++){
        var si=a[i]; if(seen[si]) continue; seen[si]=1;
        var s=SEGS[si];
        var vx=s[2]-s[0], vz=s[3]-s[1], len2=vx*vx+vz*vz;
        var t=len2>0?((x-s[0])*vx+(z-s[1])*vz)/len2:0;
        t=Math.max(0,Math.min(1,t));
        var px=s[0]+vx*t, pz=s[1]+vz*t;
        var d=Math.hypot(x-px,z-pz)-s[4];
        if(d<best){ best=d; bn=s[5]; bnx=px; bnz=pz; }
      }
    }
    return {edge:best, name:bn, nx:bnx, nz:bnz};
  }
  function qaFrontOk(x,z){
    // is there ANY road within 200u inside the front 120-degree sector?
    // (nearest-point-only would false-flag a building with roads both
    // ahead and to the side)
    var g=qaBuildGrid(), c=g.cell, pad=200, seen={};
    var bestAng=1e9, bestName=null, bestDist=1e9;
    var x0=Math.floor((x-pad)/c),x1=Math.floor((x+pad)/c),
        z0=Math.floor((z-pad)/c),z1=Math.floor((z+pad)/c);
    for(var cx=x0;cx<=x1;cx++)for(var cz=z0;cz<=z1;cz++){
      var a=g.map[cx+','+cz]; if(!a) continue;
      for(var i=0;i<a.length;i++){
        var si=a[i]; if(seen[si]) continue; seen[si]=1;
        var s=SEGS[si];
        var vx=s[2]-s[0], vz=s[3]-s[1], len2=vx*vx+vz*vz;
        var t=len2>0?((x-s[0])*vx+(z-s[1])*vz)/len2:0;
        t=Math.max(0,Math.min(1,t));
        var px=s[0]+vx*t, pz=s[1]+vz*t;
        var d=Math.hypot(x-px,z-pz);
        if(d>200) continue;
        var ang=Math.abs(Math.atan2(px-x,pz-z));
        if(ang<bestAng){ bestAng=ang; bestName=s[5]; bestDist=d; }
      }
    }
    return {ang:bestAng, name:bestName, dist:bestDist};
  }
  function qaRun(onDone){
    if(QA.running||QA.done){ if(QA.done&&onDone) onDone(); return; }
    QA.running=true;
    try{
      (WORLD.findings||[]).forEach(function(f){
        if(f[2]==='on-road') QA.rigOnroad.push(f);
      });
    }catch(e){}
    qaBuildGrid();
    var i=0, n=ALL.length, onroad=[], facing=[], skipped=0;
    function step(){
      var t0=Date.now();
      while(i<n && Date.now()-t0<50){
        var b=ALL[i];
        var half=Math.max(b[2],b[3])/2, need=half+4;
        // replicate the game's placement protocol: nudge to clear spot or skip
        var q=qaNearest(b[0],b[1],150);
        var px=b[0], pz=b[1], placed=true;
        if(q.edge<need){
          placed=false;
          for(var r=6;r<=30 && !placed;r+=6)for(var a=0;a<8 && !placed;a++){
            var nx=b[0]+Math.cos(a/8*Math.PI*2)*r, nz=b[1]+Math.sin(a/8*Math.PI*2)*r;
            var q2=qaNearest(nx,nz,150);
            if(q2.edge>=need){ px=nx; pz=nz; placed=true; q=q2; }
          }
        }
        if(!placed){ skipped++; }
        else if(q.edge<half){
          onroad.push({idx:i,b:b,edge:q.edge,need:half,name:q.name,px:px,pz:pz});
        } else {
          var fq=qaFrontOk(px,pz);
          if(fq.name!==null && fq.ang>Math.PI/3 && !QA.parking[i]){
            facing.push({idx:i,b:b,deg:Math.round(fq.ang*180/Math.PI),
              dist:Math.round(fq.dist),name:fq.name,px:px,pz:pz});
          }
        }
        i++;
      }
      qaStatus('checking buildings… '+i+' / '+n);
      if(i<n){ setTimeout(step,0); }
      else { QA.onroad=onroad; QA.facing=facing; QA.skipped=skipped;
             QA.done=true; QA.running=false;
             qaRender(); if(onDone) onDone(); }
    }
    step();
  }
  function qaStatus(t){ var s=document.getElementById('qastat'); if(s) s.textContent=t; }
  function qaSubmit(kind, item){
    var b=item.b, idx=item.idx, d=localDate();
    var title, body;
    if(kind==='onroad'){
      var ox=(item.px!==undefined?item.px:b[0]), oz=(item.pz!==undefined?item.pz:b[1]);
      title='Building feedback — #'+idx+' ON-ROAD — '+d;
      body='# Building feedback — #'+idx+' ('+TYPE_NAMES[b[5]]+') — '+d+'\n\n'
        +'## Violation: building on road\n'
        +'- coords: '+Math.round(ox)+', '+Math.round(oz)+' (game-placed position)\n'
        +'- footprint: '+b[2]+' x '+b[3]+'u, height '+b[4]+'u\n'
        +'- road: '+(item.name||'unnamed')+'\n'
        +'- detail: footprint edge '+item.edge.toFixed(1)+'u from road centerline vs need '+item.need.toFixed(1)+'u\n\n'
        +'## Requested fix\nMove/nudge the building off the road corridor (game placement protocol: spiral nudge up to 30u, else skip).\n';
    } else {
      var fx=(item.px!==undefined?item.px:b[0]), fz=(item.pz!==undefined?item.pz:b[1]);
      title='Building feedback — #'+idx+' WRONG-FACING — '+d;
      body='# Building feedback — #'+idx+' ('+TYPE_NAMES[b[5]]+') — '+d+'\n\n'
        +'## Violation: possibly wrong-facing\n'
        +'- coords: '+Math.round(fx)+', '+Math.round(fz)+' (game-placed position)\n'
        +'- footprint: '+b[2]+' x '+b[3]+'u, height '+b[4]+'u\n'
        +'- nearest road: '+(item.name||'unnamed')+' ('+item.dist+'u away, '+item.deg+'° off the front face)\n'
        +'- rule: front (+Z, entrance side) must face the street — or face a parking lot that meets the street\n\n'
        +'## Requested fix\nRotate the building so its entrance faces the road (or confirm it has a parking lot).\n';
    }
    submitFeedback(title, body, 'building-feedback');
  }
  function qaRow(kind, item, label){
    var row=el('div','qrow');
    var nm=el('a','qname',label);
    nm.href='#'; nm.title='Click to load this building in the 3D preview';
    nm.addEventListener('click',function(e){
      e.preventDefault();
      var pos=list.indexOf(item.idx);
      if(pos<0){ applyFilter(-1); pos=list.indexOf(item.idx); }
      if(pos>=0) select(pos);
    });
    row.appendChild(nm);
    if(kind==='facing'){
      var pl=el('button','qbtn','\uD83D\uDDFF lot');
      pl.title='Mark: this building has a parking lot (exempt from facing rule)';
      pl.addEventListener('click',function(){
        QA.parking[item.idx]=1; saveParking();
        QA.facing=QA.facing.filter(function(f){return f.idx!==item.idx;});
        qaRender();
      });
      row.appendChild(pl);
    }
    var go=el('button','qbtn','Submit \u2192');
    go.title='One-tap: open a pre-filled building-feedback issue for this building';
    go.addEventListener('click',function(){ qaSubmit(kind,item); });
    row.appendChild(go);
    var view=el('button','qbtn','View');
    view.title='Load this building in the 3D preview';
    view.addEventListener('click',function(){
      var pos=list.indexOf(item.idx);
      if(pos<0){ applyFilter(-1); pos=list.indexOf(item.idx); }
      if(pos>=0) select(pos);
    });
    row.appendChild(view);
    return row;
  }
  function qaRender(){
    var c=document.getElementById('qalist'); if(!c) return;
    c.innerHTML='';
    if(!QA.done){
      c.appendChild(el('div','chint','checks not run yet — opening…'));
      return;
    }
    var rsec=el('div','csec');
    rsec.appendChild(el('h4','','On-road — inspector rig confirmed ('+QA.rigOnroad.length+')'));
    if(!QA.rigOnroad.length) rsec.appendChild(el('div','chint','none'));
    QA.rigOnroad.forEach(function(f){
      var row=el('div','qrow');
      row.appendChild(el('span','','('+Math.round(f[0])+', '+Math.round(f[1])+') '+(f[5]||'')+' — '+f[6]));
      var go=el('button','qbtn','Submit \u2192');
      go.addEventListener('click',function(){
        var d=localDate();
        var url='https://github.com/kingmarkarnold-code/adamsville-watcher/issues/new'
          +'?title='+encodeURIComponent('Building feedback — ON-ROAD (rig) — '+d)
          +'&body='+encodeURIComponent('# Building feedback — inspector-rig on-road — '+d+'\n\n'
            +'## Violation: building on road (confirmed by inspector rig)\n'
            +'- coords: '+Math.round(f[0])+', '+Math.round(f[1])+'\n'
            +'- structure: '+(f[5]||'')+'\n- detail: '+f[6]+'\n\n'
            +'## Requested fix\nMove/nudge the structure off the road corridor.\n')
          +'&labels='+encodeURIComponent('building-feedback');
        window.open(url,'_blank');
      });
      row.appendChild(go); rsec.appendChild(row);
    });
    c.appendChild(rsec);
    var osec=el('div','csec');
    osec.appendChild(el('h4','','On-road — computed in this view ('+QA.onroad.length+')'));
    osec.appendChild(el('div','chint','Checked at game-placed positions (after the nudge protocol). '+
      (QA.skipped||0)+' buildings are dropped by the game itself (no clear spot) and not rendered.'));
    if(!QA.onroad.length) osec.appendChild(el('div','chint','none — no placed footprints intersect a road corridor'));
    QA.onroad.slice(0,200).forEach(function(it){
      var lx=(it.px!==undefined?it.px:it.b[0]), lz=(it.pz!==undefined?it.pz:it.b[1]);
      osec.appendChild(qaRow('onroad',it,
        '#'+it.idx+' '+TYPE_NAMES[it.b[5]]+' ('+Math.round(lx)+', '+Math.round(lz)+') — '+(it.name||'unnamed')));
    });
    if(QA.onroad.length>200) osec.appendChild(el('div','chint','…and '+(QA.onroad.length-200)+' more'));
    c.appendChild(osec);
    var fsec=el('div','csec');
    fsec.appendChild(el('h4','','Possibly wrong-facing ('+QA.facing.length+')'));
    fsec.appendChild(el('div','chint','Heuristic: front (+Z, entrance side) should face the street, or a parking lot that meets the street. Tap \uD83D\uDDFF lot to exempt a building that has one.'));
    if(!QA.facing.length) fsec.appendChild(el('div','chint','none'));
    QA.facing.slice(0,200).forEach(function(it){
      var lx=(it.px!==undefined?it.px:it.b[0]), lz=(it.pz!==undefined?it.pz:it.b[1]);
      fsec.appendChild(qaRow('facing',it,
        '#'+it.idx+' '+TYPE_NAMES[it.b[5]]+' ('+Math.round(lx)+', '+Math.round(lz)+') — '+(it.name||'unnamed')+' '+it.deg+'° off front'));
    });
    if(QA.facing.length>200) fsec.appendChild(el('div','chint','…and '+(QA.facing.length-200)+' more'));
    c.appendChild(fsec);
    qaStatus('checks complete: '+QA.onroad.length+' on-road, '+QA.facing.length+
      ' possibly wrong-facing'+(QA.rigOnroad.length?', '+QA.rigOnroad.length+' rig-confirmed':''));
  }

  /* ---------- panel ---------- */
  function buildPanel(){
    var panel=document.getElementById('bldgpanel'); panel.innerHTML='';
    panel.appendChild(el('div','chead','Buildings Studio'));
    // type filter
    var fr=el('div','arow');
    var mk=function(t,label){
      var b=el('button','abtn'+(filt===t?' on':''),label);
      b.dataset.ft=t; b.addEventListener('click',function(){ applyFilter(t); }); fr.appendChild(b);
    };
    mk(-1,'All'); mk(0,'Houses'); mk(1,'Commercial'); mk(2,'Apartments'); mk(3,'Other');
    panel.appendChild(fr);
    // selector row
    var sr=el('div','brow');
    var bPrev=el('button','cbtn','← Prev'), bNext=el('button','cbtn','Next →'),
        bRand=el('button','cbtn','🎲 Random'), bPoi=el('button','cbtn','📍 Near landmark');
    bPoi.title='Jump to the building closest to a named landmark (church, school, etc.). Not stuck — use ← Prev / Next → to keep browsing.';
    bPrev.addEventListener('click',function(){ select(li-1); });
    bNext.addEventListener('click',function(){ select(li+1); });
    bRand.addEventListener('click',function(){ select(Math.floor(Math.random()*list.length)); });
    bPoi.addEventListener('click',nearLandmark);
    sr.appendChild(bPrev); sr.appendChild(bNext); sr.appendChild(bRand); sr.appendChild(bPoi);
    panel.appendChild(sr);
    infoEl=el('div','chint',''); panel.appendChild(infoEl); updateInfo();
    panel.appendChild(el('div','chint',
      'Parametric editing: sliders change the building\u2019s numbers — not mesh sculpting. '+
      'Your recipe below is the exact spec Muse rebuilds in the game code.'));
    // sliders
    var groups={};
    SLIDERS.forEach(function(s){
      var g=groups[s.g];
      if(!g){
        g=groups[s.g]=el('div','csec');
        var gh=el('h4','cghead','');
        var collapsed=(s.g==='Structure'); // Structure starts collapsed; Colors stays open
        var body=el('div','cgbody');
        function paintHead(){ gh.innerHTML=(collapsed?'▶ ':'▼ ')+s.g; }
        paintHead();
        gh.style.cursor='pointer'; gh.title='Click to expand/collapse';
        gh.addEventListener('click',function(){ collapsed=!collapsed; paintHead(); body.style.display=collapsed?'none':''; });
        if(collapsed) body.style.display='none';
        g.appendChild(gh); g.appendChild(body);
        g._body=body;
      }
      var row=el('div','srow');
      var lab=el('label','',s.t+' <span></span>');
      var inp=document.createElement('input');
      inp.type='range'; inp.min=s.min; inp.max=s.max; inp.step=s.step; inp.value=P[s.k];
      var val=lab.querySelector('span');
      var upd=function(){ val.textContent=(+inp.value).toFixed(2).replace(/0+$/,'').replace(/\.$/,'.0'); };
      inp.addEventListener('input',function(){ P[s.k]=+inp.value; upd(); rebuild(); });
      upd(); row.appendChild(lab); row.appendChild(inp); g._body.appendChild(row);
    });
    ['Structure','Roof'].forEach(function(g){ if(groups[g]) panel.appendChild(groups[g]); });
    // roof style
    var rs=el('div','srow'); rs.appendChild(el('label','','Roof style'));
    var sel=document.createElement('select');
    ['pyramid','flat'].forEach(function(h){
      var o=document.createElement('option'); o.value=h;
      o.textContent=(h==='pyramid'?'pyramid (game default)':'flat slab'); sel.appendChild(o); });
    sel.value=P.roofStyle;
    sel.addEventListener('change',function(){ P.roofStyle=sel.value; rebuild(); });
    rs.appendChild(sel); if(groups.Roof) groups.Roof._body.appendChild(rs);
    // ---- move & rotate (Joshua's editor controls) ----
    var mg=el('div','csec'); mg.appendChild(el('h4','','Move & rotate'));
    // nudge pad: forward/left/right/back relative to the building's facing
    var pad=el('div',''); pad.style.cssText='display:grid;grid-template-columns:repeat(3,52px);gap:6px;justify-content:center;margin:6px 0;';
    [['','▲ Fwd',''],['◀ Left','Reset','Right ▶'],['','▼ Back','']].forEach(function(rw){
      rw.forEach(function(t){
        var b=el('button','cbtn',t);
        if(!t){ b.style.visibility='hidden'; }
        else b.addEventListener('click',function(){
          if(t==='Reset'){ P.moveF=0; P.moveS=0; }
          else if(t.indexOf('Fwd')>=0) P.moveF+=1;
          else if(t.indexOf('Back')>=0) P.moveF-=1;
          else if(t.indexOf('Left')>=0) P.moveS-=1;
          else if(t.indexOf('Right')>=0) P.moveS+=1;
          rebuild(); mvLab();
        });
        pad.appendChild(b);
      });
    });
    mg.appendChild(pad);
    var mvHint=el('div','chint','tap = nudge 1 unit'); mg.appendChild(mvHint);
    var mvStat=el('div','chint',''); mg.appendChild(mvStat);
    var mvLab=function(){ mvStat.textContent='offset: fwd '+P.moveF.toFixed(0)+'u, side '+P.moveS.toFixed(0)+'u'; };
    mvLab();
    // rotation: quick buttons + fine slider (degrees)
    var rrow=el('div',''); rrow.style.cssText='display:flex;gap:6px;margin:6px 0;';
    [['−90°',-90],['+90°',90],['180°',180]].forEach(function(rb){
      var b=el('button','cbtn',rb[0]);
      b.addEventListener('click',function(){ P.rot+=rb[1]*Math.PI/180; rotUpd(); rebuild(); });
      rrow.appendChild(b);
    });
    mg.appendChild(rrow);
    var frow=el('div','srow');
    var flab=el('label','','Fine rotate <span></span>'); frow.appendChild(flab);
    var finp=document.createElement('input'); finp.type='range';
    finp.min=-180; finp.max=180; finp.step=5; finp.value=Math.round(P.rot*180/Math.PI);
    var fval=flab.querySelector('span');
    var rotUpd=function(){
      var d=Math.round(P.rot*180/Math.PI);
      while(d>180)d-=360; while(d<=-180)d+=360;
      fval.textContent=d+'°'; finp.value=d;
    };
    finp.addEventListener('input',function(){ P.rot=(+finp.value)*Math.PI/180; rotUpd(); rebuild(); });
    rotUpd(); frow.appendChild(finp); mg.appendChild(frow);
    // windows & doors on wall faces
    mg.appendChild(el('h4','','Windows & doors'));
    var wrow=el('div','srow'); wrow.appendChild(el('label','','Wall'));
    var wsel=document.createElement('select');
    ['front','back','left','right'].forEach(function(w){
      var o=document.createElement('option'); o.value=w;
      o.textContent=w.charAt(0).toUpperCase()+w.slice(1)+(w==='front'?' (entrance side)':'');
      wsel.appendChild(o); });
    wsel.value=uiWall;
    wsel.addEventListener('change',function(){ uiWall=wsel.value; });
    wrow.appendChild(wsel); mg.appendChild(wrow);
    var arow=el('div','srow');
    var alab=el('label','','Along wall <span></span>'); arow.appendChild(alab);
    var ainp=document.createElement('input'); ainp.type='range';
    ainp.min=0; ainp.max=1; ainp.step=0.05; ainp.value=uiAlong;
    var aval=alab.querySelector('span');
    var aUpd=function(){ aval.textContent=(+ainp.value).toFixed(2); };
    ainp.addEventListener('input',function(){ uiAlong=+ainp.value; aUpd(); });
    aUpd(); arow.appendChild(ainp); mg.appendChild(arow);
    var orow=el('div',''); orow.style.cssText='display:flex;gap:6px;margin:6px 0;';
    [['＋ Window','window'],['＋ Door','door'],['＋ Sidewalk','sidewalk']].forEach(function(ob){
      var b=el('button','cbtn',ob[0]);
      b.addEventListener('click',function(){
        P.openings.push({kind:ob[1], wall:uiWall, at:uiAlong});
        oStat.textContent=P.openings.length+' opening(s) added'; rebuild();
      });
      orow.appendChild(b);
    });
    var bClear=el('button','cbtn','Clear');
    bClear.addEventListener('click',function(){
      P.openings=[]; oStat.textContent='openings cleared'; rebuild();
    });
    orow.appendChild(bClear); mg.appendChild(orow);
    var oStat=el('div','chint',P.openings.length+' opening(s) added'); mg.appendChild(oStat);
    var orow2=el('div',''); orow2.style.cssText='display:flex;gap:6px;margin:8px 0;';
    var bSaveO=el('button','cbtn','\uD83D\uDCBE Save windows/doors/sidewalk');
    bSaveO.title='Save this building\u2019s windows, doors and sidewalk';
    bSaveO.addEventListener('click',function(){
      var k=editKey(), e=EDITS[k]||{};
      e.openings=JSON.parse(JSON.stringify(P.openings)); EDITS[k]=e; saveEdits();
      bSaveO.textContent='\u2713 Saved'; setTimeout(function(){ bSaveO.textContent='\uD83D\uDCBE Save windows/doors/sidewalk'; },1500);
    });
    orow2.appendChild(bSaveO); mg.appendChild(orow2);
    // sidewalk nudge: move the last-added sidewalk into place
    var swrow=el('div',''); swrow.style.cssText='display:flex;gap:6px;margin:6px 0;align-items:center;flex-wrap:wrap;';
    swrow.appendChild(el('span','','Sidewalk nudge:'));
    var swStat=el('span','chint','');
    function lastWalk(){
      for(var i=P.openings.length-1;i>=0;i--) if(P.openings[i].kind==='sidewalk') return P.openings[i];
      return null;
    }
    [['\u25B2',0,-1],['\u25BC',0,1],['\u25C0',-1,0],['\u25B6',1,0]].forEach(function(d){
      var b=el('button','cbtn',d[0]);
      b.addEventListener('click',function(){
        var w=lastWalk(); if(!w){ swStat.textContent='add a sidewalk first'; return; }
        w.ox=(w.ox||0)+d[1]; w.oz=(w.oz||0)+d[2]; rebuild();
        swStat.textContent='offset '+w.ox+'u, '+w.oz+'u';
      });
      swrow.appendChild(b);
    });
    swrow.appendChild(swStat); mg.appendChild(swrow);
    panel.appendChild(mg);
    // colors
    var cg=el('div','csec'); cg.appendChild(el('h4','','Colors'));
    [['bodyColor','Body'],['roofColor','Roof']].forEach(function(c){
      var row=el('div','crow');
      row.appendChild(el('label','',c[1]));
      var inp=document.createElement('input'); inp.type='color'; inp.value=P[c[0]];
      inp.addEventListener('input',function(){ P[c[0]]=inp.value; rebuild(); });
      row.appendChild(inp); cg.appendChild(row);
    });
    var crow2=el('div',''); crow2.style.cssText='display:flex;gap:6px;margin:8px 0;';
    var bSaveC=el('button','cbtn','\uD83D\uDCBE Save colors');
    bSaveC.title='Save this building\u2019s colors';
    bSaveC.addEventListener('click',function(){
      var k=editKey(), e=EDITS[k]||{};
      e.colors={b:P.bodyColor, r:P.roofColor}; EDITS[k]=e; saveEdits();
      bSaveC.textContent='\u2713 Saved'; setTimeout(function(){ bSaveC.textContent='\uD83D\uDCBE Save colors'; },1500);
    });
    crow2.appendChild(bSaveC); cg.appendChild(crow2);
    panel.appendChild(cg);
    // QA — pre-compile gate
    var qg=el('div','csec'); qg.appendChild(el('h4','','QA — pre-compile gate'));
    qg.appendChild(el('div','chint',
      'Standing rule: (1) roads verified, THEN (2) no buildings on the adjusted roads. '+
      'The checks below run automatically against every building.'));
    var qs=el('div','chint',''); qs.id='qastat'; qg.appendChild(qs);
    var ql=el('div',''); ql.id='qalist'; qg.appendChild(ql);
    panel.appendChild(qg);
    qaRender();
    // notes + submit
    panel.appendChild(el('h4','','Notes for Muse'));
    notesEl=document.createElement('textarea');
    notesEl.placeholder='What should change about this building? (e.g. too tall for this street, wrong color\u2026)';
    panel.appendChild(notesEl);
    var bSub=el('button','csubmit','Submit building feedback \u2192');
    bSub.addEventListener('click',submit);
    panel.appendChild(bSub);
    panel.appendChild(el('div','cnote',
      'Submit opens a pre-filled GitHub issue (label building-feedback) — hit Submit there and it lands in the repo. Muse reads it before the next build.'));
  }

  /* ---------- three setup ---------- */
  function init(){
    var cv=document.getElementById('cbldg');
    renderer=new THREE.WebGLRenderer({canvas:cv,antialias:true});
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio||1));
    scene=new THREE.Scene(); scene.background=new THREE.Color(0x0b0e14);
    camera=new THREE.PerspectiveCamera(45,1,0.1,2000);
    scene.add(new THREE.AmbientLight(0xffffff,0.75));
    var sun=new THREE.DirectionalLight(0xffffff,0.75); sun.position.set(30,50,20); scene.add(sun);
    var ground=new THREE.Mesh(new THREE.PlaneGeometry(400,400),
      new THREE.MeshLambertMaterial({color:0x1d2b1f}));
    ground.rotation.x=-Math.PI/2; ground.position.y=-0.05; scene.add(ground);
    var grid=new THREE.GridHelper(120,24,0x2c384a,0x1a2230);
    grid.position.y=0; scene.add(grid);
    bindOrbit(cv);
    window.addEventListener('resize',resize);
    ALL=window.OSM_BUILDINGS||[];
    applyFilter(-1);
  }
  function resize(){
    var cv=document.getElementById('cbldg');
    var isNarrow=window.innerWidth<=700;
    var w=window.innerWidth, h=window.innerHeight;
    var pw=document.getElementById('bldgpanel');
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
      pitch=Math.max(-0.2,Math.min(1.3,pitch)); lx=e.clientX; ly=e.clientY; });
    var end=function(){ dragging=false; };
    canvas.addEventListener('pointerup',end); canvas.addEventListener('pointercancel',end);
    canvas.addEventListener('wheel',function(e){ e.preventDefault();
      dist=Math.max(6,Math.min(220,dist*(1+e.deltaY*0.001))); },{passive:false});
    canvas.addEventListener('touchmove',function(e){
      if(e.touches.length===2){ e.preventDefault();
        var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,
                         e.touches[0].clientY-e.touches[1].clientY);
        if(pinch0>0) dist=Math.max(6,Math.min(220,dist0*(pinch0/d)));
        else { pinch0=d; dist0=dist; }
      } },{passive:false});
    canvas.addEventListener('touchend',function(){ pinch0=0; });
    // tap (not drag): select neighbor building, or name the street
    var tapX=0, tapY=0, tapT=0;
    canvas.addEventListener('pointerdown',function(e){ tapX=e.clientX; tapY=e.clientY; tapT=Date.now(); });
    canvas.addEventListener('pointerup',function(e){
      if(Date.now()-tapT>400) return;
      if(Math.hypot(e.clientX-tapX,e.clientY-tapY)>12) return; // it was a drag
      handleTap(e);
    });
  }
  var rayc = new THREE.Raycaster();
  function handleTap(e){
    var rct = renderer.domElement.getBoundingClientRect();
    var mx = ((e.clientX-rct.left)/rct.width)*2-1, my = -((e.clientY-rct.top)/rct.height)*2+1;
    rayc.setFromCamera({x:mx,y:my}, camera);
    // 1. neighbor building?
    if (ctxGroup) {
      var hits = rayc.intersectObjects(ctxGroup.children, true);
      for (var hi=0; hi<hits.length; hi++) {
        var o = hits[hi].object;
        if (o.isInstancedMesh && ctxGroup.userData.spotIdx) {
          var bi = ctxGroup.userData.spotIdx[hits[hi].instanceId];
          if (bi!=null) {
            var pos = list.indexOf(bi);
            if (pos<0){ applyFilter(-1); pos=list.indexOf(bi); }
            if (pos>=0) select(pos);
            return;
          }
        }
      }
      // 2. street? use tap point on ground -> nearest named segment
      var gh = rayc.intersectObjects(ctxGroup.children, true);
      var gx=null, gz=null;
      for (var gi=0; gi<gh.length; gi++) {
        if (!gh[gi].object.isInstancedMesh) { gx=gh[gi].point.x; gz=gh[gi].point.z; break; }
      }
      if (gx!=null) {
        var best=null, bd=1e18;
        for (var si=0; si<SEGS.length; si++) {
          var sg=SEGS[si];
          var dx=sg[2]-sg[0], dz=sg[3]-sg[1], L2=dx*dx+dz*dz||1;
          var t=Math.max(0,Math.min(1,((gx-sg[0])*dx+(gz-sg[1])*dz)/L2));
          var px=sg[0]+dx*t, pz=sg[1]+dz*t;
          var d=Math.hypot(px-gx,pz-gz)-sg[4];
          if (d<bd){ bd=d; best=sg; }
        }
        if (best && bd<25) {
          var nm = best[5]||'(unnamed road)';
          if (infoEl) {
            infoEl.textContent = '\U0001F6E3\uFE0F ' + nm;
            infoEl.dataset.hold='1';
            setTimeout(function(){ if(infoEl.dataset.hold){ delete infoEl.dataset.hold; updateInfo(); } }, 3500);
          }
        }
      }
    }
  }
  var lastT=0;
  var autoRotate=true;
  function loop(t){
    if(!running) return;
    requestAnimationFrame(loop);
    var dt=Math.min(0.05,((t||0)-lastT)/1000||0.016); lastT=t||0;
    if(autoRotate) yaw+=dt*0.12;
    camera.position.set(
      tgtX+Math.sin(yaw)*Math.cos(pitch)*dist,
      tgtY+Math.sin(pitch)*dist,
      tgtZ+Math.cos(yaw)*Math.cos(pitch)*dist);
    camera.lookAt(tgtX,tgtY,tgtZ);
    renderer.render(scene,camera);
  }

  /* ---------- public ---------- */
  function ensure(){
    if(loaded) return Promise.resolve();
    if(loading) return loading;
    loading=loadScript('three.min.js')
      .then(function(){ return (typeof GameSync!=='undefined'
          ? GameSync.load('osm_buildings.js','osm_buildings.js')
          : loadScript('osm_buildings.js')); })
      .then(function(){ init(); loaded=true; })
      .catch(function(err){
        var p=document.getElementById('bldgpanel');
        if(p) p.innerHTML='<div class="chead">Buildings Studio</div><div class="cnote">Could not load 3D libraries: '+err.message+'. Check connection and retry.</div>';
        loading=null; throw err;
      });
    return loading;
  }
  function start(){ ensure().then(function(){ running=true; lastT=0; resize();
    var cv=renderer.domElement;
    if(cv&&!cv._arHook){
      cv._arHook=true;
      cv.addEventListener('pointerdown',function(){ autoRotate=false; });
    }
    requestAnimationFrame(loop);
      setTimeout(function(){ qaRun(); },400); })
    .catch(function(){}); }
  function stop(){ running=false; }

  return { ensure:ensure, start:start, stop:stop };
})();
