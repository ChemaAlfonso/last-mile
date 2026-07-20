/* ============================================================
   Last Mile — app logic
   Sections: config, db, geocoding, map, search, save flow,
             list, import/export, ui helpers, init
   ============================================================ */

'use strict'

/* ---------- config ---------- */

const CONFIG = {
	db: {
		name: 'last-mile',
		version: 3,
		store: 'addresses',
		placesStore: 'places',
		placesTownIndex: 'town',
		basemapStore: 'basemap'
	},
	basemap: {
		id: 'comarca',
		url: 'data/basemap-comarca.pmtiles',
		// Bump (or override via manifest.basemap.version) to make installed copies refresh through
		// the normal town download/update flow -- the basemap is invisible to the driver.
		version: 1,
		// Coarse floor used only when the server sends no Content-Length: reject a blob far smaller
		// than the real basemap (~25 MB). The precise check uses the server's Content-Length.
		expectedBytes: 20 * 1024 * 1024,
		// A truncated download must never be accepted: require at least this fraction of the
		// server-reported Content-Length before marking the basemap installed.
		minCompleteRatio: 0.98,
		// protomaps-leaflet built-in flavor closest to the app's light look
		flavor: 'light',
		lang: 'es',
		minZoom: 0,
		maxZoom: 18,
		// The vector tiles top out here; Leaflet overzooms beyond it so z16-18 still render
		maxDataZoom: 15,
		// Fallback comarca bbox [[minLat,minLon],[maxLat,maxLon]] used if the pmtiles header can't be
		// read. The overlay is clamped to these bounds so it never paints over the world raster.
		bounds: [
			[37.85, -1.085],
			[38.356, -0.666]
		],
		// OSM is already credited by the always-on raster base; the overlay only adds the Protomaps credit
		attribution: '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>'
	},
	dataset: {
		indexUrl: 'data/index.json',
		fileBase: 'data/',
		zoomThreshold: 14,
		renderCap: 1500,
		debounceMs: 150,
		boundsPad: 0.2,
		resultLimit: 8,
		// Extra px added to each dot's tap hit-area (visual unchanged) so imprecise taps still open
		// the popup. Kept modest to avoid neighbours stealing taps in dense partidas.
		tapTolerance: 8,
		dot: {
			radius: 6,
			weight: 2,
			color: '#1a1714',
			fillColor: '#e8500a',
			fillOpacity: 0.9
		}
	},
	storageKey: 'last-mile:settings',
	map: {
		center: [40.4168, -3.7038],
		zoom: 6,
		focusZoom: 16,
		locateZoom: 17,
		tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
		attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
		maxZoom: 19
	},
	search: {
		debounceMs: 700,
		minQueryLength: 3,
		nominatimSearch: 'https://nominatim.openstreetmap.org/search',
		nominatimReverse: 'https://nominatim.openstreetmap.org/reverse',
		remoteLimit: 5,
		localLimit: 8,
		language: 'es'
	},
	geo: {
		enableHighAccuracy: true,
		timeout: 10000,
		maximumAge: 30000,
		lowAccuracyThreshold: 30
	},
	ui: {
		toastMs: 3200,
		confirmMs: 3000,
		coordDecimals: 6
	},
	export: {
		app: 'last-mile',
		version: 1
	}
}

/* ---------- db ---------- */

let dbInstance = null

function openDb() {
	return new Promise((resolve, reject) => {
		if (dbInstance) return resolve(dbInstance)
		const req = indexedDB.open(CONFIG.db.name, CONFIG.db.version)
		req.onupgradeneeded = () => {
			const db = req.result
			// Runs on fresh installs and on the v1 -> v2 upgrade; existing 'addresses' data survives
			if (!db.objectStoreNames.contains(CONFIG.db.store)) {
				db.createObjectStore(CONFIG.db.store, { keyPath: 'id' })
			}
			if (!db.objectStoreNames.contains(CONFIG.db.placesStore)) {
				const places = db.createObjectStore(CONFIG.db.placesStore, { keyPath: 'id' })
				places.createIndex(CONFIG.db.placesTownIndex, 'town', { unique: false })
			}
			// v2 -> v3: holds the single offline basemap blob + its metadata
			if (!db.objectStoreNames.contains(CONFIG.db.basemapStore)) {
				db.createObjectStore(CONFIG.db.basemapStore, { keyPath: 'id' })
			}
		}
		req.onsuccess = () => {
			dbInstance = req.result
			resolve(dbInstance)
		}
		req.onerror = () => reject(req.error)
	})
}

function dbStore(storeName, mode) {
	return openDb().then(db => db.transaction(storeName, mode).objectStore(storeName))
}

function dbGetAll(storeName) {
	return dbStore(storeName, 'readonly').then(
		store =>
			new Promise((resolve, reject) => {
				const req = store.getAll()
				req.onsuccess = () => resolve(req.result || [])
				req.onerror = () => reject(req.error)
			})
	)
}

function dbGet(storeName, id) {
	return dbStore(storeName, 'readonly').then(
		store =>
			new Promise((resolve, reject) => {
				const req = store.get(id)
				req.onsuccess = () => resolve(req.result || null)
				req.onerror = () => reject(req.error)
			})
	)
}

function dbPut(storeName, record) {
	return dbStore(storeName, 'readwrite').then(
		store =>
			new Promise((resolve, reject) => {
				const req = store.put(record)
				req.onsuccess = () => resolve(record)
				req.onerror = () => reject(req.error)
			})
	)
}

function dbDelete(storeName, id) {
	return dbStore(storeName, 'readwrite').then(
		store =>
			new Promise((resolve, reject) => {
				const req = store.delete(id)
				req.onsuccess = () => resolve()
				req.onerror = () => reject(req.error)
			})
	)
}

function dbBulkPut(storeName, records) {
	// One transaction for all puts -- thousands of individual transactions would be too slow
	return openDb().then(
		db =>
			new Promise((resolve, reject) => {
				const tx = db.transaction(storeName, 'readwrite')
				const store = tx.objectStore(storeName)
				records.forEach(record => store.put(record))
				tx.oncomplete = () => resolve(records.length)
				tx.onerror = () => reject(tx.error)
				tx.onabort = () => reject(tx.error)
			})
	)
}

function dbGetAllByTown(town) {
	return dbStore(CONFIG.db.placesStore, 'readonly').then(
		store =>
			new Promise((resolve, reject) => {
				const req = store.index(CONFIG.db.placesTownIndex).getAll(town)
				req.onsuccess = () => resolve(req.result || [])
				req.onerror = () => reject(req.error)
			})
	)
}

function dbDeleteByTown(town, keepEdited) {
	return openDb().then(
		db =>
			new Promise((resolve, reject) => {
				const tx = db.transaction(CONFIG.db.placesStore, 'readwrite')
				const index = tx.objectStore(CONFIG.db.placesStore).index(CONFIG.db.placesTownIndex)
				const req = index.openCursor(IDBKeyRange.only(town))
				req.onsuccess = () => {
					const cursor = req.result
					if (cursor) {
						if (!(keepEdited && cursor.value.edited)) cursor.delete()
						cursor.continue()
					}
				}
				tx.oncomplete = () => resolve()
				tx.onerror = () => reject(tx.error)
				tx.onabort = () => reject(tx.error)
			})
	)
}

/* ---------- settings (localStorage) ---------- */

function loadSettings() {
	try {
		const raw = localStorage.getItem(CONFIG.storageKey)
		return normalizeSettings(raw ? JSON.parse(raw) : null)
	} catch (err) {
		return normalizeSettings(null)
	}
}

function saveSettings() {
	try {
		localStorage.setItem(CONFIG.storageKey, JSON.stringify(state.settings))
	} catch (err) {
		console.error(err)
	}
}

function normalizeSettings(parsed) {
	const settings = { ownVisible: true, onboarded: false, towns: {} }
	if (parsed && typeof parsed === 'object') {
		if (parsed.ownVisible === false) settings.ownVisible = false
		if (parsed.onboarded === true) settings.onboarded = true
		if (parsed.towns && typeof parsed.towns === 'object') {
			Object.keys(parsed.towns).forEach(id => {
				const t = parsed.towns[id]
				if (!t || typeof t !== 'object') return
				settings.towns[id] = {
					name: typeof t.name === 'string' ? t.name : id,
					version: Number(t.version) || 1,
					count: Number(t.count) || 0,
					visible: t.visible !== false
				}
			})
		}
	}
	return settings
}

/* ---------- state ---------- */

const state = {
	addresses: [],
	ownHay: new Map(),
	markers: new Map(),
	tempMarker: null,
	tempCoords: null,
	editingId: null,
	editingPlaceId: null,
	placementMode: false,
	locateLayers: null,
	remoteMarker: null,
	searchController: null,
	confirmTimers: new Map(),
	settings: { ownVisible: true, onboarded: false, towns: {} },
	manifest: { towns: [] },
	places: new Map(),
	placeMarkers: new Map(),
	datasetGroup: null,
	canvasRenderer: null,
	dotsTimer: null,
	pendingFocusPlaceId: null,
	zoomHintShown: false,
	lastSearch: null,
	partidaReturn: null,
	baseLayer: null,
	basemapOverlay: null,
	basemapInstalled: false,
	basemapBlob: null,
	basemapMeta: null,
	basemapBusy: false,
	basemapProgress: 0,
	basemapFailed: false
}

/* ---------- dom ---------- */

const el = {
	map: document.getElementById('map'),
	searchInput: document.getElementById('searchInput'),
	searchClear: document.getElementById('searchClear'),
	results: document.getElementById('results'),
	banner: document.getElementById('placementBanner'),
	placementGps: document.getElementById('placementGps'),
	placementCancel: document.getElementById('placementCancel'),
	locateBtn: document.getElementById('locateBtn'),
	addBtn: document.getElementById('addBtn'),
	sheet: document.getElementById('sheet'),
	sheetHandle: document.getElementById('sheetHandle'),
	count: document.getElementById('count'),
	listView: document.getElementById('listView'),
	formView: document.getElementById('formView'),
	settingsView: document.getElementById('settingsView'),
	list: document.getElementById('list'),
	settingsBtn: document.getElementById('settingsBtn'),
	settingsBack: document.getElementById('settingsBack'),
	exportBtn: document.getElementById('exportBtn'),
	importBtn: document.getElementById('importBtn'),
	importInput: document.getElementById('importInput'),
	datosList: document.getElementById('datosList'),
	basemapStatus: document.getElementById('basemapStatus'),
	formTitle: document.getElementById('formTitle'),
	fName: document.getElementById('fName'),
	fAddress: document.getElementById('fAddress'),
	fNotes: document.getElementById('fNotes'),
	fCoords: document.getElementById('fCoords'),
	formCancel: document.getElementById('formCancel'),
	toasts: document.getElementById('toasts'),
	splash: document.getElementById('splash'),
	splashStart: document.getElementById('splashStart'),
	splashShare: document.getElementById('splashShare'),
	onboard: document.getElementById('onboard'),
	onboardSettings: document.getElementById('onboardSettings'),
	onboardDismiss: document.getElementById('onboardDismiss'),
	updatePrompt: document.getElementById('updatePrompt'),
	updatePromptGo: document.getElementById('updatePromptGo'),
	updatePromptDismiss: document.getElementById('updatePromptDismiss')
}

