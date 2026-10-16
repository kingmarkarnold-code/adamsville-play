#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) — Data management module.

Handles downloading road data from GitHub, local caching, version checking,
and spatial indexing for fast viewport culling.

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

# GitHub repo containing the map data
REPO = "kingmarkarnold-code/adamsville-map-editor"
# Raw URL for roads.json — the single data file the app downloads
ROADS_URL = f"https://raw.githubusercontent.com/{REPO}/main/roads.json"
# GitHub API URL for version checking (returns blob SHA)
API_URL = f"https://api.github.com/repos/{REPO}/contents/roads.json"

# Local data directory (XDG-compliant)
DATA_DIR = Path.home() / ".local" / "share" / "adamsville-map-editor-native"
ROADS_FILE = DATA_DIR / "roads.json"
VERSION_FILE = DATA_DIR / "version.json"
WINDOW_FILE = DATA_DIR / "window.json"
# Joshua's zone boundary edits (dragged/added pins) are saved here so they
# survive restarts. Maps zone name -> {"points": [[x, z], ...]}
ZONE_EDITS_FILE = DATA_DIR / "zone_edits.json"
# Joshua's road edits (joins, merges, extends, deletes) are saved here.
# Format: {"base_sha": "<sha of roads.json these apply to>",
#          "replaced": {category: [full road list for that category]}}
# Full-category replacement is simple and robust: on load, the saved
# categories overwrite the downloaded ones (only if base_sha matches,
# so a fresh download doesn't get stale edits applied).
ROAD_EDITS_FILE = DATA_DIR / "road_edits.json"

# The 7 predefined game zones (same as web editor).
# Zones are arbitrary polygons: "points" is a list of [x, z] vertices
# in winding order (the polygon auto-closes back to the first point).
# Colors are RGB 0-1.
ZONES = [
    {"name": "Mableton",
     "points": [[-200, -200], [2147, -200], [2147, 4218], [-200, 4218]],
     "color": (0.29, 0.56, 0.85)},
    {"name": "Adamsville",
     "points": [[2147, -200], [5398, -200], [5398, 4218], [2147, 4218]],
     "color": (0.49, 0.83, 0.13)},
    {"name": "Downtown",
     "points": [[5398, -200], [8200, -200], [8200, 2202], [5398, 2202]],
     "color": (0.96, 0.65, 0.14)},
    {"name": "East Atlanta",
     "points": [[5398, 2202], [8200, 2202], [8200, 4218], [5398, 4218]],
     "color": (0.74, 0.06, 0.88)},
    {"name": "Union City",
     "points": [[-200, 4218], [2147, 4218], [2147, 12200], [-200, 12200]],
     "color": (0.31, 0.89, 0.76)},
    {"name": "South Fulton",
     "points": [[2147, 4218], [5398, 4218], [5398, 12200], [2147, 12200]],
     "color": (0.72, 0.91, 0.53)},
    {"name": "Riverdale",
     "points": [[5398, 4218], [8200, 4218], [8200, 12200], [5398, 12200]],
     "color": (1.0, 0.42, 0.42)},
]


def rect_to_points(x0, x1, z0, z1):
    """
    Convert an old rectangle-style zone (x0/x1/z0/z1) into a 4-point
    polygon. Used for backward compatibility with zone_edits.json files
    saved before zones became arbitrary polygons.
    Winding: top-left → top-right → bottom-right → bottom-left.
    """
    return [[float(x0), float(z0)], [float(x1), float(z0)],
            [float(x1), float(z1)], [float(x0), float(z1)]]


def zone_bbox(zone):
    """
    Bounding box of a polygon zone: (x0, z0, x1, z1).
    Used for viewport culling and zoom-to-zone.
    """
    pts = zone["points"]
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    return min(xs), min(zs), max(xs), max(zs)


def _normalize_zone(zone):
    """
    Ensure a zone dict has polygon-style "points".
    Auto-converts the old rectangle format (x0/x1/z0/z1) if found,
    so older code or data keeps working without manual migration.
    """
    if "points" not in zone and "x0" in zone:
        zone["points"] = rect_to_points(
            zone["x0"], zone["x1"], zone["z0"], zone["z1"])


# Normalize the shipped defaults (no-op for the polygon definitions above,
# but keeps this robust if the format ever regresses).
for _z in ZONES:
    _normalize_zone(_z)
del _z

