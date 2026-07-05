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
		version: 1,
		store: 'addresses'
	},
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
			if (!db.objectStoreNames.contains(CONFIG.db.store)) {
				db.createObjectStore(CONFIG.db.store, { keyPath: 'id' })
			}
		}
		req.onsuccess = () => {
			dbInstance = req.result
			resolve(dbInstance)
		}
		req.onerror = () => reject(req.error)
	})
}

function dbTx(mode) {
	return openDb().then(db => db.transaction(CONFIG.db.store, mode).objectStore(CONFIG.db.store))
}

function dbGetAll() {
	return dbTx('readonly').then(
		store =>
			new Promise((resolve, reject) => {
				const req = store.getAll()
				req.onsuccess = () => resolve(req.result || [])
				req.onerror = () => reject(req.error)
			})
	)
}

function dbPut(record) {
	return dbTx('readwrite').then(
		store =>
			new Promise((resolve, reject) => {
				const req = store.put(record)
				req.onsuccess = () => resolve(record)
				req.onerror = () => reject(req.error)
			})
	)
}

function dbDelete(id) {
	return dbTx('readwrite').then(
		store =>
			new Promise((resolve, reject) => {
				const req = store.delete(id)
				req.onsuccess = () => resolve()
				req.onerror = () => reject(req.error)
			})
	)
}

/* ---------- state ---------- */

const state = {
	addresses: [],
	markers: new Map(),
	tempMarker: null,
	tempCoords: null,
	editingId: null,
	placementMode: false,
	locateLayers: null,
	remoteMarker: null,
	searchController: null,
	confirmTimers: new Map()
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
	list: document.getElementById('list'),
	exportBtn: document.getElementById('exportBtn'),
	importBtn: document.getElementById('importBtn'),
	importInput: document.getElementById('importInput'),
	formTitle: document.getElementById('formTitle'),
	fName: document.getElementById('fName'),
	fAddress: document.getElementById('fAddress'),
	fNotes: document.getElementById('fNotes'),
	fCoords: document.getElementById('fCoords'),
	formCancel: document.getElementById('formCancel'),
	toasts: document.getElementById('toasts')
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
	L.tileLayer(CONFIG.map.tileUrl, {
		maxZoom: CONFIG.map.maxZoom,
		attribution: CONFIG.map.attribution
	}).addTo(map)
	map.on('click', onMapClick)
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

function localMatches(query) {
	const q = normalize(query)
	if (!q) return []
	return state.addresses
		.filter(a => normalize(a.name).includes(q) || normalize(a.address).includes(q) || normalize(a.notes).includes(q))
		.slice(0, CONFIG.search.localLimit)
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
		hideResults()
		return
	}
	renderResults(localMatches(query), null)
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
			renderResults(localMatches(query), remote)
		})
		.catch(err => {
			if (err.name === 'AbortError') return
			renderResults(localMatches(query), 'offline')
		})
}

function renderResults(local, remote) {
	const parts = []
	local.forEach(a => {
		parts.push(resultRow('saved', a.id, a.name, a.address || formatCoords(a.lat, a.lng), a.lat, a.lng))
	})
	if (Array.isArray(remote)) {
		remote.forEach((r, i) => {
			parts.push(resultRow('map', String(i), r.name, r.sub, r.lat, r.lng))
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
}

function resultRow(kind, ref, name, sub, lat, lng) {
	const badge = kind === 'saved' ? '<span class="badge badge--saved">Guardada</span>' : '<span class="badge">Mapa</span>'
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
		const id = node.getAttribute('data-ref')
		focusAddress(id)
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

/* ---------- save flow ---------- */

function enterPlacementMode() {
	if (state.placementMode && !state.editingId) return
	// Entering from edit mode (or fresh) starts a clean new-address placement
	state.placementMode = true
	state.editingId = null
	resetForm()
	clearTempMarker()
	showListView()
	if (!el.sheet.classList.contains('sheet--collapsed')) collapseSheet()
	el.banner.hidden = false
	toast('Toca el mapa donde está la dirección', 'ok')
}

function exitPlacementMode() {
	state.placementMode = false
	state.editingId = null
	el.banner.hidden = true
	clearTempMarker()
	showListView()
	if (!el.sheet.classList.contains('sheet--collapsed')) collapseSheet()
}

function onMapClick(ev) {
	if (!state.placementMode) return
	setTempMarker(ev.latlng.lat, ev.latlng.lng)
	// While editing, a map tap only moves the point — keep the form as-is
	if (state.editingId) return
	openFormForNew()
	prefillAddress(ev.latlng.lat, ev.latlng.lng)
}

function enterPlacementFromRemote(lat, lng, name, sub) {
	state.placementMode = true
	state.editingId = null
	el.banner.hidden = false
	resetForm()
	setTempMarker(lat, lng)
	openFormForNew()
	el.fName.value = name || ''
	el.fAddress.value = sub || ''
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
	el.listView.hidden = false
}

function showFormView() {
	el.listView.hidden = true
	el.formView.hidden = false
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
	dbPut(record)
		.then(() => {
			upsertAddress(record)
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

function startEdit(id) {
	const record = state.addresses.find(a => a.id === id)
	if (!record) return
	state.placementMode = true
	state.editingId = id
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
	dbDelete(id)
		.then(() => {
			state.addresses = state.addresses.filter(a => a.id !== id)
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
			'<p class="empty__text">Pulsa el botón naranja + para guardar tu primera dirección. Toca el mapa o usa el GPS para fijar el punto exacto.</p>' +
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
	const payload = {
		app: CONFIG.export.app,
		version: CONFIG.export.version,
		exportedAt: new Date().toISOString(),
		addresses: state.addresses
	}
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
		if (!list) {
			toast('Archivo no reconocido', 'error')
			return
		}
		mergeImported(list)
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
	Promise.all(toAdd.map(dbPut))
		.then(() => {
			toAdd.forEach(upsertAddress)
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
}

function toggleSheet() {
	if (el.sheet.classList.contains('sheet--collapsed')) expandSheet()
	else collapseSheet()
}

/* ---------- init ---------- */

function bindEvents() {
	el.searchInput.addEventListener('input', onSearchInput)
	el.searchInput.addEventListener('focus', () => {
		if (el.searchInput.value.trim()) onSearchInput()
	})
	el.searchClear.addEventListener('click', () => {
		clearSearch()
		hideResults()
		el.searchInput.focus()
	})
	document.addEventListener('click', ev => {
		if (!el.results.hidden && !ev.target.closest('.search')) hideResults()
	})

	el.addBtn.addEventListener('click', enterPlacementMode)
	el.locateBtn.addEventListener('click', () => locateUser(null))
	el.placementGps.addEventListener('click', () =>
		locateUser((lat, lng) => {
			setTempMarker(lat, lng)
			if (state.editingId) return
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

	el.exportBtn.addEventListener('click', exportData)
	el.importBtn.addEventListener('click', () => el.importInput.click())
	el.importInput.addEventListener('change', () => {
		const file = el.importInput.files && el.importInput.files[0]
		if (file) importData(file)
		el.importInput.value = ''
	})
}

function init() {
	initMap()
	bindEvents()
	dbGetAll()
		.then(rows => {
			state.addresses = rows
			renderList()
			rebuildMarkers()
		})
		.catch(err => {
			console.error(err)
			toast('No se pudo cargar el almacenamiento local', 'error')
		})
}

init()
