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

/* ---------- offline routing graph: rides along with town downloads, invisible to the driver ---------- */

function graphSource() {
	// Manifest may declare the graph (file/version/size); fall back to the CONFIG defaults
	const m = state.manifest && state.manifest.graph ? state.manifest.graph : null
	return {
		url: m && m.file ? CONFIG.dataset.fileBase + m.file : CONFIG.routing.url,
		version: Number((m && m.version) || CONFIG.routing.version),
		size: Number((m && m.size) || 0)
	}
}

function graphNeeded() {
	// Needs a fetch when missing, or when the installed copy is older than the declared version.
	// Gated on having a town, exactly like the basemap: no town, no offline extras.
	if (!hasAnyTown()) return false
	const src = graphSource()
	if (!state.graphInstalled) return true
	return Number(state.graphMeta && state.graphMeta.version) < src.version
}

function loadGraphState() {
	// Read the stored graph text (if any) at boot. Kept as raw text and parsed lazily on first
	// navigation -- parsing/indexing the ~7 MB graph would waste boot time for a driver who never routes.
	return dbGet(CONFIG.db.routingStore, CONFIG.routing.id)
		.then(rec => {
			if (rec && rec.text && rec.size) {
				state.graphInstalled = true
				state.graphText = rec.text
				state.graphMeta = { size: rec.size, installedAt: rec.installedAt, version: rec.version || 1 }
			} else {
				state.graphInstalled = false
			}
		})
		.catch(() => {})
}

function ensureGraph() {
	// Deduped, non-blocking. Fetches the graph only when a town is installed and it is missing/outdated.
	if (state.graphBusy) return Promise.resolve(false)
	if (!graphNeeded()) return Promise.resolve(false)
	if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false)
	return fetchAndStoreGraph(graphSource())
}

function fetchAndStoreGraph(src) {
	state.graphBusy = true
	state.graphFailed = false
	state.graphProgress = 0
	return fetch(src.url, { cache: 'no-store' })
		.then(res => {
			if (!res.ok) throw new Error('HTTP ' + res.status)
			const total = Number(res.headers.get('Content-Length')) || 0
			if (!res.body || !res.body.getReader) {
				// No streaming support: fall back to a plain text() read (no progress %)
				return res.text().then(text => ({ text, total, received: null }))
			}
			const reader = res.body.getReader()
			const decoder = new TextDecoder()
			let text = ''
			let received = 0
			const pump = () =>
				reader.read().then(({ done, value }) => {
					if (done) {
						text += decoder.decode()
						return
					}
					received += value.length
					text += decoder.decode(value, { stream: true })
					if (total) state.graphProgress = received / total
					return pump()
				})
			return pump().then(() => ({ text, total, received }))
		})
		.then(({ text, total, received }) => {
			// Never mark a truncated download installed: require the full Content-Length (or, when the
			// server sends none, at least ~the expected size). Byte count is what the manifest declares.
			const bytes = received != null ? received : new Blob([text]).size
			const target = total || CONFIG.routing.expectedBytes
			if (bytes < Math.floor(target * CONFIG.routing.minCompleteRatio)) throw new Error('incomplete-download')
			const record = {
				id: CONFIG.routing.id,
				text,
				size: bytes,
				version: src.version,
				installedAt: new Date().toISOString()
			}
			return dbPut(CONFIG.db.routingStore, record).then(() => record)
		})
		.then(record => {
			state.graphBusy = false
			state.graphInstalled = true
			state.graphText = record.text
			state.graphMeta = { size: record.size, installedAt: record.installedAt, version: record.version }
			// Refresh the towns list so the "Actualizar todo" control (driven by graphNeeded) updates
			renderDatos()
			return true
		})
		.catch(err => {
			// Town data is the core value and already succeeded; the routing graph is enhancement. Keep the
			// app fully usable, remember the failure, and let the next town op / boot retry silently.
			state.graphBusy = false
			state.graphFailed = true
			console.error('routing graph download failed', err)
			renderDatos()
			return false
		})
}

function deleteGraphBlob() {
	return dbDelete(CONFIG.db.routingStore, CONFIG.routing.id)
		.then(() => {
			state.graphInstalled = false
			state.graphText = null
			state.graphMeta = null
		})
		.catch(err => console.error('routing graph delete failed', err))
}

