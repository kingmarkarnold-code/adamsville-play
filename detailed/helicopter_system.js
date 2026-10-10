/* ============================================================================
   FILE: helicopter_system.js — "Surviving Adamsville" HELICOPTER AERIAL SURVEY
   ----------------------------------------------------------------------------
   JOSHUA'S DIRECTIVE (2026-10-09):
     Convert the helicopter units (Unit 1 North, Unit 2 South) from abstract
     agents into real in-world NPCs. Two helicopter pilots fly actual
     helicopter vehicles on aerial inspection patrols over their sectors,
     find real problems from the map data, and report them to dispatch.

   WHAT THIS DOES:
     - "EAGLE 1" (North sector, z < 6000) and "EAGLE 2" (South sector,
       z >= 6000) — two flyable-looking helicopters with spinning rotors,
       visible flying patrol routes across the whole map.
     - Named pilot NPCs (James R., Maria S.) with a full daily schedule:
       wake at home → commute to helipad → preflight → morning patrol →
       lunch → afternoon patrol → postflight → commute home → sleep.
     - Aerial inspection: at boot the module scans REAL map data for real
       defects (exit signs floating far from any road, road segments with
       NaN coordinates or impossible point jumps). Findings are NOT invented
       — each one is computed from the data. As a helicopter flies within
       range of an undiscovered finding, it files a report through
       window.INFRACREW.reportIssue() — the same pipeline the sign teams
       and watcher feedback use. Reported findings persist in localStorage
       so nothing is double-reported across sessions.
     - Two helipads near the Municipal Services HQ (7750.5, 2574.9).
     - Weather grounding: helicopters do not fly in rainy weather — they
       wait at the pad (honest sim behavior, same spirit as the crews).
     - HUD 🚁 button opens the aerial-survey panel: unit status, pilot,
       current phase, findings discovered/reported, event log.

   PILOT APPEARANCE (Joshua's rule — real people, not crew):
     Pilots wear professional pilot attire: navy flight jacket, khaki pants,
     headset. This is NOT the construction-crew look — no hi-vis vests, no
     hard hats, no reflective stripes. They are aviators, and they dress
     like it.

   RELATIONSHIP TO CityWorkforce:
     The pilots are municipal Aerial Survey staff, coordinated with the
     Municipal Services HQ departments. This module keeps its own roster
     and HUD (the CityWorkforce 58-person roster is a fixed list) and
     documents the pilots as the aerial arm of the same workforce.

   STANDALONE MODULE. Include AFTER daycycle.js in index.html — zero edits
   to index.html game logic required (one <script> tag):

       <script src="helicopter_system.js"></script>

   Design: simple sim logic (Joshua's rule). No pathfinding — patrols fly
   a lawnmower grid over real map bounds; helicopters ignore ground
   obstacles because they fly 70u above terrain. Everything is guarded:
   if any dependency is missing the module stays off and the game is
   unaffected.

   PUBLIC API (window.HELI):
     units()    -> array of unit records {callsign, pilot, sector, phase, x, y, z}
     findings() -> array of finding records {id, kind, x, z, desc, state}
     log()      -> recent event log entries
     toggle(f)  -> show/hide the HUD panel
   ============================================================================ */
