#!/usr/bin/env python3
"""check_inventory.py — the inventory gate for the adamsville-play repo.

WHY THIS EXISTS (Joshua's design amendment, 2026-10-17): a hand-maintained
list of "files we use" decays — a new file pushed tomorrow is not on it, a
stock file no program references yet looks like an orphan, and maintaining
the list becomes its own chore-loop. So this checker keeps NO roster. Every
run it DERIVES the used-list fresh from the code's own references:

  * the game pages' loader sets (script src / data-dsrc in the HTML),
  * the four delivery manifests (ui / map / vehicles / music),
  * the zone-dataset patterns (zoneloader.js + the Building Editor's
    ZONE_DIR / ZONE_FILES constants — every file in detailed/zones/<zone>/
    is zone dataset),
  * the editors' repo-path constants (literal detailed/... and editors/...
    paths in their sources, including their self-update file lists),
  * the watcher's live-sync list (tools/watcher/game_sync.js),
  * the GitHub workflow files' path literals,
  * runtime references inside the game and watcher code (sibling loads).

Files nobody references can still legitimately exist as STOCK, TOOLING or
DOC — but only when DECLARED in the one small registry,
tools/inventory-registry.json. The tools that create stock add their
declaration there as part of creating it; nobody edits a per-file roster.

THE GATE'S TWO QUESTIONS (and the only two):
  (a) does every reference resolve to a real file (or a declared
      creation target — a path a tool creates at runtime, like the
      Building Editor's station-edits.json on first save)?
  (b) is every file either referenced, or declared in the registry?
A file that fails (b) is a TRUE ORPHAN. A reference that fails (a) is a
DANGLING REFERENCE. The output names which side failed.

USAGE:
  python3 tools/check_inventory.py [repo_root]        # gate: exit 0/1
  python3 tools/check_inventory.py [repo_root] --snapshot OUT.json
        # also write the derived inventory snapshot (the same data
        # MIGRATION-MANIFEST.json was generated from — reproducible by
        # re-running this, never hand-edited)

Stdlib only. Run from anywhere; repo_root defaults to the current dir.
"""
import fnmatch
import json
import os
import re
import sys
from html.parser import HTMLParser

REGISTRY_PATH = "tools/inventory-registry.json"
TEXT_EXTS = {".js", ".html", ".py", ".yml", ".yaml", ".md", ".json"}
FILE_EXTS = (".js", ".json", ".bin", ".png", ".gif", ".jpg", ".jpeg",
             ".mp3", ".ogg", ".html", ".glb", ".obj", ".md", ".py",
             ".yml", ".txt", ".gz", ".css", ".svg", ".webp")
REPO_PREFIXES = ("detailed/", "editors/", "map-data/", "tools/",
                 "viewers/", "surviving-adamsville/", "world-fixes/",
                 "reports/")
ZONES = ("adamsville", "downtown", "eastatlanta", "mableton",
         "riverdale", "southfulton", "unioncity")

TOKEN_RE = re.compile(r"""['"`]([^'"`\s]{1,240})['"`]""")


def strip_query(tok):
    return tok.split("?")[0].split("#")[0]


class _HTMLRefs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for k in ("src", "data-dsrc", "href"):
            if a.get(k):
                self.refs.append(a[k])


def load_registry(root):
    p = os.path.join(root, REGISTRY_PATH)
    if not os.path.exists(p):
        return {"declarations": [], "creation_targets": [], "external": []}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def walk_files(root):
    out = []
    for dp, dn, fn in os.walk(root):
        if ".git" in dp.split(os.sep):
            continue
        dn[:] = [d for d in dn if d != ".git"]
        for name in fn:
            out.append(os.path.relpath(os.path.join(dp, name), root))
    return sorted(out)


