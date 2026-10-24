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
        polyline, shows the next real turn's arrow + distance ("↰ 0.07 mi")
        and the along-route distance remaining — not a straight-line
        bearing to the destination.
     3. AUTOMATIC REROUTING — sustained >40u off the route line re-routes
        from wherever the player is, automatically, no re-pinning.
     4. GAS STATIONS ON THE FULL MAP — GPS.drawFullMapGasStations()
        (hooked in index.html) marks the stations that actually stand in
        the world (the traffic system's placed list) as pump badges.

   v1.65 STREET-ROUTING FIX (Joshua 2026-10-24, live test: "the GPS is
   navigating but it's also allowing you to navigate through fields and
   grass — it needs to tell you how to turn just like a regular GPS
   would in real life. It needs to take into account the street layouts
   and go from there"). Diagnosis (measured in the Node harness against
   all seven zones' road geometry — see GPS-STREET-ROUTING-FIX notes):
     - CROSS-ZONE SLASH: the graph covered ONLY the loaded zone, so a
       pin in another zone routed by streets to the zone edge and then
       drew ONE straight leg (measured 6,119u to downtown, 11,517u to
       south Fulton; 20-39% of those routes off-road).
     - POCKET OVERSHOOT: a destination in a disconnected street pocket
       (the Cascade/Danforth island, 186 nodes, no link to the main
       network in the baked data) got a 1,070u straight leg clear to
       the destination, even though the pocket's own streets run
       alongside the leg for most of its length.
     - JUNCTION CHORDS: the drawn line joined consecutive A* hops
       road-point to road-point; where one junction node aggregates
       endpoints/crossings up to ~90u apart, the join cut straight
       across corners and blocks (worst measured cut 52u long, 36u off
       the road, inside routes labelled 'streets').
     - SILENT CONNECTORS: the first/last stretch from the player or to
       the door was drawn with no label, and turns carried no street
       names at all — guidance never said what to turn ONTO.
   The fix, in this file:
     1. LAZY MULTI-ZONE GRAPH — when a pin (or the player) sits in a
        zone the graph doesn't cover, that zone's roads.json is fetched
        (MapDelivery store first, then network — the goto.js pattern),
        its junction graph is built, junctions are stitched across the
        zone seam with the SAME rules used inside a zone (endpoint
        clusters 25u, T-joins 14u, front-hemisphere gap bridges 110u,
        all grade-checked), and the result is merged into G. Zones the
        straight line crosses are included, so through-routes work.
        The interim route shows meanwhile and upgrades when the street
        graph lands (the v1.64 graph-upgrade pattern). Boot is
        untouched: the current zone still builds exactly as before.
     2. A* uses a binary heap (same optimal cost; the merged graph can
        hold 3-4x the nodes and the old array-scan pop got slow).
     3. POLYLINE TRUTH — pathToPolyline picks the parallel edge that
        actually belongs to the junction (nearest the node positions)
        and inserts the junction node's own position between hops, so
        the line goes THROUGH junctions like a driven route instead of
        chord-ing across them. Every polyline vertex remembers which
        road produced it (route.ptRoad).
     4. HONEST LEGS — endpoint snaps now reach 400u (a house or a
        station set back from its street still routes along that
        street); every off-road portion of a route is an explicit,
        labelled leg (route.legs): 'start' (head to the street),
        'end' (off-road to the door), 'gap' (the street data does not
        connect — the route follows streets as far as they go, lands
        on the destination pocket's nearest street, and follows the
        pocket's streets in; only the true data gap is straight).
     5. TURN-BY-TURN WITH STREET NAMES — instructions come from real
        turns AND street changes; each names the street being turned
        onto ("↰ onto Cascade Rd SW · 394 ft", "⬆ Continue on …"),
        with the placeholder handled gracefully ("onto the next
        street"). When the next feature is an off-road leg, the band
        says so instead ("⚠ No street route — direct 0.66 mi").
     6. NEIGHBOUR RETRY (v1.65.2) — if a route still ends in a gap
        leg, the destination zone's neighbouring tiles are pulled in
        once: a pocket that is an island inside its own zone may
        connect around the back through a neighbour (the Cascade
        pocket joins the network via South Fulton and then routes
        all-street the long way around, like a real GPS).

   v1.65.2 also fixes four defects the verify harness caught in the
   first v1.65 build, each documented at its site: buildGpsRoadIndex
   silently ignoring the records a zone merge passed it (every merged
   zone was a second copy of Adamsville); the seam stitch skipping
   already-folded border ends (zones merged but never joined — fixed
   by trySeamFold) and its quadratic node rewrite (reverse indexes);
   fold-centroid waypoints dragging the drawn line off-road and
   doubling it back in spikes (25u believability bound + anti-spike
   dedupe); and turn instructions sliding to the sharpest bend of a
   cluster instead of firing where the maneuver starts.

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
/* v1.65 state: the next off-road leg ahead (route.legs entry with
   dFrom/dTo filled by annotateRoute), and the lazy multi-zone graph
   extension — which zones' roads are merged into G, whether an
   extension fetch/build is in flight, and the pin waiting on it. */
var guideLeg=null;           // next off-road leg ahead, or null
var graphZones=[];           // zone ids whose roads are IN G (own graph)
var graphExtending=false;    // a zone extension is being fetched/built
var pendingDest=null;        // {x,z,name} the in-flight extension serves

/* ---------------------------------------------------------------------------
   fmtDist(u) — PLAYER-FACING distance text (Joshua's orders 2026-10-24:
   "do the math for the players — show mileage, not units", then refined
   the same day: short distances under one mile read in FEET). The game
   world is built at 1 unit = 1 metre, so 1 mile = 1609.344 units and
   1 unit = 3.28084 feet. EVERY distance the player sees (the HUD arrow
   band, the route-set / reroute toasts) goes through this one helper:
   under a mile it reads in whole feet (120u -> "394 ft"); a mile or
   more reads in miles with two decimals (1932u -> "1.20 mi", the exact
   case Joshua saw in his demo). Display only: routing math, off-route
   thresholds, and the internal Report/console diagnostics stay in raw
   units.
   --------------------------------------------------------------------------- */
function fmtDist(u){ u=Math.max(0, u||0);
  if (u<1609.344) return Math.round(u*3.28084)+' ft';
  return (u/1609.344).toFixed(2)+' mi'; }

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
function buildGpsRoadIndex(srcOpt){
  var idx=[];
  /* srcOpt: an explicit record array (zone extension builds). The
     original signature took no argument and always read the global
     roadDrawData — a zone merge that passed its records in had them
     silently ignored and re-indexed the boot zone instead (v1.65.2
     fix, caught by the verify harness: every "merged" zone was a
     second copy of Adamsville). */
  var src=srcOpt||((typeof roadDrawData!=='undefined')?roadDrawData:[]);
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
    /* v1.65: remember which zone this graph covers, so a pin in
       another zone can extend it (see ensureGraphForRoute). The player
       is standing in the loaded zone by definition; if that lookup
       ever fails, fall back to the middle of the road extents. */
    var bootZone=zoneOfPoint(playerPos().x, playerPos().z);
    if (!bootZone && idx.length){
      var bx0=1e18, bx1=-1e18, bz0=1e18, bz1=-1e18;
      for (var bi=0;bi<idx.length;bi++){
        var bp=idx[bi].r.pts[0];
        if (bp[0]<bx0) bx0=bp[0]; if (bp[0]>bx1) bx1=bp[0];
        if (bp[1]<bz0) bz0=bp[1]; if (bp[1]>bz1) bz1=bp[1];
      }
      bootZone=zoneOfPoint((bx0+bx1)/2, (bz0+bz1)/2);
    }
    graphZones=bootZone?[bootZone]:[];
    try{
      var edgeCount=0, ks=Object.keys(G.adj);
      for (var i=0;i<ks.length;i++) edgeCount+=G.adj[ks[i]].length;
      if (typeof Report!=='undefined') Report.setSys('gps',{status:'ok',
        version:'1.65.2', nodes:G.nNodes, edges:Math.round(edgeCount/2),
        isolatedRoads:G.nIsolated, source:'own', zones:graphZones.slice(),
        junctionBuildMs:jx.buildMs, crossings:jx.nCross,
        gapBridges:jx.nGap||0,
        note:'GPS graph from roadDrawData (traffic-independent); routes follow streets; other zones merge in lazily on cross-zone pins'});
    }catch(e){}
    if (prevRoute){
      rerouteActiveDest(prevRoute.quality);
    }
    /* v1.65: a pin placed while only the traffic graph (or no graph)
       existed may target a zone this graph doesn't cover either —
       extend now that the own graph is the base. */
    maybeExtendForRoute();
  }catch(e){
    ownGraphFailed=true;
    try{ if(typeof Report!=='undefined') Report.noteError('gps','own graph build failed',String(e&&e.message||e)); }catch(x){}
  }
}

/* ---------------------------------------------------------------------------
   rerouteActiveDest(prevQuality) — recompute the active route on the
   current graph (used when the graph changes under a live pin: the own
   graph landing, or a zone extension merging in). Announces only an
   IMPROVEMENT, so upgrades feel like the GPS catching up, not nagging.
   --------------------------------------------------------------------------- */
function rerouteActiveDest(prevQuality){
  if (!route) return;
  var res=computeRoute(route.destX, route.destZ, route.destName, playerPos());
  if (!res || !res.route) return;
  route=res.route; route.quality=res.quality;
  annotateRoute(route);
  guideIdx=0; guideProg=0; offRouteCount=0; lastRouteSetAt=Date.now();
  rebuildRouteMesh();
  var improved=(prevQuality==='direct' && res.quality!=='direct') ||
               (prevQuality==='partial' && res.quality==='streets');
  if (improved){
    try{ showToast('\uD83E\uDDED Route updated — now following the streets', 2200); }catch(e){}
  }
  try{ if (typeof Report!=='undefined') Report.note('gps',
    'route recomputed on graph change: '+Math.round(route.dist)+
    'u, quality '+res.quality); }catch(e){}
}

/* ===========================================================================
   v1.65 LAZY MULTI-ZONE GRAPH — the boot graph covers the loaded zone
   (roadDrawData). A pin in another zone used to fall to a straight leg
   kilometres long. Now the graph EXTENDS on demand: the needed zones'
   roads.json are fetched (MapDelivery's local store first, then the
   network — the same discipline goto.js uses for cross-zone landings),
   each zone's junction graph is built with the same builder, junctions
   are stitched across the seam, and everything merges into G. Boot
   cost is unchanged; a cross-zone pin pays a one-off fetch+build per
   new zone per session, with the interim route on screen meanwhile.
   =========================================================================== */
/* Zone rectangles — fallback copy of zoneloader.js's ZONE_BOUNDS (the
   live ZONEUNLOCK.zoneAt() is preferred whenever it is loaded). */
var GPS_ZONE_RECTS={
  'mableton':    {xMin:-7480.585387323972, xMax:-832.1294014084006,  zMin:-4248.536971831284, zMax:8266.53697183079},
  'adamsville':  {xMin:-832.1294014084006,  xMax:8377.129401408598,  zMin:-4248.536971831284, zMax:8266.53697183079},
  'downtown':    {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:-4248.536971831284, zMax:2555.720070422735},
  'eastatlanta': {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:2555.720070422735,  zMax:8266.53697183079},
  'unioncity':   {xMin:-7480.585387323972, xMax:-832.1294014084006,  zMin:8266.53697183079,   zMax:30877.519366197153},
  'southfulton': {xMin:-832.1294014084006,  xMax:8377.129401408598,  zMin:8266.53697183079,   zMax:30877.519366197153},
  'riverdale':   {xMin:8377.129401408598,   xMax:16314.485035211088, zMin:8266.53697183079,   zMax:30877.519366197153}
};
function zoneOfPoint(x, z){
  try{
    if (typeof ZONEUNLOCK!=='undefined' && ZONEUNLOCK && ZONEUNLOCK.zoneAt){
      var id=ZONEUNLOCK.zoneAt(x, z);
      if (id) return id;
    }
  }catch(e){}
  for (var k in GPS_ZONE_RECTS){
    var r=GPS_ZONE_RECTS[k];
    if (x>=r.xMin && x<=r.xMax && z>=r.zMin && z<=r.zMax) return k;
  }
  return null;
}
/* zonesNeededFor(from, dest) — the zones a street route between the
   two points may need: both endpoint zones plus every zone the
   straight line between them crosses (sampled every 100u — the zone
   tiles are thousands of units wide, so a crossed zone can't hide). */
function zonesNeededFor(from, dest){
  var set={}, out=[];
  function add(x, z){
    var id=zoneOfPoint(x, z);
    if (id && !set[id]){ set[id]=1; out.push(id); }
  }
  add(from.x, from.z); add(dest.x, dest.z);
  var d=Math.hypot(dest.x-from.x, dest.z-from.z);
  var steps=Math.max(1, Math.ceil(d/100));
  for (var i=1;i<steps;i++)
    add(from.x+(dest.x-from.x)*i/steps, from.z+(dest.z-from.z)*i/steps);
  return out;
}
/* fetchZoneRoadsText(zid) — the zone's roads.json, local map store
   first (MapDelivery.serveText — which resolves null on a miss), then
   a plain cache-busted fetch. Mirrors goto.js's fetchZoneText. */
function fetchZoneRoadsText(zid){
  var path='zones/'+zid+'/roads.json';
  function network(){
    var v='';
    try{ v=window.__MAPVER||''; }catch(e){}
    var url=path+(v?('?v='+encodeURIComponent(v)):'');
    return fetch(url, {cache:'no-store'}).then(function(r){
      if (!r || !r.ok) throw new Error(path+' — HTTP '+(r&&r.status));
      return r.text();
    });
  }
  try{
    if (typeof MapDelivery!=='undefined' && MapDelivery.serveText){
      return MapDelivery.serveText(path).then(function(t){
        return (t!==null && t!==undefined)? t : network();
      }, function(){ return network(); });
    }
  }catch(e){}
  return network();
}
/* flattenZoneRoads(data) — a zone roads.json ({class: [records]}) in
   the roadDrawData record shape buildGpsRoadIndex consumes. */
function flattenZoneRoads(data){
  var out=[];
  var W={interstate:34, highway:22, major_artery:20, minor_artery:18.4, local:7.2};
  try{
    if (typeof ROAD_WIDTHS!=='undefined' && ROAD_WIDTHS) W=ROAD_WIDTHS;
  }catch(e){}
  for (var k in data){
    var arr=data[k]; if (!arr) continue;
    for (var i=0;i<arr.length;i++){
      var r=arr[i];
      out.push({pts:r.pts, ys:r.ys, name:r.name, cat:k, w:W[k]||10});
    }
  }
  return out;
}
/* stitchZoneJunctions(idx, jx) — join junctions ACROSS a zone seam in
   a combined index/junction structure (the per-zone builders only
   ever saw their own zone's geometry, so a street clipped at the
   boundary has its two halves in different junction graphs). Only
   road ends that are connected to NOTHING are attempted, with the
   builder's own rules in the builder's order: endpoint clusters
   (25u, grade-checked, merging any pre-existing nodes the two sides
   already assigned), endpoint-on-segment T-joins (14u), then
   front-hemisphere gap bridges (110u). Returns the stitch count. */
function stitchZoneJunctions(idx, jx, roadOff){
  var JX_GRADE=3;
  var nodes=jx.nodes, endNode=jx.endNode, crossByRoad=jx.crossByRoad;
  var NCELL=40, ngrid={};
  function nKey(x,z){ return Math.floor(x/NCELL)+','+Math.floor(z/NCELL); }
  function nodeAdd(N){
    var ni=nodes.length; nodes.push(N);
    var k=nKey(N.x,N.z); (ngrid[k]=ngrid[k]||[]).push(ni);
    return ni;
  }
  nodes.forEach(function(N, ni){
    var k=nKey(N.x,N.z); (ngrid[k]=ngrid[k]||[]).push(ni);
  });
  function nodeNear(x, z, r){
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
  /* segment grid over the combined index */
  var SCELL=100, sgrid={};
  idx.forEach(function(R, ri){
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
  /* road ends + an ends grid for cluster lookups */
  var ends=[];
  idx.forEach(function(R, ri){
    for (var e=0;e<2;e++){
      var p=R.r.pts[e===0?0:R.r.pts.length-1];
      ends.push({ri:ri, end:e, x:p[0], z:p[1],
                 y:(R.r.ys?R.r.ys[e===0?0:R.r.ys.length-1]:0)});
    }
  });
  var ECELL=50, egrid={};
  ends.forEach(function(E){
    var k=Math.floor(E.x/ECELL)+','+Math.floor(E.z/ECELL);
    (egrid[k]=egrid[k]||[]).push(E);
  });
  function endConnected(ri, e){
    if (endNode[ri+':'+e]!==undefined) return true;
    var R=idx[ri], list=crossByRoad[ri]||[];
    var segSpan=(e===0)? (R.cum[1]-R.cum[0]) : (R.len-R.cum[R.cum.length-2]);
    for (var i=0;i<list.length;i++){
      var dEnd=(e===0)? list[i].segT : (R.len-list[i].segT);
      if (dEnd<=segSpan+15) return true;
    }
    return false;
  }
  /* rewriteNode(loser, winner) — two zone builds may have assigned
     DIFFERENT nodes to what is physically one seam junction; folding
     the loser into the winner (every endNode + cross reference) is
     what actually joins the two halves for A*. Folds go through
     reverse indexes (node -> its end keys / cross entries) built
     once here: rescanning the whole junction graph per fold is
     quadratic — with thousands of seam folds a merge took minutes
     (measured in the harness; v1.65.2 fix). Assignments made during
     this stitch register through regEnd/regCross so the indexes
     stay truthful. */
  var endsByNode={}, crossByNode={};
  for (var k0 in endNode){
    var n0=endNode[k0];
    (endsByNode[n0]=endsByNode[n0]||[]).push(k0);
  }
  crossByRoad.forEach(function(list){
    list.forEach(function(en){
      (crossByNode[en.node]=crossByNode[en.node]||[]).push(en);
    });
  });
  function regEnd(k, n){
    endNode[k]=n;
    (endsByNode[n]=endsByNode[n]||[]).push(k);
  }
  function regCross(ri, en){
    crossByRoad[ri].push(en);
    (crossByNode[en.node]=crossByNode[en.node]||[]).push(en);
  }
  function rewriteNode(loser, winner){
    if (loser===winner) return;
    var ek=endsByNode[loser]||[];
    ek.forEach(function(k){ endNode[k]=winner; });
    if (ek.length){
      (endsByNode[winner]=endsByNode[winner]||[]).push.apply(
        endsByNode[winner], ek);
      endsByNode[loser]=[];
    }
    var ce=crossByNode[loser]||[];
    ce.forEach(function(en){ en.node=winner; });
    if (ce.length){
      (crossByNode[winner]=crossByNode[winner]||[]).push.apply(
        crossByNode[winner], ce);
      crossByNode[loser]=[];
    }
  }
  function tryCluster(E){
    var gx=Math.floor(E.x/ECELL), gz=Math.floor(E.z/ECELL), group=[E];
    for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
      var arr=egrid[ix+','+iz]; if(!arr) continue;
      for (var i=0;i<arr.length;i++){
        var B=arr[i]; if (B===E) continue;
        var dx=B.x-E.x, dz=B.z-E.z;
        if (dx*dx+dz*dz>25*25) continue;
        if (Math.abs(B.y-E.y)>JX_GRADE) continue;
        group.push(B);
      }
    }
    if (group.length<2) return false;
    var winner=-1, sx=0, sz=0, sy=0;
    group.forEach(function(B){
      sx+=B.x; sz+=B.z; sy+=B.y;
      var en=endNode[B.ri+':'+B.end];
      if (en!==undefined && winner<0) winner=en;
    });
    if (winner<0){
      winner=nodeNear(sx/group.length, sz/group.length, 25);
      if (winner<0)
        winner=nodeAdd({x:sx/group.length, z:sz/group.length,
                        y:sy/group.length, kind:'stitch'});
    }
    group.forEach(function(B){
      var k=B.ri+':'+B.end, en=endNode[k];
      if (en===undefined) regEnd(k, winner);
      else if (en!==winner) rewriteNode(en, winner);
    });
    return true;
  }
  function tryTee(E){
    var gx=Math.floor(E.x/SCELL), gz=Math.floor(E.z/SCELL), best=null;
    for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
      var arr=sgrid[ix+','+iz]; if(!arr) continue;
      for (var i=0;i<arr.length;i++){
        var sg=arr[i]; if (sg.ri===E.ri) continue;
        var R=idx[sg.ri], a=R.r.pts[sg.s], b=R.r.pts[sg.s+1];
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
    if (!best) return false;
    var ni=nodeNear(best.x, best.z, 25);
    if (ni<0) ni=nodeAdd({x:best.x, z:best.z, y:best.y, kind:'stitch'});
    regEnd(E.ri+':'+E.end, ni);
    regCross(best.ri, {segT:roadSegT(idx[best.ri],best.s,best.t),
                               node:ni});
    return true;
  }
  function tryGap(E){
    var GAP_R=110;
    var R=idx[E.ri], pts=R.r.pts, ys=R.r.ys;
    var pi=(E.end===0)?0:pts.length-1, pj=(E.end===0)?1:pts.length-2;
    var ex=pts[pi][0], ez=pts[pi][1], ey=ys[pi];
    var hx=ex-pts[pj][0], hz=ez-pts[pj][1];
    var hl=Math.sqrt(hx*hx+hz*hz); if (hl<0.01) return false; hx/=hl; hz/=hl;
    var best=null, seenSeg={};
    var gx=Math.floor(ex/SCELL), gz=Math.floor(ez/SCELL),
        RR=Math.ceil(GAP_R/SCELL);
    for (var ix=gx-RR;ix<=gx+RR;ix++) for (var iz=gz-RR;iz<=gz+RR;iz++){
      var cell=sgrid[ix+','+iz]; if(!cell) continue;
      for (var ci=0;ci<cell.length;ci++){
        var sg=cell[ci], key=sg.ri+':'+sg.s;
        if (seenSeg[key]) continue; seenSeg[key]=1;
        if (sg.ri===E.ri) continue;
        var B=idx[sg.ri]; if (!B) continue;
        var a=B.r.pts[sg.s], b=B.r.pts[sg.s+1]; if (!a||!b) continue;
        var abx=b[0]-a[0], abz=b[1]-a[1], L2=abx*abx+abz*abz||1;
        var tt=((ex-a[0])*abx+(ez-a[1])*abz)/L2;
        tt=Math.max(0, Math.min(1, tt));
        var qx=a[0]+tt*abx, qz=a[1]+tt*abz;
        var dx=qx-ex, dz=qz-ez, d2=dx*dx+dz*dz;
        if (d2>GAP_R*GAP_R || d2<1) continue;
        var d=Math.sqrt(d2);
        if ((dx*hx+dz*hz)/d<0) continue;   // front hemisphere only
        var qy=segYat(B, sg.s, tt);
        if (Math.abs(qy-ey)>JX_GRADE) continue;
        if (!best || d<best.d) best={d:d, rj:sg.ri, sj:sg.s, t:tt, x:qx, z:qz, y:qy};
      }
    }
    if (!best) return false;
    var ni=nodeNear(best.x, best.z, 35);
    if (ni<0) ni=nodeAdd({x:best.x, z:best.z, y:best.y, kind:'stitch'});
    regCross(best.rj, {segT:roadSegT(idx[best.rj], best.sj, best.t),
                               node:ni});
    regEnd(E.ri+':'+E.end, ni);
    return true;
  }
  /* trySeamFold(E) — THE seam join (v1.65.1). Each zone's own build
     folds its border ends into its own nodes, so by stitch time both
     halves of a border crossing are already "connected" — to two
     DIFFERENT nodes a few units apart, and the endConnected skip
     below never looks at them. (First version of this stitch missed
     exactly that: zones merged, zero seams joined, cross-zone routes
     still fell to the gap fallback.) So: any end whose 25u cluster
     mixes ends from BOTH sides of the merge (ri below/above roadOff)
     with two or more distinct assigned nodes gets those nodes folded
     into one. Groups inside a single side are left exactly as that
     side's build decided them. */
  function trySeamFold(E){
    var gx=Math.floor(E.x/ECELL), gz=Math.floor(E.z/ECELL);
    var group=[], hasOld=false, hasNew=false, nodesSeen=[], seenN={};
    for (var ix=gx-1;ix<=gx+1;ix++) for (var iz=gz-1;iz<=gz+1;iz++){
      var arr=egrid[ix+','+iz]; if(!arr) continue;
      for (var i=0;i<arr.length;i++){
        var B=arr[i];
        var dx=B.x-E.x, dz=B.z-E.z;
        if (dx*dx+dz*dz>25*25) continue;
        if (Math.abs(B.y-E.y)>JX_GRADE) continue;
        group.push(B);
        if (B.ri<roadOff) hasOld=true; else hasNew=true;
        var en=endNode[B.ri+':'+B.end];
        if (en!==undefined && !seenN[en]){ seenN[en]=1; nodesSeen.push(en); }
      }
    }
    if (!hasOld || !hasNew || nodesSeen.length<2) return false;
    var winner=nodesSeen[0];
    for (var gi=0;gi<group.length;gi++){
      if (group[gi].ri<roadOff){
        var wen=endNode[group[gi].ri+':'+group[gi].end];
        if (wen!==undefined){ winner=wen; break; }
      }
    }
    nodesSeen.forEach(function(n){ if (n!==winner) rewriteNode(n, winner); });
    group.forEach(function(B){
      var k=B.ri+':'+B.end;
      if (endNode[k]===undefined) regEnd(k, winner);
    });
    return true;
  }
  var nStitch=0;
  for (var pass=0; pass<2; pass++){
    var progressed=false;
    for (var ei=0;ei<ends.length;ei++){
      var E=ends[ei];
      if (trySeamFold(E)){ nStitch++; progressed=true; continue; }
      if (endConnected(E.ri, E.end)) continue;
      if (tryCluster(E) || tryTee(E) || tryGap(E)){
        nStitch++; progressed=true;
      }
    }
    if (!progressed) break;
  }
  /* sort + dedupe every cross list, the builder's own final pass */
  crossByRoad.forEach(function(a, ri){
    a.sort(function(p,q){ return p.segT-q.segT; });
    var w=[], last=-1;
    for (var i=0;i<a.length;i++){
      if (a[i].node===last) continue;
      w.push(a[i]); last=a[i].node;
    }
    jx.crossByRoad[ri]=w;
  });
  return nStitch;
}
/* buildZoneIntoGraph(zid, text) — build one fetched zone's junction
   graph, stitch it against everything already in G, merge, and swap
   the enlarged graph in atomically. The build runs inside a timeout
   so the caller (a pin tap) paints its interim route first. */
function buildZoneIntoGraph(zid, text){
  return new Promise(function(resolve, reject){
    setTimeout(function(){
      try{
        var data=JSON.parse(text);
        var idx=buildGpsRoadIndex(flattenZoneRoads(data));
        if (idx.length<10){
          reject(new Error('zone '+zid+': only '+idx.length+' usable roads'));
          return;
        }
        var jx=buildGpsJunctionGraph(idx);
        var roadOff=G.roadsRef.length, nodeOff=G.jx.nodes.length;
        var cIdx=G.roadsRef.concat(idx);
        var cNodes=G.jx.nodes.concat(jx.nodes);
        var cEnd={};
        for (var k in G.jx.endNode) cEnd[k]=G.jx.endNode[k];
        Object.keys(jx.endNode).forEach(function(kk){
          var p=kk.split(':');
          cEnd[(parseInt(p[0],10)+roadOff)+':'+p[1]]=jx.endNode[kk]+nodeOff;
        });
        var cCross=G.jx.crossByRoad.slice();
        jx.crossByRoad.forEach(function(list){
          cCross.push(list.map(function(en){
            return {segT:en.segT, node:en.node+nodeOff};
          }));
        });
        var cJx={nodes:cNodes, endNode:cEnd, crossByRoad:cCross};
        var nStitch=stitchZoneJunctions(cIdx, cJx, roadOff);
        var g2=buildRoutingGraph(cIdx, cJx);
        G=g2; buildNodeGrid(G.nodePos);
        if (graphZones.indexOf(zid)<0) graphZones.push(zid);
        try{ if (typeof Report!=='undefined') Report.note('gps',
          'graph extended with zone '+zid+': +'+idx.length+' roads, '+
          nStitch+' seam stitches; graph now '+G.nNodes+' nodes, zones '+
          graphZones.join(',')); }catch(e){}
        resolve(true);
      }catch(e){ reject(e); }
    }, 30);
  });
}
/* ensureGraphForRoute(from, dest) — if a street route between the two
   points needs zones the graph doesn't have, fetch + build + merge
   them (async), then recompute the active route on the bigger graph.
   Returns true when an extension was started (the caller can word its
   toast as "finding the street route…" instead of a final answer). */
function ensureGraphForRoute(from, dest){
  try{
    if (graphExtending) return false;
    if (!G || graphSource!=='own'){
      /* extensions merge into the OWN graph only — force that build
         first (a pin tap already does this when no graph exists; its
         completion hook re-enters via maybeExtendForRoute). */
      try{ buildOwnGraph(); }catch(e){}
      return graphExtending;
    }
    var need=zonesNeededFor(from, dest).filter(function(z){
      return graphZones.indexOf(z)<0;
    });
    if (!need.length) return false;
    pendingDest={x:dest.x, z:dest.z, name:dest.name};
    return extendGraphWith(need);
  }catch(e){
    graphExtending=false;
    return false;
  }
}
/* extendGraphWith(need) — fetch + build + merge the named zones into
   G (sequentially: each merge re-stitches against the growing graph),
   then recompute the active route on the bigger graph and re-check
   both extension triggers. Caller has already set pendingDest and
   verified no extension is running. Returns true (it always starts). */
function extendGraphWith(need){
  graphExtending=true;
  var texts={};
  var fetches=need.map(function(zid){
    return fetchZoneRoadsText(zid).then(function(t){ texts[zid]=t; });
  });
  Promise.all(fetches).then(function(){
    var chain=Promise.resolve();
    need.forEach(function(zid){
      chain=chain.then(function(){ return buildZoneIntoGraph(zid, texts[zid]); });
    });
    return chain;
  }).then(function(){
    graphExtending=false; pendingDest=null;
    rerouteActiveDest(route? route.quality : null);
    maybeExtendForRoute();
    maybeGapRetry();
  }, function(err){
    graphExtending=false; pendingDest=null;
    try{ if (typeof Report!=='undefined') Report.noteError('gps',
      'zone graph extension failed', String(err&&err.message||err)); }catch(e){}
  });
  return true;
}
/* neighborZonesOf(zid) — zones sharing a tile edge with zid. */
function neighborZonesOf(zid){
  var r=GPS_ZONE_RECTS[zid]; if (!r) return [];
  var out=[];
  for (var k in GPS_ZONE_RECTS){
    if (k===zid) continue;
    var o=GPS_ZONE_RECTS[k];
    var shareV=(Math.abs(o.xMax-r.xMin)<1 || Math.abs(o.xMin-r.xMax)<1) &&
               Math.min(o.zMax, r.zMax)>Math.max(o.zMin, r.zMin);
    var shareH=(Math.abs(o.zMax-r.zMin)<1 || Math.abs(o.zMin-r.zMax)<1) &&
               Math.min(o.xMax, r.xMax)>Math.max(o.xMin, r.xMin);
    if (shareV || shareH) out.push(k);
  }
  return out;
}
/* maybeGapRetry() — v1.65.2 second-stage extension. A route that
   still ends in a GAP leg means the destination's street pocket is
   not connected to the player's network IN THE GRAPH SO FAR — but
   the pocket may join the network around the back, through a
   NEIGHBOURING zone the straight line never crosses (measured: the
   Cascade/Danforth pocket is an island inside Adamsville alone, yet
   connects south into South Fulton; with that zone merged, the same
   pin routes all-street the long way around — what a real GPS does).
   So once per destination, when a gap route is showing, pull the
   destination zone's neighbours in too and recompute. Bounded: one
   retry per destination point, only while a gap leg is showing. */
var gapRetryKey=null;
function maybeGapRetry(){
  try{
    if (!route || graphExtending || !G || graphSource!=='own') return false;
    if (route.quality!=='partial') return false;
    var hasGap=false;
    (route.legs||[]).forEach(function(l){ if (l.kind==='gap') hasGap=true; });
    if (!hasGap) return false;
    var key=Math.round(route.destX)+','+Math.round(route.destZ);
    if (gapRetryKey===key) return false;
    var dz=zoneOfPoint(route.destX, route.destZ);
    if (!dz) return false;
    var missing=neighborZonesOf(dz).filter(function(z){
      return graphZones.indexOf(z)<0;
    });
    gapRetryKey=key;   // one retry per destination, whatever happens
    if (!missing.length) return false;
    try{ showToast('\uD83E\uDDED Checking the streets around '+
      (route.destName||'the destination')+' for a way in\u2026', 2400); }catch(e){}
    pendingDest={x:route.destX, z:route.destZ, name:route.destName};
    return extendGraphWith(missing);
  }catch(e){ return false; }
}
/* maybeExtendForRoute() — extension check for the ACTIVE route (used
   after graph swaps, when a pin set earlier may still be waiting for
   its zones to arrive). */
function maybeExtendForRoute(){
  try{
    if (!route || graphExtending) return;
    ensureGraphForRoute(playerPos(),
      {x:route.destX, z:route.destZ, name:route.destName});
  }catch(e){}
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
  /* v1.65: binary-heap open list (the pre-1.65 linear-scan pop was
     fine at ~2-6k nodes but seconds-slow on a merged multi-zone
     graph). Heap entries are IMMUTABLE [f, node] pairs: when a node
     is improved it is pushed again with its new key, and the stale
     entry is recognised on pop (its key no longer matches the node's
     best known f) and skipped. Same optimal cost as before — the
     Euclidean heuristic is consistent, so a node's first non-stale
     pop is final. NOTE: score lookups must test for undefined, never
     `||` — the start node's gScore is legitimately 0, and 0||x is x
     (that exact slip killed an earlier draft of this rewrite: the
     search died at the start node and every route fell to direct). */
  var gScore={}, fScore={}, came={}, closed={};
  function gOf(n){ return gScore[n]===undefined? 1e18 : gScore[n]; }
  var heap=[];
  function hPush(f, n){
    heap.push([f, n]);
    var i=heap.length-1;
    while (i>0){
      var p=(i-1)>>1;
      if (heap[p][0]<=heap[i][0]) break;
      var t=heap[p]; heap[p]=heap[i]; heap[i]=t; i=p;
    }
  }
  function hPop(){
    var top=heap[0], last=heap.pop();
    if (heap.length){
      heap[0]=last;
      var i=0;
      for (;;){
        var l=2*i+1, r=l+1, m=i;
        if (l<heap.length && heap[l][0]<heap[m][0]) m=l;
        if (r<heap.length && heap[r][0]<heap[m][0]) m=r;
        if (m===i) break;
        var t=heap[m]; heap[m]=heap[i]; heap[i]=t; i=m;
      }
    }
    return top;
  }
  gScore[start]=0; fScore[start]=h(start); hPush(fScore[start], start);
  var guard=0;
  while (heap.length && guard++<1000000){
    var topE=hPop(), cur=topE[1];
    if (closed[cur]) continue;
    if (topE[0]>(fScore[cur]||1e18)+1e-9) continue;   // stale entry
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
      var tg=gOf(cur)+edges[e].w;
      if (tg<gOf(nb)){
        came[nb]=cur; gScore[nb]=tg; fScore[nb]=tg+h(nb);
        hPush(fScore[nb], nb);
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
   polyline using each edge's stored road + arc range. Decimates to
   keep the point count sane for the 3D ribbon + canvas drawing.
   v1.65 returns {pts, roads}: roads[i] is the roadsRef index that
   produced pts[i] (-1 for an inserted junction waypoint), which is
   what turn-by-turn street naming reads.
   Two truth fixes over the pre-1.65 version:
     - PARALLEL EDGES: two nodes can be joined by several edges
       (divided carriageways, duplicate records). The old code drew
       the FIRST; A* may have costed another. Now the edge whose arc
       endpoints sit closest to the two node positions wins — the
       carriageway the junction actually belongs to.
     - JUNCTION WAYPOINTS: one node can aggregate endpoints and
       crossings up to ~90u apart (transitive endpoint clustering),
       so hop N's road point and hop N+1's road point are NOT the
       same place; joining them directly chorded across corners and
       blocks (measured: cuts up to ~200u inside 'streets' routes).
       The node's own position is now inserted between hops whenever
       it sits off both arc points, so the line travels THROUGH the
       junction the way a driven route does.
   --------------------------------------------------------------------------- */
function pathToPolyline(nodePath){
  var adj=G.adj, roads=(G&&G.roadsRef)||[], pos=G.nodePos;
  var out=[], outRoad=[];
  function pushPt(x, z, ri){
    var n=out.length;
    if (n>0){
      var dx=x-out[n-1].x, dz=z-out[n-1].z;
      if (dx*dx+dz*dz<25) return;   // decimate: min 5u spacing
    }
    out.push({x:x, z:z}); outRoad.push(ri);
  }
  function pickEdge(a, b){
    var edges=adj[a]||[], best=null, bestScore=1e18;
    for (var e=0;e<edges.length;e++){
      if (edges[e].to!==b) continue;
      var R=roads[edges[e].ri]; if (!R) continue;
      var pa=roadPointAt(R, edges[e].tA), pb=roadPointAt(R, edges[e].tB);
      var score=Math.hypot(pa.x-pos[a].x, pa.z-pos[a].z)+
                Math.hypot(pb.x-pos[b].x, pb.z-pos[b].z);
      if (score<bestScore){ bestScore=score; best=edges[e]; }
    }
    return best;
  }
  var prevEnd=null;   // last point sampled for the previous hop
  for (var i=0;i<nodePath.length-1;i++){
    var a=nodePath[i], b=nodePath[i+1];
    var edge=pickEdge(a, b);
    if (!edge) continue;
    var R=roads[edge.ri];
    if (!R) continue;
    var first=roadPointAt(R, edge.tA);
    if (prevEnd){
      var np=pos[a];
      var dPrev=Math.hypot(np.x-prevEnd.x, np.z-prevEnd.z);
      var dNext=Math.hypot(np.x-first.x, np.z-first.z);
      /* v1.65.2: insert the junction waypoint only when the node's
         stored position is a believable junction point — more than
         3u from both arc ends (else it adds nothing) but within 25u
         of both. Fold centroids can sit 40u+ off the roads they join
         (phantom folds); detouring to one of those walks the route
         through grass at the junction, which is the very complaint
         this build fixes. When the node is a phantom, the two arc
         ends — both on real road geometry — carry the join. */
      if (dPrev>3 && dNext>3 && dPrev<=25 && dNext<=25)
        pushPt(np.x, np.z, -1);
    }
    var t0=edge.tA, t1=edge.tB, steps=Math.max(2, Math.ceil(Math.abs(t1-t0)/40));
    for (var s=0;s<=steps;s++){
      var t=t0+(t1-t0)*s/steps;
      var p=roadPointAt(R,t);
      pushPt(p.x, p.z, edge.ri);
      if (s===steps) prevEnd=p;
    }
  }
  return {pts:out, roads:outRoad};
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
  var d=Math.hypot(x-from.x, z-from.z);
  return {pts:[{x:from.x,z:from.z},{x:x,z:z}], destX:x, destZ:z,
          destName:name||'Destination', dist:d, quality:'direct',
          /* v1.65: even a direct route declares its one off-road leg,
             so guidance can say "no street route" instead of implying
             the line is a road. */
          ptRoad:[-1,-1],
          legs:[{kind:'gap', fromIdx:0, toIdx:1, len:d, street:null}]};
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
/* bfsComponent(seeds) — the set of graph nodes reachable from the
   seed nodes (one connected street network). Used by computeRoute's
   disconnected-destination plan. */
function bfsComponent(seeds){
  var reach={}, stack=[];
  seeds.forEach(function(n){
    if (!reach[n]){ reach[n]=1; stack.push(n); }
  });
  while (stack.length){
    var cn=stack.pop(), ce=G.adj[cn]||[];
    for (var ei=0;ei<ce.length;ei++)
      if (!reach[ce[ei].to]){ reach[ce[ei].to]=1; stack.push(ce[ei].to); }
  }
  return reach;
}
function computeRoute(x, z, name, from){
  name=name||'Destination';
  if (!G) return {route:directRoute(x, z, name, from), quality:'direct'};
  var roads=G.roadsRef;
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
  /* v1.65: endpoint snaps reach 400u (was 60u). A destination set
     back from its street — a school parcel, a gas-station lot, a
     house — used to fall back to its nearest JUNCTION and cut the
     last stretch straight; now it brackets on its own street and
     only the final approach is an off-road leg (labelled as one in
     route.legs). Same for the player's own position. */
  var pSnap=pointRoadSnapG(from.x, from.z, 400);
  var dSnap=pointRoadSnapG(x, z, 400);
  var sCands=bracketCands(pSnap, nA, from.x, from.z);
  var gCands=bracketCands(dSnap, nB, x, z);
  /* bestPathBetween(fC, tC) — cheapest bracket-to-bracket A* over
     the candidate pairs; {path, sc, gc, cost} or null. */
  function bestPathBetween(fC, tC){
    var best=null;
    for (var si=0;si<fC.length;si++) for (var gi=0;gi<tC.length;gi++){
      var sc=fC[si], gc=tC[gi];
      var path=(sc.node===gc.node)? [sc.node] : astar(sc.node, gc.node);
      if (!path) continue;
      var cost=sc.legLen+pathCost(path)+gc.legLen;
      if (!best || cost<best.cost) best={path:path, sc:sc, gc:gc, cost:cost};
    }
    return best;
  }
  var best=bestPathBetween(sCands, gCands);
  var pocket=null;   // disconnected-destination plan (see below)
  if (!best){
    /* DISCONNECTED-DESTINATION PLAN (v1.65, replacing the v1.64.1
       reachable-node fallback). The destination's street pocket is
       not connected to the player's network in the data (measured on
       Adamsville: the Cascade/Danforth pocket — 186 junction nodes
       around Cascade Rd SW / Danforth Rd SW — has NO road link to
       the Campbellton/Dollar Mill network; a roadless band in the
       baked data). The v1.64.1 fallback drew ONE straight line from
       the nearest reachable junction clear to the destination —
       measured 1,070u, most of it alongside the pocket's own
       streets. Faking a street across the band would be a lie, so
       now: streets as far as the player's network reaches, ONE
       straight 'gap' leg that lands on the pocket's street point
       nearest the network, then the pocket's own streets in to the
       door. If the destination has no street at all (no snap, or its
       road carries no junctions), the gap leg runs from the network
       edge to the destination itself and guidance says so. */
    var reach=bfsComponent(sCands.map(function(c){ return c.node; }));
    var nearGoal=-1, nearD=Infinity;
    for (var nk in reach){
      var np=G.nodePos[nk];
      var nd=Math.hypot(x-np.x, z-np.z);
      if (nd<nearD){ nearD=nd; nearGoal=+nk; }
    }
    if (nearGoal>=0){
      var main=null;
      for (var mi=0;mi<sCands.length;mi++){
        var mp=(sCands[mi].node===nearGoal)? [nearGoal]
                                           : astar(sCands[mi].node, nearGoal);
        if (!mp) continue;
        var mc=sCands[mi].legLen+pathCost(mp);
        if (!main || mc<main.cost)
          main={path:mp, sc:sCands[mi],
                gc:{node:nearGoal, legLen:0, roadRi:-1, segT:0}, cost:mc};
      }
      if (main && dSnap && gCands[0].roadRi>=0){
        /* the destination pocket's component, and its street point
           nearest the network edge node */
        var compD=bfsComponent(gCands.map(function(c){ return c.node; }));
        var roadSeen={}, land=null;
        var ngp=G.nodePos[nearGoal];
        for (var cn in compD){
          var ce=G.adj[cn]||[];
          for (var ei2=0;ei2<ce.length;ei2++){
            var ri2=ce[ei2].ri;
            if (roadSeen[ri2]) continue; roadSeen[ri2]=1;
            var R2=roads[ri2]; if (!R2) continue;
            var pp2=R2.r.pts;
            for (var si2=0;si2<pp2.length-1;si2++){
              var a2=pp2[si2], b2=pp2[si2+1];
              var abx=b2[0]-a2[0], abz=b2[1]-a2[1], L2=abx*abx+abz*abz||1;
              var tt=((ngp.x-a2[0])*abx+(ngp.z-a2[1])*abz)/L2;
              tt=Math.max(0, Math.min(1, tt));
              var qx=a2[0]+tt*abx, qz=a2[1]+tt*abz;
              var dd=Math.hypot(ngp.x-qx, ngp.z-qz);
              if (!land || dd<land.d)
                land={ri:ri2,
                      segT:R2.cum[si2]+tt*(R2.cum[si2+1]-R2.cum[si2]),
                      x:qx, z:qz, d:dd};
            }
          }
        }
        if (land){
          var landSnap={ri:land.ri, segT:land.segT, d:0, x:land.x, z:land.z};
          var eCands=bracketCands(landSnap, gCands[0].node, land.x, land.z);
          var inner=bestPathBetween(eCands, gCands);
          if (inner) pocket={main:main, land:land, inner:inner};
        }
      }
      if (!pocket && main) pocket={main:main, land:null, inner:null};
    }
  }
  if (!best && !pocket)
    return {route:directRoute(x, z, name, from), quality:'direct'};
  /* ---------- assembly (v1.65) ----------
     The polyline is built piece by piece so every vertex knows which
     road produced it (ptRoad, -1 = off-road or a junction waypoint)
     and every off-road stretch is recorded as an explicit leg:
       {kind:'start'} player -> his street (street = its name)
       {kind:'end'}   the street -> the destination's door
       {kind:'gap'}   across a place the street data does not connect
     Junction joins pass through the junction node's own position
     when it sits off the sampled line, so joins don't chord. */
  var pts=[], ptRoad=[], legs=[];
  function AP(px, pz, ri){
    var l=pts[pts.length-1];
    if (l && Math.hypot(px-l.x, pz-l.z)<3) return pts.length-1;
    /* v1.65.2 anti-spike: a junction node's stored position can sit
       BEHIND the arc progress (its fold centroid equals a point the
       route already sampled a few vertices back). Appending it makes
       the polyline double back on itself in a 20-30u spike — drawn
       as a zigzag, measured as wild fake "turns" (a -180° U-turn
       showed up in annotation). A point within 6u of any of the
       previous four is a revisit, not progress: skip it. Genuine
       revisits (a loop route passing a junction again) are many
       vertices apart and unaffected. */
    for (var q=Math.max(0, pts.length-5); q<pts.length-1; q++)
      if (Math.hypot(px-pts[q].x, pz-pts[q].z)<6) return pts.length-1;
    pts.push({x:px, z:pz}); ptRoad.push(ri); return pts.length-1;
  }
  function APF(px, pz, ri){
    pts.push({x:px, z:pz}); ptRoad.push(ri); return pts.length-1;
  }
  function joinVia(node){
    if (node===undefined || node===null || node<0) return;
    var np=G.nodePos[node], l=pts[pts.length-1];
    /* same 25u believability bound as pathToPolyline's waypoints:
       a phantom fold centroid is not a place the route should visit */
    if (l){
      var jd=Math.hypot(np.x-l.x, np.z-l.z);
      if (jd>3 && jd<=25) AP(np.x, np.z, -1);
    }
  }
  function sampleInto(ri, t0, t1){
    var sp=sampleRoadPts(ri, t0, t1);
    for (var i=0;i<sp.length;i++) AP(sp[i].x, sp[i].z, ri);
  }
  function pathInto(nodePath){
    var pp=pathToPolyline(nodePath);
    for (var i=0;i<pp.pts.length;i++) AP(pp.pts[i].x, pp.pts[i].z, pp.roads[i]);
  }
  function roadName(ri){
    var R=roads[ri];
    return R? (R.name||null) : null;
  }
  function startInto(sc){
    APF(from.x, from.z, -1);
    if (sc.roadRi>=0){
      var sp=roadPointAt(roads[sc.roadRi], sc.snapSegT);
      var spi=AP(sp.x, sp.z, sc.roadRi);
      if (pSnap && pSnap.d>2)
        legs.push({kind:'start', fromIdx:0, toIdx:spi, len:pSnap.d,
                   street:roadName(sc.roadRi)});
      sampleInto(sc.roadRi, sc.snapSegT, sc.segT);
      joinVia(sc.node);
    } else {
      var ni=AP(G.nodePos[sc.node].x, G.nodePos[sc.node].z, -1);
      legs.push({kind:'start', fromIdx:0, toIdx:ni, len:sc.legLen,
                 street:null});
    }
  }
  function endInto(gc){
    if (gc.roadRi>=0){
      joinVia(gc.node);
      sampleInto(gc.roadRi, gc.segT, gc.snapSegT);
      var dp=roadPointAt(roads[gc.roadRi], gc.snapSegT);
      var dpi=AP(dp.x, dp.z, gc.roadRi);
      var di=APF(x, z, -1);
      if (dSnap && dSnap.d>2)
        legs.push({kind:'end', fromIdx:dpi, toIdx:di, len:dSnap.d,
                   street:roadName(gc.roadRi)});
    } else {
      var li=pts.length-1;
      var di2=APF(x, z, -1);
      legs.push({kind:'end', fromIdx:li, toIdx:di2, len:gc.legLen,
                 street:null});
    }
  }
  if (best){
    startInto(best.sc);
    pathInto(best.path);
    endInto(best.gc);
  } else {
    startInto(pocket.main.sc);
    pathInto(pocket.main.path);
    if (pocket.land){
      joinVia(pocket.main.gc.node);
      var lf=pts.length-1;
      var li2=APF(pocket.land.x, pocket.land.z, pocket.land.ri);
      legs.push({kind:'gap', fromIdx:lf, toIdx:li2, len:pocket.land.d,
                 street:null});
      sampleInto(pocket.land.ri, pocket.land.segT, pocket.inner.sc.segT);
      joinVia(pocket.inner.sc.node);
      pathInto(pocket.inner.path);
      endInto(pocket.inner.gc);
    } else {
      var ngp2=G.nodePos[pocket.main.gc.node];
      var lf2=pts.length-1;
      var di3=APF(x, z, -1);
      legs.push({kind:'gap', fromIdx:lf2, toIdx:di3,
                 len:Math.hypot(x-ngp2.x, z-ngp2.z), street:null});
    }
  }
  /* quality: 'streets' when the whole trip runs on roads except
     driveway-scale legs (<=60u, the pre-1.65 threshold); any gap leg
     or longer off-road stretch makes it 'partial', named as such. */
  var hasGap=false, maxLeg=0;
  legs.forEach(function(l){
    if (l.kind==='gap') hasGap=true;
    if (l.len>maxLeg) maxLeg=l.len;
  });
  var quality=hasGap? 'partial' : (maxLeg>60? 'partial' : 'streets');
  var dist=0;
  for (var di=1;di<pts.length;di++)
    dist+=Math.hypot(pts[di].x-pts[di-1].x, pts[di].z-pts[di-1].z);
  return {route:{pts:pts, ptRoad:ptRoad, legs:legs, destX:x, destZ:z,
                 destName:name, dist:dist, quality:quality},
          quality:quality};
}

/* roadDisplayName(ri) — the name guidance may speak for a road, or
   null when the record carries no real name (the 'Unnamed St'
   placeholder and build fallbacks are not names a driver can use;
   guidance falls back to "the next street" phrasing for those). */
function roadDisplayName(ri){
  if (!G || !G.roadsRef) return null;
  var R=G.roadsRef[ri];
  if (!R || !R.name) return null;
  if (R.name==='Unnamed St' || /^road#\d+$/.test(R.name)) return null;
  return R.name;
}

/* annotateRoute(rt) — precompute what guidance needs: cumulative
   distance along the polyline, the instruction list, and the off-road
   legs' along-route spans. An instruction is either a real TURN (a
   direction change of 30°+ measured over a ±20u window, so a curving
   street doesn't spam micro-turns; turns closer than 30u merge into
   the sharper one) or a CONTINUE (v1.65: the route changes streets
   without a bend — a real GPS still names the new street). Every
   instruction names the street being turned onto, read from the
   polyline's road attribution (rt.ptRoad): the first attributed road
   at/after the instruction point. Guidance reads these — it never
   recomputes them. */
function annotateRoute(rt){
  var pts=rt.pts, cum=[0];
  for (var i=1;i<pts.length;i++)
    cum.push(cum[i-1]+Math.hypot(pts[i].x-pts[i-1].x, pts[i].z-pts[i-1].z));
  rt.cum=cum; rt.totalDist=cum[cum.length-1]||0;
  var legs=rt.legs||[];
  legs.forEach(function(l){
    l.dFrom=cum[Math.min(l.fromIdx, cum.length-1)]||0;
    l.dTo=cum[Math.min(l.toIdx, cum.length-1)]||0;
  });
  var startLeg=null, endLeg=null;
  legs.forEach(function(l){
    if (l.kind==='start') startLeg=l;
    if (l.kind==='end') endLeg=l;
  });
  function heading(a,b){ return Math.atan2(b.x-a.x, b.z-a.z); }
  function wrapPi(a){
    while (a>Math.PI) a-=2*Math.PI;
    while (a<-Math.PI) a+=2*Math.PI;
    return a;
  }
  var turns=[];
  for (var j=1;j<pts.length-1;j++){
    var back=j, fwd=j;
    while (back>0 && cum[j]-cum[back]<20) back--;
    while (fwd<pts.length-1 && cum[fwd]-cum[j]<20) fwd++;
    if (fwd===j || back===j) continue;
    var deg=wrapPi(heading(pts[j],pts[fwd])-heading(pts[back],pts[j]))*180/Math.PI;
    if (Math.abs(deg)<30) continue;
    var last=turns[turns.length-1];
    if (last && cum[j]-last.d<30){
      /* v1.65.2: a merged cluster keeps the FIRST bend's position —
         the instruction must fire where the maneuver STARTS. The
         pre-1.65.2 rule slid the position to the sharpest bend,
         which in a junction complex (several bends across ~180u)
         put the instruction 60-100u past the first deviation, and
         guidance spoke late. The angle still adopts the sharpest
         bend in the cluster, so the glyph stays honest. */
      if (Math.abs(deg)>Math.abs(last.ang)) last.ang=deg;
      continue;
    }
    turns.push({d:cum[j], idx:j, ang:deg});
  }
  /* suppress "turns" that are really the endpoint connectors (the
     angle between the player's yard and his street is not a turn,
     and the door approach is not one either — the legs speak for
     those stretches). */
  if (rt.ptRoad){
    turns=turns.filter(function(t){
      if (startLeg && t.idx<=startLeg.toIdx) return false;
      if (endLeg && t.idx>=endLeg.fromIdx) return false;
      return true;
    });
    /* attach street names: the street AFTER the instruction point */
    function roadAfter(idx){
      for (var i=idx;i<rt.ptRoad.length;i++)
        if (rt.ptRoad[i]>=0) return rt.ptRoad[i];
      return -1;
    }
    function roadBefore(idx){
      for (var i=idx-1;i>=0;i--)
        if (rt.ptRoad[i]>=0) return rt.ptRoad[i];
      return -1;
    }
    turns.forEach(function(t){
      var ra=roadAfter(t.idx), rb=roadBefore(t.idx);
      t.name=(ra>=0)? roadDisplayName(ra) : null;
      t.streetChange=(ra>=0 && rb>=0 && ra!==rb);
      t.cont=false;
    });
    /* CONTINUE instructions at street changes with no bend */
    var conts=[], lastRi=-1;
    for (var ci=0;ci<rt.ptRoad.length;ci++){
      var ri=rt.ptRoad[ci];
      if (ri<0) continue;
      if (lastRi>=0 && ri!==lastRi){
        var nmNew=roadDisplayName(ri), nmOld=roadDisplayName(lastRi);
        var inLeg=false;
        for (var li=0;li<legs.length;li++)
          if (ci>legs[li].fromIdx && ci<=legs[li].toIdx){ inLeg=true; break; }
        if (!inLeg && nmNew && nmNew!==nmOld)
          conts.push({d:cum[ci], idx:ci, ang:0, cont:true,
                      name:nmNew, streetChange:true});
      }
      lastRi=ri;
    }
    conts.forEach(function(c){
      for (var ti=0;ti<turns.length;ti++)
        if (Math.abs(turns[ti].d-c.d)<45) return;   // a turn covers it
      turns.push(c);
    });
    turns.sort(function(a,b){ return a.d-b.d; });
  }
  rt.turns=turns;
}

/* instructionText(ins, distU) — the guidance band's words for one
   instruction (v1.65): glyph + the street being turned onto + the
   distance to it, e.g. "↰ onto Cascade Rd SW · 394 ft". A change onto
   an unnamed street reads "onto the next street"; a plain bend on a
   named street still names it; a bend on an unnamed street is just
   "Turn". Continues read "⬆ Continue on <street>". */
function instructionText(ins, distU){
  var d=fmtDist(Math.max(0, distU));
  if (ins.cont)
    return '\u2B06 '+(ins.name? ('Continue on '+ins.name) : 'Continue straight')+
           ' \u00B7 '+d;
  var g=turnGlyph(ins.ang);
  if (ins.name) return g+' onto '+ins.name+' \u00B7 '+d;
  if (ins.streetChange) return g+' onto the next street \u00B7 '+d;
  return g+' Turn \u00B7 '+d;
}

/* turnGlyph(angDeg) — GPS-style instruction arrow for a signed turn.
   Sign convention (game yaw = atan2(dx,dz), +z = south on the map): a
   POSITIVE angle change is a LEFT turn, negative is RIGHT — verified
   against known turns in the boot harness (see GPS-REWORK-NOTES.md). */
function turnGlyph(ang){
  var a=Math.abs(ang), left=ang>0;
  if (a<12) return '\u2B06';                   // straight ⬆ (continues)
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
  /* v1.65: the next off-road leg ahead, if any — when it is nearer
     than the next turn, the arrows aim along it and the band speaks
     for it (a driver about to leave the street network should hear
     that, not a turn instruction for a junction past the gap). */
  guideLeg=null;
  var legs=route.legs||[];
  for (var li=0;li<legs.length;li++){
    if ((legs[li].dTo||0)>guideProg+5){ guideLeg=legs[li]; break; }
  }
  var legD=guideLeg? (guideLeg.dFrom-guideProg) : Infinity;
  var turnD=guideNextTurn? (guideNextTurn.d-guideProg) : Infinity;
  if (guideLeg && legD<turnD){
    if (guideProg<guideLeg.dFrom-5)
      guideTarget=pointAtDist(route, guideLeg.dFrom);
    else
      guideTarget=pointAtDist(route, Math.min(guideLeg.dTo, guideProg+55));
  } else if (guideNextTurn && turnD<85){
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
    fmtDist(route.dist), 2200); }catch(e){}
  try{ if(typeof Report!=='undefined') Report.note('gps',
    'auto-reroute: '+Math.round(route.dist)+'u, quality '+res.quality); }catch(e){}
  /* v1.65: a reroute can also discover the destination needs zones
     the graph doesn't have (e.g. the pin predates the extension). */
  maybeExtendForRoute();
  maybeGapRetry();
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
  /* v1.65: if this pin needs zones the graph doesn't have yet, start
     the extension now — the toast below then promises the street
     route is being found instead of presenting the interim answer
     (streets-to-the-edge plus a straight leg) as final. */
  var extStarted=false;
  try{ extStarted=ensureGraphForRoute(from, {x:x, z:z, name:name}); }catch(e){}
  /* Player-facing toast distances via fmtDist — feet under a
     mile, miles over (Joshua 2026-10-24) — the Report.note below stays in raw units (internal). */
  try{
    if (extStarted && res.quality!=='streets'){
      showToast('\uD83E\uDDED Navigating to '+(route.destName)+
        ' \u2014 '+fmtDist(route.dist)+
        ' (finding the street route\u2026)', 3000);
    } else if (res.quality==='partial'){
      var gapLeg=null, maxLeg=0;
      (route.legs||[]).forEach(function(l){
        if (l.kind==='gap') gapLeg=l;
        if (l.len>maxLeg) maxLeg=l.len;
      });
      if (gapLeg){
        showToast('\uD83E\uDDED Navigating to '+(route.destName)+
          ' \u2014 '+fmtDist(route.dist)+
          ' (streets as far as they go \u2014 no street connects across a '+
          fmtDist(gapLeg.len)+' gap in the map data)', 3400);
      } else {
        showToast('\uD83E\uDDED Navigating to '+(route.destName)+
          ' \u2014 '+fmtDist(route.dist)+
          ' (streets, then '+fmtDist(maxLeg)+' off-road to the door)', 3000);
      }
    } else if (res.quality==='direct'){
      showToast('\uD83E\uDDF5 Navigating to '+(route.destName)+
        ' \u2014 '+fmtDist(route.dist)+
        ' (direct \u2014 no street route in the map data)', 2600);
    } else {
      showToast('\uD83E\uDDED Navigating to '+(route.destName)+
        ' \u2014 '+fmtDist(route.dist), 2600);
    }
  }catch(e){}
  try{ if(typeof Report!=='undefined') Report.note('gps',
    'route set: '+(route.destName)+' '+Math.round(route.dist)+'u, '+
    route.pts.length+' pts, quality '+res.quality); }catch(e){}
  /* v1.65.2: a gap route to a same-zone pocket (nothing for the
     line-based extension to fetch) still gets its one neighbour
     retry — the pocket may connect around the back. */
  maybeGapRetry();
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
    version:'1.65.2',
    graph:G?{source:graphSource, nodes:G.nNodes,
             edges:Math.round(ec/2), isolated:G.nIsolated,
             zones:graphZones.slice(), extending:graphExtending}:null,
    ownBuilt:ownGraphBuilt, ownFailed:ownGraphFailed,
    route:route?{quality:route.quality||'?', dist:Math.round(route.dist),
                 pts:route.pts.length, turns:(route.turns||[]).length,
                 totalDist:Math.round(route.totalDist||0),
                 ptsList:route.pts.map(function(p){
                   return [Math.round(p.x), Math.round(p.z)]; }),
                 ptRoad:(route.ptRoad||[]).slice(),
                 legsList:(route.legs||[]).map(function(l){
                   return {kind:l.kind, fromIdx:l.fromIdx, toIdx:l.toIdx,
                           len:Math.round(l.len), street:l.street||null,
                           dFrom:Math.round(l.dFrom||0),
                           dTo:Math.round(l.dTo||0)}; }),
                 turnsList:(route.turns||[]).map(function(t){
                   return {d:Math.round(t.d), idx:t.idx,
                           ang:Math.round(t.ang), glyph:turnGlyph(t.ang),
                           name:t.name||null, cont:!!t.cont,
                           streetChange:!!t.streetChange}; })}:null,
    guidance:{prog:Math.round(guideProg),
              off:(guideOff===1e9?-1:Math.round(guideOff)),
              remaining:Math.round(guideRemaining),
              nextTurn:guideNextTurn?{inU:Math.round(guideNextTurn.d-guideProg),
                                      ang:Math.round(guideNextTurn.ang),
                                      glyph:turnGlyph(guideNextTurn.ang),
                                      name:guideNextTurn.name||null,
                                      text:instructionText(guideNextTurn,
                                        guideNextTurn.d-guideProg)}:null,
              nextLeg:guideLeg?{kind:guideLeg.kind,
                                inU:Math.round(guideLeg.dFrom-guideProg),
                                len:Math.round(guideLeg.len)}:null,
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
  version:'1.65.2'
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
    if (typeof Report!=='undefined') Report.setSys('gps',{status:'ok',version:'1.65.2',
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
     the turn line shows its arrow + distance, like a real GPS.
     Both rendered distances go through fmtDist — feet under a mile,
     miles over (Joshua 2026-10-24); the 500u above stays internal. */
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
    /* v1.65: the band speaks for whichever feature comes first — an
       off-road leg (named as what it is) or the next instruction
       (glyph + the street being turned onto + distance). */
    var featTxt=null;
    var legD2=guideLeg? (guideLeg.dFrom-guideProg) : Infinity;
    var turnD2=guideNextTurn? (guideNextTurn.d-guideProg) : Infinity;
    if (guideLeg && legD2<turnD2 && legD2<=500){
      var legLeft=Math.max(0, guideLeg.dTo-guideProg);
      if (guideLeg.kind==='gap'){
        featTxt='\u26A0 No street route \u2014 direct '+fmtDist(legLeft);
      } else if (guideLeg.kind==='start'){
        featTxt='\uD83E\uDDED Head to '+(guideLeg.street||'the street')+
          (legLeft>15? ' \u00B7 '+fmtDist(legLeft) : '');
      } else {
        featTxt='\u26A0 Off-road \u2014 '+(route.destName||'destination')+
          ' '+fmtDist(legLeft);
      }
    } else if (guideNextTurn && turnD2<=500){
      featTxt=instructionText(guideNextTurn, turnD2);
    }
    if (featTxt){
      hudArrowTurn.textContent=featTxt;
      hudArrowTurn.style.display='block';
    } else {
      hudArrowTurn.style.display='none';
    }
  }
  if (hudArrowDist) hudArrowDist.textContent=(route.destName||'Destination')+
    ' \u2022 '+fmtDist(guideRemaining||Math.hypot(route.destX-p.x, route.destZ-p.z));
}

})();
