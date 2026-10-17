#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) 1.9.2 — Data management module.

1.9.0 REPOINT (Joshua's Step-1 Editors Phase): the game's converted
zone files in kingmarkarnold-code/adamsville-play are the source of
truth. On open the editor downloads (Contents API, fresh connection)
all 7 zones' zone.json + roads.json, detailed/overpasses.json and
detailed/elev.json — see gamedata.py for the model and the round-trip
save. The old adamsville-map-editor repo, its raw-URL downloads and
the road_edits.json overlay are GONE: local edits live in a per-zone
local cache and reach the game only through the round-trip save.

This module keeps the editor-facing surface the rest of the app was
built on (ZONES, SpatialIndex, window state, zone overlay helpers,
overpass cache helpers) and re-bases it on the game model.

Joshua's rule: all code commented.
"""

import json
import sys
from pathlib import Path

# Shared suite module (Joshua 2026-10-11): common utilities live in one
# place so all suite apps use the same code. Falls back to local
# implementations if not present.
for _suite_path in ("/usr/share/adamsville-suite",
                    str(Path.home() / ".local" / "share" / "adamsville-suite")):
    if _suite_path not in sys.path:
        sys.path.insert(0, _suite_path)
try:
    import adamsville_suite as suite
except ImportError:
    suite = None  # fall back to local implementations

# The 1.9.0 game-data model (zones, dirty tracking, round trip).
import gamedata
from gamedata import GAME_REPO, ZONE_IDS  # noqa: F401  (re-exported)


# ---------------------------------------------------------------------------
# Local cache layout
# ---------------------------------------------------------------------------
# The local save leg of every round trip writes the model's files here
# (per-zone, mirroring the repo layout) BEFORE anything is pushed, so
# Joshua's edits survive crashes and offline restarts. A fresh
# download-on-open overwrites the cache with the GitHub copies.

DATA_DIR = Path.home() / ".local" / "share" / "adamsville-map-editor-native"
ZONES_CACHE_DIR = DATA_DIR / "zones"
OVERPASSES_FILE = DATA_DIR / "overpasses.json"
ELEV_FILE = DATA_DIR / "elev.json"
VERSION_FILE = DATA_DIR / "version.json"
WINDOW_FILE = DATA_DIR / "window.json"
ZONE_EDITS_FILE = DATA_DIR / "zone_edits.json"
CUSTOM_ZONES_FILE = DATA_DIR / "custom_zones.json"
# Legacy 1.8.x files, kept as names only so old code paths that mention
# them fail soft instead of crashing; 1.9.0 never reads or writes them.
ROADS_FILE = DATA_DIR / "roads.json"
ROAD_EDITS_FILE = DATA_DIR / "road_edits.json"

# The live game model (gamedata.GameModel), set by the app once the
# download-on-open (or the local-cache load) completes. Zone overlay
# helpers below mirror their changes into it so the round trip sees
# them as dirty working files.
GAME_MODEL = None


def set_game_model(model):
    """
    Adopt a downloaded/loaded GameModel as the live model and rebuild
    the editor's ZONES list from its zone.json bounds + overlays.
    """
    global GAME_MODEL
    GAME_MODEL = model
    rebuild_zones_from_model()


def ensure_data_dir():
    """Create the local data directory (and zone cache) if missing."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ZONES_CACHE_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Zones for the canvas
# ---------------------------------------------------------------------------
# Zone names/bounds now come from the 7 zone.json files. zone.json's
# definition is a lat/lon RECTANGLE — it has no polygon — so the
# canvas polygons are the bounds rectangles (gamedata.zone_polygon_
# from_bounds). Joshua's dragged-boundary polygons and custom zones
# CANNOT be represented in zone.json; they remain editor overlays,
# round-tripped to editors/map-editor/zone_edits.json and
# custom_zones.json in adamsville-play (working data, not game data).

# Display colors per game zone (presentation only — the game data has
# no zone colors; these are the 1.8.x palette, matched by zone name).
_ZONE_COLORS = {
    "Mableton": (0.29, 0.56, 0.85),
    "Adamsville": (0.49, 0.83, 0.13),
    "Downtown": (0.96, 0.65, 0.14),
    "East Atlanta": (0.74, 0.06, 0.88),
    "Union City": (0.31, 0.89, 0.76),
    "South Fulton": (0.72, 0.91, 0.53),
    "Riverdale": (1.0, 0.42, 0.42),
}

# Fallback zone list used only before the first successful download
# (the 1.8.x rectangles in the OLD stage frame). As soon as a model is
# adopted, rebuild_zones_from_model() replaces these with the real
# converted bounds — nothing may save against the fallbacks.
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
    polygon. Used for backward compatibility with zone_edits.json
    files saved before zones became arbitrary polygons.
    Winding: top-left -> top-right -> bottom-right -> bottom-left.
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
    Ensure a zone dict has polygon-style "points" (auto-converts the
    old rectangle format if found).
    """
    if "points" not in zone and "x0" in zone:
        zone["points"] = rect_to_points(
            zone["x0"], zone["x1"], zone["z0"], zone["z1"])


for _z in ZONES:
    _normalize_zone(_z)
del _z


def rebuild_zones_from_model():
    """
    Rebuild ZONES (in place — mapcanvas holds the list object) from
    the live model's zone.json bounds, then re-apply the model's
    overlay working data (boundary edits + custom zones).
    """
    if GAME_MODEL is None:
        return
    fresh = []
    for zid in ZONE_IDS:
        zdata = GAME_MODEL.zones.get(zid)
        if not zdata:
            continue
        meta = zdata["meta"]
        name = meta.get("name", zid)
        fresh.append({
            "name": name,
            "zone_id": zid,
            "points": gamedata.zone_polygon_from_bounds(meta["bounds"]),
            "color": _ZONE_COLORS.get(name, (0.6, 0.6, 0.6)),
        })
    ZONES[:] = fresh
    # Overlay: Joshua's dragged boundary polygons.
    for zone in ZONES:
        ov = GAME_MODEL.zone_edits.get(zone["name"])
        if ov and "points" in ov:
            zone["points"] = [[float(p[0]), float(p[1])]
                              for p in ov["points"]]
    # Overlay: Joshua's custom zones.
    for entry in GAME_MODEL.custom_zones:
        try:
            name = entry["name"]
            points = [[float(p[0]), float(p[1])] for p in entry["points"]]
            color = tuple(entry.get("color", (0.6, 0.6, 0.6)))
            if len(points) < 3:
                continue
            if any(z["name"] == name for z in ZONES):
                continue
            ZONES.append({"name": name, "points": points, "color": color})
        except Exception:
            continue


# ---------------------------------------------------------------------------
# Road styles / categories (unchanged presentation layer)
# ---------------------------------------------------------------------------

ROAD_STYLE = {
    "interstate":   {"width": 28, "color": (0.72, 0.12, 0.12)},
    "highway":      {"width": 24, "color": (1.0, 0.27, 0.27)},
    "major_artery": {"width": 20, "color": (1.0, 0.45, 0.10)},
    "minor_artery": {"width": 16, "color": (1.0, 0.67, 0.0)},
    "local":        {"width": 10, "color": (0.53, 0.53, 0.53)},
}

CATEGORY_ORDER = ("interstate", "highway", "major_artery",
                  "minor_artery", "local")

CATEGORY_LABELS = {
    "interstate": "Interstate",
    "highway": "Highway",
    "major_artery": "Major Artery",
    "minor_artery": "Minor Artery",
    "local": "Local",
}

DIVIDABLE_CATEGORIES = ("interstate", "highway", "major_artery")
DIVIDER_TYPES = ("median", "divider")


def normalize_category(cat):
    """
    Map legacy/unknown category strings to the current 5-category set.
    "arterial" (the old single category) becomes "minor_artery".
    Unknown values fall back to "local" rather than crashing lookups.
    """
    if cat == "arterial":
        return "minor_artery"
    if cat in ROAD_STYLE:
        return cat
    return "local"


# World extent of the CONVERTED map (union of the 7 zone bounds):
# x -7480.59..16314.49, z -4248.54..30877.52. WORLD_X0/Z0 are the
# origin offsets the canvas fit math needs now that the world no
# longer starts at (0, 0).
WORLD_X0 = -7480.59
WORLD_Z0 = -4248.54
WORLD_W = 23795.08
WORLD_H = 35126.06


# ---------------------------------------------------------------------------
# Zone overlay persistence (editor working data)
# ---------------------------------------------------------------------------
# Locally these still land in ZONE_EDITS_FILE / CUSTOM_ZONES_FILE on
# every edit (the local save leg); the same content is mirrored into
# GAME_MODEL.zone_edits / custom_zones, whose baseline diff against
# editors/map-editor/*.json on GitHub is what makes the round trip
# push them. Undo snapshots read/restore the local files exactly as
# before, and the app re-syncs the model from them after a restore.

def _sync_overlays_to_model():
    """Copy the local overlay files' content into the live model."""
    if GAME_MODEL is None:
        return
    try:
        GAME_MODEL.zone_edits = (
            json.loads(ZONE_EDITS_FILE.read_text())
            if ZONE_EDITS_FILE.exists() else {})
    except Exception:
        GAME_MODEL.zone_edits = {}
    try:
        GAME_MODEL.custom_zones = (
            json.loads(CUSTOM_ZONES_FILE.read_text())
            if CUSTOM_ZONES_FILE.exists() else [])
    except Exception:
        GAME_MODEL.custom_zones = []


def load_zone_edits():
    """
    Read saved zone boundary edits and apply them onto ZONES in place.
    Missing/corrupt file = no edits. Accepts the old rectangle format
    and the polygon format.
    """
    try:
        if not ZONE_EDITS_FILE.exists():
            return
        edits = json.loads(ZONE_EDITS_FILE.read_text())
    except Exception:
        return
    for zone in ZONES:
        ov = edits.get(zone["name"])
        if not ov:
            continue
        if "points" in ov:
            zone["points"] = [[float(p[0]), float(p[1])]
                              for p in ov["points"]]
        elif "x0" in ov:
            zone["points"] = rect_to_points(
                ov["x0"], ov["x1"], ov["z0"], ov["z1"])
        _normalize_zone(zone)


def save_zone_edit(name, points):
    """
    Persist one zone's polygon boundary edit (local file + live ZONES
    + the game model, so the next round trip pushes it to
    editors/map-editor/zone_edits.json in adamsville-play).
    """
    clean = [[float(p[0]), float(p[1])] for p in points]
    for zone in ZONES:
        if zone["name"] == name:
            zone["points"] = [list(p) for p in clean]
            break
    ensure_data_dir()
    try:
        edits = json.loads(ZONE_EDITS_FILE.read_text()) \
            if ZONE_EDITS_FILE.exists() else {}
    except Exception:
        edits = {}
    edits[name] = {"points": clean}
    ZONE_EDITS_FILE.write_text(json.dumps(edits, indent=2))
    _sync_overlays_to_model()


# Apply any previously saved boundary edits on top of the defaults
# (before a model is adopted these are the local-cache overlays; the
# model adoption rebuild re-applies the GitHub overlays on top).
load_zone_edits()

CUSTOM_ZONE_COLORS = [
    (0.80, 0.40, 0.20), (0.20, 0.60, 0.80), (0.60, 0.20, 0.70),
    (0.20, 0.75, 0.45), (0.85, 0.65, 0.15), (0.55, 0.35, 0.85),
]


def load_custom_zones():
    """Load custom-created zones from the local file into ZONES."""
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
            if any(z["name"] == name for z in ZONES):
                continue
            ZONES.append({"name": name, "points": points, "color": color})
        except Exception:
            continue


def save_custom_zone(name, points, color):
    """
    Persist a newly created zone (local file + live ZONES + the game
    model, so the next round trip pushes it to
    editors/map-editor/custom_zones.json in adamsville-play).
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
    custom = [c for c in custom if c.get("name") != name]
    custom.append({"name": name, "points": clean_points,
                   "color": clean_color})
    CUSTOM_ZONES_FILE.write_text(json.dumps(custom, indent=2))
    if not any(z["name"] == name for z in ZONES):
        ZONES.append({"name": name, "points": [list(p) for p in clean_points],
                      "color": tuple(clean_color)})
    _sync_overlays_to_model()


def next_custom_zone_name():
    """Auto-name for new zones: "Zone 1", "Zone 2", ... skipping
    names already in use."""
    used = {z["name"] for z in ZONES}
    i = 1
    while f"Zone {i}" in used:
        i += 1
    return f"Zone {i}"


load_custom_zones()


# ---------------------------------------------------------------------------
# Legacy road-edit overlay — RETIRED in 1.9.0
# ---------------------------------------------------------------------------
# 1.8.x stored road edits as full-category replacements in
# road_edits.json against the old repo's roads.json SHA. That file's
# data belonged to the OLD map; applying it to the converted zones
# would corrupt them, so the functions below are deliberate no-ops
# kept only so any stray caller fails soft. Road edits now live in
# the per-zone local cache and ship via the round-trip save.

def load_road_edits():
    """Retired (see above): always (None, {})."""
    return None, {}


def save_road_edits(base_sha, replaced):
    """Retired (see above): road edits persist via save_local_cache."""
    return


# ---------------------------------------------------------------------------
# Local cache: save / load the whole game model
# ---------------------------------------------------------------------------

def _atomic_write(path, blob):
    """Write bytes via a temp file + rename (no partial files)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(blob)
    tmp.rename(path)


def save_local_cache(model):
    """
    The LOCAL SAVE leg of the round trip: write every model file to
    the local cache (per-zone roads.json + zone.json, overpasses,
    elev, overlays). Returns (True, None) or (False, error) — the
    round trip reports that as "local-save-failed: <error>" and
    pushes nothing.
    """
    try:
        ensure_data_dir()
        for zid in ZONE_IDS:
            zdata = model.zones.get(zid)
            if not zdata:
                continue
            zdir = ZONES_CACHE_DIR / zid
            _atomic_write(zdir / "roads.json",
                          gamedata.serialize_roads(zdata["roads"]))
            _atomic_write(zdir / "zone.json",
                          gamedata.serialize_json_compact(zdata["meta"]))
        _atomic_write(OVERPASSES_FILE,
                      gamedata.serialize_json_compact(model.overpass_doc))
        if model.elev is not None:
            _atomic_write(ELEV_FILE,
                          gamedata.serialize_json_compact(model.elev))
        _atomic_write(ZONE_EDITS_FILE,
                      json.dumps(model.zone_edits, indent=2).encode("utf-8"))
        _atomic_write(CUSTOM_ZONES_FILE,
                      json.dumps(model.custom_zones, indent=2).encode("utf-8"))
        return True, None
    except Exception as e:
        return False, str(e)


def load_local_model():
    """
    Build a GameModel from the local cache (offline fallback when the
    download-on-open fails). Baselines are the cache bytes themselves,
    so an offline session's edits still diff — and push — correctly
    once a token/connection is available. Returns None if the cache
    has no zone data.
    """
    model = gamedata.GameModel()
    found = False
    for zid in ZONE_IDS:
        rpath = ZONES_CACHE_DIR / zid / "roads.json"
        mpath = ZONES_CACHE_DIR / zid / "zone.json"
        try:
            if not (rpath.exists() and mpath.exists()):
                continue
            roads_blob = rpath.read_bytes()
            meta = json.loads(mpath.read_bytes().decode("utf-8"))
            model.zones[zid] = {"meta": meta, "roads": {}}
            model._load_zone_roads(zid, roads_blob)
            # Offline: we don't know GitHub's current bytes, so the
            # baseline is the cache copy — edits made offline will
            # push on the next successful round trip, and a no-edit
            # offline open still pushes nothing.
            model.baselines[gamedata.zone_roads_path(zid)] = roads_blob
            found = True
        except Exception:
            continue
    if not found:
        return None
    try:
        if OVERPASSES_FILE.exists():
            blob = OVERPASSES_FILE.read_bytes()
            model.overpass_doc = json.loads(blob.decode("utf-8"))
            model.baselines[gamedata.OVERPASSES_PATH] = blob
    except Exception:
        pass
    try:
        if ELEV_FILE.exists():
            model.elev = json.loads(ELEV_FILE.read_bytes().decode("utf-8"))
    except Exception:
        pass
    _model_overlays_from_local(model)
    return model


def _model_overlays_from_local(model):
    """Fill a model's overlay working data from the local files."""
    try:
        if ZONE_EDITS_FILE.exists():
            blob = ZONE_EDITS_FILE.read_bytes()
            model.zone_edits = json.loads(blob.decode("utf-8"))
            model.baselines[gamedata.ZONE_EDITS_PATH] = blob
    except Exception:
        pass
    try:
        if CUSTOM_ZONES_FILE.exists():
            blob = CUSTOM_ZONES_FILE.read_bytes()
            model.custom_zones = json.loads(blob.decode("utf-8"))
            model.baselines[gamedata.CUSTOM_ZONES_PATH] = blob
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Download-on-open + version checks (1.9.0 semantics)
# ---------------------------------------------------------------------------

def needs_download():
    """
    (needed, reason): a download is needed when the local cache has
    no zone data at all. (1.9.0 downloads fresh from GitHub on EVERY
    open when a connection is available — the app attempts it first
    and only falls back to this cache offline.)
    """
    for zid in ZONE_IDS:
        if (ZONES_CACHE_DIR / zid / "roads.json").exists():
            return False, "Local cache present."
    return True, "Road data not found locally. Download from GitHub?"


def get_remote_sha():
    """
    Retired: there is no single roads.json SHA anymore (15+ files,
    each with its own Contents-API SHA, handled inside github_sync).
    Kept returning None so legacy callers read it as "unknown".
    """
    return None


def get_local_sha():
    """Retired with get_remote_sha(); always None in 1.9.0."""
    return None


def save_local_sha(sha):
    """Retired with get_remote_sha(); a deliberate no-op in 1.9.0."""
    return


# 1.9.1: the REAL reason the most recent download failed, in the
# exact words gamedata/github_sync produced ("<path>: <reason>").
# The app shows this in its error dialog. Before 1.9.1 the reason
# was only printed to stdout — invisible on a desktop launch — and
# the dialog could only say "check your internet connection", which
# hid the actual fault on Joshua's laptop (2026-10-16).
LAST_DOWNLOAD_ERROR = None


def download_roads(progress_callback=None):
    """
    Download-on-open via the Contents API (gamedata.download_game_
    data — a fresh connection per file, never a raw URL). On success
    the model is adopted, cached locally, and True is returned. On
    failure the real error is kept in LAST_DOWNLOAD_ERROR for the
    app's dialog. The optional progress callback is invoked once
    per fetched file.
    """
    global LAST_DOWNLOAD_ERROR
    import github_sync as _sync
    model, err = gamedata.download_game_data(_sync)
    if model is None:
        LAST_DOWNLOAD_ERROR = err
        print(f"Download failed: {err}")
        return False
    LAST_DOWNLOAD_ERROR = None
    set_game_model(model)
    ok, lerr = save_local_cache(model)
    if not ok:
        print(f"Download ok but local cache failed: {lerr}")
        return False
    if progress_callback:
        progress_callback(1, 1)
    return True


def load_roads():
    """
    The merged {category: [roads]} working copy from the live model
    (or, before a model exists, from the local cache). Each road
    carries its "_zone" attribution.
    """
    if GAME_MODEL is not None:
        return GAME_MODEL.merged_roads()
    model = load_local_model()
    if model is None:
        raise FileNotFoundError("No local map data cached yet.")
    set_game_model(model)
    return model.merged_roads()


# ---------------------------------------------------------------------------
# Spatial index for fast viewport culling (unchanged from 1.8.x)
# ---------------------------------------------------------------------------

class SpatialIndex:
    """
    Grid-based spatial index for roads.
    Divides the world into cells; each cell lists road indices that
    overlap it. Query with a viewport rect to get candidates quickly.
    """

    def __init__(self, cell_size=500):
        """cell_size: world units per grid cell."""
        self.cell_size = cell_size
        self.cells = {}
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
        cx0, cz0, cx1, cz1 = self._cell_range(x0, z0, x1, z1)
        for cx in range(cx0, cx1 + 1):
            for cz in range(cz0, cz1 + 1):
                key = (cx, cz)
                if key not in self.cells:
                    self.cells[key] = []
                self.cells[key].append(idx)

    def build(self, roads_data):
        """Build the index from the loaded roads dict."""
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
                        _, _, rx0, rz0, rx1, rz1 = self.roads[idx]
                        if rx1 >= x0 and rx0 <= x1 and rz1 >= z0 and rz0 <= z1:
                            result.append(idx)
        return result


# ---------------------------------------------------------------------------
# Window state persistence (unchanged from 1.8.x)
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
# Full-file exports (kept for compatibility; the round trip in
# gamedata.py is what actually pushes in 1.9.0)
# ---------------------------------------------------------------------------

def export_full_roads():
    """
    The merged working copy as one compact JSON document.
    (1.9.0 pushes PER-ZONE files via gamedata; this merged export is
    kept only for diagnostics/legacy callers.)
    """
    if GAME_MODEL is None:
        return b"{}"
    merged = GAME_MODEL.merged_roads()
    clean = {}
    for cat, roads in merged.items():
        clean[cat] = [{k: v for k, v in r.items()
                       if not k.startswith("_")} for r in roads]
    return gamedata.serialize_json_compact(clean)


def export_full_zones():
    """All canvas zones (with overlay edits applied) as JSON bytes."""
    out = []
    for z in ZONES:
        out.append({
            "name": z["name"],
            "points": [[float(p[0]), float(p[1])] for p in z["points"]],
            "color": [float(c) for c in z["color"]],
        })
    return json.dumps(out, indent=1).encode("utf-8")


# ---------------------------------------------------------------------------
# Overpass persistence (1.9.0: the game's detailed/overpasses.json)
# ---------------------------------------------------------------------------
# The document is kept WHOLE ({"_note": ..., "overpasses": [...]}) so
# the note and any unknown keys round-trip untouched; the editor edits
# only the list. Locally the whole document is cached; a save pushes
# it via the round trip only when it actually changed.

SHARED_OVERPASSES_FILE = (Path.home() / ".local" / "share"
                          / "adamsville-suite" / "overpasses.json")


def load_overpasses():
    """
    The overpass list from the live model (or the local cache before
    a model exists). Empty list if none.
    """
    if GAME_MODEL is not None:
        return GAME_MODEL.overpass_doc.get("overpasses", [])
    try:
        if OVERPASSES_FILE.exists():
            doc = json.loads(OVERPASSES_FILE.read_text())
            if isinstance(doc, list):
                return doc
            if isinstance(doc, dict):
                return doc.get("overpasses", [])
    except Exception:
        pass
    return []


def save_overpasses(overpasses):
    """
    Persist the overpass list locally (whole document preserved) and
    into the live model, so the next round trip pushes
    detailed/overpasses.json if it changed. Also mirrors to the
    shared suite cache other apps read.
    """
    ensure_data_dir()
    if GAME_MODEL is not None:
        GAME_MODEL.overpass_doc["overpasses"] = overpasses
        doc = GAME_MODEL.overpass_doc
    else:
        doc = {"overpasses": overpasses}
        try:
            if OVERPASSES_FILE.exists():
                old = json.loads(OVERPASSES_FILE.read_text())
                if isinstance(old, dict):
                    doc = dict(old)
                    doc["overpasses"] = overpasses
        except Exception:
            pass
    text = json.dumps(doc, indent=2)
    try:
        OVERPASSES_FILE.write_text(text)
    except Exception:
        pass
    try:
        SHARED_OVERPASSES_FILE.parent.mkdir(parents=True, exist_ok=True)
        SHARED_OVERPASSES_FILE.write_text(text)
    except Exception:
        pass


def download_overpasses():
    """
    Retired as a separate flow in 1.9.0: overpasses download WITH the
    rest of the game data on open (download_roads). Returns True when
    a model with overpass data is already available.
    """
    return GAME_MODEL is not None


def export_overpasses(overpasses):
    """
    Build the detailed/overpasses.json bytes for a push: the whole
    document (note preserved) with the given list inside it, compact
    like the shipped game file.
    """
    doc = {"overpasses": overpasses}
    if GAME_MODEL is not None:
        doc = dict(GAME_MODEL.overpass_doc)
        doc["overpasses"] = overpasses
    else:
        try:
            if OVERPASSES_FILE.exists():
                old = json.loads(OVERPASSES_FILE.read_text())
                if isinstance(old, dict):
                    doc = dict(old)
                    doc["overpasses"] = overpasses
        except Exception:
            pass
    return gamedata.serialize_json_compact(doc)
