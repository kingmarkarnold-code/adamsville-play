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
import http.client
import urllib.parse
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

# ---------------------------------------------------------------------------
# Connections (v1.7.8 — Joshua's close/reopen design)
# ---------------------------------------------------------------------------
# In 1.7.7 the save round trip pushed and then re-downloaded as one
# undivided flow of urllib calls. On Joshua's laptop the push LANDED
# (two commits) but the re-download died with "Remote end closed
# connection without response" — a half-dead connection being reused
# for work it could no longer do.
#
# Joshua's fix (2026-10-16, supersedes any retry idea): "Instead of
# retrying what it should do is after it's pushed close the connection
# then reopen the connection to download."
#
# GitHubConnection makes connections explicit objects: one instance
# == one real HTTPS connection to api.github.com. A "leg" of work —
# all the pushes of a save, or all the proof downloads after it —
# runs on ONE connection; when the leg ends the caller CLOSES it, and
# the next leg OPENS A NEW ONE. A download therefore never rides the
# connection the push used, so a socket the server quietly dropped
# after the push cannot kill the download.

API_HOST = "api.github.com"


class GitHubConnection:
    """
    One explicit HTTPS connection to api.github.com.

    request() keeps the long-standing suite contract: it returns
    (parsed_json, None) on success or (None, error_message) on any
    failure, and the token only ever travels in the Authorization
    header. close() shuts the underlying socket for real — after
    close(), this object refuses further requests, so a stale
    connection can never be reused by accident.
    """

    def __init__(self):
        """Open the underlying HTTPS connection (socket connects on
        first request; the object represents ONE connection either
        way and is never shared between legs)."""
        self._conn = http.client.HTTPSConnection(API_HOST, timeout=30)
        self.closed = False

    def request(self, url, token, method="GET", payload=None):
        """
        Make one authenticated GitHub API request on THIS connection.
        Returns (parsed JSON, None) or (None, error_message).
        """
        if self.closed:
            # Programming error, not a network state: a closed leg's
            # connection must never silently come back to life.
            return None, "Connection already closed."
        headers = {
            "User-Agent": "adamsville-suite-native",
            "Accept": "application/vnd.github+json",
        }
        # NOTE: token is only ever sent in the Authorization header,
        # never in URLs, logs, or payloads. No header at all when no
        # token is set (public-repo reads still work unauthenticated).
        if token:
            headers["Authorization"] = f"Bearer {token}"
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        # http.client speaks in path+query, not full URLs.
        parts = urllib.parse.urlsplit(url)
        target = parts.path
        if parts.query:
            target += "?" + parts.query
        try:
            self._conn.request(method, target, body=body,
                               headers=headers)
            resp = self._conn.getresponse()
            raw = resp.read()
            status = resp.status
        except Exception as e:
            # Includes http.client.RemoteDisconnected — the exact
            # "Remote end closed connection without response" failure
            # from the laptop: THIS connection is dead. Report it as a
            # network error; the caller's leg structure (fresh
            # connection per leg) is what keeps it from stranding a
            # save whose push already landed.
            return None, f"Network error: {e}"
        if status >= 400:
            # Read the error body for a useful message (no token in it).
            try:
                err_body = json.loads(raw.decode("utf-8"))
                msg = err_body.get("message", f"HTTP {status}")
            except Exception:
                msg = f"HTTP {status}"
            if status == 401:
                msg = "Bad token (401). Check your GitHub token."
            elif status == 403:
                msg = ("Forbidden (403). Token may lack 'repo' scope "
                       "or be rate-limited.")
            elif status == 404:
                msg = ("Not found (404). Check the repo name and "
                       "file path.")
            return None, msg
        if not raw:
            # e.g. a bare 200/204 with no body — success, nothing in it.
            return {}, None
        try:
            return json.loads(raw.decode("utf-8")), None
        except Exception as e:
            return None, f"Unreadable response from GitHub: {e}"

    def close(self):
        """Close the underlying socket. Idempotent."""
        try:
            self._conn.close()
        except Exception:
            pass
        self.closed = True

    # Context-manager sugar so a leg can be written as a with-block.
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def open_connection():
    """
    Open a NEW GitHubConnection (v1.7.8).

    Every leg of a save round trip calls this for itself: the push
    leg gets one connection, it is closed, and the download leg gets
    another. Never module-level cached, never reused across legs.
    """
    return GitHubConnection()


