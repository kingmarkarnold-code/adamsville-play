# Adamsville Detail Editor

A standalone app in the editor suite (Joshua's design,
`game-map/detail-editor/DESIGN.md` in the workspace, 2026-10-18):
the fine-work editor the Map Editor's pieces go to. NOT a mode
inside the Map Editor — its own app, launched by the Map Editor's
**Detail Edit** button (which writes
`~/.local/share/adamsville-suite/open-in-detail-editor.json` and
starts `adamsville-detail-editor-native`), or opened directly and
fed through File -> Open Piece.

**Element-agnostic by design.** One manipulation core
(`app/element.py`) works on whatever element is handed to it —
POINTS, SEGMENTS, FACES — so the code exists once for the whole
suite. Roads are the first (and in 1.0.0 only) element type wired
in; the road adapter lives in `app/detaildata.py`.

**What it does to a road piece:** opens zoomed to the WHOLE piece
(all points, segments, and its face — the road surface ribbon);
moves a point by dragging (only that piece changes); adds/deletes
points; adds/deletes segments (deleting a middle segment breaks
the join and the piece saves as two records, same name); deletes a
whole SECTION — the bulge case from Joshua's drawing: bowed lines
AND the face inside them go, leaving only the straight edge.
**It never touches elevation:** points move in the flat plane
only; the record's baked heights are carried untouched (a new
point carries the height the road already has along its segment).

**Suite law, as everywhere:** data comes from GitHub (shared
suite cache, one zone at a time — never a whole-world load);
saves run the standing round trip (local save -> push -> close ->
fresh download -> the screen shows the downloaded copy); the
bottom-right progress bar covers background work; universal
viewport controls (drag pan, wheel/+/- zoom, Ctrl+drag rotate,
pinch, ORBIT); canvases are live only under the mouse and keep
their picture as a still otherwise; panes scroll/resize; tabs are
closable; no tool is armed at startup. Generic machinery is the
shared `suite_core` (vendored snapshot under `app/suite_core/`).

**Version:** 1.0.0 — `version.json` in this folder feeds
Help -> Check for Updates.
