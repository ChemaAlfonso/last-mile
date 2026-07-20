#!/usr/bin/env python3
"""Build the offline drivable road graph for Last Mile (Phase 2 routing).

Usage:
    python3 tools/build_routing.py
    python3 tools/build_routing.py --cache /path/to/tile-cache
    python3 tools/build_routing.py --margin 0.02

Computes the comarca bounding box from every point in data/*.json (plus a
margin), pulls the OpenStreetMap road network for that box from the Overpass
API in polite tiled queries (raw tile responses are cached so re-runs are
cheap), keeps only motor-drivable ways, honours oneway / roundabouts / access
tags, stitches the topology at shared geometry vertices and writes a compact
graph to data/graph-comarca.json.

Topology is keyed by rounded (lat, lon): Overpass returns byte-identical
coordinates for the same underlying OSM node wherever two ways meet, so this
merges shared nodes exactly as node ids would, while keeping the query light
(out geom) -- the recurse-down node-id query times out on the loaded public
endpoints for a comarca-sized box.

The output is an ODbL-licensed derivative database of OpenStreetMap. The
license notice and the '(c) OpenStreetMap contributors' attribution ride along
inside the JSON -- see docs/offline-routing.md for the format contract.

Standard library only -- no pip dependencies.
"""

import gzip
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# ---------- paths ----------

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DATA_DIR = os.path.join(REPO, 'data')
OUTPUT_PATH = os.path.join(DATA_DIR, 'graph-comarca.json')
DEFAULT_CACHE = os.path.join(REPO, 'tools', '.overpass-cache')

# ---------- Overpass ----------

# Rotated on failure; each is a public Overpass instance.
ENDPOINTS = [
	'https://overpass.private.coffee/api/interpreter',
	'https://overpass.kumi.systems/api/interpreter',
	'https://overpass-api.de/api/interpreter',
]
USER_AGENT = 'lastmile-routing/1.0 (https://lastmile.chemaalfonso.com)'
TILE_PAUSE_S = 2.0  # polite gap between tile requests
RETRY_PAUSE_S = 5.0
MAX_TILE_SPAN_DEG = 0.12  # split the bbox so no single tile exceeds this

# ---------- filtering ----------

# Motor-drivable highway classes -> assumed free-flow speed (km/h). The weight
# of an edge is its length divided by this speed, so the table is the single
# knob that tunes routing preference between road classes.
SPEED_KMH = {
	'motorway': 100,
	'trunk': 90,
	'primary': 80,
	'secondary': 70,
	'tertiary': 60,
	'unclassified': 45,
	'residential': 40,
	'living_street': 20,
	'service': 30,
	'track': 20,
	'road': 40,  # highway=road means "class unknown" -- treat as minor
	'motorway_link': 60,
	'trunk_link': 50,
	'primary_link': 50,
	'secondary_link': 40,
	'tertiary_link': 40,
}
DRIVABLE = set(SPEED_KMH)

# Non-motor classes we only keep when a motor_vehicle tag explicitly opens them.
FOOT_LIKE = {'footway', 'path', 'cycleway', 'pedestrian', 'bridleway', 'steps', 'corridor'}
FOOT_LIKE_SPEED = 20  # if opened to motor traffic, treat as a slow track

# Tag value sets for access resolution.
ACCESS_POSITIVE = {'yes', 'permissive', 'destination', 'designated', 'delivery', 'customers'}
ACCESS_NEGATIVE = {'no', 'private', 'agricultural', 'forestry', 'agricultural;forestry', 'military'}
ONEWAY_FORWARD = {'yes', 'true', '1'}
ONEWAY_REVERSE = {'-1', 'reverse'}
ONEWAY_NONE = {'no', 'false', '0'}

# ---------- geometry ----------

EARTH_R = 6371000.0


def haversine(a, b):
	p1 = math.radians(a[0])
	p2 = math.radians(b[0])
	dp = math.radians(b[0] - a[0])
	dl = math.radians(b[1] - a[1])
	x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
	return 2 * EARTH_R * math.asin(math.sqrt(x))


# ---------- bbox ----------


def comarca_bbox(margin):
	"""(south, west, north, east) covering every point in data/*.json + margin."""
	lats = []
	lngs = []
	for fname in os.listdir(DATA_DIR):
		if not fname.endswith('.json') or fname == 'index.json':
			continue
		with open(os.path.join(DATA_DIR, fname)) as fh:
			doc = json.load(fh)
		for place in doc.get('places', []):
			lats.append(place['lat'])
			lngs.append(place['lng'])
	if not lats:
		raise SystemExit('no place coordinates found in data/*.json')
	return (min(lats) - margin, min(lngs) - margin, max(lats) + margin, max(lngs) + margin)