let map = null

/* ---------- ui helpers ---------- */

function escapeHtml(value) {
	return String(value == null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

function normalize(value) {
	return String(value == null ? '' : value)
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
}

function formatCoords(lat, lng) {
	const d = CONFIG.ui.coordDecimals
	return `${lat.toFixed(d)}, ${lng.toFixed(d)}`
}

function formatDate(iso) {
	try {
		return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
	} catch (err) {
		return iso
	}
}

function toast(message, type) {
	const node = document.createElement('div')
	node.className = `toast${type ? ' toast--' + type : ''}`
	node.textContent = message
	el.toasts.appendChild(node)
	setTimeout(() => {
		node.classList.add('is-out')
		node.addEventListener('animationend', () => node.remove(), { once: true })
	}, CONFIG.ui.toastMs)
}

function isFiniteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value)
}

function toFiniteNumber(value) {
	// Number(null) and Number('') coerce to 0, which would silently accept missing coords as 0,0
	if (value == null || value === '') return NaN
	return Number(value)
}

function generateId() {
	// crypto.randomUUID is only available in secure contexts (HTTPS/localhost)
	if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
	return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/* ---------- geocoding ---------- */

function buildViewbox() {
	if (!map) return ''
	// At low zoom Leaflet bounds can exceed the valid lat/lng range and Nominatim rejects the request
	const b = map.getBounds()
	const clampLng = n => Math.max(-180, Math.min(180, n))
	const clampLat = n => Math.max(-90, Math.min(90, n))
	return [clampLng(b.getWest()), clampLat(b.getNorth()), clampLng(b.getEast()), clampLat(b.getSouth())]
		.map(n => n.toFixed(6))
		.join(',')
}

function searchRemote(query, signal) {
	const params = new URLSearchParams({
		format: 'jsonv2',
		q: query,
		limit: String(CONFIG.search.remoteLimit),
		addressdetails: '1',
		'accept-language': CONFIG.search.language,
		viewbox: buildViewbox(),
		bounded: '0'
	})
	return fetch(`${CONFIG.search.nominatimSearch}?${params.toString()}`, { signal, headers: { Accept: 'application/json' } })
		.then(res => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			return res.json()
		})
		.then(rows =>
			(rows || [])
				.map(row => ({
					name: row.name || (row.display_name || '').split(',')[0],
					sub: row.display_name || '',
					lat: parseFloat(row.lat),
					lng: parseFloat(row.lon)
				}))
				.filter(row => isFiniteNumber(row.lat) && isFiniteNumber(row.lng))
		)
}

function reverseGeocode(lat, lng) {
	const params = new URLSearchParams({
		format: 'jsonv2',
		lat: String(lat),
		lon: String(lng),
		'accept-language': CONFIG.search.language
	})
	return fetch(`${CONFIG.search.nominatimReverse}?${params.toString()}`, { headers: { Accept: 'application/json' } })
		.then(res => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			return res.json()
		})
		.then(data => (data && data.display_name) || '')
		.catch(() => '')
}

/* ---------- map ---------- */

function pinIcon() {
	return L.divIcon({
		className: 'pin',
		html:
			'<svg viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg">' +
			'<path d="M15 1C7.8 1 2 6.6 2 13.5 2 23 15 39 15 39s13-16 13-25.5C28 6.6 22.2 1 15 1z" ' +
			'fill="#e8500a" stroke="#1a1714" stroke-width="2"/>' +
			'<circle cx="15" cy="13.5" r="5" fill="#1a1714"/></svg>',
		iconSize: [30, 40],
		iconAnchor: [15, 39],
		popupAnchor: [0, -36]
	})
}

function tempIcon() {
	return L.divIcon({
		className: 'pin',
		html:
			'<svg viewBox="0 0 30 40" xmlns="http://www.w3.org/2000/svg">' +
			'<path d="M15 1C7.8 1 2 6.6 2 13.5 2 23 15 39 15 39s13-16 13-25.5C28 6.6 22.2 1 15 1z" ' +
			'fill="#1a1714" stroke="#e8500a" stroke-width="2"/>' +
			'<circle cx="15" cy="13.5" r="5" fill="#e8500a"/></svg>',
		iconSize: [30, 40],
		iconAnchor: [15, 39],
		popupAnchor: [0, -36]
	})
}

function initMap() {
	map = L.map(el.map, { zoomControl: true, attributionControl: true }).setView(CONFIG.map.center, CONFIG.map.zoom)
	// The offline vector layer sits UNDERNEATH the raster (z150 < tilePane z200) and below the dataset
	// dots / markers (overlayPane z400+). Online, opaque raster tiles cover it completely -> ordinary
	// OSM look with no seam. Offline, failed raster tiles are transparent and the vector shows through.
	map.createPane('basemapVector')
	map.getPane('basemapVector').style.zIndex = 150
	// The OSM raster is ALWAYS on top as the base map
	state.baseLayer = osmRasterLayer().addTo(map)
	map.on('click', onMapClick)
	map.on('moveend zoomend', scheduleRenderDots)
}

/* ---------- base map: offline vector (bottom, when installed) + OSM raster (top, always) ---------- */

// 1x1 transparent PNG -- a failed raster tile paints nothing, so the vector below shows through
const TRANSPARENT_TILE =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function osmRasterLayer() {
	return L.tileLayer(CONFIG.map.tileUrl, {
		maxZoom: CONFIG.map.maxZoom,
		attribution: CONFIG.map.attribution,
		// Keep failed tiles transparent (never an opaque gray placeholder) so the vector below is visible
		errorTileUrl: TRANSPARENT_TILE
	})
}

function addBasemapOverlay(blob) {
	// Add the comarca vector layer beneath the raster (static stack, no connectivity switching)
	return createOfflineBasemapLayer(blob).then(layer => {
		if (!layer) return false
		removeBasemapOverlay()
		state.basemapOverlay = layer
		layer.addTo(map)
		return true
	})
}

function removeBasemapOverlay() {
	if (state.basemapOverlay) {
		map.removeLayer(state.basemapOverlay)
		state.basemapOverlay = null
	}
}

function pmtilesReaderClass() {
	// protomaps-leaflet (v5) bundles the pmtiles reader but does not export the class. Reach it via
	// a throwaway PmtilesSource whose internal .p is a PMTiles instance (verified against the vendor
	// build). The placeholder never fetches -- the reader is inert until a tile is requested.
	try {
		const probe = new protomapsL.PmtilesSource('_placeholder', true)
		return probe.p && probe.p.constructor
	} catch (err) {
		return null
	}
}

function blobPmtilesSource(blob) {
	// pmtiles Source interface: getKey() + getBytes(offset, length) -> { data: ArrayBuffer }.
	// Reads bytes straight out of the local Blob -- no network, works fully offline.
	return {
		getKey: () => CONFIG.basemap.url,
		getBytes: (offset, length) =>
			blob
				.slice(offset, offset + length)
				.arrayBuffer()
				.then(data => ({ data }))
	}
}

function boundsFromHeader(h) {
	// pmtiles v3 header carries the archive bbox; fall back to the configured comarca bbox
	if (h && isFiniteNumber(h.minLat) && isFiniteNumber(h.minLon) && isFiniteNumber(h.maxLat) && isFiniteNumber(h.maxLon)) {
		return L.latLngBounds([h.minLat, h.minLon], [h.maxLat, h.maxLon])
	}
	return L.latLngBounds(CONFIG.basemap.bounds)
}

function createOfflineBasemapLayer(blob) {
	// Async: reads the archive header to clamp the layer to the comarca bbox so it never requests or
	// paints tiles outside the comarca. Resolves null on any failure (the raster base still stands).
	if (typeof protomapsL === 'undefined' || !protomapsL.leafletLayer || !blob) return Promise.resolve(null)
	let archive
	try {
		const PMTiles = pmtilesReaderClass()
		if (!PMTiles) return Promise.resolve(null)
		archive = new PMTiles(blobPmtilesSource(blob))
	} catch (err) {
		console.error('offline basemap reader failed', err)
		return Promise.resolve(null)
	}
	return archive
		.getHeader()
		.then(header => {
			// url accepts a PMTiles instance directly (non-string branch of leafletLayer); maxDataZoom
			// caps the vector data at z15 and Leaflet overzooms it so z16-18 still render
			const layer = protomapsL.leafletLayer({
				url: archive,
				pane: 'basemapVector',
				bounds: boundsFromHeader(header),
				attribution: CONFIG.basemap.attribution,
				flavor: CONFIG.basemap.flavor,
				lang: CONFIG.basemap.lang,
				maxDataZoom: CONFIG.basemap.maxDataZoom,
				minZoom: CONFIG.basemap.minZoom,
				maxZoom: CONFIG.basemap.maxZoom
			})
			// The flavor sets an opaque gray tile background; clear it so partial edge tiles and gaps
			// let the raster world show through instead of hiding it
			layer.backgroundColor = undefined
			return layer
		})
		.catch(err => {
			console.error('offline basemap layer failed', err)
			return null
		})
}

/* ---------- offline basemap: rides along with town downloads, invisible to the driver ---------- */

function basemapSource() {
	// Manifest may later declare the basemap (url/version/size); fall back to the CONFIG defaults
	const m = state.manifest && state.manifest.basemap ? state.manifest.basemap : null
	return {
		url: (m && m.file ? CONFIG.dataset.fileBase + m.file : CONFIG.basemap.url),
		version: Number((m && m.version) || CONFIG.basemap.version),
		size: Number((m && m.size) || 0)
	}
}

function hasAnyTown() {
	return Object.keys(state.settings.towns).length > 0
}

function basemapNeeded() {
	// Needs a fetch when missing, or when the installed copy is older than the declared version
	if (!hasAnyTown()) return false
	const src = basemapSource()
	if (!state.basemapInstalled) return true
	return Number(state.basemapMeta && state.basemapMeta.version) < src.version
}

function loadBasemapState() {
	// Read the stored blob (if any) at boot and add the offline vector overlay on top of the raster
	return dbGet(CONFIG.db.basemapStore, CONFIG.basemap.id)
		.then(rec => {
			if (rec && rec.blob && rec.size) {
				state.basemapInstalled = true
				state.basemapBlob = rec.blob
				state.basemapMeta = { size: rec.size, installedAt: rec.installedAt, version: rec.version || 1 }
				if (map) addBasemapOverlay(rec.blob)
			} else {
				state.basemapInstalled = false
			}
		})
		.catch(() => {})
		.then(renderBasemapStatus)
}

