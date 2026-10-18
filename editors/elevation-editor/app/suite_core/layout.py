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
the scrollable wrapper, bold section labels, and a tiny JSON
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
from gi.repository import Gtk, Gdk


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


def scrolled(widget, shadow=True):
    """
    Wrap a widget in a Gtk.ScrolledWindow (automatic scrolling both
    ways) — the suite rule for any pane whose content can be long.
    The child expands to fill; the wrapper is what gets packed.
    """
    sw = Gtk.ScrolledWindow()
    sw.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
    if shadow:
        sw.set_shadow_type(Gtk.ShadowType.IN)
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
