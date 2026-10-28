#!/usr/bin/env python3
"""
Adamsville SUITE CORE — version check against the repo version.json.

The suite's update contract (the Map Editor precedent): each app
has a version file in the repo at

    editors/<app>/version.json

    {"version": "1.0.0",
     "changelog": "what changed, in plain language",
     "files": [{"path": "app.py",
                "url":  the file's raw URL in this repo,
                "sha256": "…"}, …]}

This module is the CHECK half, shared by every app: fetch the
version file fresh from GitHub (Contents API — never the CDN, so
it cannot be stale), compare versions, and report. It FAILS OPEN:
offline, a missing file, or an unreadable document all read as
"no news", never as an error that blocks the app (Joshua's rule:
an updater must never be able to kill its host app).

v1 scope, stated plainly: the check reports and shows the
changelog; it does not overwrite the installed app in place. The
files[] list is carried in the document so a later applying
updater (and the release tooling) can consume the same contract.

Joshua's rule: all code commented.
"""

# MERGED 2026-10-18: this module now carries BOTH updater halves.
# The CHECK half above (version_key / check_for_update /
# show_update_result) is the Elevation Editor 1.0.0 contract.
# The APPLY half below (check_for_updates_gui + the staged,
# sha256-verified, backed-up in-place update, runnable as
# --apply under pkexec) is the updater the Building Editor has
# shipped since 1.5.2, including in 2.0.0 — carried verbatim.
# An app uses whichever half its Help menu wires; both fail
# open and neither can block the host app.

# v3 (2026-10-28): the SELF-UPDATE half below (stage_self_update /
# start_background_check) is the staged, user-space updater behind
# Joshua's editors-self-update rule — the editors get the same
# update capability as the game. On launch an app checks its
# channel on GitHub, downloads a newer payload into
# ~/.local/share/adamsville-suite/<slug>/updates/<version>/ with
# every file sha256-verified, and atomically flips
# updates/current to it; the app's bootstrap launcher runs the
# staged copy on the NEXT launch. No root, no pkexec, no in-place
# overwrite of /usr/share — and every failure (offline, 404, bad
# hash, corrupt payload, unwritable dir) leaves the installed app
# exactly as it was. The full contract and the release checklist
# live in editors/SELF-UPDATE.md.
#
# Refusal reporting (Joshua 2026-10-28 14:18): an INTEGRITY
# refusal (bad file hash, payload digest mismatch, corrupt
# manifest) is silent TO THE USER — the app simply opens as
# installed — but it is never silent TO MOLLIE: the updater files
# an "update-refused" Editor Report through
# suite_core/reporting.py (see _report_refused_update below).

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

# The one repo everything lives in now.
GAME_REPO = "kingmarkarnold-code/adamsville-play"


def version_key(text):
    """
    "1.10.2" -> (1, 10, 2) for numeric comparison; non-numeric
    pieces count as 0. Shorter tuples pad with zeros, so "1.0"
    equals "1.0.0".
    """
    parts = []
    for piece in str(text or "0").split("."):
        try:
            parts.append(int(piece))
        except Exception:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def check_for_update(app_repo_dir, current_version, fetch_file):
    """
    Ask GitHub whether a newer version of an app exists.

    app_repo_dir: the app's folder in the repo, e.g.
        "editors/elevation-editor" (its version.json lives there).
    current_version: the running app's version string.
    fetch_file: github_sync.fetch_file (injected so the harness
        can stub transport; pass the suite-cache fetcher in the app
        ONLY for reads where staleness is acceptable — the version
        check itself should use the RAW github_sync.fetch_file so
        the answer is never a cache copy).

    Returns (info, None) where info is
        {"available": bool, "version": str, "changelog": str,
         "files": [...]}
    or (None, error_message) when the question could not be asked.
    "available" is False (with version/changelog filled from the
    document when one was read) when the repo's version is not
    newer than the running one.
    """
    raw, err = fetch_file(GAME_REPO, f"{app_repo_dir}/version.json")
    if raw is None:
        return None, err or "Could not read the version file."
    try:
        doc = json.loads(raw.decode("utf-8"))
    except Exception as e:
        return None, f"Version file is unreadable: {e}"
    version = str(doc.get("version") or "")
    info = {
        "available": bool(version)
        and version_key(version) > version_key(current_version),
        "version": version,
        "changelog": str(doc.get("changelog") or ""),
        "files": doc.get("files") or [],
    }
    return info, None


def show_update_result(parent, app_name, current_version, info, err):
    """
    Show the outcome of a check in a small dialog: an error reads
    as plain "couldn't check" language (never a crash), an
    available update shows its version and changelog, and anything
    else confirms the app is current.
    """
    if info is None:
        dialog = Gtk.MessageDialog(
            transient_for=parent, flags=0,
            message_type=Gtk.MessageType.INFO,
            buttons=Gtk.ButtonsType.OK,
            text="Couldn't check for updates")
        dialog.format_secondary_text(
            f"{err}\n\nThe editor keeps working either way — "
            "updates are checked again next time you ask.")
    elif info["available"]:
        dialog = Gtk.MessageDialog(
            transient_for=parent, flags=0,
            message_type=Gtk.MessageType.INFO,
            buttons=Gtk.ButtonsType.OK,
            text=f"{app_name} {info['version']} is available")
        dialog.format_secondary_text(
            f"You are running {current_version}.\n\n"
            f"{info['changelog']}\n\n"
            "Install the new .deb the usual way when you're ready; "
            "your settings and the suite token carry over.")
    else:
        dialog = Gtk.MessageDialog(
            transient_for=parent, flags=0,
            message_type=Gtk.MessageType.INFO,
            buttons=Gtk.ButtonsType.OK,
            text="You're up to date")
        dialog.format_secondary_text(
            f"{app_name} {current_version} is the newest version "
            "on GitHub.")
    dialog.run()
    dialog.destroy()


# ---------------------------------------------------------------------------
# The APPLY half — the in-place updater the Building Editor ships
# (verbatim from its 2.0.0 vendored copy; see the header note).
# ---------------------------------------------------------------------------


def _version_tuple(v):
    """Turn "1.8.1" into (1, 8, 1) for comparison.

    Non-numeric segments are kept as strings and compare after numbers
    only within equal-length prefixes; good enough for our x.y.z scheme.
    """
    parts = []
    for seg in str(v).strip().split("."):
        # Allow segments like "1rc2" without crashing: split digits/prefix.
        digits = ""
        rest = ""
        for ch in seg:
            if ch.isdigit() and not rest:
                digits += ch
            else:
                rest += ch
        parts.append(int(digits) if digits else 0)
        if rest:
            parts.append(rest)
    return tuple(parts)


