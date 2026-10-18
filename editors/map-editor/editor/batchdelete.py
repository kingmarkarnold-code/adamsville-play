"""
Batch delete for the Map Editor (1.9.8, Joshua's design
2026-10-18).

The flow:

  1. On the map, Shift+drag draws a selection square (the
     rubber band lives in mapcanvas). On release the editor
     collects every road SEGMENT (record) whose geometry
     intersects the square — record-scoped, exactly as the
     Delete ruling says: whole pieces, even if only partly
     inside the square. Collection is background work under the
     corner progress bar; the app never stalls.
  2. A panel lists each segment found: its name (or "Unnamed
     segment"), a checkbox, and a small PICTURE of the segment
     in its immediate surroundings — the segment itself drawn
     RED, the surrounding roads in their normal colours, so
     what will go reads instantly against what stays.
  3. While the panel is up, the companion panes hold the
     Before/After stills (caveat rule): Before = the square's
     area as it is; After = the same framing with only the
     CHECKED segments removed. Toggling a checkbox refreshes
     each still exactly once, then they hold still again.
  4. The confirm button carries the live count ("Delete —
     confirm (N segments)"); N = 0 disables it. Confirming
     deletes exactly the checked records through the app's
     batch commit (standing save rule inside). Cancel leaves
     the data and the panes exactly as they were.

Joshua's rule: all code commented.
"""

import math
import threading

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib
import cairo

# Thumbnail size (px) and the red the doomed segment is drawn in
# (Joshua's word for the thumbnails: the piece in red, its
# surroundings normal).
THUMB_W, THUMB_H = 108, 80
THUMB_RED = (0.92, 0.10, 0.08)


# ------------------------------------------------------------------
# Geometry: does a road record touch the selection square?
# The square arrives as its four world corners (a polygon — the
# view may be rotated, so it is NOT assumed axis-aligned).
# ------------------------------------------------------------------

