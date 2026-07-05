#!/usr/bin/env python3
"""Build a Last Mile 'poblacion' dataset from Catastro INSPIRE Addresses data.

Usage:
    python3 tools/build_dataset.py <municipality_code> <town_id> <town_display_name>
    python3 tools/build_dataset.py 03059 crevillent Crevillent
    python3 tools/build_dataset.py 03059 crevillent Crevillent --gml /path/to/A.ES.SDGC.AD.03059.gml

Keeps only rural-type addresses with a real number (partidas, diseminados,
caminos, veredas, lugares, barrios... -- see RURAL_TYPES; urban street types are
excluded), cleans the zone names, deduplicates by (zone, number) averaging
coordinates, converts from EPSG:25830 (UTM 30N / ETRS89) to WGS84 and writes
data/<town_id>.json plus an updated data/index.json manifest.

Standard library only -- no pip dependencies.
"""

import json
import math
import os
import re
import ssl
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

# ---------- constants ----------

CATASTRO_HOST = 'https://www.catastro.hacienda.gob.es'
ATOM_URL = CATASTRO_HOST + '/INSPIRE/Addresses/{prov}/ES.SDGC.AD.atom_{prov}.xml'

EXPECTED_SRS = 'urn:ogc:def:crs:EPSG::25830'
NO_NUMBER = 'S-N'  # "sin numero" -> discard

# Rural thoroughfare types kept, with the display word prepended to the zone name.
# Municipalities register their scattered housing under different types: Crevillent
# uses PD (partida), Catral CM (camino), Dolores DS (diseminado), Orihuela LG
# (lugar/pedania), Callosa BO (barrio de huerta)... Urban types (CL, AV, PZ, TR,
# PS, UR, PL, RD...) are excluded: regular maps already find those.
RURAL_TYPES = {
	'PD': '',  # partida
	'DS': '',  # diseminado
	'LG': '',  # lugar / pedania
	'CM': 'Camino',
	'VR': 'Vereda',
	'CR': 'Carretera',
	'BO': 'Barrio',
	'HT': '',  # huerta/huerto
	'PG': 'Polígono',
	'PB': '',  # poblado
	'CS': '',  # caserio
	'AL': ''  # aldea
}

# Trailing-article forms that must move to the front: 'ALMAJAL DEL' -> 'del Almajal'
TRAILING_ARTICLES = ('DE LAS', 'DE LOS', 'DE LA', 'DEL', 'LAS', 'LOS', 'LA', 'EL')

# For prefixless types, prepend this word when the zone alone would be ambiguous
# (digit-only or very short names, e.g. Granja de Rocamora's 'LG 2' -> 'Lugar 2')
FALLBACK_WORDS = {'PD': 'Partida', 'DS': 'Diseminado', 'LG': 'Lugar', 'HT': 'Huerta', 'PB': 'Poblado', 'CS': 'Caserío', 'AL': 'Aldea'}

# Spanish minor words kept lowercase inside a title-cased name (never at position 0)
MINOR_WORDS = {'de', 'del', 'la', 'los', 'las', 'y'}

# GML namespaces
NS_AD = 'urn:x-inspire:specification:gmlas:Addresses:3.0'
NS_GN = 'urn:x-inspire:specification:gmlas:GeographicalNames:3.0'
NS_GML = 'http://www.opengis.net/gml/3.2'
NS_XLINK = 'http://www.w3.org/1999/xlink'

# EPSG:25830 -> ETRS89 UTM zone 30N over GRS80. ETRS89 ~ WGS84 (no datum shift needed).
GRS80_A = 6378137.0
GRS80_F = 1.0 / 298.257222101
UTM_K0 = 0.9996
UTM_ZONE = 30
UTM_LON0 = math.radians((UTM_ZONE * 6) - 183)  # zone 30 -> central meridian -3 deg
UTM_FALSE_EASTING = 500000.0

COORD_DECIMALS = 6
OUTPUT_VERSION = 1

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')

# Catastro's server presents a certificate chain that fails verification on some
# machines; the payload is public open data so we deliberately skip TLS verification.
INSECURE_SSL_CONTEXT = ssl._create_unverified_context()


# ---------- download ----------


def fetch_bytes(url):
	# Municipality folders may contain spaces ('03049-CALLOSA DE SEGURA') -> encode the path
	url = urllib.parse.quote(url, safe=':/?&=')
	req = urllib.request.Request(url, headers={'User-Agent': 'last-mile-dataset-builder'})
	with urllib.request.urlopen(req, context=INSECURE_SSL_CONTEXT, timeout=120) as resp:
		return resp.read()


