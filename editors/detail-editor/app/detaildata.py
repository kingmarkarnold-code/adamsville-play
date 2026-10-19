#!/usr/bin/env python3
"""
Adamsville Detail Editor (Native) — the data layer.

Everything this app reads or writes, in one module:

  * THE HANDOFF — the file the Map Editor's Detail Edit button
    writes (~/.local/share/adamsville-suite/open-in-detail-
    editor.json), consumed with the suite's lifecycle: a FRESH
    handoff (< 48 hours old) applies ONCE and the file is deleted;
    an unparseable file is renamed .bad so it cannot loop; a stale
    one is removed unread. (The Map Editor's own consumption of
    the Building Editor's street-jump handoff is the precedent.)

  * DOWNLOADS — only what the open piece needs: the map manifest
    (fresh, it is the freshness source) and ONE zone's zone.json +
    roads.json, through the suite's shared download cache
    (suite_core.shared_cache). No whole-world load, ever. And NO
    elevation data: this app never reads elev.json, lifts files or
    the ys heights as heights — see the adapter note below.

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
    round_trip(): local save -> push (roads.json + its regenerated
    roads.js twin, one connection, closed) -> fresh download on a
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
from datetime import datetime, timezone
from pathlib import Path

from element import Element

# This editor's version (About dialog, the roads.js twin header).
EDITOR_VERSION = "1.0.0"

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


# ---------------------------------------------------------------------------
# The handoff (Map Editor -> Detail Editor)
# ---------------------------------------------------------------------------

def handoff_path():
    """Where the suite's handoffs live (the shared suite dir)."""
    return (Path.home() / ".local" / "share" / "adamsville-suite"
            / HANDOFF_NAME)


def read_handoff():
    """
    Consume the Detail Edit handoff, once, by the suite lifecycle.
    Returns the handoff document dict when a FRESH one was waiting,
    else None. The file is deleted either way (a stale one is
    simply removed); an unparseable file is renamed .bad so it
    cannot loop. A document is:
        {"element_type": "road", "zone": <zone id>, "category": ...,
         "name": ..., "x": ..., "z": ..., "points": [[x, z], ...],
         "writtenBy": ..., "timestamp": <iso>}
    """
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
    if doc.get("element_type") not in (None, "road"):
        return None  # not for this build (roads are the wired type)
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


def find_piece(roads_doc, category, name, points, centre=None):
    """
    Locate the handoff's piece in a zone's roads document.
    Returns (category, index, how) or None. Match order (strongest
    first): the exact points under the handed category+name; the
    named records nearest the handed centre; any record in the
    category nearest the centre. `how` says which rule matched, so
    the UI can report honestly how sure the match is.
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
    # 2/3. Nearest centroid — named records first, then any.
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
        if best is not None:
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

    def build_targets(self):
        """
        The push set for this zone when dirty: roads.json plus its
        regenerated roads.js twin (they must never disagree). An
        empty list when the zone is clean.
        """
        if not self.is_dirty():
            return []
        blob = self.current_roads_bytes()
        return [
            (GAME_REPO, zone_roads_path(self.zone_id), blob,
             f"Detail Editor: update {zone_roads_path(self.zone_id)}"),
            (GAME_REPO, zone_roads_js_path(self.zone_id),
             roads_js_twin(self.zone_id, self.name, blob),
             f"Detail Editor: update {zone_roads_js_path(self.zone_id)}"),
        ]

    def adopt_fresh(self, fresh):
        """
        Adopt re-downloaded bytes after a round trip (the suite
        rule: what the editor shows after a save is the GitHub copy,
        not pre-push memory). Only the roads.json carries model
        state; the twin is regenerated from it.
        """
        blob = fresh.get(zone_roads_path(self.zone_id))
        if blob is not None:
            self.baseline = blob
            self.roads = json.loads(blob.decode("utf-8"))


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
        self.zones[zone_id] = model
        return model

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
            # The proof copy's roads.json must be exactly the bytes
            # we pushed (and must parse) before it is adopted.
            blob = fresh.get(zone_roads_path(model.zone_id))
            if blob != model.current_roads_bytes():
                return ("The downloaded copy does not match what "
                        "was pushed — not adopting it.", None)
            try:
                json.loads(blob.decode("utf-8"))
            except Exception as e:
                return (f"The downloaded copy is unreadable: {e}",
                        None)
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

    def __init__(self, model, category, index, how):
        self.model = model                      # ZoneModel
        self.category = category
        self.index = index
        self.how = how                          # match strength
        record = model.roads[category][index]
        self.template = dict(record)
        self.origin_pts = [list(p) for p in record.get("pts") or []]
        self.element = element_from_record(record)
        self.dirty = False

    @property
    def name(self):
        """The piece's street name (or the suite's placeholder)."""
        return self.template.get("name") or "Unnamed segment"

    @property
    def zone_id(self):
        return self.model.zone_id

    def title(self):
        """Tab title: the piece's name (its zone rides along in the
        page's info pane)."""
        return self.name

    def mark_dirty(self):
        """Note an edit (the app saves per zone; a session is dirty
        until its zone's save lands and rebinds it)."""
        self.dirty = True

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
                self.origin_pts = [list(p)
                                   for p in rec.get("pts") or []]
                break
        self.dirty = False
