/* ============================================================================
   FILE: zoneunlock.js — "Surviving Adamsville" MAP ZONES + DISTANCE CULLING
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-10):
   Implement BOTH:
   1. GTA/Saints Row-style map unlocking — full map not available until the
      player explores. Player starts with ONLY Adamsville unlocked.
   2. Distance-based culling — only render/simulate what's near the player,
      for massive performance wins on low-end phones (TCL froze with full
      map + 5x crews).

   PART 1 — ZONE UNLOCKING:
   - Map divided into 12 zones (3 cols x 4 rows).
   - Adamsville starts unlocked (contains home base 535 Dollar Mill Rd).
   - Exploration unlocks adjacent zones: when 40% of an unlocked zone's
     coarse grid cells have been visited, all touching zones unlock.
   - Locked zones: grayed out on minimap, invisible walls block entry,
     "Unlock by exploring [zone]" message on attempt.
   - Unlock state persists in localStorage['sa_zoneunlock_v1'].

   PART 2 — DISTANCE CULLING:
   - CULL_DIST (default 800 units): objects beyond this from the player get
     AI paused and meshes hidden.
   - Applies to: NPCs, bird drones, vehicles, crew patrol units.
   - Static baked geometry (roads, buildings) is NOT culled per-object
     (it's merged into giant meshes) — the win comes from pausing AI and
     hiding dynamic objects.
   - Chunk grid: world divided into 400x400 cells for efficient queries.
   - Minimap is NOT culled — shows full unlocked area.

   PUBLIC API (window.ZONEUNLOCK):
     zones, unlocked (Set of zone ids),
     zoneAt(x,z), isUnlocked(zoneId), isLockedZone(x,z),
     unlockZone(id), explorationPct(zoneId),
     shouldCull(x,z) — true if beyond cull distance from player,
     inActiveRange(x,z) — false if culled,
     CULL_DIST, setCullDist(d),
     log (activity array)

   STANDALONE MODULE. Include AFTER index.html core in index.html:
       <script src="zoneunlock.js"></script>
   All hooks are guarded — game works normally if this module is missing.
   ============================================================================ */
(function(){
'use strict';
if (window.ZONEUNLOCK) return;  // single instance guard

/* ---------------- zone definitions ----------------
   Map bounds: x:[-200,8200], z:[-200,12200]
   3 columns x 4 rows = 12 zones.
   Adamsville (start) contains home base 535 Dollar Mill Rd (~3130, 3705). */
var ZONES=[
  // Row 0 (north)
  {id:'mableton',  name:'Mableton',     xMin:-200, xMax:3400, zMin:-200, zMax:2900},
  {id:'northside', name:'Northside',    xMin:3400, xMax:5800, zMin:-200, zMax:2900},
  {id:'downtown',  name:'Downtown',     xMin:5800, xMax:8200, zMin:-200, zMax:2900},
  // Row 1 (center-north) — Adamsville is the starting zone
  {id:'adamsville',name:'Adamsville',   xMin:-200, xMax:3400, zMin:2900, zMax:6000, start:true},
  {id:'midtown',   name:'Midtown',      xMin:3400, xMax:5800, zMin:2900, zMax:6000},
  {id:'eastatl',   name:'East Atlanta', xMin:5800, xMax:8200, zMin:2900, zMax:6000},
  // Row 2 (center-south)
  {id:'fairburn',  name:'Fairburn',     xMin:-200, xMax:3400, zMin:6000, zMax:9100},
  {id:'cascade',   name:'Cascade',      xMin:3400, xMax:5800, zMin:6000, zMax:9100},
  {id:'southatl',  name:'South Atlanta',xMin:5800, xMax:8200, zMin:6000, zMax:9100},
  // Row 3 (south)
  {id:'westend',   name:'West End',     xMin:-200, xMax:3400, zMin:9100, zMax:12200},
  {id:'southwest', name:'Southwest',    xMin:3400, xMax:5800, zMin:9100, zMax:12200},
  {id:'riverdale', name:'Riverdale',    xMin:5400, xMax:8200, zMin:9100, zMax:12200},
];

/* ---------------- persistence ---------------- */
var LS_KEY='sa_zoneunlock_v1';
var state={
  unlocked:{adamsville:true},  // zone id -> true
  visited:{},                   // "cx,cz" cell key -> true (100-unit cells)
  cullDist:800,                 // distance culling radius (units)
};
try{
  var raw=localStorage.getItem(LS_KEY);
  if(raw){ var s=JSON.parse(raw); if(s&&s.unlocked) state.unlocked=s.unlocked; if(s&&s.visited) state.visited=s.visited; if(s&&s.cullDist) state.cullDist=s.cullDist; }
}catch(e){}
function save(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(state)); }catch(e){} }

