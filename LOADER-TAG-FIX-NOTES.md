# Swallowed loader tag — fix notes (2026-10-17)

Joshua's go (2026-10-17 18:22 EDT): **"Fix the swallowed loader
tag."** The finding came from the release-sync retirement
(`RELEASE-SYNC-RETIREMENT-NOTES.md`, surprise #1): the release
tool's step-3 smoke gate failed on the canonical game page —
76 `data-dsrc` loader tags in the text, only 75 parsed as real
elements — so every release stopped at step 3.

## Backups (taken before any edit, checksums verified)

`backups/2026-10-17-loader-fix/`:

- `index.html.detailed.before` — sha256 `dc38ab91…`
  (= pre-fix `play/detailed/index.html`)
- `index.html.rootmirror.before` — sha256 `2e80b1c0…`
  (= pre-fix `play/index.html`)
- `ui-manifest.json.before` — sha256 `19d7c199…`

## Diagnosis

Parser: Python `html.parser` (script content is raw text until
`</script>`, matching browser behaviour), counting text-level
`<script data-dsrc="…">` tags vs parsed `script[data-dsrc]`
elements.

| File | Text tags | Parsed | Swallowed |
|---|---|---|---|
| `play/detailed/index.html` (pre-fix) | 76 | 75 | `airport.js` |
| merge backup `index.html.from-play` | 74 | 73 | `airport.js` |
| merge backup `index.html.from-www` | 76 | 75 | `airport.js` |
| `play/index.html` root mirror (pre-fix) | 63 | 63 | — |

**The mechanism.** In the loader region, the tag

```
<script data-dsrc="truck_restrictions.js" data-dkey="">
```

was never closed — no `</script>`. Everything after it was
therefore the element's *body*: the AIRPORT comment and the whole
`<script data-dsrc="airport.js" …>` opening tag, up to
airport.js's own `</script>`. Two tags became one element.
`truck_restrictions.js` itself still loaded (the deferred loader
at index.html line ~1468 walks the DOM with
`querySelectorAll('script[data-dsrc]')` and reads the attribute;
the junk body is ignored) — but **airport.js had no element, so
the airport module silently never loaded** in this page lineage.
The smoke test's message ("truck_restrictions.js has <script> in
its body") names the polluted element; the parsed-element
casualty is airport.js.

**Verdict: pre-existing, NOT introduced by the 2026-10-17 merge.**
Both pre-merge parents carry the identical unclosed tag in the
identical spot (from-play line 12506, from-www line 12235); the
merge carried it over faithfully. (The stale root mirror, an
older 63-tag page, does not have the defect.)

## The fix

One edit in `play/detailed/index.html` (line 12513): the tag now
closes —

```
<script data-dsrc="truck_restrictions.js" data-dkey=""></script>
```

Loader set, order, and files are byte-identical before/after
(diff of the extracted `data-dsrc` sequence: no change). Nothing
else in the page was touched. Constraint check: the retired
overlays (`building_spawner.js`, `road_sync.js`,
`terrain_sync.js`) still have **zero** loader entries;
`worldfix_sync.js`, `input_diag.js`, `keyboard_remap.js` remain
loaded, once each; no duplicate entries anywhere.

## Verification (after fix)

- Parser: **76 text tags == 76 parsed elements**, no swallowed
  tags, no element with a `<script>` in its body.
- Smoke test (`play/tools/smoke-test.js`): **PASS** — "76
  deferred script tags parsed", "all 76 data-dsrc tags parsed
  cleanly", structure balanced (80 elements).
- `node --check`: **119/119** JS files in `play/detailed/` pass;
  4/4 inline script blocks pass. (Correction, same day: an early
  draft of these notes said 238 — that was the merge task's
  two-tree count, play + www. This fix's own sweep of the
  canonical tree covered 119 files, 0 failures.)
- Manifest: `ui-manifest.json` regenerated surgically — only the
  `index.html` fingerprint (size 961687 → 961696, sha256
  `dc38ab91…` → `7d5d1ca2…`) and the version strings changed.
  Full sweep: all 78 entries match disk (size + sha256).
  **ui_version 2026.10.17.2 → 2026.10.17.3.**
- www regenerated (`pipeline/generate-www.js`), `--check`
  passes; www's page parses 76/76.

## Known remaining gap (reported, deliberately not fixed here)

Four parsed deferred scripts are in **no** manifest —
`water_render.js`, `truck_restrictions.js`,
`water_interaction.js`, and now (post-fix) `airport.js`. The
smoke gate treats this as warn-only ("APK updater would miss
it"): the web/deferred loader reads the DOM, not the manifest,
so all four load in the web build and in the APK bundle (the
files are in the tree); what is missing is updater coverage if
one of those files changes later. Adding manifest entries was
outside this task's minimal-fix scope; it wants its own
decision.

## Ship

Pushed to `kingmarkarnold-code/adamsville-play` via the legacy
connector credential; every push read back byte-identical:

- `detailed/index.html` — commit `0c4fbaa4a8`
- `detailed/ui-manifest.json` — commit `a046125643`
- `index.html` (Pages root mirror, refreshed by direct copy of
  the fixed canonical page — the release flow's kept behaviour;
  the mirror was stale: a 63-tag older page) — commit `1aa783a47b`

## Release dry run after the fix

`python3 tools/release.py` (no `--push`): **ran end-to-end,
exit 0.** Step 3 smoke gate **passes**. Steps 4–8 stayed in
dry-run mode (version-bump preview only; mirror sync, notes and
push skipped; "no files modified" — state file and all manifest
hashes verified unchanged afterwards, no lock left).

Its step-1 classification still reports "map-manifest: 80
changed file(s)" — **that backlog is a phantom, now
reconciled.** `release.py`'s per-manifest config assumes the map
manifest truncates sha256 to 16 chars (`hash_len: 16`), but
`map-manifest.json` carries full 64-char hashes, so the tool's
16-char prefix can never equal the stored string and every entry
with a matching size is flagged "sha256 changed". Direct
verification: **all 80 map entries match disk exactly** (size +
full sha256; map_version 2026.10.16.10). Nothing is actually
waiting to release on the map side; a one-line config correction
in `release.py` (map `hash_len` 16 → 64) would clear the phantom
classification — left for a separate decision, not bundled into
this fix. (Side effect until then: a real release would spend
step 2 node-checking the 80 "changed" zone files — all clean in
this dry run — and would preview-bump map_version, as this dry
run did: 2026.10.16.10 → 2026.10.17.1, preview only.)
