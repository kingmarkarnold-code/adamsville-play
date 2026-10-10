#!/usr/bin/env python3
"""
============================================================================
split-zones.py — Split Surviving Adamsville map data by zone
----------------------------------------------------------------------------
JOSHUA'S DIRECTIVE (2026-10-10): "Break the map up by the zones so it's not
one continuous map."

This script splits the monolithic map data files into per-zone files:
  zones/<zone_id>/roads.js
  zones/<zone_id>/buildings.js
  zones/<zone_id>/pins.js        (junction pins)
  zones/<zone_id>/lifts.js       (terrain lifts)
  zones/<zone_id>/signs.js       (exit signs)
  zones/<zone_id>/zone.json      (metadata: bounds, scale, counts)

ZONES (from zoneunlock.js):
  mableton:    x[-200,2147],   z[-200,4218]
  adamsville:  x[2147,5398],   z[-200,4218]   (START, home base)
  downtown:    x[5398,8200],   z[-200,2202]
  eastatlanta: x[5398,8200],   z[2202,4218]
  unioncity:   x[-200,2147],   z[4218,12200]
  southfulton: x[2147,5398],   z[4218,12200]
  riverdale:   x[5398,8200],   z[4218,12200]

SPLIT RULES:
- Roads: a road belongs to a zone if ANY of its points fall within the zone
  bounds (with a small margin for boundary roads). Full road is included
  (not clipped) — simpler and safer for Phase 1.
- Buildings/pins/lifts/signs: filtered by x,z position within zone bounds.

ADAMSVILLE SCALE FIX (Joshua's directive):
- The map is compressed 2.83x (1 game mile ≈ 568u instead of 1609u).
- Adamsville data is rescaled to TRUE 1:1 (scale factor 2.833).
- Rescale is done around the zone center so the zone stays centered.
- New Adamsville bounds are written to zone.json and must be synced
  to zoneunlock.js.

USAGE:
  python3 split-zones.py [--rescale-adamsville] [--output zones/]

OUTPUT:
  Creates zones/<zone_id>/ directories with split data files.
============================================================================
"""

import json
import re
import os
import sys
import argparse
import math

# ---------------------------------------------------------------------------
# Zone definitions (must match zoneunlock.js)
# ---------------------------------------------------------------------------
ZONES = {
    'mableton':    {'name': 'Mableton',     'xMin': -200, 'xMax': 2147, 'zMin': -200,  'zMax': 4218},
    'adamsville':  {'name': 'Adamsville',   'xMin': 2147, 'xMax': 5398, 'zMin': -200,  'zMax': 4218, 'start': True},
    'downtown':    {'name': 'Downtown',     'xMin': 5398, 'xMax': 8200, 'zMin': -200,  'zMax': 2202},
    'eastatlanta': {'name': 'East Atlanta', 'xMin': 5398, 'xMax': 8200, 'zMin': 2202,  'zMax': 4218},
    'unioncity':   {'name': 'Union City',   'xMin': -200, 'xMax': 2147, 'zMin': 4218,  'zMax': 12200},
    'southfulton': {'name': 'South Fulton', 'xMin': 2147, 'xMax': 5398, 'zMin': 4218,  'zMax': 12200},
    'riverdale':   {'name': 'Riverdale',    'xMin': 5398, 'xMax': 8200, 'zMin': 4218,  'zMax': 12200},
}

# Scale factor for Adamsville true 1:1 fix
# 1 game mile ≈ 568u (measured) → true 1:1 = 1609u/mile
# Scale = 1609 / 568 = 2.833
ADAMSVILLE_SCALE = 1609.0 / 568.0  # ≈ 2.833

# Margin for boundary inclusion (units)
BOUNDARY_MARGIN = 50

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def in_zone(x, z, zone, margin=0):
    """Check if point (x,z) is within zone bounds (with optional margin)."""
    return (zone['xMin'] - margin <= x <= zone['xMax'] + margin and
            zone['zMin'] - margin <= z <= zone['zMax'] + margin)

def zone_center(zone):
    """Get center point of zone."""
    return ((zone['xMin'] + zone['xMax']) / 2,
            (zone['zMin'] + zone['zMax']) / 2)

def rescale_point(x, z, cx, cz, scale):
    """Rescale point around center by scale factor."""
    return (cx + (x - cx) * scale,
            cz + (z - cz) * scale)