def tiles(bbox):
	"""Split bbox into a grid of tiles no larger than MAX_TILE_SPAN_DEG per side."""
	s, w, n, e = bbox
	rows = max(1, math.ceil((n - s) / MAX_TILE_SPAN_DEG))
	cols = max(1, math.ceil((e - w) / MAX_TILE_SPAN_DEG))
	dh = (n - s) / rows
	dw = (e - w) / cols
	out = []
	for r in range(rows):
		for c in range(cols):
			out.append((s + r * dh, w + c * dw, s + (r + 1) * dh, w + c * dw + dw))
	return out


# ---------- fetch (with cache) ----------


def fetch(query):
	# One try per endpoint per round, rotating on any error so a rate-limited
	# instance is skipped immediately instead of burning retries against it.
	data = urllib.parse.urlencode({'data': query}).encode()
	last = None
	for rnd in range(4):
		for endpoint in ENDPOINTS:
			try:
				req = urllib.request.Request(endpoint, data=data, headers={'User-Agent': USER_AGENT})
				with urllib.request.urlopen(req, timeout=180) as resp:
					return json.load(resp)
			except Exception as exc:  # noqa: BLE001 - network is best-effort, rotate on any error
				last = exc
				sys.stderr.write(f'  round {rnd} {endpoint.split("//")[1][:20]}: {str(exc)[:60]}\n')
				time.sleep(RETRY_PAUSE_S)
	raise SystemExit(f'all Overpass endpoints failed: {last}')


def fetch_tiles(bbox, cache_dir):
	"""Return {way_id: way} (with inline geometry + tags) for all highways in bbox."""
	os.makedirs(cache_dir, exist_ok=True)
	grid = tiles(bbox)
	ways = {}
	for i, (s, w, n, e) in enumerate(grid):
		key = f'tile_{s:.4f}_{w:.4f}_{n:.4f}_{e:.4f}.json'
		path = os.path.join(cache_dir, key)
		if os.path.exists(path):
			with open(path) as fh:
				elements = json.load(fh)
			sys.stderr.write(f'tile {i + 1}/{len(grid)} cached ({len(elements)} elements)\n')
		else:
			# out geom tags: each way carries its full inline geometry (lat/lon per
			# vertex) and its tags. Lighter than recursing down to node elements,
			# which the loaded public endpoints time out on for a comarca-sized box.
			query = (
				f'[out:json][timeout:180];'
				f'way["highway"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});'
				f'out geom tags;'
			)
			data = fetch(query)
			elements = data['elements']
			with open(path, 'w') as fh:
				json.dump(elements, fh)
			sys.stderr.write(f'tile {i + 1}/{len(grid)} fetched ({len(elements)} elements)\n')
			time.sleep(TILE_PAUSE_S)
		for el in elements:
			if el['type'] == 'way':
				ways[el['id']] = el
	return ways


# ---------- filtering / access resolution ----------


def resolve_way(tags):
	"""Return (speed_kmh, forward, backward) or None if the way is not drivable.

	forward/backward say whether motor traffic may travel in the node order the
	way is stored in (forward) and against it (backward). oneway=-1 flips them;
	junction=roundabout implies forward-only.
	"""
	highway = tags.get('highway')
	if highway in DRIVABLE:
		speed = SPEED_KMH[highway]
	elif highway in FOOT_LIKE:
		# Only a positive motor_vehicle tag turns a footway/path into a road.
		if tags.get('motor_vehicle') in ACCESS_POSITIVE:
			speed = FOOT_LIKE_SPEED
		else:
			return None
	else:
		return None  # construction, proposed, raceway, platform, ...

	# access resolution: the most specific present tag wins.
	# motor_vehicle > motorcar > vehicle > access.
	verdict = None
	for tag in ('motor_vehicle', 'motorcar', 'vehicle', 'access'):
		val = tags.get(tag)
		if val is None:
			continue
		if val in ACCESS_POSITIVE:
			verdict = True
		elif val in ACCESS_NEGATIVE:
			verdict = False
		# unknown values (e.g. "unknown") are ignored, fall through to next tag
		if verdict is not None:
			break
	if verdict is False:
		return None  # access=no / private / agricultural etc. -> excluded

	# oneway resolution.
	oneway = tags.get('oneway')
	if oneway in ONEWAY_FORWARD:
		forward, backward = True, False
	elif oneway in ONEWAY_REVERSE:
		forward, backward = False, True
	elif oneway in ONEWAY_NONE:
		forward, backward = True, True
	elif tags.get('junction') in ('roundabout', 'circular'):
		forward, backward = True, False  # roundabouts imply oneway in node order
	else:
		forward, backward = True, True
	return speed, forward, backward


