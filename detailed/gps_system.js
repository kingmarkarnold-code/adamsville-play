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

   v1.64 GPS REWORK (Joshua 2026-10-18, live test: "The GPS system needs
   to be just like real-life GPS systems"):
     1. ROUTES FOLLOW STREETS — always. The pre-1.64 graph came from the
        traffic system, so with traffic unchecked in launch options the
        GPS had no graph and drew Joshua a STRAIGHT blue line. The GPS
        now builds its OWN junction graph from the road data the game
        already loads (roadDrawData) — traffic-independent, and including
        the short residential streets the traffic index skips. The
        traffic graph remains as an interim until the own graph is ready.
        A destination beyond the loaded roads routes on streets to the
        nearest graph node, then a clearly-named straight final leg
        ("partial"); a straight line the whole way ("direct") happens
        only when no street route exists at all, and says so.
     2. TURN-BY-TURN GUIDANCE — the floating top arrow (proven in 1.63)
        now follows the ROUTE: it aims at a lookahead point on the
        polyline, shows the next real turn's arrow + distance ("↰ 120u")
        and the along-route distance remaining — not a straight-line
        bearing to the destination.
     3. AUTOMATIC REROUTING — sustained >40u off the route line re-routes
        from wherever the player is, automatically, no re-pinning.
     4. GAS STATIONS ON THE FULL MAP — GPS.drawFullMapGasStations()
        (hooked in index.html) marks the stations that actually stand in
        the world (the traffic system's placed list) as pump badges.

   Documentation comments are required on all game code — Joshua's rule.
   ============================================================================ */
(function(){
'use strict';

/* ---------------------------------------------------------------------------
   Boot: wait for the junction graph, the 3D scene, and the player object.
   Same boot-poll pattern as traffic_system.js — quiet give-up, never breaks
   the game if deps never arrive (e.g. traffic disabled in launch options).
   --------------------------------------------------------------------------- */
/* v1.64: the boot poll no longer gives up when traffic is off (that
   give-up was the straight-blue-line bug: no traffic -> no graph ->
   direct fallback forever). Two graph sources now:
     1. GPS's OWN graph from roadDrawData (traffic-independent) — the
        primary source, built once, deferred ~1.5s after the road data
        appears so it never fights the world build for the main thread.
     2. The traffic system's junction graph as an INTERIM whenever it
        exists first (the proven pre-1.64 path), replaced by the own
        graph when that build lands. */
var bootTries=0, ownBuildScheduled=false;
var bootTimer=setInterval(function(){
  bootTries++;
  var deps=false;
  try{
    deps=(typeof THREE!=='undefined' && typeof scene!=='undefined' &&
      typeof player!=='undefined');
  }catch(e){ deps=false; }
  if (deps){
    try{
      if (!G && window.TRAFFIC && window.TRAFFIC.jx && window.TRAFFIC.roads &&
          window.TRAFFIC.roads.length>10) initGPS();
    }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('gps','init failed',String(e&&e.message||e)); }catch(x){}
    }
    try{
      if (!ownGraphBuilt && !ownGraphFailed && !ownBuildScheduled &&
          typeof roadDrawData!=='undefined' && roadDrawData.length>100){
        ownBuildScheduled=true;
        setTimeout(function(){ try{ buildOwnGraph(); }catch(e){} }, 1500);
      }
    }catch(e){}
  }
  if (ownGraphBuilt){
    clearInterval(bootTimer);
  } else if (bootTries>240){
    clearInterval(bootTimer);
    if (!G){
      try{ if(typeof Report!=='undefined') Report.noteError('gps','boot-timeout','no routing graph (traffic or own) became ready — direct guidance only'); }catch(e){}
    }
  }
},500);

/* ---------------------------------------------------------------------------
   State
   --------------------------------------------------------------------------- */
var G=null;   // routing graph, built once
var route=null;        // {pts:[{x,z}...], destX, destZ, destName, dist}
var pickMode=false;    // full-map tap sets destination instead of closing
// Floating HUD-arrow state (forward declaration, v1.63): these vars MUST be
// declared here with the rest of the state, BEFORE the module-load calls at
// the bottom of this file. They used to be declared further down — after
// buildHudArrow() had already run at load — and the later `=null`
// assignments silently wiped the stored element handle, so the guidance
// arrow never appeared (see the note at the old declaration site).
var hudArrowEl=null, hudArrowIcon=null, hudArrowDist=null, hudArrowVisible=false;
var hudArrowTurn=null;   // v1.64: the "next turn" line (glyph + distance)
var routeLine=null;    // THREE.Line (3D route ribbon)
var beacon=null;       // destination beacon mesh
var arrow=null;        // direction arrow above player
var arrowT=0;
var lastArriveCheck=0;
/* v1.64 rework state: graph provenance, rerouting, route guidance. */
var graphSource=null;        // 'own' | 'traffic' — which graph G came from
var ownGraphBuilt=false, ownGraphFailed=false;
var lastRouteSetAt=0;        // ms timestamp — reroute cooldown reference
var offRouteCount=0;         // consecutive off-route checks (~2Hz throttle)
var guideIdx=0;              // polyline segment index nearest the player
var guideProg=0;             // player's distance along the route (u)
var guideOff=1e9;            // player's distance from the route line (u)
var guideTarget=null;        // {x,z} lookahead point the arrows aim at
var guideNextTurn=null;      // next turn ahead {d, idx, ang}, or null
var guideRemaining=0;        // along-route distance left (u)
var guideMs=0;               // last guidance computation time (ms)

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
  /* v1.64: remember WHICH road index this graph was built over, so the
     polyline builder samples the same records (pre-1.64 it reached for
     window.TRAFFIC.roads, which does not exist when traffic is off). */
  /* v1.64.1: a segment grid over the same roads for point-to-road
     snapping (computeRoute uses it to start/finish a route ON the
     road the player/destination is actually on, instead of at the
     nearest junction node). Built once here with the graph. */
  var snapGrid={}, SNAPCELL=100;
  for (var gi=0; gi<roads.length; gi++){
    var gp=roads[gi].r.pts;
    for (var gs=0; gs<gp.length-1; gs++){
      var ga=gp[gs], gb=gp[gs+1];
      var gx0=Math.floor(Math.min(ga[0],gb[0])/SNAPCELL),
          gx1=Math.floor(Math.max(ga[0],gb[0])/SNAPCELL),
          gz0=Math.floor(Math.min(ga[1],gb[1])/SNAPCELL),
          gz1=Math.floor(Math.max(ga[1],gb[1])/SNAPCELL);
      for (var gix=gx0; gix<=gx1; gix++) for (var giz=gz0; giz<=gz1; giz++){
        var gk=gix+','+giz;
        (snapGrid[gk]=snapGrid[gk]||[]).push({ri:gi, s:gs});
      }
    }
  }
  return {adj:adj, nodePos:nodePos, nNodes:jx.nodes.length, nIsolated:nIsolated,
          roadsRef:roads, jx:jx, snapGrid:snapGrid, snapCell:SNAPCELL};
}

/* ---------------------------------------------------------------------------
   GPS's OWN junction graph (v1.64) — built from roadDrawData, the road
   records the game itself loads for the current zone, so navigation
   NEVER depends on the traffic system being enabled. Same junction
   rules as the traffic system's #7 graph (endpoint joins + grade-checked
   mid-segment crossings, so overpasses never become fake junctions),
   plus endpoint-on-segment joins for T-junctions, whose stem ends land
   mid-piece on the through road. One difference that matters for a
   GPS: the index covers EVERY road record — the traffic index skips
   streets under 120u, which are exactly the residential streets a
   route to a house needs.
   --------------------------------------------------------------------------- */
/* buildGpsRoadIndex() — arc-length tables over every roadDrawData entry.
   Record shape matches the traffic road index ({r, cum, len, name, cat,
   w}) so the graph builders below can share one shape. */
function buildGpsRoadIndex(){
  var idx=[];
  var src=(typeof roadDrawData!=='undefined')?roadDrawData:[];
  for (var i=0;i<src.length;i++){
    var r=src[i];
    if (!r||!r.pts||r.pts.length<2||!r.ys||r.ys.length!==r.pts.length) continue;
    var cum=[0];
    for (var p=1;p<r.pts.length;p++){
      var dx=r.pts[p][0]-r.pts[p-1][0], dz=r.pts[p][1]-r.pts[p-1][1];
      cum.push(cum[p-1]+Math.sqrt(dx*dx+dz*dz));
    }
    var len=cum[cum.length-1];
    if (len<2) continue;   // degenerate fragment — cannot carry a route
    idx.push({r:r, cum:cum, len:len, name:r.name||('road#'+i),
              cat:r.cat, w:r.w||10});
  }
  return idx;
}

/* buildGpsJunctionGraph(roads) — junction nodes for the GPS graph.
   Returns the same shape GPS's buildRoutingGraph consumes:
   {nodes[], endNode{"ri:end"->node}, crossByRoad[ri]=[{segT,node}]}. */
function buildGpsJunctionGraph(roads){
  var t0=Date.now();
  var JX_GRADE=3;   // junctions must agree in height within 3u (overpass rule)
  var nodes=[], endNode={}, crossByRoad=[];
  roads.forEach(function(){ crossByRoad.push([]); });
  /* node spatial hash so crossing folds find nearby nodes in O(1) */
  var NCELL=40, ngrid={};
  function nKey(x,z){ return Math.floor(x/NCELL)+','+Math.floor(z/NCELL); }
  function nodeAdd(N){
    var ni=nodes.length; nodes.push(N);
    var k=nKey(N.x,N.z); (ngrid[k]=ngrid[k]||[]).push(ni);
    return ni;
  }
  function nodeNear(x,z,r){
    var gx=Math.floor(x/NCELL), gz=Math.floor(z/NCELL), R=Math.ceil(r/NCELL);
    for (var ix=gx-R;ix<=gx+R;ix++) for (var iz=gz-R;iz<=gz+R;iz++){
      var a=ngrid[ix+','+iz]; if(!a) continue;
      for (var i=0;i<a.length;i++){
        var N=nodes[a[i]], dx=N.x-x, dz=N.z-z;
        if (dx*dx+dz*dz<r*r) return a[i];
      }
    }
    return -1;
  }
  function roadSegT(R,s,t){ return R.cum[s]+t*((R.cum[s+1]-R.cum[s])||0); }
  function segYat(R,s,t){ var ys=R.r.ys; return ys[s]+(ys[s+1]-ys[s])*t; }

  /* --- 1. endpoint clustering: road ends within 25u at the same height
         are the same junction (union-find over end keys). --- */
  var ends=[];
  roads.forEach(function(R,ri){
    for (var e=0;e<2;e++){
      var p=R.r.pts[e===0?0:R.r.pts.length-1];
      ends.push({ri:ri, end:e, x:p[0], z:p[1],
                 y:(R.r.ys?R.r.ys[e===0?0:R.r.ys.length-1]:0)});
    }
  });
  var parent={};
  function find(k){ while(parent[k]!==k){ parent[k]=parent[parent[k]]; k=parent[k]; } return k; }
  function union(a,b){ a=find(a); b=find(b); if (a!==b) parent[a]=b; }
  ends.forEach(function(E){ var k=E.ri+':'+E.end; parent[k]=k; });
  var ECELL=50, egrid={};
  ends.forEach(function(E){
    var k=Math.floor(E.x/ECELL)+','+Math.floor(E.z/ECELL);
    (egrid[k]=egrid[k]||[]).push(E);
  });
  var SNAP2=25*25;
  ends.forEach(function(A){
    var gx=Math.floor(A.x/ECELL), gz=Math.floor(A.z/ECELL);
    for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
      var arr=egrid[ix+','+iz]; if(!arr) continue;
      for (var i=0;i<arr.length;i++){
        var B=arr[i]; if (B===A) continue;
        var dx=B.x-A.x, dz=B.z-A.z;
        if (dx*dx+dz*dz>SNAP2) continue;
        if (Math.abs(B.y-A.y)>JX_GRADE) continue;
        union(A.ri+':'+A.end, B.ri+':'+B.end);
      }
    }
  });
  var byRoot={};
  ends.forEach(function(E){
    var k=E.ri+':'+E.end;
    (byRoot[find(k)]=byRoot[find(k)]||[]).push(E);
  });
  Object.keys(byRoot).forEach(function(r){
    var list=byRoot[r];
    if (list.length<2) return;   // a lone end is a dead end, not a junction
    var sx=0, sz=0, sy=0;
    list.forEach(function(E){ sx+=E.x; sz+=E.z; sy+=E.y; });
    var ni=nodeAdd({x:sx/list.length, z:sz/list.length,
                    y:sy/list.length, kind:'end'});
    list.forEach(function(E){ endNode[E.ri+':'+E.end]=ni; });
  });

  /* --- segment spatial hash, shared by steps 2 and 3 --- */
  var SCELL=100, sgrid={};
  roads.forEach(function(R,ri){
    var pts=R.r.pts;
    for (var s=0;s<pts.length-1;s++){
      var a=pts[s], b=pts[s+1];
      var x0=Math.floor(Math.min(a[0],b[0])/SCELL),
          x1=Math.floor(Math.max(a[0],b[0])/SCELL),
          z0=Math.floor(Math.min(a[1],b[1])/SCELL),
          z1=Math.floor(Math.max(a[1],b[1])/SCELL);
      for (var gx=x0;gx<=x1;gx++) for (var gz=z0;gz<=z1;gz++){
        var k=gx+','+gz; (sgrid[k]=sgrid[k]||[]).push({ri:ri,s:s});
      }
    }
  });

  /* --- 2. endpoint-on-segment joins (T-junctions): a road end that
         lands within 14u of another road's centreline at the same
         height joins that road right there. --- */
  ends.forEach(function(E){
    if (endNode[E.ri+':'+E.end]!==undefined) return;  // already a junction
    var gx=Math.floor(E.x/SCELL), gz=Math.floor(E.z/SCELL), best=null;
    for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
      var arr=sgrid[ix+','+iz]; if(!arr) continue;
      for (var i=0;i<arr.length;i++){
        var sg=arr[i]; if (sg.ri===E.ri) continue;
        var R=roads[sg.ri], a=R.r.pts[sg.s], b=R.r.pts[sg.s+1];
        var abx=b[0]-a[0], abz=b[1]-a[1], L2=abx*abx+abz*abz;
        if (L2<1e-6) continue;
        var t=((E.x-a[0])*abx+(E.z-a[1])*abz)/L2;
        if (t<0||t>1) continue;
        var px=a[0]+abx*t, pz=a[1]+abz*t;
        var dx=E.x-px, dz=E.z-pz, d2=dx*dx+dz*dz;
        if (d2>14*14) continue;
        if (Math.abs(segYat(R,sg.s,t)-E.y)>JX_GRADE) continue;
        if (!best || d2<best.d2)
          best={ri:sg.ri, s:sg.s, t:t, x:px, z:pz, y:segYat(R,sg.s,t), d2:d2};
      }
    }
    if (best){
      var ni=nodeNear(best.x, best.z, 25);
      if (ni<0) ni=nodeAdd({x:best.x, z:best.z, y:best.y, kind:'cross'});
      endNode[E.ri+':'+E.end]=ni;
      crossByRoad[best.ri].push({segT:roadSegT(roads[best.ri],best.s,best.t),
                                 node:ni});
    }
  });

  /* --- 3. mid-segment crossings (spatial hash, grade-checked — an
         overpass crossing 9u above the road below is NOT a junction). --- */
  function segCross(ax,az,bx,bz,cx,cz,dx,dz){
    var d=(bx-ax)*(dz-cz)-(bz-az)*(dx-cx);
    if (Math.abs(d)<1e-9) return null;
    var t=((cx-ax)*(dz-cz)-(cz-az)*(dx-cx))/d;
    var u=((cx-ax)*(bz-az)-(cz-az)*(bx-ax))/d;
    /* v1.64.1: ENDPOINT-INCLUSIVE (was (0.02, 0.98) on both) — a crossing
       that lands exactly on one road's VERTEX (junction pins are baked
       as vertices, and through roads carry a point where a stem joins)
       was silently dropped, disconnecting real junctions. Endpoint
       touches fold into the endpoint-cluster nodes (nodeNear 35u) and
       the 5u dedupe below, so including them costs nothing. */
    if (t>-0.001&&t<1.001&&u>-0.001&&u<1.001){
      var tc=Math.max(0, Math.min(1, t)), uc=Math.max(0, Math.min(1, u));
      return {x:ax+tc*(bx-ax), z:az+tc*(bz-az), t:tc, u:uc};
    }
    return null;
  }
  var crossRaw=[];
  Object.keys(sgrid).forEach(function(k){
    var arr=sgrid[k];
    for (var i=0;i<arr.length;i++) for (var j=i+1;j<arr.length;j++){
      var A=arr[i], B=arr[j];
      if (A.ri===B.ri) continue;
      var RA=roads[A.ri], RB=roads[B.ri];
      var p1=RA.r.pts[A.s], p2=RA.r.pts[A.s+1];
      var p3=RB.r.pts[B.s], p4=RB.r.pts[B.s+1];
      var hit=segCross(p1[0],p1[1],p2[0],p2[1],p3[0],p3[1],p4[0],p4[1]);
      if (!hit) continue;
      var yA=segYat(RA,A.s,hit.t), yB=segYat(RB,B.s,hit.u);
      if (Math.abs(yA-yB)>JX_GRADE) continue;   // grade-separated: no junction
      crossRaw.push({x:hit.x, z:hit.z, y:(yA+yB)/2,
        a:{ri:A.ri, s:A.s, t:hit.t}, b:{ri:B.ri, s:B.s, t:hit.u}});
    }
  });
  var seen={}, nCross=0;
  crossRaw.forEach(function(c){
    var k1=c.a.ri+'_'+c.b.ri+'_'+Math.round(c.x/5)+'_'+Math.round(c.z/5);
    var k2=c.b.ri+'_'+c.a.ri+'_'+Math.round(c.x/5)+'_'+Math.round(c.z/5);
    if (seen[k1]||seen[k2]) return;
    seen[k1]=1; nCross++;
    var ni=nodeNear(c.x, c.z, 35);
    if (ni<0) ni=nodeAdd({x:c.x, z:c.z, y:c.y, kind:'cross'});
    crossByRoad[c.a.ri].push({segT:roadSegT(roads[c.a.ri],c.a.s,c.a.t), node:ni});
    crossByRoad[c.b.ri].push({segT:roadSegT(roads[c.b.ri],c.b.s,c.b.t), node:ni});
  });
  /* --- 4. GAP BRIDGING: the baked road data has real gaps — records
         that stop 40-110u short of the road they meet (Adamsville
         measurement: a 205-record island around Cascade Road's south
         stretch whose frontier ends sit 42-109u from the main network;
         without this step that whole district is unroutable). A road
         end that connected to NOTHING above (no endpoint cluster, no
         crossing or tee near the end) is joined to the nearest segment
         in its FRONT hemisphere (the continuation must not lie behind
         the end — bent joins are common in the baked data), at
         matching grade, at most 110u away.
         The conditions keep it honest — a true dead end only bridges
         when a road lies straight ahead of it at road height — and
         every bridge is counted in the system report. --- */
  var GAP_R=110, nGap=0;
  function endConnected(ri, e){
    if (endNode[ri+':'+e]!==undefined) return true;
    var R=roads[ri], list=crossByRoad[ri]||[];
    var segSpan=(e===0)? (R.cum[1]-R.cum[0]) : (R.len-R.cum[R.cum.length-2]);
    for (var i=0;i<list.length;i++){
      var dEnd=(e===0)? list[i].segT : (R.len-list[i].segT);
      if (dEnd<=segSpan+15) return true;
    }
    return false;
  }
  roads.forEach(function(R, ri){
    var pts=R.r.pts, ys=R.r.ys;
    for (var e=0;e<2;e++){
      if (endConnected(ri, e)) continue;
      var pi=(e===0)?0:pts.length-1, pj=(e===0)?1:pts.length-2;
      var ex=pts[pi][0], ez=pts[pi][1], ey=ys[pi];
      var hx=ex-pts[pj][0], hz=ez-pts[pj][1];
      var hl=Math.sqrt(hx*hx+hz*hz); if (hl<0.01) continue; hx/=hl; hz/=hl;
      var best=null, seenSeg={};
      var gx=Math.floor(ex/SCELL), gz=Math.floor(ez/SCELL),
          RR=Math.ceil(GAP_R/SCELL);
      for (var ix=gx-RR;ix<=gx+RR;ix++) for (var iz=gz-RR;iz<=gz+RR;iz++){
        var cell=sgrid[ix+','+iz]; if(!cell) continue;
        for (var ci=0;ci<cell.length;ci++){
          var sg=cell[ci];   // sgrid entries are {ri, s} objects (steps 2-3)
          var key=sg.ri+':'+sg.s; if (seenSeg[key]) continue; seenSeg[key]=1;
          var rj=sg.ri, sj=sg.s;
          if (rj===ri) continue;
          var B=roads[rj]; if (!B) continue;
          var a=B.r.pts[sj], b=B.r.pts[sj+1]; if (!a||!b) continue;
          var abx=b[0]-a[0], abz=b[1]-a[1], L2=abx*abx+abz*abz||1;
          var tt=((ex-a[0])*abx+(ez-a[1])*abz)/L2;
          tt=Math.max(0, Math.min(1, tt));
          var qx=a[0]+tt*abx, qz=a[1]+tt*abz;
          var dx=qx-ex, dz=qz-ez, d2=dx*dx+dz*dz;
          if (d2>GAP_R*GAP_R || d2<1) continue;
          var d=Math.sqrt(d2);
          /* The candidate must lie in the end's FRONT hemisphere
             (cos >= 0): baked ends often meet their continuation at
             a bent angle (measured on Adamsville's Cascade island:
             real links at cos 0.44 and even 0.15 — an earlier cos
             0.75 "straight ahead" rule rejected them all and left a
             205-road district unroutable). Behind-the-end candidates
             (cos < 0, e.g. a parallel road the end points away from)
             stay rejected. */
          if ((dx*hx+dz*hz)/d<0) continue;
          var qy=segYat(B, sj, tt);
          if (Math.abs(qy-ey)>JX_GRADE) continue;
          if (!best || d<best.d)
            best={d:d, rj:rj, sj:sj, t:tt, x:qx, z:qz, y:qy};
        }
      }
      if (best){
        var ni=nodeNear(best.x, best.z, 35);
        if (ni<0) ni=nodeAdd({x:best.x, z:best.z, y:best.y, kind:'gap'});
        crossByRoad[best.rj].push({segT:roadSegT(roads[best.rj], best.sj, best.t),
                                   node:ni});
        endNode[ri+':'+e]=ni;
        nGap++;
      }
    }
  });

  crossByRoad.forEach(function(a,ri){
    a.sort(function(p,q){ return p.segT-q.segT; });
    var w=[], last=-1;
    for (var i=0;i<a.length;i++){
      if (a[i].node===last) continue;
      w.push(a[i]); last=a[i].node;
    }
    crossByRoad[ri]=w;
  });
  return {nodes:nodes, endNode:endNode, crossByRoad:crossByRoad,
          buildMs:Date.now()-t0, nCross:nCross, nGap:nGap};
}

