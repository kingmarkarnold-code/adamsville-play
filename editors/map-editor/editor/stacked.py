"""
Stacked-pieces finder for the Map Editor (1.9.10, Joshua
2026-10-23).

WHY THIS EXISTS: Joshua's Blender recording. He selected one
spot on Fulton Industrial Boulevard Northwest; the count said
4 objects, but only 3 were visible — a fourth piece was stacked
on the same ground, invisible and unclickable, and nothing in
Blender listed what his selection contained, so there was no
way to single the extra piece out and remove it. This module is
the data half of the fix: it FINDS pieces that lie on top of
other pieces, so the Pieces panel can list them by name, frame
them, and hand them to the ordinary Delete flow. The finder
NEVER deletes anything itself.

Pure Python, no GTK, no app imports — the scan runs on a worker
thread (the app drives the corner progress bar from the
progress callback) and the gate drives it directly.

WHAT COUNTS AS STACKED (two tiers):

  Tier 1 — "certain":
    (a) zero-length records: every point the same point (or no
        points at all). They draw nothing but still exist as
        records. Why: "zero-length — draws nothing".
    (b) exact-duplicate pairs: same zone, same category, same
        name, the same points in the same order (or exactly
        reversed) — the same piece stored twice, stacked
        exactly on itself. The LATER record of the pair is
        flagged. Why: "exact duplicate of the piece above it".
        (Sharing only the two ENDPOINTS is not enough: two
        different roads can join the same junctions — the audit
        counted 145 pairs, and full-geometry matching is what
        reproduces that count.)
    (c) on-sibling records: the record's whole line (sampled
        every ~2 m, so a long chord whose endpoints merely touch
        a sibling does not count) lies within 2 m of an EARLIER
        same-name record in the same zone + category. Why:
        "lies on top of <name>".

  Tier 2 — "review": records at least 80% covered by other
  same-class records' geometry — samples every ~2 m along the
  record, a sample counting as covered when it lies within 6 m
  of another record of the same (normalised) category. Ranked
  longest first. Why: "<pct>% covered by <name>", naming the
  single record that covers the most of it. Tier 1 hits are
  never repeated here.

Ground truth these tiers were tuned against:
~/workspace/game-map/BURIED-PIECES-AUDIT-2026-10-23.md (Tier 1)
and ~/workspace/your_files/stacked-pieces-scan.md (Tier 2).

Joshua's rule: all code commented.
"""

import math

# Tier tags used in result dicts.
TIER_CERTAIN = 1
TIER_REVIEW = 2

# Tier 1(c): every point within this distance (metres) of the
# sibling's line counts as "lying on" it. 2 m is well inside any
# road's width, and well under the ~13 m spacing of legitimate
# divided-highway carriageways (the audit's calibration).
ON_SIBLING_DIST = 2.0

# Tier 2: a sample counts as covered within this distance of
# another same-class record; at/above this fraction of samples
# covered, the record is flagged for review.
COVER_DIST = 6.0
COVER_FRACTION = 0.80
SAMPLE_STEP = 2.0

# Segment grid cell for the Tier 2 coverage pass (metres). Big
# enough that a cell holds a modest number of segments, small
# enough that lookups stay local.
_GRID_CELL = 50.0

# The five road classes, for normalising legacy category names
# (mirrors data.normalize_category without importing the app:
# "arterial" -> "minor_artery", unknown -> "local").
_KNOWN_CATS = ("interstate", "highway", "major_artery",
               "minor_artery", "local")


def _norm_cat(cat):
    """Normalise a category key to one of the five classes."""
    if cat == "arterial":
        return "minor_artery"
    if cat in _KNOWN_CATS:
        return cat
    return "local"


def display_name(road):
    """The name shown for a record ('Unnamed St' is stored
    literally in the game data for unnamed pieces; a missing or
    empty name still reads 'Unnamed')."""
    return road.get("name") or "Unnamed"


def road_length(pts):
    """Polyline length in metres (0 for fewer than 2 points)."""
    total = 0.0
    for i in range(len(pts) - 1):
        total += math.hypot(pts[i + 1][0] - pts[i][0],
                            pts[i + 1][1] - pts[i][1])
    return total


