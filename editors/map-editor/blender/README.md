# Blender files — Adamsville Map Editor

Blender-compatible exports of the game map data, for use with the Blender-based 3D manipulator.

## Files
- `roads_highway.obj` — 21 highways as ribbon meshes (24u wide)
- `roads_arterial.obj` — 142 arterials as ribbon meshes (16u wide)
- `roads_local.obj` — ~9,300 local streets as ribbon meshes (10u wide)
- `adamsville_world.glb` — all roads + terrain in one GLTF binary (4 named meshes)

## Coordinate mapping
- Blender X = game X (east)
- Blender Y = -game Z (north-up; game +Z points south)
- Blender Z = height (up)
- Roads sit at terrain height + 0.55 (the game's road pin rule)

## Notes
- Single-point roads (< 2 pts) can't form ribbons and are skipped in the .obj files; they remain in the editor's ROAD_DATA.
- In Blender: File > Import > Wavefront (.obj) or glTF 2.0 (.glb).
- Tip: select a road category object, then Mesh > Separate > By Loose Parts to get individual roads.
