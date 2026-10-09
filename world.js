/* Playable world: loads real map data from the watcher site, renders roads + buildings */
var PLAYWORLD = {
  base: 'https://kingmarkarnold-code.github.io/adamsville-watcher/',
  data: null,
  progress: function(pct,msg){
    var b=document.getElementById('lbar'), m=document.getElementById('lmsg');
    if(b) b.style.width=pct+'%'; if(m&&msg) m.textContent=msg;
  },
  load: function(scene, cb){
    var self=this;
    self.progress(20,'Loading local map…');
    // load embedded local data (no external dependency)
    var pr=fetch('local_roads.json?v=20261009b').then(function(r){ return r.json(); });
    var pb=fetch('local_buildings.json?v=20261009b').then(function(r){ return r.json(); });
    Promise.all([pr,pb]).then(function(res){
      self.progress(60,'Building world…');
      self.data={ roads:res[0], buildings:res[1] };
      var dbg=document.getElementById('lmsg');
      if(dbg) dbg.textContent='Data: '+res[0].length+' roads, '+Math.floor(res[1].length/3)+' buildings';
      self.render(scene);
      self.progress(90,'Placing…');
      if(window.Player){ window.Player.x=3125; window.Player.z=3697; }
      self.progress(100,'Ready — '+res[0].length+' roads, '+Math.floor(res[1].length/3)+' buildings — CLICK TO PLAY');
      var ld=document.getElementById('loading');
      if(ld){ ld.style.cursor='pointer'; ld.onclick=function(){ if(cb) cb(); }; }
    }).catch(function(e){
      self.progress(100,'Map failed: '+e.message);
      if(cb) cb();
    });
  },
  render: function(scene){
    var d=this.data; if(!d) return;
    // roads as dark ribbons
    var roadMat=new THREE.MeshLambertMaterial({color:0x3a3f47});
    (d.roads||[]).forEach(function(r){
      var pts=r[2]; if(!pts||pts.length<4) return;
      for(var i=0;i<pts.length-3;i+=2){
        var x1=pts[i],z1=pts[i+1],x2=pts[i+2],z2=pts[i+3];
        var len=Math.hypot(x2-x1,z2-z1); if(len<0.1) continue;
        var w=r[0]===0?14:8; // highways wider
        var geo=new THREE.PlaneGeometry(w,len);
        var m=new THREE.Mesh(geo,roadMat);
        m.rotation.x=-Math.PI/2;
        m.rotation.z=-Math.atan2(z2-z1,x2-x1)+Math.PI/2;
        m.position.set((x1+x2)/2,0.1,(z1+z2)/2);
        scene.add(m);
        // joint disc at the start vertex fills triangle gaps where roads meet
        var jgeo=new THREE.CircleGeometry(w/2,10);
        var jm=new THREE.Mesh(jgeo,roadMat);
        jm.rotation.x=-Math.PI/2; jm.position.set(x1,0.11,z1);
        scene.add(jm);
      }
    });
    // buildings as boxes — flat [x,z,type] triplets
    var blds=d.buildings||[];
    var houseMat=new THREE.MeshLambertMaterial({color:0xc8b89a});
    var comMat=new THREE.MeshLambertMaterial({color:0x9aa4b0});
    var aptMat=new THREE.MeshLambertMaterial({color:0xb0a090});
    var maxB=Math.min(blds.length/3,4000);
    // build a quick road-point lookup to keep buildings off roads
    var roadPts=[];
    (d.roads||[]).forEach(function(r){
      var pts=r[2]; if(!pts) return;
      for(var k=0;k<pts.length-1;k+=2) roadPts.push(pts[k],pts[k+1]);
    });
    function nearRoad(x,z){
      for(var k=0;k<roadPts.length;k+=2){
        var dx=x-roadPts[k], dz=z-roadPts[k+1];
        if(dx*dx+dz*dz<400) return true; // within 20 units
      }
      return false;
    }
    for(var i=0;i<maxB;i++){
      var bx=blds[i*3], bz=blds[i*3+1], bt=blds[i*3+2];
      if(bx<0||bx>8000||bz<0||bz>12000) continue;
      if(nearRoad(bx,bz)) continue; // skip buildings on roads
      var bw=11, bd=9, bh=4.5;
      if(bt===1){ bw=20; bd=16; bh=8; }
      else if(bt===2){ bw=30; bd=24; bh=14; }
      var geo=new THREE.BoxGeometry(bw,bh,bd);
      var m=new THREE.Mesh(geo, bt===0?houseMat:(bt===1?comMat:aptMat));
      m.position.set(bx,bh/2,bz);
      scene.add(m);
    }
  }
};
