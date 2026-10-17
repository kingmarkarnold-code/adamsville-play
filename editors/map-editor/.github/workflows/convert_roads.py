#!/usr/bin/env python3
"""
Road converter: map-editor roads.json/zones.json → game zone road files.

WHERE THIS FILE GOES:
  kingmarkarnold-code/adamsville-map-editor/.github/workflows/convert_roads.py
  (runs inside the sync-roads.yml workflow)

WHAT IT DOES:
  1. Reads roads.json from the map-editor repo.
     Format: {"highway": [...], "major_artery": [...], "minor_artery": [...],
              "local": [...], "interstate": [...]}
     Each road: {"name": str, "pts": [[x,z],...], ...extra fields...}
  2. Reads zones.json for zone boundary polygons.
  3. For each game zone (zones/<zone>/), assigns roads whose center falls
     inside the zone's bounds polygon.
  4. Writes zones/<zone>/roads.json as pure JSON:
       {"interstate":[...],"highway":[...],"major_artery":[...],
        "minor_artery":[...],"local":[...]}
     (plus zones/<zone>/roads.js as fallback — the game loads .js via
     <script> only if the JSON fetch fails)
     Category mapping (game uses the 5-category schema — categories are
     preserved as-is; only legacy "arterial" is remapped):
       interstate   → "interstate"
       highway      → "highway"
       major_artery → "major_artery"
       minor_artery → "minor_artery"
       arterial     → "minor_artery"  (legacy — matches game's normRoadCat)
       local        → "local"
     All editor-only fields (divided_sections, width_class, paint,
     sidewalk_*, cul_de_sac, etc.) are preserved on each road object —
     the game's road_sync.js reads them at runtime.
  5. Updates zones/<zone>/zone.json bounds from zones.json if provided.

Idempotent: same input → same output. Safe to re-run.

Joshua's rule: all code commented.
"""

import argparse
import json
import math
import os
import sys


# ---------------------------------------------------------------------------
# Category mapping: editor categories → game categories.
# The game's ROAD_DATA uses the 5-category schema
# (interstate/highway/major_artery/minor_artery/local). Categories pass
# through unchanged; only legacy "arterial" is remapped to "minor_artery"
# (exactly what the game's normRoadCat() does).
# The original editor category is kept as "_editorCat" for road_sync.js.
# ---------------------------------------------------------------------------
CATEGORY_MAP = {
    "interstate": "interstate",
    "highway": "highway",
    "major_artery": "major_artery",
    "minor_artery": "minor_artery",
    "arterial": "minor_artery",   # legacy — matches game's normRoadCat()
    "local": "local",
}

# The game's ROAD_CATS (see detailed/index.html): the renderer reads
# whatever keys exist in roads.json and normalizes legacy "arterial"
# itself, so we preserve the full 5-category schema here.
GAME_CATEGORIES = ("interstate", "highway", "major_artery", "minor_artery", "local")


def point_in_polygon(px, pz, polygon):
    """
    Ray-casting point-in-polygon test.
    polygon: list of [x, z]. Returns True if (px, pz) is inside.
    """
    inside = False
    n = len(polygon)
    for i in range(n):
        x1, z1 = polygon[i]
        x2, z2 = polygon[(i + 1) % n]
        if ((z1 > pz) != (z2 > pz)):
            xinters = (x2 - x1) * (pz - z1) / (z2 - z1 + 1e-9) + x1
            if px < xinters:
                inside = not inside
    return inside


def road_center(pts):
    """Centroid of a road's points — used for zone assignment."""
    if not pts:
        return (0, 0)
    sx = sum(p[0] for p in pts)
    sz = sum(p[1] for p in pts)
    return (sx / len(pts), sz / len(pts))


def load_zones(zones_path, game_dir):
    """
    Load zone boundary polygons.
    Tries zones.json (editor format) first, falls back to each zone's
    zone.json bounds in the game repo.
    Returns: {zone_id: {"name": str, "polygon": [[x,z],...] or None,
                        "bounds": {xMin,xMax,zMin,zMax} or None}}
    """
    zones = {}

    # Editor's zones.json: {"zones": [{"name":..., "points":[[x,z],...]}, ...]}
    # or a bare list.
    if zones_path and os.path.exists(zones_path):
        with open(zones_path) as f:
            raw = json.load(f)
        zone_list = raw.get("zones", raw) if isinstance(raw, dict) else raw
        for z in zone_list:
            zid = str(z.get("id") or z.get("name", "")).lower().replace(" ", "")
            if not zid:
                continue
            zones[zid] = {
                "name": z.get("name", zid),
                "polygon": z.get("points") or z.get("polygon"),
                "bounds": None,
            }

    # Game's existing zones: read bounds from each zone.json
    zones_dir = os.path.join(game_dir, "zones")
    if os.path.isdir(zones_dir):
        for zid in os.listdir(zones_dir):
            zpath = os.path.join(zones_dir, zid, "zone.json")
            if not os.path.exists(zpath):
                continue
            try:
                with open(zpath) as f:
                    zj = json.load(f)
            except Exception:
                continue
            if zid not in zones:
                zones[zid] = {"name": zj.get("name", zid),
                              "polygon": None, "bounds": None}
            # Editor polygon wins; game bounds are fallback
            if zones[zid]["polygon"] is None:
                zones[zid]["bounds"] = zj.get("bounds")
            # Keep the game-side display name if the editor didn't set one
            if not zones[zid].get("name"):
                zones[zid]["name"] = zj.get("name", zid)

    return zones


