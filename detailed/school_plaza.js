/* ============================================================================
   SCHOOL + PLAZA v1.0 (2026-10-09)
   Joshua's specs:
   - HARPER ARCHER HIGH SCHOOL (real: Harper-Archer Middle School,
     3399 Collier Dr NW, verified via Nominatim: 33.7688, -84.4991)
     Named "HARPER ARCHER HIGH SCHOOL" in game. Accurate campus, walkable.
     Campus sits EAST of Fairburn Rd NW, NORTH of Collier Dr NW,
     WEST of I-285 (all verified against game road data — no overlaps).
   - SHOPS AT CASCADE plaza (Cascade Rd & Fairburn Rd SW).
     East side of Fairburn Rd (left heading south), NORTH of Cascade Rd
     (clear of Cascade Rd, Research Center Dr SW, Utoy Springs Rd SW).
     Functional storefronts, parking lot, walkable.

   Saints Row principle: many buildings look enterable; the school and key
   plaza stores ARE enterable.

   Self-contained module. Depends on globals: THREE, scene, heightAt,
   box, labelAt, addCollider, addSegCollider, player, car, setDrivingUI,
   LANDMARKS, Report.
   Loaded via <script src="school_plaza.js"> after semi_system.js.
   ============================================================================ */

var ENTERABLES = [];   // {name, doorX, doorZ, inX, inZ, floorY, roofs:[]}
if (typeof player !== 'undefined') { player.locIdx = -1; player.locFloorY = 0; }

/* Register an enterable location; returns its ENTERABLES index.
   doorX/doorZ = outside door spot, inX/inZ = inside landing spot,
   floorY = player Y inside. */
function spRegisterEnterable(name, doorX, doorZ, inX, inZ, floorY) {
  ENTERABLES.push({ name: name, doorX: doorX, doorZ: doorZ,
    inX: inX, inZ: inZ, floorY: floorY, roofs: [] });
  return ENTERABLES.length - 1;
}

/* Proximity check — called from updateActionButton() in index.html */
/* Universal-action-button integration: inside a location near its inside
   spot -> offer 'exit-loc'; outside near a door (5u) -> offer 'enter-loc:<i>'.
   No-op while driving. Returns null when nothing is near. */
function spCheckEnterables() {
  if (typeof player === 'undefined' || car.driving) return null;
  var i, e, d;
  if (player.inside && player.locIdx >= 0) {
    e = ENTERABLES[player.locIdx];
    d = Math.hypot(player.x - e.inX, player.z - e.inZ);
    if (d < 6) return { act: 'exit-loc', label: 'EXIT ' + e.name };
    return null;
  }
  if (!player.inside) {
    for (i = 0; i < ENTERABLES.length; i++) {
      e = ENTERABLES[i];
      d = Math.hypot(player.x - e.doorX, player.z - e.doorZ);
      if (d < 5) return { act: 'enter-loc:' + i, label: 'ENTER ' + e.name };
    }
  }
  return null;
}

/* Enter a location: teleport the player to its inside spot, mark inside,
   hide its roofs (see-through while interior), and log. */
function spDoEnter(idx) {
  var e = ENTERABLES[idx];
  if (!e) return;
  player.x = e.inX; player.z = e.inZ;
  player.inside = true; player.locIdx = idx; player.locFloorY = e.floorY;
  e.roofs.forEach(function(r){ r.visible = false; });
  setDrivingUI(false);
  try { Report.note('enter-loc', { name: e.name }); } catch (err) {}
}

/* Exit the current location: teleport the player to the door spot, nudged
   2.5u outward so they don't instantly re-trigger entry; restore roofs. */
function spDoExit() {
  var e = ENTERABLES[player.locIdx];
  if (e) {
    player.x = e.doorX; player.z = e.doorZ;
    var dx = e.doorX - e.inX, dz = e.doorZ - e.inZ;
    var d = Math.hypot(dx, dz) || 1;
    player.x += dx / d * 2.5; player.z += dz / d * 2.5;
    e.roofs.forEach(function(r){ r.visible = true; });
  }
  player.inside = false; player.locIdx = -1; player.locFloorY = 0;
  setDrivingUI(false);
  try { Report.note('exit-loc', {}); } catch (err) {}
}

/* ---------- small builders ---------- */
/* Wall from (x1,z1) to (x2,z2), height h, base at gy, colored. gaps =
   [{at, w}] door/window openings measured along the wall from the start;
   the wall is split into solid segments around them. Each segment gets a
   box mesh + segment collider. */
