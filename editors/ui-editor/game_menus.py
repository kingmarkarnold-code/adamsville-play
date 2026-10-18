#!/usr/bin/env python3
"""
Adamsville UI Resource Editor (Native) — the game's CURRENT menus,
derived from the game's own files (v1.9.0).

Why this module exists (Joshua's report, 2026-10-18): the Menus tab
showed the menus from menu_layout.json — but the game had grown new
menus and new Settings rows (Pause, Go To, Move controls, Advanced
Properties, Download newest UI, ...) that were never added to that
file, so the tab's list fell behind the game. The file was being
downloaded faithfully; the FILE was stale.

The fix, per Joshua's editor-data rule (every list an editor shows
is downloaded from GitHub, never baked into the app): the tab now
ALSO downloads the game's own menu-bearing files — detailed/
index.html (the panels), detailed/goto.js (builds the Go To panel
in code), detailed/hud_move.js (adds buttons to the Move controls
bar in code) — and DERIVES the game's menu inventory from them:

  derive_inventory(index_html, goto_js, hud_move_js)
      -> {menu_key: {"title", "description", "panel",
                     "groups": [{"name", "items": [item, ...]}],
                     "ungrouped": [item, ...]}}
      item: {"id", "label", "kind"} — kind is "button", "option"
      (a launcher checkbox), "select", or "list" (a dynamic list
      container). Kind lives ONLY in the inventory; the saved
      menu_layout.json keeps its established item shape.

  reconcile_menu_doc(doc, inventory) -> (doc, report)
      Merges the inventory into the editor's menu document:
      menus/items the game has but the document lacks are ADDED
      (at their game-relative positions, with seeded plain-language
      descriptions); everything already in the document — Joshua's
      renamed labels, groups, ordering, visibility, start states —
      is preserved exactly. Items/menus in the document but NOT in
      the current game are KEPT and reported as orphans (never
      silently deleted — Joshua's never-delete rule).

What is still hand-written here, honestly: the PANEL TABLE below
(which panel element is which menu, with its title) and the seeded
descriptions. Panel ITEMS are always derived from the downloaded
files, never listed here. Panels are ALSO auto-discovered: any
top-level card-like <div> with buttons that is not in the table is
derived with a title from its own heading, so a future game panel
shows up even before this table learns its name. A table entry
whose panel is absent from the downloaded game is skipped.

Pure Python (html.parser + re). No GTK, no network — data.py does
the downloading (through the suite shared cache) and menus.py does
the showing. Joshua's rule: all code commented.
"""

import copy
import re
from html.parser import HTMLParser


# ---------------------------------------------------------------------------
# The panel table: menu key -> where the game keeps that menu.
# "panel" is the element id in the game file named by "source".
# "title" is the menu's name in the editor's list. Panels marked
# "sections": True read their group names from in-panel headings
# (the launcher); all other panels treat their first heading as the
# title and later headings as group names.
# ---------------------------------------------------------------------------
PANELS = [
    # Settings' leading rows sit under no heading in the game; the
    # document has always grouped them as "General" (the section
    # after the "Administrator" heading is that group), so the
    # derivation names the leading section the same way.
    {"key": "settings", "panel": "settings", "source": "index",
     "title": "Settings", "leading_group": "General"},
    {"key": "gameplay", "panel": "gameplay", "source": "index",
     "title": "Gameplay"},
    {"key": "pause", "panel": "pause-overlay", "source": "index",
     "title": "Paused"},
    {"key": "advprops", "panel": "advprops", "source": "index",
     "title": "Advanced Properties",
     "list_items": {"adv-zone-list": "(Zone list)"}},
    {"key": "advpass", "panel": "advpass", "source": "index",
     "title": "Zone Password"},
    {"key": "zonepick", "panel": "zonepick", "source": "index",
     "title": "What zone?",
     "list_items": {"zonepick-list": "(Zone list)"}},
    {"key": "saveexit", "panel": "saveexit", "source": "index",
     "title": "Save game?"},
    {"key": "slotpick", "panel": "slotpick", "source": "index",
     "title": "Choose a save slot",
     "list_items": {"slotpick-list": "(Save slot list)"}},
    {"key": "admconfirm", "panel": "adm-confirm", "source": "index",
     "title": "Confirm Re-download"},
    {"key": "zoneload", "panel": "zone-load-overlay", "source": "index",
     "title": "Unlocking Zone"},
    {"key": "inventory", "panel": "inv-panel", "source": "index",
     "title": "Inventory",
     "list_items": {"inv-list": "(Item list)"}},
    {"key": "npcdialog", "panel": "npc-dialog", "source": "index",
     "title": "Conversation"},
    {"key": "fullmap", "panel": "fullmap", "source": "index",
     "title": "Full Map"},
    {"key": "satview", "panel": "satview-ui", "source": "index",
     "title": "Satellite View"},
    {"key": "hudmove", "panel": "hud-move-bar", "source": "index",
     "title": "Move Controls",
     "extra_source": "hud_move"},
    {"key": "goto", "panel": "goto-panel", "source": "goto",
     "title": "Go To"},
    {"key": "launcher", "panel": "launcher", "source": "index",
     "title": "Launch Options", "sections": True},
    {"key": "help", "panel": "help", "source": "index",
     "title": "How to play"},
]

