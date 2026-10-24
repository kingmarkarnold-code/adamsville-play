"""
Merge / Join geometry for the Map Editor (1.9.10, Joshua
2026-10-23).

WHY THIS MODULE EXISTS: Joshua's Blender videos. A road that
runs over the top of another has to be drawn back to the edge
it actually meets — and how its end lands depends on the
meeting: square, curved, or diagonal. And two pieces of one
road with a space between them have to be joined by a section
that follows the ends — straight when the ends run straight,
curved when they bend — coming out as ONE piece, not two
parked together. He approved the step-by-step diagrams (the
spec) on 2026-10-23 before this code was written:

  ~/workspace/your_files/merge-step-by-step.html
  ~/workspace/your_files/merge-join-more-diagrams.html

THE MODEL (road records are centreline polylines; a road's
"edge" is its centreline offset by half the road's width):

MERGE (source = the overshooting piece, target = the road
being merged into; the target is NEVER modified):
  1. Find where the source's line first meets the target's
     NEAR edge — the offset line on the source's side.
     Segment against segment, the same way stacked.py works:
     never the closest point, never the far side. Everything
     of the source past that meeting is the part lying over
     the target, and it comes off.
  2. The source's new end section is laid ALONG that near
     edge, from the meeting point to the foot of the natural
     junction (where the source's line crosses the target's
     centreline, projected back onto the edge). On a square
     meeting the two points nearly coincide — the source
     simply ends on the edge. On a diagonal (ramp) meeting
     the section runs along the edge for a stretch — the
     mouth — which is the centreline form of the diagram's
     "extend the far side, shorten the short side": the
     overshoot past the edge is cut, and the mouth extends
     along the edge to the junction foot. On a curving
     target the edge itself bends, and the section follows
     it point for point — segmented every EDGE_STEP metres
     at most, so it hugs the bend instead of bridging it
     with a chord. "Matches" means the same line at EVERY
     point, the middle included.
  3. If the source never reaches the target's edge at all
     (no overshoot — the roads merely end near each other),
     merge_result reports kind "snap" and the caller keeps
     the editor's long-standing snap behaviour for that
     case. The draw-back above is the overshoot case the
     diagrams define.

JOIN (pieces of one road, a space between consecutive pieces):
  1. The pieces are chained in road order by their nearest
     ends; every space between consecutive pieces is formed.
  2. Each space reads its two ends: the travel direction
     leaving the first piece and the travel direction
     entering the second. When both point straight through
     the space (within STRAIGHT_TOL_DEG of the line across),
     the fill is STRAIGHT — points lined up across. When
     they imply a bend, the fill is a smooth curve (a cubic
     Bezier tangent to both ends, sampled finely enough that
     no chord shows): points spread along the arc, lined up
     with both sides, so the bend is carried by the whole
     section — never a straight chord cutting the corner,
     never a kink at the seams. The ends decide; a straight
     road is never curved and a bending road never
     straightened.
  3. The result is ONE polyline — the pieces and their
     formed sections as a single record.

Pure Python, no GTK, no app imports — the canvas wraps these
functions, and the gate drives them directly as well as
through the real commit paths.

Joshua's rule: all code commented.
"""

import math

# Segmentation: points laid along an edge or a curved fill are
# never more than this far apart (metres), so a bend is carried
# by many short segments — the same <=2.5u station rule the
# re-drape applies to geometry edits (ground.redrape_road).
EDGE_STEP = 2.5

# Straight join fills may run a little longer between points;
# the points are collinear, so spacing cannot distort the line.
FILL_STEP = 5.0

# Join end-reading: an end whose travel direction is within
# this many degrees of the straight line across the space
# counts as pointing through it. Both ends must qualify (and
# agree with each other) for a straight fill.
STRAIGHT_TOL_DEG = 10.0

# Two points closer than this are the same point for dedup.
_EPS = 0.01


# ----------------------------------------------------------------------
# Small vector / polyline helpers
# ----------------------------------------------------------------------

def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _unit(a, b):
    """Unit vector from a to b, or (0, 0) for a zero segment."""
    d = _dist(a, b)
    if d == 0:
        return (0.0, 0.0)
    return ((b[0] - a[0]) / d, (b[1] - a[1]) / d)


def _angle_deg(u, v):
    """Angle between two vectors, in degrees (0..180)."""
    du = math.hypot(u[0], u[1])
    dv = math.hypot(v[0], v[1])
    if du == 0 or dv == 0:
        return 0.0
    c = (u[0] * v[0] + u[1] * v[1]) / (du * dv)
    c = max(-1.0, min(1.0, c))
    return math.degrees(math.acos(c))


