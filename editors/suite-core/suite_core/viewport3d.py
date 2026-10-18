#!/usr/bin/env python3
"""
Adamsville SUITE CORE — the shared 3D viewport.

Joshua's suite law (2026-10-17): the editors keep re-creating the
same 3D viewport inside different apps — it must exist ONCE, in the
core, and every editor imports it. This is that viewport: a GTK
DrawingArea that renders a terrain patch + road ribbons with a
software (cairo) painter's-algorithm renderer — no GPU, no GL, so
it stays light enough for Joshua's laptop and the USB-stick goal.

WHAT IT DRAWS
  * a terrain mesh over a rectangular extent, sampled from a
    caller-supplied height function (the app owns the ground math
    — suite_core.ground — the viewport only samples it);
  * roads as ribbons sitting at caller-supplied display heights
    (again the app owns drape math and preview state);
  * an arc-range highlight on one "active" road (a selected
    stretch), and pin markers (start / end / crest);
  * a one-line hint in the corner (the current tool's instruction).

CAMERA + INPUT (the suite's shared vocabulary)
  * left-drag            orbit (yaw/pitch)
  * shift-left / mid-drag pan
  * wheel                 zoom
  * click (no drag)       pick — nearest station of the active
                          road within 30 px, else a ground point
  * lift mode             left-drag vertical = raise/lower,
                          reported through on_lift_drag

The viewport knows nothing about files, GitHub, or any one editor:
scenes go in as plain data, picks come out as callbacks. Written
shareable-first, like every core module.

Joshua's rule: all code commented.
"""

import math

import cairo  # noqa: F401
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
try:
    # The cairo foreign converter: without it the draw signal's
    # Context cannot cross into Python. python3-gi-cairo is a
    # declared .deb dependency, so this succeeds on a real
    # install; the try/except keeps a stripped stack from killing
    # the app at import time (the window still opens; only the
    # canvas draw would fail, loudly, in the draw handler).
    gi.require_foreign("cairo")
except Exception:
    pass
from gi.repository import Gtk, Gdk

# Road ribbon widths in world units, by game road category
# (visual only — collision/gameplay widths live in the game).
ROAD_WIDTHS = {"interstate": 16.0, "highway": 14.0,
               "major_artery": 11.0, "minor_artery": 9.0,
               "local": 7.0}
DEFAULT_ROAD_WIDTH = 7.0

# Road surface colours (dark asphalt family; the active road is
# lifted a shade so it reads against its neighbours).
ROAD_COLORS = {"interstate": (0.36, 0.36, 0.39),
               "highway": (0.34, 0.34, 0.37),
               "major_artery": (0.31, 0.31, 0.34),
               "minor_artery": (0.28, 0.28, 0.31),
               "local": (0.25, 0.25, 0.28)}
ACTIVE_ROAD_COLOR = (0.42, 0.42, 0.46)
# The selection highlight — the suite's warm orange (the same
# family as the Building Editor's FRONT face).
HIGHLIGHT_COLOR = (0.95, 0.55, 0.16)
# Marker colours by kind.
MARKER_COLORS = {"start": (0.20, 0.85, 0.42),
                 "end": (0.95, 0.30, 0.28),
                 "crest": (1.0, 1.0, 1.0)}


def _terrain_color(t, shade):
    """
    Height-ramp colour for a terrain quad: t in [0, 1] across the
    patch's height range, shade a 0..1 hillshade multiplier.
    Grass lowlands -> dry mid -> rocky high.
    """
    if t < 0.5:
        u = t / 0.5
        r = 0.22 + (0.42 - 0.22) * u
        g = 0.38 + (0.44 - 0.38) * u
        b = 0.18 + (0.24 - 0.18) * u
    else:
        u = (t - 0.5) / 0.5
        r = 0.42 + (0.62 - 0.42) * u
        g = 0.44 + (0.56 - 0.44) * u
        b = 0.24 + (0.44 - 0.24) * u
    return (r * shade, g * shade, b * shade)


