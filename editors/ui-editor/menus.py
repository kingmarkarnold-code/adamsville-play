#!/usr/bin/env python3
"""
Adamsville UI Resource Editor (Native) — menu editor tab.

Joshua's spec (2026-10-11): the game's menus (Settings, Gameplay,
Launcher options, etc.) should be editable visually — not just the HUD
layout. This tab loads menu_layout.json (the same file the game fetches
at startup via menu_layout_apply.js) and lets Joshua:

  * browse every menu and its items in a tree,
  * select any item and ALWAYS see its plain-language description,
  * rename items (edit the display label),
  * reorder items (move up / move down),
  * create named groups inside a menu,
  * move items between groups ("Move to Group"),
  * rename / delete groups (deleting returns items to the ungrouped list),
  * toggle item visibility,
  * save the menu layout, which stages menu_layout.json for the next push.

Document shape (see data.py):
  {"menus": {menu_key: {"title", "description",
                        "groups": [{"name", "items": [...]}],
                        "ungrouped": [...]}},
   "version": N}
  Item: {"id", "label", "description", "action", "visible"}

Pure Python + GTK3. NO webview, NO HTML, NO JavaScript.

Joshua's rule: all code commented.
"""

import json

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk

from data import (
    download_menu_layout, load_menu_layout, validate_menu_doc,
    stage_content,
)

# TreeStore columns: (display text, row kind, payload)
# Row kinds: "menu" (menu key), "grouphdr" (section header, not selectable
# for editing), "group" (group dict), "item" (item dict).
_COL_TEXT, _COL_KIND, _COL_REF = 0, 1, 2


