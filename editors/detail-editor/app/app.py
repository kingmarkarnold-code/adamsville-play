#!/usr/bin/env python3
"""
Adamsville Detail Editor (Native) 1.2.1 — main window.

Joshua's design (game-map/detail-editor/DESIGN.md, 2026-10-18): a
STANDALONE suite app — not a mode inside the Map Editor — for the
fine work the Map Editor cannot do: moving a road piece's points.
It is ELEMENT-AGNOSTIC: one manipulation core (element.py) works
on whatever element is handed to it; roads are the first (and in
this build only) element type wired in. The Map Editor's Detail
Edit button is the handoff door: it writes
~/.local/share/adamsville-suite/open-in-detail-editor.json and
launches this app, which opens on exactly that piece.

THE FLOW
  1. Open — via the handoff (a piece arrives) or File -> Open
     Piece (pick a zone, then a piece; only that zone downloads).
  2. Edit — the whole piece, framed, IN COLOUR (the game's own
     material colours; Joshua's findings, 2026-10-25): drag
     points to move them, add/delete points, add/delete
     segments, delete a whole section (the bulge case: bowed
     lines AND the face inside them go; the ends join straight).
     Elevation is never touched. The piece's tab also carries
     a rename PENCIL (left of the name; the close X stays on
     the right): it edits this piece's street name inline,
     named or unnamed alike (Joshua, 2026-10-24), and the new
     name rides the same save.
     The SEGMENTATION is coarse by default (a handle every
     ~30 m); Shift+drag draws the LASSO — the portion of the
     piece inside the loop becomes the focus (the view zooms
     to it), its points selected together for a one-step group
     Delete, and the right-click menu offers RESEGMENT (fine
     handles in that portion) and Coarsen. A clean click on
     ANOTHER road switches pieces: this piece's edits save
     first (the round trip), then the clicked road opens as
     the working piece (click-switch, Joshua 2026-10-25).
     A compass sits bottom-right of the canvas and a dynamic
     scale bar bottom-left; clicking the scale bar measures.
  3. Save — the suite's round trip: local save -> push -> close ->
     fresh download -> the screen shows the downloaded copy.

STANDING LAW APPLIED HERE: data from GitHub only (shared suite
cache), lightweight (one zone at a time, no whole-world load), the
bottom-right progress bar for every background job, universal
viewport controls, one-live-pane hover activation (canvases keep
their picture as a still when the mouse leaves), panes scroll and
resize with nothing clipped, tabs closable, and the app opens with
NO tool armed — plain pan / zoom / select.

Everything generic lives in suite_core (GitHub round trip, cache,
layout, About, updater); the element core lives in element.py; the
data layer in detaildata.py; the canvases in detailcanvas.py.
Joshua's rule: all code commented.
"""

import math
import os
import sys
import threading
import traceback
from pathlib import Path

# The app dir rides on sys.path (the launcher runs this file by
# path); the vendored suite_core package sits next to it.
#
# APP_ROOT (1.2.0, the bootstrap-shim contract): the launcher may
# point ADAMSVILLE_APP_ROOT at a staged update payload under
# ~/.local/share/adamsville-suite/detail-editor/updates/current,
# and then THIS file is that payload's app.py. The app resolves
# its own files from APP_ROOT — the payload root — never from a
# hardcoded /usr/share path, so a staged payload is complete in
# itself. Without the variable, APP_ROOT is simply this file's
# own directory (the installed payload).
APP_ROOT = Path(os.environ.get("ADAMSVILLE_APP_ROOT")
                or Path(__file__).resolve().parent)
sys.path.insert(0, str(APP_ROOT))

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gtk, Gdk, GLib, Pango

from suite_core import about as about_mod
from suite_core import github_sync
from suite_core import layout as layout_mod
from suite_core import shared_cache
from suite_core import updater as updater_mod
from suite_core import reporting as reporting_mod

import detaildata
from detaildata import DetailData, DetailDataError, PieceSession, \
    ZONE_IDS
from detailcanvas import DetailCanvas, OverviewCanvas, ROAD_WIDTHS, \
    DEFAULT_ROAD_WIDTH

# Identity (About, data dir, repo versioning).
APP_NAME = "Adamsville Detail Editor"
APP_VERSION = detaildata.EDITOR_VERSION
PACKAGE_NAME = "adamsville-detail-editor-native"
ICON_NAME = "adamsville-detail-editor-native"
APP_REPO_DIR = "editors/detail-editor"

# The self-update channel manifest (1.2.1): suite_core.updater's
# staging path reads this same file through the Contents API; the
# Help -> Check for Updates flow fetches it at this raw URL.
_CHANNEL_MANIFEST_URL = (
    "https://raw.githubusercontent.com/"
    "kingmarkarnold-code/adamsville-play/main/"
    "editors/detail-editor/version.json")

# Per-app data (window state, the local save leg) — never the
# shared cache (that is suite_core.shared_cache's, by design).
DATA_DIR = Path.home() / ".local" / "share" / PACKAGE_NAME
LOCAL_SAVE_DIR = DATA_DIR / "local-save"
CACHE_LOG_DIR = Path.home() / ".cache" / PACKAGE_NAME

# Tool button vocabulary -> canvas tool names + hints. "select" is
# the BASE state (pan/zoom/select, drag a point to move it), the
# state the app opens in — no tool is "armed" at startup.
TOOLS = [
    ("select", "Select",
     "Select: drag the map to pan, drag a point to move it, "
     "Shift+drag lassos a portion, click another road to "
     "switch to it."),
    ("add_point", "Add Point",
     "Add point: click a segment to split it, or click an end "
     "point then the ground to extend the piece."),
    ("del_point", "Delete Point",
     "Delete point: click a point to remove it — its neighbours "
     "join straight."),
    ("add_segment", "Add Segment",
     "Add segment: click one point, then another, to join them."),
    ("del_segment", "Delete Segment",
     "Delete segment: click a segment to remove only it."),
    ("del_section", "Delete Section",
     "Delete section: click the first segment of a section, then "
     "the last — the whole section (lines and the face inside "
     "them) goes, and the ends join straight."),
]


def _install_crash_log():
    """Unhandled exceptions land in ~/.cache/<app>/crash.log (the
    suite precedent) instead of vanishing with the window."""

    def hook(exc_type, exc, tb):
        try:
            CACHE_LOG_DIR.mkdir(parents=True, exist_ok=True)
            with open(CACHE_LOG_DIR / "crash.log", "a") as fh:
                traceback.print_exception(exc_type, exc, tb, file=fh)
        except Exception:
            pass
        sys.__excepthook__(exc_type, exc, tb)

    sys.excepthook = hook


