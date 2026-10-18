#!/usr/bin/env python3
"""
Adamsville Elevation Editor (Native) 1.0.0 — data layer.

WHAT THIS MODULE OWNS
  * downloading the game's data (manifest, elevation grid, one
    zone at a time) through the suite's shared cache;
  * the SELECTED ROAD + STRETCH working model (a HillSession);
  * building the write-back: new terrain lifts + re-draped roads,
    serialized byte-stably so untouched files never change;
  * the round-trip save (Joshua's standing rule): save locally ->
    push on one connection -> close it -> re-download on a fresh
    connection -> adopt the proof copy.

THE EDIT ITSELF (Joshua's design, ELEVATION-EDITOR-DESIGN.md):
the terrain moves, the road follows. A hill is a set of gaussian
TERRAIN LIFTS appended to the zone's lifts.json — the game's own
terrain-shaping mechanism (heightAt applies them at runtime) — and
every road the lifts touch is re-draped to the new ground
(ys = terrainMeshY + 0.01, the converter's formula, via the suite
core's ground port). Only what changed is written: untouched
stations keep their shipped ys byte-for-byte, untouched roads and
files are never pushed.

Everything generic (GitHub transport, cache, ground math, hill
fitting) lives in suite_core; this module is the elevation-specific
glue. Joshua's rule: all code commented.
"""

import copy
import hashlib
import json
import math
from datetime import date
from pathlib import Path

from suite_core import ground as ground_mod
from suite_core.ground import (GroundModel, GroundWithLifts, LiftField,
                               densify_range, fit_gaussian_profile,
                               point_at_arc, polyline_arcs)

# The one repo everything lives in now.
REPO = "kingmarkarnold-code/adamsville-play"
# This editor's version (Help -> About shows it, large and bold).
EDITOR_VERSION = "1.0.0"
# The 7 game zones, in the game's own zone order.
ZONE_IDS = ["adamsville", "downtown", "eastatlanta", "mableton",
            "riverdale", "southfulton", "unioncity"]
# Converted-format category order (the converter's key order).
CATEGORY_ORDER = ("interstate", "highway", "major_artery",
                  "minor_artery", "local")
# Repo paths.
MANIFEST_PATH = "detailed/map-manifest.json"
ELEV_PATH = "detailed/elev.json"
ZONE_DIR = "detailed/zones/{zone}"
# Segmentation spacing inside an edited stretch (the converter /
# Map Editor re-drape rule: <= 2.5 world units between stations).
STATION_SPACING = 2.5
# Default hill radius (the gaussian r of each lift, world units) —
# wide enough for the game's 13-15u terrain mesh nodes to resolve.
DEFAULT_RADIUS = 48.0
# Lift centres are laid along the road at this fraction of r.
CENTER_SPACING_FRACTION = 0.75
# Centres whose solved amplitude is below this are dropped (a lift
# that moves the ground less than ~2 cm is not written at all).
MIN_LIFT = 0.02


class ElevDataError(Exception):
    """A plain-language data failure (shown as-is in the UI)."""


def zone_path(zone, fname):
    """Repo path of one of a zone's game files."""
    return f"{ZONE_DIR.format(zone=zone)}/{fname}"


