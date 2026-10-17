#!/usr/bin/env python3
"""
Adamsville Terrain Editor (Native) — Data management module.

Handles downloading the terrain heightfield from GitHub, local caching,
version checking, bilinear height sampling, and road overlay data.

Pure Python + GTK3 + Cairo. NO webview, NO HTML, NO JavaScript.

Joshua's rule: all code commented.
"""

import json
import math
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

# GitHub repo containing the terrain data (150x200 downsampled heightfield)
REPO = "kingmarkarnold-code/adamsville-elevation-editor"
# Raw URL for terrain.json — the single data file the app downloads
TERRAIN_URL = f"https://raw.githubusercontent.com/{REPO}/main/terrain.json"
# GitHub API URL for version checking (returns blob SHA)
API_URL = f"https://api.github.com/repos/{REPO}/contents/terrain.json"

# Roads come from the map editor repo (display-only overlay, never edited here)
MAP_REPO = "kingmarkarnold-code/adamsville-map-editor"
ROADS_URL = f"https://raw.githubusercontent.com/{MAP_REPO}/main/roads.json"

# Local data directory (XDG-compliant)
DATA_DIR = Path.home() / ".local" / "share" / "adamsville-terrain-editor-native"
TERRAIN_FILE = DATA_DIR / "terrain.json"
ROADS_FILE = DATA_DIR / "roads.json"
VERSION_FILE = DATA_DIR / "version.json"
WINDOW_FILE = DATA_DIR / "window.json"
# Joshua's terrain sculpting edits — saved here so they survive restarts.
# Format: {"x,y": new_height} where x,y are downsampled grid indices.
EDITS_FILE = DATA_DIR / "terrain_edits.json"

# World extent (game coordinates, same as map editor)
WORLD_W = 8000
WORLD_H = 12000

# Downsampled grid dimensions (must match terrain.json)
TSX = 150  # columns
TSZ = 200  # rows
# World units per downsampled cell
CELL_X = WORLD_W / TSX
CELL_Z = WORLD_H / TSZ


# ---------------------------------------------------------------------------
# Heightfield access
# ---------------------------------------------------------------------------

