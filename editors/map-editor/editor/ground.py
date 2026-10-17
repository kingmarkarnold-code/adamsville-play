#!/usr/bin/env python3
"""
Adamsville Map Editor (Native) 1.9.0 — Ground height port + road re-drape.

WHY THIS MODULE EXISTS (Joshua's Step-1 Editors Phase, 2026-10-16):
every road record in the game's converted zone files carries "ys" —
one ground height per point, draped by the converter as
    ys[i] = terrainMeshY(x, z) + 0.01
where terrainMeshY is the game's own rendered-terrain height (see
full-build/convert.js §3 step 4 and play/detailed/index.html). If the
editor changes a road's shape but leaves stale ys behind, the game
draws the road buried under — or floating above — the visible ground.

THE RULES (implemented here, relied on by the harness):
  * NON-geometry edits (rename, category change, appearance) NEVER
    touch ys — they stay byte-identical.
  * GEOMETRY edits (move/insert/delete a point, move the whole road,
    join/merge/extend, a brand-new road) re-drape THAT ROAD ONLY:
    the polyline is resampled to <= 2.5 world-unit station spacing,
    then every ys[i] is set to ground(x, z) + 0.01.

THE GROUND FUNCTION is a faithful Python port of the game's heightAt()
+ terrainMeshY(), from the same inputs the converter used:
  * reference extractor: ~/workspace/map-data-work/full-build/ground.js
    (pulls heightAt/terrainMeshY VERBATIM out of the game's index.html
    and builds the terrain grid from the supplied ELEV, lifts empty);
  * game sources: play/detailed/index.html (heightAt) and the converted
    elevation grid play/detailed/elev.json (320 rows x 243 cols).
The port was verified against ground.js under Node at 1500 sampled
points across all 7 zones — see the 1.9.0 harness report for the
measured max error (target <= 0.01u).

HOW terrainMeshY IS PORTED CHEAPLY (and exactly): the game builds a
601x801 grid TERR_H[iy*601+ix] = heightAt(ix*TERR_CX, iy*TERR_CZ) with
TERR_CX = 8000/600, TERR_CZ = 12000/800, then bilinear-samples it with
edge clamping. A bilinear sample of a grid whose nodes are heightAt
values IS the bilinear blend of the four surrounding heightAt node
values — so this port evaluates heightAt at just the four corners per
query instead of building a 481k-node grid. Same numbers, no grid.

COORDINATES: zone files live in the game's world frame, which extends
past the 8000x12000 stage rectangle (zones reach x -7480..16314,
z -4248..30877). terrainMeshY clamps samples to the stage edge, and
this port clamps identically — ground outside the stage is the stage
edge's ground, exactly as the converter produced it.

Joshua's rule: all code commented.
"""

import math

# ---------------------------------------------------------------------------
# Game constants — copied from play/detailed/index.html (the heights block
# ground.js extracts) and the converted elev.json header. Values, not code,
# so they cannot drift from the game without a deliberate edit here.
# ---------------------------------------------------------------------------

# World <-> lat/lon projection anchors (index.html).
LON_MIN = -84.6209
LON_RANGE = 0.2418
LAT_MAX = 33.8392
LAT_RANGE = 0.3184
WX = 8000.0   # world size in game units (x)
WZ = 12000.0  # world size in game units (z)

# The Adamsville rescale both xz() and latLon() apply (index.html).
RESCALE = 2.8327464788732395
RESCALE_CX = 3772.5
RESCALE_CZ = 2009.0

# Terrain mesh resolution (index.html buildTerrain / ground.js).
TERR_SEGX = 600
TERR_SEGZ = 800
TERR_CX = WX / TERR_SEGX
TERR_CZ = WZ / TERR_SEGZ

# Hand-placed terrain features inside heightAt() (index.html).
# DM_ENT is a literal in the game: the Dollar Mill Rd entrance.
DM_ENT_X, DM_ENT_Z = 1765.5, 5637.7


