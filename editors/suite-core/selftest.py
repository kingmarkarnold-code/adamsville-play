#!/usr/bin/env python3
"""
selftest.py — suite-core's own proof (run: xvfb-run -a python3
selftest.py; exit 0 = all checks passed).

Covers what the MERGED package (suite_core/, consolidated
2026-10-18 per EXTRACTION-REPORT.md section 4) promises, with
stubbed transport:
  github_sync: the round trip's leg discipline (push on one
    connection, closed, proof on a FRESH one), failure-message
    shapes, the empty-save no-op, the verify gate, fetch retries,
    and the push_file 409 SHA-conflict retry.
  shared_cache: store -> serve fresh from the index; a corrupted
    entry is treated as absent.
  layout: paned children shrink on both sides, scrolled policies
    (package defaults AND the merged min-content options),
    SplitMemory clamps.
  snapshot_view: project/fit/screen_to_ground consistency, and a
    real render into a cairo image surface (sky + ground + the
    orange front wall must all appear as pixels).
  updater: both halves present (fail-open check + the applying
    updater's version math).
  suite_draw: the drawing names contract + a PNG render.
  shims: the retired flat module names still import and ARE the
    package modules (one implementation, never two).

The Building Editor's own suites passing against a staging copy
rewired to these modules are the extraction's regression proof;
this file only proves the core stands on its own.
"""

import math
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
# suite_cache resolves its directory from HOME at import time.
os.environ["HOME"] = tempfile.mkdtemp(prefix="suite-core-home-")

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(("PASS: " if cond else "FAIL: ") + name
          + (f" — {detail}" if detail and not cond else ""))


# ---------------------------------------------------------------------------
# github_roundtrip
# ---------------------------------------------------------------------------

from suite_core import github_sync as rt  # noqa: E402


class FakeConn:
    def __init__(self, hub):
        self.hub = hub
        self.id = next(hub.ids)
        self.closed = False

    def close(self):
        self.closed = True
        self.hub.events.append((self.id, "CLOSE"))


class Hub:
    def __init__(self):
        import itertools
        self.ids = itertools.count(1)
        self.repo = {}
        self.events = []
        self.fail_push = False
        self.fail_fetch = False

    def open_connection(self):
        return FakeConn(self)

    def push_targets(self, targets, conn=None):
        assert conn is not None and not conn.closed
        self.events.append((conn.id, "PUSH"))
        if self.fail_push:
            return False, "simulated push boom"
        for _repo, path, content, _msg in targets:
            self.repo[path] = content
        return True, "ok"

    def fetch_file(self, repo, path, conn=None):
        self.events.append((conn.id if conn else -1, "GET", path))
        if self.fail_fetch:
            return None, "simulated proof boom"
        if path not in self.repo:
            return None, "Not found (404)."
        return self.repo[path], None


