#!/usr/bin/env python3
"""
Adamsville UI Resource Editor (Native) — preview and visual editing.

This module provides the richer previews Joshua asked for (2026-10-11):

* Images:   a larger preview plus simple edits (resize, crop, flip).
* JSON:     pretty-printed view plus a draggable layout editor for
            files that carry x/y/width/height element data.
* JS files: a dedicated popup window (see JSEditorDialog). It opens in
            PREVIEW mode showing a Cairo visual mockup parsed from the
            source; the pencil button toggles to EDIT mode with a code
            editor and per-element position controls.
* Audio:    a waveform placeholder plus a play button (GStreamer when
            available).

Everything here degrades gracefully: GtkSourceView and GStreamer are
optional, Pillow is required for image edits (declared in the .deb
dependencies). Nothing here executes game JavaScript — the "preview"
is a best-effort static mockup, which is clearly labeled as such.

Joshua's rule: all code commented.
"""

import io
import json
import math
import re
from pathlib import Path

# Pillow does the real image work for the visual editor. The .deb
# declares python3-pil as a dependency; if it is somehow missing we
# disable image editing rather than crash.
try:
    from PIL import Image
    PIL_AVAILABLE = True
except Exception:
    Image = None
    PIL_AVAILABLE = False


# ---------------------------------------------------------------------------
# JavaScript UI-element parser (best-effort, static — never executes code)
# ---------------------------------------------------------------------------
# The game builds its UI in plain JS. We look for the most common shapes:
#   1. document.createElement('button') + el.style.left = '10px' ...
#   2. helper calls like button('OK', 10, 20, 120, 36)
#   3. object literals {x: 10, y: 20, width: 120, height: 36, text: 'OK'}
#   4. innerHTML strings containing <button>/<div> tags
#
# Each element keeps "hints": (line_number, attribute) pairs pointing at
# the source lines the value came from, so the edit panel can rewrite the
# numbers back into the code when Joshua drags values around. When no
# hint exists the element is preview-only.

# Map of HTML tags / factory names to our mockup kinds.
_TAG_KINDS = {
    "button": "button", "btn": "button",
    "div": "panel", "panel": "panel", "section": "panel",
    "span": "label", "label": "label", "p": "label", "h1": "label",
    "h2": "label", "h3": "label",
    "input": "input", "select": "input", "textarea": "input",
    "img": "image", "canvas": "image",
    "ul": "list", "ol": "list", "menu": "list",
    "form": "panel", "dialog": "panel",
}

# Sensible default sizes when the source gives no dimensions (pixels).
_DEFAULT_SIZE = {
    "button": (120, 36), "panel": (300, 200), "label": (160, 24),
    "input": (180, 32), "image": (160, 120), "list": (220, 160),
}

# Regexes (compiled once).
_RE_CREATE = re.compile(
    r"""(?:const|let|var)\s+(\w+)\s*=\s*document\.createElement\(\s*['"](\w+)['"]\s*\)""")
_RE_STYLE = re.compile(
    r"""(\w+)\.style\.(left|top|width|height)\s*=\s*['"]?(-?\d+(?:\.\d+)?)""")
_RE_TEXT = re.compile(
    r"""(\w+)\.(innerText|textContent|value|placeholder|title)\s*=\s*['"]([^'"]{0,80})['"]""")
_RE_ID = re.compile(r"""(\w+)\.(id|className)\s*=\s*['"]([^'"]{0,60})['"]""")
# button('OK', 10, 20) or panel('Title', 10, 20, 300, 200)
_RE_FACTORY = re.compile(
    r"""\b(button|btn|panel|label|text|input|makeButton|createButton|makePanel|addLabel)\s*\(\s*['"]([^'"]{0,60})['"]\s*,\s*(-?\d+)\s*,\s*(-?\d+)(?:\s*,\s*(\d+)\s*,\s*(\d+))?""")