/* buildOwnGraph() — build the GPS graph from the loaded road data and
   swap it in. An active destination re-routes onto it (a pin set during
   the interim — traffic graph or straight-line fallback — follows the
   streets from here on, and says so when it upgrades from direct). */
function buildOwnGraph(){
  if (ownGraphBuilt || ownGraphFailed) return;
  if (typeof roadDrawData==='undefined' || !roadDrawData.length) return;
  try{
    var idx=buildGpsRoadIndex();
    if (idx.length<10){ ownGraphFailed=true; return; }
    var jx=buildGpsJunctionGraph(idx);
    var g2=buildRoutingGraph(idx, jx);
    var prevRoute=route;
    G=g2; graphSource='own'; ownGraphBuilt=true;
    buildNodeGrid(G.nodePos);
    try{
      var edgeCount=0, ks=Object.keys(G.adj);
      for (var i=0;i<ks.length;i++) edgeCount+=G.adj[ks[i]].length;
      if (typeof Report!=='undefined') Report.setSys('gps',{status:'ok',
        version:'1.64', nodes:G.nNodes, edges:Math.round(edgeCount/2),
        isolatedRoads:G.nIsolated, source:'own',
        junctionBuildMs:jx.buildMs, crossings:jx.nCross,
        gapBridges:jx.nGap||0,
        note:'GPS graph from roadDrawData (traffic-independent); routes follow streets'});
    }catch(e){}
    if (prevRoute){
      var res=computeRoute(prevRoute.destX, prevRoute.destZ,
                           prevRoute.destName, playerPos());
      if (res && res.route){
        var wasDirect=(prevRoute.quality==='direct');
        route=res.route; route.quality=res.quality;
        annotateRoute(route);
        guideIdx=0; guideProg=0; offRouteCount=0; lastRouteSetAt=Date.now();
        rebuildRouteMesh();
        if (wasDirect && res.quality!=='direct'){
          try{ showToast('\uD83E\uDDED Route updated — now following the streets', 2200); }catch(e){}
        }
      }
    }
  }catch(e){
    ownGraphFailed=true;
    try{ if(typeof Report!=='undefined') Report.noteError('gps','own graph build failed',String(e&&e.message||e)); }catch(x){}
  }
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
  function consider(a){
    if (!a) return;
    for (var i=0;i<a.length;i++){
      var ni=a[i], p=G.nodePos[ni];
      var dx=p.x-x, dz=p.z-z, d2=dx*dx+dz*dz;
      if (d2<bd){ bd=d2; best=ni; }
    }
  }
  if (maxD>=10000){
    /* v1.64: whole-graph search (destination snap for 'partial'
       routes) — scan the occupied cells directly instead of a
       million-cell ring around the point. */
    for (var k in nodeGrid) consider(nodeGrid[k]);
    return best;
  }
  var R2=Math.ceil(maxD/NCELL);
  for (var ix=gx-R2;ix<=gx+R2;ix++) for (var iz=gz-R2;iz<=gz+R2;iz++)
    consider(nodeGrid[ix+','+iz]);
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
  var adj=G.adj, roads=(G&&G.roadsRef)||[];
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

/* ---------------------------------------------------------------------------
   computeRoute(x, z, name, from) — the routing core (v1.64).
   Returns {route, quality}; never strands the player:
     'streets' — A* over the junction graph, road-following throughout
                 (the last few units to the exact pin may leave the
                 centreline, like a real GPS guiding to an address).
     'partial' — streets to the graph node nearest the destination,
                 then a straight final leg: the destination lies beyond
                 the roads loaded for routing (e.g. another zone's
                 streets, visible on the map but not loaded).
     'direct'  — no graph, or no street path exists: a straight line,
                 always named as such, never dressed up as a route.
   --------------------------------------------------------------------------- */
function directRoute(x, z, name, from){
  return {pts:[{x:from.x,z:from.z},{x:x,z:z}], destX:x, destZ:z,
          destName:name||'Destination',
          dist:Math.hypot(x-from.x,z-from.z), quality:'direct'};
}

/* pointRoadSnapG(x, z, maxD) — the closest point on any road in the
   routing graph's own road set (v1.64.1). Returns {ri, segT, d, x, z}
   or null when nothing is within maxD. Uses the graph's snap grid. */
function pointRoadSnapG(x, z, maxD){
  if (!G || !G.snapGrid) return null;
  var roads=G.roadsRef, CELL=G.snapCell;
  var gx=Math.floor(x/CELL), gz=Math.floor(z/CELL), RR=Math.ceil(maxD/CELL);
  var best=null, seen={};
  for (var ix=gx-RR;ix<=gx+RR;ix++) for (var iz=gz-RR;iz<=gz+RR;iz++){
    var cell=G.snapGrid[ix+','+iz]; if(!cell) continue;
    for (var i=0;i<cell.length;i++){
      var sg=cell[i], key=sg.ri+':'+sg.s;
      if (seen[key]) continue; seen[key]=1;
      var R=roads[sg.ri]; if (!R) continue;
      var a=R.r.pts[sg.s], b=R.r.pts[sg.s+1]; if (!a||!b) continue;
      var abx=b[0]-a[0], abz=b[1]-a[1], L2=abx*abx+abz*abz||1;
      var t=((x-a[0])*abx+(z-a[1])*abz)/L2; t=Math.max(0, Math.min(1, t));
      var qx=a[0]+t*abx, qz=a[1]+t*abz;
      var dx=x-qx, dz=z-qz, d2=dx*dx+dz*dz;
      if (!best || d2<best.d2)
        best={ri:sg.ri, segT:R.cum[sg.s]+t*(R.cum[sg.s+1]-R.cum[sg.s]),
              d2:d2, x:qx, z:qz};
    }
  }
  if (!best || best.d2>maxD*maxD) return null;
  best.d=Math.sqrt(best.d2);
  return best;
}

/* roadJunctionEntries(ri) — the graph nodes on one road, in arc order
   (the same assembly buildRoutingGraph uses for its edges). */
function roadJunctionEntries(ri){
  var jx=G.jx, R=G.roadsRef[ri], out=[];
  var n0=jx.endNode[ri+':0'], n1=jx.endNode[ri+':1'];
  if (n0!==undefined) out.push({segT:0, node:n0});
  if (n1!==undefined) out.push({segT:R.len, node:n1});
  var cl=jx.crossByRoad[ri]||[];
  for (var k=0;k<cl.length;k++) out.push({segT:cl[k].segT, node:cl[k].node});
  out.sort(function(a,b){ return a.segT-b.segT; });
  var w=[], lastN=-1;
  for (var q=0;q<out.length;q++){
    if (out[q].node===lastN) continue;
    w.push(out[q]); lastN=out[q].node;
  }
  return w;
}

/* sampleRoadPts(ri, t0, t1) — points along road ri between two arc
   positions (~20u apart), excluding the first point (the caller has
   it) and including the last. Either direction works. */
function sampleRoadPts(ri, t0, t1){
  var R=G.roadsRef[ri], out=[];
  var steps=Math.max(1, Math.ceil(Math.abs(t1-t0)/20));
  for (var s=1;s<=steps;s++){
    var p=roadPointAt(R, t0+(t1-t0)*s/steps);
    out.push({x:p.x, z:p.z});
  }
  return out;
}

/* pathCost(nodePath) — total A* edge weight along a node path. */
function pathCost(nodePath){
  var c=0;
  for (var i=0;i<nodePath.length-1;i++){
    var edges=G.adj[nodePath[i]]||[];
    for (var e=0;e<edges.length;e++)
      if (edges[e].to===nodePath[i+1]){ c+=edges[e].w; break; }
  }
  return c;
}
function computeRoute(x, z, name, from){
  name=name||'Destination';
  if (!G) return {route:directRoute(x, z, name, from), quality:'direct'};
  var nA=nearestNode(from.x, from.z);
  var nB=nearestNode(x, z, 100000);   // closest graph node, wherever it is
  if (nA<0 || nB<0)
    return {route:directRoute(x, z, name, from), quality:'direct'};
  /* v1.64.1: start/finish ON the roads the endpoints are actually on.
     A destination mid-block used to route only to its nearest junction
     and then cut straight (corner-cutting on curved streets); now the
     route A*s between the junction nodes BRACKETING each endpoint's
     position on its own road and samples along that road for the
     first/last stretch — the way a real GPS routes to an address.
     Up to 2x2 candidate pairs; A* here costs milliseconds. */
  function bracketCands(snap, nearNode, px, pz){
    if (!snap) return [{node:nearNode, legLen:Math.hypot(px-G.nodePos[nearNode].x,
      pz-G.nodePos[nearNode].z), roadRi:-1, segT:0}];
    var ents=roadJunctionEntries(snap.ri), out=[], seenN={};
    var pre=null, suc=null;
    for (var i=0;i<ents.length;i++){
      if (ents[i].segT<=snap.segT+0.01) pre=ents[i];
      if (ents[i].segT>=snap.segT-0.01 && suc===null) suc=ents[i];
    }
    [pre, suc].forEach(function(en){
      if (!en || seenN[en.node]) return;
      seenN[en.node]=1;
      out.push({node:en.node, legLen:Math.abs(snap.segT-en.segT),
                roadRi:snap.ri, segT:en.segT, snapSegT:snap.segT});
    });
    if (!out.length)
      out.push({node:nearNode, legLen:Math.hypot(px-G.nodePos[nearNode].x,
        pz-G.nodePos[nearNode].z), roadRi:-1, segT:0});
    return out;
  }
  var pSnap=pointRoadSnapG(from.x, from.z, 60);
  var dSnap=pointRoadSnapG(x, z, 60);
  var sCands=bracketCands(pSnap, nA, from.x, from.z);
  var gCands=bracketCands(dSnap, nB, x, z);
  var best=null;
  for (var si=0;si<sCands.length;si++) for (var gi=0;gi<gCands.length;gi++){
    var sc=sCands[si], gc=gCands[gi];
    var path=(sc.node===gc.node)? [sc.node] : astar(sc.node, gc.node);
    if (!path) continue;
    var cost=sc.legLen+pathCost(path)+gc.legLen;
    if (!best || cost<best.cost) best={path:path, sc:sc, gc:gc, cost:cost};
  }
  if (!best){
    /* v1.64.1 REACHABLE-NODE FALLBACK: the destination's road pocket
       is not connected to the player's network at all (measured on
       Adamsville: the Cascade/Burton subdivisions have NO road link
       to the Campbellton/Dollar Mill network — a ~280u roadless band
       in the baked data; Cascade Road's northern stretch is absent).
       Faking a street there would be a lie, and a bare straight line
       wastes the network that DOES reach toward it. So: route by
       streets to the reachable node CLOSEST to the destination, then
       one straight final leg — quality 'partial', named as such in
       the toast. One BFS marks the player's whole component (a few
       ms), so no repeated failed A* searches. */
    var reach={}, stack=[];
    sCands.forEach(function(c){ if (!reach[c.node]){ reach[c.node]=1; stack.push(c.node); } });
    while (stack.length){
      var cn=stack.pop(), ce=G.adj[cn]||[];
      for (var ei=0;ei<ce.length;ei++)
        if (!reach[ce[ei].to]){ reach[ce[ei].to]=1; stack.push(ce[ei].to); }
    }
    var nearGoal=-1, nearD=Infinity;
    for (var nk in reach){
      var np=G.nodePos[nk];
      var nd=Math.hypot(x-np.x, z-np.z);
      if (nd<nearD){ nearD=nd; nearGoal=+nk; }
    }
    if (nearGoal>=0){
      var sc0=sCands[0], path0=astar(sc0.node, nearGoal);
      if (path0) best={path:path0, sc:sc0,
                       gc:{node:nearGoal, legLen:nearD, roadRi:-1, segT:0},
                       cost:sc0.legLen+pathCost(path0)+nearD};
      /* quality resolves to 'partial' below on its own: this goal
         candidate is off-road (roadRi -1) with a leg far over 60u. */
    }
  }
  if (!best)
    return {route:directRoute(x, z, name, from), quality:'direct'};
  var pts=[{x:from.x, z:from.z}];
  if (best.sc.roadRi>=0)
    pts=pts.concat(sampleRoadPts(best.sc.roadRi, best.sc.snapSegT, best.sc.segT));
  pts=pts.concat(pathToPolyline(best.path));
  if (best.gc.roadRi>=0)
    pts=pts.concat(sampleRoadPts(best.gc.roadRi, best.gc.segT, best.gc.snapSegT));
  pts.push({x:x, z:z});
  /* drop consecutive near-duplicate join points (keep first + last) */
  var clean=[pts[0]];
  for (var ci=1;ci<pts.length-1;ci++){
    var lp=clean[clean.length-1];
    if (Math.hypot(pts[ci].x-lp.x, pts[ci].z-lp.z)>=3) clean.push(pts[ci]);
  }
  clean.push(pts[pts.length-1]);
  pts=clean;
  /* quality: streets when both ends joined their roads (or were
     already at a junction); a straight off-road end leg over 60u
     makes it partial (e.g. a pin dropped in a park or another zone). */
  var offLeg=0;
  if (best.sc.roadRi<0) offLeg=Math.max(offLeg, best.sc.legLen);
  if (best.gc.roadRi<0) offLeg=Math.max(offLeg, best.gc.legLen);
  var quality=(offLeg>60)?'partial':'streets';
  var dist=0;
  for (var di=1;di<pts.length;di++)
    dist+=Math.hypot(pts[di].x-pts[di-1].x, pts[di].z-pts[di-1].z);
  return {route:{pts:pts, destX:x, destZ:z, destName:name, dist:dist,
                 quality:quality},
          quality:quality};
}

/* annotateRoute(rt) — precompute what guidance needs: cumulative
   distance along the polyline, and the list of real turns. A turn is a
   direction change of 30°+ measured over a ±20u window (so a curving
   street doesn't spam micro-turns); turns closer than 45u merge into
   the sharper one. Guidance reads these — it never recomputes them. */
function annotateRoute(rt){
  var pts=rt.pts, cum=[0];
  for (var i=1;i<pts.length;i++)
    cum.push(cum[i-1]+Math.hypot(pts[i].x-pts[i-1].x, pts[i].z-pts[i-1].z));
  rt.cum=cum; rt.totalDist=cum[cum.length-1]||0;
  rt.turns=[];
  function heading(a,b){ return Math.atan2(b.x-a.x, b.z-a.z); }
  function wrapPi(a){
    while (a>Math.PI) a-=2*Math.PI;
    while (a<-Math.PI) a+=2*Math.PI;
    return a;
  }
  for (var j=1;j<pts.length-1;j++){
    var back=j, fwd=j;
    while (back>0 && cum[j]-cum[back]<20) back--;
    while (fwd<pts.length-1 && cum[fwd]-cum[j]<20) fwd++;
    if (fwd===j || back===j) continue;
    var deg=wrapPi(heading(pts[j],pts[fwd])-heading(pts[back],pts[j]))*180/Math.PI;
    if (Math.abs(deg)<30) continue;
    var last=rt.turns[rt.turns.length-1];
    if (last && cum[j]-last.d<45){
      if (Math.abs(deg)>Math.abs(last.ang)){ last.ang=deg; last.d=cum[j]; last.idx=j; }
      continue;
    }
    rt.turns.push({d:cum[j], idx:j, ang:deg});
  }
}

/* turnGlyph(angDeg) — GPS-style instruction arrow for a signed turn.
   Sign convention (game yaw = atan2(dx,dz), +z = south on the map): a
   POSITIVE angle change is a LEFT turn, negative is RIGHT — verified
   against known turns in the boot harness (see GPS-REWORK-NOTES.md). */
function turnGlyph(ang){
  var a=Math.abs(ang), left=ang>0;
  if (a>=150) return left?'\u21A9':'\u21AA';   // U-turn ↩ / ↪
  if (a>=115) return left?'\u21B2':'\u21B3';   // sharp ↲ / ↳
  if (a>=50)  return left?'\u21B0':'\u21B1';   // turn ↰ / ↱
  return left?'\u2196':'\u2197';               // slight ↖ / ↗
}

/* pointAtDist(rt, d) — the polyline point d units along the route. */
function pointAtDist(rt, d){
  var pts=rt.pts, cum=rt.cum;
  if (d<=0) return {x:pts[0].x, z:pts[0].z};
  if (d>=rt.totalDist){ var l=pts[pts.length-1]; return {x:l.x, z:l.z}; }
  var lo=0, hi=cum.length-1;
  while (lo<hi){ var mid=(lo+hi)>>1; if (cum[mid]<d) lo=mid+1; else hi=mid; }
  var i1=Math.max(1,lo), i0=i1-1;
  var span=(cum[i1]-cum[i0])||1, t=(d-cum[i0])/span;
  return {x:pts[i0].x+(pts[i1].x-pts[i0].x)*t,
          z:pts[i0].z+(pts[i1].z-pts[i0].z)*t};
}

/* updateGuidance(p) — where the player is ON the route, how far off it,
   what the arrows should aim at, and the next turn. Throttled to ~8Hz;
   called from both per-frame ticks so guidance exists whether or not
   the HUD arrow is on screen (rerouting reads it too). */
function updateGuidance(p){
  if (!route || !route.pts || route.pts.length<2){
    guideTarget=null; guideNextTurn=null; return;
  }
  var now=Date.now();
  if (now-guideMs<120 && guideTarget) return;
  if (!route.cum) annotateRoute(route);
  var pts=route.pts, cum=route.cum;
  var best={d2:1e18, idx:guideIdx, prog:guideProg};
  function scan(i0, i1){
    for (var i=i0;i<i1 && i<pts.length-1;i++){
      var ax=pts[i].x, az=pts[i].z;
      var abx=pts[i+1].x-ax, abz=pts[i+1].z-az, L2=abx*abx+abz*abz;
      var t=L2>0?((p.x-ax)*abx+(p.z-az)*abz)/L2:0;
      if (t<0) t=0; else if (t>1) t=1;
      var qx=ax+abx*t, qz=az+abz*t;
      var dx=p.x-qx, dz=p.z-qz, d2=dx*dx+dz*dz;
      if (d2<best.d2) best={d2:d2, idx:i, prog:cum[i]+Math.sqrt(L2)*t};
    }
  }
  var lo=Math.max(0, guideIdx-4), hi=Math.min(pts.length-2, guideIdx+40);
  scan(lo, hi+1);
  if ((best.idx===lo && lo>0) || (best.idx===hi && hi<pts.length-2) ||
      best.d2>200*200){
    best={d2:1e18, idx:0, prog:0};
    scan(0, pts.length-1);
  }
  guideIdx=best.idx; guideProg=best.prog; guideOff=Math.sqrt(best.d2);
  guideRemaining=Math.max(0, route.totalDist-guideProg);
  guideNextTurn=null;
  var turns=route.turns||[];
  for (var k=0;k<turns.length;k++){
    if (turns[k].d>guideProg+15){ guideNextTurn=turns[k]; break; }
  }
  if (guideNextTurn && (guideNextTurn.d-guideProg)<85){
    var tp=pts[guideNextTurn.idx];
    guideTarget={x:tp.x, z:tp.z};
  } else {
    guideTarget=pointAtDist(route, Math.min(route.totalDist, guideProg+55));
  }
  guideMs=now;
}

/* rerouteNow() — automatic rerouting (v1.64): recompute from wherever
   the player is to the SAME destination. Keeps the old route if the
   recompute somehow fails — a stale route beats no route. */
function rerouteNow(){
  if (!route) return;
  var res=computeRoute(route.destX, route.destZ, route.destName, playerPos());
  if (!res || !res.route) return;
  route=res.route; route.quality=res.quality;
  annotateRoute(route);
  guideIdx=0; guideProg=0; lastRouteSetAt=Date.now();
  rebuildRouteMesh();
  try{ showToast('\uD83D\uDD04 Rerouting — new route '+
    Math.round(route.dist)+'u', 2200); }catch(e){}
  try{ if(typeof Report!=='undefined') Report.note('gps',
    'auto-reroute: '+Math.round(route.dist)+'u, quality '+res.quality); }catch(e){}
}

/* setDestination(x, z, name) — route from the player, draw, announce. */
function setDestination(x, z, name){
  /* v1.64: if no graph has landed yet, try to build the street graph on
     the spot — a deliberate pin tap should never settle for a straight
     line just because the deferred background build hasn't run. */
  if (!G){
    try{ buildOwnGraph(); }catch(e){}
    if (!G){
      try{
        if (window.TRAFFIC && window.TRAFFIC.jx && window.TRAFFIC.roads &&
            window.TRAFFIC.roads.length>10) initGPS();
      }catch(e){}
    }
  }
  var from;
  try{ from=playerPos(); }catch(e){ from={x:4000,z:6000}; }
  var res=computeRoute(x, z, name, from);
  route=res.route; route.quality=res.quality;
  annotateRoute(route);
  guideIdx=0; guideProg=0; offRouteCount=0; lastRouteSetAt=Date.now();
  rebuildRouteMesh();
  try{
    var cb=document.getElementById('gps-clear-btn');
    if (cb) cb.style.display='block';
  }catch(e){}
  try{
    if (res.quality==='partial'){
      showToast('\uD83E\uDDED Navigating to '+(route.destName)+
        ' \u2014 '+Math.round(route.dist)+
        'u (streets, then direct \u2014 destination past the loaded roads)', 3000);
    } else if (res.quality==='direct'){
      showToast('\uD83E\uDDF5 Navigating to '+(route.destName)+
        ' \u2014 '+Math.round(route.dist)+'u (direct)', 2600);
    } else {
      showToast('\uD83E\uDDED Navigating to '+(route.destName)+
        ' \u2014 '+Math.round(route.dist)+'u', 2600);
    }
  }catch(e){}
  try{ if(typeof Report!=='undefined') Report.note('gps',
    'route set: '+(route.destName)+' '+Math.round(route.dist)+'u, '+
    route.pts.length+' pts, quality '+res.quality); }catch(e){}
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
    /* v1.64: the 3D chevron aims at the guidance lookahead point — down
       the street you're on, swinging toward the next turn as it nears —
       not at whichever polyline point happens to be nearest. */
    updateGuidance(p);
    var tx=guideTarget?guideTarget.x:route.destX;
    var tz=guideTarget?guideTarget.z:route.destZ;
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
      /* v1.64 AUTOMATIC REROUTING: the player is >40u off the route
         line on 3 consecutive checks (~1.5s — a parking-lot stop or a
         gas-station pull-in hugs the line closer than that) and the
         route is at least 8s old -> re-route from right here to the
         same destination, no re-pinning. Runs after arrival so an
         arrival always wins. Direct routes have no line to leave. */
      if (route && route.quality!=='direct' && route.pts.length>2){
        if (guideOff>40) offRouteCount++; else offRouteCount=0;
        if (offRouteCount>=3 && now-lastRouteSetAt>8000){
          offRouteCount=0;
          rerouteNow();
        }
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
   drawFullMapGasStations(ctx, M) — v1.64 (Joshua 2026-10-18: "the
   in-game map must mark gas stations"). Source of truth = the traffic
   system's PLACED station list (window.TRAFFIC.gas): only stations
   that actually stand in the world get a marker — stations whose
   placement was skipped (they exist as data but were never built) get
   none, and nothing is invented. Stations are placed by the traffic
   system at init, so with traffic disabled in launch options the
   world has no stations standing and this honestly draws nothing.
   Returns the number of markers drawn (the boot harness checks it
   against the placed list).
   --------------------------------------------------------------------------- */
function drawFullMapGasStations(ctx, M){
  var list=null;
  try{ list=(window.TRAFFIC && window.TRAFFIC.gas) || null; }catch(e){}
  if (!list || !list.length) return 0;
  var drawn=0;
  try{
    ctx.save();
    ctx.textAlign='center';
    for (var i=0;i<list.length;i++){
      var s=list[i];
      if (!s || typeof s.x!=='number' || typeof s.z!=='number') continue;
      var m=M(s.x, s.z);
      // orange pump badge with a white ring — reads as GAS at a glance,
      // distinct from the yellow landmark squares and blue MARTA dots
      ctx.fillStyle='#ff8c1a';
      ctx.beginPath(); ctx.arc(m[0], m[1], 8, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle='#ffffff'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(m[0], m[1], 8, 0, Math.PI*2); ctx.stroke();
      ctx.fillStyle='#ffffff'; ctx.font='11px Arial';
      ctx.fillText('\u26FD', m[0], m[1]+4);
      if (s.name){
        ctx.fillStyle='#ffb35e'; ctx.font='bold 11px Arial';
        ctx.fillText(s.name, m[0], m[1]-13);
      }
      drawn++;
    }
    ctx.restore();
  }catch(e){}
  return drawn;
}

/* debugState() — read-only introspection for the boot harness (and the
   Report panel): graph provenance/size, active route quality, live
   guidance. No behaviour hangs off this. */
function debugState(){
  var ec=0;
  if (G){
    var ks=Object.keys(G.adj);
    for (var i=0;i<ks.length;i++) ec+=G.adj[ks[i]].length;
  }
  return {
    version:'1.64',
    graph:G?{source:graphSource, nodes:G.nNodes,
             edges:Math.round(ec/2), isolated:G.nIsolated}:null,
    ownBuilt:ownGraphBuilt, ownFailed:ownGraphFailed,
    route:route?{quality:route.quality||'?', dist:Math.round(route.dist),
                 pts:route.pts.length, turns:(route.turns||[]).length,
                 totalDist:Math.round(route.totalDist||0),
                 ptsList:route.pts.map(function(p){
                   return [Math.round(p.x), Math.round(p.z)]; }),
                 turnsList:(route.turns||[]).map(function(t){
                   return {d:Math.round(t.d), idx:t.idx,
                           ang:Math.round(t.ang), glyph:turnGlyph(t.ang)}; })}:null,
    guidance:{prog:Math.round(guideProg),
              off:(guideOff===1e9?-1:Math.round(guideOff)),
              remaining:Math.round(guideRemaining),
              nextTurn:guideNextTurn?{inU:Math.round(guideNextTurn.d-guideProg),
                                      ang:Math.round(guideNextTurn.ang),
                                      glyph:turnGlyph(guideNextTurn.ang)}:null,
              target:guideTarget},
    gasStations:(function(){
      try{ return (window.TRAFFIC && window.TRAFFIC.gas) ?
        window.TRAFFIC.gas.length : 0; }catch(e){ return 0; }
    })()
  };
}

/* ---------------------------------------------------------------------------
   v1.62 NAV FIX (2026-10-12): EARLY EXPOSURE.
   Previously window.GPS, the Navigate-button wiring, and the per-frame tick
   all lived inside initGPS(), which only runs after the traffic system's
   junction graph is ready. If the traffic system failed (or is disabled in
   launch options), initGPS() never ran: the Navigate button was dead and
   map taps just closed the map. Now the UI works at module load; initGPS()
   only builds the routing graph for A* (setDestination falls back to a
   straight-line route when the graph is unavailable).
   --------------------------------------------------------------------------- */
window.GPS={
  setDestination:setDestination,
  clearDestination:clearDestination,
  hasDestination:hasDestination,
  getPickMode:getPickMode,
  setPickMode:setPickMode,
  drawMinimapRoute:drawMinimapRoute,
  drawFullMapRoute:drawFullMapRoute,
  drawFullMapGasStations:drawFullMapGasStations,
  _debug:debugState,
  version:'1.64'
};
// per-frame ticks on the central registry (expert #14); interval fallback
// when Sim isn't available yet — independent of the graph boot poll.
try{
  if (window.Sim && typeof Sim.onTick==='function'){
    Sim.onTick('render', 75, function(){ gpsTick(); });
    Sim.onTick('render', 76, function(){ hudArrowTick(); });
  } else {
    setInterval(function(){ try{ gpsTick(); }catch(e){} }, 150);
    setInterval(function(){ try{ hudArrowTick(); }catch(e){} }, 150);
  }
}catch(e){
  try{ setInterval(function(){ try{ gpsTick(); hudArrowTick(); }catch(x){} }, 150); }catch(x){}
}
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
// floating HUD navigation arrow (Joshua 2026-10-12): after the pin drops and
// the map closes, this shows which direction to travel.
try{ buildHudArrow(); }catch(e){}

/* ---------------------------------------------------------------------------
   initGPS — build the routing graph only. Called by the boot poll once the
   traffic system's junction data is ready. Safe to call repeatedly (no-op
   after the first successful build). Everything else is wired at module
   load (see EARLY EXPOSURE above).
   --------------------------------------------------------------------------- */
function initGPS(){
  if (G) return; // graph already built
  var TR=window.TRAFFIC;
  if (!TR || !TR.roads || !TR.jx) return;
  try{
    G=buildRoutingGraph(TR.roads, TR.jx);
    graphSource='traffic';
    buildNodeGrid(G.nodePos);
  }catch(e){
    try{ if(typeof Report!=='undefined') Report.noteError('gps','graph build failed',String(e&&e.message||e)); }catch(x){}
    return;
  }
  try{
    var edgeCount=0, ks=Object.keys(G.adj);
    for (var i=0;i<ks.length;i++) edgeCount+=G.adj[ks[i]].length;
    if (typeof Report!=='undefined') Report.setSys('gps',{status:'ok',version:'1.64',
      nodes:G.nNodes, edges:Math.round(edgeCount/2), isolatedRoads:G.nIsolated,
      source:'traffic (interim)',
      note:'A* over #7 junction graph; route follows real roads only'});
  }catch(e){}
}

/* ---------------------------------------------------------------------------
   v1.62 NAV FIX (2026-10-12): floating HUD navigation arrow.
   Joshua's spec: after dropping a pin and closing the map, a floating arrow
   shows which direction to travel. Screen-space DOM overlay (always visible,
   unlike the 3D cone which can be occluded or out of frame). Rotates to point
   toward the destination relative to the camera view; shows destination name
   + distance. Tap to clear. Auto-hides on arrival (route cleared) and while
   the full map or satellite view is open.
   ---------------------------------------------------------------------------
   v1.63 NAV FIX (2026-10-18): the state vars for this arrow used to be
   declared on the line below this block — AFTER the buildHudArrow() call
   at module load. The build stored the element in hudArrowEl, then this
   declaration's `=null` assignments executed and wiped the handle, so
   hudArrowTick() returned at its first line on every tick and the arrow
   NEVER appeared (the element sat in the DOM at display:none). The
   declarations now live with the other state at the top of this file.
   --------------------------------------------------------------------------- */
function buildHudArrow(){
  if (hudArrowEl) return;
  if (typeof document==='undefined' || !document.body) return;
  var el=document.createElement('div');
  el.id='gps-hud-arrow';
  el.style.cssText='position:fixed;top:70px;left:50%;transform:translateX(-50%);'+
    'z-index:40;display:none;text-align:center;pointer-events:auto;cursor:pointer;'+
    'user-select:none;-webkit-user-select:none;';
  el.innerHTML='<div id="gps-hud-arrow-icon" style="font-size:46px;line-height:1;'+
    'color:#35e0ff;text-shadow:0 0 10px rgba(0,0,0,.85),0 2px 4px #000;">&#11014;</div>'+
    '<div id="gps-hud-arrow-turn" style="display:none;font-size:20px;font-weight:bold;'+
    'color:#ffd75e;text-shadow:0 1px 3px #000;background:rgba(0,0,0,.5);'+
    'border-radius:9px;padding:1px 10px;margin-top:3px;white-space:nowrap;"></div>'+
    '<div id="gps-hud-arrow-dist" style="font-size:13px;font-weight:bold;color:#fff;'+
    'text-shadow:0 1px 3px #000;background:rgba(0,0,0,.5);border-radius:9px;'+
    'padding:2px 10px;margin-top:3px;white-space:nowrap;"></div>'+
    '<div style="font-size:10px;color:#9fd8ff;text-shadow:0 1px 2px #000;margin-top:1px;">tap to clear</div>';
  el.title='Tap to clear navigation';
  function doClear(e){
    try{ if(e){ e.stopPropagation(); if(e.preventDefault) e.preventDefault(); } }catch(x){}
    clearDestination();
    try{ setPickMode(false); }catch(x){}
    try{ showToast('Navigation cleared', 1200); }catch(x){}
  }
  el.addEventListener('click', doClear);
  // touchend fallback for webviews that swallow click on fixed overlays
  el.addEventListener('touchend', doClear, {passive:false});
  document.body.appendChild(el);
  hudArrowEl=el;
  hudArrowIcon=el.querySelector('#gps-hud-arrow-icon');
  hudArrowDist=el.querySelector('#gps-hud-arrow-dist');
  hudArrowTurn=el.querySelector('#gps-hud-arrow-turn');
}
function hudArrowTick(){
  // Self-heal (v1.63): if the load-time build could not run (e.g. the
  // module executed before <body> existed), build the element lazily on
  // the first tick instead of staying silent forever.
  if (!hudArrowEl){ try{ buildHudArrow(); }catch(e){} }
  if (!hudArrowEl) return;
  var show=!!route;
  // hide while the full map or satellite view is open (route shown there)
  try{ if (typeof fullMapOpen!=='undefined' && fullMapOpen) show=false; }catch(e){}
  try{ if (window.__satViewActive) show=false; }catch(e){}
  if (!show){ if (hudArrowVisible){ hudArrowEl.style.display='none'; hudArrowVisible=false; } return; }
  if (!hudArrowVisible){ hudArrowEl.style.display='block'; hudArrowVisible=true; }
  var p;
  try{ p=playerPos(); }catch(e){ return; }
  /* v1.64 ROUTE GUIDANCE: the arrow aims at the guidance lookahead
     point ON THE ROUTE (down the street, swinging toward the next turn
     as it nears) — pre-1.64 it pointed in a straight line at the
     destination, which sent you cross-country. The distance is the
     along-route distance remaining, and when a turn is within 500u
     the turn line shows its arrow + distance, like a real GPS. */
  updateGuidance(p);
  var tgt=guideTarget||{x:route.destX, z:route.destZ};
  var dx=tgt.x-p.x, dz=tgt.z-p.z;
  // world bearing to the lookahead point (game yaw convention: atan2(dx,dz))
  var bearing=Math.atan2(dx,dz);
  // camera view yaw: driving -> car.yaw; on foot -> orbit camYaw
  var viewYaw=0;
  try{
    if (typeof car!=='undefined' && car && car.driving) viewYaw=car.yaw||0;
    else if (typeof camYaw!=='undefined') viewYaw=camYaw||0;
  }catch(e){}
  var rel=bearing-viewYaw;
  if (hudArrowIcon) hudArrowIcon.style.transform='rotate('+(rel*180/Math.PI)+'deg)';
  if (hudArrowTurn){
    if (guideNextTurn && (guideNextTurn.d-guideProg)<=500){
      hudArrowTurn.textContent=turnGlyph(guideNextTurn.ang)+' '+
        Math.max(0, Math.round(guideNextTurn.d-guideProg))+'u';
      hudArrowTurn.style.display='block';
    } else {
      hudArrowTurn.style.display='none';
    }
  }
  if (hudArrowDist) hudArrowDist.textContent=(route.destName||'Destination')+
    ' \u2022 '+Math.round(guideRemaining||Math.hypot(route.destX-p.x, route.destZ-p.z))+'u';
}

})();
