# The suite shared download cache — the standard

Joshua's rule (2026-10-17): *"all editors share the map, so if one
app downloads the new version of the map the rest can use the same
resource."*

Every Adamsville editor downloads from the same GitHub repo
(`kingmarkarnold-code/adamsville-play`). Without a shared cache,
each app downloaded its own copy of the same files — the same
multi-megabyte zone files, two or three times over, on a slow
connection. This document is the standard every editor follows;
the implementation is `shared_cache.py`, byte-identical in every
suite app (it currently ships with the Building Editor 1.7.2 and
the Map Editor 1.9.5 source; the UI Editor adopts it in its next
build).

## Where it lives

```
~/.local/share/adamsville-suite/cache/
    index.json            the cache index (below)
    detailed/zones/adamsville/roads.json     cached bytes, laid
    editors/building-editor/index/...        out mirroring their
    ...                                      repo paths
```

The suite already shares `~/.local/share/adamsville-suite/` (the
GitHub token lives there). The cache is a sibling of the token,
never inside any one app's own data folder.

## The index

`index.json` is one JSON object keyed by repo path. Each entry:

```json
"detailed/zones/adamsville/roads.json": {
  "repo": "kingmarkarnold-code/adamsville-play",
  "sha256": "<sha256 of the bytes>",
  "blobSha": "<git blob sha1 of the bytes>",
  "size": 2394062,
  "fetchedAt": "2026-10-17T19:20:11Z",
  "manifestVersion": "2026.10.16.10"
}
```

## The freshness rule

A cached file may be served **without downloading** only when it
is known to match what is currently published:

- the caller knows the published **sha256** (from a freshly
  fetched manifest — `map-manifest.json` / `ui-manifest.json`;
  the manifest fetch itself is tiny and always fresh), and the
  cached entry's sha256 equals it; or
- the caller probes the file's published **blob sha** (one small
  metadata read) and the cached entry's blobSha equals it.

The cached bytes themselves are re-hashed before serving: an
entry whose bytes no longer match its recorded sha256 is treated
as absent, never served.

On any mismatch or absence: download (with the MB progress
treatment), verify the downloaded bytes against the expected
sha, store them atomically (temp file → rename) under a lockfile
(`cache/.lock`, 15 s timeout, stale after 120 s), and update the
index. If another app stored the same sha first, the duplicate
download is discarded.

**Offline:** if the network fails and a cache copy exists, serve
it and report the read as **stale** so the app can mark the view
stale in its status bar. The cache never blocks the app
(fail-open) — except that bytes failing a sha check are refused
outright rather than served.

## What shares — and what never does

Shared: **downloaded data only** — zone files, light indexes,
roads, the flagged list, the gas-station review list, the design
set, manifests. Anything an app *downloads from the repo* may go
through the cache.

Never shared, never moved: **per-app data** — settings, local
overlays (for example the Building Editor's
`~/.local/share/adamsville-asset-editor-native/building_edits.json`,
which holds unpublished edits), and the suite token. Those stay in
the per-app folders where they have always lived.

## Proof downloads are not cached

A save's proof leg (push → close → fresh reopen → re-download)
must come from GitHub itself, or it proves nothing. Apps keep
their proof downloads on the direct transport; only
download-on-open traffic uses the cache.

## Adopting it (for the next editor)

1. Ship `shared_cache.py` unchanged alongside the app.
2. Fetch the relevant manifest fresh; register its shas.
3. Route every download-on-open fetch through
   `shared_cache.CachedFetcher` (a drop-in for the github_sync
   fetch signatures) or `shared_cache.fetch_through` directly.
4. Surface `paths_served_stale` in the status bar when non-empty.