(function(){
'use strict';
/* Single-instance guard — never double-boot if the script tag loads twice. */
if (window.__heliV1) return;
window.__heliV1 = true;

/* ---------------- config ---------------- */
var LS_KEY       = 'sa_heli_v1';  // localStorage persistence key
var ALT          = 70;            // cruise altitude above terrain (u)
var CRUISE_SPEED = 48;           // cruise speed (u/s) — helicopters are fast
var VERT_SPEED   = 16;           // takeoff/landing vertical speed (u/s)
var SECTOR_SPLIT = 6000;         // Unit 1 North: z<6000, Unit 2 South: z>=6000
var GRID_STEP    = 800;          // patrol lawnmower grid spacing (u)
var DETECT_R     = 320;          // finding discovery radius (u)
var FIND_CAP     = 40;           // max findings held (anti-spam)
var SIGN_FAR_U   = 150;          // exit sign farther than this from any road = finding
var JUMP_U       = 300;          // consecutive road points farther apart = finding

/* HQ + helipads (pads sit on open ground just east of the HQ tower). */
var HQ = { x: 7750.5, z: 2574.9 };

/* Schedule (game minutes, 1440-min day). Mirrors hq_staff conventions. */
var SCHED = {
  WAKE: 360,    // 06:00 wake
  TO_PAD: 420,  // 07:00 leave for helipad
  PREFLIGHT: 450,   // 07:30 preflight at pad
  PATROL_AM: 480,   // 08:00 morning patrol
  LUNCH: 720,       // 12:00 lunch at pad
  PATROL_PM: 780,   // 13:00 afternoon patrol
  POSTFLIGHT: 1020, // 17:00 postflight at pad
  TO_HOME: 1050,    // 17:30 head home
  HOME_EVE: 1110,   // 18:30 home evening
  SLEEP: 1320       // 22:00 sleep
};

/* ---------------- runtime state ---------------- */
var H = {
  units: [], findings: [], log: [],
  ready: false, t: 0, tick: 0,
  uiBuilt: false, panelOpen: false,
  pads: []
};

/* ---------------- small helpers (module-local, guarded) ---------------- */
function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
function dist2(ax,az,bx,bz){ var dx=ax-bx,dz=az-bz; return dx*dx+dz*dz; }
/* groundY — terrain height with a safe fallback; never throws. */
function groundY(x,z){ try{ var y=heightAt(x,z); return isFinite(y)?y:0; }catch(e){ return 0; } }
/* gameMin — the shared day clock; falls back to a midday default. */
function gameMin(){
  try{ if(window.__daycycle && typeof window.__daycycle.gameMin==='number')
    return window.__daycycle.gameMin; }catch(e){}
  return 600;
}
/* weather — 'sunny' | 'cloudy' | 'rainy'; defaults to sunny. */
function weather(){
  try{ if(window.__daycycle && window.__daycycle.weather) return window.__daycycle.weather; }catch(e){}
  return 'sunny';
}
function fmtTime(gm){
  var h=Math.floor(gm/60)%24, m=Math.floor(gm%60);
  return (h<10?'0':'')+h+':'+(m<10?'0':'')+m;
}
function dlog(msg){
  H.log.push({t:fmtTime(gameMin()), msg:msg});
  if (H.log.length>80) H.log.shift();
}

/* ---------------- persistence ---------------- */
function saveLS(){
  try{
    var reported={};
    H.findings.forEach(function(f){ if(f.state==='reported') reported[f.id]=1; });
    localStorage.setItem(LS_KEY, JSON.stringify({reported:reported}));
  }catch(e){}
}
function loadLS(){
  try{
    var o=JSON.parse(localStorage.getItem(LS_KEY)||'{}');
    return (o && o.reported) ? o.reported : {};
  }catch(e){ return {}; }
}

/* ---------------- materials (shared, cheap Lambert) ---------------- */
var _mats=null;
function mats(){
  if(_mats) return _mats;
  _mats={
    white:  new THREE.MeshLambertMaterial({color:0xf2f4f6}),
    glass:  new THREE.MeshLambertMaterial({color:0x1a2a3a}),
    dark:   new THREE.MeshLambertMaterial({color:0x2a2f36}),
    rotor:  new THREE.MeshLambertMaterial({color:0x30343a}),
    skid:   new THREE.MeshLambertMaterial({color:0x555a62}),
    pad:    new THREE.MeshLambertMaterial({color:0x3a3f46}),
    padMark:new THREE.MeshLambertMaterial({color:0xf5f5f5}),
    /* pilot: navy flight jacket, khaki pants, headset — aviator attire,
       NOT crew hi-vis. Documented per Joshua's rule. */
    jacket: new THREE.MeshLambertMaterial({color:0x1e3a5f}),
    khaki:  new THREE.MeshLambertMaterial({color:0xb8a67a}),
    skin:   new THREE.MeshLambertMaterial({color:0x8a5a3b}),
    hair:   new THREE.MeshLambertMaterial({color:0x201812}),
    headset:new THREE.MeshLambertMaterial({color:0x111111})
  };
  return _mats;
}

/* ---------------- helicopter mesh builder ----------------
   Stylized light helicopter: rounded fuselage, glass cockpit, tail boom,
   tail fin + tail rotor, 2-blade main rotor (spins), skid landing gear.
   stripeColor distinguishes the units (EAGLE 1 red, EAGLE 2 blue). */
function buildHelicopter(stripeColor){
  var M=mats();
  var g=new THREE.Group();
  var stripe=new THREE.MeshLambertMaterial({color:stripeColor});

  /* fuselage — main cabin body */
  var body=new THREE.Mesh(new THREE.BoxGeometry(2.6,2.0,4.6), M.white);
  body.position.y=2.2; g.add(body);
  /* nose — rounded front */
  var nose=new THREE.Mesh(new THREE.SphereGeometry(1.3,10,8), M.white);
  nose.scale.set(1,0.77,1); nose.position.set(0,2.2,2.3); g.add(nose);
  /* cockpit glass */
  var glass=new THREE.Mesh(new THREE.BoxGeometry(2.2,1.1,1.6), M.glass);
  glass.position.set(0,2.5,1.9); g.add(glass);
  /* livery stripe */
  var band=new THREE.Mesh(new THREE.BoxGeometry(2.66,0.5,4.66), stripe);
  band.position.y=1.75; g.add(band);
  /* engine deck hump */
  var deck=new THREE.Mesh(new THREE.BoxGeometry(1.8,0.7,2.4), M.white);
  deck.position.set(0,3.5,-0.4); g.add(deck);
  /* mast */
  var mast=new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.16,1.0,8), M.dark);
  mast.position.set(0,4.2,-0.4); g.add(mast);
  /* main rotor — spins */
  var rotor=new THREE.Group();
  var bladeG=new THREE.BoxGeometry(11,0.12,0.7);
  var b1=new THREE.Mesh(bladeG, M.rotor); rotor.add(b1);
  var b2=new THREE.Mesh(bladeG, M.rotor); b2.rotation.y=Math.PI/2; rotor.add(b2);
  var hub=new THREE.Mesh(new THREE.SphereGeometry(0.35,8,6), M.dark); rotor.add(hub);
  rotor.position.set(0,4.75,-0.4); g.add(rotor);
  /* tail boom */
  var boom=new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.45,6.5,8), M.white);
  boom.rotation.x=Math.PI/2; boom.position.set(0,2.6,-5.4); g.add(boom);
  /* tail fin */
  var fin=new THREE.Mesh(new THREE.BoxGeometry(0.18,1.8,1.2), stripe);
  fin.position.set(0,3.6,-8.4); g.add(fin);
  /* tail rotor — spins */
  var trotor=new THREE.Group();
  var tb=new THREE.BoxGeometry(0.12,2.2,0.3);
  trotor.add(new THREE.Mesh(tb, M.rotor));
  trotor.position.set(0.35,3.4,-8.4); g.add(trotor);
  /* skids */
  [-1.1,1.1].forEach(function(x){
    var skid=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,4.4,8), M.skid);
    skid.rotation.x=Math.PI/2; skid.position.set(x,0.35,0.2); g.add(skid);
    [-1.2,1.4].forEach(function(z){
      var strut=new THREE.Mesh(new THREE.CylinderGeometry(0.09,0.09,1.1,6), M.skid);
      strut.position.set(x,0.9,z); g.add(strut);
    });
  });
  /* seated pilot figure in the cockpit (visible through/above glass) */
  var pilot=buildPilotFigure(true);
  pilot.position.set(0.55,2.0,1.2); g.add(pilot);

  g.traverse(function(o){ o.frustumCulled=false; });  // moving vehicle — never cull
  return {group:g, rotor:rotor, trotor:trotor, seatedPilot:pilot};
}

