/* Player character + controls. Keyboard (desktop/laptop) or touch joystick (mobile). */
var Player = {
  mesh:null, x:0, z:0, angle:0, speed:0,
  keys:{},
  joy:{active:false, dx:0, dy:0},
  init: function(scene){
    // simple stylized character (placeholder — smooth hero comes from the studio spec)
    var g = new THREE.Group();
    var skin = new THREE.MeshLambertMaterial({color:0x8a5f36});
    var shirt = new THREE.MeshLambertMaterial({color:0x2e5fa3});
    var pants = new THREE.MeshLambertMaterial({color:0x2e4a6b});
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.32,16,16), skin);
    head.position.y = 1.75; g.add(head);
    var torso = new THREE.Mesh(new THREE.CylinderGeometry(0.28,0.34,0.7,12), shirt);
    torso.position.y = 1.15; g.add(torso);
    var legL = new THREE.Mesh(new THREE.CylinderGeometry(0.11,0.11,0.7,8), pants);
    legL.position.set(-0.14,0.4,0); g.add(legL);
    var legR = legL.clone(); legR.position.x=0.14; g.add(legR);
    var armL = new THREE.Mesh(new THREE.CylinderGeometry(0.09,0.09,0.6,8), shirt);
    armL.position.set(-0.4,1.15,0); g.add(armL);
    var armR = armL.clone(); armR.position.x=0.4; g.add(armR);
    this.mesh = g; scene.add(g);
    this.bindInputs();
  },
  bindInputs: function(){
    var self=this;
    window.addEventListener('keydown',function(e){ self.keys[e.code]=true; });
    window.addEventListener('keyup',function(e){ self.keys[e.code]=false; });
    // touch joystick
    var joy=document.getElementById('joy'), stick=document.getElementById('stick');
    var jid=null, cx=0, cy=0;
    joy.addEventListener('touchstart',function(e){
      var t=e.changedTouches[0]; jid=t.identifier;
      var r=joy.getBoundingClientRect(); cx=r.left+r.width/2; cy=r.top+r.height/2;
      self.joy.active=true; e.preventDefault();
    },{passive:false});
    window.addEventListener('touchmove',function(e){
      for(var i=0;i<e.changedTouches.length;i++){
        var t=e.changedTouches[i];
        if(t.identifier===jid){
          var dx=t.clientX-cx, dy=t.clientY-cy;
          var d=Math.hypot(dx,dy), max=48;
          if(d>max){ dx=dx/d*max; dy=dy/d*max; }
          stick.style.transform='translate('+dx+'px,'+dy+'px)';
          self.joy.dx=dx/max; self.joy.dy=dy/max;
        }
      }
    },{passive:true});
    window.addEventListener('touchend',function(e){
      for(var i=0;i<e.changedTouches.length;i++){
        if(e.changedTouches[i].identifier===jid){
          jid=null; self.joy.active=false; self.joy.dx=0; self.joy.dy=0;
          stick.style.transform='';
        }
      }
    });
  },
  update: function(dt){
    var fw=0, turn=0;
    if(this.keys['KeyW']) fw+=1;
    if(this.keys['KeyS']) fw-=1;
    if(this.keys['KeyA']) turn+=1;
    if(this.keys['KeyD']) turn-=1;
    // arrows = camera look
    if(this.keys['ArrowUp']) window._camPitch=Math.max(-0.5,(window._camPitch||0)-0.03);
    if(this.keys['ArrowDown']) window._camPitch=Math.min(0.6,(window._camPitch||0)+0.03);
    if(this.keys['ArrowLeft']) window._camYaw=(window._camYaw||0)+0.05;
    if(this.keys['ArrowRight']) window._camYaw=(window._camYaw||0)-0.05;
    if(this.joy.active){ fw+=-this.joy.dy; turn+=-this.joy.dx; }
    var sp=10, turnSp=2.5;
    this.angle+=turn*turnSp*dt;
    if(fw){
      this.x+=Math.sin(this.angle)*sp*dt*fw;
      this.z+=Math.cos(this.angle)*sp*dt*fw;
      this.speed=sp*Math.abs(fw);
    } else this.speed=0;
    // car collision: can't walk through it
    var _car=(typeof Car!=='undefined')?Car:window.Car;
    if(_car&&!_car.inCar){
      var dx=this.x-_car.x, dz=this.z-_car.z;
      var d=Math.hypot(dx,dz), minD=2.6;
      if(d<minD&&d>0.01){ this.x=_car.x+dx/d*minD; this.z=_car.z+dz/d*minD; }
    }
    this.mesh.position.set(this.x,0,this.z);
    this.mesh.rotation.y=this.angle;
    // simple walk bob
    if(this.speed>0) this.mesh.position.y=Math.abs(Math.sin(Date.now()/150))*0.06;
  }
};