def _xz(lat, lon):
    """
    Port of the game's xz(): project lat/lon into world units,
    including the always-on Adamsville rescale. Only used here to
    derive the HOME and TATUM_N anchor points exactly as the game does.
    """
    x = (lon - LON_MIN) / LON_RANGE * WX
    z = (LAT_MAX - lat) / LAT_RANGE * WZ
    x = RESCALE_CX + (x - RESCALE_CX) * RESCALE
    z = RESCALE_CZ + (z - RESCALE_CZ) * RESCALE
    return x, z


def _lat_lon(x, z):
    """Port of the game's latLon(): the true inverse of xz()."""
    x = RESCALE_CX + (x - RESCALE_CX) / RESCALE
    z = RESCALE_CZ + (z - RESCALE_CZ) / RESCALE
    return LAT_MAX - z / WZ * LAT_RANGE, LON_MIN + x / WX * LON_RANGE


# Anchors heightAt() shapes terrain around, computed via xz() exactly
# like the game (HOME = xz(33.7411, -84.52645); TATUM_N likewise).
HOME_X, HOME_Z = _xz(33.7411, -84.52645)
TATUM_N_X, TATUM_N_Z = _xz(33.75073, -84.52388)


def _gauss(x, z, cx, cz, amp, sig):
    """Port of the game's gauss(): symmetric gaussian bump/carve."""
    dx = x - cx
    dz = z - cz
    return amp * math.exp(-(dx * dx + dz * dz) / (2 * sig * sig))


class GroundModel:
    """
    The game's ground for one elevation grid (the converted elev.json).

    Construct with the parsed elev dict:
        {"lat0", "dLat", "lon0", "dLon", "rows", "cols",
         "min", "max", "g": [[...], ...]}
    Converted zones carry NO terrain lifts (CONVERSION-DESIGN §2.4),
    so the lift term of heightAt() is identically zero and is omitted
    here on purpose — documented, not forgotten.
    """

    def __init__(self, elev):
        """Store the grid and the derived ELEV_SCALE (game formula)."""
        self.elev = elev
        # ELEV_SCALE compresses real relief into game units (index.html:
        # 60 units across the whole ELEV.min..max range).
        self.elev_scale = 60.0 / (elev["max"] - elev["min"])

    # -- elevRaw: bilinear sample of the coarse elevation grid --------
    def _elev_raw(self, lat, lon):
        """
        Port of elevRaw(): bilinear sample of ELEV.g with edge clamping
        (indices clamped to cols-1.001 / rows-1.001 so i0+1 / j0+1 are
        always in range, exactly as the game does).
        """
        e = self.elev
        i = (lon - e["lon0"]) / e["dLon"]
        j = (lat - e["lat0"]) / e["dLat"]
        i = max(0.0, min(e["cols"] - 1.001, i))
        j = max(0.0, min(e["rows"] - 1.001, j))
        i0 = math.floor(i)
        j0 = math.floor(j)
        fi = i - i0
        fj = j - j0
        g = e["g"]
        a = g[j0][i0]
        b = g[j0][i0 + 1]
        c = g[j0 + 1][i0]
        d = g[j0 + 1][i0 + 1]
        return a + (b - a) * fi + (c - a) * fj + (a - b - c + d) * fi * fj

    # -- heightAt: the game's analytic ground -------------------------
    def height_at(self, x, z):
        """
        Port of heightAt(x, z) from index.html, lifts empty:
        base elevation + the Dollar Mill ridge + the two HOME bumps +
        the Tatum Lake basin carve + the fine-detail sine shimmer,
        with the game's NaN guard (non-finite -> 0).
        """
        lat, lon = _lat_lon(x, z)
        h = (self._elev_raw(lat, lon) - self.elev["min"]) * self.elev_scale
        # Dollar Mill Rd entrance ridge (asymmetric gaussian ridge,
        # elongated along the road; steep south face, gentle north fall).
        dx = x - DM_ENT_X
        dz = z - DM_ENT_Z
        u = dx * 0.12 + dz * 0.99    # along the road (north+)
        v = -dx * 0.99 + dz * 0.12   # across the road
        sig = 220.0 if u < 0 else 420.0
        h += 34.0 * math.exp(-(u * u / (2 * sig * sig)
                               + v * v / (2 * 130.0 * 130.0)))
        # Curve rise near 535 + slight decline just past it.
        h += _gauss(x, z, HOME_X + 30, HOME_Z - 40, 3.0, 55)
        h -= _gauss(x, z, HOME_X - 70, HOME_Z + 60, 2.0, 70)
        # Tatum Lake north shore basin carve.
        h += _gauss(x, z, TATUM_N_X, TATUM_N_Z, -5.0, 55)
        # (Terrain lifts: none — converted zones carry no lifts.)
        # Fine detail.
        h += (0.5 * math.sin(x * 0.011) * math.cos(z * 0.009)
              + 0.25 * math.sin(x * 0.031 + 1.7) * math.sin(z * 0.027 + 0.6))
        # The game's NaN guard: non-finite results clamp to 0.
        if not math.isfinite(h):
            h = 0.0
        return h

    # -- terrainMeshY: the rendered-terrain height --------------------
    def terrain_mesh_y(self, x, z):
        """
        Port of terrainMeshY(x, z): bilinear sample of the terrain
        mesh grid with edge clamping. Implemented as the bilinear
        blend of heightAt at the four surrounding grid nodes — the
        identical value (see the module docstring).
        """
        fx = max(0.0, min(TERR_SEGX - 0.001, x / TERR_CX))
        fz = max(0.0, min(TERR_SEGZ - 0.001, z / TERR_CZ))
        ix = math.floor(fx)
        iz = math.floor(fz)
        u = fx - ix
        v = fz - iz
        x0 = ix * TERR_CX
        z0 = iz * TERR_CZ
        a = self.height_at(x0, z0)
        b = self.height_at(x0 + TERR_CX, z0)
        c = self.height_at(x0, z0 + TERR_CZ)
        d = self.height_at(x0 + TERR_CX, z0 + TERR_CZ)
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v

    # -- the converter's drape: road height at a point ----------------
    def drape_y(self, x, z):
        """ys value for a road point: terrainMeshY + 0.01, rounded to
        3 decimals exactly as the converter rounded it (r3)."""
        return round(self.terrain_mesh_y(x, z) + 0.01, 3)


