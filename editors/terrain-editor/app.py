#!/usr/bin/env python3
"""
Adamsville Terrain Editor (Native) — Main GTK application.

3D terrain editor (v2.0): three synchronized viewports — top-down map,
player's-eye perspective, and side profile — showing the same heightfield
with natural face shading (no elevation heatmap).

Editing model (Joshua 2026-10-11): select faces (drag a box / Shift+click),
click empty terrain to lock the selection, grab it and drag UP/DOWN to
change elevation. Terrain-road grouping moves roads with the terrain.

Pure Python + GTK3 + Cairo. NO webview, NO HTML, NO JavaScript.
Joshua's rule: all code commented.
"""

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

import threading

import github_sync  # noqa: E402 -- suite auto-push + close warning
from about import show_about_dialog
# v2.0.2 (Joshua 2026-10-12): soft import for updater — if updater.py is
# missing or broken (partial install, failed in-place update), the editor
# must still open. The Help -> Check for Updates item is only added when
# the import succeeds.
try:
    import updater  # noqa: E402 -- Help -> Check for Updates (in-place updater)
    _UPDATER_AVAILABLE = True
except Exception:
    updater = None
    _UPDATER_AVAILABLE = False
from data import (
    Heightfield, FaceSelection, RoadOffsets, build_road_cell_index,
    ensure_data_dir, needs_download, download_terrain, download_roads,
    save_window_state, load_window_state, export_edits, load_roads,
)
from terraincanvas import TopDownView, SideView, PlayerEyeView


# App version shown in the Help -> About dialog (bump with each release).
# Joshua 2026-10-11: version number must be prominent in About.
APP_VERSION = "2.0.2"
# Display name and icon-theme name for the About dialog.
APP_NAME = "Adamsville Terrain Editor"
APP_ICON = "adamsville-terrain-editor-native"
APP_PACKAGE = "adamsville-terrain-editor-native"
# In-place updater (Joshua 2026-10-12): Help -> Check for
# Updates downloads new editor files from GitHub and applies
# them in place, so reinstalling the .deb is not needed.
UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/kingmarkarnold-code/adamsville-elevation-editor/main/version.json"
UPDATE_SLUG = "terrain-editor"



# ---------------------------------------------------------------------------
# Tool definitions for toolbar and help dialog
# ---------------------------------------------------------------------------

# Each tool: (id, label, tooltip, help_text)
TOOLS = [
    ("select", "Select",
     "Select terrain faces, then grab and drag up/down to move them",
     "Select: Drag a box to select terrain faces (Shift+drag adds). "
     "Shift+click toggles single faces. Selected faces show amber dashed; "
     "click empty terrain to LOCK the selection (solid amber). Then click "
     "and grab the locked selection and drag UP or DOWN to change "
     "elevation. Vertical movement only. Esc clears the selection."),
    ("level", "Level",
     "Drag a rectangle in the top view, then flatten it",
     "Level: In the TOP view, drag a rectangle over an area, then click "
     "the Flatten button (or press Enter) to make it flat. Esc cancels."),
    ("pan", "Pan",
     "Drag to move the camera",
     "Pan: Click and drag to move the camera. Middle/right-drag pans in "
     "any tool. Mouse wheel zooms (Shift+wheel zooms height in side view)."),
]

# Viewport definitions: (key, title, view class).
VIEWS = [
    ("top", "Top View", TopDownView),
    ("eye", "Player's-Eye View", PlayerEyeView),
    ("side", "Side View", SideView),
]


