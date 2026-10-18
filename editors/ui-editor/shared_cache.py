# shared_cache.py — the Adamsville editor suite's SHARED download
# cache (suite standard; see editors/SHARED-CACHE.md in the repo).
#
# Joshua (2026-10-17): "Can we make it so all editors share the
# map, so if one app downloads the new version of the map the rest
# can use the same resource?" Yes — one cache for the whole suite:
#
#   ~/.local/share/adamsville-suite/cache/
#       index.json            per-file record: repo path, sha256,
#                             git blob sha, size, fetched-at, and
#                             the manifest version it came from
#       <repo path>           the cached bytes, mirroring repo paths
#                             (e.g. detailed/zones/adamsville/…)
#
# FRESHNESS RULE: a cached file may be served WITHOUT downloading
# only when its recorded sha matches the currently published one —
# the sha256 in the game's map-manifest.json (fetched fresh; it is
# tiny) for map files, or the blob sha from a Contents-API metadata
# read for editor data files. On any mismatch or absence: download
# (with progress), verify the sha, store atomically (temp file ->
# rename) under a lockfile, update the index. If the network is
# unreachable and a cache copy exists, serve it and report the read
# as STALE — downloads fail open, never block the editor.
#
# WHAT SHARES: downloaded data only. Per-app data (settings, edit
# overlays like building_edits.json, the suite token) never lives
# here and is never moved by this module.
#
# Transport is injected (github_sync's callables) so the harness
# can drive the real cache logic with a stubbed transport.

import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

CACHE_DIR = (Path.home() / ".local" / "share" / "adamsville-suite"
             / "cache")
INDEX_PATH = CACHE_DIR / "index.json"
LOCK_PATH = CACHE_DIR / ".lock"
_LOCK_STALE_S = 120.0     # a lock older than this is abandoned
_LOCK_TIMEOUT_S = 15.0    # wait at most this long for the lock


def sha256_hex(data):
    """The sha256 of bytes (the manifest's currency)."""
    return hashlib.sha256(data).hexdigest()


