#!/usr/bin/env python3
"""
suite_core.snapshot_view — the suite's shared software-3D
"building in its surroundings" renderer: give it a SCENE
DESCRIPTION (plain data) and it draws the snapshot — the subject
building standing on its ground, its street in front, its
neighbours around — with no GPU and no editor state.

    Joshua's snapshot law (2026-10-17): selecting a building
    generates a snapshot onto its own canvas — the current
    VIEWPOINT: the building WITH its ground and surrounding area
    (street, neighbours), never the building alone. This module
    is that canvas, shared: the Building Editor's inspector is
    its first home; the rebuild, the Elevation Editor's 3D
    viewport and any suite tool that needs "show me this, in
    place" adopt the same renderer instead of re-typing one.

EXTRACTED (2026-10-17) from the Building Editor 1.7.2's
ZoneInspectorPanel draw core (app.py): the oblique projection,
the fit-to-points framing, the painter-sorted walls with the
front wall in warm orange + FRONT label and ground arrow, the
backdrop streets with the front road named, and the station
cluster's boxes. What was left behind in the editor: everything
that touches ITS state — picking, dragging, spinbuttons, the
flagged lock — because a renderer takes a scene, not an app.

SCENE DESCRIPTION (a plain dict; all coordinates world units,
x east / z south as in the game data):

    {
      "subject": {                      # the focus building
          "ring": [[x, z], ...],        # footprint ring (required)
          "height": 7.5,                # wall height (required)
          "front_edge": 2 or None,      # ring edge index facing
                                        # the street; None = no
                                        # front known (never
                                        # invented)
          "wall_rgb": (r, g, b),        # optional base wall tint
          "roof_rgb": (r, g, b),        # optional (default below)
      },
      "boxes": [                        # neighbours / cluster parts
          {"corners": [[x, z] x4], "y0": 0.0, "y1": 4.0,
           "rgb": (r, g, b)}, ...
      ],
      "roads": [{"name": "Cascade Rd", "pts": [[x, z], ...]}],
      "front_road": "Cascade Rd" or None,   # named beside the road
      "selected_road": name or None,        # drawn highlighted
      "center": (cx, cz),        # optional; default: subject ring
                                 # centroid (framing is from the
                                 # SUBJECT only — close-up rule)
      "ground_margin": 6.0,      # ground quad grows past the
                                 # subject footprint by this much
      "azimuth": radians,        # default pi/2 (the 1.7.0 south
      "elevation": radians,      # fallback); default 12 degrees
      "empty_text": "...",       # drawn when there is no subject
    }

render_scene(ctx, scene, width, height) draws onto any
cairo-style context (it uses only set_source_rgb, rectangle,
move_to, line_to, close_path, fill, stroke, set_line_width,
select_font_face, set_font_size, show_text). SceneView is the
Gtk.DrawingArea wrapper for editors that want a widget.

No editor-specific imports (math + GTK for the widget only);
no state — the scene dict IS the input, every call.
"""

import math

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

# Colours, carried from the inspector (Joshua's design): the front
# wall is permanently warm orange; the selected street is blue.
FRONT_RGB = (1.0, 0.55, 0.15)
STREET_HILITE_RGB = (0.05, 0.65, 0.85)
SKY_RGB = (0.92, 0.94, 0.96)
GROUND_RGB = (0.78, 0.82, 0.72)
ROOF_RGB = (0.55, 0.42, 0.36)
TEXT_RGB = (0.3, 0.3, 0.3)
LABEL_RGB = (0.85, 0.35, 0.0)
ARROW_RGB = (0.95, 0.45, 0.05)
ROAD_RGB = (0.62, 0.62, 0.62)
ROAD_FRONT_RGB = (0.45, 0.45, 0.45)
ROAD_NAME_RGB = (0.25, 0.25, 0.25)

DEFAULT_AZIMUTH = math.radians(90)    # south fallback (no road)
DEFAULT_ELEVATION = math.radians(12)

# Wall shading light direction, as 1.7.0.
_LIGHT = (-0.45, -0.89)


# ---------------------------------------------------------------------------
# Pure geometry (no GTK, no cairo — unit-testable as-is)
# ---------------------------------------------------------------------------