class Heightfield:
    """
    In-memory terrain heightfield with edit tracking and undo.

    Loads the 150x200 base grid from terrain.json, applies Joshua's saved
    edits on top, and supports brush sculpting with a 20-step undo stack.
    """

    def __init__(self):
        """Initialize empty; call load() to read from disk."""
        self.base = None       # list of 30000 base heights (row-major)
        self.edits = {}        # (ix, iz) -> current height (Joshua's changes)
        self.undo_stack = []   # list of {label, changes, road_changes}
        self.min_h = 0.0       # min height (for color ramp)
        self.max_h = 60.0      # max height (for color ramp)
        # RoadOffsets manager, wired by the app after load. Lets undo()
        # restore grouped road elevation offsets alongside terrain.
        # (Joshua 2026-10-11: terrain-road grouping.)
        self.road_offsets = None

    def load(self):
        """
        Load terrain.json from local cache and apply saved edits.
        Returns True on success, False if the file is missing/corrupt.
        """
        try:
            with open(TERRAIN_FILE) as f:
                doc = json.load(f)
            self.base = doc["h"]
            self.min_h = doc.get("min", 0.0)
            self.max_h = doc.get("max", 60.0)
            # Sanity check: must be 150x200 = 30000 values
            if len(self.base) != TSX * TSZ:
                return False
        except Exception:
            return False
        # Apply Joshua's previously saved edits on top of the base grid
        self._load_edits()
        return True

    def _load_edits(self):
        """Read saved terrain edits from disk into self.edits."""
        try:
            if not EDITS_FILE.exists():
                return
            raw = json.loads(EDITS_FILE.read_text())
            for key, h in raw.items():
                ix, iz = key.split(",")
                self.edits[(int(ix), int(iz))] = float(h)
        except Exception:
            pass  # corrupt file — start with no edits rather than crash

    # Optional callback invoked after edits are saved to disk.
    # The app sets this to mark changes as unpublished for the
    # close warning (Joshua 2026-10-11). No auto-push.

    def save_edits(self):
        """Persist current edits to disk (called after each committed change)."""
        ensure_data_dir()
        raw = {f"{ix},{iz}": h for (ix, iz), h in self.edits.items()}
        EDITS_FILE.write_text(json.dumps(raw))
        # Notify the app so it can auto-push (if a callback is set).
        # getattr: the app wires this in __init__; direct users of the
        # class may never set it.
        if getattr(self, "on_change", None) is not None:
            try:
                self.on_change()
            except Exception:
                pass

    def height(self, ix, iz):
        """
        Current height at downsampled grid cell (ix, iz).
        Returns the edited height if Joshua changed it, else the base.
        Clamps indices to valid range.
        """
        ix = max(0, min(TSX - 1, ix))
        iz = max(0, min(TSZ - 1, iz))
        key = (ix, iz)
        if key in self.edits:
            return self.edits[key]
        return self.base[iz * TSX + ix]

    def sample(self, wx, wz):
        """
        Bilinear interpolation of height at arbitrary world coordinates.
        Used for the status bar cursor readout and the level tool.
        """
        # Convert world -> fractional grid coords
        gx = max(0.0, min(TSX - 1.001, wx / CELL_X))
        gz = max(0.0, min(TSZ - 1.001, wz / CELL_Z))
        ix0, iz0 = int(gx), int(gz)
        fx, fz = gx - ix0, gz - iz0
        # Four surrounding vertices
        h00 = self.height(ix0, iz0)
        h10 = self.height(ix0 + 1, iz0)
        h01 = self.height(ix0, iz0 + 1)
        h11 = self.height(ix0 + 1, iz0 + 1)
        # Bilinear blend
        return (h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) +
                h01 * (1 - fx) * fz + h11 * fx * fz)

    def set_height(self, ix, iz, h):
        """
        Set a single vertex height (records into self.edits).
        Returns the old height (for undo tracking).
        """
        key = (ix, iz)
        old = self.edits.get(key, self.base[iz * TSX + ix])
        # Only store if actually different from base (keeps edits sparse)
        base_h = self.base[iz * TSX + ix]
        if abs(h - base_h) < 0.001:
            self.edits.pop(key, None)  # back to base = no edit needed
        else:
            self.edits[key] = h
        return old

    def apply_brush(self, wx, wz, radius, strength, direction):
        """
        Apply a raise/lower brush stroke centered at world (wx, wz).

        radius: brush radius in world units
        strength: height change per stroke at brush center
        direction: +1 to raise, -1 to lower

        Uses cosine falloff: full strength at center, zero at edge.
        Returns the number of vertices modified (for status bar).
        """
        # Convert brush center to grid coords
        cx = wx / CELL_X
        cz = wz / CELL_Z
        # Grid-space radius
        gr = radius / CELL_X  # approx (cells are ~square-ish)
        # Bounding box of affected cells
        ix0 = max(0, int(cx - gr))
        ix1 = min(TSX - 1, int(cx + gr) + 1)
        iz0 = max(0, int(cz - gr))
        iz1 = min(TSZ - 1, int(cz + gr) + 1)

        changes = {}  # (ix, iz) -> old height, for undo
        for iz in range(iz0, iz1 + 1):
            for ix in range(ix0, ix1 + 1):
                # Distance from brush center in grid cells
                dx = ix - cx
                dz = (iz - cz) * (CELL_Z / CELL_X)  # aspect correction
                dist = math.sqrt(dx * dx + dz * dz)
                if dist > gr:
                    continue
                # Cosine falloff: 1 at center, 0 at edge
                falloff = 0.5 * (1 + math.cos(math.pi * dist / gr))
                delta = direction * strength * falloff
                old = self.set_height(ix, iz, self.height(ix, iz) + delta)
                changes[(ix, iz)] = old
        return changes

    def level_area(self, x0, z0, x1, z1, target_h=None):
        """
        Flatten all vertices in the world rect (x0,z0)-(x1,z1) to a
        uniform height. If target_h is None, uses the area's average.
        Returns (changes_dict, applied_height).
        """
        ix0 = max(0, int(min(x0, x1) / CELL_X))
        ix1 = min(TSX - 1, int(max(x0, x1) / CELL_X))
        iz0 = max(0, int(min(z0, z1) / CELL_Z))
        iz1 = min(TSZ - 1, int(max(z0, z1) / CELL_Z))

        if target_h is None:
            # Compute average of current heights in the area
            total, count = 0.0, 0
            for iz in range(iz0, iz1 + 1):
                for ix in range(ix0, ix1 + 1):
                    total += self.height(ix, iz)
                    count += 1
            target_h = total / count if count else 0.0

        changes = {}
        for iz in range(iz0, iz1 + 1):
            for ix in range(ix0, ix1 + 1):
                old = self.set_height(ix, iz, target_h)
                changes[(ix, iz)] = old
        return changes, target_h

    def commit(self, label, changes, road_changes=None):
        """
        Push a change set onto the undo stack and save edits to disk.
        changes: dict of (ix, iz) -> old height (before the change).
        road_changes: optional dict of road-offset key -> old offset,
            for terrain-road grouping (restored together on undo).
        """
        if not changes and not road_changes:
            return
        self.undo_stack.append({"label": label,
                                "changes": changes or {},
                                "road_changes": road_changes or {}})
        # Cap at 20 steps (drop oldest)
        while len(self.undo_stack) > 20:
            self.undo_stack.pop(0)
        self.save_edits()

    def undo(self):
        """
        Undo the most recent change. Returns the label, or None if empty.
        Restores each vertex to its pre-change height.
        """
        if not self.undo_stack:
            return None
        entry = self.undo_stack.pop()
        for (ix, iz), old_h in entry["changes"].items():
            # set_height handles the base-vs-edit bookkeeping
            self.set_height(ix, iz, old_h)
        # Restore grouped road offsets alongside the terrain
        # (Joshua 2026-10-11: terrain-road grouping).
        if entry.get("road_changes") and self.road_offsets is not None:
            for key, old_off in entry["road_changes"].items():
                self.road_offsets.set(key, old_off)
            self.road_offsets.save()
        self.save_edits()
        return entry["label"]

    def undo_depth(self):
        """Number of undo steps available."""
        return len(self.undo_stack)

    def edit_count(self):
        """Number of vertices currently modified from base."""
        return len(self.edits)


