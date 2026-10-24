"""
The Pieces panel for the Map Editor (1.9.10, Joshua 2026-10-23).

WHY THIS EXISTS: Joshua's Blender recording. He selected one
spot; the count said 4 objects, only 3 were visible — a piece
stacked on the same ground was invisible and unclickable, and
nothing listed what his selection contained, so the extra piece
could not be singled out or removed. This panel is the editor
half of the fix, in two side-by-side sections:

  SELECTED PIECES — whenever the selection is non-empty, EVERY
  selected piece is listed here by name, class and length.
  Clicking a row ISOLATES that piece: the map frames it and
  lights it alone (the rest of the selection stays selected,
  drawn quiet), so a piece buried under another one becomes
  visible by itself. Each row's Delete button sends THAT ONE
  piece into the ordinary delete confirmation flow (the framed
  picture + the bar at the top of the map) — no new delete
  path, and Delete still removes the selected piece only.

  STACKED PIECES — the Find stacked button (here and on the
  toolbar) scans the loaded data in the background (the corner
  progress bar runs while it works) and lists what it found:
  Tier 1 "certain" first, then Tier 2 "review", longest first,
  each row saying WHY in plain words. Clicking a result frames
  and selects that piece; removing it is the ordinary Delete
  flow again. The finder never deletes anything itself.

LAYOUT: the panel docks BELOW the map (the canvas column's
lower sash), the two sections side by side. It does not share
the 3D inspector's column — the inspector's own internal split
needs that column's full height. The panel is a dock, NOT a
tool or mode: the editor still opens with no tool armed, and
selecting still only selects.

Joshua's rule: all code commented.
"""

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

import stacked
from data import CATEGORY_LABELS, normalize_category

# The invitation text over the results list, before any scan
# (and restored whenever stale results are dropped).
_FIND_INTRO = (
    "Pieces lying on top of other pieces are invisible on "
    "the map. Find stacked lists them by name so each one "
    "can be checked and, if it is an extra, deleted.")


