#!/usr/bin/env python3
"""
Adamsville Terrain Editor (Native) — 3D terrain viewport widgets.

Three synchronized 3D views of the same heightfield (Joshua 2026-10-11):
  TopDownView    — orthographic map view, looking straight down.
  SideView       — profile/elevation view: layered ridge silhouettes.
  PlayerEyeView  — first-person perspective, ~6 units above the ground,
                   showing what the player would see in-game.

The terrain renders as shaded 3D faces with natural light shading —
NO elevation heatmap. Roads drape over the terrain as visual guides
only: they are never clickable and never edited directly.

Editing model (Joshua's spec):
  1. Select faces: drag a selection box, or Shift+click single faces.
  2. Selected faces highlight amber (UNLOCKED = dashed outline).
  3. Click empty terrain to LOCK the selection in (solid amber).
  4. Grab the locked selection and drag UP/DOWN to change elevation.
  5. Vertical movement only — no rotation, no sideways moves.

Terrain-road grouping (Joshua 2026-10-11): when the "Move terrain only"
checkbox is OFF, road points above the selected faces move up/down with
the terrain (Blender-style grouping). Offsets are non-destructive.

Pure Python + GTK3 + Cairo. NO webview, NO HTML, NO JavaScript.

Joshua's rule: all code commented.
"""

import math
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk

# Data layer: heightfield, selection, road offsets, grid constants.
import data as _data
from data import (
    TSX, TSZ, CELL_X, CELL_Z, WORLD_W, WORLD_H,
)


# ---------------------------------------------------------------------------
# Render constants
# ---------------------------------------------------------------------------

# Full-res grid is 150x200. Viewports draw every STEPth vertex:
# coarser for speed, while EDITS always apply at full resolution.
MESH_STEP = 4    # top-down + side views -> 38 x 50 quads/rows
EYE_STEP = 8     # player's-eye view  -> 19 x 25 quads (depth-sorted)

# Natural terrain base color (NOT a heatmap): muted grass-dirt tone.
# Faces are shaded by their normal vector against a sun direction.
GROUND_RGB = (0.44, 0.46, 0.32)

# Selection highlight color: amber.
SEL_RGB = (1.0, 0.75, 0.15)

# Sun direction (points TOWARD the sun). Normalized once at import.
_SUN_LEN = math.sqrt(0.45 ** 2 + 0.9 ** 2 + 0.35 ** 2)
SUN = (-0.45 / _SUN_LEN, 0.9 / _SUN_LEN, -0.35 / _SUN_LEN)

# Road overlay colors by category (same scheme as the map editor).
ROAD_COLORS = {
    "highway":  (1.0, 0.27, 0.27),   # red
    "arterial": (1.0, 0.67, 0.0),    # orange
    "local":    (0.55, 0.55, 0.55),  # gray
}
# Base road widths in screen px (top view scales these with zoom).
ROAD_WIDTHS = {"highway": 3.0, "arterial": 2.0, "local": 1.0}

# Vertical drag sensitivity for views without a true height axis:
# height units gained per screen pixel dragged upward.
LIFT_PX_SCALE = 0.25

# Hard clamps for lifted terrain (keeps the heightfield sane).
H_MIN, H_MAX = -100.0, 300.0