# ---------------------------------------------------------------------------
# Face selection (shared by the three 3D viewports)
# ---------------------------------------------------------------------------
# Pure logic, no GTK — the view widgets in terraincanvas.py all read and
# write the same FaceSelection instance so selecting in one view shows
# up in the others instantly. (Joshua 2026-10-11: 3D terrain editor.)

class FaceSelection:
    """
    The set of currently selected terrain faces.

    A "face" is one full-resolution grid cell (ix, iz). The selection is
    shared by the top, side, and player's-eye views.

    Workflow (Joshua's spec): select faces (drag a box or Shift+click) ->
    they highlight amber but UNLOCKED -> click empty terrain to lock the
    selection in -> grab the locked selection and drag UP/DOWN to change
    elevation (vertical only).
    """

    def __init__(self):
        """Start with an empty, unlocked selection."""
        self.cells = set()   # set of (ix, iz) full-res grid cells
        self.locked = False  # True after Joshua clicks off to confirm

    def __len__(self):
        """Number of selected faces."""
        return len(self.cells)

    def __bool__(self):
        """True when at least one face is selected."""
        return bool(self.cells)

    def clear(self):
        """Empty the selection and unlock."""
        self.cells = set()
        self.locked = False

    def _clamp_cell(self, ix, iz):
        """Clamp grid indices to the valid range."""
        return (max(0, min(TSX - 1, ix)), max(0, min(TSZ - 1, iz)))

    def select_rect(self, x0, z0, x1, z1):
        """
        REPLACE the selection with all faces in the world rect
        (x0, z0)-(x1, z1). Unlocks the selection (needs confirming).
        """
        self.cells = set()
        self.add_rect(x0, z0, x1, z1)

    def add_rect(self, x0, z0, x1, z1):
        """
        ADD all faces in the world rect to the selection (Shift+drag).
        Unlocks the selection.
        """
        ix0, _ = self._clamp_cell(int(min(x0, x1) / CELL_X), 0)
        ix1, _ = self._clamp_cell(int(max(x0, x1) / CELL_X), 0)
        _, iz0 = self._clamp_cell(0, int(min(z0, z1) / CELL_Z))
        _, iz1 = self._clamp_cell(0, int(max(z0, z1) / CELL_Z))
        for iz in range(iz0, iz1 + 1):
            for ix in range(ix0, ix1 + 1):
                self.cells.add((ix, iz))
        self.locked = False

    def select_columns(self, ix0, ix1):
        """
        REPLACE the selection with full-height columns ix0..ix1
        (used by the side view, where z is ambiguous). Unlocks.
        """
        self.cells = set()
        self.add_columns(ix0, ix1)

    def add_columns(self, ix0, ix1):
        """ADD full-height columns ix0..ix1 (side view Shift+drag)."""
        a = max(0, min(TSX - 1, min(ix0, ix1)))
        b = max(0, min(TSX - 1, max(ix0, ix1)))
        for iz in range(TSZ):
            for ix in range(a, b + 1):
                self.cells.add((ix, iz))
        self.locked = False

    def toggle_cell(self, ix, iz):
        """Shift+click: add the face if absent, remove if present."""
        ix, iz = self._clamp_cell(ix, iz)
        if (ix, iz) in self.cells:
            self.cells.discard((ix, iz))
        else:
            self.cells.add((ix, iz))
        self.locked = False

    def add_cell(self, ix, iz):
        """Add one face to the selection."""
        ix, iz = self._clamp_cell(ix, iz)
        self.cells.add((ix, iz))
        self.locked = False

    def lock(self):
        """Confirm the selection (click off it). Enables grab-to-lift."""
        if self.cells:
            self.locked = True

    def bounds(self):
        """World rect (x0, z0, x1, z1) of the selection, or None."""
        if not self.cells:
            return None
        ixs = [c[0] for c in self.cells]
        izs = [c[1] for c in self.cells]
        return (min(ixs) * CELL_X, min(izs) * CELL_Z,
                (max(ixs) + 1) * CELL_X, (max(izs) + 1) * CELL_Z)

    def centroid(self):
        """World (x, z) center of the selection, or None if empty."""
        if not self.cells:
            return None
        n = len(self.cells)
        sx = sum(c[0] for c in self.cells) / n
        sz = sum(c[1] for c in self.cells) / n
        return ((sx + 0.5) * CELL_X, (sz + 0.5) * CELL_Z)

    def quad_keys(self, step):
        """
        Downsampled quad keys covering the selection, for highlight
        rendering: {(qx, qz)} where qx/qz are step-aligned grid indices.
        """
        return {(ix // step * step, iz // step * step)
                for (ix, iz) in self.cells}


# ---------------------------------------------------------------------------
# Terrain-road grouping (Joshua 2026-10-11)
# ---------------------------------------------------------------------------
# Roads are separate data (polylines in roads.json) but can be GROUPED with
# the terrain so they move up/down together, like grouping meshes in
# Blender. Each road point stores an elevation OFFSET added to the sampled
# terrain height: elev = terrain_height(x, z) + offset. Non-destructive —
# "move terrain only" mode never touches the offsets.

# Road offset storage: {"cat/ri/pi": offset}
ROAD_OFFSETS_FILE = DATA_DIR / "road_offsets.json"


class RoadOffsets:
    """Per-road-point elevation offsets for terrain-road grouping."""

    def __init__(self):
        """Start empty; call load() to read saved offsets."""
        self.offsets = {}  # "cat/ri/pi" -> float

    def load(self):
        """Read saved offsets from disk (missing file = no offsets)."""
        try:
            if ROAD_OFFSETS_FILE.exists():
                raw = json.loads(ROAD_OFFSETS_FILE.read_text())
                self.offsets = {str(k): float(v)
                                for k, v in raw.items()
                                if abs(float(v)) > 0.0005}
        except Exception:
            self.offsets = {}

    def save(self):
        """Persist offsets to disk."""
        ensure_data_dir()
        ROAD_OFFSETS_FILE.write_text(json.dumps(self.offsets))

    def get(self, key):
        """Offset for a road-point key (0.0 when unset)."""
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

    def nonzero(self):
        """All stored offsets (already sparse)."""
        return dict(self.offsets)


def build_road_cell_index(roads_data):
    """
    Build a reverse index from terrain grid cells to road points.

    Returns (cell_index, key_cell):
      cell_index: {(ix, iz): [(key, wx, wz), ...]} — road points in a cell
      key_cell:   {key: (ix, iz)} — cell for each road-point key

    Used for terrain-road grouping: when selected faces move by dh, every
    road point in those cells gets its offset adjusted by dh.
    """
    cell_index = {}
    key_cell = {}
    if not roads_data:
        return cell_index, key_cell
    for cat in ("highway", "arterial", "local"):
        for ri, road in enumerate(roads_data.get(cat, [])):
            for pi, p in enumerate(road.get("pts", [])):
                ix = int(p[0] / CELL_X)
                iz = int(p[1] / CELL_Z)
                if 0 <= ix < TSX and 0 <= iz < TSZ:
                    key = "%s/%d/%d" % (cat, ri, pi)
                    cell_index.setdefault((ix, iz), []).append(
                        (key, p[0], p[1]))
                    key_cell[key] = (ix, iz)
    return cell_index, key_cell


# ---------------------------------------------------------------------------
# Height color ramp (green low -> brown high)
# ---------------------------------------------------------------------------
# NOTE (2026-10-11): the 3D editor no longer uses this heatmap — terrain
# renders with natural face shading instead. Kept for compatibility.

# Color stops: (height, r, g, b) — RGB 0-1
# Matches the web elevation editor's palette so Joshua sees familiar colors.
RAMP = [
    (4,   0.18, 0.35, 0.15),   # deep green (valleys)
    (18,  0.43, 0.55, 0.27),   # grass
    (32,  0.59, 0.51, 0.27),   # dry grass
    (45,  0.55, 0.41, 0.22),   # dirt brown
    (57,  0.67, 0.55, 0.35),   # pale peak
]


def height_color(h):
    """
    Map a height value to an RGB color via piecewise-linear ramp.
    Returns (r, g, b) tuple, 0-1 range.
    """
    if h <= RAMP[0][0]:
        return RAMP[0][1], RAMP[0][2], RAMP[0][3]
    for i in range(len(RAMP) - 1):
        h0 = RAMP[i][0]
        h1 = RAMP[i + 1][0]
        if h <= h1:
            t = (h - h0) / (h1 - h0)
            r = RAMP[i][1] + (RAMP[i + 1][1] - RAMP[i][1]) * t
            g = RAMP[i][2] + (RAMP[i + 1][2] - RAMP[i][2]) * t
            b = RAMP[i][3] + (RAMP[i + 1][3] - RAMP[i][3]) * t
            return r, g, b
    return RAMP[-1][1], RAMP[-1][2], RAMP[-1][3]


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
    Get the current blob SHA of terrain.json on GitHub.
    Returns None if offline or on error (non-blocking by design).
    """
    try:
        req = urllib.request.Request(
            API_URL,
            headers={"User-Agent": "adamsville-terrain-editor-native",
                     "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return data.get("sha")
    except Exception:
        # Offline or API error — not fatal, caller handles None
        return None


def get_local_sha():
    """Read the saved SHA of the locally cached terrain.json."""
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
    Check if we need to download terrain.json.
    Returns (needed: bool, reason: str).
    """
    if not TERRAIN_FILE.exists():
        return True, "Terrain data not found locally. Download from GitHub?"
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


def download_file(url, dest_path, progress_callback=None, user_agent="adamsville-terrain-editor-native"):
    """
    Generic file downloader with progress and atomic write.
    Returns True on success, False on failure.
    """
    ensure_data_dir()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": user_agent})
        with urllib.request.urlopen(req, timeout=120) as resp:
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

        # Atomic write: temp file then rename (no partial files)
        tmp_path = dest_path.with_suffix(".tmp")
        with open(tmp_path, "wb") as f:
            for chunk in chunks:
                f.write(chunk)
        tmp_path.rename(dest_path)
        return True
    except Exception as e:
        print(f"Download failed: {e}")
        return False


def download_terrain(progress_callback=None):
    """
    Download terrain.json from GitHub to local cache.
    Returns True on success, False on failure.
    """
    ok = download_file(TERRAIN_URL, TERRAIN_FILE, progress_callback)
    if ok:
        remote_sha = get_remote_sha()
        if remote_sha:
            save_local_sha(remote_sha)
    return ok


def download_roads(progress_callback=None):
    """
    Download roads.json (display-only overlay) from the map editor repo.
    Also saves to the shared suite cache so other apps reuse it.
    Returns True on success. Failure is non-fatal (roads are optional).
    """
    ok = download_file(ROADS_URL, ROADS_FILE, progress_callback)
    if ok and suite is not None:
        try:
            suite.save_shared_file("roads.json", ROADS_FILE.read_bytes())
        except Exception:
            pass  # local copy is fine; sharing is best-effort
    return ok


def load_roads():
    """
    Load cached roads for the overlay.
    Checks the SHARED suite cache first (Joshua 2026-10-11: one download,
    every app uses it), then the app-local copy.
    Returns dict {"highway": [...], "arterial": [...], "local": [...]}
    or None if not downloaded yet.
    """
    # Shared cache first — the map editor may have downloaded these already.
    if suite is not None:
        try:
            p = suite.get_shared_file("roads.json")
            if p is not None:
                return json.loads(p.read_text())
        except Exception:
            pass
    try:
        with open(ROADS_FILE) as f:
            return json.load(f)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Window geometry persistence
# ---------------------------------------------------------------------------

def save_window_state(x, y, width, height, maximized):
    """Save window position/size for next launch."""
    ensure_data_dir()
    with open(WINDOW_FILE, "w") as f:
        json.dump({"x": x, "y": y, "width": width, "height": height,
                   "maximized": maximized}, f)


def load_window_state():
    """Load saved window geometry, or None if never saved."""
    try:
        with open(WINDOW_FILE) as f:
            return json.load(f)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Terrain edit export (for Push to GitHub)
# ---------------------------------------------------------------------------

def export_edits():
    """
    Build the export payload for Push to GitHub.
    Returns a dict with grid info, all modified vertices as
    world-coordinate entries with old/new heights, and grouped road
    elevation offsets.

    The game-side apply step uses this to update the full-res heightfield
    and to render grouped roads at their offset elevations.
    """
    hf = Heightfield()
    if not hf.load():
        return None
    # hf.edits maps (ix, iz) -> new height; base gives old height
    verts = []
    for (ix, iz), new_h in sorted(hf.edits.items()):
        old_h = hf.base[iz * TSX + ix]
        # World coords of the vertex center
        wx = (ix + 0.5) * CELL_X
        wz = (iz + 0.5) * CELL_Z
        verts.append({"x": round(wx, 2), "z": round(wz, 2),
                      "oldH": round(old_h, 2), "newH": round(new_h, 2)})
    # Grouped road offsets (terrain-road grouping, Joshua 2026-10-11).
    ro = RoadOffsets()
    ro.load()
    road_offsets = [{"key": k, "offset": round(v, 2)}
                    for k, v in sorted(ro.nonzero().items())]
    return {
        "app": "adamsville-terrain-editor-native",
        "version": 2,
        "grid": {"sx": TSX, "sz": TSZ,
                 "world_w": WORLD_W, "world_h": WORLD_H},
        "modifiedVertices": verts,
        "roadOffsets": road_offsets,
    }
