#!/usr/bin/env python3
"""
Adamsville Detail Editor (Native) — the data layer.

Everything this app reads or writes, in one module:

  * THE HANDOFF — the file the Map Editor's Detail Edit button
    writes (~/.local/share/adamsville-suite/open-in-detail-
    editor.json), consumed with the suite's lifecycle: a FRESH
    handoff (< 48 hours old) applies ONCE and the file is
    deleted; an unparseable file is renamed .bad so it cannot
    loop; a stale one is removed unread. Two senders write it:
    the Map Editor (roads) and the Building Editor (buildings,
    element_type "building" — supported since 1.3.0). A payload
    for an element this app genuinely cannot open is NEVER
    silently destroyed (the 1.2.2 rule): it is preserved aside
    as *.unsupported.json and a plain-language notice is left
    for the app to speak — pop_handoff_notice(). (The Map
    Editor's own consumption of the Building Editor's
    street-jump handoff is the precedent.)

  * DOWNLOADS — only what the open piece needs: the map manifest
    (fresh, it is the freshness source) and ONE zone's zone.json +
    roads.json, through the suite's shared download cache
    (suite_core.shared_cache). No whole-world load, ever. And NO
    elevation data: this app never reads elev.json, lifts files or
    the ys heights as heights — see the adapter note below.

  * NAMES — a record's "name" is its street name; a road with no
    name carries the game's own placeholder, the literal
    "Unnamed St" (the converted data holds thousands, and the Map
    Editor uses the same constant). Renaming a piece (the tab's
    pencil, 1.1.0) edits ONLY that record's name on its session
    template, so it rides the same save as any geometry edit.

  * BUILDINGS (1.3.0) — a zone's buildings.json is
    {"version": str, "realCount": n, "buildings": [ROW, ...]}
    with ROW the positional list [x, z, w, d, h, type]: centre,
    width (x extent), depth (z extent), height, integer type
    code. That is ALL a record carries — no rotation, no
    footprint polygon, no name (true footprints live in
    buildings_detail.json, a Building Editor layer this app
    never writes: the exact parallel of road elevation). The
    Building Editor's zone list is index-aligned with this
    file, so a handoff's zone + index IS the building's
    identity. The building opens as its axis-aligned footprint
    RING under a RECTANGLE LAW: every state the editor can
    reach stays a rectangle the record can hold (corner drags
    move edges, edge drags move whole edges, segmentation
    points ride collinearly and collapse on save — see
    BuildingElement). Height and type are carried, never
    edited. A save writes ONLY the record at the handoff's
    index, and only after verifying that record still matches
    the building that was sent; the buildings.js twin is
    regenerated with it (the twins never disagree).

  * THE ROAD ADAPTER — translates one road record (a PIECE) to and
    from the element core's Element (element.py). A record is
    {"name", "pts": [[x, z], ...], "ys": [...], maybe "ramp": 1}.
    "ys" is the road's baked height profile — ELEVATION data. This
    app carries it as an opaque per-point payload: it travels with
    its point when the point moves (x/z only), is interpolated for
    a NEW point (the height the road already has along that
    segment — no height is invented or changed), and is dropped
    only when its point is deleted. No existing height value is
    ever modified. That is what "detail edits never touch
    elevation" means in data terms.

  * THE SAVE — the suite's standing rule, via suite_core's
    round_trip(): local save -> push (the edited file + its
    regenerated .js twin — roads.json/roads.js or
    buildings.json/buildings.js — one connection, closed) ->
    fresh download on a
    NEW connection -> the downloaded bytes are adopted as the live
    model. Only the zone the piece lives in is ever written; the
    manifest stamp is maintained by suite_core.push_targets (the
    2026-10-18 freshness fix), so the game sees the edit at its
    next launch.

Serialisation mirrors the converter byte-for-byte (compact JSON,
UTF-8, non-ASCII literal, converter category order, empty
categories omitted, unknown record fields preserved verbatim) —
the same contract the Map Editor's gamedata.py and the Elevation
Editor's elevdata.py each carry, so an untouched file re-serialises
to its own bytes and "no change" is provable by comparison.

Joshua's rule: all code commented.
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

from element import Element

# This editor's version (About dialog, the roads.js twin header).
EDITOR_VERSION = "1.4.0"

# The game's own name for a road with no name: the converted data
# carries this literal, so a rename to "no name" writes exactly it.
UNNAMED_NAME = "Unnamed St"

# The one repo everything lives in.
GAME_REPO = "kingmarkarnold-code/adamsville-play"
REPO = GAME_REPO

# The 7 game zones, in the game's own order (the Map Editor's list).
ZONE_IDS = ["adamsville", "downtown", "eastatlanta", "mableton",
            "riverdale", "southfulton", "unioncity"]

MANIFEST_PATH = "detailed/map-manifest.json"

# Converted-format category order (the converter's key order).
CATEGORY_ORDER = ("interstate", "highway", "major_artery",
                  "minor_artery", "local")

# The handoff the Map Editor's Detail Edit button writes (its
# DETAIL_HANDOFF_NAME), in the shared suite directory (the same
# directory github_sync keeps the suite token in).
HANDOFF_NAME = "open-in-detail-editor.json"
HANDOFF_MAX_AGE_S = 48 * 3600  # the suite's freshness window
# Where a payload for an element this app cannot open is
# preserved (never deleted — read_handoff, 1.2.2).
HANDOFF_UNSUPPORTED_NAME = "open-in-detail-editor.unsupported.json"


class DetailDataError(Exception):
    """A plain-language data failure (shown as-is in the UI)."""


# ---------------------------------------------------------------------------
# Repo paths + serialisation (the converter's byte contract)
# ---------------------------------------------------------------------------

def zone_roads_path(zone_id):
    """Repo path of one zone's converted roads.json."""
    return f"detailed/zones/{zone_id}/roads.json"


def zone_roads_js_path(zone_id):
    """Repo path of one zone's roads.js twin."""
    return f"detailed/zones/{zone_id}/roads.js"


def zone_meta_path(zone_id):
    """Repo path of one zone's zone.json metadata."""
    return f"detailed/zones/{zone_id}/zone.json"


def zone_buildings_path(zone_id):
    """Repo path of one zone's buildings.json (context dressing
    for the colour views since 1.2.0; since 1.3.0 also the file a
    building session edits — one record at a time, through the
    same round trip as roads).
    """
    return f"detailed/zones/{zone_id}/buildings.json"


def zone_buildings_js_path(zone_id):
    """Repo path of one zone's buildings.js twin."""
    return f"detailed/zones/{zone_id}/buildings.js"


def zone_water_path(zone_id):
    """Repo path of one zone's water.json (context dressing,
    read-only like buildings)."""
    return f"detailed/zones/{zone_id}/water.json"


def parse_buildings(doc):
    """
    A zone's buildings document -> the context list the canvases
    draw: [x, z, w, d, h, type] rows (the game's own layout —
    centre, width, depth, height, type code; index.html's
    OSM_BUILDINGS). Malformed rows are skipped, never fatal:
    buildings are dressing, and dressing must not break the
    editor. Returns [] for anything unexpected.
    """
    rows, _src = parse_buildings_indexed(doc)
    return rows


