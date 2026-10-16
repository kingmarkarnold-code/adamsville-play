#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) — Cairo canvas widget.

GTK DrawingArea subclass that renders roads and zones with Cairo.
Handles pan (drag), zoom (wheel), and tool interactions.

Joshua's rule: all code commented.
"""

import math
import sys
from pathlib import Path
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk

from data import (ROAD_STYLE, WORLD_W, WORLD_H, save_zone_edit, zone_bbox,
                    normalize_category, CATEGORY_ORDER, CATEGORY_LABELS,
                    DIVIDABLE_CATEGORIES, DIVIDER_TYPES)

# Shared canvas helpers (pan/zoom math, hit testing). All suite apps
# install the same file; fall back to local copies if it is missing
# (e.g. running from source without installing). Joshua 2026-10-11:
# map functions must not be rewritten per app.
for _suite_path in ("/usr/share/adamsville-suite",
                    str(Path.home() / ".local" / "share" / "adamsville-suite")):
    if _suite_path not in sys.path:
        sys.path.insert(0, _suite_path)
try:
    from adamsville_suite_canvas import Camera2D, point_in_polygon
    _SHARED_CANVAS = True
except ImportError:
    _SHARED_CANVAS = False


if not _SHARED_CANVAS:
    # -- Local fallbacks (only used if the shared module is missing) --

    def point_in_polygon(px, py, poly):
        """
        Ray-casting point-in-polygon test (fallback copy).
        Returns True if (px, py) is inside the polygon; boundary counts
        as inside.
        """
        inside = False
        n = len(poly)
        if n < 3:
            return False
        j = n - 1
        for i in range(n):
            xi, yi = poly[i]
            xj, yj = poly[j]
            if ((yi > py) != (yj > py)) and \
                    (px <= (xj - xi) * (py - yi) / (yj - yi) + xi):
                inside = not inside
            j = i
        return inside

    class Camera2D:
        """
        Camera-centered 2D pan/zoom controller (fallback copy).
        See adamsville_suite_canvas for the documented version.
        """
        def __init__(self, zoom=0.06, min_zoom=0.02, max_zoom=40.0):
            self.cam_x = 0.0
            self.cam_y = 0.0
            self.zoom = zoom
            self.min_zoom = min_zoom
            self.max_zoom = max_zoom

        def world_to_screen(self, wx, wz, view_w, view_h):
            return ((wx - self.cam_x) * self.zoom + view_w / 2,
                    (wz - self.cam_y) * self.zoom + view_h / 2)

        def screen_to_world(self, sx, sy, view_w, view_h):
            return ((sx - view_w / 2) / self.zoom + self.cam_x,
                    (sy - view_h / 2) / self.zoom + self.cam_y)

        def zoom_at(self, sx, sy, factor, view_w, view_h):
            wx0, wz0 = self.screen_to_world(sx, sy, view_w, view_h)
            self.zoom = max(self.min_zoom,
                            min(self.max_zoom, self.zoom * factor))
            wx1, wz1 = self.screen_to_world(sx, sy, view_w, view_h)
            self.cam_x += wx0 - wx1
            self.cam_y += wz0 - wz1

        def pan_from(self, start_cam_x, start_cam_y, dx, dy):
            self.cam_x = start_cam_x - dx / self.zoom
            self.cam_y = start_cam_y - dy / self.zoom

        def pan_by(self, dx, dy):
            self.cam_x -= dx / self.zoom
            self.cam_y -= dy / self.zoom

        def fit_rect(self, view_w, view_h, x0, z0, x1, z1, margin=1.05):
            if view_w <= 0 or view_h <= 0:
                return
            w = max(1.0, (x1 - x0) * margin)
            h = max(1.0, (z1 - z0) * margin)
            self.zoom = min(view_w / w, view_h / h)
            self.cam_x = (x0 + x1) / 2
            self.cam_y = (z0 + z1) / 2

        def get_viewport(self, view_w, view_h):
            x0, z0 = self.screen_to_world(0, 0, view_w, view_h)
            x1, z1 = self.screen_to_world(view_w, view_h, view_w, view_h)
            return min(x0, x1), min(z0, z1), max(x0, x1), max(z0, z1)


# Backwards-compatible alias: older code in this file called the local
# ray-casting helper _point_in_polygon. It now resolves to the shared
# implementation (or the fallback above).
_point_in_polygon = point_in_polygon


# Pin radius in screen pixels for zone polygon vertex handles
PIN_RADIUS = 12
# Max screen-pixel distance from a zone boundary edge for click-to-add-pin
EDGE_PICK_PX = 10

# Road width classes (Joshua 2026-10-11: Edit → Road Appearance).
# Multiplier applied to the category base width when rendering.
WIDTH_MULT = {
    "narrow": 0.6,
    "standard": 1.0,
    "wide": 1.6,
}
# Valid paint styles for lane markings.
PAINT_STYLES = ("none", "dotted", "dotted_yellow")

# Taper length (in road points) for divided-section boundaries: the
# median/divider split gradually narrows to zero over this many points
# at each end of a divided section (Joshua 2026-10-11).
DIVIDE_TAPER_PTS = 3
# Median strip width in world units (light-gray raised strip).
MEDIAN_WIDTH = 8.0
# Divider strip width in world units (dark strip with posts).
DIVIDER_WIDTH = 4.0


# Zoom thresholds for street name labels (Joshua 2026-10-12: Google
# Maps-style zoom-dependent labels). The canvas zoom is a scale factor
# (screen pixels per world unit): higher = more zoomed in.
#   zoom < LABEL_ZOOM_HIGHWAY  → interstate names only
#   zoom < LABEL_ZOOM_ARTERY   → interstate + highway names
#   zoom < LABEL_ZOOM_LOCAL    → + major/minor artery names
#   zoom >= LABEL_ZOOM_LOCAL   → all categories incl. local streets
LABEL_ZOOM_HIGHWAY = 0.06
LABEL_ZOOM_ARTERY = 0.15
LABEL_ZOOM_LOCAL = 0.4
# Minimum on-screen road length (pixels) before its name label is drawn.
# Skips tiny stubs so the map doesn't get cluttered at high zoom.
LABEL_MIN_SCREEN_LEN = 80.0
# Font size for street name labels (screen pixels).
LABEL_FONT_SIZE = 11


def _label_categories_for_zoom(zoom):
    """
    Return the set of road categories whose names should be labeled
    at the given zoom level (Google Maps-style progressive disclosure).
    Joshua 2026-10-12: zoomed out shows only interstates; zooming in
    progressively adds highways, arteries, then local streets.
    """
    cats = {"interstate"}
    if zoom >= LABEL_ZOOM_HIGHWAY:
        cats.add("highway")
    if zoom >= LABEL_ZOOM_ARTERY:
        cats.add("major_artery")
        cats.add("minor_artery")
    if zoom >= LABEL_ZOOM_LOCAL:
        cats.add("local")
    return cats


def _direction_labels(pts):
    """
    Auto-computed direction labels for a divided road, from its overall
    angle (Joshua 2026-10-11). Roads running more north-south get
    ("N", "S"); more east-west get ("E", "W"). Abbreviated for map
    labels; the full words come from _direction_words().
    """
    if len(pts) < 2:
        return ("N", "S")
    dx = pts[-1][0] - pts[0][0]
    dz = pts[-1][1] - pts[0][1]
    if abs(dx) >= abs(dz):
        return ("E", "W")
    return ("N", "S")


def _direction_words(pts):
    """
    Full-word direction labels, e.g. ("northbound", "southbound").
    Used in the Divide Section dialog so Joshua sees real words.
    """
    abbr = _direction_labels(pts)
    words = {"N": "northbound", "S": "southbound",
             "E": "eastbound", "W": "westbound"}
    return (words[abbr[0]], words[abbr[1]])


class MapCanvas(Gtk.DrawingArea):
    """
    Native Cairo canvas for the map editor.
    All rendering is done with Cairo — no web technologies.
    """

    def __init__(self, app):
        """Initialize canvas. app is the parent MapEditorApp for callbacks."""
        super().__init__()
        self.app = app

        # Camera state: the shared Camera2D holds cam_x / cam_y / zoom.
        # (Joshua 2026-10-11: pan/zoom math lives in the shared
        # adamsville_suite_canvas module, not per app.) The cam_x /
        # cam_y / zoom names below are properties proxying to the camera
        # so outside code (e.g. app.py) that reads/writes them directly
        # keeps working unchanged.
        self._camera = Camera2D(zoom=0.06, min_zoom=0.02, max_zoom=40.0)
        self.cam_x = WORLD_W / 2
        self.cam_y = WORLD_H / 2
        self.zoom = 0.06  # will be set by fit_view()

        # Interaction state
        self.dragging = False       # True during pan drag
        self.drag_start = (0, 0)    # Screen coords where drag started
        self.cam_start = (0, 0)     # Camera position when drag started
        self.mouse_pos = (0, 0)     # Current mouse position (screen)

        # Tool state (set by toolbar)
        self.active_tool = "pan"

        # Selection state (Joshua 2026-10-11: select-first workflow).
        # Select mode: click roads to toggle-select them, up to 2 at once.
        # The Merge / Join toolbar buttons act on the two selected roads.
        self.selected_roads = []  # list of (cat, flat_idx), max 2

        # Road editing state (Extend tool only now).
        # Extend: click near a road -> closest endpoint auto-selected
        # (zoom-aware tolerance), then click destination to stretch to.
        self.extend_pick = None   # (cat, flat_idx, end_idx) or None

        # Divide-section pick state (Joshua 2026-10-11: segmentable
        # medians/dividers). When active, left clicks pick road point
        # indices for the new divided section instead of panning.
        # {"cat", "idx", "road", "start"} — "start" is the first-picked
        # point index, or None while waiting for it.
        self.divide_pick = None

        # Zone editing state (Zone tool)
        # Zones are arbitrary polygons: zone["points"] is a list of
        # [x, z] vertices (auto-closes back to the first point).
        # Clicking a boundary edge inserts a new pin there; any pin can
        # then be dragged to reshape the polygon freely.
        self.selected_zone = None  # index into data.ZONES, or None
        self.drag_pin = None       # pin index being dragged, or None

        # (Fill tool uses click-to-fill; no persistent highlight state needed.)

        # Overpass linking state (Joshua 2026-10-11).
        # When link_overpass_mode is True, the next click on an overpass
        # deck completes the link for the currently selected road.
        self.link_overpass_mode = False
        # id() of the overpass currently under the cursor (for the
        # pulsing target highlight). None when not hovering.
        self.link_overpass_hover = None

        # Move-road state (Joshua 2026-10-12): pick up an entire road
        # and relocate it. None when idle; otherwise a dict:
        #   {"cat": category, "road": road_dict,
        #    "anchor": (wx, wz) mouse world pos at mode start,
        #    "dx": float, "dz": float}  current drag offset (world units)
        # The road's pts are NOT mutated until commit — on_draw renders
        # a ghost preview at pts + (dx, dz) while the mode is active.
        self.move_road = None

        # Enable mouse events
        self.set_events(
            Gdk.EventMask.BUTTON_PRESS_MASK |
            Gdk.EventMask.BUTTON_RELEASE_MASK |
            Gdk.EventMask.POINTER_MOTION_MASK |
            Gdk.EventMask.SCROLL_MASK
        )

        # Connect signals
        self.connect("draw", self.on_draw)
        self.connect("button-press-event", self.on_button_press)
        self.connect("button-release-event", self.on_button_release)
        self.connect("motion-notify-event", self.on_motion)
        self.connect("scroll-event", self.on_scroll)

        # Dark background
        self.override_background_color(
            Gtk.StateFlags.NORMAL,
            Gdk.RGBA(0.10, 0.10, 0.18, 1.0))

    # ------------------------------------------------------------------
    # Camera properties (proxy to the shared Camera2D)
    # ------------------------------------------------------------------
    # app.py reads/writes canvas.cam_x / canvas.cam_y / canvas.zoom
    # directly (e.g. zoom-to-zone). These properties keep that working
    # while the actual state lives in the shared camera object.

    @property
    def cam_x(self):
        """World x at the view center (proxied to shared camera)."""
        return self._camera.cam_x

    @cam_x.setter
    def cam_x(self, value):
        self._camera.cam_x = value

    @property
    def cam_y(self):
        """World z at the view center (proxied to shared camera)."""
        return self._camera.cam_y

    @cam_y.setter
    def cam_y(self, value):
        self._camera.cam_y = value

    @property
    def zoom(self):
        """Screen pixels per world unit (proxied to shared camera)."""
        return self._camera.zoom

    @zoom.setter
    def zoom(self, value):
        self._camera.zoom = value

    # ------------------------------------------------------------------
    # Coordinate transforms (delegated to the shared Camera2D)
    # ------------------------------------------------------------------

    def world_to_screen(self, wx, wz):
        """Convert world coordinates to screen pixels."""
        alloc = self.get_allocation()
        return self._camera.world_to_screen(wx, wz,
                                            alloc.width, alloc.height)

    def screen_to_world(self, sx, sy):
        """Convert screen pixels to world coordinates."""
        alloc = self.get_allocation()
        return self._camera.screen_to_world(sx, sy,
                                            alloc.width, alloc.height)

    def get_viewport(self):
        """Get the visible world rect: (x0, z0, x1, z1)."""
        alloc = self.get_allocation()
        return self._camera.get_viewport(alloc.width, alloc.height)

    def fit_view(self):
        """Zoom to fit the entire world."""
        alloc = self.get_allocation()
        self._camera.fit_rect(alloc.width, alloc.height,
                              0, 0, WORLD_W, WORLD_H, margin=1.05)
        self.queue_draw()

    def zoom_at(self, sx, sy, factor):
        """
        Zoom centered on a screen point.
        factor > 1 zooms in, < 1 zooms out.
        """
        alloc = self.get_allocation()
        self._camera.zoom_at(sx, sy, factor, alloc.width, alloc.height)
        self.queue_draw()

    # ------------------------------------------------------------------
    # Rendering
    # ------------------------------------------------------------------

    def on_draw(self, widget, cr):
        """
        Cairo draw handler. Called by GTK when the widget needs repainting.
        Draw order: background → zones → roads → selection → overlays.
        """
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height

        # Background: dark blue-gray
        cr.set_source_rgb(0.10, 0.10, 0.18)
        cr.paint()

        # Get visible world bounds for culling
        vx0, vz0, vx1, vz1 = self.get_viewport()

        # Draw zones (behind roads)
        self._draw_zones(cr)

        # Draw roads (only visible ones, via spatial index)
        self._draw_roads(cr, vx0, vz0, vx1, vz1)

        # Draw street name labels on top of roads, filtered by zoom
        # level (Joshua 2026-10-12: Google Maps-style labels).
        self._draw_road_labels(cr, vx0, vz0, vx1, vz1)

        # Draw selection highlight
        self._draw_selection(cr)

        # Draw overpasses (decks, pillars, ramps) on top of roads so
        # they're always visible (Joshua 2026-10-11).
        self._draw_overpasses(cr)

        # Draw Join/Merge/Extend tool overlays (picked roads, endpoints)
        self._draw_tool_overlays(cr)

        # Draw the move-road ghost preview on top of everything else
        # while move-road mode is active (Joshua 2026-10-12).
        self._draw_move_ghost(cr)

        return False

    def _stroke_road_path(self, cr, pts):
        """Build a Cairo path from world point list (shared helper)."""
        first = True
        for px, pz in pts:
            sx, sy = self.world_to_screen(px, pz)
            if first:
                cr.move_to(sx, sy)
                first = False
            else:
                cr.line_to(sx, sy)

    def _draw_tool_overlays(self, cr):
        """
        Visual feedback for the Extend tool and the Merge preview:
        - Merge preview: with 2 roads selected, a yellow marker shows the
          source (first-selected) road's endpoint that will snap, and a
          green marker shows the snap target on the target
          (second-selected) road's edge.
        - Extend: highlight circle on the auto-selected endpoint.
        (Selected roads themselves are drawn by _draw_selection.)
        """
        # Merge preview: mark the source endpoint that will be used,
        # plus the snap target on the target road's edge, so Joshua
        # sees exactly where the endpoint will land before confirming.
        # (Joshua 2026-10-12: merge is a snap — preview both ends.)
        if len(self.selected_roads) == 2:
            (cat_s, idx_s), (cat_t, idx_t) = self.selected_roads
            road_s = self._get_road_dict(cat_s, idx_s)
            road_t = self._get_road_dict(cat_t, idx_t)
            if road_s is not None and road_t is not None:
                pts_s = road_s.get("pts", [])
                pts_t = road_t.get("pts", [])
                if len(pts_s) >= 2 and len(pts_t) >= 2:
                    end_s = self._merge_source_end(pts_s, pts_t)
                    self._draw_endpoint_marker(cr, pts_s[end_s], (1, 1, 0))
                    # Snap target: nearest point on target road's edge.
                    ex, ez = pts_s[end_s]
                    tx, tz, _dist = self._closest_point_on_road(
                        ex, ez, pts_t)
                    self._draw_endpoint_marker(cr, (tx, tz), (0, 1, 0))

        # Extend endpoint marker
        if self.extend_pick is not None:
            cat, flat_idx, end_idx = self.extend_pick
            road = self._get_road_dict(cat, flat_idx)
            if road is not None:
                pts = road.get("pts", [])
                # end_idx may be stale; clamp to a real endpoint
                ei = 0 if end_idx == 0 else len(pts) - 1
                if pts:
                    self._draw_endpoint_marker(cr, pts[ei], (0, 1, 1))

        # Divide-section pick: mark the chosen start point (cyan) so
        # Joshua sees where the section will begin.
        if self.divide_pick is not None and \
                self.divide_pick.get("start") is not None:
            road = self.divide_pick.get("road")
            pts = road.get("pts", []) if road else []
            si = self.divide_pick["start"]
            if 0 <= si < len(pts):
                self._draw_endpoint_marker(cr, pts[si], (0, 1, 1))

    def _draw_endpoint_marker(self, cr, world_pt, rgb):
        """
        Draw a highlight circle on a selected road endpoint so Joshua can
        see exactly which end will extend/merge. Radius ~12 screen px.
        """
        sx, sy = self.world_to_screen(world_pt[0], world_pt[1])
        r, g, b = rgb
        cr.set_source_rgb(r, g, b)
        cr.set_line_width(3)
        cr.arc(sx, sy, 12, 0, 2 * math.pi)
        cr.stroke()
        # Filled center dot for visibility against the road
        cr.arc(sx, sy, 4, 0, 2 * math.pi)
        cr.fill()

    def _zone_path(self, cr, zone):
        """
        Build the Cairo path for a zone polygon (auto-closes to first point).
        Used for both fill and stroke.
        """
        pts = zone["points"]
        first = True
        for wx, wz in pts:
            sx, sy = self.world_to_screen(wx, wz)
            if first:
                cr.move_to(sx, sy)
                first = False
            else:
                cr.line_to(sx, sy)
        cr.close_path()

    def _draw_zones(self, cr):
        """Draw zone polygons with semi-transparent fill and labels."""
        from data import ZONES
        # Compute the viewport once (used for culling every zone)
        vx0, vz0, vx1, vz1 = self.get_viewport()
        for zi, zone in enumerate(ZONES):
            # Skip if the zone's bounding box is completely off-screen
            bx0, bz0, bx1, bz1 = zone_bbox(zone)
            if bx1 < vx0 or bx0 > vx1 or bz1 < vz0 or bz0 > vz1:
                continue

            r, g, b = zone["color"]
            selected = (zi == self.selected_zone)
            # Semi-transparent fill (brighter when selected)
            cr.set_source_rgba(r, g, b, 0.22 if selected else 0.12)
            self._zone_path(cr, zone)
            cr.fill()
            # Border (thicker and brighter when selected)
            cr.set_source_rgba(r, g, b, 1.0 if selected else 0.6)
            cr.set_line_width(3 if selected else 2)
            self._zone_path(cr, zone)
            cr.stroke()

            # Label (centered on the bounding box)
            cr.set_source_rgba(1, 1, 1, 0.8)
            cr.select_font_face("Sans", 0, 1)  # normal, bold
            cr.set_font_size(14)
            scx0, scy0 = self.world_to_screen(bx0, bz0)
            scx1, scy1 = self.world_to_screen(bx1, bz1)
            cx, cy = (scx0 + scx1) / 2, (scy0 + scy1) / 2
            # Center the text
            ext = cr.text_extents(zone["name"])
            cr.move_to(cx - ext.width / 2, cy + ext.height / 2)
            cr.show_text(zone["name"])

            # Draggable pins for the selected zone (one per polygon vertex)
            if selected:
                self._draw_zone_pins(cr, zone)

    @staticmethod
    def _zone_pin_world(zone, pin_idx):
        """
        World coordinates of a zone polygon vertex.
        pin_idx indexes directly into zone["points"].
        """
        return zone["points"][pin_idx]

    def _draw_zone_pins(self, cr, zone):
        """
        Draw a draggable pin on every vertex of the selected zone polygon.
        White circle with the zone's color as border — 12px radius.
        """
        r, g, b = zone["color"]
        for pin_idx in range(len(zone["points"])):
            wx, wz = self._zone_pin_world(zone, pin_idx)
            sx, sy = self.world_to_screen(wx, wz)
            # White fill
            cr.set_source_rgb(1, 1, 1)
            cr.arc(sx, sy, PIN_RADIUS, 0, 2 * math.pi)
            cr.fill()
            # Colored border (thicker on the pin being dragged)
            cr.set_source_rgb(r, g, b)
            cr.set_line_width(3 if pin_idx == self.drag_pin else 2)
            cr.arc(sx, sy, PIN_RADIUS, 0, 2 * math.pi)
            cr.stroke()

    def _pick_zone_pin(self, sx, sy):
        """
        If a zone is selected, return the index of the polygon vertex
        within PIN_RADIUS of the screen point. Otherwise None.
        """
        if self.selected_zone is None:
            return None
        from data import ZONES
        zone = ZONES[self.selected_zone]
        for pin_idx in range(len(zone["points"])):
            wx, wz = self._zone_pin_world(zone, pin_idx)
            px, py = self.world_to_screen(wx, wz)
            if math.hypot(sx - px, sy - py) <= PIN_RADIUS:
                return pin_idx
        return None

    def _pick_zone_edge(self, sx, sy):
        """
        If a zone is selected, check whether the screen point is close to
        one of its boundary EDGES (but not on an existing pin).
        Returns (edge_index, world_x, world_z) where edge_index is the
        vertex the new pin will be inserted AFTER (edge from
        points[edge_index] to points[(edge_index+1) % n]), and
        (world_x, world_z) is the closest point on that edge to the click.
        Returns None if no edge is within EDGE_PICK_PX.
        """
        if self.selected_zone is None:
            return None
        # Don't offer edge-insert when the click is already on a pin
        if self._pick_zone_pin(sx, sy) is not None:
            return None
        from data import ZONES
        zone = ZONES[self.selected_zone]
        pts = zone["points"]
        n = len(pts)
        if n < 2:
            return None
        best = None
        best_d = EDGE_PICK_PX
        for i in range(n):
            ax, az = pts[i]
            bx, bz = pts[(i + 1) % n]
            asx, asy = self.world_to_screen(ax, az)
            bsx, bsy = self.world_to_screen(bx, bz)
            # Closest point on the edge segment, in screen coords
            dx, dy = bsx - asx, bsy - asy
            seg_len_sq = dx * dx + dy * dy
            if seg_len_sq == 0:
                continue
            t = max(0.0, min(1.0,
                             ((sx - asx) * dx + (sy - asy) * dy) / seg_len_sq))
            qx, qy = asx + t * dx, asy + t * dy
            d = math.hypot(sx - qx, sy - qy)
            if d < best_d:
                best_d = d
                wx, wz = self.screen_to_world(qx, qy)
                best = (i, wx, wz)
        return best

    def _pick_zone(self, sx, sy):
        """
        Return the index of the topmost zone containing the screen point,
        or None. Uses point-in-polygon (ray casting) so arbitrary polygon
        zones work. Later zones in the list draw on top, so check reversed.
        """
        from data import ZONES
        wx, wz = self.screen_to_world(sx, sy)
        for zi in range(len(ZONES) - 1, -1, -1):
            if _point_in_polygon(wx, wz, ZONES[zi]["points"]):
                return zi
        return None

    def _draw_roads(self, cr, vx0, vz0, vx1, vz1):
        """
        Draw roads using the spatial index for viewport culling.
        Only roads overlapping the visible rect are drawn.
        Draw order: local → minor_artery → major_artery → highway →
        interstate (wider roads on top). Divided sections (median/
        divider) are drawn over the base ribbon for their point ranges.
        """
        if not self.app.spatial_index:
            return

        # Get candidate road indices from spatial index
        indices = self.app.spatial_index.query(vx0, vz0, vx1, vz1)

        # Group by category for draw order. Categories are normalized
        # (legacy "arterial" -> "minor_artery") so old data keeps working.
        by_cat = {c: [] for c in CATEGORY_ORDER}
        for idx in indices:
            cat, road, _, _, _, _ = self.app.spatial_index.roads[idx]
            by_cat.setdefault(normalize_category(cat), []).append(
                (road, idx))

        # Minimum screen width to bother drawing (perf optimization)
        # At very low zoom, skip local roads entirely
        draw_local = self.zoom > 0.03

        for cat in reversed(CATEGORY_ORDER):
            if cat == "local" and not draw_local:
                continue
            style = ROAD_STYLE[cat]
            r, g, b = style["color"]

            for road, idx in by_cat.get(cat, []):
                pts = road.get("pts", [])
                if len(pts) < 2:
                    continue
                # Per-road width class (Joshua 2026-10-11: Edit → Road
                # Appearance). Defaults to standard for older data.
                wmult = WIDTH_MULT.get(
                    road.get("width_class", "standard"), 1.0)
                # Line width in screen pixels = world width * zoom
                # Minimum 1px so roads are always visible
                lw = max(1.0, style["width"] * wmult * self.zoom)
                world_w = style["width"] * wmult

                # Cul-de-sac turnaround bulb (Joshua 2026-10-11): a
                # modest rounded bulb at the dead end, drawn under the
                # ribbon so the road's round end cap blends into it.
                if road.get("cul_de_sac"):
                    self._draw_cul_de_sac_bulb(cr, pts, road, (r, g, b))

                cr.set_source_rgb(r, g, b)
                cr.set_line_width(lw)
                cr.set_line_cap(1)   # round caps
                cr.set_line_join(1)  # round joins

                # Convert to screen coords
                first = True
                for px, pz in pts:
                    sx, sy = self.world_to_screen(px, pz)
                    if first:
                        cr.move_to(sx, sy)
                        first = False
                    else:
                        cr.line_to(sx, sy)
                cr.stroke()

                # Divided sections (median/divider): drawn over the base
                # ribbon for their point ranges only (Joshua 2026-10-11).
                if (cat in DIVIDABLE_CATEGORIES
                        and road.get("divided_sections")):
                    self._draw_divided_sections(cr, pts, road, world_w,
                                                (r, g, b))

                # Lane markings (paint style), drawn on top of the ribbon.
                paint = road.get("paint", "none")
                if paint in PAINT_STYLES and paint != "none":
                    self._draw_paint(cr, pts, paint, lw)

                # Border sidewalks (Joshua 2026-10-11: Edit → Road
                # Appearance). Thin concrete strips on the selected side(s).
                if road.get("sidewalk_left") or road.get("sidewalk_right"):
                    self._draw_sidewalks(cr, pts, road, lw)

    def _draw_road_labels(self, cr, vx0, vz0, vx1, vz1):
        """
        Draw street name labels, filtered by zoom level (Google Maps
        style). Zoomed out shows only interstate names; zooming in
        progressively adds highways, arteries, then local streets.
        One label per road at its midpoint. Joshua 2026-10-12.
        """
        if not self.app.spatial_index:
            return
        # Which categories get labels at this zoom?
        label_cats = _label_categories_for_zoom(self.zoom)
        # Candidate roads from the spatial index (viewport-culled).
        indices = self.app.spatial_index.query(vx0, vz0, vx1, vz1)
        cr.select_font_face("Sans", 0, 0)  # normal weight
        cr.set_font_size(LABEL_FONT_SIZE)
        seen_names = set()  # one label per unique road name on screen
        for idx in indices:
            cat, road, _, _, _, _ = self.app.spatial_index.roads[idx]
            if normalize_category(cat) not in label_cats:
                continue
            name = road.get("name") or "Unnamed"
            if name in seen_names:
                continue  # already labeled this road on screen
            pts = road.get("pts", [])
            if len(pts) < 2:
                continue
            # Convert to screen coords and measure on-screen length.
            spts = [self.world_to_screen(px, pz) for px, pz in pts]
            screen_len = sum(
                math.hypot(spts[i + 1][0] - spts[i][0],
                           spts[i + 1][1] - spts[i][1])
                for i in range(len(spts) - 1))
            if screen_len < LABEL_MIN_SCREEN_LEN:
                continue  # too short on screen — skip to avoid clutter
            # Label at the road midpoint.
            mid = spts[len(spts) // 2]
            seen_names.add(name)
            # Dark outline (drawn first, slightly offset in 4 directions)
            # then white text on top, for readability over any road color.
            ext = cr.text_extents(name)
            tx = mid[0] - ext.width / 2
            ty = mid[1] + ext.height / 2
            cr.set_source_rgb(0.05, 0.05, 0.08)
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                cr.move_to(tx + dx, ty + dy)
                cr.show_text(name)
            cr.set_source_rgb(1.0, 1.0, 1.0)
            cr.move_to(tx, ty)
            cr.show_text(name)

    def _draw_paint(self, cr, pts, paint, road_lw):
        """
        Draw lane markings on a road polyline (screen space).

        paint "dotted": white dotted center line.
        paint "dotted_yellow": yellow solid center line + white dotted
        edge lines. road_lw is the road ribbon width in screen pixels.
        """
        spts = [self.world_to_screen(px, pz) for px, pz in pts]
        if len(spts) < 2:
            return
        if paint == "dotted":
            # White dotted center line down the middle of the road.
            cr.set_source_rgb(1.0, 1.0, 1.0)
            cr.set_line_width(max(1.0, road_lw * 0.08))
            cr.set_dash([8.0, 10.0])
            cr.move_to(*spts[0])
            for p in spts[1:]:
                cr.line_to(*p)
            cr.stroke()
            cr.set_dash([])
        elif paint == "dotted_yellow":
            # Offset edge lines run parallel to the centerline. Compute
            # a perpendicular at each point from its neighbors.
            off = road_lw * 0.28
            left, right = [], []
            for i, (sx, sy) in enumerate(spts):
                if i == 0:
                    dx, dy = spts[1][0] - sx, spts[1][1] - sy
                elif i == len(spts) - 1:
                    dx, dy = sx - spts[i - 1][0], sy - spts[i - 1][1]
                else:
                    dx, dy = (spts[i + 1][0] - spts[i - 1][0],
                              spts[i + 1][1] - spts[i - 1][1])
                length = math.hypot(dx, dy) or 1.0
                nx, ny = -dy / length, dx / length
                left.append((sx + nx * off, sy + ny * off))
                right.append((sx - nx * off, sy - ny * off))
            # Yellow solid center line.
            cr.set_source_rgb(1.0, 0.85, 0.0)
            cr.set_line_width(max(1.5, road_lw * 0.1))
            cr.move_to(*spts[0])
            for p in spts[1:]:
                cr.line_to(*p)
            cr.stroke()
            # White dotted edge lines.
            cr.set_source_rgb(1.0, 1.0, 1.0)
            cr.set_line_width(max(1.0, road_lw * 0.06))
            cr.set_dash([6.0, 8.0])
            for line in (left, right):
                cr.move_to(*line[0])
                for p in line[1:]:
                    cr.line_to(*p)
                cr.stroke()
            cr.set_dash([])

    def _draw_sidewalks(self, cr, pts, road, road_lw):
        """
        Draw border sidewalks as thin concrete strips alongside the road
        on the selected side(s). Sidewalk width class (narrow/standard/
        wide) controls strip thickness. Drawn OUTSIDE the road ribbon
        so they read as borders, not overlays.
        (Joshua 2026-10-11: Edit → Road Appearance → Border sidewalks.)
        """
        spts = [self.world_to_screen(px, pz) for px, pz in pts]
        if len(spts) < 2:
            return
        # Sidewalk strip thickness relative to the road ribbon width.
        sw_mult = {"narrow": 0.12, "standard": 0.2, "wide": 0.32}
        sw = max(2.0, road_lw *
                 sw_mult.get(road.get("sidewalk_width", "standard"), 0.2))
        # Gap between the road edge and the sidewalk strip.
        gap = max(1.5, road_lw * 0.06)
        # Distance from centerline to the strip center.
        dist = road_lw / 2.0 + gap + sw / 2.0
        sides = []
        if road.get("sidewalk_left"):
            sides.append(1.0)
        if road.get("sidewalk_right"):
            sides.append(-1.0)
        cr.set_source_rgb(0.78, 0.78, 0.75)  # concrete light gray
        cr.set_line_width(sw)
        cr.set_line_cap(1)
        cr.set_line_join(1)
        for side in sides:
            strip = []
            for i, (sx, sy) in enumerate(spts):
                if i == 0:
                    dx, dy = spts[1][0] - sx, spts[1][1] - sy
                elif i == len(spts) - 1:
                    dx, dy = sx - spts[i - 1][0], sy - spts[i - 1][1]
                else:
                    dx, dy = (spts[i + 1][0] - spts[i - 1][0],
                              spts[i + 1][1] - spts[i - 1][1])
                length = math.hypot(dx, dy) or 1.0
                nx, ny = -dy / length, dx / length
                strip.append((sx + nx * dist * side,
                              sy + ny * dist * side))
            cr.move_to(*strip[0])
            for p in strip[1:]:
                cr.line_to(*p)
            cr.stroke()

    def _draw_divided_sections(self, cr, pts, road, world_w, rgb):
        """
        Draw divided sections (median/divider) over the base road ribbon.

        Each section {"from_idx", "to_idx", "type"} covers a point-index
        range. The road visually splits into two direction ribbons with a
        median (raised light-gray strip, ~8 world units) or divider (dark
        ~4-unit strip with posts) between them. Section boundaries taper
        smoothly over DIVIDE_TAPER_PTS points. Direction labels (N/S or
        E/W, from the road's angle) are drawn on each ribbon.
        (Joshua 2026-10-11: segmentable medians/dividers.)
        """
        n = len(pts)
        sections = road.get("divided_sections") or []
        # Screen-space points and per-point perpendiculars (same pattern
        # as _draw_paint/_draw_sidewalks).
        spts = [self.world_to_screen(px, pz) for px, pz in pts]
        normals = []
        for i, (sx, sy) in enumerate(spts):
            if i == 0:
                dx, dy = spts[1][0] - sx, spts[1][1] - sy
            elif i == len(spts) - 1:
                dx, dy = sx - spts[i - 1][0], sy - spts[i - 1][1]
            else:
                dx, dy = (spts[i + 1][0] - spts[i - 1][0],
                          spts[i + 1][1] - spts[i - 1][1])
            length = math.hypot(dx, dy) or 1.0
            normals.append((-dy / length, dx / length))

        lab_l, lab_r = _direction_labels(pts)

        for sec in sections:
            dtype = sec.get("type")
            if dtype not in DIVIDER_TYPES:
                continue  # "none" or corrupt entries: nothing to draw
            try:
                a = max(0, int(sec.get("from_idx", 0)))
                b = min(n - 1, int(sec.get("to_idx", 0)))
            except (TypeError, ValueError):
                continue
            if not (0 <= a < b < n):
                continue

            # Strip widths in world units.
            strip_w = MEDIAN_WIDTH if dtype == "median" else DIVIDER_WIDTH
            # Each direction ribbon gets half the remaining width.
            dir_w = max(1.0, (world_w - strip_w) / 2.0)
            # Lateral center offset of each ribbon from the centerline.
            center_off = strip_w / 2.0 + dir_w / 2.0

            # Taper factor per point index: 1.0 inside [a, b], ramping
            # 0→1 over DIVIDE_TAPER_PTS points at each boundary.
            T = DIVIDE_TAPER_PTS
            i0 = max(0, a - T)
            i1 = min(n - 1, b + T)

            def taper(i):
                """0..1 split factor for point index i."""
                if a <= i <= b:
                    return 1.0
                if i0 <= i < a:
                    return (i - i0) / max(1, a - i0)
                if b < i <= i1:
                    return (i1 - i) / max(1, i1 - b)
                return 0.0

            # Build the two offset ribbon polylines (screen space) and
            # the center strip polyline with per-point widths. src_idx
            # tracks the original point index of each appended vertex
            # (taper-zone endpoints with factor 0 are skipped).
            left_pts, right_pts, strip_pts = [], [], []
            strip_ws = []
            src_idx = []
            for i in range(i0, i1 + 1):
                f = taper(i)
                if f <= 0.0:
                    continue
                sx, sy = spts[i]
                nx, ny = normals[i]
                # Offset in screen px: world offset * zoom.
                off_px = center_off * f * self.zoom
                left_pts.append((sx + nx * off_px, sy + ny * off_px))
                right_pts.append((sx - nx * off_px, sy - ny * off_px))
                strip_pts.append((sx, sy))
                strip_ws.append(max(1.0, strip_w * f * self.zoom))
                src_idx.append(i)

            if len(left_pts) < 2:
                continue

            def src_taper(j):
                """Taper factor of the j-th drawn vertex."""
                return taper(src_idx[j])

            # Center strip: median = light gray, divider = dark.
            if dtype == "median":
                cr.set_source_rgb(0.80, 0.80, 0.77)
            else:
                cr.set_source_rgb(0.16, 0.16, 0.16)
            cr.set_line_cap(1)
            cr.set_line_join(1)
            # Vary width along the strip for the taper: draw as
            # segments so the taper is smooth.
            for j in range(len(strip_pts) - 1):
                cr.set_line_width((strip_ws[j] + strip_ws[j + 1]) / 2.0)
                cr.move_to(*strip_pts[j])
                cr.line_to(*strip_pts[j + 1])
                cr.stroke()

            # Divider posts: small tick marks across the dark strip.
            if dtype == "divider":
                cr.set_source_rgb(0.85, 0.85, 0.85)
                cr.set_line_width(max(1.0, 1.5 * self.zoom))
                for j in range(0, len(strip_pts), 4):
                    sx, sy = strip_pts[j]
                    nx, ny = normals[src_idx[j]]
                    pw = strip_ws[j] / 2.0 + 2.0
                    cr.move_to(sx + nx * pw, sy + ny * pw)
                    cr.line_to(sx - nx * pw, sy - ny * pw)
                    cr.stroke()

            # Two direction ribbons in the road's own color.
            r, g, b = rgb
            cr.set_source_rgb(r, g, b)
            cr.set_line_cap(1)
            cr.set_line_join(1)
            for ribbon in (left_pts, right_pts):
                for j in range(len(ribbon) - 1):
                    # Ribbon width tapers with the split factor.
                    f0 = src_taper(j)
                    f1 = src_taper(j + 1)
                    w = max(1.0, dir_w * (f0 + f1) / 2.0 * self.zoom)
                    cr.set_line_width(w)
                    cr.move_to(*ribbon[j])
                    cr.line_to(*ribbon[j + 1])
                    cr.stroke()

            # Direction labels on each ribbon: at the section midpoint
            # and at intervals for long sections.
            cr.set_source_rgb(1.0, 1.0, 1.0)
            cr.set_font_size(10)
            step = max(1, (b - a) // 3)
            label_src = set(range(a, b + 1, step)) | {(a + b) // 2}
            # Map source index -> drawn vertex for label placement.
            pos_of = {si: j for j, si in enumerate(src_idx)}
            for li in sorted(label_src):
                if li not in pos_of:
                    continue
                j = pos_of[li]
                for side, lab in ((1.0, lab_l), (-1.0, lab_r)):
                    sx, sy = (left_pts[j] if side > 0 else right_pts[j])
                    cr.move_to(sx - 4, sy + 4)
                    cr.show_text(lab)

    def _draw_selection(self, cr):
        """Draw a yellow highlight around each selected road (up to 2)."""
        for cat, idx in self.selected_roads:
            if idx >= len(self.app.spatial_index.roads):
                continue
            _, road, _, _, _, _ = self.app.spatial_index.roads[idx]
            pts = road.get("pts", [])
            if len(pts) < 2:
                continue
            # Yellow highlight, slightly wider than the road.
            # Respects the road's width class (Joshua 2026-10-11).
            # Category is normalized (legacy "arterial" -> "minor_artery").
            style = ROAD_STYLE[normalize_category(cat)]
            wmult = WIDTH_MULT.get(
                road.get("width_class", "standard"), 1.0)
            cr.set_source_rgb(1.0, 1.0, 0.0)
            cr.set_line_width(
                max(2.0, style["width"] * wmult * self.zoom + 4))
            cr.set_line_cap(1)
            cr.set_line_join(1)
            first = True
            for px, pz in pts:
                sx, sy = self.world_to_screen(px, pz)
                if first:
                    cr.move_to(sx, sy)
                    first = False
                else:
                    cr.line_to(sx, sy)
            cr.stroke()

    # ------------------------------------------------------------------
    # Overpass rendering and picking (Joshua 2026-10-11)
    # ------------------------------------------------------------------
    # Overpasses are drawn as raised bridge decks (distinct orange) with
    # their support pillars as dark gray circles. Approach ramps (where
    # a road has been linked) render as a gradient from road color up
    # to the deck.

    def _draw_overpasses(self, cr):
        """
        Draw all overpasses: orange deck rectangles, dark gray pillar
        circles, and name labels. Approach ramps (linked roads) get a
        gradient highlight from the road to the deck.
        """
        overpasses = getattr(self.app, "overpasses", [])
        if not overpasses:
            return
        # Deck dimensions (world units) — same defaults as overpass.py.
        deck_len, deck_w = 200.0, 60.0
        for ovp in overpasses:
            cx, cz = ovp.get("position", [0, 0])
            sx, sy = self.world_to_screen(cx, cz)
            # Deck size in screen pixels.
            sw = deck_len * self.zoom
            sh = deck_w * self.zoom
            # Don't draw if the deck is too small to see.
            if sw < 4 or sh < 2:
                continue
            # Highlight the pending link target (pulsing amber outline
            # while in link-overpass mode).
            is_target = (self.link_overpass_mode and
                         self.link_overpass_hover == id(ovp))
            # Deck: orange fill with darker outline.
            cr.set_source_rgb(1.0, 0.55, 0.1)  # orange
            cr.rectangle(sx - sw / 2, sy - sh / 2, sw, sh)
            cr.fill_preserve()
            cr.set_source_rgb(0.7, 0.35, 0.05)
            cr.set_line_width(2.0 if not is_target else 4.0)
            cr.stroke()
            # Deck height label (e.g. "25u").
            cr.set_source_rgb(1.0, 1.0, 1.0)
            cr.select_font_face("Sans", 0, 1)  # normal, bold
            cr.set_font_size(max(9, min(14, sh * 0.35)))
            htext = f"{ovp.get('deck_height', 25):.0f}u"
            ext = cr.text_extents(htext)
            cr.move_to(sx - ext.width / 2, sy + ext.height / 2)
            cr.show_text(htext)
            # Name label above the deck.
            name = ovp.get("name", "")
            if name:
                cr.set_source_rgb(1.0, 0.75, 0.3)
                cr.set_font_size(11)
                ext = cr.text_extents(name)
                cr.move_to(sx - ext.width / 2, sy - sh / 2 - 6)
                cr.show_text(name)
            # Pillars: dark gray circles.
            for p in ovp.get("pillars", []):
                psx, psy = self.world_to_screen(p["x"], p["z"])
                cr.set_source_rgb(0.25, 0.25, 0.28)
                pr = max(3.0, 8.0 * self.zoom)
                cr.arc(psx, psy, pr, 0, 2 * math.pi)
                cr.fill()
                # Median pillars get a white ring so Joshua can tell
                # them apart from outside pillars.
                if p.get("position") == "median":
                    cr.set_source_rgb(1.0, 1.0, 1.0)
                    cr.set_line_width(1.5)
                    cr.arc(psx, psy, pr, 0, 2 * math.pi)
                    cr.stroke()
            # Approach ramps: draw a gradient line from each linked
            # road's endpoint toward the deck edge.
            for ramp in ovp.get("approach_ramps", []):
                self._draw_ramp_gradient(cr, ovp, ramp)
            # Low clearance warning signs (Joshua 2026-10-11): yellow
            # diamonds with the clearance text, placed before the
            # overpass in both directions.
            for sign in ovp.get("low_clearance_signs", []):
                self._draw_clearance_sign(cr, sign)

    def _draw_ramp_gradient(self, cr, ovp, ramp):
        """
        Draw one approach ramp as a series of segments fading from the
        road color to the overpass orange. Gives Joshua a visual cue
        of where the terrain rises to meet the deck.
        """
        pts = ramp.get("points", [])
        if len(pts) < 2:
            return
        # 10 gradient steps from road gray to deck orange.
        steps = 10
        for i in range(steps):
            t0, t1 = i / steps, (i + 1) / steps
            # Interpolate along the ramp points.
            p0 = self._interp_ramp(pts, t0)
            p1 = self._interp_ramp(pts, t1)
            if p0 is None or p1 is None:
                continue
            # Color: gray (0.53) -> orange (1.0, 0.55, 0.1).
            r = 0.53 + (1.0 - 0.53) * t1
            g = 0.53 + (0.55 - 0.53) * t1
            b = 0.53 + (0.10 - 0.53) * t1
            cr.set_source_rgb(r, g, b)
            cr.set_line_width(max(2.0, 16.0 * self.zoom))
            cr.set_line_cap(1)
            s0 = self.world_to_screen(*p0)
            s1 = self.world_to_screen(*p1)
            cr.move_to(*s0)
            cr.line_to(*s1)
            cr.stroke()

    @staticmethod
    def _interp_ramp(pts, t):
        """
        Interpolate a point along a polyline at fraction t (0-1).
        Returns (x, z) or None if the polyline is empty.
        """
        if not pts:
            return None
        if len(pts) == 1:
            return (pts[0][0], pts[0][1])
        # Total length and target distance.
        total = 0.0
        seg_lens = []
        for i in range(len(pts) - 1):
            d = math.hypot(pts[i + 1][0] - pts[i][0],
                           pts[i + 1][1] - pts[i][1])
            seg_lens.append(d)
            total += d
        if total < 1e-9:
            return (pts[0][0], pts[0][1])
        target = t * total
        acc = 0.0
        for i, sl in enumerate(seg_lens):
            if acc + sl >= target:
                f = (target - acc) / sl if sl > 0 else 0.0
                x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f
                z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f
                return (x, z)
            acc += sl
        return (pts[-1][0], pts[-1][1])

    def _draw_clearance_sign(self, cr, sign):
        """
        Draw a low-clearance warning sign: a yellow diamond with the
        clearance text below it (Joshua 2026-10-11). Signs are auto-
        placed for overpasses with 9-16ft clearance.
        """
        sx, sy = self.world_to_screen(sign["x"], sign["z"])
        # Yellow diamond, ~24px.
        d = 14.0
        cr.set_source_rgb(1.0, 0.85, 0.0)  # warning yellow
        cr.move_to(sx, sy - d)
        cr.line_to(sx + d, sy)
        cr.line_to(sx, sy + d)
        cr.line_to(sx - d, sy)
        cr.close_path()
        cr.fill_preserve()
        cr.set_source_rgb(0.0, 0.0, 0.0)
        cr.set_line_width(2.0)
        cr.stroke()
        # Black "!" in the diamond.
        cr.set_source_rgb(0.0, 0.0, 0.0)
        cr.select_font_face("Sans", 0, 1)
        cr.set_font_size(14)
        cr.move_to(sx - 3, sy + 5)
        cr.show_text("!")
        # Clearance text below the diamond.
        text = sign.get("text", "LOW CLEARANCE")
        cr.set_source_rgb(1.0, 0.85, 0.0)
        cr.set_font_size(10)
        ext = cr.text_extents(text)
        cr.move_to(sx - ext.width / 2, sy + d + 14)
        cr.show_text(text)

    def _pick_overpass(self, sx, sy):
        """
        Find the overpass whose deck contains the screen point.
        Returns the overpass dict or None.
        """
        overpasses = getattr(self.app, "overpasses", [])
        deck_len, deck_w = 200.0, 60.0
        for ovp in reversed(overpasses):  # topmost first
            cx, cz = ovp.get("position", [0, 0])
            psx, psy = self.world_to_screen(cx, cz)
            sw = deck_len * self.zoom
            sh = deck_w * self.zoom
            # Generous pick area (min 20px) so small decks are clickable.
            pw = max(20.0, sw / 2 + 6)
            ph = max(20.0, sh / 2 + 6)
            if abs(sx - psx) <= pw and abs(sy - psy) <= ph:
                return ovp
        return None

    # ------------------------------------------------------------------
    # Input handling
    # ------------------------------------------------------------------

    def on_button_press(self, widget, event):
        """Handle mouse button press. Starts pan drag or tool action."""
        if event.button == 1:  # left click
            # Move-road mode is modal (Joshua 2026-10-12): a left click
            # drops the road at its current ghost position. Shift+click
            # skips endpoint snapping on drop.
            if self.move_road is not None:
                snap = not (event.state & Gdk.ModifierType.SHIFT_MASK)
                self.commit_move_road(snap=snap)
                return True
            # Divide-section picking takes precedence over every tool:
            # clicks select road point indices for the new divided
            # section (Joshua 2026-10-11).
            if self.divide_pick is not None:
                self._on_divide_pick_click(event)
                return True
            # Overpass linking mode (Joshua 2026-10-11): the user has
            # selected a road and clicked "Link to Overpass". The next
            # click on an overpass deck completes the link.
            if self.link_overpass_mode:
                ovp = self._pick_overpass(event.x, event.y)
                if ovp is not None:
                    self.app.complete_overpass_link(ovp)
                else:
                    self.app.set_status(
                        "Link to Overpass: click an overpass deck, "
                        "or press Escape to cancel.")
                return True
            # Road editing tools handle their own clicks (no pan drag).
            # Shift+click is the documented gesture; plain click works too.
            if self.active_tool == "extend":
                self._on_extend_click(event)
                return True
            if self.active_tool == "delete":
                self._on_delete_click(event)
                return True
            if self.active_tool == "fill":
                self._on_fill_click(event)
                return True
            if self.active_tool == "zone":
                # Zone tool: pins first, then boundary edges (click to add a
                # new pin), then the zone body. No panning here — right-click
                # still pans, and the Pan tool moves the map.
                pin = self._pick_zone_pin(event.x, event.y)
                if pin is not None:
                    # Grab an existing pin: start dragging it.
                    # Undo (Joshua 2026-10-12): snapshot before the
                    # drag mutates the polygon; committed on release.
                    # A drag that moves nothing pushes no history.
                    self.app.undo_begin("Edit Zone Boundary")
                    self.drag_pin = pin
                else:
                    edge = self._pick_zone_edge(event.x, event.y)
                    if edge is not None:
                        # Clicked a boundary edge: insert a new pin there.
                        # The new vertex goes right after edge_index so the
                        # polygon winding stays intact, and it is grabbed
                        # immediately so the user can drag it in one motion.
                        from data import ZONES
                        zone = ZONES[self.selected_zone]
                        edge_idx, wx, wz = edge
                        # Undo (Joshua 2026-10-12): snapshot before
                        # the insert mutates the polygon.
                        self.app.undo_begin("Edit Zone Boundary")
                        zone["points"].insert(edge_idx + 1, [wx, wz])
                        self.drag_pin = edge_idx + 1
                        self.queue_draw()
                    else:
                        zi = self._pick_zone(event.x, event.y)
                        self.selected_zone = zi
                        self.drag_pin = None
                        from data import ZONES
                        if zi is not None:
                            self.app.on_zone_selected(ZONES[zi]["name"])
                        else:
                            self.app.on_zone_selected(None)
                        # Google Maps feel (Joshua 2026-10-12): only pins
                        # are draggable in zone mode, so a drag that
                        # starts here pans the map.
                        self.dragging = True
                        self.drag_start = (event.x, event.y)
                        self.cam_start = (self.cam_x, self.cam_y)
                        self.queue_draw()
                return True

            self.dragging = True
            self.drag_start = (event.x, event.y)
            self.cam_start = (self.cam_x, self.cam_y)

            if self.active_tool == "select":
                # Google Maps feel (Joshua 2026-10-12): a click on a
                # road selects it WITHOUT panning; a drag that starts
                # on empty terrain pans the map. Hit-test first so a
                # road grab never nudges the camera.
                hit = self._pick_road_at(event.x, event.y)
                self._pick_road(event.x, event.y)
                if hit is not None:
                    self.dragging = False

        elif event.button == 3:  # right click — always pan
            self.dragging = True
            self.drag_start = (event.x, event.y)
            self.cam_start = (self.cam_x, self.cam_y)

        return True

    def on_button_release(self, widget, event):
        """End pan drag or pin drag."""
        if event.button in (1, 3):
            self.dragging = False
        if event.button == 1 and self.drag_pin is not None:
            # Finished dragging a zone pin: persist the polygon boundary.
            # Pins move freely (no rectangle constraints), so no
            # normalization is needed — the polygon is saved as-is.
            from data import ZONES
            zone = ZONES[self.selected_zone]
            n = len(zone["points"])
            bx0, bz0, bx1, bz1 = zone_bbox(zone)
            save_zone_edit(zone["name"], zone["points"])
            # Undo (Joshua 2026-10-12): commit the boundary edit.
            # A click without any drag changes nothing — skipped.
            self.app.undo_commit()
            # Mark for the close warning (Joshua 2026-10-11).
            try:
                self.app._mark_unpublished()
            except Exception:
                pass
            self.app.set_status(
                f"Zone: {zone['name']} — boundary updated "
                f"({n} pins, x {bx0:.0f}..{bx1:.0f}, z {bz0:.0f}..{bz1:.0f})")
            self.drag_pin = None
            self.queue_draw()
        return True

    def on_motion(self, widget, event):
        """Handle mouse move. Pan if dragging, or drag a zone pin."""
        self.mouse_pos = (event.x, event.y)

        # Move-road mode is modal (Joshua 2026-10-12): the ghost
        # preview follows the cursor 1:1 from the anchor point grabbed
        # when the mode started. Nothing else happens on mouse move.
        if self.move_road is not None:
            wx, wz = self.screen_to_world(event.x, event.y)
            ax, az = self.move_road["anchor"]
            self.move_road["dx"] = wx - ax
            self.move_road["dz"] = wz - az
            self.queue_draw()
            return True

        # Overpass link hover: track which overpass is under the cursor
        # so the target highlight follows the mouse (Joshua 2026-10-11).
        if self.link_overpass_mode and not self.dragging:
            ovp = self._pick_overpass(event.x, event.y)
            new_hover = id(ovp) if ovp is not None else None
            if new_hover != self.link_overpass_hover:
                self.link_overpass_hover = new_hover
                self.queue_draw()

        if self.drag_pin is not None and self.selected_zone is not None:
            # Dragging a zone polygon pin: move that vertex to the cursor.
            # Pins are fully independent — the polygon reshapes freely.
            from data import ZONES
            zone = ZONES[self.selected_zone]
            wx, wz = self.screen_to_world(event.x, event.y)
            zone["points"][self.drag_pin] = [wx, wz]
            self.queue_draw()
            return True

        if self.dragging:
            dx = event.x - self.drag_start[0]
            dy = event.y - self.drag_start[1]
            # Pan via the shared camera (absolute drag delta avoids
            # floating-point drift on long drags).
            self._camera.pan_from(self.cam_start[0], self.cam_start[1],
                                  dx, dy)
            self.queue_draw()
            return True

        # Hover feedback: hand cursor over a selected zone's pins
        if self.active_tool == "zone" and self.selected_zone is not None:
            win = self.get_window()
            if win is not None:
                if self._pick_zone_pin(event.x, event.y) is not None:
                    win.set_cursor(Gdk.Cursor(Gdk.CursorType.HAND1))
                else:
                    win.set_cursor(None)
        return True

    def on_scroll(self, widget, event):
        """Handle mouse wheel. Zoom centered on cursor."""
        if event.direction == Gdk.ScrollDirection.UP:
            self.zoom_at(event.x, event.y, 1.2)
        elif event.direction == Gdk.ScrollDirection.DOWN:
            self.zoom_at(event.x, event.y, 1 / 1.2)
        elif event.direction == Gdk.ScrollDirection.SMOOTH:
            # Smooth scrolling (touchpad)
            dx, dy = event.get_scroll_deltas()
            if dy != 0:
                factor = math.pow(1.0015, -dy)
                self.zoom_at(event.x, event.y, factor)
        return True

    # ------------------------------------------------------------------
    # Divide-section picking (Joshua 2026-10-11: segmentable medians)
    # ------------------------------------------------------------------

    @staticmethod
    def _nearest_point_index(wx, wz, pts):
        """
        Index of the road vertex nearest to world point (wx, wz).
        Returns (index, dist_world).
        """
        best_i, best_d = 0, float("inf")
        for i, (px, pz) in enumerate(pts):
            d = math.hypot(wx - px, wz - pz)
            if d < best_d:
                best_i, best_d = i, d
        return best_i, best_d

    def _on_divide_pick_click(self, event):
        """
        Handle a click while divide-section picking is active.
        First click = section start point, second click = end point.
        Both snap to the nearest vertex of the target road (12px
        tolerance). When both are picked, ask the app for the
        median/divider/none choice.
        """
        pick = self.divide_pick
        pts = pick["road"].get("pts", [])
        if len(pts) < 2:
            self.divide_pick = None
            self.queue_draw()
            return
        wx, wz = self.screen_to_world(event.x, event.y)
        idx, dist = self._nearest_point_index(wx, wz, pts)
        if dist > 12.0 / self.zoom:
            self.app.set_status(
                "Divide: click closer to the road to pick a point.")
            return
        if pick["start"] is None:
            pick["start"] = idx
            self.app.set_status(
                f"Divide: start = point {idx} — now click the end point.")
            self.queue_draw()
        else:
            a, b = sorted((pick["start"], idx))
            self.divide_pick = None
            self.queue_draw()
            if b - a < 1:
                self.app.set_status(
                    "Divide: pick two different points for a section.")
                return
            # Hand off to the app for the median/divider/none popup.
            self.app.ask_divider_type(pick["cat"], pick["idx"],
                                      pick["road"], a, b)

    def _pick_road(self, sx, sy):
        """
        Select-mode click: toggle-select the road near the click point.
        Clicking a selected road deselects it; a third road replaces the
        oldest selection. Clicking empty space clears the selection.
        Searches within 10 screen pixels, prefers wider roads.
        """
        wx, wz = self.screen_to_world(sx, sy)
        # Search radius in world units (10px / zoom)
        radius = 10 / self.zoom

        best = None
        best_dist = float("inf")
        # Check wider roads first
        # (interstate > highway > major_artery > minor_artery > local).
        for cat in CATEGORY_ORDER:
            for idx, (rcat, road, rx0, rz0, rx1, rz1) in enumerate(
                    self.app.spatial_index.roads):
                if rcat != cat:
                    continue
                # Quick bbox check (expanded by radius)
                if (wx < rx0 - radius or wx > rx1 + radius or
                        wz < rz0 - radius or wz > rz1 + radius):
                    continue
                # Point-to-polyline distance
                dist = self._point_to_road_dist(wx, wz, road.get("pts", []))
                if dist < radius and dist < best_dist:
                    best_dist = dist
                    best = (cat, idx)

        # Toggle-select into the selection list (max 2 roads).
        if best is None:
            # Clicked empty space: clear the selection.
            self.selected_roads = []
        else:
            key = (best[0], best[1])
            if key in self.selected_roads:
                # Already selected: deselect it.
                self.selected_roads.remove(key)
            elif len(self.selected_roads) < 2:
                self.selected_roads.append(key)
            else:
                # Third click: drop the oldest, keep the newest two.
                self.selected_roads.pop(0)
                self.selected_roads.append(key)
        self.app.on_roads_selected()
        self.queue_draw()

    def _point_to_road_dist(self, wx, wz, pts):
        """Minimum distance from point to polyline."""
        if len(pts) < 2:
            return float("inf")
        min_d = float("inf")
        for i in range(len(pts) - 1):
            x0, z0 = pts[i]
            x1, z1 = pts[i + 1]
            # Project point onto segment
            dx, dz = x1 - x0, z1 - z0
            length_sq = dx * dx + dz * dz
            if length_sq == 0:
                d = math.hypot(wx - x0, wz - z0)
            else:
                t = max(0, min(1, ((wx - x0) * dx + (wz - z0) * dz) / length_sq))
                px, pz = x0 + t * dx, z0 + t * dz
                d = math.hypot(wx - px, wz - pz)
            min_d = min(min_d, d)
        return min_d

    # ------------------------------------------------------------------
    # Road editing helpers (Join / Merge / Extend)
    # ------------------------------------------------------------------

    def _pick_road_at(self, sx, sy):
        """
        Pick the nearest road to a screen point WITHOUT changing selection.
        Returns (cat, flat_idx, road_dict, dist_world) or None.
        Searches within 10 screen pixels, prefers wider roads on ties.
        """
        if not self.app.spatial_index:
            return None
        wx, wz = self.screen_to_world(sx, sy)
        radius = 10 / self.zoom  # 10px tolerance in world units

        best = None
        best_dist = float("inf")
        # Widest roads first (interstate > highway > ... > local).
        for cat in CATEGORY_ORDER:
            for idx, (rcat, road, rx0, rz0, rx1, rz1) in enumerate(
                    self.app.spatial_index.roads):
                if rcat != cat:
                    continue
                if (wx < rx0 - radius or wx > rx1 + radius or
                        wz < rz0 - radius or wz > rz1 + radius):
                    continue
                dist = self._point_to_road_dist(wx, wz, road.get("pts", []))
                if dist < radius and dist < best_dist:
                    best_dist = dist
                    best = (cat, idx, road)
        if best is None:
            return None
        return best[0], best[1], best[2], best_dist

    def _road_name_of(self, cat, flat_idx):
        """Road display name for a (cat, flat_idx) pick. Never crashes."""
        try:
            _, road, _, _, _, _ = self.app.spatial_index.roads[flat_idx]
            return road.get("name") or "Unnamed"
        except Exception:
            return "Unnamed"

    def _get_road_dict(self, cat, flat_idx):
        """Fetch the live road dict for a (cat, flat_idx) pick, or None."""
        try:
            _, road, _, _, _, _ = self.app.spatial_index.roads[flat_idx]
            return road
        except Exception:
            return None

    @staticmethod
    def _nearest_endpoint(wx, wz, pts):
        """
        Which end of the polyline is closest to (wx, wz)?
        Returns (end_idx, dist) where end_idx is 0 or len(pts)-1.
        """
        d0 = math.hypot(wx - pts[0][0], wz - pts[0][1])
        d1 = math.hypot(wx - pts[-1][0], wz - pts[-1][1])
        if d0 <= d1:
            return 0, d0
        return len(pts) - 1, d1

    def _closest_point_on_road(self, wx, wz, pts):
        """
        Closest point on a polyline to (wx, wz).
        Returns (px, pz, dist).
        """
        best_d = float("inf")
        best_p = (pts[0][0], pts[0][1]) if pts else (wx, wz)
        for i in range(len(pts) - 1):
            x0, z0 = pts[i]
            x1, z1 = pts[i + 1]
            dx, dz = x1 - x0, z1 - z0
            length_sq = dx * dx + dz * dz
            if length_sq == 0:
                px, pz = x0, z0
            else:
                t = max(0, min(1,
                               ((wx - x0) * dx + (wz - z0) * dz) / length_sq))
                px, pz = x0 + t * dx, z0 + t * dz
            d = math.hypot(wx - px, wz - pz)
            if d < best_d:
                best_d = d
                best_p = (px, pz)
        return best_p[0], best_p[1], best_d

    # ------------------------------------------------------------------
    # Cul-de-sac turnaround bulbs (Joshua 2026-10-11)
    # ------------------------------------------------------------------
    # A cul-de-sac gets a MODEST rounded bulb at its dead end — just
    # enough space for a car to turn around (a small bulb/hammerhead,
    # NOT a roundabout). Default bulb radius in world units
    # (~25-30u diameter).

    CUL_DE_SAC_DEFAULT_RADIUS = 15.0

    def _endpoint_is_dead_end(self, wx, wz, exclude_road):
        """
        True if world point (wx, wz) is NOT within snap distance of any
        road other than exclude_road. An endpoint with no nearby road
        is a dead end — the turnaround bulb goes there.
        """
        if not self.app.spatial_index:
            return True  # no data loaded yet — treat as isolated
        for _rcat, r, _, _, _, _ in self.app.spatial_index.roads:
            if r is exclude_road:
                continue
            pts = r.get("pts", [])
            if len(pts) < 2:
                continue
            if self._closest_point_on_road(wx, wz, pts)[2] \
                    < self.MERGE_SNAP_TOLERANCE:
                return False
        return True

    def find_cul_de_sac_ends(self, road):
        """
        Return which of the road's endpoints are dead ends:
        ["start"], ["end"], ["start", "end"], or [].
        """
        pts = road.get("pts", [])
        if len(pts) < 2:
            return []
        ends = []
        if self._endpoint_is_dead_end(pts[0][0], pts[0][1], road):
            ends.append("start")
        if self._endpoint_is_dead_end(pts[-1][0], pts[-1][1], road):
            ends.append("end")
        return ends

    def refresh_cul_de_sac(self, cat, road):
        """
        Re-check a road's marked cul-de-sac end after a geometry change
        (merge / join / extend). If that end now touches another road,
        the turnaround bulb is removed automatically — it is no longer
        a dead end. Returns True when flags were cleared.
        (cat is accepted for a symmetric signature; it is not needed
        for the check itself.)
        """
        if not road.get("cul_de_sac"):
            return False
        pts = road.get("pts", [])
        if len(pts) < 2:
            return False
        end = road.get("cul_de_sac_end", "end")
        x, z = pts[0] if end == "start" else pts[-1]
        if self._endpoint_is_dead_end(x, z, road):
            return False  # still a dead end — keep the bulb
        road.pop("cul_de_sac", None)
        road.pop("cul_de_sac_end", None)
        road.pop("cul_de_sac_radius", None)
        return True

    def _carry_cul_de_sac_to_joined(self, road_a, road_b, ea, eb,
                                    new_road):
        """
        Join fixup: the two connecting ends lose their bulbs; a bulb
        on an outer (non-connecting) end carries over to the joined
        road. ea/eb: 0 = first point connected, -1 = last point
        connected. The joined road's start is A's outer end and its
        end is B's outer end.
        """
        # A's outer end in A's own terms: if A connected with its last
        # point (ea == -1), the outer end is its start, and vice versa.
        a_outer = "start" if ea == -1 else "end"
        # B's outer end: if B connected with its first point (eb == 0),
        # the outer end is its end, and vice versa.
        b_outer = "end" if eb == 0 else "start"
        # Clear whatever cul-de-sac fields were inherited from road_a —
        # the connecting ends must not keep their bulbs.
        new_road.pop("cul_de_sac", None)
        new_road.pop("cul_de_sac_end", None)
        new_road.pop("cul_de_sac_radius", None)
        a_kept = (road_a.get("cul_de_sac")
                  and road_a.get("cul_de_sac_end", "end") == a_outer)
        b_kept = (road_b.get("cul_de_sac")
                  and road_b.get("cul_de_sac_end", "end") == b_outer)
        if a_kept:
            new_road["cul_de_sac"] = True
            new_road["cul_de_sac_end"] = "start"
            new_road["cul_de_sac_radius"] = float(
                road_a.get("cul_de_sac_radius",
                           self.CUL_DE_SAC_DEFAULT_RADIUS))
        elif b_kept:
            new_road["cul_de_sac"] = True
            new_road["cul_de_sac_end"] = "end"
            new_road["cul_de_sac_radius"] = float(
                road_b.get("cul_de_sac_radius",
                           self.CUL_DE_SAC_DEFAULT_RADIUS))

    def _draw_cul_de_sac_bulb(self, cr, pts, road, color):
        """
        Draw the turnaround bulb: a modest filled circle centered on
        the dead-end point, in the road's color. Called BEFORE the
        ribbon stroke so the road's round end cap blends into the bulb.
        """
        if len(pts) < 2:
            return
        end = road.get("cul_de_sac_end", "end")
        ex, ez = pts[0] if end == "start" else pts[-1]
        radius = float(road.get("cul_de_sac_radius",
                               self.CUL_DE_SAC_DEFAULT_RADIUS))
        sx, sy = self.world_to_screen(ex, ez)
        sr = max(2.0, radius * self.zoom)
        cr.set_source_rgb(*color)
        cr.arc(sx, sy, sr, 0, 2 * math.pi)
        cr.fill()

    def clear_tool_state(self):
        """
        Clear the road selection and Extend in-progress picks.
        Called on Escape and whenever the active tool changes.
        """
        self.selected_roads = []
        self.extend_pick = None
        self.divide_pick = None  # cancel any divide-section picking
        self.link_overpass_mode = False  # cancel overpass linking
        self.link_overpass_hover = None
        # Cancel move-road mode too (Joshua 2026-10-12) — Escape must
        # never leave a road stuck to the cursor.
        if self.move_road is not None:
            self.move_road = None
            try:
                self.app.set_status("Move Road cancelled.")
            except Exception:
                pass
        try:
            self.app._update_merge_join_buttons()
        except Exception:
            pass  # toolbar not built yet during early init
        # Also refresh the Link to Overpass button state.
        try:
            self.app._update_link_overpass_button()
        except Exception:
            pass
        self.queue_draw()

    # ------------------------------------------------------------------
    # Fill tool: click an unzoned gap -> new zone fills its exact shape
    # ------------------------------------------------------------------

    # Flood-fill grid cell size in world units. Smaller = tighter fit to
    # the surrounding zone boundaries; 50u is a good balance.
    _FILL_CELL = 50.0
    # Safety cap on flood-fill size (prevents hangs on huge regions)
    _FILL_MAX_CELLS = 20000

    def _point_in_any_zone(self, wx, wz):
        """True if the world point is inside any zone polygon."""
        from data import ZONES
        for zone in ZONES:
            if _point_in_polygon(wx, wz, zone["points"]):
                return True
        return False

    def _flood_unzoned_from(self, wx, wz):
        """
        Flood fill (4-connected) from a world point over unzoned cells.
        Returns a set of (cx, cz) grid coords, or None if the click point
        is already inside a zone. Grid origin: cell (0,0) covers
        [0, cell) x [0, cell); negative coords use floor division.
        """
        cell = self._FILL_CELL
        if self._point_in_any_zone(wx, wz):
            return None
        start = (math.floor(wx / cell), math.floor(wz / cell))
        cluster = {start}
        stack = [start]
        while stack:
            cx, cz = stack.pop()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx + dx, cz + dy
                if (nx, ny) in cluster:
                    continue
                if len(cluster) >= self._FILL_MAX_CELLS:
                    # Cap reached; return what we have
                    return cluster
                # Cell center in world coords
                nwx = (nx + 0.5) * cell
                nwz = (ny + 0.5) * cell
                if self._point_in_any_zone(nwx, nwz):
                    continue
                cluster.add((nx, ny))
                stack.append((nx, ny))
        return cluster

    def _trace_cluster_boundary(self, cluster):
        """
        Build a polygon tracing the outer boundary of a cell cluster.
        Collects boundary edges (cell edges not shared with another
        cluster cell), orients them CCW (interior on left), chains them
        into loops, and returns the longest loop as world [[x, z], ...].
        Collinear vertices are simplified away.
        """
        cell = self._FILL_CELL
        # edge_next: start_corner -> end_corner (grid integer coords).
        # Winding is CCW so the interior stays on the left:
        #  bottom edge (cell below missing): (cx,cz) -> (cx+1,cz)
        #  right edge  (cell right missing): (cx+1,cz) -> (cx+1,cz+1)
        #  top edge    (cell above missing): (cx+1,cz+1) -> (cx,cz+1)
        #  left edge   (cell left missing):  (cx,cz+1) -> (cx,cz)
        edge_next = {}
        for (cx, cz) in cluster:
            if (cx, cz - 1) not in cluster:
                edge_next[(cx, cz)] = (cx + 1, cz)
            if (cx + 1, cz) not in cluster:
                edge_next[(cx + 1, cz)] = (cx + 1, cz + 1)
            if (cx, cz + 1) not in cluster:
                edge_next[(cx + 1, cz + 1)] = (cx, cz + 1)
            if (cx - 1, cz) not in cluster:
                edge_next[(cx, cz + 1)] = (cx, cz)

        # Chain edges into loops
        loops = []
        while edge_next:
            start = next(iter(edge_next))
            loop = [start]
            cur = edge_next.pop(start)
            while cur != start:
                loop.append(cur)
                nxt = edge_next.pop(cur, None)
                if nxt is None:
                    break  # broken chain; shouldn't happen for flood fills
                cur = nxt
            if cur == start and len(loop) >= 3:
                loops.append(loop)
        if not loops:
            return []
        # Longest loop = outer boundary (any holes are shorter)
        best = max(loops, key=len)
        points = [[c[0] * cell, c[1] * cell] for c in best]
        return self._simplify_polygon(points)

    @staticmethod
    def _simplify_polygon(points):
        """
        Remove collinear vertices from a polygon (common on orthogonal
        cell-boundary traces). Keeps the shape identical.
        """
        n = len(points)
        if n < 4:
            return points
        result = []
        for i in range(n):
            prev = points[(i - 1) % n]
            cur = points[i]
            nxt = points[(i + 1) % n]
            dx1, dz1 = cur[0] - prev[0], cur[1] - prev[1]
            dx2, dz2 = nxt[0] - cur[0], nxt[1] - cur[1]
            # Cross product ~0 means the three points are collinear
            if abs(dx1 * dz2 - dz1 * dx2) > 1e-9:
                result.append(cur)
        return result if len(result) >= 3 else points

    def _on_fill_click(self, event):
        """
        Fill tool click handler:
        1. If the click is inside an existing zone -> status message, done.
        2. Flood fill from the click to find the connected unzoned gap.
        3. Trace the gap's boundary polygon and create a new zone there.
        4. Select the new zone with the Zone tool for immediate refining.
        """
        wx, wz = self.screen_to_world(event.x, event.y)
        if self._point_in_any_zone(wx, wz):
            self.app.set_status("Fill: this area is already zoned.")
            return
        self.app.set_status("Fill: tracing gap boundary…")
        # Let the status bar repaint before the (possibly slow) fill
        while Gtk.events_pending():
            Gtk.main_iteration()
        cluster = self._flood_unzoned_from(wx, wz)
        if not cluster:
            self.app.set_status("Fill: could not trace the gap.")
            return
        points = self._trace_cluster_boundary(cluster)
        if len(points) < 3:
            self.app.set_status("Fill: gap too small or unclear.")
            return
        from data import (next_custom_zone_name, save_custom_zone,
                          CUSTOM_ZONE_COLORS, ZONES)
        name = next_custom_zone_name()
        n_custom = sum(1 for z in ZONES if z["name"].startswith("Zone "))
        color = CUSTOM_ZONE_COLORS[n_custom % len(CUSTOM_ZONE_COLORS)]
        # Undo (Joshua 2026-10-12): snapshot before the new zone is
        # created (save_custom_zone mutates ZONES + the overlay file).
        self.app.undo_begin("Create Zone")
        save_custom_zone(name, points, color)
        self.app.undo_commit()
        # Auto-push the updated zones.json (Joshua 2026-10-11).
        try:
            self.app._after_local_save()
        except Exception:
            pass
        # Refresh the Zones menu so the new zone appears there
        self.app._rebuild_zones_menu()
        # Select the new zone and switch to the Zone tool for refining
        new_idx = next((i for i, z in enumerate(ZONES)
                        if z["name"] == name), None)
        if new_idx is not None:
            self.selected_zone = new_idx
            self.drag_pin = None
            self.app.on_zone_selected(name)
            zb = self.app.tool_buttons.get("zone")
            if zb is not None:
                zb.set_active(True)
        self.app.set_status(
            f"Fill: created {name} ({len(points)} pins) — "
            "drag pins to refine the shape.")
        self.queue_draw()

    # ------------------------------------------------------------------
    # Join: combine the two selected roads into one road object.
    # (Joshua 2026-10-11: select-first workflow — roads are picked in
    # Select mode, then the Join toolbar button asks for confirmation.)
    # ------------------------------------------------------------------

    def do_join_from_selection(self):
        """
        Join the two selected roads into one road object.
        Called after Joshua confirms the Join dialog. The result keeps
        the first-selected road's name and category; both roads join at
        their nearest endpoints.
        """
        if len(self.selected_roads) != 2:
            return
        (cat_a, idx_a), (cat_b, idx_b) = self.selected_roads
        road_a = self._get_road_dict(cat_a, idx_a)
        road_b = self._get_road_dict(cat_b, idx_b)
        name_a = self._road_name_of(cat_a, idx_a)
        name_b = self._road_name_of(cat_b, idx_b)
        self.selected_roads = []
        if road_a is None or road_b is None:
            self.app.set_status("Join failed: a road is no longer available.")
            self.app._update_merge_join_buttons()
            self.queue_draw()
            return
        if road_a is road_b:
            self.app.set_status("Join: pick two different roads.")
            self.app._update_merge_join_buttons()
            self.queue_draw()
            return

        pts_a = [list(p) for p in road_a.get("pts", [])]
        pts_b = [list(p) for p in road_b.get("pts", [])]
        if len(pts_a) < 2 or len(pts_b) < 2:
            self.app.set_status("Join failed: a road has too few points.")
            self.app._update_merge_join_buttons()
            self.queue_draw()
            return

        # Undo (Joshua 2026-10-12): one undo step for the whole join.
        # (Placed after validation so failed joins push nothing.)
        self.app.undo_begin("Join Roads")

        # Find the nearest endpoint pair (4 combinations).
        # ea/eb: 0 = first point, -1 = last point.
        best = None
        for ea, pa in ((0, pts_a[0]), (-1, pts_a[-1])):
            for eb, pb in ((0, pts_b[0]), (-1, pts_b[-1])):
                d = math.hypot(pa[0] - pb[0], pa[1] - pb[1])
                if best is None or d < best[0]:
                    best = (d, ea, eb)
        _, ea, eb = best

        # Orient both so the touching ends meet in the middle:
        # A's connecting end goes last, B's connecting end goes first.
        a_pts = pts_a if ea == -1 else pts_a[::-1]
        b_pts = pts_b if eb == 0 else pts_b[::-1]
        # Skip B's first point if it duplicates A's last (avoid zero-length
        # segment); otherwise the gap segment bridges the two roads.
        if math.hypot(a_pts[-1][0] - b_pts[0][0],
                      a_pts[-1][1] - b_pts[0][1]) < 0.001:
            joined_pts = a_pts + b_pts[1:]
        else:
            joined_pts = a_pts + b_pts

        # New road keeps Road A's name/category; preserve A's other fields.
        new_road = {"name": road_a.get("name", "Unnamed"),
                    "pts": joined_pts}
        for k, v in road_a.items():
            if k not in new_road:
                new_road[k] = v

        # Cul-de-sac fixup (Joshua 2026-10-11): the two connecting
        # ends lose their bulbs; a bulb on an outer end carries over.
        self._carry_cul_de_sac_to_joined(road_a, road_b, ea, eb,
                                        new_road)

        ok = self.app.apply_road_join(cat_a, road_a, cat_b, road_b, new_road)
        if ok:
            self.app.set_status(
                f"{name_a} + {name_b} \u2192 {new_road['name']} "
                f"({len(joined_pts)} pts)")
        else:
            self.app.set_status("Join failed: could not update road data.")
        # Undo (Joshua 2026-10-12): commit the join. A failed join
        # changed nothing, so the commit is a safe no-op there.
        self.app.undo_commit()
        self.app._update_merge_join_buttons()
        self.queue_draw()

    # ------------------------------------------------------------------
    # Merge: connect the two selected roads for traffic flow.
    # (Joshua 2026-10-11: select-first workflow — roads are picked in
    # Select mode, then the Merge toolbar button asks for confirmation.)
    # (Joshua 2026-10-12: merge is a snap — the source endpoint moves to
    # the nearest point on the target road's edge. No auto-extend.)
    # ------------------------------------------------------------------

    # Dead-end check tolerance in world units: an endpoint within this
    # distance of another road is not a dead end (cul-de-sac check).
    MERGE_SNAP_TOLERANCE = 50.0

    def _merge_source_end(self, pts_s, pts_t):
        """
        Which end of the source polyline is closer to the target road?
        Returns 0 (start) or len(pts_s)-1 (end). Used by the
        selection-based Merge: the first-selected road is the source.
        """
        d0 = self._closest_point_on_road(pts_s[0][0], pts_s[0][1], pts_t)[2]
        d1 = self._closest_point_on_road(pts_s[-1][0], pts_s[-1][1], pts_t)[2]
        return 0 if d0 <= d1 else len(pts_s) - 1

    def do_merge_from_selection(self):
        """
        Merge the two selected roads (selection-based workflow).
        The first-selected road is the source, the second is the target.
        The source endpoint nearest the target road snaps onto the
        target road's edge. Both roads stay separate
        objects. Called after Joshua confirms the Merge dialog.
        """
        if len(self.selected_roads) != 2:
            return
        (cat_s, idx_s), (cat_t, idx_t) = self.selected_roads
        road_s = self._get_road_dict(cat_s, idx_s)
        road_t = self._get_road_dict(cat_t, idx_t)
        self.selected_roads = []
        if road_s is None or road_t is None:
            self.app.set_status("Merge failed: a road is unavailable.")
            self.app._update_merge_join_buttons()
            self.queue_draw()
            return
        if road_s is road_t:
            self.app.set_status(
                "Merge: source and target must be different roads.")
            self.app._update_merge_join_buttons()
            self.queue_draw()
            return
        pts_s = road_s.get("pts", [])
        pts_t = road_t.get("pts", [])
        if len(pts_s) < 2 or len(pts_t) < 2:
            self.app.set_status("Merge failed: a road has too few points.")
            self.app._update_merge_join_buttons()
            self.queue_draw()
            return
        end_s = self._merge_source_end(pts_s, pts_t)
        # Undo (Joshua 2026-10-12): one undo step for the whole merge.
        self.app.undo_begin("Merge Roads")
        self._do_merge(cat_s, road_s, end_s, cat_t, road_t)
        self.app.undo_commit()
        self.app._update_merge_join_buttons()
        self.queue_draw()

    def _do_merge(self, cat_s, road_s, end_s, cat_t, road_t):
        """
        Merge: snap road_s's endpoint onto road_t's edge.
        (Joshua 2026-10-12: merge works like a snap — the source
        endpoint moves to the nearest point on the target road's
        edge. The old "find the point, then extend geometry" branch
        is gone: it stretched roads clear across the map instead of
        snapping.)
        Both roads stay separate objects; only the source endpoint moves.
        """
        pts_s = road_s.get("pts", [])
        pts_t = road_t.get("pts", [])
        if len(pts_s) < 2 or len(pts_t) < 2:
            self.app.set_status("Merge failed: a road has too few points.")
            return
        ex, ez = pts_s[end_s]
        # Snap target: nearest point on the target road's edge to the
        # source endpoint.
        tx, tz, dist = self._closest_point_on_road(ex, ez, pts_t)
        name_s = road_s.get("name") or "Unnamed"
        name_t = road_t.get("name") or "Unnamed"

        new_pts = [list(p) for p in pts_s]
        # Snap: move the endpoint onto the target road's edge. No
        # auto-extend — the endpoint simply relocates to (tx, tz).
        new_pts[end_s] = [tx, tz]
        action = f"snapped ({dist:.0f}u)"
        road_s["pts"] = new_pts
        # Cul-de-sac (Joshua 2026-10-11): the moved end is now
        # connected — drop its turnaround bulb if it had one. Also
        # re-check the target road: the merge may have closed one of
        # its dead ends.
        self.refresh_cul_de_sac(cat_s, road_s)
        if self.refresh_cul_de_sac(cat_t, road_t):
            self.app.apply_road_modify(cat_t, road_t)
        if self.app.apply_road_modify(cat_s, road_s):
            self.app.set_status(f"Merged {name_s} \u2192 {name_t} ({action}).")
        else:
            self.app.set_status("Merge failed: could not save the change.")

    # ------------------------------------------------------------------
    # Move Road: pick up an entire road and relocate it, preserving its
    # shape. (Joshua 2026-10-12: some streets have the right shape but
    # are in the wrong location.)
    #
    # Workflow: select exactly one road, then Edit -> Move Road. The
    # road sticks to the cursor (ghost preview follows the mouse).
    # Click or press Enter to drop it, Escape to cancel. On drop, each
    # endpoint within MERGE_SNAP_TOLERANCE of another road's edge snaps
    # onto that edge (hold Shift while dropping to skip snapping).
    # The move is one undo step ("Move Road").
    # ------------------------------------------------------------------

    def start_move_road(self):
        """
        Enter move-road mode for the single selected road.
        Returns True if the mode started, False otherwise.
        """
        sel = self.selected_roads
        if len(sel) != 1:
            self.app.set_status(
                "Move Road: select exactly one road first.")
            return False
        cat, flat_idx = sel[0]
        road = self._get_road_dict(cat, flat_idx)
        if road is None or len(road.get("pts", [])) < 2:
            self.app.set_status("Move Road: the selected road is invalid.")
            return False
        # Anchor the drag at the current mouse position in world coords
        # so the road follows the cursor 1:1 from the moment the mode
        # starts (sticky-cursor style, no press-and-hold needed).
        try:
            awx, awz = self.screen_to_world(*self.mouse_pos)
        except Exception:
            awx, awz = road["pts"][0][0], road["pts"][0][1]
        self.move_road = {"cat": cat, "road": road,
                          "anchor": (awx, awz), "dx": 0.0, "dz": 0.0}
        name = road.get("name") or "Unnamed"
        self.app.set_status(
            f"Move Road: '{name}' follows the cursor. Click or press "
            f"Enter to drop it (Shift+click skips endpoint snapping), "
            f"Escape to cancel.")
        self.queue_draw()
        return True

    def cancel_move_road(self):
        """Leave move-road mode without changing anything."""
        if self.move_road is None:
            return
        self.move_road = None
        self.app.set_status("Move Road cancelled.")
        self.queue_draw()

    def _move_road_snap_endpoints(self, cat, road):
        """
        After a move, snap any endpoint that landed within
        MERGE_SNAP_TOLERANCE of another road's edge onto that edge
        (same snap semantics as Merge). The road itself is excluded
        from the search. Returns the number of endpoints snapped.
        """
        pts = road.get("pts", [])
        if len(pts) < 2 or not self.app.spatial_index:
            return 0
        snapped = 0
        for end_idx in (0, len(pts) - 1):
            ex, ez = pts[end_idx]
            best = None  # (dist, tx, tz)
            for idx in self.app.spatial_index.query(
                    ex - self.MERGE_SNAP_TOLERANCE,
                    ez - self.MERGE_SNAP_TOLERANCE,
                    ex + self.MERGE_SNAP_TOLERANCE,
                    ez + self.MERGE_SNAP_TOLERANCE):
                _c, other, _, _, _, _ = \
                    self.app.spatial_index.roads[idx]
                if other is road:
                    continue  # never snap to ourselves
                tx, tz, dist = self._closest_point_on_road(
                    ex, ez, other.get("pts", []))
                if dist <= self.MERGE_SNAP_TOLERANCE and (
                        best is None or dist < best[0]):
                    best = (dist, tx, tz)
            if best is not None:
                _dist, tx, tz = best
                pts[end_idx] = [tx, tz]
                snapped += 1
        return snapped

    def commit_move_road(self, snap=True):
        """
        Drop the road at its current ghost position. Applies the
        accumulated (dx, dz) offset to every point, snaps endpoints to
        nearby roads (unless snap=False), and records one undo step.
        A zero-offset drop is a silent no-op (no history entry).
        """
        mv = self.move_road
        self.move_road = None
        if mv is None:
            return
        cat, road = mv["cat"], mv["road"]
        dx, dz = mv["dx"], mv["dz"]
        name = road.get("name") or "Unnamed"
        if abs(dx) < 0.001 and abs(dz) < 0.001:
            # Clicked without moving: nothing to do, no undo step.
            self.app.set_status(f"Move Road: '{name}' not moved.")
            self.queue_draw()
            return
        # Undo (Joshua 2026-10-12): snapshot BEFORE the pts shift so
        # the whole move undoes as one step.
        self.app.undo_begin("Move Road")
        # Shift every point by the same offset — the road keeps its
        # exact shape. Divided-section indices stay valid because the
        # point count and order don't change; the cul-de-sac bulb is
        # drawn from the dead-end point, so it rides along for free.
        road["pts"] = [[p[0] + dx, p[1] + dz]
                       for p in road.get("pts", [])]
        snapped = 0
        if snap:
            snapped = self._move_road_snap_endpoints(cat, road)
        # Re-check the turnaround bulb: the move may have connected or
        # disconnected a dead end (Joshua 2026-10-11).
        self.refresh_cul_de_sac(cat, road)
        if self.app.apply_road_modify(cat, road):
            msg = (f"Moved '{name}' by ({dx:.0f}, {dz:.0f}).")
            if snapped:
                msg += f" {snapped} endpoint(s) snapped to nearby roads."
            self.app.set_status(msg)
        else:
            self.app.set_status("Move Road failed: could not save.")
        # Commit the undo step (skipped automatically if the state
        # somehow ended up unchanged).
        self.app.undo_commit()
        self.queue_draw()

    def _draw_move_ghost(self, cr):
        """
        Draw the move-road ghost preview: the selected road's polyline
        shifted by the current (dx, dz), in bright highlight color, on
        top of everything else. Called from on_draw while move-road mode
        is active.
        """
        mv = self.move_road
        if mv is None:
            return
        pts = mv["road"].get("pts", [])
        if len(pts) < 2:
            return
        dx, dz = mv["dx"], mv["dz"]
        # Bright yellow-green, slightly transparent so the original
        # road shows through underneath.
        cr.set_source_rgba(0.7, 1.0, 0.2, 0.85)
        cr.set_line_width(max(2.0, 6.0 * self.zoom))
        cr.set_line_cap(1)   # round caps
        cr.set_line_join(1)  # round joins
        cr.set_dash([8.0, 4.0])  # dashed = "preview, not committed"
        first = True
        for px, pz in pts:
            sx, sy = self.world_to_screen(px + dx, pz + dz)
            if first:
                cr.move_to(sx, sy)
                first = False
            else:
                cr.line_to(sx, sy)
        cr.stroke()
        cr.set_dash([])

    # ------------------------------------------------------------------
    # Extend tool: click near a road -> closest endpoint auto-selected
    # (zoom-aware tolerance), click destination -> road stretches there.
    # ------------------------------------------------------------------

    def _on_extend_click(self, event):
        """
        Extend tool click handler. Two steps:
        1. Click on/near a road -> the CLOSEST endpoint (either end) is
           auto-selected. Tolerance scales with zoom: 20px on screen.
        2. Click the destination -> the road extends from the selected
           endpoint to that point.
        """
        wx, wz = self.screen_to_world(event.x, event.y)
        if self.extend_pick is None:
            # Step 1: find the nearest road, then its nearest endpoint.
            # Tolerance is zoom-aware: 20 screen px -> world units.
            tolerance = 20.0 / self.zoom
            pick = self._pick_road_at(event.x, event.y)
            if pick is None:
                self.app.set_status(
                    "Extend: click on or near a road endpoint.")
                return
            cat, flat_idx, road, road_dist = pick
            if road_dist > tolerance:
                self.app.set_status(
                    "Extend: click closer to a road.")
                return
            pts = road.get("pts", [])
            if len(pts) < 2:
                self.app.set_status("Extend: road has too few points.")
                return
            end_idx, end_dist = self._nearest_endpoint(wx, wz, pts)
            if end_dist > tolerance:
                self.app.set_status(
                    "Extend: click closer to a road endpoint.")
                return
            self.extend_pick = (cat, flat_idx, end_idx)
            name = road.get("name") or "Unnamed"
            end_label = "start" if end_idx == 0 else "end"
            self.app.set_status(
                f"Extend: {name} ({end_label} endpoint selected) — "
                "now click the destination point.")
            self.queue_draw()
        else:
            # Step 2: extend the selected endpoint to the clicked point.
            cat, flat_idx, end_idx = self.extend_pick
            road = self._get_road_dict(cat, flat_idx)
            self.extend_pick = None
            if road is None:
                self.app.set_status(
                    "Extend failed: the road is no longer available.")
                self.queue_draw()
                return
            pts = road.get("pts", [])
            if len(pts) < 2:
                self.app.set_status("Extend failed: road has too few points.")
                self.queue_draw()
                return
            # Clamp end_idx (road may have changed since the pick)
            end_idx = 0 if end_idx == 0 else len(pts) - 1
            # Undo (Joshua 2026-10-12): one undo step for the extend.
            self.app.undo_begin("Extend Road")
            new_pts = [list(p) for p in pts]
            if end_idx == 0:
                new_pts.insert(0, [wx, wz])
            else:
                new_pts.append([wx, wz])
            road["pts"] = new_pts
            # Cul-de-sac (Joshua 2026-10-11): if the extended end now
            # touches another road, its turnaround bulb is removed.
            self.refresh_cul_de_sac(cat, road)
            name = road.get("name") or "Unnamed"
            if self.app.apply_road_modify(cat, road):
                self.app.set_status(
                    f"Extended {name} to ({wx:.0f}, {wz:.0f}).")
            else:
                self.app.set_status("Extend failed: could not save.")
            # Undo (Joshua 2026-10-12).
            self.app.undo_commit()
            self.queue_draw()

    # ------------------------------------------------------------------
    # Delete tool: click a road to remove it entirely.
    # ------------------------------------------------------------------

    def _on_delete_click(self, event):
        """Delete tool: click a road to delete it (asks for confirmation)."""
        pick = self._pick_road_at(event.x, event.y)
        if pick is None:
            self.app.set_status("Delete: click a road to delete it.")
            return
        cat, flat_idx, road, _ = pick
        name = road.get("name") or "Unnamed"
        if self.app.confirm_delete_road(name):
            # Undo (Joshua 2026-10-12): snapshot before the delete.
            self.app.undo_begin("Delete Road")
            if self.app.apply_road_delete(cat, road):
                self.app.set_status(f"Deleted road: {name}.")
            else:
                self.app.set_status("Delete failed: could not save.")
            self.app.undo_commit()
        self.queue_draw()