class Terrain3DView(Gtk.DrawingArea):
    """
    Shared base for the three terrain viewports.

    Holds references to the app (for shared state: heightfield, selection,
    roads, grouping flag) and implements the face-shading math plus the
    grab-and-lift editing operation used by all views.
    """

    def __init__(self, app):
        """app is the TerrainEditorApp (shared state lives there)."""
        super().__init__()
        self.app = app
        self.hf = app.heightfield
        self.sel = app.selection

        # Lift-drag state (grab the locked selection, drag up/down).
        self._lifting = False
        self._lift_olds = {}       # (ix, iz) -> height at grab time
        self._lift_road_olds = {}  # road key -> offset at grab time
        self._lift_start_y = 0.0   # screen y where the grab started
        self._lift_dh = 0.0        # current total height delta

        # Pan-drag state (middle button, right button, or Pan tool).
        self._panning = False
        self._pan_start = (0, 0)

        self.set_can_focus(True)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK |
                        Gdk.EventMask.BUTTON_RELEASE_MASK |
                        Gdk.EventMask.POINTER_MOTION_MASK |
                        Gdk.EventMask.SCROLL_MASK)
        self.connect("draw", self.on_draw)
        self.connect("button-press-event", self.on_button_press)
        self.connect("button-release-event", self.on_button_release)
        self.connect("motion-notify-event", self.on_motion)
        self.connect("scroll-event", self.on_scroll)

    # ------------------------------------------------------------------
    # Shared helpers
    # ------------------------------------------------------------------

    def roads(self):
        """Road overlay data (dict), or None when not downloaded."""
        return self.app.roads_data

    def show_roads(self):
        """Whether the roads overlay is enabled."""
        return self.app.show_roads and self.roads() is not None

    def road_elev(self, key, wx, wz):
        """
        Elevation of a road point: sampled terrain height plus its
        grouping offset (0 when terrain and roads move independently).
        """
        return self.hf.sample(wx, wz) + self.app.road_offsets.get(key)

    def face_shade(self, ix, iz):
        """
        Light shading factor for the terrain face at grid cell (ix, iz).

        Computes the face normal from neighbor heights and dots it with
        the sun direction: flat ground ~0.93, slopes facing the sun
        brighter, slopes facing away darker.
        """
        hL = self.hf.height(ix - 1, iz)
        hR = self.hf.height(ix + 1, iz)
        hD = self.hf.height(ix, iz - 1)
        hU = self.hf.height(ix, iz + 1)
        dx = (hR - hL) / (2.0 * CELL_X)
        dz = (hU - hD) / (2.0 * CELL_Z)
        inv = 1.0 / math.sqrt(dx * dx + 1.0 + dz * dz)
        nx, ny, nz = -dx * inv, inv, -dz * inv
        d = nx * SUN[0] + ny * SUN[1] + nz * SUN[2]
        return 0.55 + 0.45 * max(0.0, d)

    def ground_rgb(self, ix, iz, shade):
        """
        Natural terrain color for a face: base grass-dirt tone modulated
        by light shading, with a SUBTLE elevation lighten (up to +8% at
        max height) — readable, but not a rainbow heatmap.
        """
        h = self.hf.height(ix, iz)
        span = max(1.0, self.hf.max_h - self.hf.min_h)
        t = max(0.0, min(1.0, (h - self.hf.min_h) / span))
        lift = 1.0 + 0.08 * t
        r, g, b = GROUND_RGB
        return (min(1.0, r * shade * lift),
                min(1.0, g * shade * lift),
                min(1.0, b * shade * lift))

    def sel_quad_keys(self, step):
        """Downsampled quad keys covering the selection (for highlight)."""
        return self.sel.quad_keys(step)

    # ------------------------------------------------------------------
    # Lift operation (shared): grab locked selection, drag up/down
    # ------------------------------------------------------------------

    def lift_scale(self):
        """
        Height units per screen pixel of vertical drag. Views with a
        true height axis (side view) override this with an exact value.
        """
        return LIFT_PX_SCALE

    def lift_begin(self, event):
        """
        Start a lift drag. Records pre-drag heights (terrain + grouped
        road offsets) so the whole drag commits as ONE undo step.
        Call only when the press hit the locked selection.
        """
        self._lift_olds = {c: self.hf.height(c[0], c[1])
                           for c in self.sel.cells}
        self._lift_road_olds = {}
        if not self.app.move_terrain_only:
            # Grouped mode: road points above selected faces move too.
            for c in self.sel.cells:
                for (key, _wx, _wz) in self.app.road_cell_index.get(c, ()):
                    if key not in self._lift_road_olds:
                        self._lift_road_olds[key] = \
                            self.app.road_offsets.get(key)
        self._lift_start_y = event.y
        self._lift_dh = 0.0
        self._lifting = True

    def lift_update(self, event):
        """Apply the current drag delta (vertical only) to the selection."""
        dh = (self._lift_start_y - event.y) * self.lift_scale()
        self._lift_dh = dh
        for (ix, iz), old in self._lift_olds.items():
            nh = old + dh
            self.hf.set_height(ix, iz,
                               max(H_MIN, min(H_MAX, nh)))
        if not self.app.move_terrain_only:
            for key, old_off in self._lift_road_olds.items():
                self.app.road_offsets.set(key, old_off + dh)
        self.app.update_status()

    def lift_end(self):
        """
        Finish a lift drag: commit terrain + road offsets as ONE undo
        step and save. No-op when nothing actually moved.
        """
        if not self._lifting:
            return
        self._lifting = False
        if abs(self._lift_dh) > 0.001:
            n = len(self._lift_olds)
            self.hf.commit("Move %d faces %+.1f" % (n, self._lift_dh),
                           dict(self._lift_olds),
                           dict(self._lift_road_olds) or None)
            if not self.app.move_terrain_only:
                self.app.road_offsets.save()
        self._lift_olds = {}
        self._lift_road_olds = {}
        self._lift_dh = 0.0
        self.app.redraw_all()
        self.app.update_status()

    # ------------------------------------------------------------------
    # Event stubs — subclasses implement their own camera + hit testing
    # ------------------------------------------------------------------

    def on_draw(self, widget, cr):
        """Subclasses render their projection here."""
        return False

    def on_button_press(self, widget, event):
        """Subclasses implement tool handling here."""
        return False

    def on_button_release(self, widget, event):
        """Subclasses implement tool handling here."""
        return False

    def on_motion(self, widget, event):
        """Subclasses implement tool handling here."""
        return False

    def on_scroll(self, widget, event):
        """Subclasses implement zoom here."""
        return False

    def fit_view(self):
        """Subclasses frame their default camera here."""
        pass


# ---------------------------------------------------------------------------
# Top-down view — orthographic map projection, looking straight down
# ---------------------------------------------------------------------------

