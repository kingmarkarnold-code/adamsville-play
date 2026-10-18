/* ============================================================================
   FILE: zoneunlock.js — "Surviving Adamsville" MAP ZONES + DISTANCE CULLING
   ----------------------------------------------------------------------------
   JOSHUA'S SPEC (2026-10-16, STEP 2 — replaces the original 2026-10-10
   design in full):

   PART 1 — ZONE UNLOCKING (password + union walls):
   - The 7 converted zones tile the stage rect with no gaps (bounds below
     are the EXACT converted zone.json bounds).
   - Zones unlock ONLY by password, entered in
     Settings → Advanced Properties:
       * per-zone password 5464 unlocks one tapped locked zone,
       * Unlock All password 092020 unlocks every zone at once.
   - In the future, completing a level's missions (Saints Row style) will
     unlock its zone by calling the SAME entry point:
         ZoneUnlock.unlock(id, 'mission')
     There is deliberately no other unlock path.
   - Unlock state persists in localStorage ONLY
     (key 'sa.zones.unlocked.v1'). Adamsville (home base) is ALWAYS
     unlocked and can never be re-locked.
   - UNLOCK CEREMONY (Joshua 2026-10-17): a correct password hands
     the unlock to zoneunlockflow.js when that module is loaded —
     pause, download progress bar, zone data download, minimap
     update — and the unlock COMMITS only once the data has landed
     (commitUnlock). A failed download leaves the zone locked; the
     old immediate flip survives only as the no-flow-module fallback.
   - Walls gate the PLAYER only (on foot and in the player's car). NPCs
     and traffic ignore the walls completely — nothing in this file ever
     moves or blocks an NPC/vehicle that is not the player's.
   - The playable area is a UNION: the stage rect shrunk by EDGE_MARGIN
     (the outer wall sits at the drawn ground's edge minus the margin),
     intersected with the union of the UNLOCKED zone rects. Movement
     resolves against that union with an axis slide, so the player hugs
     a locked zone's edge instead of teleporting or sticking.

   PART 2 — DISTANCE CULLING (unchanged from the original design):
   - CULL_DIST (default 800 units): objects beyond this from the player
     get AI paused and meshes hidden.
   - Applies to: NPCs, bird drones, vehicles, crew patrol units.
   - Static baked geometry (roads, buildings) is NOT culled per-object
     (it's merged into giant meshes) — the win comes from pausing AI and
     hiding dynamic objects.
   - Chunk grid: world divided into 400x400 cells for efficient queries.
   - Minimap is NOT culled — locked zones draw as dark overlays instead.

   PUBLIC APIs:
     window.ZoneUnlock — the STEP 2 API (passwords, isPlayable,
       resolveMove, unlock / unlockAll, stageRect, ...).
     window.ZONEUNLOCK — compatibility facade for existing callers
       (satellite_view.js reads .zones/.isUnlocked; index.html calls
       .trackPlayer/.blockLockedMovement/.drawZoneOverlay). Both names
       share ONE state object — see the facade comment near the bottom.

   STANDALONE MODULE. Loaded deferred by index.html like the other late
   systems. All hooks are guarded — the game works if this file is
   missing (index.html falls back to the plain stage-edge clamp).
   ============================================================================ */
