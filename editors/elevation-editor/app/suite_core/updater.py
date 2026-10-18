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

import json

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
