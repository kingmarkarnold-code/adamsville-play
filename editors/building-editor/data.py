#!/usr/bin/env python3
"""
Adamsville Asset Editor (Native) — Data management module.

Handles building asset data: downloading buildings.json from GitHub,
local caching, version checking, and persistence of Joshua's edits.

Joshua's rule: all code commented.
"""

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

# Shared suite module (Joshua 2026-10-11): common utilities (GitHub push,
# token storage, shared file cache) live in one place so all suite apps
# use the same code. Falls back to local implementations if not present.
# Shared suite module locations: system-wide (installed by .deb) first,
# then per-user (for development/testing). Falls back to None if neither
# exists, in which case the app uses its local implementations.
for _suite_path in ("/usr/share/adamsville-suite",
                    str(Path.home() / ".local" / "share" / "adamsville-suite")):
    if _suite_path not in sys.path:
        sys.path.insert(0, _suite_path)
try:
    import adamsville_suite as suite
except ImportError:
    suite = None  # fall back to local implementations


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# GitHub repo containing the building asset data
REPO = "kingmarkarnold-code/adamsville-map-editor"
# Raw URL for buildings.json — the single data file the app downloads
BUILDINGS_URL = f"https://raw.githubusercontent.com/{REPO}/main/buildings.json"
# GitHub API URL for version checking (returns blob SHA)
API_URL = f"https://api.github.com/repos/{REPO}/contents/buildings.json"

# Local data directory (XDG-compliant)
DATA_DIR = Path.home() / ".local" / "share" / "adamsville-asset-editor-native"
BUILDINGS_FILE = DATA_DIR / "buildings.json"
VERSION_FILE = DATA_DIR / "version.json"
WINDOW_FILE = DATA_DIR / "window.json"
# Joshua's building edits are saved here so they survive restarts.
# Maps building name -> full building dict (overrides shipped defaults).
EDITS_FILE = DATA_DIR / "building_edits.json"

# Building types for the v1 dropdown
BUILDING_TYPES = ["House", "Commercial", "Apartment", "Church",
                  "School", "Restaurant", "Store", "Warehouse"]

# Wall material labels for v1 (real textures come in a later version)
WALL_MATERIALS = ["Brick", "Wood Siding", "Vinyl Siding", "Planks",
                  "Concrete", "Stucco"]

# Roof texture labels for v1 (real textures come in a later version)
ROOF_TEXTURES = ["Shingle", "Metal", "Tile", "Flat", "Thatch"]

# Stock window types for v1 (placeholder labels)
WINDOW_TYPES = ["Standard", "Large", "Bay Window", "Sliding"]

# Stock door types for v1 (placeholder labels)
DOOR_TYPES = ["Wood Door", "Glass Door", "Double Door", "Garage Door"]

# Floor plan templates for walkable buildings (placeholder labels for v1)
FLOOR_PLAN_TEMPLATES = ["Small House", "Large House", "Store",
                        "Restaurant", "Apartment", "Office", "Custom"]

# House style templates for subdivisions (Joshua 2026-10-11): 20 base
# house styles. Subdivisions reference one; the game spawns houses of
# that style inside the subdivision polygon. Placeholder names for v1 —
# Joshua designs the actual 20 styles later.
HOUSE_STYLES = ["Style %d" % i for i in range(1, 21)]

# --- Exterior feature options (Joshua 2026-10-11, building editor v1.1.0) ---

# Driveway surface materials (labels for v1; real textures come later)
DRIVEWAY_MATERIALS = ["Concrete", "Paved"]

# Which side of the building a garage attaches to
GARAGE_SIDES = ["Left", "Right", "Back"]

# Fence styles (labels for v1; real textures come later)
FENCE_STYLES = ["Wood", "Metal", "Chain Link", "Brick"]

# Interior floor types, one per floor for walkable buildings
# (labels for v1; real textures come later)
FLOOR_TYPES = ["Hardwood", "Tile", "Carpet", "Concrete", "Laminate"]

# Decorative asset types Joshua can place in/around walkable buildings.
# Wall types go on wall faces (like windows); floor types go on the
# ground. These are markers/labels for v1 — the game swaps in real
# 3D models later.
DECORATION_TYPES = ["Picture Frame", "Plant", "Lamp", "Rug", "Curtains"]
# Which decoration types mount on walls vs sit on the ground
DECORATION_WALL_TYPES = {"Picture Frame", "Curtains"}
DECORATION_FLOOR_TYPES = {"Plant", "Lamp", "Rug"}

# --- Parking (Joshua 2026-10-11, building editor v1.5.0) ---