def point_seg_dist(p, a, b):
    """(distance, closest point, t) from p to segment ab."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    length_sq = dx * dx + dz * dz
    if length_sq == 0:
        return _dist(p, a), (a[0], a[1]), 0.0
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length_sq
    t = max(0.0, min(1.0, t))
    q = (a[0] + dx * t, a[1] + dz * t)
    return _dist(p, q), q, t


def point_polyline_dist(p, pts):
    """Distance from p to a polyline (inf when empty)."""
    best = float("inf")
    for i in range(len(pts) - 1):
        d, _q, _t = point_seg_dist(p, pts[i], pts[i + 1])
        if d < best:
            best = d
    if len(pts) == 1:
        best = _dist(p, pts[0])
    return best


def polyline_length(pts):
    total = 0.0
    for i in range(len(pts) - 1):
        total += _dist(pts[i], pts[i + 1])
    return total


def _cum_lengths(pts):
    """Cumulative arc length at each vertex."""
    cum = [0.0]
    for i in range(len(pts) - 1):
        cum.append(cum[-1] + _dist(pts[i], pts[i + 1]))
    return cum


def point_at_arclength(pts, cum, s):
    """The point at arc position s along a polyline."""
    if s <= 0:
        return (pts[0][0], pts[0][1])
    if s >= cum[-1]:
        return (pts[-1][0], pts[-1][1])
    for i in range(len(pts) - 1):
        if cum[i + 1] >= s:
            seg = cum[i + 1] - cum[i]
            t = 0.0 if seg == 0 else (s - cum[i]) / seg
            return (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
                    pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t)
    return (pts[-1][0], pts[-1][1])


def project_on_polyline(p, pts):
    """
    Project p onto a polyline. Returns (arc_pos, point, dist):
    the arc-length position of the closest point, the point
    itself, and the distance.
    """
    cum = _cum_lengths(pts)
    best = (float("inf"), 0.0, (pts[0][0], pts[0][1]))
    for i in range(len(pts) - 1):
        d, q, t = point_seg_dist(p, pts[i], pts[i + 1])
        if d < best[0]:
            seg = cum[i + 1] - cum[i]
            best = (d, cum[i] + seg * t, q)
    return best[1], best[2], best[0]


def walk_polyline(pts, s_from, s_to, step=EDGE_STEP):
    """
    Points along a polyline from arc position s_from to s_to
    (either direction): both end positions, every vertex in
    between, plus interpolated points so no gap exceeds
    `step`. This is what lays an end section along an edge
    without chording across its bends: the edge's own vertices
    are always included, and the spacing cap keeps long
    stretches segmented.
    """
    if not pts:
        return []
    cum = _cum_lengths(pts)
    total = cum[-1]
    s_from = max(0.0, min(total, s_from))
    s_to = max(0.0, min(total, s_to))
    if abs(s_to - s_from) < 1e-9:
        return [point_at_arclength(pts, cum, s_from)]
    lo, hi = (s_from, s_to) if s_from < s_to else (s_to, s_from)
    marks = {lo, hi}
    for c in cum:
        if lo < c < hi:
            marks.add(c)
    # Fill any gap wider than `step` with even subdivisions.
    ordered = sorted(marks)
    filled = []
    for a, b in zip(ordered, ordered[1:]):
        filled.append(a)
        gap = b - a
        if gap > step:
            n = int(math.ceil(gap / step))
            for k in range(1, n):
                filled.append(a + gap * k / n)
    filled.append(ordered[-1])
    out = [point_at_arclength(pts, cum, s) for s in filled]
    if s_from > s_to:
        out.reverse()
    return out


def _seg_seg_intersect(p1, p2, p3, p4):
    """
    Intersection point of segments p1p2 and p3p4, or None.
    Touching counts. Parallel/collinear pairs return None
    (a collinear overlap is a meeting already handled by the
    caller's other checks, not a crossing).
    """
    d1 = (p2[0] - p1[0], p2[1] - p1[1])
    d2 = (p4[0] - p3[0], p4[1] - p3[1])
    denom = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(denom) < 1e-12:
        return None
    t = ((p3[0] - p1[0]) * d2[1] - (p3[1] - p1[1]) * d2[0]) / denom
    u = ((p3[0] - p1[0]) * d1[1] - (p3[1] - p1[1]) * d1[0]) / denom
    if -1e-9 <= t <= 1.0 + 1e-9 and -1e-9 <= u <= 1.0 + 1e-9:
        t = max(0.0, min(1.0, t))
        return (p1[0] + d1[0] * t, p1[1] + d1[1] * t)
    return None


def segments_cross(a_pts, b_pts):
    """True when any segment of a crosses any segment of b."""
    for i in range(len(a_pts) - 1):
        for j in range(len(b_pts) - 1):
            if _seg_seg_intersect(a_pts[i], a_pts[i + 1],
                                  b_pts[j], b_pts[j + 1]):
                return True
    return False


# ----------------------------------------------------------------------
# The target's edge (offset polyline)
# ----------------------------------------------------------------------

def offset_polyline(pts, dist, side_point=None, sign=None):
    """
    The polyline parallel to `pts` at distance `dist`. With
    `sign` (+1 / -1) the offset is built on that side of the
    travel direction (left for +1); with `side_point` instead,
    the side facing the point is kept. Interior vertices are
    offset along the averaged normal of their two segments
    (miter, clamped so a sharp bend cannot throw the point far
    away); the offset keeps the target's own vertices, so a
    curving edge's offset curves the same way — that is what
    lets a merged end BECOME the curve instead of cutting it.
    Returns (offset_pts, cum_lengths).
    """
    n = len(pts)
    if n < 2:
        return [], []

    def seg_normal(a, b):
        ux, uz = _unit(a, b)
        return (-uz, ux)  # left of travel direction

    normals = []
    for i in range(n):
        if i == 0:
            nx, nz = seg_normal(pts[0], pts[1])
        elif i == n - 1:
            nx, nz = seg_normal(pts[-2], pts[-1])
        else:
            n1 = seg_normal(pts[i - 1], pts[i])
            n2 = seg_normal(pts[i], pts[i + 1])
            nx, nz = n1[0] + n2[0], n1[1] + n2[1]
            m = math.hypot(nx, nz)
            if m < 1e-9:
                nx, nz = n1
            else:
                nx, nz = nx / m, nz / m
        normals.append((nx, nz))

    def build(sign):
        out = []
        for i, p in enumerate(pts):
            nx, nz = normals[i]
            if 0 < i < n - 1:
                # Miter scale: 1/cos(half-angle between the two
                # segment directions), clamped against spikes.
                d1 = _unit(pts[i - 1], pts[i])
                d2 = _unit(pts[i], pts[i + 1])
                cos_half = math.sqrt(
                    max(0.0, (1.0 + d1[0] * d2[0]
                              + d1[1] * d2[1]) / 2.0))
                scale = 1.0 / max(cos_half, 0.5)
            else:
                scale = 1.0
            out.append((p[0] + sign * dist * scale * nx,
                        p[1] + sign * dist * scale * nz))
        return out

    if sign is not None:
        off = build(1.0 if sign >= 0 else -1.0)
        return off, _cum_lengths(off)
    off = build(1.0)
    # Keep the side facing the given point: if the + side sits
    # farther from it than the centreline does, flip.
    if point_polyline_dist(side_point, off) \
            > point_polyline_dist(side_point, pts):
        off = build(-1.0)
    return off, _cum_lengths(off)


def _first_edge_hit(A, off, off_cum):
    """
    The source's FIRST meeting with an offset polyline, walking
    the source from its attached end: segment against segment,
    and within one source segment the earliest crossing wins.
    Returns (arc_along_A, entry_point, off_segment_index,
    off_arc, seg_index) or None.
    """
    a_cum = _cum_lengths(A)
    for i in range(len(A) - 1):
        a, b = A[i], A[i + 1]
        seg_len = _dist(a, b)
        best = None  # (t along the source segment, point, j)
        for j in range(len(off) - 1):
            x = _seg_seg_intersect(a, b, off[j], off[j + 1])
            if x is None:
                continue
            t = 0.0 if seg_len == 0 else _dist(a, x) / seg_len
            if best is None or t < best[0]:
                best = (t, x, j)
        if best is not None:
            t, entry, j = best
            _d, _q, u = point_seg_dist(entry, off[j], off[j + 1])
            off_arc = off_cum[j] \
                + (off_cum[j + 1] - off_cum[j]) * u
            return (a_cum[i] + seg_len * t, entry, j, off_arc, i)
    return None


# ----------------------------------------------------------------------
# MERGE
# ----------------------------------------------------------------------

def merge_result(source_pts, target_pts, target_half_width):
    """
    Draw the source piece back onto the target's near edge.

    source_pts / target_pts: centreline polylines [(x, z), ...]
    (either travel direction). target_half_width: half the
    target road's world width — its edge is the centreline
    offset by this much.

    Returns None when there is nothing sensible to do, else a
    dict:
      kind: "edge" (drawn back onto the near edge) or "snap"
            (no overshoot: the source never reaches the edge;
            new_source_pts is the legacy endpoint snap, tip on
            the target's centreline).
      new_source_pts: the source's replacement polyline, in the
            source's ORIGINAL point order.
      entry: where the source first meets the near edge.
      junction: the edge point the end section runs to (the
            mouth's far end); for "snap", the snap point.
      entry_target_seg: index of the target segment whose edge
            the source reaches first (the segment-based proof:
            this is a segment of the near edge, never a closest
            point and never the far side).
      mouth_length: length of the end section lying along the
            edge (about 0 for a square meeting, long for a
            ramp).
    """
    S = [(float(p[0]), float(p[1])) for p in source_pts]
    T = [(float(p[0]), float(p[1])) for p in target_pts]
    if len(S) < 2 or len(T) < 2 or target_half_width <= 0:
        return None

    # Which end is the loose (overshooting) end? The editor's
    # standing convention: the end NEARER the target is the
    # one that moves (the far end is the piece's body, running
    # back to the rest of its road). The draw-back walks the
    # source from the attached (far) end, and the near edge is
    # defined by the meeting itself: BOTH offset sides are
    # tried and the earliest meeting along the walk wins —
    # a source that has run right across the target meets its
    # near edge long before its far one. Never the closest
    # point, never the far side. (If the nearer-end direction
    # somehow meets no edge while the other direction does,
    # the direction that meets one is used.)
    def _oriented_hit(A):
        best = None  # (hit, off, off_cum)
        for sgn in (1.0, -1.0):
            off_s, off_cum_s = offset_polyline(
                T, target_half_width, sign=sgn)
            if len(off_s) < 2:
                continue
            hit = _first_edge_hit(A, off_s, off_cum_s)
            if hit is not None and (best is None
                                    or hit[0] < best[0][0]):
                best = (hit, off_s, off_cum_s)
        return best

    d0 = point_polyline_dist(S[0], T)
    d1 = point_polyline_dist(S[-1], T)
    if d1 <= d0:
        A, flipped = list(S), False
    else:
        A, flipped = S[::-1], True
    got = _oriented_hit(A)
    if got is None:
        A2 = A[::-1]
        got2 = _oriented_hit(A2)
        if got2 is not None:
            A, flipped, got = A2, not flipped, got2
    if got is None:
        # No overshoot: the source never reaches either edge.
        # Keep the editor's standing snap (the nearer end's tip
        # to the closest point on the target's centreline).
        tip = A[-1]
        snap_pt = project_on_polyline(tip, T)[1]
        new_pts = list(A[:-1]) + [snap_pt]
        if flipped:
            new_pts = new_pts[::-1]
        return {"kind": "snap", "new_source_pts": new_pts,
                "entry": None, "junction": snap_pt,
                "entry_target_seg": -1, "mouth_length": 0.0}
    (hit, off, off_cum) = got
    tip = A[-1]
    _a_arc, entry, entry_seg, entry_off_arc, entry_i = hit
    kept = A[:entry_i + 1]  # vertices up to the meeting segment

    # 2) The junction foot: where the source's own line crosses
    #    the target's centreline, projected back onto the edge.
    #    No crossing (the source dies inside the band): the foot
    #    of the tip instead.
    cross = None
    for i in range(len(A) - 1):
        for j in range(len(T) - 1):
            x = _seg_seg_intersect(A[i], A[i + 1], T[j], T[j + 1])
            if x is not None:
                cross = x
                break
        if cross is not None:
            break
    foot_from = cross if cross is not None else tip
    j_arc, j_pt, _jd = project_on_polyline(foot_from, off)

    # 3) New source: the kept part, the meeting point, then the
    #    end section ALONG the edge to the junction foot —
    #    segmented, vertices included, so a curving edge is
    #    followed point for point. A square meeting's section
    #    is a hair long and collapses to the single foot point.
    mouth = abs(j_arc - entry_off_arc)
    new_a = list(kept)
    if not new_a or _dist(new_a[-1], entry) > _EPS:
        new_a.append(entry)
    if mouth <= 0.75:
        mid = point_at_arclength(off, off_cum,
                                 (entry_off_arc + j_arc) / 2.0)
        if _dist(new_a[-1], mid) > _EPS:
            new_a.append(mid)
    else:
        for p in walk_polyline(off, entry_off_arc, j_arc,
                               EDGE_STEP):
            if _dist(new_a[-1], p) > _EPS:
                new_a.append(p)
    if len(new_a) < 2:
        return None
    if flipped:
        new_a = new_a[::-1]
    return {"kind": "edge", "new_source_pts": new_a,
            "entry": entry, "junction": j_pt,
            "entry_target_seg": entry_seg,
            "mouth_length": mouth}


# ----------------------------------------------------------------------
# JOIN
# ----------------------------------------------------------------------

def form_section(p_from, dir_from, p_to, dir_to):
    """
    Form the connecting section across ONE space.

    p_from: the end point of the piece before the space;
    dir_from: unit travel direction LEAVING that piece.
    p_to: the start point of the piece after the space;
    dir_to: unit travel direction ENTERING that piece.

    Returns (interior_points, kind): the points BETWEEN the two
    ends (the ends themselves are the pieces' own points), and
    "straight" or "arc".

    The ends decide. Both ends pointing straight through the
    space (within STRAIGHT_TOL_DEG of the line across, and of
    each other) -> a straight fill, points lined up across.
    Otherwise a cubic Bezier tangent to both ends, sampled so
    consecutive points are never more than EDGE_STEP apart —
    the bend is carried by the whole section, ends lined up
    with both sides, no chord and no seam kinks.
    """
    gap = _dist(p_from, p_to)
    if gap < _EPS:
        return [], "straight"
    across = _unit(p_from, p_to)
    a1 = _angle_deg(dir_from, across)
    a2 = _angle_deg(across, dir_to)
    bend = _angle_deg(dir_from, dir_to)
    if a1 <= STRAIGHT_TOL_DEG and a2 <= STRAIGHT_TOL_DEG \
            and bend <= 2 * STRAIGHT_TOL_DEG:
        n = max(1, int(math.ceil(gap / FILL_STEP)))
        pts = [(p_from[0] + (p_to[0] - p_from[0]) * k / n,
                p_from[1] + (p_to[1] - p_from[1]) * k / n)
               for k in range(1, n)]
        return pts, "straight"

    # Curved: tangent lengths from where the two end tangent
    # lines meet (the corner the arc rounds); fall back to half
    # the gap when the tangents are near-parallel.
    corner = _line_intersect(p_from, dir_from, p_to, dir_to)
    if corner is not None:
        k1 = min(_dist(p_from, corner), 1.2 * gap)
        k2 = min(_dist(p_to, corner), 1.2 * gap)
    else:
        k1 = k2 = 0.5 * gap
    k1 = max(k1, 0.15 * gap)
    k2 = max(k2, 0.15 * gap)
    c1 = (p_from[0] + dir_from[0] * k1,
          p_from[1] + dir_from[1] * k1)
    c2 = (p_to[0] - dir_to[0] * k2,
          p_to[1] - dir_to[1] * k2)
    approx = (_dist(p_from, c1) + _dist(c1, c2)
              + _dist(c2, p_to))
    n = max(8, int(math.ceil(approx / (EDGE_STEP * 0.8))))
    pts = []
    for k in range(1, n):
        t = k / n
        mt = 1.0 - t
        x = (mt ** 3 * p_from[0] + 3 * mt * mt * t * c1[0]
             + 3 * mt * t * t * c2[0] + t ** 3 * p_to[0])
        z = (mt ** 3 * p_from[1] + 3 * mt * mt * t * c1[1]
             + 3 * mt * t * t * c2[1] + t ** 3 * p_to[1])
        pts.append((x, z))
    return pts, "arc"


def _line_intersect(p, u, q, v):
    """Intersection of the lines p + t*u and q + s*v, or None
    when (near-)parallel."""
    denom = u[0] * v[1] - u[1] * v[0]
    if abs(denom) < 1e-9:
        return None
    t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / denom
    return (p[0] + u[0] * t, p[1] + u[1] * t)


def _end_dir(pts, at_start):
    """Unit travel direction at a polyline end: LEAVING the
    start point when at_start, ARRIVING at the end point
    otherwise — always in the direction of travel along pts."""
    if at_start:
        for i in range(len(pts) - 1):
            u = _unit(pts[0], pts[i + 1])
            if u != (0.0, 0.0):
                return u
    else:
        for i in range(len(pts) - 1, 0, -1):
            u = _unit(pts[i - 1], pts[-1])
            if u != (0.0, 0.0):
                return u
    return (0.0, 0.0)


def join_chain(pieces_pts):
    """
    Join 2+ pieces into ONE polyline (the module core of the
    editor's Join; see the module docstring for the rules).

    pieces_pts: the pieces' polylines, in any order and either
    travel direction. They are chained by nearest ends; every
    space between consecutive pieces is formed by form_section.

    Returns {"pts": the single joined polyline,
             "sections": [{"kind", "gap"} per space, in order],
             "order": indices into pieces_pts, in chain order}
    or None when fewer than two usable pieces are given.
    """
    pieces = [[(float(p[0]), float(p[1])) for p in pts]
              for pts in pieces_pts if len(pts) >= 2]
    if len(pieces) < 2:
        return None
    remaining = list(range(len(pieces)))
    first = remaining.pop(0)
    chain = list(pieces[first])
    order = [first]
    sections = []
    while remaining:
        # Nearest (chain end, piece end) pair over both chain
        # ends and every remaining piece's two ends.
        best = None  # (dist, side, piece_i, piece_end_is_start)
        for side, cend in (("end", chain[-1]), ("start", chain[0])):
            for pi in remaining:
                p = pieces[pi]
                for is_start, pend in ((True, p[0]), (False, p[-1])):
                    d = _dist(cend, pend)
                    if best is None or d < best[0]:
                        best = (d, side, pi, is_start)
        _d, side, pi, is_start = best
        piece = pieces[pi]
        # Orient the piece so travel continues across the space:
        # `oriented` starts at the connecting end.
        oriented = piece if is_start else piece[::-1]
        if side == "end":
            dir_from = _end_dir(chain, at_start=False)
            dir_to = _end_dir(oriented, at_start=True)
            fill, kind = form_section(chain[-1], dir_from,
                                      oriented[0], dir_to)
            sections.append({"kind": kind,
                             "gap": _dist(chain[-1], oriented[0])})
            for p in fill + oriented:
                if _dist(chain[-1], p) > _EPS:
                    chain.append(p)
        else:
            dir_from = _end_dir(oriented, at_start=False)
            dir_to = _end_dir(chain, at_start=True)
            fill, kind = form_section(oriented[-1], dir_from,
                                      chain[0], dir_to)
            sections.append({"kind": kind,
                             "gap": _dist(oriented[-1], chain[0])})
            head = []
            for p in oriented + fill:
                if not head or _dist(head[-1], p) > _EPS:
                    head.append(p)
            if _dist(head[-1], chain[0]) <= _EPS:
                head.pop()
            chain = head + chain
        remaining.remove(pi)
        if side == "end":
            order.append(pi)
        else:
            order.insert(0, pi)
    return {"pts": chain, "sections": sections, "order": order}


def join_pair(a_pts, b_pts):
    """
    Join exactly two pieces — the pair case the editor's Join
    button commits. Same chaining as join_chain (nearest ends),
    so the dialog's preview and the commit can never diverge.

    Returns {"pts", "sections", "a_end", "b_end"} where a_end /
    b_end are the indices into a_pts / b_pts of the endpoints at
    the join (the ends the editor's cul-de-sac carry-over asks
    about), or None.
    """
    A = [(float(p[0]), float(p[1])) for p in a_pts]
    B = [(float(p[0]), float(p[1])) for p in b_pts]
    if len(A) < 2 or len(B) < 2:
        return None
    # Nearest endpoint pair, as the editor has always chosen.
    best = None
    for ea, pa in ((0, A[0]), (len(A) - 1, A[-1])):
        for eb, pb in ((0, B[0]), (len(B) - 1, B[-1])):
            d = _dist(pa, pb)
            if best is None or d < best[0]:
                best = (d, ea, eb)
    _d, ea, eb = best
    a_oriented = A if ea == len(A) - 1 else A[::-1]
    b_oriented = B if eb == 0 else B[::-1]
    dir_from = _end_dir(a_oriented, at_start=False)
    dir_to = _end_dir(b_oriented, at_start=True)
    fill, kind = form_section(a_oriented[-1], dir_from,
                              b_oriented[0], dir_to)
    pts = list(a_oriented)
    for p in fill + list(b_oriented):
        if _dist(pts[-1], p) > _EPS:
            pts.append(p)
    return {"pts": pts,
            "sections": [{"kind": kind,
                          "gap": _dist(a_oriented[-1],
                                       b_oriented[0])}],
            "a_end": ea, "b_end": eb}
