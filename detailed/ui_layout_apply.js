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
 *   - Layout "faces" (2026-10-17): ui_layout.json carries two faces
 *     under "faces" — "mobile" and "desktop" — each with its own
 *     full element list. The face matching this screen is applied;
 *     if that face is missing, the other face is used, then the
 *     top-level "elements" list (the legacy mirror of the mobile
 *     face) as a final fallback. Older files with no "faces" at all
 *     apply their top-level "elements" exactly as before.
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
    // scale rides along: applyElement needs it for the small-screen
    // button floor below (v2026-10-18 satellite/nav fix).
    return { left: left, top: top, width: sw, height: sh, scale: s };
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
    if (!def || !def.id) return null;
    var el = document.getElementById(def.id);
    if (!el) return null; // element not in this build — skip safely

    // Mobile-only elements: hide on desktop viewports, leave alone
    // on mobile (the game controls their show/hide from here).
    if (def.mobile_only && !mobile) {
      el.style.display = "none";
      return null;
    }

    // Visibility: hide what the layout marks invisible. Never
    // force-show — game code may hide elements dynamically.
    if (def.visible === false) {
      el.style.display = "none";
      return null;
    }

    // BUTTON SIZE FLOOR (2026-10-18 satellite/nav fix): remember the
    // element's natural size — its size under the game's own CSS,
    // before this applier ever sets an inline width/height. Measured
    // once and cached on the element, because later passes (resize)
    // would otherwise measure our own shrunk box and call it natural.
    // Only buttons need this, and only while they are rendered (a
    // display:none element measures 0 and must not poison the cache).
    var isButton = (def.type === "button") ||
      (el.tagName && el.tagName.toUpperCase() === "BUTTON");
    if (isButton && el.dataset && !el.dataset.saNatW) {
      try {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          el.dataset.saNatW = String(el.offsetWidth);
          el.dataset.saNatH = String(el.offsetHeight);
        }
      } catch (e) { /* dataset unavailable — floor just won't apply */ }
    }

    // Position + size via the anchor math.
    var pos = anchorToLeftTop(def, vw, vh);
    if (!pos) return null;
    // Only touch elements that are already absolutely positioned by
    // the game's CSS; don't change anyone's position scheme.
    var cs = null;
    try { cs = window.getComputedStyle(el); } catch (e) { /* ignore */ }
    if (cs && cs.position !== "absolute" && cs.position !== "fixed") return null;
    el.style.left = Math.round(pos.left) + "px";
    el.style.top = Math.round(pos.top) + "px";
    var w = pos.width;
    var h = pos.height;
    // On a viewport smaller than the canonical 1280x800 frame the
    // uniform scale shrinks a button's SLOT (42px -> 13px on a phone)
    // while its padding and label text do NOT shrink — the rendered
    // box stays ~36px wide on a ~15px pitch and neighbouring buttons
    // (Satellite View / Navigate on the full map) physically overlap,
    // so taps land on the wrong button or miss onto the map beneath.
    // Floor: a button never renders smaller than its natural size,
    // and never smaller than a 44px tappable box. Full-size viewports
    // (scale >= 1) are untouched — the designed layout applies as-is.
    if (isButton && pos.scale < 1) {
      var natW = 0, natH = 0;
      try {
        natW = parseInt((el.dataset && el.dataset.saNatW) || "0", 10) || 0;
        natH = parseInt((el.dataset && el.dataset.saNatH) || "0", 10) || 0;
      } catch (e) { /* ignore — absolute floor below still applies */ }
      if (natW > 0) w = Math.max(w, natW);
      if (natH > 0) h = Math.max(h, natH);
      w = Math.max(w, 44);
      h = Math.max(h, 44);
    }
    // Only resize when the layout gives sane dimensions.
    if (w > 0) el.style.width = Math.round(w) + "px";
    if (h > 0) el.style.height = Math.round(h) + "px";
    // The de-overlap pass in applyUILayout works on placed buttons.
    return isButton ? el : null;
  }

  /**
   * BUTTON DE-OVERLAP PASS (2026-10-18 satellite/nav fix).
   * After every element is placed, any two buttons IN THE SAME PANEL
   * whose boxes intersect are stacked: the lower one moves down below
   * the upper one (6px gap), clamped inside the viewport; if there
   * is no room below, it moves above instead. Only buttons, only
   * when they actually intersect — a layout that already fits (e.g.
   * desktop at scale 1) comes out byte-identical.
   *
   * Boxes are read from the INLINE STYLES applyElement just wrote,
   * never from getBoundingClientRect: this pass runs at startup,
   * when panels like the full map are still display:none and their
   * buttons render as 0x0 rects — a rect-based pass would see
   * nothing and skip exactly the buttons it exists to protect.
   * Grouping is by parent element so buttons from different panels
   * (which are never on screen together) never push each other.
   */
  function deoverlapButtons(buttons, vw, vh) {
    if (!buttons || !buttons.length) return;
    // Group placed buttons by their parent panel.
    var groups = [];
    var byParent = {};
    for (var i = 0; i < buttons.length; i++) {
      var key = buttons[i].parentElement || buttons[i];
      var gk = groups.indexOf(key);
      if (gk < 0) { groups.push(key); byParent[groups.length - 1] = []; gk = groups.length - 1; }
      byParent[gk].push(buttons[i]);
    }
    for (var gi = 0; gi < groups.length; gi++) {
      var items = [];
      var list = byParent[gi];
      for (var j = 0; j < list.length; j++) {
        var el = list[j];
        try {
          if (el.style.display === "none") continue;
          var left = parseFloat(el.style.left);
          var top = parseFloat(el.style.top);
          var width = parseFloat(el.style.width);
          var height = parseFloat(el.style.height);
          // A button whose box we cannot read was not positioned by
          // this applier — leave it exactly as authored.
          if (!isFinite(left) || !isFinite(top) || !isFinite(width) || !isFinite(height)) continue;
          if (width <= 0 || height <= 0) continue;
          items.push({ el: el, left: left, top: top, width: width, height: height });
        } catch (e) { /* one bad box must not break the pass */ }
      }
      // Top-to-bottom, left-to-right: deterministic stacking order.
      items.sort(function (a, b) { return (a.top - b.top) || (a.left - b.left); });
      // A few sweeps settle chains (A pushes B, B now covers C...).
      for (var pass = 0; pass < 4; pass++) {
        var moved = false;
        for (var a = 0; a < items.length; a++) {
          for (var b = a + 1; b < items.length; b++) {
            var A = items[a], B = items[b];
            var hitX = B.left < A.left + A.width && A.left < B.left + B.width;
            var hitY = B.top < A.top + A.height && A.top < B.top + B.height;
            if (!hitX || !hitY) continue;
            // Move B below A; if that leaves the viewport, above A.
            var newTop = A.top + A.height + 6;
            if (newTop + B.height > vh - 4) {
              var above = A.top - B.height - 6;
              if (above >= 4) newTop = above;
              else newTop = Math.max(4, vh - B.height - 4);
            }
            if (Math.round(newTop) !== Math.round(B.top)) {
              B.el.style.top = Math.round(newTop) + "px";
              B.top = newTop;
              moved = true;
            }
          }
        }
        if (!moved) break;
      }
    }
  }

  /**
   * Pick the element list for this viewport from a layout document.
   *
   * Faces (2026-10-17): when doc.faces is an object, return the
   * matching face's element list ("mobile" on a mobile viewport,
   * "desktop" otherwise) when that face carries an array. If the
   * matching face is missing, fall back to the other face's list.
   * When neither face is usable — or the file is an older one with
   * no faces at all — fall back to the top-level element list.
   * Returns null when no usable list exists, so the caller can
   * no-op defensively exactly as it did before faces existed.
   */
  function pickLayoutElements(doc, mobile) {
    if (!doc || typeof doc !== "object") return null;
    if (doc.faces && typeof doc.faces === "object") {
      // The face that matches this screen comes first.
      var wanted = mobile ? doc.faces.mobile : doc.faces.desktop;
      if (wanted && Array.isArray(wanted.elements)) {
        return wanted.elements;
      }
      // Matching face missing — use the other face rather than nothing.
      var other = mobile ? doc.faces.desktop : doc.faces.mobile;
      if (other && Array.isArray(other.elements)) {
        return other.elements;
      }
    }
    // Final fallback: the legacy top-level list (mirror of mobile).
    if (Array.isArray(doc.elements)) return doc.elements;
    return null;
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
        // Pick the face for this screen (with fallbacks); a null
        // list means a missing/corrupt layout — no-op as before.
        var list = pickLayoutElements(doc, mobile);
        if (!list) return;
        var placedButtons = [];
        list.forEach(function (def) {
          try {
            var placed = applyElement(def, vw, vh, mobile);
            if (placed) placedButtons.push(placed);
          } catch (e) { /* one bad element must not break the rest */ }
        });
        // Buttons that ended up on top of each other get stacked so
        // every one of them stays tappable (satellite/nav fix). Runs
        // before the HudMove hook below, so the player's own dragged
        // positions still win over this pass.
        try { deoverlapButtons(placedButtons, vw, vh); } catch (e) { /* never break the layout */ }
        // MOVABLE HUD (Joshua 2026-10-17): the designed layout is
        // on — now the player's own per-face position overrides
        // (hud_move.js) re-assert on top of it. This hook is the
        // single choke point every layout pass flows through
        // (startup, resize, hot-reload), so overrides always win
        // over a fresh design and always re-clamp to the current
        // screen. Guarded: no HudMove module, no change at all.
        try {
          if (window.HudMove && HudMove.onLayoutApplied) {
            HudMove.onLayoutApplied(mobile);
          }
        } catch (e) { /* an override must never break the layout */ }
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