# Road rendering properties by category
# width: world units for the road ribbon; color: RGB 0-1
# (Joshua 2026-10-11: "arterial" split into minor/major artery;
# "interstate" added above highway.)
ROAD_STYLE = {
    "interstate":   {"width": 28, "color": (0.72, 0.12, 0.12)},  # dark red
    "highway":      {"width": 24, "color": (1.0, 0.27, 0.27)},   # red
    "major_artery": {"width": 20, "color": (1.0, 0.45, 0.10)},   # orange-red
    "minor_artery": {"width": 16, "color": (1.0, 0.67, 0.0)},     # orange
    "local":        {"width": 10, "color": (0.53, 0.53, 0.53)},   # gray
}

# Category hierarchy, widest/highest-priority first. Used for draw
# order (wider roads on top) and pick preference (wider roads win ties).
CATEGORY_ORDER = ("interstate", "highway", "major_artery",
                  "minor_artery", "local")

# Human-readable labels for the category radio buttons.
CATEGORY_LABELS = {
    "interstate": "Interstate",
    "highway": "Highway",
    "major_artery": "Major Artery",
    "minor_artery": "Minor Artery",
    "local": "Local",
}

# Categories that support segmented median/divider sections
# (Joshua 2026-10-11).
DIVIDABLE_CATEGORIES = ("interstate", "highway", "major_artery")

# Valid divider types for a divided section.
DIVIDER_TYPES = ("median", "divider")


def normalize_category(cat):
    """
    Map legacy/unknown category strings to the current 5-category set.
    "arterial" (the old single category) becomes "minor_artery" so old
    roads.json data keeps working with no visual change except the label.
    Unknown values fall back to "local" rather than crashing lookups.
    """
    if cat == "arterial":
        return "minor_artery"
    if cat in ROAD_STYLE:
        return cat
    return "local"

# World extent (game coordinates)
WORLD_W = 8000
WORLD_H = 12000


# ---------------------------------------------------------------------------
# Zone boundary persistence
# ---------------------------------------------------------------------------
# Joshua edits zone boundaries by dragging pins in the app (and can add new
# pins by clicking a boundary edge). Those edits are stored as
# name -> {"points": [[x, z], ...]} so the shipped defaults above are never
# overwritten and edits survive restarts and reinstalls.

def load_zone_edits():
    """
    Read saved zone boundary edits and apply them onto ZONES in place.
    Called once at import time. Missing/corrupt file = no edits.
    Accepts both the old rectangle format (x0/x1/z0/z1) and the new
    polygon format (points) — old entries are auto-converted.
    """
    try:
        if not ZONE_EDITS_FILE.exists():
            return
        edits = json.loads(ZONE_EDITS_FILE.read_text())
    except Exception:
        return  # corrupt file — ignore rather than crash
    for zone in ZONES:
        ov = edits.get(zone["name"])
        if not ov:
            continue
        if "points" in ov:
            # New polygon format: list of [x, z] vertices
            zone["points"] = [[float(p[0]), float(p[1])]
                              for p in ov["points"]]
        elif "x0" in ov:
            # Old rectangle format: convert to a 4-point polygon
            zone["points"] = rect_to_points(
                ov["x0"], ov["x1"], ov["z0"], ov["z1"])
        _normalize_zone(zone)


def save_zone_edit(name, points):
    """
    Persist one zone's polygon boundary edit.
    points: list of [x, z] vertices.
    Updates ZONES in memory AND the JSON overlay file on disk.
    """
    # Normalize to plain float pairs (JSON-safe)
    clean = [[float(p[0]), float(p[1])] for p in points]
    # Update the live zone dict
    for zone in ZONES:
        if zone["name"] == name:
            zone["points"] = [list(p) for p in clean]
            break
    # Merge into the overlay file (keep other zones' edits)
    ensure_data_dir()
    try:
        edits = json.loads(ZONE_EDITS_FILE.read_text()) \
            if ZONE_EDITS_FILE.exists() else {}
    except Exception:
        edits = {}
    edits[name] = {"points": clean}
    ZONE_EDITS_FILE.write_text(json.dumps(edits, indent=2))


# Apply any previously saved boundary edits on top of the defaults.
load_zone_edits()


# ---------------------------------------------------------------------------
# Custom zones (created via "Fill Unzoned Area" or future new-zone tools)
# ---------------------------------------------------------------------------
# User-created zones are stored separately from boundary edits so they
# survive as full zone definitions (name + polygon + color).

CUSTOM_ZONES_FILE = DATA_DIR / "custom_zones.json"