def project(dx, dz, h, az, el):
    """Oblique projection, as 1.7.0: returns (across, vertical,
    depth) for a point offset (dx, dz) at height h, viewed from
    azimuth `az` at elevation `el`."""
    ca_, sa_ = math.cos(az), math.sin(az)
    along = dx * ca_ + dz * sa_
    across = dx * sa_ - dz * ca_
    vertical = along * math.sin(el) - h * math.cos(el)
    depth = along * math.cos(el) + h * math.sin(el)
    return across, vertical, depth


def ring_centroid(ring):
    """Mean of the ring's distinct vertices (centre of the
    footprint). The closing vertex (first == last) is dropped
    before averaging — counting it twice skews the centre toward
    that corner (Building Editor field fix, 2026-10-17)."""
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    if not pts:
        return (0.0, 0.0)
    return (sum(p[0] for p in pts) / len(pts),
            sum(p[1] for p in pts) / len(pts))


def fit_view(points, width, height, az, el, pad=28):
    """
    Fit `points` [(dx, dz, h)] into a width x height canvas:
    returns (to_screen, view) where to_screen(dx, dz, h) ->
    (sx, sy) and view is the transform record (scale, midpoints,
    size, az, el) that screen_to_ground() inverts. Framing comes
    from these points ONLY (the subject itself — the close-up
    rule), never from the whole map.
    """
    proj = [project(dx, dz, h, az, el) for dx, dz, h in points]
    if not proj:
        return (lambda dx, dz, h: (0, 0)), None
    acs = [p[0] for p in proj]
    vts = [p[1] for p in proj]
    ac_mid = (min(acs) + max(acs)) / 2
    vt_mid = (min(vts) + max(vts)) / 2
    span_a = max(max(acs) - min(acs), 1.0)
    span_v = max(max(vts) - min(vts), 1.0)
    scale = min((width - 2 * pad) / span_a,
                (height - 2 * pad) / span_v)
    scale = max(scale, 0.05)
    view = {"scale": scale, "ac_mid": ac_mid, "vt_mid": vt_mid,
            "w": width, "h": height, "az": az, "el": el}

    def to_screen(dx, dz, h):
        across, vertical, _d = project(dx, dz, h, az, el)
        return (width / 2 + (across - ac_mid) * scale,
                height / 2 + (vertical - vt_mid) * scale)
    return to_screen, view


def screen_to_ground(view, sx, sy):
    """Inverse of fit_view's transform, onto the ground plane:
    screen point -> (dx, dz) offsets, or None when the view
    cannot be inverted (edge-on elevation)."""
    if not view:
        return None
    scale = view["scale"]
    across = (sx - view["w"] / 2) / scale + view["ac_mid"]
    vertical = (sy - view["h"] / 2) / scale + view["vt_mid"]
    el = view["el"]
    if abs(math.sin(el)) < 1e-6:
        return None
    along = vertical / math.sin(el)
    az = view["az"]
    ca_, sa_ = math.cos(az), math.sin(az)
    dx = along * ca_ + across * sa_
    dz = along * sa_ - across * ca_
    return (dx, dz)


# ---------------------------------------------------------------------------
# The renderer
# ---------------------------------------------------------------------------

def _poly(ctx, pts):
    """Stroke-free filled polygon path through screen points."""
    for j, (sx, sy) in enumerate(pts):
        if j == 0:
            ctx.move_to(sx, sy)
        else:
            ctx.line_to(sx, sy)
    ctx.close_path()
    ctx.fill()