function spWall(x1, z1, x2, z2, h, color, gy, gaps) {
  var len = Math.hypot(x2 - x1, z2 - z1);
  if (len < 0.01) return;
  var dx = (x2 - x1) / len, dz = (z2 - z1) / len;
  var segs = [[0, len]];
  (gaps || []).forEach(function(g) {
    var next = [];
    segs.forEach(function(s) {
      var g0 = g.at - g.w / 2, g1 = g.at + g.w / 2;
      if (g1 <= s[0] || g0 >= s[1]) { next.push(s); return; }
      if (g0 > s[0]) next.push([s[0], g0]);
      if (g1 < s[1]) next.push([g1, s[1]]);
    });
    segs = next;
  });
  segs.forEach(function(s) {
    if (s[1] - s[0] < 0.3) return;
    var ax = x1 + dx * s[0], az = z1 + dz * s[0];
    var bx = x1 + dx * s[1], bz = z1 + dz * s[1];
    var w = Math.abs(bx - ax) || 0.25, d = Math.abs(bz - az) || 0.25;
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color: color }));
    m.position.set((ax + bx) / 2, gy + h / 2, (az + bz) / 2);
    scene.add(m);
    addSegCollider(ax, az, bx, bz);
  });
}

/* Flat floor slab (0.3 thick) at gy+yOff. Returns the mesh (callers use it
   for roofs or hide-on-entry). */
function spSlab(x, z, w, d, color, gy, yOff) {
  var m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d),
    new THREE.MeshLambertMaterial({ color: color }));
  m.position.set(x, gy + (yOff || 0.15), z);
  scene.add(m);
  return m;
}

/* Roof slab (slight overhang) at gy+h+0.2. Returned so enterables can hide
   it while the player is inside. */
function spRoof(x, z, w, d, color, gy, h) {
  var m = new THREE.Mesh(new THREE.BoxGeometry(w + 1, 0.4, d + 1),
    new THREE.MeshLambertMaterial({ color: color }));
  m.position.set(x, gy + h + 0.2, z);
  scene.add(m);
  return m;
}

/* Canvas-text sign board: white text on bgColor, auto-sized by width w.
   faceWest=true rotates it to face -x (west); otherwise faces +z. */
function spSignBoard(text, x, y, z, w, bgColor, faceWest) {
  var cv = document.createElement('canvas'); cv.width = 512; cv.height = 64;
  var c = cv.getContext('2d');
  c.fillStyle = bgColor || '#1a3a6b'; c.fillRect(0, 0, 512, 64);
  c.fillStyle = '#ffffff'; c.font = 'bold 38px Arial';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, 256, 34);
  var tex = new THREE.CanvasTexture(cv);
  var m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 64 / 512),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  m.position.set(x, y, z);
  if (faceWest) m.rotation.y = -Math.PI / 2;
  scene.add(m);
  return m;
}

/* Asphalt lot slab with nRows of painted parking-space lines (~3.2u per
   space). Pure visual — no colliders on the lines. */
function spParkingLot(cx, cz, w, d, gy, nRows) {
  spSlab(cx, cz, w, d, 0x3a3a3e, gy, 0.1);
  var lineMat = new THREE.MeshBasicMaterial({ color: 0xcccccc });
  var spaces = Math.floor(w / 3.2);
  for (var r = 0; r < (nRows || 2); r++) {
    var rz = cz - d / 2 + 4 + r * ((d - 8) / Math.max(1, (nRows || 2) - 1 || 1));
    for (var s = 0; s <= spaces; s++) {
      var line = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.06, 5), lineMat);
      line.position.set(cx - w / 2 + s * 3.2, gy + 0.28, rz);
      scene.add(line);
    }
  }
}

/* Classroom desk (box + collider). */
function spDesk(x, z, gy) {
  var m = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.75, 0.6),
    new THREE.MeshLambertMaterial({ color: 0x7a5a3a }));
  m.position.set(x, gy + 0.55, z); scene.add(m);
  addCollider(x, z, 0.8);
}

/* Store shelf (1.8 tall), oriented along x (alongX=true) or z, with a
   collider sized to its footprint. */
function spShelf(x, z, len, gy, alongX) {
  var w = alongX ? len : 0.9, d = alongX ? 0.9 : len;
  var m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.8, d),
    new THREE.MeshLambertMaterial({ color: 0x8a6a3a }));
  m.position.set(x, gy + 1.05, z); scene.add(m);
  addCollider(x, z, Math.max(w, d) / 2 + 0.4);
}