def parse_buildings_indexed(doc):
    """
    parse_buildings, plus the source row index of every kept row.
    A building's identity IS its row index (the Building Editor's
    list is index-aligned with the file), so the context list
    must know which row each drawn building came from — a
    malformed row the parser skips must not silently shift the
    identity of every building after it. Returns (rows, indices)
    with rows[i] == the parsed doc row indices[i].
    """
    out = []
    src = []
    rows = doc.get("buildings") if isinstance(doc, dict) else None
    for i, row in enumerate(rows or []):
        try:
            if len(row) < 6:
                continue
            out.append([float(row[0]), float(row[1]),
                        float(row[2]), float(row[3]),
                        float(row[4]), int(row[5])])
            src.append(i)
        except Exception:
            continue
    return out, src


def parse_water(doc):
    """
    A zone's water document -> [(kind, [[x, z], ...]), ...]:
    each entry of the game's {"water": [[id, kind, outline],
    ...]} becomes one drawable outline. Malformed entries are
    skipped (dressing, as with buildings). Returns [] for
    anything unexpected.
    """
    out = []
    rows = doc.get("water") if isinstance(doc, dict) else None
    for entry in rows or []:
        try:
            kind = str(entry[1])
            pts = [[float(p[0]), float(p[1])] for p in entry[2]]
            if len(pts) >= 3:
                out.append((kind, pts))
        except Exception:
            continue
    return out


def serialize_json_compact(obj):
    """Serialise exactly like the converter (JSON.stringify): no
    spaces, UTF-8, non-ASCII kept literal. Byte-stable against the
    shipped zone files — proven in this app's harness for all 7."""
    return json.dumps(obj, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def serialize_roads(zone_roads):
    """
    Build the roads.json bytes for ONE zone from {category:
    [record dicts]}: canonical categories first (converter order),
    then any unexpected category in its original order; empty
    categories omitted; records preserved whole and in key order.
    """
    out = {}
    ordered = [c for c in CATEGORY_ORDER if c in zone_roads]
    ordered += [c for c in zone_roads if c not in ordered]
    for cat in ordered:
        roads = zone_roads.get(cat) or []
        if roads:
            out[cat] = roads
    return serialize_json_compact(out)


def roads_js_twin(zone_id, zone_name, roads_json_bytes):
    """
    Regenerate the roads.js twin for a zone, in the shipped twins'
    style: one header comment line, then `var ROAD_DATA = <the
    identical JSON>;`. The game loader prefers roads.json; the .js
    is its fallback, so the two must never disagree — a save always
    pushes both.
    """
    header = (f"/* ZONE ROADS — {zone_name} ({zone_id}) — "
              f"Generated by Adamsville Detail Editor "
              f"{EDITOR_VERSION}; do not hand-edit. */\n")
    return (header.encode("utf-8") + b"var ROAD_DATA = "
            + roads_json_bytes + b";\n")


def buildings_js_twin(zone_id, zone_name, buildings_doc):
    """
    Regenerate the buildings.js twin for a zone, in the shipped
    twins' style (the Building Editor's generator is the
    reference): a header comment line, then OSM_BLDG_VERSION (the
    buildings.json document's own version string, carried
    unchanged), OSM_REAL_COUNT and OSM_BUILDINGS — the rows
    serialised exactly as buildings.json holds them, so the twin
    can never disagree with the file. A buildings save always
    pushes both.
    """
    rows = []
    version = None
    if isinstance(buildings_doc, dict):
        rows = buildings_doc.get("buildings") or []
        version = buildings_doc.get("version")
    header = (f"/* ZONE BUILDINGS — {zone_name} ({zone_id}) — "
              f"regenerated by Adamsville Detail Editor "
              f"{EDITOR_VERSION}; do not hand-edit. */\n")
    body = (f"var OSM_BLDG_VERSION = "
            f"{json.dumps(version, ensure_ascii=False)};\n"
            f"var OSM_REAL_COUNT = {len(rows)};\n"
            f"var OSM_BUILDINGS = "
            f"{json.dumps(rows, separators=(',', ':'), ensure_ascii=False)};\n")
    return header.encode("utf-8") + body.encode("utf-8")


# ---------------------------------------------------------------------------
# The handoff (Map Editor -> Detail Editor)
# ---------------------------------------------------------------------------

def handoff_path():
    """Where the suite's handoffs live (the shared suite dir)."""
    return (Path.home() / ".local" / "share" / "adamsville-suite"
            / HANDOFF_NAME)


# The plain-language word about the most recent handoff that
# was NOT opened (an unsupported payload), spoken by the app
# after read_handoff() returns — see pop_handoff_notice().
_handoff_notice = None


def pop_handoff_notice():
    """The notice the last read_handoff() left, or None. Reading
    clears it: a notice is spoken once, never repeated on every
    later check."""
    global _handoff_notice
    note = _handoff_notice
    _handoff_notice = None
    return note


def _unsupported_notice(doc):
    """Say plainly what arrived and why it cannot open here.
    (Buildings reached this text before 1.3.0; they are
    supported now, so only genuinely unknown types land here.)"""
    etype = str(doc.get("element_type") or "")
    name = str(doc.get("name") or "").strip()
    what = f"a {etype}" if etype else "an element"
    if name:
        what += f" ('{name}')"
    return (f"That was {what} — the Detail Editor works on "
            "roads and buildings, so it can't open that here. "
            "The handoff was kept aside, not deleted.")


def _preserve_unsupported(path):
    """Move an unsupported handoff aside, NEVER delete it:
    open-in-detail-editor.unsupported.json, timestamped when
    that name is already taken (an earlier preserved payload is
    evidence too and is never overwritten)."""
    target = path.with_name(HANDOFF_UNSUPPORTED_NAME)
    if target.exists():
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        target = path.with_name(
            f"open-in-detail-editor.unsupported-{stamp}.json")
        n = 2
        while target.exists():
            target = path.with_name(
                f"open-in-detail-editor.unsupported-{stamp}-{n}.json")
            n += 1
    try:
        path.rename(target)
    except Exception:
        # Preservation itself failed (a read-only directory?):
        # fall back to the suite's parse-failure treatment so the
        # payload still cannot be re-consumed on every launch —
        # and the notice has already been left either way.
        try:
            path.rename(path.with_suffix(".json.bad"))
        except Exception:
            pass


def read_handoff():
    """
    Consume the Detail Edit handoff, once, by the suite lifecycle.
    Returns the handoff document dict when a FRESH road or
    building one was waiting, else None. A consumed file is
    deleted either way (a stale one is simply removed); an
    unparseable file is renamed .bad so it cannot loop. A road
    document is:
        {"element_type": "road", "zone": <zone id>, "category": ...,
         "name": ..., "x": ..., "z": ..., "points": [[x, z], ...],
         "writtenBy": ..., "timestamp": <iso>}
    A building document (the Building Editor's Detail Edit) is:
        {"element_type": "building", "zone": <zone id>,
         "index": <row in the zone's buildings.json>,
         "name": ..., "x": ..., "z": ..., "w": ..., "d": ...,
         "h": ..., "type": ..., "writtenBy": ..., "timestamp": ...}
    The caller dispatches on element_type; the building is
    identity-checked against the downloaded zone data before it
    opens (verify_building).

    A payload whose element_type is anything else is NOT for
    this app. Before 1.2.2 building payloads were deleted here
    in silence and the building simply never appeared; the
    1.2.2 rule stands for what is still unsupported — the
    payload is preserved aside (_preserve_unsupported) and a
    notice is left for the app to speak (pop_handoff_notice).
    """
    global _handoff_notice
    path = handoff_path()
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text())
        if not isinstance(doc, dict):
            raise ValueError("handoff is not an object")
    except Exception:
        try:
            path.rename(path.with_suffix(".json.bad"))
        except Exception:
            pass
        return None
    if doc.get("element_type") not in (None, "road", "building"):
        # Not for this app: never silently destroy. Preserve the
        # payload aside (so it is neither lost nor re-consumed on
        # every launch) and leave the user a plain explanation.
        _preserve_unsupported(path)
        _handoff_notice = _unsupported_notice(doc)
        return None
    # Consumed (or stale): the file never applies twice.
    try:
        path.unlink()
    except Exception:
        pass
    ts = doc.get("timestamp")
    if ts:
        try:
            when = datetime.fromisoformat(str(ts))
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            age = (datetime.now(timezone.utc) - when).total_seconds()
            if age > HANDOFF_MAX_AGE_S:
                return None  # stale: removed above, not applied
        except Exception:
            pass  # an odd timestamp never blocks a plausible handoff
    return doc


