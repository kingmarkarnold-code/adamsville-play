#!/usr/bin/env python3
"""
The ELEMENT — the Detail Editor's one manipulation core.

Joshua's design (game-map/detail-editor/DESIGN.md, 2026-10-18): the
Detail Editor is ELEMENT-AGNOSTIC. Whatever element is loaded into
it — a road piece first, buildings and other elements later — is
manipulated the same way, so this code exists ONCE for the whole
suite and is never re-typed per element type. Adapters (see
detaildata.py for the road adapter) translate a stored record into
an Element, the user edits the Element, and the adapter translates
it back. This module knows nothing about roads, zones, files or
GitHub — only points, segments and faces.

HIS VOCABULARY (used everywhere in this app):
    POINT    — a vertex of the element: one [x, z] position in the
               flat plane. (Detail edits NEVER touch elevation;
               height belongs to the Elevation Editor. A point is
               two numbers here, never three.)
    SEGMENT  — one straight line between two neighbouring points.
    FACE     — the surface enclosed by the element's lines,
               carrying MATERIAL (a street face is real road
               surface in the game). For an open polyline element
               the face is the ribbon the segments sweep at the
               element's width — ribbon_polygon() derives it.
    PIECE    — one whole stored record (proposed word, 2026-10-18)
               — the adapter's concern, not this module's.

MODEL: the element is a small graph.
    points:   list of [x, z] positions.
    segments: list of [a, b] point-index pairs.
    payloads: a parallel list with ONE opaque entry per point —
              the adapter's per-point data that must travel with
              the point (for a road: its height value, carried
              untouched — carried, never edited; see detaildata).
              The core never interprets a payload.

OPERATIONS (the design's list, each implemented once, here):
    move_point(i, x, z)          — drag one point; only the segments
                                   touching it change shape.
    add_point_on_segment(k, ...) — split segment k with a new point.
    add_point_at_end(i, ...)     — extend from an endpoint point.
    delete_point(i)              — remove a point; when it joined
                                   exactly two segments, its two
                                   neighbours are joined straight
                                   (the kink comes out, the element
                                   stays whole). Endpoints simply
                                   shorten the element.
    add_segment(a, b)            — join two existing points.
    delete_segment(k)            — remove ONLY that segment
                                   (4 lines become 3). Deleting a
                                   MIDDLE segment breaks the join:
                                   the two sides are no longer one
                                   connected thing (chains() then
                                   reports two chains, and the road
                                   adapter writes two records).
    delete_section(chain, s0, s1)
                                 — the BULGE case from Joshua's
                                   drawing: the segments s0..s1 of
                                   one chain and the points strictly
                                   inside them are deleted whole —
                                   bowed lines AND the face inside
                                   them — and the section's two
                                   anchor points are joined by one
                                   straight segment: only the
                                   straight edge remains.
    delete_points(indices)       — the LASSO case (1.2.0): a whole
                                   SET of points, chosen together by
                                   the lasso, deleted as ONE
                                   operation. Every segment touching
                                   a deleted point goes with it and
                                   the two sides are NOT rejoined —
                                   a middle run removed leaves the
                                   element in two parts (the design's
                                   confirmed break semantics, same as
                                   a middle segment deletion); a run
                                   at an end simply shortens it.

Snapshots: pieces are small (a long road piece is a few hundred
points), so undo is a whole-element snapshot — snapshot()/restore()
deep-copy the three lists; the app keeps the undo stack.

Joshua's rule: all code commented.
"""

import copy
import math


def point_segment_distance(px, pz, ax, az, bx, bz):
    """
    (distance, t, cx, cz): distance from point P to segment A->B,
    the clamped parameter t of the closest point, and the closest
    point itself. Pure geometry, shared by picking and by the
    point-insertion maths — one implementation, suite-wide need.
    """
    dx, dz = bx - ax, bz - az
    length_sq = dx * dx + dz * dz
    if length_sq <= 0.0:
        t = 0.0
    else:
        t = ((px - ax) * dx + (pz - az) * dz) / length_sq
        t = max(0.0, min(1.0, t))
    cx, cz = ax + t * dx, az + t * dz
    return math.hypot(px - cx, pz - cz), t, cx, cz