(function(){
'use strict';
if (window.ZONEUNLOCK) return;  // single-instance guard (kept from v1)

/* ---------------- zone definitions ----------------
   The EXACT converted zone.json bounds (STEP 2). Together they tile the
   stage rect STAGE_X0..X1 / STAGE_Z0..Z1 with no gaps and no overlaps.
   Order is the spec order: home base first, then west/north row, then
   the southern row. `start:true` marks Adamsville as the home base. */
var ZONES=[
  {id:'adamsville', name:'Adamsville',   xMin:-832.1294014084006,  xMax:8377.129401408598,  zMin:-4248.536971831284, zMax:8266.53697183079,  start:true},
  {id:'mableton',   name:'Mableton',     xMin:-7480.585387323972,  xMax:-832.1294014084006, zMin:-4248.536971831284, zMax:8266.53697183079},
  {id:'downtown',   name:'Downtown',     xMin:8377.129401408598,   xMax:16314.485035211088, zMin:-4248.536971831284, zMax:2555.720070422735},
  {id:'eastatlanta',name:'East Atlanta', xMin:8377.129401408598,   xMax:16314.485035211088, zMin:2555.720070422735,  zMax:8266.53697183079},
  {id:'unioncity',  name:'Union City',   xMin:-7480.585387323972,  xMax:-832.1294014084006, zMin:8266.53697183079,   zMax:30877.519366197153},
  {id:'southfulton',name:'South Fulton', xMin:-832.1294014084006,  xMax:8377.129401408598,  zMin:8266.53697183079,   zMax:30877.519366197153},
  {id:'riverdale',  name:'Riverdale',    xMin:8377.129401408598,   xMax:16314.485035211088, zMin:8266.53697183079,   zMax:30877.519366197153}
];

/* ---------------- passwords (Joshua's spec, 2026-10-16) ----------------
   These literals live ONLY in this file. index.html never hard-codes
   them — the Settings UI calls tryUnlockWithPassword /
   tryUnlockAllWithPassword and this module does the comparison.
   ZONE_PASSWORD unlocks ONE zone; UNLOCK_ALL_PASSWORD unlocks all.
   The per-zone password must NOT work for Unlock All (and vice versa
   the two are simply different strings, compared exactly). */
var ZONE_PASSWORD='5464';
var UNLOCK_ALL_PASSWORD='092020';

/* ---------------- outer wall margin ----------------
   EDGE_MARGIN (units): the outer wall sits this far INSIDE the drawn
   ground's edge (the stage rect), so the player/car stop just before
   the visible edge of the world. Confirmed by Joshua 2026-10-16.
   index.html's clampToStage() reads this same value via the facade. */
var EDGE_MARGIN=60;

/* ---------------- persistence (localStorage ONLY) ----------------
   Saved shape: {v:1, unlocked:[zoneId, ...], cullDist:<number>}.
   Adamsville is forced unlocked on every load, whatever the save says,
   so a corrupt or hand-edited save can never lock the home base. */
var LS_KEY='sa.zones.unlocked.v1';
var state={
  unlocked:{adamsville:true},  // zone id -> true
  cullDist:800                 // distance culling radius (units)
};
function zoneById(id){
  // Linear scan is fine: only 7 zones, called at UI/throttle rates
  // (and once per frame by the wall — 7 comparisons is negligible).
  for(var i=0;i<ZONES.length;i++) if(ZONES[i].id===id) return ZONES[i];
  return null;
}
try{
  var raw=localStorage.getItem(LS_KEY);
  if(raw){
    var saved=JSON.parse(raw);
    if(saved){
      // Current shape stores unlocked as an array of zone ids.
      if(Object.prototype.toString.call(saved.unlocked)==='[object Array]'){
        for(var li=0;li<saved.unlocked.length;li++){
          if(zoneById(saved.unlocked[li])) state.unlocked[saved.unlocked[li]]=true;
        }
      }
      if(typeof saved.cullDist==='number' && isFinite(saved.cullDist)) state.cullDist=saved.cullDist;
    }
  }
}catch(e){}
/* Adamsville is ALWAYS unlocked — enforced after any load, forever. */
state.unlocked.adamsville=true;

/* ---------------- unlock-download flow hook ----------------
   zoneunlockflow.js (Joshua 2026-10-17) registers here so a correct
   password can run the full unlock ceremony — pause, download the
   zone's data with a progress bar, update the minimap — and only then
   commit the unlock through the callback it is handed. Signature:
     fn({zones:[zoneId,...], source, commit:function(id)->bool})
   returning true when it takes over. Null (module absent) keeps the
   original immediate-unlock behaviour below, so the game never
   depends on the flow module being present. */
var _unlockFlow=null;
function setUnlockFlow(fn){
  _unlockFlow=(typeof fn==='function') ? fn : null;
}
function unlockedIdsList(){
  // Ids of every currently-unlocked zone, in ZONES (spec) order.
  var out=[];
  for(var i=0;i<ZONES.length;i++) if(isUnlocked(ZONES[i].id)) out.push(ZONES[i].id);
  return out;
}
function save(){
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({
      v:1, unlocked:unlockedIdsList(), cullDist:state.cullDist
    }));
  }catch(e){}
}

