# Player picture — one-source GIF conversion (2026-10-17)

Joshua's ruling (2026-10-17 17:12 EDT), resolving ONE-SOURCE.md
exception 3.5: "Create the one-source picture, but change it to a gif
cause we will be changing this image later."

## What was done

1. **Master preserved first.** www's `player.png` copied untouched to
   `game-map/backups/2026-10-17-merge/player.png.master-original`
   (sha256 `b30b180f…`, verified identical to the source before any
   change). The current art survives every later image change.
2. **Converted to GIF.** `play/detailed/player.gif` — GIF89a,
   1024×2048 (same dimensions), 240,372 bytes vs the PNG's 689,006
   (65% smaller), sha256 `2f83c46b…`. Palette: 255 adaptive colours
   (Floyd–Steinberg dithered) + 1 transparent index.
3. **Alpha treatment (flagged per instructions).** The PNG is RGBA:
   1,700,481 fully transparent px, 376,119 opaque px, and 20,552
   partial-alpha px (~1% — the anti-aliased silhouette fringe). GIF
   allows only all-or-nothing transparency, so alpha was thresholded
   at 128 (≥50% coverage = solid, below = see-through). Verified
   after conversion: the GIF's transparent-pixel mask is pixel-for-
   pixel identical to the thresholded PNG mask (1,710,039 transparent
   px in both). No matte colour was needed because the picture is
   always shown over the game world, never keyed against a backdrop
   colour; a threshold keeps the silhouette at its visual edge.
4. **References.** A full sweep of the canonical tree found exactly
   ONE `player.png` mention: a stale v1.4 comment in index.html (the
   game loads no portrait file at runtime — the hero is a 3D mesh and
   the face texture is an embedded webp crop data URL). The comment
   now records player.gif as the master picture (new v1.69 note).
   www's `setup.html` has no player reference — nothing to change
   there. Post-sweep grep for `player.png` across play/detailed:
   zero hits.
5. **Manifest.** `ui-manifest.json` regenerated: player.gif added
   (no player.png entry ever existed in the canonical manifest —
   the file was never in the tree), all 78 entries recomputed;
   self-consistency sweep passes (every entry present, size +
   sha256 + hash/md5 match). ui_version 2026.10.17.1 → **2026.10.17.2**.
   The only pre-existing entry whose fingerprint changed is
   index.html (the comment edit).
6. **Generator.** `player.png` removed from `PRESERVED_WWW_ONLY` in
   `pipeline/generate-www.js` (header updated to RESOLVED, following
   the merge entries' pattern). Regeneration copied player.gif +
   the new index.html/manifest into www and deleted www's stale
   player.png (master safe in backups). `--check` PASSES. Remaining
   preservations: `github-config.js` (exception) and `setup.html`
   (deployment) only.
7. **Visual check.** Master PNG and new GIF both opened with the
   image reader: same picture (stylised full-body hero, red shirt,
   blue jeans, sneakers, transparent background), no corruption; the
   quirks visible in the GIF (neck seam, dark sneaker patches, light
   smudge at the feet) are present in the master PNG too — conversion
   introduced none of them. GIF palette banding is not noticeable at
   display size. What was NOT proven: in-game rendering of the new
   file (nothing in the game loads it as a file today) — Joshua's
   load test remains the proof standard for the tree as a whole.

## Changing the picture later (Joshua's stated intent)

Replace `play/detailed/player.gif` with the new art (GIF, same
1024×2048 unless the layout changes), regenerate the ui-manifest,
bump ui_version, push, run `node pipeline/generate-www.js`. The web
build serves it from the repo; phones pick it up through the normal
UI update channel.
