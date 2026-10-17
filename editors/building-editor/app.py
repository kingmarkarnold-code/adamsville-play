#!/usr/bin/env python3
"""
Adamsville Asset Editor (Native) — Main application.

Native GTK3 asset editor for the Surviving Adamsville 3D World Gaming
Suite. v1 is a first-state model: framework + buildings tab.
Vehicles and characters tabs come in later versions.

Layout per tab:
  - Left: isometric Cairo building preview (drag to rotate)
  - Right: properties panel (name, type, materials, colors, floors,
    walkable, position, rotation, windows/doors, stock library)

Tab system: Gtk.Notebook, Firefox-style. Each tab is one open building.
"+" button opens the building picker; "x" on each tab closes it.

Joshua's rule: all code commented.
"""

import json
import math
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

import github_sync  # noqa: E402 -- suite auto-push + close warning
from about import show_about_dialog
# v1.5.2 (Joshua 2026-10-12): soft import for updater — if updater.py is
# missing or broken (partial install, failed in-place update), the editor
# must still open. The Help -> Check for Updates item is only added when
# the import succeeds.
try:
    import updater  # noqa: E402 -- Help -> Check for Updates (in-place updater)
    _UPDATER_AVAILABLE = True
except Exception:
    updater = None
    _UPDATER_AVAILABLE = False
import data
# v1.6.0: the game zone data layer (per-zone converted building files
# in adamsville-play + the round-trip save). Soft import like the
# updater's: a broken zonedata must never stop the editor opening.
try:
    import zonedata  # noqa: E402
    _ZONEDATA_AVAILABLE = True
except Exception:
    zonedata = None
    _ZONEDATA_AVAILABLE = False
from data import (BUILDING_TYPES, WALL_MATERIALS, ROOF_TEXTURES,
                  WINDOW_TYPES, DOOR_TYPES, FLOOR_PLAN_TEMPLATES,
                  HOUSE_STYLES, DRIVEWAY_MATERIALS, GARAGE_SIDES,
                  FENCE_STYLES, FLOOR_TYPES, DECORATION_TYPES,
                  DECORATION_WALL_TYPES, PARKING_TYPE_LABELS,
                  PARKING_SPACE_ORIENTATIONS, RESIDENTIAL_TYPES,
                  garage_space_ok)
from buildingcanvas import BuildingCanvas
from subdivisioncanvas import SubdivisionCanvas


# App version shown in the Help -> About dialog (bump with each release).
# Joshua 2026-10-11: version number must be prominent in About.
APP_VERSION = "1.6.0"
# Display name and icon-theme name for the About dialog.
APP_NAME = "Adamsville Building Editor"
APP_ICON = "adamsville-building-editor-native"
APP_PACKAGE = "adamsville-building-editor-native"
# In-place updater (Joshua 2026-10-12): Help -> Check for
# Updates downloads new editor files from GitHub and applies
# them in place, so reinstalling the .deb is not needed.
UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/kingmarkarnold-code/adamsville-play/main/editors/building-editor/version.json"
UPDATE_SLUG = "building-editor"



# ---------------------------------------------------------------------------
# Application window
# ---------------------------------------------------------------------------

