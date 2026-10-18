#!/usr/bin/env python3
"""
Adamsville UI Resource Editor (Native) — Main GTK application.

A visual UI layout editor for the Surviving Adamsville game (Joshua's
spec, 2026-10-11). Two tabs:

  * Layout (primary): see the game's HUD visually per view mode
    (Application / Web desktop / Web mobile), drag elements to move
    them, resize them, hide/show them, add new ones from the existing
    asset library, and save ui_layout.json — which the game fetches at
    startup to position its UI.
  * Resources (secondary): the file manager — list every UI file used
    by the game, preview it, stage adds/removes, push to GitHub.

Pure Python + GTK3. NO webview, NO HTML, NO JavaScript.

Joshua's rule: all code commented.
"""

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GdkPixbuf, GLib

import threading
import json as _json
from pathlib import Path

import github_sync  # noqa: E402 -- suite auto-push + close warning
from about import show_about_dialog
# v1.7.3 (Joshua 2026-10-12): soft import for updater — if updater.py is
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
    ensure_data_dir, needs_download, download_manifest, download_resource,
    load_manifest, load_changes, save_changes, pending_count,
    stage_added_file, stage_content, staged_bytes, clear_staged,
    mark_removed, undo_pending_for, export_payload,
    clear_changes_after_push, save_window_state, load_window_state,
    read_text_preview, resource_type, is_image, is_text, is_visual,
    format_size, STAGING_DIR, PREVIEW_DIR, MANIFEST_FILE,
    save_local_sha, get_remote_sha, served_stale_paths,
)
from layout import LayoutTab
from menus import MenuTab


# App version shown in the Help -> About dialog (bump with each release).
# Joshua 2026-10-11: version number must be prominent in About.
APP_VERSION = "1.9.1"
# Display name and icon-theme name for the About dialog.
APP_NAME = "Adamsville UI Editor"
APP_ICON = "adamsville-ui-editor-native"
APP_PACKAGE = "adamsville-ui-editor-native"
# In-place updater (Joshua 2026-10-12): Help -> Check for
# Updates downloads new editor files from GitHub and applies
# them in place, so reinstalling the .deb is not needed.
UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/kingmarkarnold-code/adamsville-play/main/editors/ui-editor/version.json"
UPDATE_SLUG = "ui-editor"



# Max file size we'll auto-download just to show a preview (200 KB)
PREVIEW_SIZE_LIMIT = 200 * 1024
# Max preview image dimension on screen
PREVIEW_MAX_DIM = 380


