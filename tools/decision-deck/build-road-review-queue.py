#!/usr/bin/env python3
"""build-road-review-queue.py — generate a Decision Deck queue of the
road pieces in one zone that "don't seem to fit", for Joshua to review
one card at a time (his design, 2026-10-18).

WHAT IT DOES
  Reads the zone's own data files (detailed/zones/<zone>/roads.json +
  roads_detail.json + buildings.json + zone.json — the same files the
  game loads), measures every road record against five plain criteria,
  and writes a deck queue (tools/decision-deck/queues/<zone>-roads.json)
  ranked worst-first: the most certain junk is card 1.

THE CRITERIA (all measurable; counts are reported per criterion)
  degenerate — the record's points collapse to under 2 metres of road:
               a record that is, literally, a piece of nothing.
  island     — both ends end in the grass AND no other road passes
               within 5 metres of any part of it: a piece (or a whole
               little street) cut off from the road network entirely.
  overlap    — the piece runs right on top of another road: one other
               road accounts for >= 50% of its length within 2.2 m
               (junction grazing within 3 m of the piece's own ends is
               not counted), or >= 80% of its length lies within 2.2 m
               of other roads (and it is short). Two roads drawn in
               the same place.
  stub       — a short spur (<= 40 m, unnamed or service-class) joined
               to the network at one end whose other end stops in the
               grass with NO building at its end. (A spur that ends AT
               a building is a driveway — those are never queued.)
  fragment   — a piece <= 15 m with a loose end (same driveway guard).
  gap        — an end that stops 6–35 m short of the road it should
               meet (and not at a building): a broken join. Both ends
               broken ranks far above one end broken (one-end gaps are
               only queued for pieces <= 80 m).

  Ends that run off the zone's edge are never "loose" — the road
  continues into the next zone. Ends touching another road's line
  within 6 m count as connected, whatever the endpoint gap is.

WHAT IT NEVER DOES
  It never edits road data. The queue only RECORDS decisions (in the
  deck); applying them is a separate step on Joshua's word.

CARD CONTENT
  Each item carries a SnapshotView "road scene": the piece highlighted
  in green in its surroundings (neighbouring roads as asphalt ribbons,
  nearby buildings as muted boxes), plus the piece's full road (the
  connected same-name chain) for the deck's piece/full-road toggle,
  and plain identifying lines: length, what each end connects to, and
  why the piece is in the queue, in words.

GESTURE MEANINGS (declared BY THE QUEUE, per Joshua 2026-10-18)
  right      -> delete  ("DELETE — cut this piece")
  left       -> keep    ("KEEP — this piece stays")
  double-tap -> skip    ("SKIP — save for further review")
  Every other gesture stays unassigned in this queue.

USAGE
  python3 tools/decision-deck/build-road-review-queue.py [--zone adamsville]
          [--repo ROOT] [--out PATH] [--report]
  Defaults: repo = the repo this script lives in; out =
  tools/decision-deck/queues/<zone>-roads.json under that repo.
"""
import argparse, json, math, os, sys
from collections import defaultdict, Counter

# ----------------------------------------------------------------------
# Geometry thresholds (metres = game units; the game's scale is 1:1).
# ----------------------------------------------------------------------
CONNECT_DIST = 6.0     # endpoint this close to another road's line = joined
GAP_DIST = 35.0        # endpoint farther than CONNECT but within GAP = broken join
BORDER_MARGIN = 40.0   # endpoints this close to the zone edge run off-map
OVERLAP_DIST = 2.2     # "running on top of" distance between centrelines
ISLAND_CLEAR = 5.0     # an island's body stays at least this far from all roads
BUILDING_GUARD = 18.0  # a loose end this close to a building is a driveway end
STUB_MAX_LEN = 40.0
FRAGMENT_MAX_LEN = 15.0
GAP1_MAX_LEN = 80.0
CHAIN_MAX_RECORDS = 48
CHAIN_MAX_POINTS = 280

CLASS_PLAIN = {
    'highway': 'highway',
    'major_artery': 'main road',
    'minor_artery': 'arterial road',
    'local': 'local street',
}


