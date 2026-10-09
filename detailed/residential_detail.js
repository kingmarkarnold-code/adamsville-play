/* ============================================================================
   RESIDENTIAL DETAIL PASS v1.0 (2026-10-09)
   Joshua: houses and apartments must actually LOOK like houses and apartments.
   + Parking structures (2026-10-09 addendum): garages / carports / driveways.

   Self-contained module. Runs AFTER the main osmBuildings IIFE.
   Depends on globals: THREE, scene, OSM_BUILDINGS, heightAt, gridSegsNear,
   distToRoadEdge, addBldgCollider, mulberry32, ROAD_DATA, Report, HOME.

   What it adds (all InstancedMesh — no per-house draw calls):
   - Houses (type 0): front door + windows on the STREET-FACING side, porch
     (slab + posts) on ~50%, garage OR carport OR driveway-only per house
     (deterministic ~35/25/40 split), driveway strip from street to house/garage,
     sidewalk strip along the street frontage.
   - Apartments (type 2, low/mid-rise): rows of doors, window grids, balconies
     with railings on upper floors, stairwell block, parking lot with painted
     space lines on the road side.
   - Entrance facing: every door faces the nearest road (or its parking lot).
   - Placement safety: garages/carports/lots verified against road clearance
     (distToRoadEdge) before placement; a final audit counts violations.

   NOT in this module (needs an edit inside the main osmBuildings IIFE):
   - Roof SHAPE variation (gable vs hip). The main IIFE already instanced a
     pyramid (hip) roof for every building; a second shape would double-roof.
     Edit spec for parent: inside osmBuildings(), split the roofs InstancedMesh
     into two (pyramid + gable prism), choosing per building by hash.
   ============================================================================ */
