#!/usr/bin/env python3
"""
Adamsville UI Resource Editor (Native) — Data management module.

Downloads the game's UI resource list (ui-manifest.json) from GitHub,
caches it locally, and tracks Joshua's add/remove changes for pushing
back to the game repo.

Pure Python + GTK3. NO webview, NO HTML, NO JavaScript.

Joshua's rule: all code commented.
"""

import base64
import copy
import json
import os
import shutil
import sys
import urllib.request
import urllib.error
from pathlib import Path

# Shared suite module (Joshua 2026-10-11): common utilities (GitHub push,
# token storage, shared file cache) live in one place so all suite apps
# use the same code. Falls back to local implementations if not present.
# Shared suite module locations: system-wide (installed by .deb) first,
# then per-user (for development/testing). Falls back to None if neither
# exists, in which case the app uses its local implementations.
for _suite_path in ("/usr/share/adamsville-suite",
                    str(Path.home() / ".local" / "share" / "adamsville-suite")):
    if _suite_path not in sys.path:
        sys.path.insert(0, _suite_path)
try:
    import adamsville_suite as suite
except ImportError:
    suite = None  # fall back to local implementations


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Game repo and the UI manifest inside it (list of UI files + sizes + hashes)
REPO = "kingmarkarnold-code/adamsville-play"
MANIFEST_PATH = "detailed/ui-manifest.json"
MANIFEST_URL = f"https://raw.githubusercontent.com/{REPO}/main/{MANIFEST_PATH}"
API_URL = f"https://api.github.com/repos/{REPO}/contents/{MANIFEST_PATH}"
# Individual resource files download from this prefix (for image previews)
RAW_PREFIX = f"https://raw.githubusercontent.com/{REPO}/main/detailed/"

# Local data directory (XDG-compliant)
DATA_DIR = Path.home() / ".local" / "share" / "adamsville-ui-editor-native"
MANIFEST_FILE = DATA_DIR / "ui-manifest.json"
VERSION_FILE = DATA_DIR / "version.json"
WINDOW_FILE = DATA_DIR / "window.json"
# Joshua's pending add/remove changes (not yet pushed to GitHub)
CHANGES_FILE = DATA_DIR / "pending_changes.json"
# Files Joshua added from local disk wait here until pushed
STAGING_DIR = DATA_DIR / "staging"
# Lazily downloaded resource files (image previews only)
PREVIEW_DIR = DATA_DIR / "previews"

USER_AGENT = "adamsville-ui-editor-native"

# ---------------------------------------------------------------------------
# Suite shared download cache (v1.9.0 — Joshua's editor-data rules,
# 2026-10-17: every editor list is downloaded from GitHub, never
# baked in, and all editors share ONE download cache so a download
# by one app serves the rest; standard: editors/SHARED-CACHE.md in
# the repo). shared_cache.py is vendored next to this file,
# byte-identical to the suite core copy the Building and Map
# editors use. Downloads on open route through it (fetch_repo_bytes
# below); PROOF downloads after a save deliberately do NOT — they
# must come straight off GitHub (app.py's round trip calls
# github_sync.fetch_file directly, untouched by this wiring).
# ---------------------------------------------------------------------------
try:
    import shared_cache
except ImportError:
    # Cache missing (broken install): downloads still work, just
    # uncached — fail open, never block the editor opening.
    shared_cache = None

_FETCHER = None            # the CachedFetcher, built on first use
_UI_VERSION = None         # the game's ui_version, from the manifest
_UI_VERSION_TRIED = False


def _fetcher():
    """
    The app's download-on-open door: a shared_cache.CachedFetcher
    over github_sync's transport (freshness by the standard's
    blob-SHA probe — see _fetch_ui_version for why this app does
    not register the ui-manifest's hashes), or a plain pass-through
    with the same shape when the cache module is unavailable.
    """
    global _FETCHER
    if _FETCHER is not None:
        return _FETCHER
    import github_sync
    if shared_cache is not None:
        _FETCHER = shared_cache.CachedFetcher(
            github_sync.fetch_file,
            # getattr: a transport without the metadata read still
            # works — the fetcher then verifies by full download.
            fetch_meta=getattr(github_sync, "fetch_file_meta", None))
    else:
        class _PlainFetcher:
            """Cache-less fallback with the CachedFetcher shape."""
            paths_served_stale = []

            def register_manifest(self, raw):
                pass

            def fetch(self, repo, path, **kwargs):
                return github_sync.fetch_file(repo, path)

        _FETCHER = _PlainFetcher()
    return _FETCHER


def _fetch_ui_version():
    """
    Fetch the game's ui-manifest FRESH (direct Contents API read,
    never the cache) once per process — only to learn the game's
    ui_version for the Menus tab's currency line.

    The manifest's per-file sha256 entries are deliberately NOT
    registered with the cache fetcher. SHARED-CACHE.md's freshness
    rule offers the blob-SHA probe as a first-class alternative,
    and this app needs it: the UI Editor's own saves rewrite
    ui_layout.json / menu_layout.json WITHOUT rewriting
    ui-manifest.json (only full pushes update it), so the
    manifest's hashes can lag the very files they describe — and a
    registered stale hash would make the cache REFUSE the editor's
    own freshly saved file on the next open (the harness's D7
    reopen scenario caught exactly that). The probe reads each
    file's own Contents metadata, which can never lag the file.
    """
    global _UI_VERSION, _UI_VERSION_TRIED
    if _UI_VERSION_TRIED:
        return
    _UI_VERSION_TRIED = True
    try:
        import github_sync
        raw, _err = github_sync.fetch_file(REPO, MANIFEST_PATH)
        if raw:
            _UI_VERSION = json.loads(
                raw.decode("utf-8")).get("ui_version")
    except Exception:
        _UI_VERSION = None


