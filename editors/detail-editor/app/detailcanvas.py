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
  handles) over a dim neighbourhood of the surrounding pieces.
  Holds the camera (pan / zoom / heading) and the editing tools.

  OverviewCanvas — the small map: the piece in its neighbourhood
  with a rectangle for the working canvas's view; clicking or
  dragging in it moves the working view.

UNIVERSAL VIEWPORT CONTROLS (Joshua's suite law): drag pans,
wheel zooms, + / − keys zoom (the window forwards key presses),
Ctrl+drag rotates; touch: one-finger drag pans, pinch zooms, and
the ORBIT toggle (the app's button) makes a drag rotate instead —
phones have no Ctrl key.

The camera: centre (cx, cz) in world units, scale in screen px per
world unit, heading in radians. World z runs DOWN-screen at
heading 0 (south), matching the suite's map views.

Joshua's rule: all code commented.
"""

import math

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gtk, Gdk, GLib
import cairo

from element import point_segment_distance, ribbon_polygon

# Category ribbon widths in world units — the suite's table
# (suite_core.viewport3d carries the same numbers for its 3D view;
# visual only, gameplay widths live in the game).
ROAD_WIDTHS = {"interstate": 16.0, "highway": 14.0,
               "major_artery": 11.0, "minor_artery": 9.0,
               "local": 7.0}
DEFAULT_ROAD_WIDTH = 7.0

# Colours (cairo RGB). The face is asphalt — a street face carries
# its material, drawn as the road surface, not a line on a map.
FACE_COLOR = (0.23, 0.23, 0.26)
FACE_EDGE = (0.55, 0.55, 0.60)
CONTEXT_COLOR = (0.16, 0.16, 0.19)
CONTEXT_EDGE = (0.30, 0.30, 0.34)
GROUND_COLOR = (0.07, 0.08, 0.07)
GRID_COLOR = (0.13, 0.14, 0.13)
POINT_FILL = (0.95, 0.80, 0.25)
POINT_RING = (0.10, 0.10, 0.10)
SELECTED_FILL = (1.0, 0.55, 0.15)
PENDING_COLOR = (0.35, 0.75, 1.0)
SECTION_COLOR = (1.0, 0.30, 0.25)

# Screen-space pick tolerances (px): generous enough for a finger
# or a tired hand at 2 AM, tight enough to mean the nearest thing.
POINT_PICK_PX = 11
SEGMENT_PICK_PX = 9


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
        context_provider:  callable(view_rect) -> [(pts, width)]
                           for the neighbourhood (dim, underlay)
        piece_width:       ribbon width of the open piece
        on_edit:           callable() after any mutation
        on_status:         callable(text) for the status bar
        confirm_section:   callable(n_points, n_segments) -> bool,
                           asked before a section deletion lands
    """

    # The tool names (the toolbar's vocabulary). "select" is the
    # base state the app OPENS in — pan/zoom/select, with point
    # dragging as the move — not an armed tool.
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
        self.tool = "select"
        self.orbit_mode = False     # the touch face of Ctrl+drag
        self.selected_point = None  # point index or None
        self._drag = None           # in-flight drag state dict
        self._pending = None        # tool's first pick (point/seg)
        self._hover_world = None    # last pointer world position
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
        self._pending = None
        self._drag = None
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
        two-pick operation is abandoned."""
        if tool not in self.TOOLS:
            tool = "select"
        self.tool = tool
        self._pending = None
        self.invalidate()

    # -- picking ---------------------------------------------------------

    def _pick_point(self, wx, wz):
        """Nearest point index within tolerance, else None."""
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

    def _on_press(self, _widget, event):
        if event.button != 1:
            return False
        self.grab_focus()
        alloc = self.get_allocation()
        wx, wz = self.camera.screen_to_world(
            event.x, event.y, alloc.width, alloc.height)
        rotate = self.orbit_mode or (event.state & Gdk.ModifierType
                                     .CONTROL_MASK)
        self._drag = {"start": (event.x, event.y),
                      "last": (event.x, event.y),
                      "cam": (self.camera.cx, self.camera.cz,
                              self.camera.heading),
                      "rotate": bool(rotate),
                      "moved": False,
                      "point": None}
        if rotate:
            return True
        # Tool/base interaction begins on the press; a drag is
        # decided by motion (a point grab becomes a point move).
        if self.tool == "select":
            hit = self._pick_point(wx, wz)
            if hit is not None:
                self._drag["point"] = hit
                self.selected_point = hit
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
            # matrix, transposed).
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
        # A clean click (no drag): the armed tool acts.
        self._tool_click(wx, wz)
        return True

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
            self.selected_point = hit
            if hit is not None and self.on_status is not None:
                x, z = el.points[hit]
                self.on_status(f"Point {hit + 1} of {len(el.points)}"
                               f" — ({x:.1f}, {z:.1f}). Drag it to "
                               f"move it.")
            self.invalidate()
            return
        if tool == "add_point":
            self._click_add_point(wx, wz)
        elif tool == "del_point":
            hit = self._pick_point(wx, wz)
            if hit is None:
                self._say("Delete point: click a point to delete it.")
                return
            self._begin_change()
            el.delete_point(hit)
            self.selected_point = None
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
        self._edited(f"Deleted the section: {n_segs} segment(s) and "
                     f"{deleted} point(s) gone, face included — "
                     f"the ends join straight.")

    def _say(self, text):
        if self.on_status is not None:
            self.on_status(text)

    # -- painting ---------------------------------------------------------

    def render(self, cr, w, h):
        """Paint: ground, metre grid, neighbourhood, the piece's
        face + segments + points, then tool overlays."""
        cr.set_source_rgb(*GROUND_COLOR)
        cr.paint()
        cam = self.camera
        rect = cam.view_rect_world(w, h)
        self._render_grid(cr, w, h, rect)
        # Neighbourhood (dim): the surrounding pieces' ribbons.
        if self.context_provider is not None:
            try:
                for pts, width in self.context_provider(rect):
                    self._stroke_ribbon(cr, pts, width,
                                        CONTEXT_COLOR, CONTEXT_EDGE,
                                        w, h)
            except Exception:
                pass  # context is dressing; never break the editor
        if self.session is None:
            return
        el = self.session.element
        # The piece's FACE first (its material surface), then the
        # centreline structure over it.
        for chain in el.chains():
            pts = [el.points[i] for i in chain]
            face = ribbon_polygon(pts, self.piece_width)
            if face:
                self._fill_polygon(cr, face, FACE_COLOR, w, h)
                self._stroke_polygon(cr, face, FACE_EDGE, w, h, 1.0)
            self._stroke_path(cr, pts, (0.75, 0.75, 0.80), w, h, 1.2)
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
        # Points: the handles.
        for i, p in enumerate(el.points):
            if i == self.selected_point:
                self._draw_point(cr, p, SELECTED_FILL, 8, w, h)
            else:
                self._draw_point(cr, p, POINT_FILL, 6, w, h)

    def _render_grid(self, cr, w, h, rect):
        """A faint 10 m grid (50 m when zoomed out) — scale sense
        for detail work; drawn only when lines are far enough apart
        on screen to read."""
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

    # -- small paint helpers ------------------------------------------------

    def _to_screen(self, pts, w, h):
        return [self.camera.world_to_screen(p[0], p[1], w, h)
                for p in pts]

    def _stroke_ribbon(self, cr, pts, width, fill, edge, w, h):
        face = ribbon_polygon(pts, width)
        if face:
            self._fill_polygon(cr, face, fill, w, h)

    def _fill_polygon(self, cr, pts, color, w, h):
        sp = self._to_screen(pts, w, h)
        cr.set_source_rgb(*color)
        cr.move_to(sp[0][0], sp[0][1])
        for p in sp[1:]:
            cr.line_to(p[0], p[1])
        cr.close_path()
        cr.fill()

    def _stroke_polygon(self, cr, pts, color, w, h, width_px):
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

    def _draw_point(self, cr, p, color, radius, w, h):
        sx, sy = self.camera.world_to_screen(p[0], p[1], w, h)
        cr.set_source_rgb(*POINT_RING)
        cr.arc(sx, sy, radius + 2, 0, 2 * math.pi)
        cr.fill()
        cr.set_source_rgb(*color)
        cr.arc(sx, sy, radius, 0, 2 * math.pi)
        cr.fill()


class OverviewCanvas(StillCanvas):
    """
    The small map (see the module docstring): the whole piece in
    its neighbourhood, plus a rectangle for the working canvas's
    current view. Clicking (or dragging) in it moves the working
    view's centre. App-wired: session, context_provider (same as
    the working canvas's), piece_width, main_camera (the working
    canvas's Camera), on_jump(x, z).
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

    def render(self, cr, w, h):
        cr.set_source_rgb(*GROUND_COLOR)
        cr.paint()
        rect = self.camera.view_rect_world(w, h)
        if self.context_provider is not None:
            try:
                for pts, width in self.context_provider(rect):
                    face = ribbon_polygon(pts, width)
                    if face:
                        sp = [self.camera.world_to_screen(
                            p[0], p[1], w, h) for p in face]
                        cr.set_source_rgb(*CONTEXT_COLOR)
                        cr.move_to(sp[0][0], sp[0][1])
                        for p in sp[1:]:
                            cr.line_to(p[0], p[1])
                        cr.close_path()
                        cr.fill()
            except Exception:
                pass
        if self.session is not None:
            el = self.session.element
            for chain in el.chains():
                pts = [el.points[i] for i in chain]
                face = ribbon_polygon(pts, self.piece_width)
                if face:
                    sp = [self.camera.world_to_screen(p[0], p[1], w, h)
                          for p in face]
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