class PiecesPanel(Gtk.Box):
    """The selection list + stacked-pieces finder dock."""

    def __init__(self, app):
        super().__init__(orientation=Gtk.Orientation.HORIZONTAL,
                         spacing=6)
        self.app = app
        self.set_margin_start(6)
        self.set_margin_end(6)
        self.set_margin_top(4)
        self.set_margin_bottom(4)
        # Signal guards: rebuilding a list must not read as
        # Joshua clicking rows.
        self._rebuilding = False
        self._sel_data = {}      # ListBoxRow -> (cat, flat_idx)
        self._result_data = {}   # ListBoxRow -> result dict
        self._results = []

        # ------------------------------------------------------
        # Left column: Selected pieces
        # ------------------------------------------------------
        sel_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                          spacing=4)
        sel_header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                             spacing=6)
        self.sel_title = Gtk.Label(label="Selected pieces")
        self.sel_title.set_xalign(0)
        sel_header.pack_start(self.sel_title, True, True, 0)
        # "Show all" ends an isolation: every selected piece
        # lights up equally again. Only sensitive while an
        # isolation is active.
        self.show_all_btn = Gtk.Button(label="Show all")
        self.show_all_btn.set_tooltip_text(
            "Stop singling one piece out — light every selected "
            "piece the same again.")
        self.show_all_btn.connect(
            "clicked", lambda _b: self.app.clear_isolation())
        self.show_all_btn.set_sensitive(False)
        sel_header.pack_start(self.show_all_btn, False, False, 0)
        sel_col.pack_start(sel_header, False, False, 0)

        self.sel_empty = Gtk.Label(
            label="Nothing selected. Click a road and every "
                  "piece in the selection is listed here — "
                  "including one buried under another piece.")
        self.sel_empty.set_line_wrap(True)
        self.sel_empty.set_xalign(0)
        sel_col.pack_start(self.sel_empty, False, False, 0)

        # Long panes scroll (suite law).
        sel_scroll = Gtk.ScrolledWindow()
        sel_scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                              Gtk.PolicyType.AUTOMATIC)
        sel_scroll.set_min_content_height(72)
        self.sel_list = Gtk.ListBox()
        self.sel_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.sel_list.connect("row-selected",
                              self._on_sel_row_selected)
        sel_scroll.add(self.sel_list)
        sel_col.pack_start(sel_scroll, True, True, 0)
        self.pack_start(sel_col, True, True, 0)

        self.pack_start(Gtk.Separator(
            orientation=Gtk.Orientation.VERTICAL),
            False, False, 2)

        # ------------------------------------------------------
        # Right column: Stacked pieces
        # ------------------------------------------------------
        find_col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                           spacing=4)
        find_header = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        find_title = Gtk.Label(label="Stacked pieces")
        find_title.set_xalign(0)
        find_header.pack_start(find_title, True, True, 0)
        self.find_btn = Gtk.Button(label="Find stacked")
        self.find_btn.set_tooltip_text(
            "Look through the loaded map for pieces lying on "
            "top of other pieces — duplicates, zero-length "
            "records, and pieces covered by another road. "
            "Nothing is deleted; the list is for review.")
        self.find_btn.connect(
            "clicked", lambda _b: self.app.start_find_stacked())
        find_header.pack_start(self.find_btn, False, False, 0)
        find_col.pack_start(find_header, False, False, 0)

        self.find_status = Gtk.Label(label=_FIND_INTRO)
        self.find_status.set_line_wrap(True)
        self.find_status.set_xalign(0)
        find_col.pack_start(self.find_status, False, False, 0)

        res_scroll = Gtk.ScrolledWindow()
        res_scroll.set_policy(Gtk.PolicyType.AUTOMATIC,
                              Gtk.PolicyType.AUTOMATIC)
        res_scroll.set_min_content_height(72)
        self.res_list = Gtk.ListBox()
        self.res_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.res_list.connect("row-selected",
                              self._on_result_row_selected)
        res_scroll.add(self.res_list)
        find_col.pack_start(res_scroll, True, True, 0)
        self.pack_start(find_col, True, True, 0)

    # ----------------------------------------------------------
    # Selected pieces section
    # ----------------------------------------------------------

    def refresh_selection(self):
        """
        Rebuild the selected-pieces list from the canvas
        selection. Called whenever the selection changes (the
        app's on_roads_selected funnels here). A piece whose
        isolation is active gets its row re-selected (without
        re-firing the isolate action).
        """
        app = self.app
        canvas = app.canvas
        sel = list(canvas.selected_roads)
        self._rebuilding = True
        for child in self.sel_list.get_children():
            self.sel_list.remove(child)
        self._sel_data = {}
        for cat, idx in sel:
            road = canvas._get_road_dict(cat, idx)
            if road is None:
                continue
            row = self._selection_row(cat, idx, road)
            self.sel_list.add(row)
            if canvas.isolated == (cat, idx):
                self.sel_list.select_row(row)
        self._rebuilding = False
        self.sel_list.show_all()
        n = len(self._sel_data)
        self.sel_title.set_text(
            f"Selected pieces ({n})" if n else "Selected pieces")
        self.sel_empty.set_visible(n == 0)
        self.show_all_btn.set_sensitive(canvas.isolated is not None)

    def _selection_row(self, cat, idx, road):
        """One selected piece: name, class + length, Delete."""
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                      spacing=6)
        texts = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                        spacing=1)
        name_label = Gtk.Label(label=stacked.display_name(road))
        name_label.set_xalign(0)
        name_label.set_ellipsize(3)  # Pango EllipsizeMode.END
        texts.pack_start(name_label, False, False, 0)
        meta = Gtk.Label(
            label=f"{CATEGORY_LABELS[normalize_category(cat)]}"
                  f" · {stacked.road_length(road.get('pts') or []):.0f} m"
                  f" · {self.app.zone_display_name(road.get('_zone'))}")
        meta.set_xalign(0)
        texts.pack_start(meta, False, False, 0)
        box.pack_start(texts, True, True, 0)
        # Delete for THIS piece only — the ordinary framed
        # confirmation flow, via the app.
        del_btn = Gtk.Button(label="Delete")
        del_btn.set_tooltip_text(
            "Delete this one piece. The map frames it and "
            "lights it up first — nothing is removed until you "
            "confirm in the bar at the top.")
        del_btn.connect(
            "clicked",
            lambda _b, c=cat, i=idx, r=road:
                self.app.delete_one_piece(c, i, r))
        box.pack_start(del_btn, False, False, 0)
        row = Gtk.ListBoxRow()
        row.add(box)
        self._sel_data[row] = (cat, idx)
        return row

    def _on_sel_row_selected(self, _listbox, row):
        """Clicking a row isolates that piece (frame + light it
        alone). Programmatic rebuilds are guarded out."""
        if self._rebuilding or row is None:
            return
        piece = self._sel_data.get(row)
        if piece is not None:
            self.app.isolate_selected_piece(*piece)

    # ----------------------------------------------------------
    # Stacked pieces section
    # ----------------------------------------------------------

    def set_scanning(self, scanning):
        """While a scan runs: the button rests and the status
        line says the corner bar is the one to watch."""
        self.find_btn.set_sensitive(not scanning)
        if scanning:
            self.find_status.set_text(
                "Looking for stacked pieces… (the progress bar "
                "in the bottom-right corner shows the scan)")

    def reset_results(self):
        """
        Drop any listed results (the data was reloaded or an
        undo restored different records — the rows would point
        at records that no longer exist) and restore the
        invitation text.
        """
        self._results = []
        self._rebuilding = True
        for child in self.res_list.get_children():
            self.res_list.remove(child)
        self._result_data = {}
        self._rebuilding = False
        self.find_status.set_text(_FIND_INTRO)

    def show_results(self, results):
        """
        Fill the results list from a finished scan (stacked.py
        result dicts, Tier 1 first, Tier 2 longest first). The
        rows keep their result dicts so a click can hand the
        exact record to the app.
        """
        self._results = list(results)
        self._fill_result_rows()
        self._results_status()

    def prune_results(self, live_ids):
        """
        Drop result rows whose record is no longer in the
        working copy (it was deleted through the Delete flow,
        or an undo replaced the records). live_ids is a set of
        id(road) for every record currently loaded. A stale row
        must never offer up a record that does not exist.
        """
        if not self._results:
            return
        kept = [r for r in self._results
                if id(r["road"]) in live_ids]
        if len(kept) == len(self._results):
            return
        self._results = kept
        self._fill_result_rows()
        self._results_status()

    def _fill_result_rows(self):
        """(Re)build the results ListBox from self._results."""
        self._rebuilding = True
        for child in self.res_list.get_children():
            self.res_list.remove(child)
        self._result_data = {}
        for result in self._results:
            row = self._result_row(result)
            self.res_list.add(row)
        self._rebuilding = False
        self.res_list.show_all()

    def _results_status(self):
        """The status line over the results list, from whatever
        results currently stand."""
        results = self._results
        certain = sum(1 for r in results
                      if r["tier"] == stacked.TIER_CERTAIN)
        review = len(results) - certain
        if results:
            self.find_status.set_text(
                f"Found {len(results)} stacked pieces "
                f"({certain} certain, {review} to review). "
                "Click one to see it on the map. Nothing was "
                "deleted — removing a piece is the ordinary "
                "Delete, after you check it.")
        else:
            self.find_status.set_text(
                "No stacked pieces found in the loaded map.")

    def _result_row(self, result):
        """One found piece: name, WHY in plain words, tier +
        class + zone + length."""
        road = result["road"]
        texts = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                        spacing=1)
        name_label = Gtk.Label(label=stacked.display_name(road))
        name_label.set_xalign(0)
        name_label.set_ellipsize(3)  # Pango EllipsizeMode.END
        texts.pack_start(name_label, False, False, 0)
        why_label = Gtk.Label(label=result["why"])
        why_label.set_xalign(0)
        why_label.set_line_wrap(True)
        texts.pack_start(why_label, False, False, 0)
        tier_word = ("Certain" if result["tier"] == stacked.TIER_CERTAIN
                     else "Review")
        meta = Gtk.Label(
            label=f"{tier_word}"
                  f" · {CATEGORY_LABELS[normalize_category(result['cat'])]}"
                  f" · {self.app.zone_display_name(result['zone'])}"
                  f" · {result['length']:.0f} m")
        meta.set_xalign(0)
        texts.pack_start(meta, False, False, 0)
        row = Gtk.ListBoxRow()
        row.add(texts)
        self._result_data[row] = result
        return row

    def _on_result_row_selected(self, _listbox, row):
        """Clicking a result frames + selects that piece on the
        map (the app owns the camera and the selection)."""
        if self._rebuilding or row is None:
            return
        result = self._result_data.get(row)
        if result is not None:
            self.app.reveal_stacked_piece(result)
