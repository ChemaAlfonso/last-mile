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
NO_NUMBER = 'S-N'  # Catastro's "sin numero" marker in the source data
NO_NUMBER_DISPLAY = 'S/N'  # Spanish convention shown to the driver

# Rural thoroughfare types kept, with the display word prepended to the zone name.
# Municipalities register their scattered housing under different types: Crevillent
# uses PD (partida), Catral CM (camino), Dolores DS (diseminado), Orihuela LG
# (lugar/pedania), Callosa BO (barrio de huerta)... Urban types (CL, AV, PZ, TR,
# PS, UR, RD...) are excluded: regular maps already find those. PL (poligono) is a
# special case handled below -- it is urban by default with a rural allow-list.
RURAL_TYPES = {
	'PD': '',  # partida
	'DS': '',  # diseminado
	'LG': '',  # lugar / pedania
	'CM': 'Camino',
	'VR': 'Vereda',
	'CR': 'Carretera',
	'BO': 'Barrio',
	'HT': '',  # huerta/huerto
	'PG': 'Polígono',  # unused across the Alicante towns built so far (they use PL, see
	                   # below); kept because other provinces may register rural poligonos as PG
	'PL': '',  # poligono -- URBAN by default, only kept for the rural zones in is_rural_pl()
	'PB': '',  # poblado
	'CS': '',  # caserio
	'AL': ''  # aldea
}

# PL (poligono) in this province is overwhelmingly an URBAN development code: industrial
# estates, PERI/PAU/UE planning sectors and coastal urbanisations (Orihuela: 'PL PINAR DE
# BONANZA', 'PL PUENTE ALTO'...). A handful of PL zones are genuinely rural scattered
# housing and would otherwise vanish. We rescue those two ways, and drop every other PL:
#   (a) the name carries an explicit rural keyword ('PL DISEMINADOS' -> Callosa), or
#   (b) a reviewed per-municipality allow-list for rural PL zones whose name has no such
#       keyword. Confirmed by point density (rural ~0.3-0.7 dwellings/ha vs urban 2-6/ha).
# Coastal urbanisations look like plain place names, so they can only be kept out by NOT
# auto-including unlisted PL zones -- hence the explicit allow-list rather than a blocklist.
RURAL_PL_KEYWORDS = ('PARTID', 'DISEMIN', 'PARAJE', 'CASERIO', 'CASERÍO', 'ALQUERIA', 'MASIA')
RURAL_PL_ZONES = {
	'03005': {'PL MOS DEL BOU'}  # Albatera: rural paraje, 81 dwellings (density 0.73/ha)
	# Orihuela 'PL NORIAS LAS' is intentionally omitted: its zone 'Las Norias' already exists
	# (registered as LG), so adding it would perturb existing places, not add missing ones.
}

# Trailing-article forms that must move to the front: 'ALMAJAL DEL' -> 'del Almajal'
TRAILING_ARTICLES = ('DE LAS', 'DE LOS', 'DE LA', 'DEL', 'LAS', 'LOS', 'LA', 'EL')

# For prefixless types, prepend this word when the zone alone would be ambiguous
# (digit-only or very short names, e.g. Granja de Rocamora's 'LG 2' -> 'Lugar 2')
FALLBACK_WORDS = {'PD': 'Partida', 'DS': 'Diseminado', 'LG': 'Lugar', 'HT': 'Huerta', 'PB': 'Poblado', 'CS': 'Caserío', 'AL': 'Aldea'}

# Spanish minor words kept lowercase inside a title-cased name (never at position 0).
# 'el' is included so mid-name articles read consistently ('La Dehesa' / 'El Moco', not
# the old 'Dehesa la' / 'Moco El' mix); a leading article is still capitalised.
MINOR_WORDS = {'de', 'del', 'el', 'la', 'los', 'las', 'y'}

# Whole-token abbreviation expansions applied during title-casing. Only clearly-verified
# ones; the key is matched case-insensitively with any trailing dot removed. 'D' -> 'Don'
# is deliberately NOT here (a bare 'D' is too ambiguous) -- it is handled per town below.
ABBREVIATIONS = {
	'CR': 'Carretera',
	'VD': 'Vereda',
	'CMNO': 'Camino',
	'CEMENTERI': 'Cementerio'
}

# Saint abbreviations expand only before a real name token, so 'S Roque' -> 'San Roque' but
# truncations like 'S Ba' / 'S 10.2' are left untouched (never guess a truncated name).
SAINT_ABBREVIATIONS = {'S': 'San', 'STA': 'Santa', 'STO': 'Santo'}