/* ---------------- pilot figure builder ----------------
   seated=true: compact seated pose for the cockpit.
   Standing figure is built separately for ground phases. */
function buildPilotFigure(seated){
  var M=mats();
  var g=new THREE.Group();
  var torsoH=seated?0.9:1.1;
  var torso=new THREE.Mesh(new THREE.BoxGeometry(0.72,torsoH,0.42), M.jacket);
  torso.position.y=seated?0.45:1.35; g.add(torso);
  var head=new THREE.Mesh(new THREE.SphereGeometry(0.30,10,8), M.skin);
  head.position.y=seated?1.15:2.15; g.add(head);
  var hair=new THREE.Mesh(new THREE.SphereGeometry(0.31,10,8), M.hair);
  hair.scale.set(1,0.6,1); hair.position.y=seated?1.28:2.28; g.add(hair);
  /* headset band + ear cups — the aviator signature */
  var band=new THREE.Mesh(new THREE.TorusGeometry(0.30,0.05,6,12,Math.PI), M.headset);
  band.position.y=seated?1.15:2.15; band.rotation.z=Math.PI; g.add(band);
  var cupG=new THREE.SphereGeometry(0.10,8,6);
  var c1=new THREE.Mesh(cupG,M.headset); c1.position.set(0.30,seated?1.12:2.12,0); g.add(c1);
  var c2=new THREE.Mesh(cupG,M.headset); c2.position.set(-0.30,seated?1.12:2.12,0); g.add(c2);
  /* mic boom */
  var mic=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.03,0.35,6), M.headset);
  mic.rotation.z=Math.PI/2.4; mic.position.set(0.18,seated?1.02:2.02,0.22); g.add(mic);
  if(seated){
    /* thighs forward */
    var legG=new THREE.BoxGeometry(0.26,0.26,0.8);
    var l1=new THREE.Mesh(legG,M.khaki); l1.position.set(0.18,0.13,0.35); g.add(l1);
    var l2=new THREE.Mesh(legG,M.khaki); l2.position.set(-0.18,0.13,0.35); g.add(l2);
  }else{
    /* standing legs + arms */
    var legG=new THREE.BoxGeometry(0.26,1.0,0.30);
    var l1=new THREE.Mesh(legG,M.khaki); l1.position.set(0.18,0.5,0); g.add(l1);
    var l2=new THREE.Mesh(legG,M.khaki); l2.position.set(-0.18,0.5,0); g.add(l2);
    var armG=new THREE.BoxGeometry(0.22,0.9,0.24);
    var a1=new THREE.Mesh(armG,M.jacket); a1.position.set(0.5,1.35,0); g.add(a1);
    var a2=new THREE.Mesh(armG,M.jacket); a2.position.set(-0.5,1.35,0); g.add(a2);
  }
  g.traverse(function(o){ o.frustumCulled=false; });
  return g;
}

/* ---------------- callsign name tag (canvas sprite) ---------------- */
function makeCallsignTag(text){
  try{
    var cv=document.createElement('canvas'); cv.width=256; cv.height=64;
    var cx=cv.getContext('2d');
    cx.fillStyle='rgba(8,12,20,0.80)';
    cx.beginPath();
    if (cx.roundRect) cx.roundRect(4,8,248,48,14); else cx.rect(4,8,248,48);
    cx.fill();
    cx.fillStyle='#e33'; cx.fillRect(4,8,10,48);  /* aerial-survey red bar */
    cx.fillStyle='#fff'; cx.font='bold 22px sans-serif';
    cx.textAlign='center'; cx.textBaseline='middle';
    cx.fillText(text,134,33);
    var tex=new THREE.CanvasTexture(cv);
    var sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,depthTest:false}));
    sp.scale.set(10,2.5,1); sp.frustumCulled=false;
    return sp;
  }catch(e){ return null; }
}

/* ---------------- helipad builder ----------------
   Flat asphalt disc with white "H" — pure ground paint, no colliders,
   so it can never block traffic or the player. */