# ---------------------------------------------------------------------------
# Finding the handed piece inside a zone's roads
# ---------------------------------------------------------------------------

def _centroid(pts):
    """Mean point of a polyline (the handoff's x/z is this)."""
    if not pts:
        return 0.0, 0.0
    return (sum(p[0] for p in pts) / len(pts),
            sum(p[1] for p in pts) / len(pts))


def _pts_match(a, b, tol=0.011):
    """True when two point lists are the same piece geometry."""
    if len(a) != len(b):
        return False
    return all(abs(pa[0] - pb[0]) <= tol and abs(pa[1] - pb[1]) <= tol
               for pa, pb in zip(a, b))


# The nearest-centroid rules in find_piece may only reach this
# far (metres) from the handed centre, at minimum — past it, the
# handed piece is gone (changed or deleted), and opening a
# DIFFERENT piece silently is worse than opening nothing (1.2.2).
FIND_PIECE_MIN_REACH_M = 50.0


def _reach(points):
    """How far find_piece's nearest rules may reach for a piece
    with these handed points: HALF the piece's own span, floored
    at FIND_PIECE_MIN_REACH_M. The bound is geometric, not a
    guess: the records that may legitimately answer a handoff
    are the piece itself, lightly edited (its centroid moves by
    metres), or a split successor — a contiguous run of the
    original points, whose centroid cannot sit farther than
    half the original span from the original centroid. Anything
    beyond that is a different piece that happens to be near."""
    if not points:
        return FIND_PIECE_MIN_REACH_M
    xs = [p[0] for p in points]
    zs = [p[1] for p in points]
    span = math.hypot(max(xs) - min(xs), max(zs) - min(zs))
    return max(FIND_PIECE_MIN_REACH_M, span / 2.0)


def find_piece(roads_doc, category, name, points, centre=None):
    """
    Locate the handoff's piece in a zone's roads document.
    Returns (category, index, how) or None. Match order (strongest
    first): the exact points under the handed category+name; the
    named records nearest the handed centre; any record in the
    category nearest the centre. `how` says which rule matched, so
    the UI can report honestly how sure the match is. The two
    nearest rules are reach-capped (_reach): a "nearest" record
    beyond the reach is no match at all — before 1.2.2 a changed
    or deleted piece could silently resolve to whatever record
    happened to be closest, however far away.
    """
    cats = [category] if category in roads_doc else list(roads_doc)
    if centre is None:
        centre = _centroid(points or [])
    # 1. Exact geometry under the handed identity.
    for cat in cats:
        for i, rec in enumerate(roads_doc.get(cat) or []):
            if name and (rec.get("name") or "") != name:
                continue
            if points and _pts_match(rec.get("pts") or [], points):
                return cat, i, "exact"
    # 2/3. Nearest centroid — named records first, then any —
    # each accepted only within the reach.
    reach = _reach(points)
    for want_name in (True, False):
        best = None
        for cat in cats:
            for i, rec in enumerate(roads_doc.get(cat) or []):
                if want_name and name \
                        and (rec.get("name") or "") != name:
                    continue
                cx, cz = _centroid(rec.get("pts") or [])
                d = (cx - centre[0]) ** 2 + (cz - centre[1]) ** 2
                if best is None or d < best[0]:
                    best = (d, cat, i)
        if best is not None and math.sqrt(best[0]) <= reach:
            return best[1], best[2], "name+centre" if want_name \
                else "centre"
    return None


# ---------------------------------------------------------------------------
# The road adapter (record <-> Element)
# ---------------------------------------------------------------------------

def element_from_record(record):
    """
    A road record as an Element: points from "pts", the per-point
    payload = the record's "ys" heights, CARRIED untouched (never
    edited — see the module docstring). A record whose ys are
    missing/short is padded with its last height (or 0.0) so the
    parallel lists always agree; the padding is data-preserving,
    not an elevation edit (the census shows shipped records always
    carry full ys).
    """
    pts = record.get("pts") or []
    ys = list(record.get("ys") or [])
    while len(ys) < len(pts):
        ys.append(ys[-1] if ys else 0.0)
    return Element(pts, payloads=ys[:len(pts)])


def interp_payload(ya, yb, t):
    """The payload for a NEW point at fraction t along a segment:
    the linear interpolation of its ends — exactly the height the
    road already has there, nothing invented."""
    if ya is None:
        return yb
    if yb is None:
        return ya
    return ya + (yb - ya) * t


def records_from_element(template, element):
    """
    The records an edited Element becomes: ONE record per chain
    (a middle-segment deletion therefore writes two records, same
    name — the design's split). Every field of the template record
    is preserved verbatim and in order; only "pts" and "ys" are
    rewritten from the chain (points in walking order, each point's
    carried height beside it). One-point chains become one-point
    records — nothing is silently dropped.
    """
    out = []
    for chain in element.chains():
        rec = dict(template)
        rec["pts"] = [[element.points[i][0], element.points[i][1]]
                      for i in chain]
        rec["ys"] = [element.payloads[i] for i in chain]
        out.append(rec)
    return out


# ---------------------------------------------------------------------------
# One zone's working model
# ---------------------------------------------------------------------------

