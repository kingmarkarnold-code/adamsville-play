#!/usr/bin/env python3
"""build-flagged-queue.py — generate the Decision Deck queue of ALL
flagged buildings, for Joshua to review one card at a time (his design,
2026-10-17/18; the full queue was parked awaiting his word and he gave
it 2026-10-26).

WHAT IT DOES
  Reads the conversion's flagged list (editors/building-editor/
  flagged_buildings.json — the same file that drives the Building
  Editor's locks) and, for every flagged building in every zone,
  assembles one deck card in EXACTLY the shape of the deck's built-in
  8-building sample queue (v0.4): a SnapshotView scene carrying the
  building's true footprint ring, height, type code, editor-rule
  front edge and front road, and its nearest neighbours — plus plain
  identifying lines. Writes the queue to
  tools/decision-deck/queues/flagged-buildings.json.

MATCHING (the flagged file's own rule)
  A flagged entry's centroid is its zone record's box centre
  (buildings.json [x, z, w, d, h, code]) — verified exact for all
  1,532 entries (worst distance 0.00). No record is matched twice.

THE SCENE (mirrors the v0.4 sample assembly)
  subject.ring   the zone detail record's true ring, normalised (a
                 repeated closing point is dropped), in scene-local
                 coordinates centred on the ring's vertex mean,
                 rounded to 0.1.
  subject.h      the detail record's height_m.
  subject.code   the box's type code (0 residential/generic,
                 1 commercial, 2 multi-unit/institutional,
                 3 other/special).
  subject.wall / subject.roof
                 the deck palette by code — the same pairs the
                 shipped sample queue carries for codes 0/1/3
                 (#c9b18c/#7a4a34, #b9bec6/#4c4f57, #d8d2c4/#6b6f66);
                 code 2 follows the family's recorded description
                 ("multi-unit brick/brown"): #a15c48/#5a3a2a. Zone
                 data carries no colours; these are render-time
                 assignments, as they were for the sample.
  subject.frontEdge / scene.road
                 the editor's rule (zonedata.building_front): the
                 footprint edge whose midpoint is nearest a road
                 segment's centreline, with the flagged entry's named
                 road winning when an edge fronts it — recomputed on
                 the NORMALISED ring against the winning record's own
                 polyline (the v0.4 assembly correction). The scene's
                 road is that record: its point run within the view,
                 at the game width for its class (ROAD_WIDTHS).
  scene.neighbours
                 the nearest other zone boxes within 120 u of the
                 subject (up to 5), as muted boxes.
  scene.ground   the ground-patch / camera radius: a framing value
                 in the sample queue's family (theirs runs 88–270,
                 growing with the building) — here
                 clamp(3.0 * ringRadius + 1.4 * h + 55, 80, 300).

GESTURE MEANINGS (declared BY THE QUEUE, the v0.5 mechanism)
  Identical to the built-in sample queue's map: every gesture is
  unassigned (decisions record by gesture name), with ONE exception —
  hold -> send-to-editor (Building Editor), the v0.6 action mapping.
  Results carry it via the deck's normal export/send, exactly as the
  sample queue's do.

WHAT IT NEVER DOES
  It never edits building or road data, and never touches the
  flagged list. Decisions taken on this queue are RECORDED ONLY;
  applying them is a later, separate step on Joshua's word.

USAGE
  python3 tools/decision-deck/build-flagged-queue.py [--repo ROOT]
          [--out PATH] [--report]
  Defaults: repo = the repo this script lives in; out =
  tools/decision-deck/queues/flagged-buildings.json under that repo.
"""
import argparse, json, math, os, sys
from collections import defaultdict

# Road widths by class, as the game assigns them at load (the same
# table zonedata.py carries).
ROAD_WIDTHS = {"highway": 22.0, "major_artery": 20.0,
               "minor_artery": 18.4, "local": 7.2, "interstate": 34.0}

CODE_LABELS = {
    0: "Residential / generic",
    1: "Commercial",
    2: "Multi-unit / institutional",
    3: "Other / special",
}

