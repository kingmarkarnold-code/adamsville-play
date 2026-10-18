#!/usr/bin/env python3
"""
Adamsville Suite — Shared GitHub auto-push and dirty tracking.

SUITE-CORE HOME (2026-10-17): this module now lives ONCE in the
shared suite core (~/workspace/editors/suite-core/), per Joshua's
no-repeated-code law. It was adopted verbatim from the Building
Editor 1.7.2 copy — the proven implementation — and apps now import
it from the core instead of carrying private copies. (Older apps
still ship their own snapshots until their next rebuild adopts the
core; fixes should land HERE first.)

It provides:
  - GitHub token storage (owner-only, mode 600)
  - Token entry dialog (File → Settings → GitHub Token)
  - Auto-push via the GitHub Contents API
  - Dirty-flag tracking for the unsaved-changes close warning

Joshua's rule: all code commented.
The token is NEVER logged, printed, or included in any push payload.
"""

import json
import base64
import hashlib
import datetime
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

    def request_stream(self, url, token):
        """
        Start one request on THIS connection WITHOUT reading the
        body (v1.7.2): returns (status, response, None) so the
        caller can stream response.read() in chunks (the progress
        download), or (None, None, error_message). The caller owns
        reading the response to the end.
        """
        if self.closed:
            return None, None, "Connection already closed."
        headers = {
            "User-Agent": "adamsville-suite-native",
            "Accept": "application/vnd.github+json",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        parts = urllib.parse.urlsplit(url)
        target = parts.path
        if parts.query:
            target += "?" + parts.query
        try:
            self._conn.request("GET", target, headers=headers)
            resp = self._conn.getresponse()
            return resp.status, resp, None
        except Exception as e:
            return None, None, f"Network error: {e}"

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


def _is_sha_conflict(err):
    """
    True when a PUT refusal is GitHub's SHA-mismatch answer (HTTP
    409): the file changed between our SHA read and our PUT, so the
    SHA we offered is stale. GitHub's own wording for it is
    "<path> is at <current sha> but expected <our sha>" — the exact
    message Joshua saw on 2026-10-16. Any OTHER refusal (bad token,
    network, ...) is not this and must not be retried as if it were.

    (Adopted from the Map Editor 1.9.4, whose push_file is the
    cleaner of the two suite copies on this point.)
    """
    if not err:
        return False
    return "409" in err or ("is at" in err and "but expected" in err)


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

    SHA-CONFLICT RETRY (Map Editor 1.9.4): if the PUT is refused
    because the file moved under us (409 — see _is_sha_conflict),
    the SHA is re-read ONCE and the PUT retried ONCE with the fresh
    SHA and the SAME content. ANY writer to the repo can cause it
    — a second editor, a web-UI commit, an agent push — and one
    stale SHA read should not fail a whole save when the remedy is
    a single fresh read. A second refusal surfaces exactly as before.

    Returns (True, "ok") on success, (False, reason) on failure.
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

    # Step 2: PUT the new content (base64-encoded per the API). On a
    # SHA conflict, loop once through Step 1b and retry; the loop
    # bound (2 attempts total) is the whole retry policy.
    for attempt in (1, 2):
        payload = {
            "message": message,
            "content": base64.b64encode(content_bytes).decode("ascii"),
        }
        if sha:
            payload["sha"] = sha
        resp, err = _api_request(url, tok, method="PUT", payload=payload,
                                 conn=conn)
        if resp is not None:
            return True, "ok"
        if attempt == 2 or not _is_sha_conflict(err):
            # Final answer: a second refusal, or a refusal that was
            # never about the SHA — surface it exactly as before.
            return False, err
        # Step 1b (retry only): re-read the CURRENT SHA once. The
        # retry PUT below carries the same content with this fresh
        # SHA. If the file vanished in the meantime (404), the retry
        # simply creates it (sha stays None).
        resp2, err2 = _api_request(url, tok, conn=conn)
        if resp2 is not None:
            sha = resp2.get("sha")
        elif err2 and "404" in err2:
            sha = None
        else:
            # Couldn't even refresh the SHA — report the ORIGINAL
            # refusal, which is the failure the user actually hit.
            return False, err
    return False, err  # unreachable; the loop always returns




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
        # 2026-10-18 (game freshness fix): if this leg changed game
        # data that detailed/map-manifest.json covers, refresh the
        # manifest entries and bump map_version as the leg's final
        # step — see maintain_map_manifest() below. The data itself is
        # already pushed, so a manifest failure must not report the
        # SAVE as failed; it rides along as a warning suffix instead
        # (the game's own drift check covers freshness meanwhile).
        mok, mmsg = maintain_map_manifest(targets, tok, conn=conn)
        if not mok:
            return True, ("ok — but the map manifest refresh failed: "
                          f"{mmsg}")
        return True, "ok"
    finally:
        if own:
            conn.close()


# ---------------------------------------------------------------------------
# Map manifest maintenance (2026-10-18 — the game's freshness fix)
# ---------------------------------------------------------------------------
# THE DEFECT (Joshua's live report, 2026-10-18): he deleted a section
# of road in the Map Editor, the save pushed fine — and his game kept
# showing the deleted road. Cause: editor saves pushed the changed
# zone files but never touched detailed/map-manifest.json, whose
# map_version stamp and per-file hash/size entries are the game's
# freshness signal (see detailed/mapdelivery.js in the game). The
# stamp never moved, so the game never re-downloaded anything.
#
# THE RULE (Joshua's standing rule for map data: bump the version
# every time any map data file changes): whenever a push changes a
# file that detailed/map-manifest.json covers, the push leg ALSO
# refreshes that file's manifest entry (size + sha256), bumps
# map_version, and pushes the manifest as the leg's final commit.
# From then on every game copy sees the stamp move, diffs by hash,
# and downloads exactly the changed files. (The game ALSO grew a
# drift check the same day, so copies stay fresh even if a manifest
# refresh is ever missed — the two fixes back each other up.)
#
# SCOPE, deliberately narrow: only files ALREADY LISTED in the
# manifest are refreshed (adding new entries stays the build
# pipeline's job), and the bump happens only when at least one listed
# file actually changed. Pushes of anything else (UI layouts, deck
# results, drawings, editor files) never touch the manifest.

MAP_MANIFEST_PATH = "detailed/map-manifest.json"


def _next_map_version(current):
    """The next map_version stamp after `current` (YYYY.MM.DD.N).

    Same-day saves increment N; the first save of a new day starts at
    .1 under today's date; a stamp never moves backwards (a
    future-dated stamp just increments). Unparseable input starts
    today at .1. Dates are UTC, matching the manifest's convention.
    """
    today = datetime.datetime.now(datetime.timezone.utc).date()
    stamp = "%04d.%02d.%02d" % (today.year, today.month, today.day)
    try:
        parts = str(current).split(".")
        cur = ".".join(parts[:3])
        n = int(parts[3])
    except Exception:
        return stamp + ".1"
    if cur == stamp:
        return "%s.%d" % (stamp, n + 1)
    if cur < stamp:  # zero-padded dates compare correctly as text
        return stamp + ".1"
    return "%s.%d" % (cur, n + 1)


def maintain_map_manifest(targets, token=None, conn=None):
    """
    Refresh detailed/map-manifest.json after a push that changed
    manifest-covered game data (see the section note above).

    targets: the same (repo, path, content_bytes, message) list that
    was just pushed successfully. Returns (True, "ok") when nothing
    needed doing or the manifest was refreshed; (False, reason) when
    the refresh itself failed — the data push already landed either
    way, so the caller decides how loudly to report it.
    """
    tok = token or get_token()
    if not tok:
        return False, "No GitHub token set."
    # Group the pushed targets per repo: path -> content bytes.
    by_repo = {}
    for repo, path, content, _message in targets:
        by_repo.setdefault(repo, {})[path] = content
    for repo, changed in by_repo.items():
        raw, err = fetch_file(repo, MAP_MANIFEST_PATH, token=tok,
                              conn=conn)
        if raw is None:
            if err and "404" not in err:
                return False, f"map manifest fetch failed: {err}"
            # This repo has no map manifest (not the game repo) —
            # nothing to maintain there.
            continue
        try:
            manifest = json.loads(raw.decode("utf-8"))
            entries = {e.get("name"): e
                       for e in manifest.get("files", [])}
        except Exception as e:
            return False, f"map manifest unreadable: {e}"
        touched = []
        for path, content in changed.items():
            entry = entries.get(path)
            if entry is None:
                continue  # not covered by the manifest — not ours
            entry["size"] = len(content)
            entry["sha256"] = hashlib.sha256(content).hexdigest()
            entry.pop("hash", None)
            touched.append(path)
        if not touched:
            continue
        manifest["map_version"] = _next_map_version(
            manifest.get("map_version") or manifest.get("version"))
        payload = json.dumps(manifest, indent=1).encode("utf-8")
        ok, msg = push_file(
            repo, MAP_MANIFEST_PATH, payload,
            "Suite save: refresh map manifest (map data changed: "
            + ", ".join(sorted(touched)) + ")",
            tok, conn=conn)
        if not ok:
            return False, f"map manifest push failed: {msg}"
    return True, "ok"


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
    # 1.6.1 FIELD FIX (Joshua's laptop, 2026-10-16; ported from the
    # Map Editor's proven 1.9.1 fix): the Contents API returns NO
    # inline content for files larger than 1 MB — the response is
    # metadata only ("encoding": "none", "content": ""). The pre-fix
    # code decoded that empty string to b"" and every zone whose
    # buildings file is over the limit failed to load (riverdale's
    # buildings.json is 1,884,155 bytes, southfulton's 1,631,095, and
    # several buildings_detail.json / roads.json files are over too),
    # so download-on-open could NEVER fully succeed. When the
    # metadata says the file has bytes but carries no content, fetch
    # the same bytes from the Git Blobs API by the blob SHA the
    # metadata gives us — content-addressed (never stale), same
    # host, same connection, one extra request, only for files that
    # need it.
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
# Metadata + progress downloads (v1.7.2 — load on demand)
# ---------------------------------------------------------------------------
# 1.7.2 (Joshua 2026-10-17): downloads must SHOW their size as they
# happen ("a progress bar showing the download MBs"), and the suite
# shared cache needs each file's blob SHA to decide freshness
# without downloading the file. fetch_file_meta() is the cheap
# metadata read; fetch_file_progress() is fetch_file() plus a
# progress callback: progress(done_bytes, total_bytes), where the
# total is the file's real size from its Contents metadata.

def fetch_file_meta(repo, path, **kwargs):
    """
    Read one file's Contents API METADATA (no content download):
    returns (meta_dict, None) — meta carries "sha" (the git blob
    SHA) and "size" — or (None, error_message). Same connection
    rules as fetch_file (conn= rides the caller's leg; otherwise a
    fresh one-shot connection).
    """
    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    tok = kwargs.get("token") or get_token()
    conn = kwargs.get("conn")
    resp, err = _api_request(url, tok, conn=conn)
    if resp is None:
        return None, err
    return resp, None


def fetch_file_progress(repo, path, progress=None, **kwargs):
    """
    fetch_file() with download progress (v1.7.2).

    progress(done_bytes, total_bytes) is called as bytes arrive
    (for files over the Contents API's 1 MB inline limit, the blob
    body is streamed and progress is reported against the file's
    real size from its metadata; it lands exactly on the total when
    the download completes). Returns (bytes, None) or
    (None, error_message) — the same contract as fetch_file.
    """
    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    tok = kwargs.get("token") or get_token()
    conn = kwargs.get("conn")
    resp, err = _api_request(url, tok, conn=conn)
    if resp is None:
        return None, err
    total = int(resp.get("size") or 0)
    content = resp.get("content") or ""
    if content:
        try:
            data = base64.b64decode(content)
        except Exception as e:
            return None, f"Fetch failed: undecodable content ({e})"
        if progress:
            progress(len(data), total or len(data))
        return data, None
    if not (total and resp.get("sha")):
        # No content, no size: an empty file is a legitimate answer.
        if progress:
            progress(0, 0)
        return b"", None
    # Over the 1 MB inline limit: stream the blob body in chunks so
    # the progress callback sees the download grow. The blob body
    # is base64 JSON (~4/3 the file size); progress maps the bytes
    # received onto the file's real size and lands exactly on it.
    blob_url = (f"https://api.github.com/repos/{repo}"
                f"/git/blobs/{resp['sha']}")
    one_shot = None
    use_conn = conn
    if use_conn is None:
        one_shot = open_connection()
        use_conn = one_shot
    try:
        status, raw_resp, rerr = use_conn.request_stream(
            blob_url, tok)
        if raw_resp is None:
            return None, (f"Fetch failed: {path} is over the "
                          f"Contents API's 1 MB inline limit, and "
                          f"the follow-up blob download failed: {rerr}")
        if status >= 400:
            raw_resp.read()
            return None, (f"Fetch failed: blob download answered "
                          f"HTTP {status} for {path}")
        body_len = raw_resp.getheader("Content-Length")
        body_total = int(body_len) if body_len else 0
        chunks = []
        got = 0
        while True:
            chunk = raw_resp.read(65536)
            if not chunk:
                break
            chunks.append(chunk)
            got += len(chunk)
            if progress and body_total:
                progress(min(total, got * total // body_total), total)
        raw = b"".join(chunks)
    finally:
        if one_shot is not None:
            one_shot.close()
    try:
        blob = json.loads(raw.decode("utf-8"))
        data = base64.b64decode(blob.get("content") or "")
    except Exception as e:
        return None, f"Fetch failed: undecodable blob ({e})"
    if not data and total:
        # Same 10 MB Blobs ceiling guard as fetch_file.
        return None, (f"Fetch failed: {path} is too large for the "
                      f"GitHub API to return (over 10 MB).")
    if progress:
        progress(len(data), total or len(data))
    return data, None


# ---------------------------------------------------------------------------
# The round trip (suite-core extraction, 2026-10-17)
# ---------------------------------------------------------------------------
# Joshua's standing save rule (2026-10-16), as ONE operation, shared
# by every editor: save locally -> push to GitHub -> CLOSE the
# connection -> REOPEN a fresh connection -> re-download -> the
# caller refreshes its view from the downloaded proof copy.
# Nothing counts as saved until it has been seen coming back.
#
# Before this extraction the suite carried THREE copies of this
# pattern (the Building Editor's GameStore.round_trip_save, its
# StationEdits.round_trip_save, and data.design_round_trip) with
# identical stage discipline and identical failure-message shapes.
# round_trip() below is that pattern, generalized over plain
# (repo, path, content_bytes, message) targets; the app-specific
# stage 4 (adopting the proof copy into live state) stays with the
# caller, through the verify hook and the returned fresh bytes.

#: Default number of download attempts for network-class errors
#: (the Building Editor 1.7.x retry policy, carried into the core).
DOWNLOAD_ATTEMPTS = 3


def fetch_with_retries(fetch_file, repo, path, attempts=DOWNLOAD_ATTEMPTS):
    """
    fetch_file(repo, path) with the suite retry policy: network-class
    errors ("Network error: ...") get up to `attempts` tries, each on
    its own fresh connection (fetch_file's contract creates one per
    call when conn is None). HTTP answers (401/403/404) are never
    retried — re-asking cannot change them.

    Returns (raw_bytes, None) or (None, "<path>: <reason>").
    (Generalized from the Building Editor's zonedata helper, which
    had the repo baked in as a module constant.)
    """
    err = None
    for _attempt in range(attempts):
        raw, err = fetch_file(repo, path)
        if raw is not None:
            return raw, None
        if not (err or "").startswith("Network error:"):
            break
    return None, f"{path}: {err}"


def round_trip(targets, local_dir, open_connection, push_targets,
               fetch_file, *, local_writer=None, local_names=None,
               verify=None,
               success_message="Saved to GitHub and verified."):
    """
    One full save round trip over `targets` — a list of
    (repo, path, content_bytes, message) tuples, all in ONE repo
    (the repo of the first target is used for the proof fetches).

    Transport is injected (this module's own open_connection /
    push_targets / fetch_file, or a harness stub with the same
    signatures) so the operation is testable without a network:
      open_connection() -> a NEW connection object per leg, with
          .close();
      push_targets(targets, conn=...) -> (ok, reason);
      fetch_file(repo, path, conn=...) -> (bytes, None) | (None, err).

    Stages:
      1. LOCAL SAVE — every target's bytes are written under
         local_dir (default name: the repo path with "/" -> "_";
         local_names may map a repo path to a specific file name).
         local_writer, when given, REPLACES this stage entirely
         (called as local_writer(targets); its exceptions become
         the "local-save-failed:" message) — for apps whose local
         stage is a cache fold rather than plain file writes.
      2. PUSH LEG — all targets pushed on ONE connection, which is
         ALWAYS closed before the proof leg, success or failure: a
         half-dead socket must never carry the download.
      3. PROOF LEG — every target re-downloaded on a FRESH
         connection. A failure here is reported as what it is: the
         save DID reach GitHub; only the proof copy is missing.
      4. VERIFY — verify(fresh), when given, is the caller's gate
         on the proof copy: return None to accept it, or
         (message, value) to reject it (round_trip then returns
         (False, message, value)). Callers adopt the proof copy
         into their live state from the returned dict themselves.

    Returns (ok, message, fresh) where fresh maps repo path ->
    re-downloaded bytes on success (or the verify hook's value on
    a verify rejection). On ANY failure before adoption, nothing
    about the caller's state has been touched by this function.
    An empty targets list is a successful no-op with the standing
    "Nothing to save" message — zero pushes, zero fetches.
    """
    if not targets:
        return True, "Nothing to save — no changes.", {}
    repo = targets[0][0]

    # ---- Stage 1: LOCAL SAVE --------------------------------------
    try:
        if local_writer is not None:
            local_writer(targets)
        else:
            from pathlib import Path
            cache = Path(local_dir)
            cache.mkdir(parents=True, exist_ok=True)
            for _repo, path, content, _msg in targets:
                name = (local_names or {}).get(
                    path, path.replace("/", "_"))
                (cache / name).write_bytes(content)
    except Exception as e:
        return False, f"local-save-failed: {e}", None

    # ---- Stage 2: PUSH LEG (one connection, always closed) --------
    push_conn = open_connection()
    try:
        ok, msg = push_targets(targets, conn=push_conn)
    finally:
        # The push connection is ALWAYS closed before the proof
        # leg — a half-dead socket must never carry the download.
        try:
            push_conn.close()
        except Exception:
            pass
    if not ok:
        return False, f"Push to GitHub failed: {msg}", None

    # ---- Stage 3: PROOF LEG (a FRESH connection) -------------------
    fresh = {}
    proof_conn = open_connection()
    try:
        for _repo, path, _content, _msg in targets:
            raw, err = fetch_file(repo, path, conn=proof_conn)
            if err is not None or raw is None:
                return False, (
                    f"push reached GitHub but downloading the "
                    f"proof copy back failed: {err} — your save "
                    f"DID reach GitHub"), None
            fresh[path] = raw
    finally:
        try:
            proof_conn.close()
        except Exception:
            pass

    # ---- Stage 4: VERIFY (the caller's gate on the proof copy) -----
    if verify is not None:
        rejected = verify(fresh)
        if rejected is not None:
            message, value = rejected
            return False, message, value
    return True, success_message, fresh


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
