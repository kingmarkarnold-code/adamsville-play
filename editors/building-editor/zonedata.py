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

import json
import math
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
EDITOR_VERSION = "1.7.3"

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


def building_front(zd, index, flagged_entry=None, roads=None):
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
    "decision. Flagged buildings cannot be moved, resized, or "
    "deleted in this version of the editor.")

# How close a building's ring centroid must sit to a flagged entry's
# centroid to count as the same building (converter coordinates are
# exact; 1 unit of slack covers vertex-mean vs true-centroid drift
# on non-rectangular rings).
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
        once its zone detail is loaded."""
        if not ring:
            return None
        cx, cz = ring_centroid(ring)
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
# One zone's full data (loaded ON DEMAND, 1.7.2)
# ---------------------------------------------------------------------------

class ZoneData:
    """
    In-memory copy of one zone's game building files, loaded only
    when Joshua actually opens that zone (1.7.2 load on demand).

    boxes:   [[x, z, w, d, h, type], ...]         (from buildings.json)
    details: [{name, osm_type, height_m, ring, moved}, ...] (aligned)
    hero:    parsed hero_buildings.json dict, or None if the zone
             has none (only adamsville ships one today). READ-ONLY:
             listed, never modified.
    zone_meta: parsed zone.json (bounds decide zone attribution).
    roads_raw: the zone's roads.json BYTES, kept unparsed. The
             parsed roads of a zone run to ~10 MB and were a real
             part of the 1.7.1 memory weight; 1.7.2 parses them
             TRANSIENTLY (transient_roads) when a building is
             selected, keeps only the segments near that building,
             and drops the parse.
    dirty:   True once any placement/edit/delete touched this zone.
    """

    def __init__(self, zone):
        self.zone = zone
        self.version = ""
        self.boxes = []
        self.details = []
        self.hero = None
        self.zone_meta = None
        self.roads_raw = None
        self.dirty = False

    # -- loading --------------------------------------------------------

    def load(self, files):
        """
        Populate from {filename: bytes} as downloaded from GitHub.
        Raises ZoneDataError if the box/detail pair is misaligned —
        a misaligned pair must never be edited or re-pushed.
        """
        b = json.loads(files["buildings.json"])
        self.version = b.get("version", "")
        self.boxes = [list(row) for row in b.get("buildings", [])]
        self.details = json.loads(files["buildings_detail.json"])
        if len(self.boxes) != len(self.details):
            raise ZoneDataError(
                f"Zone {self.zone}: buildings.json has "
                f"{len(self.boxes)} buildings but buildings_detail.json "
                f"has {len(self.details)} — refusing to edit a "
                f"misaligned pair.")
        hero_raw = files.get("hero_buildings.json")
        self.hero = json.loads(hero_raw) if hero_raw else None
        meta_raw = files.get("zone.json")
        self.zone_meta = json.loads(meta_raw) if meta_raw else None
        # 1.7.2: roads stay RAW (see class docstring).
        self.roads_raw = files.get("roads.json")
        self.dirty = False
        return self

    def refresh_buildings(self, files):
        """Replace ONLY the building pair with re-downloaded proof
        bytes (after a successful round trip); hero/zone/roads are
        untouched. load() semantics for the pair, dirty cleared."""
        b = json.loads(files["buildings.json"])
        details = json.loads(files["buildings_detail.json"])
        boxes = [list(row) for row in b.get("buildings", [])]
        if len(boxes) != len(details):
            raise ZoneDataError(
                f"Zone {self.zone}: proof copy is misaligned "
                f"({len(boxes)} boxes vs {len(details)} details).")
        self.version = b.get("version", "")
        self.boxes = boxes
        self.details = details
        self.dirty = False

    # -- roads (transient) ------------------------------------------------

    def transient_roads(self):
        """Parse this zone's roads for ONE use and return the dict
        (or None). The caller drops the result when done — nothing
        here retains the parse."""
        if not self.roads_raw:
            return None
        try:
            return json.loads(self.roads_raw)
        except Exception:
            return None

    def nearby_segments(self, ring, margin=60.0, roads=None):
        """[(name, pts)] for roads with any point within the ring's
        bounding box grown by `margin` — the inspector's backdrop.
        Parses the zone's roads transiently unless a parsed dict is
        supplied; only the matching segments are returned (and are
        all the caller keeps)."""
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
        for _cat, records in roads.items():
            for rec in records or []:
                pts = rec.get("pts") or []
                if any(x0 <= p[0] <= x1 and z0 <= p[1] <= z1
                       for p in pts):
                    out.append((rec.get("name") or "", pts))
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

    def place(self, x, z, w, d, h, editor_type, name=None):
        """
        Append a placed building: box [x, z, w, d, h, code] + detail
        {name, osm_type, height_m = h, rectangle ring, moved: 0}.
        Returns the new building's index. Marks the zone dirty.
        """
        if editor_type not in EDITOR_TYPE_MAP:
            raise ZoneDataError(f"Unknown building type: {editor_type}")
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
        box = self.boxes[index]
        dx, dz = new_x - box[0], new_z - box[1]
        box[0], box[1] = new_x, new_z
        det = self.details[index]
        det["ring"] = [[px + dx, pz + dz] for px, pz in det["ring"]]
        self.dirty = True

    def resize(self, index, w, d, h, flagged=None):
        """Resize a building: box dims + height_m + ring rebuilt from
        the (unchanged) centre, so box and footprint stay consistent."""
        self._refuse_if_flagged(index, flagged)
        box = self.boxes[index]
        box[2], box[3], box[4] = w, d, h
        det = self.details[index]
        det["height_m"] = h
        det["ring"] = rectangle_ring(box[0], box[1], w, d)
        self.dirty = True

    def delete(self, index, flagged=None):
        """Delete a building: BOTH the box and its detail entry go."""
        self._refuse_if_flagged(index, flagged)
        del self.boxes[index]
        del self.details[index]
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
        and the regenerated buildings.js twin.
        """
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
    zones:        zone -> ZoneData (FULL data; only zones Joshua
                  actually opened — the load-on-demand rule)
    subdivisions: [{"name", "polygon": [[x, z], ...], "style"}] —
                  editor working data, persisted to
                  SUBDIVISIONS_REPO_PATH through the same round trip.
    flagged:      the downloaded FlaggedIndex.
    review:       the downloaded GasStationReview (or None).
    station_edits: the StationEdits overlay.
    """

    def __init__(self, flagged=None):
        self.zones = {}            # zone name -> ZoneData (loaded only)
        self.indexes = {}          # zone name -> BuildingIndex
        self.subdivisions = []
        self.subdivisions_dirty = False
        self.flagged = flagged if flagged is not None \
            else FlaggedIndex()
        self.review = None
        self.station_edits = StationEdits()
        self._load_order = []      # loaded zones, oldest first

    def set_flagged(self, flagged):
        """Adopt the downloaded flagged index (1.7.2: the list is
        downloaded on open, after the store exists)."""
        self.flagged = flagged

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

    # -- zone detail, on demand -------------------------------------------

    def ensure_zone(self, zone, fetch_file, fetch_file_progress=None,
                    progress=None):
        """
        Download + parse ONE zone's full building files (the
        selection-triggered load of the 1.7.2 design). A file that
        fails is reported AS "<repo path>: <GitHub's message>";
        hero_buildings.json is optional (only adamsville ships one
        — a 404 there is normal). Returns an error string or None.
        """
        if zone in self.zones:
            return None
        files = {}
        for fname in ZONE_FILES:
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
            self.zones[zone] = ZoneData(zone).load(files)
        except Exception as e:
            return str(e)
        self._load_order.append(zone)
        return None

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
        editor's own list can never show its own edits stale), plus
        the editor subdivisions file when subdivisions changed.
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
