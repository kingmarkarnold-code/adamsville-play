#!/usr/bin/env python3
"""
Adamsville Elevation Editor (Native) 1.0.0 — main window.

Joshua's design (game-map/ELEVATION-EDITOR-DESIGN.md, 2026-10-17):
a 3D viewport — NOT elevation lines — where you highlight a stretch
of road, press "Change elevation", and lift the TERRAIN; the road
moves with the terrain, the lift forms a smooth hill, and Submit
resolidifies everything (terrain lifts + the roads' draped shape
are written back, baked, by the full round-trip save rule).

THE FLOW
  1. Pick a zone        — its files download (shared suite cache).
  2. Pick a road        — the viewport shows that road in its
                          terrain, with the roads around it.
  3. Mark the stretch   — click the road in the view to set the
                          start, click again for the end.
  4. Change elevation   — the stretch is segmented automatically;
                          drag up/down in the view (or use the
                          height slider) to raise/lower the hill.
  5. Submit             — review the plain-language summary, then
                          the round trip pushes it to GitHub and
                          shows the verified copy.

v1 interaction note (honest scope): the design's Android-style
selection HANDLES + magnifier are the refinement layer (see the
1.0 notes). v1 marks the stretch by clicking its two ends on the
3D view — the same selection, a simpler input, nothing faked.

Everything generic lives in suite_core (viewport, ground, GitHub
round-trip, cache, layout, About, updater); this file is the
elevation-specific window + flow. Joshua's rule: all code commented.
"""

import math
import sys
import threading
import traceback
from pathlib import Path

# The app dir rides on sys.path (the launcher runs this file by
# path); the vendored suite_core package sits next to it.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gtk, Gdk, GLib

from suite_core import about as about_mod
from suite_core import github_sync
from suite_core import layout as layout_mod
from suite_core import shared_cache
from suite_core import updater as updater_mod
from suite_core.ground import GroundWithLifts, point_at_arc, \
    polyline_arcs
from suite_core.viewport3d import Viewport3D

import elevdata
from elevdata import ElevationData, ElevDataError, HillSession, \
    ZONE_IDS, zone_path

# Identity (About, data dir, repo versioning).
APP_NAME = "Adamsville Elevation Editor"
APP_VERSION = elevdata.EDITOR_VERSION
PACKAGE_NAME = "adamsville-elevation-editor-native"
ICON_NAME = "adamsville-elevation-editor-native"
APP_REPO_DIR = "editors/elevation-editor"

# Per-app data (window state, pending saves) — never the shared
# cache (that is suite_core.shared_cache's, by design).
DATA_DIR = Path.home() / ".local" / "share" / PACKAGE_NAME
CACHE_LOG_DIR = Path.home() / ".cache" / PACKAGE_NAME

# Peak lift range (world units): a carve of 12 or a hill of 18 is
# already dramatic against the game's ~60u of total relief.
PEAK_MIN, PEAK_MAX = -12.0, 18.0
# Default peak when Change Elevation is first pressed.
PEAK_DEFAULT = 4.0
# Default falloff tail: this fraction of the stretch's length on
# each side (the Width slider adjusts it, in world units).
TAIL_FRACTION = 0.6
# How far around the selected road the snapshot viewport reaches.
SNAPSHOT_MARGIN = 240.0


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