def point_in_polygon(x, z, polygon):
    """
    True when (x, z) lies inside `polygon` — a closed loop of
    [x, z] points, given open (the last point joins back to the
    first). Even-odd ray casting, plus an explicit on-the-boundary
    test: a point sitting ON the loop's edge counts as inside (the
    lasso the user drew around a point hugging the line still
    means to take it). Pure geometry, shared by the canvas's
    lasso selection and the harness.
    """
    n = len(polygon)
    if n < 3:
        return False
    inside = False
    for i in range(n):
        ax, az = polygon[i]
        bx, bz = polygon[(i + 1) % n]
        # On the boundary counts as in.
        d, _t, _cx, _cz = point_segment_distance(x, z, ax, az, bx, bz)
        if d <= 1e-9:
            return True
        # Ray cast: does the edge straddle the horizontal ray
        # running +x from the point?
        if (az > z) != (bz > z):
            x_cross = ax + (z - az) * (bx - ax) / (bz - az)
            if x_cross > x:
                inside = not inside
    return inside


def ribbon_polygon(points, width):
    """
    The FACE of an open polyline: the polygon the centreline sweeps
    at `width`, as a closed list of [x, z] outline points (left side
    forward, right side back). Each centreline point is offset by
    half the width along the averaged normal of its neighbouring
    segments (a miter join); the two endpoints use their single
    segment's normal. Fewer than 2 points -> no face ([]).
    """
    n = len(points)
    if n < 2 or width <= 0:
        return []
    half = width / 2.0
    left, right = [], []
    for i in range(n):
        # The point's direction: average of the adjacent segments.
        dx = dz = 0.0
        if i > 0:
            dx += points[i][0] - points[i - 1][0]
            dz += points[i][1] - points[i - 1][1]
        if i < n - 1:
            dx += points[i + 1][0] - points[i][0]
            dz += points[i + 1][1] - points[i][1]
        length = math.hypot(dx, dz)
        if length <= 1e-9:
            # A doubled-back point has no direction; reuse the
            # previous offset direction (or a fixed one at the head).
            nx, nz = (left[-1][0] - points[i][0],
                      left[-1][1] - points[i][1]) if left else (0.0, half)
            nlen = math.hypot(nx, nz) or 1.0
            nx, nz = nx / nlen * half, nz / nlen * half
        else:
            # Normal = direction rotated 90 degrees, scaled to half.
            nx, nz = -dz / length * half, dx / length * half
        left.append([points[i][0] + nx, points[i][1] + nz])
        right.append([points[i][0] - nx, points[i][1] - nz])
    return left + right[::-1]