def _point_seg_dist(px, pz, ax, az, bx, bz):
    """Distance from point P to segment AB."""
    dx, dz = bx - ax, bz - az
    length_sq = dx * dx + dz * dz
    if length_sq == 0:
        return math.hypot(px - ax, pz - az)
    t = ((px - ax) * dx + (pz - az) * dz) / length_sq
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + dx * t), pz - (az + dz * t))


def _point_polyline_dist(px, pz, pts):
    """Distance from a point to a polyline (inf for < 2 points,
    except a 1-point 'polyline' measures to that point)."""
    if not pts:
        return float("inf")
    if len(pts) == 1:
        return math.hypot(px - pts[0][0], pz - pts[0][1])
    best = float("inf")
    for i in range(len(pts) - 1):
        d = _point_seg_dist(px, pz, pts[i][0], pts[i][1],
                            pts[i + 1][0], pts[i + 1][1])
        if d < best:
            best = d
    return best


def _samples(pts, step=SAMPLE_STEP):
    """
    Densified sample points along a polyline: both endpoints
    plus a point every `step` metres of arc length. Used by the
    Tier 2 coverage pass (the stacked-scan method).
    """
    if len(pts) < 2:
        return list(pts)
    out = [pts[0]]
    carry = 0.0  # arc length since the last emitted sample
    for i in range(len(pts) - 1):
        ax, az = pts[i]
        bx, bz = pts[i + 1]
        seg_len = math.hypot(bx - ax, bz - az)
        if seg_len == 0:
            continue
        # Walk this segment emitting a sample every `step`.
        d = step - carry
        while d < seg_len:
            t = d / seg_len
            out.append((ax + (bx - ax) * t, az + (bz - az) * t))
            d += step
        # Arc length from the last emitted sample to this
        # segment's end carries into the next segment.
        carry = (carry + seg_len) % step
    out.append(pts[-1])
    return out


# ----------------------------------------------------------------------
# Tier 1 — certain
# ----------------------------------------------------------------------

