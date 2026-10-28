#!/usr/bin/env python3
"""
Adamsville SUITE CORE — editor reporting.

The editors report back to the SAME inbox as the game: Joshua's
"Surviving Adamsville — Player Reports" Google Form, under the
"Editor Report" type (added to the form 2026-10-28, the same way
"Crew Report" was added for the game's crews). Joshua's rule
(2026-10-28): Mollie should have real specifics about what's
going on inside an app — app + version, which payload is running
(installed vs update-staged), OPERATION TIMINGS for heavy work,
errors with context, the data versions in play, and a session
summary — instead of reconstructing events from timestamps after
the fact.

The doctrine is the game's crew-report doctrine (Joshua
2026-10-24): SILENT and AUTOMATIC. Reports are recorded, never
displayed: no toasts, no modals, no status-bar noise. A local
persistent queue holds reports until they can be delivered;
delivery is fire-and-forget on daemon threads with tiny
timeouts; and the whole module is FAIL-OPEN — a reporting bug,
a dead network, or a full disk must never break, slow, or even
visibly touch the host app. Every public function swallows its
own exceptions.

Form mapping (field map: game-map/report-relay/GOOGLE-FORM.md):
    Report type    entry.245308779   always "Editor Report"
    What happened? entry.722588258   the structured block below
    Game version   entry.1808724204  "<slug> <app version>"
    Where          entry.613460102   op / zone / file context
    Device         entry.1017388942  OS + Python version
    Player name    entry.1227514984  left blank (automatic)

The "What happened?" block is line-structured so it parses at a
glance — first line "<kind>: <message>", then one key=value per
line:

    timing: delete completed
    app=map-editor
    version=1.9.17
    source=staged
    session=3fa9c1
    ts=2026-10-28T17:52:11Z
    op=delete
    pieces=18
    dur_ms=4210
    data: roads=2026.10.28.1

Throttle (mirrors the game's GitHubReports crew throttle):
identical (kind, message) reports dedupe within 10 minutes, and
each kind is capped at 10 reports per rolling 10 minutes; drops
are counted (status()["dropped"]) and the count rides the
session summary, so silence never hides a flood.

Wiring (per app, three lines at startup — see SELF-UPDATE.md):

    from suite_core import reporting      # or: import reporting
    reporting.init("map-editor", APP_VERSION,
                   data_versions={"roads": MAPVER})
    reporting.session_start()
    ...
    with reporting.operation("delete", pieces=n):
        ... the heavy thing ...
    reporting.session_end()               # at shutdown

Joshua's rule: all code commented.
"""

import json
import os
import platform
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid

# ---------------------------------------------------------------------------
# Destination — the game's Player Reports form (public addresses,
# not secrets: the same values ship in the game's client config).
# ---------------------------------------------------------------------------

FORM_URL = ("https://docs.google.com/forms/d/e/"
            "1FAIpQLSeLwZKjsqKoCRVIuedhSD5NXJFO_WkwJtG7ExjXjCV6seakMg"
            "/formResponse")
ENTRY_TYPE = "entry.245308779"
ENTRY_MESSAGE = "entry.722588258"
ENTRY_VERSION = "entry.1808724204"
ENTRY_WHERE = "entry.613460102"
ENTRY_DEVICE = "entry.1017388942"
REPORT_TYPE = "Editor Report"

# Throttle + queue limits (the game's numbers).
DEDUPE_WINDOW_S = 600          # identical (kind, msg) inside 10 min
KIND_CAP = 10                  # per kind per rolling window
KIND_WINDOW_S = 600
QUEUE_CAP = 200                # persisted queue; oldest dropped past it
FLUSH_TIMEOUT_S = 5            # per-POST timeout — tiny on purpose

# ---------------------------------------------------------------------------
# Module state. One reporter per process; init() (re)configures it.
# Everything below is guarded by _LOCK and wrapped so that no
# reporting failure can reach the host app.
# ---------------------------------------------------------------------------

