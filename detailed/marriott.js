/* ============================================================================
   MARRIOTT MARQUIS v1.0 (2026-10-09)
   Joshua's specs:
   - Atlanta Marriott Marquis, 265 Peachtree Center Ave NE — 52 stories, 169m
   - WALKABLE interior, player enters through the lobby
   - FUNCTIONAL ELEVATOR — call it, ride it, select any of 52 floors
   - ACTUAL 52 FLOORS, uniform rooms, player can ENTER ANY ROOM
   - Huge open ATRIUM (the building's signature) visible from all floors
   - Story use comes later — just space + systems now

   Performance: 52 floor slabs as ONE InstancedMesh. Only the player's
   current floor (+/-1) gets full detail (hallway walls, room doors,
   furniture). Detail rebuilt on floor change. Interior group hidden
   when player is outside.

   Depends on globals: THREE, scene, heightAt, player, car, addCollider,
   addSegCollider, colliders, segColliders, ENTERABLES, spRegisterEnterable,
   spDoEnter, spDoExit, actionBtn, setDrivingUI, Report, LANDMARKS.
   Loaded via <script src="marriott.js"> after schools3.js.
   ============================================================================ */

var MQ = {
  cx: 7801.5, cz: 2925.4,   // matches OSM_BUILDINGS entry (169m tower)
  gy: 0,
  FLOORS: 52,
  LOBBY_H: 6,
  FLOOR_H: 3.4,
  PLATE: 44,                // interior floor plate (cx +/- 22)
  ATRIUM: 18,               // atrium void (cx +/- 9)
  HALL_OUT: 12.5,           // hallway outer edge
  floor: 1,                 // player's current floor (1 = lobby)
  inElev: false,
  elev: null,               // {cab, doors, y, target, state}
  interior: null,
  exterior: null,      // always-visible group (canopy, sign)
  floorDetail: null,
  detailFloor: -1,
  doors: [],                // auto room doors on current floor {mesh, x, z, open}
  colStart: 0, segStart: 0, // collider array bookmarks
  enterIdx: -1,
  extIdx: -1,               // index in __bldgMeshes.kept
  panel: null,              // floor-select HTML
  inside: false
};

function mqFloorY(f) {
  if (f <= 1) return MQ.gy;
  return MQ.gy + MQ.LOBBY_H + (f - 2) * MQ.FLOOR_H;
}
function mqSetFloorY(f) {
  MQ.floor = f;
  var y = mqFloorY(f);
  player.locFloorY = y;
  if (MQ.enterIdx >= 0 && ENTERABLES[MQ.enterIdx])
    ENTERABLES[MQ.enterIdx].floorY = y;
  return y;
}

/* ---------- tiny builders (add to interior group) ---------- */
function mqBox(w, h, d, color, x, y, z, ry) {
  var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color: color }));
  m.position.set(x, y, z);
  if (ry) m.rotation.y = ry;
  MQ.interior.add(m);
  return m;
}
function mqWall(x1, z1, x2, z2, h, yBase, color) {
  var len = Math.hypot(x2 - x1, z2 - z1);
  if (len < 0.01) return;
  var w = Math.abs(x2 - x1) || 0.3, d = Math.abs(z2 - z1) || 0.3;
  var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color: color }));
  m.position.set((x1 + x2) / 2, yBase + h / 2, (z1 + z2) / 2);
  MQ.floorDetail.add(m);
  addSegCollider(x1, z1, x2, z2);
}
function mqCol(x, z, r) { addCollider(x, z, r); }