/* ---------------- activity log ----------------
   Small ring buffer surfaced as ZONEUNLOCK.log for diagnostics. */
var activityLog=[];
function dlog(msg){
  var entry='['+new Date().toLocaleTimeString()+'] '+msg;
  activityLog.push(entry);
  if(activityLog.length>50) activityLog.shift();
}

/* ---------------- toast helper ----------------
   Same notification pattern the old module used: the game's showToast
   when the main script provides it, HR.toast as fallback, silence if
   neither exists (headless/diagnostic contexts must not throw). */
function notify(msg){
  try{
    if(typeof showToast==='function') showToast(msg);
    else if(window.HR && HR.toast) HR.toast(msg);
  }catch(e){}
}

/* ---------------- zone geometry helpers ---------------- */
function zoneAt(x,z){
  // Half-open test [xMin,xMax) x [zMin,zMax): because the zone rects
  // tile exactly, every interior point belongs to exactly ONE zone —
  // a point on a shared edge belongs to the zone east/south of it.
  for(var i=0;i<ZONES.length;i++){
    var zn=ZONES[i];
    if(x>=zn.xMin && x<zn.xMax && z>=zn.zMin && z<zn.zMax) return zn;
  }
  return null;
}
function isUnlocked(zoneId){
  // Adamsville (home base) is always unlocked, even if state is reset
  // or a save somehow lists it as locked.
  if(zoneId==='adamsville') return true;
  return !!state.unlocked[zoneId];
}
function pointInZoneClosed(zn,x,z){
  // Closed-rect test (edges included). Used for the playable UNION:
  // a point exactly on the seam between a locked and an unlocked zone
  // counts as inside the unlocked one, so the union has no hairline gap.
  return x>=zn.xMin && x<=zn.xMax && z>=zn.zMin && z<=zn.zMax;
}
function stageRect(){
  // The stage rect: prefer the live STAGE_* globals index.html defines
  // (single source of truth for the drawn ground); fall back to the
  // union of ZONES, which tiles the same rect by construction.
  try{
    if(typeof window.STAGE_X0==='number' && isFinite(window.STAGE_X0) &&
       typeof window.STAGE_X1==='number' && isFinite(window.STAGE_X1) &&
       typeof window.STAGE_Z0==='number' && isFinite(window.STAGE_Z0) &&
       typeof window.STAGE_Z1==='number' && isFinite(window.STAGE_Z1)){
      return {xMin:window.STAGE_X0, xMax:window.STAGE_X1,
              zMin:window.STAGE_Z0, zMax:window.STAGE_Z1};
    }
  }catch(e){}
  var r={xMin:Infinity, xMax:-Infinity, zMin:Infinity, zMax:-Infinity};
  for(var i=0;i<ZONES.length;i++){
    var zn=ZONES[i];
    if(zn.xMin<r.xMin) r.xMin=zn.xMin;
    if(zn.xMax>r.xMax) r.xMax=zn.xMax;
    if(zn.zMin<r.zMin) r.zMin=zn.zMin;
    if(zn.zMax>r.zMax) r.zMax=zn.zMax;
  }
  return r;
}
function isPlayable(x,z){
  // Playable = inside the stage rect shrunk by EDGE_MARGIN (the outer
  // wall) AND inside at least one UNLOCKED zone rect (the union walls).
  // This is the ONLY movement rule for the player/car — NPCs and
  // traffic never call it.
  if(!isFinite(x)||!isFinite(z)) return false;
  var r=stageRect();
  if(x<r.xMin+EDGE_MARGIN || x>r.xMax-EDGE_MARGIN ||
     z<r.zMin+EDGE_MARGIN || z>r.zMax-EDGE_MARGIN) return false;
  for(var i=0;i<ZONES.length;i++){
    var zn=ZONES[i];
    if(isUnlocked(zn.id) && pointInZoneClosed(zn,x,z)) return true;
  }
  return false;
}
function lockedZoneAt(x,z){
  // The locked zone containing (x,z), or null when the point is not in
  // a locked zone (unlocked zone, world edge, or outside every zone).
  // Used only to NAME the blocker in the wall toast / resolveMove.
  var zn=zoneAt(x,z);
  if(zn) return isUnlocked(zn.id) ? null : zn;
  // zoneAt is half-open, so points exactly on the outer max edges miss
  // every zone; retry with the closed test before giving up.
  for(var i=0;i<ZONES.length;i++){
    if(pointInZoneClosed(ZONES[i],x,z) && !isUnlocked(ZONES[i].id)) return ZONES[i];
  }
  return null;
}