_LOCK = threading.Lock()
_STATE = {
    "slug": None,              # app slug, e.g. "map-editor"
    "version": "",             # running app version
    "source": "installed",     # installed | staged | custom
    "session": "",             # short session id
    "started_at": 0.0,         # time.time() at init
    "data_versions": {},       # {"roads": "...", ...}
    "endpoint": FORM_URL,      # overridable for tests/capture
    "transport": None,         # injectable sender for harnesses
    "queue": [],               # [form-body dicts] pending delivery
    "queue_path": None,        # persisted queue file
    "dedupe": {},              # (kind, msg) -> last enqueue time
    "kind_times": {},          # kind -> [enqueue times]
    "dropped": 0,              # throttle/queue drops this session
    "sent": 0,                 # delivered this session
    "flush_running": False,
    "ready": False,
}


def _queue_path(slug):
    """~/.local/share/adamsville-suite/<slug>/reports-queue.json —
    beside the app's updates folder, in the suite's shared home."""
    return os.path.join(os.path.expanduser("~"), ".local", "share",
                        "adamsville-suite", str(slug),
                        "reports-queue.json")


def _detect_source():
    """Which payload is running: the bootstrap launcher passes the
    app root in ADAMSVILLE_APP_ROOT; a root inside the suite
    updates folder means an update-staged payload is live."""
    root = os.environ.get("ADAMSVILLE_APP_ROOT") or ""
    if not root:
        return "installed"
    norm = root.replace(os.sep, "/")
    if "/adamsville-suite/" in norm and "/updates/" in norm:
        return "staged"
    if norm.startswith("/usr/share/") or \
            norm.startswith("/usr/local/share/"):
        return "installed"
    return "custom"


def _device_string():
    """OS + Python only — the game's Device answer carries label +
    platform; editors carry the platform facts that matter for
    reproducing a report, nothing identifying."""
    try:
        return "%s · Python %s" % (platform.system(),
                                   platform.python_version())
    except Exception:
        return "unknown"


def _iso(ts):
    """UTC ISO timestamp, second precision."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

def init(slug, app_version, data_versions=None, endpoint=None,
         transport=None):
    """Configure the reporter for this process. Call once, early.

    slug:          the app's channel slug ("map-editor", ...).
    app_version:   the RUNNING payload's version (when a staged
                   payload is live, its app.py holds that version).
    data_versions: optional {name: version} for the data in play
                   (map/ui/vehicles versions, zone stamps, ...).
    endpoint:      override the form URL (tests/capture only).
    transport:     injectable sender fn(url, body_bytes) -> bool
                   (tests only; production uses the real POST).

    Never raises. Safe to call again (reconfigures + keeps queue).
    """
    try:
        with _LOCK:
            _STATE["slug"] = str(slug)
            _STATE["version"] = str(app_version or "")
            _STATE["source"] = _detect_source()
            _STATE["session"] = uuid.uuid4().hex[:6]
            _STATE["started_at"] = time.time()
            _STATE["data_versions"] = dict(data_versions or {})
            if endpoint:
                _STATE["endpoint"] = endpoint
            if transport is not None:
                _STATE["transport"] = transport
            _STATE["queue_path"] = _queue_path(slug)
            _STATE["ready"] = True
            _load_queue_locked()
    except Exception:
        pass


def set_data_versions(data_versions):
    """Update the data-version set mid-session (e.g. after a map
    download lands). Merged into every later report."""
    try:
        with _LOCK:
            _STATE["data_versions"].update(dict(data_versions or {}))
    except Exception:
        pass


def session_start():
    """Queue the session-start report (kind "session-start")."""
    note("session-start", "session started")


def session_end(summary=None):
    """Queue the session summary and make one bounded attempt to
    deliver everything outstanding before the app closes.

    The summary carries the session's wall-clock duration, how
    many reports were delivered, and how many the throttle
    dropped — the shape of the game's automatic Stats report.
    """
    try:
        started = _STATE.get("started_at") or time.time()
        fields = {"duration_s": int(time.time() - started),
                  "sent": _STATE.get("sent", 0),
                  "dropped": _STATE.get("dropped", 0),
                  "queued": len(_STATE.get("queue") or [])}
        note("session", summary or "session ended", **fields)
        # Bounded final flush: try, but never hold the app open.
        thread = _kick_flush()
        if thread is not None:
            thread.join(timeout=2.0)
    except Exception:
        pass


def is_ready():
    """True when init() has configured this process's reporter.

    The updater consults this before filing a refused-update
    report: when the app has already initialised reporting it
    files under the app's own session; only when nothing has
    initialised it yet does the updater init on the app's behalf.
    Never raises."""
    try:
        with _LOCK:
            return bool(_STATE["ready"])
    except Exception:
        return False


def status():
    """{"queued", "sent", "dropped", "source", "session"} — for
    About surfaces and harnesses. Never raises."""
    try:
        with _LOCK:
            return {"queued": len(_STATE["queue"]),
                    "sent": _STATE["sent"],
                    "dropped": _STATE["dropped"],
                    "source": _STATE["source"],
                    "session": _STATE["session"]}
    except Exception:
        return {"queued": 0, "sent": 0, "dropped": 0,
                "source": "unknown", "session": ""}


# ---------------------------------------------------------------------------
# Reporting — the public verbs
# ---------------------------------------------------------------------------

def note(kind, msg, where=None, **fields):
    """Queue one report. kind is a short slug ("timing", "error",
    "save", "session", ...); msg a one-line human summary; fields
    ride as key=value lines. Throttled per the module doctrine.
    Never raises, never blocks."""
    try:
        _enqueue(str(kind), str(msg), where, fields)
    except Exception:
        pass


def error(kind, exc, context=None, where=None):
    """Queue an exception report: the exception type + message and
    the last few traceback frames ride the block, so a crash in
    Joshua's hands carries its own evidence home."""
    try:
        tb = "".join(traceback.format_exception(
            type(exc), exc, getattr(exc, "__traceback__", None)))
        tail = "\n".join(tb.strip().splitlines()[-6:])
        msg = "%s: %s" % (type(exc).__name__, exc)
        if context:
            msg = "%s (%s)" % (msg, context)
        _enqueue(str(kind), msg, where, {"traceback_tail": tail})
    except Exception:
        pass


