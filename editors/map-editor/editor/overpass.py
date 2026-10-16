#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) — Overpass linking and pillar placement.

When a road connects to an overpass, the terrain needs to rise to meet
it. This module handles:

1. Overpass data model (load/save/export overpasses.json)
2. The "Link to Overpass" workflow: select a road, click an overpass,
   and the system automatically lifts the terrain as a smooth ramp,
   connects the road's endpoint to the overpass, and renames the
   overpass to the road's street name.
3. Smart pillar placement (Joshua 2026-10-11):
   - Streets passing under overpasses must avoid pillar positions
     (pillars are obstacles — no road geometry through them).
   - Highway/interstate crossings: ensure a median exists under the
     overpass (auto-create if missing), place pillars in the median
     (center) and on both outside shoulders, verify each direction
     still has full lane clearance.

Joshua's rule: all code commented.
"""

import json
import math
import sys
from pathlib import Path

# Shared suite module (Joshua 2026-10-11): common utilities live in one
# place. Falls back to None if not present.
for _suite_path in ("/usr/share/adamsville-suite",
                    str(Path.home() / ".local" / "share" / "adamsville-suite")):
    if _suite_path not in sys.path:
        sys.path.insert(0, _suite_path)
try:
    import adamsville_suite as suite
except ImportError:
    suite = None


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# GitHub repo containing the map data (overpasses live alongside roads).
REPO = "kingmarkarnold-code/adamsville-map-editor"
OVERPASSES_URL = f"https://raw.githubusercontent.com/{REPO}/main/overpasses.json"

# Local data directory (XDG-compliant, same as the map editor).
DATA_DIR = Path.home() / ".local" / "share" / "adamsville-map-editor-native"
OVERPASSES_FILE = DATA_DIR / "overpasses.json"
# Shared suite cache so other apps (terrain editor, 3D viewers) can
# read overpass data without re-downloading.
SHARED_DIR = Path.home() / ".local" / "share" / "adamsville-suite"
SHARED_OVERPASSES = SHARED_DIR / "overpasses.json"

# Overpass deck rendering: distinct orange so it stands out on the map.
OVERPASS_COLOR = (1.0, 0.55, 0.1)      # orange deck
OVERPASS_EDGE = (0.7, 0.35, 0.05)      # darker orange outline
PILLAR_COLOR = (0.25, 0.25, 0.28)      # dark gray pillars

# Default deck height (world units above terrain) for new overpasses.
DEFAULT_DECK_HEIGHT = 25.0
# How far (world units) the approach ramp extends from the overpass.
RAMP_LENGTH = 300.0
# Pillar spacing along the overpass deck (world units).
PILLAR_SPACING = 150.0
# Standard lane width in world units (for lane clearance checks).
LANE_WIDTH = 12.0
# Median width for auto-created medians (world units).
AUTO_MEDIAN_WIDTH = 8.0


# ---------------------------------------------------------------------------
# Data persistence
# ---------------------------------------------------------------------------

def _ensure_data_dir():
    """Create the local data directory if it doesn't exist."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def load_overpasses():
    """
    Load overpasses from local cache (shared suite cache first, then
    app-local). Returns a list of overpass dicts. Empty list if none.
    """
    for path in (SHARED_OVERPASSES, OVERPASSES_FILE):
        try:
            if path.exists():
                doc = json.loads(path.read_text())
                if isinstance(doc, list):
                    return doc
                if isinstance(doc, dict) and "overpasses" in doc:
                    return doc["overpasses"]
        except Exception:
            continue  # corrupt file — try the next location
    return []


def save_overpasses(overpasses):
    """
    Persist overpasses to both the app-local cache and the shared
    suite cache so other apps can read them.
    """
    _ensure_data_dir()
    text = json.dumps({"overpasses": overpasses}, indent=2)
    try:
        OVERPASSES_FILE.write_text(text)
    except Exception:
        pass
    try:
        SHARED_DIR.mkdir(parents=True, exist_ok=True)
        SHARED_OVERPASSES.write_text(text)
    except Exception:
        pass


def export_overpasses(overpasses):
    """
    Build the JSON bytes for pushing overpasses.json to GitHub.
    Returns bytes ready for the Contents API.
    """
    return json.dumps({"overpasses": overpasses}, indent=2).encode("utf-8")