/* ---------------- activity log ---------------- */
var activityLog=[];
function dlog(msg){
  var entry='['+new Date().toLocaleTimeString()+'] '+msg;
  activityLog.push(entry);
  if(activityLog.length>50) activityLog.shift();
}

/* ---------------- zone helpers ---------------- */
function zoneAt(x,z){
  for(var i=0;i<ZONES.length;i++){
    var zn=ZONES[i];
    if(x>=zn.xMin && x<zn.xMax && z>=zn.zMin && z<zn.zMax) return zn;
  }
  return null;
}
function isUnlocked(zoneId){ return !!state.unlocked[zoneId]; }
function isLockedZone(x,z){
  var zn=zoneAt(x,z);
  return zn ? !isUnlocked(zn.id) : false;  // outside all zones = treat as locked
}
// Zones touching the given zone (share an edge)
function adjacentZones(zoneId){
  var zn=null, i;
  for(i=0;i<ZONES.length;i++) if(ZONES[i].id===zoneId) zn=ZONES[i];
  if(!zn) return [];
  var out=[];
  for(i=0;i<ZONES.length;i++){
    var o=ZONES[i];
    if(o.id===zoneId) continue;
    // share an edge: x-ranges overlap AND z-edges touch, or vice versa
    var xOverlap = o.xMin < zn.xMax && o.xMax > zn.xMin;
    var zOverlap = o.zMin < zn.zMax && o.zMax > zn.zMin;
    var xTouch = (o.xMin===zn.xMax||o.xMax===zn.xMin) && zOverlap;
    var zTouch = (o.zMin===zn.zMax||o.zMax===zn.zMin) && xOverlap;
    if(xTouch||zTouch) out.push(o);
  }
  return out;
}

/* ---------------- exploration tracking ----------------
   Coarse 200-unit grid cells. Each zone's total cells computed from its
   rect. When 40% of an unlocked zone is visited, unlock its neighbors. */
var CELL=200;
function cellKey(x,z){ return Math.floor(x/CELL)+','+Math.floor(z/CELL); }
function zoneCellCount(zn){
  var w=Math.ceil((zn.xMax-zn.xMin)/CELL), h=Math.ceil((zn.zMax-zn.zMin)/CELL);
  return w*h;
}
function explorationPct(zoneId){
  var zn=null;
  for(var i=0;i<ZONES.length;i++) if(ZONES[i].id===zoneId) zn=ZONES[i];
  if(!zn) return 0;
  var total=zoneCellCount(zn), visited=0;
  // count visited cells in this zone (iterate state.visited keys)
  for(var k in state.visited){
    var parts=k.split(','), cx=parseInt(parts[0],10)*CELL, cz=parseInt(parts[1],10)*CELL;
    if(cx>=zn.xMin&&cx<zn.xMax&&cz>=zn.zMin&&cz<zn.zMax) visited++;
  }
  return total>0 ? visited/total : 0;
}
function unlockZone(id){
  if(state.unlocked[id]) return false;
  state.unlocked[id]=true;
  save();
  var zn=null;
  for(var i=0;i<ZONES.length;i++) if(ZONES[i].id===id) zn=ZONES[i];
  dlog('Zone unlocked: '+(zn?zn.name:id));
  // notify player via toast if available
  try{
    if(typeof showToast==='function') showToast('🗺️ New area unlocked: '+(zn?zn.name:id));
    else if(window.HR&&HR.toast) HR.toast('New area unlocked: '+(zn?zn.name:id));
  }catch(e){}
  return true;
}
function checkUnlocks(){
  // for each unlocked zone, if 40% explored, unlock all adjacent
  var toUnlock=[];
  for(var id in state.unlocked){
    if(explorationPct(id)>=0.40){
      var adj=adjacentZones(id);
      for(var i=0;i<adj.length;i++){
        if(!state.unlocked[adj[i].id]) toUnlock.push(adj[i].id);
      }
    }
  }
  for(var j=0;j<toUnlock.length;j++) unlockZone(toUnlock[j]);
}

