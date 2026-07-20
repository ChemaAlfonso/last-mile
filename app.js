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
	shareBackupBtn: document.getElementById('shareBackupBtn'),
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
	el.shareBackupBtn.addEventListener('click', shareBackup)
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
