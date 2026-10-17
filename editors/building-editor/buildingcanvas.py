#!/usr/bin/env python3
"""
Adamsville Asset Editor (Native) — Building preview canvas.

Cairo-based isometric building renderer. Draws the building as stacked
isometric boxes (one per floor) with colored wall faces, a roof, and
window/door rectangles placed on faces.

Supports:
- Drag to rotate the isometric view (changes view angle, not the building)
- Click-to-place mode for windows/doors (callback to app.py)
- Click-to-remove mode for windows/doors

This is a v1 preview renderer, not a full 3D engine. Real 3D rendering
(Blender integration) comes in a later version.

Joshua's rule: all code commented.
"""

import math
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib
import cairo


# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------

def hex_to_rgb(hex_color):
    """
    Convert a #rrggbb hex string to a (r, g, b) tuple of 0-1 floats.
    Returns a neutral gray if the input is invalid.
    """
    try:
        h = hex_color.lstrip("#")
        return (int(h[0:2], 16) / 255.0,
                int(h[2:4], 16) / 255.0,
                int(h[4:6], 16) / 255.0)
    except Exception:
        return (0.5, 0.5, 0.5)


def shade(rgb, factor):
    """
    Darken (factor < 1) or lighten (factor > 1) an RGB tuple.
    Used to give the three visible isometric faces different tones
    so the box reads as 3D.
    """
    r, g, b = rgb
    return (min(1.0, r * factor), min(1.0, g * factor), min(1.0, b * factor))


# ---------------------------------------------------------------------------
# Isometric projection
# ---------------------------------------------------------------------------

def iso_project(x, y, z, angle_rad):
    """
    Project a 3D point (x, y, z) to 2D screen offsets using a simple
    isometric-style projection rotated by angle_rad around the Y axis.

    x: right, y: up, z: depth. Returns (sx, sy) screen offsets.
    """
    # Rotate around Y axis by the view angle
    rx = x * math.cos(angle_rad) - z * math.sin(angle_rad)
    rz = x * math.sin(angle_rad) + z * math.cos(angle_rad)
    # Isometric: screen x from rotated x, screen y from height minus depth
    sx = rx
    sy = -y + rz * 0.5
    return sx, sy


# Face identifiers used in window/door placement
FACES = ("front", "right", "back", "left")


