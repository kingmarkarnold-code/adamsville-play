/* ============================================================================
   SURVIVING ADAMSVILLE — GPS / Wayfinding Navigation (gps_system.js)
   ============================================================================
   Expert report #27 (Thomas Wright, Level Designer — Joshua approved
   2026-10-11): the game had no navigation. Players got lost in a city
   this size. This module adds a simple GPS:

     1. SET DESTINATION — tap the full map in "navigate" mode, or pick a
        landmark. Destination snaps to the nearest road (never grass —
        Joshua's standing rule: no cutting across terrain).
     2. ROUTE — A* over the #7 junction graph (grade/heading-checked
        nodes + road segments). Follows real roads only.
     3. DISPLAY — route line on the minimap + full map (cyan), a 3D
        floating route ribbon, a pulsing destination beacon, and a
        direction arrow above the player pointing at the next waypoint.
     4. GUIDANCE — distance-to-destination readout + "Arrived!" on arrival.

   This is a sim game, not a driving sim: no turn-by-turn voice, no lane
   guidance — just a clear line to follow and an arrow when the minimap
   isn't open.

   PERFORMANCE: routing graph built once at init (~2k nodes). A* runs only
   when the destination changes. Per-frame cost is one arrow orientation +
   one beacon pulse — negligible.

   DEPENDENCIES (boot-poll guarded, never throws):
     - window.TRAFFIC.jx + .roads  (junction graph, expert #7)
     - THREE, scene, player, car    (3D route ribbon + beacon + arrow)
     - showToast()                 (arrival / status messages)
     - drawMinimap/drawFullMap hooks added in index.html call
       GPS.drawMinimapRoute(mm, toMap) / GPS.drawFullMapRoute(g, M)

   Documentation comments are required on all game code — Joshua's rule.
   ============================================================================ */
(function(){
'use strict';

/* ---------------------------------------------------------------------------
   Boot: wait for the junction graph, the 3D scene, and the player object.
   Same boot-poll pattern as traffic_system.js — quiet give-up, never breaks
   the game if deps never arrive (e.g. traffic disabled in launch options).
   --------------------------------------------------------------------------- */
var bootTries=0;
var bootTimer=setInterval(function(){
  if (window.__launchOpts && window.__launchOpts.traffic===false){
    try{clearInterval(bootTimer);}catch(e){} return;
  }
  bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined' && typeof scene!=='undefined' &&
      typeof player!=='undefined' &&
      window.TRAFFIC && window.TRAFFIC.jx && window.TRAFFIC.roads &&
      window.TRAFFIC.roads.length>10);
  }catch(e){ ready=false; }
  if (ready){
    try{ initGPS(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('gps','init failed',String(e&&e.message||e)); }catch(x){}
    }
    clearInterval(bootTimer);
  } else if (bootTries>240){
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('gps','boot-timeout','deps never ready'); }catch(e){}
  }
},500);

/* ---------------------------------------------------------------------------
   State
   --------------------------------------------------------------------------- */
var G=null;   // routing graph, built once
var route=null;        // {pts:[{x,z}...], destX, destZ, destName, dist}
var pickMode=false;    // full-map tap sets destination instead of closing
var routeLine=null;    // THREE.Line (3D route ribbon)
var beacon=null;       // destination beacon mesh
var arrow=null;        // direction arrow above player
var arrowT=0;
var lastArriveCheck=0;

/* ---------------------------------------------------------------------------
   buildRoutingGraph(roads, jx) — adjacency over junction nodes.
   Nodes: TR.jx.nodes indices. Edges: consecutive junction points along each
   road (endpoints via endNode + mid-segment crossings via crossByRoad,
   sorted by arc position). Bidirectional, weighted by arc distance.
   Each edge remembers its road + arc range so we can rebuild the exact
   road-following polyline for display.
   --------------------------------------------------------------------------- */