def served_stale_paths():
    """
    Repo paths this process served from the shared cache because a
    fresh download/verification failed (offline). app.py surfaces
    these in the status bar, per SHARED-CACHE.md rule 3 — a stale
    serve is always shown, never silent.
    """
    try:
        return list(_fetcher().paths_served_stale)
    except Exception:
        return []

# Extensions we can show a thumbnail for
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
# Extensions treated as readable text for the preview pane
TEXT_EXTS = {".js", ".json", ".html", ".css", ".txt", ".md", ".xml", ".svg"}


# ---------------------------------------------------------------------------
# Resource typing helpers
# ---------------------------------------------------------------------------

def resource_type(name):
    """
    Human-readable type label from a file extension.
    Examples: "app.js" -> "JavaScript", "icon.png" -> "Image".
    """
    ext = Path(name).suffix.lower()
    if ext in IMAGE_EXTS:
        return "Image"
    if ext == ".js":
        return "JavaScript"
    if ext == ".json":
        return "JSON data"
    if ext in (".mp3", ".ogg", ".wav", ".m4a"):
        return "Audio"
    if ext in (".mp4", ".webm"):
        return "Video"
    if ext == ".bin":
        return "Binary data"
    if ext in TEXT_EXTS:
        return "Text"
    if ext == "":
        return "File"
    return ext[1:].upper() + " file"


def is_image(name):
    """True if this resource can be previewed as a thumbnail image."""
    return Path(name).suffix.lower() in IMAGE_EXTS


def is_text(name):
    """True if this resource can be previewed as text."""
    return Path(name).suffix.lower() in TEXT_EXTS


def is_visual(name):
    """
    True if this resource is a *visual* UI resource worth showing when
    Joshua enables the "Visual only" filter: images, JavaScript UI
    files, and JSON layout files. Everything else (background scripts,
    raw data, audio, binaries) is hidden by that filter.
    """
    ext = Path(name).suffix.lower()
    if ext in IMAGE_EXTS or ext == ".svg":
        return True
    if ext in (".js", ".json"):
        return True
    return False


def stage_content(name, data_bytes):
    """
    Stage raw bytes as a file (used for content Joshua edited in the
    visual editors). Same bookkeeping as stage_added_file: the file
    lands in STAGING_DIR and is marked "added" — under the v1.7.7
    save protocol the staging area is step 1 (local save) and the
    same save action immediately pushes it and re-downloads the
    GitHub copy. Any pending removal of the same name is cancelled
    (editing wins over removing).
    Returns the staged file name, or None on failure.
    """
    ensure_data_dir()
    # Keep the staging name safe: plain file name only, no directories.
    # (Same convention as stage_added_file.)
    safe = Path(name).name
    try:
        (STAGING_DIR / safe).write_bytes(data_bytes)
    except Exception as e:
        print(f"Could not stage edited content for {name}: {e}")
        return None
    changes = load_changes()
    if safe not in changes["added"]:
        changes["added"].append(safe)
    if safe in changes["removed"]:
        changes["removed"].remove(safe)  # editing cancels a pending removal
    save_changes(changes)
    return safe


def staged_bytes(name):
    """
    v1.7.7: the staged (locally saved, not yet pushed) bytes for a
    file name, or None if nothing is staged under that name.

    The tabs check this on open: a staged copy that differs from the
    repo is Joshua's unsaved work and must be what he sees — in 1.7.6
    the tabs re-downloaded over it and his edits silently vanished
    from view (the menu bug, 2026-10-16).
    """
    try:
        p = STAGING_DIR / Path(name).name
        if p.exists():
            return p.read_bytes()
    except Exception:
        pass
    return None


def clear_staged(name):
    """
    v1.7.7: drop a staged copy after its content has been pushed to
    GitHub AND re-downloaded (the save round trip is complete, so the
    staged bytes and the repo bytes are the same thing). Also removes
    the name from the pending "added" list. Safe to call when nothing
    is staged.
    """
    safe = Path(name).name
    try:
        (STAGING_DIR / safe).unlink()
    except Exception:
        pass  # not staged — nothing to drop
    changes = load_changes()
    if safe in changes["added"]:
        changes["added"].remove(safe)
        save_changes(changes)


# ---------------------------------------------------------------------------
# UI layout editor (visual) — ui_layout.json
# ---------------------------------------------------------------------------
# Joshua's visual UI layout editor works on ui_layout.json: every HUD
# element's id, type, anchor, offsets, size, and visibility. The game
# fetches the same file at startup (see ui_layout_apply.js in the game
# repo) so what Joshua arranges here is what players see.

# Canonical reference frame the x/y offsets were authored against.
CANON_W, CANON_H = 1280, 800