class ZoneModel:
    """
    One zone as downloaded: its zone.json meta, its roads document
    ({category: [records]}), and the baseline bytes of its
    roads.json — a zone is DIRTY when its current serialisation
    differs from the baseline, so untouched zones are never pushed,
    by construction.
    """

    def __init__(self, zone_id):
        self.zone_id = zone_id
        self.meta = None            # parsed zone.json
        self.roads = None           # {category: [record dicts]}
        self.baseline = None        # downloaded roads.json bytes
        # Context dressing for the colour views (1.2.0): the
        # zone's buildings + water, downloaded with the zone and
        # drawn around the open piece. Water stays read-only
        # dressing, allowed to be absent (an older zone, a failed
        # fetch): the editor opens fine without it. Buildings
        # became editable in 1.3.0, so alongside the drawn rows
        # the model keeps the RAW buildings document and its
        # baseline bytes — a building session edits the document
        # (one row), and the buildings file joins the dirty check
        # and the push set exactly like roads (its own baseline,
        # its own twin). The drawn rows keep their source row
        # indices (buildings_src_index) because a building's
        # identity IS its row index.
        self.buildings = []         # [[x, z, w, d, h, type]]
        self.buildings_src_index = []   # doc row per drawn row
        self.buildings_doc = None   # parsed buildings.json doc
        self.buildings_baseline = None  # downloaded bytes
        self.water = []             # [(kind, [[x, z], ...])]

    @property
    def name(self):
        """The zone's display name (zone.json), else its id."""
        if isinstance(self.meta, dict):
            return str(self.meta.get("name") or self.zone_id)
        return self.zone_id

    def current_roads_bytes(self):
        """The bytes a save would push for this zone's roads.json."""
        return serialize_roads(self.roads or {})

    def is_dirty(self):
        """True when the working roads differ from the download."""
        return self.baseline is not None \
            and self.current_roads_bytes() != self.baseline

    # -- buildings document state (1.3.0) ---------------------------

    def adopt_buildings(self, raw, doc):
        """Take a downloaded buildings.json (raw bytes + parsed
        doc) as the model's buildings state: document, baseline,
        drawn rows and their source indices, together."""
        self.buildings_doc = doc
        self.buildings_baseline = raw
        self.buildings, self.buildings_src_index = \
            parse_buildings_indexed(doc)

    def current_buildings_bytes(self):
        """The bytes a save would push for buildings.json (the
        document serialised exactly as it was downloaded — the
        converter's compact form round-trips byte-for-byte)."""
        if self.buildings_doc is None:
            return None
        return serialize_json_compact(self.buildings_doc)

    def is_buildings_dirty(self):
        """True when the working buildings differ from download."""
        return self.buildings_baseline is not None \
            and self.current_buildings_bytes() is not None \
            and self.current_buildings_bytes() != self.buildings_baseline

    def build_targets(self):
        """
        The push set for this zone: each dirty file plus its
        regenerated .js twin (the twins must never disagree with
        their files). An empty list when the zone is clean.
        """
        targets = []
        if self.is_dirty():
            blob = self.current_roads_bytes()
            targets += [
                (GAME_REPO, zone_roads_path(self.zone_id), blob,
                 f"Detail Editor: update {zone_roads_path(self.zone_id)}"),
                (GAME_REPO, zone_roads_js_path(self.zone_id),
                 roads_js_twin(self.zone_id, self.name, blob),
                 f"Detail Editor: update {zone_roads_js_path(self.zone_id)}"),
            ]
        if self.is_buildings_dirty():
            blob = self.current_buildings_bytes()
            targets += [
                (GAME_REPO, zone_buildings_path(self.zone_id), blob,
                 f"Detail Editor: update {zone_buildings_path(self.zone_id)}"),
                (GAME_REPO, zone_buildings_js_path(self.zone_id),
                 buildings_js_twin(self.zone_id, self.name,
                                   self.buildings_doc),
                 f"Detail Editor: update {zone_buildings_js_path(self.zone_id)}"),
            ]
        return targets

    def adopt_fresh(self, fresh):
        """
        Adopt re-downloaded bytes after a round trip (the suite
        rule: what the editor shows after a save is the GitHub copy,
        not pre-push memory). The .json files carry model state;
        the twins are regenerated from them.
        """
        blob = fresh.get(zone_roads_path(self.zone_id))
        if blob is not None:
            self.baseline = blob
            self.roads = json.loads(blob.decode("utf-8"))
        blob = fresh.get(zone_buildings_path(self.zone_id))
        if blob is not None:
            self.adopt_buildings(
                blob, json.loads(blob.decode("utf-8")))


# ---------------------------------------------------------------------------
# The store: downloads + the save round trip
# ---------------------------------------------------------------------------