def parse_js_array(filepath, var_name):
    """
    Extract a JS array variable from a file.
    Returns the raw array string (for re-emitting).
    This is a simple brace-matching parser — handles nested arrays/objects.
    """
    with open(filepath, 'r') as f:
        content = f.read()
    
    # Find "var VARNAME = " or "VARNAME = "
    patterns = [
        f'var {var_name} =',
        f'{var_name} =',
    ]
    start_idx = -1
    for pat in patterns:
        idx = content.find(pat)
        if idx != -1:
            start_idx = idx + len(pat)
            break
    
    if start_idx == -1:
        raise ValueError(f"Variable {var_name} not found in {filepath}")
    
    # Find the opening bracket
    bracket_idx = content.find('[', start_idx)
    if bracket_idx == -1:
        raise ValueError(f"No array found for {var_name} in {filepath}")
    
    # Brace matching to find the end
    depth = 0
    in_string = False
    string_char = None
    escape = False
    i = bracket_idx
    
    while i < len(content):
        c = content[i]
        
        if escape:
            escape = False
            i += 1
            continue
        
        if c == '\\' and in_string:
            escape = True
            i += 1
            continue
        
        if not in_string and c in ('"', "'"):
            in_string = True
            string_char = c
        elif in_string and c == string_char:
            in_string = False
            string_char = None
        elif not in_string:
            if c == '[':
                depth += 1
            elif c == ']':
                depth -= 1
                if depth == 0:
                    break
        
        i += 1
    
    if depth != 0:
        raise ValueError(f"Unbalanced brackets for {var_name} in {filepath}")
    
    return content[bracket_idx:i+1]

def extract_header(filepath, var_name):
    """Extract the comment header (everything before the var declaration)."""
    with open(filepath, 'r') as f:
        content = f.read()
    
    patterns = [f'var {var_name} =', f'{var_name} =']
    for pat in patterns:
        idx = content.find(pat)
        if idx != -1:
            # Go back to start of line
            line_start = content.rfind('\n', 0, idx) + 1
            return content[:line_start]
    
    return ""

# ---------------------------------------------------------------------------
# Splitters
# ---------------------------------------------------------------------------
def split_roads(input_path, output_dir, rescale_adamsville=False):
    """
    Split roads.js by zone.
    Returns: {zone_id: count}
    """
    print(f"Splitting {input_path}...")
    
    # Parse ROAD_DATA using regex for road entries
    with open(input_path, 'r') as f:
        content = f.read()
    
    # Each road: {"name":"...","pts":[[x,z],...],...}
    road_pattern = r'\{"name":"((?:[^"\\]|\\.)*)","pts":\[((?:[^\[\]]|\[[^\[\]]*\])*)\](,"ramp":1)?\}'
    
    roads = []
    for m in re.finditer(road_pattern, content):
        name = m.group(1)
        pts_str = m.group(2)
        ramp = m.group(3) is not None
        try:
            pts = json.loads('[' + pts_str + ']')
            roads.append({'name': name, 'pts': pts, 'ramp': ramp, 'raw': m.group(0)})
        except:
            continue
    
    print(f"  Parsed {len(roads)} roads")
    
    # Assign to zones
    zone_roads = {zid: [] for zid in ZONES}
    
    for road in roads:
        pts = road['pts']
        if not pts:
            continue
        
        assigned = set()
        for zid, zone in ZONES.items():
            for p in pts:
                if in_zone(p[0], p[1], zone, BOUNDARY_MARGIN):
                    assigned.add(zid)
                    break
        
        for zid in assigned:
            zone_roads[zid].append(road)
    
    # Write zone files
    counts = {}
    for zid, zone in ZONES.items():
        zroads = zone_roads[zid]
        counts[zid] = len(zroads)
        
        zone_dir = os.path.join(output_dir, zid)
        os.makedirs(zone_dir, exist_ok=True)
        
        out_path = os.path.join(zone_dir, 'roads.js')
        
        # Rescale Adamsville if requested
        if rescale_adamsville and zid == 'adamsville':
            cx, cz = zone_center(zone)
            rescaled = []
            for road in zroads:
                new_pts = [rescale_point(p[0], p[1], cx, cz, ADAMSVILLE_SCALE) for p in road['pts']]
                # Rebuild the road JSON with rescaled points
                pts_json = json.dumps(new_pts, separators=(',', ':'))
                entry = f'{{"name":{json.dumps(road["name"])},"pts":{pts_json}'
                if road['ramp']:
                    entry += ',"ramp":1'
                entry += '}'
                rescaled.append(entry)
            data_str = '[' + ','.join(rescaled) + ']'
        else:
            data_str = '[' + ','.join(r['raw'] for r in zroads) + ']'
        
        header = f"""/* ============================================================================
   ZONE ROADS — {zone['name']} ({zid})
   ----------------------------------------------------------------------------
   Split from roads.js by split-zones.py (2026-10-10).
   Joshua's directive: zone-separated maps for independent per-zone development.
   Contains {len(zroads)} roads (full roads included if any point touches zone).
"""
        if rescale_adamsville and zid == 'adamsville':
            header += f"""   SCALE FIX: Rescaled to TRUE 1:1 (factor {ADAMSVILLE_SCALE:.3f}) around
   zone center. 1 game mile now = 1609u (was ~568u).
"""
        header += """   ============================================================================ */
"""
        with open(out_path, 'w') as f:
            f.write(header)
            f.write(f"var ROAD_DATA = {data_str};\n")
        
        print(f"  {zid}: {len(zroads)} roads → {out_path}")
    
    return counts