class Viewport3D(Gtk.DrawingArea):
    """
    The shared software-3D viewport. See the module docstring.

    App-facing surface:
        set_terrain(sampler, extent, step)  — (re)sample the patch
        set_roads(roads)                    — road display records
        set_active_road(key)                — the pickable road
        set_highlight(s0, s1) / clear_highlight()
        set_markers([{x, z, y, kind}, ...])
        set_hint(text)
        set_lift_mode(on)
        frame_extent()                      — camera to fit scene
        world_to_screen(x, y, z)            — projection (tests/UI)
        refresh_terrain()                   — re-sample heights
    Callbacks (assign plain callables):
        on_station_pick(key, station_index)
        on_ground_pick(x, z)
        on_lift_drag(total_delta_u)         — from drag start
    """

    def __init__(self):
        """A drawing area with the suite camera defaults."""
        super().__init__()
        self.set_hexpand(True)
        self.set_vexpand(True)
        # Mouse events: press/release/motion + wheel.
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK
                        | Gdk.EventMask.BUTTON_RELEASE_MASK
                        | Gdk.EventMask.POINTER_MOTION_MASK
                        | Gdk.EventMask.SCROLL_MASK)
        self.connect("draw", self._on_draw)
        self.connect("button-press-event", self._on_press)
        self.connect("button-release-event", self._on_release)
        self.connect("motion-notify-event", self._on_motion)
        self.connect("scroll-event", self._on_scroll)

        # -- scene state ------------------------------------------------
        self._sampler = None          # (x, z) -> terrain height
        self._extent = None           # (x0, z0, x1, z1)
        self._step = 15.0
        self._grid = None             # (xs, zs, ys) sampled patch
        self._roads = []              # display road records
        self._active_key = None
        self._highlight = None        # (s0, s1) arc range or None
        self._markers = []
        self._hint = ""
        # -- camera ------------------------------------------------------
        self._target = (0.0, 0.0)     # (x, z) the camera looks at
        self._target_y = 0.0
        self._yaw = math.radians(-35.0)
        self._pitch = math.radians(52.0)
        self._dist = 600.0
        # -- interaction -------------------------------------------------
        self._lift_mode = False
        self._press = None            # press bookkeeping dict
        self.on_station_pick = None
        self.on_ground_pick = None
        self.on_lift_drag = None
        # Draw statistics from the last frame (the smoke gate reads
        # these to prove a real scene was rendered, not a black box).
        self.last_draw_stats = {"terrain_quads": 0, "road_quads": 0}

    # ------------------------------------------------------------------
    # Scene setters
    # ------------------------------------------------------------------

    def set_terrain(self, sampler, extent, step=15.0):
        """Install the height sampler + patch extent and sample it.
        sampler(x, z) returns the terrain height (analytic)."""
        self._sampler = sampler
        self._extent = extent
        self._step = float(step)
        self._sample_grid()
        self.queue_draw()

    def refresh_terrain(self):
        """Re-sample the patch (heights changed — e.g. a lift
        preview) and redraw."""
        if self._sampler is not None:
            self._sample_grid()
        self.queue_draw()

    def _sample_grid(self):
        """Sample the sampler over the extent into (xs, zs, ys)."""
        x0, z0, x1, z1 = self._extent
        nx = max(2, int(math.ceil((x1 - x0) / self._step)) + 1)
        nz = max(2, int(math.ceil((z1 - z0) / self._step)) + 1)
        xs = [x0 + (x1 - x0) * i / (nx - 1) for i in range(nx)]
        zs = [z0 + (z1 - z0) * j / (nz - 1) for j in range(nz)]
        ys = [[self._sampler(x, z) for x in xs] for z in zs]
        self._grid = (xs, zs, ys)

    def set_roads(self, roads):
        """Install road display records (see module docstring)."""
        self._roads = list(roads)
        self.queue_draw()

    def set_active_road(self, key):
        """The road clicks pick stations on (None = ground only)."""
        self._active_key = key
        self.queue_draw()

    def set_highlight(self, s0, s1):
        """Highlight the arc range [s0, s1] of the active road."""
        self._highlight = (float(s0), float(s1))
        self.queue_draw()

    def clear_highlight(self):
        """Remove the stretch highlight."""
        self._highlight = None
        self.queue_draw()

    def set_markers(self, markers):
        """Install pin markers: [{x, z, y, kind}, ...]."""
        self._markers = list(markers)
        self.queue_draw()

    def set_hint(self, text):
        """The one-line instruction shown in the corner."""
        self._hint = text or ""
        self.queue_draw()

    def set_lift_mode(self, on):
        """In lift mode, vertical left-drags raise/lower instead of
        orbiting/picking."""
        self._lift_mode = bool(on)

    def frame_extent(self):
        """Point the camera at the scene's centre, at a distance
        that frames the extent; target height from the sampler."""
        if self._extent is None:
            return
        x0, z0, x1, z1 = self._extent
        self._target = ((x0 + x1) / 2.0, (z0 + z1) / 2.0)
        if self._sampler is not None:
            self._target_y = self._sampler(*self._target)
        span = max(x1 - x0, z1 - z0)
        self._dist = max(120.0, span * 1.05)
        self.queue_draw()

    def set_target(self, x, z):
        """Move the camera's look-at point (app-driven framing)."""
        self._target = (float(x), float(z))
        if self._sampler is not None:
            self._target_y = self._sampler(x, z)
        self.queue_draw()

    # ------------------------------------------------------------------
    # Projection
    # ------------------------------------------------------------------

    def _camera(self):
        """
        (cam_pos, right, up, forward, focal_px) for the current
        allocation and camera state. Perspective with the focal
        length tied to the widget height, so the scene's apparent
        size is stable across window sizes.
        """
        alloc = self.get_allocation()
        focal = max(50.0, alloc.height * 1.15)
        tx, tz = self._target
        ty = self._target_y
        cp = math.cos(self._pitch)
        cam = (tx + self._dist * cp * math.sin(self._yaw),
               ty + self._dist * math.sin(self._pitch),
               tz + self._dist * cp * math.cos(self._yaw))
        fwd = (tx - cam[0], ty - cam[1], tz - cam[2])
        fl = math.sqrt(sum(c * c for c in fwd)) or 1.0
        fwd = tuple(c / fl for c in fwd)
        # right = forward x world-up, normalised; up = right x fwd.
        right = (fwd[2], 0.0, -fwd[0])
        rl = math.hypot(right[0], right[2]) or 1.0
        right = (right[0] / rl, 0.0, right[2] / rl)
        up = (right[1] * fwd[2] - right[2] * fwd[1],
              right[2] * fwd[0] - right[0] * fwd[2],
              right[0] * fwd[1] - right[1] * fwd[0])
        return cam, right, up, fwd, focal

    def world_to_screen(self, x, y, z):
        """
        Project a world point: (sx, sy, depth) in widget pixels, or
        None when the point is behind the camera.
        """
        alloc = self.get_allocation()
        cam, right, up, fwd, focal = self._camera()
        vx, vy, vz = x - cam[0], y - cam[1], z - cam[2]
        depth = vx * fwd[0] + vy * fwd[1] + vz * fwd[2]
        if depth <= 1.0:
            return None
        sx = alloc.width / 2.0 + (vx * right[0] + vy * right[1]
                                  + vz * right[2]) * focal / depth
        sy = alloc.height / 2.0 - (vx * up[0] + vy * up[1]
                                    + vz * up[2]) * focal / depth
        return sx, sy, depth

    def _screen_ray_ground(self, sx, sy):
        """
        Approximate ground point under a pixel: intersect the view
        ray with the horizontal plane at the camera target's
        height. Good enough for "clicked over there" framing.
        """
        alloc = self.get_allocation()
        cam, right, up, fwd, focal = self._camera()
        # Ray direction in world space for this pixel.
        ax = (sx - alloc.width / 2.0) / focal
        ay = -(sy - alloc.height / 2.0) / focal
        d = (fwd[0] + right[0] * ax + up[0] * ay,
             fwd[1] + right[1] * ax + up[1] * ay,
             fwd[2] + right[2] * ax + up[2] * ay)
        if abs(d[1]) < 1e-6:
            return None
        t = (self._target_y - cam[1]) / d[1]
        if t <= 0:
            return None
        return cam[0] + d[0] * t, cam[2] + d[2] * t

    # ------------------------------------------------------------------
    # Drawing
    # ------------------------------------------------------------------

    def _on_draw(self, _widget, cr):
        """Render the scene: terrain, roads, highlight, markers."""
        alloc = self.get_allocation()
        # Background: deep blue-grey (the suite's dark family).
        cr.set_source_rgb(0.07, 0.08, 0.10)
        cr.paint()
        stats = {"terrain_quads": 0, "road_quads": 0}
        if self._grid is not None:
            stats["terrain_quads"] = self._draw_terrain(cr)
        stats["road_quads"] = self._draw_roads(cr)
        self._draw_markers(cr)
        self.last_draw_stats = stats
        if self._hint:
            cr.set_source_rgba(1, 1, 1, 0.85)
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                                cairo.FONT_WEIGHT_NORMAL)
            cr.set_font_size(13)
            cr.move_to(10, alloc.height - 10)
            cr.show_text(self._hint)
        return False

    def _draw_terrain(self, cr):
        """Painter-sorted, height-ramped terrain quads."""
        xs, zs, ys = self._grid
        nx, nz = len(xs), len(zs)
        flat = [y for row in ys for y in row]
        lo, hi = min(flat), max(flat)
        span = (hi - lo) or 1.0
        quads = []
        for j in range(nz - 1):
            for i in range(nx - 1):
                corners = [(xs[i], ys[j][i], zs[j]),
                           (xs[i + 1], ys[j][i + 1], zs[j]),
                           (xs[i + 1], ys[j + 1][i + 1], zs[j + 1]),
                           (xs[i], ys[j + 1][i], zs[j + 1])]
                proj = [self.world_to_screen(*c) for c in corners]
                if any(p is None for p in proj):
                    continue
                depth = sum(p[2] for p in proj) / 4.0
                yavg = sum(c[1] for c in corners) / 4.0
                # Hillshade from the grid's finite differences:
                # light from the north-west, so east/south slopes
                # read darker.
                dzdx = ((ys[j][i + 1] - ys[j][i])
                        + (ys[j + 1][i + 1] - ys[j + 1][i])) \
                    / (2.0 * (xs[i + 1] - xs[i] or 1.0))
                dzdz = ((ys[j + 1][i] - ys[j][i])
                        + (ys[j + 1][i + 1] - ys[j][i + 1])) \
                    / (2.0 * (zs[j + 1] - zs[j] or 1.0))
                shade = 0.72 + 0.28 * max(
                    -1.0, min(1.0, 0.6 * -dzdx + 0.8 * -dzdz))
                shade = max(0.35, min(1.05, shade))
                quads.append((depth, proj,
                              _terrain_color((yavg - lo) / span,
                                             shade)))
        quads.sort(key=lambda q: -q[0])  # far first
        for _depth, proj, color in quads:
            cr.set_source_rgb(*color)
            cr.move_to(proj[0][0], proj[0][1])
            for p in proj[1:]:
                cr.line_to(p[0], p[1])
            cr.close_path()
            cr.fill()
        return len(quads)

    def _ribbon(self, cr, pts, ys, width, color):
        """
        Fill one road ribbon: a quad strip across the polyline.
        Returns the number of quads drawn.
        """
        if len(pts) < 2:
            return 0
        half = width / 2.0
        quads = []
        for i in range(len(pts) - 1):
            ax, az = pts[i]
            bx, bz = pts[i + 1]
            dx, dz = bx - ax, bz - az
            seg = math.hypot(dx, dz)
            if seg < 1e-9:
                continue
            px, pz = -dz / seg, dx / seg  # left perpendicular
            ya, yb = ys[i] + 0.03, ys[i + 1] + 0.03
            corners = [(ax + px * half, ya, az + pz * half),
                       (bx + px * half, yb, bz + pz * half),
                       (bx - px * half, yb, bz - pz * half),
                       (ax - px * half, ya, az - pz * half)]
            proj = [self.world_to_screen(*c) for c in corners]
            if any(p is None for p in proj):
                continue
            depth = sum(p[2] for p in proj) / 4.0
            quads.append((depth, proj))
        quads.sort(key=lambda q: -q[0])
        cr.set_source_rgb(*color)
        for _depth, proj in quads:
            cr.move_to(proj[0][0], proj[0][1])
            for p in proj[1:]:
                cr.line_to(p[0], p[1])
            cr.close_path()
            cr.fill()
        return len(quads)

    def _draw_roads(self, cr):
        """All roads' ribbons, then the active road's highlight."""
        total = 0
        ordered = sorted(
            self._roads,
            key=lambda r: 1 if r.get("key") == self._active_key else 0)
        for road in ordered:
            active = road.get("key") == self._active_key
            color = ACTIVE_ROAD_COLOR if active else ROAD_COLORS.get(
                road.get("category"), (0.26, 0.26, 0.29))
            total += self._ribbon(
                cr, road["pts"], road["ys"],
                ROAD_WIDTHS.get(road.get("category"),
                                DEFAULT_ROAD_WIDTH), color)
        # The stretch highlight: the active road's stations inside
        # the arc range, drawn as a fat orange ribbon above it.
        if self._highlight is not None and self._active_key is not None:
            road = next((r for r in self._roads
                         if r.get("key") == self._active_key), None)
            if road is not None:
                pts, ys = road["pts"], road["ys"]
                arcs = [0.0]
                for i in range(1, len(pts)):
                    arcs.append(arcs[-1] + math.hypot(
                        pts[i][0] - pts[i - 1][0],
                        pts[i][1] - pts[i - 1][1]))
                s0, s1 = self._highlight
                sub_pts, sub_ys = [], []
                for i, a in enumerate(arcs):
                    if s0 - 1e-9 <= a <= s1 + 1e-9:
                        sub_pts.append(pts[i])
                        sub_ys.append(ys[i] + 0.06)
                if len(sub_pts) >= 2:
                    total += self._ribbon(
                        cr, sub_pts, sub_ys,
                        ROAD_WIDTHS.get(road.get("category"),
                                        DEFAULT_ROAD_WIDTH) * 0.55,
                        HIGHLIGHT_COLOR)
        return total

    def _draw_markers(self, cr):
        """Pins: a stem from the ground + a filled circle."""
        for m in self._markers:
            base = self.world_to_screen(m["x"], m["y"], m["z"])
            top = self.world_to_screen(m["x"], m["y"] + 16.0, m["z"])
            if base is None or top is None:
                continue
            color = MARKER_COLORS.get(m.get("kind"), (1, 1, 1))
            cr.set_source_rgb(*color)
            cr.set_line_width(2.0)
            cr.move_to(base[0], base[1])
            cr.line_to(top[0], top[1])
            cr.stroke()
            cr.arc(top[0], top[1], 6.5, 0, 2 * math.pi)
            cr.fill()
            if m.get("kind") == "crest":
                cr.set_source_rgb(0.1, 0.1, 0.1)
                cr.arc(top[0], top[1], 3.0, 0, 2 * math.pi)
                cr.fill()

    # ------------------------------------------------------------------
    # Input
    # ------------------------------------------------------------------

    def _on_press(self, _w, event):
        """Start a potential click / drag (mode decided by motion)."""
        self._press = {
            "x": event.x, "y": event.y, "button": event.button,
            "shift": bool(event.state & Gdk.ModifierType.SHIFT_MASK),
            "moved": False, "lift_total": 0.0,
        }
        return True

    def _on_motion(self, _w, event):
        """Drag handling: orbit / pan / lift, per mode + modifiers."""
        p = self._press
        if p is None:
            return False
        # Per-event step (orbit/pan consume steps); the total from
        # the press point decides click-vs-drag and drives lift mode.
        step_dx = event.x - p.get("lx", event.x) \
            if "lx" in p else 0.0
        step_dy = event.y - p.get("ly", event.y) \
            if "ly" in p else 0.0
        p["lx"], p["ly"] = event.x, event.y
        if math.hypot(event.x - p["x"], event.y - p["y"]) > 4:
            p["moved"] = True
        if not p["moved"]:
            return True
        if self._lift_mode and p["button"] == 1:
            # Vertical drag: up = raise. Scale by camera distance
            # so the lift feels 1:1 with the world on screen.
            alloc = self.get_allocation()
            scale = self._dist / max(1.0, alloc.height) * 1.15
            p["lift_total"] = (p["y"] - event.y) * scale
            if self.on_lift_drag:
                self.on_lift_drag(p["lift_total"])
            return True
        if p["button"] == 2 or (p["button"] == 1 and p["shift"]):
            # Pan: move the target opposite the drag, in the
            # camera's ground plane, scaled by distance.
            alloc = self.get_allocation()
            scale = self._dist / max(1.0, alloc.height) * 1.15
            sy = math.sin(self._yaw)
            cy = math.cos(self._yaw)
            # Screen-right on the ground is (cos yaw, -sin yaw);
            # screen-up on the ground is (sin yaw, cos yaw).
            mx = (-step_dx * cy + step_dy * sy) * scale
            mz = (step_dx * sy + step_dy * cy) * scale
            self._target = (self._target[0] + mx,
                            self._target[1] + mz)
            if self._sampler is not None:
                self._target_y = self._sampler(*self._target)
            self.queue_draw()
            return True
        if p["button"] == 1:
            # Orbit.
            self._yaw -= step_dx * 0.006
            self._pitch = max(0.12, min(1.45,
                                        self._pitch + step_dy * 0.005))
            self.queue_draw()
            return True
        return True

    def _on_release(self, _w, event):
        """A press that never became a drag is a CLICK: pick."""
        p = self._press
        self._press = None
        if p is None or p["moved"] or event.button != 1:
            return True
        if self._lift_mode:
            return True  # lift mode: clicks don't pick
        # Nearest station of the active road within 30 px wins.
        if self._active_key is not None and self.on_station_pick:
            road = next((r for r in self._roads
                         if r.get("key") == self._active_key), None)
            if road is not None:
                best, best_d = None, 30.0
                for i, (x, z) in enumerate(road["pts"]):
                    s = self.world_to_screen(x, road["ys"][i], z)
                    if s is None:
                        continue
                    d = math.hypot(s[0] - event.x, s[1] - event.y)
                    if d < best_d:
                        best, best_d = i, d
                if best is not None:
                    self.on_station_pick(self._active_key, best)
                    return True
        if self.on_ground_pick:
            g = self._screen_ray_ground(event.x, event.y)
            if g is not None:
                self.on_ground_pick(g[0], g[1])
        return True

    def _on_scroll(self, _w, event):
        """Wheel zoom: distance scales geometrically, clamped."""
        if event.direction == Gdk.ScrollDirection.UP:
            self._dist = max(40.0, self._dist * 0.88)
        elif event.direction == Gdk.ScrollDirection.DOWN:
            self._dist = min(8000.0, self._dist * 1.14)
        else:
            return False
        self.queue_draw()
        return True
