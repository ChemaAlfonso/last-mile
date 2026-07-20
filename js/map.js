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