def find_zip_url(municipality_code):
	"""Read the province ATOM feed and return the municipality zip download URL."""
	prov = municipality_code[:2]
	atom = fetch_bytes(ATOM_URL.format(prov=prov)).decode('utf-8', 'replace')
	# ATOM entries carry <georss:polygon>/links; the zip href contains the municipality code
	for match in re.finditer(r'href="([^"]*' + re.escape(municipality_code) + r'[^"]*\.zip)"', atom):
		return match.group(1)
	raise SystemExit(f'No zip URL for municipality {municipality_code} found in ATOM feed')


def download_gml(municipality_code):
	"""Download and extract the municipality GML, returning (gml_bytes, source_date)."""
	zip_url = find_zip_url(municipality_code)
	print(f'Downloading {zip_url}')
	raw = fetch_bytes(zip_url)
	with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as tmp:
		tmp.write(raw)
		zip_path = tmp.name
	try:
		with zipfile.ZipFile(zip_path) as zf:
			gml_name = next((n for n in zf.namelist() if n.lower().endswith('.gml')), None)
			if not gml_name:
				raise SystemExit('No .gml file inside the downloaded zip')
			info = zf.getinfo(gml_name)
			source_date = '%04d-%02d-%02d' % (info.date_time[0], info.date_time[1], info.date_time[2])
			return zf.read(gml_name), source_date
	finally:
		os.unlink(zip_path)


# ---------- coordinate transform ----------


