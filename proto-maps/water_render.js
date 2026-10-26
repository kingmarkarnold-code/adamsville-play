/* ============================================================================
   WATER RENDERER — rivers, streams, lakes, ponds (2026-10-11)
   Joshua's rule: all code commented.

   Loads water_features.json (same schema as the map-editor repo's water.json)
   and renders:
     - Rivers/streams: blue ribbons following the polyline, draped on terrain
     - Lakes/ponds: blue filled discs (ellipses) at terrain height

   Defensive: if the JSON is missing or corrupt, nothing renders and the
   game continues normally. Water never crashes the game.
   ============================================================================ */

(function WaterRenderer(){
  'use strict';

  // URL for the water data file (same directory as this script).
  var WATER_URL = 'water_features.json';

  // Water colors (match the existing Tatum Lake style in index.html).
  var WATER_SURFACE = 0x2e6f9e;  // surface blue
  var WATER_SIDE    = 0x1e6f9e;  // underwater skirt blue

  /**
   * Fetch JSON with a timeout. Returns null on any failure.
   * Defensive: the game must work with or without water data.
   */
  function fetchWater(url, cb){
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url + '?v=' + Date.now(), true);
      xhr.timeout = 10000;
      xhr.onload = function(){
        if (xhr.status >= 200 && xhr.status < 300) {
          try { cb(JSON.parse(xhr.responseText)); }
          catch(e){ cb(null); }  // corrupt JSON = no water
        } else { cb(null); }     // 404 etc = no water
      };
      xhr.onerror = function(){ cb(null); };
      xhr.ontimeout = function(){ cb(null); };
      xhr.send();
    } catch(e){ cb(null); }
  }

  /**
   * Get terrain height at (x, z). Uses the game's heightAt() if available,
   * otherwise returns 0 (water renders at ground level).
   */
  function groundHeight(x, z){
    try {
      if (typeof heightAt === 'function') return heightAt(x, z);
    } catch(e){}
    return 0;
  }

  /**
   * Render a lake or pond as an elliptical disc at terrain height,
   * with a translucent underwater skirt (same pattern as waterDisc()
   * in index.html for Tatum Lake).
   *
   * polygon: array of [x, z] points forming the shoreline.
   * name: label text (may be null for no label).
   * depthFt: max depth in FEET at the center (parabolic profile to shore).
   */
  function renderLakePond(polygon, name, depthFt){
    if (!polygon || polygon.length < 3) return;

    // Compute centroid and bounding radii from the polygon.
    var cx = 0, cz = 0;
    for (var i = 0; i < polygon.length; i++){
      cx += polygon[i][0]; cz += polygon[i][1];
    }
    cx /= polygon.length; cz /= polygon.length;

    var maxRx = 1, maxRz = 1;
    for (var j = 0; j < polygon.length; j++){
      maxRx = Math.max(maxRx, Math.abs(polygon[j][0] - cx));
      maxRz = Math.max(maxRz, Math.abs(polygon[j][1] - cz));
    }

    var y = groundHeight(cx, cz);

    // Surface disc (elliptical).
    var geo = new THREE.CircleGeometry(1, 28);
    geo.rotateX(-Math.PI / 2);
    geo.scale(maxRx, 1, maxRz);
    var mesh = new THREE.Mesh(geo,
      new THREE.MeshLambertMaterial({ color: WATER_SURFACE }));
    mesh.position.set(cx, y + 0.35, cz);
    scene.add(mesh);

    // Translucent underwater skirt (so it reads as a volume, not a shell).
    var depth = maxRx > 60 ? 10 : 6;
    var sg = new THREE.CylinderGeometry(1, 1.05, depth, 28, 1, true);
    var sm = new THREE.Mesh(sg, new THREE.MeshLambertMaterial({
      color: WATER_SIDE, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: false }));
    sm.scale.set(maxRx, 1, maxRz);
    sm.position.set(cx, y + 0.35 + 0.15 - depth / 2, cz);
    sm.renderOrder = 1;
    scene.add(sm);

    // Register in the global WATER array (used by inWater() checks).
    // depthFt flows through so waterDepthAt() can use per-feature depth.
    if (typeof WATER !== 'undefined'){
      WATER.push({ x: cx, z: cz, rx: maxRx, rz: maxRz, name: name,
                   polygon: polygon, depthFt: depthFt });
    }

    // Map label.
    if (name && typeof labelAt === 'function'){
      labelAt(name.toUpperCase(), cx, cz, 14, 34, '#7fd4ff');
    }
  }

  /**
   * Render a river or stream as a ribbon following the polyline.
   * Uses the game's ribbonGeom() if available (same as the creek in
   * index.html), otherwise builds a simple flat ribbon.
   *
   * pts: array of [x, z] centerline points.
   * width: ribbon width in world units.
   * name: label text (may be null).
   * depthFt: max depth in FEET at the channel center.
   */
  function renderRiverStream(pts, width, name, depthFt){
    if (!pts || pts.length < 2) return;

    var mesh;
    if (typeof ribbonGeom === 'function'){
      // Use the game's ribbon builder (drapes on terrain).
      var cg = ribbonGeom(pts, width, 0.18);
      mesh = new THREE.Mesh(cg,
        new THREE.MeshLambertMaterial({ color: WATER_SURFACE }));
    } else {
      // Fallback: build a simple flat ribbon manually.
      mesh = buildSimpleRibbon(pts, width);
      if (!mesh) return;
    }
    scene.add(mesh);

    // Register for inWater() checks (index.html handles {river} entries).
    if (typeof WATER !== 'undefined'){
      WATER.push({ river: pts, width: width, name: name, depthFt: depthFt });
    }

    // Label at the midpoint.
    if (name && typeof labelAt === 'function'){
      var mid = pts[Math.floor(pts.length / 2)];
      labelAt(name.toUpperCase(), mid[0], mid[1], 14, 34, '#7fd4ff');
    }
  }

  /**
   * Build a simple flat ribbon mesh from a polyline.
   * Fallback when ribbonGeom() isn't available.
   */
  function buildSimpleRibbon(pts, width){
    var hw = width / 2;
    var positions = [];
    var indices = [];

    for (var i = 0; i < pts.length; i++){
      // Direction vector (for perpendicular offset).
      var dx, dz;
      if (i === 0){ dx = pts[1][0]-pts[0][0]; dz = pts[1][1]-pts[0][1]; }
      else if (i === pts.length-1){ dx = pts[i][0]-pts[i-1][0]; dz = pts[i][1]-pts[i-1][1]; }
      else { dx = pts[i+1][0]-pts[i-1][0]; dz = pts[i+1][1]-pts[i-1][1]; }
      var len = Math.sqrt(dx*dx + dz*dz) || 1;
      // Perpendicular (normal) vector.
      var nx = -dz/len * hw, nz = dx/len * hw;

      var lx = pts[i][0] + nx, lz = pts[i][1] + nz;
      var rx = pts[i][0] - nx, rz = pts[i][1] - nz;
      // Sample terrain height at center, lift slightly above.
      var y = groundHeight(pts[i][0], pts[i][1]) + 0.3;

      positions.push(lx, y, lz,  rx, y, rz);
      if (i > 0){
        var b = i * 2;
        indices.push(b-2, b, b-1,  b-1, b, b+1);
      }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position',
      new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    return new THREE.Mesh(geo,
      new THREE.MeshLambertMaterial({ color: WATER_SURFACE,
        side: THREE.DoubleSide }));
  }

  /**
   * Main entry: fetch water data and render everything.
   * Called once at startup after the scene is ready.
   */
  function init(){
    // Wait for the scene to exist.
    if (typeof scene === 'undefined' || typeof THREE === 'undefined'){
      setTimeout(init, 500);
      return;
    }

    fetchWater(WATER_URL, function(data){
      if (!data) return;  // no water data = no water, game continues

      // Rivers (wide polylines).
      var rivers = data.rivers || [];
      for (var i = 0; i < rivers.length; i++){
        renderRiverStream(rivers[i].pts, rivers[i].width || 40,
                          rivers[i].name, rivers[i].depth);
      }

      // Streams/creeks (narrow polylines).
      var streams = data.streams || [];
      for (var j = 0; j < streams.length; j++){
        renderRiverStream(streams[j].pts, streams[j].width || 15,
                          streams[j].name, streams[j].depth);
      }

      // Lakes (large polygons).
      var lakes = data.lakes || [];
      for (var k = 0; k < lakes.length; k++){
        renderLakePond(lakes[k].polygon, lakes[k].name, lakes[k].depth);
      }

      // Ponds (small polygons).
      var ponds = data.ponds || [];
      for (var m = 0; m < ponds.length; m++){
        renderLakePond(ponds[m].polygon, ponds[m].name, ponds[m].depth);
      }
    });
  }

  // Start after the page loads (scene is built by then).
  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);

  // Expose for debugging.
  window.WaterRenderer = { init: init };

})();
