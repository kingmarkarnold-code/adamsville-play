"""
Toolbar pictograms for the Map Editor (1.9.19).

Joshua's ruling (2026-10-24 hands-on, repeated 2026-10-28 on
1.9.15): the top toolbar's WORD buttons (Zone, Fill, Draw,
Extend, Merge, Join, Delete, Rename, Detail Edit, Find stacked,
Link to Overpass) become compact PICTURE buttons — "compact
icons like undo/redo, so more fit". Undo/redo, zoom and the
settings gear already carried stock pictures; the word buttons
never got theirs (noted honestly as missing in the 1.9.12
hands-on and still missing through 1.9.16). 1.9.19 supplies
them: the toolbar shows icons only, and every button's word
lives on in its tooltip.

The pictures are drawn with Cairo at runtime onto 24x24
pixbufs — deliberately NOT themed icon names, so the same
picture shows on any icon theme (a missing themed name would
draw a broken-image glyph), and no new asset files ship.
Stroke pictograms in one dark slate ink, drawn like the stock
symbolic icons they sit beside. Any failure while drawing
falls back to a plain filled dot — building the toolbar must
never fail over a picture.

Joshua's rule: all code commented.
"""

import cairo

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import GdkPixbuf, Gtk  # noqa: E402

# Pictogram canvas size (the toolbar's large-tool size) and
# the ink: a dark slate close to the symbolic stock icons.
SIZE = 24
INK = (0.16, 0.18, 0.20)


def _line(cr, pts, close=False):
    """Stroke one polyline through (x, y) points."""
    for k, (x, y) in enumerate(pts):
        cr.line_to(x, y) if k else cr.move_to(x, y)
    if close:
        cr.close_path()
    cr.stroke()


def _dot(cr, x, y, r):
    """A small filled circle (pins, nodes, endpoints)."""
    cr.arc(x, y, r, 0, 2 * 3.14159265)
    cr.fill()


def _draw_zone(cr):
    """A zone boundary: a polygon with pins on its corners."""
    poly = [(5, 13), (10, 5), (18, 6), (20, 13), (15, 20),
            (7, 19)]
    _line(cr, poly, close=True)
    for (x, y) in poly:
        _dot(cr, x, y, 1.3)


def _draw_fill(cr):
    """Fill: an outline shape filled up to a level line."""
    cr.rectangle(5, 5, 14, 14)
    cr.stroke()
    cr.rectangle(5.8, 12.5, 12.4, 5.7)
    cr.fill()


def _draw_draw(cr):
    """Draw: a pencil, tip at bottom-left."""
    _line(cr, [(4.5, 19.5), (6.2, 14.8), (16.8, 4.2),
              (19.8, 7.2), (9.2, 17.8), (4.5, 19.5)], close=True)
    _line(cr, [(14.6, 6.4), (17.6, 9.4)])


def _draw_extend(cr):
    """Extend: a line stretching away to an arrowhead."""
    _dot(cr, 5, 19, 1.7)
    _line(cr, [(6.3, 17.7), (16.5, 7.5)])
    _line(cr, [(11.5, 7), (17, 6.5), (17.5, 12)])


def _draw_merge(cr):
    """Merge: two roads becoming one, with the flow arrow."""
    _line(cr, [(4, 4.5), (11, 11), (12.5, 12)])
    _line(cr, [(4, 19.5), (11, 13), (12.5, 12)])
    _line(cr, [(12.5, 12), (19, 12)])
    _line(cr, [(15.5, 8.8), (19.2, 12), (15.5, 15.2)])


def _draw_join(cr):
    """Join: two pieces end to end, one line through a node."""
    _line(cr, [(5, 12), (19, 12)])
    cr.arc(5, 12, 2.1, 0, 2 * 3.14159265)
    cr.stroke()
    cr.arc(19, 12, 2.1, 0, 2 * 3.14159265)
    cr.stroke()
    _dot(cr, 12, 12, 2.2)


def _draw_delete(cr):
    """Delete: a trash can — lid, handle, slatted body."""
    _line(cr, [(4.5, 7), (19.5, 7)])
    _line(cr, [(9.8, 7), (9.8, 4.6), (14.2, 4.6), (14.2, 7)])
    _line(cr, [(6.8, 7), (8, 20), (16, 20), (17.2, 7)])
    _line(cr, [(10.4, 10.5), (10.9, 17)])
    _line(cr, [(13.6, 10.5), (13.1, 17)])


def _draw_rename(cr):
    """Rename: a name tag with its string hole."""
    _line(cr, [(4, 5), (12.5, 5), (20, 12.5), (11.5, 20),
              (4, 20)], close=True)
    cr.arc(8.2, 9.2, 1.5, 0, 2 * 3.14159265)
    cr.stroke()


def _draw_detail(cr):
    """Detail Edit: a magnifier over a piece of road."""
    cr.arc(10.5, 10.5, 5.6, 0, 2 * 3.14159265)
    cr.stroke()
    _line(cr, [(14.4, 14.4), (20, 20)])
    _line(cr, [(6.8, 12.6), (10.2, 9.4), (13.4, 11.4)])


def _draw_stacked(cr):
    """Find stacked: pieces lying on top of pieces."""
    cr.rectangle(4, 8, 12, 12)
    cr.stroke()
    cr.rectangle(8.5, 4, 12, 12)
    cr.stroke()


def _draw_overpass(cr):
    """Link to Overpass: a deck arcing over the road below."""
    cr.move_to(3, 11)
    cr.curve_to(8, 5.5, 16, 5.5, 21, 11)
    cr.stroke()
    _line(cr, [(6.2, 9.2), (6.2, 18)])
    _line(cr, [(17.8, 9.2), (17.8, 18)])
    _line(cr, [(3, 18), (21, 18)])


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
    cr.set_line_width(1.7)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.set_line_join(cairo.LINE_JOIN_ROUND)
    cr.set_source_rgb(*INK)
    draw = _DRAWERS.get(name)
    if draw is None:
        _dot(cr, SIZE / 2, SIZE / 2, 3.0)
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
            cr.set_source_rgb(*INK)
            _dot(cr, SIZE / 2, SIZE / 2, 3.0)
            surf.flush()
            pix = GdkPixbuf.Pixbuf.new_from_data(
                surf.get_data(), GdkPixbuf.Colorspace.RGB, True,
                8, SIZE, SIZE, surf.get_stride())
            img.set_from_pixbuf(pix.copy())
        except Exception:
            pass  # an empty image still leaves a working button
        return img