# Parking element types. A building's "parking" list holds dicts like:
# {"type": "lot", "rows": 4, "spaces_per_row": 10, "rotation": 0.0,
#  "gx": 0.0, "gz": 0.0}
# {"type": "space", "orientation": "Perpendicular", "rotation": 0.0,
#  "gx": 0.0, "gz": 0.0}
# {"type": "garage", "levels": 3, "spaces_per_level": 20,
#  "gx": 0.0, "gz": 0.0}
# (gx, gz) are center-relative ground-plane preview units, same
# convention as floor decorations and fence points.
PARKING_TYPES = ["lot", "space", "garage"]
PARKING_TYPE_LABELS = {"lot": "Parking Lot",
                       "space": "Single Space",
                       "garage": "Parking Garage"}
# Orientation choices for a single parking space
PARKING_SPACE_ORIENTATIONS = ["Parallel", "Perpendicular", "Angled"]
# Building types treated as residential. Parking garages are
# commercial-only (Joshua 2026-10-11): the "Add Parking Garage"
# button is disabled for these types.
RESIDENTIAL_TYPES = {"House"}
# A house counts as "expanded" when its footprint (width x depth, in
# world units) exceeds this. Expanded houses may add an attached
# garage; small houses need clear adjacent space instead.
EXPANDED_HOUSE_SQ_UNITS = 1800.0
# Clear square area (world units) needed next to a small house to fit
# an attached garage.
GARAGE_CLEAR_SIZE = 20.0


def ensure_building_defaults(building):
    """
    Fill in missing v1.1.0 exterior/interior keys on a building dict so
    older saved buildings (and the shipped samples) don't break when
    the editor accesses the new properties. Mutates and returns it.
    """
    # Sidewalk: flat border around the building base
    building.setdefault("sidewalk",
                        {"enabled": False, "width": 4.0, "curved": False})
    # Driveway: flat rectangle from the front face toward the street
    building.setdefault("driveway",
                        {"enabled": False, "material": "Concrete"})
    # Garage: smaller box attached to one side
    building.setdefault("garage",
                        {"enabled": False, "side": "Right",
                         "width": 20.0, "door_type": "Garage Door"})
    # Sallyport: covered drive-through entrance at the front
    building.setdefault("sallyport", {"enabled": False})
    # Fence: polygon of ground points (building-relative preview units;
    # see fence_points_to_world). Drawn by clicking around the building.
    building.setdefault("fence",
                        {"enabled": False, "style": "Wood", "points": []})
    # Floor types: one entry per floor for walkable buildings
    if "floor_types" not in building:
        building["floor_types"] = []
    # Decorations: [{"type", "face", "x", "y"}] for wall types,
    # [{"type", "gx", "gz"}] for floor types (ground plane, preview units)
    building.setdefault("decorations", [])
    # Parking (v1.5.0, Joshua): list of parking element dicts, each
    # with "type" ("lot"/"space"/"garage") plus type-specific fields.
    # See PARKING_TYPE_LABELS above for the schema.
    building.setdefault("parking", [])
    return building


def fence_points_to_world(building):
    """
    Convert a building's fence polygon from building-relative preview
    units to game world coordinates.

    Preview units: the building footprint is 10x10 units centered at
    (0, 0) in the preview. World transform: scale by (width/10,
    depth/10), rotate by the building rotation, translate to the
    building position.

    Returns a list of [wx, wz] world points (empty if no fence).
    """
    import math
    fence = building.get("fence", {})
    pts = fence.get("points") or []
    if not pts:
        return []
    pos = building.get("position", [0, 0])
    cx = float(pos[0]) if len(pos) > 0 else 0.0
    cz = float(pos[1]) if len(pos) > 1 else 0.0
    sx = float(building.get("width", 40.0)) / 10.0
    sz = float(building.get("depth", 40.0)) / 10.0
    theta = math.radians(float(building.get("rotation", 0.0) or 0.0))
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    world = []
    for px, pz in pts:
        lx, lz = float(px) * sx, float(pz) * sz
        wx = cx + lx * cos_t - lz * sin_t
        wz = cz + lx * sin_t + lz * cos_t
        world.append([wx, wz])
    return world