# Verified proper-noun diacritics, applied per token (accent-free source -> Spanish spelling).
# Kept intentionally small; extend only with names confirmed against municipal sources.
PROPER_NOUN_ACCENTS = {'JOSE': 'José', 'AGUEDA': 'Águeda'}

# Trailing cadastral group tokens ('GP.3', 'GP 11') stripped from a zone name so the real
# partida survives and its GP fragments merge into one: 'MOCO EL GP.3' -> 'MOCO EL'. Bare
# trailing numbers are NOT stripped generally (they are meaningful in 'Sector 2', 'Ue 3',
# 'Barrio Angeles 1'...); the one verified bare-number case is fixed via CANONICAL_ZONE_NAMES.
GROUP_TOKEN_RE = re.compile(r'\s+GP\.?\s*\d+\s*$', re.IGNORECASE)

# Per-municipality canonical display names, applied to the already-cleaned zone name.
# These are owner-verified against municipal sources; they fix Catastro spelling errors and
# add the correct article. Merges happen naturally when two source zones clean to the same
# canonical name. Place ids are NOT affected (they come from legacy_zone_slug).
CANONICAL_ZONE_NAMES = {
	'03005': {  # Albatera
		'Atalayas': 'Las Atalayas',
		'Lomas': 'Las Lomas',
		'Rincon': 'El Rincón',
		'Sierra': 'La Sierra',
		'Moco': 'El Moco',
		'Dehesa': 'La Dehesa',
		'Huerta la 17': 'La Huerta'
	},
	'03015': {  # Almoradí
		'Eralta': 'La Eralta',
		'Puente D Pedro': 'Puente Don Pedro'
	},
	'03059': {  # Crevillent
		'San Antonio Florida': 'San Antonio de la Florida',
		'La Pla': 'El Plà'
	}
}

# Distance-based merging applies ONLY to zones that are two spellings of the SAME place, so
# a duplicated house registered under both spellings collapses to one. It must NOT apply to
# cadastral GP fragments (El Moco...), where a reused number means a different house even when
# nearby. Within a listed zone, colliding (zone, number) points closer than the threshold
# merge-average; farther ones stay separate (the number was reused for a distant house).
DISTANCE_MERGE_ZONES = {
	'03059': {'San Antonio de la Florida'}  # Crevillent: merges 'S ...' and 'San ...' variants
}
MERGE_DISTANCE_METRES = 150

# GML namespaces
NS_AD = 'urn:x-inspire:specification:gmlas:Addresses:3.0'
NS_GN = 'urn:x-inspire:specification:gmlas:GeographicalNames:3.0'
NS_GML = 'http://www.opengis.net/gml/3.2'
NS_XLINK = 'http://www.w3.org/1999/xlink'
NS_BASE = 'urn:x-inspire:specification:gmlas:BaseTypes:3.2'

# Grid (in UTM metres) used to collapse S/N points that sit at effectively the same spot.
# True duplicates in the source share identical coordinates; distinct dwellings on the same
# cadastral parcel can sit hundreds of metres apart, so we must NOT dedup S/N by parcel.
SN_DEDUP_METRES = 1

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


def is_rural_pl(raw_name, municipality_code):
	"""PL (poligono) is urban by default; keep it only for confirmed-rural zones."""
	upper = raw_name.upper()
	if any(keyword in upper for keyword in RURAL_PL_KEYWORDS):
		return True
	return raw_name.strip() in RURAL_PL_ZONES.get(municipality_code, ())


def parcel_ref(local_id):
	"""Cadastral parcel reference embedded in a Catastro Address localId.

	Rural example: '03.059.179.S-N.03059A02000295' -> '03059A02000295' (poligono 020,
	parcela 00295). It is persistent across dataset rebuilds, so it anchors stable S/N ids.
	"""
	if not local_id:
		return ''
	return local_id.split('.')[-1].strip()


# Rural cadastral reference: 5-digit municipality, sector letter, 3-digit poligono, 5-digit
# parcela (e.g. '03059A02000295'). Urban refs (cartography-coded) do not match this pattern.
RURAL_PARCEL_RE = re.compile(r'^\d{5}[A-Z](\d{3})(\d{5})[0-9A-Z]*$')

