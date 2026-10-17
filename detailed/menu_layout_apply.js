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
 *   - Group start state (2026-10-16, UI Editor 1.7.8): a group may
 *     carry "start": "collapsed" or "expanded" in menu_layout.json.
 *     It decides how the group's items START the first time the menu
 *     is shown. Groups without the setting behave exactly as they
 *     always have. See applyGroupStart() below.
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
   * Apply ONE item definition to its element: label + visibility.
   * Returns the element (or null when the item isn't in this build).
   * Shared by grouped and ungrouped items so both behave identically.
   */
  function applyItem(def) {
    if (!def || !def.id) return null;
    var el = document.getElementById(def.id);
    if (!el) return null; // item not present — skip, don't crash
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
    return el;
  }

  /**
   * Group start state (2026-10-16, UI Editor 1.7.8 — Joshua's
   * feature: "in the menus I can decide if something is started
   * expanded or collapsed").
   *
   * A group in menu_layout.json may carry:
   *     "start": "collapsed"  -> its items start HIDDEN the first
   *                              time the menu is shown.
   *     "start": "expanded"   -> its items start shown (today's
   *                              behavior, stated explicitly).
   *     (key absent)          -> exactly today's behavior.
   *
   * entries: [{el, def}] for the group's items that exist here.
   *
   * Collapsed handling: each shown-by-default item is hidden and
   * tagged data-sa-start-hidden="1". If the panel contains a section
   * header (h1-h4) whose text matches the group name — e.g. the
   * "Administrator" <h3> in Settings — the header becomes the
   * expand/collapse toggle for exactly those tagged items, so the
   * group is collapsed at first show, not gone. Items marked
   * visible:false are never tagged, so a toggle can never
   * force-show them. Fully defensive: any failure leaves the items
   * in their applied state.
   */
  function applyGroupStart(panel, group, entries) {
    try {
      if (!group || group.start !== "collapsed") {
        // "expanded" and unset both mean: start shown, as today.
        return;
      }
      var hidden = [];
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (!entry.el || !entry.def) continue;
        if (entry.def.visible === false) continue; // stays hidden
        entry.el.style.display = "none";
        entry.el.setAttribute("data-sa-start-hidden", "1");
        hidden.push(entry.el);
      }
      if (!hidden.length || !group.name) return;
      // Find this group's section header inside the panel, if any.
      var headers = panel.querySelectorAll("h1, h2, h3, h4");
      var header = null;
      for (var h = 0; h < headers.length; h++) {
        if ((headers[h].textContent || "").trim() === group.name) {
          header = headers[h];
          break;
        }
      }
      if (!header) return; // no header: items simply start hidden
      if (header.getAttribute("data-sa-group-toggle")) return;
      header.setAttribute("data-sa-group-toggle", "1");
      header.style.cursor = "pointer";
      var collapsed = true;
      header.addEventListener("click", function () {
        collapsed = !collapsed;
        for (var j = 0; j < hidden.length; j++) {
          if (collapsed) {
            hidden[j].style.display = "none";
          } else {
            // Only un-hide what this start state hid.
            hidden[j].style.display = "";
          }
        }
      });
    } catch (e) { /* a bad group must not break the menu */ }
  }

  /**
   * Apply one menu's item definitions: update labels, visibility,
   * and ordering within each group / the ungrouped list, then apply
   * each group's start state (see applyGroupStart).
   */
  function applyMenu(menuKey, menuDef) {
    var panelId = MENU_PANELS[menuKey];
    if (!panelId) return; // unknown menu — skip safely
    var panel = document.getElementById(panelId);
    if (!panel) return; // panel not in this build — skip safely

    // Groups first (in the layout's display order), then ungrouped.
    var groups = menuDef.groups || [];
    for (var gi = 0; gi < groups.length; gi++) {
      var group = groups[gi] || {};
      var items = group.items || [];
      var entries = [];
      for (var ii = 0; ii < items.length; ii++) {
        entries.push({ el: applyItem(items[ii]), def: items[ii] });
      }
      // The group's start state applies AFTER its items' own
      // label/visibility, so visible:false always wins.
      applyGroupStart(panel, group, entries);
    }
    var ungrouped = menuDef.ungrouped || [];
    for (var ui = 0; ui < ungrouped.length; ui++) applyItem(ungrouped[ui]);
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