/* ---------- exterior: entrance + sign (always visible) ---------- */
function mqBoxExt(w, h, d, color, x, y, z) {
  var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({ color: color }));
  m.position.set(x, y, z);
  MQ.exterior.add(m);
  return m;
}
function mqBuildExterior() {
  var gy = MQ.gy, cx = MQ.cx, cz = MQ.cz;
  // entrance canopy on south face (toward Peachtree Center Ave)
  var ez = cz + 8;
  mqBoxExt(10, 0.4, 4, 0x2a2a2e, cx, gy + 3.4, ez + 1);
  mqBoxExt(0.4, 3.4, 0.4, 0x555555, cx - 4.5, gy + 1.7, ez + 2.4);
  mqBoxExt(0.4, 3.4, 0.4, 0x555555, cx + 4.5, gy + 1.7, ez + 2.4);
  // revolving-door frame (visual)
  mqBoxExt(4, 3, 0.4, 0x1a2a3a, cx, gy + 1.5, ez);
  // sign
  var cv = document.createElement('canvas'); cv.width = 512; cv.height = 64;
  var c = cv.getContext('2d');
  c.fillStyle = '#7a1f2b'; c.fillRect(0, 0, 512, 64);
  c.fillStyle = '#ffffff'; c.font = 'bold 36px Arial';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('MARRIOTT MARQUIS', 256, 34);
  var tex = new THREE.CanvasTexture(cv);
  var sign = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.75),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  sign.position.set(cx, gy + 5.2, ez + 0.3);
  MQ.exterior.add(sign);
  try { LANDMARKS.push({ x: cx, z: cz, name: 'MARRIOTT MARQUIS' }); } catch (e) {}
  // register enterable: door outside -> lobby inside
  MQ.enterIdx = spRegisterEnterable('MARRIOTT MARQUIS',
    cx, ez + 3.5,   // door (outside)
    cx, cz + 14,    // inside landing (lobby)
    gy);
  // find exterior instance to hide on entry
  try {
    var kept = window.__bldgMeshes && window.__bldgMeshes.kept;
    if (kept) {
      var best = -1, bd = 1e18;
      for (var i = 0; i < kept.length; i++) {
        var b = kept[i];
        var d = Math.hypot(b[0] - cx, b[1] - cz);
        if (b[4] > 100 && d < bd) { bd = d; best = i; }
      }
      if (best >= 0 && bd < 30) MQ.extIdx = best;
    }
  } catch (e) {}
}
function mqHideExterior(hide) {
  try {
    var bm = window.__bldgMeshes;
    if (!bm || MQ.extIdx < 0) return;
    var m4 = new THREE.Matrix4();
    if (hide) {
      m4.makeScale(0.0001, 0.0001, 0.0001);
      m4.setPosition(bm.kept[MQ.extIdx][0], -100, bm.kept[MQ.extIdx][1]);
    } else {
      var b = bm.kept[MQ.extIdx];
      var qt = new THREE.Quaternion();
      m4.compose(
        new THREE.Vector3(b[0], MQ.gy - 0.6, b[1]), qt,
        new THREE.Vector3(b[2], Math.max(2.5, b[4]), b[3]));
    }
    bm.bodies.setMatrixAt(MQ.extIdx, m4);
    bm.bodies.instanceMatrix.needsUpdate = true;
    if (bm.roofs) {
      bm.roofs.setMatrixAt(MQ.extIdx, m4);
      bm.roofs.instanceMatrix.needsUpdate = true;
    }
  } catch (e) {}
}

