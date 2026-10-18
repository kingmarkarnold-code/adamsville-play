#!/usr/bin/env python3
"""
Adamsville SUITE CORE — one shared library for every suite app.

Joshua's law (2026-10-17, from his Android/Java study): code must
NOT repeat itself across the suite. The 3D viewport, the gesture
vocabulary, the GitHub pull/push round-trip, the shared download
cache, the ground math, and the layout grammar live HERE, once;
each editor imports them instead of re-typing its own copies.
Fixes land here and every consumer improves at its next build.

Modules:
    github_sync   — token storage, explicit-connection Contents
                    API push/fetch (with the 409 SHA-conflict
                    retry), the generalized round_trip() save and
                    fetch_with_retries(), the suite's key dialogs.
    shared_cache  — the suite's ONE download cache
                    (~/.local/share/adamsville-suite/cache/) with
                    the manifest-freshness rule.
    ground        — the game's heightAt()/terrainMeshY() port
                    (drape math), terrain lifts, stretch
                    segmentation, gaussian hill fitting.
    viewport3d    — the shared software-3D viewport (terrain patch
                    + road ribbons, orbit/pan/zoom/pick/lift-drag).
    snapshot_view — the shared building-snapshot renderer (a
                    building WITH its ground, street and
                    neighbours, from a plain scene dict).
    layout        — the layout grammar helpers (anchors/shares/
                    weights), screen-class detection, scrollable
                    panes, the divider guarantees (paned /
                    SplitMemory / anchored overlays), window-state
                    memory.
    about         — the shared Help -> About dialog.
    updater       — both updater halves: the fail-open version
                    check (Elevation contract) and the staged
                    in-place applying updater (Building Editor
                    contract, check_for_updates_gui).
    suite_draw    — Draw for Mollie, the Python drawing citizen
                    (the desktop mirror of the Suite APK's
                    SuiteDraw); vendored by apps as suite_draw.py.

Consolidated 2026-10-18: the flat extraction pass's modules
(github_roundtrip / suite_cache / layout_grammar / snapshot_view
/ suite_draw at this directory's top level) were merged into
this package per EXTRACTION-REPORT.md section 4; the flat files
remain as compatibility shims that name these modules.

Apps vendor a snapshot of this package into their install tree at
build time (the .deb stays self-contained, the sibling precedent);
the source of truth is this directory.
"""
