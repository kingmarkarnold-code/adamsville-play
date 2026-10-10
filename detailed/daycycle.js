/* ============================================================================
   DAY CYCLE + WEATHER + SEASONS v1.0 (2026-10-09)
   Joshua's directives (all confirmed 2026-10-09):
     1. 24 game hours = 2 hours 4 minutes real time (124 min, ~11.6x).
     2. Sun visibly rises and sets; full day/night cycle.
     3. Weather: sunny days, rainy days, visible cloud formations, natural change.
     4. Seasons: trees change color in fall (spring blossoms, summer green,
        winter bare for deciduous; conifers stay green).

   Self-contained module. Zero edits to index.html logic required: this file
   boot-polls for (THREE, scene, sun, hemi, player, animate), then wraps the
   global animate() exactly like bird_drones.js / traffic_system.js, so
   updateDayCycle() runs every frame.

   Season system: 7 game days per season, 28-day year. Game starts Day 1
   (Monday) in SUMMER, so fall colors arrive on day 8. On season change this
   calls window.__trees.setSeason(season) (exposed by the v2.0 tree pass in
   index.html). If __trees is absent, seasons still advance for the HUD.

   Weather: state machine SUNNY -> CLOUDY -> RAINY -> CLOUDY -> SUNNY with
   random dwell times. Clouds = 1 InstancedMesh of billboard-ish puffs
   drifting on the wind; rain = 1 THREE.Points shower around the camera.
   Weather dims the sun and tints the sky.

   Time persists in localStorage ('sa_daycycle_v1') so the clock keeps going
   across sessions instead of resetting to Monday 7:08 every launch.

   Performance: clouds = 1 draw call, rain = 1 draw call, both
   frustumCulled=false. Per-frame work is a handful of lerps + matrix
   updates for clouds only when they move (every frame, 40 matrices — cheap).

   Depends on globals: THREE, scene, sun (DirectionalLight), hemi
   (HemisphereLight), player (for cloud/rain centering), mulberry32, Report.
   ============================================================================ */
