#!/usr/bin/env python3
"""
Adamsville UI Resource Editor (Native) — visual UI layout editor.

This is the PRIMARY interface Joshua asked for (2026-10-11): a visual
editor for rearranging the game's HUD. It loads ui_layout.json (the same
file the game fetches at startup via ui_layout_apply.js), renders every
UI element on a canvas per view mode, and lets Joshua:

  * drag elements to move them,
  * drag the corner handle to resize/stretch them,
  * toggle visibility (e.g. remove the reports icon),
  * add new elements — but ONLY from the existing asset library
    (no uploading custom graphics, per Joshua's rule),
  * save the layout, which stages ui_layout.json for the next push.

View modes: Application (mobile), Web desktop, Web mobile. The two mobile
views share the Size presets (Phone portrait / Phone landscape / Tablet);
the app view defaults to Phone landscape because the game plays in
landscape (Joshua 2026-10-12).

Coordinate model: each element stores (anchor, x, y, width, height).
Anchors keep elements glued to screen corners across view sizes; the
canvas converts to concrete left/top via anchor_to_left_top() in data.py
(the same math the game's ui_layout_apply.js uses — keep in sync).

Joshua's rule: all code commented.
"""

import json

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk

from data import (
    anchor_to_left_top, left_top_to_xy, download_ui_layout, load_ui_layout,
    stage_content, is_visual, load_manifest, LAYOUT_VIEWS,
    WEB_MOBILE_PRESETS, ANCHORS, ANCHOR_LABELS, CANON_W, CANON_H,
    canon_scale, element_size_in_view,
)

# Element type -> (fill RGB, border RGB) used by the canvas mockup.
_TYPE_STYLE = {
    "button": ((0.16, 0.55, 0.55), (0.35, 0.85, 0.85)),
    "label":  ((0.0, 0.0, 0.0), (0.6, 0.6, 0.6)),
    "panel":  ((0.13, 0.15, 0.20), (0.45, 0.55, 0.70)),
    "image":  ((0.20, 0.22, 0.30), (0.55, 0.60, 0.75)),
    "bar":    ((0.25, 0.20, 0.10), (0.90, 0.75, 0.30)),
}
_DEFAULT_STYLE = ((0.25, 0.25, 0.30), (0.60, 0.60, 0.60))

# Size of the resize handle square (screen pixels).
_HANDLE = 12