class UIEditorApp:
    """Main application class."""

    def __init__(self):
        """Build the UI and initialize state."""
        # In-memory resource list: [{"name", "size", "status"}]
        # status is "", "new" (staged add), or "to remove" (pending removal)
        self.resources = []
        # Unpublished-changes tracking (Joshua 2026-10-11).
        self._unpublished = False

        # Unpublished-changes tracking (Joshua 2026-10-11).
        self._unpublished = False
        self._token_prompted = False
        # Word-style auto-push: every 5 minutes if unpublished + token.
        from gi.repository import GLib as _GLib
        _GLib.timeout_add_seconds(300, self._auto_push_tick)

        # --- Main window ---
        # Native GTK window with standard decorations (min/max/close)
        self.window = Gtk.Window(title="Adamsville UI Editor")
        self.window.set_default_size(1100, 700)
        self.window.connect("delete-event", self.on_window_close)
        # F9/F10 collapse the Layout tab's side panels (Joshua 2026-10-11).
        self.window.connect("key-press-event", self.on_key_press)
        self._restore_window()

        # --- Layout: vertical box ---
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.window.add(vbox)

        # --- Menu bar ---
        vbox.pack_start(self._build_menubar(), False, False, 0)

        # --- Status bar (created early — MenuTab.__init__ calls set_status()
        # during its own init, before the rest of the window is built).
        # v1.7.4 STATUSBAR FIX (2026-10-12): was created after the notebook
        # tabs, so MenuTab -> set_status() crashed with AttributeError because
        # self.statusbar did not exist yet. Now created here, packed below.
        self.statusbar = Gtk.Statusbar()
        self.status_ctx = self.statusbar.get_context_id("main")

        # --- Notebook: Layout (primary) + Resources (file manager) ---
        self.notebook = Gtk.Notebook()
        self.notebook.set_tab_pos(Gtk.PositionType.TOP)
        vbox.pack_start(self.notebook, True, True, 0)

        # Tab 1: visual layout editor (Joshua's primary tool).
        self.layout_tab = LayoutTab(self)
        self.notebook.append_page(self.layout_tab.root,
                                  Gtk.Label(label="Layout"))

        # Tab 2: menu editor (Joshua 2026-10-11 — edit game menus,
        # groups, and items visually).
        self.menu_tab = MenuTab(self)
        self.notebook.append_page(self.menu_tab.root,
                                  Gtk.Label(label="Menus"))

        # Tab 3: resource file manager.
        self.notebook.append_page(self._build_resources_tab(),
                                  Gtk.Label(label="Resources"))

        # --- Status bar widget (already created above; pack it at the bottom
        # of the window here). v1.7.4: creation moved earlier in __init__ so
        # MenuTab can safely call set_status() during its own init.
        vbox.pack_start(self.statusbar, False, False, 0)
        self.set_status("Ready")

        self.window.show_all()

        # First-run data check after the window is realized
        GLib.idle_add(self._initial_setup)

    def on_key_press(self, widget, event):
        """
        Global shortcuts: F9 collapses the Layout tab's left element
        list, F10 collapses its right properties panel, so Joshua can
        focus on the canvas. (Joshua 2026-10-11.)
        """
        key = Gdk.keyval_name(event.keyval)
        tab = getattr(self, "layout_tab", None)
        if tab is None:
            return False
        if key == "F9":
            tab.toggle_left_panel()
            return True
        if key == "F10":
            tab.toggle_right_panel()
            return True
        return False

    # ------------------------------------------------------------------
    # Window geometry
    # ------------------------------------------------------------------

    def _restore_window(self):
        """Restore saved window position/size from previous session."""
        state = load_window_state()
        if state:
            self.window.move(state.get("x", 100), state.get("y", 100))
            self.window.set_default_size(
                state.get("width", 1100), state.get("height", 700))
            if state.get("maximized"):
                self.window.maximize()

    def on_window_close(self, widget, event):
        """
        Save window geometry before closing.
        If there are unpublished changes, ask Joshua what to do
        (Joshua 2026-10-11).
        """
        if self._unpublished or pending_count() > 0:
            choice = self._show_close_warning()
            if choice == "cancel":
                return True  # don't close
            if choice == "push":
                # Open the manual push dialog, then close.
                self.on_push_github(None)
        x, y = self.window.get_position()
        w, h = self.window.get_size()
        save_window_state(x, y, w, h, self.window.is_maximized())
        Gtk.main_quit()
        return False

    # ------------------------------------------------------------------
    # Menu bar
    # ------------------------------------------------------------------

    def _build_menubar(self):
        """Native menu bar: File, Help."""
        menubar = Gtk.MenuBar()

        # --- File menu ---
        file_menu = Gtk.Menu()
        file_item = Gtk.MenuItem(label="File")
        file_item.set_submenu(file_menu)

        dl_item = Gtk.MenuItem(label="Download UI List…")
        dl_item.connect("activate", self.on_download_list)
        file_menu.append(dl_item)

        push_item = Gtk.MenuItem(label="Push Changes to GitHub…")
        push_item.connect("activate", self.on_push_github)
        file_menu.append(push_item)

        settings_item = Gtk.MenuItem(label="Settings…")
        settings_item.connect("activate", self.on_settings_clicked)
        file_menu.append(settings_item)

        quit_item = Gtk.MenuItem(label="Quit")
        quit_item.connect("activate", lambda w: self.window.destroy())
        file_menu.append(quit_item)

        menubar.append(file_item)

        # --- Help menu ---
        help_menu = Gtk.Menu()
        help_item = Gtk.MenuItem(label="Help")
        help_item.set_submenu(help_menu)

        glossary_item = Gtk.MenuItem(label="What does this do?")
        glossary_item.connect("activate", self.show_help)
        help_menu.append(glossary_item)

        # v1.7.3: only offer in-place updates when updater.py imported OK.
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

    def show_help(self, widget):
        """Help dialog explaining both tabs."""
        dialog = Gtk.MessageDialog(
            parent=self.window, flags=Gtk.DialogFlags.MODAL,
            type=Gtk.MessageType.INFO, buttons=Gtk.ButtonsType.OK,
            message_format="Adamsville UI Editor")
        dialog.format_secondary_text(
            "LAYOUT tab (main tool): see the game's interface visually, "
            "drag buttons and icons where you want them, resize them, "
            "hide ones you don't want (like the reports button), or add "
            "new ones from the game's own graphics. Saving a layout "
            "or menus saves it here, pushes it to GitHub, and then "
            "reloads the GitHub copy so you can see it landed.\n\n"
            "RESOURCES tab: every UI file the game uses. Add files from "
            "your computer, remove ones you don't want, refresh the list "
            "from GitHub, and push your changes.")
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
        # v1.7.3: guard — this handler is only wired when the updater
        # imported successfully, but never trust the menu state.
        if not _UPDATER_AVAILABLE or updater is None:
            return
        updater.check_for_updates_gui(
            self.window, APP_NAME, APP_VERSION,
            UPDATE_SLUG, UPDATE_MANIFEST_URL)

    # ------------------------------------------------------------------
    # Resources tab (file manager)
    # ------------------------------------------------------------------

    def _build_resources_tab(self):
        """Assemble the Resources tab: toolbar, search, list + preview."""
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        # Toolbar: Add / Remove / Refresh / Push.
        root.pack_start(self._build_toolbar(), False, False, 0)

        # Search bar + "Visual only" filter (Joshua 2026-10-11: hide the
        # non-visual background files to reduce clutter).
        search_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        search_box.set_border_width(6)
        search_box.pack_start(Gtk.Label(label="Search:"), False, False, 0)
        self.search_entry = Gtk.Entry()
        self.search_entry.set_placeholder_text("Filter resources by name…")
        self.search_entry.connect("changed", self.on_search_changed)
        search_box.pack_start(self.search_entry, True, True, 0)
        self.visual_only_check = Gtk.CheckButton(label="Visual only")
        self.visual_only_check.set_tooltip_text(
            "Show only visual UI resources: images, JavaScript UI files, "
            "and JSON layout files. Hides background scripts and data.")
        self.visual_only_check.connect("toggled", self.on_search_changed)
        search_box.pack_start(self.visual_only_check, False, False, 0)
        root.pack_start(search_box, False, False, 0)

        # Main paned area: list (left) + preview (right).
        paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        paned.set_position(620)
        root.pack_start(paned, True, True, 0)

        self._build_resource_list()
        list_scroll = Gtk.ScrolledWindow()
        list_scroll.add(self.treeview)
        paned.pack1(list_scroll, resize=True, shrink=False)

        self._build_preview_panel()
        preview_scroll = Gtk.ScrolledWindow()
        preview_scroll.add(self.preview_box)
        paned.pack2(preview_scroll, resize=False, shrink=False)

        return root

    def refresh_resources_list(self):
        """Public refresh (the Layout tab calls this after staging)."""
        self.refresh_list()

    # ------------------------------------------------------------------
    # Toolbar (Resources tab)
    # ------------------------------------------------------------------

    def _build_toolbar(self):
        """Native GTK toolbar with the four file actions."""
        toolbar = Gtk.Toolbar()
        toolbar.set_style(Gtk.ToolbarStyle.BOTH)  # icon + text

        # (id, label, stock icon, tooltip)
        buttons = [
            ("add", "Add", Gtk.STOCK_ADD,
             "Add a file from your computer to the game"),
            ("remove", "Remove", Gtk.STOCK_REMOVE,
             "Remove the selected resource from the game"),
            ("refresh", "Refresh", Gtk.STOCK_REFRESH,
             "Check GitHub for a newer resource list"),
            ("push", "Push to GitHub", Gtk.STOCK_GO_UP,
             "Push pending changes to GitHub, then reload the "
             "GitHub copies"),
        ]
        self.toolbar_buttons = {}
        for btn_id, label, stock, tooltip in buttons:
            btn = Gtk.ToolButton.new_from_stock(stock)
            btn.set_label(label)
            btn.set_is_important(True)  # always show the text label
            btn.set_tooltip_text(tooltip)
            btn.connect("clicked", self.on_toolbar_clicked, btn_id)
            toolbar.insert(btn, -1)
            self.toolbar_buttons[btn_id] = btn

        self.toolbar_buttons["remove"].set_sensitive(False)

        # Separator + gear button for Settings (GitHub API key management).
        # Joshua 2026-10-11: key must be changeable in-app, no reinstall.
        toolbar.insert(Gtk.SeparatorToolItem(), -1)
        gear = Gtk.ToolButton.new_from_stock(Gtk.STOCK_PREFERENCES)
        gear.set_tooltip_text("Settings — GitHub API key")
        gear.connect("clicked", self.on_settings_clicked)
        toolbar.insert(gear, -1)

        return toolbar

    def on_toolbar_clicked(self, widget, btn_id):
        """Route toolbar clicks to the matching action."""
        if btn_id == "add":
            self.on_add()
        elif btn_id == "remove":
            self.on_remove()
        elif btn_id == "refresh":
            self.on_download_list(widget)
        elif btn_id == "push":
            self.on_push_github(widget)

    # ------------------------------------------------------------------
    # Resource list (Resources tab, left panel)
    # ------------------------------------------------------------------

    def _build_resource_list(self):
        """
        Build the TreeView: icon, name, type, size, status.
        A TreeModelFilter sits on top for the search box and the
        "Visual only" checkbox.
        """
        # Columns: 0=pixbuf, 1=name, 2=type, 3=size text, 4=status, 5=size bytes
        self.store = Gtk.ListStore(GdkPixbuf.Pixbuf, str, str, str, str, int)
        self.filter = self.store.filter_new()
        self.filter.set_visible_func(self._filter_visible)

        self.treeview = Gtk.TreeView(model=self.filter)
        self.treeview.get_selection().set_mode(Gtk.SelectionMode.SINGLE)
        self.treeview.get_selection().connect("changed",
                                              self.on_selection_changed)

        # Icon column (no header text; fixed width — it's just a themed icon)
        icon_renderer = Gtk.CellRendererPixbuf()
        icon_col = Gtk.TreeViewColumn("", icon_renderer, pixbuf=0)
        icon_col.set_resizable(False)  # fixed: no reason to stretch an icon
        self.treeview.append_column(icon_col)

        # Name column (expands); Joshua asked for resizable columns (2026-10-11)
        name_renderer = Gtk.CellRendererText()
        name_col = Gtk.TreeViewColumn("Name", name_renderer, text=1)
        name_col.set_expand(True)
        name_col.set_resizable(True)   # drag the header edge to resize
        name_col.set_reorderable(True)  # drag the header itself to reorder
        name_col.set_min_width(120)    # keep a usable floor so it can't vanish
        name_col.set_sort_column_id(1)
        self.treeview.append_column(name_col)

        # Type, size, status columns — all user-resizable per Joshua's request
        for idx, title, min_w in ((2, "Type", 80),
                                  (3, "Size", 70),
                                  (4, "Status", 90)):
            renderer = Gtk.CellRendererText()
            col = Gtk.TreeViewColumn(title, renderer, text=idx)
            col.set_resizable(True)   # drag the header edge to resize
            col.set_reorderable(True)  # drag the header itself to reorder
            col.set_min_width(min_w)  # don't let the column collapse away
            col.set_sort_column_id(idx)
            self.treeview.append_column(col)

        self.icon_theme = Gtk.IconTheme.get_default()

    def _filter_visible(self, model, treeiter, data):
        """
        Combined filter: the search text AND the "Visual only" checkbox.
        Both must pass for a row to show.
        """
        name = model[treeiter][1]
        # "Visual only" hides background scripts/data/audio/etc.
        if self.visual_only_check.get_active() and not is_visual(name):
            return False
        query = self.search_entry.get_text().strip().lower()
        if not query:
            return True
        return query in name.lower()

    def on_search_changed(self, entry):
        """Re-apply the filters as Joshua types or toggles."""
        self.filter.refilter()

    def _icon_for(self, name, status):
        """
        Pick a themed icon for a resource: image icon for images,
        script icon for code, generic file icon otherwise.
        Pending removals get a muted look via the status text instead.
        """
        candidates = []
        if is_image(name):
            candidates = ["image-x-generic", "image"]
        elif name.endswith(".js"):
            candidates = ["text-x-script", "text-x-generic"]
        elif name.endswith(".json"):
            candidates = ["text-x-generic", "text"]
        elif name.endswith((".mp3", ".ogg", ".wav")):
            candidates = ["audio-x-generic", "audio"]
        else:
            candidates = ["text-x-generic", "unknown"]
        for icon_name in candidates:
            try:
                return self.icon_theme.load_icon(icon_name, 24,
                                                 Gtk.IconLookupFlags(0))
            except Exception:
                continue
        return None

    def refresh_list(self):
        """
        Rebuild the list from the manifest + pending changes.
        Manifest files first (alphabetical), then staged adds.
        """
        self.store.clear()
        self.resources = []
        changes = load_changes()
        manifest = load_manifest() or []

        rows = []
        manifest_names = set()
        for entry in manifest:
            name = entry["name"]
            manifest_names.add(name)
            if name in changes["removed"]:
                status = "to remove"
            elif name in changes["added"]:
                # Joshua edited an existing game file (pencil edit):
                # staged content overwrites it on push.
                status = "modified"
            else:
                status = ""
            rows.append({"name": name, "size": entry["size"],
                         "status": status})
        # Staged adds not in the manifest yet — brand-new files, on top.
        # (Names already listed above as "modified" are skipped here.)
        for name in changes["added"]:
            if name in manifest_names:
                continue
            size = 0
            try:
                size = (STAGING_DIR / name).stat().st_size
            except Exception:
                pass
            rows.insert(0, {"name": name, "size": size, "status": "new"})

        rows.sort(key=lambda r: (r["status"] not in ("new", "modified"),
                                 r["name"].lower()))
        for r in rows:
            self.resources.append(r)
            self.store.append([self._icon_for(r["name"], r["status"]),
                               r["name"],
                               resource_type(r["name"]),
                               format_size(r["size"]),
                               r["status"],
                               r["size"]])
        self.update_status()

    def on_selection_changed(self, selection):
        """Enable Remove when something is selected; update preview."""
        model, treeiter = selection.get_selected()
        has_sel = treeiter is not None
        self.toolbar_buttons["remove"].set_sensitive(has_sel)
        if has_sel:
            self.show_preview(model[treeiter][1], model[treeiter][5],
                              model[treeiter][4])
        else:
            self.clear_preview()

    def selected_resource(self):
        """Return (name, size_bytes, status) of the selected row, or None."""
        selection = self.treeview.get_selection()
        model, treeiter = selection.get_selected()
        if treeiter is None:
            return None
        return model[treeiter][1], model[treeiter][5], model[treeiter][4]

    # ------------------------------------------------------------------
    # Preview panel (Resources tab, right)
    # ------------------------------------------------------------------

    def _build_preview_panel(self):
        """Right-side panel: image thumbnail or file info."""
        self.preview_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                                   spacing=8)
        self.preview_box.set_border_width(12)
        self.clear_preview()

    def clear_preview(self):
        """Empty preview with a hint label."""
        self.edit_state = None  # drop any in-progress edit state
        for child in self.preview_box.get_children():
            self.preview_box.remove(child)
        hint = Gtk.Label(label="Select a resource to preview it.")
        hint.set_line_wrap(True)
        self.preview_box.pack_start(hint, True, True, 0)
        self.preview_box.show_all()

    def show_preview(self, name, size_bytes, status):
        """
        Show a preview for the selected resource (read-only view mode).

        The header carries a pencil (edit) button (Joshua 2026-10-11):
        for text files it switches the preview into an editable mode
        with Save/Cancel. Any in-progress edit is discarded when the
        selection changes.
        """
        # Fresh state: name/size/status of the previewed file, whether we
        # are editing, and widget refs filled in by the content helpers.
        self.edit_state = {"name": name, "size": size_bytes,
                           "status": status, "editing": False,
                           "textview": None, "pencil": None,
                           "edit_bar": None}
        for child in self.preview_box.get_children():
            self.preview_box.remove(child)

        # Header row: file name + pencil edit button.
        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        title = Gtk.Label()
        title.set_markup(f"<b>{GLib.markup_escape_text(name)}</b>")
        title.set_line_wrap(True)
        title.set_halign(Gtk.Align.START)
        title.set_hexpand(True)
        header.pack_start(title, True, True, 0)
        pencil = Gtk.Button(label="✎")
        pencil.set_relief(Gtk.ReliefStyle.NONE)
        if is_text(name):
            pencil.set_tooltip_text("Edit this file")
        else:
            pencil.set_tooltip_text("Only text files can be edited")
            pencil.set_sensitive(False)
        pencil.connect("clicked", self.on_pencil_clicked)
        header.pack_start(pencil, False, False, 0)
        self.preview_box.pack_start(header, False, False, 0)
        self.edit_state["pencil"] = pencil

        # Info line: type, size, status
        info_text = f"{resource_type(name)} · {format_size(size_bytes)}"
        if status == "new":
            info_text += " · <b>new (staged)</b>"
        elif status == "modified":
            info_text += " · <b>edited (staged)</b>"
        elif status == "to remove":
            info_text += " · <b>marked for removal</b>"
        info = Gtk.Label()
        info.set_markup(info_text)
        info.set_halign(Gtk.Align.START)
        self.preview_box.pack_start(info, False, False, 0)

        if status == "new":
            # Staged file is already on local disk — preview it directly
            self._preview_local_file(STAGING_DIR / name, name)
        elif is_image(name):
            # Download the image lazily, then thumbnail it
            self._preview_remote_image(name)
        elif is_text(name):
            if size_bytes <= PREVIEW_SIZE_LIMIT:
                self._preview_remote_text(name)
            else:
                # Too big to auto-preview, but still editable on demand.
                note = Gtk.Label(
                    label=f"File too large to preview "
                          f"({format_size(size_bytes)}). "
                          f"Click ✎ above to edit it.")
                note.set_line_wrap(True)
                self.preview_box.pack_start(note, False, False, 0)
        else:
            note = Gtk.Label(
                label="No preview available for this file type.")
            note.set_line_wrap(True)
            self.preview_box.pack_start(note, False, False, 0)

        self.preview_box.show_all()

    # -- pencil-to-edit (Joshua 2026-10-11) -------------------------------

    def on_pencil_clicked(self, widget):
        """
        Enter edit mode for the previewed text file: load the FULL file
        (the preview only shows the first 2000 chars), make the text
        editable, and show Save/Cancel.
        """
        st = self.edit_state
        if not st or st["editing"] or st["textview"] is None:
            # No text loaded yet (e.g. still downloading, or a large
            # file with no preview): load it directly for editing.
            if not st or st["editing"]:
                return
            self._enter_edit_mode(st, None)
            return
        self._enter_edit_mode(st, st["textview"])

    def _enter_edit_mode(self, st, textview):
        """Common entry into edit mode, with or without a preview widget."""
        name = st["name"]
        # Resolve the full local file: staged copy wins, otherwise the
        # downloaded preview cache (download_resource caches everything).
        if st["status"] == "new":
            local = STAGING_DIR / name
        else:
            local = download_resource(name)
        if local is None or not Path(local).exists():
            self.set_status(f"Could not load '{name}' for editing")
            return
        try:
            text = Path(local).read_text(errors="replace")
        except Exception as e:
            self.set_status(f"Could not read '{name}': {e}")
            return

        if textview is None:
            # No preview widget (large file): build an editable text view.
            textview = self._append_text_view()
            st["textview"] = textview
        textview.get_buffer().set_text(text)
        textview.set_editable(True)
        textview.grab_focus()

        # Edit-mode action bar: Save / Cancel, placed under the info line.
        edit_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                           spacing=8)
        save_btn = Gtk.Button(label="Save")
        save_btn.set_tooltip_text(
            "Save changes: saves here, pushes to GitHub, then shows "
            "the GitHub copy")
        save_btn.connect("clicked", self.on_edit_save)
        cancel_btn = Gtk.Button(label="Cancel")
        cancel_btn.set_tooltip_text("Discard changes")
        cancel_btn.connect("clicked", self.on_edit_cancel)
        edit_bar.pack_start(save_btn, False, False, 0)
        edit_bar.pack_start(cancel_btn, False, False, 0)
        self.preview_box.pack_start(edit_bar, False, False, 0)
        # Header=0, info=1 → action bar at position 2, above the content.
        self.preview_box.reorder_child(edit_bar, 2)
        st["edit_bar"] = edit_bar

        st["editing"] = True
        st["pencil"].set_sensitive(False)
        self.preview_box.show_all()
        self.set_status(f"Editing '{name}' — Save or Cancel when done")

    def on_edit_save(self, widget):
        """
        Save the edited text — GLOBAL SAVE PROTOCOL (v1.7.7): stage
        it locally, push the same-named game file to GitHub, then
        rebuild the preview from the re-downloaded GitHub copy. A
        failed push says so plainly and leaves the edit staged —
        nothing claims to be in the game when it isn't.
        """
        st = self.edit_state
        if not st or not st["editing"]:
            return
        buf = st["textview"].get_buffer()
        text = buf.get_text(buf.get_start_iter(), buf.get_end_iter(), True)
        name = st["name"]
        if stage_content(name, text.encode("utf-8")) is None:
            self.set_status(f"Could not save '{name}'")
            return
        self._unpublished = True
        self.set_status(f"Saved '{name}' locally — pushing to GitHub…")

        def done(ok, err, fresh):
            # Round-trip callback (GTK thread).
            if ok:
                # Point the preview at the GitHub copy that was just
                # re-downloaded, then rebuild it.
                if fresh and name in fresh:
                    try:
                        # The preview cache dir normally exists by
                        # now (the edit started from a download), but
                        # never let the round trip depend on that.
                        PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
                        (PREVIEW_DIR / name).write_bytes(fresh[name])
                    except Exception:
                        pass
                self.refresh_list()
                self._select_by_name(name)  # rebuilds preview
                self.set_status(
                    f"Saved '{name}' and pushed — showing the "
                    f"GitHub copy ✓")
            else:
                self.refresh_list()
                self._select_by_name(name)
                # v1.7.8: err names the failed stage (see
                # _round_trip_run) — a landed push is never reported
                # as "did NOT reach GitHub".
                self.set_status(f"'{name}' saved locally. {err}")
        self.round_trip_save([name], done)

    def on_edit_cancel(self, widget):
        """Discard edits and return to the read-only preview."""
        st = self.edit_state
        if not st:
            return
        self.show_preview(st["name"], st["size"], st["status"])

    def _select_by_name(self, name):
        """Re-select the list row for `name` after a list rebuild."""
        for row in self.filter:
            if row[1] == name:
                self.treeview.get_selection().select_iter(row.iter)
                self.treeview.scroll_to_cell(row.path, None,
                                             False, 0, 0)
                return

    def _preview_local_file(self, path, name):
        """Preview a file that is already on local disk (staged add)."""
        if is_image(name):
            self._show_image(path)
        elif is_text(name):
            self._show_text(read_text_preview(path))
        else:
            note = Gtk.Label(label="No preview available for this file type.")
            self.preview_box.pack_start(note, False, False, 0)

    def _preview_remote_image(self, name):
        """Download an image in the background, then show its thumbnail."""
        loading = Gtk.Label(label="Downloading preview…")
        self.preview_box.pack_start(loading, False, False, 0)
        self.preview_box.show_all()

        def worker():
            local = download_resource(name)

            def done():
                # The selection may have changed while downloading
                sel = self.selected_resource()
                if sel is None or sel[0] != name:
                    return False
                st = self.edit_state
                if st and st["name"] == name and st["editing"]:
                    # Joshua clicked the pencil while the preview was
                    # still downloading — he is already editing the full
                    # file; don't clobber it with the truncated preview.
                    self.preview_box.remove(loading)
                    self.preview_box.show_all()
                    return False
                # Drop just the "Downloading…" label; the header (with
                # the pencil button) and info line stay put.
                self.preview_box.remove(loading)
                if local is not None:
                    self._show_image(local)
                else:
                    err = Gtk.Label(label="Could not download preview.")
                    self.preview_box.pack_start(err, False, False, 0)
                self.preview_box.show_all()
                return False
            GLib.idle_add(done)
        threading.Thread(target=worker, daemon=True).start()

    def _preview_remote_text(self, name):
        """Download a small text file in the background, then show it."""
        loading = Gtk.Label(label="Downloading preview…")
        self.preview_box.pack_start(loading, False, False, 0)
        self.preview_box.show_all()

        def worker():
            local = download_resource(name)
            text = read_text_preview(local) if local else \
                "(could not download preview.)"

            def done():
                sel = self.selected_resource()
                if sel is None or sel[0] != name:
                    return False
                st = self.edit_state
                if st and st["name"] == name and st["editing"]:
                    # Pencil was clicked mid-download — Joshua is already
                    # editing the full file; skip the truncated preview.
                    self.preview_box.remove(loading)
                    self.preview_box.show_all()
                    return False
                # Drop just the "Downloading…" label; header/info stay.
                self.preview_box.remove(loading)
                self._show_text(text)
                self.preview_box.show_all()
                return False
            GLib.idle_add(done)
        threading.Thread(target=worker, daemon=True).start()

    def _show_image(self, path):
        """Add a scaled-down image widget to the preview panel."""
        try:
            pixbuf = GdkPixbuf.Pixbuf.new_from_file(str(path))
            w, h = pixbuf.get_width(), pixbuf.get_height()
            scale = min(1.0, PREVIEW_MAX_DIM / max(w, h))
            if scale < 1.0:
                pixbuf = pixbuf.scale_simple(int(w * scale), int(h * scale),
                                             GdkPixbuf.InterpType.BILINEAR)
            img = Gtk.Image.new_from_pixbuf(pixbuf)
            self.preview_box.pack_start(img, False, False, 0)
            dim = Gtk.Label(label=f"{w} × {h} px")
            self.preview_box.pack_start(dim, False, False, 0)
        except Exception:
            err = Gtk.Label(label="Could not display this image.")
            self.preview_box.pack_start(err, False, False, 0)

    def _append_text_view(self):
        """
        Build the scrollable text widget for the preview panel and
        return it. The caller registers it in edit_state for the
        pencil-to-edit flow.
        """
        textview = Gtk.TextView()
        textview.set_editable(False)  # view mode until the pencil is clicked
        textview.set_monospace(True)
        textview.set_wrap_mode(Gtk.WrapMode.NONE)
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_min_content_height(300)
        scrolled.add(textview)
        self.preview_box.pack_start(scrolled, True, True, 0)
        return textview

    def _show_text(self, text):
        """Add a scrollable read-only text preview to the panel."""
        textview = self._append_text_view()
        textview.get_buffer().set_text(text)
        # Register for pencil-to-edit (cleared if the selection changes).
        if self.edit_state is not None:
            self.edit_state["textview"] = textview

    # ------------------------------------------------------------------
    # Actions: Add / Remove
    # ------------------------------------------------------------------

    def on_add(self):
        """
        Add: let Joshua pick files from disk — then (v1.7.7 GLOBAL
        SAVE PROTOCOL) they are saved locally, pushed to GitHub and
        the Resources list is reloaded from the GitHub manifest, all
        as this one action. Multiple files can be selected at once.
        """
        chooser = Gtk.FileChooserDialog(
            title="Add files to the game", parent=self.window,
            action=Gtk.FileChooserAction.OPEN)
        chooser.add_buttons(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
                            Gtk.STOCK_OPEN, Gtk.ResponseType.OK)
        chooser.set_select_multiple(True)
        if chooser.run() == Gtk.ResponseType.OK:
            staged = 0
            for path in chooser.get_filenames():
                if stage_added_file(path):
                    staged += 1
            if staged > 0:
                self._unpublished = True
                self.set_status(
                    f"Added {staged} file(s) locally — pushing to "
                    f"GitHub…")
                self.round_trip_save()
            else:
                self.set_status("No files were added")
            self.refresh_list()
        chooser.destroy()

    def on_remove(self):
        """
        Remove: mark the selected resource for removal.
        If it is already pending (staged add or marked removal),
        offer to cancel that pending change instead.
        Always asks for confirmation — nothing is deleted silently.
        """
        sel = self.selected_resource()
        if sel is None:
            return
        name, _size, status = sel

        if status == "new":
            # It was never in the game — just drop it from staging
            dlg = Gtk.MessageDialog(
                parent=self.window, flags=Gtk.DialogFlags.MODAL,
                type=Gtk.MessageType.QUESTION, buttons=Gtk.ButtonsType.OK_CANCEL,
                message_format=f"Drop '{name}' from the staged adds?")
            if dlg.run() == Gtk.ResponseType.OK:
                undo_pending_for(name)
                self.set_status(f"Dropped staged file '{name}'")
                self.refresh_list()
            dlg.destroy()
            return

        if status == "to remove":
            # Already marked — offer to undo the pending removal
            dlg = Gtk.MessageDialog(
                parent=self.window, flags=Gtk.DialogFlags.MODAL,
                type=Gtk.MessageType.QUESTION, buttons=Gtk.ButtonsType.OK_CANCEL,
                message_format=f"Keep '{name}'? (cancel pending removal)")
            if dlg.run() == Gtk.ResponseType.OK:
                undo_pending_for(name)
                self.set_status(f"Kept '{name}' — removal cancelled")
                self.refresh_list()
            dlg.destroy()
            return

        # Normal case: confirm marking a game file for removal
        dlg = Gtk.MessageDialog(
            parent=self.window, flags=Gtk.DialogFlags.MODAL,
            type=Gtk.MessageType.WARNING, buttons=Gtk.ButtonsType.OK_CANCEL,
            message_format=f"Remove '{name}' from the game?")
        dlg.format_secondary_text(
            "It will be removed from GitHub right away when you "
            "confirm, and this editor then reloads the game's file "
            "list from GitHub so you can see it is gone. If the "
            "removal cannot reach GitHub, it stays marked here "
            "instead — nothing pretends to be removed when it isn't.")
        if dlg.run() == Gtk.ResponseType.OK:
            mark_removed(name)
            self.set_status(f"Removing '{name}' from GitHub…")
            self._unpublished = True
            self.refresh_list()
            # v1.7.7 GLOBAL SAVE PROTOCOL: the removal is pushed
            # (deleted) now, not at some later manual push.
            self.round_trip_save()
        dlg.destroy()

    # ------------------------------------------------------------------
    # Download / refresh
    # ------------------------------------------------------------------

    def _initial_setup(self):
        """First-run check: prompt to download the UI list if missing."""
        needed, reason = needs_download()
        if needed and not load_manifest():
            # No local data at all — ask before downloading
            dlg = Gtk.MessageDialog(
                parent=self.window, flags=Gtk.DialogFlags.MODAL,
                type=Gtk.MessageType.QUESTION,
                buttons=Gtk.ButtonsType.OK_CANCEL,
                message_format="Download the game's UI resource list?")
            dlg.format_secondary_text(
                "The editor needs the file list from GitHub first "
                "(one small download).")
            if dlg.run() == Gtk.ResponseType.OK:
                dlg.destroy()
                self.on_download_list(None)
            else:
                dlg.destroy()
                self.set_status("No UI data — use File > Download UI List…")
        else:
            self.refresh_list()
            if needed:
                # A newer version exists; mention it but don't force it
                self.set_status(reason + " Use Refresh to update.")
        # v1.9.0 (SHARED-CACHE.md rule 3): if any download-on-open
        # was served from the suite shared cache because the fresh
        # download or its verification failed, SAY SO in the status
        # bar — a stale serve is never silent.
        stale = served_stale_paths()
        if stale:
            names = ", ".join(
                p.replace("detailed/", "") for p in stale)
            self.set_status(
                f"Offline note: {names} shown from the shared "
                f"cache (connection failed) — may not be the "
                f"newest copy.")
        return False  # run once

    def on_download_list(self, widget):
        """Download (or re-download) ui-manifest.json with a progress bar."""
        needed, reason = needs_download()
        if not needed:
            self.set_status(reason)
            # Still refresh the list in case local changes were made
            self.refresh_list()
            return

        # Progress dialog
        dialog = Gtk.Dialog(title="Downloading UI List", parent=self.window,
                            flags=Gtk.DialogFlags.MODAL)
        dialog.set_default_size(360, 120)
        content = dialog.get_content_area()
        label = Gtk.Label(label=reason)
        label.set_line_wrap(True)
        content.pack_start(label, False, False, 8)
        bar = Gtk.ProgressBar()
        content.pack_start(bar, False, False, 8)
        dialog.show_all()

        def worker():
            def progress(done, total):
                def update():
                    if total > 0:
                        bar.set_fraction(done / total)
                    return False
                GLib.idle_add(update)

            ok = download_manifest(progress_callback=progress)

            def done():
                dialog.destroy()
                if ok:
                    self.set_status("UI list downloaded")
                    self.refresh_list()
                else:
                    self.set_status("Download failed — check connection")
                return False
            GLib.idle_add(done)

        threading.Thread(target=worker, daemon=True).start()

    # ------------------------------------------------------------------
    # Push to GitHub
    # ------------------------------------------------------------------
    # v1.7.7: the old _push_targets() (which only ever pushed
    # detailed/ui_layout.json) is gone — round_trip_save() below
    # builds its targets from ALL pending staged files instead.

    def _mark_unpublished(self):
        """Mark that local edits haven't been pushed yet."""
        self._unpublished = True
        if not github_sync.has_token() and not self._token_prompted:
            self._token_prompted = True
            if github_sync.show_first_save_prompt(self.window):
                # Token just set: run the full round trip over
                # everything pending (v1.7.7 save protocol).
                self.round_trip_save()

    def _auto_push_tick(self):
        """5-minute auto-push timer. Returns True to keep running."""
        if self._unpublished and github_sync.has_token():
            # v1.7.7: the auto-push is the same round trip a manual
            # save uses (push, then re-download), just silent.
            self.round_trip_save(silent=True)
        return True

    # ------------------------------------------------------------------
    # GLOBAL SAVE PROTOCOL (v1.7.7, Joshua 2026-10-16)
    # ------------------------------------------------------------------
    # EVERY save in this app is ONE action:
    #   1. the file is saved locally (staged),
    #   2. it is pushed to GitHub,
    #   3. it is re-downloaded from GitHub and that copy is what the
    #      app displays — visible proof the save landed.
    # This replaces the 1.7.6 staged/two-step design, whose push only
    # ever contained detailed/ui_layout.json: menu edits staged by
    # "Save Menus" were never pushed at all, and the Menus tab then
    # re-downloaded over them on the next open.
    GAME_REPO = "kingmarkarnold-code/adamsville-play"

    def round_trip_save(self, names=None, on_done=None, silent=False):
        """
        Push pending work to GitHub, then re-download the pushed
        files and hand their fresh GitHub bytes to the callback.

        names: staged file names to include, or None for EVERYTHING
            pending (all staged adds/edits + all pending removals,
            with the ui-manifest.json entries kept in step).
        on_done(ok, err, fresh): called on the GTK thread. `fresh`
            maps file name -> the exact bytes re-downloaded from
            GitHub after the push. On failure ok is False, err is a
            complete stage-accurate sentence (see _round_trip_run:
            v1.7.8 two-connection legs + stage naming), and NOTHING
            is reloaded over the user's view.
        Returns True if a round trip started.
        """
        import threading
        from gi.repository import GLib

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
        plan = self._round_trip_plan(names)
        if plan is None:
            if silent:
                return False
            GLib.idle_add(self._fire_done, on_done, False,
                          "Nothing to push.", None)
            return False
        if not silent:
            self.set_status("Pushing to GitHub…")

        def worker():
            ok, err, fresh = self._round_trip_run(plan)
            GLib.idle_add(self._fire_done, on_done, ok, err, fresh)

        threading.Thread(target=worker, daemon=True).start()
        return True

    @staticmethod
    def _fire_done(on_done, ok, err, fresh):
        """GLib.idle_add adapter: run the callback once."""
        on_done(ok, err, fresh)
        return False

    def _round_trip_plan(self, names):
        """
        Snapshot what a round trip will push (called on the GTK
        thread; the staged files are small). Returns
        {"push": [(name, bytes)], "delete": [name], "full": bool}
        or None when there is nothing to do.
        """
        if names is None:
            changes = load_changes()
            push_names = list(changes["added"])
            delete_names = list(changes["removed"])
            full = True
        else:
            push_names = list(names)
            delete_names = []
            full = False
        push = []
        for n in push_names:
            b = staged_bytes(n)
            if b is not None:
                push.append((n, b))
        if not push and not delete_names:
            return None
        return {"push": push, "delete": delete_names, "full": full}

    def _round_trip_run(self, plan):
        """
        Execute a round-trip plan on a worker thread (network + file
        IO only, no GTK). Returns (ok, err, fresh).

        v1.7.8 — TWO CONNECTION LEGS (Joshua's design, 2026-10-16):
        in 1.7.7 the push and the proof download ran as one undivided
        flow; on Joshua's laptop the push LANDED but the download died
        with "Remote end closed connection without response". Now the
        PUSH leg (file pushes + removals + the manifest update) runs
        on ONE connection, which is then CLOSED, and the DOWNLOAD leg
        (the proof re-download) runs on a brand-NEW connection. The
        download never inherits the push's socket.

        v1.7.8 — STAGE-ACCURATE ERRORS: err names the stage that
        failed. A push-stage failure says the push failed; a
        download-stage failure says the file WAS pushed and only the
        proof download failed — it never claims the save "did not
        reach GitHub" when the push landed.
        """
        import hashlib

        repo = self.GAME_REPO
        tok = github_sync.get_token()

        # ---- PUSH LEG: one connection for every mutation. --------
        push_conn = github_sync.open_connection()
        try:
            # Step 2a: push every staged file in the plan.
            targets = [(repo, f"detailed/{n}", b,
                        f"UI editor: update {n}")
                       for n, b in plan["push"]]
            if targets:
                ok, msg = github_sync.push_targets(
                    targets, token=tok, conn=push_conn)
                if not ok:
                    return False, f"Push to GitHub failed: {msg}", None
            # Step 2b: apply pending removals (only in a full push).
            # A 404 means the file is already gone from GitHub, which
            # is the state a removal wants — count it as removed.
            deleted = []
            for n in plan["delete"]:
                ok, msg = github_sync.delete_file(
                    repo, f"detailed/{n}", f"UI editor: remove {n}",
                    token=tok, conn=push_conn)
                if not ok and "404" not in msg:
                    return False, (f"Push to GitHub failed: "
                                   f"{n}: {msg}"), None
                deleted.append(n)
            pushed_names = [n for n, _b in plan["push"]]
            # Full pushes keep detailed/ui-manifest.json truthful
            # (entry size + sha256 for pushed files, entries dropped
            # for removals) so the game's file list matches what was
            # saved. The manifest read+write is part of the PUSH leg
            # (it prepares and lands a mutation), so it rides the
            # push connection too.
            manifest_touched = bool(plan["full"]
                                    and (pushed_names or deleted))
            if manifest_touched:
                ok, msg = self._update_manifest(
                    pushed_names, deleted, conn=push_conn)
                if not ok:
                    return False, msg, None
        finally:
            # Joshua's rule: the push connection is CLOSED before any
            # download happens — even when the push failed, so no leg
            # ever leaves a half-dead socket behind for the next one.
            push_conn.close()

        # ---- DOWNLOAD LEG: a brand-new connection. ---------------
        # Opened only now, after the push connection is closed — the
        # proof download can never die on the push's stale socket.
        dl_conn = github_sync.open_connection()
        try:
            # Step 3: re-download everything that was pushed. What
            # comes back IS the new repo state — callers display
            # exactly this.
            fresh = {}
            for n in pushed_names:
                b, err = github_sync.fetch_file(
                    repo, f"detailed/{n}", token=tok, conn=dl_conn)
                if b is None:
                    return False, (
                        f"{n} was pushed to GitHub, but downloading "
                        f"the proof copy back failed: {err} — the "
                        f"save DID reach GitHub; reopen the tab to "
                        f"see the GitHub copy."), None
                fresh[n] = b
            if manifest_touched:
                mb, err = github_sync.fetch_file(
                    repo, "detailed/ui-manifest.json",
                    token=tok, conn=dl_conn)
                if mb is None:
                    return False, (
                        "ui-manifest.json was pushed to GitHub, but "
                        f"downloading the proof copy back failed: "
                        f"{err} — the save DID reach GitHub."), None
                fresh["ui-manifest.json"] = mb
                # Cache the GitHub manifest (+ its SHA) so the
                # Resources tab shows the GitHub list, not the
                # pre-push one.
                try:
                    MANIFEST_FILE.write_bytes(mb)
                    sha = get_remote_sha()
                    if sha:
                        save_local_sha(sha)
                except Exception:
                    pass
        finally:
            dl_conn.close()
        # The round trip completed for these names: their staged
        # copies now equal the repo bytes, so drop them.
        for n in pushed_names:
            clear_staged(n)
        if deleted:
            changes = load_changes()
            for n in deleted:
                if n in changes["removed"]:
                    changes["removed"].remove(n)
            save_changes(changes)
        return True, None, fresh

    def _update_manifest(self, pushed_names, deleted, conn=None):
        """
        Worker-thread helper: refresh detailed/ui-manifest.json on
        GitHub after a resource push — entries for pushed files get
        their real size + sha256 (from the staged bytes), entries
        for removed files are dropped, everything else (including
        the version fields) stays exactly as the repo has it.
        Returns (ok, err).

        v1.7.8: rides the caller's push-leg connection (conn=), and
        its errors are stage-tagged as PUSH-stage failures — both its
        read and its write belong to landing the push.
        """
        import hashlib

        repo = self.GAME_REPO
        raw, err = github_sync.fetch_file(
            repo, "detailed/ui-manifest.json", conn=conn)
        if raw is None:
            return False, (f"Push to GitHub failed: could not read "
                           f"ui-manifest.json ({err})")
        try:
            doc = _json.loads(raw.decode("utf-8"))
            files = [e for e in doc.get("files", [])
                     if isinstance(e, dict)]
        except Exception as e:
            return False, (f"Push to GitHub failed: ui-manifest.json "
                           f"is unreadable ({e})")
        by_name = {e.get("name"): e for e in files}
        for n in deleted:
            by_name.pop(n, None)
        for n in pushed_names:
            if n == "ui-manifest.json":
                continue  # the manifest never lists itself
            b = staged_bytes(n)
            if b is None:
                continue
            digest = hashlib.sha256(b).hexdigest()
            entry = by_name.get(n, {})
            entry.update({"name": n, "size": len(b),
                          "sha256": digest, "hash": digest})
            by_name[n] = entry
        # Preserve the repo's entry order; append genuinely new
        # files at the end, in push order.
        ordered, seen = [], set()
        for e in files:
            name = e.get("name")
            if name in by_name and name not in seen:
                ordered.append(by_name[name])
                seen.add(name)
        for n in pushed_names:
            if n in by_name and n not in seen:
                ordered.append(by_name[n])
                seen.add(n)
        doc["files"] = ordered
        payload = _json.dumps(doc, indent=2).encode("utf-8")
        ok, msg = github_sync.push_file(
            repo, "detailed/ui-manifest.json", payload,
            "UI editor: update ui-manifest.json", conn=conn)
        if not ok:
            return False, f"Push to GitHub failed: ui-manifest.json: {msg}"
        return True, None

    def _round_trip_default_done(self, ok, err, fresh):
        """
        Default round-trip completion (app-level pushes and the
        auto-push): update the status bar, refresh the Resources
        list, and show the GitHub copies in the Layout/Menus tabs —
        unless a tab has unsaved edits in progress, in which case
        its view is left alone (its cache already holds the GitHub
        bytes; the tab itself says what it is showing).
        """
        if not ok:
            # v1.7.8: err is already a complete stage-accurate
            # sentence from _round_trip_run (it names whether the
            # PUSH failed or the push landed and only the proof
            # download failed) — show it as-is; wrapping it in
            # "Push failed:" would mislabel the download case.
            self.set_status(err)
            return
        if pending_count() == 0:
            self._unpublished = False
        if fresh:
            layout_tab = getattr(self, "layout_tab", None)
            if (layout_tab is not None
                    and "ui_layout.json" in fresh
                    and not layout_tab._dirty):
                layout_tab.apply_github_layout(fresh["ui_layout.json"])
            menu_tab = getattr(self, "menu_tab", None)
            if (menu_tab is not None
                    and "menu_layout.json" in fresh
                    and not menu_tab._dirty):
                menu_tab.apply_github_menus(fresh["menu_layout.json"])
        self.refresh_list()
        self.set_status("Pushed to GitHub ✓ — showing the GitHub copies")

    def on_settings_clicked(self, widget):
        """
        Settings: GitHub API key management (changeable in-app, no
        reinstall needed). Shared across all suite apps.
        """
        def on_key_changed(key_set):
            if key_set:
                self.set_status("GitHub API key saved — auto-push enabled.")
                if self._unpublished:
                    # Token just set with work pending: round trip it.
                    self.round_trip_save()
            else:
                self.set_status("GitHub API key removed — manual push only.")
        github_sync.show_settings_dialog(self.window, on_key_changed)

    def _show_close_warning(self):
        """
        Ask what to do with unpublished changes on window close.
        Returns "push", "close", or "cancel".
        (Joshua 2026-10-11 — safety net only, no auto-push.)
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
        Push everything pending to GitHub (GLOBAL SAVE PROTOCOL
        step 2+3, v1.7.7): with a token set this runs the round
        trip — push all staged files and removals, then re-download
        and display the GitHub state.

        Without a token the app cannot push itself, so it falls
        back to the manual package dialog: the payload is shown
        with Copy/Download options — Joshua sends it to Mollie,
        who applies it to the game repo. Same protocol as the map
        and terrain editors.
        """

        # API round trip first if a token is set.
        if github_sync.has_token():
            self.round_trip_save()
            return
        # No token: fall through to the manual copy/download dialog.

        payload = export_payload()
        if payload is None:
            self.set_status("No changes to push.")
            return
        n_add = len(payload["added"])
        n_rem = len(payload["removed"])

        dialog = Gtk.Dialog(title="Push Changes to GitHub",
                            parent=self.window,
                            flags=Gtk.DialogFlags.MODAL)
        dialog.set_default_size(560, 460)
        content = dialog.get_content_area()

        info = Gtk.Label()
        info.set_markup(
            f"<b>{n_add}</b> file(s) to add, "
            f"<b>{n_rem}</b> file(s) to remove.\n\n"
            "Copy the package below and send it to Mollie — she applies "
            "it to the game repo (updates ui-manifest.json, "
            "ui_layout.json, menu_layout.json, and any other edited "
            "files).")
        info.set_line_wrap(True)
        content.pack_start(info, False, False, 8)

        # Payload preview (summary only — full JSON can be large)
        preview = {"added": [{"name": a["name"], "size": a["size"]}
                             for a in payload["added"]],
                   "removed": payload["removed"],
                   "target_repo": payload["target_repo"],
                   "target_dir": payload["target_dir"],
                   "_note": "Full package (with file data) is in the "
                            "copied/downloaded JSON."}
        text = Gtk.TextView()
        text.set_editable(False)
        text.set_monospace(True)
        text.set_wrap_mode(Gtk.WrapMode.WORD)
        text.get_buffer().set_text(_json.dumps(preview, indent=2))
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_min_content_height(200)
        scrolled.add(text)
        content.pack_start(scrolled, True, True, 0)

        # Buttons: copy, download, clear-after-push, close
        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        copy_btn = Gtk.Button(label="Copy JSON")
        dl_btn = Gtk.Button(label="Download JSON")
        clear_btn = Gtk.Button(label="Clear After Push")
        clear_btn.set_tooltip_text(
            "Only click this AFTER Mollie confirms the changes are applied "
            "— it clears your local pending list.")
        close_btn = Gtk.Button(label="Close")
        for b in (copy_btn, dl_btn, clear_btn):
            btn_box.pack_start(b, False, False, 0)
        btn_box.pack_end(close_btn, False, False, 0)
        content.pack_start(btn_box, False, False, 8)

        full_json = _json.dumps(payload)

        def on_copy(w):
            clip = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            clip.set_text(full_json, -1)
            self.set_status("Push package copied to clipboard")

        def on_download(w):
            chooser = Gtk.FileChooserDialog(
                title="Save push package", parent=dialog,
                action=Gtk.FileChooserAction.SAVE)
            chooser.add_buttons(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
                                Gtk.STOCK_SAVE, Gtk.ResponseType.OK)
            chooser.set_current_name("ui_changes.json")
            if chooser.run() == Gtk.ResponseType.OK:
                with open(chooser.get_filename(), "w") as f:
                    f.write(full_json)
                self.set_status(f"Saved to {chooser.get_filename()}")
            chooser.destroy()

        def on_clear(w):
            confirm = Gtk.MessageDialog(
                parent=dialog, flags=Gtk.DialogFlags.MODAL,
                type=Gtk.MessageType.QUESTION,
                buttons=Gtk.ButtonsType.OK_CANCEL,
                message_format="Clear pending changes?")
            confirm.format_secondary_text(
                "Only do this after Mollie confirms the push was applied "
                "to the game repo.")
            if confirm.run() == Gtk.ResponseType.OK:
                clear_changes_after_push()
                self.refresh_list()
                self.set_status("Pending changes cleared")
                dialog.destroy()
            confirm.destroy()

        copy_btn.connect("clicked", on_copy)
        dl_btn.connect("clicked", on_download)
        clear_btn.connect("clicked", on_clear)
        close_btn.connect("clicked", lambda w: dialog.destroy())

        dialog.show_all()
        dialog.run()
        dialog.destroy()

    # ------------------------------------------------------------------
    # Status bar
    # ------------------------------------------------------------------

    def set_status(self, text):
        """Replace the status bar message."""
        # v1.7.4 STATUSBAR FIX (2026-10-12): guard against being called
        # before the status bar exists (e.g. MenuTab.__init__ runs during
        # UIEditorApp.__init__, before widgets are fully built). Silently
        # skip instead of raising AttributeError and killing the app.
        sb = getattr(self, "statusbar", None)
        ctx = getattr(self, "status_ctx", None)
        if sb is None or ctx is None:
            return
        sb.pop(ctx)
        sb.push(ctx, text)

    def update_status(self):
        """Show resource count and pending change count."""
        n = len(self.resources)
        p = pending_count()
        pending = f" · {p} pending change(s)" if p else ""
        self.set_status(f"{n} resources{pending}")


def main():
    """Application entry point."""
    # v1.7.3 (Joshua 2026-10-12): crash logger. If the editor fails to
    # start on Joshua's machine, the traceback is written to
    # ~/.cache/adamsville-ui-editor-native/crash.log so the real cause
    # can be diagnosed instead of failing silently.
    try:
        ensure_data_dir()
        app = UIEditorApp()
        Gtk.main()
    except Exception:
        try:
            import traceback
            log_dir = Path.home() / ".cache" / "adamsville-ui-editor-native"
            log_dir.mkdir(parents=True, exist_ok=True)
            with open(log_dir / "crash.log", "w") as f:
                f.write("Adamsville UI Editor %s crash log\n" % APP_VERSION)
                traceback.print_exc(file=f)
        except Exception:
            pass
        raise


if __name__ == "__main__":
    main()