def download_overpasses():
    """
    Download overpasses.json from GitHub to local cache.
    Returns True on success, False on failure (non-fatal).
    """
    _ensure_data_dir()
    try:
        import urllib.request
        req = urllib.request.Request(
            OVERPASSES_URL,
            headers={"User-Agent": "adamsville-map-editor-native"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read()
        OVERPASSES_FILE.write_bytes(content)
        # Also populate the shared cache.
        try:
            SHARED_DIR.mkdir(parents=True, exist_ok=True)
            SHARED_OVERPASSES.write_bytes(content)
        except Exception:
            pass
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Overpass data model helpers
# ---------------------------------------------------------------------------

def make_overpass(overpass_id, x, z, deck_height=DEFAULT_DECK_HEIGHT,
                  name="Unnamed Overpass"):
    """
    Create a new overpass dict with sensible defaults.
    position is the center of the deck in world coords.
    """
    return {
        "id": overpass_id,
        "name": name,
        "position": [float(x), float(z)],
        "deck_height": float(deck_height),
        "connected_roads": [],
        "approach_ramps": [],
        "pillars": [],
    }


def overpass_bbox(ovp, deck_length=200.0, deck_width=60.0):
    """
    Bounding box of the overpass deck: (x0, z0, x1, z1).
    Default deck is 200x60 world units centered on position.
    """
    cx, cz = ovp["position"]
    hw, hd = deck_length / 2.0, deck_width / 2.0
    return (cx - hw, cz - hd, cx + hw, cz + hd)


# ---------------------------------------------------------------------------
# Pillar placement algorithm (Joshua 2026-10-11)
# ---------------------------------------------------------------------------
# Rule 1: Streets under overpasses respect pillars — pillars are
# obstacles, no road geometry passes through them.
# Rule 2: Highway/interstate crossings:
#   1. Ensure a median exists (auto-create for the crossing section)
#   2. Place pillars in the median (center) — primary support
#   3. Place pillars on both outside shoulders — secondary supports
#   4. Verify lane clearance — each direction keeps full lanes
#   5. Both directions (N/S or E/W based on highway orientation)

def _road_direction(pts):
    """
    Determine if a road runs more north-south or east-west.
    Returns "ns" or "ew" based on total displacement.
    """
    if len(pts) < 2:
        return "ns"
    dx = abs(pts[-1][0] - pts[0][0])
    dz = abs(pts[-1][1] - pts[0][1])
    return "ns" if dz >= dx else "ew"


def _point_to_segment_dist(px, pz, ax, az, bx, bz):
    """
    Distance from point (px, pz) to segment AB. Also returns the
    closest point on the segment as (cx, cz).
    """
    dx, dy = bx - ax, bz - az
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq < 1e-9:
        return math.hypot(px - ax, pz - az), (ax, az)
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dy) / seg_len_sq))
    cx, cz = ax + t * dx, az + t * dy
    return math.hypot(px - cx, pz - cz), (cx, cz)


def find_crossing_sections(overpass, roads_data, road_styles):
    """
    Find where highways/interstates pass under the overpass.

    overpass: the overpass dict.
    roads_data: {category: [road dicts]} — the map editor's working copy.
    road_styles: {category: {"width": w}} — for lane calculations.

    Returns a list of crossing dicts:
    {"category", "road", "road_name", "cross_point": (x, z),
     "direction": "ns"|"ew", "seg_idx": int,
     "road_width": float, "lanes_per_dir": int}
    """
    cx, cz = overpass["position"]
    crossings = []
    # Only highways and interstates get pillar treatment.
    for cat in ("highway", "interstate"):
        for road in roads_data.get(cat, []):
            pts = road.get("pts", [])
            if len(pts) < 2:
                continue
            # Find the closest point on the road to the overpass center.
            best_dist = float("inf")
            best_pt = None
            best_seg = 0
            for i in range(len(pts) - 1):
                d, cp = _point_to_segment_dist(
                    cx, cz, pts[i][0], pts[i][1],
                    pts[i + 1][0], pts[i + 1][1])
                if d < best_dist:
                    best_dist = d
                    best_pt = cp
                    best_seg = i
            # The road passes "under" the overpass if it comes within
            # the deck footprint (generous threshold).
            if best_dist < 150.0:
                style = road_styles.get(cat, {"width": 24})
                # Per-road width class multiplier (from Road Appearance).
                wmult = {"narrow": 0.6, "standard": 1.0,
                         "wide": 1.6}.get(
                    road.get("width_class", "standard"), 1.0)
                road_width = style["width"] * wmult
                # Lanes per direction: half the width / lane width,
                # minimum 1.
                lanes = max(1, int(road_width / 2.0 / LANE_WIDTH))
                crossings.append({
                    "category": cat,
                    "road": road,
                    "road_name": road.get("name", "Unnamed"),
                    "cross_point": best_pt,
                    "direction": _road_direction(pts),
                    "seg_idx": best_seg,
                    "road_width": road_width,
                    "lanes_per_dir": lanes,
                })
    return crossings


