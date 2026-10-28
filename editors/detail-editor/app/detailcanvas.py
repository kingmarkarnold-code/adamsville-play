#!/usr/bin/env python3
"""
Adamsville Detail Editor (Native) — the canvases.

Two GTK/cairo canvases, one shared still-picture discipline:

  StillCanvas — the base. TONIGHT'S REFINEMENT of the suite's
  one-live-pane rule (Joshua, 2026-10-18): a canvas is LIVE only
  while the mouse hovers it; mouse-away deactivates it, and
  deactivation NEVER takes the picture away — the canvas keeps
  showing its last image as a STILL (an offscreen surface), only
  the live redraw machinery stops. A data change refreshes the
  still exactly once, then it freezes again. So at most one canvas
  in the app is ever spending resources, and every pane always
  shows its picture.

  DetailCanvas — the working canvas: the open piece drawn whole
  (its FACE — the ribbon its segments sweep at the road's width,
  carrying its material colour — its segments, and its points as
  handles) over the coloured neighbourhood it lives in (grass,
  water, buildings, the surrounding roads). Holds the camera
  (pan / zoom / heading) and the editing tools.

  OverviewCanvas — the small map: the piece in its neighbourhood
  with a rectangle for the working canvas's view; clicking or
  dragging in it moves the working view.

1.2.0 (Joshua's findings of 2026-10-25, built 2026-10-28):

  COLOUR — the world is drawn in the game's own material colours
  (grass ground, water blue, asphalt faces, muted building
  colours), never grayscale: "we're no longer on an Apple II".
  The metre grid stays (he likes it, visible as he zooms).

  SEGMENTATION — the piece carries a segmentation layer: by
  default COARSE (a handle every ~30 m — just enough to nudge
  the road), and a portion can be RESEGMENTED fine (every point
  a handle) on demand, from the right-click menu. Density is a
  control layer only; the element's points are never created or
  destroyed by it. Rendering draws only the runs of road inside
  the view, so a 4,000-point piece stays fluid zoomed in.

  LASSO — Shift+drag (his settled gesture; Ctrl+drag stays
  ROTATE under the universal controls): draw a loop on the map
  and the portion of THE OPEN PIECE inside it becomes the
  working focus — its points are selected together (Delete
  removes them as one operation, one undo step), the face tints
  over the portion, and the view zooms to fit it. Shift+click
  adds/removes one point. Other roads are never selected — the
  lasso only ever reads the open element.

  CLICK-SWITCH — a clean click on ANOTHER road asks the app
  (on_switch_request) to save the current piece and open the
  clicked one as the working piece.

  COMPASS (bottom-right; click = north up) + SCALE BAR
  (bottom-left, dynamic miles/feet; it is a real UI element —
  clicks land on IT, not through it; clicking it enters MEASURE
  mode, where clicks lay down a line whose length is reported).

UNIVERSAL VIEWPORT CONTROLS (Joshua's suite law): drag pans,
wheel zooms, + / − keys zoom (the window forwards key presses),
Ctrl+drag rotates; touch: one-finger drag pans, pinch zooms, and
the ORBIT toggle (the app's button) makes a drag rotate instead —
phones have no Ctrl key.

The camera: centre (cx, cz) in world units, scale in screen px per
world unit, heading in radians. World z runs DOWN-screen at
heading 0 (south), matching the suite's map views.

The context provider contract (app-wired): a callable taking the
view rect (x0, z0, x1, z1) and returning a dict:
    {"roads":     [(category, index, pts, width), ...],
     "buildings": [[x, z, w, d, h, type], ...],
     "water":     [(kind, [[x, z], ...]), ...]}
Roads carry their identity so a click can switch pieces.

Joshua's rule: all code commented.
"""

import math

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gtk, Gdk, GLib
import cairo

from element import point_in_polygon, point_segment_distance, \
    ribbon_polygon

# Category ribbon widths in world units — the suite's table
# (suite_core.viewport3d carries the same numbers for its 3D view;
# visual only, gameplay widths live in the game).
ROAD_WIDTHS = {"interstate": 16.0, "highway": 14.0,
               "major_artery": 11.0, "minor_artery": 9.0,
               "local": 7.0}
DEFAULT_ROAD_WIDTH = 7.0

# ---------------------------------------------------------------------------
# Colours (cairo RGB) — THE GAME'S MATERIAL LANGUAGE (1.2.0).
# Every value is one of the game's own colours, named at its
# source in play/detailed/ so the editor and the game can never
# drift apart in spirit:
#   grass      — the terrain's vertex-colour greens in index.html
#                (0x5d8f4a / 0x74a854 / 0x8aa653) and its flat
#                grass green 0x4a7a3a.
#   asphalt    — the game's road tint 0x3a3a3e (school_plaza.js's
#                asphalt lot), pavement 0x74777c (map_loader.js).
#   concrete   — dress535.js's concrete 0xb0aa9e, curb 0x8f8c85.
#   water      — water_render.js / index.html: surface 0x2e6f9e,
#                deep 0x1e6f9e.
#   buildings  — muted from the game's building palette: brick
#                0xa05c42, foundation 0x8a6f5a, cream 0xe6dec8,
#                roof charcoal 0x35322e, terracotta 0xb56545,
#                wood 0xa08156 — toned down for context duty.
#   trees      — canopy greens 0x4d8033 / 0x5f9440 / 0x8fae3e
#                (dress535.js) — held for the day the zone data
#                carries vegetation; 1.2.0's zones do not.
# ---------------------------------------------------------------------------

def _hex(rgb):
    """0xRRGGBB -> the cairo (r, g, b) float triple."""
    return (((rgb >> 16) & 255) / 255.0,
            ((rgb >> 8) & 255) / 255.0,
            (rgb & 255) / 255.0)


GROUND_COLOR = _hex(0x5d8f4a)       # grass (terrain green)
GRID_COLOR = _hex(0x4a7a3a)         # grid: the darker flat grass
FACE_COLOR = _hex(0x3a3a3e)         # the open piece: asphalt
FACE_EDGE = _hex(0x74777c)          # its edge: pavement grey
CENTRELINE_COLOR = (0.93, 0.91, 0.84)   # faded road paint
CONTEXT_COLOR = _hex(0x55524a)      # other roads: warm dark asphalt
CONTEXT_EDGE = _hex(0x8b8f94)       # (deck concrete, map_loader.js)
WATER_COLOR = _hex(0x2e6f9e)        # the game's water surface
WATER_EDGE = _hex(0x1e6f9e)         # the game's water deep
BUILDING_COLORS = [                 # muted building context tones
    (0.55, 0.38, 0.30),             # brick, toned down
    (0.72, 0.68, 0.58),             # cream
    (0.54, 0.44, 0.35),             # foundation tan
    (0.42, 0.40, 0.38),             # roof grey-brown
    (0.62, 0.42, 0.30),             # terracotta, toned down
    (0.60, 0.49, 0.36),             # wood
]
BUILDING_EDGE = _hex(0x35322e)      # roof charcoal, for outlines
POINT_FILL = (0.95, 0.80, 0.25)     # handles: gold (unchanged)
POINT_RING = (0.10, 0.10, 0.10)
SELECTED_FILL = (1.0, 0.55, 0.15)   # the selected point: orange
SELECTED_RING = (1.0, 1.0, 1.0)     # multi-selected points ring
SELECTED_RUN = (0.85, 0.45, 0.10)   # segments between selected
PENDING_COLOR = (0.35, 0.75, 1.0)
SECTION_COLOR = (1.0, 0.30, 0.25)
FOCUS_TINT = (1.0, 0.62, 0.15, 0.38)    # the lassoed portion
LASSO_COLOR = (0.30, 0.90, 1.0)         # the loop being drawn
LASSO_FILL = (0.30, 0.90, 1.0, 0.15)
MEASURE_COLOR = (1.0, 0.85, 0.25)
HANDLE_COARSE_COLOR = (0.98, 0.90, 0.55)  # coarse handles: pale

# Segmentation: the coarse base spacing (metres of road between
# handles) — light enough to nudge a road left or right, per
# Joshua's model; Resegment makes a portion fine (every point).
SEGMENT_SPACING_M = 30.0

# Screen-space pick tolerances (px): generous enough for a finger
# or a tired hand at 2 AM, tight enough to mean the nearest thing.
POINT_PICK_PX = 11
SEGMENT_PICK_PX = 9

