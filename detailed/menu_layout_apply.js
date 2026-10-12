/*
 * Surviving Adamsville — menu_layout_apply.js
 *
 * Applies menu_layout.json (authored in the Adamsville UI Editor's
 * Menu tab) to the game's menus at startup.
 *
 * Same pattern as ui_layout_apply.js:
 *   - Fetches detailed/menu_layout.json (cache-busted by ui_version).
 *   - Defensive: fully no-op if the file is missing or corrupt.
 *   - Never force-shows a menu; game-driven show/hide keeps working.
 *   - Applies menu item labels, visibility, and ordering per menu.
 *
 * Joshua's rule: all code commented.
 */
(function () {
  "use strict";

  // Menu panel element IDs in index.html that this applier can restyle.
  // Maps menu key -> panel element ID.
  var MENU_PANELS = {
    settings: "settings",
    gameplay: "gameplay",
    zonepick: "zonepick",
    saveexit: "saveexit",
    launcher: "launcher",
    help: "help",
  };

  /**
   * Apply one menu's item definitions: update labels, visibility,
   * and ordering within each group / the ungrouped list.
   */
  function applyMenu(menuKey, menuDef) {
    var panelId = MENU_PANELS[menuKey];
    if (!panelId) return; // unknown menu — skip safely
    var panel = document.getElementById(panelId);
    if (!panel) return; // panel not in this build — skip safely

    // Collect all item defs in display order: groups first, then ungrouped.
    var ordered = [];
    var groups = menuDef.groups || [];
    for (var gi = 0; gi < groups.length; gi++) {
      var items = groups[gi].items || [];
      for (var ii = 0; ii < items.length; ii++) ordered.push(items[ii]);
    }
    var ungrouped = menuDef.ungrouped || [];
    for (var ui = 0; ui < ungrouped.length; ui++) ordered.push(ungrouped[ui]);

    for (var k = 0; k < ordered.length; k++) {
      var def = ordered[k];
      if (!def || !def.id) continue;
      var el = document.getElementById(def.id);
      if (!el) continue; // item not present — skip, don't crash
      // Update the visible label (buttons may contain spans; only
      // replace the text node portion to preserve inner markup).
      if (typeof def.label === "string" && def.label) {
        // If the button has a single text node, replace it directly.
        var replaced = false;
        for (var n = 0; n < el.childNodes.length; n++) {
          var node = el.childNodes[n];
          if (node.nodeType === 3 && node.textContent.trim()) {
            node.textContent = def.label;
            replaced = true;
            break;
          }
        }
        if (!replaced && !el.querySelector("span")) {
          el.textContent = def.label;
        }
      }
      // Visibility: hide items marked invisible. Never force-show —
      // game code may hide items dynamically (e.g. admin-only).
      if (def.visible === false) {
        el.style.display = "none";
      }
    }
  }

  /**
   * Fetch menu_layout.json and apply every menu it defines.
   * Runs once at startup; re-runs are safe (idempotent).
   */
  function applyMenuLayout() {
    var url = "menu_layout.json";
    try {
      // Cache-bust with the UI version so edited menus go live promptly.
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
        if (!doc || typeof doc.menus !== "object") return;
        Object.keys(doc.menus).forEach(function (key) {
          try {
            applyMenu(key, doc.menus[key]);
          } catch (e) { /* one bad menu must not break the rest */ }
        });
      })
      .catch(function () {
        /* Missing/corrupt file: leave menus exactly as authored in HTML. */
      });
  }

  // Run after the DOM is ready so every menu panel exists.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyMenuLayout);
  } else {
    applyMenuLayout();
  }

  // Expose for debugging / re-apply after hot-reload.
  window.MenuLayoutApply = { apply: applyMenuLayout };
})();