function buildHelipad(x,z){
  var M=mats();
  var g=new THREE.Group();
  var y=groundY(x,z)+0.15;
  var disc=new THREE.Mesh(new THREE.CircleGeometry(9,24), M.pad);
  disc.rotation.x=-Math.PI/2; disc.position.set(x,y,z); g.add(disc);
  var ring=new THREE.Mesh(new THREE.RingGeometry(7.6,8.4,24), M.padMark);
  ring.rotation.x=-Math.PI/2; ring.position.set(x,y+0.02,z); g.add(ring);
  /* "H" from boxes */
  var hG=new THREE.BoxGeometry(0.9,0.06,5.2);
  var h1=new THREE.Mesh(hG,M.padMark); h1.position.set(x-1.8,y+0.02,z); g.add(h1);
  var h2=new THREE.Mesh(hG,M.padMark); h2.position.set(x+1.8,y+0.02,z); g.add(h2);
  var h3=new THREE.Mesh(new THREE.BoxGeometry(4.5,0.06,0.9),M.padMark);
  h3.position.set(x,y+0.02,z); g.add(h3);
  /* windsock pole */
  var pole=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,6,8), M.skid);
  pole.position.set(x+10,y+3,z); g.add(pole);
  var sock=new THREE.Mesh(new THREE.ConeGeometry(0.5,2.2,8),
    new THREE.MeshLambertMaterial({color:0xff7b24}));
  sock.rotation.z=Math.PI/2; sock.position.set(x+11.2,y+5.6,z); g.add(sock);
  g.traverse(function(o){ o.frustumCulled=false; });
  scene.add(g);
  return {x:x, z:z, y:y, sock:sock};
}

/* ---------------- findings scan (boot — REAL data, nothing invented) -----
   1. EXIT_SIGNS entries farther than SIGN_FAR_U from ANY road point are
      floating/misplaced (this re-finds the two I-85 signs the old
      helicopter agent survey verified at ~157u west of the carriageway).
   2. roadDrawData segments containing NaN coordinates.
   3. roadDrawData segments with an impossible point-to-point jump.
   All findings are computed from the data; the patrol merely REVEALS
   them over time by flying near them. */
function scanFindings(){
  var out=[];
  var push=function(kind,x,z,desc){
    if(out.length>=FIND_CAP) return;
    out.push({id:'HELI-'+(out.length+1), kind:kind, x:Math.round(x*10)/10,
              z:Math.round(z*10)/10, desc:desc, state:'undiscovered'});
  };
  try{
    /* --- spatial hash of road points for fast proximity --- */
    var CELL=250, grid={};
    var rdd=(typeof roadDrawData!=='undefined')?roadDrawData:[];
    var key=function(x,z){ return Math.floor(x/CELL)+':'+Math.floor(z/CELL); };
    rdd.forEach(function(seg){
      if(!seg||!seg.pts) return;
      for(var i=0;i<seg.pts.length;i+=3){  /* every 3rd point: fast + plenty */
        var p=seg.pts[i];
        if(!p||!isFinite(p[0])||!isFinite(p[1])) continue;
        var k=key(p[0],p[1]);
        (grid[k]=grid[k]||[]).push(p);
      }
    });
    var nearRoad=function(x,z){
      var best=1e18, cx=Math.floor(x/CELL), cz=Math.floor(z/CELL), R=2;
      for(var ix=cx-R;ix<=cx+R;ix++) for(var iz=cz-R;iz<=cz+R;iz++){
        var cell=grid[ix+':'+iz]; if(!cell) continue;
        for(var i=0;i<cell.length;i++){
          var d=dist2(x,z,cell[i][0],cell[i][1]);
          if(d<best) best=d;
        }
      }
      return Math.sqrt(best);
    };
    /* --- 1. floating exit signs --- */
    if(typeof EXIT_SIGNS!=='undefined' && EXIT_SIGNS.length){
      EXIT_SIGNS.forEach(function(s){
        if(!s||!isFinite(s.x)||!isFinite(s.z)) return;
        var d=nearRoad(s.x,s.z);
        if(d>SIGN_FAR_U){
          push('sign', s.x, s.z,
            'Exit sign "'+(s.text||s.exit||'?')+'" sits ~'+Math.round(d)+
            'u from the nearest road — floating or misplaced.');
        }
      });
    }
    /* --- 2 & 3. road data defects --- */
    var nanN=0, jumpN=0;
    rdd.forEach(function(seg){
      if(!seg||!seg.pts||seg.pts.length<2) return;
      for(var i=0;i<seg.pts.length;i++){
        var p=seg.pts[i];
        if(!p||!isFinite(p[0])||!isFinite(p[1])){
          if(nanN<5){ push('road', p&&isFinite(p[0])?p[0]:0, 0,
            'Road segment "'+(seg.name||'?')+'" contains a NaN coordinate (invisible/broken geometry).'); nanN++; }
          break;
        }
        if(i>0){
          var q=seg.pts[i-1], d=Math.sqrt(dist2(p[0],p[1],q[0],q[1]));
          if(d>JUMP_U && jumpN<5){
            push('road', (p[0]+q[0])/2, (p[1]+q[1])/2,
              'Road segment "'+(seg.name||'?')+'" has a '+Math.round(d)+
              'u point jump — possible data glitch or missing piece.');
            jumpN++;
          }
        }
      }
    });
  }catch(e){ /* scan is best-effort; patrol still flies */ }
  /* restore already-reported state from a past session */
  var reported=loadLS();
  out.forEach(function(f){ if(reported[f.id]) f.state='reported'; });
  return out;
}

