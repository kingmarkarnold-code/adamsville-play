"""
Toolbar pictograms for the Map Editor (1.9.19, colour 1.9.20).

Joshua's ruling (2026-10-24 hands-on, repeated 2026-10-28 on
1.9.15): the top toolbar's WORD buttons (Zone, Fill, Draw,
Extend, Merge, Join, Delete, Rename, Detail Edit, Find stacked,
Link to Overpass) become compact PICTURE buttons — "compact
icons like undo/redo, so more fit". Undo/redo, zoom and the
settings gear already carried stock pictures; the word buttons
never got theirs (noted honestly as missing in the 1.9.12
hands-on and still missing through 1.9.16). 1.9.19 supplied
them: the toolbar shows icons only, and every button's word
lives on in its tooltip.

1.9.20 — COLOUR (Joshua's hands-on on 1.9.19, 2026-10-28):
"all of the icons that you added to the map editor are all
black against a gray background. Very hard to find out what's
what." He was right: the 1.9.19 pictures were thin line
drawings in a single near-black slate ink — on the toolbar's
gray they read as one row of near-identical black smudges, and
the old gate only ever checked they were non-blank. The
pictures are now drawn in COLOUR: every tool carries its own
saturated colour and a bold filled silhouette that reads at
the toolbar's real 24x24 size, and neighbouring buttons are
deliberately far apart in hue so the row can be scanned by
colour alone:

    Zone        green land with yellow corner pins
    Fill Area   an orange fill level inside its square
    Draw        a royal-blue pencil with a wood tip
    Extend      a magenta stretch arrow
    Merge       teal + sky strands becoming one teal road
    Join        gold and amber pieces meeting at a node
    Delete      a red trash can with white slats
    Rename      a violet name tag
    Detail Edit a cyan magnifier over a piece of road
    Find Stacked lime squares lying on top of each other
    Overpass    a brown bridge deck over the road below

The pictures are drawn with Cairo at runtime onto 24x24
pixbufs — deliberately NOT themed icon names, so the same
picture shows on any icon theme (a missing themed name would
draw a broken-image glyph), and no new asset files ship. Any
failure while drawing falls back to a plain filled dot —
building the toolbar must never fail over a picture.

Joshua's rule: all code commented.
"""

import cairo

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import GdkPixbuf, Gtk  # noqa: E402

# Pictogram canvas size (the toolbar's large-tool size).
SIZE = 24

# The dark separation outline: light colours (gold, lime,
# white details) get this edge so they never melt into the
# toolbar's gray. Used ONLY as a thin perimeter — the picture
# itself is the colour, never the outline.
OUTLINE = (0.15, 0.14, 0.17)

# Per-tool colours (saturated on purpose; see the table in
# the module docstring — neighbours in the toolbar row are
# far apart in hue).
GREEN = (0.18, 0.62, 0.26)        # Zone land
PIN_YELLOW = (1.00, 0.80, 0.16)   # Zone corner pins
ORANGE = (0.96, 0.50, 0.07)       # Fill level
BLUE = (0.14, 0.36, 0.88)         # Draw pencil body
WOOD = (0.93, 0.77, 0.52)         # Draw pencil tip
FER_RULE = (0.62, 0.76, 0.98)     # Draw pencil band
MAGENTA = (0.86, 0.13, 0.64)      # Extend arrow
TEAL = (0.00, 0.60, 0.60)         # Merge strand / trunk
SKY = (0.05, 0.48, 0.82)          # Merge second strand
GOLD = (0.98, 0.74, 0.10)         # Join left piece / node
AMBER = (0.97, 0.56, 0.06)        # Join right piece
RED = (0.84, 0.11, 0.11)          # Delete can
DARK_RED = (0.62, 0.05, 0.05)     # Delete lid and handle
VIOLET = (0.49, 0.24, 0.84)       # Rename tag
CYAN = (0.00, 0.63, 0.84)         # Detail magnifier ring
DEEP_BLUE = (0.00, 0.42, 0.68)    # Detail magnifier handle
LIME = (0.42, 0.72, 0.14)         # Stacked front square
LIME_PALE = (0.58, 0.80, 0.22)    # Stacked back square
BROWN = (0.56, 0.35, 0.17)        # Overpass deck and piers
ASPHALT = (0.23, 0.23, 0.26)      # Overpass road below
WHITE = (0.97, 0.97, 0.97)        # slats, tag hole, dashes


def _stroke(cr, pts, rgb, width, close=False):
    """Stroke one polyline through (x, y) points in a colour."""
    cr.set_source_rgb(*rgb)
    cr.set_line_width(width)
    for k, (x, y) in enumerate(pts):
        cr.line_to(x, y) if k else cr.move_to(x, y)
    if close:
        cr.close_path()
    cr.stroke()


