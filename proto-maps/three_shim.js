// three_shim.js — the engine slot marker (Three.js migration, 2026-10-25).
//
// This tiny file sits in the deferred loader's queue where three.min.js
// used to sit (data-dkey="engine"). It carries no engine code itself: the
// real engine arrives as an ES module via three_bridge.js (a static
// <script type="module"> in the page head), which sets the global THREE
// and resolves window.__threeReady.
//
// When the loader finishes loading THIS file, its engine gate (in
// index.html, next to the mapdelivery gate) holds the queue until the
// bridge is ready — so every later game script still sees a ready global
// THREE, exactly as it did when three.min.js executed synchronously at
// this slot. If the module engine cannot load on this surface (the APK's
// file:// origin blocks ES modules — proven on-device), the gate instead
// loads the classic three.min.js and the game runs on r128 as before.
console.log('[three-shim] engine slot reached; the module bridge supplies window.THREE (classic r128 fallback if it cannot)');
