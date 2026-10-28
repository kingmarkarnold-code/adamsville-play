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

import copy
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
# 2.0.8: the suite reporting module (canonical suite_core
# reporting.py, vendored beside this file by the self-update
# kit). Silent, automatic reports to the same Player Reports
# inbox as the game's. Soft import like the updater's:
# reporting must never stop the editor opening.
try:
    import reporting  # noqa: E402 -- suite editor reporting
    _REPORTING_AVAILABLE = True
except Exception:
    reporting = None
    _REPORTING_AVAILABLE = False
# 2.0.8: pycairo, for the 3D view's offscreen backdrop cache.
# Soft: without it the view paints its backdrop directly,
# exactly as 2.0.7 did.
try:
    import cairo  # noqa: E402
    _CAIRO_AVAILABLE = True
except Exception:
    cairo = None
    _CAIRO_AVAILABLE = False
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
# v2.0.0: the pick-list vocabularies from the shared stock shelf
# (vocab.py). Soft import like the others: if it fails, the design
# tab shows its "list unavailable" state rather than the editor
# failing to open.
try:
    import vocab as vocab_mod  # noqa: E402
    _VOCAB_AVAILABLE = True
except Exception:
    vocab_mod = None
    _VOCAB_AVAILABLE = False
# v2.0.0: Draw for Mollie (suite_draw.py, the Python suite-core
# drawing citizen). Soft import: a broken draw module costs the
# Draw tab, never the editor.
try:
    import suite_draw  # noqa: E402
    _DRAW_AVAILABLE = True
except Exception:
    suite_draw = None
    _DRAW_AVAILABLE = False
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
APP_VERSION = "2.0.9"

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

def _pick_list(window, const_name, current=None):
    """
    The options for one pick-list control (2.0.0, spec §6): the
    stock-shelf vocabulary the window downloaded (or its download
    cache) when available; otherwise a list holding ONLY the
    building's current value (so what the building holds always
    displays truthfully), or an empty list when there is no current
    value. A baked-in substitute list is NEVER offered: an
    unavailable list is a stated state (the tab shows its
    "list unavailable" note), not a silent fallback.
    """
    voc = getattr(window, "vocabularies", None)
    vals = voc.values(const_name) if voc is not None else None
    if vals:
        opts = list(vals)
        if current is not None and current not in opts:
            opts.append(current)
        return opts
    return [current] if current is not None else []


def _pick_missing(window, const_names):
    """The subset of const_names with no shelf list available —
    drives the design tab's 'list unavailable' note."""
    voc = getattr(window, "vocabularies", None)
    if voc is None:
        return list(const_names)
    return [n for n in const_names if voc.values(n) is None]


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