/* ---------------- unlocking ----------------
   unlock() is THE unlock entry point: the password UI calls it via
   tryUnlockWithPassword, and future mission completion (Saints Row
   style) will call unlock(id, 'mission') directly. */

/* commitUnlock(id, source) — the ONE place unlock state actually
   flips: state + save + log, deliberately NO toast. unlock() adds
   the toast for the immediate paths; the unlock-download flow
   commits through here per zone once that zone's data has actually
   downloaded, and makes its own announcement on its overlay. */
function commitUnlock(id, source){
  var zn=zoneById(id);
  if(!zn) return false;              // unknown zone id: nothing to do
  if(isUnlocked(id)) return false;   // already unlocked: not "newly"
  state.unlocked[id]=true;
  save();
  dlog('Zone unlocked: '+zn.name+' (via '+(source||'api')+')');
  return true;
}
function unlock(id, source){
  if(!commitUnlock(id, source)) return false;
  var zn=zoneById(id);
  notify('🗺️ Zone unlocked: '+zn.name);
  return true;
}
/* Quiet per-zone unlock for unlockAll: flips state WITHOUT saving or
   toasting, so Unlock All produces exactly one save + one toast. */
function unlockQuiet(id){
  if(!zoneById(id)) return false;
  if(isUnlocked(id)) return false;
  state.unlocked[id]=true;
  return true;
}
function tryUnlockWithPassword(id, pw){
  // Exact string comparison against the per-zone password. A wrong
  // password changes NOTHING (no state write, no toast) — returns false.
  if(pw===null || pw===undefined || String(pw)!==ZONE_PASSWORD) return false;
  /* ZONE DOWNLOAD FLOW (Joshua 2026-10-17): a correct password no
     longer flips the zone open on the spot. When zoneunlockflow.js
     is loaded it takes over — pause, progress bar, zone download,
     minimap update — and commits through the callback only after
     the data has landed, so a failed download leaves the zone
     LOCKED instead of opening onto naked space. If the flow module
     is absent or declines, the immediate unlock below runs exactly
     as it always did. */
  if(!isUnlocked(id) && _unlockFlow){
    var took=false;
    try{
      took=_unlockFlow({ zones:[id], source:'password',
        commit:function(zid){ return commitUnlock(zid, 'password'); } });
    }catch(e){ took=false; }
    if(took) return true;  // flow owns the unlock now
  }
  unlock(id, 'password');
  return true;  // password was right, even if the zone was already open
}
function unlockAll(source){
  // Unlocks EVERY zone quietly, then saves once and fires ONE toast.
  // Returns how many zones were newly unlocked by this call.
  var newly=0;
  for(var i=0;i<ZONES.length;i++) if(unlockQuiet(ZONES[i].id)) newly++;
  save();
  dlog('All zones unlocked (via '+(source||'api')+') — '+newly+' new');
  notify('🗺️ All zones unlocked!');
  return newly;
}
function tryUnlockAllWithPassword(pw){
  // Exact string comparison against the UNLOCK ALL password ONLY.
  // The per-zone password ('5464') must NOT work here.
  if(pw===null || pw===undefined || String(pw)!==UNLOCK_ALL_PASSWORD) return false;
  /* ZONE DOWNLOAD FLOW (Joshua 2026-10-17): same ceremony as the
     per-zone path, over every still-locked zone in spec order —
     zoneunlockflow.js downloads them sequentially, committing each
     zone as its own data lands (a zone whose download fails stays
     locked; the ones before it stay unlocked). */
  var lockedIds=[];
  for(var i=0;i<ZONES.length;i++) if(!isUnlocked(ZONES[i].id)) lockedIds.push(ZONES[i].id);
  if(lockedIds.length && _unlockFlow){
    var tookAll=false;
    try{
      tookAll=_unlockFlow({ zones:lockedIds, source:'password-all',
        commit:function(zid){ return commitUnlock(zid, 'password-all'); } });
    }catch(e){ tookAll=false; }
    if(tookAll) return true;  // flow owns the unlocks now
  }
  unlockAll('password');
  return true;  // password was right, even if everything was already open
}
function resetUnlocks(){
  // Back to a fresh game: only Adamsville unlocked. The cull distance
  // is a display/performance preference, NOT progress — it is kept.
  state.unlocked={adamsville:true};
  save();
  dlog('Zone unlocks reset — only Adamsville unlocked (cull distance kept)');
}

