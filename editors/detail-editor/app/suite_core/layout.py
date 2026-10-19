#!/usr/bin/env python3
"""
Adamsville SUITE CORE — layout grammar helpers.

Joshua's layout law (2026-10-17), from his Android/LinearLayout
study, applies to every window in the suite:

  * ANCHORS pin   — an element can be held to the top, bottom,
                    left or right of its container whatever the
                    screen does; anchoring one edge keeps its size.
  * SHARES divide — regions are sized as PROPORTIONS of the space
                    available (percentages of the window), never
                    fixed pixel sizes.
  * WEIGHTS fill  — one region carries the weight and absorbs all
                    the rest; when a region collapses, its share is
                    handed to the weighted region automatically.

Plus his editor UI rule (2026-10-16): any pane whose content is
LONG must be SCROLLABLE, and any GRAPHICAL pane must be ADJUSTABLE
(resizable by him) — nothing is ever clipped off-screen.

And screen-class variants (2026-10-17): one stretched UI for every
screen is a failure mode — apps pick layout DETAILS (pane widths,
padding, default sizes) from the class of screen they find:
phone classes belong to the HTML tools; the GTK apps distinguish
LAPTOP (<= 1440 px wide — Joshua's 1366x768 is the reference) from
DESKTOP (wider).

This module holds the small shared pieces: screen-class detection,
the scrollable wrapper, bold section labels, the divider
guarantees (paned / even_split / SplitMemory), anchored overlays
and ellipsized labels (merged in from the flat layout_grammar
pass, 2026-10-18 — EXTRACTION-REPORT.md section 4), and a tiny JSON
window-state store (window size + paned positions ride from one
session to the next — the Building Editor 1.7.1 lesson: a divider
must never reset to a pinned default).

Joshua's rule: all code commented.
"""

import json
from pathlib import Path

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("Pango", "1.0")
from gi.repository import Gtk, Gdk, GLib, Pango


# Width (px) at or below which a screen counts as the LAPTOP class.
LAPTOP_MAX_WIDTH = 1440


def screen_class():
    """
    ("laptop" | "desktop", width_px, height_px) for the default
    screen. Fail-open: any error reads as the laptop class (the
    smaller, safer layout) at 1366x768.
    """
    try:
        display = Gdk.Display.get_default()
        monitor = display.get_primary_monitor() or display.get_monitor(0)
        geo = monitor.get_geometry()
        w, h = int(geo.width), int(geo.height)
    except Exception:
        w, h = 1366, 768
    return ("laptop" if w <= LAPTOP_MAX_WIDTH else "desktop"), w, h


def scrolled(widget, shadow=True, hpolicy=Gtk.PolicyType.AUTOMATIC,
             vpolicy=Gtk.PolicyType.AUTOMATIC, min_content_height=None,
             min_content_width=None):
    """
    Wrap a widget in a Gtk.ScrolledWindow — the suite rule for any
    pane whose content can be long. Defaults are this module's
    original behaviour (automatic scrolling both ways, inset
    shadow), which the Elevation Editor 1.0.0 ships. The optional
    policy / min-content arguments are the flat layout pass's
    additions (merged 2026-10-18): a pane may pin one axis (the
    inspector readout uses hpolicy NEVER) and may declare the
    smallest usable size before it has real space.
    """
    sw = Gtk.ScrolledWindow()
    sw.set_policy(hpolicy, vpolicy)
    if shadow:
        sw.set_shadow_type(Gtk.ShadowType.IN)
    if min_content_height is not None:
        sw.set_min_content_height(min_content_height)
    if min_content_width is not None:
        sw.set_min_content_width(min_content_width)
    sw.add(widget)
    return sw


def section_label(text):
    """A bold, left-aligned section heading label."""
    label = Gtk.Label()
    label.set_markup(f"<b>{text}</b>")
    label.set_xalign(0)
    return label


def hint_label(text):
    """
    A dim, wrapped, left-aligned explanatory label — instructions
    and state readouts in plain language.
    """
    label = Gtk.Label(label=text)
    label.set_line_wrap(True)
    label.set_xalign(0)
    label.set_yalign(0)
    try:
        label.get_style_context().add_class("dim-label")
    except Exception:
        pass
    return label


