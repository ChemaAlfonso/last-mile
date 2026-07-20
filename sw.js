/* ============================================================
   Last Mile — service worker
   Network-first with cache fallback so deploys are picked up on
   the next online load (no stale-version zombies). Bump CACHE_VERSION
   to force a clean precache.
   ============================================================ */

'use strict'

const CACHE_VERSION = 'last-mile-v4'

// The app shell. Datasets under data/ (incl. the offline basemap .pmtiles) are NOT precached:
// they live in IndexedDB and the app owns their offline path. Vendored libraries (Leaflet, the
// vector-basemap renderer) ARE precached so the app boots and the map inits with zero network.
const SHELL = [
	'./',
	'index.html',
	'styles.css',
	'app.js',
	'manifest.json',
	'vendor/leaflet/leaflet.js',
	'vendor/leaflet/leaflet.css',
	'vendor/leaflet/images/marker-icon.png',
	'vendor/leaflet/images/marker-icon-2x.png',
	'vendor/leaflet/images/marker-shadow.png',
	'vendor/leaflet/images/layers.png',
	'vendor/leaflet/images/layers-2x.png',
	'vendor/protomaps-leaflet.js',
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
	// The offline basemap is a large blob the app stores in IndexedDB; never precache or intercept it
	// (Range requests, big payload) even if it were ever served from outside data/
	if (url.pathname.endsWith('.pmtiles')) return
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
