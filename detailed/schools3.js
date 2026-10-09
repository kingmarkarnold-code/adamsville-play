/* ============================================================================
   THREE SCHOOLS v1.0 (2026-10-09)
   Joshua's specs: Adamsville Elementary, Usher Middle School, and Mays High
   School must be at their proper real-world locations.

   1. ADAMSVILLE ELEMENTARY SCHOOL — 286 Wilson Mill Rd SW, Atlanta, GA 30331
      Verified: 33.754818, -84.514126 -> game (3532.6, 3180.2)
      Campus EAST of Wilson Mill Rd SW, front faces WEST toward the road.
      Cleared against: Wilson Mill Rd SW, Unnamed St (E-W at z~3204),
      Oakside Dr SW, Tarragon Way SW, and 3 nearby OSM houses.
   2. USHER MIDDLE SCHOOL — 631 Harwell Rd NW, Atlanta, GA 30318
      Verified via Nominatim: 33.7722699, -84.4934517 -> game (4216.7, 2522.5)
      Campus EAST of Harwell Rd NW, front faces WEST toward the road.
      Cleared against: Harwell Rd NW, I-285, Jones Rd NW, Waterford Rd NW,
      Amhurst Dr NW, Vanderbilt Ct NW, Hobart Dr NW, and 3 nearby OSM houses.
   3. MAYS HIGH SCHOOL — 3450 Benjamin E Mays Dr SW, Atlanta, GA 30331
      Verified: 33.734171, -84.504109 -> game (3864.1, 3958.4)
      Campus NORTH of Benjamin E Mays Dr SW, front faces SOUTH toward road.
      Cleared against: Benjamin E Mays Dr SW, I-285, Unnamed St (N-S),
      Lynfield Dr SW, Utoy Dr SW. Zero OSM building conflicts.

   Saints Row principle: detailed exteriors only; no interiors (per spec).
   Self-contained module. Depends on globals from school_plaza.js:
   spWall, spSlab, spRoof, spSignBoard, spParkingLot, plus THREE, scene,
   heightAt, addCollider, addSegCollider, labelAt.
   Loaded via <script src="schools3.js"> after school_plaza.js.
   ============================================================================ */

/* ============================================================================
   1. ADAMSVILLE ELEMENTARY SCHOOL
   Main: center (3558, 3185), 52 x 20, 5u single-story. Front faces WEST.
   ============================================================================ */
