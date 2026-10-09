/* Drivable car: walk up, press E to enter/exit, WASD to drive */
var Car = {
  mesh:null, x:3130, z:3705, angle:0, speed:0, inCar:false,
  init: function(scene){
    var g=new THREE.Group();
    var bodyMat=new THREE.MeshLambertMaterial({color:0x7a3a20});
    var glassMat=new THREE.MeshLambertMaterial({color:0x9ac8e8});
    var body=new THREE.Mesh(new THREE.BoxGeometry(2,0.9,4.4), bodyMat);
    body.position.y=0.75; g.add(body);
    var cab=new THREE.Mesh(new THREE.BoxGeometry(1.7,0.7,2.2), glassMat);
    cab.position.set(0,1.4,-0.2); g.add(cab);
    var wg=new THREE.CylinderGeometry(0.35,0.35,0.3,10);
    var wm=new THREE.MeshLambertMaterial({color:0x1a1a1a});
    [[-0.9,1.4],[0.9,1.4],[-0.9,-1.4],[0.9,-1.4]].forEach(function(p){
      var w=new THREE.Mesh(wg,wm);
      w.rotation.z=Math.PI/2; w.position.set(p[0],0.35,p[1]); g.add(w);
    });
    this.mesh=g; scene.add(g);
    this.sync();
  },
  sync: function(){ this.mesh.position.set(this.x,0,this.z); this.mesh.rotation.y=this.angle; },
  update: function(dt, player){
    var dx=player.x-this.x, dz=player.z-this.z, d=Math.hypot(dx,dz);
    // E to enter/exit
    if(player.keys['KeyE']){
      player.keys['KeyE']=false; // consume
      if(!this.inCar && d<5){ this.inCar=true; }
      else if(this.inCar){ this.inCar=false;
        player.x=this.x+Math.sin(this.angle+Math.PI/2)*3;
        player.z=this.z+Math.cos(this.angle+Math.PI/2)*3; }
    }
    if(this.inCar){
      var fw=0, turn=0;
      if(player.keys['KeyW']) fw+=1;
      if(player.keys['KeyS']) fw-=1;
      if(player.keys['KeyA']) turn+=1;
      if(player.keys['KeyD']) turn-=1;
      var maxSp=110; // high top end
      this.speed+=fw*18*dt; // gentle acceleration
      this.speed*=(1-Math.min(1,dt*0.8)); // less drag, holds speed
      this.speed=Math.max(-20,Math.min(maxSp,this.speed));
      if(Math.abs(this.speed)>0.5) this.angle+=turn*1.8*dt*(this.speed>0?1:-1);
      this.x+=Math.sin(this.angle)*this.speed*dt;
      this.z+=Math.cos(this.angle)*this.speed*dt;
      this.sync();
      // player rides along (hidden)
      player.x=this.x; player.z=this.z; player.angle=this.angle;
      player.mesh.visible=false;
      player.mesh.position.set(this.x,0,this.z);
      return true; // driving
    } else {
      player.mesh.visible=true;
      return false;
    }
  }
};
