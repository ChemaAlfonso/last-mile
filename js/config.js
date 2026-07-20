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
		version: 4,
		store: 'addresses',
		placesStore: 'places',
		placesTownIndex: 'town',
		basemapStore: 'basemap',
		routingStore: 'routing'
	},
	basemap: {
		id: 'comarca',
		url: 'data/basemap-comarca.pmtiles',
		// Bump (or override via manifest.basemap.version) to make installed copies refresh through
		// the normal town download/update flow -- the basemap is invisible to the driver.
		version: 1,
		// Coarse floor used only when the server sends no Content-Length: reject a blob far smaller
		// than the real basemap (~25 MB). The precise check uses the server's Content-Length.
		expectedBytes: 20 * 1024 * 1024,
		// A truncated download must never be accepted: require at least this fraction of the
		// server-reported Content-Length before marking the basemap installed.
		minCompleteRatio: 0.98,
		// protomaps-leaflet built-in flavor closest to the app's light look
		flavor: 'light',
		lang: 'es',
		minZoom: 0,
		maxZoom: 18,
		// The vector tiles top out here; Leaflet overzooms beyond it so z16-18 still render
		maxDataZoom: 15,
		// Fallback comarca bbox [[minLat,minLon],[maxLat,maxLon]] used if the pmtiles header can't be
		// read. The overlay is clamped to these bounds so it never paints over the world raster.
		bounds: [
			[37.85, -1.085],
			[38.356, -0.666]
		],
		// OSM is already credited by the always-on raster base; the overlay only adds the Protomaps credit
		attribution: '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>'
	},
	routing: {
		id: 'comarca',
		url: 'data/graph-comarca.json',
		// Bump (or override via manifest.graph.version) to refresh installed copies through the normal
		// town download/update flow -- the routing graph is invisible to the driver, like the basemap.
		// v2 carries OSM turn restrictions.
		version: 2,
		// Coarse floor used only when the server sends no Content-Length: reject a blob far smaller than
		// the real graph (~7 MB). The precise check uses the server's Content-Length.
		expectedBytes: 5 * 1024 * 1024,
		// A truncated download must never be accepted: require at least this fraction of the
		// server-reported Content-Length before marking the graph installed.
		minCompleteRatio: 0.98,
		// Live navigation tunables (metres unless noted)
		offRouteM: 35,
		// Consecutive off-route fixes before a recompute fires (debounces GPS jitter)
		offRouteFixes: 2,
		// Within this distance of the destination, switch to the arrive state
		arriveM: 30,
		// Dashed off-road legs (you -> road, road -> door) are "no guidance here" territory: painted in
		// a muted warm grey so they never read as part of the guided route
		unguidedColor: '#8f867c',
		// Heading arrow gates: stationary GPS jitter must never paint a direction (it reads as a broken
		// compass). Below headingMinSpeedMs (m/s, when the device reports speed) the arrow neither
		// appears nor updates; without speed data, consecutive fixes must move at least headingMinMoveM.
		headingMinSpeedMs: 1.5,
		headingMinMoveM: 8,
		// Starting zoom when a route begins: close to the driver (they can freely zoom out to see it all)
		navZoom: 17,
		// The graph's edge costs are free-flow speeds; real driving never is. Displayed ETA = engine
		// time x etaFactor + etaTurnS per pending maneuver, so town crossings (many junctions) get the
		// realistic padding that open rural runs don't need. Tune from real-world feedback.
		etaFactor: 1.4,
		etaTurnS: 10,
		// watchPosition options tuned for continuous turn-by-turn tracking
		gps: {
			enableHighAccuracy: true,
			timeout: 15000,
			maximumAge: 2000
		}
	},
	dataset: {
		indexUrl: 'data/index.json',
		fileBase: 'data/',
		zoomThreshold: 14,
		renderCap: 1500,
		debounceMs: 150,
		boundsPad: 0.2,
		resultLimit: 8,
		// Extra px added to each dot's tap hit-area (visual unchanged) so imprecise taps still open
		// the popup. Kept modest to avoid neighbours stealing taps in dense partidas.
		tapTolerance: 8,
		dot: {
			radius: 6,
			weight: 2,
			color: '#1a1714',
			fillColor: '#e8500a',
			fillOpacity: 0.9
		}
	},
	storageKey: 'last-mile:settings',
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