def split_buildings(input_path, output_dir, rescale_adamsville=False):
    """
    Split osm_buildings.js by zone.
    Buildings are [x, z, w, h, height, type] arrays.
    Returns: {zone_id: count}
    """
    print(f"Splitting {input_path}...")
    
    # Extract version info
    with open(input_path, 'r') as f:
        content = f.read()
    
    ver_match = re.search(r'var OSM_BLDG_VERSION="([^"]+)"', content)
    version = ver_match.group(1) if ver_match else "unknown"
    
    count_match = re.search(r'var OSM_REAL_COUNT=(\d+)', content)
    real_count = count_match.group(1) if count_match else "unknown"
    
    # Find the buildings array
    # Format: var OSM_BUILDINGS = [[x,z,w,h,...],...];
    # Use brace matching
    try:
        arr_str = parse_js_array(input_path, 'OSM_BUILDINGS')
    except ValueError:
        # Try alternative name
        try:
            arr_str = parse_js_array(input_path, 'OSM_BUILDINGS_DATA')
        except ValueError:
            print(f"  WARNING: Could not find buildings array, trying regex...")
            # Fallback: find all [x,z,w,h,...] patterns
            bldg_pattern = r'\[(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+),([\d.]+),(\d+)\]'
            buildings = []
            for m in re.finditer(bldg_pattern, content):
                buildings.append([float(m.group(1)), float(m.group(2)), 
                                 float(m.group(3)), float(m.group(4)),
                                 float(m.group(5)), int(m.group(6))])
            print(f"  Parsed {len(buildings)} buildings via regex")
            return _write_building_zones(buildings, output_dir, version, real_count, rescale_adamsville)
    
    # Parse the array
    try:
        buildings = json.loads(arr_str)
    except:
        print(f"  WARNING: JSON parse failed, trying regex fallback...")
        bldg_pattern = r'\[(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+),([\d.]+),(\d+)\]'
        buildings = []
        for m in re.finditer(bldg_pattern, content):
            buildings.append([float(m.group(1)), float(m.group(2)),
                             float(m.group(3)), float(m.group(4)),
                             float(m.group(5)), int(m.group(6))])
    
    print(f"  Parsed {len(buildings)} buildings")
    return _write_building_zones(buildings, output_dir, version, real_count, rescale_adamsville)

def _write_building_zones(buildings, output_dir, version, real_count, rescale_adamsville):
    """Write buildings to zone files."""
    zone_bldgs = {zid: [] for zid in ZONES}
    
    for b in buildings:
        if len(b) < 2:
            continue
        x, z = b[0], b[1]
        for zid, zone in ZONES.items():
            if in_zone(x, z, zone, 0):  # No margin for buildings
                zone_bldgs[zid].append(b)
                break  # Building belongs to exactly one zone
    
    counts = {}
    for zid, zone in ZONES.items():
        zbldgs = zone_bldgs[zid]
        counts[zid] = len(zbldgs)
        
        zone_dir = os.path.join(output_dir, zid)
        os.makedirs(zone_dir, exist_ok=True)
        
        out_path = os.path.join(zone_dir, 'buildings.js')
        
        if rescale_adamsville and zid == 'adamsville':
            cx, cz = zone_center(zone)
            rescaled = []
            for b in zbldgs:
                nx, nz = rescale_point(b[0], b[1], cx, cz, ADAMSVILLE_SCALE)
                # Scale width/height too (building footprints get bigger)
                nb = [nx, nz, b[2] * ADAMSVILLE_SCALE, b[3] * ADAMSVILLE_SCALE] + b[4:]
                rescaled.append(nb)
            data_str = json.dumps(rescaled, separators=(',', ':'))
        else:
            data_str = json.dumps(zbldgs, separators=(',', ':'))
        
        header = f"""/* ============================================================================
   ZONE BUILDINGS — {zone['name']} ({zid})
   ----------------------------------------------------------------------------
   Split from osm_buildings.js by split-zones.py (2026-10-10).
   Source version: {version}
   Contains {len(zbldgs)} buildings.
"""
        if rescale_adamsville and zid == 'adamsville':
            header += f"""   SCALE FIX: Rescaled to TRUE 1:1 (factor {ADAMSVILLE_SCALE:.3f}).
"""
        header += """   ============================================================================ */
"""
        with open(out_path, 'w') as f:
            f.write(header)
            f.write(f'var OSM_BLDG_VERSION="{version}-zone-{zid}";\n')
            f.write(f"var OSM_REAL_COUNT={len(zbldgs)};\n")
            f.write(f"var OSM_BUILDINGS = {data_str};\n")
        
        print(f"  {zid}: {len(zbldgs)} buildings → {out_path}")
    
    return counts

