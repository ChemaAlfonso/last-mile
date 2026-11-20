/* ---------- db ---------- */

let dbInstance = null
let dbOpening = null

function openDb() {
	if (dbInstance) return Promise.resolve(dbInstance)
	if (dbOpening) return dbOpening
	const opening = new Promise((resolve, reject) => {
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
			// v3 -> v4: holds the single offline routing graph (raw JSON text) + its metadata
			if (!db.objectStoreNames.contains(CONFIG.db.routingStore)) {
				db.createObjectStore(CONFIG.db.routingStore, { keyPath: 'id' })
			}
		}
		req.onsuccess = () => {
			const db = req.result
			// A newer shell open elsewhere (installed app + browser tab) cannot upgrade the schema while
			// this connection stays open: release it, the next operation reopens
			db.onversionchange = () => {
				db.close()
				if (dbInstance === db) dbInstance = null
			}
			// The browser can also drop the connection by itself (site data cleared, storage failure)
			db.onclose = () => {
				if (dbInstance === db) dbInstance = null
			}
			dbInstance = db
			resolve(db)
		}
		// No onblocked handler on purpose: blocked is not final, the request succeeds as soon as the
		// other connection closes, and failing here would boot the app with an empty list
		req.onerror = () => reject(req.error)
	})
	const release = () => {
		if (dbOpening === opening) dbOpening = null
	}
	opening.then(release, release)
	dbOpening = opening
	return opening
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

function dbWrite(storeName, work) {
	// Settles on the transaction, not on the request: a commit can still abort (quota) after a
	// request reported success, and that write must not be announced as saved
	return openDb().then(
		db =>
			new Promise((resolve, reject) => {
				const tx = db.transaction(storeName, 'readwrite')
				tx.oncomplete = () => resolve()
				// A failed request bubbles here before the transaction records its own error
				tx.onerror = event => reject(tx.error || event.target.error)
				tx.onabort = () => reject(tx.error)
				work(tx.objectStore(storeName))
			})
	)
}

function dbPut(storeName, record) {
	return dbWrite(storeName, store => store.put(record)).then(() => record)
}

function dbDelete(storeName, id) {
	return dbWrite(storeName, store => store.delete(id))
}

function dbBulkPut(storeName, records) {
	// One transaction for all puts -- thousands of individual transactions would be too slow
	return dbWrite(storeName, store => records.forEach(record => store.put(record))).then(() => records.length)
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
	const settings = { ownVisible: true, onboarded: false, navWarned: false, towns: {} }
	if (parsed && typeof parsed === 'object') {
		if (parsed.ownVisible === false) settings.ownVisible = false
		if (parsed.onboarded === true) settings.onboarded = true
		if (parsed.navWarned === true) settings.navWarned = true
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