/* ---------- interior core: slabs, lobby, atrium ---------- */
function mqBuildInterior() {
  var gy = MQ.gy, cx = MQ.cx, cz = MQ.cz, P = MQ.PLATE, A = MQ.ATRIUM;
  MQ.interior = new THREE.Group();
  MQ.interior.visible = false;
  scene.add(MQ.interior);
  MQ.exterior = new THREE.Group();
  scene.add(MQ.exterior);

  /* 52 floor slabs as ONE InstancedMesh — each floor is 4 strips around the
     OPEN atrium void (no center slab). Floor 1 = lobby slab at gy. */
  var slabGeo = new THREE.BoxGeometry(1, 0.35, 1);
  var slabMat = new THREE.MeshLambertMaterial({ color: 0xb8a888 });
  var a = A / 2, hp = P / 2;
  // 4 strips: [cxOff, czOff, w, d]
  var strips = [
    [0, -(a + (hp - a) / 2), P, hp - a],          // north
    [0, (a + (hp - a) / 2), P, hp - a],           // south
    [-(a + (hp - a) / 2), 0, hp - a, A],          // west
    [(a + (hp - a) / 2), 0, hp - a, A]            // east
  ];
  var slabs = new THREE.InstancedMesh(slabGeo, slabMat, MQ.FLOORS * 4);
  var m4 = new THREE.Matrix4();
  var q0 = new THREE.Quaternion(), s3 = new THREE.Vector3();
  var si = 0;
  for (var f = 0; f < MQ.FLOORS; f++) {
    var sy = mqFloorY(f + 1) - 0.18;
    for (var st = 0; st < 4; st++) {
      s3.set(strips[st][2], 1, strips[st][3]);
      m4.compose(new THREE.Vector3(cx + strips[st][0], sy, cz + strips[st][1]), q0, s3);
      slabs.setMatrixAt(si++, m4);
    }
  }
  slabs.instanceMatrix.needsUpdate = true;
  MQ.interior.add(slabs);

  /* atrium railings per floor — instanced glass panels around the void */
  var railGeo = new THREE.BoxGeometry(1, 1.1, 0.12);
  var railMat = new THREE.MeshLambertMaterial({ color: 0x88aacc, transparent: true, opacity: 0.45 });
  var perSide = 8, railCount = perSide * 4 * (MQ.FLOORS - 1);
  var rails = new THREE.InstancedMesh(railGeo, railMat, railCount);
  var ri = 0, q = new THREE.Quaternion(), e = new THREE.Euler();
  var sc = new THREE.Vector3(A / perSide, 1, 1);
  for (var rf = 2; rf <= MQ.FLOORS; rf++) {
    var ry = mqFloorY(rf) + 0.55;
    for (var s = 0; s < perSide; s++) {
      var off = -a + (s + 0.5) * (A / perSide);
      // north + south
      e.set(0, 0, 0); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(cx + off, ry, cz - a), q, sc);
      rails.setMatrixAt(ri++, m4);
      m4.compose(new THREE.Vector3(cx + off, ry, cz + a), q, sc);
      rails.setMatrixAt(ri++, m4);
      // east + west (rotated)
      e.set(0, Math.PI / 2, 0); q.setFromEuler(e);
      m4.compose(new THREE.Vector3(cx - a, ry, cz + off), q, sc);
      rails.setMatrixAt(ri++, m4);
      m4.compose(new THREE.Vector3(cx + a, ry, cz + off), q, sc);
      rails.setMatrixAt(ri++, m4);
    }
  }
  rails.instanceMatrix.needsUpdate = true;
  MQ.interior.add(rails);

  /* lobby (floor 1): front desk, seating, plants, atrium plantings */
  var lobbyC = 0xd8cbb0, accent = 0x7a1f2b;
  // front desk (south side)
  mqBox(8, 1.1, 1.6, 0x6a4a2a, cx, gy + 0.55, cz + 16);
  mqBox(8.4, 0.15, 2, 0x2a2a2e, cx, gy + 1.15, cz + 16);
  mqCol(cx, cz + 16, 4.5);
  // desk sign
  (function() {
    var cv2 = document.createElement('canvas'); cv2.width = 256; cv2.height = 48;
    var c2 = cv2.getContext('2d');
    c2.fillStyle = '#7a1f2b'; c2.fillRect(0, 0, 256, 48);
    c2.fillStyle = '#fff'; c2.font = 'bold 28px Arial';
    c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.fillText('FRONT DESK', 128, 26);
    var t2 = new THREE.CanvasTexture(cv2);
    var s2 = new THREE.Mesh(new THREE.PlaneGeometry(5, 0.95),
      new THREE.MeshBasicMaterial({ map: t2, side: THREE.DoubleSide }));
    s2.position.set(cx, gy + 2.1, cz + 16); MQ.interior.add(s2);
  })();
  // seating clusters
  [[-12, 8], [12, 8], [-12, -2], [12, -2]].forEach(function(p) {
    mqBox(3, 0.5, 1.2, accent, cx + p[0], gy + 0.45, cz + p[1]);
    mqBox(3, 1.1, 0.3, accent, cx + p[0], gy + 0.75, cz + p[1] - 0.75);
    mqBox(1.2, 0.45, 1.2, 0x8a7a5a, cx + p[0] + 2.4, gy + 0.35, cz + p[1]);
    mqCol(cx + p[0], cz + p[1], 2);
  });
  // atrium trees (planters in the open void)
  [[-5, -5], [5, -5], [-5, 5], [5, 5]].forEach(function(p) {
    mqBox(1.6, 0.8, 1.6, 0x5a4a3a, cx + p[0], gy + 0.4, cz + p[1]);
    var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 3, 6),
      new THREE.MeshLambertMaterial({ color: 0x6a4a2a }));
    trunk.position.set(cx + p[0], gy + 2.2, cz + p[1]); MQ.interior.add(trunk);
    var top = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 6),
      new THREE.MeshLambertMaterial({ color: 0x3a7a3a }));
    top.position.set(cx + p[0], gy + 4.4, cz + p[1]); MQ.interior.add(top);
    mqCol(cx + p[0], cz + p[1], 1.1);
  });
  // hanging atrium lights (visual only, spaced up the void)
  for (var ly = 0; ly < 8; ly++) {
    var lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffeebb }));
    lamp.position.set(cx + (ly % 2 ? 4 : -4), gy + 10 + ly * 18, cz);
    MQ.interior.add(lamp);
  }
  // lobby walls (outer shell, with south entrance gap)
  var lw = P / 2, lh = MQ.LOBBY_H;
  mqLobbyWall(cx - lw, cz - lw, cx + lw, cz - lw, lh, gy);           // north
  mqLobbyWall(cx - lw, cz + lw, cx - 2.5, cz + lw, lh, gy);          // south L
  mqLobbyWall(cx + 2.5, cz + lw, cx + lw, cz + lw, lh, gy);          // south R
  mqLobbyWall(cx - lw, cz - lw, cx - lw, cz + lw, lh, gy);           // west
  mqLobbyWall(cx + lw, cz - lw, cx + lw, cz + lw, lh, gy);           // east

  /* roof slab over floor 52 + skylight over atrium */
  var roofY = mqFloorY(52) + MQ.FLOOR_H;
  mqBox(P, 0.5, P, 0x4a3a2e, cx, roofY + 0.25, cz);
  mqBox(A - 1, 0.2, A - 1, 0x99ccff, cx, roofY + 0.1, cz);  // skylight
}
function mqLobbyWall(x1, z1, x2, z2, h, gy) {
  var len = Math.hypot(x2 - x1, z2 - z1);
  var m = new THREE.Mesh(
    new THREE.BoxGeometry(Math.abs(x2 - x1) || 0.4, h, Math.abs(z2 - z1) || 0.4),
    new THREE.MeshLambertMaterial({ color: 0xc8b898 }));
  m.position.set((x1 + x2) / 2, gy + h / 2, (z1 + z2) / 2);
  MQ.interior.add(m);
  // lobby colliders persist (floor 1 always built)
  addSegCollider(x1, z1, x2, z2);
  MQ.lobbySegs = MQ.lobbySegs || [];
  MQ.lobbySegs.push({ x1: x1, z1: z1, x2: x2, z2: z2 });
}

