#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) — area data for the linked viewpoints.

WHY THIS MODULE EXISTS (1.9.8, Joshua 2026-10-18): the 3D road
inspector and the satellite viewpoint draw the CURRENT AREA of the
world — roads, terrain, and BUILDINGS. The editor's ordinary
download-on-open never fetched buildings (it edits roads; buildings
belong to the Building Editor), so the area viewpoints fetch them
LAZILY: the first time a viewpoint wakes up looking at a zone, that
zone's buildings.json comes down from GitHub on a background worker
— the same Contents-API read the rest of the editor uses, routed
through the suite shared cache when the app provides it — and is
parsed and bucketed off the UI thread. The corner progress bar
shows while a zone is in flight (Joshua's suite law: a busy app
never reads as frozen), and a zone that fails simply has no
buildings in the views until a later visit retries it. Buildings
are READ-ONLY here: never edited, never pushed.

DATA: detailed/zones/<zone>/buildings.json is the game's compact
building list — {"buildings": [[x, z, w, d, h, type], ...]}: centre
x/z, width, depth, height (all world units = metres), and the
game's building type code (0 residential/generic, 1 commercial,
2 multi-unit/institutional, 3 other/special — the type map the
Building Editor documents). One tuple per building, exactly as
stored.

Joshua's rule: all code commented.
"""

import math
import threading

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import GLib

# Grid bucket size (world units) for the per-zone building index.
# A viewpoint patch is at most a few thousand units across, so a
# 512-unit bucket keeps per-frame queries to a handful of buckets.
BUCKET = 512.0

# Query expansion (world units): a building is indexed by its
# CENTRE bucket, so a viewport query must look this far past its
# own edges to catch buildings whose centres sit just outside but
# whose bulk reaches in. The largest footprint in the data is
# ~230 units across; 300 covers it with room to spare.
QUERY_PAD = 300.0


def zone_buildings_path(zone_id):
    """Repo path of one zone's buildings.json."""
    return f"detailed/zones/{zone_id}/buildings.json"


def parse_buildings(blob):
    """
    Parse buildings.json bytes into a list of tuples
    (x, z, w, d, h, type). Malformed rows are skipped, never
    fatal — a viewpoint must not die on one bad record.
    """
    import json
    doc = json.loads(blob.decode("utf-8"))
    rows = doc.get("buildings") if isinstance(doc, dict) else doc
    out = []
    for row in rows or []:
        try:
            x, z, w, d, h = (float(row[0]), float(row[1]),
                             float(row[2]), float(row[3]),
                             float(row[4]))
            t = int(row[5]) if len(row) > 5 else 0
        except (TypeError, ValueError, IndexError):
            continue
        out.append((x, z, w, d, h, t))
    return out


class BuildingsStore:
    """
    Per-zone buildings, fetched on demand and kept in memory.

    State per zone: "absent" (never asked), "loading" (worker in
    flight), "ready" (parsed + bucketed), "failed" (last fetch or
    parse failed; a later ensure_zone() retries). The store owns
    no transport: the caller passes fetch_bytes(path) -> bytes |
    None, so the app wires its own GitHub read and the harness can
    drive the store with fixture bytes through the same door.
    """

    def __init__(self):
        self._zones = {}    # zone_id -> [building tuples]
        self._buckets = {}  # zone_id -> {(bx, bz): [building, ...]}
        self._state = {}    # zone_id -> state string
        self._lock = threading.Lock()

    # -- state ----------------------------------------------------

    def state(self, zone_id):
        """Current fetch state for a zone ("absent" if unasked)."""
        with self._lock:
            return self._state.get(zone_id, "absent")

    def count(self, zone_id):
        """Buildings held for a zone (0 unless ready)."""
        with self._lock:
            return len(self._zones.get(zone_id, ()))

    # -- ingest (worker result + the harness's door) ---------------

    def ingest(self, zone_id, buildings):
        """
        Install a parsed building list for a zone and bucket it.
        Called by the fetch worker on completion, and directly by
        tests seeding known data — one door, same result.
        """
        buckets = {}
        for b in buildings:
            key = (int(math.floor(b[0] / BUCKET)),
                   int(math.floor(b[1] / BUCKET)))
            buckets.setdefault(key, []).append(b)
        with self._lock:
            self._zones[zone_id] = list(buildings)
            self._buckets[zone_id] = buckets
            self._state[zone_id] = "ready"

    def ingest_bytes(self, zone_id, blob):
        """Parse + ingest raw buildings.json bytes. Returns count."""
        buildings = parse_buildings(blob)
        self.ingest(zone_id, buildings)
        return len(buildings)

    # -- lazy fetch -------------------------------------------------

    def ensure_zone(self, zone_id, fetch_bytes, on_ready=None):
        """
        Fetch a zone's buildings in the background if not held.

        fetch_bytes(repo_path) -> bytes | None runs ON THE WORKER
        THREAD. on_ready(zone_id, ok) is delivered on the GTK main
        loop. Returns True when a fetch was started. A zone already
        ready or already loading is a no-op (returns False) — the
        viewpoints call this on every camera move, and the store
        is the dedupe.
        """
        with self._lock:
            if self._state.get(zone_id) in ("ready", "loading"):
                return False
            self._state[zone_id] = "loading"
        path = zone_buildings_path(zone_id)

        def _work():
            blob = None
            try:
                blob = fetch_bytes(path)
            except Exception:
                blob = None
            ok = False
            if blob:
                try:
                    self.ingest_bytes(zone_id, blob)
                    ok = True
                except Exception:
                    ok = False
            if not ok:
                with self._lock:
                    self._state[zone_id] = "failed"
            if on_ready is not None:
                GLib.idle_add(on_ready, zone_id, ok)

        threading.Thread(target=_work, daemon=True,
                         name=f"buildings-{zone_id}").start()
        return True

    # -- queries ----------------------------------------------------

    def query(self, zone_ids, x0, z0, x1, z1):
        """
        Buildings of the given zones whose centre falls inside the
        rect expanded by QUERY_PAD (see its note). Only "ready"
        zones contribute. Order is unspecified; callers that paint
        sort for themselves.
        """
        out = []
        bx0 = int(math.floor((x0 - QUERY_PAD) / BUCKET))
        bz0 = int(math.floor((z0 - QUERY_PAD) / BUCKET))
        bx1 = int(math.floor((x1 + QUERY_PAD) / BUCKET))
        bz1 = int(math.floor((z1 + QUERY_PAD) / BUCKET))
        with self._lock:
            for zid in zone_ids:
                buckets = self._buckets.get(zid)
                if not buckets:
                    continue
                for bx in range(bx0, bx1 + 1):
                    for bz in range(bz0, bz1 + 1):
                        out.extend(buckets.get((bx, bz), ()))
        return out