def garage_space_ok(building):
    """
    Check whether a residential building may add an attached garage.

    Joshua's rule (v1.5.0): houses do NOT get garages by default. A
    garage is allowed when EITHER:
      1. the house is "expanded" — footprint (width x depth, world
         units) exceeds EXPANDED_HOUSE_SQ_UNITS, OR
      2. there is enough clear space — a GARAGE_CLEAR_SIZE square
         adjacent to the building that doesn't overlap any road.

    Returns (ok: bool, reason: str). reason is "expanded",
    "clear space", or "no clear space". Commercial buildings don't
    use this check (their garages are always allowed).
    """
    import math
    width = float(building.get("width", 40.0) or 40.0)
    depth = float(building.get("depth", 40.0) or 40.0)
    # Rule 1: expanded house
    if width * depth > EXPANDED_HOUSE_SQ_UNITS:
        return True, "expanded"
    # Rule 2: look for a clear square next to each face. Test the
    # four face midpoints, pushed out by half the clear size plus
    # half the building dimension, rotated by the building rotation
    # (same local->world convention as fence_points_to_world).
    pos = building.get("position", [0, 0])
    cx = float(pos[0]) if len(pos) > 0 else 0.0
    cz = float(pos[1]) if len(pos) > 1 else 0.0
    theta = math.radians(float(building.get("rotation", 0.0) or 0.0))
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    half = GARAGE_CLEAR_SIZE / 2.0
    for lx, lz in ((width / 2.0 + half, 0.0),
                   (-(width / 2.0 + half), 0.0),
                   (0.0, depth / 2.0 + half),
                   (0.0, -(depth / 2.0 + half))):
        px = cx + lx * cos_t - lz * sin_t
        pz = cz + lx * sin_t + lz * cos_t
        # margin=0: test just the clear square itself
        hits = check_building_footprint(px, pz, GARAGE_CLEAR_SIZE,
                                        GARAGE_CLEAR_SIZE, 0.0,
                                        margin=0.0)
        if not hits:
            return True, "clear space"
    return False, "no clear space"

# Subdivision data: areas of the map where houses of one style spawn.
# Raw URL for subdivisions.json in the map editor repo.
SUBDIVISIONS_URL = f"https://raw.githubusercontent.com/{REPO}/main/subdivisions.json"
SUB_API_URL = f"https://api.github.com/repos/{REPO}/contents/subdivisions.json"
# Local cache + version tracking for subdivisions
SUBDIVISIONS_FILE = DATA_DIR / "subdivisions.json"
SUB_VERSION_FILE = DATA_DIR / "subdivisions_version.json"

# Zone reference data (drawn on the subdivision map as a guide).
# Raw URL for zones.json in the map editor repo.
ZONES_URL = f"https://raw.githubusercontent.com/{REPO}/main/zones.json"
ZONES_API_URL = f"https://api.github.com/repos/{REPO}/contents/zones.json"
ZONES_FILE = DATA_DIR / "zones.json"

# Road data for the nearby-roads context + collision checks.
ROADS_API_URL = f"https://api.github.com/repos/{REPO}/contents/roads.json"


# ---------------------------------------------------------------------------
# Shared suite cache (v1.2.0, Joshua)
# ---------------------------------------------------------------------------
# Every suite app (map, terrain, UI, building, vehicle, character
# editors) downloads GitHub resources. To avoid re-downloading the same
# files in each app, they share this directory. Pattern for future apps:
#   1. Check the shared cache first (get_shared_file).
#   2. If present and fresh (SHA matches GitHub), use it - no download.
#   3. If missing or stale, download once and save_shared_file() so the
#      next app finds it. Also mirror to the app's own folder for
#      backward compatibility.
# Shared files: roads.json, zones.json, buildings.json,
# subdivisions.json - anything multiple apps need.
SHARED_DIR = Path.home() / ".local" / "share" / "adamsville-suite"


def get_shared_file(filename):
    """Return path to shared cached file, or None if not present."""
    p = SHARED_DIR / filename
    return p if p.exists() else None


def save_shared_file(filename, data_bytes):
    """Save bytes to the shared cache (creates the dir if needed)."""
    SHARED_DIR.mkdir(parents=True, exist_ok=True)
    (SHARED_DIR / filename).write_bytes(data_bytes)


def _shared_sha_path(filename):
    """Sidecar file holding the GitHub blob SHA for a shared file."""
    return SHARED_DIR / (filename + ".sha")