/* ---------- elevator: glass cab on north atrium edge ---------- */
function mqBuildElevator() {
  var gy = MQ.gy, cx = MQ.cx, cz = MQ.cz, a = MQ.ATRIUM / 2;
  var ex = cx, ez = cz - 16;   // north room zone; lobby alcove in front
  var topY = mqFloorY(52) + MQ.FLOOR_H;

  // shaft frame (4 corner posts, full height) — glass cab visible
  var postMat = new THREE.MeshLambertMaterial({ color: 0x555560 });
  [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]].forEach(function(p) {
    var post = new THREE.Mesh(new THREE.BoxGeometry(0.35, topY - gy, 0.35), postMat);
    post.position.set(ex + p[0], gy + (topY - gy) / 2, ez + p[1]);
    MQ.interior.add(post);
  });
  // shaft back wall (north side solid)
  var bw = new THREE.Mesh(new THREE.BoxGeometry(3.8, topY - gy, 0.3),
    new THREE.MeshLambertMaterial({ color: 0x8a8078 }));
  bw.position.set(ex, gy + (topY - gy) / 2, ez - 1.8);
  MQ.interior.add(bw);

  // landing doors for every floor (visual, instanced — 2 panels each)
  // doors face SOUTH (toward hallway), at shaft south face
  var doorGeo = new THREE.BoxGeometry(1.4, 2.6, 0.15);
  var doorMat = new THREE.MeshLambertMaterial({ color: 0x9aa0a8 });
  var landDoors = new THREE.InstancedMesh(doorGeo, doorMat, MQ.FLOORS * 2);
  var m4 = new THREE.Matrix4(), q0 = new THREE.Quaternion(),
      s1 = new THREE.Vector3(1, 1, 1), di = 0;
  for (var f = 1; f <= MQ.FLOORS; f++) {
    var dy = mqFloorY(f) + 1.3;
    m4.compose(new THREE.Vector3(ex - 0.72, dy, ez + 1.75), q0, s1);
    landDoors.setMatrixAt(di++, m4);
    m4.compose(new THREE.Vector3(ex + 0.72, dy, ez + 1.75), q0, s1);
    landDoors.setMatrixAt(di++, m4);
  }
  landDoors.instanceMatrix.needsUpdate = true;
  MQ.interior.add(landDoors);

  // the cab: glass box + frame + ceiling light
  var cab = new THREE.Group();
  var glass = new THREE.MeshLambertMaterial({
    color: 0xaaccdd, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
  var cg = new THREE.BoxGeometry(3, 2.9, 3);
  var cabGlass = new THREE.Mesh(cg, glass);
  cabGlass.position.y = 1.45; cab.add(cabGlass);
  var frame = new THREE.MeshLambertMaterial({ color: 0x8a7a3a });
  var cTop = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.25, 3.2), frame);
  cTop.position.y = 3.0; cab.add(cTop);
  var cBot = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.25, 3.2), frame);
  cBot.position.y = 0.12; cab.add(cBot);
  var cLight = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ color: 0xfff2cc }));
  cLight.rotation.x = Math.PI / 2; cLight.position.y = 2.86; cab.add(cLight);
  // cab doors (slide)
  var cabDoorMat = new THREE.MeshLambertMaterial({ color: 0xb0b6be });
  var doorL = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.6, 0.12), cabDoorMat);
  doorL.position.set(-0.72, 1.42, 1.5); cab.add(doorL);
  var doorR = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.6, 0.12), cabDoorMat);
  doorR.position.set(0.72, 1.42, 1.5); cab.add(doorR);
  cab.position.set(ex, gy, ez);
  MQ.interior.add(cab);

  MQ.elev = {
    x: ex, z: ez, cab: cab, doorL: doorL, doorR: doorR,
    y: gy, targetY: gy, floor: 1,
    state: 'idle',      // idle | moving | doors
    doorT: 0,           // 0 closed .. 1 open
    wantOpen: false,
    callFloor: -1
  };
  // call button pedestal in lobby + on each floor (visual)
  MQ.callBtn = { x: ex + 2.6, z: ez + 1.2 };
}

/* elevator per-frame update */
function mqUpdateElevator(dt) {
  var E = MQ.elev;
  if (!E || !MQ.inside) return;
  var speed = 9;  // u/s — fast enough for 52 floors, not nauseating
  if (E.state === 'moving') {
    var d = E.targetY - E.y;
    var step = Math.sign(d) * Math.min(Math.abs(d), speed * dt);
    E.y += step;
    E.cab.position.y = E.y;
    if (MQ.inElev) mqSetFloorY(E.floor);  // ride: player follows cab
    if (Math.abs(d) < 0.05) {
      E.y = E.targetY; E.cab.position.y = E.y;
      E.state = 'doors'; E.wantOpen = true;
      try { mqToast('DING — FLOOR ' + E.floor); } catch (e) {}
    }
  }
  // doors animate
  var want = (E.state === 'doors' && E.wantOpen) ? 1 : 0;
  E.doorT += Math.sign(want - E.doorT) * Math.min(1, Math.abs(want - E.doorT) / 0.8 * dt * 2);
  E.doorT = Math.max(0, Math.min(1, E.doorT));
  E.doorL.position.x = -0.72 - E.doorT * 1.3;
  E.doorR.position.x = 0.72 + E.doorT * 1.3;
  if (E.state === 'doors' && E.wantOpen && E.doorT >= 0.99) {
    // doors fully open — hold briefly, then close if player not interacting
    E.holdT = (E.holdT || 0) + dt;
    if (E.holdT > 6 && !MQ.inElev) { E.wantOpen = false; E.holdT = 0; }
  }
  if (E.state === 'doors' && !E.wantOpen && E.doorT <= 0.01) {
    E.state = 'idle';
    if (E.callFloor > 0 && E.callFloor !== E.floor) {
      mqSendElevator(E.callFloor); E.callFloor = -1;
    }
  }
}
function mqSendElevator(floor) {
  var E = MQ.elev;
  E.floor = floor;
  E.targetY = mqFloorY(floor);
  E.state = 'moving';
  E.wantOpen = false; E.holdT = 0;
}
function mqToast(msg) {
  try {
    var t = document.getElementById('toast');
    if (t) { t.textContent = msg; t.style.opacity = 1;
      setTimeout(function(){ t.style.opacity = 0; }, 1800); }
  } catch (e) {}
}