# Menu keys in the order the editor lists them: the PANELS order,
# with auto-discovered panels (not in the table) after, in game
# order. (dict preserves insertion order — derive_inventory builds
# in exactly this order.)

# Panels that exist in index.html but are NOT menus: the loading
# screen (its buttons belong to the critical-failure flow, and the
# menu applier must never restyle the boot path) and the radio
# stepper (a HUD widget, positioned by the Layout tab like other
# HUD elements). Named here so auto-discovery skips them on purpose,
# not by accident.
NOT_MENUS = {"loader", "radio"}

# Menu descriptions seeded for menus the document does not have yet
# (menus already in the document keep their own descriptions).
MENU_DESCRIPTIONS = {
    "pause": "The pause menu: shown when the game is paused "
             "(Escape or the pause button). Resume, or open Move "
             "controls to rearrange the on-screen controls.",
    "advprops": "Advanced Properties: zone unlocking by password. "
                "One row per zone (built by the game), Unlock All "
                "Zones, and Back to Settings.",
    "advpass": "The zone password dialog: type the zone's password "
               "to unlock it (or the Unlock All password).",
    "slotpick": "Save-slot picker: shown after Save / Save and "
                "Exit — pick one of the save slots.",
    "admconfirm": "Confirmation asked before a manual re-download: "
                  "names the asset and its current version; Yes "
                  "wipes the old files and downloads fresh, No "
                  "cancels.",
    "zoneload": "The zone-unlock download screen: progress bar "
                "while the unlocked zone's data downloads; Retry, "
                "Cancel, or Continue when it lands.",
    "inventory": "The backpack inventory panel: what the player is "
                 "carrying, with a Close button. Items are listed "
                 "by the game.",
    "npcdialog": "The conversation box shown when talking to a "
                 "person in the game: their name, what they say, "
                 "and the Bye button.",
    "fullmap": "The full map overlay: the whole map, a legend, and "
               "buttons for Satellite View, GPS Navigate, and "
               "clearing the GPS route.",
    "satview": "Satellite view controls: switch 2D/3D, zoom in and "
               "out, re-center on the player, and close.",
    "hudmove": "The Move controls bar: shown while arranging the "
               "on-screen controls — drag controls to their spots; "
               "Select control lists them, Reset restores the "
               "screen's designed layout, Done finishes.",
    "goto": "The Go To panel: search the game's streets and places "
            "by name and travel straight there. Opened by the "
            "compass button or from Settings.",
}