# S/N points whose cadastral ref is urban-format carry no polígono/parcela. Their official
# domicilio was looked up ONCE via Catastro OVC (Consulta_DNPRC, see docs/datasets.md) on
# 2026-07-20; where it adds a real designator beyond the zone (a plot number or a street) we
# store that here. Refs not listed fall back to the plain 'Ref. <RC>' (the official identifier).
# To refresh or extend for a new town, re-run the OVC lookup documented in docs/datasets.md.
OVC_SN_REF_LABELS = {
	'0861501XH8206S': 'Parcela 34', '0861502XH8206S': 'Parcela 33', '0861503XH8206S': 'Parcela 32',
	'0861504XH8206S': 'Parcela 31', '0861505XH8206S': 'Parcela 30', '0960301XH8206S': 'Parcela 22',
	'0960302XH8206S': 'Parcela 23', '0960303XH8206S': 'Parcela 24', '0960304XH8206S': 'Parcela 25',
	'0960305XH8206S': 'Parcela 26', '0960306XH8206S': 'Parcela 27', '0960307XH8206S': 'Parcela 28',
	'0960308XH8206S': 'Parcela 29', '0961201XH8206S': 'Parcela 39', '0961202XH8206S': 'Parcela 38',
	'0961203XH8206S': 'Parcela 37', '0961204XH8206S': 'Parcela 36', '0961205XH8206S': 'Parcela 35',
	'0961701XH8206S': 'Parcela 2', '0961703XH8206S': 'Parcela 5', '0961704XH8206S': 'Parcela 4',
	'0961705XH8206S': 'Parcela 3', '0961801XH8206S': 'Parcela 6', '0961802XH8206S': 'Parcela 7',
	'0961803XH8206S': 'Parcela 8', '0961804XH8206S': 'Parcela 9', '0961805XH8206S': 'Parcela 10',
	'0961806XH8206S': 'Parcela 11', '0961807XH8206S': 'Parcela 12', '0961808XH8206S': 'Parcela 13',
	'0961809XH8206S': 'Parcela 21', '0961810XH8206S': 'Parcela 20', '0961811XH8206S': 'Parcela 19',
	'0961812XH8206S': 'Parcela 18', '0961813XH8206S': 'Parcela 17', '0961814XH8206S': 'Parcela 16',
	'0961815XH8206S': 'Parcela 15', '0961816XH8206S': 'Parcela 14',  # Callosa 'Barrio Callosilla' plots
	'2980903XH9225S': 'Calle Joseph Ortin 10',  # Crevillent, San Felipe Neri
	'6233606XH9263S': 'Calle Comadrona Maria Dolore',  # Dolores (Catastro truncates the street name)
	'5932706XH9253S': 'Sector 3, Parcela 10.2'  # Dolores
}


def parcel_ref_label(ref):
	"""S/N reference label: rural -> 'Políg. X · Parc. Y'; urban -> OVC domicilio or 'Ref. <RC>'."""
	ref = (ref or '').strip().upper()
	if not ref:
		return None
	match = RURAL_PARCEL_RE.match(ref)
	if match:
		return f'Políg. {int(match.group(1))} · Parc. {int(match.group(2))}'
	return OVC_SN_REF_LABELS.get(ref) or f'Ref. {ref}'


def clean_zone(raw_name, type_code):
	"""'PD BOCH, EL' -> 'El Boch'; 'CM ALMAJAL DEL' -> 'Camino del Almajal'.

	Produces the DISPLAY name (group-token stripping, abbreviation expansion, article
	normalisation). Place ids do NOT come from here -- see legacy_zone_slug.
	"""
	name = raw_name.replace('&apos;', "'").strip()
	if name.upper().startswith(type_code + ' '):
		name = name[len(type_code) + 1:].strip()
	# Drop cadastral group tokens ('GP.3') so a zone's fragments merge into one partida.
	name = GROUP_TOKEN_RE.sub('', name)
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
	words = name.split()
	out = []
	for i, word in enumerate(words):
		next_word = words[i + 1] if i + 1 < len(words) else ''
		out.append(_case_word(word, i, next_word))
	return ' '.join(out)


def _case_word(word, index, next_word):
	key = word.upper().rstrip('.')
	if key in SAINT_ABBREVIATIONS and _is_name_token(next_word):
		return SAINT_ABBREVIATIONS[key]
	if key in ABBREVIATIONS:
		return ABBREVIATIONS[key]
	lower = word.lower()
	if "'" in lower:
		# apostrophe prefix like d'eula -> d'Eula (prefix stays lowercase)
		pre, post = lower.split("'", 1)
		return pre + "'" + (_capitalize_part(post) if post else '')
	if index > 0 and lower in MINOR_WORDS:
		return lower
	return _case_compound(lower)