def ensure_median_for_crossing(crossing):
    """
    Rule 2.1: Ensure a median exists for the highway section under the
    overpass. If the road doesn't have a divided section covering the
    crossing, auto-create one.

    Mutates the road dict's "divided_sections" in place.
    Returns True if a median was created, False if one already existed.
    """
    road = crossing["road"]
    seg = crossing["seg_idx"]
    sections = road.get("divided_sections", [])
    # Check if any existing section covers this segment with a median.
    for s in sections:
        if (s.get("type") == "median"
                and s.get("from_idx", 0) <= seg <= s.get("to_idx", 0)):
            return False  # median already exists here
    # Auto-create a median section spanning a few segments around the
    # crossing (3 segments each way for a smooth transition).
    pts = road.get("pts", [])
    from_idx = max(0, seg - 3)
    to_idx = min(len(pts) - 1, seg + 3)
    sections.append({
        "from_idx": from_idx,
        "to_idx": to_idx,
        "type": "median",
        "auto_created": True,  # flag so Joshua knows it wasn't manual
    })
    road["divided_sections"] = sections
    return True


def _perpendicular(x1, z1, x2, z2):
    """
    Unit perpendicular vector to the direction (x1,z1)->(x2,z2).
    Points "left" of the direction of travel.
    """
    dx, dz = x2 - x1, z2 - z1
    length = math.hypot(dx, dz) or 1.0
    return (-dz / length, dx / length)


def place_pillars_for_crossing(crossing, deck_height):
    """
    Rule 2.2-2.5: Place pillars for one highway crossing.

    - Median pillar: centered in the median strip (primary support,
      doesn't block any lanes).
    - Outside pillars: on both shoulders, just beyond the travel lanes.
    - Lane clearance: each direction must keep its full lane count
      clear. Pillars are placed outside the lane area, so this is
      verified by construction — but we double-check.

    Returns a list of pillar dicts:
    {"x", "z", "position": "median"|"outside_west"|"outside_east",
     "deck_height": h}
    """
    cx, cz = crossing["cross_point"]
    road = crossing["road"]
    pts = road.get("pts", [])
    seg = crossing["seg_idx"]
    pillars = []

    # Direction of the road at the crossing (for perpendicular calc).
    i0 = max(0, seg)
    i1 = min(len(pts) - 1, seg + 1)
    ax, az = pts[i0]
    bx, bz = pts[i1]
    nx, nz = _perpendicular(ax, az, bx, bz)

    road_width = crossing["road_width"]
    lanes = crossing["lanes_per_dir"]
    # Half-width of the traveled lanes (both directions).
    half_travel = lanes * LANE_WIDTH
    # Median is centered; median pillar goes at the crossing point.
    pillars.append({
        "x": round(cx, 2),
        "z": round(cz, 2),
        "position": "median",
        "deck_height": deck_height,
    })

    # Outside pillars: beyond the shoulder edge on both sides.
    # Shoulder = 1 lane width beyond the travel lanes.
    shoulder_dist = half_travel + LANE_WIDTH
    # "west"/"east" are relative to the perpendicular; for ns roads
    # this is literally west/east, for ew roads it's north/south.
    # We keep the labels for consistency.
    for side, label in ((1.0, "outside_west"), (-1.0, "outside_east")):
        px = cx + nx * shoulder_dist * side
        pz = cz + nz * shoulder_dist * side
        # Lane clearance check: the pillar must be at least half a
        # lane beyond the travel lanes. If it's too close (shouldn't
        # happen by construction, but verify), push it outward.
        dist_from_center = abs(shoulder_dist * side)
        min_clear = half_travel + LANE_WIDTH / 2.0
        if dist_from_center < min_clear:
            push = min_clear - dist_from_center + LANE_WIDTH
            px = cx + nx * (shoulder_dist * side +
                            math.copysign(push, side))
            pz = cz + nz * (shoulder_dist * side +
                            math.copysign(push, side))
        pillars.append({
            "x": round(px, 2),
            "z": round(pz, 2),
            "position": label,
            "deck_height": deck_height,
        })

    return pillars


