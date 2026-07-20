#!/usr/bin/env python3
"""Build the Last Mile offline vector basemap (PMTiles) for the covered comarca.

Usage:
    python3 tools/build_basemap.py
    python3 tools/build_basemap.py --margin 0.05
    python3 tools/build_basemap.py --source https://build.protomaps.com/20260720.pmtiles
    python3 tools/build_basemap.py --verify-only            # just re-check the existing file

What it does:
  1. Reads every data/<town>.json and computes the bounding box that encloses all
     address points, expanded by --margin degrees so panning at the edges isn't naked.
  2. Shells out to the `pmtiles` CLI (github.com/protomaps/go-pmtiles) to range-read
     ONLY that region out of Protomaps' daily planet build into
     data/basemap-comarca.pmtiles (~25 MB, MVT vector tiles, z0-15).
  3. Verifies the result by parsing the PMTiles v3 header directly (magic bytes,
     bounds cover the bbox, max zoom >= MIN_MAXZOOM) and prints a summary.

The pmtiles archive is served as a STATIC file from nginx via HTTP Range requests
(no backend, no routing service). See docs/offline-map.md.

`pmtiles` CLI install:  brew install pmtiles
                        or grab a binary from https://github.com/protomaps/go-pmtiles/releases

Standard library only -- no pip dependencies.
"""

import argparse
import glob
import json
import os
import shutil
import struct
import subprocess
import sys
import urllib.request

# ---------- constants ----------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, 'data')
OUT_FILE = os.path.join(DATA_DIR, 'basemap-comarca.pmtiles')

DEFAULT_MARGIN = 0.05  # degrees of padding around the address bbox (~5.5 km N-S)
MIN_MAXZOOM = 15  # Protomaps builds carry data to z15; the renderer overzooms to z16/z17
PMTILES_MAGIC = b'PMTiles'
PMTILES_V3_HEADER_LEN = 127

# Protomaps rolling daily planet builds. Only ~7 days are retained, so probe backwards.
BUILD_URL = 'https://build.protomaps.com/{date}.pmtiles'
BUILD_PROBE_DAYS = 30

INSTALL_HINT = (
	'The `pmtiles` CLI is required but was not found on PATH.\n'
	'  Install it with:   brew install pmtiles\n'
	'  or download a binary from https://github.com/protomaps/go-pmtiles/releases\n'
	'  (Apple Silicon: the *_Darwin_arm64.zip asset), unzip it and put `pmtiles` on PATH.'
)


# ---------- bbox ----------


def compute_bbox(margin):
	"""Enclose every address point in every data/<town>.json, padded by `margin`."""
	min_lat = min_lng = float('inf')
	max_lat = max_lng = float('-inf')
	towns = 0
	points = 0
	for path in sorted(glob.glob(os.path.join(DATA_DIR, '*.json'))):
		if os.path.basename(path) == 'index.json':
			continue
		with open(path, encoding='utf-8') as handle:
			data = json.load(handle)
		places = data.get('places') if isinstance(data, dict) else None
		if not places:
			continue
		towns += 1
		for place in places:
			lat = place.get('lat')
			lng = place.get('lng')
			if lat is None or lng is None:
				continue
			points += 1
			min_lat = min(min_lat, lat)
			max_lat = max(max_lat, lat)
			min_lng = min(min_lng, lng)
			max_lng = max(max_lng, lng)
	if points == 0:
		sys.exit('No address points found under data/*.json -- build the town datasets first.')
	return {
		'min_lng': min_lng - margin,
		'min_lat': min_lat - margin,
		'max_lng': max_lng + margin,
		'max_lat': max_lat + margin,
		'towns': towns,
		'points': points,
	}


# ---------- source discovery ----------


def find_latest_build():
	"""Return the URL of the most recent available Protomaps daily build."""
	from datetime import date, timedelta

	today = date.today()
	for back in range(BUILD_PROBE_DAYS):
		stamp = (today - timedelta(days=back)).strftime('%Y%m%d')
		url = BUILD_URL.format(date=stamp)
		request = urllib.request.Request(url, headers={'Range': 'bytes=0-0'})
		try:
			with urllib.request.urlopen(request, timeout=30) as response:
				if response.status in (200, 206):
					return url
		except Exception:
			continue
	sys.exit(
		'Could not find a recent Protomaps daily build under build.protomaps.com.\n'
		'Pass one explicitly with --source <url> (see https://maps.protomaps.com/builds/).'
	)


# ---------- extract ----------


def run_extract(source, bbox, out_path):
	cli = shutil.which('pmtiles')
	if not cli:
		sys.exit(INSTALL_HINT)
	bbox_arg = '{min_lng:.6f},{min_lat:.6f},{max_lng:.6f},{max_lat:.6f}'.format(**bbox)
	cmd = [cli, 'extract', source, out_path, '--bbox=' + bbox_arg]
	print('Running: ' + ' '.join(cmd))
	result = subprocess.run(cmd)
	if result.returncode != 0:
		sys.exit('pmtiles extract failed (exit %d).' % result.returncode)