class MenuTab:
    """
    The menu editor tab: menu list on the left, group/item tree in the
    middle, properties (with always-visible description) on the right,
    and an action toolbar on top.
    """

    def __init__(self, app):
        """
        app is the main UIEditorApp: provides set_status() for feedback
        and _unpublished tracking for the close warning.
        """
        self.app = app
        self.doc = None            # full menu_layout.json dict
        self._dirty = False        # unsaved changes?
        self._updating = False     # guard against signal recursion
        self._menu_seq = 1          # counter for new item ids
        self._build_ui()
        self._load_initial()

    # -- data loading ------------------------------------------------------

    def _load_initial(self):
        """Load the menu layout: download fresh, fall back to cache."""
        # Try a fresh download first so Joshua always sees the latest.
        try:
            download_menu_layout()
        except Exception:
            pass  # offline — the cache load below still works
        self.doc = validate_menu_doc(load_menu_layout())
        if self.doc and self.doc.get("menus"):
            self.app.set_status(
                f"Loaded {len(self.doc['menus'])} menus.")
        else:
            self.app.set_status(
                "No menu data yet — it downloads from GitHub on first run.")
        self.refresh_all()

    # -- UI construction ----------------------------------------------------

    def _build_ui(self):
        """Assemble the tab: toolbar on top, three panes below."""
        self.root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        # --- Toolbar ---
        toolbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        toolbar.set_border_width(6)
        self.root.pack_start(toolbar, False, False, 0)

        self.btn_group = Gtk.Button(label="Create Group")
        self.btn_group.set_tooltip_text(
            "Create a new named group in the selected menu")
        self.btn_group.connect("clicked", self.on_create_group)
        toolbar.pack_start(self.btn_group, False, False, 0)

        self.btn_to_group = Gtk.Button(label="Move to Group")
        self.btn_to_group.set_tooltip_text(
            "Move the selected item into a different group")
        self.btn_to_group.connect("clicked", self.on_move_to_group)
        toolbar.pack_start(self.btn_to_group, False, False, 0)

        sep1 = Gtk.Separator(orientation=Gtk.Orientation.VERTICAL)
        toolbar.pack_start(sep1, False, False, 0)

        self.btn_up = Gtk.Button(label="▲ Up")
        self.btn_up.set_tooltip_text("Move the selected item up")
        self.btn_up.connect("clicked", self.on_move_up)
        toolbar.pack_start(self.btn_up, False, False, 0)

        self.btn_down = Gtk.Button(label="▼ Down")
        self.btn_down.set_tooltip_text("Move the selected item down")
        self.btn_down.connect("clicked", self.on_move_down)
        toolbar.pack_start(self.btn_down, False, False, 0)

        sep2 = Gtk.Separator(orientation=Gtk.Orientation.VERTICAL)
        toolbar.pack_start(sep2, False, False, 0)

        self.btn_rename_group = Gtk.Button(label="Rename Group")
        self.btn_rename_group.set_tooltip_text(
            "Rename the selected group")
        self.btn_rename_group.connect("clicked", self.on_rename_group)
        toolbar.pack_start(self.btn_rename_group, False, False, 0)

        self.btn_del_group = Gtk.Button(label="Delete Group")
        self.btn_del_group.set_tooltip_text(
            "Delete the selected group — its items return to the menu")
        self.btn_del_group.connect("clicked", self.on_delete_group)
        toolbar.pack_start(self.btn_del_group, False, False, 0)

        spacer = Gtk.Box()  # pushes Save to the right
        spacer.set_hexpand(True)
        toolbar.pack_start(spacer, True, True, 0)

        self.btn_save = Gtk.Button(label="Save Menus")
        self.btn_save.set_tooltip_text(
            "Save menu changes — stages menu_layout.json for the next push")
        self.btn_save.connect("clicked", self.on_save)
        toolbar.pack_start(self.btn_save, False, False, 0)

        # --- Three panes: menus | tree | properties ---
        paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self.root.pack_start(paned, True, True, 0)

        # Left: menu list.
        left_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        left_label = Gtk.Label(label="Menus")
        left_label.set_margin_top(4)
        left_box.pack_start(left_label, False, False, 0)
        self.menu_store = Gtk.ListStore(str, str)  # (menu key, title)
        self.menu_tree = Gtk.TreeView(model=self.menu_store)
        col = Gtk.TreeViewColumn("Menu", Gtk.CellRendererText(), text=1)
        self.menu_tree.append_column(col)
        self.menu_tree.get_selection().connect("changed",
                                               self.on_menu_selected)
        left_scroll = Gtk.ScrolledWindow()
        left_scroll.set_policy(Gtk.PolicyType.NEVER,
                               Gtk.PolicyType.AUTOMATIC)
        left_scroll.add(self.menu_tree)
        left_scroll.set_size_request(170, -1)
        left_box.pack_start(left_scroll, True, True, 0)
        paned.pack1(left_box, False, False)

        # Middle: group/item tree.
        mid_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        mid_label = Gtk.Label(label="Groups & Items")
        mid_label.set_margin_top(4)
        mid_box.pack_start(mid_label, False, False, 0)
        self.tree_store = Gtk.TreeStore(str, str, object)
        self.tree = Gtk.TreeView(model=self.tree_store)
        tcol = Gtk.TreeViewColumn("Structure", Gtk.CellRendererText(),
                                  text=_COL_TEXT)
        self.tree.append_column(tcol)
        self.tree.get_selection().connect("changed", self.on_tree_selected)
        self.tree.connect("row-activated", self.on_row_activated)
        mid_scroll = Gtk.ScrolledWindow()
        mid_scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                              Gtk.PolicyType.AUTOMATIC)
        mid_scroll.add(self.tree)
        mid_box.pack_start(mid_scroll, True, True, 0)
        paned.pack2(mid_box, True, False)

        # Right: properties panel (description ALWAYS visible).
        right_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        right_box.set_border_width(8)
        right_label = Gtk.Label()
        right_label.set_markup("<b>Properties</b>")
        right_box.pack_start(right_label, False, False, 0)

        # Kind indicator: what is selected (menu / group / item).
        self.kind_label = Gtk.Label()
        self.kind_label.set_markup("<small><i>Select a menu item</i></small>")
        right_box.pack_start(self.kind_label, False, False, 0)

        # Name/label editor.
        name_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        name_box.pack_start(Gtk.Label(label="Label (display name)"),
                            False, False, 0)
        self.label_entry = Gtk.Entry()
        self.label_entry.set_tooltip_text(
            "The text the player sees for this menu item")
        self.label_entry.connect("changed", self.on_label_changed)
        name_box.pack_start(self.label_entry, False, False, 0)
        right_box.pack_start(name_box, False, False, 0)

        # Description: ALWAYS shown when an item is selected (Joshua's
        # rule — anyone working with him must understand each item).
        desc_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        desc_header = Gtk.Label()
        desc_header.set_markup("<b>Description</b>")
        desc_header.set_halign(Gtk.Align.START)
        desc_box.pack_start(desc_header, False, False, 0)
        self.desc_label = Gtk.Label()
        self.desc_label.set_line_wrap(True)
        self.desc_label.set_halign(Gtk.Align.START)
        self.desc_label.set_valign(Gtk.Align.START)
        self.desc_label.set_selectable(True)
        desc_scroll = Gtk.ScrolledWindow()
        desc_scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                               Gtk.PolicyType.AUTOMATIC)
        desc_scroll.set_min_content_height(90)
        desc_scroll.add(self.desc_label)
        desc_box.pack_start(desc_scroll, False, False, 0)
        right_box.pack_start(desc_box, False, False, 0)

        # Editable description (so Joshua can fix unclear ones).
        desc_edit_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                                spacing=2)
        desc_edit_box.pack_start(
            Gtk.Label(label="Edit description"), False, False, 0)
        self.desc_entry = Gtk.Entry()
        self.desc_entry.set_tooltip_text(
            "Plain-language explanation of what this item does")
        self.desc_entry.connect("changed", self.on_desc_changed)
        desc_edit_box.pack_start(self.desc_entry, False, False, 0)
        right_box.pack_start(desc_edit_box, False, False, 0)

        # Action (read-only — the game wires actions by id).
        act_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        act_box.pack_start(Gtk.Label(label="Action:"), False, False, 0)
        self.action_label = Gtk.Label(label="—")
        self.action_label.set_halign(Gtk.Align.START)
        act_box.pack_start(self.action_label, True, True, 0)
        right_box.pack_start(act_box, False, False, 0)

        # Item ID (read-only — must match the game's element id).
        id_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        id_box.pack_start(Gtk.Label(label="Item ID:"), False, False, 0)
        self.id_label = Gtk.Label(label="—")
        self.id_label.set_halign(Gtk.Align.START)
        id_box.pack_start(self.id_label, True, True, 0)
        right_box.pack_start(id_box, False, False, 0)

        # Visibility toggle.
        self.visible_check = Gtk.CheckButton(label="Visible in game")
        self.visible_check.set_tooltip_text(
            "Uncheck to hide this item without deleting it")
        self.visible_check.connect("toggled", self.on_visible_toggled)
        right_box.pack_start(self.visible_check, False, False, 0)

        right_scroll = Gtk.ScrolledWindow()
        right_scroll.set_policy(Gtk.PolicyType.NEVER,
                                Gtk.PolicyType.AUTOMATIC)
        right_scroll.add(right_box)
        right_scroll.set_size_request(260, -1)

        # Second paned: (menus+tree) | properties.
        paned2 = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        # Re-parent: paned currently holds left+mid; wrap it with right.
        paned_parent = paned.get_parent()
        paned_parent.remove(paned)
        paned2.pack1(paned, True, False)
        paned2.pack2(right_scroll, False, False)
        paned2.set_position(700)
        self.root.pack_start(paned2, True, True, 0)
        # Remove the earlier direct pack of paned (we re-packed above).
        # NOTE: paned was packed into self.root via pack_start earlier;
        # the remove/re-pack above handles the hierarchy correctly.

        self._refresh_toolbar_state()

    # -- refresh ------------------------------------------------------------

    def refresh_all(self):
        """Rebuild the menu list and the tree from the document."""
        self._rebuild_menu_list()
        self._rebuild_tree()
        self.refresh_props()
        self._refresh_toolbar_state()

    def _rebuild_menu_list(self):
        """Fill the left menu list from the document."""
        sel_key = self._selected_menu_key()
        self.menu_store.clear()
        if not self.doc:
            return
        for key in self.doc.get("menus", {}):
            menu = self.doc["menus"][key]
            title = menu.get("title") or key
            self.menu_store.append([key, title])
        # Restore selection.
        if sel_key:
            for row in self.menu_store:
                if row[0] == sel_key:
                    self.menu_tree.get_selection().select_iter(row.iter)
                    return
        # Default: select the first menu.
        first = self.menu_store.get_iter_first()
        if first:
            self.menu_tree.get_selection().select_iter(first)

    def _selected_menu_key(self):
        """Menu key currently selected in the left list, or None."""
        sel = self.menu_tree.get_selection().get_selected()
        if sel and sel[1]:
            return self.menu_store[sel[1]][0]
        return None

    def _selected_menu(self):
        """The selected menu dict, or None."""
        key = self._selected_menu_key()
        if key and self.doc:
            return self.doc.get("menus", {}).get(key)
        return None

    def _rebuild_tree(self):
        """Fill the middle tree: groups (expandable) + items."""
        self.tree_store.clear()
        menu = self._selected_menu()
        if not menu:
            return
        # Groups first (each expandable with its items underneath).
        for grp in menu.get("groups", []):
            gname = grp.get("name", "Group")
            giter = self.tree_store.append(
                None, [f"📁 {gname} ({len(grp.get('items', []))})",
                       "group", grp])
            for item in grp.get("items", []):
                self._append_item_row(giter, item)
        # Ungrouped items under a header row.
        ungrouped = menu.get("ungrouped", [])
        if ungrouped:
            hiter = self.tree_store.append(
                None, [f"Ungrouped ({len(ungrouped)})",
                       "grouphdr", None])
            for item in ungrouped:
                self._append_item_row(hiter, item)
        self.tree.expand_all()

    def _append_item_row(self, parent, item):
        """Add one item row under a group/header, with visibility mark."""
        label = item.get("label", item.get("id", "?"))
        mark = "" if item.get("visible", True) else " 🚫"
        self.tree_store.append(parent, [f"{label}{mark}", "item", item])

    def _selected_row(self):
        """(kind, ref) of the selected tree row, or (None, None)."""
        sel = self.tree.get_selection().get_selected()
        if sel and sel[1]:
            return self.tree_store[sel[1]][_COL_KIND], \
                self.tree_store[sel[1]][_COL_REF]
        return None, None

    # -- selection -----------------------------------------------------------

    def on_menu_selected(self, _selection):
        """Left list changed: rebuild the tree for the new menu."""
        self._rebuild_tree()
        self.refresh_props()
        self._refresh_toolbar_state()

    def on_tree_selected(self, _selection):
        """Tree selection changed: refresh properties + toolbar."""
        self.refresh_props()
        self._refresh_toolbar_state()

    def on_row_activated(self, _tree, path, _col):
        """Double-click a group expands/collapses it (default behavior)."""
        pass  # GTK handles expand/collapse natively

    def refresh_props(self):
        """
        Fill the properties panel. The description is ALWAYS shown for
        the selected item (Joshua's rule).
        """
        self._updating = True
        try:
            kind, ref = self._selected_row()
            if kind == "item" and isinstance(ref, dict):
                self.kind_label.set_markup(
                    "<small><i>Menu item</i></small>")
                self.label_entry.set_text(ref.get("label", ""))
                self.label_entry.set_sensitive(True)
                desc = ref.get("description", "")
                self.desc_label.set_text(desc if desc else "—")
                self.desc_entry.set_text(desc)
                self.desc_entry.set_sensitive(True)
                self.action_label.set_text(ref.get("action", "—") or "—")
                self.id_label.set_text(ref.get("id", "—") or "—")
                self.visible_check.set_active(bool(ref.get("visible",
                                                           True)))
                self.visible_check.set_sensitive(True)
            elif kind == "group" and isinstance(ref, dict):
                self.kind_label.set_markup(
                    "<small><i>Group</i></small>")
                self.label_entry.set_text(ref.get("name", ""))
                self.label_entry.set_sensitive(True)
                n = len(ref.get("items", []))
                self.desc_label.set_text(
                    f"A group containing {n} item(s). "
                    f"Delete the group to return its items to the menu.")
                self.desc_entry.set_text("")
                self.desc_entry.set_sensitive(False)
                self.action_label.set_text("—")
                self.id_label.set_text("—")
                self.visible_check.set_sensitive(False)
            else:
                self.kind_label.set_markup(
                    "<small><i>Select a menu item</i></small>")
                self.label_entry.set_text("")
                self.label_entry.set_sensitive(False)
                self.desc_label.set_text("—")
                self.desc_entry.set_text("")
                self.desc_entry.set_sensitive(False)
                self.action_label.set_text("—")
                self.id_label.set_text("—")
                self.visible_check.set_sensitive(False)
        finally:
            self._updating = False

    def _refresh_toolbar_state(self):
        """Enable/disable toolbar buttons based on the selection."""
        kind, _ref = self._selected_row()
        has_menu = self._selected_menu() is not None
        is_item = kind == "item"
        is_group = kind == "group"
        self.btn_group.set_sensitive(has_menu)
        self.btn_to_group.set_sensitive(is_item)
        self.btn_up.set_sensitive(is_item)
        self.btn_down.set_sensitive(is_item)
        self.btn_rename_group.set_sensitive(is_group)
        self.btn_del_group.set_sensitive(is_group)

    # -- property edits --------------------------------------------------------

    def on_label_changed(self, entry):
        """Label/group-name edit: write back to the selected row."""
        if self._updating:
            return
        kind, ref = self._selected_row()
        if kind == "item" and isinstance(ref, dict):
            ref["label"] = entry.get_text()
            self._mark_dirty()
            self._rebuild_tree_keep_selection()
        elif kind == "group" and isinstance(ref, dict):
            ref["name"] = entry.get_text()
            self._mark_dirty()
            self._rebuild_tree_keep_selection()

    def on_desc_changed(self, entry):
        """Description edit: write back to the selected item."""
        if self._updating:
            return
        kind, ref = self._selected_row()
        if kind == "item" and isinstance(ref, dict):
            ref["description"] = entry.get_text()
            self.desc_label.set_text(entry.get_text() or "—")
            self._mark_dirty()

    def on_visible_toggled(self, check):
        """Visibility toggle: write back to the selected item."""
        if self._updating:
            return
        kind, ref = self._selected_row()
        if kind == "item" and isinstance(ref, dict):
            ref["visible"] = check.get_active()
            self._mark_dirty()
            self._rebuild_tree_keep_selection()

    def _mark_dirty(self):
        """Flag unsaved changes and notify the app (close warning)."""
        self._dirty = True
        try:
            self.app._unpublished = True
        except Exception:
            pass

    def _rebuild_tree_keep_selection(self):
        """Rebuild the tree, then re-select the same item/group."""
        kind, ref = self._selected_row()
        sel_id = None
        if kind == "item" and isinstance(ref, dict):
            sel_id = ("item", ref.get("id"))
        elif kind == "group" and isinstance(ref, dict):
            sel_id = ("group", id(ref))
        self._rebuild_tree()
        if sel_id:
            for row in self.tree_store:
                if self._row_matches(row, sel_id):
                    self.tree.get_selection().select_iter(row.iter)
                    break
                for child in row.iterchildren():
                    if self._row_matches(child, sel_id):
                        self.tree.get_selection().select_iter(child.iter)
                        break

    @staticmethod
    def _row_matches(row, sel_id):
        """Check if a tree row matches the saved (kind, id) selection."""
        kind = row[_COL_KIND]
        ref = row[_COL_REF]
        if not isinstance(ref, dict):
            return False
        if sel_id[0] == "item" and kind == "item":
            return ref.get("id") == sel_id[1]
        if sel_id[0] == "group" and kind == "group":
            return id(ref) == sel_id[1]
        return False

    # -- group operations ------------------------------------------------------

    def on_create_group(self, _btn):
        """Create a new named group in the selected menu."""
        menu = self._selected_menu()
        if not menu:
            return
        dlg = Gtk.Dialog(title="Create Group", transient_for=self.app.window,
                         flags=0)
        dlg.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dlg.add_button("Create", Gtk.ResponseType.OK)
        entry = Gtk.Entry()
        entry.set_placeholder_text("Group name")
        entry.set_activates_default(True)
        dlg.get_content_area().pack_start(entry, True, True, 12)
        dlg.set_default_response(Gtk.ResponseType.OK)
        dlg.show_all()
        resp = dlg.run()
        name = entry.get_text().strip()
        dlg.destroy()
        if resp != Gtk.ResponseType.OK or not name:
            return
        menu.setdefault("groups", []).append({"name": name, "items": []})
        self._mark_dirty()
        self._rebuild_tree()
        self.app.set_status(f"Created group '{name}'")

    def on_rename_group(self, _btn):
        """Rename the selected group (label entry already edits it)."""
        # The label entry in the properties panel edits the group name
        # live; this button just focuses it for discoverability.
        self.label_entry.grab_focus()

    def on_delete_group(self, _btn):
        """
        Delete the selected group. Its items move back to the menu's
        ungrouped list (nothing is lost).
        """
        kind, ref = self._selected_row()
        menu = self._selected_menu()
        if kind != "group" or not isinstance(ref, dict) or not menu:
            return
        name = ref.get("name", "Group")
        items = ref.get("items", [])
        dlg = Gtk.MessageDialog(
            transient_for=self.app.window,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.YES_NO,
            text=f"Delete group '{name}'?")
        dlg.format_secondary_text(
            f"Its {len(items)} item(s) will move back to the menu "
            f"(nothing is deleted).")
        resp = dlg.run()
        dlg.destroy()
        if resp != Gtk.ResponseType.YES:
            return
        menu["groups"].remove(ref)
        menu.setdefault("ungrouped", []).extend(items)
        self._mark_dirty()
        self._rebuild_tree()
        self.refresh_props()
        self._refresh_toolbar_state()
        self.app.set_status(f"Deleted group '{name}' — items moved to menu")

    def on_move_to_group(self, _btn):
        """
        Move the selected item to a different group (or to ungrouped).
        Shows a dialog listing every group in the current menu.
        """
        kind, ref = self._selected_row()
        menu = self._selected_menu()
        if kind != "item" or not isinstance(ref, dict) or not menu:
            return
        # Build the destination list: each group + "Ungrouped".
        dests = []  # (label, target_list)
        for grp in menu.get("groups", []):
            # Skip the group the item is already in.
            if ref in grp.get("items", []):
                continue
            dests.append((f"📁 {grp.get('name', 'Group')}",
                          grp.setdefault("items", [])))
        # "Ungrouped" unless the item is already there.
        if ref not in menu.get("ungrouped", []):
            dests.append(("Ungrouped", menu.setdefault("ungrouped", [])))
        if not dests:
            self.app.set_status("Item is already in the only group")
            return
        dlg = Gtk.Dialog(title="Move to Group",
                         transient_for=self.app.window, flags=0)
        dlg.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dlg.add_button("Move", Gtk.ResponseType.OK)
        combo = Gtk.ComboBoxText()
        for label, _lst in dests:
            combo.append_text(label)
        combo.set_active(0)
        dlg.get_content_area().pack_start(combo, True, True, 12)
        dlg.set_default_response(Gtk.ResponseType.OK)
        dlg.show_all()
        resp = dlg.run()
        idx = combo.get_active()
        dlg.destroy()
        if resp != Gtk.ResponseType.OK or idx < 0:
            return
        self._remove_item_from_menu(menu, ref)
        dests[idx][1].append(ref)
        self._mark_dirty()
        self._rebuild_tree()
        self.refresh_props()
        self._refresh_toolbar_state()
        self.app.set_status(f"Moved '{ref.get('label')}' to {dests[idx][0]}")

    @staticmethod
    def _remove_item_from_menu(menu, item):
        """Remove an item dict from wherever it lives in the menu."""
        for grp in menu.get("groups", []):
            if item in grp.get("items", []):
                grp["items"].remove(item)
                return
        if item in menu.get("ungrouped", []):
            menu["ungrouped"].remove(item)

    # -- reorder -----------------------------------------------------------------

    def _item_location(self):
        """
        Find the selected item's container list and index.
        Returns (list, index) or (None, None).
        """
        kind, ref = self._selected_row()
        menu = self._selected_menu()
        if kind != "item" or not isinstance(ref, dict) or not menu:
            return None, None
        for grp in menu.get("groups", []):
            items = grp.get("items", [])
            if ref in items:
                return items, items.index(ref)
        ungrouped = menu.get("ungrouped", [])
        if ref in ungrouped:
            return ungrouped, ungrouped.index(ref)
        return None, None

    def on_move_up(self, _btn):
        """Move the selected item one slot up within its list."""
        lst, idx = self._item_location()
        if lst is None or idx <= 0:
            return
        lst[idx - 1], lst[idx] = lst[idx], lst[idx - 1]
        self._mark_dirty()
        self._rebuild_tree_keep_selection()

    def on_move_down(self, _btn):
        """Move the selected item one slot down within its list."""
        lst, idx = self._item_location()
        if lst is None or idx < 0 or idx >= len(lst) - 1:
            return
        lst[idx + 1], lst[idx] = lst[idx], lst[idx + 1]
        self._mark_dirty()
        self._rebuild_tree_keep_selection()

    # -- save ----------------------------------------------------------------------

    def on_save(self, _btn):
        """
        Save: serialize the menu document and stage menu_layout.json for
        the next push. The existing Resources-tab push dialog sends it to
        GitHub, and the game fetches it at startup.
        """
        try:
            payload = json.dumps(self.doc, indent=2)
        except Exception as e:
            self.app.set_status(f"Could not serialize menus: {e}")
            return
        staged = stage_content("menu_layout.json", payload.encode("utf-8"))
        if staged:
            self._dirty = False
            try:
                self.app._unpublished = True
            except Exception:
                pass
            self.app.set_status(
                "Menus saved — push from the Resources tab to go live")
