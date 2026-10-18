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
                    API push/fetch, the suite's dialogs for the key.
    shared_cache  — the suite's ONE download cache
                    (~/.local/share/adamsville-suite/cache/) with
                    the manifest-freshness rule.
    ground        — the game's heightAt()/terrainMeshY() port
                    (drape math), terrain lifts, stretch
                    segmentation, gaussian hill fitting.
    viewport3d    — the shared software-3D viewport (terrain patch
                    + road ribbons, orbit/pan/zoom/pick/lift-drag).
    layout        — the layout grammar helpers (anchors/shares/
                    weights), screen-class detection, scrollable
                    panes, window-state memory.
    about         — the shared Help -> About dialog.
    updater       — the version.json update check (fail-open).

Apps vendor a snapshot of this package into their install tree at
build time (the .deb stays self-contained, the sibling precedent);
the source of truth is this directory.
"""