def is_newer(candidate, current):
    """Return True if version string *candidate* is newer than *current*.

    "1.8.1" > "1.8.0" -> True.  "1.8.0" vs "1.8.0" -> False.
    A malformed candidate never counts as newer.
    """
    try:
        return _version_tuple(candidate) > _version_tuple(current)
    except Exception:
        return False


# ----------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------


def install_dir():
    """Directory this module is installed in (/usr/share/<editor>/)."""
    return os.path.dirname(os.path.abspath(__file__))


def _stage_dir(slug, version):
    """Per-version staging dir under the user's cache."""
    d = os.path.expanduser(
        os.path.join("~", ".cache", "adamsville-" + slug,
                     "updates", str(version)))
    os.makedirs(d, exist_ok=True)
    return d


def _backup_dir(slug, version):
    """Per-version backup dir under the user's local share."""
    d = os.path.expanduser(
        os.path.join("~", ".local", "share", "adamsville-" + slug,
                     "backups", str(version)))
    os.makedirs(d, exist_ok=True)
    return d


# ----------------------------------------------------------------------
# Network
# ----------------------------------------------------------------------


def _http_get(url, timeout=20):
    """Fetch *url* and return (status_code, bytes).  No exceptions escape."""
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": "adamsville-updater/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), resp.read()
    except Exception as exc:  # offline, DNS, 404, timeout...
        return None, exc


def fetch_manifest(manifest_url):
    """Download and parse the version.json manifest.

    Returns (manifest_dict, error_string).  Exactly one is meaningful.
    """
    status, payload = _http_get(manifest_url)
    if status is None:
        # payload is the exception here.
        return None, "Could not reach the update server:\n%s" % payload
    if status == 404:
        return None, ("No update feed published yet for this editor.\n"
                      "You are running the latest installed version.")
    if status != 200:
        return None, "Update server returned HTTP %s." % status
    try:
        text = payload.decode("utf-8")
        manifest = json.loads(text)
    except Exception as exc:
        return None, "The update feed is not valid JSON:\n%s" % exc
    if not isinstance(manifest, dict) or "version" not in manifest:
        return None, "The update feed is missing its version number."
    return manifest, None


# ----------------------------------------------------------------------
# Download + verify + apply (no GUI here; the GUI layer reports progress)
# ----------------------------------------------------------------------


def _sha256_of_file(path):
    """Hex sha256 of a file on disk."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def download_files(manifest, stage_dir, progress=None):
    """Download every file listed in the manifest into *stage_dir*.

    *progress* is an optional callable(done:int, total:int, label:str).
    Returns (ok: bool, error_string).
    """
    files = manifest.get("files", [])
    total = len(files)
    if not total:
        return False, "The update feed lists no files to download."
    for i, entry in enumerate(files, 1):
        rel = entry.get("path", "")
        url = entry.get("url", "")
        want_sha = entry.get("sha256", "")
        # Guard against path traversal: keep everything inside stage_dir.
        if not rel or os.path.isabs(rel) or ".." in rel.split(os.sep):
            return False, "Unsafe file path in update feed: %r" % rel
        if progress:
            progress(i - 1, total, "Downloading %s ..." % rel)
        status, payload = _http_get(url)
        if status != 200:
            return False, ("Failed to download %s "
                           "(HTTP %s)." % (rel, status))
        dest = os.path.join(stage_dir, rel)
        os.makedirs(os.path.dirname(dest) or stage_dir, exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(payload)
        if want_sha:
            got_sha = _sha256_of_file(dest)
            if got_sha.lower() != want_sha.lower():
                return False, ("Checksum mismatch for %s.\n"
                               "The download may be corrupt; aborting."
                               % rel)
        if progress:
            progress(i, total, "Downloaded %s." % rel)
    return True, None


def _clear_pycache(target_dir):
    """Remove __pycache__ dirs so new bytecode is generated on restart."""
    for root, dirs, _files in os.walk(target_dir):
        if "__pycache__" in dirs:
            shutil.rmtree(os.path.join(root, "__pycache__"),
                          ignore_errors=True)
            dirs.remove("__pycache__")


def apply_staged_update(stage_dir, progress=None):
    """Copy staged files over the install dir, with backup.

    Tries a direct copy first; if /usr/share is not writable, re-runs
    this module as root via pkexec with --apply.
    Returns (ok: bool, error_string).
    """
    target = install_dir()

    def do_copy():
        # Back up the files we are about to replace.
        # (The caller passes slug/version for the backup location.)
        for root, _dirs, files in os.walk(stage_dir):
            for name in files:
                src = os.path.join(root, name)
                rel = os.path.relpath(src, stage_dir)
                dst = os.path.join(target, rel)
                os.makedirs(os.path.dirname(dst) or target, exist_ok=True)
                shutil.copy2(src, dst)
                os.chmod(dst, 0o644)  # match dpkg-installed file modes
        _clear_pycache(target)

    # Fast path: we can write (dev installs, or already root).
    try:
        do_copy()
        return True, None
    except PermissionError:
        pass  # fall through to pkexec
    except OSError as exc:
        return False, "Could not write the update:\n%s" % exc

    # Privileged path: ask polkit to run the copy as root.
    if progress:
        progress(0, 1, "Requesting permission to install the update ...")
    cmd = ["pkexec", sys.executable,
           os.path.join(target, "updater.py"),
           "--apply", stage_dir]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=300)
    except FileNotFoundError:
        return False, ("'pkexec' is not installed, so the update cannot\n"
                       "be written to the system directory.\n"
                       "Install policykit-1 and try again.")
    except Exception as exc:
        return False, "Could not elevate to install the update:\n%s" % exc
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "unknown error").strip()
        # User cancelling the polkit prompt is not an "error" to fear.
        if "dismissed" in err.lower() or "cancel" in err.lower():
            return False, "Update cancelled."
        return False, "Could not install the update:\n%s" % err
    return True, None


def backup_current(slug, version, manifest):
    """Copy the files this update will replace into the backup dir."""
    target = install_dir()
    dest_dir = _backup_dir(slug, version)
    for entry in manifest.get("files", []):
        rel = entry.get("path", "")
        if not rel or os.path.isabs(rel) or ".." in rel.split(os.sep):
            continue
        src = os.path.join(target, rel)
        if os.path.isfile(src):
            dst = os.path.join(dest_dir, rel)
            os.makedirs(os.path.dirname(dst) or dest_dir, exist_ok=True)
            shutil.copy2(src, dst)
    return dest_dir


def restart_app():
    """Re-exec the editor's app.py so the update takes effect."""
    app_py = os.path.join(install_dir(), "app.py")
    os.execv(sys.executable,
             [sys.executable, app_py] + sys.argv[1:])


