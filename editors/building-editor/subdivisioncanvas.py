#!/usr/bin/env python3
"""
Adamsville Asset Editor (Native) — Subdivision map canvas.

A 2D top-down map view (Cairo) where Joshua draws subdivision polygons.
Shows zone boundaries from zones.json as a reference guide, plus any
subdivisions already defined.

Interaction modes:
  "select" — click a subdivision to select it; drag to pan; wheel zooms
  "draw"   — click to add polygon points; double-click (or Enter) to
             finish; Escape cancels; right-click removes the last point

Callbacks wired by app.py:
  on_polygon_done(points) — draw mode finished; points is a list of
      [x, z] game-world coords
  on_subdivision_click(index) — select mode click hit subdivision #index
      (or None for empty space)

World coords: game (x, z), extent roughly -200..8200 x -200..12200.

Joshua's rule: all code commented.
"""

import math
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk
import cairo


class SubdivisionCanvas(Gtk.DrawingArea):
    """2D top-down map for drawing/selecting subdivision polygons."""

    def __init__(self):
        """Set up the drawing area, view state, and input."""
        super().__init__()
        # Zone polygons for reference: list of {"name", "points", ...}
        self.zones = []
        # Subdivisions: list of {"name", "polygon": [[x,z],...], "style"}
        self.subdivisions = []
        # Index of the selected subdivision, or None
        self.selected = None
        # Points of the polygon currently being drawn (game coords)
        self.draft_points = []
        # Interaction mode: "select" or "draw"
        self.mode = "select"
        # View transform: scale (px per world unit) + offset
        self.zoom = 0.05      # start zoomed to roughly fit the world
        self.pan_x = 0.0
        self.pan_y = 0.0
        # World rect (game units) drawn as the boundary fallback
        self.world = (-200.0, -200.0, 8200.0, 12200.0)
        # Active zone (v1.2.0, Joshua): the zone Joshua picked to work
        # in. The map fits to it; other zones draw dimmed. None means
        # the whole map.
        self.active_zone = None
        # v1.2.0 FIX: fit the view on the first real size allocation,
        # not on realize (allocation is often 1x1 at realize time,
        # which made the map invisible).
        self._fitted = False
        self.connect("size-allocate", self._on_size_allocate)
        # Pan-drag state
        self._panning = False
        self._pan_sx = 0.0
        self._pan_sy = 0.0
        self._pan_ox = 0.0
        self._pan_oy = 0.0
        self._moved_far = False  # distinguish click vs drag
        # Callbacks wired by app.py
        self.on_polygon_done = None      # (points) on draw finish
        self.on_subdivision_click = None  # (index or None) on select click

        self.set_can_focus(True)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK |
                        Gdk.EventMask.BUTTON_RELEASE_MASK |
                        Gdk.EventMask.POINTER_MOTION_MASK |
                        Gdk.EventMask.SCROLL_MASK |
                        Gdk.EventMask.KEY_PRESS_MASK)
        self.connect("draw", self._on_draw)
        self.connect("button-press-event", self._on_button_press)
        self.connect("button-release-event", self._on_button_release)
        self.connect("motion-notify-event", self._on_motion)
        self.connect("scroll-event", self._on_scroll)
        self.connect("key-press-event", self._on_key)

    # -- public API used by app.py --------------------------------------

    def set_data(self, zones, subdivisions):
        """Set the reference zones and subdivision list, then redraw."""
        self.zones = zones or []
        self.subdivisions = subdivisions or []
        self.queue_draw()

    def set_mode(self, mode):
        """Set "select" or "draw" mode. Cancels any in-progress draft."""
        self.mode = mode
        if mode != "draw":
            self.draft_points = []
        self.queue_draw()

    def fit_world(self, x0, z0, x1, z1):
        """
        Zoom/pan so the given world rect fills the widget.
        v1.2.0: no-ops on tiny allocations (called too early).
        """
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height
        if w < 50 or h < 50:
            return
        self.world = (x0, z0, x1, z1)
        self.zoom = min(w / max(1.0, x1 - x0),
                        h / max(1.0, z1 - z0)) * 0.95
        # Center the rect
        cx, cy = (x0 + x1) / 2.0, (z0 + z1) / 2.0
        self.pan_x = w / 2.0 - cx * self.zoom
        self.pan_y = h / 2.0 - cy * self.zoom
        self.queue_draw()

    def _on_size_allocate(self, widget, allocation):
        """Fit the world once the widget has a real size. v1.2.0."""
        if not self._fitted and allocation.width > 50 \
                and allocation.height > 50:
            self._fitted = True
            if self.active_zone is not None:
                self.fit_zone(self.active_zone)
            else:
                self.fit_world(*self.world)

    def set_active_zone(self, zone):
        """
        Set the active working zone (a zone dict) or None for the
        whole map. v1.2.0 (Joshua): zone-first workflow.
        """
        self.active_zone = zone
        self._fitted = False  # re-fit on next draw if not allocated
        self.queue_draw()

    def fit_zone(self, zone):
        """
        Zoom/pan to a zone's bounding box with a small margin.
        Falls back to the full world if the zone has no points.
        v1.2.0 (Joshua): zone-first workflow.
        """
        pts = (zone or {}).get("points") or []
        if len(pts) < 3:
            self.fit_world(*self.world)
            return
        xs = [p[0] for p in pts]
        zs = [p[1] for p in pts]
        x0, x1 = min(xs), max(xs)
        z0, z1 = min(zs), max(zs)
        # 10% margin so the boundary isn't glued to the edges
        mx, mz = (x1 - x0) * 0.10, (z1 - z0) * 0.10
        self.fit_world(x0 - mx, z0 - mz, x1 + mx, z1 + mz)

    # -- coordinate transforms ------------------------------------------

    def _w2s(self, x, z):
        """World (x, z) -> screen (sx, sy)."""
        return x * self.zoom + self.pan_x, z * self.zoom + self.pan_y

    def _s2w(self, sx, sy):
        """Screen (sx, sy) -> world (x, z)."""
        return (sx - self.pan_x) / self.zoom, (sy - self.pan_y) / self.zoom

    # -- drawing --------------------------------------------------------

    @staticmethod
    def _point_in_poly(px, py, poly):
        """Ray-casting point-in-polygon test (screen coords)."""
        inside = False
        n = len(poly)
        for i in range(n):
            x1, y1 = poly[i]
            x2, y2 = poly[(i + 1) % n]
            if ((y1 > py) != (y2 > py)):
                xinters = (x2 - x1) * (py - y1) / (y2 - y1 + 1e-9) + x1
                if px < xinters:
                    inside = not inside
        return inside

    def _draw_poly(self, cr, points, fill, stroke, width):
        """Draw a world-coord polygon with fill and outline."""
        if len(points) < 3:
            return
        pts = [self._w2s(x, z) for x, z in points]
        cr.set_source_rgba(*fill)
        cr.move_to(*pts[0])
        for pt in pts[1:]:
            cr.line_to(*pt)
        cr.close_path()
        cr.fill_preserve()
        cr.set_source_rgba(*stroke)
        cr.set_line_width(width)
        cr.stroke()

    def _on_draw(self, widget, cr):
        """Cairo draw handler: zones, subdivisions, draft polygon."""
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height

        # Dark map background
        cr.set_source_rgb(0.10, 0.10, 0.12)
        cr.paint()

        # --- Grid + world boundary fallback (v1.2.0) ---
        # Always drawn so the map is never blank, even if zones fail
        # to load (Joshua: the subdivision tab showed no map).
        wx0, wz0, wx1, wz1 = self.world
        step = 2000.0  # world units between grid lines
        cr.set_source_rgba(0.35, 0.35, 0.42, 0.35)
        cr.set_line_width(1.0)
        gx = (int(wx0) // int(step)) * step
        while gx <= wx1:
            sx0, sy0 = self._w2s(gx, wz0)
            sx1, sy1 = self._w2s(gx, wz1)
            cr.move_to(sx0, sy0)
            cr.line_to(sx1, sy1)
            cr.stroke()
            gx += step
        gz = (int(wz0) // int(step)) * step
        while gz <= wz1:
            sx0, sy0 = self._w2s(wx0, gz)
            sx1, sy1 = self._w2s(wx1, gz)
            cr.move_to(sx0, sy0)
            cr.line_to(sx1, sy1)
            cr.stroke()
            gz += step
        # World boundary
        bx0, by0 = self._w2s(wx0, wz0)
        bx1, by1 = self._w2s(wx1, wz1)
        cr.set_source_rgba(0.6, 0.6, 0.68, 0.6)
        cr.set_line_width(1.5)
        cr.rectangle(bx0, by0, bx1 - bx0, by1 - by0)
        cr.stroke()

        # --- Zone reference polygons (thin outlines + labels) ---
        # v1.2.0: the active zone draws full-strength; other zones are
        # dimmed for context (zone-first workflow, Joshua).
        zone_colors = [
            (0.29, 0.56, 0.85), (0.49, 0.83, 0.13), (0.96, 0.65, 0.14),
            (0.74, 0.06, 0.88), (0.31, 0.89, 0.76), (0.72, 0.91, 0.53),
            (1.0, 0.42, 0.42),
        ]
        active_name = ((self.active_zone or {}).get("name")
                       if self.active_zone else None)
        for i, zone in enumerate(self.zones):
            pts = zone.get("points") or []
            if len(pts) < 3:
                continue
            c = zone_colors[i % len(zone_colors)]
            is_active = (active_name is not None
                         and str(zone.get("name", "")) == active_name)
            if self.active_zone is not None and not is_active:
                # Dimmed context zone
                self._draw_poly(cr, pts, (c[0], c[1], c[2], 0.03),
                                (c[0], c[1], c[2], 0.18), 1.0)
                continue  # no label for dimmed zones
            # Faint fill + brighter outline
            self._draw_poly(cr, pts, (c[0], c[1], c[2], 0.08),
                            (c[0], c[1], c[2], 0.55), 1.2)
            # Zone name label at polygon centroid
            cx = sum(p[0] for p in pts) / len(pts)
            cz = sum(p[1] for p in pts) / len(pts)
            sx, sy = self._w2s(cx, cz)
            if is_active:
                cr.set_source_rgba(1.0, 0.75, 0.15, 0.95)
            else:
                cr.set_source_rgba(c[0], c[1], c[2], 0.85)
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                                cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(11)
            name = str(zone.get("name", ""))
            # Center the label roughly
            xb, yb, tw, th, xa, ya = cr.text_extents(name)[:6]
            cr.move_to(sx - tw / 2.0, sy + th / 2.0)
            cr.show_text(name)

        # --- Subdivisions (translucent fill, bright border) ---
        for i, sub in enumerate(self.subdivisions):
            poly = sub.get("polygon") or []
            if len(poly) < 3:
                continue
            is_sel = (self.selected == i)
            if is_sel:
                # Selected: strong amber fill + thick border
                self._draw_poly(cr, poly, (1.0, 0.75, 0.15, 0.30),
                                (1.0, 0.75, 0.15, 1.0), 2.5)
            else:
                # Unselected: teal fill + thin border
                self._draw_poly(cr, poly, (0.2, 0.8, 0.7, 0.18),
                                (0.2, 0.8, 0.7, 0.8), 1.5)
            # Name label at centroid
            cx = sum(p[0] for p in poly) / len(poly)
            cz = sum(p[1] for p in poly) / len(poly)
            sx, sy = self._w2s(cx, cz)
            cr.set_source_rgb(1, 1, 1)
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                                cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(11)
            name = str(sub.get("name", ""))
            xb, yb, tw, th, xa, ya = cr.text_extents(name)[:6]
            cr.move_to(sx - tw / 2.0, sy + th / 2.0)
            cr.show_text(name)

        # --- Draft polygon being drawn ---
        if self.draft_points:
            pts = [self._w2s(x, z) for x, z in self.draft_points]
            # Lines between draft points
            cr.set_source_rgb(1.0, 0.85, 0.2)
            cr.set_line_width(2.0)
            cr.move_to(*pts[0])
            for pt in pts[1:]:
                cr.line_to(*pt)
            cr.stroke()
            # Vertex markers
            for sx, sy in pts:
                cr.set_source_rgb(1.0, 0.85, 0.2)
                cr.arc(sx, sy, 4.0, 0, 2 * math.pi)
                cr.fill()

        # --- Mode hint ---
        cr.set_source_rgb(1.0, 0.85, 0.3)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(12)
        if self.mode == "draw":
            cr.move_to(12, h - 14)
            cr.show_text("Click to add points — double-click to finish, "
                        "right-click removes last point, Esc cancels.")
        else:
            cr.move_to(12, h - 14)
            cr.show_text("Drag to pan — wheel zooms — click a subdivision "
                        "to select it.")

    # -- input ----------------------------------------------------------

    def _on_button_press(self, widget, event):
        """Left: draw-mode adds points / select-mode starts pan-check."""
        self.grab_focus()
        if event.button == 1:
            if self.mode == "draw":
                # Double-click finishes the polygon
                if event.type == Gdk.EventType._2BUTTON_PRESS:
                    self._finish_draft()
                else:
                    x, z = self._s2w(event.x, event.y)
                    self.draft_points.append([x, z])
                    self.queue_draw()
            else:
                # Select mode: maybe starting a pan drag
                self._panning = True
                self._moved_far = False
                self._pan_sx, self._pan_sy = event.x, event.y
                self._pan_ox, self._pan_oy = self.pan_x, self.pan_y
        elif event.button == 3 and self.mode == "draw":
            # Right-click removes the last draft point
            if self.draft_points:
                self.draft_points.pop()
                self.queue_draw()
        return True

    def _on_button_release(self, widget, event):
        """
        Left release in select mode: if the pointer barely moved it was
        a click -> hit-test subdivisions; otherwise it was a pan.
        """
        if event.button == 1 and self.mode == "select":
            self._panning = False
            if not self._moved_far and self.on_subdivision_click:
                idx = self._hit_subdivision(event.x, event.y)
                self.on_subdivision_click(idx)
        return True

    def _on_motion(self, widget, event):
        """Pan the map while the left button is held in select mode."""
        if self._panning and self.mode == "select":
            dx = event.x - self._pan_sx
            dy = event.y - self._pan_sy
            if abs(dx) > 4 or abs(dy) > 4:
                self._moved_far = True
            if self._moved_far:
                self.pan_x = self._pan_ox + dx
                self.pan_y = self._pan_oy + dy
                self.queue_draw()
        return True

    def _on_scroll(self, widget, event):
        """Wheel zoom centered on the cursor."""
        if event.direction == Gdk.ScrollDirection.UP:
            factor = 1.2
        elif event.direction == Gdk.ScrollDirection.DOWN:
            factor = 1.0 / 1.2
        else:
            return True
        # Keep the world point under the cursor fixed
        wx, wz = self._s2w(event.x, event.y)
        self.zoom = max(0.005, min(5.0, self.zoom * factor))
        self.pan_x = event.x - wx * self.zoom
        self.pan_y = event.y - wz * self.zoom
        self.queue_draw()
        return True

    def _on_key(self, widget, event):
        """Escape cancels a draft; Enter/Return finishes it."""
        key = Gdk.keyval_name(event.keyval)
        if self.mode == "draw":
            if key == "Escape":
                self.draft_points = []
                self.queue_draw()
                return True
            if key in ("Return", "KP_Enter"):
                self._finish_draft()
                return True
        return False

    def _finish_draft(self):
        """Finish the draft polygon (needs >= 3 points)."""
        if len(self.draft_points) >= 3 and self.on_polygon_done:
            pts = [list(p) for p in self.draft_points]
            self.draft_points = []
            self.queue_draw()
            self.on_polygon_done(pts)
        # Fewer than 3 points: keep drawing (don't silently drop)

    def _hit_subdivision(self, sx, sy):
        """
        Find the topmost subdivision polygon containing the click.
        Returns the subdivision index, or None.
        """
        for i in range(len(self.subdivisions) - 1, -1, -1):
            poly = self.subdivisions[i].get("polygon") or []
            if len(poly) < 3:
                continue
            pts = [self._w2s(x, z) for x, z in poly]
            if self._point_in_poly(sx, sy, pts):
                return i
        return None