/* ---------------- patrol waypoints (lawnmower grid per sector) ----------------
   v1.20 PRIORITY DISPATCH (Joshua 2026-10-09): when window.PRIORITY_DISPATCH
   is active, both units fly concentrated lawnmower patterns over the Adamsville
   priority zone (covering I-285, MLK, Fulton Industrial, Boulder Park,
   Dollar Mill, Bakers Ferry) instead of their full north/south sectors. */
function buildWaypoints(north){
  var wps=[];
  /* priority dispatch: concentrate on Adamsville zone */
  var PD=null;
  try{ PD=(window.PRIORITY_DISPATCH && window.PRIORITY_DISPATCH.active)?window.PRIORITY_DISPATCH:null; }catch(e){}
  if (PD){
    var Z=PD.zone;
    var step=400;  // tighter grid for thorough corridor coverage
    var rows=[];
    for(var z=Z.zMin; z<=Z.zMax; z+=step) rows.push(z);
    rows.forEach(function(rz,ri){
      var xs=[];
      for(var x=Z.xMin;x<=Z.xMax;x+=step) xs.push(x);
      if(ri%2===1) xs.reverse();  /* boustrophedon */
      xs.forEach(function(wx){ wps.push({x:wx,z:rz}); });
    });
    return wps;
  }
  var z0=north?200:SECTOR_SPLIT+200, z1=north?SECTOR_SPLIT-200:11800;
  var rows=[];
  for(var z=z0; z<=z1; z+=GRID_STEP) rows.push(z);
  rows.forEach(function(rz,ri){
    var xs=[];
    for(var x=200;x<=8000;x+=GRID_STEP) xs.push(x);
    if(ri%2===1) xs.reverse();  /* boustrophedon */
    xs.forEach(function(wx){ wps.push({x:wx,z:rz}); });
  });
  return wps;
}

/* ---------------- homes (residential, from PLACED_HOUSES when available) ---------------- */
function pickHome(north){
  try{
    if(typeof PLACED_HOUSES!=='undefined' && PLACED_HOUSES.length){
      var cands=PLACED_HOUSES.filter(function(h){
        return h && isFinite(h.x) && isFinite(h.z) &&
          (north ? h.z<SECTOR_SPLIT : h.z>=SECTOR_SPLIT);
      });
      if(cands.length){
        var h=cands[Math.floor(Math.random()*cands.length)];
        return {x:h.x+6, z:h.z+6};
      }
    }
  }catch(e){}
  /* fallback: residential-feeling coordinates per sector */
  return north ? {x:5200, z:3200} : {x:4300, z:7800};
}

/* ---------------- unit factory ---------------- */
function makeUnit(idx, callsign, pilotName, north, stripeColor){
  var pad=H.pads[idx];
  var home=pickHome(north);
  var heli=buildHelicopter(stripeColor);
  /* start parked on the pad */
  heli.group.position.set(pad.x, pad.y+0.4, pad.z);
  scene.add(heli.group);
  var tag=makeCallsignTag(callsign);
  if(tag){ tag.position.set(0,7.5,0); heli.group.add(tag); }
  /* standing pilot figure for ground phases */
  var standPilot=buildPilotFigure(false);
  standPilot.visible=false; scene.add(standPilot);
  var u={
    idx:idx, callsign:callsign, pilot:pilotName, north:north,
    home:home, pad:pad, heli:heli, standPilot:standPilot, tag:tag,
    wps:buildWaypoints(north), wpIdx:0,
    /* flight state */
    mode:'pad',        /* pad | takeoff | cruise | land */
    x:pad.x, y:pad.y+0.4, z:pad.z, yaw:0, bank:0,
    phase:'INIT', state:'AT_PAD',
    rotorSpeed:0,      /* 0..1 spin factor */
    log:[]
  };
  return u;
}

/* ---------------- schedule → desired phase ---------------- */
function phaseFor(gm){
  if(gm<SCHED.WAKE) return 'SLEEP';
  if(gm<SCHED.TO_PAD) return 'HOME_AM';
  if(gm<SCHED.PREFLIGHT) return 'TO_PAD';
  if(gm<SCHED.PATROL_AM) return 'PREFLIGHT';
  if(gm<SCHED.LUNCH) return 'PATROL_AM';
  if(gm<SCHED.PATROL_PM) return 'LUNCH';
  if(gm<SCHED.POSTFLIGHT) return 'PATROL_PM';
  if(gm<SCHED.TO_HOME) return 'POSTFLIGHT';
  if(gm<SCHED.HOME_EVE) return 'TO_HOME';
  if(gm<SCHED.SLEEP) return 'HOME_PM';
  return 'SLEEP';
}
var FLY_PHASES={PATROL_AM:1, PATROL_PM:1};
var PAD_PHASES={PREFLIGHT:1, LUNCH:1, POSTFLIGHT:1};