def _stage_and_report(parent, app_name, current_version, slug):
    """Download + stage an update with a progress dialog.

    The self-update counterpart of _download_and_install: nothing
    is written to /usr/share and the app is NOT restarted — the
    staged version runs on the next launch, and the final dialog
    says exactly that.
    """
    Gtk, GLib = _gtk()
    import threading

    dlg = Gtk.Dialog(title="Downloading update", transient_for=parent,
                     modal=True)
    dlg.set_default_size(380, 120)
    box = dlg.get_content_area()
    label = Gtk.Label(label="Checking for updates ...")
    label.set_line_wrap(True)
    bar = Gtk.ProgressBar()
    bar.set_show_text(True)
    box.pack_start(label, False, False, 8)
    box.pack_start(bar, False, False, 8)
    dlg.show_all()

    def set_progress(done, total, text):
        def _inner():
            frac = (done / total) if total else 0
            bar.set_fraction(max(0.0, min(1.0, frac)))
            bar.set_text("%d / %d" % (done, total))
            label.set_text(text)
            return False
        GLib.idle_add(_inner)

    def close_and(fn):
        def _inner():
            try:
                dlg.destroy()
            except Exception:
                pass
            fn()
            return False
        GLib.idle_add(_inner)

    def worker():
        outcome, info = stage_self_update(
            slug, current_version,
            progress=lambda d, t, txt: set_progress(d, t, txt))
        if outcome == "staged":
            version = info.get("version")
            close_and(lambda: _info_dialog(
                parent, "Update downloaded",
                "%s %s is downloaded and ready.\n"
                "It will run next time you start the app — "
                "nothing else to do." % (app_name, version)))
        elif outcome == "current":
            close_and(lambda: _info_dialog(
                parent, "Check for Updates",
                "You're on the latest version (%s)."
                % current_version))
        else:
            close_and(lambda: _info_dialog(
                parent, "Update failed",
                info.get("error") or "The update could not be "
                "downloaded. The app keeps working as it is."))

    threading.Thread(target=worker, daemon=True).start()


# ---------------------------------------------------------------------------
# The SELF-UPDATE half — staged, user-space updates (2026-10-28).
#
# The model (editors/SELF-UPDATE.md carries the full contract):
#   * Each app has a CHANNEL in this repo: editors/<slug>/ — a
#     version.json manifest plus the app's payload files.
#   * On launch the app calls start_background_check(), which runs
#     stage_self_update() on a daemon thread. It is SILENT when
#     there is nothing to do; visible download progress is the
#     caller's business (the suite's bottom-right progress bar,
#     fed through the progress callback).
#   * A newer payload is downloaded file by file through the
#     Contents API (github_sync.fetch_file — fresh, never the CDN)
#     into updates/.staging-<version>-<pid>/, every file verified
#     against the manifest's sha256, and only then renamed to
#     updates/<version>/ and made live by atomically flipping the
#     updates/current symlink. A VERSION file in the payload root
#     records what is staged; the app's bootstrap launcher runs
#     updates/current on the NEXT launch when its VERSION beats
#     the installed one.
#   * FAIL-OPEN, always: offline, 404, bad JSON, a bad hash, a
#     corrupt payload or an unwritable directory all end as
#     ("failed", {...}) with the installed app untouched and no
#     exception escaping. Nothing here ever shows a dialog.
#     INTEGRITY refusals (bad hash, digest mismatch, corrupt
#     manifest) additionally file an "update-refused" Editor
#     Report — silent to the user, never silent to Mollie (see
#     _report_refused_update below).
# ---------------------------------------------------------------------------

# The channel table: slug -> where its manifest and payload live
# in GAME_REPO. "payload_root" is the repo prefix the payload
# files hang under; manifest file paths are relative to it AND to
# the staged payload root (the two trees mirror each other).
CHANNELS = {
    "map-editor": {
        "repo_dir": "editors/map-editor",
        "payload_root": "editors/map-editor/editor",
    },
    "detail-editor": {
        "repo_dir": "editors/detail-editor",
        "payload_root": "editors/detail-editor/app",
    },
    "building-editor": {
        "repo_dir": "editors/building-editor",
        "payload_root": "editors/building-editor",
    },
    "ui-editor": {
        "repo_dir": "editors/ui-editor",
        "payload_root": "editors/ui-editor",
    },
    "terrain-editor": {
        "repo_dir": "editors/terrain-editor",
        "payload_root": "editors/terrain-editor",
    },
}


def channel_for(slug):
    """Channel dict for *slug*, or None for an unknown app."""
    chan = CHANNELS.get(str(slug or ""))
    return dict(chan) if chan else None


def suite_share_root():
    """~/.local/share/adamsville-suite — the suite's shared home
    (the GitHub token and the download cache already live here)."""
    return os.path.join(os.path.expanduser("~"), ".local", "share",
                        "adamsville-suite")


def updates_root(slug):
    """~/.local/share/adamsville-suite/<slug>/updates — where this
    app's staged versions and the `current` symlink live."""
    return os.path.join(suite_share_root(), str(slug), "updates")


def _read_version_file(directory):
    """The VERSION file at a payload root, or None."""
    try:
        with open(os.path.join(directory, "VERSION"),
                  encoding="utf-8") as fh:
            version = fh.read().strip().splitlines()[0].strip()
        return version or None
    except Exception:
        return None


def staged_version(slug):
    """Version of the payload updates/current points at, or None
    when nothing valid is staged."""
    try:
        current = os.path.join(updates_root(slug), "current")
        if not os.path.isfile(os.path.join(current, "app.py")):
            return None
        return _read_version_file(current)
    except Exception:
        return None


def staged_dir(slug):
    """Absolute path of the staged payload updates/current resolves
    to (validated: app.py + VERSION present), or None."""
    try:
        current = os.path.join(updates_root(slug), "current")
        if not os.path.isfile(os.path.join(current, "app.py")):
            return None
        if _read_version_file(current) is None:
            return None
        return os.path.realpath(current)
    except Exception:
        return None