class BuildingCanvas(Gtk.DrawingArea):
    """
    Cairo drawing area that renders one building isometrically.

    The app sets self.building to the building dict being previewed.
    Interaction modes:
      "view"   — drag rotates the view; dragging a window/door marker
                 moves it on its face (Joshua 2026-10-11: windows were
                 landing off-position and needed repositioning).
                 Clicking a window (without dragging) selects it and
                 shows resize handles (v1.1.0).
      "add_window" / "add_door" — click a face to place the item
      "add_decoration" — click a face (wall types) or the ground
                 (floor types) to place a decoration (v1.1.0)
      "draw_fence" — click ground points to draw a fence polygon;
                 Finish/Clear via the app's buttons (v1.1.0)
      "add_parking" — click the ground to place a parking element
                 (lot / single space / garage) (v1.5.0)
      "remove" — click a window/door/decoration/parking marker to
                 delete it

    Placement callbacks: on_face_click(face, fx, fy) is called in
    add modes with the face name and fractional (0-1) position on it.
    on_item_click(kind, index) is called in remove mode.
    on_item_moved(kind, index) is called after a window/door drag ends
    so the app can persist the new position.
    on_decoration_click(info) is called in add_decoration mode with a
    dict describing the placement (wall or ground).
    on_fence_point(gx, gz) is called in draw_fence mode for each
    ground click, in building-relative preview units.
    on_parking_click(info) is called in add_parking mode with
    {"type", "gx", "gz"} in building-relative preview units.
    on_parking_selected(index) is called in view mode when a parking
    element is clicked (index) or deselected (None).
    """

    def __init__(self):
        """Set up the drawing area and input state."""
        super().__init__()
        # The building dict currently being previewed (set by app.py)
        self.building = None
        # View rotation angle in radians (drag to change)
        # Default view: front+right faces visible. v1.2.0: was 30deg
        # which only framed correctly with the (buggy) inverted
        # face culling; 150deg gives the same framing with correct
        # culling (Joshua 2026-10-11: walls disappeared on rotate).
        self.view_angle = math.radians(150)
        # Pixels per world unit (building is 10 x 6 x 10 units per floor)
        self.scale = 22.0
        # Current interaction mode
        self.mode = "view"
        # Callbacks wired by app.py
        self.on_face_click = None   # (face, fx, fy) in add modes
        self.on_item_click = None   # (kind, index) in remove mode
        self.on_item_moved = None   # (kind, index) after an item drag
        self.on_decoration_click = None  # (info dict) in add_decoration
        self.on_fence_point = None  # (gx, gz) in draw_fence mode
        # v1.5.0 (Joshua): parking placement/selection callbacks.
        self.on_parking_click = None  # (info dict) in add_parking mode
        self.on_parking_selected = None  # (index|None) in view mode
        # Pending parking type for add_parking mode ("lot"/"space"/"garage")
        self.pending_parking_type = "lot"
        # Nearby roads for context (set by app.py; list of road-index dicts)
        self.roads = []
        # True when the building footprint overlaps a road -> red outline
        self.collision = False
        # Drag state for rotation
        self._dragging = False
        self._drag_x = 0
        self._drag_angle = 0.0
        # Drag state for moving a window/door marker on its face.
        # Tuple: (kind, index, start_sx, start_sy, start_fx, start_fy)
        # or None when not item-dragging.
        self._item_drag = None
        # Selected window for resizing: ("window", index) or None.
        # Clicking a window without dragging selects it and shows
        # corner resize handles (v1.1.0).
        self._selected_item = None
        # Resize drag state: ("window", index, handle, start_sx, start_sy,
        #                      start_x, start_y, start_w, start_h)
        self._resize_drag = None
        # Fence drawing: accumulated ground points in draw_fence mode
        # (building-relative preview units). The app reads these via
        # get_fence_points() when finishing.
        self._fence_draft = []
        # Fence segment editing (v1.2.0, Joshua): click a segment to
        # select it (amber), drag its body to stretch along its
        # direction, drag sideways to spawn a 90-degree wall, hold
        # 500ms then drag to rotate it around its midpoint,
        # double-click to delete.
        self._fence_sel = None       # selected segment index
        self._fence_drag = None      # active endpoint-drag dict
        self._fence_press = None     # press info for click-vs-drag
        self._fence_hold_id = None   # GLib hold-timer id
        self._fence_rotating = False  # True once the hold timer fires
        self._fence_view_rot = None  # empty-space drag view-rotate state
        # App callback after a fence edit (refreshes status text)
        self.on_fence_edit = None
        # House move / pivot-rotate (v1.2.0, Joshua): left-drag on the
        # house body moves it; grabbing a vertical wall edge pivots
        # the building around that edge.
        self._house_drag = None      # dict while moving the house
        self._pivot_drag = None       # dict while pivot-rotating
        self._pivot_edge = None       # screen seg highlighted amber
        self._body_bbox = None        # cached screen bbox of building
        self._edge_segs = []          # visible vertical wall edges:
        # list of ((ax,ay),(bx,by),(lx,lz)) screen seg + local coords
        # Building rotation (clockwise-from-above, matching the game)
        # as cos/sin, refreshed each draw; used by culling + picking.
        self._rot_c, self._rot_s = 1.0, 0.0
        # App callback after a move/pivot: syncs the position/rotation
        # controls, saves, re-checks collision, redraws.
        self.on_transform_changed = None
        # Projection params saved during draw so input handlers can
        # invert screen->ground coordinates (v1.1.0)
        self._proj_cx = 0.0
        self._proj_cy = 0.0
        self._proj_bw = 10.0
        self._proj_bd = 10.0
        # Cached face polygons for hit testing: list of
        # (face_name, [(sx, sy), ...]) in screen coords
        self._face_polys = []
        # Cached window/door/decoration screen rects for remove mode:
        # list of (kind, index, (x, y, w, h))
        self._item_rects = []
        # Cached resize-handle screen positions for the selected window:
        # list of (handle_name, sx, sy)
        self._resize_handles = []

        self.set_can_focus(True)
        # 1.7.0 CRASH FIX: Gdk.EventMask.BUTTON3_MASK does not exist in
        # GTK3, so the old line raised AttributeError inside
        # BuildingCanvas.__init__ and every building tab died silently
        # (PyGObject only prints the traceback to stderr). The
        # press/release masks above already deliver button-3 events;
        # BUTTON3_MOTION_MASK is the valid GTK3 constant and adds
        # right-button motion.
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK |
                        Gdk.EventMask.BUTTON_RELEASE_MASK |
                        Gdk.EventMask.POINTER_MOTION_MASK |
                        Gdk.EventMask.BUTTON3_MOTION_MASK)
        self.connect("draw", self._on_draw)
        self.connect("button-press-event", self._on_button_press)
        self.connect("button-release-event", self._on_button_release)
        self.connect("motion-notify-event", self._on_motion)

    # -- public API used by app.py --------------------------------------

    def get_fence_draft(self):
        """Return the in-progress fence polygon points (preview units)."""
        return [list(p) for p in self._fence_draft]

    def clear_fence_draft(self):
        """Discard the in-progress fence polygon."""
        self._fence_draft = []
        self.queue_draw()

    # -- public API used by app.py --------------------------------------

    def set_building(self, building):
        """Set the building to preview and redraw."""
        self.building = building
        self.queue_draw()

    def set_mode(self, mode):
        """
        Set the interaction mode: "view", "add_window", "add_door",
        or "remove".
        """
        self.mode = mode
        self.queue_draw()

    # -- drawing --------------------------------------------------------

    def _on_draw(self, widget, cr):
        """Cairo draw handler: render the building isometrically."""
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height

        # Dark background
        cr.set_source_rgb(0.12, 0.12, 0.14)
        cr.paint()

        if not self.building:
            # Empty state message
            cr.set_source_rgb(0.55, 0.55, 0.6)
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                                cairo.FONT_WEIGHT_NORMAL)
            cr.set_font_size(14)
            cr.move_to(30, h // 2)
            cr.show_text("Open a building with the + button to preview it.")
            return

        b = self.building
        floors = max(1, min(5, int(b.get("floors", 1))))
        wall_rgb = hex_to_rgb(b.get("wall_color", "#c0c0c0"))
        roof_rgb = hex_to_rgb(b.get("roof_color", "#5a3a2a"))

        # Building footprint: 10 x 10 units, 4 units tall per floor
        bw, bd, fh = 10.0, 10.0, 4.0
        total_h = floors * fh

        # Center the building in the widget
        cx, cy = w / 2.0, h / 2.0 + total_h * self.scale * 0.15

        # Save projection params so input handlers can invert
        # screen->ground coordinates (fence drawing, floor decorations)
        self._proj_cx, self._proj_cy = cx, cy
        self._proj_bw, self._proj_bd = bw, bd
        # Building rotation (v1.2.0): clockwise-from-above, matching
        # fence_points_to_world() in data.py and the game's spawner,
        # so the preview shows the true orientation. Pivot-rotating
        # and the rotation slider now visibly turn the building.
        rot_deg = float(b.get("rotation", 0.0) or 0.0)
        rot_rad = math.radians(rot_deg)
        self._rot_c, self._rot_s = math.cos(rot_rad), math.sin(rot_rad)
        rc, rs = self._rot_c, self._rot_s

        def proj(x, y, z):
            """Project building-local (0..bw, 0..bd) to widget coords,
            applying the building rotation around its center first."""
            lx, lz = x - bw / 2.0, z - bd / 2.0
            rx = lx * rc - lz * rs
            rz = lx * rs + lz * rc
            sx, sy = iso_project(rx, y, rz, self.view_angle)
            return cx + sx * self.scale, cy + sy * self.scale

        def proj_raw(x, y, z):
            """Project WITHOUT building rotation (for world-fixed
            geometry like roads). Same 0..bw local coords."""
            sx, sy = iso_project(x - bw / 2, y, z - bd / 2,
                                 self.view_angle)
            return cx + sx * self.scale, cy + sy * self.scale

        # Clear hit-test caches
        self._face_polys = []
        self._item_rects = []
        self._edge_segs = []
        self._resize_handles = []

        # Draw nearby roads first (under the building) for spatial
        # context: "my building is here, the street runs along this side"
        # (Joshua 2026-10-11). Display-only.
        self._draw_nearby_roads(cr, proj_raw, bw, bd, b)

        # v1.1.0 exterior features, drawn at ground level under the
        # building: sidewalk border, driveway, and fence (draft or saved)
        self._draw_sidewalk(cr, proj, bw, bd)
        self._draw_driveway(cr, proj, bw, bd)
        self._draw_fence(cr, proj)

        # Draw each floor as a box, bottom to top
        for f in range(floors):
            y0 = f * fh
            y1 = (f + 1) * fh
            self._draw_box(cr, proj, bw, bd, y0, y1, wall_rgb,
                           is_top_floor=(f == floors - 1),
                           floor_index=f)

        # Draw the roof as a slightly larger flat slab on top
        self._draw_roof(cr, proj, bw, bd, total_h, roof_rgb)

        # v1.1.0: garage (attached box) and sallyport (covered passage)
        self._draw_garage(cr, proj, bw, bd, fh)
        self._draw_sallyport(cr, proj, bw, bd, fh)

        # v1.5.0 (Joshua): parking lots, single spaces, parking garages
        self._draw_parking(cr, proj, bw, bd)

        # Mark the designated front (street-facing) face, if visible
        self._draw_front_indicator(cr)

        # Draw windows and doors for each floor
        self._draw_openings(cr, proj, bw, bd, fh, floors)

        # v1.1.0: decorative assets (pictures, plants, lamps, rugs, curtains)
        self._draw_decorations(cr, proj, bw, bd, fh)

        # Red dashed footprint outline if the building overlaps a road
        self._draw_collision_outline(cr, proj, bw, bd)
        # Screen bbox of the whole building (all floors + roof
        # overhang) for house-move hit testing. v1.2.0.
        _bb = []
        for _yy in (0.0, total_h):
            for _xx in (-0.6, bw + 0.6):
                for _zz in (-0.6, bd + 0.6):
                    _bb.append(proj(_xx, _yy, _zz))
        _bxs = [p[0] for p in _bb]
        _bys = [p[1] for p in _bb]
        self._body_bbox = (min(_bxs), min(_bys), max(_bxs), max(_bys))
        # Amber highlight on the grabbed pivot edge while pivoting.
        if self._pivot_edge is not None:
            (ax, ay), (bx2, by2) = self._pivot_edge
            cr.set_source_rgb(1.0, 0.65, 0.1)
            cr.set_line_width(5.0)
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.move_to(ax, ay)
            cr.line_to(bx2, by2)
            cr.stroke()

        # Mode hint text at the bottom
        hints = {
            "add_window": "Click a wall face to place a window.",
            "add_door": "Click a wall face to place a door.",
            "add_decoration": "Click a wall face (picture/curtains) or the "
                              "ground (plant/lamp/rug) to place.",
            "draw_fence": "Click ground: add point. Click a segment: "
                          "select (drag: stretch, sideways: 90-deg wall, "
                          "hold 500ms: rotate, double-click: delete). "
                          "Right-drag or empty-drag: rotate view.",
            "add_parking": "Click the ground to place parking. "
                           "Drag a parking element to move it.",
            "remove": "Click a window, door, decoration, or parking "
                      "element to remove it.",
        }
        if self.mode in hints:
            cr.set_source_rgb(1.0, 0.85, 0.3)
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                                cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(13)
            cr.move_to(12, h - 14)
            cr.show_text(hints[self.mode])

    def _draw_nearby_roads(self, cr, proj, bw, bd, building):
        """
        Draw road segments near the building's world position, projected
        into the isometric view at ground level (y=0). Display-only;
        gives Joshua street context while editing. Roads are drawn
        BEFORE the building so the building covers them.
        """
        if not self.roads or not building:
            return
        pos = building.get("position", [0, 0])
        bx = float(pos[0]) if len(pos) > 0 else 0.0
        bz = float(pos[1]) if len(pos) > 1 else 0.0
        width = max(1.0, float(building.get("width", 40.0)))
        depth = max(1.0, float(building.get("depth", 40.0)))
        # Preview units per world unit: the larger footprint dimension
        # maps to the 10-unit preview box.
        su = 10.0 / max(width, depth)
        # Only roads within this world distance are drawn
        max_dist = 600.0

        # Road colors by category (same as the map editor)
        colors = {"highway": (1.0, 0.27, 0.27),
                  "arterial": (1.0, 0.67, 0.0),
                  "local": (0.53, 0.53, 0.53)}
        widths = {"highway": 24.0, "arterial": 16.0, "local": 10.0}

        def wproj(wx, wz):
            """World (wx, wz) at ground level -> screen coords."""
            lx = (wx - bx) * su + bw / 2.0
            lz = (wz - bz) * su + bd / 2.0
            return proj(lx, 0, lz)

        for road in self.roads:
            # Quick reject: road bbox vs the 600-unit box around building
            x0, z0, x1, z1 = road["bbox"]
            if (x1 < bx - max_dist or x0 > bx + max_dist
                    or z1 < bz - max_dist or z0 > bz + max_dist):
                continue
            pts = road.get("pts") or []
            # Project points, skipping ones far outside (keeps Cairo fast)
            spts = []
            for px, pz in pts:
                if (abs(px - bx) > max_dist or abs(pz - bz) > max_dist):
                    # Break the polyline here so far segments don't
                    # draw a line across the whole view
                    if len(spts) >= 2:
                        self._stroke_road(cr, spts, road, colors, widths,
                                          su)
                    spts = []
                    continue
                spts.append(wproj(px, pz))
            if len(spts) >= 2:
                self._stroke_road(cr, spts, road, colors, widths, su)

    def _stroke_road(self, cr, spts, road, colors, widths, su):
        """Stroke one projected road polyline."""
        cat = road.get("category", "local")
        cr.set_source_rgb(*colors.get(cat, (0.5, 0.5, 0.5)))
        # Road ribbon width scaled to the preview; capped for sanity
        w = widths.get(cat, 10.0) * su * self.scale * 0.6
        cr.set_line_width(max(2.0, min(24.0, w)))
        cr.set_line_cap(cairo.LINE_CAP_ROUND)
        cr.set_line_join(cairo.LINE_JOIN_ROUND)
        cr.move_to(*spts[0])
        for pt in spts[1:]:
            cr.line_to(*pt)
        cr.stroke()

    def _draw_collision_outline(self, cr, proj, bw, bd):
        """
        Draw a red dashed outline around the building's base footprint
        when the footprint overlaps a road. Warning only — Joshua may
        place it there intentionally (Joshua 2026-10-11).
        """
        if not self.collision:
            return
        corners = [proj(0, 0, 0), proj(bw, 0, 0),
                   proj(bw, 0, bd), proj(0, 0, bd)]
        cr.set_source_rgb(1.0, 0.2, 0.2)
        cr.set_line_width(3.0)
        cr.set_dash([8.0, 5.0])
        cr.move_to(*corners[0])
        for pt in corners[1:]:
            cr.line_to(*pt)
        cr.close_path()
        cr.stroke()
        cr.set_dash([])  # reset dash for other drawing

    # -- v1.1.0 exterior feature rendering --------------------------------

    def _draw_ground_quad(self, cr, proj, x0, z0, x1, z1, rgb,
                          alpha=1.0):
        """
        Draw a flat quad on the ground plane (y=0) in preview-local
        coords. Used for sidewalk, driveway, rugs.
        """
        cr.set_source_rgba(rgb[0], rgb[1], rgb[2], alpha)
        corners = [proj(x0, 0, z0), proj(x1, 0, z0),
                   proj(x1, 0, z1), proj(x0, 0, z1)]
        cr.move_to(*corners[0])
        for pt in corners[1:]:
            cr.line_to(*pt)
        cr.close_path()
        cr.fill_preserve()
        cr.set_source_rgba(0.1, 0.1, 0.1, alpha)
        cr.set_line_width(1.0)
        cr.stroke()

    def _draw_sidewalk(self, cr, proj, bw, bd):
        """
        Draw the sidewalk as a flat border around the building base.
        v1.1.0 (Joshua): width adjustable; curved option draws rounded
        corners (approximated with extra segments — schematic only).
        """
        sw = self.building.get("sidewalk", {})
        if not self.building or not sw.get("enabled"):
            return
        width = max(0.5, float(sw.get("width", 4.0)))
        # Concrete gray
        self._draw_ground_quad(cr, proj, -width, -width,
                               bw + width, bd + width,
                               (0.72, 0.72, 0.74))
        # Re-draw the building footprint area slightly darker so the
        # sidewalk reads as a border, not a slab under the house
        self._draw_ground_quad(cr, proj, 0, 0, bw, bd,
                               (0.55, 0.55, 0.58))

    def _draw_driveway(self, cr, proj, bw, bd):
        """
        Draw the driveway as a flat rectangle extending from the front
        face (z=0) outward toward the street. Material picks the color:
        Concrete = light gray, Paved = dark asphalt.
        v1.1.0 (Joshua).
        """
        dw = self.building.get("driveway", {})
        if not self.building or not dw.get("enabled"):
            return
        material = str(dw.get("material", "Concrete"))
        color = (0.78, 0.78, 0.80) if material == "Concrete" \
            else (0.25, 0.25, 0.28)
        # Driveway: centered on the building's x, 4 units wide,
        # extending 8 units out from the front face (z=0 toward -z)
        dw_w = 4.0
        dw_len = 8.0
        x0 = bw / 2.0 - dw_w / 2.0
        self._draw_ground_quad(cr, proj, x0, -dw_len,
                               x0 + dw_w, 0, color)

    def _draw_simple_box(self, cr, proj, x0, z0, x1, z1, y0, y1,
                         rgb):
        """
        Draw a small axis-aligned box in preview-local coords with
        simple two-tone shading. Used for the garage (v1.1.0).
        """
        # Project the 8 corners
        c000 = proj(x0, y0, z0)
        c100 = proj(x1, y0, z0)
        c110 = proj(x1, y0, z1)
        c010 = proj(x0, y0, z1)
        c001 = proj(x0, y1, z0)
        c101 = proj(x1, y1, z0)
        c111 = proj(x1, y1, z1)
        c011 = proj(x0, y1, z1)
        # Same visibility logic as the main box
        ang = self.view_angle % (2 * math.pi)
        vx = math.sin(ang)
        # v1.2.0 FIX (Joshua: walls disappeared when rotating): the
        # view direction's z-component was negated, so the dot product
        # culled the faces TOWARD the viewer. The orthographic
        # projection's true view direction is (sin(ang), +cos(ang)).
        vz = math.cos(ang)
        # Rotate outward normals by the building rotation (v1.2.0)
        rc, rs = self._rot_c, self._rot_s
        faces = [
            ("front", (c000, c100, c101, c001), 1.1, (0, -1)),
            ("right", (c100, c110, c111, c101), 0.95, (1, 0)),
            ("back", (c110, c010, c011, c111), 0.8, (0, 1)),
            ("left", (c010, c000, c001, c011), 1.0, (-1, 0)),
        ]
        # Top face
        top = (c001, c101, c111, c011)
        for name, corners, shade_f, (nx, nz) in faces:
            rnx = nx * rc - nz * rs
            rnz = nx * rs + nz * rc
            if rnx * vx + rnz * vz <= 0.05:
                continue
            r, g, bl = shade(rgb, shade_f)
            cr.set_source_rgb(r, g, bl)
            cr.move_to(*corners[0])
            for pt in corners[1:]:
                cr.line_to(*pt)
            cr.close_path()
            cr.fill_preserve()
            cr.set_source_rgb(0.1, 0.1, 0.1)
            cr.set_line_width(1.0)
            cr.stroke()
        # Top
        r, g, bl = shade(rgb, 1.2)
        cr.set_source_rgb(r, g, bl)
        cr.move_to(*top[0])
        for pt in top[1:]:
            cr.line_to(*pt)
        cr.close_path()
        cr.fill_preserve()
        cr.set_source_rgb(0.1, 0.1, 0.1)
        cr.stroke()

    def _draw_garage(self, cr, proj, bw, bd, fh):
        """
        Draw the garage as a smaller box attached to the chosen side.
        v1.1.0 (Joshua). Side: Left (x=0), Right (x=bw), Back (z=bd).
        """
        g = self.building.get("garage", {})
        if not self.building or not g.get("enabled"):
            return
        side = str(g.get("side", "Right"))
        gw = max(2.0, float(g.get("width", 20.0)) / 10.0)  # world->preview
        gh = fh * 0.7  # garage is shorter than a full floor
        gd = bd * 0.6
        wall_rgb = hex_to_rgb(self.building.get("wall_color", "#c0c0c0"))
        if side == "Right":
            x0, x1, z0, z1 = bw, bw + gw, (bd - gd) / 2, (bd + gd) / 2
        elif side == "Left":
            x0, x1, z0, z1 = -gw, 0, (bd - gd) / 2, (bd + gd) / 2
        else:  # Back
            x0, x1, z0, z1 = (bw - gw) / 2, (bw + gw) / 2, bd, bd + gd
        self._draw_simple_box(cr, proj, x0, z0, x1, z1, 0, gh, wall_rgb)
        # Garage door: dark rectangle on the outward face
        # (schematic — just a dark quad on the outer side)
        door_color = (0.2, 0.2, 0.22)
        if side == "Right":
            pts = [proj(x1, 0.2, z0 + 0.5), proj(x1, 0.2, z1 - 0.5),
                   proj(x1, gh - 0.3, z1 - 0.5),
                   proj(x1, gh - 0.3, z0 + 0.5)]
        elif side == "Left":
            pts = [proj(x0, 0.2, z0 + 0.5), proj(x0, 0.2, z1 - 0.5),
                   proj(x0, gh - 0.3, z1 - 0.5),
                   proj(x0, gh - 0.3, z0 + 0.5)]
        else:
            pts = [proj(x0 + 0.5, 0.2, z1), proj(x1 - 0.5, 0.2, z1),
                   proj(x1 - 0.5, gh - 0.3, z1),
                   proj(x0 + 0.5, gh - 0.3, z1)]
        cr.set_source_rgb(*door_color)
        cr.move_to(*pts[0])
        for pt in pts[1:]:
            cr.line_to(*pt)
        cr.close_path()
        cr.fill()

    def _draw_sallyport(self, cr, proj, bw, bd, fh):
        """
        Draw the sallyport as a covered drive-through passage at the
        front: two posts and a roof slab spanning the driveway.
        v1.1.0 (Joshua). Schematic only.
        """
        if not self.building:
            return
        sp = self.building.get("sallyport", {})
        if not sp.get("enabled"):
            return
        # Align with the driveway: centered on building x, at front (z=0)
        sp_w = 5.0
        sp_h = fh * 0.8
        sp_d = 3.0
        x0 = bw / 2.0 - sp_w / 2.0
        x1 = bw / 2.0 + sp_w / 2.0
        z0, z1 = -sp_d, 0.5
        post_rgb = (0.35, 0.3, 0.25)
        # Two posts at the outer corners
        for px in (x0 + 0.3, x1 - 0.3):
            for pz in (z0 + 0.3, z1 - 0.3):
                # Post as a thin vertical line with width
                p_base = proj(px, 0, pz)
                p_top = proj(px, sp_h, pz)
                cr.set_source_rgb(*post_rgb)
                cr.set_line_width(5.0)
                cr.set_line_cap(cairo.LINE_CAP_ROUND)
                cr.move_to(*p_base)
                cr.line_to(*p_top)
                cr.stroke()
        # Roof slab over the passage
        roof_rgb = hex_to_rgb(self.building.get("roof_color", "#5a3a2a"))
        r0 = proj(x0 - 0.4, sp_h, z0 - 0.4)
        r1 = proj(x1 + 0.4, sp_h, z0 - 0.4)
        r2 = proj(x1 + 0.4, sp_h, z1 + 0.4)
        r3 = proj(x0 - 0.4, sp_h, z1 + 0.4)
        cr.set_source_rgb(*roof_rgb)
        cr.move_to(*r0)
        cr.line_to(*r1)
        cr.line_to(*r2)
        cr.line_to(*r3)
        cr.close_path()
        cr.fill_preserve()
        cr.set_source_rgb(0.08, 0.08, 0.08)
        cr.set_line_width(1.5)
        cr.stroke()

    def _draw_fence(self, cr, proj):
        """
        Draw the fence as thin wall segments along the polygon points
        (building-relative preview units). Shows the saved fence when
        enabled, or the in-progress draft in draw_fence mode.
        v1.1.0 (Joshua). Style changes the color.
        v1.2.0: fixed a coordinate bug (center-relative fence points
        were passed to proj() as 0..bw coords, shifting the fence);
        the selected segment draws amber with endpoint handles.
        """
        if not self.building:
            return
        fence = self.building.get("fence", {})
        # Draft takes precedence while drawing
        if self.mode == "draw_fence" and self._fence_draft:
            pts = self._fence_draft
            style = str(fence.get("style", "Wood"))
            draft = True
        elif fence.get("enabled") and fence.get("points"):
            pts = fence["points"]
            style = str(fence.get("style", "Wood"))
            draft = False
        else:
            return
        # Style colors (labels for v1; real textures later)
        colors = {"Wood": (0.45, 0.30, 0.18),
                  "Metal": (0.55, 0.58, 0.62),
                  "Chain Link": (0.70, 0.72, 0.75),
                  "Brick": (0.62, 0.25, 0.18)}
        rgb = colors.get(style, (0.45, 0.30, 0.18))
        fence_h = 1.2  # preview units tall
        bw, bd = self._proj_bw, self._proj_bd
        n = len(pts)

        def fp(x, z, y=0.0):
            # Fence points are center-relative; proj() takes 0..bw.
            return proj(x + bw / 2.0, y, z + bd / 2.0)

        # Draw each segment as a vertical quad (thin wall)
        for i in range(n):
            x0, z0 = float(pts[i][0]), float(pts[i][1])
            x1, z1 = float(pts[(i + 1) % n][0]), float(pts[(i + 1) % n][1])
            # Skip the closing segment for the draft (polygon not done)
            if draft and i == n - 1:
                # Draw draft points as dots instead
                p = fp(x0, z0)
                cr.set_source_rgb(1.0, 0.85, 0.2)
                cr.arc(p[0], p[1], 4.0, 0, 2 * math.pi)
                cr.fill()
                continue
            p0b, p0t = fp(x0, z0), fp(x0, z0, fence_h)
            p1b, p1t = fp(x1, z1), fp(x1, z1, fence_h)
            selected = (draft and self.mode == "draw_fence"
                        and self._fence_sel == i)
            if selected:
                # Amber highlight for the selected segment (v1.2.0)
                cr.set_source_rgb(1.0, 0.65, 0.1)
            else:
                cr.set_source_rgb(*rgb)
            cr.move_to(*p0b)
            cr.line_to(*p1b)
            cr.line_to(*p1t)
            cr.line_to(*p0t)
            cr.close_path()
            cr.fill_preserve()
            if selected:
                cr.set_source_rgb(1.0, 0.65, 0.1)
                cr.set_line_width(2.5)
            else:
                cr.set_source_rgb(0.1, 0.1, 0.1)
                cr.set_line_width(0.8)
            cr.stroke()
        # Draft: mark each clicked point
        if draft:
            for x, z in pts:
                p = fp(float(x), float(z))
                cr.set_source_rgb(1.0, 0.85, 0.2)
                cr.arc(p[0], p[1], 4.0, 0, 2 * math.pi)
                cr.fill()
        # Endpoint handles for the selected segment (v1.2.0)
        eps = self._fence_selected_endpoints()
        if draft and eps is not None:
            for ex, ey in eps:
                cr.set_source_rgb(1.0, 0.65, 0.1)
                cr.arc(ex, ey, 6.0, 0, 2 * math.pi)
                cr.fill_preserve()
                cr.set_source_rgb(0.1, 0.1, 0.1)
                cr.set_line_width(1.5)
                cr.stroke()
            if self._fence_rotating:
                # Hold-to-rotate is armed: draw a hint ring.
                mx = (eps[0][0] + eps[1][0]) / 2.0
                my = (eps[0][1] + eps[1][1]) / 2.0
                cr.set_source_rgb(1.0, 0.65, 0.1)
                cr.set_line_width(2.0)
                cr.set_dash([5.0, 4.0])
                cr.arc(mx, my, 16.0, 0, 2 * math.pi)
                cr.stroke()
                cr.set_dash([])

    def _draw_decorations(self, cr, proj, bw, bd, fh):
        """
        Draw decorative asset markers. Wall types (Picture Frame,
        Curtains) render as small rects on wall faces like windows;
        floor types (Plant, Lamp, Rug) render as ground markers.
        v1.1.0 (Joshua): markers/labels only — the game swaps in real
        3D models later.
        """
        b = self.building
        if not b:
            return
        # Local import to avoid a hard dependency at module load
        try:
            from data import DECORATION_WALL_TYPES
        except ImportError:
            DECORATION_WALL_TYPES = {"Picture Frame", "Curtains"}

        face_map = {name: poly for name, poly in self._face_polys}

        def face_point(face, fx, fy_world):
            if face == "front":
                return (fx * bw, fy_world, 0)
            if face == "right":
                return (bw, fy_world, fx * bd)
            if face == "back":
                return (bw - fx * bw, fy_world, bd)
            return (0, fy_world, bd - fx * bd)

        for i, deco in enumerate(b.get("decorations", [])):
            dtype = str(deco.get("type", ""))
            if dtype in DECORATION_WALL_TYPES:
                face = deco.get("face", "front")
                if face not in face_map:
                    continue
                fx = float(deco.get("x", 0.4))
                fy = float(deco.get("y", 0.55))
                # Picture: small rect; Curtains: taller narrow rect
                if dtype == "Curtains":
                    fw, fhgt = 0.10, 0.35
                    fill = (0.75, 0.65, 0.55)
                else:  # Picture Frame
                    fw, fhgt = 0.12, 0.10
                    fill = (0.90, 0.85, 0.70)
                corners = []
                for (px, py) in ((fx, fy * fh), (fx + fw, fy * fh),
                                 (fx + fw, (fy + fhgt) * fh),
                                 (fx, (fy + fhgt) * fh)):
                    wx, wy, wz = face_point(face, px, py)
                    corners.append(proj(wx, wy, wz))
                xs = [c[0] for c in corners]
                ys = [c[1] for c in corners]
                cr.set_source_rgb(*fill)
                cr.move_to(*corners[0])
                for pt in corners[1:]:
                    cr.line_to(*pt)
                cr.close_path()
                cr.fill_preserve()
                cr.set_source_rgb(0.2, 0.15, 0.1)
                cr.set_line_width(1.5)
                cr.stroke()
                self._item_rects.append(
                    ("decoration", i, (min(xs), min(ys),
                                       max(xs), max(ys))))
            else:
                # Floor decorations: project the ground point
                gx = float(deco.get("gx", 0.0))
                gz = float(deco.get("gz", 0.0))
                # gx/gz are building-relative preview units centered
                # at (0,0); convert to the 0..bw/0..bd local space
                lx, lz = gx + bw / 2.0, gz + bd / 2.0
                p = proj(lx, 0, lz)
                if dtype == "Plant":
                    cr.set_source_rgb(0.25, 0.55, 0.25)
                    cr.arc(p[0], p[1] - 6, 8.0, 0, 2 * math.pi)
                    cr.fill()
                    cr.set_source_rgb(0.35, 0.25, 0.15)
                    cr.arc(p[0], p[1], 3.0, 0, 2 * math.pi)
                    cr.fill()
                elif dtype == "Lamp":
                    cr.set_source_rgb(0.3, 0.3, 0.32)
                    cr.set_line_width(3.0)
                    cr.move_to(p[0], p[1])
                    cr.line_to(p[0], p[1] - 18)
                    cr.stroke()
                    cr.set_source_rgb(1.0, 0.9, 0.6)
                    cr.arc(p[0], p[1] - 20, 5.0, 0, 2 * math.pi)
                    cr.fill()
                else:  # Rug
                    self._draw_ground_quad(
                        cr, proj, lx - 1.0, lz - 0.7, lx + 1.0,
                        lz + 0.7, (0.65, 0.45, 0.55))
                    # Recompute p after the quad for the hit rect
                    p = proj(lx, 0, lz)
                # Hit rect for floor decorations (generous for clicking)
                self._item_rects.append(
                    ("decoration", i,
                     (p[0] - 12, p[1] - 24, p[0] + 12, p[1] + 6)))
            # Selection highlight for the selected decoration
            if (self._selected_item is not None
                    and self._selected_item[0] == "decoration"
                    and self._selected_item[1] == i):
                # Find its cached rect and outline it
                for kind, idx, (x0, y0, x1, y1) in self._item_rects:
                    if kind == "decoration" and idx == i:
                        cr.set_source_rgb(1.0, 0.85, 0.2)
                        cr.set_line_width(2.0)
                        cr.rectangle(x0, y0, x1 - x0, y1 - y0)
                        cr.stroke()
                        break

    def _draw_box(self, cr, proj, bw, bd, y0, y1, wall_rgb,
                  is_top_floor, floor_index):
        """
        Draw one floor as an isometric box. Only the three faces that
        can be visible from the current view angle are drawn; the
        front/right/back/left face polygons are cached for hit testing.
        """
        # 8 corners of the box
        c000 = proj(0, y0, 0)
        c100 = proj(bw, y0, 0)
        c110 = proj(bw, y0, bd)
        c010 = proj(0, y0, bd)
        c001 = proj(0, y1, 0)
        c101 = proj(bw, y1, 0)
        c111 = proj(bw, y1, bd)
        c011 = proj(0, y1, bd)

        # Face definitions: (name, 4 corners bottom->top, shade factor)
        # "front" is z=0, "right" is x=bw, "back" is z=bd, "left" is x=0
        # Face shading simulates a sun from upper-left-front.
        # Joshua 2026-10-11: houses were too dark, brightened all faces.
        faces = [
            ("front", (c000, c100, c101, c001), 1.15),
            ("right", (c100, c110, c111, c101), 1.0),
            ("back", (c110, c010, c011, c111), 0.85),
            ("left", (c010, c000, c001, c011), 1.08),
        ]

        # Determine which faces point toward the viewer for the angle.
        # A face is visible if its outward normal has a positive dot
        # product with the view direction.
        ang = self.view_angle % (2 * math.pi)
        # Outward normals in (x, z): front=(0,-1), right=(1,0),
        # back=(0,1), left=(-1,0). View dir after rotation:
        vx = math.sin(ang)
        # v1.2.0 FIX (Joshua: walls disappeared when rotating): the
        # view direction's z-component was negated, so the dot product
        # culled the faces TOWARD the viewer. The orthographic
        # projection's true view direction is (sin(ang), +cos(ang)).
        vz = math.cos(ang)
        normals = {"front": (0, -1), "right": (1, 0),
                   "back": (0, 1), "left": (-1, 0)}
        # Building-local (unrotated, center-relative) coords of each
        # face's two vertical edges: used for pivot-grab hit testing.
        edge_locals = {
            "front": [(-bw / 2.0, -bd / 2.0), (bw / 2.0, -bd / 2.0)],
            "right": [(bw / 2.0, -bd / 2.0), (bw / 2.0, bd / 2.0)],
            "back": [(bw / 2.0, bd / 2.0), (-bw / 2.0, bd / 2.0)],
            "left": [(-bw / 2.0, bd / 2.0), (-bw / 2.0, -bd / 2.0)],
        }
        rc, rs = self._rot_c, self._rot_s

        for name, corners, shade_f in faces:
            nx, nz = normals[name]
            # Rotate the outward normal by the building rotation (v1.2.0)
            rnx = nx * rc - nz * rs
            rnz = nx * rs + nz * rc
            if rnx * vx + rnz * vz <= 0.05:
                continue  # face points away — skip
            # Cache polygon for click hit-testing (only ground floor
            # faces are used for placement, but cache all for simplicity;
            # placement uses floor 0)
            if floor_index == 0:
                self._face_polys.append((name, list(corners)))
                # Cache the two vertical edges (screen seg + local
                # coords) for pivot-grab hit testing. v1.2.0.
                el = edge_locals[name]
                self._edge_segs.append(
                    (corners[0], corners[3], el[0]))
                self._edge_segs.append(
                    (corners[1], corners[2], el[1]))
            r, g, bl = shade(wall_rgb, shade_f)
            cr.set_source_rgb(r, g, bl)
            cr.move_to(*corners[0])
            for pt in corners[1:]:
                cr.line_to(*pt)
            cr.close_path()
            cr.fill_preserve()
            cr.set_source_rgb(0.1, 0.1, 0.1)
            cr.set_line_width(1.0)
            cr.stroke()

        # Floor separator line between stacked floors
        if not is_top_floor:
            cr.set_source_rgb(0.1, 0.1, 0.1)
            cr.set_line_width(1.5)
            cr.move_to(*c001)
            cr.line_to(*c101)
            cr.line_to(*c111)
            cr.line_to(*c011)
            cr.close_path()
            cr.stroke()

    # -- parking (v1.5.0, Joshua) --------------------------------------

    def _get_parking(self, index):
        """Return the parking dict at index, or None. v1.5.0."""
        if not self.building:
            return None
        items = self.building.get("parking", [])
        if 0 <= index < len(items):
            return items[index]
        return None

    @staticmethod
    def _parking_size(p):
        """
        Footprint (width, depth) in preview units for a parking
        element. Lots size from rows x spaces; a single space is one
        car slot; a garage is a fixed box whose height comes from its
        level count.
        """
        ptype = p.get("type", "lot")
        if ptype == "lot":
            rows = max(1, int(p.get("rows", 4) or 4))
            spr = max(1, int(p.get("spaces_per_row", 10) or 10))
            return spr * 1.2, rows * 2.5
        if ptype == "space":
            return 1.2, 2.5
        # garage
        return 6.0, 4.5

    def _parking_corners(self, p, bw, bd):
        """
        The 4 ground corners of a parking element in building-local
        (0..bw, 0..bd) coords, with the element's own rotation applied
        around its center. (gx, gz) are center-relative like fence
        points, so they are offset by bw/2, bd/2 first. v1.5.0.
        """
        gx = float(p.get("gx", 0.0) or 0.0) + bw / 2.0
        gz = float(p.get("gz", 0.0) or 0.0) + bd / 2.0
        w, d = self._parking_size(p)
        rot = math.radians(float(p.get("rotation", 0.0) or 0.0))
        if p.get("type") == "space":
            # Single-space orientation adds to the base rotation
            ori = str(p.get("orientation", "Perpendicular"))
            rot += math.radians(
                {"Parallel": 90.0, "Angled": 45.0}.get(ori, 0.0))
        cr_, sr_ = math.cos(rot), math.sin(rot)
        corners = []
        for sx, sz in ((-w / 2.0, -d / 2.0), (w / 2.0, -d / 2.0),
                       (w / 2.0, d / 2.0), (-w / 2.0, d / 2.0)):
            corners.append((gx + sx * cr_ - sz * sr_,
                            gz + sx * sr_ + sz * cr_))
        return corners

    @staticmethod
    def _fill_ground_poly(cr, proj, corners, rgb, alpha=1.0):
        """
        Fill + outline an arbitrary ground-plane polygon given as
        building-local (x, z) corners. v1.5.0 (parking lots/spaces
        can be rotated, so the axis-aligned _draw_ground_quad won't
        do).
        """
        spts = [proj(x, 0.0, z) for x, z in corners]
        cr.set_source_rgba(rgb[0], rgb[1], rgb[2], alpha)
        cr.move_to(*spts[0])
        for pt in spts[1:]:
            cr.line_to(*pt)
        cr.close_path()
        cr.fill_preserve()
        cr.set_source_rgba(0.1, 0.1, 0.1, alpha)
        cr.set_line_width(1.2)
        cr.stroke()
        return spts

    def _draw_parking(self, cr, proj, bw, bd):
        """
        Draw parking lots (paved rect + painted space lines), single
        spaces (one outlined slot), and parking garages (box with
        level lines). All are draggable in view mode and removable in
        remove mode. v1.5.0 (Joshua).
        """
        b = self.building
        if not b:
            return
        for i, p in enumerate(b.get("parking", [])):
            ptype = p.get("type", "lot")
            corners = self._parking_corners(p, bw, bd)
            if ptype == "garage":
                # Multi-level structure: box + level separator lines
                xs = [c[0] for c in corners]
                zs = [c[1] for c in corners]
                levels = max(1, min(5, int(p.get("levels", 3) or 3)))
                height = levels * 1.5
                self._draw_simple_box(cr, proj, min(xs), min(zs),
                                      max(xs), max(zs), 0.0, height,
                                      (0.45, 0.47, 0.52))
                # Level lines across the front face (z = min corner)
                cr.set_source_rgb(0.85, 0.85, 0.9)
                cr.set_line_width(1.0)
                for lvl in range(1, levels):
                    y = lvl * 1.5
                    a = proj(min(xs), y, min(zs))
                    c_ = proj(max(xs), y, min(zs))
                    cr.move_to(*a)
                    cr.line_to(*c_)
                    cr.stroke()
                label = "PARKING"
            else:
                # Asphalt base, then painted markings
                spts = self._fill_ground_poly(
                    cr, proj, corners, (0.25, 0.25, 0.28))
                cr.set_source_rgb(0.92, 0.92, 0.92)
                cr.set_line_width(1.0)
                if ptype == "lot":
                    rows = max(1, int(p.get("rows", 4) or 4))
                    spr = max(1, int(p.get("spaces_per_row", 10)
                                     or 10))
                    w, d = self._parking_size(p)
                    gx = float(p.get("gx", 0.0) or 0.0) + bw / 2.0
                    gz = float(p.get("gz", 0.0) or 0.0) + bd / 2.0
                    rot = math.radians(
                        float(p.get("rotation", 0.0) or 0.0))
                    cr_, sr_ = math.cos(rot), math.sin(rot)

                    def _lp(lx, lz):
                        """Local grid point -> projected screen point."""
                        wx = gx + lx * cr_ - lz * sr_
                        wz = gz + lx * sr_ + lz * cr_
                        return proj(wx, 0.0, wz)

                    # Lines between rows
                    for r in range(1, rows):
                        lz = -d / 2.0 + r * 2.5
                        cr.move_to(*_lp(-w / 2.0, lz))
                        cr.line_to(*_lp(w / 2.0, lz))
                        cr.stroke()
                    # Lines between spaces within each row
                    for s in range(1, spr):
                        lx = -w / 2.0 + s * 1.2
                        cr.move_to(*_lp(lx, -d / 2.0))
                        cr.line_to(*_lp(lx, d / 2.0))
                        cr.stroke()
                label = "PARKING LOT" if ptype == "lot" else "P"
            # Small type label under the element
            spts = [proj(x, 0.0, z) for x, z in corners]
            cxp = sum(pt[0] for pt in spts) / 4.0
            cyp = sum(pt[1] for pt in spts) / 4.0
            cr.set_source_rgb(0.9, 0.9, 0.9)
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                                cairo.FONT_WEIGHT_NORMAL)
            cr.set_font_size(9)
            cr.move_to(cxp - 24, cyp + 12)
            cr.show_text(label)
            # Cache the screen bbox for remove-mode hit testing and
            # view-mode dragging (same _item_rects mechanism as
            # windows/doors/decorations).
            xs = [pt[0] for pt in spts]
            ys = [pt[1] for pt in spts]
            # Garages are tall: extend the hit box upward so the box
            # body is clickable, not just its footprint.
            y_top = min(ys)
            if ptype == "garage":
                levels = max(1, min(5, int(p.get("levels", 3) or 3)))
                y_top -= levels * 1.5 * self.scale * 0.9
            self._item_rects.append(
                ("parking", i, (min(xs), y_top, max(xs), max(ys))))
            # Amber selection highlight (matches decorations)
            if (self._selected_item is not None
                    and self._selected_item[0] == "parking"
                    and self._selected_item[1] == i):
                cr.set_source_rgb(1.0, 0.85, 0.2)
                cr.set_line_width(2.5)
                cr.move_to(*spts[0])
                for pt in spts[1:]:
                    cr.line_to(*pt)
                cr.close_path()
                cr.stroke()

    def _draw_roof(self, cr, proj, bw, bd, total_h, roof_rgb):
        """Draw a flat roof slab slightly larger than the top floor."""
        over = 0.6  # overhang in world units
        p0 = proj(-over, total_h, -over)
        p1 = proj(bw + over, total_h, -over)
        p2 = proj(bw + over, total_h, bd + over)
        p3 = proj(-over, total_h, bd + over)
        r, g, b = roof_rgb
        cr.set_source_rgb(r, g, b)
        cr.move_to(*p0)
        cr.line_to(*p1)
        cr.line_to(*p2)
        cr.line_to(*p3)
        cr.close_path()
        cr.fill_preserve()
        cr.set_source_rgb(0.08, 0.08, 0.08)
        cr.set_line_width(1.5)
        cr.stroke()

    def _draw_front_indicator(self, cr):
        """
        Draw a small amber arrow + label above the top edge of the
        building's designated front (street-facing) face, if that face
        is currently visible. Lets Joshua see which side is marked as
        the front (Joshua 2026-10-11: used by the subdivision
        house-spawning algorithm to face houses toward roads).
        """
        if not self.building:
            return
        front = str(self.building.get("front_face", "front")).lower()
        for name, poly in self._face_polys:
            if name != front:
                continue
            # poly corners: bottom-left, bottom-right, top-right, top-left
            tx = (poly[2][0] + poly[3][0]) / 2.0  # top edge midpoint
            ty = (poly[2][1] + poly[3][1]) / 2.0
            s = 9.0  # arrow size in px
            cr.set_source_rgb(1.0, 0.75, 0.15)  # amber arrow
            cr.move_to(tx - s, ty - s * 1.7)
            cr.line_to(tx + s, ty - s * 1.7)
            cr.line_to(tx, ty - s * 0.4)
            cr.close_path()
            cr.fill()
            cr.set_source_rgb(1.0, 0.85, 0.4)
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                                cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(10)
            cr.move_to(tx - 17, ty - s * 2.0)
            cr.show_text("FRONT")
            return  # only one face matches

    def _draw_openings(self, cr, proj, bw, bd, fh, floors):
        """
        Draw window and door rectangles on the ground-floor faces.
        Window/door positions are fractional (0-1) across the face
        width and up from the floor.
        """
        b = self.building
        if not b:
            return

        # Map face name -> its screen polygon (ground floor only)
        face_map = {name: poly for name, poly in self._face_polys}

        # Face base corners in world coords for interpolation:
        # front: x 0->bw at z=0; right: z 0->bd at x=bw;
        # back: x bw->0 at z=bd; left: z bd->0 at x=0
        def face_point(face, fx, fy_world):
            """World (x, y, z) of fractional position on a face."""
            if face == "front":
                return (fx * bw, fy_world, 0)
            if face == "right":
                return (bw, fy_world, fx * bd)
            if face == "back":
                return (bw - fx * bw, fy_world, bd)
            # left
            return (0, fy_world, bd - fx * bd)

        def draw_rect_on_face(face, fx, fw, fy0, fhgt, fill_rgb,
                              kind, index):
            """
            Draw a rectangle on a face by projecting its 4 corners.
            Caches the screen bounding box for remove-mode hit testing.
            """
            corners = []
            for (px, py) in ((fx, fy0), (fx + fw, fy0),
                             (fx + fw, fy0 + fhgt), (fx, fy0 + fhgt)):
                wx, wy, wz = face_point(face, px, py)
                corners.append(proj(wx, wy, wz))
            xs = [c[0] for c in corners]
            ys = [c[1] for c in corners]
            # Fill
            cr.set_source_rgb(*fill_rgb)
            cr.move_to(*corners[0])
            for pt in corners[1:]:
                cr.line_to(*pt)
            cr.close_path()
            cr.fill_preserve()
            cr.set_source_rgb(0.05, 0.05, 0.05)
            cr.set_line_width(1.2)
            cr.stroke()
            # Cache bounding box for hit testing
            self._item_rects.append(
                (kind, index, (min(xs), min(ys), max(xs), max(ys))))
            # Highlight the item currently being dragged so Joshua can
            # see which one is grabbed.
            if (self._item_drag is not None
                    and self._item_drag[0] == kind
                    and self._item_drag[1] == index):
                cr.set_source_rgb(1.0, 0.85, 0.2)  # amber highlight
                cr.set_line_width(2.5)
                cr.move_to(*corners[0])
                for pt in corners[1:]:
                    cr.line_to(*pt)
                cr.close_path()
                cr.stroke()
            # v1.1.0: resize handles for the selected window.
            # Clicking a window (no drag) selects it; dragging a corner
            # handle resizes it. Minimum size keeps windows visible.
            if (kind == "window"
                    and self._selected_item is not None
                    and self._selected_item[0] == "window"
                    and self._selected_item[1] == index):
                handles = [("tl", min(xs), min(ys)),
                           ("tr", max(xs), min(ys)),
                           ("br", max(xs), max(ys)),
                           ("bl", min(xs), max(ys))]
                self._resize_handles = handles
                cr.set_source_rgb(1.0, 0.85, 0.2)
                for _hname, hx, hy in handles:
                    cr.arc(hx, hy, 5.0, 0, 2 * math.pi)
                    cr.fill_preserve()
                    cr.set_source_rgb(0.2, 0.15, 0.05)
                    cr.set_line_width(1.5)
                    cr.stroke()
                    cr.set_source_rgb(1.0, 0.85, 0.2)

        # Windows: light blue glass
        for i, win in enumerate(b.get("windows", [])):
            face = win.get("face", "front")
            if face not in face_map:
                continue  # face not visible from this angle
            fx = float(win.get("x", 0.4))
            fw = float(win.get("w", 0.15))
            # y is fractional up the floor (0 = floor, 1 = ceiling)
            fy = float(win.get("y", 0.55))
            fhgt = float(win.get("h", 0.25))
            draw_rect_on_face(face, fx, fw, fy * fh, fhgt * fh,
                              (0.63, 0.77, 0.91), "window", i)

        # Doors: dark brown, always from the floor up
        for i, door in enumerate(b.get("doors", [])):
            face = door.get("face", "front")
            if face not in face_map:
                continue
            fx = float(door.get("x", 0.45))
            # Doors are a fixed sensible width on the face
            fw = 0.12
            draw_rect_on_face(face, fx, fw, 0, fh * 0.62,
                              (0.35, 0.22, 0.12), "door", i)

    # -- input --------------------------------------------------------

    def _get_item(self, kind, index):
        """
        Return the window/door dict for (kind, index), or None.
        kind is "window" or "door".
        """
        if not self.building:
            return None
        items = self.building.get("windows" if kind == "window"
                                  else "doors", [])
        if 0 <= index < len(items):
            return items[index]
        return None

    def _face_bbox(self, face):
        """
        Screen bounding box of a ground-floor face polygon.
        Returns (x0, y0, x1, y1) or None if the face isn't visible.
        """
        for name, poly in self._face_polys:
            if name == face:
                xs = [p[0] for p in poly]
                ys = [p[1] for p in poly]
                return min(xs), min(ys), max(xs), max(ys)
        return None

    def _screen_to_ground(self, sx, sy):
        """
        Convert screen coords to building-relative ground-plane
        preview units (y=0). Inverts the isometric projection used in
        _on_draw. Returns (gx, gz) or None if projection params aren't
        set yet (before first draw).
        v1.1.0: used for fence drawing and floor-decoration placement.
        """
        cx, cy = self._proj_cx, self._proj_cy
        bw, bd = self._proj_bw, self._proj_bd
        if self.scale <= 0:
            return None
        # Undo translate + scale
        ox = (sx - cx) / self.scale
        oy = (sy - cy) / self.scale
        # iso_project: sx = rx, sy = -y + rz*0.5. For y=0: rx = ox,
        # rz = oy * 2.
        rx, rz = ox, oy * 2.0
        # Unrotate around Y: rx = x*cos(a) - z*sin(a),
        # rz = x*sin(a) + z*cos(a)  =>
        # x = rx*cos(a) + rz*sin(a), z = -rx*sin(a) + rz*cos(a)
        a = self.view_angle
        ca, sa = math.cos(a), math.sin(a)
        x = rx * ca + rz * sa
        z = -rx * sa + rz * ca
        # Undo the building's rotation (clockwise-from-above) to get
        # unrotated building-local coords. v1.2.0: the preview now
        # renders rotation, so picking must invert it.
        rc, rs = self._rot_c, self._rot_s
        ux = x * rc + z * rs
        uz = -x * rs + z * rc
        # Undo the centering offset (proj subtracts bw/2, bd/2) and
        # re-center at (0, 0) for building-relative coords
        return ux, uz

    # -- v1.2.0 helpers: projection, edges, fence editing -------------

    def _project(self, x, y, z):
        """
        Project building-local (0..bw, 0..bd) coords to screen,
        applying the building rotation. Method version of the proj
        closure in _on_draw, for use by hit-testing code.
        """
        bw, bd = self._proj_bw, self._proj_bd
        cx, cy = self._proj_cx, self._proj_cy
        rc, rs = self._rot_c, self._rot_s
        lx, lz = x - bw / 2.0, z - bd / 2.0
        rx = lx * rc - lz * rs
        rz = lx * rs + lz * rc
        sx, sy = iso_project(rx, y, rz, self.view_angle)
        return (cx + sx * self.scale, cy + sy * self.scale)

    def _fence_to_screen(self, gx, gz):
        """
        Convert a fence ground point (center-relative preview units)
        to screen coords.
        """
        bw, bd = self._proj_bw, self._proj_bd
        return self._project(gx + bw / 2.0, 0.0, gz + bd / 2.0)

    @staticmethod
    def _point_seg_dist(px, py, ax, ay, bx, by):
        """Distance from point (px,py) to segment a-b."""
        dx, dy = bx - ax, by - ay
        if dx == 0 and dy == 0:
            return math.hypot(px - ax, py - ay)
        t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
        t = max(0.0, min(1.0, t))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    @staticmethod
    def _rot2_cw(x, z, deg):
        """
        Rotate (x, z) clockwise-from-above by deg. Matches the game's
        fence_points_to_world transform in data.py.
        """
        r = math.radians(deg)
        c, s = math.cos(r), math.sin(r)
        return (x * c - z * s, x * s + z * c)

    def _local_to_world(self, lx, lz):
        """
        Building-local preview units (center-relative, unrotated) to
        a world-unit offset. Accounts for non-square footprints.
        """
        b = self.building or {}
        sx = float(b.get("width", 40.0)) / 10.0
        sz = float(b.get("depth", 40.0)) / 10.0
        return (lx * sx, lz * sz)

    def _in_body_bbox(self, px, py):
        """True if (px,py) is inside the cached building screen bbox."""
        bb = self._body_bbox
        if bb is None:
            return False
        x0, y0, x1, y1 = bb
        return x0 <= px <= x1 and y0 <= py <= y1

    def _near_body_center(self, px, py):
        """
        True if (px,py) is near the building bbox center. This is the
        house-move zone; clicks nearer the faces/edges pivot instead.
        """
        bb = self._body_bbox
        if bb is None:
            return False
        x0, y0, x1, y1 = bb
        ccx, ccy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        r = 0.35 * min(x1 - x0, y1 - y0)
        return math.hypot(px - ccx, py - ccy) <= r

    def _hit_edge(self, px, py, thresh=14.0):
        """
        Find the nearest cached vertical wall edge within thresh px.
        Returns (local_xz, screen_seg) or None.
        """
        best = None
        for (ax, ay), (bx, by), local in self._edge_segs:
            d = self._point_seg_dist(px, py, ax, ay, bx, by)
            if d <= thresh and (best is None or d < best[0]):
                best = (d, local, ((ax, ay), (bx, by)))
        return (best[1], best[2]) if best else None

    def _nearest_face_edge(self, face, px, py):
        """
        Nearest vertical edge of a named face to (px,py). Returns
        (local_xz, screen_seg) or None. Used when a face click isn't
        near a cached edge (e.g. an edge hidden behind the roof).
        """
        for name, poly in self._face_polys:
            if name != face or len(poly) < 4:
                continue
            # poly corners: (bl, br, tr, tl)
            bl, br, tr, tl = poly[0], poly[1], poly[2], poly[3]
            bw, bd = self._proj_bw, self._proj_bd
            edge_locals = {
                "front": [(-bw / 2.0, -bd / 2.0), (bw / 2.0, -bd / 2.0)],
                "right": [(bw / 2.0, -bd / 2.0), (bw / 2.0, bd / 2.0)],
                "back": [(bw / 2.0, bd / 2.0), (-bw / 2.0, bd / 2.0)],
                "left": [(-bw / 2.0, bd / 2.0), (-bw / 2.0, -bd / 2.0)],
            }
            el = edge_locals[face]
            d0 = self._point_seg_dist(px, py, bl[0], bl[1], tl[0], tl[1])
            d1 = self._point_seg_dist(px, py, br[0], br[1], tr[0], tr[1])
            if d0 <= d1:
                return (el[0], (bl, tl))
            return (el[1], (br, tr))
        return None

    # -- fence segment editing helpers (v1.2.0, Joshua) ---------------

    def _fence_seg_hit(self, px, py, thresh=12.0):
        """Nearest working-fence segment index within thresh px."""
        pts = self._fence_draft
        if len(pts) < 2:
            return None
        best = None
        for i in range(len(pts) - 1):
            ax, ay = self._fence_to_screen(pts[i][0], pts[i][1])
            bx, by = self._fence_to_screen(pts[i + 1][0], pts[i + 1][1])
            d = self._point_seg_dist(px, py, ax, ay, bx, by)
            if d <= thresh and (best is None or d < best[1]):
                best = (i, d)
        return best[0] if best is not None else None

    def _fence_handle_hit(self, px, py):
        """
        Hit-test the selected segment's endpoint handles (9px).
        Returns "a", "b", or None.
        """
        if self._fence_sel is None:
            return None
        pts = self._fence_draft
        i = self._fence_sel
        if not (0 <= i < len(pts) - 1):
            return None
        ax, ay = self._fence_to_screen(pts[i][0], pts[i][1])
        bx, by = self._fence_to_screen(pts[i + 1][0], pts[i + 1][1])
        if math.hypot(px - ax, py - ay) <= 9.0:
            return "a"
        if math.hypot(px - bx, py - by) <= 9.0:
            return "b"
        return None

    def _fence_selected_endpoints(self):
        """Screen positions of the selected segment's endpoints."""
        if self._fence_sel is None:
            return None
        pts = self._fence_draft
        i = self._fence_sel
        if not (0 <= i < len(pts) - 1):
            return None
        a = self._fence_to_screen(pts[i][0], pts[i][1])
        b = self._fence_to_screen(pts[i + 1][0], pts[i + 1][1])
        return (a, b)

    def _cancel_fence_hold(self):
        """Cancel a pending grab-hold rotate timer."""
        if self._fence_hold_id is not None:
            GLib.source_remove(self._fence_hold_id)
            self._fence_hold_id = None

    def _fence_hold_fired(self):
        """
        GLib timeout: a press-and-hold on a fence segment became a
        rotate gesture. Returns False (one-shot).
        """
        self._fence_hold_id = None
        fp = self._fence_press
        if (fp is not None and fp.get("seg") is not None
                and not fp.get("moved")):
            self._fence_rotating = True
            self.queue_draw()
        return False

    def _fence_delete_segment(self, seg):
        """Delete a fence segment (double-click): drop its end point."""
        pts = self._fence_draft
        if 0 <= seg < len(pts) - 1:
            pts.pop(seg + 1)
            if self._fence_sel is not None:
                if len(pts) < 3:
                    self._fence_sel = None
                elif self._fence_sel >= seg:
                    self._fence_sel = max(0, self._fence_sel - 1)
            self.queue_draw()
            if self.on_fence_edit:
                self.on_fence_edit()

    def _fence_endpoint_drag(self, x, y):
        """Drag the selected segment's endpoint handle freely."""
        fd = self._fence_drag
        pts = self._fence_draft
        seg = fd["seg"]
        if not (0 <= seg < len(pts) - 1):
            self._fence_drag = None
            return
        g = self._screen_to_ground(x, y)
        if g is None:
            return
        gx = max(-15.0, min(15.0, g[0]))
        gz = max(-15.0, min(15.0, g[1]))
        if fd["end"] == "a":
            pts[seg] = [gx, gz]
        else:
            pts[seg + 1] = [gx, gz]
        self.queue_draw()

    def _fence_body_drag(self, fp, x, y):
        """
        Drag a selected segment's body: pulling along its direction
        stretches/extends the grabbed end; pulling sideways (or
        backward) spawns a new segment at 90 degrees from the grabbed
        end, following the drag. One 90-degree spawn per press.
        """
        pts = self._fence_draft
        seg = fp["seg"]
        if fp.get("done") or not (0 <= seg < len(pts) - 1):
            return
        a0, b0 = fp["a0"], fp["b0"]
        ax, az, bx, bz = a0[0], a0[1], b0[0], b0[1]
        vx, vz = bx - ax, bz - az
        vlen = math.hypot(vx, vz)
        if vlen < 1e-6:
            return
        ux, uz = vx / vlen, vz / vlen
        g0 = self._screen_to_ground(fp["sx"], fp["sy"])
        g1 = self._screen_to_ground(x, y)
        if g0 is None or g1 is None:
            return
        dx, dz = g1[0] - g0[0], g1[1] - g0[1]
        along = dx * ux + dz * uz
        px, pz = dx - along * ux, dz - along * uz
        perp = math.hypot(px, pz)
        # Which end did Joshua grab?
        da = math.hypot(g0[0] - ax, g0[1] - az)
        db = math.hypot(g0[0] - bx, g0[1] - bz)
        grab_b = db < da
        if perp > max(2.0, abs(along) * 1.2):
            # Sideways/backward pull: new 90-degree segment from the
            # grabbed end, in the drag direction.
            ex, ez = (bx, bz) if grab_b else (ax, az)
            pl = max(perp, 0.001)
            nx = ex + (px / pl) * perp
            nz = ez + (pz / pl) * perp
            nx = max(-15.0, min(15.0, nx))
            nz = max(-15.0, min(15.0, nz))
            if grab_b:
                pts.insert(seg + 2, [nx, nz])
                self._fence_sel = seg + 1
            else:
                pts.insert(seg, [nx, nz])
                self._fence_sel = seg
            fp["done"] = True
            self._cancel_fence_hold()
            self.queue_draw()
            if self.on_fence_edit:
                self.on_fence_edit()
            return
        # Along-axis pull: stretch the grabbed end (min length 0.5).
        if grab_b:
            nl = max(0.5, vlen + along)
            pts[seg + 1] = [ax + ux * nl, az + uz * nl]
        else:
            nl = max(0.5, vlen - along)
            pts[seg] = [bx - ux * nl, bz - uz * nl]
        self.queue_draw()

    def _fence_rotate_drag(self, x, y):
        """Rotate the selected segment around its midpoint."""
        fp = self._fence_press
        if fp is None or fp.get("seg") is None:
            return
        seg = fp["seg"]
        pts = self._fence_draft
        if not (0 <= seg < len(pts) - 1):
            return
        a0, b0 = fp["a0"], fp["b0"]
        mx, mz = (a0[0] + b0[0]) / 2.0, (a0[1] + b0[1]) / 2.0
        g0 = self._screen_to_ground(fp["sx"], fp["sy"])
        g1 = self._screen_to_ground(x, y)
        if g0 is None or g1 is None:
            return
        ang0 = math.atan2(g0[1] - mz, g0[0] - mx)
        ang1 = math.atan2(g1[1] - mz, g1[0] - mx)
        da = ang1 - ang0
        c, s = math.cos(da), math.sin(da)
        pts[seg] = [mx + (a0[0] - mx) * c - (a0[1] - mz) * s,
                    mz + (a0[0] - mx) * s + (a0[1] - mz) * c]
        pts[seg + 1] = [mx + (b0[0] - mx) * c - (b0[1] - mz) * s,
                        mz + (b0[0] - mx) * s + (b0[1] - mz) * c]
        self.queue_draw()

    def _hit_resize_handle(self, px, py):
        """
        Check if a click lands on a resize handle of the selected
        window. Returns the handle name ("tl"/"tr"/"br"/"bl") or None.
        v1.1.0.
        """
        for hname, hx, hy in self._resize_handles:
            if abs(px - hx) <= 8 and abs(py - hy) <= 8:
                return hname
        return None

    def _on_button_press(self, widget, event):
        """
        Button press. v1.2.0 interactions (Joshua):
        - view: resize handle -> resize; window/door/decoration hit ->
          item drag; vertical wall edge -> pivot-rotate the building
          around that edge; house body center -> move the house;
          wall face (off-center) -> pivot around its nearest edge;
          empty space -> rotate the view.
        - draw_fence: double-click a segment -> delete it; endpoint
          handle -> stretch drag; segment body -> select (drag body to
          stretch or spawn a 90-degree wall; hold 500ms then drag to
          rotate); empty click -> add a point; empty drag -> rotate.
        - add/remove modes: handled on release (click).
        Right-drag rotates the view in any mode.
        """
        # Right button: start a view-rotate drag in any mode.
        if event.button == 3:
            self._rdrag = [event.x, event.y, self.view_angle, False]
            return True
        if event.button != 1:
            return True

        if self.mode == "view":
            # 1. Resize handle of the selected window? (v1.1.0)
            handle = self._hit_resize_handle(event.x, event.y)
            if handle and self._selected_item is not None:
                kind, index = self._selected_item
                item = self._get_item(kind, index)
                if item is not None and kind == "window":
                    self._resize_drag = (
                        kind, index, handle,
                        event.x, event.y,
                        float(item.get("x", 0.0)),
                        float(item.get("y", 0.0)),
                        float(item.get("w", 0.15)),
                        float(item.get("h", 0.25)),
                    )
                    return True
            # 2. Window/door/decoration marker? Start an item drag.
            hit = self._hit_item(event.x, event.y)
            if hit:
                kind, index = hit
                if kind == "decoration":
                    item = self._get_decoration(index)
                elif kind == "parking":
                    # v1.5.0: parking elements drag on the ground plane
                    item = self._get_parking(index)
                else:
                    item = self._get_item(kind, index)
                if item is not None:
                    if kind == "decoration":
                        dtype = str(item.get("type", ""))
                        try:
                            from data import DECORATION_WALL_TYPES
                        except ImportError:
                            DECORATION_WALL_TYPES = {"Picture Frame",
                                                     "Curtains"}
                        if dtype in DECORATION_WALL_TYPES:
                            start_fx = float(item.get("x", 0.0))
                            start_fy = float(item.get("y", 0.0))
                        else:
                            start_fx = float(item.get("gx", 0.0))
                            start_fy = float(item.get("gz", 0.0))
                    elif kind == "parking":
                        # Ground-plane drag like floor decorations
                        start_fx = float(item.get("gx", 0.0))
                        start_fy = float(item.get("gz", 0.0))
                    else:
                        start_fx = float(item.get("x", 0.0))
                        start_fy = float(item.get("y", 0.0))
                    self._item_drag = (
                        kind, index,
                        event.x, event.y,
                        start_fx, start_fy,
                    )
                    # Track whether the pointer actually moved, so a
                    # plain click can select a window for resizing.
                    self._item_drag_moved = False
                    self.queue_draw()  # show the highlight
                    return True
            # 3. Vertical wall edge? Pivot-rotate the building
            # around that edge (v1.2.0, Joshua).
            edge = self._hit_edge(event.x, event.y, 14.0)
            if edge is not None and self.building is not None:
                local, seg = edge
                pos = self.building.get("position", [0, 0])
                self._pivot_drag = {
                    "edge_local": local,
                    "sx": event.x,
                    "rot0": float(
                        self.building.get("rotation", 0.0) or 0.0),
                    "pos0": [float(pos[0]) if len(pos) > 0 else 0.0,
                             float(pos[1]) if len(pos) > 1 else 0.0],
                }
                self._pivot_edge = seg
                self.queue_draw()
                return True
            # 4. On the house body? Center -> move the house;
            # off-center face -> pivot around its nearest edge.
            if self._in_body_bbox(event.x, event.y) \
                    and self.building is not None:
                if self._near_body_center(event.x, event.y):
                    g0 = self._screen_to_ground(event.x, event.y)
                    pos = self.building.get("position", [0, 0])
                    self._house_drag = {
                        "sx": event.x, "sy": event.y, "g0": g0,
                        "pos0": [
                            float(pos[0]) if len(pos) > 0 else 0.0,
                            float(pos[1]) if len(pos) > 1 else 0.0],
                        "rot0": float(
                            self.building.get("rotation", 0.0) or 0.0),
                    }
                    return True
                fhit = self._hit_face(event.x, event.y)
                pivoted = False
                if fhit is not None:
                    ne = self._nearest_face_edge(
                        fhit[0], event.x, event.y)
                    if ne is not None:
                        local, seg = ne
                        pos = self.building.get("position", [0, 0])
                        self._pivot_drag = {
                            "edge_local": local,
                            "sx": event.x,
                            "rot0": float(self.building.get(
                                "rotation", 0.0) or 0.0),
                            "pos0": [
                                float(pos[0]) if len(pos) > 0 else 0.0,
                                float(pos[1]) if len(pos) > 1 else 0.0],
                        }
                        self._pivot_edge = seg
                        self.queue_draw()
                        pivoted = True
                if not pivoted:
                    # On the body but no face (e.g. the roof): move.
                    g0 = self._screen_to_ground(event.x, event.y)
                    pos = self.building.get("position", [0, 0])
                    self._house_drag = {
                        "sx": event.x, "sy": event.y, "g0": g0,
                        "pos0": [
                            float(pos[0]) if len(pos) > 0 else 0.0,
                            float(pos[1]) if len(pos) > 1 else 0.0],
                        "rot0": float(
                            self.building.get("rotation", 0.0) or 0.0),
                    }
                return True
            # 5. Empty space — rotate the view. Clicking empty space
            # also deselects the selected window/parking element.
            self._selected_item = None
            if self.on_parking_selected:
                self.on_parking_selected(None)
            self._dragging = True
            self._drag_x = event.x
            self._drag_angle = self.view_angle
            self.queue_draw()  # clear resize handles

        if self.mode == "draw_fence":
            # Double-click a segment -> delete it.
            if event.type == Gdk.EventType._2BUTTON_PRESS:
                seg = self._fence_seg_hit(event.x, event.y)
                if seg is not None:
                    self._fence_delete_segment(seg)
                return True
            # Endpoint handle of the selected segment -> stretch drag.
            h = self._fence_handle_hit(event.x, event.y)
            if h is not None:
                self._fence_drag = {"kind": "endpoint",
                                    "seg": self._fence_sel, "end": h}
                self._cancel_fence_hold()
                return True
            # Segment body -> select it. Hold 500ms then drag to
            # rotate it around its midpoint.
            seg = self._fence_seg_hit(event.x, event.y)
            if seg is not None:
                pts = self._fence_draft
                self._fence_sel = seg
                self._fence_press = {
                    "sx": event.x, "sy": event.y, "seg": seg,
                    "moved": False,
                    "a0": list(pts[seg]), "b0": list(pts[seg + 1]),
                }
                self._cancel_fence_hold()
                self._fence_hold_id = GLib.timeout_add(
                    500, self._fence_hold_fired)
                self.queue_draw()
                return True
            # Empty space: a click adds a point (on release); a drag
            # rotates the view.
            self._fence_press = {"sx": event.x, "sy": event.y,
                                 "seg": None, "moved": False}
            return True
        return True

    def _get_decoration(self, index):
        """Return the decoration dict at index, or None. v1.1.0."""
        if not self.building:
            return None
        decos = self.building.get("decorations", [])
        if 0 <= index < len(decos):
            return decos[index]
        return None

    def _on_button_release(self, widget, event):
        """
        Handle clicks and drag ends across all modes.
        v1.2.0: ends house-move, pivot-rotate, and fence-segment
        drags; right-drag ends view rotation (a plain right-click in
        fence mode removes the last draft point, as before).
        """
        # Right button: end the view-rotate drag. A plain right-click
        # (no drag) in draw_fence mode removes the last point.
        if event.button == 3:
            was_drag = self._rdrag is not None and self._rdrag[3]
            self._rdrag = None
            if (not was_drag and self.mode == "draw_fence"
                    and self._fence_draft):
                self._fence_draft.pop()
                self._fence_sel = None
                self.queue_draw()
            return True
        if event.button != 1:
            return True

        if self.mode == "view":
            if self._resize_drag is not None:
                # Resize finished — persist via on_item_moved.
                kind, index = (self._resize_drag[0],
                               self._resize_drag[1])
                self._resize_drag = None
                self.queue_draw()
                if self.on_item_moved:
                    self.on_item_moved(kind, index)
            elif self._item_drag is not None:
                kind, index = self._item_drag[0], self._item_drag[1]
                moved = getattr(self, "_item_drag_moved", False)
                self._item_drag = None
                if not moved and kind == "window":
                    # Plain click on a window -> select it for resizing
                    self._selected_item = ("window", index)
                elif not moved and kind == "parking":
                    # v1.5.0: plain click selects the parking element
                    # so the app can show its property editors.
                    self._selected_item = ("parking", index)
                    if self.on_parking_selected:
                        self.on_parking_selected(index)
                elif not moved and self._selected_item is not None:
                    self._selected_item = None
                    if self.on_parking_selected:
                        self.on_parking_selected(None)
                self.queue_draw()
                if moved and self.on_item_moved:
                    self.on_item_moved(kind, index)
            # End a pivot-rotate or house-move drag (v1.2.0). The new
            # rotation/position was already saved via
            # on_transform_changed during the drag.
            if self._pivot_drag is not None:
                self._pivot_drag = None
                self._pivot_edge = None
                self.queue_draw()
            self._house_drag = None
            self._dragging = False
            return True

        # Click in an edit mode — hit test
        if self.mode in ("add_window", "add_door") and self.on_face_click:
            hit = self._hit_face(event.x, event.y)
            if hit:
                face, fx, fy = hit
                self.on_face_click(face, fx, fy)
        elif self.mode == "add_decoration" and self.on_decoration_click:
            # Wall types need a face click; floor types need a ground
            # click. The app tells us which via pending_decoration_type.
            dtype = getattr(self, "pending_decoration_type",
                            "Picture Frame")
            try:
                from data import DECORATION_WALL_TYPES
            except ImportError:
                DECORATION_WALL_TYPES = {"Picture Frame", "Curtains"}
            if dtype in DECORATION_WALL_TYPES:
                hit = self._hit_face(event.x, event.y)
                if hit:
                    face, fx, fy = hit
                    self.on_decoration_click(
                        {"type": dtype, "face": face, "x": fx, "y": fy})
            else:
                g = self._screen_to_ground(event.x, event.y)
                if g is not None:
                    self.on_decoration_click(
                        {"type": dtype, "gx": g[0], "gz": g[1]})
        elif self.mode == "add_parking" and self.on_parking_click:
            # v1.5.0 (Joshua): click the ground to place a parking
            # element of the pending type.
            g = self._screen_to_ground(event.x, event.y)
            if g is not None:
                ptype = getattr(self, "pending_parking_type", "lot")
                gx = max(-15.0, min(15.0, g[0]))
                gz = max(-15.0, min(15.0, g[1]))
                self.on_parking_click(
                    {"type": ptype, "gx": gx, "gz": gz})
        elif self.mode == "draw_fence":
            # End any fence gesture. A plain click on empty ground
            # appends a fence point; anything else was handled during
            # the drag. v1.2.0 (Joshua): segment editing.
            self._cancel_fence_hold()
            self._fence_rotating = False
            self._fence_view_rot = None
            self._fence_drag = None
            fp = self._fence_press
            self._fence_press = None
            if fp is not None and not fp.get("moved") \
                    and fp.get("seg") is None:
                g = self._screen_to_ground(event.x, event.y)
                if g is not None and self.on_fence_point:
                    # Clamp to a sane area around the building
                    gx = max(-15.0, min(15.0, g[0]))
                    gz = max(-15.0, min(15.0, g[1]))
                    self._fence_draft.append([gx, gz])
                    self.on_fence_point(gx, gz)
                    self.queue_draw()
            elif fp is not None and (fp.get("moved")
                                     or fp.get("done")):
                if self.on_fence_edit:
                    self.on_fence_edit()
        elif self.mode == "remove" and self.on_item_click:
            hit = self._hit_item(event.x, event.y)
            if hit:
                kind, index = hit
                self.on_item_click(kind, index)
        return True

    def _on_motion(self, widget, event):
        """
        Motion handling. v1.2.0 (Joshua): right-drag rotates the view
        in any mode; view mode adds pivot-rotate and house-move drags;
        draw_fence mode adds segment stretch / 90-degree spawn /
        hold-to-rotate gestures.
        """
        # Right-button drag: rotate the view in any mode.
        if self._rdrag is not None:
            sx0, sy0, ang0, moved = self._rdrag
            if abs(event.x - sx0) > 3 or abs(event.y - sy0) > 3:
                moved = True
            self._rdrag = [sx0, sy0, ang0, moved]
            self.view_angle = ang0 + (event.x - sx0) * (
                2 * math.pi / 600.0)
            self.queue_draw()
            return True

        if self.mode == "draw_fence":
            # Endpoint stretch drag.
            if self._fence_drag is not None:
                self._fence_endpoint_drag(event.x, event.y)
                return True
            # Grab-hold segment rotate.
            if self._fence_rotating:
                self._fence_rotate_drag(event.x, event.y)
                return True
            # Press in progress: click-vs-drag disambiguation.
            fp = self._fence_press
            if fp is not None:
                dx = event.x - fp["sx"]
                dy = event.y - fp["sy"]
                if abs(dx) > 6 or abs(dy) > 6:
                    fp["moved"] = True
                    self._cancel_fence_hold()
                    if fp["seg"] is not None:
                        # Body drag: stretch along, or 90-degree wall.
                        self._fence_body_drag(fp, event.x, event.y)
                    else:
                        # Empty-space drag: rotate the view.
                        if self._fence_view_rot is None:
                            self._fence_view_rot = (
                                event.x, self.view_angle)
                        vsx0, vang0 = self._fence_view_rot
                        self.view_angle = vang0 + (event.x - vsx0) * (
                            2 * math.pi / 600.0)
                        self.queue_draw()
                return True
            return True

        if self.mode != "view":
            return True

        # --- Window resize drag (v1.1.0) ---
        if self._resize_drag is not None:
            (kind, index, handle, sx0, sy0,
             fx0, fy0, fw0, fh0) = self._resize_drag
            item = self._get_item(kind, index)
            if item is None:
                self._resize_drag = None
                return True
            bbox = self._face_bbox(item.get("face", "front"))
            if bbox is None:
                return True
            x0, y0, x1, y1 = bbox
            bw_px = max(1.0, x1 - x0)
            bh_px = max(1.0, y1 - y0)
            dfx = (event.x - sx0) / bw_px
            dfy = -(event.y - sy0) / bh_px  # screen y is inverted
            # Adjust x/y/w/h based on which corner handle is dragged.
            # Minimum size 0.05 keeps windows from vanishing.
            nx, ny, nw, nh = fx0, fy0, fw0, fh0
            if "l" in handle:  # left edge moves
                nx = min(fx0 + fw0 - 0.05, fx0 + dfx)
                nw = fw0 + (fx0 - nx)
            if "r" in handle:  # right edge moves
                nw = max(0.05, fw0 + dfx)
            if "t" in handle:  # top edge moves (fy grows upward)
                nh = max(0.05, fh0 + dfy)
            if "b" in handle:  # bottom edge moves
                ny = min(fy0 + fh0 - 0.05, fy0 + dfy)
                nh = fh0 + (fy0 - ny)
            # Clamp to the face
            nx = max(0.02, min(0.93, nx))
            nw = max(0.05, min(0.93 - nx, nw))
            ny = max(0.25, min(0.90, ny))
            nh = max(0.05, min(0.90 - ny, nh))
            item["x"], item["y"] = nx, ny
            item["w"], item["h"] = nw, nh
            self.queue_draw()
            return True

        # --- Item dragging: move the marker ---
        if self._item_drag is not None:
            kind, index, sx0, sy0, fx0, fy0 = self._item_drag
            # Mark as moved if the pointer left a small dead zone
            if (abs(event.x - sx0) > 4 or abs(event.y - sy0) > 4):
                self._item_drag_moved = True
            if kind == "decoration":
                item = self._get_decoration(index)
                if item is None:
                    self._item_drag = None
                    return True
                dtype = str(item.get("type", ""))
                try:
                    from data import DECORATION_WALL_TYPES
                except ImportError:
                    DECORATION_WALL_TYPES = {"Picture Frame",
                                             "Curtains"}
                if dtype in DECORATION_WALL_TYPES:
                    # Wall decoration: drag on its face like a window
                    bbox = self._face_bbox(item.get("face", "front"))
                    if bbox is None:
                        return True
                    x0, y0, x1, y1 = bbox
                    bw_px = max(1.0, x1 - x0)
                    bh_px = max(1.0, y1 - y0)
                    dfx = (event.x - sx0) / bw_px
                    dfy = -(event.y - sy0) / bh_px
                    item["x"] = max(0.02, min(0.85, fx0 + dfx))
                    item["y"] = max(0.20, min(0.80, fy0 + dfy))
                else:
                    # Floor decoration: drag on the ground plane
                    g0 = self._screen_to_ground(sx0, sy0)
                    g1 = self._screen_to_ground(event.x, event.y)
                    if g0 is not None and g1 is not None:
                        item["gx"] = max(-15.0, min(15.0,
                                                   fx0 + (g1[0] - g0[0])))
                        item["gz"] = max(-15.0, min(15.0,
                                                   fy0 + (g1[1] - g0[1])))
                self.queue_draw()
                return True
            elif kind == "parking":
                # v1.5.0: parking elements drag on the ground plane,
                # same as floor decorations.
                item = self._get_parking(index)
                if item is None:
                    self._item_drag = None
                    return True
                g0 = self._screen_to_ground(sx0, sy0)
                g1 = self._screen_to_ground(event.x, event.y)
                if g0 is not None and g1 is not None:
                    item["gx"] = max(-15.0, min(15.0,
                                               fx0 + (g1[0] - g0[0])))
                    item["gz"] = max(-15.0, min(15.0,
                                               fy0 + (g1[1] - g0[1])))
                self.queue_draw()
                return True
            # Windows/doors (existing behavior)
            item = self._get_item(kind, index)
            if item is None:
                self._item_drag = None
                return True
            bbox = self._face_bbox(item.get("face", "front"))
            if bbox is None:
                return True
            x0, y0, x1, y1 = bbox
            bw = max(1.0, x1 - x0)
            bh = max(1.0, y1 - y0)
            dfx = (event.x - sx0) / bw
            dfy = -(event.y - sy0) / bh
            if kind == "window":
                item["x"] = max(0.02, min(0.83, fx0 + dfx))
                item["y"] = max(0.25, min(0.70, fy0 + dfy))
            else:
                item["x"] = max(0.02, min(0.86, fx0 + dfx))
                item["y"] = 0.0
            self.queue_draw()
            return True

        # --- Pivot-rotate drag (v1.2.0, Joshua) ---
        # The grabbed edge stays fixed in world space: the rotation
        # changes with horizontal drag and the building center moves
        # so the pivot point doesn't move.
        if self._pivot_drag is not None and self.building is not None:
            pd = self._pivot_drag
            dx = event.x - pd["sx"]
            new_rot = (pd["rot0"] + dx * 0.35) % 360.0
            lx, lz = pd["edge_local"]
            olx, olz = self._local_to_world(lx, lz)
            rpx, rpz = self._rot2_cw(olx, olz, pd["rot0"])
            pwx, pwz = pd["pos0"][0] + rpx, pd["pos0"][1] + rpz
            rpx2, rpz2 = self._rot2_cw(olx, olz, new_rot)
            ncx, ncz = pwx - rpx2, pwz - rpz2
            self.building["rotation"] = new_rot
            self.building["position"] = [ncx, ncz]
            if self.on_transform_changed:
                self.on_transform_changed()
            return True

        # --- House-move drag (v1.2.0, Joshua) ---
        # Dragging the house body translates it across the map; the
        # roads shift in the preview and position X/Z update.
        if self._house_drag is not None and self.building is not None:
            hd = self._house_drag
            g1 = self._screen_to_ground(event.x, event.y)
            if g1 is not None and hd["g0"] is not None:
                dlx = g1[0] - hd["g0"][0]
                dlz = g1[1] - hd["g0"][1]
                olx, olz = self._local_to_world(dlx, dlz)
                wdx, wdz = self._rot2_cw(olx, olz, hd["rot0"])
                ncx = hd["pos0"][0] + wdx
                ncz = hd["pos0"][1] + wdz
                self.building["position"] = [ncx, ncz]
                if self.on_transform_changed:
                    self.on_transform_changed()
            return True

        # --- View rotation (existing behavior) ---
        if self._dragging:
            dx = event.x - self._drag_x
            self.view_angle = self._drag_angle + dx * (2 * math.pi / 600.0)
            self.queue_draw()
        return True

    def _hit_face(self, px, py):
        """
        Find which ground-floor face polygon contains the click.
        Returns (face_name, fx, fy) with fx/fy fractional 0-1 across
        the face, or None.
        """
        for name, poly in self._face_polys:
            if self._point_in_poly(px, py, poly):
                # Fractional position: interpolate along the face.
                # Use the bounding box of the polygon as an approximation.
                xs = [p[0] for p in poly]
                ys = [p[1] for p in poly]
                x0, x1 = min(xs), max(xs)
                y0, y1 = min(ys), max(ys)
                fx = (px - x0) / (x1 - x0 + 1e-9)
                # fy: 1 at top of face, 0 at bottom
                fy = 1.0 - (py - y0) / (y1 - y0 + 1e-9)
                fx = max(0.0, min(1.0, fx))
                fy = max(0.0, min(1.0, fy))
                return name, fx, fy
        return None

    def _hit_item(self, px, py):
        """
        Find which window/door screen rect contains the click.
        Returns (kind, index) or None.
        """
        for kind, index, (x0, y0, x1, y1) in self._item_rects:
            if x0 <= px <= x1 and y0 <= py <= y1:
                return kind, index
        return None
