#!/usr/bin/env python3
"""
Regenerate the Building Editor's per-zone LIGHT INDEXES
(editors/building-editor/index/<zone>.json) from the game's real
zone building data.

Why this exists (Joshua, 2026-10-17, Building Editor 1.7.2 rule
P1/P2): the editor loads on demand. Its building LISTS come from
these light indexes — one per zone, downloaded from GitHub — not
from parsing the full zone files, and never from a copy baked into
the .deb. Each index entry carries just what browsing needs:
name, type code, centre position, size — plus the zone's hero
buildings and the zone-data version the index was built from.

The editor itself regenerates a zone's index after its OWN save
(using the same zonedata.build_index function) so its list can
never show its own edits stale; run this script after any OTHER
push that changes zone building data (a conversion, a Map Editor
save) so the published indexes stay in step:

    python3 generate_indexes.py <zones_dir> <out_dir>

<zones_dir> is a directory holding <zone>/buildings.json,
buildings_detail.json, zone.json (and hero_buildings.json where
the zone has one) — e.g. a checkout's detailed/zones. <out_dir>
receives <zone>.json per zone.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import zonedata  # noqa: E402  (the editor's own module: one builder)


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    zones_dir, out_dir = Path(argv[1]), Path(argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    for zone in zonedata.ZONES:
        base = zones_dir / zone
        b_doc = json.loads((base / "buildings.json").read_bytes())
        details = json.loads(
            (base / "buildings_detail.json").read_bytes())
        zone_doc = json.loads((base / "zone.json").read_bytes())
        heroes = []
        hero_file = base / "hero_buildings.json"
        if hero_file.exists():
            heroes = [{"id": h.get("id"), "name": h.get("name"),
                       "address": h.get("address")}
                      for h in json.loads(
                          hero_file.read_bytes()).get("buildings", [])]
        doc = zonedata.build_index(
            zone, [list(r) for r in b_doc["buildings"]], details,
            heroes, zone_doc.get("bounds") or {},
            b_doc.get("version", ""))
        raw = zonedata.index_bytes(doc)
        (out_dir / f"{zone}.json").write_bytes(raw)
        total += doc["count"]
        print(f"{zone}: {doc['count']} buildings, "
              f"{len(raw)} bytes (from {doc['sourceVersion']})")
    print(f"total: {total} buildings")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