/* ---------------- movement resolution (PURE) ----------------
   resolveMove(fromX,fromZ,toX,toZ) -> {x, z, blocked, blockedZone}
   Pure: reads unlock state, changes nothing, moves nobody. Callers
   (blockLockedMovement) apply the result. Rules:
   - Destination playable        -> go there, blocked:false.
   - Destination not playable    -> try sliding along X only
     (toX,fromZ), then along Z only (fromX,toZ); the first playable
     slide wins, blocked:true (the player hugs the wall).
   - Neither slide playable      -> stay at the from-point, blocked:true.
   blockedZone names the locked zone containing the DESTINATION
   (or null when the world edge / a non-zone reason did the blocking),
   so the UI can say WHICH zone is locked. */
function resolveMove(fromX, fromZ, toX, toZ){
  if(isPlayable(toX, toZ)){
    return {x:toX, z:toZ, blocked:false, blockedZone:null};
  }
  var bz=lockedZoneAt(toX, toZ);
  if(isPlayable(toX, fromZ)){
    return {x:toX, z:fromZ, blocked:true, blockedZone:bz};
  }
  if(isPlayable(fromX, toZ)){
    return {x:fromX, z:toZ, blocked:true, blockedZone:bz};
  }
  return {x:fromX, z:fromZ, blocked:true, blockedZone:bz};
}

/* ---------------- player position (guarded, old pattern) ----------------
   The main script's `car`/`player` globals may not exist yet (or this
   module may run headless), so every read is typeof-guarded and
   try/caught exactly like the original module did. Returns
   {x, z, driving} or null when no position is available. */
function playerPos(){
  try{
    if(typeof car!=='undefined' && car && car.driving){
      return {x:car.x, z:car.z, driving:true};
    }
    if(typeof player!=='undefined' && player){
      return {x:player.x, z:player.z, driving:false};
    }
  }catch(e){}
  return null;
}
/* Adamsville spawn fallback for seeding the wall's last-good point:
   the HOME global (535 Dollar Mill Rd) when the main script defined
   it, else the Adamsville rect centre (3772.5, 2009.0). Either way the
   point sits inside the always-unlocked home zone, so the wall can
   never seed itself somewhere it would immediately reject. */