LAYOUT_URL = RAW_PREFIX + "ui_layout.json"
LAYOUT_FILE = DATA_DIR / "ui_layout.json"
# Repo-relative paths (Contents API) for the documents this app edits.
# v1.7.7: downloads go through the API first (see fetch_repo_bytes) so
# the editor always opens on the repo's CURRENT bytes, never a CDN copy.
LAYOUT_REPO_PATH = "detailed/ui_layout.json"
MENU_REPO_PATH = "detailed/menu_layout.json"
# Shipped fallback when GitHub is unreachable on first run.
DEFAULT_LAYOUT_FILE = Path(__file__).parent / "ui_layout_default.json"

# ---------------------------------------------------------------------------
# Layout faces (v1.8.0) — one layout document, two device faces
# ---------------------------------------------------------------------------
# The layout document now carries TWO element lists ("faces"): one for
# Mobile screens and one for Desktop screens. The game applies the face
# that matches the screen it is running on. The top-level "elements"
# list stays in the document as a legacy mirror of the MOBILE face, so
# older readers (and the download shape checks below, which require a
# top-level "elements" list) keep working unchanged.
#
# (key, label) pairs for the two faces, in editor display order.
LAYOUT_FACES = [("mobile", "Mobile"), ("desktop", "Desktop")]


def ensure_layout_faces(doc):
    """
    Guarantee a layout document has a well-formed "faces" section.

    Rules (v1.8.0):
      * If there is no usable faces section at all, build one: the
        mobile face takes the document's current top-level "elements"
        list OBJECT itself (not a copy), and the desktop face starts
        as a deep copy of it — so an old-format document migrates with
        its elements becoming its mobile face verbatim.
      * If faces exist but one face is missing or partial, that face
        is filled from the other face (deep copy); if neither face is
        usable, both are built from the top-level elements as above.
      * The function ALWAYS finishes by pointing the top-level
        "elements" mirror at the mobile face's list (the same object),
        so inside the editor the mirror and the mobile face can never
        drift apart.
    Returns the (possibly fixed) doc.
    """
    if not isinstance(doc, dict):
        return doc
    # The legacy top-level list: the migration source when no usable
    # face exists. A missing/invalid one behaves as an empty layout.
    top = doc.get("elements")
    if not isinstance(top, list):
        top = []
    faces = doc.get("faces")
    if not isinstance(faces, dict):
        faces = {}
        doc["faces"] = faces

    def _face_elements(key):
        """Usable elements list for one face, or None if unusable."""
        face = faces.get(key)
        if isinstance(face, dict) and isinstance(face.get("elements"),
                                                 list):
            return face["elements"]
        return None

    mobile_els = _face_elements("mobile")
    desktop_els = _face_elements("desktop")
    if mobile_els is None and desktop_els is None:
        # No usable face: migrate from the top-level elements. The
        # mobile face adopts that list object itself; the desktop
        # face gets an independent deep copy.
        mobile_els = top
        desktop_els = copy.deepcopy(top)
    elif mobile_els is None:
        # One face missing/partial: fill it from the other face.
        mobile_els = copy.deepcopy(desktop_els)
    elif desktop_els is None:
        desktop_els = copy.deepcopy(mobile_els)
    # Write the lists back, keeping a valid face dict where one exists
    # (and any extra keys it carries).
    for key, els in (("mobile", mobile_els), ("desktop", desktop_els)):
        face = faces.get(key)
        if not isinstance(face, dict):
            face = {}
            faces[key] = face
        face["elements"] = els
    # The mirror rule: top-level "elements" IS the mobile face's list
    # (same object), never a separate copy that could drift.
    doc["elements"] = faces["mobile"]["elements"]
    return doc


def layout_face_elements(doc, face):
    """
    The elements list of one face ("mobile" or "desktop"), after
    ensure_layout_faces() has run. Unknown face keys fall back to the
    mobile face. The returned list is the document's own list object —
    editing it edits the document.
    """
    ensure_layout_faces(doc)
    if face not in dict(LAYOUT_FACES):
        face = "mobile"
    return doc["faces"][face]["elements"]

# ---------------------------------------------------------------------------
# Per-size layouts (v1.10.0) — Joshua's design, DECIDED 2026-10-25:
# an explicit ENVIRONMENT choice (Application/APK vs Web); under each
# device class, layouts are saved PER NAMED SCREEN SIZE and every
# size's layout is tweaked independently (moving an icon in one size
# never disturbs another). The game picks the layout matching the
# screen it finds, falling back to the nearest size.
# ---------------------------------------------------------------------------
# The document grows a top-level "sizes" list. Each entry:
#   {"key": str,            stable id used in code and the editor
#    "name": str,           what Joshua sees in the Size dropdown
#    "cls": "mobile"|"desktop",   device class (which face seeded it)
#    "width": int, "height": int,  the screen size in CSS pixels —
#                           the units the game measures (SAView /
#                           visualViewport) and the editor previews
#    "envs": ["app", "web"],       environments this size applies to
#    "elements": [...]}            this size's own element list
# The faces stay exactly as they were: they are the fallback for
# screens no size matches well, and the top-level "elements" mirror
# rule is unchanged. Old readers ignore "sizes" entirely.
#
# (key, label) pairs for the environments, in editor display order.
LAYOUT_ENVIRONMENTS = [("app", "Application (APK)"), ("web", "Web")]