class WindowState:
    """
    Tiny JSON store for one app's window geometry: window size and
    named pane positions, persisted in the app's own data dir.

    Usage:
        state = WindowState(data_dir / "window-state.json")
        w, h = state.get_size("main", (1280, 720))
        state.remember_size("main", window.get_size())
        pos = state.get_pane("main-split", 320)
        state.remember_pane("main-split", paned.get_position())
        state.save()

    Every read fail-opens to the caller's default; a corrupt or
    missing file is simply a first run.
    """

    def __init__(self, path):
        """Load the state file if it exists (fail-open to empty)."""
        self.path = Path(path)
        self._doc = {}
        try:
            doc = json.loads(self.path.read_text())
            if isinstance(doc, dict):
                self._doc = doc
        except Exception:
            self._doc = {}

    def get_size(self, key, default):
        """(w, h) remembered for key, else the default tuple."""
        val = self._doc.get(f"size:{key}")
        if isinstance(val, list) and len(val) == 2:
            try:
                return int(val[0]), int(val[1])
            except Exception:
                pass
        return default

    def remember_size(self, key, size):
        """Record a (w, h) tuple under key (in memory until save)."""
        self._doc[f"size:{key}"] = [int(size[0]), int(size[1])]

    def get_pane(self, key, default):
        """Divider position remembered for key, else default (px)."""
        val = self._doc.get(f"pane:{key}")
        try:
            return int(val)
        except Exception:
            return int(default)

    def remember_pane(self, key, position):
        """Record a divider position under key (until save)."""
        self._doc[f"pane:{key}"] = int(position)

    def save(self):
        """Write the state file (parent dirs created; fail-open)."""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self._doc, indent=1))
        except Exception:
            pass


def hscroll_row(child):
    """
    A wide horizontal control row (label + spinbutton strips, the
    edit/place rows) inside a sideways-only scroller: at full
    width it looks exactly as laid out; narrowed, it scrolls —
    it never pushes the window wider than the screen (1.7.1
    pattern: AUTOMATIC/NEVER, no shadow).
    """
    win = Gtk.ScrolledWindow()
    win.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
    win.set_shadow_type(Gtk.ShadowType.NONE)
    win.add(child)
    return win


# ---------------------------------------------------------------------------
# Proportional splits (the ADJUSTABLE half of the UI rule)
# ---------------------------------------------------------------------------

def paned(orientation, child1, child2, wide_handle=True):
    """
    A Gtk.Paned split in the suite grammar: a wide (grabbable)
    handle and BOTH children packed resize=True, shrink=True.
    shrink=True on both sides is the load-bearing detail — it is
    what lets the divider travel its full range and what keeps
    either pane reachable on a small screen (1.7.0 packed
    shrink=False and pinned its own divider at 0px of travel).
    The divider's starting position is a SHARE, set by the caller
    once the paned has real size — see even_split() and
    SplitMemory.initial_position().
    """
    p = Gtk.Paned(orientation=orientation)
    if wide_handle:
        p.set_wide_handle(True)
    p.pack1(child1, True, True)
    p.pack2(child2, True, True)
    return p