def seg_dist(px, pz, a, b):
    """Exact distance from point (px, pz) to segment a-b."""
    ax, az = a; bx, bz = b
    dx, dz = bx - ax, bz - az
    l2 = dx * dx + dz * dz
    if l2 == 0:
        return math.hypot(px - ax, pz - az)
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / l2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def poly_len(pts):
    return sum(math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1])
               for k in range(len(pts) - 1))


def densify(pts, step=3.0):
    """Sample points along a polyline every ~step metres."""
    out = []
    for k in range(len(pts) - 1):
        a, b = pts[k], pts[k + 1]
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(seg / step))
        for j in range(n):
            t = j / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    out.append(tuple(pts[-1]))
    return out


class Zone:
    """The zone's roads with a segment grid for exact distance queries."""

    CELL = 12.0

    def __init__(self, repo, zone_id):
        zdir = f'{repo}/detailed/zones/{zone_id}'
        roads = json.load(open(f'{zdir}/roads.json'))
        detail = json.load(open(f'{zdir}/roads_detail.json'))
        self.buildings = json.load(open(f'{zdir}/buildings.json'))['buildings']
        self.bounds = json.load(open(f'{zdir}/zone.json'))['bounds']
        self.zone_id = zone_id
        self.recs = []
        for cls, arr in roads.items():
            darr = detail.get(cls, [])
            for i, r in enumerate(arr):
                d = darr[i] if i < len(darr) else {}
                self.recs.append({
                    'n': len(self.recs), 'cls': cls, 'i': i,
                    'id': f'{zone_id}:{cls}:{i}',
                    'deckid': f'road-{zone_id}-{cls}-{i}',
                    'name': r.get('name'), 'pts': r['pts'],
                    'len': poly_len(r['pts']),
                    'width': d.get('width_m') or 7.2,
                    'osm': d.get('osm_class'),
                })
        # Segment grid: cell -> [(recidx, segidx)]
        self.sgrid = defaultdict(list)
        for r in self.recs:
            for k in range(len(r['pts']) - 1):
                a, b = r['pts'][k], r['pts'][k + 1]
                seg = math.hypot(b[0] - a[0], b[1] - a[1])
                steps = max(1, int(seg / (self.CELL / 2)))
                for j in range(steps + 1):
                    t = j / steps
                    key = (int((a[0] + (b[0] - a[0]) * t) // self.CELL),
                           int((a[1] + (b[1] - a[1]) * t) // self.CELL))
                    self.sgrid[key].append((r['n'], k))
        # Building grid for the driveway guard.
        self.BCELL = 25.0
        self.bgrid = defaultdict(list)
        for bi, b in enumerate(self.buildings):
            self.bgrid[(int(b[0] // self.BCELL), int(b[1] // self.BCELL))].append(bi)

    def nearest_other(self, px, pz, selfn, maxr=36.0):
        """Exact nearest distance from a point to any OTHER record's
        polyline, and that record's index. Returns (999.0, -1) when
        nothing lies within reach."""
        best = 1e9; who = -1; seen = set(); ring = 0
        while ring <= 4:
            rad = ring * self.CELL
            if ring > 0 and rad > maxr + self.CELL and best < 1e8:
                break
            cx, cz = int(px // self.CELL), int(pz // self.CELL)
            for gx in range(cx - ring, cx + ring + 1):
                for gz in range(cz - ring, cz + ring + 1):
                    if ring and abs(gx - cx) != ring and abs(gz - cz) != ring:
                        continue
                    for (rn, k) in self.sgrid.get((gx, gz), ()):
                        if rn == selfn or (rn, k) in seen:
                            continue
                        seen.add((rn, k))
                        d = seg_dist(px, pz, self.recs[rn]['pts'][k],
                                     self.recs[rn]['pts'][k + 1])
                        if d < best:
                            best, who = d, rn
            if best <= rad:
                break
            ring += 1
        return (best if best < 1e8 else 999.0), who

    def building_near(self, x, z, rad=BUILDING_GUARD):
        """True when a building's box comes within rad of the point —
        a loose end here is a driveway arriving somewhere, not a glitch."""
        cx, cz = int(x // self.BCELL), int(z // self.BCELL)
        R = int(rad // self.BCELL) + 1
        for gx in range(cx - R, cx + R + 1):
            for gz in range(cz - R, cz + R + 1):
                for bi in self.bgrid.get((gx, gz), ()):
                    b = self.buildings[bi]
                    dx = max(abs(x - b[0]) - b[2] / 2, 0.0)
                    dz = max(abs(z - b[1]) - b[3] / 2, 0.0)
                    if math.hypot(dx, dz) <= rad:
                        return True
        return False

    def near_border(self, x, z):
        B = self.bounds
        return (x - B['xMin'] < BORDER_MARGIN or B['xMax'] - x < BORDER_MARGIN or
                z - B['zMin'] < BORDER_MARGIN or B['zMax'] - z < BORDER_MARGIN)

    def analyse(self):
        """Measure every record: end states, overlap, isolation."""
        for r in self.recs:
            ends = []
            for p in (r['pts'][0], r['pts'][-1]):
                if self.near_border(p[0], p[1]):
                    ends.append({'state': 'border', 'd': 0.0, 'who': -1,
                                 'served': False})
                else:
                    d, who = self.nearest_other(p[0], p[1], r['n'], maxr=GAP_DIST + 1)
                    state = ('connect' if d <= CONNECT_DIST else
                             'gap' if d <= GAP_DIST else 'free')
                    ends.append({'state': state, 'd': d, 'who': who,
                                 'served': self.building_near(p[0], p[1])})
            r['ends'] = ends
            # Overlap + isolation sampling at 1.5 m. Junction grazing is
            # excluded by construction: samples within 3 m of either
            # END of the piece are ignored for the overlap test, because
            # a joined neighbour always touches there — an endpoint
            # sample sitting on the next road says nothing about the
            # piece running on top of it.
            samples = densify(r['pts'], step=1.5)
            arc = [0.0]
            for k in range(1, len(samples)):
                arc.append(arc[-1] + math.hypot(
                    samples[k][0] - samples[k - 1][0],
                    samples[k][1] - samples[k - 1][1]))
            hits = Counter(); mind = 999.0
            n_ov = 0
            for j, (x, z) in enumerate(samples):
                d, who = self.nearest_other(x, z, r['n'], maxr=10.0)
                if d < mind:
                    mind = d
                if 3.0 <= arc[j] <= r['len'] - 3.0:
                    n_ov += 1
                    if d <= OVERLAP_DIST and who >= 0:
                        hits[who] += 1
            r['mind'] = mind
            r['ov_frac'] = sum(hits.values()) / max(1, n_ov)
            if hits:
                who, cnt = hits.most_common(1)[0]
                r['ov_who'] = who
                r['ov_best'] = cnt / max(1, n_ov)
            else:
                r['ov_who'] = -1; r['ov_best'] = 0.0


def is_unnamed(r):
    return not r['name'] or r['name'] == 'Unnamed St'


def dead(e):
    return e['state'] in ('gap', 'free')


def classify(r):
    """The criteria this record meets (frozen definitions, 2026-10-18)."""
    E = r['ends']
    nd_dead = sum(1 for e in E if dead(e))
    cats = []
    if r['len'] < 2.0:
        cats.append('degenerate')
    if nd_dead == 2 and r['mind'] > ISLAND_CLEAR:
        cats.append('island')
    if r['len'] >= 8 and r['ov_who'] >= 0 and (
            r['ov_best'] >= 0.50 or (r['ov_frac'] >= 0.80 and r['len'] <= 25)):
        other = ZONE.recs[r['ov_who']]
        if r['len'] <= other['len'] * 1.05 or r['len'] <= 40:
            cats.append('overlap')
    if (r['len'] <= STUB_MAX_LEN and nd_dead == 1
            and any(e['state'] in ('connect', 'border') for e in E)
            and (is_unnamed(r) or r['osm'] == 'service')
            and not any(e['served'] for e in E if dead(e))):
        cats.append('stub')
    if (r['len'] <= FRAGMENT_MAX_LEN and nd_dead >= 1
            and not any(e['served'] for e in E if dead(e))):
        cats.append('fragment')
    gaps = [e for e in E if e['state'] == 'gap' and not e['served']]
    if gaps and nd_dead == 2:
        cats.append('gap2')
    elif gaps and r['len'] <= GAP1_MAX_LEN:
        cats.append('gap1')
    return cats


def score(r, cats):
    s = 0.0
    if 'degenerate' in cats: s = max(s, 110)
    if 'island' in cats: s = max(s, 100 + min(20, r['mind']))
    if 'gap2' in cats: s = max(s, 85)
    if 'overlap' in cats: s = max(s, 80 + 20 * (r['ov_frac'] - 0.55))
    if 'stub' in cats: s = max(s, 70)
    if 'fragment' in cats: s = max(s, 60)
    if 'gap1' in cats: s = max(s, 50)
    return s


def primary_reason(r, cats):
    """The plain-words reason for the card, from the strongest criterion."""
    E = r['ends']
    if 'degenerate' in cats:
        return ("This record is only %.1f metres long — its points collapse "
                "to almost a single spot. It draws as nothing." % r['len'])
    if 'island' in cats:
        return ("This piece touches no other road. Both ends end in the "
                "grass, and no road passes within %.0f metres of it — it "
                "is cut off from the road network." % r['mind'])
    if 'gap2' in cats:
        parts = []
        for e in E:
            if e['state'] == 'gap':
                parts.append('one stops %.0f metres short of the road it '
                             'should meet' % e['d'])
            elif e['state'] == 'free':
                parts.append('one ends in the grass entirely')
        return ("Both ends of this piece are cut off: %s. The piece is "
                "joined to nothing." % '; '.join(parts))
    if 'overlap' in cats:
        other = ZONE.recs[r['ov_who']]
        oname = other['name'] if not is_unnamed(other) else 'an unnamed road'
        return ("About %d%% of this piece runs right on top of %s — two "
                "roads drawn in the same place."
                % (round(100 * r['ov_frac']), oname))
    if 'stub' in cats:
        return ("A short spur: one end joins the road network, the other "
                "end reaches nothing — no road joins it there, and there "
                "is no building at its end, so it is not a driveway. It "
                "goes nowhere.")
    if 'fragment' in cats:
        return ("A tiny piece, %.0f metres, with a loose end that reaches "
                "nothing and ends at no building." % r['len'])
    if 'gap1' in cats:
        e = next(e for e in E if e['state'] == 'gap')
        other = ZONE.recs[e['who']]
        oname = other['name'] if (e['who'] >= 0 and not is_unnamed(other)) \
            else 'the nearest road'
        return ("One end of this piece stops %.0f metres short of %s — "
                "the join between them is broken." % (e['d'], oname))
    return "This piece was flagged for review."


def end_labels(r):
    """Compass labels for the two ends (pts[0], pts[-1]) from the
    centroid. Game axes: +x is east, +z is south. Falls back to
    'One end'/'Other end' when both ends fall in the same direction."""
    cx = sum(p[0] for p in r['pts']) / len(r['pts'])
    cz = sum(p[1] for p in r['pts']) / len(r['pts'])
    labels = []
    for p in (r['pts'][0], r['pts'][-1]):
        dx, dz = p[0] - cx, p[1] - cz
        if abs(dx) >= abs(dz):
            labels.append('East end' if dx > 0 else 'West end')
        else:
            labels.append('South end' if dz > 0 else 'North end')
    if labels[0] == labels[1]:
        labels = ['One end', 'Other end']
    return labels


def end_description(r, e):
    """Plain words for what one end connects to."""
    if e['state'] == 'border':
        return 'runs off the edge of the Adamsville map (the road continues into the next zone)'
    if e['state'] == 'connect':
        if e['who'] >= 0:
            other = ZONE.recs[e['who']]
            if not is_unnamed(other):
                return 'joins ' + other['name']
        return 'joins another road'
    if e['state'] == 'gap':
        if e['who'] >= 0:
            other = ZONE.recs[e['who']]
            if not is_unnamed(other):
                if norm_name(other) == norm_name(r) and norm_name(r):
                    return ('stops %.0f metres short of the rest of %s'
                            % (e['d'], other['name']))
                return 'stops %.0f metres short of %s' % (e['d'], other['name'])
        return 'stops %.0f metres short of the nearest road' % e['d']
    return 'ends in the grass — there is no road at its end'


def norm_name(r):
    return '' if is_unnamed(r) else r['name'].strip().lower()


_LINKS = None


def link_graph():
    """Record -> set of records joined to it by the connect test
    (an endpoint within CONNECT_DIST of the other record's line)."""
    global _LINKS
    if _LINKS is None:
        _LINKS = defaultdict(set)
        for rec in ZONE.recs:
            for e in rec['ends']:
                if e['state'] == 'connect' and e['who'] >= 0:
                    _LINKS[rec['n']].add(e['who'])
                    _LINKS[e['who']].add(rec['n'])
    return _LINKS


def build_chain(r):
    """The piece's full road: records joined end-to-line (the connect
    test) that share the piece's name, breadth-first. Unnamed pieces
    chain through unnamed records. Capped for payload sanity."""
    if r['len'] < 2.0:
        return [r]  # a collapsed point has no meaningful chain
    links = link_graph()
    target = norm_name(r)
    seen = {r['n']}; frontier = [r['n']]
    while frontier and len(seen) < CHAIN_MAX_RECORDS:
        nxt = []
        for n in frontier:
            for m in links.get(n, ()):
                if m not in seen and norm_name(ZONE.recs[m]) == target:
                    seen.add(m); nxt.append(m)
        frontier = nxt
    return [ZONE.recs[n] for n in sorted(seen)]


def decimate(pts, spacing=4.0):
    """Thin a polyline to ~spacing metres between kept points."""
    if len(pts) <= 2:
        return [tuple(p) for p in pts]
    out = [tuple(pts[0])]
    acc = 0.0
    for k in range(1, len(pts)):
        acc += math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])
        if acc >= spacing:
            out.append(tuple(pts[k])); acc = 0.0
    if out[-1] != tuple(pts[-1]):
        out.append(tuple(pts[-1]))
    return out


def local(pts, ox, oz):
    return [[round(p[0] - ox, 1), round(p[1] - oz, 1)] for p in pts]


def build_scene(r, chain):
    """SnapshotView road scene, local coords centred on the piece."""
    ox = sum(p[0] for p in r['pts']) / len(r['pts'])
    oz = sum(p[1] for p in r['pts']) / len(r['pts'])
    extent = max(math.hypot(p[0] - ox, p[1] - oz) for p in r['pts'])
    ground = max(55.0, min(120.0, extent + 35.0))
    if 'island' in r['cats']:
        ground = 120.0

    # Context roads: other records with geometry inside the ground
    # disc — trimmed to the run of points near the disc, decimated.
    ctx = []
    cand = []
    R = int((ground * 1.3) // Zone.CELL) + 1
    cx, cz = int(ox // Zone.CELL), int(oz // Zone.CELL)
    near_recs = set()
    for gx in range(cx - R, cx + R + 1):
        for gz in range(cz - R, cz + R + 1):
            for (rn, k) in ZONE.sgrid.get((gx, gz), ()):
                if rn != r['n']:
                    near_recs.add(rn)
    for rn in near_recs:
        rec = ZONE.recs[rn]
        dmin = min(seg_dist(ox, oz, rec['pts'][k], rec['pts'][k + 1])
                   for k in range(len(rec['pts']) - 1)) if len(rec['pts']) > 1 else 999
        if dmin <= ground * 1.25:
            cand.append((dmin, rec))
    cand.sort(key=lambda t: t[0])
    for dmin, rec in cand[:7]:
        # keep the run of points within ground*1.3 of the origin
        run, best = [], []
        for p in rec['pts']:
            if math.hypot(p[0] - ox, p[1] - oz) <= ground * 1.3:
                run.append(p)
            else:
                if len(run) > len(best):
                    best = run
                run = []
        if len(run) > len(best):
            best = run
        if len(best) >= 2:
            ctx.append({'name': rec['name'] if not is_unnamed(rec) else None,
                        'width': rec['width'],
                        'pts': local(decimate(best, 5.0), ox, oz)})

    # Nearby buildings as muted boxes, nearest first.
    nbs = []
    for b in ZONE.buildings:
        dx, dz = b[0] - ox, b[1] - oz
        if math.hypot(dx, dz) <= ground + 40:
            nbs.append((math.hypot(dx, dz), b))
    nbs.sort(key=lambda t: t[0])
    neighbours = [{'x': round(b[0] - ox, 1), 'z': round(b[1] - oz, 1),
                   'w': b[2], 'd': b[3], 'h': b[4]} for _, b in nbs[:5]]

    scene = {
        'kind': 'road',
        'ground': round(ground),
        'subject': {'pts': local(r['pts'], ox, oz), 'width': r['width']},
        'roads': ctx,
        'neighbours': neighbours,
    }
    if len(chain) >= 2:
        paths = []
        total = 0
        for rec in chain:
            dp = decimate(rec['pts'], 4.0)
            total += len(dp)
            paths.append(local(dp, ox, oz))
        if total <= CHAIN_MAX_POINTS:
            scene['fullRoad'] = {'paths': paths, 'width': r['width']}
    return scene


def build_item(r):
    cats = r['cats']
    chain = build_chain(r)
    labels = end_labels(r)
    title = r['name'] if not is_unnamed(r) else 'Unnamed segment'
    kind = CLASS_PLAIN.get(r['cls'], 'road')
    if is_unnamed(r) and r['osm'] == 'service':
        kind = 'service road (driveway class)'
    lines = [
        'Length: %s · %s' % (
            ('%.1f metres' % r['len']) if r['len'] < 10 else ('%.0f metres' % r['len']),
            kind),
        '%s: %s' % (labels[0], end_description(r, r['ends'][0])),
        '%s: %s' % (labels[1], end_description(r, r['ends'][1])),
        'Why it is in this queue: ' + primary_reason(r, cats),
    ]
    return {'id': r['deckid'], 'title': title, 'lines': lines,
            'image': None, 'scene': build_scene(r, chain)}


GESTURE_MAP = {
    'right': {
        'action': 'delete',
        'label': 'DELETE — cut this piece',
        'detail': 'Your call: this piece should be cut from the map. '
                  'Recorded only — the cut is applied later, as a '
                  'separate step, on your word.',
    },
    'left': {
        'action': 'keep',
        'label': 'KEEP — this piece stays',
        'detail': 'Your call: this piece belongs where it is. It stays '
                  'in the map, untouched.',
    },
    'double-tap': {
        'action': 'skip',
        'label': 'SKIP — save for further review',
        'detail': 'Not decided now. The piece stays in the list, saved '
                  'for a closer look later (it can be sent to an '
                  'editor for review).',
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zone', default='adamsville')
    ap.add_argument('--repo', default=None,
                    help='repo root (default: three levels up from this script)')
    ap.add_argument('--out', default=None)
    ap.add_argument('--report', action='store_true')
    args = ap.parse_args()

    repo = args.repo or os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', '..'))
    out = args.out or os.path.join(
        repo, 'tools', 'decision-deck', 'queues', f'{args.zone}-roads.json')

    global ZONE
    ZONE = Zone(repo, args.zone)
    ZONE.analyse()

    counts = Counter()
    picked = []
    for r in ZONE.recs:
        cats = classify(r)
        r['cats'] = cats
        for c in cats:
            counts[c] += 1
        if cats:
            picked.append(r)
    picked.sort(key=lambda r: (-score(r, r['cats']), r['len'], r['id']))

    queue = {
        'name': f'Road review — {args.zone.capitalize()}',
        'queueId': f'{args.zone}-roads-v1',
        'generatedBy': 'tools/decision-deck/build-road-review-queue.py',
        'note': ('Every card is one piece of road in %s that looks like '
                 'it does not belong — the piece is lit green; tap the '
                 'view button on a card to see its whole road lit '
                 'instead. Decisions are RECORDED ONLY: nothing in the '
                 'game changes because of this queue. Any cuts are '
                 'applied later, as a separate step, only on Joshua\'s '
                 'word.' % args.zone.capitalize()),
        'gestures': GESTURE_MAP,
        'source': {
            'zone': args.zone,
            'totalRoads': len(ZONE.recs),
            'candidateCounts': dict(counts),
            'queueSize': len(picked),
        },
        'items': [build_item(r) for r in picked],
    }
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w') as f:
        json.dump(queue, f, separators=(',', ':'))
    size = os.path.getsize(out)
    print(f'zone {args.zone}: {len(ZONE.recs)} roads -> {len(picked)} candidates')
    print('per criterion:', dict(counts))
    print(f'wrote {out} ({size} bytes, ~{size // max(1, len(picked))} B/item)')
    if args.report:
        for it in queue['items'][:10]:
            print(' -', it['id'], '|', it['title'], '|', it['lines'][0])


ZONE = None
if __name__ == '__main__':
    main()