# Default colors cycled for auto-created zones (RGB 0-1)
CUSTOM_ZONE_COLORS = [
    (0.80, 0.40, 0.20),  # burnt orange
    (0.20, 0.60, 0.80),  # steel blue
    (0.60, 0.20, 0.70),  # purple
    (0.20, 0.75, 0.45),  # teal green
    (0.85, 0.65, 0.15),  # gold
    (0.55, 0.35, 0.85),  # violet
]


def load_custom_zones():
    """
    Load Joshua's custom-created zones and append them to ZONES.
    Called once at import time, after load_zone_edits().
    """
    try:
        if not CUSTOM_ZONES_FILE.exists():
            return
        custom = json.loads(CUSTOM_ZONES_FILE.read_text())
    except Exception:
        return
    if not isinstance(custom, list):
        return
    for entry in custom:
        try:
            name = entry["name"]
            points = [[float(p[0]), float(p[1])] for p in entry["points"]]
            color = tuple(entry.get("color", (0.6, 0.6, 0.6)))
            if len(points) < 3:
                continue
            # Skip if a zone with this name already exists
            if any(z["name"] == name for z in ZONES):
                continue
            ZONES.append({"name": name, "points": points, "color": color})
        except Exception:
            continue


def save_custom_zone(name, points, color):
    """
    Persist a newly created zone and add it to the live ZONES list.
    name: str, points: [[x, z], ...], color: (r, g, b).
    """
    ensure_data_dir()
    clean_points = [[float(p[0]), float(p[1])] for p in points]
    clean_color = [float(color[0]), float(color[1]), float(color[2])]
    try:
        custom = json.loads(CUSTOM_ZONES_FILE.read_text()) \
            if CUSTOM_ZONES_FILE.exists() else []
        if not isinstance(custom, list):
            custom = []
    except Exception:
        custom = []
    # Replace any existing entry with the same name
    custom = [c for c in custom if c.get("name") != name]
    custom.append({"name": name, "points": clean_points,
                   "color": clean_color})
    CUSTOM_ZONES_FILE.write_text(json.dumps(custom, indent=2))
    # Add to live list if not already there
    if not any(z["name"] == name for z in ZONES):
        ZONES.append({"name": name, "points": [list(p) for p in clean_points],
                      "color": tuple(clean_color)})


def next_custom_zone_name():
    """
    Auto-name for new zones: "Zone 1", "Zone 2", ... skipping names
    already in use (by predefined or custom zones).
    """
    used = {z["name"] for z in ZONES}
    i = 1
    while f"Zone {i}" in used:
        i += 1
    return f"Zone {i}"


# Load custom zones after boundary edits so both apply cleanly.
load_custom_zones()


# ---------------------------------------------------------------------------
# Road edit persistence (Join / Merge / Extend / Delete)
# ---------------------------------------------------------------------------
# Road edits are stored as full-category replacements plus the base SHA of
# the roads.json they were made against. This is simple and robust: no
# fragile index bookkeeping, and a fresh download (new SHA) cleanly
# invalidates stale edits instead of corrupting data.


def load_road_edits():
    """
    Load saved road edits.
    Returns (base_sha, replaced) where replaced is
    {category: [road dicts]}. Returns (None, {}) if none/corrupt.
    """
    try:
        if not ROAD_EDITS_FILE.exists():
            return None, {}
        data = json.loads(ROAD_EDITS_FILE.read_text())
        replaced = data.get("replaced", {})
        if not isinstance(replaced, dict):
            return None, {}
        return data.get("base_sha"), replaced
    except Exception:
        return None, {}


def save_road_edits(base_sha, replaced):
    """
    Persist road edits.
    base_sha: SHA of the roads.json the edits apply to.
    replaced: {category: [full road list]} for each modified category.
    """
    ensure_data_dir()
    ROAD_EDITS_FILE.write_text(json.dumps(
        {"base_sha": base_sha, "replaced": replaced}))


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
    Get the current blob SHA of roads.json on GitHub.
    Returns None if offline or on error (non-blocking by design).
    """
    try:
        req = urllib.request.Request(
            API_URL,
            headers={"User-Agent": "adamsville-map-editor-native",
                     "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return data.get("sha")
    except Exception:
        # Offline or API error — not fatal, caller handles None
        return None


def get_local_sha():
    """Read the saved SHA of the locally cached roads.json."""
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
    Check if we need to download roads.json.
    Returns (needed: bool, reason: str).
    """
    if not ROADS_FILE.exists():
        return True, "Road data not found locally. Download from GitHub?"
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