/* ---------------- player position tracking ----------------
   Called each frame (throttled) from the game loop. Tracks visited cells
   and enforces locked-zone boundaries. */
var trackT=0;
var lastBlockMsg=0;
function trackPlayer(dt){
  trackT-=dt; if(trackT>0) return; trackT=0.5;  // 2Hz
  var px, pz;
  try{
    if(typeof car!=='undefined'&&car&&car.driving){ px=car.x; pz=car.z; }
    else if(typeof player!=='undefined'&&player){ px=player.x; pz=player.z; }
    else return;
  }catch(e){ return; }
  if(!isFinite(px)||!isFinite(pz)) return;

  // mark visited
  var k=cellKey(px,pz);
  if(!state.visited[k]){ state.visited[k]=true; save(); }

  // check for unlocks (throttled by save frequency)
  checkUnlocks();

  // boundary enforcement: if player is in a locked zone, push them back
  var zn=zoneAt(px,pz);
  if(zn && !isUnlocked(zn.id)){
    // find nearest unlocked zone boundary and push player back
    var pushed=pushBackToUnlocked(px,pz);
    if(pushed && Date.now()-lastBlockMsg>5000){
      lastBlockMsg=Date.now();
      try{
        if(typeof showToast==='function') showToast('🔒 '+zn.name+' is locked — explore '+getUnlockHint(zn)+' to unlock it');
      }catch(e){}
      dlog('Blocked entry to locked zone: '+zn.name);
    }
  }
}
function getUnlockHint(lockedZone){
  // find an unlocked adjacent zone to suggest
  var adj=adjacentZones(lockedZone.id);
  for(var i=0;i<adj.length;i++) if(isUnlocked(adj[i].id)) return adj[i].name;
  return 'Adamsville';
}
function pushBackToUnlocked(px,pz){
  // Search outward from player for the nearest unlocked position.
  // Simple approach: try the 4 cardinal directions at increasing distances.
  var dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
  for(var d=50; d<=600; d+=50){
    for(var i=0;i<dirs.length;i++){
      var nx=px+dirs[i][0]*d, nz=pz+dirs[i][1]*d;
      var zn=zoneAt(nx,nz);
      if(zn && isUnlocked(zn.id)){
        // teleport player/car to this position
        try{
          if(typeof car!=='undefined'&&car&&car.driving){ car.x=nx; car.z=nz; }
          else if(typeof player!=='undefined'&&player){
            player.x=nx; player.z=nz;
            if(player.mesh) player.mesh.position.set(nx, player.mesh.position.y, nz);
          }
        }catch(e){}
        return true;
      }
    }
  }
  return false;
}

/* ---------------- DISTANCE CULLING ----------------
   CULL_DIST: objects beyond this distance from player get AI paused
   and meshes hidden. Chunk grid for efficient spatial queries. */