def staged_update_info(slug, current_version):
    """{"ready": bool, "version": str|None} — ready when a staged
    payload newer than *current_version* is waiting for the next
    launch. Used by About/Help surfaces to say "update ready —
    restart to apply" truthfully."""
    version = staged_version(slug)
    return {
        "ready": bool(version) and is_newer(version, current_version),
        "version": version,
    }


def _default_fetch_file():
    """github_sync.fetch_file, imported from wherever this app
    keeps it (suite_core package or a top-level module beside this
    file). Returns None when no copy is importable — callers then
    fall back to plain raw-URL fetches for files that carry one."""
    try:
        from suite_core import github_sync
        return github_sync.fetch_file
    except Exception:
        pass
    try:
        import github_sync
        return github_sync.fetch_file
    except Exception:
        return None


def _fetch_repo_file(fetch_file, repo_path, raw_url=None):
    """Fetch one repo file's bytes. Prefers the Contents API via
    *fetch_file* (fresh, authenticated with the suite token when
    one is set); falls back to *raw_url* over plain HTTPS.
    Returns (bytes, None) or (None, error_message)."""
    if fetch_file is not None:
        try:
            data, err = fetch_file(GAME_REPO, repo_path)
        except Exception as exc:
            data, err = None, str(exc)
        if data is not None:
            return data, None
        if not raw_url:
            return None, err or "Could not fetch %s." % repo_path
        # Fall through to the raw URL: the manifest's sha256 still
        # verifies whatever arrives, so a stale CDN copy can waste
        # a download but can never install a wrong file.
    if raw_url:
        status, payload = _http_get(raw_url)
        if status == 200:
            return payload, None
        if status is None:
            return None, "Could not reach GitHub: %s" % payload
        return None, "HTTP %s fetching %s." % (status, repo_path)
    return None, "No way to fetch %s (no github_sync, no URL)." \
        % repo_path


def _manifest_file_entries(manifest, chan):
    """Normalise a channel manifest into payload file entries:
    [{"path", "sha256", "repo_path", "url"}]. Prefers the
    manifest's "selfupdate" block; falls back to the legacy
    files[] list (same paths, per-file URLs). Returns
    (entries, payload_sha256_or_None, error_or_None)."""
    selfupdate = manifest.get("selfupdate")
    entries = []
    payload_sha = None
    if isinstance(selfupdate, dict) and selfupdate.get("files"):
        root = str(selfupdate.get("payload_root")
                   or chan["payload_root"]).rstrip("/")
        for entry in selfupdate["files"]:
            rel = str(entry.get("path") or "")
            entries.append({
                "path": rel,
                "sha256": str(entry.get("sha256") or ""),
                "repo_path": root + "/" + rel,
                "url": None,
            })
        payload_sha = selfupdate.get("payload_sha256") or None
        return entries, payload_sha, None
    files = manifest.get("files") or []
    if not files:
        return None, None, ("The channel manifest lists no files "
                            "to download.")
    root = chan["payload_root"].rstrip("/")
    for entry in files:
        rel = str(entry.get("path") or "")
        entries.append({
            "path": rel,
            "sha256": str(entry.get("sha256") or ""),
            "repo_path": root + "/" + rel,
            "url": entry.get("url") or None,
        })
    return entries, None, None


def _payload_digest(entries):
    """Whole-payload digest: sha256 over the sorted
    "path:sha256" lines — one number that pins the entire file
    set, checked after staging when the manifest carries it."""
    h = hashlib.sha256()
    for entry in sorted(entries, key=lambda e: e["path"]):
        h.update(("%s:%s\n" % (entry["path"],
                               entry["sha256"])).encode("utf-8"))
    return h.hexdigest()


def _stage_dir_complete(directory, entries, version):
    """True when *directory* already holds this exact payload:
    VERSION matches and every listed file present with a matching
    sha256. Lets a re-check skip re-downloading a staged copy."""
    if _read_version_file(directory) != version:
        return False
    for entry in entries:
        dest = os.path.join(directory, entry["path"])
        if not os.path.isfile(dest):
            return False
        if entry["sha256"] and \
                _sha256_of_file(dest).lower() != entry["sha256"].lower():
            return False
    return True


def _flip_current(updates_dir, version):
    """Atomically point updates/current at updates/<version>.

    The flip is a symlink swap: build a new symlink beside the old
    one and os.replace() it over — a launch at any instant sees
    either the whole old payload or the whole new one, never a
    mixture. A real directory left at `current` by some other
    tool is moved aside and removed, never merged."""
    link_tmp = os.path.join(
        updates_dir, ".current.tmp-%d" % os.getpid())
    try:
        os.unlink(link_tmp)
    except OSError:
        pass
    os.symlink(version, link_tmp)
    current = os.path.join(updates_dir, "current")
    if os.path.isdir(current) and not os.path.islink(current):
        aside = os.path.join(
            updates_dir, ".current.legacy-%d" % os.getpid())
        os.rename(current, aside)
        os.replace(link_tmp, current)
        shutil.rmtree(aside, ignore_errors=True)
    else:
        os.replace(link_tmp, current)


def _prune_old_versions(updates_dir, keep):
    """Delete staged version dirs except the ones in *keep* (the
    live one and its predecessor, kept for rollback). Dot-prefixed
    staging temporaries of other runs are left alone. Best-effort:
    pruning must never fail an update."""
    try:
        names = os.listdir(updates_dir)
    except OSError:
        return
    for name in names:
        if name.startswith(".") or name == "current" or name in keep:
            continue
        path = os.path.join(updates_dir, name)
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path, ignore_errors=True)


# ---------------------------------------------------------------------------
# Refused-update reporting (Joshua 2026-10-28 14:18).
#
# A corrupt download is refused and the installed app opens
# exactly as before — silent TO THE USER, always. But it must
# not be silent TO MOLLIE: every integrity refusal files an
# Editor Report through suite_core/reporting.py, so a poisoned
# channel or a mangled publish is visible in the same inbox as
# everything else instead of failing in the dark.
#
# Only INTEGRITY refusals report: a file whose sha256 does not
# match the manifest, a whole-payload digest mismatch, an unsafe
# file path in the manifest, and a manifest that arrived but is
# corrupt or missing its fields. Reachability failures (offline,
# 404, a file that would not download) and local write errors
# stay silent — they are weather, not evidence.
#
# Anti-spam is layered: reporting's own (kind, msg) 10-minute
# dedupe and per-kind cap, PLUS a per-failure memory on disk
# (<slug>/refused-update-reports.json, beside the updates dir):
# the same version failing the same check on the same file is
# reported once, ever; a NEW version failing — or the same
# version failing a different check — is a new report.
# ---------------------------------------------------------------------------