def _github_blob_sha(api_url, user_agent, timeout=10):
    """
    Fetch the current blob SHA for a repo file via the GitHub API.
    Returns None if offline or on error.
    """
    try:
        req = urllib.request.Request(
            api_url,
            headers={"User-Agent": user_agent,
                     "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode()).get("sha")
    except Exception:
        return None


def _shared_is_fresh(filename, api_url, user_agent):
    """
    True if the shared copy's SHA matches GitHub (or we can't check).
    Offline (API unreachable) counts as fresh - use what we have.
    """
    sha_path = _shared_sha_path(filename)
    if not sha_path.exists():
        return False  # no SHA recorded -> treat as stale
    try:
        local_sha = sha_path.read_text().strip()
    except Exception:
        return False
    remote_sha = _github_blob_sha(api_url, user_agent)
    if remote_sha is None:
        return True  # offline - trust the cache
    return remote_sha == local_sha


def fetch_resource(filename, url, api_url, mirror_path, user_agent,
                   timeout=30):
    """
    Shared-cache-first fetch of a GitHub resource. Returns bytes/None.
    1. Shared hit + fresh -> copy to mirror_path, return bytes.
    2. Else download -> save to shared cache (+ .sha) and mirror_path.
    3. On download failure -> mirror copy, else stale shared copy.
    """
    sp = get_shared_file(filename)
    if sp is not None and _shared_is_fresh(filename, api_url,
                                           user_agent):
        data = sp.read_bytes()
        if mirror_path is not None:
            try:
                mirror_path.parent.mkdir(parents=True, exist_ok=True)
                mirror_path.write_bytes(data)
            except Exception:
                pass
        return data
    # Download (shared miss or stale)
    try:
        req = urllib.request.Request(url,
                                     headers={"User-Agent": user_agent})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
    except Exception as e:
        print(f"Download failed for {filename}: {e}")
        data = None
    if data is not None:
        save_shared_file(filename, data)
        sha = _github_blob_sha(api_url, user_agent)
        if sha:
            try:
                _shared_sha_path(filename).write_text(sha)
            except Exception:
                pass
        if mirror_path is not None:
            try:
                mirror_path.parent.mkdir(parents=True, exist_ok=True)
                mirror_path.write_bytes(data)
            except Exception:
                pass
        return data
    # Failure fallbacks: app mirror, then stale shared copy
    if mirror_path is not None and mirror_path.exists():
        return mirror_path.read_bytes()
    if sp is not None:
        return sp.read_bytes()
    return None

# Game world extent in world units (matches the map editor)
WORLD_X0, WORLD_Z0 = -200.0, -200.0
WORLD_X1, WORLD_Z1 = 8200.0, 12200.0

# ---------------------------------------------------------------------------
# Road data (for collision checks + preview context)
# ---------------------------------------------------------------------------
# Roads come from the map editor repo's roads.json:
# {"highway": [{"name", "pts": [[x,z],...]}], "arterial": [...], "local": [...]}
ROADS_URL = f"https://raw.githubusercontent.com/{REPO}/main/roads.json"
ROADS_FILE = DATA_DIR / "roads.json"
# Road ribbon widths in world units (same as the map editor)
ROAD_WIDTHS = {"highway": 24.0, "arterial": 16.0, "local": 10.0}
# Preview colors (same as the map editor)
ROAD_COLORS = {"highway": (1.0, 0.27, 0.27),
               "arterial": (1.0, 0.67, 0.0),
               "local": (0.53, 0.53, 0.53)}

# Cached road index: list of dicts
# {"category", "name", "pts", "bbox": (x0, z0, x1, z1)}
_road_index = None


def load_roads():
    """
    Load roads via the shared suite cache (v1.2.0): if another suite
    app already downloaded roads.json, no download happens at all.
    Returns the raw dict {"highway": [...], "arterial": [...],
    "local": [...]}, or empty categories on failure.
    """
    raw = {"highway": [], "arterial": [], "local": []}
    data_bytes = fetch_resource(
        "roads.json", ROADS_URL, ROADS_API_URL, ROADS_FILE,
        "adamsville-asset-editor-native", timeout=60)
    if data_bytes is None:
        return raw
    try:
        data = json.loads(data_bytes.decode())
        for cat in raw:
            if isinstance(data.get(cat), list):
                raw[cat] = data[cat]
    except Exception as e:
        print(f"Roads load failed: {e}")
    return raw


def get_road_index():
    """
    Return the cached road index (builds it on first call).
    Each entry: {"category", "name", "pts", "bbox"}.
    """
    global _road_index
    if _road_index is not None:
        return _road_index
    _road_index = []
    raw = load_roads()
    for cat, roads in raw.items():
        for r in roads:
            pts = r.get("pts") or []
            if len(pts) < 2:
                continue
            xs = [p[0] for p in pts]
            zs = [p[1] for p in pts]
            _road_index.append({
                "category": cat,
                "name": r.get("name", "unnamed road"),
                "pts": pts,
                "bbox": (min(xs), min(zs), max(xs), max(zs)),
            })
    print(f"Road index: {len(_road_index)} roads")
    return _road_index


# ---------------------------------------------------------------------------
# Collision math (Joshua 2026-10-11)
# ---------------------------------------------------------------------------

def _point_in_rotated_rect(px, pz, cx, cz, hw, hd, cos_t, sin_t):
    """
    Test if world point (px, pz) is inside the rectangle centered at
    (cx, cz) with half-width hw, half-depth hd, rotated by angle whose
    cosine/sine are cos_t/sin_t.
    """
    dx, dz = px - cx, pz - cz
    lx = dx * cos_t + dz * sin_t
    lz = -dx * sin_t + dz * cos_t
    return abs(lx) <= hw and abs(lz) <= hd


def _segments_intersect(ax, ay, bx, by, cx, cy, dx, dy):
    """Standard 2D segment-segment intersection test."""
    def _cross(o, p, q):
        return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    d1 = _cross((cx, cy), (dx, dy), (ax, ay))
    d2 = _cross((cx, cy), (dx, dy), (bx, by))
    d3 = _cross((ax, ay), (bx, by), (cx, cy))
    d4 = _cross((ax, ay), (bx, by), (dx, dy))
    return ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0))


