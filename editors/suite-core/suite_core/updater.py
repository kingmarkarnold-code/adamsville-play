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

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

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
        manifest, error = fetch_manifest(manifest_url)
        if error:
            finish(lambda: _info_dialog(
                parent, "Check for Updates", error))
            return
        new_version = str(manifest.get("version", "")).strip()
        if not is_newer(new_version, current_version):
            finish(lambda: _info_dialog(
                parent, "Check for Updates",
                "You're on the latest version (%s)." % current_version))
            return
        changelog = manifest.get("changelog") or "No changelog provided."
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
    print("updater.py is a library. It is driven from the editor's "
          "Help -> Check for Updates menu.", file=sys.stderr)
    sys.exit(2)