UPDATE_REFUSED_KIND = "update-refused"


def _refused_reports_path(slug):
    """~/.local/share/adamsville-suite/<slug>/
    refused-update-reports.json — beside the updates dir."""
    return os.path.join(suite_share_root(), str(slug),
                        "refused-update-reports.json")


def _refusal_key(failed_version, check, file):
    """One failure's identity for the on-disk memory."""
    return "%s|%s|%s" % (failed_version or "unknown", check,
                         file or "")


def _refusal_already_reported(slug, key):
    """True when this exact failure was already reported (in any
    earlier run). Unreadable memory reads as "not reported" — a
    duplicate report is a smaller sin than a lost one."""
    try:
        with open(_refused_reports_path(slug),
                  encoding="utf-8") as fh:
            doc = json.load(fh)
        return key in (doc.get("reported") or {})
    except Exception:
        return False


def _record_refusal_reported(slug, key, failed_version, check,
                             file):
    """Remember that this failure was reported (atomic write,
    best-effort, capped so the file can never grow teeth)."""
    try:
        path = _refused_reports_path(slug)
        doc = {}
        try:
            with open(path, encoding="utf-8") as fh:
                doc = json.load(fh)
        except Exception:
            doc = {}
        reported = doc.get("reported") or {}
        reported[key] = {"version": failed_version or "unknown",
                         "check": check, "file": file or "",
                         "ts": time.time()}
        if len(reported) > 100:
            oldest = sorted(
                reported.items(),
                key=lambda kv: kv[1].get("ts", 0))
            reported = dict(oldest[-100:])
        doc["reported"] = reported
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp-%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=1)
        os.replace(tmp, path)
    except Exception:
        pass


def _load_reporting():
    """suite_core.reporting, imported from wherever this app
    keeps it (the suite_core package, or a top-level module
    beside this file — the same dual hunt as _default_fetch_file).
    None when the app carries no copy; the caller then falls back
    to writing reporting's queue file directly."""
    try:
        from suite_core import reporting
        return reporting
    except Exception:
        pass
    try:
        import reporting
        return reporting
    except Exception:
        return None


# reporting.py's form-entry ids and queue cap, duplicated ONLY
# for the last-resort direct-queue write below; the primary path
# always goes through reporting.py itself. (Field map:
# game-map/report-relay/GOOGLE-FORM.md.)
_REPORT_ENTRY_TYPE = "entry.245308779"
_REPORT_ENTRY_MESSAGE = "entry.722588258"
_REPORT_ENTRY_VERSION = "entry.1808724204"
_REPORT_ENTRY_WHERE = "entry.613460102"
_REPORT_ENTRY_DEVICE = "entry.1017388942"
_REPORT_QUEUE_CAP = 200


def _queue_refusal_directly(slug, current_version, msg, where,
                            fields):
    """Last resort: reporting.py is not importable, so append
    the report body straight into reporting's persistent queue
    file (~/.local/share/adamsville-suite/<slug>/
    reports-queue.json), in exactly its format — the next launch
    that does carry reporting delivers it, so the report still
    files even though this payload cannot speak for itself.
    Returns True when the body landed in the queue. Never
    raises."""
    try:
        # Payload source, read the same way reporting reads it.
        root = os.environ.get("ADAMSVILLE_APP_ROOT") or ""
        norm = root.replace(os.sep, "/")
        if "/adamsville-suite/" in norm and "/updates/" in norm:
            source = "staged"
        elif not root or norm.startswith("/usr/share/") or \
                norm.startswith("/usr/local/share/"):
            source = "installed"
        else:
            source = "custom"
        lines = ["%s: %s" % (UPDATE_REFUSED_KIND, msg),
                 "app=%s" % slug,
                 "version=%s" % current_version,
                 "source=%s" % source,
                 "session=%s" % uuid.uuid4().hex[:6],
                 "ts=%s" % time.strftime(
                     "%Y-%m-%dT%H:%M:%SZ", time.gmtime())]
        for key in sorted(fields):
            lines.append("%s=%s" % (key, fields[key]))
        try:
            device = "%s · Python %s" % (
                platform.system(), platform.python_version())
        except Exception:
            device = "unknown"
        body = {_REPORT_ENTRY_TYPE: "Editor Report",
                _REPORT_ENTRY_MESSAGE: "\n".join(lines),
                _REPORT_ENTRY_VERSION: "%s %s" % (
                    slug, current_version),
                _REPORT_ENTRY_WHERE: where or slug,
                _REPORT_ENTRY_DEVICE: device}
        path = os.path.join(suite_share_root(), str(slug),
                            "reports-queue.json")
        queue = []
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                queue = [b for b in data if isinstance(b, dict)]
        except Exception:
            queue = []
        queue.append(body)
        while len(queue) > _REPORT_QUEUE_CAP:
            queue.pop(0)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp-%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(queue, fh)
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def _report_refused_update(slug, current_version, failed_version,
                           check, file=None, detail=None,
                           expected_sha256=None, got_sha256=None):
    """File the Editor Report for one integrity refusal.

    The report (kind "update-refused", type "Editor Report")
    identifies: app slug, failed_version (the version that was
    refused), check (which integrity check failed), file (the
    offending file, when one file is at fault),
    installed_version (the version that kept running), and the
    expected/got hashes when a hash check failed. Delivery is
    reporting's own: persistent queue, fire-and-forget,
    offline-safe — a refusal CAUSED by a bad network still files,
    and drains when the network allows. Returns True when the
    report was handed to the pipeline (queued counts). Silent,
    never raises, never shows anything to the user."""
    try:
        fv = failed_version or "unknown"
        key = _refusal_key(fv, check, file)
        if _refusal_already_reported(slug, key):
            return False
        if check == "file_sha256":
            msg = ("update %s refused: checksum mismatch for %s"
                   % (fv, file))
        elif check == "payload_digest":
            msg = ("update %s refused: payload digest mismatch"
                   % fv)
        elif check == "manifest_json":
            msg = ("update refused: channel manifest is not "
                   "valid JSON")
        elif check == "manifest_fields":
            msg = ("update refused: channel manifest is corrupt "
                   "or missing fields")
        elif check == "unsafe_path":
            msg = ("update %s refused: unsafe file path %s in "
                   "channel manifest" % (fv, file))
        else:
            msg = "update %s refused: %s" % (fv, check)
        fields = {"failed_version": fv,
                  "check": check,
                  "installed_version": str(current_version)}
        if file:
            fields["file"] = file
        if detail:
            fields["detail"] = str(detail)[:200]
        if expected_sha256:
            fields["expected_sha256"] = expected_sha256
        if got_sha256:
            fields["got_sha256"] = got_sha256
        where = file or "self-update"
        filed = False
        rep = _load_reporting()
        if rep is not None:
            try:
                is_ready = getattr(rep, "is_ready", None)
                if is_ready is not None and not is_ready():
                    # The app has not initialised reporting (yet):
                    # do it on its behalf so the refusal still
                    # files under this app's name and version. A
                    # later app-side init re-points the session;
                    # the persistent queue is shared either way.
                    rep.init(slug, current_version)
                rep.note(UPDATE_REFUSED_KIND, msg, where=where,
                         **fields)
                filed = True
            except Exception:
                filed = False
        if not filed:
            filed = _queue_refusal_directly(
                slug, current_version, msg, where, fields)
        if filed:
            _record_refusal_reported(slug, key, fv, check, file)
        return filed
    except Exception:
        return False


