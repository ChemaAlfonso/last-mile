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