def blob_sha1(data):
    """The git blob SHA of bytes (the Contents API's currency)."""
    h = hashlib.sha1()
    h.update(b"blob %d\0" % len(data))
    h.update(data)
    return h.hexdigest()


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class _CacheLock:
    """A simple cross-process lockfile with a timeout. If the lock
    cannot be taken in time, work proceeds WITHOUT it (stores are
    atomic renames, so the worst outcome is duplicate work, never
    corruption) — the cache must never wedge an editor."""

    def __init__(self):
        self._fd = None

    def __enter__(self):
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            deadline = time.time() + _LOCK_TIMEOUT_S
            while True:
                try:
                    self._fd = os.open(
                        LOCK_PATH,
                        os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    os.write(self._fd,
                             f"{os.getpid()} {_now_iso()}".encode())
                    break
                except FileExistsError:
                    try:
                        age = time.time() - LOCK_PATH.stat().st_mtime
                    except OSError:
                        age = 0
                    if age > _LOCK_STALE_S:
                        try:
                            LOCK_PATH.unlink()
                        except OSError:
                            pass
                        continue
                    if time.time() > deadline:
                        break  # proceed unlocked (see class docs)
                    time.sleep(0.1)
        except Exception:
            self._fd = None
        return self

    def __exit__(self, *exc):
        if self._fd is not None:
            try:
                os.close(self._fd)
                LOCK_PATH.unlink()
            except OSError:
                pass
            self._fd = None
        return False


def _read_index():
    try:
        doc = json.loads(INDEX_PATH.read_text())
        return doc if isinstance(doc, dict) else {}
    except Exception:
        return {}


def _write_index(index):
    """Atomic index write (temp file -> rename, same directory)."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = INDEX_PATH.with_name(f".index.json.tmp-{os.getpid()}")
    tmp.write_text(json.dumps(index, indent=1))
    os.replace(tmp, INDEX_PATH)


def cache_file_path(repo_path):
    """Where a repo path's bytes live in the cache. Repo paths are
    trusted suite-internal strings; refuse anything that would
    escape the cache directory."""
    parts = [p for p in repo_path.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ValueError(f"unsafe cache path: {repo_path}")
    return CACHE_DIR.joinpath(*parts)


def get_cached(repo, repo_path):
    """
    (bytes, index_entry) for a cached file, or (None, None). The
    bytes are verified against the index's sha256 on the way out —
    a cache entry that does not match its own record is treated as
    absent, never served.
    """
    entry = _read_index().get(repo_path)
    if not entry or entry.get("repo") not in (None, repo):
        return None, None
    try:
        data = cache_file_path(repo_path).read_bytes()
    except OSError:
        return None, None
    if sha256_hex(data) != entry.get("sha256"):
        return None, None
    return data, entry


def store(repo, repo_path, data, manifest_version=None):
    """
    Store bytes in the shared cache (atomically, under the lock)
    and record them in the index. If another app already stored the
    SAME sha, the duplicate is discarded and "already" returned.
    Returns "stored" or "already".
    """
    digest = sha256_hex(data)
    with _CacheLock():
        index = _read_index()
        entry = index.get(repo_path)
        if entry and entry.get("sha256") == digest:
            try:
                if cache_file_path(repo_path).read_bytes() == data:
                    return "already"
            except OSError:
                pass
        dest = cache_file_path(repo_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.tmp-{os.getpid()}")
        tmp.write_bytes(data)
        os.replace(tmp, dest)
        index[repo_path] = {
            "repo": repo,
            "sha256": digest,
            "blobSha": blob_sha1(data),
            "size": len(data),
            "fetchedAt": _now_iso(),
            "manifestVersion": manifest_version,
        }
        _write_index(index)
    return "stored"


def fetch_through(repo, path, fetch_file, fetch_meta=None,
                  fetch_file_progress=None, progress=None,
                  expected_sha256=None, manifest_version=None):
    """
    The freshness rule, as one call. Returns (bytes, status) where
    status is "downloaded", "cache" (served fresh, no download), or
    "stale" (network failed; served the cache copy anyway); or
    (None, error_message) when there is nothing to serve.

    expected_sha256: the currently published sha256 when the caller
    already knows it (from a freshly fetched manifest). When it is
    not given and fetch_meta is available, the file's published
    blob sha is probed with one small metadata read instead.
    """
    cached, entry = get_cached(repo, path)
    expected_blob = None
    if expected_sha256 is None and fetch_meta is not None:
        meta, merr = fetch_meta(repo, path)
        if meta is not None:
            expected_blob = meta.get("sha")
        elif cached is not None:
            # Cannot check freshness (network down at the metadata
            # step) — fail open to the cache copy, marked stale.
            return cached, "stale"
    if cached is not None:
        if expected_sha256 is not None \
                and entry.get("sha256") == expected_sha256:
            return cached, "cache"
        if expected_blob is not None \
                and entry.get("blobSha") == expected_blob:
            return cached, "cache"
        if expected_sha256 is None and expected_blob is None:
            # No freshness source at all: the metadata probe is the
            # only check and it was not offered — serve the cache
            # rather than re-downloading blind. (Suite callers pass
            # fetch_meta or a manifest sha; this branch is a safety
            # net, and it never serves bytes whose index record did
            # not verify — get_cached already checked the sha256.)
            return cached, "cache"
    # Download (progress variant when offered), then verify + store.
    if progress is not None and fetch_file_progress is not None:
        data, err = fetch_file_progress(repo, path, progress=progress)
    else:
        data, err = fetch_file(repo, path)
    if data is None:
        if cached is not None:
            return cached, "stale"
        return None, err
    if expected_sha256 is not None \
            and sha256_hex(data) != expected_sha256:
        return None, (f"Downloaded {path} but its sha256 does not "
                      f"match the published manifest — refusing to "
                      f"use it.")
    if expected_blob is not None and blob_sha1(data) != expected_blob:
        return None, (f"Downloaded {path} but its blob sha does not "
                      f"match the published metadata — refusing to "
                      f"use it.")
    store(repo, path, data, manifest_version=manifest_version)
    return data, "downloaded"


class CachedFetcher:
    """
    The app's one download door: github_sync-compatible fetch
    callables that route every download through the shared cache.
    Pass .fetch where fetch_file is expected and .fetch_progress
    where fetch_file_progress is expected (zonedata's contract).

    paths_served_stale accumulates every path served from the cache
    because the network failed, so the window can say so honestly.
    Manifest sha256 expectations (from a freshly fetched
    map-manifest.json) are registered with register_manifest().
    """

    def __init__(self, fetch_file, fetch_meta=None,
                 fetch_file_progress=None):
        self._fetch_file = fetch_file
        self._fetch_meta = fetch_meta
        self._fetch_file_progress = fetch_file_progress
        self._expected_sha256 = {}     # repo path -> sha256
        self._manifest_version = None
        self.paths_served_stale = []

    def register_manifest(self, manifest_bytes):
        """Register expected sha256s from a map-manifest.json (its
        files are named relative to detailed/)."""
        try:
            doc = json.loads(manifest_bytes.decode("utf-8"))
        except Exception:
            return
        self._manifest_version = doc.get("map_version")
        for entry in doc.get("files") or []:
            name = entry.get("name")
            if name and entry.get("sha256"):
                self._expected_sha256[f"detailed/{name}"] = \
                    entry["sha256"]

    def _through(self, repo, path, progress=None):
        data, status = fetch_through(
            repo, path, self._fetch_file,
            fetch_meta=self._fetch_meta,
            fetch_file_progress=self._fetch_file_progress,
            progress=progress,
            expected_sha256=self._expected_sha256.get(path),
            manifest_version=self._manifest_version)
        if data is None:
            return None, status
        if status == "stale":
            self.paths_served_stale.append(path)
        return data, None

    def fetch(self, repo, path, **kwargs):
        """github_sync.fetch_file signature: (bytes, err)."""
        return self._through(repo, path)

    def fetch_progress(self, repo, path, progress=None, **kwargs):
        """github_sync.fetch_file_progress signature."""
        return self._through(repo, path, progress=progress)