class LayoutCanvas(Gtk.DrawingArea):
    """
    Cairo canvas that renders the UI layout for one view mode and
    handles direct manipulation: click to select, drag body to move,
    drag the bottom-right handle to resize.
    """

    def __init__(self, tab):
        """tab is the owning LayoutTab (callbacks + state live there)."""
        super().__init__()
        self.tab = tab
        self.set_hexpand(True)
        self.set_vexpand(True)
        # Mouse state: None, "move", or "resize".
        self._drag = None
        self._drag_el = None
        self._grab_dx = 0  # pointer offset inside the element (view px)
        self._grab_dy = 0
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK |
                        Gdk.EventMask.BUTTON_RELEASE_MASK |
                        Gdk.EventMask.POINTER_MOTION_MASK)
        self.connect("draw", self.on_draw)
        self.connect("button-press-event", self.on_press)
        self.connect("button-release-event", self.on_release)
        self.connect("motion-notify-event", self.on_motion)

    # -- geometry helpers ------------------------------------------------
    def view_geom(self):
        """
        Compute the on-screen geometry of the current view frame.
        Returns (ox, oy, scale, vw, vh): origin + pixels-per-view-pixel.
        """
        vw, vh = self.tab.current_view_size()
        alloc = self.get_allocation()
        margin = 24
        cw, ch = max(50, alloc.width - margin * 2), max(50, alloc.height - margin * 2)
        scale = min(cw / vw, ch / vh)
        fw, fh = vw * scale, vh * scale
        ox = margin + (cw - fw) / 2
        oy = margin + (ch - fh) / 2
        return ox, oy, scale, vw, vh

    def to_screen(self, vx, vy):
        """View pixels -> widget pixels."""
        ox, oy, scale, _vw, _vh = self.view_geom()
        return ox + vx * scale, oy + vy * scale

    def to_view(self, sx, sy):
        """Widget pixels -> view pixels."""
        ox, oy, scale, _vw, _vh = self.view_geom()
        return (sx - ox) / scale, (sy - oy) / scale

    def element_rect(self, el):
        # v1.7.6: concrete (left, top, w, h) in view pixels. Position AND
        # size go through the 1280x800 canonical frame (mirroring the
        # game's ui_layout_apply.js) so the preview matches the game.
        vw, vh = self.tab.current_view_size()
        left, top = anchor_to_left_top(el, vw, vh)
        sw, sh = element_size_in_view(el, vw, vh)
        return left, top, sw, sh

    def hit_test(self, sx, sy):
        """
        Find the topmost element under widget pixel (sx, sy).
        Returns (element, "handle"|"body") or (None, None).
        Hidden elements are still hittable (dashed outline) so Joshua
        can select and re-show them.
        """
        vx, vy = self.to_view(sx, sy)
        vw, vh = self.tab.current_view_size()
        if not (0 <= vx <= vw and 0 <= vy <= vh):
            return None, None
        for el in reversed(self.tab.visible_elements()):
            left, top, w, h = self.element_rect(el)
            # Resize handle: square at the bottom-right corner.
            hx0, hy0 = self.to_screen(left + w, top + h)
            if abs(sx - hx0) <= _HANDLE and abs(sy - hy0) <= _HANDLE:
                return el, "handle"
            if left <= vx <= left + w and top <= vy <= top + h:
                return el, "body"
        return None, None

    # -- drawing ----------------------------------------------------------
    def on_draw(self, _widget, cr):
        """Render the view frame and every element."""
        ox, oy, scale, vw, vh = self.view_geom()

        # Canvas background.
        cr.set_source_rgb(0.13, 0.13, 0.16)
        alloc = self.get_allocation()
        cr.rectangle(0, 0, alloc.width, alloc.height)
        cr.fill()

        # View frame: dark "screen" with a subtle border.
        cr.set_source_rgb(0.05, 0.06, 0.09)
        cr.rectangle(ox, oy, vw * scale, vh * scale)
        cr.fill()
        cr.set_source_rgb(0.45, 0.47, 0.55)
        cr.set_line_width(1.5)
        cr.rectangle(ox, oy, vw * scale, vh * scale)
        cr.stroke()

        # View label.
        cr.set_source_rgb(0.65, 0.65, 0.70)
        cr.set_font_size(12)
        cr.move_to(ox, oy - 8)
        cr.show_text(f"{self.tab.current_view_label()} — {vw}×{vh}")

        for el in self.tab.visible_elements():
            self.draw_element(cr, el, ox, oy, scale)

        return False

    def draw_element(self, cr, el, ox, oy, scale):
        """Draw one UI element as a labeled mockup box."""
        vw, vh = self.tab.current_view_size()
        left, top = anchor_to_left_top(el, vw, vh)
        # v1.7.6: size is canonical 1280x800 pixels in storage — scale to
        # view pixels like the game does (see element_size_in_view).
        w, h = element_size_in_view(el, vw, vh)
        x, y = ox + left * scale, oy + top * scale
        sw, sh = max(3, w * scale), max(3, h * scale)

        kind = el.get("type", "panel")
        fill, border = _TYPE_STYLE.get(kind, _DEFAULT_STYLE)
        selected = (el is self.tab.selected)
        hidden = not el.get("visible", True)

        # Hidden elements render ghosted with a red dashed outline so
        # Joshua can still find and re-enable them.
        cr.save()
        if hidden:
            cr.set_dash([6, 4], 0)
        cr.set_source_rgba(*fill, 0.92 if not hidden else 0.35)
        self._round_rect(cr, x, y, sw, sh, min(8, sh / 3))
        cr.fill_preserve()
        if hidden:
            cr.set_source_rgb(0.95, 0.30, 0.30)
        else:
            cr.set_source_rgb(*border)
        cr.set_line_width(2 if selected else 1.2)
        cr.stroke()
        cr.restore()

        # Label text (element id or label), clipped to the box.
        cr.save()
        label = el.get("label") or el.get("id", "")
        cr.set_source_rgba(1, 1, 1, 0.95 if not hidden else 0.5)
        fs = max(8, min(13, sh * 0.38))
        cr.set_font_size(fs)
        ext = cr.text_extents(label)
        tx = x + (sw - ext.width) / 2 - ext.x_bearing
        ty = y + (sh - ext.height) / 2 - ext.y_bearing
        # Don't overflow tiny boxes: shrink text to fit.
        if ext.width > sw - 6 and ext.width > 0:
            cr.save()
            cr.translate(x + 3, ty)
            cr.scale((sw - 6) / ext.width, 1)
            cr.move_to(0, 0)
            cr.show_text(label)
            cr.restore()
        else:
            cr.move_to(tx, ty)
            cr.show_text(label)
        cr.restore()

        if hidden:
            # "hidden" tag above the box.
            cr.set_source_rgb(0.95, 0.30, 0.30)
            cr.set_font_size(10)
            cr.move_to(x, y - 4)
            cr.show_text("hidden")

        if selected:
            # Resize handle: small square at bottom-right.
            hx, hy = x + sw, y + sh
            cr.set_source_rgb(1.0, 0.85, 0.30)
            cr.rectangle(hx - _HANDLE / 2, hy - _HANDLE / 2,
                         _HANDLE, _HANDLE)
            cr.fill()
            cr.set_source_rgb(0.2, 0.2, 0.2)
            cr.set_line_width(1)
            cr.stroke()

    @staticmethod
    def _round_rect(cr, x, y, w, h, r):
        """Cairo path for a rounded rectangle."""
        r = min(r, w / 2, h / 2)
        cr.new_sub_path()
        cr.arc(x + w - r, y + r, r, -1.5708, 0)
        cr.arc(x + w - r, y + h - r, r, 0, 1.5708)
        cr.arc(x + r, y + h - r, r, 1.5708, 3.1416)
        cr.arc(x + r, y + r, r, 3.1416, 4.7124)
        cr.close_path()

    # -- mouse interaction -------------------------------------------------
    def on_press(self, _widget, event):
        """Left-click: select; start move or resize drag."""
        if event.button == 3:
            # Right-click: context menu (visibility toggle / remove).
            el, _zone = self.hit_test(event.x, event.y)
            if el is not None:
                self.tab.select(el)
                self.tab.show_context_menu(event)
            return True
        if event.button != 1:
            return False
        el, zone = self.hit_test(event.x, event.y)
        if el is None:
            self.tab.select(None)
            return True
        self.tab.select(el)
        vx, vy = self.to_view(event.x, event.y)
        left, top, _w, _h = self.element_rect(el)
        if zone == "handle":
            self._drag = "resize"
        else:
            self._drag = "move"
            self._grab_dx = vx - left
            self._grab_dy = vy - top
        self._drag_el = el
        return True

    def on_motion(self, _widget, event):
        """Drag the selected element (move or resize)."""
        if self._drag is None or self._drag_el is None:
            return False
        el = self._drag_el
        vw, vh = self.tab.current_view_size()
        vx, vy = self.to_view(event.x, event.y)
        if self._drag == "move":
            new_left = vx - self._grab_dx
            new_top = vy - self._grab_dy
            el["x"], el["y"] = left_top_to_xy(el, new_left, new_top, vw, vh)
        elif self._drag == "resize":
            left, top, _w, _h = self.element_rect(el)
            # v1.7.6: drag distances are view pixels; stored width/height
            # are 1280x800 canonical pixels, so divide by the canonical
            # scale (mirrors the game's uniform s = min(vw/1280, vh/800)).
            cs = canon_scale(vw, vh)
            el["width"] = max(8, round((vx - left) / cs))
            el["height"] = max(8, round((vy - top) / cs))
        self.tab.after_element_changed(el, live=True)
        self.queue_draw()
        return True

    def on_release(self, _widget, event):
        """End any drag; refresh the side panels once."""
        if event.button != 1:
            return False
        if self._drag is not None:
            self._drag = None
            self._drag_el = None
            self.tab.after_element_changed(self.tab.selected, live=False)
            self.queue_draw()
        return True