function ensureBasemap() {
	// Deduped, non-blocking. Fetches the basemap only when a town is installed and it is missing/outdated.
	if (state.basemapBusy) return Promise.resolve(false)
	if (!basemapNeeded()) return Promise.resolve(false)
	if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false)
	return fetchAndStoreBasemap(basemapSource())
}

function fetchAndStoreBasemap(src) {
	state.basemapBusy = true
	state.basemapFailed = false
	state.basemapProgress = 0
	renderBasemapStatus()
	return fetch(src.url, { cache: 'no-store' })
		.then(res => {
			if (!res.ok) throw new Error('HTTP ' + res.status)
			const total = Number(res.headers.get('Content-Length')) || 0
			if (!res.body || !res.body.getReader) {
				// No streaming support: fall back to a plain blob() (no progress %)
				return res.blob().then(blob => ({ blob, total }))
			}
			const reader = res.body.getReader()
			const chunks = []
			let received = 0
			const pump = () =>
				reader.read().then(({ done, value }) => {
					if (done) return
					chunks.push(value)
					received += value.length
					if (total) {
						state.basemapProgress = received / total
						renderBasemapStatus()
					}
					return pump()
				})
			return pump().then(() => ({ blob: new Blob(chunks, { type: 'application/octet-stream' }), total, received }))
		})
		.then(({ blob, total, received }) => {
			// Never mark a truncated download installed: require the full Content-Length (or, when the
			// server sends none, at least ~the expected size)
			const got = received != null ? received : blob.size
			const target = total || CONFIG.basemap.expectedBytes
			if (got < Math.floor(target * 0.98)) throw new Error('incomplete-download')
			const record = {
				id: CONFIG.basemap.id,
				blob,
				size: blob.size,
				version: src.version,
				installedAt: new Date().toISOString()
			}
			return dbPut(CONFIG.db.basemapStore, record).then(() => record)
		})
		.then(record => {
			state.basemapBusy = false
			state.basemapInstalled = true
			state.basemapBlob = record.blob
			state.basemapMeta = { size: record.size, installedAt: record.installedAt, version: record.version }
			addBasemapOverlay(record.blob)
			renderBasemapStatus()
			// Refresh the towns list so the "Actualizar todo" control (driven by basemapNeeded) updates
			renderDatos()
			return true
		})
		.catch(err => {
			// Town data is the core value and already succeeded; the basemap is enhancement. Keep the
			// app fully usable, remember the failure, and let the next town op / boot retry silently.
			state.basemapBusy = false
			state.basemapFailed = true
			console.error('basemap download failed', err)
			if (err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err && err.message)))) {
				toast('No hay espacio para el mapa sin conexión; se reintentará al liberar espacio', 'warn')
			} else {
				toast('El mapa sin conexión se descargará más tarde', 'warn')
			}
			renderBasemapStatus()
			renderDatos()
			return false
		})
}

function deleteBasemapBlob() {
	return dbDelete(CONFIG.db.basemapStore, CONFIG.basemap.id)
		.then(() => {
			state.basemapInstalled = false
			state.basemapBlob = null
			state.basemapMeta = null
			// Remove the overlay only; the raster base stays exactly as it was
			if (map) removeBasemapOverlay()
			renderBasemapStatus()
		})
		.catch(err => console.error('basemap delete failed', err))
}

function basemapStatusText() {
	// Only actionable states surface; installed/idle stays silent (a driver gets no value from it)
	if (state.basemapBusy) return `Mapa sin conexión: descargando… ${Math.round((state.basemapProgress || 0) * 100)}%`
	if (state.basemapFailed) return 'Mapa sin conexión: se descargará más tarde'
	return ''
}

function renderBasemapStatus() {
	if (!el.basemapStatus) return
	const text = basemapStatusText()
	el.basemapStatus.textContent = text
	el.basemapStatus.hidden = !text
}

function savedPopupHtml(record) {
	const addr = record.address ? `<p class="popup__addr">${escapeHtml(record.address)}</p>` : ''
	const notes = record.notes ? `<p class="popup__notes">${escapeHtml(record.notes)}</p>` : ''
	return (
		`<div class="popup" data-id="${escapeHtml(record.id)}">` +
		`<p class="popup__name">${escapeHtml(record.name)}</p>` +
		addr +
		notes +
		'<div class="popup__actions">' +
		'<button type="button" class="btn btn--sm" data-act="route">Ruta</button>' +
		'<button type="button" class="btn btn--sm" data-act="edit">Editar</button>' +
		'<button type="button" class="btn btn--sm btn--danger" data-act="delete">Borrar</button>' +
		'</div></div>'
	)
}

function addMarker(record) {
	const marker = L.marker([record.lat, record.lng], { icon: pinIcon() }).addTo(map)
	marker.bindPopup(savedPopupHtml(record))
	marker.on('popupopen', ev => bindSavedPopup(ev.popup, record))
	state.markers.set(record.id, marker)
}

function bindSavedPopup(popup, record) {
	const root = popup.getElement()
	if (!root) return
	root.querySelectorAll('[data-act]').forEach(btn =>
		btn.addEventListener('click', () => {
			const act = btn.getAttribute('data-act')
			if (act === 'route') openRoute(record)
			else if (act === 'edit') {
				map.closePopup()
				startEdit(record.id)
			} else if (act === 'delete') {
				confirmDelete(btn, record.id)
			}
		})
	)
}

function rebuildMarkers() {
	state.markers.forEach(marker => map.removeLayer(marker))
	state.markers.clear()
	if (!state.settings.ownVisible) return
	state.addresses.forEach(addMarker)
}

function clearTempMarker() {
	if (state.tempMarker) {
		map.removeLayer(state.tempMarker)
		state.tempMarker = null
	}
	state.tempCoords = null
}

function clearRemoteMarker() {
	if (state.remoteMarker) {
		map.removeLayer(state.remoteMarker)
		state.remoteMarker = null
	}
}

function setTempMarker(lat, lng) {
	clearTempMarker()
	state.tempCoords = { lat, lng }
	state.tempMarker = L.marker([lat, lng], { icon: tempIcon(), draggable: true }).addTo(map)
	state.tempMarker.on('drag', ev => {
		const p = ev.target.getLatLng()
		state.tempCoords = { lat: p.lat, lng: p.lng }
		el.fCoords.textContent = formatCoords(p.lat, p.lng)
	})
	el.fCoords.textContent = formatCoords(lat, lng)
}

/* ---------- geolocation ---------- */

function locateUser(onSuccess) {
	if (!window.isSecureContext) {
		toast('La ubicación requiere HTTPS. Toca el mapa para fijar el punto.', 'warn')
		return
	}
	if (!navigator.geolocation) {
		toast('Geolocalización no disponible en este navegador.', 'error')
		return
	}
	el.locateBtn.classList.add('is-loading')
	navigator.geolocation.getCurrentPosition(
		pos => {
			el.locateBtn.classList.remove('is-loading')
			const { latitude, longitude, accuracy } = pos.coords
			showGpsDot(latitude, longitude, accuracy)
			map.setView([latitude, longitude], CONFIG.map.locateZoom)
			if (accuracy > CONFIG.geo.lowAccuracyThreshold) {
				toast(`Precisión baja: ±${Math.round(accuracy)}m — ajusta el punto arrastrando el marcador`, 'warn')
			}
			if (onSuccess) onSuccess(latitude, longitude)
		},
		err => {
			el.locateBtn.classList.remove('is-loading')
			handleGeoError(err)
		},
		{
			enableHighAccuracy: CONFIG.geo.enableHighAccuracy,
			timeout: CONFIG.geo.timeout,
			maximumAge: CONFIG.geo.maximumAge
		}
	)
}

function handleGeoError(err) {
	if (err.code === err.PERMISSION_DENIED) {
		toast('Permiso de ubicación denegado. Actívalo en los ajustes del navegador o toca el mapa para fijar el punto.', 'error')
	} else if (err.code === err.POSITION_UNAVAILABLE) {
		toast('Ubicación no disponible. Toca el mapa para fijar el punto.', 'error')
	} else if (err.code === err.TIMEOUT) {
		toast('Se agotó el tiempo de ubicación. Inténtalo de nuevo o toca el mapa.', 'error')
	} else {
		toast('No se pudo obtener la ubicación.', 'error')
	}
}