function offlineRouteBtnHtml() {
	// Only offered when the routing graph is installed -- it complements (never replaces) the Google "Ruta"
	return state.graphInstalled
		? '<button type="button" class="btn btn--sm" data-act="offlineRoute">Ruta sin conexión</button>'
		: ''
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
		offlineRouteBtnHtml() +
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
			else if (act === 'offlineRoute') startNavigation(record)
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
	if (state.navigation) return // own pins also hide while a route is active
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
	// While a route is active the map belongs to it: dozens of unrelated dots only confuse the driver
	if (state.navigation) {
		clearDatasetDots(false)
		return
	}
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
		offlineRouteBtnHtml() +
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
			else if (act === 'offlineRoute') startNavigation(place)
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

/* ---------- offline navigation ("Ruta sin conexión") ---------- */

// Turn-type -> Spanish guidance phrase (engine `type` is one of these exact strings)
const MANEUVER_TEXT = {
	depart: 'Comienza la ruta',
	straight: 'Continúa recto',
	'slight-left': 'Gira ligeramente a la izquierda',
	'slight-right': 'Gira ligeramente a la derecha',
	left: 'Gira a la izquierda',
	right: 'Gira a la derecha',
	'sharp-left': 'Gira bruscamente a la izquierda',
	'sharp-right': 'Gira bruscamente a la derecha',
	arrive: 'Has llegado'
}

// Turn-type -> arrow glyph shown in the banner
const MANEUVER_ARROW = {
	depart: '↑',
	straight: '↑',
	'slight-left': '↖',
	'slight-right': '↗',
	left: '←',
	right: '→',
	'sharp-left': '⤶',
	'sharp-right': '⤷',
	arrive: '◎'
}

function haversineM(aLat, aLng, bLat, bLng) {
	// Great-circle distance in metres (progress + off-route + arrive checks run on this)
	const R = 6371000
	const toRad = d => (d * Math.PI) / 180
	const dLat = toRad(bLat - aLat)
	const dLng = toRad(bLng - aLng)
	const s1 = Math.sin(dLat / 2)
	const s2 = Math.sin(dLng / 2)
	const a = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

function showNavUnavailable() {
	if (el.navUnavailable) el.navUnavailable.hidden = false
}

function routingAvailable() {
	// The engine (js/routing.js) is optional and may 404: never call it blind
	return typeof routingReady !== 'undefined' && routingReady()
}

function formatDistM(m) {
	const v = Math.max(0, Number(m) || 0)
	if (v < 1000) return `${Math.round(v)} m`
	return `${(Math.round(v / 100) / 10).toString().replace('.', ',')} km`
}

function formatEta(seconds) {
	const s = Math.max(0, Number(seconds) || 0)
	if (s < 60) return 'menos de 1 min'
	const min = Math.round(s / 60)
	if (min < 60) return `${min} min`
	const h = Math.floor(min / 60)
	const rem = min % 60
	return rem ? `${h} h ${rem} min` : `${h} h`
}

function startNavigation(dest) {
	// Complements the Google "Ruta" button; never touches placement mode's temp marker / form
	if (state.placementMode) {
		toast('Termina de colocar el punto antes de navegar', 'warn')
		return
	}
	if (!state.graphInstalled) {
		toast('Aún no está lista la ruta sin conexión', 'warn')
		return
	}
	const lat = toFiniteNumber(dest.lat)
	const lng = toFiniteNumber(dest.lng)
	if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
		toast('Este punto no tiene coordenadas válidas', 'error')
		return
	}
	if (!window.isSecureContext) {
		toast('La navegación requiere HTTPS', 'warn')
		return
	}
	if (!navigator.geolocation) {
		toast('Geolocalización no disponible en este navegador', 'error')
		return
	}
	if (state.navigation) stopNavigation()
	const d = { lat, lng, name: dest.name || '' }
	// First-use expectation setting: this is a support tool, not Google-grade navigation. Dismissable
	// forever via the checkbox (settings.navWarned); the OK handler resumes with proceedNavigation.
	if (!state.settings.navWarned) {
		state.pendingNavDest = d
		if (el.navDisclaimer) {
			el.navDisclaimer.hidden = false
			return
		}
	}
	proceedNavigation(d)
}

function proceedNavigation(d) {
	map.closePopup()
	enterNavUi()
	setNavBannerBusy('Obteniendo tu ubicación…')
	navigator.geolocation.getCurrentPosition(
		pos => beginNavigation(d, pos.coords),
		err => {
			handleGeoError(err)
			exitNavUi()
		},
		{
			enableHighAccuracy: CONFIG.geo.enableHighAccuracy,
			timeout: CONFIG.geo.timeout,
			maximumAge: CONFIG.geo.maximumAge
		}
	)
}

function beginNavigation(dest, coords) {
	const oLat = toFiniteNumber(coords.latitude)
	const oLng = toFiniteNumber(coords.longitude)
	if (!isFiniteNumber(oLat) || !isFiniteNumber(oLng)) {
		toast('No se pudo obtener tu ubicación', 'error')
		exitNavUi()
		return
	}
	state.navigation = {
		dest,
		origin: { lat: oLat, lng: oLng },
		route: null,
		layer: null,
		driverMarker: null,
		headingEl: null,
		lastFix: null,
		pos: null,
		// Anchored follow: the map keeps the driver centred until they drag away; the Centrar
		// button re-anchors. This is the behaviour every navigation app has trained drivers to expect.
		follow: true,
		legStart: null,
		destMarker: null,
		cum: [],
		totalDist: 0,
		watchId: null,
		wakeLock: null,
		offRouteCount: 0,
		pointIndex: 0,
		arrived: false
	}
	// Parsing/indexing the ~7 MB graph can take ~1s: show the busy banner, then compute off-frame
	setNavBannerBusy('Calculando ruta…')
	prepareGraph().then(ok => {
		const nav = state.navigation
		if (!nav) return // exited while the graph was parsing
		if (!ok) {
			toast('No se pudo preparar la ruta sin conexión', 'error')
			stopNavigation()
			return
		}
		const route = computeRoute(nav.origin.lat, nav.origin.lng, dest.lat, dest.lng)
		if (!route || !route.points || !route.points.length) {
			// A toast here reads as "the button is broken" -- explain the coverage rule instead
			showNavUnavailable()
			stopNavigation()
			return
		}
		nav.route = route
		drawRoute(route, dest)
		// While navigating only the route matters: hide the dataset dots and own pins (the guards in
		// renderDatasetDots/rebuildMarkers keep them hidden across map moves until the route ends)
		renderDatasetDots(true)
		rebuildMarkers()
		// Start close to the driver, not fitted to the whole route -- they can zoom out freely
		map.setView([nav.origin.lat, nav.origin.lng], CONFIG.routing.navZoom)
		// A manual drag un-anchors the follow ('dragstart' only fires on user gestures, never on panTo)
		map.on('dragstart', onNavDragStart)
		if (el.navCenter) el.navCenter.hidden = true
		requestWakeLock()
		startNavWatch()
		// Prime the banner from the fix we already have (watchPosition delivers the next one later)
		onNavPosition(coords)
	})
}

function prepareGraph() {
	// Lazily JSON.parse + index the stored graph on first navigation; keep it in memory afterwards
	if (typeof initRoutingGraph === 'undefined' || typeof routingReady === 'undefined') return Promise.resolve(false)
	if (routingReady()) return Promise.resolve(true)
	if (!state.graphText) return Promise.resolve(false)
	return new Promise(resolve => {
		// Defer so the busy banner paints before the main thread blocks on parse/index
		setTimeout(() => {
			try {
				initRoutingGraph(JSON.parse(state.graphText))
				resolve(routingReady())
			} catch (err) {
				console.error('routing graph init failed', err)
				resolve(false)
			}
		}, 32)
	})
}

function buildCumulative(points) {
	// Cumulative along-route distance per point -- powers remaining-distance / ETA / distance-to-turn
	const cum = [0]
	for (let i = 1; i < points.length; i++) {
		cum[i] = cum[i - 1] + haversineM(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
	}
	return cum
}

function drawRoute(route, dest) {
	const nav = state.navigation
	if (!nav) return
	nav.layer = L.layerGroup().addTo(map)
	// Solid route: an ink casing under an orange line for the app's field-tool sticker look
	nav.layer.addLayer(
		L.polyline(route.points, {
			color: CONFIG.dataset.dot.color,
			weight: 9,
			opacity: 1,
			lineCap: 'round',
			lineJoin: 'round',
			interactive: false
		})
	)
	nav.layer.addLayer(
		L.polyline(route.points, {
			color: CONFIG.dataset.dot.fillColor,
			weight: 5,
			opacity: 1,
			lineCap: 'round',
			lineJoin: 'round',
			interactive: false
		})
	)
	// Dashed connectors: current position -> route start snap, and end snap -> destination.
	// Muted grey on purpose -- these legs are off the road graph, so there is no guidance on them
	const dash = { color: CONFIG.routing.unguidedColor, weight: 3, dashArray: '2 9', opacity: 0.9, lineCap: 'round', interactive: false }
	const snapStart = route.startSnap ? [route.startSnap.lat, route.startSnap.lng] : route.points[0]
	nav.legStart = L.polyline([[nav.origin.lat, nav.origin.lng], snapStart], dash).addTo(nav.layer)
	const snapEnd = route.endSnap ? [route.endSnap.lat, route.endSnap.lng] : route.points[route.points.length - 1]
	nav.layer.addLayer(L.polyline([snapEnd, [dest.lat, dest.lng]], dash))
	// Destination stays clearly visible with its own pin
	nav.destMarker = L.marker([dest.lat, dest.lng], { icon: pinIcon(), interactive: false, keyboard: false }).addTo(nav.layer)
	nav.cum = buildCumulative(route.points)
	nav.totalDist = nav.cum.length ? nav.cum[nav.cum.length - 1] : Number(route.distanceM) || 0
}

function ensureNavDriverMarker(lat, lng) {
	const nav = state.navigation
	if (!nav || !nav.layer) return
	if (nav.driverMarker) {
		nav.driverMarker.setLatLng([lat, lng])
		return
	}
	nav.driverMarker = L.marker([lat, lng], {
		icon: L.divIcon({
			className: 'gps-dot-wrap',
			html: '<div class="gps-dot gps-dot--nav"><span class="gps-nav-heading" hidden></span></div>',
			iconSize: [20, 20],
			iconAnchor: [10, 10]
		}),
		interactive: false,
		keyboard: false,
		zIndexOffset: 1000
	}).addTo(nav.layer)
	const root = nav.driverMarker.getElement()
	nav.headingEl = root ? root.querySelector('.gps-nav-heading') : null
}

// Initial bearing from point 1 to point 2, degrees clockwise from north
function bearingDeg(aLat, aLng, bLat, bLng) {
	const toRad = d => (d * Math.PI) / 180
	const y = Math.sin(toRad(bLng - aLng)) * Math.cos(toRad(bLat))
	const x =
		Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
		Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLng - aLng))
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function updateNavHeading(lat, lng, coords) {
	// Map rotation is out of scope (Leaflet is north-up), so the driver dot carries a heading arrow:
	// the device course when the GPS reports one, else derived from consecutive fixes. It only ever
	// appears after VERIFIED movement -- a parked phone showing a jitter-derived arrow reads as a
	// broken compass to drivers used to native navigation.
	const nav = state.navigation
	if (!nav || !nav.headingEl) return
	const speed = toFiniteNumber(coords.speed)
	if (isFiniteNumber(speed) && speed < CONFIG.routing.headingMinSpeedMs) {
		nav.lastFix = { lat, lng } // parked or crawling: no arrow changes, jitter never accumulates
		return
	}
	let heading = toFiniteNumber(coords.heading)
	if (!isFiniteNumber(heading) && nav.lastFix) {
		const moved = haversineM(nav.lastFix.lat, nav.lastFix.lng, lat, lng)
		if (moved >= CONFIG.routing.headingMinMoveM) heading = bearingDeg(nav.lastFix.lat, nav.lastFix.lng, lat, lng)
	}
	nav.lastFix = { lat, lng }
	if (!isFiniteNumber(heading)) return // no verified course yet: keep the arrow as it was
	nav.headingEl.hidden = false
	nav.headingEl.style.transform = `rotate(${Math.round(heading)}deg)`
}

function startNavWatch() {
	const nav = state.navigation
	if (!nav || !navigator.geolocation) return
	nav.watchId = navigator.geolocation.watchPosition(
		pos => onNavPosition(pos.coords),
		err => console.error('navigation watch error', err),
		{
			enableHighAccuracy: CONFIG.routing.gps.enableHighAccuracy,
			timeout: CONFIG.routing.gps.timeout,
			maximumAge: CONFIG.routing.gps.maximumAge
		}
	)
}

function clearNavWatch() {
	const nav = state.navigation
	if (nav && nav.watchId != null && navigator.geolocation) {
		navigator.geolocation.clearWatch(nav.watchId)
		nav.watchId = null
	}
}

function onNavPosition(coords) {
	const nav = state.navigation
	if (!nav || !nav.route) return
	const lat = toFiniteNumber(coords.latitude)
	const lng = toFiniteNumber(coords.longitude)
	if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return
	ensureNavDriverMarker(lat, lng)
	updateNavHeading(lat, lng, coords)
	nav.pos = { lat, lng }
	if (nav.follow) map.panTo([lat, lng])
	// Keep the dashed start leg pinned to the live position
	if (nav.legStart && nav.route.points.length) {
		const snapStart = nav.route.startSnap ? [nav.route.startSnap.lat, nav.route.startSnap.lng] : nav.route.points[0]
		nav.legStart.setLatLngs([[lat, lng], snapStart])
	}
	if (nav.arrived) return
	if (haversineM(lat, lng, nav.dest.lat, nav.dest.lng) <= CONFIG.routing.arriveM) {
		setArrived()
		return
	}
	const near = routingAvailable() ? nearestOnRoute(nav.route, lat, lng) : null
	if (!near) {
		// Engine unavailable: fall back to straight-line remaining guidance so the banner still helps
		const dToDest = haversineM(lat, lng, nav.dest.lat, nav.dest.lng)
		renderNavBanner({
			type: 'straight',
			maneuver: MANEUVER_TEXT.straight,
			road: '',
			dist: formatDistM(dToDest),
			remaining: `${formatDistM(dToDest)} · ${formatEta(adjustedEtaS(nav.route.durationS, 0))}`
		})
		return
	}
	if (near.distM > CONFIG.routing.offRouteM) {
		nav.offRouteCount++
		if (nav.offRouteCount >= CONFIG.routing.offRouteFixes) {
			recomputeRoute(lat, lng)
			return
		}
	} else {
		nav.offRouteCount = 0
	}
	nav.pointIndex = near.pointIndex
	updateGuidance(near.pointIndex)
}

function recomputeRoute(lat, lng) {
	const nav = state.navigation
	if (!nav) return
	nav.offRouteCount = 0
	if (!routingAvailable()) return
	toast('Recalculando…', 'warn')
	const route = computeRoute(lat, lng, nav.dest.lat, nav.dest.lng)
	if (!route || !route.points || !route.points.length) {
		// Keep the previous route on screen; a later fix may snap back or recompute successfully
		return
	}
	nav.origin = { lat, lng }
	nav.route = route
	nav.pointIndex = 0
	clearNavLayers()
	drawRoute(route, nav.dest)
	ensureNavDriverMarker(lat, lng)
	updateGuidance(0)
}

function upcomingStep(steps, pointIndex) {
	// Steps whose `at` is at/behind the driver are done; the next maneuver is the first real turn ahead
	for (let i = 0; i < steps.length; i++) {
		if (steps[i].type === 'depart') continue
		if (Number(steps[i].at) >= pointIndex) return steps[i]
	}
	return null
}

function maneuverText(step) {
	// A named "continue" reads best as "Sigue por <road>"; turns keep their directional phrase
	if ((step.type === 'straight' || step.type === 'depart') && step.name) return `Sigue por ${step.name}`
	return MANEUVER_TEXT[step.type] || 'Continúa'
}

// Engine time is free-flow (no junctions, no stops); pad it into a believable ETA
function adjustedEtaS(rawS, pendingTurns) {
	return (Number(rawS) || 0) * CONFIG.routing.etaFactor + (pendingTurns || 0) * CONFIG.routing.etaTurnS
}

function pendingTurnCount(steps, pointIndex) {
	let n = 0
	for (let i = 0; i < steps.length; i++) {
		if (steps[i].type === 'depart' || steps[i].type === 'arrive') continue
		if (Number(steps[i].at) >= pointIndex) n++
	}
	return n
}

function updateGuidance(pointIndex) {
	const nav = state.navigation
	if (!nav || !nav.route) return
	const cum = nav.cum
	const idx = Math.min(Math.max(0, pointIndex), cum.length - 1)
	const doneDist = cum[idx] || 0
	const remaining = Math.max(0, nav.totalDist - doneDist)
	const rawEtaS = nav.totalDist > 0 ? (Number(nav.route.durationS) || 0) * (remaining / nav.totalDist) : 0
	const etaS = adjustedEtaS(rawEtaS, pendingTurnCount(nav.route.steps || [], pointIndex))
	const remainingText = `${formatDistM(remaining)} · ${formatEta(etaS)}`
	const step = upcomingStep(nav.route.steps || [], pointIndex)
	if (!step) {
		renderNavBanner({ type: 'straight', maneuver: MANEUVER_TEXT.straight, road: '', dist: formatDistM(remaining), remaining: remainingText })
		return
	}
	const stepIdx = Math.min(Math.max(0, Number(step.at) || 0), cum.length - 1)
	const distToStep = Math.max(0, (cum[stepIdx] || 0) - doneDist)
	const mtext = maneuverText(step)
	// Show the road as a subtitle only when it is not already inlined into the maneuver phrase
	const road = step.name && mtext.indexOf(step.name) === -1 ? `por ${step.name}` : ''
	renderNavBanner({ type: step.type, maneuver: mtext, road, dist: formatDistM(distToStep), remaining: remainingText })
}

function setArrived() {
	const nav = state.navigation
	if (!nav) return
	nav.arrived = true
	renderNavBanner({ type: 'arrive', maneuver: MANEUVER_TEXT.arrive, road: nav.dest.name || '', dist: '', remaining: 'Fin de la ruta' })
	// Movement tracking is over; stop the watch and free the wake lock, keep the banner for "Salir"
	clearNavWatch()
	releaseWakeLock()
	toast('Has llegado a tu destino', 'ok')
}

function renderNavBanner(info) {
	if (!el.navBanner) return
	el.navBanner.classList.remove('nav--busy')
	// textContent everywhere: raw OSM road names never reach innerHTML, so there is no XSS surface
	el.navArrow.textContent = MANEUVER_ARROW[info.type] || '↑'
	el.navManeuver.textContent = info.maneuver || ''
	el.navRoad.textContent = info.road || ''
	el.navRoad.hidden = !info.road
	el.navDist.textContent = info.dist || ''
	el.navDist.hidden = !info.dist
	el.navRemaining.textContent = info.remaining || ''
	el.navBanner.hidden = false
}

function setNavBannerBusy(text) {
	if (!el.navBanner) return
	el.navBanner.classList.add('nav--busy')
	el.navArrow.textContent = '…'
	el.navManeuver.textContent = text
	el.navRoad.hidden = true
	el.navDist.hidden = true
	el.navRemaining.textContent = ''
	el.navBanner.hidden = false
}

function enterNavUi() {
	// Hide the search bar, FABs, placement banner and sheet (via CSS) so the route owns the screen
	document.body.classList.add('is-navigating')
	if (el.sheet && !el.sheet.classList.contains('sheet--collapsed')) collapseSheet()
	hideResults()
}

function exitNavUi() {
	document.body.classList.remove('is-navigating')
	if (el.navBanner) el.navBanner.hidden = true
}

function clearNavLayers() {
	const nav = state.navigation
	if (!nav) return
	if (nav.layer) {
		map.removeLayer(nav.layer)
		nav.layer = null
	}
	nav.driverMarker = null
	nav.headingEl = null
	nav.legStart = null
	nav.destMarker = null
}

function onNavDragStart() {
	const nav = state.navigation
	if (!nav || !nav.follow) return
	nav.follow = false
	if (el.navCenter) el.navCenter.hidden = false
}

function recenterNavigation() {
	const nav = state.navigation
	if (!nav) return
	nav.follow = true
	if (el.navCenter) el.navCenter.hidden = true
	const p = nav.pos || nav.origin
	map.panTo([p.lat, p.lng])
}

function requestWakeLock() {
	if (!('wakeLock' in navigator) || !navigator.wakeLock) return
	navigator.wakeLock
		.request('screen')
		.then(lock => {
			if (!state.navigation) {
				lock.release().catch(() => {})
				return
			}
			state.navigation.wakeLock = lock
			lock.addEventListener('release', () => {
				if (state.navigation) state.navigation.wakeLock = null
			})
		})
		.catch(() => {
			// Unsupported / denied (e.g. not focused): degrade silently, navigation still works
		})
}

function releaseWakeLock() {
	const nav = state.navigation
	if (nav && nav.wakeLock) {
		nav.wakeLock.release().catch(() => {})
		nav.wakeLock = null
	}
}

function stopNavigation() {
	const nav = state.navigation
	if (!nav) {
		exitNavUi()
		return
	}
	clearNavWatch()
	releaseWakeLock()
	clearNavLayers()
	map.off('dragstart', onNavDragStart)
	if (el.navCenter) el.navCenter.hidden = true
	state.navigation = null
	exitNavUi()
	// Bring back the dots and own pins the route had hidden
	renderDatasetDots(true)
	rebuildMarkers()
}