class LayoutTab:
    """
    The visual layout editor tab: view controls on top, element list on
    the left, canvas in the middle, properties on the right, and an
    action toolbar (add / remove / save).
    """

    def __init__(self, app):
        """
        app is the main UIEditorApp: provides set_status() and the
        manifest (asset library) for the add-element dialog.
        """
        self.app = app
        self.doc = None          # full ui_layout.json dict
        self.selected = None     # currently selected element dict
        self.view_key = "app"    # one of LAYOUT_VIEWS keys
        # v1.7.5 ORIENTATION (2026-10-12): index into WEB_MOBILE_PRESETS.
        # Defaults to 1 = "Phone landscape" because the game plays in
        # landscape (Joshua). Both orientations stay selectable via the
        # Size dropdown, which is now enabled for the app view too.
        self.preset_idx = 1
        self._dirty = False      # unsaved changes?
        self._custom_seq = 1     # counter for custom-N ids
        self._build_ui()
        self._load_initial()

    # -- view helpers ------------------------------------------------------
    def current_view_size(self):
        """(width, height) in view pixels for the active view/preset."""
        # v1.7.5 ORIENTATION: the "app" view and "web_mobile" both use
        # the Size presets, so Joshua can pick Phone portrait or Phone
        # landscape for the APK HUD. Defaults to landscape.
        if self.view_key in ("app", "web_mobile"):
            _label, w, h = WEB_MOBILE_PRESETS[self.preset_idx]
            return w, h
        for key, _label, w, h in LAYOUT_VIEWS:
            if key == self.view_key:
                return w, h
        return 844, 390  # landscape fallback (v1.7.5)

    def current_view_label(self):
        """Human label for the active view."""
        # v1.7.5 ORIENTATION: show the chosen preset for mobile views.
        if self.view_key == "app":
            return ("Application (mobile) — "
                    + WEB_MOBILE_PRESETS[self.preset_idx][0])
        if self.view_key == "web_mobile":
            return "Web mobile — " + WEB_MOBILE_PRESETS[self.preset_idx][0]
        for key, label, _w, _h in LAYOUT_VIEWS:
            if key == self.view_key:
                return label
        return self.view_key

    def visible_elements(self):
        """
        Elements relevant to the current view. Mobile-only elements are
        skipped on the desktop view (mirrors the game's own behavior).
        """
        if self.doc is None:
            return []
        els = self.doc.get("elements", [])
        if self.view_key == "web_desktop":
            els = [e for e in els if not e.get("mobile_only")]
        return els

    # -- UI construction ----------------------------------------------------
    def _build_ui(self):
        """Assemble the tab: toolbar, view bar, paned content."""
        self.root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        # Action toolbar: add / remove / save layout.
        toolbar = Gtk.Toolbar()
        toolbar.set_style(Gtk.ToolbarStyle.BOTH)
        for btn_id, label, stock, tip in [
                ("add", "Add element", Gtk.STOCK_ADD,
                 "Add a UI element from the existing asset library"),
                ("remove", "Remove", Gtk.STOCK_REMOVE,
                 "Remove the selected element from the layout"),
                ("save", "Save layout", Gtk.STOCK_SAVE,
                 "Save the layout (staged for the next push to GitHub)")]:
            btn = Gtk.ToolButton.new_from_stock(stock)
            btn.set_label(label)
            btn.set_is_important(True)
            btn.set_tooltip_text(tip)
            btn.connect("clicked", self.on_toolbar, btn_id)
            toolbar.insert(btn, -1)
            if btn_id == "remove":
                self.remove_btn = btn
                btn.set_sensitive(False)
        self.root.pack_start(toolbar, False, False, 0)

        # View bar: view-mode dropdown + mobile size presets.
        viewbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        viewbar.set_border_width(6)
        viewbar.pack_start(Gtk.Label(label="View:"), False, False, 0)
        self.view_combo = Gtk.ComboBoxText()
        for key, label, _w, _h in LAYOUT_VIEWS:
            self.view_combo.append(key, label)
        self.view_combo.set_active_id("app")
        self.view_combo.connect("changed", self.on_view_changed)
        viewbar.pack_start(self.view_combo, False, False, 0)

        viewbar.pack_start(Gtk.Label(label="Size:"), False, False, 0)
        self.preset_combo = Gtk.ComboBoxText()
        for i, (label, _w, _h) in enumerate(WEB_MOBILE_PRESETS):
            self.preset_combo.append(str(i), label)
        # v1.7.5 ORIENTATION: default to Phone landscape (index 1) —
        # that's how the game plays. Both orientations stay selectable.
        self.preset_combo.set_active(1)
        self.preset_combo.connect("changed", self.on_preset_changed)
        viewbar.pack_start(self.preset_combo, False, False, 0)
        # v1.7.5: enabled for the app view too (was web_mobile only).

        hint = Gtk.Label()
        hint.set_markup('<small><i>Drag elements to move · drag the yellow '
                        'corner to resize · right-click for options</i></small>')
        viewbar.pack_end(hint, False, False, 0)
        self.root.pack_start(viewbar, False, False, 0)

        # Content: element list (left) | canvas (center) | props (right).
        # Both side panels are collapsible (Joshua 2026-10-11): a thin
        # toggle strip stays visible so he can focus on the canvas.
        # v1.7.5 PANEL FIX: the paneds and wrapper boxes are kept as
        # instance attributes so the toggle methods can remove the scroll
        # widgets and move the dividers (see toggle_left_panel).
        self.paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        self.paned.set_position(220)
        self.root.pack_start(self.paned, True, True, 0)
        paned = self.paned

        # Left: element list with visibility toggles.
        self._build_element_list()
        self.list_scroll = Gtk.ScrolledWindow()
        self.list_scroll.set_min_content_width(200)
        self.list_scroll.add(self.el_tree)
        left_wrap = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                            spacing=0)
        self.left_wrap = left_wrap  # v1.7.5: needed for panel collapse
        self.left_toggle = self._make_collapse_button(
            "◀", "Hide element list (F9)", self.toggle_left_panel)
        left_wrap.pack_start(self.left_toggle, False, False, 0)
        left_wrap.pack_start(self.list_scroll, True, True, 0)
        paned.pack1(left_wrap, resize=False, shrink=False)
        self.left_collapsed = False

        # Center/right: canvas + properties in a second paned.
        inner = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        inner.set_position(700)
        paned.pack2(inner, resize=True, shrink=False)
        self.inner = inner  # v1.7.5: needed for panel collapse

        self.canvas = LayoutCanvas(self)
        canvas_scroll = Gtk.ScrolledWindow()
        canvas_scroll.add(self.canvas)
        inner.pack1(canvas_scroll, resize=True, shrink=False)

        self._build_props_panel()
        self.props_scroll = Gtk.ScrolledWindow()
        self.props_scroll.set_min_content_width(230)
        self.props_scroll.add(self.props_box)
        right_wrap = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                             spacing=0)
        self.right_wrap = right_wrap  # v1.7.5: needed for panel collapse
        right_wrap.pack_start(self.props_scroll, True, True, 0)
        self.right_toggle = self._make_collapse_button(
            "▶", "Hide properties (F10)", self.toggle_right_panel)
        right_wrap.pack_start(self.right_toggle, False, False, 0)
        inner.pack2(right_wrap, resize=False, shrink=False)
        self.right_collapsed = False

    @staticmethod
    def _make_collapse_button(label, tooltip, callback):
        """
        Thin toggle-strip button for collapsing a side panel.
        Stays visible when the panel hides, so Joshua can expand it.
        """
        btn = Gtk.Button(label=label)
        btn.set_tooltip_text(tooltip)
        btn.set_relief(Gtk.ReliefStyle.NONE)
        btn.set_size_request(26, -1)  # narrow strip; panel gives height
        btn.connect("clicked", lambda _w: callback())
        return btn

    def toggle_left_panel(self):
        """Collapse/expand the left element-list panel (F9).

        v1.7.5 PANEL FIX (2026-10-12): Gtk.Paned keeps its divider
        position when a child is merely hidden, so the old hide() left
        dead space where the panel was. We now remove the scroll widget
        from the paned's child box and move the divider to the toggle
        strip, so the canvas expands into the freed space. The divider
        position is stashed so re-expanding restores it.
        """
        self.left_collapsed = not self.left_collapsed
        if self.left_collapsed:
            self._left_pos = self.paned.get_position()
            self.left_wrap.remove(self.list_scroll)
            self.paned.set_position(28)  # toggle strip only (~26px + pad)
            self.left_toggle.set_label("▶")
            self.left_toggle.set_tooltip_text("Show element list (F9)")
        else:
            self.left_wrap.pack_start(self.list_scroll, True, True, 0)
            self.list_scroll.show()
            self.paned.set_position(getattr(self, "_left_pos", 220))
            self.left_toggle.set_label("◀")
            self.left_toggle.set_tooltip_text("Hide element list (F9)")

    def toggle_right_panel(self):
        """Collapse/expand the right properties panel (F10).

        v1.7.5 PANEL FIX (2026-10-12): same approach as
        toggle_left_panel — remove the scroll widget and park the
        inner divider at the right edge so the canvas takes the freed
        space instead of leaving a gap.
        """
        self.right_collapsed = not self.right_collapsed
        if self.right_collapsed:
            self._inner_pos = self.inner.get_position()
            self.right_wrap.remove(self.props_scroll)
            # Divider near the right edge: inner width minus the
            # toggle strip. Guard against an unallocated widget.
            w = self.inner.get_allocated_width()
            self.inner.set_position(max(0, w - 28) if w > 100 else 10 ** 9)
            self.right_toggle.set_label("◀")
            self.right_toggle.set_tooltip_text("Show properties (F10)")
        else:
            self.right_wrap.pack_start(self.props_scroll, True, True, 0)
            # pack_start appends after the toggle button; move it back
            # to the front so the layout matches the original build.
            self.right_wrap.reorder_child(self.props_scroll, 0)
            self.props_scroll.show()
            self.inner.set_position(getattr(self, "_inner_pos", 700))
            self.right_toggle.set_label("▶")
            self.right_toggle.set_tooltip_text("Hide properties (F10)")

    def _build_element_list(self):
        """
        Left list: visibility checkbox, element id, type.
        Toggling the checkbox hides/shows the element in the layout.
        """
        # Columns: 0=visible bool, 1=id, 2=type, 3=element dict (hidden)
        self.el_store = Gtk.ListStore(bool, str, str, object)
        self.el_tree = Gtk.TreeView(model=self.el_store)
        self.el_tree.get_selection().set_mode(Gtk.SelectionMode.SINGLE)
        self.el_tree.get_selection().connect("changed",
                                              self.on_list_selection)

        toggle = Gtk.CellRendererToggle()
        toggle.connect("toggled", self.on_visibility_toggled)
        col_vis = Gtk.TreeViewColumn("Show", toggle, active=0)
        self.el_tree.append_column(col_vis)

        for idx, title in ((1, "Element"), (2, "Type")):
            rend = Gtk.CellRendererText()
            col = Gtk.TreeViewColumn(title, rend, text=idx)
            col.set_expand(idx == 1)
            self.el_tree.append_column(col)

    def _build_props_panel(self):
        """Right panel: editable properties of the selected element."""
        self.props_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                                 spacing=6)
        self.props_box.set_border_width(10)
        title = Gtk.Label()
        title.set_markup("<b>Properties</b>")
        title.set_halign(Gtk.Align.START)
        self.props_box.pack_start(title, False, False, 0)

        self.prop_widgets = {}
        # (key, label, widget kind)
        for key, label, kind in [
                ("id", "ID", "ro"),
                ("type", "Type", "combo"),
                ("label", "Label", "text"),
                ("anchor", "Anchor", "anchor"),
                ("x", "X offset", "int"),
                ("y", "Y offset", "int"),
                ("width", "Width", "int"),
                ("height", "Height", "int")]:
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            lab = Gtk.Label(label=label + ":")
            lab.set_halign(Gtk.Align.START)
            lab.set_size_request(70, -1)
            row.pack_start(lab, False, False, 0)
            if kind == "ro":
                w = Gtk.Label(label="—")
                w.set_halign(Gtk.Align.START)
                w.set_selectable(True)
            elif kind == "text":
                w = Gtk.Entry()
                w.connect("changed", self.on_prop_changed, key)
            elif kind == "combo":
                w = Gtk.ComboBoxText()
                for t in ("button", "label", "panel", "image", "bar"):
                    w.append(t, t)
                w.connect("changed", self.on_prop_changed, key)
            elif kind == "anchor":
                w = Gtk.ComboBoxText()
                for a in ANCHORS:
                    w.append(a, ANCHOR_LABELS[a])
                w.connect("changed", self.on_prop_changed, key)
            elif kind == "int":
                adj = Gtk.Adjustment(value=0, lower=-2000, upper=4000,
                                     step_increment=1, page_increment=10)
                w = Gtk.SpinButton(adjustment=adj, digits=0)
                w.connect("value-changed", self.on_prop_changed, key)
            row.pack_start(w, True, True, 0)
            self.props_box.pack_start(row, False, False, 0)
            self.prop_widgets[key] = w

        # Visible + mobile-only checkboxes.
        self.visible_check = Gtk.CheckButton(label="Visible")
        self.visible_check.connect("toggled", self.on_prop_changed,
                                   "visible")
        self.props_box.pack_start(self.visible_check, False, False, 0)
        self.mobile_check = Gtk.CheckButton(label="Mobile only")
        self.mobile_check.connect("toggled", self.on_prop_changed,
                                  "mobile_only")
        self.props_box.pack_start(self.mobile_check, False, False, 0)

        asset_lab = Gtk.Label()
        asset_lab.set_markup("<small>Asset: <i>none</i></small>")
        asset_lab.set_halign(Gtk.Align.START)
        asset_lab.set_line_wrap(True)
        self.props_box.pack_start(asset_lab, False, False, 0)
        self.asset_label = asset_lab

        # Description (Joshua 2026-10-11): plain-language explanation of
        # what the selected UI element does, so anyone working with him
        # understands it (e.g. "speedo" = speedometer).
        desc_title = Gtk.Label()
        desc_title.set_markup("<b>Description</b>")
        desc_title.set_halign(Gtk.Align.START)
        self.props_box.pack_start(desc_title, False, False, 0)
        self.desc_label = Gtk.Label()
        self.desc_label.set_halign(Gtk.Align.START)
        self.desc_label.set_line_wrap(True)
        self.desc_label.set_selectable(True)
        self.props_box.pack_start(self.desc_label, False, False, 0)

        self._updating_props = False  # guard against signal loops
        self.refresh_props()

    # -- data loading --------------------------------------------------------
    def _load_initial(self):
        """Load the layout: download fresh, fall back to cache/default."""
        # Try a fresh download first (non-blocking enough at ~5KB);
        # fall back to whatever is cached or shipped.
        try:
            download_ui_layout()
        except Exception:
            pass
        self.doc = load_ui_layout()
        if self.doc is None:
            self.doc = {"version": "2026.10.11.1", "views": {},
                        "elements": []}
        # Advance the custom-id counter past any existing custom-N ids.
        for el in self.doc.get("elements", []):
            eid = el.get("id", "")
            if eid.startswith("custom-"):
                try:
                    self._custom_seq = max(self._custom_seq,
                                           int(eid.split("-")[1]) + 1)
                except Exception:
                    pass
        self.selected = None
        self._dirty = False
        self.refresh_list()
        self.refresh_props()
        self.canvas.queue_draw()

    # -- selection ------------------------------------------------------------
    def select(self, el):
        """Select an element (or None): update list, props, canvas."""
        self.selected = el
        self.remove_btn.set_sensitive(el is not None)
        # Sync the list selection without triggering its handler loop.
        sel = self.el_tree.get_selection()
        sel.handler_block_by_func(self.on_list_selection)
        try:
            if el is None:
                sel.unselect_all()
            else:
                for row in self.el_store:
                    if row[3] is el:
                        sel.select_iter(row.iter)
                        break
        finally:
            sel.handler_unblock_by_func(self.on_list_selection)
        self.refresh_props()
        self.canvas.queue_draw()

    def on_list_selection(self, selection):
        """Left list row clicked -> select that element on the canvas."""
        model, treeiter = selection.get_selected()
        self.select(model[treeiter][3] if treeiter else None)

    def on_visibility_toggled(self, _renderer, path):
        """Checkbox in the element list: show/hide that element."""
        treeiter = self.el_store.get_iter(path)
        el = self.el_store[treeiter][3]
        el["visible"] = not self.el_store[treeiter][0]
        self._dirty = True
        self.refresh_list()
        self.refresh_props()
        self.canvas.queue_draw()
        self.app.set_status(
            f"{'Showing' if el['visible'] else 'Hiding'} '{el['id']}'"
            " — save the layout to apply")

    # -- view controls ----------------------------------------------------------
    def on_view_changed(self, combo):
        """View-mode dropdown: switch canvas + element filtering."""
        self.view_key = combo.get_active_id() or "app"
        # v1.7.5 ORIENTATION: the Size presets apply to both mobile
        # views (app + web_mobile); web_desktop has a fixed size.
        self.preset_combo.set_sensitive(
            self.view_key in ("app", "web_mobile"))
        self.select(None)
        self.canvas.queue_draw()

    def on_preset_changed(self, combo):
        """Size preset changed (Phone portrait / Phone landscape / Tablet).

        v1.7.5 ORIENTATION: this now drives the app view too, so picking
        "Phone landscape" resizes the APK HUD canvas to 844x390.
        """
        self.preset_idx = combo.get_active()
        if self.preset_idx < 0 or self.preset_idx >= len(WEB_MOBILE_PRESETS):
            self.preset_idx = 1  # landscape fallback
        self.select(None)
        self.canvas.queue_draw()

    # -- element changes ----------------------------------------------------------
    def after_element_changed(self, el, live):
        """
        Called by the canvas after a drag (live=True on every motion,
        live=False once on release). Updates list + props; marks dirty.
        """
        if el is None:
            return
        self._dirty = True
        if not live:
            self.refresh_list()
            self.refresh_props()
            self.app.set_status(
                f"Moved '{el['id']}' — save the layout to apply")

    def show_context_menu(self, event):
        """Right-click menu on an element: hide/show, remove."""
        el = self.selected
        if el is None:
            return
        menu = Gtk.Menu()
        vis_label = "Hide element" if el.get("visible", True) \
            else "Show element"
        vis_item = Gtk.MenuItem(label=vis_label)
        vis_item.connect("activate", self.on_toggle_selected_visibility)
        menu.append(vis_item)
        rem_item = Gtk.MenuItem(label="Remove element…")
        rem_item.connect("activate", lambda w: self.on_remove_element())
        menu.append(rem_item)
        menu.show_all()
        menu.popup_at_pointer(event)

    def on_toggle_selected_visibility(self, _widget):
        """Context-menu toggle for the selected element."""
        if self.selected is None:
            return
        self.selected["visible"] = not self.selected.get("visible", True)
        self._dirty = True
        self.refresh_list()
        self.refresh_props()
        self.canvas.queue_draw()

    # -- toolbar actions ------------------------------------------------------------
    def on_toolbar(self, _widget, btn_id):
        """Route layout-toolbar clicks."""
        if btn_id == "add":
            self.on_add_element()
        elif btn_id == "remove":
            self.on_remove_element()
        elif btn_id == "save":
            self.on_save_layout()

    def on_add_element(self):
        """
        Add an element — ONLY from the existing asset library
        (Joshua's rule: no uploading custom graphics here).
        """
        manifest = load_manifest() or []
        assets = sorted(e["name"] for e in manifest if is_visual(e["name"]))
        dialog = Gtk.Dialog(title="Add UI element", parent=self.app.window,
                            flags=Gtk.DialogFlags.MODAL)
        dialog.set_default_size(420, 300)
        content = dialog.get_content_area()
        info = Gtk.Label(label="Pick an asset from the game's library:")
        info.set_halign(Gtk.Align.START)
        content.pack_start(info, False, False, 8)

        store = Gtk.ListStore(str)
        for a in assets:
            store.append([a])
        tree = Gtk.TreeView(model=store)
        rend = Gtk.CellRendererText()
        tree.append_column(Gtk.TreeViewColumn("Asset", rend, text=0))
        tree.get_selection().set_mode(Gtk.SelectionMode.SINGLE)
        scroll = Gtk.ScrolledWindow()
        scroll.set_min_content_height(180)
        scroll.add(tree)
        content.pack_start(scroll, True, True, 0)

        dialog.add_buttons(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
                           Gtk.STOCK_ADD, Gtk.ResponseType.OK)
        dialog.show_all()
        new_el = None
        if dialog.run() == Gtk.ResponseType.OK:
            model, treeiter = tree.get_selection().get_selected()
            if treeiter is not None:
                asset = model[treeiter][0]
                eid = f"custom-{self._custom_seq}"
                self._custom_seq += 1
                vw, vh = self.current_view_size()
                new_el = {
                    "id": eid, "type": "image", "label": asset,
                    "asset": asset, "anchor": "tl",
                    "x": vw // 2 - 60, "y": vh // 2 - 30,
                    "width": 120, "height": 60,
                    "visible": True, "mobile_only": False,
                    # New custom elements get a placeholder description
                    # that Joshua can update (descriptions explain what
                    # each element does).
                    "description": f"Custom element using the '{asset}' asset",
                }
                self.doc.setdefault("elements", []).append(new_el)
                self._dirty = True
        dialog.destroy()
        if new_el is not None:
            self.refresh_list()
            self.select(new_el)
            self.app.set_status(
                f"Added '{new_el['id']}' — save the layout to apply")

    def on_remove_element(self):
        """Remove the selected element (with confirmation)."""
        el = self.selected
        if el is None:
            return
        dlg = Gtk.MessageDialog(
            parent=self.app.window, flags=Gtk.DialogFlags.MODAL,
            type=Gtk.MessageType.WARNING, buttons=Gtk.ButtonsType.OK_CANCEL,
            message_format=f"Remove '{el['id']}' from the UI layout?")
        dlg.format_secondary_text(
            "The element will no longer appear in the game. "
            "You can re-add it later from the asset library.")
        ok = dlg.run() == Gtk.ResponseType.OK
        dlg.destroy()
        if not ok:
            return
        self.doc["elements"].remove(el)
        self.select(None)
        self._dirty = True
        self.refresh_list()
        self.canvas.queue_draw()
        self.app.set_status(f"Removed '{el['id']}' — save the layout to apply")

    def on_save_layout(self):
        """
        Save: serialize the layout and stage ui_layout.json for the next
        push. The existing Resources-tab push dialog sends it to GitHub,
        and the game fetches it at startup.
        """
        try:
            payload = json.dumps(self.doc, indent=2)
        except Exception as e:
            self.app.set_status(f"Could not serialize layout: {e}")
            return
        staged = stage_content("ui_layout.json", payload.encode("utf-8"))
        if staged:
            self._dirty = False
            # Mark for the close warning (Joshua 2026-10-11).
            try:
                self.app._unpublished = True
            except Exception:
                pass
            self.app.set_status(
                "Layout saved — open the Resources tab and Push to GitHub "
                "to apply it to the game")
            self.app.refresh_resources_list()
        else:
            self.app.set_status("Save failed — could not stage the file")

    # -- list + props refresh ----------------------------------------------------------
    def refresh_list(self):
        """Rebuild the left element list from the document."""
        sel_id = self.selected.get("id") if self.selected else None
        self.el_store.clear()
        for el in self.visible_elements():
            self.el_store.append([bool(el.get("visible", True)),
                                  el.get("id", "?"),
                                  el.get("type", "?"), el])
        # Restore selection.
        if sel_id:
            for row in self.el_store:
                if row[3].get("id") == sel_id:
                    self.el_tree.get_selection().select_iter(row.iter)
                    break

    def refresh_props(self):
        """Fill the properties panel from the selected element."""
        self._updating_props = True
        try:
            el = self.selected
            for key, w in self.prop_widgets.items():
                if el is None:
                    self._set_widget_value(w, key, None)
                    w.set_sensitive(False)
                    continue
                w.set_sensitive(True)
                self._set_widget_value(w, key, el.get(key))
            self.visible_check.set_sensitive(el is not None)
            self.mobile_check.set_sensitive(el is not None)
            if el is not None:
                self.visible_check.set_active(bool(el.get("visible", True)))
                self.mobile_check.set_active(bool(el.get("mobile_only",
                                                         False)))
                asset = el.get("asset")
                self.asset_label.set_markup(
                    f"<small>Asset: <i>{asset}</i></small>" if asset
                    else "<small>Asset: <i>none</i></small>")
                # Show the element's description (plain-language explanation).
                desc = el.get("description", "")
                self.desc_label.set_text(desc if desc else "—")
            else:
                self.asset_label.set_markup("<small>Asset: <i>—</i></small>")
                self.desc_label.set_text("—")
        finally:
            self._updating_props = False

    @staticmethod
    def _set_widget_value(w, key, value):
        """Push one element property into its widget."""
        if isinstance(w, Gtk.Label):
            w.set_text(str(value) if value is not None else "—")
        elif isinstance(w, Gtk.Entry):
            w.set_text(str(value) if value is not None else "")
        elif isinstance(w, Gtk.ComboBoxText):
            w.set_active_id(str(value) if value is not None else "")
            if w.get_active() < 0:
                w.set_active(0)
        elif isinstance(w, Gtk.SpinButton):
            try:
                w.set_value(float(value or 0))
            except Exception:
                w.set_value(0)

    def on_prop_changed(self, widget, key):
        """A properties-panel widget changed: write back to the element."""
        if self._updating_props or self.selected is None:
            return
        el = self.selected
        if key == "visible":
            el["visible"] = widget.get_active()
        elif key == "mobile_only":
            el["mobile_only"] = widget.get_active()
        elif key in ("type", "anchor"):
            val = widget.get_active_id()
            if val:
                el[key] = val
        elif key == "label":
            el["label"] = widget.get_text()
        elif key in ("x", "y", "width", "height"):
            el[key] = int(widget.get_value())
            if key in ("width", "height"):
                el[key] = max(8, el[key])
        else:
            return
        self._dirty = True
        self.refresh_list()
        self.canvas.queue_draw()