function showGpsDot(lat, lng, accuracy) {
	if (state.locateLayers) {
		map.removeLayer(state.locateLayers.dot)
		map.removeLayer(state.locateLayers.circle)
	}
	const dot = L.marker([lat, lng], {
		icon: L.divIcon({ className: 'gps-dot-wrap', html: '<div class="gps-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
		interactive: false,
		keyboard: false
	}).addTo(map)
	const circle = L.circle([lat, lng], {
		radius: accuracy,
		color: '#1a73e8',
		weight: 1,
		fillColor: '#1a73e8',
		fillOpacity: 0.12
	}).addTo(map)
	state.locateLayers = { dot, circle }
}

/* ---------- search ---------- */

let searchTimer = null

function tokenize(query) {
	return normalize(query)
		.split(/\s+/)
		.filter(Boolean)
}

function haystackMatches(haystack, tokens) {
	// Every token must appear somewhere in the haystack (order-independent)
	return tokens.every(token => haystack.indexOf(token) !== -1)
}

function rebuildOwnHaystacks() {
	state.ownHay.clear()
	state.addresses.forEach(a => {
		state.ownHay.set(a.id, normalize(`${a.name} ${a.address || ''} ${a.notes || ''}`))
	})
}

function localMatches(query) {
	const tokens = tokenize(query)
	if (!tokens.length) return []
	return state.addresses
		.filter(a => haystackMatches(state.ownHay.get(a.id) || '', tokens))
		.slice(0, CONFIG.search.localLimit)
}

function parseQuery(query) {
	// Split a trailing pure-number token off as a num filter: 'cachap 10' -> name 'cachap', num '10'.
	// The num is matched by prefix on the place number (10 -> 10, 100, 1000), so non-numeric
	// numbers such as 'S/N' never match a numeric filter.
	const tokens = tokenize(query)
	let numFilter = ''
	if (tokens.length && /^\d+$/.test(tokens[tokens.length - 1])) {
		numFilter = tokens.pop()
	}
	return { nameTokens: tokens, numFilter }
}

function numMatchesPrefix(num, prefix) {
	return String(num == null ? '' : num).startsWith(prefix)
}

function collectGroups(nameTokens, numFilter) {
	const byKey = new Map()
	const groups = []
	activeTowns().forEach(town => {
		const places = state.places.get(town) || []
		for (let i = 0; i < places.length; i++) {
			const place = places[i]
			if (nameTokens.length && !haystackMatches(place.hay, nameTokens)) continue
			if (numFilter && !numMatchesPrefix(place.num, numFilter)) continue
			const key = town + '\n' + place.partida
			let group = byKey.get(key)
			if (!group) {
				group = { town, partida: place.partida, places: [], numFilter }
				byKey.set(key, group)
				groups.push(group)
			}
			group.places.push(place)
		}
	})
	return groups
}

function datasetGroupMatches(query) {
	const { nameTokens, numFilter } = parseQuery(query)
	if (!nameTokens.length && !numFilter) return []
	let groups = collectGroups(nameTokens, numFilter)
	if (!groups.length && numFilter) {
		// The trailing number was not a house number (nothing matched by prefix). Retry with the
		// whole query as free text so a cadastral ref like '2251500' or 'callosilla 22' still lands.
		groups = collectGroups(tokenize(query), '')
	}
	// Exact normalized-partida match first, then most matches, then alphabetical
	const exact = normalize(nameTokens.join(' '))
	groups.sort(
		(a, b) =>
			(normalize(b.partida) === exact) - (normalize(a.partida) === exact) ||
			b.places.length - a.places.length ||
			a.partida.localeCompare(b.partida, 'es')
	)
	return groups.slice(0, CONFIG.dataset.resultLimit)
}

function onSearchInput() {
	const query = el.searchInput.value.trim()
	el.searchClear.hidden = query.length === 0
	if (searchTimer) clearTimeout(searchTimer)
	if (state.searchController) {
		state.searchController.abort()
		state.searchController = null
	}
	if (!query) {
		showPartidaBrowser()
		return
	}
	renderResults(localMatches(query), datasetGroupMatches(query), null)
	if (query.length >= CONFIG.search.minQueryLength) {
		searchTimer = setTimeout(() => runRemoteSearch(query), CONFIG.search.debounceMs)
	}
}

function runRemoteSearch(query) {
	const controller = new AbortController()
	state.searchController = controller
	searchRemote(query, controller.signal)
		.then(remote => {
			if (controller.signal.aborted) return
			renderResults(localMatches(query), datasetGroupMatches(query), remote)
		})
		.catch(err => {
			if (err.name === 'AbortError') return
			renderResults(localMatches(query), datasetGroupMatches(query), 'offline')
		})
}

function renderResults(local, groups, remote) {
	// Keep the raw inputs so back-navigation from a partida drill-down can rebuild this exact list
	state.lastSearch = { local, groups, remote }
	const parts = []
	local.forEach(a => {
		parts.push(resultRow('saved', a.id, a.name, a.address || formatCoords(a.lat, a.lng), a.lat, a.lng, 'Guardada'))
	})
	;(groups || []).forEach((group, index) => {
		if (group.places.length === 1) {
			// A single matching place is a direct hit -- no need to make the driver drill down
			const place = group.places[0]
			parts.push(resultRow('place', place.id, place.name, placeSubtitle(place), place.lat, place.lng, townLabel(place.town)))
		} else {
			parts.push(partidaRow(group, index))
		}
	})
	if (Array.isArray(remote)) {
		remote.forEach((r, i) => {
			parts.push(resultRow('map', String(i), r.name, r.sub, r.lat, r.lng, 'Mapa'))
		})
	}
	if (remote === 'offline') {
		parts.push('<div class="result result--muted">Sin conexión con el mapa</div>')
	}
	if (parts.length === 0) {
		parts.push('<div class="result result--muted">Sin resultados</div>')
	}
	el.results.innerHTML = parts.join('')
	el.results.hidden = false
	el.results.querySelectorAll('.result[data-kind]').forEach(node =>
		node.addEventListener('click', () => onResultClick(node))
	)
	el.results.querySelectorAll('[data-group]').forEach(node =>
		node.addEventListener('click', () => drillIntoPartida(groups[Number(node.getAttribute('data-group'))], renderLastSearch))
	)
}

function renderLastSearch() {
	const last = state.lastSearch
	if (last) renderResults(last.local, last.groups, last.remote)
}

function resultRow(kind, ref, name, sub, lat, lng, badgeText) {
	let badge = `<span class="badge">${escapeHtml(badgeText)}</span>`
	if (kind === 'saved') badge = `<span class="badge badge--saved">${escapeHtml(badgeText)}</span>`
	else if (kind === 'place') badge = `<span class="badge badge--town">${escapeHtml(badgeText)}</span>`
	return (
		`<button type="button" class="result" data-kind="${kind}" data-ref="${escapeHtml(ref)}" ` +
		`data-lat="${lat}" data-lng="${lng}" data-name="${escapeHtml(name)}" data-sub="${escapeHtml(sub)}">` +
		'<div class="result__main">' +
		`<div class="result__name">${escapeHtml(name)}</div>` +
		`<div class="result__sub">${escapeHtml(sub)}</div>` +
		'</div>' +
		badge +
		'</button>'
	)
}

function onResultClick(node) {
	const kind = node.getAttribute('data-kind')
	const lat = parseFloat(node.getAttribute('data-lat'))
	const lng = parseFloat(node.getAttribute('data-lng'))
	hideResults()
	clearSearch()
	if (kind === 'saved') {
		focusAddress(node.getAttribute('data-ref'))
	} else if (kind === 'place') {
		const place = findPlaceById(node.getAttribute('data-ref'))
		if (place) focusPlace(place)
	} else {
		showRemoteMarker(lat, lng, node.getAttribute('data-name'), node.getAttribute('data-sub'))
	}
}

function showRemoteMarker(lat, lng, name, sub) {
	clearRemoteMarker()
	map.setView([lat, lng], CONFIG.map.focusZoom)
	const marker = L.marker([lat, lng], { icon: tempIcon() }).addTo(map)
	const html =
		`<div class="popup"><p class="popup__name">${escapeHtml(name)}</p>` +
		`<p class="popup__addr">${escapeHtml(sub)}</p>` +
		'<div class="popup__actions">' +
		'<button type="button" class="btn btn--sm btn--primary" data-act="save">Guardar aquí</button>' +
		'</div></div>'
	marker.bindPopup(html).addTo(map)
	marker.on('popupopen', ev => {
		const root = ev.popup.getElement()
		if (!root) return
		const btn = root.querySelector('[data-act="save"]')
		if (btn)
			btn.addEventListener('click', () => {
				map.closePopup()
				clearRemoteMarker()
				enterPlacementFromRemote(lat, lng, name, sub)
			})
	})
	state.remoteMarker = marker
	marker.openPopup()
}

function hideResults() {
	el.results.hidden = true
	el.results.innerHTML = ''
}

function clearSearch() {
	el.searchInput.value = ''
	el.searchClear.hidden = true
}

/* ---------- partida browser (empty-query drill-down) ---------- */

function partidaGroups() {
	const groups = []
	activeTowns().forEach(town => {
		const byPartida = new Map()
		;(state.places.get(town) || []).forEach(place => {
			const list = byPartida.get(place.partida)
			if (list) list.push(place)
			else byPartida.set(place.partida, [place])
		})
		Array.from(byPartida.keys())
			.sort((a, b) => a.localeCompare(b, 'es'))
			.forEach(partida => groups.push({ town, partida, places: byPartida.get(partida) }))
	})
	return groups
}

function addressCountLabel(count) {
	return count === 1 ? '1 dirección' : `${count} direcciones`
}

function compareNum(a, b) {
	// Numeric-leading numbers first (natural order), non-numeric ones (e.g. 'S/N') grouped at the end
	const na = String(a == null ? '' : a)
	const nb = String(b == null ? '' : b)
	const da = /^\d/.test(na)
	const db = /^\d/.test(nb)
	if (da !== db) return da ? -1 : 1
	return na.localeCompare(nb, 'es', { numeric: true })
}

function isSinNumero(num) {
	// Anything without a leading digit (S/N and friends) has no house number -- same rule as compareNum
	return !/^\d/.test(String(num == null ? '' : num))
}

function parcelCompact(ref) {
	// Squeeze a cadastral ref into a scannable chip label.
	//  - rural 'Políg. 20 · Parc. 295' -> '20-295'
	//  - urban 'Ref. 2251560' -> '2251560' (label dropped, identifier kept intact, letters and all)
	const s = String(ref == null ? '' : ref).trim()
	if (!s) return ''
	if (/pol[ií]g/i.test(s) && /parc/i.test(s)) {
		const nums = s.match(/\d+/g)
		if (nums && nums.length >= 2) return nums.slice(0, 2).join('-')
	}
	return s.replace(/^\s*ref\.?\s*/i, '').trim() || s
}

function numChipHtml(place) {
	const num = String(place.num == null ? '' : place.num)
	const ref = place.ref ? String(place.ref) : ''
	if (isSinNumero(num) && ref) {
		// Parcel pair on the chip, full ref on hover/long-press so the identifier is never lost
		const label = parcelCompact(ref) || num
		return (
			`<button type="button" class="numchip numchip--ref" data-place="${escapeHtml(place.id)}" ` +
			`title="${escapeHtml(ref)}">${escapeHtml(label)}</button>`
		)
	}
	return `<button type="button" class="numchip" data-place="${escapeHtml(place.id)}">${escapeHtml(num)}</button>`
}

function partidaRow(group, index) {
	return (
		`<button type="button" class="result" data-group="${index}">` +
		'<div class="result__main">' +
		`<div class="result__name">${escapeHtml(group.partida)}</div>` +
		`<div class="result__sub">${addressCountLabel(group.places.length)}</div>` +
		'</div>' +
		`<span class="badge badge--town">${escapeHtml(townLabel(group.town))}</span>` +
		'</button>'
	)
}

function drillIntoPartida(group, backRender) {
	// Remember how to rebuild the list we came from, and where it was scrolled, so back restores both
	state.partidaReturn = { render: backRender, scrollTop: el.results.scrollTop }
	showPartidaNumbers(group)
}

function showPartidaBrowser() {
	const groups = partidaGroups()
	if (groups.length === 0) {
		hideResults()
		return
	}
	const parts = ['<div class="result result--muted">Elige una partida</div>']
	groups.forEach((group, index) => parts.push(partidaRow(group, index)))
	el.results.innerHTML = parts.join('')
	el.results.hidden = false
	el.results.querySelectorAll('[data-group]').forEach(node =>
		node.addEventListener('click', () => drillIntoPartida(groups[Number(node.getAttribute('data-group'))], showPartidaBrowser))
	)
}

function showPartidaNumbers(group) {
	const places = group.places.slice().sort((a, b) => compareNum(a.num, b.num))
	// Numbered chips first; every S/N place then shows its distinguishing cadastral ref (compact)
	// under a full-width "Sin número" heading so the ref chips read in context
	const numbered = places.filter(p => !isSinNumero(p.num))
	const sinNumero = places
		.filter(p => isSinNumero(p.num))
		.sort((a, b) => parcelCompact(a.ref).localeCompare(parcelCompact(b.ref), 'es', { numeric: true }))
	const chipsFor = list => `<div class="results__nums">${list.map(numChipHtml).join('')}</div>`
	let body = ''
	if (numbered.length) body += chipsFor(numbered)
	if (sinNumero.length) {
		body += '<div class="results__numshead">Sin número</div>'
		body += chipsFor(sinNumero)
	}
	el.results.innerHTML =
		'<button type="button" class="result" data-back>' +
		'<div class="result__main">' +
		`<div class="result__name">‹ ${escapeHtml(group.partida)}</div>` +
		`<div class="result__sub">${addressCountLabel(places.length)}</div>` +
		'</div>' +
		`<span class="badge badge--town">${escapeHtml(townLabel(group.town))}</span>` +
		'</button>' +
		body
	el.results.hidden = false
	el.results.scrollTop = 0
	el.results.querySelector('[data-back]').addEventListener('click', () => {
		const ret = state.partidaReturn
		state.partidaReturn = null
		if (ret && ret.render) {
			ret.render()
			el.results.scrollTop = ret.scrollTop
		} else {
			showPartidaBrowser()
		}
	})
	el.results.querySelectorAll('[data-place]').forEach(node =>
		node.addEventListener('click', () => {
			const place = findPlaceById(node.getAttribute('data-place'))
			hideResults()
			clearSearch()
			el.searchInput.blur()
			state.partidaReturn = null
			if (place) focusPlace(place)
		})
	)
}

/* ---------- datasets (official points) ---------- */

function townLabel(townId) {
	const stored = state.settings.towns[townId]
	if (stored && stored.name) return stored.name
	const entry = state.manifest.towns.find(t => t.id === townId)
	return (entry && entry.name) || townId
}

function activeTowns() {
	// A town contributes to map + search only when downloaded (in memory) and toggled visible
	return Object.keys(state.settings.towns).filter(id => state.settings.towns[id].visible && state.places.has(id))
}

function findPlaceById(id) {
	for (const places of state.places.values()) {
		const found = places.find(p => p.id === id)
		if (found) return found
	}
	return null
}

function placeSubtitle(place) {
	// A user-set address wins; otherwise show the cadastral ref (the real-world id for S/N places).
	// A refless S/N point still reads as "Casa sin número" so it is never a cryptic bare 'S/N'.
	// Zones carry their own type word, so no 'Partida' prefix.
	if (place.address) return place.address
	if (place.ref) return String(place.ref)
	if (isSinNumero(place.num)) return `Casa sin número · ${townLabel(place.town)}`
	return `${townLabel(place.town)} · Catastro`
}

function makeMemPlace(record) {
	return {
		id: record.id,
		town: record.town,
		name: record.name,
		partida: record.partida,
		num: record.num,
		lat: record.lat,
		lng: record.lng,
		address: record.address || '',
		notes: record.notes || '',
		edited: !!record.edited,
		updatedAt: record.updatedAt || null,
		ref: record.ref || '',
		// Include the ref and its compact '20-295' form so a parcel number reaches the place
		hay: normalize(
			`${record.name} ${record.partida} ${record.num} ${record.ref || ''} ${parcelCompact(record.ref)} ` +
			`${record.address || ''} ${record.notes || ''}`
		)
	}
}

function toDbPlace(place) {
	const record = {
		id: place.id,
		town: place.town,
		name: place.name,
		partida: place.partida,
		num: place.num,
		lat: place.lat,
		lng: place.lng
	}
	if (place.ref) record.ref = place.ref
	if (place.address) record.address = place.address
	if (place.notes) record.notes = place.notes
	if (place.edited) {
		record.edited = true
		record.updatedAt = place.updatedAt
	}
	return record
}

function placeDefaultAddress(place) {
	return `${place.partida} ${place.num}, ${townLabel(place.town)}`
}

function formatMiles(n) {
	return new Intl.NumberFormat('es').format(n)
}

function formatCompact(n) {
	if (n < 1000) return String(n)
	return (Math.round(n / 100) / 10).toString().replace('.', ',') + 'k'
}

function ensureDatasetGroup() {
	if (!state.datasetGroup) state.datasetGroup = L.layerGroup().addTo(map)
	return state.datasetGroup
}

function ensureCanvasRenderer() {
	// One shared canvas renderer for thousands of dots -- far cheaper than DOM markers
	if (!state.canvasRenderer) {
		state.canvasRenderer = L.canvas({ padding: 0.3, tolerance: CONFIG.dataset.tapTolerance })
	}
	return state.canvasRenderer
}

function clearDatasetDots(keepOpenPopup) {
	if (!state.datasetGroup) return
	// Popup autopan fires moveend, which re-renders: destroying the tapped marker
	// would instantly close its popup, so keep that one marker alive across renders
	let kept = null
	if (keepOpenPopup) {
		state.placeMarkers.forEach((marker, id) => {
			if (marker.isPopupOpen()) kept = { id, marker }
		})
	}
	state.datasetGroup.eachLayer(layer => {
		if (!kept || layer !== kept.marker) state.datasetGroup.removeLayer(layer)
	})
	state.placeMarkers.clear()
	if (kept) state.placeMarkers.set(kept.id, kept.marker)
}

function refreshDatasetInteractivity() {
	// Rebuild the dots so their `interactive` flag matches the current placement mode
	if (!map) return
	clearDatasetDots(false)
	renderDatasetDots(true)
}

function scheduleRenderDots() {
	if (state.dotsTimer) clearTimeout(state.dotsTimer)
	state.dotsTimer = setTimeout(renderDatasetDots, CONFIG.dataset.debounceMs)
}

function maybeShowZoomHint() {
	if (state.zoomHintShown) return
	state.zoomHintShown = true
	toast('Acércate para ver los puntos oficiales', 'warn')
}

function renderDatasetDots(silentHint) {
	if (!map) return
	const towns = activeTowns()
	if (!towns.length) {
		clearDatasetDots(false)
		return
	}
	if (map.getZoom() < CONFIG.dataset.zoomThreshold) {
		clearDatasetDots(false)
		if (!silentHint) maybeShowZoomHint()
		return
	}
	clearDatasetDots(true)
	ensureDatasetGroup()
	const renderer = ensureCanvasRenderer()
	const bounds = map.getBounds().pad(CONFIG.dataset.boundsPad)
	const dot = CONFIG.dataset.dot
	const cap = CONFIG.dataset.renderCap
	let count = 0
	for (const town of towns) {
		const places = state.places.get(town) || []
		for (let i = 0; i < places.length; i++) {
			const place = places[i]
			if (!bounds.contains([place.lat, place.lng])) continue
			// The marker kept alive by clearDatasetDots (open popup) must not be duplicated
			if (state.placeMarkers.has(place.id)) {
				count++
				continue
			}
			const marker = L.circleMarker([place.lat, place.lng], {
				renderer,
				radius: dot.radius,
				color: dot.color,
				weight: dot.weight,
				fillColor: dot.fillColor,
				fillOpacity: dot.fillOpacity,
				// While placing/editing, dots must not swallow the tap -- it has to reach the map so the
				// point lands where the driver tapped (even right next to an existing dot)
				interactive: !state.placementMode
			})
			marker.bindPopup(placePopupHtml(place))
			marker.on('popupopen', ev => bindPlacePopup(ev.popup, place))
			state.datasetGroup.addLayer(marker)
			state.placeMarkers.set(place.id, marker)
			count++
			if (count >= cap) break
		}
		if (count >= cap) break
	}
	if (state.pendingFocusPlaceId) {
		// One shot: if the target didn't render (render cap), don't pop it open on a later pan
		const marker = state.placeMarkers.get(state.pendingFocusPlaceId)
		state.pendingFocusPlaceId = null
		if (marker) marker.openPopup()
	}
}

function placePopupHtml(place) {
	const notes = place.notes ? `<p class="popup__notes">${escapeHtml(place.notes)}</p>` : ''
	const flag = place.edited ? '<span class="popup__flag">Editado</span>' : ''
	const addrLine = placeSubtitle(place)
	return (
		`<div class="popup" data-id="${escapeHtml(place.id)}">` +
		`<p class="popup__name">${escapeHtml(place.name)}${flag}</p>` +
		`<p class="popup__addr">${escapeHtml(addrLine)}</p>` +
		`<p class="popup__meta">${escapeHtml(formatCoords(place.lat, place.lng))}</p>` +
		notes +
		'<div class="popup__actions">' +
		'<button type="button" class="btn btn--sm" data-act="route">Ruta</button>' +
		'<button type="button" class="btn btn--sm" data-act="share">Compartir</button>' +
		'<button type="button" class="btn btn--sm btn--primary" data-act="edit">Editar</button>' +
		'</div></div>'
	)
}

function bindPlacePopup(popup, place) {
	const root = popup.getElement()
	if (!root) return
	root.querySelectorAll('[data-act]').forEach(btn =>
		btn.addEventListener('click', () => {
			const act = btn.getAttribute('data-act')
			if (act === 'route') openRoute(place)
			else if (act === 'share') shareAddress(place)
			else if (act === 'edit') {
				map.closePopup()
				startEditPlace(place)
			}
		})
	)
}

function focusPlace(place) {
	// Defer to the debounced render (also fired by moveend) so the popup opens on the
	// final view and is not immediately closed by a follow-up re-render
	state.pendingFocusPlaceId = place.id
	map.setView([place.lat, place.lng], CONFIG.map.focusZoom)
	scheduleRenderDots()
	if (!el.sheet.classList.contains('sheet--collapsed')) collapseSheet()
}

function startEditPlace(place) {
	state.placementMode = true
	state.editingId = null
	state.editingPlaceId = place.id
	el.banner.hidden = false
	el.formTitle.textContent = 'Editar punto oficial'
	el.fName.value = place.name
	el.fAddress.value = place.address || placeDefaultAddress(place)
	el.fNotes.value = place.notes || ''
	setTempMarker(place.lat, place.lng)
	showFormView()
	expandSheet()
	refreshDatasetInteractivity()
}

function loadEnabledTowns() {
	const ids = Object.keys(state.settings.towns)
	return Promise.all(
		ids.map(id => dbGetAllByTown(id).then(records => state.places.set(id, records.map(makeMemPlace))))
	)
}

function fetchManifest() {
	return fetch(CONFIG.dataset.indexUrl, { cache: 'no-cache' })
		.then(res => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			return res.json()
		})
		.then(data => {
			state.manifest = data && Array.isArray(data.towns) ? data : { towns: [] }
		})
		.catch(() => {
			// Offline: fall back to already-downloaded towns so the feature keeps working
			state.manifest = {
				towns: Object.keys(state.settings.towns).map(id => ({
					id,
					name: state.settings.towns[id].name,
					file: `${id}.json`,
					version: state.settings.towns[id].version,
					count: state.settings.towns[id].count,
					sourceDate: ''
				}))
			}
		})
}

function importTownData(townId, data) {
	// Replace the town's catalog wholesale so places removed upstream don't linger,
	// but preserve edited records: never overwrite ids the driver has corrected on this device
	return dbGetAllByTown(townId).then(existing => {
		const keptIds = new Set(existing.filter(r => r.edited).map(r => r.id))
		const records = data.places
			.map(p => {
				const r = {
					id: `${townId}/${p.id}`,
					town: townId,
					name: p.name,
					partida: p.partida,
					num: p.num,
					lat: p.lat,
					lng: p.lng
				}
				// Optional cadastral ref (only present on S/N places); omit when absent
				if (p.ref) r.ref = p.ref
				return r
			})
			.filter(r => !keptIds.has(r.id))
		return dbDeleteByTown(townId, true)
			.then(() => dbBulkPut(CONFIG.db.placesStore, records))
			.then(() => dbGetAllByTown(townId))
			.then(all => {
				state.places.set(townId, all.map(makeMemPlace))
				return { kept: keptIds.size }
			})
	})
}

function downloadTown(townId, btn) {
	const entry = state.manifest.towns.find(t => t.id === townId)
	if (!entry) return
	if (btn) {
		btn.disabled = true
		btn.textContent = 'Descargando…'
	}
	fetch(CONFIG.dataset.fileBase + entry.file, { cache: 'no-cache' })
		.then(res => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			return res.json()
		})
		.then(data => importTownData(townId, data).then(() => data))
		.then(data => {
			state.settings.towns[townId] = { name: data.name, version: data.version, count: data.count, visible: true }
			saveSettings()
			toast(`${data.name}: ${formatMiles(data.count)} puntos cargados`, 'ok')
			renderDatos()
			renderDatasetDots()
			// Town first (instant value), then pull the offline basemap silently. Never blocks the town.
			ensureBasemap()
		})
		.catch(err => {
			console.error(err)
			toast('No se pudo descargar la población', 'error')
			renderDatos()
		})
}