def serialize_compact(obj):
    """
    The converter's JSON: no spaces, UTF-8, non-ASCII literal.
    Parsing and re-serializing an untouched zone file reproduces
    its bytes exactly (proven in the harness), which is what makes
    "no change -> not dirty -> never pushed" a byte comparison.
    """
    return json.dumps(obj, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def serialize_roads(roads_doc):
    """
    roads.json bytes from a parsed roads document, in the
    converter's category order, empty categories omitted, records
    preserved whole (unknown fields ride along untouched).
    """
    out = {}
    ordered = [c for c in CATEGORY_ORDER if c in roads_doc]
    ordered += [c for c in roads_doc if c not in ordered]
    for cat in ordered:
        roads = roads_doc.get(cat) or []
        if roads:
            out[cat] = roads
    return serialize_compact(out)


def roads_js_twin(zone_id, zone_name, roads_json_bytes):
    """The roads.js fallback twin: header + var ROAD_DATA, in the
    shipped twins' style, regenerated from the same bytes so the
    two can never disagree."""
    header = (f"/* ZONE ROADS — {zone_name} ({zone_id}) — "
              f"Elevation Editor {EDITOR_VERSION}; "
              f"do not hand-edit. */\n")
    return (header.encode("utf-8") + b"var ROAD_DATA = "
            + roads_json_bytes + b";\n")


def serialize_lifts(lifts):
    """lifts.json bytes: the compact array, entries preserved."""
    return serialize_compact(list(lifts))


def lifts_js_twin(zone_id, zone_name, lifts_json_bytes):
    """The lifts.js twin: header + var TERRAIN_LIFTS."""
    header = (f"/* ZONE TERRAIN_LIFTS — {zone_name} ({zone_id}) — "
              f"Elevation Editor {EDITOR_VERSION}; "
              f"do not hand-edit. */\n")
    return (header.encode("utf-8") + b"var TERRAIN_LIFTS = "
            + lifts_json_bytes + b";\n")


def bump_map_version(manifest_doc, today=None):
    """
    The next map_version (AGENTS.md: bump it whenever any map data
    file changes, or the apps never download the update). Format
    YYYY.MM.DD.N — N increments within the day, else starts at 1.
    Mutates and returns the document.
    """
    today = today or date.today()
    stamp = f"{today.year:04d}.{today.month:02d}.{today.day:02d}"
    current = str(manifest_doc.get("map_version") or "")
    if current.startswith(stamp + "."):
        try:
            n = int(current.rsplit(".", 1)[1]) + 1
        except Exception:
            n = 1
    else:
        n = 1
    manifest_doc["map_version"] = f"{stamp}.{n}"
    return manifest_doc


def update_manifest_entries(manifest_doc, changed):
    """
    Refresh the manifest's sha256/size for changed files.
    changed: {repo_path: bytes} — repo paths are translated to the
    manifest's detailed/-relative names. Entries for files the
    editor did not change are left exactly as they were.
    """
    by_name = {}
    for path, data in changed.items():
        name = path[len("detailed/"):] if path.startswith("detailed/") \
            else path
        by_name[name] = data
    for entry in manifest_doc.get("files") or []:
        data = by_name.get(entry.get("name"))
        if data is not None:
            entry["sha256"] = hashlib.sha256(data).hexdigest()
            entry["size"] = len(data)
    return manifest_doc


def serialize_manifest(manifest_doc):
    """map-manifest.json bytes: indent=1, no trailing newline (the
    shipped file's exact style — byte-stable, see the harness)."""
    return json.dumps(manifest_doc, indent=1).encode("utf-8")


# ---------------------------------------------------------------------------
# One zone's loaded state
# ---------------------------------------------------------------------------

class ZoneState:
    """
    A downloaded zone: parsed roads + lifts, plus the EXACT bytes
    downloaded for each pushable file (the baselines). A file is
    dirty when its new serialization differs from its baseline —
    untouched files are therefore never pushed, by construction.
    """

    def __init__(self, zone):
        self.zone = zone
        self.meta = None            # parsed zone.json
        self.name = zone            # display name (from zone.json)
        self.roads = None           # parsed roads.json document
        self.lifts = []             # parsed lifts.json list
        self.baselines = {}         # repo path -> downloaded bytes

    def road_records(self):
        """[(category, index, record), ...] in document order."""
        out = []
        if self.roads:
            ordered = [c for c in CATEGORY_ORDER if c in self.roads]
            ordered += [c for c in self.roads if c not in ordered]
            for cat in ordered:
                for idx, rec in enumerate(self.roads.get(cat) or []):
                    out.append((cat, idx, rec))
        return out


# ---------------------------------------------------------------------------
# The hill: one elevation edit, as a working session
# ---------------------------------------------------------------------------

class HillSession:
    """
    One elevation edit in progress: a stretch of one road, a wanted
    peak height, falloff tails, and the solved lift set.

    The geometry vocabulary is ARC LENGTH along the road (s):
      [s_start, s_end]     the highlighted stretch (what Joshua
                           picked);
      [s0, s1]             the INFLUENCE range: the stretch plus a
                           falloff tail on each side, inside which
                           stations are segmented and lifts laid;
      crest                the stretch's midpoint — the hill's top.
    The wanted profile is cos^2 from the crest down to zero at both
    influence ends (smooth at the crest AND at the joins — a hill,
    not a slab, with no kink where it meets the old ground).
    """

    def __init__(self, zone_state, category, index, s_start, s_end,
                 peak, tail, radius=DEFAULT_RADIUS):
        """Capture the edit's inputs (nothing computed yet)."""
        self.zone = zone_state.zone
        self.category = category
        self.index = index
        self.record = zone_state.roads[category][index]
        self.base_pts = [[float(p[0]), float(p[1])]
                         for p in self.record.get("pts", [])]
        self.base_ys = list(self.record.get("ys", []))
        self.base_arcs = polyline_arcs(self.base_pts)
        total = self.base_arcs[-1] if self.base_arcs else 0.0
        self.s_start = max(0.0, min(float(s_start), total))
        self.s_end = max(0.0, min(float(s_end), total))
        if self.s_end < self.s_start:
            self.s_start, self.s_end = self.s_end, self.s_start
        self.peak = float(peak)
        self.tail = max(0.0, float(tail))
        self.radius = float(radius)
        self.s0 = max(0.0, self.s_start - self.tail)
        self.s1 = min(total, self.s_end + self.tail)
        self.crest = (self.s_start + self.s_end) / 2.0
        # Filled by solve():
        self.new_pts = None         # segmented station list
        self.new_arcs = None
        self.centers = []           # [(x, z), ...] lift centres
        self.lifts = []             # solved {"x","z","lift","r"}
        self.max_error = None       # profile fit error (world units)

    # -- the wanted profile ----------------------------------------
    def desired_at(self, s):
        """
        Wanted ground change at arc s: peak * cos^2 falloff from
        the crest to each influence end (each side scaled by its
        own length, so an asymmetric influence still lands at
        exactly zero, with zero slope, at both ends).
        """
        if s <= self.s0 or s >= self.s1:
            return 0.0
        if s < self.crest:
            half = self.crest - self.s0
            u = (self.crest - s) / half if half > 0 else 0.0
        else:
            half = self.s1 - self.crest
            u = (s - self.crest) / half if half > 0 else 0.0
        c = math.cos(u * math.pi / 2.0)
        return self.peak * c * c

    # -- segmentation + solve ---------------------------------------
    def solve(self):
        """
        Segment the influence range and solve the lift amplitudes.
        Returns self (centers/lifts/new_pts filled). Raises
        ElevDataError for a degenerate stretch.
        """
        if self.s1 - self.s0 < 1.0:
            raise ElevDataError(
                "That stretch is too short to lift — pick a longer "
                "piece of road.")
        # Segment: stations <= STATION_SPACING inside the influence,
        # original stations untouched outside it.
        self.new_pts, self.new_arcs = densify_range(
            self.base_pts, self.s0, self.s1, STATION_SPACING)
        # Centres along the road every ~0.75 r inside the influence.
        spacing = max(6.0, self.radius * CENTER_SPACING_FRACTION)
        centers_s = []
        s = self.s0 + spacing / 2.0
        while s < self.s1:
            centers_s.append(s)
            s += spacing
        if not centers_s:
            centers_s = [self.crest]
        self.centers = [point_at_arc(self.base_pts, self.base_arcs, s)
                        for s in centers_s]
        # Dense check samples every ~4u along the influence.
        sample_s = []
        s = self.s0
        while s <= self.s1:
            sample_s.append(s)
            s += 4.0
        if sample_s[-1] < self.s1:
            sample_s.append(self.s1)
        samples = [point_at_arc(self.base_pts, self.base_arcs, s)
                   for s in sample_s]
        desired = [self.desired_at(s) for s in sample_s]
        amps, self.max_error = fit_gaussian_profile(
            self.centers, samples, desired, self.radius)
        # Bake the lift entries in the zone file's key order
        # (x, z, lift, r); centres that move the ground less than
        # MIN_LIFT are not written at all.
        self.lifts = []
        for (x, z), amp in zip(self.centers, amps):
            if abs(amp) < MIN_LIFT:
                continue
            r = self.radius
            entry = {"x": round(float(x), 2), "z": round(float(z), 2),
                     "lift": round(float(amp), 3),
                     "r": int(r) if float(r).is_integer() else r}
            self.lifts.append(entry)
        return self

    # -- preview ground ----------------------------------------------
    def preview_ground(self, base_ground, base_lifts):
        """The ground as it will be if this edit is submitted:
        base ground + the zone's lifts + this session's lifts."""
        return GroundWithLifts(base_ground,
                               list(base_lifts) + list(self.lifts))

    def influence_reach(self):
        """How far (world units) the edit's ground change reaches
        from any lift centre: the game's 3-sigma cutoff."""
        return 3.0 * self.radius


# ---------------------------------------------------------------------------
# The store: downloads + write-back + the round trip
# ---------------------------------------------------------------------------

class ElevationData:
    """
    Everything the editor downloaded, plus the save machinery.

    fetcher: a suite_core.shared_cache.CachedFetcher (the one
    download door — shared cache, manifest freshness).
    fetch_file: github_sync.fetch_file (raw, for the manifest —
    the freshness source itself is never served from cache).
    """

    def __init__(self, fetcher, fetch_file):
        self._fetcher = fetcher
        self._fetch_file = fetch_file
        self.manifest = None        # parsed map-manifest.json
        self.ground = None          # GroundModel (base terrain)
        self.zones = {}             # zone id -> ZoneState

    # -- downloads ----------------------------------------------------
    def load_manifest(self):
        """
        Fetch the map manifest FRESH (it is tiny and it is the
        freshness source for every other download), register its
        sha256s with the cache fetcher, keep the parsed document
        for the Submit-time bump. Returns the map_version string.
        """
        raw, err = self._fetch_file(REPO, MANIFEST_PATH)
        if raw is None:
            raise ElevDataError(f"Could not download the map "
                                f"manifest: {err}")
        try:
            self.manifest = json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise ElevDataError(f"The map manifest is unreadable: {e}")
        self._fetcher.register_manifest(raw)
        return str(self.manifest.get("map_version") or "")

    def load_ground(self, progress=None):
        """Download the elevation grid and build the ground model
        (once per session; ~450 KB, cached by the suite cache)."""
        if self.ground is not None:
            return self.ground
        raw, err = self._fetcher.fetch_progress(REPO, ELEV_PATH,
                                                progress=progress)
        if raw is None:
            raise ElevDataError(f"Could not download the elevation "
                                f"grid: {err}")
        try:
            elev = json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise ElevDataError(f"The elevation grid is "
                                f"unreadable: {e}")
        self.ground = GroundModel(elev)
        return self.ground

    def load_zone(self, zone, progress=None):
        """
        Download one zone's files (zone.json, roads.json,
        lifts.json) through the shared cache and parse them.
        Already-loaded zones are returned from memory — the editor
        never holds more zones than Joshua opened.
        """
        if zone in self.zones and self.zones[zone].roads is not None:
            return self.zones[zone]
        zs = ZoneState(zone)
        for fname, attr in (("zone.json", "meta"),
                            ("roads.json", "roads"),
                            ("lifts.json", "lifts")):
            path = zone_path(zone, fname)
            raw, err = self._fetcher.fetch_progress(REPO, path,
                                                    progress=progress)
            if raw is None:
                raise ElevDataError(f"Could not download "
                                    f"{zone}/{fname}: {err}")
            zs.baselines[path] = raw
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except Exception as e:
                raise ElevDataError(f"{zone}/{fname} is "
                                    f"unreadable: {e}")
            setattr(zs, attr, parsed)
        if isinstance(zs.meta, dict):
            zs.name = str(zs.meta.get("name") or zone)
        if not isinstance(zs.lifts, list):
            zs.lifts = []
        self.zones[zone] = zs
        return zs

    # -- snapshot -------------------------------------------------------
    def snapshot_roads(self, zone, extent):
        """
        [(category, index, record), ...] for every road of the zone
        with at least one station inside extent (x0, z0, x1, z1) —
        the viewport's surroundings (roads only; the terrain patch
        itself is sampled from the ground model).
        """
        zs = self.zones[zone]
        x0, z0, x1, z1 = extent
        out = []
        for cat, idx, rec in zs.road_records():
            for p in rec.get("pts", []):
                if x0 <= p[0] <= x1 and z0 <= p[1] <= z1:
                    out.append((cat, idx, rec))
                    break
        return out

    # -- write-back ------------------------------------------------------
    def build_targets(self, zone, session, today=None):
        """
        (targets, changed_paths, neighbour_count): the push set for
        submitting `session` in `zone`.

        targets: [(repo, path, bytes, message), ...] — the zone's
        lifts/roads files whose bytes actually changed, each with
        its regenerated .js twin, plus the bumped map-manifest when
        anything else is in the set. Pure computation: nothing is
        mutated in the loaded zone state, so a failed push leaves
        the session exactly as it was.
        """
        zs = self.zones[zone]
        if self.ground is None:
            raise ElevDataError("The elevation grid is not loaded.")
        if not session.lifts:
            # Joshua's write-back law: nothing changed -> nothing
            # written. A session whose solved lifts are all zero
            # moves no ground; even its segmentation is scaffolding
            # for a lift that isn't happening, so the road record
            # stays exactly as shipped.
            return [], {}, 0
        new_lifts = list(zs.lifts) + list(session.lifts)
        ground_after = GroundWithLifts(self.ground, new_lifts)
        reach = session.influence_reach()
        centers = [(L["x"], L["z"]) for L in session.lifts]

        def within_reach(x, z):
            """True when (x, z) is inside any new lift's 3-sigma
            reach — outside it, the game's own formula gives the
            lift term as exactly 0, so the shipped ys cannot move."""
            for cx, cz in centers:
                dx, dz = x - cx, z - cz
                if dx * dx + dz * dz < reach * reach:
                    return True
            return False

        # The edited road: segmented pts; ys recomputed only for
        # stations in the influence (added or inside it), every
        # other station keeps its shipped ys byte-for-byte.
        new_roads = {}
        for cat in list(zs.roads.keys()):
            new_roads[cat] = list(zs.roads.get(cat) or [])
        edited = dict(session.record)  # key order preserved
        new_ys = []
        for (x, z), s in zip(session.new_pts, session.new_arcs):
            # Recompute wherever the ground actually changes: the
            # influence range (segmented stations) AND anywhere a
            # lift's reach extends past it — a gaussian centred
            # near the influence edge still raises ground beyond
            # the edge, and a station left at its shipped ys there
            # would sit under the new terrain.
            if session.s0 - 1e-6 <= s <= session.s1 + 1e-6 \
                    or within_reach(x, z):
                new_ys.append(ground_after.drape_y(x, z))
            else:
                # An original station outside the influence keeps
                # its shipped ys. (Its arc in the segmented list
                # can drift a hair from the original arc — the
                # stations were re-rounded — so match the NEAREST
                # original arc within a small tolerance; only a
                # station with no original counterpart, which
                # cannot occur outside the influence, falls back
                # to a fresh drape.)
                best_j, best_d = None, 0.05
                for j, a in enumerate(session.base_arcs):
                    d = abs(a - s)
                    if d < best_d:
                        best_j, best_d = j, d
                if best_j is not None and best_j < len(session.base_ys):
                    new_ys.append(session.base_ys[best_j])
                else:
                    new_ys.append(ground_after.drape_y(x, z))
        edited["pts"] = session.new_pts
        edited["ys"] = new_ys
        new_roads[session.category][session.index] = edited

        # Neighbour roads: pts never move; ys recomputed only where
        # a lift's reach covers the point (the ground there really
        # changed — leaving stale ys would bury or float them).
        neighbours = 0
        for cat, idx, rec in zs.road_records():
            if cat == session.category and idx == session.index:
                continue
            pts, ys = rec.get("pts", []), rec.get("ys", [])
            changed = False
            out_ys = []
            for (x, z), y in zip(pts, ys):
                if within_reach(x, z):
                    ny = ground_after.drape_y(x, z)
                    if ny != y:
                        changed = True
                    out_ys.append(ny)
                else:
                    out_ys.append(y)
            if changed:
                fixed = dict(rec)
                fixed["ys"] = out_ys
                new_roads[cat][idx] = fixed
                neighbours += 1

        # Serialize + diff against baselines: only changed files go.
        changed = {}
        roads_bytes = serialize_roads(new_roads)
        if roads_bytes != zs.baselines.get(zone_path(zone, "roads.json")):
            changed[zone_path(zone, "roads.json")] = roads_bytes
            changed[zone_path(zone, "roads.js")] = roads_js_twin(
                zone, zs.name, roads_bytes)
        lifts_bytes = serialize_lifts(new_lifts)
        if lifts_bytes != zs.baselines.get(zone_path(zone, "lifts.json")):
            changed[zone_path(zone, "lifts.json")] = lifts_bytes
            changed[zone_path(zone, "lifts.js")] = lifts_js_twin(
                zone, zs.name, lifts_bytes)
        if not changed:
            return [], {}, 0

        manifest_doc = copy.deepcopy(self.manifest)
        bump_map_version(manifest_doc, today)
        update_manifest_entries(manifest_doc, changed)
        changed[MANIFEST_PATH] = serialize_manifest(manifest_doc)

        messages = {
            zone_path(zone, "roads.json"):
                f"Elevation Editor {EDITOR_VERSION}: re-drape "
                f"{zone} roads to lifted terrain",
            zone_path(zone, "roads.js"):
                f"Elevation Editor {EDITOR_VERSION}: regenerate "
                f"{zone} roads twin",
            zone_path(zone, "lifts.json"):
                f"Elevation Editor {EDITOR_VERSION}: terrain lifts "
                f"for {zone}",
            zone_path(zone, "lifts.js"):
                f"Elevation Editor {EDITOR_VERSION}: regenerate "
                f"{zone} lifts twin",
            MANIFEST_PATH:
                f"Elevation Editor {EDITOR_VERSION}: map version "
                f"{manifest_doc['map_version']}",
        }
        order = [zone_path(zone, "lifts.json"), zone_path(zone, "lifts.js"),
                 zone_path(zone, "roads.json"), zone_path(zone, "roads.js"),
                 MANIFEST_PATH]
        targets = [(REPO, p, changed[p], messages[p])
                   for p in order if p in changed]
        return targets, changed, neighbours

    # -- the round trip ---------------------------------------------------
    def round_trip_save(self, zone, session, local_dir,
                        open_connection, push_targets, fetch_file,
                        today=None):
        """
        Joshua's standing save rule, as one operation: local save
        -> push on ONE connection -> CLOSE it -> re-download every
        pushed file on FRESH connections -> adopt the proof copy.

        local_dir: this app's data dir (the local stage writes
        there, mirroring repo paths, with a journal).
        Returns (ok, message, fresh) — fresh maps repo path ->
        proof bytes. On any failure the loaded state is untouched
        and the session stays submittable.
        """
        targets, changed, neighbours = self.build_targets(
            zone, session, today=today)
        if not targets:
            return True, "Nothing to save — the edit changes " \
                         "nothing on the ground.", {}
        # ---- Stage 1: LOCAL SAVE -----------------------------------
        local_dir = Path(local_dir)
        try:
            local_dir.mkdir(parents=True, exist_ok=True)
            for _repo, path, data, _msg in targets:
                dest = local_dir / "pending" / path
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
            (local_dir / "pending" / "journal.json").write_text(
                json.dumps({"zone": zone,
                            "paths": [t[1] for t in targets]},
                           indent=1))
        except Exception as e:
            return False, f"Local save failed: {e}", None
        # ---- Stage 2: PUSH (one connection, then closed) -----------
        conn = open_connection()
        try:
            ok, msg = push_targets(targets, conn=conn)
        finally:
            try:
                conn.close()
            except Exception:
                pass
        if not ok:
            return False, f"Push to GitHub failed: {msg}", None
        # ---- Stage 3: PROOF DOWNLOAD (fresh connections) -----------
        fresh = {}
        for _repo, path, data, _msg in targets:
            raw, err = fetch_file(REPO, path)
            if raw is None:
                return False, (
                    "The push reached GitHub, but downloading the "
                    f"proof copy of {path} failed: {err} — your "
                    "save DID reach GitHub; reopen the editor to "
                    "see it."), None
            if raw != data:
                return False, (
                    f"The proof copy of {path} does not match what "
                    "was pushed — not adopting it. Your push DID "
                    "reach GitHub; reopen the editor to see its "
                    "state."), None
            fresh[path] = raw
        # ---- Adopt the proof copy ----------------------------------
        zs = self.zones[zone]
        # The new map version (from the proof manifest) tags the
        # cache stores below.
        new_version = None
        if MANIFEST_PATH in fresh:
            try:
                new_version = json.loads(
                    fresh[MANIFEST_PATH].decode("utf-8")).get(
                        "map_version")
            except Exception:
                new_version = None
        for path, raw in fresh.items():
            zs.baselines[path] = raw
            # Keep the shared cache honest for the whole suite.
            try:
                from suite_core import shared_cache
                shared_cache.store(REPO, path, raw,
                                   manifest_version=new_version)
            except Exception:
                pass
        if zone_path(zone, "roads.json") in fresh:
            zs.roads = json.loads(
                fresh[zone_path(zone, "roads.json")].decode("utf-8"))
        if zone_path(zone, "lifts.json") in fresh:
            zs.lifts = json.loads(
                fresh[zone_path(zone, "lifts.json")].decode("utf-8"))
        if MANIFEST_PATH in fresh:
            self.manifest = json.loads(
                fresh[MANIFEST_PATH].decode("utf-8"))
            self._fetcher.register_manifest(fresh[MANIFEST_PATH])
        note = f" ({neighbours} nearby road(s) re-draped too)" \
            if neighbours else ""
        return True, (f"Saved and verified — map version "
                      f"{self.manifest.get('map_version')}{note}. "
                      f"The game will pick this up on its next "
                      f"map check."), fresh