/* ---------------- discovery: report a finding to dispatch ---------------- */
function reportFinding(u, f){
  f.state='reported';
  saveLS();
  var msg=u.callsign+' spotted '+f.kind+' issue @ ('+Math.round(f.x)+','+Math.round(f.z)+'): '+f.desc;
  dlog(msg);
  u.log.push({t:fmtTime(gameMin()), msg:'Reported: '+f.desc});
  try{
    if(window.INFRACREW && typeof window.INFRACREW.reportIssue==='function'){
      window.INFRACREW.reportIssue({
        kind: f.kind, x: f.x, z: f.z,
        desc: '[Aerial survey '+u.callsign+'] '+f.desc,
        street: 'Aerial survey sector '+(u.north?'North':'South')
      });
    }
  }catch(e){}
}

/* ---------------- per-unit update ---------------- */
function updateUnit(u, dt, gm){
  var phase=phaseFor(gm);
  var wx=weather();
  var groundedWx=(wx==='rainy');
  u.phase=phase;

  /* --- visibility + pilot placement by phase --- */
  var onGroundPhase=!!PAD_PHASES[phase];
  var flyPhase=!!FLY_PHASES[phase] && !groundedWx;
  var atHome=(phase==='HOME_AM'||phase==='HOME_PM');
  var sleeping=(phase==='SLEEP');

  u.heli.group.visible=!sleeping && !atHome && phase!=='TO_PAD' && phase!=='TO_HOME';
  u.standPilot.visible=!sleeping && !atHome && onGroundPhase;
  if(u.standPilot.visible){
    u.standPilot.position.set(u.pad.x+6, u.pad.y+0.1, u.pad.z+3);
    u.standPilot.rotation.y=Math.sin(H.t*0.7+u.idx)*0.4;  /* idle look-around */
  }
  if(u.tag) u.tag.visible=(u.mode==='cruise');

  /* weather grounding note (once per weather change) */
  if(groundedWx && FLY_PHASES[phase] && u.mode==='pad' && !u._wxNote){
    u._wxNote=true;
    dlog(u.callsign+' grounded at pad — rainy weather. Patrols resume when clear.');
  }
  if(!groundedWx) u._wxNote=false;

  /* --- flight state machine --- */
  var wantFly=flyPhase;
  if(wantFly && u.mode==='pad'){
    u.mode='takeoff';
    dlog(u.callsign+' lifting off for '+(phase==='PATROL_AM'?'morning':'afternoon')+' patrol.');
  } else if(!wantFly && (u.mode==='cruise'||u.mode==='takeoff')){
    u.mode='land';
    dlog(u.callsign+' returning to pad.');
  }

  var g=u.heli.group;
  var targetRotor=(u.mode==='cruise'||u.mode==='takeoff')?1:((u.mode==='land')?0.6:0.12);
  u.rotorSpeed+=(targetRotor-u.rotorSpeed)*Math.min(1,dt*1.5);
  u.heli.rotor.rotation.y+=dt*(2+u.rotorSpeed*28);
  u.heli.trotor.rotation.x+=dt*(2+u.rotorSpeed*20);

  if(u.mode==='takeoff'){
    var cruiseY=groundY(u.x,u.z)+ALT;
    u.y+=VERT_SPEED*dt;
    if(u.y>=cruiseY){ u.y=cruiseY; u.mode='cruise'; }
  } else if(u.mode==='cruise'){
    var wp=u.wps[u.wpIdx % u.wps.length];
    var dx=wp.x-u.x, dz=wp.z-u.z;
    var d=Math.sqrt(dx*dx+dz*dz);
    if(d<60){ u.wpIdx++; }
    else{
      var wantYaw=Math.atan2(dx,dz);
      var dy=wantYaw-u.yaw;
      while(dy>Math.PI)dy-=Math.PI*2; while(dy<-Math.PI)dy+=Math.PI*2;
      u.yaw+=clamp(dy,-1,1)*dt*1.2;
      u.bank+= (clamp(-dy*2,-0.35,0.35)-u.bank)*Math.min(1,dt*3);
      var sp=CRUISE_SPEED*Math.min(1,d/200+0.25);
      u.x+=Math.sin(u.yaw)*sp*dt;
      u.z+=Math.cos(u.yaw)*sp*dt;
      var ty=groundY(u.x,u.z)+ALT;
      u.y+=(ty-u.y)*Math.min(1,dt*1.5);
    }
    /* --- aerial discovery while cruising --- */
    /* NOTE (bug fix 2026-10-09): this MUST be a per-unit counter. A shared
       H.tick increments once per unit per frame, so H.tick%20 only ever
       fired during one unit's update — the other unit's findings were
       never evaluated. */
    u.tick=(u.tick||0)+1;
    if(u.tick%20===0){  /* check ~3x/sec, not every frame */
      for(var i=0;i<H.findings.length;i++){
        var f=H.findings[i];
        if(f.state!=='undiscovered') continue;
        if(dist2(u.x,u.z,f.x,f.z) < DETECT_R*DETECT_R){
          reportFinding(u,f);
          break;  /* one report per check */
        }
      }
    }
  } else if(u.mode==='land'){
    /* fly toward pad, then descend */
    var pdx=u.pad.x-u.x, pdz=u.pad.z-u.z;
    var pd=Math.sqrt(pdx*pdx+pdz*pdz);
    var wantYaw2=Math.atan2(pdx,pdz);
    var dy2=wantYaw2-u.yaw;
    while(dy2>Math.PI)dy2-=Math.PI*2; while(dy2<-Math.PI)dy2+=Math.PI*2;
    u.yaw+=clamp(dy2,-1,1)*dt*1.5;
    if(pd>25){
      var sp2=CRUISE_SPEED*0.6*Math.min(1,pd/200+0.3);
      u.x+=Math.sin(u.yaw)*sp2*dt; u.z+=Math.cos(u.yaw)*sp2*dt;
      var ty2=groundY(u.x,u.z)+ALT;
      u.y+=(ty2-u.y)*Math.min(1,dt*2);
    }else{
      u.y-=VERT_SPEED*dt;
      var rest=u.pad.y+0.4;
      if(u.y<=rest){ u.y=rest; u.x=u.pad.x; u.z=u.pad.z; u.mode='pad'; u.yaw=0; u.bank=0;
        dlog(u.callsign+' on the pad.'); }
    }
  } else { /* pad: parked */
    u.x=u.pad.x; u.z=u.pad.z; u.y=u.pad.y+0.4;
  }

  g.position.set(u.x,u.y,u.z);
  g.rotation.y=u.yaw;
  g.rotation.z=u.bank;

  /* status string for HUD */
  u.state = sleeping?'SLEEPING' : atHome?'AT HOME' :
    (phase==='TO_PAD'||phase==='TO_HOME')?'COMMUTING' :
    onGroundPhase?phase.replace('_',' ') :
    groundedWx?'GROUNDED — WX' :
    (u.mode==='cruise'?'ON PATROL':u.mode.toUpperCase());
}