function spawnFallback(){
  try{
    if(typeof HOME!=='undefined' && HOME && isFinite(HOME.x) && isFinite(HOME.z)){
      return {x:HOME.x, z:HOME.z};
    }
  }catch(e){}
  var a=zoneById('adamsville');
  if(a) return {x:(a.xMin+a.xMax)/2, z:(a.zMin+a.zMax)/2};
  return {x:3772.5, z:2009.0};
}

/* ---------------- per-frame union wall ----------------
   blockLockedMovement() — index.html calls this EVERY frame after
   movement updates. It remembers the last playable position
   (lastGood) and resolves the current position against the union via
   resolveMove: free inside unlocked ground, axis-slide along locked
   edges, full stop at corners/outer wall. Only the PLAYER (or the car
   the player is driving) is ever written back — NPCs/traffic are not
   the player's car and are never touched here. */
var _lastGoodX=null, _lastGoodZ=null, _lastGoodDriving=false;
var _wallMsgT=0;
function blockLockedMovement(){
  var pos=playerPos();
  if(!pos) return;
  var px=pos.x, pz=pos.z, driving=pos.driving;
  if(!isFinite(px)||!isFinite(pz)) return;
  // Seed lastGood when there is none yet, or when the remembered point
  // is somehow no longer playable (e.g. unlocks were reset mid-game):
  // prefer the current position if IT is playable, else fall back to
  // the Adamsville spawn so the player is recovered, never soft-locked.
  if(_lastGoodX===null || !isPlayable(_lastGoodX, _lastGoodZ)){
    if(isPlayable(px, pz)){ _lastGoodX=px; _lastGoodZ=pz; }
    else { var fb=spawnFallback(); _lastGoodX=fb.x; _lastGoodZ=fb.z; }
  }
  // Resolve lastGood -> current against the union walls.
  var res=resolveMove(_lastGoodX, _lastGoodZ, px, pz);
  // Write the resolved position back only when the wall actually
  // changed it (blocked or slid) — free movement is left untouched.
  if(res.x!==px || res.z!==pz){
    try{
      if(driving && typeof car!=='undefined' && car){
        car.x=res.x; car.z=res.z;  // car: x/z only (y is terrain-driven)
      } else if(typeof player!=='undefined' && player){
        player.x=res.x; player.z=res.z;
        if(player.mesh) player.mesh.position.set(res.x, player.mesh.position.y, res.z);
      }
    }catch(e){}
  }
  // Name the blocker, throttled to one toast per 4 seconds, and only
  // when a specific LOCKED ZONE did the blocking (the plain world edge
  // stays silent — the border visual already explains it).
  if(res.blocked && res.blockedZone){
    var now=Date.now();
    if(now-_wallMsgT>4000){
      _wallMsgT=now;
      notify('🔒 ' + res.blockedZone.name + ' is locked — unlock it in Settings → Advanced Properties.');
      dlog('Wall blocked entry to locked zone: '+res.blockedZone.name);
    }
  }
  // The resolved point is by construction playable: it becomes the new
  // last-good position for the next frame.
  _lastGoodX=res.x; _lastGoodZ=res.z; _lastGoodDriving=driving;
}

/* ---------------- zone-crossing tracker (slim, 2Hz) ----------------
   trackPlayer(dt) — index.html calls this every frame; internally it
   runs at 2Hz and does ONE job: zone-crossing duty for the zone
   loader. When the loader reports the player has crossed into an
   UNLOCKED zone, hand over to ZONELOADER.transitionTo (which loads
   that zone's map). A LOCKED target needs no action here at all —
   the per-frame wall above already keeps the player out of it, so a
   locked crossing can never actually be reached. */
var trackT=0;
function trackPlayer(dt){
  trackT-=dt; if(trackT>0) return; trackT=0.5;  // 2Hz
  var pos=playerPos();
  if(!pos) return;
  if(!isFinite(pos.x)||!isFinite(pos.z)) return;
  try{
    if(typeof ZONELOADER!=='undefined' && ZONELOADER &&
       typeof ZONELOADER.checkZoneCrossing==='function'){
      var target=ZONELOADER.checkZoneCrossing(pos.x, pos.z);
      if(target && isUnlocked(target)){
        dlog('Zone crossing: -> '+target+' (unlocked, transitioning)');
        ZONELOADER.transitionTo(target);
      }
      // Locked target: do nothing — the wall already stops the player.
    }
  }catch(e){}
}