def _api_request(url, token, method="GET", payload=None, conn=None):
    """
    Make an authenticated GitHub API request.
    Returns the parsed JSON response, or (None, error_message) on failure.

    v1.7.8: conn= runs the request on the caller's open
    GitHubConnection (one leg of a save round trip). Without conn, a
    FRESH connection is opened for this single request and closed
    right after — a request never rides a connection left over from
    earlier work.
    """
    if conn is not None:
        return conn.request(url, token, method=method, payload=payload)
    one_shot = open_connection()
    try:
        return one_shot.request(url, token, method=method,
                                payload=payload)
    finally:
        one_shot.close()


def push_file(repo, path, content_bytes, message, token=None, conn=None):
    """
    Push a file to a GitHub repo via the Contents API (create or update).

    repo: "owner/repo" (e.g. "kingmarkarnold-code/adamsville-map-editor")
    path: repo-relative path (e.g. "roads.json" or "detailed/ui_layout.json")
    content_bytes: the new file content
    message: commit message
    token: GitHub token (uses stored token if None)
    conn: optional GitHubConnection for this push leg (v1.7.8) — both
        requests (SHA read + PUT) ride it; without one, each request
        gets its own fresh one-shot connection.

    Returns (True, "ok") on success, (False, reason) on failure.
    """
    tok = token or get_token()
    if not tok:
        return False, "No GitHub token set."

    # Step 1: get the current blob SHA (needed for updates).
    # If the file doesn't exist yet (404), we create it without a SHA.
    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    resp, err = _api_request(url, tok, conn=conn)
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
    resp, err = _api_request(url, tok, method="PUT", payload=payload,
                             conn=conn)
    if resp is None:
        return False, err
    return True, "ok"


def push_targets(targets, token=None, conn=None):
    """
    Push multiple (repo, path, content_bytes, message) targets.
    Returns (True, "ok") if all succeeded, else (False, first_error).
    Stops at the first failure.

    v1.7.8: with conn=, every target rides the caller's push-leg
    connection. Without one, push_targets opens its OWN connection
    for the whole push leg and closes it when the leg ends — a bare
    push never leaves a half-dead connection behind for the next
    leg (e.g. a proof download) to trip over.
    """
    tok = token or get_token()
    if not tok:
        return False, "No GitHub token set."
    own = conn is None
    if own:
        conn = open_connection()
    try:
        for repo, path, content, message in targets:
            ok, msg = push_file(repo, path, content, message, tok,
                                conn=conn)
            if not ok:
                return False, f"{path}: {msg}"
        return True, "ok"
    finally:
        if own:
            conn.close()


# ---------------------------------------------------------------------------
# Fetch + delete (v1.7.7 — GLOBAL SAVE PROTOCOL support)
# ---------------------------------------------------------------------------
# v1.7.7 (Joshua 2026-10-16): every save in the suite now ends by
# RE-DOWNLOADING the pushed file from GitHub and showing that copy, so a
# save is only "done" once the GitHub state is what the user sees.
# fetch_file() is that re-download; it goes through the Contents API
# (never raw.githubusercontent.com, whose CDN can serve stale bytes).
# delete_file() completes the round trip for removals.
# v1.7.8: both take an optional conn= GitHubConnection so a round trip
# can run each leg on its own fresh connection (see above).