def stage_self_update(slug, current_version, fetch_file=None,
                      progress=None):
    """Check the app's channel and, if newer, stage the payload.

    Returns (outcome, info) and NEVER raises:
      ("current", {...})  the channel is not newer than
                          *current_version* (info["already_staged"]
                          notes a staged copy of that version);
      ("staged",  {...})  updates/current now points at the new
                          payload; it runs on the next launch;
      ("failed",  {"error": ...})  anything went wrong; the
                          installed app is untouched.

    *progress* is an optional callable(done, total, label) fed
    during the download (the suite's progress-bar law); it is not
    called at all when there is nothing to download.
    """
    try:
        return _stage_self_update(slug, current_version,
                                  fetch_file, progress)
    except Exception as exc:  # the fail-open promise, kept literally
        return "failed", {"error": "Unexpected updater error: %s"
                          % exc}


def _stage_self_update(slug, current_version, fetch_file, progress):
    """stage_self_update's body (see its docstring)."""
    chan = channel_for(slug)
    if chan is None:
        return "failed", {"error": "Unknown app slug: %r" % (slug,)}
    if fetch_file is None:
        fetch_file = _default_fetch_file()

    # -- the manifest, fresh via the Contents API ---------------
    manifest_path = chan["repo_dir"] + "/version.json"
    raw_url = ("https://raw.githubusercontent.com/%s/main/%s"
               % (GAME_REPO, manifest_path))
    raw, err = _fetch_repo_file(fetch_file, manifest_path, raw_url)
    if raw is None:
        return "failed", {"error": err or "Could not read the "
                          "channel manifest."}
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        # The manifest ARRIVED but is corrupt — an integrity
        # refusal: silent to the user, reported to Mollie.
        _report_refused_update(slug, current_version, None,
                               "manifest_json", detail=str(exc))
        return "failed", {"error": "Channel manifest is not valid "
                          "JSON: %s" % exc}
    if not isinstance(manifest, dict):
        _report_refused_update(slug, current_version, None,
                               "manifest_fields",
                               detail="manifest is not an object")
        return "failed", {"error": "Channel manifest is malformed."}
    new_version = str(manifest.get("version") or "").strip()
    if not new_version:
        _report_refused_update(slug, current_version, None,
                               "manifest_fields",
                               detail="manifest has no version")
        return "failed", {"error": "Channel manifest has no version."}

    updates_dir = updates_root(slug)
    if not is_newer(new_version, current_version):
        already = False
        try:
            already = staged_version(slug) == new_version
        except Exception:
            pass
        return "current", {"version": new_version,
                           "already_staged": already,
                           "changelog": manifest.get("changelog")
                           or ""}

    entries, payload_sha, err = _manifest_file_entries(manifest, chan)
    if err:
        _report_refused_update(slug, current_version, new_version,
                               "manifest_fields", detail=err)
        return "failed", {"error": err}
    if isinstance(manifest.get("selfupdate"), dict):
        # A self-update entry without a sha256 cannot be verified
        # at all — the manifest is missing a required field.
        missing = [e["path"] for e in entries if not e["sha256"]]
        if missing:
            _report_refused_update(
                slug, current_version, new_version,
                "manifest_fields", file=missing[0],
                detail="file entry has no sha256")
            return "failed", {"error": "Channel manifest entry "
                              "for %s has no sha256; refusing to "
                              "stage." % missing[0]}
    if payload_sha:
        digest = _payload_digest(entries)
        if digest.lower() != str(payload_sha).lower():
            _report_refused_update(
                slug, current_version, new_version,
                "payload_digest", expected_sha256=str(payload_sha),
                got_sha256=digest)
            return "failed", {"error": "Channel manifest's payload "
                              "digest does not match its file list; "
                              "refusing to stage."}

    try:
        os.makedirs(updates_dir, exist_ok=True)
    except OSError as exc:
        return "failed", {"error": "Updates folder is not "
                          "writable: %s" % exc}

    # -- already staged? just make sure `current` points at it --
    target = os.path.join(updates_dir, new_version)
    if os.path.isdir(target) and \
            _stage_dir_complete(target, entries, new_version):
        previous = staged_version(slug)
        _flip_current(updates_dir, new_version)
        _prune_old_versions(updates_dir,
                            {new_version, previous} - {None})
        return "staged", {"version": new_version,
                          "changelog": manifest.get("changelog")
                          or "", "reused": True}

    # -- download into a private staging dir ---------------------
    staging = os.path.join(
        updates_dir, ".staging-%s-%d" % (new_version, os.getpid()))
    shutil.rmtree(staging, ignore_errors=True)
    try:
        os.makedirs(staging)
        total = len(entries)
        for i, entry in enumerate(entries, 1):
            rel = entry["path"]
            # Same traversal guard as the legacy downloader.
            if not rel or os.path.isabs(rel) \
                    or ".." in rel.split("/"):
                shutil.rmtree(staging, ignore_errors=True)
                _report_refused_update(slug, current_version,
                                       new_version, "unsafe_path",
                                       file=rel)
                return "failed", {"error": "Unsafe file path in "
                                  "channel manifest: %r" % rel}
            if progress:
                progress(i - 1, total, "Downloading %s ..." % rel)
            data, ferr = _fetch_repo_file(
                fetch_file, entry["repo_path"], entry.get("url"))
            if data is None:
                shutil.rmtree(staging, ignore_errors=True)
                return "failed", {"error": ferr or
                                  "Download failed for %s." % rel}
            got = hashlib.sha256(data).hexdigest()
            if entry["sha256"] and \
                    got.lower() != entry["sha256"].lower():
                shutil.rmtree(staging, ignore_errors=True)
                # THE integrity refusal (Joshua 2026-10-28 14:18):
                # the fallback stays silent to the user; Mollie
                # gets an Editor Report naming the file.
                _report_refused_update(
                    slug, current_version, new_version,
                    "file_sha256", file=rel,
                    expected_sha256=entry["sha256"], got_sha256=got)
                return "failed", {"error": "Checksum mismatch for "
                                  "%s.\nThe download may be "
                                  "corrupt; nothing was staged."
                                  % rel}
            dest = os.path.join(staging, rel)
            os.makedirs(os.path.dirname(dest) or staging,
                        exist_ok=True)
            with open(dest, "wb") as fh:
                fh.write(data)
            if progress:
                progress(i, total, "Downloaded %s." % rel)
        # The payload's own identity papers: VERSION (the
        # bootstrap launcher reads this) + the manifest it came
        # from (provenance for later debugging).
        with open(os.path.join(staging, "VERSION"), "w",
                  encoding="utf-8") as fh:
            fh.write(new_version + "\n")
        with open(os.path.join(staging, "channel.json"), "wb") as fh:
            fh.write(raw)
        _clear_pycache(staging)
    except OSError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        return "failed", {"error": "Could not write the staged "
                          "update: %s" % exc}

    # -- promote + flip ------------------------------------------
    previous = staged_version(slug)
    try:
        if os.path.isdir(target):
            shutil.rmtree(target)
        os.rename(staging, target)
        _flip_current(updates_dir, new_version)
    except OSError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        return "failed", {"error": "Could not activate the staged "
                          "update: %s" % exc}
    _prune_old_versions(updates_dir, {new_version, previous} - {None})
    return "staged", {"version": new_version,
                      "changelog": manifest.get("changelog") or ""}