class PiecePage:
    """
    One notebook page: everything for ONE open piece — its working
    canvas, its overview, its info pane, its undo history. Pages
    are closable (tonight's suite ruling); closing a dirty page
    asks first (see the window's close flow).
    """

    def __init__(self, window, session):
        self.window = window
        self.session = session
        self.undo_stack = []        # element snapshots (pre-edit)
        self.redo_stack = []
        self.build_ui()

    # -- construction ---------------------------------------------------

    def build_ui(self):
        """Canvas | (overview over info), in remembered splitters:
        both directions resize (the layout law), the info pane
        scrolls, headers stay visible."""
        win = self.window
        self.canvas = DetailCanvas()
        self.overview = OverviewCanvas()
        self.overview.set_size_request(-1, 190)
        # Wire the canvas family to the session + the app.
        self.canvas.context_provider = self._context
        self.overview.context_provider = self._context
        self.canvas.on_status = win._set_status
        self.canvas.on_edit = lambda: win._on_page_edited(self)
        self.canvas.on_snapshot = lambda: win._on_page_snapshot(self)
        self.canvas.confirm_section = win._confirm_section
        self.canvas.confirm_points = win._confirm_points
        # Reporting (1.2.1): time the group delete. Every door to
        # it — the Delete key, the toolbar's Delete Selected
        # button, the canvas right-click menu — calls this one
        # bound method, so wrapping it here times EVERY group
        # delete exactly once, with its piece count, as a
        # "delete" timing report.
        _raw_delete_points = self.canvas.delete_selected_points

        def _delete_points_timed():
            n = len(self.canvas.selected_points)
            if n > 1:
                with reporting_mod.operation("delete", pieces=n):
                    _raw_delete_points()
            else:
                _raw_delete_points()

        self.canvas.delete_selected_points = _delete_points_timed
        self.canvas.on_selection = \
            lambda: win._on_selection_changed(self)
        self.canvas.on_switch_request = \
            lambda cat, idx, pts: win._switch_to_piece(
                self, cat, idx, pts)
        self.canvas.on_context_menu = \
            lambda event: win._show_canvas_menu(self, event)
        self.overview.main_camera = self.canvas.camera
        self.overview.main_view_rect = self.canvas.view_rect
        self.overview.on_jump = self._on_overview_jump
        width = ROAD_WIDTHS.get(self.session.category,
                                DEFAULT_ROAD_WIDTH)
        self.canvas.set_session(self.session, width)
        self.overview.session = self.session
        self.overview.piece_width = width

        # The right column: overview on top, info below, in a
        # vertical splitter the user can drag.
        self.info = layout_mod.hint_label("")
        info_scroll = layout_mod.scrolled(self.info)
        info_scroll.set_min_content_height(120)
        right = Gtk.Paned(orientation=Gtk.Orientation.VERTICAL)
        right.pack1(self.overview, resize=False, shrink=True)
        right.pack2(info_scroll, resize=True, shrink=True)
        right.set_position(win._state.get_pane("page-vsplit", 210))

        self.root = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self.root.pack1(self.canvas, resize=True, shrink=True)
        self.root.pack2(right, resize=False, shrink=True)
        self.root.set_position(win._state.get_pane("page-split", 980))
        self.right_pane = right
        self.refresh_info()
        # Both canvases frame themselves once they have real size
        # (at build time the allocation is still nominal — a fit
        # computed then would frame for a 1x1 window).
        self.overview.connect("size-allocate", self._overview_sized)
        self.canvas.connect("size-allocate", self._canvas_sized)

    def _canvas_sized(self, _widget, alloc):
        """Frame the piece when the canvas first gets real size."""
        if not getattr(self, "_canvas_fitted", False) \
                and alloc.width > 50 and alloc.height > 50:
            self._canvas_fitted = True
            self.canvas.fit_piece()

    def _overview_sized(self, _widget, _alloc):
        """Fit the overview to the piece when it first gets size
        (and keep the fit when the pane is resized taller)."""
        if not getattr(self, "_overview_fitted", False):
            self._overview_fitted = True
            self.overview.fit()

    def _on_overview_jump(self, x, z):
        """Clicking the overview moves the working view's centre."""
        self.canvas.camera.cx = x
        self.canvas.camera.cz = z
        self.canvas.invalidate()
        self.overview.invalidate()

    # -- neighbourhood ----------------------------------------------------

    def _context_index(self):
        """
        The neighbourhood's geometry, indexed ONCE per session:
        every road record's bounding box (with its identity, for
        click-switch), every building, every water outline. The
        1.1.0 provider recomputed every record's bbox from its
        point list on EVERY render — over a ~8k-record zone that
        per-frame list building was a real share of the pan
        sluggishness Joshua reported. Built lazily on first use
        and cached on the page; the zone document is only ever
        replaced wholesale by a save's adopt, which also swaps
        the session's origin — a save clears the cache (see
        _on_page_edited's sibling, the window's save flow, which
        invalidates every page of the zone).
        """
        cached = getattr(self, "_context_cache", None)
        if cached is not None:
            return cached
        model = self.session.model
        roads = []
        for cat, records in (model.roads or {}).items():
            width = ROAD_WIDTHS.get(cat, DEFAULT_ROAD_WIDTH)
            for idx, rec in enumerate(records):
                pts = rec.get("pts") or []
                if len(pts) < 2:
                    continue
                xs = [p[0] for p in pts]
                zs = [p[1] for p in pts]
                roads.append((cat, idx, pts, width,
                              min(xs), min(zs), max(xs), max(zs)))
        buildings = []
        for b in model.buildings:
            x, z, bw, bd = b[0], b[1], b[2], b[3]
            r = max(bw, bd) / 2.0
            buildings.append((b, x - r, z - r, x + r, z + r))
        water = []
        for kind, pts in model.water:
            xs = [p[0] for p in pts]
            zs = [p[1] for p in pts]
            water.append((kind, pts,
                          min(xs), min(zs), max(xs), max(zs)))
        self._context_cache = (roads, buildings, water)
        return self._context_cache

    def _context(self, rect):
        """
        The neighbourhood underlay, as the canvases' context
        dict: the roads (with identity), buildings and water
        whose bounding boxes touch the view rect — EXCLUDING the
        open piece itself (it is drawn from its live Element,
        edits and all). Pure bbox filtering over the cached
        index: cheap enough to run per render.
        """
        x0, z0, x1, z1 = rect
        margin = 40.0
        roads_idx, buildings_idx, water_idx = self._context_index()
        origin = self.session.origin_pts
        roads = []
        for cat, idx, pts, width, bx0, bz0, bx1, bz1 in roads_idx:
            if cat == self.session.category and pts == origin:
                continue  # the open piece draws itself
            if bx1 < x0 - margin or bx0 > x1 + margin \
                    or bz1 < z0 - margin or bz0 > z1 + margin:
                continue
            roads.append((cat, idx, pts, width))
        buildings = [b for b, bx0, bz0, bx1, bz1 in buildings_idx
                     if not (bx1 < x0 - margin or bx0 > x1 + margin
                             or bz1 < z0 - margin
                             or bz0 > z1 + margin)]
        # Dressing stays light: when a wide view holds thousands
        # of buildings, keep the ones nearest the view's centre.
        if len(buildings) > 2500:
            cx, cz = (x0 + x1) / 2.0, (z0 + z1) / 2.0
            buildings.sort(
                key=lambda b: (b[0] - cx) ** 2 + (b[1] - cz) ** 2)
            buildings = buildings[:2500]
        water = [(kind, pts)
                 for kind, pts, bx0, bz0, bx1, bz1 in water_idx
                 if not (bx1 < x0 - margin or bx0 > x1 + margin
                         or bz1 < z0 - margin or bz0 > z1 + margin)]
        return {"roads": roads, "buildings": buildings,
                "water": water}

    # -- info -------------------------------------------------------------

    def refresh_info(self):
        """The info pane's readout: what this piece is, its shape
        in numbers, and its saved state — plain language."""
        s = self.session
        el = s.element
        length = 0.0
        for a, b in el.segments:
            length += math.hypot(el.points[a][0] - el.points[b][0],
                                 el.points[a][1] - el.points[b][1])
        chains = len(el.chains())
        state = "Unsaved changes" if s.dirty else "Saved"
        selected = len(self.canvas.selected_points)
        sel_line = ""
        if selected:
            sel_line = (f"\nSelected: {selected} point(s) "
                        f"together — Delete Selected removes "
                        f"them as one section (one Undo).")
        matched = {"exact": "matched exactly",
                   "name+centre": "matched by name and position",
                   "centre": "matched by position only"}.get(
                       s.how, s.how)
        self.info.set_text(
            f"{s.name}\n"
            f"Zone: {s.model.name} · Category: {s.category}\n"
            f"Opened from the downloaded zone data ({matched}).\n\n"
            f"Points: {len(el.points)} · Segments: "
            f"{len(el.segments)} · Parts: {chains}\n"
            f"Length: {length:.0f} m · Face width: "
            f"{self.canvas.piece_width:.0f} m\n\n"
            f"State: {state}{sel_line}\n\n"
            "Drag a point to move it. Shift+drag lassos a "
            "portion; right-click offers Resegment. Tools are "
            "on the toolbar; Esc returns to Select. Saving "
            "pushes the whole zone file (this piece's edits "
            "baked in) and shows the downloaded copy.")

    # -- the tab: pencil, name, close X --------------------------------

    def build_tab(self):
        """
        This page's notebook tab: a rename PENCIL on the LEFT
        (Joshua, 2026-10-24 — "on the left you'll have a pencil",
        with the X on the right), the piece's name, and the close
        button on the RIGHT (the closable-tabs ruling). The pencil
        edits the street name inline, in the tab itself.
        """
        self.tab_box = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        self.rename_btn = Gtk.Button()
        self.rename_btn.set_relief(Gtk.ReliefStyle.NONE)
        self.rename_btn.set_image(Gtk.Image.new_from_icon_name(
            "document-edit", Gtk.IconSize.MENU))
        self.rename_btn.set_tooltip_text("Rename this street")
        self.rename_btn.connect("clicked",
                                lambda _b: self.start_rename())
        self.tab_box.pack_start(self.rename_btn, False, False, 0)
        self.tab_label = Gtk.Label(label=self.session.title())
        self.tab_box.pack_start(self.tab_label, False, False, 0)
        close_btn = Gtk.Button()
        close_btn.set_relief(Gtk.ReliefStyle.NONE)
        close_btn.set_image(Gtk.Image.new_from_icon_name(
            "window-close", Gtk.IconSize.MENU))
        close_btn.set_tooltip_text("Close this piece")
        close_btn.connect(
            "clicked", lambda _b: self.window._close_page(self))
        self.tab_box.pack_start(close_btn, False, False, 0)
        self.tab_box.show_all()
        return self.tab_box

    def refresh_tab_title(self):
        """The tab's name label follows the session — after a
        rename, and after a save rebinds the session to the
        downloaded copy."""
        if getattr(self, "tab_label", None) is not None:
            self.tab_label.set_text(self.session.title())

    def start_rename(self):
        """
        The pencil: swap the tab's name label for an inline text
        field, right there in the tab. The field starts with the
        record's real name — EXCEPT for an unnamed piece, where
        it starts EMPTY with the placeholder showing: "Unnamed
        St" is the game's placeholder text, not a name to make
        him delete first. Enter or clicking away confirms; Esc
        cancels, leaving the name untouched.
        """
        if getattr(self, "_rename_entry", None) is not None:
            return  # a rename is already open in this tab
        entry = Gtk.Entry()
        current = self.session.template.get("name") or ""
        if current == detaildata.UNNAMED_NAME:
            entry.set_placeholder_text(detaildata.UNNAMED_NAME)
        else:
            entry.set_text(current)
        entry.set_width_chars(max(12, min(36, len(current) + 4)))
        entry.connect("activate",
                      lambda _e: self._finish_rename(True))
        entry.connect("focus-out-event", self._on_rename_focus_out)
        entry.connect("key-press-event", self._on_rename_key)
        self._rename_entry = entry
        self.tab_box.remove(self.tab_label)
        self.tab_box.pack_start(entry, False, False, 0)
        self.tab_box.reorder_child(entry, 1)
        entry.show()
        entry.grab_focus()
        entry.select_region(0, -1)

    def _on_rename_key(self, _entry, event):
        """Esc cancels the rename — the name stays untouched."""
        if event.keyval == Gdk.KEY_Escape:
            self._finish_rename(False)
            return True
        return False

    def _on_rename_focus_out(self, _entry, _event):
        """Clicking away confirms the rename (Enter does too)."""
        self._finish_rename(True)
        return False

    def _finish_rename(self, commit):
        """
        End the inline rename: the name label goes back, and a
        CONFIRMED text is handed to the window (which owns the
        session bookkeeping). The entry reference clears FIRST —
        removing the entry can fire focus-out, which would
        otherwise re-enter here and try to confirm twice.
        """
        entry = getattr(self, "_rename_entry", None)
        if entry is None:
            return
        self._rename_entry = None
        raw = entry.get_text() if commit else None
        self.tab_box.remove(entry)
        self.tab_box.pack_start(self.tab_label, False, False, 0)
        self.tab_box.reorder_child(self.tab_label, 1)
        self.tab_label.show()
        if commit:
            self.window._on_page_renamed(self, raw)