class DetailData:
    """
    Downloads (through the suite's shared cache) and the save.

    fetcher:    a suite_core.shared_cache.CachedFetcher — the one
                download door (shared cache, manifest freshness).
    fetch_file: github_sync.fetch_file (raw; the manifest itself is
                never served from cache — it IS the freshness
                source).
    """

    def __init__(self, fetcher, fetch_file):
        self._fetcher = fetcher
        self._fetch_file = fetch_file
        self.manifest = None        # parsed map-manifest.json
        self.zones = {}             # zone id -> ZoneModel

    # -- downloads ----------------------------------------------------

    def load_manifest(self):
        """Fetch the map manifest FRESH and register its sha256s
        with the cache fetcher. Returns the map_version string."""
        raw, err = self._fetch_file(REPO, MANIFEST_PATH)
        if raw is None:
            raise DetailDataError(
                f"Could not download the map manifest: {err}")
        try:
            self.manifest = json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise DetailDataError(f"The map manifest is unreadable: {e}")
        self._fetcher.register_manifest(raw)
        return str(self.manifest.get("map_version") or "")

    def load_zone(self, zone_id, progress=None):
        """
        Download ONE zone's zone.json + roads.json through the
        shared cache and parse them (roads only — never lifts,
        never elev: this app does not touch elevation). Already-
        loaded zones return from memory: the app never holds more
        zones than were opened.
        """
        if zone_id in self.zones and self.zones[zone_id].roads is not None:
            return self.zones[zone_id]
        model = ZoneModel(zone_id)
        for path, attr in ((zone_meta_path(zone_id), "meta"),
                           (zone_roads_path(zone_id), "roads")):
            raw, err = self._fetcher.fetch_progress(
                REPO, path, progress=progress)
            if raw is None:
                raise DetailDataError(
                    f"Could not download {path}: {err}")
            if attr == "roads":
                model.baseline = raw
            try:
                setattr(model, attr, json.loads(raw.decode("utf-8")))
            except Exception as e:
                raise DetailDataError(f"{path} is unreadable: {e}")
        # The colour views' dressing (1.2.0): buildings + water
        # ride the same download, through the same shared cache —
        # but FAIL OPEN. A zone that lacks them, or a fetch that
        # fails, leaves the lists empty and the piece still opens;
        # dressing never blocks the work. Buildings keep their
        # raw bytes + parsed document too (1.3.0): a building
        # session may edit them later, and re-downloading then
        # would break the "what you see is the download" rule.
        try:
            raw, _err = self._fetcher.fetch_progress(
                REPO, zone_buildings_path(zone_id), progress=progress)
            if raw is not None:
                model.adopt_buildings(
                    raw, json.loads(raw.decode("utf-8")))
        except Exception:
            pass  # dressing only — see the note above
        try:
            raw, _err = self._fetcher.fetch_progress(
                REPO, zone_water_path(zone_id), progress=progress)
            if raw is not None:
                model.water = parse_water(
                    json.loads(raw.decode("utf-8")))
        except Exception:
            pass  # dressing only — see the note above
        self.zones[zone_id] = model
        return model

    def load_zone_buildings(self, model, progress=None):
        """
        Fetch a loaded zone's buildings.json FOR EDITING (the
        building-open path). Unlike the context dressing this is
        FATAL on failure: a building cannot open on data the
        editor does not actually hold. Returns the parsed doc.
        """
        raw, err = self._fetcher.fetch_progress(
            REPO, zone_buildings_path(model.zone_id),
            progress=progress)
        if raw is None:
            raise DetailDataError(
                f"Could not download "
                f"{zone_buildings_path(model.zone_id)}: {err}")
        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise DetailDataError(
                f"{zone_buildings_path(model.zone_id)} is "
                f"unreadable: {e}")
        if not isinstance(doc, dict) \
                or not isinstance(doc.get("buildings"), list):
            raise DetailDataError(
                f"{zone_buildings_path(model.zone_id)} does not "
                "hold a buildings list — the building can't open.")
        model.adopt_buildings(raw, doc)
        return doc

    # -- the save -------------------------------------------------------

    def save_zone(self, model, local_dir, sync):
        """
        One full round-trip save for a zone, by the standing rule,
        through suite_core.github_sync.round_trip:
          local save -> push (one connection, closed) -> proof
          download (fresh connection) -> adopt the downloaded
          bytes as the live model.
        sync: the github_sync module (injected — the harness stubs
        transport the same way the sibling harnesses do).
        Returns (ok, message). A clean zone is a successful no-op.
        """
        targets = model.build_targets()
        if not targets:
            return True, "Nothing to save — no changes."

        def verify(fresh):
            # The proof copy of each pushed .json must be exactly
            # the bytes we pushed (and must parse) before it is
            # adopted. Only files in the push set are checked — a
            # roads-only save never consults the buildings copy.
            pushed = {t[1] for t in targets}
            for path, current in (
                    (zone_roads_path(model.zone_id),
                     model.current_roads_bytes()),
                    (zone_buildings_path(model.zone_id),
                     model.current_buildings_bytes())):
                if path not in pushed:
                    continue
                blob = fresh.get(path)
                if blob != current:
                    return ("The downloaded copy does not match "
                            "what was pushed — not adopting it.",
                            None)
                try:
                    json.loads(blob.decode("utf-8"))
                except Exception as e:
                    return (f"The downloaded copy is unreadable: "
                            f"{e}", None)
            return None

        ok, message, fresh = sync.round_trip(
            targets, local_dir, sync.open_connection,
            sync.push_targets, sync.fetch_file, verify=verify,
            success_message="Saved to GitHub and verified — the "
                            "copy on screen is the downloaded one.")
        if ok and fresh:
            model.adopt_fresh(fresh)
        return ok, message


# ---------------------------------------------------------------------------
# A piece session: one open piece, its working Element, its origin
# ---------------------------------------------------------------------------

class PieceSession:
    """
    One opened piece: where it lives (zone, category, and the index
    it was found at), the record as opened (the template every
    write-back preserves), its origin points (the fingerprint a
    later save re-finds the record by — indices shift when a split
    adds a record, origins do not), and the working Element the
    user edits.
    """

    # The page-kind surface the app + canvas share with
    # BuildingSession (1.3.0): what this page edits, how the
    # canvas draws it, whether its tab offers a rename pencil.
    kind = "road"
    face_mode = "ribbon"
    can_rename = True

    def __init__(self, model, category, index, how):
        self.model = model                      # ZoneModel
        self.category = category
        self.index = index
        self.how = how                          # match strength
        record = model.roads[category][index]
        self.template = dict(record)
        # The name as opened (1.4.0): rename() edits the template,
        # so the pristine name lives here — a Discard restores it,
        # and a save rebind advances it with the template.
        self.origin_name = record.get("name")
        self.origin_pts = [list(p) for p in record.get("pts") or []]
        self.element = element_from_record(record)
        self.dirty = False

    @property
    def name(self):
        """The piece's street name (or the game's placeholder)."""
        return self.template.get("name") or UNNAMED_NAME

    @property
    def zone_id(self):
        return self.model.zone_id

    def title(self):
        """Tab title: the piece's name (its zone rides along in the
        page's info pane)."""
        return self.name

    def mark_dirty(self):
        """Note an edit. Under the cache + Apply workflow (1.4.0)
        the edit lives only in this working copy until the user
        presses Apply — the session is dirty until its Apply
        round trip lands and rebinds it."""
        self.dirty = True

    def rename(self, raw):
        """
        Rename this piece — and only this piece. The name rides
        the session TEMPLATE, so the write-back carries it into
        every record the piece becomes (a split's records share
        the new name, exactly as they shared the old one), and the
        existing save round trip pushes it like any other changed
        variable. Pieces that merely happen to share the old name
        are NOT renamed: their records are never touched. The text
        is trimmed; an empty field means "no name", which the game
        writes as UNNAMED_NAME. Returns the new name, or None when
        nothing actually changed.
        """
        new = (raw or "").strip() or UNNAMED_NAME
        if new == (self.template.get("name") or ""):
            return None
        self.template["name"] = new
        return new

    def apply_to_doc(self):
        """
        Write the working Element back into the zone document:
        re-find the record by its ORIGIN points (indices may have
        shifted since the piece was opened), then splice the
        element's records in its place. Returns the number of
        records the piece now occupies (1 normally, 2+ after a
        split). Raises DetailDataError when the origin is gone
        (the file changed under the session — say so, never guess).
        """
        records = self.model.roads.get(self.category) or []
        idx = None
        for i, rec in enumerate(records):
            if _pts_match(rec.get("pts") or [], self.origin_pts):
                idx = i
                break
        if idx is None:
            raise DetailDataError(
                "This piece could not be found in the downloaded "
                "zone data any more — it may have changed on GitHub "
                "since it was opened. Nothing was saved.")
        new_records = records_from_element(self.template, self.element)
        records[idx:idx + 1] = new_records
        self.index = idx
        return len(new_records)

    def rebind_after_save(self):
        """
        After a successful save + adopt: the session's origin
        becomes its FIRST record's saved points, its template that
        record, and the dirty flag clears — so a second save finds
        the piece again. (After a split, further edits ride on the
        first resulting record; the other records are saved data
        now, openable as their own pieces.)
        """
        chains = self.element.chains()
        first_pts = []
        if chains:
            first_pts = [[self.element.points[j][0],
                          self.element.points[j][1]]
                         for j in chains[0]]
        records = self.model.roads.get(self.category) or []
        for i, rec in enumerate(records):
            if first_pts and _pts_match(rec.get("pts") or [], first_pts):
                self.index = i
                self.template = dict(rec)
                self.origin_name = rec.get("name")
                self.origin_pts = [list(p)
                                   for p in rec.get("pts") or []]
                break
        self.dirty = False

    def discard_edits(self):
        """
        Drop every unapplied edit (the cache + Apply workflow's
        Discard, 1.4.0): the working Element is rebuilt from the
        record as opened (or as last applied — the template and
        origin name advance with every save rebind), and the
        dirty flag clears. The zone document is never touched —
        an unapplied edit never reached it.
        """
        self.template["name"] = self.origin_name
        self.element = element_from_record(self.template)
        self.dirty = False