def start_background_check(slug, current_version, fetch_file=None,
                           on_progress=None, on_staged=None,
                           gui=False):
    """Launch-time self-update check on a daemon thread.

    The launch contract (Joshua's editors-self-update rule): call
    once, right after the main window exists. Silent when the app
    is current or the check fails; on_progress(done, total, label)
    feeds the app's bottom-right progress bar while a download
    runs (and only then); on_staged(info) fires when a new payload
    was staged, so the app may note "update ready — restart to
    apply" in its About/Help surface. With gui=True the callbacks
    are marshalled onto the GTK main loop via GLib.idle_add.
    Returns the thread, or None when it could not be started —
    a broken updater must never stop an editor opening.
    """
    try:
        import threading

        def wrap(callback):
            if callback is None:
                return None
            if gui:
                try:
                    from gi.repository import GLib

                    def wrapped(*args):
                        GLib.idle_add(lambda: (callback(*args),
                                               False)[1])
                    return wrapped
                except Exception:
                    pass
            return callback

        progress_cb = wrap(on_progress)
        staged_cb = wrap(on_staged)

        def run():
            try:
                outcome, info = stage_self_update(
                    slug, current_version, fetch_file=fetch_file,
                    progress=progress_cb)
                if outcome == "staged" and staged_cb is not None:
                    staged_cb(info)
            except Exception:
                pass  # already fail-open; belt and braces

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread
    except Exception:
        return None


# ----------------------------------------------------------------------
# --apply entry point (runs as root via pkexec)
# ----------------------------------------------------------------------


def _apply_main(stage_dir):
    """Copy staged files into the install dir.  Must run as root."""
    target = install_dir()
    if not os.path.isdir(stage_dir):
        print("Staging directory not found: %s" % stage_dir,
              file=sys.stderr)
        return 1
    try:
        for root, _dirs, files in os.walk(stage_dir):
            for name in files:
                src = os.path.join(root, name)
                rel = os.path.relpath(src, stage_dir)
                # Same traversal guard as the downloader.
                if os.path.isabs(rel) or ".." in rel.split(os.sep):
                    print("Refusing unsafe path: %r" % rel,
                          file=sys.stderr)
                    return 1
                dst = os.path.join(target, rel)
                os.makedirs(os.path.dirname(dst) or target, exist_ok=True)
                shutil.copy2(src, dst)
                os.chmod(dst, 0o644)
        _clear_pycache(target)
    except Exception as exc:
        print("Apply failed: %s" % exc, file=sys.stderr)
        return 1
    print("Update applied to %s" % target)
    return 0


# ----------------------------------------------------------------------
# GTK GUI layer
# ----------------------------------------------------------------------

_GUI = None  # lazy Gtk import holder


def _gtk():
    """Import Gtk lazily so --apply mode never needs a display."""
    global _GUI
    if _GUI is None:
        import gi
        gi.require_version("Gtk", "3.0")
        from gi.repository import Gtk, GLib
        _GUI = (Gtk, GLib)
    return _GUI


def _info_dialog(parent, title, message):
    """Simple modal info dialog."""
    Gtk, _GLib = _gtk()
    dlg = Gtk.MessageDialog(
        transient_for=parent, modal=True,
        message_type=Gtk.MessageType.INFO,
        buttons=Gtk.ButtonsType.OK, text=title)
    dlg.format_secondary_text(message)
    dlg.run()
    dlg.destroy()


def _confirm_dialog(parent, title, message):
    """Yes/No dialog.  Returns True when the user picks Yes."""
    Gtk, _GLib = _gtk()
    dlg = Gtk.MessageDialog(
        transient_for=parent, modal=True,
        message_type=Gtk.MessageType.QUESTION,
        buttons=Gtk.ButtonsType.YES_NO, text=title)
    dlg.format_secondary_text(message)
    answer = dlg.run()
    dlg.destroy()
    return answer == Gtk.ResponseType.YES


