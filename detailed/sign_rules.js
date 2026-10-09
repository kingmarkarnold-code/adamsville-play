/* ================= SIGN PLACEMENT RULES (2026-10-09) =================
   Joshua's directive: ALGORITHMIC PREVENTION — not just fixing today's
   signs, but a placement rule that runs at load time so NO sign can ever
   spawn in a driving lane again.

   Every sign in the game (MARTA bus stops, highway exit signs, street-name
   signs, stop signs, traffic lights, crew warning signs) must pass through
   SignRules.place(x, z, opts) before its mesh is positioned:

     SignRules.place(x, z, opts) -> {x, z, moved, road}

   - Finds the nearest road segment (spatial hash, same grid the building
     checker uses: gridSegsNear / [ax,az,bx,bz,y1,y2,hw,name]).
   - If the point is inside the driving lane (perp distance < hw + margin),
     it is moved perpendicular to the road edge + shoulder clearance,
     on the RIGHT side of travel when a direction is given (opts.dir),
     otherwise on whichever side it is already closest to.
   - Every correction is logged to SignRules.report() + console + the
     Report panel, so Joshua can audit what moved and why.

   Depends on: gridSegsNear (defined in index.html inline blocks). All
   lookups are lazy — safe to load this file before the road grid exists,
   as long as place() is only CALLED after the grid is built.
*/
var SignRules=(function(){
  var audit=[];
  var DEFAULT_MARGIN=2.5;   // extra clearance past the road half-width
  var SHOULDER=3.0;         // final resting distance past half-width

  // nearest road segment to (x,z): {d (perp dist to centerline), hw, name,
  // side (+1/-1 of normal), nx, nz (unit normal), cx, cz (closest point)}
  function nearestSeg(x,z){
    var best=null;
    try{
      var segs=gridSegsNear(x,z,1);
      for(var i=0;i<segs.length;i++){
        var s=segs[i];
        var vx=s[2]-s[0], vz=s[3]-s[1], len2=vx*vx+vz*vz;
        var t=len2>0?((x-s[0])*vx+(z-s[1])*vz)/len2:0;
        t=Math.max(0,Math.min(1,t));
        var cx=s[0]+vx*t, cz=s[1]+vz*t;
        var d=Math.hypot(x-cx,z-cz);
        if(!best||d<best.d){
          var l=Math.hypot(vx,vz)||1;
          var nx=-vz/l, nz=vx/l;            // unit normal
          var side=((x-cx)*nx+(z-cz)*nz)>=0?1:-1;
          best={d:d, hw:(s[6]||3.5), name:(s[7]||''),
                side:side, nx:nx, nz:nz, cx:cx, cz:cz,
                dx:vx/l, dz:vz/l};
        }
      }
    }catch(e){}
    return best;
  }

  // opts: {type, margin, dir:{dx,dz} (travel direction -> right shoulder)}
  function place(x,z,opts){
    opts=opts||{};
    var seg=nearestSeg(x,z);
    if(!seg) return {x:x, z:z, moved:false, road:''};
    var clear=seg.hw+(opts.margin!=null?opts.margin:DEFAULT_MARGIN);
    if(seg.d>=clear) return {x:x, z:z, moved:false, road:seg.name};
    // inside the driving lane -> move to the shoulder
    var nx, nz;
    if(opts.dir&&(opts.dir.dx||opts.dir.dz)){
      var dl=Math.hypot(opts.dir.dx,opts.dir.dz)||1;
      var dx=opts.dir.dx/dl, dz=opts.dir.dz/dl;
      nx=-dz; nz=dx;                       // right side of travel
    }else{
      nx=seg.nx*seg.side; nz=seg.nz*seg.side; // side already closest to
    }
    var px=seg.cx+nx*(seg.hw+SHOULDER), pz=seg.cz+nz*(seg.hw+SHOULDER);
    audit.push({type:opts.type||'sign',
      from:[+x.toFixed(1),+z.toFixed(1)], to:[+px.toFixed(1),+pz.toFixed(1)],
      road:seg.name});
    return {x:px, z:pz, moved:true, road:seg.name};
  }

  function report(){ return audit; }

  // publish audit once per load (guarded — Report may not exist in all contexts)
  function publish(){
    try{
      if(typeof Report!=='undefined'&&Report.setSys)
        Report.setSys('signrules',{checked:'all', moved:audit.length, status:'ok'});
    }catch(e){}
    try{ window.__signAudit=audit; }catch(e){}
    if(audit.length){
      try{ console.log('[SignRules] moved '+audit.length+' sign(s) off driving lanes', audit.slice(0,10)); }catch(e){}
    }
  }

  return {place:place, report:report, nearestSeg:nearestSeg, publish:publish};
})();
