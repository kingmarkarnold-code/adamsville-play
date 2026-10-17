#!/usr/bin/env python3
"""
Adamsville Suite — Shared GitHub auto-push and dirty tracking.

This module is copied into each suite app (map, terrain, UI, building
editors). It provides:
  - GitHub token storage (owner-only, mode 600)
  - Token entry dialog (File → Settings → GitHub Token)
  - Auto-push via the GitHub Contents API
  - Dirty-flag tracking for the unsaved-changes close warning

Joshua's rule: all code commented.
The token is NEVER logged, printed, or included in any push payload.
"""

import json
import base64
import urllib.request
import urllib.error
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk


# ---------------------------------------------------------------------------
# Token storage
# ---------------------------------------------------------------------------
# Shared suite directory so all four apps use the same token.
SHARED_DIR = Path.home() / ".local" / "share" / "adamsville-suite"
TOKEN_FILE = SHARED_DIR / "github_token"


def _ensure_shared_dir():
    """Create the shared suite directory if missing."""
    SHARED_DIR.mkdir(parents=True, exist_ok=True)


def get_token():
    """
    Return the stored GitHub token, or None if not set.
    The token is read from disk each time (never cached in memory
    longer than needed).
    """
    try:
        if TOKEN_FILE.exists():
            token = TOKEN_FILE.read_text().strip()
            return token if token else None
    except Exception:
        pass
    return None


def has_token():
    """True if a GitHub token is stored."""
    return get_token() is not None


def save_token(token):
    """
    Store the GitHub token with owner-only permissions (mode 600).
    Overwrites any existing token.
    """
    _ensure_shared_dir()
    TOKEN_FILE.write_text(token.strip() + "\n")
    # Owner read/write only — no group/other access.
    TOKEN_FILE.chmod(0o600)


def clear_token():
    """Remove the stored token (e.g. if the user revokes it)."""
    try:
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# GitHub Contents API push
# ---------------------------------------------------------------------------

def _api_request(url, token, method="GET", payload=None):
    """
    Make an authenticated GitHub API request.
    Returns the parsed JSON response, or (None, error_message) on failure.
    """
    headers = {
        "User-Agent": "adamsville-suite-native",
        "Accept": "application/vnd.github+json",
        # NOTE: token is only ever sent in the Authorization header,
        # never in URLs, logs, or payloads.
        "Authorization": f"Bearer {token}",
    }
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode()), None
    except urllib.error.HTTPError as e:
        # Read the error body for a useful message (no token in it).
        try:
            err_body = json.loads(e.read().decode())
            msg = err_body.get("message", f"HTTP {e.code}")
        except Exception:
            msg = f"HTTP {e.code}"
        if e.code == 401:
            msg = "Bad token (401). Check your GitHub token."
        elif e.code == 403:
            msg = "Forbidden (403). Token may lack 'repo' scope or be rate-limited."
        elif e.code == 404:
            msg = "Not found (404). Check the repo name and file path."
        return None, msg
    except urllib.error.URLError as e:
        return None, f"Network error: {e.reason}"
    except Exception as e:
        return None, f"Push failed: {e}"


def push_file(repo, path, content_bytes, message, token=None):
    """
    Push a file to a GitHub repo via the Contents API (create or update).

    repo: "owner/repo" (e.g. "kingmarkarnold-code/adamsville-map-editor")
    path: repo-relative path (e.g. "roads.json" or "detailed/ui_layout.json")
    content_bytes: the new file content
    message: commit message
    token: GitHub token (uses stored token if None)

    Returns (True, "ok") on success, (False, reason) on failure.
    """
    tok = token or get_token()
    if not tok:
        return False, "No GitHub token set."

    # Step 1: get the current blob SHA (needed for updates).
    # If the file doesn't exist yet (404), we create it without a SHA.
    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    resp, err = _api_request(url, tok)
    sha = None
    if resp is not None:
        sha = resp.get("sha")
    elif err and "404" not in err:
        # A real error (not just "file doesn't exist yet").
        return False, err
    # else: 404 → new file, sha stays None.

    # Step 2: PUT the new content (base64-encoded per the API).
    payload = {
        "message": message,
        "content": base64.b64encode(content_bytes).decode("ascii"),
    }
    if sha:
        payload["sha"] = sha
    resp, err = _api_request(url, tok, method="PUT", payload=payload)
    if resp is None:
        return False, err
    return True, "ok"