# The seed sizes, in dropdown order. Every seed starts as a deep copy
# of its class face, so nothing changes visually on any screen until
# Joshua edits that specific size.
#
# WHERE THE NUMBERS COME FROM (stated plainly, 2026-10-25): no
# on-device measurement of Joshua's phones was ever recorded, so the
# three devices are seeded from their MANUFACTURER display
# resolutions at each model's standard Android display density —
# i.e. the CSS-pixel size the game will measure:
#   Galaxy A17 5G   1080x2340 panel (Samsung)   -> 360x780 CSS
#   TCL K33 5G      720x1600 panel (TCL)        -> 360x800 CSS
#   FOXXD A67L      720x1600 panel (FOXXD)      -> 360x800 CSS
# Each phone also gets a landscape entry (the game plays landscape).
# TCL and FOXXD land on the same frame numbers; they stay separate
# named layouts because independence is the point of the design.
# The three "standard" sizes are the editor's old preview presets
# (Phone portrait / Phone landscape / Tablet), now real layouts.
# The desktop side carries Joshua's laptop class (1366x768) plus the
# 1280x800 canonical reference frame the layouts are authored in.
LAYOUT_SIZE_SEEDS = [
    # key, name, cls, width, height
    ("galaxy-a17-5g", "Galaxy A17 5G", "mobile", 360, 780),
    ("galaxy-a17-5g-landscape", "Galaxy A17 5G — landscape",
     "mobile", 780, 360),
    ("tcl-k33-5g", "TCL K33 5G", "mobile", 360, 800),
    ("tcl-k33-5g-landscape", "TCL K33 5G — landscape",
     "mobile", 800, 360),
    ("foxxd-a67l", "FOXXD A67L", "mobile", 360, 800),
    ("foxxd-a67l-landscape", "FOXXD A67L — landscape",
     "mobile", 800, 360),
    ("phone-portrait", "Phone portrait (standard)", "mobile", 390, 844),
    ("phone-landscape", "Phone landscape (standard)",
     "mobile", 844, 390),
    ("tablet", "Tablet (standard)", "mobile", 820, 1180),
    ("laptop-1366x768", "Laptop 1366×768", "desktop", 1366, 768),
    ("desktop-1280x800", "Desktop 1280×800 (reference)",
     "desktop", 1280, 800),
]


def ensure_layout_sizes(doc):
    """
    Guarantee a layout document has a well-formed "sizes" section
    (v1.10.0). Runs AFTER ensure_layout_faces (the seeds copy faces).

    Rules:
      * "sizes" absent or not a list -> SEED: one entry per
        LAYOUT_SIZE_SEEDS row, each entry's elements a DEEP COPY of
        its class face's elements. This is the migration: a document
        in the pre-1.10.0 format gains per-size layouts that are
        element-for-element identical to its faces, so no screen
        changes visually until a specific size is edited.
      * "sizes" present (even an empty list) -> RESPECT it: entries
        are Joshua's data, never re-seeded (a size he removed stays
        removed). Malformed entries are repaired in place where a
        repair is unambiguous: a missing/invalid elements list is
        refilled from the entry's class face, missing name/cls/envs/
        width/height get sane defaults, a missing key gets a
        generated one. Entries that are not dicts are dropped.
    Returns the (possibly fixed) doc.
    """
    if not isinstance(doc, dict):
        return doc
    ensure_layout_faces(doc)
    sizes = doc.get("sizes")
    if not isinstance(sizes, list):
        seeded = []
        for key, name, cls, w, h in LAYOUT_SIZE_SEEDS:
            seeded.append({
                "key": key,
                "name": name,
                "cls": cls,
                "width": w,
                "height": h,
                # Seeds apply to both environments; Joshua can
                # narrow a size from the editor's "Applies to" menu.
                "envs": ["app", "web"],
                "elements": copy.deepcopy(
                    doc["faces"][cls]["elements"]),
            })
        doc["sizes"] = seeded
        return doc
    repaired = []
    for i, entry in enumerate(sizes):
        if not isinstance(entry, dict):
            continue  # unrepairable — dropped, never crashes the load
        if not isinstance(entry.get("key"), str) or not entry["key"]:
            entry["key"] = f"size-{i + 1}"
        if entry.get("cls") not in ("mobile", "desktop"):
            entry["cls"] = "mobile"
        if not isinstance(entry.get("name"), str) or not entry["name"]:
            entry["name"] = entry["key"]
        for dim in ("width", "height"):
            try:
                entry[dim] = int(entry[dim])
            except Exception:
                entry[dim] = 390 if dim == "width" else 844
        envs = entry.get("envs")
        if not isinstance(envs, list) or not envs:
            entry["envs"] = ["app", "web"]
        else:
            entry["envs"] = [e for e in envs if e in ("app", "web")] \
                or ["app", "web"]
        if not isinstance(entry.get("elements"), list):
            entry["elements"] = copy.deepcopy(
                doc["faces"][entry["cls"]]["elements"])
        repaired.append(entry)
    doc["sizes"] = repaired
    return doc


