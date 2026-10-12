/*
 * Surviving Adamsville — ui_layout_apply.js
 *
 * Applies ui_layout.json (authored in the Adamsville UI Editor's Layout
 * tab) to the game's HUD elements at startup.
 *
 * Same defensive pattern as menu_layout_apply.js:
 *   - Fetches detailed/ui_layout.json (cache-busted by ui_version).
 *   - Fully no-op if the file is missing or corrupt — the game keeps
 *     its default HUD layout.
 *   - Never force-shows an element the game hides programmatically
 *     (e.g. context-sensitive buttons). Only hides what the layout
 *     marks invisible, and only positions/sizes elements that exist.
 *   - Mobile-only elements are hidden on non-mobile viewports.
 *
 * Coordinate model (matches the UI editor):
 *   Each element stores (anchor, x, y, width, height) in canonical
 *   pixels of a 1280x800 reference frame. Anchors pin the element to
 *   a screen corner/edge; x/y are offsets from that anchor.
 *
 * Joshua's rule: all code commented.
 */
(function () {
  "use strict";

  // Canonical reference frame the UI editor uses (pixels).
  var CANON_W = 1280;
  var CANON_H = 800;

  /**
   * Convert (anchor, x, y, width, height) to concrete CSS
   * left/top for the current viewport size.
   * Returns {left, top} in CSS pixels, or null on bad input.
   */
  function anchorToLeftTop(el, vw, vh) {
    var w = +el.width || 0;
    var h = +el.height || 0;
    var x = +el.x || 0;
    var y = +el.y || 0;
    // Scale from the canonical frame to the real viewport so layouts
    // authored at 1280x800 adapt to any screen size.
    var sx = vw / CANON_W;
    var sy = vh / CANON_H;
    // Use uniform scale (min) so elements keep their proportions.
    var s = Math.min(sx, sy);
    var sw = w * s;
    var sh = h * s;
    var ox = x * s;
    var oy = y * s;
    var left = 0, top = 0;
    switch (el.anchor) {
      case "tl": // top-left: offsets from the top-left corner
        left = ox; top = oy; break;
      case "tr": // top-right: x offsets leftward from the right edge
        left = vw - ox - sw; top = oy; break;
      case "bl": // bottom-left: y offsets upward from the bottom edge
        left = ox; top = vh - oy - sh; break;
      case "br": // bottom-right
        left = vw - ox - sw; top = vh - oy - sh; break;
      case "tc": // top-center: x offsets from horizontal center
        left = vw / 2 + ox - sw / 2; top = oy; break;
      case "bc": // bottom-center
        left = vw / 2 + ox - sw / 2; top = vh - oy - sh; break;
      case "c": // center: x/y offsets from screen center
        left = vw / 2 + ox - sw / 2; top = vh / 2 + oy - sh / 2; break;
      default: // unknown anchor — treat as top-left, don't crash
        left = ox; top = oy; break;
    }
    return { left: left, top: top, width: sw, height: sh };
  }

  /**
   * Heuristic: is this a mobile/coarse-pointer viewport?
   * Mobile-only HUD elements (joystick, pedals) stay hidden on desktop.
   */
  function isMobileViewport() {
    try {
      if (window.matchMedia &&
          window.matchMedia("(pointer: coarse)").matches) return true;
      // Small screens are treated as mobile too.
      if (Math.min(window.innerWidth, window.innerHeight) < 600) return true;
    } catch (e) { /* ignore — default to desktop */ }
    return false;
  }

  /**
   * Apply one element definition to its DOM node.
   * Skips anything missing; never throws.
   */
  function applyElement(def, vw, vh, mobile) {
    if (!def || !def.id) return;
    var el = document.getElementById(def.id);
    if (!el) return; // element not in this build — skip safely

    // Mobile-only elements: hide on desktop viewports, leave alone
    // on mobile (the game controls their show/hide from here).
    if (def.mobile_only && !mobile) {
      el.style.display = "none";
      return;
    }

    // Visibility: hide what the layout marks invisible. Never
    // force-show — game code may hide elements dynamically.
    if (def.visible === false) {
      el.style.display = "none";
      return;
    }

    // Position + size via the anchor math.
    var pos = anchorToLeftTop(def, vw, vh);
    if (!pos) return;
    // Only touch elements that are already absolutely positioned by
    // the game's CSS; don't change anyone's position scheme.
    var cs = null;
    try { cs = window.getComputedStyle(el); } catch (e) { /* ignore */ }
    if (cs && cs.position !== "absolute" && cs.position !== "fixed") return;
    el.style.left = Math.round(pos.left) + "px";
    el.style.top = Math.round(pos.top) + "px";
    // Only resize when the layout gives sane dimensions.
    if (pos.width > 0) el.style.width = Math.round(pos.width) + "px";
    if (pos.height > 0) el.style.height = Math.round(pos.height) + "px";
  }

  /**
   * Fetch ui_layout.json and apply every element it defines.
   * Idempotent — safe to re-run (e.g. after resize or hot-reload).
   */
  function applyUILayout() {
    var vw = window.innerWidth || CANON_W;
    var vh = window.innerHeight || CANON_H;
    var mobile = isMobileViewport();

    var url = "ui_layout.json";
    try {
      // Cache-bust with the UI version so edited layouts go live promptly.
      var v = null;
      if (window.ASSETVER && window.ASSETVER.uiVersion) {
        v = window.ASSETVER.uiVersion;
      } else if (window.UI_VERSION) {
        v = window.UI_VERSION;
      }
      if (v) url += "?v=" + encodeURIComponent(v);
    } catch (e) { /* keep plain URL on any error */ }

    fetch(url, { cache: "no-store" })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (doc) {
        if (!doc || !Array.isArray(doc.elements)) return;
        doc.elements.forEach(function (def) {
          try {
            applyElement(def, vw, vh, mobile);
          } catch (e) { /* one bad element must not break the rest */ }
        });
      })
      .catch(function () {
        /* Missing/corrupt file: leave the HUD exactly as authored. */
      });
  }

  // Run after the DOM is ready so every HUD element exists.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyUILayout);
  } else {
    applyUILayout();
  }

  // Re-apply (debounced) on resize so anchors track the viewport.
  var _rt = null;
  window.addEventListener("resize", function () {
    if (_rt) clearTimeout(_rt);
    _rt = setTimeout(applyUILayout, 250);
  });

  // Expose for debugging / re-apply after hot-reload.
  window.UILayoutApply = { apply: applyUILayout };
})();
