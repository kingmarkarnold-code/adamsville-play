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
    export_overpasses, save_local_cache,
)
from mapcanvas import MapCanvas, _direction_words
from roadinspect import RoadInspectorPanel  # noqa: E402 -- 3D road inspector
# Pieces panel (1.9.10): the selection contents list + the
# stacked-pieces finder dock (Joshua's Blender recording,
# 2026-10-23 — a selection must list what it contains, and
# stacked pieces must be findable by name).
from piecespanel import PiecesPanel  # noqa: E402
import stacked as stacked_mod  # noqa: E402 -- the finder scan (pure)
# Overpass linking + smart pillar placement (Joshua 2026-10-11).
import overpass as overpass_mod  # noqa: E402


# App version shown in the Help -> About dialog (bump with each release).
# Joshua 2026-10-11: version number must be prominent in About.
APP_VERSION = "1.9.10"
# Display name and icon-theme name for the About dialog.
APP_NAME = "Adamsville Map Editor"
APP_ICON = "adamsville-map-editor-native"
APP_PACKAGE = "adamsville-map-editor-native"
# In-place updater (Joshua 2026-10-12): Help -> Check for
# Updates downloads new editor files from GitHub and applies
# them in place, so reinstalling the .deb is not needed.
UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/kingmarkarnold-code/adamsville-play/main/editors/map-editor/version.json"
UPDATE_SLUG = "map-editor"



# ---------------------------------------------------------------------------
# Tool definitions for toolbar and help dialog
# ---------------------------------------------------------------------------