/* ============================================================================
   HARPER ARCHER HIGH SCHOOL
   Campus: x 4010-4110 (E of Fairburn Rd NW, W of I-285), z 2436-2637
   (N of Collier Dr NW). Front faces SOUTH (+z) toward Collier Dr.
   ============================================================================ */
(function buildHarperArcher() {
  var brick = 0x9d5f43, trim = 0xf2ede2, roofC = 0x4a3a2e, inC = 0xe8dcc0;

  /* ---- main building: center (4060, 2595), 76 x 32, 9u (2 stories) ---- */
  var cx = 4060, cz = 2595;
  /* v2.0 auto-check: nudge clear of roads if needed (never on road) */
  try{ var _sp=placeStruct(cx,cz,41,4,'HarperArcherHS'); if(_sp){cx=_sp.x;cz=_sp.z;} }catch(e){}
  var gy = heightAt(cx, cz);
  var x0 = cx - 38, x1 = cx + 38, z0 = cz - 16, z1 = cz + 16;
  spWall(x0, z1, x1, z1, 9, brick, gy, [{ at: 38, w: 5 }]);  // front + entrance
  spWall(x0, z0, x1, z0, 9, brick, gy, []);                  // back
  spWall(x0, z0, x0, z1, 9, brick, gy, []);                  // west
  spWall(x1, z0, x1, z1, 9, brick, gy, []);                  // east
  spSlab(cx, cz, 76, 32, 0xb8a888, gy, 0.15);
  var roof = spRoof(cx, cz, 76, 32, roofC, gy, 9);
  var trimB = new THREE.Mesh(new THREE.BoxGeometry(76, 0.6, 0.3),
    new THREE.MeshLambertMaterial({ color: trim }));
  trimB.position.set(cx, gy + 7.5, z1 + 0.15); scene.add(trimB);
  spSignBoard('HARPER ARCHER HIGH SCHOOL', cx, gy + 8.3, z1 + 0.35, 38, '#1a3a6b', false);

  /* ---- interior: lobby + E-W hall + classrooms ---- */
  var hz0 = cz - 3, hz1 = cz + 3;
  spWall(cx - 30, hz0, cx + 30, hz0, 3.2, inC, gy,
    [{ at: 10, w: 2.2 }, { at: 30, w: 2.2 }, { at: 50, w: 2.2 }]);   // N wall, 3 doors
  spWall(cx - 30, hz1, cx - 6, hz1, 3.2, inC, gy, [{ at: 12, w: 2.2 }]);
  spWall(cx + 6, hz1, cx + 30, hz1, 3.2, inC, gy, [{ at: 12, w: 2.2 }]);
  spWall(cx - 30, hz0, cx - 30, hz1, 3.2, inC, gy, []);
  spWall(cx + 30, hz0, cx + 30, hz1, 3.2, inC, gy, []);
  // north classroom dividers + desks
  [0, 1].forEach(function(ri) {
    var divX = cx - 10 + ri * 20;
    spWall(divX, z0 + 0.3, divX, hz0, 3.2, inC, gy, []);
  });
  [[-30, -10], [-10, 10], [10, 30]].forEach(function(r) {
    for (var dx = 0; dx < 3; dx++) for (var dz = 0; dz < 2; dz++)
      spDesk(cx + r[0] + 4 + dx * 5, z0 + 5 + dz * 4, gy);
  });
  // south classroom dividers + desks (flank lobby)
  spWall(cx - 6, hz1, cx - 6, z1 - 0.3, 3.2, inC, gy, []);
  spWall(cx + 6, hz1, cx + 6, z1 - 0.3, 3.2, inC, gy, []);
  [[-30, -6], [6, 30]].forEach(function(r) {
    for (var dx = 0; dx < 3; dx++) for (var dz = 0; dz < 2; dz++)
      spDesk(cx + r[0] + 3 + dx * 5, hz1 + 4 + dz * 4, gy);
  });
  // lobby trophy case
  var tc = new THREE.Mesh(new THREE.BoxGeometry(4, 1.5, 1),
    new THREE.MeshLambertMaterial({ color: 0x6a4a2a }));
  tc.position.set(cx - 4, gy + 0.9, z1 - 3); scene.add(tc);
  addCollider(cx - 4, z1 - 3, 2.2);

  var idx = spRegisterEnterable('HARPER ARCHER HIGH SCHOOL', cx, z1 + 1.5, cx, z1 - 4, gy + 0.25);
  ENTERABLES[idx].roofs.push(roof);
  // door blocker: seal the door gap so player must use EXIT command
  addSegCollider(cx - 2.8, z1, cx + 2.8, z1);

  /* ---- gym: (4045, 2530), 36 x 28, enterable ---- */
  var gx = 4045, gz = 2530, ggy = heightAt(gx, gz);
  var ggx0 = gx - 18, ggx1 = gx + 18, ggz0 = gz - 14, ggz1 = gz + 14;
  spWall(ggx0, ggz1, ggx1, ggz1, 8, brick, ggy, []);
  spWall(ggx0, ggz0, ggx1, ggz0, 8, brick, ggy, []);
  spWall(ggx0, ggz0, ggx0, ggz1, 8, brick, ggy, []);
  spWall(ggx1, ggz0, ggx1, ggz1, 8, brick, ggy, [{ at: 14, w: 4 }]); // east doors
  spSlab(gx, gz, 36, 28, 0xc8a86a, ggy, 0.15);
  var groof = spRoof(gx, gz, 36, 28, roofC, ggy, 8);
  var hoopM = new THREE.MeshBasicMaterial({ color: 0xcc4422 });
  [[ggx0 + 4, gz], [ggx1 - 4, gz]].forEach(function(p) {
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 3.5, 8),
      new THREE.MeshLambertMaterial({ color: 0x888888 }));
    pole.position.set(p[0], ggy + 1.75, p[1]); scene.add(pole);
    var rim = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.08, 8, 16), hoopM);
    rim.position.set(p[0], ggy + 3.2, p[1]); rim.rotation.x = Math.PI / 2; scene.add(rim);
    addCollider(p[0], p[1], 0.7);
  });
  for (var b = 0; b < 2; b++) {
    var bl = new THREE.Mesh(new THREE.BoxGeometry(24, 0.8 + b * 0.8, 1.2),
      new THREE.MeshLambertMaterial({ color: 0x5a6a8a }));
    bl.position.set(gx, ggy + 0.6 + b * 0.8, ggz0 + 2 + b * 1.4); scene.add(bl);
  }
  addCollider(gx, ggz0 + 3, 13);
  spSignBoard('GYMNASIUM', gx, ggy + 6.5, ggz1 + 0.3, 16, '#2a6b2a', false);
  var gidx = spRegisterEnterable('SCHOOL GYM', ggx1 + 1.5, gz, ggx1 - 4, gz, ggy + 0.25);
  ENTERABLES[gidx].roofs.push(groof);
  // door blocker: seal the east door gap
  addSegCollider(ggx1, gz - 2.3, ggx1, gz + 2.3);

  /* ---- cafeteria: (4092, 2528), 28 x 24, enterable ---- */
  var fx = 4092, fz = 2528, fgy = heightAt(fx, fz);
  var ffx0 = fx - 14, ffx1 = fx + 14, ffz0 = fz - 12, ffz1 = fz + 12;
  spWall(ffx0, ffz1, ffx1, ffz1, 6, brick, fgy, []);
  spWall(ffx0, ffz0, ffx1, ffz0, 6, brick, fgy, []);
  spWall(ffx0, ffz0, ffx0, ffz1, 6, brick, fgy, [{ at: 12, w: 4 }]); // west doors
  spWall(ffx1, ffz0, ffx1, ffz1, 6, brick, fgy, []);
  spSlab(fx, fz, 28, 24, 0xd8ccb0, fgy, 0.15);
  var froof = spRoof(fx, fz, 28, 24, roofC, fgy, 6);
  for (var tx = 0; tx < 3; tx++) for (var tz = 0; tz < 2; tz++) {
    var tbl = new THREE.Mesh(new THREE.BoxGeometry(3, 0.8, 1.5),
      new THREE.MeshLambertMaterial({ color: 0xcccccc }));
    var txp = ffx0 + 5 + tx * 8, tzp = ffz0 + 6 + tz * 10;
    tbl.position.set(txp, fgy + 0.55, tzp); scene.add(tbl);
    addCollider(txp, tzp, 2);
  }
  var ctr = new THREE.Mesh(new THREE.BoxGeometry(14, 1.1, 1.2),
    new THREE.MeshLambertMaterial({ color: 0x9a9a9a }));
  ctr.position.set(fx, fgy + 0.7, ffz0 + 2); scene.add(ctr);
  addCollider(fx, ffz0 + 2, 7.5);
  var fidx = spRegisterEnterable('SCHOOL CAFETERIA', ffx0 - 1.5, fz, ffx0 + 4, fz, fgy + 0.25);
  ENTERABLES[fidx].roofs.push(froof);
  // door blocker: seal the west door gap
  addSegCollider(ffx0, fz - 2.3, ffx0, fz + 2.3);

  /* ---- parking lot (south of main, north of Collier Dr) ---- */
  spParkingLot(4060, 2625, 60, 24, heightAt(4060, 2625), 2);
  spSlab(4060, 2640, 10, 10, 0x3a3a3e, heightAt(4060, 2640), 0.1); // driveway to Collier

  /* ---- football field (4030->4060, 2460), 80 x 48 ---- */
  var fldx = 4060, fldz = 2460, fldgy = heightAt(fldx, fldz);
  spSlab(fldx, fldz, 80, 48, 0x3d7a3d, fldgy, 0.08);
  var wlM = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
  for (var yl = -20; yl <= 20; yl += 10) {
    var ylM = new THREE.Mesh(new THREE.BoxGeometry(40, 0.06, 0.4), wlM);
    ylM.position.set(fldx, fldgy + 0.25, fldz + yl); scene.add(ylM);
  }
  [[fldx, fldz - 22], [fldx, fldz + 22]].forEach(function(p) {
    var gp = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 6, 8),
      new THREE.MeshLambertMaterial({ color: 0xddbb33 }));
    gp.position.set(p[0], fldgy + 3, p[1]); scene.add(gp);
    var cross = new THREE.Mesh(new THREE.BoxGeometry(5, 0.3, 0.3),
      new THREE.MeshLambertMaterial({ color: 0xddbb33 }));
    cross.position.set(p[0], fldgy + 5.5, p[1]); scene.add(cross);
  });
  for (var sb = 0; sb < 3; sb++) {
    var st = new THREE.Mesh(new THREE.BoxGeometry(2, 0.8 + sb * 0.9, 32),
      new THREE.MeshLambertMaterial({ color: 0x5a6a8a }));
    st.position.set(fldx + 44 + sb * 2.2, fldgy + 0.5 + sb * 0.9, fldz);
    scene.add(st);
  }
  addCollider(fldx + 46, fldz, 20);

  /* ---- flag pole + sidewalk ---- */
  var fp = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 12, 8),
    new THREE.MeshLambertMaterial({ color: 0xcccccc }));
  fp.position.set(cx - 20, gy + 6, z1 + 8); scene.add(fp);
  addCollider(cx - 20, z1 + 8, 0.5);
  spSlab(cx, 2618, 6, 12, 0x9a9a9a, heightAt(cx, 2618), 0.12);

  labelAt('HARPER ARCHER HIGH SCHOOL', cx, cz, 22, 60, '#ffd75e');
  addCollider(cx, cz, 40);
})();