def compute_pillars(overpass, roads_data, road_styles):
    """
    Full pillar placement for an overpass.

    1. Find highway/interstate crossings under the overpass.
    2. For each crossing: ensure a median exists (auto-create if
       needed), then place median + outside pillars.
    3. Return (pillars, medians_created) where medians_created is a
       list of road names that got auto-created medians.

    The caller is responsible for persisting the overpass (pillars are
    stored on the overpass dict) and marking the affected road
    categories dirty (for the auto-created medians).
    """
    crossings = find_crossing_sections(overpass, roads_data, road_styles)
    all_pillars = []
    medians_created = []  # (category, road_name) tuples
    deck_h = overpass.get("deck_height", DEFAULT_DECK_HEIGHT)

    for crossing in crossings:
        # Rule 2.1: ensure median.
        if ensure_median_for_crossing(crossing):
            medians_created.append(
                (crossing["category"], crossing["road_name"]))
        # Rules 2.2-2.5: place pillars.
        all_pillars.extend(
            place_pillars_for_crossing(crossing, deck_h))

    return all_pillars, medians_created


def pillars_as_obstacles(pillars, clearance=15.0):
    """
    Rule 1: Convert pillars to obstacle circles for road routing.
    Returns a list of (x, z, radius) tuples. Any new road geometry
    must avoid these circles.

    clearance: extra buffer around each pillar (world units).
    """
    obstacles = []
    for p in pillars:
        # Pillar footprint ~6 units, plus clearance buffer.
        obstacles.append((p["x"], p["z"], 6.0 + clearance))
    return obstacles


def segment_avoids_pillars(ax, az, bx, bz, obstacles):
    """
    Rule 1 check: does the segment AB avoid all pillar obstacles?
    Returns True if clear, False if it passes through a pillar.
    """
    for ox, oz, radius in obstacles:
        d, _ = _point_to_segment_dist(ox, oz, ax, az, bx, bz)
        if d < radius:
            return False
    return True


# ---------------------------------------------------------------------------
# Approach ramp calculation
# ---------------------------------------------------------------------------
# When a road links to an overpass, the terrain between the road's
# endpoint and the overpass deck must rise smoothly. We compute a ramp
# as a series of heightfield edits (compatible with the terrain
# editor's terrain_edits.json format: "ix,iz" -> height).

# Terrain grid constants (must match the terrain editor).
TSX, TSZ = 150, 200
WORLD_W, WORLD_H = 8000, 12000
CELL_X = WORLD_W / TSX
CELL_Z = WORLD_H / TSZ


def _world_to_grid(wx, wz):
    """World coords -> fractional grid coords."""
    return wx / CELL_X, wz / CELL_Z