def utm_to_wgs84(easting, northing):
	"""Inverse transverse-Mercator (Snyder series) for UTM 30N / GRS80 -> lat, lng."""
	a = GRS80_A
	e2 = 2 * GRS80_F - GRS80_F * GRS80_F
	ep2 = e2 / (1 - e2)

	x = easting - UTM_FALSE_EASTING
	y = northing  # northern hemisphere, false northing 0

	m = y / UTM_K0
	mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))

	e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
	phi1 = (
		mu
		+ (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
		+ (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
		+ (151 * e1 ** 3 / 96) * math.sin(6 * mu)
		+ (1097 * e1 ** 4 / 512) * math.sin(8 * mu)
	)

	sin_phi1 = math.sin(phi1)
	cos_phi1 = math.cos(phi1)
	tan_phi1 = math.tan(phi1)

	c1 = ep2 * cos_phi1 ** 2
	t1 = tan_phi1 ** 2
	n1 = a / math.sqrt(1 - e2 * sin_phi1 ** 2)
	r1 = a * (1 - e2) / (1 - e2 * sin_phi1 ** 2) ** 1.5
	d = x / (n1 * UTM_K0)

	lat = phi1 - (n1 * tan_phi1 / r1) * (
		d ** 2 / 2
		- (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
		+ (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720
	)
	lng = UTM_LON0 + (
		d
		- (1 + 2 * t1 + c1) * d ** 3 / 6
		+ (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120
	) / cos_phi1

	return math.degrees(lat), math.degrees(lng)


# ---------- name cleaning ----------


def rural_type(raw_name):
	"""Return the thoroughfare type code if the name belongs to a rural type, else None."""
	first = raw_name.strip().split(' ', 1)[0].upper()
	return first if first in RURAL_TYPES else None


def clean_zone(raw_name, type_code):
	"""'PD BOCH, EL' -> 'El Boch'; 'CM ALMAJAL DEL' -> 'Camino del Almajal'."""
	name = raw_name.replace('&apos;', "'").strip()
	if name.upper().startswith(type_code + ' '):
		name = name[len(type_code) + 1:].strip()
	# Trailing-article forms: 'BOCH, EL' -> 'EL BOCH', 'ALMAJAL DEL' -> 'DEL ALMAJAL'
	if ', ' in name:
		base, article = name.split(', ', 1)
		name = f'{article} {base}'
	else:
		upper = name.upper()
		for article in TRAILING_ARTICLES:
			if upper.endswith(' ' + article):
				name = f'{name[-len(article):]} {name[:-len(article) - 1]}'
				break
	prefix = RURAL_TYPES[type_code]
	if prefix:
		# 'Camino del Almajal': the article stays lowercase after the type word
		zone = title_case_es(name)
		if zone.split(' ', 1)[0].lower() in MINOR_WORDS | {'el', 'las', 'los'}:
			zone = zone[0].lower() + zone[1:]
		return f'{prefix} {zone}'
	zone = title_case_es(name)
	if zone and (zone[0].isdigit() or len(zone) <= 2):
		fallback = FALLBACK_WORDS.get(type_code)
		if fallback:
			return f'{fallback} {zone}'
	return zone


def title_case_es(name):
	words = name.lower().split()
	out = []
	for i, word in enumerate(words):
		if "'" in word:
			# apostrophe prefix like d'eula -> d'Eula (prefix stays lowercase)
			pre, post = word.split("'", 1)
			out.append(pre + "'" + (post.capitalize() if post else ''))
		elif i > 0 and word in MINOR_WORDS:
			out.append(word)
		else:
			out.append(word.capitalize())
	return ' '.join(out)


def slugify(value):
	text = value.replace("'", ' ')
	text = ''.join(c for c in unicode_normalize(text) if not is_combining(c)).lower()
	text = re.sub(r'[^a-z0-9]+', '-', text)
	return text.strip('-')


def unicode_normalize(text):
	import unicodedata

	return unicodedata.normalize('NFD', text)


def is_combining(char):
	import unicodedata

	return unicodedata.combining(char)


# ---------- GML parsing ----------


def local(tag):
	return tag.rsplit('}', 1)[-1]


def parse_gml(gml_bytes):
	"""Stream the GML, returning (thoroughfare_names, addresses).

	thoroughfare_names: {gml_id: text}
	addresses: list of dicts {tn_refs, number, x, y}
	"""
	thoroughfare_names = {}
	addresses = []
	srs_checked = False

	# iterparse over the byte stream; ThoroughfareName elements appear after Addresses,
	# so we resolve the thoroughfare reference in a second pass below.
	source = _byte_stream(gml_bytes)
	for event, elem in ET.iterparse(source, events=('end',)):
		name = local(elem.tag)
		if name == 'ThoroughfareName':
			gid = elem.get('{%s}id' % NS_GML)
			text_el = elem.find('.//{%s}text' % NS_GN)
			if gid and text_el is not None and text_el.text:
				thoroughfare_names[gid] = text_el.text.strip()
			elem.clear()
		elif name == 'Address':
			addr = _parse_address(elem)
			if addr is not None:
				if not srs_checked:
					_check_srs(elem)
					srs_checked = True
				addresses.append(addr)
			elem.clear()
	return thoroughfare_names, addresses


def _byte_stream(gml_bytes):
	import io

	return io.BytesIO(gml_bytes)


def _check_srs(address_elem):
	point = address_elem.find('.//{%s}Point' % NS_GML)
	srs = point.get('srsName') if point is not None else None
	if srs != EXPECTED_SRS:
		raise SystemExit(f'Unexpected srsName {srs!r}; expected {EXPECTED_SRS!r}. Aborting to avoid wrong coordinates.')


def _parse_address(elem):
	pos_el = elem.find('.//{%s}pos' % NS_GML)
	if pos_el is None or not pos_el.text:
		return None
	coords = pos_el.text.split()
	if len(coords) < 2:
		return None
	x, y = float(coords[0]), float(coords[1])

	# The number lives in the first LocatorDesignator/designator
	number = None
	for loc in elem.findall('.//{%s}LocatorDesignator' % NS_AD):
		des = loc.find('{%s}designator' % NS_AD)
		if des is not None and des.text:
			number = des.text.strip()
			break
	if number is None:
		return None

	tn_refs = []
	for comp in elem.findall('{%s}component' % NS_AD):
		href = comp.get('{%s}href' % NS_XLINK)
		if href:
			tn_refs.append(href.lstrip('#'))

	return {'tn_refs': tn_refs, 'number': number, 'x': x, 'y': y}


# ---------- build ----------


def build(municipality_code, town_id, town_name, gml_bytes, source_date):
	thoroughfare_names, addresses = parse_gml(gml_bytes)
	print(f'Addresses read: {len(addresses)}')
	print(f'Thoroughfare names: {len(thoroughfare_names)}')

	kept = []  # (zone, number, x, y)
	partidas = set()
	type_counts = {}
	for addr in addresses:
		raw_name = None
		for ref in addr['tn_refs']:
			if ref in thoroughfare_names:
				raw_name = thoroughfare_names[ref]
				break
		if raw_name is None:
			continue
		type_code = rural_type(raw_name)
		if type_code is None:
			continue
		if addr['number'] == NO_NUMBER:
			continue
		zone = clean_zone(raw_name, type_code)
		if not zone:
			continue
		kept.append((zone, addr['number'], addr['x'], addr['y']))
		partidas.add(zone)
		type_counts[type_code] = type_counts.get(type_code, 0) + 1

	print(f'Kept rural numbered addresses: {len(kept)} {type_counts}')

	# Dedup by (partida, number): average the UTM coordinates (centroid) then convert
	groups = {}
	for partida, number, x, y in kept:
		key = (partida, number)
		bucket = groups.setdefault(key, [0.0, 0.0, 0])
		bucket[0] += x
		bucket[1] += y
		bucket[2] += 1

	places = []
	for (partida, number), (sx, sy, n) in groups.items():
		lat, lng = utm_to_wgs84(sx / n, sy / n)
		places.append(
			{
				'id': f'{slugify(partida)}-{number}',
				'name': f'{partida}, {number}',
				'partida': partida,
				'num': number,
				'lat': round(lat, COORD_DECIMALS),
				'lng': round(lng, COORD_DECIMALS)
			}
		)

	places.sort(key=lambda p: (p['partida'], p['num']))
	print(f'Deduped places: {len(places)}')
	print(f'Partidas: {len(partidas)}')

	dataset = {
		'id': town_id,
		'name': town_name,
		'source': 'Direccion General del Catastro',
		'sourceDate': source_date,
		'version': OUTPUT_VERSION,
		'count': len(places),
		'places': places
	}
	return dataset


def resolve_version(town_path, dataset):
	"""Keep the previous version if places are unchanged, bump it otherwise.

	Without this, regenerated datasets would stay at version 1 forever and the
	app's 'Actualizar' button would never appear for already-downloaded towns.
	"""
	if not os.path.exists(town_path):
		return OUTPUT_VERSION
	try:
		with open(town_path, encoding='utf-8') as fh:
			previous = json.load(fh)
	except (json.JSONDecodeError, OSError):
		return OUTPUT_VERSION
	prev_version = int(previous.get('version', OUTPUT_VERSION))
	if previous.get('places') == dataset['places']:
		return prev_version
	return prev_version + 1


def write_outputs(town_id, town_name, dataset):
	os.makedirs(DATA_DIR, exist_ok=True)
	town_path = os.path.join(DATA_DIR, f'{town_id}.json')
	dataset['version'] = resolve_version(town_path, dataset)
	print(f'Version: {dataset["version"]}')
	with open(town_path, 'w', encoding='utf-8') as fh:
		json.dump(dataset, fh, ensure_ascii=False, separators=(',', ':'))

	index_path = os.path.join(DATA_DIR, 'index.json')
	manifest = {'towns': []}
	if os.path.exists(index_path):
		with open(index_path, encoding='utf-8') as fh:
			try:
				manifest = json.load(fh)
			except json.JSONDecodeError:
				manifest = {'towns': []}
	if not isinstance(manifest.get('towns'), list):
		manifest['towns'] = []

	entry = {
		'id': town_id,
		'name': town_name,
		'file': f'{town_id}.json',
		'version': dataset['version'],
		'count': dataset['count'],
		'sourceDate': dataset['sourceDate']
	}
	manifest['towns'] = [t for t in manifest['towns'] if t.get('id') != town_id] + [entry]
	manifest['towns'].sort(key=lambda t: t.get('name', ''))
	with open(index_path, 'w', encoding='utf-8') as fh:
		json.dump(manifest, fh, ensure_ascii=False, separators=(',', ':'))

	town_size = os.path.getsize(town_path)
	index_size = os.path.getsize(index_path)
	print(f'Wrote {town_path} ({town_size / 1024:.1f} KB)')
	print(f'Wrote {index_path} ({index_size} B)')


# ---------- cli ----------


def main(argv):
	args = [a for a in argv[1:] if not a.startswith('--')]
	gml_flag = None
	for i, a in enumerate(argv):
		if a == '--gml' and i + 1 < len(argv):
			gml_flag = argv[i + 1]

	if len(args) < 3:
		print(__doc__)
		return 1

	municipality_code, town_id, town_name = args[0], args[1], args[2]

	if gml_flag:
		with open(gml_flag, 'rb') as fh:
			gml_bytes = fh.read()
		mtime = os.path.getmtime(gml_flag)
		source_date = datetime.fromtimestamp(mtime, tz=timezone.utc).strftime('%Y-%m-%d')
	else:
		gml_bytes, source_date = download_gml(municipality_code)

	dataset = build(municipality_code, town_id, town_name, gml_bytes, source_date)
	write_outputs(town_id, town_name, dataset)
	print(f'sourceDate: {source_date}')
	return 0


if __name__ == '__main__':
	sys.exit(main(sys.argv))