def _poly(cr, pts, rgb, outline=True, ow=1.4):
    """Fill one closed polygon in a colour, then give it the
    dark separation outline (light colours need the edge to
    stay readable against the toolbar's gray)."""
    for k, (x, y) in enumerate(pts):
        cr.line_to(x, y) if k else cr.move_to(x, y)
    cr.close_path()
    cr.set_source_rgb(*rgb)
    cr.fill_preserve()
    if outline:
        cr.set_source_rgb(*OUTLINE)
        cr.set_line_width(ow)
        cr.stroke()
    else:
        cr.new_path()


def _rect(cr, x, y, w, h, rgb, outline=True, ow=1.4):
    """Fill one rectangle in a colour (+ separation outline)."""
    cr.rectangle(x, y, w, h)
    cr.set_source_rgb(*rgb)
    cr.fill_preserve()
    if outline:
        cr.set_source_rgb(*OUTLINE)
        cr.set_line_width(ow)
        cr.stroke()
    else:
        cr.new_path()


def _dot(cr, x, y, r, rgb):
    """A small filled circle in a colour (pins, nodes)."""
    cr.set_source_rgb(*rgb)
    cr.arc(x, y, r, 0, 2 * 3.14159265)
    cr.fill()


def _ring(cr, x, y, r, rgb, width):
    """A stroked circle in a colour (magnifier ring, tag hole)."""
    cr.set_source_rgb(*rgb)
    cr.set_line_width(width)
    cr.arc(x, y, r, 0, 2 * 3.14159265)
    cr.stroke()


def _draw_zone(cr):
    """Zone: a green land boundary with yellow corner pins."""
    poly = [(5, 13), (10, 5), (18, 6), (20, 13), (15, 20),
            (7, 19)]
    _poly(cr, poly, GREEN)
    for (x, y) in poly:
        _dot(cr, x, y, 1.5, PIN_YELLOW)


def _draw_fill(cr):
    """Fill Area: a square filled up to an orange level, with
    a drop of the same orange waiting above the level line."""
    cr.set_source_rgb(*OUTLINE)
    cr.set_line_width(2.2)
    cr.rectangle(5, 5, 14, 14)
    cr.stroke()
    _rect(cr, 6.3, 11.6, 11.4, 6.1, ORANGE, outline=False)
    _dot(cr, 12, 8.6, 2.1, ORANGE)


def _draw_draw(cr):
    """Draw: a royal-blue pencil, wood tip at bottom-left."""
    body = [(4.5, 19.5), (6.2, 14.8), (16.8, 4.2),
            (19.8, 7.2), (9.2, 17.8)]
    _poly(cr, body, BLUE)
    # The sharpened wood cone and the graphite point.
    _poly(cr, [(4.5, 19.5), (5.15, 17.7), (6.29, 18.85)],
          WOOD, outline=False)
    _dot(cr, 4.75, 19.15, 0.75, OUTLINE)
    # A pale band across the pencil near its top end.
    _stroke(cr, [(14.9, 6.1), (17.9, 9.1)], FER_RULE, 1.5)


def _draw_extend(cr):
    """Extend: a magenta line stretching away to an arrowhead."""
    _dot(cr, 5.5, 18.5, 2.3, MAGENTA)
    _stroke(cr, [(7, 16.8), (14.9, 9.7)], MAGENTA, 3.0)
    _poly(cr, [(18.6, 6.0), (16.95, 11.75), (12.85, 7.65)],
          MAGENTA, ow=1.3)


def _draw_merge(cr):
    """Merge: teal and sky strands becoming one teal road,
    with the flow arrow — two colours coming together."""
    _stroke(cr, [(3.5, 4.5), (9.5, 9.5), (12.3, 12)], TEAL, 2.9)
    _stroke(cr, [(3.5, 19.5), (9.5, 14.5), (12.3, 12)], SKY, 2.9)
    _stroke(cr, [(12.3, 12), (17.6, 12)], TEAL, 2.9)
    _poly(cr, [(15.2, 8.9), (20.3, 12), (15.2, 15.1)],
          TEAL, outline=False)


def _draw_join(cr):
    """Join: a gold piece and an amber piece end to end,
    meeting at one gold node — two colours coming together."""
    _rect(cr, 3.2, 8.8, 7.6, 6.4, GOLD)
    _rect(cr, 13.2, 8.8, 7.6, 6.4, AMBER)
    _dot(cr, 12, 12, 3.1, GOLD)
    _ring(cr, 12, 12, 3.1, OUTLINE, 1.5)