# Each tool: (id, label, tooltip, help_text)
#
# INTERACTION MODEL (1.9.7, Joshua 2026-10-18): Pan and Select are
# NOT tools any more — dragging the map always pans, and clicking a
# road always selects it, with no mode to enter. Delete is not a
# tool either: it is the toolbar's Delete ACTION button, acting on
# the current selection (see on_delete_clicked). What remains in
# this table are the genuine editing tools, entered on purpose and
# left by clicking the same button again.
TOOLS = [
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
        # 1.9.0: the game-data model (gamedata.GameModel) adopted by
        # _load_data() after the download-on-open, and the ground port
        # used to re-drape geometry edits (ground.GroundModel). Both
        # stay None until data loads.
        self.game_model = None
        self._ground = None
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
        # Round-trip re-entrancy guard (1.9.4 — see round_trip_save):
        # _round_trip_in_flight is True while one save trip is running;
        # _round_trip_followup remembers that another trigger arrived
        # mid-trip (any number of them coalesce into this one flag);
        # _trip_sent_snapshot holds the bytes the in-flight trip set
        # out to push, so the finisher can tell whether the model
        # actually changed while the trip was away.
        self._round_trip_in_flight = False
        self._round_trip_followup = False
        self._trip_sent_snapshot = {}
        # Word-style auto-push: every 5 minutes if there are unpublished
        # changes and a GitHub token is set (Joshua 2026-10-11).
        from gi.repository import GLib as _GLib
        _GLib.timeout_add_seconds(300, self._auto_push_tick)

        # Pieces panel state (1.9.10): the stacked-finder scan
        # runs on a worker thread; the token drops a stale result
        # if a second scan is started, and _stacked_results holds
        # the last finished scan's rows (result dicts from
        # stacked.py) for the panel.
        self._stacked_token = 0
        self._stacked_running = False
        self._stacked_results = []

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
        # One-live-pane rule (1.9.8): which pane is being
        # manipulated ("map" normally; "3d" while the 3D viewport
        # is live). Every other pane holds a still.
        self.live_pane = "map"
        self.canvas = MapCanvas(self)
        self.main_paned = Gtk.HPaned()
        # Delete confirmation bar (1.9.7): the canvas sits inside a
        # Gtk.Overlay so the slim Delete / Cancel bar can ride the
        # TOP EDGE of the map while a road is lit up for deletion.
        # An overlay — not a layout box — so showing or hiding the
        # bar never resizes the canvas: the framed "photograph" of
        # the road keeps the exact geometry it was framed with.
        self.canvas_overlay = Gtk.Overlay()
        self.canvas_overlay.add(self.canvas)
        self._build_delete_bar()
        self.canvas_overlay.add_overlay(self.delete_bar)
        # 1.9.10: the Pieces panel (selection contents list +
        # stacked-pieces finder) docks BELOW the map in the
        # canvas column, in a vertical paned whose sash Joshua
        # can drag — including nearly shut. It does NOT share
        # the inspector's column: the inspector's own internal
        # split (area view over elevation view at a fixed 300)
        # needs the column's full height, and squeezing it
        # starved the elevation pane. The canvas's framing math
        # is all allocation-relative, so a shorter canvas is
        # safe; the initial sash position is set in
        # _initial_setup once the real height is known.
        self.pieces_panel = PiecesPanel(self)
        self.canvas_paned = Gtk.VPaned()
        self.canvas_paned.pack1(self.canvas_overlay, resize=True,
                                shrink=False)
        self.canvas_paned.pack2(self.pieces_panel, resize=False,
                                shrink=True)
        self.main_paned.pack1(self.canvas_paned, resize=True,
                              shrink=False)

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

        # No default tool (1.9.7 interaction model): the editor
        # rests with NO mode active — dragging pans, clicking a
        # road selects it. Tools are entered on purpose from the
        # toolbar and left by clicking the same button again.

        # --- Status bar ---
        self.statusbar = Gtk.Statusbar()
        self.status_ctx = self.statusbar.get_context_id("main")
        vbox.pack_start(self.statusbar, False, False, 0)
        # Background-work progress bar (1.9.7, Joshua's suite law):
        # rides the RIGHT END of the status bar — the bottom-right
        # corner of the window — whenever the app is working in the
        # background, so a busy app never reads as frozen.
        self._build_progress_bar()
        self._build_heading_box()
        self.set_status(
            "Click a road to select it — then Merge, Join, or "
            "Delete. Drag the map to pan.")

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
        # Q / E rotate the shared view (1.9.8): every viewpoint
        # turns together. Shift = bigger steps. Same text-focus
        # guard as undo: never steal keys from an entry.
        if not ctrl:
            try:
                focus = self.window.get_focus()
                if isinstance(focus, (Gtk.Entry, Gtk.TextView,
                                      Gtk.SearchEntry)):
                    return False
            except Exception:
                pass
            key = (Gdk.keyval_name(event.keyval) or "").lower()
            step = 15 if shift else 5
            if key == "q":
                self.canvas.rotate_by(-step)
                return True
            if key == "e":
                self.canvas.rotate_by(step)
                return True
            # Universal controls (1.9.9): + / - zoom the shared
            # view at its centre — the keyboard twin of the
            # wheel, identical in every pane.
            if event.keyval in (Gdk.KEY_plus, Gdk.KEY_KP_Add,
                                Gdk.KEY_equal):
                alloc = self.canvas.get_allocation()
                self.canvas.zoom_at(alloc.width / 2,
                                    alloc.height / 2, 1.25)
                return True
            if event.keyval in (Gdk.KEY_minus, Gdk.KEY_KP_Subtract,
                                Gdk.KEY_underscore):
                alloc = self.canvas.get_allocation()
                self.canvas.zoom_at(alloc.width / 2,
                                    alloc.height / 2, 0.8)
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

        for tool_id, label, tooltip, _ in TOOLS:
            # Toggle buttons (1.9.7): on_tool_toggled keeps at most
            # one tool active, and clicking the active tool again
            # returns to the resting state — no tool at all, where
            # dragging pans and clicking selects. (These were radio
            # buttons while Pan/Select were modes; a radio group
            # would force some tool to always be active.)
            btn = Gtk.ToggleToolButton(label=label)
            btn.set_tooltip_text(tooltip)
            # Capture tool_id in default arg
            btn.connect("toggled", self.on_tool_toggled, tool_id)
            toolbar.insert(btn, -1)
            self.tool_buttons[tool_id] = btn
        # Fill is only available while the Zone tool is active
        # (Joshua 2026-10-11); it starts insensitive and
        # on_tool_toggled maintains that.
        self.tool_buttons["fill"].set_sensitive(False)

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

        # Delete action button (1.9.7): NOT a tool or mode — it acts
        # on the current selection, like Merge and Join. With roads
        # selected it opens the framed delete preview (the map
        # frames the whole road and lights it up before any
        # decision); with nothing selected it just says so.
        self.delete_button = Gtk.ToolButton(label="Delete")
        self.delete_button.set_tooltip_text(
            "Delete the selected road(s). First the map frames the "
            "whole road and lights it up so you can check it — "
            "nothing is deleted until you confirm. With nothing "
            "selected, it just says so.")
        self.delete_button.connect("clicked", self.on_delete_clicked)
        toolbar.insert(self.delete_button, -1)

        # Rename action (1.9.8 — the pencil): renames the SELECTED
        # PIECE (one record, the piece-scoping Joshua ruled for
        # Delete). Sits with the other selection actions.
        self.rename_button = Gtk.ToolButton(label="✎ Rename")
        self.rename_button.set_tooltip_text(
            "Rename the selected road piece. Only that piece "
            "gets the new name — the rest of the street keeps "
            "its own. With nothing selected, it just says so.")
        self.rename_button.connect("clicked", self.on_rename_clicked)
        toolbar.insert(self.rename_button, -1)

        # Detail Edit action (1.9.8): the HANDOFF DOOR to the
        # separate Detail Editor suite app (Joshua's pivot
        # 2026-10-18: the detail editor is its own app, element-
        # agnostic — not a mode inside this one). With a piece
        # selected it prepares the detail handoff file and
        # launches the Detail Editor when it is installed.
        self.detail_button = Gtk.ToolButton(label="Detail Edit")
        self.detail_button.set_tooltip_text(
            "Open the selected piece in the Detail Editor — the "
            "separate suite app for fine detail work (moving, "
            "adding and deleting points and segments).")
        self.detail_button.connect("clicked", self.on_detail_clicked)
        toolbar.insert(self.detail_button, -1)

        # Find Stacked action (1.9.10): NOT a tool or mode — it
        # runs the stacked-pieces scan over the loaded data in
        # the background and fills the Pieces panel's results
        # list (the same button lives in the panel itself). It
        # never deletes anything: each found piece is framed and
        # selected when clicked, and removal is the ordinary
        # Delete flow.
        self.find_stacked_button = Gtk.ToolButton(
            label="Find stacked")
        self.find_stacked_button.set_tooltip_text(
            "Find pieces lying on top of other pieces — "
            "duplicates, zero-length records, covered pieces. "
            "They are listed by name in the Pieces panel so a "
            "buried piece can be checked and deleted. The scan "
            "runs in the background and deletes nothing.")
        self.find_stacked_button.connect(
            "clicked", lambda _b: self.start_find_stacked())
        toolbar.insert(self.find_stacked_button, -1)

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
        """
        Handle toolbar tool toggling (1.9.7 toggle semantics).

        Toggling a tool ON turns every other tool off (at most one
        editing tool is ever active). Toggling the ACTIVE tool OFF
        returns the editor to its resting state — no tool, where
        dragging pans and clicking selects. Programmatic offs done
        by this handler itself are ignored via _switching_tools so
        they don't recursively reset the state being set up.
        """
        if getattr(self, "_switching_tools", False):
            return
        if button.get_active():
            self._switching_tools = True
            for other_id, other in self.tool_buttons.items():
                if other_id != tool_id and other.get_active():
                    other.set_active(False)
            self._switching_tools = False
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
        elif self.canvas.active_tool == tool_id:
            # The active tool was clicked again: back to resting.
            self.canvas.clear_tool_state()
            self.canvas.active_tool = None
            fill_btn = self.tool_buttons.get("fill")
            if fill_btn is not None:
                fill_btn.set_sensitive(False)
            self.set_status(
                "Click a road to select it; drag the map to pan.")

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
            f"The part of {names[0]} lying over {names[1]} is "
            f"drawn back to the first of {names[1]}'s edges it "
            "reaches, and its end is lined up along that edge — "
            "straight, curved or diagonal as the meeting lies. "
            "Both roads stay as separate objects, and "
            f"{names[1]} itself is not changed.")
        # Before/After (1.9.8): while the decision is up, the
        # companion panes hold the comparison stills — Before the
        # two roads as they are, After the source drawn back onto
        # the target's near edge.
        preview = self.canvas.compute_merge_result()
        if preview is not None:
            road_s, road_t, new_s = preview
            self._open_compare(
                [road_s, road_t], {id(road_s)}, [new_s],
                "Before — as they are",
                "After — first road drawn back onto the second's near edge",
                [road_s, road_t])
        resp = dialog.run()
        dialog.destroy()
        self.inspector.clear_compare()
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
            f"They will become one road, keeping {names[0]}'s name. "
            "The space between them is formed for them — straight "
            "when their ends run straight, curved when they bend — "
            "so the joined road is a single piece.")
        # Before/After (1.9.8): Before the two pieces as they
        # are, After the single joined road.
        preview = self.canvas.compute_join_result()
        if preview is not None:
            road_a, road_b, new_road = preview
            self._open_compare(
                [road_a, road_b], {id(road_a), id(road_b)},
                [new_road],
                "Before — as they are",
                "After — joined into one road",
                [road_a, road_b, new_road])
        resp = dialog.run()
        dialog.destroy()
        self.inspector.clear_compare()
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
        # Linking moved the road's endpoint onto the overpass — a
        # geometry edit, so the road re-drapes (1.9.0).
        self.apply_road_modify(cat, road, geometry=True)
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
        Called at startup, after _load_data adopts a model (1.9.2),
        and after Fill Unzoned Area creates new zones.
        """
        # Remove old children
        for child in self.zones_menu.get_children():
            self.zones_menu.remove(child)
        for i, zone in enumerate(ZONES):
            zi = Gtk.MenuItem(label=zone["name"])
            # Use default args to capture the loop variables. The item
            # hands zoom_to_zone BOTH its position and the name it
            # displays (1.9.2): ZONES is rebuilt in place when a model
            # is adopted, so a position captured earlier can silently
            # point at a different zone — the displayed name is the
            # ground truth for what the user picked.
            zi.connect("activate",
                       lambda w, idx=i, name=zone["name"]:
                       self.zoom_to_zone(idx, name))
            self.zones_menu.append(zi)
        self.zones_menu.show_all()

    def zoom_to_zone(self, idx, name=None):
        """Zoom the canvas to fit a zone's polygon bounds, and select it."""
        # 1.9.2: if the caller's index no longer points at the zone it
        # named (data.ZONES was rebuilt in place after the caller
        # captured the index — the wrong-zone jump Joshua hit on
        # 2026-10-16), resolve by name instead. The label the user
        # clicked must always win over a stale position.
        if name is not None and (not (0 <= idx < len(ZONES))
                                 or ZONES[idx]["name"] != name):
            match = [j for j, z in enumerate(ZONES)
                     if z["name"] == name]
            if not match:
                return
            idx = match[0]
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
        # The companion panes follow the jump (1.9.8).
        self.on_camera_changed()

    # ------------------------------------------------------------------
    # Status bar
    # ------------------------------------------------------------------

    def set_status(self, message):
        """Show a message in the status bar."""
        self.statusbar.pop(self.status_ctx)
        self.statusbar.push(self.status_ctx, message)

    # ------------------------------------------------------------------
    # Background-work progress bar (1.9.7 — Joshua's suite law,
    # 2026-10-18): whenever the editor is doing background work —
    # downloading, pushing, or heavy processing like preparing a
    # delete preview — a progress bar shows in the BOTTOM-RIGHT
    # corner of the window (the right end of the status bar), so a
    # busy app never reads as frozen. Real progress where a total
    # is known; a moving indeterminate pulse where it isn't. It
    # appears when work starts and clears when work ends, and it
    # lives inside the status area, so it never covers the map or
    # any of the map's controls.
    #
    # Jobs are keyed (several can run at once); the bar shows the
    # most recently started/updated job. All methods are UI-thread
    # only — worker threads hop here with GLib.idle_add, exactly
    # like the download progress callbacks already do.
    # ------------------------------------------------------------------

    def _build_progress_bar(self):
        """Build the corner progress widget (hidden while idle)."""
        self._progress_jobs = {}  # job_id -> {"label", "fraction"}
        self._progress_pulse_id = None
        self.progress_box = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.progress_label = Gtk.Label(label="")
        self.progress_bar_widget = Gtk.ProgressBar()
        self.progress_bar_widget.set_size_request(170, -1)
        self.progress_box.pack_start(
            self.progress_label, False, False, 0)
        self.progress_box.pack_start(
            self.progress_bar_widget, False, False, 0)
        self.progress_box.set_no_show_all(True)
        self.progress_box.hide()
        self.statusbar.pack_end(self.progress_box, False, False, 4)

    def progress_start(self, job_id, label):
        """Register a background job and show the corner bar."""
        if not hasattr(self, "_progress_jobs"):
            return  # progress UI not built (partial/headless app)
        self._progress_jobs[job_id] = {"label": label,
                                       "fraction": None}
        self._refresh_progress_bar()

    def progress_update(self, job_id, fraction=None, label=None):
        """Update a job's fraction (0..1) and/or label."""
        if not hasattr(self, "_progress_jobs"):
            return  # progress UI not built (partial/headless app)
        job = self._progress_jobs.get(job_id)
        if job is None:
            return
        if fraction is not None:
            job["fraction"] = max(0.0, min(1.0, fraction))
        if label is not None:
            job["label"] = label
        self._refresh_progress_bar()

    def progress_finish(self, job_id):
        """End a background job; the bar clears when none remain."""
        if not hasattr(self, "_progress_jobs"):
            return  # progress UI not built (partial/headless app)
        self._progress_jobs.pop(job_id, None)
        self._refresh_progress_bar()

    def _refresh_progress_bar(self):
        """Make the corner bar reflect the current job set."""
        if not hasattr(self, "progress_box"):
            return  # progress UI not built (partial/headless app)
        if not self._progress_jobs:
            self._stop_progress_pulse()
            self.progress_box.hide()
            return
        job = list(self._progress_jobs.values())[-1]
        self.progress_label.set_text(job["label"])
        if job["fraction"] is None:
            # No known total: indeterminate — keep the pulse moving
            # so the bar visibly works.
            self.progress_bar_widget.set_fraction(0.0)
            if self._progress_pulse_id is None:
                self._progress_pulse_id = GLib.timeout_add(
                    120, self._pulse_progress_bar)
        else:
            self._stop_progress_pulse()
            self.progress_bar_widget.set_fraction(job["fraction"])
        # show() per widget: the box carries no_show_all (so window
        # show_all never pops it up), and GTK's show_all() honours
        # that flag even on the widget itself.
        self.progress_label.show()
        self.progress_bar_widget.show()
        self.progress_box.show()

    def _pulse_progress_bar(self):
        """Indeterminate pulse tick; returns False to stop."""
        if not any(j["fraction"] is None
                   for j in self._progress_jobs.values()):
            self._progress_pulse_id = None
            return False
        self.progress_bar_widget.pulse()
        return True

    def _stop_progress_pulse(self):
        if self._progress_pulse_id is not None:
            GLib.source_remove(self._progress_pulse_id)
            self._progress_pulse_id = None

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
        # 1.9.10: the Pieces panel lists the selection's
        # contents — refresh it with every selection change.
        self._refresh_pieces_panel()

    # ------------------------------------------------------------------
    # Pieces panel + stacked finder (1.9.10, Joshua 2026-10-23)
    #
    # From his Blender recording: he selected one spot, the count
    # said 4 objects, only 3 were visible — a piece stacked on
    # the same ground was invisible, unclickable, and nothing
    # listed what the selection contained, so the extra piece
    # could not be singled out or removed. The Pieces panel
    # (docked below the map) lists EVERY selected piece by
    # name; clicking a row isolates it (framed, lit alone, the
    # rest of the selection quiet). Find Stacked
    # scans the loaded data for pieces lying on other pieces and
    # lists them for review. Removal is ALWAYS the ordinary
    # framed Delete flow — nothing here deletes directly.
    # ------------------------------------------------------------------

    def zone_display_name(self, zone_id):
        """Display name for a zone id ('eastatlanta' -> 'East
        Atlanta'), from the loaded zone list; falls back to the
        id itself, capitalised."""
        if not zone_id:
            return "—"
        try:
            import data as _data_mod
            for zone in _data_mod.ZONES:
                if zone.get("zone_id") == zone_id:
                    return zone.get("name", zone_id)
        except Exception:
            pass
        return zone_id.capitalize()

    def _refresh_pieces_panel(self):
        """
        Sync the Pieces panel with the canvas selection, and
        hold the isolation invariant: an isolated piece that is
        no longer selected stops being isolated (the drawing
        falls back to lighting the whole selection alike).
        """
        panel = getattr(self, "pieces_panel", None)
        if panel is None:
            return  # dock not built yet during early init
        canvas = self.canvas
        if canvas.isolated is not None \
                and canvas.isolated not in canvas.selected_roads:
            canvas.isolated = None
        panel.refresh_selection()
        # Stale stacked rows (a piece deleted since the scan)
        # are dropped: build the live-record id set once per
        # refresh — a few milliseconds over the whole map, and
        # refreshes happen per selection change, not per frame.
        if self._stacked_results and self.roads_data:
            live_ids = {id(r) for lst in self.roads_data.values()
                        for r in lst}
            panel.prune_results(live_ids)
            self._stacked_results = list(panel._results)

    def isolate_selected_piece(self, cat, idx):
        """
        Pieces-panel row click: single ONE selected piece out —
        frame it and light it alone (canvas.isolated), the rest
        of the selection drawn quiet. The selection itself does
        not change: Merge / Join / Delete still see all of it.
        """
        canvas = self.canvas
        if (cat, idx) not in canvas.selected_roads:
            return
        canvas.isolated = (cat, idx)
        canvas.frame_piece(cat, idx)
        name = canvas._road_name_of(cat, idx)
        self.set_status(
            f"Showing '{name}' by itself — it is framed and lit "
            "bright; the rest of the selection is still selected "
            "(drawn pale). 'Show all' in the Pieces panel ends "
            "this.")
        canvas.queue_draw()
        self._refresh_pieces_panel()

    def clear_isolation(self):
        """End an isolation: every selected piece lights alike."""
        if self.canvas.isolated is not None:
            self.canvas.isolated = None
            self.canvas.queue_draw()
        self._refresh_pieces_panel()

    def delete_one_piece(self, cat, idx, road):
        """
        A Pieces-panel row's Delete button: send THAT ONE piece
        into the ordinary delete confirmation flow — the same
        framed picture + top bar the toolbar Delete button opens
        (on_delete_clicked's machinery, one record). No new
        delete path: the bar owns the decision, Cancel restores
        the view, and the standing save rule applies inside.
        """
        canvas = self.canvas
        if canvas.delete_preview is not None \
                or canvas.delete_prep is not None:
            self.set_status(
                "Delete: finish the road shown first — "
                "Delete it, or Cancel in the bar at the top.")
            return
        canvas.begin_delete_preview([(cat, idx, road)])

    def _stacked_entries(self):
        """
        Build the finder scan's entry list from the working
        copy: one entry per record, carrying its category, its
        zone, and its index WITHIN that zone + category (the
        numbering the audit and the zone files use — e.g.
        adamsville major_artery 173). The merged working copy
        holds each zone's records contiguously in file order
        (gamedata.merged_roads), so a per-(zone, category)
        counter reproduces the file indices exactly.
        """
        entries = []
        counters = {}
        for cat, roads in (self.roads_data or {}).items():
            for road in roads:
                zone = road.get("_zone") or ""
                key = (zone, cat)
                idx = counters.get(key, 0)
                counters[key] = idx + 1
                entries.append({"cat": cat, "zone": zone,
                                "idx": idx, "road": road})
        return entries

    def start_find_stacked(self):
        """
        Find Stacked: scan the loaded data for stacked pieces
        on a worker thread (Progress Bar Law — the corner bar
        runs for the whole scan), then fill the Pieces panel's
        results list. Read-only: the scan never mutates a
        record, so the data counts are identical afterwards.
        """
        if self._stacked_running:
            self.set_status(
                "Find stacked: a scan is already running — "
                "watch the progress bar in the corner.")
            return
        if not self.roads_data:
            self.set_status(
                "Find stacked: no map data is loaded yet.")
            return
        self._stacked_token += 1
        token = self._stacked_token
        self._stacked_running = True
        panel = getattr(self, "pieces_panel", None)
        if panel is not None:
            panel.set_scanning(True)
        self.progress_start("find-stacked",
                            "Looking for stacked pieces…")
        self.set_status(
            "Find stacked: scanning the loaded map in the "
            "background — nothing will be deleted.")
        entries = self._stacked_entries()

        def report(frac):
            # Worker -> UI thread hop for the progress bar.
            GLib.idle_add(self.progress_update,
                          "find-stacked", frac)

        def worker():
            try:
                results = stacked_mod.scan_stacked(
                    entries, on_progress=report)
            except Exception:
                results = None  # landing reports the failure
            GLib.idle_add(self._find_stacked_done, token, results)

        threading.Thread(target=worker, daemon=True).start()

    def _find_stacked_done(self, token, results):
        """UI-thread landing for a finished stacked scan."""
        if token != self._stacked_token:
            return False  # superseded — drop it
        self._stacked_running = False
        self.progress_finish("find-stacked")
        panel = getattr(self, "pieces_panel", None)
        if panel is not None:
            panel.set_scanning(False)
        if results is None:
            self.set_status(
                "Find stacked: the scan failed — the map data "
                "was not changed.")
            return False
        self._stacked_results = results
        if panel is not None:
            panel.show_results(results)
        certain = sum(1 for r in results
                      if r["tier"] == stacked_mod.TIER_CERTAIN)
        self.set_status(
            f"Find stacked: {len(results)} pieces found "
            f"({certain} certain, {len(results) - certain} to "
            "review). Click one in the Pieces panel to see it; "
            "nothing was deleted.")
        return False

    def _flat_index_of(self, road):
        """
        The spatial-index (cat, flat_idx) for a live road dict,
        by identity — the mapping the canvas selection uses.
        None when the record is not indexed (a record with fewer
        than 2 points has no line to index).
        """
        si = self.spatial_index
        if si is None:
            return None
        for flat, (cat, indexed, *_rest) in enumerate(si.roads):
            if indexed is road:
                return (cat, flat)
        return None

    def reveal_stacked_piece(self, result):
        """
        Stacked-results row click: select the found piece and
        frame it, exactly as if Joshua had clicked it on the
        map — from there the ordinary actions (Delete included)
        apply. A record the index cannot hold (no line) is
        framed by its own points and explained instead.
        """
        road = result["road"]
        canvas = self.canvas
        found = self._flat_index_of(road)
        name = stacked_mod.display_name(road)
        if found is None:
            # Not in the spatial index (fewer than 2 points):
            # frame the spot from the record's own points.
            pts = road.get("pts") or []
            if pts:
                xs = [p[0] for p in pts]
                zs = [p[1] for p in pts]
                canvas.frame_rect(min(xs) - 30, min(zs) - 30,
                                  max(xs) + 30, max(zs) + 30)
            self.set_status(
                f"'{name}': {result['why']}. This piece has no "
                "line to select — the map is framed on its spot.")
            return
        cat, flat = found
        canvas.selected_roads = [(cat, flat)]
        canvas.isolated = None
        self.on_roads_selected()
        canvas.frame_piece(cat, flat)
        self.set_status(
            f"'{name}': {result['why']}. It is selected and "
            "framed — check it, then Delete removes just this "
            "piece.")
        canvas.queue_draw()

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
    # Linked viewpoints (1.9.8): one shared camera, one live pane,
    # Before/After comparisons.
    #
    # The canvas owns the ONE camera (cam_x / cam_y / zoom /
    # rotation). Every camera move funnels into on_camera_changed
    # (the canvas calls it after its own moves; pane gestures and
    # programmatic jumps call it too), which is the single place
    # the companion panes are told to follow.
    #
    # One-live-pane rule (Joshua): at most one pane renders
    # continuously — the one being manipulated. Making the 3D
    # viewport live stills the map + elevation panes; touching
    # the map (or the elevation pane) makes the map live again
    # and returns the 3D viewport to a still.
    #
    # During a delete / join / merge / batch decision the panes
    # hold Before/After STILLS (compare mode in the inspector
    # panel): no sync, no redraws, exactly one still refresh per
    # selection change — Joshua's static-viewports rule.
    # ------------------------------------------------------------------

    def on_camera_changed(self):
        """The shared camera moved: sync the companion panes."""
        insp = getattr(self, "inspector", None)
        # Heading readout follows the same truth.
        if hasattr(self, "heading_label"):
            deg = int(round(self.canvas.rotation)) % 360
            self.heading_label.set_text(f"Heading {deg:03d}°")
        if insp is None:
            return
        if insp.compare_active():
            return  # static rule: the stills hold, nothing follows
        if self.live_pane == "3d":
            # Only the live pane redraws; the map side holds its
            # stills (their draw handlers blit the cache).
            insp.cp_viewer.queue_draw()
            return
        insp.elev_viewer.queue_draw()
        insp.cp_viewer.invalidate_still()
        # New area on screen: make sure its buildings are coming
        # (the panel gates this on the pane being awake).
        insp.request_area_data()

    def note_pane_touched(self, which):
        """
        A pane was grabbed for manipulation: it becomes the live
        pane and every other pane returns to a still. Called by
        the canvas ("map"), the elevation pane ("map") and the 3D
        viewport ("3d"). A no-op during comparisons.
        """
        insp = getattr(self, "inspector", None)
        if insp is not None and insp.compare_active():
            return
        self.set_live_pane(which)

    def set_live_pane(self, which):
        """Switch the one live pane ("map" | "3d")."""
        insp = getattr(self, "inspector", None)
        if insp is None:
            self.live_pane = which
            return
        self.live_pane = which
        cp = insp.cp_viewer
        if which == "3d":
            cp.live = True
            self.canvas.stilled = True
            insp.elev_viewer.stilled = True
        else:
            if cp.live:
                cp.live = False
                cp.invalidate_still()
            self.canvas.stilled = False
            self.canvas._still_surface = None
            insp.elev_viewer.stilled = False
            insp.elev_viewer._still_surface = None
        insp._sync_live_button()
        self.canvas.queue_draw()
        cp.queue_draw()
        insp.elev_viewer.queue_draw()

    # -- Before/After comparisons --------------------------------

    def _snapshot_camera(self):
        """A private copy of the shared camera (same class, same
        state) for a comparison's framing."""
        import copy as _copy
        return _copy.copy(self.canvas._camera)

    def _compare_camera_for(self, roads):
        """
        The framing camera for a comparison: a snapshot fitted to
        the given roads' combined extent (photograph framing —
        whole pieces + margin), computed against the Before
        pane's size so BOTH panes share the exact same centre,
        zoom and heading.
        """
        cam = self._snapshot_camera()
        xs, zs = [], []
        for road in roads:
            for px, pz in road.get("pts") or []:
                xs.append(px)
                zs.append(pz)
        if not xs:
            return cam
        insp = self.inspector
        alloc = insp.cp_viewer.get_allocation()
        w = max(320, alloc.width)
        h = max(240, alloc.height)
        cam.fit_rect(w, h, min(xs), min(zs), max(xs), max(zs),
                     margin=1.18)
        return cam

    def _open_compare(self, targets, omit_ids, extra_roads,
                      before_text, after_text, frame_roads,
                      cam=None):
        """
        Switch the companion panes to a Before/After comparison.
        targets are lit in Before; omit_ids vanish in After;
        extra_roads (result pieces) appear only in After. The
        framing camera is fitted to frame_roads unless `cam`
        is given (single delete: the main view's own framed
        camera, so the panes match the photograph exactly).
        """
        insp = getattr(self, "inspector", None)
        if insp is None:
            return
        if self.insp_collapsed:
            self.toggle_inspector()
        if cam is None:
            cam = self._compare_camera_for(frame_roads)
        insp.set_compare(cam, targets, omit_ids,
                         extra_roads=extra_roads,
                         before_text=before_text,
                         after_text=after_text)

    def on_delete_preview_begin(self, roads):
        """
        Single-delete caveat: the delete preview just framed the
        piece(s) in the main view — the panes now show Before
        (framed exactly like the main view) and After (the same
        framing with the piece(s) removed).
        """
        targets = [road for _cat, _idx, road in roads]
        # The delete framing IS the main camera's new state; the
        # comparison uses THAT framing exactly (identical centre,
        # zoom and heading to the main view's photograph).
        self._open_compare(
            targets, {id(r) for r in targets}, [],
            "Before — as it is now",
            "After — with the piece removed",
            targets, cam=self._snapshot_camera())

    def on_delete_preview_end(self):
        """Delete decided (either way): panes back to synced."""
        insp = getattr(self, "inspector", None)
        if insp is not None:
            insp.clear_compare()
        # 1.9.10: a confirmed delete cleared the selection
        # inside apply_road_delete (which does not funnel
        # through on_roads_selected) — resync the Pieces panel
        # here so its list never shows a deleted piece.
        self._refresh_pieces_panel()

    # -- Detail Edit handoff (the door to the Detail Editor) -----

    # The Detail Editor's suite identity, by the same convention
    # as every suite app (adamsville-<name>-native).
    DETAIL_EDITOR_BIN = "adamsville-detail-editor-native"
    DETAIL_HANDOFF_NAME = "open-in-detail-editor.json"

    def on_detail_clicked(self, _button=None):
        """
        Detail Edit: prepare the detail handoff for the selected
        piece and launch the Detail Editor app.

        The handoff mirrors the suite's street-jump pattern: a
        JSON file in ~/.local/share/adamsville-suite/ named for
        the TARGET app, carrying the element's identity (type,
        zone, category, name) and its points, so the Detail
        Editor can open on exactly this piece. When the Detail
        Editor is not installed, a dialog says so plainly — the
        handoff is still written (it will be there when the app
        arrives), and nothing pretends to have opened.
        """
        sel = self.canvas.selected_roads
        if not sel:
            dialog = Gtk.MessageDialog(
                transient_for=self.window,
                flags=0,
                message_type=Gtk.MessageType.INFO,
                buttons=Gtk.ButtonsType.OK,
                text="Nothing is selected.")
            dialog.format_secondary_text(
                "Click a road to select it first, then press "
                "Detail Edit.")
            dialog.run()
            dialog.destroy()
            return
        cat, idx = sel[-1]
        road = self.canvas._get_road_dict(cat, idx)
        if road is None:
            return
        pts = road.get("pts") or []
        import json as _json
        import shutil
        import subprocess
        from datetime import datetime, timezone
        from pathlib import Path as _Path
        cx = sum(p[0] for p in pts) / len(pts) if pts else 0.0
        cz = sum(p[1] for p in pts) / len(pts) if pts else 0.0
        doc = {
            "element_type": "road",
            "zone": road.get("_zone") or "",
            "category": cat,
            "name": road.get("name") or "",
            "x": cx,
            "z": cz,
            "points": pts,
            "writtenBy": f"Adamsville Map Editor {APP_VERSION}",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        handoff_dir = (_Path.home() / ".local" / "share"
                       / "adamsville-suite")
        try:
            handoff_dir.mkdir(parents=True, exist_ok=True)
            (handoff_dir / self.DETAIL_HANDOFF_NAME).write_text(
                _json.dumps(doc))
            handoff_ok = True
        except Exception:
            handoff_ok = False
        exe = shutil.which(self.DETAIL_EDITOR_BIN)
        if exe is None:
            # Not installed: say so plainly, never fake an open.
            dialog = Gtk.MessageDialog(
                transient_for=self.window,
                flags=0,
                message_type=Gtk.MessageType.INFO,
                buttons=Gtk.ButtonsType.OK,
                text="Detail Editor is not installed.")
            dialog.format_secondary_text(
                "The Detail Editor is a separate suite app and "
                "isn't on this machine yet. "
                + ("The handoff for this piece has been "
                   "prepared — it will open there once the app "
                   "is installed." if handoff_ok else
                   "The handoff could not be written either."))
            dialog.run()
            dialog.destroy()
            self.set_status(
                "Detail Edit: the Detail Editor app is not "
                "installed.")
            return
        try:
            subprocess.Popen([exe],
                             stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
            self.set_status(
                "Detail Edit: opened "
                f"'{doc['name'] or 'Unnamed segment'}' in the "
                "Detail Editor.")
        except Exception:
            self.set_status(
                "Detail Edit: the Detail Editor could not be "
                "launched.")

    def begin_batch_delete(self, corners):
        """
        Batch delete entry (canvas Shift+drag band released):
        collect every piece touching the square in the
        background, then open the batch panel.
        """
        import batchdelete
        batchdelete.collect_and_open(self, corners)

    # -- heading readout ------------------------------------------

    def _build_heading_box(self):
        """
        The heading readout + turn buttons at the status bar's
        right end (left of the progress bar, which stays the
        corner widget): the shared view's current heading, and
        the buttons that turn every viewpoint together.
        """
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                      spacing=4)
        ccw = Gtk.Button(label="⟲")
        ccw.set_tooltip_text("Turn the view left 15° (all views)")
        ccw.connect("clicked",
                    lambda _b: self.canvas.rotate_by(-15))
        box.pack_start(ccw, False, False, 0)
        self.heading_label = Gtk.Label(label="Heading 000°")
        box.pack_start(self.heading_label, False, False, 0)
        cw = Gtk.Button(label="⟳")
        cw.set_tooltip_text("Turn the view right 15° (all views)")
        cw.connect("clicked",
                   lambda _b: self.canvas.rotate_by(15))
        box.pack_start(cw, False, False, 0)
        self.statusbar.pack_end(box, False, False, 4)
        self.heading_box = box

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

    def _ground_model(self):
        """
        The ground port for re-draping (ground.GroundModel over the
        downloaded elev.json), built lazily. None when no elevation
        data is available (re-drape is then skipped, never faked).
        """
        if self._ground is None and self.game_model is not None \
                and self.game_model.elev is not None:
            try:
                import ground as _ground_mod
                self._ground = _ground_mod.GroundModel(
                    self.game_model.elev)
            except Exception:
                self._ground = None
        return self._ground

    def redrape_road(self, road):
        """
        Re-drape ONE road after a GEOMETRY edit (1.9.0): resample to
        <=2.5u stations and reset ys = terrainMeshY + 0.01 via the
        ground port. NON-geometry edits (rename, category, appearance,
        divided sections) never call this — their ys stay
        byte-identical. See ground.py for the full rule.
        """
        gm = self._ground_model()
        if gm is None:
            return
        try:
            import ground as _ground_mod
            _ground_mod.redrape_road(road, gm)
        except Exception:
            pass  # a failed re-drape must never lose the edit itself

    def persist_road_edits(self):
        """
        Persist the working copy LOCALLY (1.9.0): the merged canvas
        roads are adopted back into the per-zone game model and the
        whole model is written to the per-zone local cache, so joins,
        merges, extends and deletes survive restarts. Dirtiness for
        the GitHub round trip is computed from the model itself
        (serialization vs the downloaded baseline) — categories here
        only drive the unpublished flag.
        """
        if not self._dirty_road_cats:
            return
        if self.game_model is not None and self.roads_data is not None:
            self.game_model.adopt_merged_roads(self.roads_data)
            ok, err = save_local_cache(self.game_model)
            if not ok:
                self.set_status(f"local-save-failed: {err}")
                return
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
        # 1.9.0: the restored overlay files are the model's working
        # data too — re-sync so the next round trip diffs correctly.
        try:
            import data as _data_mod
            _data_mod._sync_overlays_to_model()
        except Exception:
            pass
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
            self.canvas.isolated = None
        except Exception:
            pass
        # 1.9.10: the restored records are fresh dicts — the
        # Pieces panel's selection list and any stacked results
        # point at the pre-restore records. Resync the list and
        # drop the stale results.
        self._stacked_results = []
        try:
            self.pieces_panel.reset_results()
            self._refresh_pieces_panel()
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
        # 1.9.0: a join creates NEW geometry — re-drape it onto the
        # ground, and keep road_a's zone attribution (the joined road
        # is written back to road_a's zone file).
        if "_zone" in road_a:
            new_road["_zone"] = road_a["_zone"]
        self.redrape_road(new_road)
        self.roads_data.setdefault(cat_a, []).append(new_road)
        self._dirty_road_cats.add(cat_a)
        if cat_b != cat_a:
            self._dirty_road_cats.add(cat_b)
        self.persist_road_edits()
        self._rebuild_road_index()
        return True

    def apply_road_modify(self, cat, road, geometry=False):
        """
        Merge/Extend commit: the road dict was already mutated in place
        (pts updated). Mark dirty, persist, rebuild index.
        Returns True on success.

        1.9.0: geometry=True marks a GEOMETRY edit (points moved /
        inserted / deleted, whole road moved, endpoint snapped) — the
        road is re-draped (see redrape_road). Callers committing
        non-geometry changes (appearance, category, divided sections,
        cul-de-sac flags) use the default and leave ys untouched.
        """
        if self.roads_data is None:
            return False
        if geometry:
            self.redrape_road(road)
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

    def apply_road_add(self, cat, new_road):
        """
        Add a brand-new road record in a category (Detail Edit's
        middle-segment split creates the second piece this way).
        Mirrors the add half of apply_road_join: re-drape the new
        geometry, persist by the standing save rule, rebuild the
        index. Returns True on success.
        """
        if self.roads_data is None:
            return False
        self.redrape_road(new_road)
        self.roads_data.setdefault(cat, []).append(new_road)
        self._dirty_road_cats.add(cat)
        self.persist_road_edits()
        self._rebuild_road_index()
        return True

    def apply_road_delete_batch(self, picked):
        """
        Batch delete commit: remove many records with ONE persist
        and ONE index rebuild (the single-delete apply persists
        per record — a batch of dozens must not). picked is a
        list of (category, road). Returns True when every record
        was removed.
        """
        if self.roads_data is None:
            return False
        ok = True
        for cat, road in picked:
            if self._remove_road_from_working_copy(cat, road):
                self._dirty_road_cats.add(cat)
            else:
                ok = False
        self.persist_road_edits()
        self._rebuild_road_index()
        self.canvas.selected_roads = []
        self._update_merge_join_buttons()
        return ok

    def apply_road_rename(self, cat, road, new_name):
        """
        Rename ONE road record in place (the pencil action —
        piece-scoped like Delete). Persisted by the standing save
        rule. Returns True on success.
        """
        if self.roads_data is None:
            return False
        road["name"] = new_name
        self._dirty_road_cats.add(cat)
        self.persist_road_edits()
        self._rebuild_road_index()
        return True

    def on_rename_clicked(self, _button=None):
        """
        ✎ Rename: a small dialog prefilled with the selected
        piece's current name (blank for the many unnamed pieces).
        Saving applies the standing save rule; the editor then
        shows the name that came back from the download.
        """
        sel = self.canvas.selected_roads
        if not sel:
            dialog = Gtk.MessageDialog(
                transient_for=self.window,
                flags=0,
                message_type=Gtk.MessageType.INFO,
                buttons=Gtk.ButtonsType.OK,
                text="Nothing is selected.")
            dialog.format_secondary_text(
                "Click a road to select it first, then press "
                "✎ Rename.")
            dialog.run()
            dialog.destroy()
            return
        # The piece he clicked last is the piece renamed.
        cat, idx = sel[-1]
        road = self.canvas._get_road_dict(cat, idx)
        if road is None:
            return
        dialog = Gtk.Dialog(
            title="Rename road piece",
            transient_for=self.window,
            flags=Gtk.DialogFlags.MODAL,
            buttons=(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
                     Gtk.STOCK_SAVE, Gtk.ResponseType.OK))
        dialog.set_default_size(380, -1)
        box = dialog.get_content_area()
        label = Gtk.Label(
            label="New name for this one piece only — the rest "
                  "of the street keeps its own name. Leave it "
                  "blank to un-name the piece.")
        label.set_line_wrap(True)
        label.set_xalign(0)
        box.add(label)
        entry = Gtk.Entry()
        entry.set_text(road.get("name") or "")
        entry.set_activates_default(True)
        box.add(entry)
        dialog.set_default_response(Gtk.ResponseType.OK)
        dialog.show_all()
        resp = dialog.run()
        new_name = entry.get_text().strip()
        dialog.destroy()
        if resp != Gtk.ResponseType.OK:
            return
        old_name = road.get("name") or ""
        if self.apply_road_rename(cat, road, new_name):
            self.set_status(
                f"Renamed piece: '{old_name or '(unnamed)'}' → "
                f"'{new_name or '(unnamed)'}'.")
            self.inspector.refresh()
            self.canvas.queue_draw()
        else:
            self.set_status("Rename failed: could not save.")

    def on_delete_clicked(self, _button=None):
        """
        Delete action button (1.9.7): acts on the current selection.

        With roads selected, the canvas opens the framed delete
        preview for them (the map frames the whole road, lights it
        up, and the bar at the top carries the decision). With
        NOTHING selected, a plain popup says exactly that — and
        nothing else happens: no preview, no camera move, no
        delete.
        """
        if self.canvas.delete_preview is not None \
                or self.canvas.delete_prep is not None:
            # A preview (or its preparation) is already up; the
            # bar owns the decision.
            self.set_status(
                "Delete: finish the road shown first — "
                "Delete it, or Cancel in the bar at the top.")
            return
        picked = []
        si = self.spatial_index
        if si is not None:
            for cat, idx in self.canvas.selected_roads:
                if 0 <= idx < len(si.roads):
                    picked.append((cat, idx, si.roads[idx][1]))
        if not picked:
            dialog = Gtk.MessageDialog(
                transient_for=self.window,
                flags=0,
                message_type=Gtk.MessageType.INFO,
                buttons=Gtk.ButtonsType.OK,
                text="Nothing is selected.")
            dialog.format_secondary_text(
                "Click a road to select it first, then press "
                "Delete.")
            dialog.run()
            dialog.destroy()
            return
        self.canvas.begin_delete_preview(picked)

    # ------------------------------------------------------------------
    # Delete confirmation bar (1.9.7 — Joshua's design, 2026-10-18)
    #
    # Replaces the old centred YES/NO dialog (confirm_delete_road,
    # removed): it named the road but never showed it, and it sat
    # ON TOP of the map. Now, when a road is picked, the canvas
    # frames and lights the whole road first; this bar then rides
    # the map's top edge — out of the picture's way — carrying the
    # name plus the Delete / Cancel decision.
    # ------------------------------------------------------------------

    def _build_delete_bar(self):
        """
        Build the slim delete bar (hidden until a road is picked).

        A dark red-brown band across the top of the map: the road's
        name on the left, Cancel and Delete buttons on the right.
        no_show_all + hide() keep it invisible until
        show_delete_bar() is called, and being an overlay child it
        never takes layout space away from the canvas.
        """
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                      spacing=8)
        box.set_margin_start(10)
        box.set_margin_end(10)
        box.set_margin_top(6)
        box.set_margin_bottom(6)
        self.delete_bar_label = Gtk.Label(label="")
        self.delete_bar_label.set_xalign(0.0)
        self.delete_bar_label.override_color(
            Gtk.StateFlags.NORMAL, Gdk.RGBA(1.0, 1.0, 1.0, 1.0))
        box.pack_start(self.delete_bar_label, True, True, 0)
        self.delete_cancel_btn = Gtk.Button(label="Cancel")
        self.delete_cancel_btn.connect(
            "clicked",
            lambda _b: self.canvas.cancel_delete_preview())
        box.pack_start(self.delete_cancel_btn, False, False, 0)
        self.delete_confirm_btn = Gtk.Button(label="Delete road")
        self.delete_confirm_btn.get_style_context().add_class(
            "destructive-action")
        self.delete_confirm_btn.connect(
            "clicked",
            lambda _b: self.canvas.confirm_delete_preview())
        box.pack_start(self.delete_confirm_btn, False, False, 0)
        self.delete_bar_box = box
        self.delete_bar = Gtk.EventBox()
        self.delete_bar.add(box)
        self.delete_bar.override_background_color(
            Gtk.StateFlags.NORMAL, Gdk.RGBA(0.32, 0.07, 0.07, 0.96))
        self.delete_bar.set_halign(Gtk.Align.FILL)
        self.delete_bar.set_valign(Gtk.Align.START)
        self.delete_bar.set_no_show_all(True)
        self.delete_bar.hide()

    def show_delete_bar(self, text, ready=True):
        """
        Show the delete bar with the text the canvas composed
        (it names the road or roads that are lit up).

        ready=False is the PREPARING state (1.9.7 no-stall rule):
        the bar is up from the first moment so Cancel is always
        reachable, but the Delete button stays insensitive until
        the framed picture has actually landed — nobody can confirm
        a deletion they have not seen yet.
        """
        self.delete_bar_label.set_text(text)
        self.delete_confirm_btn.set_sensitive(ready)
        # NOT show_all(): the bar carries no_show_all (so the main
        # window's show_all never pops it up at launch), and GTK's
        # show_all() honours that flag even on the widget itself —
        # show the band directly, then its contents.
        self.delete_bar.show()
        self.delete_bar_box.show_all()

    def hide_delete_bar(self):
        """Hide the delete bar (after Delete or Cancel)."""
        self.delete_bar.hide()

    # ------------------------------------------------------------------
    # Data download / updates
    # ------------------------------------------------------------------

    def _initial_setup(self):
        """
        Called once after window is shown.

        1.9.0 (Joshua's standing rule): on open, DOWNLOAD the game's
        current files from GitHub first (Contents API, fresh
        connection), then load. If the download fails (offline), fall
        back to the local cache; only when there is no cache at all do
        we prompt.
        """
        # 1.9.10: give the Pieces panel its starting share of
        # the canvas column (~200 px at the bottom) now that the
        # paned has a real height; the sash stays draggable.
        try:
            alloc = self.canvas_paned.get_allocation()
            if alloc.height > 300:
                self.canvas_paned.set_position(alloc.height - 205)
        except Exception:
            pass
        self.canvas.fit_view()
        self.set_status("Downloading game data from GitHub…")
        # Corner progress bar (1.9.7 suite law): the startup
        # download is background work — show it in the corner.
        self.progress_start("download", "Downloading game data…")

        def worker():
            ok = download_roads()

            def done():
                self.progress_finish("download")
                if ok:
                    self._load_data()
                else:
                    needed, reason = needs_download()
                    if not needed:
                        self._load_data()
                        self.set_status(
                            "Offline — using the local copy. "
                            "Your saves will push when a connection "
                            "and token are available.")
                    else:
                        # 1.9.1: carry the REAL failure reason into
                        # the prompt (file + what GitHub said), not
                        # just "data not found locally".
                        import data as _data_mod
                        detail = _data_mod.LAST_DOWNLOAD_ERROR
                        if detail:
                            reason += ("\n\nThe automatic download "
                                       f"just failed — {detail}")
                        self._prompt_download(reason)
                return False
            GLib.idle_add(done)

        threading.Thread(target=worker, daemon=True).start()
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
        # Corner progress bar too (1.9.7 suite law): the same real
        # fractions drive both, and the corner bar is the one that
        # stays visible for every kind of background work.
        self.progress_start("download", "Downloading…")

        def update_progress(frac, text):
            """Thread-safe progress update via GLib.idle_add."""
            def _update():
                bar.set_fraction(frac)
                bar.set_text(text)
                self.progress_update("download", fraction=frac,
                                     label=f"Downloading… {text}")
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
                self.progress_finish("download")
                if success:
                    self._load_data()
                    self.set_status("Data downloaded successfully.")
                else:
                    # 1.9.1: show the REAL reason (the file and what
                    # GitHub/the connection actually said) — in 1.9.0
                    # this dialog flattened every failure into
                    # "check your internet connection", which hid the
                    # fault completely on Joshua's laptop.
                    import data as _data_mod
                    detail = _data_mod.LAST_DOWNLOAD_ERROR
                    message = "Could not download from GitHub."
                    if detail:
                        message += f"\n\nWhat happened: {detail}"
                    self._show_error("Download failed", message)
                return False
            GLib.idle_add(done)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

    def _load_data(self):
        """
        Load the working copy from the game model (adopted by the
        download-on-open, or built from the local cache offline) and
        build the spatial index. The canvas edits ONE merged view;
        every road keeps its "_zone" attribution for per-zone saving.
        """
        try:
            self.set_status("Loading roads…")
            import data as _data_mod
            if _data_mod.GAME_MODEL is None:
                # Raises FileNotFoundError when nothing is cached.
                load_roads()
            self.game_model = _data_mod.GAME_MODEL
            self._ground = None  # rebuilt lazily from the model's elev
            self.roads_data = self.game_model.merged_roads()
            # 1.9.10: a fresh load replaces every record, so any
            # stacked results from a previous scan point at dead
            # dicts — drop them (the panel says a fresh Find
            # stacked is needed, never a stale row).
            self._stacked_results = []
            try:
                self.pieces_panel.reset_results()
            except Exception:
                pass
            # Overpasses: the model's list (the game's
            # detailed/overpasses.json content, taken as-is).
            self.overpasses = load_overpasses()
            self._dirty_road_cats = set()
            # Guarantee all five category lists exist for the canvas.
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
            # 1.9.2: adopting a model rebuilds data.ZONES IN PLACE in
            # ZONE_IDS order (data.rebuild_zones_from_model), while the
            # Zones menu was built at startup from the pre-download
            # fallback list in a DIFFERENT order, its items resolving
            # by position. Without a rebuild here, every menu entry
            # jumps to the wrong zone (Joshua 2026-10-16: "Adamsville"
            # landed on Downtown, "Mableton" on Adamsville). Every
            # adoption path (download-on-open, offline cache, File ->
            # Download, Check for Updates) funnels through _load_data,
            # so the menu is resynced here, next to the load itself.
            try:
                self._rebuild_zones_menu()
            except Exception:
                pass
            # Zone indices may have shifted with the rebuild: drop any
            # stale zone selection rather than point it at another
            # zone's pins.
            try:
                self.canvas.selected_zone = None
                self.canvas.drag_pin = None
            except Exception:
                pass
            # 1.9.4: if this load adopted staged unpublished edits
            # (download-on-open guard in data.download_roads), tell
            # the user their changes were kept once the load settles.
            self._surface_download_warning()
            # 1.9.5 (ready-in-source 2026-10-17): a suite handoff
            # from the Building Editor may be waiting — open at the
            # street it names. See _consume_open_handoff.
            # 1.9.6: remember whether it applied a jump, so the
            # post-load re-fit doesn't override the jump's view.
            self._handoff_applied = False
            try:
                self._handoff_applied = bool(self._consume_open_handoff())
            except Exception:
                pass
        except FileNotFoundError:
            self.set_status("No local data. Use File → Download from GitHub.")
        except Exception as e:
            self._show_error("Load Error", f"Could not load road data:\n{e}")

    def _consume_open_handoff(self):
        """
        Consume a suite "open in Map Editor" handoff, once.

        Building Editor 1.7.2 (Joshua 2026-10-17, amendment 3):
        picking a street in its 3D view (or a blocking street in
        its Gas Station Review tab) writes
        ~/.local/share/adamsville-suite/open-in-map-editor.json —
        {zone, x, z, street, writtenBy, timestamp} — and launches
        this app. On load, a FRESH handoff (< 48 hours old) is
        applied once: switch to the zone, centre the view on the
        point at street level, select the named street when it
        resolves near the point — then the file is DELETED so the
        jump happens once, not on every launch. A file that does
        not parse is renamed .bad so it cannot loop; a stale one
        is simply removed.

        1.9.9 (Joshua 2026-10-18): the file may also carry the
        BUILDING the jump is about — "building": {"name", "zone",
        "footprint": [[x, z], ...], "at": [x, z]} (Building
        Editor 2.0.2 writes it). With it, arrival draws the
        building's GHOST at its true position (reference only),
        auto-selects the FRONTING road piece, and frames BOTH
        into view. Without it, the jump behaves exactly as
        before.

        1.9.6: returns True when a jump was actually applied, so
        the post-load whole-world re-fit (see _build_index_idle)
        knows to leave this view alone.
        """
        import json as _json
        from datetime import datetime, timezone
        from pathlib import Path as _Path

        path = (_Path.home() / ".local" / "share" / "adamsville-suite"
                / "open-in-map-editor.json")
        if not path.exists():
            return False
        try:
            doc = _json.loads(path.read_text())
            zone_id = str(doc["zone"])
            x = float(doc["x"])
            z = float(doc["z"])
            street = doc.get("street") or ""
            # 1.9.9: a jump may carry the BUILDING it is about
            # (Building Editor 2.0.2 contract): {"name", "zone",
            # "footprint": [[x, z], ...], "at": [x, z]}. Absent
            # or malformed -> a plain street jump, exactly as
            # before; a bad building never breaks the jump.
            ghost = None
            bdoc = doc.get("building")
            if isinstance(bdoc, dict):
                try:
                    fp = [[float(p[0]), float(p[1])]
                          for p in bdoc.get("footprint") or []]
                    bat = bdoc.get("at") or []
                    bat = [float(bat[0]), float(bat[1])]
                    if len(fp) >= 3:
                        ghost = {
                            "name": str(bdoc.get("name")
                                        or "Building"),
                            "footprint": fp,
                            "at": bat,
                            "zone": str(bdoc.get("zone") or ""),
                        }
                except Exception:
                    ghost = None
            fresh = True
            ts = doc.get("timestamp")
            if ts:
                when = datetime.fromisoformat(ts)
                fresh = (datetime.now(timezone.utc)
                         - when).total_seconds() < 48 * 3600
        except Exception:
            try:
                path.rename(path.with_suffix(".json.bad"))
            except Exception:
                pass
            return False
        # Consumed (or stale): the file never applies twice.
        try:
            path.unlink()
        except Exception:
            pass
        if not fresh:
            return False
        # Resolve the zone: handoff zones are game zone ids
        # ("eastatlanta"); ZONES carry display names ("East
        # Atlanta") — match on the squashed name.
        idx = None
        for j, zn in enumerate(ZONES):
            squashed = (zn.get("name") or "").replace(" ", "").casefold()
            if squashed == zone_id.casefold() \
                    or (zn.get("name") or "") == zone_id:
                idx = j
                break
        if idx is None:
            return False
        self.zoom_to_zone(idx, ZONES[idx]["name"])
        # Centre on the handed-off point, at street level.
        self.canvas.cam_x = x
        self.canvas.cam_y = z
        alloc = self.canvas.get_allocation()
        if alloc.width > 0:
            self.canvas.zoom = max(self.canvas.zoom,
                                   alloc.width / 700.0)
        # Select the named street nearest the point (same zone).
        if street and self.roads_data:
            from overpass import _point_to_segment_dist
            best = None  # (distance, cat, index)
            for cat, records in self.roads_data.items():
                for i, rec in enumerate(records or []):
                    if (rec.get("name") or "") != street:
                        continue
                    if rec.get("_zone") not in (None, zone_id):
                        continue
                    pts = rec.get("pts") or []
                    for a, b in zip(pts, pts[1:]):
                        d, _closest = _point_to_segment_dist(
                            x, z, a[0], a[1], b[0], b[1])
                        if best is None or d < best[0]:
                            best = (d, cat, i)
            if best is not None:
                self.canvas.selected_roads = [(best[1], best[2])]
        # 1.9.9: with a building aboard, draw its GHOST where it
        # belongs, auto-select the FRONTING road piece (Joshua's
        # suggestion — his eye lands building -> its road in one
        # glance), and frame BOTH into the arriving view.
        if ghost is not None:
            from overpass import _point_to_segment_dist
            samples = [tuple(p) for p in ghost["footprint"]]
            samples.append(tuple(ghost["at"]))
            gx0 = min(p[0] for p in ghost["footprint"]) - 200.0
            gx1 = max(p[0] for p in ghost["footprint"]) + 200.0
            gz0 = min(p[1] for p in ghost["footprint"]) - 200.0
            gz1 = max(p[1] for p in ghost["footprint"]) + 200.0

            def dist_to(rec):
                pts = rec.get("pts") or []
                best_d = None
                for a, b in zip(pts, pts[1:]):
                    for (sx, sz) in samples:
                        d, _c = _point_to_segment_dist(
                            sx, sz, a[0], a[1], b[0], b[1])
                        if best_d is None or d < best_d:
                            best_d = d
                return best_d

            front = None   # nearest piece of any name
            named = None   # nearest piece of the named street
            for cat, records in self.roads_data.items():
                for i, rec in enumerate(records or []):
                    if rec.get("_zone") not in (None, zone_id):
                        continue
                    pts = rec.get("pts") or []
                    if len(pts) < 2:
                        continue
                    # Cheap bbox gate before the segment maths.
                    rxs = [p[0] for p in pts]
                    rzs = [p[1] for p in pts]
                    if max(rxs) < gx0 or min(rxs) > gx1 \
                            or max(rzs) < gz0 or min(rzs) > gz1:
                        continue
                    d = dist_to(rec)
                    if d is None:
                        continue
                    if front is None or d < front[0]:
                        front = (d, cat, i, rec)
                    if street and (rec.get("name") or "") == street:
                        if named is None or d < named[0]:
                            named = (d, cat, i, rec)
            pick = named if (named is not None
                             and named[0] <= 150.0) else front
            xs = [p[0] for p in ghost["footprint"]]
            zs = [p[1] for p in ghost["footprint"]]
            if pick is not None:
                self.canvas.selected_roads = [(pick[1], pick[2])]
                for p in pick[3].get("pts") or []:
                    xs.append(p[0])
                    zs.append(p[1])
            # Frame building + road together (minimum span so a
            # small building never zooms to a postage stamp).
            ccx = (min(xs) + max(xs)) / 2
            ccz = (min(zs) + max(zs)) / 2
            span_x = max(max(xs) - min(xs), 150.0)
            span_z = max(max(zs) - min(zs), 150.0)
            self.canvas.frame_rect(ccx - span_x / 2,
                                   ccz - span_z / 2,
                                   ccx + span_x / 2,
                                   ccz + span_z / 2)
            self.canvas.jump_ghost = ghost
        self.canvas.queue_draw()
        if ghost is not None:
            self.set_status(
                f"Opened at {street or 'the marked spot'} in "
                f"{ZONES[idx]['name']} — '{ghost['name']}' is "
                "drawn where it belongs (pale-blue ghost, "
                "reference only) and its road is selected. "
                "(Sent from the Building Editor.)")
        else:
            self.set_status(
                f"Opened at {street or 'the marked spot'} in "
                f"{ZONES[idx]['name']} (sent from the Building "
                "Editor).")
        return True

    def _surface_download_warning(self):
        """
        Show data.LAST_DOWNLOAD_WARNING (1.9.4) if the download-on-
        open guard kept staged unpublished edits, and mark the
        session unpublished — the kept edits ARE unpublished, so the
        close warning and the Check-for-Updates guard must treat
        them that way. The status is set from a queued idle callback
        so it lands AFTER _load_data's own "Loaded … roads." status
        instead of being overwritten by it. Consumes the warning.
        """
        import data as _data_mod
        warn = getattr(_data_mod, "LAST_DOWNLOAD_WARNING", None)
        if not warn:
            return
        _data_mod.LAST_DOWNLOAD_WARNING = None
        self._unpublished = True

        def _show():
            self.set_status(warn)
            return False
        GLib.idle_add(_show)

    def _build_index_idle(self):
        """Build spatial index (called via idle_add after load)."""
        self.spatial_index.build(self.roads_data)
        total = len(self.spatial_index.roads)
        self.set_status(f"Loaded {total:,} roads.")
        # 1.9.6: re-fit NOW that the data is in and the window has
        # reached its final size. The startup fit (in
        # _initial_setup) runs BEFORE the download, against
        # whatever allocation the canvas had at that idle moment;
        # this re-fit is what guarantees the opening view a user
        # actually lands on frames the whole seven-zone world.
        # A Building Editor street jump (1.9.5) sets the view
        # itself — never override it with the overview.
        if not getattr(self, "_handoff_applied", False):
            self.canvas.fit_view()
        self.canvas.queue_draw()
        return False

    def on_download_clicked(self, widget):
        """File → Download from GitHub."""
        self._prompt_download("Download the latest road data from GitHub?")

    def on_check_updates(self, widget):
        """
        View → Check for Updates (1.9.0): re-download the game data
        from GitHub (the same download-on-open) and reload from it.
        There is no single file SHA to compare anymore — the fresh
        download IS the check.
        """
        if getattr(self, "_unpublished", False):
            self.set_status(
                "You have unpublished changes — push them first "
                "(File → Push to GitHub) so a refresh can't hide them.")
            return
        self.set_status("Downloading the latest game data…")

        def worker():
            ok = download_roads()

            def done():
                if ok:
                    self._load_data()
                    self.set_status("Game data refreshed from GitHub.")
                else:
                    self.set_status("Offline — using local copy.")
                return False
            GLib.idle_add(done)

        threading.Thread(target=worker, daemon=True).start()

    # ------------------------------------------------------------------
    # Unpublished-changes close warning (Joshua 2026-10-11)
    # ------------------------------------------------------------------
    # Safety net: if Joshua hits X with unpushed edits, ask what to do.
    # No auto-push — the manual push flow is unchanged.

    # ------------------------------------------------------------------
    # THE ROUND-TRIP SAVE (1.9.0 — Joshua's standing rule, same design
    # as UI Editor 1.7.8): EVERY save point in this app is this one
    # action — local save -> PUSH on one connection -> CLOSE it ->
    # fresh connection -> RE-DOWNLOAD every pushed file -> refresh the
    # view from the re-downloaded copies. Only files that actually
    # changed are pushed (per-zone dirty tracking in gamedata.py).
    # Stage-accurate failures (gamedata.perform_round_trip):
    # local-save-failed / "Push to GitHub failed: ..." / "push reached
    # GitHub but downloading the proof copy back failed: ... — your
    # save DID reach GitHub". On failure, local edits stay exactly as
    # they are and the view is NOT reloaded over them.
    # ------------------------------------------------------------------

    def round_trip_save(self, on_done=None, silent=False):
        """
        Run one round-trip save on a worker thread.
        on_done(ok, err, fresh) runs on the GTK thread; fresh maps
        repo path -> re-downloaded bytes. Returns True if it started
        (or if a trip already in flight will cover the request).

        1.9.4 RE-ENTRANCY GUARD: three different triggers can ask for
        a save — File → Push, the 5-minute auto-push tick, and the
        Settings dialog's key-changed callback (which fires the moment
        a key is saved, exactly when a user is also likely to hit
        Push). Before 1.9.4 nothing stopped two trips from running AT
        ONCE: their GET-sha → PUT sequences interleaved, and GitHub
        refused the loser with a 409 sha mismatch ("… is at X but
        expected Y") — Joshua hit exactly this on 2026-10-16 after
        re-adding his key with a road join unpublished: his own Push
        raced the Settings auto-push and the save failed. Now only
        ONE trip is ever in flight. A trigger that arrives mid-trip
        just sets the follow-up flag (any number of them coalesce
        into the one flag); when the trip lands, _round_trip_finished
        runs AT MOST one follow-up trip, and only if the model
        actually changed while the trip was away.
        """
        if getattr(self, "_round_trip_in_flight", False):
            # A trip is already running: coalesce this trigger into
            # the single follow-up flag and let the finisher decide
            # whether a second trip is actually needed. Nothing else
            # to do — starting a rival trip here is the 409 race.
            self._round_trip_followup = True
            return True
        if on_done is None:
            on_done = self._round_trip_default_done
        if not github_sync.has_token():
            err = ("No GitHub token set — changes are saved on this "
                   "computer only. Set one in File → Settings to push.")
            if silent:
                return False
            self.set_status(err)
            GLib.idle_add(self._fire_done, on_done, False, err, None)
            return False
        if self.game_model is None:
            if not silent:
                self.set_status("Nothing to push — no data loaded.")
            return False
        # Adopt the canvas working copy into the model on THIS (GTK)
        # thread; the worker then only touches the model + network.
        if self.roads_data is not None:
            self.game_model.adopt_merged_roads(self.roads_data)
        import gamedata as _gd
        dirty = _gd.GameModel.dirty_paths(self.game_model)
        if not dirty:
            if not silent:
                self.set_status("Nothing to push — no changes.")
                GLib.idle_add(self._fire_done, on_done, True, None, {})
            return False
        if not silent:
            self.set_status("Pushing to GitHub…")
        # 1.9.4: claim the single flight slot BEFORE the worker
        # starts, and snapshot the exact bytes this trip sets out to
        # push. The finisher compares the model against this snapshot
        # to decide whether a queued follow-up trip is warranted
        # (model changed mid-trip) or would just re-push the same
        # bytes (trigger spam — the trip that just landed covers it).
        self._round_trip_in_flight = True
        self._trip_sent_snapshot = {
            path: self.game_model.current_bytes(path) for path in dirty}
        # Corner progress bar (1.9.7 suite law): a push is
        # background work with no known total — indeterminate.
        self.progress_start("push", "Pushing to GitHub…")

        def worker():
            ok, err, fresh = _gd.perform_round_trip(
                self.game_model, github_sync, save_local_cache)
            GLib.idle_add(self._round_trip_finished, on_done, ok, err,
                          fresh)

        threading.Thread(target=worker, daemon=True).start()
        return True

    def _round_trip_finished(self, on_done, ok, err, fresh):
        """
        GTK-thread finisher for one round-trip save (1.9.4): release
        the flight slot, run the caller's completion, then honour a
        coalesced follow-up trigger — at most one extra trip, and
        only when the model changed while the trip was in flight.

        The slot is released BEFORE on_done runs, so a completion
        that itself asks for a save starts a fresh trip instead of
        queueing behind the one that just ended.
        """
        self._round_trip_in_flight = False
        self.progress_finish("push")
        on_done(ok, err, fresh)
        if getattr(self, "_round_trip_followup", False):
            self._round_trip_followup = False
            if self._model_changed_during_trip():
                # One follow-up trip for everything that arrived
                # mid-flight — never a queue of them.
                self.round_trip_save()
        return False  # GLib.idle_add one-shot

    def _model_changed_during_trip(self):
        """
        True when the model now holds bytes the in-flight trip did
        NOT set out to push: a still-dirty path whose current bytes
        differ from the trip's snapshot, or a path that became dirty
        only while the trip was away. A path that is dirty with the
        SAME bytes as the snapshot (e.g. the trip failed before
        pushing) is not a mid-trip change — the queued trigger is
        already answered by that trip's own result, so no follow-up.
        """
        if self.game_model is None:
            return False
        # Fold the canvas working copy in first, exactly as a fresh
        # save would, so edits made during the push are visible here
        # even if they never touched the model directly.
        if self.roads_data is not None:
            self.game_model.adopt_merged_roads(self.roads_data)
        import gamedata as _gd
        snapshot = getattr(self, "_trip_sent_snapshot", {})
        for path in _gd.GameModel.dirty_paths(self.game_model):
            if snapshot.get(path) != self.game_model.current_bytes(path):
                return True
        return False

    @staticmethod
    def _fire_done(on_done, ok, err, fresh):
        """GLib.idle_add adapter: run the callback once."""
        on_done(ok, err, fresh)
        return False

    def _round_trip_default_done(self, ok, err, fresh):
        """
        Default completion: on success, refresh the view FROM THE
        RE-DOWNLOADED copies (the model was already re-parsed from
        the proof bytes inside the round trip) and clear the
        unpublished flag if nothing remains dirty. On failure, show
        the stage-accurate message as-is and touch nothing.
        """
        if not ok:
            self.set_status(err)
            return
        if fresh:
            # Rebuild the working copy + view from the GitHub copies.
            self.roads_data = self.game_model.merged_roads()
            for _cat in ("interstate", "highway", "major_artery",
                         "minor_artery", "local"):
                self.roads_data.setdefault(_cat, [])
            self.overpasses = load_overpasses()
            self._dirty_road_cats = set()
            import data as _data_mod
            _data_mod.rebuild_zones_from_model()
            try:
                self._rebuild_zones_menu()
            except Exception:
                pass
            self._rebuild_road_index()
            self.canvas.queue_draw()
        import gamedata as _gd
        if not _gd.GameModel.dirty_paths(self.game_model):
            self._unpublished = False
        self.set_status("Pushed to GitHub ✓ — showing the GitHub copies")

    def _mark_unpublished(self):
        """Mark that local edits haven't been pushed yet."""
        self._unpublished = True
        # First save without a token: offer to set one up for auto-push.
        if not github_sync.has_token() and not self._token_prompted:
            self._token_prompted = True
            if github_sync.show_first_save_prompt(self.window):
                self.round_trip_save()

    def _auto_push_tick(self):
        """
        Word-style auto-push timer: every 5 minutes, if there are
        unpublished changes and a token is set, run the round trip.
        Returns True to keep the timer running.
        """
        if self._unpublished and github_sync.has_token():
            self.round_trip_save(silent=True)
        return True  # keep the timer alive

    def _do_push(self, silent=True):
        """Legacy name kept for stray callers: the round-trip save."""
        return self.round_trip_save(silent=silent)

    def on_settings_clicked(self, widget):
        """
        Settings: GitHub API key management (changeable in-app, no
        reinstall needed). Shared across all suite apps.
        """
        def on_key_changed(key_set):
            if key_set:
                self.set_status("GitHub API key saved — auto-push enabled.")
                if self._unpublished:
                    self.round_trip_save()
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
        File → Push to GitHub: the round-trip save (local save, push,
        close, fresh-connection proof download, view refresh). With
        no token set, offer the token dialog first, then the manual
        note as a last resort.
        """
        # Make sure in-memory road edits are persisted locally first.
        self.persist_road_edits()
        if github_sync.has_token():
            self.round_trip_save()
            return
        if github_sync.show_token_dialog(self.window):
            self.round_trip_save()
            return
        dialog = Gtk.MessageDialog(
            transient_for=self.window,
            flags=0,
            message_type=Gtk.MessageType.INFO,
            buttons=Gtk.ButtonsType.OK,
            text="Push to GitHub")
        dialog.format_secondary_text(
            "Your edits are saved locally.\n\n"
            "Set a GitHub token in File → Settings to push "
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
        # 1.9.10: the Pieces panel + Find stacked are actions,
        # not tools, so they are not in TOOLS — explain them here.
        lines.append(
            "• Selected pieces (Pieces panel, right side): every "
            "piece in the current selection is listed by name. "
            "Click a row to see that piece by itself — the map "
            "frames it and lights it bright while the rest of "
            "the selection stays selected but pale. That is how "
            "a piece buried under another one can be seen. Each "
            "row's Delete button deletes just that piece, "
            "through the usual framed check.")
        lines.append(
            "• Find stacked: scans the loaded map for pieces "
            "lying on top of other pieces — exact duplicates, "
            "zero-length records that draw nothing, and pieces "
            "mostly covered by another road — and lists them by "
            "name in the Pieces panel with the reason for each. "
            "Click a found piece to see it on the map. The scan "
            "never deletes anything; removing a piece is always "
            "the ordinary Delete, after you check it.")
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