function outdatedTowns() {
	// Downloaded towns whose manifest version is newer than what is stored on this device
	return state.manifest.towns
		.filter(t => {
			const stored = state.settings.towns[t.id]
			return stored && Number(t.version) > Number(stored.version)
		})
		.map(t => t.id)
}

function performTownUpdate(townId) {
	// Core update path shared by the per-town button and the "update all" flow.
	// Edited records are preserved inside importTownData; never reimplement that here.
	const entry = state.manifest.towns.find(t => t.id === townId)
	if (!entry) return Promise.reject(new Error('no-manifest-entry'))
	return fetch(CONFIG.dataset.fileBase + entry.file, { cache: 'no-cache' })
		.then(res => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			return res.json()
		})
		.then(data => importTownData(townId, data).then(result => ({ data, kept: result.kept })))
		.then(({ data, kept }) => {
			const stored = state.settings.towns[townId]
			stored.version = data.version
			stored.count = data.count
			stored.name = data.name
			saveSettings()
			return { name: data.name, count: data.count, kept }
		})
}

function updateTown(townId, btn) {
	if (btn) {
		btn.disabled = true
		btn.textContent = 'Actualizando…'
	}
	performTownUpdate(townId)
		.then(({ count, kept }) => {
			const keptText = kept ? `, ${formatMiles(kept)} ediciones conservadas` : ''
			toast(`Actualizado: ${formatMiles(count)} puntos${keptText}`, 'ok')
			renderDatos()
			renderDatasetDots()
			ensureBasemap()
		})
		.catch(err => {
			console.error(err)
			toast('No se pudo actualizar', 'error')
			renderDatos()
		})
}

