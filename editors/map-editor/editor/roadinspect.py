#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) — 3D Road Inspection Panel.

Dockable right-side panel with two Cairo isometric 3D viewers:

- ControlPointViewer (top): the selected road(s) draped on the terrain
  in 3D. Road endpoints are clickable; if a selected endpoint sits
  near another road, a snap indicator appears and Joshua can snap it
  (double-click or the Snap button). With no nearby road the viewer is
  visual-only.
- ElevationViewer (bottom): side-view elevation profile of the selected
  road on the terrain cross-section. Click the road face and drag UP or
  DOWN to adjust its elevation offset. Vertical only — no sideways or
  forward/back movement.

When no road is selected both viewers show a placeholder message.

Purpose (Joshua 2026-10-11):
- "See where the road is looking like on a 3D model"
- "Make sure that the algorithm of joining and merging is working
  correctly" (visual verification of join/merge results)
- "See the underlying terrain"
- "If the street needs to be moved you can select the face of the
  street and move it up or down"

Joshua's rule: all code commented.
"""

import math
import json
import sys
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk

# Shared suite canvas helpers (iso_project). All suite apps install the
# same file; fall back to a local copy if it is missing (Joshua
# 2026-10-11: map functions must not be rewritten per app).
for _suite_path in ("/usr/share/adamsville-suite",
                    str(Path.home() / ".local" / "share" / "adamsville-suite")):
    if _suite_path not in sys.path:
        sys.path.insert(0, _suite_path)
try:
    from adamsville_suite_canvas import iso_project
    _HAS_ISO = True
except ImportError:  # pragma: no cover - fallback only
    _HAS_ISO = False

    def iso_project(x, y, z, angle_rad):
        """Fallback isometric projection (local copy)."""
        rx = x * math.cos(angle_rad) - z * math.sin(angle_rad)
        rz = x * math.sin(angle_rad) + z * math.cos(angle_rad)
        return rx, -y + rz * 0.5


# ---------------------------------------------------------------------------
# Terrain data (read-only sampling for the 3D viewers)
# ---------------------------------------------------------------------------
# The viewers drape roads on the real terrain so Joshua can see whether a
# road floats above or sinks below the ground. Terrain comes from the
# terrain editor's terrain.json (150x200 downsampled heightfield, world
# 8000x12000). Search order: shared suite cache first, then the terrain
# editor's own cache. Missing file = flat terrain (height 0).

TSX, TSZ = 150, 200          # downsampled grid dimensions
WORLD_W, WORLD_H = 8000, 12000  # game world extent (same as map editor)
CELL_X = WORLD_W / TSX       # world units per grid cell (x)
CELL_Z = WORLD_H / TSZ       # world units per grid cell (z)


def _find_terrain_file():
    """
    Locate terrain.json for height sampling.
    Returns a Path or None when no cached terrain exists.
    """
    candidates = [
        Path.home() / ".local" / "share" / "adamsville-suite" / "terrain.json",
        Path.home() / ".local" / "share"
        / "adamsville-terrain-editor-native" / "terrain.json",
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


class TerrainSampler:
    """
    Minimal read-only terrain height sampler (no GTK — headless-testable).

    Loads the 150x200 heightfield once and answers bilinear height
    queries at arbitrary world coordinates. Gracefully degrades to flat
    (0.0) when no terrain file is available.
    """

    def __init__(self):
        """Start empty; call load() to read from disk."""
        self.heights = None   # flat list, row-major, TSX*TSZ floats
        self.loaded = False

    def load(self):
        """
        Read terrain.json from the first available cache location.
        Returns True on success, False when no usable file exists.
        Never raises — the viewers must work without terrain.
        """
        try:
            path = _find_terrain_file()
            if path is None:
                return False
            with open(path) as f:
                doc = json.load(f)
            h = doc["h"]
            if len(h) != TSX * TSZ:
                return False  # wrong grid — ignore rather than misrender
            self.heights = [float(v) for v in h]
            self.loaded = True
            return True
        except Exception:
            return False

    def _cell(self, ix, iz):
        """Height at integer grid cell, clamped to the grid."""
        ix = max(0, min(TSX - 1, ix))
        iz = max(0, min(TSZ - 1, iz))
        return self.heights[iz * TSX + ix]

    def sample(self, wx, wz):
        """
        Bilinear-interpolated terrain height at world (wx, wz).
        Returns 0.0 when no terrain is loaded.
        """
        if not self.loaded:
            return 0.0
        # World -> fractional grid coords, clamped just inside the grid
        # so ix0+1 / iz0+1 stay valid.
        gx = max(0.0, min(TSX - 1.001, wx / CELL_X))
        gz = max(0.0, min(TSZ - 1.001, wz / CELL_Z))
        ix0, iz0 = int(gx), int(gz)
        fx, fz = gx - ix0, gz - iz0
        h00 = self._cell(ix0, iz0)
        h10 = self._cell(ix0 + 1, iz0)
        h01 = self._cell(ix0, iz0 + 1)
        h11 = self._cell(ix0 + 1, iz0 + 1)
        return (h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) +
                h01 * (1 - fx) * fz + h11 * fx * fz)


# ---------------------------------------------------------------------------
# Per-road elevation offsets
# ---------------------------------------------------------------------------
# The Elevation viewer lets Joshua lift/lower a whole road. Offsets are
# stored per road (key "cat/name") in the map editor's own data dir, so
# they survive restarts. This is coarser than the terrain editor's
# per-point road_offsets.json — a different file on purpose, so the two
# apps never clobber each other's data.

ELEV_FILE = (Path.home() / ".local" / "share"
             / "adamsville-map-editor-native" / "road_elev.json")


class RoadElevStore:
    """
    Per-road elevation offsets, keyed by "cat/road_name".
    Headless-testable; the app wires save() into its push flow.
    """

    def __init__(self, path=None):
        """path overrides the default location (used by tests)."""
        self.path = Path(path) if path else ELEV_FILE
        self.offsets = {}  # "cat/name" -> float
        self.load()

    def load(self):
        """Read saved offsets; missing/corrupt file = start empty."""
        try:
            if self.path.exists():
                raw = json.loads(self.path.read_text())
                self.offsets = {str(k): float(v) for k, v in raw.items()
                                if abs(float(v)) > 0.0005}
        except Exception:
            self.offsets = {}

    def save(self):
        """Persist offsets to disk. Creates the data dir if needed."""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.offsets, indent=2))
        except Exception:
            pass  # best effort — the viewer keeps working in memory

    @staticmethod
    def key_for(cat, name):
        """Stable storage key for a road."""
        return "%s/%s" % (cat, name or "Unnamed")

    def get(self, key):
        """Elevation offset for key (0.0 when unset)."""
        return self.offsets.get(key, 0.0)

    def set(self, key, value):
        """
        Set an offset. Near-zero values are dropped so the file stays
        sparse (only real edits are stored).
        """
        if abs(value) < 0.0005:
            self.offsets.pop(key, None)
        else:
            self.offsets[key] = float(value)
        self.save()


# ---------------------------------------------------------------------------
# Shared 3D drawing helpers
# ---------------------------------------------------------------------------

# Snap radius in world units: a selected endpoint within this distance of
# another road offers the snap indicator.
SNAP_RADIUS = 150.0
# Screen-pixel radius for clicking endpoints in the control-point viewer.
ENDPOINT_PICK_PX = 12
# Road ribbon lift above terrain in the 3D view (world height units).
ROAD_LIFT = 2.0

# Road colors by category (same as the map editor).
# Legacy "arterial" kept so old selections still resolve.
ROAD_COLORS = {
    "interstate": (0.72, 0.12, 0.12),   # dark red
    "highway": (1.0, 0.27, 0.27),       # red
    "major_artery": (1.0, 0.45, 0.10),  # orange-red
    "minor_artery": (1.0, 0.67, 0.0),   # orange
    "arterial": (1.0, 0.67, 0.0),       # legacy -> minor_artery orange
    "local": (0.53, 0.53, 0.53),        # gray
}


def _norm_cat(cat):
    """
    Normalize a category string for color/width lookups.
    Local copy (avoids importing data.py's GTK-free parts — actually
    data.py is GTK-free, but keep this dependency-free on purpose).
    """
    if cat == "arterial":
        return "minor_artery"
    if cat in ROAD_COLORS:
        return cat
    return "local"


def _direction_labels(pts):
    """
    ("N","S") if the road runs more north-south else ("E","W").
    Duplicated from mapcanvas (kept local so this module stays
    import-light). Used for divided-section labels.
    """
    if len(pts) < 2:
        return ("N", "S")
    dx = pts[-1][0] - pts[0][0]
    dz = pts[-1][1] - pts[0][1]
    return ("E", "W") if abs(dx) >= abs(dz) else ("N", "S")


def _shade(rgb, factor):
    """Darken/lighten an RGB tuple (factor < 1 darkens)."""
    r, g, b = rgb
    return (min(1.0, r * factor), min(1.0, g * factor),
            min(1.0, b * factor))


def _face_shade(nx, ny, nz):
    """
    Simple lambert-ish shading for terrain quads.
    Light comes from upper-left-front. Returns a 0.55..1.15 factor.
    """
    # Fixed sun direction (normalized-ish).
    lx, ly, lz = -0.45, 0.8, -0.35
    dot = nx * lx + ny * ly + nz * lz
    return max(0.55, min(1.15, 0.75 + 0.4 * dot))


# ---------------------------------------------------------------------------
# Top viewer: control points (isometric 3D, clickable endpoints + snap)
# ---------------------------------------------------------------------------

class ControlPointViewer(Gtk.DrawingArea):
    """
    Top 3D viewer: selected road(s) draped on a terrain patch, rendered
    isometrically with Cairo.

    Interactions:
    - Click an endpoint (amber circle) to select it.
    - If the selected endpoint is within SNAP_RADIUS of another road, a
      dashed snap line appears; double-click the endpoint (or press the
      Snap button) to move it onto that road.
    - Drag empty space to rotate the view; mouse wheel zooms.
    - With no nearby road the viewer is visual-only (no snap offered).
    """

    def __init__(self, panel):
        """panel is the owning RoadInspectorPanel (shared state)."""
        super().__init__()
        self.panel = panel
        # View state
        self.view_angle = math.radians(35)  # isometric rotation
        self.zoom = 0.35                   # screen px per world unit
        self._dragging = False             # view-rotate drag in progress
        self._drag_x = 0
        self._drag_angle = 0.0
        # Endpoint selection: (road_key, end_idx) or None.
        # road_key is the (cat, flat_idx) tuple from the main selection.
        self.sel_endpoint = None
        # Cached screen positions of endpoints for hit-testing:
        # list of (road_key, end_idx, sx, sy)
        self._ep_screen = []
        # Snap candidate for the selected endpoint:
        # (target_wx, target_wz, target_road_name) or None
        self.snap_candidate = None

        self.set_size_request(280, 220)
        self.set_can_focus(True)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK |
                        Gdk.EventMask.BUTTON_RELEASE_MASK |
                        Gdk.EventMask.POINTER_MOTION_MASK |
                        Gdk.EventMask.SCROLL_MASK)
        self.connect("draw", self._on_draw)
        self.connect("button-press-event", self._on_press)
        self.connect("button-release-event", self._on_release)
        self.connect("motion-notify-event", self._on_motion)
        self.connect("scroll-event", self._on_scroll)

    # -- data access ---------------------------------------------------

    def _selected_roads(self):
        """
        Live (cat, flat_idx, road_dict) for the main canvas selection.
        Empty list when nothing is selected or no data is loaded.
        """
        app = self.panel.app
        canvas = getattr(app, "canvas", None)
        if canvas is None or not getattr(app, "roads_data", None):
            return []
        out = []
        for cat, idx in getattr(canvas, "selected_roads", []):
            road = canvas._get_road_dict(cat, idx)
            if road and len(road.get("pts", [])) >= 2:
                out.append((cat, idx, road))
        return out

    def _road_bbox(self, roads):
        """World bbox (x0, z0, x1, z1) around the given roads + margin."""
        xs, zs = [], []
        for _cat, _idx, road in roads:
            for px, pz in road.get("pts", []):
                xs.append(px)
                zs.append(pz)
        if not xs:
            return None
        margin = max(300.0, (max(xs) - min(xs)) * 0.25 + 200.0)
        return (min(xs) - margin, min(zs) - margin,
                max(xs) + margin, max(zs) + margin)

    # -- projection ----------------------------------------------------

    def _proj(self, wx, wz, wh, cx, cy, ox, oz):
        """
        World (wx, wz, wh) -> screen coords.
        (cx, cz) is the world focus point; (ox, oy) the screen center.
        """
        sx, sy = iso_project(wx - cx, wh, wz - oz, self.view_angle)
        return ox + sx * self.zoom, cy + sy * self.zoom

    # -- drawing -------------------------------------------------------

    def _on_draw(self, widget, cr):
        """Render the 3D inspection view."""
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height
        # Dark background
        cr.set_source_rgb(0.10, 0.10, 0.13)
        cr.paint()

        roads = self._selected_roads()
        if not roads:
            self._draw_placeholder(cr, w, h)
            return

        sampler = self.panel.terrain
        bbox = self._road_bbox(roads)
        cx = (bbox[0] + bbox[2]) / 2.0
        cz = (bbox[1] + bbox[3]) / 2.0
        ox, oy = w / 2.0, h / 2.0 + 20

        def proj(wx, wz, wh=0.0):
            return self._proj(wx, wz, wh, cx, cz, ox, oy)

        # Terrain patch: coarse quads with face shading.
        self._draw_terrain_patch(cr, proj, bbox, sampler)
        # Selected roads as ribbons draped on the terrain.
        for cat, idx, road in roads:
            self._draw_road_3d(cr, proj, sampler, cat, idx, road)
        # Overpasses near the selection: elevated decks with pillars
        # (Joshua 2026-10-11).
        self._draw_overpasses_3d(cr, proj, sampler, bbox)
        # Semi-truck silhouette for scale reference (Joshua 2026-10-11):
        # shown when any nearby overpass is truck-restricted.
        self._draw_truck_scale(cr, proj, sampler, bbox)
        # Endpoints (clickable) + snap indicator.
        self._ep_screen = []
        for cat, idx, road in roads:
            self._draw_endpoints(cr, proj, sampler, (cat, idx), road)
        self._draw_snap_indicator(cr, proj, sampler)

        # Hint line
        cr.set_source_rgb(0.6, 0.6, 0.65)
        cr.set_font_size(11)
        cr.move_to(8, h - 8)
        cr.show_text("Drag: rotate  •  Wheel: zoom  •  Click endpoint to select")

    def _draw_placeholder(self, cr, w, h):
        """Empty-state message when no road is selected."""
        cr.set_source_rgb(0.55, 0.55, 0.6)
        cr.select_font_face("Sans", 0, 0)
        cr.set_font_size(13)
        cr.move_to(20, h // 2 - 8)
        cr.show_text("Select a road to inspect in 3D")
        cr.move_to(20, h // 2 + 12)
        cr.set_font_size(11)
        cr.show_text("Click a road in the map (Select mode).")

    def _draw_terrain_patch(self, cr, proj, bbox, sampler):
        """
        Draw the terrain under the roads as shaded quads.
        Coarse sampling (every 4th grid cell) keeps this fast.
        """
        x0, z0, x1, z1 = bbox
        # Snap the patch to grid cells for stable sampling.
        gx0 = max(0, int(x0 / CELL_X))
        gz0 = max(0, int(z0 / CELL_Z))
        gx1 = min(TSX - 1, int(x1 / CELL_X) + 1)
        gz1 = min(TSZ - 1, int(z1 / CELL_Z) + 1)
        step = 4  # coarse quads for the preview
        # Natural grass-dirt base tone (no heatmap — Joshua 2026-10-11).
        base = (0.32, 0.42, 0.22)
        for iz in range(gz0, gz1, step):
            for ix in range(gx0, gx1, step):
                ix1 = min(ix + step, TSX - 1)
                iz1 = min(iz + step, TSZ - 1)
                # Four corners in world coords + heights
                corners = []
                for qx, qz in ((ix, iz), (ix1, iz),
                               (ix1, iz1), (ix, iz1)):
                    wx, wz = qx * CELL_X, qz * CELL_Z
                    corners.append((wx, wz, sampler.sample(wx, wz)))
                # Face normal via cross product (for shading)
                (ax, ay, az), (bx, by, bz), (cx_, cy_, cz_) = \
                    corners[0], corners[1], corners[2]
                ux, uy, uz = bx - ax, by - ay, bz - az
                vx, vy, vz = cx_ - ax, cy_ - ay, cz_ - az
                nx = uy * vz - uz * vy
                ny = uz * vx - ux * vz
                nz = ux * vy - uy * vx
                nl = math.hypot(nx, ny, nz) or 1.0
                shade = _face_shade(nx / nl, ny / nl, nz / nl)
                r, g, b = _shade(base, shade)
                cr.set_source_rgb(r, g, b)
                pts = [proj(wx, wz, wh) for wx, wz, wh in corners]
                cr.move_to(*pts[0])
                for p in pts[1:]:
                    cr.line_to(*p)
                cr.close_path()
                cr.fill()

    def _road_height(self, sampler, wx, wz, key):
        """Terrain height + road elevation offset + small lift."""
        return (sampler.sample(wx, wz) +
                self.panel.elev.get(key) + ROAD_LIFT)

    def _draw_road_3d(self, cr, proj, sampler, cat, idx, road):
        """Draw one road as a 3D ribbon draped on the terrain."""
        pts = road.get("pts", [])
        if len(pts) < 2:
            return
        name = road.get("name") or "Unnamed"
        key = RoadElevStore.key_for(cat, name)
        color = ROAD_COLORS.get(_norm_cat(cat), (0.5, 0.5, 0.5))
        # Ribbon: offset each point perpendicular in screen space.
        # Simpler robust approach: draw a thick line through the
        # projected centerline points.
        spts = [proj(px, pz, self._road_height(sampler, px, pz, key))
                for px, pz in pts]
        cr.set_source_rgb(*color)
        cr.set_line_width(max(3.0, 5.0 * self.zoom))
        cr.set_line_cap(1)
        cr.set_line_join(1)
        cr.move_to(*spts[0])
        for p in spts[1:]:
            cr.line_to(*p)
        cr.stroke()
        # Dark center line for definition
        cr.set_source_rgb(0.12, 0.12, 0.12)
        cr.set_line_width(1.0)
        cr.move_to(*spts[0])
        for p in spts[1:]:
            cr.line_to(*p)
        cr.stroke()
        # Divided sections: split ribbons + raised median / divider wall
        # (Joshua 2026-10-11).
        if _norm_cat(cat) in ("interstate", "highway", "major_artery") \
                and road.get("divided_sections"):
            self._draw_divided_3d(cr, proj, sampler, key, road, color)
        # Cul-de-sac turnaround bulb: flat disc at the dead end
        # (Joshua 2026-10-11).
        if road.get("cul_de_sac"):
            self._draw_cul_de_sac_disc(cr, proj, sampler, key, road,
                                       color)

    def _draw_cul_de_sac_disc(self, cr, proj, sampler, key, road,
                              color):
        """
        Draw the cul-de-sac turnaround bulb as a flat disc draped on
        the terrain at the dead end — the 3D counterpart of the 2D
        bulb. (The elevation-profile viewer skips it: the bulb does
        not change the road's elevation profile.)
        """
        pts = road.get("pts", [])
        if len(pts) < 2:
            return
        end = road.get("cul_de_sac_end", "end")
        ex, ez = pts[0] if end == "start" else pts[-1]
        radius = float(road.get("cul_de_sac_radius", 15.0))
        eh = self._road_height(sampler, ex, ez, key) + 0.15
        cx, cy = proj(ex, ez, eh)
        # Screen-space radius: project a second point `radius` world
        # units east and measure the distance (approximation is fine
        # for a small disc).
        px2, py2 = proj(ex + radius, ez, eh)
        sr = max(3.0, math.hypot(px2 - cx, py2 - cy))
        cr.set_source_rgb(*color)
        cr.arc(cx, cy, sr, 0, 2 * math.pi)
        cr.fill()

    def _draw_overpasses_3d(self, cr, proj, sampler, bbox):
        """
        Draw overpasses near the current view as elevated 3D structures
        (Joshua 2026-10-11).

        Each overpass renders as:
        - An orange deck box at deck_height above the terrain
        - Dark gray pillar columns from ground to deck
        - A clearance label (e.g. "16 FT") on the deck side
        - Low-clearance signs as small yellow posts (if any)

        Only overpasses within the view bbox are drawn.
        """
        app = self.panel.app
        overpasses = getattr(app, "overpasses", [])
        if not overpasses:
            return
        vx0, vz0, vx1, vz1 = bbox
        deck_len, deck_w = 200.0, 60.0
        for ovp in overpasses:
            cx, cz = ovp.get("position", [0, 0])
            # Cull overpasses outside the view.
            if not (vx0 <= cx <= vx1 and vz0 <= cz <= vz1):
                continue
            deck_h = ovp.get("deck_height", 25.0)
            ground_h = sampler.sample(cx, cz) if sampler else 0.0

            # Deck: draw as a flat orange box (top face + front edge).
            # Project the 4 top corners.
            hl, hw = deck_len / 2.0, deck_w / 2.0
            corners_top = [
                proj(cx - hl, cz - hw, ground_h + deck_h),
                proj(cx + hl, cz - hw, ground_h + deck_h),
                proj(cx + hl, cz + hw, ground_h + deck_h),
                proj(cx - hl, cz + hw, ground_h + deck_h),
            ]
            # Top face: orange.
            cr.set_source_rgb(1.0, 0.55, 0.1)
            cr.move_to(*corners_top[0])
            for p in corners_top[1:]:
                cr.line_to(*p)
            cr.close_path()
            cr.fill()
            # Front edge (thickness): darker orange.
            corners_bot = [
                proj(cx - hl, cz + hw, ground_h + deck_h - 4),
                proj(cx + hl, cz + hw, ground_h + deck_h - 4),
            ]
            cr.set_source_rgb(0.7, 0.35, 0.05)
            cr.set_line_width(2.0)
            cr.move_to(*corners_top[2])
            cr.line_to(*corners_top[3])
            cr.line_to(*corners_bot[0])
            cr.line_to(*corners_bot[1])
            cr.close_path()
            cr.fill()

            # Pillars: vertical dark gray columns from ground to deck.
            for p in ovp.get("pillars", []):
                px, pz = p["x"], p["z"]
                p_ground = sampler.sample(px, pz) if sampler else 0.0
                top = proj(px, pz, p_ground + deck_h)
                bot = proj(px, pz, p_ground)
                cr.set_source_rgb(0.25, 0.25, 0.28)
                cr.set_line_width(max(3.0, 6.0 * self.zoom))
                cr.set_line_cap(1)
                cr.move_to(*bot)
                cr.line_to(*top)
                cr.stroke()

            # Clearance label on the deck.
            cr.set_source_rgb(1.0, 1.0, 1.0)
            cr.select_font_face("Sans", 0, 1)
            cr.set_font_size(11)
            label = f"{deck_h:.0f} FT"
            if ovp.get("truck_restricted"):
                cr.set_source_rgb(1.0, 0.3, 0.3)
                label += " NO TRUCKS"
            lx, ly = proj(cx, cz - hw - 10, ground_h + deck_h)
            cr.move_to(lx - 30, ly)
            cr.show_text(label)

            # Low-clearance signs: small yellow posts.
            for sign in ovp.get("low_clearance_signs", []):
                sx, sy = sign["x"], sign["z"]
                s_ground = sampler.sample(sx, sy) if sampler else 0.0
                base = proj(sx, sy, s_ground)
                top_p = proj(sx, sy, s_ground + 12)
                cr.set_source_rgb(0.5, 0.5, 0.5)
                cr.set_line_width(2.0)
                cr.move_to(*base)
                cr.line_to(*top_p)
                cr.stroke()
                # Yellow diamond at the top.
                cr.set_source_rgb(1.0, 0.85, 0.0)
                d = 8.0
                cr.move_to(top_p[0], top_p[1] - d)
                cr.line_to(top_p[0] + d, top_p[1])
                cr.line_to(top_p[0], top_p[1] + d)
                cr.line_to(top_p[0] - d, top_p[1])
                cr.close_path()
                cr.fill()

    def _draw_truck_scale(self, cr, proj, sampler, bbox):
        """
        Draw a semi-truck silhouette for scale reference (Joshua
        2026-10-11). Only shown when a nearby overpass is
        truck-restricted, so Joshua can visually verify the clearance
        issue.

        The truck is drawn as a simple side-profile silhouette:
        cab + trailer, ~70ft long, ~13.5ft tall (standard 18-wheeler).
        """
        app = self.panel.app
        overpasses = getattr(app, "overpasses", [])
        vx0, vz0, vx1, vz1 = bbox
        # Find the first truck-restricted overpass in view.
        target = None
        for ovp in overpasses:
            cx, cz = ovp.get("position", [0, 0])
            if (vx0 <= cx <= vx1 and vz0 <= cz <= vz1
                    and ovp.get("truck_restricted")):
                target = ovp
                break
        if target is None:
            return
        # Draw the truck beside the overpass (offset to avoid overlap).
        cx, cz = target["position"]
        tx, tz = cx + 150, cz  # 150u to the side
        ground = sampler.sample(tx, tz) if sampler else 0.0

        # Truck dimensions (world units ≈ feet).
        truck_len = 70.0
        truck_h = 13.5
        # Side profile: project the truck's outline.
        # Simple silhouette: cab (front 20ft) + trailer (50ft).
        hw = truck_len / 2.0
        # Bottom edge (wheels/ground).
        p0 = proj(tx - hw, tz, ground)
        p1 = proj(tx + hw, tz, ground)
        # Top of trailer.
        p2 = proj(tx + hw, tz, ground + truck_h)
        p3 = proj(tx - hw + 20, tz, ground + truck_h)
        # Cab top (slightly lower).
        p4 = proj(tx - hw, tz, ground + 10)
        cr.set_source_rgb(0.35, 0.45, 0.65)  # steel blue
        cr.move_to(*p0)
        cr.line_to(*p1)
        cr.line_to(*p2)
        cr.line_to(*p3)
        cr.line_to(*p4)
        cr.close_path()
        cr.fill()
        # Label.
        cr.set_source_rgb(1.0, 1.0, 1.0)
        cr.set_font_size(10)
        lx, ly = proj(tx, tz, ground + truck_h + 8)
        cr.move_to(lx - 40, ly)
        cr.show_text("18-wheeler (13.5ft)")

    def _draw_divided_3d(self, cr, proj, sampler, key, road, color):
        """
        3D divided-section rendering for the control-point viewer.

        Each section's point range is drawn as two offset carriageways.
        Median: light-gray strip slightly RAISED above the road (+6u).
        Divider: dark strip with a thin vertical wall (+8u posts).
        Direction labels (N/S or E/W) at each section's midpoint.
        Tapers match the 2D map (3-point smooth transitions).
        """
        pts = road.get("pts", [])
        n = len(pts)
        sections = road.get("divided_sections") or []
        # World-space perpendiculars from neighbor segments.
        normals = []
        for i, (px, pz) in enumerate(pts):
            if i == 0:
                dx, dz = pts[1][0] - px, pts[1][1] - pz
            elif i == n - 1:
                dx, dz = px - pts[i - 1][0], pz - pts[i - 1][1]
            else:
                dx, dz = (pts[i + 1][0] - pts[i - 1][0],
                          pts[i + 1][1] - pts[i - 1][1])
            length = math.hypot(dx, dz) or 1.0
            normals.append((-dz / length, dx / length))

        T = 3  # taper points, same as the 2D map
        lab_l, lab_r = _direction_labels(pts)

        def height_at(i):
            """Road height (terrain + offset + lift) at point i."""
            px, pz = pts[i]
            return self._road_height(sampler, px, pz, key)

        for sec in sections:
            dtype = sec.get("type")
            if dtype not in ("median", "divider"):
                continue
            try:
                a = max(0, int(sec.get("from_idx", 0)))
                b = min(n - 1, int(sec.get("to_idx", 0)))
            except (TypeError, ValueError):
                continue
            if not (0 <= a < b < n):
                continue
            strip_w = 8.0 if dtype == "median" else 4.0
            # Carriageway center offset from the centerline.
            center_off = strip_w / 2.0 + 5.0

            def taper(i):
                if a <= i <= b:
                    return 1.0
                if max(0, a - T) <= i < a:
                    return (i - max(0, a - T)) / max(1, a - max(0, a - T))
                if b < i <= min(n - 1, b + T):
                    return (min(n - 1, b + T) - i) / max(
                        1, min(n - 1, b + T) - b)
                return 0.0

            # Offset carriageway centerlines (world space).
            left, right, center = [], [], []
            for i in range(max(0, a - T), min(n, b + T + 1)):
                f = taper(i)
                if f <= 0:
                    continue
                px, pz = pts[i]
                nx, nz = normals[i]
                off = center_off * f
                h = height_at(i)
                left.append(proj(px + nx * off, pz + nz * off, h))
                right.append(proj(px - nx * off, pz - nz * off, h))
                center.append((proj(px, pz, h), h, px, pz, i))

            if len(left) < 2:
                continue
            # Carriageways in the road color, slightly thinner.
            cr.set_source_rgb(*color)
            cr.set_line_width(max(2.0, 3.5 * self.zoom))
            cr.set_line_cap(1)
            cr.set_line_join(1)
            for line in (left, right):
                cr.move_to(*line[0])
                for p in line[1:]:
                    cr.line_to(*p)
                cr.stroke()

            if dtype == "median":
                # Raised light-gray median strip (+6 world units).
                cr.set_source_rgb(0.80, 0.80, 0.77)
                cr.set_line_width(max(2.0, 3.0 * self.zoom))
                cr.move_to(*proj(center[0][2], center[0][3],
                                 center[0][1] + 6.0))
                for _, h, px, pz, _i in center[1:]:
                    cr.line_to(*proj(px, pz, h + 6.0))
                cr.stroke()
            else:
                # Divider: dark strip + thin vertical wall posts.
                cr.set_source_rgb(0.16, 0.16, 0.16)
                cr.set_line_width(max(1.5, 2.0 * self.zoom))
                cr.move_to(*proj(center[0][2], center[0][3],
                                 center[0][1] + 2.0))
                for _, h, px, pz, _i in center[1:]:
                    cr.line_to(*proj(px, pz, h + 2.0))
                cr.stroke()
                # Vertical posts every 4th vertex, 8 units tall.
                cr.set_source_rgb(0.85, 0.85, 0.85)
                cr.set_line_width(1.5)
                for k in range(0, len(center), 4):
                    _, h, px, pz, _i = center[k]
                    cr.move_to(*proj(px, pz, h + 2.0))
                    cr.line_to(*proj(px, pz, h + 10.0))
                    cr.stroke()

            # Direction labels at the middle of each carriageway.
            cr.set_source_rgb(1.0, 1.0, 1.0)
            cr.set_font_size(10)
            for line, lab in ((left, lab_l), (right, lab_r)):
                sx, sy = line[len(line) // 2]
                cr.move_to(sx - 4, sy - 4)
                cr.show_text(lab)

    def _draw_endpoints(self, cr, proj, sampler, road_key, road):
        """Draw clickable endpoint circles; cache screen positions."""
        cat, idx = road_key
        name = road.get("name") or "Unnamed"
        key = RoadElevStore.key_for(cat, name)
        pts = road.get("pts", [])
        for end_idx in (0, len(pts) - 1):
            px, pz = pts[end_idx]
            sx, sy = proj(px, pz,
                          self._road_height(sampler, px, pz, key))
            self._ep_screen.append((road_key, end_idx, sx, sy))
            selected = (self.sel_endpoint is not None and
                        self.sel_endpoint[0] == road_key and
                        self.sel_endpoint[1] == end_idx)
            # Amber circle; filled when selected.
            cr.set_source_rgb(1.0, 0.75, 0.15)
            cr.arc(sx, sy, 7 if selected else 5, 0, 2 * math.pi)
            if selected:
                cr.fill()
            else:
                cr.set_line_width(2.0)
                cr.stroke()

    def _draw_snap_indicator(self, cr, proj, sampler):
        """
        Dashed line from the selected endpoint to the snap candidate,
        plus a "click to snap" hint. Only when a candidate exists.
        """
        if self.snap_candidate is None or self.sel_endpoint is None:
            return
        road_key, end_idx = self.sel_endpoint
        # Find the endpoint's screen position
        ep = None
        for rk, ei, sx, sy in self._ep_screen:
            if rk == road_key and ei == end_idx:
                ep = (sx, sy)
                break
        if ep is None:
            return
        twx, twz, _tname = self.snap_candidate
        th = sampler.sample(twx, twz) + ROAD_LIFT
        # Recompute projection focus (same as _on_draw)
        roads = self._selected_roads()
        bbox = self._road_bbox(roads)
        if bbox is None:
            return
        alloc = self.get_allocation()
        cx = (bbox[0] + bbox[2]) / 2.0
        cz = (bbox[1] + bbox[3]) / 2.0
        tx, ty = self._proj(twx, twz, th, cx, cz,
                            alloc.width / 2.0, alloc.height / 2.0 + 20)
        cr.set_source_rgb(0.3, 0.9, 1.0)  # cyan snap line
        cr.set_line_width(2.0)
        cr.set_dash([6.0, 4.0])
        cr.move_to(*ep)
        cr.line_to(tx, ty)
        cr.stroke()
        cr.set_dash([])
        cr.arc(tx, ty, 5, 0, 2 * math.pi)
        cr.stroke()
        cr.set_source_rgb(0.6, 0.95, 1.0)
        cr.set_font_size(11)
        cr.move_to(8, 18)
        cr.show_text("Snap available — double-click endpoint or press Snap")

    # -- interaction ---------------------------------------------------

    def _update_snap_candidate(self):
        """
        For the selected endpoint, find the nearest point on any OTHER
        road within SNAP_RADIUS. Sets self.snap_candidate or None.
        """
        self.snap_candidate = None
        if self.sel_endpoint is None:
            return
        app = self.panel.app
        canvas = getattr(app, "canvas", None)
        if canvas is None or not getattr(app, "spatial_index", None):
            return
        road_key, end_idx = self.sel_endpoint
        road = canvas._get_road_dict(*road_key)
        if road is None:
            return
        pts = road.get("pts", [])
        ex, ez = pts[end_idx]
        best = None  # (dist, wx, wz, name)
        for rcat, rroad, _rx0, _rz0, _rx1, _rz1 in \
                app.spatial_index.roads:
            if rroad is road:
                continue  # not the road itself
            # Check each segment for the closest point
            rpts = rroad.get("pts", [])
            for i in range(len(rpts) - 1):
                x0, z0 = rpts[i]
                x1, z1 = rpts[i + 1]
                dx, dz = x1 - x0, z1 - z0
                lsq = dx * dx + dz * dz
                if lsq == 0:
                    px, pz = x0, z0
                else:
                    t = max(0.0, min(1.0,
                                     ((ex - x0) * dx + (ez - z0) * dz) / lsq))
                    px, pz = x0 + t * dx, z0 + t * dz
                d = math.hypot(ex - px, ez - pz)
                if d < SNAP_RADIUS and (best is None or d < best[0]):
                    best = (d, px, pz,
                            rroad.get("name") or "Unnamed")
        if best is not None:
            self.snap_candidate = (best[1], best[2], best[3])

    def do_snap(self):
        """
        Move the selected endpoint onto the snap candidate point.
        Commits through the app's road-mutation path so the change is
        saved, indexed, and pushed like any other edit.
        Returns True on success.
        """
        if self.sel_endpoint is None or self.snap_candidate is None:
            return False
        app = self.panel.app
        canvas = getattr(app, "canvas", None)
        if canvas is None:
            return False
        road_key, end_idx = self.sel_endpoint
        cat, idx = road_key
        road = canvas._get_road_dict(cat, idx)
        if road is None:
            return False
        twx, twz, tname = self.snap_candidate
        pts = road.get("pts", [])
        # Undo (Joshua 2026-10-12): snapshot before moving the endpoint.
        app.undo_begin("Snap Endpoint (3D Inspector)")
        pts[end_idx] = [twx, twz]  # move the endpoint in place
        ok = app.apply_road_modify(cat, road)
        app.undo_commit()
        if ok:
            app.set_status(
                "Snapped endpoint to '%s'." % tname)
            self.sel_endpoint = None
            self.snap_candidate = None
            self.panel.refresh()
        else:
            app.set_status("Snap failed: could not update road data.")
        return ok

    def _on_press(self, widget, event):
        """Left click: endpoint select; double-click: snap."""
        if event.button == 3:
            # Right-drag rotates in any mode (consistent with building
            # editor). Start a rotate drag.
            self._dragging = True
            self._drag_x = event.x
            self._drag_angle = self.view_angle
            return True
        if event.button != 1:
            return True
        # Double-click on a selected endpoint = snap (if available).
        if event.type == Gdk.EventType._2BUTTON_PRESS:
            if self.sel_endpoint is not None and \
                    self.snap_candidate is not None:
                # Only snap if the double-click landed on the endpoint
                for rk, ei, sx, sy in self._ep_screen:
                    if (rk == self.sel_endpoint[0] and
                            ei == self.sel_endpoint[1] and
                            math.hypot(event.x - sx,
                                       event.y - sy) <= ENDPOINT_PICK_PX):
                        self.do_snap()
                        return True
            return True
        # Single click: hit-test endpoints first.
        for rk, ei, sx, sy in self._ep_screen:
            if math.hypot(event.x - sx, event.y - sy) <= ENDPOINT_PICK_PX:
                self.sel_endpoint = (rk, ei)
                self._update_snap_candidate()
                self.queue_draw()
                self.panel.update_snap_ui()
                return True
        # Clicked elsewhere: deselect endpoint, start view rotation.
        if self.sel_endpoint is not None:
            self.sel_endpoint = None
            self.snap_candidate = None
            self.panel.update_snap_ui()
            self.queue_draw()
        self._dragging = True
        self._drag_x = event.x
        self._drag_angle = self.view_angle
        return True

    def _on_release(self, widget, event):
        """End any rotate drag."""
        self._dragging = False
        return True

    def _on_motion(self, widget, event):
        """Rotate the view while dragging."""
        if self._dragging:
            dx = event.x - self._drag_x
            self.view_angle = self._drag_angle + dx * 0.01
            self.queue_draw()
        return True

    def _on_scroll(self, widget, event):
        """Mouse wheel zooms the 3D view."""
        if event.direction == Gdk.ScrollDirection.UP:
            self.zoom = min(3.0, self.zoom * 1.15)
        elif event.direction == Gdk.ScrollDirection.DOWN:
            self.zoom = max(0.05, self.zoom / 1.15)
        self.queue_draw()
        return True


# ---------------------------------------------------------------------------
# Bottom viewer: elevation profile (side view, drag road up/down)
# ---------------------------------------------------------------------------

class ElevationViewer(Gtk.DrawingArea):
    """
    Bottom 3D viewer: side-view elevation profile of the selected road.

    - Horizontal axis: distance along the road.
    - Vertical axis: elevation (exaggerated for visibility).
    - Terrain cross-section is drawn under the road path; the road
      ribbon sits at terrain height + its elevation offset.
    - Click the road face and drag UP/DOWN to change the offset.
      Vertical only — no sideways or forward/back movement (Joshua
      2026-10-11: this viewer is purely about elevation).
    """

    def __init__(self, panel):
        """panel is the owning RoadInspectorPanel (shared state)."""
        super().__init__()
        self.panel = panel
        # Vertical exaggeration for the elevation axis.
        self.v_ex = 4.0
        # Drag state: None, or (start_sy, start_offset).
        self._drag = None
        self._grabbed_key = None  # "cat/name" of the road being dragged
        self.set_size_request(280, 180)
        self.set_can_focus(True)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK |
                        Gdk.EventMask.BUTTON_RELEASE_MASK |
                        Gdk.EventMask.POINTER_MOTION_MASK)
        self.connect("draw", self._on_draw)
        self.connect("button-press-event", self._on_press)
        self.connect("button-release-event", self._on_release)
        self.connect("motion-notify-event", self._on_motion)

    # -- profile computation (headless-testable pieces) ------------------

    def _profile(self):
        """
        Build the elevation profile for the FIRST selected road.
        Returns (distances, terrain_h, road_name, key, offset) or None.
        distances: cumulative world distance along the polyline.
        terrain_h: sampled terrain height at each point.
        """
        app = self.panel.app
        canvas = getattr(app, "canvas", None)
        if canvas is None or not getattr(app, "roads_data", None):
            return None
        sel = getattr(canvas, "selected_roads", [])
        if not sel:
            return None
        cat, idx = sel[0]
        road = canvas._get_road_dict(cat, idx)
        pts = road.get("pts", []) if road else []
        if len(pts) < 2:
            return None
        name = road.get("name") or "Unnamed"
        key = RoadElevStore.key_for(cat, name)
        offset = self.panel.elev.get(key)
        sampler = self.panel.terrain
        dists, hs = [0.0], []
        for i, (px, pz) in enumerate(pts):
            if i > 0:
                qx, qz = pts[i - 1]
                dists.append(dists[-1] + math.hypot(px - qx, pz - qz))
            hs.append(sampler.sample(px, pz))
        return dists, hs, name, key, offset

    def _plot_geom(self, w, h, dists, hs, offset):
        """
        Compute plot geometry: returns dict with the y-mapping closure
        and road polyline screen points. Shared by draw + hit-testing.
        """
        total = dists[-1] or 1.0
        all_h = [x + offset for x in hs] + hs
        h_min = min(all_h) - 5.0
        h_max = max(all_h) + 5.0
        span = max(1.0, h_max - h_min)
        m_l, m_r, m_t, m_b = 36, 10, 14, 26  # margins
        pw, ph = w - m_l - m_r, h - m_t - m_b

        def sx(d):
            return m_l + (d / total) * pw

        def sy(hh):
            # Screen y grows downward; elevation grows upward.
            return m_t + (1.0 - (hh - h_min) / span) * ph

        road_pts = [(sx(d), sy(hh + offset))
                    for d, hh in zip(dists, hs)]
        terr_pts = [(sx(d), sy(hh)) for d, hh in zip(dists, hs)]
        return {"sx": sx, "sy": sy, "road_pts": road_pts,
                "terr_pts": terr_pts, "h_min": h_min, "h_max": h_max,
                "m_l": m_l, "m_t": m_t, "pw": pw, "ph": ph, "span": span}

    # -- drawing -------------------------------------------------------

    def _on_draw(self, widget, cr):
        """Render the elevation profile."""
        alloc = self.get_allocation()
        w, h = alloc.width, alloc.height
        cr.set_source_rgb(0.10, 0.10, 0.13)
        cr.paint()

        prof = self._profile()
        if prof is None:
            self._draw_placeholder(cr, w, h)
            return
        dists, hs, name, key, offset = prof
        g = self._plot_geom(w, h, dists, hs, offset)

        # Title + offset readout
        cr.set_source_rgb(0.75, 0.75, 0.8)
        cr.set_font_size(12)
        cr.move_to(8, 14)
        cr.show_text("Elevation: %s  (offset %+.1f)" % (name, offset))

        # Terrain cross-section (filled silhouette, natural tone).
        cr.set_source_rgb(0.30, 0.38, 0.20)
        cr.move_to(g["terr_pts"][0][0], h - g["m_t"] - 0)
        # Build polygon: along terrain, then back along the bottom.
        cr.move_to(*g["terr_pts"][0])
        for p in g["terr_pts"][1:]:
            cr.line_to(*p)
        cr.line_to(g["terr_pts"][-1][0], h - 26)
        cr.line_to(g["terr_pts"][0][0], h - 26)
        cr.close_path()
        cr.fill()

        # Height gridlines with labels (every ~10 world units).
        cr.set_source_rgb(0.25, 0.25, 0.3)
        cr.set_line_width(1.0)
        cr.set_font_size(9)
        step = 10.0
        gh = math.ceil(g["h_min"] / step) * step
        while gh <= g["h_max"]:
            yy = g["sy"](gh)
            cr.move_to(g["m_l"], yy)
            cr.line_to(w - 10, yy)
            cr.stroke()
            cr.set_source_rgb(0.5, 0.5, 0.55)
            cr.move_to(4, yy + 3)
            cr.show_text("%d" % int(gh))
            cr.set_source_rgb(0.25, 0.25, 0.3)
            gh += step

        # Road ribbon at terrain + offset (amber when grabbed).
        grabbed = (self._grabbed_key == key)
        cr.set_source_rgb(1.0, 0.75, 0.15 if grabbed else 0.55)
        if not grabbed:
            cr.set_source_rgb(1.0, 0.67, 0.0)  # arterial orange default
        cr.set_line_width(7.0)
        cr.set_line_cap(1)
        cr.move_to(*g["road_pts"][0])
        for p in g["road_pts"][1:]:
            cr.line_to(*p)
        cr.stroke()
        # Dashed zero-offset reference (where the road would sit on raw
        # terrain) when an offset is applied.
        if abs(offset) > 0.0005:
            cr.set_source_rgb(0.6, 0.6, 0.65)
            cr.set_line_width(1.5)
            cr.set_dash([5.0, 4.0])
            cr.move_to(*g["terr_pts"][0])
            for p in g["terr_pts"][1:]:
                cr.line_to(*p)
            cr.stroke()
            cr.set_dash([])

        # Hint
        cr.set_source_rgb(0.6, 0.6, 0.65)
        cr.set_font_size(10)
        cr.move_to(8, h - 8)
        cr.show_text("Drag the road up / down to set elevation")

    def _draw_placeholder(self, cr, w, h):
        """Empty-state message when no road is selected."""
        cr.set_source_rgb(0.55, 0.55, 0.6)
        cr.set_font_size(12)
        cr.move_to(20, h // 2)
        cr.show_text("Select a road to see its elevation")

    # -- interaction ---------------------------------------------------

    def _hit_road(self, event, g):
        """True if the click is within 10px of the road polyline."""
        for px, py in g["road_pts"]:
            if math.hypot(event.x - px, event.y - py) <= 10.0:
                return True
        # Also accept clicks between segments (segment distance).
        pts = g["road_pts"]
        for i in range(len(pts) - 1):
            x0, y0 = pts[i]
            x1, y1 = pts[i + 1]
            dx, dy = x1 - x0, y1 - y0
            lsq = dx * dx + dy * dy
            if lsq == 0:
                d = math.hypot(event.x - x0, event.y - y0)
            else:
                t = max(0.0, min(1.0,
                                 ((event.x - x0) * dx +
                                  (event.y - y0) * dy) / lsq))
                d = math.hypot(event.x - (x0 + t * dx),
                               event.y - (y0 + t * dy))
            if d <= 10.0:
                return True
        return False

    def _on_press(self, widget, event):
        """Grab the road face to start a vertical drag."""
        if event.button != 1:
            return True
        prof = self._profile()
        if prof is None:
            return True
        dists, hs, name, key, offset = prof
        alloc = self.get_allocation()
        g = self._plot_geom(alloc.width, alloc.height, dists, hs, offset)
        if self._hit_road(event, g):
            # Vertical-only drag: record start Y and start offset.
            # Pixels -> world height via the plot's vertical scale.
            self._drag = (event.y, offset, g["ph"] / g["span"])
            self._grabbed_key = key
            self.queue_draw()
        return True

    def _on_motion(self, widget, event):
        """Drag the road face up/down; update the elevation offset."""
        if self._drag is None or self._grabbed_key is None:
            return True
        start_y, start_offset, px_per_unit = self._drag
        # Screen y grows downward; dragging up (negative dy) raises.
        dy_world = -(event.y - start_y) / max(0.001, px_per_unit)
        new_offset = start_offset + dy_world
        # Clamp to a sane range so the road can't be lost in the sky.
        new_offset = max(-200.0, min(500.0, new_offset))
        self.panel.elev.set(self._grabbed_key, new_offset)
        # Mark unpublished so the close warning + auto-push pick it up.
        try:
            self.panel.app._mark_unpublished()
        except AttributeError:
            pass
        self.queue_draw()
        return True

    def _on_release(self, widget, event):
        """End the elevation drag."""
        if self._drag is not None:
            self._drag = None
            self._grabbed_key = None
            self.queue_draw()
        return True


# ---------------------------------------------------------------------------
# The dockable panel
# ---------------------------------------------------------------------------

class RoadInspectorPanel(Gtk.Box):
    """
    Right-side dockable panel hosting the two 3D viewers.

    Layout: header (title + collapse handled by the parent wrap) then a
    vertical paned with the ControlPointViewer on top and the
    ElevationViewer below. Both viewers stay in sync with the main
    canvas selection via refresh().
    """

    def __init__(self, app):
        """
        app is the MapEditorApp. Shared state (terrain sampler, elevation
        store) lives here so both viewers see the same data.
        """
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.app = app
        # Shared state for both viewers.
        self.terrain = TerrainSampler()
        self.terrain.load()  # silent no-op when no terrain cached
        self.elev = RoadElevStore()

        # Header
        header = Gtk.Label()
        header.set_markup("<b>3D Road Inspector</b>")
        header.set_margin_top(6)
        header.set_margin_bottom(4)
        self.pack_start(header, False, False, 0)

        # Vertical paned: control points (top) / elevation (bottom).
        # Paned sash lets Joshua resize the two viewers.
        paned = Gtk.Paned(orientation=Gtk.Orientation.VERTICAL)
        paned.set_position(260)
        self.pack_start(paned, True, True, 0)

        # -- Top: control points viewer in a labeled frame --
        top_frame = Gtk.Frame(label="Control Points")
        self.cp_viewer = ControlPointViewer(self)
        top_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        top_box.pack_start(self.cp_viewer, True, True, 0)
        # Snap button row (enabled only when a snap candidate exists).
        snap_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                           spacing=6)
        snap_row.set_margin_start(6)
        snap_row.set_margin_end(6)
        snap_row.set_margin_bottom(4)
        self.snap_label = Gtk.Label(label="No endpoint selected")
        self.snap_label.set_halign(Gtk.Align.START)
        self.snap_label.set_hexpand(True)
        snap_row.pack_start(self.snap_label, True, True, 0)
        self.snap_button = Gtk.Button(label="Snap to Road")
        self.snap_button.set_tooltip_text(
            "Move the selected endpoint onto the nearby road")
        self.snap_button.set_sensitive(False)
        self.snap_button.connect(
            "clicked", lambda _w: self.cp_viewer.do_snap())
        snap_row.pack_start(self.snap_button, False, False, 0)
        top_box.pack_start(snap_row, False, False, 0)
        top_frame.add(top_box)
        paned.pack1(top_frame, resize=True, shrink=False)

        # -- Bottom: elevation viewer in a labeled frame --
        bot_frame = Gtk.Frame(label="Elevation")
        self.elev_viewer = ElevationViewer(self)
        bot_frame.add(self.elev_viewer)
        paned.pack2(bot_frame, resize=True, shrink=False)

        self.set_size_request(300, -1)
        self.show_all()

    # -- public API used by app.py ------------------------------------

    def refresh(self):
        """
        Re-read the main canvas selection and redraw both viewers.
        Called on selection change and after join/merge/extend edits.
        """
        # Drop a stale endpoint selection (e.g. after join cleared it).
        valid_keys = set()
        canvas = getattr(self.app, "canvas", None)
        if canvas is not None:
            valid_keys = set(getattr(canvas, "selected_roads", []))
        if (self.cp_viewer.sel_endpoint is not None and
                self.cp_viewer.sel_endpoint[0] not in valid_keys):
            self.cp_viewer.sel_endpoint = None
            self.cp_viewer.snap_candidate = None
        self.cp_viewer.queue_draw()
        self.elev_viewer.queue_draw()
        self.update_snap_ui()

    def update_snap_ui(self):
        """Enable/disable the Snap button + label from viewer state."""
        v = self.cp_viewer
        if v.snap_candidate is not None:
            _wx, _wz, tname = v.snap_candidate
            self.snap_label.set_text("Near '%s' — snap available" % tname)
            self.snap_button.set_sensitive(True)
        elif v.sel_endpoint is not None:
            self.snap_label.set_text(
                "Endpoint selected — no nearby road (visual only)")
            self.snap_button.set_sensitive(False)
        else:
            self.snap_label.set_text("No endpoint selected")
            self.snap_button.set_sensitive(False)
