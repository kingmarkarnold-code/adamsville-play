# Adamsville Suite Core

One shared library for the whole editor suite — Joshua's
no-repeated-code law (2026-10-17): *"if I need a canvas for one
application I should use the same canvas for another application."*

## Contracts (what an app may rely on)

- **`github_sync`** — `open_connection()` returns ONE explicit
  HTTPS connection per work leg; a save round trip pushes on one
  connection, CLOSES it, and proof-downloads on a FRESH one
  (Joshua's connection design, 2026-10-16). `push_targets()` /
  `fetch_file()` / `fetch_file_progress()` / `fetch_file_meta()`
  return `(result, error)` pairs and never raise for network
  states. `push_file()` retries a 409 SHA conflict ONCE with a
  freshly read SHA (the Map Editor 1.9.4 fix). `round_trip()`
  performs the standing save rule as one operation over plain
  targets (local save -> push -> close -> fresh proof download
  -> the caller's verify gate), and `fetch_with_retries()` is
  the download retry policy (network errors retried on fresh
  connections; HTTP answers never). Token lives at
  `~/.local/share/adamsville-suite/github_token`
  (mode 600), shared by all apps; never logged.
- **`shared_cache`** — `CachedFetcher(fetch_file, fetch_meta,
  fetch_file_progress)` is the one download door: bytes are served
  from `~/.local/share/adamsville-suite/cache/` only when their
  sha matches the freshly fetched manifest (or the Contents-API
  blob sha); downloads verify, store atomically, and fail open to
  a STALE-marked cache copy when the network is down.
- **`ground`** — `GroundModel(elev)` is the game's ground
  (heightAt + terrainMeshY ports, verified against the game's own
  JS). `GroundWithLifts(base, lifts)` adds the game's terrain-lift
  term. `drape_y(x, z)` is the shipped road height:
  `terrainMeshY + 0.01`, r3. `densify_range()` segments one arc
  range of a road; `fit_gaussian_profile()` solves lift amplitudes
  for a wanted hill profile.
- **`viewport3d`** — `Viewport3D` draws a terrain patch + road
  ribbons from plain data + callbacks (`on_station_pick`,
  `on_ground_pick`, `on_lift_drag`). It owns no files and no math
  beyond projection.
- **`snapshot_view`** — the building-snapshot renderer: a plain
  scene dict in (subject building + ground + front street +
  neighbours), pixels out; the front wall in warm orange with
  FRONT label/arrow. `render_scene()` + `SceneView` widget.
- **`layout`** — `screen_class()` → `("laptop"|"desktop", w, h)`;
  `scrolled()` wraps long panes (optional policy / min-content
  arguments); the divider guarantees — `paned()` (both children
  shrink), `even_split()`, `SplitMemory` (a dragged divider is
  remembered), `anchored_overlay()`, `ellipsized_label()`;
  `WindowState` remembers window sizes and pane positions
  across sessions.
- **`about`** — `show_about_dialog(parent, app_name, version,
  icon_name, package_name)`; version shown large and bold.
- **`updater`** — BOTH halves. The CHECK half:
  `check_for_update(app_repo_dir, version, fetch_file)` reads
  `editors/<app>/version.json` fresh and fails open;
  `show_update_result()` presents the outcome. The APPLY half
  (the Building Editor's shipped in-place updater):
  `check_for_updates_gui(parent, app_name, version, slug,
  manifest_url)` — staged, sha256-verified, backed-up update,
  applied via `--apply` under pkexec.
- **`suite_draw`** — Draw for Mollie: the Python drawing citizen
  (five inks, four sizes, free/straight/curve strokes, eraser,
  undo; palette collapses while drawing). `DrawPanel` is the
  widget; `send_drawing()` pushes to the repo's `drawings/`
  folder by the suite save law.

## Consumers

- Elevation Editor 1.0.0 — first consumer (vendored snapshot of
  this package in its install tree; source of truth is here).
- Building Editor 2.0.0 — vendored the flat files as they stood
  the night it shipped (its `suite_draw.py` is byte-identical
  to the core's; its github_sync / shared_cache / about copies
  differ from the package only in header notes; its updater is
  the APPLY half now carried in `suite_core/updater.py`). It
  adopts the merged package at its next build.
- Map Editor 1.9.x / UI Editor 1.8.0 still ship their own
  snapshots of the adopted modules from before the core
  existed; each adopts the core at its next rebuild. Fixes land
  HERE first.

## Consolidation (2026-10-18) — one shape, as recommended

`EXTRACTION-REPORT.md` §4 has been EXECUTED. The flat pass's
additions were merged into this package: `round_trip()` +
`fetch_with_retries()` + the 409-retry into `github_sync.py`;
`paned()` / `even_split()` / `SplitMemory` /
`anchored_overlay()` / `ellipsized_label()` / `hscroll_row()`
into `layout.py` (whose `scrolled()` gained the flat options
while keeping its original defaults — the behaviour Elevation
Editor 1.0.0 ships); `snapshot_view.py` in beside
`viewport3d.py`; `suite_draw.py` in as the package's drawing
citizen; and `updater.py` now carries both updater halves (see
above). The top-level flat files remain as COMPATIBILITY SHIMS
that hand the importer the package module itself — one
implementation, never two. The pre-merge tree is preserved at
`~/workspace/editors/suite-core-backup-2026-10-18-pre-merge/`.
`selftest.py` proves the merged package (39 checks). Do not let
a third shape appear.

## Repo home

`editors/suite-core/` in the adamsville-play repo (declared in
`tools/inventory-registry.json` as suite tooling). This directory
is the working source of truth; the repo copy is its published
mirror, pushed the same way the editors' sources are.

## Provenance

`github_sync.py`, `shared_cache.py`, `about.py` adopted verbatim
(bar header notes) from Building Editor 1.7.2 — the proven copies.
`ground.py` adopted from Map Editor 1.9.x and extended with the
lift term. `viewport3d.py`, `layout.py`, `updater.py` written new
for the core, shareable-first.