def download_roads(progress_callback=None):
    """
    Download roads.json from GitHub to local cache.
    progress_callback(downloaded_bytes, total_bytes) — called during download.
    Returns True on success, False on failure.
    Uses atomic write (temp file → rename) to avoid partial files.
    """
    ensure_data_dir()
    try:
        req = urllib.request.Request(
            ROADS_URL,
            headers={"User-Agent": "adamsville-map-editor-native"})
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
        tmp_path = ROADS_FILE.with_suffix(".tmp")
        with open(tmp_path, "wb") as f:
            for chunk in chunks:
                f.write(chunk)
        tmp_path.rename(ROADS_FILE)

        # Save the new SHA
        remote_sha = get_remote_sha()
        if remote_sha:
            save_local_sha(remote_sha)

        return True
    except Exception as e:
        print(f"Download failed: {e}")
        return False


def load_roads():
    """
    Load roads from local cache.
    Returns dict: {"interstate": [...], "highway": [...],
                   "major_artery": [...], "minor_artery": [...], "local": [...]}
    (Old files may still use "arterial"; callers should run
    normalize_category() or migrate at load. See app._load_data.)
    Each road: {"name": str, "pts": [[x, z], ...]}
    """
    with open(ROADS_FILE) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Spatial index for fast viewport culling
# ---------------------------------------------------------------------------