class TerrainEditorApp:
    """Main application class."""

    def __init__(self):
        """Build the UI and initialize shared editing state."""
        # Shared state: one heightfield, one selection, one road-offset
        # store — all three viewports read/write the same objects.
        self.heightfield = Heightfield()
        self.selection = FaceSelection()
        self.road_offsets = RoadOffsets()
        self.road_offsets.load()
        # Wire undo() so grouped road offsets restore with the terrain.
        self.heightfield.road_offsets = self.road_offsets

        # Road overlay data + reverse index (cell -> road points), built
        # after download. Roads are VISUAL ONLY — never clickable.
        self.roads_data = None
        self.road_cell_index = {}  # (ix, iz) -> [(key, wx, wz), ...]
        self.road_key_cell = {}    # key -> (ix, iz)
        self.show_roads = True

        # Editing state.
        self.active_tool = "select"
        # Terrain-road grouping (Joshua 2026-10-11): checked = terrain moves
        # alone; unchecked = roads lift with the terrain (grouped).
        self.move_terrain_only = True

        # Unpublished-changes tracking (Joshua 2026-10-11).
        self._unpublished = False
        self._token_prompted = False
        self.heightfield.on_change = self._mark_unpublished
        # Word-style auto-push: every 5 minutes if unpublished + token.
        GLib.timeout_add_seconds(300, self._auto_push_tick)

        # --- Main window ---
        self.window = Gtk.Window(title="Adamsville Terrain Editor")
        self.window.set_default_size(1400, 850)
        self.window.connect("delete-event", self.on_window_close)
        self.window.connect("key-press-event", self.on_key_press)
        self._restore_window()

        # --- Layout: vertical box ---
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.window.add(vbox)

        # --- Menu bar: File, View, Window, Help ---
        menubar = self._build_menubar()
        vbox.pack_start(menubar, False, False, 0)

        # --- Toolbar ---
        toolbar = self._build_toolbar()
        vbox.pack_start(toolbar, False, False, 0)

        # --- Three viewports in draggable splitters ---
        # Left: top-down map. Right: vertical split of player's-eye over
        # side profile. Each viewport has a close (X) button in its header
        # and can be reopened from the Window menu.
        self.view_frames = {}  # key -> Gtk.Box (header + canvas)
        self.views = {}        # key -> viewport widget
        self._syncing_menu = False  # guards Window-menu check recursion

        self.main_paned = Gtk.HPaned()
        self.right_paned = Gtk.VPaned()

        for key, title, cls in VIEWS:
            frame, view = self._make_view_frame(key, title, cls)
            self.view_frames[key] = frame
            self.views[key] = view

        self.main_paned.pack1(self.view_frames["top"], True, False)
        self.right_paned.pack1(self.view_frames["eye"], True, False)
        self.right_paned.pack2(self.view_frames["side"], True, False)
        self.main_paned.pack2(self.right_paned, True, False)
        vbox.pack_start(self.main_paned, True, True, 0)

        # --- Status bar ---
        self.statusbar = Gtk.Statusbar()
        self.status_ctx = self.statusbar.get_context_id("main")
        vbox.pack_start(self.statusbar, False, False, 0)
        self.set_status("Ready")

        self.window.show_all()
        # Sensible initial splitter positions (after realization).
        GLib.idle_add(self._initial_setup)

    # ------------------------------------------------------------------
    # Viewport frames (header with title + close X) and Window menu
    # ------------------------------------------------------------------

    def _make_view_frame(self, key, title, view_cls):
        """
        Build one closable viewport: a header bar (title + X button)
        above the 3D canvas. Returns (frame_box, view_widget).
        """
        frame = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        header.get_style_context().add_class("view-header")
        label = Gtk.Label(label=title)
        label.set_halign(Gtk.Align.START)
        label.set_margin_start(8)
        close_btn = Gtk.Button(label="×")
        close_btn.set_relief(Gtk.ReliefStyle.NONE)
        close_btn.set_focus_on_click(False)
        close_btn.set_tooltip_text("Close this viewport "
                                   "(reopen from the Window menu)")
        close_btn.connect("clicked", lambda w, k=key: self.close_view(k))
        header.pack_start(label, True, True, 0)
        header.pack_start(close_btn, False, False, 0)

        view = view_cls(self)
        frame.pack_start(header, False, False, 0)
        frame.pack_start(view, True, True, 0)
        return frame, view

    def close_view(self, key):
        """Hide a viewport (X button). Window menu check follows."""
        self.view_frames[key].hide()
        self._syncing_menu = True
        self.window_checks[key].set_active(False)
        self._syncing_menu = False

    def toggle_view(self, key, show):
        """Window menu toggle: reopen a closed viewport or close one."""
        if self._syncing_menu:
            return
        if show:
            self.view_frames[key].show_all()
            # Re-frame the camera in case the allocation changed.
            self.views[key].fit_view()
        else:
            self.view_frames[key].hide()

    def redraw_all(self):
        """Queue a redraw in every viewport (data changed)."""
        for view in self.views.values():
            view.queue_draw()

    # ------------------------------------------------------------------
    # Window geometry + keyboard
    # ------------------------------------------------------------------

    def _restore_window(self):
        """Restore saved window position/size from previous session."""
        state = load_window_state()
        if state:
            self.window.move(state.get("x", 100), state.get("y", 100))
            self.window.set_default_size(
                state.get("width", 1400), state.get("height", 850))
            if state.get("maximized"):
                self.window.maximize()

    def on_key_press(self, widget, event):
        """Esc clears the selection; Enter applies the level rectangle."""
        keyval = event.keyval
        if keyval == Gdk.KEY_Escape:
            if self.selection.cells:
                self.selection.clear()
                self.views["top"].clear_level_rect()
                self.redraw_all()
                self.update_status()
                return True
        elif keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter):
            if self.active_tool == "level":
                self.on_flatten(None)
                return True
        return False

    def on_window_close(self, widget, event):
        """
        Save window geometry before closing. Unpublished changes trigger
        the safety-net dialog (Joshua 2026-10-11).
        """
        if self._unpublished:
            choice = self._show_close_warning()
            if choice == "cancel":
                return True  # don't close
            if choice == "push":
                self.on_push_github(None)
        x, y = self.window.get_position()
        w, h = self.window.get_size()
        maximized = self.window.is_maximized()
        save_window_state(x, y, w, h, maximized)
        Gtk.main_quit()
        return False

    # ------------------------------------------------------------------
    # Menu bar
    # ------------------------------------------------------------------

    def _build_menubar(self):
        """Native menu bar: File, View, Window, Help."""
        menubar = Gtk.MenuBar()

        # --- File menu ---
        file_menu = Gtk.Menu()
        file_item = Gtk.MenuItem(label="File")
        file_item.set_submenu(file_menu)

        dl_item = Gtk.MenuItem(label="Download Terrain Data…")
        dl_item.connect("activate", self.on_download_data)
        file_menu.append(dl_item)

        push_item = Gtk.MenuItem(label="Push Edits to GitHub…")
        push_item.connect("activate", self.on_push_github)
        file_menu.append(push_item)

        settings_item = Gtk.MenuItem(label="Settings…")
        settings_item.connect("activate", self.on_settings_clicked)
        file_menu.append(settings_item)

        file_menu.append(Gtk.SeparatorMenuItem())

        quit_item = Gtk.MenuItem(label="Quit")
        quit_item.connect("activate", lambda w: self.window.close())
        file_menu.append(quit_item)

        menubar.append(file_item)

        # --- View menu ---
        view_menu = Gtk.Menu()
        view_item = Gtk.MenuItem(label="View")
        view_item.set_submenu(view_menu)

        fit_item = Gtk.MenuItem(label="Fit All Views")
        fit_item.connect("activate", self.on_fit_all)
        view_menu.append(fit_item)

        reset_eye = Gtk.MenuItem(label="Reset Player's-Eye Camera")
        reset_eye.connect(
            "activate", lambda w: self.views["eye"].reset_view())
        view_menu.append(reset_eye)

        self.roads_check = Gtk.CheckMenuItem(label="Show Roads Overlay")
        self.roads_check.set_active(True)
        self.roads_check.connect("toggled", self.on_roads_toggle)
        view_menu.append(self.roads_check)

        menubar.append(view_item)

        # --- Window menu: toggle the three viewports ---
        window_menu = Gtk.Menu()
        window_item = Gtk.MenuItem(label="Window")
        window_item.set_submenu(window_menu)
        self.window_checks = {}
        for key, title, _cls in VIEWS:
            check = Gtk.CheckMenuItem(label=title)
            check.set_active(True)
            check.connect("toggled", self._on_window_toggled, key)
            window_menu.append(check)
            self.window_checks[key] = check
        menubar.append(window_item)

        # --- Help menu ---
        help_menu = Gtk.Menu()
        help_item = Gtk.MenuItem(label="Help")
        help_item.set_submenu(help_menu)

        glossary_item = Gtk.MenuItem(label="Tool Glossary")
        glossary_item.connect("activate", self.show_help)
        help_menu.append(glossary_item)

        # v2.0.2: only offer in-place updates when updater.py imported OK.
        # (A missing/broken updater must never stop the editor opening.)
        if _UPDATER_AVAILABLE:
            update_item = Gtk.MenuItem(label="Check for Updates")
            update_item.connect("activate", self.on_check_updates)
            help_menu.append(update_item)

        about_item = Gtk.MenuItem(label="About")
        about_item.connect("activate", self.show_about)
        help_menu.append(about_item)

        menubar.append(help_item)

        return menubar

    def _on_window_toggled(self, widget, key):
        """Window menu checkbox -> show/hide the viewport."""
        self.toggle_view(key, widget.get_active())

    def on_fit_all(self, widget):
        """Frame every viewport on the full world."""
        for view in self.views.values():
            view.fit_view()

    # ------------------------------------------------------------------
    # Toolbar
    # ------------------------------------------------------------------

    def _build_toolbar(self):
        """Toolbar: tools, grouping checkbox, undo, flatten, settings."""
        toolbar = Gtk.Toolbar()
        toolbar.set_style(Gtk.ToolbarStyle.BOTH)

        self.tool_buttons = {}
        first_button = None
        for tool_id, label, tooltip, _ in TOOLS:
            if first_button is None:
                btn = Gtk.RadioToolButton(label=label)
                first_button = btn
            else:
                btn = Gtk.RadioToolButton.new_from_widget(first_button)
                btn.set_label(label)
            btn.set_tooltip_text(tooltip)
            btn.connect("toggled", self.on_tool_toggled, tool_id)
            toolbar.insert(btn, -1)
            self.tool_buttons[tool_id] = btn

        toolbar.insert(Gtk.SeparatorToolItem(), -1)

        # --- Terrain-road grouping (Joshua 2026-10-11) ---
        # Checked (default): lifting terrain moves ONLY the terrain.
        # Unchecked: roads lift with the terrain (Blender-style grouping).
        group_item = Gtk.ToolItem()
        self.group_check = Gtk.CheckButton(label="Move terrain only")
        self.group_check.set_active(True)
        self.group_check.set_tooltip_text(
            "CHECKED: lifting terrain faces moves only the terrain — "
            "roads stay at their elevation.\n"
            "UNCHECKED: terrain and roads move together as one grouped "
            "object (road segments above the selection lift with it).")
        self.group_check.connect("toggled", self.on_group_toggled)
        group_item.add(self.group_check)
        toolbar.insert(group_item, -1)

        toolbar.insert(Gtk.SeparatorToolItem(), -1)

        # --- Undo button ---
        undo_btn = Gtk.ToolButton(label="Undo")
        undo_btn.set_tooltip_text("Undo last change (20 steps)")
        undo_btn.connect("clicked", self.on_undo)
        toolbar.insert(undo_btn, -1)

        # --- Flatten button (applies the level rectangle) ---
        flat_btn = Gtk.ToolButton(label="Flatten")
        flat_btn.set_tooltip_text(
            "Flatten the Level tool's rectangle to its average height")
        flat_btn.connect("clicked", self.on_flatten)
        toolbar.insert(flat_btn, -1)

        # --- Gear: Settings (GitHub API key management) ---
        toolbar.insert(Gtk.SeparatorToolItem(), -1)
        gear = Gtk.ToolButton.new_from_stock(Gtk.STOCK_PREFERENCES)
        gear.set_tooltip_text("Settings — GitHub API key")
        gear.connect("clicked", self.on_settings_clicked)
        toolbar.insert(gear, -1)

        return toolbar

    # ------------------------------------------------------------------
    # Toolbar callbacks
    # ------------------------------------------------------------------

    def on_tool_toggled(self, button, tool_id):
        """Switch the active tool (shared by all three viewports)."""
        if button.get_active():
            self.active_tool = tool_id
            if tool_id != "level":
                self.views["top"].clear_level_rect()
            self.set_status("Tool: %s" % tool_id)

    def on_group_toggled(self, button):
        """Terrain-road grouping checkbox."""
        self.move_terrain_only = button.get_active()
        mode = "terrain only" if self.move_terrain_only else \
            "terrain + roads grouped"
        self.set_status("Grouping: %s" % mode)
        self.redraw_all()

    def on_undo(self, widget):
        """Undo the most recent terrain change."""
        label = self.heightfield.undo()
        if label:
            self.set_status("Undid: %s" % label)
        else:
            self.set_status("Nothing to undo")
        self.redraw_all()
        self.update_status()

    def on_flatten(self, widget):
        """Apply the level tool in the top view."""
        if self.views["top"].level_rect:
            self.views["top"].apply_level()
            self.set_status("Area flattened")
        else:
            self.set_status(
                "Level tool: drag a rectangle in the TOP view first")

    def on_roads_toggle(self, widget):
        """Show/hide the roads overlay in all viewports."""
        self.show_roads = widget.get_active()
        self.redraw_all()

    # ------------------------------------------------------------------
    # Status bar
    # ------------------------------------------------------------------

    def set_status(self, text):
        """Replace the status bar message."""
        self.statusbar.pop(self.status_ctx)
        self.statusbar.push(self.status_ctx, text)

    def update_status(self, wx=None, wz=None):
        """
        Refresh the status bar: tool, selection (count + locked state),
        edit count, undo depth, grouping mode, and hover height.
        """
        parts = ["Tool: %s" % self.active_tool]
        n = len(self.selection)
        if n:
            state = "locked" if self.selection.locked else "selecting…"
            parts.append("Selected: %d faces (%s)" % (n, state))
        parts.append("Edits: %d" % self.heightfield.edit_count())
        parts.append("Undo: %d/20" % self.heightfield.undo_depth())
        parts.append("Grouping: %s" % (
            "terrain only" if self.move_terrain_only else "with roads"))
        if wx is not None and wz is not None:
            parts.append("Height: %.1f" % self.heightfield.sample(wx, wz))
        self.set_status(" | ".join(parts))

    # ------------------------------------------------------------------
    # Help glossary
    # ------------------------------------------------------------------

    def show_help(self, widget):
        """Show the tool glossary dialog."""
        dialog = Gtk.Dialog(title="Tool Glossary",
                            parent=self.window,
                            flags=Gtk.DialogFlags.MODAL)
        dialog.set_default_size(520, 420)

        text = Gtk.TextView()
        text.set_editable(False)
        text.set_wrap_mode(Gtk.WrapMode.WORD)
        buf = text.get_buffer()
        for _tool_id, label, _, help_text in TOOLS:
            buf.insert_at_cursor("%s\n" % label)
            buf.insert_at_cursor("  %s\n\n" % help_text)
        buf.insert_at_cursor(
            "Move terrain only (grouping checkbox)\n"
            "  CHECKED (default): lifting faces moves only the terrain.\n"
            "  UNCHECKED: road segments above the selected faces lift with "
            "the terrain, like grouping meshes in Blender. Road offsets are "
            "stored non-destructively.\n\n")
        buf.insert_at_cursor(
            "Undo\n  Reverses the last change (20 steps).\n\n")
        buf.insert_at_cursor(
            "Flatten\n  Flattens the Level tool's rectangle to its "
            "average height.\n\n")
        buf.insert_at_cursor(
            "Viewports\n"
            "  Top View: map-style selection and editing.\n"
            "  Player's-Eye View: ground-level perspective — what the "
            "player sees. Drag to look, wheel to move.\n"
            "  Side View: elevation profile — the natural view for "
            "dragging faces up/down.\n"
            "  Each viewport resizes via the splitters, closes with its X "
            "button, and reopens from the Window menu.\n\n")
        buf.insert_at_cursor(
            "Roads overlay\n  Shows roads draped on the terrain. Roads are "
            "visual guides only — clicking them does nothing. In grouped "
            "mode, road segments above your selection highlight amber.\n\n")
        buf.insert_at_cursor(
            "Push to GitHub\n  File menu: packages terrain edits (and "
            "grouped road offsets) as JSON. The full terrain rebuild "
            "happens from these edits in a batch.")

        scrolled = Gtk.ScrolledWindow()
        scrolled.add(text)
        dialog.get_content_area().pack_start(scrolled, True, True, 0)

        close_btn = dialog.add_button("Close", Gtk.ResponseType.CLOSE)
        close_btn.connect("clicked", lambda w: dialog.destroy())

        dialog.show_all()
        dialog.run()
        dialog.destroy()

    def show_about(self, widget):
        """Show the About dialog (app icon + Mollie icon + credits)."""
        show_about_dialog(self.window, APP_NAME, APP_VERSION,
                          APP_ICON, APP_PACKAGE)

    def on_check_updates(self, widget):
        """Help -> Check for Updates: in-place update flow."""
        # (Joshua 2026-10-12: update the installed app in
        # place instead of reinstalling the .deb.)
        # v2.0.2: guard — this handler is only wired when the updater
        # imported successfully, but never trust the menu state.
        if not _UPDATER_AVAILABLE or updater is None:
            return
        updater.check_for_updates_gui(
            self.window, APP_NAME, APP_VERSION,
            UPDATE_SLUG, UPDATE_MANIFEST_URL)

    # ------------------------------------------------------------------
    # Data download (first launch / updates)
    # ------------------------------------------------------------------

    def _initial_setup(self):
        """
        Runs once after the window is realized: position the splitters,
        fit the views, then check whether terrain data needs downloading.
        """
        # Initial splitter positions: top view gets ~55% width; right
        # side splits evenly between player's-eye and side views.
        w = self.window.get_size()[0]
        self.main_paned.set_position(int(w * 0.55))
        h = self.main_paned.get_allocation().height or 700
        self.right_paned.set_position(h // 2)
        self.on_fit_all(None)
        needed, reason = needs_download()
        if needed:
            self._ask_download(reason)
        else:
            self._load_data()
        return False  # run once

    def _ask_download(self, reason):
        """Ask Joshua whether to download terrain data from GitHub."""
        dialog = Gtk.MessageDialog(
            parent=self.window,
            flags=Gtk.DialogFlags.MODAL,
            type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.YES_NO,
            message_format="Terrain data needed")
        dialog.format_secondary_text(
            "%s\n\nThe app downloads ~175KB from GitHub, then "
            "works fully offline." % reason)
        response = dialog.run()
        dialog.destroy()
        if response == Gtk.ResponseType.YES:
            self.on_download_data(None)
        else:
            self.set_status("No terrain data — download from File menu.")

    def on_download_data(self, widget):
        """Download terrain.json (and roads overlay) with a progress dialog."""
        dialog = Gtk.Dialog(title="Downloading…", parent=self.window,
                            flags=Gtk.DialogFlags.MODAL)
        dialog.set_default_size(360, 100)
        label = Gtk.Label(label="Downloading terrain data…")
        bar = Gtk.ProgressBar()
        dialog.get_content_area().pack_start(label, False, False, 8)
        dialog.get_content_area().pack_start(bar, False, False, 8)
        dialog.show_all()

        def do_download():
            """Background thread: download terrain, then roads overlay."""
            def progress(done, total, what):
                GLib.idle_add(
                    lambda: (label.set_text("Downloading %s…" % what),
                             bar.set_fraction(done / total if total else 0)))

            ok = download_terrain(
                lambda d, t: progress(d, t, "terrain"))
            if ok:
                download_roads(lambda d, t: progress(d, t, "roads"))
            GLib.idle_add(lambda: dialog.destroy() or False)
            GLib.idle_add(lambda: self._after_download(ok) or False)

        threading.Thread(target=do_download, daemon=True).start()
        dialog.run()

    def _after_download(self, ok):
        """Called on the main thread after the download finishes."""
        if ok:
            self.set_status("Download complete")
            self._load_data()
        else:
            self.set_status("Download failed — check connection, retry "
                            "from File menu.")

    def _load_data(self):
        """Load heightfield, roads overlay, and the road cell index."""
        if not self.heightfield.load():
            self.set_status("Terrain data missing — use File > Download.")
            return
        self.load_roads_overlay()
        self.on_fit_all(None)
        self.update_status()

    def load_roads_overlay(self):
        """
        Load cached roads (shared suite cache first) and build the
        cell index used for terrain-road grouping.
        """
        self.roads_data = load_roads()
        if self.roads_data:
            self.road_cell_index, self.road_key_cell = \
                build_road_cell_index(self.roads_data)
        self.redraw_all()

    # ------------------------------------------------------------------
    # Unpublished-changes close warning + push (Joshua 2026-10-11)
    # ------------------------------------------------------------------

    def _push_targets(self):
        """Build (repo, path, bytes, message) list for terrain push."""
        payload = export_edits()
        if payload is None:
            return []
        import json as _json
        repo = "kingmarkarnold-code/adamsville-elevation-editor"
        return [(repo, "terrain_edits.json",
                 _json.dumps(payload, indent=1).encode("utf-8"),
                 "Terrain editor: update terrain_edits.json")]

    def _mark_unpublished(self):
        """Mark that local edits haven't been pushed yet."""
        self._unpublished = True
        if not github_sync.has_token() and not self._token_prompted:
            self._token_prompted = True
            if github_sync.show_first_save_prompt(self.window):
                self._do_push()

    def _auto_push_tick(self):
        """5-minute auto-push timer. Returns True to keep running."""
        if self._unpublished and github_sync.has_token():
            self._do_push(silent=True)
        return True

    def _do_push(self, silent=True):
        """Push terrain edits via the GitHub API."""
        if not github_sync.has_token():
            if not silent:
                self.set_status(
                    "No GitHub token — set one in File → Settings.")
            return False
        targets = self._push_targets()
        if not targets:
            self.set_status("No terrain edits to push.")
            return False
        self.set_status("Pushing to GitHub…")

        def worker():
            ok, msg = github_sync.push_targets(targets)

            def done():
                if ok:
                    self._unpublished = False
                    self.set_status("Pushed to GitHub ✓")
                else:
                    self.set_status("Push failed: %s" % msg)
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

    def on_push_github(self, widget):
        """
        File → Push Edits to GitHub: manual on-demand push.
        Uses the GitHub API if a token is set, else the copy/download
        dialog (Joshua sends it to Mollie for the apply step).
        """
        if github_sync.has_token():
            self._do_push(silent=False)
            return
        if github_sync.show_token_dialog(self.window):
            self._do_push(silent=False)
            return
        self._push_manual_dialog()

    def _push_manual_dialog(self):
        """Copy/download fallback dialog (used when no GitHub token)."""
        payload = export_edits()
        if payload is None:
            self.set_status("No terrain data loaded — nothing to push.")
            return
        n = len(payload["modifiedVertices"])
        nr = len(payload.get("roadOffsets", []))

        dialog = Gtk.Dialog(title="Push Edits to GitHub",
                            parent=self.window,
                            flags=Gtk.DialogFlags.MODAL)
        dialog.set_default_size(520, 420)
        dialog_content = dialog.get_content_area()

        info = Gtk.Label()
        info.set_markup(
            "<b>%d</b> modified vertices and <b>%d</b> road offsets "
            "ready to push.\n\n"
            "Copy the JSON below and send it to Mollie — she applies it "
            "to the game repo (batched terrain rebuild)." % (n, nr))
        info.set_line_wrap(True)
        dialog_content.pack_start(info, False, False, 8)

        text = Gtk.TextView()
        text.set_editable(False)
        text.set_wrap_mode(Gtk.WrapMode.WORD)
        import json as _json
        full_json = _json.dumps(payload, indent=2)
        text.get_buffer().set_text(
            full_json[:20000] +
            ("\n…(truncated preview)" if len(full_json) > 20000 else ""))
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_min_content_height(220)
        scrolled.add(text)
        dialog_content.pack_start(scrolled, True, True, 0)

        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        copy_btn = Gtk.Button(label="Copy JSON")
        dl_btn = Gtk.Button(label="Download JSON")
        close_btn = Gtk.Button(label="Close")
        btn_box.pack_start(copy_btn, False, False, 0)
        btn_box.pack_start(dl_btn, False, False, 0)
        btn_box.pack_end(close_btn, False, False, 0)
        dialog_content.pack_start(btn_box, False, False, 8)

        def on_copy(w):
            clip = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            clip.set_text(full_json, -1)
            self.set_status("Push package copied to clipboard.")

        def on_download(w):
            chooser = Gtk.FileChooserDialog(
                title="Save push package", transient_for=dialog,
                action=Gtk.FileChooserAction.SAVE)
            chooser.add_buttons(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
                                Gtk.STOCK_SAVE, Gtk.ResponseType.OK)
            chooser.set_current_name("terrain_edits.json")
            if chooser.run() == Gtk.ResponseType.OK:
                with open(chooser.get_filename(), "w") as f:
                    f.write(full_json)
                self.set_status("Push package saved.")
            chooser.destroy()

        copy_btn.connect("clicked", on_copy)
        dl_btn.connect("clicked", on_download)
        close_btn.connect("clicked", lambda w: dialog.destroy())

        dialog.show_all()
        dialog.run()
        dialog.destroy()


# v2.0.2 (Joshua 2026-10-12): the module-level launch code was missing —
# the class was defined but never instantiated, so the editor exited
# silently on launch. main() + the __main__ guard fix that.
def main():
    """Application entry point."""
    # v2.0.2 (Joshua 2026-10-12): crash logger. If the editor fails to
    # start on Joshua's machine, the traceback is written to
    # ~/.cache/adamsville-terrain-editor-native/crash.log so the real
    # cause can be diagnosed instead of failing silently.
    try:
        from pathlib import Path
        ensure_data_dir()
        app = TerrainEditorApp()
        Gtk.main()
    except Exception:
        try:
            import traceback
            log_dir = Path.home() / ".cache" / "adamsville-terrain-editor-native"
            log_dir.mkdir(parents=True, exist_ok=True)
            with open(log_dir / "crash.log", "w") as f:
                f.write("Adamsville Terrain Editor %s crash log\n" % APP_VERSION)
                traceback.print_exc(file=f)
        except Exception:
            pass
        raise


if __name__ == "__main__":
    main()