def _draw_delete(cr):
    """Delete: a red trash can — dark-red lid and handle,
    white slats down the red body."""
    _stroke(cr, [(4.2, 6.6), (19.8, 6.6)], DARK_RED, 2.6)
    _stroke(cr, [(9.6, 6.6), (9.6, 4.4), (14.4, 4.4),
                 (14.4, 6.6)], DARK_RED, 2.0)
    _poly(cr, [(6.6, 8.2), (17.4, 8.2), (16.1, 20), (7.9, 20)],
          RED)
    _stroke(cr, [(10.3, 11), (10.7, 17)], WHITE, 1.7)
    _stroke(cr, [(13.7, 11), (13.3, 17)], WHITE, 1.7)


def _draw_rename(cr):
    """Rename: a violet name tag — white string hole, and a
    white line where the name is written."""
    _poly(cr, [(4, 5), (12.5, 5), (20, 12.5), (11.5, 20),
               (4, 20)], VIOLET)
    _dot(cr, 8.2, 9.2, 1.8, WHITE)
    _ring(cr, 8.2, 9.2, 1.8, OUTLINE, 1.2)
    _stroke(cr, [(10.8, 15.6), (15.8, 15.6)], WHITE, 1.6)


def _draw_detail(cr):
    """Detail Edit: a cyan magnifier over a piece of road —
    thick ring, deep-blue handle, the road a thin dark line
    under the glass."""
    _stroke(cr, [(6.9, 12.8), (10.0, 9.6), (13.2, 11.6)],
            OUTLINE, 1.6)
    _ring(cr, 10.5, 10.5, 5.9, CYAN, 3.1)
    _stroke(cr, [(14.8, 14.8), (19.8, 19.8)], DEEP_BLUE, 3.6)


def _draw_stacked(cr):
    """Find Stacked: lime squares lying on top of each other —
    a pale one behind, a stronger one in front."""
    _rect(cr, 8.5, 4, 12, 12, LIME_PALE)
    _rect(cr, 3.5, 8, 12, 12, LIME)


def _draw_overpass(cr):
    """Link to Overpass: a brown deck arcing over the road
    below — brown piers, and the road a dark line with white
    dashes running underneath."""
    cr.set_source_rgb(*BROWN)
    cr.set_line_width(3.0)
    cr.move_to(3, 11.5)
    cr.curve_to(8, 5.8, 16, 5.8, 21, 11.5)
    cr.stroke()
    _stroke(cr, [(6.4, 9.9), (6.4, 17.5)], BROWN, 2.6)
    _stroke(cr, [(17.6, 9.9), (17.6, 17.5)], BROWN, 2.6)
    _stroke(cr, [(3, 19.6), (21, 19.6)], ASPHALT, 2.2)
    _stroke(cr, [(7, 19.6), (9.5, 19.6)], WHITE, 1.2)
    _stroke(cr, [(14.5, 19.6), (17, 19.6)], WHITE, 1.2)


_DRAWERS = {
    "zone": _draw_zone,
    "fill": _draw_fill,
    "draw": _draw_draw,
    "extend": _draw_extend,
    "merge": _draw_merge,
    "join": _draw_join,
    "delete": _draw_delete,
    "rename": _draw_rename,
    "detail": _draw_detail,
    "stacked": _draw_stacked,
    "overpass": _draw_overpass,
}


def _pixbuf(name):
    """Render one pictogram to a fresh pixbuf (a copy, so the
    Cairo surface's buffer can go away safely)."""
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, SIZE, SIZE)
    cr = cairo.Context(surf)
    cr.set_line_width(2.2)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.set_line_join(cairo.LINE_JOIN_ROUND)
    draw = _DRAWERS.get(name)
    if draw is None:
        _dot(cr, SIZE / 2, SIZE / 2, 3.0, OUTLINE)
    else:
        draw(cr)
    surf.flush()
    pix = GdkPixbuf.Pixbuf.new_from_data(
        surf.get_data(), GdkPixbuf.Colorspace.RGB, True, 8,
        SIZE, SIZE, surf.get_stride())
    return pix.copy()


def icon_image(name):
    """
    A Gtk.Image carrying the named pictogram, ready to be a
    tool button's icon widget. Never raises: any rendering
    failure returns a plain dot picture instead.
    """
    try:
        return Gtk.Image.new_from_pixbuf(_pixbuf(name))
    except Exception:
        img = Gtk.Image()
        try:
            surf = cairo.ImageSurface(cairo.FORMAT_ARGB32,
                                      SIZE, SIZE)
            cr = cairo.Context(surf)
            _dot(cr, SIZE / 2, SIZE / 2, 3.0, OUTLINE)
            surf.flush()
            pix = GdkPixbuf.Pixbuf.new_from_data(
                surf.get_data(), GdkPixbuf.Colorspace.RGB, True,
                8, SIZE, SIZE, surf.get_stride())
            img.set_from_pixbuf(pix.copy())
        except Exception:
            pass  # an empty image still leaves a working button
        return img
