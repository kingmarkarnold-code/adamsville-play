/* ============================================================================
   MLK & FAIRBURN v1.0 (2026-10-09)
   Joshua's ground truth (his lived knowledge — canonical):
   - Intersection: Martin Luther King Jr Dr & Fairburn Rd (game: 3819, 3000)
   - Traveling NORTH on Fairburn Rd, reaching MLK:
     - GAS STATION: on Fairburn, just past (north of) MLK, WEST side
       (left heading north). Built in traffic_system.js placeGasStations().
     - PLAZA: same intersection area, EAST side (right heading north).
   This module builds FAIRBURN PLAZA — east of Fairburn Rd, between the
   east-west Unnamed St (z~2980) and MLK's NE leg. Storefronts face WEST
   toward Fairburn Rd. Saints Row principle: key stores ARE enterable.

   Self-contained module. Depends on globals from school_plaza.js:
   spWall, spSlab, spRoof, spSignBoard, spParkingLot, spShelf,
   spRegisterEnterable, ENTERABLES — plus THREE, scene, heightAt,
   addCollider, labelAt, placeStruct, Report.
   Loaded via <script src="mlk_fairburn.js"> after school_plaza.js.
   ============================================================================ */
(function buildFairburnPlaza() {
  var cx = 3910, cz = 3020;
  /* v2.0 auto-check: nudge clear of roads if needed (never on road) */
  try { var _mf = placeStruct(cx, cz, 24, 3, 'FairburnPlaza'); if (_mf) { cx = _mf.x; cz = _mf.z; } } catch (e) {}
  var gy = heightAt(cx, cz);
  var wallC = 0xa89878, roofC = 0x3a3a3e, H = 6;
  var px0 = cx - 9, px1 = cx + 9;      // west (storefront) / east (back)
  var pz0 = cz - 22, pz1 = cz + 22;    // 44 deep

  var stores = [
    { name: 'DOLLAR STORE', w: 10, enter: true,  color: '#228822' },
    { name: 'PIZZA',        w: 9,  enter: true,  color: '#cc6622' },
    { name: 'BARBER',       w: 8,  enter: false, color: '#224488' },
    { name: 'NAIL SALON',   w: 9,  enter: false, color: '#aa44aa' },
    { name: 'CELL PHONES',  w: 8,  enter: false, color: '#6633aa' },
  ];
  // 10+9+8+9+8 = 44 = pz1-pz0.

  spWall(px0, pz0, px1, pz0, H, wallC, gy, []);   // north
  spWall(px0, pz1, px1, pz1, H, wallC, gy, []);   // south
  spWall(px1, pz0, px1, pz1, H, wallC, gy, []);   // east (back)
  var plazaRoof = spRoof(cx, cz, 18, 44, roofC, gy, H);
  spSlab(cx, cz, 18, 44, 0xc8b898, gy, 0.15);

  var glassM = new THREE.MeshLambertMaterial({
    color: 0x9fc4d8, transparent: true, opacity: 0.45 });
  var zcur = pz0;
  stores.forEach(function(st) {
    var zA = zcur, zB = zcur + st.w, zM = (zA + zB) / 2;
    zcur = zB;
    spWall(px0, zA, px0, zB, H, wallC, gy, [{ at: st.w / 2, w: 3 }]);
    [[zA, zM - 1.8], [zM + 1.8, zB]].forEach(function(sg) {
      var gw = sg[1] - sg[0];
      if (gw < 0.5) return;
      var gm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 3.2, gw), glassM);
      gm.position.set(px0, gy + 2.0, (sg[0] + sg[1]) / 2);
      scene.add(gm);
    });
    spSignBoard(st.name, px0 - 0.4, gy + 5.0, zM, Math.min(st.w - 1, 16), st.color, true);

    if (st.enter) {
      var inX = px0 + 5, inZ = zM;
      if (st.name === 'DOLLAR STORE') {
        for (var a = 0; a < 2; a++) {
          spShelf(inX - 1 + a * 3, inZ - 3, 7, gy, false);
          spShelf(inX - 1 + a * 3, inZ + 3, 7, gy, false);
        }
        var dc = new THREE.Mesh(new THREE.BoxGeometry(3, 1.0, 1.2),
          new THREE.MeshLambertMaterial({ color: 0xaaaaaa }));
        dc.position.set(px1 - 2.5, gy + 0.65, inZ); scene.add(dc);
        addCollider(px1 - 2.5, inZ, 2);
      } else { // PIZZA
        var mc = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 6),
          new THREE.MeshLambertMaterial({ color: 0x8a4a2a }));
        mc.position.set(px1 - 3, gy + 0.7, inZ); scene.add(mc);
        addCollider(px1 - 3, inZ, 3.5);
        for (var t2 = 0; t2 < 2; t2++) {
          var tb = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.75, 1.5),
            new THREE.MeshLambertMaterial({ color: 0xcc8833 }));
          var tbz = inZ - 2.5 + t2 * 5;
          tb.position.set(inX - 2, gy + 0.5, tbz);
          scene.add(tb); addCollider(inX - 2, tbz, 1.1);
        }
      }
      var ix = spRegisterEnterable(st.name, px0 - 1.5, zM, inX, inZ, gy + 0.25);
      ENTERABLES[ix].roofs.push(plazaRoof);
    }
  });

  /* ---- parking lot (west of building, toward Fairburn Rd) ---- */
  spParkingLot(cx - 25, cz + 2, 22, 36, heightAt(cx - 25, cz + 2), 2);

  /* ---- sidewalk along storefronts ---- */
  spSlab(px0 - 3, cz, 5, 48, 0x9a9a9a, heightAt(px0 - 3, cz), 0.12);

  /* ---- pylon sign near the corner ---- */
  var pyX = cx - 32, pyZ = cz - 10, pyGy = heightAt(pyX, pyZ);
  var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 10, 8),
    new THREE.MeshLambertMaterial({ color: 0x666666 }));
  pole.position.set(pyX, pyGy + 5, pyZ); scene.add(pole);
  spSignBoard('FAIRBURN PLAZA', pyX, pyGy + 11, pyZ, 20, '#1a3a6b', true);
  addCollider(pyX, pyZ, 1);

  labelAt('FAIRBURN PLAZA', cx, cz, 18, 45, '#ffd75e');
  addCollider(cx, cz, 26);
})();

/* ---------- placement audit (logged, not blocking) ---------- */
(function mfAudit() {
  try {
    Report.note('mlk-fairburn-build', {
      plaza: 'FAIRBURN PLAZA',
      gas: 'FairburnFuel (MLK & Fairburn, west side)',
      enterables: (typeof ENTERABLES !== 'undefined') ? ENTERABLES.length : -1
    });
  } catch (e) {}
})();
