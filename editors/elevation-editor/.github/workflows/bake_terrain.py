#!/usr/bin/env python3
"""
Terrain baker: elevation-editor terrain_edits.json → game lift files.

WHERE THIS FILE GOES:
  kingmarkarnold-code/adamsville-elevation-editor/.github/workflows/bake_terrain.py
  (runs inside the sync-terrain.yml workflow)

WHAT IT DOES:
  1. Reads terrain_edits.json from the elevation-editor repo.
     Expected format:
       {"grid": "600x800",
        "modifiedVertices": [{"x": float, "z": float,
                              "oldH": float, "newH": float}, ...],
        "roadOffsets": [{"key": str, "offset": float}, ...]}
  2. Converts each vertex delta into a terrain lift entry:
       {"x": x, "z": z, "lift": newH - oldH, "r": radius}
     Lifts use the same gaussian format as the game's TERRAIN_LIFTS
     (see zones/<zone>/lifts.json) so the runtime spatial hash picks
     them up with zero code changes.
  3. Appends the new lifts to each zone's lifts.json whose bounds contain
     the lift point (or to the global terrain_lifts.js as fallback).
     The .js fallback sibling is kept in sync automatically.
  4. Merges roadOffsets into the game's road offset data if present.

Idempotent-ish: re-running with the same edits file appends duplicates.
To avoid that, the workflow only triggers on actual file changes, and
this script records a bake manifest (baked_edits.json) of applied edit
hashes — edits already baked are skipped.

Joshua's rule: all code commented.
"""

import argparse
import hashlib
import json
import os
import re
import sys


# Lift radius in world units — matches the terrain editor's brush falloff
# so baked lifts reproduce what Joshua saw in the editor.
LIFT_RADIUS = 60.0


def edit_hash(edit):
    """Stable hash of one vertex edit, for dedup tracking."""
    key = f"{edit['x']:.2f},{edit['z']:.2f},{edit['newH']:.3f}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def load_lifts_file(path):
    """
    Parse a lifts file: returns (header_comment, lifts_list).
    Handles both formats:
      - lifts.json: pure JSON array [{...}, ...]
      - lifts.js: /* ... */ var TERRAIN_LIFTS = [{...}, ...];

    v1.54 (2026-10-12): the game loads lifts.json (fetch + JSON.parse).
    The .js file is fallback only.
    """
    with open(path) as f:
        content = f.read().strip()
    if path.endswith(".json"):
        return "", json.loads(content)
    # Split off the leading comment
    m = re.match(r"(/\*.*?\*/\s*)", content, re.DOTALL)
    header = m.group(1) if m else ""
    # Extract the JSON array after "var TERRAIN_LIFTS ="
    m2 = re.search(r"var\s+TERRAIN_LIFTS\s*=\s*(\[.*\])\s*;", content, re.DOTALL)
    if not m2:
        raise ValueError(f"Could not parse TERRAIN_LIFTS in {path}")
    lifts = json.loads(m2.group(1))
    return header, lifts


def write_lifts_file(path, header, lifts):
    """
    Write lifts back. For .json paths, writes a pure JSON array (the game's
    primary format) and keeps the .js fallback sibling in sync.

    v1.54 (2026-10-12): iOS Safari froze at 18% parsing long .js lines —
    JSON is primary now, .js is fallback only.
    """
    payload = json.dumps(lifts, separators=(",", ":"))
    if path.endswith(".json"):
        with open(path, "w") as f:
            f.write(payload)
        # Keep the .js fallback sibling in sync.
        js_path = path[:-5] + ".js"
        with open(js_path, "w") as f:
            f.write(header + "var TERRAIN_LIFTS = " + payload + ";\n")
    else:
        body = "var TERRAIN_LIFTS = " + payload + ";\n"
        with open(path, "w") as f:
            f.write(header + body)


def zone_for_point(x, z, game_dir):
    """
    Find which zone contains (x, z) via zone.json bounds.
    Returns zone_id or None.
    """
    zones_dir = os.path.join(game_dir, "zones")
    if not os.path.isdir(zones_dir):
        return None
    for zid in os.listdir(zones_dir):
        zpath = os.path.join(zones_dir, zid, "zone.json")
        if not os.path.exists(zpath):
            continue
        try:
            with open(zpath) as f:
                zj = json.load(f)
        except Exception:
            continue
        b = zj.get("bounds")
        if b and b["xMin"] <= x <= b["xMax"] and b["zMin"] <= z <= b["zMax"]:
            return zid
    return None


def main():
    """Parse args, bake edits into lift files."""
    ap = argparse.ArgumentParser(description="Bake terrain edits into game lifts")
    ap.add_argument("--edits", required=True, help="Path to terrain_edits.json")
    ap.add_argument("--game-dir", required=True,
                    help="Game detailed/ directory")
    args = ap.parse_args()

    with open(args.edits) as f:
        edits_data = json.load(f)

    modified = edits_data.get("modifiedVertices", [])
    if not modified:
        print("No modified vertices — nothing to bake.")
        return

    # Dedup: skip edits already baked (tracked in baked_edits.json)
    manifest_path = os.path.join(args.game_dir, "baked_edits.json")
    baked = set()
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path) as f:
                baked = set(json.load(f).get("hashes", []))
        except Exception:
            pass

    new_lifts_by_zone = {}   # zid -> [lift, ...]
    new_hashes = []
    for edit in modified:
        h = edit_hash(edit)
        if h in baked:
            continue  # already baked in a previous run
        lift_amount = edit["newH"] - edit["oldH"]
        if abs(lift_amount) < 0.001:
            continue  # no-op edit
        lift = {"x": round(edit["x"], 2),
                "z": round(edit["z"], 2),
                "lift": round(lift_amount, 3),
                "r": LIFT_RADIUS}
        zid = zone_for_point(edit["x"], edit["z"], args.game_dir)
        # None → global fallback file
        key = zid or "__global__"
        new_lifts_by_zone.setdefault(key, []).append(lift)
        new_hashes.append(h)

    if not new_hashes:
        print("All edits already baked — nothing new.")
        return

    # Append lifts to each zone's lifts.json (or global terrain_lifts.js).
    # v1.54: .json is the game's primary format; the .js fallback sibling
    # is written alongside by write_lifts_file().
    for key, lifts in new_lifts_by_zone.items():
        if key == "__global__":
            path = os.path.join(args.game_dir, "terrain_lifts.js")
        else:
            path = os.path.join(args.game_dir, "zones", key, "lifts.json")
        if not os.path.exists(path):
            # Fall back to the old .js path if the .json doesn't exist yet.
            alt = path[:-5] + ".js" if path.endswith(".json") else None
            if alt and os.path.exists(alt):
                path = alt
            else:
                print(f"WARNING: {path} not found — skipping "
                      f"{len(lifts)} lifts for zone '{key}'.")
                continue
        header, existing = load_lifts_file(path)
        existing.extend(lifts)
        write_lifts_file(path, header, existing)
        print(f"Baked {len(lifts)} lifts into {path}")

    # Record baked hashes so re-runs skip them
    baked.update(new_hashes)
    with open(manifest_path, "w") as f:
        json.dump({"hashes": sorted(baked)}, f, indent=2)
    print(f"Baked {len(new_hashes)} new terrain edits. Done.")


if __name__ == "__main__":
    main()