class DetailWindow(Gtk.Window):
    """The editor's one window (see the module docstring's flow)."""

    def __init__(self):
        """Build the window; start the manifest download, then
        consume any handoff the Map Editor left for us."""
        super().__init__(title=f"{APP_NAME} {APP_VERSION}")
        self._state = layout_mod.WindowState(DATA_DIR / "window.json")
        cls, _sw, _sh = layout_mod.screen_class()
        # Screen-class variant: the laptop class gets the tighter
        # default window; both classes stay fully usable small.
        w, h = self._state.get_size(
            "main", (1180, 700) if cls == "laptop" else (1320, 800))
        self.set_default_size(w, h)
        self.set_size_request(760, 480)
        try:
            self.set_icon_name(ICON_NAME)
        except Exception:
            pass
        self.connect("delete-event", self._on_delete)
        self.connect("destroy", self._on_destroy)
        self.connect("key-press-event", self._on_key)
        # A handoff can land while this window is already running
        # (1.2.2): recheck whenever the window gains focus.
        self.connect("focus-in-event", self._on_focus_in)

        # -- data ---------------------------------------------------
        self._fetcher = shared_cache.CachedFetcher(
            github_sync.fetch_file,
            fetch_meta=github_sync.fetch_file_meta,
            fetch_file_progress=github_sync.fetch_file_progress)
        self.data = DetailData(self._fetcher, github_sync.fetch_file)
        self.pages = []             # [PiecePage]
        self._manifest_version = None
        # Set once the startup manifest flow has had its turn
        # (success OR failure): from then on, focus-in re-checks
        # the handoff (see _on_focus_in).
        self._handoff_armed = False

        self._build_ui()
        self.show_all()
        self.progress_box.hide()
        self._set_status("Downloading the map manifest…")
        self._run_background(self._load_manifest_bg,
                             self._on_manifest_done)
        self._start_reporting_and_updates()

    # ------------------------------------------------------------------
    # Reporting + self-update (1.2.1): the door gets its hand
    # ------------------------------------------------------------------

    def _start_reporting_and_updates(self):
        """Wire the app into the suite's reporting + self-update.

        ORDER MATTERS (the reporting rule): reporting is
        initialised BEFORE the background update check starts, so
        if the launch-time check refuses a corrupt download, the
        "update-refused" report files under THIS app's own
        session (the updater only initialises reporting itself
        when nothing has). The background check is the v3 staging
        path: silent when the app is current or the check fails,
        it downloads a newer payload into the updates folder —
        the bootstrap launcher runs it on the next launch.

        Fail-open throughout: a broken reporter or updater must
        never stop the editor opening, so each step guards
        itself (reporting's own functions never raise; these
        guards are belt and braces).
        """
        try:
            reporting_mod.init("detail-editor", APP_VERSION,
                               data_versions={})
            reporting_mod.session_start()
        except Exception:
            pass
        try:
            updater_mod.start_background_check(
                "detail-editor", APP_VERSION,
                fetch_file=github_sync.fetch_file,
                on_progress=self._update_progress,
                on_staged=self._on_update_staged,
                gui=True)
        except Exception:
            pass

    def _update_progress(self, done, total, label):
        """Feed a self-update download into the corner bar (the
        suite's progress-bar law). Runs on the UI thread —
        start_background_check marshals with gui=True. Only ever
        called while a payload is actually downloading."""
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
            f"Update downloaded: version {version} will run "
            f"next time you start the app.")

    def _on_destroy(self, _window):
        """The window is really going away (the delete-event
        already had its say): close the report session. The
        module's final flush is bounded — it never holds the
        app open."""
        try:
            reporting_mod.session_end()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _build_ui(self):
        """Menubar (anchored top), toolbar, notebook body, status
        bar with the corner progress bar (anchored bottom) — the
        suite layout grammar."""
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.add(root)
        root.pack_start(self._build_menubar(), False, False, 0)
        root.pack_start(self._build_toolbar(), False, False, 0)
        self.notebook = Gtk.Notebook()
        self.notebook.set_scrollable(True)
        self.notebook.connect("switch-page", self._on_switch_page)
        root.pack_start(self.notebook, True, True, 0)
        # The placeholder page (no close button): shown until the
        # first piece opens.
        self._placeholder = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL)
        label = layout_mod.hint_label(
            "No piece is open.\n\nIf the Map Editor sent a piece "
            "(its Detail Edit button), it opens here by itself. "
            "Otherwise use File -> Open Piece… to pick a road piece "
            "from a zone.")
        label.set_valign(Gtk.Align.CENTER)
        label.set_halign(Gtk.Align.CENTER)
        self._placeholder.pack_start(label, True, True, 0)
        self.notebook.append_page(self._placeholder,
                                  Gtk.Label(label="Detail Editor"))
        self.statusbar = Gtk.Statusbar()
        self.statusbar.set_margin_top(0)
        self.statusbar.set_margin_bottom(0)
        self._build_progress_bar()
        root.pack_start(self.statusbar, False, False, 0)

    def _build_menubar(self):
        """File (open piece, save, token settings, quit) + Help
        (updates, About). Menus yield after selection (GTK closes
        them itself)."""
        bar = Gtk.MenuBar()
        file_menu = Gtk.Menu()
        file_item = Gtk.MenuItem(label="File")
        file_item.set_submenu(file_menu)
        open_item = Gtk.MenuItem(label="Open Piece…")
        open_item.connect("activate", self._on_open_piece)
        file_menu.append(open_item)
        self.save_item = Gtk.MenuItem(label="Save")
        self.save_item.connect("activate", self._on_save)
        self.save_item.set_sensitive(False)
        file_menu.append(self.save_item)
        file_menu.append(Gtk.SeparatorMenuItem())
        settings_item = Gtk.MenuItem(label="Settings…")
        settings_item.connect(
            "activate",
            lambda _w: github_sync.show_settings_dialog(
                self, on_key_changed=lambda _c: None))
        file_menu.append(settings_item)
        file_menu.append(Gtk.SeparatorMenuItem())
        quit_item = Gtk.MenuItem(label="Quit")
        quit_item.connect("activate", lambda _w: self.close())
        file_menu.append(quit_item)
        bar.append(file_item)

        help_menu = Gtk.Menu()
        help_item = Gtk.MenuItem(label="Help")
        help_item.set_submenu(help_menu)
        upd_item = Gtk.MenuItem(label="Check for Updates…")
        upd_item.connect("activate", self._on_check_updates)
        help_menu.append(upd_item)
        about_item = Gtk.MenuItem(label="About…")
        about_item.connect("activate", self._on_about)
        help_menu.append(about_item)
        bar.append(help_item)
        return bar

    def _build_toolbar(self):
        """The tool row: the six tools as toggles (Select is the
        base state), Undo/Redo, ORBIT (the touch face of rotate),
        Fit, and Save — in a sideways scroller so a narrow window
        scrolls the row instead of clipping it."""
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                      spacing=4)
        row.set_border_width(4)
        # The hint label exists BEFORE any toggle can fire: arming
        # the Select base state below emits "toggled", and the
        # handler writes the hint — an AttributeError there used to
        # kill startup (caught by the 1.0.0 launch harness).
        self.tool_hint = layout_mod.hint_label(TOOLS[0][2])
        # The hint must NOT wrap: inside this sideways-scrolling
        # row a wrapping label's height request explodes as the
        # window narrows (measured: a 209 px toolbar on an 820x500
        # window, button labels centred out of sight). Ellipsised,
        # with the full text on the tooltip instead — set per tool
        # in _on_tool_toggled.
        self.tool_hint.set_line_wrap(False)
        self.tool_hint.set_ellipsize(Pango.EllipsizeMode.END)
        self.tool_hint.set_max_width_chars(46)
        self.tool_hint.set_tooltip_text(TOOLS[0][2])
        self.tool_buttons = {}
        first = None
        for name, label, _hint in TOOLS:
            btn = Gtk.ToggleButton(label=label)
            btn.connect("toggled", self._on_tool_toggled, name)
            row.pack_start(btn, False, False, 0)
            self.tool_buttons[name] = btn
        self.tool_buttons["select"].set_active(True)
        row.pack_start(Gtk.Separator(
            orientation=Gtk.Orientation.VERTICAL), False, False, 2)
        self.undo_button = Gtk.Button(label="Undo")
        self.undo_button.connect("clicked", self._on_undo)
        self.undo_button.set_sensitive(False)
        row.pack_start(self.undo_button, False, False, 0)
        self.redo_button = Gtk.Button(label="Redo")
        self.redo_button.connect("clicked", self._on_redo)
        self.redo_button.set_sensitive(False)
        row.pack_start(self.redo_button, False, False, 0)
        # Delete Selected (1.2.0): the lasso's group delete, as a
        # visible button beside Undo — live only while a point
        # selection exists; its label carries the count. (The
        # Delete key and the right-click menu reach the same verb;
        # the menu is a shortcut layer, never the only door.)
        self.delete_selected_button = Gtk.Button(
            label="Delete Selected")
        self.delete_selected_button.set_tooltip_text(
            "Delete every selected point as one operation "
            "(Shift+drag a lasso to select a portion).")
        self.delete_selected_button.connect(
            "clicked", self._on_delete_selected)
        self.delete_selected_button.set_sensitive(False)
        row.pack_start(self.delete_selected_button, False, False, 0)
        row.pack_start(Gtk.Separator(
            orientation=Gtk.Orientation.VERTICAL), False, False, 2)
        self.orbit_button = Gtk.ToggleButton(label="ORBIT")
        self.orbit_button.set_tooltip_text(
            "Orbit: while on, dragging rotates the view (the touch "
            "face of Ctrl+drag).")
        self.orbit_button.connect("toggled", self._on_orbit_toggled)
        row.pack_start(self.orbit_button, False, False, 0)
        fit_button = Gtk.Button(label="Fit Piece")
        fit_button.connect("clicked", self._on_fit)
        row.pack_start(fit_button, False, False, 0)
        row.pack_start(Gtk.Separator(
            orientation=Gtk.Orientation.VERTICAL), False, False, 2)
        self.save_button = Gtk.Button(label="Save")
        self.save_button.connect("clicked", self._on_save)
        self.save_button.set_sensitive(False)
        row.pack_start(self.save_button, False, False, 0)
        row.pack_start(self.tool_hint, False, False, 8)
        return layout_mod.hscroll_row(row)

    # ------------------------------------------------------------------
    # Background work + the corner progress bar (the suite law)
    # ------------------------------------------------------------------
    # Whenever the app downloads, pushes or computes in the
    # background, a progress bar shows in the BOTTOM-RIGHT corner
    # (the right end of the status bar): real progress where a
    # total is known, a moving pulse where it isn't, so a busy app
    # never reads as frozen. Jobs are keyed; the bar shows the most
    # recent job and clears when none remain. UI-thread only —
    # workers hop here with GLib.idle_add. (The Map Editor 1.9.7
    # facility, same shape.)

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
        self._progress_jobs[job_id] = {"label": label,
                                       "fraction": None}
        self._refresh_progress_bar()

    def progress_update(self, job_id, fraction=None, label=None):
        """Update a job's fraction (0..1) and/or label."""
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
        self._progress_jobs.pop(job_id, None)
        self._refresh_progress_bar()

    def _refresh_progress_bar(self):
        """Make the corner bar reflect the current job set."""
        if not self._progress_jobs:
            self._stop_progress_pulse()
            self.progress_box.hide()
            return
        job = list(self._progress_jobs.values())[-1]
        self.progress_label.set_text(job["label"])
        if job["fraction"] is None:
            self.progress_bar_widget.set_fraction(0.0)
            if self._progress_pulse_id is None:
                self._progress_pulse_id = GLib.timeout_add(
                    120, self._pulse_progress_bar)
        else:
            self._stop_progress_pulse()
            self.progress_bar_widget.set_fraction(job["fraction"])
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

    def _run_background(self, work, done):
        """
        Run work() on a thread; done(result, error) lands back on
        the UI thread via GLib.idle_add. Errors are captured, never
        raised into the void. (The Elevation Editor's runner.)
        """

        def runner():
            try:
                result = work()
                GLib.idle_add(done, result, None)
            except Exception as e:  # noqa: BLE001 — shown to the user
                GLib.idle_add(done, None, e)

        threading.Thread(target=runner, daemon=True).start()

    def _set_status(self, text):
        """Replace the status bar's message."""
        ctx = self.statusbar.get_context_id("main")
        self.statusbar.pop(ctx)
        self.statusbar.push(ctx, text)

    def _progress_cb(self, job_id, label):
        """A fetch progress callback (done_bytes, total_bytes) that
        feeds the corner bar on the UI thread."""
        def cb(done, total):
            frac = (done / total) if total else None
            GLib.idle_add(self.progress_update, job_id, frac, label)
        return cb

    # ------------------------------------------------------------------
    # Startup: manifest, then the handoff
    # ------------------------------------------------------------------

    def _load_manifest_bg(self):
        self.progress_start("manifest", "Downloading map manifest…")
        try:
            return self.data.load_manifest()
        finally:
            GLib.idle_add(self.progress_finish, "manifest")

    def _on_manifest_done(self, version, err):
        # The startup flow has had its turn either way: focus-in
        # handoff rechecks are live from here on.
        self._handoff_armed = True
        if err is not None:
            self._set_status(
                f"Could not download the map manifest: {err} — "
                "check the connection; pieces can still be opened "
                "from the cache if the network returns.")
            return False
        self._manifest_version = version
        self._set_status(f"Map data {version}. Ready.")
        # The handoff: a piece the Map Editor sent us.
        self._consume_handoff()
        return False

    def _consume_handoff(self):
        """Act on any waiting handoff: open a road piece, or
        speak the notice an unsupported payload left behind. A
        building handed to this roads-only editor must never
        vanish in silence (1.2.2) — the notice names what it
        was, and the payload itself is preserved aside, not
        deleted (detaildata.read_handoff)."""
        doc = detaildata.read_handoff()
        notice = detaildata.pop_handoff_notice()
        if notice:
            self._set_status(notice)
        if doc is not None:
            self._open_handoff(doc)

    def _on_focus_in(self, _window, _event):
        """The window gained focus: recheck for a handoff. Before
        1.2.2 the handoff was read exactly once, at startup — a
        piece (or building) sent while the editor was already
        open simply never appeared, and no amount of waiting
        helped. The startup read is guarded off here: until the
        manifest flow has had its turn, it owns the first
        consumption."""
        if not self._handoff_armed:
            return False
        self._consume_handoff()
        return False

    def _open_handoff(self, doc):
        """Open the handed piece: download its zone (background,
        progress bar), find the piece, open its tab."""
        zone = str(doc.get("zone") or "")
        if zone not in ZONE_IDS:
            self._set_status(
                "The Map Editor sent a piece, but its zone "
                f"('{zone}') is not one of the game's zones — "
                "nothing opened.")
            return
        name = doc.get("name") or detaildata.UNNAMED_NAME
        self._set_status(f"Opening '{name}' from the Map Editor…")

        def work():
            self.progress_start("zone", f"Downloading {zone}…")
            try:
                return self.data.load_zone(
                    zone, progress=self._progress_cb("zone",
                                                     f"{zone} roads"))
            finally:
                GLib.idle_add(self.progress_finish, "zone")

        def done(model, err):
            if err is not None:
                self._set_status(f"Could not open the piece: {err}")
                return False
            found = detaildata.find_piece(
                model.roads, str(doc.get("category") or ""),
                str(doc.get("name") or ""), doc.get("points") or [],
                (doc.get("x"), doc.get("z"))
                if doc.get("x") is not None else None)
            if found is None:
                self._set_status(
                    "Couldn't find that piece — it may have "
                    "been changed or deleted.")
                return False
            cat, idx, how = found
            self._open_piece(model, cat, idx, how)
            return False

        self._run_background(work, done)

    # ------------------------------------------------------------------
    # Opening pieces (handoff + picker share this door)
    # ------------------------------------------------------------------

    def _open_piece(self, model, category, index, how):
        """
        Open (or focus) a tab for one piece. The same piece opened
        twice focuses its existing tab — one working copy per
        piece, so two tabs can never fight over one record.
        """
        record = model.roads[category][index]
        origin = [list(p) for p in record.get("pts") or []]
        for page in self.pages:
            if page.session.model is model \
                    and page.session.category == category \
                    and page.session.origin_pts == origin:
                self.notebook.set_current_page(
                    self.notebook.page_num(page.root))
                self._set_status(
                    f"'{page.session.name}' is already open — "
                    "focused its tab.")
                return page
        session = PieceSession(model, category, index, how)
        page = PiecePage(self, session)
        self.pages.append(page)
        # The tab — rename pencil (left), name, close button
        # (right) — is built by the page, which owns the rename.
        tab_box = page.build_tab()
        # The page content must be SHOWN before it joins the
        # notebook: the window's own show_all() ran at startup,
        # before this page existed, and a hidden notebook page
        # never becomes current and never gets sized — the canvas
        # would sit at 1x1 forever (caught by the 1.0.0 launch
        # harness: current page -1, canvas 1x1).
        page.root.show_all()
        self.notebook.append_page(page.root, tab_box)
        if self.notebook.page_num(self._placeholder) >= 0 \
                and len(self.pages) == 1:
            self.notebook.remove_page(
                self.notebook.page_num(self._placeholder))
        self.notebook.set_current_page(
            self.notebook.page_num(page.root))
        page.canvas.fit_piece()
        page.overview.fit()
        self._set_status(
            f"Opened '{session.name}' — the whole piece, "
            f"{len(session.element.points)} points. Drag a point "
            "to move it.")
        self._refresh_save_state()
        return page

    def _on_open_piece(self, _item=None):
        """File -> Open Piece…: pick a zone (downloads on demand),
        then a piece from its downloaded list."""
        dialog = Gtk.Dialog(title="Open a road piece",
                            transient_for=self, flags=0)
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        open_btn = dialog.add_button("Open", Gtk.ResponseType.OK)
        open_btn.set_sensitive(False)
        dialog.set_default_size(560, 520)
        box = dialog.get_content_area()
        box.set_spacing(8)
        box.set_border_width(10)
        box.pack_start(layout_mod.section_label("1 · Zone"),
                       False, False, 0)
        zone_combo = Gtk.ComboBoxText()
        for zid in ZONE_IDS:
            zone_combo.append_text(zid)
        zone_combo.set_active(0)
        box.pack_start(zone_combo, False, False, 0)
        box.pack_start(layout_mod.section_label("2 · Piece"),
                       False, False, 0)
        filter_entry = Gtk.Entry()
        filter_entry.set_placeholder_text("Filter by name…")
        box.pack_start(filter_entry, False, False, 0)
        store = Gtk.ListStore(str, str, int)  # name, category, index
        view = Gtk.TreeView(model=store)
        view.set_headers_visible(False)
        view.append_column(Gtk.TreeViewColumn("Piece",
                                              Gtk.CellRendererText(),
                                              text=0))
        view.append_column(Gtk.TreeViewColumn("Category",
                                              Gtk.CellRendererText(),
                                              text=1))
        scroll = layout_mod.scrolled(view)
        scroll.set_min_content_height(260)
        box.pack_start(scroll, True, True, 0)
        hint = layout_mod.hint_label("Pick a zone to download its "
                                     "piece list.")
        box.pack_start(hint, False, False, 0)
        state = {"model": None, "rows": []}

        def fill_list():
            """(Re)fill the piece list from the loaded zone, with
            the name filter applied; capped for lightness."""
            store.clear()
            state["rows"] = []
            if state["model"] is None:
                return
            needle = filter_entry.get_text().strip().casefold()
            count = 0
            for cat, records in state["model"].roads.items():
                for i, rec in enumerate(records):
                    nm = rec.get("name") or detaildata.UNNAMED_NAME
                    if needle and needle not in nm.casefold():
                        continue
                    store.append([f"{nm}  ({len(rec.get('pts') or [])}"
                                  f" pts)", cat, i])
                    state["rows"].append((cat, i))
                    count += 1
                    if count >= 4000:   # a filter narrows from here
                        break
                if count >= 4000:
                    break
            hint.set_text(f"{count} pieces listed"
                          + (" (list capped — type to filter)"
                             if count >= 4000 else "")
                          + ". Double-click opens.")

        def on_zone_changed(_combo):
            zone = zone_combo.get_active_text()
            open_btn.set_sensitive(False)
            hint.set_text(f"Downloading {zone}…")

            def work():
                self.progress_start("zone", f"Downloading {zone}…")
                try:
                    return self.data.load_zone(
                        zone, progress=self._progress_cb(
                            "zone", f"{zone} roads"))
                finally:
                    GLib.idle_add(self.progress_finish, "zone")

            def done(model, err):
                if err is not None:
                    hint.set_text(f"Could not download {zone}: {err}")
                    return False
                state["model"] = model
                fill_list()
                return False

            self._run_background(work, done)

        def on_selection_changed(_sel):
            _model, it = _sel.get_selected()
            open_btn.set_sensitive(it is not None)

        view.get_selection().connect("changed", on_selection_changed)
        filter_entry.connect("changed", lambda _e: fill_list())
        zone_combo.connect("changed", on_zone_changed)
        view.connect("row-activated",
                     lambda *_a: dialog.response(Gtk.ResponseType.OK))
        dialog.show_all()
        on_zone_changed(zone_combo)
        resp = dialog.run()
        chosen = None
        if resp == Gtk.ResponseType.OK:
            _model, it = view.get_selection().get_selected()
            if it is not None:
                row = store.get_path(it).get_indices()[0]
                chosen = state["rows"][row]
        model = state["model"]
        dialog.destroy()
        if chosen is not None and model is not None:
            self._open_piece(model, chosen[0], chosen[1], "picked")

    # ------------------------------------------------------------------
    # Pages, tools, undo
    # ------------------------------------------------------------------

    def _current_page(self):
        """The PiecePage of the notebook's current page, or None.
        Construction-safe: toolbar toggles fire while the window is
        still being built, before the notebook exists — those early
        calls mean "no page yet", not a crash."""
        notebook = getattr(self, "notebook", None)
        if notebook is None:
            return None
        n = notebook.get_current_page()
        if n < 0:
            return None
        widget = self.notebook.get_nth_page(n)
        for page in self.pages:
            if page.root is widget:
                return page
        return None

    def _on_switch_page(self, _nb, _page, _num):
        """A tab switch re-arms the toolbar to the page's canvas
        state and refreshes the Save buttons (via idle, so the new
        page is current when we read it)."""
        GLib.idle_add(self._sync_toolbar_to_page)
        return False

    def _sync_toolbar_to_page(self):
        page = self._current_page()
        tool = page.canvas.tool if page else "select"
        self._setting_tool = True
        for name, btn in self.tool_buttons.items():
            btn.set_active(name == tool)
        self._setting_tool = False
        if page:
            self.orbit_button.set_active(page.canvas.orbit_mode)
        self._refresh_save_state()
        self._refresh_undo_buttons()
        self._refresh_delete_button()
        return False

    def _on_tool_toggled(self, btn, name):
        """Tool toggles: exactly one active (Select = base state);
        the hint line follows the tool."""
        if getattr(self, "_setting_tool", False):
            return
        if not btn.get_active():
            # Turning the active one off returns to the base state.
            if name != "select":
                self._setting_tool = True
                self.tool_buttons["select"].set_active(True)
                self._setting_tool = False
                name = "select"
            else:
                btn.set_active(True)
                return
        self._setting_tool = True
        for other, obtn in self.tool_buttons.items():
            if other != name:
                obtn.set_active(False)
        self._setting_tool = False
        for _n, _label, hint in TOOLS:
            if _n == name:
                self.tool_hint.set_text(hint)
                self.tool_hint.set_tooltip_text(hint)
        page = self._current_page()
        if page is not None:
            page.canvas.set_tool(name)
            page.canvas.grab_focus()

    def _on_orbit_toggled(self, btn):
        page = self._current_page()
        if page is not None:
            page.canvas.orbit_mode = btn.get_active()

    def _on_fit(self, _btn):
        page = self._current_page()
        if page is not None:
            page.canvas.fit_piece()
            page.overview.fit()

    def _on_page_snapshot(self, page):
        """The canvas is about to mutate the element: keep the
        pre-edit state for Undo (cap the stack — pieces are small,
        but a long session shouldn't grow without bound)."""
        page.undo_stack.append(page.session.element.snapshot())
        if len(page.undo_stack) > 100:
            page.undo_stack.pop(0)
        page.redo_stack.clear()
        self._refresh_undo_buttons()

    def _on_page_edited(self, page):
        """A mutation landed: the session is dirty; readouts and
        stills refresh."""
        page.session.mark_dirty()
        page.refresh_info()
        page.overview.invalidate()
        self._refresh_save_state()
        self._refresh_undo_buttons()

    # ------------------------------------------------------------------
    # Selection, the portion menu, click-switch (1.2.0)
    # ------------------------------------------------------------------

    def _on_selection_changed(self, page):
        """The canvas's point selection/focus changed: the info
        pane's Selected line and the Delete Selected button
        follow."""
        page.refresh_info()
        if page is self._current_page():
            self._refresh_delete_button()

    def _refresh_delete_button(self):
        """Delete Selected is live exactly while the current
        page's canvas holds a point selection; the label carries
        the count."""
        page = self._current_page()
        n = len(page.canvas.selected_points) if page else 0
        self.delete_selected_button.set_sensitive(n > 0)
        self.delete_selected_button.set_label(
            f"Delete Selected ({n})" if n else "Delete Selected")

    def _on_delete_selected(self, _btn):
        page = self._current_page()
        if page is not None:
            page.canvas.delete_selected_points()

    def _show_canvas_menu(self, page, event):
        """
        The canvas's right-click menu (Joshua, 2026-10-25): the
        home for the portion/selection verbs, where the hand
        already is — RESEGMENT first, as he named it. ADDITIVE:
        every verb here also lives somewhere else (toolbar,
        keys); nothing was removed to make room for it. Entries
        grey out honestly when they have nothing to act on.
        """
        canvas = page.canvas
        menu = Gtk.Menu()
        focus = canvas.focus_points()
        selected = canvas.selected_points

        def item(label, action, sensitive=True):
            entry = Gtk.MenuItem(label=label)
            entry.set_sensitive(sensitive)
            if action is not None:
                entry.connect("activate", lambda _i: action())
            menu.append(entry)
            return entry

        item("Resegment — fine points in this portion",
             canvas.resegment_focus, bool(focus))
        item("Coarsen this portion",
             canvas.coarsen_focus,
             bool(focus & canvas.fine_points))
        menu.append(Gtk.SeparatorMenuItem())
        item(f"Delete selected points ({len(selected)})",
             canvas.delete_selected_points, bool(selected))
        item("Clear selection", canvas.clear_selection,
             bool(selected or focus))
        menu.append(Gtk.SeparatorMenuItem())
        item("Zoom to fit the portion",
             lambda: self._zoom_to_focus(page), bool(focus))
        item("Show the whole piece",
             lambda: (canvas.fit_piece(), page.overview.fit()))
        menu.show_all()
        menu.popup_at_pointer(event)

    def _zoom_to_focus(self, page):
        """Frame the focused portion in the working canvas."""
        canvas = page.canvas
        pts = [canvas.session.element.points[i]
               for i in sorted(canvas.focus_points())]
        if not pts:
            return
        alloc = canvas.get_allocation()
        pad = canvas.piece_width
        xs = [p[0] for p in pts]
        zs = [p[1] for p in pts]
        canvas.camera.fit_rect(
            (min(xs) - pad, min(zs) - pad,
             max(xs) + pad, max(zs) + pad),
            max(alloc.width, 2), max(alloc.height, 2), margin=1.3)
        canvas.invalidate()

    def _switch_to_piece(self, page, category, index, pts):
        """
        CLICK-SWITCH (Joshua's rule, 2026-10-25): a clean click
        on another road makes it the working piece — and the
        current piece's edit progress SAVES FIRST when it has
        any. Clean piece: the clicked road opens at once. Dirty:
        the zone's round trip runs; only on success does the
        clicked road open (a failed save keeps the user where
        they are, looking at the piece that still needs saving).
        The clicked record is re-found by its POINTS after any
        save — indices can shift when a split added records;
        geometry does not lie.
        """
        model = page.session.model
        target_pts = [list(p) for p in pts]

        def open_target():
            found = detaildata.find_piece(
                model.roads, category, "", target_pts)
            # Only an EXACT geometry match may open — find_piece's
            # centroid fallback could land on a different road,
            # and switching to the wrong piece silently is worse
            # than not switching.
            if found is None or found[2] != "exact":
                self._set_status(
                    "The road you clicked could not be found "
                    "again in the zone data — nothing switched.")
                return
            cat, idx, _how = found
            self._open_piece(model, cat, idx, "switch")
            name = (model.roads[cat][idx].get("name")
                    or detaildata.UNNAMED_NAME)
            self._set_status(
                f"Now editing '{name}' — the whole piece, "
                f"highlighted as the working piece.")

        if page.session.dirty:
            self._set_status(
                "Saving this piece's edits before switching…")
            self._save_zone(
                model, after=lambda ok: ok and open_target())
        else:
            open_target()

    def _on_page_renamed(self, page, raw):
        """
        A rename confirmed from the tab's pencil. The new name
        is a changed variable like any geometry edit: it marks
        the session dirty and rides the EXISTING save round trip
        — the write-back takes every field from the session
        template, the name included (after a split, the
        resulting records share the new name, exactly as they
        shared the old one). Only THIS piece's record changes;
        other pieces that happen to share the old name keep it.
        """
        new = page.session.rename(raw)
        if new is None:
            page.refresh_tab_title()
            self._set_status(
                f"The name is unchanged ('{page.session.name}').")
            return
        page.session.mark_dirty()
        page.refresh_tab_title()
        page.refresh_info()
        page.overview.invalidate()
        self._refresh_save_state()
        self._set_status(
            f"Renamed to '{new}' — Save pushes the new name to "
            "GitHub with the piece's other edits.")

    def _on_undo(self, _btn):
        page = self._current_page()
        if page is None or not page.undo_stack:
            return
        page.redo_stack.append(page.session.element.snapshot())
        page.session.element.restore(page.undo_stack.pop())
        # Point indices may have shifted under the restore: the
        # selection and the density layer reset with the element.
        page.canvas.clear_selection()
        page.canvas.reset_segmentation()
        page.canvas.invalidate()
        self._on_page_edited(page)
        self._set_status("Undid the last edit.")

    def _on_redo(self, _btn):
        page = self._current_page()
        if page is None or not page.redo_stack:
            return
        page.undo_stack.append(page.session.element.snapshot())
        page.session.element.restore(page.redo_stack.pop())
        page.canvas.clear_selection()
        page.canvas.reset_segmentation()
        page.canvas.invalidate()
        self._on_page_edited(page)
        self._set_status("Redid the edit.")

    def _refresh_undo_buttons(self):
        page = self._current_page()
        self.undo_button.set_sensitive(
            bool(page and page.undo_stack))
        self.redo_button.set_sensitive(
            bool(page and page.redo_stack))

    def _confirm_points(self, n_points):
        """A lasso group deletion asks first, in the section
        deletion's own pattern (it is the same class of act:
        many points and the face between them, gone at once).
        Undo can still bring them back until a save."""
        dialog = Gtk.MessageDialog(
            transient_for=self, flags=0,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.OK_CANCEL,
            text="Delete the selected points?")
        dialog.format_secondary_text(
            f"{n_points} point(s) will be deleted together, "
            "with every segment touching them — a middle run "
            "leaves the piece in two parts; an end run shortens "
            "it. It is ONE operation: one Undo brings them all "
            "back, until you save.")
        resp = dialog.run()
        dialog.destroy()
        return resp == Gtk.ResponseType.OK

    def _confirm_section(self, n_points, n_segments):
        """Section deletion is the one destructive click that asks
        first (Joshua's care with deletion): it names what goes —
        the lines AND the face inside them — before anything is
        removed. Undo can still bring it back until a save."""
        dialog = Gtk.MessageDialog(
            transient_for=self, flags=0,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.OK_CANCEL,
            text="Delete this section?")
        dialog.format_secondary_text(
            f"{n_segments} segment(s) and the {max(n_points, 0)} "
            "point(s) inside them will be deleted, with the street "
            "face inside them — the two ends join straight. "
            "Undo can bring it back until you save.")
        resp = dialog.run()
        dialog.destroy()
        return resp == Gtk.ResponseType.OK

    # ------------------------------------------------------------------
    # Closing pages + the window
    # ------------------------------------------------------------------

    def _close_page(self, page):
        """Close one tab. A dirty page asks: save its zone first,
        discard the edits, or keep the tab."""
        if page.session.dirty:
            dialog = Gtk.MessageDialog(
                transient_for=self, flags=0,
                message_type=Gtk.MessageType.WARNING,
                buttons=Gtk.ButtonsType.NONE,
                text=f"'{page.session.name}' has unsaved changes")
            dialog.format_secondary_text(
                "Save the zone's changes to GitHub, discard this "
                "piece's unsaved edits, or keep the tab open?")
            dialog.add_button("Keep open", Gtk.ResponseType.CANCEL)
            dialog.add_button("Discard edits",
                              Gtk.ResponseType.REJECT)
            dialog.add_button("Save", Gtk.ResponseType.APPLY)
            resp = dialog.run()
            dialog.destroy()
            if resp == Gtk.ResponseType.CANCEL:
                return
            if resp == Gtk.ResponseType.APPLY:
                self._save_zone(page.session.model,
                                after=lambda ok: ok and
                                self._finish_close_page(page))
                return
            # Discard: fall through and close.
        self._finish_close_page(page)

    def _finish_close_page(self, page):
        self.notebook.remove_page(self.notebook.page_num(page.root))
        self.pages.remove(page)
        if not self.pages \
                and self.notebook.page_num(self._placeholder) < 0:
            self.notebook.append_page(
                self._placeholder,
                Gtk.Label(label="Detail Editor"))
        self._refresh_save_state()

    # ------------------------------------------------------------------
    # Saving (the round trip)
    # ------------------------------------------------------------------

    def _refresh_save_state(self):
        """Save is live when any open zone holds unsaved splices —
        i.e. any session is dirty, or a session's zone serialises
        differently from its download (post-splice)."""
        dirty = any(p.session.dirty for p in self.pages)
        self.save_button.set_sensitive(dirty)
        self.save_item.set_sensitive(dirty)

    def _on_save(self, _widget=None):
        """Save the CURRENT page's zone: every dirty session of
        that zone is spliced in, then the round trip runs."""
        page = self._current_page()
        if page is None:
            self._set_status("Nothing is open to save.")
            return
        model = page.session.model
        dirty_sessions = [p.session for p in self.pages
                          if p.session.model is model
                          and p.session.dirty]
        if not dirty_sessions:
            self._set_status("No unsaved changes in this zone.")
            return
        # A plain-language review before anything is pushed.
        names = ", ".join(f"'{s.name}'" for s in dirty_sessions)
        dialog = Gtk.MessageDialog(
            transient_for=self, flags=0,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.OK_CANCEL,
            text=f"Save {model.name} to GitHub?")
        dialog.format_secondary_text(
            f"Pieces changed: {names}.\n\nThe zone's roads file "
            "(with its .js twin) is saved locally, pushed to "
            "GitHub, then downloaded again — the copy you end up "
            "looking at is the downloaded one, verified against "
            "what was pushed. No other zone is touched, and no "
            "elevation data is written.")
        resp = dialog.run()
        dialog.destroy()
        if resp != Gtk.ResponseType.OK:
            return
        self._save_zone(model)

    def _save_zone(self, model, after=None):
        """
        Splice every dirty session of the zone into its document,
        then run the round trip in the background under the
        progress bar. On success the sessions rebind to the
        downloaded copy. `after(ok)` runs on the UI thread.
        """
        sessions = [p.session for p in self.pages
                    if p.session.model is model and p.session.dirty]
        try:
            for session in sessions:
                session.apply_to_doc()
        except DetailDataError as e:
            self._set_status(f"Save stopped: {e}")
            if after is not None:
                after(False)
            return

        def work():
            self.progress_start("save", f"Saving {model.name}…")
            try:
                return self.data.save_zone(model, LOCAL_SAVE_DIR,
                                           github_sync)
            finally:
                GLib.idle_add(self.progress_finish, "save")

        def done(result, err):
            if err is not None:
                self._set_status(f"Save failed: {err}")
                if after is not None:
                    after(False)
                return False
            ok, message = result
            self._set_status(message if ok else f"Save: {message}")
            if ok:
                for session in sessions:
                    session.rebind_after_save()
                for page in self.pages:
                    if page.session.model is model:
                        # The zone document was replaced by the
                        # downloaded copy: the page's cached
                        # context index describes the OLD records
                        # — drop it (it rebuilds on next render).
                        page._context_cache = None
                        page.refresh_info()
                        page.refresh_tab_title()
                        page.canvas.invalidate()
                        page.overview.invalidate()
                self._refresh_save_state()
            if after is not None:
                after(ok)
            return False

        self._run_background(work, done)

    # ------------------------------------------------------------------
    # Keys, updates, about, close
    # ------------------------------------------------------------------

    def _on_key(self, _widget, event):
        """Esc steps back one layer at a time (measure mode,
        then the selection/focus, then the armed tool); Delete
        removes the selected points together; + / − zoom the
        current canvas; Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z)
        undo/redo."""
        key = event.keyval
        page = self._current_page()
        if key == Gdk.KEY_Escape:
            if page is not None and page.canvas.measure_mode:
                page.canvas.exit_measure()
                self._set_status("Measure off.")
                return True
            if page is not None and (page.canvas.selected_points
                                     or page.canvas.focus_chain
                                     is not None):
                page.canvas.clear_selection()
                self._set_status("Selection cleared.")
                return True
            self._setting_tool = True
            for name, btn in self.tool_buttons.items():
                btn.set_active(name == "select")
            self._setting_tool = False
            if page is not None:
                page.canvas.set_tool("select")
            self.tool_hint.set_text(TOOLS[0][2])
            self.tool_hint.set_tooltip_text(TOOLS[0][2])
            return True
        if page is None:
            return False
        if key in (Gdk.KEY_Delete, Gdk.KEY_BackSpace) \
                and not (event.state & Gdk.ModifierType
                         .CONTROL_MASK) \
                and page.canvas.selected_points:
            page.canvas.delete_selected_points()
            return True
        ctrl = event.state & Gdk.ModifierType.CONTROL_MASK
        if ctrl and key in (Gdk.KEY_z, Gdk.KEY_Z):
            if event.state & Gdk.ModifierType.SHIFT_MASK:
                self._on_redo(None)
            else:
                self._on_undo(None)
            return True
        if ctrl and key in (Gdk.KEY_y, Gdk.KEY_Y):
            self._on_redo(None)
            return True
        if key in (Gdk.KEY_plus, Gdk.KEY_KP_Add, Gdk.KEY_equal):
            page.canvas.zoom_step(1.2)
            return True
        if key in (Gdk.KEY_minus, Gdk.KEY_KP_Subtract,
                   Gdk.KEY_underscore):
            page.canvas.zoom_step(1 / 1.2)
            return True
        return False

    def _on_about(self, _item):
        about_mod.show_about_dialog(self, APP_NAME, APP_VERSION,
                                    ICON_NAME, PACKAGE_NAME)

    def _on_check_updates(self, _item):
        """Help -> Check for Updates (suite_core.updater v3).

        The v3 semantics: an update that is already staged is
        reported first — it runs on the next launch — and that
        answer is truthful even with the network down. A newer
        version on this app's channel is a SELF-UPDATE channel:
        on the user's go-ahead it stages into their own updates
        folder (no .deb, no admin password) and runs next
        launch — never the v2 "install the new .deb the usual
        way" flow. The helper runs its own worker thread and
        marshals its dialogs back onto the UI thread, so it is
        called directly from here. Fail-open: a broken updater
        shows nothing rather than breaking the menu.
        """
        try:
            updater_mod.check_for_updates_gui(
                self, APP_NAME, APP_VERSION, "detail-editor",
                _CHANNEL_MANIFEST_URL)
        except Exception:
            pass

    def _on_delete(self, _window, _event):
        """Remember the window geometry; unsaved edits get one
        plain question before the window goes."""
        size = self.get_size()
        self._state.remember_size("main", (size.width, size.height))
        for page in self.pages:
            self._state.remember_pane(
                "page-split", page.root.get_position())
            self._state.remember_pane(
                "page-vsplit", page.right_pane.get_position())
            break
        self._state.save()
        dirty = [p for p in self.pages if p.session.dirty]
        if not dirty:
            return False
        names = ", ".join(f"'{p.session.name}'" for p in dirty)
        dialog = Gtk.MessageDialog(
            transient_for=self, flags=0,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.NONE,
            text="Unsaved changes")
        dialog.format_secondary_text(
            f"{names} changed but not saved. Close anyway and "
            "lose those edits?")
        dialog.add_button("Keep editing", Gtk.ResponseType.CANCEL)
        dialog.add_button("Close", Gtk.ResponseType.OK)
        resp = dialog.run()
        dialog.destroy()
        return resp != Gtk.ResponseType.OK


def main():
    """Entry point: crash log in place, window up, GTK main loop."""
    _install_crash_log()
    win = DetailWindow()
    win.connect("destroy", Gtk.main_quit)
    Gtk.main()


if __name__ == "__main__":
    main()