# ---------------------------------------------------------------------------
# Buildings (1.3.0): identity, the rectangle-law element, the session
# ---------------------------------------------------------------------------

# Identity tolerance (metres) for matching a zone row against the
# building a handoff describes: the handoff's numbers are copies
# of the row's own values, so anything beyond float noise means
# the record changed hands since it was sent.
BUILDING_MATCH_TOL_M = 0.05

# The smallest width/depth a drag may leave a building. The record
# could hold less, but a sub-metre "building" is a collapsed
# shape, not an edit — the clamp keeps every reachable state a
# real rectangle (the rectangle law).
BUILDING_MIN_SIZE_M = 1.0

# Ring edges in ring order; each runs corner -> next corner.
_EDGES = ("N", "E", "S", "W")
_EDGE_CORNERS = {"N": (0, 1), "E": (1, 2), "S": (2, 3), "W": (3, 0)}


def building_rows_match(a, b, tol=BUILDING_MATCH_TOL_M):
    """True when two [x, z, w, d, h, type] rows describe the same
    building: position, size and height within tol, type equal."""
    try:
        if len(a) < 6 or len(b) < 6:
            return False
        if int(a[5]) != int(b[5]):
            return False
        return all(abs(float(a[i]) - float(b[i])) <= tol
                   for i in range(5))
    except Exception:
        return False


def building_handoff_row(doc):
    """The [x, z, w, d, h, type] row a building handoff claims
    (its identity), or None when the payload lacks the numbers."""
    try:
        return [float(doc["x"]), float(doc["z"]), float(doc["w"]),
                float(doc["d"]), float(doc["h"]), int(doc["type"])]
    except Exception:
        return None


def verify_building(model, doc):
    """
    Identity-check a building handoff against the model's
    downloaded buildings document: the record AT the handoff's
    index must still be the building the handoff describes.
    Returns (index, row). Raises DetailDataError in plain words
    when the building cannot be identified — nothing opens on a
    stranger.
    """
    rows = None
    if isinstance(model.buildings_doc, dict):
        rows = model.buildings_doc.get("buildings")
    if rows is None:
        raise DetailDataError(
            "The zone's buildings data isn't downloaded, so the "
            "building can't be checked — nothing was opened.")
    try:
        index = int(doc.get("index"))
    except Exception:
        raise DetailDataError(
            "The Building Editor's handoff doesn't say which "
            "building it sent — nothing was opened.")
    if index < 0 or index >= len(rows):
        raise DetailDataError(
            "That building isn't in the downloaded zone data any "
            "more — nothing was opened.")
    claimed = building_handoff_row(doc)
    if claimed is None \
            or not building_rows_match(rows[index], claimed):
        raise DetailDataError(
            "That building has changed since it was sent here — "
            "nothing was opened.")
    return index, rows[index]


