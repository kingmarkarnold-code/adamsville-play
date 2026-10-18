#!/usr/bin/env python3
"""
vocab.py — the Building Editor's pick-lists, from the shared stock
shelf (Building Editor 2.0.0, Joshua's editor data rules).

Every list the design tab offers — wall materials, roof textures,
window/door types, floor plans, house styles, driveway materials,
garage sides, fence styles, floor types, decoration types, parking
types, building types — lives on the repo's stock shelf at
editors/stock/vocabularies/<name>.json (ONE-SOURCE.md §4: "we
don't know when we might need to change something", so the lists
must be changeable without rebuilding the app). Through 1.7.x the
app read its own baked-in copies in data.py; the shelf files were
verbatim copies of those constants, made canonical on 2026-10-17
"until the Building Editor rebuild adopts this shelf". This module
is that adoption.

The rules this module lives by (spec §6):
  * Lists come from GitHub, downloaded through the caller's
    fetcher (the suite shared cache in the app).
  * A local copy is ONLY a cache of a previous successful download
    (kept in the app-data dir, next to the other download caches).
  * A list that can neither be downloaded nor found in the cache
    is UNAVAILABLE: callers show a plain-language "list
    unavailable" state. There is deliberately NO baked-in fallback
    list in this module — silently offering last year's list is
    the defect this design exists to kill.

Each shelf file is {"vocabulary", "title", "source_constant",
"values": [...]} plus, for two files, extras this module surfaces:
decoration-types carries "placement" {wall: [...], ground: [...]}
(the DECORATION_WALL_TYPES rule), parking-types carries "labels"
and "space_orientations".

No GTK imports: the harness drives this module headlessly.
"""

import json
from pathlib import Path

REPO = "kingmarkarnold-code/adamsville-play"
VOCAB_DIR = "editors/stock/vocabularies"

# data.py constant name -> shelf file. These are the pick-lists the
# design tab and subdivision tab offer (RESIDENTIAL_TYPES and the
# label maps in data.py are record SCHEMA, not pick-lists, and are
# not sourced here; decoration placement and parking labels ARE
# pick-list data and ride along with their files below).
VOCAB_FILES = {
    "BUILDING_TYPES": "building-types.json",
    "WALL_MATERIALS": "wall-materials.json",
    "ROOF_TEXTURES": "roof-textures.json",
    "WINDOW_TYPES": "window-types.json",
    "DOOR_TYPES": "door-types.json",
    "FLOOR_PLAN_TEMPLATES": "floor-plan-templates.json",
    "HOUSE_STYLES": "house-styles.json",
    "DRIVEWAY_MATERIALS": "driveway-materials.json",
    "GARAGE_SIDES": "garage-sides.json",
    "FENCE_STYLES": "fence-styles.json",
    "FLOOR_TYPES": "floor-types.json",
    "DECORATION_TYPES": "decoration-types.json",
    "PARKING_TYPES": "parking-types.json",
}

# The plain-language note shown wherever a pick-list is missing.
UNAVAILABLE_NOTE = (
    "List unavailable — this list downloads from GitHub and no "
    "downloaded copy is on this computer yet. Connect to the "
    "internet and reopen the editor to load it.")


class Vocabularies:
    """
    The downloaded pick-lists, keyed by the data.py constant name
    the app has always used. status(name) is one of "downloaded"
    (fetched this session), "cached" (a previous download's cache
    copy), or "unavailable" (neither — values() returns None).
    """

    def __init__(self, cache_dir):
        """cache_dir: the app-data directory holding the download
        caches (data.DATA_DIR in the app)."""
        self._cache_dir = Path(cache_dir) / "vocab-cache"
        self._docs = {}      # const name -> parsed shelf document
        self._status = {}    # const name -> status string

    # -- loading -----------------------------------------------------

    def load(self, fetch):
        """
        Download every vocabulary through `fetch` (the shared-cache
        fetcher's callable: fetch(repo, path) -> (raw, err)). A
        failed download falls back to that list's cache copy; a
        list with neither is "unavailable". Returns
        {const_name: status} for the caller's status reporting.
        """
        for const_name, fname in VOCAB_FILES.items():
            raw, _err = fetch(REPO, f"{VOCAB_DIR}/{fname}")
            doc = self._parse(raw) if raw is not None else None
            if doc is not None:
                self._docs[const_name] = doc
                self._status[const_name] = "downloaded"
                try:
                    self._cache_dir.mkdir(parents=True, exist_ok=True)
                    (self._cache_dir / fname).write_bytes(raw)
                except Exception:
                    pass  # a cache write failure is not fatal
                continue
            cached = self._read_cache(fname)
            if cached is not None:
                self._docs[const_name] = cached
                self._status[const_name] = "cached"
            else:
                self._status[const_name] = "unavailable"
        return dict(self._status)

    @staticmethod
    def _parse(raw):
        """Parse one shelf file; None when it does not carry a
        usable values list (a malformed shelf file must degrade to
        'unavailable', never to a crash or a half-list)."""
        try:
            doc = json.loads(raw.decode("utf-8"))
        except Exception:
            return None
        if not isinstance(doc, dict) \
                or not isinstance(doc.get("values"), list) \
                or not doc["values"]:
            return None
        return doc

    def _read_cache(self, fname):
        try:
            return self._parse((self._cache_dir / fname).read_bytes())
        except Exception:
            return None

    # -- access -------------------------------------------------------

    def status(self, const_name):
        return self._status.get(const_name, "unavailable")

    def values(self, const_name):
        """The list for a constant name, or None when unavailable.
        Callers MUST handle None as the 'list unavailable' state —
        never substitute a private copy."""
        doc = self._docs.get(const_name)
        if doc is None:
            return None
        return list(doc.get("values") or [])

    def unavailable(self):
        """Constant names with no usable list this session."""
        return [name for name in VOCAB_FILES
                if self.values(name) is None]

    def decoration_wall_types(self):
        """The set of decoration types that mount on walls, from
        the shelf's placement map; None when the decoration list
        is unavailable."""
        doc = self._docs.get("DECORATION_TYPES")
        if doc is None:
            return None
        wall = (doc.get("placement") or {}).get("wall")
        if wall is None:
            return None
        return set(wall)

    def parking_labels(self):
        """{parking type: display label} from the shelf, or None."""
        doc = self._docs.get("PARKING_TYPES")
        if doc is None:
            return None
        labels = doc.get("labels")
        return dict(labels) if isinstance(labels, dict) else None

    def parking_orientations(self):
        """The parking-space orientation list from the shelf, or
        None when unavailable."""
        doc = self._docs.get("PARKING_TYPES")
        if doc is None:
            return None
        vals = doc.get("space_orientations")
        return list(vals) if isinstance(vals, list) and vals else None