function buildRoutingGraph(roads, jx){
  var adj={};   // nodeIdx -> [{to, w, ri, tA, tB}]
  function addEdge(a,b,w,ri,tA,tB){
    (adj[a]=adj[a]||[]).push({to:b, w:w, ri:ri, tA:tA, tB:tB});
    (adj[b]=adj[b]||[]).push({to:a, w:w, ri:ri, tA:tB, tB:tA});
  }
  var nIsolated=0;
  for (var ri=0; ri<roads.length; ri++){
    var R=roads[ri];
    var pts=[];   // {segT, node}
    var n0=jx.endNode[ri+':0'], n1=jx.endNode[ri+':1'];
    if (n0!==undefined) pts.push({segT:0, node:n0});
    if (n1!==undefined) pts.push({segT:R.len, node:n1});
    var cl=jx.crossByRoad[ri]||[];
    for (var k=0;k<cl.length;k++) pts.push({segT:cl[k].segT, node:cl[k].node});
    if (!pts.length){ nIsolated++; continue; }
    pts.sort(function(a,b){ return a.segT-b.segT; });
    // dedupe consecutive same-node entries (merged crossings)
    var w2=[], lastN=-1;
    for (var q=0;q<pts.length;q++){
      if (pts[q].node===lastN) continue;
      w2.push(pts[q]); lastN=pts[q].node;
    }
    for (var i2=0;i2<w2.length-1;i2++){
      var A=w2[i2], B=w2[i2+1];
      var wgt=Math.abs(B.segT-A.segT);
      if (wgt<0.5) continue;
      addEdge(A.node, B.node, wgt, ri, A.segT, B.segT);
    }
  }
  // node positions for the heuristic + spatial hash
  var nodePos=jx.nodes.map(function(N){ return {x:N.x, z:N.z}; });
  return {adj:adj, nodePos:nodePos, nNodes:jx.nodes.length, nIsolated:nIsolated};
}

/* ---------------------------------------------------------------------------
   Spatial hash of junction nodes for nearest-node lookup.
   --------------------------------------------------------------------------- */
var nodeGrid=null, NCELL=200;
function buildNodeGrid(nodePos){
  var grid={};
  for (var i=0;i<nodePos.length;i++){
    var k=Math.floor(nodePos[i].x/NCELL)+','+Math.floor(nodePos[i].z/NCELL);
    (grid[k]=grid[k]||[]).push(i);
  }
  nodeGrid=grid;
}
function nearestNode(x, z, maxD){
  maxD=maxD||1200;
  var gx=Math.floor(x/NCELL), gz=Math.floor(z/NCELL);
  var best=-1, bd=maxD*maxD;
  var R2=Math.ceil(maxD/NCELL);
  for (var ix=gx-R2;ix<=gx+R2;ix++) for (var iz=gz-R2;iz<=gz+R2;iz++){
    var a=nodeGrid[ix+','+iz]; if(!a) continue;
    for (var i=0;i<a.length;i++){
      var ni=a[i], p=G.nodePos[ni];
      var dx=p.x-x, dz=p.z-z, d2=dx*dx+dz*dz;
      if (d2<bd){ bd=d2; best=ni; }
    }
  }
  return best;
}

/* ---------------------------------------------------------------------------
   astar(start, goal) — standard A* with Euclidean heuristic.
   Returns array of node indices, or null if unreachable.
   --------------------------------------------------------------------------- */
