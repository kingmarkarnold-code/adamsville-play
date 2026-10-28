# zonedata.py — game zone building data for the Building Editor.
#
# 1.7.2 REWORK (Joshua, 2026-10-17): LOAD ON DEMAND + ALL LISTS FROM
# GITHUB. The 1.6.0–1.7.1 design downloaded and parsed ALL SEVEN
# zones (~166,000 buildings, ~276 MB of building details, ~69 MB of
# parsed road backdrops) before the editor could be used; measured
# steady state was ~530–580 MB resident, which is what made the app
# feel frozen on Joshua's laptop. Now:
#
#   * STARTUP loads only LIGHT INDEXES (one small file per zone:
#     name, type, position, size — enough to browse, search, sort)
#     plus the flagged list, the gas-station review list and the
#     station-edits overlay, ALL downloaded from GitHub (Joshua's
#     rule: no list is baked into the app; a local file is only ever
#     a cache of a previous successful download).
#   * Selecting a building downloads ONLY its zone's full records
#     (ensure_zone), and the roads backdrop is reduced at once to
#     the segments near the selected building — the parsed roads of
#     a zone are never retained (the raw bytes are kept so a
#     transient parse is possible; the parsed form is dropped).
#   * A zone with no unsaved edits may be unloaded again
#     (unload_zone); a dirty zone is NEVER dropped.
#   * After the editor's own save pushes a changed zone, that zone's
#     light index is regenerated from the in-memory data and pushed
#     in the SAME round, so the list can never show its own edits
#     stale.
#
# Data model (unchanged since 1.6.0): the editor works on the game's
# converted zone files in detailed/zones/<zone>/ of the single
# adamsville-play repo:
#   buildings.json         {"version", "realCount",
#                           "buildings": [[x, z, w, d, h, type], ...]}
#   buildings_detail.json  [ {name, osm_type, height_m, ring, ...} ]
#                          index-aligned with buildings.json
#   buildings.js           the game's twin of buildings.json
#   hero_buildings.json    hand-placed read-only buildings (may 404)
#   zone.json              {"id", "name", "bounds": {...}}
#   roads.json             backdrop reference for the 3D inspector
#
# buildings.json's boxes and buildings_detail.json's records are
# index-aligned (record i describes box i); that invariant is
# checked on load and before every push — a misaligned pair is
# REFUSED, never "repaired" silently.
#
# Saving follows Joshua's standing rule (2026-10-16): download ->
# edit -> save locally -> push -> CLOSE the connection -> REOPEN a
# fresh connection -> re-download -> the view refreshes from the
# downloaded proof copy. Nothing counts as saved until it has been
# seen coming back. See GameStore.round_trip_save.
#
# Flagged buildings (Joshua, 2026-10-16): the conversion flagged
# 1,532 buildings that still intersect a road. They are listed in
# editors/building-editor/flagged_buildings.json IN THE REPO
# (downloaded on open since 1.7.2 — through 1.7.1 the list was
# bundled with the app, which meant it could go stale). Flagged
# buildings are LOCKED in the editor: no move, resize, or delete —
# they await Joshua's own decision.
#
# This module is pure data + GitHub transport by injected callables
# (fetch_file / push_targets / open_connection, github_sync's
# signatures) so the harness can drive it with a stubbed transport.
#
# 2.0.0 REWORK (Joshua, 2026-10-18): THE SNAPSHOT MODEL. 1.7.2's
# load-on-demand still downloaded a building's WHOLE ZONE before it
# could show one building (19.06 MB for Riverdale) — the weight
# Joshua's lightweight law rejects. Now selecting a building
# generates a SNAPSHOT of just that building:
#
#   * A zone's SPINE (buildings.json boxes + zone.json + hero list,
#     ~0.9–1.9 MB) is all that loads before a selection. The detail
#     records live in editors/building-editor/detail-chunks/<zone>/
#     as small per-area files (a 2000-unit grid; each chunk holds
#     the records of the buildings whose centres fall in its cell,
#     keyed by building index). DetailList fetches ONLY the chunks
#     a snapshot touches — the subject's cell and its neighbours'.
#   * Roads stay the game's own roads.json (raw bytes, parsed
#     transiently), fetched lazily on the zone's first snapshot.
#   * EDITING a zone is the one moment its full detail set is
#     assembled (materialize_details, from the same chunks): the
#     write-back law needs the whole aligned pair to bake a delta
#     into. Viewing never pays that cost.
#   * SAVING pushes the zone pair + regenerated light index + the
#     regenerated chunks of exactly the cells the edits touched
#     (a delete shifts indexes, so it regenerates every cell), and
#     the proof leg must return bytes IDENTICAL to what was pushed
#     AND records identical to what was meant — the byte-proof law
#     (Issue B: a save may only say "saved" about bytes that were
#     seen coming back carrying the change).
#   * The flagged matcher compares AREA centroids (the centre the
#     flagged list actually stores). 1.7.x compared vertex means,
#     which drift past the 1.0 tolerance on irregular rings — the
#     measured reason 1,122 of 1,532 flagged buildings were never
#     locked. See ring_area_centroid.
#
# 2.0.1 (Joshua's live report, 2026-10-18): THE SELECT FREEZE,
# AGAIN — AND THE FIX. The snapshot model cut the BYTES, but the
# selection path still ran its downloads (detail chunks, the
# zone's 2.4 MB roads.json) and a full roads parse + ~79k-segment
# index build SYNCHRONOUSLY on the UI thread, and rebuilt that
# parse on EVERY click ("transient"). On Joshua's laptop over a
# real network that is a multi-second freeze per selection, cold
# or warm. The 2.0.0 harness could not see it: it served files
# from local disk at zero latency, under a fake GTK. Now:
#
#   * GameStore.prepare_snapshot gathers EVERYTHING a selection
#     needs (chunks, roads bytes, front, backdrop) in one call,
#     and the app runs it on a WORKER thread — the UI thread only
#     applies the finished snapshot. Downloads ride the window's
#     MB progress bar (fetch_zone_file's progress path).
#   * ZoneData.roads_view caches the parsed roads + segment
#     index ONCE per zone per roads bytes (single-slot across
#     zones), so repeat selections pay neither the parse nor
#     the index build again. building_front takes the cached
#     index; the derived fronts are byte-identical (the
#     exactness gate proves it).
#   * A roads failure is reported by name (prepare_snapshot's
#     roads_error) instead of silently degrading the view.

import copy
import json
import math
import threading
from datetime import date as _date
from pathlib import Path

REPO = "kingmarkarnold-code/adamsville-play"
ZONES = ["adamsville", "downtown", "eastatlanta", "mableton",
         "riverdale", "southfulton", "unioncity"]
ZONE_DIR = "detailed/zones/{zone}"
ZONE_FILES = ("buildings.json", "buildings_detail.json",
              "hero_buildings.json", "zone.json", "roads.json")
SUBDIVISIONS_REPO_PATH = "editors/building-editor/subdivisions.json"

# Editor-side data files that live in the repo and are DOWNLOADED on
# open (Joshua's 1.7.2 rule: all lists from GitHub, nothing baked
# in). A local copy may exist only as a download cache.
INDEX_REPO_DIR = "editors/building-editor/index"
INDEX_REPO_PATH = INDEX_REPO_DIR + "/{zone}.json"
FLAGGED_REPO_PATH = "editors/building-editor/flagged_buildings.json"
REVIEW_REPO_PATH = "editors/building-editor/gas-station-review.json"
STATION_EDITS_REPO_PATH = "editors/building-editor/station-edits.json"

# Stamps into the version string of any zone file this editor saves
# ("<date>-building-editor-<ver>-<zone>").
EDITOR_VERSION = "2.0.9"

# -- detail chunks (2.0.0 snapshot model) ------------------------------
# buildings_detail.json stays the game's canonical detail file; the
# EDITOR reads details through chunk files derived from it (and
# regenerates the chunks it touches when it saves). One chunk per
# 2000-unit grid cell: {"zone", "cell": [cx, cz], "cellSize",
# "count", "records": {"<index>": {detail record}}}. A record lives
# in the cell of its BOX CENTRE. 222 chunks cover all seven zones.
DETAIL_CHUNK_DIR = "editors/building-editor/detail-chunks"
DETAIL_CELL = 2000.0
# How many fetched chunks a zone keeps in memory at once (LRU). A
# snapshot touches 1–4; 12 leaves headroom for browsing around.
CHUNK_CACHE_MAX = 12
# The snapshot's neighbourhood radius (2.0.0 spec §1): the subject
# is shown WITH the buildings inside this distance, read-only.
SNAPSHOT_RADIUS = 120.0


def detail_cell(x, z):
    """The detail-chunk cell of a point: (cx, cz) on the
    DETAIL_CELL grid."""
    return (int(math.floor(x / DETAIL_CELL)),
            int(math.floor(z / DETAIL_CELL)))


def detail_chunk_path(zone, cell):
    """Repo path of one detail chunk file."""
    return f"{DETAIL_CHUNK_DIR}/{zone}/{cell[0]}_{cell[1]}.json"


def build_chunk_doc(zone, cell, boxes, details):
    """
    The chunk document for one cell from full zone data: the
    records (keyed by building index) of every building whose box
    centre falls in `cell`. Shared by the committed generator
    (generate_detail_chunks.py) and by the save path (which
    regenerates exactly the cells its edits touched) — one
    definition, so the two can never drift.
    """
    records = {}
    for i, box in enumerate(boxes):
        if detail_cell(box[0], box[1]) == cell:
            records[str(i)] = details[i]
    return {"zone": zone, "cell": [cell[0], cell[1]],
            "cellSize": DETAIL_CELL, "count": len(records),
            "records": records}


def chunk_bytes(doc):
    """Canonical chunk bytes (compact, like the zone files)."""
    return json.dumps(doc, separators=(",", ":")).encode()

# Download retry policy (1.7.x): network-class errors (connection
# reset, timeout, DNS ...) get up to this many attempts per file,
# each on its own fresh connection (the github_sync fetch_file
# contract creates one per call when conn is None). A file that
# still fails is reported BY NAME with GitHub's own error text;
# HTTP answers (401/403/404) are never retried — re-asking cannot
# change them.
DOWNLOAD_ATTEMPTS = 3


def _fetch_with_retries(fetch_file, path):
    """fetch_file(REPO, path) with the retry policy above.

    Returns (raw_bytes, None) or (None, "<path>: <reason>").
    """
    err = None
    for _attempt in range(DOWNLOAD_ATTEMPTS):
        raw, err = fetch_file(REPO, path)
        if raw is not None:
            return raw, None
        if not (err or "").startswith("Network error:"):
            break
    return None, f"{path}: {err}"


def _fetch_progress(fetch_file, fetch_file_progress, path, progress):
    """One file, with download progress when a progress-capable
    fetch was supplied. progress(done_bytes, total_bytes, path)."""
    if progress is not None and fetch_file_progress is not None:
        def cb(done, total, _path=path):
            progress(done, total, _path)
        raw, err = fetch_file_progress(REPO, path, progress=cb)
        if raw is not None:
            return raw, None
        return None, f"{path}: {err}"
    return _fetch_with_retries(fetch_file, path)


class ZoneDataError(Exception):
    """Any zone-data problem the user must hear about verbatim."""


# Editor placement types -> (game type code, detail osm_type).
# Mirrors the game's taxonomy: 0 residential/generic, 1 commercial,
# 2 multi-unit/institutional, 3 other/special.
EDITOR_TYPE_MAP = {
    "House": (0, "house"),
    "Commercial": (1, "commercial"),
    "Apartment": (2, "apartments"),
    "Church": (2, "church"),
    "School": (2, "school"),
    "Restaurant": (1, "restaurant"),
    "Store": (1, "retail"),
    "Warehouse": (1, "warehouse"),
}

CODE_LABELS = {
    0: "Residential / generic",
    1: "Commercial",
    2: "Multi-unit / institutional",
    3: "Other / special",
}

