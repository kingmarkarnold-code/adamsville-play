/* ui_layout_apply.js — applies ui_layout.json to the game's HUD.
 *
 * Joshua edits the UI layout visually in the UI Layout Editor; that tool
 * saves ui_layout.json, and this script reads it at startup and moves /
 * hides the matching DOM elements. It is fully defensive:
 *   - if ui_layout.json is missing or corrupt, nothing changes;
 *   - it only ever HIDES elements Joshua marked invisible — it never
 *     force-shows anything, so game-driven show/hide logic keeps working;
 *   - every DOM touch is wrapped so one bad element can't break the rest.
 *
 * Anchors: tl = top-left, tr = top-right, bl = bottom-left,
 *           br = bottom-right, tc = top-center, bc = bottom-center,
 *           c = center. x/y are pixel offsets from the anchor corner
 *           (measured the same way CSS top/left/right/bottom work).
 */
(function () {
  'use strict';

  // Convert (anchor, x, y, w, h) into concrete left/top for a viewport.
  function anchorPos(anchor, x, y, w, h, vw, vh) {
    var left = 0, top = 0;
    switch (anchor) {
      case 'tr': left = vw - x - w; top = y; break;
      case 'bl': left = x; top = vh - y - h; break;
      case 'br': left = vw - x - w; top = vh - y - h; break;
      case 'tc': left = (vw - w) / 2 + x; top = y; break;
      case 'bc': left = (vw - w) / 2 + x; top = vh - y - h; break;
      case 'c':  left = (vw - w) / 2 + x; top = (vh - h) / 2 + y; break;
      default:   left = x; top = y; break; // 'tl'
    }
    return { left: Math.round(left), top: Math.round(top) };
  }

  // Best-effort mobile check: mirrors the game's own isMobileUI logic.
  function isMobile() {
    try {
      if (typeof isMobileUI !== 'undefined') return !!isMobileUI;
    } catch (e) {}
    try {
      return window.innerWidth <= 820 ||
        (window.matchMedia && window.matchMedia('(pointer:coarse)').matches);
    } catch (e) {}
    return false;
  }

  function applyLayout(layout) {
    try {
      var vw = window.innerWidth, vh = window.innerHeight;
      var mobile = isMobile();
      var els = (layout && layout.elements) || [];
      for (var i = 0; i < els.length; i++) {
        (function (el) {
          try {
            if (!el || !el.id) return;
            // Mobile-only elements are skipped on desktop and vice versa
            // is not needed (desktop elements show on both).
            if (el.mobile_only && !mobile) return;
            var node = document.getElementById(el.id);
            if (!node) return;
            // Joshua asked to remove this element: hide it and stop.
            // (We never force-show: game-driven visibility keeps working.)
            if (el.visible === false) {
              node.style.display = 'none';
              return;
            }
            var w = el.width || 50, h = el.height || 30;
            var p = anchorPos(el.anchor || 'tl', el.x || 0, el.y || 0,
                              w, h, vw, vh);
            node.style.position = 'fixed';
            node.style.left = p.left + 'px';
            node.style.top = p.top + 'px';
            node.style.width = w + 'px';
            node.style.height = h + 'px';
          } catch (e) { /* one bad element can't break the rest */ }
        })(els[i]);
      }
    } catch (e) {}
  }

  function boot() {
    try {
      fetch('ui_layout.json?v=' + Date.now(), { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('no layout');
          return r.json();
        })
        .then(applyLayout)
        .catch(function () { /* missing file = keep default layout */ });
    } catch (e) {}
  }

  // Re-apply (debounced) on resize / orientation change so anchored
  // elements stay glued to their corners.
  var _t = null;
  window.addEventListener('resize', function () {
    clearTimeout(_t);
    _t = setTimeout(boot, 400);
  });

  if (document.readyState === 'complete' ||
      document.readyState === 'interactive') {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }
})();