class AssetEditorWindow(Gtk.Window):
    """Main window: menu bar, notebook tabs, status bar."""

    def __init__(self):
        """Build the window, menus, notebook, and status bar."""
        super().__init__(title="Adamsville Building Editor")
        self.set_default_size(1100, 700)

        # All loaded buildings (list of dicts)
        self.buildings = []
        # v1.6.0: game zone store (zonedata.GameStore) + its tab.
        # Populated by download-on-open in _load_zone_data().
        self.zone_store = None
        self.zone_tab = None
        # Tabs: list of (building_dict,) currently open
        self.open_tabs = []

        # Unpublished-changes tracking (Joshua 2026-10-11).
        self._unpublished = False
        self._token_prompted = False
        # Word-style auto-push: every 5 minutes if unpublished + token.
        from gi.repository import GLib as _GLib
        _GLib.timeout_add_seconds(300, self._auto_push_tick)

        # --- Main vertical layout ---
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.add(vbox)

        # --- Menu bar ---
        vbox.pack_start(self._build_menubar(), False, False, 0)

        # --- Notebook (Firefox-style tabs) ---
        self.notebook = Gtk.Notebook()
        self.notebook.set_scrollable(True)  # scroll tabs if many open
        vbox.pack_start(self.notebook, True, True, 0)

        # --- Status bar ---
        self.status = Gtk.Statusbar()
        self.status_ctx = self.status.get_context_id("main")
        vbox.pack_start(self.status, False, False, 0)

        # --- Window geometry: restore, then track changes ---
        self._restore_geometry()
        self.connect("delete-event", self._on_close)
        self.connect("configure-event", self._on_configure)

        # --- Load building data (download prompt on first launch) ---
        self._load_data()
        # v1.6.0: download the game's per-zone building files and add
        # the Zone Buildings tab (runs on a worker thread; the tab
        # appears when the download lands).
        self._load_zone_data()

    # -- menus ----------------------------------------------------------

    def _build_menubar(self):
        """Build the File / Tabs / Help menu bar."""
        menubar = Gtk.MenuBar()

        # File menu
        file_menu = Gtk.Menu()
        file_item = Gtk.MenuItem(label="File")
        file_item.set_submenu(file_menu)

        dl = Gtk.MenuItem(label="Download Buildings from GitHub")
        dl.connect("activate", self._on_download)
        file_menu.append(dl)

        push = Gtk.MenuItem(label="Push to GitHub…")
        push.connect("activate", self._on_push)
        file_menu.append(push)

        settings_item = Gtk.MenuItem(label="Settings…")
        settings_item.connect("activate", self.on_settings_clicked)
        file_menu.append(settings_item)

        file_menu.append(Gtk.SeparatorMenuItem())

        quit_item = Gtk.MenuItem(label="Quit")
        quit_item.connect("activate", lambda w: self.destroy())
        file_menu.append(quit_item)
        menubar.append(file_item)

        # Tabs menu
        tabs_menu = Gtk.Menu()
        tabs_item = Gtk.MenuItem(label="Tabs")
        tabs_item.set_submenu(tabs_menu)

        new_tab = Gtk.MenuItem(label="Open Building…")
        new_tab.connect("activate", self._on_open_building)
        tabs_menu.append(new_tab)

        close_tab = Gtk.MenuItem(label="Close Current Tab")
        close_tab.connect("activate", self._on_close_tab)
        tabs_menu.append(close_tab)

        tabs_menu.append(Gtk.SeparatorMenuItem())

        # Subdivisions: 2D map for defining house-spawn areas
        # (Joshua 2026-10-11)
        sub_tab = Gtk.MenuItem(label="Subdivisions…")
        sub_tab.connect("activate", self._on_open_subdivisions)
        tabs_menu.append(sub_tab)
        menubar.append(tabs_item)

        # Help menu
        help_menu = Gtk.Menu()
        help_item = Gtk.MenuItem(label="Help")
        help_item.set_submenu(help_menu)

        # v1.5.2: only offer in-place updates when updater.py imported OK.
        # (A missing/broken updater must never stop the editor opening.)
        if _UPDATER_AVAILABLE:
            update_item = Gtk.MenuItem(label="Check for Updates")
            update_item.connect("activate", self.on_check_updates)
            help_menu.append(update_item)

        about = Gtk.MenuItem(label="About")
        about.connect("activate", self._on_about)
        help_menu.append(about)
        menubar.append(help_item)

        return menubar

    # -- data loading ---------------------------------------------------

    def _load_data(self):
        """
        Load buildings: check if a download is needed, prompt Joshua
        on first launch, then load from cache (or built-in defaults).
        """
        needed, reason = data.needs_download()
        if needed:
            # Ask Joshua whether to download now
            dlg = Gtk.MessageDialog(
                transient_for=self,
                message_type=Gtk.MessageType.QUESTION,
                buttons=Gtk.ButtonsType.YES_NO,
                text="Download building data?")
            dlg.format_secondary_text(reason)
            resp = dlg.run()
            dlg.destroy()
            if resp == Gtk.ResponseType.YES:
                if data.download_buildings():
                    self._set_status("Downloaded buildings from GitHub.")
                else:
                    self._set_status(
                        "Download failed — using built-in samples.")
            else:
                self._set_status("Using local/built-in building data.")
        self.buildings = data.load_buildings()
        self._set_status(f"Loaded {len(self.buildings)} buildings.")
        # Road data for collision checks + preview context (Joshua
        # 2026-10-11). Silent download on first run — auxiliary data.
        self.road_index = []
        try:
            self.road_index = data.get_road_index()
            if self.road_index:
                self._set_status(
                    f"Loaded {len(self.buildings)} buildings, "
                    f"{len(self.road_index)} roads.")
        except Exception:
            pass  # offline or failed — collision checks just skip

    # -- v1.6.0 game zone data -------------------------------------------

    def _load_zone_data(self):
        """
        Download-on-open for the GAME's building files (Joshua's
        standing rule): one fresh GitHub connection fetches every
        zone's buildings/detail/hero/zone/roads files plus the
        editor subdivisions file from adamsville-play, then the
        connection is closed. Runs on a worker thread; the Zone
        Buildings tab is added on the GTK thread when it lands.
        """
        if not _ZONEDATA_AVAILABLE:
            return
        import threading
        from gi.repository import GLib

        def worker():
            store = zonedata.GameStore()
            conn = github_sync.open_connection()
            try:
                def fetch(repo, path, conn=conn):
                    return github_sync.fetch_file(repo, path, conn=conn)
                errors = store.download_on_open(fetch)
            except Exception as e:
                errors = {"all zones": str(e)}
            finally:
                conn.close()

            def done():
                self.zone_store = store
                self.zone_tab = ZoneBuildingsTab(self)
                label = Gtk.Label(label="Zone Buildings (game data)")
                self.notebook.append_page(self.zone_tab, label)
                self.zone_tab.show_all()
                loaded = len(store.zones)
                if errors:
                    self._set_status(
                        f"Zone data: {loaded} zones loaded; failed: "
                        + ", ".join(sorted(errors)))
                else:
                    total = sum(len(z.boxes) for z in store.zones.values())
                    self._set_status(
                        f"Zone data loaded from GitHub: {loaded} zones, "
                        f"{total} buildings.")
                # Subdivisions from the game repo replace the local
                # working copy when a subdivisions tab exists.
                return False
            GLib.idle_add(done)

        threading.Thread(target=worker, daemon=True).start()

    def round_trip_save(self):
        """
        THE save for zone data + subdivisions (v1.6.0): Joshua's
        standing round trip, delegated to zonedata.GameStore —
        local save -> push on one connection -> close -> re-download
        on a fresh connection -> refresh the view from the proof
        copy. Stage-accurate failure messages come back verbatim.
        Returns True when a round trip started.
        """
        if self.zone_store is None:
            self._set_status("Zone data has not loaded yet.")
            return False
        if not github_sync.has_token():
            self._set_status(
                "No GitHub token — changes are saved on this computer "
                "only. Set one in File → Settings to push.")
            return False
        import threading
        from gi.repository import GLib
        self._set_status("Saving to GitHub…")

        def worker():
            ok, msg, _fresh = self.zone_store.round_trip_save(
                data.DATA_DIR / "zone-cache",
                github_sync.open_connection,
                github_sync.push_targets,
                github_sync.fetch_file)

            def done():
                if ok:
                    self._unpublished = False
                    if self.zone_tab is not None:
                        self.zone_tab.refresh()
                self._set_status(msg if ok else f"Save failed: {msg}")
                return False
            GLib.idle_add(done)

        threading.Thread(target=worker, daemon=True).start()
        return True

    def _on_download(self, widget):
        """Menu action: force a re-download from GitHub."""
        if data.download_buildings():
            self.buildings = data.load_buildings()
            self._set_status(
                f"Downloaded. {len(self.buildings)} buildings loaded.")
        else:
            self._set_status("Download failed. Check your connection.")

    # -- tab management -------------------------------------------------

    def _on_open_building(self, widget=None):
        """
        Show the building picker dialog, then open the chosen
        building in a new tab (or focus its tab if already open).
        """
        if not self.buildings:
            self._set_status("No buildings loaded.")
            return

        # Build a simple list dialog
        dlg = Gtk.Dialog(title="Open Building", transient_for=self,
                         flags=0)
        dlg.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dlg.add_button("Open", Gtk.ResponseType.OK)
        dlg.set_default_size(320, 380)

        store = Gtk.ListStore(str)
        for b in self.buildings:
            store.append([b.get("name", "Unnamed")])
        tree = Gtk.TreeView(model=store)
        col = Gtk.TreeViewColumn("Building",
                                 Gtk.CellRendererText(), text=0)
        tree.append_column(col)
        tree.get_selection().set_mode(Gtk.SelectionMode.SINGLE)
        # Double-click a row to open immediately
        tree.connect("row-activated",
                     lambda tv, path, col: dlg.response(Gtk.ResponseType.OK))

        scrolled = Gtk.ScrolledWindow()
        scrolled.add(tree)
        dlg.get_content_area().pack_start(scrolled, True, True, 0)
        dlg.show_all()

        resp = dlg.run()
        sel = tree.get_selection().get_selected()
        dlg.destroy()

        if resp != Gtk.ResponseType.OK or not sel or not sel[1]:
            return
        name = store[sel[1]][0]
        building = next((b for b in self.buildings
                         if b.get("name") == name), None)
        if building:
            self.open_building_tab(building)

    def open_building_tab(self, building):
        """
        Open a building in a new tab. If it's already open, just
        switch to that tab.
        """
        # Already open? Switch to it.
        for i, tab in enumerate(self.open_tabs):
            if tab.building is building:
                self.notebook.set_current_page(i)
                return

        tab = BuildingTab(self, building)
        self.open_tabs.append(tab)

        # Tab label with close button (Firefox-style "x")
        label_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                            spacing=4)
        label = Gtk.Label(label=building.get("name", "Unnamed"))
        close_btn = Gtk.Button(label="×")
        close_btn.set_relief(Gtk.ReliefStyle.NONE)
        close_btn.set_focus_on_click(False)
        # Capture the tab object for the close handler
        close_btn.connect("clicked",
                          lambda w, t=tab: self.close_tab(t))
        label_box.pack_start(label, True, True, 0)
        label_box.pack_start(close_btn, False, False, 0)
        label_box.show_all()

        page_num = self.notebook.append_page(tab, label_box)
        self.notebook.set_current_page(page_num)
        self.notebook.show_all()
        self._set_status(f"Opened '{building.get('name')}'.")

    def close_tab(self, tab):
        """Close one tab and drop it from the open list."""
        page = self.notebook.page_num(tab)
        if page >= 0:
            self.notebook.remove_page(page)
        if tab in self.open_tabs:
            self.open_tabs.remove(tab)
        self._set_status("Tab closed.")

    def _on_close_tab(self, widget):
        """Menu action: close the currently visible tab."""
        page = self.notebook.get_current_page()
        if 0 <= page < len(self.open_tabs):
            self.close_tab(self.open_tabs[page])

    def _on_open_subdivisions(self, widget=None):
        """
        Open the Subdivisions tab (2D map). Only one instance —
        switches to it if already open.
        """
        for i, tab in enumerate(self.open_tabs):
            if isinstance(tab, SubdivisionTab):
                self.notebook.set_current_page(i)
                return
        tab = SubdivisionTab(self)
        self.open_tabs.append(tab)

        label_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                            spacing=4)
        label = Gtk.Label(label="Subdivisions")
        close_btn = Gtk.Button(label="×")
        close_btn.set_relief(Gtk.ReliefStyle.NONE)
        close_btn.set_focus_on_click(False)
        close_btn.connect("clicked",
                          lambda w, t=tab: self.close_tab(t))
        label_box.pack_start(label, True, True, 0)
        label_box.pack_start(close_btn, False, False, 0)
        label_box.show_all()

        page_num = self.notebook.append_page(tab, label_box)
        self.notebook.set_current_page(page_num)
        self.notebook.show_all()
        self._set_status("Subdivisions map opened.")
        # Zone-first workflow (v1.2.0): ask which zone to work in
        # once the tab is on screen.
        GLib.idle_add(tab.maybe_show_zone_picker)

    # -- push to GitHub (copy/download JSON protocol) -------------------

    def _on_push(self, widget):
        """
        Show the push dialog with the export payload as JSON.
        Joshua copies it or downloads it; Mollie applies it to the repo.
        (No GitHub token is stored in the app — same protocol as the
        sibling editors.)
        """

        # Word-style: try API push first if token is set.
        if github_sync.has_token():
            self._do_push(silent=False)
            return
        # No token: fall through to the manual copy/download dialog.

        payload = data.export_payload()
        text = json.dumps(payload, indent=2)

        dlg = Gtk.Dialog(title="Push to GitHub", transient_for=self,
                         flags=0)
        dlg.add_button("Close", Gtk.ResponseType.CLOSE)
        dlg.set_default_size(560, 420)

        info = Gtk.Label(
            label="Copy this JSON or download it, then send it to Mollie "
                  "to apply to the GitHub repo.")
        info.set_line_wrap(True)
        dlg.get_content_area().pack_start(info, False, False, 6)

        scrolled = Gtk.ScrolledWindow()
        tv = Gtk.TextView()
        tv.get_buffer().set_text(text)
        tv.set_editable(False)
        tv.set_monospace(True)
        scrolled.add(tv)
        dlg.get_content_area().pack_start(scrolled, True, True, 0)

        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                          spacing=6)

        copy_btn = Gtk.Button(label="Copy to Clipboard")
        def _copy(w):
            clip = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            clip.set_text(text, -1)
            self._set_status("Payload copied to clipboard.")
        copy_btn.connect("clicked", _copy)
        btn_box.pack_start(copy_btn, False, False, 0)

        dl_btn = Gtk.Button(label="Download JSON")
        def _download(w):
            chooser = Gtk.FileChooserDialog(
                title="Save payload", transient_for=dlg,
                action=Gtk.FileChooserAction.SAVE)
            chooser.add_button("Cancel", Gtk.ResponseType.CANCEL)
            chooser.add_button("Save", Gtk.ResponseType.OK)
            chooser.set_current_name("asset_push.json")
            if chooser.run() == Gtk.ResponseType.OK:
                with open(chooser.get_filename(), "w") as f:
                    f.write(text)
                self._set_status("Payload saved.")
            chooser.destroy()
        dl_btn.connect("clicked", _download)
        btn_box.pack_start(dl_btn, False, False, 0)

        dlg.get_content_area().pack_start(btn_box, False, False, 6)
        dlg.show_all()
        dlg.run()
        dlg.destroy()

    # -- help / about ----------------------------------------------------

    def _on_about(self, widget):
        """Show the About dialog (app icon + Mollie icon + credits)."""
        # Note: this window IS the parent (AssetEditorWindow subclasses
        # Gtk.Window), so pass self directly.
        show_about_dialog(self, APP_NAME, APP_VERSION,
                          APP_ICON, APP_PACKAGE)

    def on_check_updates(self, widget):
        """Help -> Check for Updates: in-place update flow."""
        # (Joshua 2026-10-12: update the installed app in
        # place instead of reinstalling the .deb.)
        # v1.5.2: guard — this handler is only wired when the updater
        # imported successfully, but never trust the menu state.
        if not _UPDATER_AVAILABLE or updater is None:
            return
        updater.check_for_updates_gui(
            self, APP_NAME, APP_VERSION,
            UPDATE_SLUG, UPDATE_MANIFEST_URL)

    # -- status bar / geometry -------------------------------------------

    def _set_status(self, msg):
        """Show a message in the status bar."""
        self.status.push(self.status_ctx, msg)

    def _restore_geometry(self):
        """Restore saved window size/position/maximized state."""
        st = data.load_window_state()
        if st:
            try:
                self.move(st.get("x", 100), st.get("y", 100))
                self.set_default_size(st.get("width", 1100),
                                      st.get("height", 700))
                if st.get("maximized"):
                    self.maximize()
            except Exception:
                pass  # corrupt state — fall back to defaults

    def _on_configure(self, widget, event):
        """Track window moves/resizes (saved on close)."""
        return False

    def _on_close(self, widget, event):
        """
        Save window geometry on close.
        If there are unpublished changes, ask Joshua what to do
        (Joshua 2026-10-11).
        """
        if self._unpublished:
            choice = self._show_close_warning()
            if choice == "cancel":
                return True  # don't close
            if choice == "push":
                self._on_push(None)
        try:
            maximized = self.is_maximized()
            x, y = self.get_position()
            w, h = self.get_size()
            data.save_window_state(x, y, w, h, maximized)
        except Exception:
            pass
        return False  # allow the window to close

    def _mark_unpublished(self):
        """Mark that local edits haven't been pushed yet."""
        self._unpublished = True
        if not github_sync.has_token() and not self._token_prompted:
            self._token_prompted = True
            if github_sync.show_first_save_prompt(self):
                self._do_push()

    def _show_close_warning(self):
        """
        Ask what to do with unpublished changes on window close.
        Returns "push", "close", or "cancel".
        """
        dialog = Gtk.MessageDialog(
            transient_for=self, flags=0,
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

    def _push_targets(self):
        """
        Build (repo, path, bytes, message) list.
        v1.6.0: ONLY game zone targets (dirty zones only, from the
        zonedata store) + the editor subdivisions file in
        adamsville-play. The 1.5.2 targets (buildings.json /
        subdivisions.json in the retired adamsville-map-editor repo)
        are GONE — that repo is no longer the source of truth, and
        the legacy detailed-asset sample set is never pushed over
        game data.
        """
        if self.zone_store is None:
            return []
        try:
            return self.zone_store.build_targets()
        except Exception:
            return []

    def _auto_push_tick(self):
        """5-minute auto-push timer. Returns True to keep running."""
        if self._unpublished and github_sync.has_token():
            self._do_push(silent=True)
        return True

    def _do_push(self, silent=True):
        """
        Save via the v1.6.0 round trip (see round_trip_save). The
        1.5.2 one-way push is replaced: a save is only done once the
        proof copy has been re-downloaded and shown.
        """
        if not github_sync.has_token():
            if not silent:
                self._set_status("No GitHub token — set one in File → Settings.")
            return False
        return self.round_trip_save()

    def on_settings_clicked(self, widget):
        """
        Settings: GitHub API key management (changeable in-app, no
        reinstall needed). Shared across all suite apps.
        """
        def on_key_changed(key_set):
            if key_set:
                self._set_status("GitHub API key saved — auto-push enabled.")
                if self._unpublished:
                    self._do_push(silent=False)
            else:
                self._set_status("GitHub API key removed — manual push only.")
        github_sync.show_settings_dialog(self, on_key_changed)



# ---------------------------------------------------------------------------
# v1.6.0: Zone Buildings tab — the game's actual building data
# ---------------------------------------------------------------------------

class ZoneBuildingsTab(Gtk.Box):
    """
    Zone-by-zone view of the game's converted building files
    (zonedata.GameStore). Shows, per zone: building count, the
    read-only hero buildings list, and the buildings themselves
    (first rows + FLAGGED markers). Placement / move / resize /
    delete go through zonedata, so zone attribution (bounds),
    box/detail alignment, and the flagged lock are enforced by the
    same code the harness tests. Saving is the window's round trip.
    """

    # Rows shown in the list (zones hold tens of thousands of
    # buildings; the list is a working window, not a full dump).
    ROW_CAP = 1000

    def __init__(self, window):
        """window: the AssetEditorWindow (store + status access)."""
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.set_border_width(8)
        self.app_window = window
        self._zone = "adamsville"

        # --- Zone picker + save -------------------------------------
        top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        top.pack_start(Gtk.Label(label="Zone:"), False, False, 0)
        self.zone_combo = Gtk.ComboBoxText()
        if _ZONEDATA_AVAILABLE:
            for z in zonedata.ZONES:
                self.zone_combo.append_text(z)
        self.zone_combo.set_active(0)
        self.zone_combo.connect("changed", self._on_zone_changed)
        top.pack_start(self.zone_combo, False, False, 0)
        save_btn = Gtk.Button(label="Save to GitHub (round trip)")
        save_btn.connect("clicked", lambda w: window.round_trip_save())
        top.pack_start(save_btn, False, False, 6)
        self.info_label = Gtk.Label(label="")
        self.info_label.set_halign(Gtk.Align.START)
        top.pack_start(self.info_label, True, True, 6)
        self.pack_start(top, False, False, 0)

        # --- Hero buildings (read-only listing) ----------------------
        hero_lbl = Gtk.Label()
        hero_lbl.set_markup("<b>Hero buildings (read-only)</b>")
        hero_lbl.set_halign(Gtk.Align.START)
        self.pack_start(hero_lbl, False, False, 2)
        self.hero_store = Gtk.ListStore(str, str, str)
        hero_tree = Gtk.TreeView(model=self.hero_store)
        for i, title in enumerate(("ID", "Name", "Address")):
            hero_tree.append_column(Gtk.TreeViewColumn(
                title, Gtk.CellRendererText(), text=i))
        hero_scroll = Gtk.ScrolledWindow()
        hero_scroll.set_min_content_height(60)
        hero_scroll.add(hero_tree)
        self.pack_start(hero_scroll, False, False, 0)

        # --- Buildings list -------------------------------------------
        b_lbl = Gtk.Label()
        b_lbl.set_markup("<b>Buildings</b> (FLAGGED = locked, awaiting "
                         "Joshua's decision)")
        b_lbl.set_halign(Gtk.Align.START)
        self.pack_start(b_lbl, False, False, 2)
        self.store = Gtk.ListStore(int, str, str, str)
        self.tree = Gtk.TreeView(model=self.store)
        for i, title in enumerate(("#", "Name", "Type", "Flagged")):
            self.tree.append_column(Gtk.TreeViewColumn(
                title, Gtk.CellRendererText(), text=i))
        self.tree.get_selection().connect("changed",
                                          self._on_select)
        scroll = Gtk.ScrolledWindow()
        scroll.set_min_content_height(180)
        scroll.add(self.tree)
        self.pack_start(scroll, True, True, 0)

        # --- Edit selected: move / resize / delete ---------------------
        edit = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.mx = Gtk.SpinButton.new_with_range(-20000, 20000, 1)
        self.mz = Gtk.SpinButton.new_with_range(-20000, 20000, 1)
        self.mw = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.md = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.mh = Gtk.SpinButton.new_with_range(1, 200, 1)
        for label, spin in (("x", self.mx), ("z", self.mz),
                            ("w", self.mw), ("d", self.md),
                            ("h", self.mh)):
            edit.pack_start(Gtk.Label(label=label), False, False, 0)
            edit.pack_start(spin, False, False, 0)
        move_btn = Gtk.Button(label="Move / Resize Selected")
        move_btn.connect("clicked", self._on_move_resize)
        edit.pack_start(move_btn, False, False, 4)
        del_btn = Gtk.Button(label="Delete Selected")
        del_btn.connect("clicked", self._on_delete)
        edit.pack_start(del_btn, False, False, 0)
        self.pack_start(edit, False, False, 2)

        # --- Place a new building ---------------------------------------
        place = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.px = Gtk.SpinButton.new_with_range(-20000, 20000, 1)
        self.pz = Gtk.SpinButton.new_with_range(-20000, 20000, 1)
        self.pw = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.pd = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.ph = Gtk.SpinButton.new_with_range(1, 200, 1)
        self.pw.set_value(24); self.pd.set_value(18); self.ph.set_value(5)
        for label, spin in (("x", self.px), ("z", self.pz),
                            ("w", self.pw), ("d", self.pd),
                            ("h", self.ph)):
            place.pack_start(Gtk.Label(label=label), False, False, 0)
            place.pack_start(spin, False, False, 0)
        self.ptype = Gtk.ComboBoxText()
        if _ZONEDATA_AVAILABLE:
            for t in zonedata.EDITOR_TYPE_MAP:
                self.ptype.append_text(t)
        self.ptype.set_active(0)
        place.pack_start(self.ptype, False, False, 0)
        self.pname = Gtk.Entry()
        self.pname.set_placeholder_text("Name (optional)")
        place.pack_start(self.pname, True, True, 0)
        place_btn = Gtk.Button(label="Place Building")
        place_btn.connect("clicked", self._on_place)
        place.pack_start(place_btn, False, False, 0)
        self.pack_start(place, False, False, 2)

        self.refresh()

    # -- helpers ---------------------------------------------------------

    def _zd(self):
        """The current zone's ZoneData, or None."""
        store = self.app_window.zone_store
        return store.zones.get(self._zone) if store else None

    def _selected_index(self):
        """Index (into the zone's arrays) of the selected row."""
        sel = self.tree.get_selection()
        model, it = sel.get_selected()
        if it is None:
            return None
        return model.get_value(it, 0)

    def refresh(self):
        """Repopulate hero + building lists from the store."""
        self.hero_store.clear()
        self.store.clear()
        zd = self._zd()
        if zd is None:
            self.info_label.set_text("Zone data not loaded.")
            return
        store = self.app_window.zone_store
        flagged_n = 0
        for hb in zd.hero_list():
            self.hero_store.append([hb["id"] or "", hb["name"] or "",
                                    hb["address"] or ""])
        for i, (box, det) in enumerate(zip(zd.boxes, zd.details)):
            if i >= self.ROW_CAP:
                break
            is_flag = store.flagged.match(
                self._zone, det.get("ring") or []) is not None
            flagged_n += 1 if is_flag else 0
            self.store.append([i, det.get("name") or "",
                               zonedata.CODE_LABELS.get(box[5], "?"),
                               "FLAGGED" if is_flag else ""])
        self.info_label.set_text(
            f"{self._zone}: {len(zd.boxes)} buildings, "
            f"{len(zd.hero_list())} hero, "
            f"{store.flagged.count(self._zone)} flagged in zone "
            f"(showing first {min(self.ROW_CAP, len(zd.boxes))} rows)"
            + (" — UNSAVED CHANGES" if zd.dirty else ""))

    # -- callbacks ---------------------------------------------------------

    def _on_zone_changed(self, combo):
        """Switch the working zone."""
        self._zone = combo.get_active_text() or self._zone
        self.refresh()

    def _on_select(self, selection):
        """Load the selected building's numbers into the edit spins."""
        idx = self._selected_index()
        zd = self._zd()
        if idx is None or zd is None or idx >= len(zd.boxes):
            return
        box = zd.boxes[idx]
        self.mx.set_value(box[0]); self.mz.set_value(box[1])
        self.mw.set_value(box[2]); self.md.set_value(box[3])
        self.mh.set_value(box[4])

    def _on_place(self, widget):
        """Place a building; zonedata attributes it to its zone and
        refuses placements outside all zones."""
        store = self.app_window.zone_store
        if store is None:
            return
        try:
            zone, idx = store.place_building(
                self.px.get_value(), self.pz.get_value(),
                self.pw.get_value(), self.pd.get_value(),
                self.ph.get_value(),
                self.ptype.get_active_text() or "House",
                self.pname.get_text().strip() or None)
        except Exception as e:
            self.app_window._set_status(str(e))
            return
        self.app_window._mark_unpublished()
        self._zone = zone
        self.zone_combo.set_active(zonedata.ZONES.index(zone))
        self.refresh()
        self.app_window._set_status(
            f"Placed building #{idx} in {zone} (unsaved until save).")

    def _on_move_resize(self, widget):
        """Move + resize the selected building (flagged = refused)."""
        store = self.app_window.zone_store
        zd = self._zd()
        idx = self._selected_index()
        if store is None or zd is None or idx is None:
            return
        try:
            zd.move(idx, self.mx.get_value(), self.mz.get_value(),
                    flagged=store.flagged)
            zd.resize(idx, self.mw.get_value(), self.md.get_value(),
                      self.mh.get_value(), flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            return
        self.app_window._mark_unpublished()
        self.refresh()
        self.app_window._set_status(f"Building #{idx} updated (unsaved).")

    def _on_delete(self, widget):
        """Delete the selected building (flagged = refused)."""
        store = self.app_window.zone_store
        zd = self._zd()
        idx = self._selected_index()
        if store is None or zd is None or idx is None:
            return
        try:
            zd.delete(idx, flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            return
        self.app_window._mark_unpublished()
        self.refresh()
        self.app_window._set_status(f"Building #{idx} deleted (unsaved).")


# ---------------------------------------------------------------------------
# One building tab: preview (left) + properties (right)
# ---------------------------------------------------------------------------

class BuildingTab(Gtk.Box):
    """
    A single open building: isometric preview on the left, scrollable
    properties panel on the right.
    """

    def __init__(self, window, building):
        """
        window: the AssetEditorWindow (for status messages).
        building: the building dict this tab edits (edited in place).
        """
        super().__init__(orientation=Gtk.Orientation.HORIZONTAL,
                         spacing=6)
        self.app_window = window
        self.building = building
        # Currently selected stock window/door type for placement
        self.pending_window_type = WINDOW_TYPES[0]
        self.pending_door_type = DOOR_TYPES[0]

        # --- Left: preview canvas ---
        left = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.canvas = BuildingCanvas()
        self.canvas.set_building(building)
        # Wire placement callbacks
        self.canvas.on_face_click = self._on_face_click
        self.canvas.on_item_click = self._on_item_click
        # Persist window/door positions after a drag (Joshua 2026-10-11)
        self.canvas.on_item_moved = self._on_item_moved
        # v1.1.0: decoration placement + fence drawing callbacks
        self.canvas.on_decoration_click = self._on_decoration_click
        self.canvas.on_fence_point = self._on_fence_point
        # v1.2.0: canvas-driven house move / pivot-rotate + fence edits
        self.canvas.on_transform_changed = (
            self._on_canvas_transform_changed)
        self.canvas.on_fence_edit = self._on_fence_edit
        # v1.5.0 (Joshua): parking placement + selection callbacks
        self.canvas.on_parking_click = self._on_parking_click
        self.canvas.on_parking_selected = self._on_parking_selected
        # Currently selected parking type for add_parking mode
        self.pending_parking_type = "lot"
        # Index into building["parking"] of the selected element
        # (None when nothing is selected)
        self.selected_parking = None
        # Currently selected decoration type for placement
        self.pending_decoration_type = DECORATION_TYPES[0]
        # Nearby roads for preview context + collision checks
        self.canvas.roads = window.road_index
        left.pack_start(self.canvas, True, True, 0)

        # Mode buttons under the canvas
        mode_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                           spacing=4)
        self.mode_buttons = {}
        for mode_id, label in (("view", "View"),
                               ("add_window", "Add Window"),
                               ("add_door", "Add Door"),
                               ("add_decoration", "Add Decoration"),
                               ("remove", "Remove")):
            btn = Gtk.ToggleButton(label=label)
            btn.connect("toggled", self._on_mode_toggled, mode_id)
            self.mode_buttons[mode_id] = btn
            mode_bar.pack_start(btn, False, False, 0)
        self.mode_buttons["view"].set_active(True)
        left.pack_start(mode_bar, False, False, 4)

        hint = Gtk.Label(
            label="Drag empty space to rotate — drag a window/door/"
                  "decoration to move it. Click a window to resize it.")
        hint.set_halign(Gtk.Align.START)
        left.pack_start(hint, False, False, 0)
        self.pack_start(left, True, True, 6)

        # --- Right: properties panel (scrollable) ---
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER,
                            Gtk.PolicyType.AUTOMATIC)
        scrolled.set_min_content_width(300)
        props = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        props.set_border_width(10)
        scrolled.add(props)
        self._build_properties(props)
        self.pack_start(scrolled, False, False, 6)

    # -- properties panel -------------------------------------------------

    def _row(self, parent, label_text, widget):
        """Add a labeled row to the properties panel."""
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        lbl = Gtk.Label(label=label_text)
        lbl.set_halign(Gtk.Align.START)
        lbl.set_size_request(110, -1)
        row.pack_start(lbl, False, False, 0)
        row.pack_start(widget, True, True, 0)
        parent.pack_start(row, False, False, 0)

    def _spin_row(self, parent, label_text, lo, hi, step, handler):
        """
        Build a labeled SpinButton row and return (row_box, spin).
        v1.5.0: used by the Parking property editors so rows can be
        shown/hidden per parking type.
        """
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        lbl = Gtk.Label(label=label_text)
        lbl.set_halign(Gtk.Align.START)
        lbl.set_size_request(110, -1)
        row.pack_start(lbl, False, False, 0)
        spin = Gtk.SpinButton.new_with_range(lo, hi, step)
        spin.connect("value-changed", handler)
        row.pack_start(spin, True, True, 0)
        parent.pack_start(row, False, False, 0)
        return row, spin

    def _combo_row(self, parent, label_text, options, handler):
        """
        Build a labeled ComboBoxText row and return (row_box, combo).
        v1.5.0: used by the Parking property editors.
        """
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        lbl = Gtk.Label(label=label_text)
        lbl.set_halign(Gtk.Align.START)
        lbl.set_size_request(110, -1)
        row.pack_start(lbl, False, False, 0)
        combo = Gtk.ComboBoxText()
        for opt in options:
            combo.append_text(opt)
        combo.connect("changed", handler)
        row.pack_start(combo, True, True, 0)
        parent.pack_start(row, False, False, 0)
        return row, combo
        return row

    def _section(self, parent, title):
        """Add a bold section header to the properties panel."""
        lbl = Gtk.Label()
        lbl.set_markup(f"<b>{title}</b>")
        lbl.set_halign(Gtk.Align.START)
        parent.pack_start(lbl, False, False, 4)

    def _build_properties(self, props):
        """Build all property controls, wired to the building dict."""
        b = self.building

        # --- Identity ---
        self._section(props, "Identity")
        name_entry = Gtk.Entry(text=b.get("name", ""))
        name_entry.connect("changed",
                           lambda e: self._update("name", e.get_text()))
        self._row(props, "Name:", name_entry)

        type_combo = Gtk.ComboBoxText()
        for t in BUILDING_TYPES:
            type_combo.append_text(t)
        cur_type = b.get("type", "House")
        if cur_type in BUILDING_TYPES:
            type_combo.set_active(BUILDING_TYPES.index(cur_type))
        # v1.5.0: routed through _on_type_changed so switching to a
        # residential type warns before removing a parking garage
        # (garages are commercial-only, Joshua 2026-10-11).
        self.type_combo = type_combo
        type_combo.connect("changed", self._on_type_changed)
        self._row(props, "Type:", type_combo)

        # --- Materials ---
        self._section(props, "Materials")
        mat_combo = Gtk.ComboBoxText()
        for m in WALL_MATERIALS:
            mat_combo.append_text(m)
        cur_mat = b.get("wall_material", "Brick")
        if cur_mat in WALL_MATERIALS:
            mat_combo.set_active(WALL_MATERIALS.index(cur_mat))
        mat_combo.connect("changed", lambda c: self._update(
            "wall_material", c.get_active_text()))
        self._row(props, "Wall material:", mat_combo)

        wall_color = Gtk.ColorButton()
        wall_color.set_rgba(self._hex_to_rgba(
            b.get("wall_color", "#c0c0c0")))
        wall_color.connect("color-set",
                           lambda w: self._update("wall_color",
                                                  self._rgba_to_hex(
                                                      w.get_rgba())))
        self._row(props, "Wall color:", wall_color)

        roof_color = Gtk.ColorButton()
        roof_color.set_rgba(self._hex_to_rgba(
            b.get("roof_color", "#5a3a2a")))
        roof_color.connect("color-set",
                           lambda w: self._update("roof_color",
                                                  self._rgba_to_hex(
                                                      w.get_rgba())))
        self._row(props, "Roof color:", roof_color)

        roof_combo = Gtk.ComboBoxText()
        for r in ROOF_TEXTURES:
            roof_combo.append_text(r)
        cur_roof = b.get("roof_texture", "Shingle")
        if cur_roof in ROOF_TEXTURES:
            roof_combo.set_active(ROOF_TEXTURES.index(cur_roof))
        roof_combo.connect("changed", lambda c: self._update(
            "roof_texture", c.get_active_text()))
        self._row(props, "Roof texture:", roof_combo)

        # --- Structure ---
        self._section(props, "Structure")
        floors_spin = Gtk.SpinButton.new_with_range(1, 5, 1)
        floors_spin.set_value(int(b.get("floors", 1)))
        floors_spin.connect("value-changed", lambda s: self._update(
            "floors", int(s.get_value())))
        self._row(props, "Floors:", floors_spin)

        # Add/Remove floor quick buttons
        floor_btns = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                             spacing=4)
        add_floor = Gtk.Button(label="+ Floor")
        add_floor.connect("clicked", lambda w: self._change_floors(1))
        rm_floor = Gtk.Button(label="− Floor")
        rm_floor.connect("clicked", lambda w: self._change_floors(-1))
        floor_btns.pack_start(add_floor, True, True, 0)
        floor_btns.pack_start(rm_floor, True, True, 0)
        self._row(props, "", floor_btns)

        # Footprint size in world units (Joshua 2026-10-11): used for
        # road-collision checks. The isometric preview stays schematic.
        w_spin = Gtk.SpinButton.new_with_range(10, 500, 5)
        w_spin.set_value(float(b.get("width", 40.0)))
        w_spin.connect("value-changed", lambda s: self._update(
            "width", float(s.get_value())))
        self._row(props, "Width (units):", w_spin)

        d_spin = Gtk.SpinButton.new_with_range(10, 500, 5)
        d_spin.set_value(float(b.get("depth", 40.0)))
        d_spin.connect("value-changed", lambda s: self._update(
            "depth", float(s.get_value())))
        self._row(props, "Depth (units):", d_spin)

        # Front (street-facing) face designation (Joshua 2026-10-11):
        # when houses auto-spawn in subdivisions, the game rotates each
        # house so this face points at the nearest/largest road.
        front_combo = Gtk.ComboBoxText()
        for ff in ("Front", "Back", "Left", "Right"):
            front_combo.append_text(ff)
        cur_front = b.get("front_face", "front")
        # Normalize stored value to the dropdown labels
        front_labels = {"front": "Front", "back": "Back",
                        "left": "Left", "right": "Right"}
        front_combo.set_active(
            ["Front", "Back", "Left", "Right"].index(
                front_labels.get(str(cur_front).lower(), "Front")))
        def _on_front_changed(c):
            # Store lowercase ("front"/"back"/"left"/"right")
            self._update("front_face",
                         c.get_active_text().lower())
        front_combo.connect("changed", _on_front_changed)
        self._row(props, "Front face:", front_combo)

        walk_check = Gtk.CheckButton(label="Walkable (enterable)")
        walk_check.set_active(bool(b.get("walkable", False)))
        walk_check.connect("toggled",
                           lambda w: self._on_walkable(w.get_active()))
        props.pack_start(walk_check, False, False, 0)

        # Floor plan templates (visible when walkable)
        self.floor_plan_box = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.floor_plan_box.set_no_show_all(True)
        fp_lbl = Gtk.Label(label="Floor plan:")
        fp_lbl.set_halign(Gtk.Align.START)
        fp_lbl.set_size_request(110, -1)
        self.floor_plan_box.pack_start(fp_lbl, False, False, 0)
        self.fp_combo = Gtk.ComboBoxText()
        for fp in FLOOR_PLAN_TEMPLATES:
            self.fp_combo.append_text(fp)
        cur_fp = b.get("floor_plan", "")
        if cur_fp in FLOOR_PLAN_TEMPLATES:
            self.fp_combo.set_active(FLOOR_PLAN_TEMPLATES.index(cur_fp))
        self.fp_combo.connect("changed", lambda c: self._update(
            "floor_plan", c.get_active_text() or ""))
        self.floor_plan_box.pack_start(self.fp_combo, True, True, 0)
        props.pack_start(self.floor_plan_box, False, False, 0)
        self.floor_plan_box.set_visible(bool(b.get("walkable", False)))

        # --- Placement ---
        self._section(props, "Placement")
        pos = b.get("position", [0, 0])
        # v1.2.0: instance attributes so canvas-driven moves/pivots
        # can sync these controls (see _on_canvas_transform_changed).
        self._syncing_ui = False
        self.x_spin = Gtk.SpinButton.new_with_range(-10000, 10000, 10)
        self.x_spin.set_value(float(pos[0]) if len(pos) > 0 else 0)
        self.x_spin.connect("value-changed",
                            lambda s: self._update_pos(0, s.get_value()))
        self._row(props, "Position X:", self.x_spin)

        self.z_spin = Gtk.SpinButton.new_with_range(-10000, 10000, 10)
        self.z_spin.set_value(float(pos[1]) if len(pos) > 1 else 0)
        self.z_spin.connect("value-changed",
                            lambda s: self._update_pos(1, s.get_value()))
        self._row(props, "Position Z:", self.z_spin)

        self.rot_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, 0, 360, 5)
        self.rot_scale.set_value(float(b.get("rotation", 0.0)))
        self.rot_scale.set_hexpand(True)
        self.rot_scale.connect("value-changed", lambda s: self._update(
            "rotation", float(s.get_value())))
        self._row(props, "Rotation:", self.rot_scale)

        # --- Stock library ---
        self._section(props, "Stock Library")
        win_combo = Gtk.ComboBoxText()
        for wt in WINDOW_TYPES:
            win_combo.append_text(wt)
        win_combo.set_active(0)
        win_combo.connect("changed", lambda c: setattr(
            self, "pending_window_type", c.get_active_text()))
        self._row(props, "Window type:", win_combo)

        door_combo = Gtk.ComboBoxText()
        for dt in DOOR_TYPES:
            door_combo.append_text(dt)
        door_combo.set_active(0)
        door_combo.connect("changed", lambda c: setattr(
            self, "pending_door_type", c.get_active_text()))
        self._row(props, "Door type:", door_combo)

        # --- Exterior features (v1.1.0, Joshua) ---
        # Toggleable sections so the panel doesn't get overwhelming.
        self._section(props, "Exterior")

        # Sidewalk
        sw = b.get("sidewalk", {})
        sw_check = Gtk.CheckButton(label="Sidewalk")
        sw_check.set_active(bool(sw.get("enabled", False)))
        sw_check.connect("toggled",
                         lambda w: self._update_sub(
                             "sidewalk", "enabled", w.get_active()))
        props.pack_start(sw_check, False, False, 0)

        sw_width = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, 1.0, 12.0, 0.5)
        sw_width.set_value(float(sw.get("width", 4.0)))
        sw_width.set_hexpand(True)
        sw_width.connect("value-changed", lambda s: self._update_sub(
            "sidewalk", "width", float(s.get_value())))
        self._row(props, "Sidewalk width:", sw_width)

        sw_curved = Gtk.CheckButton(label="Curved corners")
        sw_curved.set_active(bool(sw.get("curved", False)))
        sw_curved.connect("toggled",
                          lambda w: self._update_sub(
                              "sidewalk", "curved", w.get_active()))
        props.pack_start(sw_curved, False, False, 0)

        # Driveway
        dw = b.get("driveway", {})
        dw_check = Gtk.CheckButton(label="Driveway")
        dw_check.set_active(bool(dw.get("enabled", False)))
        dw_check.connect("toggled",
                         lambda w: self._update_sub(
                             "driveway", "enabled", w.get_active()))
        props.pack_start(dw_check, False, False, 0)

        dw_mat = Gtk.ComboBoxText()
        for m in DRIVEWAY_MATERIALS:
            dw_mat.append_text(m)
        cur_dw = str(dw.get("material", "Concrete"))
        if cur_dw in DRIVEWAY_MATERIALS:
            dw_mat.set_active(DRIVEWAY_MATERIALS.index(cur_dw))
        dw_mat.connect("changed", lambda c: self._update_sub(
            "driveway", "material", c.get_active_text() or "Concrete"))
        self._row(props, "Driveway surface:", dw_mat)

        # Garage
        gar = b.get("garage", {})
        # v1.5.0: stored as self.gar_check so the residential space
        # rule can enable/disable it (Joshua: houses only get a
        # garage when expanded or with clear adjacent space).
        self.gar_check = Gtk.CheckButton(label="Garage (attached)")
        self.gar_check.set_active(bool(gar.get("enabled", False)))
        self.gar_check.connect("toggled",
                               lambda w: self._update_sub(
                                   "garage", "enabled", w.get_active()))
        props.pack_start(self.gar_check, False, False, 0)

        gar_side = Gtk.ComboBoxText()
        for s in GARAGE_SIDES:
            gar_side.append_text(s)
        cur_side = str(gar.get("side", "Right"))
        if cur_side in GARAGE_SIDES:
            gar_side.set_active(GARAGE_SIDES.index(cur_side))
        gar_side.connect("changed", lambda c: self._update_sub(
            "garage", "side", c.get_active_text() or "Right"))
        self._row(props, "Garage side:", gar_side)

        gar_w = Gtk.SpinButton.new_with_range(10, 100, 5)
        gar_w.set_value(float(gar.get("width", 20.0)))
        gar_w.connect("value-changed", lambda s: self._update_sub(
            "garage", "width", float(s.get_value())))
        self._row(props, "Garage width:", gar_w)

        # Sallyport
        sp = b.get("sallyport", {})
        sp_check = Gtk.CheckButton(label="Sallyport (covered entrance)")
        sp_check.set_active(bool(sp.get("enabled", False)))
        sp_check.connect("toggled",
                         lambda w: self._update_sub(
                             "sallyport", "enabled", w.get_active()))
        props.pack_start(sp_check, False, False, 0)

        # --- Fence (v1.1.0, Joshua) ---
        self._section(props, "Fence")
        fence = b.get("fence", {})
        fence_check = Gtk.CheckButton(label="Fence")
        fence_check.set_active(bool(fence.get("enabled", False)))
        fence_check.connect("toggled",
                            lambda w: self._update_sub(
                                "fence", "enabled", w.get_active()))
        props.pack_start(fence_check, False, False, 0)

        fence_style = Gtk.ComboBoxText()
        for s in FENCE_STYLES:
            fence_style.append_text(s)
        cur_fs = str(fence.get("style", "Wood"))
        if cur_fs in FENCE_STYLES:
            fence_style.set_active(FENCE_STYLES.index(cur_fs))
        fence_style.connect("changed", lambda c: self._update_sub(
            "fence", "style", c.get_active_text() or "Wood"))
        self._row(props, "Fence style:", fence_style)

        # Fence drawing buttons
        fence_btns = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                             spacing=4)
        self.fence_draw_btn = Gtk.ToggleButton(label="Draw Fence")
        self.fence_draw_btn.connect("toggled", self._on_fence_draw_toggled)
        fence_btns.pack_start(self.fence_draw_btn, True, True, 0)
        fence_finish = Gtk.Button(label="Finish")
        fence_finish.connect("clicked", self._on_fence_finish)
        fence_finish.set_tooltip_text(
            "Save the drawn polygon as the fence perimeter")
        fence_btns.pack_start(fence_finish, True, True, 0)
        fence_clear = Gtk.Button(label="Clear")
        fence_clear.connect("clicked", self._on_fence_clear)
        fence_clear.set_tooltip_text("Discard the fence polygon")
        fence_btns.pack_start(fence_clear, True, True, 0)
        self._row(props, "", fence_btns)

        # --- Interior floors (v1.1.0, Joshua) ---
        # Floor type picker, visible when the building is walkable.
        self.floor_type_box = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.floor_type_box.set_no_show_all(True)
        self._section(self.floor_type_box, "Interior Floors")
        floor_sel_row = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        floor_sel_lbl = Gtk.Label(label="Floor:")
        floor_sel_lbl.set_halign(Gtk.Align.START)
        floor_sel_lbl.set_size_request(110, -1)
        floor_sel_row.pack_start(floor_sel_lbl, False, False, 0)
        self.floor_sel_spin = Gtk.SpinButton.new_with_range(1, 5, 1)
        self.floor_sel_spin.set_value(1)
        self.floor_sel_spin.connect("value-changed",
                                    self._on_floor_sel_changed)
        floor_sel_row.pack_start(self.floor_sel_spin, True, True, 0)
        self.floor_type_box.pack_start(floor_sel_row, False, False, 0)

        self.floor_type_combo = Gtk.ComboBoxText()
        for ft in FLOOR_TYPES:
            self.floor_type_combo.append_text(ft)
        self.floor_type_combo.connect("changed",
                                     self._on_floor_type_changed)
        ft_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                         spacing=8)
        ft_lbl = Gtk.Label(label="Floor type:")
        ft_lbl.set_halign(Gtk.Align.START)
        ft_lbl.set_size_request(110, -1)
        ft_row.pack_start(ft_lbl, False, False, 0)
        ft_row.pack_start(self.floor_type_combo, True, True, 0)
        self.floor_type_box.pack_start(ft_row, False, False, 0)
        props.pack_start(self.floor_type_box, False, False, 0)
        self.floor_type_box.set_visible(bool(b.get("walkable", False)))
        self._sync_floor_type()

        # --- Decorations (v1.1.0, Joshua) ---
        self._section(props, "Decorations")
        deco_combo = Gtk.ComboBoxText()
        for dt in DECORATION_TYPES:
            deco_combo.append_text(dt)
        deco_combo.set_active(0)
        deco_combo.connect("changed", lambda c: (
            setattr(self, "pending_decoration_type",
                    c.get_active_text() or DECORATION_TYPES[0]),
            setattr(self.canvas, "pending_decoration_type",
                    c.get_active_text() or DECORATION_TYPES[0])))
        self._row(props, "Decoration:", deco_combo)
        # Sync the canvas's copy for the placement handler
        self.canvas.pending_decoration_type = self.pending_decoration_type
        deco_hint = Gtk.Label(
            label="Use 'Add Decoration' mode, then click a wall "
                  "(picture/curtains) or the ground (plant/lamp/rug).")
        deco_hint.set_line_wrap(True)
        deco_hint.set_halign(Gtk.Align.START)
        props.pack_start(deco_hint, False, False, 0)
        self.deco_count_label = Gtk.Label()
        self.deco_count_label.set_halign(Gtk.Align.START)
        props.pack_start(self.deco_count_label, False, False, 2)
        self._refresh_deco_count()

        # --- Parking (v1.5.0, Joshua) ---
        # Three parking types: lot, single space, garage. Garages are
        # commercial-only. Elements are placed by clicking the ground,
        # dragged to move, and removed in Remove mode.
        self._section(props, "Parking")
        park_btns = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                            spacing=4)
        self.park_lot_btn = Gtk.Button(label="Add Parking Lot")
        self.park_lot_btn.set_tooltip_text(
            "Place a parking lot (rows x spaces)")
        self.park_lot_btn.connect(
            "clicked", lambda w: self._on_add_parking("lot"))
        park_btns.pack_start(self.park_lot_btn, True, True, 0)
        self.park_space_btn = Gtk.Button(label="Add Single Space")
        self.park_space_btn.set_tooltip_text(
            "Place one marked parking space")
        self.park_space_btn.connect(
            "clicked", lambda w: self._on_add_parking("space"))
        park_btns.pack_start(self.park_space_btn, True, True, 0)
        self.park_garage_btn = Gtk.Button(label="Add Parking Garage")
        self.park_garage_btn.connect(
            "clicked", lambda w: self._on_add_parking("garage"))
        park_btns.pack_start(self.park_garage_btn, True, True, 0)
        props.pack_start(park_btns, False, False, 0)
        park_hint = Gtk.Label(
            label="Click a button, then click the ground in the preview "
                  "to place it. Drag a parking element to move it; "
                  "use Remove mode to delete it.")
        park_hint.set_line_wrap(True)
        park_hint.set_halign(Gtk.Align.START)
        props.pack_start(park_hint, False, False, 0)
        self.parking_count_label = Gtk.Label()
        self.parking_count_label.set_halign(Gtk.Align.START)
        props.pack_start(self.parking_count_label, False, False, 2)

        # Property editors for the selected parking element. Hidden
        # until Joshua clicks a parking element in the preview.
        self.parking_props_box = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.parking_props_box.set_no_show_all(True)
        self.park_sel_label = Gtk.Label()
        self.park_sel_label.set_halign(Gtk.Align.START)
        self.parking_props_box.pack_start(
            self.park_sel_label, False, False, 0)
        self._refreshing_parking = False

        self.park_rows_row, self.park_rows_spin = self._spin_row(
            self.parking_props_box, "Rows:", 1, 10, 1,
            self._on_park_rows_changed)
        self.park_spr_row, self.park_spr_spin = self._spin_row(
            self.parking_props_box, "Spaces / row:", 1, 30, 1,
            self._on_park_spr_changed)
        self.park_ori_row, self.park_ori_combo = self._combo_row(
            self.parking_props_box, "Orientation:",
            PARKING_SPACE_ORIENTATIONS, self._on_park_ori_changed)
        self.park_levels_row, self.park_levels_spin = self._spin_row(
            self.parking_props_box, "Levels:", 1, 5, 1,
            self._on_park_levels_changed)
        self.park_spl_row, self.park_spl_spin = self._spin_row(
            self.parking_props_box, "Spaces / level:", 1, 50, 1,
            self._on_park_spl_changed)
        self.park_rot_row, self.park_rot_spin = self._spin_row(
            self.parking_props_box, "Rotation:", 0, 359, 5,
            self._on_park_rot_changed)
        props.pack_start(self.parking_props_box, False, False, 0)
        self._refresh_parking_ui()

        # --- Make Walkable button ---
        self._section(props, "Actions")
        make_walk = Gtk.Button(label="Make Walkable")
        make_walk.connect("clicked", self._on_make_walkable)
        props.pack_start(make_walk, False, False, 0)

        # Window/door counts for reference
        self.count_label = Gtk.Label()
        self.count_label.set_halign(Gtk.Align.START)
        props.pack_start(self.count_label, False, False, 4)
        self._refresh_counts()
        # Initial road-collision check for this building's position
        self._check_collision()
        # v1.5.0: initial attached-garage availability (residential rule)
        self._refresh_garage_availability()

    # -- property helpers -------------------------------------------------

    @staticmethod
    def _hex_to_rgba(hex_color):
        """Convert #rrggbb to a Gdk.RGBA."""
        try:
            h = hex_color.lstrip("#")
            return Gdk.RGBA(int(h[0:2], 16) / 255.0,
                            int(h[2:4], 16) / 255.0,
                            int(h[4:6], 16) / 255.0, 1.0)
        except Exception:
            return Gdk.RGBA(0.75, 0.75, 0.75, 1.0)

    @staticmethod
    def _rgba_to_hex(rgba):
        """Convert a Gdk.RGBA to #rrggbb."""
        return "#{:02x}{:02x}{:02x}".format(
            int(rgba.red * 255), int(rgba.green * 255),
            int(rgba.blue * 255))

    def _update(self, key, value):
        """
        Update one building property, persist the edit, and redraw.
        Called by every property control.
        """
        # v1.2.0: skip while the canvas is driving these controls
        # (_on_canvas_transform_changed handles save/redraw itself).
        if getattr(self, "_syncing_ui", False):
            return
        self.building[key] = value
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        # Mark for auto-push + close warning (Joshua 2026-10-11).
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self.canvas.queue_draw()
        # Footprint-affecting changes re-run the road collision check
        if key in ("rotation", "width", "depth"):
            self._check_collision()
        # v1.5.0: footprint changes re-check the residential garage rule
        if key in ("width", "depth"):
            self._refresh_garage_availability()

    def _update_pos(self, idx, value):
        """Update one component of the [x, z] position."""
        # v1.2.0: skip while the canvas is driving these controls.
        if getattr(self, "_syncing_ui", False):
            return
        pos = self.building.get("position", [0, 0])
        while len(pos) <= idx:
            pos.append(0)
        pos[idx] = float(value)
        self.building["position"] = pos
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self.canvas.queue_draw()  # refresh nearby-road context
        self._check_collision()
        # v1.5.0: moving the house can change the garage space check
        self._refresh_garage_availability()

    def _update_sub(self, key, subkey, value):
        """
        Update one nested property (e.g. building["sidewalk"]["width"]).
        v1.1.0: used by the Exterior/Fence sections. Persists and redraws.
        """
        sub = self.building.get(key)
        if not isinstance(sub, dict):
            sub = {}
            self.building[key] = sub
        sub[subkey] = value
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self.canvas.queue_draw()

    # -- floor types (v1.1.0) -------------------------------------------------

    def _sync_floor_type(self):
        """
        Update the floor-type combo from the currently selected floor.
        floor_types is a list indexed by floor-1; missing entries read
        as the default ("Hardwood").
        """
        floor_idx = int(self.floor_sel_spin.get_value()) - 1
        ftypes = self.building.get("floor_types", [])
        cur = ftypes[floor_idx] if 0 <= floor_idx < len(ftypes) \
            else "Hardwood"
        # Block the changed signal while setting
        self.floor_type_combo.handler_block_by_func(
            self._on_floor_type_changed)
        if cur in FLOOR_TYPES:
            self.floor_type_combo.set_active(FLOOR_TYPES.index(cur))
        else:
            self.floor_type_combo.set_active(0)
        self.floor_type_combo.handler_unblock_by_func(
            self._on_floor_type_changed)

    def _on_floor_sel_changed(self, spin):
        """Floor selector changed: show that floor's type."""
        self._sync_floor_type()

    def _on_floor_type_changed(self, combo):
        """Save the selected floor's type."""
        text = combo.get_active_text()
        if not text:
            return
        floor_idx = int(self.floor_sel_spin.get_value()) - 1
        ftypes = self.building.get("floor_types", [])
        # Extend the list so the index exists
        while len(ftypes) <= floor_idx:
            ftypes.append("Hardwood")
        ftypes[floor_idx] = text
        self.building["floor_types"] = ftypes
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self.app_window._set_status(
            f"Floor {floor_idx + 1} type: {text}")

    # -- fence drawing (v1.1.0) -------------------------------------------------

    def _on_fence_draw_toggled(self, button):
        """
        Toggle fence-drawing mode on the canvas. While active, clicks
        on the ground add polygon points (amber dots in the preview).
        """
        if button.get_active():
            # Switch the canvas to fence mode and untoggle other modes
            self._set_canvas_mode("draw_fence")
            self.canvas.clear_fence_draft()
            # Start the draft from any existing saved points so Joshua
            # can extend a fence rather than redrawing it
            existing = (self.building.get("fence", {}).get("points")
                        or [])
            for pt in existing:
                self.canvas._fence_draft.append([float(pt[0]),
                                                float(pt[1])])
            self.canvas.queue_draw()
            self.app_window._set_status(
                "Click ground points around the building, then Finish.")
        else:
            if self.canvas.mode == "draw_fence":
                self._set_canvas_mode("view")

    def _set_canvas_mode(self, mode):
        """
        Set the canvas mode and sync the mode-bar toggle buttons.
        Used by fence drawing (which lives in the properties panel,
        not the mode bar).
        """
        for mid, btn in self.mode_buttons.items():
            btn.handler_block_by_func(self._on_mode_toggled)
            btn.set_active(mid == mode)
            btn.handler_unblock_by_func(self._on_mode_toggled)
        self.canvas.set_mode(mode)

    def _on_fence_point(self, gx, gz):
        """Canvas callback: one fence polygon point was clicked."""
        n = len(self.canvas.get_fence_draft())
        self.app_window._set_status(f"Fence point {n} placed.")

    def _on_canvas_transform_changed(self):
        """
        Canvas callback (v1.2.0, Joshua): the house was moved by
        dragging its body, or pivot-rotated by dragging a wall edge.
        Sync the Position X/Z and Rotation controls, persist the
        edit, re-run the road collision check, and redraw.
        """
        self._syncing_ui = True
        try:
            pos = self.building.get("position", [0, 0])
            self.x_spin.set_value(
                float(pos[0]) if len(pos) > 0 else 0.0)
            self.z_spin.set_value(
                float(pos[1]) if len(pos) > 1 else 0.0)
            self.rot_scale.set_value(
                float(self.building.get("rotation", 0.0)) % 360.0)
        finally:
            self._syncing_ui = False
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self._check_collision()
        # v1.5.0: canvas-driven moves also re-check the garage rule
        self._refresh_garage_availability()
        self.canvas.queue_draw()

    def _on_fence_edit(self):
        """Canvas callback (v1.2.0): a fence segment was edited."""
        n = len(self.canvas.get_fence_draft())
        self.app_window._set_status(
            f"Fence updated ({n} points). Finish to save.")

    def _on_fence_finish(self, widget):
        """
        Save the drawn polygon as the building's fence perimeter and
        enable the fence. Untoggles draw mode.
        """
        pts = self.canvas.get_fence_draft()
        if len(pts) < 3:
            self.app_window._set_status(
                "Need at least 3 points for a fence.")
            return
        fence = self.building.get("fence", {})
        fence["points"] = pts
        fence["enabled"] = True
        self.building["fence"] = fence
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self.canvas.clear_fence_draft()
        self.fence_draw_btn.set_active(False)
        self._set_canvas_mode("view")
        self.canvas.queue_draw()
        self.app_window._set_status(
            f"Fence saved ({len(pts)} points).")

    def _on_fence_clear(self, widget):
        """Discard the fence polygon (draft and saved)."""
        fence = self.building.get("fence", {})
        fence["points"] = []
        fence["enabled"] = False
        self.building["fence"] = fence
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self.canvas.clear_fence_draft()
        self.fence_draw_btn.set_active(False)
        self._set_canvas_mode("view")
        self.canvas.queue_draw()
        self.app_window._set_status("Fence cleared.")

    # -- decorations (v1.1.0) -------------------------------------------------

    def _on_decoration_click(self, info):
        """
        Canvas callback: Joshua clicked to place a decoration.
        info is {"type", "face", "x", "y"} for wall types or
        {"type", "gx", "gz"} for floor types.
        """
        dtype = info.get("type", "")
        if dtype in DECORATION_WALL_TYPES:
            deco = {"type": dtype,
                    "face": info.get("face", "front"),
                    "x": max(0.02, min(0.85, float(info.get("x", 0.4)))),
                    "y": max(0.20, min(0.80, float(info.get("y", 0.5))))}
        else:
            deco = {"type": dtype,
                    "gx": max(-15.0, min(15.0,
                                         float(info.get("gx", 0.0)))),
                    "gz": max(-15.0, min(15.0,
                                         float(info.get("gz", 0.0))))}
        self.building.setdefault("decorations", []).append(deco)
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self._refresh_deco_count()
        self.canvas.queue_draw()
        self.app_window._set_status(f"{dtype} placed.")

    def _refresh_deco_count(self):
        """Update the decoration count label."""
        n = len(self.building.get("decorations", []))
        self.deco_count_label.set_text(f"{n} decorations placed")

    # -- parking (v1.5.0, Joshua) ------------------------------------------

    def _on_type_changed(self, combo):
        """
        Building type changed. Parking garages are commercial-only:
        switching to a residential type while the building has a
        parking garage asks Joshua whether to remove it. Also refreshes
        the residential attached-garage availability.
        """
        new_type = combo.get_active_text() or "House"
        old_type = self.building.get("type", "House")
        if new_type == old_type:
            return
        garages = [p for p in self.building.get("parking", [])
                   if p.get("type") == "garage"]
        if new_type in RESIDENTIAL_TYPES and garages:
            dlg = Gtk.MessageDialog(
                transient_for=self.app_window,
                message_type=Gtk.MessageType.WARNING,
                buttons=Gtk.ButtonsType.NONE,
                text="This building has a parking garage. Changing to "
                     "residential will remove it.")
            dlg.add_button("Cancel", Gtk.ResponseType.CANCEL)
            dlg.add_button("Remove Garage", Gtk.ResponseType.OK)
            resp = dlg.run()
            dlg.destroy()
            if resp != Gtk.ResponseType.OK:
                # Revert the combo without re-triggering this handler
                combo.handler_block_by_func(self._on_type_changed)
                if old_type in BUILDING_TYPES:
                    combo.set_active(BUILDING_TYPES.index(old_type))
                combo.handler_unblock_by_func(self._on_type_changed)
                return
            self.building["parking"] = [
                p for p in self.building.get("parking", [])
                if p.get("type") != "garage"]
            self.selected_parking = None
            self.canvas._selected_item = None
        self._update("type", new_type)
        self._refresh_parking_ui()
        self._refresh_garage_availability()

    def _refresh_garage_availability(self):
        """
        Enable/disable the attached-garage checkbox per Joshua's
        residential rule (v1.5.0): houses only get a garage when
        expanded (>1800 sq world units) or with clear adjacent space.
        Commercial buildings always allow it.
        """
        if not hasattr(self, "gar_check"):
            return
        b = self.building
        gar = b.get("garage", {})
        if b.get("type", "House") in RESIDENTIAL_TYPES:
            ok, _reason = garage_space_ok(b)
            if ok or gar.get("enabled"):
                self.gar_check.set_sensitive(True)
                self.gar_check.set_tooltip_text("Attached garage")
            else:
                self.gar_check.set_sensitive(False)
                self.gar_check.set_tooltip_text(
                    "Not enough space for a garage — expand the house "
                    "or clear the lot")
        else:
            self.gar_check.set_sensitive(True)
            self.gar_check.set_tooltip_text("Attached garage")

    def _on_add_parking(self, ptype):
        """
        Parking section button: enter ground-placement mode for one
        parking element of the given type. The garage button is only
        sensitive for commercial buildings (see _refresh_parking_ui),
        but double-check here in case the type changed mid-session.
        """
        if ptype == "garage" and \
                self.building.get("type", "House") in RESIDENTIAL_TYPES:
            self.app_window._set_status(
                "Parking garages are commercial-only.")
            return
        self.pending_parking_type = ptype
        self.canvas.pending_parking_type = ptype
        self._set_canvas_mode("add_parking")
        label = PARKING_TYPE_LABELS.get(ptype, ptype).lower()
        self.app_window._set_status(
            f"Click the ground to place a {label}.")

    def _on_parking_click(self, info):
        """
        Canvas callback: Joshua clicked the ground to place a parking
        element. info is {"type", "gx", "gz"}.
        """
        ptype = info.get("type", "lot")
        p = {"type": ptype,
             "gx": max(-15.0, min(15.0, float(info.get("gx", 0.0)))),
             "gz": max(-15.0, min(15.0, float(info.get("gz", 0.0))))}
        if ptype == "lot":
            p.update({"rows": 4, "spaces_per_row": 10,
                      "rotation": 0.0})
        elif ptype == "space":
            p.update({"orientation": "Perpendicular",
                      "rotation": 0.0})
        else:
            p.update({"levels": 3, "spaces_per_level": 20})
        self.building.setdefault("parking", []).append(p)
        self._save_parking()
        # Select the new element so its properties show immediately
        self.selected_parking = len(self.building["parking"]) - 1
        self.canvas._selected_item = ("parking", self.selected_parking)
        self._refresh_parking_ui()
        self._set_canvas_mode("view")
        label = PARKING_TYPE_LABELS.get(ptype, ptype)
        self.app_window._set_status(f"{label} placed.")

    def _on_parking_selected(self, index):
        """
        Canvas callback: a parking element was clicked (index) or
        deselected (None) in view mode. Updates the property editors.
        """
        self.selected_parking = index
        self._refresh_parking_ui()

    def _selected_parking_dict(self):
        """Return the selected parking dict, or None."""
        items = self.building.get("parking", [])
        sel = self.selected_parking
        if sel is None or not (0 <= sel < len(items)):
            return None
        return items[sel]

    def _save_parking(self):
        """Persist a parking change and redraw."""
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self.canvas.queue_draw()

    def _refresh_parking_ui(self):
        """
        Update the Parking section: element count, commercial-only
        garage button state, and the selected-element property editors.
        """
        items = self.building.get("parking", [])
        self.parking_count_label.set_text(
            f"{len(items)} parking element(s)")
        # Garages are commercial-only (Joshua 2026-10-11)
        is_res = self.building.get("type", "House") in RESIDENTIAL_TYPES
        self.park_garage_btn.set_sensitive(not is_res)
        self.park_garage_btn.set_tooltip_text(
            "Parking garages are commercial-only" if is_res else
            "Add a multi-level parking garage")
        # Selected-element editors
        p = self._selected_parking_dict()
        self._refreshing_parking = True
        try:
            if p is None:
                self.parking_props_box.set_visible(False)
                return
            self.parking_props_box.set_visible(True)
            ptype = p.get("type", "lot")
            sel = self.selected_parking
            self.park_sel_label.set_text(
                "Selected: %s #%d" % (
                    PARKING_TYPE_LABELS.get(ptype, ptype), sel + 1))
            # Show only the rows relevant to this type
            self.park_rows_row.set_visible(ptype == "lot")
            self.park_spr_row.set_visible(ptype == "lot")
            self.park_ori_row.set_visible(ptype == "space")
            self.park_levels_row.set_visible(ptype == "garage")
            self.park_spl_row.set_visible(ptype == "garage")
            self.park_rot_row.set_visible(ptype in ("lot", "space"))
            if ptype == "lot":
                self.park_rows_spin.set_value(
                    float(p.get("rows", 4) or 4))
                self.park_spr_spin.set_value(
                    float(p.get("spaces_per_row", 10) or 10))
                self.park_rot_spin.set_value(
                    float(p.get("rotation", 0.0) or 0.0))
            elif ptype == "space":
                ori = str(p.get("orientation", "Perpendicular"))
                if ori in PARKING_SPACE_ORIENTATIONS:
                    self.park_ori_combo.set_active(
                        PARKING_SPACE_ORIENTATIONS.index(ori))
                self.park_rot_spin.set_value(
                    float(p.get("rotation", 0.0) or 0.0))
            else:
                self.park_levels_spin.set_value(
                    float(p.get("levels", 3) or 3))
                self.park_spl_spin.set_value(
                    float(p.get("spaces_per_level", 20) or 20))
        finally:
            self._refreshing_parking = False

    def _park_prop(self, key, value):
        """Write one property on the selected parking element."""
        if self._refreshing_parking:
            return
        p = self._selected_parking_dict()
        if p is None:
            return
        p[key] = value
        self._save_parking()

    def _on_park_rows_changed(self, spin):
        self._park_prop("rows", int(spin.get_value()))

    def _on_park_spr_changed(self, spin):
        self._park_prop("spaces_per_row", int(spin.get_value()))

    def _on_park_ori_changed(self, combo):
        self._park_prop("orientation",
                        combo.get_active_text() or "Perpendicular")

    def _on_park_levels_changed(self, spin):
        self._park_prop("levels", int(spin.get_value()))

    def _on_park_spl_changed(self, spin):
        self._park_prop("spaces_per_level", int(spin.get_value()))

    def _on_park_rot_changed(self, spin):
        self._park_prop("rotation", float(spin.get_value()) % 360.0)

    def _check_collision(self):
        """
        Check whether the building footprint overlaps any road.
        Warns in the status bar and outlines the footprint in red —
        but never blocks the placement (Joshua may do it intentionally).
        """
        if not self.canvas.roads:
            self.canvas.collision = False
            return  # no road data (offline first run) — skip silently
        b = self.building
        pos = b.get("position", [0, 0])
        cx = float(pos[0]) if len(pos) > 0 else 0.0
        cz = float(pos[1]) if len(pos) > 1 else 0.0
        hits = data.check_building_footprint(
            cx, cz,
            float(b.get("width", 40.0)),
            float(b.get("depth", 40.0)),
            float(b.get("rotation", 0.0)))
        self.canvas.collision = bool(hits)
        self.canvas.queue_draw()
        if hits:
            names = ", ".join(f"{n} ({c})" for n, c in hits[:4])
            extra = f" (+{len(hits) - 4} more)" if len(hits) > 4 else ""
            self.app_window._set_status(
                f"⚠ Building overlaps {names}{extra}")
        # No else-branch: leave the last status message alone when clear

    def _change_floors(self, delta):
        """Add (+1) or remove (−1) a floor, clamped to 1-5."""
        floors = max(1, min(5, int(self.building.get("floors", 1))
                            + delta))
        self.building["floors"] = floors
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self.canvas.queue_draw()
        self.app_window._set_status(f"Floors: {floors}")

    def _on_walkable(self, active):
        """Toggle walkable; show/hide the floor plan picker."""
        self.building["walkable"] = active
        self.floor_plan_box.set_visible(active)
        # v1.1.0: floor-type picker also only applies to walkables
        self.floor_type_box.set_visible(active)
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self.app_window._set_status(
            "Marked walkable." if active else "Marked exterior-only.")

    def _on_make_walkable(self, widget):
        """
        "Make Walkable" action: marks the building walkable and, per
        Joshua's spec, this is where windows become see-through and the
        door becomes enterable. v1 just flips the flag and reveals the
        floor plan picker; the visual/door behavior comes later.
        """
        self.building["walkable"] = True
        self.floor_plan_box.set_visible(True)
        # v1.1.0: reveal the floor-type picker too
        self.floor_type_box.set_visible(True)
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self.app_window._set_status(
            "Building is now walkable. Pick a floor plan template.")

    def _refresh_counts(self):
        """Update the window/door count label."""
        nw = len(self.building.get("windows", []))
        nd = len(self.building.get("doors", []))
        self.count_label.set_text(f"{nw} windows, {nd} doors")

    # -- canvas interaction modes -----------------------------------------

    def _on_mode_toggled(self, button, mode_id):
        """
        Radio-style mode buttons: activating one deactivates the rest
        and sets the canvas interaction mode.
        """
        if not button.get_active():
            return
        for mid, btn in self.mode_buttons.items():
            if mid != mode_id:
                # Block the toggled signal to avoid recursion
                btn.handler_block_by_func(self._on_mode_toggled)
                btn.set_active(False)
                btn.handler_unblock_by_func(self._on_mode_toggled)
        # Leaving fence-draw mode via the mode bar: untoggle the
        # fence button in the properties panel (v1.1.0)
        if mode_id != "draw_fence" and hasattr(self, "fence_draw_btn"):
            self.fence_draw_btn.handler_block_by_func(
                self._on_fence_draw_toggled)
            self.fence_draw_btn.set_active(False)
            self.fence_draw_btn.handler_unblock_by_func(
                self._on_fence_draw_toggled)
        self.canvas.set_mode(mode_id)

    def _on_face_click(self, face, fx, fy):
        """
        Canvas callback: Joshua clicked a wall face in an add mode.
        Place a window or door at the fractional position.
        """
        if self.canvas.mode == "add_window":
            # Windows sit on the wall: y fractional up the floor,
            # clamped away from the very top/bottom edges
            win = {"face": face,
                   "x": max(0.02, min(0.83, fx - 0.075)),
                   "y": max(0.25, min(0.70, fy - 0.125)),
                   "w": 0.15, "h": 0.25,
                   "type": self.pending_window_type}
            self.building.setdefault("windows", []).append(win)
            self.app_window._set_status(
                f"Window added on {face} face.")
        elif self.canvas.mode == "add_door":
            # Doors always sit on the floor
            door = {"face": face,
                    "x": max(0.02, min(0.86, fx - 0.06)),
                    "y": 0.0,
                    "type": self.pending_door_type}
            self.building.setdefault("doors", []).append(door)
            self.app_window._set_status(f"Door added on {face} face.")
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self._refresh_counts()
        self.canvas.queue_draw()

    def _on_item_click(self, kind, index):
        """
        Canvas callback: Joshua clicked a window/door/decoration in
        remove mode. Delete it.
        """
        if kind == "decoration":
            items = self.building.get("decorations", [])
        elif kind == "parking":
            # v1.5.0: parking elements are removable like decorations
            items = self.building.get("parking", [])
        else:
            items = self.building.get("windows" if kind == "window"
                                      else "doors", [])
        if 0 <= index < len(items):
            del items[index]
            data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
            self._refresh_counts()
            if kind == "decoration":
                self._refresh_deco_count()
            if kind == "parking":
                # v1.5.0: indices shifted — clear a stale selection
                if self.selected_parking == index:
                    self.selected_parking = None
                elif (self.selected_parking is not None
                      and self.selected_parking > index):
                    self.selected_parking -= 1
                self._refresh_parking_ui()
            # Clear a stale resize selection
            if self.canvas._selected_item == (kind, index):
                self.canvas._selected_item = None
            self.canvas.queue_draw()
            self.app_window._set_status(f"{kind.capitalize()} removed.")

    def _on_item_moved(self, kind, index):
        """
        Canvas callback: Joshua finished dragging a window/door to a
        new position on its face. Persist the building edit.
        (The canvas already mutated the item dict in place.)
        """
        data.save_building_edit(self.building)
        try:
            self.app_window._mark_unpublished()
        except Exception:
            pass
        self.canvas.queue_draw()
        self.app_window._set_status(
            f"{kind.capitalize()} moved.")


