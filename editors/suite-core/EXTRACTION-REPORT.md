# Suite-core extraction report — the round-trip / cache / layout / snapshot pass (2026-10-17)

Written by the extraction job briefed to pull the Building Editor
1.7.2's proven implementations into the shared core. It landed
CONCURRENTLY with the Elevation Editor build's own core pass
(the `suite_core/` package + `README.md` in this directory —
written by that job, not touched by this one). The two passes
are complementary, not rival; §4 below is the reconciliation
this report recommends. Nothing of the other pass was modified.

## 1. What this pass extracted (top level of this directory)

| File | Lines | Contents |
|---|---|---|
| `github_roundtrip.py` | 1,005 | BE 1.7.2's `github_sync.py` carried over in full (token storage, `GitHubConnection` one-leg connections, Contents API + Git Blobs >1 MB fallback, progress fetch, dialogs) **plus two things no suite copy had together**: the Map Editor 1.9.4's `_is_sha_conflict` + one-retry `push_file`, and a NEW generalized `round_trip()` + `fetch_with_retries()` (see §2). |
| `suite_cache.py` | 327 | BE 1.7.2's `shared_cache.py`, verbatim bar the contract header (it was already byte-identical in BE 1.7.2 and ME 1.9.5, transport-injected, app-free). |
| `layout_grammar.py` | 277 | NEW module from BE 1.7.1/1.7.2's layout fixes: `scrolled()`, `hscroll_row()`, `paned()` (both children shrink=True), `even_split()`, `SplitMemory` (dragged-divider memory), `anchored_overlay()`, `ellipsized_label()` — the parts that guarantee Joshua's editor UI rule. |
| `snapshot_view.py` | 411 | The BE 1.7.2 inspector's draw core generalized to a scene dict: `project()` / `fit_view()` / `screen_to_ground()` (pure) + `render_scene()` (ground, streets with the front road named, neighbour boxes, painter-sorted walls, front in warm orange + FRONT label/arrow) + `SceneView` widget. The inspector's app state (picking/dragging/spins) stayed in the editor, deliberately. |
| `selftest.py` | — | The core's own standalone proof: 29 checks, `xvfb-run -a python3 selftest.py` → **29/29** (round-trip leg discipline on a stub transport, cache store/serve/tamper, layout guarantees under real GTK, a scene rendered into real cairo pixels incl. the orange front wall). |

## 2. The generalized round trip

Before this pass the suite carried THREE copies of Joshua's
save rule (GameStore, StationEdits, design set) with identical
stage discipline and failure-message shapes. `round_trip()` in
`github_roundtrip.py` is that pattern once: targets +
`local_writer` / `local_names` / `verify` hooks for the parts
that are genuinely an app's own, message shapes preserved
verbatim (`local-save-failed: …`, `Push to GitHub failed: …`,
`… proof copy back failed: … — your save DID reach GitHub`).

## 3. The proof (staging, shipped code untouched)

`~/workspace/editors/suite-core-staging/` holds a copy of the
1.7.2 app rewired onto this core: `github_sync.py` /
`shared_cache.py` replaced by adapter shims re-exporting the
core modules, and `zonedata.py` / `data.py` round trips
delegating to `round_trip()`. The editor's own suites, UNMODIFIED,
against the staging copy — identical to the pristine baseline
(also re-run; the freeze gate's one baseline miss reproduced as
VM contention from parallel jobs and passes 7/7 on both trees
on a quiet machine):

| Suite | Pristine 1.7.2 | Staging on suite-core |
|---|---|---|
| data (`run_tests.py`) | 54/54 | 54/54 |
| GTK smoke (real GTK, Xvfb) | 28/28 | 28/28 |
| manipulation gate | 31/31 | 31/31 |
| design round-trip | 14/14 | 14/14 |
| freeze regression | 7/7 | 7/7 |
| shared-cache gate | 6/6 | 6/6 |

## 4. Reconciliation recommended (one directory, two shapes)

The Elevation pass chose a package (`suite_core/`, original
module names, vendored snapshots at build time; Elevation Editor
1.0.0 already consumes it). This pass chose flat modules with
functional names. **Recommend: keep the package shape and the
vendoring model (it has a live consumer), and merge this pass's
additions into it** — `round_trip()` + `fetch_with_retries()` +
the 409-retry into `suite_core/github_sync.py` (the package's
copy has none of the three yet), `layout_grammar`'s paned /
SplitMemory / anchored-overlay parts into `suite_core/layout.py`
(its `scrolled()` overlaps; the package's copy lacks the
divider guarantees), and `snapshot_view.py` in as a sibling of
`viewport3d.py` (different renderer: building snapshots vs
terrain/roads — both are core material). Until that merge is
done, this directory's top-level modules are the proven,
test-backed copies of the round trip/cache/layout-guarantee/
snapshot pieces — do not let a third shape appear.

Repo home (open decision, unchanged by this pass): recommend
`editors/suite-core/` in adamsville-play, registered in the
inventory registry as suite tooling, carried in by the Building
Editor rebuild. The Decision Deck's JS gesture module remains
the web-side sibling of this library — same write-shareable-first
rule, different platform.


---

## Addendum (2026-10-18) — §4 EXECUTED

The recommendation above was carried out: the flat additions
were merged into the `suite_core/` package (round_trip +
fetch_with_retries + 409-retry into `github_sync.py`; paned /
SplitMemory / anchored-overlay parts into `layout.py`;
`snapshot_view.py` and `suite_draw.py` homed in the package;
`updater.py` now carries both updater halves — the check half
above and the Building Editor's shipped applying updater).
The flat files remain as compatibility shims naming the
package modules. Record: `~/workspace/game-map/SUITE-CORE-MERGE-NOTES.md`.
Repo home decided and landed: `editors/suite-core/` in
adamsville-play (this file included), registered in
`tools/inventory-registry.json`.