def _case_compound(token):
	"""Capitalise each '-'/'.'-separated sub-token: 'alicante-murcia' -> 'Alicante-Murcia'."""
	parts = re.split(r'([-.])', token)
	out = []
	sub_index = 0
	for part in parts:
		if part in ('-', '.') or part == '':
			out.append(part)
			continue
		if sub_index > 0 and part in MINOR_WORDS:
			out.append(part)
		else:
			out.append(_capitalize_part(part))
		sub_index += 1
	return ''.join(out)


def _capitalize_part(part):
	accented = PROPER_NOUN_ACCENTS.get(part.upper())
	return accented if accented else part[:1].upper() + part[1:]


def _is_name_token(word):
	"""A real name token has at least three letters -- used to gate saint-abbrev expansion."""
	return sum(char.isalpha() for char in word) >= 3


# --- frozen id cleaning ---------------------------------------------------------------
# Reproduces the place ids in the shipped data/*.json byte-for-byte. Display names evolve
# (clean_zone above) but ids must not churn, or drivers' saved edits -- keyed by id -- are
# orphaned. Do NOT add the display fixes here; this is the pre-fix cleaning, kept frozen.


def legacy_zone_slug(raw_name, type_code):
	return slugify(_legacy_clean_zone(raw_name, type_code))


def _legacy_clean_zone(raw_name, type_code):
	name = raw_name.replace('&apos;', "'").strip()
	if name.upper().startswith(type_code + ' '):
		name = name[len(type_code) + 1:].strip()
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
		zone = _legacy_title_case_es(name)
		if zone.split(' ', 1)[0].lower() in MINOR_WORDS | {'el', 'las', 'los'}:
			zone = zone[0].lower() + zone[1:]
		return f'{prefix} {zone}'
	zone = _legacy_title_case_es(name)
	if zone and (zone[0].isdigit() or len(zone) <= 2):
		fallback = FALLBACK_WORDS.get(type_code)
		if fallback:
			return f'{fallback} {zone}'
	return zone


def _legacy_title_case_es(name):
	words = name.lower().split()
	out = []
	for i, word in enumerate(words):
		if "'" in word:
			pre, post = word.split("'", 1)
			out.append(pre + "'" + (post.capitalize() if post else ''))
		elif i > 0 and word in MINOR_WORDS:
			out.append(word)
		else:
			out.append(word.capitalize())
	return ' '.join(out)


def canonical_zone(zone, municipality_code):
	"""Apply the owner-verified per-town display-name overrides."""
	return CANONICAL_ZONE_NAMES.get(municipality_code, {}).get(zone, zone)


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

	local_id_el = elem.find('.//{%s}localId' % NS_BASE)
	local_id = local_id_el.text.strip() if local_id_el is not None and local_id_el.text else None

	return {'tn_refs': tn_refs, 'number': number, 'x': x, 'y': y, 'local_id': local_id}


# ---------- build ----------


def _cluster_units(zone_units):
	"""Single-link clustering of same-(zone, number) units by MERGE_DISTANCE_METRES (UTM)."""
	clusters = [[unit] for unit in zone_units]
	merged = True
	while merged:
		merged = False
		for i in range(len(clusters)):
			for j in range(i + 1, len(clusters)):
				if _clusters_close(clusters[i], clusters[j]):
					clusters[i].extend(clusters.pop(j))
					merged = True
					break
			if merged:
				break
	return clusters


def _clusters_close(a, b):
	return any(
		math.hypot(ua['x'] - ub['x'], ua['y'] - ub['y']) <= MERGE_DISTANCE_METRES for ua in a for ub in b
	)


def _surviving_base(cluster, legacy_totals):
	"""On a merge keep the id of the larger legacy zone (the established one), tie by slug."""
	return sorted(cluster, key=lambda u: (-legacy_totals[u['base']], u['base']))[0]['base']