/* ---------- floor-select panel (HTML) ---------- */
function mqBuildPanel() {
  var p = document.createElement('div');
  p.id = 'mq-panel';
  p.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
    'background:rgba(20,20,26,0.94);border:2px solid #8a7a3a;border-radius:10px;' +
    'padding:12px;display:none;z-index:60;max-width:92vw;';
  var title = document.createElement('div');
  title.textContent = 'MARRIOTT MARQUIS — SELECT FLOOR';
  title.style.cssText = 'color:#e8d9a0;text-align:center;font:bold 14px Arial;margin-bottom:8px;';
  p.appendChild(title);
  var grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(8,44px);gap:5px;max-height:44vh;overflow-y:auto;';
  for (var f = 1; f <= 52; f++) {
    (function(fl) {
      var b = document.createElement('button');
      b.textContent = fl;
      b.style.cssText = 'padding:8px 0;background:#3a3a44;color:#fff;border:1px solid #666;' +
        'border-radius:5px;font:bold 13px Arial;';
      b.addEventListener('click', function() {
        mqRideTo(fl);
      });
      grid.appendChild(b);
    })(f);
  }
  p.appendChild(grid);
  var cancel = document.createElement('button');
  cancel.textContent = 'CLOSE';
  cancel.style.cssText = 'display:block;margin:10px auto 0;padding:8px 30px;background:#7a1f2b;' +
    'color:#fff;border:none;border-radius:5px;font:bold 13px Arial;';
  cancel.addEventListener('click', function() { mqHidePanel(); });
  p.appendChild(cancel);
  document.body.appendChild(p);
  MQ.panel = p;
}
function mqShowPanel() { if (MQ.panel) MQ.panel.style.display = 'block'; }
function mqHidePanel() { if (MQ.panel) MQ.panel.style.display = 'none'; }
function mqRideTo(floor) {
  mqHidePanel();
  if (floor === MQ.elev.floor) {
    MQ.elev.wantOpen = false; // close doors, stay
    MQ.elev.state = 'doors';
    return;
  }
  mqToast('FLOOR ' + floor + ' — GOING ' + (floor > MQ.elev.floor ? 'UP' : 'DOWN'));
  mqSendElevator(floor);
}

/* ---------- floor detail: hallway + rooms (rebuilt per floor) ---------- */
var MQ_ROOM_TEMPLATE = null;
function mqMakeRoomTemplate() {
  var g = new THREE.Group();
  var mat = function(c) { return new THREE.MeshLambertMaterial({ color: c }); };
  // bed (queen)
  var bed = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.55, 2.6), mat(0x8a2a2a));
  bed.position.set(-1.2, 0.45, -2.2); g.add(bed);
  var blanket = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.18, 1.6), mat(0xd8cbb0));
  blanket.position.set(-1.2, 0.72, -1.8); g.add(blanket);
  [[-1.9], [-0.5]].forEach(function(o) {
    var pil = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.18, 0.4), mat(0xffffff));
    pil.position.set(-1.2 + o[0] + 1.2, 0.78, -3.2); g.add(pil);
  });
  // headboard
  var hb = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.1, 0.15), mat(0x6a4a2a));
  hb.position.set(-1.2, 0.7, -3.55); g.add(hb);
  // nightstands
  [[-2.7], [0.3]].forEach(function(o) {
    var ns = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat(0x6a4a2a));
    ns.position.set(o[0], 0.3, -3.2); g.add(ns);
    var lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 0.35, 8), mat(0xffeebb));
    lamp.position.set(o[0], 0.78, -3.2); g.add(lamp);
  });
  // TV on wall
  var tv = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 0.12), mat(0x1a1a1a));
  tv.position.set(1.8, 1.7, -3.6); g.add(tv);
  // desk + chair
  var desk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.8), mat(0x6a4a2a));
  desk.position.set(2.2, 0.75, 2.8); g.add(desk);
  [[-0.7], [0.7]].forEach(function(o) {
    var leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.75, 0.08), mat(0x4a3a2a));
    leg.position.set(2.2 + o[0], 0.38, 2.8); g.add(leg);
  });
  var chair = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.9, 0.55), mat(0x3a5a7a));
  chair.position.set(2.2, 0.45, 1.9); g.add(chair);
  // bathroom alcove (NE corner): toilet + sink
  var bath = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 0.18), mat(0xe8e8e8));
  bath.position.set(2.0, 1.3, -1.2); bath.rotation.y = Math.PI / 2; g.add(bath);
  var toilet = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 0.7), mat(0xffffff));
  toilet.position.set(2.6, 0.35, -2.2); g.add(toilet);
  var tank = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.25), mat(0xffffff));
  tank.position.set(2.6, 0.7, -2.6); g.add(tank);
  var sink = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.15, 0.55), mat(0xffffff));
  sink.position.set(2.6, 0.85, -0.9); g.add(sink);
  var ped = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.8, 0.3), mat(0xdddddd));
  ped.position.set(2.6, 0.4, -0.9); g.add(ped);
  // window frame on outer wall (north)
  var winF = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 0.15), mat(0x8a8078));
  winF.position.set(0, 1.7, -4.55); g.add(winF);
  var winG = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.2),
    new THREE.MeshBasicMaterial({ color: 0x99bbdd }));
  winG.position.set(0, 1.7, -4.46); g.add(winG);
  // furniture collider spots (local x, z, r)
  g.userData.colliders = [
    [-1.2, -2.2, 1.7],  // bed
    [2.6, -1.5, 1.5],   // bathroom
    [2.2, 2.8, 0.9]     // desk
  ];
  return g;
}

