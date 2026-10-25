// three_bridge.js — the modern engine bridge (Three.js migration, 2026-10-25).
//
// WHAT THIS IS, IN PLAIN WORDS: the game was written for the old Three.js
// r128, which arrived as one plain script file (three.min.js) and set a
// global called THREE that ~90 game scripts use. Modern Three.js (this
// file loads the pinned r186, three@0.186.1) only ships as an ES module —
// there is no plain-script build any more. So this bridge loads the module
// build and publishes it as the same global THREE, and every game script
// keeps working unchanged. It also attaches the two add-ons the character
// upgrade exists for — GLTFLoader (loads real 3D models) and SkeletonUtils
// (clones a boned character so each copy animates on its own skeleton).
// In r128 those only existed as separate example scripts; in modern three
// they exist only as modules like this one.
//
// HOW IT IS LOADED: a static <script type="module"> in the page head, with
// an importmap that maps the name "three" to ./three.module.js and
// "three/addons/" to ./three-addons/. This file runs long before the
// game's deferred loader reaches the engine slot (three_shim.js), whose
// loader gate waits for the promise this bridge resolves.
//
// THE FACADE: `import * as THREE` hands back a module namespace object,
// and namespace objects are IMMUTABLE — writing THREE.GLTFLoader onto one
// throws and would kill the rest of this bridge. So the global is a plain
// shallow copy of the namespace (same class objects — instanceof and
// friends are unaffected) with the add-ons attached. The add-ons
// themselves import the real 'three' module directly and never see the
// facade.
//
// COLOUR COMPATIBILITY: r152+ turned colour management on by default,
// which made this game's scene render about 2.2x darker and more
// saturated than r128 did (measured in the upgrade spike). Switching it
// off here restores the r128 colour handling exactly. It is ONE switch,
// deliberately left reversible: a later art pass can turn colour
// management on properly, on purpose, instead of by accident.
//
// THE FALLBACK CONTRACT: the loader gate in index.html can decide to run
// the game on the classic three.min.js (r128) instead — that is what
// keeps today's APK working, because its file:// page origin cannot load
// ES modules at all (proven on-device). If the gate has already taken
// the fallback (window.__threeFallbackTaken), this bridge STANDS DOWN:
// it must never swap the engine mid-boot. It still resolves the ready
// promise (false) so nothing waits on it.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

if (window.__threeFallbackTaken){
  console.log('[three-bridge] classic engine fallback already taken — module bridge standing down');
  if (window.__threeReadyResolve) window.__threeReadyResolve(false);
} else {
  THREE.ColorManagement.enabled = false; // r128 colour handling (see header)
  const T = Object.assign({}, THREE);
  T.GLTFLoader = GLTFLoader;
  T.SkeletonUtils = SkeletonUtils;
  window.THREE = T;
  // Read by daycycle.js (its per-frame light intensities get the legacy
  // PI compensation ONLY on the modern engine) and by the loader gate.
  window.__threeModern = true;
  console.log('[three-bridge] THREE r' + THREE.REVISION + ' module ready; GLTFLoader + SkeletonUtils attached');
  if (window.__threeReadyResolve) window.__threeReadyResolve(true);
}
