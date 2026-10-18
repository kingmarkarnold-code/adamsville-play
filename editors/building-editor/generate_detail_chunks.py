#!/usr/bin/env python3
"""
Regenerate the Building Editor's per-zone DETAIL CHUNKS
(editors/building-editor/detail-chunks/<zone>/<cx>_<cz>.json) from
the game's real zone building data.

Why this exists (Joshua, 2026-10-18, Building Editor 2.0.0 — the
snapshot model + the lightweight law): selecting ONE building must
never download its whole zone's detail file (up to 10.7 MB). The
detail records therefore also live in small chunk files: one per
2000-unit grid cell, holding the records of the buildings whose
centres fall in that cell, keyed by building index. The editor
fetches only the chunks a snapshot touches. buildings_detail.json
stays the game's canonical file — the chunks are a DERIVED view of
it, built by zonedata.build_chunk_doc, the same function the
editor's own save path uses to regenerate the cells its edits
touched, so the two can never drift apart.

Run this after any push that changes zone building data OUTSIDE
the Building Editor (a conversion, a Map Editor save):

    python3 generate_detail_chunks.py <zones_dir> <out_dir>

<zones_dir> is a directory holding <zone>/buildings.json and
<zone>/buildings_detail.json — e.g. a checkout's detailed/zones.
<out_dir> receives <zone>/<cx>_<cz>.json per non-empty cell; stale
chunk files of regenerated zones are removed, so the output is
exactly the current chunk set.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import zonedata  # noqa: E402  (the editor's own module: one builder)


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    zones_dir, out_dir = Path(argv[1]), Path(argv[2])
    total_files = 0
    total_bytes = 0
    for zone in zonedata.ZONES:
        base = zones_dir / zone
        files = {
            "buildings.json": (base / "buildings.json").read_bytes(),
            "buildings_detail.json":
                (base / "buildings_detail.json").read_bytes(),
        }
        zd = zonedata.ZoneData(zone).load(files)
        cells = sorted({zonedata.detail_cell(b[0], b[1])
                        for b in zd.boxes})
        zone_out = out_dir / zone
        zone_out.mkdir(parents=True, exist_ok=True)
        # Remove stale chunks of this zone first: the output must
        # be exactly the current set (a cell emptied by an outside
        # edit must not linger with old records).
        for old in zone_out.glob("*.json"):
            old.unlink()
        for cell in cells:
            raw = zonedata.chunk_bytes(zonedata.build_chunk_doc(
                zone, cell, zd.boxes, zd.details))
            (zone_out / f"{cell[0]}_{cell[1]}.json").write_bytes(raw)
            total_files += 1
            total_bytes += len(raw)
        print(f"{zone}: {len(cells)} chunks")
    print(f"total: {total_files} chunk files, "
          f"{total_bytes / 1048576:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