# ---------- graph build ----------


NODE_KEY_DECIMALS = 6  # ~0.11 m; Overpass emits identical coords for a shared OSM node


def build_graph(ways):
	"""Build directed edges from filtered ways. Returns the compact graph dict + stats.

	Topology is stitched by node key: the rounded (lat, lon) of each geometry
	vertex. Overpass returns byte-identical coordinates for the same underlying
	OSM node wherever two ways meet, so rounding to 6 decimals merges shared
	nodes exactly the way node ids would, without the heavier recurse-down query.
	"""
	used = {}  # coord key -> compact index
	node_coords = []  # compact index -> (lat, lon)

	def intern(lat, lon):
		key = (round(lat, NODE_KEY_DECIMALS), round(lon, NODE_KEY_DECIMALS))
		idx = used.get(key)
		if idx is None:
			idx = len(node_coords)
			used[key] = idx
			node_coords.append((lat, lon))
		return idx

	# Undirected edges: one row per road segment. dir says how it may be driven.
	ea = []  # first node index
	eb = []  # second node index
	ecost = []  # centiseconds
	edir = []  # 0 = both ways, 1 = a->b only
	ecls = []
	ename = []
	class_index = {}
	name_index = {}
	kept_ways = 0

	def cls_id(highway):
		i = class_index.get(highway)
		if i is None:
			i = len(class_index)
			class_index[highway] = i
		return i

	def name_id(name):
		if not name:
			return -1
		i = name_index.get(name)
		if i is None:
			i = len(name_index)
			name_index[name] = i
		return i

	def add_edge(a, b, cost, direction, cid, nid):
		ea.append(a)
		eb.append(b)
		ecost.append(cost)
		edir.append(direction)
		ecls.append(cid)
		ename.append(nid)

	for way in ways.values():
		tags = way.get('tags', {})
		resolved = resolve_way(tags)
		if resolved is None:
			continue
		speed, forward, backward = resolved
		geom = way.get('geometry')
		if not geom or len(geom) < 2:
			continue
		cid = cls_id(tags.get('highway'))
		nid = name_id(tags.get('name') or tags.get('ref') or '')
		for k in range(len(geom) - 1):
			ca = (geom[k]['lat'], geom[k]['lon'])
			cb = (geom[k + 1]['lat'], geom[k + 1]['lon'])
			length = haversine(ca, cb)
			if length <= 0:
				continue
			cost = int(round(360.0 * length / speed))  # centiseconds = length / (speed/3.6) * 100
			cost = max(cost, 1)
			ia, ib = intern(*ca), intern(*cb)
			if ia == ib:
				continue
			if forward and backward:
				add_edge(ia, ib, cost, 0, cid, nid)  # both ways
			elif forward:
				add_edge(ia, ib, cost, 1, cid, nid)  # ia -> ib only
			else:  # backward only: travel goes ib -> ia, store it as the a->b direction
				add_edge(ib, ia, cost, 1, cid, nid)
		kept_ways += 1

	graph = {
		'node_coords': node_coords,
		'edges': {'a': ea, 'b': eb, 'cost': ecost, 'dir': edir, 'cls': ecls, 'name': ename},
		'classes': [c for c, _ in sorted(class_index.items(), key=lambda kv: kv[1])],
		'names': [n for n, _ in sorted(name_index.items(), key=lambda kv: kv[1])],
	}
	stats = {'kept_ways': kept_ways}
	return graph, stats


# ---------- compact encoding (Morton renumber + delta) ----------

COORD_SCALE = 1000000  # microdegrees; 6-decimal precision, lossless integer coords


def _morton(x, y):
	# interleave bits of two positive ints (coords shifted into positive range)
	z = 0
	for b in range(30):
		z |= ((x >> b) & 1) << (2 * b) | ((y >> b) & 1) << (2 * b + 1)
	return z