def _rect_corners(cx, cz, hw, hd, cos_t, sin_t):
    """Four corners of the rotated rect (world coords)."""
    corners = []
    for sx, sz in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        lx, lz = sx * hw, sz * hd
        # Rotate by +angle (inverse of the test's -angle)
        wx = cx + lx * cos_t - lz * sin_t
        wz = cz + lx * sin_t + lz * cos_t
        corners.append((wx, wz))
    return corners


def check_building_footprint(cx, cz, width, depth, rotation_deg,
                             margin=10.0):
    """
    Check if a building footprint overlaps any road.

    cx, cz: building center in world coords.
    width, depth: footprint size in world units.
    rotation_deg: building rotation in degrees.
    margin: extra clearance in world units beyond the road half-width.

    Returns a list of (road_name, category) for overlapping roads.
    A road overlaps if its centerline comes within
    (road_width/2 + margin) of the footprint rect.
    """
    import math
    theta = math.radians(rotation_deg or 0.0)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    hw, hd = width / 2.0, depth / 2.0
    hits = []
    for road in get_road_index():
        rw = ROAD_WIDTHS.get(road["category"], 10.0)
        expand = rw / 2.0 + margin
        ehW, ehD = hw + expand, hd + expand
        # Quick bbox reject: world-axis bbox of the rotated rect.
        # A rotated rect's extent is |hw*cos|+|hd*sin| etc.
        ac, as_ = abs(cos_t), abs(sin_t)
        rx = ehW * ac + ehD * as_
        rz = ehW * as_ + ehD * ac
        x0, z0, x1, z1 = road["bbox"]
        if x1 < cx - rx or x0 > cx + rx or z1 < cz - rz or z0 > cz + rz:
            continue
        # Rect corners for edge-intersection tests
        corners = _rect_corners(cx, cz, ehW, ehD, cos_t, sin_t)
        edges = [(corners[i], corners[(i + 1) % 4]) for i in range(4)]
        pts = road["pts"]
        hit = False
        # Any road point inside the expanded rect?
        for px, pz in pts:
            if _point_in_rotated_rect(px, pz, cx, cz,
                                      ehW, ehD, cos_t, sin_t):
                hit = True
                break
        # Any segment crossing a rect edge?
        if not hit:
            for i in range(len(pts) - 1):
                ax, az = pts[i]
                bx, bz = pts[i + 1]
                for (ex0, ez0), (ex1, ez1) in edges:
                    if _segments_intersect(ax, az, bx, bz,
                                           ex0, ez0, ex1, ez1):
                        hit = True
                        break
                if hit:
                    break
        if hit:
            hits.append((road["name"], road["category"]))
    return hits


def count_roads_in_polygon(polygon):
    """
    Count how many roads cross (or touch) a world-coord polygon.
    Used to warn Joshua when a subdivision area has roads running
    through it. polygon: list of [x, z].
    """
    if not polygon or len(polygon) < 3:
        return 0
    # Polygon bbox for quick rejection
    xs = [p[0] for p in polygon]
    zs = [p[1] for p in polygon]
    px0, pz0, px1, pz1 = min(xs), min(zs), max(xs), max(zs)

    def _in_poly(px, pz):
        inside = False
        n = len(polygon)
        for i in range(n):
            x1, y1 = polygon[i]
            x2, y2 = polygon[(i + 1) % n]
            if ((y1 > pz) != (y2 > pz)):
                xi = (x2 - x1) * (pz - y1) / (y2 - y1 + 1e-9) + x1
                if px < xi:
                    inside = not inside
        return inside

    count = 0
    for road in get_road_index():
        x0, z0, x1, z1 = road["bbox"]
        if x1 < px0 or x0 > px1 or z1 < pz0 or z0 > pz1:
            continue  # bbox doesn't touch the polygon bbox
        pts = road["pts"]
        hit = False
        for px, pz in pts:
            if _in_poly(px, pz):
                hit = True
                break
        if not hit:
            n = len(polygon)
            for i in range(len(pts) - 1):
                ax, az = pts[i]
                bx, bz = pts[i + 1]
                for j in range(n):
                    cx, cz = polygon[j]
                    dx, dz = polygon[(j + 1) % n]
                    if _segments_intersect(ax, az, bx, bz,
                                           cx, cz, dx, dz):
                        hit = True
                        break
                if hit:
                    break
        if hit:
            count += 1
    return count