let updatingAll = false

function updateAllTowns(btn, onDone) {
	if (updatingAll) return
	const ids = outdatedTowns()
	// Nothing to do only when neither town data nor the basemap needs a refresh
	if (!ids.length && !basemapNeeded()) {
		if (onDone) onDone()
		return
	}
	updatingAll = true
	if (btn) btn.disabled = true
	const total = ids.length
	const done = []
	const failed = []
	const finishTowns = () => {
		// After town data, fold in the basemap refresh (missing or outdated) as part of the same action
		const complete = () => finishUpdateAll(done, failed, onDone)
		if (basemapNeeded()) {
			if (btn) btn.textContent = 'Descargando mapa…'
			return ensureBasemap().then(complete, complete)
		}
		return complete()
	}
	const step = i => {
		if (i >= ids.length) return finishTowns()
		const townId = ids[i]
		if (btn) btn.textContent = total ? `Actualizando ${i + 1} de ${total}…` : 'Actualizando…'
		return performTownUpdate(townId)
			.then(({ name }) => done.push(name || townLabel(townId)))
			.catch(err => {
				console.error(err)
				failed.push(townLabel(townId))
			})
			.then(() => step(i + 1))
	}
	step(0)
}

function finishUpdateAll(done, failed, onDone) {
	updatingAll = false
	// Re-render so the "Actualizar todo" button reflects what still needs updating (retry path)
	renderDatos()
	renderDatasetDots()
	if (failed.length && done.length) {
		toast(`Actualizadas ${done.length}, fallaron ${failed.length}: ${failed.join(', ')}`, 'warn')
	} else if (failed.length) {
		toast(`No se pudo actualizar: ${failed.join(', ')}`, 'error')
	} else if (done.length) {
		toast(`${done.length} ${done.length === 1 ? 'zona actualizada' : 'zonas actualizadas'}`, 'ok')
	}
	// A basemap-only run (done/failed empty) reports through its own status line/toast, not here
	if (onDone) onDone()
}

function confirmDeleteTown(btn, townId) {
	const key = `town:${townId}`
	if (btn.dataset.confirming === 'true') {
		clearTimeout(state.confirmTimers.get(key))
		state.confirmTimers.delete(key)
		deleteTown(townId)
		return
	}
	btn.dataset.confirming = 'true'
	const original = btn.textContent
	const editedCount = (state.places.get(townId) || []).filter(p => p.edited).length
	const isLastTown = Object.keys(state.settings.towns).length === 1
	if (editedCount) btn.textContent = `¿Borrar? Incluye ${editedCount} editados`
	else if (isLastTown && state.basemapInstalled) btn.textContent = '¿Borrar? Quita el mapa sin conexión'
	else btn.textContent = '¿Borrar? Confirmar'
	const timer = setTimeout(() => {
		btn.dataset.confirming = 'false'
		btn.textContent = original
		state.confirmTimers.delete(key)
	}, CONFIG.ui.confirmMs)
	state.confirmTimers.set(key, timer)
}

function deleteTown(townId) {
	const name = townLabel(townId)
	dbDeleteByTown(townId)
		.then(() => {
			delete state.settings.towns[townId]
			saveSettings()
			state.places.delete(townId)
			// Deleting the last town frees the shared offline basemap too (no town left to use it)
			if (Object.keys(state.settings.towns).length === 0 && state.basemapInstalled) {
				deleteBasemapBlob()
			}
			renderDatasetDots()
			renderDatos()
			toast(`${name} eliminado`, 'ok')
		})
		.catch(err => {
			console.error(err)
			toast('No se pudo eliminar', 'error')
		})
}

