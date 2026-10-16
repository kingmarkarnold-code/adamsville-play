# Blender files — Adamsville Elevation Editor

Blender-compatible export of the game terrain, for use with the Blender-based 3D manipulator.

## Files
- `terrain_300x400.obj` — heightfield mesh, 301x401 verts, 120k quads, with vertex normals (downsampled from 601x801)
- `adamsville_world.glb` — terrain + all roads in one GLTF binary (4 named meshes)

## Coordinate mapping
- Blender X = game X (east)
- Blender Y = -game Z (north-up; game +Z points south)
- Blender Z = height (up)

## Notes
- Full-res terrain (601x801) lives in the game's `terrain_heights_adamsville_600x800.bin` (Float32 LE, PlaneGeometry order: index = iy*601+ix, x = ix*8000/600, z = iy*12000/800).
- In Blender: File > Import > Wavefront (.obj) or glTF 2.0 (.glb).
- Sculpt terrain here; roads snap to terrain at +0.55 when the game applies changes.