def check_for_updates_gui(parent, app_name, current_version, slug,
                          manifest_url):
    """Help -> Check for Updates: full GUI flow (runs on the UI thread).

    Network I/O happens on a worker thread; every dialog is marshalled
    back onto the GTK main loop with GLib.idle_add.
    """
    Gtk, GLib = _gtk()
    import threading

    # Small "checking..." dialog so the click feels alive.
    checking = Gtk.MessageDialog(
        transient_for=parent, modal=False,
        message_type=Gtk.MessageType.INFO,
        buttons=Gtk.ButtonsType.NONE,
        text="Checking for updates ...")
    checking.format_secondary_text(
        "Contacting the update server for %s." % app_name)
    checking.show_all()

    def finish(fn):
        """Run *fn* on the GTK thread and close the checking dialog."""
        def _inner():
            try:
                checking.destroy()
            except Exception:
                pass
            fn()
            return False
        GLib.idle_add(_inner)

    def worker():
        # Self-update (2026-10-28): an update may already be staged
        # in the user's updates folder — check that FIRST, because
        # it answers truthfully even when the network is down.
        try:
            staged = staged_update_info(slug, current_version)
        except Exception:
            staged = {"ready": False, "version": None}

        def staged_dialog():
            _info_dialog(
                parent, "Check for Updates",
                "An update is already downloaded: %s %s will run "
                "next time you start the app.\n\nNothing else to "
                "do — restart the app when you're ready."
                % (app_name, staged.get("version")))

        manifest, error = fetch_manifest(manifest_url)
        if error:
            # Check failed — but a staged update is still news
            # worth reporting truthfully.
            if staged.get("ready"):
                finish(staged_dialog)
            else:
                finish(lambda: _info_dialog(
                    parent, "Check for Updates", error))
            return
        new_version = str(manifest.get("version", "")).strip()
        if not is_newer(new_version, current_version):
            if staged.get("ready"):
                finish(staged_dialog)
            else:
                finish(lambda: _info_dialog(
                    parent, "Check for Updates",
                    "You're on the latest version (%s)."
                    % current_version))
            return
        if staged.get("ready") and not is_newer(
                new_version, str(staged.get("version") or "")):
            finish(staged_dialog)
            return
        changelog = manifest.get("changelog") or "No changelog provided."
        # Self-update channels stage the new version into the
        # user's own updates folder — no root password, no
        # reinstall; it runs on the next launch.
        if isinstance(manifest.get("selfupdate"), dict):
            n_files = len((manifest.get("selfupdate") or {}).get(
                "files") or [])
            msg = ("Version %s is available "
                   "(you have %s).\n\n%s\n\n"
                   "This will download %d file(s) into your own "
                   "updates folder — no reinstall and no admin "
                   "password. The new version runs next time you "
                   "start the app."
                   % (new_version, current_version, changelog,
                      n_files))

            def ask_stage():
                if _confirm_dialog(parent, "Update available", msg):
                    _stage_and_report(parent, app_name,
                                      current_version, slug)
            finish(ask_stage)
            return
        n_files = len(manifest.get("files", []))
        msg = ("Version %s is available "
               "(you have %s).\n\n%s\n\n"
               "This will download %d file(s) and install them in "
               "place — no reinstall needed. The app will restart "
               "afterwards."
               % (new_version, current_version, changelog, n_files))

        def ask():
            if _confirm_dialog(parent, "Update available", msg):
                _download_and_install(parent, app_name, current_version,
                                      slug, manifest)
        finish(ask)

    threading.Thread(target=worker, daemon=True).start()


def _download_and_install(parent, app_name, current_version, slug,
                          manifest):
    """Download with progress bar, back up, apply, offer restart."""
    Gtk, GLib = _gtk()
    import threading

    new_version = str(manifest.get("version", "")).strip()

    # --- Progress dialog -------------------------------------------
    dlg = Gtk.Dialog(title="Downloading update", transient_for=parent,
                     modal=True)
    dlg.set_default_size(380, 120)
    box = dlg.get_content_area()
    label = Gtk.Label(label="Starting download ...")
    label.set_line_wrap(True)
    bar = Gtk.ProgressBar()
    bar.set_show_text(True)
    box.pack_start(label, False, False, 8)
    box.pack_start(bar, False, False, 8)
    dlg.add_button("Cancel", Gtk.ResponseType.CANCEL)
    dlg.show_all()
    cancelled = {"yes": False}

    def on_response(_d, resp):
        if resp == Gtk.ResponseType.CANCEL:
            cancelled["yes"] = True
    dlg.connect("response", on_response)

    def set_progress(done, total, text):
        def _inner():
            if cancelled["yes"]:
                return False
            frac = (done / total) if total else 0
            bar.set_fraction(max(0.0, min(1.0, frac)))
            bar.set_text("%d / %d" % (done, total))
            label.set_text(text)
            return False
        GLib.idle_add(_inner)

    def close_and(fn):
        def _inner():
            try:
                dlg.destroy()
            except Exception:
                pass
            fn()
            return False
        GLib.idle_add(_inner)

    def worker():
        stage = _stage_dir(slug, new_version)
        ok, error = download_files(
            manifest, stage,
            progress=lambda d, t, txt: set_progress(d, t, txt)
            if not cancelled["yes"] else None)
        if cancelled["yes"]:
            close_and(lambda: None)
            return
        if not ok:
            close_and(lambda: _info_dialog(
                parent, "Update failed", error))
            return
        set_progress(1, 1, "Download complete. Installing ...")
        # Back up what we are about to replace (cheap insurance).
        try:
            backup_current(slug, current_version, manifest)
        except Exception:
            pass  # backup is best-effort; the update matters more
        ok, error = apply_staged_update(
            stage, progress=lambda d, t, txt: set_progress(d, t, txt))
        if not ok:
            close_and(lambda: _info_dialog(
                parent, "Update failed", error))
            return

        def done():
            _info_dialog(
                parent, "Update installed",
                "Version %s installed successfully.\n"
                "The app will now restart." % new_version)
            restart_app()
        close_and(done)

    threading.Thread(target=worker, daemon=True).start()
    # Note: we deliberately do NOT dlg.run() here; the worker thread
    # drives the dialog and closes it when done.  The dialog stays
    # responsive because all network/file work is on the thread.


if __name__ == "__main__":
    # Privileged apply mode: pkexec python3 updater.py --apply <stagedir>
    # (Joshua's rule: comment everything, including entry points.)
    if len(sys.argv) == 3 and sys.argv[1] == "--apply":
        sys.exit(_apply_main(sys.argv[2]))
    # Foreground self-update staging: python3 updater.py
    # --self-check <slug> <current_version> — used by harnesses and
    # for debugging a channel from a terminal. Prints the outcome
    # as JSON; exit 0 when the app is current or an update staged.
    if len(sys.argv) == 4 and sys.argv[1] == "--self-check":
        _outcome, _info = stage_self_update(sys.argv[2], sys.argv[3])
        print(json.dumps({"outcome": _outcome, "info": _info},
                         indent=1))
        sys.exit(0 if _outcome in ("current", "staged") else 1)
    print("updater.py is a library. It is driven from the editor's "
          "Help -> Check for Updates menu.", file=sys.stderr)
    sys.exit(2)