(function dayCycle(){
'use strict';

/* ---------------- constants ---------------- */
// Joshua: 24 game hours = 2h04m real. 124*60 real seconds per 1440 game min.
var DAY_LEN_S = 124*60;
var GAME_MIN_PER_SEC = 1440/DAY_LEN_S;
var DAYS=['MON','TUE','WED','THU','FRI','SAT','SUN'];
// Joshua: game opens Monday morning.
var START_MIN = 7*60+8, START_DAY = 1;
// Season: 7 game days each; day 1-7 = summer so fall arrives day 8.
var DAYS_PER_SEASON = 7;
var SEASON_ORDER = ['summer','fall','winter','spring'];
var SUNRISE_MIN = 6*60, SUNSET_MIN = 20*60;   // summer hours
var LS_KEY = 'sa_daycycle_v1';

/* Sky / light keyframes: [gameMin, skyHex, fogHex, sunHex, sunInt, hemiInt].
   Night is dim blue moonlight; dawn/dusk burn orange. */
var KEYS=[
 [0,    0x0a0f1e, 0x0a0f1e, 0x2a3a5a, 0.12, 0.22],
 [300,  0x0a0f1e, 0x0a0f1e, 0x2a3a5a, 0.12, 0.22],
 [345,  0x3a3a5a, 0x3a3a5a, 0x6a4a6a, 0.18, 0.30],
 [390,  0xff9a5a, 0xff9a5a, 0xff8844, 0.50, 0.50],  // sunrise
 [480,  0x9fc7e8, 0x9fc7e8, 0xfff2d8, 0.75, 0.85],  // morning
 [720,  0x9fc7e8, 0x9fc7e8, 0xfff2d8, 0.85, 0.95],  // noon
 [1020, 0x9fc7e8, 0x9fc7e8, 0xfff2d8, 0.80, 0.90],  // afternoon
 [1170, 0xff8a4a, 0xff8a4a, 0xff7744, 0.45, 0.50],  // sunset
 [1230, 0x2a2a4a, 0x2a2a4a, 0x334466, 0.15, 0.30],  // dusk
 [1320, 0x0a0f1e, 0x0a0f1e, 0x2a3a5a, 0.12, 0.22],
 [1440, 0x0a0f1e, 0x0a0f1e, 0x2a3a5a, 0.12, 0.22]
];
// Weather dimming of the sun + sky gray factor.
var WX_DIM={sunny:1.0, cloudy:0.65, rainy:0.38};
var WX_SKY={sunny:0x000000, cloudy:0x8a9098, rainy:0x5a6068}; // gray overlay tint
var _cA=new (typeof THREE!=='undefined'?THREE.Color:function(){})(),
    _cB=new (typeof THREE!=='undefined'?THREE.Color:function(){})();

/* ---------------- state ---------------- */
var DC=null;   // state object once initialized

function seasonForDay(dayNum){
  var idx=Math.floor((dayNum-1)/DAYS_PER_SEASON)%4;
  return SEASON_ORDER[idx];
}

function loadPersist(){
  try{
    var raw=localStorage.getItem(LS_KEY);
    if(!raw) return null;
    var o=JSON.parse(raw);
    if(typeof o.gameMin==='number' && typeof o.dayNum==='number') return o;
  }catch(e){}
  return null;
}
function savePersist(){
  if(!DC) return;
  try{ localStorage.setItem(LS_KEY, JSON.stringify({gameMin:DC.gameMin, dayNum:DC.dayNum})); }catch(e){}
}

/* lerp the keyframe table at gameMin; writes into out {sky,fog,sunC,sunI,hemiI} */
var _kSky=new (typeof THREE!=='undefined'?THREE.Color:function(){})();
var _kFog=new (typeof THREE!=='undefined'?THREE.Color:function(){})();
var _kSun=new (typeof THREE!=='undefined'?THREE.Color:function(){})();
function sampleKeys(gameMin, out){
  var a=KEYS[0], b=KEYS[KEYS.length-1];
  for(var i=0;i<KEYS.length-1;i++){
    if(gameMin>=KEYS[i][0] && gameMin<=KEYS[i+1][0]){ a=KEYS[i]; b=KEYS[i+1]; break; }
  }
  var t=(b[0]>a[0]) ? (gameMin-a[0])/(b[0]-a[0]) : 0;
  t=Math.max(0,Math.min(1,t));
  _cA.setHex(a[1]); _cB.setHex(b[1]);
  _kSky.copy(_cA).lerp(_cB,t); out.sky.copy(_kSky);
  _cA.setHex(a[2]); _cB.setHex(b[2]);
  _kFog.copy(_cA).lerp(_cB,t); out.fog.copy(_kFog);
  _cA.setHex(a[3]); _cB.setHex(b[3]);
  _kSun.copy(_cA).lerp(_cB,t); out.sunC.copy(_kSun);
  out.sunI=a[4]+(b[4]-a[4])*t;
  out.hemiI=a[5]+(b[5]-a[5])*t;
  return out;
}

/* ---------------- init ---------------- */
function init(){
  var rng=(typeof mulberry32!=='undefined')?mulberry32(0xDACC):Math.random;

  var saved=loadPersist();
  DC={
    gameMin: saved?saved.gameMin:START_MIN,
    dayNum: saved?saved.dayNum:START_DAY,
    season: seasonForDay(saved?saved.dayNum:START_DAY),
    weather:'sunny', wxTimer: 25+rng()*40,   // game-minutes until re-roll
    cloudCover: 0.15,                         // 0..1 eased toward target
    t:0, lastSave:0,
    keys:{sky:new THREE.Color(), fog:new THREE.Color(), sunC:new THREE.Color(), sunI:0.85, hemiI:0.95}
  };

  /* --- clouds: one InstancedMesh of soft puffs, drifting on the wind --- */
  var N_CLOUDS=40;
  var puffGeo=new THREE.SphereGeometry(60, 7, 6);
  var cloudMat=new THREE.MeshLambertMaterial({color:0xffffff, transparent:true, opacity:0.88});
  var clouds=new THREE.InstancedMesh(puffGeo, cloudMat, N_CLOUDS);
  clouds.frustumCulled=false;
  var cloudData=[];
  for(var i=0;i<N_CLOUDS;i++){
    cloudData.push({
      ox:(rng()-0.5)*4000, oz:(rng()-0.5)*4000,  // offset from player
      y: 420+rng()*180,
      sx: 1.6+rng()*2.2, sy: 0.45+rng()*0.35, sz: 1.1+rng()*1.4,
      spd: 6+rng()*10
    });
  }
  scene.add(clouds);
  DC.clouds=clouds; DC.cloudData=cloudData; DC.cloudMat=cloudMat;

  /* --- rain: one THREE.Points shower around the camera --- */
  var N_RAIN=1500;
  var rPos=new Float32Array(N_RAIN*3);
  for(var j=0;j<N_RAIN;j++){
    rPos[j*3]=(rng()-0.5)*260; rPos[j*3+1]=rng()*160; rPos[j*3+2]=(rng()-0.5)*260;
  }
  var rainGeo=new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rPos,3));
  var rainMat=new THREE.PointsMaterial({color:0x9ab8d8, size:1.6, transparent:true, opacity:0.65});
  var rain=new THREE.Points(rainGeo, rainMat);
  rain.frustumCulled=false; rain.visible=false;
  scene.add(rain);
  DC.rain=rain; DC.rainPos=rPos;

  /* --- HUD clock: DAY 1 MON 07:08 + weather + season --- */
  var hud=document.createElement('div');
  hud.id='daycycle-hud';
  var _narrow=(typeof window!=='undefined'&&window.innerWidth<600);
  hud.style.cssText='position:fixed;'+(_narrow?'top:64px;':'top:8px;')+
    'left:50%;transform:translateX(-50%);'+
    'background:rgba(20,24,32,0.72);color:#fff;font:600 15px system-ui,sans-serif;'+
    'padding:6px 16px;border-radius:14px;z-index:50;pointer-events:none;'+
    'letter-spacing:1px;white-space:nowrap;';
  document.body.appendChild(hud);
  DC.hud=hud;

  // apply the starting season to the trees (summer on fresh boot)
  try{ if(window.__trees) window.__trees.setSeason(DC.season); }catch(e){}

  // frame hook (same wrap pattern as bird_drones.js / traffic_system.js)
  DC._lastT=performance.now()/1000;
  try{
    if(typeof animate==='function' && !animate.__dayWrap){
      var orig=animate;
      var wrapped=function(){ orig(); updateDayCycle(); };
      wrapped.__dayWrap=true;
      animate=wrapped;
    }
  }catch(e){}

  try{
    if(typeof Report!=='undefined') Report.setSys('daycycle',
      {status:'ok', version:'1.0', dayLenMin:124,
       note:'124-min day/night, sun orbit, weather, 7-day seasons'});
  }catch(e){}

  window.__daycycle={
    get gameMin(){return DC.gameMin;}, get dayNum(){return DC.dayNum;},
    get season(){return DC.season;}, get weather(){return DC.weather;},
    setTime:function(min,day){ DC.gameMin=min; DC.dayNum=day||DC.dayNum; }
  };
}