function astar(start, goal){
  var adj=G.adj, pos=G.nodePos;
  var gx=pos[goal].x, gz=pos[goal].z;
  function h(n){
    var dx=pos[n].x-gx, dz=pos[n].z-gz;
    return Math.sqrt(dx*dx+dz*dz);
  }
  var open=[start];           // simple array; graph is small (~2k nodes)
  var gScore={}, fScore={}, came={}, inOpen={}, closed={};
  gScore[start]=0; fScore[start]=h(start); inOpen[start]=true;
  var guard=0;
  while (open.length && guard++<20000){
    // pop lowest fScore
    var bi=0;
    for (var i=1;i<open.length;i++) if ((fScore[open[i]]||1e18)<(fScore[open[bi]]||1e18)) bi=i;
    var cur=open.splice(bi,1)[0];
    inOpen[cur]=false;
    if (cur===goal){
      var path=[cur];
      while (came[cur]!==undefined){ cur=came[cur]; path.push(cur); }
      path.reverse();
      return path;
    }
    closed[cur]=true;
    var edges=adj[cur]||[];
    for (var e=0;e<edges.length;e++){
      var nb=edges[e].to;
      if (closed[nb]) continue;
      var tg=(gScore[cur]||1e18)+edges[e].w;
      if (!inOpen[nb] || tg<(gScore[nb]||1e18)){
        came[nb]=cur; gScore[nb]=tg; fScore[nb]=tg+h(nb);
        if (!inOpen[nb]){ open.push(nb); inOpen[nb]=true; }
      }
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
   Road sampling: position on road ri at arc distance segT.
   --------------------------------------------------------------------------- */
function roadPointAt(R, segT){
  var pts=R.r.pts, cum=R.cum;
  if (segT<=0) return {x:pts[0][0], z:pts[0][1]};
  if (segT>=R.len) return {x:pts[pts.length-1][0], z:pts[pts.length-1][1]};
  var lo=0, hi=cum.length-1;
  while (lo<hi){ var mid=(lo+hi)>>1; if (cum[mid]<segT) lo=mid+1; else hi=mid; }
  var i1=Math.max(1,lo), i0=i1-1;
  var span=(cum[i1]-cum[i0])||1, t=(segT-cum[i0])/span;
  return {x:pts[i0][0]+(pts[i1][0]-pts[i0][0])*t,
          z:pts[i0][1]+(pts[i1][1]-pts[i0][1])*t};
}

/* ---------------------------------------------------------------------------
   pathToPolyline(nodePath) — expand node hops into a road-following
   [{x,z}] polyline using each edge's stored road + arc range. Decimates
   to keep the point count sane for the 3D ribbon + canvas drawing.
   --------------------------------------------------------------------------- */
function pathToPolyline(nodePath){
  var adj=G.adj, roads=window.TRAFFIC.roads;
  var out=[];
  function pushPt(x,z){
    var n=out.length;
    if (n>0){
      var dx=x-out[n-1].x, dz=z-out[n-1].z;
      if (dx*dx+dz*dz<25) return;   // decimate: min 5u spacing
    }
    out.push({x:x, z:z});
  }
  for (var i=0;i<nodePath.length-1;i++){
    var a=nodePath[i], b=nodePath[i+1];
    var edge=null, edges=adj[a]||[];
    for (var e=0;e<edges.length;e++) if (edges[e].to===b){ edge=edges[e]; break; }
    if (!edge) continue;
    var R=roads[edge.ri];
    var t0=edge.tA, t1=edge.tB, steps=Math.max(2, Math.ceil(Math.abs(t1-t0)/40));
    for (var s=0;s<=steps;s++){
      var t=t0+(t1-t0)*s/steps;
      var p=roadPointAt(R,t);
      pushPt(p.x, p.z);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Public API
   --------------------------------------------------------------------------- */
function playerPos(){
  try{
    if (typeof car!=='undefined' && car && car.driving) return {x:car.x, z:car.z};
    return {x:player.x, z:player.z};
  }catch(e){ return {x:0, z:0}; }
}

/* setDestination(x, z, name) — snap to nearest junction node, route, draw. */
function setDestination(x, z, name){
  if (!G) return false;
  var from=playerPos();
  var nA=nearestNode(from.x, from.z);
  var nB=nearestNode(x, z);
  if (nA<0 || nB<0){
    try{ showToast('GPS: no road nearby', 2200); }catch(e){}
    return false;
  }
  if (nA===nB){
    // already there — trivial route
    route={pts:[{x:from.x,z:from.z},{x:x,z:z}], destX:x, destZ:z,
           destName:name||'Destination', dist:Math.hypot(x-from.x,z-from.z)};
  } else {
    var nodePath=astar(nA, nB);
    if (!nodePath){
      try{ showToast('GPS: no route found', 2200); }catch(e){}
      return false;
    }
    var pts=pathToPolyline(nodePath);
    // prepend player pos, append exact destination
    pts.unshift({x:from.x, z:from.z});
    pts.push({x:x, z:z});
    var dist=0;
    for (var i=1;i<pts.length;i++)
      dist+=Math.hypot(pts[i].x-pts[i-1].x, pts[i].z-pts[i-1].z);
    route={pts:pts, destX:x, destZ:z, destName:name||'Destination', dist:dist};
  }
  rebuildRouteMesh();
  try{
    var cb=document.getElementById('gps-clear-btn');
    if (cb) cb.style.display='block';
  }catch(e){}
  try{
    showToast('🧭 Navigating to '+(route.destName)+
      ' — '+Math.round(route.dist)+'u', 2600);
  }catch(e){}
  try{ if(typeof Report!=='undefined') Report.note('gps',
    'route set: '+(route.destName)+' '+Math.round(route.dist)+'u, '+route.pts.length+' pts'); }catch(e){}
  return true;
}

function clearDestination(){
  route=null;
  rebuildRouteMesh();
  try{
    var cb=document.getElementById('gps-clear-btn');
    if (cb) cb.style.display='none';
  }catch(e){}
  try{ showToast('GPS cleared', 1500); }catch(e){}
}

function hasDestination(){ return !!route; }
function getPickMode(){ return pickMode; }
function setPickMode(v){
  pickMode=!!v;
  try{
    var b=document.getElementById('gps-nav-btn');
    if (b){ b.textContent=pickMode?'✅ Tap map to set destination':'📍 Navigate';
            b.classList.toggle('gps-picking', pickMode); }
  }catch(e){}
}

/* ---------------------------------------------------------------------------
   3D visuals: route ribbon (THREE.Line), destination beacon, player arrow.
   --------------------------------------------------------------------------- */
function groundY(x,z){
  try{ return (typeof heightAt==='function'?heightAt(x,z):0)+2.5; }
  catch(e){ return 2.5; }
}
function rebuildRouteMesh(){
  try{
    if (routeLine && routeLine.parent) routeLine.parent.remove(routeLine);
    routeLine=null;
    if (beacon && beacon.parent) beacon.parent.remove(beacon);
    beacon=null;
    if (!route) return;
    var geo=new THREE.BufferGeometry();
    var verts=new Float32Array(route.pts.length*3);
    for (var i=0;i<route.pts.length;i++){
      verts[i*3]=route.pts[i].x;
      verts[i*3+1]=groundY(route.pts[i].x, route.pts[i].z);
      verts[i*3+2]=route.pts[i].z;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(verts,3));
    var mat=new THREE.LineBasicMaterial({color:0x35e0ff, linewidth:3,
      transparent:true, opacity:0.9, depthTest:false});
    routeLine=new THREE.Line(geo, mat);
    routeLine.renderOrder=5;
    routeLine.frustumCulled=false;
    scene.add(routeLine);
    // destination beacon: pulsing cyan cylinder
    var bgeo=new THREE.CylinderGeometry(3,3,30,12,1,true);
    var bmat=new THREE.MeshBasicMaterial({color:0x35e0ff, transparent:true,
      opacity:0.55, side:THREE.DoubleSide, depthWrite:false});
    beacon=new THREE.Mesh(bgeo, bmat);
    beacon.position.set(route.destX, groundY(route.destX,route.destZ)+15, route.destZ);
    beacon.renderOrder=6;
    scene.add(beacon);
  }catch(e){}
}
function ensureArrow(){
  if (arrow) return;
  try{
    // flat chevron floating above the player, points toward next waypoint
    var shape=new THREE.Shape();
    shape.moveTo(0,6); shape.lineTo(-4,-4); shape.lineTo(0,-1.5);
    shape.lineTo(4,-4); shape.closePath();
    var g=new THREE.ExtrudeGeometry(shape,{depth:1,bevelEnabled:false});
    var m=new THREE.MeshBasicMaterial({color:0x35e0ff, transparent:true,
      opacity:0.95, depthTest:false});
    arrow=new THREE.Mesh(g,m);
    arrow.renderOrder=7;
    arrow.frustumCulled=false;
    scene.add(arrow);
  }catch(e){}
}

/* ---------------------------------------------------------------------------
   Per-frame: arrow orientation, beacon pulse, arrival check.
   Registered on the central Sim tick registry ('render', priority 75 —
   after NPCs at 70, before nothing else critical). Expert #14 pattern.
   --------------------------------------------------------------------------- */
function gpsTick(){
  try{
    if (!route){
      if (arrow && arrow.parent) arrow.parent.remove(arrow);
      arrow=null;
      return;
    }
    ensureArrow();
    var p=playerPos();
    // find next waypoint ahead of the player (skip passed ones)
    var pts=route.pts, ni=1;
    var best=1, bd=1e18;
    for (var i=1;i<pts.length;i++){
      var dx=pts[i].x-p.x, dz=pts[i].z-p.z, d2=dx*dx+dz*dz;
      if (d2<bd){ bd=d2; best=i; }
    }
    ni=Math.min(best+1, pts.length-1);
    var tx=pts[ni].x, tz=pts[ni].z;
    // arrow above player, yaw toward target
    var yaw=Math.atan2(tx-p.x, tz-p.z);
    var py=groundY(p.x,p.z)+14;
    arrow.position.set(p.x, py, p.z);
    arrow.rotation.set(0, yaw, 0);
    arrowT+=0.06;
    var s=1+Math.sin(arrowT*2)*0.12;
    arrow.scale.set(s,s,s);
    // beacon pulse
    if (beacon){
      var bs=1+Math.sin(arrowT*2.4)*0.18;
      beacon.scale.set(bs,1,bs);
      beacon.rotation.y+=0.02;
    }
    // arrival check (throttled to ~2Hz)
    var now=Date.now();
    if (now-lastArriveCheck>500){
      lastArriveCheck=now;
      var adx=route.destX-p.x, adz=route.destZ-p.z;
      if (adx*adx+adz*adz<25*25){
        var nm=route.destName;
        clearDestination();
        try{ showToast('🎯 Arrived at '+nm, 3000); }catch(e){}
      }
    }
  }catch(e){}
}

/* ---------------------------------------------------------------------------
   Minimap + full-map route drawing. Called from drawMinimap/drawFullMap
   via the hooks added in index.html (same pattern as ZONEUNLOCK overlay).
   --------------------------------------------------------------------------- */
function drawMinimapRoute(ctx, toMap){
  if (!route || !route.pts.length) return;
  try{
    ctx.save();
    ctx.strokeStyle='#35e0ff'; ctx.lineWidth=4; ctx.lineCap='round';
    ctx.shadowColor='#35e0ff'; ctx.shadowBlur=6;
    ctx.beginPath();
    for (var i=0;i<route.pts.length;i++){
      var m=toMap(route.pts[i].x, route.pts[i].z);
      if (i) ctx.lineTo(m[0],m[1]); else ctx.moveTo(m[0],m[1]);
    }
    ctx.stroke();
    ctx.shadowBlur=0;
    // destination pin
    var d=toMap(route.destX, route.destZ);
    ctx.fillStyle='#35e0ff';
    ctx.beginPath(); ctx.arc(d[0],d[1],7,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#062a33';
    ctx.beginPath(); ctx.arc(d[0],d[1],3,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }catch(e){}
}
function drawFullMapRoute(ctx, M){
  if (!route || !route.pts.length) return;
  try{
    ctx.save();
    ctx.strokeStyle='#35e0ff'; ctx.lineWidth=5; ctx.lineCap='round';
    ctx.shadowColor='#35e0ff'; ctx.shadowBlur=8;
    ctx.beginPath();
    for (var i=0;i<route.pts.length;i++){
      var m=M(route.pts[i].x, route.pts[i].z);
      if (i) ctx.lineTo(m[0],m[1]); else ctx.moveTo(m[0],m[1]);
    }
    ctx.stroke();
    ctx.shadowBlur=0;
    var d=M(route.destX, route.destZ);
    ctx.fillStyle='#35e0ff';
    ctx.beginPath(); ctx.arc(d[0],d[1],10,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#fff'; ctx.font='bold 14px Arial'; ctx.textAlign='center';
    ctx.fillText(route.destName, d[0], d[1]-18);
    ctx.restore();
  }catch(e){}
}

/* ---------------------------------------------------------------------------
   initGPS — build the graph, expose window.GPS, wire UI + tick.
   --------------------------------------------------------------------------- */
function initGPS(){
  var TR=window.TRAFFIC;
  G=buildRoutingGraph(TR.roads, TR.jx);
  buildNodeGrid(G.nodePos);
  window.GPS={
    setDestination:setDestination,
    clearDestination:clearDestination,
    hasDestination:hasDestination,
    getPickMode:getPickMode,
    setPickMode:setPickMode,
    drawMinimapRoute:drawMinimapRoute,
    drawFullMapRoute:drawFullMapRoute,
    version:'1.0'
  };
  // per-frame tick on the central registry (expert #14)
  try{
    if (window.Sim && typeof Sim.onTick==='function')
      Sim.onTick('render', 75, function(){ gpsTick(); });
  }catch(e){}
  // full-map "Navigate" button wiring (button element added in index.html)
  try{
    var b=document.getElementById('gps-nav-btn');
    if (b) b.addEventListener('click', function(e){
      e.stopPropagation();
      if (route && !pickMode){ clearDestination(); setPickMode(false); return; }
      setPickMode(!pickMode);
      if (pickMode){ try{ showToast('Tap the map to set your destination', 2500); }catch(x){} }
    });
    var c=document.getElementById('gps-clear-btn');
    if (c) c.addEventListener('click', function(e){
      e.stopPropagation(); setPickMode(false); clearDestination();
    });
  }catch(e){}
  try{
    var edgeCount=0, ks=Object.keys(G.adj);
    for (var i=0;i<ks.length;i++) edgeCount+=G.adj[ks[i]].length;
    if (typeof Report!=='undefined') Report.setSys('gps',{status:'ok',version:'1.0',
      nodes:G.nNodes, edges:Math.round(edgeCount/2), isolatedRoads:G.nIsolated,
      note:'A* over #7 junction graph; route follows real roads only'});
  }catch(e){}
}

})();