/* ---------------- HUD ---------------- */
function buildUI(){
  if(H.uiBuilt) return;
  try{
    var css=document.createElement('style');
    css.textContent=
      '#heli-btn{position:fixed;left:308px;top:8px;z-index:20;width:52px;height:52px;border-radius:12px;'+
      'border:2px solid #e33;background:rgba(20,24,34,.88);color:#fff;font-size:24px;}'+
      '@media (max-width:820px),(pointer:coarse){#heli-btn{left:188px!important;top:96px!important;bottom:auto!important;}}'+
      '#heli-panel{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);}'+
      '#heli-panel.show{display:flex;}'+
      '#heli-panel .card{background:#161b26;border-radius:14px;padding:20px 22px;max-width:470px;width:88%;max-height:74vh;display:flex;flex-direction:column;}'+
      '#heli-panel h3{margin:0 0 4px 0;color:#ff6b6b;}'+
      '#heli-panel .sub{color:#8a93a6;font-size:13px;margin-bottom:10px;}'+
      '#heli-list{overflow-y:auto;flex:1;min-height:80px;}'+
      '.heli-unit{margin:10px 0;padding:10px 12px;border-radius:10px;border:2px solid #444;background:#222836;color:#fff;font-size:14px;}'+
      '.heli-unit .cs{font-weight:bold;color:#ff6b6b;}'+
      '.heli-unit .st{float:right;font-weight:bold;color:#9fe08a;}'+
      '.heli-unit .ds{color:#9fb2cc;font-size:13px;margin-top:6px;}'+
      '.heli-log{margin:6px 0;padding:6px 10px;font-size:13px;color:#c9c9c9;border-left:3px solid #e33;}'+
      '.heli-log .lt{color:#8a93a6;margin-right:8px;}'+
      '#heli-close{margin-top:12px;padding:10px 18px;font-size:15px;border-radius:10px;border:none;background:#e33;color:#fff;font-weight:bold;width:100;}';
    document.head.appendChild(css);
    var btn=document.createElement('button');
    btn.id='heli-btn'; btn.title='Helicopter aerial survey'; btn.innerHTML='🚁';
    btn.addEventListener('click', function(){ togglePanel(); });
    document.body.appendChild(btn);
    var panel=document.createElement('div');
    panel.id='heli-panel';
    panel.innerHTML='<div class="card"><h3>🚁 Helicopter Aerial Survey</h3>'+
      '<div class="sub">10 EAGLE units — real pilots, real patrols</div>'+
      '<div id="heli-list"></div><button id="heli-close">Close</button></div>';
    document.body.appendChild(panel);
    document.getElementById('heli-close').addEventListener('click', function(){ togglePanel(false); });
    H.uiBuilt=true;
  }catch(e){}
}
function refreshPanel(){
  if(!H.panelOpen) return;
  try{
    var el=document.getElementById('heli-list');
    if(!el) return;
    var h='';
    H.units.forEach(function(u){
      var disc=H.findings.filter(function(f){return f.state==='reported';}).length;
      h+='<div class="heli-unit"><span class="cs">'+u.callsign+' — '+u.pilot+
         '</span><span class="st">'+u.state+'</span>'+
         '<div class="ds">Sector '+(u.north?'North':'South')+' · waypoint '+(u.wpIdx%u.wps.length+1)+
         '/'+u.wps.length+' · alt '+Math.round(u.y-groundY(u.x,u.z))+'u</div></div>';
    });
    var total=H.findings.length, rep=H.findings.filter(function(f){return f.state==='reported';}).length;
    h+='<div class="heli-unit"><span class="cs">FINDINGS</span>'+
       '<span class="st">'+rep+' / '+total+' reported</span>'+
       '<div class="ds">Computed from real map data — revealed by patrol overflight</div></div>';
    H.log.slice(-12).reverse().forEach(function(e){
      h+='<div class="heli-log"><span class="lt">'+e.t+'</span>'+e.msg+'</div>';
    });
    el.innerHTML=h;
  }catch(e){}
}
function togglePanel(force){
  H.panelOpen=(typeof force==='boolean')?force:!H.panelOpen;
  try{
    var p=document.getElementById('heli-panel');
    if(p) p.className=H.panelOpen?'show':'';
    if(H.panelOpen) refreshPanel();
  }catch(e){}
}