function mqClearFloorDetail() {
  if (MQ.floorDetail) {
    MQ.interior.remove(MQ.floorDetail);
    MQ.floorDetail = null;
  }
  MQ.doors = [];
  // truncate colliders added by last floor detail
  try {
    colliders.length = MQ.colStart;
    segColliders.length = MQ.segStart;
  } catch (e) {}
}

function mqBuildFloorDetail(f) {
  mqClearFloorDetail();
  MQ.colStart = colliders.length;
  MQ.segStart = segColliders.length;
  MQ.floorDetail = new THREE.Group();
  MQ.interior.add(MQ.floorDetail);
  MQ.detailFloor = f;

  var cx = MQ.cx, cz = MQ.cz, y0 = mqFloorY(f);
  var hw = 3.2;                       // hallway wall height
  var inR = MQ.ATRIUM / 2;            // 9
  var outR = MQ.HALL_OUT;             // 12.5
  var extR = MQ.PLATE / 2;            // 22
  var wallC = 0xc4b49a, roomC = 0xd0c0a8;

  if (f === 1) return;  // lobby already built (persistent)

  /* hallway outer wall with door gaps — 6 rooms per side */
  var perSide = 6, roomW = MQ.PLATE / perSide;  // 7.33
  var doorW = 1.4;
  // north side rooms 2,3 (0-indexed) are the elevator lobby — no doors there
  function wallWithDoors(x1, z1, x2, z2, isX, side, rStart, rEnd) {
    var segs = [];
    var start = isX ? (cx - extR) : (cz - extR);  // full-side origin
    for (var r = rStart; r < rEnd; r++) {
      if (side === 0 && (r === 2 || r === 3)) continue;  // elevator lobby
      var rc = start + (r + 0.5) * roomW;
      var d0 = rc - doorW / 2, d1 = rc + doorW / 2;
      var s0 = start + r * roomW;
      segs.push([s0, d0], [d1, s0 + roomW]);
    }
    segs.forEach(function(s) {
      if (s[1] - s[0] < 0.2) return;
      if (isX) mqWall(s[0], z1, s[1], z1, hw, y0, wallC);
      else mqWall(x1, s[0], x1, s[1], hw, y0, wallC);
    });
    // record door positions for auto-doors + labels
    for (var r2 = rStart; r2 < rEnd; r2++) {
      if (side === 0 && (r2 === 2 || r2 === 3)) continue;
      var rc2 = start + (r2 + 0.5) * roomW;
      var dx = isX ? rc2 : x1, dz = isX ? z1 : rc2;
      mqAddDoor(dx, dz, isX ? 0 : Math.PI / 2, f, side * perSide + r2);
    }
  }
  // north (z = cz-outR): rooms 0-1 west of elevator lobby, rooms 4-5 east
  // elevator lobby: 6 wide (cx+/-3), opening in hallway wall
  var lb0 = cx - 3, lb1 = cx + 3;
  (function() {
    // west segment rooms 0-1
    wallWithDoors(cx - extR, cz - outR, 0, cz - outR, true, 0, 0, 2);
    // east segment rooms 4-5
    wallWithDoors(0, cz - outR, cx + extR, cz - outR, true, 0, 4, 6);
    // hallway wall pieces flanking lobby opening
    var wStart = cx - extR;
    mqWall(wStart + 2 * roomW, cz - outR, lb0, cz - outR, hw, y0, wallC);
    mqWall(lb1, cz - outR, wStart + 4 * roomW, cz - outR, hw, y0, wallC);
    // lobby side walls (alcove from hallway to shaft)
    var shS = MQ.elev.z + 1.5;  // shaft south face
    mqWall(lb0, cz - outR, lb0, shS, hw, y0, wallC);
    mqWall(lb1, cz - outR, lb1, shS, hw, y0, wallC);
    // lobby end wall segments beside shaft doors (doors are 2.8 wide centered)
    mqWall(lb0, shS, cx - 1.5, shS, hw, y0, wallC);
    mqWall(cx + 1.5, shS, lb1, shS, hw, y0, wallC);
  })();
  wallWithDoors(cx - extR, cz + outR, cx + extR, cz + outR, true, 1, 0, 6);
  wallWithDoors(cx - outR, cz - extR, cx - outR, cz + extR, false, 2, 0, 6);
  wallWithDoors(cx + outR, cz - extR, cx + outR, cz + extR, false, 3, 0, 6);

  /* room divider walls */
  for (var s = 0; s < 4; s++) {
    for (var r = 1; r < perSide; r++) {
      var off = -extR + r * roomW;
      if (s === 0) mqWall(cx + off, cz - extR, cx + off, cz - outR, hw, y0, roomC);       // north
      else if (s === 1) mqWall(cx + off, cz + outR, cx + off, cz + extR, hw, y0, roomC); // south
      else if (s === 2) mqWall(cx - extR, cz + off, cx - outR, cz + off, hw, y0, roomC); // west
      else mqWall(cx + outR, cz + off, cx + extR, cz + off, hw, y0, roomC);               // east
    }
  }
  /* outer building walls (with window strips — visual only) */
  var winC = 0x8a8078;
  [[cx - extR, cz - extR, cx + extR, cz - extR],
   [cx - extR, cz + extR, cx + extR, cz + extR],
   [cx - extR, cz - extR, cx - extR, cz + extR],
   [cx + extR, cz - extR, cx + extR, cz + extR]
  ].forEach(function(w) {
    mqWall(w[0], w[1], w[2], w[3], hw, y0, winC);
  });

  /* room interiors — clone template */
  if (!MQ_ROOM_TEMPLATE) MQ_ROOM_TEMPLATE = mqMakeRoomTemplate();
  var roomNum = 0;
  for (var side = 0; side < 4; side++) {
    for (var ri = 0; ri < perSide; ri++) {
      roomNum++;
      // skip rooms blocked by elevator on north side (rooms 3,4)
      if (side === 0 && (ri === 2 || ri === 3)) continue;
      var room = MQ_ROOM_TEMPLATE.clone();
      var px, pz, ry;
      var rcx = -extR + (ri + 0.5) * roomW;
      if (side === 0) { px = cx + rcx; pz = cz - (outR + extR) / 2; ry = 0; }
      else if (side === 1) { px = cx + rcx; pz = cz + (outR + extR) / 2; ry = Math.PI; }
      else if (side === 2) { px = cx - (outR + extR) / 2; pz = cz + rcx; ry = -Math.PI / 2; }
      else { px = cx + (outR + extR) / 2; pz = cz + rcx; ry = Math.PI / 2; }
      room.position.set(px, y0, pz);
      room.rotation.y = ry;
      MQ.floorDetail.add(room);
      // furniture colliders (rotate local offsets)
      var cosr = Math.cos(ry), sinr = Math.sin(ry);
      MQ_ROOM_TEMPLATE.userData.colliders.forEach(function(cc) {
        var wx = px + cc[0] * cosr + cc[1] * sinr;
        var wz = pz - cc[0] * sinr + cc[1] * cosr;
        mqCol(wx, wz, cc[2]);
      });
    }
  }
}

