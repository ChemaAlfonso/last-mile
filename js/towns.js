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
	// Merge rule: the importer's own edits always prevail. Incoming edits are applied only
	// to official places the importer has NOT already edited locally; conflicts are skipped
	// and counted. Re-importing the same file is idempotent because applied records become
	// `edited: true` locally and are then treated as conflicts on the next pass.
	let invalid = 0
	const candidates = []
	edits.forEach(e => {
		if (!e || typeof e.id !== 'string' || typeof e.town !== 'string') return invalid++
		const lat = toFiniteNumber(e.lat)
		const lng = toFiniteNumber(e.lng)
		if (!isFiniteNumber(lat) || !isFiniteNumber(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return invalid++
		candidates.push({
			id: e.id,
			town: e.town,
			name: String(e.name || ''),
			partida: String(e.partida || ''),
			num: String(e.num || ''),
			ref: typeof e.ref === 'string' ? e.ref : '',
			lat,
			lng,
			address: typeof e.address === 'string' ? e.address : '',
			notes: typeof e.notes === 'string' ? e.notes : '',
			edited: true,
			updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date().toISOString()
		})
	})
	return dbGetAll(CONFIG.db.placesStore)
		.then(all => new Set(all.filter(record => record.edited).map(record => record.id)))
		.catch(() => new Set())
		.then(localEditedIds => {
			let conflicts = 0
			const toApply = candidates.filter(record => {
				if (localEditedIds.has(record.id)) {
					conflicts++
					return false
				}
				return true
			})
			if (!toApply.length) return { added: 0, conflicts, invalid }
			return dbBulkPut(CONFIG.db.placesStore, toApply).then(() => {
				toApply.forEach(record => {
					if (!state.places.has(record.town)) return
					const arr = state.places.get(record.town)
					const idx = arr.findIndex(p => p.id === record.id)
					const mem = makeMemPlace(record)
					if (idx >= 0) arr[idx] = mem
					else arr.push(mem)
				})
				renderDatasetDots()
				return { added: toApply.length, conflicts, invalid }
			})
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

/* ---------- import / export ---------- */

function buildBackupPayload() {
	// Own addresses always export; edited official points ride along under placeEdits.
	// This shape is the shared/backup contract -- keep it additive-only for compatibility.
	return dbGetAll(CONFIG.db.placesStore)
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
			return payload
		})
}

function backupFilename() {
	const stamp = new Date().toISOString().slice(0, 10)
	return `last-mile-${stamp}.json`
}

function downloadBackup(payload) {
	const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.href = url
	link.download = backupFilename()
	document.body.appendChild(link)
	link.click()
	link.remove()
	URL.revokeObjectURL(url)
}

function exportData() {
	buildBackupPayload().then(payload => {
		downloadBackup(payload)
		toast('Datos exportados', 'ok')
	})
}

function shareBackup() {
	// Share the very same backup JSON via the native share sheet when the platform can attach
	// files; otherwise fall back to the plain download and tell the driver to attach it manually.
	buildBackupPayload().then(payload => {
		const json = JSON.stringify(payload, null, 2)
		const file = typeof File === 'function' ? new File([json], backupFilename(), { type: 'application/json' }) : null
		const canShareFile = file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share
		const fallback = () => {
			downloadBackup(payload)
			toast('Archivo descargado. Adjúntalo para compartirlo', 'warn')
		}
		if (canShareFile) {
			// Some platforms (Chrome on macOS) accept canShare({files}) yet reject share() with
			// NotAllowedError. AbortError means the driver dismissed the sheet on purpose.
			navigator
				.share({ files: [file], title: 'Last Mile', text: 'Mis puntos de Last Mile' })
				.catch(err => {
					if (!err || err.name !== 'AbortError') fallback()
				})
			return
		}
		fallback()
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
		// Merge rule: the importer's local data always prevails on conflict. Both halves run,
		// then a single compact summary reports what was added and what was kept local.
		Promise.all([
			list ? mergeImported(list) : Promise.resolve(null),
			edits ? importPlaceEdits(edits) : Promise.resolve(null)
		])
			.then(([addrResult, editResult]) => summariseImport(addrResult, editResult))
			.catch(err => {
				console.error(err)
				toast('Error al importar', 'error')
			})
	}
	reader.onerror = () => toast('No se pudo leer el archivo', 'error')
	reader.readAsText(file)
}

function addressSignature(name, lat, lng) {
	// Accent/case-insensitive name plus rounded coords -> catches the same logical point even
	// when it arrives with a fresh id (older files carried no ids), keeping re-import idempotent.
	const d = CONFIG.ui.coordDecimals
	return `${normalize(name).trim()}|${lat.toFixed(d)}|${lng.toFixed(d)}`
}

function mergeImported(list) {
	const existingIds = new Set(state.addresses.map(a => a.id))
	const existingSigs = new Set(state.addresses.map(a => addressSignature(a.name, a.lat, a.lng)))
	const toAdd = []
	let conflicts = 0
	let invalid = 0
	list.forEach(entry => {
		if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) return invalid++
		const lat = toFiniteNumber(entry.lat)
		const lng = toFiniteNumber(entry.lng)
		if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return invalid++
		if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return invalid++
		const name = entry.name.trim()
		const id = typeof entry.id === 'string' && entry.id ? entry.id : generateId()
		// Local prevails: skip on id collision or on an exact duplicate (same rounded coords + name)
		if (existingIds.has(id)) return conflicts++
		const sig = addressSignature(name, lat, lng)
		if (existingSigs.has(sig)) return conflicts++
		existingIds.add(id)
		existingSigs.add(sig)
		const now = new Date().toISOString()
		toAdd.push({
			id,
			name,
			address: typeof entry.address === 'string' ? entry.address : '',
			notes: typeof entry.notes === 'string' ? entry.notes : '',
			lat,
			lng,
			createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : now,
			updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : now
		})
	})
	if (toAdd.length === 0) return Promise.resolve({ added: 0, conflicts, invalid })
	return Promise.all(toAdd.map(record => dbPut(CONFIG.db.store, record))).then(() => {
		toAdd.forEach(upsertAddress)
		rebuildOwnHaystacks()
		renderList()
		rebuildMarkers()
		return { added: toAdd.length, conflicts, invalid }
	})
}

function summariseImport(addrResult, editResult) {
	const points = addrResult ? addrResult.added : 0
	const corrections = editResult ? editResult.added : 0
	const conflicts = (addrResult ? addrResult.conflicts : 0) + (editResult ? editResult.conflicts : 0)
	const invalid = (addrResult ? addrResult.invalid : 0) + (editResult ? editResult.invalid : 0)

	const segments = []
	if (points) segments.push(`${points} ${points === 1 ? 'punto' : 'puntos'}`)
	if (corrections) segments.push(`${corrections} ${corrections === 1 ? 'corrección' : 'correcciones'}`)

	let message
	if (segments.length) {
		message = `${points ? 'Añadidos' : 'Añadidas'} ${segments.join(' y ')}`
	} else {
		message = 'Sin novedades'
	}
	if (conflicts) message += ` · conservados los tuyos en ${conflicts} ${conflicts === 1 ? 'conflicto' : 'conflictos'}`
	if (invalid) message += ` · ${invalid} ${invalid === 1 ? 'descartado' : 'descartados'}`

	toast(message, segments.length ? 'ok' : 'warn')
}