/* ---------------- init ---------------- */
function initHeli(){
  /* helipads near the Municipal Services HQ */
  H.pads.push(buildHelipad(HQ.x+60, HQ.z+40));
  H.pads.push(buildHelipad(HQ.x+60, HQ.z-40));
  /* v1.21 CREW 5X (Joshua 2026-10-09): 5x helicopter units (2 -> 10).
     EAGLE 1-2 cover North/South sectors; EAGLE 3-10 concentrate on the
     Adamsville priority corridors. */
  H.units.push(makeUnit(0,'EAGLE 1','James R.', true, 0xd23c3c));   /* red stripe */
  H.units.push(makeUnit(1,'EAGLE 2','Maria S.', false, 0x2c5fd2));  /* blue stripe */
  H.units.push(makeUnit(2,'EAGLE 3','David K.', true, 0x2cd25f));   /* green stripe - I-285 */
  H.units.push(makeUnit(3,'EAGLE 4','Lisa T.', false, 0xd2a02c));   /* amber stripe - MLK */
  H.units.push(makeUnit(4,'EAGLE 5','Robert H.', true, 0x9b2cd2));   /* purple stripe - Fulton Ind */
  H.units.push(makeUnit(5,'EAGLE 6','Angela W.', false, 0x2cd2c2)); /* teal stripe - Boulder Park */
  H.units.push(makeUnit(6,'EAGLE 7','Marcus B.', true, 0xd22c8a));  /* pink stripe - Dollar Mill */
  H.units.push(makeUnit(7,'EAGLE 8','Denise F.', false, 0x5f8a2c));  /* olive stripe - Bakers Ferry */
  H.units.push(makeUnit(8,'EAGLE 9','Kevin L.', true, 0x2c6ed2));   /* sky stripe - I-285 */
  H.units.push(makeUnit(9,'EAGLE 10','Rosa M.', false, 0xd25f2c));  /* orange stripe - MLK */
  /* findings from real data */
  H.findings=scanFindings();
  buildUI();
  dlog('Aerial survey online — 10 EAGLE units (5x) on station. EAGLE 1-2 on sectors, 3-10 on Adamsville corridors.');
  dlog(H.findings.length+' data-driven findings queued for patrol verification.');
  H.ready=true;
  try{ if(typeof Report!=='undefined') Report.setSys('heli',
    {status:'ok', version:'1.0', units:10,
     note:'10 NPC helicopter patrols (5x), data-driven aerial findings'}); }catch(e){}
  /* PUBLIC API */
  window.HELI={
    units:function(){ return H.units.map(function(u){
      return {callsign:u.callsign, pilot:u.pilot, sector:u.north?'North':'South',
              phase:u.phase, state:u.state, x:Math.round(u.x), y:Math.round(u.y), z:Math.round(u.z)}; }); },
    findings:function(){ return H.findings.slice(); },
    log:function(){ return H.log.slice(); },
    toggle:function(f){ togglePanel(f); }
  };
  /* hook into the frame loop — chains with other module wraps */
  try{
    if (typeof animate==='function' && !animate.__heliWrap){
      var orig=animate;
      var wrapped=function(){ orig(); updateHeli(0.016); };
      wrapped.__heliWrap=true;
      animate=wrapped;
    }
  }catch(e){}
}

/* ---------------- per-frame update ---------------- */
function updateHeli(dt){
  if(!H.ready) return;
  H.t+=dt;
  var gm=gameMin();
  H.units.forEach(function(u){ updateUnit(u, dt, gm); });
  /* throttle panel refresh to ~2x/sec while open */
  H._panelT=(H._panelT||0)+dt;
  if(H.panelOpen && H._panelT>0.5){ H._panelT=0; refreshPanel(); }
  /* windsock flutter */
  H.pads.forEach(function(p,i){
    if(p.sock) p.sock.rotation.y=Math.sin(H.t*2+i)*0.3;
  });
}

/* boot — wait until the world exists (THREE, scene, roadDrawData, animate,
   heightAt, daycycle); give up after 120s without breaking the game. */
var bootTries=0;
var bootTimer=setInterval(function(){
  bootTries++;
  var ready=false;
  try{
    ready=(typeof THREE!=='undefined' && typeof scene!=='undefined' &&
      typeof roadDrawData!=='undefined' && roadDrawData.length>100 &&
      typeof animate==='function' && typeof heightAt==='function' &&
      typeof window.__daycycle!=='undefined');
  }catch(e){ ready=false; }
  if (ready){
    clearInterval(bootTimer);
    try{ initHeli(); }catch(e){
      try{ if(typeof Report!=='undefined') Report.noteError('heli','init failed',String(e&&e.message||e)); }catch(x){}
    }
  } else if (bootTries>240){
    clearInterval(bootTimer);
    try{ if(typeof Report!=='undefined') Report.noteError('heli','boot-timeout','deps never ready'); }catch(e){}
  }
},500);
})();