(function residentialDetail(){
'use strict';
try{
  if (typeof THREE==='undefined' || typeof scene==='undefined') return;
  if (typeof OSM_BUILDINGS==='undefined' || !OSM_BUILDINGS || !OSM_BUILDINGS.length) return;
  try{ if (typeof ensureRoadSurf==='function') ensureRoadSurf(); }catch(e){}

  var t0=Date.now();
  var stats={houses:0,apts:0,doors:0,wins:0,porches:0,garages:0,carports:0,
    driveways:0,walks:0,lots:0,lotLines:0,balconies:0,stairs:0,skipped:0,
    violations:0,heroSkipped:0};

  var HX=null,HZ=null;
  try{ if (typeof HOME!=='undefined'&&HOME){ HX=HOME.x; HZ=HOME.z; } }catch(e){}

  /* ---------- nearest road: direction (to road), tangent, edge dist, class -- */
  function roadInfo(x,z){
    var best=1e9, bdx=0, bdz=1, btx=1, btz=0, bcat=null;
    var segs=[];
    try{ segs=gridSegsNear(x,z,1); }catch(e){}
    var seen=null; try{ seen=new Set(); }catch(e){}
    for (var i=0;i<segs.length;i++){
      var s=segs[i];
      if (seen){ if(seen.has(s)) continue; seen.add(s); }
      var vx=s[2]-s[0], vz=s[3]-s[1], len2=vx*vx+vz*vz;
      var t=len2>0?((x-s[0])*vx+(z-s[1])*vz)/len2:0;
      t=Math.max(0,Math.min(1,t));
      var px=s[0]+vx*t, pz=s[1]+vz*t;
      var d=Math.hypot(x-px,z-pz)-(s[6]||0);
      if (d<best){
        best=d; bdx=px-x; bdz=pz-z; bcat=(s[8]!==undefined&&s[8]!==null)?s[8]:null;
        var L=Math.sqrt(len2)||1; btx=vx/L; btz=vz/L;
      }
    }
    var l=Math.hypot(bdx,bdz)||1;
    return {dx:bdx/l, dz:bdz/l, tx:btx, tz:btz, dist:best, cat:bcat};
  }

  /* ---------- re-derive kept placements (same protocol as osmBuildings) ---- */
  function bldgClear(x,z,need){
    var d=1e9;
    try{ d=distToRoadEdge(x,z); }catch(e){}
    return d>=need;
  }
  var kept=[];
  for (var i=0;i<OSM_BUILDINGS.length;i++){
    var b=OSM_BUILDINGS[i];
    if (!b || b.length<6) continue;
    var need=Math.max(b[2],b[3])/2+4;
    if (bldgClear(b[0],b[1],need)){ kept.push(b); continue; }
    var placed2=null;
    for (var r=6;r<=24 && !placed2;r+=6){
      for (var a=0;a<8 && !placed2;a++){
        var nx=b[0]+Math.cos(a/8*Math.PI*2)*r, nz=b[1]+Math.sin(a/8*Math.PI*2)*r;
        if (bldgClear(nx,nz,need)) placed2=[nx,nz];
      }
    }
    if (placed2) kept.push([placed2[0],placed2[1],b[2],b[3],b[4],b[5]]);
    else stats.skipped++;
  }

  /* ---------- detail op collectors ---------------------------------------- */
  // op: {x,y,z,yaw,sx,sy,sz,c}
  var doors=[], wins=[], porchSlabs=[], porchPosts=[], garages=[], garageDoors=[],
      carportRoofs=[], carportPosts=[], driveways=[], aptDoors=[], aptWins=[],
      balconies=[], balcRails=[], stairs=[], lots=[], lotLines=[], walks=[];

  function hash01(n){ var f=mulberry32((n*2654435761)|0); return f(); }

  // local (lx,lz) -> world, given building center (bx,bz) and facing yaw
  // (local +z faces the road)
  function l2w(bx,bz,yaw,lx,lz){
    var c=Math.cos(yaw), s=Math.sin(yaw);
    return [bx+lx*c+lz*s, bz-lx*s+lz*c];
  }

  var DOOR_COLS=[0x6b4a2f,0x4a5d3a,0x7a2e2e,0x3a4a5d,0x8a6d3b];
  var GAR_COLS=[0xd8d2c4,0xc9bfae,0xb5a88f,0xc4c0b4];
  var WIN_COL=0x2b3a4a;

  /* ================= HOUSES ================= */
  for (var k=0;k<kept.length;k++){
    var kb=kept[k];
    if (kb[5]!==0) continue;                        // houses only here
    if (HX!==null && Math.hypot(kb[0]-HX,kb[1]-HZ)<16){ stats.heroSkipped++; continue; } // hero house has own detail
    var bx=kb[0], bz=kb[1], bw=kb[2], bd=kb[3], bh=Math.max(2.5,kb[4]);
    var ri=roadInfo(bx,bz);
    if (ri.dist>1e8) continue;
    var yaw=Math.atan2(ri.dx,ri.dz);                // local +z faces the road
    var gy=0; try{ gy=heightAt(bx,bz); }catch(e){}
    var base=gy-0.6;
    var hsh=hash01(k);
    stats.houses++;

    // ---- front door (street-facing) ----
    var dp=l2w(bx,bz,yaw,0,bd/2+0.06);
    doors.push({x:dp[0],y:base,z:dp[1],yaw:yaw,sx:1.3,sy:2.3,sz:0.18,
      c:DOOR_COLS[Math.floor(hsh*DOOR_COLS.length)%DOOR_COLS.length]});
    stats.doors++;

    // ---- windows: front flanking door, sides, one back ----
    function winAt(lx,lz,faceYaw,w){
      var wp=l2w(bx,bz,yaw,lx,lz);
      wins.push({x:wp[0],y:base+1.7,z:wp[1],yaw:faceYaw,sx:w||1.15,sy:1.15,sz:0.12,c:WIN_COL});
      stats.wins++;
    }
    var fw=Math.min(2,Math.max(1,Math.floor(bw/6)));
    for (var wi=0;wi<fw;wi++){
      var off=(wi-(fw-1)/2)*Math.max(2.6,bw*0.32);
      winAt(off,bd/2+0.06,yaw);
    }
    var nside=Math.max(1,Math.floor(bd/7));
    for (var s2=0;s2<nside;s2++){
      var lz2=(s2-(nside-1)/2)*Math.max(3,bd*0.4);
      winAt(bw/2+0.06,lz2,yaw+Math.PI/2);
      winAt(-bw/2-0.06,lz2,yaw-Math.PI/2);
    }
    winAt(0,-bd/2-0.06,yaw+Math.PI);               // back

    // ---- porch: slab + posts, ~50% ----
    if (hsh<0.5){
      var pp=l2w(bx,bz,yaw,0,bd/2+1.25);
      porchSlabs.push({x:pp[0],y:base+0.17,z:pp[1],yaw:yaw,
        sx:Math.min(bw*0.7,6),sy:0.35,sz:2.4,c:0x9a968c});
      for (var pi=-1;pi<=1;pi+=2){
        var po=l2w(bx,bz,yaw,pi*Math.min(bw*0.32,2.6),bd/2+2.2);
        porchPosts.push({x:po[0],y:base+0.35,z:po[1],yaw:yaw,
          sx:0.22,sy:2.5,sz:0.22,c:0xd8d2c4});
      }
      stats.porches++;
    }

    // ---- parking structure: garage 35% / carport 25% / driveway-only 40% --
    var gx=bw/2+2.7;                               // garage/carport side offset (local +x)
    var gp=l2w(bx,bz,yaw,gx,0);
    var gClear=false;
    try{ gClear=distToRoadEdge(gp[0],gp[1])>=7; }catch(e){}
    var ptype=hsh<0.35?'garage':(hsh<0.60?'carport':'drive');
    var lat=0;                                     // driveway lateral offset (local x)
    if (ptype==='garage' && gClear){
      garages.push({x:gp[0],y:base,z:gp[1],yaw:yaw,sx:5.2,sy:3.2,sz:6.4,
        c:GAR_COLS[Math.floor(hsh*7)%GAR_COLS.length]});
      var gd=l2w(bx,bz,yaw,gx,3.28);
      garageDoors.push({x:gd[0],y:base+1.25,z:gd[1],yaw:yaw,
        sx:4.4,sy:2.5,sz:0.14,c:0xe8e4da});
      try{ addBldgCollider(gp[0],gp[1],3.6); }catch(e){}
      stats.garages++;
      lat=gx;
    } else if (ptype==='carport' && gClear){
      carportRoofs.push({x:gp[0],y:base+3.1,z:gp[1],yaw:yaw,
        sx:5.6,sy:0.28,sz:6.8,c:0x6b6f75});
      for (var cx2=-1;cx2<=1;cx2+=2) for (var cz2=-1;cz2<=1;cz2+=2){
        var cp=l2w(bx,bz,yaw,gx+cx2*2.5,cz2*3.1);
        carportPosts.push({x:cp[0],y:base,z:cp[1],yaw:yaw,
          sx:0.24,sy:3.0,sz:0.24,c:0x8a8f96});
      }
      stats.carports++;
      lat=gx;
    }
    // ---- driveway: street -> house/garage ----
    if (ri.dist<45){
      var e2x=bx+ri.dx*ri.dist, e2z=bz+ri.dz*ri.dist;   // road edge point
      var lo=l2w(0,0,yaw,lat,0);                        // lateral shift (world)
      var ax2=e2x+lo[0], az2=e2z+lo[1];                 // near end (road side)
      var fx2=bx+ri.dx*(bd/2-1)+lo[0], fz2=bz+ri.dz*(bd/2-1)+lo[1]; // far end (house side)
      var dlen=Math.hypot(ax2-fx2,az2-fz2)+1;
      if (dlen>2.5 && dlen<60){
        driveways.push({x:(ax2+fx2)/2,y:0,z:(az2+fz2)/2,
          yaw:Math.atan2(ri.dx,ri.dz),sx:3.2,sy:0.14,sz:dlen,c:0xb0aca2});
        // set y from terrain at center
        try{ driveways[driveways.length-1].y=heightAt((ax2+fx2)/2,(az2+fz2)/2)+0.06; }catch(e){}
        stats.driveways++;
      }
    }

    // ---- sidewalk strip along street frontage (local roads only) ----
    if ((ri.cat==='local'||ri.cat===null) && ri.dist<45){
      var swx=bx+ri.dx*(ri.dist-1.4), swz=bz+ri.dz*(ri.dist-1.4);
      var swYaw=Math.atan2(ri.tx,ri.tz);
      var swy=0; try{ swy=heightAt(swx,swz); }catch(e){}
      walks.push({x:swx,y:swy+0.1,z:swz,yaw:swYaw,
        sx:2.2,sy:0.15,sz:Math.min(bw+10,26),c:0xb9b5ab});
      stats.walks++;
    }
  }

  /* ================= APARTMENTS ================= */
  for (var k2=0;k2<kept.length;k2++){
    var ab=kept[k2];
    if (ab[5]!==2) continue;
    var ax=ab[0], az=ab[1], aw=ab[2], ad=ab[3], ah=Math.max(2.5,ab[4]);
    if (ah>35 || Math.max(aw,ad)>60) continue;      // towers: skip unit detail
    var ri2=roadInfo(ax,az);
    if (ri2.dist>1e8) continue;
    var yaw2=Math.atan2(ri2.dx,ri2.dz);
    var gy2=0; try{ gy2=heightAt(ax,az); }catch(e){}
    var base2=gy2-0.6;
    var hsh2=hash01(k2+7919);
    stats.apts++;

    function awinAt(lx,lz,ly,w2){
      var wp=l2w(ax,az,yaw2,lx,lz);
      aptWins.push({x:wp[0],y:ly,z:wp[1],yaw:yaw2,sx:w2||1.2,sy:1.2,sz:0.12,c:WIN_COL});
      stats.wins++;
    }
    // doors: row across front
    var nd=Math.max(1,Math.floor(aw/7));
    for (var di=0;di<nd;di++){
      var dx2=(di-(nd-1)/2)*Math.max(5,aw/Math.max(1,nd));
      var dp2=l2w(ax,az,yaw2,dx2,ad/2+0.06);
      aptDoors.push({x:dp2[0],y:base2,z:dp2[1],yaw:yaw2,sx:1.3,sy:2.3,sz:0.18,
        c:DOOR_COLS[Math.floor(hsh2*DOOR_COLS.length)%DOOR_COLS.length]});
      stats.doors++;
    }
    // window grid (front), capped
    var cols=Math.max(2,Math.floor(aw/4.5)), rows=Math.min(10,Math.floor(ah/3.2));
    var wcount=0;
    for (var r3=0;r3<rows && wcount<48;r3++){
      for (var c3=0;c3<cols && wcount<48;c3++){
        var lx3=(c3-(cols-1)/2)*(aw/Math.max(1,cols))*0.92;
        awinAt(lx3,ad/2+0.06,base2+3.4+r3*3.2);
        wcount++;
      }
    }
    // balconies on upper floors
    if (ah>=7){
      var bcount=0;
      var floors=Math.floor((ah-3)/3.2), units=Math.max(1,Math.floor(aw/7));
      for (var f=1;f<=floors && bcount<24;f++){
        for (var u=0;u<units && bcount<24;u++){
          var lx4=(u-(units-1)/2)*Math.max(5,aw/Math.max(1,units));
          var bp=l2w(ax,az,yaw2,lx4,ad/2+0.95);
          var by=base2+3.3*f;
          balconies.push({x:bp[0],y:by,z:bp[1],yaw:yaw2,sx:3.0,sy:0.25,sz:1.7,c:0xcac4b8});
          var rp=l2w(ax,az,yaw2,lx4,ad/2+1.78);
          balcRails.push({x:rp[0],y:by+0.55,z:rp[1],yaw:yaw2,sx:3.0,sy:0.9,sz:0.08,c:0x4a4d52});
          bcount++; stats.balconies++;
        }
      }
    }
    // stairwell block on the side
    var stx=aw/2+1.8;
    var sp=l2w(ax,az,yaw2,stx,0);
    var stClear=false;
    try{ stClear=distToRoadEdge(sp[0],sp[1])>=6; }catch(e){}
    if (ah>=8 && stClear){
      stairs.push({x:sp[0],y:base2,z:sp[1],yaw:yaw2,sx:3.2,sy:ah,sz:3.2,c:0x9a938a});
      try{ addBldgCollider(sp[0],sp[1],2.6); }catch(e){}
      stats.stairs++;
    }
    // parking lot on the road side
    if (Math.max(aw,ad)>=16){
      var lotD=15, lotW=aw*1.3;
      var lotCx=ax+ri2.dx*(ad/2+lotD/2+2), lotCz=az+ri2.dz*(ad/2+lotD/2+2);
      var lotClear=false;
      try{ lotClear=distToRoadEdge(lotCx,lotCz)>=lotD/2+2; }catch(e){}
      if (lotClear){
        var lotY=0; try{ lotY=heightAt(lotCx,lotCz); }catch(e){}
        lots.push({x:lotCx,y:lotY+0.05,z:lotCz,yaw:yaw2,sx:lotW,sy:0.14,sz:lotD,c:0x3f4145});
        stats.lots++;
        // painted space lines along the far edge
        var nlines=Math.floor(lotW/3);
        for (var li2=0;li2<nlines;li2++){
          var lx5=(li2-(nlines-1)/2)*3;
          var lp=l2w(lotCx,lotCz,yaw2,lx5,-lotD/2+3);
          lotLines.push({x:lp[0],y:lotY+0.14,z:lp[1],yaw:yaw2,
            sx:0.18,sy:0.03,sz:5.5,c:0xd8d8d8});
          stats.lotLines++;
        }
      }
    }
    // sidewalk frontage
    if ((ri2.cat==='local'||ri2.cat===null) && ri2.dist<45){
      var swx2=ax+ri2.dx*(ri2.dist-1.4), swz2=az+ri2.dz*(ri2.dist-1.4);
      var swy2=0; try{ swy2=heightAt(swx2,swz2); }catch(e){}
      walks.push({x:swx2,y:swy2+0.1,z:swz2,yaw:Math.atan2(ri2.tx,ri2.tz),
        sx:2.2,sy:0.15,sz:Math.min(aw+10,30),c:0xb9b5ab});
      stats.walks++;
    }
  }

  /* ---------- build InstancedMeshes (one per detail type) ---------- */
  var meshSpecs=[
    [doors,'doors'],[wins,'wins'],[porchSlabs,'porchSlabs'],[porchPosts,'porchPosts'],
    [garages,'garages'],[garageDoors,'garageDoors'],
    [carportRoofs,'carportRoofs'],[carportPosts,'carportPosts'],
    [driveways,'driveways'],[aptDoors,'aptDoors'],[aptWins,'aptWins'],
    [balconies,'balconies'],[balcRails,'balcRails'],[stairs,'stairs'],
    [lots,'lots'],[lotLines,'lotLines'],[walks,'walks']
  ];
  var YAXIS=new THREE.Vector3(0,1,0);
  meshSpecs.forEach(function(spec){
    var list=spec[0];
    if (!list.length) return;
    var geo=new THREE.BoxGeometry(1,1,1);
    geo.translate(0,0.5,0);
    var mesh=new THREE.InstancedMesh(geo,
      new THREE.MeshLambertMaterial({color:0xffffff}), list.length);
    var m4=new THREE.Matrix4(), q=new THREE.Quaternion(),
        sv=new THREE.Vector3(), pv=new THREE.Vector3(), col=new THREE.Color();
    for (var i=0;i<list.length;i++){
      var o=list[i];
      pv.set(o.x,o.y,o.z); sv.set(o.sx,o.sy,o.sz);
      q.setFromAxisAngle(YAXIS,o.yaw||0);
      m4.compose(pv,q,sv);
      mesh.setMatrixAt(i,m4);
      col.set(o.c);
      try{ mesh.setColorAt(i,col); }catch(e){}
    }
    mesh.count=list.length;
    mesh.instanceMatrix.needsUpdate=true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate=true;
    try{ mesh.frustumCulled=false; }catch(e){}
    scene.add(mesh);
  });

  /* ---------- post-placement audit: nothing new on a road ---------- */
  try{
    var checkLists=[['garage',garages,4],['carport',carportRoofs,4],
      ['lot',lots,8],['stair',stairs,3],['driveway',driveways,2]];
    checkLists.forEach(function(entry){
      var list=entry[1], need=entry[2];
      for (var i=0;i<list.length;i++){
        var o=list[i], d=1e9;
        try{ d=distToRoadEdge(o.x,o.z); }catch(e){}
        if (d<need) stats.violations++;
      }
    });
  }catch(e){}

  try{
    Report.setSys('residentialDetail',{
      houses:stats.houses, apartments:stats.apts,
      doors:stats.doors, windows:stats.wins, porches:stats.porches,
      garages:stats.garages, carports:stats.carports, driveways:stats.driveways,
      sidewalks:stats.walks, parkLots:stats.lots, lotLines:stats.lotLines,
      balconies:stats.balconies, stairs:stats.stairs,
      skippedRoad:stats.skipped, heroSkipped:stats.heroSkipped,
      postViolations:stats.violations,
      ms:Date.now()-t0, status:'ok',
      note:'roof SHAPE variation deferred — needs edit inside main osmBuildings IIFE (see file header)'
    });
  }catch(e){}
}catch(e){ try{ Report.noteError('residentialDetail','build failed',String(e&&e.stack||e)); }catch(x){} }
})();