/* ---------------- DISTANCE CULLING ----------------
   CULL_DIST: objects beyond this distance from player get AI paused
   and meshes hidden. Chunk grid for efficient spatial queries.
   (Functionally identical to the original module's Part 2.) */
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
   as dark overlays. Expects the minimap's toMap function and context.
   STEP 2: iterates ALL zones — every zone is a real, same-stage rect
   now, so every locked zone honestly belongs on the minimap. */
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

/* ---------------- public API: ZoneUnlock (STEP 2) ----------------
   The canonical API for new code: Settings → Advanced Properties, the
   zone picker, save-load checks, and (in the future) mission rewards
   all go through window.ZoneUnlock. */
window.ZoneUnlock={
  PASSWORD:ZONE_PASSWORD,
  UNLOCK_ALL_PASSWORD:UNLOCK_ALL_PASSWORD,
  EDGE_MARGIN:EDGE_MARGIN,
  zones:ZONES,
  zoneAt:zoneAt,
  zoneById:zoneById,
  isUnlocked:isUnlocked,
  unlock:unlock,
  unlockAll:unlockAll,
  /* ZONE DOWNLOAD FLOW (Joshua 2026-10-17): zoneunlockflow.js
     registers its ceremony via setUnlockFlow; commitUnlock is the
     flow's per-zone commit (state flip without the toast). */
  setUnlockFlow:setUnlockFlow,
  commitUnlock:commitUnlock,
  tryUnlockWithPassword:tryUnlockWithPassword,
  tryUnlockAllWithPassword:tryUnlockAllWithPassword,
  isPlayable:isPlayable,
  resolveMove:resolveMove,
  stageRect:stageRect,
  reset:resetUnlocks,
  get unlockedIds(){ return unlockedIdsList(); }
};

/* ---------------- compatibility facade: ZONEUNLOCK ----------------
   Why this exists: the all-caps ZONEUNLOCK name predates STEP 2 and
   existing callers still use it — satellite_view.js reads
   .zones/.isUnlocked, index.html calls .trackPlayer /
   .blockLockedMovement / .drawZoneOverlay / .zones, and the crew
   systems call .shouldCull. The facade forwards every one of those to
   the SAME functions and the SAME state above, so old and new callers
   can never disagree about what is unlocked. unlockZone() is kept as
   a thin alias of unlock(id, 'legacy') for the same reason. */
window.ZONEUNLOCK={
  zones:ZONES,
  /* EDGE_MARGIN + isPlayable are forwarded too: index.html's
     clampToStage() reads ZONEUNLOCK.EDGE_MARGIN and loadSlot() checks
     ZONEUNLOCK.isPlayable, so the facade must carry both. */
  EDGE_MARGIN:EDGE_MARGIN,
  isPlayable:isPlayable,
  get unlocked(){ return unlockedIdsList(); },
  zoneAt:zoneAt,
  isUnlocked:isUnlocked,
  unlockZone:function(id){ return unlock(id, 'legacy'); },
  compatibleZones:function(){ return ZONES.slice(); },
  shouldCull:shouldCull,
  inActiveRange:inActiveRange,
  get CULL_DIST(){ return state.cullDist; },
  setCullDist:setCullDist,
  trackPlayer:trackPlayer,
  blockLockedMovement:blockLockedMovement,
  drawZoneOverlay:drawZoneOverlay,
  unlockAll:function(){ return unlockAll('admin'); },
  reset:resetUnlocks,
  get log(){ return activityLog.slice(); }
};

/* ---------------- boot ---------------- */
dlog('ZoneUnlock v2 online — '+unlockedIdsList().length+' zone(s) unlocked, cull dist '+state.cullDist);
})();