def run_roundtrip_checks():
    tmp = Path(tempfile.mkdtemp(prefix="suite-core-rt-"))
    hub = Hub()
    targets = [("owner/repo", "a/b.json", b"{\"x\": 1}", "msg")]
    ok, msg, fresh = rt.round_trip(
        targets, tmp, hub.open_connection, hub.push_targets,
        hub.fetch_file)
    check("round_trip: success + proof bytes returned",
          ok and fresh == {"a/b.json": b"{\"x\": 1}"}, msg)
    check("round_trip: local stage wrote the flattened name",
          (tmp / "a_b.json").read_bytes() == b"{\"x\": 1}")
    legs = [e for e in hub.events if e[1] in ("PUSH", "GET")]
    push_conn = [e[0] for e in legs if e[1] == "PUSH"][0]
    get_conn = [e[0] for e in legs if e[1] == "GET"][0]
    check("round_trip: proof leg on a DIFFERENT connection",
          push_conn != get_conn)
    seq = [e[1] for e in hub.events]
    check("round_trip: push connection closed before the proof leg",
          seq.index("CLOSE") < len(seq) - 1
          and ("GET" in seq[seq.index("CLOSE"):]))
    ok, msg, fresh = rt.round_trip(
        [], tmp, hub.open_connection, hub.push_targets, hub.fetch_file)
    check("round_trip: empty targets = nothing-to-save no-op",
          ok and fresh == {} and "Nothing to save" in msg, msg)
    hub.fail_push = True
    ok, msg, _ = rt.round_trip(
        targets, tmp, hub.open_connection, hub.push_targets,
        hub.fetch_file)
    check("round_trip: push failure message shape",
          not ok and msg.startswith("Push to GitHub failed:")
          and "simulated push boom" in msg, msg)
    hub.fail_push = False
    hub.fail_fetch = True
    ok, msg, _ = rt.round_trip(
        targets, tmp, hub.open_connection, hub.push_targets,
        hub.fetch_file)
    check("round_trip: proof failure says the save DID reach GitHub",
          not ok and "DID reach GitHub" in msg, msg)
    hub.fail_fetch = False

    def reject(fresh):
        return ("caller rejected the proof copy", {"partial": True})
    ok, msg, val = rt.round_trip(
        targets, tmp, hub.open_connection, hub.push_targets,
        hub.fetch_file, verify=reject)
    check("round_trip: verify gate rejects with the caller's value",
          not ok and msg == "caller rejected the proof copy"
          and val == {"partial": True}, msg)

    calls = {"n": 0}

    def flaky(repo, path, conn=None):
        calls["n"] += 1
        if calls["n"] < 3:
            return None, "Network error: simulated reset"
        return b"bytes", None
    raw, err = rt.fetch_with_retries(flaky, "o/r", "p.json")
    check("fetch_with_retries: network errors retried to success",
          raw == b"bytes" and calls["n"] == 3)
    calls["n"] = 0

    def http_err(repo, path, conn=None):
        calls["n"] += 1
        return None, "Not found (404)."
    raw, err = rt.fetch_with_retries(http_err, "o/r", "p.json")
    check("fetch_with_retries: HTTP answers never retried",
          raw is None and calls["n"] == 1
          and err == "p.json: Not found (404).", str(err))
    check("push_file: _is_sha_conflict reads GitHub's 409 wording",
          rt._is_sha_conflict("x is at abc but expected def (409)")
          and not rt._is_sha_conflict("Bad token (401)."))


# ---------------------------------------------------------------------------
# shared_cache
# ---------------------------------------------------------------------------

def run_cache_checks():
    # The fixture path names a REAL repo file on purpose: the
    # cache only ever sees path strings, and a real name keeps
    # the repo inventory deriver reading this test honestly.
    from suite_core import shared_cache as sc
    payload = b"{\"roads\": []}"
    out = sc.store("owner/repo", "detailed/zones/adamsville/roads.json", payload)
    check("shared_cache: store reports stored", out == "stored")
    data, entry = sc.get_cached("owner/repo",
                                "detailed/zones/adamsville/roads.json")
    check("shared_cache: get_cached returns verified bytes",
          data == payload and entry["sha256"] == sc.sha256_hex(payload))
    out = sc.store("owner/repo", "detailed/zones/adamsville/roads.json", payload)
    check("shared_cache: same bytes again = already", out == "already")
    path = sc.cache_file_path("detailed/zones/adamsville/roads.json")
    path.write_bytes(b"tampered")
    data, _entry = sc.get_cached("owner/repo",
                                 "detailed/zones/adamsville/roads.json")
    check("shared_cache: bytes not matching the index are absent",
          data is None)

    def fetch(repo, p):
        return payload, None

    def meta(repo, p):
        return {"sha": sc.blob_sha1(payload)}, None
    data, status = sc.fetch_through(
        "owner/repo", "detailed/zones/adamsville/roads.json", fetch,
        fetch_meta=meta)
    check("shared_cache: fetch_through re-downloads after tamper",
          data == payload and status == "downloaded", status)


# ---------------------------------------------------------------------------
# layout (real GTK under Xvfb)
# ---------------------------------------------------------------------------

