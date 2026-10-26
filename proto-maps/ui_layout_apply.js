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
 *   - Per-size layouts (2026-10-25, Joshua's UI Editor design): the
 *     file may also carry a "sizes" list — named screen sizes (his
 *     Galaxy A17 5G, TCL K33 5G, FOXXD A67L, standard phone/tablet
 *     sizes, the laptop class), each with its own full element list,
 *     authored per size in the UI Editor. When sizes exist, the one
 *     matching this screen's MEASURED visible size (SAView) is
 *     applied: an exact width/height match first, otherwise the
 *     NEAREST size. Only when no usable size exists do the faces
 *     (then the legacy list) apply — so a file without "sizes"
 *     behaves exactly as it did before this change.
 *   - FIT PASS (2026-10-26, replaces the 2026-10-18 de-overlap pass —
 *     see the long note above fitPlacedElements): after placement,
 *     every placed box is clamped inside the measured visible rect
 *     and boxes that can be on screen together are separated, so no
 *     control sits off-screen or on top of another. The pick is also
 *     published on window.__SA_LAYOUT_PICK so the session Stats
 *     report can record the measured size + the layout picked.
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
   * Returns the placed box ({el, def, left, top, width, height, ...})
   * for the fit pass, or null when the element was left alone.
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
      // CSS MIN-SIZE FLOOR (2026-10-26): a button hidden right now
      // (the drive pedals before a drive) has no cached natural size,
      // but its stylesheet may still declare the size it WILL render
      // at — the pedals carry min-width:74px and render 74px wide no
      // matter what width is written. Flooring to the declared
      // min-width/min-height makes the placed box the rendered box,
      // which is what the fit pass separates. (The old pass assumed
      // 44px for the pedals; at 74px rendered they piled up.)
      try {
        var minW = parseFloat(cs && cs.minWidth) || 0;
        var minH = parseFloat(cs && cs.minHeight) || 0;
        if (minW > 0) w = Math.max(w, minW);
        if (minH > 0) h = Math.max(h, minH);
      } catch (e) { /* ignore — the floors above still apply */ }
    }
    // Only resize when the layout gives sane dimensions.
    // BOX-SIZING (2026-10-26): the placed box must be the RENDERED
    // box, but elements whose stylesheet uses content-box (the toast,
    // the street-name banner) render at width + padding + border —
    // wider than the box this pass writes and reasons about (the
    // banner rendered 112px on an 84px placed box). For those, write
    // the content size that renders at the placed size. Border-box
    // elements (most buttons) are written as-is.
    if (w > 0 || h > 0) {
      var writeW = w, writeH = h;
      try {
        if (cs && cs.boxSizing !== "border-box") {
          var extraW = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) +
                       (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
          var extraH = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) +
                       (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
          if (extraW > 0) writeW = Math.max(1, w - extraW);
          if (extraH > 0) writeH = Math.max(1, h - extraH);
        }
      } catch (e) { /* ignore — write the placed size as-is */ }
      if (w > 0) el.style.width = Math.round(writeW) + "px";
      if (h > 0) el.style.height = Math.round(writeH) + "px";
    }
    // CENTRE-ANCHOR TRANSFORM (2026-10-26): centre-anchored elements
    // (toast, version tag) carry a stylesheet translateX(-50%) that
    // centres them on a CSS left:50%. The anchor math above already
    // centres the box on the offset it writes, so the transform would
    // shift the rendered box a second time, by half its real width —
    // part of why the toast rendered on top of the street-name
    // banner. When the layout places a centre-anchored element, the
    // transform comes off. Without a layout, the CSS is untouched.
    var anch = String(def.anchor || "tl");
    if (anch.charAt(1) === "c") {
      try { el.style.transform = "none"; } catch (e) { /* ignore */ }
    }
    // The fit pass in applyUILayout works on placed boxes — every
    // placed element, buttons and panels/labels alike, hidden or
    // not (a hidden element's written box is the box it appears at).
    var canonBox = anchorToLeftTop(def, CANON_W, CANON_H);
    return {
      el: el, def: def,
      parentKey: el.parentElement
        ? (el.parentElement.id || el.parentElement.tagName || "body")
        : "body",
      left: pos.left, top: pos.top, width: w, height: h,
      isButton: isButton,
      canon: { left: canonBox.left, top: canonBox.top, width: +def.width || 0, height: +def.height || 0 },
      followerOf: null, sizeChanged: false
    };
  }

  /* ==================================================================
   * FIT PASS (2026-10-26) — replaces the BUTTON DE-OVERLAP PASS of
   * 2026-10-18. Joshua's phone report (prototype, portrait, browser):
   * street-name banner clipped at the top edge, CAM shoved under it,
   * top-right buttons stacked on each other, EXIT CAR + DRIVING +
   * BRAKE piled half off-screen: "Screen layout makes it unplayable."
   *
   * WHY THE OLD PASS WAS REPLACED — three mechanisms, reproduced in
   * headless Chrome at 360x620/700/800 in BOTH trees
   * (workspace/game-map/phone-layout-fix-work/repro-findings.md):
   * (1) SLOT-VS-FLOOR GEOMETRY: positions come from scaled slots
   *     (a 44px button is a 12px slot at phone scale) while the size
   *     floor is applied afterwards WITHOUT recomputing position —
   *     floored boxes systematically overlap their neighbours and
   *     spill off the right/bottom edges (pause 10px off-screen,
   *     inv-btn 33px, pedals 14px, at every portrait size).
   * (2) THE OLD PASS ONLY REPAIRED PART OF IT: it skipped any button
   *     whose inline display was "none" — exactly the drive pedals
   *     and steering buttons at pass time — so they appeared for
   *     driving as one overlapping stack. It also moved buttons
   *     vertically only and never checked on-screen fit.
   * (3) A THIRD ARRANGEMENT IN CSS: three @media blocks in index.html
   *     pinned 11+ elements with !important to fixed phone positions
   *     matching neither the layout nor each other; inline styles
   *     lose to !important, so the screen showed a collision of
   *     layouts. Those geometry pins are removed (the display
   *     decisions in the same blocks stay), leaving this module the
   *     single authority for every element it manages.
   *
   * WHAT THE FIT PASS GUARANTEES for the boxes it manages:
   *   - every placed box lies fully inside the measured visible rect
   *     (4px safe margin), shrinking a box that is larger than the
   *     rect itself;
   *   - no two boxes that can be on screen TOGETHER overlap —
   *     buttons settle first, then panels/labels around them;
   *   - hidden elements are fitted too (their written box is the box
   *     they appear at when the game shows them);
   *   - an element drawn inside another in the canonical design
   *     (the joystick knob inside its base) follows its container
   *     instead of being separated out of it.
   * Co-visibility: drive controls (steering/pedals/speedo/mode tag/
   * damage-gas bars) and on-foot controls (joystick) are never on
   * screen together, so they never push each other; "always" boxes
   * coexist with every context and separate against all of them.
   * Intentional overlays (the transient toast banner; the NPC dialog
   * bottom-sheet) are clamped on-screen but exempt from separation —
   * floating briefly over the HUD is their job.
   * ================================================================== */
  var FIT_MARGIN = 4; // px kept between every box and the screen edge
  var FIT_GAP = 2;    // px of breathing room between separated boxes

  var DRIVE_IDS = { "steer-left": 1, "steer-right": 1, "gas-btn": 1, "brake-btn": 1,
                    "handbrake-btn": 1, "speedo": 1, "mode-tag": 1, "dmg-wrap": 1, "gas-bar": 1 };
  var FOOT_IDS = { "joy-base": 1, "joy-knob": 1 };
  var OVERLAY_IDS = { "toast": 1, "npc-dialog": 1 };

  function contextOf(id) {
    if (DRIVE_IDS[id]) return "drive";
    if (FOOT_IDS[id]) return "foot";
    return "always";
  }
  function contextsCoexist(a, b) { return a === "always" || b === "always" || a === b; }
  function boxesOverlap(a, b) {
    return a.left < b.left + b.width && b.left < a.left + a.width &&
           a.top < b.top + b.height && b.top < a.top + a.height;
  }

  // Write an item's box back to its element (width/height only when
  // the fit pass had to shrink the box to fit the screen).
  function writeFitBox(it) {
    try {
      it.el.style.left = Math.round(it.left) + "px";
      it.el.style.top = Math.round(it.top) + "px";
      if (it.sizeChanged) {
        it.el.style.width = Math.round(it.width) + "px";
        it.el.style.height = Math.round(it.height) + "px";
      }
    } catch (e) { /* a detached element must never break the pass */ }
  }

  // Clamp one item fully inside the visible rect. Returns its delta.
  function clampFitItem(it, vw, vh) {
    var dx = 0, dy = 0;
    if (it.width > vw - FIT_MARGIN * 2) { it.width = Math.max(1, vw - FIT_MARGIN * 2); it.sizeChanged = true; }
    if (it.height > vh - FIT_MARGIN * 2) { it.height = Math.max(1, vh - FIT_MARGIN * 2); it.sizeChanged = true; }
    if (it.left < FIT_MARGIN) { dx = FIT_MARGIN - it.left; it.left = FIT_MARGIN; }
    if (it.left + it.width > vw - FIT_MARGIN) { dx = (vw - FIT_MARGIN - it.width) - it.left; it.left = vw - FIT_MARGIN - it.width; }
    if (it.top < FIT_MARGIN) { dy = FIT_MARGIN - it.top; it.top = FIT_MARGIN; }
    if (it.top + it.height > vh - FIT_MARGIN) { dy = (vh - FIT_MARGIN - it.height) - it.top; it.top = vh - FIT_MARGIN - it.height; }
    // Always write back, not only when the clamp itself moved the
    // box: callers also reach here after moving an item's box
    // directly (the separation fallback, a container's follower
    // delta), and those moves live only in the item until written —
    // skipping the write left the DOM at the pre-move position while
    // the pass reasoned about the moved one (the gas/handbrake pile
    // survived exactly this way).
    writeFitBox(it);
    return { dx: dx, dy: dy };
  }

  function fitPlacedElements(items, vw, vh) {
    if (!items || !items.length || !vw || !vh) return;
    var i, j, k, g;

    // Group by parent panel, like the old pass: buttons inside a
    // panel (the full-map buttons live inside #fullmap) are only
    // ever on screen with their panel-mates.
    var groups = [];
    var groupByParent = {};
    for (i = 0; i < items.length; i++) {
      var key = items[i].parentKey;
      if (!groupByParent[key]) { groupByParent[key] = []; groups.push(groupByParent[key]); }
      groupByParent[key].push(items[i]);
    }

    for (g = 0; g < groups.length; g++) {
      var list = groups[g];

      // Containment followers (canonical design): B inside A means B
      // inherits A's moves and is never separated from A. Two guards
      // keep this honest: an intentional OVERLAY can never be a
      // container (the NPC dialog is a full-width bottom sheet whose
      // authored box happens to span the drive pedals — it carries
      // nothing, and treating the pedals as its followers froze them
      // out of separation entirely), and the follower must be a real
      // inset control, at least a tenth of its container's area (the
      // knob is ~26% of its base; a spanned pedal is ~3% of the
      // dialog sheet).
      for (i = 0; i < list.length; i++) {
        var bi = list[i], bestArea = Infinity;
        for (j = 0; j < list.length; j++) {
          if (i === j) continue;
          var bj = list[j];
          if (OVERLAY_IDS[bj.def.id]) continue;
          if (bi.canon.left >= bj.canon.left - 1 && bi.canon.top >= bj.canon.top - 1 &&
              bi.canon.left + bi.canon.width <= bj.canon.left + bj.canon.width + 1 &&
              bi.canon.top + bi.canon.height <= bj.canon.top + bj.canon.height + 1) {
            var area = bj.canon.width * bj.canon.height;
            var bArea = bi.canon.width * bi.canon.height;
            if (area > 0 && bArea / area < 0.1) continue;
            if (area < bestArea) { bestArea = area; bi.followerOf = bj; }
          }
        }
      }
      function followersOf(container) {
        var out = [];
        for (var q = 0; q < list.length; q++) if (list[q].followerOf === container) out.push(list[q]);
        return out;
      }
      function moveItem(it, dx, dy) {
        it.left += dx; it.top += dy; writeFitBox(it);
        var fs = followersOf(it);
        for (var q = 0; q < fs.length; q++) {
          fs[q].left += dx; fs[q].top += dy;
          clampFitItem(fs[q], vw, vh);
        }
      }

      // Stage 1 — clamp everything on-screen. Containers first, so a
      // follower inherits its container's clamped position, then gets
      // its own clamp.
      var containersFirst = list.slice().sort(function (a, b) {
        return (a.followerOf ? 1 : 0) - (b.followerOf ? 1 : 0);
      });
      for (i = 0; i < containersFirst.length; i++) {
        var cit = containersFirst[i];
        if (cit.followerOf) continue;
        var cd = clampFitItem(cit, vw, vh);
        if (cd.dx || cd.dy) {
          var cfs = followersOf(cit);
          for (j = 0; j < cfs.length; j++) { cfs[j].left += cd.dx; cfs[j].top += cd.dy; }
        }
      }
      for (i = 0; i < list.length; i++) if (list[i].followerOf) clampFitItem(list[i], vw, vh);

      // Stage 2 — separation sweeps. Priority order: buttons first,
      // then panels/labels/images in list order. An item only moves
      // for a conflict with an item placed earlier in this order.
      var order = list.map(function (it2, idx) { return { it: it2, idx: idx }; }).sort(function (a, b) {
        var pa = a.it.isButton ? 0 : 1, pb = b.it.isButton ? 0 : 1;
        return (pa - pb) || (a.idx - b.idx);
      }).map(function (o) { return o.it; });

      function candidateOk(mover, dx, dy) {
        var probe = { left: mover.left + dx, top: mover.top + dy, width: mover.width, height: mover.height };
        if (probe.left < FIT_MARGIN || probe.top < FIT_MARGIN ||
            probe.left + probe.width > vw - FIT_MARGIN || probe.top + probe.height > vh - FIT_MARGIN) return false;
        for (var q = 0; q < order.length; q++) {
          var o = order[q];
          if (o === mover || o.followerOf === mover || mover.followerOf === o) continue;
          if (OVERLAY_IDS[o.def.id]) continue;
          if (!contextsCoexist(contextOf(mover.def.id), contextOf(o.def.id))) continue;
          if (boxesOverlap(probe, o)) return false;
        }
        return true;
      }

      // The sweep loop, callable twice: once for everything, and
      // once more after the stage-3 button stacking with buttons
      // held fixed, so panels/labels settle around the buttons'
      // final positions instead of being stacked into.
      function separationSweeps(onlyNonButtons) {
      for (var sweep = 0; sweep < (onlyNonButtons ? 4 : 8); sweep++) {
        var movedAny = false;
        for (i = 0; i < order.length; i++) {
          var fixed = order[i];
          if (OVERLAY_IDS[fixed.def.id]) continue;
          for (j = i + 1; j < order.length; j++) {
            var mover = order[j];
            if (onlyNonButtons && mover.isButton) continue;
            if (mover.followerOf || OVERLAY_IDS[mover.def.id]) continue;
            if (!contextsCoexist(contextOf(fixed.def.id), contextOf(mover.def.id))) continue;
            if (!boxesOverlap(fixed, mover)) continue;
            // The four single-axis escapes, smallest first.
            var cands = [
              { dx: (fixed.left + fixed.width + FIT_GAP) - mover.left, dy: 0 },
              { dx: (fixed.left - FIT_GAP - mover.width) - mover.left, dy: 0 },
              { dx: 0, dy: (fixed.top + fixed.height + FIT_GAP) - mover.top },
              { dx: 0, dy: (fixed.top - FIT_GAP - mover.height) - mover.top }
            ];
            cands.sort(function (a, b) {
              return (Math.abs(a.dx) + Math.abs(a.dy)) - (Math.abs(b.dx) + Math.abs(b.dy));
            });
            var applied = false;
            for (k = 0; k < cands.length; k++) {
              if (candidateOk(mover, cands[k].dx, cands[k].dy)) {
                moveItem(mover, cands[k].dx, cands[k].dy);
                applied = true; movedAny = true; break;
              }
            }
            if (!applied) {
              // No clean escape: take the smallest escape anyway and
              // clamp back on-screen; later sweeps (or stage 3 for
              // buttons) get another chance at the residue.
              mover.left += cands[0].dx; mover.top += cands[0].dy;
              clampFitItem(mover, vw, vh);
              var fs3 = followersOf(mover);
              for (k = 0; k < fs3.length; k++) { fs3[k].left += cands[0].dx; fs3[k].top += cands[0].dy; clampFitItem(fs3[k], vw, vh); }
              movedAny = true;
            }
          }
        }
        if (!movedAny) break;
      }
      }
      separationSweeps(false);

      // Stage 3 — cluster fallback (buttons only): if sweeps left two
      // buttons overlapping (a cornered cluster), stack the cluster
      // vertically at its left edge with a 6px gap.
      var guard = 0, changed = true;
      while (changed && guard++ < 6) {
        changed = false;
        for (i = 0; i < order.length; i++) {
          if (!order[i].isButton || OVERLAY_IDS[order[i].def.id]) continue;
          for (j = i + 1; j < order.length; j++) {
            var b1 = order[i], b2 = order[j];
            if (!b2.isButton || b2.followerOf) continue;
            if (!contextsCoexist(contextOf(b1.def.id), contextOf(b2.def.id))) continue;
            if (!boxesOverlap(b1, b2)) continue;
            var cluster = [b1];
            for (k = 0; k < order.length; k++) {
              var cand = order[k];
              if (!cand.isButton || cand === b1 || cand.followerOf) continue;
              for (var m = 0; m < cluster.length; m++) {
                if (boxesOverlap(cluster[m], cand)) { cluster.push(cand); break; }
              }
            }
            cluster.sort(function (a, b) { return a.top - b.top; });
            var totalH = 0, leftMin = Infinity, topMin = Infinity, widest = 0;
            for (k = 0; k < cluster.length; k++) {
              totalH += cluster[k].height + (k ? 6 : 0);
              if (cluster[k].left < leftMin) leftMin = cluster[k].left;
              if (cluster[k].top < topMin) topMin = cluster[k].top;
              if (cluster[k].width > widest) widest = cluster[k].width;
            }
            if (leftMin + widest > vw - FIT_MARGIN) leftMin = Math.max(FIT_MARGIN, vw - FIT_MARGIN - widest);
            if (topMin + totalH > vh - FIT_MARGIN) topMin = Math.max(FIT_MARGIN, vh - FIT_MARGIN - totalH);
            var yy = topMin;
            for (k = 0; k < cluster.length; k++) {
              moveItem(cluster[k], leftMin - cluster[k].left, yy - cluster[k].top);
              yy += cluster[k].height + 6;
            }
            changed = true;
          }
        }
      }

      // Stage 4 — settle: with the buttons at their final stacked
      // positions, run the sweeps once more for panels/labels only,
      // so nothing ends up underneath a stacked button.
      separationSweeps(true);
    }
  }

  /**
   * Per-size layouts (2026-10-25): pick the named size for this
   * screen from doc.sizes. An entry is usable when it carries an
   * elements array and positive width/height. An EXACT match on the
   * measured visible size wins immediately. Otherwise the NEAREST
   * entry wins: smallest total |Δwidth| + |Δheight|; ties go to the
   * smallest worst-axis difference, then to the earliest entry in
   * the list (the UI Editor's order — deterministic). Two entries
   * with identical dimensions (e.g. two 720x1600 phones at the same
   * density) therefore resolve to the first one listed.
   * Returns {elements, key, exact, width, height} or null when no
   * size is usable. (width/height ride along since 2026-10-26 for
   * the __SA_LAYOUT_PICK telemetry; the pick itself is unchanged.)
   */
  function pickSizeElements(doc, vw, vh) {
    if (!doc || !Array.isArray(doc.sizes)) return null;
    var best = null;
    var bestScore = Infinity;
    var bestMax = Infinity;
    for (var i = 0; i < doc.sizes.length; i++) {
      var s = doc.sizes[i];
      if (!s || !Array.isArray(s.elements)) continue;
      var w = +s.width;
      var h = +s.height;
      if (!(w > 0) || !(h > 0)) continue;
      if (w === vw && h === vh) {
        return { elements: s.elements, key: s.key || null, exact: true, width: w, height: h };
      }
      var dw = Math.abs(w - vw);
      var dh = Math.abs(h - vh);
      var score = dw + dh;
      var mx = Math.max(dw, dh);
      if (score < bestScore || (score === bestScore && mx < bestMax)) {
        best = s;
        bestScore = score;
        bestMax = mx;
      }
    }
    if (!best) return null;
    return { elements: best.elements, key: best.key || null, exact: false, width: +best.width, height: +best.height };
  }

  /**
   * Pick the layout for this viewport from a layout document.
   * Order (2026-10-25): a per-size pick (exact, then nearest) when
   * the document carries usable sizes; then the faces; then the
   * legacy top-level list. Returns {list, source, key} where source
   * is "size" | "face" | "legacy", or null when nothing is usable
   * so the caller can no-op defensively exactly as before.
   *
   * Faces (2026-10-17): when doc.faces is an object, return the
   * matching face's element list ("mobile" on a mobile viewport,
   * "desktop" otherwise) when that face carries an array. If the
   * matching face is missing, fall back to the other face's list.
   * When neither face is usable — or the file is an older one with
   * no faces at all — fall back to the top-level element list.
   */
  function pickLayout(doc, mobile, vw, vh) {
    if (!doc || typeof doc !== "object") return null;
    // Per-size layouts first (exact match, then nearest size).
    var sized = pickSizeElements(doc, vw, vh);
    if (sized) {
      return { list: sized.elements, source: "size", key: sized.key };
    }
    if (doc.faces && typeof doc.faces === "object") {
      // The face that matches this screen comes first.
      var wanted = mobile ? doc.faces.mobile : doc.faces.desktop;
      if (wanted && Array.isArray(wanted.elements)) {
        return { list: wanted.elements, source: "face", key: null };
      }
      // Matching face missing — use the other face rather than nothing.
      var other = mobile ? doc.faces.desktop : doc.faces.mobile;
      if (other && Array.isArray(other.elements)) {
        return { list: other.elements, source: "face", key: null };
      }
    }
    // Final fallback: the legacy top-level list (mirror of mobile).
    if (Array.isArray(doc.elements)) {
      return { list: doc.elements, source: "legacy", key: null };
    }
    return null;
  }

  /**
   * The element list only — the shape this module has always used
   * internally. Kept as a thin wrapper over pickLayout().
   */
  function pickLayoutElements(doc, mobile, vw, vh) {
    var picked = pickLayout(doc, mobile, vw, vh);
    return picked ? picked.list : null;
  }

  /**
   * Fetch ui_layout.json and apply every element it defines.
   * Idempotent — safe to re-run (e.g. after resize or hot-reload).
   */
  function applyUILayout() {
    // MEASURED VIEWPORT (Joshua 2026-10-24, same fix as basketball
    // v2.3.1): window.innerWidth/innerHeight can count the strip
    // hidden under the phone browser's address bar / footer, so
    // bottom-anchored controls landed where the player cannot see
    // them. index.html's SAView measures window.visualViewport —
    // the area actually visible — and this pass lays out against
    // THAT. Falls back to the window size when SAView is absent.
    var vw = (window.SAView && SAView.width()) || window.innerWidth || CANON_W;
    var vh = (window.SAView && SAView.height()) || window.innerHeight || CANON_H;
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
        // Pick the layout for this screen — per-size pick first
        // (exact/nearest against the measured visible size), then
        // the faces, then the legacy list; a null list means a
        // missing/corrupt layout — no-op as before.
        var picked = pickLayout(doc, mobile, vw, vh);
        var list = picked ? picked.list : null;
        if (!list) return;
        // LAYOUT PICK TELEMETRY (2026-10-26): publish the measured
        // visible size and the layout this screen actually picked.
        // The session Stats report (github_reports.js) reads this so
        // a report from a real device names its real size and layout
        // instead of the seeded manufacturer guesses. Harmless when
        // nothing reads it.
        try {
          var sizedPick = (picked.source === "size") ? pickSizeElements(doc, vw, vh) : null;
          window.__SA_LAYOUT_PICK = {
            source: picked.source || null,
            key: picked.key || null,
            width: sizedPick ? sizedPick.width : null,
            height: sizedPick ? sizedPick.height : null,
            exact: sizedPick ? !!sizedPick.exact : false,
            vw: vw, vh: vh
          };
        } catch (e) { /* telemetry is an enhancement, never a dependency */ }
        var placedItems = [];
        var presentIds = [];
        list.forEach(function (def) {
          try {
            // MOVABLE-HUD REGISTRY (2026-10-24): hud_move.js no
            // longer keeps a hand-typed allow-list — the ids this
            // pass actually placed (element exists in the DOM) are
            // published here, and hud_move DERIVES its movable /
            // select-by-list set from them. A control added to the
            // designed layout joins the move-controls list by
            // itself (this is how Go To gets in).
            if (def && def.id && document.getElementById(def.id)) {
              presentIds.push(def.id);
            }
            var placed = applyElement(def, vw, vh, mobile);
            if (placed) placedItems.push(placed);
          } catch (e) { /* one bad element must not break the rest */ }
        });
        try { window.__SA_LAYOUT_IDS = presentIds; } catch (e) { /* registry is an enhancement, never a dependency */ }
        // FIT PASS (2026-10-26): clamp every placed box inside the
        // measured visible rect and separate boxes that can share
        // the screen, so nothing sits off-screen or stacked. Runs
        // before the HudMove hook below, so the player's own dragged
        // positions still win over this pass.
        try { fitPlacedElements(placedItems, vw, vh); } catch (e) { /* never break the layout */ }
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

  // Expose for debugging / re-apply after hot-reload. pickLayout is
  // exposed so the selection logic itself is testable headlessly
  // (which list WOULD this screen get?) without a DOM. Other modules
  // creating a layout-managed element late (workerhousing.js) call
  // apply() so the new element joins the fitted layout.
  window.UILayoutApply = { apply: applyUILayout, pickLayout: pickLayout };
})();
