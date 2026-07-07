/* ============================================================
   Last Mile — service worker
   Network-first with cache fallback so deploys are picked up on
   the next online load (no stale-version zombies). Bump CACHE_VERSION
   to force a clean precache.
   ============================================================ */

'use strict'

const CACHE_VERSION = 'last-mile-v2'

// The app shell. Datasets under data/ are NOT precached: they live in
// IndexedDB and the app has its own offline fallback for the manifest.
const SHELL = [
	'./',
	'index.html',
	'styles.css',
	'app.js',
	'manifest.json',
	'assets/kraken.png',
	'assets/icon-192.png',
	'assets/icon-512.png',
	'assets/icon-maskable.png',
	'assets/apple-touch-icon.png',
	'assets/og.png'
]

self.addEventListener('install', event => {
	event.waitUntil(
		caches
			.open(CACHE_VERSION)
			.then(cache => cache.addAll(SHELL))
			.then(() => self.skipWaiting())
	)
})

self.addEventListener('activate', event => {
	event.waitUntil(
		caches
			.keys()
			.then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))))
			.then(() => self.clients.claim())
	)
})

self.addEventListener('fetch', event => {
	const request = event.request
	if (request.method !== 'GET') return
	const url = new URL(request.url)
	if (url.origin !== self.location.origin) return
	// Never intercept dataset/manifest requests -- the app owns their offline behaviour
	const dataPath = new URL('data/', self.registration.scope).pathname
	if (url.pathname.startsWith(dataPath)) return
	event.respondWith(networkFirst(request))
})

function networkFirst(request) {
	return fetch(request)
		.then(response => {
			// Refresh the cache on every successful load so the next offline visit is current
			if (response && response.ok) {
				const copy = response.clone()
				caches.open(CACHE_VERSION).then(cache => cache.put(request, copy))
			}
			return response
		})
		.catch(() =>
			caches.match(request).then(cached => {
				if (cached) return cached
				// Navigations fall back to the cached shell so the app boots offline
				if (request.mode === 'navigate') return caches.match('index.html')
				return Response.error()
			})
		)
}