def zone_for_road(cx, cz, zones):
    """
    Find which zone a road center belongs to.
    Polygon test first, then bounds fallback. Returns zone_id or None.
    """
    for zid, z in zones.items():
        poly = z.get("polygon")
        if poly and len(poly) >= 3:
            if point_in_polygon(cx, cz, poly):
                return zid
    for zid, z in zones.items():
        b = z.get("bounds")
        if b and b["xMin"] <= cx <= b["xMax"] and b["zMin"] <= cz <= b["zMax"]:
            return zid
    return None


def convert_road(road, editor_cat):
    """
    Convert one editor road to game format.
    Maps the category, preserves all editor-only fields, tags _editorCat.
    """
    game_cat = CATEGORY_MAP.get(editor_cat, "local")
    out = dict(road)  # keep everything (divided_sections, paint, etc.)
    out["_editorCat"] = editor_cat
    # Ensure required fields exist
    out.setdefault("name", "Unnamed St")
    out.setdefault("pts", [])
    return game_cat, out


def write_zone_roads(zone_dir, road_data):
    """
    Write zones/<zone>/roads.json as pure JSON:
      {"interstate":[...],"highway":[...],"major_artery":[...],
       "minor_artery":[...],"local":[...]}

    v1.54 (2026-10-12): iOS Safari froze at 18% parsing the 1.6M-char single
    lines in .js zone files — the game now fetches .json (JSON.parse is
    native C++). The old roads.js is kept as fallback; write it too so the
    fallback never goes stale.
    """
    import datetime
    today = datetime.date.today().isoformat()
    payload = json.dumps(road_data, separators=(",", ":"))
    # Primary: pure JSON (game fetches this).
    json_path = os.path.join(zone_dir, "roads.json")
    with open(json_path, "w") as f:
        f.write(payload)
    # Fallback: old .js wrapper (game loads via <script> only if JSON fails).
    header = (
        "/* ============================================================================\n"
        f"   ZONE ROADS — auto-baked from map-editor repo ({today})\n"
        "   DO NOT EDIT BY HAND — edit in the Map Editor, this file is generated.\n"
        "   FALLBACK ONLY — the game loads roads.json; this .js is used only\n"
        "   if the JSON fetch fails.\n"
        "   ============================================================================ */\n"
    )
    js_path = os.path.join(zone_dir, "roads.js")
    with open(js_path, "w") as f:
        f.write(header + "var ROAD_DATA = " + payload + ";\n")
    print(f"Wrote {json_path} (+ {js_path} fallback) "
          f"({sum(len(v) for v in road_data.values())} roads)")


def main():
    """Parse args, convert, write zone files."""
    ap = argparse.ArgumentParser(description="Bake map-editor roads into game zones")
    ap.add_argument("--roads", required=True, help="Path to roads.json")
    ap.add_argument("--zones", default=None, help="Path to zones.json")
    ap.add_argument("--game-dir", required=True,
                    help="Game detailed/ directory")
    ap.add_argument("--manifest", default=None,
                    help="Path to map-manifest.json (for reference)")
    args = ap.parse_args()

    # Load editor roads
    with open(args.roads) as f:
        editor_roads = json.load(f)

    # Load zones (editor polygons + game bounds fallback)
    zones = load_zones(args.zones, args.game_dir)
    if not zones:
        print("ERROR: no zones found — cannot assign roads.", file=sys.stderr)
        sys.exit(1)

    # Bucket roads by zone
    zone_roads = {zid: {c: [] for c in GAME_CATEGORIES} for zid in zones}
    unassigned = []
    for editor_cat, roads in editor_roads.items():
        if not isinstance(roads, list):
            continue
        for road in roads:
            pts = road.get("pts") or []
            if len(pts) < 2:
                continue  # skip degenerate roads
            cx, cz = road_center(pts)
            zid = zone_for_road(cx, cz, zones)
            game_cat, converted = convert_road(road, editor_cat)
            if zid:
                zone_roads[zid][game_cat].append(converted)
            else:
                unassigned.append(converted)

    # Roads outside all zones go to the zone with the nearest bounds center
    # (keeps them in the game instead of dropping them silently).
    for road in unassigned:
        pts = road.get("pts") or []
        cx, cz = road_center(pts)
        best, best_d = None, float("inf")
        for zid, z in zones.items():
            b = z.get("bounds")
            if not b:
                continue
            bx = (b["xMin"] + b["xMax"]) / 2
            bz = (b["zMin"] + b["zMax"]) / 2
            d = math.hypot(cx - bx, cz - bz)
            if d < best_d:
                best, best_d = zid, d
        if best:
            # Recover the game category from the preserved editor tag
            gcat = CATEGORY_MAP.get(road.get("_editorCat", "local"), "local")
            zone_roads[best][gcat].append(road)
        else:
            print(f"WARNING: road '{road.get('name')}' outside all zones "
                  f"and no bounds to attach to — dropped.")

    # Write each zone's roads.js
    zones_dir = os.path.join(args.game_dir, "zones")
    for zid, rdata in zone_roads.items():
        zdir = os.path.join(zones_dir, zid)
        os.makedirs(zdir, exist_ok=True)
        write_zone_roads(zdir, rdata)

    print("Done. Roads baked into game zones.")


if __name__ == "__main__":
    main()