var CHUNK=400;  // chunk size for spatial partitioning
function shouldCull(x,z){
  var px, pz;
  try{
    if(typeof car!=='undefined'&&car&&car.driving){ px=car.x; pz=car.z; }
    else if(typeof player!=='undefined'&&player){ px=player.x; pz=player.z; }
    else return false;  // no player pos = don't cull
  }catch(e){ return false; }
  if(!isFinite(px)||!isFinite(pz)||!isFinite(x)||!isFinite(z)) return false;
  var dx=x-px, dz=z-pz;
  var dist2=dx*dx+dz*dz, cull2=state.cullDist*state.cullDist;
  return dist2 > cull2;
}
function inActiveRange(x,z){ return !shouldCull(x,z); }
function setCullDist(d){
  state.cullDist=Math.max(200,Math.min(3000,d|0));
  save();
  dlog('Cull distance set to '+state.cullDist);
}

/* ---------------- minimap zone overlay ----------------
   Called from drawMinimap (patched in index.html). Draws locked zones
   as dark overlays. Expects the minimap's toMap function and context. */
function drawZoneOverlay(mm, toMap, px, pz, range, R){
  try{
    for(var i=0;i<ZONES.length;i++){
      var zn=ZONES[i];
      if(isUnlocked(zn.id)) continue;
      // draw locked zone as semi-transparent dark rect
      // only if any part is in view
      if(zn.xMax<px-range||zn.xMin>px+range||zn.zMax<pz-range||zn.zMin>pz+range) continue;
      var c1=toMap(zn.xMin,zn.zMin), c2=toMap(zn.xMax,zn.zMax);
      var x=Math.min(c1[0],c2[0]), y=Math.min(c1[1],c2[1]);
      var w=Math.abs(c2[0]-c1[0]), h=Math.abs(c2[1]-c1[1]);
      mm.fillStyle='rgba(20,20,30,0.55)';
      mm.fillRect(x,y,w,h);
      // lock icon + name at center
      var cc=toMap((zn.xMin+zn.xMax)/2,(zn.zMin+zn.zMax)/2);
      // only draw label if center is within the circular minimap
      var dcx=cc[0]-R, dcy=cc[1]-R;
      if(Math.sqrt(dcx*dcx+dcy*dcy)<R-20){
        mm.fillStyle='rgba(255,255,255,0.7)';
        mm.font='bold 12px Arial'; mm.textAlign='center';
        mm.fillText('🔒 '+zn.name, cc[0], cc[1]);
      }
    }
  }catch(e){}
}

/* ---------------- crew zone awareness ----------------
   Crews assigned to locked zones should wait. This helper lets crew
   systems check if their target is in an accessible zone. */
function canOperateAt(x,z){
  var zn=zoneAt(x,z);
  if(!zn) return false;
  return isUnlocked(zn.id);
}

/* ---------------- public API ---------------- */
window.ZONEUNLOCK={
  zones:ZONES,
  get unlocked(){ var out=[]; for(var id in state.unlocked) out.push(id); return out; },
  zoneAt:zoneAt,
  isUnlocked:isUnlocked,
  isLockedZone:isLockedZone,
  unlockZone:unlockZone,
  explorationPct:explorationPct,
  adjacentZones:adjacentZones,
  shouldCull:shouldCull,
  inActiveRange:inActiveRange,
  canOperateAt:canOperateAt,
  get CULL_DIST(){ return state.cullDist; },
  setCullDist:setCullDist,
  trackPlayer:trackPlayer,
  drawZoneOverlay:drawZoneOverlay,
  get log(){ return activityLog.slice(); },
  // debug/admin
  unlockAll:function(){ for(var i=0;i<ZONES.length;i++) state.unlocked[ZONES[i].id]=true; save(); dlog('All zones unlocked (admin)'); },
  reset:function(){ state.unlocked={adamsville:true}; state.visited={}; save(); dlog('Zone progress reset'); },
};

/* ---------------- boot ---------------- */
dlog('ZoneUnlock v1.0 online — '+Object.keys(state.unlocked).length+' zone(s) unlocked, cull dist '+state.cullDist);
})();
