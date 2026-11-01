# Release release-2026.11.01.5

Pushed 2026-11-01 07:22 UTC.

## Versions
- ui_version: 2026.11.01.4 -> 2026.11.01.5

## Changes
- ui 2026.11.01.5: package-mode tree collision converted from the collider REGISTRY to MESH/MATERIAL collision, per Joshua's ruling (2026-11-01). buildPkgTrees no longer registers a collider per tree (addCollider/removeCollider deleted); tiles keep each trunk's drawn frustum record {x,z,y0,y1,rB,rT,lx,lz} plus 8u build-time buckets. CollisionMaterial.pushOut gained step (6): a guarded hook into the streamed tiles resolves the mover against the trunk's actual tapered/leaning surface over the body span (14-step ternary search for the height of closest approach), so the body stops exactly at the bark — no bubble, no gap, no penetration. Mesh-first rule documented in both files: mesh collision is the default for anything with a mesh (NPCs, trunks, vehicles, terrain, water); the registry remains only for things not identifiable by a mesh. Harness-verified (Chrome 156 + SwiftShader, desktop + A17 emulation): package trees contribute ZERO registry colliders (census 0/0; audit 0 matches over 1,588-3,657 mesh trunks); solver rest 0.909 == independent frustum prediction 0.909; min body-span clearance at rest 0.501 == body radius 0.5; organic camYaw-steered walk reaches and holds 0.914; pass-by clean; stream-out leaves no ghost (solver displacement 0.000 on the dead anchor; rebuilt tree pushes out to 0.91 again); full-map .4 regressions pass on both profiles; zero exceptions everywhere. Perf vs .4 on identical streamed worlds (44 tiles / 3,493 trunks / 2,277,181 tris both): fps@6x equal (0.67), resolveCollision micro-benches at parity (spawn faster, scan equal, contact +2-5us/call on an ~11-21us call). Evidence: verification/2026-11-01-trunk-mesh-contact-side.png, -side2.png, -phone.png. Joshua's hands-on verdict is the final proof.

## Files changed
- collision_material.js (size 53238 -> 55321)
- index.html (size 1172393 -> 1181167)

## QA gates
- release lock: PASS
- cooldown: PASS
- remote HEAD readable: PASS
- inventory gate: PASS
- node --check: PASS
- smoke test: PASS
- manifest hashes regenerated: PASS
- www generator + --check: PASS
- remote HEAD stable: PASS

GitHub Pages CDN lags ~10 min; hard-refresh to verify.
