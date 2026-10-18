#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) 1.9.7 — Game-data model + round-trip save.

SOURCE OF TRUTH (Joshua's one-repo decision, 2026-10-16): the game's
own files in repo kingmarkarnold-code/adamsville-play. This editor no
longer reads or writes the old adamsville-map-editor repo at all, and
there is NO sync-roads bridge — the editor writes game files directly.

WHAT THE EDITOR READS (download-on-open, Contents API, fresh
connection — never raw.githubusercontent.com, which serves stale
bytes):
  * detailed/zones/<zone>/zone.json   for all 7 zones (names/bounds)
  * detailed/zones/<zone>/roads.json for all 7 zones (converted format)
  * detailed/overpasses.json          (the file the game loads)
  * detailed/elev.json                (for the ground/re-drape port)
  * editors/map-editor/zone_edits.json + custom_zones.json
        (editor WORKING data — overlays, not game data; may not exist
        yet, in which case they start empty)

WHAT A SAVE WRITES (one round trip, dirty files only):
  * detailed/zones/<zone>/roads.json AND its regenerated roads.js twin
    for each zone whose roads actually changed;
  * detailed/overpasses.json if the overpasses changed;
  * the two editors/map-editor/ overlay files if they changed.

CONVERTED ROADS FORMAT (per zone):
  {"highway": [...], "major_artery": [...], "minor_artery": [...],
   "local": [...]}  — only non-empty categories are present.
  Each record: {"name": str, "pts": [[x, z], ...], "ys": [float, ...],
  "ramp": 1 (optional)}. Records round-trip LOSSLESSLY: the model keeps
  the parsed dicts whole, so unknown fields survive untouched; the
  editor-only "_zone" attribution key is stripped at serialization.

ZONE ATTRIBUTION: a road belongs to the zone FILE it came from (not to
whatever zone polygon it happens to sit in — zone rectangles share
edges, and the game loads roads per zone file). New roads drawn in the
editor are attributed to the zone whose bounds contain their first
point (falling back to the nearest zone rectangle).

ZONES IN THE EDITOR: zone.json's "definition" is a LAT/LON RECTANGLE
and "bounds" its world-frame image — there is no polygon in the game
data. The editor's draggable polygon boundaries and custom zones
therefore CANNOT be written into zone.json honestly; they stay editor
overlays (see data.py) and are round-tripped to
editors/map-editor/*.json as working data. The canvas zone polygons
are DERIVED from zone.json bounds (rectangle corners) at load.

Joshua's rule: all code commented.
"""

import copy
import json

# The one repo everything lives in now.
GAME_REPO = "kingmarkarnold-code/adamsville-play"

# The 7 game zones, in the game's own zone order.
ZONE_IDS = ["adamsville", "downtown", "eastatlanta", "mableton",
            "riverdale", "southfulton", "unioncity"]

# Converted-format category order (the converter's key order; the
# editor's extra "interstate" class, if ever used, sorts first so it
# can never shuffle the converted categories relative to each other).
CATEGORY_ORDER_OUT = ("interstate", "highway", "major_artery",
                      "minor_artery", "local")

# Repo paths (single source for every read/write the editor makes).
OVERPASSES_PATH = "detailed/overpasses.json"
ELEV_PATH = "detailed/elev.json"
ZONE_EDITS_PATH = "editors/map-editor/zone_edits.json"
CUSTOM_ZONES_PATH = "editors/map-editor/custom_zones.json"


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
    """
    Serialize exactly like the converter did (JSON.stringify):
    no spaces, UTF-8, non-ASCII kept literal. Verified byte-stable
    against the shipped zone roads.json files — parsing and
    re-serializing an untouched file reproduces its bytes exactly,
    which is what makes "no edits -> no push" provable by comparison.
    """
    return json.dumps(obj, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


def serialize_roads(zone_roads):
    """
    Build the roads.json bytes for ONE zone from its in-editor roads:
    {category: [road dicts]}. Only non-empty categories are written
    (the converted format's rule); editor-only keys (leading "_",
    e.g. "_zone") are stripped; every other field — known or unknown —
    is preserved verbatim and in its original key order.
    """
    out = {}
    # Canonical categories first, in converter order…
    ordered = [c for c in CATEGORY_ORDER_OUT if c in zone_roads]
    # …then any unexpected category, in the order it appeared.
    ordered += [c for c in zone_roads if c not in ordered]
    for cat in ordered:
        roads = zone_roads.get(cat) or []
        if not roads:
            continue  # converted files omit empty categories
        clean = []
        for road in roads:
            clean.append({k: v for k, v in road.items()
                          if not k.startswith("_")})
        out[cat] = clean
    return serialize_json_compact(out)


def roads_js_twin(zone_id, zone_name, roads_json_bytes):
    """
    Regenerate the roads.js twin for a zone, mirroring the shipped
    twins exactly in style: one header comment line, then
    `var ROAD_DATA = <the identical JSON>;` and a trailing newline.
    The game loader prefers roads.json; the .js is its fallback, so
    the two must never disagree — a save always pushes both.
    """
    header = (f"/* ZONE ROADS — {zone_name} ({zone_id}) — "
              f"FULL CONVERSION STAGING 2026-10-16 "
              f"(CONVERSION-DESIGN.md). Generated by Adamsville Map "
              f"Editor 1.9.7; do not hand-edit. */\n")
    return (header.encode("utf-8") + b"var ROAD_DATA = "
            + roads_json_bytes + b";\n")


def zone_polygon_from_bounds(bounds):
    """
    Editor canvas polygon for a zone: the rectangle corners of the
    zone.json "bounds" {xMin, xMax, zMin, zMax}, wound
    top-left -> top-right -> bottom-right -> bottom-left (the same
    winding data.rect_to_points has always used).
    """
    return [[float(bounds["xMin"]), float(bounds["zMin"])],
            [float(bounds["xMax"]), float(bounds["zMin"])],
            [float(bounds["xMax"]), float(bounds["zMax"])],
            [float(bounds["xMin"]), float(bounds["zMax"])]]


class GameModel:
    """
    Everything the editor downloaded on open, plus dirty tracking.

    zones:      {zone_id: {"meta": <parsed zone.json>,
                           "roads": {category: [road dicts]}}}
                Every road dict carries "_zone" = its zone_id.
    baselines:  {repo_path: bytes} — the exact bytes downloaded for
                each pushable file; a file is DIRTY when its current
                serialization differs from its baseline. Untouched
                files are therefore never pushed, by construction.
    overpass_doc: the whole parsed detailed/overpasses.json document
                ({"_note": ..., "overpasses": [...]}) — kept whole so
                the note and any unknown keys round-trip untouched;
                the editor edits only the "overpasses" list inside it.
    elev:       the parsed elev.json (feeds ground.GroundModel).
    """

    def __init__(self):
        """Start empty; download_game_data() fills the model."""
        self.zones = {}
        self.baselines = {}
        self.overpass_doc = {"overpasses": []}
        self.elev = None
        # Editor overlay working data (not game data — see docstring).
        self.zone_edits = {}    # name -> {"points": [[x, z], ...]}
        self.custom_zones = []  # [{"name", "points", "color"}]

    # -- merged view ---------------------------------------------------
    def merged_roads(self):
        """
        The whole map as one {category: [roads]} dict for the canvas
        (zones are adjacent rectangles; the editor shows one map).
        Roads keep their "_zone" attribution through the merge.
        """
        merged = {}
        for zone_id in ZONE_IDS:
            zdata = self.zones.get(zone_id)
            if not zdata:
                continue
            for cat, roads in zdata["roads"].items():
                merged.setdefault(cat, []).extend(roads)
        return merged

    def adopt_merged_roads(self, merged):
        """
        Replace the model's per-zone roads from a merged working copy
        (what the canvas edits). Roads are re-grouped by their "_zone"
        attribution; a road WITHOUT attribution (newly drawn) is
        assigned by zone_for_point() from its first point.
        """
        grouped = {zid: {} for zid in self.zones}
        for cat, roads in merged.items():
            for road in roads:
                zid = road.get("_zone") or self.zone_for_point(road)
                road["_zone"] = zid
                if zid in grouped:
                    grouped[zid].setdefault(cat, []).append(road)
        for zid, cats in grouped.items():
            self.zones[zid]["roads"] = cats

    def zone_for_point(self, road):
        """
        Zone attribution for a road that doesn't carry one yet: the
        zone whose bounds contain its first point; if none contains
        it (a road drawn in a gap), the zone whose rectangle is
        nearest to that point. Falls back to the first loaded zone.
        """
        pts = road.get("pts") or []
        if not pts or not self.zones:
            return next(iter(self.zones), None)
        x, z = float(pts[0][0]), float(pts[0][1])
        best, best_d = None, None
        for zid in ZONE_IDS:
            zdata = self.zones.get(zid)
            if not zdata:
                continue
            b = zdata["meta"]["bounds"]
            if (b["xMin"] <= x <= b["xMax"]
                    and b["zMin"] <= z <= b["zMax"]):
                return zid
            # Distance to the rectangle (0 inside, handled above).
            dx = max(b["xMin"] - x, 0, x - b["xMax"])
            dz = max(b["zMin"] - z, 0, z - b["zMax"])
            d = dx * dx + dz * dz
            if best_d is None or d < best_d:
                best, best_d = zid, d
        return best

    # -- serialization of every pushable file --------------------------
    def current_bytes(self, path):
        """
        The bytes a save would push for one repo path, or None if the
        path isn't one this editor writes. Roads serialize per zone;
        overpasses serialize the whole document (compact, matching the
        shipped file's style); overlays serialize their working data.
        """
        if path == OVERPASSES_PATH:
            return serialize_json_compact(self.overpass_doc)
        if path == ZONE_EDITS_PATH:
            return json.dumps(self.zone_edits, indent=2).encode("utf-8")
        if path == CUSTOM_ZONES_PATH:
            return json.dumps(self.custom_zones,
                              indent=2).encode("utf-8")
        for zid in ZONE_IDS:
            if path == zone_roads_path(zid) and zid in self.zones:
                return serialize_roads(self.zones[zid]["roads"])
            if path == zone_roads_js_path(zid) and zid in self.zones:
                meta = self.zones[zid]["meta"]
                return roads_js_twin(
                    zid, meta.get("name", zid),
                    serialize_roads(self.zones[zid]["roads"]))
        return None

    def pushable_paths(self):
        """Every repo path a save may write, in deterministic order."""
        paths = []
        for zid in ZONE_IDS:
            if zid in self.zones:
                paths.append(zone_roads_path(zid))
                paths.append(zone_roads_js_path(zid))
        paths.append(OVERPASSES_PATH)
        paths.append(ZONE_EDITS_PATH)
        paths.append(CUSTOM_ZONES_PATH)
        return paths

    def dirty_paths(self):
        """
        The paths whose current bytes differ from the downloaded
        baseline. A path with NO baseline (a working file that didn't
        exist on GitHub yet) counts as dirty only when it actually
        holds data — an empty overlay is not worth creating a file for.
        """
        dirty = []
        for path in self.pushable_paths():
            # A roads.js twin is dirty exactly when its zone's
            # roads.json is: the twin is regenerated FROM the roads,
            # and its header comment legitimately differs from the
            # converter's original — comparing twin bytes directly
            # would make every save "dirty" forever.
            if path.endswith("/roads.js"):
                zid = path.split("/")[2]
                if zone_roads_path(zid) in dirty:
                    dirty.append(path)
                continue
            cur = self.current_bytes(path)
            base = self.baselines.get(path)
            if base is None:
                if path == ZONE_EDITS_PATH and not self.zone_edits:
                    continue
                if path == CUSTOM_ZONES_PATH and not self.custom_zones:
                    continue
                if cur is not None:
                    dirty.append(path)
            elif cur != base:
                dirty.append(path)
        return dirty

    def apply_fresh(self, fresh):
        """
        Adopt re-downloaded bytes after a successful round trip:
        each pushed file's baseline becomes the downloaded bytes, and
        the model's content for it is re-parsed FROM those bytes — so
        what the editor shows after a save is the GitHub copy, not the
        pre-push memory. Only call with files the round trip actually
        re-downloaded (never over unsaved edits).
        """
        for path, blob in fresh.items():
            self.baselines[path] = blob
            if path == OVERPASSES_PATH:
                self.overpass_doc = json.loads(blob.decode("utf-8"))
            elif path == ZONE_EDITS_PATH:
                self.zone_edits = json.loads(blob.decode("utf-8"))
            elif path == CUSTOM_ZONES_PATH:
                self.custom_zones = json.loads(blob.decode("utf-8"))
            else:
                for zid in ZONE_IDS:
                    if path == zone_roads_path(zid):
                        self._load_zone_roads(zid, blob)
                        break
                # roads.js twins carry no model state of their own —
                # the baseline update above is their whole story.

    def _load_zone_roads(self, zone_id, blob):
        """Parse one zone's roads.json bytes into the model, stamping
        every road with its "_zone" attribution."""
        parsed = json.loads(blob.decode("utf-8"))
        roads = {}
        for cat, lst in parsed.items():
            stamped = []
            for road in lst:
                road = dict(road)
                road["_zone"] = zone_id
                stamped.append(road)
            roads[cat] = stamped
        self.zones[zone_id]["roads"] = roads


# ---------------------------------------------------------------------------
# Download on open (Contents API; 1.9.1: a FRESH connection per file)
# ---------------------------------------------------------------------------

# 1.9.1: attempts per file when the failure is a NETWORK error (a
# dropped or refused connection) — every attempt on a brand-new
# connection. API answers (bad token, missing file, ...) are NOT
# retried: GitHub refused on the merits and would only refuse again.
DOWNLOAD_ATTEMPTS = 3


def download_game_data(sync, conn=None, token=None):
    """
    Download everything the editor needs from adamsville-play via
    the Contents API and build a GameModel.

    sync: the github_sync module (GitHubConnection-based; injected so
        the harness can stub the connection layer).
    conn: an open connection to pin the whole leg to (the 1.9.0
        behaviour, kept for callers that want it; the caller owns
        closing it). The editor passes none, and 1.9.1 then fetches
        every file on its OWN fresh connection — opened for that
        file and closed right after — so the download never depends
        on one keep-alive connection surviving ~25 requests (field
        failure on Joshua's laptop, 2026-10-16; this is the same
        close/reopen-fresh design Joshua set for the save round
        trip, taken per-file). A file that fails with a NETWORK
        error is retried on another fresh connection, up to
        DOWNLOAD_ATTEMPTS attempts; any other failure is final.

    Returns (model, None) on success, (None, error_message) when a
    REQUIRED file fails. The two overlay working files are optional:
    a 404 there simply means "no overlays yet".
    """
    model = GameModel()

    # 1.9.5 (ready-in-source 2026-10-17; Building Editor 1.7.2
    # amendment 4, Joshua): downloads route through the suite
    # SHARED CACHE (~/.local/share/adamsville-suite/cache/ —
    # standard written at editors/SHARED-CACHE.md in the repo,
    # module shared_cache.py, identical in every suite app). If
    # another suite app already downloaded this exact map, this
    # editor reuses those bytes instead of downloading again.
    # Freshness comes from the published map-manifest, fetched
    # fresh and directly first (it is tiny); files the manifest
    # does not cover download as before and are stored for the
    # next app. Only the download-on-open path uses the cache: the
    # round-trip save's PROOF downloads must come from GitHub
    # itself, and perform_round_trip below still calls
    # sync.fetch_file directly (unchanged). When a caller pins a
    # connection (conn=), the pinned path is used exactly as
    # before. Any failure setting the cache up falls back to the
    # plain direct fetch — the cache can never block a download.
    _cache_fetch = None
    if conn is None:
        try:
            import shared_cache as _shared_cache

            def _raw_fetch(repo, path):
                return sync.fetch_file(repo, path, token=token)

            _expected = {}
            _manifest_version = None
            _mraw, _merr = _raw_fetch(GAME_REPO,
                                      "detailed/map-manifest.json")
            if _mraw:
                _mdoc = json.loads(_mraw.decode("utf-8"))
                _manifest_version = _mdoc.get("map_version")
                for _f in _mdoc.get("files") or []:
                    if _f.get("name") and _f.get("sha256"):
                        _expected["detailed/" + _f["name"]] = \
                            _f["sha256"]

            def _cache_fetch(path):
                # Only manifest-covered paths may be SERVED from
                # the cache (their freshness is verifiable against
                # the manifest's sha). Uncovered paths — the
                # editor's own overlay files — always download
                # fresh, exactly as before the cache, and are then
                # stored so other apps can reuse them. If the
                # manifest itself could not be fetched, nothing is
                # served from the cache at all this run.
                if _manifest_version is None \
                        or path not in _expected:
                    data, err = _raw_fetch(GAME_REPO, path)
                    if data is not None:
                        try:
                            _shared_cache.store(
                                GAME_REPO, path, data,
                                manifest_version=_manifest_version)
                        except Exception:
                            pass
                    return data, err
                data, status = _shared_cache.fetch_through(
                    GAME_REPO, path, _raw_fetch,
                    expected_sha256=_expected.get(path),
                    manifest_version=_manifest_version)
                if data is None:
                    return None, status
                return data, None
        except Exception:
            _cache_fetch = None

    def fetch(path, required=True):
        """One file's fetch (bounded fresh-connection retries)."""
        attempts = 1 if conn is not None else DOWNLOAD_ATTEMPTS
        blob, err = None, None
        for _attempt in range(attempts):
            if _cache_fetch is not None:
                blob, err = _cache_fetch(path)
            elif conn is not None:
                blob, err = sync.fetch_file(GAME_REPO, path,
                                            token=token, conn=conn)
            else:
                # No conn=: github_sync opens a fresh connection
                # for this single request and closes it right
                # after — no request rides a previous file's socket.
                blob, err = sync.fetch_file(GAME_REPO, path,
                                            token=token)
            if blob is not None:
                return blob
            if not (err or "").startswith("Network error:"):
                break  # an API refusal, not a dead connection
        if required:
            raise _DownloadFailed(f"{path}: {err}")
        return None

    try:
        # Elev first: the ground port (re-drape) needs it.
        elev_blob = fetch(ELEV_PATH)
        model.elev = json.loads(elev_blob.decode("utf-8"))
        # All 7 zones: metadata (names/bounds) + converted roads.
        for zid in ZONE_IDS:
            meta_blob = fetch(zone_meta_path(zid))
            roads_blob = fetch(zone_roads_path(zid))
            meta = json.loads(meta_blob.decode("utf-8"))
            model.zones[zid] = {"meta": meta, "roads": {}}
            model._load_zone_roads(zid, roads_blob)
            model.baselines[zone_roads_path(zid)] = roads_blob
            # The twin's baseline is what GitHub holds now; fetch
            # it too so an unchanged twin is never re-pushed.
            twin_blob = fetch(zone_roads_js_path(zid))
            model.baselines[zone_roads_js_path(zid)] = twin_blob
        # Overpasses: the game's file, taken as-is (its current
        # empty list is the truth — never replaced from elsewhere).
        ovp_blob = fetch(OVERPASSES_PATH)
        model.overpass_doc = json.loads(ovp_blob.decode("utf-8"))
        model.baselines[OVERPASSES_PATH] = ovp_blob
        # Editor overlay working data (optional files).
        ze_blob = fetch(ZONE_EDITS_PATH, required=False)
        if ze_blob is not None:
            model.zone_edits = json.loads(ze_blob.decode("utf-8"))
            model.baselines[ZONE_EDITS_PATH] = ze_blob
        cz_blob = fetch(CUSTOM_ZONES_PATH, required=False)
        if cz_blob is not None:
            model.custom_zones = json.loads(cz_blob.decode("utf-8"))
            model.baselines[CUSTOM_ZONES_PATH] = cz_blob
    except _DownloadFailed as e:
        return None, str(e)
    except Exception as e:
        return None, f"Downloaded data was unreadable: {e}"
    return model, None


class _DownloadFailed(Exception):
    """Internal: a required Contents-API fetch failed."""


# ---------------------------------------------------------------------------
# THE ROUND-TRIP SAVE (Joshua's standing rule for ALL editors)
# ---------------------------------------------------------------------------
# One save = local save -> PUSH on one connection -> CLOSE it -> fresh
# connection -> RE-DOWNLOAD every pushed file -> the caller refreshes
# the view from the re-downloaded bytes. Stage-accurate failures:
#   * local save failed            -> "local-save-failed: <error>"
#   * push leg failed              -> "Push to GitHub failed: <error>"
#   * proof download leg failed    -> "push reached GitHub but
#     downloading the proof copy back failed: <error> — your save DID
#     reach GitHub"
# On ANY failure the model's in-memory edits are left exactly as they
# were (nothing is reloaded over them); only a fully successful round
# trip calls model.apply_fresh().

def perform_round_trip(model, sync, save_local, token=None):
    """
    Run one round-trip save for a GameModel.

    model: the GameModel with Joshua's edits in it.
    sync: the github_sync module (injected; the harness stubs it).
    save_local: callable(model) -> (ok, error) performing the LOCAL
        save leg (the caller owns where local files live); it runs
        FIRST, before anything is pushed.
    Returns (ok, error, fresh) where fresh maps repo path -> the
    re-downloaded bytes on success ({} when nothing was dirty).
    """
    # ---- Stage 1: LOCAL SAVE ----------------------------------------
    # Local edits hit disk first; if that fails, nothing is pushed
    # and the failure is named for what it is.
    ok, err = save_local(model)
    if not ok:
        return False, f"local-save-failed: {err}", None

    dirty = model.dirty_paths()
    if not dirty:
        # Open + save with no edits: zero pushes, zero connections.
        return True, None, {}

    targets = [(GAME_REPO, path, model.current_bytes(path),
                f"Map editor: update {path}") for path in dirty]

    # ---- Stage 2: PUSH LEG (one connection, then CLOSE it) ---------
    push_conn = sync.open_connection()
    try:
        ok, msg = sync.push_targets(targets, token=token, conn=push_conn)
        if not ok:
            return False, f"Push to GitHub failed: {msg}", None
    finally:
        # Joshua's rule: the push connection is CLOSED before any
        # download happens — even when the push failed.
        push_conn.close()

    # ---- Stage 3: PROOF DOWNLOAD LEG (a brand-NEW connection) -------
    dl_conn = sync.open_connection()
    try:
        fresh = {}
        for path in dirty:
            blob, ferr = sync.fetch_file(GAME_REPO, path,
                                         token=token, conn=dl_conn)
            if blob is None:
                # The push LANDED — say exactly that, never claim the
                # save "did not reach GitHub".
                return False, (
                    "push reached GitHub but downloading the proof "
                    f"copy back failed: {path}: {ferr} — your save "
                    "DID reach GitHub"), None
            fresh[path] = blob
    finally:
        dl_conn.close()

    # ---- Stage 4: adopt the GitHub copies ---------------------------
    model.apply_fresh(fresh)
    return True, None, fresh


def snapshot_model(model):
    """Deep-copy a model for failure-safety checks / undo support."""
    return copy.deepcopy(model)
