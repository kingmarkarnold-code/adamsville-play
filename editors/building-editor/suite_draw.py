#!/usr/bin/env python3
"""
suite_draw.py — Draw for Mollie, the Python suite-core citizen.

The desktop mirror of the suite's web drawing surface (SuiteDraw,
www/core/suite-draw.js in the Suite APK — the reference
implementation, v0.1.4). The adoption contract (suite README,
"Draw for Mollie — the adoption contract"): every editor hosts
this same surface as an "Export Drawing to Mollie" action; a
drawing lands in the repo's drawings/ folder as
drawing-<ISO timestamp>.png with a same-timestamp .json sidecar
{caption, from, appVersion, sentAt}; the send follows the suite
save law — push on one connection, CLOSE it, re-download on a
fresh connection, byte-compare, and only then say "sent".

The surface itself has no GitHub and no tokens (like SuiteDraw):
it draws, holds an optional caption, and hands back PNG bytes.
The host wires the Send button to send_drawing() below with its
own github_sync callables.

Tool set (mirrors SuiteDraw exactly):
  * five inks — Ink, Orange, Blue, Green, Red;
  * four line sizes — 2, 4, 8, 14 px (fine to thick);
  * three line modes per stroke — Free (follows the pointer, with
    midpoint-quadratic smoothing), Straight (press–drag–release,
    live preview), Curve (a rough drag rendered as a clean
    midpoint-quadratic spline — the french curve);
  * eraser (paper colour at twice the chosen width);
  * Undo (15 states) and Clear;
  * the tools palette COLLAPSES to an edge tab the moment a
    stroke begins (menus yield — while he draws, the canvas owns
    the space) and returns when the stroke ends.
Mode, size and colour freeze at stroke start, as in SuiteDraw.

Points are stored NORMALISED (fractions of the surface), so a
window resize never distorts a drawing, and the exported PNG is
always EXPORT_W x EXPORT_H.
"""

import json
from datetime import datetime, timezone

import cairo
import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk  # noqa: E402

# The repo every suite drawing lands in (the send callables the
# host passes in already target it; named here for the sidecar
# paths so this module stands alone in the suite core).
REPO = "kingmarkarnold-code/adamsville-play"
DRAWINGS_DIR = "drawings"

PAPER = "#fdfdf8"
INKS = [
    ("Ink", "#23262d"),
    ("Orange", "#e07b2a"),
    ("Blue", "#2a6fe0"),
    ("Green", "#2e9e5b"),
    ("Red", "#d23b3b"),
]
SIZES = [2, 4, 8, 14]          # px at export scale — fine to thick
MODES = ["free", "straight", "curve"]
MODE_LABELS = {"free": "Free draw", "straight": "Straight",
               "curve": "Curve"}
EXPORT_W, EXPORT_H = 960, 720  # the exported PNG's size
UNDO_STATES = 15


def _hex_rgb(hex_color):
    """'#rrggbb' -> (r, g, b) floats for cairo."""
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0,
            int(h[4:6], 16) / 255.0)


def _quad(ctx, p0, q, p1):
    """Quadratic segment (control q) as a cairo cubic: cairo has
    no quadratic primitive; the standard conversion is
    C1 = P0 + 2/3 (Q - P0), C2 = P1 + 2/3 (Q - P1)."""
    c1 = (p0[0] + 2.0 / 3.0 * (q[0] - p0[0]),
          p0[1] + 2.0 / 3.0 * (q[1] - p0[1]))
    c2 = (p1[0] + 2.0 / 3.0 * (q[0] - p1[0]),
          p1[1] + 2.0 / 3.0 * (q[1] - p1[1]))
    ctx.curve_to(c1[0], c1[1], c2[0], c2[1], p1[0], p1[1])