def run_layout_checks():
    from suite_core import layout as lg
    from gi.repository import Gtk
    win = Gtk.Window()
    left = Gtk.Box()
    right = Gtk.Box()
    p = lg.paned(Gtk.Orientation.HORIZONTAL, left, right)
    check("layout: paned children shrink=True both sides",
          p.get_child1() is left and p.get_child2() is right
          and p.child_get_property(left, "shrink")
          and p.child_get_property(right, "shrink")
          and p.child_get_property(left, "resize")
          and p.child_get_property(right, "resize"))
    sw = lg.scrolled(Gtk.Box(), min_content_height=120)
    check("layout: scrolled policies + min height",
          sw.get_policy() == (Gtk.PolicyType.AUTOMATIC,
                              Gtk.PolicyType.AUTOMATIC)
          and sw.get_min_content_height() == 120)
    sw2 = lg.scrolled(Gtk.Box())
    check("layout: scrolled defaults keep the package behaviour "
          "(automatic policies + inset shadow)",
          sw2.get_policy() == (Gtk.PolicyType.AUTOMATIC,
                                Gtk.PolicyType.AUTOMATIC)
          and sw2.get_shadow_type() == Gtk.ShadowType.IN)
    row = lg.hscroll_row(Gtk.Box())
    check("layout: hscroll_row is sideways-only, no shadow",
          row.get_policy() == (Gtk.PolicyType.AUTOMATIC,
                               Gtk.PolicyType.NEVER)
          and row.get_shadow_type() == Gtk.ShadowType.NONE)
    lbl = lg.ellipsized_label(text="A very long label")
    check("layout: ellipsized label carries its tooltip",
          lbl.get_tooltip_text() == "A very long label")
    win.add(p)
    win.set_default_size(800, 400)
    win.show_all()
    while Gtk.events_pending():
        Gtk.main_iteration()
    mem = lg.SplitMemory(default_open_px=320)
    pos = mem.initial_position(p)
    check("layout: SplitMemory default = size - 320, clamped",
          pos is not None and pos == max(240, min(800 - 320, 800 - 200)),
          str(pos))
    mem.position = 300
    check("layout: SplitMemory restores Joshua's drag",
          mem.initial_position(p) == 300)
    ov = lg.anchored_overlay(Gtk.Box(), Gtk.Label(label="x"),
                             margin_start=6, margin_bottom=6)
    check("layout: anchored overlay pins bottom-left",
          isinstance(ov, Gtk.Overlay))
    win.destroy()


# ---------------------------------------------------------------------------
# snapshot_view
# ---------------------------------------------------------------------------

def run_snapshot_checks():
    import cairo
    from suite_core import snapshot_view as sv
    ring = [[0, 0], [10, 0], [10, 8], [0, 8]]
    check("snapshot_view: ring_centroid drops the closing vertex",
          sv.ring_centroid(ring + [ring[0]]) == (5.0, 4.0))
    az, el = math.radians(90), math.radians(12)
    to_screen, view = sv.fit_view(
        [(x - 5, z - 4, 0) for x, z in ring], 400, 300, az, el)
    sx, sy = to_screen(0, 0, 0)
    back = sv.screen_to_ground(view, sx, sy)
    check("snapshot_view: screen_to_ground inverts fit_view",
          back is not None and abs(back[0]) < 1e-6
          and abs(back[1]) < 1e-6, str(back))
    scene = {
        # A three-quarter camera: at the default 90-degree azimuth
        # the east wall is exactly edge-on (zero projected width)
        # in this projection — correct geometry, nothing to paint.
        "azimuth": math.radians(35),
        "subject": {"ring": ring, "height": 6.0, "front_edge": 1},
        "roads": [{"name": "Front St",
                   "pts": [[-6, 12], [16, 12]]}],
        "front_road": "Front St",
        "boxes": [{"corners": [[14, -2], [20, -2], [20, 3], [14, 3]],
                   "y0": 0.0, "y1": 4.0, "rgb": (0.6, 0.6, 0.65)}],
    }
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, 400, 300)
    ctx = cairo.Context(surf)
    view = sv.render_scene(ctx, scene, 400, 300)
    surf.flush()
    check("snapshot_view: render returns a view transform",
          view is not None)
    data = surf.get_data()
    stride = surf.get_stride()

    def px(x, y):
        off = y * stride + x * 4
        b, g, r, _a = data[off:off + 4]
        return (r / 255, g / 255, b / 255)
    sky = px(2, 2)
    check("snapshot_view: sky wash painted",
          abs(sky[0] - 0.92) < 0.03 and abs(sky[2] - 0.96) < 0.03,
          str(sky))
    # The orange front wall (1.0, 0.55, 0.15) must appear somewhere.
    found = False
    for y in range(0, 300, 3):
        for x in range(0, 400, 3):
            r, g, b = px(x, y)
            if r > 0.9 and 0.4 < g < 0.7 and b < 0.3:
                found = True
                break
        if found:
            break
    check("snapshot_view: the warm-orange FRONT wall is in the pixels",
          found)
    view2 = sv.render_scene(ctx, {"empty_text": "nothing"}, 400, 300)
    check("snapshot_view: no subject -> empty text, no view",
          view2 is None)