def build_sn_places(sn_records):
	"""Turn rural S/N records into places, one per distinct location.

	Dedup only collapses points at effectively the same spot (SN_DEDUP_METRES grid); two
	dwellings on the same parcel that sit far apart stay as two points. Ids are anchored on
	the legacy zone slug plus the persistent cadastral parcel ref so they survive rebuilds
	(drivers' edits are keyed by place id); when a parcel legitimately holds several distinct
	S/N points the id also carries the grid cell, keeping every id unique and order-independent.
	"""
	groups = {}  # (legacy_base, gx, gy) -> [sum_x, sum_y, n, parcel_ref, display]
	for display, legacy_base, x, y, ref in sn_records:
		gx = round(x / SN_DEDUP_METRES)
		gy = round(y / SN_DEDUP_METRES)
		bucket = groups.setdefault((legacy_base, gx, gy), [0.0, 0.0, 0, ref, display])
		bucket[0] += x
		bucket[1] += y
		bucket[2] += 1
		if ref < bucket[3]:  # deterministic pick if a cell mixes refs
			bucket[3] = ref

	drafts = []
	base_ids = {}
	for (legacy_base, gx, gy), (sx, sy, n, ref, display) in groups.items():
		lat, lng = utm_to_wgs84(sx / n, sy / n)
		base_id = f'{legacy_base}-sn-{slugify(ref)}' if ref else f'{legacy_base}-sn'
		base_ids[base_id] = base_ids.get(base_id, 0) + 1
		drafts.append((base_id, display, ref, gx, gy, round(lat, COORD_DECIMALS), round(lng, COORD_DECIMALS)))

	places = []
	for base_id, display, ref, gx, gy, lat, lng in drafts:
		place_id = base_id if base_ids[base_id] == 1 else f'{base_id}-{gx}-{gy}'
		place = {
			'id': place_id,
			'name': f'{display}, {NO_NUMBER_DISPLAY}',
			'partida': display,
			'num': NO_NUMBER_DISPLAY,
			'lat': lat,
			'lng': lng
		}
		label = parcel_ref_label(ref)  # rural refs only; urban refs stay unlabelled
		if label:
			place['ref'] = label
		places.append(place)
	return places


def build(municipality_code, town_id, town_name, gml_bytes, source_date):
	thoroughfare_names, addresses = parse_gml(gml_bytes)
	print(f'Addresses read: {len(addresses)}')
	print(f'Thoroughfare names: {len(thoroughfare_names)}')

	kept = []  # numbered: (zone, number, x, y)
	sn_records = []  # sin-numero: (zone, x, y, parcel_ref)
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
		if type_code == 'PL' and not is_rural_pl(raw_name, municipality_code):
			continue
		zone = clean_zone(raw_name, type_code)
		if not zone:
			continue
		display = canonical_zone(zone, municipality_code)  # user-facing name (may merge zones)
		legacy_base = legacy_zone_slug(raw_name, type_code)  # id anchor -- never changes
		if addr['number'] == NO_NUMBER:
			# Keep S/N points: they are real dwellings with valid coordinates, just no house
			# number. Each keeps its own position (not averaged with the rest of the zone).
			sn_records.append((display, legacy_base, addr['x'], addr['y'], parcel_ref(addr['local_id'])))
			continue
		kept.append((display, legacy_base, addr['number'], addr['x'], addr['y']))
		partidas.add(display)
		type_counts[type_code] = type_counts.get(type_code, 0) + 1

	print(f'Kept rural numbered addresses: {len(kept)} {type_counts}')
	print(f'Rural S/N addresses: {len(sn_records)}')

	# A "unit" is one legacy zone + number, coordinates averaged -- i.e. exactly what used to
	# be a single shipped place. Its id stays anchored on the legacy zone slug.
	units = {}  # (display, number, legacy_base) -> [sum_x, sum_y, n]
	legacy_totals = {}  # legacy_base -> address count, to pick the surviving id when merging
	for display, legacy_base, number, x, y in kept:
		bucket = units.setdefault((display, number, legacy_base), [0.0, 0.0, 0])
		bucket[0] += x
		bucket[1] += y
		bucket[2] += 1
		legacy_totals[legacy_base] = legacy_totals.get(legacy_base, 0) + 1

	# Units that share a (display, number) are the same real address only when physically
	# close; a reused number for a far-away house stays a separate place with its own id.
	by_zone_number = {}
	for (display, number, legacy_base), (sx, sy, n) in units.items():
		by_zone_number.setdefault((display, number), []).append(
			{'base': legacy_base, 'x': sx / n, 'y': sy / n, 'n': n}
		)

	merge_zones = DISTANCE_MERGE_ZONES.get(municipality_code, set())
	places = []
	for (display, number), zone_units in by_zone_number.items():
		clusters = _cluster_units(zone_units) if display in merge_zones else [[unit] for unit in zone_units]
		for cluster in clusters:
			total = sum(u['n'] for u in cluster)
			cx = sum(u['x'] * u['n'] for u in cluster) / total
			cy = sum(u['y'] * u['n'] for u in cluster) / total
			base = _surviving_base(cluster, legacy_totals)
			lat, lng = utm_to_wgs84(cx, cy)
			places.append(
				{
					'id': f'{base}-{number}',
					'name': f'{display}, {number}',
					'partida': display,
					'num': number,
					'lat': round(lat, COORD_DECIMALS),
					'lng': round(lng, COORD_DECIMALS)
				}
			)

	places.extend(build_sn_places(sn_records))
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