/* ============================================================================
   SHOPS AT CASCADE — Cascade Rd & Fairburn Rd SW
   East of Fairburn Rd SW (left heading south), NORTH of Cascade Rd.
   Building: (3750, 4297), 24 x 96. Storefronts face WEST (-x).
   Clear of: Fairburn Rd SW, Cascade Rd, Research Center Dr SW,
   Utoy Springs Rd SW (all verified).
   Real anchor: Walgreens. 10 storefronts.
   ============================================================================ */
(function buildCascadePlaza() {
  var cx = 3750, cz = 4297;
  /* v2.0 auto-check: nudge clear of roads if needed (never on road) */
  try{ var _sp2=placeStruct(cx,cz,50,4,'ShopsAtCascade'); if(_sp2){cx=_sp2.x;cz=_sp2.z;} }catch(e){}
  var gy = heightAt(cx, cz);
  var wallC = 0xb09a78, roofC = 0x3a3a3e, H = 7;
  var px0 = cx - 12, px1 = cx + 12;      // 3738 - 3762
  var pz0 = cz - 48, pz1 = cz + 48;      // 4249 - 4345

  var stores = [
    { name: 'WALGREENS', w: 24, enter: true, color: '#cc2222' },
    { name: "MOE'S", w: 8, enter: true, color: '#2a8a3a' },
    { name: 'NAIL SALON', w: 8, enter: false, color: '#aa44aa' },
    { name: 'BARBER', w: 8, enter: false, color: '#224488' },
    { name: 'DOLLAR STORE', w: 8, enter: true, color: '#228822' },
    { name: 'PIZZA', w: 8, enter: false, color: '#cc6622' },
    { name: 'DRY CLEANER', w: 8, enter: false, color: '#4488aa' },
    { name: 'CELL PHONES', w: 8, enter: false, color: '#6633aa' },
    { name: 'BAKERY', w: 8, enter: false, color: '#aa7722' },
    { name: 'SUBS', w: 8, enter: false, color: '#882222' },
  ];
  // 24 + 8*9 = 96 = pz1-pz0. 

  spWall(px0, pz0, px1, pz0, H, wallC, gy, []);   // north
  spWall(px0, pz1, px1, pz1, H, wallC, gy, []);   // south
  spWall(px1, pz0, px1, pz1, H, wallC, gy, []);   // east (back)
  var plazaRoof = spRoof(cx, cz, 24, 96, roofC, gy, H);
  spSlab(cx, cz, 24, 96, 0xc8b898, gy, 0.15);

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
      var gm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 3.5, gw), glassM);
      gm.position.set(px0, gy + 2.2, (sg[0] + sg[1]) / 2);
      scene.add(gm);
    });
    spSignBoard(st.name, px0 - 0.4, gy + 5.6, zM, Math.min(st.w - 1, 18), st.color, true);

    if (st.enter) {
      var inX = px0 + 6, inZ = zM;
      if (st.name === 'WALGREENS') {
        for (var a = 0; a < 3; a++) {
          spShelf(inX - 2 + a * 4, inZ - 4, 9, gy, false);
          spShelf(inX - 2 + a * 4, inZ + 4, 9, gy, false);
        }
        var pc = new THREE.Mesh(new THREE.BoxGeometry(8, 1.1, 1.5),
          new THREE.MeshLambertMaterial({ color: 0xdddddd }));
        pc.position.set(px1 - 4, gy + 0.7, inZ); scene.add(pc);
        addCollider(px1 - 4, inZ, 4.5);
      } else if (st.name === "MOE'S") {
        var mc = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 6),
          new THREE.MeshLambertMaterial({ color: 0x8a4a2a }));
        mc.position.set(px1 - 3, gy + 0.7, inZ); scene.add(mc);
        addCollider(px1 - 3, inZ, 3.5);
        for (var t2 = 0; t2 < 3; t2++) {
          var tb = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.75, 1.5),
            new THREE.MeshLambertMaterial({ color: 0xcc8833 }));
          var tbz = inZ - 3 + t2 * 3;
          tb.position.set(inX - 2, gy + 0.5, tbz);
          scene.add(tb); addCollider(inX - 2, tbz, 1.1);
        }
      } else {
        for (var d2 = 0; d2 < 2; d2++) spShelf(inX, inZ - 3 + d2 * 6, 7, gy, true);
        var dc = new THREE.Mesh(new THREE.BoxGeometry(3, 1.0, 1.2),
          new THREE.MeshLambertMaterial({ color: 0xaaaaaa }));
        dc.position.set(px1 - 2.5, gy + 0.65, inZ); scene.add(dc);
        addCollider(px1 - 2.5, inZ, 2);
      }
      var ix = spRegisterEnterable(st.name, px0 - 1.5, zM, inX, inZ, gy + 0.25);
      ENTERABLES[ix].roofs.push(plazaRoof);
      // door blocker: seal the storefront door gap (gap w=3 at zM on px0 wall)
      addSegCollider(px0, zM - 1.8, px0, zM + 1.8);
    }
  });

  /* ---- parking lot (west of building) ---- */
  spParkingLot(3705, 4300, 50, 90, heightAt(3705, 4300), 3);

  /* ---- sidewalk along storefronts ---- */
  spSlab(px0 - 3, cz, 5, 100, 0x9a9a9a, heightAt(px0 - 3, cz), 0.12);

  /* ---- pylon sign near Fairburn Rd ---- */
  var pyX = 3690, pyZ = 4260, pyGy = heightAt(pyX, pyZ);
  var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 10, 8),
    new THREE.MeshLambertMaterial({ color: 0x666666 }));
  pole.position.set(pyX, pyGy + 5, pyZ); scene.add(pole);
  spSignBoard('SHOPS AT CASCADE', pyX, pyGy + 11, pyZ, 22, '#1a3a6b', true);
  addCollider(pyX, pyZ, 1);

  labelAt('SHOPS AT CASCADE', cx, cz, 20, 50, '#ffd75e');
  addCollider(cx, cz, 52);
})();

/* ---------- placement audit (logged, not blocking) ---------- */
(function spAudit() {
  try {
    Report.note('school-plaza-build', {
      enterables: ENTERABLES.length,
      names: ENTERABLES.map(function(e){ return e.name; })
    });
  } catch (e) {}
})();