class TopDownView(Terrain3DView):
    """
    Map-style viewport: world X -> screen X, world Z -> screen Y.

    This is the primary SELECTION view: drag a box to select faces,
    Shift+click to toggle single faces, grab the locked selection to
    lift it. The Level tool also draws its rectangle here.
    """

    def __init__(self, app):
        """Set up the top-down camera (centered, fit later)."""
        super().__init__(app)
        self.cam_x = WORLD_W / 2.0
        self.cam_z = WORLD_H / 2.0
        self.zoom = 0.06  # screen px per world unit (fit_view sets it)

        # Selection rubber band: (sx0, sy0, sx1, sy1) screen px, or None.
        self._rubber = None
        self._rubber_shift = False
        # Level tool rectangle (world coords), or None.
        self.level_rect = None

    # -- camera ---------------------------------------------------------

    def world_to_screen(self, wx, wz):
        """World (x, z) -> screen pixels."""
        alloc = self.get_allocation()
        return ((wx - self.cam_x) * self.zoom + alloc.width / 2.0,
                (wz - self.cam_z) * self.zoom + alloc.height / 2.0)

    def screen_to_world(self, sx, sy):
        """Screen pixels -> world (x, z)."""
        alloc = self.get_allocation()
        return ((sx - alloc.width / 2.0) / self.zoom + self.cam_x,
                (sy - alloc.height / 2.0) / self.zoom + self.cam_z)

    def fit_view(self):
        """Frame the whole world."""
        alloc = self.get_allocation()
        if alloc.width < 10:
            return
        self.zoom = min(alloc.width / (WORLD_W * 1.05),
                        alloc.height / (WORLD_H * 1.05))
        self.cam_x = WORLD_W / 2.0
        self.cam_z = WORLD_H / 2.0
        self.queue_draw()

    def cell_at(self, sx, sy):
        """Full-res grid cell under a screen point, or None if outside."""
        wx, wz = self.screen_to_world(sx, sy)
        if not (0 <= wx <= WORLD_W and 0 <= wz <= WORLD_H):
            return None
        return (max(0, min(TSX - 1, int(wx / CELL_X))),
                max(0, min(TSZ - 1, int(wz / CELL_Z))))

    # -- drawing --------------------------------------------------------

    def on_draw(self, widget, cr):
        """Render shaded terrain quads, selection, roads, rubber band."""
        alloc = self.get_allocation()
        W, H = alloc.width, alloc.height
        # Dark backdrop.
        cr.set_source_rgb(0.10, 0.10, 0.14)
        cr.paint()
        if W < 10 or self.hf.base is None:
            return

        S = MESH_STEP
        # Visible world bounds -> downsampled quad index range.
        x0w, z0w = self.screen_to_world(0, 0)
        x1w, z1w = self.screen_to_world(W, H)
        qx0 = max(0, (int(x0w / CELL_X) // S) * S)
        qx1 = min(TSX - 1, int(x1w / CELL_X) + S)
        qz0 = max(0, (int(z0w / CELL_Z) // S) * S)
        qz1 = min(TSZ - 1, int(z1w / CELL_Z) + S)

        # ---- Terrain faces ----
        # Orthographic straight-down: each quad is an axis-aligned rect.
        qw = S * CELL_X * self.zoom
        qh = S * CELL_Z * self.zoom
        for qz in range(qz0, qz1 + 1, S):
            for qx in range(qx0, qx1 + 1, S):
                sx = (qx * CELL_X - self.cam_x) * self.zoom + W / 2.0
                sy = (qz * CELL_Z - self.cam_z) * self.zoom + H / 2.0
                if sx + qw < 0 or sx > W or sy + qh < 0 or sy > H:
                    continue
                r, g, b = self.ground_rgb(qx, qz, self.face_shade(qx, qz))
                cr.set_source_rgb(r, g, b)
                # +0.6 overlap avoids hairline gaps between quads.
                cr.rectangle(sx, sy, qw + 0.6, qh + 0.6)
                cr.fill()

        # ---- Selection highlight ----
        sel_quads = self.sel_quad_keys(S)
        if sel_quads:
            if self.sel.locked:
                # Locked in: solid amber wash so Joshua sees the lift target.
                cr.set_source_rgba(SEL_RGB[0], SEL_RGB[1], SEL_RGB[2], 0.55)
                for (qx, qz) in sel_quads:
                    sx = (qx * CELL_X - self.cam_x) * self.zoom + W / 2.0
                    sy = (qz * CELL_Z - self.cam_z) * self.zoom + H / 2.0
                    if -qw < sx < W and -qh < sy < H:
                        cr.rectangle(sx, sy, qw + 0.6, qh + 0.6)
                        cr.fill()
            else:
                # Not yet confirmed: dashed amber outline (proposed).
                cr.set_source_rgb(*SEL_RGB)
                cr.set_line_width(2.0)
                cr.set_dash([7.0, 5.0])
                for (qx, qz) in sel_quads:
                    sx = (qx * CELL_X - self.cam_x) * self.zoom + W / 2.0
                    sy = (qz * CELL_Z - self.cam_z) * self.zoom + H / 2.0
                    if -qw < sx < W and -qh < sy < H:
                        cr.rectangle(sx, sy, qw + 0.6, qh + 0.6)
                        cr.stroke()
                cr.set_dash([])

        # ---- Roads overlay (VISUAL ONLY — never clickable, never edited) --
        if self.show_roads():
            self._draw_roads(cr, W, H, x0w, z0w, x1w, z1w)

        # ---- Level tool rectangle ----
        if self.level_rect and self.app.active_tool == "level":
            x0, z0, x1, z1 = self.level_rect
            sx0, sy0 = self.world_to_screen(min(x0, x1), min(z0, z1))
            sx1, sy1 = self.world_to_screen(max(x0, x1), max(z0, z1))
            cr.set_source_rgba(1.0, 1.0, 0.0, 0.25)
            cr.rectangle(sx0, sy0, sx1 - sx0, sy1 - sy0)
            cr.fill()
            cr.set_source_rgb(1.0, 1.0, 0.0)
            cr.set_line_width(2.0)
            cr.set_dash([8.0, 4.0])
            cr.rectangle(sx0, sy0, sx1 - sx0, sy1 - sy0)
            cr.stroke()
            cr.set_dash([])

        # ---- Selection rubber band ----
        if self._rubber:
            sx0, sy0, sx1, sy1 = self._rubber
            cr.set_source_rgba(SEL_RGB[0], SEL_RGB[1], SEL_RGB[2], 0.15)
            cr.rectangle(min(sx0, sx1), min(sy0, sy1),
                         abs(sx1 - sx0), abs(sy1 - sy0))
            cr.fill()
            cr.set_source_rgb(*SEL_RGB)
            cr.set_line_width(1.5)
            cr.set_dash([6.0, 4.0])
            cr.rectangle(min(sx0, sx1), min(sy0, sy1),
                         abs(sx1 - sx0), abs(sy1 - sy0))
            cr.stroke()
            cr.set_dash([])
        return False

    def _draw_roads(self, cr, W, H, x0w, z0w, x1w, z1w):
        """
        Draw road polylines draped on the map. Display-only: no hit
        testing is ever performed on roads, so clicks pass through.
        In grouped mode (Move terrain only OFF), road segments above the
        current selection draw highlighted to show they will lift together.
        """
        grouped = not self.app.move_terrain_only
        zoom_k = max(0.5, self.zoom / 0.06)
        for cat in ("local", "arterial", "highway"):
            color = ROAD_COLORS[cat]
            width = ROAD_WIDTHS[cat] * zoom_k
            for road in self.roads().get(cat, []):
                pts = road.get("pts", [])
                if len(pts) < 2:
                    continue
                # Cull + project.
                spts = []
                for (px, pz) in pts:
                    if (px < x0w - 200 or px > x1w + 200 or
                            pz < z0w - 200 or pz > z1w + 200):
                        spts.append(None)  # break the polyline
                        continue
                    spts.append(self.world_to_screen(px, pz))
                # Base polyline.
                cr.set_source_rgb(*color)
                cr.set_line_width(width)
                started = False
                for sp in spts:
                    if sp is None:
                        started = False
                        continue
                    if not started:
                        cr.move_to(*sp)
                        started = True
                    else:
                        cr.line_to(*sp)
                cr.stroke()
                # Grouped highlight: segments whose points sit on selected
                # faces draw bright so Joshua sees the grouping.
                if grouped and self.sel.cells:
                    cr.set_source_rgb(1.0, 0.9, 0.3)
                    cr.set_line_width(width + 1.5)
                    n = len(pts)
                    for i in range(n - 1):
                        if spts[i] is None or spts[i + 1] is None:
                            continue
                        c0 = (max(0, min(TSX - 1, int(pts[i][0] / CELL_X))),
                              max(0, min(TSZ - 1, int(pts[i][1] / CELL_Z))))
                        c1 = (max(0, min(TSX - 1, int(pts[i + 1][0] / CELL_X))),
                              max(0, min(TSZ - 1, int(pts[i + 1][1] / CELL_Z))))
                        if c0 in self.sel.cells or c1 in self.sel.cells:
                            cr.move_to(*spts[i])
                            cr.line_to(*spts[i + 1])
                            cr.stroke()

    # -- input ----------------------------------------------------------

    def on_button_press(self, widget, event):
        """Left: select/lift/level. Middle/right or Pan tool: pan."""
        tool = self.app.active_tool
        if event.button in (2, 3) or (event.button == 1 and tool == "pan"):
            # Pan drag.
            self._panning = True
            self._pan_start = (event.x, event.y)
            self._pan_cam = (self.cam_x, self.cam_z)
            return True
        if event.button != 1:
            return False

        if tool == "select":
            cell = self.cell_at(event.x, event.y)
            if (cell is not None and self.sel.locked
                    and cell in self.sel.cells):
                # Grab the locked selection -> vertical lift drag.
                self.lift_begin(event)
            else:
                # Start a selection rubber band (Shift adds to selection).
                self._rubber = [event.x, event.y, event.x, event.y]
                self._rubber_shift = bool(
                    event.state & Gdk.ModifierType.SHIFT_MASK)
            return True
        if tool == "level":
            wx, wz = self.screen_to_world(event.x, event.y)
            self.level_rect = (wx, wz, wx, wz)
            self.queue_draw()
            return True
        return False

    def on_motion(self, widget, event):
        """Rubber band, lift drag, pan drag, hover height readout."""
        if self._lifting:
            self.lift_update(event)
            self.app.redraw_all()
            return True
        if self._panning:
            dx = event.x - self._pan_start[0]
            dy = event.y - self._pan_start[1]
            self.cam_x = self._pan_cam[0] - dx / self.zoom
            self.cam_z = self._pan_cam[1] - dy / self.zoom
            self.queue_draw()
            return True
        if self._rubber:
            self._rubber[2], self._rubber[3] = event.x, event.y
            self.queue_draw()
            return True
        if self.app.active_tool == "level" and self.level_rect:
            # Distinguish drag-in-progress from a parked rect: the press
            # handler sets the rect, motion extends it while button held.
            if event.state & Gdk.ModifierType.BUTTON1_MASK:
                wx, wz = self.screen_to_world(event.x, event.y)
                x0, z0, _, _ = self.level_rect
                self.level_rect = (x0, z0, wx, wz)
                self.queue_draw()
            return True
        # Hover: height readout in the status bar.
        wx, wz = self.screen_to_world(event.x, event.y)
        if 0 <= wx <= WORLD_W and 0 <= wz <= WORLD_H:
            self.app.update_status(wx, wz)
        return False

    def on_button_release(self, widget, event):
        """Finish pan, lift (commit undo), rubber band, or click."""
        if event.button in (2, 3) or self._panning:
            self._panning = False
            return True
        if event.button != 1:
            return False
        if self._lifting:
            self.lift_end()
            return True
        if self._rubber:
            sx0, sy0, sx1, sy1 = self._rubber
            self._rubber = None
            shift = self._rubber_shift
            if abs(sx1 - sx0) < 5 and abs(sy1 - sy0) < 5:
                # Tiny movement = click, not a box.
                self._click_select(event, shift)
            else:
                # Box select: world rect -> grid faces.
                x0, z0 = self.screen_to_world(min(sx0, sx1), min(sy0, sy1))
                x1, z1 = self.screen_to_world(max(sx0, sx1), max(sy0, sy1))
                if shift:
                    self.sel.add_rect(x0, z0, x1, z1)
                else:
                    self.sel.select_rect(x0, z0, x1, z1)
                self.app.update_status()
            self.app.redraw_all()
            return True
        return False

    def _click_select(self, event, shift):
        """
        Plain click (no drag) in the Select tool:
          Shift+click -> toggle one face.
          Otherwise    -> lock the selection in ("click off to confirm").
        """
        if shift:
            cell = self.cell_at(event.x, event.y)
            if cell is not None:
                self.sel.toggle_cell(*cell)
                self.app.update_status()
        elif self.sel.cells and not self.sel.locked:
            self.sel.lock()
            self.app.update_status()

    def on_scroll(self, widget, event):
        """Wheel zoom centered on the cursor."""
        if event.direction == Gdk.ScrollDirection.UP:
            factor = 1.2
        elif event.direction == Gdk.ScrollDirection.DOWN:
            factor = 1.0 / 1.2
        elif event.direction == Gdk.ScrollDirection.SMOOTH:
            _dx, dy = event.get_scroll_deltas()[1:3]
            factor = 1.2 ** (-dy / 20.0)
        else:
            return False
        wx0, wz0 = self.screen_to_world(event.x, event.y)
        self.zoom = max(0.02, min(8.0, self.zoom * factor))
        wx1, wz1 = self.screen_to_world(event.x, event.y)
        self.cam_x += wx0 - wx1
        self.cam_z += wz0 - wz1
        self.queue_draw()
        return True

    # -- level tool -----------------------------------------------------

    def apply_level(self, target_h=None):
        """
        Flatten the level rectangle (Flatten button / Enter).
        Commits as one undo step.
        """
        if not self.level_rect:
            return
        x0, z0, x1, z1 = self.level_rect
        changes, applied = self.hf.level_area(x0, z0, x1, z1, target_h)
        self.hf.commit("Level to %.1f (%d faces)" % (applied, len(changes)),
                       changes)
        self.level_rect = None
        self.app.update_status()
        self.app.redraw_all()

    def clear_level_rect(self):
        """Cancel the level selection without applying."""
        self.level_rect = None
        self.queue_draw()


# ---------------------------------------------------------------------------
# Side view — profile/elevation: layered ridge silhouettes from the south
# ---------------------------------------------------------------------------

class SideView(Terrain3DView):
    """
    Architectural profile viewport: world X -> screen X, height -> screen Y.

    Draws each terrain row (fixed Z) as a filled ridge silhouette, far
    rows first and darker, near rows last and brighter — the classic
    layered-mountain look. This is the natural view for vertical
    editing: grabbing the selection and dragging up/down maps 1:1 to
    elevation change.

    Selection here works on COLUMNS (x-range, all z): drag a box to
    select every face in an x-range, Shift+click a ridge for one face.
    """

    def __init__(self, app):
        """Set up the side camera (framed by fit_view)."""
        super().__init__(app)
        self.cam_x = WORLD_W / 2.0   # world x at screen center
        self.cam_h = 35.0            # height at screen center
        self.zoom_x = 0.06           # screen px per world-x unit
        self.zoom_h = 3.0            # screen px per height unit
        self._rubber = None
        self._rubber_shift = False

    # -- camera ---------------------------------------------------------

    def world_to_screen(self, wx, h):
        """World (x, height) -> screen pixels."""
        alloc = self.get_allocation()
        return ((wx - self.cam_x) * self.zoom_x + alloc.width / 2.0,
                alloc.height / 2.0 - (h - self.cam_h) * self.zoom_h)

    def screen_to_world_x(self, sx):
        """Screen x -> world x."""
        alloc = self.get_allocation()
        return (sx - alloc.width / 2.0) / self.zoom_x + self.cam_x

    def profile_y(self, ix, rz):
        """Screen y of the terrain profile at column ix, row rz."""
        alloc = self.get_allocation()
        h = self.hf.height(ix, rz)
        return alloc.height / 2.0 - (h - self.cam_h) * self.zoom_h

    def fit_view(self):
        """Frame the whole world width and a sensible height range."""
        alloc = self.get_allocation()
        if alloc.width < 10:
            return
        self.zoom_x = alloc.width / (WORLD_W * 1.05)
        self.zoom_h = alloc.height / 110.0  # shows roughly -15..+95
        self.cam_x = WORLD_W / 2.0
        self.cam_h = 35.0
        self.queue_draw()

    def lift_scale(self):
        """Exact mapping here: the Y axis IS elevation."""
        return 1.0 / max(0.001, self.zoom_h)

    def cell_at(self, sx, sy):
        """
        Grid cell under a screen point: nearest (front-most) row whose
        filled silhouette covers the point. Returns (ix, rz) or None.
        """
        wx = self.screen_to_world_x(sx)
        if not 0 <= wx <= WORLD_W:
            return None
        ix = max(0, min(TSX - 1, int(wx / CELL_X)))
        # Near rows are drawn on top: first row (smallest z) whose
        # profile is at or above the click wins.
        for rz in range(0, TSZ, MESH_STEP):
            if sy >= self.profile_y(ix, rz) - 3:
                return (ix, rz)
        return None

    # -- drawing --------------------------------------------------------

    def on_draw(self, widget, cr):
        """Render layered ridge silhouettes, selection, roads, gridlines."""
        alloc = self.get_allocation()
        W, H = alloc.width, alloc.height
        cr.set_source_rgb(0.10, 0.10, 0.14)
        cr.paint()
        if W < 10 or self.hf.base is None:
            return

        S = MESH_STEP

        # ---- Height gridlines (every 10 units) ----
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.08)
        cr.set_line_width(1.0)
        for hh in range(0, 101, 10):
            _, sy = self.world_to_screen(0, hh)
            if 0 <= sy <= H:
                cr.move_to(0, sy)
                cr.line_to(W, sy)
                cr.stroke()
                cr.set_source_rgba(1.0, 1.0, 1.0, 0.35)
                cr.move_to(4, sy - 3)
                cr.show_text("%d" % hh)
                cr.set_source_rgba(1.0, 1.0, 1.0, 0.08)

        # ---- Ridge silhouettes: far rows first (darker), near last ----
        for rz in range(TSZ - S, -1, -S):
            # Depth shading: near (small z) brighter.
            f = 0.55 + 0.45 * (1.0 - rz / TSZ)
            r, g, b = GROUND_RGB
            # Build the profile polyline for this row.
            first = True
            for ix in range(0, TSX, S):
                sx, sy = self.world_to_screen(ix * CELL_X,
                                              self.hf.height(ix, rz))
                if first:
                    cr.move_to(sx, H + 10)
                    cr.line_to(sx, sy)
                    first = False
                else:
                    cr.line_to(sx, sy)
            # Close down to the bottom and fill the silhouette.
            last_x, _ = self.world_to_screen((TSX - 1) * CELL_X, 0)
            cr.line_to(last_x, H + 10)
            cr.close_path()
            cr.set_source_rgb(r * f, g * f, b * f)
            cr.fill_preserve()
            # Brighter crest line so rows read individually.
            cr.set_source_rgb(min(1.0, r * f + 0.12),
                              min(1.0, g * f + 0.12),
                              min(1.0, b * f + 0.12))
            cr.set_line_width(1.0)
            cr.stroke()

        # ---- Selection highlight: amber crest segments ----
        if self.sel.cells:
            # Group selected cells by row for segment drawing.
            by_row = {}
            for (ix, iz) in self.sel.cells:
                by_row.setdefault(iz, []).append(ix)
            cr.set_source_rgb(*SEL_RGB)
            cr.set_line_width(4.0 if self.sel.locked else 2.0)
            if not self.sel.locked:
                cr.set_dash([7.0, 5.0])
            for rz, ixs in by_row.items():
                for ix in sorted(ixs):
                    x0, y0 = self.world_to_screen(ix * CELL_X,
                                                  self.hf.height(ix, rz))
                    x1, y1 = self.world_to_screen((ix + 1) * CELL_X,
                                                  self.hf.height(ix + 1, rz))
                    cr.move_to(x0, y0 - 2)
                    cr.line_to(x1, y1 - 2)
                    cr.stroke()
            cr.set_dash([])

        # ---- Roads: thin polylines following terrain elevation ----
        if self.show_roads():
            for cat in ("local", "arterial", "highway"):
                cr.set_source_rgba(*ROAD_COLORS[cat], 0.9)
                cr.set_line_width(1.5)
                for ri, road in enumerate(self.roads().get(cat, [])):
                    pts = road.get("pts", [])
                    if len(pts) < 2:
                        continue
                    started = False
                    for pi in range(0, len(pts), 2):
                        px, pz = pts[pi]
                        if px < 0 or px > WORLD_W:
                            started = False
                            continue
                        key = "%s/%d/%d" % (cat, ri, pi)
                        h = self.road_elev(key, px, pz) + 1.5
                        sx, sy = self.world_to_screen(px, h)
                        if not started:
                            cr.move_to(sx, sy)
                            started = True
                        else:
                            cr.line_to(sx, sy)
                    cr.stroke()

        # ---- Selection rubber band ----
        if self._rubber:
            sx0, sy0, sx1, sy1 = self._rubber
            cr.set_source_rgba(SEL_RGB[0], SEL_RGB[1], SEL_RGB[2], 0.15)
            cr.rectangle(min(sx0, sx1), min(sy0, sy1),
                         abs(sx1 - sx0), abs(sy1 - sy0))
            cr.fill()
            cr.set_source_rgb(*SEL_RGB)
            cr.set_line_width(1.5)
            cr.set_dash([6.0, 4.0])
            cr.rectangle(min(sx0, sx1), min(sy0, sy1),
                         abs(sx1 - sx0), abs(sy1 - sy0))
            cr.stroke()
            cr.set_dash([])
        return False

    # -- input ----------------------------------------------------------

    def on_button_press(self, widget, event):
        """Left: select/lift. Middle/right or Pan tool: pan."""
        tool = self.app.active_tool
        if event.button in (2, 3) or (event.button == 1 and tool == "pan"):
            self._panning = True
            self._pan_start = (event.x, event.y)
            self._pan_cam = (self.cam_x, self.cam_h)
            return True
        if event.button != 1:
            return False
        if tool == "select":
            cell = self.cell_at(event.x, event.y)
            if (cell is not None and self.sel.locked
                    and cell in self.sel.cells):
                self.lift_begin(event)
            else:
                self._rubber = [event.x, event.y, event.x, event.y]
                self._rubber_shift = bool(
                    event.state & Gdk.ModifierType.SHIFT_MASK)
            return True
        return False

    def on_motion(self, widget, event):
        """Rubber band, lift drag, pan drag."""
        if self._lifting:
            self.lift_update(event)
            self.app.redraw_all()
            return True
        if self._panning:
            dx = event.x - self._pan_start[0]
            dy = event.y - self._pan_start[1]
            self.cam_x = self._pan_cam[0] - dx / self.zoom_x
            self.cam_h = self._pan_cam[1] + dy / self.zoom_h
            self.queue_draw()
            return True
        if self._rubber:
            self._rubber[2], self._rubber[3] = event.x, event.y
            self.queue_draw()
            return True
        return False

    def on_button_release(self, widget, event):
        """Finish pan, lift, rubber band, or click."""
        if event.button in (2, 3) or self._panning:
            self._panning = False
            return True
        if event.button != 1:
            return False
        if self._lifting:
            self.lift_end()
            return True
        if self._rubber:
            sx0, sy0, sx1, sy1 = self._rubber
            self._rubber = None
            shift = self._rubber_shift
            if abs(sx1 - sx0) < 5 and abs(sy1 - sy0) < 5:
                self._click_select(event, shift)
            else:
                # Box -> x-range -> full-height columns (z is ambiguous
                # from the side, so the whole column is selected).
                ix0 = int(self.screen_to_world_x(min(sx0, sx1)) / CELL_X)
                ix1 = int(self.screen_to_world_x(max(sx0, sx1)) / CELL_X)
                if shift:
                    self.sel.add_columns(ix0, ix1)
                else:
                    self.sel.select_columns(ix0, ix1)
                self.app.update_status()
            self.app.redraw_all()
            return True
        return False

    def _click_select(self, event, shift):
        """Plain click: Shift toggles one face, else locks the selection."""
        if shift:
            cell = self.cell_at(event.x, event.y)
            if cell is not None:
                self.sel.toggle_cell(*cell)
                self.app.update_status()
        elif self.sel.cells and not self.sel.locked:
            self.sel.lock()
            self.app.update_status()

    def on_scroll(self, widget, event):
        """
        Wheel zoom: horizontal wheel zooms X, otherwise zooms height.
        (Shift+wheel always zooms X for precision.)
        """
        if event.direction == Gdk.ScrollDirection.UP:
            factor = 1.2
        elif event.direction == Gdk.ScrollDirection.DOWN:
            factor = 1.0 / 1.2
        elif event.direction == Gdk.ScrollDirection.SMOOTH:
            _dx, dy = event.get_scroll_deltas()[1:3]
            factor = 1.2 ** (-dy / 20.0)
        else:
            return False
        if event.state & Gdk.ModifierType.SHIFT_MASK:
            # Zoom the X axis about the cursor.
            wx0 = self.screen_to_world_x(event.x)
            self.zoom_x = max(0.01, min(4.0, self.zoom_x * factor))
            wx1 = self.screen_to_world_x(event.x)
            self.cam_x += wx0 - wx1
        else:
            # Zoom the height axis about the view center.
            self.zoom_h = max(0.2, min(40.0, self.zoom_h * factor))
        self.queue_draw()
        return True


# ---------------------------------------------------------------------------
# Player's-eye view — first-person perspective, ~6 units above the ground
# ---------------------------------------------------------------------------

class PlayerEyeView(Terrain3DView):
    """
    What the player would actually see in-game: a perspective camera
    ~6 units above the terrain, with a sky background and horizon.

    Joshua uses this to verify elevation edits look right from ground
    level. Drag to look around, wheel to move forward/back. Selection
    shows highlighted; Shift+click picks the nearest face, and a locked
    selection can be grabbed and lifted here too.
    """

    # Eye height above the local terrain (~6 feet in game units).
    EYE_HEIGHT = 6.0
    # Quads closer than this (forward distance) are skipped to avoid
    # extreme perspective distortion.
    NEAR = 8.0
    # Roads beyond this distance are culled for speed.
    ROAD_FAR = 7000.0

    def __init__(self, app):
        """Set up the camera; reset_view() frames it once data loads."""
        super().__init__(app)
        self.ex = WORLD_W / 2.0      # eye world x
        self.ez = WORLD_H * 0.75     # eye world z
        self.ey = 10.0              # eye height (reset_view sets it)
        self.yaw = math.pi           # facing -z (north)
        self.pitch = -0.03           # slightly downward
        self.focal = 600.0           # set from allocation in on_draw
        self._looking = False        # look-around drag state
        self._look_moved = False
        self._press_shift = False    # shift state of the current press

    # -- camera ---------------------------------------------------------

    def _basis(self):
        """
        Camera basis vectors: forward, right, up.
        forward = (sin yaw * cos pitch, sin pitch, cos yaw * cos pitch).
        """
        cp = math.cos(self.pitch)
        fx = math.sin(self.yaw) * cp
        fy = math.sin(self.pitch)
        fz = math.cos(self.yaw) * cp
        # right = forward x world-up, normalized
        rx, ry, rz = -fz, 0.0, fx
        rl = math.sqrt(rx * rx + rz * rz) or 1.0
        rx, rz = rx / rl, rz / rl
        # up = right x forward
        ux = ry * fz - rz * fy
        uy = rz * fx - rx * fz
        uz = rx * fy - ry * fx
        return (fx, fy, fz), (rx, ry, rz), (ux, uy, uz)

    def project(self, wx, wy, wz, W, H):
        """
        Perspective project a world point -> (sx, sy, forward_dist),
        or None when behind the near plane.
        """
        (fx, fy, fz), (rx, ry, rz), (ux, uy, uz) = self._basis()
        vx, vy, vz = wx - self.ex, wy - self.ey, wz - self.ez
        cx = vx * rx + vy * ry + vz * rz
        cy = vx * ux + vy * uy + vz * uz
        cz = vx * fx + vy * fy + vz * fz
        if cz < self.NEAR:
            return None
        return (W / 2.0 + self.focal * cx / cz,
                H / 2.0 - self.focal * cy / cz,
                cz)

    def reset_view(self):
        """
        Place the camera south of the selection (or world center),
        6 units above the local ground, looking at the target.
        """
        target = self.sel.centroid()
        if target is None:
            target = (WORLD_W / 2.0, WORLD_H / 2.0)
        tx, tz = target
        # Stand 1500 units south of the target (clamped inside the world).
        self.ex = max(0.0, min(WORLD_W, tx))
        self.ez = max(0.0, min(WORLD_H, tz + 1500.0))
        self.ey = self.hf.sample(self.ex, self.ez) + self.EYE_HEIGHT
        dx, dz = tx - self.ex, tz - self.ez
        self.yaw = math.atan2(dx, dz)
        self.pitch = -0.03
        self.queue_draw()

    def fit_view(self):
        """Fit = reset to the default player's-eye framing."""
        if self.hf.base is not None:
            self.reset_view()

    # -- drawing --------------------------------------------------------

    def on_draw(self, widget, cr):
        """Render sky, horizon, then depth-sorted terrain + roads."""
        alloc = self.get_allocation()
        W, H = alloc.width, alloc.height
        if W < 10 or self.hf.base is None:
            return False
        # 60-degree vertical field of view.
        self.focal = (H * 0.5) / math.tan(math.radians(30.0))

        # ---- Sky + horizon haze ----
        horizon = self.project(self.ex, self.ey, self.ez - 8000.0,
                               W, H)
        hy = horizon[1] if horizon else H * 0.45
        hy = max(0.0, min(float(H), hy))
        cr.set_source_rgb(0.55, 0.75, 0.95)   # sky blue
        cr.rectangle(0, 0, W, hy)
        cr.fill()
        cr.set_source_rgb(0.82, 0.86, 0.90)   # horizon haze
        cr.rectangle(0, hy, W, H - hy)
        cr.fill()

        S = EYE_STEP
        draw_list = []  # (depth, kind, payload) — painted far to near

        # ---- Terrain quads ----
        sel_quads = self.sel_quad_keys(S)
        for qz in range(0, TSZ, S):
            qz2 = min(qz + S, TSZ - 1)
            wz, wz2 = qz * CELL_Z, qz2 * CELL_Z
            for qx in range(0, TSX, S):
                qx2 = min(qx + S, TSX - 1)
                wx, wx2 = qx * CELL_X, qx2 * CELL_X
                corners = [
                    self.project(wx, self.hf.height(qx, qz), wz, W, H),
                    self.project(wx2, self.hf.height(qx2, qz), wz, W, H),
                    self.project(wx2, self.hf.height(qx2, qz2), wz2, W, H),
                    self.project(wx, self.hf.height(qx, qz2), wz2, W, H),
                ]
                if any(c is None for c in corners):
                    continue  # behind/inside the near plane — skip
                depth = sum(c[2] for c in corners) / 4.0
                r, g, b = self.ground_rgb(qx, qz,
                                          self.face_shade(qx, qz))
                selected = (qx, qz) in sel_quads
                draw_list.append((depth, "quad",
                                  ([(c[0], c[1]) for c in corners],
                                   (r, g, b), selected)))

        # ---- Roads (visual only): segments in the same depth sort ----
        if self.show_roads():
            grouped = not self.app.move_terrain_only
            for cat in ("local", "arterial", "highway"):
                color = ROAD_COLORS[cat]
                for ri, road in enumerate(self.roads().get(cat, [])):
                    pts = road.get("pts", [])
                    if len(pts) < 2:
                        continue
                    prev = None  # (sx, sy, depth, key)
                    for pi in range(0, len(pts), 2):
                        px, pz = pts[pi]
                        dx, dz = px - self.ex, pz - self.ez
                        if dx * dx + dz * dz > self.ROAD_FAR ** 2:
                            prev = None
                            continue
                        key = "%s/%d/%d" % (cat, ri, pi)
                        pr = self.project(px, self.road_elev(key, px, pz)
                                          + 1.5, pz, W, H)
                        cur = None
                        if pr is not None:
                            cur = (pr[0], pr[1], pr[2], key)
                        if prev is not None and cur is not None:
                            depth = (prev[2] + cur[2]) / 2.0
                            hl = (grouped and self.sel.cells
                                  and self._key_selected(prev[3])
                                  and self._key_selected(cur[3]))
                            draw_list.append(
                                (depth, "road",
                                 ((prev[0], prev[1]), (cur[0], cur[1]),
                                  (1.0, 0.9, 0.3) if hl else color)))
                        prev = cur

        # ---- Paint far to near (painter's algorithm) ----
        draw_list.sort(key=lambda e: e[0], reverse=True)
        for _depth, kind, payload in draw_list:
            if kind == "quad":
                corners, (r, g, b), selected = payload
                if selected:
                    # Locked = solid amber; proposed = amber outline.
                    if self.sel.locked:
                        cr.set_source_rgba(SEL_RGB[0], SEL_RGB[1],
                                           SEL_RGB[2], 0.75)
                    else:
                        cr.set_source_rgb(r, g, b)
                else:
                    cr.set_source_rgb(r, g, b)
                cr.move_to(*corners[0])
                for pt in corners[1:]:
                    cr.line_to(*pt)
                cr.close_path()
                cr.fill_preserve()
                if selected and not self.sel.locked:
                    cr.set_source_rgb(*SEL_RGB)
                    cr.set_line_width(2.0)
                    cr.set_dash([6.0, 4.0])
                    cr.stroke()
                    cr.set_dash([])
                else:
                    cr.set_source_rgba(0, 0, 0, 0.25)
                    cr.set_line_width(1.0)
                    cr.stroke()
            else:  # road segment
                (x0, y0), (x1, y1), color = payload
                cr.set_source_rgb(*color)
                cr.set_line_width(2.5)
                cr.move_to(x0, y0)
                cr.line_to(x1, y1)
                cr.stroke()
        return False

    def _key_selected(self, key):
        """True when a road point's terrain cell is in the selection."""
        cell = self.app.road_key_cell.get(key)
        return cell is not None and cell in self.sel.cells

    def nearest_corner_cell(self, sx, sy, max_px=30.0):
        """
        Full-res grid cell whose projected downsampled corner is nearest
        the screen point (within max_px). Used for Shift+click picking.
        """
        alloc = self.get_allocation()
        W, H = alloc.width, alloc.height
        S = EYE_STEP
        best, best_d2 = None, max_px * max_px
        for qz in range(0, TSZ, S):
            wz = qz * CELL_Z
            for qx in range(0, TSX, S):
                pr = self.project(qx * CELL_X, self.hf.height(qx, qz),
                                  wz, W, H)
                if pr is None:
                    continue
                d2 = (pr[0] - sx) ** 2 + (pr[1] - sy) ** 2
                if d2 < best_d2:
                    best, best_d2 = (qx, qz), d2
        return best

    # -- input ----------------------------------------------------------

    def on_button_press(self, widget, event):
        """Left: maybe lift, else look around. Middle/right: look too."""
        if event.button in (2, 3):
            self._looking = True
            self._look_start = (event.x, event.y)
            self._look_yaw_pitch = (self.yaw, self.pitch)
            self._look_moved = False
            return True
        if event.button != 1:
            return False
        if self.app.active_tool == "pan":
            # Pan tool here = dolly/strafe via drag; reuse look-drag.
            self._looking = True
            self._look_start = (event.x, event.y)
            self._look_yaw_pitch = (self.yaw, self.pitch)
            self._look_moved = False
            return True
        # Select tool: lift if the press is on the locked selection.
        cell = self.nearest_corner_cell(event.x, event.y)
        if (cell is not None and self.sel.locked
                and cell in self.sel.cells):
            self.lift_begin(event)
            return True
        # Otherwise start a look-around drag (click detected on release).
        self._looking = True
        self._look_start = (event.x, event.y)
        self._look_yaw_pitch = (self.yaw, self.pitch)
        self._look_moved = False
        self._press_shift = bool(event.state & Gdk.ModifierType.SHIFT_MASK)
        return True

    def on_motion(self, widget, event):
        """Lift drag, or look around (yaw/pitch)."""
        if self._lifting:
            self.lift_update(event)
            self.app.redraw_all()
            return True
        if self._looking:
            dx = event.x - self._look_start[0]
            dy = event.y - self._look_start[1]
            if abs(dx) + abs(dy) > 3:
                self._look_moved = True
            yaw0, pitch0 = self._look_yaw_pitch
            self.yaw = yaw0 - dx * 0.004
            self.pitch = max(-1.2, min(0.6, pitch0 - dy * 0.004))
            self.queue_draw()
            return True
        return False

    def on_button_release(self, widget, event):
        """Finish lift or look; detect clicks for select/lock."""
        if self._lifting:
            self.lift_end()
            return True
        if self._looking:
            was_look = self._looking
            self._looking = False
            if was_look and not self._look_moved and event.button == 1:
                self._click_select(event)
            return True
        return False

    def _click_select(self, event):
        """Plain click: Shift toggles nearest face, else locks selection."""
        if self._press_shift:
            cell = self.nearest_corner_cell(event.x, event.y)
            if cell is not None:
                self.sel.toggle_cell(*cell)
                self.app.update_status()
                self.app.redraw_all()
        elif self.sel.cells and not self.sel.locked:
            self.sel.lock()
            self.app.update_status()
            self.app.redraw_all()

    def on_scroll(self, widget, event):
        """Wheel: dolly the camera forward/back along the view direction."""
        if event.direction == Gdk.ScrollDirection.UP:
            dist = 150.0
        elif event.direction == Gdk.ScrollDirection.DOWN:
            dist = -150.0
        elif event.direction == Gdk.ScrollDirection.SMOOTH:
            _dx, dy = event.get_scroll_deltas()[1:3]
            dist = -dy * 8.0
        else:
            return False
        # Move along the horizontal forward vector, stay 6 units up.
        self.ex = max(0.0, min(WORLD_W,
                               self.ex + math.sin(self.yaw) * dist))
        self.ez = max(0.0, min(WORLD_H,
                               self.ez + math.cos(self.yaw) * dist))
        self.ey = self.hf.sample(self.ex, self.ez) + self.EYE_HEIGHT
        self.queue_draw()
        return True