def paned_opening_share(paned, first_min_share, second_min_px,
                        second_max_share, vertical=True,
                        sized_child="second"):
    """
    Give a Gtk.Paned its DESIGNED OPENING SHARES (2.0.1, the
    startup-layout fix — Joshua's layout law: regions open at
    their designed shares of the viewport, full or empty).

    2.0.0 never positioned the Zone tab's two vertical dividers,
    and real GTK's first-allocation default put them at 20 px /
    5 px: the building list opened collapsed to a sliver and
    the edit/place field rows filled the column from the top
    (Joshua's live report, 2026-10-18). The suite's other splits
    were positioned by one-shot idle callbacks; this helper is
    the robust form of that idea:

    * it acts on the paned's REAL allocations (size > 1), so it
      works for notebook pages that are not visible yet (an idle
      callback at startup would measure a 1-px widget and give
      up);
    * the SIZED child (the second by default; the first when
      sized_child="first", for the hero list above the buildings
      list) gets its natural height, clamped to [second_min_px,
      second_max_share of the paned] — the field rows below a
      list are content-sized regions; the flexible child takes
      the rest, never less than first_min_share of the paned;
    * the share is (re)applied whenever the paned's SIZE
      changes — measured on this app (real GTK 3.24): a divider
      position set while the paned still has its startup size
      does NOT survive the paned growing to its real size (GTK
      hands the growth to the first child), so a one-shot set
      at startup is exactly what does not work. A drag by
      Joshua does not change the paned's size, so his dragged
      position is never overridden — only a window resize
      re-applies the designed share, which is the layout law
      (shares of the viewport) working as intended.
    """
    state = {"size": None, "pos": None}

    def _target(size):
        if sized_child == "first":
            # The FIRST child is the content-sized one (the hero
            # list above the buildings list): it gets its natural
            # size, clamped; the second child takes the rest.
            child1 = paned.get_child1()
            natural = 0
            if child1 is not None:
                try:
                    if vertical:
                        _min, natural = \
                            child1.get_preferred_height()
                    else:
                        _min, natural = \
                            child1.get_preferred_width()
                except Exception:
                    natural = 0
            pos = natural or second_min_px
            pos = max(second_min_px, pos)
            pos = min(pos, int(size * second_max_share))
            pos = min(pos, int(size * (1.0 - first_min_share)))
            return max(0, pos)
        child2 = paned.get_child2()
        natural = 0
        if child2 is not None:
            try:
                if vertical:
                    _min, natural = child2.get_preferred_height()
                else:
                    _min, natural = child2.get_preferred_width()
            except Exception:
                natural = 0
        second = natural or second_min_px
        second = max(second_min_px, second)
        second = min(second, int(size * second_max_share))
        pos = size - second
        pos = max(pos, int(size * first_min_share))
        return max(0, min(pos, size - 24))

    def _on_allocate(_widget, alloc):
        size = alloc.height if vertical else alloc.width
        if size <= 1:
            return
        if size == state["size"]:
            # Same size: either settled (the position is the one
            # this helper set), clamped by GTK, or dragged by
            # Joshua — in every case, leave it alone.
            return
        pos = _target(size)
        state["size"] = size
        state["pos"] = pos
        if pos != paned.get_position():
            # Defer the set past this allocation pass.
            GLib.idle_add(_apply, pos)

    def _apply(pos):
        # Apply only if the paned has not been resized again
        # since this target was computed (a newer allocation
        # will have scheduled its own, fresher target).
        if state["pos"] == pos:
            paned.set_position(pos)
        return False

    paned.connect("size-allocate", _on_allocate)


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
        # 2.0.0: bind the store's lazy transport — detail chunks,
        # roads and materialisation fetch through the same
        # shared-cache door as every other download.
        if self.zone_store is not None:
            self.zone_store.bind_transport(
                self._fetcher.fetch, self._fetcher.fetch_progress,
                self._dl_progress)
        # 2.0.0: the pick-list vocabularies (vocab.py) — loaded
        # from the stock shelf in _load_lists_on_open; the design
        # tab reads them through self.vocabularies.
        self.vocabularies = vocab_mod.Vocabularies(data.DATA_DIR) \
            if _VOCAB_AVAILABLE else None
        self.draw_tab = None
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

        # --- Corner progress bar (2.0.2 — Joshua's progress-bar
        # law, 2026-10-18): the same facility the Map Editor
        # shipped in its 1.9.7, so the suite feels like one
        # program: a small bar at the BOTTOM-RIGHT (the end of the
        # status bar) that is present whenever the app is doing
        # background work of any kind — downloads, building-detail
        # fetches, pushes — so a busy app never reads as frozen.
        # The full-width MB readout above stays as it was; this
        # bar is the always-present indicator. See progress_start.
        self._build_progress_bar()

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

        # --- Draw for Mollie (2.0.0) ---
        # The suite's drawing channel, hosted as its own tab (the
        # desktop adoption contract: same surface citizen, same
        # drawings/ folder, same sidecar shape). Guarded like the
        # gas tab: a broken draw module costs this tab only.
        if _DRAW_AVAILABLE:
            try:
                self.draw_tab = DrawTab(self)
                self.notebook.append_page(
                    self.draw_tab,
                    Gtk.Label(label="Draw for Mollie"))
            except Exception as e:
                import traceback
                traceback.print_exc()
                self._set_status(
                    f"Draw for Mollie tab failed to open: {e}")

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
        # Map Editor building jump (receiving half; companion to
        # Map Editor 1.9.13): clicking a building in the Map
        # Editor writes open-in-building-editor.json and launches
        # this app. Consume it on an idle tick — the window and
        # its tabs exist by then, and the notebook page switch
        # needs the window shown to land.
        GLib.idle_add(self._consume_building_handoff)

        # --- Suite reporting + the self-update door (2.0.8) ----
        # Joshua's editors-reporting rule (2026-10-28): this app
        # reports silently and automatically to the same Player
        # Reports inbox as the game — session start/end, timings
        # on the heavy paths, errors with context. And his
        # editors-self-update rule: opening the app checks
        # GitHub for a newer version in the background (the
        # corner progress bar shows the check), stages it
        # hash-verified, and the bootstrap launcher applies it
        # on the NEXT launch — fail-open throughout: none of
        # this may ever block or break the editor.
        # ORDER MATTERS (the reporting rule): reporting is
        # initialised BEFORE the background update check starts,
        # so if the launch-time check refuses a corrupt
        # download, the "update-refused" report files under
        # THIS app's own session. The check is the updater v3
        # staging path (the Detail Editor 1.2.1 wiring, carried
        # across): silent when current or offline, hash-verified
        # staging, applied by the bootstrap launcher on the next
        # launch. fetch_file is left to the updater's own
        # discovery — it finds this app's vendored github_sync
        # beside updater.py, whose fetch_file matches its
        # (repo, path) -> (bytes, err) contract.
        if reporting is not None:
            try:
                reporting.init(UPDATE_SLUG, APP_VERSION,
                               data_versions={})
                reporting.session_start()
            except Exception:
                pass
        if _UPDATER_AVAILABLE and updater is not None:
            try:
                updater.start_background_check(
                    UPDATE_SLUG, APP_VERSION,
                    on_progress=self._update_progress,
                    on_staged=self._on_update_staged,
                    gui=True)
            except Exception:
                pass

    def _update_progress(self, done, total, label):
        """Feed a self-update download into the corner progress
        bar (the suite's progress-bar law). Runs on the UI
        thread — start_background_check marshals with gui=True.
        Only ever called while a payload is downloading."""
        if done <= 0:
            self.progress_start("self-update",
                                label or "Downloading update…")
        frac = (done / total) if total else None
        self.progress_update("self-update", frac, label)
        if total and done >= total:
            self.progress_finish("self-update")

    def _on_update_staged(self, info):
        """A newer payload was staged in the background: note it
        in the status bar. It runs on the NEXT launch (the
        bootstrap launcher picks it up); the running app is
        unchanged."""
        version = (info or {}).get("version") or "newer"
        self._set_status(
            f"Update downloaded: Building Editor {version} will "
            f"run next time you start the app.")

    # (The 2.0.8 _prewarm_materialize helper is GONE in 2.0.9:
    # it materialised a zone's FULL detail list in the
    # background the moment a building opened, so the first
    # edit would not pay for it. Under the cache + Apply
    # model edits run on the one-record working copy and
    # never materialise the zone at all — the only remaining
    # payer is Apply itself (absorb_record), a deliberate
    # commit click where the wait belongs. Keeping the
    # warm-up would also have kept the whole zone's details
    # resident behind every open building, against the
    # working-set doctrine Joshua restated the same evening.)

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

    # -- corner progress bar (2.0.2 — Joshua's progress-bar law,
    # 2026-10-18): whenever the app is downloading or doing heavy
    # processing in the background, a progress bar shows in the
    # BOTTOM-RIGHT corner (the right end of the status bar), so a
    # busy app never reads as frozen. Real progress where a total
    # is known; a moving indeterminate pulse where it isn't. It
    # appears when work starts and clears when work ends, and it
    # lives inside the status area, so it never covers the editor
    # or any of its controls.
    #
    # Jobs are keyed (several can run at once); the bar shows the
    # most recently started/updated job. All methods are UI-thread
    # only — worker threads hop here with GLib.idle_add, exactly
    # like the download progress callbacks already do. The
    # facility is the Map Editor 1.9.7's, carried across so the
    # suite feels like one program.
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
        self.status.pack_end(self.progress_box, False, False, 4)

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
        # 2.0.2: the same numbers drive the corner bar (the
        # progress-bar law) under the keyed "download" job.
        GLib.idle_add(self._corner_download_progress, frac, label)

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
        # 2.0.2: a load flow ending also ends the corner bar's
        # download job (other keyed jobs, if any, keep it up).
        self.progress_finish("download")
        return False

    def _corner_download_progress(self, frac, label):
        """GTK thread (2.0.2): mirror _dl_progress into the corner
        bar's keyed "download" job — real fraction, file named."""
        if frac >= 1.0:
            self.progress_finish("download")
        elif "download" in self._progress_jobs:
            self.progress_update(
                "download", fraction=frac,
                label=f"Downloading {label}")
        else:
            self.progress_start("download", f"Downloading {label}")
            self.progress_update("download", fraction=frac)
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

            # 2.0.0: the pick-list vocabularies, from the stock
            # shelf through the same shared-cache door. A list that
            # cannot be downloaded (and has no cache copy) is
            # reported ONCE here; the design tab shows its
            # "list unavailable" state for it.
            if self.vocabularies is not None:
                try:
                    self.vocabularies.load(fetcher.fetch)
                    missing = self.vocabularies.unavailable()
                    if missing:
                        notes.append(
                            "These pick-lists are unavailable "
                            "(not downloaded yet): "
                            + ", ".join(sorted(missing)))
                except Exception as e:
                    notes.append(f"Pick-lists failed to load: {e}")

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

    def _collect_garbage(self):
        """Deferred memory hand-back (2.0.1): run a full garbage
        collection and return freed pages to the OS. Scheduled a
        couple of seconds after a zone load lands — the
        collection is real work (~0.2–0.4 s over this app's heap)
        and does not belong inside a click-to-answer path.
        Returns False (one-shot timer)."""
        import gc
        gc.collect()
        try:
            import ctypes
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except Exception:
            pass
        return False

    def ensure_zone_detail(self, zone, done=None):
        """
        Make sure one zone's SPINE is in memory — the
        selection-triggered load of the 2.0.0 snapshot design (the
        method keeps its 1.7.2 name; the tabs call it before
        showing a building). Only the spine downloads here (boxes
        + zone info); the building's own detail chunk and the
        roads arrive with the snapshot itself, through the store's
        bound transport. Shows MB progress for the spine files; on
        success the previously loaded clean zones are unloaded (a
        zone with unsaved edits is NEVER unloaded) and the freed
        memory is returned. done(ok) runs on the GTK thread.
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
            err = store.ensure_spine(
                zone, self._fetcher.fetch,
                self._fetcher.fetch_progress,
                progress=self._dl_progress)

            def finish():
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
                    zd = store.zones.get(zone)
                    self._set_status(
                        f"{zone} loaded from GitHub: "
                        f"{len(zd.boxes) if zd else 0} buildings.")
                    self._note_stale("Zone loaded")
                    # 2.0.1: when the zone that landed is the
                    # one the Zone tab is showing, refresh it
                    # LIGHTLY (refresh_after_zone_load): its
                    # building rows come from the light index,
                    # which a spine load does not change — the
                    # full refresh() walks the whole index
                    # (~53k rows for riverdale, measured ~0.3 s
                    # on the UI thread) and landed in the middle
                    # of the selection that triggered this load.
                    # When a DIFFERENT zone's spine lands (e.g. a
                    # gas station's zone, loaded for its 3D view)
                    # the tab is not refreshed at all: none of
                    # its data changed.
                    if self.zone_tab is not None \
                            and self.zone_tab._zone == zone:
                        self.zone_tab.refresh_after_zone_load()
                for cb in cbs:
                    cb(not err)
                if not err:
                    # 2.0.1: the garbage collection that hands
                    # the dropped zones' memory back is DEFERRED
                    # until a couple of seconds AFTER the waiting
                    # selection has been answered. Measured: a
                    # full gc.collect() over the app heap costs
                    # ~0.2–0.4 s — run inline here it sat inside
                    # the click-to-answer path of the very
                    # selection that triggered this load, and
                    # even an idle callback fired during the
                    # load's download window (the loop is idle
                    # while bytes arrive). The memory still goes
                    # back — shortly after, never inside an
                    # answer.
                    GLib.timeout_add(2000, self._collect_garbage)
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

    # -- Open in Building Editor (the Map Editor's building jump) ------
    # Receiving half of the Map Editor 1.9.13 building click; the
    # sending half is MapEditorApp.on_building_clicked there.

    BUILDING_HANDOFF_NAME = "open-in-building-editor.json"

    def _consume_building_handoff(self):
        """
        Consume a suite "open in Building Editor" handoff, once.

        The Map Editor writes ~/.local/share/adamsville-suite/
        open-in-building-editor.json — {target, zone, index, x,
        z, w, d, h, type, writtenBy, timestamp} — and launches
        this app when Joshua clicks a building there and answers
        "Edit this location?". The semantics mirror this suite's
        street-jump consumption in the Map Editor (1.7.2): a
        FRESH file (< 48 hours old) is applied once — the Zone
        Buildings tab comes forward and focuses the building —
        then the file is DELETED so the jump happens once, not
        on every launch; a file that does not parse is renamed
        .bad so it cannot loop; a stale one is simply removed.

        The building's identity is its INDEX in the zone's
        buildings.json (this editor's zone list is index-aligned
        with that file); the position rides along as the
        fallback identity (see ZoneBuildingsTab.focus_building).

        2.0.5: when the focus lands, the building's OWN tab
        opens in front (open_zone_building_tab) — in 2.0.4 the
        jump stopped at the list selection, and Joshua's
        hands-on verdict was that he was left "under the first
        panel" instead of in the building.
        Returns False always: it is a GLib idle one-shot.
        """
        import json as _json
        from datetime import datetime, timezone
        path = github_sync.SHARED_DIR / self.BUILDING_HANDOFF_NAME
        if not path.exists():
            return False
        try:
            doc = _json.loads(path.read_text())
            zone = str(doc["zone"])
            index = doc.get("index")
            index = int(index) if index is not None else None
            at = None
            if doc.get("x") is not None \
                    and doc.get("z") is not None:
                at = (float(doc["x"]), float(doc["z"]))
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
        if not _ZONEDATA_AVAILABLE or self.zone_tab is None \
                or zone not in zonedata.ZONES:
            return False
        page = self.notebook.page_num(self.zone_tab)
        if page >= 0:
            self.notebook.set_current_page(page)

        def _open_handed(resolved, _zone=zone):
            # 2.0.5: the focus resolved the building (index, or
            # the position fallback's) — open its own tab in
            # front. A building that resolved to nothing opens
            # nothing (focus_building already said so).
            if resolved is not None:
                self.open_zone_building_tab(_zone, resolved)

        self.zone_tab.focus_building(zone, index, at,
                                     done=_open_handed)
        return False

    def open_zone_building_tab(self, zone, index):
        """
        Open one zone building in its OWN notebook tab and bring
        it forward (2.0.5) — the landing the Map Editor building
        jump always promised. If that building's tab is already
        open, switch to it; never a duplicate.

        The tab management mirrors open_building_tab exactly
        (the design buildings' manual open): dedupe by scanning
        open_tabs, a build failure surfaces in the status bar
        instead of dying silently, and the order is append ->
        show_all -> set_current_page so the tab actually comes
        to the front on GTK 3.24.
        """
        for tab in self.open_tabs:
            if isinstance(tab, ZoneBuildingTab) \
                    and tab.zone == zone and tab.index == index:
                self.notebook.set_current_page(
                    self.notebook.page_num(tab))
                return
        try:
            tab = ZoneBuildingTab(self, zone, index)
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._set_status(
                f"Could not open building #{index}: {e}")
            return
        self.open_tabs.append(tab)

        # Tab label with close button (same shape as the design
        # tabs): the building's name from the zone's light index
        # when it has one, else its number.
        name = None
        store = self.zone_store
        if store is not None:
            idx_obj = store.indexes.get(zone)
            if idx_obj is not None \
                    and 0 <= index < len(idx_obj.entries):
                name = idx_obj.entries[index].get("n") or None
        label_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                            spacing=4)
        label = Gtk.Label(label=name or f"Building #{index}")
        close_btn = Gtk.Button(label="×")
        close_btn.set_relief(Gtk.ReliefStyle.NONE)
        close_btn.set_focus_on_click(False)
        close_btn.connect("clicked",
                          lambda w, t=tab: self.close_tab(t))
        label_box.pack_start(label, True, True, 0)
        label_box.pack_start(close_btn, False, False, 0)
        label_box.show_all()

        page_num = self.notebook.append_page(tab, label_box)
        self.notebook.show_all()
        self.notebook.set_current_page(page_num)
        # Load + show the building (async — the tab fills in when
        # its snapshot lands; begin() keeps the panel hidden
        # until then).
        tab.begin()
        self._set_status(
            f"Opened building #{index} ({zone}) in its own tab.")

    # -- Open in Map Editor (1.7.2, Joshua 2026-10-17) -------------------

    def open_in_map_editor(self, zone, x, z, street_name,
                           building=None):
        """
        Hand a location to the Map Editor: write the suite handoff
        file (~/.local/share/adamsville-suite/open-in-map-editor.
        json — {zone, x, z, street, writtenBy, timestamp}) and, if
        the Map Editor is installed, launch it. The Map Editor
        learns to read the file in its 1.9.5 update (the reader is
        built into its source now); until then the honest status
        says the location is saved and the jump lands with that
        update.

        2.0.2 (Joshua, 2026-10-18): when a building is in hand at
        jump time, the caller passes `building` — {name, zone,
        footprint, at} — and it rides along in the payload, so the
        Map Editor (1.9.8+) can draw the building where it belongs
        and select the street it fronts. Joshua's live find: he
        clicked a road in this editor's 3D view, landed in the Map
        Editor zoomed to the road, and had no idea where his
        building was supposed to go — the building simply was not
        in the handoff. With no building in hand, `building` stays
        None and the payload is exactly what it has always been.
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
        if building is not None:
            payload["building"] = building
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

    # -- Detail Edit door (2.0.6; honest form 2.0.8) -----------------

    def open_in_detail_editor(self, zone, index):
        """
        The building "Detail Edit" door — 2.0.8 INTERIM HONESTY.

        2.0.6 built this door to mirror the Map Editor's road
        Detail Edit: write open-in-detail-editor.json, then
        launch the Detail Editor. What 2.0.6's notes already
        admitted is now proven: the Detail Editor (through
        1.2.1) has NO building receiver — its read_handoff()
        deletes any non-road payload unread. So the old flow
        sent buildings into the void while the status bar said
        "handed building #N to the Detail Editor" — a button
        that appeared to work and did nothing.

        Until a building receiver exists over there (Joshua's
        separate decision, pending), this door writes NOTHING
        and launches NOTHING. It says so plainly, in a dialog
        and in the status bar: the Detail Editor works on
        roads; buildings aren't supported there yet; nothing
        was sent. The button stays — labelled honestly — so
        the door is here the day the receiver lands.
        """
        dialog = Gtk.MessageDialog(
            transient_for=self, flags=0,
            message_type=Gtk.MessageType.INFO,
            buttons=Gtk.ButtonsType.OK,
            text="Detail Edit can't take buildings yet.")
        dialog.format_secondary_text(
            "The Detail Editor works on roads. Buildings aren't "
            "supported there yet, so nothing was sent — the "
            "building stays right here, and you can keep "
            "editing it in this app.")
        dialog.run()
        dialog.destroy()
        self._set_status(
            "Detail Edit: the Detail Editor works on roads — "
            "buildings aren't supported there yet, so nothing "
            "was sent.")

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
        # Issue B fix (prepared in the held 1.7.3 tree, SHIPPED in
        # 2.0.0): the zone leg's "Nothing to save — no changes."
        # describes the ZONE files only. When a later leg (design
        # set / stations) DID save, leading the status with that
        # line told Joshua his design edit had not saved — when it
        # had: his Suburban House wall colour reached GitHub in
        # commit 65bbf45971 (2026-10-17 18:24 EDT) from the very
        # push whose status opened with "Nothing to save". Scope
        # the line whenever it is not the whole story.
        if len(msgs) > 1 and msgs[0] == "Nothing to save — no changes.":
            msgs[0] = "Zones: no changes."
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
        # 2.0.2 (progress-bar law): the whole round trip — push,
        # close, proof download — is background work; the corner
        # bar pulses under the keyed "push" job until it lands.
        # (The proof-download leg also reports real fractions
        # through _dl_progress's "download" job while it runs.)
        self.progress_start("push", "Saving to GitHub…")

        def worker():
            result = self._round_trip_work()

            def done():
                self._round_trip_apply(*result)
                self.progress_finish("push")
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
        """Close one tab and drop it from the open list.
        2.0.9: a tab holding a building's working copy with
        unapplied changes asks first (Apply / Discard / Stay)
        — Stay keeps the tab open."""
        resolver = getattr(tab, "resolve_work_dirty", None)
        if resolver is not None and not resolver():
            return
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
        # 2.0.9: unapplied working-copy changes resolve FIRST
        # (Apply / Discard / Stay per building) — a Stay keeps
        # the app open, and an Apply lands in the zone data in
        # time for the unpublished-changes round trip below to
        # carry it. The Zone tab's inspector and every open
        # building tab are asked in turn.
        work_tabs = []
        if self.zone_tab is not None:
            work_tabs.append(self.zone_tab)
        work_tabs.extend(
            t for t in self.open_tabs
            if isinstance(t, ZoneBuildingTab))
        for tab in work_tabs:
            resolver = getattr(tab, "resolve_work_dirty", None)
            if resolver is not None and not resolver():
                return True  # Stay — don't close
        # 2.0.8: close the reporting session (editors-reporting
        # rule). First, so the session summary goes out even
        # when the unpublished-changes dialog follows; the
        # module's flush is bounded and fail-silent.
        if reporting is not None:
            try:
                reporting.session_end()
            except Exception:
                pass
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
        (The gesture assignments in this bullet were replaced
        by Joshua's manipulation model in 2.0.7 — see the 2.0.7
        entry below.)
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
    no timer exists), elevation clamped.

    2.0.2 (Joshua, 2026-10-18) — UNIVERSAL VIEWPORT CONTROLS, the
    one scheme he set for every viewport in the suite, replacing
    1.7.0's drag-to-orbit here: click-and-hold DRAG = PAN the view;
    mouse WHEEL = zoom in/out; the + and − keys = the same zoom;
    CONTROL+drag = ROTATE (the old orbit motion, now on the
    modifier). The manipulation grabs are NOT view controls and
    are unchanged: a plain press on the building still grabs it
    (the current assignments are the 2.0.7 entry below), and a
    plain click (press + release, no drag) still picks a street.

    2.0.6 (Joshua, 2026-10-25) introduced PART SELECTION (a
    plain click selects the part clicked and names it in the
    readouts), the click-vs-drag threshold (a press that stays
    put never nudges the building), and BUILDING ROTATION with
    its live degrees readout, the Rotation field, and the
    baked footprint-ring storage. Its gesture assignments
    (roof = move, Ctrl anywhere on the building = rotate) were
    replaced the next day by the model below.

    2.0.7 (Joshua, 2026-10-26) — THE MANIPULATION MODEL, in his
    words: the editor exists because a building sits in the
    WRONG LOCATION — blocking streets, sometimes not even
    showing because streets are in the way — and you fix its
    placement by hand, on the building itself:
      * ROOF: drag up/down changes the HEIGHT. Nothing else
        moves.
      * FRONT FACE (the orange wall): drag changes the DEPTH —
        the front wall moves, the back wall stays put.
      * LEFT / RIGHT FACE: drag changes the WIDTH — that wall
        moves, the opposite wall stays put.
      * A CORNER (where two walls meet, low on the building):
        press-and-hold and drag MOVES the building around the
        ground plane. X/Z only — the base stays seated.
      * The same CORNER with SHIFT held ("use shift for
        control" — Joshua): drag ROTATES the building around
        its own centre, following the mouse, with the live
        degrees readout; the turn bakes into the footprint
        ring exactly as 2.0.6 stored it (ZoneData.rotate +
        bounding box, manifest-safe save).
      * The same CORNER with CONTROL held: drag scales the
        WHOLE building — footprint and height together by one
        factor, anchored on the OPPOSITE corner, which does
        not move (ZoneData.scale, its own isolated path; the
        live readout shows the factor and the new W/D/H).
      * A modifier drag starting anywhere else rotates the
        VIEW (the universal controls), exactly as always.
    Width is left-to-right across the front; depth is
    front-to-back. Every drag engages only past the click
    threshold, so a press that stays put is the click that
    selects the part — ROOF, FRONT FACE, SIDE FACE or CORNER,
    each named in the readout with what its drag does.

    SHAPE-PRESERVATION LAW (2.0.7, Joshua, same day): a resize
    never rebuilds the footprint as a rectangle — the 2.0.6
    rebuild straightened the jutting walls of church/school
    footprints, destroying them. Every size path (typed
    fields, face drags, the whole-size scale) SCALES the
    existing ring's points; the shape sequence survives,
    proportionally scaled. See ZoneData.resize / .scale.
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

    # 2.0.8 (Joshua, Oct 28): the viewpoint shows the SURROUNDING
    # ENVIRONMENT in the GAME's colours — the Detail Editor
    # 1.2.0 context treatment carried into this 3D view. The
    # tones below are that build's palette, sampled from the
    # game: grass green, asphalt, and six muted building tones
    # (a neighbour's tone is picked from its index, so the same
    # building wears the same colour every frame). Zone data
    # carries no tree layer, so trees cannot be drawn — the
    # same honest limit Detail 1.2.0 stated.
    GRASS_RGB = (0.365, 0.561, 0.290)    # game grass 0x5d8f4a
    PLOT_RGB = (0.450, 0.620, 0.360)     # lighter worn plot
    ASPHALT_RGB = (0.227, 0.227, 0.243)  # game road 0x3a3a3e
    NEIGHBOUR_TONES = (
        (0.62, 0.52, 0.44), (0.55, 0.58, 0.62), (0.66, 0.60, 0.48),
        (0.52, 0.60, 0.52), (0.64, 0.56, 0.56), (0.50, 0.55, 0.66))
    # How far out (world units from the subject's centre) the
    # framed context reaches: the snapshot radius (120) plus a
    # margin, so the building is seen IN its neighbourhood —
    # never alone in a void — while the framing stays stable
    # when the building itself is resized (the context, not the
    # subject, sets the extent).
    CONTEXT_FIT_MARGIN = 150.0

    # Building rotation speed — degrees of building turn per
    # horizontal pixel of a modifier drag on a corner (2.0.6;
    # the corner grip is 2.0.7). Half a degree per pixel turns
    # a full half-circle (orientation is mod 180) in 360 px of
    # drag: deliberate, not twitchy.
    ROTATE_DEG_PER_PX = 0.5

    # 2.0.7: how close (screen px) a press must land to a
    # building corner to grab the CORNER — on the corner's
    # ground point itself, or along the lower half of its
    # vertical edge. Corners are the move/rotate handle, so
    # the target is generous on purpose.
    CORNER_GRAB_PX = 18
    CORNER_EDGE_PX = 13
    # 2.0.8 (picking fix, second pass): a press this close to
    # a corner's ground or roof POINT takes the corner even
    # when it also lands inside a wall — the corner dots are
    # what a corner grab aims at. A press farther inside a
    # wall belongs to the wall, however near a vertex's
    # vertical edge it sits (on a dense articulated ring,
    # every wall midpoint is near some vertex edge).
    CORNER_POINT_PX = 6

    # The box's corners as (right sign, front sign), in the
    # order _classify_grab numbers them: back-left, back-right,
    # front-right, front-left.
    _CORNERS = ((-1, -1), (1, -1), (1, 1), (-1, 1))

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
        # 2.0.9 (Joshua's cache + Apply model): the WORKING
        # COPY — a detached one-record ZoneData the panel's
        # subject lives in while it is open. box/detail point
        # at the working records, so the picture, the picking
        # and every readout follow the copy; the zone's own
        # records are untouched until the tab's Apply absorbs
        # the copy back. _work_base holds the as-opened (or
        # last-applied) record pair the dirty check compares
        # against.
        self.work = None
        self._work_base = None
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
        self.neighbours = []        # snapshot context (2.0.0)
        self._view = None           # last draw's transform (inverse)
        self._drag = None
        self._cur_values = None     # {x, z, w, d, h} being viewed
        self.selected_street = None  # {"name", "x", "z", "zone"}
        # The part of the building a plain click selected —
        # None | "roof" | "front" | ("side", side) |
        # ("corner", index) (2.0.6; the part set is 2.0.7's).
        # Set on click, named by the readout line, highlighted
        # in the picture; cleared by a click on empty ground or
        # a new subject.
        self.selected_part = None
        # 2.0.8: the ring edge the current wall selection was
        # picked from, so the highlight traces the wall he
        # actually clicked (articulated rings have many edges
        # per face), and the edge the last press grabbed.
        self._sel_edge = None
        self._grab_edge = None
        # 2.0.8 backdrop cache: the roads + neighbours layer,
        # rendered once per (camera, size, backdrop generation)
        # to an offscreen cairo surface and blitted per frame —
        # a manipulation frame then paints the cache + the
        # subject instead of re-walking every road segment and
        # neighbour ring (the draw half of the speed pass).
        # None whenever cairo is unavailable (the stub harness)
        # — the draw then paints the same layer directly.
        self._backdrop_surface = None
        self._backdrop_key = None
        self._backdrop_gen = 0
        self.status_word = None
        self.status_color = None
        # 2.0.2 universal viewport controls: the view's zoom factor
        # over the fitted framing, and its pan offset in screen
        # pixels. Both reset whenever a subject is (re)framed —
        # see _reset_camera_to_front.
        self._zoom = 1.0
        self._pan = [0.0, 0.0]

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
        self.drawing.set_size_request(160, 280)
        self.drawing.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.BUTTON_RELEASE_MASK
            | Gdk.EventMask.POINTER_MOTION_MASK
            | Gdk.EventMask.SCROLL_MASK)
        self.drawing.connect("button-press-event", self._on_drag_press)
        self.drawing.connect("button-release-event",
                             self._on_drag_release)
        self.drawing.connect("motion-notify-event", self._on_drag_motion)
        self.drawing.connect("draw", self._on_draw_3d)
        # 2.0.2 universal viewport controls: wheel zoom, and the
        # + / − keys zoom too — keys need keyboard focus, which a
        # press takes (see _on_drag_press's grab_focus).
        self.drawing.set_can_focus(True)
        self.drawing.connect("scroll-event", self._on_scroll)
        self.drawing.connect("key-press-event", self._on_key_press)
        self.status_label = Gtk.Label()
        self.status_label.set_halign(Gtk.Align.START)
        self.status_label.set_valign(Gtk.Align.END)
        self.status_label.set_margin_start(6)
        self.status_label.set_margin_bottom(6)
        self.status_label.set_no_show_all(True)
        self.status_label.hide()
        # 2.0.6: the live rotation readout, overlaid top-left of
        # the view and visible only while a corner modifier drag
        # is turning the building itself. 2.0.7: the same overlay
        # label carries the whole-size scale readout while a
        # Ctrl+corner drag scales the building.
        self.rotate_label = Gtk.Label()
        self.rotate_label.set_halign(Gtk.Align.START)
        self.rotate_label.set_valign(Gtk.Align.START)
        self.rotate_label.set_margin_start(6)
        self.rotate_label.set_margin_top(6)
        self.rotate_label.set_no_show_all(True)
        self.rotate_label.hide()
        # 2.0.8: the sizing-state banner, overlaid top-centre —
        # while a part is selected FOR SIZING, pan and rotate
        # are paused and every drag sizes the building (Joshua's
        # rule from the Oct 28 session); the banner says so, in
        # the view, the whole time the state lasts.
        self.sizing_label = Gtk.Label()
        self.sizing_label.set_halign(Gtk.Align.CENTER)
        self.sizing_label.set_valign(Gtk.Align.START)
        self.sizing_label.set_margin_top(6)
        self.sizing_label.set_no_show_all(True)
        self.sizing_label.hide()
        overlay = Gtk.Overlay()
        overlay.add(self.drawing)
        overlay.add_overlay(self.status_label)
        overlay.add_overlay(self.rotate_label)
        overlay.add_overlay(self.sizing_label)
        self.view_overlay = overlay
        self.pack_start(overlay, True, True, 0)

        # -- below the viewport ------------------------------------
        # 2.0.8 (EDITOR UI RULE; Joshua's Oct 28 finding): the
        # controls row, the street row and the readouts live in
        # ONE scrolling well under the viewport. The old layout
        # packed them as fixed rows under a readouts scroller
        # with a 70px floor of its own, so at laptop window
        # heights the rows below the fold simply sat unreachable.
        # Now the whole region scrolls: the well shrinks to
        # whatever height the pane gets and every row stays
        # reachable by scrolling.
        below = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                        spacing=4)
        self._below_box = below

        # -- controls -------------------------------------------------
        controls = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                           spacing=4)
        hint = Gtk.Label(
            label="Drag to pan the view; Ctrl+drag rotates it; "
                  "wheel or +/− zooms. On the building: drag the "
                  "roof for height, the front wall for depth, a "
                  "side wall for width, a corner to move it; "
                  "Shift+corner turns it, Ctrl+corner scales it "
                  "whole. Click a street to select it.")
        hint.set_halign(Gtk.Align.START)
        hint.set_ellipsize(Pango.EllipsizeMode.END)
        hint.set_tooltip_text(
            "Universal viewport controls: drag pans the view, "
            "Ctrl+drag or Shift+drag rotates it, the mouse wheel "
            "or the + and − keys zoom. On the building itself "
            "(Joshua's 2.0.7 model): drag the ROOF up or down "
            "for HEIGHT; drag the FRONT WALL for DEPTH — the "
            "front wall moves, the back wall stays; drag a LEFT "
            "or RIGHT WALL for WIDTH — that wall moves, the "
            "other stays; drag a CORNER to MOVE the building on "
            "the ground; Shift+drag a corner to ROTATE the "
            "building; Ctrl+drag a corner to scale the WHOLE "
            "building (footprint and height together, anchored "
            "on the opposite corner). Resizing scales the "
            "footprint's own shape — jutting walls are never "
            "straightened. A modifier drag starting OFF a "
            "corner rotates the view. Click the roof, a wall or "
            "a corner to select that part; click a street to "
            "select it.")
        controls.pack_start(hint, True, True, 0)
        face_btn = Gtk.Button(label="Face front")
        face_btn.set_tooltip_text(
            "Return to the front view: eye level, straight at the "
            "front wall")
        face_btn.connect("clicked", self._on_face_front)
        controls.pack_start(face_btn, False, False, 0)
        below.pack_start(controls, False, False, 0)

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
        below.pack_start(street_row, False, False, 0)

        # -- readouts (scrollable: long content scrolls, UI rule) -----
        readout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                          spacing=2)
        self.name_label = Gtk.Label(label="")
        self.type_label = Gtk.Label(label="")
        self.size_label = Gtk.Label(label="")
        self.pos_label = Gtk.Label(label="")
        # 2.0.6: the part-selection line — names what a click
        # selected (roof / front face / edge) and what drags do.
        self.sel_label = Gtk.Label(label="")
        self.front_line = Gtk.Label(label="")
        self.flagged_line = Gtk.Label(label="")
        for lbl in (self.name_label, self.type_label, self.size_label,
                    self.pos_label, self.sel_label, self.front_line,
                    self.flagged_line):
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
        below.pack_start(readout, False, False, 0)
        below_scroll = Gtk.ScrolledWindow()
        below_scroll.set_policy(Gtk.PolicyType.NEVER,
                                Gtk.PolicyType.AUTOMATIC)
        below_scroll.add(below)
        # readout_scroll keeps its name for the region as a
        # whole (older code and the gates know it by this).
        self.readout_scroll = below_scroll
        self.pack_start(below_scroll, False, True, 0)

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

    # -- part selection + rotation readout (2.0.6) -------------------

    def _set_selected_part(self, part, edge=None):
        """Record the part a plain click selected (roof / front
        face / back face / side face / corner) and announce it
        in the readout line. `edge` (2.0.8) is the ring edge the
        click picked the wall from, when it came off the drawn
        footprint — the highlight traces that exact wall."""
        self.selected_part = part
        self._sel_edge = edge
        self._update_sel_label()
        self._update_sizing_banner()
        self.drawing.queue_draw()

    def _part_name(self, part):
        """The plain name of a selectable part (readouts, the
        sizing banner)."""
        if part == "roof":
            return "the ROOF"
        if part == "front":
            return "the FRONT FACE"
        if part == ("back",):
            return "the BACK FACE"
        if isinstance(part, tuple) and part[0] == "side":
            return "the RIGHT FACE" if part[1] > 0 \
                else "the LEFT FACE"
        if isinstance(part, tuple) and part[0] == "corner":
            return "a CORNER"
        return "the building"

    def _sizing_grab(self):
        """The manipulation grab the current part selection
        sizes with — (kind, side) — or None when no sizing
        selection is active (2.0.8, Joshua's sizing-lock rule:
        while a part is selected FOR SIZING, pan and rotate are
        disabled and every drag sizes the building; ending the
        selection restores navigation)."""
        part = self.selected_part
        if self.mode != "building" or part is None:
            return None
        if part == "roof":
            return ("height", 0)
        if part == "front":
            return ("depth", 1)
        if part == ("back",):
            return ("depth", -1)
        if isinstance(part, tuple) and part[0] == "side":
            return ("width", part[1])
        if isinstance(part, tuple) and part[0] == "corner":
            return ("corner", part[1])
        return None

    def _update_sizing_banner(self):
        """Show/hide the in-view sizing banner so the active
        sizing state is visible the whole time it lasts."""
        grab = self._sizing_grab()
        if grab is None:
            self.sizing_label.hide()
            return
        what = {"height": "its height", "depth": "its depth",
                "width": "its width",
                "corner": "its position"}[grab[0]]
        text = (f"Sizing: {self._part_name(self.selected_part)} "
                f"selected — every drag changes {what}. "
                f"Pan and rotate are paused; click empty ground "
                f"or press Esc to finish.")
        self.sizing_label.set_text(text)
        self.sizing_label.set_markup(
            f"<span font_weight=\"bold\" size=\"large\" "
            f"foreground=\"#ffffff\" background=\"#7a3b00\">"
            f" {text} </span>")
        self.sizing_label.show()

    def _update_sel_label(self):
        part = self.selected_part
        if self.mode != "building" or part is None:
            self.sel_label.set_text("")
            self.sel_label.set_tooltip_text("")
            return
        # 2.0.8: every selection is a SIZING selection — the
        # line names the part, what a drag does to it, and that
        # navigation is paused until the selection ends.
        tail = (" Pan and rotate are paused while it's "
                "selected — click empty ground or press Esc "
                "to finish sizing.")
        if part == "roof":
            text = ("Selected: the ROOF — drag up/down to "
                    "change the height." + tail)
        elif part == "front":
            text = ("Selected: the FRONT FACE — drag to change "
                    "the depth; this wall moves, the back wall "
                    "stays put." + tail)
        elif part == ("back",):
            text = ("Selected: the BACK FACE — drag to change "
                    "the depth; this wall moves, the front wall "
                    "stays put." + tail)
        elif part[0] == "side":
            which = "RIGHT" if part[1] > 0 else "LEFT"
            text = (f"Selected: the {which} FACE — drag to "
                    f"change the width; this wall moves, the "
                    f"other wall stays put." + tail)
        else:  # ("corner", index)
            text = ("Selected: a CORNER — drag to move the "
                    "building; Shift+drag on the corner to "
                    "rotate it; Ctrl+drag on the corner to "
                    "scale the whole building." + tail)
        self.sel_label.set_text(text)
        self.sel_label.set_tooltip_text(text)

    def _show_rotate_readout(self, angle_deg):
        """The live degrees readout overlaid on the view while a
        corner modifier drag is turning the building. Hidden on
        release — the tab's Rotation field keeps the final
        angle."""
        # Plain text first, markup second: real GTK shows the
        # markup; the harness's stub label keeps the plain text.
        self.rotate_label.set_text(f"Rotation: {angle_deg:.0f}°")
        self.rotate_label.set_markup(
            f"<span font_weight=\"bold\" size=\"large\" "
            f"foreground=\"#ffffff\" background=\"#333333\">"
            f" Rotation: {angle_deg:.0f}° </span>")
        self.rotate_label.show()

    def _show_scale_readout(self, factor, vals):
        """The live whole-size readout overlaid on the view
        while a Ctrl+corner drag scales the building (2.0.7):
        the factor plus the resulting width/depth/height.
        Same overlay label as the rotation readout; hidden on
        release by _hide_rotate_readout — the tab's fields keep
        the final size."""
        text = (f"Whole size: ×{factor:.2f} — "
                f"W {vals['w']:.1f} × D {vals['d']:.1f} — "
                f"H {vals['h']:.1f}")
        self.rotate_label.set_text(text)
        self.rotate_label.set_markup(
            f"<span font_weight=\"bold\" size=\"large\" "
            f"foreground=\"#ffffff\" background=\"#333333\">"
            f" {text} </span>")
        self.rotate_label.show()

    def _hide_rotate_readout(self):
        self.rotate_label.hide()
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

    def show_building(self, tab, zd, index, flagged_entry,
                      neighbours=None, front_info=None,
                      roads_near=None):
        """Point the panel at zone building `index` of ZoneData
        `zd`. The front is derived from the roads near the building
        (parsed transiently, then dropped); the camera opens at eye
        level in front of the front wall, framed close.

        2.0.0: `neighbours` is the snapshot's read-only context
        (the buildings around the subject, from
        GameStore.open_snapshot) — drawn muted around the subject,
        never edited through this view.

        2.0.1: `front_info` / `roads_near` are the PREPARED front
        + backdrop (GameStore.prepare_snapshot, gathered on a
        worker thread) — the normal path passes both and this
        method then does NO downloads and NO parsing on the UI
        thread. When they are not passed (direct callers), the
        front is derived here from the zone's CACHED roads view
        (ZoneData.roads_view) instead of 2.0.0's per-selection
        transient parse."""
        self.mode = "building"
        self.tab = tab
        self.zd = zd
        self.zone = zd.zone if zd else None
        self.index = index
        # 2.0.9: the subject is copied into the WORKING COPY
        # and the panel lives on the copy from here — box and
        # detail are the working records, so the picture, the
        # picking and the readouts all follow the copy while
        # the zone's own records stay exactly as loaded until
        # Apply. A copy that cannot be made (unreadable detail
        # record) leaves work None: the building still shows
        # (from the live records, read-only in effect — every
        # edit funnel checks for the copy and refuses).
        try:
            self.work = zd.working_copy(index)
            self._work_base = (list(self.work.boxes[0]),
                               copy.deepcopy(self.work.details[0]))
            self.box = self.work.boxes[0]
            self.detail = self.work.details[0]
        except Exception:
            self.work = None
            self._work_base = None
            self.box = zd.boxes[index]
            self.detail = zd.details[index]
        self.neighbours = neighbours or []
        self.flagged_entry = flagged_entry
        self.station = None
        self.station_edit = None
        self.selected_street = None
        self.selected_part = None
        self._sel_edge = None
        self._update_sizing_banner()
        self._hide_rotate_readout()
        self.map_btn.hide()
        self.street_label.set_text("")
        # The front + backdrop: prepared on the worker thread by
        # the normal path (see the docstring). The fallback derives
        # them from the zone's cached roads view — one parse per
        # zone, reused, never one parse per selection.
        if front_info is None:
            roads, seg_index = zd.roads_view()
            # `roads or {}`: an empty dict keeps building_front
            # from falling back to a transient parse — the view
            # already tried (and failed) to get the roads.
            front_info = zonedata.building_front(
                zd, index, flagged_entry, roads=roads or {},
                seg_index=seg_index)
            ring = front_info.get("ring") \
                or self.detail.get("ring") or []
            roads_near = zd.nearby_segments(
                ring, margin=60.0, roads=roads or {})
        self.front_info = front_info
        self._roads_near = roads_near or []
        self._backdrop_gen += 1
        self._reset_camera_to_front()
        self._cur_values = {
            "x": self.box[0], "z": self.box[1], "w": self.box[2],
            "d": self.box[3], "h": self.box[4]}
        self.badge_label.set_visible(bool(flagged_entry))
        self.set_status(self._game_status())
        self._update_readouts()
        self.drawing.queue_draw()

    # -- the working copy (2.0.9, Joshua's cache + Apply) ----

    def work_is_dirty(self):
        """True when the working copy differs from the record
        pair it was opened (or last applied) with — compared
        exactly, so an edit that lands back where it started
        is no longer dirty."""
        if self.work is None or self._work_base is None:
            return False
        return (self.work.boxes[0] != self._work_base[0]
                or self.work.details[0] != self._work_base[1])

    def note_work_edit(self):
        """An edit funnel landed a change on the working copy:
        the hosting tab refreshes its Apply affordances."""
        tab = self.tab
        if tab is not None and hasattr(tab, "_refresh_apply_ui"):
            tab._refresh_apply_ui()

    def absorb_work(self):
        """Commit the working copy into the zone's records —
        the tab then runs the save round trip that sends it
        back and proves it. The base moves to the absorbed
        state: the copy is clean from here; the ZONE is dirty
        until the save lands."""
        if self.work is None or self.zd is None \
                or self.index is None:
            raise zonedata.ZoneDataError(
                "There is no working copy to apply.")
        self.zd.absorb_record(self.index, self.work.boxes[0],
                              self.work.details[0])
        self._work_base = (list(self.work.boxes[0]),
                           copy.deepcopy(self.work.details[0]))

    def discard_work(self):
        """Throw the working copy away and re-copy the zone's
        records as they stand — the building is shown exactly
        as saved, and the fields follow (the tab refills them).
        Returns False when there is nothing to discard into."""
        if self.zd is None or self.index is None \
                or self.index >= len(self.zd.boxes):
            return False
        try:
            self.work = self.zd.working_copy(self.index)
        except Exception:
            return False
        self._work_base = (list(self.work.boxes[0]),
                           copy.deepcopy(self.work.details[0]))
        self.box = self.work.boxes[0]
        self.detail = self.work.details[0]
        self.selected_part = None
        self._sel_edge = None
        self._update_sizing_banner()
        self.refresh_view()
        return True

    def clear_work(self):
        """Drop the working copy without a word (the building
        it belonged to is gone — a delete already resolved
        any unapplied changes with Joshua first)."""
        self.work = None
        self._work_base = None

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
        self.work = None
        self._work_base = None
        self.flagged_entry = None
        self.selected_street = None
        self.selected_part = None
        self._sel_edge = None
        self._update_sizing_banner()
        self._hide_rotate_readout()
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
            # 2.0.1: the zone's cached roads view (built on a
            # worker thread when the station was opened — see
            # GasStationReviewTab._on_open_3d), not a per-open
            # transient parse on the UI thread.
            roads, _seg_index = self.zd.roads_view()
            self._roads_near = self.zd.nearby_segments(
                ring, margin=80.0, roads=roads or {})
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
        # 2.0.2: reframing also clears the universal controls'
        # pan/zoom — the default view IS the fitted framing.
        self._zoom = 1.0
        self._pan = [0.0, 0.0]

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
        self._update_sel_label()

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
            # 2.0.9: the picture follows the WORKING COPY —
            # box/detail are its records, and the front is
            # derived from its ring (building_front reads only
            # the subject's own record pair, so the copy stands
            # in for the zone at index 0). The neighbours stay
            # the zone's context around the building.
            if self.work is not None:
                self.box = self.work.boxes[0]
                self.detail = self.work.details[0]
            else:
                self.box = self.zd.boxes[self.index]
                self.detail = self.zd.details[self.index]
            # 2.0.0: the snapshot's context follows the edit too.
            try:
                self.neighbours = self.zd.neighbours_within(
                    self.index)
            except Exception:
                self.neighbours = []
            # 2.0.1: the cached roads view (built when the
            # building was opened) — a drag-end refresh never
            # re-parses the zone's roads on the UI thread.
            roads, seg_index = self.zd.roads_view()
            front_zd = self.work if self.work is not None \
                else self.zd
            front_idx = 0 if self.work is not None else self.index
            self.front_info = zonedata.building_front(
                front_zd, front_idx, self.flagged_entry,
                roads=roads or {}, seg_index=seg_index)
            ring = (self.front_info or {}).get("ring") \
                or self.detail.get("ring") or []
            self._roads_near = self.zd.nearby_segments(
                ring, margin=60.0, roads=roads or {})
            self._backdrop_gen += 1
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

    def refresh_view_light(self):
        """The cheap refresh (2.0.8, the stepper path): values,
        size/position lines and the picture — which draws the
        subject from the LIVE records, so a size change shows
        at once — WITHOUT re-deriving the front, the neighbours
        or the road backdrop. The full refresh follows on a
        short debounce (the tab schedules it), the same
        batching shape as the Map Editor's delete fix: the
        gesture never pays for the whole scene per step."""
        if self.mode == "building" and self.zd is not None \
                and self.index is not None \
                and self.index < len(self.zd.boxes):
            # 2.0.9: values + picture from the WORKING COPY's
            # records (see refresh_view).
            if self.work is not None:
                self.box = self.work.boxes[0]
                self.detail = self.work.details[0]
            else:
                self.box = self.zd.boxes[self.index]
                self.detail = self.zd.details[self.index]
            self._cur_values = {
                "x": self.box[0], "z": self.box[1], "w": self.box[2],
                "d": self.box[3], "h": self.box[4]}
            self._update_size_pos_labels()
        elif self.mode == "station":
            self._cur_values = None
            self._station_geometry()
            self._update_size_pos_labels()
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
        # 2.0.2 universal viewport controls: the fitted scale is
        # multiplied by the view's zoom factor, and the mapping is
        # shifted by the pan offset. Both are recorded in _view so
        # every inverse mapping (picking, manipulation) uses the
        # same transform the draw used.
        scale = max(scale * self._zoom, 0.05)
        ox, oy = self._pan
        self._view = {"scale": scale, "ac_mid": ac_mid,
                      "vt_mid": vt_mid, "w": width, "h": height,
                      "az": az, "el": el, "ox": ox, "oy": oy}

        def to_screen(dx, dz, h):
            across, vertical, _d = self._project(dx, dz, h, az, el)
            return (width / 2 + (across - ac_mid) * scale + ox,
                    height / 2 + (vertical - vt_mid) * scale + oy)
        return to_screen

    def _screen_to_ground(self, sx, sy):
        """Inverse of the last draw's transform, onto the ground
        plane: screen point -> (dx, dz) relative offsets."""
        v = self._view
        if not v:
            return None
        scale = v["scale"]
        # 2.0.2: undo the pan offset the fit applied (see _fit_view).
        across = (sx - v.get("ox", 0.0) - v["w"] / 2) / scale \
            + v["ac_mid"]
        vertical = (sy - v.get("oy", 0.0) - v["h"] / 2) / scale \
            + v["vt_mid"]
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
        if self.mode in ("building", "station"):
            self._draw_axis_gizmo(ctx, width, height)
        return False

    def _draw_axis_gizmo(self, ctx, width, height):
        """The axis reminder (2.0.8, Joshua): a fixed X/Z/Y
        representation in the TOP-RIGHT corner of the viewport,
        turning with the camera, so orientation is never in
        doubt while moving fast. The axes are spelled out in
        words, per his spelled-out-labels preference: X runs
        East–West, Z runs North–South, Y is Up."""
        if width < 220 or height < 180:
            return
        az, el = self.azimuth, self.elevation
        ox, oy = width - 132, 66
        # A dark plate keeps the lines readable over any scene.
        ctx.set_source_rgb(0.16, 0.17, 0.19)
        ctx.rectangle(ox - 58, oy - 54, 168, 112)
        ctx.fill()
        ctx.select_font_face("Sans")
        ctx.set_font_size(10)
        for label, vec, rgb in (
                ("X — East–West", (1.0, 0.0, 0.0),
                 (0.95, 0.35, 0.30)),
                ("Z — North–South", (0.0, 1.0, 0.0),
                 (0.40, 0.65, 1.00)),
                ("Y — Up", (0.0, 0.0, 1.0), (0.45, 0.90, 0.45))):
            across, vertical, _d = self._project(
                vec[0], vec[1], vec[2], az, el)
            ex = ox + across * 26
            ey = oy + vertical * 26
            ctx.set_source_rgb(*rgb)
            ctx.set_line_width(2)
            ctx.move_to(ox, oy)
            ctx.line_to(ex, ey)
            ctx.stroke()
            ctx.move_to(ex + (6 if ex >= ox else -58),
                        ey + 4)
            ctx.show_text(label)

    def _paint_backdrop(self, ctx, to_screen, cx, cz, width,
                        height):
        """Paint the backdrop layer (roads + neighbours) — from
        the offscreen cache when cairo is available (2.0.8):
        the layer is re-rendered only when the camera, the
        canvas size or the backdrop data changes, so a
        manipulation frame costs a blit plus the subject
        instead of re-walking every road segment and neighbour
        ring. Without cairo (or a ctx that can't take a
        surface) the same layer paints directly, as 2.0.7 did."""
        key = (width, height, round(self.azimuth, 4),
               round(self.elevation, 4), round(self._zoom, 4),
               round(self._pan[0], 1), round(self._pan[1], 1),
               self._backdrop_gen, self.mode, self.index)
        if _CAIRO_AVAILABLE and width > 0 and height > 0 \
                and hasattr(ctx, "set_source_surface"):
            if self._backdrop_key == key \
                    and self._backdrop_surface is not None:
                ctx.set_source_surface(self._backdrop_surface,
                                       0, 0)
                ctx.paint()
                return
            try:
                surf = cairo.ImageSurface(
                    cairo.FORMAT_ARGB32, width, height)
                bctx = cairo.Context(surf)
                self._draw_roads(bctx, to_screen, cx, cz,
                                 width, height)
                self._draw_neighbours(bctx, to_screen, cx, cz,
                                      width, height)
                surf.flush()
                self._backdrop_surface = surf
                self._backdrop_key = key
                ctx.set_source_surface(surf, 0, 0)
                ctx.paint()
                return
            except Exception:
                self._backdrop_surface = None
                self._backdrop_key = None
        self._draw_roads(ctx, to_screen, cx, cz, width, height)
        self._draw_neighbours(ctx, to_screen, cx, cz, width,
                              height)

    @staticmethod
    def _screen_visible(pts_screen, width, height, margin=90):
        """True when a projected polyline's bounding box meets
        the canvas (2.0.8 culling: off-screen backdrop geometry
        is not stroked at all)."""
        if width is None or height is None or not pts_screen:
            return True
        xs = [p[0] for p in pts_screen]
        ys = [p[1] for p in pts_screen]
        return not (max(xs) < -margin or min(xs) > width + margin
                    or max(ys) < -margin
                    or min(ys) > height + margin)

    def _draw_roads(self, ctx, to_screen, cx, cz, width=None,
                    height=None):
        """The backdrop streets (+ the selected street highlighted,
        amendment 3; the front road named). 2.0.8: asphalt in the
        game's road tone, and segments lying wholly off-canvas
        are culled before stroking."""
        selected = (self.selected_street or {}).get("name")
        front_name = None
        if self.mode == "building":
            front_name = (self.front_info or {}).get("front_road")
        for name, pts in self._roads_near:
            if len(pts) < 2:
                continue
            scr = [to_screen(p[0] - cx, p[1] - cz, 0)
                   for p in pts]
            if not self._screen_visible(scr, width, height):
                continue
            if selected and name == selected:
                ctx.set_source_rgb(*self.STREET_HILITE_RGB)
                ctx.set_line_width(7)
            elif front_name and name == front_name:
                ctx.set_source_rgb(0.36, 0.36, 0.38)
                ctx.set_line_width(5)
            else:
                ctx.set_source_rgb(*self.ASPHALT_RGB)
                ctx.set_line_width(5)
            for i, (sx, sy) in enumerate(scr):
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

    def _draw_neighbours(self, ctx, to_screen, cx, cz,
                         width=None, height=None):
        """The snapshot's context buildings (2.0.0): the subject's
        neighbours drawn around it — plain extruded footprints,
        no front marking, no labels — so the subject is always
        seen in its place, never alone on a void (Joshua's
        snapshot rule). Read-only: nothing here is pickable or
        editable. Painter order: far centres first, matching
        _draw_building's face sort; the subject draws over them
        afterwards.

        2.0.8: the flat blue-grey is gone — neighbours wear the
        GAME's muted building tones (the Detail Editor 1.2.0
        palette), one tone per building, stable across frames
        (picked from the building's place in the snapshot), with
        the subject's own light model shading their walls; and
        buildings lying wholly off-canvas are culled."""
        items = []
        for pos, nb in enumerate(self.neighbours or []):
            ring = nb.get("ring") or []
            if len(ring) < 3:
                continue
            ncx, ncz = zonedata.ring_centroid(ring)
            depth = self._project(ncx - cx, ncz - cz, 0,
                                  self.azimuth, self.elevation)[2]
            items.append((depth, pos, nb))
        items.sort(key=lambda t: t[0])
        light = (-0.45, -0.89)
        for _depth, pos, nb in items:
            ring = nb["ring"]
            hgt = nb.get("height_m") or nb["box"][4]
            n = len(ring)
            ground = [to_screen(p[0] - cx, p[1] - cz, 0)
                      for p in ring]
            if not self._screen_visible(ground, width, height):
                continue
            tone = self.NEIGHBOUR_TONES[pos % len(
                self.NEIGHBOUR_TONES)]
            ncx, ncz = zonedata.ring_centroid(ring)
            for i in range(n):
                a = ring[i]
                b = ring[(i + 1) % n]
                mx, mz = (a[0] + b[0]) / 2 - ncx, \
                    (a[1] + b[1]) / 2 - ncz
                norm = math.hypot(mx, mz) or 1.0
                shade = 0.78 + 0.22 * (mx * light[0]
                                       + mz * light[1]) / norm
                ctx.set_source_rgb(tone[0] * shade,
                                   tone[1] * shade,
                                   tone[2] * shade)
                quad = [(a[0], a[1], 0), (b[0], b[1], 0),
                        (b[0], b[1], hgt), (a[0], a[1], hgt)]
                for k, (px, pz, ph) in enumerate(quad):
                    sx, sy = to_screen(px - cx, pz - cz, ph)
                    if k == 0:
                        ctx.move_to(sx, sy)
                    else:
                        ctx.line_to(sx, sy)
                ctx.close_path()
                ctx.fill()
            # Roof: the same tone, a touch lighter.
            ctx.set_source_rgb(min(1.0, tone[0] * 1.18),
                               min(1.0, tone[1] * 1.18),
                               min(1.0, tone[2] * 1.18))
            for k, p in enumerate(ring):
                sx, sy = to_screen(p[0] - cx, p[1] - cz, hgt)
                if k == 0:
                    ctx.move_to(sx, sy)
                else:
                    ctx.line_to(sx, sy)
            ctx.close_path()
            ctx.fill()

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
        # 2.0.8 (Joshua, Oct 28): the framing takes in the
        # SURROUNDING ENVIRONMENT — the backdrop roads and the
        # neighbouring buildings, clamped to CONTEXT_FIT_MARGIN
        # around the subject — so the building is seen in its
        # neighbourhood in the game's colours, never alone in
        # a void. A side effect he also asked for: because the
        # (fixed) context, not the subject, now sets the
        # frame's extent, resizing the building no longer
        # re-frames the world around it — the building visibly
        # grows and shrinks inside a steady picture.
        _m = self.CONTEXT_FIT_MARGIN
        for _name, pts in self._roads_near:
            for p in pts:
                points.append((max(-_m, min(_m, p[0] - cx)),
                               max(-_m, min(_m, p[1] - cz)), 0))
        for nb in self.neighbours or []:
            for p in nb.get("ring") or []:
                points.append((max(-_m, min(_m, p[0] - cx)),
                               max(-_m, min(_m, p[1] - cz)), 0))
        to_screen = self._fit_view(ctx, points, width, height)
        # The ground: game grass across the whole framed
        # context, then the building's own plot, a touch
        # lighter (footprint grown a little).
        ctx.set_source_rgb(*self.GRASS_RGB)
        for i, (px, pz) in enumerate(((-_m, -_m), (_m, -_m),
                                      (_m, _m), (-_m, _m))):
            sx, sy = to_screen(px, pz, 0)
            if i == 0:
                ctx.move_to(sx, sy)
            else:
                ctx.line_to(sx, sy)
        ctx.close_path()
        ctx.fill()
        xs = [p[0] for p in ring]
        zs = [p[1] for p in ring]
        gx0, gx1 = min(xs) - 6, max(xs) + 6
        gz0, gz1 = min(zs) - 6, max(zs) + 6
        ctx.set_source_rgb(*self.PLOT_RGB)
        for i, (px, pz) in enumerate(((gx0, gz0), (gx1, gz0),
                                      (gx1, gz1), (gx0, gz1))):
            sx, sy = to_screen(px - cx, pz - cz, 0)
            if i == 0:
                ctx.move_to(sx, sy)
            else:
                ctx.line_to(sx, sy)
        ctx.close_path()
        ctx.fill()
        self._paint_backdrop(ctx, to_screen, cx, cz, width,
                             height)
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
        # The clicked part's highlight (2.0.6; side + corner
        # added 2.0.7) — stroked bright over the fill so the
        # selection is visible at a glance.
        part = self.selected_part
        if part == "roof":
            ctx.set_source_rgb(0.1, 0.9, 1.0)
            ctx.set_line_width(3)
            for i, p in enumerate(ring):
                sx, sy = to_screen(p[0] - cx, p[1] - cz, hgt)
                if i == 0:
                    ctx.move_to(sx, sy)
                else:
                    ctx.line_to(sx, sy)
            ctx.close_path()
            ctx.stroke()
        elif part == "front" or part == ("back",):
            # 2.0.8: front AND back walls highlight — the exact
            # ring edge the click picked from, when the pick
            # recorded one; the front falls back to the derived
            # front edge (the pre-2.0.8 behaviour).
            edge = self._sel_edge
            if edge is None and part == "front":
                edge = front_edge
            if edge is not None and 0 <= edge < len(ring):
                a = ring[edge]
                b = ring[(edge + 1) % len(ring)]
                quad = [to_screen(a[0] - cx, a[1] - cz, 0),
                        to_screen(b[0] - cx, b[1] - cz, 0),
                        to_screen(b[0] - cx, b[1] - cz, hgt),
                        to_screen(a[0] - cx, a[1] - cz, hgt)]
                ctx.set_source_rgb(0.1, 0.9, 1.0)
                ctx.set_line_width(3)
                for j, (sx, sy) in enumerate(quad):
                    if j == 0:
                        ctx.move_to(sx, sy)
                    else:
                        ctx.line_to(sx, sy)
                ctx.close_path()
                ctx.stroke()
        elif isinstance(part, tuple) and part[0] == "side" \
                and self._sel_edge is not None \
                and 0 <= self._sel_edge < len(ring):
            # 2.0.8: the side wall the click actually picked
            # (an articulated ring has several edges per side).
            a = ring[self._sel_edge]
            b = ring[(self._sel_edge + 1) % len(ring)]
            quad = [to_screen(a[0] - cx, a[1] - cz, 0),
                    to_screen(b[0] - cx, b[1] - cz, 0),
                    to_screen(b[0] - cx, b[1] - cz, hgt),
                    to_screen(a[0] - cx, a[1] - cz, hgt)]
            ctx.set_source_rgb(0.1, 0.9, 1.0)
            ctx.set_line_width(3)
            for j, (sx, sy) in enumerate(quad):
                if j == 0:
                    ctx.move_to(sx, sy)
                else:
                    ctx.line_to(sx, sy)
            ctx.close_path()
            ctx.stroke()
        elif isinstance(part, tuple) and part[0] == "side" \
                and front_edge is not None:
            # 2.0.7: the side face — the footprint edge next to
            # the front edge on the selected side (left/right by
            # the frame's right vector), stroked as a quad.
            f2, r2 = self._frame()
            n2 = len(ring)
            quad = None
            for cand in ((front_edge - 1) % n2,
                         (front_edge + 1) % n2):
                a, b = fi["edges"][cand]
                mx, mz = (a[0] + b[0]) / 2 - cx, \
                    (a[1] + b[1]) / 2 - cz
                if (mx * r2[0] + mz * r2[1] > 0) == (part[1] > 0):
                    quad = [to_screen(a[0] - cx, a[1] - cz, 0),
                            to_screen(b[0] - cx, b[1] - cz, 0),
                            to_screen(b[0] - cx, b[1] - cz, hgt),
                            to_screen(a[0] - cx, a[1] - cz, hgt)]
                    break
            if quad is not None:
                ctx.set_source_rgb(0.1, 0.9, 1.0)
                ctx.set_line_width(3)
                for j, (sx, sy) in enumerate(quad):
                    if j == 0:
                        ctx.move_to(sx, sy)
                    else:
                        ctx.line_to(sx, sy)
                ctx.close_path()
                ctx.stroke()
        elif isinstance(part, tuple) and part[0] == "corner":
            # 2.0.7: the corner — the footprint vertex nearest
            # the box corner the click classified, stroked as a
            # bright vertical with a ring at its foot, so the
            # move/rotate handle reads at a glance.
            v2 = self._cur_values
            if v2:
                f2, r2 = self._frame()
                sr = (-v2["w"] / 2, v2["w"] / 2, v2["w"] / 2,
                      -v2["w"] / 2)[part[1]]
                sf = (-v2["d"] / 2, -v2["d"] / 2, v2["d"] / 2,
                      v2["d"] / 2)[part[1]]
                wx = v2["x"] + r2[0] * sr + f2[0] * sf
                wz = v2["z"] + r2[1] * sr + f2[1] * sf
                near = min(ring, key=lambda p: (p[0] - wx) ** 2
                           + (p[1] - wz) ** 2)
                gx, gy = to_screen(near[0] - cx, near[1] - cz, 0)
                tx, ty = to_screen(near[0] - cx, near[1] - cz,
                                   hgt)
                ctx.set_source_rgb(0.1, 0.9, 1.0)
                ctx.set_line_width(3)
                ctx.move_to(gx, gy)
                ctx.line_to(tx, ty)
                ctx.stroke()
                ctx.arc(gx, gy, 6, 0, 2 * math.pi)
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
        return (v["w"] / 2 + (across - v["ac_mid"]) * v["scale"]
                + v.get("ox", 0.0),
                v["h"] / 2 + (vertical - v["vt_mid"]) * v["scale"]
                + v.get("oy", 0.0))

    def _on_open_in_map_editor(self, _widget):
        """Hand the selected street's location to the Map Editor.

        2.0.2: when this panel is showing a BUILDING, the building
        rides along (see AssetEditorWindow.open_in_map_editor):
        its name, its zone, its footprint ring exactly as the
        editor holds it right now — drags included, because
        manipulation rewrites detail["ring"] in place — and the
        ring's centre. In station mode, or with nothing shown, the
        handoff is the plain street jump it has always been."""
        s = self.selected_street
        if s:
            building = None
            if self.mode == "building" and self.detail:
                ring = self.detail.get("ring") or []
                if ring:
                    cx, cz = zonedata.ring_centroid(ring)
                    building = {
                        "name": self.detail.get("name") or "",
                        "zone": self.zone or s["zone"],
                        "footprint": [[float(px), float(pz)]
                                      for px, pz in ring],
                        "at": [float(cx), float(cz)],
                    }
            self.app_window.open_in_map_editor(
                s["zone"], s["x"], s["z"], s["name"],
                building=building)

    # -- dragging: pan / rotate, manipulation, click-to-pick ----------------

    def _pick_ring(self):
        """The world ring whose geometry is on screen, for
        picking: the building's drawn footprint ring (station
        mode: its ground ring). None when there is no ring —
        the box classification then applies alone."""
        if self.mode == "station":
            ring = self._station_ring()
            return ring if len(ring) >= 3 else None
        if self.mode == "building":
            ring = (self.detail or {}).get("ring") or []
            return ring if len(ring) >= 3 else None
        return None

    def _classify_ring(self, ring, sx, sy, ccx, ccz):
        """Classify a press against the DRAWN footprint ring
        (2.0.8 — the fix for Joshua's Oct 28 finding that walls
        other than the roof, and nearly all corners, were not
        selectable: 2.0.7 classified against the box rectangle,
        so on any building whose footprint is not its box —
        rotated, articulated, a church with jutting walls —
        the walls and corners on screen were not the walls and
        corners the picker tested).

        Corners: every ring VERTEX is grabbable — on its
        ground or roof POINT (which wins even over a wall the
        point borders), or along its vertical edge when the
        press hits no wall (a near-miss fallback) — and
        reports the nearest box corner index (the manipulation
        model's corner numbering is unchanged). Roof: the ring
        at height. Walls: every ring edge's quad, classified
        by the edge's outward normal in the manipulation
        frame — front ("depth", +1), BACK ("depth", -1; new
        in 2.0.8 — the back wall was never even tested
        before), and the two sides ("width", ±1). The winning
        wall's edge index is kept in self._grab_edge so the
        highlight can trace the exact wall clicked. Returns
        the grab, or None when the press misses the drawn
        building entirely."""
        v = self._cur_values
        if not v:
            return None
        hgt = v["h"]
        n = len(ring)
        f, r = self._frame()
        ground = [self._project_screen(p[0] - ccx, p[1] - ccz, 0)
                  for p in ring]
        roof = [self._project_screen(p[0] - ccx, p[1] - ccz, hgt)
                for p in ring]
        # Precedence (2.0.8, second pass — measured on the
        # real 69-vertex subject #17990): a press right on a
        # corner POINT (a vertex's ground or roof dot) grabs
        # the corner; a press INSIDE a wall or the roof takes
        # that wall / the roof, even when it sits near a
        # vertex's vertical edge; the vertical edges are the
        # near-miss fallback for presses that hit nothing.
        # The first pass tested the full vertical edges
        # BEFORE the walls, and on a dense articulated ring
        # — segments a few pixels long on screen — every
        # wall midpoint fell inside some vertex's edge
        # tolerance: the probe read walls 3/69 and no screen
        # point classified as a side wall at all, the very
        # defect this release exists to fix.
        cx, cz = v["x"], v["z"]
        hw, hd = v["w"] / 2, v["d"] / 2
        box_world = []
        for sr, sf in self._CORNERS:
            box_world.append((cx + r[0] * sr * hw + f[0] * sf * hd,
                              cz + r[1] * sr * hw + f[1] * sf * hd))
        box_screen = []
        for wx, wz in box_world:
            box_screen.append((
                self._project_screen(wx - ccx, wz - ccz, 0),
                self._project_screen(wx - ccx, wz - ccz, hgt)))
        best_point = None       # (dist, ring vertex index)
        for i in range(n):
            for px, py in (ground[i], roof[i]):
                d = math.hypot(sx - px, sy - py)
                if d <= self.CORNER_GRAB_PX and (
                        best_point is None or d < best_point[0]):
                    best_point = (d, i)
        best_box_point = None   # (dist, box corner index)
        for i in range(4):
            for px, py in box_screen[i]:
                d = math.hypot(sx - px, sy - py)
                if d <= self.CORNER_GRAB_PX and (
                        best_box_point is None
                        or d < best_box_point[0]):
                    best_box_point = (d, i)
        # The roof: the ring at height.
        roof_hit = self._point_in_poly(sx, sy, roof)
        # The walls: every edge's quad, the nearest (largest
        # depth) winning where projections overlap.
        faces = []
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            quad = [ground[i], ground[(i + 1) % n],
                    roof[(i + 1) % n], roof[i]]
            if not self._point_in_poly(sx, sy, quad):
                continue
            mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            ex, ez = b[0] - a[0], b[1] - a[1]
            nx, nz = -ez, ex
            if nx * (mx - ccx) + nz * (mz - ccz) < 0:
                nx, nz = -nx, -nz
            nf = nx * f[0] + nz * f[1]
            nr = nx * r[0] + nz * r[1]
            if abs(nf) >= abs(nr):
                kind, side = "depth", (1 if nf > 0 else -1)
            else:
                kind, side = "width", (1 if nr > 0 else -1)
            depth = self._project(mx - ccx, mz - ccz, hgt / 2,
                                  self._view["az"],
                                  self._view["el"])[2]
            faces.append((depth, kind, side, i))
        corner = None
        if best_point is not None and (
                best_box_point is None
                or best_point[0] <= best_box_point[0]):
            corner = ("ring", best_point)
        elif best_box_point is not None:
            corner = ("box", best_box_point)
        contained = roof_hit or bool(faces)
        if corner is not None and (
                not contained
                or corner[1][0] <= self.CORNER_POINT_PX):
            if corner[0] == "ring":
                vx, vz = ring[corner[1][1]]
                mapped = min(
                    range(4),
                    key=lambda i: (box_world[i][0] - vx) ** 2
                    + (box_world[i][1] - vz) ** 2)
                return ("corner", mapped)
            return ("corner", corner[1][1])
        if roof_hit:
            return ("height", 0)
        if faces:
            faces.sort(key=lambda t: t[0], reverse=True)
            _depth, kind, side, edge = faces[0]
            self._grab_edge = edge
            return (kind, side)
        # Near-miss fallback: the vertical edges — the ring's
        # full edges and the box's (to mid-height, as 2.0.7
        # tested) — grab a press that hit no wall, no roof
        # and no corner point, so a grab aimed just beside
        # the building's outline still finds the corner.
        best_ring_edge = None   # (dist, ring vertex index)
        for i in range(n):
            gx, gy = ground[i]
            d_edge, _t = self._point_seg_dist(
                sx, sy, gx, gy, roof[i][0], roof[i][1])
            if d_edge <= self.CORNER_EDGE_PX and (
                    best_ring_edge is None
                    or d_edge < best_ring_edge[0]):
                best_ring_edge = (d_edge, i)
        best_box_edge = None    # (dist, box corner index)
        for i in range(4):
            (gx, gy), (tx, ty) = box_screen[i]
            mx, my = (gx + tx) / 2, (gy + ty) / 2
            d_edge, _t = self._point_seg_dist(sx, sy, gx, gy,
                                              mx, my)
            if d_edge <= self.CORNER_EDGE_PX and (
                    best_box_edge is None
                    or d_edge < best_box_edge[0]):
                best_box_edge = (d_edge, i)
        if best_ring_edge is not None and (
                best_box_edge is None
                or best_ring_edge[0] <= best_box_edge[0]):
            vx, vz = ring[best_ring_edge[1]]
            mapped = min(
                range(4),
                key=lambda i: (box_world[i][0] - vx) ** 2
                + (box_world[i][1] - vz) ** 2)
            return ("corner", mapped)
        if best_box_edge is not None:
            return ("corner", best_box_edge[1])
        return None

    def _classify_grab(self, sx, sy):
        """
        What a press at (sx, sy) grabs, by Joshua's manipulation
        model (2.0.7):
          ("corner", i) — near a bottom corner (i = 0..3 in
              _CORNERS order): the drag MOVES the building; the
              press handler turns the same grip into the
              ROTATION grip when Shift is held, and into the
              WHOLE-SIZE SCALE grip when Ctrl is held;
          ("height", 0) — inside the ROOF: the drag changes the
              height, nothing else;
          ("depth", +1) — inside the FRONT face: the drag
              changes the depth, the front wall moving and the
              back wall staying put;
          ("width", ±1) — inside a LEFT/RIGHT face: the drag
              changes the width, that wall moving and the
              opposite wall staying put;
          None — off the building (a view drag — pan, or rotate
              with a modifier held — or a click).
        2.0.8: classification runs on the DRAWN footprint ring
        first (see _classify_ring): every wall — front, BACK
        (("depth", -1), new), and both sides — and every corner
        is pickable by its line on screen. The BOX rectangle
        tests below (the same rectangle the number fields
        describe, projected with the last draw's transform)
        remain as the fallback. When more than one face
        contains the point (an oblique view), the face nearest
        the viewer wins.
        """
        v = self._cur_values
        if not v or not self._view:
            return None
        f, r = self._frame()
        cx, cz = v["x"], v["z"]
        hw, hd = v["w"] / 2, v["d"] / 2
        ccx, ccz = self._centre()

        # 2.0.8: the DRAWN footprint ring classifies first
        # (see _classify_ring) — walls and corners are picked
        # by the lines actually on screen. The box tests below
        # remain as the fallback for presses the ring misses
        # (and the only path when there is no ring), unchanged.
        self._grab_edge = None
        ring = self._pick_ring()
        if ring:
            got = self._classify_ring(ring, sx, sy, ccx, ccz)
            if got is not None:
                return got

        def screen(sr, sf, h):
            wx = cx + r[0] * sr + f[0] * sf
            wz = cz + r[1] * sr + f[1] * sf
            return self._project_screen(wx - ccx, wz - ccz, h)

        roof = [screen(sr * hw, sf * hd, v["h"])
                for sr, sf in self._CORNERS]
        ground = [screen(sr * hw, sf * hd, 0)
                  for sr, sf in self._CORNERS]
        # 1. Corners first: the move/rotate handle gets a
        # generous target — on the corner's ground point, or
        # along the lower half of its vertical edge (where two
        # walls meet, low on the building, as Joshua put it).
        best = None
        for i in range(4):
            gx, gy = ground[i]
            near = math.hypot(sx - gx, sy - gy)
            if near > self.CORNER_GRAB_PX:
                near = None
            mx, my = (gx + roof[i][0]) / 2, (gy + roof[i][1]) / 2
            along, _t = self._point_seg_dist(sx, sy, gx, gy,
                                             mx, my)
            if along > self.CORNER_EDGE_PX:
                along = None
            cand = [d for d in (near, along) if d is not None]
            if cand and (best is None or min(cand) < best[0]):
                best = (min(cand), i)
        if best is not None:
            return ("corner", best[1])
        # 2. The roof: the drag changes the height.
        if self._point_in_poly(sx, sy, roof):
            return ("height", 0)
        # 3. The faces, as quads in _CORNERS order: the front
        # face is edge 2->3 (sf = +hd), the right face edge
        # 1->2 (sr = +hw), the left face edge 3->0 (sr = -hw).
        faces = []

        def face(kind, side, i0, i1, off_r, off_f):
            quad = [roof[i0], roof[i1], ground[i1], ground[i0]]
            if self._point_in_poly(sx, sy, quad):
                wx = cx + r[0] * off_r + f[0] * off_f
                wz = cz + r[1] * off_r + f[1] * off_f
                depth = self._project(
                    wx - ccx, wz - ccz, v["h"] / 2,
                    self._view["az"], self._view["el"])[2]
                faces.append((depth, kind, side))

        face("depth", 1, 2, 3, 0, hd)
        face("width", 1, 1, 2, hw, 0)
        face("width", -1, 3, 0, -hw, 0)
        if faces:
            # Largest depth = nearest the viewer (see _project).
            faces.sort(key=lambda t: t[0], reverse=True)
            return (faces[0][1], faces[0][2])
        return None

    def _project_screen(self, dx, dz, h):
        """Project with the last draw's transform, at height h."""
        v = self._view
        across, vertical, _d = self._project(dx, dz, h,
                                             v["az"], v["el"])
        return (v["w"] / 2 + (across - v["ac_mid"]) * v["scale"]
                + v.get("ox", 0.0),
                v["h"] / 2 + (vertical - v["vt_mid"]) * v["scale"]
                + v.get("oy", 0.0))

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
        # Take keyboard focus so the universal controls' + / −
        # zoom keys land here after any click in the view.
        try:
            self.drawing.grab_focus()
        except Exception:
            pass
        # 2.0.2 universal viewport controls: a modifier held
        # makes the drag a ROTATE — and 2.0.7 (Joshua's model)
        # splits it by modifier AND by where the press lands:
        #   corner + SHIFT  -> rotate THE BUILDING (his "use
        #     shift for control"), when the tab offers
        #     manip_rotate;
        #   corner + CTRL   -> scale THE WHOLE BUILDING, when
        #     the tab offers manip_scale (ZoneData.scale);
        #   a modifier drag starting anywhere else rotates the
        #     VIEW exactly as 2.0.2.
        # Both modifiers together: Shift wins (rotate) — an
        # undefined combination in Joshua's model, settled
        # here. (getattr guards: harness-fabricated events may
        # carry no modifier state at all.)
        state = getattr(event, "state", 0) or 0
        try:
            ctrl_mask = Gdk.ModifierType.CONTROL_MASK
            shift_mask = Gdk.ModifierType.SHIFT_MASK
        except Exception:
            ctrl_mask = 1 << 2   # GDK's CONTROL_MASK value
            shift_mask = 1 << 0  # GDK's SHIFT_MASK value
        ctrl = bool(state & ctrl_mask)
        shift = bool(state & shift_mask)
        rotate = ctrl or shift
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
        # Classified even under a modifier — the press point is
        # what decides building-op vs view-op (2.0.6; the grip
        # narrowed to the corner in 2.0.7). A corner grab with
        # no modifier is the MOVE drag.
        grab = self._classify_grab(event.x, event.y)
        # 2.0.8 (Joshua's sizing-lock rule): while a part is
        # selected FOR SIZING, pan and rotate are DISABLED —
        # every drag sizes the building. A press that misses
        # the building therefore grabs the SELECTED part
        # (synthesized here) instead of panning; a modifier
        # press off the building sizes too, rather than
        # rotating the view. Modifier grips ON a corner
        # (rotate/scale the building) are manipulations, not
        # navigation, and keep working.
        sizing = self._sizing_grab()
        press_on_building = grab is not None
        synth = False
        if sizing is not None and grab is None:
            grab = sizing
            synth = True
        kind = grab[0] if grab else "pan"
        if kind == "corner":
            kind = "move"
        angle0 = None
        scale = None
        # A modifier press on a FACE while sizing is active is
        # still a sizing drag (the face's own), never a view
        # rotation — only the corner grips keep their modifier
        # meanings under the lock.
        if rotate and not synth and not (
                sizing is not None and grab is not None
                and grab[0] != "corner"):
            kind = "rotate"
            on_corner = self.mode == "building" \
                and grab is not None and grab[0] == "corner" \
                and self.tab is not None
            if on_corner and shift \
                    and callable(getattr(self.tab, "manip_rotate",
                                         None)):
                kind = "rotate_bldg"
                try:
                    angle0 = self.tab.manip_angle()
                except Exception:
                    angle0 = None
            elif on_corner and ctrl and not shift \
                    and self._cur_values \
                    and callable(getattr(self.tab, "manip_scale",
                                         None)):
                # The scale setup: the anchor is the OPPOSITE
                # corner's ground point (it must not move);
                # the factor is the pointer's distance from the
                # anchor over the grabbed corner's starting
                # distance from it.
                kind = "scale_bldg"
                sr, sf = self._CORNERS[grab[1]]
                v = self._cur_values
                f, r = self._frame()
                gx = v["x"] + r[0] * sr * v["w"] / 2.0 \
                    + f[0] * sf * v["d"] / 2.0
                gz = v["z"] + r[1] * sr * v["w"] / 2.0 \
                    + f[1] * sf * v["d"] / 2.0
                scale = {
                    "anchor": (2.0 * v["x"] - gx,
                               2.0 * v["z"] - gz),
                    "dist0": math.hypot(gx - (2.0 * v["x"] - gx),
                                        gz - (2.0 * v["z"] - gz)),
                    "factor": 1.0,
                    "applied": 1.0,
                }
        self._drag = {
            "kind": kind,
            "side": grab[1] if grab else 0,
            # 2.0.6: the press classification, kept for the
            # click-selection decision at release time.
            "grab": grab,
            # 2.0.8 sizing lock: whether the press landed on
            # the building itself, and whether a sizing
            # selection was active — the release tells an
            # end-sizing click on empty ground from a
            # street-picking click by these.
            "press_on_building": press_on_building,
            "sizing_active": sizing is not None,
            # 2.0.8: the ring edge the press grabbed, if any —
            # the click selection highlights that exact wall.
            "grab_edge": self._grab_edge,
            # 2.0.6 rotate_bldg bookkeeping: the orientation at
            # press time and the accumulated drag turn.
            "angle0": angle0,
            "cum_delta": 0.0,
            # 2.0.7 scale_bldg bookkeeping (see above).
            "scale": scale,
            "sx": event.x, "sy": event.y,
            "x": event.x, "y": event.y,
            "az0": self.azimuth, "el0": self.elevation,
            "pan0": list(self._pan),
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
        if kind in ("width", "depth") \
                and self._drag["start"] is not None:
            # 2.0.7: the face drags are measured from the
            # POINTER's ground position at press time, not from
            # the wall's own coordinate — a press lands on the
            # face at height, and its ground projection sits
            # offset from the wall by the view's parallax, so
            # comparing the pointer against the wall's u made
            # the wall jump on engagement and run off the hand.
            # Press-relative, the wall follows the hand's
            # ground travel exactly.
            f, r = self._frame()
            axis = r if kind == "width" else f
            g0p = self._screen_to_ground(event.x, event.y)
            if g0p:
                st = self._drag["start"]
                ccx, ccz = self._drag["centre"]
                self._drag["u_press"] = (
                    (ccx + g0p[0] - st["x"]) * axis[0]
                    + (ccz + g0p[1] - st["z"]) * axis[1])
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
        if kind == "pan":
            # 2.0.2 universal controls: a plain drag PANS — the
            # view's pixel offset follows the pointer exactly, and
            # the camera angles do not move.
            self._pan[0] = d["pan0"][0] + (event.x - d["sx"])
            self._pan[1] = d["pan0"][1] + (event.y - d["sy"])
            self.drawing.queue_draw()
            return True
        if kind == "rotate":
            # 2.0.2 universal controls: a modifier drag ROTATES
            # THE VIEW (the pre-2.0.2 orbit motion, unchanged
            # maths and clamps) — the branch a modifier press
            # lands in when it did NOT start on a building
            # corner (2.0.7) — and the pan offset does not move.
            self.azimuth = d["az0"] + (event.x - d["sx"]) * 0.01
            self.elevation = max(
                self.MIN_ELEVATION,
                min(self.MAX_ELEVATION,
                    d["el0"] + (d["sy"] - event.y) * 0.01))
            self.drawing.queue_draw()
            return True
        if kind == "rotate_bldg":
            # 2.0.7 (Joshua): the corner modifier drag turns THE
            # BUILDING. Horizontal movement only,
            # ROTATE_DEG_PER_PX per pixel, applied incrementally
            # through the tab (each step is small, so the
            # mod-180 orientation never wraps mid-drag). The
            # live preview is the model itself turning — the
            # picture draws the footprint ring the tab just
            # rotated. Like every manipulation it engages only
            # past the click threshold; d["x"] is not advanced
            # while under it, so no part of the turn is lost
            # when the drag engages.
            if not d["moved"]:
                return True
            step = (event.x - d["x"]) * self.ROTATE_DEG_PER_PX
            d["x"], d["y"] = event.x, event.y
            if step and self.tab is not None:
                try:
                    res = self.tab.manip_rotate(step)
                except Exception:
                    res = None
                if res is None:
                    # Refused (e.g. a flagged building): end the
                    # drag; the tab has said why in the status bar.
                    self._drag = None
                    self._hide_rotate_readout()
                    return True
                d["cum_delta"] += step
                self._cur_values = dict(res)
                angle = ((d["angle0"] or 0.0) + d["cum_delta"]) \
                    % 180.0
                self._show_rotate_readout(angle)
                self._update_size_pos_labels()
                self.drawing.queue_draw()
            return True
        if kind == "scale_bldg":
            # 2.0.7 (Joshua): Ctrl+corner scales the WHOLE
            # building — footprint and height by one factor,
            # anchored on the opposite corner (see the press
            # handler for the setup). The factor is the
            # pointer's ground distance from the anchor over
            # the grabbed corner's starting distance; steps go
            # through the tab incrementally about the SAME
            # anchor, so the anchor never drifts. Engages only
            # past the click threshold, like every manipulation.
            if not d["moved"]:
                return True
            scfg = d["scale"]
            g = self._screen_to_ground(event.x, event.y)
            if scfg and g:
                ccx, ccz = d.get("centre") or self._centre()
                px, pz = ccx + g[0], ccz + g[1]
                ax, az = scfg["anchor"]
                if scfg["dist0"] > 1e-9:
                    total = math.hypot(px - ax, pz - az) \
                        / scfg["dist0"]
                    total = max(0.05, min(20.0, total))
                    step = total / scfg["applied"]
                    if step != 1.0 and self.tab is not None:
                        try:
                            res = self.tab.manip_scale(step, ax, az)
                        except Exception:
                            res = None
                        if res is None:
                            # Refused (flagged): end the drag;
                            # the tab has said why.
                            self._drag = None
                            self._hide_rotate_readout()
                            return True
                        scfg["applied"] = total
                        scfg["factor"] = total
                        self._cur_values = dict(res)
                        self._show_scale_readout(total, res)
                        self._update_size_pos_labels()
                        self.drawing.queue_draw()
            return True
        if d["start"] is None or self.tab is None:
            return True
        # 2.0.7: EVERY manipulation engages only past the click
        # threshold — a press that stays put is the click that
        # selects the part, and must not move, resize or
        # re-height the building by a pixel of hand jitter. The
        # candidates below are computed from the press-time
        # start values, so engaging late loses nothing.
        if not d["moved"]:
            return True
        start = d["start"]
        cand = dict(start)
        f, r = self._frame()
        if kind == "move":
            # 2.0.7 (Joshua): the corner move — the building
            # follows the pointer in the ground plane.
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
            if d.get("u_press") is not None:
                # Press-relative (2.0.7, see _on_drag_press):
                # the wall moves by the pointer's ground travel
                # along the axis since the press.
                delta = u - d["u_press"]
            else:
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
        if d is None:
            return True

        def manip_end(kind):
            # The tab's drag-end hook, timed for the suite
            # report (2.0.8: the heavy paths carry timings —
            # this one pays the front/backdrop re-derivation).
            hook = getattr(self.tab, "on_manip_end", None)
            if hook is None:
                return
            if reporting is not None:
                with reporting.operation("sizing", kind=kind):
                    hook()
            else:
                hook()

        if d["kind"] == "rotate_bldg":
            # 2.0.6: the building-turn ends — readout away, the
            # tab's Rotation field holds the final angle, and a
            # real turn re-derives front + backdrop.
            self._hide_rotate_readout()
            if d["moved"]:
                manip_end("rotate")
            return True
        if d["kind"] == "scale_bldg":
            # 2.0.7: the whole-size scale ends — readout away,
            # the tab's fields hold the final size, and a real
            # scale re-derives front + backdrop.
            self._hide_rotate_readout()
            if d["moved"]:
                manip_end("scale")
            return True
        if not d["moved"] and self.mode == "building" \
                and d.get("sizing_active") \
                and not d.get("press_on_building"):
            # 2.0.8: a plain click on EMPTY ground while a
            # sizing selection is active ENDS the sizing —
            # navigation (pan/rotate) is restored, and the
            # click is consumed: it is not a street pick.
            self._set_selected_part(None)
            return True
        if not d["moved"] and self.mode == "building" \
                and d.get("grab") is not None:
            # A plain CLICK on the building selects the part
            # clicked — roof, front face, BACK face (2.0.8),
            # side face or corner (2.0.6; the part set is
            # 2.0.7's) — instead of falling through to a street
            # pick.
            grab = d["grab"]
            if grab[0] == "height":
                part = "roof"
            elif grab[0] == "depth":
                part = "front" if grab[1] > 0 else ("back",)
            elif grab[0] == "width":
                part = ("side", grab[1])
            else:  # "corner"
                part = ("corner", grab[1])
            self._set_selected_part(part, d.get("grab_edge"))
            return True
        if d["kind"] == "pan" and not d["moved"]:
            # A click, not a drag: any part selection clears, and
            # the click may be a street pick.
            if self.selected_part is not None:
                self._set_selected_part(None)
            self.pick_street(event.x, event.y)
        elif d["kind"] in ("move", "width", "depth", "height"):
            # A manipulation drag ended: let the tab re-derive the
            # front + backdrop at the object's new spot.
            manip_end(d["kind"])
        return True

    # -- universal viewport controls: zoom (2.0.2) --------------------------

    # One zoom step, shared by the wheel and the + / − keys so
    # both feel identical; the factor is clamped so the view can
    # neither vanish nor blow up without bound.
    ZOOM_STEP = 1.12
    ZOOM_MIN = 0.15
    ZOOM_MAX = 10.0

    def _zoom_by(self, factor):
        """Multiply the view's zoom factor (clamped); redraw."""
        self._zoom = max(self.ZOOM_MIN,
                         min(self.ZOOM_MAX, self._zoom * factor))
        self.drawing.queue_draw()

    def _on_scroll(self, _widget, event):
        """Mouse wheel = zoom in/out (universal controls)."""
        if self.mode is None:
            return False
        factor = None
        direction = None
        try:
            direction = event.get_scroll_direction()
        except Exception:
            direction = None
        up = getattr(getattr(Gdk, "ScrollDirection", None),
                     "UP", None)
        down = getattr(getattr(Gdk, "ScrollDirection", None),
                       "DOWN", None)
        if direction is not None and direction == up:
            factor = self.ZOOM_STEP
        elif direction is not None and direction == down:
            factor = 1.0 / self.ZOOM_STEP
        else:
            # Smooth-scroll devices report deltas instead of a
            # direction: negative dy (scroll up) zooms in.
            try:
                _ok, _dx, dy = event.get_scroll_deltas()
            except Exception:
                return False
            if dy < 0:
                factor = self.ZOOM_STEP
            elif dy > 0:
                factor = 1.0 / self.ZOOM_STEP
            else:
                return False
        self._zoom_by(factor)
        return True

    def _on_key_press(self, _widget, event):
        """The + and − keys = the same zoom as the wheel
        (universal controls). Esc ends an active sizing
        selection (2.0.8). Other keys pass through."""
        keyval = getattr(event, "keyval", None)
        # (0xFF1B is Gdk.KEY_Escape's value; named too so the
        # intent reads plainly.)
        if keyval in (getattr(Gdk, "KEY_Escape", 0xFF1B), 0xFF1B) \
                and self._sizing_grab() is not None:
            self._set_selected_part(None)
            return True
        plus = (getattr(Gdk, "KEY_plus", 0x2B),
                getattr(Gdk, "KEY_equal", 0x3D),
                getattr(Gdk, "KEY_KP_Add", 0xFFAB))
        minus = (getattr(Gdk, "KEY_minus", 0x2D),
                 getattr(Gdk, "KEY_KP_Subtract", 0xFFAD))
        if keyval in plus:
            self._zoom_by(self.ZOOM_STEP)
            return True
        if keyval in minus:
            self._zoom_by(1.0 / self.ZOOM_STEP)
            return True
        return False


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
        self._row_window = 0           # first row of _rows the
        # list materialises (normally 0; focus_building slides it
        # so a handed-over building past ROW_CAP is reachable)
        self._filter_id = "all"        # the ONE filter state (below)
        self._sort_key = None          # None | "name" | "type" | "flag"
        self._sort_asc = True
        # 2.0.5: True while refresh() is rebuilding the list.
        # Clearing the store makes GTK fire a transient "no
        # selection" change; _on_select must not read that as
        # the user putting the building down (see refresh()).
        self._rebuilding = False
        self._rows = []                # full filtered row dicts
        self._spins_loading = False    # guard: programmatic spin sets
        self._place_retry = False      # place-after-load retry flag
        # 2.0.8 speed pass: the debounced full-refresh source
        # and the drag-end follow-up slot (see _apply_values).
        self._view_refresh_source = None
        self._drag_followup_idx = None
        # 2.0.1: snapshot-load generation. Every selection bumps
        # it; a snapshot worker whose generation is no longer
        # current when it finishes is SUPERSEDED — its result is
        # dropped, never applied over the newer selection.
        self._sel_gen = 0

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
                            "(typing applies at once to the "
                            "preview — Apply sends it back)")
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
        # Rotation (2.0.6, Joshua): the footprint's orientation in
        # degrees, derived from its ring
        # (zonedata.ring_orientation_deg) and filled by
        # _sync_rot_field; typing a number turns the building to
        # it at once, like every other field, through its own
        # handler — rotation is not a move/resize value.
        edit.pack_start(Gtk.Label(label="Rotation (°)"),
                        False, False, 0)
        self.mrot = Gtk.SpinButton.new_with_range(0, 180, 1)
        self.mrot.set_digits(0)
        self.mrot.connect("value-changed", self._on_rot_changed)
        edit.pack_start(self.mrot, False, False, 0)
        move_btn = Gtk.Button(label="Move / Resize Selected")
        move_btn.connect("clicked", self._on_move_resize)
        edit.pack_start(move_btn, False, False, 4)
        del_btn = Gtk.Button(label="Delete Selected")
        del_btn.connect("clicked", self._on_delete)
        edit.pack_start(del_btn, False, False, 0)
        # Detail Edit: the same door the building's own tab
        # has. 2.0.8 interim honesty: the Detail Editor takes
        # roads only, so the window says so plainly and sends
        # nothing (see open_in_detail_editor).
        detail_btn = Gtk.Button(label="Detail Edit")
        detail_btn.set_tooltip_text(
            "The Detail Editor works on roads — buildings "
            "aren't supported there yet")
        detail_btn.connect("clicked", self._on_detail_edit)
        edit.pack_start(detail_btn, False, False, 0)
        self.detail_btn = detail_btn
        # APPLY (2.0.9, Joshua's cache + Apply model): edits
        # live on the building's working copy until this button
        # sends the finished copy back in one save round trip.
        # The label beside it is the dirty state, spelled out.
        self.apply_btn = Gtk.Button(label="Apply")
        self.apply_btn.get_style_context().add_class(
            "suggested-action")
        self.apply_btn.set_tooltip_text(
            "Send the finished changes back in one save")
        self.apply_btn.connect("clicked", self._on_apply)
        self.apply_btn.set_sensitive(False)
        edit.pack_start(self.apply_btn, False, False, 4)
        self.work_label = Gtk.Label(label="")
        self.work_label.set_halign(Gtk.Align.START)
        edit.pack_start(self.work_label, False, False, 0)
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
        # 2.0.1 (Defect 2 — the startup layout collapse): both
        # vertical dividers get their DESIGNED OPENING SHARES.
        # The lists block keeps at least 55% of the column and
        # the edit/place rows below it get their natural height
        # (at most 45%); inside the lists block the hero list
        # gets its natural height (at most 35%) and the buildings
        # list takes the rest, never less than 65% of the block.
        # In 2.0.0 nothing positioned these dividers and the
        # editor opened with the list collapsed to ~20 px.
        paned_opening_share(self.vpaned, first_min_share=0.55,
                            second_min_px=120, second_max_share=0.45)
        paned_opening_share(self.upper_paned, first_min_share=0.65,
                            second_min_px=64, second_max_share=0.35,
                            sized_child="first")

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
        # 2.0.6: the Rotation field follows every fill — it is
        # derived from the building's ring, not a stored value.
        self._sync_rot_field()

    def _sync_rot_field(self):
        """Show the current building's footprint orientation in
        the Rotation field (2.0.6). A code fill, never a
        live-apply: the loading guard is saved/restored around
        the set so a fill inside another fill stays guarded."""
        if not hasattr(self, "mrot"):
            return
        zd = self._zd()
        idx = self.inspector.index \
            if getattr(self, "inspector", None) is not None \
            and self.inspector.get_visible() \
            else self._selected_index()
        if zd is None or idx is None or idx >= len(zd.boxes):
            return
        # 2.0.9: while the building is open, the field shows
        # the WORKING COPY's orientation (its saved orientation
        # only when no copy is open on it).
        work = self._work_for(idx)
        ring = (work.details[0].get("ring") if work is not None
                else zd.details[idx].get("ring")) or []
        if not ring:
            return
        prev = self._spins_loading
        self._spins_loading = True
        try:
            self.mrot.set_value(zonedata.ring_orientation_deg(ring))
        finally:
            self._spins_loading = prev

    def _on_rot_changed(self, _spin=None):
        """Typing an angle turns the selected building to it at
        once — the Rotation field's twin of _on_spin_changed.
        2.0.9: it turns the WORKING COPY; Apply sends it back."""
        if self._spins_loading:
            return
        zd = self._zd()
        store = self._store()
        idx = self._selected_index()
        if store is None or zd is None or idx is None \
                or idx >= len(zd.boxes):
            return
        work = self._work_for(idx)
        if work is None:
            self._sync_rot_field()
            return
        try:
            turned = work.rotate_to(0, self.mrot.get_value(),
                                    flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            self._sync_rot_field()
            return
        if not turned:
            return
        self.inspector.note_work_edit()
        box = work.boxes[0]
        self._set_spins(box[0], box[1], box[2], box[3], box[4])
        if self.inspector.get_visible() \
                and self.inspector.index == idx:
            # 2.0.8: the rotation step turns the building in
            # the viewport on the step itself (light refresh
            # now, front re-derivation on the debounce) — the
            # landed tab's _on_rot_changed carries the note.
            self.inspector.refresh_view_light()
            self._schedule_view_refresh()
        self.app_window._set_status(
            f"Building #{idx} rotated in the preview — "
            f"unapplied (Apply sends it back).")

    # -- the list: rows from the index (or the loaded detail) -----------

    def _build_rows(self):
        """The full row set for the current zone + filter, sorted
        per the active sort. Row: {i, name, code, flagged}.

        2.0.0: rows ALWAYS come from the zone's light index. The
        1.7.x "zone loaded" branch re-derived names and flags from
        the full detail records — under the snapshot model that
        would fetch every chunk in the zone just to draw a list
        (the hidden whole-zone load the model bans). The index is
        regenerated by the editor's own saves, so it cannot show
        its own edits stale; the FLAGGED marker is centre-based
        here (match_point) and the LOCK re-checks with the real
        ring when the building's snapshot opens."""
        store = self._store()
        if store is None:
            return [], 0, 0
        idx = store.indexes.get(self._zone)
        if idx is None:
            return [], 0, 0
        # 2.0.1 speed: the flagged set for a zone is computed
        # ONCE per (index, flagged-list) pair and cached — both
        # are session-static (a save reloads the index object,
        # which changes its identity and so refreshes the cache).
        # The per-entry match_point walk cost ~0.25 s of UI-thread
        # time on EVERY refresh of a big zone (52,771 entries for
        # riverdale) — most of it re-answering a question whose
        # answer cannot change.
        key = (self._zone, id(idx), id(store.flagged))
        if getattr(self, "_flag_key", None) == key:
            flagged_set = self._flag_set
        else:
            flagged_set = {
                i for i, e in enumerate(idx.entries)
                if store.flagged.match_point(
                    self._zone, e["x"], e["z"]) is not None}
            self._flag_key, self._flag_set = key, flagged_set
        flagged_n = len(flagged_set)
        rows = [{"i": i, "name": e.get("n") or "",
                 "code": int(e.get("c", 0)),
                 "flagged": i in flagged_set}
                for i, e in enumerate(idx.entries)]
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
        Repopulate hero + building lists (the body is
        _refresh_body below).

        2.0.5 (Joshua's standing defect, first reported on
        2.0.2): a filter or sort change rebuilds the LIST ONLY —
        it must never close the 3D viewpoint of the building he
        is in. The rebuild clears the list store, and real GTK
        answers that by dropping the tree's selection, which
        used to read as "nothing selected" and hid the
        inspector — viewpoint gone, even when the building was
        still in the rows, and doubly so when the filter left
        it out entirely. The _rebuilding flag covers the
        rebuild: _on_select ignores the transient empty
        selection while it is set, and the body's restore step
        re-selects his building — or, when the new rows leave
        it out, leaves the viewpoint standing on it, untouched.
        """
        self._rebuilding = True
        try:
            self._refresh_body()
        finally:
            self._rebuilding = False

    def _refresh_body(self):
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
        self._total = total
        # The materialised window (normally the first ROW_CAP
        # rows; focus_building may have slid it — see _row_window).
        if self._row_window >= len(self._rows):
            self._row_window = 0
        # 2.0.5: when the selected building survived the rebuild
        # but landed outside the materialised window (a sort
        # moved it; a filter shrank the list around it), slide
        # the window onto it — the restore below can only
        # re-select a row that is actually in the store.
        if keep_index is not None:
            for pos, r in enumerate(self._rows):
                if r["i"] == keep_index:
                    if not (self._row_window <= pos
                            < self._row_window + self.ROW_CAP):
                        self._row_window = max(
                            0, pos - self.ROW_CAP // 2)
                    break
        window_rows = self._rows[
            self._row_window:self._row_window + self.ROW_CAP]
        self._shown = len(window_rows)
        for r in window_rows:
            self.store.append([r["i"], r["name"],
                               zonedata.CODE_LABELS.get(r["code"], "?"),
                               "FLAGGED" if r["flagged"] else ""])
        info = self._info_text(len(heroes))
        self.info_label.set_text(info)
        self.info_label.set_tooltip_text(info)
        # Restore the selection the clear() dropped (see above).
        if keep_index is not None:
            for pos, r in enumerate(self._rows):
                if r["i"] == keep_index \
                        and self._row_window <= pos \
                        < self._row_window + self.ROW_CAP:
                    try:
                        self.tree.get_selection().select_path(
                            Gtk.TreePath.new_from_string(
                                str(pos - self._row_window)))
                    except Exception:
                        pass
                    break

    def _info_text(self, hero_count):
        """The zone info line, from the CURRENT row set + load
        state (shared by refresh and refresh_after_zone_load)."""
        store = self._store()
        zd = self._zd()
        state = "full records loaded" if zd is not None \
            else "list only — pick a building to load its zone"
        info = (f"{self._zone}: {getattr(self, '_total', 0)} "
                f"buildings, {hero_count} hero, "
                f"{store.flagged.count(self._zone) if store else 0} "
                f"flagged in zone ({state}; showing "
                f"{getattr(self, '_shown', min(self.ROW_CAP, len(self._rows)))} "
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
        return info

    def refresh_after_zone_load(self):
        """Light refresh for a zone SPINE landing (2.0.1): the
        building rows come from the zone's light index, which a
        spine load does not change — rebuilding them walked the
        whole index (~53k rows for riverdale, measured ~0.3 s of
        UI-thread work in the middle of a selection). Only the
        HERO list (which rides the spine) and the info line's
        loaded-state text can actually change, so only those are
        redone here. Selection and scroll state are untouched."""
        store = self._store()
        zd = self._zd()
        if store is None or zd is None:
            return
        heroes = zd.hero_list()
        self.hero_store.clear()
        for hb in heroes:
            self.hero_store.append([hb.get("id") or "",
                                    hb.get("name") or "",
                                    hb.get("address") or ""])
        info = self._info_text(len(heroes))
        self.info_label.set_text(info)
        self.info_label.set_tooltip_text(info)

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
        self._row_window = 0  # a fresh list starts at the top
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
        self._row_window = 0  # a fresh list starts at the top
        self.refresh()

    # -- inspector show/hide ------------------------------------------------

    def show_inspector(self, index):
        """Open the 3D inspector on building `index` (right pane).
        The data column stays fully visible and editable.

        2.0.0: opening generates the building's SNAPSHOT first
        (store.open_snapshot — subject + neighbours, chunk-sized
        downloads only). A snapshot that cannot be generated
        (missing chunk, unreadable data) is reported in the status
        bar with the reason — loudly, never as an empty view.

        2.0.1 (Defect 1 — the select freeze): the snapshot is
        prepared ASYNCHRONOUSLY. In 2.0.0 this method ran
        open_snapshot + the inspector's roads work SYNCHRONOUSLY
        on the UI thread: the building's detail chunks and the
        zone's roads.json (~2.4 MB) downloaded through the shared
        cache and the roads were parsed + indexed right here, in
        the click — measured at 5.8 s of frozen UI for the church
        on a fast machine with a merely slow network, and several
        seconds even warm (the parse + index were rebuilt per
        click). Now a worker thread gathers everything (chunk
        downloads with the MB progress bar, the roads download,
        the once-per-zone roads parse) and the UI thread only
        APPLIES the finished snapshot when it lands. Selecting
        another building supersedes an in-flight load (the
        generation check in the completion callback); the
        superseded worker's downloads still warm the caches, so
        nothing it fetched is wasted."""
        zd = self._zd()
        store = self._store()
        if zd is None or store is None \
                or not (0 <= index < len(zd.boxes)):
            return
        self._sel_gen += 1
        gen = self._sel_gen
        zone = self._zone
        name = None
        idx_obj = store.indexes.get(zone)
        if idx_obj is not None and index < len(idx_obj.entries):
            name = idx_obj.entries[index].get("name")
        self.app_window._set_status(
            f"Loading {name or f'building #{index}'}…")
        # 2.0.2 (progress-bar law): the detail fetch is background
        # work — the corner bar pulses under the keyed "selection"
        # job from this click until the answer lands (the chunk
        # downloads inside it also report real fractions under the
        # "download" job). A superseding selection re-starts the
        # same key; only the surviving generation finishes it (see
        # done() below), and hide_inspector finishes it too.
        self.app_window.progress_start(
            "selection",
            f"Loading {name or f'building #{index}'}…")
        import threading

        def worker():
            try:
                # 2.0.8: the open-in-3D path carries a timing in
                # the suite report (editors-reporting rule).
                if reporting is not None:
                    with reporting.operation(
                            "open-in-3d", zone=zone, index=index):
                        prep = store.prepare_snapshot(zone, index)
                else:
                    prep = store.prepare_snapshot(zone, index)
                err = None
            except Exception as e:
                # ZoneDataError or a transport blowup: the reason
                # is reported verbatim in the status bar (loud,
                # never an empty view).
                prep, err = None, str(e)

            def done():
                if gen != self._sel_gen or self._zone != zone:
                    return False  # superseded — drop the result
                self.app_window._hide_progress()
                self.app_window.progress_finish("selection")
                if err is not None:
                    self.app_window._set_status(err)
                    return False
                self._apply_snapshot(prep)
                return False
            GLib.idle_add(done)

        threading.Thread(target=worker, daemon=True).start()

    def _apply_snapshot(self, prep):
        """GTK thread: show a snapshot a worker prepared (see
        show_inspector). Pure widget work — no downloads, no
        parsing — so applying can never freeze the UI."""
        zd = prep["zd"]
        index = prep["index"]
        self.inspector.show_building(
            self, zd, index, prep["flagged"],
            neighbours=prep["neighbours"],
            front_info=prep["front"],
            roads_near=prep["roads_near"])
        self.inspector.set_visible(True)
        self._position_inspector()
        GLib.idle_add(self._position_inspector_idle)
        if prep.get("roads_error"):
            # The building is shown; the missing front/backdrop
            # is named, not silently absent.
            self.app_window._set_status(
                f"Building #{index} is shown without its street "
                f"front: the roads could not be loaded "
                f"({prep['roads_error']}).")

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
        # 2.0.1: hiding also supersedes any in-flight snapshot
        # load — a late result must never reopen the panel.
        self._sel_gen += 1
        # 2.0.2: a superseded-by-hiding load will never reach its
        # done(), so its corner-bar job ends here instead.
        self.app_window.progress_finish("selection")
        if hasattr(self, "inspector"):
            self.inspector.set_visible(False)

    # -- selection ---------------------------------------------------------

    def _on_zone_changed(self, combo):
        """Switch the working zone: its list comes from its light
        index (downloading the index first if needed)."""
        if getattr(self, "_zone_reverting", False):
            return
        new_zone = combo.get_active_text() or self._zone
        # 2.0.9: switching zones closes the open building's
        # view — unapplied changes there ask first.
        if new_zone != self._zone \
                and getattr(self, "inspector", None) is not None \
                and self.inspector.get_visible() \
                and self.inspector.work_is_dirty():
            if not self.resolve_work_dirty():
                self._zone_reverting = True
                try:
                    combo.set_active(
                        zonedata.ZONES.index(self._zone))
                except Exception:
                    pass
                finally:
                    self._zone_reverting = False
                return
        self._zone = new_zone
        self._row_window = 0  # a fresh list starts at the top
        self.hide_inspector()
        self.app_window.ensure_zone_index(self._zone)
        self.refresh()

    # -- the Map Editor building jump (receiving half) --------------

    def focus_building(self, zone, index=None, at=None,
                       done=None):
        """
        Bring this tab to one building and select it — the
        receiving half of the Map Editor's building click
        (Map Editor 1.9.13; the window's _consume_building_handoff
        calls this).

        2.0.5: `done(resolved_index_or_None)`, when given, runs
        once the focus has landed (or failed) — the window uses
        it to open the resolved building's own tab.

        Switches the zone, clears the category filter and any
        column sort (rows then stand in INDEX order — the order
        the handed-over index counts in), slides the list window
        onto the building when it sits past the materialised
        rows, and selects its row: the ordinary selection path
        then fills the edit fields and opens the 3D inspector,
        downloading the zone's records first if needed — exactly
        as if the row had been clicked by hand. When the zone's
        light index is still downloading, the selection lands
        when it arrives (ensure_zone_index's done callback).

        `index` is the building's position in the zone's
        buildings.json — this list is index-aligned with that
        file, so the index names the building here. `at` (x, z)
        is the fallback identity: an index whose building no
        longer stands near `at` is distrusted (the two apps may
        hold different downloads of the zone) and the nearest
        building to `at` takes its place. Returns True when the
        focus was accepted; a building that resolves to nothing
        reports itself in the status bar and selects nothing.
        """
        if not _ZONEDATA_AVAILABLE or zone not in zonedata.ZONES:
            return False
        # Neutral list state: all categories, index order.
        self._filter_id = "all"
        try:
            self.filter_combo.set_active(0)
        except Exception:
            pass
        self._sort_key = None
        for col in self._columns.values():
            if col is not None:
                try:
                    col.set_sort_indicator(False)
                except Exception:
                    pass
        self._row_window = 0
        # Switch zone through the combo's own handler (it loads
        # the index and refreshes); if already there, just
        # refresh under the neutral state.
        zi = zonedata.ZONES.index(zone)
        if self.zone_combo.get_active() != zi:
            self.zone_combo.set_active(zi)
        else:
            self._zone = zone
            self.refresh()

        def land(ok):
            if not ok:
                self.app_window._set_status(
                    "Building jump: the "
                    f"{zone} building list could not be loaded.")
                if done:
                    done(None)
                return False
            resolved = None
            if self._zone == zone:
                resolved = self._focus_select(index, at)
            if done:
                done(resolved)
            return False

        self.app_window.ensure_zone_index(zone, done=land)
        return True

    def _focus_select(self, index, at):
        """Resolve the focused building (zone index in memory)
        and select its row through the real selection path.
        Returns the resolved index, or None when nothing was
        selected (2.0.5 — the handoff's tab opening keys off
        the RESOLVED building, position fallback included)."""
        store = self._store()
        idx = store.indexes.get(self._zone) if store else None
        if idx is None:
            return None
        entries = idx.entries
        target = index
        # An index that disagrees with the handed-over position
        # is not trusted (see focus_building's docstring).
        if target is not None and at is not None \
                and 0 <= target < len(entries):
            e = entries[target]
            if (e["x"] - at[0]) ** 2 + (e["z"] - at[1]) ** 2 \
                    > 4.0:
                target = None
        if target is None and at is not None:
            best, best_d = None, None
            for i, e in enumerate(entries):
                d = (e["x"] - at[0]) ** 2 + (e["z"] - at[1]) ** 2
                if best_d is None or d < best_d:
                    best, best_d = i, d
            if best is not None and best_d <= 4.0:
                target = best
        if target is None or not (0 <= target < len(entries)):
            self.app_window._set_status(
                "Building jump: that building could not be "
                f"found in the {self._zone} list.")
            return None
        # The row's position in the (neutral) row set, then the
        # window slide if it sits outside the materialised rows.
        pos = None
        for p, r in enumerate(self._rows):
            if r["i"] == target:
                pos = p
                break
        if pos is None:
            return None
        if not (self._row_window <= pos
                < self._row_window + self.ROW_CAP):
            self._row_window = max(0, pos - self.ROW_CAP // 2)
            self.refresh()
        path = Gtk.TreePath.new_from_string(
            str(pos - self._row_window))
        self.tree.get_selection().select_path(path)
        try:
            self.tree.scroll_to_cell(path, None, True, 0.5, 0.0)
        except Exception:
            pass
        return target

    def _on_select(self, selection):
        """
        Fill the edit fields from the selected row, and open the
        3D inspector. When the zone's full records are not loaded
        yet, the fields fill from the light index at once and the
        zone downloads (progress bar); the inspector opens when it
        lands, if the selection is still this building.
        """
        idx = self._selected_index()
        # 2.0.9: leaving a building whose working copy holds
        # unapplied changes — by selecting another, or by
        # putting it down entirely — asks first (Apply /
        # Discard / Stay). Stay puts the selection back on the
        # building still being edited. (Not during rebuilds:
        # those selection swings are the list's own
        # bookkeeping, and the 2.0.5 rule below keeps the view
        # alive through them.)
        if not getattr(self, "_rebuilding", False) \
                and not getattr(self, "_sel_reverting", False) \
                and getattr(self, "inspector", None) is not None \
                and self.inspector.get_visible() \
                and self.inspector.work_is_dirty() \
                and idx != self.inspector.index:
            if not self.resolve_work_dirty():
                self._revert_selection()
                return
        if idx is None:
            # 2.0.5: an empty selection DURING a list rebuild is
            # the rebuild's own bookkeeping (the store clear
            # dropped the selection), not the user putting the
            # building down — the viewpoint he is in survives
            # filter and sort changes, including ones that
            # filter his building out of the rows. A genuine
            # deselection outside a rebuild still closes it.
            if getattr(self, "_rebuilding", False):
                return
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

    # -- the working copy (2.0.9, Joshua's cache + Apply) ----

    def _work_for(self, idx):
        """The working copy for building `idx` when the
        inspector is open on it — the ONLY thing edits run
        against in 2.0.9 — else None."""
        panel = self.inspector
        if panel is not None and panel.mode == "building" \
                and panel.index == idx and panel.work is not None:
            return panel.work
        return None

    def _refresh_apply_ui(self):
        """The Apply button + dirty label follow the working
        copy's state (the panel calls this after every edit
        funnel lands, and the tab after Apply / Discard)."""
        dirty = False
        try:
            dirty = self.inspector.work_is_dirty()
        except Exception:
            dirty = False
        if hasattr(self, "apply_btn"):
            self.apply_btn.set_sensitive(dirty)
        if hasattr(self, "work_label"):
            self.work_label.set_text(
                "● Unapplied changes" if dirty else "")

    def _on_apply(self, _widget=None):
        """APPLY: commit the working copy into the zone and
        send it back in ONE save round trip (the standing
        verified save — push, close, re-download, show the
        proof). Until this is pressed, no edit has left the
        working copy."""
        panel = self.inspector
        idx = panel.index if panel is not None else None
        if panel is None or panel.work is None or idx is None:
            return
        if not panel.work_is_dirty():
            self.app_window._set_status(
                f"Building #{idx}: nothing to apply — it is "
                f"already as saved.")
            return
        try:
            if reporting is not None:
                with reporting.operation(
                        "apply", zone=self._zone, index=idx):
                    panel.absorb_work()
            else:
                panel.absorb_work()
        except Exception as e:
            self.app_window._set_status(str(e))
            return
        self.app_window._mark_unpublished()
        self._update_row(idx)
        self._refresh_apply_ui()
        self.app_window._set_status(
            f"Building #{idx} applied — sending it back…")
        self.app_window.round_trip_save()

    def discard_work(self):
        """Discard this tab's unapplied changes: the building
        is shown exactly as saved and the fields follow."""
        panel = self.inspector
        idx = panel.index if panel is not None else None
        if panel is None or not panel.discard_work():
            return False
        box = panel.work.boxes[0]
        self._set_spins(box[0], box[1], box[2], box[3], box[4])
        self._refresh_apply_ui()
        self.app_window._set_status(
            f"Building #{idx}: unapplied changes discarded — "
            f"it is shown as saved.")
        return True

    def resolve_work_dirty(self):
        """Ask what to do with this tab's unapplied changes —
        Apply / Discard / Stay (2.0.9). Returns True when the
        caller may proceed (applied, discarded, or nothing
        was dirty), False when Joshua chose Stay."""
        panel = self.inspector
        if panel is None or not panel.work_is_dirty():
            return True
        choice = self._run_work_dialog(panel.index)
        if choice == "apply":
            self._on_apply()
            return not panel.work_is_dirty()
        if choice == "discard":
            return self.discard_work()
        return False

    def _run_work_dialog(self, idx):
        """The Apply / Discard / Stay dialog itself (suite
        style: plain words, the consequence named)."""
        dialog = Gtk.MessageDialog(
            transient_for=self.app_window, flags=0,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.NONE,
            text=f"Unapplied changes — Building #{idx}")
        dialog.format_secondary_text(
            "You changed this building, but the changes have "
            "not been sent back yet. Apply them now, discard "
            "them, or stay and keep editing.")
        dialog.add_button("Stay", Gtk.ResponseType.CANCEL)
        dialog.add_button("Discard changes", Gtk.ResponseType.NO)
        dialog.add_button("Apply", Gtk.ResponseType.YES)
        dialog.set_default_response(Gtk.ResponseType.YES)
        resp = dialog.run()
        dialog.destroy()
        if resp == Gtk.ResponseType.YES:
            return "apply"
        if resp == Gtk.ResponseType.NO:
            return "discard"
        return "stay"

    def _revert_selection(self):
        """Put the list selection back on the building whose
        working copy is still open (a Stay answer)."""
        idx = self.inspector.index
        if idx is None:
            return
        self._sel_reverting = True
        try:
            row = next(i for i, r in enumerate(self.store)
                       if r[0] == idx)
            self.tree.get_selection().select_path(str(row))
        except Exception:
            pass
        finally:
            self._sel_reverting = False

    # -- applying edits (numbers <-> drags, one path) ------------------------

    def manip_values(self):
        """The inspector's current building as {x, z, w, d, h}
        (the panel's manipulation starting point) — read from
        the WORKING COPY (2.0.9), never the saved records."""
        idx = self.inspector.index
        work = self._work_for(idx) if idx is not None else None
        if work is None:
            return None
        box = work.boxes[0]
        return {"x": box[0], "z": box[1], "w": box[2], "d": box[3],
                "h": box[4]}

    def manip_apply(self, values):
        """Apply {x, z, w, d, h} from a 3D drag: the model changes,
        the number fields follow, the row updates — same values,
        both directions. Returns False when the edit is refused
        (flagged), so the panel ends the drag."""
        return self._apply_values(values, from_drag=True)

    def manip_angle(self):
        """The inspector building's current footprint orientation
        in degrees (2.0.6) — the panel's rotate readout starts
        from here. 2.0.9: read from the WORKING COPY's ring."""
        idx = self.inspector.index
        work = self._work_for(idx) if idx is not None else None
        if work is None:
            return None
        return zonedata.ring_orientation_deg(
            work.details[0].get("ring") or [])

    def manip_rotate(self, delta_deg):
        """One step of the panel's Shift+corner building
        rotation (2.0.6; the corner+Shift grip is 2.0.7's).
        Returns the building's new {x, z, w, d, h} for the
        panel's own bookkeeping, or None when refused (the
        panel then ends the drag). 2.0.9: turns the WORKING
        COPY; nothing is sent back until Apply."""
        store = self._store()
        idx = self.inspector.index \
            if self.inspector.get_visible() else self._selected_index()
        work = self._work_for(idx) if idx is not None else None
        if store is None or work is None:
            return None
        try:
            work.rotate(0, delta_deg, flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            return None
        self.inspector.note_work_edit()
        box = work.boxes[0]
        self._set_spins(box[0], box[1], box[2], box[3], box[4])
        # 2.0.8 batching: the status follows at drag END
        # (on_manip_end), not per motion event.
        self._drag_followup_idx = idx
        return {"x": box[0], "z": box[1], "w": box[2], "d": box[3],
                "h": box[4]}

    def manip_scale(self, factor, anchor_x, anchor_z):
        """One step of the panel's Ctrl+corner whole-size
        scale (2.0.7) — the working copy's scale about the
        fixed opposite-corner anchor (ZoneData.scale's math,
        on the copy). Returns the building's new {x, z, w, d,
        h}, or None when refused (the panel then ends the
        drag)."""
        store = self._store()
        idx = self.inspector.index \
            if self.inspector.get_visible() else self._selected_index()
        work = self._work_for(idx) if idx is not None else None
        if store is None or work is None:
            return None
        try:
            work.scale(0, factor, anchor_x, anchor_z,
                       flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            return None
        self.inspector.note_work_edit()
        box = work.boxes[0]
        self._set_spins(box[0], box[1], box[2], box[3], box[4])
        # 2.0.8 batching: status at drag end, as above.
        self._drag_followup_idx = idx
        return {"x": box[0], "z": box[1], "w": box[2], "d": box[3],
                "h": box[4]}

    def on_manip_end(self):
        """A drag finished: re-derive the inspector's front and
        backdrop at the building's new spot, and land the
        follow-up the drag batched (2.0.8): the status line
        updates ONCE here instead of on every motion event.
        2.0.9: the list row no longer follows the drag — the
        list shows what is SAVED; the row updates at Apply."""
        if self.inspector.get_visible():
            self.inspector.refresh_view()
        idx = self._drag_followup_idx
        self._drag_followup_idx = None
        if idx is not None:
            self.app_window._set_status(
                f"Building #{idx} — unapplied changes "
                f"(Apply sends them back).")

    # -- the debounced full refresh (2.0.8) ----------------------

    def _schedule_view_refresh(self):
        """Ask for ONE full view refresh shortly: repeated
        stepper steps keep pushing it out, so a run of steps
        pays for the front/backdrop re-derivation once, at the
        end — while the light refresh has already shown every
        step in the picture as it happened."""
        if self._view_refresh_source is not None:
            GLib.source_remove(self._view_refresh_source)
        self._view_refresh_source = GLib.timeout_add(
            350, self._view_refresh_due)

    def _view_refresh_due(self):
        self._view_refresh_source = None
        if self.inspector.get_visible():
            self.inspector.refresh_view()
        return False

    def _cancel_view_refresh(self):
        if self._view_refresh_source is not None:
            GLib.source_remove(self._view_refresh_source)
            self._view_refresh_source = None

    def _apply_values(self, values, from_drag=False, light=False):
        zd = self._zd()
        store = self._store()
        idx = self.inspector.index \
            if self.inspector.get_visible() else self._selected_index()
        if store is None or zd is None or idx is None \
                or idx >= len(zd.boxes):
            return False
        # 2.0.9: the edit lands on the WORKING COPY only. No
        # working copy (the building's 3D view is not open on
        # it) means no edit — the fields are a view of the
        # copy, and there is nothing truthful to edit without
        # one.
        work = self._work_for(idx)
        if work is None:
            self.app_window._set_status(
                f"Building #{idx}: open its 3D view to edit it "
                f"— edits happen on its working copy.")
            return False
        try:
            # 2.0.7 ORDER MATTERS (shape-preservation law):
            # resize FIRST (the ring scales about the standing
            # centre), move SECOND (the ring translates
            # rigidly). The composition is what anchors a
            # one-sided drag: scale-about-centre then translate
            # by the centre shift lands the un-dragged wall
            # exactly where it stood, for a ring of ANY shape —
            # and repeated drag steps telescope into the same
            # single transform. (Unchanged in 2.0.9 — the verbs
            # run on the working copy at index 0, with the
            # store's flagged index, so the flagged lock bites
            # exactly as before.)
            work.resize(0, values["w"], values["d"], values["h"],
                        flagged=store.flagged)
            work.move(0, values["x"], values["z"],
                      flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            # Restore the fields to the copy's (unchanged)
            # values.
            box = work.boxes[0]
            self._set_spins(box[0], box[1], box[2], box[3], box[4])
            return False
        self.inspector.note_work_edit()
        self._set_spins(values["x"], values["z"], values["w"],
                        values["d"], values["h"])
        # 2.0.8 batching (the speed pass; ZoneBuildingTab's
        # _apply_values carries the full note): drags defer the
        # status to on_manip_end; the stepper path takes the
        # light refresh + debounce; a full apply refreshes
        # everything at once, as before. 2.0.9: the list row
        # follows at APPLY, not here — the list shows what is
        # saved, and nothing is saved yet.
        if from_drag:
            self._drag_followup_idx = idx
            return True
        if self.inspector.get_visible() \
                and self.inspector.index == idx:
            if light:
                self.inspector.refresh_view_light()
                self._schedule_view_refresh()
            else:
                self._cancel_view_refresh()
                self.inspector.refresh_view()
        self.app_window._set_status(
            f"Building #{idx} — unapplied changes "
            f"(Apply sends them back).")
        return True

    def _field_values(self):
        return {
            "x": self.mx.get_value(), "z": self.mz.get_value(),
            "w": self.mw.get_value(), "d": self.md.get_value(),
            "h": self.mh.get_value()}

    def _on_spin_changed(self):
        """Typing a number applies it at once (1.7.2 two-way
        sizing) — unless the fields are being filled by code.
        2.0.8: the light apply — the view adjusts in step
        without a full scene re-derivation per step."""
        if self._spins_loading:
            return
        idx = self._selected_index()
        zd = self._zd()
        if idx is None or zd is None:
            return
        self._apply_values(self._field_values(), light=True)

    def _on_move_resize(self, widget):
        """Move + resize the selected building from the fields
        (the same apply path as typing and dragging) — a
        deliberate full apply: everything refreshes at once."""
        if self._spins_loading:
            return
        idx = self._selected_index()
        zd = self._zd()
        if idx is None or zd is None:
            return
        if reporting is not None:
            with reporting.operation("move-resize",
                                     zone=self._zone, index=idx):
                self._apply_values(self._field_values())
        else:
            self._apply_values(self._field_values())

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
        # 2.0.9: deleting the very building whose working copy
        # holds unapplied changes asks about them first —
        # they are never silently dropped with it.
        if getattr(self, "inspector", None) is not None \
                and self.inspector.get_visible() \
                and self.inspector.index == idx \
                and self.inspector.work_is_dirty():
            if not self.resolve_work_dirty():
                return
            # Applied (then deleted below) or discarded: the
            # copy's story is settled either way.
            self.inspector.clear_work()
        try:
            zd.delete(idx, flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            return
        self.app_window._mark_unpublished()
        self.hide_inspector()
        self.refresh()
        self.app_window._set_status(f"Building #{idx} deleted (unsaved).")

    def _on_detail_edit(self, widget):
        """Detail Edit: the window answers — 2.0.8 interim
        honesty: the Detail Editor takes roads only, so it
        says so plainly and sends nothing."""
        idx = self._selected_index()
        if idx is None:
            self.app_window._set_status(
                "Detail Edit: select a building first.")
            return
        self.app_window.open_in_detail_editor(self._zone, idx)


# ---------------------------------------------------------------------------
# One zone building in its own tab (2.0.5)
# ---------------------------------------------------------------------------

class ZoneBuildingTab(Gtk.Box):
    """
    A single zone building in its own notebook tab (2.0.5).

    Born from Joshua's hands-on proof of the Map Editor
    building jump (2026-10-25): 2.0.4's receiver selected the
    handed-over building in the Zone Buildings list and opened
    its inspector there, but he was still "under the first
    panel" — the jump must land him IN the building, in a tab
    of its own, the way opening a design building from the
    list lands in that building's tab. The window's
    open_zone_building_tab manages these exactly like the
    design tabs (dedupe, × close, append -> show -> front).

    The tab hosts its own ZoneInspectorPanel — the same 3D
    viewpoint the Zone tab shows, with the same manipulation
    (2.0.7's model: roof = height, front face = depth, side
    face = width, corner = move, corner+Shift = rotate,
    corner+Ctrl = whole-size scale) applied to the same
    shared ZoneData, so
    an edit made here is the zone's edit (the Zone tab's list
    row follows via _update_row). Loading mirrors the Zone
    tab's selection path: the zone spine first if needed,
    then the building's snapshot prepared on a worker thread
    and applied on the UI thread — never a UI-thread download.

    The viewpoint in this tab is the tab's own state: it is
    not driven by the Zone list's selection, so list filters
    and sorts over there can never close it (the companion
    2.0.5 fix in ZoneBuildingsTab.refresh/_on_select covers
    the Zone tab's own inspector the same way).

    2.0.6 (Joshua's hands-on verdict on 2.0.5, 2026-10-25
    23:37): the tab above was a VIEWER — the 3D viewpoint and
    nothing else. He could not change the width or the depth,
    could not change the height, and there was no Detail
    button: "it's not the proper tab for editing." He was
    right — the manual editing path for a zone building (the
    Zone Buildings tab's selection state) pairs the viewpoint
    with the spelled-out number fields (X / Z / Width / Depth
    / Height, typing applies at once), Move / Resize and
    Delete, all through the one zonedata apply path. This tab
    now carries THAT full control set under its viewpoint —
    the same fields with the same labels and ranges, the same
    apply path (this class's _apply_values already ran the
    Zone tab's move/resize calls; the fields now sync through
    it both ways, exactly as the manual path's do) — plus the
    Detail Edit door (2.0.6). The BuildingTab class is NOT
    the manual path for these buildings and is not used here:
    it edits the design-stock dicts (windows, doors, fences —
    a different data kind with a different save); a zone
    record is a bare [x, z, w, d, h, type] box whose edits
    belong to zonedata and the window's round trip.
    """

    def __init__(self, window, zone, index):
        super().__init__(orientation=Gtk.Orientation.VERTICAL,
                         spacing=4)
        self.set_border_width(6)
        self.app_window = window
        self.zone = zone
        self.index = index
        # Snapshot-load generation, same discipline as the Zone
        # tab's: a superseded (or view-closed) load never lands.
        self._sel_gen = 0
        self._view_refresh_source = None
        self._drag_followup_idx = None
        # 2.0.8 layout (Joshua, Oct 28): the viewpoint and its
        # "Edit this building" controls sit SIDE BY SIDE — the
        # controls in a collapsible side panel (the suite's
        # collapsible pattern, the Map Editor's inspector
        # strip), NOT in a strip across the bottom. The old
        # bottom strip sat under a non-scrolling info column,
        # so at laptop window heights part of it was simply
        # unreachable; the side panel scrolls vertically, and
        # the divider is his to drag (EDITOR UI RULE).
        self._paned = Gtk.Paned(
            orientation=Gtk.Orientation.HORIZONTAL)
        view_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                           spacing=4)
        self.inspector = ZoneInspectorPanel(self)
        self.inspector.set_visible(False)
        view_box.pack_start(self.inspector, True, True, 0)
        # Shown only when the panel's ✕ has closed the view:
        # the tab stays, the view reopens from here.
        self.closed_box = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.closed_box.set_no_show_all(True)
        closed_label = Gtk.Label(
            label="The 3D view is closed for this building.")
        closed_label.set_halign(Gtk.Align.START)
        self.closed_box.pack_start(closed_label, False, False, 0)
        reopen_btn = Gtk.Button(label="Reopen the 3D view")
        reopen_btn.set_halign(Gtk.Align.START)
        reopen_btn.connect("clicked", lambda w: self.show_building())
        self.closed_box.pack_start(reopen_btn, False, False, 0)
        self.closed_box.hide()
        view_box.pack_start(self.closed_box, True, True, 0)
        self._paned.pack1(view_box, resize=True, shrink=False)

        # --- the manual path's edit controls, as a side panel --
        # The Zone Buildings tab's "Edit selected building"
        # fields, with the same spelled-out labels and ranges,
        # stacked vertically in the side panel: typing a number
        # applies it at once through the same apply path the
        # drag handles use — plus Move / Resize, Delete, and
        # Detail Edit. The fields stay disabled until the
        # building's snapshot lands (there is nothing truthful
        # to show before then); _apply_snapshot fills and
        # enables them.
        self._spins_loading = False    # programmatic-fill guard
        edit_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                           spacing=4)
        edit_lbl = Gtk.Label()
        edit_lbl.set_markup(
            "<b>Edit this building</b>\n"
            "(typing applies at once to the preview —\n"
            "Apply sends it back)")
        edit_lbl.set_halign(Gtk.Align.START)
        edit_box.pack_start(edit_lbl, False, False, 2)
        self.mx = Gtk.SpinButton.new_with_range(-30000, 30000, 1)
        self.mz = Gtk.SpinButton.new_with_range(-30000, 30000, 1)
        self.mw = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.md = Gtk.SpinButton.new_with_range(1, 1000, 1)
        self.mh = Gtk.SpinButton.new_with_range(1, 200, 1)
        for label, spin in (
                ("East–West position (X)", self.mx),
                ("North–South position (Z)", self.mz),
                ("Width (W)", self.mw),
                ("Depth (D)", self.md),
                ("Height (H)", self.mh)):
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                          spacing=4)
            lbl = Gtk.Label(label=label)
            lbl.set_halign(Gtk.Align.START)
            row.pack_start(lbl, True, True, 0)
            row.pack_start(spin, False, False, 0)
            edit_box.pack_start(row, False, False, 0)
            spin.connect("value-changed",
                         lambda s: self._on_spin_changed())
        # Rotation (2.0.6, Joshua): the footprint's orientation,
        # exactly as the Zone tab's field — filled from the ring
        # by _sync_rot_field; typing turns the building to it.
        rot_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                          spacing=4)
        rot_lbl = Gtk.Label(label="Rotation (°)")
        rot_lbl.set_halign(Gtk.Align.START)
        rot_row.pack_start(rot_lbl, True, True, 0)
        self.mrot = Gtk.SpinButton.new_with_range(0, 180, 1)
        self.mrot.set_digits(0)
        self.mrot.connect("value-changed", self._on_rot_changed)
        rot_row.pack_start(self.mrot, False, False, 0)
        edit_box.pack_start(rot_row, False, False, 0)
        move_btn = Gtk.Button(label="Move / Resize")
        move_btn.connect("clicked", self._on_move_resize)
        edit_box.pack_start(move_btn, False, False, 2)
        # APPLY (2.0.9, Joshua's cache + Apply model): edits
        # live on this building's working copy until this
        # button sends the finished copy back in one save
        # round trip. The label under it is the dirty state,
        # spelled out.
        self.apply_btn = Gtk.Button(label="Apply")
        self.apply_btn.get_style_context().add_class(
            "suggested-action")
        self.apply_btn.set_tooltip_text(
            "Send the finished changes back in one save")
        self.apply_btn.connect("clicked", self._on_apply)
        self.apply_btn.set_sensitive(False)
        edit_box.pack_start(self.apply_btn, False, False, 2)
        self.work_label = Gtk.Label(label="")
        self.work_label.set_halign(Gtk.Align.START)
        edit_box.pack_start(self.work_label, False, False, 0)
        del_btn = Gtk.Button(label="Delete")
        del_btn.connect("clicked", self._on_delete)
        edit_box.pack_start(del_btn, False, False, 0)
        # The Detail Edit door. 2.0.8 interim honesty: the
        # Detail Editor takes roads only, so the window says so
        # plainly and sends nothing (open_in_detail_editor).
        detail_btn = Gtk.Button(label="Detail Edit")
        detail_btn.set_tooltip_text(
            "The Detail Editor works on roads — buildings "
            "aren't supported there yet")
        detail_btn.connect("clicked", self._on_detail_edit)
        edit_box.pack_start(detail_btn, False, False, 0)
        self.detail_btn = detail_btn
        # The panel scrolls vertically: every control stays
        # reachable however short the window gets.
        side_scroll = Gtk.ScrolledWindow()
        side_scroll.set_policy(Gtk.PolicyType.NEVER,
                               Gtk.PolicyType.AUTOMATIC)
        side_scroll.set_shadow_type(Gtk.ShadowType.NONE)
        side_scroll.set_min_content_width(216)
        side_scroll.add(edit_box)
        self.edit_scroll = side_scroll
        edit_box.set_sensitive(False)
        self.edit_box = edit_box
        # Collapse strip on the panel's left edge (the Map
        # Editor's inspector pattern): the strip stays visible
        # when collapsed so the panel can be brought back.
        side_wrap = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        self.edit_toggle = Gtk.Button(label="◀")
        self.edit_toggle.set_tooltip_text("Hide the edit panel")
        self.edit_toggle.set_relief(Gtk.ReliefStyle.NONE)
        self.edit_toggle.set_size_request(26, -1)
        self.edit_toggle.connect("clicked", self._toggle_edit_panel)
        self.edit_collapsed = False
        side_wrap.pack_start(self.edit_toggle, False, False, 0)
        side_wrap.pack_start(side_scroll, True, True, 0)
        self._side_scroll = side_scroll
        self._paned.pack2(side_wrap, resize=False, shrink=True)
        self.pack_start(self._paned, True, True, 0)
        GLib.idle_add(self._position_side_paned)

    def _position_side_paned(self):
        """First layout: give the side panel its working width
        (the divider stays Joshua's to drag afterwards)."""
        try:
            alloc = self._paned.get_allocated_width()
            if alloc and alloc > 420:
                self._paned.set_position(alloc - 268)
        except Exception:
            pass
        return False

    def _toggle_edit_panel(self, _widget=None):
        """Collapse/expand the side edit panel (the strip stays
        visible either way)."""
        self.edit_collapsed = not self.edit_collapsed
        if self.edit_collapsed:
            self._side_scroll.hide()
            self.edit_toggle.set_label("▶")
            self.edit_toggle.set_tooltip_text(
                "Show the edit panel")
        else:
            self._side_scroll.show()
            self.edit_toggle.set_label("◀")
            self.edit_toggle.set_tooltip_text(
                "Hide the edit panel")

    # -- data ----------------------------------------------------

    def _store(self):
        return self.app_window.zone_store

    def _zd(self):
        """This tab's zone FULL ZoneData, or None while only
        its light index is loaded (mirrors ZoneBuildingsTab)."""
        store = self._store()
        return store.zones.get(self.zone) if store else None

    # -- opening ---------------------------------------------------

    def begin(self):
        """Load what the view needs, then show the building:
        the zone spine first when it is not in memory yet."""
        if self._zd() is not None:
            self.show_building()
            return
        self.app_window._set_status(
            f"Loading building #{self.index} ({self.zone})…")

        def done(ok):
            if ok:
                self.show_building()
            else:
                self.app_window._set_status(
                    "Building tab: the "
                    f"{self.zone} records could not be loaded.")
            return False
        self.app_window.ensure_zone_detail(self.zone, done=done)

    def show_building(self):
        """
        (Re)open the 3D view on this tab's building — the same
        async snapshot path the Zone tab's selection uses
        (show_inspector there): a worker thread prepares the
        snapshot through the store, the UI thread only applies
        it. A load superseded by a newer one, or by the view
        being closed, is dropped.
        """
        store = self._store()
        zd = self._zd()
        if store is None or zd is None \
                or not (0 <= self.index < len(zd.boxes)):
            return
        self._sel_gen += 1
        gen = self._sel_gen
        zone, index = self.zone, self.index
        # The detail fetch is background work — the corner bar
        # runs under the same keyed job the Zone tab uses.
        self.app_window.progress_start(
            "selection", f"Loading building #{index}…")
        import threading

        def worker():
            try:
                # 2.0.8: timed for the suite report, as in the
                # Zone tab's snapshot worker.
                if reporting is not None:
                    with reporting.operation(
                            "open-in-3d", zone=zone, index=index):
                        prep = store.prepare_snapshot(zone, index)
                else:
                    prep = store.prepare_snapshot(zone, index)
                err = None
            except Exception as e:
                prep, err = None, str(e)

            def done():
                if gen != self._sel_gen:
                    return False  # superseded — drop the result
                self.app_window._hide_progress()
                self.app_window.progress_finish("selection")
                if err is not None:
                    self.app_window._set_status(err)
                    return False
                self._apply_snapshot(prep)
                return False
            GLib.idle_add(done)

        threading.Thread(target=worker, daemon=True).start()

    def _apply_snapshot(self, prep):
        """GTK thread: show a prepared snapshot (see
        show_building). Pure widget work."""
        self.closed_box.hide()
        self.inspector.show_building(
            self, prep["zd"], prep["index"], prep["flagged"],
            neighbours=prep["neighbours"],
            front_info=prep["front"],
            roads_near=prep["roads_near"])
        self.inspector.set_visible(True)
        # 2.0.6: the edit fields come alive with the building —
        # filled from its record, then live (see __init__).
        box = prep["zd"].boxes[prep["index"]]
        self._set_spins(box[0], box[1], box[2], box[3], box[4])
        self.edit_box.set_sensitive(True)
        if prep.get("roads_error"):
            self.app_window._set_status(
                f"Building #{prep['index']} is shown without its "
                f"street front: the roads could not be loaded "
                f"({prep['roads_error']}).")

    def hide_inspector(self):
        """Close this tab's 3D view (the panel's ✕). The tab
        itself stays — its whole point is keeping the building
        in front of Joshua; the reopen button takes the ✕'s
        place until the view is wanted again."""
        self._sel_gen += 1
        self.app_window.progress_finish("selection")
        if hasattr(self, "inspector"):
            self.inspector.set_visible(False)
        self.closed_box.show_all()

    # -- manipulation (the inspector panel's owner interface) ------

    # -- the working copy (2.0.9, Joshua's cache + Apply) ----

    def _work_for(self, idx):
        """The working copy for this tab's building when the
        inspector is open on it — the ONLY thing edits run
        against in 2.0.9 — else None."""
        panel = self.inspector
        if panel is not None and panel.mode == "building" \
                and panel.index == idx and panel.work is not None:
            return panel.work
        return None

    def _refresh_apply_ui(self):
        """The Apply button + dirty label follow the working
        copy's state."""
        dirty = False
        try:
            dirty = self.inspector.work_is_dirty()
        except Exception:
            dirty = False
        if hasattr(self, "apply_btn"):
            self.apply_btn.set_sensitive(dirty)
        if hasattr(self, "work_label"):
            self.work_label.set_text(
                "● Unapplied changes" if dirty else "")

    def _on_apply(self, _widget=None):
        """APPLY: commit the working copy into the zone and
        send it back in ONE save round trip (the standing
        verified save). Until this is pressed, no edit has
        left the working copy."""
        panel = self.inspector
        idx = self.index
        if panel is None or panel.work is None:
            return
        if not panel.work_is_dirty():
            self.app_window._set_status(
                f"Building #{idx}: nothing to apply — it is "
                f"already as saved.")
            return
        try:
            if reporting is not None:
                with reporting.operation(
                        "apply", zone=self.zone, index=idx):
                    panel.absorb_work()
            else:
                panel.absorb_work()
        except Exception as e:
            self.app_window._set_status(str(e))
            return
        self.app_window._mark_unpublished()
        self._update_zone_row(idx)
        self._refresh_apply_ui()
        self.app_window._set_status(
            f"Building #{idx} applied — sending it back…")
        self.app_window.round_trip_save()

    def discard_work(self):
        """Discard this tab's unapplied changes: the building
        is shown exactly as saved and the fields follow."""
        panel = self.inspector
        if panel is None or not panel.discard_work():
            return False
        box = panel.work.boxes[0]
        self._set_spins(box[0], box[1], box[2], box[3], box[4])
        self._refresh_apply_ui()
        self.app_window._set_status(
            f"Building #{self.index}: unapplied changes "
            f"discarded — it is shown as saved.")
        return True

    def resolve_work_dirty(self):
        """Ask what to do with this tab's unapplied changes —
        Apply / Discard / Stay (2.0.9). Returns True when the
        caller may proceed, False when Joshua chose Stay."""
        panel = self.inspector
        if panel is None or not panel.work_is_dirty():
            return True
        choice = self._run_work_dialog(panel.index)
        if choice == "apply":
            self._on_apply()
            return not panel.work_is_dirty()
        if choice == "discard":
            return self.discard_work()
        return False

    def _run_work_dialog(self, idx):
        """The Apply / Discard / Stay dialog itself."""
        dialog = Gtk.MessageDialog(
            transient_for=self.app_window, flags=0,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.NONE,
            text=f"Unapplied changes — Building #{idx}")
        dialog.format_secondary_text(
            "You changed this building, but the changes have "
            "not been sent back yet. Apply them now, discard "
            "them, or stay and keep editing.")
        dialog.add_button("Stay", Gtk.ResponseType.CANCEL)
        dialog.add_button("Discard changes", Gtk.ResponseType.NO)
        dialog.add_button("Apply", Gtk.ResponseType.YES)
        dialog.set_default_response(Gtk.ResponseType.YES)
        resp = dialog.run()
        dialog.destroy()
        if resp == Gtk.ResponseType.YES:
            return "apply"
        if resp == Gtk.ResponseType.NO:
            return "discard"
        return "stay"

    def manip_values(self):
        """The viewed building as {x, z, w, d, h} (the panel's
        manipulation starting point) — read from the WORKING
        COPY (2.0.9), never the saved records."""
        idx = self.inspector.index
        work = self._work_for(idx) if idx is not None else None
        if work is None:
            return None
        box = work.boxes[0]
        return {"x": box[0], "z": box[1], "w": box[2],
                "d": box[3], "h": box[4]}

    def manip_apply(self, values):
        """Apply {x, z, w, d, h} from a 3D drag. Returns False
        when the edit is refused (flagged), so the panel ends
        the drag."""
        return self._apply_values(values, from_drag=True)

    def manip_angle(self):
        """The viewed building's current footprint orientation
        in degrees (2.0.6) — the panel's rotate readout starts
        from here. 2.0.9: read from the WORKING COPY's ring."""
        idx = self.inspector.index
        work = self._work_for(idx) if idx is not None else None
        if work is None:
            return None
        return zonedata.ring_orientation_deg(
            work.details[0].get("ring") or [])

    def manip_rotate(self, delta_deg):
        """One step of the panel's Shift+corner building
        rotation (2.0.6; the corner+Shift grip is 2.0.7's) —
        the same discipline as _apply_values. 2.0.9: turns the
        WORKING COPY; this tab's fields follow at once, the
        Zone tab's row follows at Apply. Returns the new
        {x, z, w, d, h} or None when refused."""
        store = self._store()
        idx = self.inspector.index \
            if self.inspector.get_visible() else self.index
        work = self._work_for(idx) if idx is not None else None
        if store is None or work is None:
            return None
        try:
            work.rotate(0, delta_deg, flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            return None
        self.inspector.note_work_edit()
        box = work.boxes[0]
        self._set_spins(box[0], box[1], box[2], box[3], box[4])
        # 2.0.8 batching: the status follows at drag END
        # (on_manip_end), not per motion event.
        self._drag_followup_idx = idx
        return {"x": box[0], "z": box[1], "w": box[2],
                "d": box[3], "h": box[4]}

    def manip_scale(self, factor, anchor_x, anchor_z):
        """One step of the panel's Ctrl+corner whole-size
        scale (2.0.7) — the same discipline as manip_rotate:
        the working copy scales about the fixed
        opposite-corner anchor. Returns the new {x, z, w, d,
        h} or None when refused."""
        store = self._store()
        idx = self.inspector.index \
            if self.inspector.get_visible() else self.index
        work = self._work_for(idx) if idx is not None else None
        if store is None or work is None:
            return None
        try:
            work.scale(0, factor, anchor_x, anchor_z,
                       flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            return None
        self.inspector.note_work_edit()
        box = work.boxes[0]
        self._set_spins(box[0], box[1], box[2], box[3], box[4])
        # 2.0.8 batching: status at drag end, as above.
        self._drag_followup_idx = idx
        return {"x": box[0], "z": box[1], "w": box[2],
                "d": box[3], "h": box[4]}

    def _update_zone_row(self, idx):
        """Refresh the Zone tab's list row for this building
        (when that tab is showing this zone)."""
        zone_tab = self.app_window.zone_tab
        if zone_tab is not None and zone_tab._zone == self.zone:
            try:
                zone_tab._update_row(idx)
            except Exception:
                pass

    def on_manip_end(self):
        """A drag finished: re-derive the view's front and
        backdrop at the building's new spot, and land the
        follow-up the drag batched (2.0.8): the status line
        updates ONCE here instead of on every motion event.
        2.0.9: the Zone tab's row follows at APPLY — the list
        shows what is saved."""
        if self.inspector.get_visible():
            self.inspector.refresh_view()
        idx = self._drag_followup_idx
        self._drag_followup_idx = None
        if idx is not None:
            self.app_window._set_status(
                f"Building #{idx} — unapplied changes "
                f"(Apply sends them back).")

    # -- the debounced full refresh (2.0.8) ----------------------

    def _schedule_view_refresh(self):
        """Ask for ONE full view refresh shortly: repeated
        stepper steps keep pushing it out, so a run of steps
        pays for the front/backdrop re-derivation once, at the
        end — while the light refresh has already shown every
        step in the picture as it happened."""
        if self._view_refresh_source is not None:
            GLib.source_remove(self._view_refresh_source)
        self._view_refresh_source = GLib.timeout_add(
            350, self._view_refresh_due)

    def _view_refresh_due(self):
        self._view_refresh_source = None
        if self.inspector.get_visible():
            self.inspector.refresh_view()
        return False

    def _cancel_view_refresh(self):
        if self._view_refresh_source is not None:
            GLib.source_remove(self._view_refresh_source)
            self._view_refresh_source = None

    def _set_spins(self, x, z, w, d, h):
        """Fill the edit fields WITHOUT triggering live-apply
        (the manual path's guard, carried across)."""
        self._spins_loading = True
        try:
            self.mx.set_value(x); self.mz.set_value(z)
            self.mw.set_value(w); self.md.set_value(d)
            self.mh.set_value(h)
        finally:
            self._spins_loading = False
        # 2.0.6: the Rotation field follows every fill.
        self._sync_rot_field()

    def _sync_rot_field(self):
        """Show this building's footprint orientation in the
        Rotation field (2.0.6) — a code fill under the same
        guard discipline as the Zone tab's."""
        if not hasattr(self, "mrot"):
            return
        zd = self._zd()
        idx = self.inspector.index \
            if getattr(self, "inspector", None) is not None \
            and self.inspector.get_visible() else self.index
        if zd is None or idx is None or idx >= len(zd.boxes):
            return
        # 2.0.9: while the building is open, the field shows
        # the WORKING COPY's orientation.
        work = self._work_for(idx)
        ring = (work.details[0].get("ring") if work is not None
                else zd.details[idx].get("ring")) or []
        if not ring:
            return
        prev = self._spins_loading
        self._spins_loading = True
        try:
            self.mrot.set_value(zonedata.ring_orientation_deg(ring))
        finally:
            self._spins_loading = prev

    def _on_rot_changed(self, _spin=None):
        """Typing an angle turns this building to it at once —
        the Rotation field's twin of _on_spin_changed.
        2.0.9: it turns the WORKING COPY; Apply sends it back."""
        if self._spins_loading:
            return
        store = self._store()
        zd = self._zd()
        if store is None or zd is None \
                or self.index >= len(zd.boxes):
            return
        work = self._work_for(self.index)
        if work is None:
            self._sync_rot_field()
            return
        try:
            turned = work.rotate_to(0,
                                    self.mrot.get_value(),
                                    flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            self._sync_rot_field()
            return
        if not turned:
            return
        self.inspector.note_work_edit()
        box = work.boxes[0]
        self._set_spins(box[0], box[1], box[2], box[3], box[4])
        if self.inspector.get_visible() \
                and self.inspector.index == self.index:
            # 2.0.8 (Joshua, Oct 28, live report): a rotation
            # STEP must turn the building in the viewport on
            # the step itself — degrees and picture moving
            # together. The light refresh redraws the footprint
            # from the live, just-rotated record at once; the
            # debounced full refresh re-derives the front
            # marking a beat later. He does NOT have to press
            # Move / Resize first: that button is a full apply
            # of the number fields, never a door the steppers
            # wait behind.
            self.inspector.refresh_view_light()
            self._schedule_view_refresh()
        self.app_window._set_status(
            f"Building #{self.index} rotated in the preview "
            f"— unapplied (Apply sends it back).")

    def _apply_values(self, values, from_drag=False, light=False):
        """The Zone tab's apply path: the model changes in the
        shared ZoneData, this tab's number fields follow (2.0.6
        — synced both ways, as the manual path's are), the Zone
        tab's row for this building follows, the view refreshes.

        2.0.8 batching (the speed pass): a DRAG apply defers
        the Zone-row update and the status line to drag end
        (on_manip_end) instead of paying them per motion
        event. A LIGHT apply (the stepper path) refreshes only
        values + picture — the picture draws the subject from
        the live records, so the step shows at once — and the
        full front/backdrop re-derivation follows on the
        debounce; a full apply (Move / Resize, drags' ends)
        refreshes everything immediately, as before."""
        store = self._store()
        zd = self._zd()
        idx = self.inspector.index \
            if self.inspector.get_visible() else self.index
        if store is None or zd is None or idx is None \
                or idx >= len(zd.boxes):
            return False
        # 2.0.9: the edit lands on the WORKING COPY only (see
        # the Zone tab's _apply_values for the full note).
        work = self._work_for(idx)
        if work is None:
            self.app_window._set_status(
                f"Building #{idx}: open its 3D view to edit it "
                f"— edits happen on its working copy.")
            return False
        try:
            # 2.0.7: resize FIRST, move SECOND — the same
            # shape-preserving composition as the Zone tab's
            # _apply_values (see its note).
            work.resize(0, values["w"], values["d"], values["h"],
                        flagged=store.flagged)
            work.move(0, values["x"], values["z"],
                      flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            # Restore the fields to the copy's (unchanged)
            # values, as the manual path does on a refused edit.
            box = work.boxes[0]
            self._set_spins(box[0], box[1], box[2], box[3], box[4])
            return False
        self.inspector.note_work_edit()
        self._set_spins(values["x"], values["z"], values["w"],
                        values["d"], values["h"])
        if from_drag:
            self._drag_followup_idx = idx
            return True
        if self.inspector.get_visible() \
                and self.inspector.index == idx:
            if light:
                self.inspector.refresh_view_light()
                self._schedule_view_refresh()
            else:
                self._cancel_view_refresh()
                self.inspector.refresh_view()
        self.app_window._set_status(
            f"Building #{idx} — unapplied changes "
            f"(Apply sends them back).")
        return True

    # -- the edit fields (2.0.6: the manual path's controls) -------

    def _field_values(self):
        return {
            "x": self.mx.get_value(), "z": self.mz.get_value(),
            "w": self.mw.get_value(), "d": self.md.get_value(),
            "h": self.mh.get_value()}

    def _on_spin_changed(self):
        """Typing a number applies it at once (the manual path's
        rule) — unless the fields are being filled by code.
        2.0.8: the light apply — the view adjusts in step (the
        two-way sizing rule) without a full scene re-derivation
        per step."""
        if self._spins_loading:
            return
        zd = self._zd()
        if zd is None or self.index >= len(zd.boxes):
            return
        self._apply_values(self._field_values(), light=True)

    def _on_move_resize(self, widget):
        """Move + resize this building from the fields (the same
        apply path as typing and dragging) — a deliberate full
        apply: everything refreshes at once."""
        if self._spins_loading:
            return
        zd = self._zd()
        if zd is None or self.index >= len(zd.boxes):
            return
        if reporting is not None:
            with reporting.operation("move-resize",
                                     zone=self.zone,
                                     index=self.index):
                self._apply_values(self._field_values())
        else:
            self._apply_values(self._field_values())

    def _on_delete(self, widget):
        """Delete this tab's building — the manual path's
        Delete: the same zonedata call, the same flagged lock.
        On success the tab closes (the building is gone) and
        the Zone tab's list is rebuilt when it shows this zone,
        so no view is left pointing at shifted indices."""
        store = self._store()
        zd = self._zd()
        if store is None or zd is None:
            return
        idx = self.index
        # 2.0.9: unapplied changes on this very building ask
        # first — they are never silently dropped with it.
        if self.inspector.work_is_dirty():
            if not self.resolve_work_dirty():
                return
            self.inspector.clear_work()
        try:
            zd.delete(idx, flagged=store.flagged)
        except Exception as e:
            self.app_window._set_status(str(e))
            return
        self.app_window._mark_unpublished()
        zone_tab = self.app_window.zone_tab
        if zone_tab is not None and zone_tab._zone == self.zone:
            zone_tab.hide_inspector()
            zone_tab.refresh()
        self.app_window.close_tab(self)
        self.app_window._set_status(
            f"Building #{idx} deleted (unsaved).")

    def _on_detail_edit(self, widget):
        """Detail Edit: the window answers — 2.0.8 interim
        honesty: the Detail Editor takes roads only, so it
        says so plainly and sends nothing."""
        self.app_window.open_in_detail_editor(self.zone, self.index)


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
        # 2.0.1: open-in-3D generation — a newer station (or a
        # newer open request) supersedes an in-flight roads prep.
        self._open_gen = 0
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
        # 2.0.1 (Defect 2): the station list's divider gets its
        # designed opening share too — same unpositioned-divider
        # bug as the Zone tab's: the list keeps at least half the
        # column; the details below get their natural height, at
        # most half.
        paned_opening_share(self.vpaned, first_min_share=0.50,
                            second_min_px=140, second_max_share=0.50)

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
        # 2.0.1: changing the station supersedes any in-flight
        # open-in-3D preparation for the previous one.
        self._open_gen += 1
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

    def _reselect_station(self, sid):
        """Re-select station `sid`'s row after a list rebuild
        (2.0.1 fix). refresh_list() clears and re-appends the
        Gtk model, which clears the tree's selection as a side
        effect — and the selection handler answers by setting
        _current to None. In 2.0.0, _on_make_editable then read
        _current for its status line and CRASHED (AttributeError,
        printed to stderr; the app carried on with the station
        deselected and "Open in 3D view" greyed out again, so
        the flow the status line describes could not be followed
        without re-selecting the station by hand). The rebuild's
        row order is stable, so the station's row is found by its
        stationIndex (the model's hidden last column) and
        selected again, restoring _current and the controls."""
        if sid is None:
            return
        for row in self.store:
            if row[6] == sid:
                self.tree.get_selection().select_path(row.path)
                return

    def _on_make_editable(self, _widget):
        """Flip the selected station to editable (Joshua's
        per-station choice; the default is review-only)."""
        if self._current is None or self.edits is None:
            return
        sid = self._current.get("stationIndex")
        name = self._current.get("name") or "Station"
        self.edits.set_edit(sid, editable=True)
        self.app_window._mark_unpublished()
        self._refresh_controls()
        self.refresh_list()
        # The rebuild deselected the station (see
        # _reselect_station) — put the selection back so the
        # station stays current and the 3D button stays live.
        self._reselect_station(sid)
        self.app_window._set_status(
            f"{name} is now "
            f"editable — open it in the 3D view to adjust it. "
            f"(Unsaved until the next save.)")

    def _on_unedit(self, _widget):
        """Back to review-only (the station's saved edit values are
        kept in the overlay, but it no longer opens for editing)."""
        if self._current is None or self.edits is None:
            return
        sid = self._current.get("stationIndex")
        self.edits.set_edit(sid, editable=False)
        self.app_window._mark_unpublished()
        self.hide_inspector()
        self._refresh_controls()
        self.refresh_list()
        self._reselect_station(sid)
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
        roads backdrop; without them the station still opens.

        2.0.1: the zone's roads view (download + parse + index)
        is prepared on a WORKER thread before the panel opens —
        in 2.0.0, show_station did that work synchronously in
        this click (the same select-freeze mechanism as the
        buildings list). A newer station selection supersedes an
        in-flight preparation (generation check)."""
        if self._current is None:
            return
        station = self._current
        zone = station.get("zone")
        self._open_gen += 1
        gen = self._open_gen
        # 2.0.2 (progress-bar law): preparing the station's view
        # is background work — the corner bar pulses under the
        # keyed "selection" job until the panel shows (show()
        # finishes it; a superseding open re-starts the same key).
        self.app_window.progress_start("selection",
                                       "Loading station…")

        def show(zd):
            if gen != self._open_gen or self._current is not station:
                return  # superseded while preparing
            self.app_window.progress_finish("selection")
            self.inspector.show_station(
                self, station, self._edit(), zd)
            self.inspector.set_visible(True)
            self._position_inspector()
            GLib.idle_add(self._position_inspector_idle)

        def prep_then_show(zd):
            """Build zd's roads view off the UI thread, then
            show. Without a ZoneData the station opens at once
            (no backdrop, as before)."""
            if zd is None:
                show(None)
                return
            import threading

            def worker():
                err = zd.ensure_roads()
                if not err:
                    zd.roads_view()

                def done():
                    if err:
                        self.app_window._set_status(
                            f"Station shown without its roads "
                            f"backdrop: {err}")
                    show(zd)
                    return False
                GLib.idle_add(done)

            threading.Thread(target=worker, daemon=True).start()

        store = self.app_window.zone_store
        if store is not None and zone in store.zones:
            prep_then_show(store.zones[zone])
        elif zone:
            def done(ok, _station=station):
                store2 = self.app_window.zone_store
                zd = store2.zones.get(_station.get("zone")) \
                    if store2 else None
                if self._current is _station:
                    prep_then_show(zd)
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
        # Currently selected stock window/door type for placement.
        # 2.0.0: starts as None and is set from the shelf-driven
        # combos when _build_properties fills them; a None pending
        # type (list unavailable) refuses placement in plain words
        # rather than stamping a made-up type into the data.
        self.pending_window_type = None
        self.pending_door_type = None

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
        # (2.0.0: None until the shelf-driven combo sets it).
        self.pending_decoration_type = None
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
        # Issue A fix (prepared in the held 1.7.3 tree, SHIPPED in
        # 2.0.0): the vertical bar is ALWAYS shown and
        # overlay scrolling is off, so there is a real, grabbable
        # scrollbar on screen at all times — the old 6px overlay
        # sliver was effectively invisible, one half of why this
        # pane read as "not scrollable" in Joshua's live report.
        # (The other half is the wheel guard — see _wheel_proof.)
        scrolled.set_policy(Gtk.PolicyType.NEVER,
                            Gtk.PolicyType.ALWAYS)
        scrolled.set_overlay_scrolling(False)
        # 1.7.1: floor lowered 300 -> 260 (rows are label 110px +
        # control; 260 stays usable) — the paned's shrink below
        # handles the rest.
        scrolled.set_min_content_width(260)
        props = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        props.set_border_width(10)
        scrolled.add(props)
        # props_scroll is assigned BEFORE the controls are built:
        # the row helpers wheel-proof each control against it.
        self.props_scroll = scrolled
        self._build_properties(props)

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

    def _wheel_proof(self, widget):
        """
        Issue A fix (prepared in the held 1.7.3 tree, SHIPPED in
        2.0.0). Combo boxes and scales in this panel CONSUME
        mouse-wheel events: measured in the real app, one wheel
        tick over a combo CHANGED ITS SELECTION (0 -> 1) instead
        of scrolling the panel. With 13 combos, 12 spin buttons
        and 2 scales filling nearly every row's width, the wheel
        almost never reached the scroller — the pane read as "not
        scrollable" and two-thirds of the properties were
        unreachable by wheel (Joshua's live report, 2026-10-17).
        Forward the wheel to the properties scroller and stop the
        event: the wheel always scrolls the panel, and it can
        never silently change a property again. (The forwarding
        moves the scroller's adjustment directly — re-emitting the
        event at the scroller does not work under PyGObject: the
        handler receives a Gdk.EventScroll, which cannot be
        converted back to the GdkEvent emit() requires; measured
        2026-10-17, the TypeError silently voided the handler.)
        """
        def forward(w, event):
            scrolled = getattr(self, "props_scroll", None)
            adj = scrolled.get_vadjustment() \
                if scrolled is not None else None
            if adj is not None:
                dy = getattr(event, "delta_y", 0.0)
                if not dy:
                    dy = 1.0 if getattr(event, "direction", None) \
                        == Gdk.ScrollDirection.DOWN else -1.0
                # One wheel tick = three step increments, the
                # scroller's own pace (measured: its handler moves
                # ~71px per tick on this panel).
                adj.set_value(adj.get_value()
                              + dy * adj.get_step_increment() * 3)
            return True

        def walk(w):
            if isinstance(w, (Gtk.ComboBoxText, Gtk.Scale,
                              Gtk.SpinButton)):
                w.connect("scroll-event", forward)
            if isinstance(w, Gtk.Container):
                for c in w.get_children():
                    walk(c)
        walk(widget)

    def _row(self, parent, label_text, widget):
        """Add a labeled row to the properties panel."""
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        lbl = Gtk.Label(label=label_text)
        lbl.set_halign(Gtk.Align.START)
        lbl.set_size_request(110, -1)
        row.pack_start(lbl, False, False, 0)
        row.pack_start(widget, True, True, 0)
        self._wheel_proof(widget)
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
        self._wheel_proof(spin)
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
        self._wheel_proof(combo)
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
        # 2.0.0: when a pick-list could not be downloaded (and no
        # cache copy exists) the tab says so plainly at the top of
        # the properties pane — never a silent baked-in list. The
        # text is set at the end of this build, once every control
        # has read the shelf state.
        self.vocab_note = Gtk.Label()
        self.vocab_note.set_line_wrap(True)
        self.vocab_note.set_halign(Gtk.Align.START)
        self.vocab_note.set_no_show_all(True)
        self.vocab_note.hide()
        props.pack_start(self.vocab_note, False, False, 0)

        # --- Identity ---
        self._section(props, "Identity")
        name_entry = Gtk.Entry(text=b.get("name", ""))
        name_entry.connect("changed",
                           lambda e: self._update("name", e.get_text()))
        self._row(props, "Name:", name_entry)

        type_combo = Gtk.ComboBoxText()
        cur_type = b.get("type", "House")
        type_opts = _pick_list(self.app_window, "BUILDING_TYPES",
                               cur_type)
        for t in type_opts:
            type_combo.append_text(t)
        if cur_type in type_opts:
            type_combo.set_active(type_opts.index(cur_type))
        # v1.5.0: routed through _on_type_changed so switching to a
        # residential type warns before removing a parking garage
        # (garages are commercial-only, Joshua 2026-10-11).
        self.type_combo = type_combo
        type_combo.connect("changed", self._on_type_changed)
        self._row(props, "Type:", type_combo)

        # --- Materials ---
        self._section(props, "Materials")
        mat_combo = Gtk.ComboBoxText()
        cur_mat = b.get("wall_material", "Brick")
        mat_opts = _pick_list(self.app_window, "WALL_MATERIALS",
                              cur_mat)
        for m in mat_opts:
            mat_combo.append_text(m)
        if cur_mat in mat_opts:
            mat_combo.set_active(mat_opts.index(cur_mat))
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
        cur_roof = b.get("roof_texture", "Shingle")
        roof_opts = _pick_list(self.app_window, "ROOF_TEXTURES",
                               cur_roof)
        for r in roof_opts:
            roof_combo.append_text(r)
        if cur_roof in roof_opts:
            roof_combo.set_active(roof_opts.index(cur_roof))
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
        cur_fp = b.get("floor_plan", "")
        fp_opts = _pick_list(self.app_window, "FLOOR_PLAN_TEMPLATES",
                             cur_fp or None)
        for fp in fp_opts:
            self.fp_combo.append_text(fp)
        if cur_fp in fp_opts:
            self.fp_combo.set_active(fp_opts.index(cur_fp))
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
        for wt in _pick_list(self.app_window, "WINDOW_TYPES"):
            win_combo.append_text(wt)
        if win_combo.get_model().iter_n_children(None):
            win_combo.set_active(0)
        win_combo.connect("changed", lambda c: setattr(
            self, "pending_window_type", c.get_active_text()))
        self._row(props, "Window type:", win_combo)
        self.pending_window_type = win_combo.get_active_text()

        door_combo = Gtk.ComboBoxText()
        for dt in _pick_list(self.app_window, "DOOR_TYPES"):
            door_combo.append_text(dt)
        if door_combo.get_model().iter_n_children(None):
            door_combo.set_active(0)
        door_combo.connect("changed", lambda c: setattr(
            self, "pending_door_type", c.get_active_text()))
        self._row(props, "Door type:", door_combo)
        self.pending_door_type = door_combo.get_active_text()

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
        cur_dw = str(dw.get("material", "Concrete"))
        dw_opts = _pick_list(self.app_window, "DRIVEWAY_MATERIALS",
                             cur_dw)
        for m in dw_opts:
            dw_mat.append_text(m)
        if cur_dw in dw_opts:
            dw_mat.set_active(dw_opts.index(cur_dw))
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
        cur_side = str(gar.get("side", "Right"))
        side_opts = _pick_list(self.app_window, "GARAGE_SIDES",
                               cur_side)
        for s in side_opts:
            gar_side.append_text(s)
        if cur_side in side_opts:
            gar_side.set_active(side_opts.index(cur_side))
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
        cur_fs = str(fence.get("style", "Wood"))
        fence_opts = _pick_list(self.app_window, "FENCE_STYLES",
                                cur_fs)
        for s in fence_opts:
            fence_style.append_text(s)
        if cur_fs in fence_opts:
            fence_style.set_active(fence_opts.index(cur_fs))
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
        self._floor_type_opts = _pick_list(self.app_window,
                                           "FLOOR_TYPES")
        for ft in self._floor_type_opts:
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
        for dt in _pick_list(self.app_window, "DECORATION_TYPES"):
            deco_combo.append_text(dt)
        if deco_combo.get_model().iter_n_children(None):
            deco_combo.set_active(0)
        deco_combo.connect("changed", lambda c: (
            setattr(self, "pending_decoration_type",
                    c.get_active_text()),
            setattr(self.canvas, "pending_decoration_type",
                    c.get_active_text())))
        self._row(props, "Decoration:", deco_combo)
        # Sync the canvas's copy for the placement handler
        self.pending_decoration_type = deco_combo.get_active_text()
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
        self._park_ori_opts = self._parking_orientations()
        self.park_ori_row, self.park_ori_combo = self._combo_row(
            self.parking_props_box, "Orientation:",
            self._park_ori_opts, self._on_park_ori_changed)
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
        # 2.0.0: say plainly which pick-lists (if any) could not be
        # loaded — the note at the top of this pane (spec §6).
        missing = _pick_missing(self.app_window, [
            "BUILDING_TYPES", "WALL_MATERIALS", "ROOF_TEXTURES",
            "WINDOW_TYPES", "DOOR_TYPES", "FLOOR_PLAN_TEMPLATES",
            "DRIVEWAY_MATERIALS", "GARAGE_SIDES", "FENCE_STYLES",
            "FLOOR_TYPES", "DECORATION_TYPES", "PARKING_TYPES"])
        if missing:
            self.vocab_note.set_text(
                vocab_mod.UNAVAILABLE_NOTE + " Missing: "
                + ", ".join(sorted(missing)) + ".")
            self.vocab_note.show()

    # -- property helpers -------------------------------------------------

    def _decoration_wall_types(self):
        """The wall-mounted decoration types (2.0.0): the shelf's
        placement map when the decoration vocabulary downloaded;
        otherwise data.py's set. The placement split is record
        SCHEMA (which face a stored type belongs to), not a
        pick-list — the pick-list itself never falls back."""
        voc = getattr(self.app_window, "vocabularies", None)
        wall = voc.decoration_wall_types() if voc is not None \
            else None
        return wall if wall is not None else DECORATION_WALL_TYPES

    def _parking_labels(self):
        """{parking type: display label} (2.0.0): the shelf's
        labels when downloaded, else data.py's schema labels."""
        voc = getattr(self.app_window, "vocabularies", None)
        labels = voc.parking_labels() if voc is not None else None
        return labels if labels is not None else PARKING_TYPE_LABELS

    def _parking_orientations(self):
        """Parking-space orientations (2.0.0): the shelf's list
        when downloaded, else data.py's schema list."""
        voc = getattr(self.app_window, "vocabularies", None)
        ori = voc.parking_orientations() if voc is not None \
            else None
        return ori if ori is not None \
            else list(PARKING_SPACE_ORIENTATIONS)

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
        opts = getattr(self, "_floor_type_opts", [])
        if cur and cur not in opts:
            # A stored type the shelf no longer lists still
            # displays truthfully (2.0.0 pick-list rule).
            self.floor_type_combo.append_text(cur)
            opts.append(cur)
        if cur in opts:
            self.floor_type_combo.set_active(opts.index(cur))
        elif opts:
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
        if not dtype:
            self.app_window._set_status(
                "The decoration list is unavailable — connect to "
                "the internet and reopen the editor to load it.")
            return
        if dtype in self._decoration_wall_types():
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
                _opts = [r[0] for r in combo.get_model()]
                if old_type in _opts:
                    combo.set_active(_opts.index(old_type))
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
        label = self._parking_labels().get(ptype, ptype).lower()
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
        label = self._parking_labels().get(ptype, ptype)
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
                    self._parking_labels().get(ptype, ptype), sel + 1))
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
                if ori in self._park_ori_opts:
                    self.park_ori_combo.set_active(
                        self._park_ori_opts.index(ori))
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
            if not self.pending_window_type:
                self.app_window._set_status(
                    "The window-type list is unavailable — connect "
                    "to the internet and reopen the editor to load "
                    "it.")
                return
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
            if not self.pending_door_type:
                self.app_window._set_status(
                    "The door-type list is unavailable — connect to "
                    "the internet and reopen the editor to load it.")
                return
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
        # 2.0.0: house styles come from the stock shelf.
        self._style_opts = _pick_list(self.app_window, "HOUSE_STYLES")
        for s in self._style_opts:
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
        _style_opts = _pick_list(self.app_window, "HOUSE_STYLES")
        for s in _style_opts:
            style_combo.append_text(s)
        if _style_opts:
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

        if not style:
            self.app_window._set_status(
                "The house-style list is unavailable — connect to "
                "the internet and reopen the editor to load it.")
            return
        new_sub = {"name": name,
                   "polygon": [[float(p[0]), float(p[1])] for p in points],
                   "style": style}
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
        if style and style not in self._style_opts:
            # A stored style the shelf no longer lists still
            # displays truthfully (2.0.0 pick-list rule).
            self.style_combo.append_text(style)
            self._style_opts.append(style)
        try:
            active = self._style_opts.index(style)
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

# ---------------------------------------------------------------------------
# Draw for Mollie tab (2.0.0 — the suite drawing channel, desktop host)
# ---------------------------------------------------------------------------

class DrawTab(Gtk.Box):
    """
    The editor's host for the suite-core drawing surface
    (suite_draw.DrawPanel): sketch, caption, Send. The send goes
    through suite_draw.send_drawing — the suite save law for bytes
    (push both files on one connection, CLOSE it, re-download on a
    fresh connection, byte-compare; "sent" only on proof). The
    drawing stays on screen through any failure, and a retry
    re-uses the same timestamp until a send verifies, so retrying
    can never duplicate a drawing (the adoption contract).
    """

    def __init__(self, app_window):
        super().__init__(orientation=Gtk.Orientation.VERTICAL,
                         spacing=4)
        self.set_border_width(6)
        self.app_window = app_window
        # The send identity of the drawing currently on screen:
        # fixed at the first Send tap, cleared by a verified send.
        self._send_stamp = None
        intro = Gtk.Label(
            label="Draw for Mollie — sketch what words can't say, "
                  "then Send. The drawing lands in the repo's "
                  "drawings/ folder where Mollie reads it.")
        intro.set_halign(Gtk.Align.START)
        intro.set_line_wrap(True)
        self.pack_start(intro, False, False, 0)
        self.panel = suite_draw.DrawPanel()
        self.pack_start(self.panel, True, True, 0)
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                      spacing=6)
        self.send_btn = Gtk.Button(label="Send drawing to Mollie")
        self.send_btn.connect("clicked", self._on_send)
        row.pack_start(self.send_btn, False, False, 0)
        self.draw_status = Gtk.Label(label="")
        self.draw_status.set_halign(Gtk.Align.START)
        self.draw_status.set_line_wrap(True)
        row.pack_start(self.draw_status, True, True, 0)
        self.pack_start(row, False, False, 0)

    def _set_draw_status(self, text):
        self.draw_status.set_text(text)
        return False

    def _on_send(self, _btn):
        """Send tap: blank paper and a missing token are refused
        in plain words BEFORE any network call (the contract);
        otherwise the round trip runs on a worker thread."""
        if self.panel.is_blank():
            self._set_draw_status(
                "The drawing is blank — draw something first.")
            return
        if not github_sync.has_token():
            self._set_draw_status(
                "No GitHub token — the drawing is safe on screen. "
                "Set one in File → Settings, then Send again.")
            return
        from datetime import datetime, timezone
        if self._send_stamp is None:
            self._send_stamp = datetime.now(timezone.utc)
        stamp = self._send_stamp
        png = self.panel.to_png_bytes()
        caption = self.panel.caption()
        self.send_btn.set_sensitive(False)
        self._set_draw_status("Sending…")
        import threading

        def worker():
            ok, msg, _path = suite_draw.send_drawing(
                png, caption, "building-editor", APP_VERSION,
                github_sync.open_connection,
                github_sync.push_targets,
                github_sync.fetch_file, now=stamp)

            def done():
                self.send_btn.set_sensitive(True)
                if ok:
                    # Verified: the NEXT send is a new drawing
                    # with a fresh timestamp.
                    self._send_stamp = None
                self._set_draw_status(msg)
                return False
            GLib.idle_add(done)

        threading.Thread(target=worker, daemon=True).start()


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