def split_point_data(input_path, var_name, output_dir, rescale_adamsville=False, x_key='x', z_key='z'):
    """
    Generic splitter for point-based data files (junction_pins, terrain_lifts, exit_signs).
    Each entry is an object with x/z coordinates.
    Returns: {zone_id: count}
    """
    print(f"Splitting {input_path}...")
    
    try:
        arr_str = parse_js_array(input_path, var_name)
        items = json.loads(arr_str)
    except Exception as e:
        print(f"  WARNING: Could not parse {var_name}: {e}")
        return {zid: 0 for zid in ZONES}
    
    print(f"  Parsed {len(items)} items")
    
    zone_items = {zid: [] for zid in ZONES}
    
    for item in items:
        if isinstance(item, dict):
            x = item.get(x_key)
            z = item.get(z_key)
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            x, z = item[0], item[1]
        else:
            continue
        
        if x is None or z is None:
            continue
        
        for zid, zone in ZONES.items():
            if in_zone(x, z, zone, BOUNDARY_MARGIN):
                zone_items[zid].append(item)
                # Points can belong to multiple zones (for boundary continuity)
    
    counts = {}
    for zid, zone in ZONES.items():
        zitems = zone_items[zid]
        counts[zid] = len(zitems)
        
        zone_dir = os.path.join(output_dir, zid)
        os.makedirs(zone_dir, exist_ok=True)
        
        # Output filename based on var name
        fname = var_name.lower().replace('terrain_lifts', 'lifts').replace('junction_pins', 'pins').replace('exit_signs', 'signs') + '.js'
        # Actually use cleaner names
        name_map = {
            'JUNCTION_PINS': 'pins.js',
            'TERRAIN_LIFTS': 'lifts.js',
            'EXIT_SIGNS': 'signs.js',
        }
        fname = name_map.get(var_name, var_name.lower() + '.js')
        out_var = var_name  # Use original global name (e.g., JUNCTION_PINS)
        
        out_path = os.path.join(zone_dir, fname)
        
        if rescale_adamsville and zid == 'adamsville':
            cx, cz = zone_center(zone)
            rescaled = []
            for item in zitems:
                if isinstance(item, dict):
                    ni = dict(item)
                    ni[x_key], ni[z_key] = rescale_point(item[x_key], item[z_key], cx, cz, ADAMSVILLE_SCALE)
                    # Scale radius if present
                    if 'r' in ni and isinstance(ni['r'], (int, float)):
                        ni['r'] = ni['r'] * ADAMSVILLE_SCALE
                    rescaled.append(ni)
                else:
                    rescaled.append(item)
            data_str = json.dumps(rescaled, separators=(',', ':'))
        else:
            data_str = json.dumps(zitems, separators=(',', ':'))
        
        header = f"""/* ============================================================================
   ZONE {var_name} — {zone['name']} ({zid})
   ----------------------------------------------------------------------------
   Split from {input_path} by split-zones.py (2026-10-10).
   Contains {len(zitems)} items.
   ============================================================================ */
"""
        with open(out_path, 'w') as f:
            f.write(header)
            f.write(f"var {out_var} = {data_str};\n")
        
        print(f"  {zid}: {len(zitems)} items → {out_path}")
    
    return counts