def render_scene(ctx, scene, width, height):
    """
    Draw `scene` (schema in the module docstring) onto the cairo
    context `ctx` in a width x height canvas. Returns the view
    transform (see fit_view) or None when there was no subject to
    frame. Draw order, as the inspector: sky, ground quad, roads,
    boxes (painter-sorted), the subject's walls (painter-sorted,
    front in orange), its roof, the FRONT label + ground arrow,
    and the front road's name beside the road.
    """
    scene = scene or {}
    az = scene.get("azimuth", DEFAULT_AZIMUTH)
    el = scene.get("elevation", DEFAULT_ELEVATION)
    # Sky wash.
    ctx.set_source_rgb(*SKY_RGB)
    ctx.rectangle(0, 0, width, height)
    ctx.fill()
    subject = scene.get("subject") or {}
    ring = subject.get("ring") or []
    if len(ring) < 2 or not subject.get("height"):
        ctx.set_source_rgb(*TEXT_RGB)
        ctx.select_font_face("Sans")
        ctx.set_font_size(12)
        ctx.move_to(12, 24)
        ctx.show_text(scene.get(
            "empty_text", "Select a building to see it here."))
        return None
    hgt = subject["height"]
    cx, cz = scene.get("center") or ring_centroid(ring)
    points = [(p[0] - cx, p[1] - cz, 0) for p in ring]
    points += [(p[0] - cx, p[1] - cz, hgt) for p in ring]
    to_screen, view = fit_view(points, width, height, az, el)

    # Ground quad under the subject (footprint grown a little).
    margin = scene.get("ground_margin", 6.0)
    xs = [p[0] for p in ring]
    zs = [p[1] for p in ring]
    gx0, gx1 = min(xs) - margin, max(xs) + margin
    gz0, gz1 = min(zs) - margin, max(zs) + margin
    ctx.set_source_rgb(*GROUND_RGB)
    _poly(ctx, [to_screen(px - cx, pz - cz, 0)
                for px, pz in ((gx0, gz0), (gx1, gz0),
                               (gx1, gz1), (gx0, gz1))])

    _draw_roads(ctx, scene, to_screen, cx, cz)
    _draw_boxes(ctx, scene, to_screen, cx, cz, az, el)

    # Walls, painter-sorted by depth; the front wall is orange.
    front_edge = subject.get("front_edge")
    base = subject.get("wall_rgb")
    faces = []
    n = len(ring)
    for i in range(n):
        a = ring[i]
        b = ring[(i + 1) % n]
        depth = 0.0
        for p in (a, b):
            depth += project(p[0] - cx, p[1] - cz, 0, az, el)[2]
        faces.append((depth / 2, i, a, b))
    faces.sort()
    for _depth, i, a, b in faces:
        is_front = (front_edge is not None and i == front_edge)
        quad = [to_screen(a[0] - cx, a[1] - cz, 0),
                to_screen(b[0] - cx, b[1] - cz, 0),
                to_screen(b[0] - cx, b[1] - cz, hgt),
                to_screen(a[0] - cx, a[1] - cz, hgt)]
        if is_front:
            ctx.set_source_rgb(*FRONT_RGB)
        else:
            mx, mz = (a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz
            norm = math.hypot(mx, mz) or 1.0
            shade = 0.62 + 0.25 * (mx * _LIGHT[0] + mz * _LIGHT[1]) \
                / norm
            if base is None:
                ctx.set_source_rgb(shade * 0.85, shade * 0.9, shade)
            else:
                ctx.set_source_rgb(shade * base[0], shade * base[1],
                                   shade * base[2])
        _poly(ctx, quad)
    # Roof.
    ctx.set_source_rgb(*(subject.get("roof_rgb") or ROOF_RGB))
    _poly(ctx, [to_screen(p[0] - cx, p[1] - cz, hgt) for p in ring])
    # FRONT label + ground arrow out of the front edge.
    if front_edge is not None and 0 <= front_edge < n:
        a = ring[front_edge]
        b = ring[(front_edge + 1) % n]
        mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        sx, sy = to_screen(mx - cx, mz - cz, hgt)
        ctx.set_source_rgb(*LABEL_RGB)
        ctx.select_font_face("Sans", 0, 1)  # bold
        ctx.set_font_size(13)
        ctx.move_to(sx - 18, sy - 8)
        ctx.show_text("FRONT")
        nx, nz = mx - cx, mz - cz
        norm = math.hypot(nx, nz) or 1.0
        ex, ez = mx + nx / norm * 8, mz + nz / norm * 8
        sx2, sy2 = to_screen(ex - cx, ez - cz, 0)
        sx1, sy1 = to_screen(mx - cx, mz - cz, 0)
        ctx.set_source_rgb(*ARROW_RGB)
        ctx.set_line_width(3)
        ctx.move_to(sx1, sy1)
        ctx.line_to(sx2, sy2)
        ctx.stroke()
    return view


def _draw_roads(ctx, scene, to_screen, cx, cz):
    """The backdrop streets: the selected street highlighted, the
    front road darker, and the front road named beside its nearest
    point (as the inspector draws them)."""
    selected = scene.get("selected_road")
    front_name = scene.get("front_road")
    for road in scene.get("roads") or []:
        name = road.get("name") or ""
        pts = road.get("pts") or []
        if len(pts) < 2:
            continue
        if selected and name == selected:
            ctx.set_source_rgb(*STREET_HILITE_RGB)
            ctx.set_line_width(7)
        elif front_name and name == front_name:
            ctx.set_source_rgb(*ROAD_FRONT_RGB)
            ctx.set_line_width(5)
        else:
            ctx.set_source_rgb(*ROAD_RGB)
            ctx.set_line_width(5)
        for i, p in enumerate(pts):
            sx, sy = to_screen(p[0] - cx, p[1] - cz, 0)
            if i == 0:
                ctx.move_to(sx, sy)
            else:
                ctx.line_to(sx, sy)
        ctx.stroke()
    # Name the front road beside its nearest point.
    if front_name:
        subject = scene.get("subject") or {}
        ring = subject.get("ring") or []
        if ring:
            ccx, ccz = scene.get("center") or ring_centroid(ring)
            best = None
            for road in scene.get("roads") or []:
                if (road.get("name") or "") != front_name:
                    continue
                for p in road.get("pts") or []:
                    d2 = (p[0] - ccx) ** 2 + (p[1] - ccz) ** 2
                    if best is None or d2 < best[0]:
                        best = (d2, p)
            if best is not None:
                sx, sy = to_screen(best[1][0] - cx, best[1][1] - cz, 0)
                ctx.set_source_rgb(*ROAD_NAME_RGB)
                ctx.select_font_face("Sans")
                ctx.set_font_size(11)
                ctx.move_to(sx + 6, sy - 6)
                ctx.show_text(front_name)


def _draw_boxes(ctx, scene, to_screen, cx, cz, az, el):
    """Neighbour / cluster boxes, painter-sorted by depth; each
    box's camera-facing sides shaded 0.8x, its top full colour
    (the inspector's station-parts treatment)."""
    boxes = []
    for part in scene.get("boxes") or []:
        corners = part.get("corners") or []
        if len(corners) < 4:
            continue
        dcx = sum(p[0] for p in corners) / 4 - cx
        dcz = sum(p[1] for p in corners) / 4 - cz
        depth = project(dcx, dcz, 0, az, el)[2]
        boxes.append((depth, part, corners))
    boxes.sort(key=lambda t: t[0])
    for _depth, part, corners in boxes:
        base = part.get("rgb") or (0.7, 0.7, 0.7)
        y0 = part.get("y0", 0.0)
        y1 = part.get("y1", 0.0)
        n = len(corners)
        for i in range(n):
            a = corners[i]
            b = corners[(i + 1) % n]
            mx, mz = (a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz
            facing = mx * math.cos(az) + mz * math.sin(az)
            if facing < -0.001:
                continue  # back face — the far side draws it
            ctx.set_source_rgb(base[0] * 0.8, base[1] * 0.8,
                               base[2] * 0.8)
            _poly(ctx, [to_screen(a[0] - cx, a[1] - cz, y0),
                        to_screen(b[0] - cx, b[1] - cz, y0),
                        to_screen(b[0] - cx, b[1] - cz, y1),
                        to_screen(a[0] - cx, a[1] - cz, y1)])
        ctx.set_source_rgb(*base)
        _poly(ctx, [to_screen(p[0] - cx, p[1] - cz, y1)
                    for p in corners])


# ---------------------------------------------------------------------------
# The widget
# ---------------------------------------------------------------------------

class SceneView(Gtk.DrawingArea):
    """
    A Gtk.DrawingArea that renders one scene (see module
    docstring). The host sets .scene (or calls set_scene) and the
    widget redraws; camera lives in the scene dict ("azimuth" /
    "elevation"), so orbiting is the host writing the scene, not
    the renderer keeping state. last_view holds the most recent
    fit_view transform for hosts that pick (screen_to_ground).
    """

    def __init__(self, scene=None):
        super().__init__()
        self.scene = scene
        self.last_view = None
        self.connect("draw", self._on_draw)

    def set_scene(self, scene):
        """Point the view at a new scene and redraw."""
        self.scene = scene
        self.queue_draw()

    def _on_draw(self, _widget, ctx):
        self.last_view = render_scene(
            ctx, self.scene, self.get_allocated_width(),
            self.get_allocated_height())
        return False