def even_split(p):
    """
    Start paned `p`'s divider at an even 50/50 share, applied on
    the next idle pass (a paned has no real width until it is
    shown; the Building Editor's Open dialog pattern). Returns
    the idle source id.
    """
    def _apply():
        width = (p.get_allocated_width()
                 if p.get_orientation() == Gtk.Orientation.HORIZONTAL
                 else p.get_allocated_height())
        if width > 0:
            p.set_position(width // 2)
        return False
    return GLib.idle_add(_apply)


class SplitMemory:
    """
    Session memory for one draggable divider (extracted from the
    zone tab's inspector split): the position Joshua drags to is
    the position the pane reopens at, every time, until the app
    closes. Usage:

        mem = SplitMemory(default_open_px=320)
        mem.attach(paned, is_open=lambda: inspector.get_visible())
        ... when the pane opens:
        mem.apply_initial(paned)

    default_open_px: how much space the SECOND pane gets before
    Joshua has ever dragged (the inspector's ~320px). min_first /
    min_second: clamps keeping both panes usable at apply time
    (240 / 200 in the original).
    """

    def __init__(self, default_open_px=320, min_first=240,
                 min_second=200):
        self.position = None        # Joshua's dragged position
        self.default_open_px = default_open_px
        self.min_first = min_first
        self.min_second = min_second
        self._guard = False

    def attach(self, paned, is_open):
        """Watch `paned` for user drags. is_open() -> bool tells
        whether the collapsible pane is currently shown — drags
        are only remembered while it is open, and applies are
        guarded so restoring a position is not itself remembered
        as a drag."""
        def _moved(p, _param):
            if not self._guard and is_open():
                self.position = p.get_position()
        paned.connect("notify::position", _moved)
        return paned

    def initial_position(self, paned):
        """The position to apply for this opening: Joshua's
        dragged position wins; before he ever drags, the second
        pane gets default_open_px. Clamped so both panes stay
        usable at the paned's current size. Pure arithmetic —
        returns None when the paned has no real size yet (the
        caller then also schedules an idle re-apply)."""
        horizontal = (paned.get_orientation()
                      == Gtk.Orientation.HORIZONTAL)
        size = (paned.get_allocated_width() if horizontal
                else paned.get_allocated_height())
        if size <= 0:
            return None
        if self.position is not None:
            pos = self.position
        elif horizontal:
            pos = size - self.default_open_px
        else:
            pos = self.default_open_px
        return max(self.min_first, min(pos, size - self.min_second))

    def apply_initial(self, paned):
        """Apply initial_position() under the remember-guard."""
        pos = self.initial_position(paned)
        if pos is None:
            return False
        self._guard = True
        try:
            paned.set_position(pos)
        finally:
            self._guard = False
        return True

    def apply_initial_idle(self, paned):
        """apply_initial on the next idle pass (for when the paned
        had no size yet at open time); one-shot."""
        def _apply():
            self.apply_initial(paned)
            return False
        return GLib.idle_add(_apply)


# ---------------------------------------------------------------------------
# Anchors (pin to an edge; size kept — Android gravity)
# ---------------------------------------------------------------------------

def anchored_overlay(base, overlay_child, halign=Gtk.Align.START,
                     valign=Gtk.Align.END, margin_start=0,
                     margin_end=0, margin_top=0, margin_bottom=0):
    """
    Pin `overlay_child` over `base` at the given alignment — the
    anchor: it keeps its own size and STAYS at that edge/corner
    whatever the base's size does (the inspector's status label
    is anchored bottom-left this way). Returns the Gtk.Overlay
    holding both; the overlay expands with the base (the weighted
    region), the child rides its anchor.
    """
    overlay_child.set_halign(halign)
    overlay_child.set_valign(valign)
    if margin_start:
        overlay_child.set_margin_start(margin_start)
    if margin_end:
        overlay_child.set_margin_end(margin_end)
    if margin_top:
        overlay_child.set_margin_top(margin_top)
    if margin_bottom:
        overlay_child.set_margin_bottom(margin_bottom)
    overlay = Gtk.Overlay()
    overlay.add(base)
    overlay.add_overlay(overlay_child)
    return overlay


# ---------------------------------------------------------------------------
# Labels that can never widen a window
# ---------------------------------------------------------------------------

def ellipsized_label(text=None, markup=None, tooltip=None,
                     max_width_chars=None, wrap=False):
    """
    A left-aligned label whose long text ELLIPSIZES (with the full
    text on the tooltip) instead of forcing its window wider —
    the 1.7.1 replacement for labels that pushed a 1527px minimum
    onto a 1366px screen. wrap=True is for readout blocks (line
    wrap inside a scrolled pane); max_width_chars caps a wrapping
    label's natural width (the inspector readout uses 48).
    """
    label = Gtk.Label()
    if markup is not None:
        label.set_markup(markup)
    elif text is not None:
        label.set_text(text)
    label.set_halign(Gtk.Align.START)
    label.set_ellipsize(Pango.EllipsizeMode.END)
    if wrap:
        label.set_line_wrap(True)
    if max_width_chars is not None:
        label.set_max_width_chars(max_width_chars)
    full = text if text is not None else markup
    if tooltip is not None:
        label.set_tooltip_text(tooltip)
    elif full:
        label.set_tooltip_text(full)
    return label