# {x: 10, y: 20, width: 100, height: 30, text: 'OK'} style literals
_RE_LITERAL = re.compile(
    r"""\{[^{}]{0,400}?\bx\s*:\s*(-?\d+)[^{}]{0,400}?\by\s*:\s*(-?\d+)""")
_RE_LITERAL_W = re.compile(r"""\b(?:width|w)\s*:\s*(\d+)""")
_RE_LITERAL_H = re.compile(r"""\b(?:height|h)\s*:\s*(\d+)""")
_RE_LITERAL_T = re.compile(
    r"""\b(?:text|label|title|name)\s*:\s*['"]([^'"]{0,60})['"]""")
_RE_LITERAL_TYPE = re.compile(
    r"""\b(?:type|kind|tag)\s*:\s*['"](\w+)['"]""")
# innerHTML = '<button>OK</button>' fragments
_RE_INNER_TAG = re.compile(r"""<(\w+)[^>]{0,120}?>([^<]{0,60})<""")
# menu-ish string arrays: const items = ['New', 'Load', 'Quit']
_RE_STR_ARRAY = re.compile(
    r"""(?:const|let|var)\s+(\w*(?:menu|items|options|buttons)\w*)\s*=\s*\[([^\]]{1,400})\]""",
    re.IGNORECASE)
_RE_QUOTED = re.compile(r"""['"]([^'"]{1,40})['"]""")


def _num(s):
    """Parse an int/float-ish string; None on failure."""
    try:
        return int(float(s))
    except Exception:
        return None


def parse_js_ui_elements(source):
    """
    Best-effort static parse of UI elements from JS source.

    Returns a list of dicts:
      {"kind": "button"|"panel"|..., "label": str,
       "x": int|None, "y": int|None, "w": int|None, "h": int|None,
       "hints": [(line_no_0based, attr), ...]}
    Elements without positions get staggered defaults so the mockup
    still shows something. Never raises on weird input.
    """
    elements = []
    lines = source.splitlines()
    by_var = {}  # var name -> element dict (for createElement tracking)

    def new_element(kind, label=""):
        el = {"kind": kind, "label": label, "x": None, "y": None,
              "w": None, "h": None, "hints": []}
        elements.append(el)
        return el

    # --- Pass 1: createElement + style/text/id assignments ---------------
    for i, line in enumerate(lines):
        m = _RE_CREATE.search(line)
        if m:
            var, tag = m.group(1), m.group(2).lower()
            kind = _TAG_KINDS.get(tag, "panel")
            by_var[var] = new_element(kind)
            continue
        m = _RE_STYLE.search(line)
        if m:
            var, attr, val = m.group(1), m.group(2), _num(m.group(3))
            el = by_var.get(var)
            if el is not None and val is not None:
                key = {"left": "x", "top": "y",
                       "width": "w", "height": "h"}[attr]
                el[key] = val
                el["hints"].append((i, key))
            continue
        m = _RE_TEXT.search(line)
        if m:
            var, _attr, val = m.group(1), m.group(2), m.group(3)
            el = by_var.get(var)
            if el is not None and not el["label"]:
                el["label"] = val
            continue
        m = _RE_ID.search(line)
        if m:
            var, _attr, val = m.group(1), m.group(2), m.group(3)
            el = by_var.get(var)
            if el is not None and not el["label"]:
                el["label"] = val.replace("-", " ").replace("_", " ")

    # --- Pass 2: factory calls like button('OK', 10, 20, 120, 36) ------
    for i, line in enumerate(lines):
        for m in _RE_FACTORY.finditer(line):
            fname, label, x, y, w, h = (m.group(1), m.group(2),
                                        _num(m.group(3)), _num(m.group(4)),
                                        _num(m.group(5)), _num(m.group(6)))
            kind = _TAG_KINDS.get(fname.lower().replace("make", "")
                                  .replace("create", "").replace("add", ""),
                                  "button")
            el = new_element(kind, label)
            el.update({"x": x, "y": y, "w": w, "h": h})
            for attr, val in (("x", x), ("y", y), ("w", w), ("h", h)):
                if val is not None:
                    el["hints"].append((i, attr))

    # --- Pass 3: object literals with x/y -------------------------------
    for i, line in enumerate(lines):
        m = _RE_LITERAL.search(line)
        if m:
            x, y = _num(m.group(1)), _num(m.group(2))
            kind_m = _RE_LITERAL_TYPE.search(line)
            kind = _TAG_KINDS.get(kind_m.group(1).lower(), "panel") \
                if kind_m else "panel"
            t_m = _RE_LITERAL_T.search(line)
            label = t_m.group(1) if t_m else ""
            w_m, h_m = _RE_LITERAL_W.search(line), _RE_LITERAL_H.search(line)
            el = new_element(kind, label)
            el.update({"x": x, "y": y,
                       "w": _num(w_m.group(1)) if w_m else None,
                       "h": _num(h_m.group(1)) if h_m else None})
            el["hints"].append((i, "x"))
            el["hints"].append((i, "y"))

    # --- Pass 4: innerHTML tag fragments --------------------------------
    for m in _RE_INNER_TAG.finditer(source):
        tag, text = m.group(1).lower(), m.group(2).strip()
        if tag in ("button", "div", "span", "p", "input", "label", "h1",
                   "h2", "img", "select"):
            el = new_element(_TAG_KINDS.get(tag, "panel"), text)

    # --- Pass 5: menu-ish string arrays ---------------------------------
    for m in _RE_STR_ARRAY.finditer(source):
        items = _RE_QUOTED.findall(m.group(2))
        items = [s for s in items if s.strip()]
        if 2 <= len(items) <= 12:
            el = new_element("list", ", ".join(items[:4]))
            el["menu_items"] = items  # extra info for the mockup

    # --- Defaults: stagger anything missing a position ------------------
    for idx, el in enumerate(elements):
        dw, dh = _DEFAULT_SIZE.get(el["kind"], (200, 100))
        if el["w"] is None:
            el["w"] = dw
        if el["h"] is None:
            el["h"] = dh
        if el["x"] is None:
            el["x"] = 24 + (idx % 4) * 24
        if el["y"] is None:
            el["y"] = 24 + (idx % 6) * 44

    return elements