def stroke_path(ctx, stroke, w, h):
    """
    Build (but do not stroke/fill) the cairo path of one stroke at
    pixel size (w, h). Points are normalised, so they scale by
    (w, h). Straight = the segment; Free and Curve both render as
    the midpoint-quadratic spline through the sampled points
    (Free's smoothing and Curve's spline are the same maths in
    SuiteDraw — Free applies it incrementally, Curve to the whole
    drag; the finished paths agree). A single point is a dot.
    """
    pts = [(x * w, y * h) for x, y in stroke["points"]]
    if len(pts) == 1:
        r = stroke["size"] / 2.0
        ctx.new_path()
        ctx.arc(pts[0][0], pts[0][1], r, 0, 2 * 3.141592653589793)
        return "fill"
    ctx.new_path()
    ctx.move_to(*pts[0])
    if stroke["mode"] == "straight" or len(pts) == 2:
        ctx.line_to(*pts[-1])
        return "stroke"
    # Midpoint-quadratic spline: for each interior point, a
    # quadratic whose control is the point itself and whose end is
    # the midpoint to the next point, closing on the last point.
    for i in range(1, len(pts) - 1):
        mid = ((pts[i][0] + pts[i + 1][0]) / 2.0,
               (pts[i][1] + pts[i + 1][1]) / 2.0)
        _quad(ctx, ctx.get_current_point(), pts[i], mid)
    ctx.line_to(*pts[-1])
    return "stroke"


def render_strokes(ctx, strokes, w, h):
    """Paint a stroke list onto a cairo context at size (w, h):
    paper first, then every stroke in order."""
    r, g, b = _hex_rgb(PAPER)
    ctx.set_source_rgb(r, g, b)
    ctx.paint()
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    for s in strokes:
        colour = PAPER if s.get("eraser") else s["ink"]
        r, g, b = _hex_rgb(colour)
        ctx.set_source_rgb(r, g, b)
        width = s["size"] * (2 if s.get("eraser") else 1)
        ctx.set_line_width(width)
        if stroke_path(ctx, s, w, h) == "fill":
            ctx.fill()
        else:
            ctx.stroke()


def strokes_to_png(strokes, w=EXPORT_W, h=EXPORT_H):
    """Render a stroke list to PNG bytes (the export + the gate's
    headless path — no GTK needed beyond cairo)."""
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, h)
    ctx = cairo.Context(surface)
    render_strokes(ctx, strokes, w, h)
    surface.flush()
    import io
    buf = io.BytesIO()
    surface.write_to_png(buf)
    return buf.getvalue()


class DrawSurface(Gtk.DrawingArea):
    """
    The sketch canvas. Pointer input via button-press / motion /
    release (mouse, finger or stylus — GTK delivers all three the
    same way). Emits no signals of its own; the host (DrawPanel)
    reads strokes / is_blank() / to_png_bytes().
    """

    def __init__(self):
        super().__init__()
        self.set_hexpand(True)
        self.set_vexpand(True)
        self.set_size_request(320, 240)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK
                        | Gdk.EventMask.BUTTON_RELEASE_MASK
                        | Gdk.EventMask.POINTER_MOTION_MASK)
        self.connect("draw", self._on_draw)
        self.connect("button-press-event", self._on_press)
        self.connect("motion-notify-event", self._on_motion)
        self.connect("button-release-event", self._on_release)
        # Tool state (frozen into each stroke at its start).
        self.ink = INKS[0][1]
        self.size = SIZES[1]
        self.mode = "free"
        self.eraser = False
        # The drawing: finished strokes + the one in progress.
        self.strokes = []
        self._current = None
        self._undo = []          # snapshots of self.strokes

    # -- tools -----------------------------------------------------

    def set_ink(self, hex_color):
        self.ink = hex_color
        self.eraser = False

    def set_size(self, px):
        self.size = px

    def set_mode(self, mode):
        if mode in MODES:
            self.mode = mode

    def set_eraser(self, on):
        self.eraser = bool(on)

    def is_blank(self):
        """True when nothing has been drawn (Send refuses blank
        paper, as in SuiteDraw)."""
        return not self.strokes and self._current is None

    def clear(self):
        self._push_undo()
        self.strokes = []
        self._current = None
        self.queue_draw()

    def undo(self):
        if self._undo:
            self.strokes = self._undo.pop()
            self._current = None
            self.queue_draw()

    def _push_undo(self):
        self._undo.append([dict(s, points=list(s["points"]))
                           for s in self.strokes])
        while len(self._undo) > UNDO_STATES:
            self._undo.pop(0)

    # -- export ------------------------------------------------------

    def to_png_bytes(self):
        return strokes_to_png(self.strokes)

    # -- pointer -----------------------------------------------------

    def _norm(self, event):
        w = max(1, self.get_allocated_width())
        h = max(1, self.get_allocated_height())
        return (min(1.0, max(0.0, event.x / w)),
                min(1.0, max(0.0, event.y / h)))

    def _on_press(self, _widget, event):
        if event.button != 1:
            return False
        self._push_undo()
        self._current = {
            "points": [self._norm(event)],
            "ink": self.ink, "size": self.size,
            "mode": self.mode, "eraser": self.eraser,
        }
        panel = self.get_ancestor(DrawPanel)
        if panel is not None:
            panel.collapse_palette()
        self.queue_draw()
        return True

    def _on_motion(self, _widget, event):
        if self._current is None:
            return False
        pt = self._norm(event)
        pts = self._current["points"]
        if not pts or pts[-1] != pt:
            pts.append(pt)
        self.queue_draw()
        return True

    def _on_release(self, _widget, event):
        if self._current is None:
            return False
        self.strokes.append(self._current)
        self._current = None
        panel = self.get_ancestor(DrawPanel)
        if panel is not None:
            panel.expand_palette()
        self.queue_draw()
        return True

    # -- drawing -------------------------------------------------------

    def _on_draw(self, _widget, ctx):
        w = self.get_allocated_width()
        h = self.get_allocated_height()
        strokes = list(self.strokes)
        if self._current is not None:
            strokes.append(self._current)
        render_strokes(ctx, strokes, w, h)
        return False