def write_zone_metadata(output_dir, counts_map, rescale_adamsville=False):
    """Write zone.json metadata for each zone."""
    for zid, zone in ZONES.items():
        zone_dir = os.path.join(output_dir, zid)
        os.makedirs(zone_dir, exist_ok=True)
        
        # Calculate new bounds if Adamsville was rescaled
        bounds = {
            'xMin': zone['xMin'], 'xMax': zone['xMax'],
            'zMin': zone['zMin'], 'zMax': zone['zMax'],
        }
        scale = 1.0
        
        if rescale_adamsville and zid == 'adamsville':
            cx, cz = zone_center(zone)
            scale = ADAMSVILLE_SCALE
            bounds = {
                'xMin': cx + (zone['xMin'] - cx) * scale,
                'xMax': cx + (zone['xMax'] - cx) * scale,
                'zMin': cz + (zone['zMin'] - cz) * scale,
                'zMax': cz + (zone['zMax'] - cz) * scale,
            }
        
        metadata = {
            'id': zid,
            'name': zone['name'],
            'bounds': bounds,
            'original_bounds': {
                'xMin': zone['xMin'], 'xMax': zone['xMax'],
                'zMin': zone['zMin'], 'zMax': zone['zMax'],
            },
            'scale': scale,
            'is_start': zone.get('start', False),
            'counts': {k: v.get(zid, 0) for k, v in counts_map.items()},
            'generated': '2026-10-10',
            'generator': 'split-zones.py',
        }
        
        out_path = os.path.join(zone_dir, 'zone.json')
        with open(out_path, 'w') as f:
            json.dump(metadata, f, indent=2)
        
        print(f"  {zid}: metadata → {out_path}")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description='Split map data by zone')
    parser.add_argument('--rescale-adamsville', action='store_true',
                       help='Rescale Adamsville to true 1:1')
    parser.add_argument('--output', default='zones',
                       help='Output directory (default: zones)')
    parser.add_argument('--input-dir', default='.',
                       help='Input directory with source files (default: .)')
    args = parser.parse_args()
    
    input_dir = args.input_dir
    output_dir = args.output
    
    print("=" * 70)
    print("Zone Map Splitter — Surviving Adamsville")
    print("=" * 70)
    print(f"Input:  {input_dir}")
    print(f"Output: {output_dir}")
    print(f"Rescale Adamsville: {args.rescale_adamsville}")
    if args.rescale_adamsville:
        print(f"  Scale factor: {ADAMSVILLE_SCALE:.4f}")
    print()
    
    counts_map = {}
    
    # Split roads
    roads_path = os.path.join(input_dir, 'roads.js')
    if os.path.exists(roads_path):
        counts_map['roads'] = split_roads(roads_path, output_dir, args.rescale_adamsville)
    else:
        print(f"  SKIP: {roads_path} not found")
    print()
    
    # Split buildings
    bldg_path = os.path.join(input_dir, 'osm_buildings.js')
    if os.path.exists(bldg_path):
        counts_map['buildings'] = split_buildings(bldg_path, output_dir, args.rescale_adamsville)
    else:
        print(f"  SKIP: {bldg_path} not found")
    print()
    
    # Split junction pins
    pins_path = os.path.join(input_dir, 'junction_pins.js')
    if os.path.exists(pins_path):
        counts_map['pins'] = split_point_data(pins_path, 'JUNCTION_PINS', output_dir, args.rescale_adamsville)
    else:
        print(f"  SKIP: {pins_path} not found")
    print()
    
    # Split terrain lifts
    lifts_path = os.path.join(input_dir, 'terrain_lifts.js')
    if os.path.exists(lifts_path):
        counts_map['lifts'] = split_point_data(lifts_path, 'TERRAIN_LIFTS', output_dir, args.rescale_adamsville)
    else:
        print(f"  SKIP: {lifts_path} not found")
    print()
    
    # Split exit signs
    signs_path = os.path.join(input_dir, 'exit_signs.js')
    if os.path.exists(signs_path):
        counts_map['signs'] = split_point_data(signs_path, 'EXIT_SIGNS', output_dir, args.rescale_adamsville)
    else:
        print(f"  SKIP: {signs_path} not found")
    print()
    
    # Write metadata
    print("Writing zone metadata...")
    write_zone_metadata(output_dir, counts_map, args.rescale_adamsville)
    print()
    
    # Summary
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    for zid in ZONES:
        parts = []
        for dtype, counts in counts_map.items():
            parts.append(f"{dtype}={counts.get(zid, 0)}")
        print(f"  {zid}: {', '.join(parts)}")
    print()
    print("Done.")

if __name__ == '__main__':
    main()
