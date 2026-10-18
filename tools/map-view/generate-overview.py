#!/usr/bin/env python3
"""generate-overview.py — build the compact overview dataset for the
Google-Maps-style map viewer (tools/map-view/map-view.html).

WHY: the viewer must open on the WHOLE rebuilt world (all 7 zones,
~66,000 roads) without downloading the full zone datasets (80+ MB).
This generator reads the game's own zone files
(detailed/zones/<zone>/roads.json + zone.json — the same files the
game loads), simplifies every road polyline (Douglas-Peucker, a few
metres of tolerance by road class), rounds coordinates to whole
metres, and writes ONE compact JSON the page loads in a single fetch:

    tools/map-view/map-view-overview.json

Format (all coordinates are integer metres in an offset frame whose
origin is the world corner xMin/zMin, so every value is positive;
each road after the first point is DELTA-encoded):

    { "v": 1,
      "world":  [xMin, zMin, xMax, zMax],
      "zones":  [ {"id": ..., "name": ..., "b": [xMin,zMin,xMax,zMax]} ],
      "classes":["highway","major_artery","minor_artery","local"],
      "names":  [ "Cascade Road Southwest", ... ],   # unique names
      "roads":  [ [classIdx, zoneIdx, nameIdxOrMinus1,
                   x0, z0, dx1, dz1, dx2, dz2, ...], ... ] }

Per-zone DETAIL (true geometry + buildings + water) is not in this
file at all: the viewer fetches the game's own zone files on demand
when the user zooms deep into a zone. Nothing here is hand-kept —
re-run this script after any map conversion or zone edit and commit
the regenerated file with the page.

USAGE:  python3 tools/map-view/generate-overview.py [repo_root]
Stdlib only.
"""
import json
import math
import os
import sys

ZONES = ("adamsville", "downtown", "eastatlanta", "mableton",
         "riverdale", "southfulton", "unioncity")
CLASSES = ("highway", "major_artery", "minor_artery", "local")
# Douglas-Peucker tolerance in metres, per class. Highways keep the
# tightest shape; short local streets tolerate the most.
TOLERANCE = {"highway": 4.0, "major_artery": 5.0,
             "minor_artery": 6.0, "local": 8.0}
UNNAMED = ("", "Unnamed St", "Unnamed", None)


def simplify(pts, tol):
    """Iterative Douglas-Peucker. Always keeps both endpoints."""
    n = len(pts)
    if n <= 2:
        return pts
    keep = bytearray(n)
    keep[0] = keep[n - 1] = 1
    t2 = tol * tol
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, az = pts[a]
        bx, bz = pts[b]
        dx, dz = bx - ax, bz - az
        seg2 = dx * dx + dz * dz
        worst, wi = -1.0, -1
        for i in range(a + 1, b):
            px, pz = pts[i]
            if seg2 == 0.0:
                d2 = (px - ax) ** 2 + (pz - az) ** 2
            else:
                t = ((px - ax) * dx + (pz - az) * dz) / seg2
                t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                cx, cz = ax + t * dx, az + t * dz
                d2 = (px - cx) ** 2 + (pz - cz) ** 2
            if d2 > worst:
                worst, wi = d2, i
        if worst > t2:
            keep[wi] = 1
            stack.append((a, wi))
            stack.append((wi, b))
    return [p for p, k in zip(pts, keep) if k]


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    zones_meta = []
    all_roads = []          # (classIdx, zoneIdx, name, simplified pts)
    names = []
    name_index = {}
    wx0 = wz0 = math.inf
    wx1 = wz1 = -math.inf

    for zi, zid in enumerate(ZONES):
        zdir = os.path.join(root, "detailed", "zones", zid)
        zone = json.load(open(os.path.join(zdir, "zone.json")))
        b = zone["bounds"]
        zones_meta.append({
            "id": zid, "name": zone["name"],
            "b": [round(b["xMin"]), round(b["zMin"]),
                  round(b["xMax"]), round(b["zMax"])],
        })
        wx0 = min(wx0, b["xMin"]); wz0 = min(wz0, b["zMin"])
        wx1 = max(wx1, b["xMax"]); wz1 = max(wz1, b["zMax"])
        roads = json.load(open(os.path.join(zdir, "roads.json")))
        for ci, cls in enumerate(CLASSES):
            for rec in roads.get(cls, []):
                pts = [(float(x), float(z)) for x, z in rec["pts"]]
                if len(pts) < 2:
                    continue
                sp = simplify(pts, TOLERANCE[cls])
                nm = rec.get("name")
                if nm in UNNAMED:
                    ni = -1
                else:
                    if nm not in name_index:
                        name_index[nm] = len(names)
                        names.append(nm)
                    ni = name_index[nm]
                all_roads.append((ci, zi, ni, sp))

    ox, oz = math.floor(wx0), math.floor(wz0)
    out_roads = []
    total_pts = 0
    for ci, zi, ni, sp in all_roads:
        enc = [ci, zi, ni]
        px = pz = None
        for x, z in sp:
            ix, iz = int(round(x)) - ox, int(round(z)) - oz
            if px is None:
                enc.append(ix); enc.append(iz)
            else:
                enc.append(ix - px); enc.append(iz - pz)
            px, pz = ix, iz
        total_pts += len(sp)
        out_roads.append(enc)

    doc = {
        "v": 1,
        "world": [ox, oz, int(math.ceil(wx1)), int(math.ceil(wz1))],
        "zones": zones_meta,
        "classes": list(CLASSES),
        "names": names,
        "roads": out_roads,
    }
    out_path = os.path.join(root, "tools", "map-view", "map-view-overview.json")
    with open(out_path, "w") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
    size = os.path.getsize(out_path)
    print(f"wrote {out_path}: {size:,} bytes")
    print(f"roads: {len(out_roads):,}  simplified points: {total_pts:,}"
          f"  unique names: {len(names):,}")
    print(f"world: x[{doc['world'][0]}..{doc['world'][2]}] "
          f"z[{doc['world'][1]}..{doc['world'][3]}]")


if __name__ == "__main__":
    main()
