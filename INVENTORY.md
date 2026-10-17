# Inventory — how this repo knows what belongs in it

*Joshua's design, 2026-10-17. Written when this repository was rebuilt
clean: every file in it is either used by something, or declared as
stock / tooling / documentation. Nothing rides along by accident.*

## The problem this solves

The old repository grew by accretion. Whole projects were copied in,
features were retired by removing their loaders but not their files,
and lists of "what we use" were kept by hand — so the lists decayed:
a file pushed tomorrow isn't on the list, a stock file no program
references yet looks like an orphan, and maintaining the list becomes
its own chore-loop. Dead files kept surfacing one surprise at a time.

## The rule (clear, simple, repeatable)

**The used-list is derived, never hand-kept.** The checker
(`tools/check_inventory.py`, stdlib Python, no dependencies) rebuilds
it on every run from the code's own references:

- the game pages' loader sets and fetches,
- the four delivery manifests (ui / map / vehicles / music),
- the zone-dataset patterns (the zoneloader's and the editors'
  zone-directory constants — everything in `detailed/zones/<zone>/`
  is zone dataset),
- the editors' repo-path constants, including the file lists their
  updaters download,
- the watcher's live-sync list,
- the GitHub workflow files' path literals,
- sibling loads inside the game and watcher code.

**A file may also be present as declared stock, tooling or doc** —
present on purpose, without any program referencing it yet. Those
declarations live in ONE small registry,
`tools/inventory-registry.json`, by area, with a reason for each. The
tool that creates a piece of stock adds its declaration there as part
of creating it. Nobody maintains a per-file roster.

**The gate asks exactly two questions:**

1. Does every reference resolve to a real file? (A reference to a
   declared *creation target* — a path a tool creates at runtime,
   like the Building Editor's `station-edits.json` on first save —
   also passes.)
2. Is every file either referenced, or declared?

A reference that fails (1) is a **dangling reference**. A file that
fails (2) is a **true orphan**. The checker's output names which side
failed. Run it before a push that adds, moves or retires files:

```
python3 tools/check_inventory.py
```

## Working rules that follow from this

- **A manifest entry is a reference.** To retire a file, remove it
  from every manifest too — the gate checks both directions (this is
  how the retired overlay scripts were caught in the old repo: their
  loaders were removed in October 2026 but their manifest entries —
  and the files — lived on).
- **Retiring a file means removing its mentions.** The deriver reads
  code text; a file still named in comments counts as mentioned. When
  you retire something, sweep its name out.
- **New stock goes on a shelf and gets declared.** Placeable things
  live under `editors/stock/` (see `editors/stock/README.md`). If no
  program references the new file yet, declare its area in the
  registry in the same change.
- **The root game page is a mirror.** `index.html` at the repo root
  is a byte-copy of `detailed/index.html`, kept by the release flow;
  its relative references are read against `detailed/`, where they
  resolve for the canonical page.
- **Known limit, stated plainly:** the gate catches file-level drift
  — the historical failure mode (single files orphaned by refactors,
  references broken by renames). A whole dead tree imported at once
  references itself internally and can look consistent; wholesale
  imports are what code review is for.

## This repo's birth certificate

This repository was created on 2026-10-17 by deriving the used-list
from the previous repository, moving only referenced or declared
files — each verified byte-for-byte against the old repo — and
leaving everything else behind in the archive
(`adamsville-play-archive`, the previous repo, renamed, nothing
deleted). `MIGRATION-MANIFEST.json` at the root is the generated
snapshot of that move: every file that crossed, its fingerprint, and
what uses it or declares it. It is reproducible — re-running the
deriver (`tools/check_inventory.py --snapshot`) regenerates the same
inventory from the code, which is the whole point.