# Scale-bar steps: (world metres, label) — feet close in, miles
# far out (Joshua's scale spec, 2026-10-25 17:07).
SCALE_STEPS = [(15.24, "50 ft"), (30.48, "100 ft"),
               (60.96, "200 ft"), (152.4, "500 ft"),
               (304.8, "1,000 ft"), (402.336, "¼ mi"),
               (804.672, "½ mi"), (1609.344, "1 mi"),
               (3218.688, "2 mi"), (8046.72, "5 mi"),
               (16093.44, "10 mi")]
SCALE_BAR_MAX_PX = 150


def runs_in_view(pts, rect, margin):
    """
    Split a polyline into the runs that cross the view: a list of
    (start, end) index pairs (end exclusive), each extended by
    one point past the view on both sides where one exists, so
    strokes and fills run off the screen edge instead of stopping
    at the last visible point. The test per point is four
    comparisons — this is what makes a 4,000-point piece cheap to
    draw zoomed into detail: everything outside the view is
    skipped before any ribbon or projection maths happens.
    """
    x0, z0, x1, z1 = rect
    x0 -= margin
    z0 -= margin
    x1 += margin
    z1 += margin
    runs = []
    start = None
    for i, p in enumerate(pts):
        if x0 <= p[0] <= x1 and z0 <= p[1] <= z1:
            if start is None:
                start = i
        elif start is not None:
            runs.append((max(start - 1, 0), min(i + 1, len(pts))))
            start = None
    if start is not None:
        runs.append((max(start - 1, 0), len(pts)))
    return runs


def scale_choice(scale):
    """
    The scale bar's step for a camera scale (px per metre): the
    largest step whose on-screen length fits the bar's budget
    (the smallest step when zoomed in past all of them). Returns
    (world_metres, label, px_length).
    """
    best = SCALE_STEPS[0]
    for step in SCALE_STEPS:
        if step[0] * scale <= SCALE_BAR_MAX_PX:
            best = step
        else:
            break
    return best[0], best[1], best[0] * scale


class Camera:
    """World <-> screen for one view: centre, scale, heading."""

    def __init__(self):
        self.cx = 0.0           # world x at the view centre
        self.cz = 0.0           # world z at the view centre
        self.scale = 2.0        # screen px per world unit
        self.heading = 0.0      # radians; 0 = north up

    def world_to_screen(self, x, z, w, h):
        """Project a world point into widget pixels."""
        dx, dz = x - self.cx, z - self.cz
        c, s = math.cos(self.heading), math.sin(self.heading)
        rx, rz = dx * c + dz * s, -dx * s + dz * c
        return (w / 2.0 + rx * self.scale, h / 2.0 + rz * self.scale)

    def screen_to_world(self, sx, sy, w, h):
        """The exact inverse of world_to_screen."""
        rx = (sx - w / 2.0) / self.scale
        rz = (sy - h / 2.0) / self.scale
        c, s = math.cos(self.heading), math.sin(self.heading)
        dx, dz = rx * c - rz * s, rx * s + rz * c
        return (self.cx + dx, self.cz + dz)

    def view_rect_world(self, w, h):
        """(x0, z0, x1, z1): the world rectangle the view covers
        (heading-aware: the rotated corners' bounding box)."""
        corners = [self.screen_to_world(px, py, w, h)
                   for px, py in ((0, 0), (w, 0), (0, h), (w, h))]
        xs = [p[0] for p in corners]
        zs = [p[1] for p in corners]
        return min(xs), min(zs), max(xs), max(zs)

    def fit_rect(self, rect, w, h, margin=1.25):
        """Centre on a world rect and scale so it fits with margin.
        Heading is left alone (a fit never spins the view)."""
        if w <= 0 or h <= 0:
            return
        x0, z0, x1, z1 = rect
        self.cx, self.cz = (x0 + x1) / 2.0, (z0 + z1) / 2.0
        rw, rh = max(x1 - x0, 1.0), max(z1 - z0, 1.0)
        self.scale = max(0.02, min(w / (rw * margin),
                                   h / (rh * margin)))

    def zoom_at(self, sx, sy, factor, w, h):
        """Zoom around a screen point (the point stays put)."""
        wx, wz = self.screen_to_world(sx, sy, w, h)
        self.scale = max(0.02, min(400.0, self.scale * factor))
        nx, nz = self.screen_to_world(sx, sy, w, h)
        self.cx += wx - nx
        self.cz += wz - nz


class StillCanvas(Gtk.DrawingArea):
    """
    The hover-live / still-picture discipline (see the module
    docstring). Subclasses implement render(cr, w, h) — a FULL
    scene paint. The base owns: the offscreen still, hover
    tracking, and the rule that an inactive canvas never repaints
    from anything but its still (refreshed once per change).
    """

    def __init__(self):
        super().__init__()
        self._live = False          # the mouse is over us
        self._still = None          # cairo.ImageSurface or None
        self._still_valid = False
        self.add_events(Gdk.EventMask.ENTER_NOTIFY_MASK
                        | Gdk.EventMask.LEAVE_NOTIFY_MASK)
        self.connect("enter-notify-event", self._on_enter)
        self.connect("leave-notify-event", self._on_leave)
        self.connect("draw", self._on_draw)

    # -- the discipline ----------------------------------------------

    def is_live(self):
        """True while the mouse hovers this canvas."""
        return self._live

    def invalidate(self):
        """
        Mark the picture stale (data changed). The next draw —
        whenever it comes — refreshes the still ONCE; if we are
        live, draws keep coming and stay live.
        """
        self._still_valid = False
        self.queue_draw()

    def _on_enter(self, _widget, _event):
        self._live = True
        self.queue_draw()
        return False

    def _on_leave(self, _widget, _event):
        self._live = False
        # Freeze the CURRENT picture as the still before going
        # quiet, so mouse-away never shows an older frame.
        self._still_valid = False
        self.queue_draw()
        return False

    def _on_draw(self, _widget, cr):
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height
        if w <= 0 or h <= 0:
            return False
        if self._live:
            # Live: paint the scene directly (and keep the still in
            # step, cheaply, only when a drag is not in flight —
            # the leave handler takes the final still).
            self.render(cr, w, h)
            return False
        # Not live: show the still; refresh it once if stale.
        if self._still is None or self._still.get_width() != w \
                or self._still.get_height() != h \
                or not self._still_valid:
            self._still = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, h)
            scr = cairo.Context(self._still)
            self.render(scr, w, h)
            self._still_valid = True
        cr.set_source_surface(self._still, 0, 0)
        cr.paint()
        return False

    def render(self, cr, w, h):
        """Paint the whole scene. Subclasses override."""
        cr.set_source_rgb(*GROUND_COLOR)
        cr.paint()