class BuildingElement(Element):
    """
    One building's footprint as an editable element: the ring of
    its axis-aligned box — 4 corners plus any number of points
    riding its edges — under the RECTANGLE LAW. The record
    ([x, z, w, d, h, type]) can only hold an axis-aligned
    rectangle, so the element's canonical state is the four edges
    (west x0, north z0, east x1, south z1) plus, per edge, the
    fractions where extra points ride. points/segments are
    REBUILT from that state after every operation, which makes
    unsaveable states unreachable rather than refused after the
    fact:
      * dragging a corner moves its two edges (the adjacent
        corners follow along their own edges);
      * dragging an edge point moves that whole edge (both its
        corners), the point riding at its fraction;
      * corners can never be deleted (a building without its
        corners is not a building); edge points dissolve freely;
      * segment/section surgery does not exist here — the ring
        is closed by construction (the app also disables those
        tools on a building page).
    Edge points are view-layer working detail: they collapse
    back to the four edges when the record is derived, exactly
    as the rectangle law states. Drags clamp at
    BUILDING_MIN_SIZE_M so a rectangle can never invert.
    """

    # The whole-piece delete refusal on a building page names the
    # app that owns whole-building removal (the canvas reads it).
    whole_delete_owner = "the Building Editor"

    def __init__(self, row):
        x, z, w, d = (float(row[0]), float(row[1]),
                      float(row[2]), float(row[3]))
        self._edges = [x - w / 2.0, z - d / 2.0,
                       x + w / 2.0, z + d / 2.0]
        self._fracs = {e: [] for e in _EDGES}
        self._kinds = []
        self._rebuild()

    # -- canonical state <-> the Element face ---------------------

    def _edge_point(self, edge, f):
        """The world point at fraction f along an edge (fractions
        run corner -> next corner, in ring order)."""
        x0, z0, x1, z1 = self._edges
        if edge == "N":
            return [x0 + f * (x1 - x0), z0]
        if edge == "E":
            return [x1, z0 + f * (z1 - z0)]
        if edge == "S":
            return [x1 - f * (x1 - x0), z1]
        return [x0, z1 - f * (z1 - z0)]     # "W"

    def _rebuild(self):
        """Rebuild points/segments from the canonical state:
        corners NW, NE, SE, SW with each edge's riding points
        between its corners, ring-closed."""
        x0, z0, x1, z1 = self._edges
        corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]
        points, kinds = [], []
        for ci in range(4):
            points.append(list(corners[ci]))
            kinds.append(("corner", ci))
            edge = _EDGES[ci]
            for f in self._fracs[edge]:
                points.append(self._edge_point(edge, f))
                kinds.append(("edge", edge, f))
        n = len(points)
        self.points = points
        self.payloads = [None] * n
        self.segments = [[i, (i + 1) % n] for i in range(n)]
        self._kinds = kinds

    @property
    def edges(self):
        """(west, north, east, south) — the rectangle itself."""
        return tuple(self._edges)

    def point_kind(self, i):
        """("corner", corner_index) or ("edge", edge, fraction)."""
        return self._kinds[i]

    def row(self, h, type_code):
        """The record this rectangle writes back, with the carried
        height/type: centre + size derived from the edges,
        rounded to the data's own precision (the zone files'
        values carry at most 2 decimals)."""
        x0, z0, x1, z1 = self._edges
        return [round((x0 + x1) / 2.0, 2),
                round((z0 + z1) / 2.0, 2),
                round(x1 - x0, 2), round(z1 - z0, 2),
                h, type_code]

    # -- snapshot / restore (undo carries the canonical state) --

    def snapshot(self):
        return {"building": True,
                "edges": list(self._edges),
                "fracs": {e: list(fs)
                          for e, fs in self._fracs.items()}}

    def restore(self, snap):
        if isinstance(snap, dict) and snap.get("building"):
            self._edges = [float(v) for v in snap["edges"]]
            self._fracs = {
                e: sorted(float(f)
                          for f in snap["fracs"].get(e, []))
                for e in _EDGES}
            self._rebuild()
        else:
            # A base-class triple (never produced for a building
            # in practice): best effort, as the base defines it.
            super().restore(snap)

    # -- the verbs -------------------------------------------------

    def move_point(self, i, x, z):
        """Drag point i. A corner moves its two edges (the
        adjacent corners follow along theirs); an edge point
        moves its whole edge along the edge's normal, riding at
        its fraction — the tangential part of the drag is not
        an edit the record can hold, so it does not happen.
        Clamped so width/depth stay >= BUILDING_MIN_SIZE_M."""
        kind = self._kinds[i]
        x0, z0, x1, z1 = self._edges
        m = BUILDING_MIN_SIZE_M
        if kind[0] == "corner":
            ci = kind[1]
            if ci in (0, 3):        # west corners: the west edge
                x0 = min(float(x), x1 - m)
            else:                   # east corners: the east edge
                x1 = max(float(x), x0 + m)
            if ci in (0, 1):        # north corners
                z0 = min(float(z), z1 - m)
            else:                   # south corners
                z1 = max(float(z), z0 + m)
        else:
            edge = kind[1]
            if edge == "N":
                z0 = min(float(z), z1 - m)
            elif edge == "S":
                z1 = max(float(z), z0 + m)
            elif edge == "W":
                x0 = min(float(x), x1 - m)
            else:                   # "E"
                x1 = max(float(x), x0 + m)
        self._edges = [x0, z0, x1, z1]
        self._rebuild()

    def edge_of_segment(self, a, b):
        """The ring edge ("N"/"E"/"S"/"W") a segment's endpoints
        lie on, or None. Every ring segment lies on one edge."""
        ka, kb = self._kinds[a], self._kinds[b]
        for kind in (ka, kb):
            if kind[0] == "edge":
                return kind[1]
        pair = {ka[1], kb[1]}       # corner to corner
        for edge, (c0, c1) in _EDGE_CORNERS.items():
            if pair == {c0, c1}:
                return edge
        return None

    def _fraction_on(self, edge, x, z):
        """The fraction of world point (x, z) along an edge."""
        x0, z0, x1, z1 = self._edges
        if edge == "N":
            return (x - x0) / (x1 - x0) if x1 > x0 else 0.5
        if edge == "S":
            return (x1 - x) / (x1 - x0) if x1 > x0 else 0.5
        if edge == "E":
            return (z - z0) / (z1 - z0) if z1 > z0 else 0.5
        return (z1 - z) / (z1 - z0) if z1 > z0 else 0.5   # "W"

    def _endpoint_fraction(self, edge, i):
        """Point i's fraction along edge: a riding point's own,
        a corner's 0 or 1 by the edge's direction."""
        kind = self._kinds[i]
        if kind[0] == "edge":
            return kind[2]
        c0, _c1 = _EDGE_CORNERS[edge]
        return 0.0 if kind[1] == c0 else 1.0

    def _insert_fraction(self, edge, f):
        """Add a riding point at fraction f on an edge and return
        its new point index (fractions are unique per edge)."""
        self._fracs[edge].append(f)
        self._fracs[edge].sort()
        self._rebuild()
        for i, kind in enumerate(self._kinds):
            if kind[0] == "edge" and kind[1] == edge \
                    and kind[2] == f:
                return i
        return 0                    # unreachable

    def add_point_on_segment(self, seg_i, x, z, payload=None):
        """Split an edge with a new riding point at the click's
        fraction, kept inside the clicked segment (never on top
        of an existing point), so it is always a real new point.
        Returns the new point's index."""
        a, b = self.segments[seg_i]
        edge = self.edge_of_segment(a, b)
        if edge is None:
            return a                # unreachable by construction
        fa = self._endpoint_fraction(edge, a)
        fb = self._endpoint_fraction(edge, b)
        lo, hi = min(fa, fb), max(fa, fb)
        keep = 0.1 * (hi - lo)      # stay clear of the ends
        f = min(max(self._fraction_on(edge, x, z), lo + keep),
                hi - keep)
        return self._insert_fraction(edge, f)

    def add_point_at_end(self, end_i, x, z, payload=None):
        """A closed ring has no ends to extend, and the canvas
        never arms this (every ring point has two neighbours).
        Kept total for safety: the point joins the nearest edge
        at its projected fraction."""
        best = None
        for edge in _EDGES:
            f = min(max(self._fraction_on(edge, x, z), 0.05), 0.95)
            px, pz = self._edge_point(edge, f)
            dist = (px - x) ** 2 + (pz - z) ** 2
            if best is None or dist < best[0]:
                best = (dist, edge, f)
        _dist, edge, f = best
        if all(abs(f - g) > 1e-4 for g in self._fracs[edge]):
            return self._insert_fraction(edge, f)
        for i, kind in enumerate(self._kinds):
            if kind[0] == "edge" and kind[1] == edge:
                return i
        return end_i                # unreachable

    # -- deletes: edge points dissolve, corners never do ----------

    def point_delete_refusal(self, i):
        if self._kinds[i][0] == "corner":
            return ("That point is a corner — a building's "
                    "corners are its shape, and deleting one "
                    "isn't an edit this record can hold. Drag "
                    "the corner to resize instead.")
        return None

    def delete_preview(self, indices):
        keep = [i for i in indices
                if self._kinds[i][0] == "edge"]
        note = None
        if len(keep) != len(indices):
            note = ("Corners can't be deleted here, so they were "
                    "kept — removing a whole building is the "
                    "Building Editor's job.")
        return keep, note

    def delete_point(self, i):
        """Dissolve an edge point (its fraction goes). A corner
        delete changes nothing — the canvas asks
        point_delete_refusal() first and says why."""
        kind = self._kinds[i]
        if kind[0] == "corner":
            return
        self._fracs[kind[1]].remove(kind[2])
        self._rebuild()

    def delete_points(self, indices):
        """Delete the EDGE points among indices (the lasso case);
        corners in the set are kept — see delete_preview.
        Returns the count actually deleted."""
        drop = {}
        gone = 0
        for i in indices:
            kind = self._kinds[i]
            if kind[0] == "edge":
                drop.setdefault(kind[1], []).append(kind[2])
                gone += 1
        for edge, fs in drop.items():
            self._fracs[edge] = [f for f in self._fracs[edge]
                                 if f not in fs]
        if gone:
            self._rebuild()
        return gone

    # -- density on edges (the building's Resegment/Coarsen) ------

    def _wanted_fracs(self, edge, target_gap_m=8.0):
        """The fractions Resegment wants on an edge: evenly
        spaced so no gap is much wider than target_gap_m, and
        always at least the midpoint."""
        x0, z0, x1, z1 = self._edges
        length = (x1 - x0) if edge in ("N", "S") else (z1 - z0)
        if length <= 0:
            return []
        steps = max(2, math.ceil(length / target_gap_m))
        return [k / steps for k in range(1, steps)]

    def resegment_additions(self, edges, target_gap_m=8.0):
        """How many points resegment_edges WOULD add (a dry run,
        so the caller can snapshot only for a real change)."""
        n = 0
        for edge in edges:
            have = self._fracs[edge]
            n += sum(1 for f in self._wanted_fracs(edge,
                                                   target_gap_m)
                     if all(abs(f - g) > 1e-4 for g in have))
        return n

    def edge_point_count(self, edge):
        """Riding points currently on an edge."""
        return len(self._fracs[edge])

    def resegment_edges(self, edges, target_gap_m=8.0):
        """Add riding points along the given edges so no gap is
        much wider than target_gap_m (every edge at least
        halves): a building's edges start bare — unlike a road's
        points, these are MADE here, as view-layer detail.
        Returns the count added."""
        added = 0
        for edge in edges:
            have = self._fracs[edge]
            for f in self._wanted_fracs(edge, target_gap_m):
                if all(abs(f - g) > 1e-4 for g in have):
                    have.append(f)
                    added += 1
            have.sort()
        if added:
            self._rebuild()
        return added

    def coarsen_edges(self, edges):
        """Remove every riding point on the given edges (corners
        stay — a coarsened building is its bare rectangle).
        Returns the count removed."""
        gone = 0
        for edge in edges:
            gone += len(self._fracs[edge])
            self._fracs[edge] = []
        if gone:
            self._rebuild()
        return gone

    # -- ring surgery: no building meaning, safe no-ops -----------
    # The ring is closed by construction. The app disables these
    # tools on a building page; the no-ops keep any stray call
    # harmless (add_segment must never grow a chord across the
    # ring, delete_section must never eat the ring).

    def add_segment(self, a, b):
        return False

    def delete_segment(self, seg_index):
        return None

    def delete_section(self, chain, lo_pos, hi_pos):
        return 0


