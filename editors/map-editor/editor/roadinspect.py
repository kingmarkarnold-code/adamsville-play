#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) — Inspection Panel (linked viewpoints).

Dockable right-side panel, reworked in 1.9.8 around ONE shared camera
(Joshua 2026-10-18: the viewpoints work together — pan one and the
others pan, rotate one and the others rotate). The camera lives in
the main canvas (mapcanvas.Camera2D: centre + zoom + heading); every
viewer in this panel is a VIEW of that camera and keeps no private
camera of its own.

- ControlPointViewer (top): the 3D / satellite viewpoint of the
  CURRENT AREA. It stays BLACK until clicked (Joshua: it should
  "continue to stay black, but if you tap on it or click on it then
  it will show you a 3D of whatever area you're in"). Once awake it
  renders the area the main view is looking at, from the game data:
  terrain (the game's own ground), roads draped on it, building
  blocks (fetched lazily per zone — see areadata.py), overpasses.
  A mode toggle on the panel switches it between the isometric 3D
  view and the SATELLITE viewpoint: a top-down picture of our own
  3D world (materials, blocks, roads as the game draws them — NOT
  real satellite photography; Joshua's definition). The selected
  road keeps its 2026-10-11 treatment in 3D: clickable endpoints
  and snap-to-road (double-click or the Snap button).
- ResourceMapViewer (bottom, in the "Resource map" frame;
  1.9.12 — Joshua's design clarification): the RESOURCE MAP —
  the reference map data the world was built FROM (the repo's
  map-data/game-map/roads.json, already in world coordinates) —
  shown at the SAME location and zoom as the top viewer, so he
  can compare where streets currently are in our world against
  where the reference says they should be. It is reference
  material only: the pane never edits it (map-data/ is
  read-only by standing rule), and it draws NO game data. The
  views stay linked both ways: the pane follows the shared
  camera (and the top pane's selection framing — a click that
  selects a road frames the same clicked point here), and
  dragging in the pane pans the shared camera like everywhere
  else. The readout line above the pane still carries the
  selected road's elevation offset with its ▲ / ▼ steppers
  (that is what the readout is FOR — it is not the pane).

Gestures are the same in every pane (the sync law): drag pans the
shared camera, Ctrl+drag rotates it, the wheel zooms it. Panes
redraw each other through the app's on_camera_changed hook.

Purpose (Joshua 2026-10-11, still the point of the 3D view):
- "See where the road is looking like on a 3D model"
- "Make sure that the algorithm of joining and merging is working
  correctly" (visual verification of join/merge results)
- "See the underlying terrain"

Joshua's rule: all code commented.
"""

import copy
import math
import threading

import cairo
import json
import sys
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib, Pango

# Area data for the viewpoints (per-zone buildings, lazily fetched).
from areadata import BuildingsStore

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
# Terrain heights for the area viewpoints (the game's own ground)
# ---------------------------------------------------------------------------
# The 3D and satellite viewpoints drape and shade the CURRENT AREA
# with the game's ground: ground.GroundModel.terrain_mesh_y, the
# faithful port of the game's rendered terrain (same function the
# converter draped every road's "ys" with). Heights are computed on
# a coarse grid over the area being shown and cached — the area is
# small (a few thousand units at most), so a 17x17 or 25x25 grid is
# both truthful and cheap, and panning within ~50 units reuses it.
# (The pre-1.9.8 TerrainSampler is retired: it sampled a 150x200
# downsample of the OLD 8000x12000 frame, which the converted world
# no longer lives in.)

# The 3D viewpoint never renders more than this many world units
# across, however far the 2D view is zoomed out — "current area
# only" is the lightweight law, and a whole-world 3D render on
# Joshua's laptop is exactly what the law exists to prevent. When
# the 2D view is zoomed out past this, the 3D view shows the
# central area around the shared centre.
AREA_MAX_SPAN = 3500.0
# ...and never less: zoomed hard in, the 3D view still shows a
# readable neighbourhood rather than one road filling the pane.
AREA_MIN_SPAN = 240.0

# The selection still's span (1.9.11): when a click selects a
# piece, the still frames the CLICKED POINT at street level —
# this many world units across, centred exactly where he
# clicked, so the picture is the spot he picked, not the whole
# area the 2D view happens to cover.
EYE_STILL_SPAN = 240.0


class _PatchSampler:
    """
    Bilinear height sampler over one cached patch grid — the
    .sample(wx, wz) shape the 3D drawing helpers already speak.
    heights is a list of rows (z direction), each a list of node
    heights (x direction), nodes spaced `step` world units apart
    starting at (x0, z0).
    """

    def __init__(self, x0, z0, step, heights):
        self.x0, self.z0, self.step = x0, z0, step
        self.heights = heights
        self.rows = len(heights)
        self.cols = len(heights[0]) if heights else 0

    def sample(self, wx, wz):
        """Bilinear height at (wx, wz), clamped to the patch."""
        if not self.heights:
            return 0.0
        fx = max(0.0, min(self.cols - 1.001,
                          (wx - self.x0) / self.step))
        fz = max(0.0, min(self.rows - 1.001,
                          (wz - self.z0) / self.step))
        ix, iz = int(fx), int(fz)
        tx, tz = fx - ix, fz - iz
        h = self.heights
        a, b = h[iz][ix], h[iz][ix + 1]
        c, d = h[iz + 1][ix], h[iz + 1][ix + 1]
        return (a + (b - a) * tx + (c - a) * tz
                + (a - b - c + d) * tx * tz)


def ground_height_fn(app):
    """
    The app's game-ground function (terrain_mesh_y) or None when
    the model/elev has not loaded. Fail-open: viewpoints fall back
    to flat ground rather than dying before the download lands.
    """
    try:
        gm = app._ground_model()
    except Exception:
        gm = None
    return gm.terrain_mesh_y if gm is not None else None


def heights_grid(app, x0, z0, x1, z1, nodes):
    """
    A _PatchSampler over the rect with `nodes` nodes per side,
    heights from the game's ground (all zeros when the ground is
    unavailable). Node count is the caller's resolution choice;
    the rects the viewpoints ask for are small.
    """
    fn = ground_height_fn(app)
    step_x = (x1 - x0) / (nodes - 1)
    step_z = (z1 - z0) / (nodes - 1)
    rows = []
    for j in range(nodes):
        wz = z0 + j * step_z
        row = []
        for i in range(nodes):
            wx = x0 + i * step_x
            row.append(fn(wx, wz) if fn is not None else 0.0)
        rows.append(row)
    # step is uniform in the sampler; the rects asked for are
    # square in practice — use the x step and note the assumption.
    return _PatchSampler(x0, z0, step_x, rows)


# Satellite ground tint: height-banded tones in the spirit of the
# game's terrain tint — low ground greener, high ground browner,
# so the top-down picture reads as land, not a blank fill.
def ground_tint(height):
    """RGB fill for one satellite ground cell at the given height."""
    # Heights in the converted world run roughly -5..60.
    t = max(0.0, min(1.0, (height + 5.0) / 65.0))
    low = (0.26, 0.38, 0.18)    # lowland green
    high = (0.48, 0.40, 0.26)   # upland brown-green
    return (low[0] + (high[0] - low[0]) * t,
            low[1] + (high[1] - low[1]) * t,
            low[2] + (high[2] - low[2]) * t)


# Roof colours for the area viewpoints, by the game's building
# type code (0 residential/generic, 1 commercial, 2 multi-unit /
# institutional, 3 other/special) — flat material tones like the
# game's own stylised buildings.
ROOF_COLORS = {
    0: (0.62, 0.36, 0.24),   # residential — warm brick/terracotta
    1: (0.55, 0.58, 0.62),   # commercial — flat gray
    2: (0.70, 0.62, 0.48),   # multi-unit — tan
    3: (0.45, 0.50, 0.55),   # special — slate
}
ROOF_DEFAULT = (0.58, 0.50, 0.42)


def roof_color(type_code):
    """Roof tone for a building type code (default for unknown)."""
    return ROOF_COLORS.get(type_code, ROOF_DEFAULT)


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

def _zone_ids_for_rect(rect):
    """
    Game zone ids whose editor zone bboxes intersect the world
    rect (x0, z0, x1, z1) — used to fetch buildings lazily for just
    the zones on screen. Display names in data.ZONES map to game
    ids by squashing spaces/case ("South Fulton" -> "southfulton").
    """
    import data as _data
    import gamedata as _gd
    x0, z0, x1, z1 = rect
    out = []
    for zone in _data.ZONES:
        name = zone.get("name", "")
        zid = "".join(name.split()).casefold()
        if zid not in _gd.ZONE_IDS:
            continue
        bx0, bz0, bx1, bz1 = _data.zone_bbox(zone)
        if bx1 >= x0 and bx0 <= x1 and bz1 >= z0 and bz0 <= z1:
            out.append(zid)
    return out


def _roads_in_rect(app, rect):
    """
    [(category, flat_index, road)] overlapping a world rect, via
    the spatial index (query returns flat indices into its roads
    table of (category, road, bbox...) tuples).
    """
    idx = getattr(app, "spatial_index", None)
    if idx is None:
        return []
    out = []
    for fi in idx.query(rect[0], rect[1], rect[2], rect[3]):
        try:
            entry = idx.roads[fi]
            out.append((entry[0], fi, entry[1]))
        except Exception:
            continue
    return out


def _draw_map_roads(cr, app, cam, w, h, omit_ids=frozenset(),
                    selected_ids=frozenset(), thin_locals=False):
    """
    Draw the roads visible through `cam` in a w x h pane — the 2D
    map picture shared by the elevation/map pane and the delete
    comparison stills. omit_ids (id(road) set) are skipped (the
    After picture); selected_ids are repainted yellow on top.
    """
    from data import ROAD_STYLE, normalize_category
    vp = cam.get_viewport(w, h)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.set_line_join(cairo.LINE_JOIN_ROUND)
    selected = []
    for cat, _i, road in _roads_in_rect(app, vp):
        if id(road) in omit_ids:
            continue
        if id(road) in selected_ids:
            selected.append(road)
            continue
        ncat = normalize_category(cat)
        style = ROAD_STYLE.get(ncat, ROAD_STYLE["local"])
        pts = road.get("pts") or []
        if len(pts) < 2:
            continue
        cr.set_source_rgb(*style["color"])
        width = style["width"] * cam.zoom
        if thin_locals and ncat == "local":
            width = min(width, 1.0)
        cr.set_line_width(max(0.6, width))
        for j, (wx, wz) in enumerate(pts):
            sx, sy = cam.world_to_screen(wx, wz, w, h)
            cr.line_to(sx, sy) if j else cr.move_to(sx, sy)
        cr.stroke()
    # Selected roads last, in the editor's selection yellow.
    cr.set_source_rgb(1.0, 0.85, 0.1)
    for road in selected:
        pts = road.get("pts") or []
        if len(pts) < 2:
            continue
        cr.set_line_width(max(1.6, 10.0 * cam.zoom))
        for j, (wx, wz) in enumerate(pts):
            sx, sy = cam.world_to_screen(wx, wz, w, h)
            cr.line_to(sx, sy) if j else cr.move_to(sx, sy)
        cr.stroke()


def _draw_map_buildings(cr, app, store, cam, w, h, zones):
    """
    Building blocks for a 2D map pane: footprint rectangles in
    roof tones, through the same camera. Only buildings the store
    has already loaded are drawn (never a blocking fetch here).
    """
    if store is None or not zones:
        return
    vp = cam.get_viewport(w, h)
    for (bx, bz, bw, bd, bh, btype) in store.query(zones, *vp):
        r, g, b = roof_color(btype)
        cr.set_source_rgb(r, g, b)
        corners = [(bx - bw / 2, bz - bd / 2), (bx + bw / 2, bz - bd / 2),
                   (bx + bw / 2, bz + bd / 2), (bx - bw / 2, bz + bd / 2)]
        for j, (wx, wz) in enumerate(corners):
            sx, sy = cam.world_to_screen(wx, wz, w, h)
            cr.line_to(sx, sy) if j else cr.move_to(sx, sy)
        cr.close_path()
        cr.fill()


def _draw_north_arrow(cr, cam, w, h):
    """
    A small north arrow + centre reticle for the 2D map panes:
    north on screen is wherever the shared camera's heading puts
    world -Z. Drawn from the camera transform itself, so it can
    never disagree with the picture.
    """
    cx, cy = cam.cam_x, cam.cam_y
    x0, y0 = cam.world_to_screen(cx, cy, w, h)
    x1, y1 = cam.world_to_screen(cx, cy - 100.0, w, h)
    dx, dy = x1 - x0, y1 - y0
    n = math.hypot(dx, dy) or 1.0
    dx, dy = dx / n, dy / n
    ax, ay = w - 22, 26
    cr.set_source_rgb(0.95, 0.95, 0.95)
    cr.set_line_width(2.0)
    cr.move_to(ax - dx * 10, ay - dy * 10)
    cr.line_to(ax + dx * 10, ay + dy * 10)
    cr.stroke()
    cr.move_to(ax + dx * 14, ay + dy * 14)
    cr.line_to(ax + dy * 5 - dx * 4, ay - dx * 5 - dy * 4)
    cr.line_to(ax - dy * 5 - dx * 4, ay + dx * 5 - dy * 4)
    cr.close_path()
    cr.fill()
    # Centre reticle.
    cr.set_source_rgba(1, 1, 1, 0.55)
    cr.set_line_width(1.0)
    cr.move_to(w / 2 - 7, h / 2)
    cr.line_to(w / 2 + 7, h / 2)
    cr.move_to(w / 2, h / 2 - 7)
    cr.line_to(w / 2, h / 2 + 7)
    cr.stroke()


# ---------------------------------------------------------------------------
# The resource map (reference) — 1.9.12
# ---------------------------------------------------------------------------
# The repo's map-data/game-map/roads.json: the reference roads the
# game world was built from, ALREADY in world coordinates (its
# header names the origin and "1 unit = 1 meter"), as records
# [name, highway_class, width, [[x, z], ...], [ys...]]. It is
# REFERENCE material — the bottom pane only ever reads it
# (map-data/ is never edited, by standing rule).

RESOURCE_ROADS_PATH = "map-data/game-map/roads.json"

# Resource highway class -> the editor's road category, so the
# reference draws in the same colours/widths as the game map.
RESOURCE_CATEGORY = {
    "motorway": "interstate", "motorway_link": "interstate",
    "trunk": "highway", "trunk_link": "highway",
    "primary": "highway", "primary_link": "highway",
    "secondary": "major_artery", "secondary_link": "major_artery",
    "tertiary": "minor_artery", "tertiary_link": "minor_artery",
}


def resource_category(highway_class):
    """Editor category for a resource-map highway class."""
    return RESOURCE_CATEGORY.get(highway_class or "", "local")


class ResourceRoadsStore:
    """
    The resource-map roads, fetched ONCE per run in the
    background and kept in memory behind a uniform-grid index —
    the BuildingsStore pattern, for one whole-world file instead
    of per-zone files. States: "absent" (never asked), "loading"
    (worker in flight), "ready" (parsed + indexed), "failed"
    (fetch or parse failed; a later ensure() retries). The store
    owns no transport: the caller passes fetch_bytes(path) ->
    bytes | None, so the app wires its own GitHub read and the
    harness can drive the store with fixture bytes through the
    same door (ingest()).
    """

    CELL = 512.0

    def __init__(self):
        self._records = []   # [(category, name, pts)]
        self._grid = {}      # (gx, gz) -> [record index]
        self._state = "absent"
        self._lock = threading.Lock()

    def state(self):
        with self._lock:
            return self._state

    def count(self):
        with self._lock:
            return len(self._records)

    def ingest(self, doc):
        """
        Install a parsed resource document and build the grid.
        Called by the fetch worker on completion, and directly
        by tests seeding known data — one door, same result.
        Records with fewer than 2 points draw nothing and are
        skipped, exactly as the map treats them.
        """
        records = []
        grid = {}
        for rec in (doc or {}).get("roads") or []:
            try:
                name = rec[0] or ""
                pts = rec[3] or []
            except Exception:
                continue
            if len(pts) < 2:
                continue
            cat = resource_category(rec[1] if len(rec) > 1
                                    else "")
            xs = [p[0] for p in pts]
            zs = [p[1] for p in pts]
            ri = len(records)
            records.append((cat, name, pts))
            gx0 = int(math.floor(min(xs) / self.CELL))
            gx1 = int(math.floor(max(xs) / self.CELL))
            gz0 = int(math.floor(min(zs) / self.CELL))
            gz1 = int(math.floor(max(zs) / self.CELL))
            for gx in range(gx0, gx1 + 1):
                for gz in range(gz0, gz1 + 1):
                    grid.setdefault((gx, gz), []).append(ri)
        with self._lock:
            self._records = records
            self._grid = grid
            self._state = "ready"

    def ensure(self, fetch_bytes, on_ready):
        """
        Start the one background fetch if it isn't running/done.
        fetch_bytes runs on the worker; on_ready(ok) is posted
        back through GLib.idle_add. Returns True when a fetch was
        started.
        """
        with self._lock:
            if self._state in ("loading", "ready"):
                return False
            self._state = "loading"

        def _work():
            ok = False
            try:
                blob = fetch_bytes(RESOURCE_ROADS_PATH)
                if blob:
                    doc = json.loads(blob.decode("utf-8"))
                    self.ingest(doc)
                    ok = True
            except Exception:
                ok = False
            if not ok:
                with self._lock:
                    if self._state == "loading":
                        self._state = "failed"
            GLib.idle_add(on_ready, ok)

        threading.Thread(target=_work, daemon=True,
                         name="resource-roads").start()
        return True

    def query(self, x0, z0, x1, z1):
        """[(category, name, pts)] whose bbox meets the rect —
        the pane's draw list for one viewport."""
        with self._lock:
            if self._state != "ready":
                return []
            records = self._records
            grid = self._grid
        out = []
        seen = set()
        gx0 = int(math.floor(x0 / self.CELL))
        gx1 = int(math.floor(x1 / self.CELL))
        gz0 = int(math.floor(z0 / self.CELL))
        gz1 = int(math.floor(z1 / self.CELL))
        for gx in range(gx0, gx1 + 1):
            for gz in range(gz0, gz1 + 1):
                for ri in grid.get((gx, gz), ()):
                    if ri in seen:
                        continue
                    seen.add(ri)
                    cat, name, pts = records[ri]
                    xs = [p[0] for p in pts]
                    zs = [p[1] for p in pts]
                    if max(xs) < x0 or min(xs) > x1 \
                            or max(zs) < z0 or min(zs) > z1:
                        continue
                    out.append((cat, name, pts))
        return out


class ControlPointViewer(Gtk.DrawingArea):
    """
    The area viewpoint (top pane of the inspector). Two pictures
    of the SAME shared camera the main canvas uses:

      * "3d" mode — a software-3D view of the current area: game
        ground, buildings and roads around the shared centre,
        tilted at the classic 35 degrees PLUS the shared heading,
        so rotating any view rotates this one by the same amount.
      * "satellite" mode — Joshua's satellite viewpoint: the same
        world drawn straight from above through the shared camera
        itself (roads, building blocks, height-tinted ground).

    The pane is BLACK — pure black, nothing drawn — until it is
    first clicked (Joshua's rule); the click that wakes it does
    nothing else. 1.9.11: a click that SELECTS a piece on the
    map also wakes it — framing a still on the clicked point at
    street level (wake_at) — because in 1.9.9 selecting left it
    black, the defect Joshua reported. Once awake: drag pans
    the shared camera, Ctrl+drag rotates it, the wheel zooms
    it — every other view follows, because there is only one
    camera. Endpoint picking and endpoint snapping (the pane's
    original job) still work in 3D mode on the selected road.

    During a delete confirmation the pane leaves all of that and
    holds the BEFORE still (see RoadInspectorPanel compare mode).
    """

    def __init__(self, panel):
        super().__init__()
        self.panel = panel
        self.app = panel.app
        # Black until clicked — the gate pixel-checks this.
        self.awake = False
        # STILL by default (Joshua, 1.9.8): the pane is a picture
        # rendered once per change of what it looks at — no
        # continuous rendering, which saves memory on his laptop.
        # The pane's state button flips it Live (fully movable:
        # drag/shift-drag/wheel work in it) and back.
        self.live = False
        self._still = None          # cached still surface
        self._still_dirty = True
        self._still_scheduled = False
        self.still_render_count = 0  # gate instrumentation
        # The eye focus (1.9.11): the world point of Joshua's
        # last click-pick, when the still is framing THAT spot
        # (see wake_at). None = the still follows the shared
        # camera as before. This is the fix for the 1.9.9 defect
        # (the pane stayed black after selecting): the pane only
        # ever woke on clicks IN the pane, and map selections
        # merely marked its still stale — a stale still on a
        # sleeping pane renders nothing, forever. Now a map
        # selection wakes it and hands it the clicked point.
        self._eye_focus = None
        # Drag state: None | ("pan", x, y, cam_x, cam_y) |
        # ("rotate", x, start_rotation).
        self._drag = None
        # Cached height grid for the current 3D patch:
        # (key, _PatchSampler, patch rect).
        self._grid = None
        # Cached satellite ground grid: (key, _PatchSampler, rect).
        self._sat_grid = None
        # Endpoint selection (the pane's original job): (road_key,
        # end_idx) with road_key = (cat, flat_idx); the snap
        # candidate for it: (target_wx, target_wz, target_name).
        self.sel_endpoint = None
        self.snap_candidate = None
        self._ep_screen = []   # [(road_key, end_idx, sx, sy)]
        # Current fit zoom of the last 3D frame (the restored
        # drawing helpers scale line widths by it).
        self._zoom_cached = 0.35
        # Projection of the last 3D draw, for picking + snap art.
        self._last_proj = None
        self._last_sampler = None
        self._last_patch = None
        self.set_size_request(200, 150)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK
                        | Gdk.EventMask.BUTTON_RELEASE_MASK
                        | Gdk.EventMask.POINTER_MOTION_MASK
                        | Gdk.EventMask.SCROLL_MASK)
        self.connect("draw", self._on_draw)
        self.connect("button-press-event", self._on_press)
        self.connect("button-release-event", self._on_release)
        self.connect("motion-notify-event", self._on_motion)
        self.connect("scroll-event", self._on_scroll)

    # -- shared-camera accessors ---------------------------------

    def _canvas(self):
        return getattr(self.app, "canvas", None)

    def _view_angle(self):
        """
        The 3D tilt direction: the classic 35-degree isometric
        base PLUS the shared camera heading, in radians. This one
        formula is the whole rotation sync for the 3D view.
        """
        canvas = self._canvas()
        heading = canvas.rotation if canvas is not None else 0.0
        return math.radians(35.0) + math.radians(heading)

    def focus_point(self):
        """The world point this pane is centred on: the eye
        focus while a selection still is framed on a click,
        otherwise the shared camera's centre."""
        if self._eye_focus is not None:
            return self._eye_focus
        canvas = self._canvas()
        if canvas is None:
            return (0.0, 0.0)
        return (canvas.cam_x, canvas.cam_y)

    def wake_at(self, wx, wz):
        """
        Wake the pane ON a world point (1.9.11): the still will
        frame (wx, wz) at street level (EYE_STILL_SPAN across).
        Called by the panel when a map click selects a piece —
        the activation the 1.9.9 build never had, which is why
        selecting left this pane black. The pane stays a STILL
        (one render per selection — the one-live-canvas rule);
        it does not become a live canvas.
        """
        self._eye_focus = (float(wx), float(wz))
        self.awake = True
        # The framed spot needs its buildings, like any wake.
        try:
            self.panel.request_area_data()
        except Exception:
            pass
        self.invalidate_still()
        self.queue_draw()

    # -- the still (render-once picture) ---------------------------

    def invalidate_still(self):
        """
        Mark the still stale and schedule ONE coalesced re-render
        (idle-time). A drag in another view fires many camera
        changes; they collapse into a single still refresh — the
        pane never renders continuously.
        """
        self._still_dirty = True
        if not self.awake or self.live or self.panel.compare_active():
            return
        if self._still_scheduled:
            return
        self._still_scheduled = True

        def _do():
            self._still_scheduled = False
            if self._still_dirty and self.awake and not self.live \
                    and not self.panel.compare_active():
                self.queue_draw()
            return False
        GLib.idle_add(_do)

    def _render_still(self, w, h):
        """Render the current picture once into the still cache."""
        surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, h)
        cr = cairo.Context(surf)
        if self.panel.view_mode == "satellite":
            self._draw_satellite(cr, w, h)
        else:
            self._draw_3d(cr, w, h)
        surf.flush()
        self._still = surf
        self._still_dirty = False
        self.still_render_count += 1

    # -- drawing --------------------------------------------------

    def _on_draw(self, _widget, cr):
        alloc = self.get_allocation()
        w, h = max(2, alloc.width), max(2, alloc.height)
        panel = self.panel
        # Delete comparison: hold the BEFORE still, nothing else.
        if panel.compare_active():
            panel.paint_compare_still(cr, "before", w, h)
            return False
        if not self.awake:
            # Joshua's rule: black until clicked. Pure black —
            # no text, no placeholder art.
            cr.set_source_rgb(0, 0, 0)
            cr.paint()
            return False
        if self.live:
            # Movable state: render the scene directly.
            if panel.view_mode == "satellite":
                self._draw_satellite(cr, w, h)
            else:
                self._draw_3d(cr, w, h)
            return False
        # Still state: paint the cached picture, rendering it
        # once if it is stale or the pane changed size.
        if self._still is None or self._still_dirty \
                or self._still.get_width() != w \
                or self._still.get_height() != h:
            self._render_still(w, h)
        cr.set_source_surface(self._still, 0, 0)
        cr.paint()
        return False


    def _selected_roads(self):
        """
        Live (cat, flat_idx, road_dict) for the main canvas
        selection. Empty when nothing is selected / no data.
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
        """World bbox (x0, z0, x1, z1) around the given roads."""
        xs, zs = [], []
        for _cat, _idx, road in roads:
            for px, pz in road.get("pts", []):
                xs.append(px)
                zs.append(pz)
        if not xs:
            return None
        return (min(xs), min(zs), max(xs), max(zs))

    def _patch_rect(self):
        """
        The world rect the 3D view renders: centred on the shared
        camera centre, spanning the main view's span clamped to
        [AREA_MIN_SPAN, AREA_MAX_SPAN] — current area only.

        1.9.11: while an eye focus stands (a click just selected
        a piece), the rect is the street-level square around the
        CLICKED point instead — the still shows the spot he
        picked, at the scale he picked it at.
        """
        if self._eye_focus is not None:
            fx, fz = self._eye_focus
            half = EYE_STILL_SPAN / 2
            return (fx - half, fz - half, fx + half, fz + half)
        canvas = self._canvas()
        if canvas is None:
            return (-100.0, -100.0, 100.0, 100.0)
        calloc = canvas.get_allocation()
        vp = canvas._camera.get_viewport(max(2, calloc.width),
                                         max(2, calloc.height))
        span = max(vp[2] - vp[0], vp[3] - vp[1])
        span = max(AREA_MIN_SPAN, min(AREA_MAX_SPAN, span))
        cx, cy = canvas.cam_x, canvas.cam_y
        return (cx - span / 2, cy - span / 2,
                cx + span / 2, cy + span / 2)

    def _patch_sampler(self, rect, nodes=17):
        """Cached heights grid over the patch rect."""
        key = (round(rect[0] / 50), round(rect[1] / 50),
               round(rect[2] / 50), round(rect[3] / 50), nodes)
        if self._grid is not None and self._grid[0] == key:
            return self._grid[1]
        sampler = heights_grid(self.app, rect[0], rect[1],
                               rect[2], rect[3], nodes)
        self._grid = (key, sampler)
        return sampler

    def _draw_3d(self, cr, w, h):
        """The software-3D area view (see the class docstring)."""
        app = self.app
        canvas = self._canvas()
        # Background: night-side dark like the old inspector.
        cr.set_source_rgb(0.05, 0.06, 0.09)
        cr.paint()
        if canvas is None or getattr(app, "game_model", None) is None:
            self._placeholder(cr, w, h,
                              "The 3D view shows your current area\n"
                              "once the map has loaded.")
            return
        rect = self._patch_rect()
        sampler = self._patch_sampler(rect)
        angle = self._view_angle()
        # The picture centres on the PATCH — the shared camera
        # normally, the clicked point while an eye focus stands
        # (1.9.11) — never on a road's head or foot.
        cx, cy = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
        cos_a, sin_a = math.cos(angle), math.sin(angle)

        def project(wx, wz, y=0.0):
            """World -> pane pixels through the shared heading
            (the suite isometric projection, rotated by the
            view angle = 35 degrees + the shared heading)."""
            px, py = iso_project(wx - cx, y, wz - cy, angle)
            return (w / 2 + px * zoom_fit[0],
                    h / 2 + py * zoom_fit[0] + 6)

        # Fit: project the four patch corners at zoom 1 and scale
        # so the whole patch fits the pane.
        corners = [(rect[0], rect[1]), (rect[2], rect[1]),
                   (rect[0], rect[3]), (rect[2], rect[3])]
        zoom_fit = [1.0]
        raw = []
        for (wx, wz) in corners:
            raw.append(iso_project(wx - cx, sampler.sample(wx, wz),
                                   wz - cy, angle))
        ext_x = max(p[0] for p in raw) - min(p[0] for p in raw)
        ext_y = max(p[1] for p in raw) - min(p[1] for p in raw)
        zoom_fit[0] = max(0.001, min(w / max(1.0, ext_x),
                                     h / max(1.0, ext_y)) * 0.97)
        zoom = zoom_fit[0]
        self._zoom_cached = zoom
        self._last_proj = project
        self._last_sampler = sampler
        self._last_patch = rect

        # --- Ground: the patch grid as shaded quads.
        heights = sampler.heights
        rows, cols = sampler.rows, sampler.cols
        step = sampler.step
        for j in range(rows - 1):
            for i in range(cols - 1):
                wx, wz = sampler.x0 + i * step, sampler.z0 + j * step
                quad = [(wx, wz), (wx + step, wz),
                        (wx + step, wz + step), (wx, wz + step)]
                hs = [sampler.sample(qx, qz) for (qx, qz) in quad]
                # Face normal from the first three corners, the
                # shading the original terrain patch used.
                (ax, ay, az), (bx, by, bz), (cx2, cy2, cz2) = (
                    (quad[0][0], hs[0], quad[0][1]),
                    (quad[1][0], hs[1], quad[1][1]),
                    (quad[2][0], hs[2], quad[2][1]))
                ux, uy, uz = bx - ax, by - ay, bz - az
                vx, vy, vz = cx2 - ax, cy2 - ay, cz2 - az
                nx = uy * vz - uz * vy
                ny = uz * vx - ux * vz
                nz = ux * vy - uy * vx
                nl = math.hypot(nx, ny, nz) or 1.0
                shade = _face_shade(nx / nl, ny / nl, nz / nl)
                r, g, b = _shade((0.32, 0.42, 0.22), shade)
                cr.set_source_rgb(r, g, b)
                for k, (qx, qz) in enumerate(quad):
                    sx, sy = project(qx, qz, hs[k])
                    cr.line_to(sx, sy) if k else cr.move_to(sx, sy)
                cr.close_path()
                cr.fill()

        # --- Buildings: boxes from the game's building data.
        self._draw_buildings_3d(cr, project, sampler, rect)

        # --- Roads in the patch (locals first, majors on top).
        roads = _roads_in_rect(app, rect)
        rank = {"local": 0, "minor_artery": 1, "major_artery": 2,
                "highway": 3, "interstate": 4}
        roads.sort(key=lambda t: rank.get(_norm_cat(t[0]), 0))
        widths = {"interstate": 7.0, "highway": 6.0,
                  "major_artery": 5.0, "minor_artery": 4.5,
                  "local": 3.0}
        cr.set_line_cap(cairo.LINE_CAP_ROUND)
        cr.set_line_join(cairo.LINE_JOIN_ROUND)
        for _cat, _i, road in roads:
            pts = road.get("pts") or []
            if len(pts) < 2:
                continue
            ys = road.get("ys")
            key = RoadElevStore.key_for(_cat, road.get("name"))
            off = self.panel.elev.get(key)
            ncat = _norm_cat(_cat)
            col = ROAD_COLORS.get(ncat, (0.5, 0.5, 0.5))
            cr.set_source_rgb(*col)
            cr.set_line_width(max(
                1.2, widths.get(ncat, 3.0) * zoom))
            step_n = max(1, (len(pts) - 1) // 80 + 1)
            idxs = list(range(0, len(pts), step_n))
            if idxs[-1] != len(pts) - 1:
                idxs.append(len(pts) - 1)
            for k, pi in enumerate(idxs):
                wx, wz = pts[pi]
                y = (ys[pi] if ys and pi < len(ys)
                     else sampler.sample(wx, wz)) + off + ROAD_LIFT
                sx, sy = project(wx, wz, y)
                cr.line_to(sx, sy) if k else cr.move_to(sx, sy)
            cr.stroke()

        # --- Overpasses + the truck-scale reference, as before.
        self._draw_overpasses_3d(cr, project, sampler, rect)
        self._draw_truck_scale(cr, project, sampler, rect)

        # --- The selected roads' full treatment + endpoints.
        selected = self._selected_roads()
        self._ep_screen = []
        for cat, idx, road in selected:
            self._draw_road_3d(cr, project, sampler, cat, idx, road)
        for cat, idx, road in selected:
            self._draw_endpoints(cr, project, sampler,
                                 (cat, idx), road)
        if selected:
            self._draw_snap_indicator(cr, project, sampler)
        self._hint(cr, w, h,
                   "Drag: move all views · Ctrl+drag: turn all "
                   "views · Wheel: zoom · Double-click a road end: "
                   "snap")

    def _draw_buildings_3d(self, cr, project, sampler, rect):
        """Game buildings as shaded boxes inside the patch."""
        store = self.panel.buildings
        zones = _zone_ids_for_rect(rect)
        if not zones:
            return
        items = store.query(zones, *rect)
        if not items:
            return
        # Depth is measured from the PATCH centre (the clicked
        # point while an eye focus stands — 1.9.11), matching
        # the projection the picture is drawn with.
        cx, cy = (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2
        # Nearest first is wrong for painters: draw far-to-near by
        # rotated depth (u + v in view space grows away from us).
        angle = self._view_angle()
        cos_a, sin_a = math.cos(angle), math.sin(angle)

        def depth(b):
            # In this projection screen-y grows with the rotated
            # z (rz); nearer = larger rz = drawn later.
            dx, dz = b[0] - cx, b[1] - cy
            return dx * sin_a + dz * cos_a
        items.sort(key=depth)
        if len(items) > 1500:
            items = items[:1500]
        for (bx, bz, bw, bd, bh, btype) in items:
            base = sampler.sample(bx, bz)
            hw, hd = bw / 2, bd / 2
            base_pts = [(bx - hw, bz - hd), (bx + hw, bz - hd),
                        (bx + hw, bz + hd), (bx - hw, bz + hd)]
            top = [project(px, pz, base + bh) for (px, pz) in base_pts]
            bot = [project(px, pz, base) for (px, pz) in base_pts]
            r, g, b = roof_color(btype)
            # Two visible side faces (the ones facing the viewer:
            # edges 1->2 and 2->3 in screen space read as the
            # front of the box in this projection).
            for (a, bb, shade) in ((1, 2, 0.72), (2, 3, 0.58)):
                cr.set_source_rgb(r * shade, g * shade, b * shade)
                cr.move_to(*top[a])
                cr.line_to(*top[bb])
                cr.line_to(*bot[bb])
                cr.line_to(*bot[a])
                cr.close_path()
                cr.fill()
            cr.set_source_rgb(r, g, b)
            for k, p in enumerate(top):
                cr.line_to(*p) if k else cr.move_to(*p)
            cr.close_path()
            cr.fill()

    def _draw_satellite(self, cr, w, h):
        """
        Joshua's satellite viewpoint: our own world from directly
        above, through the shared camera — height-tinted ground,
        asphalt roads at true width, building blocks in roof
        tones, the selected road in yellow.
        """
        app = self.app
        canvas = self._canvas()
        if canvas is None or getattr(app, "game_model", None) is None:
            cr.set_source_rgb(0.05, 0.06, 0.09)
            cr.paint()
            self._placeholder(cr, w, h,
                              "The satellite view shows your world\n"
                              "from above once the map has loaded.")
            return
        cam = canvas._camera
        if self._eye_focus is not None:
            # Selection still (1.9.11): the satellite picture,
            # too, frames the CLICKED point at street level —
            # through a private copy of the shared camera, so
            # the shared camera itself never moves.
            cam = copy.copy(cam)
            cam.cam_x, cam.cam_y = self._eye_focus
            cam.zoom = max(cam.min_zoom,
                           min(cam.max_zoom,
                               min(w, h) / EYE_STILL_SPAN))
        vp = cam.get_viewport(w, h)
        # Ground: a height grid over exactly this pane's viewport.
        key = (round(vp[0] / 50), round(vp[1] / 50),
               round(vp[2] / 50), round(vp[3] / 50))
        if self._sat_grid is None or self._sat_grid[0] != key:
            self._sat_grid = (key, heights_grid(app, *vp, nodes=25),
                              vp)
        _key, grid, grect = self._sat_grid
        heights = grid.heights
        rows, cols = grid.rows, grid.cols
        cell_x = (grect[2] - grect[0]) / (cols - 1)
        cell_z = (grect[3] - grect[1]) / (rows - 1)
        for j in range(rows - 1):
            for i in range(cols - 1):
                avg = (heights[j][i] + heights[j][i + 1]
                       + heights[j + 1][i] + heights[j + 1][i + 1]) / 4
                cr.set_source_rgb(*ground_tint(avg))
                wx, wz = grect[0] + i * cell_x, grect[1] + j * cell_z
                corners = [(wx, wz), (wx + cell_x, wz),
                           (wx + cell_x, wz + cell_z),
                           (wx, wz + cell_z)]
                for k, (qx, qz) in enumerate(corners):
                    sx, sy = cam.world_to_screen(qx, qz, w, h)
                    cr.line_to(sx, sy) if k else cr.move_to(sx, sy)
                cr.close_path()
                cr.fill()
        # Roads as asphalt ribbons at true-ish width.
        cr.set_line_cap(cairo.LINE_CAP_ROUND)
        cr.set_line_join(cairo.LINE_JOIN_ROUND)
        for _cat, _i, road in _roads_in_rect(app, vp):
            pts = road.get("pts") or []
            if len(pts) < 2:
                continue
            cr.set_source_rgb(0.16, 0.16, 0.17)
            cr.set_line_width(max(1.2, _sat_road_width(road) * cam.zoom))
            for k, (wx, wz) in enumerate(pts):
                sx, sy = cam.world_to_screen(wx, wz, w, h)
                cr.line_to(sx, sy) if k else cr.move_to(sx, sy)
            cr.stroke()
        # Building blocks on top of the ground, under nothing else.
        zones = _zone_ids_for_rect(vp)
        _draw_map_buildings(cr, app, self.panel.buildings, cam, w, h,
                            zones)
        # Selected road in yellow, topmost.
        sel_ids = {id(r) for _c, _i, r in self._selected_roads()}
        if sel_ids:
            _draw_map_roads(cr, app, cam, w, h,
                            selected_ids=sel_ids)
        _draw_north_arrow(cr, cam, w, h)
        self._hint(cr, w, h,
                   "Satellite: your world from above · Drag: move "
                   "all views · Ctrl+drag: turn · Wheel: zoom")

    def _placeholder(self, cr, w, h, text):
        cr.set_source_rgb(0.75, 0.78, 0.85)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_NORMAL)
        cr.set_font_size(12)
        lines = text.split("\n")
        y = h / 2 - (len(lines) - 1) * 8
        for line in lines:
            ext = cr.text_extents(line)
            cr.move_to(w / 2 - ext.width / 2, y)
            cr.show_text(line)
            y += 16

    def _hint(self, cr, w, h, text):
        cr.set_source_rgba(0, 0, 0, 0.45)
        cr.rectangle(0, h - 18, w, 18)
        cr.fill()
        cr.set_source_rgb(0.85, 0.88, 0.95)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_NORMAL)
        cr.set_font_size(10)
        cr.move_to(6, h - 5)
        cr.show_text(text)

    # -- selection / snap (the pane's original job, kept) --------










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
        cr.set_line_width(max(3.0, 5.0 * self._zoom_cached or 0.35))
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
            cr.set_line_width(max(2.0, 3.5 * self._zoom_cached or 0.35))
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
                cr.set_line_width(max(2.0, 3.0 * self._zoom_cached or 0.35))
                cr.move_to(*proj(center[0][2], center[0][3],
                                 center[0][1] + 6.0))
                for _, h, px, pz, _i in center[1:]:
                    cr.line_to(*proj(px, pz, h + 6.0))
                cr.stroke()
            else:
                # Divider: dark strip + thin vertical wall posts.
                cr.set_source_rgb(0.16, 0.16, 0.16)
                cr.set_line_width(max(1.5, 2.0 * self._zoom_cached or 0.35))
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
                cr.set_line_width(max(3.0, 6.0 * self._zoom_cached or 0.35))
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
        # Snapping an endpoint is a geometry edit (1.9.0 re-drape).
        ok = app.apply_road_modify(cat, road, geometry=True)
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
        # Target point through THIS frame's projection (the view
        # is centred on the shared camera, not the selection).
        tx, ty = proj(twx, twz, th)
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

    # -- input: wake, then shared-camera gestures -----------------

    def _on_press(self, _w, event):
        panel = self.panel
        # Delete comparison up: the pane holds its still. Presses
        # do nothing (the decision lives in the main view / the
        # batch panel) — Joshua's static-viewports rule.
        if panel.compare_active():
            return True
        # A press IN this pane ends the selection framing
        # (1.9.11): the pane goes back to following the shared
        # camera — his own touch outranks the last click's.
        if self._eye_focus is not None:
            self._eye_focus = None
            self.invalidate_still()
        if not self.awake:
            # The wake click: turn the pane on, fetch the area's
            # buildings, and SWALLOW the click — it must not move
            # the camera or pick anything.
            self.awake = True
            panel.request_area_data()
            self.queue_draw()
            return True
        if not self.live:
            # Still state: the pane is a picture. It does not
            # take gestures — pan/rotate from the other views, or
            # tap the state button to make this pane live.
            return True
        try:
            self.app.note_pane_touched("3d")
        except Exception:
            pass
        canvas = self._canvas()
        if canvas is None:
            return False
        alloc = self.get_allocation()
        # Endpoint picking first (3D mode only) — the pane's
        # original behaviour: click an endpoint to select it (a
        # snap candidate appears); double-click the selected
        # endpoint to snap it onto the candidate.
        if panel.view_mode == "3d" and event.button == 1:
            if event.type == Gdk.EventType._2BUTTON_PRESS:
                if self.sel_endpoint is not None and \
                        self.snap_candidate is not None:
                    for rk, ei, sx, sy in self._ep_screen:
                        if rk == self.sel_endpoint[0] and \
                                ei == self.sel_endpoint[1] and \
                                math.hypot(event.x - sx,
                                           event.y - sy) \
                                <= ENDPOINT_PICK_PX:
                            self.do_snap()
                            return True
                return True
            for rk, ei, sx, sy in self._ep_screen:
                if math.hypot(event.x - sx, event.y - sy) \
                        <= ENDPOINT_PICK_PX:
                    self.sel_endpoint = (rk, ei)
                    self._update_snap_candidate()
                    self.panel.update_snap_ui()
                    self.queue_draw()
                    return True
            if self.sel_endpoint is not None:
                self.sel_endpoint = None
                self.snap_candidate = None
                self.panel.update_snap_ui()
                self.queue_draw()
        # Universal controls (1.9.9, Joshua's ruling): plain
        # drag PANS, Control+drag ROTATES, the wheel zooms —
        # the same in every pane.
        ctrl = bool(event.state & Gdk.ModifierType.CONTROL_MASK)
        if ctrl:
            self._drag = ("rotate", event.x, canvas.rotation)
        else:
            self._drag = ("pan", event.x, event.y,
                          canvas.cam_x, canvas.cam_y)
        return True

    def _on_motion(self, _w, event):
        if self._drag is None or self.panel.compare_active():
            return False
        canvas = self._canvas()
        if canvas is None:
            return False
        alloc = self.get_allocation()
        w, h = max(2, alloc.width), max(2, alloc.height)
        if self._drag[0] == "rotate":
            _kind, x0, rot0 = self._drag
            canvas.rotation = rot0 + (event.x - x0) * 0.4
        else:
            _kind, x0, y0, cx0, cy0 = self._drag
            dx, dy = event.x - x0, event.y - y0
            if self.panel.view_mode == "satellite":
                # The satellite pane IS the shared camera: drag
                # the world under the pointer, exactly like the
                # main canvas pan.
                canvas._camera.pan_from(x0, y0, event.x, event.y,
                                         w, h)
                self._drag = ("pan", event.x, event.y,
                              canvas.cam_x, canvas.cam_y)
            else:
                # 3D: un-project the screen delta through the
                # isometric view and move the shared centre.
                zoom = self._last_zoom()
                if zoom:
                    a = self._view_angle()
                    rx = dx / zoom
                    rz = 2.0 * dy / zoom
                    cos_a, sin_a = math.cos(a), math.sin(a)
                    wx = rx * cos_a + rz * sin_a
                    wz = -rx * sin_a + rz * cos_a
                    canvas.cam_x = cx0 - wx
                    canvas.cam_y = cy0 - wz
        canvas.queue_draw()
        canvas._notify_camera_changed()
        self.queue_draw()
        return True

    def _last_zoom(self):
        """The draw zoom of the last 3D frame (for pan maths)."""
        return getattr(self, "_zoom_cached", None) or 0.0

    def _on_release(self, _w, _event):
        self._drag = None
        return True

    def _on_scroll(self, _w, event):
        if self.panel.compare_active() or not self.live:
            return True
        canvas = self._canvas()
        if canvas is None:
            return False
        alloc = self.get_allocation()
        w, h = max(2, alloc.width), max(2, alloc.height)
        factor = 1.15 if event.direction == Gdk.ScrollDirection.UP \
            else 1 / 1.15
        # Anchor at the pane centre: zooming a companion pane
        # zooms the shared camera around the shared centre, so
        # the centre cannot drift between views.
        canvas._camera.zoom_at(w / 2, h / 2, factor, w, h)
        canvas.queue_draw()
        canvas._notify_camera_changed()
        self.queue_draw()
        return True


def _sat_road_width(road):
    """True-ish asphalt width (world units) for the satellite view."""
    return {"interstate": 14.0, "highway": 11.0, "major": 9.0,
            "minor": 7.0, "local": 5.5}.get(road.get("category"), 5.5)


class ResourceMapViewer(Gtk.DrawingArea):
    """
    The bottom companion pane (the "Resource map" frame).
    1.9.12 — Joshua's design clarification: this pane is NOT a
    second view of our world. It shows the RESOURCE MAP — the
    reference roads the world was built from (the repo's
    map-data reference, read-only) — at the SAME location and
    zoom as the top viewer (see RoadInspectorPanel.
    resource_camera), so he can compare where streets currently
    are against where the reference says they should be. It
    draws no game data at all. (1.9.8–1.9.11 this pane drew the
    rebuilt game map; Joshua's clarification supersedes that.)
    The elevation readout line above the pane — the selected
    road's ground range + its elevation offset, with steppers —
    is unchanged; it was never the pane itself (see
    RoadInspectorPanel.update_elev_readout).

    Gestures mirror the main view: drag pans the shared camera,
    Ctrl+drag rotates it, the wheel zooms it around the pointer
    — the views stay linked both ways. During a delete/join/
    merge confirmation the pane holds the AFTER still instead
    (compare mode); in the delete preview a click there adds
    the clicked piece to the deletion (1.9.12) — see
    RoadInspectorPanel.compare_after_clicked.
    """

    def __init__(self, panel):
        super().__init__()
        self.panel = panel
        self.app = panel.app
        self._drag = None
        # One-live-pane rule: while the 3D viewport is the live
        # pane, this pane holds a still (rendered once, then only
        # blitted) — the same pattern as the main canvas.
        self.stilled = False
        self._still_surface = None
        self.render_count = 0   # scene renders (gate evidence)
        self.set_size_request(200, 140)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK
                        | Gdk.EventMask.BUTTON_RELEASE_MASK
                        | Gdk.EventMask.POINTER_MOTION_MASK
                        | Gdk.EventMask.SCROLL_MASK)
        self.connect("draw", self._on_draw)
        self.connect("button-press-event", self._on_press)
        self.connect("button-release-event", self._on_release)
        self.connect("motion-notify-event", self._on_motion)
        self.connect("scroll-event", self._on_scroll)

    def _canvas(self):
        return getattr(self.app, "canvas", None)

    def _on_draw(self, _widget, cr):
        alloc = self.get_allocation()
        w, h = max(2, alloc.width), max(2, alloc.height)
        panel = self.panel
        if panel.compare_active():
            panel.paint_compare_still(cr, "after", w, h)
            return False
        if self.stilled:
            if self._still_surface is None or \
                    self._still_surface.get_width() != w or \
                    self._still_surface.get_height() != h:
                surf = cairo.ImageSurface(cairo.FORMAT_ARGB32,
                                          w, h)
                self.render_count += 1
                self._draw_live(_widget, cairo.Context(surf))
                surf.flush()
                self._still_surface = surf
            cr.set_source_surface(self._still_surface, 0, 0)
            cr.paint()
            return False
        self.render_count += 1
        return self._draw_live(_widget, cr)

    def _draw_live(self, _widget, cr):
        alloc = self.get_allocation()
        w, h = max(2, alloc.width), max(2, alloc.height)
        panel = self.panel
        # Background: the editor's map paper tone.
        cr.set_source_rgb(0.09, 0.10, 0.12)
        cr.paint()
        # 1.9.12: the picture is the RESOURCE MAP (reference) —
        # the reference roads the world was built from, through
        # the pane's locked camera (same place + zoom as the top
        # viewer). NO game roads or buildings are drawn here any
        # more: comparing our world against the reference is the
        # pane's whole job, and mixing the two would hide exactly
        # the differences Joshua is looking for.
        store = panel.resources
        if store.state() != "ready":
            # The reference is still downloading (or failed):
            # say so plainly in the pane rather than showing a
            # misleadingly empty map.
            msg = ("Resource map unavailable — the reference "
                   "could not be downloaded."
                   if store.state() == "failed" else
                   "Resource map (reference) — loading…")
            cr.set_source_rgb(0.75, 0.78, 0.82)
            cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                                cairo.FONT_WEIGHT_NORMAL)
            cr.set_font_size(12)
            ext = cr.text_extents(msg)
            cr.move_to(max(4, (w - ext.width) / 2),
                       max(14, h / 2))
            cr.show_text(msg)
            return False
        cam = panel.resource_camera(w, h)
        if cam is None:
            return False
        from data import ROAD_STYLE
        vp = cam.get_viewport(w, h)
        cr.set_line_cap(cairo.LINE_CAP_ROUND)
        cr.set_line_join(cairo.LINE_JOIN_ROUND)
        for cat, _name, pts in store.query(*vp):
            style = ROAD_STYLE.get(cat, ROAD_STYLE["local"])
            cr.set_source_rgb(*style["color"])
            cr.set_line_width(max(0.8, style["width"] * cam.zoom))
            for j, (wx, wz) in enumerate(pts):
                sx, sy = cam.world_to_screen(wx, wz, w, h)
                cr.line_to(sx, sy) if j else cr.move_to(sx, sy)
            cr.stroke()
        _draw_north_arrow(cr, cam, w, h)
        # Caption chip, top-left: this picture is the REFERENCE,
        # never our world — labelled on the picture itself so a
        # screenshot can never confuse the two.
        cr.set_source_rgba(0, 0, 0, 0.55)
        cr.rectangle(6, 6, 178, 20)
        cr.fill()
        cr.set_source_rgb(0.92, 0.94, 0.97)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(11)
        cr.move_to(12, 20)
        cr.show_text("Resource map (reference)")
        return False

    def _on_press(self, _w, event):
        if self.panel.compare_active():
            # Holding a still: no gestures. 1.9.12 exception —
            # in the DELETE preview the After picture is
            # clickable: a left click adds the piece under it
            # to the deletion (panel.compare_after_clicked).
            if event.button == 1 \
                    and self.panel.compare_after_pickable():
                alloc = self.get_allocation()
                self.panel.compare_after_clicked(
                    event.x, event.y,
                    max(2, alloc.width), max(2, alloc.height))
            return True
        # 1.9.12: grabbing this pane re-locks it to the shared
        # camera — drop the top pane's selection eye-focus, so
        # this pane's picture (which prefers the eye focus while
        # one is set, exactly like the top pane's own still)
        # follows the shared centre again from this grab on.
        try:
            self.panel.clear_eye_focus()
        except Exception:
            pass
        try:
            self.app.note_pane_touched("map")
        except Exception:
            pass
        canvas = self._canvas()
        if canvas is None:
            return False
        # Universal controls (1.9.9): plain drag pans,
        # Control+drag rotates.
        if event.state & Gdk.ModifierType.CONTROL_MASK:
            self._drag = ("rotate", event.x, canvas.rotation)
        else:
            self._drag = ("pan", event.x, event.y)
        return True

    def _on_motion(self, _w, event):
        if self._drag is None or self.panel.compare_active():
            return False
        canvas = self._canvas()
        if canvas is None:
            return False
        alloc = self.get_allocation()
        w, h = max(2, alloc.width), max(2, alloc.height)
        if self._drag[0] == "rotate":
            _k, x0, rot0 = self._drag
            canvas.rotation = rot0 + (event.x - x0) * 0.4
        else:
            _k, x0, y0 = self._drag
            canvas._camera.pan_from(x0, y0, event.x, event.y, w, h)
            self._drag = ("pan", event.x, event.y)
        canvas.queue_draw()
        canvas._notify_camera_changed()
        self.queue_draw()
        return True

    def _on_release(self, _w, _event):
        self._drag = None
        return True

    def _on_scroll(self, _w, event):
        if self.panel.compare_active():
            return True
        try:
            self.app.note_pane_touched("map")
        except Exception:
            pass
        canvas = self._canvas()
        if canvas is None:
            return False
        alloc = self.get_allocation()
        w, h = max(2, alloc.width), max(2, alloc.height)
        factor = 1.15 if event.direction == Gdk.ScrollDirection.UP \
            else 1 / 1.15
        canvas._camera.zoom_at(event.x, event.y, factor, w, h)
        canvas.queue_draw()
        canvas._notify_camera_changed()
        self.queue_draw()
        return True


class RoadInspectorPanel(Gtk.VBox):
    """
    The right-hand dock: header (title + 3D/Satellite toggle +
    the viewport's Still/Live state button), the area viewpoint
    (ControlPointViewer), and the Resource map frame — the
    reference map (ResourceMapViewer, 1.9.12) under the selected
    road's elevation readout line with offset steppers. The
    readout is about the SELECTED ROAD's elevation; the pane
    under it is the resource/reference map — the labels say
    exactly that, separately, so the two are never confused.

    The panel also owns DELETE/JOIN/MERGE COMPARE MODE: while a
    confirmation is up, the two companion panes stop following
    the shared camera and hold two STILLS — Before (top pane:
    the area as it is, target pieces lit) and After (bottom
    pane: the same framing with the result applied — pieces
    omitted and/or the result piece drawn). The stills render
    exactly once when the comparison opens and exactly once per
    selection change; nothing else redraws them (Joshua's
    static-viewports rule). Leaving compare mode drops the
    stills and both panes simply show the current synced view
    again — nothing is queued or replayed.
    """

    def __init__(self, app):
        super().__init__(spacing=4)
        self.app = app
        self.elev = RoadElevStore()
        self.elev.load()
        # "3d" | "satellite" — which picture the area pane shows.
        self.view_mode = "3d"
        # Lazy per-zone buildings for the area viewpoints.
        self.buildings = BuildingsStore()
        # The resource map (reference roads) for the bottom
        # pane — one whole-world reference file, fetched once
        # in the background (1.9.12).
        self.resources = ResourceRoadsStore()
        # Compare mode state (see the class docstring).
        self._compare = None
        self._stills = {"before": None, "after": None}
        self.still_counts = {"before": 0, "after": 0}

        # --- Header: title + mode toggle.
        header = Gtk.HBox(spacing=4)
        title = Gtk.Label(label="Road Inspector")
        title.set_xalign(0)
        header.pack_start(title, True, True, 2)
        self._btn_3d = Gtk.ToggleButton(label="3D")
        self._btn_3d.set_active(True)
        self._btn_3d.set_tooltip_text(
            "3D view of the area around the main view")
        self._btn_sat = Gtk.ToggleButton(label="Satellite")
        self._btn_sat.set_tooltip_text(
            "Satellite view: your world from directly above")
        self._btn_3d.connect("toggled", self._on_mode_toggled, "3d")
        self._btn_sat.connect("toggled", self._on_mode_toggled,
                              "satellite")
        header.pack_start(self._btn_3d, False, False, 0)
        header.pack_start(self._btn_sat, False, False, 0)
        self.pack_start(header, False, False, 2)

        vpaned = Gtk.VPaned()
        # 1.9.14: a handle the app can reach — this split's size
        # is part of the remembered window layout (app.py's
        # layout persistence reads and restores it).
        self.split_paned = vpaned
        self.cp_viewer = ControlPointViewer(self)

        # The area pane sits in an overlay so its Still/Live state
        # button rides ON the viewport (Joshua's state icon).
        overlay = Gtk.Overlay()
        overlay.add(self.cp_viewer)
        self._btn_live = Gtk.Button(label="❚❚ Still")
        self._btn_live.set_tooltip_text(
            "The viewport is a still picture (saves memory). "
            "Tap to make it live and movable; tap again to go "
            "back to a still.")
        self._btn_live.set_halign(Gtk.Align.END)
        self._btn_live.set_valign(Gtk.Align.START)
        self._btn_live.set_margin_top(4)
        self._btn_live.set_margin_end(4)
        self._btn_live.connect("clicked", self._on_live_toggled)
        overlay.add_overlay(self._btn_live)
        overlay.show_all()
        frame = Gtk.Frame(label="Control Points — area view")
        frame.add(overlay)
        vpaned.pack1(frame, resize=True, shrink=True)

        # --- Resource map frame: the selected road's elevation
        # readout + steppers over the RESOURCE (reference) map.
        # The readout line is labelled "Road elevation" because
        # that is what IT is; the frame — the pane — is labelled
        # for the resource map it shows (1.9.12 label audit:
        # nothing around this pane calls the PANE "elevation"
        # any more).
        elev_box = Gtk.VBox(spacing=2)
        readout_row = Gtk.HBox(spacing=4)
        self._elev_label = Gtk.Label(
            label="Road elevation — select a road")
        self._elev_label.set_xalign(0)
        self._elev_label.set_ellipsize(Pango.EllipsizeMode.END)
        readout_row.pack_start(self._elev_label, True, True, 2)
        self._btn_elev_down = Gtk.Button(label="▼")
        self._btn_elev_down.set_tooltip_text(
            "Lower the selected road's elevation offset by 0.5")
        self._btn_elev_up = Gtk.Button(label="▲")
        self._btn_elev_up.set_tooltip_text(
            "Raise the selected road's elevation offset by 0.5")
        self._btn_elev_down.connect("clicked",
                                    lambda _b: self._nudge_elev(-0.5))
        self._btn_elev_up.connect("clicked",
                                  lambda _b: self._nudge_elev(0.5))
        readout_row.pack_start(self._btn_elev_down, False, False, 0)
        readout_row.pack_start(self._btn_elev_up, False, False, 0)
        elev_box.pack_start(readout_row, False, False, 0)
        # The attribute name stays `elev_viewer`: refresh() and
        # anything outside this module that redraws the pane
        # keeps working across the 1.9.8 change — and across
        # the 1.9.12 rename of the viewer class itself to
        # ResourceMapViewer (the pane's job changed; the
        # attribute is plumbing, not a label).
        self.elev_viewer = ResourceMapViewer(self)
        elev_box.pack_start(self.elev_viewer, True, True, 0)
        eframe = Gtk.Frame(label="Resource map — reference")
        # Kept as an attribute so the gates can read the pane's
        # title back and prove the label audit (1.9.12).
        self._resource_frame = eframe
        eframe.add(elev_box)
        vpaned.pack2(eframe, resize=True, shrink=True)
        vpaned.set_position(300)
        self.pack_start(vpaned, True, True, 0)

        # Snap row (the merge candidate), as before.
        snap_row = Gtk.HBox(spacing=4)
        self.snap_label = Gtk.Label(label="Snap: no candidate")
        self.snap_label.set_xalign(0)
        self.snap_label.set_ellipsize(Pango.EllipsizeMode.END)
        self.snap_btn = Gtk.Button(label="Snap")
        self.snap_btn.set_sensitive(False)
        self.snap_btn.connect("clicked", self._on_snap_clicked)
        snap_row.pack_start(self.snap_label, True, True, 2)
        snap_row.pack_start(self.snap_btn, False, False, 0)
        self.pack_start(snap_row, False, False, 0)
        self.show_all()

    # -- mode + still/live state -----------------------------------

    def _on_mode_toggled(self, btn, mode):
        if not btn.get_active():
            return
        other = self._btn_sat if mode == "3d" else self._btn_3d
        other.set_active(False)
        self.view_mode = mode
        # The new picture is a fresh still until rendered.
        self.cp_viewer.invalidate_still()
        self.cp_viewer.queue_draw()

    def _on_live_toggled(self, _btn):
        """The viewport's state icon: Still <-> Live (Movable).
        Delegates to the app's one-live-pane coordinator: making
        this pane live stills the map side; going back to a still
        makes the map live again."""
        try:
            self.app.set_live_pane(
                "map" if self.cp_viewer.live else "3d")
            return
        except Exception:
            pass
        viewer = self.cp_viewer
        viewer.live = not viewer.live
        self._sync_live_button()
        if viewer.live:
            viewer.queue_draw()
        else:
            viewer.invalidate_still()
            viewer.queue_draw()

    def _sync_live_button(self):
        if self.cp_viewer.live:
            self._btn_live.set_label("▶ Live")
            self._btn_live.set_tooltip_text(
                "The viewport is live and movable. Tap to go "
                "back to a still picture (saves memory).")
        else:
            self._btn_live.set_label("❚❚ Still")
            self._btn_live.set_tooltip_text(
                "The viewport is a still picture (saves memory). "
                "Tap to make it live and movable; tap again to "
                "go back to a still.")

    # -- area data (buildings) --------------------------------------

    def _fetch_buildings_bytes(self, path):
        """
        Worker-side fetch of one zone's buildings.json through
        the suite plumbing (shared cache first, GitHub on a miss).
        Runs ON a BuildingsStore worker thread — never the UI.
        """
        try:
            import github_sync
            import gamedata
            data, _err = github_sync.fetch_file(gamedata.GAME_REPO,
                                                path)
            return data
        except Exception:
            return None

    def _on_buildings_ready(self, zid, ok):
        try:
            self.app.progress_finish(f"buildings-{zid}")
        except Exception:
            pass
        self.cp_viewer.invalidate_still()
        self.cp_viewer.queue_draw()
        self.elev_viewer.queue_draw()
        # 1.9.13: the main canvas draws buildings too (and clicks
        # them) — a zone landing must repaint it. While the map is
        # the stilled pane this is a no-op picture-wise (its still
        # re-renders when it next goes live), exactly like the
        # panes' own stills.
        canvas = getattr(self.app, "canvas", None)
        if canvas is not None:
            canvas.queue_draw()

    def request_area_data(self):
        """
        Make sure the buildings for the zones in the current view
        are on their way (background download + corner progress
        bar). Called when the area pane wakes, when the camera
        settles somewhere new, and on refresh. No-op while a
        comparison is up (static rule: no side activity) or while
        the pane is still asleep.
        """
        if self._compare is not None or not self.cp_viewer.awake:
            return
        self._ensure_buildings_for_view()

    def ensure_buildings_for_main_view(self):
        """
        The MAIN map's own buildings fetch (1.9.13): since this
        build the main canvas DRAWS buildings and a click on one
        offers the jump to the Building Editor — so the zones on
        screen need their buildings even while the 3D pane (whose
        waking gates request_area_data) is asleep. Same compare
        guard as request_area_data (a comparison's stills are
        never disturbed), same store, same progress bar.
        """
        if self._compare is not None:
            return
        self._ensure_buildings_for_view()

    def _ensure_buildings_for_view(self):
        """Start background fetches for the zones the shared
        camera currently shows (plus a margin), if not held.
        Shared by request_area_data and the main view's fetch."""
        canvas = getattr(self.app, "canvas", None)
        if canvas is None:
            return
        alloc = canvas.get_allocation()
        vp = canvas._camera.get_viewport(max(2, alloc.width),
                                         max(2, alloc.height))
        pad_x = (vp[2] - vp[0]) * 0.25
        pad_z = (vp[3] - vp[1]) * 0.25
        rect = (vp[0] - pad_x, vp[1] - pad_z,
                vp[2] + pad_x, vp[3] + pad_z)
        for zid in _zone_ids_for_rect(rect):
            started = self.buildings.ensure_zone(
                zid, self._fetch_buildings_bytes,
                self._on_buildings_ready)
            if started:
                try:
                    self.app.progress_start(
                        f"buildings-{zid}",
                        f"Downloading {zid} buildings…")
                except Exception:
                    pass

    # -- resource map (reference) data — 1.9.12 --------------------

    def _fetch_resource_bytes(self, path):
        """
        Worker-side fetch of the resource-map reference file
        through the suite plumbing (shared cache first, GitHub
        on a miss) — the same door the buildings fetch uses.
        Runs ON the ResourceRoadsStore worker thread.
        """
        try:
            import github_sync
            import gamedata
            data, _err = github_sync.fetch_file(gamedata.GAME_REPO,
                                                path)
            return data
        except Exception:
            return None

    def _on_resource_ready(self, ok):
        try:
            self.app.progress_finish("resource-roads")
        except Exception:
            pass
        # The bottom pane may be holding its "loading…" caption;
        # one redraw swaps in the reference (or the failure note).
        self.elev_viewer.queue_draw()

    def request_resource_data(self):
        """
        Make sure the resource-map reference is on its way
        (background download + corner progress bar). The store
        fetches once per run; later calls are no-ops. Called by
        the app when data loads (open + Check for Updates).
        """
        started = self.resources.ensure(self._fetch_resource_bytes,
                                        self._on_resource_ready)
        if started:
            try:
                self.app.progress_start(
                    "resource-roads",
                    "Downloading the resource map (reference)…")
            except Exception:
                pass

    def resource_camera(self, w, h):
        """
        The camera the bottom (resource map) pane draws through:
        the SAME place and zoom as the top viewer. While the top
        pane holds a selection still (its eye focus — the point
        a click selected), the bottom pane frames THAT point at
        the same street-level zoom, through a private copy of
        the shared camera (the shared camera itself never
        moves) — the construction the top pane's own satellite
        still uses. Otherwise the shared camera itself. None
        before the canvas exists.
        """
        canvas = getattr(self.app, "canvas", None)
        if canvas is None:
            return None
        cam = canvas._camera
        focus = self.cp_viewer._eye_focus
        if focus is not None:
            cam = copy.copy(cam)
            cam.cam_x, cam.cam_y = focus
            cam.zoom = max(cam.min_zoom,
                           min(cam.max_zoom,
                               min(w, h) / EYE_STILL_SPAN))
        return cam

    def clear_eye_focus(self):
        """
        Drop the top pane's selection eye-focus (the bottom
        pane calls this when Joshua grabs it): both panes then
        follow the shared camera's centre again. The top pane's
        still re-renders once for its new framing.
        """
        if self.cp_viewer._eye_focus is not None:
            self.cp_viewer._eye_focus = None
            self.cp_viewer.invalidate_still()
            self.cp_viewer.queue_draw()

    # -- elevation readout + steppers -------------------------------

    def _first_selected_road(self):
        """(category, road) of the first selected piece, or None."""
        canvas = getattr(self.app, "canvas", None)
        if canvas is None:
            return None
        sel = getattr(canvas, "selected_roads", []) or []
        if not sel:
            return None
        cat, idx = sel[0]
        road = canvas._get_road_dict(cat, idx)
        return (cat, road) if road is not None else None

    def update_elev_readout(self):
        """
        The elevation READOUT's information (the line above the
        resource map pane), kept from the old profile pane in
        words: which road, its ground height range (from its
        converter-draped ys) and its elevation offset (the value
        the steppers change).
        """
        got = self._first_selected_road()
        if got is None:
            self._elev_label.set_text(
                "Road elevation — select a road")
            self._btn_elev_down.set_sensitive(False)
            self._btn_elev_up.set_sensitive(False)
            return
        cat, road = got
        name = road.get("name") or "Unnamed road"
        off = self.elev.get(RoadElevStore.key_for(cat, road.get("name")))
        ys = road.get("ys") or []
        if ys:
            ground = f"ground {min(ys) - 0.01:.1f}–{max(ys) - 0.01:.1f} u"
        else:
            ground = "ground —"
        self._elev_label.set_text(
            f"Road elevation — {name}: offset {off:+.1f} u · "
            f"{ground}")
        self._btn_elev_down.set_sensitive(True)
        self._btn_elev_up.set_sensitive(True)

    def _nudge_elev(self, delta):
        got = self._first_selected_road()
        if got is None:
            return
        cat, road = got
        key = RoadElevStore.key_for(cat, road.get("name"))
        self.elev.set(key, self.elev.get(key) + delta)
        try:
            self.app._mark_unpublished()
        except Exception:
            pass
        self.update_elev_readout()
        self.cp_viewer.invalidate_still()
        self.cp_viewer.queue_draw()

    # -- compare mode (Before / After stills) ------------------------

    def compare_active(self):
        return self._compare is not None

    def compare_camera(self):
        """The shared framing camera of the current comparison."""
        return None if self._compare is None else self._compare["cam"]

    def compare_omit_ids(self):
        if self._compare is None:
            return frozenset()
        return frozenset(self._compare["omit"])

    def set_compare(self, cam, target_roads, omit_ids,
                    extra_roads=(), before_text="Before — as it is now",
                    after_text="After — with the change applied",
                    on_after_pick=None):
        """
        Open the Before/After comparison. `cam` is the framing
        camera BOTH panes share (identical centre/zoom/heading);
        target_roads are lit in Before; omit_ids (id() set) vanish
        in After; extra_roads (road dicts not in the model, e.g.
        a joined result) appear only in After. Both stills render
        once, here.

        on_after_pick (1.9.12) — the owner's click-to-add handler
        for the After picture, called (cat, idx, road) when a
        click in the After still lands on a road still drawn
        there. Only the delete preview registers one; every other
        comparison keeps its stills inert.
        """
        self._compare = {
            "cam": cam,
            "targets": list(target_roads),
            "omit": set(omit_ids),
            "extra": list(extra_roads),
            "before_text": before_text,
            "after_text": after_text,
            "on_after_pick": on_after_pick,
        }
        self._stills = {"before": None, "after": None}
        self.render_compare_still("before")
        self.render_compare_still("after")
        self.cp_viewer.queue_draw()
        self.elev_viewer.queue_draw()

    def update_compare(self, omit_ids=None, extra_roads=None,
                       target_roads=None):
        """
        A selection change mid-comparison: refresh each still
        EXACTLY once (Joshua's rule), then still again.

        target_roads (1.9.12) replaces the Before targets when
        given — the delete preview passes its GROWN set after a
        piece is added through the After picture, so the new
        piece lights up in Before exactly like the originals.
        The on_after_pick handler is preserved across updates.
        """
        if self._compare is None:
            return
        if omit_ids is not None:
            self._compare["omit"] = set(omit_ids)
        if extra_roads is not None:
            self._compare["extra"] = list(extra_roads)
        if target_roads is not None:
            self._compare["targets"] = list(target_roads)
        self.render_compare_still("before")
        self.render_compare_still("after")
        self.cp_viewer.queue_draw()
        self.elev_viewer.queue_draw()

    # -- After-picture picking (1.9.12) ---------------------------

    def compare_after_pickable(self):
        """True while a comparison with an After-picture
        click-to-add handler is up (the delete preview)."""
        cmp = self._compare
        return cmp is not None \
            and cmp.get("on_after_pick") is not None

    def pick_compare_after(self, sx, sy, w, h):
        """
        The road record nearest a click in the After still, as
        (cat, flat_idx, road) or None. The click is resolved in
        the comparison camera's own framing (the stills' pinned
        camera), candidates come from the spatial index over a
        small world box around the point, roads already omitted
        from the After picture are NOT pickable (they are not
        drawn there), and the nearest record wins. Distances use
        the main canvas's own point-to-road measure, so the
        After picture picks exactly like the map does.
        """
        cmp = self._compare
        if cmp is None:
            return None
        app = self.app
        canvas = getattr(app, "canvas", None)
        if canvas is None \
                or getattr(app, "spatial_index", None) is None:
            return None
        cam = cmp["cam"]
        wx, wz = cam.screen_to_world(sx, sy, w, h)
        tol = 10.0 / max(cam.zoom, 1e-6)
        best = None
        best_d = None
        for cat, fi, road in _roads_in_rect(
                app, (wx - tol, wz - tol, wx + tol, wz + tol)):
            if id(road) in cmp["omit"]:
                continue
            pts = road.get("pts") or []
            if len(pts) < 2:
                continue
            d = canvas._point_to_road_dist(wx, wz, pts)
            if d is None or d > tol:
                continue
            if best is None or d < best_d:
                best = (cat, fi, road)
                best_d = d
        return best

    def compare_after_clicked(self, sx, sy, w, h):
        """
        A click landed in the After still. When the comparison
        registered a click-to-add handler (the delete preview),
        resolve the piece under the click and hand it to the
        handler; a click that lands on empty ground says so in
        the status instead of silently doing nothing. Returns
        True when the click was consumed by the After picture.
        """
        cmp = self._compare
        if cmp is None or cmp.get("on_after_pick") is None:
            return False
        hit = self.pick_compare_after(sx, sy, w, h)
        if hit is None:
            try:
                self.app.set_status(
                    "After picture: that click missed every "
                    "road — nothing was added.")
            except Exception:
                pass
            return True
        cat, idx, road = hit
        cmp["on_after_pick"](cat, idx, road)
        return True

    def clear_compare(self):
        """Close the comparison; both panes show the live synced
        view again — nothing queued, nothing replayed."""
        if self._compare is None:
            return
        self._compare = None
        self._stills = {"before": None, "after": None}
        self.cp_viewer.invalidate_still()
        self.cp_viewer.queue_draw()
        self.elev_viewer.queue_draw()

    def render_compare_still(self, which):
        """
        Render ONE comparison still ("before" | "after") into its
        cached surface. This is the only place comparison pixels
        are produced; still_counts proves the discipline to the
        gates (one render on open, one per selection change).
        """
        if self._compare is None:
            return
        viewer = self.cp_viewer if which == "before" \
            else self.elev_viewer
        alloc = viewer.get_allocation()
        w, h = alloc.width, alloc.height
        if w < 8 or h < 8:
            return  # pane not laid out yet; paint retries later
        surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, h)
        cr = cairo.Context(surf)
        self._draw_compare_scene(cr, w, h, after=(which == "after"))
        surf.flush()
        self._stills[which] = surf
        self.still_counts[which] += 1

    def paint_compare_still(self, cr, which, w, h):
        """Blit the cached still (rendering it first if the pane
        was not laid out when the comparison opened)."""
        surf = self._stills.get(which)
        if surf is None or surf.get_width() != w \
                or surf.get_height() != h:
            self.render_compare_still(which)
            surf = self._stills.get(which)
        if surf is not None:
            cr.set_source_surface(surf, 0, 0)
            cr.paint()
        else:
            cr.set_source_rgb(0, 0, 0)
            cr.paint()

    def _draw_compare_scene(self, cr, w, h, after):
        """
        One comparison picture: the framed area through the
        compare camera. Before = everything as it stands, target
        pieces lit magenta on top. After = the same picture with
        the omitted pieces gone and any result pieces drawn in.
        """
        from mapcanvas import DELETE_HIGHLIGHT_RGB
        cmp_ = self._compare
        cam = cmp_["cam"]
        cr.set_source_rgb(0.09, 0.10, 0.12)
        cr.paint()
        vp = cam.get_viewport(w, h)
        zones = _zone_ids_for_rect(vp)
        _draw_map_buildings(cr, self.app, self.buildings, cam,
                            w, h, zones)
        target_ids = {id(r) for r in cmp_["targets"]}
        # Before: the targets leave the normal pass — they are
        # drawn lit on top instead. After: ONLY the omit set
        # leaves; spared targets (an unchecked batch piece, the
        # merge's target road) draw normally — unchecking a piece
        # must put it back into the After picture.
        omit = cmp_["omit"] if after else target_ids
        _draw_map_roads(cr, self.app, cam, w, h, omit_ids=omit)
        if after:
            # Result pieces (join/merge) in their own colours.
            from data import ROAD_STYLE, normalize_category
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.set_line_join(cairo.LINE_JOIN_ROUND)
            for road in cmp_["extra"]:
                pts = road.get("pts") or []
                if len(pts) < 2:
                    continue
                style = ROAD_STYLE.get(
                    normalize_category(road.get("category")),
                    ROAD_STYLE["local"])
                cr.set_source_rgb(*style["color"])
                cr.set_line_width(max(1.6, style["width"] * cam.zoom))
                for k, (wx, wz) in enumerate(pts):
                    sx, sy = cam.world_to_screen(wx, wz, w, h)
                    cr.line_to(sx, sy) if k else cr.move_to(sx, sy)
                cr.stroke()
        else:
            # The pieces under decision, lit like the main view's
            # delete framing lights them.
            cr.set_source_rgb(*DELETE_HIGHLIGHT_RGB)
            cr.set_line_cap(cairo.LINE_CAP_ROUND)
            cr.set_line_join(cairo.LINE_JOIN_ROUND)
            for road in cmp_["targets"]:
                pts = road.get("pts") or []
                if len(pts) < 2:
                    continue
                cr.set_line_width(max(2.0, 12.0 * cam.zoom))
                for k, (wx, wz) in enumerate(pts):
                    sx, sy = cam.world_to_screen(wx, wz, w, h)
                    cr.line_to(sx, sy) if k else cr.move_to(sx, sy)
                cr.stroke()
                for (wx, wz) in (pts[0], pts[-1]):
                    sx, sy = cam.world_to_screen(wx, wz, w, h)
                    cr.arc(sx, sy, 3.5, 0, 2 * math.pi)
                    cr.fill()
        _draw_north_arrow(cr, cam, w, h)
        # The caption chip: BEFORE / AFTER, top-left.
        text = cmp_["after_text"] if after else cmp_["before_text"]
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(11)
        ext = cr.text_extents(text)
        cr.set_source_rgba(0, 0, 0, 0.62)
        cr.rectangle(6, 6, ext.width + 14, 20)
        cr.fill()
        cr.set_source_rgb(1, 1, 1)
        cr.move_to(13, 20)
        cr.show_text(text)

    # -- the selection still (1.9.11) --------------------------------

    def show_selection_still(self, wx, wz):
        """
        A map click just selected a piece at world point
        (wx, wz): wake the area pane and frame its still on
        THAT point at street level (the viewer's wake_at).
        This is the activation path whose absence left the pane
        black after selecting in 1.9.9. During a comparison the
        stills belong to the decision — the click's picture
        waits (compare mode is untouched).
        """
        if self.compare_active():
            return
        self.cp_viewer.wake_at(wx, wz)

    # -- refresh (selection / data changed) ---------------------------

    def refresh(self):
        """
        Selection changed: drop a stale endpoint selection, update
        the snap UI + the elevation readout, redraw both viewers
        (the area pane's still simply goes stale — one coalesced
        re-render, per the stills rule).
        """
        canvas = getattr(self.app, "canvas", None)
        valid_keys = set()
        if canvas is not None:
            valid_keys = set(getattr(canvas, "selected_roads", []))
        v = self.cp_viewer
        if v.sel_endpoint is not None and \
                v.sel_endpoint[0] not in valid_keys:
            v.sel_endpoint = None
            v.snap_candidate = None
        self.update_snap_ui()
        self.update_elev_readout()
        v.invalidate_still()
        v.queue_draw()
        self.elev_viewer.queue_draw()

    def update_snap_ui(self):
        """Snap button + label from the viewer's endpoint state."""
        v = self.cp_viewer
        if v.snap_candidate is not None:
            _wx, _wz, tname = v.snap_candidate
            self.snap_label.set_text(
                "Near '%s' — snap available" % tname)
            self.snap_btn.set_sensitive(True)
        elif v.sel_endpoint is not None:
            self.snap_label.set_text(
                "Endpoint selected — no nearby road (visual only)")
            self.snap_btn.set_sensitive(False)
        else:
            self.snap_label.set_text("No endpoint selected")
            self.snap_btn.set_sensitive(False)

    def _on_snap_clicked(self, _btn):
        """Snap button: commit the candidate (the pane's original
        behaviour — the endpoint moves onto the other road)."""
        self.cp_viewer.do_snap()