class ElevationWindow(Gtk.Window):
    """The editor's one window (see the module docstring's flow)."""

    def __init__(self):
        """Build the window; start the manifest download."""
        super().__init__(title=f"{APP_NAME} {APP_VERSION}")
        self._state = layout_mod.WindowState(DATA_DIR / "window.json")
        cls, _sw, _sh = layout_mod.screen_class()
        # Screen-class variant: laptop gets the narrower control
        # pane + tighter default window; desktop breathes more.
        self._pane_default = 300 if cls == "laptop" else 340
        w, h = self._state.get_size("main", (1240, 720)
                                    if cls == "laptop" else (1360, 800))
        self.set_default_size(w, h)
        self.set_size_request(860, 520)
        try:
            self.set_icon_name(ICON_NAME)
        except Exception:
            pass
        self.connect("delete-event", self._on_delete)

        # -- data + flow state --------------------------------------
        self._fetcher = shared_cache.CachedFetcher(
            github_sync.fetch_file,
            fetch_meta=github_sync.fetch_file_meta,
            fetch_file_progress=github_sync.fetch_file_progress)
        self.data = ElevationData(self._fetcher, github_sync.fetch_file)
        self.zone_state = None        # elevdata.ZoneState
        self.road_ref = None          # (category, index, record)
        self.marks = []               # station indices picked (0..2)
        self.session = None           # HillSession being edited
        self._drag_peak0 = None       # peak when a lift drag began
        self._refresh_pending = False
        self._syncing_slider = False

        self._build_ui()
        self.show_all()
        self.progress.hide()
        # The manifest comes first (freshness for everything else).
        self._run_background(self._load_manifest_bg,
                             self._on_manifest_done)

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _build_ui(self):
        """Menubar (anchored top), paned body (shares + weights),
        status bar (anchored bottom) — the suite layout grammar."""
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.add(root)
        root.pack_start(self._build_menubar(), False, False, 0)
        self.paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self.paned.pack1(self._build_controls(), resize=False,
                         shrink=True)
        self.viewport = Viewport3D()
        self.viewport.on_station_pick = self._on_station_pick
        self.viewport.on_ground_pick = self._on_ground_pick
        self.viewport.on_lift_drag = self._on_lift_drag
        self.paned.pack2(self.viewport, resize=True, shrink=True)
        self.paned.set_position(
            self._state.get_pane("main-split", self._pane_default))
        root.pack_start(self.paned, True, True, 0)
        self.status = Gtk.Statusbar()
        self.status.set_margin_top(0)
        self.status.set_margin_bottom(0)
        root.pack_start(self.status, False, False, 0)
        self._set_status("Downloading the map manifest…")

    def _build_menubar(self):
        """File (token settings, quit) + Help (updates, About)."""
        bar = Gtk.MenuBar()
        file_menu = Gtk.Menu()
        file_item = Gtk.MenuItem(label="File")
        file_item.set_submenu(file_menu)
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

    def _build_controls(self):
        """
        The left control column, inside a scrolled window (the
        suite rule: a long pane scrolls, never clips). Sections
        follow the flow: zone -> road -> stretch -> lift -> submit.
        """
        col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        col.set_border_width(10)
        col.set_size_request(self._pane_default - 20, -1)

        # -- 1 · zone ------------------------------------------------
        col.pack_start(layout_mod.section_label("1 · Pick a zone"),
                       False, False, 0)
        self.zone_combo = Gtk.ComboBoxText()
        for zone in ZONE_IDS:
            self.zone_combo.append_text(zone)
        self.zone_combo.set_active(0)
        col.pack_start(self.zone_combo, False, False, 0)
        self.load_button = Gtk.Button(label="Load zone")
        self.load_button.connect("clicked", self._on_load_zone)
        col.pack_start(self.load_button, False, False, 0)
        self.progress = Gtk.ProgressBar()
        self.progress.set_show_text(True)
        col.pack_start(self.progress, False, False, 0)
        self.zone_info = layout_mod.hint_label(
            "Nothing loaded yet. Loading a zone downloads only that "
            "zone's roads + lifts (a few MB at most).")
        col.pack_start(self.zone_info, False, False, 0)

        # -- 2 · road --------------------------------------------------
        col.pack_start(layout_mod.section_label("2 · Pick a road"),
                       False, False, 0)
        self.road_filter = Gtk.Entry()
        self.road_filter.set_placeholder_text("Filter by name…")
        self.road_filter.connect("changed", self._on_filter_changed)
        col.pack_start(self.road_filter, False, False, 0)
        self.road_list = Gtk.ListBox()
        self.road_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.road_list.connect("row-selected", self._on_road_chosen)
        road_scroll = layout_mod.scrolled(self.road_list)
        road_scroll.set_min_content_height(150)
        col.pack_start(road_scroll, True, True, 0)
        self.road_info = layout_mod.hint_label("Load a zone first.")
        col.pack_start(self.road_info, False, False, 0)

        # -- 3 · stretch -----------------------------------------------
        col.pack_start(layout_mod.section_label("3 · Mark the stretch"),
                       False, False, 0)
        self.mark_info = layout_mod.hint_label(
            "With a road picked, click the road in the 3D view to "
            "set the start of the stretch, then click again for "
            "the end.")
        col.pack_start(self.mark_info, False, False, 0)
        clear_marks = Gtk.Button(label="Clear marks")
        clear_marks.connect("clicked", self._on_clear_marks)
        col.pack_start(clear_marks, False, False, 0)

        # -- 4 · lift ----------------------------------------------------
        col.pack_start(layout_mod.section_label("4 · Change elevation"),
                       False, False, 0)
        self.lift_button = Gtk.Button(
            label="Change elevation (segment + lift)")
        self.lift_button.connect("clicked", self._on_change_elevation)
        self.lift_button.set_sensitive(False)
        col.pack_start(self.lift_button, False, False, 0)
        col.pack_start(layout_mod.hint_label("Hill height (world units)"),
                       False, False, 0)
        self.height_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, PEAK_MIN, PEAK_MAX, 0.1)
        self.height_scale.set_value(PEAK_DEFAULT)
        self.height_scale.set_digits(1)
        self.height_scale.connect("value-changed",
                                  self._on_height_changed)
        self.height_scale.set_sensitive(False)
        col.pack_start(self.height_scale, False, False, 0)
        col.pack_start(layout_mod.hint_label(
            "Hill width — falloff tail on each side (world units)"),
            False, False, 0)
        self.width_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, 0.0, 400.0, 5.0)
        self.width_scale.set_value(60.0)
        self.width_scale.set_digits(0)
        self.width_scale.connect("value-changed",
                                 self._on_width_changed)
        self.width_scale.set_sensitive(False)
        col.pack_start(self.width_scale, False, False, 0)
        self.lift_info = layout_mod.hint_label("")
        col.pack_start(self.lift_info, False, False, 0)
        self.cancel_button = Gtk.Button(label="Cancel this edit")
        self.cancel_button.connect("clicked", self._on_cancel_edit)
        self.cancel_button.set_sensitive(False)
        col.pack_start(self.cancel_button, False, False, 0)

        # -- 5 · submit --------------------------------------------------
        col.pack_start(layout_mod.section_label("5 · Submit"),
                       False, False, 0)
        self.submit_button = Gtk.Button(label="Review + Submit")
        self.submit_button.connect("clicked", self._on_submit)
        self.submit_button.set_sensitive(False)
        col.pack_start(self.submit_button, False, False, 0)
        col.pack_start(layout_mod.hint_label(
            "Submit writes ONLY what changed: the new terrain lifts "
            "and the re-draped roads, pushed to GitHub and verified "
            "by re-download."), False, False, 0)

        outer = layout_mod.scrolled(col)
        outer.set_min_content_width(self._pane_default)
        return outer

    # ------------------------------------------------------------------
    # Small helpers
    # ------------------------------------------------------------------

    def _set_status(self, text):
        """Replace the status bar's message."""
        ctx = self.status.get_context_id("main")
        self.status.pop(ctx)
        self.status.push(ctx, text)

    def _run_background(self, work, done):
        """
        Run work() on a thread; done(result, error) lands back on
        the UI thread via GLib.idle_add. Errors are captured, never
        raised into the void.
        """

        def runner():
            try:
                result = work()
                GLib.idle_add(done, result, None)
            except Exception as e:  # noqa: BLE001 — shown in the UI
                GLib.idle_add(done, None, e)

        threading.Thread(target=runner, daemon=True).start()

    def _progress_cb(self, done_bytes, total_bytes):
        """Download progress (called from worker threads)."""
        frac = (done_bytes / total_bytes) if total_bytes else 0.0
        text = f"{done_bytes / 1e6:.1f} / {total_bytes / 1e6:.1f} MB"

        def apply():
            self.progress.show()
            self.progress.set_fraction(min(1.0, frac))
            self.progress.set_text(text)
            return False

        GLib.idle_add(apply)

    def _progress_done(self):
        """Hide the progress bar (UI thread)."""
        self.progress.hide()
        self.progress.set_fraction(0.0)
        return False

    # ------------------------------------------------------------------
    # Loading flow
    # ------------------------------------------------------------------

    def _load_manifest_bg(self):
        return self.data.load_manifest()

    def _on_manifest_done(self, version, err):
        if err is not None:
            self._set_status(f"Manifest failed: {err}")
            self.zone_info.set_text(
                "The map manifest could not be downloaded — check "
                "the connection and use Load zone to retry.")
            return False
        self._set_status(f"Map version {version}. Pick a zone.")
        return False

    def _on_load_zone(self, _button):
        zone = self.zone_combo.get_active_text()
        if not zone:
            return
        self.load_button.set_sensitive(False)
        self._set_status(f"Loading {zone}…")

        def work():
            self.data.load_ground(progress=self._progress_cb)
            return self.data.load_zone(zone, progress=self._progress_cb)

        def done(zs, err):
            self.load_button.set_sensitive(True)
            GLib.idle_add(self._progress_done)
            if err is not None:
                msg = str(err)
                self._set_status(msg)
                self.zone_info.set_text(msg)
                return False
            self.zone_state = zs
            self._clear_edit()
            n_roads = len(zs.road_records())
            self.zone_info.set_text(
                f"{zs.name}: {n_roads} roads, "
                f"{len(zs.lifts)} terrain lifts on record.")
            self._fill_road_list()
            self._set_status(f"{zs.name} loaded. Pick a road.")
            return False

        self._run_background(work, done)

    def _fill_road_list(self):
        """(Re)build the road list from the loaded zone + filter."""
        for child in self.road_list.get_children():
            self.road_list.remove(child)
        needle = self.road_filter.get_text().strip().lower()
        self._road_rows = []
        for cat, idx, rec in self.zone_state.road_records():
            name = str(rec.get("name") or "Unnamed St")
            if needle and needle not in name.lower():
                continue
            pts = rec.get("pts", [])
            arcs = polyline_arcs(pts) if len(pts) >= 2 else [0.0]
            label = Gtk.Label(
                label=f"{name}  ·  {cat}  ·  {arcs[-1]:.0f} u")
            label.set_xalign(0)
            label.set_margin_start(6)
            label.set_margin_top(3)
            label.set_margin_bottom(3)
            row = Gtk.ListBoxRow()
            row.add(label)
            row._elev_ref = (cat, idx, rec)
            self.road_list.add(row)
            self._road_rows.append(row)
        self.road_list.show_all()

    def _on_filter_changed(self, _entry):
        if self.zone_state is not None:
            self._fill_road_list()

    # ------------------------------------------------------------------
    # Road + stretch selection
    # ------------------------------------------------------------------

    def _on_road_chosen(self, _box, row):
        if row is None or not hasattr(row, "_elev_ref"):
            return
        self._clear_edit()
        self.road_ref = row._elev_ref
        cat, _idx, rec = self.road_ref
        self.road_info.set_text(
            f"{rec.get('name') or 'Unnamed St'} ({cat}). Now click "
            "the road in the 3D view to mark the stretch.")
        self._refresh_scene()

    def _on_station_pick(self, _key, station_index):
        """Viewport click on the selected road: set start, then end."""
        if self.road_ref is None or self.session is not None:
            return
        _cat, _idx, rec = self.road_ref
        pts = rec.get("pts", [])
        if not (0 <= station_index < len(pts)):
            return
        if len(self.marks) >= 2:
            self.marks = []
        self.marks.append(station_index)
        arcs = polyline_arcs(pts)
        if len(self.marks) == 1:
            self.mark_info.set_text(
                f"Start marked at {arcs[station_index]:.0f} u along "
                "the road. Click further along for the end.")
        else:
            a, b = sorted((arcs[self.marks[0]], arcs[self.marks[1]]))
            self.mark_info.set_text(
                f"Stretch marked: {a:.0f} u → {b:.0f} u "
                f"({b - a:.0f} u long). Press Change elevation.")
            self.lift_button.set_sensitive(True)
        self._refresh_scene()

    def _on_ground_pick(self, x, z):
        """Click off the road: just re-centre the view there."""
        self.viewport.set_target(x, z)

    def _on_clear_marks(self, _button):
        if self.session is not None:
            return  # marks are baked into the session; Cancel first
        self.marks = []
        self.lift_button.set_sensitive(False)
        self.mark_info.set_text(
            "Marks cleared. Click the road to set the start.")
        self._refresh_scene()

    # ------------------------------------------------------------------
    # The lift session
    # ------------------------------------------------------------------

    def _on_change_elevation(self, _button):
        """Segment the stretch and open the lift for editing."""
        if self.road_ref is None or len(self.marks) != 2:
            return
        cat, idx, rec = self.road_ref
        pts = rec.get("pts", [])
        arcs = polyline_arcs(pts)
        a, b = sorted((arcs[self.marks[0]], arcs[self.marks[1]]))
        tail = max(10.0, (b - a) * TAIL_FRACTION)
        self.session = HillSession(self.zone_state, cat, idx, a, b,
                                   peak=PEAK_DEFAULT, tail=tail)
        try:
            self.session.solve()
        except ElevDataError as e:
            self.session = None
            self.mark_info.set_text(str(e))
            return
        self._syncing_slider = True
        self.height_scale.set_value(PEAK_DEFAULT)
        self.width_scale.set_value(min(400.0, tail))
        self._syncing_slider = False
        self.height_scale.set_sensitive(True)
        self.width_scale.set_sensitive(True)
        self.cancel_button.set_sensitive(True)
        self.submit_button.set_sensitive(True)
        self.lift_button.set_sensitive(False)
        self.viewport.set_lift_mode(True)
        self.viewport.set_hint(
            "Drag up/down to lift · drag empty space to orbit · "
            "wheel zooms")
        self._update_lift_info()
        self._refresh_scene()

    def _on_height_changed(self, scale):
        if self.session is None or self._syncing_slider:
            return
        self.session.peak = float(scale.get_value())
        self._resolve_session()

    def _on_width_changed(self, scale):
        if self.session is None or self._syncing_slider:
            return
        self.session.tail = float(scale.get_value())
        total = polyline_arcs(self.session.base_pts)[-1]
        self.session.s0 = max(0.0, self.session.s_start
                              - self.session.tail)
        self.session.s1 = min(total, self.session.s_end
                              + self.session.tail)
        self._resolve_session()

    def _on_lift_drag(self, total_delta):
        """Viewport vertical drag: peak = peak-at-drag-start + the
        drag's total (the viewport reports from the drag's start)."""
        if self.session is None:
            return
        if self._drag_peak0 is None:
            self._drag_peak0 = self.session.peak
        new_peak = max(PEAK_MIN, min(PEAK_MAX,
                                     self._drag_peak0 + total_delta))
        if abs(new_peak - self.session.peak) < 0.02:
            return
        self.session.peak = new_peak
        self._syncing_slider = True
        self.height_scale.set_value(new_peak)
        self._syncing_slider = False
        self._resolve_session()

    def _resolve_session(self):
        """Re-solve the hill after a control change (coalesced so
        a drag doesn't solve per pixel)."""
        if self.session is None:
            return
        if self._refresh_pending:
            return
        self._refresh_pending = True

        def apply():
            self._refresh_pending = False
            self._drag_peak0 = None
            if self.session is not None:
                try:
                    self.session.solve()
                except ElevDataError:
                    pass
                self._update_lift_info()
                self._refresh_scene()
            return False

        GLib.timeout_add(70, apply)

    def _update_lift_info(self):
        s = self.session
        if s is None:
            self.lift_info.set_text("")
            return
        direction = "hill" if s.peak >= 0 else "carve (dig down)"
        self.lift_info.set_text(
            f"{direction.capitalize()}: peak {s.peak:+.1f} u, "
            f"{len(s.lifts)} terrain lifts, fits the wanted shape "
            f"within {s.max_error:.2f} u.")

    def _on_cancel_edit(self, _button):
        self._clear_edit()
        self._refresh_scene()

    def _clear_edit(self):
        """Drop marks + session and reset the lift controls."""
        self.marks = []
        self.session = None
        self._drag_peak0 = None
        self.lift_button.set_sensitive(False)
        self.height_scale.set_sensitive(False)
        self.width_scale.set_sensitive(False)
        self.cancel_button.set_sensitive(False)
        self.submit_button.set_sensitive(False)
        self.viewport.set_lift_mode(False)
        self.viewport.set_hint("")
        self.lift_info.set_text("")

    # ------------------------------------------------------------------
    # Scene building
    # ------------------------------------------------------------------

    def _display_roads(self, extent):
        """
        Viewport road records for the snapshot: the selected road
        at its working shape, neighbours at their shipped heights —
        except, while a session is live, every point inside the
        lifts' reach shows the PREVIEW drape (the ground as it will
        be), so the hill reads correctly before Submit.
        """
        zs = self.zone_state
        session = self.session
        preview = None
        if session is not None and self.data.ground is not None:
            preview = session.preview_ground(self.data.ground,
                                             zs.lifts)
        reach = session.influence_reach() if session else 0.0
        centers = [(L["x"], L["z"]) for L in session.lifts] \
            if session else []

        def near_edit(x, z):
            for cx, cz in centers:
                if (x - cx) ** 2 + (z - cz) ** 2 < reach * reach:
                    return True
            return False

        out = []
        for cat, idx, rec in self.data.snapshot_roads(zs.zone, extent):
            key = (cat, idx)
            pts = [[float(p[0]), float(p[1])]
                   for p in rec.get("pts", [])]
            ys = list(rec.get("ys", []))
            if session is not None and key == (session.category,
                                               session.index):
                # The edited road at its working shape: segmented
                # stations; preview drape inside the influence, the
                # shipped ys (matched by arc) outside it.
                pts = session.new_pts
                shipped = {round(a, 6): y for a, y in
                           zip(session.base_arcs, session.base_ys)}
                ys = []
                for (x, z), s in zip(pts, session.new_arcs):
                    if session.s0 - 1e-6 <= s <= session.s1 + 1e-6:
                        ys.append(preview.drape_y(x, z))
                    else:
                        ys.append(shipped.get(
                            round(s, 6),
                            preview.drape_y(x, z)))
            elif preview is not None:
                ys = [preview.drape_y(x, z) if near_edit(x, z) else y
                      for (x, z), y in zip(pts, ys)]
            out.append({"key": key, "name": rec.get("name"),
                        "category": cat, "pts": pts, "ys": ys})
        return out

    def _refresh_scene(self):
        """Rebuild the viewport scene around the selected road."""
        if self.zone_state is None or self.road_ref is None \
                or self.data.ground is None:
            return
        zs = self.zone_state
        _cat, _idx, rec = self.road_ref
        pts = rec.get("pts", [])
        if len(pts) < 2:
            return
        xs = [p[0] for p in pts]
        zsv = [p[1] for p in pts]
        extent = (min(xs) - SNAPSHOT_MARGIN, min(zsv) - SNAPSHOT_MARGIN,
                  max(xs) + SNAPSHOT_MARGIN, max(zsv) + SNAPSHOT_MARGIN)
        # The terrain sampler: current ground (with the zone's
        # lifts, plus the session's trial lifts while editing).
        if self.session is not None:
            ground = self.session.preview_ground(self.data.ground,
                                                 zs.lifts)
        else:
            ground = GroundWithLifts(self.data.ground, zs.lifts)
        span = max(extent[2] - extent[0], extent[3] - extent[1])
        step = max(8.0, min(30.0, span / 70.0))
        self.viewport.set_terrain(ground.height_at, extent, step=step)
        self.viewport.set_roads(self._display_roads(extent))
        key = (self.road_ref[0], self.road_ref[1])
        self.viewport.set_active_road(key)
        # Highlight + markers for marks / session.
        arcs = polyline_arcs(pts)
        if self.session is not None:
            s = self.session
            self.viewport.set_highlight(s.s_start, s.s_end)
            # Start/end markers sit at the STRETCH ends (on the
            # segmented line), the crest marker at the hill's top.
            sx, sz = point_at_arc(s.new_pts, s.new_arcs, s.s_start)
            ex, ez = point_at_arc(s.new_pts, s.new_arcs, s.s_end)
            cx, cz = point_at_arc(s.new_pts, s.new_arcs, s.crest)
            self.viewport.set_markers([
                {"x": sx, "z": sz,
                 "y": ground.height_at(sx, sz), "kind": "start"},
                {"x": ex, "z": ez,
                 "y": ground.height_at(ex, ez), "kind": "end"},
                {"x": cx, "z": cz,
                 "y": ground.height_at(cx, cz), "kind": "crest"}])
        elif len(self.marks) == 2:
            a, b = sorted((arcs[self.marks[0]], arcs[self.marks[1]]))
            self.viewport.set_highlight(a, b)
            self.viewport.set_markers([
                {"x": pts[i][0], "z": pts[i][1],
                 "y": rec.get("ys", [0] * len(pts))[i],
                 "kind": "start" if k == 0 else "end"}
                for k, i in enumerate(self.marks)])
        elif len(self.marks) == 1:
            i = self.marks[0]
            self.viewport.clear_highlight()
            self.viewport.set_markers([
                {"x": pts[i][0], "z": pts[i][1],
                 "y": rec.get("ys", [0] * len(pts))[i], "kind": "start"}])
        else:
            self.viewport.clear_highlight()
            self.viewport.set_markers([])
        self.viewport.frame_extent()
        if self.session is None:
            self.viewport.set_hint(
                "Drag to orbit · wheel zooms · click the road to "
                "mark the stretch")

    # ------------------------------------------------------------------
    # Submit
    # ------------------------------------------------------------------

    def _on_submit(self, _button):
        """Review the change in plain language, then round-trip."""
        if self.session is None or self.zone_state is None:
            return
        zone = self.zone_state.zone

        def work():
            return self.data.build_targets(zone, self.session)

        def done(result, err):
            if err is not None:
                self._set_status(f"Could not prepare the submit: {err}")
                return False
            targets, changed, neighbours = result
            if not targets:
                self._set_status(
                    "Nothing to save — this edit changes nothing.")
                return False
            files = "\n".join(
                f"  • {p} ({len(b) / 1024:.0f} KB)"
                for _r, p, b, _m in targets)
            s = self.session
            text = (f"Lift the terrain under "
                    f"{s.record.get('name') or 'Unnamed St'} "
                    f"({zone}) by up to {s.peak:+.1f} u, as "
                    f"{len(s.lifts)} terrain lifts.\n\n"
                    f"Roads re-draped to the new ground: the edited "
                    f"road"
                    + (f" plus {neighbours} nearby road(s)."
                       if neighbours else ".")
                    + f"\n\nFiles that will change on GitHub:\n"
                      f"{files}\n\n"
                      "The push is verified by re-downloading "
                      "every file afterwards.")
            dialog = Gtk.MessageDialog(
                transient_for=self, flags=0,
                message_type=Gtk.MessageType.QUESTION,
                buttons=Gtk.ButtonsType.NONE, text="Submit this edit?")
            dialog.format_secondary_text(text)
            dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
            dialog.add_button("Push to GitHub", Gtk.ResponseType.OK)
            resp = dialog.run()
            dialog.destroy()
            if resp == Gtk.ResponseType.OK:
                self._do_round_trip(zone)
            return False

        self._run_background(work, done)

    def _do_round_trip(self, zone):
        """The save itself, on a worker thread."""
        self.submit_button.set_sensitive(False)
        self._set_status("Saving: local save → push → verify…")

        def work():
            return self.data.round_trip_save(
                zone, self.session, DATA_DIR,
                github_sync.open_connection, github_sync.push_targets,
                github_sync.fetch_file)

        def done(result, err):
            self.submit_button.set_sensitive(True)
            if err is not None:
                self._set_status(f"Save failed: {err}")
                return False
            ok, msg, _fresh = result
            self._set_status(msg)
            if ok:
                self._clear_edit()
                self.zone_info.set_text(
                    f"{self.zone_state.name}: {len(self.zone_state.lifts)} "
                    "terrain lifts on record.")
                self._refresh_scene()
            return False

        self._run_background(work, done)

    # ------------------------------------------------------------------
    # Help menu + window lifecycle
    # ------------------------------------------------------------------

    def _on_about(self, _item):
        about_mod.show_about_dialog(self, APP_NAME, APP_VERSION,
                                    ICON_NAME, PACKAGE_NAME)

    def _on_check_updates(self, _item):
        """Fail-open update check (suite_core.updater)."""

        def work():
            return updater_mod.check_for_update(
                APP_REPO_DIR, APP_VERSION, github_sync.fetch_file)

        def done(result, err):
            if err is not None:
                updater_mod.show_update_result(
                    self, APP_NAME, APP_VERSION, None, str(err))
            else:
                info, uerr = result
                updater_mod.show_update_result(
                    self, APP_NAME, APP_VERSION, info, uerr)
            return False

        self._run_background(work, done)

    def _on_delete(self, _window, _event):
        """Confirm closing over an unsubmitted edit; remember the
        window geometry either way."""
        size = self.get_size()
        self._state.remember_size("main", (size.width, size.height))
        self._state.remember_pane("main-split",
                                  self.paned.get_position())
        self._state.save()
        if self.session is None:
            return False
        dialog = Gtk.MessageDialog(
            transient_for=self, flags=0,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.NONE,
            text="Unsubmitted elevation edit")
        dialog.format_secondary_text(
            "You marked and lifted a stretch but never submitted "
            "it. Close anyway and lose the edit?")
        dialog.add_button("Keep editing", Gtk.ResponseType.CANCEL)
        dialog.add_button("Close", Gtk.ResponseType.OK)
        resp = dialog.run()
        dialog.destroy()
        return resp != Gtk.ResponseType.OK


def main():
    """Entry point: crash log in place, window up, GTK main loop."""
    _install_crash_log()
    win = ElevationWindow()
    win.connect("destroy", Gtk.main_quit)
    Gtk.main()


if __name__ == "__main__":
    main()