# The deck palette by type code (see the header).
PALETTE = {
    0: ("#c9b18c", "#7a4a34"),
    1: ("#b9bec6", "#4c4f57"),
    2: ("#a15c48", "#5a3a2a"),
    3: ("#d8d2c4", "#6b6f66"),
}

ZONE_TITLES = {
    "adamsville": "Adamsville",
    "downtown": "Downtown",
    "eastatlanta": "East Atlanta",
    "mableton": "Mableton",
    "unioncity": "Union City",
    "southfulton": "South Fulton",
    "riverdale": "Riverdale",
}

NEIGHBOUR_RADIUS = 120.0
NEIGHBOUR_MAX = 5


def seg_dist(px, pz, a, b):
    """Exact distance from point (px, pz) to segment a-b."""
    ax, az = a; bx, bz = b
    dx, dz = bx - ax, bz - az
    l2 = dx * dx + dz * dz
    if l2 == 0:
        return math.hypot(px - ax, pz - az)
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / l2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


def poly_dist(px, pz, pts):
    if len(pts) < 2:
        return math.hypot(px - pts[0][0], pz - pts[0][1]) if pts else 1e18
    return min(seg_dist(px, pz, pts[k], pts[k + 1])
               for k in range(len(pts) - 1))


class Zone:
    """One zone's buildings + roads, with grids for exact queries."""

    CELL = 12.0

    def __init__(self, repo, zone_id):
        zdir = os.path.join(repo, 'detailed', 'zones', zone_id)
        self.boxes = json.load(open(os.path.join(
            zdir, 'buildings.json')))['buildings']
        self.details = json.load(open(os.path.join(
            zdir, 'buildings_detail.json')))
        roads = json.load(open(os.path.join(zdir, 'roads.json')))
        self.zone_id = zone_id
        # Road records with identity: (cls, ridx, name, pts)
        self.recs = []
        self.segs = []   # (recidx_into_recs, a, b)
        for cls, arr in roads.items():
            for ri, r in enumerate(arr):
                pts = r['pts']
                self.recs.append({'cls': cls, 'i': ri,
                                  'name': r.get('name') or '',
                                  'pts': pts,
                                  'width': ROAD_WIDTHS.get(cls, 7.2)})
                for k in range(len(pts) - 1):
                    self.segs.append((len(self.recs) - 1, pts[k], pts[k + 1]))
        # Segment grid: cell -> [segidx]
        self.sgrid = defaultdict(list)
        for si, (_, a, b) in enumerate(self.segs):
            steps = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) /
                               (self.CELL / 2)))
            for j in range(steps + 1):
                t = j / steps
                key = (int((a[0] + (b[0] - a[0]) * t) // self.CELL),
                       int((a[1] + (b[1] - a[1]) * t) // self.CELL))
                self.sgrid[key].append(si)
        # Box-centre grid for the flagged match.
        self.bgrid = defaultdict(list)
        for bi, b in enumerate(self.boxes):
            self.bgrid[(int(b[0] // 50), int(b[1] // 50))].append(bi)

    def match_box(self, cx, cz):
        """The record whose box centre is (cx, cz) — the flagged
        file's own match (centroid within 1.0). Returns (index, dist)
        or (None, dist) when nothing is within 1.0."""
        gx, gz = int(cx // 50), int(cz // 50)
        best, bd = None, 1e18
        for ax in range(gx - 1, gx + 2):
            for az in range(gz - 1, gz + 2):
                for bi in self.bgrid.get((ax, az), ()):
                    b = self.boxes[bi]
                    d = math.hypot(b[0] - cx, b[1] - cz)
                    if d < bd:
                        bd, best = d, bi
        if bd <= 1.0:
            return best, bd
        return None, bd

    def nearest_seg(self, px, pz):
        """(distance, recidx) of the nearest road segment centreline
        to a point — exact, grid-accelerated (expanding rings, the
        road queue generator's pattern)."""
        best = 1e18; who = -1; seen = set(); ring = 0
        while ring <= 12:
            rad = ring * self.CELL
            if ring > 0 and best <= rad:
                break
            cx, cz = int(px // self.CELL), int(pz // self.CELL)
            for gx in range(cx - ring, cx + ring + 1):
                for gz in range(cz - ring, cz + ring + 1):
                    if ring and abs(gx - cx) != ring and abs(gz - cz) != ring:
                        continue
                    for si in self.sgrid.get((gx, gz), ()):
                        if si in seen:
                            continue
                        seen.add(si)
                        rn, a, b = self.segs[si]
                        d = seg_dist(px, pz, a, b)
                        if d < best:
                            best, who = d, rn
            ring += 1
        return best, who


def normalise_ring(ring):
    pts = [list(p) for p in ring]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    return pts


def build_item(zone, idx, entry):
    det = zone.details[idx]
    box = zone.boxes[idx]
    ring = normalise_ring(det.get('ring') or [])
    code = int(box[5])
    h = det.get('height_m') or box[4]
    name = det.get('name') or entry.get('name') or 'unnamed'
    osm = det.get('osm_type') or entry.get('type') or ''
    road_name = entry.get('nearestRoad') or ''

    if ring:
        ox = sum(p[0] for p in ring) / len(ring)
        oz = sum(p[1] for p in ring) / len(ring)
    else:
        ox, oz = box[0], box[1]
    local_ring = [[round(p[0] - ox, 1), round(p[1] - oz, 1)] for p in ring]
    ring_r = max((math.hypot(p[0] - ox, p[1] - oz) for p in ring),
                 default=0.0)
    ground = round(max(80.0, min(300.0, 3.0 * ring_r + 1.4 * h + 55.0)), 1)

    # --- Front derivation: the editor's rule on the normalised ring.
    front_edge = None
    front_rec = None
    if len(ring) >= 2:
        edges = [(ring[i], ring[(i + 1) % len(ring)])
                 for i in range(len(ring))]
        per_edge = []
        for a, b in edges:
            d, rn = zone.nearest_seg((a[0] + b[0]) / 2.0,
                                     (a[1] + b[1]) / 2.0)
            per_edge.append((d, rn))
        named = [(per_edge[i][0], i) for i in range(len(edges))
                 if per_edge[i][1] >= 0 and
                 zone.recs[per_edge[i][1]]['name'] == road_name]
        if named:
            _, bi = min(named)
        else:
            bi = min(range(len(edges)), key=lambda i: per_edge[i][0])
        front_rec_n = per_edge[bi][1]
        if front_rec_n >= 0:
            front_rec = zone.recs[front_rec_n]
            # The v0.4 correction: recompute the edge against the
            # front road's OWN polyline.
            front_edge = min(
                range(len(edges)),
                key=lambda i: poly_dist((edges[i][0][0] + edges[i][1][0]) / 2.0,
                                        (edges[i][0][1] + edges[i][1][1]) / 2.0,
                                        front_rec['pts']))

    # --- The front road's point run within the view.
    road = None
    if front_rec is not None:
        pts = front_rec['pts']
        run, best = [], []
        for p in pts:
            if math.hypot(p[0] - ox, p[1] - oz) <= ground:
                run.append(p)
            else:
                if len(run) > len(best):
                    best = run
                run = []
        if len(run) > len(best):
            best = run
        if len(best) < 2:
            best = pts
        road = {'name': front_rec['name'] or road_name,
                'width': front_rec['width'],
                'pts': [[round(p[0] - ox, 1), round(p[1] - oz, 1)]
                        for p in best]}

    # --- Neighbours: nearest other boxes within 120 u.
    nbs = []
    for j, b in enumerate(zone.boxes):
        if j == idx:
            continue
        d = math.hypot(b[0] - ox, b[1] - oz)
        if d <= NEIGHBOUR_RADIUS:
            nbs.append((d, b))
    nbs.sort(key=lambda t: t[0])
    neighbours = [{'x': round(b[0] - ox, 1), 'z': round(b[1] - oz, 1),
                   'w': b[2], 'd': b[3], 'h': b[4]}
                  for _, b in nbs[:NEIGHBOUR_MAX]]

    wall, roof = PALETTE.get(code, PALETTE[3])
    scene = {
        'subject': {'ring': local_ring, 'h': h, 'wall': wall,
                    'roof': roof, 'code': code, 'frontEdge': front_edge},
        'ground': ground,
        'road': road,
        'neighbours': neighbours,
    }
    lines = [
        'Type: %s (%s)' % (CODE_LABELS.get(code, 'Other / special'), osm),
        'Zone: %s' % ZONE_TITLES.get(zone.zone_id, zone.zone_id),
        'Why flagged: intersects %s — left in place by the conversion; '
        'your decision is pending' % (road_name or 'a road'),
    ]
    return {'id': 'flag-%s-%d' % (zone.zone_id, idx),
            'title': 'Flagged: %s' % name,
            'lines': lines, 'image': None, 'scene': scene}


GESTURE_MAP = {
    'hold': {
        'action': 'send-to-editor',
        'target': 'building-editor',
        'label': 'Send to Building Editor',
        'detail': 'hands this building to the Building Editor; carried '
                  'out with the deck\'s results',
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default=None,
                    help='repo root (default: two levels up from this script)')
    ap.add_argument('--out', default=None)
    ap.add_argument('--report', action='store_true')
    args = ap.parse_args()

    repo = args.repo or os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', '..'))
    out = args.out or os.path.join(
        repo, 'tools', 'decision-deck', 'queues', 'flagged-buildings.json')

    flagged = json.load(open(os.path.join(
        repo, 'editors', 'building-editor', 'flagged_buildings.json')))

    items = []
    per_zone = {}
    problems = []
    for zone_id, entries in flagged['zones'].items():
        zone = Zone(repo, zone_id)
        used = set()
        for entry in entries:
            cx, cz = entry['centroid']
            idx, dist = zone.match_box(cx, cz)
            if idx is None:
                problems.append('%s: no record within 1.0 of %s (%.2f)'
                                % (zone_id, entry.get('name'), dist))
                continue
            if idx in used:
                problems.append('%s: record %d matched twice'
                                % (zone_id, idx))
                continue
            used.add(idx)
            items.append(build_item(zone, idx, entry))
        per_zone[zone_id] = len(entries)
        print('zone %s: %d flagged -> %d items'
              % (zone_id, len(entries), len(used)))

    queue = {
        'name': 'Flagged buildings — the full list, 3D snapshots',
        'queueId': 'flagged-buildings-v1',
        'generatedBy': 'tools/decision-deck/build-flagged-queue.py',
        'note': ('Every card is one building the conversion left '
                 'intersecting a road — shown as a rotating 3D '
                 'snapshot of the building in its place, its front '
                 'face in orange. Gesture meanings are unassigned '
                 'for this queue, with one exception: press & hold '
                 'a card to send that building to the Building '
                 'Editor. Decisions are RECORDED ONLY — nothing in '
                 'the game changes because of this queue; anything '
                 'decided here is applied later, as a separate step, '
                 'only on Joshua\'s word.'),
        'gestures': GESTURE_MAP,
        'source': {
            'flaggedFile': 'editors/building-editor/flagged_buildings.json',
            'totalFlagged': flagged.get('total'),
            'perZone': per_zone,
            'queueSize': len(items),
        },
        'items': items,
    }
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w') as f:
        json.dump(queue, f, separators=(',', ':'))
    size = os.path.getsize(out)
    print('total: %d items, wrote %s (%d bytes, ~%d B/item)'
          % (len(items), out, size, size // max(1, len(items))))
    for p in problems:
        print('PROBLEM:', p)
    if args.report:
        for it in items[:5]:
            print(' -', it['id'], '|', it['title'], '|', it['lines'][0])
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
