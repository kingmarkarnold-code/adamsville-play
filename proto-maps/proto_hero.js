/* ============================================================================
   FILE: proto_hero.js — SEVERAL-MAPS PROTOTYPE: the NEW HERO as the player
   ----------------------------------------------------------------------------
   Joshua (2026-10-25 22:18 EDT): "let's place the prototype player next to
   the prototype map" — in this prototype the on-foot player IS the new
   hero 3D model (character-refs/hero-3d/hero.glb: 8,222 tris, 21-bone
   standard skeleton, clips Idle/Walk/Run), so the character and the
   map-split are judged in one experience. THE LIVE GAME IS UNTOUCHED —
   this swap happens only inside proto-maps/.

   HOW IT WIRES IN (the existing player-rig contract):
   - The game builds its procedural rig into player.mesh and moves THAT
     object every frame (position from player.x/z, rotation.y =
     player.yaw, visibility toggled by driving/interiors). The hero is
     built to the same contract: 2.008 units tall (exact match), origin
     at the feet, faces +Z. So the swap is a mesh replacement:
     player.mesh = hero group, and every game system that drives the
     old mesh — movement, camera, stash restore, driving hide — drives
     the hero identically.
   - player.rig is deliberately LEFT INTACT (detached with the old
     mesh): clothing_system.js reads rig parts, and animateHero() keeps
     posing the detached rig harmlessly. The hero's own animation is
     driven here from player.speed — the same signal animateHero uses
     (idle <= 0.4, walk above, run at speed) — with 0.18s crossfades.
   - Driving: the game hides player.mesh while driving, so the hero is
     hidden in the car exactly like the current player.
   - Swimming keeps the Walk clip (the GLB has no swim clips — a noted
     prototype gap, not hidden).

   ENGINE: the hero loads through THREE.GLTFLoader, which the game's
   three_bridge.js attaches on the module engine (three@0.186.1). On
   the automatic r128 fallback there is no GLTFLoader — the prototype
   then keeps the current player and says so in __protoHero.reason
   (reported plainly, never silently).
   ============================================================================ */
(function(){
'use strict';
var S = window.__protoHero = {ok: false, reason: 'waiting', clip: null, speed: 0, tris: null};

function gameReady(){
  try{
    return typeof player !== 'undefined' && player && player.mesh &&
           typeof scene !== 'undefined' && scene && window.THREE;
  }catch(e){ return false; }
}

var tries = 0;
var poll = setInterval(function(){
  tries++;
  if (!gameReady()){
    if (tries > 300){ clearInterval(poll); S.reason = 'game-never-ready'; }
    return;
  }
  clearInterval(poll);
  if (!THREE.GLTFLoader){
    /* Fallback engine (r128): no GLTFLoader — keep the current player. */
    S.reason = 'module-engine-required (fallback engine has no GLTFLoader)';
    try{ console.warn('[proto-hero] ' + S.reason); }catch(e){}
    return;
  }
  S.reason = 'loading-glb';
  new THREE.GLTFLoader().load('hero.glb', onLoaded, undefined, function(err){
    S.reason = 'glb-load-failed: ' + (err && err.message || err);
    try{ console.warn('[proto-hero] ' + S.reason); }catch(e){}
  });
}, 400);

function onLoaded(gltf){
  try{
    var hero = gltf.scene;
    var tris = 0;
    hero.traverse(function(o){
      if (o.isMesh){
        o.frustumCulled = false;    /* skinned meshes: never cull the hero */
        if (o.geometry && o.geometry.index) tris += o.geometry.index.count / 3;
        else if (o.geometry && o.geometry.attributes && o.geometry.attributes.position)
          tris += o.geometry.attributes.position.count / 3;
      }
    });
    S.tris = Math.round(tris);

    var mixer = new THREE.AnimationMixer(hero);
    var actions = {};
    (gltf.animations || []).forEach(function(clip){
      actions[clip.name] = mixer.clipAction(clip);
    });
    if (!actions.Idle || !actions.Walk || !actions.Run){
      S.reason = 'glb-missing-clips: ' + Object.keys(actions).join(',');
      return;
    }

    /* --- the swap: same contract as the old rig (see header) --- */
    var old = player.mesh;
    var px = old.position.x, py = old.position.y, pz = old.position.z, ry = old.rotation.y;
    scene.remove(old);
    hero.position.set(px, py, pz);
    hero.rotation.y = ry;
    hero.visible = old.visible;
    scene.add(hero);
    player.mesh = hero;
    /* player.rig intentionally untouched (clothing reads it; the old
       procedural animator keeps posing the detached rig, invisibly). */

    var current = null;
    function setClip(name){
      if (current === name) return;
      var next = actions[name]; if (!next) return;
      if (current && actions[current]) actions[current].fadeOut(0.18);
      next.reset().fadeIn(0.18).play();
      current = name; S.clip = name;
    }
    setClip('Idle');

    var clock = new THREE.Clock();
    (function tick(){
      requestAnimationFrame(tick);
      var dt = Math.min(0.05, clock.getDelta());
      try{
        var spd = (typeof player !== 'undefined' && player) ? (player.speed || 0) : 0;
        S.speed = spd;
        /* Same thresholds the game's animateHero reads: moving above
           0.4; the run band is the top of its amp scale (spd/13.8). */
        var target = 'Idle';
        if (typeof player !== 'undefined' && player && player.swimming) target = (spd > 0.5) ? 'Walk' : 'Idle';
        else if (spd > 8.5) target = 'Run';
        else if (spd > 0.4) target = 'Walk';
        setClip(target);
      }catch(e){}
      mixer.update(dt);
    })();

    S.ok = true; S.reason = 'hero-live';
    try{ console.log('[proto-hero] hero live — ' + S.tris + ' tris, clips Idle/Walk/Run'); }catch(e){}
  }catch(e){
    S.reason = 'swap-failed: ' + (e && e.message || e);
  }
}
})();