class Element:
    """
    One editable element (see the module docstring): points,
    segments between them, one opaque payload per point.
    """

    def __init__(self, points, segments=None, payloads=None):
        """Build from positions; segments default to the open chain
        through consecutive points (the shape every road piece has).
        Payloads default to None per point."""
        self.points = [[float(p[0]), float(p[1])] for p in points]
        if segments is None:
            segments = [[i, i + 1] for i in range(len(self.points) - 1)]
        self.segments = [[int(a), int(b)] for a, b in segments]
        if payloads is None:
            payloads = [None] * len(self.points)
        if len(payloads) != len(self.points):
            raise ValueError("payloads must parallel points")
        self.payloads = list(payloads)

    # -- snapshots (undo) -------------------------------------------

    def snapshot(self):
        """A deep copy of the whole element state (points, segments,
        payloads) — small enough to keep per edit for undo."""
        return (copy.deepcopy(self.points),
                copy.deepcopy(self.segments),
                copy.deepcopy(self.payloads))

    def restore(self, snap):
        """Put back a snapshot() state, exactly."""
        self.points, self.segments, self.payloads = copy.deepcopy(
            snap[0]), copy.deepcopy(snap[1]), copy.deepcopy(snap[2])

    # -- queries ------------------------------------------------------

    def neighbours(self, i):
        """The point indices joined to point i by a segment."""
        out = []
        for a, b in self.segments:
            if a == i:
                out.append(b)
            elif b == i:
                out.append(a)
        return out

    def segment_index(self, a, b):
        """Index of the segment joining a and b, or None."""
        for k, (x, y) in enumerate(self.segments):
            if (x == a and y == b) or (x == b and y == a):
                return k
        return None

    def chains(self):
        """
        The connected paths of the element: a list of chains, each a
        list of point indices in walking order. A healthy road piece
        is ONE chain; after a middle segment is deleted there are
        two. Isolated points (no segments) come back as one-point
        chains so no point is ever lost by a query. Chains start at
        an endpoint (degree != 2) when one exists; a closed loop
        starts at its lowest index.
        """
        adjacency = {}
        for a, b in self.segments:
            adjacency.setdefault(a, []).append(b)
            adjacency.setdefault(b, []).append(a)
        # Segment lookup built ONCE for the whole walk (1.2.0).
        # chains() used to call the linear-scan segment_index()
        # for every step, which made it O(points^2) — on a
        # 4,000-point piece that was ~15 million probes and over
        # a second per call, and the canvas calls chains() several
        # times per render: THE zoomed-in sluggishness. First
        # match wins, exactly like segment_index().
        seg_lookup = {}
        for k, (x, y) in enumerate(self.segments):
            seg_lookup.setdefault((x, y), k)
            seg_lookup.setdefault((y, x), k)

        def seg_index(a, b):
            return seg_lookup.get((a, b))

        seen_points = set()
        seen_segments = set()
        chains = []
        # Walk from endpoints first so chains come out in order.
        starts = sorted(i for i in range(len(self.points))
                        if len(adjacency.get(i, [])) != 2)
        starts += sorted(i for i in range(len(self.points))
                         if len(adjacency.get(i, [])) == 2)
        for start in starts:
            if start in seen_points and adjacency.get(start):
                continue
            if not adjacency.get(start):
                if start not in seen_points:
                    chains.append([start])
                    seen_points.add(start)
                continue
            if all(seg_index(start, nb) in seen_segments
                   for nb in adjacency[start]):
                continue
            chain = [start]
            seen_points.add(start)
            prev, cur = None, start
            while True:
                nexts = [nb for nb in adjacency.get(cur, [])
                         if nb != prev
                         and seg_index(cur, nb)
                         not in seen_segments]
                if not nexts:
                    break
                nb = nexts[0]
                seen_segments.add(seg_index(cur, nb))
                chain.append(nb)
                seen_points.add(nb)
                prev, cur = cur, nb
                if cur == start:
                    break  # closed loop walked home
            chains.append(chain)
        return chains

    def bounds(self):
        """(x0, z0, x1, z1) covering every point, or None if empty."""
        if not self.points:
            return None
        xs = [p[0] for p in self.points]
        zs = [p[1] for p in self.points]
        return min(xs), min(zs), max(xs), max(zs)

    # -- operations ---------------------------------------------------

    def move_point(self, i, x, z):
        """MOVE a point to (x, z) — flat plane only, by design."""
        self.points[i] = [float(x), float(z)]

    def add_point_on_segment(self, seg_i, x, z, payload=None):
        """
        ADD a point on segment seg_i at (x, z): the segment is
        replaced by two segments through the new point. Returns the
        new point's index. The caller supplies the position (usually
        the click, projected onto the segment) and the payload (for
        a road, the height interpolated between the segment's ends
        — computed by the adapter, which owns that meaning).
        """
        a, b = self.segments[seg_i]
        new_i = len(self.points)
        self.points.append([float(x), float(z)])
        self.payloads.append(payload)
        self.segments[seg_i] = [a, new_i]
        self.segments.append([new_i, b])
        return new_i

    def add_point_at_end(self, end_i, x, z, payload=None):
        """
        ADD a point joined to point end_i by a new segment (how a
        piece is extended from an endpoint). Returns the new index.
        """
        new_i = len(self.points)
        self.points.append([float(x), float(z)])
        self.payloads.append(payload)
        self.segments.append([end_i, new_i])
        return new_i

    def delete_point(self, i):
        """
        DELETE a point. Its segments go with it; when it joined
        exactly two segments, the two neighbours are joined by one
        straight segment (the point dissolves out — the element
        stays whole). An endpoint's deletion just shortens the
        element. Point indices above i shift down by one.
        """
        neighbours = self.neighbours(i)
        self.segments = [[a, b] for a, b in self.segments
                         if a != i and b != i]
        del self.points[i]
        del self.payloads[i]
        # Indices above the removed point shift down.
        self.segments = [[a - 1 if a > i else a,
                          b - 1 if b > i else b]
                         for a, b in self.segments]
        if len(neighbours) == 2:
            a, b = (n - 1 if n > i else n for n in neighbours)
            if a != b and self.segment_index(a, b) is None:
                self.segments.append([a, b])

    def delete_points(self, indices):
        """
        DELETE A SET OF POINTS (the lasso case, 1.2.0): every
        listed point goes, and every segment touching one goes
        with it. The two sides are NOT rejoined — removing a
        middle run leaves the element in two parts (chains()
        shows it, and the road adapter writes two records, the
        design's confirmed break semantics); removing a run at
        an end simply shortens the element. Points outside the
        set are never touched, and segments between two
        surviving points survive. Returns the number of points
        deleted. (Contrast delete_point(), singular: a lone
        interior point DISSOLVES — its neighbours join straight.
        A lassoed GROUP is a section, and a section breaks.)
        """
        doomed = sorted({i for i in indices
                         if 0 <= i < len(self.points)})
        if not doomed:
            return 0
        gone = set(doomed)
        self.segments = [[a, b] for a, b in self.segments
                         if a not in gone and b not in gone]
        remap = {}
        points, payloads = [], []
        for i, (p, pay) in enumerate(zip(self.points,
                                         self.payloads)):
            if i in gone:
                continue
            remap[i] = len(points)
            points.append(p)
            payloads.append(pay)
        self.points, self.payloads = points, payloads
        self.segments = [[remap[a], remap[b]]
                         for a, b in self.segments]
        return len(doomed)

    def add_segment(self, a, b):
        """
        ADD a segment joining two existing points (e.g. rejoining
        two chains). Refuses a self-join or a duplicate. Returns
        True when a segment was added.
        """
        if a == b or self.segment_index(a, b) is not None:
            return False
        self.segments.append([int(a), int(b)])
        return True

    def delete_segment(self, seg_i):
        """
        DELETE one segment — only that segment (the design's rule:
        4 lines become 3). Points stay, even ones left isolated;
        chains() shows the result honestly.
        """
        del self.segments[seg_i]

    def delete_section(self, chain, seg_pos0, seg_pos1):
        """
        DELETE A SECTION (the bulge case): the segments at chain
        positions seg_pos0..seg_pos1 (inclusive) and the points
        strictly inside the section are deleted whole; when the
        section has an anchor point on BOTH sides, the anchors are
        joined by one straight segment — only the straight edge
        remains (the face re-derives from the new centreline, so the
        material inside the bow is gone with its lines).

        chain: one chain from chains() (point indices in order).
        A section reaching a chain's end simply trims that end (no
        anchor on that side, no join segment). Points outside the
        chain are never touched. Returns the number of points
        deleted.
        """
        if seg_pos0 > seg_pos1:
            seg_pos0, seg_pos1 = seg_pos1, seg_pos0
        # Segment point-pairs the section covers.
        doomed_segments = set()
        for pos in range(seg_pos0, seg_pos1 + 1):
            a, b = chain[pos], chain[pos + 1]
            k = self.segment_index(a, b)
            if k is not None:
                doomed_segments.add(k)
        # Anchors: the points just outside the section, when the
        # section does not reach the chain's end on that side.
        left = chain[seg_pos0] if seg_pos0 > 0 else None
        right = chain[seg_pos1 + 1] if seg_pos1 < len(chain) - 2 else None
        # Interior points: strictly between the anchors along the
        # chain — they belong to the section alone.
        interior = chain[seg_pos0 + 1:seg_pos1 + 1]
        if seg_pos0 == 0:
            interior = chain[0:seg_pos1 + 1]
        if seg_pos1 == len(chain) - 2:
            interior = interior + [chain[-1]]
        interior = sorted(set(interior)
                          - {p for p in (left, right) if p is not None})
        # Delete the segments, then the interior points (highest
        # index first so lower indices stay valid while deleting).
        self.segments = [s for k, s in enumerate(self.segments)
                         if k not in doomed_segments]
        deleted_idx = []
        for i in sorted(interior, reverse=True):
            # A point is only deleted when nothing outside the
            # section still uses it (degree 0 after the cut).
            if self.neighbours(i):
                continue
            del self.points[i]
            del self.payloads[i]
            self.segments = [[a - 1 if a > i else a,
                              b - 1 if b > i else b]
                             for a, b in self.segments]
            deleted_idx.append(i)
        # Join the anchors straight, when both survived.
        if left is not None and right is not None:
            a = left - sum(1 for i in deleted_idx if i < left)
            b = right - sum(1 for i in deleted_idx if i < right)
            if a != b and self.segment_index(a, b) is None:
                self.segments.append([a, b])
        return len(deleted_idx)