# ---------------------------------------------------------------------------
# Default sample buildings (used if GitHub download fails and no cache)
# ---------------------------------------------------------------------------

def _default_buildings():
    """
    Return a small list of sample buildings used as a fallback when
    no local cache exists and the GitHub download fails.
    """
    return [
        {
            "name": "Suburban House",
            "type": "House",
            "wall_material": "Vinyl Siding",
            "wall_color": "#d4c5a0",
            "roof_color": "#5a3a2a",
            "roof_texture": "Shingle",
            "floors": 1,
            "walkable": False,
            "floor_plan": "",
            "position": [3000, 2000],
            "rotation": 0.0,
            "front_face": "front",
            "width": 40.0,
            "depth": 40.0,
            "windows": [
                {"face": "front", "x": 0.25, "y": 0.55, "w": 0.15,
                 "h": 0.25, "type": "Standard"},
                {"face": "front", "x": 0.60, "y": 0.55, "w": 0.15,
                 "h": 0.25, "type": "Standard"},
            ],
            "doors": [
                {"face": "front", "x": 0.45, "y": 0.0, "type": "Wood Door"},
            ],
        },
        {
            "name": "Downtown Store",
            "type": "Store",
            "wall_material": "Brick",
            "wall_color": "#a0522d",
            "roof_color": "#3a3a3a",
            "roof_texture": "Flat",
            "floors": 2,
            "walkable": True,
            "floor_plan": "Store",
            "position": [6000, 1500],
            "rotation": 0.0,
            "front_face": "front",
            "width": 40.0,
            "depth": 40.0,
            "windows": [
                {"face": "front", "x": 0.15, "y": 0.50, "w": 0.25,
                 "h": 0.35, "type": "Large"},
                {"face": "front", "x": 0.60, "y": 0.50, "w": 0.25,
                 "h": 0.35, "type": "Large"},
            ],
            "doors": [
                {"face": "front", "x": 0.45, "y": 0.0, "type": "Glass Door"},
            ],
        },
        {
            "name": "Corner Restaurant",
            "type": "Restaurant",
            "wall_material": "Stucco",
            "wall_color": "#e8dcc0",
            "roof_color": "#7a2a1a",
            "roof_texture": "Tile",
            "floors": 1,
            "walkable": True,
            "floor_plan": "Restaurant",
            "position": [6500, 2500],
            "rotation": 90.0,
            "front_face": "front",
            "width": 40.0,
            "depth": 40.0,
            "windows": [
                {"face": "front", "x": 0.20, "y": 0.55, "w": 0.20,
                 "h": 0.30, "type": "Bay Window"},
            ],
            "doors": [
                {"face": "front", "x": 0.55, "y": 0.0, "type": "Double Door"},
            ],
        },
        {
            "name": "Ranch House",
            "type": "House",
            "wall_material": "Wood Siding",
            "wall_color": "#8b7355",
            "roof_color": "#4a4a4a",
            "roof_texture": "Shingle",
            "floors": 1,
            "walkable": False,
            "floor_plan": "",
            "position": [2500, 3000],
            "rotation": 180.0,
            "front_face": "front",
            "width": 40.0,
            "depth": 40.0,
            "windows": [
                {"face": "front", "x": 0.30, "y": 0.55, "w": 0.15,
                 "h": 0.25, "type": "Standard"},
            ],
            "doors": [
                {"face": "front", "x": 0.50, "y": 0.0, "type": "Wood Door"},
            ],
        },
    ]


# ---------------------------------------------------------------------------
# Data directory setup
# ---------------------------------------------------------------------------