# ---------- verification (stdlib PMTiles v3 header parser) ----------


def parse_header(path):
	"""Parse the 127-byte PMTiles v3 header. No external deps.

	Layout (little-endian): magic[7] version[1], then u64 offsets/lengths, then
	u64 tile counts, then 1-byte flags, min/max zoom, and the bbox / center as
	int32 values in 1e7 degrees. See the PMTiles v3 spec.
	"""
	with open(path, 'rb') as handle:
		head = handle.read(PMTILES_V3_HEADER_LEN)
	if len(head) < PMTILES_V3_HEADER_LEN or head[:7] != PMTILES_MAGIC:
		sys.exit('%s is not a PMTiles archive (bad magic bytes).' % path)
	version = head[7]
	if version != 3:
		sys.exit('Unexpected PMTiles spec version %d (expected 3).' % version)
	addressed = struct.unpack_from('<Q', head, 72)[0]
	tile_entries = struct.unpack_from('<Q', head, 80)[0]
	tile_type = head[99]
	min_zoom = head[100]
	max_zoom = head[101]
	min_lng, min_lat, max_lng, max_lat = struct.unpack_from('<iiii', head, 102)
	return {
		'version': version,
		'addressed_tiles': addressed,
		'tile_entries': tile_entries,
		'tile_type': {1: 'mvt', 2: 'png', 3: 'jpeg', 4: 'webp', 5: 'avif'}.get(tile_type, tile_type),
		'min_zoom': min_zoom,
		'max_zoom': max_zoom,
		'min_lng': min_lng / 1e7,
		'min_lat': min_lat / 1e7,
		'max_lng': max_lng / 1e7,
		'max_lat': max_lat / 1e7,
	}


def verify(path, bbox=None):
	if not os.path.exists(path):
		sys.exit('%s does not exist -- run without --verify-only first.' % path)
	header = parse_header(path)
	size = os.path.getsize(path)
	print('')
	print('=== %s ===' % os.path.relpath(path, REPO_ROOT))
	print('  size          %d bytes (%.1f MB)' % (size, size / 1e6))
	print('  spec version  %d' % header['version'])
	print('  tile type     %s' % header['tile_type'])
	print('  zoom          %d..%d' % (header['min_zoom'], header['max_zoom']))
	print('  bounds        lng %.5f..%.5f  lat %.5f..%.5f' % (
		header['min_lng'], header['max_lng'], header['min_lat'], header['max_lat']))
	print('  tile entries  %d (addressed %d)' % (header['tile_entries'], header['addressed_tiles']))

	problems = []
	if header['tile_type'] != 'mvt':
		problems.append('tile type is %s, expected mvt (vector)' % header['tile_type'])
	if header['max_zoom'] < MIN_MAXZOOM:
		problems.append('max zoom %d < required %d' % (header['max_zoom'], MIN_MAXZOOM))
	if bbox is not None:
		# The archive must cover the requested address bbox (its own bounds may be
		# slightly larger because tiles snap to the z-grid).
		covers = (
			header['min_lng'] <= bbox['min_lng'] + 1e-6
			and header['min_lat'] <= bbox['min_lat'] + 1e-6
			and header['max_lng'] >= bbox['max_lng'] - 1e-6
			and header['max_lat'] >= bbox['max_lat'] - 1e-6
		)
		if not covers:
			problems.append('archive bounds do not cover the requested bbox')
	if problems:
		print('')
		for problem in problems:
			print('  FAIL: ' + problem)
		sys.exit(1)
	print('  OK: vector basemap covers the comarca and reaches street zoom.')


# ---------- main ----------


def main():
	parser = argparse.ArgumentParser(description='Build the offline vector basemap PMTiles for the covered comarca.')
	parser.add_argument('--margin', type=float, default=DEFAULT_MARGIN,
	                    help='degrees of padding around the address bbox (default %(default)s)')
	parser.add_argument('--source', default=None,
	                    help='Protomaps build URL to extract from (default: latest daily build)')
	parser.add_argument('--out', default=OUT_FILE, help='output path (default data/basemap-comarca.pmtiles)')
	parser.add_argument('--verify-only', action='store_true', help='only verify the existing archive, do not build')
	args = parser.parse_args()

	if args.verify_only:
		verify(args.out)
		return

	bbox = compute_bbox(args.margin)
	print('Address bbox from %d towns / %d points (+%.3f deg margin):' % (bbox['towns'], bbox['points'], args.margin))
	print('  lng %.5f .. %.5f   lat %.5f .. %.5f' % (bbox['min_lng'], bbox['max_lng'], bbox['min_lat'], bbox['max_lat']))

	if not shutil.which('pmtiles'):
		sys.exit(INSTALL_HINT)

	source = args.source or find_latest_build()
	print('Source build: %s' % source)
	run_extract(source, bbox, args.out)
	verify(args.out, bbox)


if __name__ == '__main__':
	main()