class OperationTimer:
    """Context manager for OPERATION TIMINGS — the heavy-operation
    durations whose absence once forced timestamp archaeology:

        with reporting.operation("delete", pieces=18) as op:
            ... delete ...
            op.set(roads_changed=18)     # optional extra fields

    On exit it queues a "timing" report: op=<label>, dur_ms=<wall
    clock>, plus the given fields. If the block raised, the report
    still fires and carries error=<type>. Never raises itself.
    """

    def __init__(self, label, kind="timing", **fields):
        self.label = str(label)
        self.kind = str(kind)
        self.fields = dict(fields)
        self._t0 = None

    def set(self, **fields):
        """Add/overwrite fields before the report fires."""
        self.fields.update(fields)
        return self

    def __enter__(self):
        self._t0 = time.monotonic()
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            dur_ms = int((time.monotonic() - self._t0) * 1000)
            fields = dict(self.fields)
            fields["op"] = self.label
            fields["dur_ms"] = dur_ms
            msg = "%s completed" % self.label
            if exc is not None:
                fields["error"] = exc_type.__name__ if exc_type \
                    else "error"
                msg = "%s failed" % self.label
            note(self.kind, msg, **fields)
        except Exception:
            pass
        return False  # never swallow the block's own exception


def operation(label, kind="timing", **fields):
    """Start an OperationTimer (see its docstring)."""
    return OperationTimer(label, kind=kind, **fields)


# ---------------------------------------------------------------------------
# Queue + throttle + delivery (all internal, all fail-open)
# ---------------------------------------------------------------------------

def _throttled_locked(kind, msg, now):
    """True when this report is throttled away (and count it)."""
    key = (kind, msg)
    last = _STATE["dedupe"].get(key)
    if last is not None and now - last < DEDUPE_WINDOW_S:
        _STATE["dropped"] += 1
        return True
    times = [t for t in _STATE["kind_times"].get(kind, [])
             if now - t < KIND_WINDOW_S]
    if len(times) >= KIND_CAP:
        _STATE["dedupe"][key] = now
        _STATE["kind_times"][kind] = times
        _STATE["dropped"] += 1
        return True
    _STATE["dedupe"][key] = now
    times.append(now)
    _STATE["kind_times"][kind] = times
    return False