def fetch_file(repo, path, **kwargs):
    """
    Download one file from a GitHub repo via the Contents API.

    repo: "owner/repo"; path: repo-relative path.
    Optional kwargs:
      token: defaults to the stored suite token.
      conn: a GitHubConnection for this download leg (v1.7.8) — the
        caller owns it (opened fresh for the leg, closed after);
        without one, the fetch runs on its own one-shot connection.
    Returns (bytes, None) on success, (None, error_message) on failure.
    Works without a token for public repos (unauthenticated read); when
    a token is available it is used (higher rate limit, same content).
    """
    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    tok = kwargs.get("token") or get_token()
    conn = kwargs.get("conn")
    # v1.7.8: BOTH the authenticated and the unauthenticated read go
    # through _api_request / GitHubConnection now, so every download
    # — token or not — runs on an explicit connection instead of a
    # urllib one-off whose state nobody owns.
    resp, err = _api_request(url, tok, conn=conn)
    if resp is None:
        return None, err
    # 1.9.1 FIELD FIX (Joshua's laptop, 2026-10-16): the Contents API
    # returns NO inline content for files larger than 1 MB — the
    # response is metadata only ("encoding": "none", "content": "").
    # 1.9.0 decoded that empty string to b"" and the caller died with
    # "Downloaded data was unreadable", flattened by the app into
    # "check your internet connection". Eight of the game's zone
    # files (four zones' roads.json + roads.js) are 1.9–3.9 MB, so
    # download-on-open could NEVER succeed. When the metadata says
    # the file has bytes but carries no content, fetch the same bytes
    # from the Git Blobs API by the blob SHA the metadata gives us —
    # content-addressed (never stale), same host, same connection,
    # one extra request, only for files that need it.
    content = resp.get("content") or ""
    if not content and resp.get("size", 0) and resp.get("sha"):
        blob_url = (f"https://api.github.com/repos/{repo}"
                    f"/git/blobs/{resp['sha']}")
        blob, berr = _api_request(blob_url, tok, conn=conn)
        if blob is None:
            return None, (f"Fetch failed: {path} is over the "
                          f"Contents API's 1 MB inline limit, and "
                          f"the follow-up blob download failed: "
                          f"{berr}")
        content = blob.get("content") or ""
        if not content:
            # The Blobs API itself caps at 10 MB; an empty blob body
            # for a non-empty file means we hit that ceiling — say
            # so plainly instead of returning empty bytes upstream.
            return None, (f"Fetch failed: {path} is too large for "
                          f"the GitHub API to return (over 10 MB).")
    try:
        # Contents API returns the file base64-encoded (with newlines).
        return base64.b64decode(content), None
    except Exception as e:
        return None, f"Fetch failed: undecodable content ({e})"


def delete_file(repo, path, message, **kwargs):
    """
    Delete one file from a GitHub repo via the Contents API.

    repo: "owner/repo"; path: repo-relative path; message: commit text.
    Optional kwargs:
      token: defaults to the stored suite token.
      conn: a GitHubConnection for this push leg (v1.7.8) — deletes
        are mutations, so in a save round trip they ride the PUSH
        connection, never the proof-download one.
    Returns (True, "ok") on success, (False, reason) on failure —
    including (False, "...404...") if the file is already gone, so the
    caller can decide whether that counts as removed.
    """
    tok = kwargs.get("token") or get_token()
    conn = kwargs.get("conn")
    if not tok:
        return False, "No GitHub token set."

    # Step 1: the delete call needs the current blob SHA.
    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    resp, err = _api_request(url, tok, conn=conn)
    if resp is None:
        return False, err
    sha = resp.get("sha")
    if not sha:
        return False, "Could not read the file's SHA for deletion."

    # Step 2: DELETE with {message, sha}.
    payload = {"message": message, "sha": sha}
    resp, err = _api_request(url, tok, method="DELETE", payload=payload,
                             conn=conn)
    if resp is None:
        return False, err
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