def compute_approach_ramp(road_end, overpass, base_height_fn):
    """
    Compute a smooth terrain ramp from a road endpoint up to an
    overpass deck.

    road_end: (x, z) of the road's endpoint nearest the overpass.
    overpass: the overpass dict (has "position" and "deck_height").
    base_height_fn: callable (x, z) -> current terrain height.

    Returns a dict of {(ix, iz): new_height} grid edits forming a
    smooth ramp. The ramp:
    - Starts at the road's current height at road_end
    - Rises smoothly (smoothstep interpolation) to deck_height
    - Is RAMP_LENGTH world units long, aimed at the overpass center
    - Has a width matching a standard road (~24 units) with soft edges

    The caller merges these into the terrain editor's edits and saves.
    """
    ex, ez = road_end
    ox, oz = overpass["position"]
    deck_h = overpass.get("deck_height", DEFAULT_DECK_HEIGHT)

    # Direction from road end toward the overpass.
    dx, dz = ox - ex, oz - ez
    dist = math.hypot(dx, dz)
    if dist < 1e-6:
        return {}  # road end is at the overpass center — nothing to ramp
    ux, uz = dx / dist, dz / dist
    # Perpendicular for ramp width.
    nx, nz = -uz, ux

    start_h = base_height_fn(ex, ez)
    ramp_len = min(RAMP_LENGTH, dist)
    ramp_width = 30.0  # wide enough for the road + soft edges

    edits = {}
    # Sample along the ramp in grid-cell steps.
    steps = max(2, int(ramp_len / CELL_X) + 1)
    for s in range(steps + 1):
        t = s / steps  # 0 at road end, 1 at overpass
        # Smoothstep for a natural ramp profile (gentle at both ends).
        smooth = t * t * (3.0 - 2.0 * t)
        h = start_h + (deck_h - start_h) * smooth
        # Center of this ramp cross-section.
        rcx = ex + ux * ramp_len * t
        rcz = ez + uz * ramp_len * t
        # Cross-section: full height in the middle, feather to base
        # height at the edges.
        across_steps = max(2, int(ramp_width / CELL_X) + 1)
        for a in range(across_steps + 1):
            at = a / across_steps  # 0 to 1 across
            # -1 to 1, 0 = center
            lateral = (at - 0.5) * 2.0
            wx = rcx + nx * lateral * ramp_width / 2.0
            wz = rcz + nz * lateral * ramp_width / 2.0
            # Feather: 1.0 at center, 0.0 at edges (cosine falloff).
            feather = 0.5 + 0.5 * math.cos(lateral * math.pi / 2.0)
            # Blend between ramp height and base terrain.
            base_h = base_height_fn(wx, wz)
            final_h = base_h + (h - base_h) * feather
            gx, gz = _world_to_grid(wx, wz)
            ix, iz = int(round(gx)), int(round(gz))
            if 0 <= ix < TSX and 0 <= iz < TSZ:
                # Keep the highest ramp value if cells overlap.
                key = (ix, iz)
                if key not in edits or final_h > edits[key]:
                    edits[key] = round(final_h, 2)

    return edits


def road_endpoint_to_overpass(road_pts, overpass_pos):
    """
    Find which endpoint of a road is nearest to an overpass.
    Returns (end_idx, (x, z)) where end_idx is 0 (first point) or
    -1 (last point).
    """
    ox, oz = overpass_pos
    if len(road_pts) < 1:
        return None, None
    d0 = math.hypot(road_pts[0][0] - ox, road_pts[0][1] - oz)
    d1 = math.hypot(road_pts[-1][0] - ox, road_pts[-1][1] - oz)
    if d0 <= d1:
        return 0, (road_pts[0][0], road_pts[0][1])
    else:
        return -1, (road_pts[-1][0], road_pts[-1][1])


# ---------------------------------------------------------------------------
# Clearance tiers and truck routing (Joshua 2026-10-11)
# ---------------------------------------------------------------------------
# Overpass clearance determines which vehicles can pass underneath:
#
# Tier 1: 16ft+ — all vehicles pass, no restrictions.
# Tier 2: ~9ft (van height) to 16ft — 18-wheelers CANNOT pass; vans and
#         cars can. A "LOW CLEARANCE" warning sign is automatically
#         placed before the overpass in both directions, showing the
#         actual clearance (e.g. "LOW CLEARANCE 12 FT").
# Tier 3: Below ~9ft — NOT ALLOWED. The editor refuses to go this low.
#
# Overpasses below 16ft are marked truck_restricted so the game's
# 18-wheeler pathfinding routes around them.

# Clearance thresholds in feet (= world units, 1 unit ≈ 1 ft).
MIN_CLEARANCE_FT = 16.0   # 18-wheelers need this much
VAN_HEIGHT_FT = 9.0        # below this: not allowed at all
# How far before the overpass to place warning signs (world units).
SIGN_DISTANCE = 200.0


def clearance_tier(deck_height_ft):
    """
    Determine the clearance tier for a deck height.
    Returns "full" (16ft+), "restricted" (9-16ft), or "blocked" (<9ft).
    """
    if deck_height_ft >= MIN_CLEARANCE_FT:
        return "full"
    if deck_height_ft >= VAN_HEIGHT_FT:
        return "restricted"
    return "blocked"


def format_clearance(deck_height_ft):
    """
    Format a deck height as a sign-friendly string.
    E.g. 12.5 -> "12 FT 6 IN", 14.0 -> "14 FT".
    """
    feet = int(deck_height_ft)
    inches = round((deck_height_ft - feet) * 12)
    if inches == 12:
        feet += 1
        inches = 0
    if inches:
        return f"{feet} FT {inches} IN"
    return f"{feet} FT"