(function buildAdamsvilleElem() {
  var brick = 0x9d5f43, trim = 0xf2ede2, roofC = 0x4a3a2e;
  var cx = 3554, cz = 3185;
  /* v2.0 auto-check: nudge clear of roads if needed (never on road) */
  try{ var _sp=placeStruct(cx,cz,26,4,'AdamsvilleElem'); if(_sp){cx=_sp.x;cz=_sp.z;} }catch(e){}
  var gy = heightAt(cx, cz);
  var x0 = cx - 22, x1 = cx + 22, z0 = cz - 10, z1 = cz + 10;

  /* main building (44 x 20 — clear of Oakside Dr SW to the east) */
  spWall(x0, z1, x1, z1, 5, brick, gy, []);
  spWall(x0, z0, x1, z0, 5, brick, gy, []);
  spWall(x1, z0, x1, z1, 5, brick, gy, []);
  spWall(x0, z0, x0, z1, 5, brick, gy, [{ at: 10, w: 4 }]);  // west entrance
  spSlab(cx, cz, 44, 20, 0xc8b898, gy, 0.15);
  spRoof(cx, cz, 44, 20, roofC, gy, 5);
  /* entrance canopy (west) */
  var can = new THREE.Mesh(new THREE.BoxGeometry(6, 0.4, 10),
    new THREE.MeshLambertMaterial({ color: trim }));
  can.position.set(x0 - 3, gy + 3.4, cz); scene.add(can);
  [[-4], [4]].forEach(function(o) {
    var post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 3.4, 8),
      new THREE.MeshLambertMaterial({ color: 0x888888 }));
    post.position.set(x0 - 5.5, gy + 1.7, cz + o[0]); scene.add(post);
  });
  /* window band (west face) */
  var winM = new THREE.MeshLambertMaterial({ color: 0x9fc4d8 });
  for (var wx = 0; wx < 4; wx++) {
    var win = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.6, 4), winM);
    win.position.set(x0 - 0.05, gy + 2.8, z0 + 3 + wx * 5);
    scene.add(win);
    var win2 = win.clone(); win2.position.z = z1 - 3 - wx * 5; scene.add(win2);
  }
  spSignBoard('ADAMSVILLE ELEMENTARY SCHOOL', cx, gy + 4.4, z1 + 0.35, 34, '#1a6b3a', false);

  /* playground (south of main): rubber surface + play structures */
  var pgx = 3558, pgz = 3150, pggy = heightAt(pgx, pgz);
  spSlab(pgx, pgz, 36, 20, 0x4a7a4a, pggy, 0.08);
  var eqC = [0xcc3333, 0x3366cc, 0xddaa22];
  for (var pi = 0; pi < 3; pi++) {
    var eq = new THREE.Mesh(new THREE.BoxGeometry(3, 2.2, 3),
      new THREE.MeshLambertMaterial({ color: eqC[pi] }));
    eq.position.set(pgx - 10 + pi * 10, pggy + 1.2, pgz);
    scene.add(eq);
    addCollider(pgx - 10 + pi * 10, pgz, 2);
  }
  /* swing set frame */
  var swM = new THREE.MeshLambertMaterial({ color: 0x666666 });
  [-6, 6].forEach(function(o) {
    var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3, 8), swM);
    leg.position.set(pgx + o, pggy + 1.5, pgz + 6); scene.add(leg);
  });
  var bar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 12.5, 8), swM);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(pgx, pggy + 3, pgz + 6); scene.add(bar);

  /* parking lot (north of Unnamed St) */
  spParkingLot(3550, 3230, 30, 20, heightAt(3550, 3230), 2);

  /* monument sign near Wilson Mill Rd */
  var sgx = 3530, sgz = 3190, sggy = heightAt(sgx, sgz);
  var sp1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.5, 0.5),
    new THREE.MeshLambertMaterial({ color: 0x6a4a2a }));
  sp1.position.set(sgx, sggy + 1.25, sgz); scene.add(sp1);
  spSignBoard('ADAMSVILLE ELEMENTARY', sgx, sggy + 3.4, sgz, 16, '#1a6b3a', true);
  addCollider(sgx, sgz, 1);

  /* sidewalk: road -> entrance */
  spSlab(3544, 3185, 16, 3, 0x9a9a9a, heightAt(3544, 3185), 0.12);

  labelAt('ADAMSVILLE ELEMENTARY', cx, cz, 18, 46, '#ffd75e');
  addCollider(cx, cz, 28);
})();

/* ============================================================================
   2. USHER MIDDLE SCHOOL
   Main: center (4220, 2525), 64 x 26, 8u two-story. Front faces WEST.
   ============================================================================ */