def derive_references(root, files):
    """Return (referenced, dangling):
    referenced: {target_path: set(source descriptions)}
    dangling:   [(source, token, why)] for repo-shaped references that
                resolve to nothing (creation targets filtered by caller).
    """
    fileset = set(files)
    referenced = {}
    dangling = []

    def note(target, source):
        if target == source:
            return  # a file mentioning itself is not consumption
        referenced.setdefault(target, set()).add(source)

    def resolve_rel(token, src):
        """Resolve a relative/bare reference from src's directory."""
        base = os.path.dirname(src)
        cand = os.path.normpath(os.path.join(base, token)) if base else token
        return cand if cand in fileset else None

    # NOTE: .md files are documentation, not code — a doc MENTIONING a
    # path is not consumption, and prose is full of path-shaped text.
    # References are derived from code only (.js/.html/.py/.yml/.json).
    text_files = [f for f in files
                  if os.path.splitext(f)[1].lower() in TEXT_EXTS
                  and os.path.splitext(f)[1].lower() != ".md"
                  and f != REGISTRY_PATH
                  and f != "MIGRATION-MANIFEST.json"]
    for src in text_files:
        full = os.path.join(root, src)
        try:
            text = open(full, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        ext = os.path.splitext(src)[1].lower()

        # resolution bases: a file's own directory. The root Pages page
        # is a byte-mirror of detailed/index.html (kept by the release
        # flow), so its relative references are read against detailed/
        # as well — that is where they resolve for the canonical page.
        bases = [os.path.dirname(src)]
        if src == "index.html":
            bases.append("detailed")

        def resolve_any(tok):
            for b in bases:
                cand = os.path.normpath(os.path.join(b, tok)) if b else tok
                if cand in fileset:
                    return cand
            return tok if tok in fileset else None

        # --- HTML: real attribute references (relative to the page) ---
        if ext == ".html":
            p = _HTMLRefs()
            try:
                p.feed(text)
            except Exception:
                pass
            for raw in p.refs:
                tok = strip_query(raw)
                if not tok or tok.startswith(("http://", "https://", "//",
                                               "data:", "mailto:")):
                    continue
                hit = resolve_any(tok.lstrip("./"))
                if hit:
                    note(hit, f"{src} (page reference)")
                elif tok.endswith(FILE_EXTS):
                    dangling.append((src, raw, "page reference missing"))

        # --- manifests: entry names are delivery references ---
        if os.path.basename(src) in ("ui-manifest.json", "map-manifest.json",
                                     "vehicles-manifest.json",
                                     "music-manifest.json") \
                and src.startswith("detailed/"):
            try:
                m = json.loads(text)
                for e in m.get("files", []):
                    name = e.get("name", "")
                    tgt = "detailed/" + name
                    if tgt in fileset:
                        note(tgt, f"{src} (manifest entry)")
                    elif name:
                        dangling.append((src, name, "manifest entry missing"))
            except Exception:
                pass

        # --- template constructions: '{zone}'-style tokens are expanded
        # over the zone list; a directory constant in the same source
        # combines with a '/{zone}.json' suffix token (the editors'
        # INDEX_REPO_DIR + "/{zone}.json" pattern). Other templates
        # ({name}, {n}) name whole families and are skipped, never
        # dangling — the files they name earn their own references.
        src_tokens = [strip_query(m.group(1))
                      for m in TOKEN_RE.finditer(text)]
        dir_tokens = [t for t in src_tokens
                      if t.startswith(REPO_PREFIXES)
                      and not t.endswith(FILE_EXTS) and "{" not in t]
        for t in src_tokens:
            if "{zone}" not in t and "{zone_id}" not in t:
                continue
            for z in ZONES:
                exp = t.replace("{zone_id}", z).replace("{zone}", z)
                hit = resolve_any(exp.lstrip("./").lstrip("/"))
                if hit:
                    note(hit, f"{src} (zone template)")
                for d in dir_tokens:
                    cand = d.rstrip("/") + "/" + exp.lstrip("/")
                    if cand in fileset:
                        note(cand, f"{src} (zone template)")

        # --- quoted tokens: repo paths, self-URLs, sibling loads ---
        for m in TOKEN_RE.finditer(text):
            raw = m.group(1)
            tok = strip_query(raw)
            if not tok or "{" in tok:
                continue
            # self-URL into this repo (Pages or raw): take the tail path
            if "adamsville-play/" in tok and (
                    "github.io" in tok or "githubusercontent" in tok
                    or "github.com" in tok):
                tail = tok.split("adamsville-play/", 1)[1]
                tail = tail.split("/", 1)[1] if tail.startswith(
                    ("main", "master")) and "/" in tail else tail
                if tail in fileset:
                    note(tail, f"{src} (self-URL)")
                continue
            if tok.startswith(("http://", "https://", "//", "data:",
                               "mailto:", "blob:")):
                continue
            # literal repo-relative path (files only — directory
            # constants and templates are not references to a file)
            if tok.startswith(REPO_PREFIXES) or tok in (
                    "index.html", ".gitignore"):
                tgt = tok.lstrip("./")
                if tgt in fileset:
                    note(tgt, f"{src} (path constant)")
                elif tgt.endswith(FILE_EXTS):
                    dangling.append((src, raw, "repo path missing"))
                continue
            # watcher live-sync: load('name') under GAME_URL base
            if src == "tools/watcher/game_sync.js" and tok.endswith(".js"):
                tgt = "detailed/" + tok
                if tgt in fileset:
                    note(tgt, "tools/watcher/game_sync.js (live sync)")
                continue
            # sibling loads: a bare filename in JS/HTML resolves
            # relative to the file that names it (fetch('camera-tilt.json'),
            # load('osm_buildings.js'), AIRPORT_URL='airport.json', ...).
            # Python sources are excluded: their bare filenames are
            # local-cache files, not repo paths.
            if ext in (".js", ".html") \
                    and tok.endswith(FILE_EXTS) and "/" not in tok:
                hit = resolve_any(tok)
                if hit:
                    note(hit, f"{src} (sibling load)")
                continue
            # zone dataset construction: 'zones/<zone>/...' fragments
            zm = re.match(r"zones/([a-z]+)/(.+)$", tok)
            if zm and zm.group(1) in ZONES:
                tgt = "detailed/zones/%s/%s" % (zm.group(1), zm.group(2))
                if tgt in fileset:
                    note(tgt, f"{src} (zone path)")

    # --- zone dataset rule: zoneloader + editor ZONE_DIR constants make
    # every file under detailed/zones/<zone>/ a referenced dataset member.
    for f in files:
        parts = f.split("/")
        if len(parts) >= 3 and parts[0] == "detailed" \
                and parts[1] == "zones" and parts[2] in ZONES:
            note(f, "zone dataset (zoneloader.js / editor ZONE_DIR)")

    # --- the root Pages page is the release flow's mirror target ---
    if "index.html" in fileset:
        note("index.html", "GitHub Pages root (release-flow mirror of "
                           "detailed/index.html)")
    return referenced, dangling


def declared_class(path, registry):
    for d in registry.get("declarations", []):
        if fnmatch.fnmatch(path, d["pattern"]):
            return d
    return None


def is_creation_target(path, registry):
    for pat in registry.get("creation_targets", []):
        if fnmatch.fnmatch(path, pat):
            return True
    return False


def check(root):
    files = walk_files(root)
    registry = load_registry(root)
    referenced, dangling = derive_references(root, files)

    # dangling references to declared creation targets are fine
    real_dangling = []
    for src, tok, why in dangling:
        tgt = strip_query(tok).lstrip("./")
        if is_creation_target(tgt, registry):
            continue
        real_dangling.append((src, tok, why))

    orphans = []
    snapshot = []
    for f in files:
        consumers = sorted(referenced.get(f, ()))
        decl = declared_class(f, registry)
        if consumers:
            status, cls = "referenced", "used"
        elif decl:
            status, cls = "declared", decl["class"]
        else:
            status, cls = "orphan", "orphan"
            orphans.append(f)
        snapshot.append({"path": f, "status": status, "class": cls,
                         "referenced_by": consumers,
                         "declaration": decl["reason"] if decl else None})
    return files, snapshot, real_dangling, orphans, registry


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    root = os.path.abspath(args[0]) if args else os.getcwd()
    snap_out = None
    if "--snapshot" in argv:
        snap_out = argv[argv.index("--snapshot") + 1]
    files, snapshot, dangling, orphans, registry = check(root)
    n_ref = sum(1 for s in snapshot if s["status"] == "referenced")
    n_dec = sum(1 for s in snapshot if s["status"] == "declared")
    print(f"inventory check: {root}")
    print(f"  files: {len(files)}  referenced: {n_ref}  "
          f"declared: {n_dec}  orphans: {len(orphans)}")
    for src, tok, why in dangling:
        print(f"  DANGLING REFERENCE: {src} -> {tok} ({why})")
    for f in orphans:
        print(f"  TRUE ORPHAN: {f} (referenced by nothing, "
              f"declared as nothing)")
    if snap_out:
        with open(snap_out, "w", encoding="utf-8") as fh:
            json.dump({"generated_by": "tools/check_inventory.py "
                                       "(derived — do not hand-edit)",
                       "files": snapshot}, fh, indent=1)
        print(f"  snapshot written: {snap_out}")
    if dangling or orphans:
        print("  RESULT: FAIL")
        return 1
    print("  RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