class DrawPanel(Gtk.Box):
    """
    The hosted citizen: toolbar (inks, sizes, modes, eraser, undo,
    clear) + caption + the DrawSurface. The palette collapses to a
    slim "Tools" tab while a stroke is in progress (SuiteDraw's
    menus-yield behaviour) and returns when the stroke ends — the
    tab also toggles it manually.
    """

    def __init__(self):
        super().__init__(orientation=Gtk.Orientation.VERTICAL,
                         spacing=4)
        self.surface = DrawSurface()

        # The collapsed-state tab (visible only while collapsed).
        self.tab_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        tab_btn = Gtk.Button(label="▸ Tools")
        tab_btn.set_relief(Gtk.ReliefStyle.NONE)
        tab_btn.connect("clicked", lambda w: self.expand_palette())
        self.tab_bar.pack_start(tab_btn, False, False, 0)
        self.tab_bar.set_no_show_all(True)
        self.tab_bar.hide()
        self.pack_start(self.tab_bar, False, False, 0)

        # -- the palette ------------------------------------------
        self.palette = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                               spacing=4)
        row1 = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                       spacing=4)
        row1.pack_start(Gtk.Label(label="Ink:"), False, False, 0)
        self._ink_btns = {}
        for name, hex_color in INKS:
            btn = Gtk.ToggleButton(label=name)
            btn.connect("toggled", self._on_ink_toggled, hex_color)
            row1.pack_start(btn, False, False, 0)
            self._ink_btns[hex_color] = btn
        self._ink_btns[INKS[0][1]].set_active(True)
        eraser_btn = Gtk.ToggleButton(label="Eraser")
        eraser_btn.connect(
            "toggled", lambda w: self.surface.set_eraser(w.get_active()))
        row1.pack_start(eraser_btn, False, False, 0)
        row1.pack_start(Gtk.Label(label="Size:"), False, False, 6)
        self._size_btns = {}
        for px in SIZES:
            btn = Gtk.ToggleButton(label=str(px))
            btn.connect("toggled", self._on_size_toggled, px)
            row1.pack_start(btn, False, False, 0)
            self._size_btns[px] = btn
        self._size_btns[SIZES[1]].set_active(True)
        self.palette.pack_start(row1, False, False, 0)

        row2 = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                       spacing=4)
        self._mode_btns = {}
        for mode in MODES:
            btn = Gtk.ToggleButton(label=MODE_LABELS[mode])
            btn.connect("toggled", self._on_mode_toggled, mode)
            row2.pack_start(btn, False, False, 0)
            self._mode_btns[mode] = btn
        self._mode_btns["free"].set_active(True)
        undo_btn = Gtk.Button(label="Undo")
        undo_btn.connect("clicked", lambda w: self.surface.undo())
        row2.pack_start(undo_btn, False, False, 6)
        clear_btn = Gtk.Button(label="Clear")
        clear_btn.connect("clicked", lambda w: self.surface.clear())
        row2.pack_start(clear_btn, False, False, 0)
        self.palette.pack_start(row2, False, False, 0)
        self.pack_start(self.palette, False, False, 0)

        self.pack_start(self.surface, True, True, 0)

        cap_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                          spacing=4)
        cap_row.pack_start(Gtk.Label(label="What is this?"),
                           False, False, 0)
        self.caption_entry = Gtk.Entry()
        self.caption_entry.set_placeholder_text(
            "One line for Mollie (optional)")
        cap_row.pack_start(self.caption_entry, True, True, 0)
        self.pack_start(cap_row, False, False, 0)

    # -- palette collapse (menus yield) ------------------------------

    def collapse_palette(self):
        self.palette.hide()
        self.tab_bar.show()

    def expand_palette(self):
        self.tab_bar.hide()
        self.palette.show()

    # -- tool wiring (radio behaviour among the toggle rows) ----------

    def _radio(self, btns, active_btn):
        for btn in btns.values():
            if btn is not active_btn and btn.get_active():
                btn.set_active(False)

    def _on_ink_toggled(self, btn, hex_color):
        if btn.get_active():
            self._radio(self._ink_btns, btn)
            self.surface.set_ink(hex_color)

    def _on_size_toggled(self, btn, px):
        if btn.get_active():
            self._radio(self._size_btns, btn)
            self.surface.set_size(px)

    def _on_mode_toggled(self, btn, mode):
        if btn.get_active():
            self._radio(self._mode_btns, btn)
            self.surface.set_mode(mode)

    # -- host conveniences --------------------------------------------

    def is_blank(self):
        return self.surface.is_blank()

    def caption(self):
        return self.caption_entry.get_text().strip()

    def to_png_bytes(self):
        return self.surface.to_png_bytes()