def push_targets(targets, token=None):
    """
    Push multiple (repo, path, content_bytes, message) targets.
    Returns (True, "ok") if all succeeded, else (False, first_error).
    Stops at the first failure.
    """
    tok = token or get_token()
    if not tok:
        return False, "No GitHub token set."
    for repo, path, content, message in targets:
        ok, msg = push_file(repo, path, content, message, tok)
        if not ok:
            return False, f"{path}: {msg}"
    return True, "ok"


# ---------------------------------------------------------------------------
# Token entry dialog
# ---------------------------------------------------------------------------

def show_token_dialog(parent):
    """
    Show the GitHub token entry dialog.
    Returns True if a token was saved, False otherwise.
    """
    dialog = Gtk.Dialog(title="GitHub Token", transient_for=parent, flags=0)
    dialog.set_default_size(460, 260)
    dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
    dialog.add_button("Save Token", Gtk.ResponseType.OK)

    content = dialog.get_content_area()
    content.set_border_width(12)
    content.set_spacing(8)

    info = Gtk.Label()
    info.set_markup(
        "Enter a GitHub <b>personal access token</b> to enable automatic "
        "pushing.\n\n"
        "Create one at <b>github.com/settings/tokens</b> with the "
        "<b>repo</b> scope.\n\n"
        "The token is stored on this machine only (owner-readable), "
        "and is never logged or shared.")
    info.set_line_wrap(True)
    info.set_xalign(0)
    content.pack_start(info, False, False, 0)

    # Password-style entry so the token isn't visible on screen.
    entry = Gtk.Entry()
    entry.set_visibility(False)
    entry.set_placeholder_text("ghp_…")
    existing = get_token()
    if existing:
        entry.set_text(existing)
    content.pack_start(entry, False, False, 0)

    # Show/hide toggle for the token field.
    show_check = Gtk.CheckButton(label="Show token")
    show_check.connect(
        "toggled", lambda w: entry.set_visibility(w.get_active()))
    content.pack_start(show_check, False, False, 0)

    dialog.show_all()
    resp = dialog.run()
    token = entry.get_text().strip()
    dialog.destroy()

    if resp == Gtk.ResponseType.OK and token:
        save_token(token)
        return True
    return False


def show_first_save_prompt(parent):
    """
    Shown on the first local save when no token is set.
    Returns True if the user entered a token, False if they skipped.
    """
    dialog = Gtk.MessageDialog(
        transient_for=parent, flags=0,
        message_type=Gtk.MessageType.QUESTION,
        buttons=Gtk.ButtonsType.NONE,
        text="Enable auto-push to GitHub?")
    dialog.format_secondary_text(
        "Every save can automatically push to GitHub, so your changes "
        "go live without extra steps.\n\n"
        "Enter your GitHub token to enable it, or Skip to keep pushing "
        "manually.")
    dialog.add_button("Skip", Gtk.ResponseType.CANCEL)
    dialog.add_button("Enter Token", Gtk.ResponseType.OK)
    resp = dialog.run()
    dialog.destroy()
    if resp == Gtk.ResponseType.OK:
        return show_token_dialog(parent)
    return False


# ---------------------------------------------------------------------------
# Unsaved-changes close warning
# ---------------------------------------------------------------------------

def show_close_warning(parent):
    """
    Ask what to do with unpublished changes on window close.

    Returns:
      "push"   — push then close
      "close"  — close without pushing
      "cancel" — don't close
    """
    dialog = Gtk.MessageDialog(
        transient_for=parent, flags=0,
        message_type=Gtk.MessageType.WARNING,
        buttons=Gtk.ButtonsType.NONE,
        text="Unpublished changes")
    dialog.format_secondary_text(
        "You have unpublished changes. "
        "Would you like to push to GitHub?")
    dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
    dialog.add_button("Close Without Pushing", Gtk.ResponseType.NO)
    dialog.add_button("Push & Close", Gtk.ResponseType.YES)
    # Make Push & Close the default (Enter key).
    dialog.set_default_response(Gtk.ResponseType.YES)
    resp = dialog.run()
    dialog.destroy()
    if resp == Gtk.ResponseType.YES:
        return "push"
    if resp == Gtk.ResponseType.NO:
        return "close"
    return "cancel"