def layout_size_entries(doc, env=None, cls=None):
    """
    The document's size entries (the live dicts — editing them edits
    the document), optionally filtered to one environment ("app" /
    "web") and/or one device class ("mobile" / "desktop"). Order is
    the document's order (the editor's dropdown order).
    """
    ensure_layout_sizes(doc)
    out = []
    for entry in doc["sizes"]:
        if cls is not None and entry.get("cls") != cls:
            continue
        if env is not None and env not in entry.get("envs", []):
            continue
        out.append(entry)
    return out


def layout_size_entry(doc, key):
    """One size entry by key, or None."""
    ensure_layout_sizes(doc)
    for entry in doc["sizes"]:
        if entry.get("key") == key:
            return entry
    return None


def layout_size_elements(doc, key):
    """
    The elements list of one size entry (the document's own list
    object — editing it edits the document), or None for an
    unknown key.
    """
    entry = layout_size_entry(doc, key)
    return entry["elements"] if entry else None

# View modes Joshua can preview: (key, label, width, height).
# "web_mobile" expands into size presets in the UI.
LAYOUT_VIEWS = [
    ("app", "Application (mobile)", 390, 844),
    ("web_desktop", "Web desktop", 1280, 800),
    ("web_mobile", "Web mobile", 390, 844),  # presets override size
]
WEB_MOBILE_PRESETS = [
    ("Phone portrait", 390, 844),
    ("Phone landscape", 844, 390),
    ("Tablet", 820, 1180),
]

ANCHORS = ["tl", "tr", "bl", "br", "tc", "bc", "c"]
ANCHOR_LABELS = {
    "tl": "top-left", "tr": "top-right", "bl": "bottom-left",
    "br": "bottom-right", "tc": "top-center", "bc": "bottom-center",
    "c": "center",
}


def canon_scale(vw, vh):
    # v1.7.6 CANONICAL FRAME FIX (2026-10-12): uniform scale factor from
    # the 1280x800 canonical frame to a vw x vh viewport. Mirrors
    # ui_layout_apply.js in the game repo — keep them in sync.
    return min(vw / CANON_W, vh / CANON_H)


def anchor_to_left_top(el, vw, vh):
    """
    Convert an element's (anchor, x, y, width, height) into concrete
    left/top pixel coordinates for a viewport of vw x vh.
    Mirrors ui_layout_apply.js in the game repo — keep them in sync.

    v1.7.6: element coordinates are 1280x800 CANONICAL pixels (the frame
    the game renders from). They are scaled uniformly by
    s = min(vw/1280, vh/800), then anchored to the real viewport —
    exactly like the game. Previously the editor treated them as raw
    view-frame pixels, so the preview did not match the game.
    """
    w, h = el.get("width", 50), el.get("height", 30)
    x, y, a = el.get("x", 0), el.get("y", 0), el.get("anchor", "tl")
    s = canon_scale(vw, vh)
    sw, sh, ox, oy = w * s, h * s, x * s, y * s
    if a == "tr":
        return vw - ox - sw, oy
    if a == "bl":
        return ox, vh - oy - sh
    if a == "br":
        return vw - ox - sw, vh - oy - sh
    if a == "tc":
        return vw / 2 + ox - sw / 2, oy
    if a == "bc":
        return vw / 2 + ox - sw / 2, vh - oy - sh
    if a == "c":
        return vw / 2 + ox - sw / 2, vh / 2 + oy - sh / 2
    return ox, oy  # "tl"


def element_size_in_view(el, vw, vh):
    # v1.7.6: scaled (width, height) in view pixels, mirroring the
    # game's sw/sh. Callers must use this instead of the raw stored
    # width/height when drawing or hit-testing in a viewport.
    s = canon_scale(vw, vh)
    return el.get("width", 50) * s, el.get("height", 30) * s


def left_top_to_xy(el, left, top, vw, vh):
    """
    Inverse of anchor_to_left_top: given a dragged left/top position
    (in view pixels), recompute the canonical x/y offsets so the
    element keeps its anchor. Returns (x, y) rounded to whole
    canonical pixels. Mirrors ui_layout_apply.js — keep in sync.
    """
    s = canon_scale(vw, vh)
    sw = el.get("width", 50) * s
    sh = el.get("height", 30) * s
    a = el.get("anchor", "tl")
    if a == "tr":
        return round((vw - left - sw) / s), round(top / s)
    if a == "bl":
        return round(left / s), round((vh - top - sh) / s)
    if a == "br":
        return round((vw - left - sw) / s), round((vh - top - sh) / s)
    if a == "tc":
        return round((left - (vw - sw) / 2) / s), round(top / s)
    if a == "bc":
        return round((left - (vw - sw) / 2) / s), round((vh - top - sh) / s)
    if a == "c":
        return round((left - (vw - sw) / 2) / s), round((top - (vh - sh) / 2) / s)
    return round(left / s), round(top / s)  # "tl"