def encode_graph(node_coords, edges):
	"""Renumber nodes along a Morton (Z-order) curve and delta-encode everything.

	Spatially-near nodes get near indices, so an edge's two endpoints have close
	indices -- storing the second relative to the first, and both sorted, makes
	the integer columns compress an order of magnitude better. Fully lossless at
	COORD_SCALE precision. See docs/offline-routing.md for the decode.
	"""
	mic = [(round(lat * COORD_SCALE), round(lon * COORD_SCALE)) for lat, lon in node_coords]
	shift = COORD_SCALE * 200  # push lat/lon into positive ints for bit interleave
	order = sorted(range(len(mic)), key=lambda i: _morton(mic[i][0] + shift, mic[i][1] + shift))
	new_index = [0] * len(order)
	for new_i, old_i in enumerate(order):
		new_index[old_i] = new_i

	# node delta columns in the new order
	slat = [mic[order[i]][0] for i in range(len(order))]
	slon = [mic[order[i]][1] for i in range(len(order))]
	dlat = [slat[0]] + [slat[i] - slat[i - 1] for i in range(1, len(slat))] if slat else []
	dlon = [slon[0]] + [slon[i] - slon[i - 1] for i in range(1, len(slon))] if slon else []

	# remap edge endpoints, sort by (a, b), store a as delta and b relative to a
	a = [new_index[x] for x in edges['a']]
	b = [new_index[x] for x in edges['b']]
	cost, direction, cls, name = edges['cost'], edges['dir'], edges['cls'], edges['name']
	perm = sorted(range(len(a)), key=lambda i: (a[i], b[i]))
	sa = [a[i] for i in perm]
	sb = [b[i] for i in perm]
	from_delta = [sa[0]] + [sa[i] - sa[i - 1] for i in range(1, len(sa))] if sa else []
	to_rel = [sb[i] - sa[i] for i in range(len(sb))]

	enc_nodes = {'dlat': dlat, 'dlng': dlon}
	enc_edges = {
		'fromDelta': from_delta,
		'toRel': to_rel,
		'cost': [cost[i] for i in perm],
		'dir': [direction[i] for i in perm],
		'cls': [cls[i] for i in perm],
		'name': [name[i] for i in perm],
	}
	# directed endpoint lists for verification / SCC (a->b always; b->a when dir==0)
	directed = (sa, sb, [direction[i] for i in perm])
	return enc_nodes, enc_edges, directed


# ---------- strongly connected components (iterative Kosaraju) ----------


def largest_scc(node_count, directed):
	"""Return (size_of_largest_scc, membership list) for the directed graph.

	directed = (a_list, b_list, dir_list); each edge is a->b, plus b->a when dir==0.
	"""
	a_list, b_list, dir_list = directed
	out_adj = [[] for _ in range(node_count)]
	in_adj = [[] for _ in range(node_count)]
	for a, b, d in zip(a_list, b_list, dir_list):
		out_adj[a].append(b)
		in_adj[b].append(a)
		if d == 0:
			out_adj[b].append(a)
			in_adj[a].append(b)

	# pass 1: finish-time order via iterative DFS
	visited = bytearray(node_count)
	order = []
	for start in range(node_count):
		if visited[start]:
			continue
		stack = [(start, 0)]
		visited[start] = 1
		while stack:
			node, i = stack[-1]
			nbrs = out_adj[node]
			if i < len(nbrs):
				stack[-1] = (node, i + 1)
				nxt = nbrs[i]
				if not visited[nxt]:
					visited[nxt] = 1
					stack.append((nxt, 0))
			else:
				order.append(node)
				stack.pop()

	# pass 2: assign components on the transposed graph in reverse finish order
	comp = [-1] * node_count
	label = 0
	sizes = []
	for seed in reversed(order):
		if comp[seed] != -1:
			continue
		size = 0
		stack = [seed]
		comp[seed] = label
		while stack:
			node = stack.pop()
			size += 1
			for prv in in_adj[node]:
				if comp[prv] == -1:
					comp[prv] = label
					stack.append(prv)
		sizes.append(size)
		label += 1
	best = max(sizes) if sizes else 0
	return best, comp


# ---------- output ----------