def _point_in_poly(x, z, poly):
    """Ray-casting point-in-polygon test."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, zi = poly[i]
        xj, zj = poly[j]
        if (zi > z) != (zj > z):
            x_at = xi + (z - zi) * (xj - xi) / (zj - zi)
            if x < x_at:
                inside = not inside
        j = i
    return inside


def _seg_intersects_seg(a, b, c, d):
    """Segment-segment intersection (touching counts)."""
    def orient(p, q, r):
        v = (q[0] - p[0]) * (r[1] - p[1]) \
            - (q[1] - p[1]) * (r[0] - p[0])
        if abs(v) < 1e-9:
            return 0
        return 1 if v > 0 else -1

    def on_seg(p, q, r):
        return (min(p[0], r[0]) - 1e-9 <= q[0] <= max(p[0], r[0]) + 1e-9
                and min(p[1], r[1]) - 1e-9 <= q[1]
                <= max(p[1], r[1]) + 1e-9)

    o1, o2 = orient(a, b, c), orient(a, b, d)
    o3, o4 = orient(c, d, a), orient(c, d, b)
    if o1 != o2 and o3 != o4:
        return True
    if o1 == 0 and on_seg(a, c, b):
        return True
    if o2 == 0 and on_seg(a, d, b):
        return True
    if o3 == 0 and on_seg(c, a, d):
        return True
    if o4 == 0 and on_seg(c, b, d):
        return True
    return False


def road_intersects_poly(pts, poly):
    """
    True when any point of the road lies inside the polygon or
    any of its segments crosses a polygon edge.
    """
    for (x, z) in pts:
        if _point_in_poly(x, z, poly):
            return True
    edges = [(poly[i], poly[(i + 1) % len(poly)])
             for i in range(len(poly))]
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        for (c, d) in edges:
            if _seg_intersects_seg(a, b, c, d):
                return True
    return False


def collect_records(app, corners):
    """
    Every (category, flat_index, road) whose geometry intersects
    the selection polygon. Candidates come from the spatial
    index over the polygon's AABB (never a whole-map scan);
    the exact test is road_intersects_poly. Runs on a worker
    thread — reads only.
    """
    si = getattr(app, "spatial_index", None)
    if si is None:
        return []
    xs = [c[0] for c in corners]
    zs = [c[1] for c in corners]
    out = []
    for fi in si.query(min(xs), min(zs), max(xs), max(zs)):
        try:
            cat, road = si.roads[fi][0], si.roads[fi][1]
        except Exception:
            continue
        pts = road.get("pts") or []
        if len(pts) >= 2 and road_intersects_poly(pts, corners):
            out.append((cat, fi, road))
    # Stable, name-first order for the list.
    out.sort(key=lambda t: ((t[2].get("name") or "").casefold(),
                            t[0], t[1]))
    return out


def collect_and_open(app, corners):
    """
    Entry point (called by the app on band release): collect in
    the background under the progress bar, then open the batch
    panel on the UI thread. A token drops stale results (a
    second square drawn while the first is still collecting).
    """
    token = getattr(app, "_batch_token", 0) + 1
    app._batch_token = token
    app.progress_start("batch-collect",
                       "Collecting pieces in the square…")

    def worker():
        try:
            records = collect_records(app, corners)
        except Exception:
            records = []

        def land():
            if getattr(app, "_batch_token", 0) != token:
                return False  # superseded — drop it
            app.progress_finish("batch-collect")
            if not records:
                app.set_status(
                    "Batch delete: no road pieces touch that "
                    "square.")
                return False
            dialog = BatchDeleteDialog(app, records, corners)
            dialog.show_all()
            return False
        GLib.idle_add(land)

    threading.Thread(target=worker, daemon=True).start()


# ------------------------------------------------------------------
# Thumbnails: the segment in red against its surroundings.
# ------------------------------------------------------------------

class SegmentThumbnail(Gtk.DrawingArea):
    """
    A small picture of ONE segment in its immediate
    surroundings: neighbouring roads in their normal colours,
    this segment in red on top. The view is the segment's own
    extent widened ~2.4x so the context shows.
    """

    def __init__(self, app, road):
        super().__init__()
        self.app = app
        self.road = road
        self.set_size_request(THUMB_W, THUMB_H)
        self.connect("draw", self._on_draw)

    def _frame(self, w, h):
        """(centre_x, centre_z, zoom) fitting the segment with
        its surroundings."""
        pts = self.road.get("pts") or [(0, 0)]
        xs = [p[0] for p in pts]
        zs = [p[1] for p in pts]
        span = max(max(xs) - min(xs), max(zs) - min(zs), 40.0) * 2.4
        cx = (min(xs) + max(xs)) / 2
        cz = (min(zs) + max(zs)) / 2
        return cx, cz, min(w, h) / span

    def _on_draw(self, _w, cr):
        from data import ROAD_STYLE, normalize_category
        alloc = self.get_allocation()
        w, h = max(2, alloc.width), max(2, alloc.height)
        cr.set_source_rgb(0.09, 0.10, 0.12)
        cr.paint()
        cx, cz, zoom = self._frame(w, h)

        def to_px(wx, wz):
            return (w / 2 + (wx - cx) * zoom,
                    h / 2 + (wz - cz) * zoom)

        half = (max(w, h) / zoom) / 2 + 60
        si = getattr(self.app, "spatial_index", None)
        if si is not None:
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.set_line_join(cairo.LINE_JOIN_ROUND)
            for fi in si.query(cx - half, cz - half,
                               cx + half, cz + half):
                try:
                    cat, road = si.roads[fi][0], si.roads[fi][1]
                except Exception:
                    continue
                if road is self.road:
                    continue
                pts = road.get("pts") or []
                if len(pts) < 2:
                    continue
                style = ROAD_STYLE.get(normalize_category(cat),
                                       ROAD_STYLE["local"])
                cr.set_source_rgb(*style["color"])
                cr.set_line_width(max(
                    0.8, style["width"] * zoom * 0.6))
                for k, (wx, wz) in enumerate(pts):
                    px, py = to_px(wx, wz)
                    cr.line_to(px, py) if k else cr.move_to(px, py)
                cr.stroke()
        # The segment itself: RED, on top, unmissable.
        pts = self.road.get("pts") or []
        if len(pts) >= 2:
            cr.set_source_rgb(*THUMB_RED)
            cr.set_line_width(2.6)
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.set_line_join(cairo.LINE_JOIN_ROUND)
            for k, (wx, wz) in enumerate(pts):
                px, py = to_px(wx, wz)
                cr.line_to(px, py) if k else cr.move_to(px, py)
            cr.stroke()
        return False


# ------------------------------------------------------------------
# The batch panel.
# ------------------------------------------------------------------

class BatchDeleteDialog(Gtk.Dialog):
    """
    The batch list + decision. Rows start checked (the square
    was drawn around what goes; unchecking spares a piece).
    The confirm button's label carries the live count.
    """

    def __init__(self, app, records, corners):
        super().__init__(title="Delete several segments",
                         transient_for=app.window,
                         flags=Gtk.DialogFlags.MODAL)
        self.app = app
        self.records = records      # [(cat, flat_idx, road)]
        self.corners = corners
        self._syncing = False       # select-all cascade guard
        self._closed = False
        self.set_default_size(520, 560)

        box = self.get_content_area()
        box.set_spacing(6)
        box.set_margin_start(10)
        box.set_margin_end(10)
        box.set_margin_top(10)
        box.set_margin_bottom(6)

        intro = Gtk.Label(
            label=f"{len(records)} road segment(s) touch the "
                  "square. Uncheck any piece you want to keep — "
                  "only the checked pieces are deleted.")
        intro.set_line_wrap(True)
        intro.set_xalign(0)
        box.pack_start(intro, False, False, 0)

        # Select-all row (standard tri-state behaviour).
        all_row = Gtk.HBox(spacing=6)
        self.all_check = Gtk.CheckButton(label="Select all")
        self.all_check.set_active(True)
        self.all_check.connect("toggled", self._on_all_toggled)
        all_row.pack_start(self.all_check, False, False, 0)
        box.pack_start(all_row, False, False, 0)

        # The scrollable list (long pane scrollable — suite law).
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                          Gtk.PolicyType.AUTOMATIC)
        scroll.set_min_content_height(300)
        self.listbox = Gtk.ListBox()
        self.listbox.set_selection_mode(Gtk.SelectionMode.NONE)
        scroll.add(self.listbox)
        box.pack_start(scroll, True, True, 0)

        self._rows = []   # [(check, cat, road)]
        for cat, _fi, road in records:
            row_box = Gtk.HBox(spacing=8)
            check = Gtk.CheckButton()
            check.set_active(True)
            check.connect("toggled", self._on_row_toggled)
            row_box.pack_start(check, False, False, 2)
            thumb = SegmentThumbnail(app, road)
            row_box.pack_start(thumb, False, False, 0)
            texts = Gtk.VBox(spacing=1)
            name = road.get("name") or "Unnamed segment"
            name_label = Gtk.Label(label=name)
            name_label.set_xalign(0)
            name_label.set_ellipsize(3)  # Pango END
            texts.pack_start(name_label, False, False, 0)
            pts = road.get("pts") or []
            length = 0.0
            for i in range(len(pts) - 1):
                length += math.hypot(
                    pts[i + 1][0] - pts[i][0],
                    pts[i + 1][1] - pts[i][1])
            meta = Gtk.Label(
                label=f"{cat} · {len(pts)} points · "
                      f"{length:.0f} m")
            meta.set_xalign(0)
            texts.pack_start(meta, False, False, 0)
            row_box.pack_start(texts, True, True, 0)
            lrow = Gtk.ListBoxRow()
            lrow.add(row_box)
            self.listbox.add(lrow)
            self._rows.append((check, cat, road))

        # Decision row: Cancel + the counting confirm button
        # (added manually — the dialog's own button area stays
        # empty so the count label is ours).
        btn_row = Gtk.HBox(spacing=8)
        cancel = Gtk.Button(label="Cancel")
        cancel.connect("clicked", lambda _b: self._close())
        btn_row.pack_start(cancel, False, False, 0)
        spacer = Gtk.Label(label="")
        btn_row.pack_start(spacer, True, True, 0)
        self.confirm_btn = Gtk.Button(label="")
        self.confirm_btn.get_style_context().add_class(
            "destructive-action")
        self.confirm_btn.connect("clicked",
                                 lambda _b: self._confirm())
        btn_row.pack_start(self.confirm_btn, False, False, 0)
        box.pack_start(btn_row, False, False, 0)

        self.connect("delete-event", self._on_delete_event)
        self._refresh_count()
        self._open_compare()

    # -- Before/After stills -------------------------------------

    def _band_camera(self):
        """
        The comparison framing: the SQUARE's area (its corners'
        extent + margin), fitted against the Before pane — the
        same framing for both panes by construction.
        """
        cam = self.app._snapshot_camera()
        xs = [c[0] for c in self.corners]
        zs = [c[1] for c in self.corners]
        insp = self.app.inspector
        alloc = insp.cp_viewer.get_allocation()
        w = max(320, alloc.width)
        h = max(240, alloc.height)
        cam.fit_rect(w, h, min(xs), min(zs), max(xs), max(zs),
                     margin=1.15)
        return cam

    def _open_compare(self):
        insp = getattr(self.app, "inspector", None)
        if insp is None:
            return
        if self.app.insp_collapsed:
            self.app.toggle_inspector()
        targets = [road for _c, _f, road in self.records]
        cam = self._band_camera()
        insp.set_compare(
            cam, targets, self._checked_ids(), extra_roads=[],
            before_text="Before — the square as it is",
            after_text="After — checked pieces removed")

    def _checked_ids(self):
        return {id(road) for (check, _cat, road) in self._rows
                if check.get_active()}

    def _checked_records(self):
        return [(cat, road) for (check, cat, road) in self._rows
                if check.get_active()]

    # -- checkbox behaviour ----------------------------------------

    def _on_all_toggled(self, btn):
        if self._syncing:
            return
        self._syncing = True
        for (check, _cat, _road) in self._rows:
            check.set_active(btn.get_active())
        self._syncing = False
        btn.set_inconsistent(False)
        self._after_selection_change()

    def _on_row_toggled(self, _btn):
        if self._syncing:
            return
        self._sync_all_box()
        self._after_selection_change()

    def _sync_all_box(self):
        """The all-box mirrors the rows: all → on; none → off;
        some → inconsistent (tri-state), per standard behaviour."""
        states = [check.get_active()
                  for (check, _c, _r) in self._rows]
        self._syncing = True
        if all(states):
            self.all_check.set_active(True)
            self.all_check.set_inconsistent(False)
        elif any(states):
            self.all_check.set_active(False)
            self.all_check.set_inconsistent(True)
        else:
            self.all_check.set_active(False)
            self.all_check.set_inconsistent(False)
        self._syncing = False

    def _after_selection_change(self):
        """
        One selection change: the count refreshes and each
        still re-renders EXACTLY once (static rule), with the
        After picture tracking the checked set live.
        """
        self._refresh_count()
        insp = getattr(self.app, "inspector", None)
        if insp is not None and insp.compare_active():
            insp.update_compare(omit_ids=self._checked_ids())

    def _refresh_count(self):
        n = len(self._checked_records())
        word = "segment" if n == 1 else "segments"
        self.confirm_btn.set_label(
            f"Delete — confirm ({n} {word})")
        self.confirm_btn.set_sensitive(n > 0)

    # -- outcomes ----------------------------------------------------

    def _confirm(self):
        picked = self._checked_records()
        n = len(picked)
        if n == 0:
            return
        self.app.undo_begin("Batch Delete")
        ok = self.app.apply_road_delete_batch(picked)
        self.app.undo_commit()
        self._close()
        if ok:
            self.app.set_status(
                f"Batch delete: removed {n} segment(s).")
            self.app.canvas.queue_draw()
        else:
            self.app.set_status(
                "Batch delete failed: could not save every "
                "piece — check the map before trusting it.")

    def _on_delete_event(self, _w, _event):
        self._close()
        return True

    def _close(self):
        """Cancel path + shared teardown: panes revert to their
        normal synced views; data was never touched on cancel."""
        if self._closed:
            return
        self._closed = True
        insp = getattr(self.app, "inspector", None)
        if insp is not None:
            insp.clear_compare()
        self.destroy()