# Item descriptions seeded for items the document does not have yet,
# in the same one-sentence style as menu_layout.json's own text.
# Items already in the document keep their own descriptions; an
# item with no seed here gets FALLBACK_DESCRIPTION.
ITEM_DESCRIPTIONS = {
    "set-advprops": "Opens Advanced Properties — zone unlocking "
                    "by password.",
    "set-movecontrols": "Opens Move controls: drag the on-screen "
                        "controls to where you want them on this "
                        "screen.",
    "set-goto": "Opens Go To: search a street or place by name "
                "and travel straight there.",
    "adm-hrapply": "Applies a downloaded UI update right away and "
                   "puts you back where you were playing.",
    "adm-uiflow": "Downloads the newest UI files from GitHub "
                  "(only the changed ones, verified), then reloads "
                  "the game into them where you left off.",
    "launch-drawdist": "How far the game draws the world: Short "
                       "(fastest), Medium, or Long.",
    "launch-quality": "Graphics quality: Auto lets the game step "
                      "quality up and down to hold its frame rate; "
                      "or lock Full / High / Medium / Low.",
    "pause-resume": "Closes the pause menu and resumes play.",
    "pause-move": "Opens Move controls from the pause menu: "
                  "rearrange the on-screen controls.",
    "adv-zone-list": "The zone rows the game builds here: one per "
                     "zone, showing locked/unlocked; tapping a "
                     "locked zone asks for its password.",
    "adv-unlock-all": "Asks for the Unlock All password and "
                      "unlocks every zone at once.",
    "adv-back": "Returns to Settings.",
    "advpass-ok": "Tries the typed password: unlocks the zone "
                  "(or all zones) if it matches.",
    "advpass-cancel": "Closes the password dialog without "
                      "unlocking anything.",
    "slotpick-list": "The save slots the game lists here: pick one "
                     "to save into (an occupied slot asks before "
                     "overwriting).",
    "slotpick-cancel": "Closes the slot picker without saving.",
    "adm-confirm-yes": "Confirms the re-download: old files of "
                       "that type are wiped and downloaded fresh.",
    "adm-confirm-no": "Cancels the re-download — nothing is "
                      "changed.",
    "zone-load-retry": "Retries the zone download after a failure.",
    "zone-load-cancel": "Cancels the unlock — the zone stays "
                        "locked.",
    "zone-load-continue": "Continues into the unlocked zone once "
                          "its data has downloaded.",
    "inv-list": "The items the player is carrying, listed by the "
                "game; tapping an item can drop it.",
    "inv-close": "Closes the inventory panel.",
    "npc-dialog-bye": "Ends the conversation.",
    "fullmap-close": "Closes the full map and returns to the game.",
    "satview-btn": "Opens Satellite View from the full map.",
    "gps-nav-btn": "Starts GPS navigation to the tapped point on "
                   "the map.",
    "gps-clear-btn": "Clears the current GPS route.",
    "satview-mode": "Switches Satellite View between 2D and 3D.",
    "satview-zin": "Zooms Satellite View in.",
    "satview-zout": "Zooms Satellite View out.",
    "satview-recenter": "Centers Satellite View back on the "
                        "player.",
    "satview-close": "Closes Satellite View.",
    "hud-move-reset": "Restores this screen's designed control "
                      "layout (undoes your dragging).",
    "hud-move-done": "Finishes arranging and returns to the game.",
    "hud-move-select": "Lists every movable control by name — "
                       "pick one to select it (off-screen controls "
                       "can be brought back to the center).",
    "hud-move-hide": "Collapses the Move controls bar to its slim "
                     "tab so the screen is clear for dragging.",
    "hud-move-tab": "The collapsed Move controls tab: tap to bring "
                    "the bar back.",
    "goto-close": "Closes the Go To panel.",
}

# Used when a game item has no seed above (a future game addition).
# The editor shows it verbatim, so the gap is visible, not hidden.
FALLBACK_DESCRIPTION = (
    "New in the current game — no description written yet. "
    "(Added automatically so this list matches the game; "
    "write a description here.)")


# ---------------------------------------------------------------------------
# A tiny DOM over html.parser — just enough to walk panels in
# document order. The game's index.html is well-formed enough for
# this; malformed fragments degrade to fewer panels, never a crash.
# ---------------------------------------------------------------------------
_VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img",
              "input", "link", "meta", "source", "track", "wbr"}


class _Node:
    """One parsed element: tag, attrs, children, own text chunks."""

    __slots__ = ("tag", "attrs", "children", "text")

    def __init__(self, tag, attrs):
        self.tag = tag
        self.attrs = attrs
        self.children = []
        self.text = ""