(function buildUsherMiddle() {
  var brick = 0x8a4f38, trim = 0xf2ede2, roofC = 0x3a3a3e;
  var cx = 4220, cz = 2525;
  /* v2.0 auto-check: nudge clear of roads if needed (never on road) */
  try{ var _sp2=placeStruct(cx,cz,35,4,'UsherMiddle'); if(_sp2){cx=_sp2.x;cz=_sp2.z;} }catch(e){}
  var gy = heightAt(cx, cz);
  var x0 = cx - 32, x1 = cx + 32, z0 = cz - 13, z1 = cz + 13;

  /* main building (2 stories) */
  spWall(x0, z1, x1, z1, 8, brick, gy, []);
  spWall(x0, z0, x1, z0, 8, brick, gy, []);
  spWall(x1, z0, x1, z1, 8, brick, gy, []);
  spWall(x0, z0, x0, z1, 8, brick, gy, [{ at: 13, w: 5 }]);  // west entrance
  spSlab(cx, cz, 64, 26, 0xc8b898, gy, 0.15);
  spRoof(cx, cz, 64, 26, roofC, gy, 8);
  /* second-story window band */
  var winM = new THREE.MeshLambertMaterial({ color: 0x9fc4d8 });
  for (var wx = 0; wx < 6; wx++) {
    var win = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.8, 3), winM);
    win.position.set(x0 - 0.05, gy + 5.8, z0 + 4 + wx * 4);
    scene.add(win);
  }
  /* entrance canopy */
  var can = new THREE.Mesh(new THREE.BoxGeometry(7, 0.4, 12),
    new THREE.MeshLambertMaterial({ color: trim }));
  can.position.set(x0 - 3.5, gy + 3.6, cz); scene.add(can);
  [[-5], [5]].forEach(function(o) {
    var post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 3.6, 8),
      new THREE.MeshLambertMaterial({ color: 0x888888 }));
    post.position.set(x0 - 6.5, gy + 1.8, cz + o[0]); scene.add(post);
  });
  spSignBoard('USHER MIDDLE SCHOOL', cx, gy + 7.2, z1 + 0.35, 36, '#6b1a2a', false);

  /* gym (east of main) */
  var gx = 4275, gz = 2525, ggy = heightAt(gx, gz);
  var ggx0 = gx - 15, ggx1 = gx + 15, ggz0 = gz - 12, ggz1 = gz + 12;
  spWall(ggx0, ggz1, ggx1, ggz1, 7, brick, ggy, []);
  spWall(ggx0, ggz0, ggx1, ggz0, 7, brick, ggy, []);
  spWall(ggx1, ggz0, ggx1, ggz1, 7, brick, ggy, []);
  spWall(ggx0, ggz0, ggx0, ggz1, 7, brick, ggy, [{ at: 12, w: 4 }]);
  spSlab(gx, gz, 30, 24, 0xc8a86a, ggy, 0.15);
  spRoof(gx, gz, 30, 24, roofC, ggy, 7);
  spSignBoard('GYMNASIUM', gx, ggy + 5.8, ggz1 + 0.3, 14, '#2a6b2a', false);
  addCollider(gx, gz, 17);

  /* athletic field (east): grass + track oval + goals */
  var fx = 4285, fz = 2510, fgy = heightAt(fx, fz);
  spSlab(fx, fz, 44, 36, 0x3d7a3d, fgy, 0.08);
  var trM = new THREE.MeshLambertMaterial({ color: 0x9a5a3a });
  var track = new THREE.Mesh(new THREE.BoxGeometry(40, 0.1, 32), trM);
  track.position.set(fx, fgy + 0.18, fz); scene.add(track);
  var inf = new THREE.Mesh(new THREE.BoxGeometry(30, 0.12, 22),
    new THREE.MeshLambertMaterial({ color: 0x3d7a3d }));
  inf.position.set(fx, fgy + 0.2, fz); scene.add(inf);
  [[fx - 18, fz], [fx + 18, fz]].forEach(function(p) {
    var gp = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 4, 8),
      new THREE.MeshLambertMaterial({ color: 0xddbb33 }));
    gp.position.set(p[0], fgy + 2, p[1]); scene.add(gp);
  });

  /* parking lot (south of main) */
  spParkingLot(4220, 2560, 44, 20, heightAt(4220, 2560), 2);

  /* driveway: Harwell Rd -> campus */
  spSlab(4172, 2525, 50, 8, 0x3a3a3e, heightAt(4172, 2525), 0.1);

  /* monument sign near Harwell Rd */
  var sgx = 4158, sgz = 2525, sggy = heightAt(sgx, sgz);
  var sp1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.5, 0.5),
    new THREE.MeshLambertMaterial({ color: 0x6a4a2a }));
  sp1.position.set(sgx, sggy + 1.25, sgz); scene.add(sp1);
  spSignBoard('USHER MIDDLE SCHOOL', sgx, sggy + 3.4, sgz, 16, '#6b1a2a', true);
  addCollider(sgx, sgz, 1);

  /* flag pole */
  var fp = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 12, 8),
    new THREE.MeshLambertMaterial({ color: 0xcccccc }));
  fp.position.set(x0 - 12, gy + 6, cz + 10); scene.add(fp);
  addCollider(x0 - 12, cz + 10, 0.5);

  labelAt('USHER MIDDLE SCHOOL', cx, cz, 20, 52, '#ffd75e');
  addCollider(cx, cz, 34);
})();