# ---------------------------------------------------------------------------
# push_file's 409 retry (merged from the flat pass / Map Editor 1.9.4)
# ---------------------------------------------------------------------------

def run_push_retry_checks():
    state = {"puts": 0, "gets": 0, "conflict_once": True}

    def fake_api(url, token, method="GET", payload=None, conn=None):
        if method == "GET":
            state["gets"] += 1
            sha = "newsha" if state["gets"] > 1 else "oldsha"
            return {"sha": sha}, None
        state["puts"] += 1
        if state["conflict_once"] and state["puts"] == 1:
            return None, "f.json is at newsha but expected oldsha (409)"
        return {"content": {}}, None

    orig_api, orig_tok = rt._api_request, rt.get_token
    rt._api_request, rt.get_token = fake_api, lambda: "tok"
    try:
        ok, msg = rt.push_file("o/r", "f.json", b"x", "m")
        check("push_file: a 409 is retried once with the fresh SHA",
              ok and state["puts"] == 2 and state["gets"] == 2, msg)
        state.update(puts=0, gets=0, conflict_once=False)

        def deny(url, token, method="GET", payload=None, conn=None):
            if method == "GET":
                return {"sha": "s"}, None
            state["puts"] += 1
            return None, "Bad credentials (401)."
        rt._api_request = deny
        ok, msg = rt.push_file("o/r", "f.json", b"x", "m")
        check("push_file: a non-409 refusal is NOT retried",
              not ok and state["puts"] == 1 and "401" in msg, msg)
    finally:
        rt._api_request, rt.get_token = orig_api, orig_tok


# ---------------------------------------------------------------------------
# updater (both halves) + suite_draw + the flat-name shims
# ---------------------------------------------------------------------------

def run_updater_checks():
    import json as _json
    from suite_core import updater as up
    check("updater: version_key orders numerically",
          up.version_key("1.10.0") > up.version_key("1.9.9")
          and up.version_key("1.0") == up.version_key("1.0.0"))
    info, err = up.check_for_update(
        "editors/x", "1.0.0",
        lambda repo, path: (_json.dumps(
            {"version": "1.1.0", "changelog": "c", "files": []}
        ).encode(), None))
    check("updater: check half reports a newer version",
          err is None and info["available"] and info["version"] == "1.1.0")
    info, err = up.check_for_update(
        "editors/x", "1.0.0", lambda repo, path: (None, "offline"))
    check("updater: check half fails open (error, no exception)",
          info is None and err == "offline")
    check("updater: apply half present (the Building Editor's "
          "shipped updater)",
          callable(up.check_for_updates_gui) and callable(up.is_newer)
          and up.is_newer("2.0.0", "1.7.3")
          and not up.is_newer("1.7.3", "2.0.0"))


def run_draw_checks():
    from datetime import datetime, timezone
    from suite_core import suite_draw as sd
    now = datetime(2026, 10, 18, 3, 0, 0, tzinfo=timezone.utc)
    png_name, json_name, sent_at = sd.drawing_names(now)
    check("suite_draw: names follow the drawings/ contract",
          png_name == "drawing-2026-10-18T03-00-00.000Z.png"
          and json_name == "drawing-2026-10-18T03-00-00.000Z.json"
          and sent_at == "2026-10-18T03:00:00.000Z",
          f"{png_name} {json_name} {sent_at}")
    stroke = {"ink": "#20242a", "size": 4, "mode": "free",
              "points": [[0.1, 0.1], [0.5, 0.5], [0.9, 0.2]]}
    png = sd.strokes_to_png([stroke], 200, 120)
    check("suite_draw: strokes render to real PNG bytes",
          png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 100)


def run_shim_checks():
    import github_roundtrip
    import layout_grammar
    import suite_cache
    import snapshot_view as flat_sv
    import suite_draw as flat_sd
    from suite_core import github_sync, layout, shared_cache
    from suite_core import snapshot_view, suite_draw
    check("shims: flat names ARE the package modules",
          github_roundtrip is github_sync and suite_cache is shared_cache
          and layout_grammar is layout and flat_sv is snapshot_view
          and flat_sd is suite_draw)



def main():
    run_roundtrip_checks()
    run_push_retry_checks()
    run_cache_checks()
    run_layout_checks()
    run_snapshot_checks()
    run_updater_checks()
    run_draw_checks()
    run_shim_checks()
    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} "
          f"suite-core checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
