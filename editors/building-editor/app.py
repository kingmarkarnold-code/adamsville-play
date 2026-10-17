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
import shutil
import subprocess
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
# v1.7.2: the suite shared download cache (Joshua 2026-10-17: all
# editors share one downloaded copy of the map). Soft import for
# the same reason as zonedata's: downloads must fail open to plain
# fetches, never stop the editor opening.
try:
    import shared_cache  # noqa: E402
    _SHARED_CACHE_AVAILABLE = True
except Exception:
    shared_cache = None
    _SHARED_CACHE_AVAILABLE = False
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
APP_VERSION = "1.7.3"

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
        # v1.7.2 LOAD ON DEMAND (Joshua 2026-10-17): the zone store
        # exists from the start but starts EMPTY — startup downloads
        # only the light lists (flagged list, gas-station review,
        # station edits, one zone's light index); a zone's full
        # building records download when Joshua selects a building
        # in it (see _load_lists_on_open / ensure_zone_detail). The
        # tabs are built immediately so the window opens fast.
        self.zone_store = zonedata.GameStore() \
            if _ZONEDATA_AVAILABLE else None
        self.zone_tab = None
        self.gas_review_tab = None
        # The one download door (1.7.2): every download this app
        # makes goes through the suite shared cache (see
        # shared_cache.py and editors/SHARED-CACHE.md).
        self._fetcher = self._build_fetcher()
        # In-flight zone loads: zone -> [done callbacks].
        self._zone_loads = {}
        self._index_loads = {}
        # Download progress bar state (see _dl_progress).
        self._progress_state = {}
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

        # --- Download progress (1.7.2, Joshua: "a progress bar
        # showing the download MBs") — visible only while a download
        # runs; its text names the file and the MB done of total.
        self.progress_bar = Gtk.ProgressBar()
        self.progress_bar.set_show_text(True)
        self.progress_bar.set_no_show_all(True)
        self.progress_bar.hide()
        vbox.pack_start(self.progress_bar, False, False, 0)

        # --- Status bar ---
        self.status = Gtk.Statusbar()
        self.status_ctx = self.status.get_context_id("main")
        vbox.pack_start(self.status, False, False, 0)

        # --- The game-data tabs exist from the start (1.7.2) ---
        # They fill in as the light lists land; building the Gas
        # Station Review tab is guarded so a failure there can
        # never take the window down (the 1.7.0 tab lesson) — it
        # surfaces in the status bar instead.
        if _ZONEDATA_AVAILABLE:
            self.zone_tab = ZoneBuildingsTab(self)
            self.notebook.append_page(
                self.zone_tab,
                Gtk.Label(label="Zone Buildings (game data)"))
            try:
                self.gas_review_tab = GasStationReviewTab(self)
                self.notebook.append_page(
                    self.gas_review_tab,
                    Gtk.Label(label="Gas Station Review"))
            except Exception as e:
                import traceback
                traceback.print_exc()
                self._set_status(
                    f"Gas Station Review tab failed to open: {e}")

        # --- Window geometry: restore, then track changes ---
        self._restore_geometry()
        self.connect("delete-event", self._on_close)
        self.connect("configure-event", self._on_configure)

        # --- Load building data (download prompt on first launch) ---
        self._load_data()
        # v1.7.2: download the LIGHT lists only (flagged list, gas
        # review, station edits, subdivisions, the first zone's
        # light index) on a worker thread. Zone building records
        # load later, one zone at a time, when Joshua selects a
        # building — never all seven zones up front.
        self._load_lists_on_open()

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
            # 1.7.2: through the suite shared cache, like every
            # download this app makes.
            downloaded, err = data.download_design_buildings(
                self._fetcher.fetch)
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

    # -- v1.7.2 downloads: light lists on open, zones on demand ------

    def _build_fetcher(self):
        """
        The app's one download door: a shared_cache.CachedFetcher
        over github_sync's transport, so EVERY download (zone
        files, light indexes, the flagged/review/station lists, the
        design set) goes through the suite shared cache — one copy
        of the map on this machine, shared by all the editors. If
        shared_cache failed to import, fall back to plain github
        fetches behind the same two callables (downloads must fail
        open, never stop the editor opening).
        """
        if _SHARED_CACHE_AVAILABLE:
            return shared_cache.CachedFetcher(
                github_sync.fetch_file,
                fetch_meta=github_sync.fetch_file_meta,
                fetch_file_progress=github_sync.fetch_file_progress)

        class _PlainFetcher:
            """Cache-less fallback with the CachedFetcher shape."""
            paths_served_stale = []

            def register_manifest(self, raw):
                pass

            def fetch(self, repo, path, **kwargs):
                return github_sync.fetch_file(repo, path)

            def fetch_progress(self, repo, path, progress=None,
                               **kwargs):
                return github_sync.fetch_file_progress(
                    repo, path, progress=progress)
        return _PlainFetcher()

    # -- download progress (worker thread -> GTK thread) --------------

    def _dl_progress(self, done, total, path):
        """
        Progress callback handed to the store's downloads: called
        from worker threads with (bytes done, bytes total, repo
        path). Posts to the GTK thread, throttled so a fast
        download cannot flood the main loop with redraws.
        """
        st = self._progress_state
        key = path
        last = st.get(key, -1)
        pct = int(100 * done / total) if total else 100
        if done < total and pct == last:
            return
        st[key] = pct
        label = path.rsplit("/", 1)[-1]
        text = (f"Downloading {label} — {done / 1048576:.1f} of "
                f"{total / 1048576:.1f} MB")
        frac = (done / total) if total else 1.0
        GLib.idle_add(self._show_progress, frac, text)

    def _show_progress(self, frac, text):
        """GTK thread: move the progress bar (hide at completion)."""
        if frac >= 1.0:
            self.progress_bar.hide()
            self._progress_state.clear()
        else:
            self.progress_bar.set_fraction(frac)
            self.progress_bar.set_text(text)
            self.progress_bar.show()
        return False

    def _hide_progress(self):
        self.progress_bar.hide()
        self._progress_state.clear()
        return False

    def _note_stale(self, what):
        """Name any files the shared cache served stale (offline)
        since the last note, in the status bar — the view is marked
        stale honestly, per the shared-cache standard."""
        stale = self._fetcher.paths_served_stale
        if stale:
            names = ", ".join(p.rsplit("/", 1)[-1] for p in stale)
            self._set_status(
                f"{what} (offline — showing the last downloaded "
                f"copy of: {names}; it may be out of date.)")
            stale.clear()

    # -- the light lists on open ---------------------------------------

    def _load_lists_on_open(self):
        """
        Download-on-open, 1.7.2 style (Joshua's load-on-demand +
        all-lists-from-GitHub rules): the map manifest (freshness
        for the shared cache), the flagged-buildings list, the
        gas-station review list, the station-edits overlay, the
        subdivisions file, and ONE zone's light index (adamsville,
        the home zone) — a few hundred KB to ~2 MB total, never the
        ~55 MB of zone building records. The other zones' indexes
        download when Joshua picks those zones; a zone's full
        records download when he selects a building in it.

        Each list: GitHub first; a per-app cache file under the
        app-data dir is the offline fallback (a cache of a previous
        successful download — the only local copy the rules allow);
        a failure with no cache is named in the status bar with the
        real reason. Runs on a worker thread.
        """
        if not _ZONEDATA_AVAILABLE:
            return
        import threading

        store = self.zone_store
        fetcher = self._fetcher
        repo = zonedata.REPO

        def fetch_list(path, cache_name):
            """Download one list; fall back to its cache file.
            Returns (raw_bytes_or_None, note_or_None)."""
            raw, err = fetcher.fetch(repo, path)
            cache_path = data.DATA_DIR / cache_name
            if raw is not None:
                try:
                    data.DATA_DIR.mkdir(parents=True, exist_ok=True)
                    cache_path.write_bytes(raw)
                except Exception:
                    pass  # a cache write failure is not fatal
                return raw, None
            if cache_path.exists():
                try:
                    return cache_path.read_bytes(), \
                        f"{path}: download failed ({err}) — using " \
                        f"the last downloaded copy."
                except Exception:
                    pass
            return None, f"{path}: download failed ({err})."

        def worker():
            notes = []
            # The manifest: always fetched fresh (it is tiny) — it
            # is the shared cache's freshness source for map files.
            mraw, merr = github_sync.fetch_file(
                repo, "detailed/map-manifest.json")
            if mraw is not None:
                fetcher.register_manifest(mraw)

            raw, note = fetch_list(zonedata.FLAGGED_REPO_PATH,
                                   "flagged-list-cache.json")
            if raw is not None:
                store.set_flagged(zonedata.FlaggedIndex.from_bytes(raw))
            if note:
                notes.append(note)

            raw, note = fetch_list(zonedata.REVIEW_REPO_PATH,
                                   "gas-review-cache.json")
            if raw is not None:
                store.review = zonedata.GasStationReview.from_bytes(raw)
            if note:
                notes.append(note)

            # Station-edits overlay: a 404 is the normal first run
            # (nobody has flipped a station yet) — start empty.
            raw, err = fetcher.fetch(
                repo, zonedata.STATION_EDITS_REPO_PATH)
            if raw is not None:
                store.station_edits = \
                    zonedata.StationEdits.from_bytes(raw)
            elif err and "404" not in err:
                notes.append(
                    f"{zonedata.STATION_EDITS_REPO_PATH}: {err}")

            err = store.fetch_subdivisions(fetcher.fetch)
            if err:
                notes.append(err)

            err = store.ensure_index(
                "adamsville", fetcher.fetch, fetcher.fetch_progress,
                progress=self._dl_progress)
            if err:
                notes.append(err)

            def done():
                import gc
                gc.collect()
                if self.zone_tab is not None:
                    self.zone_tab.refresh()
                if self.gas_review_tab is not None:
                    self.gas_review_tab.set_review(
                        store.review, store.station_edits)
                idx = store.indexes.get("adamsville")
                n = len(idx.entries) if idx else 0
                msg = (f"Ready. Adamsville's building list is loaded "
                       f"({n} buildings) — pick any building and "
                       f"just its zone downloads.")
                if notes:
                    msg += " Problems: " + "; ".join(notes)
                self._set_status(msg)
                self._note_stale("Lists loaded from the shared cache")
                return False
            GLib.idle_add(done)

        threading.Thread(target=worker, daemon=True).start()

    # -- one zone's index / detail, on demand ---------------------------

    def ensure_zone_index(self, zone, done=None):
        """Make sure one zone's light index is in memory (downloading
        it with progress if not). done(ok) runs on the GTK thread."""
        store = self.zone_store
        if store is None or zone in store.indexes:
            if done:
                done(True)
            return
        if zone in self._index_loads:
            if done:
                self._index_loads[zone].append(done)
            return
        self._index_loads[zone] = [done] if done else []
        import threading

        def worker():
            err = store.ensure_index(
                zone, self._fetcher.fetch,
                self._fetcher.fetch_progress,
                progress=self._dl_progress)

            def finish():
                cbs = self._index_loads.pop(zone, [])
                GLib.idle_add(self._hide_progress)
                if err:
                    self._set_status(
                        f"Could not load the {zone} building list: "
                        f"{err}")
                elif self.zone_tab is not None:
                    self.zone_tab.refresh()
                for cb in cbs:
                    cb(not err)
                return False
            GLib.idle_add(finish)

        threading.Thread(target=worker, daemon=True).start()

    def ensure_zone_detail(self, zone, done=None):
        """
        Make sure one zone's FULL building records are in memory —
        the selection-triggered download of the load-on-demand
        design. Shows MB progress; on success the previously loaded
        clean zones are unloaded (a zone with unsaved edits is
        NEVER unloaded) and the freed memory is returned. done(ok)
        runs on the GTK thread.
        """
        store = self.zone_store
        if store is None or zone in store.zones:
            if done:
                done(True)
            return
        if zone in self._zone_loads:
            if done:
                self._zone_loads[zone].append(done)
            return
        self._zone_loads[zone] = [done] if done else []
        import threading

        def worker():
            err = store.ensure_zone(
                zone, self._fetcher.fetch,
                self._fetcher.fetch_progress,
                progress=self._dl_progress)

            def finish():
                import gc
                cbs = self._zone_loads.pop(zone, [])
                GLib.idle_add(self._hide_progress)
                if err:
                    self._set_status(
                        f"Could not load the {zone} zone: {err}")
                else:
                    # Memory diet: drop other CLEAN zones' detail
                    # (their light indexes stay, so their lists
                    # still browse). Dirty zones are never dropped.
                    for other in list(store.zones):
                        if other != zone:
                            store.unload_zone(other)
                    gc.collect()
                    # Return freed memory to the OS where possible.
                    try:
                        import ctypes
                        ctypes.CDLL("libc.so.6").malloc_trim(0)
                    except Exception:
                        pass
                    zd = store.zones.get(zone)
                    self._set_status(
                        f"{zone} loaded from GitHub: "
                        f"{len(zd.boxes) if zd else 0} buildings.")
                    self._note_stale("Zone loaded")
                    if self.zone_tab is not None:
                        self.zone_tab.refresh()
                for cb in cbs:
                    cb(not err)
                return False
            GLib.idle_add(finish)

        threading.Thread(target=worker, daemon=True).start()

    def ensure_all_zones(self, done=None):
        """Load EVERY zone's full records — only for actions that
        genuinely need the whole map (baking a subdivision). Joshua's
        rule: whole-map loads happen only when he explicitly does
        something that needs them. done(ok) on the GTK thread."""
        store = self.zone_store
        missing = [z for z in zonedata.ZONES if z not in store.zones]
        if not missing:
            if done:
                done(True)
            return
        import threading

        def worker():
            errs = []
            for zone in missing:
                err = store.ensure_zone(
                    zone, self._fetcher.fetch,
                    self._fetcher.fetch_progress,
                    progress=self._dl_progress)
                if err:
                    errs.append(err)

            def finish():
                GLib.idle_add(self._hide_progress)
                if errs:
                    self._set_status(
                        "Could not load every zone: "
                        + "; ".join(errs))
                if done:
                    done(not errs)
                return False
            GLib.idle_add(finish)

        threading.Thread(target=worker, daemon=True).start()

    # -- Open in Map Editor (1.7.2, Joshua 2026-10-17) -------------------

    def open_in_map_editor(self, zone, x, z, street_name):
        """
        Hand a location to the Map Editor: write the suite handoff
        file (~/.local/share/adamsville-suite/open-in-map-editor.
        json — {zone, x, z, street, writtenBy, timestamp}) and, if
        the Map Editor is installed, launch it. The Map Editor
        learns to read the file in its 1.9.5 update (the reader is
        built into its source now); until then the honest status
        says the location is saved and the jump lands with that
        update.
        """
        from datetime import datetime, timezone
        payload = {
            "zone": zone,
            "x": round(float(x), 2),
            "z": round(float(z), 2),
            "street": street_name or "",
            "writtenBy": f"building-editor-{APP_VERSION}",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        try:
            github_sync.SHARED_DIR.mkdir(parents=True, exist_ok=True)
            path = github_sync.SHARED_DIR / "open-in-map-editor.json"
            path.write_text(json.dumps(payload, indent=1))
        except Exception as e:
            self._set_status(
                f"Could not save the Map Editor location: {e}")
            return
        where = f"{street_name} in {zone}" if street_name \
            else f"that spot in {zone}"
        exe = shutil.which("adamsville-map-editor-native")
        if exe:
            try:
                subprocess.Popen([exe])
                self._set_status(
                    f"Map Editor location saved ({where}) and the "
                    f"Map Editor is starting — it will open there "
                    f"once its 1.9.5 update is installed.")
                return
            except Exception:
                pass
        self._set_status(
            f"Map Editor location saved ({where}). The Map Editor "
            f"update that reads it (1.9.5) is ready — once it's "
            f"installed, the Map Editor opens right there.")

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

        THREE legs, each a full standing-rule round trip:
          1. the game zone store (zonedata.GameStore — dirty zones
             + the subdivisions file), as since 1.6.0;
          2. the DESIGN set (data.design_round_trip) — NEW in
             1.7.1. Before this, design edits were in NO target
             list: "Push & Close" after a roof-colour change ran
             leg 1 only, found nothing to do, and reported success
             while the design edit never left the laptop;
          3. the station-edits overlay (1.7.2), when dirty.
        The design leg runs only when the zone leg succeeded (or
        there is no zone store): a half-save must read as one
        honest failure, not two confusing halves.
        """
        msgs = []
        ok_all = True
        proof = None
        if self.zone_store is not None:
            ok, msg, fresh = self.zone_store.round_trip_save(
                data.DATA_DIR / "zone-cache",
                github_sync.open_connection,
                github_sync.push_targets,
                github_sync.fetch_file)
            msgs.append(msg)
            ok_all = ok
            if ok and fresh and _SHARED_CACHE_AVAILABLE:
                # The proof copies ARE the freshest known bytes —
                # file them in the suite shared cache so every
                # editor (and this one's next open) can reuse them
                # without downloading again.
                for path, raw in fresh.items():
                    try:
                        shared_cache.store(zonedata.REPO, path, raw)
                    except Exception:
                        pass
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
        # Leg 3 (1.7.2): the editable-station overlay, when it has
        # unsaved changes — same standing-rule round trip, its own
        # file (editors/building-editor/station-edits.json).
        if self.zone_store is not None \
                and self.zone_store.station_edits.dirty:
            if ok_all:
                ok3, msg3, sproof = \
                    self.zone_store.station_edits.round_trip_save(
                        data.DATA_DIR / "zone-cache",
                        github_sync.open_connection,
                        github_sync.push_targets,
                        github_sync.fetch_file)
                msgs.append(msg3)
                ok_all = ok_all and ok3
                if ok3 and sproof is not None \
                        and _SHARED_CACHE_AVAILABLE:
                    try:
                        shared_cache.store(
                            zonedata.REPO,
                            zonedata.STATION_EDITS_REPO_PATH, sproof)
                    except Exception:
                        pass
            else:
                msgs.append(
                    "Station edits were NOT pushed (an earlier "
                    "part of the save failed first).")
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
            if self.gas_review_tab is not None:
                self.gas_review_tab.refresh_station_states()
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
            self._set_status("Zone data is unavailable — zonedata "
                             "failed to load.")
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
# ZoneInspectorPanel — the selected building (or station), in 3D
# ---------------------------------------------------------------------------

class ZoneInspectorPanel(Gtk.Box):
    """
    The right pane of the split view (Joshua's design, 1.7.0): when
    a building is selected in the Zone Buildings list, this panel
    shows it IN 3D, in its current location — the building drawn
    from its real footprint ring, the roads around it as context,
    and its FRONT derived from the data: the footprint edge nearest
    a road is the front; that wall is always painted warm orange
    and labelled FRONT, with a ground arrow pointing out of it.

    1.7.2 changes (Joshua, 2026-10-17):
      * CAMERA: opens as if standing in FRONT of the building —
        eye level, straight at the front wall, framed close on the
        building alone (the roads are context, they no longer set
        the framing). "Face front" returns to exactly this view.
      * DIRECT MANIPULATION: grab the ROOF and drag to MOVE the
        building; grab a LEFT/RIGHT edge to change WIDTH; a
        FRONT/BACK edge for DEPTH; the FRONT FACE (orange wall)
        dragged up/down for HEIGHT. Typing numbers and dragging
        are the same values, synced both ways through the tab.
      * STATUS LABEL (amendment 2): bold coloured text at the
        BOTTOM LEFT of the 3D view — red "Flagged", yellow
        "Skipped", green "Placed" — describing how the GAME treats
        this object today (a station flipped editable still shows
        its game status).
      * SELECTABLE STREETS (amendment 3): clicking a drawn street
        selects it (highlighted, named); the "Open in Map Editor"
        button then hands that street's location to the Map
        Editor.
      * STATIONS: an editable gas station opens here too, drawn as
        the game's own station cluster (pad, canopy, kiosk, pumps,
        columns at their real offsets) as one editable object.
      * The backdrop roads are the segments near the building only
        (zonedata keeps the zone's parsed roads only transiently —
        the 1.7.1 panel re-scanned all of them on every draw and
        the store retained them all).

    The view never rotates on its own (auto_rotate stays False and
    no timer exists): orbit is by dragging empty space, elevation
    clamped, exactly as Joshua set it in 1.7.0.
    """

    view_mode = "3d"
    auto_rotate = False
    _rotate_timer_id = None

    # 1.7.2 camera: eye level (was an elevated 30 degrees in
    # 1.7.0/1.7.1 — superseded by Joshua's "standing in front of
    # the building" rule). The clamp lets him go a little lower
    # than eye level and up to the old working angles.
    DEFAULT_ELEVATION = math.radians(12)
    DEFAULT_AZIMUTH = math.radians(90)   # south fallback (no road)
    MIN_ELEVATION = math.radians(5)
    MAX_ELEVATION = math.radians(60)

    FRONT_RGB = (1.0, 0.55, 0.15)        # the warm orange front wall
    STREET_HILITE_RGB = (0.05, 0.65, 0.85)

    # The status label's words + colours (Joshua's exact spec).
    STATUS_STYLE = {
        "Flagged": "#ff0000",
        "Skipped": "#ffff00",
        "Placed": "#00cc00",
    }

    def __init__(self, tab):
        """tab: the owning tab (ZoneBuildingsTab or
        GasStationReviewTab) — provides manip_values/manip_apply
        and app_window access."""
        super().__init__(orientation=Gtk.Orientation.VERTICAL,
                         spacing=4)
        self.set_border_width(6)
        # Shrinkable + a real request: the split divider decides
        # the final width (EDITOR UI RULE — adjustable panes), but
        # the request is what GTK anchors the divider to when the
        # panel is first shown. 1.7.2 (real-GTK fix, Xvfb smoke
        # 2026-10-17): at 240 the anchored allocation came out at
        # 228px — too narrow for the 3D view + controls, and under
        # the layout gate's 240px floor; the same request is also
        # the divider's drag floor in GTK3, so it cannot be set
        # huge either (the divider must still drag the pane small
        # — Joshua's adjustability rule cuts both ways). 264 lands
        # the default allocation at ~252px with the drag floor at
        # the same ~252px: real space by default, full travel on
        # the drag.
        self.set_size_request(264, -1)
        self.tab = tab
        self.app_window = tab.app_window

        # -- viewed-object state -----------------------------------
        self.mode = None            # "building" | "station"
        self.zd = None              # ZoneData (backdrop / front)
        self.index = None           # building index (building mode)
        self.box = None
        self.detail = None
        self.flagged_entry = None
        self.front_info = None
        self.front_azimuth = self.DEFAULT_AZIMUTH
        self.azimuth = self.DEFAULT_AZIMUTH
        self.elevation = self.DEFAULT_ELEVATION
        self.zone = None            # zone name (handoff + backdrop)
        # station mode:
        self.station = None         # the station record dict
        self.station_edit = None    # its StationEdits entry
        self.station_anchor = (0.0, 0.0)
        self.station_facing = 0.0   # game face angle (L2W convention)
        self.station_parts = []
        # shared view state:
        self._roads_near = []       # [(name, pts)] backdrop, cached
        self._view = None           # last draw's transform (inverse)
        self._drag = None
        self._cur_values = None     # {x, z, w, d, h} being viewed
        self.selected_street = None  # {"name", "x", "z", "zone"}
        self.status_word = None
        self.status_color = None

        # -- header: title + close ----------------------------------
        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                         spacing=4)
        self.title_label = Gtk.Label(label="")
        self.title_label.set_halign(Gtk.Align.START)
        self.title_label.set_ellipsize(Pango.EllipsizeMode.END)
        header.pack_start(self.title_label, True, True, 0)
        close_btn = Gtk.Button(label="✕")
        close_btn.set_relief(Gtk.ReliefStyle.NONE)
        close_btn.set_tooltip_text("Close the 3D view")
        close_btn.connect("clicked", lambda w: tab.hide_inspector())
        header.pack_start(close_btn, False, False, 0)
        self.pack_start(header, False, False, 0)

        # -- flagged badge (buildings only) --------------------------
        self.badge_label = Gtk.Label()
        self.badge_label.set_markup(
            "<b><span foreground=\"#c00000\">⚠ FLAGGED — locked, "
            "awaiting Joshua's decision</span></b>")
        self.badge_label.set_halign(Gtk.Align.START)
        self.badge_label.set_line_wrap(True)
        self.badge_label.set_no_show_all(True)
        self.badge_label.hide()
        self.pack_start(self.badge_label, False, False, 0)

        # -- the 3D view, with the status label overlaid -------------
        # DrawingArea (cairo, software-rendered — the laptop has no
        # real GPU). It EXPANDS with the pane; the status label is a
        # Gtk.Overlay child at the bottom left (amendment 2).
        self.drawing = Gtk.DrawingArea()
        self.drawing.set_size_request(160, 320)
        self.drawing.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.BUTTON_RELEASE_MASK
            | Gdk.EventMask.POINTER_MOTION_MASK)
        self.drawing.connect("button-press-event", self._on_drag_press)
        self.drawing.connect("button-release-event",
                             self._on_drag_release)
        self.drawing.connect("motion-notify-event", self._on_drag_motion)
        self.drawing.connect("draw", self._on_draw_3d)
        self.status_label = Gtk.Label()
        self.status_label.set_halign(Gtk.Align.START)
        self.status_label.set_valign(Gtk.Align.END)
        self.status_label.set_margin_start(6)
        self.status_label.set_margin_bottom(6)
        self.status_label.set_no_show_all(True)
        self.status_label.hide()
        overlay = Gtk.Overlay()
        overlay.add(self.drawing)
        overlay.add_overlay(self.status_label)
        self.view_overlay = overlay
        self.pack_start(overlay, True, True, 0)

        # -- controls -------------------------------------------------
        controls = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                           spacing=4)
        hint = Gtk.Label(
            label="Drag empty space to look around. Drag the roof "
                  "to move, an edge to resize, the orange wall for "
                  "height. Click a street to select it.")
        hint.set_halign(Gtk.Align.START)
        hint.set_ellipsize(Pango.EllipsizeMode.END)
        hint.set_tooltip_text(
            "Drag empty space to look around. Drag the roof to "
            "move the building, a left/right edge for width, a "
            "front/back edge for depth, the orange front wall up "
            "or down for height. Click a street to select it.")
        controls.pack_start(hint, True, True, 0)
        face_btn = Gtk.Button(label="Face front")
        face_btn.set_tooltip_text(
            "Return to the front view: eye level, straight at the "
            "front wall")
        face_btn.connect("clicked", self._on_face_front)
        controls.pack_start(face_btn, False, False, 0)
        self.pack_start(controls, False, False, 0)

        # -- selected street + the Map Editor handoff -----------------
        street_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                             spacing=4)
        self.street_label = Gtk.Label(label="")
        self.street_label.set_halign(Gtk.Align.START)
        self.street_label.set_ellipsize(Pango.EllipsizeMode.END)
        street_row.pack_start(self.street_label, True, True, 0)
        self.map_btn = Gtk.Button(label="Open in Map Editor")
        self.map_btn.set_no_show_all(True)
        self.map_btn.hide()
        self.map_btn.connect("clicked", self._on_open_in_map_editor)
        street_row.pack_start(self.map_btn, False, False, 0)
        self.pack_start(street_row, False, False, 0)

        # -- readouts (scrollable: long content scrolls, UI rule) -----
        readout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                          spacing=2)
        self.name_label = Gtk.Label(label="")
        self.type_label = Gtk.Label(label="")
        self.size_label = Gtk.Label(label="")
        self.pos_label = Gtk.Label(label="")
        self.front_line = Gtk.Label(label="")
        self.flagged_line = Gtk.Label(label="")
        for lbl in (self.name_label, self.type_label, self.size_label,
                    self.pos_label, self.front_line, self.flagged_line):
            lbl.set_halign(Gtk.Align.START)
            lbl.set_ellipsize(Pango.EllipsizeMode.END)
            lbl.set_line_wrap(True)
            lbl.set_max_width_chars(48)
            readout.pack_start(lbl, False, False, 0)
        self.footnote = Gtk.Label(label="")
        self.footnote.set_halign(Gtk.Align.START)
        self.footnote.set_line_wrap(True)
        self.footnote.set_max_width_chars(48)
        readout.pack_start(self.footnote, False, False, 2)
        readout_scroll = Gtk.ScrolledWindow()
        readout_scroll.set_policy(Gtk.PolicyType.NEVER,
                                  Gtk.PolicyType.AUTOMATIC)
        readout_scroll.set_min_content_height(70)
        readout_scroll.add(readout)
        self.readout_scroll = readout_scroll
        self.pack_start(readout_scroll, False, True, 0)

    # -- status label (amendment 2) ------------------------------------

    def set_status(self, word):
        """Show the game-status word at the bottom left of the 3D
        view, in Joshua's colours (red Flagged, yellow Skipped,
        green Placed) — or hide the label when word is None. The
        word describes the GAME's treatment of the object, never
        the editor's: a station flipped editable still reads
        Skipped until the game itself places it."""
        self.status_word = word
        self.status_color = self.STATUS_STYLE.get(word) \
            if word else None
        if not word:
            self.status_label.hide()
            return
        color = self.STATUS_STYLE[word]
        # A dark backing keeps the yellow word readable against
        # the pale sky wash (the word and its colour are the spec;
        # the backing is presentation only).
        self.status_label.set_markup(
            f"<span font_weight=\"bold\" size=\"large\" "
            f"foreground=\"{color}\" background=\"#333333\">"
            f" {word} </span>")
        self.status_label.show()

    def _game_status(self):
        """The status word for the currently viewed object:
        Flagged wins first (Joshua's list), then a station the
        live game does not place is Skipped, else Placed."""
        if self.mode == "building":
            return "Flagged" if self.flagged_entry else "Placed"
        if self.mode == "station":
            store = self.app_window.zone_store
            review = store.review if store else None
            idx = (self.station or {}).get("stationIndex")
            if review is not None and idx is not None:
                live = review.live_status(idx)
                if live == "skipped":
                    return "Skipped"
                if live == "placed":
                    return "Placed"
            return None
        return None

    # -- showing a building ---------------------------------------------

    def show_building(self, tab, zd, index, flagged_entry):
        """Point the panel at zone building `index` of ZoneData
        `zd`. The front is derived from the roads near the building
        (parsed transiently, then dropped); the camera opens at eye
        level in front of the front wall, framed close."""
        self.mode = "building"
        self.tab = tab
        self.zd = zd
        self.zone = zd.zone if zd else None
        self.index = index
        self.box = zd.boxes[index]
        self.detail = zd.details[index]
        self.flagged_entry = flagged_entry
        self.station = None
        self.station_edit = None
        self.selected_street = None
        self.map_btn.hide()
        self.street_label.set_text("")
        # One transient parse serves the front + the backdrop.
        roads = zd.transient_roads()
        self.front_info = zonedata.building_front(
            zd, index, flagged_entry, roads=roads)
        ring = (self.front_info or {}).get("ring") \
            or self.detail.get("ring") or []
        self._roads_near = zd.nearby_segments(ring, margin=60.0,
                                              roads=roads)
        roads = None  # the parse is dropped here, on purpose
        self._reset_camera_to_front()
        self._cur_values = {
            "x": self.box[0], "z": self.box[1], "w": self.box[2],
            "d": self.box[3], "h": self.box[4]}
        self.badge_label.set_visible(bool(flagged_entry))
        self.set_status(self._game_status())
        self._update_readouts()
        self.drawing.queue_draw()

    # -- showing a station (amendment 1) ---------------------------------

    def show_station(self, tab, station, edit, zd):
        """Point the panel at a gas station: the game's station
        cluster (zonedata.station_parts) as one editable object,
        anchored at the station's editor position (real position +
        the overlay's offset), facing its nearest road like the
        game faces it. `zd` may be None (zone not loaded): the
        cluster still draws, without the roads backdrop."""
        self.mode = "station"
        self.tab = tab
        self.station = station
        self.station_edit = edit or {}
        self.zd = zd
        self.zone = station.get("zone")
        self.index = None
        self.box = None
        self.detail = None
        self.flagged_entry = None
        self.selected_street = None
        self.map_btn.hide()
        self.street_label.set_text("")
        self._station_geometry()
        self._reset_camera_to_front()
        self.badge_label.hide()
        self.set_status(self._game_status())
        self._update_readouts()
        self.drawing.queue_draw()

    def _station_geometry(self):
        """(Re)compute the station's anchor, facing and parts from
        its record + edit overlay + the current values."""
        edit = self.station_edit or {}
        vals = self._cur_values
        if vals is None:
            ax, az = zonedata.station_anchor(self.station, edit)
            vals = {
                "x": ax, "z": az,
                "w": edit.get("w") or zonedata.STATION_DEFAULT_W,
                "d": edit.get("d") or zonedata.STATION_DEFAULT_D,
                "h": edit.get("h") or zonedata.STATION_DEFAULT_H}
            self._cur_values = vals
        self.station_anchor = (vals["x"], vals["z"])
        self.station_parts = zonedata.station_parts(
            vals["w"], vals["d"], vals["h"])
        # Facing: the approach side (+z local) aims at the nearest
        # road point, exactly the game's gasFaceAngle rule. Without
        # road data the station faces south (local +z -> world +z).
        self.station_facing = 0.0
        self.front_info = None
        ring = self._station_ring()
        self._roads_near = []
        if self.zd is not None:
            roads = self.zd.transient_roads()
            self._roads_near = self.zd.nearby_segments(
                ring, margin=80.0, roads=roads)
            best = None
            ax, az = self.station_anchor
            for _name, pts in self._roads_near:
                for p in pts:
                    d2 = (p[0] - ax) ** 2 + (p[1] - az) ** 2
                    if best is None or d2 < best[0]:
                        best = (d2, p)
            if best is not None:
                p = best[1]
                self.station_facing = math.atan2(p[0] - ax, p[1] - az)
            roads = None
        # The manipulation/camera frame: front = local +z in world.
        a = self.station_facing
        fx, fz = math.sin(a), math.cos(a)
        self.front_azimuth = math.atan2(fz, fx)

    def _station_ring(self):
        """The station footprint's ground ring (rotated rectangle),
        for backdrop queries and the ground quad."""
        vals = self._cur_values or {
            "x": 0, "z": 0, "w": zonedata.STATION_DEFAULT_W,
            "d": zonedata.STATION_DEFAULT_D}
        ax, az = vals["x"], vals["z"]
        a = self.station_facing
        ca, sa = math.cos(a), math.sin(a)
        ring = []
        for lx, lz in ((-vals["w"] / 2, -vals["d"] / 2),
                       (vals["w"] / 2, -vals["d"] / 2),
                       (vals["w"] / 2, vals["d"] / 2),
                       (-vals["w"] / 2, vals["d"] / 2)):
            ring.append([ax + lx * ca + lz * sa,
                         az - lx * sa + lz * ca])
        return ring

    def _station_part_corners(self, part):
        """A part's 4 ground corners in world coordinates (its
        local rectangle rotated by the station facing)."""
        ax, az = self.station_anchor
        a = self.station_facing
        ca, sa = math.cos(a), math.sin(a)
        hw, hd = part["w"] / 2, part["d"] / 2
        out = []
        for lx, lz in ((-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)):
            x = part["lx"] + lx
            z = part["lz"] + lz
            out.append((ax + x * ca + z * sa, az - x * sa + z * ca))
        return out

    # -- camera -----------------------------------------------------------

    def _reset_camera_to_front(self):
        """The 1.7.2 default view: eye level, straight at the front
        wall. For a building the front comes from its derived front
        edge (outward normal); for a station, its facing."""
        if self.mode == "station":
            self.azimuth = self.front_azimuth
        else:
            fi = self.front_info or {}
            ring = fi.get("ring") or []
            fe = fi.get("front_edge")
            azimuth = self.DEFAULT_AZIMUTH
            if fe is not None and len(ring) >= 2:
                a, b = fi["edges"][fe]
                mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
                cx, cz = zonedata.ring_centroid(ring)
                nx, nz = mx - cx, mz - cz
                if nx or nz:
                    azimuth = math.atan2(nz, nx)
            self.front_azimuth = azimuth
            self.azimuth = azimuth
        self.elevation = self.DEFAULT_ELEVATION

    def _on_face_front(self, _widget):
        """Face front: exactly the default view again."""
        self._reset_camera_to_front()
        self.drawing.queue_draw()

    def _frame(self):
        """The manipulation frame: (front_dir, right_dir) unit
        vectors in world (x, z). Right is the viewer's right when
        standing in front looking at the front wall."""
        fa = self.front_azimuth
        f = (math.cos(fa), math.sin(fa))
        r = (f[1], -f[0])
        return f, r

    # -- readouts -----------------------------------------------------------

    def _update_readouts(self):
        """Full readout refresh (selection / external edit)."""
        if self.mode == "building":
            det, box = self.detail or {}, self.box or [0] * 6
            name = det.get("name") or "Unnamed building"
            self.title_label.set_text(name)
            self.name_label.set_text(f"Name: {name}")
            self.type_label.set_text(
                f"Type: {det.get('osm_type') or '?'} "
                f"({zonedata.CODE_LABELS.get(box[5], '?')})")
            fi = self.front_info or {}
            if fi.get("front_road"):
                self.front_line.set_text(
                    f"Fronts onto: {fi['front_road']} "
                    f"(≈ {fi.get('front_distance') or 0:.1f} units)")
            else:
                self.front_line.set_text(
                    "Front can't be determined — no road data nearby.")
            if self.flagged_entry:
                self.flagged_line.set_text(
                    f"Flagged against: "
                    f"{self.flagged_entry.get('nearestRoad') or '?'} "
                    f"— locked, awaiting Joshua's decision.")
            else:
                self.flagged_line.set_text("")
            self.footnote.set_text(
                "The orange wall is the front: the footprint edge "
                "nearest a road. The status word at the bottom left "
                "of the picture is how the game treats this "
                "building today.")
        elif self.mode == "station":
            s = self.station or {}
            name = s.get("name") or "Unnamed station"
            self.title_label.set_text(f"{name} (gas station)")
            self.name_label.set_text(
                f"Name: {name}"
                + (f" — {s.get('address')}" if s.get("address")
                   else ""))
            self.type_label.set_text(
                f"Type: Gas station ({s.get('zone') or ''})")
            live = self._game_status()
            self.front_line.set_text(
                "In the game today: "
                + ("this station is placed." if live == "Placed"
                   else "this station is left out (skipped)." if live
                   == "Skipped" else "unknown."))
            self.flagged_line.set_text(
                "Walkable: " + ("yes — people can walk in."
                                if (self.station_edit or {}).get(
                                    "walkable")
                                else "no."))
            self.footnote.set_text(
                "The orange edge is the drive-in side (faces the "
                "nearest road). Your edits save to the editor's "
                "station-edits file — the game itself does not "
                "change until a game update reads them.")
        self._update_size_pos_labels()

    def _update_size_pos_labels(self):
        """Size/position lines only (cheap; used during drags)."""
        v = self._cur_values
        if not v:
            return
        self.size_label.set_text(
            f"Size: Width {v['w']:.1f} × Depth {v['d']:.1f} — "
            f"Height ≈ {v['h']:.1f}")
        self.size_label.set_tooltip_text(self.size_label.get_text())
        self.pos_label.set_text(
            f"Position: East–West (X) {v['x']:.1f}, "
            f"North–South (Z) {v['z']:.1f}")
        self.pos_label.set_tooltip_text(self.pos_label.get_text())

    def refresh_view(self):
        """Re-derive everything after an edit made elsewhere (the
        tab's number fields, a place/delete): front, backdrop,
        readouts and picture refresh, CAMERA UNTOUCHED (Joshua's
        place in the scene is his own while he works)."""
        if self.mode == "building" and self.zd is not None \
                and self.index is not None \
                and self.index < len(self.zd.boxes):
            self.box = self.zd.boxes[self.index]
            self.detail = self.zd.details[self.index]
            roads = self.zd.transient_roads()
            self.front_info = zonedata.building_front(
                self.zd, self.index, self.flagged_entry, roads=roads)
            ring = (self.front_info or {}).get("ring") \
                or self.detail.get("ring") or []
            self._roads_near = self.zd.nearby_segments(
                ring, margin=60.0, roads=roads)
            roads = None
            self._cur_values = {
                "x": self.box[0], "z": self.box[1], "w": self.box[2],
                "d": self.box[3], "h": self.box[4]}
            self.set_status(self._game_status())
            self._update_readouts()
        elif self.mode == "station":
            self._cur_values = None
            self._station_geometry()
            self.set_status(self._game_status())
            self._update_readouts()
        self.drawing.queue_draw()

    # -- projection -----------------------------------------------------

    def _project(self, dx, dz, h, az, el):
        """Oblique projection, as 1.7.0: returns (across, vertical,
        depth) for a point offset (dx, dz) at height h."""
        ca_, sa_ = math.cos(az), math.sin(az)
        along = dx * ca_ + dz * sa_
        across = dx * sa_ - dz * ca_
        vertical = along * math.sin(el) - h * math.cos(el)
        depth = along * math.cos(el) + h * math.sin(el)
        return across, vertical, depth

    def _fit_view(self, ctx, points, width, height):
        """Fit `points` [(dx, dz, h)] into the canvas: returns a
        to_screen(dx, dz, h) closure and records the transform in
        self._view for the inverse mapping (manipulation/picking).
        Framing is from these points ONLY (the building/station
        itself — close-up per Joshua's camera rule)."""
        az, el = self.azimuth, self.elevation
        proj = [self._project(dx, dz, h, az, el)
                for dx, dz, h in points]
        if not proj:
            self._view = None
            return lambda dx, dz, h: (0, 0)
        acs = [p[0] for p in proj]
        vts = [p[1] for p in proj]
        ac_mid = (min(acs) + max(acs)) / 2
        vt_mid = (min(vts) + max(vts)) / 2
        span_a = max(max(acs) - min(acs), 1.0)
        span_v = max(max(vts) - min(vts), 1.0)
        pad = 28
        scale = min((width - 2 * pad) / span_a,
                    (height - 2 * pad) / span_v)
        scale = max(scale, 0.05)
        self._view = {"scale": scale, "ac_mid": ac_mid,
                      "vt_mid": vt_mid, "w": width, "h": height,
                      "az": az, "el": el}

        def to_screen(dx, dz, h):
            across, vertical, _d = self._project(dx, dz, h, az, el)
            return (width / 2 + (across - ac_mid) * scale,
                    height / 2 + (vertical - vt_mid) * scale)
        return to_screen

    def _screen_to_ground(self, sx, sy):
        """Inverse of the last draw's transform, onto the ground
        plane: screen point -> (dx, dz) relative offsets."""
        v = self._view
        if not v:
            return None
        scale = v["scale"]
        across = (sx - v["w"] / 2) / scale + v["ac_mid"]
        vertical = (sy - v["h"] / 2) / scale + v["vt_mid"]
        el = v["el"]
        if abs(math.sin(el)) < 1e-6:
            return None
        along = vertical / math.sin(el)
        az = v["az"]
        ca_, sa_ = math.cos(az), math.sin(az)
        dx = along * ca_ + across * sa_
        dz = along * sa_ - across * ca_
        return (dx, dz)

    # -- drawing -----------------------------------------------------------

    def _on_draw_3d(self, _widget, ctx):
        width = self.drawing.get_allocated_width()
        height = self.drawing.get_allocated_height()
        # Sky wash.
        ctx.set_source_rgb(0.92, 0.94, 0.96)
        ctx.rectangle(0, 0, width, height)
        ctx.fill()
        if self.mode == "building":
            self._draw_building(ctx, width, height)
        elif self.mode == "station":
            self._draw_station(ctx, width, height)
        else:
            ctx.set_source_rgb(0.3, 0.3, 0.3)
            ctx.select_font_face("Sans")
            ctx.set_font_size(12)
            ctx.move_to(12, 24)
            ctx.show_text("Select a building to see it here.")
        return False

    def _draw_roads(self, ctx, to_screen, cx, cz):
        """The backdrop streets (+ the selected street highlighted,
        amendment 3; the front road named)."""
        selected = (self.selected_street or {}).get("name")
        front_name = None
        if self.mode == "building":
            front_name = (self.front_info or {}).get("front_road")
        for name, pts in self._roads_near:
            if len(pts) < 2:
                continue
            if selected and name == selected:
                ctx.set_source_rgb(*self.STREET_HILITE_RGB)
                ctx.set_line_width(7)
            elif front_name and name == front_name:
                ctx.set_source_rgb(0.45, 0.45, 0.45)
                ctx.set_line_width(5)
            else:
                ctx.set_source_rgb(0.62, 0.62, 0.62)
                ctx.set_line_width(5)
            for i, p in enumerate(pts):
                sx, sy = to_screen(p[0] - cx, p[1] - cz, 0)
                if i == 0:
                    ctx.move_to(sx, sy)
                else:
                    ctx.line_to(sx, sy)
            ctx.stroke()
        # Name the front road beside its nearest point.
        if front_name:
            ring = (self.front_info or {}).get("ring") or []
            if ring:
                ccx, ccz = zonedata.ring_centroid(ring)
                best = None
                for name, pts in self._roads_near:
                    if name != front_name:
                        continue
                    for p in pts:
                        d2 = (p[0] - ccx) ** 2 + (p[1] - ccz) ** 2
                        if best is None or d2 < best[0]:
                            best = (d2, p)
                if best is not None:
                    sx, sy = to_screen(best[1][0] - cx,
                                       best[1][1] - cz, 0)
                    ctx.set_source_rgb(0.25, 0.25, 0.25)
                    ctx.select_font_face("Sans")
                    ctx.set_font_size(11)
                    ctx.move_to(sx + 6, sy - 6)
                    ctx.show_text(front_name)

    def _draw_building(self, ctx, width, height):
        det = self.detail or {}
        ring = det.get("ring") or []
        if len(ring) < 2 or not self.box:
            ctx.set_source_rgb(0.3, 0.3, 0.3)
            ctx.select_font_face("Sans")
            ctx.set_font_size(12)
            ctx.move_to(12, 24)
            ctx.show_text("This building has no footprint to draw.")
            return
        cx, cz = zonedata.ring_centroid(ring)
        hgt = self.box[4]
        points = [(p[0] - cx, p[1] - cz, 0) for p in ring]
        points += [(p[0] - cx, p[1] - cz, hgt) for p in ring]
        to_screen = self._fit_view(ctx, points, width, height)
        # Ground quad under the building (footprint grown a little).
        xs = [p[0] for p in ring]
        zs = [p[1] for p in ring]
        gx0, gx1 = min(xs) - 6, max(xs) + 6
        gz0, gz1 = min(zs) - 6, max(zs) + 6
        ctx.set_source_rgb(0.78, 0.82, 0.72)
        for i, (px, pz) in enumerate(((gx0, gz0), (gx1, gz0),
                                      (gx1, gz1), (gx0, gz1))):
            sx, sy = to_screen(px - cx, pz - cz, 0)
            if i == 0:
                ctx.move_to(sx, sy)
            else:
                ctx.line_to(sx, sy)
        ctx.close_path()
        ctx.fill()
        self._draw_roads(ctx, to_screen, cx, cz)
        # Walls, painter-sorted by depth; the front wall is orange.
        fi = self.front_info or {}
        front_edge = fi.get("front_edge")
        faces = []
        n = len(ring)
        for i in range(n):
            a = ring[i]
            b = ring[(i + 1) % n]
            depth = 0.0
            for p in (a, b):
                depth += self._project(p[0] - cx, p[1] - cz, 0,
                                       self.azimuth,
                                       self.elevation)[2]
            faces.append((depth / 2, i, a, b))
        faces.sort()
        light = (-0.45, -0.89)
        for _depth, i, a, b in faces:
            is_front = (front_edge is not None and i == front_edge)
            quad = [to_screen(a[0] - cx, a[1] - cz, 0),
                    to_screen(b[0] - cx, b[1] - cz, 0),
                    to_screen(b[0] - cx, b[1] - cz, hgt),
                    to_screen(a[0] - cx, a[1] - cz, hgt)]
            if is_front:
                ctx.set_source_rgb(*self.FRONT_RGB)
            else:
                mx, mz = (a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz
                norm = math.hypot(mx, mz) or 1.0
                shade = 0.62 + 0.25 * (mx * light[0] + mz * light[1]) \
                    / norm
                ctx.set_source_rgb(shade * 0.85, shade * 0.9, shade)
            for j, (sx, sy) in enumerate(quad):
                if j == 0:
                    ctx.move_to(sx, sy)
                else:
                    ctx.line_to(sx, sy)
            ctx.close_path()
            ctx.fill()
        # Roof.
        ctx.set_source_rgb(0.55, 0.42, 0.36)
        for i, p in enumerate(ring):
            sx, sy = to_screen(p[0] - cx, p[1] - cz, hgt)
            if i == 0:
                ctx.move_to(sx, sy)
            else:
                ctx.line_to(sx, sy)
        ctx.close_path()
        ctx.fill()
        # FRONT label + ground arrow out of the front edge.
        if front_edge is not None:
            a, b = fi["edges"][front_edge]
            mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            sx, sy = to_screen(mx - cx, mz - cz, hgt)
            ctx.set_source_rgb(0.85, 0.35, 0.0)
            ctx.select_font_face("Sans", 0, 1)  # bold
            ctx.set_font_size(13)
            ctx.move_to(sx - 18, sy - 8)
            ctx.show_text("FRONT")
            nx, nz = mx - cx, mz - cz
            norm = math.hypot(nx, nz) or 1.0
            ex, ez = mx + nx / norm * 8, mz + nz / norm * 8
            sx2, sy2 = to_screen(ex - cx, ez - cz, 0)
            sx1, sy1 = to_screen(mx - cx, mz - cz, 0)
            ctx.set_source_rgb(0.95, 0.45, 0.05)
            ctx.set_line_width(3)
            ctx.move_to(sx1, sy1)
            ctx.line_to(sx2, sy2)
            ctx.stroke()

    _STATION_COLORS = {
        "pad": (0.45, 0.47, 0.49),
        "canopy": (0.92, 0.92, 0.92),
        "kiosk": (0.85, 0.82, 0.77),
        "roof": (0.29, 0.31, 0.33),
        "column": (0.95, 0.95, 0.95),
        "pump": (0.69, 0.19, 0.19),
    }

    def _draw_station(self, ctx, width, height):
        ax, az = self.station_anchor
        ring = self._station_ring()
        points = [(p[0] - ax, p[1] - az, 0) for p in ring]
        top_h = max((p["y1"] for p in self.station_parts),
                    default=8.5)
        points += [(p[0] - ax, p[1] - az, top_h) for p in ring]
        to_screen = self._fit_view(ctx, points, width, height)
        # Ground quad.
        xs = [p[0] for p in ring]
        zs = [p[1] for p in ring]
        gx0, gx1 = min(xs) - 8, max(xs) + 8
        gz0, gz1 = min(zs) - 8, max(zs) + 8
        ctx.set_source_rgb(0.78, 0.82, 0.72)
        for i, (px, pz) in enumerate(((gx0, gz0), (gx1, gz0),
                                      (gx1, gz1), (gx0, gz1))):
            sx, sy = to_screen(px - ax, pz - az, 0)
            if i == 0:
                ctx.move_to(sx, sy)
            else:
                ctx.line_to(sx, sy)
        ctx.close_path()
        ctx.fill()
        self._draw_roads(ctx, to_screen, ax, az)
        # The cluster's parts as boxes, painter-sorted by depth.
        boxes = []
        for part in self.station_parts:
            corners = self._station_part_corners(part)
            dcx = sum(p[0] for p in corners) / 4 - ax
            dcz = sum(p[1] for p in corners) / 4 - az
            depth = self._project(dcx, dcz, 0, self.azimuth,
                                  self.elevation)[2]
            boxes.append((depth, part, corners))
        boxes.sort(key=lambda t: t[0])
        for _depth, part, corners in boxes:
            base = self._STATION_COLORS.get(part["kind"],
                                            (0.7, 0.7, 0.7))
            # Side faces (two, chosen by view side) then the top.
            n = len(corners)
            for i in range(n):
                a = corners[i]
                b = corners[(i + 1) % n]
                mx, mz = (a[0] + b[0]) / 2 - ax, (a[1] + b[1]) / 2 - az
                facing = mx * math.cos(self.azimuth) \
                    + mz * math.sin(self.azimuth)
                if facing < -0.001:
                    continue  # back face — the far side draws it
                quad = [to_screen(a[0] - ax, a[1] - az, part["y0"]),
                        to_screen(b[0] - ax, b[1] - az, part["y0"]),
                        to_screen(b[0] - ax, b[1] - az, part["y1"]),
                        to_screen(a[0] - ax, a[1] - az, part["y1"])]
                ctx.set_source_rgb(base[0] * 0.8, base[1] * 0.8,
                                   base[2] * 0.8)
                for j, (sx, sy) in enumerate(quad):
                    if j == 0:
                        ctx.move_to(sx, sy)
                    else:
                        ctx.line_to(sx, sy)
                ctx.close_path()
                ctx.fill()
            ctx.set_source_rgb(*base)
            for i, p in enumerate(corners):
                sx, sy = to_screen(p[0] - ax, p[1] - az, part["y1"])
                if i == 0:
                    ctx.move_to(sx, sy)
                else:
                    ctx.line_to(sx, sy)
            ctx.close_path()
            ctx.fill()
        # The drive-in (front) edge of the pad, orange, + label.
        f, _r = self._frame()
        vals = self._cur_values or {}
        hd = (vals.get("d") or zonedata.STATION_DEFAULT_D) / 2
        hw = (vals.get("w") or zonedata.STATION_DEFAULT_W) / 2
        cxw, czw = ax + f[0] * hd, az + f[1] * hd
        rx, rz = _r
        a_pt = (cxw - rx * hw, czw - rz * hw)
        b_pt = (cxw + rx * hw, czw + rz * hw)
        ctx.set_source_rgb(0.95, 0.45, 0.05)
        ctx.set_line_width(4)
        sx1, sy1 = to_screen(a_pt[0] - ax, a_pt[1] - az, 0.35)
        sx2, sy2 = to_screen(b_pt[0] - ax, b_pt[1] - az, 0.35)
        ctx.move_to(sx1, sy1)
        ctx.line_to(sx2, sy2)
        ctx.stroke()
        sx, sy = to_screen(cxw - ax, czw - az, top_h)
        ctx.set_source_rgb(0.85, 0.35, 0.0)
        ctx.select_font_face("Sans", 0, 1)
        ctx.set_font_size(13)
        ctx.move_to(sx - 18, sy - 8)
        ctx.show_text("FRONT")

    # -- picking streets (amendment 3) --------------------------------------

    def pick_street(self, sx, sy):
        """
        The picking function (also driven directly by the smoke
        tests): find the drawn street nearest the screen point
        (sx, sy) within tolerance; select it and return its record
        {"name", "x", "z", "zone"} — the clicked point projected
        onto the segment — or None when no street is close.
        """
        if not self._view or not self._roads_near:
            return None
        cx, cz = self._centre()
        best = None  # (screen distance, name, world point)
        for name, pts in self._roads_near:
            for i in range(len(pts) - 1):
                a, b = pts[i], pts[i + 1]
                sax, say = self._to_screen_now(a[0] - cx, a[1] - cz)
                sbx, sby = self._to_screen_now(b[0] - cx, b[1] - cz)
                d, t = self._point_seg_dist(sx, sy, sax, say,
                                             sbx, sby)
                if best is None or d < best[0]:
                    wx = a[0] + (b[0] - a[0]) * t
                    wz = a[1] + (b[1] - a[1]) * t
                    best = (d, name, (wx, wz))
        if best is None or best[0] > 10:
            self.selected_street = None
            self.map_btn.hide()
            self.street_label.set_text("")
            self.drawing.queue_draw()
            return None
        self.selected_street = {
            "name": best[1], "x": best[2][0], "z": best[2][1],
            "zone": self.zone}
        self.street_label.set_text(
            f"Street selected: {best[1]}")
        self.street_label.set_tooltip_text(
            f"Street selected: {best[1]} (in {self.zone})")
        self.map_btn.show()
        self.drawing.queue_draw()
        return self.selected_street

    @staticmethod
    def _point_seg_dist(px, py, ax, ay, bx, by):
        """(distance, t) from point to segment (screen space)."""
        vx, vy = bx - ax, by - ay
        len2 = vx * vx + vy * vy
        t = 0.0 if len2 == 0 else max(
            0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / len2))
        dx = px - (ax + vx * t)
        dy = py - (ay + vy * t)
        return (dx * dx + dy * dy) ** 0.5, t

    def _centre(self):
        """The world point the current view is centred on."""
        if self.mode == "station":
            return self.station_anchor
        ring = (self.detail or {}).get("ring") or []
        if ring:
            return zonedata.ring_centroid(ring)
        return (0.0, 0.0)

    def _to_screen_now(self, dx, dz):
        """Project with the LAST draw's transform (picking space)."""
        v = self._view
        across, vertical, _d = self._project(
            dx, dz, 0, v["az"], v["el"])
        return (v["w"] / 2 + (across - v["ac_mid"]) * v["scale"],
                v["h"] / 2 + (vertical - v["vt_mid"]) * v["scale"])

    def _on_open_in_map_editor(self, _widget):
        """Hand the selected street's location to the Map Editor."""
        s = self.selected_street
        if s:
            self.app_window.open_in_map_editor(
                s["zone"], s["x"], s["z"], s["name"])

    # -- dragging: orbit, manipulation, click-to-pick -----------------------

    def _classify_grab(self, sx, sy):
        """
        What a press at (sx, sy) grabs, by the manipulation rules:
        ("width"|"depth", side) near a roof edge, "move" inside the
        roof, "height" inside the front face, else None (orbit /
        click). Uses the viewed object's BOX rectangle (the same
        rectangle the number fields describe).
        """
        v = self._cur_values
        if not v or not self._view:
            return None
        f, r = self._frame()
        cx, cz = v["x"], v["z"]
        hw, hd = v["w"] / 2, v["d"] / 2

        def corner(sr, sf, h):
            return (cx + r[0] * sr + f[0] * sf,
                    cz + r[1] * sr + f[1] * sf, h)

        ccx, ccz = self._centre()
        # The roof rectangle's corners on screen (projected with
        # the last draw's transform, at the building's height).
        roof = []
        for sr, sf in ((-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)):
            wx, wz, hh = corner(sr, sf, v["h"])
            roof.append(self._project_screen(wx - ccx, wz - ccz, hh))
        # Edges: 0=back (sf=-hd), 1=right (sr=+hw), 2=front, 3=left.
        edges = [(3, 0, "width", -1), (0, 1, "depth", -1),
                 (1, 2, "width", +1), (2, 3, "depth", +1)]
        for i0, i1, kind, side in edges:
            d, _t = self._point_seg_dist(
                sx, sy, roof[i0][0], roof[i0][1],
                roof[i1][0], roof[i1][1])
            if d <= 9:
                return (kind, side)
        if self._point_in_poly(sx, sy, roof):
            return ("move", 0)
        # The front face: front roof edge down to the ground.
        gx1, gz1, _gh = corner(hw, hd, 0)
        gx0, gz0, _gh = corner(-hw, hd, 0)
        fr0 = self._project_screen(gx1 - ccx, gz1 - ccz, 0)
        fr1 = self._project_screen(gx0 - ccx, gz0 - ccz, 0)
        face = [roof[2], roof[3], fr1, fr0]
        if self._point_in_poly(sx, sy, face):
            return ("height", 0)
        return None

    def _project_screen(self, dx, dz, h):
        """Project with the last draw's transform, at height h."""
        v = self._view
        across, vertical, _d = self._project(dx, dz, h,
                                             v["az"], v["el"])
        return (v["w"] / 2 + (across - v["ac_mid"]) * v["scale"],
                v["h"] / 2 + (vertical - v["vt_mid"]) * v["scale"])

    @staticmethod
    def _point_in_poly(px, py, poly):
        inside = False
        n = len(poly)
        for i in range(n):
            x1, y1 = poly[i]
            x2, y2 = poly[(i + 1) % n]
            if (y1 > py) != (y2 > py):
                xin = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
                if px < xin:
                    inside = not inside
        return inside

    def _on_drag_press(self, _widget, event):
        if event.button != 1 or self.mode is None:
            return False
        # Fresh values first: the grab classification works on the
        # same numbers the tab's fields currently show.
        values = None
        if self.tab is not None:
            try:
                values = self.tab.manip_values()
            except Exception:
                values = None
        if values:
            self._cur_values = dict(values)
        grab = self._classify_grab(event.x, event.y)
        self._drag = {
            "kind": grab[0] if grab else "orbit",
            "side": grab[1] if grab else 0,
            "sx": event.x, "sy": event.y,
            "x": event.x, "y": event.y,
            "az0": self.azimuth, "el0": self.elevation,
            "start": dict(self._cur_values) if self._cur_values
            else None,
            # The view frame's centre, frozen at press time
            # (2026-10-17, manipulation-gate find): the ground
            # offsets _screen_to_ground returns are relative to
            # the centre the view was FIT on, but _centre() moves
            # mid-drag as the object itself is moved/resized —
            # using the live centre corrupted every width/depth
            # step after the first.
            "centre": self._centre(),
            "moved": False,
        }
        return True

    def _on_drag_motion(self, _widget, event):
        d = self._drag
        if d is None:
            return False
        dx = event.x - d["x"]
        dy = event.y - d["y"]
        if abs(event.x - d["sx"]) + abs(event.y - d["sy"]) > 4:
            d["moved"] = True
        kind = d["kind"]
        if kind == "orbit":
            self.azimuth = d["az0"] + (event.x - d["sx"]) * 0.01
            self.elevation = max(
                self.MIN_ELEVATION,
                min(self.MAX_ELEVATION,
                    d["el0"] + (d["sy"] - event.y) * 0.01))
            self.drawing.queue_draw()
            return True
        if d["start"] is None or self.tab is None:
            return True
        start = d["start"]
        cand = dict(start)
        f, r = self._frame()
        if kind == "move":
            # Ground-plane deltas are centre-independent (the
            # inverse mapping returns centre-relative offsets).
            g0 = self._screen_to_ground(d["sx"], d["sy"])
            g1 = self._screen_to_ground(event.x, event.y)
            if g0 and g1:
                cand["x"] = start["x"] + (g1[0] - g0[0])
                cand["z"] = start["z"] + (g1[1] - g0[1])
        elif kind in ("width", "depth"):
            g = self._screen_to_ground(event.x, event.y)
            if not g:
                return True
            # Frozen fit-time centre (see _on_drag_press): the
            # ground offsets live in the fitted view's frame.
            ccx, ccz = d.get("centre") or self._centre()
            px, pz = ccx + g[0], ccz + g[1]
            axis = r if kind == "width" else f
            dim = "w" if kind == "width" else "d"
            u = (px - start["x"]) * axis[0] + (pz - start["z"]) * axis[1]
            u0 = d["side"] * start[dim] / 2
            delta = u - u0
            cand[dim] = max(1.0, min(1000.0,
                                     start[dim] + d["side"] * delta))
            shift = delta / 2
            cand["x"] = start["x"] + axis[0] * shift
            cand["z"] = start["z"] + axis[1] * shift
        elif kind == "height":
            scale = (self._view or {}).get("scale", 1.0)
            dh = (d["sy"] - event.y) / max(
                scale * math.cos(self.elevation), 0.01)
            cand["h"] = max(1.0, min(200.0, start["h"] + dh))
        try:
            ok = self.tab.manip_apply(cand)
        except Exception:
            ok = False
        if not ok:
            # Refused (e.g. a flagged building): end the drag; the
            # tab has said why in the status bar.
            self._drag = None
            return True
        self._cur_values = cand
        if self.mode == "station":
            self.station_anchor = (cand["x"], cand["z"])
            self.station_parts = zonedata.station_parts(
                cand["w"], cand["d"], cand["h"])
        self._update_size_pos_labels()
        self.drawing.queue_draw()
        return True

    def _on_drag_release(self, _widget, event):
        d = self._drag
        self._drag = None
        if d is not None and d["kind"] == "orbit" and not d["moved"]:
            # A click, not a drag: it may be a street pick.
            self.pick_street(event.x, event.y)
        elif d is not None and d["kind"] in (
                "move", "width", "depth", "height"):
            # A manipulation drag ended: let the tab re-derive the
            # front + backdrop at the object's new spot.
            hook = getattr(self.tab, "on_manip_end", None)
            if hook is not None:
                hook()
        return True


# ---------------------------------------------------------------------------
# Zone Buildings tab — light index browsing, on-demand zone detail
# ---------------------------------------------------------------------------

class ZoneBuildingsTab(Gtk.Box):
    """
    Zone-by-zone view of the game's converted building files
    (zonedata.GameStore), 1.7.2 style:

    * The LIST comes from the zone's LIGHT INDEX (downloaded from
      GitHub): name, type, position, size for every building —
      enough to browse, search and sort with only ~2–4 MB per zone
      in memory. Clicking Name / Type / Flagged column headers
      sorts the whole list (1.7.2).
    * Selecting a building downloads ONLY its zone's full records
      (the window's ensure_zone_detail, with the MB progress bar),
      fills the number fields, and opens the 3D inspector.
    * The edit fields are spelled out in plain words (1.7.2):
      East–West position (X), North–South position (Z), Width (W),
      Depth (D), Height (H). Typing a number applies it at once —
      the same values the 3D drag handles use, synced both ways.
    * FLAG STATE: the list's FLAGGED marker is centre-based while
      only the index is loaded; the LOCK always re-checks against
      the building's real footprint once its zone is loaded
      (zonedata's ring match), so a flagged building can never be
      edited from the list alone.
    * LAYOUT (EDITOR UI RULE + 1.7.2 vertical adjustment): the data
      column is split VERTICALLY — hero list / buildings list above,
      the edit + place rows below — with draggable dividers, so
      Joshua can pull the details below up into view or give the
      list the whole column; the wide number rows ride in
      horizontal scrollers whose rows are tall enough that text
      never clips.

    Placement / move / resize / delete go through zonedata, so
    zone attribution, box/detail alignment and the flagged lock
    are enforced by the same code the harness tests. Saving is the
    window's round trip.
    """

    # Rows materialised in the Gtk list at once (the full filtered
    # set is held as light row dicts; the widget shows a window).
    ROW_CAP = 1000

    def __init__(self, window):
        """window: the AssetEditorWindow (store + status access)."""
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.set_border_width(8)
        self.app_window = window
        self._zone = "adamsville"
        self._filter_id = "all"        # the ONE filter state (below)
        self._sort_key = None          # None | "name" | "type" | "flag"
        self._sort_asc = True
        self._rows = []                # full filtered row dicts
        self._spins_loading = False    # guard: programmatic spin sets
        self._place_retry = False      # place-after-load retry flag

        # The left data column: everything this tab shows lives
        # here; the inspector is the right pane of the horizontal
        # split packed at the end of __init__.
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
        # A label must never set the window's width (1.7.1): it
        # ellipsizes; refresh() keeps the full text on its tooltip.
        self.info_label.set_ellipsize(Pango.EllipsizeMode.END)
        self.info_label.set_max_width_chars(48)
        top.pack_start(self.info_label, True, True, 6)
        self.data_box.pack_start(top, False, False, 0)

        # --- Upper block: hero list + buildings list ----------------
        # Hero buildings (read-only listing).
        hero_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                           spacing=2)
        hero_lbl = Gtk.Label()
        hero_lbl.set_markup("<b>Hero buildings (read-only)</b>")
        hero_lbl.set_halign(Gtk.Align.START)
        self.hero_label = hero_lbl
        hero_box.pack_start(hero_lbl, False, False, 2)
        self.hero_store = Gtk.ListStore(str, str, str)
        hero_tree = Gtk.TreeView(model=self.hero_store)
        for i, title in enumerate(("ID", "Name", "Address")):
            hero_tree.append_column(Gtk.TreeViewColumn(
                title, Gtk.CellRendererText(), text=i))
        hero_scroll = Gtk.ScrolledWindow()
        hero_scroll.set_min_content_height(48)
        hero_scroll.add(hero_tree)
        self.hero_scroll = hero_scroll
        hero_box.pack_start(hero_scroll, True, True, 0)

        # Buildings list block: filter row + heading + the list.
        list_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                           spacing=2)
        filter_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                             spacing=6)
        filter_row.pack_start(Gtk.Label(label="Category:"),
                              False, False, 0)
        self.filter_combo = Gtk.ComboBoxText()
        # Entry order is part of the panel's contract (the smoke
        # test selects "Flagged only" by this index): All, the four
        # CODE_LABELS in code order, then Flagged only.
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
        self.filter_combo.connect("changed", self._on_filter_changed)
        filter_row.pack_start(self.filter_combo, False, False, 0)
        list_box.pack_start(filter_row, False, False, 2)
        b_lbl = Gtk.Label()
        b_lbl.set_markup("<b>Buildings</b> (FLAGGED = locked, awaiting "
                         "Joshua's decision)")
        b_lbl.set_halign(Gtk.Align.START)
        b_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        b_lbl.set_tooltip_text(
            "Buildings (FLAGGED = locked, awaiting Joshua's decision)")
        list_box.pack_start(b_lbl, False, False, 2)
        self.store = Gtk.ListStore(int, str, str, str)
        self.tree = Gtk.TreeView(model=self.store)
        # 1.7.2 SORTING: Name / Type / Flagged headers are clickable
        # and sort the WHOLE list (the rows are light dicts, so a
        # full sort is cheap); clicking again reverses direction.
        self._columns = {}
        for i, (title, key) in enumerate(
                (("#", None), ("Name", "name"), ("Type", "type"),
                 ("Flagged", "flag"))):
            col = Gtk.TreeViewColumn(title, Gtk.CellRendererText(),
                                     text=i)
            if key is not None:
                col.set_clickable(True)
                col.connect("clicked",
                            lambda c, k=key: self._on_header_clicked(k))
            self._columns[key] = col
            self.tree.append_column(col)
        self.tree.get_selection().connect("changed", self._on_select)
        scroll = Gtk.ScrolledWindow()
        scroll.set_min_content_height(120)
        scroll.add(self.tree)
        # Kept as an attribute: the smoke test asserts the long
        # buildings list lives inside a scrolled window (EDITOR UI
        # RULE — long content scrolls, never clips).
        self.list_scroll = scroll
        list_box.pack_start(scroll, True, True, 0)

        # The hero block and the list block share the upper area
        # through a VERTICAL divider Joshua can drag.
        self.upper_paned = Gtk.Paned(
            orientation=Gtk.Orientation.VERTICAL)
        self.upper_paned.set_wide_handle(True)
        self.upper_paned.pack1(hero_box, True, True)
        self.upper_paned.pack2(list_box, True, True)

        # --- Lower block: edit + place rows ---------------------------
        lower_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                            spacing=2)
        edit_lbl = Gtk.Label()
        edit_lbl.set_markup("<b>Edit selected building</b> "
                            "(typing a number applies it at once)")
        edit_lbl.set_halign(Gtk.Align.START)
        edit_lbl.set_ellipsize(Pango.EllipsizeMode.END)
        lower_box.pack_start(edit_lbl, False, False, 2)
        edit = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.mx = Gtk.SpinButton.new_with_range(-30000, 30000, 1)
        self.mz = Gtk.SpinButton.new_with_range(-30000, 30000, 1)
        self.mw = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.md = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.mh = Gtk.SpinButton.new_with_range(1, 200, 1)
        # 1.7.2 spelled-out labels (Joshua): plain words first, the
        # letter kept in parentheses for reference.
        for label, spin in (
                ("East–West position (X)", self.mx),
                ("North–South position (Z)", self.mz),
                ("Width (W)", self.mw),
                ("Depth (D)", self.md),
                ("Height (H)", self.mh)):
            edit.pack_start(Gtk.Label(label=label), False, False, 0)
            edit.pack_start(spin, False, False, 0)
            spin.connect("value-changed",
                         lambda s: self._on_spin_changed())
        move_btn = Gtk.Button(label="Move / Resize Selected")
        move_btn.connect("clicked", self._on_move_resize)
        edit.pack_start(move_btn, False, False, 4)
        del_btn = Gtk.Button(label="Delete Selected")
        del_btn.connect("clicked", self._on_delete)
        edit.pack_start(del_btn, False, False, 0)
        # Horizontal scroller (the row is wide; at full width it
        # looks as before, narrowed it scrolls — 1.7.1 pattern).
        self.edit_scroll = Gtk.ScrolledWindow()
        self.edit_scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                                    Gtk.PolicyType.NEVER)
        self.edit_scroll.set_shadow_type(Gtk.ShadowType.NONE)
        self.edit_scroll.add(edit)
        lower_box.pack_start(self.edit_scroll, False, False, 2)

        place_lbl = Gtk.Label()
        place_lbl.set_markup("<b>Place a new building</b>")
        place_lbl.set_halign(Gtk.Align.START)
        lower_box.pack_start(place_lbl, False, False, 2)
        place = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.px = Gtk.SpinButton.new_with_range(-30000, 30000, 1)
        self.pz = Gtk.SpinButton.new_with_range(-30000, 30000, 1)
        self.pw = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.pd = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.ph = Gtk.SpinButton.new_with_range(1, 200, 1)
        self.pw.set_value(24); self.pd.set_value(18); self.ph.set_value(5)
        for label, spin in (
                ("East–West position (X)", self.px),
                ("North–South position (Z)", self.pz),
                ("Width (W)", self.pw),
                ("Depth (D)", self.pd),
                ("Height (H)", self.ph)):
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
        self.pname.set_width_chars(12)
        place.pack_start(self.pname, True, True, 0)
        place_btn = Gtk.Button(label="Place Building")
        place_btn.connect("clicked", self._on_place)
        place.pack_start(place_btn, False, False, 0)
        self.place_scroll = Gtk.ScrolledWindow()
        self.place_scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                                     Gtk.PolicyType.NEVER)
        self.place_scroll.set_shadow_type(Gtk.ShadowType.NONE)
        self.place_scroll.add(place)
        lower_box.pack_start(self.place_scroll, False, False, 2)

        # The data column's VERTICAL split (1.7.2): lists above,
        # edit/place rows below, divider draggable — the flagged
        # list's window is adjustable vertically and the details
        # below can be pulled up into view (Joshua's report).
        self.vpaned = Gtk.Paned(orientation=Gtk.Orientation.VERTICAL)
        self.vpaned.set_wide_handle(True)
        self.vpaned.pack1(self.upper_paned, True, True)
        self.vpaned.pack2(lower_box, True, True)
        self.data_box.pack_start(self.vpaned, True, True, 0)

        # --- Split pane: data column (left) + inspector (right) ----
        # The inspector starts hidden; selecting a building shows
        # it. The data column is pack1 and is NEVER hidden.
        self.inspector = ZoneInspectorPanel(self)
        self.inspector.set_visible(False)
        self.paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self.paned.set_wide_handle(True)
        # shrink=True on both children (1.7.1): the divider travels
        # the full width; contents stay usable small.
        self.paned.pack1(self.data_box, True, True)
        self.paned.pack2(self.inspector, False, True)
        self.pack_start(self.paned, True, True, 0)
        # Divider memory (session): Joshua's dragged position is
        # restored every time the inspector reopens.
        self._split_pos = None
        self._split_guard = False
        self.paned.connect("notify::position", self._on_split_moved)

        self.refresh()

    def _on_split_moved(self, paned, _param):
        """Remember a user-dragged divider position (this session)."""
        if not self._split_guard and self.inspector.get_visible():
            self._split_pos = paned.get_position()

    # -- helpers ---------------------------------------------------------

    def _store(self):
        return self.app_window.zone_store

    def _zd(self):
        """The current zone's FULL ZoneData, or None when only its
        light index is loaded (the normal browsing state, 1.7.2)."""
        store = self._store()
        return store.zones.get(self._zone) if store else None

    def _selected_index(self):
        """Index (into the zone's arrays) of the selected row."""
        sel = self.tree.get_selection()
        model, it = sel.get_selected()
        if it is None:
            return None
        return model.get_value(it, 0)

    def _set_spins(self, x, z, w, d, h):
        """Fill the edit fields WITHOUT triggering live-apply."""
        self._spins_loading = True
        try:
            self.mx.set_value(x); self.mz.set_value(z)
            self.mw.set_value(w); self.md.set_value(d)
            self.mh.set_value(h)
        finally:
            self._spins_loading = False

    # -- the list: rows from the index (or the loaded detail) -----------

    def _build_rows(self):
        """The full row set for the current zone + filter, sorted
        per the active sort. Row: {i, name, code, flagged}."""
        store = self._store()
        if store is None:
            return [], 0, 0
        zd = self._zd()
        rows = []
        flagged_n = 0
        if zd is not None:
            for i, (box, det) in enumerate(zip(zd.boxes, zd.details)):
                is_flag = store.flagged.match(
                    self._zone, det.get("ring") or []) is not None
                flagged_n += 1 if is_flag else 0
                rows.append({"i": i, "name": det.get("name") or "",
                             "code": int(box[5]), "flagged": is_flag})
            total = len(zd.boxes)
        else:
            idx = store.indexes.get(self._zone)
            if idx is None:
                return [], 0, 0
            for i, e in enumerate(idx.entries):
                is_flag = store.flagged.match_point(
                    self._zone, e["x"], e["z"]) is not None
                flagged_n += 1 if is_flag else 0
                rows.append({"i": i, "name": e.get("n") or "",
                             "code": int(e.get("c", 0)),
                             "flagged": is_flag})
            total = len(idx.entries)
        filt = self._filter_id
        if filt == "flagged":
            rows = [r for r in rows if r["flagged"]]
        elif filt != "all":
            rows = [r for r in rows if r["code"] == int(filt)]
        if self._sort_key == "name":
            rows.sort(key=lambda r: (r["name"].casefold(), r["i"]),
                      reverse=not self._sort_asc)
        elif self._sort_key == "type":
            rows.sort(key=lambda r: (r["code"], r["name"].casefold(),
                                     r["i"]),
                      reverse=not self._sort_asc)
        elif self._sort_key == "flag":
            rows.sort(key=lambda r: (not r["flagged"], r["i"]),
                      reverse=not self._sort_asc)
        return rows, total, flagged_n

    def refresh(self):
        """
        Repopulate hero + building lists. The filter state is read
        ONLY from self._filter_id (set solely by the combo's own
        handler) — 1.7.2's fix for the stuck category filter: in
        1.7.1 every refresh re-derived the filter from the widget,
        and any refresh triggered while the combo was mid-change
        (a selection change during repopulation, a save refresh, a
        zone switch) could snap the visible list back; now the
        combo sets state, and refresh() only ever READS state, so
        switching category works in every state, flagged view
        included.

        1.7.2 (real-GTK fix, found by the Xvfb smoke 2026-10-17):
        clearing the list store makes real GTK drop the tree's
        selection — so a refresh landing right after a click (the
        on-demand zone load finishing) silently ate the selection,
        and the inspector never opened on the building Joshua had
        just picked. (The GTK stub kept the selection, which is
        why only the real-GTK run saw it.) refresh() now remembers
        the selected building and re-selects its row afterwards;
        re-selecting fires the normal selection path, which opens
        the inspector when the zone is loaded — the user's place
        is kept across every refresh.
        """
        keep_index = None
        try:
            keep_index = self._selected_index()
        except Exception:
            keep_index = None
        self.hero_store.clear()
        self.store.clear()
        store = self._store()
        if store is None:
            self.info_label.set_text("Zone data unavailable.")
            return
        zd = self._zd()
        # Hero list: from the full data when loaded, else the index.
        heroes = []
        if zd is not None:
            heroes = zd.hero_list()
        else:
            idx = store.indexes.get(self._zone)
            if idx is not None:
                heroes = idx.heroes
        for hb in heroes:
            self.hero_store.append([hb.get("id") or "",
                                    hb.get("name") or "",
                                    hb.get("address") or ""])
        self._rows, total, flagged_n = self._build_rows()
        for r in self._rows[:self.ROW_CAP]:
            self.store.append([r["i"], r["name"],
                               zonedata.CODE_LABELS.get(r["code"], "?"),
                               "FLAGGED" if r["flagged"] else ""])
        state = "full records loaded" if zd is not None \
            else "list only — pick a building to load its zone"
        info = (f"{self._zone}: {total} buildings, {len(heroes)} hero, "
                f"{store.flagged.count(self._zone)} flagged in zone "
                f"({state}; showing {min(self.ROW_CAP, len(self._rows))} "
                f"of {len(self._rows)} rows)")
        if zd is not None and zd.dirty:
            info += " — UNSAVED CHANGES"
        if self._filter_id != "all":
            label = self._filter_labels[
                self._filter_values.index(self._filter_id)]
            info += f" — filter: {label}"
        if self._sort_key:
            info += (f" — sorted by {self._sort_key} "
                     f"({'A→Z' if self._sort_asc else 'Z→A'})")
        self.info_label.set_text(info)
        self.info_label.set_tooltip_text(info)
        # Restore the selection the clear() dropped (see above).
        if keep_index is not None:
            for pos, r in enumerate(self._rows[:self.ROW_CAP]):
                if r["i"] == keep_index:
                    try:
                        self.tree.get_selection().select_path(
                            Gtk.TreePath.new_from_string(str(pos)))
                    except Exception:
                        pass
                    break

    def _update_row(self, index):
        """Refresh one visible row in place (after an edit) and its
        light row dict — the list never needs a full rebuild for a
        single building's change."""
        zd = self._zd()
        if zd is None or not (0 <= index < len(zd.boxes)):
            return
        store = self._store()
        box, det = zd.boxes[index], zd.details[index]
        is_flag = store.flagged.match(
            self._zone, det.get("ring") or []) is not None
        for r in self._rows:
            if r["i"] == index:
                r["name"] = det.get("name") or ""
                r["code"] = int(box[5])
                r["flagged"] = is_flag
                break
        for row in self.store:
            if row[0] == index:
                row[1] = det.get("name") or ""
                row[2] = zonedata.CODE_LABELS.get(int(box[5]), "?")
                row[3] = "FLAGGED" if is_flag else ""
                break

    # -- filter + sort -----------------------------------------------------

    def _on_filter_changed(self, combo):
        """The combo's ONLY job: record the chosen filter, then
        refresh. (See refresh() for why state lives here.)"""
        active = combo.get_active()
        if 0 <= active < len(self._filter_values):
            self._filter_id = self._filter_values[active]
        self.refresh()

    def _on_header_clicked(self, key):
        """Sort by a column; clicking the same column again
        reverses the direction."""
        if self._sort_key == key:
            self._sort_asc = not self._sort_asc
        else:
            self._sort_key = key
            self._sort_asc = True
        for k, col in self._columns.items():
            if k is not None:
                col.set_sort_indicator(k == key)
                if k == key:
                    col.set_sort_order(
                        Gtk.SortType.ASCENDING if self._sort_asc
                        else Gtk.SortType.DESCENDING)
        self.refresh()

    # -- inspector show/hide ------------------------------------------------

    def show_inspector(self, index):
        """Open the 3D inspector on building `index` (right pane).
        The data column stays fully visible and editable."""
        zd = self._zd()
        store = self._store()
        if zd is None or store is None \
                or not (0 <= index < len(zd.boxes)):
            return
        flagged_entry = store.flagged.match(
            self._zone, zd.details[index].get("ring") or [])
        self.inspector.show_building(self, zd, index, flagged_entry)
        self.inspector.set_visible(True)
        self._position_inspector()
        GLib.idle_add(self._position_inspector_idle)

    def _position_inspector(self):
        """Place the split divider: Joshua's dragged position wins;
        before he drags, the inspector gets ~320px."""
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
        self._position_inspector()
        return False

    def hide_inspector(self):
        """Hide the inspector panel. The data column was never
        hidden, so there is nothing to restore."""
        if hasattr(self, "inspector"):
            self.inspector.set_visible(False)

    # -- selection ---------------------------------------------------------

    def _on_zone_changed(self, combo):
        """Switch the working zone: its list comes from its light
        index (downloading the index first if needed)."""
        self._zone = combo.get_active_text() or self._zone
        self.hide_inspector()
        self.app_window.ensure_zone_index(self._zone)
        self.refresh()

    def _on_select(self, selection):
        """
        Fill the edit fields from the selected row, and open the
        3D inspector. When the zone's full records are not loaded
        yet, the fields fill from the light index at once and the
        zone downloads (progress bar); the inspector opens when it
        lands, if the selection is still this building.
        """
        idx = self._selected_index()
        if idx is None:
            self.hide_inspector()
            return
        zd = self._zd()
        if zd is not None and idx < len(zd.boxes):
            box = zd.boxes[idx]
            self._set_spins(box[0], box[1], box[2], box[3], box[4])
            self.show_inspector(idx)
            return
        store = self._store()
        index = store.indexes.get(self._zone) if store else None
        if index is not None and idx < len(index.entries):
            e = index.entries[idx]
            self._set_spins(e["x"], e["z"], e["w"], e["d"], e["h"])
        zone = self._zone

        def done(ok, _idx=idx, _zone=zone):
            if ok and self._zone == _zone \
                    and self._selected_index() == _idx:
                zd2 = self._zd()
                if zd2 is not None and _idx < len(zd2.boxes):
                    box = zd2.boxes[_idx]
                    self._set_spins(box[0], box[1], box[2], box[3],
                                    box[4])
                    self.show_inspector(_idx)
        self.app_window.ensure_zone_detail(zone, done=done)

    # -- applying edits (numbers <-> drags, one path) ------------------------

    def manip_values(self):
        """The inspector's current building as {x, z, w, d, h}
        (the panel's manipulation starting point)."""
        zd = self._zd()
        idx = self.inspector.index
        if zd is None or idx is None or idx >= len(zd.boxes):
            return None
        box = zd.boxes[idx]
        return {"x": box[0], "z": box[1], "w": box[2], "d": box[3],
                "h": box[4]}

    def manip_apply(self, values):
        """Apply {x, z, w, d, h} from a 3D drag: the model changes,
        the number fields follow, the row updates — same values,
        both directions. Returns False when the edit is refused
        (flagged), so the panel ends the drag."""
        return self._apply_values(values, from_drag=True)

    def on_manip_end(self):
        """A drag finished: re-derive the inspector's front and
        backdrop at the building's new spot."""
        if self.inspector.get_visible():
            self.inspector.refresh_view()

    def _apply_values(self, values, from_drag=False):
        zd = self._zd()
        store = self._store()
        idx = self.inspector.index \
            if self.inspector.get_visible() else self._selected_index()
        if store is None or zd is None or idx is None \
                or idx >= len(zd.boxes):
            return False
        try:
            zd.move(idx, values["x"], values["z"],
                    flagged=store.flagged)
            zd.resize(idx, values["w"], values["d"], values["h"],
                      flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            # Restore the fields to the real (unchanged) values.
            box = zd.boxes[idx]
            self._set_spins(box[0], box[1], box[2], box[3], box[4])
            return False
        self.app_window._mark_unpublished()
        self._set_spins(values["x"], values["z"], values["w"],
                        values["d"], values["h"])
        self._update_row(idx)
        if not from_drag and self.inspector.get_visible() \
                and self.inspector.index == idx:
            self.inspector.refresh_view()
        self.app_window._set_status(
            f"Building #{idx} updated (unsaved until save).")
        return True

    def _on_spin_changed(self):
        """Typing a number applies it at once (1.7.2 two-way
        sizing) — unless the fields are being filled by code."""
        if self._spins_loading:
            return
        idx = self._selected_index()
        zd = self._zd()
        if idx is None or zd is None:
            return
        self._apply_values({
            "x": self.mx.get_value(), "z": self.mz.get_value(),
            "w": self.mw.get_value(), "d": self.md.get_value(),
            "h": self.mh.get_value()})

    def _on_move_resize(self, widget):
        """Move + resize the selected building from the fields
        (the same apply path as typing and dragging)."""
        self._on_spin_changed()

    def _on_place(self, widget):
        """Place a building; zonedata attributes it to its zone and
        refuses placements outside all zones. If the current zone's
        records are not loaded yet, load them first, then place."""
        store = self._store()
        if store is None:
            return
        if self._zd() is None and not self._place_retry:
            self._place_retry = True
            zone = self._zone

            def done(ok):
                self._place_retry = False
                if ok:
                    self._on_place(widget)
            self.app_window.ensure_zone_detail(zone, done=done)
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
        if zone != self._zone:
            self._zone = zone
            self.zone_combo.set_active(zonedata.ZONES.index(zone))
        self.refresh()
        self.app_window._set_status(
            f"Placed building #{idx} in {zone} (unsaved until save).")

    def _on_delete(self, widget):
        """Delete the selected building (flagged = refused)."""
        store = self._store()
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
        self.hide_inspector()
        self.refresh()
        self.app_window._set_status(f"Building #{idx} deleted (unsaved).")


# ---------------------------------------------------------------------------
# Gas Station Review tab: the problem stations, listed for Joshua
# ---------------------------------------------------------------------------

class GasStationReviewTab(Gtk.Box):
    """
    Gas Station Review (Joshua 2026-10-17): the problem gas
    stations, listed for HIS decision — the same role the flagged
    buildings play in the Zone Buildings tab.

    The game still uses the skip rule: a station that cannot sit
    clear of the streets is left out. This list is every station
    that under the round-2 rules is left out entirely or has to
    move more than 2 units from its real spot, with the streets
    blocking it and a plain-language note on what is in the way.
    A toggle shows ALL 109 stations with their live in-game status
    (placed / skipped under the game's current gate) — Joshua
    named Marathon, Valero and Chevron: all three read Skipped.

    1.7.2 (Joshua's rules): the list is DOWNLOADED FROM GITHUB on
    open (editors/building-editor/gas-station-review.json) — never
    bundled. And stations can be made EDITABLE here (amendment 1):
    flip a station's "Make editable" switch and it opens in the 3D
    inspector like a building — the game's station cluster as one
    object at its real location, with the manipulation tools, the
    spelled-out fields, and a Walkable flag. Edits live in the
    editor's own station-edits.json in the repo and save by the
    same round-trip rule; the game's station file is never edited.

    The status word in the 3D view (Flagged / Skipped / Placed)
    describes the GAME's treatment of the station today — flipping
    a station editable does not change it.

    EDITOR UI RULE: the list is long, so it lives in a
    Gtk.ScrolledWindow; the list and the details below it share a
    VERTICAL draggable divider; long cell text ellipsizes with the
    full note in the wrapping detail label.
    """

    def __init__(self, window):
        """window: the AssetEditorWindow (store + status access)."""
        super().__init__(orientation=Gtk.Orientation.VERTICAL,
                         spacing=6)
        self.set_border_width(6)
        self.app_window = window
        self.review = None          # zonedata.GasStationReview
        self.edits = None           # zonedata.StationEdits
        self._current = None        # selected station record
        self._show_all = False      # list toggle state
        self._spins_loading = False

        # The left column: heading, intro, toggle, list, details.
        self.data_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                                spacing=6)
        head = Gtk.Label()
        head.set_markup("<b>Gas stations awaiting Joshua's review</b>")
        head.set_halign(Gtk.Align.START)
        head.set_ellipsize(Pango.EllipsizeMode.END)
        head.set_tooltip_text("Gas stations awaiting Joshua's review")
        self.data_box.pack_start(head, False, False, 0)
        intro = Gtk.Label(label=(
            "The game still uses the skip rule: a station that "
            "cannot sit clear of the streets is left out. These "
            "stations either cannot be placed at all, or would have "
            "to move more than 2 units from their real spot. They "
            "are listed here for your decision. Flip “Make "
            "editable” on a station to open it in the 3D view and "
            "adjust it — your edits save to the editor's own "
            "station file; the game does not change until a game "
            "update reads them."))
        intro.set_line_wrap(True)
        intro.set_halign(Gtk.Align.START)
        self.data_box.pack_start(intro, False, False, 0)

        # List source toggle: the 53 problems, or all 109 stations.
        toggle_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                             spacing=6)
        toggle_row.pack_start(Gtk.Label(label="Show:"),
                              False, False, 0)
        self.source_combo = Gtk.ComboBoxText()
        self.source_combo.append_text("Problem stations (53)")
        self.source_combo.append_text("All stations (109)")
        self.source_combo.set_active(0)
        self.source_combo.connect("changed", self._on_source_changed)
        toggle_row.pack_start(self.source_combo, False, False, 0)
        self.data_box.pack_start(toggle_row, False, False, 0)

        # The list: Station | Zone | What happens | Blocking
        # streets | Other blockers, plus hidden columns (detail
        # text, stationIndex).
        self.store = Gtk.ListStore(str, str, str, str, str, str, int)
        self.tree = Gtk.TreeView(model=self.store)
        for i, title in enumerate(("Station", "Zone", "What happens",
                                    "Blocking streets",
                                    "Other blockers")):
            renderer = Gtk.CellRendererText()
            renderer.set_property("ellipsize",
                                  Pango.EllipsizeMode.END)
            col = Gtk.TreeViewColumn(title, renderer, text=i)
            col.set_resizable(True)
            col.set_min_width(90)
            self.tree.append_column(col)
        self.tree.get_selection().connect("changed", self._on_select)
        scroll = Gtk.ScrolledWindow()
        scroll.set_min_content_height(150)
        scroll.add(self.tree)
        self.list_scroll = scroll

        # Details below the list: note, live status, and the
        # editable controls (visible when a station is selected).
        detail_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                             spacing=4)
        self.detail_label = Gtk.Label(label=(
            "The station list is downloading from GitHub…"))
        self.detail_label.set_line_wrap(True)
        self.detail_label.set_halign(Gtk.Align.START)
        detail_box.pack_start(self.detail_label, False, False, 0)

        btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                          spacing=4)
        self.make_btn = Gtk.Button(label="Make editable")
        self.make_btn.connect("clicked", self._on_make_editable)
        btn_row.pack_start(self.make_btn, False, False, 0)
        self.unedit_btn = Gtk.Button(label="Back to review-only")
        self.unedit_btn.connect("clicked", self._on_unedit)
        btn_row.pack_start(self.unedit_btn, False, False, 0)
        self.open3d_btn = Gtk.Button(label="Open in 3D view")
        self.open3d_btn.connect("clicked", self._on_open_3d)
        btn_row.pack_start(self.open3d_btn, False, False, 0)
        self.map_btn = Gtk.Button(
            label="Open blocking street in Map Editor")
        self.map_btn.connect("clicked", self._on_open_blocking_street)
        btn_row.pack_start(self.map_btn, False, False, 0)
        self.walk_check = Gtk.CheckButton(
            label="Walkable — people can walk in")
        self.walk_check.connect("toggled", self._on_walk_toggled)
        btn_row.pack_start(self.walk_check, False, False, 4)
        btn_scroll = Gtk.ScrolledWindow()
        btn_scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                              Gtk.PolicyType.NEVER)
        btn_scroll.set_shadow_type(Gtk.ShadowType.NONE)
        btn_scroll.add(btn_row)
        detail_box.pack_start(btn_scroll, False, False, 0)

        # The station's number fields (spelled out, two-way with
        # the 3D drags — same as the buildings').
        spin_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                           spacing=4)
        self.sx = Gtk.SpinButton.new_with_range(-30000, 30000, 1)
        self.sz = Gtk.SpinButton.new_with_range(-30000, 30000, 1)
        self.sw = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.sd = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.sh = Gtk.SpinButton.new_with_range(1, 200, 1)
        for label, spin in (
                ("East–West position (X)", self.sx),
                ("North–South position (Z)", self.sz),
                ("Width (W)", self.sw),
                ("Depth (D)", self.sd),
                ("Height (H)", self.sh)):
            spin_row.pack_start(Gtk.Label(label=label), False, False, 0)
            spin_row.pack_start(spin, False, False, 0)
            spin.connect("value-changed",
                         lambda s: self._on_spin_changed())
        self.spin_scroll = Gtk.ScrolledWindow()
        self.spin_scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                                    Gtk.PolicyType.NEVER)
        self.spin_scroll.set_shadow_type(Gtk.ShadowType.NONE)
        self.spin_scroll.add(spin_row)
        detail_box.pack_start(self.spin_scroll, False, False, 0)

        # List above, details below, one draggable VERTICAL divider
        # (the Editor UI rule's vertical adjustment).
        self.vpaned = Gtk.Paned(orientation=Gtk.Orientation.VERTICAL)
        self.vpaned.set_wide_handle(True)
        self.vpaned.pack1(scroll, True, True)
        self.vpaned.pack2(detail_box, True, True)
        self.data_box.pack_start(self.vpaned, True, True, 0)

        # The 3D inspector (station mode) on the right.
        self.inspector = ZoneInspectorPanel(self)
        self.inspector.set_visible(False)
        self.paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self.paned.set_wide_handle(True)
        self.paned.pack1(self.data_box, True, True)
        self.paned.pack2(self.inspector, False, True)
        self.pack_start(self.paned, True, True, 0)
        self._split_pos = None
        self._split_guard = False
        self.paned.connect("notify::position", self._on_split_moved)

        self._refresh_controls()

    def _on_split_moved(self, paned, _param):
        if not self._split_guard and self.inspector.get_visible():
            self._split_pos = paned.get_position()

    # -- data in ---------------------------------------------------------

    def set_review(self, review, edits):
        """Adopt the downloaded review list + station-edits overlay
        (called by the window when the open-downloads land)."""
        self.review = review
        self.edits = edits
        if review is None:
            self.detail_label.set_text(
                "The gas station list could not be downloaded — "
                "see the status bar for the reason.")
        self.refresh_list()
        self._refresh_controls()

    def refresh_station_states(self):
        """After a save round trip: the overlay object now holds
        the proof copy — re-read the current station's state."""
        store = self.app_window.zone_store
        if store is not None:
            self.edits = store.station_edits
        self._refresh_controls()
        if self._current is not None:
            self._fill_spins()

    def refresh_list(self):
        """Rebuild the list from the active source (problems or
        all stations)."""
        self.store.clear()
        if self.review is None:
            return
        entries = self.review.all_stations if self._show_all \
            else self.review.stations
        for entry in entries:
            if self._show_all:
                live = entry.get("liveStatus")
                happens = ("Placed in the game" if live == "placed"
                           else "Left out of the game")
                blocking = ""
                other = ""
                detail = (f"In the game today: {happens.lower()}.")
            else:
                if entry.get("outcome") == "skipped":
                    happens = "Left out of the game"
                else:
                    happens = f"Moves {entry.get('moveUnits')} units"
                blocking = ", ".join(
                    entry.get("blockingStreets") or []) or "-"
                other = entry.get("otherBlockers") or "-"
                detail = entry.get("issue") or ""
            pos = entry.get("realPosition") or [0, 0]
            detail += (f"  Real spot: {pos[0]}, {pos[1]} "
                       f"({entry.get('zone')}).")
            if entry.get("address"):
                detail += f"  Address: {entry['address']}"
            live = self.review.live_status(entry.get("stationIndex"))
            if not self._show_all and live:
                detail += ("  In the game today: "
                           + ("placed." if live == "placed"
                              else "left out (skipped)."))
            edit = self.edits.get(entry.get("stationIndex")) \
                if self.edits else {}
            if edit.get("editable"):
                detail += "  EDITABLE in the editor."
            if edit.get("walkable"):
                detail += "  Marked walkable."
            self.store.append([
                entry.get("name") or "Unnamed station",
                entry.get("zone") or "",
                happens,
                blocking,
                other,
                detail,
                int(entry.get("stationIndex") or 0)])

    # -- selection + controls ----------------------------------------------

    def _on_source_changed(self, combo):
        self._show_all = combo.get_active() == 1
        self._current = None
        self.hide_inspector()
        self.refresh_list()
        self._refresh_controls()

    def _selected_station(self):
        """The full record for the selected row, from the active
        source list (matched by stationIndex)."""
        sel = self.tree.get_selection()
        model, it = sel.get_selected()
        if it is None or self.review is None:
            return None
        sid = model.get_value(it, 6)
        source = self.review.all_stations if self._show_all \
            else self.review.stations
        for entry in source:
            if entry.get("stationIndex") == sid:
                return entry
        # A problem-station row opened from the problems list also
        # resolves against all-stations data when needed.
        return self.review.station(sid)

    def _on_select(self, selection):
        """Show the selected station's full note + its controls."""
        model, iter_ = selection.get_selected()
        if iter_ is None:
            self._current = None
            self._refresh_controls()
            return
        self._current = self._selected_station()
        self.detail_label.set_text(model[iter_][5])
        self._fill_spins()
        self._refresh_controls()

    def _edit(self):
        """The current station's edit dict ({} when none)."""
        if self.edits is None or self._current is None:
            return {}
        return self.edits.get(self._current.get("stationIndex"))

    def _refresh_controls(self):
        """Button/field states follow the selection + its edit
        state: nothing works until a station is chosen; the 3D
        view and fields only for editable stations."""
        cur = self._current is not None
        editable = cur and bool(self._edit().get("editable"))
        self.make_btn.set_sensitive(cur and not editable)
        self.unedit_btn.set_sensitive(editable)
        self.open3d_btn.set_sensitive(editable)
        self.walk_check.set_sensitive(editable)
        blocking = (self._current or {}).get("blockingStreets") or []
        self.map_btn.set_sensitive(cur and bool(blocking))
        for spin in (self.sx, self.sz, self.sw, self.sd, self.sh):
            spin.set_sensitive(editable)
        if cur:
            self._spins_loading = True
            try:
                self.walk_check.set_active(
                    bool(self._edit().get("walkable")))
            finally:
                self._spins_loading = False

    def _fill_spins(self):
        """The station's fields: its editor anchor + size (real
        position + overlay offset; game defaults when unset)."""
        if self._current is None:
            return
        edit = self._edit()
        ax, az = zonedata.station_anchor(self._current, edit)
        self._spins_loading = True
        try:
            self.sx.set_value(ax)
            self.sz.set_value(az)
            self.sw.set_value(
                edit.get("w") or zonedata.STATION_DEFAULT_W)
            self.sd.set_value(
                edit.get("d") or zonedata.STATION_DEFAULT_D)
            self.sh.set_value(
                edit.get("h") or zonedata.STATION_DEFAULT_H)
        finally:
            self._spins_loading = False

    # -- editing ------------------------------------------------------------

    def _on_make_editable(self, _widget):
        """Flip the selected station to editable (Joshua's
        per-station choice; the default is review-only)."""
        if self._current is None or self.edits is None:
            return
        sid = self._current.get("stationIndex")
        self.edits.set_edit(sid, editable=True)
        self.app_window._mark_unpublished()
        self._refresh_controls()
        self.refresh_list()
        self.app_window._set_status(
            f"{self._current.get('name') or 'Station'} is now "
            f"editable — open it in the 3D view to adjust it. "
            f"(Unsaved until the next save.)")

    def _on_unedit(self, _widget):
        """Back to review-only (the station's saved edit values are
        kept in the overlay, but it no longer opens for editing)."""
        if self._current is None or self.edits is None:
            return
        self.edits.set_edit(
            self._current.get("stationIndex"), editable=False)
        self.app_window._mark_unpublished()
        self.hide_inspector()
        self._refresh_controls()
        self.refresh_list()
        self.app_window._set_status(
            "Station is review-only again. (Unsaved until save.)")

    def _on_walk_toggled(self, _widget):
        """The Walkable flag — the editor's existing walkable
        machinery, applied to a station."""
        if self._spins_loading or self._current is None \
                or self.edits is None:
            return
        self.edits.set_edit(
            self._current.get("stationIndex"),
            walkable=self.walk_check.get_active())
        self.app_window._mark_unpublished()
        if self.inspector.get_visible():
            self.inspector.refresh_view()
        self.app_window._set_status(
            "Walkable " + ("on" if self.walk_check.get_active()
                           else "off")
            + " for this station. (Unsaved until save.)")

    def _on_open_3d(self, _widget):
        """Open the station in the 3D inspector at its real
        location. Its zone's records download on demand for the
        roads backdrop; without them the station still opens."""
        if self._current is None:
            return
        station = self._current
        zone = station.get("zone")

        def show(zd):
            self.inspector.show_station(
                self, station, self._edit(), zd)
            self.inspector.set_visible(True)
            self._position_inspector()
            GLib.idle_add(self._position_inspector_idle)

        store = self.app_window.zone_store
        if store is not None and zone in store.zones:
            show(store.zones[zone])
        elif zone:
            def done(ok, _station=station):
                store2 = self.app_window.zone_store
                zd = store2.zones.get(_station.get("zone")) \
                    if store2 else None
                if self._current is _station:
                    show(zd)
            self.app_window.ensure_zone_detail(zone, done=done)
        else:
            show(None)

    def _position_inspector(self):
        width = self.paned.get_allocated_width()
        if width <= 0:
            return
        pos = self._split_pos if self._split_pos is not None \
            else width - 340
        pos = max(240, min(pos, width - 200))
        self._split_guard = True
        try:
            self.paned.set_position(pos)
        finally:
            self._split_guard = False

    def _position_inspector_idle(self):
        self._position_inspector()
        return False

    def hide_inspector(self):
        if hasattr(self, "inspector"):
            self.inspector.set_visible(False)

    def _on_open_blocking_street(self, _widget):
        """Amendment 3 from the review side: a named blocking
        street hands its location (the station's real spot + the
        street's name + zone) to the Map Editor."""
        cur = self._current or {}
        streets = cur.get("blockingStreets") or []
        if not streets:
            return
        pos = cur.get("realPosition") or [0, 0]
        self.app_window.open_in_map_editor(
            cur.get("zone"), pos[0], pos[1], streets[0])

    # -- manipulation / fields (the panel's contract) ------------------------

    def manip_values(self):
        """The current station as {x, z, w, d, h} (editor anchor +
        size) — the drags' starting point."""
        if self._current is None:
            return None
        edit = self._edit()
        ax, az = zonedata.station_anchor(self._current, edit)
        return {"x": ax, "z": az,
                "w": edit.get("w") or zonedata.STATION_DEFAULT_W,
                "d": edit.get("d") or zonedata.STATION_DEFAULT_D,
                "h": edit.get("h") or zonedata.STATION_DEFAULT_H}

    def manip_apply(self, values):
        """Apply {x, z, w, d, h} from a drag or the fields: the
        overlay records the offset from the station's real spot
        plus the size; the fields follow. Always succeeds for an
        editable station."""
        if self._current is None or self.edits is None:
            return False
        real = self._current.get("realPosition") or [0, 0]
        self.edits.set_edit(
            self._current.get("stationIndex"),
            dx=round(values["x"] - real[0], 2),
            dz=round(values["z"] - real[1], 2),
            w=values["w"], d=values["d"], h=values["h"])
        self.app_window._mark_unpublished()
        self._spins_loading = True
        try:
            self.sx.set_value(values["x"])
            self.sz.set_value(values["z"])
            self.sw.set_value(values["w"])
            self.sd.set_value(values["d"])
            self.sh.set_value(values["h"])
        finally:
            self._spins_loading = False
        return True

    def on_manip_end(self):
        """Drag finished: refresh the inspector's backdrop at the
        station's new spot."""
        if self.inspector.get_visible():
            self.inspector.station_edit = self._edit()
            self.inspector.refresh_view()

    def _on_spin_changed(self):
        """Typing a station number applies it at once."""
        if self._spins_loading or self._current is None:
            return
        if not self._edit().get("editable"):
            return
        self.manip_apply({
            "x": self.sx.get_value(), "z": self.sz.get_value(),
            "w": self.sw.get_value(), "d": self.sd.get_value(),
            "h": self.sh.get_value()})
        if self.inspector.get_visible():
            self.inspector.station_edit = self._edit()
            self.inspector.refresh_view()


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
        # 1.7.2 load-on-demand: baking writes into whichever zones
        # the lots land in, so it is one of the few actions that
        # legitimately needs the whole map. If no zone's records
        # are loaded yet, load them all first (with progress), then
        # bake — an explicit whole-map load for an explicit
        # whole-map action, never a silent one.
        if len(store.zones) < len(zonedata.ZONES):
            self.app_window._set_status(
                "Loading every zone first — baking a subdivision "
                "needs the whole map…")
            self.app_window.ensure_all_zones(
                done=lambda ok: self._on_generate_houses(widget)
                if ok else None)
            return
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