def fetch_repo_bytes(repo_path):
    """
    Fetch a file's CURRENT bytes from the game repo (download on
    open — the Layout tab's ui_layout.json, the Menus tab's
    menu_layout.json and the game's menu-bearing files).

    v1.7.7: goes through the GitHub Contents API (authenticated
    when the suite token is set), which always serves the repo's
    current blob, unlike raw.githubusercontent.com, whose CDN
    cache can hand back a stale copy.
    v1.9.0: routed through the suite SHARED CACHE (see the section
    above): when the shared cache already holds these exact bytes
    (proven against the ui-manifest's sha256), they are served
    locally with no download; when a download fails, the cache may
    serve the previous copy and the path is recorded in
    served_stale_paths() for the status bar. NOT used for proof
    downloads after a save — those call github_sync.fetch_file
    directly in app.py, by design.
    Returns the raw bytes, or None if the fetch failed.
    """
    try:
        data, err = _fetcher().fetch(REPO, repo_path)
        if data is not None:
            return data
        print(f"Repo fetch failed for {repo_path}: {err}")
    except Exception as e:
        print(f"Repo fetch unavailable for {repo_path}: {e}")
    return None


def _download_raw(url):
    """Plain raw.githubusercontent download. Returns bytes or None."""
    try:
        req = urllib.request.Request(url,
                                     headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read()
    except Exception as e:
        print(f"Raw download failed ({url}): {e}")
        return None


def _store_doc_bytes(cache_file, data, key, expect):
    """
    Validate fetched document bytes and store them in the local cache.
    key/expect: the top-level key that must exist and its type
    ("elements"/list for layouts, "menus"/dict for menus) — the same
    shape checks the downloads have always done, so a bad response can
    never overwrite a good cache. Atomic write (temp file -> rename).
    Returns True if the bytes were valid and stored.
    """
    try:
        doc = json.loads(data.decode("utf-8"))
        if not isinstance(doc.get(key), expect):
            return False
    except Exception:
        return False
    ensure_data_dir()
    tmp_path = cache_file.with_suffix(".tmp")
    tmp_path.write_bytes(data)
    tmp_path.rename(cache_file)
    return True


def download_ui_layout():
    """
    Download ui_layout.json from the game repo into the local cache.
    v1.7.7: Contents API first (current bytes, guaranteed), the raw
    URL only as a fallback. Returns True on success, False on failure.
    """
    ensure_data_dir()
    data = fetch_repo_bytes(LAYOUT_REPO_PATH)
    if data is not None and _store_doc_bytes(LAYOUT_FILE, data,
                                             "elements", list):
        return True
    # Fallback: the raw URL (may be CDN-cached, but better than nothing).
    data = _download_raw(LAYOUT_URL)
    if data is not None:
        return _store_doc_bytes(LAYOUT_FILE, data, "elements", list)
    return False


def load_ui_layout():
    """
    Load the UI layout: local cache first, shipped default as fallback.
    Returns the parsed dict, or None if nothing is available.
    """
    for path in (LAYOUT_FILE, DEFAULT_LAYOUT_FILE):
        try:
            if path.exists():
                doc = json.loads(path.read_text())
                if isinstance(doc.get("elements"), list):
                    return doc
        except Exception:
            continue
    return None


def format_size(num_bytes):
    """Format a byte count as '1.4 MB', '255 KB', etc."""
    n = float(num_bytes or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024.0 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024.0
    return f"{n:.1f} GB"


# ---------------------------------------------------------------------------
# Data directory setup
# ---------------------------------------------------------------------------

def ensure_data_dir():
    """Create the local data directory (and subdirs) if missing."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# GitHub download and version checking
# ---------------------------------------------------------------------------

def get_remote_sha():
    """
    Get the current blob SHA of ui-manifest.json on GitHub.
    Returns None if offline or on error (non-blocking by design).
    """
    try:
        req = urllib.request.Request(
            API_URL,
            headers={"User-Agent": USER_AGENT,
                     "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return data.get("sha")
    except Exception:
        return None  # offline or API error — caller handles None


def get_local_sha():
    """Read the saved SHA of the locally cached manifest."""
    try:
        with open(VERSION_FILE) as f:
            return json.load(f).get("sha")
    except Exception:
        return None


def save_local_sha(sha):
    """Save the SHA after a successful download."""
    ensure_data_dir()
    with open(VERSION_FILE, "w") as f:
        json.dump({"sha": sha, "source": "github"}, f)


def needs_download():
    """
    Check if we need to (re)download ui-manifest.json.
    Returns (needed: bool, reason: str).
    """
    if not MANIFEST_FILE.exists():
        return True, "UI resource list not found locally. Download from GitHub?"
    local_sha = get_local_sha()
    if not local_sha:
        return True, "Local version unknown. Re-download from GitHub?"
    remote_sha = get_remote_sha()
    if remote_sha is None:
        return False, "Offline — using local copy."
    if remote_sha != local_sha:
        return True, "A newer version is available on GitHub. Download?"
    return False, "Local copy is up to date."


def download_manifest(progress_callback=None):
    """
    Download ui-manifest.json from GitHub into the local cache.
    Returns True on success, False on failure.
    Uses atomic write (temp file -> rename) to avoid partial files.
    """
    ensure_data_dir()
    try:
        req = urllib.request.Request(MANIFEST_URL,
                                     headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            chunks = []
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                downloaded += len(chunk)
                if progress_callback:
                    progress_callback(downloaded, total)
        # Atomic write
        tmp_path = MANIFEST_FILE.with_suffix(".tmp")
        with open(tmp_path, "wb") as f:
            for chunk in chunks:
                f.write(chunk)
        tmp_path.rename(MANIFEST_FILE)
        remote_sha = get_remote_sha()
        if remote_sha:
            save_local_sha(remote_sha)
        return True
    except Exception as e:
        print(f"Manifest download failed: {e}")
        return False


def download_resource(name, progress_callback=None):
    """
    Lazily download one resource file (used for image previews).
    Returns the local Path on success, None on failure.
    Cached in PREVIEW_DIR so it is only fetched once.
    """
    ensure_data_dir()
    dest = PREVIEW_DIR / name
    if dest.exists():
        return dest  # already cached
    try:
        req = urllib.request.Request(RAW_PREFIX + name,
                                     headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        tmp_path = dest.with_suffix(".tmp")
        tmp_path.write_bytes(data)
        tmp_path.rename(dest)
        return dest
    except Exception as e:
        print(f"Resource download failed ({name}): {e}")
        return None


def load_manifest():
    """
    Load the cached UI manifest.
    Returns a list of {"name": str, "size": int} dicts, or None if missing.
    """
    try:
        with open(MANIFEST_FILE) as f:
            doc = json.load(f)
        files = doc.get("files", [])
        return [{"name": e.get("name", "?"),
                 "size": int(e.get("size", 0))} for e in files]
    except Exception:
        return None


def read_text_preview(local_path, max_chars=2000):
    """
    Read the first max_chars of a text file for the preview pane.
    Returns the text, or an error note if unreadable.
    """
    try:
        with open(local_path, "r", errors="replace") as f:
            text = f.read(max_chars + 1)
        if len(text) > max_chars:
            text = text[:max_chars] + "\n…(truncated)"
        return text
    except Exception as e:
        return f"(could not read file: {e})"


# ---------------------------------------------------------------------------
# Pending add/remove change tracking
# ---------------------------------------------------------------------------
# Joshua's changes are tracked locally until he pushes them:
#   {"added": ["file1.png", ...], "removed": ["old.js", ...]}
# Added files are copied into STAGING_DIR. Removed names refer to manifest
# entries. export_payload() builds the push package.

def load_changes():
    """Read pending changes from disk. Returns {"added": [], "removed": []}."""
    try:
        if CHANGES_FILE.exists():
            doc = json.loads(CHANGES_FILE.read_text())
            return {"added": list(doc.get("added", [])),
                    "removed": list(doc.get("removed", []))}
    except Exception:
        pass  # corrupt file — start fresh rather than crash
    return {"added": [], "removed": []}


def save_changes(changes):
    """Persist pending changes to disk."""
    ensure_data_dir()
    CHANGES_FILE.write_text(json.dumps(changes, indent=2))


def stage_added_file(src_path):
    """
    Copy a local file into the staging dir and mark it as added.
    If a manifest file with the same name is marked removed, unmark it
    (re-adding wins over removing).
    Returns the staged file name, or None on failure.
    """
    ensure_data_dir()
    name = Path(src_path).name
    # Keep the staging name safe: plain file name only, no directories
    dest = STAGING_DIR / name
    try:
        shutil.copy2(src_path, dest)
    except Exception as e:
        print(f"Could not stage {src_path}: {e}")
        return None
    changes = load_changes()
    if name not in changes["added"]:
        changes["added"].append(name)
    if name in changes["removed"]:
        changes["removed"].remove(name)  # re-adding cancels a pending removal
    save_changes(changes)
    return name


def mark_removed(name):
    """
    Mark a manifest resource for removal (pending push).
    If the file was staged as a brand-new add (not in the manifest),
    unstage it instead (nothing to push).
    If it was a staged *edit* of an existing game file (Joshua's pencil
    edit, 2026-10-11), drop the edit AND mark it removed — removal wins.
    """
    changes = load_changes()
    staged = STAGING_DIR / name
    in_manifest = any(e.get("name") == name
                      for e in (load_manifest() or []))
    if staged.exists() and name in changes["added"]:
        # Drop the staged copy either way.
        try:
            staged.unlink()
        except Exception:
            pass
        changes["added"].remove(name)
        if in_manifest and name not in changes["removed"]:
            # It was an edit of a real game file: removal still applies.
            changes["removed"].append(name)
    elif name not in changes["removed"]:
        changes["removed"].append(name)
    save_changes(changes)


def undo_pending_for(name):
    """
    Cancel a pending change for one resource (un-remove or un-add).
    Returns True if something was cancelled.
    """
    changes = load_changes()
    changed = False
    if name in changes["removed"]:
        changes["removed"].remove(name)
        changed = True
    if name in changes["added"]:
        changes["added"].remove(name)
        changed = True
        try:
            (STAGING_DIR / name).unlink()
        except Exception:
            pass
    if changed:
        save_changes(changes)
    return changed


def pending_count():
    """Total number of pending add/remove changes."""
    c = load_changes()
    return len(c["added"]) + len(c["removed"])


def export_payload():
    """
    Build the push package for GitHub.

    Returns a dict:
      {"added": [{"name":..., "size":..., "data_base64":...}, ...],
       "removed": ["name", ...],
       "target_repo": ..., "target_dir": "detailed"}
    Added files are base64-encoded so binary images survive the JSON trip.
    Returns None if there is nothing to push.
    """
    changes = load_changes()
    if not changes["added"] and not changes["removed"]:
        return None
    added = []
    for name in changes["added"]:
        p = STAGING_DIR / name
        try:
            raw = p.read_bytes()
        except Exception:
            continue  # staged file vanished — skip it
        added.append({"name": name,
                      "size": len(raw),
                      "data_base64": base64.b64encode(raw).decode("ascii")})
    return {"added": added,
            "removed": list(changes["removed"]),
            "target_repo": REPO,
            "target_dir": "detailed"}


def clear_changes_after_push():
    """
    Clear local pending changes after Joshua confirms the push was applied.
    Removes staged files and the changes file.
    """
    try:
        if STAGING_DIR.exists():
            shutil.rmtree(STAGING_DIR)
        STAGING_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    try:
        if CHANGES_FILE.exists():
            CHANGES_FILE.unlink()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Window state persistence
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
# Menu editor (visual) — menu_layout.json
# ---------------------------------------------------------------------------
# Joshua's menu editor works on menu_layout.json: every game menu's title,
# groups, items, labels, descriptions, and visibility. The game fetches the
# same file at startup (see menu_layout_apply.js in the game repo) so what
# Joshua arranges here is what players see.
#
# Document shape:
#   {"menus": {menu_key: {"title", "description", "groups": [...],
#                         "ungrouped": [...]}},
#    "version": N}
# Group shape:  {"name": str, "items": [item, ...]}
#               + optional "start": "expanded"|"collapsed" (v1.7.8 —
#               written only when Joshua sets the group's start state;
#               absent = today's behavior, honored by the game)
# Item shape:   {"id", "label", "description", "action", "visible"}

MENU_LAYOUT_URL = RAW_PREFIX + "menu_layout.json"
MENU_LAYOUT_FILE = DATA_DIR / "menu_layout.json"


def download_menu_layout():
    """
    Download menu_layout.json from the game repo into the local cache.
    v1.7.7: Contents API first (current bytes, guaranteed), the raw
    URL only as a fallback — same fix as download_ui_layout.
    Returns True on success, False on failure (offline / missing).
    """
    ensure_data_dir()
    data = fetch_repo_bytes(MENU_REPO_PATH)
    if data is not None and _store_doc_bytes(MENU_LAYOUT_FILE, data,
                                             "menus", dict):
        return True
    # Fallback: the raw URL (may be CDN-cached, but better than nothing).
    data = _download_raw(MENU_LAYOUT_URL)
    if data is not None:
        return _store_doc_bytes(MENU_LAYOUT_FILE, data, "menus", dict)
    return False


def load_menu_layout():
    """
    Load the menu layout: local cache first, None if unavailable.
    Returns the parsed dict, or None if nothing is available.
    Unlike ui_layout.json there is no shipped default — the menus are
    extracted from the game code on first download.
    """
    try:
        if MENU_LAYOUT_FILE.exists():
            doc = json.loads(MENU_LAYOUT_FILE.read_text())
            if isinstance(doc.get("menus"), dict):
                return doc
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# The game's menu-bearing files (v1.9.0 — menu currency). game_menus.py
# derives the game's CURRENT menus from these; the Menus tab downloads
# them on open, through the shared cache like every download-on-open.
# ---------------------------------------------------------------------------
GAME_MENU_FILES = ("index.html", "goto.js", "hud_move.js")


def download_game_menu_files():
    """
    Download the game's menu-bearing files (fresh-or-cache via
    fetch_repo_bytes). Returns {name: text or None} — a file that
    could not be fetched is None and its source is simply skipped
    by the derivation (fail-open: the tab still shows
    menu_layout.json exactly as downloaded).
    """
    out = {}
    for name in GAME_MENU_FILES:
        raw = fetch_repo_bytes(f"detailed/{name}")
        if raw is None:
            out[name] = None
            continue
        try:
            out[name] = raw.decode("utf-8")
        except Exception:
            out[name] = None
    return out


def game_ui_version():
    """The game's ui_version from the fresh ui-manifest, or None."""
    _fetch_ui_version()
    return _UI_VERSION


def validate_menu_doc(doc):
    """
    Ensure a menu document has the expected shape, backfilling missing
    keys so the editor never crashes on a partial file.
    Returns the (possibly fixed) doc.
    """
    if not isinstance(doc, dict):
        return {"menus": {}, "version": 1}
    if not isinstance(doc.get("menus"), dict):
        doc["menus"] = {}
    for _key, menu in doc["menus"].items():
        if not isinstance(menu, dict):
            continue
        menu.setdefault("title", "")
        menu.setdefault("description", "")
        if not isinstance(menu.get("groups"), list):
            menu["groups"] = []
        if not isinstance(menu.get("ungrouped"), list):
            menu["ungrouped"] = []
        for grp in menu["groups"]:
            if not isinstance(grp, dict):
                continue
            grp.setdefault("name", "Group")
            if not isinstance(grp.get("items"), list):
                grp["items"] = []
            for item in grp["items"]:
                _backfill_menu_item(item)
        for item in menu["ungrouped"]:
            _backfill_menu_item(item)
    return doc


def _backfill_menu_item(item):
    """Fill missing keys on a menu item dict so the editor is safe."""
    if not isinstance(item, dict):
        return
    item.setdefault("id", "")
    item.setdefault("label", "")
    item.setdefault("description", "")
    item.setdefault("action", "")
    if "visible" not in item:
        item["visible"] = True
