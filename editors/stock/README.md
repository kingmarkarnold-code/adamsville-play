# The stock shelf

*One shared shelf for placeable things — Joshua's rule (2026-10-17):
"If I create a table that can go into a house, it should become a
part of the stock resources we have on GitHub. That in turn makes the
list in the Building Editor refresh to show the new table."*

Stock is a first-class state in this repo: a file may sit here as
stock — present on purpose, available to every editor and the game —
before any program references it. An editor's list is a *view* over
this stock, never a private copy baked into an app.

## Shelves

- **`props/`** — prop and furniture 3D models (`.glb`), by category
  (dining, education, hospitality, nightlife, parks, residential,
  retail, worship). Each category carries a `SOURCES.md` with the
  models' provenance. *Born 2026-10-17: moved here from
  `editors/map-editor/blender/assets/`, where the library sat inside
  one editor's drawer. Same-named models repeat across categories on
  purpose (a dining table and a school table are different stock).*
- **`vocabularies/`** — *designated, not yet populated.* The Building
  Editor's pick-lists (floor-plan templates, fence styles, floor
  types, driveway materials, garage sides, house styles, decoration
  types) currently live inside the app's code. When they move out —
  a Building Editor change, made with the app, not by this shelf —
  their data files land here so any editor can read the same lists.

## Still on their home shelves (for now)

- **Building designs** — `editors/building-editor/design-buildings.json`
  is the design set's working home, because the Building Editor's own
  paths name it there. It is stock in every way that matters (the
  editor downloads it on open and pushes on save); moving it to this
  shelf is an app-aware step for later, not a file shuffle.
- **Game stock** — buildings, heroes, stations, vehicles, music and
  layouts live in `detailed/`, the game's own shelves, and move
  through the game's delivery manifests.

## Adding stock

1. Save the file onto the right shelf.
2. If no program references it yet, declare the shelf area in
   `tools/inventory-registry.json` — in the same change. (The
   `editors/stock/` shelf is already declared; files added under it
   are covered.)
3. Run `python3 tools/check_inventory.py` — it should pass.
