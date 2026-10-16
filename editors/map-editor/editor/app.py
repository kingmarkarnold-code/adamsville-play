#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) — Main GTK application.

Pure Python + GTK3 + Cairo. NO webview, NO HTML, NO JavaScript.
Native toolbar, canvas, dialogs, and menus.

Joshua's rule: all code commented.
"""

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

import copy  # noqa: E402 -- deepcopy for undo/redo map-state snapshots
import threading

import github_sync  # noqa: E402 -- suite auto-push + close warning
from about import show_about_dialog
# v1.8.2 (Joshua 2026-10-12): soft import for updater — if updater.py is
# missing or broken (partial install, failed in-place update), the editor
# must still open. The Help -> Check for Updates item is only added when
# the import succeeds.
try:
    import updater  # noqa: E402 -- Help -> Check for Updates (in-place updater)
    _UPDATER_AVAILABLE = True
except Exception:
    updater = None
    _UPDATER_AVAILABLE = False
from undo import UndoManager, UndoCommand  # noqa: E402 -- undo/redo stacks
from data import (
    ensure_data_dir, needs_download, download_roads, load_roads,
    get_remote_sha, save_local_sha,
    SpatialIndex, ZONES, zone_bbox,
    save_window_state, load_window_state,
    normalize_category, CATEGORY_ORDER, CATEGORY_LABELS,
    DIVIDABLE_CATEGORIES, DIVIDER_TYPES,
    load_overpasses, save_overpasses, download_overpasses,
    export_overpasses,
)
from mapcanvas import MapCanvas, _direction_words
from roadinspect import RoadInspectorPanel  # noqa: E402 -- 3D road inspector
# Overpass linking + smart pillar placement (Joshua 2026-10-11).
import overpass as overpass_mod  # noqa: E402


# App version shown in the Help -> About dialog (bump with each release).
# Joshua 2026-10-11: version number must be prominent in About.
APP_VERSION = "1.8.4"
# Display name and icon-theme name for the About dialog.
APP_NAME = "Adamsville Map Editor"
APP_ICON = "adamsville-map-editor-native"
APP_PACKAGE = "adamsville-map-editor-native"
# In-place updater (Joshua 2026-10-12): Help -> Check for
# Updates downloads new editor files from GitHub and applies
# them in place, so reinstalling the .deb is not needed.
UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/kingmarkarnold-code/adamsville-map-editor/main/version.json"
UPDATE_SLUG = "map-editor"



# ---------------------------------------------------------------------------
# Tool definitions for toolbar and help dialog
# ---------------------------------------------------------------------------

# Each tool: (id, label, tooltip, help_text)
TOOLS = [
    ("pan",     "Pan",     "Drag to move the map",
     "Pan: Click and drag to move around the map. Mouse wheel zooms."),
    ("select",  "Select",  "Click roads to select them (up to 2)",
     "Select: Click a road to select it; click it again to deselect. "
     "Select 2 roads, then click Merge or Join in the toolbar. "
     "Escape or clicking empty space clears the selection."),
    ("zone",    "Zone",    "Select and edit zones",
     "Zone: Click a zone to select it and show its pins. Drag a pin to "
     "reshape the boundary. Click a boundary edge to add a new pin there. "
     "Edits are saved locally."),
    ("fill",    "Fill",    "Fill an unzoned gap with a new zone",
     "Fill: Click on an unzoned gap between zones. The tool traces the "
     "surrounding boundaries and creates a new zone filling that exact "
     "shape. The new zone is selected with the Zone tool for refining."),
    ("draw",    "Draw",    "Draw a new road",
     "Draw Road: Click to place points, double-click to finish. (Coming soon)"),
    ("cut",     "Cut",     "Cut a road into segments",
     "Cut: Click two points on a road to split it. (Coming soon)"),
    ("delete",  "Delete",  "Delete the selected road",
     "Delete: Removes the currently selected road. (Coming soon)"),
    ("extend",  "Extend",  "Stretch a road endpoint",
     "Extend: Click on or near a road — the CLOSEST endpoint (either end) "
     "is auto-selected and highlighted. Then click the destination point "
     "and the road stretches there."),
]


class MapEditorApp:
    """Main application class."""

    def __init__(self):
        """Build the UI and initialize state."""
        self.spatial_index = None
        self.roads_data = None
        # Overpasses (Joshua 2026-10-11): bridge structures that roads
        # can link to. Loaded in _load_data(); empty until then.
        self.overpasses = []
        # Categories with unsaved road edits (join/merge/extend/delete).
        # persist_road_edits() writes these to road_edits.json.
        self._dirty_road_cats = set()

        # Undo/redo (Joshua 2026-10-12: "The map editor needs a undo").
        # Command-pattern stacks, 50 steps deep. Each edit operation
        # snapshots the full map state before/after via undo_begin() /
        # undo_commit() so one logical edit = one undo step.
        self.undo_manager = UndoManager(max_depth=50)
        # Pending transaction: (label, before_snapshot) set by
        # undo_begin(), consumed by undo_commit(). None when idle.
        self._undo_pending = None
        # Undo/redo UI widgets (created in _build_menubar /
        # _build_toolbar); kept here so _refresh_undo_ui() can reach
        # them even if called before the widgets exist.
        self.undo_item = None
        self.redo_item = None
        self.undo_button = None
        self.redo_button = None

        # Unpublished-changes tracking (Joshua 2026-10-11): True when
        # local edits haven't been pushed to GitHub yet.
        self._unpublished = False
        self._token_prompted = False
        # Word-style auto-push: every 5 minutes if there are unpublished
        # changes and a GitHub token is set (Joshua 2026-10-11).
        from gi.repository import GLib as _GLib
        _GLib.timeout_add_seconds(300, self._auto_push_tick)

        # --- Main window ---
        # Native GTK window with standard decorations (min/max/close)
        self.window = Gtk.Window(title="Adamsville Map Editor")
        self.window.set_default_size(1280, 800)
        self.window.connect("delete-event", self.on_window_close)
        # Escape clears in-progress Join/Merge/Extend selections.
        self.window.connect("key-press-event", self.on_key_press)

        # Restore previous window geometry
        self._restore_window()

        # --- Layout: vertical box ---
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.window.add(vbox)

        # --- Menu bar ---
        menubar = self._build_menubar()
        vbox.pack_start(menubar, False, False, 0)

        # --- Toolbar ---
        toolbar = self._build_toolbar()
        vbox.pack_start(toolbar, False, False, 0)

        # --- Canvas + 3D inspector in a horizontal paned ---
        # Left: the 2D map canvas. Right: the dockable 3D road inspection
        # panel (Joshua 2026-10-11). The sash lets Joshua resize them.
        self.canvas = MapCanvas(self)
        self.main_paned = Gtk.HPaned()
        self.main_paned.pack1(self.canvas, resize=True, shrink=False)

        # Inspector wrap: collapse strip on the left edge + the panel.
        # The strip stays visible when collapsed so Joshua can re-expand.
        self.inspector = RoadInspectorPanel(self)
        insp_wrap = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                            spacing=0)
        self.insp_toggle = Gtk.Button(label="◀")
        self.insp_toggle.set_tooltip_text("Hide 3D inspector")
        self.insp_toggle.set_relief(Gtk.ReliefStyle.NONE)
        self.insp_toggle.set_size_request(26, -1)
        self.insp_toggle.connect("clicked", self.toggle_inspector)
        self.insp_collapsed = False
        insp_wrap.pack_start(self.insp_toggle, False, False, 0)
        insp_wrap.pack_start(self.inspector, True, True, 0)
        self.main_paned.pack2(insp_wrap, resize=False, shrink=False)
        self.main_paned.set_position(980)  # canvas gets most of the width
        vbox.pack_start(self.main_paned, True, True, 0)

        # Default tool is Select (Joshua 2026-10-11: select-first
        # workflow — pick roads first, then Merge/Join). This fires
        # on_tool_toggled, which sets canvas.active_tool.
        self.tool_buttons["select"].set_active(True)

        # --- Status bar ---
        self.statusbar = Gtk.Statusbar()
        self.status_ctx = self.statusbar.get_context_id("main")
        vbox.pack_start(self.statusbar, False, False, 0)
        self.set_status("Select 2 roads, then click Merge or Join")

        self.window.show_all()

        # Fit view after window is realized (needs allocation)
        GLib.idle_add(self._initial_setup)

    # ------------------------------------------------------------------
    # Window geometry
    # ------------------------------------------------------------------

    def _restore_window(self):
        """Restore saved window position/size from previous session."""
        state = load_window_state()
        if state:
            self.window.move(state.get("x", 100), state.get("y", 100))
            self.window.set_default_size(
                state.get("width", 1280), state.get("height", 800))
            if state.get("maximized"):
                self.window.maximize()

    def on_window_close(self, widget, event):
        """
        Save window geometry before closing.
        If there are unpublished changes, ask Joshua what to do
        (Joshua 2026-10-11).
        """
        # Persist any pending in-memory road edits first so the
        # dirty check sees the true state.
        self.persist_road_edits()
        if self._unpublished:
            choice = self._show_close_warning()
            if choice == "cancel":
                return True  # don't close
            if choice == "push":
                # Push via API if token is set, else open manual dialog.
                self.on_push_clicked(None)
        x, y = self.window.get_position()
        w, h = self.window.get_size()
        maximized = self.window.is_maximized()
        save_window_state(x, y, w, h, maximized)
        Gtk.main_quit()
        return False

    def on_key_press(self, widget, event):
        """
        Global key handler.
        Escape: clear Join/Merge/Extend in-progress selections.
        Ctrl+Z: undo. Ctrl+Y or Ctrl+Shift+Z: redo.
        (Joshua 2026-10-12: undo/redo keyboard shortcuts.)
        Move-road mode (Joshua 2026-10-12): Enter drops the road,
        Escape cancels the move.
        """
        # Move-road mode is modal: Enter commits the drop, Escape
        # cancels. Handled before anything else.
        if getattr(self.canvas, "move_road", None) is not None:
            if event.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter):
                snap = not (event.state & Gdk.ModifierType.SHIFT_MASK)
                self.canvas.commit_move_road(snap=snap)
                return True
            if event.keyval == Gdk.KEY_Escape:
                self.canvas.cancel_move_road()
                return True
        if event.keyval == Gdk.KEY_Escape:
            self.canvas.clear_tool_state()
            self.set_status("Selection cleared.")
            return True
        # Ctrl+Z = undo; Ctrl+Shift+Z = redo (also Ctrl+Y = redo).
        # GDK reports Shift+Ctrl+Z as "Z" (uppercase) with the shift
        # modifier, so check both keyval and modifiers.
        ctrl = event.state & Gdk.ModifierType.CONTROL_MASK
        shift = event.state & Gdk.ModifierType.SHIFT_MASK
        if ctrl:
            # Don't hijack text editing: if a text entry/field has
            # focus, let it handle Ctrl+Z itself.
            try:
                focus = self.window.get_focus()
                if isinstance(focus, (Gtk.Entry, Gtk.TextView,
                                      Gtk.SearchEntry)):
                    return False
            except Exception:
                pass
            key = Gdk.keyval_name(event.keyval) or ""
            key_lower = key.lower()
            if key_lower == "z" and not shift:
                self.on_undo_clicked()
                return True
            if (key_lower == "z" and shift) or key_lower == "y":
                self.on_redo_clicked()
                return True
        return False

    # ------------------------------------------------------------------
    # Menu bar
    # ------------------------------------------------------------------

    def _build_menubar(self):
        """Build the native GTK menu bar: File, View, Help."""
        menubar = Gtk.MenuBar()

        # --- File menu ---
        file_menu = Gtk.Menu()
        file_item = Gtk.MenuItem(label="File")
        file_item.set_submenu(file_menu)

        download_item = Gtk.MenuItem(label="Download from GitHub…")
        download_item.connect("activate", self.on_download_clicked)
        file_menu.append(download_item)

        push_item = Gtk.MenuItem(label="Push to GitHub…")
        push_item.connect("activate", self.on_push_clicked)
        file_menu.append(push_item)

        settings_item = Gtk.MenuItem(label="Settings…")
        settings_item.connect("activate", self.on_settings_clicked)
        file_menu.append(settings_item)

        file_menu.append(Gtk.SeparatorMenuItem())

        quit_item = Gtk.MenuItem(label="Quit")
        quit_item.connect("activate", lambda w: self.window.destroy())
        file_menu.append(quit_item)

        menubar.append(file_item)

        # --- Edit menu ---
        # Undo/Redo (Joshua 2026-10-12): command-pattern history, 50
        # steps. Labels show what will be undone/redone, e.g.
        # "Undo: Join Roads". Disabled when the stacks are empty.
        edit_menu = Gtk.Menu()
        edit_item = Gtk.MenuItem(label="Edit")
        edit_item.set_submenu(edit_menu)

        self.undo_item = Gtk.MenuItem(label="Undo")
        self.undo_item.set_tooltip_text("Undo the last edit (Ctrl+Z)")
        self.undo_item.connect("activate", self.on_undo_clicked)
        self.undo_item.set_sensitive(False)  # nothing to undo yet
        edit_menu.append(self.undo_item)

        self.redo_item = Gtk.MenuItem(label="Redo")
        self.redo_item.set_tooltip_text(
            "Redo the last undone edit (Ctrl+Y)")
        self.redo_item.connect("activate", self.on_redo_clicked)
        self.redo_item.set_sensitive(False)  # nothing to redo yet
        edit_menu.append(self.redo_item)

        edit_menu.append(Gtk.SeparatorMenuItem())

        # Joshua 2026-10-11: road appearance (width, paint, sidewalks).
        # Only enabled when at least one road is selected.
        self.edit_road_item = Gtk.MenuItem(label="Road Appearance…")
        self.edit_road_item.set_tooltip_text(
            "Change the selected road's width, lane markings, and "
            "border sidewalks")
        self.edit_road_item.connect("activate", self.on_road_appearance)
        self.edit_road_item.set_sensitive(False)  # no selection yet
        edit_menu.append(self.edit_road_item)

        # Divide Road Section (Joshua 2026-10-11): segmentable
        # medians/dividers on major arteries, highways, interstates.
        # Enabled when exactly one dividable road is selected.
        self.divide_item = Gtk.MenuItem(label="Divide Road Section…")
        self.divide_item.set_tooltip_text(
            "Add a median/divider to part of the selected road")
        self.divide_item.connect("activate", self.on_divide_section)
        self.divide_item.set_sensitive(False)  # no selection yet
        edit_menu.append(self.divide_item)

        # Move Road (Joshua 2026-10-12): pick up an entire road and
        # relocate it, preserving its shape. Enabled when exactly one
        # road is selected.
        self.move_road_item = Gtk.MenuItem(label="Move Road…")
        self.move_road_item.set_tooltip_text(
            "Pick up the selected road and move it to a new location")
        self.move_road_item.connect("activate", self.on_move_road)
        self.move_road_item.set_sensitive(False)  # no selection yet
        edit_menu.append(self.move_road_item)

        menubar.append(edit_item)

        # --- View menu ---
        view_menu = Gtk.Menu()
        view_item = Gtk.MenuItem(label="View")
        view_item.set_submenu(view_menu)

        fit_item = Gtk.MenuItem(label="Fit to World")
        fit_item.connect("activate", lambda w: self.canvas.fit_view())
        view_menu.append(fit_item)

        check_item = Gtk.MenuItem(label="Check for Updates")
        check_item.connect("activate", self.on_check_updates)
        view_menu.append(check_item)

        menubar.append(view_item)

        # --- Zones menu ---
        zones_menu = Gtk.Menu()
        zones_item = Gtk.MenuItem(label="Zones")
        zones_item.set_submenu(zones_menu)
        # Keep a reference so Fill Unzoned Area can add new zones to it
        self.zones_menu = zones_menu
        self._rebuild_zones_menu()

        menubar.append(zones_item)

        # --- Help menu ---
        help_menu = Gtk.Menu()
        help_item = Gtk.MenuItem(label="Help")
        help_item.set_submenu(help_menu)

        tools_item = Gtk.MenuItem(label="Tool Glossary")
        tools_item.connect("activate", self.show_help)
        help_menu.append(tools_item)

        # v1.8.2: only offer in-place updates when updater.py imported OK.
        # (A missing/broken updater must never stop the editor opening.)
        if _UPDATER_AVAILABLE:
            update_item = Gtk.MenuItem(label="Check for Updates")
            update_item.connect("activate", self.on_check_app_updates)
            help_menu.append(update_item)

        about_item = Gtk.MenuItem(label="About")
        about_item.connect("activate", self.show_about)
        help_menu.append(about_item)

        menubar.append(help_item)

        return menubar

    # ------------------------------------------------------------------
    # Toolbar
    # ------------------------------------------------------------------

    def _build_toolbar(self):
        """Build the native GTK toolbar with tool buttons."""
        toolbar = Gtk.Toolbar()
        toolbar.set_style(Gtk.ToolbarStyle.BOTH)  # icon + text

        # Undo/Redo buttons first (Joshua 2026-10-12): standard icons,
        # disabled until there is something to undo/redo.
        self.undo_button = Gtk.ToolButton.new_from_stock(Gtk.STOCK_UNDO)
        self.undo_button.set_tooltip_text("Undo (nothing to undo)")
        self.undo_button.connect("clicked", self.on_undo_clicked)
        self.undo_button.set_sensitive(False)
        toolbar.insert(self.undo_button, -1)

        self.redo_button = Gtk.ToolButton.new_from_stock(Gtk.STOCK_REDO)
        self.redo_button.set_tooltip_text("Redo (nothing to redo)")
        self.redo_button.connect("clicked", self.on_redo_clicked)
        self.redo_button.set_sensitive(False)
        toolbar.insert(self.redo_button, -1)

        toolbar.insert(Gtk.SeparatorToolItem(), -1)

        self.tool_buttons = {}
        first_button = None

        for tool_id, label, tooltip, _ in TOOLS:
            # Radio buttons so only one tool is active at a time
            if first_button is None:
                btn = Gtk.RadioToolButton(label=label)
                first_button = btn
            else:
                btn = Gtk.RadioToolButton.new_from_widget(first_button)
                btn.set_label(label)
            btn.set_tooltip_text(tooltip)
            # Capture tool_id in default arg
            btn.connect("toggled", self.on_tool_toggled, tool_id)
            toolbar.insert(btn, -1)
            self.tool_buttons[tool_id] = btn

        # Separator, then Merge / Join action buttons (Joshua 2026-10-11:
        # select-first workflow — select 2 roads first, then click one).
        # These are plain action buttons, NOT radio tools.
        toolbar.insert(Gtk.SeparatorToolItem(), -1)

        self.merge_button = Gtk.ToolButton(label="Merge")
        self.merge_button.set_tooltip_text(
            "Merge the 2 selected roads (connect for traffic flow). "
            "First selected = source, second = target.")
        self.merge_button.connect("clicked", self.on_merge_clicked)
        self.merge_button.set_sensitive(False)
        toolbar.insert(self.merge_button, -1)

        self.join_button = Gtk.ToolButton(label="Join")
        self.join_button.set_tooltip_text(
            "Join the 2 selected roads into one road object "
            "(keeps the first road's name).")
        self.join_button.connect("clicked", self.on_join_clicked)
        self.join_button.set_sensitive(False)
        toolbar.insert(self.join_button, -1)

        # Link to Overpass action button (Joshua 2026-10-11).
        # Select 1 road first, then click this, then click an overpass
        # deck on the map. The terrain ramps up to the deck, the road
        # connects, and the overpass takes the road's street name.
        self.link_overpass_button = Gtk.ToolButton(label="Link to Overpass")
        self.link_overpass_button.set_tooltip_text(
            "Link the selected road to an overpass: lifts the terrain "
            "as a smooth ramp, connects the road to the deck, and "
            "renames the overpass to the road's street name. "
            "Select 1 road first, then click an overpass.")
        self.link_overpass_button.connect(
            "clicked", self.on_link_overpass_clicked)
        self.link_overpass_button.set_sensitive(False)
        toolbar.insert(self.link_overpass_button, -1)

        # Separator
        toolbar.insert(Gtk.SeparatorToolItem(), -1)

        # Zoom in button
        zin = Gtk.ToolButton.new_from_stock(Gtk.STOCK_ZOOM_IN)
        zin.set_tooltip_text("Zoom in")
        zin.connect("clicked", self.on_zoom_in)
        toolbar.insert(zin, -1)

        # Zoom out button
        zout = Gtk.ToolButton.new_from_stock(Gtk.STOCK_ZOOM_OUT)
        zout.set_tooltip_text("Zoom out")
        zout.connect("clicked", self.on_zoom_out)
        toolbar.insert(zout, -1)

        # Fit button
        zfit = Gtk.ToolButton.new_from_stock(Gtk.STOCK_ZOOM_FIT)
        zfit.set_tooltip_text("Fit to world")
        zfit.connect("clicked", lambda w: self.canvas.fit_view())
        toolbar.insert(zfit, -1)

        # Separator + gear button for Settings (GitHub API key management).
        # Joshua 2026-10-11: key must be changeable in-app, no reinstall.
        sep = Gtk.SeparatorToolItem()
        toolbar.insert(sep, -1)
        gear = Gtk.ToolButton.new_from_stock(Gtk.STOCK_PREFERENCES)
        gear.set_tooltip_text("Settings — GitHub API key")
        gear.connect("clicked", self.on_settings_clicked)
        toolbar.insert(gear, -1)

        return toolbar

    def toggle_inspector(self):
        """Collapse/expand the 3D road inspector panel."""
        self.insp_collapsed = not self.insp_collapsed
        if self.insp_collapsed:
            self.inspector.hide()
            self.insp_toggle.set_label("▶")
            self.insp_toggle.set_tooltip_text("Show 3D inspector")
        else:
            self.inspector.show()
            self.insp_toggle.set_label("◀")
            self.insp_toggle.set_tooltip_text("Hide 3D inspector")

    def on_tool_toggled(self, button, tool_id):
        """Handle toolbar tool selection."""
        if button.get_active():
            # Clear any in-progress selections when switching tools so
            # stale highlights don't linger.
            self.canvas.clear_tool_state()
            self.canvas.active_tool = tool_id
            self.set_status(f"Tool: {tool_id}")
            # Joshua 2026-10-11: Fill is ONLY available in Zone mode.
            # Clicking the Zone toolbar button zooms out to the full map
            # first so Joshua sees every zone before filling gaps.
            # (zoom_to_zone sets _skip_zone_fit so the Zones menu keeps
            # its zoom-to-specific-zone behavior.)
            fill_btn = self.tool_buttons.get("fill")
            if fill_btn is not None:
                fill_btn.set_sensitive(tool_id == "zone")
            if tool_id == "zone":
                if not getattr(self, "_skip_zone_fit", False):
                    self.canvas.fit_view()
                self._skip_zone_fit = False

    def on_merge_clicked(self, widget):
        """
        Merge toolbar button: ask for confirmation, then merge the two
        selected roads. First selected = source, second = target.
        (Joshua 2026-10-11: select-first workflow.)
        """
        sel = self.canvas.selected_roads
        if len(sel) != 2:
            return  # button is disabled anyway; belt and suspenders
        names = [self.canvas._road_name_of(c, i) for c, i in sel]
        dialog = Gtk.MessageDialog(
            transient_for=self.window,
            flags=0,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.YES_NO,
            text="Do you want to merge these together?")
        dialog.format_secondary_text(
            f"Source: {names[0]}\nTarget: {names[1]}\n\n"
            f"{names[0]}'s nearest endpoint will snap to the nearest "
            f"point on {names[1]}'s edge. "
            "Both roads stay as separate objects.")
        resp = dialog.run()
        dialog.destroy()
        if resp == Gtk.ResponseType.YES:
            self.canvas.do_merge_from_selection()

    def on_join_clicked(self, widget):
        """
        Join toolbar button: ask for confirmation, then join the two
        selected roads into a single road object.
        (Joshua 2026-10-11: select-first workflow.)
        """
        sel = self.canvas.selected_roads
        if len(sel) != 2:
            return  # button is disabled anyway; belt and suspenders
        names = [self.canvas._road_name_of(c, i) for c, i in sel]
        dialog = Gtk.MessageDialog(
            transient_for=self.window,
            flags=0,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.YES_NO,
            text="Do you want to join these together?")
        dialog.format_secondary_text(
            f"{names[0]}\n{names[1]}\n\n"
            f"They will become one road, keeping {names[0]}'s name, "
            "joined at their nearest endpoints.")
        resp = dialog.run()
        dialog.destroy()
        if resp == Gtk.ResponseType.YES:
            self.canvas.do_join_from_selection()

    # ------------------------------------------------------------------
    # Overpass linking (Joshua 2026-10-11)
    # ------------------------------------------------------------------
    # Workflow: select 1 road → click "Link to Overpass" → click an
    # overpass deck on the map. The system then:
    #   a. Lifts the terrain between the road endpoint and the overpass
    #      as a smooth ramp (grouped with the road, like terrain-road
    #      grouping in the terrain editor).
    #   b. Connects the road's endpoint to the overpass edge.
    #   c. Renames the overpass to the road's street name.
    #   d. Places support pillars (median + outside shoulders) with
    #      lane clearance verification.
    #   e. Enforces minimum 16ft deck clearance for 18-wheelers.

    # Minimum overpass deck clearance in world units (1 unit ≈ 1 ft).
    # Standard US interstate minimum: 16ft accommodates 13.5ft trailers
    # plus a safety margin (Joshua 2026-10-11).
    MIN_DECK_CLEARANCE = 16.0

    def _update_link_overpass_button(self):
        """
        Enable the Link to Overpass button only when exactly 1 road is
        selected (the road to link). Called on selection changes.
        """
        try:
            btn = self.link_overpass_button
        except AttributeError:
            return  # toolbar not built yet during early init
        n = len(self.canvas.selected_roads)
        btn.set_sensitive(n == 1)

    def on_link_overpass_clicked(self, widget):
        """
        Link to Overpass toolbar button: enter targeting mode.
        Joshua clicks an overpass deck on the map to complete the link.
        """
        sel = self.canvas.selected_roads
        if len(sel) != 1:
            return  # button is disabled anyway; belt and suspenders
        self.canvas.link_overpass_mode = True
        self.canvas.link_overpass_hover = None
        road_name = self.canvas._road_name_of(*sel[0])
        self.set_status(
            f"Link to Overpass: '{road_name}' selected — "
            "click an overpass deck on the map (Escape to cancel).")
        self.canvas.queue_draw()

    def _enforce_min_clearance(self, overpass):
        """
        Minimum clearance enforcement (Joshua 2026-10-11): overpasses
        must be tall enough for 18-wheelers (16ft minimum).

        Clearance tiers:
        - 16ft+: all vehicles pass, no restrictions.
        - 9ft-16ft: 18-wheelers cannot pass; auto-place LOW CLEARANCE
          signs and mark truck_restricted for the game's pathfinding.
        - Below 9ft: NOT ALLOWED — raise to 16ft automatically.

        If the deck height is below the minimum, raise it automatically
        and return True (was raised). Otherwise return False.
        """
        deck_h = overpass.get("deck_height",
                              overpass_mod.DEFAULT_DECK_HEIGHT)
        if deck_h < overpass_mod.VAN_HEIGHT_FT:
            # Below van height: not allowed at all. Raise to the
            # 16ft standard.
            overpass["deck_height"] = self.MIN_DECK_CLEARANCE
            overpass["clearance_ft"] = self.MIN_DECK_CLEARANCE
            overpass.pop("truck_restricted", None)
            overpass.pop("low_clearance_signs", None)
            return True
        # Record the clearance for the game and sign rendering.
        overpass["clearance_ft"] = round(deck_h, 1)
        tier = overpass_mod.clearance_tier(deck_h)
        if tier == "full":
            # 16ft+: clear any previous restrictions.
            overpass.pop("truck_restricted", None)
            overpass.pop("low_clearance_signs", None)
        elif tier == "restricted":
            # 9-16ft: mark truck-restricted (signs are placed in
            # complete_overpass_link where we have the road geometry).
            overpass["truck_restricted"] = True
        return False

    def confirm_lower_overpass(self, overpass, new_height):
        """
        Ask for confirmation before lowering an overpass below the
        16ft minimum clearance. Below 9ft (van height) is refused
        outright — the editor will not allow it.

        Returns True if the user confirms (or no warning needed),
        False to cancel/refuse.
        """
        if new_height >= self.MIN_DECK_CLEARANCE:
            return True  # no warning needed
        if new_height < overpass_mod.VAN_HEIGHT_FT:
            # Tier 3: below van height — NOT ALLOWED, no confirmation
            # option. Show an informational dialog instead.
            dialog = Gtk.MessageDialog(
                transient_for=self.window,
                flags=0,
                message_type=Gtk.MessageType.ERROR,
                buttons=Gtk.ButtonsType.OK,
                text="Clearance too low")
            dialog.format_secondary_text(
                f"Overpasses cannot be lower than "
                f"{overpass_mod.VAN_HEIGHT_FT:.0f}ft — vans and cars "
                "could not pass underneath.\n\n"
                "The height was not changed.")
            dialog.run()
            dialog.destroy()
            return False
        # Tier 2: 9-16ft — warn and require confirmation.
        dialog = Gtk.MessageDialog(
            transient_for=self.window,
            flags=0,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.YES_NO,
            text="Clearance below 16ft")
        dialog.format_secondary_text(
            "Clearance below 16ft — 18-wheelers cannot pass underneath.\n\n"
            f"New height: {new_height:.1f}ft (minimum: "
            f"{self.MIN_DECK_CLEARANCE:.0f}ft).\n"
            "A LOW CLEARANCE warning sign will be placed automatically.\n\n"
            "Are you sure you want to lower this overpass?")
        resp = dialog.run()
        dialog.destroy()
        return resp == Gtk.ResponseType.YES

    def complete_overpass_link(self, overpass):
        """
        Complete the Link to Overpass workflow after Joshua clicks an
        overpass deck. Performs the full automatic sequence:
        terrain ramp, road connection, rename, pillars, clearance.
        """
        # Exit targeting mode first.
        self.canvas.link_overpass_mode = False
        self.canvas.link_overpass_hover = None

        sel = self.canvas.selected_roads
        if len(sel) != 1:
            self.set_status("Link cancelled: select exactly 1 road first.")
            self.canvas.queue_draw()
            return
        cat, idx = sel[0]
        road = self.canvas._get_road_dict(cat, idx)
        if road is None:
            self.set_status("Link failed: road no longer available.")
            self.canvas.queue_draw()
            return

        # Undo (Joshua 2026-10-12): snapshot before the link mutates
        # roads/overpasses; one undo step covers the whole sequence.
        self.undo_begin("Link Overpass")

        road_name = road.get("name", "Unnamed")
        road_pts = [list(p) for p in road.get("pts", [])]
        if len(road_pts) < 2:
            self.set_status("Link failed: road has too few points.")
            self.canvas.queue_draw()
            self.undo_discard()  # nothing mutated yet — drop transaction
            return

        # --- Step 1: Enforce minimum clearance (auto-raise if needed).
        raised = self._enforce_min_clearance(overpass)
        if raised:
            self.set_status(
                f"Overpass raised to {self.MIN_DECK_CLEARANCE:.0f}ft "
                "minimum clearance for 18-wheelers.")

        # --- Step 2: Find the road endpoint nearest the overpass.
        end_idx, end_pt = overpass_mod.road_endpoint_to_overpass(
            road_pts, overpass["position"])
        if end_pt is None:
            self.set_status("Link failed: could not find road endpoint.")
            self.canvas.queue_draw()
            # The overpass may have been auto-raised above — commit so
            # that partial change stays undoable instead of leaking.
            self.undo_commit()
            return

        # --- Step 3: Compute the terrain approach ramp.
        # Base height function: sample the terrain editor's heightfield
        # if available, else assume flat (0). We read the shared cache.
        base_h = self._terrain_height_fn()
        ramp_edits = overpass_mod.compute_approach_ramp(
            end_pt, overpass, base_h)

        # --- Step 4: Merge the ramp into the terrain editor's edits.
        # This writes to the shared terrain_edits.json so the terrain
        # editor picks it up (grouped with the road, per Joshua's
        # terrain-road grouping concept).
        self._apply_terrain_ramp(ramp_edits)

        # --- Step 5: Connect the road's endpoint to the overpass edge.
        # Add interpolated points from the endpoint toward the deck.
        ox, oz = overpass["position"]
        # Direction from endpoint to overpass center.
        import math as _math
        dx, dz = ox - end_pt[0], oz - end_pt[1]
        dist = _math.hypot(dx, dz)
        if dist > 1.0:
            # Add 3 intermediate points for a smooth connection.
            new_pts = []
            for i in range(1, 4):
                t = i / 4.0
                new_pts.append([end_pt[0] + dx * t,
                                end_pt[1] + dz * t])
            if end_idx == 0:
                road["pts"] = new_pts[::-1] + road_pts
            else:
                road["pts"] = road_pts + new_pts
            # Record the ramp polyline on the overpass for the
            # gradient rendering.
            ramp_line = [end_pt] + new_pts + [[ox, oz]]
            overpass.setdefault("approach_ramps", []).append({
                "road": road_name,
                "points": [[round(p[0], 2), round(p[1], 2)]
                           for p in ramp_line],
            })

        # --- Step 6: Rename the overpass to the road's street name.
        old_name = overpass.get("name", "Unnamed Overpass")
        overpass["name"] = road_name
        if road_name not in overpass.get("connected_roads", []):
            overpass.setdefault("connected_roads", []).append(road_name)

        # --- Step 7: Smart pillar placement (highway/interstate
        # crossings under this overpass).
        from data import ROAD_STYLE
        pillars, medians_created = overpass_mod.compute_pillars(
            overpass, self.roads_data, ROAD_STYLE)
        if pillars:
            overpass["pillars"] = pillars
        # Mark affected road categories dirty (auto-created medians).
        for med_cat, _ in medians_created:
            self._dirty_road_cats.add(med_cat)

        # --- Step 7b: Clearance tiers — low clearance signs and truck
        # routing flags (Joshua 2026-10-11).
        tier = overpass_mod.clearance_tier(
            overpass.get("deck_height", self.MIN_DECK_CLEARANCE))
        if tier == "restricted":
            # 9-16ft: auto-place LOW CLEARANCE signs in both directions
            # and mark the overpass + approach zone as truck-restricted
            # so the game's 18-wheeler pathfinding routes around it.
            signs = overpass_mod.place_low_clearance_signs(
                overpass, road.get("pts", []))
            if signs:
                overpass["low_clearance_signs"] = signs
            overpass_mod.mark_truck_restricted(overpass, road)

        # --- Step 8: Persist everything.
        save_overpasses(self.overpasses)
        self.apply_road_modify(cat, road)  # persists + rebuilds index
        self._mark_unpublished()
        # Undo (Joshua 2026-10-12): commit the link as one undo step.
        self.undo_commit()
        self.canvas.queue_draw()

        # --- Status summary.
        parts = [f"Linked '{road_name}' to overpass (now '{road_name}')"]
        if ramp_edits:
            parts.append(f"{len(ramp_edits)} terrain cells ramped")
        if pillars:
            parts.append(f"{len(pillars)} pillars placed")
        if medians_created:
            parts.append(
                f"median auto-created under "
                f"{', '.join(n for _, n in medians_created)}")
        # Clearance tier info.
        tier = overpass_mod.clearance_tier(
            overpass.get("deck_height", self.MIN_DECK_CLEARANCE))
        if tier == "restricted":
            signs = overpass.get("low_clearance_signs", [])
            parts.append(
                f"LOW CLEARANCE "
                f"{overpass_mod.format_clearance(overpass['deck_height'])}"
                f" — {len(signs)} warning signs placed, trucks rerouted")
        elif tier == "full":
            parts.append(
                f"{overpass['deck_height']:.0f}ft clearance — all vehicles")
        self.set_status(". ".join(parts) + ".")

    def _terrain_height_fn(self):
        """
        Build a terrain height sampling function for ramp computation.
        Reads the terrain editor's heightfield from the shared cache.
        Falls back to flat (0.0) if no terrain data is available.
        """
        # Try the shared suite cache first, then the terrain editor's
        # own cache. Format: {"h": [150*200 floats], ...} or similar.
        import json as _json
        from pathlib import Path as _Path
        candidates = [
            _Path.home() / ".local" / "share" / "adamsville-suite"
            / "terrain.json",
            _Path.home() / ".local" / "share"
            / "adamsville-terrain-editor-native" / "terrain.json",
        ]
        heights = None
        for p in candidates:
            try:
                if p.exists():
                    doc = _json.loads(p.read_text())
                    h = doc.get("h") or doc.get("heights")
                    if h and len(h) == 150 * 200:
                        heights = [float(v) for v in h]
                        break
            except Exception:
                continue

        if heights is None:
            return lambda x, z: 0.0  # flat fallback

        # Bilinear sampler (same grid as overpass.py).
        def _sample(wx, wz):
            gx = max(0.0, min(150 - 1.001, wx / (8000 / 150)))
            gz = max(0.0, min(200 - 1.001, wz / (12000 / 200)))
            ix0, iz0 = int(gx), int(gz)
            fx, fz = gx - ix0, gz - iz0
            h00 = heights[iz0 * 150 + ix0]
            h10 = heights[iz0 * 150 + ix0 + 1]
            h01 = heights[(iz0 + 1) * 150 + ix0]
            h11 = heights[(iz0 + 1) * 150 + ix0 + 1]
            return (h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) +
                    h01 * (1 - fx) * fz + h11 * fx * fz)
        return _sample

    def _apply_terrain_ramp(self, ramp_edits):
        """
        Merge computed ramp heights into the terrain editor's edit
        file (shared cache). The terrain editor reads these on next
        launch and renders the ramp. This is the "grouped" terrain —
        it moves with the road per Joshua's grouping concept.
        """
        if not ramp_edits:
            return
        import json as _json
        from pathlib import Path as _Path
        # The terrain editor stores edits as {"ix,iz": height}.
        # Write to the shared suite cache so both apps see it.
        shared_edits = (_Path.home() / ".local" / "share"
                        / "adamsville-suite" / "terrain_edits.json")
        existing = {}
        try:
            if shared_edits.exists():
                existing = _json.loads(shared_edits.read_text())
        except Exception:
            pass
        for (ix, iz), h in ramp_edits.items():
            key = f"{ix},{iz}"
            # Keep the highest value (ramps build up, don't carve down).
            if key not in existing or h > existing[key]:
                existing[key] = h
        try:
            shared_edits.parent.mkdir(parents=True, exist_ok=True)
            shared_edits.write_text(_json.dumps(existing))
        except Exception:
            pass  # non-fatal — the ramp is still in the overpass data
        self._mark_unpublished()

    # ------------------------------------------------------------------
    # Road Appearance dialog (Joshua 2026-10-11)
    # ------------------------------------------------------------------
    # Edit → Road Appearance: two-section popup (Width, Paint) plus an
    # optional Border sidewalks section. Applies to every selected road.
    # Stored on each road dict as:
    #   {"width_class": "narrow"|"standard"|"wide",
    #    "paint": "none"|"dotted"|"dotted_yellow",
    #    "sidewalk_left": bool, "sidewalk_right": bool,
    #    "sidewalk_width": "narrow"|"standard"|"wide"}

    def on_move_road(self, widget):
        """
        Edit → Move Road (Joshua 2026-10-12). Enters move-road mode for
        the single selected road: the road sticks to the cursor with a
        ghost preview. Click or Enter drops it, Escape cancels. One
        undo step.
        """
        if not self.canvas.start_move_road():
            # start_move_road already set a helpful status message.
            return

    def on_road_appearance(self, widget):
        """
        Open the Road Appearance popup for the selected road(s).
        Section 1 (Width): Narrow / Standard / Wide radio buttons.
        Section 2 (Paint): No paint / Dotted / Dotted+yellow radios.
        Section 3 (Border sidewalks): checkbox revealing Left/Right
        sub-checkboxes; confirming opens the sidewalk width popup.
        """
        sel = self.canvas.selected_roads
        if not sel:
            return  # menu is disabled anyway; belt and suspenders

        # Pre-select current values from the first selected road.
        road0 = self.canvas._get_road_dict(*sel[0])
        cur_width = "standard"
        cur_paint = "none"
        cur_sw_left = False
        cur_sw_right = False
        cur_sw_width = "standard"
        # Category comes from the selection key (roads live in per-
        # category lists); normalized for legacy "arterial" data.
        cur_cat = normalize_category(sel[0][0])
        if road0 is not None:
            cur_width = road0.get("width_class", "standard")
            cur_paint = road0.get("paint", "none")
            cur_sw_left = bool(road0.get("sidewalk_left", False))
            cur_sw_right = bool(road0.get("sidewalk_right", False))
            cur_sw_width = road0.get("sidewalk_width", "standard")

        dialog = Gtk.Dialog(title="Road Appearance",
                            transient_for=self.window, flags=0)
        dialog.set_default_size(340, 380)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("OK", Gtk.ResponseType.OK)
        box = dialog.get_content_area()
        box.set_spacing(6)
        for margin in ("margin_start", "margin_end"):
            getattr(box, "set_" + margin)(14)
        box.set_margin_top(10)
        box.set_margin_bottom(10)

        def section_label(text):
            """Bold section header label."""
            lbl = Gtk.Label()
            lbl.set_markup("<b>%s</b>" % text)
            lbl.set_halign(Gtk.Align.START)
            return lbl

        def radio_group(options, current):
            """
            Build a vertical stack of radio buttons.
            options: list of (value, label). Returns (box, {value: btn}).
            """
            vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                           spacing=2)
            btns = {}
            first = None
            for value, label in options:
                if first is None:
                    btn = Gtk.RadioButton(label=label)
                    first = btn
                else:
                    btn = Gtk.RadioButton.new_from_widget(first)
                    btn.set_label(label)
                btns[value] = btn
                vbox.pack_start(btn, False, False, 0)
            if current in btns:
                btns[current].set_active(True)
            return vbox, btns

        # -- Section 0: Category (Joshua 2026-10-11: interstate >
        # highway > major_artery > minor_artery > local) --
        box.pack_start(section_label("Category"), False, False, 0)
        cbox, cat_btns = radio_group(
            [(c, CATEGORY_LABELS[c]) for c in CATEGORY_ORDER],
            cur_cat if cur_cat in CATEGORY_ORDER else "local")
        box.pack_start(cbox, False, False, 0)
        box.pack_start(Gtk.Separator(), False, False, 4)

        # -- Section 1: Width --
        box.pack_start(section_label("Width"), False, False, 0)
        wbox, width_btns = radio_group(
            [("narrow", "Narrow"),
             ("standard", "Standard"),
             ("wide", "Wide")],
            cur_width if cur_width in ("narrow", "standard", "wide")
            else "standard")
        box.pack_start(wbox, False, False, 0)
        box.pack_start(Gtk.Separator(), False, False, 4)

        # -- Section 2: Paint (lane markings) --
        box.pack_start(section_label("Paint"), False, False, 0)
        pbox, paint_btns = radio_group(
            [("none", "No paint (no lane markings)"),
             ("dotted", "Dotted lines (white dotted lines)"),
             ("dotted_yellow",
              "Dotted lines with yellow lines "
              "(yellow center + white dotted)")],
            cur_paint if cur_paint in ("none", "dotted", "dotted_yellow")
            else "none")
        box.pack_start(pbox, False, False, 0)
        box.pack_start(Gtk.Separator(), False, False, 4)

        # -- Section 3: Border sidewalks --
        box.pack_start(section_label("Border sidewalks"), False, False, 0)
        sw_enable = Gtk.CheckButton(label="Add border sidewalks")
        box.pack_start(sw_enable, False, False, 0)
        # Sub-checkboxes, revealed when the main checkbox is on.
        sw_sides_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                               spacing=2)
        sw_sides_box.set_margin_start(18)
        sw_left = Gtk.CheckButton(label="Left side")
        sw_right = Gtk.CheckButton(label="Right side")
        sw_sides_box.pack_start(sw_left, False, False, 0)
        sw_sides_box.pack_start(sw_right, False, False, 0)
        box.pack_start(sw_sides_box, False, False, 0)

        has_sw = cur_sw_left or cur_sw_right
        sw_enable.set_active(has_sw)
        sw_left.set_active(cur_sw_left)
        sw_right.set_active(cur_sw_right)
        sw_sides_box.set_visible(has_sw)
        sw_enable.connect(
            "toggled",
            lambda _b: sw_sides_box.set_visible(sw_enable.get_active()))

        dialog.show_all()
        # show_all() would reveal the sides box; re-hide if unchecked.
        sw_sides_box.set_visible(sw_enable.get_active())
        resp = dialog.run()

        # Gather choices before destroying the dialog.
        new_cat = next((v for v, b in cat_btns.items()
                        if b.get_active()), "local")
        new_width = next((v for v, b in width_btns.items()
                          if b.get_active()), "standard")
        new_paint = next((v for v, b in paint_btns.items()
                          if b.get_active()), "none")
        want_sw = sw_enable.get_active()
        want_left = sw_left.get_active() if want_sw else False
        want_right = sw_right.get_active() if want_sw else False
        dialog.destroy()

        if resp != Gtk.ResponseType.OK:
            return

        # Undo (Joshua 2026-10-12): one undo step covers the whole
        # appearance edit (category move + width/paint/sidewalks +
        # cul-de-sac prompts).
        self.undo_begin("Edit Road Appearance")

        # Sidewalk width: only ask when sidewalks are enabled. A third
        # popup (Joshua 2026-10-11) offers Narrow / Standard / Wide.
        new_sw_width = cur_sw_width
        if want_sw and (want_left or want_right):
            picked = self._pick_sidewalk_width(cur_sw_width)
            if picked is None:
                # User cancelled — abort all and drop the pending
                # undo transaction (nothing was mutated).
                self.undo_discard()
                return
            new_sw_width = picked
        elif not want_sw:
            want_left = want_right = False

        # Collect the live road dicts BEFORE any list moves (flat
        # indices go stale once the index is rebuilt).
        targets = []
        for cat, idx in sel:
            road = self.canvas._get_road_dict(cat, idx)
            if road is not None:
                targets.append((normalize_category(cat), road))

        # Category change: move each road dict between the per-category
        # working-copy lists (Joshua 2026-10-11).
        cat_changed = False
        if new_cat in CATEGORY_ORDER:
            for old_cat, road in targets:
                if old_cat == new_cat:
                    continue
                if self._remove_road_from_working_copy(old_cat, road):
                    self.roads_data.setdefault(new_cat, []).append(road)
                    self._dirty_road_cats.add(old_cat)
                    self._dirty_road_cats.add(new_cat)
                    cat_changed = True
                    # Interstates default to divided (median) since they
                    # are almost always divided highways — Joshua can
                    # still change/remove per section (Joshua 2026-10-11).
                    if new_cat == "interstate" and not road.get(
                            "divided_sections"):
                        npts = len(road.get("pts", []))
                        if npts >= 2:
                            road["divided_sections"] = [{
                                "from_idx": 0,
                                "to_idx": npts - 1,
                                "type": "median",
                            }]

        # Apply to every selected road through the normal mutation path
        # (marks dirty, persists, rebuilds index, refreshes inspector).
        names = []
        for old_cat, road in targets:
            eff_cat = new_cat if cat_changed else old_cat
            road["width_class"] = new_width
            road["paint"] = new_paint
            road["sidewalk_left"] = want_left
            road["sidewalk_right"] = want_right
            road["sidewalk_width"] = new_sw_width
            self.apply_road_modify(eff_cat, road)
            names.append(road.get("name") or "Unnamed")

        # Cul-de-sac prompt (Joshua 2026-10-11): whenever a road's
        # category is Local, ask "Is this a cul-de-sac?" — a Yes
        # auto-adds a small turnaround bulb at the dead end.
        for old_cat, road in targets:
            eff_cat = new_cat if cat_changed else old_cat
            if eff_cat == "local" and not road.get("cul_de_sac"):
                if self._prompt_cul_de_sac(road):
                    self.apply_road_modify(eff_cat, road)
            elif eff_cat != "local" and road.get("cul_de_sac"):
                # Bulbs only make sense on local roads — clear stale
                # flags when the category moves away from local.
                road.pop("cul_de_sac", None)
                road.pop("cul_de_sac_end", None)
                road.pop("cul_de_sac_radius", None)
                self.apply_road_modify(eff_cat, road)
        # Category moves invalidate flat selection indices — clear.
        if cat_changed:
            self.canvas.selected_roads = []
            self._update_merge_join_buttons()
            try:
                self.edit_road_item.set_sensitive(False)
                self.divide_item.set_sensitive(False)
            except AttributeError:
                pass
        self.canvas.queue_draw()
        if names:
            msg = "Appearance updated: %s." % ", ".join(names)
            if cat_changed:
                msg += f" Category → {CATEGORY_LABELS[new_cat]}."
            self.set_status(msg)
        # Undo (Joshua 2026-10-12): commit the appearance edit.
        # (No-op if the user changed nothing — skipped automatically.)
        self.undo_commit()

    def _pick_sidewalk_width(self, current):
        """
        Third popup (Joshua 2026-10-11): sidewalk width selection.
        Returns "narrow"/"standard"/"wide", or None if cancelled.
        """
        dialog = Gtk.Dialog(title="Sidewalk Width",
                            transient_for=self.window, flags=0)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("OK", Gtk.ResponseType.OK)
        box = dialog.get_content_area()
        box.set_spacing(4)
        box.set_margin_start(14)
        box.set_margin_end(14)
        box.set_margin_top(10)
        box.set_margin_bottom(10)
        lbl = Gtk.Label(label="Choose the sidewalk strip width:")
        lbl.set_halign(Gtk.Align.START)
        box.pack_start(lbl, False, False, 0)
        first = None
        btns = {}
        for value, label in [("narrow", "Narrow"),
                             ("standard", "Standard"),
                             ("wide", "Wide")]:
            if first is None:
                btn = Gtk.RadioButton(label=label)
                first = btn
            else:
                btn = Gtk.RadioButton.new_from_widget(first)
                btn.set_label(label)
            btns[value] = btn
            box.pack_start(btn, False, False, 0)
        if current in btns:
            btns[current].set_active(True)
        dialog.show_all()
        resp = dialog.run()
        picked = next((v for v, b in btns.items() if b.get_active()),
                      "standard")
        dialog.destroy()
        if resp != Gtk.ResponseType.OK:
            return None
        return picked

    # ------------------------------------------------------------------
    # Cul-de-sac prompt (Joshua 2026-10-11)
    # ------------------------------------------------------------------
    # When a road's category is set to Local, ask "Is this a
    # cul-de-sac?" — a Yes auto-adds a small turnaround bulb at the
    # dead end (the endpoint that doesn't reach another road).

    def _prompt_cul_de_sac(self, road):
        """
        "Is this a cul-de-sac?" Yes/No dialog. On Yes, detect the
        dead end and mark the turnaround bulb on the road dict.
        Returns True if the bulb flags were set.
        """
        name = road.get("name") or "Unnamed"
        dialog = Gtk.MessageDialog(
            transient_for=self.window, flags=0,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.YES_NO,
            text="Is this a cul-de-sac?")
        dialog.format_secondary_text(
            f"'{name}' is a local road. If it ends in a dead end, a "
            "small turnaround bulb will be added there automatically "
            "(just enough room for a car to turn around).")
        resp = dialog.run()
        dialog.destroy()
        if resp != Gtk.ResponseType.YES:
            return False
        ends = self.canvas.find_cul_de_sac_ends(road)
        if not ends:
            self.set_status(
                f"'{name}': both ends connect to other roads — "
                "no cul-de-sac added.")
            return False
        if len(ends) == 2:
            # Both ends are dead ends — let Joshua pick which end
            # gets the bulb (defaults to the "end" point on cancel).
            pick = self._pick_cul_de_sac_end(name)
            if pick is None:
                return False  # user cancelled
            ends = [pick]
        road["cul_de_sac"] = True
        road["cul_de_sac_end"] = ends[0]
        road["cul_de_sac_radius"] = 15.0
        self.set_status(
            f"'{name}': turnaround bulb added at the {ends[0]} end.")
        return True

    def _pick_cul_de_sac_end(self, name):
        """
        Both ends of the road are dead ends — ask Joshua which end
        gets the turnaround bulb. Returns "start", "end", or None
        if the user cancelled.
        """
        dialog = Gtk.Dialog(title="Cul-de-sac end",
                            transient_for=self.window, flags=0)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        box = dialog.get_content_area()
        box.set_spacing(6)
        for margin in ("margin_start", "margin_end",
                       "margin_top", "margin_bottom"):
            getattr(box, "set_" + margin)(14)
        lbl = Gtk.Label(
            label=f"Both ends of '{name}' are dead ends.\n"
                  "Which end gets the turnaround bulb?")
        lbl.set_halign(Gtk.Align.START)
        box.pack_start(lbl, False, False, 0)
        start_btn = Gtk.Button(label="Start end (first point)")
        end_btn = Gtk.Button(label="End (last point)")
        box.pack_start(start_btn, False, False, 0)
        box.pack_start(end_btn, False, False, 0)
        result = [None]

        def _pick(which):
            """Record the choice and close the dialog."""
            result[0] = which
            dialog.response(Gtk.ResponseType.OK)

        start_btn.connect("clicked", lambda _b: _pick("start"))
        end_btn.connect("clicked", lambda _b: _pick("end"))
        dialog.show_all()
        resp = dialog.run()
        dialog.destroy()
        return result[0] if resp == Gtk.ResponseType.OK else None

    # ------------------------------------------------------------------
    # Divide Road Section (Joshua 2026-10-11: segmentable medians)
    # ------------------------------------------------------------------
    # Major arteries, highways, and interstates can have divided
    # SECTIONS — point-index ranges rendered as two direction ribbons
    # with a median (raised light-gray strip) or divider (dark strip
    # with posts) between them. Sections are independent: one road can
    # have several, and undivided stretches stay a single ribbon.
    # Stored on the road dict as:
    #   {"divided_sections": [{"from_idx": int, "to_idx": int,
    #                          "type": "median"|"divider"}, ...]}

    def on_divide_section(self, widget):
        """
        Edit → Divide Road Section: manage divided sections for the
        single selected dividable road (major artery / highway /
        interstate). Opens the section list dialog.
        """
        sel = self.canvas.selected_roads
        if len(sel) != 1:
            return  # menu is disabled anyway; belt and suspenders
        cat, idx = sel[0]
        ncat = normalize_category(cat)
        if ncat not in DIVIDABLE_CATEGORIES:
            return
        road = self.canvas._get_road_dict(cat, idx)
        if road is None or len(road.get("pts", [])) < 2:
            return
        self._divide_sections_dialog(ncat, idx, road)

    def _divide_sections_dialog(self, cat, idx, road):
        """
        List the road's divided sections with Change/Remove per row,
        plus "Add Section…" which starts point picking on the canvas.
        """
        name = road.get("name") or "Unnamed"
        words = _direction_words(road.get("pts", []))
        dialog = Gtk.Dialog(title=f"Divided Sections — {name}",
                            transient_for=self.window, flags=0)
        dialog.set_default_size(420, 300)
        dialog.add_button("Close", Gtk.ResponseType.CLOSE)
        box = dialog.get_content_area()
        box.set_spacing(6)
        box.set_margin_start(14)
        box.set_margin_end(14)
        box.set_margin_top(10)
        box.set_margin_bottom(10)

        info = Gtk.Label(
            label=f"Directions: {words[0]} / {words[1]} "
                  f"(auto-detected from the road's angle)")
        info.set_halign(Gtk.Align.START)
        info.set_line_wrap(True)
        box.pack_start(info, False, False, 0)
        box.pack_start(Gtk.Separator(), False, False, 4)

        sections = road.setdefault("divided_sections", [])
        # Validate/clean on open: drop corrupt entries.
        npts = len(road.get("pts", []))
        clean = [s for s in sections
                 if isinstance(s, dict)
                 and s.get("type") in DIVIDER_TYPES
                 and isinstance(s.get("from_idx"), int)
                 and isinstance(s.get("to_idx"), int)
                 and 0 <= s["from_idx"] < s["to_idx"] < npts]
        if len(clean) != len(sections):
            # Undo (Joshua 2026-10-12): the dialog auto-repairs
            # corrupt section data on open — make that undoable too.
            # (Begin BEFORE the mutation so the before-state is clean.)
            self.undo_begin("Clean Divided Sections")
            sections[:] = clean
            self.apply_road_modify(cat, road)
            self.undo_commit()

        list_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        box.pack_start(list_box, True, True, 0)

        def rebuild_list():
            """Redraw the section rows after add/change/remove."""
            for child in list_box.get_children():
                list_box.remove(child)
            if not sections:
                lbl = Gtk.Label(label="No divided sections yet.\n"
                                      "Click “Add Section…” and pick two\n"
                                      "points on the road.")
                lbl.set_line_wrap(True)
                list_box.pack_start(lbl, False, False, 6)
            for si, sec in enumerate(list(sections)):
                row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                              spacing=6)
                lab = Gtk.Label(
                    label=f"Points {sec['from_idx']}–{sec['to_idx']}: "
                          f"{sec['type'].capitalize()}")
                lab.set_halign(Gtk.Align.START)
                lab.set_hexpand(True)
                row.pack_start(lab, True, True, 0)
                chg = Gtk.Button(label="Change")
                chg.connect("clicked", self._on_section_change,
                            dialog, cat, road, si, list_box, rebuild_list)
                row.pack_start(chg, False, False, 0)
                rm = Gtk.Button(label="Remove")
                rm.connect("clicked", self._on_section_remove,
                           cat, road, si, list_box, rebuild_list)
                row.pack_start(rm, False, False, 0)
                list_box.pack_start(row, False, False, 0)
            list_box.show_all()

        rebuild_list()

        add_btn = Gtk.Button(label="Add Section…")
        add_btn.set_tooltip_text(
            "Pick a start and end point on the road, then choose "
            "median, divider, or none")
        add_btn.connect("clicked", self._on_section_add,
                        dialog, cat, idx, road)
        box.pack_start(add_btn, False, False, 0)

        dialog.show_all()
        dialog.run()
        dialog.destroy()
        self.canvas.queue_draw()

    def _on_section_change(self, button, dialog, cat, road, si,
                           list_box, rebuild_list):
        """
        Change button: re-ask median/divider/none for an existing
        section. "None" removes the section.
        """
        sections = road.get("divided_sections", [])
        if not (0 <= si < len(sections)):
            return
        # Undo (Joshua 2026-10-12): one undo step per section edit.
        self.undo_begin("Edit Divided Section")
        sec = sections[si]
        choice = self._ask_divider_type(
            f"Points {sec['from_idx']}–{sec['to_idx']}",
            current=sec.get("type"))
        if choice is None:
            self.undo_discard()  # dialog dismissed — nothing changed
            return  # dialog dismissed — no change
        if choice == "none":
            del sections[si]
            self.set_status("Divided section removed.")
        else:
            sec["type"] = choice
            self.set_status(
                f"Section → {choice.capitalize()}.")
        self.apply_road_modify(cat, road)
        self.undo_commit()
        rebuild_list()

    def _on_section_remove(self, button, cat, road, si,
                           list_box, rebuild_list):
        """Remove button: delete the section outright."""
        sections = road.get("divided_sections", [])
        if 0 <= si < len(sections):
            # Undo (Joshua 2026-10-12).
            self.undo_begin("Edit Divided Section")
            del sections[si]
            self.apply_road_modify(cat, road)
            self.undo_commit()
            self.set_status("Divided section removed.")
            rebuild_list()

    def _on_section_add(self, button, dialog, cat, idx, road):
        """
        Add Section…: close the dialog and start point picking on the
        canvas. Joshua clicks the section start point, then the end
        point; then the median/divider/none popup appears.
        """
        dialog.destroy()
        self.canvas.divide_pick = {"cat": cat, "idx": idx,
                                   "road": road, "start": None}
        self.set_status(
            "Divide: click the SECTION START point on the road "
            "(Esc to cancel).")
        self.canvas.queue_draw()

    def _ask_divider_type(self, where_label, current="none"):
        """
        Popup: "Would you like a median, divider, or none?"
        Three buttons; None is the default (preselected).
        Returns "median", "divider", "none", or None if dismissed.
        (Joshua 2026-10-11.)
        """
        dialog = Gtk.Dialog(title="Divide Section",
                            transient_for=self.window, flags=0)
        box = dialog.get_content_area()
        box.set_spacing(6)
        box.set_margin_start(14)
        box.set_margin_end(14)
        box.set_margin_top(10)
        box.set_margin_bottom(10)
        lbl = Gtk.Label(
            label=f"Would you like a median, divider, or none\n"
                  f"for {where_label}?")
        lbl.set_line_wrap(True)
        lbl.set_halign(Gtk.Align.START)
        box.pack_start(lbl, False, False, 0)
        hint = Gtk.Label(
            label="Median: raised light-gray strip between directions.\n"
                  "Divider: narrow dark strip with posts.\n"
                  "None: the road stays a single undivided strip.")
        hint.set_line_wrap(True)
        hint.set_halign(Gtk.Align.START)
        box.pack_start(hint, False, False, 0)

        # None is the default choice (Joshua 2026-10-11).
        RESP_MEDIAN, RESP_DIVIDER, RESP_NONE = 101, 102, 103
        dialog.add_button("Median", RESP_MEDIAN)
        dialog.add_button("Divider", RESP_DIVIDER)
        none_btn = dialog.add_button("None", RESP_NONE)
        dialog.set_default_response(RESP_NONE)
        dialog.show_all()
        # Give the None button initial focus so Enter accepts it.
        none_btn.grab_focus()
        resp = dialog.run()
        dialog.destroy()
        if resp == RESP_MEDIAN:
            return "median"
        if resp == RESP_DIVIDER:
            return "divider"
        if resp == RESP_NONE:
            return "none"
        return None

    def ask_divider_type(self, cat, idx, road, a, b):
        """
        Called by the canvas after Joshua picks the section's start/end
        points. Shows the median/divider/none popup and adds the
        section unless "none" was chosen.
        """
        choice = self._ask_divider_type(f"points {a}–{b}")
        if choice is None or choice == "none":
            self.set_status("Divide: no division added.")
            return
        self._add_divided_section(cat, road, a, b, choice)

    def _add_divided_section(self, cat, road, a, b, dtype):
        """
        Append a divided section, merging overlaps with existing
        sections of the same span to avoid duplicates.
        """
        # Undo (Joshua 2026-10-12).
        self.undo_begin("Edit Divided Section")
        sections = road.setdefault("divided_sections", [])
        # Drop any existing section fully inside the new range (the new
        # choice supersedes it); trim partial overlaps away.
        kept = []
        for s in sections:
            sa, sb = s.get("from_idx", 0), s.get("to_idx", 0)
            if sa >= a and sb <= b:
                continue  # fully covered — replaced
            kept.append(s)
        kept.append({"from_idx": a, "to_idx": b, "type": dtype})
        # Keep sorted by start index for predictable rendering.
        kept.sort(key=lambda s: s["from_idx"])
        sections[:] = kept
        self.apply_road_modify(cat, road)
        self.undo_commit()
        self.set_status(
            f"Divided section added: points {a}–{b} → "
            f"{dtype.capitalize()}.")

    def on_zoom_in(self, widget):
        """Zoom in centered on canvas middle."""
        alloc = self.canvas.get_allocation()
        self.canvas.zoom_at(alloc.width / 2, alloc.height / 2, 1.4)

    def on_zoom_out(self, widget):
        """Zoom out centered on canvas middle."""
        alloc = self.canvas.get_allocation()
        self.canvas.zoom_at(alloc.width / 2, alloc.height / 2, 1 / 1.4)

    # ------------------------------------------------------------------
    # Zone navigation
    # ------------------------------------------------------------------

    def _rebuild_zones_menu(self):
        """
        (Re)build the Zones menu entries from data.ZONES.
        Called at startup and after Fill Unzoned Area creates new zones.
        """
        # Remove old children
        for child in self.zones_menu.get_children():
            self.zones_menu.remove(child)
        for i, zone in enumerate(ZONES):
            zi = Gtk.MenuItem(label=zone["name"])
            # Use default arg to capture loop variable
            zi.connect("activate", lambda w, idx=i: self.zoom_to_zone(idx))
            self.zones_menu.append(zi)
        self.zones_menu.show_all()

    def zoom_to_zone(self, idx):
        """Zoom the canvas to fit a zone's polygon bounds, and select it."""
        zone = ZONES[idx]
        alloc = self.canvas.get_allocation()
        if alloc.width <= 0:
            return
        # Fit the polygon's bounding box with 10% padding
        bx0, bz0, bx1, bz1 = zone_bbox(zone)
        pad = 1.1
        zw = alloc.width / ((bx1 - bx0) * pad)
        zh = alloc.height / ((bz1 - bz0) * pad)
        self.canvas.zoom = min(zw, zh)
        self.canvas.cam_x = (bx0 + bx1) / 2
        self.canvas.cam_y = (bz0 + bz1) / 2
        # Select the zone so its corner pins are shown and draggable
        self.canvas.selected_zone = idx
        self.canvas.drag_pin = None
        self.canvas.queue_draw()
        self.on_zone_selected(zone["name"])
        # Switch to the Zone tool so the pins are immediately usable.
        # Skip the auto-fit-to-full-map: zoom_to_zone already framed
        # this specific zone (Joshua 2026-10-11).
        self._skip_zone_fit = True
        zb = self.tool_buttons.get("zone")
        if zb is not None:
            zb.set_active(True)

    # ------------------------------------------------------------------
    # Status bar
    # ------------------------------------------------------------------

    def set_status(self, message):
        """Show a message in the status bar."""
        self.statusbar.pop(self.status_ctx)
        self.statusbar.push(self.status_ctx, message)

    def on_roads_selected(self):
        """
        Called by the canvas whenever the road selection changes.
        Updates the status bar and enables/disables Merge/Join.
        """
        sel = self.canvas.selected_roads
        names = [self.canvas._road_name_of(c, i) for c, i in sel]
        if len(names) == 2:
            self.set_status(
                f"Selected: {names[0]} + {names[1]} — click Merge or Join")
        elif len(names) == 1:
            self.set_status(
                f"Selected: {names[0]} — select one more road, "
                "then click Merge or Join")
        else:
            self.set_status("Select 2 roads, then click Merge or Join")
        self._update_merge_join_buttons()
        # Edit → Road Appearance only makes sense with a selection.
        # (Joshua 2026-10-11.)
        try:
            self.edit_road_item.set_sensitive(len(sel) > 0)
        except AttributeError:
            pass  # menu not built yet during early init
        # Edit → Divide Road Section: exactly one selected road whose
        # category supports medians/dividers (Joshua 2026-10-11).
        try:
            dividable = False
            if len(sel) == 1:
                road = self.canvas._get_road_dict(*sel[0])
                if road is not None:
                    dividable = (normalize_category(sel[0][0])
                                 in DIVIDABLE_CATEGORIES)
            self.divide_item.set_sensitive(dividable)
        except AttributeError:
            pass  # menu not built yet during early init
        # Edit → Move Road: exactly one selected road (Joshua 2026-10-12).
        try:
            self.move_road_item.set_sensitive(len(sel) == 1)
        except AttributeError:
            pass  # menu not built yet during early init
        # Keep the 3D inspector in sync with the selection.
        insp = getattr(self, "inspector", None)
        if insp is not None:
            insp.refresh()

    def _update_merge_join_buttons(self):
        """
        Enable the Merge/Join toolbar buttons only when exactly 2
        roads are selected (Joshua 2026-10-11).
        Also updates the Link to Overpass button (1 road selected).
        """
        two = len(self.canvas.selected_roads) == 2
        try:
            self.merge_button.set_sensitive(two)
            self.join_button.set_sensitive(two)
        except AttributeError:
            pass  # toolbar not built yet during early init
        # Link to Overpass needs exactly 1 selected road.
        self._update_link_overpass_button()

    def on_zone_selected(self, name):
        """Called by canvas when a zone is selected/deselected."""
        if name:
            self.set_status(
                f"Zone: {name} — drag pins to reshape, "
                "click an edge to add a pin")
        else:
            self.set_status("No zone selected")

    # ------------------------------------------------------------------
    # Road mutations (Join / Merge / Extend / Delete)
    # ------------------------------------------------------------------
    # The working copy (self.roads_data) is mutated, the changed categories
    # are marked dirty, edits are persisted to road_edits.json, and the
    # spatial index is rebuilt so rendering and picking stay correct.

    def _remove_road_from_working_copy(self, cat, road_dict):
        """
        Remove a road dict from the working copy by object identity.
        Returns True if found and removed.
        """
        lst = self.roads_data.get(cat, [])
        for i, r in enumerate(lst):
            if r is road_dict:
                del lst[i]
                return True
        return False

    def _rebuild_road_index(self):
        """Rebuild the spatial index from the working copy (after edits)."""
        self.spatial_index = SpatialIndex(cell_size=500)
        self.spatial_index.build(self.roads_data)
        self.canvas.queue_draw()
        # The 3D inspector shows post-edit geometry (Joshua 2026-10-11:
        # visual verification that join/merge worked correctly).
        insp = getattr(self, "inspector", None)
        if insp is not None:
            insp.refresh()

    def persist_road_edits(self):
        """
        Save dirty road categories to road_edits.json so joins, merges,
        extends, and deletes survive restarts. Only writes categories
        that actually changed.
        """
        if not self._dirty_road_cats:
            return
        from data import save_road_edits, get_local_sha
        replaced = {cat: self.roads_data[cat]
                    for cat in self._dirty_road_cats
                    if cat in self.roads_data}
        save_road_edits(get_local_sha(), replaced)
        # Mark for the close warning (Joshua 2026-10-11).
        self._mark_unpublished()

    # ------------------------------------------------------------------
    # Undo/redo (Joshua 2026-10-12: "The map editor needs a undo").
    # ------------------------------------------------------------------
    # Every map edit is wrapped in an undo transaction:
    #   token = self.undo_begin("Join Roads")   # snapshot BEFORE
    #   ... mutate roads/overpasses/zones ...
    #   self.undo_commit(token)                 # snapshot AFTER, push
    # If nothing changed (before == after), no command is pushed, so
    # no-op drags don't clutter the history. Redo is cleared on every
    # new edit (standard behavior).
    #
    # Snapshots cover the full map state: roads_data, overpasses, zone
    # polygons, plus the zone overlay files on disk (zone_edits.json /
    # custom_zones.json) so memory and disk stay consistent across
    # undo/redo and restarts.

    def _map_state_snapshot(self):
        """
        Deep-copy the full editable map state.

        Returns a plain dict; the UndoManager treats it opaquely.
        Zone file contents are captured as text so undo can restore
        the on-disk overlays too (a restart must not resurrect an
        undone zone edit).
        """
        from data import ZONES, ZONE_EDITS_FILE, CUSTOM_ZONES_FILE
        snap = {
            # Road data: {category: [road dicts]}.
            "roads": copy.deepcopy(self.roads_data),
            # Overpass structures (linked roads, pillars, signs).
            "overpasses": copy.deepcopy(self.overpasses),
            # Zone polygons (full dicts; restored in place).
            "zones": copy.deepcopy(ZONES),
            # On-disk zone overlays: text or None if absent.
            "zone_edits_text": self._read_text_file(ZONE_EDITS_FILE),
            "custom_zones_text": self._read_text_file(CUSTOM_ZONES_FILE),
        }
        return snap

    @staticmethod
    def _read_text_file(path):
        """Read a text file, returning None if missing/unreadable."""
        try:
            if path.exists():
                return path.read_text()
        except Exception:
            pass
        return None

    def _map_state_restore(self, snap):
        """
        Restore a snapshot from _map_state_snapshot().

        Uses fresh deep copies so the stack's stored snapshots are
        never aliased by live state (a later edit must not corrupt
        history). Rebuilds the spatial index, re-persists everything,
        clears stale selections, and refreshes the UI.
        """
        from data import (ZONES, ZONE_EDITS_FILE, CUSTOM_ZONES_FILE,
                          save_overpasses)
        # Roads: replace the working copy outright.
        self.roads_data = copy.deepcopy(snap["roads"])
        # Overpasses: replace and re-persist.
        self.overpasses = copy.deepcopy(snap["overpasses"])
        try:
            save_overpasses(self.overpasses)
        except Exception:
            pass
        # Zones: restore in place so other modules holding the ZONES
        # list object (mapcanvas imports it) keep working.
        ZONES[:] = copy.deepcopy(snap["zones"])
        # Zone overlay files: rewrite to match the restored memory
        # state (or remove the file if it didn't exist).
        self._write_text_file(ZONE_EDITS_FILE, snap["zone_edits_text"])
        self._write_text_file(CUSTOM_ZONES_FILE,
                              snap["custom_zones_text"])
        # Zone list may have gained/lost entries (fill tool) — rebuild
        # the Zones menu so it matches.
        try:
            self._rebuild_zones_menu()
        except Exception:
            pass
        # Every road category may differ from disk now — mark all
        # dirty so persist_road_edits() rewrites the overlay fully.
        if self.roads_data:
            self._dirty_road_cats.update(self.roads_data.keys())
        self.persist_road_edits()
        self._rebuild_road_index()
        # Selections point at (category, index) pairs that may no
        # longer be valid — clear them.
        try:
            self.canvas.selected_roads = []
        except Exception:
            pass
        self._update_merge_join_buttons()
        try:
            self.edit_road_item.set_sensitive(False)
            self.divide_item.set_sensitive(False)
        except Exception:
            pass
        # The 3D inspector may hold references to pre-undo road dicts.
        try:
            self.inspector.refresh()
        except Exception:
            pass
        try:
            self.canvas.queue_draw()
        except Exception:
            pass
        # Restored state differs from the last push — flag it.
        try:
            self._mark_unpublished()
        except Exception:
            pass
        self._refresh_undo_ui()

    @staticmethod
    def _write_text_file(path, text):
        """
        Write text back to a file, or delete the file if text is None
        (meaning the file didn't exist when the snapshot was taken).
        """
        try:
            if text is None:
                if path.exists():
                    path.unlink()
            else:
                path.write_text(text)
        except Exception:
            pass

    def undo_begin(self, label):
        """
        Start an undo transaction. Call BEFORE mutating map data.

        Returns an opaque token to pass to undo_commit(). If a
        transaction is already open (nested), the outer one wins —
        one logical edit stays one undo step.
        """
        if self._undo_pending is not None:
            # Nested begin: keep the outer transaction's label and
            # before-state so the whole operation undoes as one step.
            return self._undo_pending
        token = (label, self._map_state_snapshot())
        self._undo_pending = token
        return token

    def undo_commit(self, token=None):
        """
        Finish an undo transaction. Call AFTER the mutation attempt.

        Captures the after-state and pushes one UndoCommand. If the
        state didn't actually change (failed or cancelled edit), nothing
        is pushed — no-op history entries are skipped.
        """
        pending = self._undo_pending
        self._undo_pending = None
        if pending is None:
            return
        label, before = pending
        after = self._map_state_snapshot()
        if before == after:
            # Nothing changed — don't clutter the history.
            return
        self.undo_manager.push(UndoCommand(label, before, after))
        self._refresh_undo_ui()

    def undo_discard(self):
        """Abandon an open transaction without pushing (rare; safe)."""
        self._undo_pending = None

    def on_undo_clicked(self, widget=None):
        """
        Edit -> Undo (or Ctrl+Z, or the toolbar button).
        Restores the before-state of the most recent edit.
        """
        cmd = self.undo_manager.undo()
        if cmd is None:
            return
        self._map_state_restore(cmd.before)
        self.set_status("Undone: %s." % cmd.label)

    def on_redo_clicked(self, widget=None):
        """
        Edit -> Redo (or Ctrl+Y / Ctrl+Shift+Z, or the toolbar button).
        Re-applies the most recently undone edit.
        """
        cmd = self.undo_manager.redo()
        if cmd is None:
            return
        self._map_state_restore(cmd.after)
        self.set_status("Redone: %s." % cmd.label)

    def _refresh_undo_ui(self):
        """
        Update Undo/Redo menu labels and widget sensitivity.

        Menu items read e.g. "Undo: Join Roads" / "Redo: Join Roads";
        plain "Undo"/"Redo" when the stack is empty (and disabled).
        Called after every push/undo/redo/restore.
        """
        undo_label = self.undo_manager.undo_label()
        redo_label = self.undo_manager.redo_label()
        can_undo = self.undo_manager.can_undo()
        can_redo = self.undo_manager.can_redo()
        try:
            if self.undo_item is not None:
                self.undo_item.set_label(
                    "Undo: %s" % undo_label if undo_label else "Undo")
                self.undo_item.set_sensitive(can_undo)
            if self.redo_item is not None:
                self.redo_item.set_label(
                    "Redo: %s" % redo_label if redo_label else "Redo")
                self.redo_item.set_sensitive(can_redo)
            if self.undo_button is not None:
                self.undo_button.set_sensitive(can_undo)
                self.undo_button.set_tooltip_text(
                    "Undo %s" % undo_label if undo_label
                    else "Undo (nothing to undo)")
            if self.redo_button is not None:
                self.redo_button.set_sensitive(can_redo)
                self.redo_button.set_tooltip_text(
                    "Redo %s" % redo_label if redo_label
                    else "Redo (nothing to redo)")
        except Exception:
            pass

    def apply_road_join(self, cat_a, road_a, cat_b, road_b, new_road):
        """
        Join tool commit: remove road_a and road_b, add new_road
        (in road_a's category). Returns True on success.
        """
        if self.roads_data is None:
            return False
        ok_a = self._remove_road_from_working_copy(cat_a, road_a)
        # If both roads are in the same category, road_b is still there
        # (identity-based removal is unaffected by the first removal).
        ok_b = self._remove_road_from_working_copy(cat_b, road_b)
        if not (ok_a and ok_b):
            return False
        self.roads_data.setdefault(cat_a, []).append(new_road)
        self._dirty_road_cats.add(cat_a)
        if cat_b != cat_a:
            self._dirty_road_cats.add(cat_b)
        self.persist_road_edits()
        self._rebuild_road_index()
        return True

    def apply_road_modify(self, cat, road):
        """
        Merge/Extend commit: the road dict was already mutated in place
        (pts updated). Mark dirty, persist, rebuild index.
        Returns True on success.
        """
        if self.roads_data is None:
            return False
        self._dirty_road_cats.add(cat)
        self.persist_road_edits()
        self._rebuild_road_index()
        return True

    def apply_road_delete(self, cat, road):
        """Delete tool commit: remove the road entirely. Returns True."""
        if self.roads_data is None:
            return False
        if not self._remove_road_from_working_copy(cat, road):
            return False
        self._dirty_road_cats.add(cat)
        self.persist_road_edits()
        self._rebuild_road_index()
        # Clear selection if it pointed at the deleted road
        self.canvas.selected_roads = []
        self._update_merge_join_buttons()
        return True

    def confirm_delete_road(self, name):
        """Ask Joshua to confirm before deleting a road. Returns True=OK."""
        dialog = Gtk.MessageDialog(
            transient_for=self.window,
            flags=0,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.YES_NO,
            text=f"Delete road '{name}'?")
        dialog.format_secondary_text(
            "This removes the road entirely. You can undo it with "
            "Edit → Undo (Ctrl+Z).")
        response = dialog.run()
        dialog.destroy()
        return response == Gtk.ResponseType.YES

    # ------------------------------------------------------------------
    # Data download / updates
    # ------------------------------------------------------------------

    def _initial_setup(self):
        """
        Called once after window is shown.
        Checks for road data, prompts download if needed, then loads.
        """
        self.canvas.fit_view()
        needed, reason = needs_download()
        if needed:
            self._prompt_download(reason)
        else:
            self._load_data()
            if "newer version" in reason.lower():
                self.set_status(reason)
        return False  # don't repeat

    def _prompt_download(self, reason):
        """Show a dialog asking the user to download road data."""
        dialog = Gtk.MessageDialog(
            transient_for=self.window,
            flags=0,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.YES_NO,
            text="Download Map Data?")
        dialog.format_secondary_text(
            f"{reason}\n\nThe road data (~1.2 MB) will be downloaded "
            "from GitHub and stored locally.")
        response = dialog.run()
        dialog.destroy()

        if response == Gtk.ResponseType.YES:
            self._do_download()
        else:
            self.set_status("No data — canvas will be empty.")

    def _do_download(self):
        """Download roads in a background thread with progress dialog."""
        progress = Gtk.Dialog(
            title="Downloading…", transient_for=self.window, flags=0)
        progress.set_default_size(350, 80)
        bar = Gtk.ProgressBar()
        bar.set_show_text(True)
        bar.set_text("Connecting…")
        progress.get_content_area().pack_start(bar, True, True, 10)
        progress.show_all()

        def update_progress(frac, text):
            """Thread-safe progress update via GLib.idle_add."""
            def _update():
                bar.set_fraction(frac)
                bar.set_text(text)
                return False
            GLib.idle_add(_update)

        def worker():
            """Background download thread."""
            def cb(downloaded, total):
                if total > 0:
                    frac = downloaded / total
                    update_progress(
                        frac, f"{downloaded // 1024} KB / {total // 1024} KB")
                else:
                    update_progress(0, f"{downloaded // 1024} KB")
            success = download_roads(progress_callback=cb)

            def done():
                progress.destroy()
                if success:
                    self._load_data()
                    self.set_status("Data downloaded successfully.")
                else:
                    self._show_error(
                        "Download failed",
                        "Could not download from GitHub. "
                        "Check your internet connection.")
                return False
            GLib.idle_add(done)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

    def _load_data(self):
        """Load roads from local cache and build spatial index."""
        try:
            self.set_status("Loading roads…")
            self.roads_data = load_roads()
            # Load overpasses (Joshua 2026-10-11). Empty list if none
            # cached yet — the app works fine without overpasses.
            self.overpasses = load_overpasses()
            if not self.overpasses:
                # Try downloading once (silent if it fails).
                try:
                    if download_overpasses():
                        self.overpasses = load_overpasses()
                except Exception:
                    pass
            self._dirty_road_cats = set()
            # Re-apply saved road edits (joins/merges/extends/deletes)
            # on top of the downloaded data, if the base SHA still matches.
            from data import load_road_edits, get_local_sha
            saved_sha, replaced = load_road_edits()
            if replaced and saved_sha and saved_sha == get_local_sha():
                # Saved edits may use the legacy "arterial" key from
                # before the 2026-10-11 category split — translate it.
                if "arterial" in replaced:
                    legacy_edits = replaced.pop("arterial")
                    if isinstance(legacy_edits, list):
                        replaced["minor_artery"] = (
                            replaced.get("minor_artery", []) +
                            legacy_edits)
                applied = 0
                for cat, roads in replaced.items():
                    if cat in self.roads_data and isinstance(roads, list):
                        self.roads_data[cat] = roads
                        applied += 1
                if applied:
                    self._dirty_road_cats.update(
                        c for c in replaced if c in self.roads_data)
                    self.set_status(
                        f"Loading roads (with {applied} edited "
                        "categories)…")
            # Migrate legacy "arterial" roads to "minor_artery" in the
            # working copy (Joshua 2026-10-11: arterial split into
            # minor/major artery). Not marked dirty here — the migration
            # piggybacks on the next real edit's push via
            # export_full_roads(), so Joshua isn't nagged about
            # "unpublished changes" he didn't make.
            legacy = self.roads_data.pop("arterial", None)
            if isinstance(legacy, list) and legacy:
                self.roads_data.setdefault("minor_artery", []).extend(legacy)
            # Guarantee all five category lists exist.
            for _cat in ("interstate", "highway", "major_artery",
                         "minor_artery", "local"):
                self.roads_data.setdefault(_cat, [])
            self.spatial_index = SpatialIndex(cell_size=500)
            # Build index in idle to keep UI responsive
            GLib.idle_add(self._build_index_idle)
            # Undo (Joshua 2026-10-12): a fresh data load invalidates
            # all history — snapshots reference the old dataset.
            self.undo_manager.clear()
            self._refresh_undo_ui()
        except FileNotFoundError:
            self.set_status("No local data. Use File → Download from GitHub.")
        except Exception as e:
            self._show_error("Load Error", f"Could not load road data:\n{e}")

    def _build_index_idle(self):
        """Build spatial index (called via idle_add after load)."""
        self.spatial_index.build(self.roads_data)
        total = len(self.spatial_index.roads)
        self.set_status(f"Loaded {total:,} roads.")
        self.canvas.queue_draw()
        return False

    def on_download_clicked(self, widget):
        """File → Download from GitHub."""
        self._prompt_download("Download the latest road data from GitHub?")

    def on_check_updates(self, widget):
        """View → Check for Updates. Compare local SHA with GitHub."""
        self.set_status("Checking for updates…")

        def worker():
            remote = get_remote_sha()
            def done():
                if remote is None:
                    self.set_status("Offline — using local copy.")
                else:
                    from data import get_local_sha
                    local = get_local_sha()
                    if local != remote:
                        self._prompt_download(
                            "A newer version is available on GitHub.")
                    else:
                        self.set_status("Already up to date.")
                return False
            GLib.idle_add(done)

        threading.Thread(target=worker, daemon=True).start()

    # ------------------------------------------------------------------
    # Unpublished-changes close warning (Joshua 2026-10-11)
    # ------------------------------------------------------------------
    # Safety net: if Joshua hits X with unpushed edits, ask what to do.
    # No auto-push — the manual push flow is unchanged.

    def _push_targets(self):
        """
        Build the list of (repo, path, bytes, message) to push.
        Map editor pushes roads.json, zones.json, and overpasses.json
        to the map repo.
        """
        from data import export_full_roads, export_full_zones
        repo = "kingmarkarnold-code/adamsville-map-editor"
        targets = [
            (repo, "roads.json", export_full_roads(),
             "Map editor: update roads.json"),
            (repo, "zones.json", export_full_zones(),
             "Map editor: update zones.json"),
        ]
        # Overpasses (Joshua 2026-10-11): only push if there are any.
        overpasses = getattr(self, "overpasses", [])
        if overpasses:
            targets.append(
                (repo, "overpasses.json", export_overpasses(overpasses),
                 "Map editor: update overpasses.json"))
        return targets

    def _mark_unpublished(self):
        """Mark that local edits haven't been pushed yet."""
        self._unpublished = True
        # First save without a token: offer to set one up for auto-push.
        if not github_sync.has_token() and not self._token_prompted:
            self._token_prompted = True
            if github_sync.show_first_save_prompt(self.window):
                self._do_push()

    def _auto_push_tick(self):
        """
        Word-style auto-push timer: every 5 minutes, if there are
        unpublished changes and a token is set, push them.
        Returns True to keep the timer running.
        """
        if self._unpublished and github_sync.has_token():
            self._do_push(silent=True)
        return True  # keep the timer alive

    def _do_push(self, silent=True):
        """
        Push local edits to GitHub via the Contents API.
        On success clears the unpublished flag.
        """
        if not github_sync.has_token():
            if not silent:
                self.set_status("No GitHub token — set one in File → Settings.")
            return False
        self.set_status("Pushing to GitHub…")
        targets = self._push_targets()
        import threading
        from gi.repository import GLib
        def worker():
            ok, msg = github_sync.push_targets(targets)
            def done():
                if ok:
                    self._unpublished = False
                    self.set_status("Pushed to GitHub ✓")
                else:
                    self.set_status(f"Push failed: {msg}")
                return False
            GLib.idle_add(done)
        threading.Thread(target=worker, daemon=True).start()
        return True

    def on_settings_clicked(self, widget):
        """
        Settings: GitHub API key management (changeable in-app, no
        reinstall needed). Shared across all suite apps.
        """
        def on_key_changed(key_set):
            if key_set:
                self.set_status("GitHub API key saved — auto-push enabled.")
                if self._unpublished:
                    self._do_push(silent=False)
            else:
                self.set_status("GitHub API key removed — manual push only.")
        github_sync.show_settings_dialog(self.window, on_key_changed)

    def _show_close_warning(self):
        """
        Ask what to do with unpublished changes on window close.
        Returns "push", "close", or "cancel".
        """
        dialog = Gtk.MessageDialog(
            transient_for=self.window, flags=0,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.NONE,
            text="Unpublished changes")
        dialog.format_secondary_text(
            "You have unpublished changes. "
            "Would you like to push to GitHub?")
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("Close Without Pushing", Gtk.ResponseType.NO)
        dialog.add_button("Push & Close", Gtk.ResponseType.YES)
        dialog.set_default_response(Gtk.ResponseType.YES)
        resp = dialog.run()
        dialog.destroy()
        if resp == Gtk.ResponseType.YES:
            return "push"
        if resp == Gtk.ResponseType.NO:
            return "close"
        return "cancel"

    def on_push_clicked(self, widget):
        """
        File → Push to GitHub: manual on-demand push.
        If a token is set, pushes via the API. Otherwise shows the
        manual copy/download instructions (fallback).
        """
        # Make sure in-memory road edits are persisted first.
        self.persist_road_edits()
        if github_sync.has_token():
            self._do_push(silent=False)
            return
        # No token: fall back to the manual flow.
        if github_sync.show_token_dialog(self.window):
            self._do_push(silent=False)
            return
        dialog = Gtk.MessageDialog(
            transient_for=self.window,
            flags=0,
            message_type=Gtk.MessageType.INFO,
            buttons=Gtk.ButtonsType.OK,
            text="Push to GitHub")
        dialog.format_secondary_text(
            "Your edits are saved locally.\n\n"
            "To push them: use the web editor's 'Push to GitHub' button, "
            "or send your edits to Mollie and she'll push them.\n\n"
            "Tip: set a GitHub token in File → Settings to push "
            "directly from here.")
        dialog.run()
        dialog.destroy()

    # ------------------------------------------------------------------
    # Help and About
    # ------------------------------------------------------------------

    def show_help(self, widget=None):
        """Show the tool glossary dialog."""
        dialog = Gtk.Dialog(
            title="Tool Glossary", transient_for=self.window, flags=0)
        dialog.set_default_size(450, 400)

        # Scrolled text view with all tool descriptions
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)

        textview = Gtk.TextView()
        textview.set_editable(False)
        textview.set_wrap_mode(Gtk.WrapMode.WORD)
        buf = textview.get_buffer()

        lines = []
        for tool_id, label, tooltip, help_text in TOOLS:
            lines.append(f"• {label}: {help_text}")
        buf.set_text("\n\n".join(lines))

        scrolled.add(textview)
        dialog.get_content_area().pack_start(scrolled, True, True, 0)

        dialog.add_button("Close", Gtk.ResponseType.CLOSE)
        dialog.show_all()
        dialog.run()
        dialog.destroy()

    def show_about(self, widget):
        """Show the About dialog (app icon + Mollie icon + credits)."""
        show_about_dialog(self.window, APP_NAME, APP_VERSION,
                          APP_ICON, APP_PACKAGE)

    def on_check_app_updates(self, widget):
        """Help -> Check for Updates: in-place app update flow."""
        # (Named on_check_app_updates to avoid colliding with the
        # existing View-menu on_check_updates, which checks road-data.)
        # (Joshua 2026-10-12: update the installed app in
        # place instead of reinstalling the .deb.)
        # v1.8.2: guard — this handler is only wired when the updater
        # imported successfully, but never trust the menu state.
        if not _UPDATER_AVAILABLE or updater is None:
            return
        updater.check_for_updates_gui(
            self.window, APP_NAME, APP_VERSION,
            UPDATE_SLUG, UPDATE_MANIFEST_URL)

    # ------------------------------------------------------------------
    # Error dialogs
    # ------------------------------------------------------------------

    def _show_error(self, title, message):
        """Show an error message dialog."""
        dialog = Gtk.MessageDialog(
            transient_for=self.window,
            flags=0,
            message_type=Gtk.MessageType.ERROR,
            buttons=Gtk.ButtonsType.OK,
            text=title)
        dialog.format_secondary_text(message)
        dialog.run()
        dialog.destroy()


def main():
    """Application entry point."""
    # v1.8.2 (Joshua 2026-10-12): crash logger. If the editor fails to
    # start on Joshua's machine, the traceback is written to
    # ~/.cache/adamsville-map-editor-native/crash.log so the real cause
    # can be diagnosed instead of failing silently.
    try:
        ensure_data_dir()
        app = MapEditorApp()
        Gtk.main()
    except Exception:
        try:
            import traceback
            from pathlib import Path
            log_dir = Path.home() / ".cache" / "adamsville-map-editor-native"
            log_dir.mkdir(parents=True, exist_ok=True)
            with open(log_dir / "crash.log", "w") as f:
                f.write("Adamsville Map Editor %s crash log\n" % APP_VERSION)
                traceback.print_exc(file=f)
        except Exception:
            pass
        raise


if __name__ == "__main__":
    main()