# ---------------------------------------------------------------------------
# Re-drape (geometry edits only — see the module docstring for the rules)
# ---------------------------------------------------------------------------

# Station spacing for resampled roads (task spec: <= 2.5 world units).
MAX_STATION_SPACING = 2.5


def resample_polyline(pts, max_spacing=MAX_STATION_SPACING):
    """
    Resample a polyline so no segment is longer than max_spacing,
    keeping every original vertex (endpoints included) and inserting
    evenly spaced stations along long segments. Coordinates are
    rounded to 2 decimals, the converter's pts precision (r2).
    A polyline with fewer than 2 points is returned unchanged.
    """
    if len(pts) < 2:
        return [[float(p[0]), float(p[1])] for p in pts]
    out = [[round(float(pts[0][0]), 2), round(float(pts[0][1]), 2)]]
    for i in range(1, len(pts)):
        ax, az = float(pts[i - 1][0]), float(pts[i - 1][1])
        bx, bz = float(pts[i][0]), float(pts[i][1])
        seg = math.hypot(bx - ax, bz - az)
        # Number of sub-segments so each is <= max_spacing.
        n = max(1, math.ceil(seg / max_spacing)) if seg > 0 else 1
        for k in range(1, n + 1):
            t = k / n
            out.append([round(ax + (bx - ax) * t, 2),
                        round(az + (bz - az) * t, 2)])
    return out


def redrape_road(road, ground):
    """
    Re-drape ONE road record in place after a GEOMETRY edit:
    resample its pts to <= 2.5u spacing, then set
    ys[i] = ground.terrain_mesh_y(pts[i]) + 0.01 for every point.
    Guarantees len(ys) == len(pts) afterwards. Returns the road.
    Callers must NOT call this for rename/category/appearance edits —
    those leave ys byte-identical by simply not coming here.
    """
    new_pts = resample_polyline(road.get("pts", []))
    road["pts"] = new_pts
    road["ys"] = [ground.drape_y(p[0], p[1]) for p in new_pts]
    return road
