/* ============================================================================
   ROADLABELS — street-name labels painted on road surfaces for the watcher's
   3D views (3D Explore + Buildings in-context preview).
   EDITOR-ONLY. This is a review aid for Joshua — it must NEVER go into the
   game build. The game itself has no street-name road paint.
   ----------------------------------------------------------------------------
   Usage:
     ROADLABELS.build({
       heightAt: function(x,z){ return <road-surface y> + 0.5; },
       cx: <center x>, cz: <center z>, radius: <max dist>   // optional: area limit
       labelH: <base label height in world units>           // optional
     }) -> THREE.Group (merged 1 draw call per unique street name)
   Requires: THREE, WORLD (world.js) loaded before calling build().
   ========================================================================== */
window.ROADLABELS = (function () {
  'use strict';

  var texCache = {};   // name -> {tex, aspect}
  var FS = 44, PAD = 16;

  function nameTexture(name) {
    var hit = texCache[name];
    if (hit) return hit;
    var cv = document.createElement('canvas');
    var g = cv.getContext('2d');
    g.font = 'bold ' + FS + 'px Arial, Helvetica, sans-serif';
    var tw = Math.ceil(g.measureText(name).width);
    cv.width = Math.min(1024, tw + PAD * 2);
    cv.height = FS + PAD * 2;
    var c2 = cv.getContext('2d');
    c2.font = 'bold ' + FS + 'px Arial, Helvetica, sans-serif';
    c2.textBaseline = 'middle';
    // crisp white; slight dark edge so it reads on any surface
    c2.lineWidth = 5;
    c2.strokeStyle = 'rgba(0,0,0,0.45)';
    c2.strokeText(name, PAD, PAD + FS / 2);
    c2.fillStyle = 'rgba(255,255,255,0.95)';
    c2.fillText(name, PAD, PAD + FS / 2);
    var tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    hit = { tex: tex, aspect: cv.width / cv.height };
    texCache[name] = hit;
    return hit;
  }

  // label heights per road category (highways read from far away)
  var CAT_H = { 0: 22, 1: 15, 2: 10 };

  function build(opts) {
    opts = opts || {};
    var group = new THREE.Group();
    if (typeof WORLD === 'undefined' || !WORLD.roads) return group;
    var heightAt = opts.heightAt || function () { return 1; };
    var perName = {};   // name -> {quads:[{x,z,h,heading,w}], h}
    var haveArea = (opts.cx !== undefined && opts.cz !== undefined && opts.radius);

    (WORLD.roads || []).forEach(function (r) {
      var name = (r[1] || '').trim();
      if (!name) return;                       // unnamed roads get no label
      var pts = r[2], n = pts.length / 2;
      if (n < 2) return;
      var spots = [Math.floor(n / 2)];
      if (n > 10) spots.push(Math.floor(n / 4), Math.floor(3 * n / 4));
      var lh = opts.labelH || CAT_H[r[0]] || 10;
      for (var s = 0; s < spots.length; s++) {
        var si = spots[s];
        var x = pts[si * 2], z = pts[si * 2 + 1];
        if (haveArea && Math.hypot(x - opts.cx, z - opts.cz) > opts.radius) continue;
        // road heading from neighboring points
        var i0 = Math.max(0, si - 2) * 2, i1 = Math.min(n - 1, si + 2) * 2;
        var dx = pts[i1] - pts[i0], dz = pts[i1 + 1] - pts[i0 + 1];
        if (!dx && !dz) continue;
        var heading = Math.atan2(dx, dz);
        if (Math.cos(heading) < 0) heading += Math.PI;  // keep text readable from the south side
        var e = perName[name] || (perName[name] = { quads: [], h: lh });
        e.quads.push({ x: x, z: z, heading: heading });
      }
    });

    Object.keys(perName).forEach(function (name) {
      var t = nameTexture(name);
      var E = perName[name], H = E.h, W = H * t.aspect;
      var hw = W / 2, hh = H / 2;
      var pos = [], uv = [], idx = [];
      E.quads.forEach(function (L, qi) {
        var y = heightAt(L.x, L.z);
        var sh = Math.sin(L.heading), ch = Math.cos(L.heading);
        // dir=(sh,ch) in (x,z); perp=(ch,-sh); corners laid flat on XZ
        function corner(du, dv) {
          return [L.x + sh * du + ch * dv, y, L.z + ch * du - sh * dv];
        }
        var A = corner(-hw, -hh), B = corner(hw, -hh),
            C = corner(hw, hh),  D = corner(-hw, hh);
        var b = pos.length / 3;
        pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2]);
        uv.push(0, 0, 1, 0, 1, 1, 0, 1);
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      });
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      var mat = new THREE.MeshBasicMaterial({
        map: t.tex, transparent: true, opacity: 0.92,
        depthWrite: false
      });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 5;   // draw after roads so paint sits on top
      mesh.userData.kind = 'roadlabel';
      group.add(mesh);
    });
    return group;
  }

  return { build: build };
})();