class SpatialIndex:
    """
    Grid-based spatial index for roads.
    Divides the world into cells; each cell lists road indices that overlap it.
    Query with a viewport rect to get candidate roads quickly.
    """

    def __init__(self, cell_size=500):
        """
        cell_size: world units per grid cell.
        500u gives ~16x24 = 384 cells for the 8000x12000 world.
        """
        self.cell_size = cell_size
        # (cx, cz) -> list of (category, road_index)
        self.cells = {}
        # Flat list of all roads with precomputed bboxes
        # Each entry: (category, road_dict, x0, z0, x1, z1)
        self.roads = []

    def _cell_range(self, x0, z0, x1, z1):
        """Get the range of cell coordinates overlapping a bbox."""
        cx0 = int(x0 // self.cell_size)
        cz0 = int(z0 // self.cell_size)
        cx1 = int(x1 // self.cell_size)
        cz1 = int(z1 // self.cell_size)
        return cx0, cz0, cx1, cz1

    def add_road(self, category, road):
        """Add a road to the index. Computes bbox from points."""
        pts = road.get("pts", [])
        if len(pts) < 2:
            return
        xs = [p[0] for p in pts]
        zs = [p[1] for p in pts]
        x0, x1 = min(xs), max(xs)
        z0, z1 = min(zs), max(zs)

        idx = len(self.roads)
        self.roads.append((category, road, x0, z0, x1, z1))

        # Add to all overlapping cells
        cx0, cz0, cx1, cz1 = self._cell_range(x0, z0, x1, z1)
        for cx in range(cx0, cx1 + 1):
            for cz in range(cz0, cz1 + 1):
                key = (cx, cz)
                if key not in self.cells:
                    self.cells[key] = []
                self.cells[key].append(idx)

    def build(self, roads_data):
        """Build the index from the loaded roads dict."""
        # Legacy "arterial" roads are indexed under "minor_artery"
        # (Joshua 2026-10-11) so old data keeps rendering.
        for category in CATEGORY_ORDER:
            for road in roads_data.get(category, []):
                self.add_road(category, road)
        for road in roads_data.get("arterial", []):
            self.add_road("minor_artery", road)
        print(f"Spatial index: {len(self.roads)} roads in {len(self.cells)} cells")

    def query(self, x0, z0, x1, z1):
        """
        Get road indices overlapping the viewport rect.
        Returns list of indices into self.roads (deduplicated).
        """
        cx0, cz0, cx1, cz1 = self._cell_range(x0, z0, x1, z1)
        seen = set()
        result = []
        for cx in range(cx0, cx1 + 1):
            for cz in range(cz0, cz1 + 1):
                for idx in self.cells.get((cx, cz), []):
                    if idx not in seen:
                        seen.add(idx)
                        # Double-check bbox overlap (cell may over-cover)
                        _, _, rx0, rz0, rx1, rz1 = self.roads[idx]
                        if rx1 >= x0 and rx0 <= x1 and rz1 >= z0 and rz0 <= z1:
                            result.append(idx)
        return result


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



# ---------------------------------------------------------------------------
# Full-file export for GitHub push (Joshua 2026-10-11)
# ---------------------------------------------------------------------------
# These build the complete file contents to push, merging the shipped
# base data with Joshua's local edits.

def export_full_roads():
    """
    Build the complete roads.json content (base + local edits applied).
    Returns the JSON as UTF-8 bytes, ready to push to GitHub.
    """
    try:
        with open(ROADS_FILE) as f:
            roads = json.load(f)
    except Exception:
        roads = {"interstate": [], "highway": [], "major_artery": [],
                 "minor_artery": [], "local": []}
    # Migrate legacy "arterial" to "minor_artery" in the export so the
    # pushed file always uses the current 5-category schema
    # (Joshua 2026-10-11).
    if "arterial" in roads:
        legacy = roads.pop("arterial")
        if isinstance(legacy, list) and legacy:
            roads.setdefault("minor_artery", []).extend(legacy)
    _base_sha, replaced = load_road_edits()
    for cat, road_list in replaced.items():
        if isinstance(road_list, list):
            roads[cat] = road_list
    return json.dumps(roads, indent=1).encode("utf-8")


def export_full_zones():
    """
    Build the complete zones.json content (all zones with edits applied).
    Returns the JSON as UTF-8 bytes, ready to push to GitHub.
    ZONES already has edits and custom zones applied at import time.
    """
    out = []
    for z in ZONES:
        out.append({
            "name": z["name"],
            "points": [[float(p[0]), float(p[1])] for p in z["points"]],
            "color": [float(c) for c in z["color"]],
        })
    return json.dumps(out, indent=1).encode("utf-8")


# ---------------------------------------------------------------------------
# Overpass persistence (Joshua 2026-10-11)
# ---------------------------------------------------------------------------
# Overpasses are bridge structures that roads can link to. Stored in
# overpasses.json in the map-editor repo. Local cache + shared suite
# cache so the 3D viewers and terrain editor can read them.

# Local cache file for overpasses.
OVERPASSES_FILE = DATA_DIR / "overpasses.json"
# Shared suite cache (other apps read from here).
SHARED_OVERPASSES_FILE = (Path.home() / ".local" / "share"
                          / "adamsville-suite" / "overpasses.json")
# GitHub raw URL for overpasses.json.
OVERPASSES_URL = (f"https://raw.githubusercontent.com/{REPO}"
                  f"/main/overpasses.json")


def load_overpasses():
    """
    Load overpasses from local cache (shared suite cache first, then
    app-local). Returns a list of overpass dicts. Empty list if none.
    """
    for path in (SHARED_OVERPASSES_FILE, OVERPASSES_FILE):
        try:
            if path.exists():
                doc = json.loads(path.read_text())
                if isinstance(doc, list):
                    return doc
                if isinstance(doc, dict) and "overpasses" in doc:
                    return doc["overpasses"]
        except Exception:
            continue  # corrupt — try the next location
    return []


def save_overpasses(overpasses):
    """
    Persist overpasses to both the app-local cache and the shared
    suite cache so other apps (terrain editor, 3D viewers) can read
    them without re-downloading.
    """
    ensure_data_dir()
    text = json.dumps({"overpasses": overpasses}, indent=2)
    try:
        OVERPASSES_FILE.write_text(text)
    except Exception:
        pass  # non-fatal — shared cache is the important one
    try:
        SHARED_OVERPASSES_FILE.parent.mkdir(parents=True, exist_ok=True)
        SHARED_OVERPASSES_FILE.write_text(text)
    except Exception:
        pass


def download_overpasses():
    """
    Download overpasses.json from GitHub to local cache.
    Returns True on success, False on failure (non-fatal — the app
    works fine with an empty overpass list).
    """
    ensure_data_dir()
    try:
        req = urllib.request.Request(
            OVERPASSES_URL,
            headers={"User-Agent": "adamsville-map-editor-native"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read()
        OVERPASSES_FILE.write_bytes(content)
        try:
            SHARED_OVERPASSES_FILE.parent.mkdir(parents=True,
                                                exist_ok=True)
            SHARED_OVERPASSES_FILE.write_bytes(content)
        except Exception:
            pass
        return True
    except Exception:
        return False


def export_overpasses(overpasses):
    """
    Build the overpasses.json content for pushing to GitHub.
    Returns the JSON as UTF-8 bytes.
    """
    return json.dumps({"overpasses": overpasses}, indent=2).encode("utf-8")