def _tier1(entries):
    """
    Run the three Tier 1 checks over entries (each a dict with
    cat / zone / idx / road). Returns (flagged, twins):
    flagged maps id(road) -> result-fields for every flagged
    record; twins maps id(road) -> the set of id(road)s of its
    exact-duplicate twins (the (b) pairs, both directions), so
    the Tier 2 pass can ignore coverage that comes only from a
    record's own twin — the pair is already reported once, as
    Tier 1, and the original must not reappear in Tier 2 as
    "covered by" its copy.
    """
    flagged = {}
    twins = {}

    def flag(entry, why):
        flagged[id(entry["road"])] = {"why": why, "coverage": None,
                                      "coverer": None}

    # (a) Zero-length: no points, or every point the same point.
    for e in entries:
        pts = e["road"].get("pts") or []
        if not pts or all(p == pts[0] for p in pts):
            flag(e, "zero-length — draws nothing")

    # Group by (zone, category) for the pair/sibling checks —
    # records only stack WITHIN one zone file's category list.
    groups = {}
    for e in entries:
        groups.setdefault((e["zone"], e["cat"]), []).append(e)

    for group in groups.values():
        group.sort(key=lambda e: e["idx"])
        # (b) Exact duplicates: same name + the same full point
        # sequence, in order or exactly reversed. The first
        # record of a set is the original; every later one is
        # flagged.
        seen = {}
        for e in group:
            if id(e["road"]) in flagged:
                continue
            pts = e["road"].get("pts") or []
            if len(pts) < 2:
                continue
            fwd = tuple(tuple(p) for p in pts)
            key = ((e["road"].get("name") or ""),
                   min(fwd, fwd[::-1]))
            if key in seen:
                flag(e, "exact duplicate of the piece above it")
                orig = seen[key]
                twins.setdefault(id(e["road"]), set()).add(
                    id(orig["road"]))
                twins.setdefault(id(orig["road"]), set()).add(
                    id(e["road"]))
            else:
                seen[key] = e
        # (c) On-sibling: every point within ON_SIBLING_DIST of
        # an EARLIER same-name record's line. (Earlier-only is
        # what keeps the original of a duplicate pair — and the
        # real road under a later stub — from being flagged.)
        by_name = {}
        for e in group:
            by_name.setdefault(e["road"].get("name") or "",
                               []).append(e)
        for name, named in by_name.items():
            named.sort(key=lambda e: e["idx"])
            # Bbox grid over the earlier records' bounding boxes
            # so the point tests only run against neighbours
            # (the unnamed groups hold thousands of records).
            earlier = []       # entries already passed (idx order)
            cell = 100.0
            grid = {}
            for e in named:
                if id(e["road"]) not in flagged:
                    pts = e["road"].get("pts") or []
                    if pts:
                        xs = [p[0] for p in pts]
                        zs = [p[1] for p in pts]
                        cand_ids = set()
                        cx0 = int((min(xs) - ON_SIBLING_DIST)
                                  // cell)
                        cx1 = int((max(xs) + ON_SIBLING_DIST)
                                  // cell)
                        cz0 = int((min(zs) - ON_SIBLING_DIST)
                                  // cell)
                        cz1 = int((max(zs) + ON_SIBLING_DIST)
                                  // cell)
                        for cx in range(cx0, cx1 + 1):
                            for cz in range(cz0, cz1 + 1):
                                cand_ids.update(
                                    grid.get((cx, cz), ()))
                        for ci in cand_ids:
                            sib = earlier[ci]
                            sib_pts = sib["road"].get("pts") or []
                            if len(sib_pts) < 2:
                                continue
                            if all(
                                    _point_polyline_dist(
                                        p[0], p[1], sib_pts)
                                    <= ON_SIBLING_DIST
                                    for p in _samples(pts)):
                                flag(e, "lies on top of "
                                     + display_name(sib["road"]))
                                break
                # This record becomes an "earlier" candidate for
                # the records after it, flagged or not (a flagged
                # duplicate's line is still the same ground).
                pts = e["road"].get("pts") or []
                if len(pts) >= 2:
                    xs = [p[0] for p in pts]
                    zs = [p[1] for p in pts]
                    ci = len(earlier)
                    earlier.append(e)
                    for cx in range(int(min(xs) // cell),
                                    int(max(xs) // cell) + 1):
                        for cz in range(int(min(zs) // cell),
                                        int(max(zs) // cell) + 1):
                            grid.setdefault((cx, cz),
                                            []).append(ci)
    return flagged, twins


# ----------------------------------------------------------------------
# Tier 2 — review (coverage)
# ----------------------------------------------------------------------

def _tier2(entries, tier1_flagged, twins, on_progress=None):
    """
    Coverage pass. Subjects: records with >= 2 points that
    Tier 1 did not flag. Coverers: every other record of the
    same normalised class (any zone — pieces stack across zone
    borders too), Tier 1 records included (a duplicate's line is
    still ground another piece can lie on) — EXCEPT the
    subject's own exact-duplicate twins: that pair is already
    reported once in Tier 1, and neither half should reappear
    here as "covered by" the other.
    """
    # Twin lookup by entry position (twins arrive keyed by
    # id(road)).
    pos_of = {id(e["road"]): ei for ei, e in enumerate(entries)}
    twin_pos = {}
    for ei, e in enumerate(entries):
        tw = twins.get(id(e["road"]))
        if tw:
            twin_pos[ei] = {pos_of[t] for t in tw if t in pos_of}
    # Segment grid: cell -> [(entry_index, ax, az, bx, bz)].
    # Segments are filed under every cell their bbox — grown by
    # COVER_DIST — touches, so a sample only ever needs to look
    # in its own cell.
    grid = {}
    for ei, e in enumerate(entries):
        pts = e["road"].get("pts") or []
        if len(pts) < 2:
            continue
        cls = _norm_cat(e["cat"])
        for i in range(len(pts) - 1):
            ax, az = pts[i]
            bx, bz = pts[i + 1]
            cx0 = int((min(ax, bx) - COVER_DIST) // _GRID_CELL)
            cx1 = int((max(ax, bx) + COVER_DIST) // _GRID_CELL)
            cz0 = int((min(az, bz) - COVER_DIST) // _GRID_CELL)
            cz1 = int((max(az, bz) + COVER_DIST) // _GRID_CELL)
            for cx in range(cx0, cx1 + 1):
                for cz in range(cz0, cz1 + 1):
                    grid.setdefault((cx, cz), []).append(
                        (ei, cls, ax, az, bx, bz))

    subjects = [ei for ei, e in enumerate(entries)
                if id(e["road"]) not in tier1_flagged
                and len(e["road"].get("pts") or []) >= 2]
    results = []
    total = max(1, len(subjects))
    for n, ei in enumerate(subjects):
        if on_progress is not None and n % 128 == 0:
            on_progress(n / total)
        e = entries[ei]
        cls = _norm_cat(e["cat"])
        skip = twin_pos.get(ei, ())
        samples = _samples(e["road"].get("pts") or [])
        if not samples:
            continue
        need = math.ceil(COVER_FRACTION * len(samples))
        max_uncovered = len(samples) - need
        covered = 0
        uncovered = 0
        per_coverer = {}
        for (sx, sz) in samples:
            cell_key = (int(sx // _GRID_CELL), int(sz // _GRID_CELL))
            best_coverer = None
            for (ci, ccls, ax, az, bx, bz) in grid.get(cell_key,
                                                       ()):
                if ci == ei or ci in skip or ccls != cls:
                    continue
                # Cheap bbox reject before the distance math.
                if sx < min(ax, bx) - COVER_DIST \
                        or sx > max(ax, bx) + COVER_DIST \
                        or sz < min(az, bz) - COVER_DIST \
                        or sz > max(az, bz) + COVER_DIST:
                    continue
                if _point_seg_dist(sx, sz, ax, az, bx, bz) \
                        <= COVER_DIST:
                    best_coverer = ci
                    break
            if best_coverer is None:
                uncovered += 1
                if uncovered > max_uncovered:
                    break  # can no longer reach the bar — stop
            else:
                covered += 1
                per_coverer[best_coverer] = \
                    per_coverer.get(best_coverer, 0) + 1
        else:
            # The loop finished without the early exit: judge it.
            if covered >= need and per_coverer:
                top = max(per_coverer,
                          key=lambda ci: per_coverer[ci])
                cov = covered / len(samples)
                coverer = entries[top]
                results.append({
                    "entry": e,
                    "why": f"{int(round(cov * 100))}% covered by "
                           + display_name(coverer["road"]),
                    "coverage": cov,
                    "coverer": coverer,
                })
    # Ranked longest first (the review order Joshua asked for).
    results.sort(
        key=lambda r: -road_length(r["entry"]["road"].get("pts")
                                   or []))
    return results


# ----------------------------------------------------------------------
# The scan entry point
# ----------------------------------------------------------------------

def scan_stacked(entries, on_progress=None):
    """
    Scan entries for stacked pieces. Each entry is a dict:
      {"cat": category key, "zone": zone id, "idx": the record's
       index within its zone + category list, "road": road dict}

    Returns a list of result dicts:
      {"cat", "zone", "idx", "road", "tier", "why", "coverage",
       "coverer", "length"}
    Tier 1 ("certain") first, in data order; then Tier 2
    ("review"), longest first. on_progress(fraction), when
    given, fires from this thread as the work advances — the
    caller hops it to the UI. This function NEVER mutates the
    road data.
    """
    if on_progress is not None:
        on_progress(0.0)
    tier1, twins = _tier1(entries)
    results = []
    for e in entries:
        info = tier1.get(id(e["road"]))
        if info is None:
            continue
        results.append({
            "cat": e["cat"], "zone": e["zone"], "idx": e["idx"],
            "road": e["road"], "tier": TIER_CERTAIN,
            "why": info["why"], "coverage": None, "coverer": None,
            "length": road_length(e["road"].get("pts") or []),
        })

    def tier2_progress(frac):
        if on_progress is not None:
            on_progress(0.1 + 0.9 * frac)

    for r in _tier2(entries, tier1, twins,
                    on_progress=tier2_progress if on_progress
                    else None):
        e = r["entry"]
        results.append({
            "cat": e["cat"], "zone": e["zone"], "idx": e["idx"],
            "road": e["road"], "tier": TIER_REVIEW,
            "why": r["why"], "coverage": r["coverage"],
            "coverer": r["coverer"],
            "length": road_length(e["road"].get("pts") or []),
        })
    if on_progress is not None:
        on_progress(1.0)
    return results