/* auto-swing room door + number label */
function mqAddDoor(x, z, ry, floor, roomIdx) {
  var y0 = mqFloorY(floor);
  var hinge = new THREE.Group();
  hinge.position.set(x - Math.cos(ry) * 0.7, y0, z + Math.sin(ry) * 0.7);
  var panel = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.5, 0.1),
    new THREE.MeshLambertMaterial({ color: 0x6a4a2a }));
  panel.position.set(Math.cos(ry) * 0.7, 1.25, -Math.sin(ry) * 0.7);
  hinge.add(panel);
  // room number plate (floor*100 + 1..24)
  var num = floor * 100 + (roomIdx + 1);
  var cv = document.createElement('canvas'); cv.width = 64; cv.height = 32;
  var c = cv.getContext('2d');
  c.fillStyle = '#2a2a2e'; c.fillRect(0, 0, 64, 32);
  c.fillStyle = '#e8d9a0'; c.font = 'bold 20px Arial';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(String(num), 32, 17);
  var tex = new THREE.CanvasTexture(cv);
  var plate = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45),
    new THREE.MeshBasicMaterial({ map: tex }));
  plate.position.set(0, 1.9, 0.08);
  panel.add(plate);
  MQ.floorDetail.add(hinge);
  MQ.doors.push({ hinge: hinge, x: x, z: z, open: 0, num: num });
}

function mqUpdateDoors(dt) {
  if (!MQ.inside) return;
  for (var i = 0; i < MQ.doors.length; i++) {
    var d = MQ.doors[i];
    var dist = Math.hypot(player.x - d.x, player.z - d.z);
    var want = dist < 3.2 ? 1 : 0;
    d.open += Math.sign(want - d.open) * Math.min(1, Math.abs(want - d.open) * 3 * dt);
    d.open = Math.max(0, Math.min(1, d.open));
    d.hinge.rotation.y = d.open * 1.9;
  }
}