# ---------------------------------------------------------------------------
# Pure geometry helpers (unit-tested by the harness)
# ---------------------------------------------------------------------------

def rectangle_ring(x, z, w, d):
    """The axis-aligned footprint ring for a box centred at (x, z)."""
    hw, hd = w / 2.0, d / 2.0
    return [[x - hw, z - hd], [x + hw, z - hd],
            [x + hw, z + hd], [x - hw, z + hd]]


def ring_orientation_deg(ring):
    """A footprint ring's orientation in degrees, in [0, 180):
    the direction of the ring's longest edge, measured in the
    x/z plane (atan2 of the edge's dz over dx, folded mod 180).

    2.0.6 (Joshua): this is the number the editor's Rotation
    field shows and the rotate drag turns. For a rectangular
    footprint it is the direction of its long sides; an
    axis-aligned rectangle_ring reads 0. A rectangle has no
    head/tail, so orientation is naturally mod 180."""
    best = None
    n = len(ring or [])
    for i in range(n):
        a = ring[i]
        b = ring[(i + 1) % n]
        dx, dz = b[0] - a[0], b[1] - a[1]
        length2 = dx * dx + dz * dz
        if length2 <= 0:
            continue
        if best is None or length2 > best[0]:
            best = (length2, dx, dz)
    if best is None:
        return 0.0
    ang = math.degrees(math.atan2(best[2], best[1])) % 180.0
    return ang


def ring_centroid(ring):
    """Mean of the ring's distinct vertices (centre of the footprint).

    Carried verbatim from 1.7.1: the closing vertex (first == last)
    is dropped before averaging — counting it twice skews the centre
    toward that corner by enough to break the flagged matcher's
    1-unit tolerance (caught by the harness, 2026-10-17)."""
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    if not pts:
        return (0.0, 0.0)
    return (sum(p[0] for p in pts) / len(pts),
            sum(p[1] for p in pts) / len(pts))


def ring_area_centroid(ring):
    """The ring's TRUE (area-weighted, shoelace) centroid — the
    centre the conversion stored in the flagged list's entries.

    2.0.0 matcher fix: 1.7.x matched flagged entries against
    ring_centroid (the vertex MEAN). On a rectangular ring the two
    centres coincide, but on an irregular ring they drift apart —
    Elizabeth Baptist Church: 4.57 units — far past the matcher's
    1.0 tolerance, so the lock silently failed for 1,122 of the
    1,532 flagged buildings (73%), including the church itself
    (diagnosis measured an area-centroid match at 1,532/1,532,
    worst distance 0.0071 units). Falls back to the vertex mean
    for degenerate (zero-area) rings.
    """
    pts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    if len(pts) < 3:
        return ring_centroid(ring)
    a2 = cx = cz = 0.0
    n = len(pts)
    for i in range(n):
        x1, z1 = pts[i]
        x2, z2 = pts[(i + 1) % n]
        cross = x1 * z2 - x2 * z1
        a2 += cross
        cx += (x1 + x2) * cross
        cz += (z1 + z2) * cross
    if abs(a2) < 1e-9:
        return ring_centroid(ring)
    return (cx / (3.0 * a2), cz / (3.0 * a2))


def _point_in_polygon(x, z, ring):
    """Ray-cast point-in-polygon over a [[x, z], ...] ring."""
    inside = False
    n = len(ring)
    for i in range(n):
        x1, z1 = ring[i]
        x2, z2 = ring[(i + 1) % n]
        if (z1 > z) != (z2 > z):
            xin = x1 + (z - z1) * (x2 - x1) / (z2 - z1)
            if x < xin:
                inside = not inside
    return inside


def _point_segment_distance(px, pz, ax, az, bx, bz):
    """Distance from point P to segment AB."""
    vx, vz = bx - ax, bz - az
    len2 = vx * vx + vz * vz
    t = 0.0 if len2 == 0 else max(
        0.0, min(1.0, ((px - ax) * vx + (pz - az) * vz) / len2))
    dx = px - (ax + vx * t)
    dz = pz - (az + vz * t)
    return (dx * dx + dz * dz) ** 0.5


# Road widths by class, as the game assigns them at load
# (index.html ROAD_WIDTHS); zone roads.json records carry no width
# of their own. Used only for distance CONTEXT (front derivation,
# backdrop) — never written back.
ROAD_WIDTHS = {"highway": 22.0, "major_artery": 20.0,
               "minor_artery": 18.4, "local": 7.2, "interstate": 34.0}


def _iter_road_segments(roads):
    """Yield (name, ax, az, bx, bz, halfwidth) for every segment of
    every road record in a parsed zone roads dict."""
    if not roads:
        return
    for cat, records in roads.items():
        hw = ROAD_WIDTHS.get(cat, 7.2) / 2.0
        for rec in records or []:
            pts = rec.get("pts") or []
            name = rec.get("name") or ""
            for i in range(len(pts) - 1):
                yield (name, pts[i][0], pts[i][1],
                       pts[i + 1][0], pts[i + 1][1], hw)


def _segment_index(roads):
    """Flat segment table for nearest-road queries: one tuple
    (name, ax, az, bx, bz, minx, minz, maxx, maxz) per road
    segment, materialised ONCE per query set.

    1.7.3 — the Elizabeth Baptist Church freeze (Joshua's live
    report, 2026-10-17): building_front used to re-walk every
    road record and run the exact distance test on every one of
    the zone's segments for EVERY footprint edge — 43 edges x
    78,750 adamsville segments = 3.4M pure-Python distance
    tests, ~4.2 s on the build VM for that one church and a
    dead, "not responding" window for tens of seconds on
    Joshua's laptop, on every selection and every refresh. The
    table is built once per building shown; _nearest_in_index
    then exact-tests only the handful of segments whose
    bounding box reaches the search window."""
    out = []
    if not roads:
        return out
    for cat, records in roads.items():
        for rec in records or []:
            pts = rec.get("pts") or []
            name = rec.get("name") or ""
            for i in range(len(pts) - 1):
                ax, az = pts[i][0], pts[i][1]
                bx, bz = pts[i + 1][0], pts[i + 1][1]
                out.append((name, ax, az, bx, bz,
                            min(ax, bx), min(az, bz),
                            max(ax, bx), max(az, bz)))
    return out


def _nearest_in_index(index, x, z):
    """(distance, name) of the nearest segment CENTRELINE to
    (x, z) over a _segment_index table; (inf, "") when the table
    is empty. EXACTLY the old full scan's result, found faster:
    a segment can only be nearest if its bounding box reaches
    a square window around the point, so each pass exact-tests
    just those segments; the window starts at 60 u (the same
    margin the inspector's backdrop uses) and doubles until
    the best distance found fits inside it — at that point
    every untested segment is provably farther away (any point
    outside the square is more than the half-side from the
    centre). Candidates are tested in table order with the
    same strict < as the old scan, so ties resolve the same
    way they always did."""
    if not index:
        return float("inf"), ""
    radius = 60.0
    while True:
        x0, x1 = x - radius, x + radius
        z0, z1 = z - radius, z + radius
        best = float("inf")
        best_name = ""
        for name, ax, az, bx, bz, mnx, mnz, mxx, mxz in index:
            if mxx < x0 or mnx > x1 or mxz < z0 or mnz > z1:
                continue
            d = _point_segment_distance(x, z, ax, az, bx, bz)
            if d < best:
                best = d
                best_name = name
        if best <= radius:
            return best, best_name
        radius *= 2.0  # nothing close enough yet — widen


def _nearest_road_distance(roads, x, z):
    """(distance, name) of the nearest road segment's CENTRELINE to
    (x, z) over a parsed roads dict; (inf, "") when there are no
    roads. Backs building_front's derivation. (1.7.3: routed
    through the segment index — same result, see _segment_index
    for the freeze this fixes.)"""
    return _nearest_in_index(_segment_index(roads), x, z)