/* ---------------- per-frame update ---------------- */
var _m4=null, _q=null, _v=null, _s=null;
function updateDayCycle(){
  if(!DC) return;
  if(!_m4){ _m4=new THREE.Matrix4(); _q=new THREE.Quaternion(); _v=new THREE.Vector3(); _s=new THREE.Vector3(); }
  var now=performance.now()/1000;
  var dt=Math.min(0.1, now-DC._lastT); DC._lastT=now;
  DC.t+=dt;

  /* --- advance the clock --- */
  DC.gameMin+=dt*GAME_MIN_PER_SEC;
  var newSeason=null;
  if(DC.gameMin>=1440){
    DC.gameMin-=1440; DC.dayNum++;
    newSeason=seasonForDay(DC.dayNum);
    if(newSeason!==DC.season){ DC.season=newSeason;
      try{ if(window.__trees) window.__trees.setSeason(newSeason); }catch(e){}
    }
  }
  // persist every ~10s so the clock survives reloads
  if(DC.t-DC.lastSave>10){ DC.lastSave=DC.t; savePersist(); }

  /* --- weather state machine --- */
  DC.wxTimer-=dt*GAME_MIN_PER_SEC;
  if(DC.wxTimer<=0){
    var r=Math.random(), w=DC.weather;
    if(w==='sunny'){ DC.weather=(r<0.45)?'cloudy':'sunny'; }
    else if(w==='cloudy'){ DC.weather=(r<0.30)?'sunny':((r<0.62)?'rainy':'cloudy'); }
    else { DC.weather=(r<0.70)?'cloudy':'rainy'; }
    DC.wxTimer=20+Math.random()*50;   // game-minutes until next re-roll
  }
  var targetCover=DC.weather==='sunny'?0.15:(DC.weather==='cloudy'?0.55:0.95);
  DC.cloudCover+=(targetCover-DC.cloudCover)*Math.min(1,dt*0.25);

  /* --- sun position: orbit east->west, moonlight at night --- */
  var px=0, pz=0, py=0;
  try{ if(typeof player!=='undefined'&&player.mesh){ px=player.mesh.position.x; pz=player.mesh.position.z; } }catch(e){}
  var gm=DC.gameMin, isDay=(gm>=SUNRISE_MIN&&gm<=SUNSET_MIN);
  var dim=WX_DIM[DC.weather];
  if(isDay){
    var dayT=(gm-SUNRISE_MIN)/(SUNSET_MIN-SUNRISE_MIN);   // 0..1
    var el=Math.sin(dayT*Math.PI);                        // 0 horizon -> 1 noon
    var az=Math.PI*(1-dayT);                               // east -> west
    var R=1400;
    sun.position.set(
      px+Math.cos(az)*R*Math.max(0.15,Math.cos(el*1.2)),
      Math.max(40, Math.sin(el*1.35)*R*0.75),
      pz+320+Math.sin(az)*220
    );
  } else {
    // moonlight: dim blue from high overhead, slow drift
    var nt=((gm>SUNSET_MIN?gm-SUNSET_MIN:gm+1440-SUNSET_MIN)/(1440-(SUNSET_MIN-SUNRISE_MIN)))*Math.PI;
    sun.position.set(px+Math.cos(nt)*900, 900, pz+Math.sin(nt)*500);
  }

  /* --- sky / fog / light colors from keyframes, weather-adjusted --- */
  sampleKeys(gm, DC.keys);
  var k=DC.keys;
  scene.background.copy(k.sky);
  if(scene.fog) scene.fog.color.copy(k.fog);
  sun.color.copy(k.sunC);
  sun.intensity=k.sunI*(isDay?dim:1.0);
  try{ hemi.intensity=k.hemiI*(DC.weather==='rainy'?0.8:1.0); }catch(e){}
  // gray the sky a touch when overcast
  if(DC.weather!=='sunny' && isDay){
    _cA.setHex(WX_SKY[DC.weather]);
    var f=DC.weather==='rainy'?0.35:0.22;
    scene.background.lerp(_cA,f);
    if(scene.fog) scene.fog.color.lerp(_cA,f);
  }

  /* --- clouds drift on the wind; count/opacity follow coverage --- */
  var showN=Math.floor(DC.cloudCover*DC.cloudData.length);
  DC.cloudMat.opacity=0.55+DC.cloudCover*0.35;
  _cA.setHex(DC.weather==='rainy'?0x8a9098:0xffffff);
  DC.cloudMat.color.copy(_cA);
  for(var i=0;i<DC.cloudData.length;i++){
    var c=DC.cloudData[i];
    c.ox+=c.spd*dt; if(c.ox>2200) c.ox-=4400;
    var vis=i<showN;
    _v.set(px+c.ox, c.y, pz+c.oz);
    _s.set(c.sx*(vis?1:0.001), c.sy*(vis?1:0.001), c.sz*(vis?1:0.001));
    _m4.compose(_v,_q,_s);
    DC.clouds.setMatrixAt(i,_m4);
  }
  DC.clouds.instanceMatrix.needsUpdate=true;

  /* --- rain falls around the camera when raining --- */
  var raining=(DC.weather==='rainy');
  DC.rain.visible=raining;
  if(raining){
    var cx=px, cz=pz, cy=0;
    try{ if(typeof camera!=='undefined'){ cx=camera.position.x; cz=camera.position.z; cy=camera.position.y; } }catch(e){}
    DC.rain.position.set(cx, cy-40, cz);
    var rp=DC.rainPos;
    for(var j=0;j<rp.length;j+=3){
      rp[j+1]-=dt*130;
      if(rp[j+1]<0){ rp[j+1]=160; }
    }
    DC.rain.geometry.attributes.position.needsUpdate=true;
  }

  /* --- HUD clock --- */
  var hh=Math.floor(gm/60), mm=Math.floor(gm%60);
  var wday=DAYS[(DC.dayNum-1)%7];
  var wicon=DC.weather==='sunny'?'☀️':(DC.weather==='cloudy'?'☁️':'🌧️');
  DC.hud.textContent='DAY '+DC.dayNum+' '+wday+' '+
    (hh<10?'0':'')+hh+':'+(mm<10?'0':'')+mm+' '+wicon+' '+DC.season.toUpperCase();
}

/* ---------------- boot poll ---------------- */
var _tries=0;
(function boot(){
  _tries++;
  var ok=(typeof THREE!=='undefined' && typeof scene!=='undefined' &&
          typeof sun!=='undefined' && typeof hemi!=='undefined' &&
          typeof player!=='undefined' && typeof animate==='function');
  if(ok){ try{ init(); }catch(e){ if(typeof console!=='undefined') console.warn('[daycycle] init failed', e); } return; }
  if(_tries<900) setTimeout(boot, 500);
})();

})();
