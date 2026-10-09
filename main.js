/* Main game loop: scene, camera (wide view), ground, game start */
(function(){
  var canvas=document.getElementById('c');
  var renderer=new THREE.WebGLRenderer({canvas:canvas,antialias:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  var scene=new THREE.Scene();
  scene.background=new THREE.Color(0x87a5c8);
  scene.fog=new THREE.Fog(0x87a5c8,150,600);
  var camera=new THREE.PerspectiveCamera(60,1,0.1,2000);

  scene.add(new THREE.HemisphereLight(0xffffff,0x6a7a68,0.9));
  var sun=new THREE.DirectionalLight(0xffffff,0.6); sun.position.set(100,200,80); scene.add(sun);

  function resize(){
    var w=window.innerWidth,h=window.innerHeight;
    renderer.setSize(w,h,false); camera.aspect=w/h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize',resize); resize();

  // ground covers the local play area (4000x4000 centered on home)
  var ground=new THREE.Mesh(new THREE.PlaneGeometry(4000,4000),
    new THREE.MeshLambertMaterial({color:0x5a7a4a}));
  ground.rotation.x=-Math.PI/2; ground.position.set(3125,0,3697); scene.add(ground);

  Player.init(scene);
  Car.init(scene);



  // mouse look: drag to orbit
  var mouseYaw=0, mousePitch=0, dragging=false, lx=0, ly=0;
  canvas.addEventListener('mousedown',function(e){ dragging=true; lx=e.clientX; ly=e.clientY; });
  window.addEventListener('mouseup',function(){ dragging=false; });
  window.addEventListener('mousemove',function(e){
    if(!dragging) return;
    mouseYaw-=(e.clientX-lx)*0.005; mousePitch-=(e.clientY-ly)*0.003;
    mousePitch=Math.max(-0.5,Math.min(0.6,mousePitch));
    lx=e.clientX; ly=e.clientY;
  });
  // camera: wide view (behind player, full character visible)
  var camDist=9, camH=4.5;
  var last=performance.now();
  function loop(now){
    requestAnimationFrame(loop);
    var dt=Math.min((now-last)/1000,0.05); last=now;
    var driving=Car.update(dt, Player);
    if(!driving) Player.update(dt);
    // smooth follow (with mouse orbit offset)
    var a=(driving?Car.angle:Player.angle)+mouseYaw+(window._camYaw||0);
    mousePitch=(window._camPitch!==undefined?window._camPitch:mousePitch);
    var tx=Player.x-Math.sin(a)*camDist,
        tz=Player.z-Math.cos(a)*camDist,
        ty=camH+mousePitch*10;
    camera.position.x+=(tx-camera.position.x)*Math.min(1,dt*5);
    camera.position.z+=(tz-camera.position.z)*Math.min(1,dt*5);
    camera.position.y+=(ty-camera.position.y)*Math.min(1,dt*5);
    camera.lookAt(Player.x,1.4,Player.z);
    // nearest street name (checked every 10 frames, sampled points)
    if(!window._stCt) window._stCt=0;
    window._stCt++;
    if(window._stCt%10===0&&PLAYWORLD.data&&PLAYWORLD.data.roads){
      var bd=1e18, bn='';
      var rs=PLAYWORLD.data.roads;
      var px=(typeof Car!=='undefined'&&Car.inCar)?Car.x:Player.x;
      var pz=(typeof Car!=='undefined'&&Car.inCar)?Car.z:Player.z;
      for(var ri=0;ri<rs.length;ri++){
        var rp=rs[ri][2]; if(!rp||rp.length<4) continue;
        for(var rj=0;rj<rp.length;rj+=8){
          var dx=rp[rj]-px, dz=rp[rj+1]-pz;
          var dd=dx*dx+dz*dz;
          if(dd<bd){ bd=dd; bn=rs[ri][1]||''; }
        }
      }
      window._street=(bd<6400&&bn)?' · '+bn:'';
    }
    var street=window._street||'';
    document.getElementById('loc').textContent=
      DEVICE.label+' · '+Math.round(Player.x)+', '+Math.round(Player.z);
    var sn=document.getElementById('streetname');
    if(sn) sn.textContent=street.replace(/^ · /,'')||'—';
    renderer.render(scene,camera);
    drawMinimap();
    // speedometer
    var spd=document.getElementById('speedo');
    if(spd){
      var v=(typeof Car!=='undefined'&&Car.inCar)?Math.abs(Car.speed)*2.2:Player.speed*2.2;
      spd.textContent=Math.round(v)+' MPH';
      spd.style.display=(v>1||(typeof Car!=='undefined'&&Car.inCar))?'block':'none';
    }
  }
  var mm=document.getElementById('mm'), mmc=mm.getContext('2d');
  function drawMinimap(){
    mmc.fillStyle='#0e1420'; mmc.fillRect(0,0,140,180);
    // zoomed: 300-unit radius around player, player centered (detailed)
    var R=300, cx=Player.x, cz=Player.z;
    var sx=140/(R*2), sz=180/(R*2);
    var w2m=function(x,z){ return [(x-(cx-R))*sx, (z-(cz-R))*sz]; };
    mmc.strokeStyle='#2c384a'; mmc.strokeRect(1,1,138,178);
    // roads — draw as filled background grid first
    mmc.fillStyle='#1a2230'; mmc.fillRect(0,0,140,180);
    if(PLAYWORLD.data&&PLAYWORLD.data.roads){
      mmc.strokeStyle='#8a94a8'; mmc.lineWidth=1;
      var roads=PLAYWORLD.data.roads;
      for(var i=0;i<roads.length;i++){
        var rd=roads[i]; if(!rd) continue;
        var pts=rd[2]; if(!pts||pts.length<4) continue;
        mmc.beginPath();
        var started=false;
        for(var j=0;j<pts.length-1;j+=2){
          // skip segments far from player
          if(Math.abs(pts[j]-cx)>R||Math.abs(pts[j+1]-cz)>R) continue;
          var pp=w2m(pts[j],pts[j+1]);
          if(!started){ mmc.moveTo(pp[0],pp[1]); started=true; }
          else mmc.lineTo(pp[0],pp[1]);
        }
        if(started) mmc.stroke();
      }
    }
    // home (if in range)
    var hp=w2m(3125,3697);
    if(hp[0]>0&&hp[0]<140&&hp[1]>0&&hp[1]<180){
      mmc.fillStyle='#ff5a5a'; mmc.fillRect(hp[0]-3,hp[1]-3,6,6);
    }
    // player arrow (centered, points where he's facing)
    var pa=Player.angle;
    mmc.fillStyle='#39ff6a';
    mmc.beginPath();
    mmc.moveTo(70+Math.sin(pa)*8, 90+Math.cos(pa)*8);
    mmc.lineTo(70+Math.sin(pa+2.5)*6, 90+Math.cos(pa+2.5)*6);
    mmc.lineTo(70+Math.sin(pa-2.5)*6, 90+Math.cos(pa-2.5)*6);
    mmc.closePath(); mmc.fill();
    // north indicator
    mmc.fillStyle='#9aa7bd'; mmc.font='10px sans-serif'; mmc.fillText('N',64,12);
  }
  requestAnimationFrame(loop);

  // load real map data in background (roads/buildings render when ready)
  PLAYWORLD.load(scene, function(){
    document.getElementById('loc').textContent+=' · map loaded';
    document.getElementById('loading').style.display='none';
  });
  // no forced timeout — loading screen stays until data arrives or errors
})();