/* ---------- action-button integration ---------- */
function mqIsMarriott() {
  return MQ.inside && player.inside && player.locIdx === MQ.enterIdx;
}
function mqCheck() {
  if (car.driving) return null;
  if (!mqIsMarriott()) return null;
  var E = MQ.elev;
  // inside elevator cab
  if (MQ.inElev) {
    if (E.state === 'doors' && E.doorT > 0.7) {
      return { act: 'mq-exit-elev', label: 'EXIT ELEVATOR' };
    }
    return { act: 'mq-panel', label: 'FLOORS' };
  }
  // near elevator landing doors -> call / enter (doors at shaft south face)
  var ed = Math.hypot(player.x - E.x, player.z - (E.z + 1.75));
  var floorD = Math.abs(mqFloorY(MQ.floor) - E.y);
  if (ed < 3.5) {
    if (E.state === 'doors' && E.doorT > 0.7 && floorD < 1) {
      return { act: 'mq-enter-elev', label: 'ENTER ELEVATOR' };
    }
    return { act: 'mq-call', label: 'CALL ELEVATOR' };
  }
  return null;
}
function mqDoAction(a) {
  var E = MQ.elev;
  if (a === 'mq-call') {
    if (E.floor !== MQ.floor) {
      mqToast('ELEVATOR COMING...');
      E.callFloor = MQ.floor;
      if (E.state === 'idle') { mqSendElevator(MQ.floor); E.callFloor = -1; }
    } else {
      E.state = 'doors'; E.wantOpen = true; E.holdT = 0;
    }
  } else if (a === 'mq-enter-elev') {
    MQ.inElev = true;
    player.x = E.x; player.z = E.z;
    mqShowPanel();
    mqToast('SELECT A FLOOR');
  } else if (a === 'mq-panel') {
    mqShowPanel();
  } else if (a === 'mq-exit-elev') {
    mqExitElevator();
  }
}
function mqExitElevator() {
  var E = MQ.elev;
  MQ.inElev = false;
  mqHidePanel();
  // step out south of cab
  player.x = E.x; player.z = E.z + 3.2;
  mqSetFloorY(E.floor);
  mqBuildFloorDetail(E.floor);
  E.wantOpen = false;
}

/* ---------- enter / exit the hotel ---------- */
var mqOrigEnter = null, mqOrigExit = null;
function mqHookEnterable() {
  // wrap spDoEnter/spDoExit to manage interior visibility + exterior shell
  if (typeof spDoEnter === 'function' && !mqOrigEnter) {
    mqOrigEnter = spDoEnter;
    spDoEnter = function(idx) {
      mqOrigEnter(idx);
      if (idx === MQ.enterIdx) mqOnEnter();
    };
  }
  if (typeof spDoExit === 'function' && !mqOrigExit) {
    mqOrigExit = spDoExit;
    spDoExit = function() {
      var was = (player.locIdx === MQ.enterIdx);
      mqOrigExit();
      if (was) mqOnExit();
    };
  }
}
function mqOnEnter() {
  MQ.inside = true;
  MQ.interior.visible = true;
  mqHideExterior(true);
  mqSetFloorY(1);
  mqBuildFloorDetail(1);
  // reset elevator to lobby
  var E = MQ.elev;
  E.y = MQ.gy; E.cab.position.y = MQ.gy;
  E.floor = 1; E.state = 'idle'; E.doorT = 0; E.wantOpen = false;
  try { Report.note('marriott', { event: 'enter' }); } catch (e) {}
}
function mqOnExit() {
  MQ.inside = false;
  MQ.inElev = false;
  mqHidePanel();
  MQ.interior.visible = false;
  mqHideExterior(false);
  mqClearFloorDetail();
  MQ.detailFloor = -1;
  try { Report.note('marriott', { event: 'exit' }); } catch (e) {}
}

/* ---------- per-frame ---------- */
function mqUpdate(dt) {
  if (!MQ.inside) return;
  mqUpdateElevator(dt);
  mqUpdateDoors(dt);
  // rebuild floor detail if player changed floors (e.g. via elevator)
  if (MQ.detailFloor !== MQ.floor && !MQ.inElev) {
    mqBuildFloorDetail(MQ.floor);
  }
  // exiting elevator: action button handles it; also allow walking out
  // when doors open (player walks south out of cab)
  if (MQ.inElev) {
    var E = MQ.elev;
    player.x = E.x; player.z = E.z;
    mqSetFloorY(E.floor);
    // walk-out detection: if player pushes south past cab, exit
    // (handled via action button EXIT ELEVATOR instead — keep simple)
  }
}

/* ---------- init ---------- */
function mqInit() {
  try { MQ.gy = heightAt(MQ.cx, MQ.cz); } catch (e) { MQ.gy = 0; }
  mqBuildInterior();   // creates interior + exterior groups
  mqBuildExterior();   // canopy, sign, enterable registration
  mqBuildElevator();
  mqBuildPanel();
  mqHookEnterable();
  // if player loaded inside (save persistence), restore
  try {
    if (player.inside && player.locIdx === MQ.enterIdx) mqOnEnter();
  } catch (e) {}
  try { Report.setSys('marriott', { status: 'online', floors: 52 }); } catch (e) {}
}
try { mqInit(); } catch (e) {
  try { Report.noteError('marriott', 'init-fail', String(e).slice(0, 120)); } catch (e2) {}
}