def place_low_clearance_signs(overpass, road_pts):
    """
    Tier 2: Automatically place "LOW CLEARANCE" warning signs before
    the overpass in both directions of travel.

    overpass: the overpass dict (must have "position", "deck_height").
    road_pts: the linked road's points (for direction).

    Returns a list of sign dicts:
    {"x", "z", "direction": "northbound"|"southbound"|..., "text": ...}
    Signs are placed SIGN_DISTANCE before the overpass along the road,
    one for each direction of travel.
    """
    deck_h = overpass.get("deck_height", MIN_CLEARANCE_FT)
    if clearance_tier(deck_h) != "restricted":
        return []  # only restricted overpasses get signs

    ox, oz = overpass["position"]
    text = f"LOW CLEARANCE {format_clearance(deck_h)}"
    signs = []

    if len(road_pts) >= 2:
        # Direction of travel along the road.
        # Place one sign approaching from each end.
        for end_idx, direction in ((0, "inbound"), (-1, "outbound")):
            # Walk back from the overpass along the road.
            px, pz = road_pts[end_idx]
            # Direction from road end toward the overpass.
            dx, dz = ox - px, oz - pz
            dist = math.hypot(dx, dz)
            if dist < 1e-6:
                continue
            ux, uz = dx / dist, dz / dist
            # Sign position: SIGN_DISTANCE before the overpass, offset
            # to the right side of the road (like a real road sign).
            sign_dist = min(SIGN_DISTANCE, dist * 0.8)
            sx = ox - ux * sign_dist + uz * 15.0
            sz = oz - uz * sign_dist - ux * 15.0
            # Human-friendly direction label from road orientation.
            words = _direction_words_for(road_pts)
            label = words[0] if direction == "inbound" else words[1]
            signs.append({
                "x": round(sx, 2),
                "z": round(sz, 2),
                "direction": label,
                "text": text,
            })
    else:
        # No road points: place generic signs on both sides.
        for direction, (sx, sz) in (
                ("northbound", (ox - 30, oz - SIGN_DISTANCE)),
                ("southbound", (ox + 30, oz + SIGN_DISTANCE))):
            signs.append({
                "x": round(sx, 2),
                "z": round(sz, 2),
                "direction": direction,
                "text": text,
            })
    return signs


def _direction_words_for(pts):
    """
    Full-word direction labels for a road, e.g.
    ("northbound", "southbound"). Used for sign placement.
    """
    if len(pts) < 2:
        return ("northbound", "southbound")
    dx = pts[-1][0] - pts[0][0]
    dz = pts[-1][1] - pts[0][1]
    if abs(dx) >= abs(dz):
        return ("eastbound", "westbound")
    return ("northbound", "southbound")


def mark_truck_restricted(overpass, road, approach_dist=150.0):
    """
    Mark an overpass and its approach zone as truck-restricted.

    Sets truck_restricted=true on the overpass dict. Also marks the
    road segments within approach_dist of the overpass so the game's
    18-wheeler pathfinding can route around the entire restricted
    zone (not just the overpass itself — trucks shouldn't get stuck
    at the last second).

    Returns the list of road point indices in the restricted zone.
    """
    overpass["truck_restricted"] = True
    deck_h = overpass.get("deck_height", MIN_CLEARANCE_FT)
    overpass["clearance_ft"] = round(deck_h, 1)

    # Find road points within the approach zone.
    ox, oz = overpass["position"]
    restricted_indices = []
    for i, (px, pz) in enumerate(road.get("pts", [])):
        d = math.hypot(px - ox, pz - oz)
        if d <= approach_dist:
            restricted_indices.append(i)

    # Store the restricted point ranges on the road for the game's
    # pathfinding. Compact to ranges.
    if restricted_indices:
        ranges = []
        start = restricted_indices[0]
        prev = start
        for idx in restricted_indices[1:]:
            if idx == prev + 1:
                prev = idx
            else:
                ranges.append([start, prev])
                start = idx
                prev = idx
        ranges.append([start, prev])
        road.setdefault("truck_restricted_zones", []).extend(ranges)

    return restricted_indices


def clear_truck_restriction(overpass, road):
    """
    Remove truck restrictions (when clearance is raised to 16ft+).
    Cleans up the flags set by mark_truck_restricted.
    """
    overpass.pop("truck_restricted", None)
    overpass.pop("low_clearance_signs", None)
    # Keep clearance_ft as informational.
    if "truck_restricted_zones" in road:
        del road["truck_restricted_zones"]