function importPlaceEdits(edits) {
	// Edited place records are self-contained, so they persist even if the town dataset
	// is not downloaded -- they stay dormant until that town is loaded into memory.
	const valid = edits
		.filter(e => {
			if (!e || typeof e.id !== 'string' || typeof e.town !== 'string') return false
			const lat = toFiniteNumber(e.lat)
			const lng = toFiniteNumber(e.lng)
			return isFiniteNumber(lat) && isFiniteNumber(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
		})
		.map(e => ({
			id: e.id,
			town: e.town,
			name: String(e.name || ''),
			partida: String(e.partida || ''),
			num: String(e.num || ''),
			ref: typeof e.ref === 'string' ? e.ref : '',
			lat: Number(e.lat),
			lng: Number(e.lng),
			address: typeof e.address === 'string' ? e.address : '',
			notes: typeof e.notes === 'string' ? e.notes : '',
			edited: true,
			updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date().toISOString()
		}))
	if (!valid.length) return
	dbBulkPut(CONFIG.db.placesStore, valid)
		.then(() => {
			valid.forEach(record => {
				if (!state.places.has(record.town)) return
				const arr = state.places.get(record.town)
				const idx = arr.findIndex(p => p.id === record.id)
				const mem = makeMemPlace(record)
				if (idx >= 0) arr[idx] = mem
				else arr.push(mem)
			})
			renderDatasetDots()
			toast(`Importadas ${valid.length} ediciones`, 'ok')
		})
		.catch(err => {
			console.error(err)
			toast('Error al importar ediciones', 'error')
		})
}

/* ---------- datos settings ui ---------- */

function toggleHtml(act, townId, checked) {
	const townAttr = townId ? ` data-town="${escapeHtml(townId)}"` : ''
	return (
		'<label class="toggle">' +
		`<input type="checkbox" class="toggle__input" data-act="${act}"${townAttr}${checked ? ' checked' : ''}>` +
		'<span class="toggle__track"><span class="toggle__thumb"></span></span>' +
		'</label>'
	)
}

function renderDatos() {
	const rows = []
	rows.push(
		'<div class="datos-row">' +
		'<div class="datos-row__head">' +
		'<div class="datos-row__main">' +
		'<div class="datos-row__name">Mis direcciones</div>' +
		`<div class="datos-row__sub">${formatMiles(state.addresses.length)} guardadas</div>` +
		'</div>' +
		toggleHtml('own-toggle', '', state.settings.ownVisible) +
		'</div></div>'
	)

	const seen = new Set()
	const towns = []
	state.manifest.towns.forEach(t => {
		towns.push(t)
		seen.add(t.id)
	})
	Object.keys(state.settings.towns).forEach(id => {
		if (seen.has(id)) return
		const stored = state.settings.towns[id]
		towns.push({ id, name: stored.name, version: stored.version, count: stored.count })
	})
	// One-tap update: shown when several zones are outdated, or when the offline basemap still
	// needs fetching/refreshing (which has no per-row button of its own)
	if (outdatedTowns().length > 1 || basemapNeeded()) {
		rows.push(
			'<div class="datos-row datos-row--action">' +
			'<button type="button" class="btn btn--primary btn--block" data-act="towns-update-all">Actualizar todo</button>' +
			'</div>'
		)
	}

	towns.forEach(t => rows.push(townRowHtml(t)))

	el.datosList.innerHTML = rows.join('')
	bindDatos()
	renderBasemapStatus()
}

function townRowHtml(town) {
	const stored = state.settings.towns[town.id]
	const downloaded = !!stored
	const sub = `${formatCompact(town.count || 0)} puntos`
	let head =
		'<div class="datos-row__head">' +
		'<div class="datos-row__main">' +
		`<div class="datos-row__name">${escapeHtml(town.name)}</div>` +
		`<div class="datos-row__sub">${escapeHtml(sub)}</div>` +
		'</div>'
	let actions = ''
	if (downloaded) {
		head += toggleHtml('town-toggle', town.id, stored.visible)
		const canUpdate = Number(town.version) > Number(stored.version)
		const update = canUpdate
			? `<button type="button" class="btn btn--sm" data-act="town-update" data-town="${escapeHtml(town.id)}">Actualizar</button>`
			: ''
		actions =
			'<div class="datos-row__actions">' +
			update +
			`<button type="button" class="btn btn--sm btn--danger" data-act="town-delete" data-town="${escapeHtml(town.id)}">Eliminar</button>` +
			'</div>'
	} else {
		actions =
			'<div class="datos-row__actions">' +
			`<button type="button" class="btn btn--sm" data-act="town-download" data-town="${escapeHtml(town.id)}">Descargar</button>` +
			'</div>'
	}
	head += '</div>'
	return `<div class="datos-row" data-town="${escapeHtml(town.id)}">${head}${actions}</div>`
}

function bindDatos() {
	el.datosList.querySelectorAll('[data-act]').forEach(node => {
		const act = node.getAttribute('data-act')
		const townId = node.getAttribute('data-town')
		if (act === 'own-toggle') {
			node.addEventListener('change', () => {
				state.settings.ownVisible = node.checked
				saveSettings()
				rebuildMarkers()
			})
		} else if (act === 'town-toggle') {
			node.addEventListener('change', () => {
				if (state.settings.towns[townId]) state.settings.towns[townId].visible = node.checked
				saveSettings()
				renderDatasetDots()
			})
		} else if (act === 'town-download') {
			node.addEventListener('click', () => downloadTown(townId, node))
		} else if (act === 'town-update') {
			node.addEventListener('click', () => updateTown(townId, node))
		} else if (act === 'towns-update-all') {
			node.addEventListener('click', () => updateAllTowns(node))
		} else if (act === 'town-delete') {
			node.addEventListener('click', () => confirmDeleteTown(node, townId))
		}
	})
}

/* ---------- save flow ---------- */

function enterPlacementMode() {
	if (state.placementMode && !state.editingId && !state.editingPlaceId) return
	// Entering from edit mode (or fresh) starts a clean new-address placement
	state.placementMode = true
	state.editingId = null
	state.editingPlaceId = null
	resetForm()
	clearTempMarker()
	showListView()
	if (!el.sheet.classList.contains('sheet--collapsed')) collapseSheet()
	el.banner.hidden = false
	refreshDatasetInteractivity()
	toast('Toca el mapa donde está la dirección', 'ok')
}

function exitPlacementMode() {
	state.placementMode = false
	state.editingId = null
	state.editingPlaceId = null
	el.banner.hidden = true
	clearTempMarker()
	showListView()
	if (!el.sheet.classList.contains('sheet--collapsed')) collapseSheet()
	refreshDatasetInteractivity()
}

function onMapClick(ev) {
	if (!state.placementMode) return
	setTempMarker(ev.latlng.lat, ev.latlng.lng)
	// While editing (own address or official point), a map tap only moves the point
	if (state.editingId || state.editingPlaceId) return
	openFormForNew()
	prefillAddress(ev.latlng.lat, ev.latlng.lng)
}

function enterPlacementFromRemote(lat, lng, name, sub) {
	state.placementMode = true
	state.editingId = null
	state.editingPlaceId = null
	el.banner.hidden = false
	resetForm()
	setTempMarker(lat, lng)
	openFormForNew()
	el.fName.value = name || ''
	el.fAddress.value = sub || ''
	refreshDatasetInteractivity()
}

function prefillAddress(lat, lng) {
	if (el.fAddress.value.trim()) return
	reverseGeocode(lat, lng).then(text => {
		if (text && !el.fAddress.value.trim()) el.fAddress.value = text
	})
}

function openFormForNew() {
	el.formTitle.textContent = 'Nueva dirección'
	showFormView()
	expandSheet()
}

function showListView() {
	el.formView.hidden = true
	el.settingsView.hidden = true
	el.listView.hidden = false
}

function showFormView() {
	el.listView.hidden = true
	el.settingsView.hidden = true
	el.formView.hidden = false
}

function showSettingsView() {
	el.listView.hidden = true
	el.formView.hidden = true
	el.settingsView.hidden = false
	renderDatos()
}

function resetForm() {
	el.fName.value = ''
	el.fAddress.value = ''
	el.fNotes.value = ''
	el.fCoords.textContent = '—'
}

function onFormSubmit(event) {
	event.preventDefault()
	const name = el.fName.value.trim()
	if (!name) {
		toast('El nombre es obligatorio', 'warn')
		el.fName.focus()
		return
	}
	if (!state.tempCoords) {
		toast('Fija un punto en el mapa primero', 'warn')
		return
	}
	if (state.editingPlaceId) {
		savePlaceEdit(name)
		return
	}
	const now = new Date().toISOString()
	const existing = state.editingId ? state.addresses.find(a => a.id === state.editingId) : null
	const record = {
		id: existing ? existing.id : generateId(),
		name,
		address: el.fAddress.value.trim(),
		notes: el.fNotes.value.trim(),
		lat: state.tempCoords.lat,
		lng: state.tempCoords.lng,
		createdAt: existing ? existing.createdAt : now,
		updatedAt: now
	}
	dbPut(CONFIG.db.store, record)
		.then(() => {
			upsertAddress(record)
			rebuildOwnHaystacks()
			toast(existing ? 'Dirección actualizada' : 'Dirección guardada', 'ok')
			resetForm()
			exitPlacementMode()
			renderList()
			rebuildMarkers()
		})
		.catch(err => {
			console.error(err)
			toast('No se pudo guardar', 'error')
		})
}

function upsertAddress(record) {
	const idx = state.addresses.findIndex(a => a.id === record.id)
	if (idx >= 0) state.addresses[idx] = record
	else state.addresses.push(record)
}

function savePlaceEdit(name) {
	const place = findPlaceById(state.editingPlaceId)
	if (!place) {
		toast('No se pudo guardar', 'error')
		return
	}
	// Update the record in the 'places' store in place: keep town/id/partida/num, mark edited
	const address = el.fAddress.value.trim()
	place.name = name
	// The generated default address is display-only context; only persist a real user value
	place.address = address === placeDefaultAddress(place) ? '' : address
	place.notes = el.fNotes.value.trim()
	place.lat = state.tempCoords.lat
	place.lng = state.tempCoords.lng
	place.edited = true
	place.updatedAt = new Date().toISOString()
	place.hay = normalize(`${place.name} ${place.partida} ${place.num} ${place.address} ${place.notes}`)
	dbPut(CONFIG.db.placesStore, toDbPlace(place))
		.then(() => {
			toast('Punto actualizado', 'ok')
			resetForm()
			exitPlacementMode()
			renderDatasetDots()
		})
		.catch(err => {
			console.error(err)
			toast('No se pudo guardar', 'error')
		})
}

function startEdit(id) {
	const record = state.addresses.find(a => a.id === id)
	if (!record) return
	state.placementMode = true
	state.editingId = id
	state.editingPlaceId = null
	el.banner.hidden = false
	el.formTitle.textContent = 'Editar dirección'
	el.fName.value = record.name
	el.fAddress.value = record.address || ''
	el.fNotes.value = record.notes || ''
	setTempMarker(record.lat, record.lng)
	showFormView()
	expandSheet()
}

/* ---------- list ---------- */

function focusAddress(id) {
	const record = state.addresses.find(a => a.id === id)
	if (!record) return
	map.setView([record.lat, record.lng], CONFIG.map.focusZoom)
	const marker = state.markers.get(id)
	if (marker) marker.openPopup()
	if (!el.sheet.classList.contains('sheet--collapsed')) collapseSheet()
}

function openRoute(record) {
	window.open(`https://www.google.com/maps/dir/?api=1&destination=${record.lat},${record.lng}`, '_blank', 'noopener')
}

function shareAddress(record) {
	const link = `https://www.google.com/maps/search/?api=1&query=${record.lat},${record.lng}`
	const shareData = { title: record.name, text: `${record.name}\n${record.address || ''}`.trim(), url: link }
	if (navigator.share) {
		navigator.share(shareData).catch(() => {})
		return
	}
	if (navigator.clipboard) {
		navigator.clipboard
			.writeText(`${record.name} — ${link}`)
			.then(() => toast('Copiado', 'ok'))
			.catch(() => toast('No se pudo copiar', 'error'))
	} else {
		toast('Compartir no disponible', 'warn')
	}
}

function deleteAddress(id) {
	dbDelete(CONFIG.db.store, id)
		.then(() => {
			state.addresses = state.addresses.filter(a => a.id !== id)
			rebuildOwnHaystacks()
			const marker = state.markers.get(id)
			if (marker) {
				map.removeLayer(marker)
				state.markers.delete(id)
			}
			renderList()
			toast('Dirección borrada', 'ok')
		})
		.catch(err => {
			console.error(err)
			toast('No se pudo borrar', 'error')
		})
}

function renderList() {
	el.count.textContent = String(state.addresses.length)
	if (state.addresses.length === 0) {
		el.list.innerHTML =
			'<li class="empty">' +
			'<div class="empty__mark">📍</div>' +
			'<h3 class="empty__title">Aún no hay direcciones</h3>' +
			'<p class="empty__text">Pulsa el botón naranja + para guardar tu primera dirección. Toca el mapa o usa el GPS para fijar el punto exacto, o descarga la base oficial de tu zona en Ajustes.</p>' +
			'</li>'
		return
	}
	const sorted = state.addresses.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
	el.list.innerHTML = sorted.map(cardHtml).join('')
	el.list.querySelectorAll('.card').forEach(bindCard)
}

function cardHtml(record) {
	const addr = record.address ? `<p class="card__addr">${escapeHtml(record.address)}</p>` : ''
	const notes = record.notes ? `<p class="card__notes">${escapeHtml(record.notes)}</p>` : ''
	return (
		`<li class="card" data-id="${escapeHtml(record.id)}">` +
		`<h3 class="card__name">${escapeHtml(record.name)}</h3>` +
		addr +
		notes +
		`<p class="card__meta">${escapeHtml(formatDate(record.createdAt))} · ${escapeHtml(formatCoords(record.lat, record.lng))}</p>` +
		'<div class="card__actions">' +
		'<button type="button" class="btn btn--sm" data-act="view">Ver</button>' +
		'<button type="button" class="btn btn--sm" data-act="route">Ruta</button>' +
		'<button type="button" class="btn btn--sm" data-act="share">Compartir</button>' +
		'<button type="button" class="btn btn--sm" data-act="edit">Editar</button>' +
		'<button type="button" class="btn btn--sm btn--danger" data-act="delete">Borrar</button>' +
		'</div></li>'
	)
}

function bindCard(card) {
	const id = card.getAttribute('data-id')
	const record = state.addresses.find(a => a.id === id)
	if (!record) return
	card.querySelectorAll('[data-act]').forEach(btn => {
		const act = btn.getAttribute('data-act')
		btn.addEventListener('click', () => {
			if (act === 'view') focusAddress(id)
			else if (act === 'route') openRoute(record)
			else if (act === 'share') shareAddress(record)
			else if (act === 'edit') startEdit(id)
			else if (act === 'delete') confirmDelete(btn, id)
		})
	})
}

function confirmDelete(btn, id) {
	if (btn.dataset.confirming === 'true') {
		clearTimeout(state.confirmTimers.get(id))
		state.confirmTimers.delete(id)
		deleteAddress(id)
		return
	}
	btn.dataset.confirming = 'true'
	const original = btn.textContent
	btn.textContent = '¿Borrar? Confirmar'
	const timer = setTimeout(() => {
		btn.dataset.confirming = 'false'
		btn.textContent = original
		state.confirmTimers.delete(id)
	}, CONFIG.ui.confirmMs)
	state.confirmTimers.set(id, timer)
}

/* ---------- import / export ---------- */

function exportData() {
	// Own addresses always export; edited official points ride along under placeEdits
	dbGetAll(CONFIG.db.placesStore)
		.then(all => all.filter(record => record.edited))
		.catch(() => [])
		.then(edits => {
			const payload = {
				app: CONFIG.export.app,
				version: CONFIG.export.version,
				exportedAt: new Date().toISOString(),
				addresses: state.addresses
			}
			if (edits.length) payload.placeEdits = edits
			const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
			const url = URL.createObjectURL(blob)
			const link = document.createElement('a')
			const stamp = new Date().toISOString().slice(0, 10)
			link.href = url
			link.download = `last-mile-${stamp}.json`
			document.body.appendChild(link)
			link.click()
			link.remove()
			URL.revokeObjectURL(url)
			toast('Datos exportados', 'ok')
		})
}

function importData(file) {
	const reader = new FileReader()
	reader.onload = () => {
		let parsed
		try {
			parsed = JSON.parse(reader.result)
		} catch (err) {
			toast('Archivo no válido (JSON corrupto)', 'error')
			return
		}
		const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.addresses) ? parsed.addresses : null
		const edits = parsed && Array.isArray(parsed.placeEdits) ? parsed.placeEdits : null
		if (!list && !edits) {
			toast('Archivo no reconocido', 'error')
			return
		}
		// Own-addresses import is unchanged; placeEdits are handled separately when present
		if (list) mergeImported(list)
		if (edits) importPlaceEdits(edits)
	}
	reader.onerror = () => toast('No se pudo leer el archivo', 'error')
	reader.readAsText(file)
}