# ---------------------------------------------------------------------------
# Subdivisions tab: 2D map for defining house-spawn areas
# ---------------------------------------------------------------------------

class SubdivisionTab(Gtk.Box):
    """
    Subdivision editor tab: 2D top-down map (left) + subdivision list
    and editor panel (right).

    Joshua draws a polygon on the map to define a subdivision area,
    names it, and picks one of the 20 house styles. The game spawns
    houses of that style inside the polygon. The editor only defines
    the areas — the spawning algorithm lives in the game engine.
    """

    def __init__(self, window):
        """
        window: the AssetEditorWindow (for status messages).
        """
        super().__init__(orientation=Gtk.Orientation.HORIZONTAL,
                         spacing=6)
        self.app_window = window
        # Working copy of the subdivision list
        self.subdivisions = data.load_subdivisions()
        # Zone-first workflow (v1.2.0, Joshua): Joshua picks a zone to
        # work in; the map zooms to it. Empty until _refresh() loads.
        self.zones = []
        self._zone_picker_shown = False

        # --- Left: map canvas ---
        left = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.canvas = SubdivisionCanvas()
        self.canvas.on_polygon_done = self._on_polygon_done
        self.canvas.on_subdivision_click = self._on_subdivision_click
        left.pack_start(self.canvas, True, True, 0)

        # Draw-mode toggle under the canvas
        mode_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                           spacing=4)
        self.draw_btn = Gtk.ToggleButton(label="Draw Subdivision")
        self.draw_btn.connect("toggled", self._on_draw_toggled)
        mode_bar.pack_start(self.draw_btn, False, False, 0)
        fit_btn = Gtk.Button(label="Fit to World")
        fit_btn.connect("clicked", self._on_fit)
        mode_bar.pack_start(fit_btn, False, False, 0)
        # Zone picker: switch the working zone (v1.2.0)
        zone_btn = Gtk.Button(label="Change Zone")
        zone_btn.set_tooltip_text(
            "Pick a different zone to work in")
        zone_btn.connect("clicked", self._on_change_zone)
        mode_bar.pack_start(zone_btn, False, False, 0)
        self.zone_label = Gtk.Label(label="Zone: (full map)")
        self.zone_label.set_halign(Gtk.Align.START)
        mode_bar.pack_start(self.zone_label, False, False, 8)
        left.pack_start(mode_bar, False, False, 4)

        hint = Gtk.Label(
            label="Draw a polygon around a neighborhood, then name it "
                  "and pick a house style.")
        hint.set_halign(Gtk.Align.START)
        hint.set_line_wrap(True)
        left.pack_start(hint, False, False, 0)
        self.pack_start(left, True, True, 6)

        # --- Right: subdivision list + editor panel ---
        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        right.set_border_width(10)
        right.set_size_request(280, -1)

        lbl = Gtk.Label()
        lbl.set_markup("<b>Subdivisions</b>")
        lbl.set_halign(Gtk.Align.START)
        right.pack_start(lbl, False, False, 0)

        # List of subdivisions
        self.store = Gtk.ListStore(str, str)  # name, style
        self.tree = Gtk.TreeView(model=self.store)
        for i, title in enumerate(("Name", "Style")):
            col = Gtk.TreeViewColumn(title, Gtk.CellRendererText(),
                                     text=i)
            self.tree.append_column(col)
        self.tree.get_selection().connect("changed",
                                          self._on_list_select)
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_min_content_height(160)
        scrolled.add(self.tree)
        right.pack_start(scrolled, False, False, 0)

        # Editor for the selected subdivision
        edit_lbl = Gtk.Label()
        edit_lbl.set_markup("<b>Edit Selected</b>")
        edit_lbl.set_halign(Gtk.Align.START)
        right.pack_start(edit_lbl, False, False, 4)

        self.name_entry = Gtk.Entry()
        self.name_entry.set_placeholder_text("Subdivision name")
        self.name_entry.connect("changed", self._on_name_changed)
        name_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                           spacing=8)
        name_row.pack_start(Gtk.Label(label="Name:"), False, False, 0)
        name_row.pack_start(self.name_entry, True, True, 0)
        right.pack_start(name_row, False, False, 0)

        self.style_combo = Gtk.ComboBoxText()
        for s in HOUSE_STYLES:
            self.style_combo.append_text(s)
        self.style_combo.connect("changed", self._on_style_changed)
        style_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                            spacing=8)
        style_row.pack_start(Gtk.Label(label="Style:"), False, False, 0)
        style_row.pack_start(self.style_combo, True, True, 0)
        right.pack_start(style_row, False, False, 0)

        del_btn = Gtk.Button(label="Delete Subdivision")
        del_btn.connect("clicked", self._on_delete)
        right.pack_start(del_btn, False, False, 4)

        # v1.6.0: bake generated houses into the game zone files.
        gen_btn = Gtk.Button(label="Generate Houses into Zone Buildings")
        gen_btn.set_tooltip_text(
            "Fill the selected subdivision's polygon with houses and "
            "bake them into the game's zone building files")
        gen_btn.connect("clicked", self._on_generate_houses)
        right.pack_start(gen_btn, False, False, 4)

        self.pack_start(right, False, False, 6)

        # Load data into the canvas; the canvas fits the view itself
        # on its first real size allocation (v1.2.0 fix).
        self._refresh()

    # -- data / refresh ---------------------------------------------------

    def _refresh(self):
        """Reload the list widget and canvas from the working copy."""
        self.store.clear()
        for sub in self.subdivisions:
            self.store.append([sub.get("name", ""),
                               sub.get("style", "")])
        self.zones = data.load_zones()
        self.canvas.set_data(self.zones, self.subdivisions)
        self.canvas.queue_draw()

    # -- zone-first workflow (v1.2.0, Joshua) ----------------------------

    def maybe_show_zone_picker(self):
        """
        Show the zone picker once, the first time the tab is shown.
        Called via GLib.idle_add after the tab opens. If zones failed
        to load, fall back to the full map without blocking Joshua.
        """
        if self._zone_picker_shown:
            return False
        self._zone_picker_shown = True
        if self.zones:
            self.show_zone_picker()
        else:
            self._apply_zone(None)
        return False  # one-shot

    def _on_change_zone(self, widget):
        """'Change Zone' button: back to the zone picker."""
        if not self.zones:
            self.zones = data.load_zones()
            self.canvas.set_data(self.zones, self.subdivisions)
        if self.zones:
            self.show_zone_picker()
        else:
            self.app_window._set_status(
                "No zones available - showing the full map.")

    def show_zone_picker(self):
        """
        Zone picker dialog: 'Select a zone to work in'. The map then
        zooms to that zone's boundaries.
        """
        dlg = Gtk.Dialog(title="Select a Zone to Work In",
                         transient_for=self.app_window, flags=0)
        dlg.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dlg.add_button("Use Full Map", Gtk.ResponseType.REJECT)
        dlg.add_button("Select Zone", Gtk.ResponseType.OK)
        dlg.set_default_size(320, 380)

        box = dlg.get_content_area()
        box.set_border_width(10)
        box.set_spacing(8)
        lbl = Gtk.Label(
            label="Pick a zone - the map will zoom to its boundaries.\n"
                  "Subdivisions are still saved in world coordinates.")
        lbl.set_line_wrap(True)
        lbl.set_halign(Gtk.Align.START)
        box.pack_start(lbl, False, False, 0)

        store = Gtk.ListStore(str)
        for z in self.zones:
            store.append([str(z.get("name", "Unnamed"))])
        tree = Gtk.TreeView(model=store)
        col = Gtk.TreeViewColumn("Zone", Gtk.CellRendererText(), text=0)
        tree.append_column(col)
        tree.get_selection().set_mode(Gtk.SelectionMode.SINGLE)
        # Pre-select the active zone if there is one
        active = self.canvas.active_zone
        if active is not None:
            aname = str(active.get("name", ""))
            for i, z in enumerate(self.zones):
                if str(z.get("name", "")) == aname:
                    tree.get_selection().select_path(
                        Gtk.TreePath.new_from_string(str(i)))
                    break
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_min_content_height(220)
        scrolled.add(tree)
        box.pack_start(scrolled, True, True, 0)

        box.show_all()
        resp = dlg.run()
        sel = tree.get_selection().get_selected()
        dlg.destroy()

        if resp == Gtk.ResponseType.OK and sel[0] is not None:
            model, tree_iter = sel
            path = model.get_path(tree_iter)
            idx = path.get_indices()[0] if path is not None else -1
            if 0 <= idx < len(self.zones):
                self._apply_zone(self.zones[idx])
        elif resp == Gtk.ResponseType.REJECT:
            self._apply_zone(None)
        # Cancel: keep whatever zone (or full map) is current.

    def _apply_zone(self, zone):
        """Zoom the map to a zone (or the full map if None)."""
        self.canvas.set_active_zone(zone)
        if zone is not None:
            self.canvas.fit_zone(zone)
            zname = str(zone.get("name", "Unnamed"))
            self.zone_label.set_text(f"Zone: {zname}")
            self.app_window._set_status(
                f"Working in zone '{zname}'.")
        else:
            self.canvas.fit_world(data.WORLD_X0, data.WORLD_Z0,
                                  data.WORLD_X1, data.WORLD_Z1)
            self.zone_label.set_text("Zone: (full map)")
            self.app_window._set_status("Showing the full map.")

    def _save(self):
        """
        Persist subdivisions locally AND mark the game-repo copy
        dirty (v1.6.0): the round trip pushes them to
        editors/building-editor/subdivisions.json in adamsville-play.
        """
        data.save_subdivisions(self.subdivisions)
        try:
            store = self.app_window.zone_store
            if store is not None:
                store.subdivisions = list(self.subdivisions)
                store.subdivisions_dirty = True
            self.app_window._mark_unpublished()
        except Exception:
            pass

    def _on_generate_houses(self, widget):
        """
        Bake this subdivision's houses into the zone building files
        (v1.6.0): generated houses become real placed buildings in
        whichever zone contains them, saved by the same round trip
        as any other placement. (Up to 1.5.2 subdivisions were only
        definitions the game was expected to spawn from — Joshua's
        rule now is that placed/generated buildings are BAKED into
        game data permanently.)
        """
        idx = self._selected_index()
        store = self.app_window.zone_store
        if idx is None or idx >= len(self.subdivisions):
            self.app_window._set_status("Select a subdivision first.")
            return
        if store is None:
            self.app_window._set_status("Zone data has not loaded yet.")
            return
        sub = self.subdivisions[idx]
        try:
            n = store.bake_subdivision(sub)
        except Exception as e:
            self.app_window._set_status(f"Generate failed: {e}")
            return
        self.app_window._mark_unpublished()
        if self.app_window.zone_tab is not None:
            self.app_window.zone_tab.refresh()
        self.app_window._set_status(
            f"Baked {n} houses from '{sub.get('name', '')}' into the "
            f"zone building data (unsaved until the next save).")

    def _selected_index(self):
        """Index of the selected subdivision, or None."""
        return self.canvas.selected

    # -- canvas callbacks ---------------------------------------------------

    def _on_polygon_done(self, points):
        """
        Joshua finished drawing a polygon. Ask for a name and style,
        then create the subdivision.
        """
        dlg = Gtk.Dialog(title="New Subdivision",
                         transient_for=self.app_window, flags=0)
        dlg.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dlg.add_button("Create", Gtk.ResponseType.OK)
        dlg.set_default_size(320, 160)

        box = dlg.get_content_area()
        box.set_border_width(10)
        box.set_spacing(8)

        name_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                           spacing=8)
        name_row.pack_start(Gtk.Label(label="Name:"), False, False, 0)
        name_entry = Gtk.Entry()
        # Suggest the next available name
        existing = {s.get("name", "") for s in self.subdivisions}
        n = 1
        while f"Subdivision {n}" in existing:
            n += 1
        name_entry.set_text(f"Subdivision {n}")
        name_row.pack_start(name_entry, True, True, 0)
        box.pack_start(name_row, False, False, 0)

        style_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                            spacing=8)
        style_row.pack_start(Gtk.Label(label="House style:"),
                             False, False, 0)
        style_combo = Gtk.ComboBoxText()
        for s in HOUSE_STYLES:
            style_combo.append_text(s)
        style_combo.set_active(0)
        style_row.pack_start(style_combo, True, True, 0)
        box.pack_start(style_row, False, False, 0)

        # Warn if roads cross the drawn area — helps Joshua pick
        # better subdivision spots (Joshua 2026-10-11).
        road_count = data.count_roads_in_polygon(points)
        if road_count > 0:
            warn = Gtk.Label()
            warn.set_markup(
                f"<b>⚠ {road_count} road(s) cross this area.</b>")
            warn.set_line_wrap(True)
            box.pack_start(warn, False, False, 0)

        box.show_all()
        resp = dlg.run()
        name = name_entry.get_text().strip()
        style = style_combo.get_active_text()
        dlg.destroy()

        # Back to select mode regardless
        self.draw_btn.set_active(False)

        if resp != Gtk.ResponseType.OK or not name:
            self.app_window._set_status("Subdivision creation cancelled.")
            return

        new_sub = {"name": name,
                   "polygon": [[float(p[0]), float(p[1])] for p in points],
                   "style": style or HOUSE_STYLES[0]}
        self.subdivisions.append(new_sub)
        self._save()
        self.canvas.selected = len(self.subdivisions) - 1
        self._refresh()
        self._sync_editor()
        self.app_window._set_status(
            f"Subdivision '{name}' created ({style}).")

    def _on_subdivision_click(self, index):
        """Canvas click: select the subdivision (or deselect)."""
        self.canvas.selected = index
        # Sync the list selection without firing the changed handler twice
        sel = self.tree.get_selection()
        if index is None:
            sel.unselect_all()
        else:
            sel.select_path(Gtk.TreePath.new_from_string(str(index)))
        self.canvas.queue_draw()
        self._sync_editor()

    # -- panel callbacks ----------------------------------------------------

    def _on_draw_toggled(self, button):
        """Toggle between draw and select mode on the canvas."""
        self.canvas.set_mode("draw" if button.get_active() else "select")

    def _on_fit(self, widget):
        """Zoom the map to fit the whole world."""
        self.canvas.fit_world(data.WORLD_X0, data.WORLD_Z0,
                              data.WORLD_X1, data.WORLD_Z1)

    def _on_list_select(self, selection):
        """List click: select the subdivision on the map."""
        model, treeiter = selection.get_selected()
        if treeiter is None:
            self.canvas.selected = None
        else:
            path = model.get_path(treeiter)
            self.canvas.selected = path.get_indices()[0]
        self.canvas.queue_draw()
        self._sync_editor()

    def _sync_editor(self):
        """
        Update the name/style editor controls from the selected
        subdivision (block signals to avoid feedback loops).
        """
        idx = self._selected_index()
        if idx is None or not (0 <= idx < len(self.subdivisions)):
            self.name_entry.set_text("")
            self.style_combo.set_active(-1)
            return
        sub = self.subdivisions[idx]
        # Block the changed handlers while we set values
        self.name_entry.handler_block_by_func(self._on_name_changed)
        self.name_entry.set_text(sub.get("name", ""))
        self.name_entry.handler_unblock_by_func(self._on_name_changed)
        style = sub.get("style", "")
        try:
            active = HOUSE_STYLES.index(style)
        except ValueError:
            active = -1
        self.style_combo.handler_block_by_func(self._on_style_changed)
        self.style_combo.set_active(active)
        self.style_combo.handler_unblock_by_func(self._on_style_changed)

    def _on_name_changed(self, entry):
        """Rename the selected subdivision as Joshua types."""
        idx = self._selected_index()
        if idx is not None and 0 <= idx < len(self.subdivisions):
            self.subdivisions[idx]["name"] = entry.get_text()
            self._save()
            # Update the list row and canvas label
            self.store[idx][0] = entry.get_text()
            self.canvas.queue_draw()

    def _on_style_changed(self, combo):
        """Change the selected subdivision's house style."""
        idx = self._selected_index()
        text = combo.get_active_text()
        if idx is not None and text and 0 <= idx < len(self.subdivisions):
            self.subdivisions[idx]["style"] = text
            self._save()
            self.store[idx][1] = text

    def _on_delete(self, widget):
        """Delete the selected subdivision (with confirmation)."""
        idx = self._selected_index()
        if idx is None or not (0 <= idx < len(self.subdivisions)):
            self.app_window._set_status("No subdivision selected.")
            return
        name = self.subdivisions[idx].get("name", "")
        dlg = Gtk.MessageDialog(
            transient_for=self.app_window,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.YES_NO,
            text=f"Delete subdivision '{name}'?")
        resp = dlg.run()
        dlg.destroy()
        if resp == Gtk.ResponseType.YES:
            del self.subdivisions[idx]
            self.canvas.selected = None
            self._save()
            self._refresh()
            self._sync_editor()
            self.app_window._set_status(f"Deleted '{name}'.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    """Launch the asset editor."""
    # v1.5.2 (Joshua 2026-10-12): crash logger. If the editor fails to
    # start on Joshua's machine, the traceback is written to
    # ~/.cache/adamsville-building-editor-native/crash.log so the real
    # cause can be diagnosed instead of failing silently.
    try:
        data.ensure_data_dir()
        win = AssetEditorWindow()
        win.connect("destroy", Gtk.main_quit)
        win.show_all()
        Gtk.main()
    except Exception:
        try:
            import traceback
            from pathlib import Path
            log_dir = Path.home() / ".cache" / "adamsville-building-editor-native"
            log_dir.mkdir(parents=True, exist_ok=True)
            with open(log_dir / "crash.log", "w") as f:
                f.write("Adamsville Building Editor %s crash log\n" % APP_VERSION)
                traceback.print_exc(file=f)
        except Exception:
            pass
        raise


if __name__ == "__main__":
    main()