def _self_check(node_coords, edges, enc_nodes, enc_edges):
	"""Round-trip the encoding in Python so a broken decode never ships silently."""
	dlat, dlng = enc_nodes['dlat'], enc_nodes['dlng']
	lat = []
	lon = []
	acc_la = acc_lo = 0
	for i in range(len(dlat)):
		acc_la += dlat[i]
		acc_lo += dlng[i]
		lat.append(acc_la)
		lon.append(acc_lo)
	# rebuild the undirected edge set (as sorted node-index pairs + dir) both ways
	acc = 0
	dec = set()
	fd, tr = enc_edges['fromDelta'], enc_edges['toRel']
	for i in range(len(fd)):
		acc += fd[i]
		a = acc
		b = acc + tr[i]
		dec.add((a, b, enc_edges['dir'][i]))
	# original edges mapped through the same coords must be present
	coord_of = {}
	for i in range(len(lat)):
		coord_of[(lat[i], lon[i])] = i
	orig = set()
	for i in range(len(edges['a'])):
		la = round(node_coords[edges['a'][i]][0] * COORD_SCALE)
		lo = round(node_coords[edges['a'][i]][1] * COORD_SCALE)
		lb = round(node_coords[edges['b'][i]][0] * COORD_SCALE)
		lob = round(node_coords[edges['b'][i]][1] * COORD_SCALE)
		orig.add((coord_of[(la, lo)], coord_of[(lb, lob)], edges['dir'][i]))
	if orig != dec:
		raise SystemExit('self-check FAILED: encoded edges do not round-trip')


def write_output(bbox, graph, stats):
	node_coords = graph['node_coords']
	node_count = len(node_coords)
	enc_nodes, enc_edges, directed = encode_graph(node_coords, graph['edges'])
	edge_count = len(enc_edges['fromDelta'])
	directed_count = edge_count + directed[2].count(0)  # dir==0 edges are traversable both ways
	best_scc, _ = largest_scc(node_count, directed)
	_self_check(node_coords, graph['edges'], enc_nodes, enc_edges)

	doc = {
		'format': 'lastmile-routing-graph',
		'formatVersion': 1,
		'source': 'OpenStreetMap via Overpass API',
		'attribution': '(c) OpenStreetMap contributors',
		'license': 'ODbL 1.0',
		'licenseNote': (
			'This graph is a derivative database of OpenStreetMap, licensed under the '
			'Open Database License (ODbL) 1.0 (https://opendatacommons.org/licenses/odbl/1-0/). '
			'You must keep the "(c) OpenStreetMap contributors" attribution and share alike any '
			'derivative database. Routes computed from this graph are Produced Works and are not '
			'themselves covered by the share-alike clause.'
		),
		'buildDate': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
		'bbox': [round(bbox[0], 6), round(bbox[1], 6), round(bbox[2], 6), round(bbox[3], 6)],
		'weightUnit': 'centiseconds',
		'coordScale': COORD_SCALE,
		'encoding': 'nodes: Morton order, delta microdegrees. edges: undirected, '
		'sorted; fromDelta=delta of first node index, toRel=second minus first. See docs/offline-routing.md.',
		'speedTable': SPEED_KMH,
		'counts': {'nodes': node_count, 'edges': edge_count, 'directedEdges': directed_count, 'largestScc': best_scc},
		'classes': graph['classes'],
		'names': graph['names'],
		'nodes': enc_nodes,
		'edges': enc_edges,
	}
	raw = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
	with open(OUTPUT_PATH, 'wb') as fh:
		fh.write(raw)
	gz = gzip.compress(raw, 9)

	print('== routing graph built ==')
	print(f'bbox              {doc["bbox"]}')
	print(f'kept ways         {stats["kept_ways"]}')
	print(f'nodes             {node_count}')
	print(f'undirected edges  {edge_count}')
	print(f'directed edges    {directed_count}')
	print(f'largest SCC       {best_scc} ({100.0 * best_scc / max(1, node_count):.1f}% of nodes)')
	print(f'classes           {graph["classes"]}')
	print(f'named ways        {len(graph["names"])}')
	print(f'output            {OUTPUT_PATH}')
	print(f'size raw          {len(raw) / 1e6:.2f} MB')
	print(f'size gzip -9      {len(gz) / 1e6:.2f} MB')


# ---------- main ----------


def main(argv):
	margin = 0.02
	cache_dir = DEFAULT_CACHE
	for i, a in enumerate(argv):
		if a == '--margin' and i + 1 < len(argv):
			margin = float(argv[i + 1])
		if a == '--cache' and i + 1 < len(argv):
			cache_dir = argv[i + 1]

	bbox = comarca_bbox(margin)
	sys.stderr.write(f'comarca bbox {tuple(round(x, 4) for x in bbox)} -> {len(tiles(bbox))} tiles\n')
	ways = fetch_tiles(bbox, cache_dir)
	sys.stderr.write(f'fetched {len(ways)} highway ways\n')
	graph, stats = build_graph(ways)
	write_output(bbox, graph, stats)
	return 0


if __name__ == '__main__':
	sys.exit(main(sys.argv))