function mergeImported(list) {
	const existingIds = new Set(state.addresses.map(a => a.id))
	const toAdd = []
	let skipped = 0
	list.forEach(entry => {
		if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) return skipped++
		const lat = toFiniteNumber(entry.lat)
		const lng = toFiniteNumber(entry.lng)
		if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return skipped++
		if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return skipped++
		let id = typeof entry.id === 'string' && entry.id ? entry.id : generateId()
		if (existingIds.has(id)) return skipped++
		existingIds.add(id)
		const now = new Date().toISOString()
		toAdd.push({
			id,
			name: entry.name.trim(),
			address: typeof entry.address === 'string' ? entry.address : '',
			notes: typeof entry.notes === 'string' ? entry.notes : '',
			lat,
			lng,
			createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : now,
			updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : now
		})
	})
	if (toAdd.length === 0) {
		toast(`Importadas 0, omitidas ${skipped}`, 'warn')
		return
	}
	Promise.all(toAdd.map(record => dbPut(CONFIG.db.store, record)))
		.then(() => {
			toAdd.forEach(upsertAddress)
			rebuildOwnHaystacks()
			renderList()
			rebuildMarkers()
			toast(`Importadas ${toAdd.length}, omitidas ${skipped}`, 'ok')
		})
		.catch(err => {
			console.error(err)
			toast('Error al importar', 'error')
		})
}

/* ---------- sheet ---------- */

function expandSheet() {
	el.sheet.classList.remove('sheet--collapsed')
	el.sheetHandle.setAttribute('aria-expanded', 'true')
}

function collapseSheet() {
	el.sheet.classList.add('sheet--collapsed')
	el.sheetHandle.setAttribute('aria-expanded', 'false')
	// Collapsing from settings resets to the list so the next expand shows addresses
	if (!el.settingsView.hidden) showListView()
}

function toggleSheet() {
	if (el.sheet.classList.contains('sheet--collapsed')) expandSheet()
	else collapseSheet()
}

/* ---------- onboarding ---------- */

function maybeShowOnboarding() {
	// Once per device, and only for drivers who have not downloaded any town yet
	if (state.settings.onboarded) return
	if (Object.keys(state.settings.towns).length > 0) return
	el.onboard.hidden = false
}

function dismissOnboarding() {
	state.settings.onboarded = true
	saveSettings()
	el.onboard.hidden = true
}

function openOnboardingSettings() {
	dismissOnboarding()
	expandSheet()
	showSettingsView()
}

let updatePromptShown = false

function maybeShowUpdatePrompt() {
	// Proactive nudge when downloaded zones have a newer dataset. Shown at most once per boot,
	// never while onboarding is due or open, and never stacked on another modal.
	if (updatePromptShown || !el.updatePrompt) return
	if (!el.onboard.hidden) return
	if (Object.keys(state.settings.towns).length === 0) return
	// Outdated town data OR a missing/outdated offline basemap both surface as the normal update state
	if (!outdatedTowns().length && !basemapNeeded()) return
	updatePromptShown = true
	el.updatePrompt.hidden = false
}

function dismissUpdatePrompt() {
	el.updatePrompt.hidden = true
}

function runUpdatePromptUpdate() {
	// Reuse the shared update-all path; show progress on the modal button, then close on completion
	updateAllTowns(el.updatePromptGo, dismissUpdatePrompt)
}

/* ---------- init ---------- */

function bindEvents() {
	el.searchInput.addEventListener('input', onSearchInput)
	el.searchInput.addEventListener('focus', () => {
		if (el.searchInput.value.trim()) onSearchInput()
		else showPartidaBrowser()
	})
	el.searchClear.addEventListener('click', () => {
		clearSearch()
		hideResults()
		el.searchInput.focus()
	})
	document.addEventListener('click', ev => {
		// A detached target means a results click handler already re-rendered the panel; closest()
		// would return null and wrongly hide it
		if (!ev.target.isConnected) return
		if (!el.results.hidden && !ev.target.closest('.search')) hideResults()
	})

	el.addBtn.addEventListener('click', enterPlacementMode)
	el.locateBtn.addEventListener('click', () => locateUser(null))
	el.placementGps.addEventListener('click', () =>
		locateUser((lat, lng) => {
			setTempMarker(lat, lng)
			if (state.editingId || state.editingPlaceId) return
			openFormForNew()
			prefillAddress(lat, lng)
		})
	)
	el.placementCancel.addEventListener('click', () => {
		resetForm()
		exitPlacementMode()
	})

	el.sheetHandle.addEventListener('click', toggleSheet)
	el.formView.addEventListener('submit', onFormSubmit)
	el.formCancel.addEventListener('click', () => {
		resetForm()
		exitPlacementMode()
	})

	el.settingsBtn.addEventListener('click', showSettingsView)
	el.settingsBack.addEventListener('click', showListView)
	el.exportBtn.addEventListener('click', exportData)
	el.importBtn.addEventListener('click', () => el.importInput.click())
	el.importInput.addEventListener('change', () => {
		const file = el.importInput.files && el.importInput.files[0]
		if (file) importData(file)
		el.importInput.value = ''
	})

	el.onboardSettings.addEventListener('click', openOnboardingSettings)
	el.onboardDismiss.addEventListener('click', dismissOnboarding)

	if (el.updatePromptGo) el.updatePromptGo.addEventListener('click', runUpdatePromptUpdate)
	if (el.updatePromptDismiss) el.updatePromptDismiss.addEventListener('click', dismissUpdatePrompt)
}

let appStarted = false

// Shell: runs immediately on load. Only the splash wiring and service worker --
// no map, IndexedDB or network until the driver taps "Iniciar".
function initShell() {
	registerServiceWorker()
	el.splashStart.addEventListener('click', startApp)
	if (el.splashShare) el.splashShare.addEventListener('click', shareApp)
}

const SHARE_URL = 'https://lastmile.chemaalfonso.com'

function shareApp() {
	const data = { title: 'Last Mile', text: 'Direcciones rurales que no aparecen en el mapa', url: SHARE_URL }
	if (navigator.share) {
		// The native sheet handles its own cancel; only fall back when sharing is unavailable
		navigator.share(data).catch(() => {})
		return
	}
	copyShareUrl()
}

function copyShareUrl() {
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard
			.writeText(SHARE_URL)
			.then(() => toast('Enlace copiado', 'ok'))
			.catch(fallbackCopyShareUrl)
		return
	}
	fallbackCopyShareUrl()
}

function fallbackCopyShareUrl() {
	// execCommand copy works where the async clipboard API is blocked (older webviews, no permission)
	try {
		const area = document.createElement('textarea')
		area.value = SHARE_URL
		area.setAttribute('readonly', '')
		area.style.position = 'absolute'
		area.style.left = '-9999px'
		document.body.appendChild(area)
		area.select()
		document.execCommand('copy')
		document.body.removeChild(area)
		toast('Enlace copiado', 'ok')
	} catch (err) {
		toast('No se pudo copiar el enlace', 'error')
	}
}

function registerServiceWorker() {
	if (!('serviceWorker' in navigator)) return
	window.addEventListener('load', () => {
		navigator.serviceWorker.register('sw.js').catch(err => console.error(err))
	})
}

function startApp() {
	if (appStarted) return
	appStarted = true
	hideSplash()
	initApp()
}

function hideSplash() {
	el.splash.classList.add('splash--hidden')
	el.splash.addEventListener('transitionend', () => (el.splash.hidden = true), { once: true })
}

// App: the heavy init, run once when the splash is dismissed
function initApp() {
	state.settings = loadSettings()
	initMap()
	bindEvents()
	// Read the stored basemap (if any) and switch to the offline vector layer -- read-only,
	// never a hidden download. A missing basemap surfaces through the normal update UI instead.
	loadBasemapState()
	// Wait for the splash transition to finish so the modal never lands on top of it
	setTimeout(maybeShowOnboarding, 450)
	dbGetAll(CONFIG.db.store)
		.then(rows => {
			state.addresses = rows
			rebuildOwnHaystacks()
			renderList()
			rebuildMarkers()
		})
		.catch(err => {
			console.error(err)
			toast('No se pudo cargar el almacenamiento local', 'error')
		})
	// Load already-downloaded towns from IndexedDB, then reconcile with the online manifest
	loadEnabledTowns()
		.then(fetchManifest)
		.then(() => {
			renderDatos()
			// Silent: nudging "acércate" on every app open would be noise, not help
			renderDatasetDots(true)
			maybeShowUpdatePrompt()
		})
		.catch(err => {
			console.error(err)
			renderDatos()
		})
}

initShell()
