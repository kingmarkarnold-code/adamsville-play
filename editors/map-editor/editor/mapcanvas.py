#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) — Cairo canvas widget.

GTK DrawingArea subclass that renders roads and zones with Cairo.
Handles pan (drag), zoom (wheel), and tool interactions.

Joshua's rule: all code commented.
"""

import copy
import math
import sys
import threading
import time
from pathlib import Path
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib

from data import (ROAD_STYLE, WORLD_W, WORLD_H, WORLD_X0, WORLD_Z0,
                  save_zone_edit, zone_bbox,
                    normalize_category, CATEGORY_ORDER, CATEGORY_LABELS,
                    DIVIDABLE_CATEGORIES, DIVIDER_TYPES)

# Merge/Join geometry (1.9.10): the segment-based draw-back and
# the smart formed-section join live in their own pure module
# (mergejoin.py) so the preview and the commit share one core.
import mergejoin

# Shared canvas helpers (pan/zoom math, hit testing). All suite apps
# install the same file; fall back to local copies if it is missing
# (e.g. running from source without installing). Joshua 2026-10-11:
# map functions must not be rewritten per app.
for _suite_path in ("/usr/share/adamsville-suite",
                    str(Path.home() / ".local" / "share" / "adamsville-suite")):
    if _suite_path not in sys.path:
        sys.path.insert(0, _suite_path)
try:
    from adamsville_suite_canvas import point_in_polygon
    _SHARED_PIP = True
except ImportError:
    _SHARED_PIP = False

try:
    from adamsville_suite_canvas import Camera2D as _SharedCamera2D
except ImportError:
    _SharedCamera2D = None


def _camera_supports_rotation(cls):
    """
    Probe a Camera2D copy for the 1.9.8 rotation contract.

    Linked viewpoints (Joshua 2026-10-18) made ROTATION part of the
    camera: one shared heading that every pane reads. Suite copies
    of adamsville_suite_canvas installed before 1.9.8 have no
    rotation attribute at all. Constructing a throwaway instance is
    the honest test — the class is plain numbers, no GTK.
    """
    if cls is None:
        return False
    try:
        return hasattr(cls(), "rotation")
    except Exception:
        return False


if not _SHARED_PIP:
    # -- Local fallback (only used if the shared module is missing) --

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


class _LocalCamera2D:
    """
    Camera-centered 2D pan/zoom/rotate controller (bundled copy).

    The camera looks at world point (cam_x, cam_y); zoom is screen
    pixels per world unit; rotation is the view heading in DEGREES
    CLOCKWISE on screen (0 = the world's -z edge at the top of the
    screen, as the editor has always drawn it; 90 = that edge at
    the right). Every transform below honours rotation, so any
    view that draws through this camera — the main canvas, the
    elevation map, the satellite viewpoint — shows the same world
    turned the same way. That is the whole of the 1.9.8 linked-
    viewpoints design: ONE camera, many panes, no private copies
    that can drift apart.

    Rotation math (screen coords, y down): a world offset (dx, dz)
    from the camera centre lands on screen at
        (dx*cos - dz*sin, dx*sin + dz*cos) * zoom
    which turns world features clockwise as rotation grows, and
    screen_to_world applies the exact inverse.
    """

    def __init__(self, zoom=0.06, min_zoom=0.02, max_zoom=40.0):
        self.cam_x = 0.0
        self.cam_y = 0.0
        self.zoom = zoom
        self.min_zoom = min_zoom
        self.max_zoom = max_zoom
        # View heading, degrees clockwise on screen, kept in
        # [0, 360) by set_rotation().
        self.rotation = 0.0

    # -- rotation -------------------------------------------------

    def set_rotation(self, deg):
        """Set the heading, normalized into [0, 360)."""
        self.rotation = float(deg) % 360.0

    def rotate_by(self, delta_deg):
        """Turn the view by delta degrees (clockwise positive)."""
        self.set_rotation(self.rotation + float(delta_deg))

    def _rot(self):
        """(cos, sin) of the current heading."""
        rad = math.radians(self.rotation)
        return math.cos(rad), math.sin(rad)

    # -- transforms -------------------------------------------------

    def world_to_screen(self, wx, wz, view_w, view_h):
        dx = wx - self.cam_x
        dz = wz - self.cam_y
        c, s = self._rot()
        return ((dx * c - dz * s) * self.zoom + view_w / 2,
                (dx * s + dz * c) * self.zoom + view_h / 2)

    def screen_to_world(self, sx, sy, view_w, view_h):
        rx = (sx - view_w / 2) / self.zoom
        ry = (sy - view_h / 2) / self.zoom
        c, s = self._rot()
        return (rx * c + ry * s + self.cam_x,
                -rx * s + ry * c + self.cam_y)

    def zoom_at(self, sx, sy, factor, view_w, view_h):
        """Zoom keeping the world point under (sx, sy) pinned there.
        Works at any heading because it round-trips through the
        two transforms above."""
        wx0, wz0 = self.screen_to_world(sx, sy, view_w, view_h)
        self.zoom = max(self.min_zoom,
                        min(self.max_zoom, self.zoom * factor))
        wx1, wz1 = self.screen_to_world(sx, sy, view_w, view_h)
        self.cam_x += wx0 - wx1
        self.cam_y += wz0 - wz1

    def _screen_delta_to_world(self, dx, dy):
        """A screen-pixel delta expressed in world units (the
        inverse rotation, unzoomed). Dragging by (dx, dy) screen
        pixels moves the PICTURE by this much world travel."""
        c, s = self._rot()
        return ((dx * c + dy * s) / self.zoom,
                (-dx * s + dy * c) / self.zoom)

    def pan_from(self, start_cam_x, start_cam_y, dx, dy):
        """Pan from a drag start: the picture follows the cursor,
        so the camera moves opposite the drag delta — at any
        heading, the delta is first turned into world axes."""
        wdx, wdz = self._screen_delta_to_world(dx, dy)
        self.cam_x = start_cam_x - wdx
        self.cam_y = start_cam_y - wdz

    def pan_by(self, dx, dy):
        """Incremental pan by a screen-pixel delta."""
        wdx, wdz = self._screen_delta_to_world(dx, dy)
        self.cam_x -= wdx
        self.cam_y -= wdz

    def move_view_by(self, dx, dy):
        """
        Shift the CAMERA by the world equivalent of the screen
        vector (dx, dy): the rendered picture then translates by
        (-dx, -dy) screen pixels. Used to centre a fitted picture
        in a sub-band of the view (e.g. below the delete bar) at
        any heading.
        """
        wdx, wdz = self._screen_delta_to_world(dx, dy)
        self.cam_x += wdx
        self.cam_y += wdz

    def fit_rect(self, view_w, view_h, x0, z0, x1, z1, margin=1.05):
        """
        Centre on the rect and zoom so the WHOLE rect is visible
        at the current heading: the rect's corners are rotated
        first, and the fit uses the rotated extents. At rotation 0
        this is exactly the pre-1.9.8 fit.
        """
        if view_w <= 0 or view_h <= 0:
            return
        cx = (x0 + x1) / 2
        cy = (z0 + z1) / 2
        c, s = self._rot()
        hw = hh = 0.0
        for px in (x0, x1):
            for pz in (z0, z1):
                dx, dz = px - cx, pz - cy
                hw = max(hw, abs(dx * c - dz * s))
                hh = max(hh, abs(dx * s + dz * c))
        w = max(1.0, 2 * hw * margin)
        h = max(1.0, 2 * hh * margin)
        self.zoom = min(view_w / w, view_h / h)
        self.cam_x = cx
        self.cam_y = cy

    def get_viewport(self, view_w, view_h):
        """
        Axis-aligned world rect covering the view: the four
        screen corners turned back into world coords. Under
        rotation this is a (conservative) superset of the visible
        area — safe for culling, which is its job.
        """
        corners = [self.screen_to_world(sx, sy, view_w, view_h)
                   for sx in (0, view_w) for sy in (0, view_h)]
        xs = [p[0] for p in corners]
        zs = [p[1] for p in corners]
        return min(xs), min(zs), max(xs), max(zs)


# The camera class the canvas actually uses: the shared suite copy
# when it is CURRENT (carries rotation), otherwise the bundled
# rotation-capable copy above. Linked viewpoints made rotation
# part of the camera contract; a stale shared copy installed by an
# older suite app must neither take rotation away nor crash on it,
# so it is passed over until the suite copy catches up — the same
# doctrine as the min_zoom pin in MapCanvas.__init__ (1.9.6).
Camera2D = (_SharedCamera2D if _camera_supports_rotation(_SharedCamera2D)
            else _LocalCamera2D)
_SHARED_CANVAS = _SHARED_PIP


# Backwards-compatible alias: older code in this file called the local
# ray-casting helper _point_in_polygon. It now resolves to the shared
# implementation (or the fallback above).
_point_in_polygon = point_in_polygon


# Lowest zoom the camera may use (screen pixels per world unit).
# 1.9.6: this floor MUST be small enough that the whole converted
# world fits the canvas at once. Fitting the world needs
# zoom ~= min(view_w / WORLD_W, view_h / WORLD_H); at 1366x768 the
# fit lands near 0.017 — BELOW the old 0.02 floor — so with the old
# floor the whole-world fit was unreachable by wheel: the first
# zoom-out gesture clamped UP to 0.02, jumping the view IN and
# pushing the world's far edges (north Mableton/Adamsville, south
# Riverdale) out of the frame. 0.005 fits the whole world in any
# viewport down to ~185x250 px, so a fit is always reachable and
# always returnable.
MIN_ZOOM = 0.005

# Zoom below which local roads take the batched overview pass
# instead of the detailed per-road pass (1.9.6 — see _draw_roads).
LOCAL_FULL_DETAIL_ZOOM = 0.03

# ------------------------------------------------------------------
# Delete preview (1.9.7 — Joshua's live report, 2026-10-18).
#
# The old Delete flow named the road in a centred modal dialog but
# never SHOWED it: no highlight, no camera move, just a name to
# trust blind. Now a pick frames the whole road like a photograph
# and lights it up in this colour — a hot magenta no road category,
# zone fill or marker uses, so the lit road cannot be mistaken for
# anything else on the map — while a slim bar at the top edge of
# the map (app.py) carries the name and the Delete / Cancel choice.
# ------------------------------------------------------------------
DELETE_HIGHLIGHT_RGB = (1.0, 0.05, 0.78)

# Height (px) reserved at the top of the canvas when framing a
# road for deletion: the confirmation bar rides there, and the
# framed picture is fitted into the space BELOW it so the bar can
# never cover part of the road.
DELETE_BAR_H = 48


# Framing margin for the delete "photograph": the road's bounding
# box is scaled by this before fitting, so the road sits inside
# the frame with a modest ring of surrounding area for context —
# "not a large area, just enough to see the full road".
DELETE_FRAME_MARGIN = 1.12

# Framing never zooms in past the point where the smaller usable
# view dimension shows this many world units: a tiny stub still
# gets its street context instead of one fat line filling the
# screen.
DELETE_FRAME_MIN_SPAN = 160.0

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


# ---------------------------------------------------------------------------
# View chrome measurements (1.9.14 — compass + scale ruler)
# ---------------------------------------------------------------------------
# World units are metres (the game's own unit: 1 unit = 1 m), and
# the camera zoom IS the scale — screen pixels per metre — so the
# ruler below is computed from the live camera, never hardcoded.

FOOT_M = 0.3048          # one international foot, in metres
MILE_M = 1609.344        # one international mile, in metres


def format_distance(metres):
    """
    A distance in the game's own style (Joshua's GPS ruling):
    feet while under a mile, miles to two decimals at or over it.
    Used by the scale ruler's labels and by measure mode's report
    of a measured section.
    """
    if metres < MILE_M:
        return f"{metres / FOOT_M:.0f} ft"
    return f"{metres / MILE_M:.2f} mi"


# The ruler's candidate bar lengths, ascending: round feet first,
# then round miles. The drawn bar is the LARGEST candidate whose
# true pixel length fits the box (see MapCanvas.scale_bar).
SCALE_LADDER = tuple(
    [(ft * FOOT_M, f"{ft} ft")
     for ft in (10, 20, 50, 100, 200, 500, 1000)]
    + [(0.5 * MILE_M, "0.5 mi"), (1 * MILE_M, "1 mi"),
       (2 * MILE_M, "2 mi"), (5 * MILE_M, "5 mi"),
       (10 * MILE_M, "10 mi"), (20 * MILE_M, "20 mi")])


class MapCanvas(Gtk.DrawingArea):
    """
    Native Cairo canvas for the map editor.
    All rendering is done with Cairo — no web technologies.
    """

    # View chrome geometry (1.9.14), in screen pixels.
    _CHROME_MARGIN = 10    # gap between the canvas edge and chrome
    _CHROME_PAD = 8        # padding inside the ruler box
    _RULER_H = 36          # scale ruler box height
    _COMPASS_R = 30        # compass disc radius
    _SCALE_MAX_PX = 150    # longest the ruler bar may grow
    # Buildings toggle (1.9.15): a square button in the main
    # view's TOP-RIGHT corner. Its top edge sits BELOW the
    # delete-confirmation bar's strip (DELETE_BAR_H + the app's
    # overlay margins): that bar is an overlay widget spanning
    # the full top edge while a delete decision is up, and the
    # toggle must never hide under it or fight it for clicks.
    _BLDG_BTN_SIZE = 40    # buildings toggle box (square, px)
    _BLDG_BTN_TOP = DELETE_BAR_H + 6

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
        self._camera = Camera2D(zoom=0.06, min_zoom=MIN_ZOOM,
                                max_zoom=40.0)
        # 1.9.6: the camera may be the SHARED suite copy, whose own
        # floor is whatever that copy was built with; pin the floor
        # the world-fit guarantee needs. Both camera copies (shared
        # and the local fallback above) expose min_zoom as a plain
        # attribute, so this works for either.
        self._camera.min_zoom = MIN_ZOOM
        # Centre of the converted world (its origin is no longer 0,0).
        self.cam_x = WORLD_X0 + WORLD_W / 2
        self.cam_y = WORLD_Z0 + WORLD_H / 2
        self.zoom = 0.06  # will be set by fit_view()

        # Interaction state
        self.dragging = False       # True during pan drag
        self.drag_start = (0, 0)    # Screen coords where drag started
        self.cam_start = (0, 0)     # Camera position when drag started
        self.mouse_pos = (0, 0)     # Current mouse position (screen)
        # 1.9.19: a resting left press does NOT pick on press —
        # it records press_pick = (x, y) and the click (if it
        # stays a click) is decided on release. A press that
        # travels is a pan, and a pan never touches the
        # selection (Joshua's rule, 2026-10-28 — see
        # on_button_release).
        self.press_pick = None
        # Shift+drag state (1.9.8 band, 1.9.11 lasso): band_drag is
        # (start_x, start_y, cur_x, cur_y) in screen px while a
        # Shift+drag is in progress, and band_path is the freeform
        # screen path the pointer actually took. On release the
        # gesture resolves three ways (see on_button_release): a
        # plain Shift+click ADDS the piece under the click; a path
        # that loops back to its start is the LASSO — pieces inside
        # it join the selection; any other drag keeps the 1.9.8
        # behaviour, the batch-delete square between press and
        # release. (Rotation lives on the Q/E keys, the heading
        # buttons, and Control+drag in any pane — Joshua's
        # universal controls, 1.9.9; the Control+drag bookkeeping
        # state is ctrl_drag, below.)
        self.band_drag = None
        self.band_path = None
        # Street-jump GHOST (1.9.9): when a Building Editor jump
        # carries a building, its footprint + name are drawn here
        # as reference context — {"name", "footprint", "at"} or
        # None. Pure drawing state: never selectable, never
        # editable, never part of any road data or save.
        self.jump_ghost = None
        # Universal controls (1.9.9): a Control+drag rotation in
        # progress — (start_x, rotation_at_start) or None.
        self.ctrl_drag = None
        # One-live-pane rule (1.9.8): while the 3D viewport is the
        # live pane, the map holds a still (rendered once, then
        # only blitted) — see on_draw.
        self.stilled = False
        self._still_surface = None
        self.render_count = 0   # scene renders (gate evidence)

        # Tool state (set by toolbar). None is the RESTING state
        # (1.9.7 interaction model, Joshua 2026-10-18): there is no
        # Pan mode and no Select mode — dragging the map always
        # pans, and clicking a road always selects it. Only the
        # genuine editing tools (zone, fill, extend, ...) set this
        # to a tool id while they are in use.
        self.active_tool = None

        # Selection state (Joshua 2026-10-11: select-first workflow).
        # Click roads to toggle-select them. 1.9.11 (Joshua's word,
        # 2026-10-24): the old cap of 2 is GONE — Join works on
        # chains of 2+ pieces, so the selection holds as many pieces
        # as he picks (click, Shift+click, or the lasso). The Merge /
        # Join / Delete toolbar buttons act on the selection.
        self.selected_roads = []  # list of (cat, flat_idx), no cap

        # One-object pairings (1.9.11, Joshua's Question 4 / Spot 2
        # rulings): records sharing a "grp" value are ONE piece.
        # The selection stores the member keys (all existing
        # machinery works on keys), and every UI path that adds or
        # removes a piece expands through the pairing, so an object
        # is always selected — and deleted — whole. The grp lookup
        # cache is keyed by the spatial index object and rebuilt
        # when the index is (see _grp_map).
        self._grp_cache = None      # (id(spatial_index), {grp: keys})
        # The last successful click-pick's world point (1.9.11):
        # the 3D still pane frames its picture on this point —
        # the viewpoint sits where he clicked, not at a road's
        # head or foot (his 1.9.9 still-pane ruling). _pick_fresh
        # marks a pick the app has not yet reacted to.
        self.last_pick_world = None
        self._pick_fresh = False

        # Draw tool state (1.9.11 — the 1.9.9 Draw did nothing):
        # while the Draw tool is active, a left drag collects
        # world points here instead of panning; on release the
        # points become a new road. None while not drawing.
        self.draw_drag = None

        # Isolation (1.9.10): one selected piece singled out from
        # the Pieces panel — it is framed and lit BRIGHT while
        # the rest of the selection stays selected but is drawn
        # quiet, so a piece buried under another selected piece
        # becomes visible by itself (Joshua's Blender recording,
        # 2026-10-23: 4 objects selected, only 3 visible, no way
        # to single out the fourth). A (cat, flat_idx) key from
        # selected_roads, or None. Pure view state: the selection
        # itself never changes when a piece is isolated.
        self.isolated = None

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

        # Delete preview state (1.9.7). None when idle; otherwise:
        #   {"roads": [(cat, flat_idx, road_dict), ...] — the current
        #    selection, resolved to records,
        #    "prev_cam": (cam_x, cam_y, zoom, rotation) from before
        #    the preview — Cancel restores all four, exactly,
        #    "prev_selection": the selection keys from before the
        #    preview (1.9.12) — Cancel restores them too}
        # While it is set, those roads are drawn lit up whole (see
        # _draw_delete_preview), the view is framed on their full
        # extent, and the app's delete bar names them with the
        # Delete / Cancel choice. The road dicts are the very
        # records a confirmed delete removes — the highlight covers
        # exactly what will be deleted, no more and no less.
        # 1.9.12: while the picture is up, clicking a revealed
        # piece in the companion panes' AFTER still adds it to
        # "roads" (and to the selection) — the set can grow until
        # Joshua confirms or cancels (app.add_piece_from_after_
        # picture).
        self.delete_preview = None

        # Delete PREPARATION state (1.9.7 no-stall rule): between
        # the Delete button press and the preview appearing, the
        # picked roads' geometry is gathered on a worker thread
        # (see begin_delete_preview). While a preparation runs,
        # this holds {"token": int, "roads": [...], "names": [...]};
        # the token identifies the live preparation so a cancelled
        # one's late result is dropped instead of popping a preview
        # Joshua already backed out of.
        self.delete_prep = None
        self._delete_prep_token = 0

        # View chrome (1.9.14, Joshua's rulings 2026-10-25): the
        # COMPASS (bottom-right of the main view) and the SCALE
        # RULER (bottom-left) are drawn on this canvas, over the
        # map — see _draw_view_chrome. The compass turns with the
        # shared camera heading; the ruler's bar is computed from
        # the camera's true scale (zoom = screen px per metre).
        # The window's progress bar lives in the status bar BELOW
        # this canvas (packed at its right end), so the compass in
        # the canvas corner and the progress bar in the strip under
        # it form a stack that can never overlap.
        #
        # The ruler is also the MEASURE MODE switch (his ruling:
        # click the ruler to measure). Measure state:
        #   measure_mode   — True while measuring;
        #   measure_points — the picked world points (0, 1 or 2);
        #   measure_drag   — (press_x, press_y, was_second) while
        #                    a measure press is down, else None;
        #   measure_live   — the pointer's current world point
        #                    during that press (the section being
        #                    dragged out), else None.
        # Measure mode NEVER touches the road selection: entering,
        # measuring and leaving all leave selected_roads exactly
        # as they were (proved in the 1.9.14 gate).
        self.measure_mode = False
        self.measure_points = []
        self.measure_drag = None
        self.measure_live = None

        # Buildings visibility (1.9.15, Joshua 2026-10-25): the
        # building-shaped button at the main view's top right
        # turns the zone buildings on and off. ON (the state
        # every launch starts in — "starts enabled", his words):
        # buildings draw and a click on one offers the Building
        # Editor jump, exactly as before. OFF: buildings are not
        # drawn AND not hit-tested at all, so a building sitting
        # on top of a road can no longer hide the road or steal
        # its clicks — "there's a section of road that is not
        # able to be grabbed because there's a building sitting
        # on top of it." Deliberately NOT remembered in the
        # window/layout state: every launch starts enabled.
        self.show_buildings = True

        # Delete-review reframe (1.9.15): while a delete picture
        # is up, a canvas resize schedules ONE coalesced refit of
        # the framed roads (see _on_canvas_size_allocate and
        # reframe_delete_preview). The id of the pending timeout,
        # or None when no refit is scheduled.
        self._delete_reframe_id = None

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
        # Delete-review reframe (1.9.15): canvas resizes (window
        # resize, pane drags) re-fit an open delete picture — see
        # _on_canvas_size_allocate.
        self.connect("size-allocate", self._on_canvas_size_allocate)

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

    @property
    def rotation(self):
        """View heading in degrees clockwise (proxied to the shared
        camera). 1.9.8: THE one heading every viewpoint reads — the
        main map, the elevation map, the 3D inspector and the
        satellite viewpoint all turn together because there is
        only this one number."""
        return self._camera.rotation

    @rotation.setter
    def rotation(self, value):
        self._camera.set_rotation(value)

    def rotate_by(self, delta_deg):
        """
        Turn the shared view by delta degrees (clockwise positive)
        and tell the app so every linked viewpoint redraws. This
        is the single door every rotate gesture walks through —
        Control+drag here, Q/E keys and the status-bar buttons in
        app.py — so the panes can never disagree about heading.
        """
        # A user rotation is navigation: the jump ghost clears.
        self.clear_jump_ghost()
        self._camera.rotate_by(delta_deg)
        self.queue_draw()
        self._notify_camera_changed()

    def _notify_camera_changed(self):
        """
        Tell the app the shared camera moved (pan / zoom / rotate /
        fit), so the linked viewpoints (elevation map, inspector)
        follow. Fail-open: early-init and headless harnesses may
        build canvases whose app has no such hook yet.
        """
        hook = getattr(self.app, "on_camera_changed", None)
        if hook is not None:
            try:
                hook()
            except Exception:
                pass

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
        """
        Zoom to fit the entire converted world (all seven zones).

        1.9.6: the fit is GUARANTEED here, not merely delegated to
        the camera: after asking the camera to fit, the resulting
        viewport is checked against the world rect, and if a camera
        copy's own zoom floor clamped the fit (leaving part of the
        world outside the frame), the camera is set directly from
        the world constants — the same math as fit_rect, applied
        through the unclamped cam_x / cam_y / zoom properties.

        1.9.8: "show me the whole map" also means north-up — the
        heading resets to 0, so the guarantee below is stated (and
        checked) for the unrotated frame it was written for.
        """
        self._camera.set_rotation(0.0)
        alloc = self.get_allocation()
        self._camera.fit_rect(alloc.width, alloc.height,
                              WORLD_X0, WORLD_Z0,
                              WORLD_X0 + WORLD_W, WORLD_Z0 + WORLD_H,
                              margin=1.05)
        vx0, vz0, vx1, vz1 = self.get_viewport()
        if (vx0 > WORLD_X0 or vz0 > WORLD_Z0
                or vx1 < WORLD_X0 + WORLD_W
                or vz1 < WORLD_Z0 + WORLD_H):
            # The camera's fit left world outside the frame. Set
            # the fit directly so the whole world is in view.
            if alloc.width > 0 and alloc.height > 0:
                self.zoom = min(alloc.width / (WORLD_W * 1.05),
                                alloc.height / (WORLD_H * 1.05))
                self.cam_x = WORLD_X0 + WORLD_W / 2
                self.cam_y = WORLD_Z0 + WORLD_H / 2
        self.queue_draw()
        self._notify_camera_changed()

    def zoom_at(self, sx, sy, factor):
        """
        Zoom centered on a screen point.
        factor > 1 zooms in, < 1 zooms out.
        """
        alloc = self.get_allocation()
        self._camera.zoom_at(sx, sy, factor, alloc.width, alloc.height)
        self.queue_draw()
        self._notify_camera_changed()

    def frame_rect(self, x0, z0, x1, z1, top_inset=0):
        """
        Frame a world rectangle like a photograph (1.9.7): pan and
        zoom — IN or OUT, whichever the rectangle needs — so the
        whole rectangle fits the canvas with DELETE_FRAME_MARGIN of
        breathing room, centred in the area below `top_inset`
        pixels (the delete bar rides in that top strip, so the
        picture is fitted underneath it and the bar never covers
        the road).

        Two clamps keep the framing sane at the extremes: the zoom
        never drops below the camera's world floor (a road longer
        than the world cannot occur, but the floor keeps this
        method honest for any caller), and it never rises past the
        point where the smaller usable dimension would show less
        than DELETE_FRAME_MIN_SPAN world units — a five-unit stub
        still gets its surrounding streets as context instead of
        filling the screen with one fat line.
        """
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height
        usable_h = h - top_inset
        if w <= 0 or usable_h <= 0:
            return
        # 1.9.8: the fit is computed on the rect's ROTATED extents
        # (the camera may be turned when a delete is framed; the
        # photograph must still contain the whole road). At
        # heading 0 the rotated extents are the rect itself and
        # this is exactly the 1.9.7 framing.
        cxr, czr = (x0 + x1) / 2, (z0 + z1) / 2
        rad = math.radians(self._camera.rotation)
        c, s = math.cos(rad), math.sin(rad)
        hw = hh = 0.0
        for px in (x0, x1):
            for pz in (z0, z1):
                dx, dz = px - cxr, pz - czr
                hw = max(hw, abs(dx * c - dz * s))
                hh = max(hh, abs(dx * s + dz * c))
        rw = max(1.0, 2 * hw * DELETE_FRAME_MARGIN)
        rh = max(1.0, 2 * hh * DELETE_FRAME_MARGIN)
        zoom = min(w / rw, usable_h / rh)
        zoom_cap = min(w, usable_h) / DELETE_FRAME_MIN_SPAN
        zoom = max(MIN_ZOOM, min(zoom, zoom_cap, self._camera.max_zoom))
        self.zoom = zoom
        self.cam_x = cxr
        self.cam_y = czr
        # Centre the rectangle in the band BELOW the top inset:
        # shifting the camera by the screen vector (0, -inset/2)
        # moves the picture DOWN by exactly the inset — expressed
        # through the camera so it stays true at any heading (at
        # heading 0 it is the 1.9.7 cam_y adjustment, verbatim).
        self._camera.move_view_by(0, -top_inset / 2.0)
        self.queue_draw()
        self._notify_camera_changed()

    # ------------------------------------------------------------------
    # Rendering
    # ------------------------------------------------------------------

    def on_draw(self, widget, cr):
        """
        Cairo draw handler. Called by GTK when the widget needs
        repainting. One-live-pane rule: while the map is stilled
        (the 3D viewport is the live pane), the scene renders
        ONCE into a cache and later draws only blit it — zero
        rendering activity until the map is touched again.
        """
        if self.stilled:
            alloc = self.get_allocation()
            w, h = alloc.width, alloc.height
            if self._still_surface is None or \
                    self._still_surface.get_width() != w or \
                    self._still_surface.get_height() != h:
                import cairo as _cairo
                surf = _cairo.ImageSurface(
                    _cairo.FORMAT_ARGB32, max(2, w), max(2, h))
                self.render_count += 1
                self._draw_scene(widget, _cairo.Context(surf))
                surf.flush()
                self._still_surface = surf
            cr.set_source_surface(self._still_surface, 0, 0)
            cr.paint()
            return False
        self.render_count += 1
        return self._draw_scene(widget, cr)

    def _draw_scene(self, widget, cr):
        """
        The map picture itself.
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

        # Draw buildings (1.9.13): footprint blocks in roof tones,
        # the same picture the satellite pane draws — on the main
        # map they are the visible targets of the building click
        # (click one -> "Edit this location?" -> Building Editor).
        self._draw_buildings(cr)

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

        # The street-jump building ghost (1.9.9), under the band.
        self._draw_jump_ghost(cr)
        # Batch selection band (1.9.8), topmost.
        self._draw_band(cr)

        # Draw the pending-delete road LAST, on top of everything:
        # while Joshua is deciding, the road he is about to delete
        # must be the most visible thing on the map (1.9.7).
        self._draw_delete_preview(cr)

        # View chrome (1.9.14): the compass (bottom-right), the
        # scale ruler (bottom-left) and any live measurement ride
        # above the map picture itself — they are the map's own
        # furniture, always visible, never part of the world.
        self._draw_view_chrome(cr)

        return False

    def _draw_buildings(self, cr):
        """
        Buildings on the main map (1.9.13): footprint rectangles
        in the area viewpoints' roof tones, drawn through this
        canvas's own camera by the shared helper. Only zones the
        lazy BuildingsStore has already loaded contribute (never
        a blocking fetch in a draw); the app keeps the on-screen
        zones' buildings coming in the background. Under the road
        labels, over the roads — a building's block is what the
        building click hits (see _pick_building).

        1.9.15: the buildings toggle (top-right of the view) —
        while it is OFF nothing is drawn here at all.
        """
        if not self.show_buildings:
            return
        insp = getattr(self.app, "inspector", None)
        store = getattr(insp, "buildings", None) if insp else None
        if store is None:
            return
        from roadinspect import _draw_map_buildings, \
            _zone_ids_for_rect
        alloc = self.get_allocation()
        w, h = max(2, alloc.width), max(2, alloc.height)
        vp = self._camera.get_viewport(w, h)
        _draw_map_buildings(cr, self.app, store, self._camera,
                            w, h, _zone_ids_for_rect(vp))

    def _pick_building(self, sx, sy):
        """
        The building under a screen point, as (zone_id, index,
        building) — the identity app.on_building_clicked hands to
        the Building Editor — or None. The hit-test itself lives
        in the store (areadata.BuildingsStore.pick_building);
        this only translates the point and the zones around it.

        1.9.15: while the buildings toggle is OFF this returns
        None for every point — buildings are out of hit-testing
        entirely, so a click where a building overlaps a road
        reaches the road (and can never raise the building-jump
        dialog). This is the toggle's only hit-test caller path:
        _maybe_building_click is the sole consumer.
        """
        if not self.show_buildings:
            return None
        insp = getattr(self.app, "inspector", None)
        store = getattr(insp, "buildings", None) if insp else None
        if store is None:
            return None
        wx, wz = self.screen_to_world(sx, sy)
        from roadinspect import _zone_ids_for_rect
        zones = _zone_ids_for_rect((wx, wz, wx, wz))
        return store.pick_building(zones, wx, wz)

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

        # Draw tool (1.9.11): the line being laid, live under the
        # pointer — a bright cyan trace through the points the
        # drag has collected so far, so the road he is drawing
        # is visible before he lets go.
        if self.draw_drag:
            cr.set_source_rgb(0.3, 0.9, 1.0)
            cr.set_line_width(3)
            cr.set_line_cap(1)
            cr.set_line_join(1)
            first = True
            for px, pz in self.draw_drag:
                sx, sy = self.world_to_screen(px, pz)
                if first:
                    cr.move_to(sx, sy)
                    first = False
                else:
                    cr.line_to(sx, sy)
            cr.stroke()

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
        # 1.9.19: records a confirmed delete already removed from
        # the working copy are skipped here while the worker's
        # index rebuild is still in flight — the picture must not
        # keep showing roads that are already deleted.
        hidden = getattr(self.app, "_pending_delete_ids", None)
        by_cat = {c: [] for c in CATEGORY_ORDER}
        for idx in indices:
            cat, road, _, _, _, _ = self.app.spatial_index.roads[idx]
            if hidden and id(road) in hidden:
                continue
            by_cat.setdefault(normalize_category(cat), []).append(
                (road, idx))

        # 1.9.6: local roads are drawn at EVERY zoom. Below
        # LOCAL_FULL_DETAIL_ZOOM they take the batched overview
        # pass (one Cairo path, one stroke — see
        # _draw_roads_overview); at and above it they take the
        # detailed per-road pass below, like every other category.
        # Before 1.9.6 local roads were SKIPPED outright below
        # zoom 0.03 ("perf optimization") — but the whole-world fit
        # lands near 0.017, so the opening map hid 57,173 of the
        # map's 65,982 roads (87%): every local street in Mableton,
        # Union City, the Adamsville / South Fulton extensions and
        # most of Riverdale simply wasn't there to see.
        for cat in reversed(CATEGORY_ORDER):
            if cat == "local" and self.zoom < LOCAL_FULL_DETAIL_ZOOM:
                self._draw_roads_overview(cr, by_cat.get("local", []))
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

    def _draw_roads_overview(self, cr, roads):
        """
        Fast overview pass for LOCAL roads at low zoom (1.9.6).

        The local roads in the viewport are drawn as 1 px
        hairlines — the same line width the detailed pass computes
        at these zooms (max(1.0, width * zoom) = 1.0) — built into
        ONE Cairo path (one subpath per road, so roads never
        connect to each other) and stroked once. Two scale culls
        keep that fast without changing the picture: points closer
        together than ~0.75 px on screen are decimated (invisible
        inside a 1 px hairline), and a road whose whole bounding
        box is ~1 px is skipped (it cannot read as a road at this
        zoom; it draws in full on zoom-in). Per-road extras (lane
        paint, sidewalks, cul-de-sac bulbs) are likewise
        sub-pixel here; they belong to the detailed pass, which
        takes over as soon as the user zooms in past
        LOCAL_FULL_DETAIL_ZOOM.
        """
        style = ROAD_STYLE["local"]
        r, g, b = style["color"]
        cr.set_source_rgb(r, g, b)
        cr.set_line_width(1.0)
        cr.set_line_cap(1)   # round caps, same as the detailed pass
        cr.set_line_join(1)  # round joins
        # Inlined world->screen transform (same math as
        # Camera2D.world_to_screen): at overview zoom this pass
        # walks every local road's points — hundreds of thousands —
        # so the per-point method call is avoided on purpose.
        alloc = self.get_allocation()
        cam_x, cam_y, zoom = self.cam_x, self.cam_y, self.zoom
        hw, hh = alloc.width / 2, alloc.height / 2
        for road, _idx in roads:
            pts = road.get("pts", [])
            if len(pts) < 2:
                continue
            # Roads whose whole bounding box is ~1 screen pixel
            # cannot read as roads at this zoom (a sub-pixel stub
            # is at most a faint dot); they draw in full the moment
            # the user zooms in. Skipping them is what keeps the
            # overview fast — the network's SHAPE stays complete.
            xs = [p[0] for p in pts]
            zs = [p[1] for p in pts]
            if (max(xs) - min(xs)) * zoom < 1.25 \
                    and (max(zs) - min(zs)) * zoom < 1.25:
                continue
            # Decimation: consecutive points closer than ~0.75 px
            # on screen are indistinguishable in a 1 px hairline;
            # keep the first, the last, and any point that moved
            # far enough from the last KEPT point.
            first = True
            kx = ky = None
            last_i = len(pts) - 1
            for i, (px, pz) in enumerate(pts):
                sx = (px - cam_x) * zoom + hw
                sy = (pz - cam_y) * zoom + hh
                if first:
                    cr.move_to(sx, sy)
                    kx, ky = sx, sy
                    first = False
                elif i == last_i or abs(sx - kx) + abs(sy - ky) >= 0.75:
                    cr.line_to(sx, sy)
                    kx, ky = sx, sy
        cr.stroke()

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
        """Draw a yellow highlight around each selected road.

        1.9.10: while a piece is ISOLATED (singled out from the
        Pieces panel), the isolated piece keeps the bright fat
        yellow and every other selected piece is drawn QUIET —
        thin and translucent — so the isolated piece can be seen
        by itself even where the pieces lie on the same ground.
        The selection itself is unchanged; only the drawing is.

        1.9.11: isolating one run of a grp object lights the
        WHOLE object bright — the runs are one piece, so the
        picture treats them as one.
        """
        iso = self.isolated
        isolating = iso is not None and iso in self.selected_roads \
            and len(self.selected_roads) > 1
        iso_keys = set(self.grp_members(*iso)) if iso is not None \
            else set()
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
            if isolating and (cat, idx) not in iso_keys:
                # Quiet: thin, translucent grey — present (it is
                # still selected) but not competing.
                cr.set_source_rgba(0.8, 0.8, 0.8, 0.45)
                cr.set_line_width(max(
                    1.5, style["width"] * wmult * self.zoom * 0.4))
            else:
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

    def frame_piece(self, cat, idx):
        """
        Frame ONE indexed piece like a photograph (1.9.10): pan
        and zoom so its whole extent fits with the same modest
        margin the delete framing uses. The Pieces panel's
        isolate + the stacked finder's reveal both land here.
        Returns False when the piece is not in the index.
        """
        if self.app.spatial_index is None:
            return False
        if idx < 0 or idx >= len(self.app.spatial_index.roads):
            return False
        rcat, road, x0, z0, x1, z1 = \
            self.app.spatial_index.roads[idx]
        # Pad by half the road's width + a few metres, like the
        # delete preparation's framing pad, so the fat highlight
        # stroke is never clipped by the frame.
        style = ROAD_STYLE[normalize_category(rcat)]
        wmult = WIDTH_MULT.get(
            road.get("width_class", "standard"), 1.0)
        pad = style["width"] * wmult / 2.0 + 6.0
        self.frame_rect(x0 - pad, z0 - pad, x1 + pad, z1 + pad)
        return True

    def _draw_delete_preview(self, cr):
        """
        Draw the pending-delete road ON TOP of everything (1.9.7).

        One fat magenta stroke through the road's FULL point list,
        plus a dot on each end so Joshua can see where the road
        begins and ends. Drawn directly from the road record — no
        spatial-index culling — so the whole road lights up even
        where the ordinary passes draw mere hairlines (the zoomed-
        out overview) and even for the parts of the road outside
        the current view (Cairo clips them; the in-view part still
        reads clearly). The width keeps a screen-space floor so
        the highlight is unmistakable at ANY zoom.
        """
        pv = self.delete_preview
        if pv is None:
            return
        cr.set_source_rgb(*DELETE_HIGHLIGHT_RGB)
        cr.set_line_cap(1)   # round caps
        cr.set_line_join(1)  # round joins
        for cat, _idx, road in pv["roads"]:
            pts = road.get("pts", [])
            if len(pts) < 2:
                continue
            style = ROAD_STYLE[normalize_category(cat)]
            wmult = WIDTH_MULT.get(
                road.get("width_class", "standard"), 1.0)
            cr.set_line_width(
                max(6.0, style["width"] * wmult * self.zoom + 5.0))
            self._stroke_road_path(cr, pts)
            cr.stroke()
            # Endpoint dots: where this road starts and stops.
            for px, pz in (pts[0], pts[-1]):
                sx, sy = self.world_to_screen(px, pz)
                cr.arc(sx, sy, 5, 0, 2 * math.pi)
                cr.fill()

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
        # One-live-pane: touching the map makes it the
        # live pane (the 3D viewport goes back to a still).
        try:
            self.app.note_pane_touched("map")
        except Exception:
            pass
        # His own press: the jump ghost has done its job.
        self.clear_jump_ghost()
        # View chrome first (1.9.15): a left press on the
        # BUILDINGS TOGGLE (top right) flips building visibility
        # — a furniture click with the same discipline as the
        # ruler's below: no pan starts, nothing selects or
        # deselects, the camera never moves. While other
        # machinery owns the pointer (a modal mode, the zone pin
        # drag, the delete preview) or an editing tool is armed,
        # the button stays inert and the click keeps its ordinary
        # meaning. (While measuring, the flip is allowed: hiding
        # buildings can only help see the measured ground.)
        if event.button == 1 and self._point_in_buildings_button(
                event.x, event.y):
            busy = (self.move_road is not None
                    or self.divide_pick is not None
                    or self.link_overpass_mode
                    or self.delete_preview is not None
                    or self.drag_pin is not None)
            if not busy and (self.active_tool is None
                             or self.measure_mode):
                self.toggle_buildings()
                return True
        # View chrome first (1.9.14): a left press on the SCALE
        # RULER toggles measure mode — a furniture click, never a
        # map gesture: no pan starts, nothing selects or
        # deselects. While other machinery owns the pointer (a
        # modal mode, the zone pin drag, the delete preview) or
        # an editing tool is armed, the ruler stays inert and the
        # click keeps its ordinary meaning.
        if event.button == 1 and self._point_in_ruler(event.x,
                                                      event.y):
            busy = (self.move_road is not None
                    or self.divide_pick is not None
                    or self.link_overpass_mode
                    or self.delete_preview is not None
                    or self.drag_pin is not None)
            if not busy and (self.active_tool is None
                             or self.measure_mode):
                if self.measure_mode:
                    self.exit_measure_mode()
                    try:
                        self.app.set_status("Measure off.")
                    except Exception:
                        pass
                else:
                    self.enter_measure_mode()
                return True
        # Measure mode (1.9.14): map presses belong to measuring
        # — they pick points; they never pan, never select, and
        # never disturb a selection made before entering.
        if self.measure_mode:
            if self.delete_preview is not None:
                # A delete decision outranks measuring: leave
                # measure mode and let this press mean whatever
                # it means with the preview up.
                self.exit_measure_mode()
            elif event.button == 1:
                wx, wz = self.screen_to_world(event.x, event.y)
                if len(self.measure_points) >= 2:
                    # A press after a finished measurement starts
                    # the next one.
                    self.measure_points = [(wx, wz)]
                    self.measure_drag = (event.x, event.y, False)
                elif len(self.measure_points) == 1:
                    self.measure_drag = (event.x, event.y, True)
                else:
                    self.measure_points = [(wx, wz)]
                    self.measure_drag = (event.x, event.y, False)
                self.measure_live = (wx, wz)
                self.queue_draw()
                return True
            elif event.button == 3:
                # Right-drag pan is suspended while measuring.
                return True
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
            # Draw tool (1.9.11 — in 1.9.9 selecting Draw did
            # nothing at all): the drag BELONGS to drawing while
            # Draw is active, so panning is disabled and the drag
            # collects the new road's points (Joshua's ruling).
            # Points land on release (see _finish_draw).
            if self.active_tool == "draw":
                wx, wz = self.screen_to_world(event.x, event.y)
                self.draw_drag = [(wx, wz)]
                self.queue_draw()
                return True
            if self.active_tool == "extend":
                self._on_extend_click(event)
                return True
            if self.active_tool == "fill":
                self._on_fill_click(event)
                return True
            if self.active_tool == "zone":
                # Zone tool: pins first, then boundary edges (click to add a
                # new pin), then the zone body. A drag that starts on the
                # zone body still pans (pan is always on).
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

            # Resting interaction (1.9.7 model — no Pan mode, no
            # Select mode): EVERY left press starts a potential pan
            # drag, from a road or from empty ground alike, because
            # pan is always on. At rest (no editing tool active) the
            # press also ARMS a click: if the gesture stays a
            # click, the release selects (a road toggle-selects;
            # empty space clears). 1.9.19: the pick is decided on
            # RELEASE, never on press — a press that turns into a
            # drag is a pan, and a pan must never disturb a
            # selection already made (Joshua, 2026-10-28: two
            # pieces selected, panned to reach more, both gone,
            # because the press on empty ground cleared them
            # before the pan even began — and a press ON a
            # selected piece toggle-deselected it the same way).
            #
            # 1.9.8 (Joshua's batch rule): Shift+left-drag draws
            # the batch selection SQUARE — on release, every road
            # piece touching the square is collected for the batch
            # delete list. A band drag neither pans nor selects.
            # (Rotating the shared view lives on the Q/E keys, the
            # heading buttons, and Control+drag in any pane —
            # Joshua's universal controls, 1.9.9.)
            if event.state & Gdk.ModifierType.SHIFT_MASK:
                self.band_drag = (event.x, event.y,
                                  event.x, event.y)
                # 1.9.11: remember the path itself — on release
                # it decides between Shift+click (add), the lasso
                # (a loop back to the start), and the band square.
                self.band_path = [(event.x, event.y)]
                return True
            # Universal controls: Control+drag rotates (it never
            # picks and never pans).
            if event.state & Gdk.ModifierType.CONTROL_MASK:
                # (press x, press y, rotation at press): release
                # tells a Ctrl+click (no travel — deselect one
                # piece) from a Ctrl+drag (travel — rotation).
                self.ctrl_drag = (event.x, event.y, self.rotation)
                return True
            self.dragging = True
            self.drag_start = (event.x, event.y)
            self.cam_start = (self.cam_x, self.cam_y)

            if self.active_tool is None:
                # Arm the click; on_button_release fires it only
                # if the pointer stayed put (see press_pick).
                self.press_pick = (event.x, event.y)

        elif event.button == 3:  # right click — always pan
            # …except while Draw is active: Draw owns the drags
            # and panning is disabled (Joshua's Draw ruling).
            if self.active_tool == "draw":
                return True
            self.press_pick = None  # a right press disarms a click
            self.dragging = True
            self.drag_start = (event.x, event.y)
            self.cam_start = (self.cam_x, self.cam_y)

        return True

    def on_button_release(self, widget, event):
        """End pan drag or pin drag."""
        # Measure press ending (1.9.14): the release fixes the
        # section's far point. A first press that never travelled
        # was a CLICK — it set the first point only, and the far
        # point waits for the next click. A second press sets the
        # far point wherever it lands, travelled or not; a press
        # that DID travel (either time) was a drag, and the
        # release point is the section's end. (No other gesture
        # state can be live while a measure press is down —
        # measure presses never set any.)
        if event.button == 1 and self.measure_drag is not None:
            px, py, was_second = self.measure_drag
            self.measure_drag = None
            wx, wz = self.screen_to_world(event.x, event.y)
            travelled = math.hypot(event.x - px, event.y - py) >= 6
            if (was_second or travelled) \
                    and len(self.measure_points) == 1:
                self.measure_points.append((wx, wz))
                self._report_measurement()
            self.measure_live = None
            self.queue_draw()
            return True
        # 1.9.13: remember how this gesture began — the building
        # click decided at the end of the release is only for a
        # plain resting press (a pan drag that stayed a click);
        # the gesture flags below are consumed as the release
        # runs, so they are captured before anything else.
        _had_ctrl = self.ctrl_drag is not None
        _had_band = self.band_drag is not None
        _had_draw = self.draw_drag is not None
        _had_pin = self.drag_pin is not None
        _was_dragging = self.dragging
        if event.button == 1:
            # Ctrl+click: the press started a possible rotation;
            # if the pointer never really travelled, it was a
            # click — take the piece under it out of the
            # selection (Joshua's Ctrl+click rule, 1.9.11).
            if self.ctrl_drag is not None:
                x0, y0, _rot0 = self.ctrl_drag
                self.ctrl_drag = None
                if math.hypot(event.x - x0, event.y - y0) < 6:
                    self.ctrl_click_remove(event.x, event.y)
            # Draw tool: the drag ends — the collected points
            # become a new road (see _finish_draw).
            if self.draw_drag is not None:
                pts = self.draw_drag
                self.draw_drag = None
                wx, wz = self.screen_to_world(event.x, event.y)
                lx, lz = pts[-1]
                if math.hypot(wx - lx, wz - lz) >= 1.0:
                    pts = pts + [(wx, wz)]
                self._finish_draw(pts)
                self.queue_draw()
        if event.button in (1, 3):
            self.dragging = False
            if event.button == 1 and self.band_drag is not None:
                # The gesture ends where the button went UP (the
                # last motion event can lag a step behind it).
                band = (self.band_drag[0], self.band_drag[1],
                        event.x, event.y)
                path = self.band_path
                self.band_drag = None
                self.band_path = None
                self._finish_shift_drag(band, path)
                self.queue_draw()
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
        # 1.9.19: a resting press that stayed a click picks NOW,
        # on release — the same travel test the building click
        # below uses (< 6 px from the press point). A press that
        # travelled was a pan: the armed click is dropped and
        # the selection is left exactly as it was (Joshua's
        # rule: once a selection has begun, panning must not
        # eliminate it).
        if event.button == 1 and self.press_pick is not None:
            _ppx, _ppy = self.press_pick
            self.press_pick = None
            if math.hypot(event.x - _ppx, event.y - _ppy) < 6:
                self._pick_road(event.x, event.y)
        # The building click (1.9.13): only a plain resting
        # press that stayed a click can offer the Building
        # Editor jump — every other gesture keeps its meaning.
        if event.button == 1 and _was_dragging and not _had_ctrl \
                and not _had_band and not _had_draw and not _had_pin:
            self._maybe_building_click(event)
        return True

    def _maybe_building_click(self, event):
        """
        Offer the Building Editor jump for a genuine building
        click (1.9.13, Joshua's order). Decided on RELEASE, when
        a click can be told apart from a pan:

        * at rest — no editing tool armed, no modal mode
          (move-road, divide, overpass link) and no delete
          preview up;
        * the pointer barely travelled (< 6 px, the Ctrl+click
          rule's own threshold) — a press that travelled was a
          pan, and a pan NEVER prompts (his stated failure mode);
        * no road under the point — a road click is a road
          click, exactly as it has always been (the release
          pick just selected it);
        * a building under the point (the store's hit-test).

        The release pick already did whatever a normal click
        does to the road selection; this adds only the offer,
        and cancelling the offer changes nothing more.
        """
        if self.active_tool is not None:
            return
        if self.move_road is not None \
                or self.divide_pick is not None \
                or self.link_overpass_mode:
            return
        if getattr(self, "delete_preview", None) is not None:
            return  # the delete bar owns clicks while it is up
        if math.hypot(event.x - self.drag_start[0],
                      event.y - self.drag_start[1]) >= 6:
            return  # it travelled: a pan, not a click
        if self._pick_road_at(event.x, event.y) is not None:
            return  # a road is under the point: the road wins
        hit = self._pick_building(event.x, event.y)
        if hit is not None:
            self.app.on_building_clicked(*hit)

    def on_motion(self, widget, event):
        """Handle mouse move. Pan if dragging, or drag a zone pin."""
        self.mouse_pos = (event.x, event.y)

        # Measure drag (1.9.14): the section's far end follows
        # the pointer until the release fixes it.
        if self.measure_drag is not None:
            self.measure_live = self.screen_to_world(event.x,
                                                     event.y)
            self.queue_draw()
            return True

        # Universal controls (1.9.9): a Control+drag in progress
        # rotates the shared view — horizontally, like the panes.
        if self.ctrl_drag is not None:
            x0, _y0, rot0 = self.ctrl_drag
            self.rotation = rot0 + (event.x - x0) * 0.4
            return True

        # Draw tool (1.9.11): while a draw drag runs, the pointer
        # lays the new road's points — one every few metres, so a
        # steady drag makes a smooth line and a shaky one does
        # not make a thicket. Nothing pans (Draw owns the drag).
        if self.draw_drag is not None:
            wx, wz = self.screen_to_world(event.x, event.y)
            lx, lz = self.draw_drag[-1]
            if math.hypot(wx - lx, wz - lz) >= 3.0:
                self.draw_drag.append((wx, wz))
                self.queue_draw()
            return True

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

        # Shift+drag in progress (1.9.8 band / 1.9.11 lasso):
        # the square follows the pointer and the freeform path is
        # recorded; what the gesture MEANS is decided on release.
        if self.band_drag is not None:
            sx, sy, _cx, _cy = self.band_drag
            self.band_drag = (sx, sy, event.x, event.y)
            if self.band_path is not None:
                lx, ly = self.band_path[-1]
                if math.hypot(event.x - lx, event.y - ly) >= 2.0:
                    self.band_path.append((event.x, event.y))
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
            self._notify_camera_changed()
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
        # One-live-pane: wheeling the map makes it the live pane.
        try:
            self.app.note_pane_touched("map")
        except Exception:
            pass
        # His own zoom: the jump ghost clears.
        self.clear_jump_ghost()
        """Handle mouse wheel. Zoom centered on cursor (the canvas
        zoom_at already notifies the linked viewpoints)."""
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
    # View chrome: compass, scale ruler, measure mode (1.9.14)
    # ------------------------------------------------------------------
    # Joshua's rulings (2026-10-25): the compass lives in the
    # BOTTOM RIGHT of the main view; the scale ruler in the
    # BOTTOM LEFT; clicking the ruler toggles measure mode. The
    # bottom-left STATUS text (the future post-action readout)
    # lives in the window's status bar below the canvas — the
    # ruler rides on the canvas above it, so the two never cover
    # each other. Likewise the corner progress bar rides the
    # status bar's right end, directly under the compass: a
    # stack in adjacent strips, never an overlap.

    def _chrome_text_width(self, text, size, bold=True):
        """Pixel width of `text` in the chrome font, measured on a
        scratch Cairo context so the ruler box the pointer hits
        is exactly the box that is drawn."""
        import cairo as _cairo
        ctx = getattr(self, "_chrome_text_ctx", None)
        if ctx is None:
            surf = _cairo.ImageSurface(_cairo.FORMAT_ARGB32, 1, 1)
            ctx = _cairo.Context(surf)
            self._chrome_text_ctx = ctx
        ctx.select_font_face("Sans", 0, 1 if bold else 0)
        ctx.set_font_size(size)
        return ctx.text_extents(text)[2]

    def scale_bar(self):
        """
        (metres, label, pixel_width) for the ruler right now: the
        largest ladder candidate whose TRUE length at the current
        camera scale (zoom = px per metre) fits the box. At wide
        zooms that lands on round miles; zooming in walks down
        through round feet — the switch is the ladder itself.
        """
        zoom = max(float(self.zoom), 1e-9)
        best = None
        for metres, label in SCALE_LADDER:
            px = metres * zoom
            if px <= self._SCALE_MAX_PX:
                best = (metres, label, px)
            else:
                break  # ascending ladder: nothing later fits
        if best is None:
            metres, label = SCALE_LADDER[0]
            best = (metres, label, metres * zoom)
        return best

    def compass_north_dir(self):
        """
        The screen-space unit vector pointing at world NORTH
        (-z) under the current heading. The camera turns world
        features clockwise as the heading grows (see
        _LocalCamera2D), so north sits at (sin h, -cos h):
        straight up at heading 0, at the right at heading 90.
        """
        rad = math.radians(self.rotation)
        return (math.sin(rad), -math.cos(rad))

    def _compass_centre(self):
        """(cx, cy, r) of the compass disc, canvas coords."""
        alloc = self.get_allocation()
        r = self._COMPASS_R
        return (alloc.width - self._CHROME_MARGIN - r,
                alloc.height - self._CHROME_MARGIN - r, r)

    def _ruler_label(self):
        """The ruler box's text line for the current state: the
        scale label at rest; in measure mode, the measurement
        (or the prompt for the point still missing)."""
        if not self.measure_mode:
            return self.scale_bar()[1]
        length = self.measure_length_m()
        if length is not None:
            return format_distance(length)
        live = self._measure_live_length_m()
        if live is not None:
            return format_distance(live)
        if len(self.measure_points) == 1:
            return "pick the second point"
        return "pick the first point"

    def ruler_rect(self):
        """The ruler box as (x, y, w, h) in canvas coords — the
        drawn box AND the click target, from one computation.
        None when the canvas is too small to carry furniture."""
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height
        if w < 240 or h < 180:
            return None
        _m, _label, bar_px = self.scale_bar()
        text_w = self._chrome_text_width(self._ruler_label(), 10.5)
        box_w = max(bar_px, text_w, 74) + 2 * self._CHROME_PAD
        return (self._CHROME_MARGIN,
                h - self._CHROME_MARGIN - self._RULER_H,
                box_w, self._RULER_H)

    def _point_in_ruler(self, sx, sy):
        """True if a canvas point lands on the scale ruler."""
        rect = self.ruler_rect()
        if rect is None:
            return False
        x, y, w, h = rect
        return x <= sx <= x + w and y <= sy <= y + h

    # -- buildings toggle (1.9.15) -----------------------------------

    def buildings_button_rect(self):
        """The buildings toggle box as (x, y, w, h) in canvas
        coords — the drawn button AND the click target, from one
        computation (the ruler_rect pattern). Top-right corner,
        its top edge below the delete bar's strip (see
        _BLDG_BTN_TOP). None when the canvas is too small to
        carry furniture — the same rule as the ruler/compass."""
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height
        if w < 240 or h < 180:
            return None
        return (w - self._CHROME_MARGIN - self._BLDG_BTN_SIZE,
                self._BLDG_BTN_TOP,
                self._BLDG_BTN_SIZE, self._BLDG_BTN_SIZE)

    def _point_in_buildings_button(self, sx, sy):
        """True if a canvas point lands on the buildings toggle."""
        rect = self.buildings_button_rect()
        if rect is None:
            return False
        x, y, w, h = rect
        return x <= sx <= x + w and y <= sy <= y + h

    def toggle_buildings(self):
        """
        Flip the buildings toggle (the top-right button was
        clicked at rest). Buildings off: they leave the picture
        and the hit-testing together — the roads underneath are
        fully clickable again. Buildings on: exactly the 1.9.14
        behaviour. The flip never moves the camera or touches
        the selection; it only repaints.
        """
        self.show_buildings = not self.show_buildings
        try:
            if self.show_buildings:
                self.app.set_status(
                    "Buildings shown — click a building to open "
                    "it in the Building Editor.")
            else:
                self.app.set_status(
                    "Buildings hidden — the roads under them "
                    "can be picked now. Click the building "
                    "button (top right) to bring buildings back.")
        except Exception:
            pass
        self.queue_draw()

    # -- measure mode ------------------------------------------------

    def measure_length_m(self):
        """The finished measurement in metres (world units), or
        None while fewer than two points are picked."""
        if len(self.measure_points) != 2:
            return None
        (ax, az), (bx, bz) = self.measure_points
        return math.hypot(bx - ax, bz - az)

    def _measure_live_length_m(self):
        """The in-progress drag's length in metres, or None."""
        if len(self.measure_points) == 1 \
                and self.measure_live is not None:
            ax, az = self.measure_points[0]
            bx, bz = self.measure_live
            return math.hypot(bx - ax, bz - az)
        return None

    def enter_measure_mode(self):
        """Start measuring (the ruler was clicked at rest)."""
        self.measure_mode = True
        self.measure_points = []
        self.measure_drag = None
        self.measure_live = None
        try:
            self.app.set_status(
                "Measure: click two points on the map — or drag "
                "a section. Click the ruler again, or press "
                "Escape, to stop.")
        except Exception:
            pass
        self.queue_draw()

    def exit_measure_mode(self):
        """
        Stop measuring and put the ordinary gestures back exactly
        as they were. The road selection is NOT touched — it was
        never measure mode's to touch.
        """
        self.measure_mode = False
        self.measure_points = []
        self.measure_drag = None
        self.measure_live = None
        self.queue_draw()

    def _report_measurement(self):
        """Announce a finished measurement in the status line
        (the number itself also sits in the ruler box)."""
        length = self.measure_length_m()
        if length is None:
            return
        try:
            self.app.set_status(
                f"Measured: {format_distance(length)} — click "
                "the map to measure again, or the ruler / Esc "
                "to stop.")
        except Exception:
            pass

    # -- chrome drawing ------------------------------------------------

    def _rounded_rect_path(self, cr, x, y, w, h, r):
        """A rounded-rectangle path (the chrome boxes' shape)."""
        cr.new_path()
        cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
        cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
        cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
        cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
        cr.close_path()

    def _draw_centred_text(self, cr, text, cx, cy, size,
                           rgba, bold=True):
        """Draw `text` centred on (cx, cy)."""
        cr.select_font_face("Sans", 0, 1 if bold else 0)
        cr.set_font_size(size)
        ext = cr.text_extents(text)
        cr.set_source_rgba(*rgba)
        cr.move_to(cx - ext[2] / 2 - ext[0], cy - ext[3] / 2 - ext[1])
        cr.show_text(text)

    def _draw_view_chrome(self, cr):
        """
        The main view's furniture, drawn last over the map: the
        measured section (when measuring), the scale ruler
        (bottom-left), the compass (bottom-right) and — while
        measuring — the unmistakable measure banner across the
        top. Pure drawing: no state changes here.
        """
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height
        if w < 240 or h < 180:
            return
        self._draw_measure_overlay(cr)
        self._draw_ruler(cr, w, h)
        self._draw_compass(cr, w, h)
        self._draw_buildings_button(cr, w, h)
        if self.measure_mode:
            self._draw_measure_banner(cr, w)

    def _draw_buildings_button(self, cr, view_w, view_h):
        """
        The buildings toggle (top-right, 1.9.15): a dark chrome
        box in the ruler/compass family holding a building
        glyph — a tall tower beside a shorter annex, with
        window squares. The two states read at a glance:
        buildings ON = the glyph lit pale with warm windows;
        buildings OFF = the glyph dimmed grey with a red slash
        across it. Drawn from buildings_button_rect(), the same
        computation the click test uses.
        """
        rect = self.buildings_button_rect()
        if rect is None:
            return
        import cairo
        x, y, bw, bh = rect
        on = self.show_buildings
        # Box + ring (compass/ruler family).
        self._rounded_rect_path(cr, x, y, bw, bh, 7)
        cr.set_source_rgba(0.04, 0.05, 0.10, 0.82 if on else 0.72)
        cr.fill()
        self._rounded_rect_path(cr, x + 0.75, y + 0.75,
                                bw - 1.5, bh - 1.5, 6)
        cr.set_source_rgba(1, 1, 1, 0.45 if on else 0.28)
        cr.set_line_width(1.5)
        cr.stroke()
        # The building glyph: tower + annex standing on a shared
        # ground line, centred in the box.
        base = y + bh - 9          # ground line
        tower_x, tower_w = x + 9, 12
        tower_top = y + 8
        annex_x, annex_w = tower_x + tower_w, 9
        annex_top = y + 17
        if on:
            cr.set_source_rgba(0.88, 0.90, 0.94, 0.98)
        else:
            cr.set_source_rgba(0.42, 0.44, 0.50, 0.85)
        cr.rectangle(tower_x, tower_top, tower_w, base - tower_top)
        cr.fill()
        cr.rectangle(annex_x, annex_top, annex_w, base - annex_top)
        cr.fill()
        cr.rectangle(x + 7, base, bw - 14, 1.6)
        cr.fill()
        # Windows: little squares punched into the silhouette —
        # warm lit panes while ON, dark holes while OFF.
        if on:
            cr.set_source_rgba(0.98, 0.75, 0.35, 0.95)
        else:
            cr.set_source_rgba(0.16, 0.17, 0.22, 0.9)
        for wy in (tower_top + 4, tower_top + 9.5, tower_top + 15):
            for wx in (tower_x + 2.5, tower_x + 7):
                cr.rectangle(wx, wy, 2.6, 3.2)
                cr.fill()
        for wy in (annex_top + 4, annex_top + 9.5):
            cr.rectangle(annex_x + 3, wy, 2.6, 3.2)
            cr.fill()
        if not on:
            # The OFF slash: a red diagonal across the whole
            # box, cased so it reads over the glyph.
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.set_source_rgba(1, 1, 1, 0.55)
            cr.set_line_width(4.6)
            cr.move_to(x + 6, y + 6)
            cr.line_to(x + bw - 6, y + bh - 6)
            cr.stroke()
            cr.set_source_rgb(0.94, 0.26, 0.16)
            cr.set_line_width(3.0)
            cr.move_to(x + 6, y + 6)
            cr.line_to(x + bw - 6, y + bh - 6)
            cr.stroke()

    def _draw_measure_overlay(self, cr):
        """The measured section itself: a cased amber line with
        end dots — the highlight the ruler's number belongs to."""
        if not self.measure_points:
            return
        a = self.measure_points[0]
        b = None
        if len(self.measure_points) == 2:
            b = self.measure_points[1]
        elif self.measure_live is not None:
            b = self.measure_live
        ax, ay = self.world_to_screen(a[0], a[1])
        if b is None:
            # Only the first point so far: a ringed dot.
            cr.set_source_rgba(1, 1, 1, 0.9)
            cr.set_line_width(2)
            cr.arc(ax, ay, 8, 0, 2 * math.pi)
            cr.stroke()
            cr.set_source_rgb(1.0, 0.72, 0.15)
            cr.arc(ax, ay, 3.5, 0, 2 * math.pi)
            cr.fill()
            return
        bx, by = self.world_to_screen(b[0], b[1])
        # White casing first, amber core on top.
        cr.set_source_rgba(1, 1, 1, 0.85)
        cr.set_line_width(5)
        cr.move_to(ax, ay)
        cr.line_to(bx, by)
        cr.stroke()
        cr.set_source_rgb(1.0, 0.72, 0.15)
        cr.set_line_width(3)
        cr.move_to(ax, ay)
        cr.line_to(bx, by)
        cr.stroke()
        for px, py in ((ax, ay), (bx, by)):
            cr.set_source_rgb(1.0, 0.72, 0.15)
            cr.arc(px, py, 4.5, 0, 2 * math.pi)
            cr.fill()
            cr.set_source_rgba(1, 1, 1, 0.9)
            cr.set_line_width(1.5)
            cr.arc(px, py, 4.5, 0, 2 * math.pi)
            cr.stroke()

    def _draw_measure_banner(self, cr, view_w):
        """The measure-mode banner: a bright pill across the top
        centre — the mode can never be mistaken for resting."""
        if len(self.measure_points) == 1 \
                and self.measure_length_m() is None:
            text = "MEASURE — click the second point"
        else:
            text = ("MEASURE — click two points, or drag a "
                    "section · Esc to exit")
        size = 11.5
        tw = self._chrome_text_width(text, size)
        bw, bh = tw + 28, 25
        x = (view_w - bw) / 2
        y = 8
        self._rounded_rect_path(cr, x, y, bw, bh, 12)
        cr.set_source_rgba(0.98, 0.70, 0.12, 0.95)
        cr.fill()
        self._draw_centred_text(cr, text, x + bw / 2, y + bh / 2,
                                size, (0.12, 0.09, 0.02, 1.0))

    def _draw_ruler(self, cr, view_w, view_h):
        """
        The scale ruler (bottom-left): a dark occluding box whose
        white bar spans a TRUE distance at the current zoom —
        the label names it. In measure mode the box lights up
        amber and its text line carries the measurement instead.
        """
        rect = self.ruler_rect()
        if rect is None:
            return
        x, y, bw, bh = rect
        _m, _label, bar_px = self.scale_bar()
        self._rounded_rect_path(cr, x, y, bw, bh, 6)
        cr.set_source_rgba(0.04, 0.05, 0.10, 0.80)
        cr.fill()
        if self.measure_mode:
            cr.set_source_rgba(1.0, 0.72, 0.15, 1.0)
            cr.set_line_width(2)
        else:
            cr.set_source_rgba(1, 1, 1, 0.35)
            cr.set_line_width(1)
        self._rounded_rect_path(cr, x, y, bw, bh, 6)
        cr.stroke()
        label_rgba = (1.0, 0.85, 0.40, 1.0) if self.measure_mode \
            else (1, 1, 1, 0.95)
        self._draw_centred_text(cr, self._ruler_label(),
                                x + bw / 2, y + 12, 10.5, label_rgba)
        # The bar itself, with end ticks and a mid tick.
        bx0 = x + self._CHROME_PAD
        bx1 = bx0 + bar_px
        by = y + bh - 8
        cr.set_source_rgba(1, 1, 1, 0.95)
        cr.set_line_width(2.5)
        cr.move_to(bx0, by)
        cr.line_to(bx1, by)
        cr.stroke()
        cr.set_line_width(1.5)
        for tx, th in ((bx0, 6), ((bx0 + bx1) / 2, 3.5), (bx1, 6)):
            cr.move_to(tx, by - th)
            cr.line_to(tx, by)
            cr.stroke()

    def _draw_compass(self, cr, view_w, view_h):
        """
        The compass (bottom-right): a dark disc whose needle and
        cardinal letters turn WITH the shared view heading —
        north on screen is compass_north_dir(), so at heading 90
        the needle points at the screen's right edge, exactly
        where north has gone in the map picture.
        """
        cx, cy, r = self._compass_centre()
        # Disc + ring.
        cr.set_source_rgba(0.04, 0.05, 0.10, 0.78)
        cr.arc(cx, cy, r, 0, 2 * math.pi)
        cr.fill()
        cr.set_source_rgba(1, 1, 1, 0.45)
        cr.set_line_width(1.5)
        cr.arc(cx, cy, r - 0.75, 0, 2 * math.pi)
        cr.stroke()
        # The camera's rotation, recomputed from the public
        # heading (the shared camera copy's private helpers are
        # not part of its contract).
        rad = math.radians(self.rotation)
        c, s = math.cos(rad), math.sin(rad)
        # Cardinal letters at their turned positions, upright so
        # they stay readable at any heading.
        for letter, dx, dz, is_north in (
                ("N", 0, -1, True), ("E", 1, 0, False),
                ("S", 0, 1, False), ("W", -1, 0, False)):
            vx = dx * c - dz * s
            vy = dx * s + dz * c
            rgba = (1.0, 0.50, 0.38, 1.0) if is_north \
                else (0.82, 0.85, 0.90, 0.9)
            self._draw_centred_text(
                cr, letter, cx + vx * (r - 8), cy + vy * (r - 8),
                10 if is_north else 8.5, rgba)
            # A short tick at the rim.
            cr.set_source_rgba(1, 1, 1, 0.5)
            cr.set_line_width(1.5)
            cr.move_to(cx + vx * (r - 3.5), cy + vy * (r - 3.5))
            cr.line_to(cx + vx * (r - 1), cy + vy * (r - 1))
            cr.stroke()
        # Needle: red half to north, pale half to south.
        nx, ny = self.compass_north_dir()
        px, py = -ny, nx  # screen perpendicular to the needle
        tip = r - 13
        cr.set_source_rgb(0.94, 0.26, 0.16)
        cr.move_to(cx + nx * tip, cy + ny * tip)
        cr.line_to(cx + px * 4.5, cy + py * 4.5)
        cr.line_to(cx - px * 4.5, cy - py * 4.5)
        cr.close_path()
        cr.fill()
        cr.set_source_rgb(0.80, 0.83, 0.88)
        cr.move_to(cx - nx * tip, cy - ny * tip)
        cr.line_to(cx + px * 4.5, cy + py * 4.5)
        cr.line_to(cx - px * 4.5, cy - py * 4.5)
        cr.close_path()
        cr.fill()
        cr.set_source_rgb(0.10, 0.11, 0.16)
        cr.arc(cx, cy, 2.6, 0, 2 * math.pi)
        cr.fill()

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

    # ------------------------------------------------------------------
    # One-object pairings (1.9.11): records sharing a "grp" value
    # ------------------------------------------------------------------
    # Joshua's Question 4 / Spot 2 rulings (2026-10-24): where a
    # road exists as two runs — split by a crossing road, or the
    # two carriageways of a median stretch — the runs are ONE
    # piece. The data pass writes a shared "grp" value onto each
    # run's record; the editor treats the group as a single
    # object everywhere: selecting any run selects all of them,
    # the Pieces panel lists them as one entry, and Delete
    # removes the whole object. When no record carries "grp" the
    # map is empty of pairings and every behaviour below reduces
    # to the single-record case, exactly as before.

    def _grp_map(self):
        """
        {grp value: [(cat, flat_idx), ...]} over the current
        spatial index. Built lazily and cached against the index
        object itself (an index rebuild replaces the object, so
        a stale pairing can never survive an edit).
        """
        si = self.app.spatial_index
        if si is None:
            return {}
        cache = self._grp_cache
        if cache is not None and cache[0] is si:
            return cache[1]
        out = {}
        for flat, entry in enumerate(si.roads):
            road = entry[1]
            grp = road.get("grp") if isinstance(road, dict) else None
            if grp:
                out.setdefault(grp, []).append((entry[0], flat))
        self._grp_cache = (si, out)
        return out

    def grp_value(self, cat, idx):
        """The "grp" pairing value of one indexed record, or None."""
        road = self._get_road_dict(cat, idx)
        if road is None:
            return None
        return road.get("grp") or None

    def grp_members(self, cat, idx):
        """
        Every selection key belonging to the same object as
        (cat, idx): the key itself first, then its grp partners
        in index order. An unpaired record returns just itself.
        """
        key = (cat, idx)
        grp = self.grp_value(cat, idx)
        if not grp:
            return [key]
        members = self._grp_map().get(grp) or [key]
        return [key] + [k for k in members if k != key]

    def expand_with_grp(self, keys):
        """
        Expand a key list so every grp object it touches appears
        whole, partners following the member that pulled them
        in. Order-preserving and duplicate-free.
        """
        out = []
        for key in keys:
            for member in self.grp_members(*key):
                if member not in out:
                    out.append(member)
        return out

    def selection_grp_values(self):
        """The grp values present in the current selection."""
        values = []
        for cat, idx in self.selected_roads:
            grp = self.grp_value(cat, idx)
            if grp and grp not in values:
                values.append(grp)
        return values

    def _pick_key(self, sx, sy):
        """
        The (cat, flat_idx) of the road nearest a screen point,
        or None. Searches within 10 screen pixels, prefers wider
        roads. Candidates come from the spatial index (see
        _pick_candidates) so a click never scans the whole map on
        the UI thread.
        """
        wx, wz = self.screen_to_world(sx, sy)
        # Search radius in world units (10px / zoom)
        radius = 10 / self.zoom

        best = None
        best_dist = float("inf")
        candidates = self._pick_candidates(wx, wz, radius)
        # Check wider roads first
        # (interstate > highway > major_artery > minor_artery > local).
        for cat in CATEGORY_ORDER:
            for idx in candidates:
                rcat, road, rx0, rz0, rx1, rz1 = \
                    self.app.spatial_index.roads[idx]
                if rcat != cat:
                    continue
                # 1.9.19: a record whose delete is still saving
                # in the background is already out of the
                # working copy — the live index lists it only
                # until the worker's rebuild lands, and a pick
                # must never land on a piece that is gone.
                if id(road) in self.app._pending_delete_ids:
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
        return best

    def _pick_road(self, sx, sy):
        """
        Click select: toggle-select the road near the click point.
        Clicking a selected road deselects it; clicking empty
        space clears the selection. 1.9.11: no count cap (Join
        works on chains), and a click on one run of a grp object
        selects — or deselects — the WHOLE object. A successful
        pick also records the click's world point: the 3D still
        pane frames its picture there (player's-eye ruling).
        """
        if not self.app.spatial_index:
            return  # no data yet — nothing to select
        best = self._pick_key(sx, sy)
        if best is None:
            # Clicked empty space: clear the selection.
            self.selected_roads = []
        else:
            key = (best[0], best[1])
            if key in self.selected_roads:
                # Already selected: deselect it — the whole
                # object, when it is one (grp partners leave too).
                drop = set(self.grp_members(*key))
                self.selected_roads = [
                    k for k in self.selected_roads if k not in drop]
            else:
                for member in self.grp_members(*key):
                    if member not in self.selected_roads:
                        self.selected_roads.append(member)
            # The still pane's viewpoint: where he clicked.
            self.last_pick_world = self.screen_to_world(sx, sy)
            self._pick_fresh = True
        self.app.on_roads_selected()
        self.queue_draw()

    def shift_click_add(self, sx, sy):
        """
        Shift+click (1.9.11, Joshua's selection model): ADD the
        piece under the click to the selection — never removes,
        never replaces, and it works mid-flow (the selection
        simply grows; any open panel sees the new contents via
        on_roads_selected). A grp object is added whole.
        """
        if not self.app.spatial_index:
            return
        best = self._pick_key(sx, sy)
        if best is None:
            self.app.set_status(
                "Shift+click adds a piece — that click missed "
                "every road.")
            return
        key = (best[0], best[1])
        added = [m for m in self.grp_members(*key)
                 if m not in self.selected_roads]
        if not added:
            self.app.set_status(
                "That piece is already in the selection.")
            return
        self.selected_roads.extend(added)
        self.last_pick_world = self.screen_to_world(sx, sy)
        self._pick_fresh = True
        self.app.on_roads_selected()
        self.queue_draw()

    def ctrl_click_remove(self, sx, sy):
        """
        Ctrl+click (1.9.11, Joshua's selection model): take the
        ONE piece under the click OUT of the selection (its whole
        grp object, when paired). A Ctrl+click that does not
        land on a selected piece changes nothing — Ctrl+drag is
        rotation, and this only fires for a click that did not
        turn into a drag.
        """
        if not self.app.spatial_index:
            return
        best = self._pick_key(sx, sy)
        if best is None:
            return
        key = (best[0], best[1])
        if key not in self.selected_roads:
            return
        drop = set(self.grp_members(*key))
        self.selected_roads = [
            k for k in self.selected_roads if k not in drop]
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

    def _pick_candidates(self, wx, wz, radius):
        """
        Flat indices of every road whose bounding box reaches the
        search box around (wx, wz), from the spatial index.

        1.9.7 NO-STALL RULE: the pick functions used to scan all
        65,982 records on the UI thread for EVERY click (five
        category passes, with full point-to-polyline distance math
        for every record whose box contained the click — at
        whole-map zoom the 10px tolerance is a ±578-unit net, so
        thousands of roads got the expensive treatment; on Joshua's
        laptop that was the freeze he hit picking Fulton Industrial
        Boulevard in 1.9.5). The spatial index returns exactly the
        records the old scan's bounding-box test would have passed
        (deduplicated, box-filtered), so pick results are unchanged
        — only the wasted work is gone.
        """
        return self.app.spatial_index.query(
            wx - radius, wz - radius, wx + radius, wz + radius)

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
        candidates = self._pick_candidates(wx, wz, radius)
        # Widest roads first (interstate > highway > ... > local).
        for cat in CATEGORY_ORDER:
            for idx in candidates:
                rcat, road, rx0, rz0, rx1, rz1 = \
                    self.app.spatial_index.roads[idx]
                if rcat != cat:
                    continue
                # 1.9.19: same pending-delete skip as
                # _pick_key — a piece whose delete is still
                # saving is gone, for every kind of pick.
                if id(road) in self.app._pending_delete_ids:
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
        # Delete preview (1.9.7): Escape / a tool switch cancels a
        # pending delete — the highlight clears and the camera goes
        # back to where it was before the pick, because the framing
        # was a look, not a move.
        if self.delete_preview is not None:
            self.cancel_delete_preview()
        self.band_drag = None
        self.band_path = None
        self.ctrl_drag = None
        # Draw (1.9.11): a tool switch or Escape abandons a
        # half-drawn line — nothing is added.
        self.draw_drag = None
        # Measure mode (1.9.14): a tool switch abandons a
        # measurement in progress, like the gestures above.
        # (Escape while measuring never reaches here — app.py
        # leaves measure mode first, precisely so this method's
        # selection clear does not eat a selection measure mode
        # promised to leave alone.)
        self.measure_mode = False
        self.measure_points = []
        self.measure_drag = None
        self.measure_live = None
        # A tool switch is his own move: the jump ghost clears.
        self.jump_ghost = None
        self.selected_roads = []
        # 1.9.10: the selection is gone, so any isolation (one
        # piece singled out of it) goes with it.
        self.isolated = None
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
    # Street-jump building ghost (1.9.9)
    # ------------------------------------------------------------------

    # The ghost's colour: a bright cyan no road category uses, so
    # it can never be mistaken for a road.
    GHOST_RGB = (0.35, 0.85, 1.0)

    def clear_jump_ghost(self):
        """Drop the ghost (his own selection/navigation began —
        a stale ghost must not outlive the jump that brought it)."""
        if self.jump_ghost is not None:
            self.jump_ghost = None
            self.queue_draw()

    def _draw_jump_ghost(self, cr):
        """The handed-off building, drawn where it belongs:
        footprint outline (dashed cyan, translucent fill), a
        centre mark, and its name on a dark chip. Reference only."""
        ghost = self.jump_ghost
        if not ghost:
            return
        w = self.get_allocated_width()
        h = self.get_allocated_height()
        fp = ghost.get("footprint") or []
        if len(fp) < 3:
            return
        scr = [self._camera.world_to_screen(px, pz, w, h) for px, pz in fp]
        r, g, b = self.GHOST_RGB
        cr.set_source_rgba(r, g, b, 0.13)
        for k, (sx, sy) in enumerate(scr):
            cr.line_to(sx, sy) if k else cr.move_to(sx, sy)
        cr.close_path()
        cr.fill()
        cr.set_source_rgba(r, g, b, 0.95)
        cr.set_line_width(2.0)
        cr.set_dash([7, 5])
        for k, (sx, sy) in enumerate(scr):
            cr.line_to(sx, sy) if k else cr.move_to(sx, sy)
        cr.close_path()
        cr.stroke()
        cr.set_dash([])
        at = ghost.get("at")
        if at:
            cx, cy = self._camera.world_to_screen(at[0], at[1], w, h)
            cr.set_source_rgba(r, g, b, 0.95)
            cr.arc(cx, cy, 3.0, 0, 2 * math.pi)
            cr.fill()
        name = ghost.get("name") or "Building"
        top_x = sum(p[0] for p in scr) / len(scr)
        top_y = min(p[1] for p in scr)
        cr.select_font_face("Sans", 0, 1)  # normal, bold
        cr.set_font_size(11)
        ext = cr.text_extents(name)
        chip_w = ext.width + 14
        chip_x = max(4, min(top_x - chip_w / 2, w - chip_w - 4))
        chip_y = max(4, top_y - 26)
        cr.set_source_rgba(0, 0, 0, 0.62)
        cr.rectangle(chip_x, chip_y, chip_w, 19)
        cr.fill()
        cr.set_source_rgb(1, 1, 1)
        cr.move_to(chip_x + 7, chip_y + 14)
        cr.show_text(name)

    # ------------------------------------------------------------------
    # Batch selection band drawing (1.9.8)
    # ------------------------------------------------------------------

    def _draw_band(self, cr):
        """
        The Shift+drag feedback while the gesture is in progress:
        the 1.9.8 batch square (translucent) PLUS the pointer's
        actual freeform path (1.9.11) — the path is what makes a
        lasso a lasso, so Joshua can see the line he is drawing
        and whether it has looped back to its start.
        """
        if self.band_drag is None:
            return
        sx, sy, cx, cy = self.band_drag
        x0, x1 = min(sx, cx), max(sx, cx)
        y0, y1 = min(sy, cy), max(sy, cy)
        cr.set_source_rgba(0.35, 0.65, 1.0, 0.16)
        cr.rectangle(x0, y0, x1 - x0, y1 - y0)
        cr.fill()
        cr.set_source_rgba(0.45, 0.75, 1.0, 0.95)
        cr.set_line_width(1.5)
        cr.set_dash([6, 4])
        cr.rectangle(x0, y0, x1 - x0, y1 - y0)
        cr.stroke()
        cr.set_dash([])
        # The freeform path itself, solid and bright.
        path = self.band_path or []
        if len(path) >= 2:
            cr.set_source_rgba(0.55, 0.85, 1.0, 0.95)
            cr.set_line_width(2.0)
            for i, (px, py) in enumerate(path):
                if i == 0:
                    cr.move_to(px, py)
                else:
                    cr.line_to(px, py)
            cr.stroke()
            # Start marker: the spot the path must come back to
            # for the gesture to count as a lasso.
            cr.arc(path[0][0], path[0][1], 4, 0, 2 * math.pi)
            cr.fill()

    def _finish_band(self, band):
        """
        A non-lasso Shift+drag released: hand the square to the
        batch delete flow (the standing 1.9.8 behaviour). The
        square is passed as its four world corners (the view
        may be rotated; the collector tests real geometry).
        """
        sx, sy, cx, cy = band
        if abs(cx - sx) < 6 or abs(cy - sy) < 6:
            self.app.set_status(
                "Shift+drag draws a square to collect pieces "
                "for batch delete.")
            return
        corners = [self.screen_to_world(sx, sy),
                   self.screen_to_world(cx, sy),
                   self.screen_to_world(cx, cy),
                   self.screen_to_world(sx, cy)]
        try:
            self.app.begin_batch_delete(corners)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Shift gestures (1.9.11): Shift+click adds, the lasso selects
    # ------------------------------------------------------------------
    # Joshua's selection model (1.9.9 hands-on, built 1.9.11):
    # Shift is his ADD key. Three releases are possible:
    #   * the pointer barely moved — a Shift+CLICK: add the piece
    #     under it (never removes, works mid-flow);
    #   * the path travelled and LOOPED BACK to its start — the
    #     LASSO: every piece touching or inside the closed line
    #     is ADDED to the selection (selection only — he then
    #     chooses Merge / Join / Delete himself);
    #   * anything else — the standing 1.9.8 batch square.
    # A loop is recognised generously (release within 26 px of
    # the press point, at least 60 px travelled, at least 8
    # recorded points) so a hand-drawn loop counts even when it
    # does not close pixel-perfectly.

    @staticmethod
    def _path_length(path):
        """Total travel of a screen path, in pixels."""
        return sum(math.hypot(b[0] - a[0], b[1] - a[1])
                   for a, b in zip(path, path[1:]))

    def _finish_shift_drag(self, band, path):
        """Resolve a released Shift+drag (see the section note)."""
        sx, sy, cx, cy = band
        path = list(path or [])
        # The release point itself belongs to the path (the last
        # motion event can lag a step behind it).
        if not path or math.hypot(cx - path[-1][0],
                                  cy - path[-1][1]) > 0.5:
            path.append((cx, cy))
        # A click is judged by how far the pointer TRAVELLED in
        # all, never by where it ended: a lasso's whole point is
        # that it ends where it started, so end-to-end distance
        # would call every loop a click.
        travelled = self._path_length(path)
        if travelled < 6:
            # Shift+click: add the piece under the click.
            self.shift_click_add(cx, cy)
            return
        if len(path) >= 8 and travelled >= 60:
            gap = math.hypot(path[-1][0] - path[0][0],
                             path[-1][1] - path[0][1])
            if gap <= 26:
                # The lasso: the path becomes a world polygon
                # (the view may be rotated — screen_to_world
                # honours the heading) and the app collects the
                # pieces inside it in the background.
                polygon = [self.screen_to_world(px, py)
                           for px, py in path]
                try:
                    self.app.begin_lasso_select(polygon)
                except Exception:
                    self.app.set_status(
                        "Lasso: the collection could not start.")
                return
        self._finish_band(band)

    # ------------------------------------------------------------------
    # Draw tool (1.9.11): the drag lays a new road
    # ------------------------------------------------------------------
    # While Draw is active the drag belongs to drawing (panning
    # is disabled — see on_button_press / on_motion). On release
    # the collected points are simplified (Douglas–Peucker, so a
    # steady hand's line keeps its shape and a shaky one loses
    # its noise) and committed through the app's standing save
    # path as ONE new local road.

    @staticmethod
    def _simplify_line(points, tolerance=1.5):
        """
        Douglas–Peucker simplification of a world point list.
        Points within `tolerance` world units of the line between
        their neighbours are dropped; the endpoints always stay.
        Iterative (an explicit stack) so a long drag can never
        hit the recursion limit.
        """
        pts = [tuple(map(float, p)) for p in points]
        if len(pts) <= 2:
            return pts
        keep = {0, len(pts) - 1}
        stack = [(0, len(pts) - 1)]
        while stack:
            lo, hi = stack.pop()
            ax, az = pts[lo]
            bx, bz = pts[hi]
            vx, vz = bx - ax, bz - az
            seg_len = math.hypot(vx, vz)
            worst_i, worst_d = None, tolerance
            for i in range(lo + 1, hi):
                px, pz = pts[i]
                if seg_len < 1e-9:
                    d = math.hypot(px - ax, pz - az)
                else:
                    d = abs(vx * (pz - az) - vz * (px - ax)) \
                        / seg_len
                if d > worst_d:
                    worst_i, worst_d = i, d
            if worst_i is not None:
                keep.add(worst_i)
                stack.append((lo, worst_i))
                stack.append((worst_i, hi))
        return [pts[i] for i in sorted(keep)]

    def _finish_draw(self, raw_points):
        """
        Draw release: simplify the dragged line and add it as a
        new road through the app (which owns the save path and
        the undo step). A click or a tiny scribble adds nothing.
        """
        pts = self._simplify_line(raw_points, tolerance=1.5)
        # Drop any near-duplicate neighbours the simplification
        # left behind, then measure the line: a road needs a
        # real run of ground, not a dot.
        clean = []
        for p in pts:
            if not clean or math.hypot(p[0] - clean[-1][0],
                                       p[1] - clean[-1][1]) >= 0.5:
                clean.append(p)
        length = self._path_length(clean)
        if len(clean) < 2 or length < 5.0:
            self.app.set_status(
                "Draw: drag a longer line to lay a road — "
                "that was too short, so nothing was added.")
            return
        try:
            added = self.app.add_drawn_road(clean)
        except Exception:
            added = False
        if not added:
            self.app.set_status(
                "Draw: the new road could not be added.")

    # ------------------------------------------------------------------
    # Join: combine the selected roads into one road object.
    # (Joshua 2026-10-11: select-first workflow — roads are picked in
    # Select mode, then the Join toolbar button asks for confirmation.
    # 1.9.11: Join works on CHAINS of 2+ pieces — the pair keeps its
    # gate-proven path below; 3+ pieces go through join_chain.)
    # ------------------------------------------------------------------

    def _selected_records(self):
        """
        The selection resolved to (cat, flat_idx, road_dict)
        triples, in selection order — or None when any key no
        longer resolves or one record is somehow selected twice.
        Shared by the chain-join preview and commit so they can
        never disagree about what is selected.
        """
        out = []
        seen_ids = set()
        for cat, idx in self.selected_roads:
            road = self._get_road_dict(cat, idx)
            if road is None or id(road) in seen_ids:
                return None
            if len(road.get("pts", [])) < 2:
                return None
            seen_ids.add(id(road))
            out.append((cat, idx, road))
        return out

    def compute_join_result(self):
        """
        Preview twin of do_join_from_selection: the joined road
        the commit WOULD create, computed read-only for the
        Before/After comparison. Returns (road_a, road_b,
        new_road) or None. Both halves call mergejoin.join_pair
        — the same geometry core — so the preview and the
        commit can never diverge (1.9.10).
        """
        if len(self.selected_roads) != 2:
            return None
        if self.selection_grp_values():
            return None  # grp object: already one piece (1.9.11)
        (cat_a, idx_a), (cat_b, idx_b) = self.selected_roads
        road_a = self._get_road_dict(cat_a, idx_a)
        road_b = self._get_road_dict(cat_b, idx_b)
        if road_a is None or road_b is None or road_a is road_b:
            return None
        pts_a = [list(p) for p in road_a.get("pts", [])]
        pts_b = [list(p) for p in road_b.get("pts", [])]
        if len(pts_a) < 2 or len(pts_b) < 2:
            return None
        res = mergejoin.join_pair(pts_a, pts_b)
        if res is None:
            return None
        joined_pts = [list(p) for p in res["pts"]]
        # Endpoint indices in this file's 0 / -1 convention for
        # the cul-de-sac carry-over.
        ea = 0 if res["a_end"] == 0 else -1
        eb = 0 if res["b_end"] == 0 else -1
        new_road = {"name": road_a.get("name", "Unnamed"),
                    "pts": joined_pts}
        for k, v in road_a.items():
            if k not in new_road:
                new_road[k] = v
        self._carry_cul_de_sac_to_joined(road_a, road_b, ea, eb,
                                         new_road)
        return (road_a, road_b, new_road)

    # ------------------------------------------------------------------
    # Chain Join (1.9.11): 3+ selected pieces become ONE road.
    # mergejoin.join_chain finds every space between the pieces
    # (in chain order, nearest ends) and forms each one with the
    # same form_section the pair join uses — straight or curved
    # as the ends dictate, per Joshua's approved diagrams. The
    # result keeps the FIRST-selected piece's name and category.
    # A selection containing a grp object is refused: those
    # records are already one object, and joining must never
    # disturb the pairing.
    # ------------------------------------------------------------------

    def _carry_cul_de_sac_to_chain(self, records, order, joined_pts,
                                   new_road):
        """
        Chain version of the pair carry-over: only the joined
        road's two OUTER ends can keep a turnaround bulb — every
        inner end is a connection now. `order` is join_chain's
        chain order (indices into `records`); the outer end of
        the first / last piece in the chain is whichever of its
        endpoints the joined line actually starts / ends on.
        """
        new_road.pop("cul_de_sac", None)
        new_road.pop("cul_de_sac_end", None)
        new_road.pop("cul_de_sac_radius", None)
        if not order or len(joined_pts) < 2:
            return

        def outer_end(road, target):
            """'start' / 'end': which of road's ends sits on
            the joined line's point `target`."""
            pts = road.get("pts", [])
            d0 = math.hypot(pts[0][0] - target[0],
                            pts[0][1] - target[1])
            d1 = math.hypot(pts[-1][0] - target[0],
                            pts[-1][1] - target[1])
            return "start" if d0 <= d1 else "end"

        first_road = records[order[0]][2]
        if first_road.get("cul_de_sac") and \
                first_road.get("cul_de_sac_end", "end") == \
                outer_end(first_road, joined_pts[0]):
            new_road["cul_de_sac"] = True
            new_road["cul_de_sac_end"] = "start"
            new_road["cul_de_sac_radius"] = float(
                first_road.get("cul_de_sac_radius",
                               self.CUL_DE_SAC_DEFAULT_RADIUS))
            return
        last_road = records[order[-1]][2]
        if last_road.get("cul_de_sac") and \
                last_road.get("cul_de_sac_end", "end") == \
                outer_end(last_road, joined_pts[-1]):
            new_road["cul_de_sac"] = True
            new_road["cul_de_sac_end"] = "end"
            new_road["cul_de_sac_radius"] = float(
                last_road.get("cul_de_sac_radius",
                               self.CUL_DE_SAC_DEFAULT_RADIUS))

    def compute_join_chain_result(self):
        """
        Preview twin of do_join_chain_from_selection: the joined
        road a chain commit WOULD create, read-only, for the
        Before/After comparison. Returns (records, new_road) —
        records in selection order — or None. Both halves call
        mergejoin.join_chain on the same inputs, so the preview
        and the commit can never diverge.
        """
        if len(self.selected_roads) < 3:
            return None
        if self.selection_grp_values():
            return None  # a grp object is already one piece
        records = self._selected_records()
        if records is None:
            return None
        pieces_pts = [[list(p) for p in road.get("pts", [])]
                      for _c, _i, road in records]
        res = mergejoin.join_chain(pieces_pts)
        if res is None:
            return None
        joined_pts = [list(p) for p in res["pts"]]
        first = records[0][2]
        new_road = {"name": first.get("name", "Unnamed"),
                    "pts": joined_pts}
        for k, v in first.items():
            if k not in new_road:
                new_road[k] = v
        self._carry_cul_de_sac_to_chain(records, res["order"],
                                        joined_pts, new_road)
        return (records, new_road)

    def do_join_chain_from_selection(self):
        """
        Chain Join commit: replace the 3+ selected pieces with
        the single joined road (the app's apply_road_join_multi
        path — one persist, one index rebuild), keeping the
        first-selected piece's name and category. Called after
        Joshua confirms the Join dialog.
        """
        if len(self.selected_roads) < 3:
            return
        if self.selection_grp_values():
            self.app.set_status(
                "Join: a paired object (one piece in several "
                "runs) is already one piece — it can't be joined "
                "again. Nothing was changed.")
            return
        records = self._selected_records()
        count = len(self.selected_roads)
        self.selected_roads = []
        if records is None:
            self.app.set_status(
                "Join failed: a selected road is no longer "
                "available.")
            self.app._update_merge_join_buttons()
            self.queue_draw()
            return
        pieces_pts = [[list(p) for p in road.get("pts", [])]
                      for _c, _i, road in records]
        res = mergejoin.join_chain(pieces_pts)
        if res is None:
            self.app.set_status(
                "Join failed: those pieces could not be chained.")
            self.app._update_merge_join_buttons()
            self.queue_draw()
            return
        joined_pts = [list(p) for p in res["pts"]]
        first_cat, _first_idx, first_road = records[0]
        new_road = {"name": first_road.get("name", "Unnamed"),
                    "pts": joined_pts}
        for k, v in first_road.items():
            if k not in new_road:
                new_road[k] = v
        self._carry_cul_de_sac_to_chain(records, res["order"],
                                        joined_pts, new_road)
        # Undo (Joshua 2026-10-12): one step for the whole chain.
        self.app.undo_begin("Join Roads")
        ok = self.app.apply_road_join_multi(first_cat, records,
                                            new_road)
        if ok:
            kinds = [s["kind"] for s in res["sections"]]
            formed = ", ".join(
                "straight" if k == "straight" else "curved"
                for k in kinds)
            self.app.set_status(
                f"Joined {count} pieces into "
                f"'{new_road['name']}' ({len(joined_pts)} pts; "
                f"{len(kinds)} spaces formed: {formed}).")
        else:
            self.app.set_status(
                "Join failed: could not update road data.")
        self.app.undo_commit()
        self.app._update_merge_join_buttons()
        self.queue_draw()

    def compute_merge_result(self):
        """
        Preview twin of do_merge_from_selection: the source road
        as the merge WOULD leave it, read-only, for the
        Before/After comparison. Returns (road_s, road_t,
        new_road_s) or None. Both halves call
        mergejoin.merge_result — the same geometry core — so
        the preview and the commit can never diverge (1.9.10).
        """
        if len(self.selected_roads) != 2:
            return None
        if self.selection_grp_values():
            return None  # grp object: Merge leaves it alone (1.9.11)
        (cat_s, idx_s), (cat_t, idx_t) = self.selected_roads
        road_s = self._get_road_dict(cat_s, idx_s)
        road_t = self._get_road_dict(cat_t, idx_t)
        if road_s is None or road_t is None or road_s is road_t:
            return None
        pts_s = road_s.get("pts", [])
        pts_t = road_t.get("pts", [])
        if len(pts_s) < 2 or len(pts_t) < 2:
            return None
        res = mergejoin.merge_result(
            pts_s, pts_t, self._road_half_width(cat_t, road_t))
        if res is None:
            return None
        new_s = copy.deepcopy(road_s)
        new_s["pts"] = [list(p) for p in res["new_source_pts"]]
        return (road_s, road_t, new_s)

    def do_join_from_selection(self):
        """
        Join the two selected roads into one road object.
        Called after Joshua confirms the Join dialog. The result keeps
        the first-selected road's name and category; the space
        between the nearest ends is formed (straight or curved,
        as the ends dictate — mergejoin.form_section) and the
        result is a single record.
        """
        if len(self.selected_roads) != 2:
            return
        # One-object rule (1.9.11): a grp piece is already one
        # object — Join must never disturb the pairing.
        if self.selection_grp_values():
            self.app.set_status(
                "Join: a paired object (one piece in several "
                "runs) is already one piece — it can't be joined "
                "again. Nothing was changed.")
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

        # Form the joined line with the shared geometry core
        # (1.9.10, Joshua's diagrams): nearest ends, and the
        # space between them FORMED — straight when the ends
        # run straight, a smooth arc when they bend. The result
        # is ONE road. (Computed before the undo snapshot so a
        # failure here pushes nothing.)
        res = mergejoin.join_pair(pts_a, pts_b)
        if res is None:
            self.app.set_status("Join failed: a road has too few points.")
            self.app._update_merge_join_buttons()
            self.queue_draw()
            return
        joined_pts = [list(p) for p in res["pts"]]
        # Endpoint indices in this file's 0 / -1 convention for
        # the cul-de-sac carry-over.
        ea = 0 if res["a_end"] == 0 else -1
        eb = 0 if res["b_end"] == 0 else -1
        section_kind = res["sections"][0]["kind"]

        # Undo (Joshua 2026-10-12): one undo step for the whole join.
        # (Placed after validation so failed joins push nothing.)
        self.app.undo_begin("Join Roads")

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
            formed = ("formed straight across the space"
                      if section_kind == "straight"
                      else "formed in a curve across the space")
            self.app.set_status(
                f"{name_a} + {name_b} \u2192 {new_road['name']} "
                f"({len(joined_pts)} pts; {formed})")
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
    # (Joshua 2026-10-12: merge was a snap — the source endpoint moved
    # to the nearest point on the target road.)
    # (1.9.10, Joshua 2026-10-23, the approved diagrams supersede the
    # snap for the overshoot case: the part of the source lying over
    # the target is DRAWN BACK to the first of the target's near-edge
    # segments it reaches — segment-based, never the closest point,
    # never the far side — and the source's end section is laid along
    # that edge: straight on a straight edge, following the curve on
    # a curving edge, a mouth along the edge on a diagonal meeting.
    # The geometry lives in mergejoin.merge_result. The plain snap
    # survives there for the case the diagrams do not cover: a source
    # that never reaches the target's edge at all.)
    # ------------------------------------------------------------------

    # Dead-end check tolerance in world units: an endpoint within this
    # distance of another road is not a dead end (cul-de-sac check).
    MERGE_SNAP_TOLERANCE = 50.0

    def _road_half_width(self, cat, road):
        """
        Half a road's world width (its centreline-to-edge
        distance), using the editor's own style table and the
        road's width class — the same numbers the canvas draws
        with. Merge geometry measures the target's edge from
        this.
        """
        style = ROAD_STYLE[normalize_category(cat)]
        wmult = WIDTH_MULT.get(road.get("width_class", "standard"),
                               1.0)
        return style["width"] * wmult / 2.0

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
        The first-selected road is the source, the second is the
        target. The source is drawn back onto the target's near
        edge (mergejoin.merge_result); both roads stay separate
        objects and the target is never modified. Called after
        Joshua confirms the Merge dialog.
        """
        if len(self.selected_roads) != 2:
            return
        # One-object rule (1.9.11): Merge never touches a grp
        # piece — its records are already one object.
        if self.selection_grp_values():
            self.app.set_status(
                "Merge: a paired object (one piece in several "
                "runs) is already one piece — Merge leaves it "
                "as it is. Nothing was changed.")
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
        # The geometry (before the undo snapshot, so a degenerate
        # pair pushes nothing): draw-back onto the near edge, or
        # the standing snap when the source never reaches it.
        res = mergejoin.merge_result(
            pts_s, pts_t, self._road_half_width(cat_t, road_t))
        if res is None:
            self.app.set_status("Merge failed: nothing sensible to merge.")
            self.app._update_merge_join_buttons()
            self.queue_draw()
            return
        # Undo (Joshua 2026-10-12): one undo step for the whole merge.
        self.app.undo_begin("Merge Roads")
        self._do_merge(cat_s, road_s, cat_t, road_t, res)
        self.app.undo_commit()
        self.app._update_merge_join_buttons()
        self.queue_draw()

    def _do_merge(self, cat_s, road_s, cat_t, road_t, res):
        """
        Apply a computed merge (mergejoin.merge_result): replace
        the source's points with the drawn-back line. Only the
        SOURCE changes — the target record is never written
        (its cul-de-sac flags are re-checked, as before, because
        the merge may have closed one of its dead ends; that
        re-check touches flags only, never its line).
        """
        name_s = road_s.get("name") or "Unnamed"
        name_t = road_t.get("name") or "Unnamed"
        road_s["pts"] = [list(p) for p in res["new_source_pts"]]
        if res["kind"] == "edge":
            action = "drawn back onto the near edge"
            if res["mouth_length"] > 0.75:
                action += (f"; its end runs "
                           f"{res['mouth_length']:.0f} m along the edge")
        else:
            # No overshoot: the standing snap.
            action = "snapped onto the target"
        # Cul-de-sac (Joshua 2026-10-11): the moved end is now
        # connected — drop its turnaround bulb if it had one. Also
        # re-check the target road: the merge may have closed one of
        # its dead ends.
        self.refresh_cul_de_sac(cat_s, road_s)
        if self.refresh_cul_de_sac(cat_t, road_t):
            self.app.apply_road_modify(cat_t, road_t)
        # Merge moved points — a geometry edit (1.9.0 re-drape).
        if self.app.apply_road_modify(cat_s, road_s, geometry=True):
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
        # Moving the whole road is a geometry edit (1.9.0 re-drape).
        if self.app.apply_road_modify(cat, road, geometry=True):
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
            # Extend is a geometry edit — re-drape on commit (1.9.0).
            if self.app.apply_road_modify(cat, road, geometry=True):
                self.app.set_status(
                    f"Extended {name} to ({wx:.0f}, {wz:.0f}).")
            else:
                self.app.set_status("Extend failed: could not save.")
            # Undo (Joshua 2026-10-12).
            self.app.undo_commit()
            self.queue_draw()

    # ------------------------------------------------------------------
    # Delete preview (1.9.7). Delete is NOT a tool or a mode: it is
    # the toolbar's Delete action button acting on the current
    # selection (app.on_delete_clicked). The preview methods below
    # are what the button drives.
    #
    # Joshua's live report (2026-10-18): the old flow popped a
    # centred dialog that gave only the road's NAME — the road
    # itself was never highlighted, so the decision was blind. His
    # design: pressing Delete ends any window over the map, the
    # picture minimizes or expands to frame the full selected road
    # with a little surrounding area — "like a screenshot, a
    # photograph of the 2D lines" — the road lights up, and the
    # name + Delete / Cancel present in a slim bar at the map's
    # edge, never over the picture. Cancel restores the view he
    # came from.
    # ------------------------------------------------------------------

    @staticmethod
    def delete_picture_texts(roads):
        """
        The delete bar's line + the status line for a set of
        framed roads — ONE composer for the picture, used when
        the picture opens (_delete_prep_ready) and again whenever
        a piece is added through the After picture (1.9.12, app.
        add_piece_from_after_picture), so the words always
        describe the set exactly as it stands. A set that is one
        grp object says so; a single road is named; several roads
        name the first two and count the rest (the bar stays one
        readable line however long a lasso take runs).
        """
        names = [road.get("name") or "Unnamed"
                 for _c, _i, road in roads]
        grp_vals = [road.get("grp") for _c, _i, road in roads]
        grp_object = len(roads) > 1 and grp_vals[0] \
            and all(g == grp_vals[0] for g in grp_vals)
        if grp_object:
            bar_text = (
                f"Delete '{names[0]}'?  All {len(roads)} runs of "
                "this one object are lit up in pink below — "
                "check them, then choose.")
            status = (
                f"Delete: '{names[0]}' is ONE object in "
                f"{len(roads)} runs — every run is lit up in "
                "pink. Delete it in the bar at the top, or "
                "Cancel to go back.")
        elif len(roads) == 1:
            bar_text = (
                f"Delete '{names[0]}'?  The whole road is lit up "
                "in pink below — check it, then choose.")
            status = (
                f"Delete: '{names[0]}' is lit up in pink — the "
                "whole road. Delete it in the bar at the top, or "
                "Cancel to go back.")
        else:
            named = f"'{names[0]}', '{names[1]}'"
            if len(roads) > 2:
                named += f" and {len(roads) - 2} more"
            bar_text = (
                f"Delete {len(roads)} roads ({named})?  They "
                "are lit up in pink below — check them, then "
                "choose.")
            status = (
                f"Delete: {len(roads)} roads are lit up in pink. "
                "Delete them in the bar at the top, or Cancel to "
                "go back.")
        return bar_text, status

    def begin_delete_preview(self, picked):
        """
        Start the delete preview for the selected roads — WITHOUT
        stalling (1.9.7).

        `picked` is a list of (cat, flat_idx, road_dict) — the
        current selection resolved to records. One road normally;
        1.9.11 selections can hold more (a chain, a lasso take),
        and a grp object arrives as ALL of its runs, so the
        framed picture shows the whole object.

        The Building Editor 2.0.1 pattern: this method (on the UI
        thread) only TAKES THE ORDER — it shows the delete bar in
        its "preparing" state (Cancel live, Delete not yet), starts
        the corner progress bar, and hands the actual geometry
        gathering (every point of every picked road) to a worker
        thread. The framed, lit picture lands via
        _delete_prep_ready when the worker finishes. The app stays
        fully responsive in between: pan, zoom, and Cancel all work
        while a map-spanning road is being prepared.
        """
        if self.delete_preview is not None \
                or self.delete_prep is not None:
            return  # a preview or preparation already owns the bar
        if getattr(self.app, "_delete_apply_in_flight", 0) > 0:
            # One delete flight at a time (1.9.19): a preview
            # opened now would be decided against a world whose
            # save is still in the background.
            self.app.set_status(
                "A delete is still saving in the background — "
                "give it a moment, then delete.")
            return
        roads = [(cat, idx, road) for cat, idx, road in picked
                 if len(road.get("pts", [])) >= 2]
        if not roads:
            # Degenerate records have no line to show; still never
            # delete blind — say so and stop.
            self.app.set_status(
                "Delete: that road has no line to show; "
                "it was not deleted.")
            return
        names = [road.get("name") or "Unnamed"
                 for _c, _i, road in roads]
        # One-object rule (1.9.11): when every record in the
        # picture shares one grp value, the picture is ONE
        # object in several runs — the bar and the status say
        # so, in those words, so the decision is never mistaken
        # for deleting several separate roads.
        grp_vals = [road.get("grp") for _c, _i, road in roads]
        grp_object = len(roads) > 1 and grp_vals[0] \
            and all(g == grp_vals[0] for g in grp_vals)
        self._delete_prep_token += 1
        token = self._delete_prep_token
        self.delete_prep = {"token": token, "roads": roads,
                            "names": names,
                            "grp_object": bool(grp_object),
                            # 1.9.12: the selection as it stands when
                            # the picture opens. Pieces added through
                            # the After picture join the selection
                            # (see app.add_piece_from_after_picture);
                            # Cancel restores THIS selection, so an
                            # abandoned decision leaves nothing
                            # half-changed behind.
                            "prev_selection":
                                list(self.selected_roads)}
        if grp_object:
            prep_text = (f"Preparing '{names[0]}' "
                         f"({len(roads)} runs, one object)…")
            job_label = f"Preparing '{names[0]}'"
        elif len(roads) == 1:
            prep_text = f"Preparing '{names[0]}'…"
            job_label = f"Preparing '{names[0]}'"
        else:
            prep_text = f"Preparing {len(roads)} roads…"
            job_label = f"Preparing {len(roads)} roads"
        # The bar goes up NOW, in preparing state, so Cancel is
        # reachable from the first moment (Joshua's incident: he
        # could not even reach Cancel during the 1.9.5 stall).
        self.app.show_delete_bar(prep_text, ready=False)
        self.app.progress_start("delete-prep", job_label)
        self.app.set_status(
            "Delete: preparing the picture… "
            "Cancel in the bar at the top stops it.")

        def report(frac):
            # Worker -> UI thread hop for the progress bar.
            GLib.idle_add(self.app.progress_update,
                          "delete-prep", frac)

        def worker():
            try:
                bbox = self._gather_delete_geometry(roads, report)
            except Exception:
                bbox = None  # ready handler reports the failure
            GLib.idle_add(self._delete_prep_ready, token, bbox)

        threading.Thread(target=worker, daemon=True).start()

    def _gather_delete_geometry(self, roads, report):
        """
        Worker-thread half of the delete preview: walk every point
        of every picked road and compute the union bounding box
        plus the framing pad. Pure reads of the road records (which
        nothing mutates during a preparation) — safe off the UI
        thread. report(fraction) fires as points are consumed, so
        the corner progress bar shows REAL progress. Returns
        (min_x, min_z, max_x, max_z, pad), or None if the roads
        somehow hold no points.
        """
        total = sum(len(road.get("pts", []))
                    for _c, _i, road in roads)
        if total == 0:
            return None
        done_pts = 0
        min_x = min_z = float("inf")
        max_x = max_z = float("-inf")
        pad = 6.0
        for cat, _idx, road in roads:
            style = ROAD_STYLE[normalize_category(cat)]
            wmult = WIDTH_MULT.get(
                road.get("width_class", "standard"), 1.0)
            pad = max(pad, style["width"] * wmult / 2.0 + 6.0)
            pts = road.get("pts", [])
            for i, p in enumerate(pts):
                if p[0] < min_x:
                    min_x = p[0]
                if p[0] > max_x:
                    max_x = p[0]
                if p[1] < min_z:
                    min_z = p[1]
                if p[1] > max_z:
                    max_z = p[1]
                if i % 64 == 63:
                    report((done_pts + i + 1) / total)
            done_pts += len(pts)
        report(1.0)
        return (min_x, min_z, max_x, max_z, pad)

    def _delete_prep_ready(self, token, bbox):
        """
        UI-thread landing for a finished preparation (idle_add).

        Drops stale results (a preparation Joshua already
        cancelled). Otherwise: remembers the camera as it is RIGHT
        NOW (the spot he is looking at when the picture appears —
        Cancel restores exactly that), frames the roads' FULL
        combined extent (padded so the fat highlight stroke is
        never clipped by the frame), flips the delete bar to its
        decision state, and clears the progress bar.
        """
        prep = self.delete_prep
        if prep is None or prep["token"] != token:
            return False  # cancelled while gathering — drop it
        self.delete_prep = None
        self.app.progress_finish("delete-prep")
        roads = prep["roads"]
        if bbox is None:
            self.app.hide_delete_bar()
            self.app.set_status(
                "Delete: could not prepare that road; "
                "nothing was deleted.")
            return False
        min_x, min_z, max_x, max_z, pad = bbox
        self.delete_preview = {
            "roads": roads,
            # 1.9.8: prev_cam carries the heading too — Cancel
            # restores the view EXACTLY, rotation included.
            "prev_cam": (self.cam_x, self.cam_y, self.zoom,
                         self.rotation),
            # 1.9.12: selection snapshot (see begin_delete_
            # preview) — Cancel restores it exactly.
            "prev_selection": prep.get("prev_selection",
                                       list(self.selected_roads)),
            # 1.9.15: the padded rect this picture frames, and
            # the camera the framing produced. A canvas resize
            # re-fits THIS rect (reframe_delete_preview) — but
            # only while the camera still equals framed_cam, so a
            # view Joshua panned himself mid-decision is never
            # yanked back.
            "frame_rect": (min_x - pad, min_z - pad,
                           max_x + pad, max_z + pad),
        }
        inset = self._delete_top_inset()
        self.frame_rect(min_x - pad, min_z - pad,
                        max_x + pad, max_z + pad,
                        top_inset=inset)
        self.delete_preview["framed_cam"] = (
            self.cam_x, self.cam_y, self.zoom, self.rotation)
        # What the framing was fitted against (1.9.15): the
        # passive refit compares against these, so a cosmetic
        # wobble — the bar growing a few px because its text
        # changed — never re-shoots the stills.
        _alloc = self.get_allocation()
        self.delete_preview["framed_size"] = (_alloc.width,
                                              _alloc.height)
        self.delete_preview["framed_inset"] = inset
        self.delete_preview["framed_at"] = time.monotonic()
        bar_text, status = self.delete_picture_texts(roads)
        self.app.show_delete_bar(bar_text, ready=True)
        self.app.set_status(status)
        # Before/After caveat (1.9.8): the companion panes switch
        # to the comparison stills for this decision.
        try:
            self.app.on_delete_preview_begin(roads)
        except Exception:
            pass
        self.queue_draw()
        return False

    # -- delete picture: refit on resize (1.9.15) -------------------

    def _delete_top_inset(self):
        """
        The top inset a delete framing must respect: the delete
        bar's REAL height once it is on screen (its label wraps
        at narrow widths since 1.9.15, so the bar can stand
        taller than the classic strip), never less than the
        standing DELETE_BAR_H allowance.
        """
        inset = DELETE_BAR_H
        bar = getattr(self.app, "delete_bar", None)
        if bar is not None and bar.get_visible():
            inset = max(inset, bar.get_allocated_height())
        return inset

    def _on_canvas_size_allocate(self, _widget, _alloc):
        """
        The canvas changed size (window resized, a pane divider
        dragged). While a delete picture is up, its framing was
        fitted to the OLD size — schedule a refit so the whole
        road stays in the photograph at the new size (Joshua
        2026-10-25: the delete viewport "is not adjusting to
        the viewport being resized" — at a smaller window the
        framed road ran off the top and bottom edges).
        """
        if self.delete_preview is not None:
            self._schedule_delete_reframe()

    def _schedule_delete_reframe(self):
        """
        Coalesce refits the stills way: a resize drag fires a
        stream of allocations; ONE refit lands shortly after
        they settle (the app's layout saves debounce the same
        way). Also called when the delete bar itself changes
        height (its wrapped label), because the framing's top
        inset follows the bar.
        """
        if getattr(self, "_delete_reframe_id", None):
            return
        self._delete_reframe_id = GLib.timeout_add(
            180, self._run_delete_reframe)

    def _run_delete_reframe(self):
        self._delete_reframe_id = None
        self.reframe_delete_preview()
        return False

    def _framed_camera_intact(self, pv):
        """True while the camera still stands exactly where the
        delete framing put it (Joshua has not panned/zoomed the
        picture himself since)."""
        fc = pv.get("framed_cam")
        if fc is None:
            return True
        return (abs(self.cam_x - fc[0]) < 1e-9
                and abs(self.cam_y - fc[1]) < 1e-9
                and abs(self.zoom - fc[2]) < 1e-12
                and abs(self.rotation - fc[3]) < 1e-9)

    def reframe_delete_preview(self, force=False, sync_compare=True):
        """
        Re-fit the open delete picture to the canvas's CURRENT
        size: the same padded rect, framed again below the
        delete bar's current height, and the Before/After panes
        re-shot from the reframed camera (one render each, via
        the app) so all three pictures stay the same photograph
        — and the After picture's click-to-add mapping, which
        resolves through that same camera at the pane's live
        size, stays true.

        A passive refit (a resize) only happens while the
        framing is untouched: if Joshua panned or zoomed the
        picture himself mid-decision, his view is his — a
        resize never yanks it back. (force=True overrides the
        guard; nothing automatic uses it.)

        Adding a piece through the After picture deliberately
        does NOT refit (the 1.9.12 design, gate-proven): the
        new piece lights up in the Before picture at the SAME
        framing he clicked in — a partner record can sit
        kilometres away, and refitting to include it would
        destroy the picture he is studying.
        prev_cam / prev_selection are never touched here —
        Cancel still restores exactly what it restored before.
        """
        pv = self.delete_preview
        if pv is None or "frame_rect" not in pv:
            return False
        if not force and not self._framed_camera_intact(pv):
            return False
        # Materiality (1.9.15): a passive refit needs a real
        # change — the canvas SIZE changed (a window resize, a
        # pane drag), or the bar's height moved by 8+ px (a
        # wrapped second line) during the brief settle right
        # after the picture opened, when the bar's final text
        # is still finding its height. Bar growth LATER is the
        # message changing because a piece was added — and an
        # add must never move the picture (the 1.9.12 law the
        # delete gates enforce: one still render per add, the
        # framing untouched).
        alloc = self.get_allocation()
        size_now = (alloc.width, alloc.height)
        inset_now = self._delete_top_inset()
        size_changed = pv.get("framed_size") != size_now
        inset_changed = abs(
            inset_now - pv.get("framed_inset", inset_now)) >= 8
        settling = (time.monotonic()
                    - pv.get("framed_at", 0.0)) < 0.6
        if not force and not (size_changed
                              or (inset_changed and settling)):
            return False
        x0, z0, x1, z1 = pv["frame_rect"]
        self.frame_rect(x0, z0, x1, z1, top_inset=inset_now)
        pv["framed_cam"] = (self.cam_x, self.cam_y, self.zoom,
                            self.rotation)
        pv["framed_size"] = size_now
        pv["framed_inset"] = inset_now
        pv["framed_at"] = time.monotonic()
        if sync_compare:
            try:
                self.app.resync_delete_compare()
            except Exception:
                pass
        return True

    def cancel_delete_preview(self):
        """
        Cancel a pending delete — at ANY stage.

        During preparation (the picture hasn't landed yet): abandon
        the gathering (its late result will be dropped by token),
        clear the progress bar and the bar. The camera is NOT
        touched — the app never moved it, and any panning Joshua
        did while waiting stands.

        Once the preview is up: clear the highlight, hide the bar,
        and restore the camera to exactly where it was when the
        picture appeared. Nothing is deleted; the framing was only
        a look.
        """
        if self.delete_prep is not None:
            self._delete_prep_token += 1  # invalidate the worker
            self.delete_prep = None
            self.app.progress_finish("delete-prep")
            try:
                self.app.hide_delete_bar()
            except Exception:
                pass  # bar not built yet (early init)
            try:
                self.app.set_status(
                    "Delete cancelled — nothing was removed.")
            except Exception:
                pass  # status bar not built yet during early init
            return
        pv = self.delete_preview
        if pv is None:
            return
        self.delete_preview = None
        try:
            self.app.hide_delete_bar()
        except Exception:
            pass  # bar not built yet (early init) — nothing to hide
        cam_x, cam_y, zoom, rotation = pv["prev_cam"]
        self.cam_x, self.cam_y, self.zoom = cam_x, cam_y, zoom
        self.rotation = rotation
        # 1.9.12: pieces added through the After picture joined
        # the selection while the picture was up — Cancel puts
        # the selection back to exactly what it was when the
        # picture opened, so nothing half-changed leaks out of
        # an abandoned decision. (The data was never touched.)
        prev_sel = pv.get("prev_selection")
        if prev_sel is not None \
                and list(self.selected_roads) != list(prev_sel):
            self.selected_roads = list(prev_sel)
            try:
                self.app.on_roads_selected()
            except Exception:
                pass
        # Comparison over (cancel): panes revert to synced views.
        try:
            self.app.on_delete_preview_end()
        except Exception:
            pass
        try:
            self.app.set_status(
                "Delete cancelled — nothing was removed.")
        except Exception:
            pass  # status bar not built yet during early init
        self.queue_draw()
        self._notify_camera_changed()

    def confirm_delete_preview(self):
        """
        Confirm a pending delete from the bar's Delete button.

        Removes exactly the records the highlight framed and
        clears the preview. The view STAYS framed on the spot —
        calmer than jumping back — so Joshua sees the roads
        vanish from the picture he was just shown.

        1.9.19: the commit is the app's ONE batched async apply
        (the old code looped the single-delete apply once per
        record, and each apply re-saved and re-indexed the
        WHOLE map on this thread — an 18-piece delete froze the
        app for minutes on Joshua's laptop). The records come
        out of the working copy at once, the undo entry is the
        app's delete delta, and the save + index rebuild finish
        in the background under the corner progress bar; the
        status line reports when the save lands.
        """
        pv = self.delete_preview
        if pv is None:
            return
        roads = pv["roads"]
        self.delete_preview = None
        self.app.hide_delete_bar()
        picked = [(cat, road) for cat, _idx, road in roads]

        def landed(ok, _n):
            # The same outcome wording this confirm has always
            # carried — now spoken when the background save
            # lands (seconds, under the progress bar).
            # One-object rule (1.9.11): a whole grp object
            # reports as what it was — one object, however
            # many runs.
            grp_vals = [road.get("grp") for _c, _i, road in roads]
            grp_object = len(roads) > 1 and grp_vals[0] \
                and all(g == grp_vals[0] for g in grp_vals)
            if ok and grp_object:
                name = roads[0][2].get("name") or "Unnamed"
                self.app.set_status(
                    f"Deleted one object: {name} "
                    f"({len(roads)} runs).")
            elif ok and len(roads) == 1:
                name = roads[0][2].get("name") or "Unnamed"
                self.app.set_status(f"Deleted road: {name}.")
            elif ok:
                self.app.set_status(f"Deleted {len(roads)} roads.")
            else:
                self.app.set_status("Delete failed: could not save.")

        self.app.apply_road_delete_batch_async(
            picked, "Delete Road", on_landed=landed)
        # Comparison over (confirmed): panes revert to the normal
        # synced views, which now show the post-delete world.
        # (After the apply call, as before 1.9.19: the apply has
        # already cleared the selection by this line, so the
        # Pieces panel resync inside sees the post-delete state.)
        try:
            self.app.on_delete_preview_end()
        except Exception:
            pass
        self.queue_draw()
