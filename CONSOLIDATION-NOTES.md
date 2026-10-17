# Consolidation notes — 2026-10-16

On 2026-10-16 Joshua decided to consolidate every project repo into this one
(`adamsville-play`). Separate repos were meant to keep the editors out of the
game install, but the APK/game only ever read their own folders — folders, not
repos, are the boundary — and the split caused the editor↔game alignment
drifts found in the 2026-10-16 source-of-truth audit.

Everything below was **copied** here (one commit per source repo, every file
verified byte-for-byte by git blob SHA). The source repos were **not**
modified or emptied; they stand as archives until Joshua confirms the new
home.

| Folder | Copied from | Source head |
|---|---|---|
| `editors/map-editor/` | `adamsville-map-editor` | `725fb9e7` |
| `editors/elevation-editor/` | `adamsville-elevation-editor` | `d9cfabff` |
| `map-data/` | `map-data` | `eeadca5d` |
| `tools/watcher/` | `adamsville-watcher` | `c13bc744` |
| `viewers/web/` | `map-viewer-web` | `d2515438` |
| `viewers/android/` | `map-viewer-android` | `ad70f288` |
| `viewers/linux/` | `map-viewer-linux` | `2865b96b` |
| `surviving-adamsville/` | `surviving-adamsville` | `a8dd635d` |

Not copied (stale-audit candidates; the originals still exist in the source
repos): the watcher's four `*.bak-*` files, and the Linux viewer's generated
`__pycache__` bytecode.

Known follow-ups (not done in the consolidation pass):

- The installed editor apps still download/push against their original repos
  and update channels; repointing them to this repo is a separate job.
- The game's runtime overlays (`road_sync.js`, `building_spawner.js`,
  `terrain_sync.js`) still fetch the original editor repos. The Map Editor's
  `roads.json` and the game's zone roads are different networks (see the
  audit) — merging them is a deliberate decision for Joshua, not a copy.
- The camera-tilt watcher cron was repointed to
  `map-data/diagnostics/camera-tilt.json` in this repo on 2026-10-16.
- `editors/ui-editor/version.json` still declares 1.7.6 (the update channel
  is behind the 1.7.8 build) — flagged, not fixed.
