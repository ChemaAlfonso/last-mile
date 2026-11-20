/* ============================================================
   Last Mile — service worker
   Cache-first on the app shell. Bump CACHE_VERSION on every deploy.
   ============================================================ */

'use strict'

const CACHE_VERSION = 'last-mile-v13'

// The app shell. Datasets under data/ (incl. the offline basemap .pmtiles) are NOT precached:
// they live in IndexedDB and the app owns their offline path. Vendored libraries (Leaflet, the
// vector-basemap renderer) ARE precached so the app boots and the map inits with zero network.
const SHELL = [
	'./',
	'index.html',
	'styles.css',
	'js/config.js',
	'js/db.js',
	'js/map.js',
	'js/search.js',
	'js/towns.js',
	'js/routing.js',
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
			// 'no-cache' revalidates each file with the server: never an old copy, and a retry only downloads what changed
			.then(cache => cache.addAll(SHELL.map(path => new Request(path, { cache: 'no-cache' }))))
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
	event.respondWith(cacheFirst(request))
})

function cacheFirst(request) {
	// Any navigation is the app itself, whatever query string the launcher adds
	const key = request.mode === 'navigate' ? 'index.html' : request
	return caches
		.open(CACHE_VERSION)
		.then(cache => cache.match(key))
		.then(cached => cached || fetch(request))
}
