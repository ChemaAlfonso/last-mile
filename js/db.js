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

