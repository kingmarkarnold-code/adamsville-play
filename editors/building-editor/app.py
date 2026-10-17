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
from gi.repository import Gtk, Gdk, GLib, Pango

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
APP_VERSION = "1.7.1"

# ---------------------------------------------------------------------------
# THE EDITOR UI RULE (Joshua, 2026-10-16 — standing suite principle):
#   * any pane whose content is LONG must be SCROLLABLE;
#   * any GRAPHICAL pane must be ADJUSTABLE (he can drag a divider
#     and resize its space himself);
#   * nothing is ever clipped out of reach: if a layout comes out
#     wrong, he can always scroll or drag his way to the hidden part.
# 1.7.1 exists because 1.7.0 broke this rule three ways at once: the
# Zone Buildings split divider was mathematically pinned (both panes
# packed shrink=False with minimums summing past a 1366px screen —
# measured 0px of divider travel and a 1527px window minimum), the
# maximized window overflowed his screen, and the Open Building
# dialog gave its Categories pane 46px. Every layout built below
# follows the rule: lists/text live in Gtk.ScrolledWindow, graphical
# panes live in Gtk.Paned with shrink=True on both children, and
# labels that carry long single-line text ellipsize (full text on
# the tooltip) instead of forcing the window wider.
# ---------------------------------------------------------------------------
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
# Legacy building categories (1.7.0: subcategory browsing in Open Building)
# ---------------------------------------------------------------------------
# The legacy detailed-asset buildings carry an editor type name
# ("House", "Store", ...). zonedata.EDITOR_TYPE_MAP maps each type
# name onto the game's numeric type code, so a legacy building's
# category is that code's label (zonedata.CODE_LABELS). An unknown
# type falls back to code 3 ("Other / special").

def legacy_building_category_id(building):
    """Category id for one legacy building dict, as a string:
    "0".."3" from its type's zonedata code, or "walkable" is NOT
    returned here (walkable is a cross-cutting extra category the
    dialog adds on top of the code categories)."""
    # Look the type name up in the editor->game type map; a missing
    # zonedata module or an unknown type both land on code 3.
    if zonedata is not None:
        code = zonedata.EDITOR_TYPE_MAP.get(
            building.get("type"), (3, ""))[0]
    else:
        code = 3
    return str(code)


def legacy_building_categories(buildings):
    """
    The Open Building dialog's category list: [(label, category_id)]
    with "All buildings" always first, then each non-empty code
    category in code order (labels exactly zonedata.CODE_LABELS
    values), then "Walkable (enterable)" when any building is
    walkable. category_id is one of "all", "0", "1", "2", "3",
    "walkable".
    """
    cats = [("All buildings", "all")]
    # Count buildings per code so empty categories are not listed.
    counts = {}
    for b in buildings:
        cid = legacy_building_category_id(b)
        counts[cid] = counts.get(cid, 0) + 1
    labels = zonedata.CODE_LABELS if zonedata is not None else {
        0: "Residential / generic", 1: "Commercial",
        2: "Multi-unit / institutional", 3: "Other / special"}
    for code in (0, 1, 2, 3):
        if counts.get(str(code)):
            cats.append((labels[code], str(code)))
    # Walkable (enterable) cuts across the code categories.
    if any(b.get("walkable") for b in buildings):
        cats.append(("Walkable (enterable)", "walkable"))
    return cats