# ---------------------------------------------------------------------------
# JSON layout element finder
# ---------------------------------------------------------------------------
# A "layout element" is any dict carrying x and y (plus optional
# width/height/w/h and a label-ish key). We search recursively so nested
# structures like {"screens": {"main": {"elements": [...]}}} work.

_LABEL_KEYS = ("label", "text", "title", "name", "id", "caption")


def _is_layout_dict(d):
    """True if a dict looks like a positioned UI element."""
    if not isinstance(d, dict):
        return False
    keys = set(d.keys())
    return ("x" in keys and "y" in keys and
            all(isinstance(d[k], (int, float)) for k in ("x", "y")))


def _dict_label(d):
    """Best human label for a layout dict."""
    for k in _LABEL_KEYS:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()[:40]
    return ""


def find_json_layout_elements(obj):
    """
    Recursively collect layout elements from parsed JSON.

    Returns a list of dicts:
      {"label": str, "x": num, "y": num, "w": num|None, "h": num|None,
       "node": <the original dict, mutated in place by the editor>}
    "node" is a live reference — editing x/y/w/h writes straight back
    into the parsed structure, so Save just re-serializes it.
    """
    found = []

    def walk(node):
        if isinstance(node, dict):
            if _is_layout_dict(node):
                w = node.get("width", node.get("w"))
                h = node.get("height", node.get("h"))
                found.append({
                    "label": _dict_label(node),
                    "x": node["x"], "y": node["y"],
                    "w": w if isinstance(w, (int, float)) else None,
                    "h": h if isinstance(h, (int, float)) else None,
                    "node": node,
                })
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(obj)
    return found