class _Dom(HTMLParser):
    """Parse HTML into _Node trees; by_id maps element id -> _Node."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("#root", {})
        self.stack = [self.root]
        self.by_id = {}
        self.in_order = []          # every element, document order

    def _add(self, tag, attrs, push):
        node = _Node(tag, dict(attrs))
        self.stack[-1].children.append(node)
        self.in_order.append(node)
        if node.attrs.get("id"):
            self.by_id.setdefault(node.attrs["id"], node)
        if push:
            self.stack.append(node)

    def handle_starttag(self, tag, attrs):
        self._add(tag, attrs, tag not in _VOID_TAGS)

    def handle_startendtag(self, tag, attrs):
        self._add(tag, attrs, False)

    def handle_endtag(self, tag):
        # Pop back to the matching open tag (tolerant of misnesting).
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].text += data


def _walk(node):
    """Yield node and its descendants in document order."""
    yield node
    for child in node.children:
        yield from _walk(child)


def _text(node):
    """All text inside a node, whitespace-normalized."""
    parts = [node.text]
    for child in node.children:
        parts.append(_text(child))
    return " ".join(" ".join(parts).split())


def _visible_label(node):
    """
    The label a player sees on a button: its text when the text has
    letters/digits; for symbol-only buttons (✕, ×, +) prefer the
    title attribute, then aria-label, then the symbol itself.
    """
    text = _text(node)
    if re.search(r"[A-Za-z0-9]", text):
        return text
    for attr in ("title", "aria-label"):
        val = node.attrs.get(attr)
        if val and val.strip():
            return val.strip()
    return text


def _clean_heading(text):
    """Heading text with leading emoji/symbols stripped, so a game
    heading like '⚙️ PERFORMANCE' names the group 'PERFORMANCE' —
    the name menu_layout.json has always used."""
    return re.sub(r"^[^A-Za-z0-9]+", "", text).strip()


# ---------------------------------------------------------------------------
# Panel extraction
# ---------------------------------------------------------------------------
def _panel_items(panel_node, spec):
    """
    Extract (groups, ungrouped) from one panel element, in game
    order. Groups come from headings (see PANELS note); list
    containers named in spec["list_items"] appear as "list" items
    at their document position; the launcher's checkboxes/selects
    become "option"/"select" items keyed like menu_layout.json
    ("opt-<data-opt>" for checkboxes).
    """
    groups = []                     # [{"name", "items"}]
    ungrouped = []
    leading = []                    # items before the first section
    current = leading               # item list being filled
    seen_heading = False
    sections_mode = bool(spec.get("sections"))
    list_items = spec.get("list_items", {})

    def open_group(name):
        """Start (or reuse) the group for a section heading."""
        for grp in groups:
            if grp["name"] == name:
                return grp["items"]
        grp = {"name": name, "items": []}
        groups.append(grp)
        return grp["items"]

    for node in _walk(panel_node):
        if node is panel_node:
            continue
        if node.tag in ("h1", "h2", "h3", "h4"):
            name = _clean_heading(_text(node))
            if not name:
                continue
            if not seen_heading and not sections_mode:
                # First heading of a normal panel is its title.
                seen_heading = True
                continue
            seen_heading = True
            current = open_group(name)
            continue
        nid = node.attrs.get("id")
        if nid and nid in list_items:
            current.append({"id": nid, "label": list_items[nid],
                            "kind": "list"})
            continue
        if node.tag == "button" and nid:
            current.append({"id": nid, "label": _visible_label(node),
                            "kind": "button"})
            continue
        if node.tag == "input" and node.attrs.get("data-opt"):
            # A launcher option checkbox. Its visible label is the
            # .opt-label span inside the wrapping <label>.
            label = ""
            current.append({"id": "opt-" + node.attrs["data-opt"],
                            "label": label, "kind": "option",
                            "_wrap": node})
            continue
        if node.tag == "select" and nid:
            current.append({"id": nid, "label": "", "kind": "select",
                            "_wrap": node})
            continue
    # The leading section: when the panel spec names a leading
    # group (Settings' "General") and the panel HAS section
    # headings, the leading items form that group; otherwise they
    # stay ungrouped, as they do in every heading-less panel.
    if leading:
        if groups and spec.get("leading_group"):
            groups.insert(0, {"name": spec["leading_group"],
                              "items": leading})
        else:
            ungrouped = leading + ungrouped
    # Second pass: fill option/select labels from their wrapping
    # <label> element's .opt-label span (needs parent context, so it
    # runs over the panel tree rather than the flat item list).
    _fill_option_labels(panel_node, groups, ungrouped)
    for lst in [ungrouped] + [g["items"] for g in groups]:
        for item in lst:
            item.pop("_wrap", None)
    return groups, ungrouped


def _fill_option_labels(panel_node, groups, ungrouped):
    """
    Launcher options live in <label class="launch-opt"> wrappers:
    the text a player reads is the .opt-label span inside. Match
    each option/select item (by its data-opt / id, in document
    order) to its wrapper's span text.
    """
    targets = []
    for lst in [ungrouped] + [g["items"] for g in groups]:
        for item in lst:
            if item["kind"] in ("option", "select") and "_wrap" in item:
                targets.append(item)
    if not targets:
        return
    wrappers = [n for n in _walk(panel_node)
                if n.tag == "label"]
    by_key = {}
    for wrap in wrappers:
        span = None
        key = None
        for desc in _walk(wrap):
            if desc.tag == "span" and \
                    "opt-label" in desc.attrs.get("class", ""):
                span = desc
            if desc.tag == "input" and desc.attrs.get("data-opt"):
                key = "opt-" + desc.attrs["data-opt"]
            if desc.tag == "select" and desc.attrs.get("id"):
                key = desc.attrs["id"]
        if key and span is not None:
            by_key[key] = _text(span)
    for item in targets:
        item["label"] = by_key.get(item["id"], item["id"])


def _goto_items(goto_js_text):
    """
    The Go To panel is built by goto.js, not written in index.html:
    its one static button is goto-close, inside the panel markup
    string. Extract button ids from that markup (the results list
    and status line are search output, not menu items).
    """
    items = []
    if not goto_js_text:
        return items
    # The panel's innerHTML string: ids in order of appearance.
    m = re.search(r"elPanel\.innerHTML\s*=\s*(.*?);\n", goto_js_text,
                  re.DOTALL)
    markup = m.group(1) if m else goto_js_text
    for bid in re.findall(r"<button[^>]*id=\"([^\"]+)\"", markup):
        label = "✕" if bid == "goto-close" else bid
        if bid == "goto-close":
            label = "Close Go to"
        items.append({"id": bid, "label": label, "kind": "button"})
    return items


def _hudmove_extra_items(hud_move_js_text):
    """
    hud_move.js ADDS buttons to the Move controls bar at runtime
    (hud-move-select, hud-move-hide) plus the collapsed tab
    (hud-move-tab): created with .id = '...' and .textContent =
    '...' lines. Extract those (id, text) pairs in file order.
    """
    items = []
    if not hud_move_js_text:
        return items
    for m in re.finditer(
            r"\.id\s*=\s*'(hud-move-[a-z-]+)'\s*;\s*\n\s*\w+\.textContent"
            r"\s*=\s*'([^']*)'", hud_move_js_text):
        items.append({"id": m.group(1), "label": m.group(2),
                      "kind": "button"})
    return items


def derive_inventory(index_html, goto_js, hud_move_js):
    """
    Derive the game's menu inventory from its own files.

    index_html / goto_js / hud_move_js: the files' TEXT (any may be
    None/empty when a download failed — that source is skipped).
    Returns an insertion-ordered dict menu_key -> menu inventory
    (see module docstring). Panels whose element is absent from the
    files are skipped (a table entry never invents a menu).
    """
    inventory = {}
    dom = None
    if index_html:
        dom = _Dom()
        try:
            dom.feed(index_html)
        except Exception:
            dom = None
    known_panels = set()
    if dom is not None:
        for spec in PANELS:
            if spec["source"] != "index":
                continue
            node = dom.by_id.get(spec["panel"])
            if node is None:
                continue
            known_panels.add(spec["panel"])
            groups, ungrouped = _panel_items(node, spec)
            if spec["key"] == "hudmove":
                # The bar's runtime-added buttons (hud_move.js).
                extra = _hudmove_extra_items(hud_move_js)
                have = {i["id"] for i in ungrouped}
                ungrouped += [i for i in extra if i["id"] not in have]
            inventory[spec["key"]] = {
                "title": spec["title"], "panel": spec["panel"],
                "description": MENU_DESCRIPTIONS.get(spec["key"], ""),
                "groups": groups, "ungrouped": ungrouped}
        # The Go To panel (built by goto.js).
        goto_spec = next(s for s in PANELS if s["key"] == "goto")
        gitems = _goto_items(goto_js)
        if gitems:
            inventory["goto"] = {
                "title": goto_spec["title"],
                "panel": goto_spec["panel"],
                "description": MENU_DESCRIPTIONS.get("goto", ""),
                "groups": [], "ungrouped": gitems}
        # Order: PANELS order first (goto sits in its table slot),
        # which the dict above already follows except goto was
        # appended late — rebuild in table order.
        ordered = {}
        for spec in PANELS:
            if spec["key"] in inventory:
                ordered[spec["key"]] = inventory[spec["key"]]
        for key, val in inventory.items():
            ordered.setdefault(key, val)
        inventory = ordered
        # Auto-discovery: any other outermost button-bearing panel
        # <div> in index.html is a menu the table doesn't know yet.
        # "Outermost": anything inside a known panel, inside a
        # NOT_MENUS panel, or inside an earlier candidate is part of
        # that panel, not a menu of its own (satview-controls lives
        # inside satview-ui; the loader's inner divs are not menus).
        covered = set()
        for pid in list(known_panels) + list(NOT_MENUS):
            pnode = dom.by_id.get(pid)
            if pnode is not None:
                for desc in _walk(pnode):
                    if desc.attrs.get("id"):
                        covered.add(desc.attrs["id"])
        for node in dom.in_order:
            if node.tag != "div" or not node.attrs.get("id"):
                continue
            pid = node.attrs["id"]
            if pid in known_panels or pid in NOT_MENUS \
                    or pid in covered:
                continue
            desc = list(_walk(node))
            if not any(d.tag == "button" for d in desc):
                continue
            # This div is a panel: everything inside it is covered.
            for d in desc:
                if d.attrs.get("id"):
                    covered.add(d.attrs["id"])
            spec = {"key": pid, "panel": pid, "source": "index",
                    "title": None}
            groups, ungrouped = _panel_items(node, spec)
            title = pid.replace("-", " ").title()
            for d in _walk(node):
                if d.tag in ("h1", "h2", "h3"):
                    title = _clean_heading(_text(d)) or title
                    break
            key = re.sub(r"[^a-z0-9]+", "", pid.lower()) or pid
            if key in inventory:
                continue
            inventory[key] = {
                "title": title, "panel": pid,
                "description": MENU_DESCRIPTIONS.get(key, ""),
                "groups": groups, "ungrouped": ungrouped,
                "discovered": True}
    return inventory


# ---------------------------------------------------------------------------
# Reconciliation: merge the inventory into the editor's document.
# ---------------------------------------------------------------------------
def _seed_item(inv_item):
    """A document item for a game item the document lacks."""
    return {"id": inv_item["id"],
            "label": inv_item.get("label") or inv_item["id"],
            "description": ITEM_DESCRIPTIONS.get(
                inv_item["id"], FALLBACK_DESCRIPTION),
            "action": "",
            "visible": True}


def _all_item_ids(menu):
    """Every item id in a document menu (groups + ungrouped)."""
    ids = set()
    for grp in menu.get("groups", []):
        for item in grp.get("items", []):
            ids.add(item.get("id"))
    for item in menu.get("ungrouped", []):
        ids.add(item.get("id"))
    return ids


def _insert_at_game_position(container, game_items, new_item):
    """
    Insert new_item into a document item list at the position the
    game implies: after the last game item (in this container's
    game order) already present in the container; else before the
    first present one; else at the end. Joshua's own ordering of
    existing items is never disturbed.
    """
    present_ids = [it.get("id") for it in container]
    game_ids = [gi["id"] for gi in game_items]
    new_pos = game_ids.index(new_item["id"])
    # Last preceding game item that is present in the container.
    for prev in reversed(game_ids[:new_pos]):
        if prev in present_ids:
            container.insert(present_ids.index(prev) + 1, new_item)
            return
    # Otherwise before the first following present game item.
    for nxt in game_ids[new_pos + 1:]:
        if nxt in present_ids:
            container.insert(present_ids.index(nxt), new_item)
            return
    container.append(new_item)


def reconcile_menu_doc(doc, inventory):
    """
    Merge the derived inventory into a menu document.

    Returns (new_doc, report) — the input doc is not mutated.
    report: {"added_menus": [keys], "added_items": {key: [ids]},
             "orphan_items": {key: [ids]}, "orphan_menus": [keys],
             "ui_version": None} (the caller fills ui_version).
    Existing document content always wins: labels, descriptions,
    groups (including Joshua's custom ones), ordering, visibility
    and group start states are preserved; the inventory only ADDS
    what the game has and the document lacks.
    """
    new_doc = copy.deepcopy(doc) if isinstance(doc, dict) \
        else {"menus": {}, "version": 1}
    menus = new_doc.setdefault("menus", {})
    report = {"added_menus": [], "added_items": {},
              "orphan_items": {}, "orphan_menus": []}
    if not inventory:
        return new_doc, report

    for key, inv_menu in inventory.items():
        inv_groups = inv_menu.get("groups", [])
        inv_ungrouped = inv_menu.get("ungrouped", [])
        if key not in menus:
            # A whole menu the document never had: adopt it whole,
            # in game order, with seeded descriptions.
            menu = {"title": inv_menu.get("title", key),
                    "description": inv_menu.get("description", ""),
                    "groups": [], "ungrouped": []}
            for grp in inv_groups:
                menu["groups"].append(
                    {"name": grp["name"],
                     "items": [_seed_item(i) for i in grp["items"]]})
            menu["ungrouped"] = [_seed_item(i) for i in inv_ungrouped]
            menus[key] = menu
            report["added_menus"].append(key)
            added = [i["id"] for g in inv_groups for i in g["items"]]
            added += [i["id"] for i in inv_ungrouped]
            if added:
                report["added_items"][key] = added
            continue
        menu = menus[key]
        have = _all_item_ids(menu)
        doc_groups = menu.setdefault("groups", [])
        doc_ungrouped = menu.setdefault("ungrouped", [])

        def group_list(name, game_groups):
            """The document group list for a game group name,
            creating the group (at its game-relative position among
            groups) when the document lacks it."""
            for grp in doc_groups:
                if grp.get("name") == name:
                    return grp.setdefault("items", [])
            new_grp = {"name": name, "items": []}
            game_names = [g["name"] for g in game_groups]
            pos = game_names.index(name)
            placed = False
            for later in game_names[pos + 1:]:
                for idx, grp in enumerate(doc_groups):
                    if grp.get("name") == later:
                        doc_groups.insert(idx, new_grp)
                        placed = True
                        break
                if placed:
                    break
            if not placed:
                doc_groups.append(new_grp)
            return new_grp["items"]

        added_here = []
        for grp in inv_groups:
            for inv_item in grp["items"]:
                if inv_item["id"] in have:
                    continue
                target = group_list(grp["name"], inv_groups)
                _insert_at_game_position(
                    target,
                    [i for i in grp["items"]],
                    _seed_item(inv_item))
                have.add(inv_item["id"])
                added_here.append(inv_item["id"])
        for inv_item in inv_ungrouped:
            if inv_item["id"] in have:
                continue
            _insert_at_game_position(doc_ungrouped, inv_ungrouped,
                                     _seed_item(inv_item))
            have.add(inv_item["id"])
            added_here.append(inv_item["id"])
        if added_here:
            report["added_items"][key] = added_here
        # Orphans: in the document, not in the current game. Kept —
        # reported so Joshua can see them, never deleted here.
        inv_ids = {i["id"] for g in inv_groups for i in g["items"]}
        inv_ids |= {i["id"] for i in inv_ungrouped}
        orphans = [i for i in _all_item_ids(menu) if i not in inv_ids]
        if orphans:
            report["orphan_items"][key] = sorted(orphans)
    for key in menus:
        if key not in inventory:
            report["orphan_menus"].append(key)
    # Menu order: game order first, orphan menus after (in their
    # document order). The editor lists menus in document order.
    ordered = {}
    for key in inventory:
        if key in menus:
            ordered[key] = menus[key]
    for key, val in menus.items():
        ordered.setdefault(key, val)
    new_doc["menus"] = ordered
    return new_doc, report