def legacy_building_in_category(building, category_id):
    """True when a legacy building belongs in a dialog category."""
    if category_id == "all":
        return True
    if category_id == "walkable":
        return bool(building.get("walkable"))
    return legacy_building_category_id(building) == category_id


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
        # 1.7.1: design-set sync baseline — design_hash() of the
        # design set GitHub is known to hold (set by the
        # download-on-open in _load_data and by every verified
        # save). None until the first successful sync; the dirty
        # check (_design_dirty) treats that case separately.
        self._design_remote_hash = None
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
        Load buildings: download-on-open for the design set
        (1.7.1), then load the effective set (downloaded base +
        local edits overlay) from the local cache.

        1.7.1: the design set has a GitHub home again (data.py —
        editors/building-editor/design-buildings.json), so opening
        the app downloads it first, silently, like the zone data.
        The old first-launch prompt is gone with the retired remote
        it belonged to (its needs_download() stub had made it
        unreachable anyway). A failed download falls back to the
        local cache / built-in samples with an honest status; a
        successful one sets the sync baseline (_design_remote_hash)
        the save dirty-check compares against.
        """
        downloaded, err = None, None
        try:
            downloaded, err = data.download_design_buildings(
                github_sync.fetch_file)
        except Exception as e:
            # A transport-level blowup must never stop the app
            # opening — the local copy is the fallback.
            err = str(e)
        # The download outcome rides on the Loaded status below
        # (a status set here would be overwritten by it instantly).
        dl_note = ""
        if downloaded is not None:
            self._design_remote_hash = data.design_hash(downloaded)
            dl_note = " Design set downloaded from GitHub."
        elif err:
            dl_note = (f" Design set download failed ({err}) — "
                       f"local copy in use.")
        self.buildings = data.load_buildings()
        self._set_status(
            f"Loaded {len(self.buildings)} buildings.{dl_note}")
        # Road data for collision checks + preview context (Joshua
        # 2026-10-11). Silent download on first run — auxiliary data.
        self.road_index = []
        try:
            self.road_index = data.get_road_index()
            if self.road_index:
                self._set_status(
                    f"Loaded {len(self.buildings)} buildings, "
                    f"{len(self.road_index)} roads.{dl_note}")
        except Exception:
            pass  # offline or failed — collision checks just skip

    # -- v1.6.0 game zone data -------------------------------------------

    def _load_zone_data(self):
        """
        Download-on-open for the GAME's building files (Joshua's
        standing rule): every zone's buildings/detail/hero/zone/
        roads files plus the editor subdivisions file are fetched
        from adamsville-play. 1.6.1: NO single pinned connection —
        each file is fetched on its own fresh connection (opened
        and closed by github_sync per request, with bounded retries
        on network errors inside zonedata.download_on_open), the
        design that fixed the Map Editor's download-on-open; one
        shared keep-alive connection could die mid-download and
        take every zone with it. Runs on a worker thread; the Zone
        Buildings tab is added on the GTK thread when it lands.
        """
        if not _ZONEDATA_AVAILABLE:
            return
        import threading
        from gi.repository import GLib

        def worker():
            store = zonedata.GameStore()
            try:
                # No conn= kwarg: github_sync.fetch_file runs each
                # request on its own fresh one-shot connection.
                errors = store.download_on_open(github_sync.fetch_file)
            except Exception as e:
                errors = {"all zones": str(e)}

            def done():
                self.zone_store = store
                self.zone_tab = ZoneBuildingsTab(self)
                label = Gtk.Label(label="Zone Buildings (game data)")
                self.notebook.append_page(self.zone_tab, label)
                self.zone_tab.show_all()
                loaded = len(store.zones)
                if errors:
                    # 1.6.1: surface the REAL failure — each error
                    # names the repo path and GitHub's own message
                    # (zonedata records "<path>: <reason>") — never
                    # a bare "check your connection".
                    detail = "; ".join(
                        f"{zone} — {errors[zone]}"
                        for zone in sorted(errors))
                    self._set_status(
                        f"Zone data: {loaded} zones loaded; "
                        f"failed: {detail}")
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

    # -- THE SAVE: zone data + the design set --------------------------

    def _design_dirty(self):
        """
        True when the live design set differs from the set GitHub
        is known to hold. The comparison hashes the canonical
        payload (data.design_hash) — the exact bytes a push would
        send — so formatting can never fake or hide a change.
        Before the first successful sync this session, only the
        local edits overlay can hold unpublished design work.
        """
        if self._design_remote_hash is None:
            return bool(data.load_edits())
        return (data.design_hash(self.buildings)
                != self._design_remote_hash)

    def _round_trip_work(self):
        """
        Run the whole save. NO GTK calls in here — it runs on the
        save worker thread, and synchronously on the quit path
        (see _on_close). Returns (ok, message, design_proof).

        TWO legs, each a full standing-rule round trip:
          1. the game zone store (zonedata.GameStore — dirty zones
             + the subdivisions file), as since 1.6.0;
          2. the DESIGN set (data.design_round_trip) — NEW in
             1.7.1. Before this, design edits were in NO target
             list: "Push & Close" after a roof-colour change ran
             leg 1 only, found nothing to do, and reported success
             while the design edit never left the laptop.
        The design leg runs only when the zone leg succeeded (or
        there is no zone store): a half-save must read as one
        honest failure, not two confusing halves.
        """
        msgs = []
        ok_all = True
        proof = None
        if self.zone_store is not None:
            ok, msg, _fresh = self.zone_store.round_trip_save(
                data.DATA_DIR / "zone-cache",
                github_sync.open_connection,
                github_sync.push_targets,
                github_sync.fetch_file)
            msgs.append(msg)
            ok_all = ok
        if self._design_dirty():
            if ok_all:
                ok2, msg2, proof = data.design_round_trip(
                    self.buildings,
                    github_sync.open_connection,
                    github_sync.push_targets,
                    github_sync.fetch_file)
                msgs.append(msg2)
                ok_all = ok_all and ok2
            else:
                msgs.append(
                    "Design buildings were NOT pushed (the zone "
                    "save failed first — fix that and save again).")
                ok_all = False
        if not msgs:
            msgs.append("Nothing to save — no changes.")
        return ok_all, " ".join(msgs), proof

    def _round_trip_apply(self, ok, msg, proof):
        """GTK-thread half of the save: adopt the proof copies,
        refresh the views, set the status. The app shows what
        GitHub holds — that is the point of the round trip."""
        if proof is not None:
            data.merge_proof_into(self.buildings, proof)
            self._design_remote_hash = data.design_hash(proof)
        if ok:
            self._unpublished = False
            if self.zone_tab is not None:
                self.zone_tab.refresh()
        self._set_status(msg if ok else f"Save failed: {msg}")

    def round_trip_save(self):
        """
        THE save (v1.6.0 zone round trip + 1.7.1 design-set leg):
        local save -> push on one connection -> close -> re-download
        on a fresh connection -> refresh the view from the proof
        copy — for BOTH data sets this editor edits. Stage-accurate
        failure messages come back verbatim. Runs on a worker
        thread; the result is applied on the GTK thread. Returns
        True when a round trip started.
        """
        if self.zone_store is None and not self._design_dirty():
            self._set_status("Nothing to save yet — data is "
                             "still loading.")
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
            result = self._round_trip_work()

            def done():
                self._round_trip_apply(*result)
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

        1.7.0: the old flat single list is now a TWO-PANE browser —
        subcategories on the left (All / the four game type-code
        groups / Walkable), the buildings in the chosen subcategory
        on the right. The right-hand store carries a hidden column
        with the building's index in self.buildings, so two
        buildings sharing a name can never open the wrong one (the
        old dialog resolved by name).
        """
        if not self.buildings:
            self._set_status("No buildings loaded.")
            return

        # --- Dialog shell (same entry point / buttons as before) ---
        dlg = Gtk.Dialog(title="Open Building", transient_for=self,
                         flags=0)
        dlg.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dlg.add_button("Open", Gtk.ResponseType.OK)
        # 1.7.1: bigger default and explicitly resizable, so the two
        # panes below have room to share evenly (EDITOR UI RULE).
        dlg.set_default_size(640, 440)
        dlg.set_resizable(True)

        # --- Left pane: the subcategory list -------------------------
        # Rows are (label, category_id); see the module-level
        # legacy_building_categories() helper for how they are built.
        cat_store = Gtk.ListStore(str, str)
        for label, cid in legacy_building_categories(self.buildings):
            cat_store.append([label, cid])
        cat_tree = Gtk.TreeView(model=cat_store)
        cat_tree.append_column(Gtk.TreeViewColumn(
            "Category", Gtk.CellRendererText(), text=0))
        cat_tree.get_selection().set_mode(Gtk.SelectionMode.SINGLE)

        # --- Right pane: buildings in the chosen subcategory ---------
        # Rows are (name, index_into_self.buildings); the index
        # column is the duplicate-safe resolution back to the dict.
        bld_store = Gtk.ListStore(str, int)
        bld_tree = Gtk.TreeView(model=bld_store)
        bld_tree.append_column(Gtk.TreeViewColumn(
            "Building", Gtk.CellRendererText(), text=0))
        bld_tree.get_selection().set_mode(Gtk.SelectionMode.SINGLE)
        # Double-click a building row to open it immediately.
        bld_tree.connect(
            "row-activated",
            lambda tv, path, col: dlg.response(Gtk.ResponseType.OK))

        def refill(category_id):
            """Refill the right pane with one subcategory's buildings."""
            bld_store.clear()
            for idx, b in enumerate(self.buildings):
                if legacy_building_in_category(b, category_id):
                    bld_store.append([b.get("name", "Unnamed"), idx])

        def on_category_changed(selection):
            """Category selection changed -> refill the right pane."""
            model, it = selection.get_selected()
            if it is not None:
                refill(model.get_value(it, 1))
        cat_tree.get_selection().connect("changed", on_category_changed)

        # --- Lay the two panes out side by side -----------------------
        # 1.7.1 LAYOUT FIX (Joshua live report, 2026-10-16): 1.7.0
        # packed the Categories pane resize=False/shrink=False, so
        # GtkPaned gave it exactly its bare minimum request —
        # measured 46px against the Buildings pane's 489px, leaving
        # the category text "barely readable". Per the EDITOR UI
        # RULE both panes are graphical/list space he adjusts: both
        # pack resize=True/shrink=True on a draggable divider, and
        # the divider starts at an EVEN 50/50 split (set once the
        # dialog has its real width — see the idle callback below).
        paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        paned.set_wide_handle(True)
        cat_scroll = Gtk.ScrolledWindow()
        cat_scroll.add(cat_tree)
        paned.pack1(cat_scroll, True, True)
        bld_scroll = Gtk.ScrolledWindow()
        bld_scroll.add(bld_tree)
        paned.pack2(bld_scroll, True, True)
        dlg.get_content_area().pack_start(paned, True, True, 0)
        dlg.show_all()

        def _even_split():
            """One-shot idle: start the divider at half the width."""
            width = paned.get_allocated_width()
            if width > 0:
                paned.set_position(width // 2)
            return False
        GLib.idle_add(_even_split)
        # Start on "All buildings" (always the first category row).
        cat_tree.get_selection().select_path(Gtk.TreePath.new_first())

        resp = dlg.run()
        sel = bld_tree.get_selection().get_selected()
        dlg.destroy()

        if resp != Gtk.ResponseType.OK or not sel or not sel[1]:
            return
        # Resolve by the hidden index column, never by name.
        idx = bld_store[sel[1]][1]
        if 0 <= idx < len(self.buildings):
            self.open_building_tab(self.buildings[idx])

    def open_building_tab(self, building):
        """
        Open a building in a new tab. If it's already open, just
        switch to that tab.

        1.7.0 fixes: (a) the already-open switch uses
        notebook.page_num(tab) — notebook page numbers are NOT
        open_tabs indices since the Zone Buildings tab occupies a
        notebook page outside open_tabs; (b) a BuildingTab that
        fails to build is reported in the status bar (with the
        traceback on stderr) instead of dying silently — this is
        how the 1.6.x BUTTON3_MASK crash hid; (c) the order is
        append -> show_all -> set_current_page, because on GTK 3.24
        set_current_page issued before show_all does not take
        effect and the opened tab never came to the front.
        """
        # Already open? Switch to it — by its real notebook page.
        for tab in self.open_tabs:
            if getattr(tab, "building", None) is building:
                self.notebook.set_current_page(
                    self.notebook.page_num(tab))
                return

        # Build the tab; surface any failure instead of hiding it.
        try:
            tab = BuildingTab(self, building)
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._set_status(
                f"Could not open '{building.get('name', 'Unnamed')}': {e}")
            return
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

        # Append, THEN show, THEN focus (order matters, see docstring).
        page_num = self.notebook.append_page(tab, label_box)
        self.notebook.show_all()
        self.notebook.set_current_page(page_num)
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
        """
        Menu action: close the currently visible tab.

        1.7.0 fix: the old code indexed open_tabs by the notebook's
        current page number, but notebook pages and open_tabs are
        different lists — the Zone Buildings tab occupies a notebook
        page without being in open_tabs, so the indices drift and
        this could close the WRONG tab (or pretend to close the Zone
        tab). Resolve the current page's child widget first and only
        close it when it really is one of the open_tabs.
        """
        child = self.notebook.get_nth_page(
            self.notebook.get_current_page())
        if child is not None and child in self.open_tabs:
            self.close_tab(child)
        else:
            self._set_status(
                "This tab can't be closed (use its × button if it "
                "has one).")

    def _on_open_subdivisions(self, widget=None):
        """
        Open the Subdivisions tab (2D map). Only one instance —
        switches to it if already open.

        1.7.0: same three fixes as open_building_tab — switch by
        notebook.page_num (not the open_tabs index), surface a
        construction failure in the status bar instead of dying
        silently, and append -> show_all -> set_current_page so the
        tab actually comes to the front on GTK 3.24.
        """
        # Already open? Switch by its real notebook page number.
        for tab in self.open_tabs:
            if isinstance(tab, SubdivisionTab):
                self.notebook.set_current_page(
                    self.notebook.page_num(tab))
                return
        # Build the tab; surface any failure instead of hiding it.
        try:
            tab = SubdivisionTab(self)
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._set_status(f"Could not open 'Subdivisions': {e}")
            return
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

        # Append, THEN show, THEN focus (order matters, see above).
        page_num = self.notebook.append_page(tab, label_box)
        self.notebook.show_all()
        self.notebook.set_current_page(page_num)
        self._set_status("Subdivisions map opened.")
        # Zone-first workflow (v1.2.0): ask which zone to work in
        # once the tab is on screen.
        GLib.idle_add(tab.maybe_show_zone_picker)

    # -- push to GitHub (copy/download JSON protocol) -------------------

    def _on_push(self, widget):
        """
        File -> Push to GitHub…: with a suite token this runs the
        real round-trip save (zones + design set, 1.7.1). Only
        without a token does it fall back to the manual export
        dialog below (copy/download the payload JSON by hand).
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
                # 1.7.1: push SYNCHRONOUSLY, before the window is
                # allowed to close. The old code called _on_push,
                # which (with a token) merely STARTED the threaded
                # round trip and let the close proceed — process
                # exit could kill the push mid-flight, and (before
                # the 1.7.1 design leg) the design set was not in
                # the save at all. "Push & Close" must mean the
                # push FINISHED; the quit path pays the few seconds
                # the round trip takes. Without a token there is no
                # API push to wait for — fall back to the manual
                # export dialog, as before.
                if github_sync.has_token():
                    self._round_trip_apply(*self._round_trip_work())
                else:
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

    # (The 1.6.0-era _push_targets() helper is gone in 1.7.1: it
    # had no callers since the GameStore took over target building,
    # and its "design set is never pushed" rationale is exactly
    # what the design leg in _round_trip_work reverses.)

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
# v1.7.0: ZoneInspectorPanel — the selected zone building, in 3D
# ---------------------------------------------------------------------------

class ZoneInspectorPanel(Gtk.Box):
    """
    Visual inspector for one zone building, shown in the RIGHT pane
    of the Zone Buildings tab's split view (Joshua's design, as
    corrected 2026-10-16): selecting a building makes the tab a
    split pane — the data column stays fully present and editable
    on the left (NOTHING is hidden or collapsed), and this panel
    shows the building itself on the right.

    THE VIEW IS 3D, software-rendered with cairo (no OpenGL — this
    is a low-resource GTK app):
      * the building is a shaded EXTRUSION of its real footprint
        ring (the detail ring) up to its real height;
      * it sits IN ITS CURRENT LOCATION: a ground plane under it
        carries the neighbouring road polylines from zd.roads,
        projected onto the ground;
      * side faces are shaded by a simple fixed light according to
        each face's orientation; the roof is the ring polygon at
        full height, in its own tone;
      * the FRONT wall (the extruded face over the front edge from
        zonedata.building_front) is ALWAYS warm orange — a permanent
        colour property of that face, whatever the camera angle —
        plus a "FRONT" label and a ground-level arrow pointing at
        the front face, so the front is identifiable while orbiting.

    CAMERA (Joshua's amendment, 2026-10-16):
      * NO AUTO-ROTATION, EVER: no timer, no idle animation, no
        turntable. The camera moves ONLY when Joshua drags on the
        view. `auto_rotate` is False and `_rotate_timer_id` is None
        — permanently; the smoke test asserts both.
      * FRONT-ON DEFAULT: on every show_building() the azimuth is
        reset to `front_azimuth`, computed from the front edge's
        OUTWARD NORMAL (away from the ring centroid), so the front
        wall faces the viewer, with an oblique elevation (~30°) so
        the front wall, the roof, and one side are all visible.
        When no front can be derived, the fallback is a documented
        default: the camera sits to the SOUTH of the building
        (azimuth = +pi/2 in the x/z plane, i.e. looking north).
      * MANUAL ORBIT: drag on the drawing area — horizontal drag
        changes the azimuth, vertical drag changes the elevation,
        clamped to 10°..60°. A "Face front" button snaps back to
        the front-on view.
      * Projection is a hand-rolled orthographic oblique
        projection: for a ground point (dx, dz) relative to the
        footprint centroid and height h, with camera azimuth A
        (radians, in the x/z plane, atan2(z, x) convention) and
        elevation E (radians):
            along  = dx*cos(A) + dz*sin(A)   (toward the camera)
            across = dx*sin(A) - dz*cos(A)   (screen-right)
            screen_x = cx + scale * across
            screen_y = cy + scale * (along*sin(E) - h*cos(E))
        Painter's algorithm: ground, roads, front arrow, then wall
        faces sorted by average view depth (farthest first), roof
        last among the building faces.

    Documented state for the smoke test: `view_mode` ("3d"),
    `index`, `front_info` (the zonedata.building_front dict),
    `front_edge`, `azimuth` and `front_azimuth` (radians),
    `elevation` (radians), `auto_rotate` (False),
    `_rotate_timer_id` (None).
    """

    # The view is a 3D view (asserted by the smoke test).
    view_mode = "3d"
    # No auto-rotation exists in this panel — ever (see class docs).
    auto_rotate = False

    # Default oblique elevation when a building is shown (~30°).
    DEFAULT_ELEVATION = math.radians(30.0)
    # Fallback azimuth when no front can be derived: the camera
    # sits due SOUTH of the building (in the x/z plane the south
    # direction is +z, whose atan2(z, x) angle is +pi/2).
    DEFAULT_AZIMUTH = math.radians(90.0)
    # Elevation clamp for manual orbiting (10°..60°).
    MIN_ELEVATION = math.radians(10.0)
    MAX_ELEVATION = math.radians(60.0)

    def __init__(self, tab):
        """tab: the ZoneBuildingsTab that owns this panel."""
        super().__init__(orientation=Gtk.Orientation.VERTICAL,
                         spacing=6)
        self.set_border_width(8)
        # 1.7.1 LAYOUT FIX (EDITOR UI RULE): 1.7.0 gave this panel a
        # hard 400px width request and the split packed it
        # shrink=False — with the data column's own minimum added,
        # the divider had ZERO travel and the window's minimum width
        # measured 1527px on a 1366px screen (see the rule block at
        # the top of this file). The panel now requests only a
        # modest 240px floor; the paned (shrink=True) and Joshua's
        # drag decide its real size (default ~320px when it opens —
        # see ZoneBuildingsTab._position_inspector).
        self.set_size_request(240, -1)
        # Back-reference to the owning tab (zone + store access).
        self.tab = tab

        # --- Documented view state (see the class docstring) ------
        self.index = None            # zone building index shown
        self.zd = None               # the ZoneData it belongs to
        self.box = None              # [x, z, w, d, h, type_code]
        self.detail = None           # the detail dict (ring etc.)
        self.flagged_entry = None    # flagged entry, or None
        self.front_info = None       # zonedata.building_front dict
        self.front_edge = None       # (p1, p2) or None
        # Camera: azimuth/elevation in RADIANS (see class docstring
        # for the projection and the azimuth convention).
        self.azimuth = self.DEFAULT_AZIMUTH
        self.front_azimuth = self.DEFAULT_AZIMUTH
        self.elevation = self.DEFAULT_ELEVATION
        # No auto-rotation timer exists; this stays None forever.
        self._rotate_timer_id = None
        # Drag-orbit state: (start_x, start_y, start_az, start_el)
        # while a drag is in progress, else None.
        self._drag = None

        # --- Header row: title + close button ----------------------
        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                         spacing=6)
        self.title_label = Gtk.Label()
        self.title_label.set_markup("<b>Building</b>")
        self.title_label.set_halign(Gtk.Align.START)
        # A long building name must ellipsize, not widen the panel
        # (EDITOR UI RULE); the full name is on the tooltip.
        self.title_label.set_ellipsize(Pango.EllipsizeMode.END)
        header.pack_start(self.title_label, True, True, 0)
        close_btn = Gtk.Button(label="✕")
        close_btn.set_relief(Gtk.ReliefStyle.NONE)
        # Closing only hides THIS panel; the data column never hid.
        close_btn.connect("clicked",
                          lambda w: self.tab.hide_inspector())
        header.pack_start(close_btn, False, False, 0)
        self.pack_start(header, False, False, 0)

        # --- FLAGGED badge (visible only for flagged buildings) -----
        self.badge_label = Gtk.Label()
        self.badge_label.set_markup(
            '<span foreground="#b00000"><b>⚠ FLAGGED — locked, '
            'awaiting Joshua\'s decision</b></span>')
        self.badge_label.set_halign(Gtk.Align.START)
        self.pack_start(self.badge_label, False, False, 0)

        # --- The 3D drawing area ------------------------------------
        self.drawing = Gtk.DrawingArea()
        # Minimum height ~320 via the size request (DrawingArea has
        # no set_min_content_height — that is a ScrolledWindow API).
        # The width request is a small floor only: as a graphical
        # pane its real width is the split divider's business
        # (EDITOR UI RULE), and the drawing rescales to whatever
        # space it is given.
        self.drawing.set_size_request(160, 320)
        # Drag-to-orbit needs press / release / motion events.
        self.drawing.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.BUTTON_RELEASE_MASK
            | Gdk.EventMask.POINTER_MOTION_MASK)
        self.drawing.connect("draw", self._on_draw_3d)
        self.drawing.connect("button-press-event",
                             self._on_drag_press)
        self.drawing.connect("button-release-event",
                             self._on_drag_release)
        self.drawing.connect("motion-notify-event",
                             self._on_drag_motion)
        self.pack_start(self.drawing, True, True, 0)

        # --- Controls hint + Face front ------------------------------
        ctrl = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                       spacing=6)
        hint = Gtk.Label(
            label="Drag to rotate — the orange wall is the front")
        hint.set_halign(Gtk.Align.START)
        # Ellipsize rather than force the panel wide (EDITOR UI RULE).
        hint.set_ellipsize(Pango.EllipsizeMode.END)
        ctrl.pack_start(hint, True, True, 0)
        face_btn = Gtk.Button(label="Face front")
        # Snap back to the front-on azimuth computed at show time.
        face_btn.connect("clicked", self._on_face_front)
        ctrl.pack_start(face_btn, False, False, 0)
        self.pack_start(ctrl, False, False, 0)

        # --- Readout labels -------------------------------------------
        # Name / type / size / position, then the road lines. The
        # front line and the flagged line are separate labels so a
        # disagreement between them is shown honestly, not merged.
        self.name_label = Gtk.Label(label="")
        self.type_label = Gtk.Label(label="")
        self.size_label = Gtk.Label(label="")
        self.pos_label = Gtk.Label(label="")
        self.front_line = Gtk.Label(label="")
        self.flagged_line = Gtk.Label(label="")
        for lbl in (self.name_label, self.type_label, self.size_label,
                    self.pos_label, self.front_line, self.flagged_line):
            lbl.set_halign(Gtk.Align.START)
            # 1.7.1 (EDITOR UI RULE): a long single-line fact (a
            # long name, a long road in "Flagged against: ...")
            # ellipsizes inside a narrow pane instead of forcing
            # the panel — and the window — wider. show_building()
            # puts each label's full text on its tooltip.
            lbl.set_ellipsize(Pango.EllipsizeMode.END)
            lbl.set_line_wrap(True)
            self.pack_start(lbl, False, False, 0)

        # --- Footnote: the honest front-derivation note ---------------
        self.footnote = Gtk.Label(
            label="How the front is worked out: converted zone data "
                  "doesn't record a front (or a parking lot), so the "
                  "front shown here is the footprint edge nearest "
                  "to a road — the editor's derivation from "
                  "Joshua's rule that a building's front faces its "
                  "street, not recorded fact.")
        self.footnote.set_line_wrap(True)
        self.footnote.set_halign(Gtk.Align.START)
        # Cap the wrapped label's natural width (a wrapping label
        # still reports its full unwrapped text as NATURAL width —
        # measured 1549px in 1.7.0 — which inflates the panel's
        # natural size for no benefit).
        self.footnote.set_max_width_chars(48)
        self.pack_start(self.footnote, False, False, 4)

    # -- showing a building ----------------------------------------------

    def show_building(self, tab, zd, index, flagged_entry):
        """
        Show zone building `index` from ZoneData `zd`.
        tab: the owning ZoneBuildingsTab. flagged_entry: the
        store.flagged.match() result for this building, or None.
        Recomputes the front, resets the camera FRONT-ON (azimuth =
        front_azimuth), fills the readouts, and queues a redraw.
        """
        # Store the state the draw handler and the test rely on.
        self.tab = tab
        self.zd = zd
        self.index = index
        self.box = zd.boxes[index]
        self.detail = zd.details[index]
        self.flagged_entry = flagged_entry
        # The front derivation (zonedata, pure geometry).
        self.front_info = zonedata.building_front(
            zd, index, flagged_entry)
        self.front_edge = self.front_info.get("front_edge")

        # --- Front-on camera (recomputed on EVERY show) -------------
        # The front edge's outward normal points away from the ring
        # centroid; the camera sits along that normal, so its
        # azimuth is the normal's atan2(z, x) angle.
        if self.front_edge is not None:
            ring = self.detail.get("ring") or []
            cx, cz = zonedata.ring_centroid(ring)
            (x1, z1), (x2, z2) = self.front_edge
            nx = (x1 + x2) / 2.0 - cx
            nz = (z1 + z2) / 2.0 - cz
            if nx or nz:
                self.front_azimuth = math.atan2(nz, nx)
            else:
                # Degenerate: midpoint ON the centroid — fall back.
                self.front_azimuth = self.DEFAULT_AZIMUTH
        else:
            # No front derivable — documented south fallback.
            self.front_azimuth = self.DEFAULT_AZIMUTH
        # The initial view IS the front view; elevation is oblique.
        self.azimuth = self.front_azimuth
        self.elevation = self.DEFAULT_ELEVATION
        self._drag = None

        # --- Header, badge, readouts ----------------------------------
        box, det = self.box, self.detail
        name = det.get("name") or f"Building #{index}"
        self.title_label.set_markup(f"<b>{name}</b>")
        # The badge shows only when this building is flagged.
        self.badge_label.set_visible(flagged_entry is not None)
        self.name_label.set_text(f"Name: {name}")
        code_label = zonedata.CODE_LABELS.get(box[5], "?")
        self.type_label.set_text(
            f"Type: {code_label} (OSM: {det.get('osm_type') or '?'})")
        # Height: the box height and the detail height agree in
        # valid data; show the box height as the building's height.
        self.size_label.set_text(
            f"Size: {box[2]:.1f} × {box[3]:.1f} — "
            f"height ≈ {box[4]:.1f} m")
        self.pos_label.set_text(
            f"Position: x {box[0]:.1f}, z {box[1]:.1f}")
        # Front road line (the derived front), or the honest
        # can't-be-determined state.
        front_road = self.front_info.get("front_road")
        front_dist = self.front_info.get("front_distance")
        if front_road is not None and front_dist is not None:
            self.front_line.set_text(
                f"Fronts onto: {front_road} (≈ {front_dist:.1f})")
        else:
            self.front_line.set_text(
                "Front can't be determined — no road data nearby.")
        # Flagged road line: only for flagged buildings; shown
        # alongside the front line even when the two disagree.
        if flagged_entry is not None:
            self.flagged_line.set_text(
                f"Flagged against: "
                f"{flagged_entry.get('nearestRoad') or '?'}")
            self.flagged_line.set_visible(True)
        else:
            self.flagged_line.set_visible(False)
        # 1.7.1: the readout labels ellipsize in a narrow pane (see
        # __init__) — mirror each full text onto its tooltip so
        # nothing is ever actually hidden from Joshua.
        self.title_label.set_tooltip_text(name)
        for lbl in (self.name_label, self.type_label, self.size_label,
                    self.pos_label, self.front_line, self.flagged_line):
            lbl.set_tooltip_text(lbl.get_text())

        # Become visible and draw the building.
        self.set_visible(True)
        self.drawing.queue_draw()

    # -- manual orbit (the ONLY way the camera ever moves) -----------------

    def _on_face_front(self, widget):
        """'Face front' button: snap back to the front-on view."""
        # Azimuth back to the front, elevation back to the default.
        self.azimuth = self.front_azimuth
        self.elevation = self.DEFAULT_ELEVATION
        self.drawing.queue_draw()

    def _on_drag_press(self, widget, event):
        """Start a drag-orbit: remember where the drag began and
        what the camera was at that moment."""
        # Only the primary button orbits.
        if event.button != 1:
            return False
        self._drag = (event.x, event.y, self.azimuth, self.elevation)
        return True

    def _on_drag_release(self, widget, event):
        """End a drag-orbit."""
        self._drag = None
        return False

    def _on_drag_motion(self, widget, event):
        """
        Drag-orbit: horizontal movement turns the azimuth, vertical
        movement raises/lowers the elevation (drag up = higher
        camera), clamped to 10°..60°. Redraw on every change. This
        handler — plus the Face front button — is the ONLY code
        that ever changes the camera; there is no timer or idle
        animation anywhere in this panel.
        """
        if self._drag is None:
            return False
        x0, y0, az0, el0 = self._drag
        # ~0.01 rad per pixel feels right for a building-sized view.
        self.azimuth = az0 + (event.x - x0) * 0.01
        self.elevation = max(
            self.MIN_ELEVATION,
            min(self.MAX_ELEVATION, el0 + (y0 - event.y) * 0.01))
        self.drawing.queue_draw()
        return True

    # -- the 3D renderer -----------------------------------------------------

    def _project(self, dx, dz, h, az, el):
        """
        Orthographic oblique projection (see the class docstring):
        returns (across, vertical, depth) in unscaled world units —
        across/depth from the ground plane, vertical including the
        height contribution. `depth` (toward the camera) is the
        painter's-algorithm sort key.
        """
        # Rotate the ground point into camera space.
        along = dx * math.cos(az) + dz * math.sin(az)
        across = dx * math.sin(az) - dz * math.cos(az)
        # Vertical: ground recedes upward at sin(elevation); height
        # rises at cos(elevation).
        vertical = along * math.sin(el) - h * math.cos(el)
        # View depth: how far toward the camera the point sits.
        depth = along * math.cos(el) + h * math.sin(el)
        return across, vertical, depth

    def _on_draw_3d(self, widget, cr):
        """
        Draw the 3D view: ground plane + nearby roads, the front
        arrow, the extruded footprint (walls sorted back-to-front,
        front wall orange), the roof, and the FRONT label.
        All math is guarded against degenerate rings / no roads.
        """
        # Canvas size; nothing sensible to draw at zero size.
        width = widget.get_allocated_width()
        height = widget.get_allocated_height()
        if width < 10 or height < 10:
            return
        # Background: a soft sky-grey wash.
        cr.set_source_rgb(0.92, 0.94, 0.96)
        cr.paint()
        # Without a building there is nothing else to draw.
        if self.zd is None or self.detail is None or self.box is None:
            return

        # --- Gather the geometry --------------------------------------
        # Distinct footprint vertices (drop the closing duplicate).
        ring = self.detail.get("ring") or []
        pts = [list(p) for p in ring if len(p) >= 2]
        if len(pts) > 1 and pts[0] == pts[-1]:
            pts = pts[:-1]
        # Building height (box height; detail height as fallback).
        bheight = float(self.box[4] or self.detail.get("height_m")
                        or 0.0)
        # Road context near the footprint (may be empty).
        nearby = []
        if zonedata is not None:
            nearby = zonedata.nearby_road_segments(
                self.zd, ring, margin=60.0)

        if len(pts) < 2:
            # Degenerate footprint: say so instead of dividing by
            # zero or drawing nonsense.
            cr.set_source_rgb(0.2, 0.2, 0.2)
            cr.set_font_size(13)
            cr.move_to(12, 24)
            cr.show_text("This building has no usable footprint "
                         "to draw.")
            return

        # Local coordinates are relative to the footprint centroid,
        # so the building stays centred whatever its world position.
        cx, cz = zonedata.ring_centroid(ring)
        az, el = self.azimuth, self.elevation

        # Context points for the fit: footprint corners (ground and
        # roof) + nearby road points (ground only).
        context = [(p[0] - cx, p[1] - cz, 0.0) for p in pts]
        context += [(p[0] - cx, p[1] - cz, bheight) for p in pts]
        for _name, road_pts in nearby:
            for p in road_pts:
                if len(p) >= 2:
                    context.append((p[0] - cx, p[1] - cz, 0.0))

        # --- Fit transform (uniform scale + centring, guarded) --------
        proj = [self._project(dx, dz, h, az, el)
                for dx, dz, h in context]
        xs = [q[0] for q in proj]
        ys = [q[1] for q in proj]
        span_x = max(xs) - min(xs)
        span_y = max(ys) - min(ys)
        # Guard zero-size spans (a single point / a flat line).
        span_x = span_x if span_x > 1e-6 else 1.0
        span_y = span_y if span_y > 1e-6 else 1.0
        pad = 28.0
        scale = min((width - 2 * pad) / span_x,
                    (height - 2 * pad) / span_y)
        # Centre the projected bounds in the drawing area.
        mid_x = (max(xs) + min(xs)) / 2.0
        mid_y = (max(ys) + min(ys)) / 2.0

        def to_screen(dx, dz, h):
            """Project a local point to screen coordinates."""
            across, vertical, _depth = self._project(dx, dz, h,
                                                     az, el)
            return (width / 2.0 + (across - mid_x) * scale,
                    height / 2.0 + (vertical - mid_y) * scale)

        # --- Ground plane ------------------------------------------------
        # A quad through the context bounds' corners at h=0, so the
        # building and its roads sit on visible ground.
        gx = [c[0] for c in context]
        gz = [c[1] for c in context]
        # Pad the ground a little past the context.
        gpad_x = max(4.0, 0.08 * (max(gx) - min(gx) or 1.0))
        gpad_z = max(4.0, 0.08 * (max(gz) - min(gz) or 1.0))
        corners = [(min(gx) - gpad_x, min(gz) - gpad_z),
                   (max(gx) + gpad_x, min(gz) - gpad_z),
                   (max(gx) + gpad_x, max(gz) + gpad_z),
                   (min(gx) - gpad_x, max(gz) + gpad_z)]
        ground = [to_screen(dx, dz, 0.0) for dx, dz in corners]
        cr.set_source_rgb(0.78, 0.82, 0.72)
        cr.move_to(*ground[0])
        for s in ground[1:]:
            cr.line_to(*s)
        cr.close_path()
        cr.fill()

        # --- Roads on the ground plane -----------------------------------
        # Light-grey thick polylines; the front road's name is drawn
        # near it when that road is among the nearby ones.
        front_road = (self.front_info or {}).get("front_road")
        for name, road_pts in nearby:
            screen_pts = [to_screen(p[0] - cx, p[1] - cz, 0.0)
                          for p in road_pts if len(p) >= 2]
            if len(screen_pts) < 2:
                continue
            cr.set_source_rgb(0.62, 0.62, 0.62)
            cr.set_line_width(5)
            cr.move_to(*screen_pts[0])
            for s in screen_pts[1:]:
                cr.line_to(*s)
            cr.stroke()
            # Label the front road near its closest drawn point.
            if name == front_road:
                lx, ly = screen_pts[len(screen_pts) // 2]
                cr.set_source_rgb(0.25, 0.25, 0.25)
                cr.set_font_size(11)
                cr.move_to(lx + 4, ly - 4)
                cr.show_text(name)

        # --- Front ground arrow -------------------------------------------
        # From the footprint centroid (ground) out past the front
        # edge midpoint: a ground-level arrow pointing AT the front.
        if self.front_edge is not None:
            (x1, z1), (x2, z2) = self.front_edge
            mx, mz = (x1 + x2) / 2.0, (z1 + z2) / 2.0
            # Outward direction (centroid -> edge midpoint).
            ox, oz = mx - cx, mz - cz
            olen = math.hypot(ox, oz) or 1.0
            # The arrow tip sits a little beyond the front edge.
            tip = (mx - cx + ox / olen * max(3.0, 0.15 * olen),
                   mz - cz + oz / olen * max(3.0, 0.15 * olen))
            a0 = to_screen(0.0, 0.0, 0.0)
            a1 = to_screen(tip[0], tip[1], 0.0)
            cr.set_source_rgb(0.95, 0.45, 0.05)
            cr.set_line_width(2.5)
            cr.move_to(*a0)
            cr.line_to(*a1)
            cr.stroke()
            # Arrowhead: two short barbs at the tip, angled back
            # along the arrow direction in screen space.
            ang = math.atan2(a1[1] - a0[1], a1[0] - a0[0])
            for da in (2.6, -2.6):
                cr.move_to(*a1)
                cr.line_to(a1[0] + 9 * math.cos(ang + da),
                           a1[1] + 9 * math.sin(ang + da))
            cr.stroke()

        # --- Wall faces (painter's algorithm) ------------------------------
        # One extruded face per footprint edge. Faces are sorted by
        # average view depth, farthest first, so nearer faces paint
        # over farther ones. The FRONT face is always warm orange;
        # the others are blue-grey tones shaded by orientation
        # against a fixed light direction.
        light = (-0.45, -0.89)  # fixed light, from the north-west
        faces = []
        n = len(pts)
        for i in range(n):
            p1 = pts[i]
            p2 = pts[(i + 1) % n]
            if p1 == p2:
                continue  # zero-length edge — no face to draw
            # The face's four corners in local coordinates.
            quad_local = [(p1[0] - cx, p1[1] - cz, 0.0),
                          (p2[0] - cx, p2[1] - cz, 0.0),
                          (p2[0] - cx, p2[1] - cz, bheight),
                          (p1[0] - cx, p1[1] - cz, bheight)]
            depths = [self._project(dx, dz, h, az, el)[2]
                      for dx, dz, h in quad_local]
            faces.append({
                "edge": (p1, p2),
                "quad": [to_screen(dx, dz, h)
                         for dx, dz, h in quad_local],
                "depth": sum(depths) / len(depths),
            })
        # Farthest first.
        faces.sort(key=lambda f: f["depth"])
        for face in faces:
            p1, p2 = face["edge"]
            is_front = (self.front_edge is not None
                        and (p1, p2) == tuple(self.front_edge))
            if is_front:
                # The front wall: warm orange, ALWAYS (see header).
                cr.set_source_rgb(1.0, 0.55, 0.15)
            else:
                # Orientation shading: the edge's outward normal
                # (pointing away from the centroid) dotted with the
                # fixed light sets the tone.
                ex, ez = p2[0] - p1[0], p2[1] - p1[1]
                # A perpendicular of the edge direction.
                nx_, nz_ = ez, -ex
                mx, mz = (p1[0] + p2[0]) / 2.0 - cx, \
                    (p1[1] + p2[1]) / 2.0 - cz
                if nx_ * mx + nz_ * mz < 0:
                    nx_, nz_ = -nx_, -nz_
                nlen = math.hypot(nx_, nz_) or 1.0
                shade = 0.55 + 0.40 * max(
                    0.0, (nx_ / nlen) * light[0]
                    + (nz_ / nlen) * light[1])
                cr.set_source_rgb(0.45 * shade + 0.25,
                                  0.52 * shade + 0.25,
                                  0.62 * shade + 0.25)
            quad = face["quad"]
            cr.move_to(*quad[0])
            for s in quad[1:]:
                cr.line_to(*s)
            cr.close_path()
            cr.fill_preserve()
            cr.set_source_rgb(0.25, 0.28, 0.32)
            cr.set_line_width(1.2)
            cr.stroke()

        # --- Roof (the ring polygon at full height, drawn last) -----------
        roof = [to_screen(p[0] - cx, p[1] - cz, bheight)
                for p in pts]
        cr.set_source_rgb(0.55, 0.42, 0.36)
        cr.move_to(*roof[0])
        for s in roof[1:]:
            cr.line_to(*s)
        cr.close_path()
        cr.fill_preserve()
        cr.set_source_rgb(0.3, 0.24, 0.2)
        cr.set_line_width(1.2)
        cr.stroke()

        # --- FRONT label ------------------------------------------------------
        # Above the front edge's midpoint at roof height.
        if self.front_edge is not None:
            (x1, z1), (x2, z2) = self.front_edge
            fx, fy = to_screen((x1 + x2) / 2.0 - cx,
                               (z1 + z2) / 2.0 - cz, bheight)
            cr.set_source_rgb(0.85, 0.35, 0.0)
            cr.set_font_size(13)
            # Centre the word roughly on the front edge midpoint.
            cr.move_to(fx - 18, fy - 8)
            cr.show_text("FRONT")
        elif not (self.front_info or {}).get("front_road"):
            # No front could be derived: say so on the view too
            # (the readout line carries the same message).
            cr.set_source_rgb(0.3, 0.3, 0.3)
            cr.set_font_size(12)
            cr.move_to(12, height - 12)
            cr.show_text("Front can't be determined — no road "
                         "data nearby.")


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

        # 1.7.0 SPLIT-PANE LAYOUT (Joshua's design correction,
        # 2026-10-16): everything this tab has always shown lives in
        # the LEFT data column (self.data_box); the visual inspector
        # panel is the RIGHT pane of a Gtk.Paned packed below at the
        # end of __init__. Selecting a building opens the inspector
        # — NOTHING in the data column is hidden or collapsed, ever:
        # Joshua adjusts values on the data side while looking at
        # the building, and the paned divider stays draggable.
        self.data_box = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL, spacing=6)

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
        # 1.7.1 LAYOUT FIX (EDITOR UI RULE): this one-line status
        # text ("adamsville: N buildings, ... showing first 1000
        # rows") measured 834px of the data column's minimum width
        # in 1.7.0 — a label must never set the window's width. It
        # ellipsizes now; refresh() keeps the full text on its
        # tooltip so it stays fully readable on hover.
        self.info_label.set_ellipsize(Pango.EllipsizeMode.END)
        self.info_label.set_max_width_chars(48)
        top.pack_start(self.info_label, True, True, 6)
        self.data_box.pack_start(top, False, False, 0)

        # --- Hero buildings (read-only listing) ----------------------
        hero_lbl = Gtk.Label()
        hero_lbl.set_markup("<b>Hero buildings (read-only)</b>")
        hero_lbl.set_halign(Gtk.Align.START)
        # Kept as attributes: the smoke test asserts the hero list
        # is STILL VISIBLE while the inspector is open.
        self.hero_label = hero_lbl
        self.data_box.pack_start(hero_lbl, False, False, 2)
        self.hero_store = Gtk.ListStore(str, str, str)
        hero_tree = Gtk.TreeView(model=self.hero_store)
        for i, title in enumerate(("ID", "Name", "Address")):
            hero_tree.append_column(Gtk.TreeViewColumn(
                title, Gtk.CellRendererText(), text=i))
        hero_scroll = Gtk.ScrolledWindow()
        hero_scroll.set_min_content_height(60)
        hero_scroll.add(hero_tree)
        self.hero_scroll = hero_scroll
        self.data_box.pack_start(hero_scroll, False, False, 0)

        # --- Category filter (1.7.0) -----------------------------------
        # Filters the buildings list below by game type code, or to
        # flagged buildings only. Column 0 of the list store stays
        # the real building index whatever the filter (see refresh).
        filter_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                             spacing=6)
        filter_row.pack_start(Gtk.Label(label="Category:"),
                              False, False, 0)
        self.filter_combo = Gtk.ComboBoxText()
        # Entry order is part of the panel's contract (the smoke
        # test selects "Flagged only" by this index): All, the four
        # CODE_LABELS in code order, then Flagged only. The parallel
        # _filter_values list maps an active index to its filter id.
        self._filter_labels = (
            ["All categories"]
            + [zonedata.CODE_LABELS[c] for c in (0, 1, 2, 3)]
            + ["Flagged only"]) if _ZONEDATA_AVAILABLE else \
            ["All categories", "Residential / generic", "Commercial",
             "Multi-unit / institutional", "Other / special",
             "Flagged only"]
        self._filter_values = ["all", "0", "1", "2", "3", "flagged"]
        for lbl in self._filter_labels:
            self.filter_combo.append_text(lbl)
        self.filter_combo.set_active(0)
        self.filter_combo.connect("changed",
                                  lambda c: self.refresh())
        filter_row.pack_start(self.filter_combo, False, False, 0)
        self.data_box.pack_start(filter_row, False, False, 2)

        # --- Buildings list -------------------------------------------
        b_lbl = Gtk.Label()
        b_lbl.set_markup("<b>Buildings</b> (FLAGGED = locked, awaiting "
                         "Joshua's decision)")
        b_lbl.set_halign(Gtk.Align.START)
        # Same rule as the info label: ellipsize, full text on the
        # tooltip — a heading never widens the window.
        b_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        b_lbl.set_tooltip_text(
            "Buildings (FLAGGED = locked, awaiting Joshua's decision)")
        self.data_box.pack_start(b_lbl, False, False, 2)
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
        # Kept as an attribute: the smoke test asserts the long
        # buildings list lives inside a scrolled window (EDITOR UI
        # RULE — long content scrolls, never clips).
        self.list_scroll = scroll
        self.data_box.pack_start(scroll, True, True, 0)

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
        # 1.7.1 LAYOUT FIX (EDITOR UI RULE — long content SCROLLS):
        # this row is intrinsically ~1080px wide (five spin buttons
        # whose minimums GTK computes from their ranges — measured
        # 120-136px each and NOT reducible via width_chars or size
        # requests — plus two buttons), and it alone set the data
        # column's minimum in 1.7.0. It now rides in a horizontal
        # scroller: at full width it looks exactly as before; when
        # Joshua narrows the data pane, the row scrolls sideways
        # and every control stays reachable.
        self.edit_scroll = Gtk.ScrolledWindow()
        self.edit_scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                                    Gtk.PolicyType.NEVER)
        self.edit_scroll.set_shadow_type(Gtk.ShadowType.NONE)
        self.edit_scroll.add(edit)
        self.data_box.pack_start(self.edit_scroll, False, False, 2)

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
        # The name entry expands into free space, but its MINIMUM
        # stays small (12 chars) so it never widens the window.
        self.pname.set_width_chars(12)
        place.pack_start(self.pname, True, True, 0)
        place_btn = Gtk.Button(label="Place Building")
        place_btn.connect("clicked", self._on_place)
        place.pack_start(place_btn, False, False, 0)
        # Same horizontal scroller as the edit row above (this row
        # measured 1112px in 1.7.0 — the widest thing in the tab).
        self.place_scroll = Gtk.ScrolledWindow()
        self.place_scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                                     Gtk.PolicyType.NEVER)
        self.place_scroll.set_shadow_type(Gtk.ShadowType.NONE)
        self.place_scroll.add(place)
        self.data_box.pack_start(self.place_scroll, False, False, 2)

        # --- Split pane: data column (left) + inspector (right) ----
        # The inspector starts hidden; selecting a building shows
        # it (see show_inspector). The data column is pack1 and is
        # NEVER hidden — the split is the whole design.
        self.inspector = ZoneInspectorPanel(self)
        self.inspector.set_visible(False)
        self.paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self.paned.set_wide_handle(True)
        # 1.7.1 LAYOUT FIX (EDITOR UI RULE — graphical panes are
        # ADJUSTABLE): 1.7.0 packed BOTH children shrink=False, so
        # GtkPaned clamped the divider to [data minimum, width −
        # inspector minimum] = a 1px range once the minimums summed
        # past the window width (measured: set_position(250/754/
        # 1259) ALL left the divider at 1108 — it could not move at
        # all, exactly as Joshua reported). shrink=True on both
        # children lets either pane go below its request size, so
        # the divider travels the full width; the panes' contents
        # are built to stay usable small (scrolled lists, capped
        # spin buttons, ellipsized labels — see above).
        self.paned.pack1(self.data_box, True, True)
        self.paned.pack2(self.inspector, False, True)
        self.pack_start(self.paned, True, True, 0)
        # Divider memory (session): once Joshua drags the divider,
        # his position — not the default — is restored every time
        # the inspector reopens. _split_guard keeps show_inspector's
        # own programmatic positioning from overwriting his choice.
        self._split_pos = None
        self._split_guard = False
        self.paned.connect("notify::position", self._on_split_moved)

        self.refresh()

    def _on_split_moved(self, paned, _param):
        """Remember a user-dragged divider position (this session)."""
        if not self._split_guard and self.inspector.get_visible():
            self._split_pos = paned.get_position()

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
        """
        Repopulate hero + building lists from the store, honouring
        the category filter (1.7.0): a row is included only when the
        filter is All, or the box's type code matches the chosen
        category, or the filter is "Flagged only" and the building
        has a flagged match. Column 0 ALWAYS stays the real building
        index — _selected_index and the edit handlers depend on it.
        """
        self.hero_store.clear()
        self.store.clear()
        zd = self._zd()
        if zd is None:
            self.info_label.set_text("Zone data not loaded.")
            return
        store = self.app_window.zone_store
        # The active filter id ("all" during __init__, before the
        # combo exists, refresh is only called after it is built).
        filt = "all"
        if hasattr(self, "filter_combo"):
            active = self.filter_combo.get_active()
            if 0 <= active < len(self._filter_values):
                filt = self._filter_values[active]
        flagged_n = 0
        for hb in zd.hero_list():
            self.hero_store.append([hb["id"] or "", hb["name"] or "",
                                    hb["address"] or ""])
        shown = 0
        for i, (box, det) in enumerate(zip(zd.boxes, zd.details)):
            if shown >= self.ROW_CAP:
                break
            is_flag = store.flagged.match(
                self._zone, det.get("ring") or []) is not None
            flagged_n += 1 if is_flag else 0
            # --- the 1.7.0 category filter ----------------------------
            if filt == "flagged":
                if not is_flag:
                    continue
            elif filt != "all":
                if box[5] != int(filt):
                    continue
            self.store.append([i, det.get("name") or "",
                               zonedata.CODE_LABELS.get(box[5], "?"),
                               "FLAGGED" if is_flag else ""])
            shown += 1
        info = (
            f"{self._zone}: {len(zd.boxes)} buildings, "
            f"{len(zd.hero_list())} hero, "
            f"{store.flagged.count(self._zone)} flagged in zone "
            f"(showing first {min(self.ROW_CAP, len(zd.boxes))} rows)"
            + (" — UNSAVED CHANGES" if zd.dirty else ""))
        if filt != "all":
            # Name the active filter and how many rows it leaves.
            label = self._filter_labels[
                self._filter_values.index(filt)]
            info += f" — filter: {label}: {shown} rows shown"
        self.info_label.set_text(info)
        # The label ellipsizes (1.7.1) — full text stays on hover.
        self.info_label.set_tooltip_text(info)

    # -- inspector show/hide (1.7.0) --------------------------------------

    def show_inspector(self, index):
        """
        Open the visual inspector on building `index` (right pane).
        The data column stays fully visible and editable — only the
        inspector appears and the paned divider moves so it gets
        its share (~320px by default, or the position Joshua last
        dragged it to this session). Called from _on_select on a
        valid selection.
        """
        zd = self._zd()
        store = self.app_window.zone_store
        if zd is None or store is None \
                or not (0 <= index < len(zd.boxes)):
            return
        # The flagged entry for this building, if any.
        flagged_entry = store.flagged.match(
            self._zone, zd.details[index].get("ring") or [])
        self.inspector.show_building(self, zd, index, flagged_entry)
        self.inspector.set_visible(True)
        self._position_inspector()
        # The paned may not have its final width yet on the first
        # selection; re-position once the GTK loop has allocated it.
        GLib.idle_add(self._position_inspector_idle)

    def _position_inspector(self):
        """Place the split divider for the inspector.

        1.7.1: Joshua's dragged position wins (remembered by
        _on_split_moved for the whole session); before he has
        dragged anything, the inspector gets ~320px. Either way the
        position is clamped so the data column keeps >=240px and
        the inspector >=200px — and because both panes are packed
        shrink=True now, the clamp is a courtesy, not a wall: he
        can drag past it afterwards.
        """
        width = self.paned.get_allocated_width()
        if width <= 0:
            return
        if self._split_pos is not None:
            pos = self._split_pos
        else:
            pos = width - 320
        pos = max(240, min(pos, width - 200))
        self._split_guard = True
        try:
            self.paned.set_position(pos)
        finally:
            self._split_guard = False

    def _position_inspector_idle(self):
        """idle_add wrapper for _position_inspector (one-shot)."""
        self._position_inspector()
        return False

    def hide_inspector(self):
        """Hide the inspector panel. The data column was never
        hidden, so there is nothing to restore."""
        if hasattr(self, "inspector"):
            self.inspector.set_visible(False)

    # -- callbacks ---------------------------------------------------------

    def _on_zone_changed(self, combo):
        """Switch the working zone."""
        self._zone = combo.get_active_text() or self._zone
        # The inspector was showing the old zone's building.
        self.hide_inspector()
        self.refresh()

    def _on_select(self, selection):
        """
        Load the selected building's numbers into the edit spins,
        and (1.7.0) open the visual inspector on it. An empty
        selection hides the inspector again.
        """
        idx = self._selected_index()
        zd = self._zd()
        if idx is None or zd is None or idx >= len(zd.boxes):
            # No valid row selected — the inspector closes.
            self.hide_inspector()
            return
        box = zd.boxes[idx]
        self.mx.set_value(box[0]); self.mz.set_value(box[1])
        self.mw.set_value(box[2]); self.md.set_value(box[3])
        self.mh.set_value(box[4])
        # Show the building in the 3D inspector (right pane).
        self.show_inspector(idx)

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
        # 1.7.1 (EDITOR UI RULE): the mode bar rides in a
        # horizontal scroller — if the canvas pane is dragged
        # narrow, the buttons SCROLL into reach instead of being
        # clipped off the edge.
        mode_scroll = Gtk.ScrolledWindow()
        mode_scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                               Gtk.PolicyType.NEVER)
        mode_scroll.set_shadow_type(Gtk.ShadowType.NONE)
        mode_scroll.add(mode_bar)
        left.pack_start(mode_scroll, False, False, 4)

        hint = Gtk.Label(
            label="Drag empty space to rotate — drag a window/door/"
                  "decoration to move it. Click a window to resize it.")
        hint.set_halign(Gtk.Align.START)
        # Wrap so the hint's minimum is its longest word, not the
        # whole sentence (EDITOR UI RULE).
        hint.set_line_wrap(True)
        left.pack_start(hint, False, False, 0)

        # --- Right: properties panel (scrollable) ---
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER,
                            Gtk.PolicyType.AUTOMATIC)
        # 1.7.1: floor lowered 300 -> 260 (rows are label 110px +
        # control; 260 stays usable) — the paned's shrink below
        # handles the rest.
        scrolled.set_min_content_width(260)
        props = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        props.set_border_width(10)
        scrolled.add(props)
        self._build_properties(props)
        self.props_scroll = scrolled

        # 1.7.1 LAYOUT (EDITOR UI RULE): the preview canvas is a
        # GRAPHICAL pane, so it sits in an adjustable split like
        # the Zone tab's inspector — 1.7.0 used a plain box, where
        # the properties column's width was whatever its content
        # demanded and neither side could be resized. Both children
        # pack shrink=True; the divider starts with the properties
        # at ~330px (see _position_paned_idle).
        self.paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self.paned.set_wide_handle(True)
        self.paned.pack1(left, True, True)
        self.paned.pack2(scrolled, False, True)
        self.pack_start(self.paned, True, True, 6)
        GLib.idle_add(self._position_paned_idle)

    def _position_paned_idle(self):
        """One-shot idle: initial divider — properties get ~330px."""
        width = self.paned.get_allocated_width()
        if width > 500:
            self.paned.set_position(width - 330)
        return False

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
        # `left` is packed into the split at the END of __init__
        # (1.7.1: Gtk.Paned — see below), once `right` exists.

        # --- Right: subdivision list + editor panel ---
        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        right.set_border_width(10)
        # 1.7.1: 240px floor (was a hard 280 request); the split's
        # shrink lets it go narrower still (EDITOR UI RULE).
        right.set_size_request(240, -1)
        self.right_panel = right

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

        # 1.7.1 LAYOUT (EDITOR UI RULE): the map canvas is a
        # GRAPHICAL pane — it belongs in an adjustable split, not a
        # fixed box beside a hard-width side panel (the 1.7.0
        # arrangement). Both children shrink=True; the divider
        # starts with the side panel at ~290px.
        self.paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self.paned.set_wide_handle(True)
        self.paned.pack1(left, True, True)
        self.paned.pack2(right, False, True)
        self.pack_start(self.paned, True, True, 6)
        GLib.idle_add(self._position_paned_idle)

        # Load data into the canvas; the canvas fits the view itself
        # on its first real size allocation (v1.2.0 fix).
        self._refresh()

    def _position_paned_idle(self):
        """One-shot idle: initial divider — side panel gets ~290px."""
        width = self.paned.get_allocated_width()
        if width > 500:
            self.paned.set_position(width - 290)
        return False

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