# ---------------------------------------------------------------------------
# Settings dialog — GitHub API key management (Joshua 2026-10-11)
# ---------------------------------------------------------------------------
# The key is changeable from within the app (no reinstall needed).
# All four suite apps share the same storage, so changing it in one
# app changes it for all. The actual key value is never displayed.

def show_settings_dialog(parent, on_key_changed=None):
    """
    Show the settings dialog with GitHub API key management.

    Shows key status ("Key set" / "No key set"), a "Change Key" button
    that opens the entry dialog, and a "Remove Key" button that clears
    the stored key (disabling auto-push, falling back to manual).

    on_key_changed: optional callback invoked after a change/remove,
    so the app can update its status bar.

    Returns True if the key was changed or removed, False otherwise.
    """
    dialog = Gtk.Dialog(title="Settings", transient_for=parent, flags=0)
    dialog.set_default_size(420, 220)
    dialog.add_button("Close", Gtk.ResponseType.CLOSE)

    content = dialog.get_content_area()
    content.set_border_width(12)
    content.set_spacing(10)

    # --- GitHub API key section ---
    key_label = Gtk.Label()
    key_label.set_markup("<b>GitHub API Key</b>")
    key_label.set_xalign(0)
    content.pack_start(key_label, False, False, 0)

    # Status line: never shows the actual key value.
    status_label = Gtk.Label()
    status_label.set_xalign(0)
    content.pack_start(status_label, False, False, 0)

    def refresh_status():
        """Update the status line without revealing the key."""
        if has_token():
            status_label.set_markup(
                'Status: <b>Key set</b> <span foreground="#888888">'
                "(auto-push enabled)</span>")
        else:
            status_label.set_markup(
                'Status: <b>No key set</b> <span foreground="#888888">'
                "(manual push only)</span>")

    refresh_status()

    desc = Gtk.Label(
        label="The API key lets the app push to GitHub automatically "
              "(every 5 minutes) instead of copying JSON manually.\n"
              "Create one at github.com/settings/tokens with the "
              "'repo' scope.")
    desc.set_line_wrap(True)
    desc.set_xalign(0)
    content.pack_start(desc, False, False, 0)

    btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)

    changed = [False]  # mutable flag for the closure

    def on_change_clicked(w):
        """Open the key entry dialog; save if confirmed."""
        if show_token_dialog(parent):
            changed[0] = True
            refresh_status()
            if on_key_changed:
                on_key_changed(True)

    def on_remove_clicked(w):
        """Clear the stored key after confirmation."""
        confirm = Gtk.MessageDialog(
            transient_for=dialog, flags=0,
            message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.OK_CANCEL,
            text="Remove GitHub API key?")
        confirm.format_secondary_text(
            "Auto-push will be disabled. You can still push manually "
            "with the copy/download flow.")
        resp = confirm.run()
        confirm.destroy()
        if resp == Gtk.ResponseType.OK:
            clear_token()
            changed[0] = True
            refresh_status()
            if on_key_changed:
                on_key_changed(False)

    change_btn = Gtk.Button(label="Change Key…")
    change_btn.connect("clicked", on_change_clicked)
    btn_box.pack_start(change_btn, False, False, 0)

    remove_btn = Gtk.Button(label="Remove Key")
    remove_btn.connect("clicked", on_remove_clicked)
    # Only enable Remove when a key exists.
    remove_btn.set_sensitive(has_token())
    btn_box.pack_start(remove_btn, False, False, 0)

    content.pack_start(btn_box, False, False, 0)

    dialog.show_all()
    dialog.run()
    dialog.destroy()
    return changed[0]
