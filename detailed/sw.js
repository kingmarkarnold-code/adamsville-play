/* Surviving Adamsville — service worker (ui 2026.11.08.10).
 *
 * PASS-THROUGH ONLY — THE LAW: this worker exists solely so Chromium
 * treats the game as installable (Add to Home Screen). It must NEVER
 * cache a game file: this player has been hurt repeatedly by stale
 * copies of the game, so a caching worker would be a defect, not a
 * feature. The fetch handler below is registered (installability
 * wants one) but deliberately never calls respondWith — every
 * request goes straight to the network, exactly as if no worker
 * existed. Do not add a cache here. Do not precache. Do not
 * respondWith. Ever.
 */
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  /* pass-through by design: no respondWith, no caches — see the law above */
});