def _edges_nearest(index, ring, edges):
    """[(distance, name)] — the nearest segment centreline to
    each edge's midpoint, over a _segment_index table.

    1.7.3: building_front's per-edge helper. Testing every edge
    against the whole table would still re-scan 78,750 bounding
    boxes per edge, so the candidate set is cut ONCE for the
    whole ring: only segments whose bounding box reaches the
    ring's bounding box grown by R can win any edge. R starts
    at 60 u and doubles until every edge's best distance over
    the candidates fits inside R — the same square argument
    as _nearest_in_index, applied ring-wide: a segment outside
    the grown box is more than R from every point of the ring,
    so once every best is <= R no outside segment can beat
    any edge's winner. Winners are then picked per edge with
    _nearest_in_index over the candidates (table order, strict
    < — ties resolve exactly as the old full scan)."""
    xs = [p[0] for p in ring]
    zs = [p[1] for p in ring]
    rx0, rx1 = min(xs), max(xs)
    rz0, rz1 = min(zs), max(zs)
    radius = 60.0
    while True:
        gx0, gx1 = rx0 - radius, rx1 + radius
        gz0, gz1 = rz0 - radius, rz1 + radius
        cand = [s for s in index
                if not (s[7] < gx0 or s[5] > gx1
                        or s[8] < gz0 or s[6] > gz1)]
        out = []
        fits = True
        for a, b in edges:
            d, name = _nearest_in_index(
                cand, (a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
            out.append((d, name))
            if d > radius:
                fits = False
        if fits:
            return out
        radius *= 2.0  # some edge's road is farther out — widen


def nearby_road_segments(zd, ring, margin=60.0):
    """[(name, pts)] for roads with any point within the ring's
    bounding box grown by `margin` — the inspector's backdrop.

    1.7.2: delegates to ZoneData.nearby_segments, which parses the
    zone's roads TRANSIENTLY and keeps only the matching segments —
    the parsed roads are not retained (the 1.7.1 backdrop kept
    ~69 MB of parsed roads in memory for all seven zones).
    """
    return zd.nearby_segments(ring, margin=margin)


def building_front(zd, index, flagged_entry=None, roads=None,
                   seg_index=None):
    """
    Derive a building's FRONT from the data (1.7.0, Joshua's
    design): the footprint edge whose midpoint is nearest a road
    segment's centreline is the front — that is the side the
    building presents to its street. When the building is flagged,
    the flagged entry already names the road it intersects; that
    road wins when one of the building's edges fronts it.

    `roads` (1.7.2): an optionally pre-parsed roads dict for this
    zone (see ZoneData.transient_roads) so a caller showing one
    building parses the zone's roads at most once per selection.

    `seg_index` (2.0.1): an optionally pre-built _segment_index
    table for `roads` (see ZoneData.roads_view). 2.0.0 rebuilt
    the table from all ~79k segments on EVERY selection — a
    measurable slice of the select freeze on a slow CPU; the
    caller that holds the zone's cached view passes it in and
    the derivation is then just the candidate walk. The result
    is identical either way (the exactness gate proves it).

    Returns {"ring", "edges", "front_edge", "front_road",
    "front_distance", "flagged_road"}: edges are (a, b) point
    pairs; front_edge indexes edges, or is None when no road data
    is available (the panel then falls back to a plain view — the
    front is never invented).
    """
    det = zd.details[index] if 0 <= index < len(zd.details) else {}
    ring = det.get("ring") or []
    out = {"ring": ring, "edges": [], "front_edge": None,
           "front_road": None, "front_distance": None,
           "flagged_road": None}
    if len(ring) < 2:
        return out
    edges = [(ring[i], ring[(i + 1) % len(ring)])
             for i in range(len(ring))]
    out["edges"] = edges
    if roads is None:
        roads = zd.transient_roads()
    if not roads:
        return out
    flagged_road = (flagged_entry or {}).get("nearestRoad") or None
    out["flagged_road"] = flagged_road
    # 1.7.3: one segment index + one ring-wide candidate cut
    # serves every edge of this ring (the per-edge full re-scan
    # was the church freeze — see _segment_index/_edges_nearest).
    # 2.0.1: reuse the caller's cached table when one is offered
    # instead of rebuilding it per selection.
    if seg_index is None:
        seg_index = _segment_index(roads)
    edge_nearest = _edges_nearest(seg_index, ring, edges)
    best_i, best_d, best_name = None, float("inf"), None
    flagged_best = None  # (distance, edge index) fronting flagged rd
    for i, (a, b) in enumerate(edges):
        d, name = edge_nearest[i]
        if d < best_d:
            best_i, best_d, best_name = i, d, name
        if flagged_road and name == flagged_road:
            if flagged_best is None or d < flagged_best[0]:
                flagged_best = (d, i)
    if flagged_best is not None:
        best_i, best_d = flagged_best[1], flagged_best[0]
        best_name = flagged_road
    out["front_edge"] = best_i
    out["front_distance"] = best_d if best_i is not None else None
    out["front_road"] = best_name
    return out


# ---------------------------------------------------------------------------
# The light index (1.7.2): browse/search/sort without the full zone
# ---------------------------------------------------------------------------

def build_index(zone, boxes, details, heroes, bounds, source_version):
    """Build the light-index document for one zone from its full
    data. Used by the committed generator script AND by the store
    after its own save (regenerating the pushed zone's index from
    the in-memory data, so the editor's list can never show its own
    edits stale).

    Entry keys are short on purpose (the whole point is a LIGHT
    file): n=name, t=detail osm_type, c=type code, x/z=centre,
    w/d/h=size. The index also carries the zone bounds (so places
    can be attributed to a zone before its detail loads) and the
    read-only hero list (a handful of entries).
    """
    entries = []
    for box, det in zip(boxes, details):
        entries.append({
            "n": det.get("name") or "",
            "t": det.get("osm_type") or "",
            "c": int(box[5]),
            "x": box[0], "z": box[1],
            "w": box[2], "d": box[3], "h": box[4],
        })
    return {
        "zone": zone,
        "sourceVersion": source_version,
        "count": len(entries),
        "bounds": bounds,
        "hero": [{"id": h.get("id"), "name": h.get("name"),
                  "address": h.get("address")} for h in heroes or []],
        "buildings": entries,
    }


def index_bytes(doc):
    """Canonical index bytes (compact, like the zone files)."""
    return json.dumps(doc, separators=(",", ":")).encode()


class BuildingIndex:
    """One zone's light index, as downloaded from GitHub."""

    def __init__(self, doc):
        self.zone = doc.get("zone") or ""
        self.source_version = doc.get("sourceVersion") or ""
        self.bounds = doc.get("bounds") or {}
        self.heroes = doc.get("hero") or []
        self.entries = doc.get("buildings") or []

    @classmethod
    def from_bytes(cls, raw):
        return cls(json.loads(raw.decode("utf-8")))

    def __len__(self):
        return len(self.entries)

    def contains(self, x, z):
        b = self.bounds
        return (b.get("xMin", 0) <= x <= b.get("xMax", 0)
                and b.get("zMin", 0) <= z <= b.get("zMax", 0))


# ---------------------------------------------------------------------------
# Flagged buildings: Joshua's locked list (downloaded from GitHub)
# ---------------------------------------------------------------------------

# Joshua's lock message, shown verbatim wherever a flagged
# building's lock is explained (panel + refusal errors).
FLAGGED_LOCK_MESSAGE = (
    "This building is FLAGGED: the conversion left it intersecting "
    "a road, and Joshua has flagged these buildings for his own "
    "decision. Flagged buildings cannot be moved, resized, "
    "rotated, scaled, or deleted in this version of the editor.")

# How close a building's ring centroid must sit to a flagged entry's
# centroid to count as the same building. 2.0.0: both sides are now
# AREA centroids (see ring_area_centroid), so the tolerance only has
# to cover conversion rounding — measured worst true distance
# across all 1,532 flagged buildings is 0.0071 units.
FLAG_MATCH_TOLERANCE = 1.0


class FlaggedIndex:
    """
    The flagged-buildings list, bucketed by rounded centroid for
    fast matching. Built from DOWNLOADED bytes (1.7.2: the list
    lives at editors/building-editor/flagged_buildings.json in the
    repo and is downloaded on open; nothing is bundled). An empty
    index matches nothing, and every load failure lands here as an
    empty index rather than an exception — a missing list must
    never stop the editor opening (the caller surfaces the failure
    in the status bar).
    """

    def __init__(self, zones=None):
        self._zones = zones or {}   # zone -> list of entry dicts
        self._buckets = {}          # (zone, gx, gz) -> [entry, ...]
        for zone, entries in self._zones.items():
            for e in entries:
                c = e.get("centroid") or [0, 0]
                key = (zone, round(c[0] / 10.0), round(c[1] / 10.0))
                self._buckets.setdefault(key, []).append(e)

    @classmethod
    def from_bytes(cls, raw):
        """Build from downloaded (or cached-download) bytes."""
        try:
            doc = json.loads(raw.decode("utf-8"))
            return cls(doc.get("zones") or {})
        except Exception:
            return cls()

    @classmethod
    def load(cls, path):
        """Build from a local file (a download CACHE, or a harness
        fixture). Never raises."""
        try:
            return cls.from_bytes(Path(path).read_bytes())
        except Exception:
            return cls()

    def match(self, zone, ring):
        """The flagged entry matching this ring's centroid, or
        None. The lock check — run against the building's REAL ring
        once its snapshot is open. 2.0.0: compares AREA centroids
        (ring_area_centroid) — the centre the flagged list stores.
        The 1.7.x vertex-mean comparison is the measured reason
        most flagged buildings were never locked."""
        if not ring:
            return None
        cx, cz = ring_area_centroid(ring)
        return self.match_point(zone, cx, cz)

    def match_point(self, zone, x, z):
        """The flagged entry whose centroid sits within tolerance
        of a point (1.7.2: the light index carries centres, not
        rings, so the list's FLAGGED marker is centre-based. The
        lock itself always re-checks with the real ring via match()
        once the zone detail is loaded)."""
        gx, gz = round(x / 10.0), round(z / 10.0)
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for e in self._buckets.get((zone, gx + dx, gz + dz),
                                           []):
                    ec = e.get("centroid") or [0, 0]
                    # Euclidean distance, exactly as 1.7.1's matcher.
                    if math.hypot(ec[0] - x, ec[1] - z) \
                            <= FLAG_MATCH_TOLERANCE:
                        return e
        return None

    def count(self, zone=None):
        """Flagged entries in one zone, or in all zones."""
        if zone is not None:
            return len(self._zones.get(zone, []))
        return sum(len(v) for v in self._zones.values())


# ---------------------------------------------------------------------------
# Gas stations: the review list + the editable-station overlay
# ---------------------------------------------------------------------------

class GasStationReview:
    """
    Joshua's gas-station review queue, downloaded on open from
    editors/building-editor/gas-station-review.json (1.7.2; through
    the staged 1.7.1 code the file was bundled — Joshua's rule now
    is that every list comes from GitHub).

    `stations` is the review queue: the 53 problem stations (left
    out by the round-2 rules, or moved more than 2 units), worst
    first. `all_stations` covers ALL 109 stations with each one's
    LIVE status under the game's current (old) placement gate —
    "placed" or "skipped" — which is what the 3D view's status
    label reads (Joshua, 2026-10-17: Marathon, Valero and Chevron
    must all read Skipped, including stations not in the queue).
    """

    def __init__(self, stations=None, counts=None, note="",
                 all_stations=None):
        self.stations = stations or []
        self.counts = counts or {}
        self.note = note or ""
        self.all_stations = all_stations or []
        self._by_index = {s.get("stationIndex"): s
                          for s in self.all_stations}

    @classmethod
    def from_bytes(cls, raw):
        """Build from downloaded bytes. Never raises: a bad file is
        an empty queue, and the caller says so in the status bar."""
        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception:
            return cls()
        return cls(stations=doc.get("stations") or [],
                   counts=doc.get("counts") or {},
                   note=doc.get("_note") or "",
                   all_stations=doc.get("allStations") or [])

    def live_status(self, station_index):
        """"placed" / "skipped" for any of the 109 stations under
        the game's current gate, or None when unknown."""
        s = self._by_index.get(station_index)
        return (s or {}).get("liveStatus")

    def station(self, station_index):
        """The all-stations record for an index, or None."""
        return self._by_index.get(station_index)


# The game's station cluster (traffic_system.js buildGasStation),
# in station-local units: +z is the approach/drive side (the side
# facing the nearest road). The editor renders these same parts as
# ONE editable object anchored at the station's mapped position.
# part: (label, kind, lx, lz, w, d, y0, y1) at the DEFAULT size;
# station_parts() scales them to a station's (w, d, h).
STATION_DEFAULT_W = 48.0    # pad width  (game: pad 48x38)
STATION_DEFAULT_D = 38.0    # pad depth
STATION_DEFAULT_H = 8.5     # the game's business record height
_STATION_PARTS = (
    ("Pad", "pad", 0.0, 0.0, 48.0, 38.0, 0.0, 0.3),
    ("Canopy", "canopy", 0.0, 0.0, 38.0, 24.0, 6.65, 7.75),
    ("Kiosk", "kiosk", 18.0, -14.0, 9.0, 7.0, 0.0, 3.6),
    ("Kiosk roof", "roof", 18.0, -14.0, 9.6, 7.6, 3.75, 4.15),
    ("Column", "column", -15.0, -9.0, 0.9, 0.9, 0.0, 7.2),
    ("Column", "column", 0.0, -9.0, 0.9, 0.9, 0.0, 7.2),
    ("Column", "column", 15.0, -9.0, 0.9, 0.9, 0.0, 7.2),
    ("Column", "column", -15.0, 9.0, 0.9, 0.9, 0.0, 7.2),
    ("Column", "column", 0.0, 9.0, 0.9, 0.9, 0.0, 7.2),
    ("Column", "column", 15.0, 9.0, 0.9, 0.9, 0.0, 7.2),
    ("Pump", "pump", -15.75, 0.0, 1.4, 0.9, 0.3, 1.8),
    ("Pump", "pump", -5.25, 0.0, 1.4, 0.9, 0.3, 1.8),
    ("Pump", "pump", 5.25, 0.0, 1.4, 0.9, 0.3, 1.8),
    ("Pump", "pump", 15.75, 0.0, 1.4, 0.9, 0.3, 1.8),
)


def station_parts(w=None, d=None, h=None):
    """The station cluster's parts at footprint (w, d) and height h
    (defaults: the game's own 48 x 38 x 8.5). Offsets and sizes
    scale proportionally, so resizing a station in the editor keeps
    the cluster's layout — the same shape the game builds, at the
    size Joshua sets."""
    w = STATION_DEFAULT_W if w is None else float(w)
    d = STATION_DEFAULT_D if d is None else float(d)
    h = STATION_DEFAULT_H if h is None else float(h)
    sx, sz, sy = (w / STATION_DEFAULT_W, d / STATION_DEFAULT_D,
                  h / STATION_DEFAULT_H)
    parts = []
    for label, kind, lx, lz, pw, pd, y0, y1 in _STATION_PARTS:
        parts.append({
            "label": label, "kind": kind,
            "lx": lx * sx, "lz": lz * sz,
            "w": pw * sx, "d": pd * sz,
            "y0": y0 * sy, "y1": y1 * sy,
        })
    return parts


def station_anchor(station, edit):
    """A station's editor position: its real (game) position plus
    the overlay's offset. `station` is an all-stations or review
    record; `edit` its station-edits entry (or None)."""
    pos = station.get("realPosition") or [0, 0]
    dx = (edit or {}).get("dx") or 0.0
    dz = (edit or {}).get("dz") or 0.0
    return (pos[0] + dx, pos[1] + dz)


class StationEdits:
    """
    The editable-station overlay (Joshua, 2026-10-17): stations
    Joshua flips to "editable" in the review tab get their edits
    here — position offset from the real spot, footprint/height
    overrides, and the WALKABLE flag — keyed by stationIndex (the
    station's stable identity in the game's station file). The
    overlay lives at editors/building-editor/station-edits.json in
    the repo, is downloaded on open, layers over the game's station
    data, and saves by the same round-trip rule as everything else.
    The game's own station file is NEVER edited by the editor.
    """

    def __init__(self, edits=None):
        self.edits = edits or {}    # str(stationIndex) -> dict
        self.dirty = False

    @classmethod
    def from_bytes(cls, raw):
        try:
            doc = json.loads(raw.decode("utf-8"))
            return cls(doc.get("stations") or {})
        except Exception:
            return cls()

    def get(self, station_index):
        """The edit dict for a station, or an empty dict."""
        return self.edits.get(str(station_index)) or {}

    def is_editable(self, station_index):
        return bool(self.get(station_index).get("editable"))

    def set_edit(self, station_index, **fields):
        """Update fields of a station's edit; marks the overlay
        dirty. Only known fields are kept, so the file stays clean."""
        key = str(station_index)
        cur = dict(self.edits.get(key) or {})
        for k in ("editable", "walkable", "dx", "dz", "w", "d", "h"):
            if k in fields:
                cur[k] = fields[k]
        self.edits[key] = cur
        self.dirty = True
        return cur

    def payload_bytes(self):
        doc = {"version": 1,
               "updatedBy": f"building-editor-{EDITOR_VERSION}",
               "stations": self.edits}
        return json.dumps(doc, indent=1).encode()

    def round_trip_save(self, cache_dir, open_connection,
                        push_targets, fetch_file):
        """
        The standing save rule for this one file: save locally ->
        push on one connection -> CLOSE it -> re-download on a
        FRESH connection -> adopt the downloaded proof copy.
        Returns (ok, message, proof_bytes_or_None) with the same
        stage-accurate message shapes as GameStore.round_trip_save.
        """
        cache_dir = Path(cache_dir)
        payload = self.payload_bytes()
        # Stage 1: local save (nothing counts until this exists).
        try:
            cache_dir.mkdir(parents=True, exist_ok=True)
            (cache_dir / "station-edits.json").write_bytes(payload)
        except Exception as e:
            return False, f"local-save-failed: {e}", None
        # Stage 2: push, on one dedicated connection, always closed.
        conn = open_connection()
        try:
            ok, msg = push_targets(
                [(REPO, STATION_EDITS_REPO_PATH, payload,
                  f"Building Editor {EDITOR_VERSION}: station edits")],
                conn=conn)
        finally:
            try:
                conn.close()
            except Exception:
                pass
        if not ok:
            return False, f"Push to GitHub failed: {msg}", None
        # Stage 3: proof download on a FRESH connection; the view
        # adopts the downloaded bytes, never the pushed ones.
        raw, err = _fetch_with_retries(fetch_file,
                                       STATION_EDITS_REPO_PATH)
        if raw is None:
            return False, (
                "push reached GitHub but downloading the proof copy "
                f"back failed: {err} — your save DID reach GitHub"), None
        # 2.0.0 byte-proof law: the proof copy must be the very
        # bytes that were pushed — anything else means the save
        # cannot honestly be called verified.
        if raw != payload:
            return False, (
                "the station-edits copy that came back from GitHub "
                "is not the file that was just sent — the save is "
                "NOT verified. Your edits are still on this "
                "computer; save again."), None
        proof = StationEdits.from_bytes(raw)
        self.edits = proof.edits
        self.dirty = False
        return True, "Station edits saved and verified.", raw


def zone_repo_path(zone, fname):
    """Repo path of one of a zone's game files."""
    return f"{ZONE_DIR.format(zone=zone)}/{fname}"


# Public alias (the bake and older callers use the un-underscored
# name; the helper above is the same function).
point_in_polygon = _point_in_polygon


# ---------------------------------------------------------------------------
# Detail records, lazily (2.0.0 snapshot model)
# ---------------------------------------------------------------------------

class DetailList:
    """
    A read facade over one zone's detail records that behaves like
    the list it replaces — len(), [i], iteration — but fetches
    records CHUNK BY CHUNK (see DETAIL_CHUNK_DIR) only when they
    are actually touched: opening one building downloads its cell's
    chunk (~50–400 KB), never the zone's whole detail file
    (1.7–10.7 MB). Fetched chunks are kept in a small LRU
    (CHUNK_CACHE_MAX) so neighbouring buildings — the snapshot's
    context — usually ride in chunks already fetched.

    This facade NEVER writes: the first edit to a zone materialises
    the full list (ZoneData.materialize_details) and the facade is
    replaced by the real list, so every write path works on plain
    data exactly as before.
    """

    def __init__(self, zd):
        self._zd = zd
        self._chunks = {}          # cell -> {"<index>": record}
        self._lru = []             # cells, least-recent first

    def __len__(self):
        return len(self._zd.boxes)

    def _chunk(self, cell):
        """The parsed records dict of one cell ({} when the chunk
        file does not exist — a cell with no buildings in it)."""
        if cell in self._chunks:
            self._lru.remove(cell)
            self._lru.append(cell)
            return self._chunks[cell]
        raw = self._zd.fetch_chunk_raw(cell)
        records = {}
        if raw is not None:
            try:
                doc = json.loads(raw.decode("utf-8"))
                records = doc.get("records") or {}
            except Exception as e:
                raise ZoneDataError(
                    f"Zone {self._zd.zone}: detail chunk "
                    f"{cell[0]}_{cell[1]} is not readable ({e}).")
        self._chunks[cell] = records
        self._lru.append(cell)
        while len(self._lru) > CHUNK_CACHE_MAX:
            old = self._lru.pop(0)
            self._chunks.pop(old, None)
        return records

    def __getitem__(self, i):
        if isinstance(i, slice):
            return [self[j] for j in range(*i.indices(len(self)))]
        n = len(self)
        if i < 0:
            i += n
        if i < 0 or i >= n:
            raise IndexError(i)
        box = self._zd.boxes[i]
        rec = self._chunk(detail_cell(box[0], box[1])).get(str(i))
        if rec is None:
            # Loud, never silent (Joshua's failure philosophy): a
            # building whose record cannot be found is a data
            # problem he must hear about, not an empty view.
            raise ZoneDataError(
                f"Zone {self._zd.zone}: building {i}'s detail "
                f"record is missing from its detail chunk — the "
                f"chunk files are out of step with buildings.json. "
                f"Regenerate them with generate_detail_chunks.py.")
        return rec

    def __iter__(self):
        return (self[j] for j in range(len(self)))

    def __contains__(self, item):
        return any(self[j] == item for j in range(len(self)))


# ---------------------------------------------------------------------------
# One zone's full data (loaded ON DEMAND, 1.7.2)
# ---------------------------------------------------------------------------

class ZoneData:
    """
    One zone's data, held at SNAPSHOT weight (2.0.0).

    boxes:   [[x, z, w, d, h, type], ...] — the zone's SPINE, from
             buildings.json. Always fully held once the zone is
             opened: it is small, and every snapshot needs the
             centres (neighbourhood, chunk addressing).
    details: the detail records, index-aligned with boxes — but as
             a DetailList facade: records are fetched chunk by
             chunk as snapshots touch them. The FIRST EDIT to the
             zone materialises the real list (materialize_details)
             and the facade is replaced by it.
    hero:    parsed hero_buildings.json dict, or None if the zone
             has none (only adamsville ships one today). READ-ONLY:
             listed, never modified.
    zone_meta: parsed zone.json (bounds decide zone attribution).
    roads_raw: the zone's roads.json BYTES, fetched lazily on the
             first snapshot and kept. The parsed roads of a zone
             run to ~10 MB; 2.0.0 parsed them TRANSIENTLY per
             selection and dropped the parse — 2.0.1 keeps ONE
             zone's parsed view (roads_view: parsed doc + segment
             index) cached instead, because the per-selection
             re-parse was half the select freeze. Only the
             segments near a shown building are ever RETAINED by
             callers (nearby_segments' result).
    dirty:   True once any placement/edit/delete touched this zone.
    bytes_fetched: detail/roads bytes this zone has downloaded in
             this session (the snapshot weight accounting the
             window can show; chunk + roads bytes only — the spine
             is counted by the loader that fetched it).
    """

    def __init__(self, zone):
        self.zone = zone
        self.version = ""
        self.boxes = []
        self.details = DetailList(self)
        self.hero = None
        self.zone_meta = None
        self.roads_raw = None
        self.dirty = False
        # Set by GameStore when the zone enters the store: the
        # transport the lazy fetches (chunks, roads, materialise)
        # go through. A ZoneData with no store can still be built
        # whole from files (load) — the harness and the chunk
        # generator do that — but it cannot fetch anything.
        self.store = None
        self.bytes_fetched = 0
        # 2.0.1: the CACHED roads view — (roads_raw identity,
        # parsed roads, segment index) built once per roads bytes
        # by roads_view(). 2.0.0 re-parsed the zone's roads.json
        # (~2.4 MB) and rebuilt the ~79k-segment index on EVERY
        # selection, on the UI thread; that per-click CPU cost is
        # half of the 2.0.1 freeze fix (the other half is doing
        # the work off the UI thread — see GameStore.
        # prepare_snapshot). The lock keeps two snapshot workers
        # from building the same view twice at once.
        self._roads_view = None
        self._roads_view_lock = threading.Lock()
        self._nearby_bboxes = None
        # Pristine copies taken at materialisation (the state
        # GitHub held when editing began): the save path diffs
        # against them to know which records — and which chunk
        # cells — a save must push and prove.
        self._pristine_boxes = None
        self._pristine_details = None
        self._deleted_any = False

    # -- loading ---------------------------------------------------------

    def load_spine(self, files):
        """
        Populate the SPINE from {filename: bytes}: buildings.json
        (boxes), zone.json, hero_buildings.json. NO detail file is
        read — details arrive per chunk through the DetailList
        facade. Returns self.
        """
        b = json.loads(files["buildings.json"])
        self.version = b.get("version", "")
        self.boxes = [list(row) for row in b.get("buildings", [])]
        self.details = DetailList(self)
        hero_raw = files.get("hero_buildings.json")
        self.hero = json.loads(hero_raw) if hero_raw else None
        meta_raw = files.get("zone.json")
        self.zone_meta = json.loads(meta_raw) if meta_raw else None
        self.roads_raw = files.get("roads.json")
        self.dirty = False
        return self

    def load(self, files):
        """
        Populate WHOLE from {filename: bytes} including
        buildings_detail.json (which materialises the detail list
        at once). The 1.7.x entry point, kept for the harness
        fixtures and the chunk generator, which legitimately work
        on complete local data. Raises ZoneDataError if the
        box/detail pair is misaligned — a misaligned pair must
        never be edited or re-pushed.
        """
        self.load_spine(files)
        raw = files.get("buildings_detail.json")
        if raw is not None:
            details = json.loads(raw)
            if len(self.boxes) != len(details):
                raise ZoneDataError(
                    f"Zone {self.zone}: buildings.json has "
                    f"{len(self.boxes)} buildings but "
                    f"buildings_detail.json has {len(details)} — "
                    f"refusing to edit a misaligned pair.")
            self.details = details
        return self

    @property
    def materialized(self):
        """True when the full detail list is in memory (the zone
        is in edit mode, or was loaded whole with load())."""
        return isinstance(self.details, list)

    def refresh_buildings(self, files):
        """Replace ONLY the building pair with re-downloaded proof
        bytes (after a successful round trip); hero/zone/roads are
        untouched. 2.0.0: the details return to the lazy facade —
        the proof chunks were pushed in the same round, so the
        next snapshot re-reads exactly what GitHub now holds.
        Dirty cleared; pristine copies dropped."""
        b = json.loads(files["buildings.json"])
        details = json.loads(files["buildings_detail.json"])
        boxes = [list(row) for row in b.get("buildings", [])]
        if len(boxes) != len(details):
            raise ZoneDataError(
                f"Zone {self.zone}: proof copy is misaligned "
                f"({len(boxes)} boxes vs {len(details)} details).")
        self.version = b.get("version", "")
        self.boxes = boxes
        self.details = DetailList(self)
        self._pristine_boxes = None
        self._pristine_details = None
        self._deleted_any = False
        self.dirty = False

    # -- lazy fetches (through the owning store's transport) --------------

    def _require_store(self, what):
        if self.store is None:
            raise ZoneDataError(
                f"Zone {self.zone}: cannot {what} — this zone was "
                f"loaded without a download connection.")
        return self.store

    def fetch_chunk_raw(self, cell):
        """Raw bytes of one detail chunk, or None when the chunk
        file does not exist (404 = a cell with no buildings).
        Counted in bytes_fetched. Network-class failures raise
        ZoneDataError — a snapshot must fail loudly, not empty."""
        store = self._require_store("fetch detail chunks")
        path = detail_chunk_path(self.zone, cell)
        raw, err = store.fetch_chunk(self.zone, cell)
        if raw is None:
            if err and "404" in err:
                return None
            raise ZoneDataError(f"{path}: {err}")
        self.bytes_fetched += len(raw)
        return raw

    def ensure_roads(self):
        """Fetch the zone's roads.json bytes if not held (the
        first snapshot in a zone pays it once; the bytes stay for
        transient parses)."""
        if self.roads_raw is not None:
            return None
        store = self._require_store("fetch roads")
        path = zone_repo_path(self.zone, "roads.json")
        raw, err = store.fetch_zone_file(self.zone, "roads.json")
        if raw is None:
            return err
        self.roads_raw = raw
        self.bytes_fetched += len(raw)
        return None

    def materialize_details(self):
        """
        Assemble the zone's FULL detail list from its chunk files
        — the moment a VIEWED zone becomes an EDITED zone. Takes
        the pristine copies the save path diffs against. Returns
        an error string or None. Already-materialised zones (and
        whole-loaded ones) return at once.
        """
        if self.materialized:
            return None
        store = self._require_store("load building details")
        cells = sorted({detail_cell(b[0], b[1]) for b in self.boxes})
        full = [None] * len(self.boxes)
        for cell in cells:
            raw = self.fetch_chunk_raw(cell)
            if raw is None:
                continue
            try:
                records = json.loads(
                    raw.decode("utf-8")).get("records") or {}
            except Exception as e:
                return (f"{detail_chunk_path(self.zone, cell)}: "
                        f"{e}")
            for key, rec in records.items():
                try:
                    i = int(key)
                except (TypeError, ValueError):
                    continue
                if 0 <= i < len(full):
                    full[i] = rec
        missing = [i for i, rec in enumerate(full) if rec is None]
        if missing:
            return (f"Zone {self.zone}: {len(missing)} building "
                    f"detail records are missing from the detail "
                    f"chunks (first: {missing[0]}) — the chunk "
                    f"files are out of step with buildings.json. "
                    f"Regenerate them with "
                    f"generate_detail_chunks.py.")
        import copy as _copy
        self._pristine_boxes = [list(b) for b in self.boxes]
        self._pristine_details = _copy.deepcopy(full)
        self.details = full
        return None

    # -- the snapshot ------------------------------------------------------

    def neighbours_within(self, index, radius=SNAPSHOT_RADIUS):
        """
        The snapshot's context buildings: every OTHER building
        whose centre sits within `radius` of building `index`'s
        centre, as [{"index", "box", "ring", "height_m"}] with the
        records fetched through the lazy facade (only the chunks
        the neighbourhood touches are downloaded). Read-only
        context — the editor never edits through this list.
        """
        if not (0 <= index < len(self.boxes)):
            return []
        cx, cz = self.boxes[index][0], self.boxes[index][1]
        r2 = radius * radius
        out = []
        for j, box in enumerate(self.boxes):
            if j == index:
                continue
            dx, dz = box[0] - cx, box[1] - cz
            if dx * dx + dz * dz <= r2:
                det = self.details[j]
                out.append({"index": j, "box": box,
                            "ring": det.get("ring") or [],
                            "height_m": det.get("height_m")
                            or box[4]})
        return out

    # -- roads (transient) ------------------------------------------------

    def transient_roads(self):
        """Parse this zone's roads for ONE use and return the dict
        (or None). The caller drops the result when done — nothing
        here retains the parse. 2.0.0: the raw bytes are fetched
        lazily on first use (ensure_roads); a fetch failure leaves
        roads_raw empty and this returns None — the callers treat
        "no roads" as "no backdrop / no front derivation" exactly
        as 1.7.x did, and ensure_roads' error is surfaced by the
        selection path before it gets here."""
        if not self.roads_raw:
            if self.store is not None:
                self.ensure_roads()
            if not self.roads_raw:
                return None
        try:
            return json.loads(self.roads_raw)
        except Exception:
            return None

    def roads_view(self):
        """(parsed roads, segment index) for this zone — parsed
        ONCE per roads bytes and then CACHED on the ZoneData
        (2.0.1, the select-freeze fix).

        2.0.0's transient_roads contract ("parse, use, drop")
        kept memory low but charged every single selection the
        full parse of roads.json plus a full rebuild of the
        segment index (~0.35 s on a fast desktop CPU, several
        seconds on Joshua's laptop — measured in the 2.0.1
        investigation). The view is keyed on the roads BYTES
        object, so a re-downloaded roads.json rebuilds it
        automatically, and the store keeps only ONE zone's view
        alive at a time (see GameStore._drop_roads_views) — the
        lightweight law still holds: at most one zone's parsed
        roads exist, for the zone actually being looked at.

        Returns (None, None) when the zone has no roads (not
        downloaded, fetch failed, or unparsable) — callers treat
        that as "no front derivation / no backdrop", exactly as
        they treated a transient parse of None."""
        raw = self.roads_raw
        view = self._roads_view
        if view is not None and raw is not None \
                and view[0] is raw:
            return view[1], view[2]
        with self._roads_view_lock:
            # Re-check under the lock: another snapshot worker
            # may have built the view while this one waited.
            view = self._roads_view
            if view is not None and self.roads_raw is not None \
                    and view[0] is self.roads_raw:
                return view[1], view[2]
            roads = self.transient_roads()
            index = _segment_index(roads) if roads else None
            if roads:
                # Cache only a SUCCESSFUL view: a failed roads
                # fetch must retry on the next selection, not be
                # remembered as "this zone has no roads".
                self._roads_view = (self.roads_raw, roads, index)
                if self.store is not None:
                    self.store._drop_roads_views(
                        except_zone=self.zone)
            return roads, index

    def _record_bboxes(self, roads):
        """Per-record bounding boxes for a parsed roads dict,
        cached on the roads OBJECT identity (2.0.8, the speed
        pass). nearby_segments used to walk every point of every
        record in the zone on every call (~113k points for
        adamsville) just to keep the handful near one building;
        the bbox prefilter below rejects almost every record with
        four number compares, and only bbox hits pay the original
        per-point test — so the RESULT is identical, only the
        cost changes. The cache keeps a reference to the roads
        dict itself, so the identity check can never alias a
        different dict that reused a freed address."""
        cached = self._nearby_bboxes
        if cached is not None and cached[0] is roads:
            return cached[1]
        out = []
        for _cat, records in roads.items():
            for rec in records or []:
                pts = rec.get("pts") or []
                if not pts:
                    continue
                xs = [p[0] for p in pts]
                zs = [p[1] for p in pts]
                out.append((min(xs), min(zs), max(xs), max(zs),
                            rec.get("name") or "", pts))
        self._nearby_bboxes = (roads, out)
        return out

    def nearby_segments(self, ring, margin=60.0, roads=None):
        """[(name, pts)] for roads with any point within the ring's
        bounding box grown by `margin` — the inspector's backdrop.
        Parses the zone's roads transiently unless a parsed dict is
        supplied; only the matching segments are returned (and are
        all the caller keeps).

        2.0.8: the scan runs over cached per-record bounding
        boxes first (see _record_bboxes); records whose bbox
        misses the query box provably have no point inside it,
        and bbox hits still pass the exact per-point test, so
        the returned list is unchanged."""
        if not ring:
            return []
        xs = [p[0] for p in ring]
        zs = [p[1] for p in ring]
        x0, x1 = min(xs) - margin, max(xs) + margin
        z0, z1 = min(zs) - margin, max(zs) + margin
        if roads is None:
            roads = self.transient_roads()
        out = []
        if not roads:
            return out
        for bx0, bz0, bx1, bz1, name, pts in \
                self._record_bboxes(roads):
            if bx1 < x0 or bx0 > x1 or bz1 < z0 or bz0 > z1:
                continue
            if any(x0 <= p[0] <= x1 and z0 <= p[1] <= z1
                   for p in pts):
                out.append((name, pts))
        return out

    # -- zone attribution -------------------------------------------------

    def contains(self, x, z):
        """True when (x, z) is inside this zone's zone.json bounds."""
        if not self.zone_meta:
            return False
        b = self.zone_meta.get("bounds") or {}
        return (b.get("xMin", 0) <= x <= b.get("xMax", 0)
                and b.get("zMin", 0) <= z <= b.get("zMax", 0))

    # -- flagged ----------------------------------------------------------

    def is_flagged(self, index, flagged):
        """True when building `index` matches the flagged index."""
        if index < 0 or index >= len(self.details):
            return False
        return flagged.match(self.zone,
                             self.details[index].get("ring") or []) \
            is not None

    def _refuse_if_flagged(self, index, flagged):
        """Raise the flagged-lock error when building `index` is flagged."""
        if flagged is not None and self.is_flagged(index, flagged):
            raise ZoneDataError(FLAGGED_LOCK_MESSAGE)

    # -- edits (box + detail always move together, index-aligned) ---------
    #
    # 2.0.0: every edit first MATERIALISES the zone's details (the
    # snapshot becomes an edit session). A materialisation failure
    # refuses the edit with the reason — an editor that cannot see
    # the whole aligned pair must not write half of it.

    def _materialize_or_refuse(self):
        err = self.materialize_details()
        if err:
            raise ZoneDataError(err)

    def place(self, x, z, w, d, h, editor_type, name=None):
        """
        Append a placed building: box [x, z, w, d, h, code] + detail
        {name, osm_type, height_m = h, rectangle ring, moved: 0}.
        Returns the new building's index. Marks the zone dirty.
        """
        if editor_type not in EDITOR_TYPE_MAP:
            raise ZoneDataError(f"Unknown building type: {editor_type}")
        self._materialize_or_refuse()
        code, osm_type = EDITOR_TYPE_MAP[editor_type]
        self.boxes.append([x, z, w, d, h, code])
        self.details.append({
            "name": name, "osm_type": osm_type, "height_m": h,
            "ring": rectangle_ring(x, z, w, d), "moved": 0})
        self.dirty = True
        return len(self.boxes) - 1

    def move(self, index, new_x, new_z, flagged=None):
        """Move a building: box centre and ring shift together."""
        self._refuse_if_flagged(index, flagged)
        self._materialize_or_refuse()
        box = self.boxes[index]
        dx, dz = new_x - box[0], new_z - box[1]
        box[0], box[1] = new_x, new_z
        det = self.details[index]
        det["ring"] = [[px + dx, pz + dz] for px, pz in det["ring"]]
        self.dirty = True

    def resize(self, index, w, d, h, flagged=None):
        """Resize a building: box dims + height_m, and the
        footprint ring SCALED per-axis about the box centre.

        2.0.7 SHAPE-PRESERVATION LAW (Joshua, hands-on bug): the
        2.0.6 resize REBUILT the ring as the box's axis-aligned
        rectangle — resizing an articulated footprint (a church
        or school whose walls jut out and back) DELETED the
        articulation and straightened the walls. That path is
        gone. A size edit now scales the existing ring's points:
        x by w_new/w_old, z by d_new/d_old, about the centre —
        the point sequence and the in/out jut pattern are
        preserved, only scaled. A height-only edit (w/d
        unchanged) leaves the ring point-for-point identical.
        One-sided anchoring is the caller's composition:
        resize FIRST (this scale about the standing centre),
        move SECOND (a rigid translation by the centre shift)
        — the composition lands the un-dragged wall exactly
        where it stood, for a ring of any shape."""
        self._refuse_if_flagged(index, flagged)
        self._materialize_or_refuse()
        box = self.boxes[index]
        old_w, old_d = box[2], box[3]
        box[2], box[3], box[4] = w, d, h
        det = self.details[index]
        det["height_m"] = h
        ring = det.get("ring") or []
        if len(ring) >= 2 and old_w > 0 and old_d > 0:
            sx, sz = w / old_w, d / old_d
            if sx != 1.0 or sz != 1.0:
                cx, cz = box[0], box[1]
                det["ring"] = [
                    [cx + (px - cx) * sx, cz + (pz - cz) * sz]
                    for px, pz in ring]
        self.dirty = True

    def scale(self, index, factor, anchor_x, anchor_z, flagged=None):
        """Scale a WHOLE building by `factor` about a fixed
        ground anchor (2.0.7, Joshua: Ctrl+drag on a corner —
        the grabbed corner follows the mouse, the OPPOSITE
        corner is the anchor and does not move).

        The footprint ring scales uniformly about the anchor
        (shape preserved — points scale, never rebuilt), the
        box centre moves along the anchor line by the same
        factor, width/depth/height all scale by the factor,
        and height_m follows. Isolated in this one method so
        the gesture can be retired on Joshua's word without
        touching move/resize/rotate."""
        self._refuse_if_flagged(index, flagged)
        self._materialize_or_refuse()
        if factor <= 0:
            raise ZoneDataError("A scale factor must be positive.")
        box = self.boxes[index]
        box[0] = anchor_x + (box[0] - anchor_x) * factor
        box[1] = anchor_z + (box[1] - anchor_z) * factor
        box[2] = box[2] * factor
        box[3] = box[3] * factor
        box[4] = box[4] * factor
        det = self.details[index]
        det["height_m"] = box[4]
        ring = det.get("ring") or []
        if len(ring) >= 2:
            det["ring"] = [
                [anchor_x + (px - anchor_x) * factor,
                 anchor_z + (pz - anchor_z) * factor]
                for px, pz in ring]
        self.dirty = True

    def rotate(self, index, delta_deg, flagged=None):
        """Rotate a building's footprint by `delta_deg` around
        its own centre (2.0.6; the gesture is Shift+drag on a
        corner since 2.0.7, Joshua's model).

        HOW ROTATION IS STORED: a zone building's record pair
        has no angle field — the footprint IS the detail record's
        ring, and the box is the summary the game consumes. So a
        rotation BAKES, like every editor transform: the ring
        turns rigidly about the box centre, and the box becomes
        the rotated footprint's bounding summary — centre
        unchanged (rotation never translates a building), width
        and depth grown symmetrically so the box still contains
        the whole footprint; height and type untouched. The pair
        saves through the same manifest-safe path as move/resize
        (buildings.json + buildings_detail.json + the detail
        chunks + the regenerated light index).

        GAME LIMIT (stated plainly): the game places mass
        buildings from the box and derives each building's facing
        yaw from the roads at runtime — it reads no per-building
        angle from the zone data. A rotation is therefore exact
        in the editor's footprint record and views, while in the
        game it takes effect through the new bounding box; the
        game keeps facing the building to its street."""
        self._refuse_if_flagged(index, flagged)
        self._materialize_or_refuse()
        box = self.boxes[index]
        det = self.details[index]
        ring = det.get("ring") or []
        if len(ring) < 2:
            raise ZoneDataError(
                "This building has no footprint to rotate.")
        cx, cz = box[0], box[1]
        th = math.radians(delta_deg)
        ca, sa = math.cos(th), math.sin(th)
        new_ring = []
        max_dx = 0.0
        max_dz = 0.0
        for px, pz in ring:
            dx, dz = px - cx, pz - cz
            rx, rz = cx + dx * ca - dz * sa, cz + dx * sa + dz * ca
            new_ring.append([rx, rz])
            max_dx = max(max_dx, abs(rx - cx))
            max_dz = max(max_dz, abs(rz - cz))
        det["ring"] = new_ring
        box[2] = 2.0 * max_dx
        box[3] = 2.0 * max_dz
        self.dirty = True

    def rotate_to(self, index, angle_deg, flagged=None):
        """Rotate a building so its footprint orientation reads
        `angle_deg` (see ring_orientation_deg): turns it by the
        shortest arc from where it sits now. Returns True when
        the building actually turned."""
        if index < 0 or index >= len(self.details):
            raise ZoneDataError("No such building.")
        cur = ring_orientation_deg(self.details[index].get("ring"))
        delta = (angle_deg - cur + 90.0) % 180.0 - 90.0
        if abs(delta) < 1e-9:
            return False
        self.rotate(index, delta, flagged=flagged)
        return True

    # -- the working copy (2.0.9, Joshua's cache + Apply model) --

    def working_copy(self, index):
        """A detached ONE-RECORD ZoneData holding deep copies of
        building `index`'s box + detail — the working copy the
        2.0.9 cache + Apply model edits against (Joshua, Oct 28:
        opening a building puts it and its surrounding area in a
        local cache; every adjustment mutates the cache only,
        with live preview; an explicit Apply sends the finished
        copy back in one save round trip).

        The copy is a real ZoneData, so every edit verb (move /
        resize / scale / rotate / rotate_to) runs on it at index
        0 with its math — shape preservation, rotation baking,
        the flagged lock (the caller passes the store's flagged
        index; the match is by ring, so it bites identically) —
        exactly as it would on the zone, while the zone's own
        records stay untouched until absorb_record. Its details
        are a plain list, so materialise is already satisfied
        and no store/fetch is ever needed to edit it."""
        if not (0 <= index < len(self.boxes)):
            raise ZoneDataError("No such building.")
        det = self.details[index]
        if not isinstance(det, dict):
            raise ZoneDataError(
                "This building's detail record could not be "
                "read — it cannot be edited.")
        work = ZoneData(self.zone)
        work.boxes = [list(self.boxes[index])]
        work.details = [copy.deepcopy(det)]
        return work

    def absorb_record(self, index, box, detail):
        """Commit a working copy back into this zone (2.0.9):
        the record pair is replaced with the working copy's
        finished box + detail and the zone is marked dirty —
        the caller's save round trip then sends it back and
        proves it, the standing suite way. Materialises the
        zone's details first (the save path diffs against the
        pristine copies materialisation takes), exactly as
        every other edit does."""
        self._materialize_or_refuse()
        if not (0 <= index < len(self.boxes)):
            raise ZoneDataError("No such building.")
        self.boxes[index] = list(box)
        self.details[index] = copy.deepcopy(detail)
        self.dirty = True

    def delete(self, index, flagged=None):
        """Delete a building: BOTH the box and its detail entry go.
        2.0.0: a delete SHIFTS the indexes of every later building,
        so the zone's whole chunk set is regenerated at save time
        (see chunk_cells_to_push)."""
        self._refuse_if_flagged(index, flagged)
        self._materialize_or_refuse()
        del self.boxes[index]
        del self.details[index]
        self._deleted_any = True
        self.dirty = True

    # -- hero buildings (read-only listing) --------------------------------

    def hero_list(self):
        """Hero buildings in this zone as [{id, name, address}] —
        listed in the editor; not editable (see class docs)."""
        if not self.hero:
            return []
        out = []
        for hb in self.hero.get("buildings", []):
            out.append({"id": hb.get("id"), "name": hb.get("name"),
                        "address": hb.get("address")})
        return out

    # -- serialisation -------------------------------------------------------

    def validate_alignment(self):
        """Box/detail index alignment + height agreement. Returns an
        error string, or None when the pair is safe to push."""
        if len(self.boxes) != len(self.details):
            return (f"Zone {self.zone}: {len(self.boxes)} boxes vs "
                    f"{len(self.details)} details — misaligned, "
                    f"refusing to push.")
        for i, (box, det) in enumerate(zip(self.boxes, self.details)):
            if abs(box[4] - det.get("height_m", box[4])) > 0.01:
                return (f"Zone {self.zone} building {i}: box height "
                        f"{box[4]} != detail height_m "
                        f"{det.get('height_m')} — refusing to push.")
        return None

    def new_version(self, today=None):
        """The version string for a save (see module docstring)."""
        d = today or _date.today()
        return (f"{d.year:04d}.{d.month:02d}.{d.day:02d}"
                f"-building-editor-{EDITOR_VERSION}-{self.zone}")

    def payloads(self, today=None):
        """
        The three files a dirty zone pushes, as {filename: bytes}:
        buildings.json (fresh version + realCount), the detail array,
        and the regenerated buildings.js twin. Requires the zone to
        be MATERIALISED (build_targets guarantees it) — serialising
        through the lazy facade would fetch every chunk silently,
        which is exactly the hidden whole-zone load 2.0.0 bans.
        """
        if not self.materialized:
            raise ZoneDataError(
                f"Zone {self.zone}: payloads requested before the "
                f"zone's details were loaded — refusing to build a "
                f"save out of a partial view.")
        version = self.new_version(today)
        buildings_doc = {"version": version,
                         "realCount": len(self.boxes),
                         "buildings": self.boxes}
        return {
            "buildings.json": json.dumps(
                buildings_doc, separators=(",", ":")).encode(),
            "buildings_detail.json": json.dumps(
                self.details, separators=(",", ":")).encode(),
            "buildings.js": buildings_js_bytes(
                self.zone, version, self.boxes),
        }

    def index_doc(self, today=None):
        """This zone's light index, regenerated from the in-memory
        data (1.7.2: pushed in the same round as a zone save, its
        sourceVersion matching the version the save stamps)."""
        bounds = (self.zone_meta or {}).get("bounds") or {}
        return build_index(self.zone, self.boxes, self.details,
                           self.hero_list(), bounds,
                           self.new_version(today))

    # -- save diffing (2.0.0: the write-back law, made measurable) --------

    def changed_indices(self):
        """
        The building indexes whose box or detail record differs
        from the pristine copies taken at materialisation (plus any
        appended indexes). Empty when pristine copies are missing
        (a whole-loaded zone) — callers treat that as "unknown",
        never as "nothing changed". A delete shifts indexes, so
        after one the honest answer is "everything from the first
        difference on" — the length check below catches it: when
        the counts differ, every index from the first mismatch to
        the end of the longer side counts as changed.
        """
        if self._pristine_details is None \
                or self._pristine_boxes is None:
            return None
        old_b, old_d = self._pristine_boxes, self._pristine_details
        changed = set()
        n = max(len(old_b), len(self.boxes))
        for i in range(n):
            ob = old_b[i] if i < len(old_b) else None
            nb = self.boxes[i] if i < len(self.boxes) else None
            od = old_d[i] if i < len(old_d) else None
            nd = self.details[i] if i < len(self.details) else None
            if ob != nb or od != nd:
                changed.add(i)
        return changed

    def chunk_cells_to_push(self):
        """
        The detail-chunk cells a save of this zone must regenerate
        and push (2.0.0): the cells of every CHANGED building —
        both its pristine cell and its current cell (a move across
        a boundary touches two). A delete (index shift) or missing
        pristine copies regenerate EVERY cell the zone has, on
        either side of the save. Only meaningful when materialised.
        """
        if self._deleted_any or self._pristine_boxes is None:
            cells = {detail_cell(b[0], b[1]) for b in self.boxes}
            if self._pristine_boxes:
                cells |= {detail_cell(b[0], b[1])
                          for b in self._pristine_boxes}
            return sorted(cells)
        cells = set()
        for i in self.changed_indices() or ():
            if i < len(self._pristine_boxes):
                pb = self._pristine_boxes[i]
                cells.add(detail_cell(pb[0], pb[1]))
            if i < len(self.boxes):
                nb = self.boxes[i]
                cells.add(detail_cell(nb[0], nb[1]))
        return sorted(cells)

    def chunk_payload(self, cell):
        """The regenerated chunk file bytes for one cell, from the
        materialised data (an emptied cell pushes an empty-records
        chunk — the file stays, its contents say what is)."""
        return chunk_bytes(build_chunk_doc(
            self.zone, cell, self.boxes, self.details))


def buildings_js_bytes(zone, version, boxes):
    """
    Regenerate the buildings.js twin in the converter's exact shape:
    a header comment, OSM_BLDG_VERSION, OSM_REAL_COUNT, then
    OSM_BUILDINGS as one compact JSON array (verified byte-shape
    against zones/adamsville/buildings.js).
    """
    zone_title = zone.capitalize()
    header = (f"/* ZONE BUILDINGS — {zone_title} ({zone}) — "
              f"regenerated by Adamsville Building Editor "
              f"{EDITOR_VERSION}; do not hand-edit. */\n")
    body = (f"var OSM_BLDG_VERSION = {json.dumps(version)};\n"
            f"var OSM_REAL_COUNT = {len(boxes)};\n"
            f"var OSM_BUILDINGS = "
            f"{json.dumps(boxes, separators=(',', ':'))};\n")
    return (header + body).encode()


# ---------------------------------------------------------------------------
# The whole game store: light indexes + on-demand zones + subdivisions
# ---------------------------------------------------------------------------

class GameStore:
    """
    indexes:      zone -> BuildingIndex (light; browsable at once)
    zones:        zone -> ZoneData (spine-loaded; details lazy —
                  see the ZoneData docstring)
    subdivisions: [{"name", "polygon": [[x, z], ...], "style"}] —
                  editor working data, persisted to
                  SUBDIVISIONS_REPO_PATH through the same round trip.
    flagged:      the downloaded FlaggedIndex.
    review:       the downloaded GasStationReview (or None).
    station_edits: the StationEdits overlay.
    """

    def __init__(self, flagged=None):
        self.zones = {}            # zone name -> ZoneData (spine-loaded)
        self.indexes = {}          # zone name -> BuildingIndex
        self.subdivisions = []
        self.subdivisions_dirty = False
        self.flagged = flagged if flagged is not None \
            else FlaggedIndex()
        self.review = None
        self.station_edits = StationEdits()
        self._load_order = []      # loaded zones, oldest first
        # The bound transport (2.0.0): the fetch callables the lazy
        # per-zone fetches (detail chunks, roads, materialisation)
        # go through. Bound by the window at startup and by every
        # ensure_* call, so a ZoneData always fetches the same way
        # its spine was fetched (through the suite shared cache in
        # the app; through the stub in the harness).
        self._fetch = None
        self._fetch_progress = None
        self._progress = None
        # 2.0.1: serialises snapshot preparation (chunk fetches +
        # roads work) across selection workers — the DetailList
        # facade's chunk LRU is not safe for two threads racing
        # the same cell, and serial prep is never the bottleneck
        # (a superseded worker's fetches still warm the caches).
        self._snapshot_lock = threading.Lock()

    def set_flagged(self, flagged):
        """Adopt the downloaded flagged index (1.7.2: the list is
        downloaded on open, after the store exists)."""
        self.flagged = flagged

    # -- the bound transport (2.0.0) --------------------------------------

    def bind_transport(self, fetch_file, fetch_file_progress=None,
                       progress=None):
        """Bind the fetch callables lazy zone loads use. The window
        binds its shared-cache fetcher once at startup; ensure_*
        calls rebind to whatever transport loaded them."""
        if fetch_file is not None:
            self._fetch = fetch_file
        if fetch_file_progress is not None:
            self._fetch_progress = fetch_file_progress
        if progress is not None:
            self._progress = progress

    def fetch_chunk(self, zone, cell):
        """(raw, err) for one detail chunk through the bound
        transport, with the standard retry policy."""
        if self._fetch is None:
            return None, "no download connection is bound"
        return _fetch_with_retries(
            self._fetch, detail_chunk_path(zone, cell))

    def fetch_zone_file(self, zone, fname):
        """(raw, err) for one of a zone's game files through the
        bound transport, with the standard retry policy.

        2.0.1: when a progress callback is bound, the download
        goes through the progress-capable fetch first (so the
        window's MB bar moves during a selection's roads
        download — in 2.0.0 that download was invisible AND on
        the UI thread). A network-class failure of that attempt
        falls through to the standard retried fetch; an HTTP
        answer (401/403/404) is returned at once, as retries
        cannot change it."""
        if self._fetch is None:
            return None, "no download connection is bound"
        path = zone_repo_path(zone, fname)
        if self._fetch_progress is not None \
                and self._progress is not None:
            raw, err = _fetch_progress(
                self._fetch, self._fetch_progress, path,
                self._progress)
            if raw is not None:
                return raw, None
            if "Network error:" not in (err or ""):
                return None, err
        return _fetch_with_retries(self._fetch, path)

    def _drop_roads_views(self, except_zone=None):
        """Drop every loaded zone's cached roads view except one
        (2.0.1): parsed roads are the heaviest per-zone structure
        the editor holds, so only the zone being looked at keeps
        its view; another zone's view rebuilds on demand if
        Joshua goes back to it. The roads BYTES stay — only the
        parse + segment index are released."""
        for name, zd in self.zones.items():
            if name != except_zone:
                zd._roads_view = None

    # -- light indexes ---------------------------------------------------

    def ensure_index(self, zone, fetch_file, fetch_file_progress=None,
                     progress=None):
        """Download one zone's light index if not already held.
        Returns an error string ("<path>: <reason>") or None."""
        if zone in self.indexes:
            return None
        path = INDEX_REPO_PATH.format(zone=zone)
        raw, err = _fetch_progress(fetch_file, fetch_file_progress,
                                   path, progress)
        if raw is None:
            return err
        try:
            self.indexes[zone] = BuildingIndex.from_bytes(raw)
        except Exception as e:
            return f"{path}: {e}"
        return None

    def download_indexes(self, fetch_file, fetch_file_progress=None,
                         progress=None):
        """Download every zone's light index. Returns {zone: error}."""
        errors = {}
        for zone in ZONES:
            err = self.ensure_index(zone, fetch_file,
                                    fetch_file_progress, progress)
            if err:
                errors[zone] = err
        return errors

    # -- zone data, on demand ----------------------------------------------

    def ensure_spine(self, zone, fetch_file, fetch_file_progress=None,
                     progress=None):
        """
        Download ONE zone's SPINE (2.0.0): buildings.json +
        zone.json + hero_buildings.json (404-normal) — the light
        frame every snapshot hangs on. The detail records are NOT
        downloaded (they arrive per chunk through the DetailList
        facade) and neither is roads.json (lazy, first snapshot).
        A file that fails is reported AS "<repo path>: <GitHub's
        message>". Returns an error string or None.
        """
        self.bind_transport(fetch_file, fetch_file_progress, progress)
        if zone in self.zones:
            return None
        files = {}
        for fname in ("buildings.json", "zone.json",
                      "hero_buildings.json"):
            path = zone_repo_path(zone, fname)
            raw, err = _fetch_progress(fetch_file,
                                       fetch_file_progress,
                                       path, progress)
            if raw is None:
                if fname == "hero_buildings.json" and "404" in err:
                    files[fname] = None
                    continue
                return err
            files[fname] = raw
        try:
            zd = ZoneData(zone).load_spine(files)
        except Exception as e:
            return str(e)
        zd.store = self
        self.zones[zone] = zd
        self._load_order.append(zone)
        return None

    def ensure_zone(self, zone, fetch_file, fetch_file_progress=None,
                    progress=None):
        """
        The FULL load of one zone (2.0.0): spine + every detail
        record materialised + roads bytes. Only for actions that
        genuinely need the whole zone (baking a subdivision). The
        selection path uses ensure_spine + snapshots instead.
        Returns an error string or None.
        """
        err = self.ensure_spine(zone, fetch_file,
                                fetch_file_progress, progress)
        if err:
            return err
        zd = self.zones[zone]
        err = zd.materialize_details()
        if err:
            return err
        return zd.ensure_roads()

    def open_snapshot(self, zone, index):
        """
        Generate the SNAPSHOT of one building (2.0.0 spec §1): the
        subject's record, its flagged entry (if any), and its
        read-only neighbours within SNAPSHOT_RADIUS — fetching
        only the detail chunks those records live in. The zone's
        spine must already be loaded (ensure_spine). Returns a
        dict {zd, index, detail, flagged, neighbours, bytes}
        where bytes counts the detail-chunk bytes this snapshot
        fetched (roads bytes ride in zd.bytes_fetched too — the
        panel fetches them for the backdrop right after).
        Raises ZoneDataError on any data problem — loudly.
        """
        zd = self.zones.get(zone)
        if zd is None:
            raise ZoneDataError(
                f"Zone {zone} is not loaded — no snapshot can be "
                f"generated.")
        if not (0 <= index < len(zd.boxes)):
            raise ZoneDataError(
                f"Zone {zone}: no building at index {index}.")
        before = zd.bytes_fetched
        detail = zd.details[index]
        flagged = self.flagged.match(zone, detail.get("ring") or [])
        neighbours = zd.neighbours_within(index)
        return {"zd": zd, "index": index, "detail": detail,
                "flagged": flagged, "neighbours": neighbours,
                "bytes": zd.bytes_fetched - before}

    def prepare_snapshot(self, zone, index):
        """
        EVERYTHING the inspector needs for one building, gathered
        in one call (2.0.1) — designed to run on a WORKER thread
        so the UI thread never waits on it:

        * the snapshot itself (open_snapshot: the detail chunks
          of the building and its neighbours — network fetches),
        * the zone's roads bytes (a ~2.4 MB download the first
          time, with the bound progress callback driving the
          window's MB bar),
        * the zone's CACHED roads view (roads_view: the parse +
          segment index, built once per zone, not per selection),
        * the derived FRONT (building_front over the cached
          view) and the nearby-segments backdrop.

        Returns the open_snapshot dict plus {"front",
        "roads_near", "roads_error"}. A roads problem is NOT
        fatal to the snapshot — the building still shows, with
        front=None and the reason in roads_error for the status
        bar (2.0.0 silently degraded to a front-less view when
        the roads fetch failed; the failure is named now, per
        Joshua's failure philosophy). A snapshot problem (a
        missing/unreadable detail chunk) raises ZoneDataError,
        as open_snapshot always has.

        Serialised on _snapshot_lock: the DetailList facade's
        chunk LRU is single-threaded by design, and two rapid
        selections must not race it.
        """
        zd = self.zones.get(zone)
        if zd is None:
            raise ZoneDataError(
                f"Zone {zone} is not loaded — no snapshot can be "
                f"prepared.")
        with self._snapshot_lock:
            snap = self.open_snapshot(zone, index)
            roads = None
            seg_index = None
            roads_error = None
            err = zd.ensure_roads()
            if err:
                roads_error = (f"{zone_repo_path(zone, 'roads.json')}"
                               f": {err}")
            else:
                roads, seg_index = zd.roads_view()
                if roads is None and zd.roads_raw:
                    roads_error = (
                        f"{zone_repo_path(zone, 'roads.json')}: "
                        f"the downloaded roads could not be read.")
            front = None
            roads_near = []
            if roads:
                front = building_front(
                    zd, index, snap["flagged"], roads=roads,
                    seg_index=seg_index)
                ring = front.get("ring") \
                    or snap["detail"].get("ring") or []
                roads_near = zd.nearby_segments(
                    ring, margin=60.0, roads=roads)
            snap.update({"front": front, "roads_near": roads_near,
                         "roads_error": roads_error})
            return snap

    def unload_zone(self, zone):
        """Drop a loaded zone's full data. ONLY a zone with no
        unsaved edits may be dropped — dirty data is never thrown
        away. Returns True when the zone was unloaded."""
        zd = self.zones.get(zone)
        if zd is None or zd.dirty:
            return False
        del self.zones[zone]
        if zone in self._load_order:
            self._load_order.remove(zone)
        return True

    def fetch_subdivisions(self, fetch_file):
        """Download the editor subdivisions file (a missing file —
        404 — means "start empty; created on first save"). Returns
        an error string or None."""
        raw, err = _fetch_with_retries(fetch_file,
                                       SUBDIVISIONS_REPO_PATH)
        if err is not None:
            if "404" in err:
                self.subdivisions = []
                self.subdivisions_dirty = False
                return None
            return err
        if raw:
            try:
                parsed = json.loads(raw)
                self.subdivisions = parsed if isinstance(parsed, list) \
                    else parsed.get("subdivisions", [])
            except Exception:
                self.subdivisions = []
        self.subdivisions_dirty = False
        return None

    def download_on_open(self, fetch_file, fetch_file_progress=None,
                         progress=None):
        """
        The 1.6.0–1.7.1 FULL download (every index + every zone +
        subdivisions), kept as one call for the harness and the
        memory-comparison gate. The 1.7.2 app does NOT call this —
        it loads on demand (download_indexes + ensure_zone). Each
        zone's failure is recorded as "<repo path>: <reason>".
        Returns {zone: error_string} for zones that failed.
        """
        errors = {}
        for zone in ZONES:
            err = self.ensure_index(zone, fetch_file,
                                    fetch_file_progress, progress)
            if err:
                errors[zone] = err
                continue
            err = self.ensure_zone(zone, fetch_file,
                                   fetch_file_progress, progress)
            if err:
                errors[zone] = err
        err = self.fetch_subdivisions(fetch_file)
        if err:
            errors["subdivisions"] = err
        return errors

    # -- zone attribution -----------------------------------------------------

    def zone_for_point(self, x, z):
        """The zone containing (x, z): loaded zones by their exact
        bounds first, then the light indexes' bounds (so a point
        can be attributed before its zone's detail loads)."""
        for zone in ZONES:
            zd = self.zones.get(zone)
            if zd is not None and zd.contains(x, z):
                return zone
        for zone in ZONES:
            idx = self.indexes.get(zone)
            if idx is not None and idx.contains(x, z):
                return zone
        return None

    def place_building(self, x, z, w, d, h, editor_type, name=None):
        """
        Place a building at (x, z): the zone is whichever zone's
        bounds contain the centre. A centre outside ALL zones is
        refused (nothing is appended anywhere); a centre inside a
        zone whose full data is not loaded yet is refused with the
        zone named, so the caller can load it first (1.7.2: placing
        must never silently download a whole zone). Returns
        (zone, index).
        """
        zone = self.zone_for_point(x, z)
        if zone is None:
            raise ZoneDataError(
                f"Cannot place a building at ({x:.1f}, {z:.1f}): that "
                f"point is outside every game zone. Buildings can "
                f"only be placed inside a zone's bounds.")
        if zone not in self.zones:
            raise ZoneDataError(
                f"That spot is in the {zone} zone, which is not "
                f"loaded yet. Open a building in {zone} first (that "
                f"loads it), then place.")
        idx = self.zones[zone].place(x, z, w, d, h, editor_type, name)
        return zone, idx

    # -- subdivision bake -------------------------------------------------------

    # House footprint used by the bake: subdivision templates are
    # house styles, so generated houses use a standard house box on a
    # regular lot grid. Lot pitch leaves a gap between houses.
    BAKE_HOUSE_W, BAKE_HOUSE_D, BAKE_HOUSE_H = 24.0, 18.0, 5.0
    BAKE_LOT_PITCH = 34.0

    def bake_subdivision(self, subdivision):
        """
        Generate houses from a subdivision definition and BAKE them
        into the zone building files exactly like placements: lot
        centres on a grid over the polygon's bounding box, kept when
        the centre is inside the polygon, each placed through
        place_building() (so zone attribution + refusal rules are
        the same code path). Returns the number of houses baked.
        Houses whose centre falls outside all zones are skipped by
        place_building's refusal — caught here and counted as skipped
        so one stray lot cannot abort the whole bake.
        """
        polygon = subdivision.get("polygon") or []
        if len(polygon) < 3:
            raise ZoneDataError(
                "Subdivision has no polygon to generate houses in.")
        xs = [p[0] for p in polygon]
        zs = [p[1] for p in polygon]
        baked = 0
        gx = min(xs) + self.BAKE_LOT_PITCH / 2.0
        while gx < max(xs):
            gz = min(zs) + self.BAKE_LOT_PITCH / 2.0
            while gz < max(zs):
                if point_in_polygon(gx, gz, polygon):
                    try:
                        self.place_building(
                            gx, gz, self.BAKE_HOUSE_W, self.BAKE_HOUSE_D,
                            self.BAKE_HOUSE_H, "House",
                            name=subdivision.get("name"))
                        baked += 1
                    except ZoneDataError:
                        pass  # outside all zones — skip this lot
                gz += self.BAKE_LOT_PITCH
            gx += self.BAKE_LOT_PITCH
        return baked

    # -- save targets -----------------------------------------------------------

    def dirty_zone_names(self):
        """Zones with unsaved edits (only these are ever pushed)."""
        return [z for z in ZONES
                if z in self.zones and self.zones[z].dirty]

    def build_targets(self, today=None):
        """
        (repo, path, bytes, message) push targets for one round trip:
        per dirty zone its three files together PLUS its regenerated
        light index (1.7.2 — the index rides in the same round so the
        editor's own list can never show its own edits stale) PLUS,
        2.0.0, the regenerated detail chunks of exactly the cells
        its edits touched (chunk_cells_to_push), plus the editor
        subdivisions file when subdivisions changed.
        Raises ZoneDataError when any dirty zone's pair is
        misaligned — BEFORE anything is pushed.
        """
        targets = []
        for zone in self.dirty_zone_names():
            zd = self.zones[zone]
            err = zd.validate_alignment()
            if err:
                raise ZoneDataError(err)
            payloads = zd.payloads(today)
            for fname in ("buildings.json", "buildings_detail.json",
                          "buildings.js"):
                targets.append(
                    (REPO, zone_repo_path(zone, fname), payloads[fname],
                     f"Building editor {EDITOR_VERSION}: update "
                     f"{zone} {fname}"))
            targets.append(
                (REPO, INDEX_REPO_PATH.format(zone=zone),
                 index_bytes(zd.index_doc(today)),
                 f"Building editor {EDITOR_VERSION}: refresh "
                 f"{zone} light index"))
            for cell in zd.chunk_cells_to_push():
                targets.append(
                    (REPO, detail_chunk_path(zone, cell),
                     zd.chunk_payload(cell),
                     f"Building editor {EDITOR_VERSION}: refresh "
                     f"{zone} detail chunk {cell[0]}_{cell[1]}"))
        if self.subdivisions_dirty:
            targets.append(
                (REPO, SUBDIVISIONS_REPO_PATH,
                 json.dumps(self.subdivisions, indent=1).encode(),
                 f"Building editor {EDITOR_VERSION}: update "
                 f"subdivisions"))
        return targets

    # -- THE ROUND TRIP -----------------------------------------------------------

    def round_trip_save(self, cache_dir, open_connection, push_targets,
                        fetch_file, today=None):
        """
        Joshua's standing save rule, as one operation: local save ->
        push on ONE connection -> close it -> re-download every
        pushed file on a FRESH connection -> refresh the view from
        the downloaded proof copy.

        cache_dir: local cache directory (local stage writes there).
        open_connection(): returns a NEW connection object per leg.
        push_targets(targets, conn=...): github_sync.push_targets.
        fetch_file(repo, path, conn=...): github_sync.fetch_file.

        Returns (ok, message, fresh) where fresh maps repo path ->
        re-downloaded bytes on success. On ANY failure the in-memory
        edits stay exactly as they were (dirty flags untouched) and
        the view is not refreshed.
        """
        # Nothing dirty -> nothing to do (zero pushes, zero fetches).
        # 2.0.0: a dirty zone must be MATERIALISED before its save
        # can be built (every edit path materialises already; this
        # is the guarantee, not the expectation — a zone that
        # cannot be fully loaded must not be half-saved).
        for zone in self.dirty_zone_names():
            err = self.zones[zone].materialize_details()
            if err:
                return False, err, None
        try:
            targets = self.build_targets(today)
        except ZoneDataError as e:
            return False, str(e), None
        if not targets:
            return True, "Nothing to save — no changes.", {}

        # ---- Stage 1: LOCAL SAVE -------------------------------------
        try:
            cache = Path(cache_dir)
            cache.mkdir(parents=True, exist_ok=True)
            for _repo, path, content, _msg in targets:
                local = cache / path.replace("/", "_")
                local.write_bytes(content)
        except Exception as e:
            return False, f"local-save-failed: {e}", None

        # ---- Stage 2: PUSH LEG (one connection) ----------------------
        push_conn = open_connection()
        try:
            ok, msg = push_targets(targets, conn=push_conn)
        finally:
            # The push connection is ALWAYS closed before the proof
            # leg — a half-dead socket must never carry the download.
            push_conn.close()
        if not ok:
            return False, f"Push to GitHub failed: {msg}", None

        # ---- Stage 3: PROOF LEG (a FRESH connection) ------------------
        fresh = {}
        proof_conn = open_connection()
        try:
            for _repo, path, _content, _msg in targets:
                raw, err = fetch_file(REPO, path, conn=proof_conn)
                if err is not None:
                    return False, (
                        f"push reached GitHub but downloading the "
                        f"proof copy back failed: {err} — your save "
                        f"DID reach GitHub"), None
                fresh[path] = raw
        finally:
            proof_conn.close()

        # ---- Stage 3b: BYTE PROOF (2.0.0 — the Issue B law) -----------
        # Every re-downloaded file must be byte-identical to the
        # bytes that were pushed. If GitHub's copy differs, the
        # word "saved" must not be said: the edits stay dirty on
        # this computer and the message says exactly what happened.
        pushed = {path: content for _r, path, content, _m in targets}
        for path, content in pushed.items():
            if fresh.get(path) != content:
                return False, (
                    f"the copy of {path} that came back from "
                    f"GitHub is not the file that was just sent — "
                    f"the save is NOT verified. Your edits are "
                    f"still on this computer; save again."), None

        # ---- Stage 3c: RECORD PROOF (2.0.0) -----------------------------
        # Byte equality proves the transport; this proves the DATA:
        # the proof copies of every dirty zone must parse to exactly
        # the boxes and detail records this save meant to store —
        # every changed record carrying its new values, every
        # unchanged record untouched.
        for zone in self.dirty_zone_names():
            zd = self.zones[zone]
            try:
                proof_boxes = [list(r) for r in json.loads(
                    fresh[zone_repo_path(zone, "buildings.json")]
                ).get("buildings", [])]
                proof_details = json.loads(
                    fresh[zone_repo_path(zone,
                                         "buildings_detail.json")])
            except Exception as e:
                return False, (
                    f"the proof copy for {zone} does not parse "
                    f"({e}) — the save is NOT verified. Your edits "
                    f"are still on this computer; save again."), None
            if proof_boxes != zd.boxes \
                    or proof_details != list(zd.details):
                return False, (
                    f"the {zone} data that came back from GitHub "
                    f"does not match the data that was sent — the "
                    f"save is NOT verified. Your edits are still "
                    f"on this computer; save again."), None

        # ---- Stage 4: REFRESH FROM THE PROOF COPY ---------------------
        # The view now shows exactly what GitHub holds. Dirty flags
        # clear only here, after the proof copy is in hand.
        for zone in self.dirty_zone_names():
            self.zones[zone].refresh_buildings({
                "buildings.json":
                    fresh[zone_repo_path(zone, "buildings.json")],
                "buildings_detail.json":
                    fresh[zone_repo_path(zone,
                                         "buildings_detail.json")],
            })
            idx_raw = fresh.get(INDEX_REPO_PATH.format(zone=zone))
            if idx_raw:
                self.indexes[zone] = BuildingIndex.from_bytes(idx_raw)
        if self.subdivisions_dirty:
            raw = fresh.get(SUBDIVISIONS_REPO_PATH)
            if raw:
                self.subdivisions = json.loads(raw)
            self.subdivisions_dirty = False
        return True, "Saved to GitHub and verified.", fresh
