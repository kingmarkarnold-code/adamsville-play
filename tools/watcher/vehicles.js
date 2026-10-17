/* Adamsville Watcher — Vehicles Studio.
   3D preview + parametric editing for the game's vehicles.
   Types: the Main Van (Joshua's spec — 70s/80s full-size two-tone conversion
   van, brown + tan/gold, ALL doors openable with a visible interior) and the
   Sedan (the game's sedanMesh). Doors animate open/closed.
   The JSON recipe from "Submit vehicle feedback" is what Muse rebuilds
   verbatim in the game code. three.min.js lazy-loads on first open. */
window.VehStudio = (function () {
  'use strict';

  var TYPES = {
    van:   { label:'Main Van — your spec' },
    sedan: { label:'Sedan' },
    /* Live previews — built by the game's own vehicle_meshes.js (single source
       of truth, loaded from the published game). Paint/rim combos randomize. */
    boxchevy:    { label:'Box Chevy', preview:true,
      build:function(){ return boxChevyMesh(pickPaint('boxchevy','chrome'),'chrome'); } },
    bubblechevy: { label:'Bubble Chevy', preview:true,
      build:function(){ return bubbleChevyMesh(pickPaint('bubblechevy','chrome'),'chrome'); } },
    pickup:      { label:'Pickup', preview:true,
      build:function(){ return pickupMesh(pickPaint('pickup','chrome'),'chrome'); } },
    suv:         { label:'SUV', preview:true,
      build:function(){ return suvMesh(pickPaint('suv','chrome'),'chrome'); } },
    semi:        { label:'Semi', preview:true,
      build:function(){ return semiMesh(); } },
    martabus:    { label:'MARTA bus', preview:true,
      build:function(){ return martaBusMesh(); } },
    schoolbus:   { label:'School bus', preview:true,
      build:function(){ return schoolBusMesh(); } }
  };
  var ORDER = ['van','sedan','boxchevy','bubblechevy','pickup','suv','semi','martabus','schoolbus'];

  /* ---------- defaults ---------- */
  function vanDefaults(){ return {
    len:5.4, wid:2.0, lowerH:0.75, upperH:0.72, wheelR:0.42,
    colors:{ lower:'#6b4426', upper:'#d7a821', stripe:'#1c1c1e',
             glass:'#223140', interior:'#26262c', seat:'#4a3b2c' },
    doors:{ frontL:0, frontR:0, sideL:0, sideR:0, rearL:0, rearR:0 }
  }; }
  function sedanDefaults(){ return {
    len:4.6, wid:2.0, color:'#2e5fa3', wheelR:0.34
  }; }

  var VAN_SLIDERS = [
    {k:'len', g:'Body', t:'Length', min:4.5, max:6.5, step:0.1},
    {k:'wid', g:'Body', t:'Width', min:1.8, max:2.3, step:0.05},
    {k:'lowerH', g:'Body', t:'Lower band height', min:0.6, max:0.95, step:0.05},
    {k:'upperH', g:'Body', t:'Upper band height', min:0.55, max:0.95, step:0.05},
    {k:'wheelR', g:'Body', t:'Wheel size', min:0.32, max:0.5, step:0.02}
  ];
  var SEDAN_SLIDERS = [
    {k:'len', g:'Body', t:'Length', min:4.0, max:5.2, step:0.1},
    {k:'wid', g:'Body', t:'Width', min:1.8, max:2.2, step:0.05},
    {k:'wheelR', g:'Body', t:'Wheel size', min:0.28, max:0.42, step:0.02}
  ];
  var DOORS = [
    {k:'frontL', t:'Front left door'},
    {k:'frontR', t:'Front right door'},
    {k:'sideL', t:'Side door — front-hinged panel (passenger side)'},
    {k:'sideR', t:'Side door — rear-hinged panel (passenger side)'},
    {k:'rearL', t:'Rear left door'},
    {k:'rearR', t:'Rear right door'}
  ];

  /* ---------- state ---------- */
  var loaded=false, loading=null, running=false;
  var renderer, scene, camera, veh=null, doorGroups={};
  var yaw=0.7, pitch=0.18, dist=11, tgtY=1.1;
  var cur='van';
  var P=null, doorCur={};
  var seatView=false;   // driver's-seat camera (Joshua's sightline check)
  var notesEl=null, infoEl=null;

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
  function L(c){ return new THREE.MeshLambertMaterial({color:c}); }
  function box(w,h,d,mt,x,y,z){
    var m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mt);
    m.position.set(x,y,z); return m;
  }
  function hex(h){ return new THREE.Color(h).getHex(); }

  /* ================= VAN =================
     +Z forward; vehicle's LEFT = +X (US left-hand drive: driver at +X).
     Brown lower band, tan/gold upper band, dark dividing stripe.
     Doors: frontL/frontR hinged at front edge; sideL/sideR = PASSENGER-side
     (vehicle's RIGHT, x=-W/2) double swing doors (barn-door style, NOT a
     slider), each panel with its own open/close; rearL/rearR hinged at
     outer rear edges.
     Glass: transparent, double-sided (windshield, side + rear windows).
     Front: sloped hood + angled windshield — clear driver sightline.
     Interior always modeled. */
  function buildVan(){
    var g=new THREE.Group();
    var W=P.wid, VL=P.len, hL=VL/2, TH=0.08;
    var ly0=0.55, lh=P.lowerH, uy0=ly0+lh, uh=P.upperH;
    var M={ lower:L(hex(P.colors.lower)), upper:L(hex(P.colors.upper)),
            stripe:L(hex(P.colors.stripe)),
            glass:new THREE.MeshLambertMaterial({color:hex(P.colors.glass),transparent:true,opacity:0.35,side:THREE.DoubleSide}),
            dark:L(0x17171b), chrome:L(0x8a8f96) };
    var Mi={ inL:L(hex(P.colors.interior)), seat:L(hex(P.colors.seat)) };

    // wheels
    var wg=new THREE.CylinderGeometry(P.wheelR,P.wheelR,0.3,12); wg.rotateZ(Math.PI/2);
    var wm=L(0x1a1a1a), hm=L(0x9a9a9a);
    [[0.95,1.65],[-0.95,1.65],[0.95,-1.65],[-0.95,-1.65]].forEach(function(p){
      var w=new THREE.Mesh(wg,wm); w.position.set(p[0]*W/2,P.wheelR,p[1]*VL/5.4); g.add(w);
      var hub=new THREE.Mesh(new THREE.CylinderGeometry(P.wheelR*0.45,P.wheelR*0.45,0.32,10),hm);
      hub.rotation.z=Math.PI/2; hub.position.copy(w.position); g.add(hub);
    });
    // chassis shadow
    g.add(box(W-0.3,0.3,VL-0.6,M.dark,0,0.42,0));

    var lcy=ly0+lh/2, ucy=uy0+uh/2;
    function wallSeg(x,z,len,upper){ // side wall segment (static)
      g.add(box(TH,lh,len,M.lower,x,lcy,z));
      if(upper){
        g.add(box(TH,uh,len,M.upper,x,ucy,z));
        g.add(box(TH+0.012,uh-0.24,len-0.3,M.glass,x,ucy,z)); // window band
      } else {
        g.add(box(TH,uh,len,M.upper,x,ucy,z));
      }
    }
    // vehicle LEFT (x=+W/2, DRIVER side for US left-hand drive):
    // fender, FRONT DOOR gap, mid, rear quarter
    wallSeg(W/2, 2.1, 1.2, false);
    wallSeg(W/2, -0.35, 1.7, true);
    wallSeg(W/2, -1.95, 1.5, true);
    // vehicle RIGHT (x=-W/2, PASSENGER side for US left-hand drive):
    // fender, FRONT DOOR gap, DOUBLE-DOOR gap, rear quarter
    wallSeg(-W/2, 2.1, 1.2, false);
    wallSeg(-W/2, -1.8, 1.8, true);

    // side door builder (spans Z, faces ±X). hinge group origin at hinge edge.
    function sideDoor(len, hingeX, hingeZ, dirSign){
      var hg=new THREE.Group(); hg.position.set(hingeX,0,hingeZ);
      var inner=new THREE.Group(); hg.add(inner);
      // panel spans local z: 0..-len*dirSign (rearward from front hinge)
      var cz=-len*dirSign/2;
      inner.add(box(TH,lh,len,M.lower,0,lcy,cz));
      inner.add(box(TH,uh,len,M.upper,0,ucy,cz));
      inner.add(box(TH+0.012,uh-0.24,len-0.3,M.glass,0,ucy,cz));
      inner.add(box(0.05,0.06,0.3,M.dark,(hingeX>0?0.07:-0.07),lcy,-len*dirSign+dirSign*0.18)); // handle
      g.add(hg); return hg;
    }
    // front doors: hinge at front edge z=1.5, span z 1.5..0.5
    doorGroups.frontL=sideDoor(1.0,-W/2,1.5,1);
    doorGroups.frontR=sideDoor(1.0, W/2,1.5,1);
    // PASSENGER-side DOUBLE doors (barn-door style, NOT a slider) on the
    // vehicle's RIGHT (x=-W/2, US passenger side):
    // front-hinged panel hinged at z=0.5, rear-hinged panel hinged at z=-0.9.
    // Panels meet at z=-0.2. Each has its own open/close.
    function sidePanel(len, hingeZ, dirSign){
      var hg=new THREE.Group(); hg.position.set(-W/2,0,hingeZ);
      var inner=new THREE.Group(); hg.add(inner);
      var cz=-len*dirSign/2;
      inner.add(box(TH,lh,len,M.lower,0,lcy,cz));
      inner.add(box(TH,uh,len,M.upper,0,ucy,cz));
      inner.add(box(TH+0.012,uh-0.24,len-0.3,M.glass,0,ucy,cz));
      inner.add(box(0.05,0.06,0.3,M.dark,-0.07,lcy,-len*dirSign+dirSign*0.18)); // handle (outer face)
      g.add(hg); return hg;
    }
    doorGroups.sideL=sidePanel(0.7,0.5,1);    // front-hinged panel
    doorGroups.sideR=sidePanel(0.7,-0.9,-1);  // rear-hinged panel
    // rear doors at z=-hL: each spans half width
    function rearDoor(wdt, hingeX, dirSign){
      var hg=new THREE.Group(); hg.position.set(hingeX,0,-hL);
      var inner=new THREE.Group(); hg.add(inner);
      var cx=wdt*dirSign/2;
      inner.add(box(wdt,lh,TH,M.lower,cx,lcy,0));
      inner.add(box(wdt,uh,TH,M.upper,cx,ucy,0));
      inner.add(box(wdt-0.24,uh-0.24,TH+0.012,M.glass,cx,ucy,0));
      g.add(hg); return hg;
    }
    doorGroups.rearL=rearDoor(W/2,-W/2,1);
    doorGroups.rearR=rearDoor(W/2, W/2,-1);

    // front clip: sloped hood (dips toward the nose — stays below the
    // windshield base so the driver sightline is clear), grille, headlights,
    // bumper, angled transparent windshield
    var hood=box(W-0.12,0.3,1.1,M.lower,0,1.0,hL-0.55); hood.rotation.x=0.14; g.add(hood);
    g.add(box(W-0.5,0.3,0.1,M.dark,0,ly0+0.35,hL+0.01));           // grille
    [-1,1].forEach(function(s){
      var hl=new THREE.Mesh(new THREE.CylinderGeometry(0.14,0.14,0.08,12),L(0xf5f0d8));
      hl.rotation.x=Math.PI/2; hl.position.set(s*(W/2-0.3),ly0+0.42,hL+0.02); g.add(hl);
    });
    g.add(box(W+0.05,0.26,0.22,M.stripe,0,0.5,hL+0.05));            // bumper
    var shield=box(W-0.3,uh-0.1,0.06,M.glass,0,ucy,hL-0.75); shield.rotation.x=-0.26; g.add(shield);
    g.add(box(0.12,uh,0.3,M.upper,-(W/2-0.06),ucy,hL-0.62));        // A-pillars
    g.add(box(0.12,uh,0.3,M.upper, (W/2-0.06),ucy,hL-0.62));
    g.add(box(W-0.1,0.14,0.5,M.upper,0,uy0+uh-0.07,hL-0.55));      // header

    // roof + dividing stripes
    g.add(box(W,0.1,VL-0.15,M.upper,0,uy0+uh+0.05,-0.05));
    g.add(box(0.02,0.1,VL,M.stripe,-(W/2+0.005),ly0+lh,0));
    g.add(box(0.02,0.1,VL,M.stripe, (W/2+0.005),ly0+lh,0));

    // ---- interior (visible when doors open) ----
    var ig=new THREE.Group(); g.add(ig);
    ig.add(box(W-0.3,0.1,VL-0.6,Mi.inL,0,0.68,0));                  // floor
    ig.add(box(W-0.5,0.32,0.5,Mi.inL,0,1.06,1.55));               // dashboard
    var sw=new THREE.Mesh(new THREE.TorusGeometry(0.19,0.03,8,16),Mi.inL);
    sw.position.set(0.5,1.12,1.32); sw.rotation.x=-0.5; ig.add(sw);
    ig.add(box(0.06,0.3,0.06,Mi.inL,0.5,0.95,1.42));             // column
    [-0.5,0.5].forEach(function(sx){                              // front seats
      ig.add(box(0.55,0.16,0.55,Mi.seat,sx,0.86,0.9));
      ig.add(box(0.55,0.62,0.16,Mi.seat,sx,1.2,0.62));
    });
    [-0.5,-1.4].forEach(function(sz){                             // rear benches
      ig.add(box(W-0.7,0.4,0.62,Mi.seat,0,0.95,sz));
      ig.add(box(W-0.7,0.55,0.14,Mi.seat,0,1.3,sz-0.32));
    });

    for (var k in P.doors) doorCur[k]=doorCur[k]||0;
    return g;
  }

  function applyDoorPose(){
    if(!doorGroups.frontL) return;
    var d=doorCur;
    doorGroups.frontL.rotation.y= 1.15*d.frontL;
    doorGroups.frontR.rotation.y=-1.15*d.frontR;
    doorGroups.sideL.rotation.y= 1.5*d.sideL;   // front-hinged panel swings outward (passenger side)
    doorGroups.sideR.rotation.y=-1.5*d.sideR;   // rear-hinged panel swings outward (passenger side)
    doorGroups.rearL.rotation.y= 1.9*d.rearL;
    doorGroups.rearR.rotation.y=-1.9*d.rearR;
  }

  /* ================= SEDAN (game's sedanMesh) ================= */
  function buildSedan(){
    var g=new THREE.Group();
    var W=P.wid, VL=P.len, hL=VL/2;
    var bm=L(hex(P.color)),
        gm=new THREE.MeshLambertMaterial({color:0x1c2733,transparent:true,opacity:0.35,side:THREE.DoubleSide}),
        wm=L(0x181818);
    g.add(box(W,0.62,VL,bm,0,0.55,0)); g.userData={};
    g.add(box(W-0.25,0.5,VL*0.52,gm,0,1.12,-0.2));                 // glass cab
    var hood=box(W-0.1,0.14,VL*0.24,bm,0,0.92,hL-VL*0.12); g.add(hood);
    var wg=new THREE.CylinderGeometry(P.wheelR,P.wheelR,0.3,10); wg.rotateZ(Math.PI/2);
    [[0.95,1.5],[-0.95,1.5],[0.95,-1.5],[-0.95,-1.5]].forEach(function(p){
      var w=new THREE.Mesh(wg,wm);
      w.position.set(p[0]*(W/2),P.wheelR,p[1]*(VL/4.6)); g.add(w);
    });
    g.add(box(W+0.04,0.22,0.2,wm,0,0.42,hL));                    // bumpers
    g.add(box(W+0.04,0.22,0.2,wm,0,0.42,-hL));
    return g;
  }

  function rebuild(){
    if (veh) scene.remove(veh);
    doorGroups={};
    if (TYPES[cur].preview) {
      veh = null;
      try { veh = TYPES[cur].build(); } catch (e) { veh = null; }
      if (veh) scene.add(veh);
    } else {
      veh = (cur==='van') ? buildVan() : buildSedan();
      scene.add(veh);
      applyDoorPose();
    }
    tgtY=1.1; dist=Math.max(9,(P&&P.len?P.len:5.4)*2.0);
  }

  /* ---------- recipe / submit ---------- */
  function r3(n){ return Math.round(n*1000)/1000; }
  function localDate(){ var d=new Date();
    return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
  function recipe(){
    var hexNum=function(h){ return '0x'+h.replace('#',''); };
    var rec={ vehicle:cur, label:TYPES[cur].label, date:localDate(),
      notes:(notesEl?notesEl.value:'').trim() };
    if(cur==='van'){
      rec.params={ len:r3(P.len), wid:r3(P.wid), lowerH:r3(P.lowerH),
                   upperH:r3(P.upperH), wheelR:r3(P.wheelR) };
      rec.colors=clone(P.colors);
      rec.doors={ front:'driver + passenger, hinged at front edge — openable',
        side:'PASSENGER-side DOUBLE doors (two swing panels like barn doors, NOT a slider) — left + right panels, each openable independently',
        rear:'double rear doors, hinged at outer edges — openable',
        windshield:'angled windshield, transparent glass (see-through both sides); sloped hood — clear driver sightline, no solid box blocking the view',
        interior:'visible: floor, dashboard, steering wheel (left-hand drive), 2 front seats, 2 rear benches' };
      rec.game={ target:'www/index.html → safariMesh() — remodel to Joshua\u2019s spec van',
        spec:'70s/80s full-size conversion van, two-tone brown lower + tan/gold upper, dark dividing stripe',
        dims:clone(rec.params),
        colors:{ lower:hexNum(P.colors.lower), upper:hexNum(P.colors.upper),
                 stripe:hexNum(P.colors.stripe) },
        doors:'ALL doors openable (front L/R, passenger-side double doors L/R panels, rear L/R); transparent windshield + windows (see-through both sides); sloped hood, clear driver sightline; explorable interior; action menu: ENTER vehicle OR OPEN door (per door/panel)' };
    } else if (TYPES[cur].preview) {
      rec.params={ live:'game model from vehicle_meshes.js (synced automatically)' };
      rec.game={ target:'play/detailed/vehicle_meshes.js → '+cur+' builder',
        note:'live-synced game model; describe desired changes in notes' };
    } else {
      rec.params={ len:r3(P.len), wid:r3(P.wid), wheelR:r3(P.wheelR) };
      rec.colors={ body:P.color };
      rec.game={ target:'www/index.html → sedanMesh(color)',
        dims:clone(rec.params), color:hexNum(P.color) };
    }
    return rec;
  }
  function submit(){
    var rec=recipe();
    var md='# Vehicle feedback — '+rec.label+' — '+rec.date+'\n\n'
      +'## Notes\n'+(rec.notes||'(no notes — proportions/colors only)')+'\n\n'
      +'## Recipe (JSON — rebuild verbatim in game code)\n```json\n'
      +JSON.stringify(rec,null,2)+'\n```\n';
    submitFeedback('Vehicle feedback — '+rec.label+' — '+rec.date, md, 'vehicle-feedback');
  }

  /* ---------- panel ---------- */
  function buildPanel(){
    var panel=document.getElementById('vehpanel'); panel.innerHTML='';
    panel.appendChild(el('div','chead','Vehicles Studio'));
    var tr=el('div','arow');
    ORDER.forEach(function(t){
      var b=el('button','abtn'+(t===cur?' on':''),TYPES[t].label);
      b.addEventListener('click',function(){ switchType(t); }); tr.appendChild(b);
    });
    panel.appendChild(tr);
    // driver's-seat view: camera at the driver's head, looking forward
    // through the windshield — Joshua's sightline verification tool.
    var seatRow=el('div','arow');
    var bSeat=el('button','abtn','\uD83D\uDE91 Sit in driver\u2019s seat');
    bSeat.addEventListener('click',function(){
      seatView=!seatView;
      bSeat.textContent=seatView?'\uD83D\uDEAA Step out':'\uD83D\uDE91 Sit in driver\u2019s seat';
      bSeat.classList.toggle('on',seatView);
    });
    seatRow.appendChild(bSeat);
    panel.appendChild(seatRow);
    if(cur==='van'){
      panel.appendChild(el('div','chint',
        'Joshua\u2019s spec: 70s/80s full-size two-tone conversion van (brown + tan/gold). '+
        'Every door opens — toggle them below and look inside. In the game the action menu '+
        'will offer ENTER vehicle or OPEN door per door.'));
      var dg=el('div','csec'); dg.appendChild(el('h4','','Doors — tap to open/close'));
      DOORS.forEach(function(dr){
        var row=el('div','brow');
        var b=el('button','cbtn',(P.doors[dr.k]?'🔓 ':'🔒 ')+dr.t);
        b.addEventListener('click',function(){
          P.doors[dr.k]=P.doors[dr.k]?0:1;
          b.textContent=(P.doors[dr.k]?'🔓 ':'🔒 ')+dr.t;
        });
        row.appendChild(b); dg.appendChild(row);
      });
      var all=el('div','brow');
      var bO=el('button','cbtn','🔓 Open all'), bC=el('button','cbtn','🔒 Close all');
      bO.addEventListener('click',function(){ setAllDoors(1); buildPanel(); });
      bC.addEventListener('click',function(){ setAllDoors(0); buildPanel(); });
      all.appendChild(bO); all.appendChild(bC); dg.appendChild(all);
      panel.appendChild(dg);
    } else if (TYPES[cur].preview) {
      panel.appendChild(el('div','chint',
        'Live model from the game — synced automatically. Every Chevy paint/rim combo is one-of-a-kind in-game. Hit the dice for another combo, or describe changes below.'));
      var rr=el('div','brow');
      var bR=el('button','cbtn','🎲 New random paint/rim combo');
      bR.addEventListener('click',function(){ rebuild(); });
      rr.appendChild(bR); panel.appendChild(rr);
    } else {
      panel.appendChild(el('div','chint','The game\u2019s sedan (parked cars + traffic). Adjust and submit.'));
    }
    if (TYPES[cur].preview) { /* no parametric sliders for live game models */ }
    else {
    panel.appendChild(el('div','chint',
      'Parametric editing: sliders change the model\u2019s numbers — not mesh sculpting.'));
    var groups={};
    (cur==='van'?VAN_SLIDERS:SEDAN_SLIDERS).forEach(function(s){
      var g=groups[s.g]; if(!g){ g=groups[s.g]=el('div','csec'); g.appendChild(el('h4','',s.g)); }
      var row=el('div','srow');
      var lab=el('label','',s.t+' <span></span>');
      var inp=document.createElement('input');
      inp.type='range'; inp.min=s.min; inp.max=s.max; inp.step=s.step; inp.value=P[s.k];
      var val=lab.querySelector('span');
      var upd=function(){ val.textContent=(+inp.value).toFixed(2).replace(/0+$/,'').replace(/\.$/,'.0'); };
      inp.addEventListener('input',function(){ P[s.k]=+inp.value; upd(); rebuild(); });
      upd(); row.appendChild(lab); row.appendChild(inp); g.appendChild(row);
    });
    ['Body'].forEach(function(g){ if(groups[g]) panel.appendChild(groups[g]); });
    // colors
    var cg=el('div','csec'); cg.appendChild(el('h4','','Colors'));
    var cols = cur==='van'
      ? [['lower','Lower (brown)'],['upper','Upper (tan/gold)'],['stripe','Stripe']]
      : [['color','Body']];
    if(cur==='van') cols.push(['glass','Glass']);
    cols.forEach(function(c){
      var row=el('div','crow');
      row.appendChild(el('label','',c[1]));
      var inp=document.createElement('input'); inp.type='color';
      inp.value = cur==='van' ? P.colors[c[0]] : P[c[0]];
      inp.addEventListener('input',function(){
        if(cur==='van') P.colors[c[0]]=inp.value; else P[c[0]]=inp.value;
        rebuild();
      });
      row.appendChild(inp); cg.appendChild(row);
    });
    panel.appendChild(cg);
    } // end non-preview sliders/colors
    // notes + submit
    panel.appendChild(el('h4','','Notes for Muse'));
    notesEl=document.createElement('textarea');
    notesEl.placeholder = cur==='van'
      ? 'What should change about the van? (e.g. doors, colors, interior\u2026)'
      : (TYPES[cur].preview
        ? 'What should change about the '+TYPES[cur].label+'?'
        : 'What should change about the sedan?');
    panel.appendChild(notesEl);
    var bSub=el('button','csubmit','Submit vehicle feedback \u2192');
    bSub.addEventListener('click',submit);
    panel.appendChild(bSub);
    panel.appendChild(el('div','cnote',
      'Submit opens a pre-filled GitHub issue (label vehicle-feedback) — hit Submit there and it lands in the repo. Muse reads it before the next build.'));
  }
  function setAllDoors(v){ for(var k in P.doors) P.doors[k]=v; }
  function switchType(t){
    cur=t; seatView=false;
    P = (t==='van') ? vanDefaults() : (t==='sedan' ? sedanDefaults() : {len:5.4});
    doorCur={}; rebuild(); buildPanel();
  }

  /* ---------- three setup ---------- */
  function init(){
    var cv=document.getElementById('cveh');
    renderer=new THREE.WebGLRenderer({canvas:cv,antialias:true});
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio||1));
    scene=new THREE.Scene(); scene.background=new THREE.Color(0x0b0e14);
    camera=new THREE.PerspectiveCamera(45,1,0.1,2000);
    scene.add(new THREE.AmbientLight(0xffffff,0.8));
    var sun=new THREE.DirectionalLight(0xffffff,0.7); sun.position.set(20,30,15); scene.add(sun);
    var ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),
      new THREE.MeshLambertMaterial({color:0x141a20}));
    ground.rotation.x=-Math.PI/2; ground.position.y=-0.02; scene.add(ground);
    var grid=new THREE.GridHelper(60,20,0x2c384a,0x1a2230);
    grid.position.y=0; scene.add(grid);
    bindOrbit(cv);
    window.addEventListener('resize',resize);
    P=vanDefaults(); rebuild(); buildPanel();
  }
  function resize(){
    var cv=document.getElementById('cveh');
    var isNarrow=window.innerWidth<=700;
    var w=window.innerWidth, h=window.innerHeight;
    var pw=document.getElementById('vehpanel');
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
      dist=Math.max(4,Math.min(40,dist*(1+e.deltaY*0.001))); },{passive:false});
    canvas.addEventListener('touchmove',function(e){
      if(e.touches.length===2){ e.preventDefault();
        var d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,
                         e.touches[0].clientY-e.touches[1].clientY);
        if(pinch0>0) dist=Math.max(4,Math.min(40,dist0*(pinch0/d)));
        else { pinch0=d; dist0=dist; }
      } },{passive:false});
    canvas.addEventListener('touchend',function(){ pinch0=0; });
  }
  var lastT=0;
  function loop(t){
    if(!running) return;
    requestAnimationFrame(loop);
    var dt=Math.min(0.05,((t||0)-lastT)/1000||0.016); lastT=t||0;
    // door animation
    var moving=false;
    for(var k in P.doors){
      var tgt=P.doors[k]||0, cur2=doorCur[k]||0;
      if(Math.abs(tgt-cur2)>0.002){ doorCur[k]=cur2+(tgt-cur2)*Math.min(1,dt*5); moving=true; }
    }
    if(moving || !loop._posed){ applyDoorPose(); loop._posed=true; }
    if(seatView){
      // driver's head position, looking forward through the windshield
      var sp = cur==='van'
        ? {eye:[0.5,1.6,0.9],  look:[0.5,1.3,12]}
        : {eye:[-0.45,1.22,0.3], look:[-0.45,1.0,12]};
      camera.position.set(sp.eye[0],sp.eye[1],sp.eye[2]);
      camera.lookAt(sp.look[0],sp.look[1],sp.look[2]);
    } else {
      yaw+=dt*0.1;
      camera.position.set(
        Math.sin(yaw)*Math.cos(pitch)*dist,
        tgtY+Math.sin(pitch)*dist,
        Math.cos(yaw)*Math.cos(pitch)*dist);
      camera.lookAt(0,tgtY,0);
    }
    renderer.render(scene,camera);
  }

  /* ---------- public ---------- */
  function ensure(){
    if(loaded) return Promise.resolve();
    if(loading) return loading;
    loading=loadScript('three.min.js')
      .then(function(){
        return (typeof GameSync!=='undefined'
          ? GameSync.load('vehicle_meshes.js', null)   // live game vehicle models
          : Promise.resolve());
      })
      .then(function(){ init(); loaded=true; })
      .catch(function(err){
        var p=document.getElementById('vehpanel');
        if(p) p.innerHTML='<div class="chead">Vehicles Studio</div><div class="cnote">Could not load 3D libraries: '+err.message+'. Check connection and retry.</div>';
        loading=null; throw err;
      });
    return loading;
  }
  function start(){ ensure().then(function(){ running=true; lastT=0; resize(); requestAnimationFrame(loop); })
    .catch(function(){}); }
  function stop(){ running=false; }

  return { ensure:ensure, start:start, stop:stop };
})();