class BuildingSession:
    """
    One opened building: its identity (zone + the index of its
    record in the zone's buildings.json), the record as handed
    over and verified (the origin every save re-checks), the
    handoff's display fields (a record carries no name — the
    name lives only in the handoff), and the working
    BuildingElement.

    The save contract: apply_to_doc() writes ONLY the record at
    the index, and only when that record still matches the
    origin within BUILDING_MATCH_TOL_M; height and type are
    carried from the live record, never edited. On mismatch it
    refuses in plain words and writes nothing.
    """

    kind = "building"
    face_mode = "footprint"
    can_rename = False
    category = None     # a building page has no road category

    def __init__(self, model, index, row, doc):
        self.model = model                      # ZoneModel
        self.index = index
        self.how = "handoff"
        self.origin_row = list(row)
        self.handed_name = str(doc.get("name") or "").strip()
        self.type_label = str(doc.get("type_label") or "").strip()
        self.element = BuildingElement(row)
        # For the app's generic page plumbing: the page excludes
        # its building from the CONTEXT by index, never by
        # points. origin_pts is the ring's corners, which no road
        # record's points can equal, so the road exclusion stays
        # inert on a building page.
        self.origin_pts = [list(p)
                           for p in self.element.points[:4]]
        self.dirty = False

    @property
    def zone_id(self):
        return self.model.zone_id

    @property
    def name(self):
        """Display name: the handoff's (records carry none)."""
        return self.handed_name or f"Building #{self.index}"

    @property
    def building_type(self):
        """The record's type code (the canvas colours by it)."""
        try:
            return int(self.origin_row[5])
        except Exception:
            return 0

    @property
    def piece_width(self):
        """View padding when fitting (a building has no ribbon
        width to draw; the page fits its footprint + this)."""
        return 2.0

    def title(self):
        """Tab title: the handoff's name (or its number)."""
        return self.name

    def mark_dirty(self):
        """Note an edit. Under the cache + Apply workflow (1.4.0)
        the edit lives only in this working copy until the user
        presses Apply."""
        self.dirty = True

    def apply_to_doc(self):
        """
        Splice the edited rectangle into the zone's buildings
        document — the record at the index ONLY, after verifying
        it is still the building that was sent here. Returns 1
        (one record written). Raises DetailDataError in plain
        words on any mismatch; nothing is written then.
        """
        doc = self.model.buildings_doc
        rows = doc.get("buildings") if isinstance(doc, dict) \
            else None
        if rows is None or self.index >= len(rows):
            raise DetailDataError(
                "That building isn't in the zone's buildings "
                "data any more — nothing was written.")
        current = rows[self.index]
        if not building_rows_match(current, self.origin_row):
            raise DetailDataError(
                "That building has changed since it was sent "
                "here — nothing was written.")
        new_row = self.element.row(current[4], current[5])
        rows[self.index] = new_row
        # Keep the drawn context rows in step until the adopt
        # (the round trip re-parses them from the proof copy).
        for pos, src in enumerate(self.model.buildings_src_index):
            if src == self.index \
                    and pos < len(self.model.buildings):
                self.model.buildings[pos] = [
                    float(new_row[0]), float(new_row[1]),
                    float(new_row[2]), float(new_row[3]),
                    float(new_row[4]), int(new_row[5])]
                break
        self.origin_row = list(new_row)
        return 1

    def rebind_after_save(self):
        """
        After a successful save + adopt: the origin becomes the
        saved record, the working element collapses back to the
        saved rectangle (edge points were view-layer detail and
        fold away on save, per the rectangle law), and the dirty
        flag clears.
        """
        doc = self.model.buildings_doc
        rows = doc.get("buildings") if isinstance(doc, dict) \
            else None
        if rows and 0 <= self.index < len(rows):
            self.origin_row = list(rows[self.index])
        self.element = BuildingElement(self.origin_row)
        self.origin_pts = [list(p)
                           for p in self.element.points[:4]]
        self.dirty = False

    def discard_edits(self):
        """
        Drop every unapplied edit (the cache + Apply workflow's
        Discard, 1.4.0): the working ring is rebuilt from the
        origin row (the record as handed over, or as last
        applied — the origin advances with every save rebind),
        and the dirty flag clears. The zone document is never
        touched — an unapplied edit never reached it.
        """
        self.element = BuildingElement(self.origin_row)
        self.origin_pts = [list(p)
                           for p in self.element.points[:4]]
        self.dirty = False