/* ============================================================================
   3. MAYS HIGH SCHOOL
   Main: center (3875, 3952), 80 x 25, 10u two-story modern.
   Front faces SOUTH toward Benjamin E Mays Dr SW.
   Colors: Carolina blue + gold accents (Raiders).
   ============================================================================ */
(function buildMaysHigh() {
  var conc = 0xb8a888, blue = 0x4a90c4, gold = 0xddbb33, roofC = 0x3a3a3e;
  var cx = 3875, cz = 3952;
  /* v2.0 auto-check: nudge clear of roads if needed (never on road) */
  try{ var _sp3=placeStruct(cx,cz,36,4,'MaysHigh'); if(_sp3){cx=_sp3.x;cz=_sp3.z;} }catch(e){}
  var gy = heightAt(cx, cz);
  var x0 = cx - 35, x1 = cx + 35, z0 = cz - 10, z1 = cz + 10;

  /* main building (modern, 2 stories — clear of Unnamed St W and I-285 E) */
  spWall(x0, z0, x1, z0, 10, conc, gy, [{ at: 40, w: 6 }]);  // south entrance
  spWall(x0, z1, x1, z1, 10, conc, gy, []);
  spWall(x0, z0, x0, z1, 10, conc, gy, []);
  spWall(x1, z0, x1, z1, 10, conc, gy, []);
  spSlab(cx, cz, 70, 20, 0xd8ccb0, gy, 0.15);
  spRoof(cx, cz, 70, 20, roofC, gy, 10);
  /* Carolina blue accent band */
  var band = new THREE.Mesh(new THREE.BoxGeometry(70, 1.2, 0.3),
    new THREE.MeshLambertMaterial({ color: blue }));
  band.position.set(cx, gy + 8.2, z0 - 0.1); scene.add(band);
  var band2 = band.clone(); band2.position.z = z1 + 0.1; scene.add(band2);
  /* glass entrance (south) */
  var glassM = new THREE.MeshLambertMaterial({
    color: 0x9fc4d8, transparent: true, opacity: 0.5 });
  var gl = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 0.3), glassM);
  gl.position.set(cx, gy + 3.2, z0 - 0.1); scene.add(gl);
  /* second-story windows (south face) */
  var winM = new THREE.MeshLambertMaterial({ color: 0x9fc4d8 });
  for (var wx = 0; wx < 8; wx++) {
    var win = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 0.2), winM);
    win.position.set(x0 + 6 + wx * 9, gy + 7, z0 - 0.05);
    scene.add(win);
  }
  spSignBoard('MAYS HIGH SCHOOL', cx, gy + 9.2, z0 - 0.35, 40, '#1a3a6b', false);
  /* gold Raider accent on roof edge */
  var ra = new THREE.Mesh(new THREE.BoxGeometry(20, 0.8, 0.4),
    new THREE.MeshLambertMaterial({ color: gold }));
  ra.position.set(cx, gy + 10.4, z0 - 0.2); scene.add(ra);

  /* gym (north-east of main) */
  var gx = 3855, gz = 3912, ggy = heightAt(gx, gz);
  var ggx0 = gx - 15, ggx1 = gx + 15, ggz0 = gz - 12, ggz1 = gz + 12;
  spWall(ggx0, ggz1, ggx1, ggz1, 8, conc, ggy, []);
  spWall(ggx0, ggz0, ggx1, ggz0, 8, conc, ggy, []);
  spWall(ggx0, ggz0, ggx0, ggz1, 8, conc, ggy, []);
  spWall(ggx1, ggz0, ggx1, ggz1, 8, conc, ggy, [{ at: 12, w: 4 }]);
  spSlab(gx, gz, 30, 24, 0xc8a86a, ggy, 0.15);
  spRoof(gx, gz, 30, 24, roofC, ggy, 8);
  var gband = new THREE.Mesh(new THREE.BoxGeometry(30, 1, 0.3),
    new THREE.MeshLambertMaterial({ color: blue }));
  gband.position.set(gx, ggy + 6.5, ggz1 + 0.1); scene.add(gband);
  spSignBoard('RAIDERS GYMNASIUM', gx, ggy + 7.4, ggz1 + 0.35, 20, '#1a3a6b', false);
  addCollider(gx, gz, 17);

  /* practice field (west of campus) */
  var fx = 3740, fz = 3960, fgy = heightAt(fx, fz);
  spSlab(fx, fz, 80, 48, 0x3d7a3d, fgy, 0.08);
  var wlM = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
  for (var yl = -20; yl <= 20; yl += 10) {
    var ylm = new THREE.Mesh(new THREE.BoxGeometry(40, 0.06, 0.4), wlM);
    ylm.position.set(fx, fgy + 0.25, fz + yl); scene.add(ylm);
  }
  [[fx - 22, fz], [fx + 22, fz]].forEach(function(p) {
    var gp = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 6, 8),
      new THREE.MeshLambertMaterial({ color: gold }));
    gp.position.set(p[0], fgy + 3, p[1]); scene.add(gp);
    var cross = new THREE.Mesh(new THREE.BoxGeometry(5, 0.3, 0.3),
      new THREE.MeshLambertMaterial({ color: gold }));
    cross.position.set(p[0], fgy + 5.5, p[1]); scene.add(cross);
  });

  /* main parking lot (south of main, toward road) */
  spParkingLot(3875, 3900, 60, 30, heightAt(3875, 3900), 2);

  /* driveway: Benjamin E Mays Dr -> parking */
  spSlab(3870, 3848, 10, 74, 0x3a3a3e, heightAt(3870, 3848), 0.1);

  /* monument sign near Benjamin E Mays Dr */
  var sgx = 3880, sgz = 3820, sggy = heightAt(sgx, sgz);
  var sp1 = new THREE.Mesh(new THREE.BoxGeometry(0.6, 3, 0.6),
    new THREE.MeshLambertMaterial({ color: 0x6a4a2a }));
  sp1.position.set(sgx - 8, sggy + 1.5, sgz); scene.add(sp1);
  var sp2 = sp1.clone(); sp2.position.x = sgx + 8; scene.add(sp2);
  spSignBoard('MAYS HIGH SCHOOL', sgx, sggy + 4.2, sgz, 22, '#1a3a6b', false);
  addCollider(sgx, sgz, 2);

  /* flag pole */
  var fp = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 14, 8),
    new THREE.MeshLambertMaterial({ color: 0xcccccc }));
  fp.position.set(x0 + 10, gy + 7, z0 - 8); scene.add(fp);
  addCollider(x0 + 10, z0 - 8, 0.5);

  labelAt('MAYS HIGH SCHOOL', cx, cz, 24, 62, '#ffd75e');
  addCollider(cx, cz, 37);
})();

/* ---------- placement audit (logged, not blocking) ---------- */
(function schools3Audit() {
  try {
    Report.note('schools3-build', {
      schools: ['ADAMSVILLE ELEMENTARY', 'USHER MIDDLE SCHOOL', 'MAYS HIGH SCHOOL'],
      positions: { adamsville: [3558, 3185], usher: [4220, 2525], mays: [3875, 3952] }
    });
  } catch (e) {}
})();