def ensure_data_dir():
    """Create the local data directory if it doesn't exist."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# GitHub download and version checking
# ---------------------------------------------------------------------------

def get_remote_sha():
    """
    Get the current blob SHA of buildings.json on GitHub.
    Returns None if offline or on error (non-blocking by design).
    """
    try:
        req = urllib.request.Request(
            API_URL,
            headers={"User-Agent": "adamsville-asset-editor-native",
                     "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return data.get("sha")
    except Exception:
        # Offline or API error — not fatal, caller handles None
        return None


def get_local_sha():
    """Read the saved SHA of the locally cached buildings.json."""
    try:
        with open(VERSION_FILE) as f:
            return json.load(f).get("sha")
    except Exception:
        return None


def save_local_sha(sha):
    """Save the SHA after a successful download."""
    ensure_data_dir()
    with open(VERSION_FILE, "w") as f:
        json.dump({"sha": sha, "source": "github"}, f)


def needs_download():
    """
    Check if we need to download buildings.json.
    Returns (needed: bool, reason: str).
    """
    if not BUILDINGS_FILE.exists():
        return True, "Building data not found locally. Download from GitHub?"
    local_sha = get_local_sha()
    if not local_sha:
        return True, "Local version unknown. Re-download from GitHub?"
    remote_sha = get_remote_sha()
    if remote_sha is None:
        # Offline — use what we have
        return False, "Offline — using local copy."
    if remote_sha != local_sha:
        return True, "A newer version is available on GitHub. Download?"
    return False, "Local copy is up to date."


def download_buildings(progress_callback=None):
    """
    Download buildings.json from GitHub to local cache.
    progress_callback(downloaded_bytes, total_bytes) — called during download.
    Returns True on success, False on failure.
    Uses atomic write (temp file → rename) to avoid partial files.
    """
    ensure_data_dir()
    try:
        req = urllib.request.Request(
            BUILDINGS_URL,
            headers={"User-Agent": "adamsville-asset-editor-native"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            chunks = []
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                downloaded += len(chunk)
                if progress_callback:
                    progress_callback(downloaded, total)

        # Atomic write: temp file then rename
        tmp_path = BUILDINGS_FILE.with_suffix(".tmp")
        with open(tmp_path, "wb") as f:
            for chunk in chunks:
                f.write(chunk)
        tmp_path.rename(BUILDINGS_FILE)

        # Save the new SHA
        remote_sha = get_remote_sha()
        if remote_sha:
            save_local_sha(remote_sha)

        # Share with the other suite apps (v1.2.0)
        try:
            save_shared_file("buildings.json",
                             BUILDINGS_FILE.read_bytes())
            if remote_sha:
                _shared_sha_path("buildings.json").write_text(
                    remote_sha)
        except Exception as e:
            print(f"Shared cache save failed: {e}")

        return True
    except Exception as e:
        print(f"Download failed: {e}")
        return False


def load_buildings():
    """
    Load buildings from local cache, applying Joshua's saved edits on top.
    Returns a list of building dicts.
    Falls back to built-in defaults if no cache exists.
    """
    # v1.2.0: seed the app cache from the shared suite cache if
    # another app already downloaded buildings.json.
    if not BUILDINGS_FILE.exists():
        sp = get_shared_file("buildings.json")
        if sp is not None:
            try:
                ensure_data_dir()
                BUILDINGS_FILE.write_bytes(sp.read_bytes())
            except Exception:
                pass
    if BUILDINGS_FILE.exists():
        try:
            with open(BUILDINGS_FILE) as f:
                buildings = json.load(f)
        except Exception:
            buildings = _default_buildings()
    else:
        buildings = _default_buildings()

    # Apply Joshua's saved edits (name -> full building dict override)
    edits = load_edits()
    if edits:
        by_name = {b["name"]: b for b in buildings}
        for name, edited in edits.items():
            by_name[name] = edited
        buildings = list(by_name.values())

    # Fill in v1.1.0 exterior/interior defaults so older data keeps working
    for b in buildings:
        ensure_building_defaults(b)

    return buildings


# ---------------------------------------------------------------------------
# Edit persistence
# ---------------------------------------------------------------------------

def load_edits():
    """
    Load Joshua's saved building edits.
    Returns dict: building name -> full building dict.
    """
    try:
        if EDITS_FILE.exists():
            with open(EDITS_FILE) as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def save_building_edit(building):
    """
    Persist one building's full state as an edit override.
    building: complete building dict (must have "name").
    """
    ensure_data_dir()
    try:
        edits = load_edits()
    except Exception:
        edits = {}
    edits[building["name"]] = building
    with open(EDITS_FILE, "w") as f:
        json.dump(edits, f, indent=2)


def delete_building_edit(name):
    """Remove a saved edit override for one building."""
    edits = load_edits()
    if name in edits:
        del edits[name]
        ensure_data_dir()
        with open(EDITS_FILE, "w") as f:
            json.dump(edits, f, indent=2)


# ---------------------------------------------------------------------------
# Subdivision persistence (Joshua 2026-10-11)
# ---------------------------------------------------------------------------
# A subdivision: {"name": str, "polygon": [[x, z], ...],
#                 "style": "Style N"}. The polygon is in game world coords.
# The game spawns houses of that style inside the polygon; the editor
# only defines the areas and their styles.

def load_subdivisions():
    """
    Load Joshua's subdivisions from the local JSON file.
    Returns a list of subdivision dicts (empty list if none saved).
    """
    try:
        if SUBDIVISIONS_FILE.exists():
            with open(SUBDIVISIONS_FILE) as f:
                subs = json.load(f)
                if isinstance(subs, list):
                    return subs
    except Exception:
        pass
    return []


def save_subdivisions(subdivisions):
    """
    Persist the full subdivision list to the local JSON file.
    subdivisions: list of {"name", "polygon", "style"} dicts.
    """
    ensure_data_dir()
    with open(SUBDIVISIONS_FILE, "w") as f:
        json.dump(subdivisions, f, indent=2)


def download_subdivisions():
    """
    Download subdivisions.json from GitHub to the local cache.
    Returns True on success, False on failure (non-fatal: the local
    file may simply not exist yet on first run).
    Uses atomic write (temp file -> rename) to avoid partial files.
    """
    ensure_data_dir()
    try:
        req = urllib.request.Request(
            SUBDIVISIONS_URL,
            headers={"User-Agent": "adamsville-asset-editor-native"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read()
        tmp_path = SUBDIVISIONS_FILE.with_suffix(".tmp")
        with open(tmp_path, "wb") as f:
            f.write(content)
        tmp_path.rename(SUBDIVISIONS_FILE)
        # Share with the other suite apps (v1.2.0)
        try:
            save_shared_file("subdivisions.json", content)
            sha = _github_blob_sha(
                SUB_API_URL, "adamsville-asset-editor-native")
            if sha:
                _shared_sha_path("subdivisions.json").write_text(sha)
        except Exception as e:
            print(f"Shared cache save failed: {e}")
        return True
    except Exception as e:
        print(f"Subdivisions download failed: {e}")
        return False


def maybe_download_subdivisions():
    """
    Fetch subdivisions.json from GitHub if we have no local copy.
    v1.2.0: the shared suite cache counts as a local copy.
    Called once at startup; silent on failure.
    """
    if SUBDIVISIONS_FILE.exists():
        return
    sp = get_shared_file("subdivisions.json")
    if sp is not None:
        try:
            ensure_data_dir()
            SUBDIVISIONS_FILE.write_bytes(sp.read_bytes())
            return
        except Exception:
            pass
    download_subdivisions()


# ---------------------------------------------------------------------------
# Zone reference data (drawn on the subdivision map as a guide)
# ---------------------------------------------------------------------------

def _extract_zones(raw):
    """
    Accept a bare zone list OR {"zones": [...]} (the actual GitHub
    format). v1.2.0 FIX (Joshua: subdivision map showed nothing):
    the old code required a bare list, so the real zones.json
    (a dict) was rejected and the map drew no zones.
    """
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        z = raw.get("zones")
        if isinstance(z, list):
            return z
    return []


def load_zones():
    """
    Load zone polygons for the subdivision map background.
    v1.2.0: uses the shared suite cache first, and accepts both the
    bare-list and {"zones": [...]} formats.
    Zones are {"name": str, "points": [[x, z], ...], ...}.
    """
    data_bytes = fetch_resource(
        "zones.json", ZONES_URL, ZONES_API_URL, ZONES_FILE,
        "adamsville-asset-editor-native", timeout=30)
    if data_bytes is None:
        return []
    try:
        return _extract_zones(json.loads(data_bytes.decode()))
    except Exception as e:
        print(f"Zones parse failed: {e}")
        return []


# ---------------------------------------------------------------------------
# Export for Push to GitHub (copy/download JSON protocol)
# ---------------------------------------------------------------------------

def export_payload():
    """
    Build the export payload for the Push to GitHub dialog.
    Returns a dict with all buildings (including edits) and all
    subdivisions, ready for JSON.
    """
    return {
        "buildings": load_buildings(),
        "subdivisions": load_subdivisions(),
        "exported_by": "Joshua Arnold",
    }


# ---------------------------------------------------------------------------
# Window state persistence
# ---------------------------------------------------------------------------

def save_window_state(x, y, width, height, maximized):
    """Save window geometry for restore on next launch."""
    ensure_data_dir()
    with open(WINDOW_FILE, "w") as f:
        json.dump({"x": x, "y": y, "width": width,
                   "height": height, "maximized": maximized}, f)


def load_window_state():
    """Load saved window geometry. Returns None if not saved."""
    try:
        with open(WINDOW_FILE) as f:
            return json.load(f)
    except Exception:
        return None