def _build_body(kind, msg, where, fields, now):
    """One queued report = one form body (entry map -> strings),
    its "What happened?" value the structured block."""
    lines = ["%s: %s" % (kind, msg)]
    lines.append("app=%s" % _STATE["slug"])
    lines.append("version=%s" % _STATE["version"])
    lines.append("source=%s" % _STATE["source"])
    lines.append("session=%s" % _STATE["session"])
    lines.append("ts=%s" % _iso(now))
    for key in sorted(fields):
        value = fields[key]
        if isinstance(value, str) and "\n" in value:
            # Multi-line values (traceback tails) go last, as-is,
            # under their own header so line parsing stays clean.
            continue
        lines.append("%s=%s" % (key, value))
    if _STATE["data_versions"]:
        dv = " ".join("%s=%s" % (k, _STATE["data_versions"][k])
                      for k in sorted(_STATE["data_versions"]))
        lines.append("data: %s" % dv)
    for key in sorted(fields):
        value = fields[key]
        if isinstance(value, str) and "\n" in value:
            lines.append("%s:" % key)
            lines.append(value)
    return {
        ENTRY_TYPE: REPORT_TYPE,
        ENTRY_MESSAGE: "\n".join(lines),
        ENTRY_VERSION: "%s %s" % (_STATE["slug"], _STATE["version"]),
        ENTRY_WHERE: where or _STATE["slug"] or "",
        ENTRY_DEVICE: _device_string(),
    }


def _enqueue(kind, msg, where, fields):
    """Throttle, build, persist, and kick a flush. Lock-held parts
    are short; network I/O never happens under the lock."""
    now = time.time()
    with _LOCK:
        if not _STATE["ready"]:
            return
        if _throttled_locked(kind, msg, now):
            return
        body = _build_body(kind, msg, where, fields, now)
        _STATE["queue"].append(body)
        while len(_STATE["queue"]) > QUEUE_CAP:
            _STATE["queue"].pop(0)
            _STATE["dropped"] += 1
        _save_queue_locked()
    _kick_flush()


def _load_queue_locked():
    """Load any queue a previous run left undelivered."""
    try:
        path = _STATE["queue_path"]
        if path and os.path.isfile(path):
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                _STATE["queue"] = [b for b in data
                                    if isinstance(b, dict)]
    except Exception:
        pass


def _save_queue_locked():
    """Persist the queue atomically (tmp + rename)."""
    try:
        path = _STATE["queue_path"]
        if not path:
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp-%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_STATE["queue"], fh)
        os.replace(tmp, path)
    except Exception:
        pass


def _post(url, body):
    """One form POST; True when the endpoint accepted it (HTTP
    200). The injected transport (tests) replaces the real POST."""
    transport = _STATE.get("transport")
    if transport is not None:
        try:
            return bool(transport(url, body))
        except Exception:
            return False
    try:
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type":
                     "application/x-www-form-urlencoded",
                     "User-Agent": "adamsville-editor-reporting/1.0"})
        with urllib.request.urlopen(req, timeout=FLUSH_TIMEOUT_S) \
                as resp:
            resp.read()
            return resp.getcode() == 200
    except Exception:
        return False


def _flush_once():
    """Deliver queued reports oldest-first until one fails (then
    stop — the rest wait for the next kick, so an offline laptop
    costs one tiny timeout, not a queue's worth)."""
    while True:
        with _LOCK:
            if not _STATE["queue"]:
                return
            body = _STATE["queue"][0]
            url = _STATE["endpoint"]
        data = urllib.parse.urlencode(body).encode("utf-8")
        if not _post(url, data):
            return
        with _LOCK:
            # Remove exactly the item we sent (it is still first
            # unless a same-process enqueue raced us — it cannot
            # remove from the front, only append/pop-oldest under
            # cap pressure; identity-check to be safe).
            if _STATE["queue"] and _STATE["queue"][0] is body:
                _STATE["queue"].pop(0)
            elif body in _STATE["queue"]:
                _STATE["queue"].remove(body)
            _STATE["sent"] += 1
            _save_queue_locked()


def _kick_flush():
    """Start the flusher thread if it isn't already running.
    Returns the thread (or the running one), else None."""
    try:
        with _LOCK:
            if _STATE["flush_running"]:
                return None
            _STATE["flush_running"] = True

        def run():
            try:
                _flush_once()
            except Exception:
                pass
            finally:
                with _LOCK:
                    _STATE["flush_running"] = False

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread
    except Exception:
        try:
            with _LOCK:
                _STATE["flush_running"] = False
        except Exception:
            pass
        return None


def flush():
    """Ask for a delivery attempt now (e.g. when the app knows the
    network just came back). Fire-and-forget; never raises."""
    _kick_flush()