class DetailCanvas(StillCanvas):
    """
    The working canvas (see the module docstring).

    App-wired attributes:
        session:           the PieceSession being edited (or None)
        context_provider:  callable(view_rect) -> the context
                           dict (see the module docstring)
        piece_width:       ribbon width of the open piece
        on_edit:           callable() after any mutation
        on_status:         callable(text) for the status bar
        on_snapshot:       callable() BEFORE a mutation
        confirm_section:   callable(n_points, n_segments) -> bool,
                           asked before a section deletion lands
        confirm_points:    callable(n_points) -> bool, asked
                           before a lasso group deletion lands
        on_selection:      callable() after the point selection
                           or focus changes (the app refreshes
                           its Delete Selected button + info)
        on_switch_request: callable(category, index, pts) when a
                           clean click lands on another road
        on_context_menu:   callable(event) on a right-click —
                           the app shows the portion menu
    """

    # The tool names (the toolbar's vocabulary). "select" is the
    # base state the app OPENS in — pan/zoom/select, with point
    # dragging as the move — not an armed tool. There is NO lasso
    # tool: the lasso is the Shift+drag gesture, always available
    # (Joshua's design, 2026-10-25).
    TOOLS = ("select", "add_point", "del_point", "add_segment",
             "del_segment", "del_section")

    def __init__(self):
        super().__init__()
        self.camera = Camera()
        self.session = None
        self.context_provider = None
        self.piece_width = DEFAULT_ROAD_WIDTH
        self.on_edit = None
        self.on_status = None
        self.on_snapshot = None     # callable() BEFORE a mutation
        self.confirm_section = None
        self.confirm_points = None
        self.on_selection = None
        self.on_switch_request = None
        self.on_context_menu = None
        self.tool = "select"
        self.orbit_mode = False     # the touch face of Ctrl+drag
        self.selected_point = None  # point index or None
        # The lasso's harvest (1.2.0): the points selected
        # together, and the focused portion (a contiguous run of
        # one chain) the last lasso defined.
        self.selected_points = set()
        self.focus_chain = None     # chain (point indices) or None
        self.focus_lo = None        # span positions in the chain
        self.focus_hi = None
        # Segmentation layer (1.2.0): point indices resegmented
        # FINE; everything else is coarse (handles at ~30 m).
        self.fine_points = set()
        self._handles = set()       # computed handle indices
        # Measure mode (1.2.0): entered from the scale bar.
        self.measure_mode = False
        self.measure_pts = []       # [[x, z], ...] world points
        self._drag = None           # in-flight drag state dict
        self._pending = None        # tool's first pick (point/seg)
        self._hover_world = None    # last pointer world position
        # Overlay hit-rects from the last render (the scale bar
        # and compass are real UI: clicks land on them, never
        # through them — Joshua's occlusion rule).
        self._scale_rect = None
        self._compass_rect = None
        self.set_can_focus(True)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK
                        | Gdk.EventMask.BUTTON_RELEASE_MASK
                        | Gdk.EventMask.POINTER_MOTION_MASK
                        | Gdk.EventMask.SCROLL_MASK
                        | Gdk.EventMask.ENTER_NOTIFY_MASK
                        | Gdk.EventMask.LEAVE_NOTIFY_MASK)
        self.connect("button-press-event", self._on_press)
        self.connect("button-release-event", self._on_release)
        self.connect("motion-notify-event", self._on_motion)
        self.connect("scroll-event", self._on_scroll)
        # Pinch zoom (touch): GTK's zoom gesture reports a scale
        # delta; route it into the same camera zoom as the wheel.
        try:
            self._pinch = Gtk.GestureZoom.new(self)
            self._pinch.connect("scale-changed", self._on_pinch)
            self._pinch_base = None
            self._pinch.connect("begin",
                                lambda *_a: setattr(self,
                                                    "_pinch_base",
                                                    self.camera.scale))
        except Exception:
            self._pinch = None      # mouse-only environment: fine

    # -- setup ---------------------------------------------------------

    def set_session(self, session, piece_width):
        """Open a piece: adopt the session, reset tool state, frame
        the WHOLE piece (the design: open zoomed to the full street
        — all points, all segments, the face)."""
        self.session = session
        self.piece_width = piece_width or DEFAULT_ROAD_WIDTH
        self.tool = "select"
        self.selected_point = None
        self.selected_points = set()
        self.focus_chain = None
        self.focus_lo = self.focus_hi = None
        self.fine_points = set()
        self.measure_mode = False
        self.measure_pts = []
        self._pending = None
        self._drag = None
        self._compute_handles()
        self.fit_piece()
        self.invalidate()

    def fit_piece(self):
        """Frame the whole piece with a modest margin."""
        if self.session is None:
            return
        alloc = self.get_allocation()
        bounds = self.session.element.bounds()
        if bounds is not None:
            pad = self.piece_width  # the face extends past the line
            rect = (bounds[0] - pad, bounds[1] - pad,
                    bounds[2] + pad, bounds[3] + pad)
            self.camera.fit_rect(rect, max(alloc.width, 2),
                                 max(alloc.height, 2), margin=1.3)
        self.invalidate()

    def view_rect(self):
        """The world rectangle this canvas currently shows (its own
        allocation + camera) — the overview draws it as the frame."""
        alloc = self.get_allocation()
        return self.camera.view_rect_world(max(alloc.width, 2),
                                           max(alloc.height, 2))

    def set_tool(self, tool):
        """Arm a tool (or return to the base state). Any half-done
        two-pick operation is abandoned. The selection and focus
        SURVIVE tool changes (selection is multipurpose)."""
        if tool not in self.TOOLS:
            tool = "select"
        self.tool = tool
        self._pending = None
        self.invalidate()

    # -- the segmentation layer ----------------------------------------

    def _compute_handles(self):
        """
        Recompute which points carry handles: every chain end,
        one boundary every SEGMENT_SPACING_M of road per chain,
        plus every fine (resegmented) point. Called when a piece
        opens and whenever the density layer changes — never per
        frame.
        """
        self._handles = set(self.fine_points)
        if self.session is None:
            return
        el = self.session.element
        for chain in el.chains():
            if not chain:
                continue
            self._handles.add(chain[0])
            self._handles.add(chain[-1])
            travelled = 0.0
            for pos in range(1, len(chain)):
                a = el.points[chain[pos - 1]]
                b = el.points[chain[pos]]
                travelled += math.hypot(b[0] - a[0], b[1] - a[1])
                if travelled >= SEGMENT_SPACING_M:
                    self._handles.add(chain[pos])
                    travelled = 0.0

    def reset_segmentation(self):
        """Back to the coarse base (structural edits renumber the
        points, so density state cannot honestly survive them;
        a plain point MOVE never calls this)."""
        self.fine_points = set()
        self.focus_chain = None
        self.focus_lo = self.focus_hi = None
        self._compute_handles()

    def focus_points(self):
        """The focused portion's point indices (the contiguous
        span the last lasso defined), or an empty set."""
        if self.focus_chain is None or self.focus_lo is None:
            return set()
        return set(self.focus_chain[self.focus_lo:
                                    self.focus_hi + 1])

    def resegment_focus(self):
        """RESEGMENT the focused portion fine: every point in it
        becomes a handle (density up, in this area only)."""
        pts = self.focus_points()
        if not pts:
            self._say("Resegment: lasso a portion first "
                      "(Shift+drag around it).")
            return
        self.fine_points |= pts
        self._compute_handles()
        self.invalidate()
        self._say(f"Resegmented: {len(pts)} points in the "
                  f"portion are now fine handles.")

    def coarsen_focus(self):
        """Coarsen the focused portion back to the base spacing
        (density down, in this area only)."""
        pts = self.focus_points()
        if not pts:
            self._say("Coarsen: lasso a portion first "
                      "(Shift+drag around it).")
            return
        self.fine_points -= pts
        self._compute_handles()
        self.invalidate()
        self._say("Coarsened: the portion is back to the base "
                  "segmentation.")

    # -- picking ---------------------------------------------------------

    def _pick_point(self, wx, wz):
        """Nearest HANDLE point index within tolerance, else
        None. Only handles can be grabbed — in a coarse span the
        interior points are geometry, not controls, until the
        portion is resegmented fine."""
        if self.session is None:
            return None
        tol = POINT_PICK_PX / self.camera.scale
        el = self.session.element
        best = None
        for i in self._handles:
            if i >= len(el.points):
                continue
            x, z = el.points[i]
            d = math.hypot(x - wx, z - wz)
            if d <= tol and (best is None or d < best[0]):
                best = (d, i)
        return best[1] if best else None

    def _pick_point_any(self, wx, wz):
        """Nearest point index (ANY point, handle or not) within
        tolerance — Shift+click speaks of points, not handles."""
        if self.session is None:
            return None
        tol = POINT_PICK_PX / self.camera.scale
        best = None
        for i, (x, z) in enumerate(self.session.element.points):
            d = math.hypot(x - wx, z - wz)
            if d <= tol and (best is None or d < best[0]):
                best = (d, i)
        return best[1] if best else None

    def _pick_segment(self, wx, wz):
        """(segment index, t, closest point) nearest within
        tolerance, else (None, 0, None)."""
        if self.session is None:
            return None, 0.0, None
        el = self.session.element
        tol = SEGMENT_PICK_PX / self.camera.scale
        best = None
        for k, (a, b) in enumerate(el.segments):
            d, t, cx, cz = point_segment_distance(
                wx, wz, el.points[a][0], el.points[a][1],
                el.points[b][0], el.points[b][1])
            if d <= tol and (best is None or d < best[0]):
                best = (d, k, t, (cx, cz))
        if best is None:
            return None, 0.0, None
        return best[1], best[2], best[3]

    def _context(self, rect):
        """The context dict for a view rect ({} when no provider
        or it fails — context is dressing; never break the
        editor)."""
        if self.context_provider is None:
            return {}
        try:
            data = self.context_provider(rect)
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def _pick_context_road(self, wx, wz):
        """The context road under a click: (category, index, pts)
        of the nearest road whose face reaches the click, else
        None. Used by click-switch — only a CLEAN click gets
        here, so a pan can never trigger a switch."""
        reach = max(SEGMENT_PICK_PX / self.camera.scale, 4.0)
        rect = (wx - reach - 20.0, wz - reach - 20.0,
                wx + reach + 20.0, wz + reach + 20.0)
        best = None
        for cat, idx, pts, width in self._context(rect).get(
                "roads", []):
            if len(pts) < 2:
                continue
            limit = width / 2.0 + reach
            for k in range(len(pts) - 1):
                d, _t, _cx, _cz = point_segment_distance(
                    wx, wz, pts[k][0], pts[k][1],
                    pts[k + 1][0], pts[k + 1][1])
                score = d - width / 2.0
                if d <= limit and (best is None
                                   or score < best[0]):
                    best = (score, cat, idx, pts)
        if best is None:
            return None
        return best[1], best[2], best[3]

    # -- gestures --------------------------------------------------------

    def _on_scroll(self, _widget, event):
        alloc = self.get_allocation()
        factor = 1.15 if event.direction == Gdk.ScrollDirection.UP \
            else (1 / 1.15 if event.direction
                  == Gdk.ScrollDirection.DOWN else None)
        if factor is None:
            # Smooth scrolling (touchpads): use the y delta's sign.
            _dx, dy = event.get_scroll_deltas()[1:]
            factor = 1.15 if dy < 0 else (1 / 1.15 if dy > 0 else 1.0)
        self.camera.zoom_at(event.x, event.y, factor,
                            alloc.width, alloc.height)
        self.invalidate()
        return True

    def _on_pinch(self, _gesture, scale):
        if self._pinch_base:
            alloc = self.get_allocation()
            self.camera.scale = max(
                0.02, min(400.0, self._pinch_base * scale))
            self.invalidate()

    def zoom_step(self, factor):
        """The + / − keys' zoom (around the view centre)."""
        alloc = self.get_allocation()
        self.camera.zoom_at(alloc.width / 2.0, alloc.height / 2.0,
                            factor, alloc.width, alloc.height)
        self.invalidate()

    def _in_rect(self, x, y, rect):
        """True when a screen point falls in an overlay rect."""
        return rect is not None and rect[0] <= x <= rect[0] + rect[2] \
            and rect[1] <= y <= rect[1] + rect[3]

    def _on_press(self, _widget, event):
        # Right-click: the app owns the context menu (it carries
        # the portion verbs — Resegment first among them).
        if event.button == 3:
            if self.on_context_menu is not None:
                self.on_context_menu(event)
            return True
        if event.button != 1:
            return False
        self.grab_focus()
        # The scale bar + compass are real UI elements overlaid
        # on the canvas: a press on one lands on IT, never
        # through it onto the map (Joshua's occlusion rule).
        if self._in_rect(event.x, event.y, self._scale_rect):
            self._toggle_measure()
            return True
        if self._in_rect(event.x, event.y, self._compass_rect):
            self.camera.heading = 0.0
            self.invalidate()
            self._say("Compass: north is up.")
            return True
        alloc = self.get_allocation()
        wx, wz = self.camera.screen_to_world(
            event.x, event.y, alloc.width, alloc.height)
        rotate = self.orbit_mode or (event.state & Gdk.ModifierType
                                     .CONTROL_MASK)
        shift = bool(event.state & Gdk.ModifierType.SHIFT_MASK)
        self._drag = {"start": (event.x, event.y),
                      "last": (event.x, event.y),
                      "cam": (self.camera.cx, self.camera.cz,
                              self.camera.heading),
                      "rotate": bool(rotate),
                      "moved": False,
                      "point": None,
                      "lasso": None}
        if rotate:
            return True
        # Shift+drag is the LASSO (Joshua's settled gesture) —
        # available in the base state and under any tool; it
        # never pans and never grabs a point. In measure mode a
        # Shift+drag just pans (measure owns plain clicks).
        if shift and not self.measure_mode \
                and self.session is not None:
            self._drag["lasso"] = [(wx, wz)]
            return True
        # Tool/base interaction begins on the press; a drag is
        # decided by motion (a point grab becomes a point move).
        if self.tool == "select" and not self.measure_mode:
            hit = self._pick_point(wx, wz)
            if hit is not None:
                self._drag["point"] = hit
                self.selected_point = hit
                self._selection_changed()
                self.invalidate()
        return True

    def _on_motion(self, _widget, event):
        alloc = self.get_allocation()
        wx, wz = self.camera.screen_to_world(
            event.x, event.y, alloc.width, alloc.height)
        self._hover_world = (wx, wz)
        if self._drag is None:
            return False
        drag = self._drag
        dx = event.x - drag["last"][0]
        dy = event.y - drag["last"][1]
        if abs(event.x - drag["start"][0]) + abs(event.y
                                                 - drag["start"][1]) > 3:
            drag["moved"] = True
        drag["last"] = (event.x, event.y)
        if drag["rotate"]:
            # Ctrl+drag (or ORBIT): spin the heading around centre.
            cx0, cz0, h0 = drag["cam"]
            total_dx = event.x - drag["start"][0]
            self.camera.heading = h0 + total_dx * 0.005
            self.invalidate()
        elif drag.get("lasso") is not None:
            # Collect the loop (thinned: a point every few px is
            # plenty of resolution for a hand-drawn line).
            path = drag["lasso"]
            lx, lz = path[-1]
            lsx, lsy = self.camera.world_to_screen(lx, lz,
                                                   alloc.width,
                                                   alloc.height)
            if math.hypot(event.x - lsx, event.y - lsy) >= 3:
                path.append((wx, wz))
            self.invalidate()
        elif drag.get("point") is not None and self.session is not None:
            # Dragging a point MOVES it (only that point changes).
            # The undo snapshot is taken once, before the drag's
            # first actual move.
            if not drag.get("snapshotted"):
                drag["snapshotted"] = True
                self._begin_change()
            self.session.element.move_point(drag["point"], wx, wz)
            self.invalidate()
        elif drag["moved"]:
            # Plain drag on empty ground pans the view: the camera
            # centre moves opposite the pointer, through the
            # heading rotation's inverse (Camera.screen_to_world's
            # matrix, transposed). A pan NEVER touches the
            # selection (suite law).
            c, s = math.cos(self.camera.heading), \
                math.sin(self.camera.heading)
            self.camera.cx -= (c * dx - s * dy) / self.camera.scale
            self.camera.cz -= (s * dx + c * dy) / self.camera.scale
            self.invalidate()
        return True

    def _on_release(self, _widget, event):
        if event.button != 1 or self._drag is None:
            return False
        drag, self._drag = self._drag, None
        alloc = self.get_allocation()
        wx, wz = self.camera.screen_to_world(
            event.x, event.y, alloc.width, alloc.height)
        if drag["rotate"]:
            return True
        if drag.get("lasso") is not None:
            self._finish_lasso(drag, alloc)
            return True
        if drag.get("point") is not None:
            # A press on a point with no drag = a selection; with a
            # drag, the move already happened live — commit it.
            if drag["moved"] and self.session is not None:
                self._edited(f"Moved point {drag['point'] + 1} to "
                             f"({wx:.1f}, {wz:.1f}) — only this "
                             f"piece changed.")
            return True
        if drag["moved"]:
            return True     # it was a pan; nothing else happens
        # A clean click (no drag): measure mode first, then the
        # armed tool acts.
        if self.measure_mode:
            self.measure_pts.append([wx, wz])
            total = self.measure_length()
            self._say(f"Measure: {total:.1f} m "
                      f"({total * 3.28084:.0f} ft) so far — click "
                      f"for another point, or click the scale "
                      f"bar to stop.")
            self.invalidate()
            return True
        self._tool_click(wx, wz)
        return True

    # -- the lasso ---------------------------------------------------------

    def _finish_lasso(self, drag, alloc):
        """
        A Shift+drag ends. A loop selects the PORTION of the open
        piece inside it: the contiguous span of its chain, ends
        at the outermost points the loop caught — everything
        between them is the section (the group selection: Delete
        removes it whole). The view zooms to fit the portion
        (Joshua's completion rule). A Shift+CLICK (the drag never
        became a loop) toggles one point in/out of the selection
        instead. Only the open element is ever read — no other
        road can be selected by a lasso here.
        """
        el = self.session.element
        path = drag["lasso"]
        # How far did the pointer actually travel on screen?
        sx, sy = drag["start"]
        travelled = 0.0
        prev = (sx, sy)
        for (px, pz) in path[1:]:
            cur = self.camera.world_to_screen(px, pz, alloc.width,
                                              alloc.height)
            travelled += math.hypot(cur[0] - prev[0],
                                    cur[1] - prev[1])
            prev = cur
        if len(path) < 3 or travelled < 8:
            # Shift+click: toggle the point under the click.
            wx, wz = path[0]
            hit = self._pick_point_any(wx, wz)
            if hit is not None:
                if hit in self.selected_points:
                    self.selected_points.discard(hit)
                    verb = "removed from"
                else:
                    self.selected_points.add(hit)
                    verb = "added to"
                self._say(f"Point {hit + 1} {verb} the selection "
                          f"({len(self.selected_points)} "
                          f"selected).")
                self._selection_changed()
            self.invalidate()
            return
        # The loop: which of the OPEN ELEMENT's points are in?
        inside = [i for i, (x, z) in enumerate(el.points)
                  if point_in_polygon(x, z, path)]
        if not inside:
            self._say("Lasso: no points of this piece inside the "
                      "loop — the focus is unchanged.")
            self.invalidate()
            return
        # The portion = the contiguous span, on the chain that
        # holds most of the caught points, from the outermost
        # caught point to the outermost.
        inside_set = set(inside)
        best = None
        for chain in el.chains():
            pos = [p for p, idx in enumerate(chain)
                   if idx in inside_set]
            if pos and (best is None or len(pos) > len(best[1])):
                best = (chain, pos)
        chain, positions = best
        lo, hi = min(positions), max(positions)
        self.focus_chain, self.focus_lo, self.focus_hi = \
            chain, lo, hi
        self.selected_points = set(chain[lo:hi + 1])
        self.selected_point = None
        n = len(self.selected_points)
        self._say(f"Lassoed a portion: {n} points selected "
                  f"together. Delete removes them as one section; "
                  f"right-click offers Resegment for fine work.")
        self._selection_changed()
        # Completion rule: the view zooms to fit the portion.
        xs = [p[0] for p in path]
        zs = [p[1] for p in path]
        pad = self.piece_width
        self.camera.fit_rect((min(xs) - pad, min(zs) - pad,
                              max(xs) + pad, max(zs) + pad),
                             alloc.width, alloc.height, margin=1.3)
        self.invalidate()

    def _selection_changed(self):
        """Selection/focus moved: the app refreshes its buttons
        and readouts."""
        if self.on_selection is not None:
            self.on_selection()

    def clear_selection(self):
        """Esc's clear: the point selection AND the focus go.
        (Density — the fine set — is a view state, not a
        selection; it stays.)"""
        self.selected_point = None
        self.selected_points = set()
        self.focus_chain = None
        self.focus_lo = self.focus_hi = None
        self._selection_changed()
        self.invalidate()

    def delete_selected_points(self):
        """
        Delete ALL selected points as ONE operation (one undo
        snapshot — the app snapshots once on _begin_change). The
        app's confirm (confirm_points) is asked first, matching
        the section deletion's ask-first pattern; single-point
        deletes stay immediate, as they always were. Section
        semantics live in Element.delete_points: segments
        touching the points go too, a middle run breaks the
        piece in two, an end run shortens it.
        """
        if self.session is None or not self.selected_points:
            self._say("Delete selected: nothing is selected — "
                      "Shift+drag a lasso around a portion first.")
            return
        el = self.session.element
        if len(self.selected_points) >= len(el.points):
            owner = getattr(el, "whole_delete_owner",
                            "the Map Editor's Delete")
            self._say("Delete selected: that is EVERY point of "
                      "the piece — deleting a whole piece is "
                      f"{owner}, not this. Lasso a smaller "
                      "portion.")
            return
        # Adapters that protect some points (a building's
        # corners, 1.3.0) preview the delete: nothing deletable
        # plus a reason refuses here, before the confirm and the
        # undo snapshot; a partial delete carries the note into
        # the outcome. The base element previews everything as
        # deletable, so the road flow is unchanged.
        deletable, note = el.delete_preview(
            sorted(self.selected_points))
        if not deletable:
            if note:
                self._say(note)
            return
        if self.confirm_points is not None and not \
                self.confirm_points(len(deletable)):
            self._say("Delete selected: cancelled — nothing "
                      "deleted.")
            return
        self._begin_change()
        deleted = el.delete_points(deletable)
        self.selected_points = set()
        self.selected_point = None
        self.focus_chain = None
        self.focus_lo = self.focus_hi = None
        self.reset_segmentation()
        self._selection_changed()
        msg = (f"Deleted {deleted} points together, with "
               f"their segments — one operation, one Undo "
               f"brings them all back.")
        if note:
            msg += " " + note
        self._edited(msg)

    # -- measure ---------------------------------------------------------

    def _toggle_measure(self):
        """The scale bar's click: enter or leave measure mode."""
        self.measure_mode = not self.measure_mode
        self.measure_pts = []
        if self.measure_mode:
            self._say("Measure: click along the map to lay down "
                      "a line — its length shows here. Click the "
                      "scale bar again to stop.")
        else:
            self._say("Measure off.")
        self.invalidate()

    def exit_measure(self):
        """Leave measure mode (Esc's first call)."""
        if self.measure_mode:
            self.measure_mode = False
            self.measure_pts = []
            self.invalidate()

    def measure_length(self):
        """The laid-down measure line's total length (metres)."""
        total = 0.0
        for a, b in zip(self.measure_pts, self.measure_pts[1:]):
            total += math.hypot(b[0] - a[0], b[1] - a[1])
        return total

    # -- the tools ---------------------------------------------------------

    def _begin_change(self):
        """Announce an imminent mutation (the app snapshots the
        element for Undo before we touch it)."""
        if self.on_snapshot is not None:
            self.on_snapshot()

    def _edited(self, status=None):
        """After any mutation: tell the app (dirty + info refresh),
        restill, and say what happened."""
        self.invalidate()
        if self.on_edit is not None:
            self.on_edit()
        if status and self.on_status is not None:
            self.on_status(status)

    def _tool_click(self, wx, wz):
        if self.session is None:
            return
        el = self.session.element
        tool = self.tool
        if tool == "select":
            hit = self._pick_point(wx, wz)
            if hit is not None:
                self.selected_point = hit
                if self.on_status is not None:
                    x, z = el.points[hit]
                    self.on_status(
                        f"Point {hit + 1} of {len(el.points)}"
                        f" — ({x:.1f}, {z:.1f}). Drag it to "
                        f"move it.")
                self._selection_changed()
                self.invalidate()
                return
            # A clean click on ANOTHER road switches the working
            # piece (the app saves the current piece first when
            # it has edits — Joshua's click-switch rule).
            road = self._pick_context_road(wx, wz)
            if road is not None and self.on_switch_request \
                    is not None:
                self.on_switch_request(*road)
                return
            # A clean click on empty ground clears the single
            # selection (a deliberate click — a PAN never does).
            if self.selected_point is not None:
                self.selected_point = None
                self._selection_changed()
            self.invalidate()
            return
        if tool == "add_point":
            self._click_add_point(wx, wz)
        elif tool == "del_point":
            hit = self._pick_point(wx, wz)
            if hit is None:
                self._say("Delete point: click a point to delete it.")
                return
            # Protected points (a building's corners) refuse in
            # the moment, before any snapshot (1.3.0).
            refusal = el.point_delete_refusal(hit)
            if refusal is not None:
                self._say(refusal)
                return
            self._begin_change()
            el.delete_point(hit)
            self.selected_point = None
            self.reset_segmentation()
            self._edited(f"Deleted point {hit + 1}. "
                         f"{len(el.points)} points remain.")
        elif tool == "add_segment":
            hit = self._pick_point(wx, wz)
            if hit is None:
                self._say("Add segment: click one point, then "
                          "another, to join them.")
                return
            if self._pending is None:
                self._pending = hit
                self._say(f"Add segment: point {hit + 1} chosen — "
                          f"click the point to join it to.")
                self.invalidate()
                return
            first, self._pending = self._pending, None
            if first != hit and el.segment_index(first, hit) is None:
                self._begin_change()
            if el.add_segment(first, hit):
                self.reset_segmentation()
                self._edited(f"Added a segment joining points "
                             f"{first + 1} and {hit + 1}.")
            else:
                self._say("Those points are already joined (or the "
                          "same point twice).")
                self.invalidate()
        elif tool == "del_segment":
            seg, _t, _c = self._pick_segment(wx, wz)
            if seg is None:
                self._say("Delete segment: click a segment to "
                          "delete only it.")
                return
            self._begin_change()
            el.delete_segment(seg)
            self.reset_segmentation()
            self._edited("Deleted one segment — only that segment. "
                         "The piece may now be in two parts.")
        elif tool == "del_section":
            self._click_delete_section(wx, wz)

    def _click_add_point(self, wx, wz):
        el = self.session.element
        # On a segment: split it where the click projects.
        seg, t, closest = self._pick_segment(wx, wz)
        if seg is not None:
            a, b = el.segments[seg]
            payload = None
            if el.payloads[a] is not None and el.payloads[b] is not None:
                # The adapter's interpolation rule, mirrored: the
                # new point carries the value the element already
                # has along this segment (for a road: its height —
                # carried, never edited; see detaildata).
                payload = el.payloads[a] + (el.payloads[b]
                                            - el.payloads[a]) * t
            self._begin_change()
            ni = el.add_point_on_segment(seg, closest[0], closest[1],
                                         payload=payload)
            self.selected_point = ni
            # Working here means this spot is now fine detail.
            self.fine_points.add(ni)
            self._compute_handles()
            self._edited(f"Added point {ni + 1} on the segment — "
                         f"the segment is now two.")
            return
        # On an endpoint: arm it; the NEXT ground click extends.
        hit = self._pick_point(wx, wz)
        if hit is not None and len(el.neighbours(hit)) <= 1:
            self._pending = hit
            self._say(f"Add point: end point {hit + 1} chosen — "
                      f"click where the new point goes.")
            self.invalidate()
            return
        if self._pending is not None:
            end, self._pending = self._pending, None
            payload = el.payloads[end]
            self._begin_change()
            ni = el.add_point_at_end(end, wx, wz, payload=payload)
            self.selected_point = ni
            self.fine_points.add(ni)
            self._compute_handles()
            self._edited(f"Added point {ni + 1}, extending the "
                         f"piece from point {end + 1}.")
            return
        self._say("Add point: click a segment to split it, or an "
                  "end point then the ground to extend the piece.")

    def _click_delete_section(self, wx, wz):
        el = self.session.element
        seg, _t, _c = self._pick_segment(wx, wz)
        if seg is None:
            self._say("Delete section: click the FIRST segment of "
                      "the section, then the LAST.")
            return
        # The chain the clicked segment belongs to, and the
        # segment's position within it.
        chains = el.chains()
        found = None
        for chain in chains:
            for pos in range(len(chain) - 1):
                if el.segment_index(chain[pos], chain[pos + 1]) == seg:
                    found = (chain, pos)
                    break
            if found:
                break
        if found is None:
            return
        chain, pos = found
        if self._pending is None:
            self._pending = (chain, pos)
            self._say("Delete section: first segment marked — "
                      "click the LAST segment of the section.")
            self.invalidate()
            return
        first_chain, first_pos = self._pending
        self._pending = None
        if first_chain != chain:
            self._say("Delete section: both segments must be on "
                      "the same part of the piece. Start again.")
            self.invalidate()
            return
        lo, hi = min(first_pos, pos), max(first_pos, pos)
        n_segs = hi - lo + 1
        n_pts = hi - lo  # interior points strictly between anchors
        if self.confirm_section is not None and not \
                self.confirm_section(max(n_pts, 0), n_segs):
            self._say("Delete section: cancelled — nothing deleted.")
            self.invalidate()
            return
        self._begin_change()
        deleted = el.delete_section(chain, lo, hi)
        self.selected_point = None
        self.reset_segmentation()
        self._edited(f"Deleted the section: {n_segs} segment(s) and "
                     f"{deleted} point(s) gone, face included — "
                     f"the ends join straight.")

    def _say(self, text):
        if self.on_status is not None:
            self.on_status(text)

    # -- painting ---------------------------------------------------------

    def render(self, cr, w, h):
        """Paint: grass, metre grid, water, buildings, the
        neighbourhood roads, the piece's face + segments + points,
        then tool overlays, then the compass + scale bar."""
        cr.set_source_rgb(*GROUND_COLOR)
        cr.paint()
        cam = self.camera
        rect = cam.view_rect_world(w, h)
        self._render_grid(cr, w, h, rect)
        context = self._context(rect)
        # Dressing under the roads: water, then buildings.
        for _kind, pts in context.get("water", []):
            self._fill_polygon(cr, pts, WATER_COLOR, w, h)
            self._stroke_polygon(cr, pts, WATER_EDGE, w, h, 1.0)
        buildings = context.get("buildings", [])
        for b in buildings:
            self._draw_building(cr, b, w, h,
                                edged=len(buildings) <= 800)
        # Neighbourhood roads (dim): runs in view only.
        for _cat, _idx, pts, width in context.get("roads", []):
            self._draw_road_runs(cr, pts, width, CONTEXT_COLOR,
                                 None, rect, w, h)
        if self.session is None:
            self._render_overlays(cr, w, h)
            return
        el = self.session.element
        # The piece's FACE first (its material surface), then the
        # centreline structure over it — chain by chain, run by
        # run, so only what the view shows is ever drawn.
        if getattr(self.session, "face_mode", "ribbon") \
                == "footprint":
            # A building page (1.3.0): the piece IS its footprint
            # — the filled ring in its own building colour, not a
            # ribbon around a centreline.
            self._draw_footprint(cr, w, h)
        else:
            for chain in el.chains():
                pts = [el.points[i] for i in chain]
                self._draw_road_runs(cr, pts, self.piece_width,
                                     FACE_COLOR, FACE_EDGE, rect,
                                     w, h)
        # The focused portion tints over the face.
        if self.focus_chain is not None and self.focus_lo is not None:
            span = [el.points[i] for i in
                    self.focus_chain[self.focus_lo:
                                     self.focus_hi + 1]]
            if len(span) >= 2:
                if getattr(self.session, "face_mode", "ribbon") \
                        == "footprint":
                    # The span is a stretch of the ring: tint the
                    # wedge between it and the building's centre.
                    bx = el.bounds()
                    face = span + [[(bx[0] + bx[2]) / 2.0,
                                    (bx[1] + bx[3]) / 2.0]]
                else:
                    face = ribbon_polygon(span, self.piece_width)
                if face:
                    self._fill_polygon_rgba(cr, face, FOCUS_TINT,
                                            w, h)
        # Selected runs: segments whose BOTH ends are selected.
        if self.selected_points:
            for a, b in el.segments:
                if a in self.selected_points \
                        and b in self.selected_points:
                    self._stroke_path(cr, [el.points[a],
                                           el.points[b]],
                                      SELECTED_RUN, w, h, 3.0)
        # Pending highlights (section ends / segment picks).
        if self._pending is not None and self.tool == "del_section" \
                and isinstance(self._pending, tuple):
            chain, pos = self._pending
            a, b = chain[pos], chain[pos + 1]
            self._stroke_path(cr, [el.points[a], el.points[b]],
                              SECTION_COLOR, w, h, 3.0)
        if self._pending is not None and self.tool in (
                "add_segment", "add_point") \
                and isinstance(self._pending, int):
            self._draw_point(cr, el.points[self._pending],
                             PENDING_COLOR, 8, w, h)
            if self._hover_world is not None and \
                    self.tool == "add_segment":
                self._stroke_path(
                    cr, [el.points[self._pending],
                         list(self._hover_world)],
                    PENDING_COLOR, w, h, 1.0)
        # The lasso being drawn.
        if self._drag is not None and self._drag.get("lasso"):
            path = self._drag["lasso"]
            if len(path) >= 2:
                self._fill_polygon_rgba(cr, [list(p) for p in path],
                                        LASSO_FILL, w, h)
                loop = [list(p) for p in path] + [list(path[0])]
                self._stroke_path(cr, loop, LASSO_COLOR, w, h, 2.0)
        # Measure line.
        if self.measure_pts:
            if len(self.measure_pts) >= 2:
                self._stroke_path(cr, self.measure_pts,
                                  MEASURE_COLOR, w, h, 2.0)
            for p in self.measure_pts:
                self._draw_point(cr, p, MEASURE_COLOR, 4, w, h)
        # Points: the handles (segmentation layer — coarse
        # boundaries in pale gold, fine points in gold), then the
        # selections over them.
        for i in sorted(self._handles):
            if i >= len(el.points) or i in self.selected_points \
                    or i == self.selected_point:
                continue
            color = POINT_FILL if i in self.fine_points \
                else HANDLE_COARSE_COLOR
            self._draw_point(cr, el.points[i], color, 6, w, h)
        for i in sorted(self.selected_points):
            if i < len(el.points):
                self._draw_point(cr, el.points[i], SELECTED_FILL, 7,
                                 w, h, ring=SELECTED_RING)
        if self.selected_point is not None \
                and self.selected_point < len(el.points):
            self._draw_point(cr, el.points[self.selected_point],
                             SELECTED_FILL, 8, w, h)
        self._render_overlays(cr, w, h)

    def _draw_road_runs(self, cr, pts, width, fill, edge, rect,
                        w, h):
        """Draw one road (face + paint) as the runs of it that
        cross the view — the render optimisation: a long road
        zoomed into detail costs only its visible points."""
        margin = width  # the face reaches half a width past the line
        for start, end in runs_in_view(pts, rect, margin):
            run = pts[start:end]
            if len(run) < 2:
                continue
            face = ribbon_polygon(run, width)
            if face:
                self._fill_polygon(cr, face, fill, w, h)
                if edge is not None:
                    self._stroke_polygon(cr, face, edge, w, h, 1.0)
            # The faded paint centreline (the game's roads carry
            # one; it also makes direction read at a glance).
            sp = self._to_screen(run, w, h)
            cr.set_source_rgb(*CENTRELINE_COLOR)
            cr.set_line_width(1.0)
            cr.set_dash([6.0, 6.0])
            cr.move_to(sp[0][0], sp[0][1])
            for p in sp[1:]:
                cr.line_to(p[0], p[1])
            cr.stroke()
            cr.set_dash([])

    def _draw_building(self, cr, b, w, h, edged=True):
        """One context building: its footprint rectangle in a
        muted building colour (chosen stably from its position +
        type, so a building keeps its colour between frames)."""
        x, z, bw, bd, _ht, btype = b
        color = self._building_color(x, z, btype)
        hw, hd = bw / 2.0, bd / 2.0
        corners = [[x - hw, z - hd], [x + hw, z - hd],
                   [x + hw, z + hd], [x - hw, z + hd]]
        self._fill_polygon(cr, corners, color, w, h)
        if edged:
            self._stroke_polygon(cr, corners, BUILDING_EDGE,
                                 w, h, 1.0)

    def _building_color(self, x, z, btype):
        """The stable colour _draw_building would give a building
        at (x, z) of this type — shared so the OPEN building (the
        footprint below, the overview) wears the very colour it
        wears as context."""
        return BUILDING_COLORS[
            (int(abs(x) // 10 + abs(z) // 10) + btype * 3)
            % len(BUILDING_COLORS)]

    def _draw_footprint(self, cr, w, h):
        """The open building (1.3.0): its ring filled in its own
        building colour with a clear edge — the same presentation
        the building has as context, promoted to the piece."""
        el = self.session.element
        chains = el.chains()
        if not chains:
            return
        ring = [el.points[i] for i in chains[0]]
        if len(ring) >= 2 and ring[0] == ring[-1]:
            ring = ring[:-1]        # the closing repeat
        if len(ring) < 3:
            return
        bx = el.bounds()
        color = self._building_color((bx[0] + bx[2]) / 2.0,
                                     (bx[1] + bx[3]) / 2.0,
                                     getattr(self.session,
                                             "building_type", 0))
        self._fill_polygon(cr, ring, color, w, h)
        self._stroke_polygon(cr, ring, FACE_EDGE, w, h, 1.5)

    def _render_grid(self, cr, w, h, rect):
        """A faint 10 m grid (50 m when zoomed out) — scale sense
        for detail work; drawn only when lines are far enough apart
        on screen to read. Joshua likes the grid: it stays, over
        the grass, in the darker grass green."""
        step = 10.0
        if step * self.camera.scale < 14:
            step = 50.0
        if step * self.camera.scale < 14:
            return
        cr.set_source_rgb(*GRID_COLOR)
        cr.set_line_width(1)
        x = math.floor(rect[0] / step) * step
        while x <= rect[2]:
            a = self.camera.world_to_screen(x, rect[1], w, h)
            b = self.camera.world_to_screen(x, rect[3], w, h)
            cr.move_to(a[0], a[1])
            cr.line_to(b[0], b[1])
            cr.stroke()
            x += step
        z = math.floor(rect[1] / step) * step
        while z <= rect[3]:
            a = self.camera.world_to_screen(rect[0], z, w, h)
            b = self.camera.world_to_screen(rect[2], z, w, h)
            cr.move_to(a[0], a[1])
            cr.line_to(b[0], b[1])
            cr.stroke()
            z += step

    # -- the compass + scale bar -----------------------------------------

    def _render_overlays(self, cr, w, h):
        """Compass bottom-right, scale bar bottom-left (Joshua's
        placements). Both record their hit-rects: they are real
        UI elements, and presses land on them, not through."""
        # -- scale bar (bottom-left) --
        bx, by = 12, h - 26
        _len, label, px = scale_choice(self.camera.scale)
        bar_w = max(int(round(px)), 8)
        bar_h = 6
        self._scale_rect = (bx - 4, by - 14, bar_w + 8, 30)
        cr.set_source_rgba(0.0, 0.0, 0.0, 0.45)
        cr.rectangle(bx - 4, by - 14, bar_w + 8, 30)
        cr.fill()
        cr.set_source_rgb(1.0, 1.0, 1.0)
        cr.rectangle(bx, by, bar_w, bar_h)
        cr.fill()
        cr.set_source_rgb(0.15, 0.15, 0.15)
        cr.rectangle(bx, by, bar_w / 2.0, bar_h)
        cr.fill()
        cr.set_source_rgb(1.0, 1.0, 1.0)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(11)
        text = label + ("  ·  MEASURE" if self.measure_mode else "")
        cr.move_to(bx, by - 4)
        cr.show_text(text)
        # -- compass (bottom-right) --
        cxp, cyp, r = w - 34, h - 34, 23
        self._compass_rect = (cxp - r - 3, cyp - r - 3,
                              2 * (r + 3), 2 * (r + 3))
        cr.set_source_rgba(0.0, 0.0, 0.0, 0.45)
        cr.arc(cxp, cyp, r, 0, 2 * math.pi)
        cr.fill()
        cr.set_source_rgb(0.9, 0.9, 0.9)
        cr.set_line_width(1.2)
        cr.arc(cxp, cyp, r, 0, 2 * math.pi)
        cr.stroke()
        # North: where world -z projects on this view.
        ox, oy = self.camera.world_to_screen(self.camera.cx,
                                             self.camera.cz, w, h)
        nx, ny = self.camera.world_to_screen(self.camera.cx,
                                             self.camera.cz - 100.0,
                                             w, h)
        vx, vy = nx - ox, ny - oy
        norm = math.hypot(vx, vy) or 1.0
        vx, vy = vx / norm, vy / norm
        cr.set_source_rgb(1.0, 0.35, 0.30)
        cr.set_line_width(2.0)
        cr.move_to(cxp - vx * (r - 8), cyp - vy * (r - 8))
        cr.line_to(cxp + vx * (r - 5), cyp + vy * (r - 5))
        cr.stroke()
        cr.set_source_rgb(1.0, 1.0, 1.0)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(10)
        tx = cxp + vx * (r - 15) - 3
        ty = cyp + vy * (r - 15) + 3
        cr.move_to(tx, ty)
        cr.show_text("N")

    # -- small paint helpers ------------------------------------------------

    def _to_screen(self, pts, w, h):
        return [self.camera.world_to_screen(p[0], p[1], w, h)
                for p in pts]

    def _fill_polygon(self, cr, pts, color, w, h):
        if len(pts) < 3:
            return
        sp = self._to_screen(pts, w, h)
        cr.set_source_rgb(*color)
        cr.move_to(sp[0][0], sp[0][1])
        for p in sp[1:]:
            cr.line_to(p[0], p[1])
        cr.close_path()
        cr.fill()

    def _fill_polygon_rgba(self, cr, pts, color, w, h):
        if len(pts) < 3:
            return
        sp = self._to_screen(pts, w, h)
        cr.set_source_rgba(*color)
        cr.move_to(sp[0][0], sp[0][1])
        for p in sp[1:]:
            cr.line_to(p[0], p[1])
        cr.close_path()
        cr.fill()

    def _stroke_polygon(self, cr, pts, color, w, h, width_px):
        if len(pts) < 3:
            return
        sp = self._to_screen(pts, w, h)
        cr.set_source_rgb(*color)
        cr.set_line_width(width_px)
        cr.move_to(sp[0][0], sp[0][1])
        for p in sp[1:]:
            cr.line_to(p[0], p[1])
        cr.close_path()
        cr.stroke()

    def _stroke_path(self, cr, pts, color, w, h, width_px):
        if len(pts) < 2:
            return
        sp = self._to_screen(pts, w, h)
        cr.set_source_rgb(*color)
        cr.set_line_width(width_px)
        cr.move_to(sp[0][0], sp[0][1])
        for p in sp[1:]:
            cr.line_to(p[0], p[1])
        cr.stroke()

    def _draw_point(self, cr, p, color, radius, w, h, ring=None):
        sx, sy = self.camera.world_to_screen(p[0], p[1], w, h)
        cr.set_source_rgb(*(ring if ring is not None else POINT_RING))
        cr.arc(sx, sy, radius + 2, 0, 2 * math.pi)
        cr.fill()
        cr.set_source_rgb(*color)
        cr.arc(sx, sy, radius, 0, 2 * math.pi)
        cr.fill()


class OverviewCanvas(StillCanvas):
    """
    The small map (see the module docstring): the whole piece in
    its coloured neighbourhood, plus a rectangle for the working
    canvas's current view. Clicking (or dragging) in it moves the
    working view's centre. App-wired: session, context_provider
    (same as the working canvas's), piece_width, main_camera (the
    working canvas's Camera), on_jump(x, z).
    """

    def __init__(self):
        super().__init__()
        self.camera = Camera()
        self.session = None
        self.context_provider = None
        self.piece_width = DEFAULT_ROAD_WIDTH
        self.main_camera = None
        self.main_view_rect = None  # callable -> the working rect
        self.on_jump = None
        self._dragging = False
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK
                        | Gdk.EventMask.BUTTON_RELEASE_MASK
                        | Gdk.EventMask.POINTER_MOTION_MASK
                        | Gdk.EventMask.ENTER_NOTIFY_MASK
                        | Gdk.EventMask.LEAVE_NOTIFY_MASK)
        self.connect("button-press-event", self._on_press)
        self.connect("button-release-event",
                     lambda *_a: setattr(self, "_dragging", False))
        self.connect("motion-notify-event", self._on_motion)

    def fit(self):
        """Frame the piece (plus a ring of neighbourhood)."""
        if self.session is None:
            return
        bounds = self.session.element.bounds()
        if bounds is None:
            return
        alloc = self.get_allocation()
        pad = max(self.piece_width * 4,
                  (bounds[2] - bounds[0]) * 0.15 + 10,
                  (bounds[3] - bounds[1]) * 0.15 + 10)
        self.camera.fit_rect(
            (bounds[0] - pad, bounds[1] - pad,
             bounds[2] + pad, bounds[3] + pad),
            max(alloc.width, 2), max(alloc.height, 2), margin=1.1)
        self.invalidate()

    def _jump(self, event):
        alloc = self.get_allocation()
        wx, wz = self.camera.screen_to_world(
            event.x, event.y, alloc.width, alloc.height)
        if self.on_jump is not None:
            self.on_jump(wx, wz)

    def _on_press(self, _widget, event):
        if event.button == 1:
            self._dragging = True
            self._jump(event)
        return True

    def _on_motion(self, _widget, event):
        if self._dragging:
            self._jump(event)
        return True

    def _context(self, rect):
        """The context dict for a view rect ({} on any failure —
        dressing never breaks the editor)."""
        if self.context_provider is None:
            return {}
        try:
            data = self.context_provider(rect)
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def render(self, cr, w, h):
        """The small map in colour: grass, water, buildings, the
        neighbourhood's roads dim, the piece's face bright, and
        the working view's rectangle in gold."""
        cr.set_source_rgb(*GROUND_COLOR)
        cr.paint()
        rect = self.camera.view_rect_world(w, h)
        context = self._context(rect)
        for _kind, pts in context.get("water", []):
            sp = [self.camera.world_to_screen(p[0], p[1], w, h)
                  for p in pts]
            if len(sp) < 3:
                continue
            cr.set_source_rgb(*WATER_COLOR)
            cr.move_to(sp[0][0], sp[0][1])
            for p in sp[1:]:
                cr.line_to(p[0], p[1])
            cr.close_path()
            cr.fill()
        for b in context.get("buildings", []):
            x, z, bw, bd = b[0], b[1], b[2], b[3]
            color = BUILDING_COLORS[
                (int(abs(x) // 10 + abs(z) // 10) + b[5] * 3)
                % len(BUILDING_COLORS)]
            hw, hd = bw / 2.0, bd / 2.0
            corners = [[x - hw, z - hd], [x + hw, z - hd],
                       [x + hw, z + hd], [x - hw, z + hd]]
            sp = [self.camera.world_to_screen(p[0], p[1], w, h)
                  for p in corners]
            cr.set_source_rgb(*color)
            cr.move_to(sp[0][0], sp[0][1])
            for p in sp[1:]:
                cr.line_to(p[0], p[1])
            cr.close_path()
            cr.fill()
        for _cat, _idx, pts, width in context.get("roads", []):
            for start, end in runs_in_view(pts, rect, width):
                face = ribbon_polygon(pts[start:end], width)
                if not face:
                    continue
                sp = [self.camera.world_to_screen(p[0], p[1], w, h)
                      for p in face]
                cr.set_source_rgb(*CONTEXT_COLOR)
                cr.move_to(sp[0][0], sp[0][1])
                for p in sp[1:]:
                    cr.line_to(p[0], p[1])
                cr.close_path()
                cr.fill()
        if self.session is not None:
            el = self.session.element
            if getattr(self.session, "face_mode", "ribbon") \
                    == "footprint":
                # A building page (1.3.0): the filled footprint in
                # its building colour (the formula the context
                # buildings above use), not an asphalt ribbon.
                chains = el.chains()
                ring = [el.points[i] for i in chains[0]] \
                    if chains else []
                if len(ring) >= 2 and ring[0] == ring[-1]:
                    ring = ring[:-1]
                if len(ring) >= 3:
                    bx = el.bounds()
                    cx, cz = (bx[0] + bx[2]) / 2.0, \
                        (bx[1] + bx[3]) / 2.0
                    color = BUILDING_COLORS[
                        (int(abs(cx) // 10 + abs(cz) // 10)
                         + getattr(self.session, "building_type",
                                   0) * 3)
                        % len(BUILDING_COLORS)]
                    sp = [self.camera.world_to_screen(
                        p[0], p[1], w, h) for p in ring]
                    cr.set_source_rgb(*color)
                    cr.move_to(sp[0][0], sp[0][1])
                    for p in sp[1:]:
                        cr.line_to(p[0], p[1])
                    cr.close_path()
                    cr.fill()
            else:
                for chain in el.chains():
                    pts = [el.points[i] for i in chain]
                    for start, end in runs_in_view(pts, rect,
                                                   self.piece_width):
                        face = ribbon_polygon(pts[start:end],
                                              self.piece_width)
                        if not face:
                            continue
                        sp = [self.camera.world_to_screen(
                            p[0], p[1], w, h) for p in face]
                        cr.set_source_rgb(*FACE_COLOR)
                        cr.move_to(sp[0][0], sp[0][1])
                        for p in sp[1:]:
                            cr.line_to(p[0], p[1])
                        cr.close_path()
                        cr.fill()
        # The working view's rectangle.
        if self.main_view_rect is not None:
            rect2 = self.main_view_rect()
            corners = [(rect2[0], rect2[1]), (rect2[2], rect2[1]),
                       (rect2[2], rect2[3]), (rect2[0], rect2[3])]
            sp = [self.camera.world_to_screen(p[0], p[1], w, h)
                  for p in corners]
            cr.set_source_rgb(0.95, 0.80, 0.25)
            cr.set_line_width(1.5)
            cr.move_to(sp[0][0], sp[0][1])
            for p in sp[1:]:
                cr.line_to(p[0], p[1])
            cr.close_path()
            cr.stroke()