# ---------------------------------------------------------------------------
# The send (the suite save law, bytes variant)
# ---------------------------------------------------------------------------

def drawing_names(now=None):
    """
    The file names one send uses: drawing-<ISO timestamp>.png and
    the same-timestamp .json sidecar. `now` is injectable for the
    harness. Returns (png_name, json_name, sent_at_iso).
    """
    now = now or datetime.now(timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H-%M-%S.") \
        + f"{now.microsecond // 1000:03d}Z"
    sent_at = now.strftime("%Y-%m-%dT%H:%M:%S.") \
        + f"{now.microsecond // 1000:03d}Z"
    return (f"drawing-{stamp}.png", f"drawing-{stamp}.json", sent_at)


def send_drawing(png_bytes, caption, from_name, app_version,
                 open_connection, push_targets, fetch_file,
                 now=None):
    """
    Push one drawing + its sidecar by the suite save law: both
    files on ONE connection, which is then CLOSED; both
    re-downloaded on a FRESH connection and byte-compared; "sent"
    is said only when the proof copies match. A retry after a
    failure re-uses the same timestamp (pass the same `now`), so a
    drawing is never duplicated by retrying.

    open_connection / push_targets / fetch_file are github_sync's
    callables, injected so the harness can drive this with a
    stubbed GitHub. Returns (ok, message, png_repo_path_or_None).
    """
    png_name, json_name, sent_at = drawing_names(now)
    png_path = f"{DRAWINGS_DIR}/{png_name}"
    json_path = f"{DRAWINGS_DIR}/{json_name}"
    sidecar = json.dumps({
        "caption": caption or "",
        "from": from_name,
        "appVersion": app_version,
        "sentAt": sent_at,
    }, indent=1).encode()
    targets = [
        (REPO, png_path, png_bytes,
         f"Draw for Mollie: drawing from {from_name}"),
        (REPO, json_path, sidecar,
         f"Draw for Mollie: sidecar for {png_name}"),
    ]
    push_conn = open_connection()
    try:
        ok, msg = push_targets(targets, conn=push_conn)
    finally:
        try:
            push_conn.close()
        except Exception:
            pass
    if not ok:
        return False, f"Push to GitHub failed: {msg}", None
    proof_conn = open_connection()
    try:
        for path, content in ((png_path, png_bytes),
                              (json_path, sidecar)):
            raw, err = fetch_file(REPO, path, conn=proof_conn)
            if err is not None or raw is None:
                return False, (
                    f"the drawing reached GitHub but downloading "
                    f"the proof copy back failed: {err} — the "
                    f"drawing is still on screen; send again to "
                    f"retry."), None
            if raw != content:
                return False, (
                    f"the copy of {path} that came back from "
                    f"GitHub is not the file that was sent — the "
                    f"send is NOT verified. The drawing is still "
                    f"on screen; send again to retry."), None
    finally:
        try:
            proof_conn.close()
        except Exception:
            pass
    return True, f"Sent — Mollie can see it ({png_name}).", png_path
